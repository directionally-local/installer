import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import { randomToken, sha256Hex, timingSafeEqual } from "../../shared/src/auth.js";
import { newUserCode } from "./codes.js";

/**
 * Sign-in state: device codes, the OAuth `state` values that bind a GitHub round trip to one
 * device code, and refresh tokens. One object (`getByName("auth")`). Every secret is stored as
 * its SHA-256: the device code, the OAuth state, the browser cookie, the invite-step ticket
 * and the refresh token are high-entropy random values, so a hash lookup is safe and a leaked
 * database holds nothing usable.
 */

export const DEVICE_CODE_TTL_MS = 600_000;
export const POLL_INTERVAL_S = 5;
export const REFRESH_TTL_MS = 30 * 86_400_000;
/** A rotated refresh token used again within this window is a retry, not theft. */
export const REFRESH_REUSE_GRACE_MS = 30_000;
const OAUTH_STATE_TTL_MS = 600_000;
const POLL_TOLERANCE_MS = 250;
/** `oauth_states.device_hash` of an admin dashboard sign-in; never a SHA-256 hex, so never a device code. */
const ADMIN_SIGN_IN = "admin-dashboard";

export type DeviceStatus = "pending" | "needs_invite" | "approved" | "denied" | "not_invited" | "consumed";

export type PollResult =
  | { status: "pending" | "slow_down" | "expired" | "denied" | "not_invited"; interval: number; reason?: string }
  | { status: "approved"; githubId: number; login: string; refreshToken: string; family: string };

export interface Identity {
  githubId: number;
  login: string;
}

interface DeviceRow {
  device_hash: string;
  user_code: string;
  status: DeviceStatus;
  created_at: number;
  expires_at: number;
  interval_s: number;
  last_poll_at: number | null;
  client_device_id: string | null;
  github_id: number | null;
  login: string | null;
  ticket_hash: string | null;
  reason: string | null;
}

interface RefreshRow {
  token_hash: string;
  family: string;
  github_id: number;
  login: string;
  expires_at: number;
  used_at: number | null;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS device_codes (
     device_hash      TEXT PRIMARY KEY,
     user_code        TEXT NOT NULL UNIQUE,
     status           TEXT NOT NULL,
     created_at       INTEGER NOT NULL,
     expires_at       INTEGER NOT NULL,
     interval_s       INTEGER NOT NULL,
     last_poll_at     INTEGER,
     client_device_id TEXT,
     github_id        INTEGER,
     login            TEXT,
     ticket_hash      TEXT UNIQUE,
     reason           TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS oauth_states (
     state_hash   TEXT PRIMARY KEY,
     device_hash  TEXT NOT NULL,
     browser_hash TEXT NOT NULL,
     expires_at   INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS refresh_tokens (
     token_hash TEXT PRIMARY KEY,
     family     TEXT NOT NULL,
     github_id  INTEGER NOT NULL,
     login      TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     used_at    INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS refresh_family ON refresh_tokens (family)`,
  `CREATE INDEX IF NOT EXISTS refresh_person ON refresh_tokens (github_id)`,
];

export class AuthObject extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      for (const statement of SCHEMA) this.ctx.storage.sql.exec(statement);
    });
  }

  async issueDeviceCode(input: { clientDeviceId: string | null; now: number }): Promise<{ deviceCode: string; userCode: string; expiresAt: number; interval: number }> {
    const deviceCode = randomToken();
    const deviceHash = await sha256Hex(deviceCode);
    const expiresAt = input.now + DEVICE_CODE_TTL_MS;
    this.ctx.storage.sql.exec("DELETE FROM device_codes WHERE expires_at <= ? AND status != 'approved'", input.now);
    for (let attempt = 0; ; attempt++) {
      const userCode = newUserCode();
      const taken = this.ctx.storage.sql.exec("SELECT 1 FROM device_codes WHERE user_code = ?", userCode).toArray().length > 0;
      if (taken) {
        if (attempt > 20) throw new Error("Couldn't find a free user code.");
        continue;
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO device_codes (device_hash, user_code, status, created_at, expires_at, interval_s, client_device_id)
         VALUES (?, ?, 'pending', ?, ?, ?, ?)`,
        deviceHash,
        userCode,
        input.now,
        expiresAt,
        POLL_INTERVAL_S,
        input.clientDeviceId,
      );
      await this.#scheduleCleanup(input.now);
      return { deviceCode, userCode, expiresAt, interval: POLL_INTERVAL_S };
    }
  }

