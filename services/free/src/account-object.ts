import { DurableObject, type DurableObjectNamespace, type DurableObjectState } from "cloudflare:workers";
import { randomToken, sha256Hex, timingSafeEqual } from "../../shared/src/auth.js";
import type { DirectoryObject } from "./directory-object.js";
import { DEFAULT_MODEL, POOLS, POOL_TOKENS, creditPrices, modelById, type Pool } from "./models.js";
import type { Upstream } from "./config.js";
import type { Level } from "./admission.js";
import { FALLBACK_USD_PER_MILLION_TOKENS, costAtPrices, costOf, estimateCostUsd, planReservation } from "./quota.js";
import { weekEnd, weekStart } from "./week.js";

/**
 * One person's allowance: `getByName("gh:<githubId>")`. The single serialization point for
 * reserve and settle, so two concurrent requests can't both spend the last tokens. The week
 * rolls over lazily on the first call after Monday 00:00 UTC; no timer is needed for that.
 * The alarm only settles reservations whose request never came back (a crash or a dropped
 * connection), charging them in full.
 */

export const RESERVATION_TTL_MS = 30 * 60_000;
/** Pro stays on this long past the paid period's end, so a renewal webhook that runs late doesn't cut anyone off. */
export const PRO_GRACE_MS = 3 * 86_400_000;
/** Server keys per account. */
export const MAX_SERVER_KEYS = 5;
/** `last_used_at` is written at most this often per key. */
const KEY_TOUCH_MS = 60_000;

/** `dlk_<githubId>_<id>_<secret>`: the GitHub id routes to this object; only the secret's hash is stored. */
const SERVER_KEY = /^dlk_([1-9][0-9]{0,15})_([a-z0-9]{12})_([A-Za-z0-9_-]{43})$/;

export function parseServerKey(key: string): { githubId: number; id: string; secret: string } | undefined {
  const match = SERVER_KEY.exec(key);
  if (!match) return undefined;
  const githubId = Number(match[1]);
  return Number.isSafeInteger(githubId) ? { githubId, id: match[2]!, secret: match[3]! } : undefined;
}

export interface ServerKeyView {
  id: string;
  name: string;
  /** Unix ms. */
  createdAt: number;
  /** Unix ms, to the minute; null when never used. */
  lastUsedAt: number | null;
}

export type CreateKeyResult =
  | { ok: true; key: string; view: ServerKeyView }
  | { ok: false; code: "not_invited" | "suspended" | "blocked" | "key_limit_reached" | "key_name_taken" };

export interface AccountEnv {
  DIRECTORY?: DurableObjectNamespace<DirectoryObject>;
}

/** "blocked": an admin blocked the account for abuse (stronger than a suspension: no refresh, no sign-in). */
export type AccountStatus = "active" | "suspended" | "blocked";

export type Plan = "free" | "pro";
/** Where a request's tokens come from: the weekly allowance (free or Pro), or top-ups. */
export type Source = "weekly" | "topup";

/** One weekly token allowance: what a model's tokens come from. */
export interface PoolAllowance {
  tokensPerWeek: number;
  usedThisWeek: number;
  reserved: number;
  remaining: number;
}

export interface Allowance {
  exists: boolean;
  plan: Plan;
  /** Unexpired top-up tokens not yet used or held. */
  topupTokensLeft: number;
  /** Pro's paid period end (Unix ms), or null. */
  proPeriodEnd: number | null;
  proCancelAtPeriodEnd: boolean;
  status: AccountStatus | null;
  isAdmin: boolean;
  tokensPerWeek: number;
  usedThisWeek: number;
  reserved: number;
  remaining: number;
  /** The weekly spend cap in USD, or null for none. */
  usdPerWeek: number | null;
  spentUsdThisWeek: number;
  /** Unix ms. */
  resetsAt: number;
  /** Every pool's allowance, so a client can show what each model has left. */
  pools: Record<Pool, PoolAllowance>;
}

