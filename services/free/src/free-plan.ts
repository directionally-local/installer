/**
 * dl.new's Free plan (owner decision, 26 Nov 2026): no card, GitHub sign-in only, DeepSeek V4.1
 * Flash only, a weekly cap that resets Mon 00:00 UTC. Off until the owner turns it on:
 *
 *   POST /admin/config {"freePlan": "on"}
 *
 * While it is on, /web/plans offers it (`freePlan`), and a GitHub sign-in with no account makes a
 * Free account (after the free tier's account checks and `freePlanMinAccountAgeDays`) instead of
 * the "pick a plan" pending sign-in. Google and email sign-ins still go to pick a plan. While it
 * is off, nothing offers it, nobody new gets it, and an existing Free account is refused like any
 * account without a plan ("Pick a plan at dl.new").
 *
 * The cap is set and shown in REAL tokens with caching applied ("10M tokens/week (95.5% caching
 * applied)") and enforced in COUNTED tokens like the paid plans (plans.ts countedLimit: cached
 * input x cachedTokenWeight + fresh input + output). It uses the plans' own weekly per-model meter
 * (plan-meter.ts model_usage), so it resets with the week and needs no reset job.
 *
 * One global safety: `freePlanWeeklyUsdCap`, what every Free account together may cost us a week
 * (the Directory's `free_plan_spend`). Past it, new Free requests get FREE_CAPACITY_FULL_MESSAGE.
 *
 * Pure functions, the copy and the Directory's SQL; the routes are in app.ts (chat) and
 * paid-web.ts (sign-in, /web/plans, /web/account, /web/usage).
 */

import { approxTokens, countedLimit, PLAN_MIX_LABEL, WEEKS_PER_MONTH, type PlanSettingsConfig } from "./plans.js";
import { PLANS } from "./plan-prices.js";
import { weekEnd, weekStart } from "./week.js";

export const FREE_PLAN_MODES = ["off", "on"] as const;
export type FreePlanMode = (typeof FREE_PLAN_MODES)[number];

export type FreePlanSettingsConfig = {
  /** The master switch (default "off"). */
  freePlan: FreePlanMode;
  /** Real tokens a week (95.5% caching applied) of DeepSeek V4.1 Flash; enforced as counted. Default 10M. */
  freePlanWeeklyRealTokens: number;
  /** What every Free account together may cost a week, USD (default 150). */
  freePlanWeeklyUsdCap: number;
  /** A GitHub account at least this many days old gets the Free plan (default 90). */
  freePlanMinAccountAgeDays: number;
};

export const FREE_PLAN_DEFAULTS: FreePlanSettingsConfig = {
  freePlan: "off",
  freePlanWeeklyRealTokens: 10_000_000,
  freePlanWeeklyUsdCap: 150,
  freePlanMinAccountAgeDays: 90,
};

export const FREE_PLAN_SETTING_ENV: Readonly<Record<keyof FreePlanSettingsConfig, string>> = {
  freePlan: "FREE_PLAN",
  freePlanWeeklyRealTokens: "FREE_PLAN_WEEKLY_REAL_TOKENS",
  freePlanWeeklyUsdCap: "FREE_PLAN_WEEKLY_USD_CAP",
  freePlanMinAccountAgeDays: "FREE_PLAN_MIN_ACCOUNT_AGE_DAYS",
};

/** The share of the week's cap that sends the 80% notice and email. */
export const FREE_PLAN_WARN_SHARE = 0.8;
export const FREE_PLAN_URL = "https://dl.new";
const CACHING = `(${PLAN_MIX_LABEL})`;

export function freePlanOn(config: Pick<FreePlanSettingsConfig, "freePlan">): boolean {
  return config.freePlan === "on";
}

/** The week's cap as the counted tokens it is enforced at. */
export function freePlanCountedLimit(config: Pick<FreePlanSettingsConfig, "freePlanWeeklyRealTokens"> & { cachedTokenWeight: number }): number {
  return countedLimit(config.freePlanWeeklyRealTokens, config.cachedTokenWeight);
}

/** Counted tokens used as real tokens at the plan mix, scaled to the week's real cap. */
export function freePlanRealUsed(counted: number, limit: number, realLimit: number): number {
  return limit > 0 ? Math.round((Math.min(Math.max(0, counted), limit) / limit) * realLimit) : 0;
}

// ─── Copy ────────────────────────────────────────────────────────────────────

/** Tokens without the tilde: "10M" (a setting is exact). */
function exact(tokens: number): string {
  return approxTokens(tokens).replace(/^~/, "");
}

/** The cheapest plan: "Starter $7/mo, ~269M tokens/month (~62M/week) (95.5% caching applied)". */
export function starterLine(config: Pick<PlanSettingsConfig, "planTokens.starter.deepseek">): string {
  const week = config["planTokens.starter.deepseek"];
  return `Starter $${PLANS.starter.priceUsd}/mo, ${approxTokens(week * WEEKS_PER_MONTH)} tokens/month (${approxTokens(week)}/week) ${CACHING}`;
}

