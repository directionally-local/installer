import { DOWNLOAD_ROUTES, type DownloadRoute } from "./telemetry.js";
import { DAY_MS, weekStart } from "./week.js";

/**
 * The admin dashboard's numbers (GET /admin), computed from the `daily_activity` roll-up the
 * Directory keeps next to its per-request log: one row per person per UTC day with request
 * and event counts, charged tokens and cost. Nothing else is read here: no model, status,
 * event type, event properties or session ids, and never any content. A test runs these
 * queries under an SQLite authorizer that allows only the columns listed in
 * `DASHBOARD_COLUMNS`.
 *
 * The install funnel also reads `download_daily` and `install_daily`: anonymous per-day counts of
 * install scripts served and installs finished, which can't be joined to people (telemetry.ts).
 *
 * The upstream section reads `upstream_daily` and `upstream_timings` instead: per upstream,
 * counts, tokens, dollars and milliseconds, with no person attached (admins included there).
 *
 * Admins are left out of every number: anyone in ADMIN_GITHUB_IDS (passed in) and anyone
 * admitted as an admin. Their requests aren't rolled up in the first place.
 *
 * Days are whole UTC days (`at / 86400000`); weeks run Monday to Sunday, UTC, keyed by the
 * day number of their Monday (1970-01-01 was a Thursday, so Monday is `day - (day + 3) % 7`).
 */

/** Tables and columns the dashboard may read. Everything is counts, tokens, cost, time or who. */
export const DASHBOARD_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  daily_activity: ["day", "github_id", "requests", "events", "charged_tokens", "cost_usd", "paid_cost_usd", "credit_usd", "sessions"],
  // Levels and the GitHub signals behind them, numbers only (the Starter accounts table).
  people: [
    "github_id",
    "login",
    // Only to leave blocked accounts out of the daily cohorts.
    "status",
    "admitted_at",
    "admitted_via",
    "level",
    "level_reason",
    // Whether the person had free tokens at sign-up: retention counts only people who could use dl.
    "signup_tokens",
    "account_age_days",
    "public_repos",
    "followers",
    "contributions",
    "restricted_contributions",
    "github_created_day",
    // The creation-batch flag: a flagged Starter account has no allowance (the limits table).
    "batch_flag",
    "active_weeks",
    "outside_contributions",
    "oldest_repo_at",
    "social",
  ],
  grants: ["github_id", "weekly_tokens", "weekly_usd"],
  spend_weeks: ["week_start", "usd", "tokens", "requests", "admin_usd", "admin_tokens", "admin_requests", "paid_usd", "paid_tokens", "paid_requests", "credit_usd", "free_credit_usd", "openai_credit_usd", "openai_free_credit_usd"],
  upstream_daily: ["day", "upstream", "requests", "errors", "prompt_tokens", "cached_tokens", "cash_usd", "credit_usd"],
  upstream_timings: ["at", "upstream", "ttfb_ms", "ttft_ms"],
  settings: ["key", "value"],
  queue: ["github_id", "queued_at", "admitted_at", "admitted_how"],
  queue_runs: ["week_start", "ran_at", "admitted", "waiting_before", "avg_usd", "actives", "budget_usd"],
  referrals: ["referred_id", "referrer_id", "outcome", "at"],
  subscriptions: ["github_id", "state", "period_end", "state_at"],
  download_daily: ["day", "route", "client", "downloads"],
  install_daily: ["day", "os", "arch", "mode", "dl_version", "result", "failed_step", "via", "installs"],
  payments: ["github_id", "kind", "amount_cents", "at"],
  // Days someone was refused free tokens below the bar: the sign-up funnel. Ids and days only.
  refused_days: ["github_id", "day"],
};

/** Pro counts as subscribed this long past its period end (as in account-object.ts). */
const PRO_GRACE_MS = 3 * DAY_MS;

/** Weeks of weekly actives and cost on the page. */
export const WEEKS_SHOWN = 8;
/** Sign-up weeks in the retention table: enough for the oldest to have a week 4. */
export const COHORT_WEEKS = 12;
/** Retention is shown for these weeks after the sign-up week (week 0). */
export const RETENTION_OFFSETS = [1, 2, 4] as const;
/** Daily retention: the last this many sign-up days (UTC days with at least one sign-up). */
export const DAILY_COHORTS = 21;
/** Daily retention is shown for these days after the sign-up day (day 0). */
export const RETENTION_DAYS = [0, 1, 2, 3, 4, 5, 6, 7, 14] as const;
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
  /**
   * The smaller levels' allowances, so the limits table holds basic and Starter accounts to their
   * own (a batch-flagged Starter account has none). Without them everyone is held to Full's.
   */
  levels?: { basicTokens: number; basicUsd: number | null; starterTokens: number; starterUsd: number | null };
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

