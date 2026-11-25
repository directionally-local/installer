import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import { randomToken, sha256Hex, timingSafeEqual } from "../../shared/src/auth.js";
import { newUserCode } from "./codes.js";
import { parseCampaign, type Campaign } from "./web-signup.js";
import {
  beginAccountOAuth,
  beginGoogleOAuth,
  claimAccountHandoff,
  claimAccountOAuth,
  claimGoogleHandoff,
  claimGoogleOAuth,
  cliLogin,
  decideCliLogin,
  dropEmailCode,
  isAccountOAuthState,
  issueAccountHandoff,
  issueEmailCode,
  issueGoogleHandoff,
  migrateAccountHandoffs,
  PAID_AUTH_SCHEMA,
  pendingPaidAuth,
  pollCliLogin,
  prunePaidAuth,
  startCliLogin,
  verifyEmailCode,
  type CliLoginView,
  type CliPoll,
  type EmailCodeCheck,
  type EmailCodeIssue,
} from "./paid-auth.js";

/**
 * Sign-in state: device codes, the OAuth `state` values that bind a GitHub round trip to one
 * device code, and refresh tokens. One object (`getByName("auth")`). Every secret is stored as
 * its SHA-256: the device code, the OAuth state, the browser cookie, the invite-step ticket
 * and the refresh token are high-entropy random values, so a hash lookup is safe and a leaked
 * database holds nothing usable.
 */

/** How long a sign-in code works: long enough to switch to a phone and sign in to GitHub there. */
export const DEVICE_CODE_TTL_MS = 15 * 60_000;
export const POLL_INTERVAL_S = 5;
export const REFRESH_TTL_MS = 30 * 86_400_000;
/** A rotated refresh token used again within this window is a retry, not theft. */
/**
 * How long a rotated refresh token still works. Two sessions on one machine share one sign-in,
 * and the slower one may present the old token minutes after the other rotated it. Within this
 * window that gets a new token in the same sign-in; after it, the replay is treated as theft and
 * the whole sign-in is revoked.
 */
export const REFRESH_REUSE_GRACE_MS = 5 * 60_000;
const OAUTH_STATE_TTL_MS = 600_000;
/** How long the dl.new page has to exchange a finished web sign-in for its session. */
export const WEB_HANDOFF_TTL_MS = 5 * 60_000;
/** How long a personal install command works. */
export const INSTALL_CODE_TTL_MS = 60 * 60_000;
/** An install code's random bytes: 160 bits, 27 base64url characters. */
const INSTALL_CODE_BYTES = 20;
/** What the person chose on dl.new: where dl runs, and (this computer) the plan. */
export type InstallOption = "computer" | "gpu";
export type InstallPlan = "free" | "pro";
export type InstallCodeRedeem =
  | ({ ok: true; option: InstallOption; plan: InstallPlan | null } & Identity)
  | { ok: false; reason: "unknown" | "used" | "expired" };
const POLL_TOLERANCE_MS = 250;
/** Earlier admin rows carried this in `device_hash`; the purpose column replaced it. */
const LEGACY_ADMIN_MARKER = "admin-dashboard";

/** What a GitHub round trip is for: finishing a device code, an admin dashboard sign-in, or a dl.new account sign-in (paid-auth.ts). */
export type OAuthPurpose = "device" | "admin" | "account";

