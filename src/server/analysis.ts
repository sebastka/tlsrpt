// Aggregation of stored reports into the dashboard overview.
import type {
  FailureDetailStat,
  FailureTypeStat,
  Filters,
  Insight,
  OrgStat,
  Overview,
  PolicyStat,
  ReportSummary,
  TimeBucket,
} from '../shared/types.ts';
import type { PolicyRow, ReportRow } from './db.ts';
import { RESULT_TYPES } from '../shared/result-types.ts';

const DAY_MS = 86_400_000;
/** Ranges longer than this are bucketed per ISO week instead of per day. */
const MAX_DAILY_BUCKETS = 120;
/** A reporter that has been silent this long (while it reported before) is flagged. */
const STALE_DAYS = 7;

const toDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);

function weekStart(day: string): string {
  const ms = dayMs(day);
  const dow = (new Date(ms).getUTCDay() + 6) % 7; // Monday = 0
  return toDay(ms - dow * DAY_MS);
}

/**
 * Session totals of one report, deduplicated across policies.
 *
 * A reporter evaluating several policies for the same domain (e.g. Microsoft reports both
 * DANE/TLSA and MTA-STS) counts every session once per policy. Summing would double count,
 * so per domain we take the largest total and the largest failure count across its policies.
 */
export function reportSessions(policies: PolicyRow[]): { sessions: number; failed: number } {
  const perDomain = new Map<string, { sessions: number; failed: number }>();
  for (const p of policies) {
    const cur = perDomain.get(p.domain) ?? { sessions: 0, failed: 0 };
    cur.sessions = Math.max(cur.sessions, p.successful + p.failed);
    cur.failed = Math.max(cur.failed, p.failed);
    perDomain.set(p.domain, cur);
  }
  let sessions = 0;
  let failed = 0;
  for (const v of perDomain.values()) {
    sessions += v.sessions;
    failed += v.failed;
  }
  return { sessions, failed };
}

export function summarizeReport(r: ReportRow): ReportSummary {
  const { sessions, failed } = reportSessions(r.policies);
  return {
    id: r.id,
    org: r.org,
    reportId: r.reportId,
    start: r.start,
    end: r.end,
    domains: [...new Set(r.policies.map((p) => p.domain))],
    policyTypes: [...new Set(r.policies.map((p) => p.type))],
    sessions,
    failed,
    receivedAt: r.receivedAt,
  };
}

export function buildOverview(reports: ReportRow[], filters: Filters, now = new Date()): Overview {
  const days = reports.map((r) => r.day).sort();
  const from = filters.from ?? days[0] ?? null;
  const to = filters.to ?? days.at(-1) ?? null;
  const spanDays = from && to ? Math.round((dayMs(to) - dayMs(from)) / DAY_MS) + 1 : 0;
  const bucket: 'day' | 'week' = spanDays > MAX_DAILY_BUCKETS ? 'week' : 'day';
  const bucketOf = (day: string) => (bucket === 'week' ? weekStart(day) : day);

  // Pre-fill buckets so days without reports show as gaps on the axis.
  const series = new Map<string, TimeBucket>();
  if (from && to) {
    const step = bucket === 'week' ? 7 * DAY_MS : DAY_MS;
    for (let ms = dayMs(bucketOf(from)); ms <= dayMs(to); ms += step) {
      const d = toDay(ms);
      series.set(d, { start: d, successful: 0, failed: 0, reports: 0 });
    }
  }

  const orgs = new Map<string, OrgStat>();
  const policies = new Map<string, PolicyStat>();
  const failureTypes = new Map<string, FailureTypeStat & { reportIds: Set<number> }>();
  const details = new Map<string, FailureDetailStat & { reporterSet: Set<string> }>();
  const domains = new Set<string>();
  let sessions = 0;
  let failed = 0;
  let lastReportEnd: string | null = null;

  for (const r of reports) {
    const s = reportSessions(r.policies);
    sessions += s.sessions;
    failed += s.failed;
    if (!lastReportEnd || r.end > lastReportEnd) lastReportEnd = r.end;

    const b = bucketOf(r.day);
    const tb = series.get(b) ?? { start: b, successful: 0, failed: 0, reports: 0 };
    tb.successful += s.sessions - s.failed;
    tb.failed += s.failed;
    tb.reports += 1;
    series.set(b, tb);

    const o = orgs.get(r.org) ?? { org: r.org, reports: 0, sessions: 0, failed: 0, lastReportEnd: r.end };
    o.reports += 1;
    o.sessions += s.sessions;
    o.failed += s.failed;
    if (r.end > o.lastReportEnd) o.lastReportEnd = r.end;
    orgs.set(r.org, o);

    for (const p of r.policies) {
      domains.add(p.domain);
      const key = `${p.domain}\u0000${p.type}`;
      const ps = policies.get(key) ?? {
        domain: p.domain,
        type: p.type,
        reports: 0,
        successful: 0,
        failed: 0,
        latestMode: null,
        latestMxHosts: [],
        latestPolicyString: [],
        lastSeen: '',
      };
      ps.reports += 1;
      ps.successful += p.successful;
      ps.failed += p.failed;
      // Reports are processed oldest first, so the last one wins.
      if (r.end >= ps.lastSeen) {
        ps.lastSeen = r.end;
        ps.latestMode = p.mode;
        if (p.mxHosts.length) ps.latestMxHosts = p.mxHosts;
        ps.latestPolicyString = p.policyString;
      }
      policies.set(key, ps);

      for (const f of p.failures) {
        const ft = failureTypes.get(f.resultType) ?? {
          resultType: f.resultType,
          sessions: 0,
          reports: 0,
          reportIds: new Set<number>(),
        };
        ft.sessions += f.failedSessionCount;
        ft.reportIds.add(r.id);
        failureTypes.set(f.resultType, ft);

        const dk = [
          p.domain,
          p.type,
          f.resultType,
          f.sendingMtaIp,
          f.receivingMxHostname,
          f.receivingIp,
          f.failureReasonCode,
        ].join('\u0000');
        const d = details.get(dk) ?? {
          domain: p.domain,
          policyType: p.type,
          resultType: f.resultType,
          sendingMtaIp: f.sendingMtaIp,
          receivingMxHostname: f.receivingMxHostname,
          receivingMxHelo: f.receivingMxHelo,
          receivingIp: f.receivingIp,
          failureReasonCode: f.failureReasonCode,
          additionalInformation: f.additionalInformation,
          sessions: 0,
          reporters: [],
          reporterSet: new Set<string>(),
          firstSeen: r.start,
          lastSeen: r.end,
        };
        d.sessions += f.failedSessionCount;
        d.reporterSet.add(r.org);
        if (r.start < d.firstSeen) d.firstSeen = r.start;
        if (r.end > d.lastSeen) d.lastSeen = r.end;
        d.receivingMxHelo ??= f.receivingMxHelo;
        d.additionalInformation ??= f.additionalInformation;
        details.set(dk, d);
      }
    }
  }

  const byPolicy = [...policies.values()].sort(
    (a, b) => a.domain.localeCompare(b.domain) || a.type.localeCompare(b.type),
  );
  const byOrg = [...orgs.values()].sort((a, b) => b.sessions - a.sessions || a.org.localeCompare(b.org));

  const overview: Overview = {
    range: { from, to },
    bucket,
    kpis: {
      reports: reports.length,
      reporters: orgs.size,
      domains: domains.size,
      sessions,
      successful: sessions - failed,
      failed,
      successRate: sessions ? (sessions - failed) / sessions : null,
      lastReportEnd,
    },
    series: [...series.values()].sort((a, b) => a.start.localeCompare(b.start)),
    byOrg,
    byPolicy,
    failureTypes: [...failureTypes.values()]
      .map(({ reportIds, ...ft }) => ({ ...ft, reports: reportIds.size }))
      .sort((a, b) => b.sessions - a.sessions),
    failureDetails: [...details.values()]
      .map(({ reporterSet, ...d }) => ({ ...d, reporters: [...reporterSet].sort() }))
      .sort((a, b) => b.sessions - a.sessions || b.lastSeen.localeCompare(a.lastSeen)),
    insights: [],
  };
  overview.insights = buildInsights(overview, filters, now);
  return overview;
}

