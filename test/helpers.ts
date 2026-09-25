import { readFileSync } from 'node:fs';
import type { ReportRow } from '../src/server/db.ts';
import { normalizeReport } from '../src/server/tlsrpt.ts';

export const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8'));

/** Builds the rows Store.loadReports would return, without a database. */
export function rows(...names: string[]): ReportRow[] {
  let pid = 0;
  return names
    .map((name, i) => {
      const r = normalizeReport(fixture(name));
      return {
        id: i + 1,
        org: r.organizationName,
        reportId: r.reportId,
        contactInfo: r.contactInfo,
        start: r.start,
        end: r.end,
        day: r.start.slice(0, 10),
        receivedAt: null,
        policies: r.policies.map((p) => ({ ...p, id: ++pid })),
      };
    })
    .sort((a, b) => a.start.localeCompare(b.start));
}