/**
 * One sign-up day's funnel: everyone admitted that UTC day (admins and blocked accounts left
 * out), how many had free tokens at sign-up (Full or basic, an admin's grant, or Starter with an
 * allowance), how many were refused (no free tokens), and how many of those still opened dl that
 * day (a dl session, or a refused chat request).
 */
export interface SignupFunnelDay {
  day: number;
  signedUp: number;
  gotTokens: number;
  refused: number;
  refusedOpened: number;
}

/** People admitted on one UTC day, and who made a request on given days after it. */
export interface DailyCohort {
  /** The sign-up day, as Unix ms (00:00 UTC). */
  day: number;
  size: number;
  /** One entry per RETENTION_DAYS; null until that day has ended (UTC). */
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

export interface QueueView {
  waiting: number;
  /** Unix ms the longest-waiting person joined the line; null when nobody waits. */
  oldestQueuedAt: number | null;
  /** This Monday's admission (this week's run), if it ran. */
  thisWeek: { admitted: number; waitingBefore: number; avgUsd: number; actives: number; budgetUsd: number | null; ranAt: number } | null;
  /** Everyone who has waited, and how many got in. */
  everQueued: number;
  admittedEver: number;
}

export interface ReferralView {
  /** Sign-ups that carried any referral code (including self, unknown and same-network ones). */
  linksUsed: number;
  /** Sign-ups that count as referrals (outcome ok). */
  signups: number;
  /** Referral sign-ups refused a payout: own code, unknown code, or the same network. */
  blocked: number;
  /** Referred people who were weekly active (3+ request days) in some week. */
  becameActive: number;
  /** Bonus tokens a week granted this week, summed over everyone, and how many people get one. */
  bonusTokensThisWeek: number;
  peopleWithBonus: number;
}

export interface PaidView {
  /** Active Pro subscriptions now. */
  proSubscribers: number;
  topupsThisWeek: number;
  topupsThisMonth: number;
  /** Revenue before tax, USD, from payments this week (Monday UTC) and this calendar month (UTC). */
  revenueWeekUsd: number;
  revenueMonthUsd: number;
  /** What paid usage (Pro and top-ups) cost upstream: logged apart from the free caps. */
  paidCostWeekUsd: number;
  paidCostMonthUsd: number;
  paidRequestsWeek: number;
}

/** One upstream over one window (today, UTC, this Monday-to-Sunday week, or the Health view's last N days). Admins included. */
export interface UpstreamStats {
  upstream: "openai" | "luminal" | "openrouter";
  window: "today" | "week" | `${number}d`;
  requests: number;
  /** Requests the upstream failed: 429, 5xx, a timeout, a network error or a failed stream. */
  errors: number;
  medianTtftMs: number | null;
  p90TtftMs: number | null;
  medianTtfbMs: number | null;
  /** Cached prompt tokens over prompt tokens; null without prompt tokens. */
  cacheHitShare: number | null;
  /** Real money (OpenRouter) and prepaid credit (Luminal). */
  cashUsd: number;
  creditUsd: number;
}

export const UPSTREAM_NAMES = ["openai", "luminal", "openrouter"] as const;

export interface FunnelRow {
  /** Monday of the sign-up week; null for the all-time row. */
  weekStart: number | null;
  signedUp: number;
  firstRequest: number;
  weeklyActive: number;
}

/** Days of the install funnel shown one by one. */
export const FUNNEL_DAYS = 14;

/**
 * One day or one week of the install funnel, from the top: scripts served (anonymous, by
 * route) → installs finished (anonymous, ok or failed) → free tier sign-ups → people whose
 * first request was in this period → active people (any request that day; for a week, requests
 * on REGULAR_DAYS or more of its days). The first two are separate counts, not the same people.
 */
export interface InstallFunnelRow {
  /** The day, or the Monday of the week, as Unix ms. */
  start: number;
  downloads: number;
  downloadsByRoute: Record<DownloadRoute, number>;
  installsOk: number;
  installsFailed: number;
  signedUp: number;
  firstRequest: number;
  active: number;
}

export interface InstallFunnel {
  /** The last FUNNEL_DAYS days and the last WEEKS_SHOWN weeks, newest first. */
  days: InstallFunnelRow[];
  weeks: InstallFunnelRow[];
  /** Over the weeks shown: finished installs by OS, chip and mode, most first. */
  platforms: Array<{ os: string; arch: string; mode: string; ok: number; failed: number }>;
  /** Over the weeks shown: the steps installs failed at, most first ("" when it didn't say). */
  failedSteps: Array<{ step: string; failed: number }>;
}

export interface DashboardData {
  now: number;
  currentWeek: number;
  weeklyActive: WeekActive[];
  cohorts: Cohort[];
  /** Daily retention: the last DAILY_COHORTS sign-up days, newest first. Only people who had free tokens at sign-up. */
  dailyCohorts: DailyCohort[];
  /** The same sign-up days' funnel (everyone who signed up), newest first. */
  signupFunnel: SignupFunnelDay[];
  weeklyCost: WeekCost[];
  topWeek: number;
  top: TopSpender[];
  limitHits: LimitHit[];
  people: { admitted: number; activeThisWeek: number };
  queue: QueueView;
  referrals: ReferralView;
  paid: PaidView;
  /** Sign-ups → first request → weekly active (3+ request days in a week), per sign-up week and in all. */
  funnel: FunnelRow[];
  /** Downloads → installs → sign-ups → first request → active, per day and per week. */
  installFunnel: InstallFunnel;
  /** Per upstream, today and this week. */
  upstreams: UpstreamStats[];
}

/** The slice of `ctx.storage.sql` the queries need. */
export interface Sql {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): { toArray(): T[] };
}

