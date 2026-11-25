/**
 * dl.new's free trials (owner decisions, 25 Nov 2026). Two kinds, both served DeepSeek V4.1 Flash
 * only. Sizes are REAL tokens with caching applied, like the plan cards ("20M tokens (95.5%
 * caching applied)"), enforced in COUNTED tokens (quota.ts chargedTokens) converted with the
 * plans' factor (plans.ts countedLimit: 20M real = 1,282,000 counted at cachedTokenWeight 0.02):
 *
 *   card    every plan's Checkout adds a card and pays $0 now (Stripe `trial_period_days`). The
 *           first `cardTrialTokens` (20M real) are free. The plan starts (Stripe ends
 *           the trial and makes the first real charge) when the account has used them, or after
 *           `cardTrialDays` (30), whichever comes first. The launch offer's coupon goes on that
 *           first real charge, never on the $0 trial invoice. Kimi and the GPT-6 bonus start
 *           when the plan starts.
 *   nocard  `noCardTrialTokens` (10M real) without a card or plan, after a GitHub
 *           sign-in that passes the free tier's account checks. One per GitHub account and per
 *           verified email, one time (no weekly reset, no expiry).
 *
 * Two global budgets (`trialBudgetUsd` 300 for card trials, `noCardTrialBudgetUsd` 200): what
 * trials have actually cost (DeepSeek's cost of their usage) plus the projected rest of every
 * active trial. A new trial is given only while one more full trial still fits; past that,
 * /web/plans says "Free trial: fully claimed" and new sign-ups don't get that trial.
 *
 * Pure functions and the SQL both Durable Objects keep: the Directory's `trials` table (every
 * trial, for the budgets, the one-per-person rules and the admin view) and the Account object's
 * `trial` row (the meter a request is held to).
 */

import { approxTokens, countedFactor, countedLimit, PLAN_MIX } from "./plans.js";
import { DAY_MS } from "./week.js";

export type TrialKind = "card" | "nocard";
/** How the API names them (`trials.card`, `trials.noCard`, `trial.kind`). */
export type TrialKindName = "card" | "no_card";

export function trialKindName(kind: TrialKind): TrialKindName {
  return kind === "card" ? "card" : "no_card";
}

export type TrialSettingsConfig = {
  /** Card trials on every plan's Checkout (default on). */
  cardTrial: boolean;
  /** Real tokens (95.5% caching applied) a card trial includes (default 20M; enforced as counted). */
  cardTrialTokens: number;
  /** Days before the plan starts anyway (default 30; Stripe's `trial_period_days`). */
  cardTrialDays: number;
  /** Card trials' global budget, USD (default 300). */
  trialBudgetUsd: number;
  /** No-card trials after a GitHub sign-in (default on). */
  noCardTrial: boolean;
  /** Real tokens (95.5% caching applied) a no-card trial includes (default 10M; enforced as counted). */
  noCardTrialTokens: number;
  /** No-card trials' global budget, USD (default 200). */
  noCardTrialBudgetUsd: number;
  /**
   * What a counted token costs us, USD per million, for the projection until trials have used
   * enough to measure it (TRIAL_MEASURED_FROM). Default 0.30: the measured $0.019 per million
   * real DeepSeek tokens at the plan mix (95.5% cached), over 0.0641 counted per real.
   */
  trialUsdPerMillionCounted: number;
};

export const TRIAL_DEFAULTS: TrialSettingsConfig = {
  cardTrial: true,
  cardTrialTokens: 20_000_000,
  cardTrialDays: 30,
  trialBudgetUsd: 300,
  noCardTrial: true,
  noCardTrialTokens: 10_000_000,
  noCardTrialBudgetUsd: 200,
  trialUsdPerMillionCounted: 0.3,
};

/** Every trial setting with its env var. */
export const TRIAL_SETTING_ENV: Readonly<Record<keyof TrialSettingsConfig, string>> = {
  cardTrial: "CARD_TRIAL",
  cardTrialTokens: "CARD_TRIAL_TOKENS",
  cardTrialDays: "CARD_TRIAL_DAYS",
  trialBudgetUsd: "TRIAL_BUDGET_USD",
  noCardTrial: "NO_CARD_TRIAL",
  noCardTrialTokens: "NO_CARD_TRIAL_TOKENS",
  noCardTrialBudgetUsd: "NO_CARD_TRIAL_BUDGET_USD",
  trialUsdPerMillionCounted: "TRIAL_USD_PER_MILLION_COUNTED",
};

