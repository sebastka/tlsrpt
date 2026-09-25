// OpenID Connect login (authorization code flow with PKCE) and server-side sessions.
import { createHash, randomBytes } from 'node:crypto';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import * as oidc from 'openid-client';
import type { AuthUser } from '../shared/types.ts';
import { config } from './config.ts';
import type { Store } from './db.ts';

export type AppEnv = { Variables: { user: AuthUser | null } };

const SESSION_COOKIE = 'tlsrpt_session';
const LOGIN_COOKIE = 'tlsrpt_login';
/** The only routes reachable without a session. */
const PUBLIC_PATHS = new Set(['/auth/login', '/auth/callback', '/auth/logout', '/api/health']);

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Only same-site relative paths are accepted as post-login redirect targets. */
export function safeReturnTo(v: string | undefined | null): string {
  if (!v || !v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\') || v.startsWith('/auth/')) return '/';
  return v;
}

/**
 * Reads the groups claim. The name is tried as-is first (some providers use URLs as claim
 * names), then as a dotted path into nested claims, e.g. Keycloak's "realm_access.roles".
 */
export function groupsFromClaims(claims: Record<string, unknown>, claim: string): string[] | null {
  let raw: unknown = claims[claim];
  if (raw === undefined && claim.includes('.')) {
    raw = claim
      .split('.')
      .reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), claims);
  }
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') return raw.split(/[\s,]+/).filter(Boolean);
  return null;
}

/** Only members of an allowed group may open the dashboard. Returns a reason when denied. */
export function authorize(
  claims: Record<string, unknown>,
  cfg: Pick<typeof config.oidc, 'allowedGroups' | 'groupsClaim'> = config.oidc,
): string | null {
  const groups = groupsFromClaims(claims, cfg.groupsClaim);
  if (groups === null) {
    return `the identity provider did not send a "${cfg.groupsClaim}" claim; add a group mapper or scope for this client`;
  }
  // An empty allow-list is refused at startup; deny here as well rather than fail open.
  if (!groups.some((g) => cfg.allowedGroups.includes(g))) {
    return 'you are not a member of a group that is allowed to open this dashboard';
  }
  return null;
}

