/**
 * The per-model meters of one account (AccountObject's storage): what each model used this week
 * in counted and real tokens, per day, per tool, how many requests a backup provider or a
 * fallback model served, and the GPT-6 launch bonus's dollars. Plain functions over the Durable
 * Object's SQL so the account object only calls them (no logic of its own here).
 *
 * Weeks are Monday 00:00 UTC (week.ts). Rows older than METER_KEEP_DAYS are pruned as they roll.
 */

import { DAY_MS, dayStart, weekStart } from "./week.js";
import { realisticPromptTokens, type Usage } from "./quota.js";
import { PLAN_CACHED_SHARE, type PlanTier, isPaidPlan } from "./plans.js";

/** What the meters need of `ctx.storage.sql`. */
export interface MeterSql {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): { toArray(): T[] };
}

/** Days of per-day and per-week rows kept: this week and the four before it. */
export const METER_KEEP_DAYS = 35;

export const METER_SCHEMA = [
  // Per model per week. `counted` is what plan limits are enforced on (quota.ts chargedTokens);
  // prompt (cached included), cached and output are the real tokens.
  `CREATE TABLE IF NOT EXISTS model_usage (
     week_start INTEGER NOT NULL,
     model      TEXT NOT NULL,
     counted    INTEGER NOT NULL DEFAULT 0,
     prompt     INTEGER NOT NULL DEFAULT 0,
     cached     INTEGER NOT NULL DEFAULT 0,
     output     INTEGER NOT NULL DEFAULT 0,
     requests   INTEGER NOT NULL DEFAULT 0,
     failovers  INTEGER NOT NULL DEFAULT 0,
     cost_usd   REAL NOT NULL DEFAULT 0,
     trial_counted INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (week_start, model)
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS model_usage_daily (
     day     INTEGER NOT NULL,
     model   TEXT NOT NULL,
     counted INTEGER NOT NULL DEFAULT 0,
     prompt  INTEGER NOT NULL DEFAULT 0,
     cached  INTEGER NOT NULL DEFAULT 0,
     output  INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (day, model)
   ) WITHOUT ROWID`,
  // Per tool per week: "autopilot", "claude-code", "opencode", "pi", "codex", or "tool:<name>" (tool-keys.ts).
  `CREATE TABLE IF NOT EXISTS tool_usage (
     week_start INTEGER NOT NULL,
     tool       TEXT NOT NULL,
     counted    INTEGER NOT NULL DEFAULT 0,
     real       INTEGER NOT NULL DEFAULT 0,
     requests   INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (week_start, tool)
   ) WITHOUT ROWID`,
  // The GPT-6 launch bonus's dollars per week (gpt6-bonus.ts), apart from every plan meter.
  `CREATE TABLE IF NOT EXISTS bonus_usage (
     week_start INTEGER PRIMARY KEY,
     usd        REAL NOT NULL DEFAULT 0
   )`,
  // Notices shown once per week (the 80% warning per model): claimed here so only one request shows it.
  `CREATE TABLE IF NOT EXISTS plan_notices (
     week_start INTEGER NOT NULL,
     key        TEXT NOT NULL,
     PRIMARY KEY (week_start, key)
   ) WITHOUT ROWID`,
];

/** One settled request, as the meters record it. */
export interface MeterRecord {
  model: string;
  counted: number;
  usage: Usage | undefined;
  costUsd: number;
  /** The client: "autopilot", a harness, or "tool:<name>". */
  tool: string;
  /** A backup provider or a fallback model served it. */
  failover: boolean;
  /** Paid from the GPT-6 launch bonus. */
  bonus: boolean;
  /** Held to a free trial (trials.ts): shown in the week's usage, never counted against the plan's weekly limit. */
  trial?: boolean;
  now: number;
}

/** Adds `model_usage.trial_counted` to meters made before trials (AccountObject's constructor). */
export function migrateMeters(sql: MeterSql): void {
  const columns = sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('model_usage')").toArray().map((column) => column.name);
  if (!columns.includes("trial_counted")) sql.exec("ALTER TABLE model_usage ADD COLUMN trial_counted INTEGER NOT NULL DEFAULT 0");
}