/** The upgrade prompt every Free limit message ends with. */
export function upgradeLine(config: Pick<PlanSettingsConfig, "planTokens.starter.deepseek">): string {
  return `Upgrade at ${FREE_PLAN_URL}: ${starterLine(config)}.`;
}

/** The plan page's one no-card option: "Start free (no card) — 10M tokens/week (95.5% caching applied). Sign in with GitHub." */
export function freePlanLine(config: Pick<FreePlanSettingsConfig, "freePlanWeeklyRealTokens">): string {
  return `Start free (no card) — ${exact(config.freePlanWeeklyRealTokens)} tokens/week ${CACHING}. Sign in with GitHub.`;
}

/** "Free plan: 81% of this week used (~8.1M of 10M at 95.5% caching), ~1.9M left until Mon 00:00 UTC. Upgrade at https://dl.new: Starter ..." */
export function freePlanWarning(input: { counted: number; limit: number; realLimit: number; config: Pick<PlanSettingsConfig, "planTokens.starter.deepseek"> }): string {
  const share = Math.min(99, Math.max(80, Math.floor((input.counted / Math.max(1, input.limit)) * 100)));
  const used = freePlanRealUsed(input.counted, input.limit, input.realLimit);
  return `Free plan: ${share}% of this week used (${approxTokens(used)} of ${exact(input.realLimit)} at 95.5% caching), ${approxTokens(Math.max(0, input.realLimit - used))} left until Mon 00:00 UTC. ${upgradeLine(input.config)}`;
}

/** 402 free_plan_limit: "Your Free plan's 10M tokens this week (95.5% caching applied) are used. They reset Mon 00:00 UTC. Upgrade at https://dl.new: ..." */
export function freePlanLimitMessage(realLimit: number, config: Pick<PlanSettingsConfig, "planTokens.starter.deepseek">): string {
  return `Your Free plan's ${exact(realLimit)} tokens this week ${CACHING} are used. They reset Mon 00:00 UTC. ${upgradeLine(config)}`;
}

/** 402 free_capacity_full: the global weekly cap is reached. */
export function freeCapacityFullMessage(config: Pick<PlanSettingsConfig, "planTokens.starter.deepseek">): string {
  return `Free capacity is full this week. It opens again Mon 00:00 UTC. Starter is $${PLANS.starter.priceUsd}/mo: ${upgradeLine(config)}`;
}

/** Any other model on Free: "Kimi K3.1 isn't on the Free plan. Now using DeepSeek V4.1 Flash." */
export function notOnFreeNotice(name: string): string {
  return `${name} isn't on the Free plan. Now using DeepSeek V4.1 Flash.`;
}

export const FREE_PLAN_NOT_ELIGIBLE_MESSAGE = "This GitHub account can't get the Free plan. Pick a plan at dl.new to start.";
export const FREE_PLAN_EMAIL_USED_MESSAGE = "This email already has a dl.new account. Sign in with it, or pick a plan at dl.new.";

/** Why a Free plan sign-up was refused: below the bar or too young ("not_eligible"), the email taken ("used"). */
export type FreePlanRefusal = "not_eligible" | "used";

/** The account checks the Free plan adds to the free tier's: the GitHub account's age. */
export function oldEnough(accountAgeDays: number | undefined, config: Pick<FreePlanSettingsConfig, "freePlanMinAccountAgeDays">): boolean {
  return typeof accountAgeDays === "number" && Number.isFinite(accountAgeDays) && accountAgeDays >= config.freePlanMinAccountAgeDays;
}

// ─── What the pages and emails show ──────────────────────────────────────────

/** `/web/plans` `freePlan`: the offer while the switch is on (left out while it is off). */
export function freePlanOffer(config: FreePlanSettingsConfig & PlanSettingsConfig & { cachedTokenWeight: number }, capacityFull: boolean) {
  return {
    enabled: true,
    available: !capacityFull,
    capacityFull,
    tokensPerWeek: config.freePlanWeeklyRealTokens,
    countedTokensPerWeek: freePlanCountedLimit(config),
    model: "DeepSeek V4.1 Flash",
    line: freePlanLine(config),
    label: CACHING,
    signIn: "github",
    upgrade: { url: FREE_PLAN_URL, line: starterLine(config) },
  };
}

