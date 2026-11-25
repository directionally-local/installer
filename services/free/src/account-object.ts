import { DurableObject, type DurableObjectNamespace, type DurableObjectState } from "cloudflare:workers";
import { randomToken, sha256Hex, timingSafeEqual } from "../../shared/src/auth.js";
import type { DirectoryObject } from "./directory-object.js";
import { DEFAULT_MODEL, FAMILIES, POOLS, POOL_TOKENS, creditPrices, familyOfPool, modelById, type Family, type Pool } from "./models.js";
import type { Upstream } from "./config.js";
import type { Level } from "./admission.js";
import {
  DEEPSEEK_MAX_OUTPUT_TOKENS,
  FALLBACK_USD_PER_MILLION_TOKENS,
  MAX_OUTPUT_TOKENS,
  MIN_OUTPUT_TOKENS,
  MIN_PROMPT_TOKENS_FOR_CACHED_SHARE,
  chargedTokens,
  costAtPrices,
  costAtPricesOrFallback,
  estimateCostUsd,
  estimatedUsage,
  planReservation,
  realisticPromptTokens,
  type TokenPrices,
  type Usage,
} from "./quota.js";
import { weekEnd, weekStart } from "./week.js";
import { META, METER_SCHEMA, bonusUsdThisWeek, claimNotice, countedThisWeek, expectedCounted, inFlightOn, meterSnapshot, pruneMeters, readMeta, recordMeter, tierOf, writeMeta, type MeterSnapshot } from "./plan-meter.js";
import { isPaidPlan, type PlanTier } from "./plans.js";

/**
 * One person's allowance: `getByName("gh:<githubId>")`. The single serialization point for
 * reserve and settle, so two concurrent requests can't both spend the last tokens. The week
 * rolls over lazily on the first call after Monday 00:00 UTC; no timer is needed for that.
 * The alarm only settles reservations whose request never came back (a crash or a dropped
 * connection), charging the person nothing (see sweep).
 */

/** A request that ended without usage (AccountObject.settle): what it was charged as, if anything, and its realistic prompt alone. */
export interface NoUsageEstimate {
  /** The estimate charged; undefined when no output was streamed (nothing charged). */
  usage: Usage | undefined;
  /** The realistic prompt with the person's cached share and no output: the provider credit's estimate for a request cancelled before output. */
  prompt: Usage;
}

export const RESERVATION_TTL_MS = 30 * 60_000;
/** Pro stays on this long past the paid period's end, so a renewal webhook that runs late doesn't cut anyone off. */
export const PRO_GRACE_MS = 3 * 86_400_000;
/** Server keys per account. */
export const MAX_SERVER_KEYS = 5;
/**
 * What a `dlk_` key is for. "server": dl's server mode (Autopilot on a server; by grant, see
 * app.ts serverKeysAllowed). "tool": an API key the person pastes into any OpenAI- or
 * Anthropic-compatible tool (Cursor, Cline, Zed, Aider…), for any account in good standing;
 * served like another coding agent (GPT-6 stays in Autopilot, the other agents' share applies).
 * Both live in `server_keys` and look the same; the kind is stored, never read from the key.
 */
export const KEY_KINDS = ["server", "tool"] as const;
export type KeyKind = (typeof KEY_KINDS)[number];
/** `last_used_at` is written at most this often per key. */
const KEY_TOUCH_MS = 60_000;

/** `dlk_<githubId>_<id>_<secret>`: the GitHub id routes to this object; only the secret's hash is stored. */
const SERVER_KEY = /^dlk_([1-9][0-9]{0,15})_([a-z0-9]{12})_([A-Za-z0-9_-]{43})$/;

/** A stored kind; anything unknown reads as a tool key, the narrower of the two. */
function keyKind(value: string): KeyKind {
  return value === "server" ? "server" : "tool";
}

export function parseServerKey(key: string): { githubId: number; id: string; secret: string } | undefined {
  const match = SERVER_KEY.exec(key);
  if (!match) return undefined;
  const githubId = Number(match[1]);
  return Number.isSafeInteger(githubId) ? { githubId, id: match[2]!, secret: match[3]! } : undefined;
}

/**
 * Harness keys: what dl hands another coding agent it launches (`dl claude`: Claude Code,
 * `dl opencode`: OpenCode, `dl pi`: Pi). `dlh_<githubId>_<id>_<secret>`, minted from a
 * sign-in's access token for one dl session, bound to that sign-in session (signing out ends it),
 * and short-lived: it expires HARNESS_KEY_TTL_MS after it was made or last refreshed. dl refreshes
 * it while the agent runs and revokes it when it exits, so it never outlives dl by much.
 */
const HARNESS_KEY = /^dlh_([1-9][0-9]{0,15})_([a-z0-9]{12})_([A-Za-z0-9_-]{43})$/;
export const HARNESS_KEY_TTL_MS = 15 * 60_000;
/** Live harness keys per account: one per running `dl claude` or `dl opencode`. */
export const MAX_HARNESS_KEYS = 10;
/** The coding agents other than Autopilot dl can launch on free tokens. */
export const HARNESSES = ["claude-code", "opencode", "pi"] as const;
export type Harness = (typeof HARNESSES)[number];

export function parseHarnessKey(key: string): { githubId: number; id: string; secret: string } | undefined {
  const match = HARNESS_KEY.exec(key);
  if (!match) return undefined;
  const githubId = Number(match[1]);
  return Number.isSafeInteger(githubId) ? { githubId, id: match[2]!, secret: match[3]! } : undefined;
}

export type CreateHarnessKeyResult =
  | { ok: true; id: string; key: string; expiresAt: number }
  | { ok: false; code: "not_invited" | "suspended" | "blocked" | "harness_key_limit" };

export interface ServerKeyView {
  id: string;
  name: string;
  kind: KeyKind;
  /** Unix ms. */
  createdAt: number;
  /** Unix ms, to the minute; null when never used. */
  lastUsedAt: number | null;
  /** A tool key's last tool (tool-keys.ts toolName, a short name); null for a server key or one never used. */
  lastTool: string | null;
}

export type CreateKeyResult =
  | { ok: true; key: string; view: ServerKeyView }
  | { ok: false; code: "not_invited" | "suspended" | "blocked" | "key_limit_reached" | "key_name_taken"; max?: number };

export interface AccountEnv {
  DIRECTORY?: DurableObjectNamespace<DirectoryObject>;
}

/** "blocked": an admin blocked the account for abuse (stronger than a suspension: no refresh, no sign-in). */
export type AccountStatus = "active" | "suspended" | "blocked";

export type Plan = "free" | "pro";
/**
 * Where a request is paid from: the weekly allowance (free or Pro), the old token top-ups
 * ("topup"), or dollar top-ups ("credit": usage dollars, charged at the dollar caps' cost).
 */
export type Source = "weekly" | "topup" | "credit";

/** One weekly token allowance: what a model's tokens come from. Null tokens: no token cap (DeepSeek). */
export interface PoolAllowance {
  tokensPerWeek: number | null;
  usedThisWeek: number;
  reserved: number;
  remaining: number | null;
}

/** One weekly dollar budget: every GPT-6 model shares one, DeepSeek has its own. */
export interface FamilyBudget {
  /** USD a week, or null for no cap. */
  usdPerWeek: number | null;
  /** Settled this week (in-flight estimates not included). */
  spentUsd: number;
  /**
   * Every token processed this week on this budget's models, counted the normal way: prompt
   * tokens (cached included) plus completion tokens, whatever paid for them. Not the weighted
   * count the token allowances are charged.
   */
  tokensThisWeek: number;
}

/**
 * A new account's one-time trial (see `Limits.trialTokens`): tokens counted the normal way
 * (prompt with cached, plus completion), every free model together, for the account's lifetime.
 * Only free weekly usage counts: Pro and top-ups don't use the trial.
 */
export interface TrialState {
  tokens: number;
  /** Settled free tokens since the trial started counting. */
  used: number;
  /** Held by free requests in flight. */
  reserved: number;
  /** What a new free request may still use: tokens less used and reserved, at least 0. */
  remaining: number;
  /** Used up: less than a minimal answer is left, in-flight requests aside. */
  ended: boolean;
}

export interface Allowance {
  exists: boolean;
  plan: Plan;
  /** Unexpired top-up tokens (the old token top-ups) not yet used or held. */
  topupTokensLeft: number;
  /** Unexpired top-up usage dollars not yet spent or held by requests in flight. */
  topupUsdLeft: number;
  /** When the soonest-expiring dollar top-up with usage left expires (Unix ms), or null. */
  topupUsdExpiresAt: number | null;
  /** Pro's paid period end (Unix ms), or null. */
  proPeriodEnd: number | null;
  proCancelAtPeriodEnd: boolean;
  status: AccountStatus | null;
  isAdmin: boolean;
  /** The asked pool's tokens; null tokensPerWeek and remaining: no token cap (its budget is the limit). */
  tokensPerWeek: number | null;
  usedThisWeek: number;
  reserved: number;
  /** 0 once the pool's tokens or its family's dollar budget are used up. */
  remaining: number | null;
  /** The asked pool's family: the budget `usdPerWeek` and `spentUsdThisWeek` describe. */
  family: Family;
  /** That family's weekly dollar budget in USD, or null for none. */
  usdPerWeek: number | null;
  spentUsdThisWeek: number;
  /** Unix ms. */
  resetsAt: number;
  /** Every pool's allowance, so a client can show what each model has left. */
  pools: Record<Pool, PoolAllowance>;
  /** Both weekly dollar budgets. */
  budgets: Record<Family, FamilyBudget>;
  /** The one-time trial, for an account on trial (whatever its plan); null for everyone else. */
  trial: TrialState | null;
}

