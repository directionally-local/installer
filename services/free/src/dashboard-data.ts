import { DAY_MS, weekStart } from "./week.js";

/**
 * The admin dashboard's numbers (GET /admin), computed from the `daily_activity` roll-up the
 * Directory keeps next to its per-request log: one row per person per UTC day with request
 * and event counts, charged tokens and cost. Nothing else is read here: no model, status,
 * event type, event properties or session ids, and never any content. A test runs these
 * queries under an SQLite authorizer that allows only the columns listed in
 * `DASHBOARD_COLUMNS`.
 *
 * Admins are left out of every number: anyone in ADMIN_GITHUB_IDS (passed in) and anyone
 * admitted as an admin. Their requests aren't rolled up in the first place.
 *
 * Days are whole UTC days (`at / 86400000`); weeks run Monday to Sunday, UTC, keyed by the
 * day number of their Monday (1970-01-01 was a Thursday, so Monday is `day - (day + 3) % 7`).
 */

/** Tables and columns the dashboard may read. Everything is counts, tokens, cost, time or who. */
export const DASHBOARD_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  daily_activity: ["day", "github_id", "requests", "events", "charged_tokens", "cost_usd"],
  people: ["github_id", "login", "admitted_at", "admitted_via"],
  grants: ["github_id", "weekly_tokens", "weekly_usd"],
  spend_weeks: ["week_start", "usd", "tokens", "requests", "admin_usd", "admin_tokens", "admin_requests"],
  settings: ["key", "value"],
};

/** Weeks of weekly actives and cost on the page. */
export const WEEKS_SHOWN = 8;
/** Sign-up weeks in the retention table: enough for the oldest to have a week 4. */
export const COHORT_WEEKS = 12;
/** Retention is shown for these weeks after the sign-up week (week 0). */
export const RETENTION_OFFSETS = [1, 2, 4] as const;
/** Days of activity in one week that make someone a regular. */
export const REGULAR_DAYS = 3;
/**
 * A person has reached the token allowance once their charged tokens are within 1% of it. A
 * request reserves its whole prompt estimate plus room for an answer, so the last few hundred
 * thousand tokens of an allowance usually can't be spent: someone at 99.5% is refused just
 * like someone at 100%. The USD allowance is exact: it refuses once spend reaches it.
 */
export const TOKEN_LIMIT_SHARE = 0.99;

export interface DashboardLimits {
  weeklyTokens: number;
  /** null: no per-person spend cap. */
  weeklyUsd: number | null;
}

export interface WeekActive {
  weekStart: number;
  /** Active on 3 or more separate days. */
  regular: number;
  /** Active on any day. */
  active: number;
}

export interface Cohort {
  weekStart: number;
  size: number;
  /** One entry per RETENTION_OFFSETS; null when that week hasn't finished yet. */
  retained: Array<{ offset: number; active: number; share: number } | null>;
}

export interface WeekCost {
  weekStart: number;
  /** People with at least one request that week. */
  people: number;
  requests: number;
  tokens: number;
  costUsd: number;
  medianUsd: number | null;
  meanUsd: number | null;
}

export interface TopSpender {
  githubId: number;
  login: string | null;
  requests: number;
  tokens: number;
  costUsd: number;
  activeDays: number;
}

export interface LimitHit {
  weekStart: number;
  githubId: number;
  login: string | null;
  /** The UTC day (Unix ms) the allowance was first reached, whichever came first. */
  day: number;
  /** Which allowance was reached that day; both when it was the same day. */
  reached: "tokens" | "usd" | "both";
  tokenDay: number | null;
  usdDay: number | null;
  tokens: number;
  costUsd: number;
  tokenLimit: number;
  usdLimit: number | null;
}

export interface DashboardData {
  now: number;
  currentWeek: number;
  weeklyActive: WeekActive[];
  cohorts: Cohort[];
  weeklyCost: WeekCost[];
  topWeek: number;
  top: TopSpender[];
  limitHits: LimitHit[];
  people: { admitted: number; activeThisWeek: number };
}

/** The slice of `ctx.storage.sql` the queries need. */
export interface Sql {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): { toArray(): T[] };
}

const WEEK_OF_DAY = "(day - ((day + 3) % 7))";