export function recordMeter(sql: MeterSql, record: MeterRecord): void {
  const week = weekStart(record.now);
  const day = dayStart(record.now);
  const prompt = record.usage?.promptTokens ?? 0;
  const cached = record.usage?.cachedTokens ?? 0;
  const output = record.usage?.completionTokens ?? 0;
  const counted = Math.max(0, Math.round(record.counted));
  sql.exec(
    `INSERT INTO model_usage (week_start, model, counted, prompt, cached, output, requests, failovers, cost_usd, trial_counted) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT (week_start, model) DO UPDATE SET counted = counted + excluded.counted, prompt = prompt + excluded.prompt, cached = cached + excluded.cached,
       output = output + excluded.output, requests = requests + 1, failovers = failovers + excluded.failovers, cost_usd = cost_usd + excluded.cost_usd,
       trial_counted = trial_counted + excluded.trial_counted`,
    week,
    record.model,
    counted,
    prompt,
    cached,
    output,
    record.failover ? 1 : 0,
    Math.max(0, record.costUsd),
    record.trial ? counted : 0,
  );
  sql.exec(
    `INSERT INTO model_usage_daily (day, model, counted, prompt, cached, output) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (day, model) DO UPDATE SET counted = counted + excluded.counted, prompt = prompt + excluded.prompt, cached = cached + excluded.cached, output = output + excluded.output`,
    day,
    record.model,
    counted,
    prompt,
    cached,
    output,
  );
  sql.exec(
    `INSERT INTO tool_usage (week_start, tool, counted, real, requests) VALUES (?, ?, ?, ?, 1)
     ON CONFLICT (week_start, tool) DO UPDATE SET counted = counted + excluded.counted, real = real + excluded.real, requests = requests + 1`,
    week,
    record.tool,
    counted,
    prompt + output,
  );
  if (record.bonus && record.costUsd > 0) {
    sql.exec("INSERT INTO bonus_usage (week_start, usd) VALUES (?, ?) ON CONFLICT (week_start) DO UPDATE SET usd = usd + excluded.usd", week, record.costUsd);
  }
}

/** Drops rows older than METER_KEEP_DAYS. */
export function pruneMeters(sql: MeterSql, now: number): void {
  const cutoff = dayStart(now) - METER_KEEP_DAYS * DAY_MS;
  const weekCutoff = weekStart(cutoff);
  sql.exec("DELETE FROM model_usage WHERE week_start < ?", weekCutoff);
  sql.exec("DELETE FROM model_usage_daily WHERE day < ?", cutoff);
  sql.exec("DELETE FROM tool_usage WHERE week_start < ?", weekCutoff);
  sql.exec("DELETE FROM bonus_usage WHERE week_start < ?", weekCutoff);
  sql.exec("DELETE FROM plan_notices WHERE week_start < ?", weekStart(now));
}

/** Counted tokens this week on one model, held to the plan's limit: a free trial's usage left out. */
export function countedThisWeek(sql: MeterSql, model: string, now: number): number {
  const row = sql.exec<{ counted: number; trial_counted: number }>("SELECT counted, trial_counted FROM model_usage WHERE week_start = ? AND model = ?", weekStart(now), model).toArray()[0];
  return row ? Math.max(0, row.counted - row.trial_counted) : 0;
}

/** The bonus dollars spent this week. */
export function bonusUsdThisWeek(sql: MeterSql, now: number): number {
  return sql.exec<{ usd: number }>("SELECT usd FROM bonus_usage WHERE week_start = ?", weekStart(now)).toArray()[0]?.usd ?? 0;
}

/**
 * Requests in flight on one model and what they are expected to count: each reservation's
 * realistic prompt at the person's cached share (`cachedShare`, or the plan mix's when unknown),
 * fresh input in full and cached input at `cachedTokenWeight`. Output isn't known yet; the
 * one-request overshoot this leaves is the same as the dollar caps'.
 */
export function inFlightOn(sql: MeterSql, model: string, cachedShare: number | undefined, cachedTokenWeight: number): { count: number; counted: number; usd: number } {
  const rows = sql.exec<{ prompt_estimate: number | null; cost_estimate: number | null }>("SELECT prompt_estimate, cost_estimate FROM reservations WHERE model = ?", model).toArray();
  const share = cachedShare ?? PLAN_CACHED_SHARE;
  let counted = 0;
  let usd = 0;
  for (const row of rows) {
    counted += expectedCounted(row.prompt_estimate ?? 0, share, cachedTokenWeight);
    usd += row.cost_estimate ?? 0;
  }
  return { count: rows.length, counted, usd };
}

/** What a request with this prompt estimate is expected to count, before output. */
export function expectedCounted(promptEstimate: number, cachedShare: number, cachedTokenWeight: number): number {
  const prompt = realisticPromptTokens(promptEstimate);
  const share = Math.min(1, Math.max(0, cachedShare));
  return Math.ceil(prompt * (1 - share) + prompt * share * Math.min(1, Math.max(0, cachedTokenWeight)));
}