export type DeviceStatus = "pending" | "needs_invite" | "needs_details" | "approved" | "denied" | "not_invited" | "consumed";

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
  referral_code: string | null;
  /** The sign-in step's carried state (GitHub signals, prefilled email) as JSON, for `needs_details`. */
  details_json: string | null;
  /** A web sign-up's page to return to (dl.new); null for the CLI's device codes. */
  web_return: string | null;
  /** The SHA-256 of the web page's random state, for a web sign-up. */
  web_state_hash: string | null;
  /** A web sign-up's link campaign (web-signup.ts Campaign) as JSON, or null. Tags only. */
  web_campaign: string | null;
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
  // dl.new's web sign-up (web-signup.ts): the one-time code that hands a finished GitHub sign-in
  // back to the dl.new page, bound to the page's own random state.
  `CREATE TABLE IF NOT EXISTS web_handoffs (
     code_hash  TEXT PRIMARY KEY,
     state_hash TEXT NOT NULL,
     github_id  INTEGER NOT NULL,
     login      TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  // ... and the personal install command's one-time code (dl.new/i/<code>), exchanged once by
  // the installed dl for a sign-in session. `option` and `plan` are what the person chose.
  `CREATE TABLE IF NOT EXISTS install_codes (
     code_hash  TEXT PRIMARY KEY,
     github_id  INTEGER NOT NULL,
     login      TEXT NOT NULL,
     option     TEXT NOT NULL,
     plan       TEXT,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     used_at    INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS refresh_person ON refresh_tokens (github_id)`,
];

export class AuthObject extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      for (const statement of [...SCHEMA, ...PAID_AUTH_SCHEMA]) this.ctx.storage.sql.exec(statement);
      this.#migrateOAuthPurpose();
      this.#migrateReferralCode();
      this.#migrateDetails();
      this.#migrateWeb();
      migrateAccountHandoffs(this.ctx.storage.sql);
    });
  }

  /**
   * `web`: a dl.new web sign-up (web-signup.ts) instead of the CLI's: the same code, GitHub round
   * trip, details and invite steps and admission, then `finishWebSignIn` hands it back to `web.returnUrl`.
   */
  async issueDeviceCode(input: { clientDeviceId: string | null; referralCode?: string | null; now: number; web?: { returnUrl: string; state: string; campaign?: Campaign } }): Promise<{ deviceCode: string; userCode: string; expiresAt: number; interval: number }> {
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
        `INSERT INTO device_codes (device_hash, user_code, status, created_at, expires_at, interval_s, client_device_id, referral_code, web_return, web_state_hash, web_campaign)
         VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
        deviceHash,
        userCode,
        input.now,
        expiresAt,
        POLL_INTERVAL_S,
        input.clientDeviceId,
        input.referralCode ?? null,
        input.web?.returnUrl ?? null,
        input.web ? await sha256Hex(input.web.state) : null,
        input.web?.campaign ? JSON.stringify(input.web.campaign) : null,
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
  async beginOAuth(userCode: string, now: number, referralCode?: string): Promise<{ state: string; browser: string } | undefined> {
    const row = this.#byUserCode(userCode);
    if (!row || row.expires_at <= now || row.status !== "pending") return undefined;
    // A code from the browser (`/device?ref=`) fills in when the terminal sent none.
    if (referralCode && row.referral_code === null) this.ctx.storage.sql.exec("UPDATE device_codes SET referral_code = ? WHERE device_hash = ?", referralCode, row.device_hash);
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
  async claimOAuthState(state: string, browser: string, now: number): Promise<{ deviceRef: string; clientDeviceId: string | null; referralCode: string | null } | undefined> {
    const stateHash = await sha256Hex(state);
    const row = this.ctx.storage.sql
      .exec<{ device_hash: string; browser_hash: string; expires_at: number; purpose: string }>("SELECT * FROM oauth_states WHERE state_hash = ?", stateHash)
      .toArray()[0];
    if (!row || row.purpose !== "device") return undefined;
    this.ctx.storage.sql.exec("DELETE FROM oauth_states WHERE state_hash = ?", stateHash);
    if (row.expires_at <= now) return undefined;
    if (!timingSafeEqual(await sha256Hex(browser), row.browser_hash)) return undefined;
    const device = this.#byHash(row.device_hash);
    if (!device || device.expires_at <= now || device.status !== "pending") return undefined;
    return { deviceRef: device.device_hash, clientDeviceId: device.client_device_id, referralCode: device.referral_code };
  }

  /**
   * Starts a GitHub round trip for the admin dashboard's browser sign-in. Same shape as
   * `beginOAuth`, but bound to no device code and stored with purpose `admin`. Both flows come
   * back to the one registered callback; the purpose tells them apart, and each claim accepts
   * only its own purpose.
   */
  async beginAdminOAuth(now: number): Promise<{ state: string; browser: string }> {
    const state = randomToken();
    const browser = randomToken();
    this.ctx.storage.sql.exec("DELETE FROM oauth_states WHERE purpose = 'admin' AND expires_at <= ?", now);
    this.ctx.storage.sql.exec(
      "INSERT INTO oauth_states (state_hash, device_hash, browser_hash, expires_at, purpose) VALUES (?, '', ?, ?, 'admin')",
      await sha256Hex(state),
      await sha256Hex(browser),
      now + OAUTH_STATE_TTL_MS,
    );
    return { state, browser };
  }

  /**
   * Which flow a callback's `state` belongs to, without consuming it; undefined when unknown or
   * expired. Only routes the callback: the claim that follows checks everything again.
   */
  async oauthPurpose(state: string, now: number): Promise<OAuthPurpose | undefined> {
    if (await isAccountOAuthState(this.ctx.storage.sql, state, now)) return "account";
    const row = this.ctx.storage.sql
      .exec<{ purpose: string; expires_at: number }>("SELECT purpose, expires_at FROM oauth_states WHERE state_hash = ?", await sha256Hex(state))
      .toArray()[0];
    if (!row || row.expires_at <= now) return undefined;
    return row.purpose === "admin" ? "admin" : "device";
  }

  /** Consumes an admin sign-in `state`: once, unexpired, and only with the browser cookie it was issued with. */
  async claimAdminOAuthState(state: string, browser: string, now: number): Promise<boolean> {
    const stateHash = await sha256Hex(state);
    const row = this.ctx.storage.sql
      .exec<{ purpose: string; browser_hash: string; expires_at: number }>("SELECT * FROM oauth_states WHERE state_hash = ?", stateHash)
      .toArray()[0];
    if (!row || row.purpose !== "admin") return false;
    this.ctx.storage.sql.exec("DELETE FROM oauth_states WHERE state_hash = ?", stateHash);
    if (row.expires_at <= now) return false;
    return timingSafeEqual(await sha256Hex(browser), row.browser_hash);
  }

  /**
   * Records what happened in the browser. `needs_invite` and `needs_details` return a ticket
   * for that step's form (`details` is carried to it as JSON),
   * which only the browser that finished the GitHub round trip has.
   */
  async decide(
    deviceRef: string,
    outcome: Exclude<DeviceStatus, "pending" | "consumed">,
    identity: Identity | undefined,
    now: number,
    reason?: string,
    details?: string,
  ): Promise<{ ticket?: string }> {
    const device = this.#byHash(deviceRef);
    if (!device || device.expires_at <= now) return {};
    let ticket: string | undefined;
    if (outcome === "needs_invite" || outcome === "needs_details") ticket = randomToken();
    this.ctx.storage.sql.exec(
      "UPDATE device_codes SET status = ?, github_id = COALESCE(?, github_id), login = COALESCE(?, login), ticket_hash = ?, reason = ?, details_json = ? WHERE device_hash = ?",
      outcome,
      identity?.githubId ?? null,
      identity?.login ?? null,
      ticket ? await sha256Hex(ticket) : null,
      reason ?? null,
      outcome === "needs_details" ? (details ?? null) : null,
      deviceRef,
    );
    return ticket ? { ticket } : {};
  }

  /** Cancels a pending code from the browser page; `reason` tells the terminal why. */
  async deny(userCode: string, now: number, reason?: string): Promise<boolean> {
    const row = this.#byUserCode(userCode);
    if (!row || row.expires_at <= now || (row.status !== "pending" && row.status !== "needs_invite" && row.status !== "needs_details")) return false;
    this.ctx.storage.sql.exec("UPDATE device_codes SET status = 'denied', ticket_hash = NULL, reason = ? WHERE device_hash = ?", reason ?? null, row.device_hash);
    return true;
  }

  /**
   * The device and person behind a step's ticket, and why the step was asked for. `step` is
   * the step the form belongs to: an invite ticket can't finish the details step, nor the
   * other way round.
   */
  async ticket(
    ticket: string,
    now: number,
    step: "needs_invite" | "needs_details" = "needs_invite",
  ): Promise<(Identity & { deviceRef: string; clientDeviceId: string | null; reason: string | null; referralCode: string | null; details: string | null }) | undefined> {
    const row = this.ctx.storage.sql.exec<DeviceRow>("SELECT * FROM device_codes WHERE ticket_hash = ?", await sha256Hex(ticket)).toArray()[0];
    if (!row || row.expires_at <= now || row.status !== step || row.github_id === null || row.login === null) return undefined;
    return {
      deviceRef: row.device_hash,
      githubId: row.github_id,
      login: row.login,
      clientDeviceId: row.client_device_id,
      reason: row.reason,
      referralCode: row.referral_code,
      details: row.details_json ?? null,
    };
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
      if (now - row.used_at > REFRESH_REUSE_GRACE_MS) {
        this.ctx.storage.sql.exec("DELETE FROM refresh_tokens WHERE family = ?", row.family);
        return undefined;
      }
      // Another session of this sign-in rotated it moments ago: give this one its own new token.
      if (row.expires_at <= now) return undefined;
      const next = await this.#issueRefresh({ githubId: row.github_id, login: row.login }, row.family, now);
      return { githubId: row.github_id, login: row.login, refreshToken: next, family: row.family };
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

  /**
   * A web sign-up that admission just approved: the device code is used up (nobody polls it) and
   * a one-time handoff code is issued for the page to exchange (`claimWebHandoff`). Undefined for
   * a CLI sign-in, which the terminal's poll finishes as before.
   */
  async finishWebSignIn(deviceRef: string, identity: Identity, now: number): Promise<{ returnUrl: string; code: string; campaign?: Campaign } | undefined> {
    const row = this.#byHash(deviceRef);
    if (!row || row.web_return === null || row.web_state_hash === null || row.expires_at <= now) return undefined;
    const code = randomToken();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("UPDATE device_codes SET status = 'consumed', ticket_hash = NULL WHERE device_hash = ?", deviceRef);
      this.ctx.storage.sql.exec("DELETE FROM web_handoffs WHERE expires_at <= ?", now);
    });
    this.ctx.storage.sql.exec(
      "INSERT INTO web_handoffs (code_hash, state_hash, github_id, login, expires_at) VALUES (?, ?, ?, ?, ?)",
      await sha256Hex(code),
      row.web_state_hash,
      identity.githubId,
      identity.login,
      now + WEB_HANDOFF_TTL_MS,
    );
    await this.#scheduleCleanup(now);
    const campaign = row.web_campaign ? parseCampaign(JSON.parse(row.web_campaign)) : undefined;
    return { returnUrl: row.web_return, code, ...(campaign ? { campaign } : {}) };
  }

  /** Whether this device code is a web sign-up's (its refusals then point back to the web page). */
  async isWebSignIn(deviceRef: string): Promise<boolean> {
    return (this.#byHash(deviceRef)?.web_return ?? null) !== null;
  }

  /** Consumes a web handoff code: once, unexpired, and only with the state the page started with. */
  async claimWebHandoff(code: string, state: string, now: number): Promise<Identity | undefined> {
    const codeHash = await sha256Hex(code);
    const row = this.ctx.storage.sql
      .exec<{ state_hash: string; github_id: number; login: string; expires_at: number }>("SELECT * FROM web_handoffs WHERE code_hash = ?", codeHash)
      .toArray()[0];
    if (!row) return undefined;
    this.ctx.storage.sql.exec("DELETE FROM web_handoffs WHERE code_hash = ?", codeHash);
    if (row.expires_at <= now) return undefined;
    if (!timingSafeEqual(await sha256Hex(state), row.state_hash)) return undefined;
    return { githubId: row.github_id, login: row.login };
  }

  /**
   * A personal install command's code: random (160 bits), stored as its SHA-256 only, for one
   * person, used once, for `INSTALL_CODE_TTL_MS`. Earlier unused codes of the same person stop
   * working, so only the command on screen works.
   */
  async issueInstallCode(input: { identity: Identity; option: InstallOption; plan: InstallPlan | null; now: number }): Promise<{ code: string; expiresAt: number }> {
    const code = randomToken(INSTALL_CODE_BYTES);
    const expiresAt = input.now + INSTALL_CODE_TTL_MS;
    const sql = this.ctx.storage.sql;
    const codeHash = await sha256Hex(code);
    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM install_codes WHERE expires_at <= ? OR (github_id = ? AND used_at IS NULL)", input.now - INSTALL_CODE_TTL_MS, input.identity.githubId);
      sql.exec(
        "INSERT INTO install_codes (code_hash, github_id, login, option, plan, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        codeHash,
        input.identity.githubId,
        input.identity.login,
        input.option,
        input.plan,
        input.now,
        expiresAt,
      );
    });
    await this.#scheduleCleanup(input.now);
    return { code, expiresAt };
  }

  /** Uses an install code up: the person and their choice, or why it can't be used. */
  async redeemInstallCode(code: string, now: number): Promise<InstallCodeRedeem> {
    const codeHash = await sha256Hex(code);
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync((): InstallCodeRedeem => {
      const row = sql
        .exec<{ code_hash: string; github_id: number; login: string; option: string; plan: string | null; expires_at: number; used_at: number | null }>(
          "SELECT * FROM install_codes WHERE code_hash = ?",
          codeHash,
        )
        .toArray()[0];
      // The lookup is by hash; the compare is constant-time all the same.
      if (!row || !timingSafeEqual(row.code_hash, codeHash)) return { ok: false, reason: "unknown" };
      if (row.used_at !== null) return { ok: false, reason: "used" };
      if (row.expires_at <= now) return { ok: false, reason: "expired" };
      sql.exec("UPDATE install_codes SET used_at = ? WHERE code_hash = ?", now, codeHash);
      return {
        ok: true,
        githubId: row.github_id,
        login: row.login,
        option: row.option === "gpu" ? "gpu" : "computer",
        plan: row.plan === "pro" || row.plan === "free" ? row.plan : null,
      };
    });
  }

  /** A new sign-in session (refresh-token family) for someone already admitted: an install code's exchange. */
  // ─── dl.new accounts (paid-auth.ts) ─────────────────────────────────────────

  async issueEmailCode(input: { emailNorm: string; purpose: string; now: number }): Promise<EmailCodeIssue> {
    const issued = await issueEmailCode(this.ctx.storage.sql, input);
    if (issued.ok) await this.#scheduleCleanup(input.now);
    return issued;
  }

  async dropEmailCode(emailNorm: string, purpose: string): Promise<void> {
    dropEmailCode(this.ctx.storage.sql, emailNorm, purpose);
  }

  async verifyEmailCode(input: { emailNorm: string; purpose: string; code: string; now: number }): Promise<EmailCodeCheck> {
    return verifyEmailCode(this.ctx.storage.sql, input);
  }

  async beginAccountOAuth(input: { returnUrl: string; pageState: string; now: number }): Promise<{ state: string; browser: string }> {
    const begun = await beginAccountOAuth(this.ctx.storage.sql, input);
    await this.#scheduleCleanup(input.now);
    return begun;
  }

  async claimAccountOAuth(input: { state: string; browser: string; now: number }): Promise<{ returnUrl: string; pageStateHash: string } | undefined> {
    return claimAccountOAuth(this.ctx.storage.sql, input);
  }

  async issueAccountHandoff(input: { pageStateHash: string; githubId: number; login: string; email: string; details?: string | null; now: number }): Promise<string> {
    return issueAccountHandoff(this.ctx.storage.sql, input);
  }

  async claimAccountHandoff(input: { code: string; state: string; now: number }): Promise<{ githubId: number; login: string; email: string; details: string | null } | undefined> {
    return claimAccountHandoff(this.ctx.storage.sql, input);
  }

  async beginGoogleOAuth(input: { returnUrl: string; pageState: string; verifier: string; nonce: string; now: number }): Promise<{ state: string; browser: string }> {
    const begun = await beginGoogleOAuth(this.ctx.storage.sql, input);
    await this.#scheduleCleanup(input.now);
    return begun;
  }

  async claimGoogleOAuth(input: { state: string; browser: string; now: number }): Promise<{ returnUrl: string; pageStateHash: string; verifier: string; nonce: string } | undefined> {
    return claimGoogleOAuth(this.ctx.storage.sql, input);
  }

  async issueGoogleHandoff(input: { pageStateHash: string; subject: string; email: string; now: number }): Promise<string> {
    return issueGoogleHandoff(this.ctx.storage.sql, input);
  }

  async claimGoogleHandoff(input: { code: string; state: string; now: number }): Promise<{ subject: string; email: string } | undefined> {
    return claimGoogleHandoff(this.ctx.storage.sql, input);
  }

  async startCliLogin(input: { tool: string; deviceName: string | null; now: number }): Promise<{ loginId: string; userCode: string; expiresAt: number }> {
    const started = await startCliLogin(this.ctx.storage.sql, input);
    await this.#scheduleCleanup(input.now);
    return started;
  }

  async cliLogin(userCode: string, now: number): Promise<CliLoginView | undefined> {
    return cliLogin(this.ctx.storage.sql, userCode, now);
  }

  async decideCliLogin(input: { userCode: string; account: number; approve: boolean; now: number }): Promise<ReturnType<typeof decideCliLogin>> {
    return decideCliLogin(this.ctx.storage.sql, input);
  }

  async pollCliLogin(input: { loginId: string; now: number }): Promise<CliPoll> {
    return pollCliLogin(this.ctx.storage.sql, input);
  }

  async issueSession(identity: Identity, now: number): Promise<{ refreshToken: string; family: string }> {
    const family = crypto.randomUUID();
    return { refreshToken: await this.#issueRefresh(identity, family, now), family };
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM web_handoffs WHERE expires_at <= ?", now);
    this.ctx.storage.sql.exec("DELETE FROM install_codes WHERE expires_at <= ?", now - INSTALL_CODE_TTL_MS);
    this.ctx.storage.sql.exec("DELETE FROM device_codes WHERE expires_at <= ?", now - DEVICE_CODE_TTL_MS);
    this.ctx.storage.sql.exec("DELETE FROM oauth_states WHERE expires_at <= ?", now);
    this.ctx.storage.sql.exec("DELETE FROM refresh_tokens WHERE expires_at <= ? OR (used_at IS NOT NULL AND used_at <= ?)", now, now - REFRESH_TTL_MS);
    prunePaidAuth(this.ctx.storage.sql, now);
    const pending =
      (this.ctx.storage.sql.exec<{ n: number }>("SELECT (SELECT COUNT(*) FROM device_codes) + (SELECT COUNT(*) FROM web_handoffs) + (SELECT COUNT(*) FROM install_codes) AS n").toArray()[0]?.n ?? 0) +
      pendingPaidAuth(this.ctx.storage.sql);
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

  /** Adds `oauth_states.purpose` to databases created before it existed. */
  #migrateOAuthPurpose(): void {
    const sql = this.ctx.storage.sql;
    const columns = sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('oauth_states')").toArray();
    if (columns.some((column) => column.name === "purpose")) return;
    this.ctx.storage.transactionSync(() => {
      sql.exec("ALTER TABLE oauth_states ADD COLUMN purpose TEXT NOT NULL DEFAULT 'device'");
      sql.exec("UPDATE oauth_states SET purpose = 'admin' WHERE device_hash = ?", LEGACY_ADMIN_MARKER);
    });
  }

  /** Adds `device_codes.details_json` to databases created before it existed. */
  #migrateDetails(): void {
    const columns = this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('device_codes')").toArray();
    if (!columns.some((column) => column.name === "details_json")) this.ctx.storage.sql.exec("ALTER TABLE device_codes ADD COLUMN details_json TEXT");
  }

  /** Adds `device_codes.web_return`, `web_state_hash` and `web_campaign` (dl.new's web sign-up) to databases created before them. */
  #migrateWeb(): void {
    const columns = this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('device_codes')").toArray();
    if (!columns.some((column) => column.name === "web_return")) this.ctx.storage.sql.exec("ALTER TABLE device_codes ADD COLUMN web_return TEXT");
    if (!columns.some((column) => column.name === "web_state_hash")) this.ctx.storage.sql.exec("ALTER TABLE device_codes ADD COLUMN web_state_hash TEXT");
    if (!columns.some((column) => column.name === "web_campaign")) this.ctx.storage.sql.exec("ALTER TABLE device_codes ADD COLUMN web_campaign TEXT");
  }

  /** Adds `device_codes.referral_code` to databases created before it existed. */
  #migrateReferralCode(): void {
    const columns = this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('device_codes')").toArray();
    if (!columns.some((column) => column.name === "referral_code")) this.ctx.storage.sql.exec("ALTER TABLE device_codes ADD COLUMN referral_code TEXT");
  }

  async #scheduleCleanup(now: number): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now + 3_600_000);
  }
}
