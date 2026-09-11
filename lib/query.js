// The query parameters every page and endpoint reads, parsed in one place so the HTML pages and
// the JSON API can never disagree about what `?days=400` means.
//
// The contract throughout: a value the developer typed by hand is expected to sometimes be
// wrong, so a bad one falls back to the default and returns a sentence saying so, instead of
// failing the request. Imports nothing — it is handed the choices it has to validate against.
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 1000;
export const DEFAULT_DAYS = 30;
export const SORT_CHOICES = ['time', 'tokens', 'cost'];
export const DEFAULT_SORT = 'time';
const MAX_TAG = 32;

export function parseLimit(rawLimit) {
  if (rawLimit === undefined) return { limit: DEFAULT_LIMIT, invalidLimitNote: null };
  const n = Number(rawLimit);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIMIT) {
    return {
      limit: DEFAULT_LIMIT,
      invalidLimitNote: `Invalid ?limit=${rawLimit}, showing the default ${DEFAULT_LIMIT} instead.`,
    };
  }
  return { limit: n, invalidLimitNote: null };
}

// The offered periods differ per page (the overview adds a year to the dashboard's three), so
// they are a parameter; the fallback and the wording are not.
export function parseDaysFrom(raw, choices, fallback = DEFAULT_DAYS) {
  if (raw === undefined) return { days: fallback, invalidDaysNote: null };
  const n = Number(raw);
  if (!choices.includes(n)) {
    return {
      days: fallback,
      invalidDaysNote: `Invalid ?days=${raw}, showing ${fallback} days instead.`,
    };
  }
  return { days: n, invalidDaysNote: null };
}

export function parseSort(raw) {
  if (raw === undefined) return { sort: DEFAULT_SORT, invalidSortNote: null };
  if (SORT_CHOICES.includes(raw)) return { sort: raw, invalidSortNote: null };
  return { sort: DEFAULT_SORT, invalidSortNote: `Invalid ?sort=${raw}, sorting by time instead.` };
}

// Free-text filters typed by the developer: trimmed, capped, and only ever used for matching.
export function parseText(raw, max) {
  return typeof raw === 'string' ? raw.trim().slice(0, max) : '';
}

export function parseTag(raw) {
  return parseText(raw, MAX_TAG);
}

// A flag in a URL: present and not an explicit "off" means on, so `?starred=1`, `?starred=true`
// and a bare `?starred` all read the same, while `?starred=0` reads as off.
export function parseFlag(raw) {
  if (raw === undefined) return false;
  return raw !== '0' && raw !== 'false';
}
