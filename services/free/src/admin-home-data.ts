import type { Sql } from "./dashboard-data.js";
import { DAY_MS, weekStart } from "./week.js";

/**
 * The admin home's numbers (GET /admin): the same data the old Kimiflare Cloud admin dashboard
 * showed, in dl's model. Stat cards (users, active grants, the weekly budget, estimated cost,
 * feedback, input tokens over the last 7 days), platform health, the paid plans, a users table,
 * the admin-set personal caps (active and ended) and usage per day, week and month.
 *
 * Every read is bounded by people or days, never by the request log:
 *   person_totals   all-time tokens, cost and requests per person (kept with each request)
 *   daily_activity  per person per day (admins left out): this week's spend, the usage chart
 *   people, grants, grant_history, subscriptions, payments, person_networks (a count), feedback_daily
 *
 * Admins are left out of every total, as everywhere else, and shown (marked) in the users table.
 * Counts, sums, logins and times only: no email, no content. `ADMIN_HOME_COLUMNS` lists every
 * column read (a test holds the queries to it).
 */

/** Every query here starts with this comment, so a test can hold them to `ADMIN_HOME_COLUMNS`. */
export const ADMIN_HOME_QUERY_TAG = "/* admin-home */";

/** Tables and columns the admin home may read. */
export const ADMIN_HOME_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  people: ["github_id", "login", "status", "admitted_at", "admitted_via", "level", "batch_flag"],
  person_totals: ["github_id", "prompt_tokens", "completion_tokens", "cost_usd", "requests", "last_at"],
  daily_activity: ["day", "github_id", "requests", "cost_usd", "deepseek_cost_usd", "prompt_tokens", "completion_tokens"],
  grants: ["github_id", "weekly_tokens", "weekly_usd"],
  grant_history: ["github_id", "weekly_usd", "weekly_tokens", "set_at", "ended_at", "ended_how"],
  subscriptions: ["github_id", "state", "period_end"],
  payments: ["kind", "amount_cents"],
  person_networks: ["github_id"],
  feedback_daily: ["day", "n"],
};

/** A Pro subscription whose period ended this long ago without a renewal no longer counts as active. */
export const PRO_GRACE_MS = 3 * DAY_MS;
/** Bars in the usage chart per period. */
export const USAGE_PERIODS = { day: 30, week: 12, month: 12 } as const;
export type UsagePeriodKind = keyof typeof USAGE_PERIODS;

export type Plan = "pro" | "past_due" | "canceled" | "free";

export interface AdminUserRow {
  githubId: number;
  login: string;
  status: string;
  level: string;
  batchFlagged: boolean;
  /** In ADMIN_GITHUB_IDS or admitted as an admin. */
  admin: boolean;
  joinedAt: number;
  plan: Plan;
  /** The admin-set personal caps; null: the level's. */
  grantUsd: number | null;
  grantTokens: number | null;
  /** All time, every request (free and paid). Cost at the allowance's prices. */
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  requests: number;
  lastActiveAt: number | null;
  /** This week's free spend (Monday UTC on) from the daily roll-up: GPT-6 and DeepSeek budgets. */
  weekGptUsd: number;
  weekDeepseekUsd: number;
  /** Distinct networks (keyed hashes) the person signed in from. dl never stores an address. */
  networks: number;
}

export interface AdminGrantRow {
  githubId: number;
  login: string | null;
  status: string | null;
  weeklyUsd: number | null;
  weeklyTokens: number | null;
  /** null: from before set times were kept, with no admin log entry. */
  setAt: number | null;
  endedAt: number | null;
  /** "replaced", "removed", or "blocked" for a cap still set on a blocked account. */
  endedHow: string | null;
}

export interface UsagePeriod {
  /** The period's first day, ms (UTC; weeks start Monday). */
  start: number;
  promptTokens: number;
  completionTokens: number;
  requests: number;
}

export interface AdminHomeData {
  now: number;
  weekStart: number;
  totalUsers: number;
  blockedUsers: number;
  feedback: { total: number; sinceDay: number | null };
  /** Admins left out: the last 7 UTC days, today included. */
  last7: { promptTokens: number; completionTokens: number };
  /** Admins left out, all time. */
  totals: { promptTokens: number; completionTokens: number; costUsd: number; requests: number };
  subscriptions: { active: number; pastDue: number; canceled: number };
  payments: { topups: number; topupCents: number; proCents: number };
  users: AdminUserRow[];
  activeGrants: AdminGrantRow[];
  endedGrants: AdminGrantRow[];
  usage: Record<UsagePeriodKind, UsagePeriod[]>;
}