/** Stripe's limit on `trial_period_days` is 730; ours is far below it. */
export const MAX_TRIAL_DAYS = 90;
/** Trials' counted tokens from which their own measured cost replaces `trialUsdPerMillionCounted`. */
export const TRIAL_MEASURED_FROM = 20_000_000;
/** A no-card trial unused this long no longer counts as active in the projection (it has no expiry). */
export const NO_CARD_IDLE_MS = 30 * DAY_MS;
/** The share of a trial that sends the 80% notice (and, for a card trial, the email). */
export const TRIAL_WARN_SHARE = 0.8;

/** A trial's size in real tokens at the plan mix (what users are shown). */
export function trialTokensOf(kind: TrialKind, config: TrialSettingsConfig): number {
  return kind === "card" ? config.cardTrialTokens : config.noCardTrialTokens;
}

/** A trial's size as the counted tokens it is enforced at (the plans' factor). */
export function trialCountedLimit(kind: TrialKind, config: TrialSettingsConfig & { cachedTokenWeight: number }): number {
  return countedLimit(trialTokensOf(kind, config), config.cachedTokenWeight);
}

export function trialBudgetOf(kind: TrialKind, config: TrialSettingsConfig): number {
  return kind === "card" ? config.trialBudgetUsd : config.noCardTrialBudgetUsd;
}

export function trialOn(kind: TrialKind, config: TrialSettingsConfig): boolean {
  return (kind === "card" ? config.cardTrial : config.noCardTrial) && trialTokensOf(kind, config) > 0;
}

// ─── Copy (owner: "be clear, these are engineers") ───────────────────────────

/** Counted tokens as the copy writes them: "20M", "10M", "16.2M", "850K" (no tilde: they are exact). */
export function countedText(tokens: number): string {
  return approxTokens(tokens).replace(/^~/, "");
}

/** The cached-input weight as copy writes it: 0.02 → "2%". */
export function weightText(cachedTokenWeight: number): string {
  const pct = Math.round(Math.min(1, Math.max(0, cachedTokenWeight)) * 1000) / 10;
  return `${pct}%`;
}

/** Real tokens (sent and received) a counted amount stands for at the plan mix (95.5% cached). */
export function realAtMix(counted: number, cachedTokenWeight: number): number {
  return Math.round(Math.max(0, counted) / countedFactor(cachedTokenWeight));
}

const CACHE_RATE = `${Math.round(PLAN_MIX.cached * 1000) / 10}%`;

/** Counted tokens as real tokens at the plan mix, scaled to a trial: used of the real size. */
export function realShare(counted: number, countedLimitTokens: number, realLimit: number): number {
  return countedLimitTokens > 0 ? Math.round((Math.max(0, counted) / countedLimitTokens) * realLimit) : 0;
}

const CACHING = `(${CACHE_RATE} caching applied)`;

/** The plan card's line: "First 20M tokens free (95.5% caching applied). Card required; your plan starts when you've used them or after 30 days." */
export function cardTrialLine(config: TrialSettingsConfig): string {
  return `First ${countedText(config.cardTrialTokens)} tokens free ${CACHING}. Card required; your plan starts when you've used them or after ${config.cardTrialDays} days.`;
}

/** The plan step's secondary option: "No card? Get 10M tokens free (95.5% caching applied). Sign in with GitHub." */
export function noCardTrialLine(config: TrialSettingsConfig): string {
  return `No card? Get ${countedText(config.noCardTrialTokens)} tokens free ${CACHING}. Sign in with GitHub.`;
}

/** What the plan page shows instead of a trial with no room left. */
export const TRIAL_FULLY_CLAIMED = "Free trial: fully claimed";

/** The no-card trial used up (402 trial_used_up): "Your 10M free tokens are used up. Pick a plan at dl.new to keep going." (`realTokens`: its size as shown) */
export function noCardUsedUpMessage(realTokens: number): string {
  return `Your ${countedText(realTokens)} free tokens are used up. Pick a plan at dl.new to keep going.`;
}