/**
 * A paid plan's meter for one request (plans.ts, gpt6-bonus.ts): the request is held to it
 * instead of the weekly pools and dollar budgets. "tokens": the model's counted tokens this week
 * against `limit`; "bonus": the GPT-6 launch bonus's dollars this week against `limit`.
 */
export interface ReserveMeter {
  kind: "tokens" | "bonus";
  /** The model the meter is for (the one that serves). */
  model: string;
  limit: number;
  /** Cached-token weight, for the in-flight estimate. */
  cachedTokenWeight: number;
}

/** An account's plan state (plans.ts): its tier, since when it pays, and the fallback setting. */
export interface PlanState {
  tier: PlanTier;
  /** When the account was first seen paying (Unix ms); null when not paying. */
  paidSince: number | null;
  /** Whether a model at its limit falls back to DeepSeek (the default) rather than refusing. */
  fallback: boolean;
  /** Counted tokens this week per model asked about. */
  counted: Record<string, number>;
  /** GPT-6 launch bonus dollars spent this week. */
  bonusUsd: number;
}

export type ReserveResult =
  | { ok: true; reservationId: string; amount: number; maxTokens: number; source: Source; paid: boolean; allowance: Allowance }
  /** A paid plan's meter (ReserveMeter) has no room left for this request. */
  | { ok: false; code: "plan_limit"; meter: ReserveMeter; used: number; allowance: Allowance }
  | { ok: false; code: "not_invited" | "suspended" | "blocked"; allowance: Allowance }
  /** A trial account on the free plan used its trial, with no top-up left: Pro or a top-up from here. */
  | { ok: false; code: "trial_ended"; allowance: Allowance; trial: TrialState }
  | {
      ok: false;
      code: "quota_exceeded";
      reason: "tokens" | "spend";
      allowance: Allowance;
      /** The refused request's family, and whether DeepSeek still has weekly room for this person (it never does for a DeepSeek request). */
      family: Family;
      deepseekLeft: boolean;
    };

/** Caps a call applies; per-person overrides set by an admin win over these. */
export interface Limits {
  weeklyTokens: number;
  /** The GPT-6 weekly dollar budget (every GPT-6 model); undefined for none. A personal cap replaces it. */
  weeklyUsd: number | undefined;
  /**
   * The DeepSeek weekly dollar budget; null for none, left out: the same as `weeklyUsd`. With a
   * personal cap it is the larger of the two.
   */
  deepseekWeeklyUsd?: number | null;
  /**
   * This week's referral bonus, added on top of the weekly tokens (default or grant). The USD
   * allowance grows in the same proportion, so the bonus isn't cut short by the dollar cap.
   */
  bonusTokens?: number;
  /** Pro's weekly tokens. */
  proTokensPerWeek?: number;
  /**
   * Pro's DeepSeek (open models) budget; null for none, left out: the plan's own DeepSeek budget.
   * Pro has no GPT-6 budget of its own: it gets the free plan's (`weeklyUsd`), so paying never
   * unlocks GPT-6.
   */
  proDeepseekUsdPerWeek?: number | null;
  /**
   * Free tokens are unavailable to a free-plan person for now (queued, or a global cap reached):
   * their requests can use top-ups only. Pro is unaffected.
   */
  freeBlocked?: boolean;
  /**
   * "basic" and "starter" put every GPT-6 pool at `levelTokens` (Sol and Astra at most their own
   * fixed grants): every model, a smaller allowance. DeepSeek has no token cap, except 0 when
   * `levelTokens` is 0. The dollar cap for the level comes in
   * `weeklyUsd`. Pro is unaffected.
   */
  level?: Level;
  /** A basic or Starter account's weekly tokens (BASIC_WEEKLY_TOKENS or STARTER_WEEKLY_TOKENS; 0 for a batch-flagged Starter). */
  levelTokens?: number;
  /**
   * The account is on the new-user trial (admitted at or after the trial cutoff, not an admin):
   * its free usage is also held to these tokens for its lifetime, on top of the weekly rules.
   * Undefined: grandfathered (or the trial is off), the weekly allowance alone.
   */
  trialTokens?: number;
  /**
   * Requests from another coding agent launched by dl (`dl claude`) see only this share (0 to 1)
   * of the weekly allowance: every token pool, both dollar budgets and the trial are scaled by it,
   * while what the week (and the trial) has used is counted in full. So such requests stop once the
   * account as a whole has used the share; Autopilot's own requests keep the rest. Undefined: 1.
   * Top-ups and Pro are not scaled: a Pro subscriber gets the whole Pro allowance.
   */
  harnessShare?: number;
}

export interface BillingState {
  customerId: string | null;
  subscriptionId: string | null;
  proState: "none" | "active" | "past_due" | "canceled";
  periodEnd: number | null;
  cancelAtPeriodEnd: boolean;
}

