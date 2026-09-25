import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Filters, SyncStatus } from '../shared/types.ts';
import { RESULT_TYPES } from '../shared/result-types.ts';
import { api } from './api.ts';
import { BarList } from './components/BarList.tsx';
import { ReportDrawer } from './components/ReportDrawer.tsx';
import { SessionsChart } from './components/SessionsChart.tsx';
import { FailureTable, OrgTable, PolicyTable, ReportTable, SeriesTable } from './components/Tables.tsx';
import { Card, ChartCard, StatusIcon, StatusLabel } from './components/ui.tsx';
import { ago, compact, dateTime, num, percent, shortDay, todayUtc } from './format.ts';
import { useAsync } from './hooks.ts';

const PRESETS = [
  { key: '7d', label: '7 days', days: 7 },
  { key: '30d', label: '30 days', days: 30 },
  { key: '90d', label: '90 days', days: 90 },
  { key: '1y', label: '1 year', days: 365 },
  { key: 'all', label: 'All', days: 0 },
] as const;
type PresetKey = (typeof PRESETS)[number]['key'] | 'custom';

interface UiState {
  preset: PresetKey;
  from: string;
  to: string;
  domain: string;
  org: string;
}

function readUrl(): UiState {
  const p = new URLSearchParams(location.search);
  const preset = (p.get('range') as PresetKey) ?? '90d';
  return {
    preset: [...PRESETS.map((x) => x.key), 'custom'].includes(preset) ? preset : '90d',
    from: p.get('from') ?? todayUtc(-29),
    to: p.get('to') ?? todayUtc(),
    domain: p.get('domain') ?? '',
    org: p.get('org') ?? '',
  };
}

function writeUrl(s: UiState) {
  const p = new URLSearchParams();
  if (s.preset !== '90d') p.set('range', s.preset);
  if (s.preset === 'custom') {
    p.set('from', s.from);
    p.set('to', s.to);
  }
  if (s.domain) p.set('domain', s.domain);
  if (s.org) p.set('org', s.org);
  const q = p.toString();
  history.replaceState(null, '', q ? `?${q}` : location.pathname);
}

function toFilters(s: UiState): Filters {
  const f: Filters = {};
  if (s.preset === 'custom') {
    f.from = s.from;
    f.to = s.to;
  } else {
    const preset = PRESETS.find((p) => p.key === s.preset)!;
    if (preset.days) {
      f.from = todayUtc(-(preset.days - 1));
      f.to = todayUtc();
    }
  }
  if (s.domain) f.domain = s.domain;
  if (s.org) f.org = s.org;
  return f;
}

