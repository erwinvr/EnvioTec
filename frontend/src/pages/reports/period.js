// Report period helpers (ADR-031). Dates are calendar days (YYYY-MM-DD) in
// America/La_Paz, like the backend.

const DAY_MS = 86_400_000;
export const MAX_PERIOD_DAYS = 366;
export const DEFAULT_PERIOD_DAYS = 30;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function todayInLaPaz(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/La_Paz' }).format(now);
}

export function addDays(day, days) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function periodDays(from, to) {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1;
}

export function isValidPeriod(from, to) {
  if (!DATE.test(from ?? '') || !DATE.test(to ?? '')) return false;
  const days = periodDays(from, to);
  return Number.isInteger(days) && days >= 1 && days <= MAX_PERIOD_DAYS;
}

// The period of the URL (?desde=&hasta=) or, if missing or invalid, the
// last DEFAULT_PERIOD_DAYS days ending today.
export function periodFrom(query, now = new Date()) {
  if (isValidPeriod(query?.desde, query?.hasta)) return { from: query.desde, to: query.hasta };
  const to = todayInLaPaz(now);
  return { from: addDays(to, -(DEFAULT_PERIOD_DAYS - 1)), to };
}

export function lastDays(days, now = new Date()) {
  const to = todayInLaPaz(now);
  return { from: addDays(to, -(days - 1)), to };
}