/** A card trial's model the plan includes, asked for during the trial: "Kimi K3.1 starts when your plan starts. Now using DeepSeek V4.1 Flash." */
export function startsWithPlanNotice(name: string): string {
  return `${name} starts when your plan starts. Now using DeepSeek V4.1 Flash.`;
}

/** Any other model during a trial: "GLM 5.3 Flash isn't in the free trial. Now using DeepSeek V4.1 Flash." */
export function notInTrialNotice(name: string): string {
  return `${name} isn't in the free trial. Now using DeepSeek V4.1 Flash.`;
}

/**
 * The 80% notice in the tool, once per trial, in real tokens at 95.5% caching.
 * Card: "Free trial: 81% used (~16.2M of 20M at 95.5% caching). Your Starter plan starts at 20M, ~3.8M left."
 * No card: "Free trial: 81% used (~8.1M of 10M at 95.5% caching), ~1.9M left. Pick a plan at dl.new to keep going."
 */
export function trialWarningNotice(input: { kind: TrialKind; counted: number; limit: number; realLimit: number; planName?: string }): string {
  const share = Math.min(99, Math.max(80, Math.floor((input.counted / Math.max(1, input.limit)) * 100)));
  const usedReal = realShare(input.counted, input.limit, input.realLimit);
  const used = `${share}% used (${approxTokens(usedReal)} of ${countedText(input.realLimit)} at 95.5% caching)`;
  const left = approxTokens(Math.max(0, input.realLimit - usedReal));
  if (input.kind === "card") return `Free trial: ${used}. Your ${input.planName ? `${input.planName} ` : ""}plan starts at ${countedText(input.realLimit)}, ${left} left.`;
  return `Free trial: ${used}, ${left} left. Pick a plan at dl.new to keep going.`;
}

/** The card trial used up while the plan's first payment didn't go through (402 trial_payment_failed). */
export const TRIAL_PAYMENT_FAILED_MESSAGE = "Your free trial tokens are used up and the first payment for your plan didn't go through. Update your card at dl.new/billing to keep going.";
/** The card trial used up and the plan is starting this moment (Stripe didn't answer): try again shortly. */
export const TRIAL_CONVERTING_MESSAGE = "Your free trial tokens are used up and your plan is starting now. Try again in a minute.";

/** "1 Dec": a day as the emails write it, in UTC. */
export function dayText(at: number): string {
  const date = new Date(at);
  return `${date.getUTCDate()} ${["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"][date.getUTCMonth()]}`;
}

// ─── The budgets (the Directory's `trials` table) ────────────────────────────

/** What the trial helpers need of Durable Object SQL storage. */
export interface TrialSql {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): { toArray(): T[] };
}

export const TRIAL_SCHEMA = [
  // Every trial given. Card trials are keyed by their Stripe subscription (the account is set
  // when the Checkout is claimed); no-card trials by `nocard:<GitHub id>`.
  `CREATE TABLE IF NOT EXISTS trials (
     id            TEXT PRIMARY KEY,
     kind          TEXT NOT NULL,
     account       INTEGER,
     github_id     INTEGER,
     email_norm    TEXT,
     plan          TEXT,
     limit_counted INTEGER NOT NULL,
     counted       INTEGER NOT NULL DEFAULT 0,
     cost_usd      REAL NOT NULL DEFAULT 0,
     started_at    INTEGER NOT NULL,
     ends_at       INTEGER,
     last_used_at  INTEGER,
     ended_at      INTEGER,
     end_reason    TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS trials_account ON trials (account)`,
  // One no-card trial per GitHub account and per verified email.
  `CREATE UNIQUE INDEX IF NOT EXISTS trials_nocard_github ON trials (github_id) WHERE kind = 'nocard'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS trials_nocard_email ON trials (email_norm) WHERE kind = 'nocard'`,
];

export interface TrialRow {
  id: string;
  kind: TrialKind;
  account: number | null;
  github_id: number | null;
  email_norm: string | null;
  plan: string | null;
  limit_counted: number;
  counted: number;
  cost_usd: number;
  started_at: number;
  ends_at: number | null;
  last_used_at: number | null;
  ended_at: number | null;
  end_reason: string | null;
}

/** Why a trial ended. */
export type TrialEndReason = "used" | "expired" | "canceled" | "plan";

