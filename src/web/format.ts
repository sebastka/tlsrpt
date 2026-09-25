export const num = (n: number) => n.toLocaleString('en');

export function compact(n: number): string {
  if (n < 10_000) return num(n);
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function percent(r: number | null): string {
  if (r === null) return '–';
  const p = r * 100;
  // Keep 99.97% from rounding up to a misleading 100.0%.
  if (p > 99.9 && p < 100) return `${p.toFixed(2)}%`;
  return `${p.toFixed(1)}%`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Sep 3" for a YYYY-MM-DD or ISO string (UTC). */
export function shortDay(s: string): string {
  const d = new Date(s.length === 10 ? `${s}T00:00:00Z` : s);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** "2026-09-03" for an ISO string (UTC). */
export const day = (s: string) => s.slice(0, 10);

export function dateTime(s: string | null): string {
  if (!s) return '–';
  const d = new Date(s);
  return d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

export function ago(s: string | null, now = Date.now()): string {
  if (!s) return 'never';
  const sec = Math.round((now - Date.parse(s)) / 1000);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function todayUtc(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}