  /** The status of a user code the browser page was given, or undefined when unknown or expired. */
  async lookup(userCode: string, now: number): Promise<{ status: DeviceStatus; expiresAt: number } | undefined> {
    const row = this.#byUserCode(userCode);
    if (!row || row.expires_at <= now) return undefined;
    return { status: row.status, expiresAt: row.expires_at };
  }

  /**
   * Starts the GitHub round trip for a pending code: a random `state` for the URL and a
   * random browser value for a cookie. The callback must present both.
   */
  async beginOAuth(userCode: string, now: number): Promise<{ state: string; browser: string } | undefined> {
    const row = this.#byUserCode(userCode);
    if (!row || row.expires_at <= now || row.status !== "pending") return undefined;
    const state = randomToken();
    const browser = randomToken();
    this.ctx.storage.sql.exec(
      "INSERT INTO oauth_states (state_hash, device_hash, browser_hash, expires_at) VALUES (?, ?, ?, ?)",
      await sha256Hex(state),
      row.device_hash,
      await sha256Hex(browser),
      Math.min(row.expires_at, now + OAUTH_STATE_TTL_MS),
    );
    return { state, browser };
  }

  /**
   * Consumes a `state` from the callback. It must exist, be unexpired, belong to a code that
   * is still pending, and come with the browser cookie set when it was issued.
   */
  async claimOAuthState(state: string, browser: string, now: number): Promise<{ deviceRef: string; clientDeviceId: string | null } | undefined> {
    const stateHash = await sha256Hex(state);
    const row = this.ctx.storage.sql
      .exec<{ device_hash: string; browser_hash: string; expires_at: number }>("SELECT * FROM oauth_states WHERE state_hash = ?", stateHash)
      .toArray()[0];
    if (!row) return undefined;
    this.ctx.storage.sql.exec("DELETE FROM oauth_states WHERE state_hash = ?", stateHash);
    if (row.expires_at <= now) return undefined;
    if (!timingSafeEqual(await sha256Hex(browser), row.browser_hash)) return undefined;
    const device = this.#byHash(row.device_hash);
    if (!device || device.expires_at <= now || device.status !== "pending") return undefined;
    return { deviceRef: device.device_hash, clientDeviceId: device.client_device_id };
  }

  /**
   * Starts a GitHub round trip for the admin dashboard's browser sign-in. Same shape as
   * `beginOAuth`, but bound to no device code: its row carries `ADMIN_SIGN_IN` instead, so a
   * device callback can't consume it and this one can't consume a device state.
   */
  async beginAdminOAuth(now: number): Promise<{ state: string; browser: string }> {
    const state = randomToken();
    const browser = randomToken();
    this.ctx.storage.sql.exec("DELETE FROM oauth_states WHERE device_hash = ? AND expires_at <= ?", ADMIN_SIGN_IN, now);
    this.ctx.storage.sql.exec(
      "INSERT INTO oauth_states (state_hash, device_hash, browser_hash, expires_at) VALUES (?, ?, ?, ?)",
      await sha256Hex(state),
      ADMIN_SIGN_IN,
      await sha256Hex(browser),
      now + OAUTH_STATE_TTL_MS,
    );
    return { state, browser };
  }

  /** Consumes an admin sign-in `state`: once, unexpired, and only with the browser cookie it was issued with. */
  async claimAdminOAuthState(state: string, browser: string, now: number): Promise<boolean> {
    const stateHash = await sha256Hex(state);
    const row = this.ctx.storage.sql
      .exec<{ device_hash: string; browser_hash: string; expires_at: number }>("SELECT * FROM oauth_states WHERE state_hash = ?", stateHash)
      .toArray()[0];
    if (!row || row.device_hash !== ADMIN_SIGN_IN) return false;
    this.ctx.storage.sql.exec("DELETE FROM oauth_states WHERE state_hash = ?", stateHash);
    if (row.expires_at <= now) return false;
    return timingSafeEqual(await sha256Hex(browser), row.browser_hash);
  }