/** Claims a once-a-week notice: true the first time for this week and key, false after. */
export function claimNotice(sql: MeterSql, key: string, now: number): boolean {
  const week = weekStart(now);
  const existing = sql.exec("SELECT 1 FROM plan_notices WHERE week_start = ? AND key = ?", week, key).toArray();
  if (existing.length > 0) return false;
  sql.exec("INSERT INTO plan_notices (week_start, key) VALUES (?, ?)", week, key);
  return true;
}

// ─── Plan state (meta) ───────────────────────────────────────────────────────

/** Meta keys the plan state lives under. */
export const META = {
  /** The paid plan a subscription is on ("starter", "plus", "max"); part A sets it from the Stripe price. */
  tier: "plan_tier",
  /** When the account was first seen paying (Unix ms): the bonus's wait counts from it. */
  paidSince: "plan_paid_since",
  /** "off" when the person turned the fallback to DeepSeek off. */
  fallback: "plan_fallback",
  /** When the account started dl.new's Free plan (Unix ms; free-plan.ts). */
  freePlan: "free_plan_since",
} as const;

export function readMeta(sql: MeterSql, key: string): string | undefined {
  return sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value;
}

export function writeMeta(sql: MeterSql, key: string, value: string | undefined): void {
  if (value === undefined) sql.exec("DELETE FROM meta WHERE key = ?", key);
  else sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
}

/**
 * The plan tier of an account whose subscription is `paying` (billing active, in its period):
 * the stored tier, else Starter (a subscription from before the three plans: dl Pro at $7, the
 * Starter price). "none" when not paying.
 */
export function tierOf(paying: boolean, stored: string | undefined): PlanTier {
  if (!paying) return "none";
  return isPaidPlan(stored) ? stored : "starter";
}

// ─── What the dashboard reads ────────────────────────────────────────────────

export interface MeterWeekRow {
  model: string;
  counted: number;
  prompt: number;
  cached: number;
  output: number;
  requests: number;
  failovers: number;
  costUsd: number;
  /** Of `counted`, what a free trial used (not held to the plan's limit). */
  trialCounted: number;
}

export interface MeterSnapshot {
  weekStart: number;
  models: MeterWeekRow[];
  /** Counted tokens per UTC day of this week, every model together, and per model. */
  days: Array<{ day: number; counted: number; real: number; byModel: Record<string, number> }>;
  tools: Array<{ tool: string; counted: number; real: number; requests: number }>;
  bonusUsd: number;
}

export function meterSnapshot(sql: MeterSql, now: number): MeterSnapshot {
  const week = weekStart(now);
  const models = sql
    .exec<{ model: string; counted: number; prompt: number; cached: number; output: number; requests: number; failovers: number; cost_usd: number; trial_counted: number }>(
      "SELECT model, counted, prompt, cached, output, requests, failovers, cost_usd, trial_counted FROM model_usage WHERE week_start = ? ORDER BY model",
      week,
    )
    .toArray()
    .map((row) => ({ model: row.model, counted: row.counted, prompt: row.prompt, cached: row.cached, output: row.output, requests: row.requests, failovers: row.failovers, costUsd: row.cost_usd, trialCounted: row.trial_counted ?? 0 }));
  const daily = sql
    .exec<{ day: number; model: string; counted: number; prompt: number; output: number }>("SELECT day, model, counted, prompt, output FROM model_usage_daily WHERE day >= ? ORDER BY day", week)
    .toArray();
  const days: MeterSnapshot["days"] = [];
  for (let day = week; day < week + 7 * DAY_MS && day <= now; day += DAY_MS) {
    const rows = daily.filter((row) => row.day === day);
    days.push({
      day,
      counted: rows.reduce((sum, row) => sum + row.counted, 0),
      real: rows.reduce((sum, row) => sum + row.prompt + row.output, 0),
      byModel: Object.fromEntries(rows.map((row) => [row.model, row.counted])),
    });
  }
  const tools = sql
    .exec<{ tool: string; counted: number; real: number; requests: number }>("SELECT tool, counted, real, requests FROM tool_usage WHERE week_start = ? ORDER BY counted DESC", week)
    .toArray()
    .map((row) => ({ tool: row.tool, counted: row.counted, real: row.real, requests: row.requests }));
  return { weekStart: week, models, days, tools, bonusUsd: bonusUsdThisWeek(sql, now) };
}
