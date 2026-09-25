// Incremental, read-only IMAP synchronisation.
import { ImapFlow } from 'imapflow';
import type { SyncResult, SyncStatus } from '../shared/types.ts';
import { config, imapConfigured } from './config.ts';
import type { Store } from './db.ts';
import { extractReports } from './mail.ts';

type Log = (msg: string) => void;

export class Syncer {
  private running: Promise<SyncResult> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastRunAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;
  private lastResult: SyncResult | null = null;
  private nextRunAt: string | null = null;

  private readonly store: Store;
  private readonly log: Log;

  constructor(store: Store, log: Log = (m) => console.log(`[sync] ${m}`)) {
    this.store = store;
    this.log = log;
  }

  async status(): Promise<SyncStatus> {
    const [lastSuccessAt, totals, issues] = await Promise.all([
      // Stored in the database so it reflects syncs done by any instance.
      this.store.getMeta('lastSuccessAt'),
      this.store.totals(),
      this.store.messageIssues(config.imap.mailbox),
    ]);
    return {
      configured: imapConfigured(),
      mailbox: config.imap.mailbox,
      running: this.running !== null,
      lastRunAt: this.lastRunAt,
      lastSuccessAt: lastSuccessAt ?? this.lastSuccessAt,
      lastError: this.lastError,
      lastResult: this.lastResult,
      nextRunAt: this.nextRunAt,
      totals,
      issues,
    };
  }

