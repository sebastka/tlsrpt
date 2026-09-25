import { useState, type ReactNode } from 'react';
import type { InsightLevel } from '../../shared/types.ts';

const STATUS: Record<InsightLevel, { color: string; label: string }> = {
  good: { color: 'var(--status-good)', label: 'OK' },
  info: { color: 'var(--status-info)', label: 'Info' },
  warning: { color: 'var(--status-warning)', label: 'Warning' },
  critical: { color: 'var(--status-critical)', label: 'Critical' },
};

export function StatusIcon({ level, size = 16 }: { level: InsightLevel; size?: number }) {
  const c = STATUS[level].color;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      {level === 'good' && (
        <>
          <circle cx="8" cy="8" r="7" fill={c} />
          <path
            d="M4.8 8.2l2.1 2.1 4.3-4.5"
            fill="none"
            stroke="#fff"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
      {level === 'info' && (
        <>
          <circle cx="8" cy="8" r="7" fill={c} />
          <path d="M8 7.2v4.2" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="8" cy="4.7" r="1.1" fill="#fff" />
        </>
      )}
      {level === 'warning' && (
        <>
          <path d="M8 1.3l7 12.6H1z" fill={c} strokeLinejoin="round" />
          <path d="M8 6v3.6" stroke="#0b0b0b" strokeWidth="1.7" strokeLinecap="round" />
          <circle cx="8" cy="11.8" r="1" fill="#0b0b0b" />
        </>
      )}
      {level === 'critical' && (
        <>
          <circle cx="8" cy="8" r="7" fill={c} />
          <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

export function StatusLabel({ level }: { level: InsightLevel }) {
  return <span className="badge">{STATUS[level].label}</span>;
}

export function Card({
  title,
  desc,
  actions,
  children,
  className,
}: {
  title: string;
  desc?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className ?? ''}`}>
      <div className="card-head">
        <div>
          <h2>{title}</h2>
          {desc && <p className="desc">{desc}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** A chart card with a chart/table toggle, so no value is only reachable by hovering. */
export function ChartCard({
  title,
  desc,
  chart,
  table,
}: {
  title: string;
  desc?: ReactNode;
  chart: ReactNode;
  table: ReactNode;
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  return (
    <Card
      title={title}
      desc={desc}
      actions={
        <div className="segmented" role="group" aria-label="View">
          <button type="button" aria-pressed={view === 'chart'} onClick={() => setView('chart')}>
            Chart
          </button>
          <button type="button" aria-pressed={view === 'table'} onClick={() => setView('table')}>
            Table
          </button>
        </div>
      }
    >
      {view === 'chart' ? chart : <div className="table-wrap">{table}</div>}
    </Card>
  );
}

export function FailCount({ n }: { n: number }) {
  if (n === 0) return <span className="muted">0</span>;
  return (
    <span className="fail-count">
      <StatusIcon level="critical" size={12} />
      {n.toLocaleString('en')}
    </span>
  );
}