const pct = (n: number) => `${(n * 100).toFixed(n > 0.999 && n < 1 ? 2 : 1)}%`;

export function buildInsights(o: Overview, filters: Filters, now: Date): Insight[] {
  const out: Insight[] = [];
  const { kpis } = o;

  if (kpis.reports === 0) {
    out.push({
      level: 'info',
      title: 'No reports in this range',
      detail: 'Widen the date range, or check the sync status if you expected reports.',
    });
    return out;
  }

  if (kpis.failed > 0) {
    const rate = kpis.failed / kpis.sessions;
    const top = o.failureTypes[0];
    out.push({
      level: rate >= 0.05 ? 'critical' : 'warning',
      title: `${kpis.failed.toLocaleString('en')} failed TLS session${kpis.failed === 1 ? '' : 's'} (${pct(rate)})`,
      detail: top
        ? `Most common result: ${top.resultType}. ${RESULT_TYPES[top.resultType] ?? ''}`.trim()
        : 'Reporters did not include failure details.',
    });
  } else {
    out.push({
      level: 'good',
      title: 'No TLS failures reported',
      detail: `All ${kpis.sessions.toLocaleString('en')} sessions reported by ${kpis.reporters} reporter${
        kpis.reporters === 1 ? '' : 's'
      } negotiated TLS successfully.`,
    });
  }

  for (const p of o.byPolicy) {
    if (p.type === 'sts' && p.latestMode === 'testing') {
      out.push({
        level: p.failed === 0 ? 'info' : 'warning',
        title: `MTA-STS for ${p.domain} is in testing mode`,
        detail:
          p.failed === 0
            ? `No MTA-STS failures in ${p.reports} report${p.reports === 1 ? '' : 's'}. Consider switching the policy to "mode: enforce" once you have enough history.`
            : 'Senders will still deliver without TLS when validation fails. Fix the failures before switching to "mode: enforce".',
      });
    } else if (p.type === 'sts' && p.latestMode === 'none') {
      out.push({
        level: 'warning',
        title: `MTA-STS for ${p.domain} is set to mode "none"`,
        detail: 'The policy is being withdrawn; senders do not apply it.',
      });
    } else if (p.type === 'no-policy-found') {
      out.push({
        level: 'info',
        title: `Reporters found no policy for ${p.domain}`,
        detail: 'Neither MTA-STS nor DANE was found when delivering to this domain, so TLS is opportunistic only.',
      });
    }
  }

  // Staleness only makes sense when the range reaches (close to) today.
  const today = now.toISOString().slice(0, 10);
  if (!filters.to || filters.to >= today) {
    for (const org of o.byOrg) {
      const silentDays = Math.floor((now.getTime() - Date.parse(org.lastReportEnd)) / DAY_MS);
      if (silentDays >= STALE_DAYS) {
        out.push({
          level: 'info',
          title: `No report from ${org.org} for ${silentDays} days`,
          detail: 'Reporters only send a report on days they delivered mail to you, so this can be normal.',
        });
      }
    }
  }

  return out;
}