interface AccountRow {
  github_id: number;
  login: string;
  status: AccountStatus;
  is_admin: number;
  weekly_tokens: number | null;
  weekly_usd: number | null;
  week_start: number;
  used: number;
  /** This week's settled cost, both families. */
  cost_used: number;
  /** ... of which DeepSeek's. GPT-6's is the rest. */
  cost_used_deepseek: number;
  /** All-time free tokens (prompt with cached, plus completion) from the weekly allowance on the free plan: the trial's count. */
  trial_used: number;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS account (
     github_id     INTEGER PRIMARY KEY,
     login         TEXT NOT NULL,
     status        TEXT NOT NULL,
     is_admin      INTEGER NOT NULL,
     weekly_tokens INTEGER,
     weekly_usd    REAL,
     week_start    INTEGER NOT NULL,
     used          INTEGER NOT NULL,
     cost_used     REAL NOT NULL,
     created_at    INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS server_keys (
     id           TEXT PRIMARY KEY,
     name         TEXT NOT NULL UNIQUE,
     key_hash     TEXT NOT NULL,
     created_at   INTEGER NOT NULL,
     last_used_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS harness_keys (
     id         TEXT PRIMARY KEY,
     harness    TEXT NOT NULL,
     key_hash   TEXT NOT NULL,
     sid        TEXT,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS revoked_sessions (
     sid        TEXT PRIMARY KEY,
     expires_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS reservations (
     id         TEXT PRIMARY KEY,
     amount     INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  // Stripe: the customer, the Pro subscription's state as the webhooks last said (state_at is
  // the newest event's Unix seconds, so an older event arriving late can't undo a newer one).
  `CREATE TABLE IF NOT EXISTS billing (
     k                    INTEGER PRIMARY KEY CHECK (k = 1),
     customer_id          TEXT,
     subscription_id      TEXT,
     pro_state            TEXT NOT NULL DEFAULT 'none',
     period_end           INTEGER,
     cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
     state_at             INTEGER NOT NULL DEFAULT 0
   )`,
  // Per pool per week: the tokens each model's allowance has spent. The account's `used` stays
  // the total, for the dollar cap and the dashboards.
  `CREATE TABLE IF NOT EXISTS pool_usage (
     week_start INTEGER NOT NULL,
     pool       TEXT NOT NULL,
     used       INTEGER NOT NULL,
     PRIMARY KEY (week_start, pool)
   ) WITHOUT ROWID`,
  // Per budget per week: every token processed (prompt with cached, plus completion), for display.
  `CREATE TABLE IF NOT EXISTS family_tokens (
     week_start INTEGER NOT NULL,
     family     TEXT NOT NULL,
     tokens     INTEGER NOT NULL,
     PRIMARY KEY (week_start, family)
   ) WITHOUT ROWID`,
  // Top-ups: tokens bought once, used after the weekly allowance runs out, until they expire.
  `CREATE TABLE IF NOT EXISTS topups (
     id         TEXT PRIMARY KEY,
     tokens     INTEGER NOT NULL,
     used       INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
];

export class AccountObject extends DurableObject<AccountEnv> {
  constructor(ctx: DurableObjectState, env: AccountEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      for (const statement of SCHEMA) this.ctx.storage.sql.exec(statement);
      for (const statement of METER_SCHEMA) this.ctx.storage.sql.exec(statement);
      // Reservations made before billing were all against the weekly allowance, unpaid.
      const columns = this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('reservations')").toArray().map((column) => column.name);
      if (!columns.includes("source")) this.ctx.storage.sql.exec("ALTER TABLE reservations ADD COLUMN source TEXT NOT NULL DEFAULT 'weekly'");
      if (!columns.includes("paid")) this.ctx.storage.sql.exec("ALTER TABLE reservations ADD COLUMN paid INTEGER NOT NULL DEFAULT 0");
      // Reservations made before pools were all against the one model's allowance.
      if (!columns.includes("pool")) this.ctx.storage.sql.exec("ALTER TABLE reservations ADD COLUMN pool TEXT NOT NULL DEFAULT 'luna'");
      // What an abandoned reservation is recorded and charged as: the provider and model that
      // were serving it, and the prompt's estimated size. Null on reservations made before.
      if (!columns.includes("provider")) this.ctx.storage.sql.exec("ALTER TABLE reservations ADD COLUMN provider TEXT");
      if (!columns.includes("model")) this.ctx.storage.sql.exec("ALTER TABLE reservations ADD COLUMN model TEXT");
      if (!columns.includes("prompt_estimate")) this.ctx.storage.sql.exec("ALTER TABLE reservations ADD COLUMN prompt_estimate INTEGER");
      // The reservation's estimated cost in USD, held against the dollar cap while it is in
      // flight. Null on reservations made before (they count as nothing).
      if (!columns.includes("cost_estimate")) this.ctx.storage.sql.exec("ALTER TABLE reservations ADD COLUMN cost_estimate REAL");
      // Dollar top-ups: `usd` is the usage dollars bought (null on a token top-up), `used_usd` what is spent.
      const topupColumns = this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('topups')").toArray().map((column) => column.name);
      if (!topupColumns.includes("usd")) this.ctx.storage.sql.exec("ALTER TABLE topups ADD COLUMN usd REAL");
      if (!topupColumns.includes("used_usd")) this.ctx.storage.sql.exec("ALTER TABLE topups ADD COLUMN used_usd REAL NOT NULL DEFAULT 0");
      // Two weekly dollar budgets: DeepSeek's spend is kept apart; cost_used stays the total.
      // Spend from before this column counts as GPT-6's for the rest of that week.
      const accountColumns = this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('account')").toArray().map((column) => column.name);
      if (!accountColumns.includes("cost_used_deepseek")) this.ctx.storage.sql.exec("ALTER TABLE account ADD COLUMN cost_used_deepseek REAL NOT NULL DEFAULT 0");
      // The trial's count: free tokens (unpaid weekly usage) for the account's lifetime. It starts
      // at 0 for accounts from before it; only trial accounts (admitted at or after the cutoff) are held to it.
      // Key kinds (KEY_KINDS): every key made before them was a server key.
      const keyColumns = this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('server_keys')").toArray().map((column) => column.name);
      if (!keyColumns.includes("kind")) this.ctx.storage.sql.exec("ALTER TABLE server_keys ADD COLUMN kind TEXT NOT NULL DEFAULT 'server'");
      // The tool a tool key was last used from (a short name only, never a header as sent).
      if (!keyColumns.includes("last_tool")) this.ctx.storage.sql.exec("ALTER TABLE server_keys ADD COLUMN last_tool TEXT");
      if (!accountColumns.includes("trial_used")) this.ctx.storage.sql.exec("ALTER TABLE account ADD COLUMN trial_used INTEGER NOT NULL DEFAULT 0");
      // Prompt and cached tokens the providers reported for this person, all time: their cached
      // share, which a request that ended without usage is estimated with. 0 for accounts from before.
      if (!accountColumns.includes("prompt_seen")) this.ctx.storage.sql.exec("ALTER TABLE account ADD COLUMN prompt_seen INTEGER NOT NULL DEFAULT 0");
      if (!accountColumns.includes("cached_seen")) this.ctx.storage.sql.exec("ALTER TABLE account ADD COLUMN cached_seen INTEGER NOT NULL DEFAULT 0");
    });
  }

  /** Creates the account on admission, or refreshes the login. A suspension stays. */
  async activate(input: { githubId: number; login: string; isAdmin: boolean; now: number }): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO account (github_id, login, status, is_admin, weekly_tokens, weekly_usd, week_start, used, cost_used, created_at)
       VALUES (?, ?, 'active', ?, NULL, NULL, ?, 0, 0, ?)
       ON CONFLICT(github_id) DO UPDATE SET login = excluded.login, is_admin = excluded.is_admin`,
      input.githubId,
      input.login,
      input.isAdmin ? 1 : 0,
      weekStart(input.now),
      input.now,
    );
  }

  /** The allowance for one pool (default: the shared Luna/DeepSeek one), with every pool's detail. */
  async allowance(now: number, limits: Limits, pool: Pool = "luna"): Promise<Allowance> {
    return this.#allowance(this.#current(now), now, limits, pool);
  }

  /**
   * Holds tokens for one request. The token cap is exact (the reservation covers the worst
   * case). The dollar cap is the request's family's budget (GPT-6 or DeepSeek): it counts what
   * that family settled plus the estimated cost of every weekly reservation of that family still
   * in flight (`estimateCostUsd`): a request whose estimate doesn't fit next to those is
   * refused, so parallel requests can't run past the cap together. A request with
   * nothing else in flight still goes through while any of the cap is left, so the week ends at
   * the cap rather than an estimate short of it: the overshoot is at most that one request.
   * Settling or sweeping a reservation deletes it, which releases its estimate.
   */
  async reserve(input: {
    pool?: Pool;
    promptEstimate: number;
    requestedMaxTokens: number | undefined;
    limits: Limits;
    now: number;
    /** The provider and model serving the request, for the record if it is abandoned. */
    provider?: Upstream;
    model?: string;
    /** A paid plan's meter: replaces the weekly pools, dollar budgets and top-ups for this request. */
    meter?: ReserveMeter;
  }): Promise<ReserveResult> {
    const pool = input.pool ?? "luna";
    const row = this.#current(input.now);
    const before = this.#allowance(row, input.now, input.limits, pool);
    if (!row) return { ok: false, code: "not_invited", allowance: before };
    if (row.status === "blocked") return { ok: false, code: "blocked", allowance: before };
    if (row.status === "suspended") return { ok: false, code: "suspended", allowance: before };
    if (input.meter) return this.#reserveOnMeter(row, before, pool, input as typeof input & { meter: ReserveMeter });
    // The weekly allowance first (free or Pro), then top-ups.
    const family = familyOfPool(pool);
    const spendReached = before.usdPerWeek !== null && before.spentUsdThisWeek >= before.usdPerWeek;
    // On the free plan, a trial account's weekly room is also held to what its trial has left.
    const trial = before.plan === "free" ? before.trial : null;
    const weeklyRoom = spendReached || (before.plan === "free" && input.limits.freeBlocked) ? 0 : Math.min(before.remaining ?? Number.MAX_SAFE_INTEGER, trial ? trial.remaining : Number.MAX_SAFE_INTEGER);
    const model = modelById(input.model ?? DEFAULT_MODEL);
    const estimate = (maxTokens: number) =>
      model ? estimateCostUsd(input.promptEstimate, maxTokens, model.prices) : ((Math.max(0, input.promptEstimate) + maxTokens) * FALLBACK_USD_PER_MILLION_TOKENS) / 1_000_000;
    let source: Source = "weekly";
    const outputCap = model?.family === "deepseek" ? Math.min(model.maxOutputTokens, DEEPSEEK_MAX_OUTPUT_TOKENS) : MAX_OUTPUT_TOKENS;
    let plan = planReservation(input.promptEstimate, input.requestedMaxTokens, weeklyRoom, outputCap);
    let spendFull = false;
    if (plan && before.usdPerWeek !== null) {
      const inFlight = this.#inFlight("weekly", family);
      spendFull = inFlight.count > 0 && before.spentUsdThisWeek + inFlight.usd + estimate(plan.maxTokens) > before.usdPerWeek;
      if (spendFull) plan = undefined;
    }
    if (!plan) {
      source = "topup";
      plan = planReservation(input.promptEstimate, input.requestedMaxTokens, before.topupTokensLeft, outputCap);
    }
    if (!plan) {
      // Dollar top-ups last, held like the dollar caps: what is spent plus the estimates in flight.
      // With nothing else in flight a request goes through while any of the balance is left.
      const credit = this.#creditLeft(input.now);
      const inFlight = this.#inFlight("credit");
      const wanted = planReservation(input.promptEstimate, input.requestedMaxTokens, Number.MAX_SAFE_INTEGER, outputCap);
      if (wanted && credit > 0 && (inFlight.count === 0 || inFlight.usd + estimate(wanted.maxTokens) <= credit)) {
        source = "credit";
        plan = wanted;
      }
    }
    if (!plan) {
      // The trial is what stops it: it is the same for every model, so no other model can help.
      if (trial && !input.limits.freeBlocked && !planReservation(input.promptEstimate, input.requestedMaxTokens, trial.remaining, outputCap)) {
        return { ok: false, code: "trial_ended", allowance: before, trial };
      }
      // Whether DeepSeek's week still has room, so a GPT-6 refusal can point there instead of a dead end.
      const deepseek = family === "gpt6" && !(before.plan === "free" && input.limits.freeBlocked) ? this.#allowance(row, input.now, input.limits, "deepseek") : undefined;
      const deepseekLeft = deepseek !== undefined && (deepseek.remaining === null || deepseek.remaining > 0);
      return { ok: false, code: "quota_exceeded", reason: spendReached || spendFull ? "spend" : "tokens", allowance: before, family, deepseekLeft };
    }
    const paid = source !== "weekly" || before.plan === "pro";
    const reservationId = crypto.randomUUID();
    const expiresAt = input.now + RESERVATION_TTL_MS;
    this.ctx.storage.sql.exec(
      "INSERT INTO reservations (id, amount, created_at, expires_at, source, paid, pool, provider, model, prompt_estimate, cost_estimate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      reservationId,
      plan.amount,
      input.now,
      expiresAt,
      source,
      paid ? 1 : 0,
      pool,
      input.provider ?? null,
      input.model ?? null,
      Math.max(0, Math.round(input.promptEstimate)),
      estimate(plan.maxTokens),
    );
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > expiresAt) await this.ctx.storage.setAlarm(expiresAt);
    return { ok: true, reservationId, amount: plan.amount, maxTokens: plan.maxTokens, source, paid, allowance: this.#allowance(row, input.now, input.limits, pool) };
  }

  /**
   * A request held to a paid plan's meter. With nothing else in flight on the model it goes
   * through while any of the limit is left (the week ends at the limit, overshooting by at most
   * that one request, like the dollar caps); with others in flight, only when their expected
   * counts plus its own still fit. The output cap is the model's own, never clamped by a pool.
   */
  async #reserveOnMeter(
    row: AccountRow,
    before: Allowance,
    pool: Pool,
    input: { promptEstimate: number; requestedMaxTokens: number | undefined; now: number; provider?: Upstream; model?: string; meter: ReserveMeter },
  ): Promise<ReserveResult> {
    const { meter } = input;
    const sql = this.ctx.storage.sql;
    const model = modelById(input.model ?? meter.model);
    const share = this.#cachedShareOrUndefined(row.github_id);
    const flight = inFlightOn(sql, meter.model, share, meter.cachedTokenWeight);
    const outputCap = model?.family === "deepseek" ? Math.min(model.maxOutputTokens, DEEPSEEK_MAX_OUTPUT_TOKENS) : MAX_OUTPUT_TOKENS;
    const plan = planReservation(input.promptEstimate, input.requestedMaxTokens, Number.MAX_SAFE_INTEGER, outputCap)!;
    const cost = model ? estimateCostUsd(input.promptEstimate, plan.maxTokens, model.prices) : ((Math.max(0, input.promptEstimate) + plan.maxTokens) * FALLBACK_USD_PER_MILLION_TOKENS) / 1_000_000;
    const used = meter.kind === "bonus" ? bonusUsdThisWeek(sql, input.now) : countedThisWeek(sql, meter.model, input.now);
    const inFlight = meter.kind === "bonus" ? flight.usd : flight.counted;
    const own = meter.kind === "bonus" ? cost : expectedCounted(input.promptEstimate, share ?? 0.9617, meter.cachedTokenWeight);
    const fits = used < meter.limit && (flight.count === 0 || used + inFlight + own <= meter.limit);
    if (!fits) return { ok: false, code: "plan_limit", meter, used, allowance: before };
    const reservationId = crypto.randomUUID();
    const expiresAt = input.now + RESERVATION_TTL_MS;
    sql.exec(
      "INSERT INTO reservations (id, amount, created_at, expires_at, source, paid, pool, provider, model, prompt_estimate, cost_estimate) VALUES (?, ?, ?, ?, 'weekly', 1, ?, ?, ?, ?, ?)",
      reservationId,
      plan.amount,
      input.now,
      expiresAt,
      pool,
      input.provider ?? null,
      input.model ?? meter.model,
      Math.max(0, Math.round(input.promptEstimate)),
      cost,
    );
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > expiresAt) await this.ctx.storage.setAlarm(expiresAt);
    return { ok: true, reservationId, amount: plan.amount, maxTokens: plan.maxTokens, source: "weekly", paid: true, allowance: before };
  }

  // ─── Paid plans (plans.ts, plan-meter.ts) ─────────────────────────────────

  /**
   * The plan state and this week's meters for `models`. The tier is the stored one while the
   * subscription is active (Starter for a subscription from before the three plans), else "none".
   * The first call that sees the account paying records when (the bonus's wait counts from it).
   */
  async planState(now: number, models: readonly string[] = []): Promise<PlanState> {
    const sql = this.ctx.storage.sql;
    this.#current(now);
    const paying = this.#row() !== undefined && this.#plan(now) === "pro";
    const tier = tierOf(paying, readMeta(sql, META.tier));
    let paidSince: number | null = null;
    if (paying) {
      const stored = Number(readMeta(sql, META.paidSince));
      if (Number.isSafeInteger(stored) && stored > 0) paidSince = stored;
      else {
        paidSince = now;
        writeMeta(sql, META.paidSince, String(now));
      }
    }
    const counted: Record<string, number> = {};
    for (const model of models) counted[model] = countedThisWeek(sql, model, now);
    return { tier, paidSince, fallback: readMeta(sql, META.fallback) !== "off", counted, bonusUsd: bonusUsdThisWeek(sql, now) };
  }

  /** Part A's hook: the paid plan the subscription is on (from its Stripe price). Undefined clears it. */
  async setPlanTier(tier: string | undefined): Promise<boolean> {
    if (tier !== undefined && !isPaidPlan(tier)) return false;
    writeMeta(this.ctx.storage.sql, META.tier, tier);
    return true;
  }

  /** The person's setting: fall back to DeepSeek at a model's limit (true, the default) or refuse. */
  async setPlanFallback(on: boolean): Promise<void> {
    writeMeta(this.ctx.storage.sql, META.fallback, on ? undefined : "off");
  }

  /** Claims a once-a-week notice (the 80% warning per model): true only the first time this week. */
  async claimPlanNotice(key: string, now: number): Promise<boolean> {
    return claimNotice(this.ctx.storage.sql, key, now);
  }

  /** This week's per-model, per-day and per-tool meters, and the bonus dollars (dashboard). */
  async meters(now: number): Promise<MeterSnapshot> {
    pruneMeters(this.ctx.storage.sql, now);
    return meterSnapshot(this.ctx.storage.sql, now);
  }

  /**
   * Replaces a reservation with what was really used. `charged` undefined means the provider
   * reported no usage: the request is charged an estimate (`noUsage`), never the reservation.
   * With no output streamed (cancelled, or failed before any output), that is nothing; with
   * output, a realistic prompt at the person's own cached share plus the output streamed, at the
   * model's list prices (quota.ts estimatedUsage). A reservation the alarm already settled is not
   * charged twice.
   */
  async settle(input: {
    reservationId: string;
    charged: number | undefined;
    costUsd: number | undefined;
    /** Tokens processed (prompt with cached, plus completion); undefined: `charged`. */
    rawTokens?: number;
    /** The usage the provider reported, when it did: kept for the person's cached share. */
    usage?: Usage;
    /** With `charged` undefined: what was streamed, the serving model's prices (undefined: none known) and the cached-token weight. */
    noUsage?: { outputTokens: number; prices: TokenPrices | undefined; cachedTokenWeight: number };
    /** For the per-model meters (plan-meter.ts): the client, whether a backup or fallback served, and whether the GPT-6 bonus paid. */
    meter?: { tool: string; failover: boolean; bonus: boolean };
    limits: Limits;
    now: number;
  }): Promise<{ charged: number; costUsd: number; paid: boolean; allowance: Allowance; estimate?: NoUsageEstimate }> {
    const reservation = this.ctx.storage.sql
      .exec<{ amount: number; source: Source; paid: number; pool: Pool; model: string | null; prompt_estimate: number | null }>(
        "SELECT amount, source, paid, pool, model, prompt_estimate FROM reservations WHERE id = ?",
        input.reservationId,
      )
      .toArray()[0];
    const row = this.#current(input.now);
    if (!reservation || !row) return { charged: 0, costUsd: 0, paid: false, allowance: this.#allowance(row, input.now, input.limits) };
    let charged = input.charged;
    let costUsd = input.costUsd;
    let rawTokens = input.rawTokens;
    let estimate: NoUsageEstimate | undefined;
    if (charged === undefined) {
      const prices = input.noUsage ? input.noUsage.prices : modelById(reservation.model ?? "")?.prices;
      estimate = this.#estimate(row, reservation.prompt_estimate ?? 0, input.noUsage?.outputTokens ?? 0);
      charged = estimate.usage ? chargedTokens(estimate.usage, input.noUsage?.cachedTokenWeight ?? 0) : 0;
      costUsd = estimate.usage ? costAtPricesOrFallback(estimate.usage, prices) : 0;
      rawTokens = estimate.usage ? estimate.usage.promptTokens + estimate.usage.completionTokens : 0;
    }
    const finalCharged = charged;
    const finalCost = costUsd ?? 0;
    const finalRaw = rawTokens ?? finalCharged;
    this.ctx.storage.transactionSync(() => {
      this.#charge(row.github_id, input.reservationId, reservation.source, reservation.pool, finalCharged, finalCost, input.now);
      this.#addTokens(reservation.pool, finalRaw, input.now);
      if (reservation.source === "weekly" && reservation.paid !== 1) this.#addTrial(row.github_id, finalRaw);
      if (input.meter && reservation.model) {
        recordMeter(this.ctx.storage.sql, {
          model: reservation.model,
          counted: finalCharged,
          usage: input.usage ?? estimate?.usage,
          costUsd: finalCost,
          tool: input.meter.tool,
          failover: input.meter.failover,
          bonus: input.meter.bonus,
          now: input.now,
        });
      }
      if (input.usage && input.usage.promptTokens > 0) {
        this.ctx.storage.sql.exec(
          "UPDATE account SET prompt_seen = prompt_seen + ?, cached_seen = cached_seen + ? WHERE github_id = ?",
          input.usage.promptTokens,
          Math.min(input.usage.cachedTokens, input.usage.promptTokens),
          row.github_id,
        );
      }
    });
    return {
      charged: finalCharged,
      costUsd: finalCost,
      paid: reservation.paid === 1,
      allowance: this.#allowance(this.#current(input.now), input.now, input.limits, reservation.pool),
      ...(estimate ? { estimate } : {}),
    };
  }

  /** The person's cached share of prompt tokens so far; 0 until enough has been reported to tell. */
  #cachedShare(githubId: number): number {
    const seen = this.ctx.storage.sql.exec<{ prompt_seen: number; cached_seen: number }>("SELECT prompt_seen, cached_seen FROM account WHERE github_id = ?", githubId).toArray()[0];
    if (!seen || seen.prompt_seen < MIN_PROMPT_TOKENS_FOR_CACHED_SHARE) return 0;
    return Math.min(1, seen.cached_seen / seen.prompt_seen);
  }

  /** The person's cached share, or undefined until enough has been reported to tell. */
  #cachedShareOrUndefined(githubId: number): number | undefined {
    const seen = this.ctx.storage.sql.exec<{ prompt_seen: number; cached_seen: number }>("SELECT prompt_seen, cached_seen FROM account WHERE github_id = ?", githubId).toArray()[0];
    if (!seen || seen.prompt_seen < MIN_PROMPT_TOKENS_FOR_CACHED_SHARE) return undefined;
    return Math.min(1, seen.cached_seen / seen.prompt_seen);
  }

