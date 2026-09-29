// Incremental IMAP synchronisation (read-only), plus the opt-in cleanup of old imported messages.
import { ImapFlow } from 'imapflow';
import type { SyncResult, SyncStatus } from '../shared/types.ts';
import { config, imapConfigured } from './config.ts';
import type { Store } from './db.ts';
import { extractReports } from './mail.ts';

type Log = (msg: string) => void;

/**
 * The cleanup deletes messages sent before this date: `months` calendar months before `now`
 * (UTC, start of day). The day is clamped to the target month, e.g. 31 March minus one month
 * is 28/29 February.
 */
export function cleanupCutoff(now: Date, months: number): Date {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() - months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(now.getUTCDate(), lastDay)));
}

/**
 * Of the messages the server found older than the cutoff, only those at or below the last
 * processed UID and recorded as imported may be deleted; everything else is kept.
 */
export function selectForDeletion(olderThanCutoff: number[], lastProcessedUid: number, imported: Set<number>) {
  const remove = olderThanCutoff.filter((uid) => uid <= lastProcessedUid && imported.has(uid)).sort((a, b) => a - b);
  return { remove, kept: olderThanCutoff.length - remove.length };
}

export class Syncer {
  private running: Promise<SyncResult> | null = null;
  private stopping = false;
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
      cleanup:
        config.imap.deleteAfterMonths > 0
          ? { afterMonths: config.imap.deleteAfterMonths, dryRun: config.imap.deleteDryRun }
          : null,
    };
  }

  /** Runs a sync, or joins the one already in progress. */
  run(opts: { full?: boolean } = {}): Promise<SyncResult> {
    if (this.stopping) return Promise.reject(new Error('shutting down'));
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
          .finally(() => {
            if (!this.stopping) tick();
          });
      }, minutes * 60_000);
      this.timer.unref();
    };
    tick();
  }

  /**
   * Stops scheduling and asks a running sync to finish after the current message (it then
   * logs out of IMAP normally). Resolves once no sync is running; the next run resumes
   * from the last stored message.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.nextRunAt = null;
    await this.running?.catch(() => {});
  }

  private async doRun({ full = false }: { full?: boolean }): Promise<SyncResult> {
    this.lastRunAt = new Date().toISOString();
    const result: SyncResult = {
      messagesSeen: 0,
      reportsAdded: 0,
      duplicates: 0,
      messagesWithoutReport: 0,
      errors: 0,
      deleted: 0,
    };
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
      // Importing is read-only. Only the opt-in cleanup below opens the mailbox read-write.
      let importedFrom: string | null = null;
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
          if (this.stopping) {
            this.log(
              `shutting down: stopped after ${result.messagesSeen} of ${pending.length} message(s), the rest follow next run`,
            );
            break;
          }
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
        importedFrom = uidValidity;
      } finally {
        lock.release();
      }
      if (importedFrom && imap.deleteAfterMonths > 0 && !this.stopping) {
        await this.cleanup(client, importedFrom, result);
      }
      return true;
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  /**
   * Opt-in cleanup: permanently deletes messages in IMAP_DIR (and nowhere else) that were sent
   * more than IMAP_DELETE_AFTER_MONTHS months ago and whose reports are stored. Messages that
   * could not be imported are kept. Requires UIDPLUS, so that only the chosen UIDs are expunged.
   */
  private async cleanup(client: ImapFlow, uidValidity: string, result: SyncResult): Promise<void> {
    const { imap } = config;
    if (!client.capabilities.has('UIDPLUS')) {
      this.log('cleanup skipped: the server lacks UIDPLUS, so an expunge could also remove messages flagged by others');
      return;
    }
    const lastUid = Number((await this.store.getMeta(`lastuid:${imap.mailbox}`)) ?? 0);
    if (!lastUid) return;
    const cutoff = cleanupCutoff(new Date(), imap.deleteAfterMonths);
    const day = cutoff.toISOString().slice(0, 10);

    const lock = await client.getMailboxLock(imap.mailbox);
    try {
      // The mailbox must be the one just imported from, not a recreated one with reused UIDs.
      if (String(client.mailbox && client.mailbox.uidValidity) !== uidValidity) {
        this.log('cleanup skipped: UIDVALIDITY changed since the import');
        return;
      }
      // SENTBEFORE compares the Date: header (the date the dashboard shows as "Received").
      const old = (await client.search({ sentBefore: cutoff, uid: `1:${lastUid}` }, { uid: true })) || [];
      if (!old.length) return;
      const imported = await this.store.importedUids(imap.mailbox, uidValidity, old);
      const { remove, kept } = selectForDeletion(old, lastUid, imported);
      const keptNote = kept ? `, ${kept} older message(s) kept because they were not imported` : '';
      if (imap.deleteDryRun) {
        result.deleted += remove.length;
        this.log(`cleanup dry run: would delete ${remove.length} message(s) sent before ${day}${keptNote}`);
        return;
      }
      for (let i = 0; i < remove.length; i += 200) {
        if (this.stopping) break;
        const chunk = remove.slice(i, i + 200);
        // \Deleted + UID EXPUNGE of exactly these UIDs (ImapFlow uses UID EXPUNGE with UIDPLUS).
        if (!(await client.messageDelete(chunk.join(','), { uid: true }))) {
          throw new Error(`cleanup: the server refused to delete messages ${chunk[0]}-${chunk.at(-1)}`);
        }
        await this.store.markDeleted(imap.mailbox, uidValidity, chunk);
        result.deleted += chunk.length;
      }
      if (remove.length || kept) {
        this.log(`cleanup: deleted ${result.deleted} message(s) sent before ${day}${keptNote}`);
      }
    } finally {
      lock.release();
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
