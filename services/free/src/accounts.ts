/**
 * dl.new accounts, independent of GitHub (docs/web-api-paid.md).
 *
 * The service keys everything on one number: `githubId` in `Caller`, `people.github_id`, the
 * request log and the Account object's name. That number is now the **account number**. For
 * accounts from before the paid launch it is the GitHub id, unchanged (their GitHub sign-in is
 * linked as an identity the first time it's used, so nothing moves). Accounts made on dl.new
 * get a random number from PAID_ACCOUNT_BASE (2^50) up, far above any GitHub id, so the two
 * can never collide and nothing that meters or logs per account has to change.
 *
 * Identities (`identities` in the Directory): `github:<GitHub id>`, `email:<normalized address>`
 * or `google:<Google sub>`
 * → account number. The page sees an account as `acct_<base36>`.
 */

/** The first number a dl.new account can get. GitHub ids are around 2.5 × 10^8 in 2026. */
export const PAID_ACCOUNT_BASE = 2 ** 50;
/** New account numbers are PAID_ACCOUNT_BASE plus a random offset below this (2^48). */
export const PAID_ACCOUNT_SPAN = 2 ** 48;

/** `google`: keyed by the Google ID token's `sub` (stable per Google account), labelled with its verified email. */
export type IdentityKind = "github" | "email" | "google";

export function isPaidAccountNumber(account: number): boolean {
  return Number.isSafeInteger(account) && account >= PAID_ACCOUNT_BASE;
}

/** A fresh random account number (the caller checks it is free). */
export function randomAccountNumber(): number {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let offset = 0;
  for (const byte of bytes) offset = offset * 256 + byte;
  return PAID_ACCOUNT_BASE + (offset % PAID_ACCOUNT_SPAN);
}

/** What the pages and the admin see: `acct_<base36>`. */
export function accountIdOf(account: number): string {
  return `acct_${account.toString(36)}`;
}

export function parseAccountId(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^acct_([0-9a-z]{1,11})$/.exec(value);
  if (!match) return undefined;
  const account = parseInt(match[1]!, 36);
  return Number.isSafeInteger(account) && account > 0 ? account : undefined;
}

/** The Account object's name: `gh:<n>` as before for GitHub-numbered accounts, `acct:<n>` for dl.new's. */
export function accountObjectName(account: number): string {
  return isPaidAccountNumber(account) ? `acct:${account}` : `gh:${account}`;
}

/** The login shown for an account made on dl.new (no GitHub login): its account id. */
export function paidLogin(account: number): string {
  return accountIdOf(account);
}

// ─── API keys ───────────────────────────────────────────────────────────────

/**
 * `dl_sk_<account base36>_<id>_<secret>`: the account routes to its Account object (as the
 * GitHub id does in `dlk_` keys); only the secret's SHA-256 is stored. Kept with the other keys
 * (`server_keys`, kind "tool", format "dl_sk").
 */
const API_KEY = /^dl_sk_([0-9a-z]{1,11})_([a-z0-9]{12})_([A-Za-z0-9_-]{43})$/;
export const API_KEY_PREFIX = "dl_sk_";

export function formatApiKey(account: number, id: string, secret: string): string {
  return `${API_KEY_PREFIX}${account.toString(36)}_${id}_${secret}`;
}

export function parseApiKey(key: string): { account: number; id: string; secret: string } | undefined {
  const match = API_KEY.exec(key);
  if (!match) return undefined;
  const account = parseInt(match[1]!, 36);
  return Number.isSafeInteger(account) && account > 0 ? { account, id: match[2]!, secret: match[3]! } : undefined;
}

// ─── Autopilot keys ─────────────────────────────────────────────────────────

/**
 * `dl_ak_<account base36>_<id>_<secret>`: a short-lived key dl mints from the person's dl key
 * (POST /v1/autopilot-keys) for the one Autopilot it launches, and refreshes while that
 * Autopilot runs (account-object.ts AUTOPILOT_KEY_TTL_MS). Requests with it count as Autopilot:
 * GPT-6 and the paid plans' GPT-6 launch bonus, which a dl key in another tool doesn't get.
 * Laid out like a dl key (`dl_sk_`) so the account routes to its Account object.
 */
const AUTOPILOT_KEY = /^dl_ak_([0-9a-z]{1,11})_([a-z0-9]{12})_([A-Za-z0-9_-]{43})$/;
export const AUTOPILOT_KEY_PREFIX = "dl_ak_";

export function formatAutopilotKey(account: number, id: string, secret: string): string {
  return `${AUTOPILOT_KEY_PREFIX}${account.toString(36)}_${id}_${secret}`;
}

export function parseAutopilotKey(key: string): { account: number; id: string; secret: string } | undefined {
  const match = AUTOPILOT_KEY.exec(key);
  if (!match) return undefined;
  const account = parseInt(match[1]!, 36);
  return Number.isSafeInteger(account) && account > 0 ? { account, id: match[2]!, secret: match[3]! } : undefined;
}

/** What a list shows of a key: the prefix and the secret's last four characters. */
export function keyHint(lastFour: string | null): string {
  return lastFour ? `${API_KEY_PREFIX}…${lastFour}` : `${API_KEY_PREFIX}…`;
}

/** A masked address for a page that only holds a Checkout id: `a•••@gmail.com`. */
export function emailHint(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at <= 0) return null;
  return `${email[0]}•••${email.slice(at)}`;
}