  /** A request without usage: the estimate charged (undefined with no output), and the realistic prompt alone, for the provider's credit. */
  #estimate(row: { github_id: number }, promptEstimate: number, outputTokens: number): NoUsageEstimate {
    const share = this.#cachedShare(row.github_id);
    const promptTokens = realisticPromptTokens(promptEstimate);
    return { usage: estimatedUsage(promptEstimate, outputTokens, share), prompt: { promptTokens, completionTokens: 0, cachedTokens: Math.floor(promptTokens * share), costUsd: undefined } };
  }

  /** Replaces a reservation with its charge: to the week's counters, or to top-ups, earliest expiry first. */
  #charge(githubId: number, reservationId: string, source: Source, pool: Pool, charged: number, costUsd: number, now: number): void {
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM reservations WHERE id = ?", reservationId);
    if (source === "weekly") {
      this.#addWeekly(githubId, pool, charged, costUsd, now);
      return;
    }
    if (source === "credit") {
      // Usage dollars from dollar top-ups, earliest expiry first; any cost past the last one goes
      // on the week (tokens in proportion), like an overshoot past token top-ups.
      let leftUsd = costUsd;
      for (const topup of sql.exec<{ id: string; usd: number; used_usd: number }>("SELECT id, usd, used_usd FROM topups WHERE usd IS NOT NULL AND expires_at > ? AND used_usd < usd ORDER BY expires_at, id", now).toArray()) {
        if (leftUsd <= 0) break;
        const take = Math.min(leftUsd, topup.usd - topup.used_usd);
        sql.exec("UPDATE topups SET used_usd = used_usd + ? WHERE id = ?", take, topup.id);
        leftUsd -= take;
      }
      if (leftUsd > 1e-12) {
        const tokens = costUsd > 0 ? Math.round((charged * leftUsd) / costUsd) : 0;
        this.#addWeekly(githubId, pool, tokens, leftUsd, now);
      }
      return;
    }
    let left = charged;
    for (const topup of sql.exec<{ id: string; tokens: number; used: number }>("SELECT id, tokens, used FROM topups WHERE expires_at > ? AND used < tokens ORDER BY expires_at, id", now).toArray()) {
      if (left <= 0) break;
      const take = Math.min(left, topup.tokens - topup.used);
      sql.exec("UPDATE topups SET used = used + ? WHERE id = ?", take, topup.id);
      left -= take;
    }
    // Usage past the last top-up (an overshoot the reservation didn't foresee) goes on the week,
    // tokens and its share of the cost, so top-ups never buy more than their tokens: the excess
    // counts against the weekly token and dollar caps like any other weekly use.
    if (left > 0) {
      const overshootUsd = charged > 0 ? (costUsd * left) / charged : 0;
      this.#addWeekly(githubId, pool, left, overshootUsd, now);
    }
  }

  /** Adds tokens processed to this week's count for the pool's budget. */
  #addTokens(pool: Pool, tokens: number, now: number): void {
    if (tokens <= 0) return;
    this.ctx.storage.sql.exec(
      "INSERT INTO family_tokens (week_start, family, tokens) VALUES (?, ?, ?) ON CONFLICT(week_start, family) DO UPDATE SET tokens = tokens + excluded.tokens",
      weekStart(now),
      familyOfPool(pool),
      Math.round(tokens),
    );
  }

  /** Adds free tokens to the all-time count a trial is held to. */
  #addTrial(githubId: number, tokens: number): void {
    if (tokens <= 0) return;
    this.ctx.storage.sql.exec("UPDATE account SET trial_used = trial_used + ? WHERE github_id = ?", Math.round(tokens), githubId);
  }

  /**
   * Admin: starts this week over for this person: tokens and dollars of both budgets back to 0
   * (requests in flight still settle). Top-ups, plan and personal caps are kept. False with no account.
   */
  async resetWeek(now: number): Promise<boolean> {
    const row = this.#current(now);
    if (!row) return false;
    const start = weekStart(now);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("UPDATE account SET used = 0, cost_used = 0, cost_used_deepseek = 0 WHERE github_id = ?", row.github_id);
      this.ctx.storage.sql.exec("DELETE FROM pool_usage WHERE week_start = ?", start);
      this.ctx.storage.sql.exec("DELETE FROM family_tokens WHERE week_start = ?", start);
    });
    return true;
  }

  /** Adds tokens and dollars to this week's counters: the total, the pool's tokens and, for DeepSeek, its own dollars. */
  #addWeekly(githubId: number, pool: Pool, tokens: number, usd: number, now: number): void {
    const sql = this.ctx.storage.sql;
    const deepseekUsd = familyOfPool(pool) === "deepseek" ? usd : 0;
    sql.exec("UPDATE account SET used = used + ?, cost_used = cost_used + ?, cost_used_deepseek = cost_used_deepseek + ? WHERE github_id = ?", tokens, usd, deepseekUsd, githubId);
    sql.exec(
      "INSERT INTO pool_usage (week_start, pool, used) VALUES (?, ?, ?) ON CONFLICT(week_start, pool) DO UPDATE SET used = used + excluded.used",
      weekStart(now),
      pool,
      tokens,
    );
  }

  // ─── Billing ──────────────────────────────────────────────────────────────

  #billing(): BillingState & { stateAt: number } {
    const row = this.ctx.storage.sql
      .exec<{ customer_id: string | null; subscription_id: string | null; pro_state: BillingState["proState"]; period_end: number | null; cancel_at_period_end: number; state_at: number }>(
        "SELECT * FROM billing WHERE k = 1",
      )
      .toArray()[0];
    return {
      customerId: row?.customer_id ?? null,
      subscriptionId: row?.subscription_id ?? null,
      proState: row?.pro_state ?? "none",
      periodEnd: row?.period_end ?? null,
      cancelAtPeriodEnd: row?.cancel_at_period_end === 1,
      stateAt: row?.state_at ?? 0,
    };
  }

  /** Pro while the subscription is active and its paid period (plus a grace) hasn't ended. */
  #plan(now: number): Plan {
    const billing = this.#billing();
    return billing.proState === "active" && (billing.periodEnd === null || now < billing.periodEnd + PRO_GRACE_MS) ? "pro" : "free";
  }

  /** "pro" or "free" now (see #plan). */
  async plan(now: number): Promise<Plan> {
    return this.#plan(now);
  }

  async billing(): Promise<BillingState> {
    const { stateAt: _stateAt, ...state } = this.#billing();
    return state;
  }

  async setCustomer(customerId: string): Promise<void> {
    this.ctx.storage.sql.exec("INSERT INTO billing (k, customer_id) VALUES (1, ?) ON CONFLICT(k) DO UPDATE SET customer_id = excluded.customer_id", customerId);
  }

  /**
   * Applies a subscription state from a webhook. Ignored when an event newer than this one was
   * applied already, or when it is about another subscription than the current one and doesn't
   * start it (a late cancel of an old subscription can't end a new one). A failed payment is
   * `past_due`: back to free, never to no access.
   */
  async applySubscription(input: {
    subscriptionId: string;
    state: "active" | "past_due" | "canceled";
    periodEnd: number | null | undefined;
    cancelAtPeriodEnd?: boolean;
    customerId?: string;
    eventAt: number;
  }): Promise<boolean> {
    const current = this.#billing();
    if (input.eventAt < current.stateAt) return false;
    if (current.subscriptionId && current.subscriptionId !== input.subscriptionId && input.state !== "active" && current.proState === "active") return false;
    this.ctx.storage.sql.exec(
      `INSERT INTO billing (k, customer_id, subscription_id, pro_state, period_end, cancel_at_period_end, state_at) VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(k) DO UPDATE SET customer_id = COALESCE(excluded.customer_id, customer_id), subscription_id = excluded.subscription_id,
         pro_state = excluded.pro_state, period_end = COALESCE(excluded.period_end, period_end),
         cancel_at_period_end = excluded.cancel_at_period_end, state_at = excluded.state_at`,
      input.customerId ?? current.customerId,
      input.subscriptionId,
      input.state,
      input.periodEnd === undefined ? null : input.periodEnd,
      input.cancelAtPeriodEnd ? 1 : 0,
      input.eventAt,
    );
    return true;
  }

  /** Adds a dollar top-up (usage dollars) once per id (the Checkout Session). False when it was already added. */
  async grantCredit(input: { id: string; usd: number; createdAt: number; expiresAt: number }): Promise<boolean> {
    return (
      this.ctx.storage.sql
        .exec(
          "INSERT INTO topups (id, tokens, used, created_at, expires_at, usd, used_usd) VALUES (?, 0, 0, ?, ?, ?, 0) ON CONFLICT(id) DO NOTHING RETURNING id",
          input.id,
          input.createdAt,
          input.expiresAt,
          input.usd,
        )
        .toArray().length > 0
    );
  }

  /** Adds a token top-up (the old product) once per id (the Checkout Session). False when it was already added. */
  async grantTopup(input: { id: string; tokens: number; createdAt: number; expiresAt: number }): Promise<boolean> {
    return (
      this.ctx.storage.sql
        .exec("INSERT INTO topups (id, tokens, used, created_at, expires_at) VALUES (?, ?, 0, ?, ?) ON CONFLICT(id) DO NOTHING RETURNING id", input.id, input.tokens, input.createdAt, input.expiresAt)
        .toArray().length > 0
    );
  }

  async setStatus(status: AccountStatus): Promise<boolean> {
    const row = this.#row();
    if (!row) return false;
    this.ctx.storage.sql.exec("UPDATE account SET status = ? WHERE github_id = ?", status, row.github_id);
    return true;
  }

  /**
   * Admin: per-person weekly caps (null = back to the default; undefined = unchanged) and
   * optionally this week's counters.
   */
  async setGrant(input: {
    tokensPerWeek: number | null | undefined;
    usdPerWeek: number | null | undefined;
    usedThisWeek: number | undefined;
    /** GPT-6's spend this week (the budget the older fields describe). */
    spentUsdThisWeek: number | undefined;
    /** DeepSeek's spend this week. */
    deepseekSpentUsdThisWeek?: number | undefined;
    limits: Limits;
    now: number;
  }): Promise<Allowance | undefined> {
    const row = this.#current(input.now);
    if (!row) return undefined;
    const sql = this.ctx.storage.sql;
    if (input.tokensPerWeek !== undefined) sql.exec("UPDATE account SET weekly_tokens = ? WHERE github_id = ?", input.tokensPerWeek, row.github_id);
    if (input.usdPerWeek !== undefined) sql.exec("UPDATE account SET weekly_usd = ? WHERE github_id = ?", input.usdPerWeek, row.github_id);
    if (input.usedThisWeek !== undefined) {
      sql.exec("UPDATE account SET used = ? WHERE github_id = ?", input.usedThisWeek, row.github_id);
      // The Luna pool is the one the weekly grant covers, so its counter is what the admin set.
      sql.exec(
        "INSERT INTO pool_usage (week_start, pool, used) VALUES (?, 'luna', ?) ON CONFLICT(week_start, pool) DO UPDATE SET used = excluded.used",
        weekStart(input.now),
        input.usedThisWeek,
      );
    }
    // cost_used is the total: setting one family's spend keeps the other's.
    if (input.deepseekSpentUsdThisWeek !== undefined) {
      sql.exec("UPDATE account SET cost_used = MAX(0, cost_used - cost_used_deepseek) + ?, cost_used_deepseek = ? WHERE github_id = ?", input.deepseekSpentUsdThisWeek, input.deepseekSpentUsdThisWeek, row.github_id);
    }
    if (input.spentUsdThisWeek !== undefined) sql.exec("UPDATE account SET cost_used = cost_used_deepseek + ? WHERE github_id = ?", input.spentUsdThisWeek, row.github_id);
    return this.#allowance(this.#current(input.now), input.now, input.limits);
  }

  /**
   * Admin grant: raises the personal weekly dollar cap to `usd`, never lowering a higher one
   * already set. Returns the personal cap now in place, or undefined for no account.
   */
  async raiseUsdCap(usd: number): Promise<number | undefined> {
    const row = this.#row();
    if (!row) return undefined;
    if (row.weekly_usd !== null && row.weekly_usd >= usd) return row.weekly_usd;
    this.ctx.storage.sql.exec("UPDATE account SET weekly_usd = ? WHERE github_id = ?", usd, row.github_id);
    return usd;
  }

  // ─── Sessions and server keys ─────────────────────────────────────────────

  /**
   * Stops access tokens of these sign-in sessions (refresh-token families) from working before
   * they expire. `until` is when the last of them would have expired anyway. `notBefore`
   * (Unix seconds) also stops older access tokens that carry no session id.
   */
  async revokeSessions(input: { sids: string[]; until: number; notBefore?: number; now: number }): Promise<void> {
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM revoked_sessions WHERE expires_at <= ?", input.now);
      for (const sid of input.sids) {
        sql.exec("INSERT INTO revoked_sessions (sid, expires_at) VALUES (?, ?) ON CONFLICT(sid) DO UPDATE SET expires_at = MAX(expires_at, excluded.expires_at)", sid, input.until);
        // Harness keys minted from that sign-in end with it (they can outlive the record above).
        sql.exec("DELETE FROM harness_keys WHERE sid = ?", sid);
      }
      if (input.notBefore !== undefined) sql.exec("DELETE FROM harness_keys WHERE sid IS NULL");
      if (input.notBefore !== undefined) {
        sql.exec("INSERT INTO meta (key, value) VALUES ('not_before', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(input.notBefore));
      }
    });
  }

  /** Whether an access token from session `sid`, issued at `iat` (Unix seconds), still counts. */
  async sessionAllowed(sid: string | undefined, iat: number): Promise<boolean> {
    if (sid !== undefined) return this.ctx.storage.sql.exec("SELECT 1 FROM revoked_sessions WHERE sid = ?", sid).toArray().length === 0;
    const notBefore = Number(this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'not_before'").toArray()[0]?.value ?? "0");
    return iat > notBefore;
  }

  /**
   * Creates a named key of one kind (a server key unless said). The secret is returned here once;
   * only its hash is kept. `max`: that kind's keys per account (MAX_SERVER_KEYS for server keys).
   */
  async createKey(input: { name: string; now: number; kind?: KeyKind; max?: number }): Promise<CreateKeyResult> {
    const row = this.#row();
    if (!row) return { ok: false, code: "not_invited" };
    if (row.status === "blocked") return { ok: false, code: "blocked" };
    if (row.status === "suspended") return { ok: false, code: "suspended" };
    const kind = input.kind ?? "server";
    const max = input.max ?? MAX_SERVER_KEYS;
    const sql = this.ctx.storage.sql;
    if ((await this.keyCount(kind)) >= max) return { ok: false, code: "key_limit_reached", max };
    if (sql.exec("SELECT 1 FROM server_keys WHERE name = ?", input.name).toArray().length > 0) return { ok: false, code: "key_name_taken" };
    const id = [...crypto.getRandomValues(new Uint8Array(6))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const secret = randomToken();
    sql.exec("INSERT INTO server_keys (id, name, key_hash, created_at, kind) VALUES (?, ?, ?, ?, ?)", id, input.name, await sha256Hex(secret), input.now, kind);
    return { ok: true, key: `dlk_${row.github_id}_${id}_${secret}`, view: { id, name: input.name, kind, createdAt: input.now, lastUsedAt: null, lastTool: null } };
  }

  async listKeys(): Promise<ServerKeyView[]> {
    return this.ctx.storage.sql
      .exec<{ id: string; name: string; kind: string; created_at: number; last_used_at: number | null; last_tool: string | null }>(
        "SELECT id, name, kind, created_at, last_used_at, last_tool FROM server_keys ORDER BY created_at, id",
      )
      .toArray()
      .map((key) => {
        const kind = keyKind(key.kind);
        return { id: key.id, name: key.name, kind, createdAt: key.created_at, lastUsedAt: key.last_used_at, lastTool: kind === "tool" ? key.last_tool : null };
      });
  }

  /** The allowance and the key counts in one call, for the admin people list (one RPC per person, not two). */
  async adminSummary(now: number, limits: Limits): Promise<{ allowance: Allowance; serverKeys: number; toolKeys: number }> {
    return { allowance: this.#allowance(this.#current(now), now, limits), serverKeys: await this.keyCount("server"), toolKeys: await this.keyCount("tool") };
  }

  /** How many keys of one kind (server keys unless said) the account has. */
  async keyCount(kind: KeyKind = "server"): Promise<number> {
    return this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM server_keys WHERE kind = ?", kind).toArray()[0]?.n ?? 0;
  }

  /** Deletes one key (only of `kind` when given); false when there is no such key. */
  async revokeKey(id: string, kind?: KeyKind): Promise<boolean> {
    const found = (kind === undefined ? this.ctx.storage.sql.exec("SELECT 1 FROM server_keys WHERE id = ?", id) : this.ctx.storage.sql.exec("SELECT 1 FROM server_keys WHERE id = ? AND kind = ?", id, kind)).toArray().length > 0;
    if (found) this.ctx.storage.sql.exec("DELETE FROM server_keys WHERE id = ?", id);
    return found;
  }

  /** Deletes every key, server and tool (and every harness key); returns how many there were. */
  async revokeAllKeys(): Promise<number> {
    const count = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM server_keys").toArray()[0]?.n ?? 0;
    this.ctx.storage.sql.exec("DELETE FROM server_keys");
    this.ctx.storage.sql.exec("DELETE FROM harness_keys");
    return count;
  }

  /** Mints a harness key for one dl session (see HARNESS_KEY). The secret is returned here once. */
  async createHarnessKey(input: { harness: Harness; sid: string | undefined; now: number }): Promise<CreateHarnessKeyResult> {
    const row = this.#row();
    if (!row) return { ok: false, code: "not_invited" };
    if (row.status === "blocked") return { ok: false, code: "blocked" };
    if (row.status === "suspended") return { ok: false, code: "suspended" };
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM harness_keys WHERE expires_at <= ?", input.now);
    const live = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM harness_keys").toArray()[0]?.n ?? 0;
    if (live >= MAX_HARNESS_KEYS) return { ok: false, code: "harness_key_limit" };
    const id = [...crypto.getRandomValues(new Uint8Array(6))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const secret = randomToken();
    const expiresAt = input.now + HARNESS_KEY_TTL_MS;
    sql.exec("INSERT INTO harness_keys (id, harness, key_hash, sid, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)", id, input.harness, await sha256Hex(secret), input.sid ?? null, input.now, expiresAt);
    return { ok: true, id, key: `dlh_${row.github_id}_${id}_${secret}`, expiresAt };
  }

  /** Pushes a live harness key's expiry out again; undefined when it is unknown or expired. */
  async refreshHarnessKey(id: string, now: number): Promise<number | undefined> {
    const sql = this.ctx.storage.sql;
    const found = sql.exec<{ expires_at: number }>("SELECT expires_at FROM harness_keys WHERE id = ?", id).toArray()[0];
    if (!found || found.expires_at <= now) return undefined;
    const expiresAt = now + HARNESS_KEY_TTL_MS;
    sql.exec("UPDATE harness_keys SET expires_at = ? WHERE id = ?", expiresAt, id);
    return expiresAt;
  }

  /** Deletes one harness key; false when there was none. */
  async revokeHarnessKey(id: string): Promise<boolean> {
    const found = this.ctx.storage.sql.exec("SELECT 1 FROM harness_keys WHERE id = ?", id).toArray().length > 0;
    if (found) this.ctx.storage.sql.exec("DELETE FROM harness_keys WHERE id = ?", id);
    return found;
  }

  /**
   * The account behind a live harness key, its harness and the sign-in session it was minted
   * from; undefined when the key is unknown, wrong, expired, or its sign-in session was revoked.
   */
  async verifyHarnessKey(id: string, secret: string, now: number): Promise<{ githubId: number; login: string; harness: Harness; sid?: string } | undefined> {
    const row = this.#row();
    const key = this.ctx.storage.sql
      .exec<{ key_hash: string; harness: string; sid: string | null; expires_at: number }>("SELECT key_hash, harness, sid, expires_at FROM harness_keys WHERE id = ?", id)
      .toArray()[0];
    if (!row || !key || key.expires_at <= now || !timingSafeEqual(await sha256Hex(secret), key.key_hash)) return undefined;
    if (!(HARNESSES as readonly string[]).includes(key.harness)) return undefined;
    if (key.sid !== null && this.ctx.storage.sql.exec("SELECT 1 FROM revoked_sessions WHERE sid = ?", key.sid).toArray().length > 0) return undefined;
    return { githubId: row.github_id, login: row.login, harness: key.harness as Harness, ...(key.sid !== null ? { sid: key.sid } : {}) };
  }

  /**
   * The account behind a key and the key's kind, or undefined when the key is unknown or revoked.
   * `tool`: the tool the request came from (tool-keys.ts toolName), kept on a tool key as its last tool.
   */
  async verifyKey(id: string, secret: string, now: number, tool?: string): Promise<{ githubId: number; login: string; kind: KeyKind } | undefined> {
    const row = this.#row();
    const key = this.ctx.storage.sql
      .exec<{ key_hash: string; kind: string; last_used_at: number | null; last_tool: string | null }>("SELECT key_hash, kind, last_used_at, last_tool FROM server_keys WHERE id = ?", id)
      .toArray()[0];
    if (!row || !key || !timingSafeEqual(await sha256Hex(secret), key.key_hash)) return undefined;
    const kind = keyKind(key.kind);
    const lastTool = kind === "tool" && tool !== undefined ? tool.slice(0, 32) : key.last_tool;
    if (key.last_used_at === null || now - key.last_used_at >= KEY_TOUCH_MS) {
      this.ctx.storage.sql.exec("UPDATE server_keys SET last_used_at = ?, last_tool = ? WHERE id = ?", now, lastTool, id);
    } else if (lastTool !== key.last_tool) {
      this.ctx.storage.sql.exec("UPDATE server_keys SET last_tool = ? WHERE id = ?", lastTool, id);
    }
    return { githubId: row.github_id, login: row.login, kind };
  }

  /**
   * Settles reservations that outlived any request, and logs them as abandoned. That happens
   * when the caller hangs up before the upstream answers: Workers stops the handler there, so
   * it never settles. Nothing reached the person, so they are charged nothing; the upstream
   * most likely read the prompt, so the provider's credit is recorded a realistic estimate of it.
   * The record names the provider that was serving it.
   */
  async alarm(): Promise<void> {
    await this.sweep(Date.now());
  }

  async sweep(now: number): Promise<number> {
    const row = this.#current(now);
    const stale = this.ctx.storage.sql
      .exec<{ id: string; amount: number; created_at: number; source: Source; paid: number; pool: Pool; provider: Upstream | null; model: string | null; prompt_estimate: number | null }>(
        "SELECT id, amount, created_at, source, paid, pool, provider, model, prompt_estimate FROM reservations WHERE expires_at <= ?",
        now,
      )
      .toArray();
    for (const reservation of stale) {
      const model = modelById(reservation.model ?? DEFAULT_MODEL);
      // Nothing reached the person, so nothing is charged to them. The upstream most likely read
      // the prompt, so the provider's credit is recorded a realistic prompt at its prices (Open
      // Relay doesn't bill a request it didn't finish).
      const prompt = row ? this.#estimate(row, reservation.prompt_estimate ?? 0, 0).prompt : undefined;
      // Reservations made before the provider was kept were all served on Luminal or OpenAI
      // (OpenRouter served nothing by then): never record them as OpenRouter cash.
      const provider: Upstream = reservation.provider ?? (model?.provider === "openai" ? "openai" : "luminal");
      const creditUsd = provider !== "openrouter" && provider !== "openrelay" && model && prompt ? costAtPrices(prompt, creditPrices(model)) : 0;
      this.ctx.storage.transactionSync(() => {
        if (row) this.#charge(row.github_id, reservation.id, reservation.source, reservation.pool, 0, 0, now);
        else this.ctx.storage.sql.exec("DELETE FROM reservations WHERE id = ?", reservation.id);
      });
      if (row && this.env.DIRECTORY) {
        await this.env.DIRECTORY.getByName("directory").recordRequest({
          githubId: row.github_id,
          isAdmin: row.is_admin === 1,
          at: reservation.created_at,
          model: model?.id ?? DEFAULT_MODEL,
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 0,
          chargedTokens: 0,
          costUsd: 0,
          status: "abandoned",
          latencyMs: null,
          upstream: provider,
          creditUsd,
          ...(reservation.paid === 1 ? { paid: true } : {}),
          family: familyOfPool(reservation.pool),
        });
      }
    }
    const next = this.ctx.storage.sql.exec<{ next: number | null }>("SELECT MIN(expires_at) AS next FROM reservations").toArray()[0]?.next;
    if (next === null || next === undefined) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
    return stale.length;
  }

  /**
   * Reservations in flight from one source and their estimated cost: weekly ones count toward
   * their family's weekly dollar budget (`family`), "credit" ones toward the dollar top-up balance.
   */
  #inFlight(source: Source, family?: Family): { count: number; usd: number } {
    const sql = this.ctx.storage.sql;
    const row = (
      family === undefined
        ? sql.exec<{ n: number; usd: number | null }>("SELECT COUNT(*) AS n, SUM(cost_estimate) AS usd FROM reservations WHERE source = ?", source)
        : sql.exec<{ n: number; usd: number | null }>(
            "SELECT COUNT(*) AS n, SUM(cost_estimate) AS usd FROM reservations WHERE source = ? AND (pool = 'deepseek') = ?",
            source,
            family === "deepseek" ? 1 : 0,
          )
    ).toArray()[0];
    return { count: row?.n ?? 0, usd: row?.usd ?? 0 };
  }

  /** Unexpired dollar top-up usage not yet spent (in-flight estimates not taken off). */
  #creditLeft(now: number): number {
    return this.ctx.storage.sql.exec<{ left: number | null }>("SELECT SUM(usd - used_usd) AS left FROM topups WHERE usd IS NOT NULL AND expires_at > ?", now).toArray()[0]?.left ?? 0;
  }

  #row(): AccountRow | undefined {
    return this.ctx.storage.sql.exec<AccountRow>("SELECT * FROM account LIMIT 1").toArray()[0];
  }

  /** The account with the week rolled forward to `now`. */
  #current(now: number): AccountRow | undefined {
    const row = this.#row();
    if (!row) return undefined;
    const start = weekStart(now);
    if (row.week_start < start) {
      this.ctx.storage.sql.exec("UPDATE account SET week_start = ?, used = 0, cost_used = 0, cost_used_deepseek = 0 WHERE github_id = ?", start, row.github_id);
      this.ctx.storage.sql.exec("DELETE FROM pool_usage WHERE week_start < ?", start);
      this.ctx.storage.sql.exec("DELETE FROM family_tokens WHERE week_start < ?", start);
      return { ...row, week_start: start, used: 0, cost_used: 0, cost_used_deepseek: 0 };
    }
    return row;
  }

  #allowance(row: AccountRow | undefined, now: number, limits: Limits, pool: Pool = "luna"): Allowance {
    const sql = this.ctx.storage.sql;
    const reservedBy = (source: Source) => sql.exec<{ total: number | null }>("SELECT SUM(amount) AS total FROM reservations WHERE source = ?", source).toArray()[0]?.total ?? 0;
    const plan = row ? this.#plan(now) : "free";
    const billing = this.#billing();
    const topups = sql.exec<{ left: number | null }>("SELECT SUM(tokens - used) AS left FROM topups WHERE expires_at > ?", now).toArray()[0]?.left ?? 0;
    const topupTokensLeft = Math.max(0, topups - reservedBy("topup"));
    const topupUsdLeft = Math.max(0, Math.round((this.#creditLeft(now) - this.#inFlight("credit").usd) * 1e6) / 1e6);
    const topupUsdExpiresAt =
      sql.exec<{ at: number | null }>("SELECT MIN(expires_at) AS at FROM topups WHERE usd IS NOT NULL AND expires_at > ? AND used_usd < usd", now).toArray()[0]?.at ?? null;
    const pro = plan === "pro";
    // Pro replaces the free allowance (no referral bonus: that is free tokens); grants apply to free.
    const bonus = pro ? 0 : Math.max(0, limits.bonusTokens ?? 0);
    // Pro is exempt: a subscriber gets the whole Pro allowance in other coding agents too.
    const share = pro || limits.harnessShare === undefined ? 1 : Math.min(1, Math.max(0, limits.harnessShare));
    const unscaled = this.#pools(row, now, limits, plan, bonus);
    const pools = scalePools(unscaled, share);
    const mine = pools[pool];
    const family = familyOfPool(pool);
    const budgets = scaleBudgets(this.#budgets(row, now, limits, pro, bonus, unscaled.luna.tokensPerWeek), share);
    const { usdPerWeek, spentUsd: spent } = budgets[family];
    const spendLeft = usdPerWeek === null || spent < usdPerWeek;
    const trial = scaleTrial(this.#trial(row, limits), share);
    // On the free plan the trial is a limit like the week's: `remaining` is the smaller of the two.
    const own = row && spendLeft ? mine.remaining : 0;
    const remaining = trial && plan === "free" && own !== 0 ? Math.min(own ?? Number.MAX_SAFE_INTEGER, trial.remaining) : own;
    return {
      exists: row !== undefined,
      plan,
      topupTokensLeft,
      topupUsdLeft,
      topupUsdExpiresAt,
      proPeriodEnd: billing.periodEnd,
      proCancelAtPeriodEnd: billing.cancelAtPeriodEnd,
      status: row?.status ?? null,
      isAdmin: row?.is_admin === 1,
      tokensPerWeek: mine.tokensPerWeek,
      usedThisWeek: mine.usedThisWeek,
      reserved: mine.reserved,
      remaining,
      family,
      usdPerWeek,
      spentUsdThisWeek: spent,
      resetsAt: weekEnd(now),
      pools,
      budgets,
      trial,
    };
  }

  /** The trial's state for an account on trial; null for everyone else (grandfathered, admins, the trial off). */
  #trial(row: AccountRow | undefined, limits: Limits): TrialState | null {
    if (!row || limits.trialTokens === undefined || row.is_admin === 1) return null;
    const tokens = Math.max(0, limits.trialTokens);
    const used = row.trial_used ?? 0;
    const reserved =
      this.ctx.storage.sql.exec<{ total: number | null }>("SELECT SUM(amount) AS total FROM reservations WHERE source = 'weekly' AND paid = 0").toArray()[0]?.total ?? 0;
    return { tokens, used, reserved, remaining: Math.max(0, tokens - used - reserved), ended: tokens - used < MIN_OUTPUT_TOKENS };
  }

  /**
   * Both weekly dollar budgets. GPT-6's is the level's cap (the same on Pro), replaced by a personal cap
   * when an admin set one, and grown by the referral bonus in the same proportion as the Luna
   * pool. DeepSeek's is its own level's (or Pro's larger) budget; a personal cap gives it the larger of
   * the personal cap and that budget, so a grant never leaves DeepSeek below the level.
   */
  #budgets(row: AccountRow | undefined, now: number, limits: Limits, pro: boolean, bonus: number, lunaTokens: number | null): Record<Family, FamilyBudget> {
    const personal = pro ? null : (row?.weekly_usd ?? null);
    // GPT-6 on Pro is exactly what the free plan gets (a personal cap included): Pro buys more
    // open models, never GPT-6.
    const gptBase = (row?.weekly_usd ?? null) ?? limits.weeklyUsd ?? null;
    const gpt6 = gptBase !== null && bonus > 0 && lunaTokens !== null && lunaTokens > bonus ? Math.round(gptBase * (lunaTokens / (lunaTokens - bonus)) * 1e6) / 1e6 : gptBase;
    const levelDeepseek = pro
      ? limits.proDeepseekUsdPerWeek === undefined
        ? limits.deepseekWeeklyUsd === undefined
          ? (limits.weeklyUsd ?? null)
          : limits.deepseekWeeklyUsd
        : limits.proDeepseekUsdPerWeek
      : limits.deepseekWeeklyUsd === undefined
        ? (limits.weeklyUsd ?? null)
        : limits.deepseekWeeklyUsd;
    const deepseek = levelDeepseek === null ? null : personal === null ? levelDeepseek : Math.max(personal, levelDeepseek);
    const total = row?.cost_used ?? 0;
    const deepseekSpent = row?.cost_used_deepseek ?? 0;
    const round = (usd: number) => Math.round(usd * 1e6) / 1e6;
    const tokens = new Map(
      this.ctx.storage.sql.exec<{ family: string; tokens: number }>("SELECT family, tokens FROM family_tokens WHERE week_start = ?", weekStart(now)).toArray().map((r) => [r.family, r.tokens]),
    );
    const out = {} as Record<Family, FamilyBudget>;
    for (const family of FAMILIES) {
      const tokensThisWeek = row ? (tokens.get(family) ?? 0) : 0;
      out[family] =
        family === "gpt6"
          ? { usdPerWeek: gpt6, spentUsd: round(Math.max(0, total - deepseekSpent)), tokensThisWeek }
          : { usdPerWeek: deepseek, spentUsd: round(deepseekSpent), tokensThisWeek };
    }
    return out;
  }

  /**
   * Every pool's allowance this week. The Luna pool is the one the weekly grant and the
   * referral bonus apply to (it is the free tier's default model); Sol and Astra keep their
   * own fixed grants. Pro's weekly tokens replace the Luna grant, as before. DeepSeek has no
   * token cap (null) on Full: its dollar budget is its limit. Basic and Starter get their level's
   * weekly tokens on DeepSeek as well (0 for a batch-flagged Starter account).
   */
  #pools(row: AccountRow | undefined, now: number, limits: Limits, plan: Plan, bonus: number): Record<Pool, PoolAllowance> {
    const sql = this.ctx.storage.sql;
    const start = weekStart(now);
    const out = {} as Record<Pool, PoolAllowance>;
    for (const pool of POOLS) {
      const used = sql.exec<{ used: number }>("SELECT used FROM pool_usage WHERE week_start = ? AND pool = ?", start, pool).toArray()[0]?.used ?? 0;
      const reserved = sql.exec<{ total: number | null }>("SELECT SUM(amount) AS total FROM reservations WHERE pool = ? AND source = 'weekly'", pool).toArray()[0]?.total ?? 0;
      // A basic or Starter account gets every model on its level's smaller allowance: each pool
      // at the level's tokens, Sol and Astra no more than their own grants. Pro replaces the
      // level, as it replaces the free allowance.
      const limited = (limits.level === "starter" || limits.level === "basic") && plan !== "pro";
      const levelTokens = Math.max(0, limits.levelTokens ?? 0);
      const fixed = POOL_TOKENS[pool];
      if (fixed === null) {
        // Full: no token cap (the dollar budget is the limit). Basic and Starter: their level's
        // weekly tokens, so the three levels get 3 different allowances on DeepSeek too.
        const tokensPerWeek = limited ? levelTokens : null;
        out[pool] = { tokensPerWeek, usedThisWeek: used, reserved, remaining: tokensPerWeek === null ? null : Math.max(0, tokensPerWeek - used - reserved) };
        continue;
      }
      const base =
        pool === "luna"
          ? plan === "pro"
            ? (limits.proTokensPerWeek ?? limits.weeklyTokens)
            : limited
              ? levelTokens
              : (row?.weekly_tokens ?? limits.weeklyTokens)
          : limited
            ? Math.min(fixed, levelTokens)
            : fixed;
      // The referral bonus is for Full only, as it was before the smaller levels had every model.
      const tokensPerWeek = pool === "luna" && !limited ? base + bonus : base;
      out[pool] = { tokensPerWeek, usedThisWeek: used, reserved, remaining: Math.max(0, tokensPerWeek - used - reserved) };
    }
    return out;
  }
}

