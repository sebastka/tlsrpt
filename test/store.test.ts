// Integration tests against a real MariaDB. Skipped unless TEST_DB_HOST is set.
// The database named TEST_DB_NAME (default tlsrpt_test) is dropped and recreated.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import mariadb from 'mariadb';
import { buildOverview } from '../src/server/analysis.ts';
import { Store } from '../src/server/db.ts';
import { normalizeReport } from '../src/server/tlsrpt.ts';
import { fixture } from './helpers.ts';

const env = process.env;
const cfg = {
  host: env.TEST_DB_HOST ?? '',
  port: Number(env.TEST_DB_PORT ?? 3306),
  user: env.TEST_DB_USER ?? 'root',
  password: env.TEST_DB_PASSWORD,
  database: env.TEST_DB_NAME ?? 'tlsrpt_test',
};

describe('Store (MariaDB)', { skip: cfg.host ? false : 'TEST_DB_HOST not set' }, () => {
  let store: Store;
  const src = { from: 'r@example.net', subject: 's', filename: 'f.json.gz', receivedAt: '2026-08-28T16:02:31.000Z' };
  const insert = (name: string) => {
    const raw = fixture(name);
    return store.insertReport(normalizeReport(raw), raw, src);
  };

  before(async () => {
    if (!/^[\w]+$/.test(cfg.database) || !cfg.database.endsWith('_test'))
      throw new Error('TEST_DB_NAME must end with _test');
    const conn = await mariadb.createConnection({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
    });
    await conn.query(`DROP DATABASE IF EXISTS \`${cfg.database}\``);
    await conn.query(`CREATE DATABASE \`${cfg.database}\` CHARACTER SET utf8mb4`);
    await conn.end();
    store = await Store.connect(cfg);
    for (const f of ['google-sts.json', 'microsoft-tlsa-sts.json', 'synthetic-failures.json']) {
      assert.equal(await insert(f), true);
    }
  });

  after(async () => {
    await store?.close();
  });

  test('migrations are idempotent', async () => {
    const again = await Store.connect(cfg);
    await again.close();
  });

  test('duplicates are detected on organisation + report-id', async () => {
    assert.equal(await insert('google-sts.json'), false);
    assert.equal((await store.totals()).reports, 3);
  });

  test('loadReports round-trips reports, policies and failures', async () => {
    const all = await store.loadReports({});
    assert.equal(all.length, 3);
    const o = buildOverview(all, {}, new Date('2026-09-11T00:00:00Z'));
    assert.equal(o.kpis.sessions, 111);
    assert.equal(o.kpis.failed, 10);
    const r = all.find((x) => x.org === 'Google Inc.')!;
    assert.equal(r.start, '2026-08-27T00:00:00.000Z');
    assert.equal(r.day, '2026-08-27');
    assert.equal(r.receivedAt, src.receivedAt);
    assert.deepEqual(r.policies[0]!.mxHosts, ['mx.domeneshop.no']);
    const detail = await store.reportById(r.id);
    assert.equal(detail?.reportId, r.reportId);
    const source = (await store.reportSource(r.id)) as { raw: Record<string, unknown> };
    assert.equal(source.raw['organization-name'], 'Google Inc.');
  });

  test('timestamps are stored in UTC whatever the process time zone', async () => {
    const [row] = await store.pool.query<{ s: string }[]>(
      "SELECT DATE_FORMAT(start_ts, '%Y-%m-%d %H:%i:%s') AS s FROM reports WHERE org_name = 'Google Inc.'",
    );
    assert.equal(row!.s, '2026-08-27 00:00:00');
  });

  test('filters narrow the data set', async () => {
    assert.equal((await store.loadReports({ domain: 'example.org' })).length, 1);
    assert.equal((await store.loadReports({ domain: 'example.org' }))[0]!.policies.length, 1);
    assert.equal((await store.loadReports({ from: '2026-08-20', to: '2026-08-31' })).length, 1);
    assert.equal((await store.loadReports({ org: 'Microsoft Corporation' })).length, 1);
    const opts = await store.filterOptions();
    assert.deepEqual(opts.domains, ['example.com', 'example.org', 'karlsen.fr']);
    assert.equal(opts.firstDay, '2026-08-18');
  });

  test('meta and message bookkeeping', async () => {
    await store.setMeta('uidvalidity:INBOX', '42');
    await store.setMeta('uidvalidity:INBOX', '43');
    assert.equal(await store.getMeta('uidvalidity:INBOX'), '43');
    const base = { mailbox: 'INBOX', uidvalidity: '43', messageId: null, from: 'x@y', subject: 's', date: null };
    await store.recordMessage({ ...base, uid: 1, status: 'no-report', error: null });
    await store.recordMessage({ ...base, uid: 1, status: 'error', error: 'boom' });
    const issues = await store.messageIssues('INBOX');
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.error, 'boom');
  });

  test('sessions and pending logins are single-use and expire', async () => {
    await store.createSession('a'.repeat(64), { sub: 's1', email: 'e@x', name: 'N', idToken: 't' }, 3600);
    assert.equal((await store.getSession('a'.repeat(64)))?.sub, 's1');
    await store.createSession('b'.repeat(64), { sub: 's2', email: null, name: null, idToken: null }, -1);
    assert.equal(await store.getSession('b'.repeat(64)), null);
    assert.equal((await store.deleteSession('a'.repeat(64)))?.idToken, 't');
    assert.equal(await store.getSession('a'.repeat(64)), null);

    await store.createLogin('st', { codeVerifier: 'v', nonce: 'n', returnTo: '/x' });
    assert.deepEqual(await store.takeLogin('st'), { codeVerifier: 'v', nonce: 'n', returnTo: '/x' });
    assert.equal(await store.takeLogin('st'), null);
  });

  test('exclusive lock prevents concurrent holders', async () => {
    let inner: unknown = 'not run';
    const outer = await store.withExclusiveLock('tlsrpt_test_lock', async () => {
      inner = await store.withExclusiveLock('tlsrpt_test_lock', async () => 'ran');
      return 'outer';
    });
    assert.equal(outer, 'outer');
    assert.equal(inner, null);
  });
});
