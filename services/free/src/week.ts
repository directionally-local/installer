/** Weeks run Monday 00:00 UTC to the next Monday, for allowances, spend and metrics. */

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

export function weekStart(now: number): number {
  const date = new Date(now);
  const sinceMonday = (date.getUTCDay() + 6) % 7;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - sinceMonday);
}

export function weekEnd(now: number): number {
  return weekStart(now) + WEEK_MS;
}

export function dayStart(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS;
}

export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