/** `harnessShare` (see Limits): each token pool's weekly tokens scaled, what is used counted in full. */
function scalePools(pools: Record<Pool, PoolAllowance>, share: number): Record<Pool, PoolAllowance> {
  if (share === 1) return pools;
  const out = {} as Record<Pool, PoolAllowance>;
  for (const pool of POOLS) {
    const p = pools[pool];
    const tokensPerWeek = p.tokensPerWeek === null ? null : Math.floor(p.tokensPerWeek * share);
    out[pool] = { ...p, tokensPerWeek, remaining: tokensPerWeek === null ? null : Math.max(0, tokensPerWeek - p.usedThisWeek - p.reserved) };
  }
  return out;
}

/** `harnessShare`: both weekly dollar budgets scaled; null (no cap) stays null. */
function scaleBudgets(budgets: Record<Family, FamilyBudget>, share: number): Record<Family, FamilyBudget> {
  if (share === 1) return budgets;
  const out = {} as Record<Family, FamilyBudget>;
  for (const family of FAMILIES) {
    const b = budgets[family];
    out[family] = { ...b, usdPerWeek: b.usdPerWeek === null ? null : Math.round(b.usdPerWeek * share * 1e6) / 1e6 };
  }
  return out;
}

/** `harnessShare`: the trial's tokens scaled, what it has used counted in full. */
function scaleTrial(trial: TrialState | null, share: number): TrialState | null {
  if (!trial || share === 1) return trial;
  const tokens = Math.floor(trial.tokens * share);
  return { ...trial, tokens, remaining: Math.max(0, tokens - trial.used - trial.reserved), ended: tokens - trial.used < MIN_OUTPUT_TOKENS };
}
