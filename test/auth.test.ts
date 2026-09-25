import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import * as oidc from 'openid-client';
import { authorize, clientAuth, readGroupsClaim, safeReturnTo } from '../src/server/auth.ts';
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

const ok = (groups: string[]) => ({ status: 'ok', groups });

test('groups claim can be a nested path or a URL-like claim name', () => {
  assert.deepEqual(readGroupsClaim({ realm_access: { roles: ['a', 'b'] } }, 'realm_access.roles'), ok(['a', 'b']));
  assert.deepEqual(readGroupsClaim({ 'https://example.com/groups': ['a'] }, 'https://example.com/groups'), ok(['a']));
  assert.deepEqual(readGroupsClaim({ realm_access: {} }, 'realm_access.roles'), { status: 'missing' });
  // "@" has no special meaning in lists: e-mail style group names match as-is.
  assert.equal(authorize({ sub: 'a', groups: ['noc@example.com'] }, groups(['noc@example.com'])), null);
});

test('Zitadel project roles are scoped to the organisation that granted them', () => {
  const claim = 'urn:zitadel:iam:org:project:roles';
  const zitadel = {
    [claim]: {
      operations: { '123': 'inbox.com' },
      support_1l: { '123': 'inbox.com', '456': 'partner.example' },
    },
  };
  assert.deepEqual(readGroupsClaim(zitadel, claim), ok(['operations@123', 'support_1l@123', 'support_1l@456']));
  assert.equal(authorize({ sub: 'a', ...zitadel }, groups(['operations@123'], claim)), null);
  // The bare role name never matches, and neither does the role in another organisation.
  assert.match(authorize({ sub: 'a', ...zitadel }, groups(['operations'], claim))!, /not a member/);
  assert.match(authorize({ sub: 'a', ...zitadel }, groups(['operations@456'], claim))!, /not a member/);
  // Present but empty is a membership problem, not a missing mapper: the messages differ.
  assert.deepEqual(readGroupsClaim({ [claim]: {} }, claim), ok([]));
  assert.match(authorize({ sub: 'a', [claim]: {} }, groups(['operations@123'], claim))!, /not a member/);
  assert.match(authorize({ sub: 'a' }, groups(['operations@123'], claim))!, /did not send/);
});

test('claims of other shapes are refused instead of guessed at', () => {
  // Keycloak resource_access is keyed by client: its keys must not become groups.
  const keycloak = { resource_access: { tlsrpt: { roles: ['viewer'] }, account: { roles: ['manage-account'] } } };
  assert.deepEqual(readGroupsClaim(keycloak, 'resource_access'), { status: 'unsupported' });
  assert.match(authorize({ sub: 'a', ...keycloak }, groups(['tlsrpt'], 'resource_access'))!, /unsupported format/);
  for (const bad of [{ a: 1 }, { a: ['x'] }, { a: { org: 1 } }, [{ name: 'x' }], 42, true]) {
    assert.deepEqual(readGroupsClaim({ groups: bad }, 'groups'), { status: 'unsupported' }, JSON.stringify(bad));
  }
});

test('the web server refuses to start without OIDC and allowed groups', () => {
  const base: Config = structuredClone({ ...config, staticDir: '' });
  base.db.password = 'x';
  base.http.publicUrl = 'https://tlsrpt.example.com';
  base.oidc = {
    ...base.oidc,
    issuer: 'https://idp.example',
    clientId: 'tlsrpt',
    clientSecret: 's3cret',
    tokenAuthMethod: 'client_secret_basic',
    allowedGroups: ['noc'],
  };
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
  assert.throws(
    without((c) => (c.oidc.clientSecret = undefined)),
    /OIDC_CLIENT_SECRET/,
  );
  assert.throws(
    without((c) => (c.oidc.tokenAuthMethod = 'private_key_jwt' as never)),
    /OIDC_TOKEN_AUTH_METHOD must be one of/,
  );
  assert.throws(
    without((c) => (c.oidc.tokenAuthMethod = 'none')),
    /public client/,
  );
  assert.doesNotThrow(
    without((c) => {
      c.oidc.tokenAuthMethod = 'none';
      c.oidc.clientSecret = undefined;
    }),
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

test('the default is client_secret_basic, and each method authenticates as registered', async () => {
  const { config: fresh } = await import(`../src/server/config.ts?default=${Date.now()}`);
  if (!process.env.OIDC_TOKEN_AUTH_METHOD) assert.equal(fresh.oidc.tokenAuthMethod, 'client_secret_basic');

  // A minimal token endpoint that records how the client authenticated.
  let seen: { authorization?: string; body: URLSearchParams } | null = null;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen = { authorization: req.headers.authorization, body: new URLSearchParams(body) };
      res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"invalid_grant"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  const as = { issuer: 'http://idp.test', token_endpoint: `http://127.0.0.1:${port}/token` };
  const tokenRequest = async (method: Parameters<typeof clientAuth>[0], secret?: string) => {
    const c = new oidc.Configuration(as, 'tlsrpt', undefined, clientAuth(method, secret));
    oidc.allowInsecureRequests(c);
    await assert.rejects(oidc.refreshTokenGrant(c, 'rt'));
    return seen!;
  };
  try {
    const basic = await tokenRequest('client_secret_basic', 's3cret');
    assert.equal(basic.authorization, `Basic ${Buffer.from('tlsrpt:s3cret').toString('base64')}`);
    assert.equal(basic.body.get('client_secret'), null);

    const post = await tokenRequest('client_secret_post', 's3cret');
    assert.equal(post.authorization, undefined);
    assert.equal(post.body.get('client_secret'), 's3cret');

    const jwt = await tokenRequest('client_secret_jwt', 's3cret');
    assert.equal(jwt.body.get('client_assertion_type'), 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    assert.equal(jwt.body.get('client_secret'), null);

    const none = await tokenRequest('none');
    assert.equal(none.authorization, undefined);
    assert.equal(none.body.get('client_id'), 'tlsrpt');
    assert.equal(none.body.get('client_secret'), null);
  } finally {
    server.close();
  }
});
