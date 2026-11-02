import { DurableObject, type DurableObjectNamespace, type DurableObjectState } from "cloudflare:workers";
import type { DirectoryObject } from "./directory-object.js";
import { ALLOWED_MODELS, costOf, planReservation } from "./quota.js";
import { weekEnd, weekStart } from "./week.js";

/**
 * One person's allowance: `getByName("gh:<githubId>")`. The single serialization point for
 * reserve and settle, so two concurrent requests can't both spend the last tokens. The week
 * rolls over lazily on the first call after Monday 00:00 UTC; no timer is needed for that.
 * The alarm only settles reservations whose request never came back (a crash or a dropped
 * connection), charging them in full.
 */

export const RESERVATION_TTL_MS = 30 * 60_000;

export interface AccountEnv {
  DIRECTORY?: DurableObjectNamespace<DirectoryObject>;
}

export type AccountStatus = "active" | "suspended";

export interface Allowance {
  exists: boolean;
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
}

export type ReserveResult =
  | { ok: true; reservationId: string; amount: number; maxTokens: number; allowance: Allowance }
  | { ok: false; code: "not_invited" | "suspended"; allowance: Allowance }
  | { ok: false; code: "quota_exceeded"; reason: "tokens" | "spend"; allowance: Allowance };

/** Caps a call applies; per-person overrides set by an admin win over these. */
export interface Limits {
  weeklyTokens: number;
  weeklyUsd: number | undefined;
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
  `CREATE TABLE IF NOT EXISTS reservations (
     id         TEXT PRIMARY KEY,
     amount     INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
];

export class AccountObject extends DurableObject<AccountEnv> {
  constructor(ctx: DurableObjectState, env: AccountEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      for (const statement of SCHEMA) this.ctx.storage.sql.exec(statement);
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

  async allowance(now: number, limits: Limits): Promise<Allowance> {
    return this.#allowance(this.#current(now), now, limits);
  }

  /**
   * Holds tokens for one request. The token cap is exact (the reservation covers the worst
   * case). The spend cap is checked against settled cost, so it can be passed by at most the
   * cost of the requests in flight when it's reached.
   */
  async reserve(input: { promptEstimate: number; requestedMaxTokens: number | undefined; limits: Limits; now: number }): Promise<ReserveResult> {
    const row = this.#current(input.now);
    const before = this.#allowance(row, input.now, input.limits);
    if (!row) return { ok: false, code: "not_invited", allowance: before };
    if (row.status === "suspended") return { ok: false, code: "suspended", allowance: before };
    if (before.usdPerWeek !== null && before.spentUsdThisWeek >= before.usdPerWeek) {
      return { ok: false, code: "quota_exceeded", reason: "spend", allowance: before };
    }
    const plan = planReservation(input.promptEstimate, input.requestedMaxTokens, before.remaining);
    if (!plan) return { ok: false, code: "quota_exceeded", reason: "tokens", allowance: before };
    const reservationId = crypto.randomUUID();
    const expiresAt = input.now + RESERVATION_TTL_MS;
    this.ctx.storage.sql.exec(
      "INSERT INTO reservations (id, amount, created_at, expires_at) VALUES (?, ?, ?, ?)",
      reservationId,
      plan.amount,
      input.now,
      expiresAt,
    );
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > expiresAt) await this.ctx.storage.setAlarm(expiresAt);
    return { ok: true, reservationId, amount: plan.amount, maxTokens: plan.maxTokens, allowance: this.#allowance(row, input.now, input.limits) };
  }

  /**
   * Replaces a reservation with what was really used. `charged` undefined means the provider
   * reported nothing, so the whole reservation is charged. A reservation the alarm already
   * settled is not charged twice.
   */
  async settle(input: { reservationId: string; charged: number | undefined; costUsd: number | undefined; limits: Limits; now: number }): Promise<{ charged: number; costUsd: number; allowance: Allowance }> {
    const reservation = this.ctx.storage.sql
      .exec<{ amount: number }>("SELECT amount FROM reservations WHERE id = ?", input.reservationId)
      .toArray()[0];
    const row = this.#current(input.now);
    if (!reservation || !row) return { charged: 0, costUsd: 0, allowance: this.#allowance(row, input.now, input.limits) };
    const charged = input.charged ?? reservation.amount;
    const costUsd = input.costUsd ?? costOf(undefined, charged);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM reservations WHERE id = ?", input.reservationId);
      this.ctx.storage.sql.exec("UPDATE account SET used = used + ?, cost_used = cost_used + ? WHERE github_id = ?", charged, costUsd, row.github_id);
    });
    return { charged, costUsd, allowance: this.#allowance(this.#current(input.now), input.now, input.limits) };
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
    if (input.usedThisWeek !== undefined) sql.exec("UPDATE account SET used = ? WHERE github_id = ?", input.usedThisWeek, row.github_id);
    if (input.spentUsdThisWeek !== undefined) sql.exec("UPDATE account SET cost_used = ? WHERE github_id = ?", input.spentUsdThisWeek, row.github_id);
    return this.#allowance(this.#current(input.now), input.now, input.limits);
  }

  /** Charges reservations that outlived any request in full, and logs them as abandoned. */
  async alarm(): Promise<void> {
    await this.sweep(Date.now());
  }

  async sweep(now: number): Promise<number> {
    const row = this.#current(now);
    const stale = this.ctx.storage.sql
      .exec<{ id: string; amount: number; created_at: number }>("SELECT id, amount, created_at FROM reservations WHERE expires_at <= ?", now)
      .toArray();
    for (const reservation of stale) {
      const costUsd = costOf(undefined, reservation.amount);
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("DELETE FROM reservations WHERE id = ?", reservation.id);
        if (row) this.ctx.storage.sql.exec("UPDATE account SET used = used + ?, cost_used = cost_used + ? WHERE github_id = ?", reservation.amount, costUsd, row.github_id);
      });
      if (row && this.env.DIRECTORY) {
        await this.env.DIRECTORY.getByName("directory").recordRequest({
          githubId: row.github_id,
          isAdmin: row.is_admin === 1,
          at: reservation.created_at,
          model: ALLOWED_MODELS[0],
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 0,
          chargedTokens: reservation.amount,
          costUsd,
          status: "abandoned",
          latencyMs: null,
        });
      }
    }
    const next = this.ctx.storage.sql.exec<{ next: number | null }>("SELECT MIN(expires_at) AS next FROM reservations").toArray()[0]?.next;
    if (next === null || next === undefined) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
    return stale.length;
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
      return { ...row, week_start: start, used: 0, cost_used: 0 };
    }
    return row;
  }

  #allowance(row: AccountRow | undefined, now: number, limits: Limits): Allowance {
    const reserved = this.ctx.storage.sql.exec<{ total: number | null }>("SELECT SUM(amount) AS total FROM reservations").toArray()[0]?.total ?? 0;
    const tokensPerWeek = row?.weekly_tokens ?? limits.weeklyTokens;
    const usdPerWeek = row?.weekly_usd ?? limits.weeklyUsd ?? null;
    const used = row?.used ?? 0;
    const spent = row?.cost_used ?? 0;
    const spendLeft = usdPerWeek === null || spent < usdPerWeek;
    return {
      exists: row !== undefined,
      status: row?.status ?? null,
      isAdmin: row?.is_admin === 1,
      tokensPerWeek,
      usedThisWeek: used,
      reserved,
      remaining: row && spendLeft ? Math.max(0, tokensPerWeek - used - reserved) : 0,
      usdPerWeek,
      spentUsdThisWeek: Math.round(spent * 1e6) / 1e6,
      resetsAt: weekEnd(now),
    };
  }
}
