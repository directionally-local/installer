import { DurableObject, type DurableObjectNamespace, type DurableObjectState } from "cloudflare:workers";
import { randomToken, sha256Hex, timingSafeEqual } from "../../shared/src/auth.js";
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
  | { ok: false; code: "not_invited" | "suspended" | "key_limit_reached" | "key_name_taken" };

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
  /**
   * This week's referral bonus, added on top of the weekly tokens (default or grant). The USD
   * allowance grows in the same proportion, so the bonus isn't cut short by the dollar cap.
   */
  bonusTokens?: number;
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
    const baseTokens = row?.weekly_tokens ?? limits.weeklyTokens;
    const bonus = Math.max(0, limits.bonusTokens ?? 0);
    const tokensPerWeek = baseTokens + bonus;
    const baseUsd = row?.weekly_usd ?? limits.weeklyUsd ?? null;
    const usdPerWeek = baseUsd !== null && bonus > 0 && baseTokens > 0 ? Math.round(baseUsd * (tokensPerWeek / baseTokens) * 1e6) / 1e6 : baseUsd;
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