/** Monday 00:00 UTC of a day number, as a day number. */
const mondayOf = (day: number) => day - ((day + 3) % 7);
const monthOf = (day: number) => {
  const date = new Date(day * DAY_MS);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / DAY_MS;
};

/** The plan badge from the dashboard's copy of the Pro subscription. A lapsed "active" one counts as canceled. */
export function planOf(state: string | null, periodEnd: number | null, now: number): Plan {
  if (state === "active") return periodEnd === null || periodEnd + PRO_GRACE_MS > now ? "pro" : "canceled";
  if (state === "past_due") return "past_due";
  if (state === "canceled") return "canceled";
  return "free";
}

export function adminHomeData(store: Sql, input: { now: number; adminIds: readonly number[] }): AdminHomeData {
  const sql: Sql = { exec: (query, ...bindings) => store.exec(`${ADMIN_HOME_QUERY_TAG} ${query}`, ...bindings) };
  const { now } = input;
  const adminIds = new Set(input.adminIds);
  const today = Math.floor(now / DAY_MS);
  const week = weekStart(now);

  type UserRow = {
    github_id: number;
    login: string;
    status: string;
    level: string;
    batch_flag: number;
    admitted_at: number;
    admitted_via: string;
    prompt: number | null;
    completion: number | null;
    cost: number | null;
    requests: number | null;
    last_at: number | null;
    grant_usd: number | null;
    grant_tokens: number | null;
    sub_state: string | null;
    period_end: number | null;
    week_gpt: number | null;
    week_deepseek: number | null;
    networks: number;
  };
  // One row per person: people, their totals, their caps, their plan and this week's spend.
  const users = sql
    .exec<UserRow>(
      `SELECT p.github_id, p.login, p.status, p.level, p.batch_flag, p.admitted_at, p.admitted_via,
              t.prompt_tokens AS prompt, t.completion_tokens AS completion, t.cost_usd AS cost, t.requests, t.last_at,
              g.weekly_usd AS grant_usd, g.weekly_tokens AS grant_tokens, s.state AS sub_state, s.period_end,
              w.gpt AS week_gpt, w.deepseek AS week_deepseek,
              (SELECT COUNT(*) FROM person_networks n WHERE n.github_id = p.github_id) AS networks
       FROM people p
       LEFT JOIN person_totals t ON t.github_id = p.github_id
       LEFT JOIN grants g ON g.github_id = p.github_id
       LEFT JOIN subscriptions s ON s.github_id = p.github_id
       LEFT JOIN (SELECT github_id, SUM(cost_usd - deepseek_cost_usd) AS gpt, SUM(deepseek_cost_usd) AS deepseek
                  FROM daily_activity WHERE day >= ? GROUP BY github_id) w ON w.github_id = p.github_id
       ORDER BY p.admitted_at DESC, p.github_id DESC`,
      week / DAY_MS,
    )
    .toArray()
    .map(
      (row): AdminUserRow => ({
        githubId: row.github_id,
        login: row.login,
        status: row.status,
        level: row.level,
        batchFlagged: row.batch_flag === 1,
        admin: adminIds.has(row.github_id) || row.admitted_via === "admin",
        joinedAt: row.admitted_at,
        plan: planOf(row.sub_state, row.period_end, now),
        grantUsd: row.grant_usd,
        grantTokens: row.grant_tokens,
        promptTokens: row.prompt ?? 0,
        completionTokens: row.completion ?? 0,
        costUsd: row.cost ?? 0,
        requests: row.requests ?? 0,
        lastActiveAt: row.last_at,
        weekGptUsd: Math.max(0, row.week_gpt ?? 0),
        weekDeepseekUsd: row.week_deepseek ?? 0,
        networks: row.networks,
      }),
    );

  const counted = users.filter((user) => !user.admin);
  const totals = {
    promptTokens: counted.reduce((sum, user) => sum + user.promptTokens, 0),
    completionTokens: counted.reduce((sum, user) => sum + user.completionTokens, 0),
    costUsd: counted.reduce((sum, user) => sum + user.costUsd, 0),
    requests: counted.reduce((sum, user) => sum + user.requests, 0),
  };
  const subscriptions = { active: 0, pastDue: 0, canceled: 0 };
  for (const user of users) {
    if (user.plan === "pro") subscriptions.active++;
    else if (user.plan === "past_due") subscriptions.pastDue++;
    else if (user.plan === "canceled") subscriptions.canceled++;
  }
  const paid = sql
    .exec<{ topups: number | null; topup_cents: number | null; pro_cents: number | null }>(
      "SELECT SUM(kind = 'topup') AS topups, SUM(CASE WHEN kind = 'topup' THEN amount_cents ELSE 0 END) AS topup_cents, SUM(CASE WHEN kind = 'pro' THEN amount_cents ELSE 0 END) AS pro_cents FROM payments",
    )
    .toArray()[0];
  const feedback = sql.exec<{ total: number | null; since: number | null }>("SELECT SUM(n) AS total, MIN(day) AS since FROM feedback_daily").toArray()[0];

  // Personal caps: the current ones (grants), dated by their open history entry, and the ended ones.
  const logins = new Map(users.map((user) => [user.githubId, user]));
  const history = sql
    .exec<{ github_id: number; weekly_usd: number | null; weekly_tokens: number | null; set_at: number | null; ended_at: number | null; ended_how: string | null }>(
      "SELECT github_id, weekly_usd, weekly_tokens, set_at, ended_at, ended_how FROM grant_history ORDER BY COALESCE(ended_at, set_at) DESC",
    )
    .toArray();
  const openSince = new Map<number, number | null>();
  for (const row of history) if (row.ended_at === null && !openSince.has(row.github_id)) openSince.set(row.github_id, row.set_at);
  const grantRow = (githubId: number, rest: Omit<AdminGrantRow, "githubId" | "login" | "status">): AdminGrantRow => ({
    githubId,
    login: logins.get(githubId)?.login ?? null,
    status: logins.get(githubId)?.status ?? null,
    ...rest,
  });
  const current = sql.exec<{ github_id: number; weekly_usd: number | null; weekly_tokens: number | null }>("SELECT github_id, weekly_usd, weekly_tokens FROM grants").toArray();
  const activeGrants: AdminGrantRow[] = [];
  const endedGrants: AdminGrantRow[] = [];
  for (const row of current) {
    const blocked = logins.get(row.github_id)?.status === "blocked";
    const entry = grantRow(row.github_id, { weeklyUsd: row.weekly_usd, weeklyTokens: row.weekly_tokens, setAt: openSince.get(row.github_id) ?? null, endedAt: null, endedHow: blocked ? "blocked" : null });
    (blocked ? endedGrants : activeGrants).push(entry);
  }
  for (const row of history) {
    if (row.ended_at === null) continue;
    endedGrants.push(grantRow(row.github_id, { weeklyUsd: row.weekly_usd, weeklyTokens: row.weekly_tokens, setAt: row.set_at, endedAt: row.ended_at, endedHow: row.ended_how }));
  }
  const newest = (a: AdminGrantRow, b: AdminGrantRow) => (b.endedAt ?? b.setAt ?? 0) - (a.endedAt ?? a.setAt ?? 0);
  activeGrants.sort(newest);
  endedGrants.sort(newest);

  // Usage per day, week and month (admins left out), from at most a year of daily rows.
  const first = Math.min(today - USAGE_PERIODS.day + 1, mondayOf(today) - 7 * (USAGE_PERIODS.week - 1), monthOf(today) - 31 * USAGE_PERIODS.month);
  const days = sql
    .exec<{ day: number; prompt: number; completion: number; requests: number }>(
      "SELECT day, SUM(prompt_tokens) AS prompt, SUM(completion_tokens) AS completion, SUM(requests) AS requests FROM daily_activity WHERE day >= ? GROUP BY day",
      first,
    )
    .toArray();
  const series = (kind: UsagePeriodKind): UsagePeriod[] => {
    const startOf = kind === "day" ? (day: number) => day : kind === "week" ? mondayOf : monthOf;
    const starts: number[] = [];
    let cursor = startOf(today);
    while (starts.length < USAGE_PERIODS[kind]) {
      starts.unshift(cursor);
      cursor = kind === "month" ? monthOf(cursor - 1) : cursor - (kind === "week" ? 7 : 1);
    }
    const byStart = new Map(starts.map((start) => [start, { start: start * DAY_MS, promptTokens: 0, completionTokens: 0, requests: 0 }]));
    for (const row of days) {
      const target = byStart.get(startOf(row.day));
      if (!target) continue;
      target.promptTokens += row.prompt;
      target.completionTokens += row.completion;
      target.requests += row.requests;
    }
    return [...byStart.values()];
  };
  const last7 = days.filter((row) => row.day > today - 7 && row.day <= today);

  return {
    now,
    weekStart: week,
    totalUsers: users.length,
    blockedUsers: users.filter((user) => user.status === "blocked").length,
    feedback: { total: feedback?.total ?? 0, sinceDay: feedback?.since ?? null },
    last7: { promptTokens: last7.reduce((sum, row) => sum + row.prompt, 0), completionTokens: last7.reduce((sum, row) => sum + row.completion, 0) },
    totals,
    subscriptions,
    payments: { topups: paid?.topups ?? 0, topupCents: paid?.topup_cents ?? 0, proCents: paid?.pro_cents ?? 0 },
    users,
    activeGrants,
    endedGrants,
    usage: { day: series("day"), week: series("week"), month: series("month") },
  };
}