const WEEK_OF_DAY = "(day - ((day + 3) % 7))";

/** Leaves out admins: by id (ADMIN_GITHUB_IDS, bound as a JSON array) and by how they were admitted. */
export function notAdmin(column: string): string {
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
    .exec<{ github_id: number; week: number; days: number; request_days: number; requests: number; tokens: number; cost: number }>(
      `SELECT github_id, ${WEEK_OF_DAY} AS week, COUNT(*) AS days, SUM(requests > 0) AS request_days, SUM(requests) AS requests,
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

  // Who reached their allowance this week or last, and on which day: running totals per week,
  // against each person's own level (basic with its tokens off is Starter, as app.ts serves it).
  const levels = input.limits.levels;
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
       served AS (
         SELECT r.github_id AS github_id, r.day AS day, r.week AS week, r.tokens AS tokens, r.cost AS cost, g.weekly_tokens AS grant_tokens, g.weekly_usd AS grant_usd,
                CASE WHEN ? = 0 OR p.level IS NULL OR p.level = 'full' THEN 'full' WHEN p.level = 'basic' AND ? > 0 THEN 'basic'
                     WHEN p.batch_flag = 1 THEN 'none' ELSE 'starter' END AS level
         FROM running r LEFT JOIN grants g ON g.github_id = r.github_id LEFT JOIN people p ON p.github_id = r.github_id),
       limited AS (
         SELECT github_id, day, week, tokens, cost,
                CASE level WHEN 'basic' THEN ? WHEN 'starter' THEN ? WHEN 'none' THEN 0 ELSE COALESCE(grant_tokens, ?) END AS token_limit,
                COALESCE(grant_usd, CASE level WHEN 'basic' THEN ? WHEN 'starter' THEN ? WHEN 'none' THEN NULL ELSE ? END) AS usd_limit
         FROM served)
       SELECT l.week AS week, l.github_id AS github_id, p.login AS login,
              MIN(CASE WHEN l.token_limit > 0 AND l.tokens >= l.token_limit * ${TOKEN_LIMIT_SHARE} THEN l.day END) AS token_day,
              MIN(CASE WHEN l.cost >= l.usd_limit THEN l.day END) AS usd_day,
              MAX(l.tokens) AS tokens, MAX(l.cost) AS cost, MAX(l.token_limit) AS token_limit, MAX(l.usd_limit) AS usd_limit
       FROM limited l LEFT JOIN people p ON p.github_id = l.github_id
       GROUP BY l.week, l.github_id
       HAVING token_day IS NOT NULL OR usd_day IS NOT NULL`,
      currentWeekDay - 7,
      admins,
      levels ? 1 : 0,
      levels?.basicTokens ?? 0,
      levels?.basicTokens ?? 0,
      levels?.starterTokens ?? 0,
      input.limits.weeklyTokens,
      levels?.basicUsd ?? null,
      levels?.starterUsd ?? null,
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

  // The queue: who waits now, and this Monday's admission.
  const queueRow = sql
    .exec<{ waiting: number; oldest: number | null; ever: number; admitted: number }>(
      `SELECT SUM(admitted_at IS NULL) AS waiting, MIN(CASE WHEN admitted_at IS NULL THEN queued_at END) AS oldest,
              COUNT(*) AS ever, SUM(admitted_at IS NOT NULL) AS admitted FROM queue`,
    )
    .toArray()[0];
  const run = sql
    .exec<{ ran_at: number; admitted: number; waiting_before: number; avg_usd: number; actives: number; budget_usd: number | null }>(
      "SELECT ran_at, admitted, waiting_before, avg_usd, actives, budget_usd FROM queue_runs WHERE week_start = ?",
      currentWeek,
    )
    .toArray()[0];
  const queue: QueueView = {
    waiting: queueRow?.waiting ?? 0,
    oldestQueuedAt: queueRow?.oldest ?? null,
    thisWeek: run ? { admitted: run.admitted, waitingBefore: run.waiting_before, avgUsd: run.avg_usd, actives: run.actives, budgetUsd: run.budget_usd, ranAt: run.ran_at } : null,
    everQueued: queueRow?.ever ?? 0,
    admittedEver: queueRow?.admitted ?? 0,
  };

  // Referrals: counts only. Bonus tokens are filled in by the Directory, which knows the rules.
  const referralRow = sql
    .exec<{ used: number; ok: number }>("SELECT COUNT(*) AS used, SUM(outcome = 'ok') AS ok FROM referrals")
    .toArray()[0];
  const becameActive =
    sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM referrals r WHERE r.outcome = 'ok' AND EXISTS (
           SELECT 1 FROM daily_activity d WHERE d.github_id = r.referred_id AND d.requests > 0
           GROUP BY (d.day - ((d.day + 3) % 7)) HAVING COUNT(*) >= ${REGULAR_DAYS})`,
      )
      .toArray()[0]?.n ?? 0;
  const referrals: ReferralView = {
    linksUsed: referralRow?.used ?? 0,
    signups: referralRow?.ok ?? 0,
    blocked: (referralRow?.used ?? 0) - (referralRow?.ok ?? 0),
    becameActive,
    bonusTokensThisWeek: 0,
    peopleWithBonus: 0,
  };

  // The funnel per sign-up week (last WEEKS_SHOWN weeks) and in all.
  const funnelRows = sql
    .exec<{ github_id: number; admitted_at: number; requested: number; active: number; first_day: number | null }>(
      `WITH reqdays AS (SELECT github_id, ${WEEK_OF_DAY} AS week, COUNT(*) AS days, MIN(day) AS first_day FROM daily_activity WHERE requests > 0 GROUP BY github_id, week),
            per AS (SELECT github_id, MAX(days >= ${REGULAR_DAYS}) AS active, MIN(first_day) AS first_day FROM reqdays GROUP BY github_id)
       SELECT p.github_id AS github_id, p.admitted_at AS admitted_at, per.github_id IS NOT NULL AS requested, COALESCE(per.active, 0) AS active, per.first_day AS first_day
       FROM people p LEFT JOIN per ON per.github_id = p.github_id WHERE ${notAdmin("p.github_id")}`,
      admins,
    )
    .toArray();
  const funnelByWeek = new Map<number, FunnelRow>();
  for (let week = firstWeekDay; week <= currentWeekDay; week += 7) funnelByWeek.set(toMs(week), { weekStart: toMs(week), signedUp: 0, firstRequest: 0, weeklyActive: 0 });
  const funnelTotal: FunnelRow = { weekStart: null, signedUp: 0, firstRequest: 0, weeklyActive: 0 };
  for (const row of funnelRows) {
    for (const target of [funnelTotal, funnelByWeek.get(weekStart(row.admitted_at))]) {
      if (!target) continue;
      target.signedUp++;
      if (row.requested) target.firstRequest++;
      if (row.active) target.weeklyActive++;
    }
  }
  const funnel = [funnelTotal, ...[...funnelByWeek.values()].reverse()];

  // Paid plans: counts and sums only.
  const monthStart = Date.UTC(new Date(input.now).getUTCFullYear(), new Date(input.now).getUTCMonth(), 1);
  const proSubscribers =
    sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM subscriptions WHERE state = 'active' AND (period_end IS NULL OR period_end + ? > ?)", PRO_GRACE_MS, input.now)
      .toArray()[0]?.n ?? 0;
  const sums = (since: number) =>
    sql
      .exec<{ topups: number | null; cents: number | null }>("SELECT SUM(kind = 'topup') AS topups, SUM(amount_cents) AS cents FROM payments WHERE at >= ?", since)
      .toArray()[0];
  const week = sums(currentWeek);
  const month = sums(monthStart);
  const paidWeek = sql.exec<{ usd: number; n: number }>("SELECT paid_usd AS usd, paid_requests AS n FROM spend_weeks WHERE week_start = ?", currentWeek).toArray()[0];
  const paidMonth = sql.exec<{ usd: number | null }>("SELECT SUM(paid_cost_usd) AS usd FROM daily_activity WHERE day >= ?", monthStart / DAY_MS).toArray()[0];
  const paid: PaidView = {
    proSubscribers,
    topupsThisWeek: week?.topups ?? 0,
    topupsThisMonth: month?.topups ?? 0,
    revenueWeekUsd: (week?.cents ?? 0) / 100,
    revenueMonthUsd: (month?.cents ?? 0) / 100,
    paidCostWeekUsd: paidWeek?.usd ?? 0,
    paidCostMonthUsd: paidMonth?.usd ?? 0,
    paidRequestsWeek: paidWeek?.n ?? 0,
  };

  const upstreams = upstreamStats(sql, input.now);
  // Weekly actives by requests (3+ request days) and each person's first request day, from the
  // scans above, so the install funnel doesn't read daily_activity again.
  const requestRegulars = new Map<number, number>();
  for (const row of personWeeks) if (row.request_days >= REGULAR_DAYS) requestRegulars.set(row.week, (requestRegulars.get(row.week) ?? 0) + 1);
  const firstRequestDays = funnelRows.flatMap((row) => (row.first_day === null ? [] : [row.first_day]));
  const installFunnel = installFunnelData(sql, input.now, admins, { firstRequestDays, weeklyActive: requestRegulars });

  return {
    now: input.now,
    upstreams,
    currentWeek,
    queue,
    paid,
    referrals,
    funnel,
    installFunnel,
    weeklyActive,
    cohorts,
    dailyCohorts: dailyCohorts(sql, input.now, admins),
    signupFunnel: signupFunnel(sql, input.now, admins),
    weeklyCost,
    topWeek: toMs(topWeekDay),
    top,
    limitHits,
    people: { admitted, activeThisWeek: weeklyActive[weeklyActive.length - 1]?.active ?? 0 },
  };
}

/**
 * Whether a person had free tokens at sign-up, as SQL over `people p`. For sign-ups from before
 * `signup_tokens` was stored, the current level stands in: anyone not Starter counts.
 */
const HAD_TOKENS = "COALESCE(p.signup_tokens, p.level != 'starter')";

/**
 * Daily retention: people who could use dl (they had free tokens at sign-up: Full, basic, an
 * admin's grant, or Starter with an allowance) grouped by the UTC day they were admitted (the
 * last DAILY_COHORTS such days), admins and blocked accounts left out, and how many of them made
 * at least one request on each of RETENTION_DAYS days after it. People refused free tokens are
 * left out: they can't make a request, so they would only dilute the share. A day is null until
 * it has ended (UTC), so today's partial numbers never show or count in the averages. `admins`:
 * ADMIN_GITHUB_IDS as a JSON array. Two indexed reads.
 */
export function dailyCohorts(sql: Sql, now: number, admins: string): DailyCohort[] {
  const today = Math.floor(now / DAY_MS);
  const counted = `p.status != 'blocked' AND ${HAD_TOKENS} = 1 AND ${notAdmin("p.github_id")}`;
  const sizes = sql
    .exec<{ day: number; n: number }>(
      `SELECT p.admitted_at / ${DAY_MS} AS day, COUNT(*) AS n FROM people p WHERE p.admitted_at < ? AND ${counted} GROUP BY 1 ORDER BY 1 DESC LIMIT ?`,
      (today + 1) * DAY_MS,
      admins,
      DAILY_COHORTS,
    )
    .toArray();
  if (sizes.length === 0) return [];
  const first = sizes[sizes.length - 1]!.day;
  const last = RETENTION_DAYS[RETENTION_DAYS.length - 1]!;
  const active = new Map<string, number>();
  // CROSS JOIN keeps people as the outer loop: the few recent sign-ups, each looked up in
  // daily_activity by (github_id, day), instead of a scan of every person's every day.
  for (const row of sql
    .exec<{ cohort: number; after: number; n: number }>(
      `SELECT p.admitted_at / ${DAY_MS} AS cohort, d.day - p.admitted_at / ${DAY_MS} AS after, COUNT(*) AS n
       FROM people p CROSS JOIN daily_activity d ON d.github_id = p.github_id AND d.day >= p.admitted_at / ${DAY_MS} AND d.day <= p.admitted_at / ${DAY_MS} + ${last}
       WHERE p.admitted_at >= ? AND p.admitted_at < ? AND d.requests > 0 AND ${counted} GROUP BY 1, 2`,
      first * DAY_MS,
      (today + 1) * DAY_MS,
      admins,
    )
    .toArray()) {
    active.set(`${row.cohort}:${row.after}`, row.n);
  }
  return sizes.map((cohort) => ({
    day: cohort.day * DAY_MS,
    size: cohort.n,
    retained: RETENTION_DAYS.map((offset) => {
      if (cohort.day + offset >= today) return null;
      const n = active.get(`${cohort.day}:${offset}`) ?? 0;
      return { offset, active: n, share: n / cohort.n };
    }),
  }));
}

/**
 * The sign-up funnel per UTC sign-up day (the last DAILY_COHORTS days with any sign-up, newest
 * first): see SignupFunnelDay. "Opened dl" is a dl session or a refused request on the sign-up day.
 */
export function signupFunnel(sql: Sql, now: number, admins: string): SignupFunnelDay[] {
  const today = Math.floor(now / DAY_MS);
  const counted = `p.status != 'blocked' AND ${notAdmin("p.github_id")}`;
  // The oldest of the last DAILY_COHORTS sign-up days first, so the funnel reads only those days.
  const days = sql
    .exec<{ day: number }>(`SELECT DISTINCT p.admitted_at / ${DAY_MS} AS day FROM people p WHERE p.admitted_at < ? AND ${counted} ORDER BY 1 DESC LIMIT ?`, (today + 1) * DAY_MS, admins, DAILY_COHORTS)
    .toArray();
  if (days.length === 0) return [];
  const first = days[days.length - 1]!.day;
  return sql
    .exec<{ day: number; signed_up: number; got: number; opened: number | null }>(
      `SELECT p.admitted_at / ${DAY_MS} AS day, COUNT(*) AS signed_up, SUM(${HAD_TOKENS}) AS got,
              SUM(${HAD_TOKENS} = 0 AND (
                EXISTS (SELECT 1 FROM daily_activity d WHERE d.github_id = p.github_id AND d.day = p.admitted_at / ${DAY_MS} AND d.sessions > 0)
                OR EXISTS (SELECT 1 FROM refused_days r WHERE r.github_id = p.github_id AND r.day = p.admitted_at / ${DAY_MS}))) AS opened
       FROM people p WHERE p.admitted_at >= ? AND p.admitted_at < ? AND ${counted}
       GROUP BY 1 ORDER BY 1 DESC`,
      first * DAY_MS,
      (today + 1) * DAY_MS,
      admins,
    )
    .toArray()
    .map((row) => ({ day: row.day * DAY_MS, signedUp: row.signed_up, gotTokens: row.got ?? 0, refused: row.signed_up - (row.got ?? 0), refusedOpened: row.opened ?? 0 }));
}

/**
 * Day `offset`'s retention over the cohorts that have reached it, weighted by cohort size (all
 * their active people over all their people); null when none has.
 */
export function averageRetention(cohorts: readonly DailyCohort[], offset: (typeof RETENTION_DAYS)[number]): { share: number; cohorts: number; people: number } | null {
  const index = RETENTION_DAYS.indexOf(offset);
  let people = 0;
  let active = 0;
  let counted = 0;
  for (const cohort of cohorts) {
    const cell = cohort.retained[index];
    if (!cell) continue;
    people += cohort.size;
    active += cell.active;
    counted++;
  }
  return counted === 0 || people === 0 ? null : { share: active / people, cohorts: counted, people };
}

/**
 * The install funnel (see `InstallFunnelRow`). `admins`: ADMIN_GITHUB_IDS as a JSON array.
 * `people`: each non-admin's first request day, and per week (its Monday's day number) how many
 * made requests on REGULAR_DAYS or more days, as `dashboardData` already has them.
 */
export function installFunnelData(sql: Sql, now: number, admins: string, people: { firstRequestDays: Iterable<number>; weeklyActive: ReadonlyMap<number, number> }): InstallFunnel {
  const today = Math.floor(now / DAY_MS);
  const currentWeekDay = weekStart(now) / DAY_MS;
  const firstWeekDay = currentWeekDay - 7 * (WEEKS_SHOWN - 1);
  const firstDay = Math.min(firstWeekDay, today - (FUNNEL_DAYS - 1));
  const empty = (start: number): InstallFunnelRow => ({
    start: start * DAY_MS,
    downloads: 0,
    downloadsByRoute: Object.fromEntries(DOWNLOAD_ROUTES.map((route) => [route, 0])) as Record<DownloadRoute, number>,
    installsOk: 0,
    installsFailed: 0,
    signedUp: 0,
    firstRequest: 0,
    active: 0,
  });
  const days = new Map<number, InstallFunnelRow>();
  for (let day = today - (FUNNEL_DAYS - 1); day <= today; day++) days.set(day, empty(day));
  const weeks = new Map<number, InstallFunnelRow>();
  for (let week = firstWeekDay; week <= currentWeekDay; week += 7) weeks.set(week, empty(week));
  /** The rows a day counts in: its own and its week's (when shown). */
  const rowsOf = (day: number) => [days.get(day), weeks.get(day - ((day + 3) % 7))].filter((row): row is InstallFunnelRow => row !== undefined);

  for (const row of sql
    .exec<{ day: number; route: string; n: number }>("SELECT day, route, SUM(downloads) AS n FROM download_daily WHERE day >= ? GROUP BY day, route", firstDay)
    .toArray()) {
    for (const target of rowsOf(row.day)) {
      target.downloads += row.n;
      if (row.route in target.downloadsByRoute) target.downloadsByRoute[row.route as DownloadRoute] += row.n;
    }
  }
  for (const row of sql
    .exec<{ day: number; result: string; n: number }>("SELECT day, result, SUM(installs) AS n FROM install_daily WHERE day >= ? GROUP BY day, result", firstDay)
    .toArray()) {
    for (const target of rowsOf(row.day)) {
      if (row.result === "ok") target.installsOk += row.n;
      else target.installsFailed += row.n;
    }
  }
  for (const row of sql
    .exec<{ day: number; n: number }>(`SELECT admitted_at / ${DAY_MS} AS day, COUNT(*) AS n FROM people WHERE admitted_at >= ? AND ${notAdmin("github_id")} GROUP BY 1`, firstDay * DAY_MS, admins)
    .toArray()) {
    for (const target of rowsOf(row.day)) target.signedUp += row.n;
  }
  for (const day of people.firstRequestDays) for (const target of rowsOf(day)) target.firstRequest++;
  for (const row of sql
    .exec<{ day: number; n: number }>(`SELECT day, COUNT(*) AS n FROM daily_activity WHERE day >= ? AND requests > 0 AND ${notAdmin("github_id")} GROUP BY day`, firstDay, admins)
    .toArray()) {
    const target = days.get(row.day);
    if (target) target.active = row.n;
  }
  for (const [week, n] of people.weeklyActive) {
    const target = weeks.get(week);
    if (target) target.active = n;
  }

  const { platforms, failedSteps } = installBreakdown(sql, firstWeekDay, today + 1);
  return { days: [...days.values()].reverse(), weeks: [...weeks.values()].reverse(), platforms, failedSteps };
}

/**
 * Finished installs over UTC days `fromDay` (inclusive) to `untilDay` (exclusive), by OS, chip and
 * mode (most first), and the steps failed installs stopped at (most first, ten at most). The
 * dashboard shows the weeks on the page; the daily digest shows one day.
 */
export function installBreakdown(
  sql: Sql,
  fromDay: number,
  untilDay: number,
): Pick<InstallFunnel, "platforms" | "failedSteps"> {
  const platforms = sql
    .exec<{ os: string; arch: string; mode: string; ok: number; failed: number }>(
      `SELECT os, arch, mode, SUM(CASE WHEN result = 'ok' THEN installs ELSE 0 END) AS ok, SUM(CASE WHEN result = 'ok' THEN 0 ELSE installs END) AS failed
       FROM install_daily WHERE day >= ? AND day < ? GROUP BY os, arch, mode ORDER BY ok + failed DESC, os, arch, mode`,
      fromDay,
      untilDay,
    )
    .toArray();
  const failedSteps = sql
    .exec<{ step: string; failed: number }>(
      `SELECT failed_step AS step, SUM(installs) AS failed FROM install_daily WHERE day >= ? AND day < ? AND result = 'failed'
       GROUP BY failed_step ORDER BY failed DESC, failed_step LIMIT 10`,
      fromDay,
      untilDay,
    )
    .toArray();
  return { platforms, failedSteps };
}

/** One window of `upstreamStats`: counts from UTC day `fromDay` on, timings from `since` (default: that day's start). */
export interface UpstreamWindow {
  window: UpstreamStats["window"];
  fromDay: number;
  since?: number;
}

/**
 * Per upstream, today and this week (or the windows given): counts from `upstream_daily`,
 * percentiles from `upstream_timings` (kept TIMINGS_MAX_AGE_MS, 15 days, by the Directory).
 */
export function upstreamStats(sql: Sql, now: number, windows?: readonly UpstreamWindow[]): UpstreamStats[] {
  const today = Math.floor(now / DAY_MS);
  const week = weekStart(now) / DAY_MS;
  const out: UpstreamStats[] = [];
  const list: readonly UpstreamWindow[] = windows ?? [
    { window: "today", fromDay: today },
    { window: "week", fromDay: week },
  ];
  for (const { window, fromDay, since: from } of list) {
    for (const upstream of UPSTREAM_NAMES) {
      const row = sql
        .exec<{ requests: number | null; errors: number | null; prompt: number | null; cached: number | null; cash: number | null; credit: number | null }>(
          `SELECT SUM(requests) AS requests, SUM(errors) AS errors, SUM(prompt_tokens) AS prompt, SUM(cached_tokens) AS cached,
                  SUM(cash_usd) AS cash, SUM(credit_usd) AS credit
           FROM upstream_daily WHERE upstream = ? AND day >= ?`,
          upstream,
          fromDay,
        )
        .toArray()[0];
      const since = from ?? fromDay * DAY_MS;
      out.push({
        upstream,
        window,
        requests: row?.requests ?? 0,
        errors: row?.errors ?? 0,
        medianTtftMs: percentile(sql, "ttft_ms", upstream, since, 0.5),
        p90TtftMs: percentile(sql, "ttft_ms", upstream, since, 0.9),
        medianTtfbMs: percentile(sql, "ttfb_ms", upstream, since, 0.5),
        cacheHitShare: row?.prompt ? (row.cached ?? 0) / row.prompt : null,
        cashUsd: row?.cash ?? 0,
        creditUsd: row?.credit ?? 0,
      });
    }
  }
  return out;
}

/** The nearest-rank percentile of one timing column since `since`; null without values. */
function percentile(sql: Sql, column: "ttft_ms" | "ttfb_ms", upstream: string, since: number, share: number): number | null {
  const n = sql.exec<{ n: number }>(`SELECT COUNT(${column}) AS n FROM upstream_timings WHERE upstream = ? AND at >= ?`, upstream, since).toArray()[0]?.n ?? 0;
  if (n === 0) return null;
  const rank = Math.max(1, Math.ceil(share * n));
  return (
    sql
      .exec<{ v: number }>(`SELECT ${column} AS v FROM upstream_timings WHERE upstream = ? AND at >= ? AND ${column} IS NOT NULL ORDER BY ${column} LIMIT 1 OFFSET ?`, upstream, since, rank - 1)
      .toArray()[0]?.v ?? null
  );
}

/** The median of a list (sorted here); null when it's empty. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