/** `/web/account` and `/web/usage` `freePlan`: this week's meter, or null for an account not on Free. */
export function freePlanView(input: { on: boolean; counted: number; config: FreePlanSettingsConfig & PlanSettingsConfig & { cachedTokenWeight: number }; now: number }) {
  const { config } = input;
  const limit = freePlanCountedLimit(config);
  const realLimit = config.freePlanWeeklyRealTokens;
  const used = freePlanRealUsed(input.counted, limit, realLimit);
  const state = !input.on ? "off" : input.counted >= limit ? "used_up" : input.counted >= limit * FREE_PLAN_WARN_SHARE ? "warning" : "ok";
  const percent = limit > 0 ? Math.min(100, Math.floor((input.counted / limit) * 100)) : 100;
  return {
    plan: "free",
    name: "Free",
    model: "DeepSeek V4.1 Flash",
    state,
    tokensPerWeek: realLimit,
    usedAtMix: used,
    leftAtMix: Math.max(0, realLimit - used),
    countedLimit: limit,
    countedUsed: input.counted,
    percent,
    label: CACHING,
    weekStart: new Date(weekStart(input.now)).toISOString(),
    resetsAt: new Date(weekEnd(input.now)).toISOString(),
    line:
      state === "off"
        ? `The Free plan is paused. Pick a plan at ${FREE_PLAN_URL} to keep going.`
        : state === "used_up"
          ? freePlanLimitMessage(realLimit, config)
          : `Free plan: ${approxTokens(used)} of ${exact(realLimit)} tokens this week ${CACHING}. Resets Mon 00:00 UTC.${state === "warning" ? ` ${upgradeLine(config)}` : ""}`,
    upgrade: { url: FREE_PLAN_URL, line: starterLine(config) },
  };
}

/** free_80 / free_100 email values (user-emails.ts): {share} {used} {tokens} {left} {upgrade}. */
export function freePlanEmailValues(input: { counted: number; config: FreePlanSettingsConfig & PlanSettingsConfig & { cachedTokenWeight: number } }): Record<"share" | "used" | "tokens" | "left" | "upgrade", string> {
  const limit = freePlanCountedLimit(input.config);
  const realLimit = input.config.freePlanWeeklyRealTokens;
  const used = freePlanRealUsed(input.counted, limit, realLimit);
  return {
    share: String(Math.min(100, Math.max(80, Math.floor((input.counted / Math.max(1, limit)) * 100)))),
    used: approxTokens(used),
    tokens: exact(realLimit),
    left: approxTokens(Math.max(0, realLimit - used)),
    upgrade: starterLine(input.config),
  };
}

// ─── The Directory's records ─────────────────────────────────────────────────

/** What the helpers need of Durable Object SQL storage. */
export interface FreePlanSql {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): { toArray(): T[] };
}

export const FREE_PLAN_SCHEMA = [
  // Every Free account made (one per GitHub account; the email is checked before).
  `CREATE TABLE IF NOT EXISTS free_plans (
     account    INTEGER PRIMARY KEY,
     github_id  INTEGER NOT NULL UNIQUE,
     email_norm TEXT,
     started_at INTEGER NOT NULL
   )`,
  // What Free accounts together cost us per week (OpenRouter's cash, else the provider's credit).
  `CREATE TABLE IF NOT EXISTS free_plan_spend (
     week_start INTEGER PRIMARY KEY,
     usd        REAL NOT NULL DEFAULT 0,
     counted    INTEGER NOT NULL DEFAULT 0,
     requests   INTEGER NOT NULL DEFAULT 0
   )`,
];

export function insertFreePlan(sql: FreePlanSql, input: { account: number; githubId: number; emailNorm: string; now: number }): void {
  sql.exec("INSERT OR IGNORE INTO free_plans (account, github_id, email_norm, started_at) VALUES (?, ?, ?, ?)", input.account, input.githubId, input.emailNorm, input.now);
}

/** One Free request's cost, for the global weekly cap. */
export function noteFreePlanSpend(sql: FreePlanSql, input: { at: number; usd: number; counted: number }): void {
  sql.exec(
    `INSERT INTO free_plan_spend (week_start, usd, counted, requests) VALUES (?, ?, ?, 1)
     ON CONFLICT (week_start) DO UPDATE SET usd = usd + excluded.usd, counted = counted + excluded.counted, requests = requests + 1`,
    weekStart(input.at),
    Math.max(0, input.usd),
    Math.max(0, Math.round(input.counted)),
  );
}

export function freePlanWeek(sql: FreePlanSql, now: number): { usd: number; counted: number; requests: number; accounts: number } {
  const row = sql.exec<{ usd: number; counted: number; requests: number }>("SELECT usd, counted, requests FROM free_plan_spend WHERE week_start = ?", weekStart(now)).toArray()[0];
  const accounts = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM free_plans").toArray()[0]?.n ?? 0;
  return { usd: row?.usd ?? 0, counted: row?.counted ?? 0, requests: row?.requests ?? 0, accounts };
}

/** Whether the week's global cap is reached. */
export function capacityFull(spentUsd: number, config: Pick<FreePlanSettingsConfig, "freePlanWeeklyUsdCap">): boolean {
  return spentUsd >= config.freePlanWeeklyUsdCap;
}
