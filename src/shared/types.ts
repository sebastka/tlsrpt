// Types shared between the API server and the web UI.
// Keep this file free of runtime code so both sides can import it as types only.

export type PolicyType = 'sts' | 'tlsa' | 'no-policy-found' | (string & {});

export interface Filters {
  /** Inclusive start day, YYYY-MM-DD (UTC). */
  from?: string;
  /** Inclusive end day, YYYY-MM-DD (UTC). */
  to?: string;
  domain?: string;
  org?: string;
}

export interface Kpis {
  reports: number;
  reporters: number;
  domains: number;
  /** Deduplicated session count (see DECISIONS.md, "Counting sessions"). */
  sessions: number;
  successful: number;
  failed: number;
  /** 0..1, or null when there are no sessions. */
  successRate: number | null;
  lastReportEnd: string | null;
}

export interface TimeBucket {
  /** Bucket start, YYYY-MM-DD (UTC). */
  start: string;
  successful: number;
  failed: number;
  reports: number;
}

export interface OrgStat {
  org: string;
  reports: number;
  sessions: number;
  failed: number;
  lastReportEnd: string;
}

export interface PolicyStat {
  domain: string;
  type: PolicyType;
  reports: number;
  successful: number;
  failed: number;
  /** MTA-STS mode (enforce/testing/none) taken from the most recent report, sts only. */
  latestMode: string | null;
  latestMxHosts: string[];
  latestPolicyString: string[];
  lastSeen: string;
}

export interface FailureTypeStat {
  resultType: string;
  sessions: number;
  reports: number;
}

export interface FailureDetailStat {
  domain: string;
  policyType: PolicyType;
  resultType: string;
  sendingMtaIp: string | null;
  receivingMxHostname: string | null;
  receivingMxHelo: string | null;
  receivingIp: string | null;
  failureReasonCode: string | null;
  additionalInformation: string | null;
  sessions: number;
  reporters: string[];
  firstSeen: string;
  lastSeen: string;
}

export type InsightLevel = 'good' | 'info' | 'warning' | 'critical';

export interface Insight {
  level: InsightLevel;
  title: string;
  detail: string;
}

export interface Overview {
  range: { from: string | null; to: string | null };
  bucket: 'day' | 'week';
  kpis: Kpis;
  series: TimeBucket[];
  byOrg: OrgStat[];
  byPolicy: PolicyStat[];
  failureTypes: FailureTypeStat[];
  failureDetails: FailureDetailStat[];
  insights: Insight[];
}

export interface ReportSummary {
  id: number;
  org: string;
  reportId: string;
  start: string;
  end: string;
  domains: string[];
  policyTypes: string[];
  sessions: number;
  failed: number;
  receivedAt: string | null;
}

export interface FailureDetail {
  resultType: string;
  sendingMtaIp: string | null;
  receivingMxHostname: string | null;
  receivingMxHelo: string | null;
  receivingIp: string | null;
  failedSessionCount: number;
  additionalInformation: string | null;
  failureReasonCode: string | null;
}

export interface PolicyDetail {
  type: PolicyType;
  domain: string;
  policyString: string[];
  mxHosts: string[];
  mode: string | null;
  successful: number;
  failed: number;
  failures: FailureDetail[];
}

export interface ReportDetail extends ReportSummary {
  contactInfo: string | null;
  policies: PolicyDetail[];
  source: { from: string | null; subject: string | null; filename: string | null };
  raw: unknown;
}

export interface FilterOptions {
  domains: string[];
  orgs: string[];
  firstDay: string | null;
  lastDay: string | null;
}

export interface SyncResult {
  messagesSeen: number;
  reportsAdded: number;
  duplicates: number;
  messagesWithoutReport: number;
  errors: number;
}

export interface MessageIssue {
  uid: number;
  from: string | null;
  subject: string | null;
  date: string | null;
  status: 'no-report' | 'error';
  error: string | null;
}

export interface SyncStatus {
  configured: boolean;
  mailbox: string;
  running: boolean;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastResult: SyncResult | null;
  nextRunAt: string | null;
  totals: { messages: number; reports: number };
  issues: MessageIssue[];
}

export interface AuthUser {
  sub: string;
  email: string | null;
  name: string | null;
}

export interface Me {
  user: AuthUser;
}