  /**
   * Records what happened in the browser. `needs_invite` returns a ticket for the invite form,
   * which only the browser that finished the GitHub round trip has.
   */
  async decide(
    deviceRef: string,
    outcome: Exclude<DeviceStatus, "pending" | "consumed">,
    identity: Identity | undefined,
    now: number,
    reason?: string,
  ): Promise<{ ticket?: string }> {
    const device = this.#byHash(deviceRef);
    if (!device || device.expires_at <= now) return {};
    let ticket: string | undefined;
    if (outcome === "needs_invite") ticket = randomToken();
    this.ctx.storage.sql.exec(
      "UPDATE device_codes SET status = ?, github_id = COALESCE(?, github_id), login = COALESCE(?, login), ticket_hash = ?, reason = ? WHERE device_hash = ?",
      outcome,
      identity?.githubId ?? null,
      identity?.login ?? null,
      ticket ? await sha256Hex(ticket) : null,
      reason ?? null,
      deviceRef,
    );
    return ticket ? { ticket } : {};
  }

  /** Cancels a pending code from the browser page; `reason` tells the terminal why. */
  async deny(userCode: string, now: number, reason?: string): Promise<boolean> {
    const row = this.#byUserCode(userCode);
    if (!row || row.expires_at <= now || (row.status !== "pending" && row.status !== "needs_invite")) return false;
    this.ctx.storage.sql.exec("UPDATE device_codes SET status = 'denied', ticket_hash = NULL, reason = ? WHERE device_hash = ?", reason ?? null, row.device_hash);
    return true;
  }

  /** The device and person behind an invite-step ticket, and why an invite was asked for. */
  async ticket(ticket: string, now: number): Promise<(Identity & { deviceRef: string; clientDeviceId: string | null; reason: string | null }) | undefined> {
    const row = this.ctx.storage.sql.exec<DeviceRow>("SELECT * FROM device_codes WHERE ticket_hash = ?", await sha256Hex(ticket)).toArray()[0];
    if (!row || row.expires_at <= now || row.status !== "needs_invite" || row.github_id === null || row.login === null) return undefined;
    return { deviceRef: row.device_hash, githubId: row.github_id, login: row.login, clientDeviceId: row.client_device_id, reason: row.reason };
  }

  /** The CLI's poll (RFC 8628 §3.4–3.5), including `slow_down`. Approved codes pay out once. */
  async poll(deviceCode: string, now: number): Promise<PollResult> {
    const row = this.#byHash(await sha256Hex(deviceCode));
    if (!row || row.status === "consumed") return { status: "expired", interval: POLL_INTERVAL_S };
    if (row.status === "approved" && row.github_id !== null && row.login !== null) {
      this.ctx.storage.sql.exec("UPDATE device_codes SET status = 'consumed', ticket_hash = NULL WHERE device_hash = ?", row.device_hash);
      const family = crypto.randomUUID();
      const refreshToken = await this.#issueRefresh({ githubId: row.github_id, login: row.login }, family, now);
      return { status: "approved", githubId: row.github_id, login: row.login, refreshToken, family };
    }
    if (row.expires_at <= now) return { status: "expired", interval: row.interval_s };
    if (row.status === "denied" || row.status === "not_invited") {
      return { status: row.status, interval: row.interval_s, ...(row.reason ? { reason: row.reason } : {}) };
    }

    const tooSoon = row.last_poll_at !== null && now - row.last_poll_at < row.interval_s * 1000 - POLL_TOLERANCE_MS;
    const interval = tooSoon ? row.interval_s + 5 : row.interval_s;
    this.ctx.storage.sql.exec("UPDATE device_codes SET last_poll_at = ?, interval_s = ? WHERE device_hash = ?", now, interval, row.device_hash);
    return { status: tooSoon ? "slow_down" : "pending", interval };
  }