function useSync(onFinished: () => void) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const wasRunning = useRef(false);
  const running = status?.running ?? false;

  // Poll quickly while a sync runs, slowly otherwise; refetch data when a run finishes.
  useEffect(() => {
    let active = true;
    const poll = () =>
      api.syncStatus().then(
        (s) => {
          if (!active) return;
          setStatus(s);
          if (wasRunning.current && !s.running) onFinished();
          wasRunning.current = s.running;
        },
        () => {}, // keep the last known status
      );
    void poll();
    const t = setInterval(poll, running ? 1500 : 30_000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [onFinished, running]);

  const trigger = async () => {
    const s = await api.sync();
    wasRunning.current = true;
    setStatus(s);
  };
  return { status, trigger };
}

function UserMenu() {
  const { data } = useAsync(() => api.me(), []);
  if (!data) return null;
  const u = data.user;
  return (
    <form method="post" action="/auth/logout" className="user-menu">
      <span className="user-name" title={u.email ?? u.sub}>
        {u.name ?? u.email ?? u.sub}
      </span>
      <button type="submit" className="btn">
        Log out
      </button>
    </form>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<string>(() => document.documentElement.getAttribute('data-theme') ?? 'auto');
  const set = (t: string) => {
    setTheme(t);
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    try {
      localStorage.setItem('theme', t);
    } catch {
      // storage unavailable
    }
  };
  return (
    <div className="segmented" role="group" aria-label="Theme">
      {['auto', 'light', 'dark'].map((t) => (
        <button key={t} type="button" aria-pressed={theme === t} onClick={() => set(t)}>
          {t[0]!.toUpperCase() + t.slice(1)}
        </button>
      ))}
    </div>
  );
}

export function App() {
  const [ui, setUi] = useState<UiState>(readUrl);
  const [version, setVersion] = useState(0);
  const [openReport, setOpenReport] = useState<number | null>(null);
  const filters = useMemo(() => toFilters(ui), [ui]);
  const key = JSON.stringify(filters);

  useEffect(() => writeUrl(ui), [ui]);

  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const { status, trigger } = useSync(bump);
  const options = useAsync(() => api.filters(), [version]);
  const overview = useAsync(() => api.overview(filters), [key, version]);
  const reports = useAsync(() => api.reports(filters), [key, version]);

  const o = overview.data;
  const update = (patch: Partial<UiState>) => setUi((s) => ({ ...s, ...patch }));

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>SMTP TLS Reports</h1>
          <div className="sub">
            RFC 8460 reports from <b>{status?.mailbox ?? '…'}</b>
            {options.data?.firstDay && (
              <>
                {' '}
                · data from {options.data.firstDay} to {options.data.lastDay}
              </>
            )}
          </div>
        </div>
        <div className="header-actions">
          <span className="sync-state" aria-live="polite">
            {status?.running ? (
              <>
                <span className="spin" /> Syncing…
              </>
            ) : status?.lastError ? (
              <>
                <StatusIcon level="critical" size={12} /> Sync failed {ago(status.lastRunAt)}
              </>
            ) : (
              <>Synced {ago(status?.lastSuccessAt ?? null)}</>
            )}
          </span>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void trigger()}
            disabled={!status?.configured || status.running}
          >
            Sync now
          </button>
          <ThemeToggle />
          <UserMenu />
        </div>
      </header>

      {status && !status.configured && (
        <div className="error-banner">
          <StatusIcon level="warning" />
          <div>
            <b>IMAP is not configured.</b> Set IMAP_HOST, IMAP_USERNAME and IMAP_PASSWORD (see .env.example).
          </div>
        </div>
      )}
      {status?.lastError && !status.running && (
        <div className="error-banner">
          <StatusIcon level="critical" />
          <div>
            <b>Last sync failed:</b> {status.lastError}
          </div>
        </div>
      )}

      <div className="filters" role="search">
        <div className="segmented" role="group" aria-label="Date range">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              aria-pressed={ui.preset === p.key}
              onClick={() => update({ preset: p.key })}
            >
              {p.label}
            </button>
          ))}
          <button type="button" aria-pressed={ui.preset === 'custom'} onClick={() => update({ preset: 'custom' })}>
            Custom
          </button>
        </div>
        {ui.preset === 'custom' && (
          <>
            <label className="field">
              From
              <input
                type="date"
                value={ui.from}
                max={ui.to}
                onChange={(e) => e.target.value && update({ from: e.target.value })}
              />
            </label>
            <label className="field">
              To
              <input
                type="date"
                value={ui.to}
                min={ui.from}
                onChange={(e) => e.target.value && update({ to: e.target.value })}
              />
            </label>
          </>
        )}
        <label className="field">
          Domain
          <select value={ui.domain} onChange={(e) => update({ domain: e.target.value })}>
            <option value="">All domains</option>
            {options.data?.domains.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Reporter
          <select value={ui.org} onChange={(e) => update({ org: e.target.value })}>
            <option value="">All reporters</option>
            {options.data?.orgs.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
      </div>

      {overview.error && (
        <div className="error-banner">
          <StatusIcon level="critical" />
          <div>Could not load the overview: {overview.error}</div>
        </div>
      )}

      {o && (
        <div style={{ opacity: overview.loading ? 0.55 : 1, transition: 'opacity .15s' }}>
          <div className="grid kpis">
            <div className="card stat hero">
              <div className="label">TLS success rate</div>
              <div className="value">{percent(o.kpis.successRate)}</div>
              {o.kpis.sessions > 0 && (
                <div className="meter" aria-hidden="true">
                  <span
                    style={{ width: `${(o.kpis.successful / o.kpis.sessions) * 100}%`, background: 'var(--series-1)' }}
                  />
                  {o.kpis.failed > 0 && (
                    <span
                      style={{ width: `${(o.kpis.failed / o.kpis.sessions) * 100}%`, background: 'var(--series-2)' }}
                    />
                  )}
                </div>
              )}
              <div className="foot">
                {o.range.from ? `${shortDay(o.range.from)} – ${shortDay(o.range.to!)}` : 'No data'}
              </div>
            </div>
            <div className="card stat">
              <div className="label">Sessions</div>
              <div className="value">{compact(o.kpis.sessions)}</div>
              <div className="foot">{num(o.kpis.successful)} successful</div>
            </div>
            <div className="card stat">
              <div className="label">Failed sessions</div>
              <div className="value">{compact(o.kpis.failed)}</div>
              <div className="foot">
                {o.failureTypes.length} failure type{o.failureTypes.length === 1 ? '' : 's'}
              </div>
            </div>
            <div className="card stat">
              <div className="label">Reports</div>
              <div className="value">{compact(o.kpis.reports)}</div>
              <div className="foot">
                from {o.kpis.reporters} reporter{o.kpis.reporters === 1 ? '' : 's'}
              </div>
            </div>
            <div className="card stat">
              <div className="label">Latest report</div>
              <div className="value">{o.kpis.lastReportEnd ? shortDay(o.kpis.lastReportEnd) : '–'}</div>
              <div className="foot">
                {o.kpis.domains} domain{o.kpis.domains === 1 ? '' : 's'} covered
              </div>
            </div>
          </div>

          <div className="insights" aria-label="Findings">
            {o.insights.map((i, n) => (
              <div className="insight" key={n}>
                <StatusIcon level={i.level} />
                <div>
                  <div className="t">
                    {i.title}
                    <StatusLabel level={i.level} />
                  </div>
                  <div className="d">{i.detail}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="grid two">
            <ChartCard
              title={`Sessions per ${o.bucket}`}
              desc="Deduplicated across policies, by report start date (UTC)"
              chart={<SessionsChart data={o.series} bucket={o.bucket} />}
              table={<SeriesTable data={o.series} bucket={o.bucket} />}
            />
            <ChartCard
              title="Failures by result type"
              desc="Failed sessions, as reported in failure details"
              chart={
                o.failureTypes.length ? (
                  <BarList
                    unit="sessions"
                    items={o.failureTypes.map((f) => ({
                      key: f.resultType,
                      label: f.resultType,
                      value: f.sessions,
                      note: `${RESULT_TYPES[f.resultType] ?? 'Unknown result type.'} Seen in ${f.reports} report${f.reports === 1 ? '' : 's'}.`,
                    }))}
                  />
                ) : (
                  <div className="empty">No failures reported in this range.</div>
                )
              }
              table={
                <table>
                  <thead>
                    <tr>
                      <th>Result type</th>
                      <th className="num">Sessions</th>
                      <th className="num">Reports</th>
                    </tr>
                  </thead>
                  <tbody>
                    {o.failureTypes.map((f) => (
                      <tr key={f.resultType}>
                        <td title={RESULT_TYPES[f.resultType]}>{f.resultType}</td>
                        <td className="num">{num(f.sessions)}</td>
                        <td className="num">{num(f.reports)}</td>
                      </tr>
                    ))}
                    {o.failureTypes.length === 0 && (
                      <tr>
                        <td colSpan={3} className="empty">
                          No failures reported in this range.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              }
            />
          </div>

          <div className="grid two section">
            <Card
              title="Policies"
              desc="Policies reporters applied, per domain. Mode and MX come from the latest report."
            >
              <div className="table-wrap">
                <PolicyTable rows={o.byPolicy} />
              </div>
            </Card>
            <Card title="Reporters" desc="Organisations that sent reports">
              <div className="table-wrap">
                <OrgTable rows={o.byOrg} />
              </div>
            </Card>
          </div>

          {o.failureDetails.length > 0 && (
            <div className="section">
              <Card
                title="Failure details"
                desc="Grouped by domain, policy, result type, receiving MX/IP and sending MTA"
              >
                <div className="table-wrap">
                  <FailureTable rows={o.failureDetails} />
                </div>
              </Card>
            </div>
          )}
        </div>
      )}

      <div className="section" style={{ opacity: reports.loading && reports.data ? 0.55 : 1 }}>
        <Card title="Reports" desc="Click a report to see its policies, failures and raw JSON">
          {reports.data && <ReportTable key={key} rows={reports.data} onOpen={setOpenReport} />}
        </Card>
      </div>

      {status && (status.issues.length > 0 || status.lastResult) && (
        <div className="section">
          <Card
            title="Mailbox sync"
            desc={
              <>
                {num(status.totals.messages)} messages processed, {num(status.totals.reports)} reports stored · last run{' '}
                {dateTime(status.lastRunAt)}
                {status.nextRunAt && <> · next run {dateTime(status.nextRunAt)}</>}
              </>
            }
          >
            {status.issues.length > 0 ? (
              <details className="issues">
                <summary>
                  {status.issues.length} message{status.issues.length === 1 ? '' : 's'} without a usable report
                </summary>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>UID</th>
                        <th>Date</th>
                        <th>From</th>
                        <th>Subject</th>
                        <th>Problem</th>
                      </tr>
                    </thead>
                    <tbody>
                      {status.issues.map((m) => (
                        <tr key={m.uid}>
                          <td className="num">{m.uid}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>{dateTime(m.date)}</td>
                          <td>{m.from ?? '–'}</td>
                          <td>{m.subject ?? '–'}</td>
                          <td>{m.status === 'no-report' ? 'No TLSRPT attachment' : m.error}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ) : (
              <div className="muted">Every message in the mailbox contained a valid report.</div>
            )}
          </Card>
        </div>
      )}

      {openReport !== null && <ReportDrawer id={openReport} onClose={() => setOpenReport(null)} />}
    </div>
  );
}