export type ReserveResult =
  | { ok: true; reservationId: string; amount: number; maxTokens: number; source: Source; paid: boolean; allowance: Allowance }
  | { ok: false; code: "not_invited" | "suspended" | "blocked"; allowance: Allowance }
  | { ok: false; code: "quota_exceeded"; reason: "tokens" | "spend"; allowance: Allowance };

/** Caps a call applies; per-person overrides set by an admin win over these. */
export interface Limits {
  weeklyTokens: number;
  weeklyUsd: number | undefined;
  /**
   * This week's referral bonus, added on top of the weekly tokens (default or grant). The USD
   * allowance grows in the same proportion, so the bonus isn't cut short by the dollar cap.
   */
  bonusTokens?: number;
  /** Pro's weekly tokens and dollar ceiling (none when undefined). */
  proTokensPerWeek?: number;
  proUsdPerWeek?: number | undefined;
  /**
   * Free tokens are unavailable to a free-plan person for now (queued, or a global cap reached):
   * their requests can use top-ups only. Pro is unaffected.
   */
  freeBlocked?: boolean;
  /**
   * "basic" and "starter" put every pool at `levelTokens` (Sol and Astra at most their own
   * fixed grants): every model, a smaller allowance. The dollar cap for the level comes in
   * `weeklyUsd`. Pro is unaffected.
   */
  level?: Level;
  /** A basic or Starter account's weekly tokens (BASIC_WEEKLY_TOKENS or STARTER_WEEKLY_TOKENS; 0 for a batch-flagged Starter). */
  levelTokens?: number;
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
  cost_used: number;
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
   * case). The dollar cap counts what is settled plus the estimated cost of every weekly
   * reservation still in flight (`estimateCostUsd`): a request whose estimate doesn't fit next
   * to those is refused, so parallel requests can't run past the cap together. A request with
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
  }): Promise<ReserveResult> {
    const pool = input.pool ?? "luna";
    const row = this.#current(input.now);
    const before = this.#allowance(row, input.now, input.limits, pool);
    if (!row) return { ok: false, code: "not_invited", allowance: before };
    if (row.status === "blocked") return { ok: false, code: "blocked", allowance: before };
    if (row.status === "suspended") return { ok: false, code: "suspended", allowance: before };
    // The weekly allowance first (free or Pro), then top-ups.
    const spendReached = before.usdPerWeek !== null && before.spentUsdThisWeek >= before.usdPerWeek;
    const weeklyRoom = spendReached || (before.plan === "free" && input.limits.freeBlocked) ? 0 : before.remaining;
    const model = modelById(input.model ?? DEFAULT_MODEL);
    const estimate = (maxTokens: number) =>
      model ? estimateCostUsd(input.promptEstimate, maxTokens, model.prices) : ((Math.max(0, input.promptEstimate) + maxTokens) * FALLBACK_USD_PER_MILLION_TOKENS) / 1_000_000;
    let source: Source = "weekly";
    let plan = planReservation(input.promptEstimate, input.requestedMaxTokens, weeklyRoom);
    let spendFull = false;
    if (plan && before.usdPerWeek !== null) {
      const inFlight = this.#inFlightWeekly();
      spendFull = inFlight.count > 0 && before.spentUsdThisWeek + inFlight.usd + estimate(plan.maxTokens) > before.usdPerWeek;
      if (spendFull) plan = undefined;
    }
    if (!plan) {
      source = "topup";
      plan = planReservation(input.promptEstimate, input.requestedMaxTokens, before.topupTokensLeft);
    }
    if (!plan) return { ok: false, code: "quota_exceeded", reason: spendReached || spendFull ? "spend" : "tokens", allowance: before };
    const paid = source === "topup" || before.plan === "pro";
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
   * Replaces a reservation with what was really used. `charged` undefined means the provider
   * reported nothing, so the whole reservation is charged. A reservation the alarm already
   * settled is not charged twice.
   */
  async settle(input: { reservationId: string; charged: number | undefined; costUsd: number | undefined; limits: Limits; now: number }): Promise<{ charged: number; costUsd: number; paid: boolean; allowance: Allowance }> {
    const reservation = this.ctx.storage.sql
      .exec<{ amount: number; source: Source; paid: number; pool: Pool }>("SELECT amount, source, paid, pool FROM reservations WHERE id = ?", input.reservationId)
      .toArray()[0];
    const row = this.#current(input.now);
    if (!reservation || !row) return { charged: 0, costUsd: 0, paid: false, allowance: this.#allowance(row, input.now, input.limits) };
    const charged = input.charged ?? reservation.amount;
    const costUsd = input.costUsd ?? costOf(undefined, charged);
    this.ctx.storage.transactionSync(() => this.#charge(row.github_id, input.reservationId, reservation.source, reservation.pool, charged, costUsd, input.now));
    return { charged, costUsd, paid: reservation.paid === 1, allowance: this.#allowance(this.#current(input.now), input.now, input.limits, reservation.pool) };
  }

  /** Replaces a reservation with its charge: to the week's counters, or to top-ups, earliest expiry first. */
  #charge(githubId: number, reservationId: string, source: Source, pool: Pool, charged: number, costUsd: number, now: number): void {
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM reservations WHERE id = ?", reservationId);
    if (source === "weekly") {
      sql.exec("UPDATE account SET used = used + ?, cost_used = cost_used + ? WHERE github_id = ?", charged, costUsd, githubId);
      sql.exec(
        "INSERT INTO pool_usage (week_start, pool, used) VALUES (?, ?, ?) ON CONFLICT(week_start, pool) DO UPDATE SET used = used + excluded.used",
        weekStart(now),
        pool,
        charged,
      );
      return;
    }
    let left = charged;
    for (const topup of sql.exec<{ id: string; tokens: number; used: number }>("SELECT id, tokens, used FROM topups WHERE expires_at > ? AND used < tokens ORDER BY expires_at, id", now).toArray()) {
      if (left <= 0) break;
      const take = Math.min(left, topup.tokens - topup.used);
      sql.exec("UPDATE topups SET used = used + ? WHERE id = ?", take, topup.id);
      left -= take;
    }
    // Usage past the last top-up (an overshoot the reservation didn't foresee) goes on the week.
    if (left > 0) sql.exec("UPDATE account SET used = used + ? WHERE github_id = ?", left, githubId);
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

  /** Adds a top-up once per id (the Checkout Session). False when it was already added. */
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
    spentUsdThisWeek: number | undefined;
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
    if (input.spentUsdThisWeek !== undefined) sql.exec("UPDATE account SET cost_used = ? WHERE github_id = ?", input.spentUsdThisWeek, row.github_id);
    return this.#allowance(this.#current(input.now), input.now, input.limits);
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
      }
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

  /** Creates a named server key. The secret is returned here once; only its hash is kept. */
  async createKey(input: { name: string; now: number }): Promise<CreateKeyResult> {
    const row = this.#row();
    if (!row) return { ok: false, code: "not_invited" };
    if (row.status === "blocked") return { ok: false, code: "blocked" };
    if (row.status === "suspended") return { ok: false, code: "suspended" };
    const sql = this.ctx.storage.sql;
    const count = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM server_keys").toArray()[0]?.n ?? 0;
    if (count >= MAX_SERVER_KEYS) return { ok: false, code: "key_limit_reached" };
    if (sql.exec("SELECT 1 FROM server_keys WHERE name = ?", input.name).toArray().length > 0) return { ok: false, code: "key_name_taken" };
    const id = [...crypto.getRandomValues(new Uint8Array(6))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const secret = randomToken();
    sql.exec("INSERT INTO server_keys (id, name, key_hash, created_at) VALUES (?, ?, ?, ?)", id, input.name, await sha256Hex(secret), input.now);
    return { ok: true, key: `dlk_${row.github_id}_${id}_${secret}`, view: { id, name: input.name, createdAt: input.now, lastUsedAt: null } };
  }

  async listKeys(): Promise<ServerKeyView[]> {
    return this.ctx.storage.sql
      .exec<{ id: string; name: string; created_at: number; last_used_at: number | null }>("SELECT id, name, created_at, last_used_at FROM server_keys ORDER BY created_at, id")
      .toArray()
      .map((key) => ({ id: key.id, name: key.name, createdAt: key.created_at, lastUsedAt: key.last_used_at }));
  }

  async keyCount(): Promise<number> {
    return this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM server_keys").toArray()[0]?.n ?? 0;
  }

  /** Deletes one key; false when there is no such key. */
  async revokeKey(id: string): Promise<boolean> {
    const found = this.ctx.storage.sql.exec("SELECT 1 FROM server_keys WHERE id = ?", id).toArray().length > 0;
    if (found) this.ctx.storage.sql.exec("DELETE FROM server_keys WHERE id = ?", id);
    return found;
  }

  /** Deletes every key; returns how many there were. */
  async revokeAllKeys(): Promise<number> {
    const count = await this.keyCount();
    this.ctx.storage.sql.exec("DELETE FROM server_keys");
    return count;
  }

  /** The account behind a server key, or undefined when the key is unknown or revoked. */
  async verifyKey(id: string, secret: string, now: number): Promise<{ githubId: number; login: string } | undefined> {
    const row = this.#row();
    const key = this.ctx.storage.sql.exec<{ key_hash: string; last_used_at: number | null }>("SELECT key_hash, last_used_at FROM server_keys WHERE id = ?", id).toArray()[0];
    if (!row || !key || !timingSafeEqual(await sha256Hex(secret), key.key_hash)) return undefined;
    if (key.last_used_at === null || now - key.last_used_at >= KEY_TOUCH_MS) this.ctx.storage.sql.exec("UPDATE server_keys SET last_used_at = ? WHERE id = ?", now, id);
    return { githubId: row.github_id, login: row.login };
  }

  /**
   * Settles reservations that outlived any request, and logs them as abandoned. That happens
   * when the caller hangs up before the upstream answers: Workers stops the handler there, so
   * it never settles. The upstream most likely read the prompt, so the charge is the prompt's
   * estimated size at the serving model's prices, never the whole reservation (which counts
   * the output the person never got). The record names the provider that was serving it.
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
      const charged = Math.min(reservation.amount, reservation.prompt_estimate ?? reservation.amount);
      const usage = { promptTokens: charged, completionTokens: 0, cachedTokens: 0, costUsd: undefined };
      const costUsd = model ? costAtPrices(usage, model.prices) : costOf(undefined, charged);
      // Reservations made before the provider was kept were all served on Luminal or OpenAI
      // (OpenRouter served nothing by then): never record them as OpenRouter cash.
      const provider: Upstream = reservation.provider ?? (model?.provider === "openai" ? "openai" : "luminal");
      const creditUsd = provider !== "openrouter" && model ? costAtPrices(usage, creditPrices(model)) : 0;
      this.ctx.storage.transactionSync(() => {
        if (row) this.#charge(row.github_id, reservation.id, reservation.source, reservation.pool, charged, costUsd, now);
        else this.ctx.storage.sql.exec("DELETE FROM reservations WHERE id = ?", reservation.id);
      });
      if (row && this.env.DIRECTORY) {
        await this.env.DIRECTORY.getByName("directory").recordRequest({
          githubId: row.github_id,
          isAdmin: row.is_admin === 1,
          at: reservation.created_at,
          model: model?.id ?? DEFAULT_MODEL,
          promptTokens: charged,
          completionTokens: 0,
          cachedTokens: 0,
          chargedTokens: charged,
          costUsd,
          status: "abandoned",
          latencyMs: null,
          upstream: provider,
          creditUsd,
          ...(reservation.paid === 1 ? { paid: true } : {}),
        });
      }
    }
    const next = this.ctx.storage.sql.exec<{ next: number | null }>("SELECT MIN(expires_at) AS next FROM reservations").toArray()[0]?.next;
    if (next === null || next === undefined) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
    return stale.length;
  }

  /** Weekly reservations in flight (top-ups don't count toward the dollar cap) and their estimated cost. */
  #inFlightWeekly(): { count: number; usd: number } {
    const row = this.ctx.storage.sql
      .exec<{ n: number; usd: number | null }>("SELECT COUNT(*) AS n, SUM(cost_estimate) AS usd FROM reservations WHERE source = 'weekly'")
      .toArray()[0];
    return { count: row?.n ?? 0, usd: row?.usd ?? 0 };
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
      this.ctx.storage.sql.exec("UPDATE account SET week_start = ?, used = 0, cost_used = 0 WHERE github_id = ?", start, row.github_id);
      this.ctx.storage.sql.exec("DELETE FROM pool_usage WHERE week_start < ?", start);
      return { ...row, week_start: start, used: 0, cost_used: 0 };
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
    const pro = plan === "pro";
    // Pro replaces the free allowance (no referral bonus: that is free tokens); grants apply to free.
    const bonus = pro ? 0 : Math.max(0, limits.bonusTokens ?? 0);
    const pools = this.#pools(row, now, limits, plan, bonus);
    const mine = pools[pool];
    const baseUsd = pro ? (limits.proUsdPerWeek ?? null) : (row?.weekly_usd ?? limits.weeklyUsd ?? null);
    // The referral bonus grows the dollar allowance in the same proportion as the Luna pool.
    const usdPerWeek = baseUsd !== null && bonus > 0 && mine.tokensPerWeek > bonus ? Math.round(baseUsd * (mine.tokensPerWeek / (mine.tokensPerWeek - bonus)) * 1e6) / 1e6 : baseUsd;
    const spent = row?.cost_used ?? 0;
    const spendLeft = usdPerWeek === null || spent < usdPerWeek;
    return {
      exists: row !== undefined,
      plan,
      topupTokensLeft,
      proPeriodEnd: billing.periodEnd,
      proCancelAtPeriodEnd: billing.cancelAtPeriodEnd,
      status: row?.status ?? null,
      isAdmin: row?.is_admin === 1,
      tokensPerWeek: mine.tokensPerWeek,
      usedThisWeek: mine.usedThisWeek,
      reserved: mine.reserved,
      remaining: row && spendLeft ? mine.remaining : 0,
      usdPerWeek,
      spentUsdThisWeek: Math.round(spent * 1e6) / 1e6,
      resetsAt: weekEnd(now),
      pools,
    };
  }

  /**
   * Every pool's allowance this week. The Luna pool is the one the weekly grant and the
   * referral bonus apply to (it is the free tier's default model); Sol and Astra keep their
   * own fixed grants. Pro's weekly tokens replace the Luna grant, as before.
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
      const base =
        pool === "luna"
          ? plan === "pro"
            ? (limits.proTokensPerWeek ?? limits.weeklyTokens)
            : limited
              ? levelTokens
              : (row?.weekly_tokens ?? limits.weeklyTokens)
          : limited
            ? Math.min(POOL_TOKENS[pool], levelTokens)
            : POOL_TOKENS[pool];
      // The referral bonus is for Full only, as it was before the smaller levels had every model.
      const tokensPerWeek = pool === "luna" && !limited ? base + bonus : base;
      out[pool] = { tokensPerWeek, usedThisWeek: used, reserved, remaining: Math.max(0, tokensPerWeek - used - reserved) };
    }
    return out;
  }
}
