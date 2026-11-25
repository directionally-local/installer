/**
 * The AuthObject's part of dl.new's accounts (docs/web-api-paid.md): 6-digit email codes, the
 * GitHub round trip for dl.new's own sign-in (not the device code), its one-time handoff back
 * to the page, and cli-login (dl claude's browser sign-in). Short-lived rows only; every secret
 * is stored as its SHA-256.
 */

import { randomToken, sha256Hex, timingSafeEqual } from "../../shared/src/auth.js";
import { newUserCode } from "./codes.js";
import type { Sql } from "./dashboard-data.js";

/** An email code works this long. */
export const EMAIL_CODE_TTL_MS = 10 * 60_000;
/** A new code to the same address waits this long after the last one. */
export const EMAIL_CODE_RESEND_MS = 30_000;
/** Wrong tries before a code stops working. */
export const EMAIL_CODE_ATTEMPTS = 5;
const OAUTH_TTL_MS = 10 * 60_000;
const HANDOFF_TTL_MS = 5 * 60_000;
/** A cli-login waits this long for the browser. */
export const CLI_LOGIN_TTL_MS = 10 * 60_000;
/** How often the CLI may poll (seconds). */
export const CLI_LOGIN_INTERVAL_S = 2;

export const PAID_AUTH_SCHEMA = [
  // `purpose`: "signin" (sign-up and sign-in) or "change:<account>" (a contact-email change, bound to that account).
  `CREATE TABLE IF NOT EXISTS email_codes (
     email_norm TEXT NOT NULL,
     purpose    TEXT NOT NULL,
     code_hash  TEXT NOT NULL,
     attempts   INTEGER NOT NULL,
     sent_at    INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     PRIMARY KEY (email_norm, purpose)
   )`,
  `CREATE TABLE IF NOT EXISTS account_oauth (
     state_hash      TEXT PRIMARY KEY,
     browser_hash    TEXT NOT NULL,
     page_state_hash TEXT NOT NULL,
     return_url      TEXT NOT NULL,
     expires_at      INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS account_handoffs (
     code_hash  TEXT PRIMARY KEY,
     state_hash TEXT NOT NULL,
     github_id  INTEGER NOT NULL,
     login      TEXT NOT NULL,
     email      TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS cli_logins (
     login_hash   TEXT PRIMARY KEY,
     user_code    TEXT NOT NULL UNIQUE,
     tool         TEXT NOT NULL,
     device_name  TEXT,
     status       TEXT NOT NULL,
     account      INTEGER,
     created_at   INTEGER NOT NULL,
     expires_at   INTEGER NOT NULL,
     last_poll_at INTEGER
   )`,
];

/** Every expired row goes (the AuthObject's hourly alarm). */
export function prunePaidAuth(sql: Sql, now: number): void {
  sql.exec("DELETE FROM email_codes WHERE expires_at <= ?", now);
  sql.exec("DELETE FROM account_oauth WHERE expires_at <= ?", now);
  sql.exec("DELETE FROM account_handoffs WHERE expires_at <= ?", now);
  sql.exec("DELETE FROM cli_logins WHERE expires_at <= ?", now);
}

export function pendingPaidAuth(sql: Sql): number {
  return (
    sql.exec<{ n: number }>("SELECT (SELECT COUNT(*) FROM email_codes) + (SELECT COUNT(*) FROM account_oauth) + (SELECT COUNT(*) FROM account_handoffs) + (SELECT COUNT(*) FROM cli_logins) AS n").toArray()[0]?.n ?? 0
  );
}

/** Six random digits, uniformly (rejection sampling). */
export function newEmailCode(): string {
  const limit = 4_294_000_000; // the largest multiple of 1,000,000 below 2^32
  for (;;) {
    const value = crypto.getRandomValues(new Uint32Array(1))[0]!;
    if (value < limit) return String(value % 1_000_000).padStart(6, "0");
  }
}

function codeHash(emailNorm: string, purpose: string, code: string): Promise<string> {
  return sha256Hex(`email-code:${emailNorm}:${purpose}:${code}`);
}

export type EmailCodeIssue = { ok: true; code: string; expiresAt: number } | { ok: false; retryAfter: number };

/** A new code for an address and purpose, replacing any earlier one; refused within 30 s of the last. */
export async function issueEmailCode(sql: Sql, input: { emailNorm: string; purpose: string; now: number }): Promise<EmailCodeIssue> {
  const last = sql.exec<{ sent_at: number }>("SELECT sent_at FROM email_codes WHERE email_norm = ? AND purpose = ?", input.emailNorm, input.purpose).toArray()[0];
  if (last && input.now - last.sent_at < EMAIL_CODE_RESEND_MS) return { ok: false, retryAfter: Math.ceil((EMAIL_CODE_RESEND_MS - (input.now - last.sent_at)) / 1000) };
  const code = newEmailCode();
  const expiresAt = input.now + EMAIL_CODE_TTL_MS;
  sql.exec(
    `INSERT INTO email_codes (email_norm, purpose, code_hash, attempts, sent_at, expires_at) VALUES (?, ?, ?, 0, ?, ?)
     ON CONFLICT(email_norm, purpose) DO UPDATE SET code_hash = excluded.code_hash, attempts = 0, sent_at = excluded.sent_at, expires_at = excluded.expires_at`,
    input.emailNorm,
    input.purpose,
    await codeHash(input.emailNorm, input.purpose, code),
    input.now,
    expiresAt,
  );
  return { ok: true, code, expiresAt };
}

