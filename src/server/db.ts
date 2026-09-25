// MariaDB persistence.
import mariadb, { type Pool, type PoolConnection } from 'mariadb';
import type { Filters, FilterOptions, MessageIssue } from '../shared/types.ts';
import type { NormalizedFailure, NormalizedReport } from './tlsrpt.ts';

/**
 * Ordered schema migrations. Never edit an applied migration; append a new one.
 * Each entry is a list of statements (the driver runs one statement per query).
 */
const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE meta (
       k VARCHAR(191) NOT NULL PRIMARY KEY,
       v TEXT NOT NULL
     )`,
    `CREATE TABLE messages (
       mailbox      VARCHAR(191) NOT NULL,
       uidvalidity  VARCHAR(32)  NOT NULL,
       uid          INT UNSIGNED NOT NULL,
       message_id   TEXT,
       from_addr    VARCHAR(320),
       subject      TEXT,
       date         DATETIME,
       status       ENUM('ok', 'duplicate', 'no-report', 'error') NOT NULL,
       error        TEXT,
       processed_at DATETIME NOT NULL,
       PRIMARY KEY (mailbox, uidvalidity, uid)
     )`,
    `CREATE TABLE reports (
       id           INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
       org_name     VARCHAR(255) NOT NULL,
       report_id    VARCHAR(255) COLLATE utf8mb4_bin NOT NULL,
       contact_info VARCHAR(1024),
       start_ts     DATETIME NOT NULL,
       end_ts       DATETIME NOT NULL,
       day          DATE NOT NULL,
       raw_json     LONGTEXT NOT NULL CHECK (JSON_VALID(raw_json)),
       src_from     VARCHAR(320),
       src_subject  TEXT,
       src_filename VARCHAR(1024),
       received_at  DATETIME,
       created_at   DATETIME NOT NULL,
       UNIQUE KEY reports_unique (org_name, report_id),
       KEY reports_day (day)
     )`,
    `CREATE TABLE policies (
       id            INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
       report_ref    INT UNSIGNED NOT NULL,
       policy_type   VARCHAR(32)  NOT NULL,
       policy_domain VARCHAR(255) NOT NULL,
       policy_string LONGTEXT NOT NULL CHECK (JSON_VALID(policy_string)),
       mx_hosts      LONGTEXT NOT NULL CHECK (JSON_VALID(mx_hosts)),
       sts_mode      VARCHAR(32),
       success_count INT UNSIGNED NOT NULL,
       failure_count INT UNSIGNED NOT NULL,
       KEY policies_domain (policy_domain),
       CONSTRAINT policies_report FOREIGN KEY (report_ref) REFERENCES reports (id) ON DELETE CASCADE
     )`,
    `CREATE TABLE failures (
       id                     INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
       policy_ref             INT UNSIGNED NOT NULL,
       result_type            VARCHAR(64) NOT NULL,
       sending_mta_ip         VARCHAR(64),
       receiving_mx_hostname  VARCHAR(255),
       receiving_mx_helo      VARCHAR(255),
       receiving_ip           VARCHAR(64),
       failed_session_count   INT UNSIGNED NOT NULL,
       additional_information TEXT,
       failure_reason_code    VARCHAR(255),
       CONSTRAINT failures_policy FOREIGN KEY (policy_ref) REFERENCES policies (id) ON DELETE CASCADE
     )`,
    `CREATE TABLE sessions (
       token_hash CHAR(64) NOT NULL PRIMARY KEY,
       sub        VARCHAR(255) NOT NULL,
       email      VARCHAR(320),
       name       VARCHAR(255),
       id_token   TEXT,
       created_at DATETIME NOT NULL,
       expires_at DATETIME NOT NULL,
       KEY sessions_expiry (expires_at)
     )`,
    `CREATE TABLE oidc_logins (
       state         VARCHAR(128) NOT NULL PRIMARY KEY,
       code_verifier VARCHAR(128) NOT NULL,
       nonce         VARCHAR(128) NOT NULL,
       return_to     VARCHAR(2048) NOT NULL,
       created_at    DATETIME NOT NULL
     )`,
  ],
];

export interface ReportRow {
  id: number;
  org: string;
  reportId: string;
  contactInfo: string | null;
  start: string;
  end: string;
  day: string;
  receivedAt: string | null;
  policies: PolicyRow[];
}

export interface PolicyRow {
  id: number;
  type: string;
  domain: string;
  policyString: string[];
  mxHosts: string[];
  mode: string | null;
  successful: number;
  failed: number;
  failures: NormalizedFailure[];
}

export interface MessageRecord {
  mailbox: string;
  uidvalidity: string;
  uid: number;
  messageId: string | null;
  from: string | null;
  subject: string | null;
  date: string | null;
  status: 'ok' | 'duplicate' | 'no-report' | 'error';
  error: string | null;
}

export interface SessionRecord {
  sub: string;
  email: string | null;
  name: string | null;
  idToken: string | null;
}

export interface PendingLogin {
  codeVerifier: string;
  nonce: string;
  returnTo: string;
}

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password?: string | undefined;
  database: string;
  connectionLimit?: number;
  ssl?: boolean;
}

// The driver returns loosely typed rows.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

// DATETIME columns hold UTC. They are exchanged with the driver as 'YYYY-MM-DD HH:MM:SS'
// strings (dateStrings), because the driver otherwise converts using the process time zone.
const iso = (s: string | null | undefined): string | null =>
  s ? new Date(`${s.replace(' ', 'T')}Z`).toISOString() : null;
const dbTime = (s: string | Date | null): string | null =>
  s ? new Date(s).toISOString().slice(0, 19).replace('T', ' ') : null;
const clip = (s: string | null, n: number): string | null => (s && s.length > n ? s.slice(0, n) : s);
const json = <T>(v: unknown): T => (typeof v === 'string' ? (JSON.parse(v) as T) : (v as T));

export class Store {
  readonly pool: Pool;

  private constructor(pool: Pool) {
    this.pool = pool;
  }

  /** Connects and applies pending migrations. */
  static async connect(cfg: DbConfig): Promise<Store> {
    const pool = mariadb.createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      connectionLimit: cfg.connectionLimit ?? 5,
      ssl: cfg.ssl ? { rejectUnauthorized: true } : undefined,
      dateStrings: true,
      bigIntAsNumber: true,
      insertIdAsNumber: true,
      decimalAsNumber: true,
      charset: 'utf8mb4',
    });
    const store = new Store(pool);
    try {
      await store.migrate();
    } catch (e) {
      await pool.end();
      throw e;
    }
    return store;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async migrate(): Promise<void> {
    await this.withConnection(async (conn) => {
      // Serialise migrations when several instances start at once.
      const [lock] = await conn.query<Row[]>("SELECT GET_LOCK('tlsrpt_migrate', 60) AS ok");
      if (lock?.ok !== 1) throw new Error('could not acquire the migration lock');
      try {
        await conn.query(
          'CREATE TABLE IF NOT EXISTS schema_migrations (version INT UNSIGNED NOT NULL PRIMARY KEY, applied_at DATETIME NOT NULL)',
        );
        const [row] = await conn.query<Row[]>('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations');
        for (let v = Number(row?.v ?? 0); v < MIGRATIONS.length; v++) {
          // DDL commits implicitly in MariaDB, so a failed migration must be fixed by hand.
          for (const stmt of MIGRATIONS[v]!) await conn.query(stmt);
          await conn.query('INSERT INTO schema_migrations (version, applied_at) VALUES (?, UTC_TIMESTAMP())', [v + 1]);
        }
      } finally {
        await conn.query("SELECT RELEASE_LOCK('tlsrpt_migrate')");
      }
    });
  }

  private async withConnection<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
    const conn = await this.pool.getConnection();
    try {
      return await fn(conn);
    } finally {
      await conn.release();
    }
  }

  private async transaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
    return this.withConnection(async (conn) => {
      await conn.beginTransaction();
      try {
        const r = await fn(conn);
        await conn.commit();
        return r;
      } catch (e) {
        await conn.rollback();
        throw e;
      }
    });
  }

  /**
   * Runs fn while holding a named server-side lock, so only one instance does it at a time.
   * Returns null without running fn when another holder has the lock.
   */
  async withExclusiveLock<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    return this.withConnection(async (conn) => {
      const [lock] = await conn.query<Row[]>('SELECT GET_LOCK(?, 0) AS ok', [name]);
      if (lock?.ok !== 1) return null;
      try {
        return await fn();
      } finally {
        await conn.query('SELECT RELEASE_LOCK(?)', [name]);
      }
    });
  }

  async getMeta(key: string): Promise<string | null> {
    const [row] = await this.pool.query<Row[]>('SELECT v FROM meta WHERE k = ?', [key]);
    return (row?.v as string) ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.pool.query('INSERT INTO meta (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [key, value]);
  }

  /** Inserts a report; returns false when (organisation, report-id) is already stored. */
  async insertReport(
    r: NormalizedReport,
    raw: unknown,
    src: { from: string | null; subject: string | null; filename: string | null; receivedAt: string | null },
  ): Promise<boolean> {
    return this.transaction(async (conn) => {
      const res = await conn.query(
        `INSERT INTO reports
           (org_name, report_id, contact_info, start_ts, end_ts, day, raw_json, src_from, src_subject, src_filename, received_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())
         ON DUPLICATE KEY UPDATE id = id`,
        [
          clip(r.organizationName, 255),
          clip(r.reportId, 255),
          clip(r.contactInfo, 1024),
          dbTime(r.start),
          dbTime(r.end),
          r.start.slice(0, 10),
          JSON.stringify(raw),
          clip(src.from, 320),
          src.subject,
          clip(src.filename, 1024),
          dbTime(src.receivedAt),
        ],
      );
      // On a duplicate no row is inserted and insertId is 0 (affectedRows is not reliable here).
      if (!res.insertId) return false;
      const reportRef = Number(res.insertId);
      for (const p of r.policies) {
        const pr = await conn.query(
          `INSERT INTO policies (report_ref, policy_type, policy_domain, policy_string, mx_hosts, sts_mode, success_count, failure_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            reportRef,
            clip(p.type, 32),
            clip(p.domain, 255),
            JSON.stringify(p.policyString),
            JSON.stringify(p.mxHosts),
            clip(p.mode, 32),
            p.successful,
            p.failed,
          ],
        );
        if (p.failures.length) {
          await conn.batch(
            `INSERT INTO failures (policy_ref, result_type, sending_mta_ip, receiving_mx_hostname, receiving_mx_helo,
                                   receiving_ip, failed_session_count, additional_information, failure_reason_code)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            p.failures.map((f) => [
              Number(pr.insertId),
              clip(f.resultType, 64),
              clip(f.sendingMtaIp, 64),
              clip(f.receivingMxHostname, 255),
              clip(f.receivingMxHelo, 255),
              clip(f.receivingIp, 64),
              f.failedSessionCount,
              f.additionalInformation,
              clip(f.failureReasonCode, 255),
            ]),
          );
        }
      }
      return true;
    });
  }

  async recordMessage(m: MessageRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO messages (mailbox, uidvalidity, uid, message_id, from_addr, subject, date, status, error, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())
       ON DUPLICATE KEY UPDATE
         message_id = VALUES(message_id), from_addr = VALUES(from_addr), subject = VALUES(subject),
         date = VALUES(date), status = VALUES(status), error = VALUES(error), processed_at = VALUES(processed_at)`,
      [m.mailbox, m.uidvalidity, m.uid, m.messageId, clip(m.from, 320), m.subject, dbTime(m.date), m.status, m.error],
    );
  }

  async messageIssues(mailbox: string, limit = 50): Promise<MessageIssue[]> {
    const rows = await this.pool.query<Row[]>(
      `SELECT uid, from_addr, subject, date, status, error FROM messages
       WHERE mailbox = ? AND uidvalidity = (SELECT v FROM meta WHERE k = CONCAT('uidvalidity:', ?))
         AND status IN ('no-report', 'error')
       ORDER BY uid DESC LIMIT ?`,
      [mailbox, mailbox, limit],
    );
    return rows.map((r) => ({
      uid: Number(r.uid),
      from: r.from_addr ?? null,
      subject: r.subject ?? null,
      date: iso(r.date),
      status: r.status,
      error: r.error ?? null,
    }));
  }

  async totals(): Promise<{ messages: number; reports: number }> {
    const [row] = await this.pool.query<Row[]>(
      'SELECT (SELECT COUNT(*) FROM messages) AS m, (SELECT COUNT(*) FROM reports) AS r',
    );
    return { messages: Number(row?.m ?? 0), reports: Number(row?.r ?? 0) };
  }

  async filterOptions(): Promise<FilterOptions> {
    const [domains, orgs, [range]] = await Promise.all([
      this.pool.query<Row[]>('SELECT DISTINCT policy_domain AS d FROM policies ORDER BY 1'),
      this.pool.query<Row[]>('SELECT DISTINCT org_name AS o FROM reports ORDER BY 1'),
      this.pool.query<Row[]>(
        "SELECT DATE_FORMAT(MIN(day), '%Y-%m-%d') AS a, DATE_FORMAT(MAX(day), '%Y-%m-%d') AS b FROM reports",
      ),
    ]);
    return {
      domains: domains.map((r) => r.d as string),
      orgs: orgs.map((r) => r.o as string),
      firstDay: range?.a ?? null,
      lastDay: range?.b ?? null,
    };
  }

  /**
   * Loads reports matching the filters with their policies and failure details.
   * With a domain filter, only that domain's policies are attached.
   */
  async loadReports(f: Filters & { id?: number }): Promise<ReportRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      where.push(clause);
      params.push(value);
    };
    if (f.id !== undefined) add('r.id = ?', f.id);
    if (f.from) add('r.day >= ?', f.from);
    if (f.to) add('r.day <= ?', f.to);
    if (f.org) add('r.org_name = ?', f.org);
    if (f.domain) add('p.policy_domain = ?', f.domain);
    const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = await this.pool.query<Row[]>(
      `SELECT r.id, r.org_name, r.report_id, r.contact_info, r.start_ts, r.end_ts,
              DATE_FORMAT(r.day, '%Y-%m-%d') AS day, r.received_at,
              p.id AS pid, p.policy_type, p.policy_domain, p.policy_string, p.mx_hosts, p.sts_mode,
              p.success_count, p.failure_count
       FROM reports r JOIN policies p ON p.report_ref = r.id
       ${cond}
       ORDER BY r.start_ts, r.id, p.id`,
      params,
    );

    const reports = new Map<number, ReportRow>();
    const policies = new Map<number, PolicyRow>();
    for (const row of rows) {
      const id = Number(row.id);
      let rep = reports.get(id);
      if (!rep) {
        rep = {
          id,
          org: row.org_name,
          reportId: row.report_id,
          contactInfo: row.contact_info ?? null,
          start: iso(row.start_ts)!,
          end: iso(row.end_ts)!,
          day: row.day,
          receivedAt: iso(row.received_at),
          policies: [],
        };
        reports.set(id, rep);
      }
      const pol: PolicyRow = {
        id: Number(row.pid),
        type: row.policy_type,
        domain: row.policy_domain,
        policyString: json<string[]>(row.policy_string),
        mxHosts: json<string[]>(row.mx_hosts),
        mode: row.sts_mode ?? null,
        successful: Number(row.success_count),
        failed: Number(row.failure_count),
        failures: [],
      };
      rep.policies.push(pol);
      policies.set(pol.id, pol);
    }

    if (policies.size) {
      const failures = await this.pool.query<Row[]>(
        `SELECT f.* FROM failures f
         JOIN policies p ON p.id = f.policy_ref
         JOIN reports r ON r.id = p.report_ref
         ${cond} ORDER BY f.id`,
        params,
      );
      for (const fr of failures) {
        policies.get(Number(fr.policy_ref))?.failures.push({
          resultType: fr.result_type,
          sendingMtaIp: fr.sending_mta_ip ?? null,
          receivingMxHostname: fr.receiving_mx_hostname ?? null,
          receivingMxHelo: fr.receiving_mx_helo ?? null,
          receivingIp: fr.receiving_ip ?? null,
          failedSessionCount: Number(fr.failed_session_count),
          additionalInformation: fr.additional_information ?? null,
          failureReasonCode: fr.failure_reason_code ?? null,
        });
      }
    }
    return [...reports.values()];
  }

  async reportById(id: number): Promise<ReportRow | null> {
    return (await this.loadReports({ id }))[0] ?? null;
  }

  async reportSource(
    id: number,
  ): Promise<{ raw: unknown; from: string | null; subject: string | null; filename: string | null } | null> {
    const [row] = await this.pool.query<Row[]>(
      'SELECT raw_json, src_from, src_subject, src_filename FROM reports WHERE id = ?',
      [id],
    );
    if (!row) return null;
    return {
      raw: json<unknown>(row.raw_json),
      from: row.src_from ?? null,
      subject: row.src_subject ?? null,
      filename: row.src_filename ?? null,
    };
  }

  // --- OIDC sessions ---------------------------------------------------------------

  /** Expiry is computed with the database clock, like every other session time check. */
  async createSession(tokenHash: string, s: SessionRecord, ttlSeconds: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO sessions (token_hash, sub, email, name, id_token, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP() + INTERVAL ? SECOND)`,
      [tokenHash, clip(s.sub, 255), clip(s.email, 320), clip(s.name, 255), s.idToken, ttlSeconds],
    );
  }

  async getSession(tokenHash: string): Promise<SessionRecord | null> {
    const [row] = await this.pool.query<Row[]>(
      'SELECT sub, email, name, id_token FROM sessions WHERE token_hash = ? AND expires_at > UTC_TIMESTAMP()',
      [tokenHash],
    );
    if (!row) return null;
    return { sub: row.sub, email: row.email, name: row.name, idToken: row.id_token };
  }

  async deleteSession(tokenHash: string): Promise<SessionRecord | null> {
    const [row] = await this.pool.query<Row[]>(
      'DELETE FROM sessions WHERE token_hash = ? RETURNING sub, email, name, id_token',
      [tokenHash],
    );
    if (!row) return null;
    return { sub: row.sub, email: row.email, name: row.name, idToken: row.id_token };
  }

  async createLogin(state: string, l: PendingLogin): Promise<void> {
    await this.pool.query(
      'INSERT INTO oidc_logins (state, code_verifier, nonce, return_to, created_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())',
      [state, l.codeVerifier, l.nonce, clip(l.returnTo, 2048)],
    );
  }

  /** Consumes a pending login (single use); logins expire after 10 minutes. */
  async takeLogin(state: string): Promise<PendingLogin | null> {
    const [row] = await this.pool.query<Row[]>(
      `DELETE FROM oidc_logins WHERE state = ? AND created_at > UTC_TIMESTAMP() - INTERVAL 10 MINUTE
       RETURNING code_verifier, nonce, return_to`,
      [state],
    );
    return row ? { codeVerifier: row.code_verifier, nonce: row.nonce, returnTo: row.return_to } : null;
  }

  async purgeExpiredAuth(): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE expires_at <= UTC_TIMESTAMP()');
    await this.pool.query('DELETE FROM oidc_logins WHERE created_at <= UTC_TIMESTAMP() - INTERVAL 10 MINUTE');
  }
}