  /**
   * Rotates a refresh token: the old one stops working and a new one is returned. Presenting
   * an already-rotated token after the grace window revokes the whole family, since one copy
   * of it is in the wrong hands.
   */
  async rotate(refreshToken: string, now: number): Promise<(Identity & { refreshToken: string; family: string }) | undefined> {
    const tokenHash = await sha256Hex(refreshToken);
    const row = this.ctx.storage.sql.exec<RefreshRow>("SELECT * FROM refresh_tokens WHERE token_hash = ?", tokenHash).toArray()[0];
    if (!row) return undefined;
    if (row.used_at !== null) {
      if (now - row.used_at > REFRESH_REUSE_GRACE_MS) this.ctx.storage.sql.exec("DELETE FROM refresh_tokens WHERE family = ?", row.family);
      return undefined;
    }
    if (row.expires_at <= now) {
      this.ctx.storage.sql.exec("DELETE FROM refresh_tokens WHERE token_hash = ?", tokenHash);
      return undefined;
    }
    this.ctx.storage.sql.exec("UPDATE refresh_tokens SET used_at = ? WHERE token_hash = ?", now, tokenHash);
    const next = await this.#issueRefresh({ githubId: row.github_id, login: row.login }, row.family, now);
    return { githubId: row.github_id, login: row.login, refreshToken: next, family: row.family };
  }

  /** The sign-in session (family) and person behind a refresh token, used or not. */
  async familyOf(refreshToken: string): Promise<{ family: string; githubId: number } | undefined> {
    const row = this.ctx.storage.sql.exec<RefreshRow>("SELECT * FROM refresh_tokens WHERE token_hash = ?", await sha256Hex(refreshToken)).toArray()[0];
    return row ? { family: row.family, githubId: row.github_id } : undefined;
  }

  /** Deletes every refresh token of these families, so none of them can be refreshed again. */
  async revokeFamilies(families: string[]): Promise<number> {
    let deleted = 0;
    for (const family of families) {
      deleted += this.ctx.storage.sql.exec("DELETE FROM refresh_tokens WHERE family = ? RETURNING token_hash", family).toArray().length;
    }
    return deleted;
  }

  /** Deletes all of one person's refresh tokens; returns the families they belonged to. */
  async revokeAllFor(githubId: number): Promise<string[]> {
    const families = this.ctx.storage.sql
      .exec<{ family: string }>("SELECT DISTINCT family FROM refresh_tokens WHERE github_id = ?", githubId)
      .toArray()
      .map((row) => row.family);
    this.ctx.storage.sql.exec("DELETE FROM refresh_tokens WHERE github_id = ?", githubId);
    return families;
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM device_codes WHERE expires_at <= ?", now - DEVICE_CODE_TTL_MS);
    this.ctx.storage.sql.exec("DELETE FROM oauth_states WHERE expires_at <= ?", now);
    this.ctx.storage.sql.exec("DELETE FROM refresh_tokens WHERE expires_at <= ? OR (used_at IS NOT NULL AND used_at <= ?)", now, now - REFRESH_TTL_MS);
    const pending = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM device_codes").toArray()[0]?.n ?? 0;
    if (pending > 0) await this.ctx.storage.setAlarm(now + 3_600_000);
  }

  async #issueRefresh(identity: Identity, family: string, now: number): Promise<string> {
    const token = randomToken();
    this.ctx.storage.sql.exec(
      "INSERT INTO refresh_tokens (token_hash, family, github_id, login, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      await sha256Hex(token),
      family,
      identity.githubId,
      identity.login,
      now,
      now + REFRESH_TTL_MS,
    );
    return token;
  }

  #byUserCode(userCode: string): DeviceRow | undefined {
    return this.ctx.storage.sql.exec<DeviceRow>("SELECT * FROM device_codes WHERE user_code = ?", userCode).toArray()[0];
  }

  #byHash(deviceHash: string): DeviceRow | undefined {
    return this.ctx.storage.sql.exec<DeviceRow>("SELECT * FROM device_codes WHERE device_hash = ?", deviceHash).toArray()[0];
  }

  async #scheduleCleanup(now: number): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now + 3_600_000);
  }
}