/** Leaves out admins: by id (ADMIN_GITHUB_IDS, bound as a JSON array) and by how they were admitted. */
function notAdmin(column: string): string {
  return `${column} NOT IN (SELECT github_id FROM people WHERE admitted_via = 'admin') AND ${column} NOT IN (SELECT value FROM json_each(?))`;
}

export function dashboardData(
  sql: Sql,
  input: { now: number; adminIds: readonly number[]; limits: DashboardLimits; topWeek?: number },
): DashboardData {
  const admins = JSON.stringify([...input.adminIds]);
  const currentWeek = weekStart(input.now);
  const currentWeekDay = currentWeek / DAY_MS;
  const firstWeekDay = currentWeekDay - 7 * (WEEKS_SHOWN - 1);
  const firstCohortDay = currentWeekDay - 7 * (COHORT_WEEKS - 1);
  const toMs = (day: number) => day * DAY_MS;

  // One pass over the window: per person per week, days active, requests, tokens and cost.
  // The weekly actives, retention and cost tables are all computed from it.
  const personWeeks = sql
    .exec<{ github_id: number; week: number; days: number; requests: number; tokens: number; cost: number }>(
      `SELECT github_id, ${WEEK_OF_DAY} AS week, COUNT(*) AS days, SUM(requests) AS requests,
              SUM(charged_tokens) AS tokens, SUM(cost_usd) AS cost
       FROM daily_activity WHERE day >= ? AND ${notAdmin("github_id")}
       GROUP BY github_id, week`,
      firstCohortDay,
      admins,
    )
    .toArray();

  const weeklyActive: WeekActive[] = [];
  const weeklyCost: WeekCost[] = [];
  const shown = new Map<number, { regular: number; active: number; costs: number[]; requests: number; tokens: number; cost: number }>();
  for (let week = firstWeekDay; week <= currentWeekDay; week += 7) shown.set(week, { regular: 0, active: 0, costs: [], requests: 0, tokens: 0, cost: 0 });
  const activeWeeks = new Map<number, Set<number>>();
  for (const row of personWeeks) {
    let weeks = activeWeeks.get(row.github_id);
    if (!weeks) activeWeeks.set(row.github_id, (weeks = new Set()));
    weeks.add(row.week);
    const week = shown.get(row.week);
    if (!week) continue;
    week.active++;
    if (row.days >= REGULAR_DAYS) week.regular++;
    if (row.requests > 0) {
      week.costs.push(row.cost);
      week.requests += row.requests;
      week.tokens += row.tokens;
      week.cost += row.cost;
    }
  }
  for (const [week, totals] of shown) {
    weeklyActive.push({ weekStart: toMs(week), regular: totals.regular, active: totals.active });
    const people = totals.costs.length;
    weeklyCost.push({
      weekStart: toMs(week),
      people,
      requests: totals.requests,
      tokens: totals.tokens,
      costUsd: totals.cost,
      medianUsd: median(totals.costs),
      meanUsd: people > 0 ? totals.cost / people : null,
    });
  }

  // Retention: people by sign-up week; who was active in weeks 1, 2 and 4 after it.
  const members = sql
    .exec<{ github_id: number; admitted_at: number }>(`SELECT github_id, admitted_at FROM people WHERE admitted_at >= ? AND ${notAdmin("github_id")}`, toMs(firstCohortDay), admins)
    .toArray();
  const cohortMembers = new Map<number, number[]>();
  for (const member of members) {
    const week = weekStart(member.admitted_at) / DAY_MS;
    let list = cohortMembers.get(week);
    if (!list) cohortMembers.set(week, (list = []));
    list.push(member.github_id);
  }
  const cohorts: Cohort[] = [...cohortMembers.entries()]
    .sort(([a], [b]) => b - a)
    .map(([week, ids]) => ({
      weekStart: toMs(week),
      size: ids.length,
      retained: RETENTION_OFFSETS.map((offset) => {
        // Only weeks that have ended: a week still running would understate retention.
        const target = week + 7 * offset;
        if (target >= currentWeekDay) return null;
        const active = ids.filter((id) => activeWeeks.get(id)?.has(target)).length;
        return { offset, active, share: active / ids.length };
      }),
    }));

  // The ten people who cost the most in one week (this week unless another is picked).
  const topWeekDay = input.topWeek !== undefined && input.topWeek >= toMs(firstWeekDay) && input.topWeek <= currentWeek ? weekStart(input.topWeek) / DAY_MS : currentWeekDay;
  const top: TopSpender[] = sql
    .exec<{ github_id: number; login: string | null; requests: number; tokens: number; cost: number; days: number }>(
      `SELECT d.github_id AS github_id, p.login AS login, SUM(d.requests) AS requests, SUM(d.charged_tokens) AS tokens,
              SUM(d.cost_usd) AS cost, COUNT(*) AS days
       FROM daily_activity d LEFT JOIN people p ON p.github_id = d.github_id
       WHERE d.day >= ? AND d.day < ? AND d.requests > 0 AND ${notAdmin("d.github_id")}
       GROUP BY d.github_id ORDER BY cost DESC, d.github_id LIMIT 10`,
      topWeekDay,
      topWeekDay + 7,
      admins,
    )
    .toArray()
    .map((row) => ({ githubId: row.github_id, login: row.login, requests: row.requests, tokens: row.tokens, costUsd: row.cost, activeDays: row.days }));

  // Who reached their allowance this week or last, and on which day: running totals per week.
  const limitRows = sql
    .exec<{
      week: number;
      github_id: number;
      login: string | null;
      token_day: number | null;
      usd_day: number | null;
      tokens: number;
      cost: number;
      token_limit: number;
      usd_limit: number | null;
    }>(
      `WITH running AS (
         SELECT github_id, day, ${WEEK_OF_DAY} AS week,
                SUM(charged_tokens) OVER (PARTITION BY github_id, ${WEEK_OF_DAY} ORDER BY day) AS tokens,
                SUM(cost_usd) OVER (PARTITION BY github_id, ${WEEK_OF_DAY} ORDER BY day) AS cost
         FROM daily_activity WHERE day >= ? AND requests > 0 AND ${notAdmin("github_id")}),
       limited AS (
         SELECT r.github_id AS github_id, r.day AS day, r.week AS week, r.tokens AS tokens, r.cost AS cost,
                COALESCE(g.weekly_tokens, ?) AS token_limit, COALESCE(g.weekly_usd, ?) AS usd_limit
         FROM running r LEFT JOIN grants g ON g.github_id = r.github_id)
       SELECT l.week AS week, l.github_id AS github_id, p.login AS login,
              MIN(CASE WHEN l.tokens >= l.token_limit * ${TOKEN_LIMIT_SHARE} THEN l.day END) AS token_day,
              MIN(CASE WHEN l.cost >= l.usd_limit THEN l.day END) AS usd_day,
              MAX(l.tokens) AS tokens, MAX(l.cost) AS cost, MAX(l.token_limit) AS token_limit, MAX(l.usd_limit) AS usd_limit
       FROM limited l LEFT JOIN people p ON p.github_id = l.github_id
       GROUP BY l.week, l.github_id
       HAVING token_day IS NOT NULL OR usd_day IS NOT NULL`,
      currentWeekDay - 7,
      admins,
      input.limits.weeklyTokens,
      input.limits.weeklyUsd,
    )
    .toArray();
  const limitHits: LimitHit[] = limitRows
    .map((row) => {
      const day = Math.min(row.token_day ?? Infinity, row.usd_day ?? Infinity);
      const reached: LimitHit["reached"] = row.token_day === day && row.usd_day === day ? "both" : row.token_day === day ? "tokens" : "usd";
      return {
        weekStart: toMs(row.week),
        githubId: row.github_id,
        login: row.login,
        day: toMs(day),
        reached,
        tokenDay: row.token_day === null ? null : toMs(row.token_day),
        usdDay: row.usd_day === null ? null : toMs(row.usd_day),
        tokens: row.tokens,
        costUsd: row.cost,
        tokenLimit: row.token_limit,
        usdLimit: row.usd_limit,
      };
    })
    .sort((a, b) => b.weekStart - a.weekStart || a.day - b.day || a.githubId - b.githubId);

  const admitted =
    sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM people WHERE ${notAdmin("github_id")}`, admins).toArray()[0]?.n ?? 0;

  return {
    now: input.now,
    currentWeek,
    weeklyActive,
    cohorts,
    weeklyCost,
    topWeek: toMs(topWeekDay),
    top,
    limitHits,
    people: { admitted, activeThisWeek: weeklyActive[weeklyActive.length - 1]?.active ?? 0 },
  };
}

/** The median of a list (sorted here); null when it's empty. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