// ─── Allowance per level ──────────────────────────────────────────────────

/** The settings a person's weekly allowance comes from (effective values). */
export interface LevelSettings {
  weeklyTokens: number;
  /** Each level's GPT-6 budget (`...Usd`) and DeepSeek budget (`...DeepseekUsd`, absent: the GPT-6 one). */
  perPersonWeeklyUsd: number | null;
  deepseekWeeklyUsd?: number | null;
  basicWeeklyTokens: number;
  basicWeeklyUsd: number | null;
  basicDeepseekWeeklyUsd?: number | null;
  starterWeeklyTokens: number;
  starterWeeklyUsd: number | null;
  starterDeepseekWeeklyUsd?: number | null;
}

/** The tier in plain words: full, middle (basic), small (Starter) or no tokens. */
export type Tier = "full" | "middle" | "small" | "no tokens";

/**
 * A person's real weekly allowance, as app.ts `limitsFor` and the AccountObject compute it: basic
 * with its tokens at 0 is served as Starter; a batch-flagged Starter account gets 0 tokens and 0
 * of both budgets; an admin's grant sets Full's tokens and any level's GPT-6 budget, and DeepSeek
 * then gets the larger of the grant and the level's DeepSeek budget. Referral bonuses aren't counted.
 */
export function realAllowance(
  person: { level: string | null; batchFlagged: boolean; grantTokens: number | null; grantUsd: number | null },
  settings: LevelSettings,
): { tier: Tier; tokens: number; usd: number | null; deepseekUsd: number | null } {
  const level = person.level === "basic" && settings.basicWeeklyTokens <= 0 ? "starter" : person.level;
  const grantUsd = person.grantUsd;
  const deepseek = (levelUsd: number | null, own: number | null | undefined) => {
    const base = own === undefined ? levelUsd : own;
    return base === null ? null : grantUsd === null ? base : Math.max(grantUsd, base);
  };
  if (level === "basic") return { tier: "middle", tokens: settings.basicWeeklyTokens, usd: grantUsd ?? settings.basicWeeklyUsd, deepseekUsd: deepseek(settings.basicWeeklyUsd, settings.basicDeepseekWeeklyUsd) };
  if (level === "starter") {
    const tokens = person.batchFlagged ? 0 : settings.starterWeeklyTokens;
    if (tokens <= 0) return { tier: "no tokens", tokens, usd: 0, deepseekUsd: 0 };
    return { tier: "small", tokens, usd: grantUsd ?? settings.starterWeeklyUsd, deepseekUsd: deepseek(settings.starterWeeklyUsd, settings.starterDeepseekWeeklyUsd) };
  }
  return { tier: "full", tokens: person.grantTokens ?? settings.weeklyTokens, usd: grantUsd ?? settings.perPersonWeeklyUsd, deepseekUsd: deepseek(settings.perPersonWeeklyUsd, settings.deepseekWeeklyUsd) };
}