function page(c: Context, status: 401 | 403 | 502, title: string, message: string) {
  const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return c.html(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>body{font:15px system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 16px;color:#0b0b0b;background:#f9f9f7}
@media (prefers-color-scheme:dark){body{color:#fff;background:#0d0d0d}a{color:#86b6ef}}</style>
<h1 style="font-size:20px">${esc(title)}</h1><p>${esc(message)}</p><p><a href="/auth/login">Try again</a></p>`,
    status,
  );
}

export class Auth {
  private readonly store: Store;
  private discovery: Promise<oidc.Configuration> | null = null;

  constructor(store: Store) {
    this.store = store;
  }

  private get secureCookies(): boolean {
    return config.http.publicUrl?.startsWith('https://') ?? false;
  }

  /** Lazily discovers the provider; a failed discovery is retried on the next request. */
  private client(): Promise<oidc.Configuration> {
    this.discovery ??= oidc
      .discovery(
        new URL(config.oidc.issuer!),
        config.oidc.clientId!,
        undefined,
        config.oidc.clientSecret ? oidc.ClientSecretPost(config.oidc.clientSecret) : oidc.None(),
        config.oidc.allowInsecureIssuer ? { execute: [oidc.allowInsecureRequests] } : undefined,
      )
      .catch((e: unknown) => {
        this.discovery = null;
        throw e;
      });
    return this.discovery;
  }

  private get redirectUri(): string {
    return `${config.http.publicUrl}/auth/callback`;
  }

  /** Resolves the session cookie to a user; everything except PUBLIC_PATHS requires login. */
  middleware(): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
      c.set('user', null);
      const path = c.req.path;
      if (PUBLIC_PATHS.has(path)) return next();

      const token = getCookie(c, SESSION_COOKIE);
      const session = token ? await this.store.getSession(sha256(token)) : null;
      if (session) {
        c.set('user', { sub: session.sub, email: session.email, name: session.name });
        return next();
      }
      if (path.startsWith('/api/')) return c.json({ error: 'authentication required' }, 401);
      const url = new URL(c.req.url);
      return c.redirect(`/auth/login?returnTo=${encodeURIComponent(url.pathname + url.search)}`);
    };
  }

  routes(app: Hono<AppEnv>): void {
    app.get('/auth/login', async (c) => {
      let client: oidc.Configuration;
      try {
        client = await this.client();
      } catch (e) {
        console.error('[auth] OIDC discovery failed:', e);
        return page(c, 502, 'Login unavailable', 'The identity provider could not be reached. Try again later.');
      }
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const codeVerifier = oidc.randomPKCECodeVerifier();
      await this.store.purgeExpiredAuth();
      await this.store.createLogin(state, { codeVerifier, nonce, returnTo: safeReturnTo(c.req.query('returnTo')) });
      // Binds the login to this browser (login CSRF protection).
      setCookie(c, LOGIN_COOKIE, state, {
        httpOnly: true,
        secure: this.secureCookies,
        sameSite: 'Lax',
        path: '/auth/',
        maxAge: 600,
      });
      const url = oidc.buildAuthorizationUrl(client, {
        redirect_uri: this.redirectUri,
        scope: config.oidc.scopes,
        code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
        state,
        nonce,
      });
      return c.redirect(url.href);
    });

    app.get('/auth/callback', async (c) => {
      const error = c.req.query('error');
      if (error) {
        return page(c, 401, 'Login failed', `${error}: ${c.req.query('error_description') ?? 'no details'}`);
      }
      const state = getCookie(c, LOGIN_COOKIE);
      deleteCookie(c, LOGIN_COOKIE, { path: '/auth/', secure: this.secureCookies });
      const pending = state ? await this.store.takeLogin(state) : null;
      if (!state || !pending) {
        return page(c, 401, 'Login expired', 'The login attempt expired or was started in another browser.');
      }

      let claims: Record<string, unknown>;
      let idToken: string | undefined;
      try {
        const client = await this.client();
        const current = new URL(this.redirectUri);
        current.search = new URL(c.req.url).search;
        const tokens = await oidc.authorizationCodeGrant(client, current, {
          pkceCodeVerifier: pending.codeVerifier,
          expectedState: state,
          expectedNonce: pending.nonce,
          idTokenExpected: true,
        });
        const idClaims = tokens.claims()!;
        claims = { ...idClaims };
        idToken = tokens.id_token;
        if (client.serverMetadata().userinfo_endpoint) {
          try {
            const info = await oidc.fetchUserInfo(client, tokens.access_token, idClaims.sub);
            // fetchUserInfo verifies that userinfo.sub matches the ID token.
            claims = { ...idClaims, ...info };
          } catch (e) {
            console.warn('[auth] userinfo request failed, using ID token claims only:', (e as Error).message);
          }
        }
      } catch (e) {
        console.error('[auth] token exchange failed:', e);
        return page(c, 401, 'Login failed', 'The identity provider response could not be validated.');
      }

      const denied = authorize(claims);
      if (denied) {
        console.warn(`[auth] access denied for ${String(claims.sub)}: ${denied}`);
        return page(c, 403, 'Access denied', denied);
      }

      const token = randomBytes(32).toString('base64url');
      const ttl = config.oidc.sessionTtlHours * 3600;
      await this.store.createSession(
        sha256(token),
        {
          sub: String(claims.sub),
          email: typeof claims.email === 'string' ? claims.email : null,
          name:
            typeof claims.name === 'string'
              ? claims.name
              : typeof claims.preferred_username === 'string'
                ? claims.preferred_username
                : null,
          idToken: idToken ?? null,
        },
        ttl,
      );
      setCookie(c, SESSION_COOKIE, token, {
        httpOnly: true,
        secure: this.secureCookies,
        sameSite: 'Lax',
        path: '/',
        maxAge: ttl,
      });
      return c.redirect(pending.returnTo);
    });

    app.post('/auth/logout', async (c) => {
      const token = getCookie(c, SESSION_COOKIE);
      deleteCookie(c, SESSION_COOKIE, { path: '/', secure: this.secureCookies });
      const session = token ? await this.store.deleteSession(sha256(token)) : null;
      let target = '/';
      try {
        const client = await this.client();
        // RP-initiated logout ends the provider session too, when supported.
        if (client.serverMetadata().end_session_endpoint) {
          target = oidc.buildEndSessionUrl(client, {
            post_logout_redirect_uri: `${config.http.publicUrl}/`,
            ...(session?.idToken ? { id_token_hint: session.idToken } : {}),
          }).href;
        }
      } catch {
        // provider unreachable: local logout only
      }
      return c.redirect(target, 303);
    });
  }
}

/**
 * Rejects cross-site state-changing requests. SameSite=Lax cookies already prevent most
 * CSRF, this adds a check on the browser-provided Fetch Metadata / Origin headers.
 */
export function sameOriginGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') return next();
    const site = c.req.header('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') return c.json({ error: 'cross-site request refused' }, 403);
    const origin = c.req.header('origin');
    if (origin && !site) {
      const expected = config.http.publicUrl ?? `${new URL(c.req.url).protocol}//${c.req.header('host')}`;
      if (new URL(origin).origin !== new URL(expected).origin) {
        return c.json({ error: 'cross-origin request refused' }, 403);
      }
    }
    return next();
  };
}