/** Forgets a code whose email didn't go out, so the person can ask again at once. */
export function dropEmailCode(sql: Sql, emailNorm: string, purpose: string): void {
  sql.exec("DELETE FROM email_codes WHERE email_norm = ? AND purpose = ?", emailNorm, purpose);
}

export type EmailCodeCheck = { ok: true } | { ok: false; reason: "invalid"; attemptsLeft: number } | { ok: false; reason: "expired" };

/** Checks a code: used once on success; dead after EMAIL_CODE_ATTEMPTS wrong tries or once expired. */
export async function verifyEmailCode(sql: Sql, input: { emailNorm: string; purpose: string; code: string; now: number }): Promise<EmailCodeCheck> {
  const row = sql
    .exec<{ code_hash: string; attempts: number; expires_at: number }>("SELECT code_hash, attempts, expires_at FROM email_codes WHERE email_norm = ? AND purpose = ?", input.emailNorm, input.purpose)
    .toArray()[0];
  if (!row || row.expires_at <= input.now || row.attempts >= EMAIL_CODE_ATTEMPTS) return { ok: false, reason: "expired" };
  const valid = /^[0-9]{6}$/.test(input.code) && timingSafeEqual(await codeHash(input.emailNorm, input.purpose, input.code), row.code_hash);
  if (valid) {
    dropEmailCode(sql, input.emailNorm, input.purpose);
    return { ok: true };
  }
  const attempts = row.attempts + 1;
  if (attempts >= EMAIL_CODE_ATTEMPTS) {
    dropEmailCode(sql, input.emailNorm, input.purpose);
    return { ok: false, reason: "expired" };
  }
  sql.exec("UPDATE email_codes SET attempts = ? WHERE email_norm = ? AND purpose = ?", attempts, input.emailNorm, input.purpose);
  return { ok: false, reason: "invalid", attemptsLeft: EMAIL_CODE_ATTEMPTS - attempts };
}

// ─── GitHub for dl.new accounts ─────────────────────────────────────────────

/** Starts dl.new's GitHub round trip: the URL's `state` and the browser cookie that binds it. */
export async function beginAccountOAuth(sql: Sql, input: { returnUrl: string; pageState: string; now: number }): Promise<{ state: string; browser: string }> {
  const state = randomToken();
  const browser = randomToken();
  sql.exec(
    "INSERT INTO account_oauth (state_hash, browser_hash, page_state_hash, return_url, expires_at) VALUES (?, ?, ?, ?, ?)",
    await sha256Hex(state),
    await sha256Hex(browser),
    await sha256Hex(input.pageState),
    input.returnUrl,
    input.now + OAUTH_TTL_MS,
  );
  return { state, browser };
}

export async function isAccountOAuthState(sql: Sql, state: string, now: number): Promise<boolean> {
  return sql.exec("SELECT 1 FROM account_oauth WHERE state_hash = ? AND expires_at > ?", await sha256Hex(state), now).toArray().length > 0;
}

/** Consumes the state: once, unexpired, with its browser cookie. */
export async function claimAccountOAuth(sql: Sql, input: { state: string; browser: string; now: number }): Promise<{ returnUrl: string; pageStateHash: string } | undefined> {
  const stateHash = await sha256Hex(input.state);
  const row = sql.exec<{ browser_hash: string; page_state_hash: string; return_url: string; expires_at: number }>("SELECT * FROM account_oauth WHERE state_hash = ?", stateHash).toArray()[0];
  if (!row) return undefined;
  sql.exec("DELETE FROM account_oauth WHERE state_hash = ?", stateHash);
  if (row.expires_at <= input.now || !timingSafeEqual(await sha256Hex(input.browser), row.browser_hash)) return undefined;
  return { returnUrl: row.return_url, pageStateHash: row.page_state_hash };
}

/** The one-time code that hands a finished GitHub sign-in (with its verified email) back to the page. */
/** Adds `account_handoffs.details` to tables made before the no-card trial (AuthObject's constructor). */
export function migrateAccountHandoffs(sql: Sql): void {
  const columns = sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('account_handoffs')").toArray().map((column) => column.name);
  if (!columns.includes("details")) sql.exec("ALTER TABLE account_handoffs ADD COLUMN details TEXT");
}

/**
 * `details`: what a no-card trial's GitHub sign-in read at the callback (trial-web.ts: the
 * account's level from its GitHub signals), as JSON; null for every other sign-in.
 */
