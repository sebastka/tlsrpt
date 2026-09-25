import type { Filters, FilterOptions, Me, Overview, ReportDetail, ReportSummary, SyncStatus } from '../shared/types.ts';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (res.status === 401) {
    // Session expired or missing: go through the OIDC login and come back here.
    location.href = `/auth/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`;
    throw new Error('authentication required');
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      // not JSON
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export function query(f: Filters): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const api = {
  me: () => request<Me>('/api/me'),
  filters: () => request<FilterOptions>('/api/filters'),
  overview: (f: Filters) => request<Overview>(`/api/overview${query(f)}`),
  reports: (f: Filters) => request<ReportSummary[]>(`/api/reports${query(f)}`),
  report: (id: number) => request<ReportDetail>(`/api/reports/${id}`),
  syncStatus: () => request<SyncStatus>('/api/sync'),
  sync: () => request<SyncStatus>('/api/sync', { method: 'POST' }),
};
