import { resolve } from 'node:path';

function str(name: string, fallback?: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : fallback;
}

function int(name: string, fallback: number): number {
  const v = str(name);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer, got "${v}"`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = str(name)?.toLowerCase();
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v);
}

function list(name: string): string[] {
  return (str(name) ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const imapPort = int('IMAP_PORT', 993);
const publicUrl = str('PUBLIC_URL')?.replace(/\/+$/, '');

export const config = {
  imap: {
    host: str('IMAP_HOST'),
    port: imapPort,
    // Implicit TLS on 993, STARTTLS (upgraded by ImapFlow) otherwise.
    secure: bool('IMAP_TLS', imapPort === 993),
    user: str('IMAP_USERNAME'),
    pass: str('IMAP_PASSWORD'),
    mailbox: str('IMAP_DIR', 'INBOX')!,
    rejectUnauthorized: bool('IMAP_TLS_REJECT_UNAUTHORIZED', true),
    /** Messages larger than this are skipped (bytes). */
    maxMessageSize: int('IMAP_MAX_MESSAGE_BYTES', 25 * 1024 * 1024),
  },
  db: {
    host: str('DB_HOST', '127.0.0.1')!,
    port: int('DB_PORT', 3306),
    user: str('DB_USER', 'tlsrpt')!,
    password: str('DB_PASSWORD'),
    database: str('DB_NAME', 'tlsrpt')!,
    connectionLimit: int('DB_POOL_SIZE', 5),
    ssl: bool('DB_TLS', false),
  },
  http: {
    host: str('LISTEN_HOST', '127.0.0.1')!,
    port: int('PORT', 3000),
    /** External origin (scheme + host), used for the OIDC redirect URI. Required. */
    publicUrl,
  },
  oidc: {
    issuer: str('OIDC_ISSUER'),
    clientId: str('OIDC_CLIENT_ID'),
    clientSecret: str('OIDC_CLIENT_SECRET'),
    scopes: str('OIDC_SCOPES', 'openid profile email')!,
    /** Members of at least one of these groups may open the dashboard. Required. */
    allowedGroups: list('OIDC_ALLOWED_GROUPS'),
    groupsClaim: str('OIDC_GROUPS_CLAIM', 'groups')!,
    sessionTtlHours: int('SESSION_TTL_HOURS', 12),
    /** Development only: allow an http:// issuer (e.g. a local mock provider). */
    allowInsecureIssuer: bool('OIDC_ALLOW_INSECURE_ISSUER', false),
  },
  /** 0 disables periodic sync (manual / CLI only). */
  syncIntervalMinutes: int('SYNC_INTERVAL_MINUTES', 30),
  // Relative to this file, so the bundle works whatever the working directory is.
  staticDir: resolve(str('STATIC_DIR') ?? resolve(import.meta.dirname, '../../dist/web')),
};

export function imapConfigured(): boolean {
  return Boolean(config.imap.host && config.imap.user && config.imap.pass);
}

export type Config = typeof config;

/**
 * Fails fast on configuration that would otherwise break later. The web server always
 * requires OIDC login; `server: false` is for CLI tools that never serve HTTP.
 */
export function validateConfig({ server }: { server: boolean }, cfg: Config = config): void {
  const missing: string[] = [];
  if (!cfg.db.password) missing.push('DB_PASSWORD');
  if (server) {
    if (!cfg.oidc.issuer) missing.push('OIDC_ISSUER');
    if (!cfg.oidc.clientId) missing.push('OIDC_CLIENT_ID');
    if (!cfg.oidc.allowedGroups.length) missing.push('OIDC_ALLOWED_GROUPS');
    if (!cfg.http.publicUrl) missing.push('PUBLIC_URL');
  }
  if (missing.length) {
    throw new Error(`missing required configuration: ${missing.join(', ')} (login via OIDC is mandatory)`);
  }
  if (server) {
    const u = new URL(cfg.http.publicUrl!);
    if (u.pathname !== '/' || u.search) {
      throw new Error('PUBLIC_URL must be an origin without a path, e.g. https://tlsrpt.example.com');
    }
  }
}