export async function issueAccountHandoff(sql: Sql, input: { pageStateHash: string; githubId: number; login: string; email: string; details?: string | null; now: number }): Promise<string> {
  const code = randomToken();
  sql.exec(
    "INSERT INTO account_handoffs (code_hash, state_hash, github_id, login, email, expires_at, details) VALUES (?, ?, ?, ?, ?, ?, ?)",
    await sha256Hex(code),
    input.pageStateHash,
    input.githubId,
    input.login,
    input.email,
    input.now + HANDOFF_TTL_MS,
    input.details ?? null,
  );
  return code;
}

export async function claimAccountHandoff(sql: Sql, input: { code: string; state: string; now: number }): Promise<{ githubId: number; login: string; email: string; details: string | null } | undefined> {
  const codeHash = await sha256Hex(input.code);
  const row = sql.exec<{ state_hash: string; github_id: number; login: string; email: string; expires_at: number; details: string | null }>("SELECT * FROM account_handoffs WHERE code_hash = ?", codeHash).toArray()[0];
  if (!row) return undefined;
  sql.exec("DELETE FROM account_handoffs WHERE code_hash = ?", codeHash);
  if (row.expires_at <= input.now || !timingSafeEqual(await sha256Hex(input.state), row.state_hash)) return undefined;
  return { githubId: row.github_id, login: row.login, email: row.email, details: row.details ?? null };
}

// ─── cli-login ──────────────────────────────────────────────────────────────

export type CliLoginStatus = "pending" | "approved" | "denied";

export interface CliLoginView {
  userCode: string;
  tool: string;
  deviceName: string | null;
  status: CliLoginStatus | "expired";
  createdAt: number;
  expiresAt: number;
}

interface CliLoginRow {
  login_hash: string;
  user_code: string;
  tool: string;
  device_name: string | null;
  status: CliLoginStatus;
  account: number | null;
  created_at: number;
  expires_at: number;
  last_poll_at: number | null;
}

export async function startCliLogin(sql: Sql, input: { tool: string; deviceName: string | null; now: number }): Promise<{ loginId: string; userCode: string; expiresAt: number }> {
  const loginId = randomToken();
  const expiresAt = input.now + CLI_LOGIN_TTL_MS;
  for (let attempt = 0; ; attempt++) {
    const userCode = newUserCode();
    if (sql.exec("SELECT 1 FROM cli_logins WHERE user_code = ?", userCode).toArray().length > 0) {
      if (attempt > 20) throw new Error("Couldn't find a free user code.");
      continue;
    }
    sql.exec(
      "INSERT INTO cli_logins (login_hash, user_code, tool, device_name, status, created_at, expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
      await sha256Hex(loginId),
      userCode,
      input.tool,
      input.deviceName,
      input.now,
      expiresAt,
    );
    return { loginId, userCode, expiresAt };
  }
}

export function cliLogin(sql: Sql, userCode: string, now: number): CliLoginView | undefined {
  const row = sql.exec<CliLoginRow>("SELECT * FROM cli_logins WHERE user_code = ?", userCode).toArray()[0];
  if (!row) return undefined;
  return { userCode: row.user_code, tool: row.tool, deviceName: row.device_name, status: row.expires_at <= now ? "expired" : row.status, createdAt: row.created_at, expiresAt: row.expires_at };
}

/** The browser's answer, once, while pending. */
export function decideCliLogin(sql: Sql, input: { userCode: string; account: number; approve: boolean; now: number }): "approved" | "denied" | "missing" | "expired" | "decided" {
  const row = sql.exec<CliLoginRow>("SELECT * FROM cli_logins WHERE user_code = ?", input.userCode).toArray()[0];
  if (!row) return "missing";
  if (row.expires_at <= input.now) return "expired";
  if (row.status !== "pending") return "decided";
  const status = input.approve ? "approved" : "denied";
  sql.exec("UPDATE cli_logins SET status = ?, account = ? WHERE user_code = ?", status, input.account, input.userCode);
  return status;
}

export type CliPoll =
  | { status: "pending" | "slow_down" | "denied" | "expired" }
  | { status: "approved"; account: number; tool: string; deviceName: string | null };

/** The CLI's poll. An approved login is handed over once and then gone. */
export async function pollCliLogin(sql: Sql, input: { loginId: string; now: number }): Promise<CliPoll> {
  const loginHash = await sha256Hex(input.loginId);
  const row = sql.exec<CliLoginRow>("SELECT * FROM cli_logins WHERE login_hash = ?", loginHash).toArray()[0];
  if (!row || row.expires_at <= input.now) return { status: "expired" };
  if (row.status === "denied") {
    sql.exec("DELETE FROM cli_logins WHERE login_hash = ?", loginHash);
    return { status: "denied" };
  }
  if (row.status === "approved" && row.account !== null) {
    sql.exec("DELETE FROM cli_logins WHERE login_hash = ?", loginHash);
    return { status: "approved", account: row.account, tool: row.tool, deviceName: row.device_name };
  }
  const tooSoon = row.last_poll_at !== null && input.now - row.last_poll_at < CLI_LOGIN_INTERVAL_S * 1000 - 250;
  sql.exec("UPDATE cli_logins SET last_poll_at = ? WHERE login_hash = ?", input.now, loginHash);
  return { status: tooSoon ? "slow_down" : "pending" };
}