/** A trial that still counts in the projection: not ended, a card trial before its end, a no-card trial used (or started) in the last 30 days. */
function activeWhere(now: number): { clause: string; bindings: unknown[] } {
  return {
    clause: "ended_at IS NULL AND ((kind = 'card' AND (ends_at IS NULL OR ends_at > ?)) OR (kind = 'nocard' AND COALESCE(last_used_at, started_at) > ?))",
    bindings: [now, now - NO_CARD_IDLE_MS],
  };
}

export interface TrialBudgetView {
  kind: TrialKindName;
  /** The setting's on/off. */
  enabled: boolean;
  budgetUsd: number;
  /** What every trial of this kind has cost so far (DeepSeek's cost of the usage). */
  spentUsd: number;
  /** The rest of every active trial, at `usdPerMillionCounted`. */
  projectedUsd: number;
  /** One more full trial. */
  nextTrialUsd: number;
  usdPerMillionCounted: number;
  /** Whether the cost rate is measured from trials' own usage (else the setting). */
  measured: boolean;
  trials: number;
  active: number;
  /** No room for one more full trial (shown as "Free trial: fully claimed"). */
  fullyClaimed: boolean;
  /** On and not fully claimed: new sign-ups get it. */
  available: boolean;
}

/** One kind's budget now: spent + projected, and whether a new trial still fits. */
export function trialBudgetStatus(sql: TrialSql, kind: TrialKind, config: TrialSettingsConfig & { cachedTokenWeight: number }, now: number): TrialBudgetView {
  const totals = sql.exec<{ n: number; counted: number; cost: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(counted), 0) AS counted, COALESCE(SUM(cost_usd), 0) AS cost FROM trials WHERE kind = ?", kind).toArray()[0] ?? { n: 0, counted: 0, cost: 0 };
  const active = activeWhere(now);
  const open = sql
    .exec<{ n: number; left: number }>(`SELECT COUNT(*) AS n, COALESCE(SUM(MAX(0, limit_counted - counted)), 0) AS left FROM trials WHERE kind = ? AND ${active.clause}`, kind, ...active.bindings)
    .toArray()[0] ?? { n: 0, left: 0 };
  const measured = totals.counted >= TRIAL_MEASURED_FROM;
  const rate = measured ? (totals.cost / totals.counted) * 1_000_000 : Math.max(0, config.trialUsdPerMillionCounted);
  const projected = (open.left / 1_000_000) * rate;
  const next = (trialCountedLimit(kind, config) / 1_000_000) * rate;
  const budget = trialBudgetOf(kind, config);
  const fullyClaimed = totals.cost + projected + next > budget;
  const enabled = trialOn(kind, config);
  return {
    kind: trialKindName(kind),
    enabled,
    budgetUsd: budget,
    spentUsd: round2(totals.cost),
    projectedUsd: round2(projected),
    nextTrialUsd: round2(next),
    usdPerMillionCounted: Math.round(rate * 10_000) / 10_000,
    measured,
    trials: totals.n,
    active: open.n,
    fullyClaimed,
    available: enabled && !fullyClaimed,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A card trial Stripe started (checkout.session.completed or the claim): recorded once per subscription. */
export function recordCardTrial(sql: TrialSql, input: { subscriptionId: string; plan: string; limit: number; startedAt: number; endsAt: number | null; account?: number }): void {
  sql.exec(
    `INSERT INTO trials (id, kind, account, plan, limit_counted, started_at, ends_at) VALUES (?, 'card', ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET account = COALESCE(trials.account, excluded.account), plan = excluded.plan, ends_at = COALESCE(excluded.ends_at, trials.ends_at)`,
    input.subscriptionId,
    input.account ?? null,
    input.plan,
    input.limit,
    input.startedAt,
    input.endsAt,
  );
}

/** Whether an account already had a card trial on another subscription than `subscriptionId`. */
export function hadOtherCardTrial(sql: TrialSql, account: number, subscriptionId: string): boolean {
  return sql.exec("SELECT 1 FROM trials WHERE kind = 'card' AND account = ? AND id != ? LIMIT 1", account, subscriptionId).toArray().length > 0;
}

/** Why a no-card trial is refused at the Directory. */
export type NoCardRefusal = "github_used" | "email_used" | "fully_claimed" | "off";

/**
 * Takes a no-card trial for a GitHub id and verified email, if neither had one and one more fits
 * the budget. Run inside the Directory's transaction with the account's creation.
 */
export function takeNoCardTrial(sql: TrialSql, input: { githubId: number; emailNorm: string; config: TrialSettingsConfig & { cachedTokenWeight: number }; now: number }): { ok: true; limit: number } | { ok: false; reason: NoCardRefusal } {
  if (sql.exec("SELECT 1 FROM trials WHERE kind = 'nocard' AND github_id = ?", input.githubId).toArray().length > 0) return { ok: false, reason: "github_used" };
  if (sql.exec("SELECT 1 FROM trials WHERE kind = 'nocard' AND email_norm = ?", input.emailNorm).toArray().length > 0) return { ok: false, reason: "email_used" };
  const status = trialBudgetStatus(sql, "nocard", input.config, input.now);
  if (!status.enabled) return { ok: false, reason: "off" };
  if (status.fullyClaimed) return { ok: false, reason: "fully_claimed" };
  return { ok: true, limit: trialCountedLimit("nocard", input.config) };
}

export function insertNoCardTrial(sql: TrialSql, input: { account: number; githubId: number; emailNorm: string; limit: number; now: number }): void {
  sql.exec(
    "INSERT INTO trials (id, kind, account, github_id, email_norm, limit_counted, started_at) VALUES (?, 'nocard', ?, ?, ?, ?, ?)",
    `nocard:${input.githubId}`,
    input.account,
    input.githubId,
    input.emailNorm,
    input.limit,
    input.now,
  );
}

/** A trial request's usage, from the request log (DirectoryObject.recordRequest): counted tokens and DeepSeek's cost. */
export function noteTrialUsage(sql: TrialSql, input: { account: number; kind: TrialKind; counted: number; costUsd: number; at: number }): void {
  sql.exec(
    `UPDATE trials SET counted = counted + ?, cost_usd = cost_usd + ?, last_used_at = ?
     WHERE id = (SELECT id FROM trials WHERE account = ? AND kind = ? ORDER BY ended_at IS NULL DESC, started_at DESC LIMIT 1)`,
    Math.max(0, Math.round(input.counted)),
    Math.max(0, input.costUsd),
    input.at,
    input.account,
    input.kind,
  );
}

/** Ends an account's open trial of a kind (or a card trial by its subscription). */
export function endTrialRow(sql: TrialSql, input: { account?: number; subscriptionId?: string; kind: TrialKind; reason: TrialEndReason; at: number }): void {
  if (input.subscriptionId) {
    sql.exec("UPDATE trials SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL", input.at, input.reason, input.subscriptionId);
    return;
  }
  sql.exec("UPDATE trials SET ended_at = ?, end_reason = ? WHERE account = ? AND kind = ? AND ended_at IS NULL", input.at, input.reason, input.account ?? -1, input.kind);
}

/** The admin view: both budgets and the latest trials. */
export function trialsAdminView(sql: TrialSql, config: TrialSettingsConfig & { cachedTokenWeight: number }, now: number, limit = 100) {
  const rows = sql.exec<TrialRow>("SELECT * FROM trials ORDER BY started_at DESC LIMIT ?", limit).toArray();
  return {
    budgets: { card: trialBudgetStatus(sql, "card", config, now), noCard: trialBudgetStatus(sql, "nocard", config, now) },
    trials: rows.map((row) => ({
      id: row.id,
      kind: trialKindName(row.kind),
      account: row.account,
      plan: row.plan,
      limitCounted: row.limit_counted,
      counted: row.counted,
      costUsd: round2(row.cost_usd),
      startedAt: new Date(row.started_at).toISOString(),
      endsAt: row.ends_at === null ? null : new Date(row.ends_at).toISOString(),
      lastUsedAt: row.last_used_at === null ? null : new Date(row.last_used_at).toISOString(),
      endedAt: row.ended_at === null ? null : new Date(row.ended_at).toISOString(),
      endReason: row.end_reason,
    })),
  };
}

// ─── The meter (the Account object's `trial` row) ────────────────────────────

export const ACCOUNT_TRIAL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS trial (
     k               INTEGER PRIMARY KEY CHECK (k = 1),
     kind            TEXT NOT NULL,
     plan            TEXT,
     subscription_id TEXT,
     limit_counted   INTEGER NOT NULL,
     real_limit      INTEGER NOT NULL DEFAULT 0,
     counted         INTEGER NOT NULL DEFAULT 0,
     prompt          INTEGER NOT NULL DEFAULT 0,
     cached          INTEGER NOT NULL DEFAULT 0,
     output          INTEGER NOT NULL DEFAULT 0,
     cost_usd        REAL NOT NULL DEFAULT 0,
     started_at      INTEGER NOT NULL,
     ends_at         INTEGER,
     ended_at        INTEGER,
     end_reason      TEXT,
     promo_coupon    TEXT,
     warned          INTEGER NOT NULL DEFAULT 0,
     converting_at   INTEGER,
     declined_at     INTEGER
   )`,
];

interface AccountTrialRow {
  kind: TrialKind;
  plan: string | null;
  subscription_id: string | null;
  limit_counted: number;
  real_limit: number;
  counted: number;
  prompt: number;
  cached: number;
  output: number;
  cost_usd: number;
  started_at: number;
  ends_at: number | null;
  ended_at: number | null;
  end_reason: string | null;
  promo_coupon: string | null;
  warned: number;
  converting_at: number | null;
  declined_at: number | null;
}

/** An account's trial as requests and pages see it. */
export interface TrialMeter {
  kind: TrialKind;
  /** The card trial's plan (it starts after the trial). */
  plan: string | null;
  subscriptionId: string | null;
  /** Counted tokens the trial is enforced at. */
  limit: number;
  /** The trial's size as shown: real tokens at 95.5% caching (20M, 10M). */
  realLimit: number;
  counted: number;
  /** Real tokens processed in the trial: prompt (cached included) and output. */
  realTokens: number;
  cachedInput: number;
  freshInput: number;
  output: number;
  costUsd: number;
  startedAt: number;
  /** A card trial's end (Stripe's trial_end): the plan starts then at the latest. */
  endsAt: number | null;
  endedAt: number | null;
  endReason: string | null;
  /** The launch offer's coupon recorded at Checkout, for the first real charge. */
  promoCoupon: string | null;
  /** When Stripe last declined the first real charge (Unix ms), or null. */
  declinedAt: number | null;
  /** Not ended, and a card trial before its end. */
  active: boolean;
  /** At or past its limit. */
  usedUp: boolean;
}

export function readAccountTrial(sql: TrialSql, now: number): TrialMeter | null {
  const row = sql.exec<AccountTrialRow>("SELECT * FROM trial WHERE k = 1").toArray()[0];
  if (!row) return null;
  const active = row.ended_at === null && (row.kind !== "card" || row.ends_at === null || now < row.ends_at);
  return {
    kind: row.kind,
    plan: row.plan,
    subscriptionId: row.subscription_id,
    limit: row.limit_counted,
    realLimit: row.real_limit,
    counted: row.counted,
    realTokens: row.prompt + row.output,
    cachedInput: row.cached,
    freshInput: Math.max(0, row.prompt - row.cached),
    output: row.output,
    costUsd: row.cost_usd,
    startedAt: row.started_at,
    endsAt: row.ends_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
    promoCoupon: row.promo_coupon,
    declinedAt: row.declined_at,
    active,
    usedUp: row.counted >= row.limit_counted,
  };
}

/**
 * Starts (or refreshes) the account's trial. The same card subscription keeps its counters; a new
 * kind or subscription replaces an ended trial or a no-card one (someone who used the no-card
 * trial and then picks a plan). An open card trial is never replaced by a no-card one.
 */
export function startAccountTrial(sql: TrialSql, input: { kind: TrialKind; limit: number; realLimit: number; startedAt: number; endsAt: number | null; plan?: string | null; subscriptionId?: string | null; promoCoupon?: string | null }): boolean {
  const row = sql.exec<AccountTrialRow>("SELECT * FROM trial WHERE k = 1").toArray()[0];
  if (row && input.kind === "card" && row.kind === "card" && row.subscription_id === (input.subscriptionId ?? null)) {
    sql.exec("UPDATE trial SET plan = COALESCE(?, plan), ends_at = COALESCE(?, ends_at), promo_coupon = COALESCE(?, promo_coupon) WHERE k = 1", input.plan ?? null, input.endsAt, input.promoCoupon ?? null);
    return false;
  }
  if (row && row.ended_at === null && row.kind === "card" && input.kind === "nocard") return false;
  if (row && row.ended_at === null && row.kind === "nocard" && input.kind === "nocard") return false;
  sql.exec("DELETE FROM trial WHERE k = 1");
  sql.exec(
    "INSERT INTO trial (k, kind, plan, subscription_id, limit_counted, real_limit, started_at, ends_at, promo_coupon) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)",
    input.kind,
    input.plan ?? null,
    input.subscriptionId ?? null,
    input.limit,
    input.realLimit,
    input.startedAt,
    input.endsAt,
    input.promoCoupon ?? null,
  );
  return true;
}

/** Adds one settled trial request to the meter. */
export function addTrialUsage(sql: TrialSql, input: { counted: number; prompt: number; cached: number; output: number; costUsd: number }): void {
  sql.exec(
    "UPDATE trial SET counted = counted + ?, prompt = prompt + ?, cached = cached + ?, output = output + ?, cost_usd = cost_usd + ? WHERE k = 1 AND ended_at IS NULL",
    Math.max(0, Math.round(input.counted)),
    Math.max(0, input.prompt),
    Math.max(0, input.cached),
    Math.max(0, input.output),
    Math.max(0, input.costUsd),
  );
}

/** Ends the open trial; true when this call ended it (the conversion email goes out once). */
export function endAccountTrial(sql: TrialSql, input: { reason: TrialEndReason; at: number; subscriptionId?: string }): boolean {
  const row = sql.exec<AccountTrialRow>("SELECT * FROM trial WHERE k = 1").toArray()[0];
  if (!row || row.ended_at !== null) return false;
  if (input.subscriptionId && row.subscription_id !== null && row.subscription_id !== input.subscriptionId) return false;
  sql.exec("UPDATE trial SET ended_at = ?, end_reason = ?, converting_at = NULL WHERE k = 1", input.at, input.reason);
  return true;
}

/** Claims the 80% notice, once per trial. */
export function claimTrialWarning(sql: TrialSql): boolean {
  const row = sql.exec<{ warned: number }>("SELECT warned FROM trial WHERE k = 1").toArray()[0];
  if (!row || row.warned === 1) return false;
  sql.exec("UPDATE trial SET warned = 1 WHERE k = 1");
  return true;
}

/** How long one conversion attempt holds the others off (Stripe answers in seconds). */
export const CONVERSION_HOLD_MS = 60_000;

/** Claims the card trial's conversion (ending it in Stripe) for one caller at a time. */
export function claimTrialConversion(sql: TrialSql, now: number): boolean {
  const row = sql.exec<{ ended_at: number | null; converting_at: number | null; kind: string }>("SELECT ended_at, converting_at, kind FROM trial WHERE k = 1").toArray()[0];
  if (!row || row.kind !== "card" || row.ended_at !== null) return false;
  if (row.converting_at !== null && now - row.converting_at < CONVERSION_HOLD_MS) return false;
  sql.exec("UPDATE trial SET converting_at = ? WHERE k = 1", now);
  return true;
}

export function releaseTrialConversion(sql: TrialSql, declinedAt?: number): void {
  if (declinedAt !== undefined) sql.exec("UPDATE trial SET converting_at = NULL, declined_at = ? WHERE k = 1", declinedAt);
  else sql.exec("UPDATE trial SET converting_at = NULL WHERE k = 1");
}

/** After a declined first charge, Stripe isn't asked again for this long (the card has to change first). */
export const DECLINE_HOLD_MS = 10 * 60_000;

/** Whether the first real charge was declined recently (requests are refused without calling Stripe). */
export function declinedRecently(trial: Pick<TrialMeter, "declinedAt">, now: number): boolean {
  return trial.declinedAt !== null && now - trial.declinedAt < DECLINE_HOLD_MS;
}

/** Whether a conversion is under way (claimed less than CONVERSION_HOLD_MS ago). */
export function trialConverting(sql: TrialSql, now: number): boolean {
  const row = sql.exec<{ converting_at: number | null }>("SELECT converting_at FROM trial WHERE k = 1").toArray()[0];
  return row?.converting_at != null && now - row.converting_at < CONVERSION_HOLD_MS;
}

// ─── What the pages show ─────────────────────────────────────────────────────

/** `/web/account` `trial` and `/web/usage` `trial` (docs/web-api-paid.md): the meter, or null without a trial to show. */
export function trialView(trial: TrialMeter | null, config: { cachedTokenWeight: number }, now: number) {
  if (!trial) return null;
  // A card trial that ended is the plan now: nothing to show. A used no-card trial stays, so the page can say so.
  if (trial.kind === "card" && !trial.active) return null;
  // A no-card trial ended by a plan: nothing to show either.
  if (!trial.active && trial.endReason === "plan") return null;
  const status = trial.active ? (trial.usedUp ? "used_up" : "active") : trial.endReason === "used" || trial.usedUp ? "used_up" : "ended";
  const left = Math.max(0, trial.limit - trial.counted);
  const prompt = trial.cachedInput + trial.freshInput;
  const usedAtMix = realShare(trial.counted, trial.limit, trial.realLimit);
  return {
    kind: trialKindName(trial.kind),
    status,
    plan: trial.plan,
    countedLimit: trial.limit,
    countedUsed: trial.counted,
    countedLeft: left,
    percent: trial.limit > 0 ? Math.min(100, Math.floor((trial.counted / trial.limit) * 100)) : 100,
    state: trial.counted >= trial.limit ? "used_up" : trial.counted >= trial.limit * TRIAL_WARN_SHARE ? "warning" : "ok",
    /** Real tokens sent and received so far in the trial. */
    realUsed: trial.realTokens,
    cachedInput: trial.cachedInput,
    freshInput: trial.freshInput,
    output: trial.output,
    /** The person's own caching share in the trial, or null before any usage. */
    cachingShare: prompt > 0 ? Math.round((trial.cachedInput / prompt) * 1000) / 1000 : null,
    /** The trial's size as shown: real tokens with 95.5% caching applied (20M). */
    tokens: trial.realLimit,
    /** The bar: counted used as real tokens at 95.5% caching ("~4.1M of 20M"). */
    usedAtMix,
    /** What is left as real tokens at 95.5% caching. */
    leftAtMix: Math.max(0, trial.realLimit - usedAtMix),
    startedAt: new Date(trial.startedAt).toISOString(),
    /** A card trial: the plan starts then at the latest. */
    endsAt: trial.endsAt === null ? null : new Date(trial.endsAt).toISOString(),
    daysLeft: trial.endsAt === null ? null : Math.max(0, Math.ceil((trial.endsAt - now) / DAY_MS)),
    line:
      trial.kind === "card"
        ? `Free trial: ${approxTokens(usedAtMix)} of ${countedText(trial.realLimit)} tokens used ${CACHING}. Your plan starts when you've used them${trial.endsAt === null ? "" : ` or on ${dayText(trial.endsAt)}`}, whichever comes first.`
        : status === "used_up"
          ? noCardUsedUpMessage(trial.realLimit)
          : `Free trial: ${approxTokens(usedAtMix)} of ${countedText(trial.realLimit)} tokens used ${CACHING}. One time, no card. Pick a plan at dl.new when you want more.`,
  };
}

/** `/web/plans` `trials`: what the plan step offers right now. */
export function trialsOffer(config: TrialSettingsConfig & { cachedTokenWeight: number }, budgets: { card: { available: boolean; fullyClaimed: boolean; enabled: boolean }; noCard: { available: boolean; fullyClaimed: boolean; enabled: boolean } }) {
  return {
    card: {
      enabled: budgets.card.enabled,
      available: budgets.card.available,
      fullyClaimed: budgets.card.enabled && budgets.card.fullyClaimed,
      tokens: config.cardTrialTokens,
      countedTokens: trialCountedLimit("card", config),
      days: config.cardTrialDays,
      line: cardTrialLine(config),
      fullyClaimedText: TRIAL_FULLY_CLAIMED,
    },
    noCard: {
      enabled: budgets.noCard.enabled,
      available: budgets.noCard.available,
      fullyClaimed: budgets.noCard.enabled && budgets.noCard.fullyClaimed,
      tokens: config.noCardTrialTokens,
      countedTokens: trialCountedLimit("nocard", config),
      line: noCardTrialLine(config),
      fullyClaimedText: TRIAL_FULLY_CLAIMED,
    },
    label: CACHING,
  };
}
