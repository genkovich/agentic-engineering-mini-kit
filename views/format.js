// Pure value formatters shared by every page: sizes, counts, dates, durations, money.
// Hand-rolled instead of toLocaleString: fixed fields, no dependency on ICU data being
// present, so the format never varies across Node builds or CI platforms.

const UNITS = ['B', 'KB', 'MB', 'GB'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n) => String(n).padStart(2, '0');

export function humanSize(bytes) {
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const formatted = unitIndex === 0 ? String(value) : value.toFixed(1);
  return `${formatted} ${UNITS[unitIndex]}`;
}

// Token counts: 975 → "975", 3265 → "3.3K", 162900 → "163K", 2400000 → "2.4M".
export function humanCount(n) {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1000000) return `${Math.round(n / 1000)}K`;
  return `${(n / 1000000).toFixed(1)}M`;
}

export function formatMtime(mtimeMs) {
  const d = new Date(mtimeMs);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function isoMtime(mtimeMs) {
  const d = new Date(mtimeMs);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// "2026-08-20" → "20 Aug"; chart axis and legend text, no time part.
export function shortDay(dayKey) {
  const [, m, d] = dayKey.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

// Wall-clock spans, two units at most, the smaller one dropped once it stops mattering:
// under a minute "45s"; under an hour "3m 20s"; under a day "2h 05m"; beyond "1d 3h".
// Anything not a finite number, and anything negative, reads as "0s".
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600) % 24;
  const d = Math.floor(total / 86400);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// Money: below a cent the second decimal hides the whole number, so show four ("$0.0042");
// from a cent up, two ("$12.30"). Exact zero stays "$0.00". No thousands separator.
export function formatUsd(n) {
  if (!Number.isFinite(n)) return '$0.00';
  const sign = n < 0 ? '-' : '';
  const value = Math.abs(n);
  const decimals = value !== 0 && value < 0.01 ? 4 : 2;
  return `${sign}$${value.toFixed(decimals)}`;
}

// Coarse "how long ago": "just now" under a minute, then minutes, hours, "yesterday",
// days; past two weeks the exact date reads better than a count, so fall back to formatMtime.
export function relativeTime(ms, now = Date.now()) {
  const diff = now - ms;
  if (!Number.isFinite(diff) || diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} h ago`;
  const days = Math.floor(diff / 86400000);
  if (days === 1) return 'yesterday';
  if (days <= 14) return `${days} days ago`;
  return formatMtime(ms);
}
