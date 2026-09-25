import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { authorize, groupsFromClaims, safeReturnTo } from '../src/server/auth.ts';
import { config, validateConfig, type Config } from '../src/server/config.ts';

const groups = (allowedGroups: string[], groupsClaim = 'groups') => ({ allowedGroups, groupsClaim });

test('safeReturnTo only accepts local paths', () => {
  assert.equal(safeReturnTo('/?range=7d'), '/?range=7d');
  for (const bad of [undefined, '', 'https://evil.example', '//evil.example', '/\\evil.example', '/auth/login']) {
    assert.equal(safeReturnTo(bad), '/');
  }
});

test('authorize requires membership of an allowed group', () => {
  const c = groups(['tlsrpt-admins', 'noc']);
  assert.equal(authorize({ sub: 'a', groups: ['x', 'noc'] }, c), null);
  assert.equal(authorize({ sub: 'a', groups: 'x tlsrpt-admins' }, c), null);
  assert.match(authorize({ sub: 'a', groups: ['x'] }, c)!, /not a member/);
  assert.match(authorize({ sub: 'a', groups: [] }, c)!, /not a member/);
  assert.match(authorize({ sub: 'a' }, c)!, /did not send a "groups" claim/);
});

test('authorize fails closed with an empty allow-list', () => {
  assert.match(authorize({ sub: 'a', groups: ['anything'] }, groups([]))!, /not a member/);
});

test('groups claim can be a nested path or a URL-like claim name', () => {
  assert.deepEqual(groupsFromClaims({ realm_access: { roles: ['a', 'b'] } }, 'realm_access.roles'), ['a', 'b']);
  assert.deepEqual(groupsFromClaims({ 'https://example.com/groups': ['a'] }, 'https://example.com/groups'), ['a']);
  assert.equal(groupsFromClaims({ realm_access: {} }, 'realm_access.roles'), null);
});

test('the web server refuses to start without OIDC and allowed groups', () => {
  const base: Config = structuredClone({ ...config, staticDir: '' });
  base.db.password = 'x';
  base.http.publicUrl = 'https://tlsrpt.example.com';
  base.oidc = { ...base.oidc, issuer: 'https://idp.example', clientId: 'tlsrpt', allowedGroups: ['noc'] };
  assert.doesNotThrow(() => validateConfig({ server: true }, base));

  const without = (patch: (c: Config) => void) => {
    const c = structuredClone(base);
    patch(c);
    return () => validateConfig({ server: true }, c);
  };
  assert.throws(
    without((c) => (c.oidc.allowedGroups = [])),
    /OIDC_ALLOWED_GROUPS/,
  );
  assert.throws(
    without((c) => (c.oidc.issuer = undefined)),
    /OIDC_ISSUER/,
  );
  assert.throws(
    without((c) => (c.oidc.clientId = undefined)),
    /OIDC_CLIENT_ID/,
  );
  assert.throws(
    without((c) => (c.http.publicUrl = undefined)),
    /PUBLIC_URL/,
  );
  assert.throws(
    without((c) => (c.http.publicUrl = 'https://x.example/tlsrpt')),
    /origin without a path/,
  );
  // The CLI sync never serves HTTP and only needs the database.
  assert.doesNotThrow(() =>
    validateConfig({ server: false }, { ...base, oidc: { ...base.oidc, issuer: undefined, allowedGroups: [] } }),
  );
});

test('every route except login, callback, logout and health requires a session', async () => {
  const { createApp } = await import('../src/server/app.ts');
  const token = 'valid-token';
  const hash = createHash('sha256').update(token).digest('hex');
  // Only the calls made by the auth middleware and the routes below are needed.
  const store = {
    getSession: async (h: string) => (h === hash ? { sub: 'u1', email: 'u@x', name: 'U', idToken: null } : null),
    filterOptions: async () => ({ domains: [], orgs: [], firstDay: null, lastDay: null }),
  };
  const syncer = { status: async () => ({}), run: async () => ({}) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = createApp(store as any, syncer as any);

  for (const path of ['/', '/index.html', '/assets/app.js', '/auth/other', '/some/spa/route']) {
    const res = await app.request(path);
    assert.equal(res.status, 302, path);
    assert.match(res.headers.get('location')!, /^\/auth\/login\?returnTo=/, path);
  }
  for (const path of ['/api/overview', '/api/reports', '/api/reports/1', '/api/filters', '/api/sync', '/api/me']) {
    assert.equal((await app.request(path)).status, 401, path);
  }
  assert.equal((await app.request('/api/sync', { method: 'POST' })).status, 401);
  assert.equal((await app.request('/api/health')).status, 200);
  assert.equal((await app.request('/api/me', { headers: { cookie: 'tlsrpt_session=forged' } })).status, 401);

  const me = await app.request('/api/me', { headers: { cookie: `tlsrpt_session=${token}` } });
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), { user: { sub: 'u1', email: 'u@x', name: 'U' } });
  const filters = await app.request('/api/filters', { headers: { cookie: `tlsrpt_session=${token}` } });
  assert.equal(filters.status, 200);
});