  /** Runs a sync, or joins the one already in progress. */
  run(opts: { full?: boolean } = {}): Promise<SyncResult> {
    this.running ??= this.doRun(opts).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  schedule(minutes: number): void {
    if (minutes <= 0) return;
    const tick = () => {
      this.nextRunAt = new Date(Date.now() + minutes * 60_000).toISOString();
      this.timer = setTimeout(() => {
        this.run()
          .catch(() => {})
          .finally(tick);
      }, minutes * 60_000);
      this.timer.unref();
    };
    tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  private async doRun({ full = false }: { full?: boolean }): Promise<SyncResult> {
    this.lastRunAt = new Date().toISOString();
    const result: SyncResult = { messagesSeen: 0, reportsAdded: 0, duplicates: 0, messagesWithoutReport: 0, errors: 0 };
    try {
      if (!imapConfigured()) throw new Error('IMAP is not configured (IMAP_HOST, IMAP_USERNAME, IMAP_PASSWORD)');
      // Only one instance talks to the mailbox at a time.
      const ran = await this.store.withExclusiveLock('tlsrpt_sync', () => this.syncMailbox(result, full));
      if (ran === null) {
        this.log('another instance is already syncing, skipped');
        this.lastResult = result;
        return result;
      }
      this.lastError = null;
      this.lastSuccessAt = new Date().toISOString();
      await this.store.setMeta('lastSuccessAt', this.lastSuccessAt);
      this.log(
        `done: ${result.messagesSeen} new message(s), ${result.reportsAdded} report(s) added, ` +
          `${result.duplicates} duplicate(s), ${result.messagesWithoutReport} without report, ${result.errors} error(s)`,
      );
      this.lastResult = result;
      return result;
    } catch (e) {
      this.lastError = (e as Error).message;
      this.lastResult = result;
      this.log(`failed: ${this.lastError}`);
      throw e;
    }
  }

  private async syncMailbox(result: SyncResult, full: boolean): Promise<true> {
    const { imap } = config;
    const client = new ImapFlow({
      host: imap.host!,
      port: imap.port,
      secure: imap.secure,
      auth: { user: imap.user!, pass: imap.pass! },
      tls: { rejectUnauthorized: imap.rejectUnauthorized },
      logger: false,
    });
    client.on('error', (err: Error) => this.log(`connection error: ${err.message}`));

    await client.connect();
    try {
      // Read-only: we never change flags, move or delete messages.
      const lock = await client.getMailboxLock(imap.mailbox, { readOnly: true });
      try {
        const box = client.mailbox;
        if (!box) throw new Error(`mailbox ${imap.mailbox} could not be opened`);
        const uidValidity = String(box.uidValidity);
        const validityKey = `uidvalidity:${imap.mailbox}`;
        const lastUidKey = `lastuid:${imap.mailbox}`;
        let lastUid = Number((await this.store.getMeta(lastUidKey)) ?? 0);
        if (full || (await this.store.getMeta(validityKey)) !== uidValidity) {
          if (!full && lastUid > 0) this.log('UIDVALIDITY changed, rescanning the whole mailbox');
          lastUid = 0;
        }
        await this.store.setMeta(validityKey, uidValidity);
        if (box.exists === 0) return true;

        // Collect UIDs first; running other commands inside a FETCH stream is not allowed.
        const pending: { uid: number; size: number }[] = [];
        for await (const m of client.fetch(`${lastUid + 1}:*`, { uid: true, size: true }, { uid: true })) {
          // "N:*" always matches the highest UID, even when it is below N.
          if (m.uid > lastUid) pending.push({ uid: m.uid, size: m.size ?? 0 });
        }
        pending.sort((a, b) => a.uid - b.uid);
        if (pending.length) this.log(`${pending.length} new message(s) in ${imap.mailbox}`);

        for (const { uid, size } of pending) {
          result.messagesSeen++;
          const base = { mailbox: imap.mailbox, uidvalidity: uidValidity, uid };
          if (size > imap.maxMessageSize) {
            result.errors++;
            await this.store.recordMessage({
              ...base,
              messageId: null,
              from: null,
              subject: null,
              date: null,
              status: 'error',
              error: `message too large (${size} bytes)`,
            });
          } else {
            const msg = await client.fetchOne(String(uid), { source: true, internalDate: true }, { uid: true });
            if (msg && msg.source) {
              await this.processMessage(base, msg.source, msg.internalDate, result);
            }
          }
          // Advance only after the message is stored: a database error aborts the run and the
          // message is retried next time.
          await this.store.setMeta(lastUidKey, String(uid));
        }
        return true;
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  private async processMessage(
    base: { mailbox: string; uidvalidity: string; uid: number },
    source: Buffer,
    internalDate: Date | string | undefined,
    result: SyncResult,
  ): Promise<void> {
    let parsed: Awaited<ReturnType<typeof extractReports>>;
    try {
      parsed = await extractReports(source);
    } catch (e) {
      // Unparseable MIME: record it and move on (database errors below are not caught).
      result.errors++;
      await this.store.recordMessage({
        ...base,
        messageId: null,
        from: null,
        subject: null,
        date: null,
        status: 'error',
        error: (e as Error).message,
      });
      return;
    }
    // Prefer the Date header: INTERNALDATE changes when messages are copied or migrated.
    const receivedAt = parsed.date ?? (internalDate ? new Date(internalDate).toISOString() : null);
    let added = 0;
    let dupes = 0;
    for (const r of parsed.reports) {
      const ok = await this.store.insertReport(r.report, r.raw, {
        from: parsed.from,
        subject: parsed.subject,
        filename: r.filename,
        receivedAt,
      });
      if (ok) added++;
      else dupes++;
    }
    result.reportsAdded += added;
    result.duplicates += dupes;
    let status: 'ok' | 'duplicate' | 'no-report' | 'error';
    if (parsed.errors.length && !parsed.reports.length) status = 'error';
    else if (!parsed.reports.length) status = 'no-report';
    else if (added === 0) status = 'duplicate';
    else status = 'ok';
    if (status === 'error') result.errors++;
    if (status === 'no-report') result.messagesWithoutReport++;
    await this.store.recordMessage({
      ...base,
      messageId: parsed.messageId,
      from: parsed.from,
      subject: parsed.subject,
      date: parsed.date,
      status,
      error: parsed.errors.length ? parsed.errors.join('; ') : null,
    });
  }
}
