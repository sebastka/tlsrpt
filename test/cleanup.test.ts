import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { ImapFlow } from 'imapflow';
import mariadb from 'mariadb';
import { config } from '../src/server/config.ts';
import { Store } from '../src/server/db.ts';
import { cleanupCutoff, selectForDeletion, Syncer } from '../src/server/sync.ts';
import { fixture } from './helpers.ts';

test('cleanup cutoff is N calendar months back, clamped to the end of shorter months', () => {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  assert.equal(day(cleanupCutoff(new Date('2026-09-29T15:00:00Z'), 6)), '2026-03-29');
  assert.equal(day(cleanupCutoff(new Date('2026-03-31T00:00:00Z'), 1)), '2026-02-28');
  assert.equal(day(cleanupCutoff(new Date('2028-03-31T00:00:00Z'), 1)), '2028-02-29');
  assert.equal(day(cleanupCutoff(new Date('2026-01-15T00:00:00Z'), 2)), '2025-11-15');
  assert.equal(day(cleanupCutoff(new Date('2026-09-29T00:00:00Z'), 24)), '2024-09-29');
});

test('only processed and imported messages are selected for deletion', () => {
  const { remove, kept } = selectForDeletion([7, 3, 5, 9, 1], 7, new Set([1, 3, 7, 9]));
  assert.deepEqual(remove, [1, 3, 7]); // 5 not imported, 9 above the last processed UID
  assert.equal(kept, 2);
  assert.deepEqual(selectForDeletion([], 10, new Set()), { remove: [], kept: 0 });
});

// End-to-end against a disposable IMAP server (e.g. the dovecot/dovecot image) and MariaDB.
// Skipped unless TEST_IMAP_HOST and TEST_DB_HOST are set. Never point this at a real mailbox:
// it logs in as a fresh random user, which the test server creates on the fly.
const env = process.env;
const imapTarget = env.TEST_IMAP_HOST;
describe(
  'mailbox cleanup (IMAP + MariaDB)',
  { skip: imapTarget && env.TEST_DB_HOST ? false : 'TEST_IMAP_HOST/TEST_DB_HOST not set' },
  () => {
    const user = `cleanup-${randomBytes(4).toString('hex')}`;
    const imap = {
      host: imapTarget!,
      port: Number(env.TEST_IMAP_PORT ?? 31993),
      secure: true,
      auth: { user, pass: env.TEST_IMAP_PASSWORD ?? 'secret' },
      tls: { rejectUnauthorized: false },
      logger: false as const,
    };
    const dbCfg = {
      host: env.TEST_DB_HOST!,
      port: Number(env.TEST_DB_PORT ?? 3306),
      user: env.TEST_DB_USER ?? 'root',
      password: env.TEST_DB_PASSWORD,
      // Separate from store.test.ts (test files run in parallel); covered by the tlsrpt\_test% grant.
      database: `${env.TEST_DB_NAME ?? 'tlsrpt_test'}_cleanup`,
    };
    const saved = { ...config.imap };
    let store: Store;

    const report = (id: string) => {
      const r = structuredClone(fixture('google-sts.json')) as Record<string, unknown>;
      r['report-id'] = id;
      return gzipSync(JSON.stringify(r)).toString('base64');
    };
    const eml = (date: string, subject: string, attachment?: string) =>
      [
        'From: reporter@example.net',
        `Date: ${date}`,
        `Subject: ${subject}`,
        `Message-ID: <${randomBytes(6).toString('hex')}@example.net>`,
        'MIME-Version: 1.0',
        ...(attachment === undefined
          ? ['Content-Type: text/plain', '', 'Not a report.']
          : [
              'Content-Type: multipart/report; report-type="tlsrpt"; boundary="b"',
              '',
              '--b',
              'Content-Type: application/tlsrpt+gzip',
              'Content-Disposition: attachment; filename="r.json.gz"',
              'Content-Transfer-Encoding: base64',
              '',
              attachment,
              '--b--',
            ]),
        '',
      ].join('\r\n');

    const subjects = async (client: ImapFlow, mailbox: string) => {
      const lock = await client.getMailboxLock(mailbox, { readOnly: true });
      try {
        const out: string[] = [];
        if (client.mailbox && client.mailbox.exists) {
          for await (const m of client.fetch('1:*', { envelope: true })) out.push(m.envelope?.subject ?? '');
        }
        return out.sort();
      } finally {
        lock.release();
      }
    };

    before(async () => {
      const conn = await mariadb.createConnection({
        host: dbCfg.host,
        port: dbCfg.port,
        user: dbCfg.user,
        password: dbCfg.password,
      });
      await conn.query(`DROP DATABASE IF EXISTS \`${dbCfg.database}\``);
      await conn.query(`CREATE DATABASE \`${dbCfg.database}\``);
      await conn.end();
      store = await Store.connect(dbCfg);

      const client = new ImapFlow(imap);
      await client.connect();
      const old = 'Wed, 01 Jan 2025 10:00:00 +0000';
      const recent = new Date().toUTCString().replace('GMT', '+0000');
      await client.append('INBOX', eml(old, 'old report', report('old-1')));
      await client.append('INBOX', eml(old, 'old other mail'));
      await client.append('INBOX', eml(old, 'old broken report', Buffer.from('not gzip').toString('base64')));
      await client.append('INBOX', eml(recent, 'recent report', report('recent-1')));
      await client.mailboxCreate('Archive');
      await client.append('Archive', eml(old, 'archived old report', report('archived-1')));
      await client.logout();

      Object.assign(config.imap, {
        host: imap.host,
        port: imap.port,
        secure: true,
        user,
        pass: imap.auth.pass,
        mailbox: 'INBOX',
        rejectUnauthorized: false,
        deleteAfterMonths: 6,
      });
    });

    after(async () => {
      Object.assign(config.imap, saved);
      await store?.close();
    });

    test('a dry run reports what would go and deletes nothing', async () => {
      config.imap.deleteDryRun = true;
      const r = await new Syncer(store, () => {}).run();
      assert.equal(r.reportsAdded, 2);
      assert.equal(r.deleted, 1);
      const client = new ImapFlow(imap);
      await client.connect();
      assert.equal((await subjects(client, 'INBOX')).length, 4);
      await client.logout();
    });

    test('only old, imported messages in IMAP_DIR are deleted; reports stay stored', async () => {
      config.imap.deleteDryRun = false;
      const logs: string[] = [];
      const r = await new Syncer(store, (m) => logs.push(m)).run();
      assert.equal(r.deleted, 1, logs.join('\n'));
      assert.ok(
        logs.some((l) => /deleted 1 message\(s\).*2 older message\(s\) kept because they were not imported/.test(l)),
        logs.join('\n'),
      );

      const client = new ImapFlow(imap);
      await client.connect();
      assert.deepEqual(await subjects(client, 'INBOX'), ['old broken report', 'old other mail', 'recent report']);
      assert.deepEqual(await subjects(client, 'Archive'), ['archived old report']);
      await client.logout();

      assert.equal((await store.loadReports({})).filter((x) => x.reportId === 'old-1').length, 1);
      const [row] = await store.pool.query<{ n: number }[]>(
        'SELECT COUNT(*) AS n FROM messages WHERE deleted_at IS NOT NULL',
      );
      assert.equal(Number(row!.n), 1);
    });

    test('a later run is a no-op, and disabling cleanup deletes nothing', async () => {
      assert.equal((await new Syncer(store, () => {}).run()).deleted, 0);
      config.imap.deleteAfterMonths = 0;
      assert.equal((await new Syncer(store, () => {}).run()).deleted, 0);
    });
  },
);
