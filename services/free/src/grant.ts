/**
 * Giving free tokens by GitHub username, from the admin dashboard or POST /v1/admin/grant
 * {logins}. Each login is resolved to its numeric GitHub id (stable; a login can be renamed).
 * Someone already signed up is set to Full with reason "admin", like the level endpoint; a
 * blocked account is never changed. Someone who hasn't signed up gets a pre-grant: one row per
 * id, used once, so their first sign-up admits them at Full with reason "admin".
 */

/** At most this many usernames per call. */
export const MAX_GRANT_LOGINS = 50;

/** What happened to one username. */
export type GrantOutcome =
  /** Raised to Full (reason "admin"). */
  | "granted"
  /** Already Full; the level is now the admin's choice, so a sign-in can't lower it. */
  | "already_full"
  /** No account yet: Full at their first sign-up. */
  | "pregranted"
  /** Blocked: not changed. */
  | "blocked"
  /** Not a GitHub user (or not a valid username). */
  | "not_found"
  /** GitHub didn't answer (or rate-limited); nothing changed, try again. */
  | "github_error";

export interface GrantResult {
  /** As typed, after cleaning (no @, no URL). */
  input: string;
  outcome: GrantOutcome;
  /** GitHub's current spelling and id, when it was found. */
  login?: string;
  githubId?: number;
  /** The personal weekly dollar cap in place after the grant (a pre-grant's, at sign-in), when there is one. */
  usdPerWeek?: number;
}

/** The highest personal weekly dollar cap one grant can give. */
export const MAX_GRANT_USD = 1000;

/**
 * A grant's personal weekly dollar cap as the admin sent it: a number (JSON) or a form field's
 * text, 0 to MAX_GRANT_USD. Undefined (left out, or an empty field) means the
 * grantWeeklyUsdCap setting; 0 means no personal cap, only the level.
 */
export function parseGrantUsd(value: unknown): number | undefined | "invalid" {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  const amount = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim().replace(/^\$/, "")) : Number.NaN;
  return Number.isFinite(amount) && amount >= 0 && amount <= MAX_GRANT_USD ? Math.round(amount * 100) / 100 : "invalid";
}

/** "$20", "$2.50": a weekly dollar amount for the admin pages. */
export function grantUsdText(usd: number): string {
  return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`;
}

/** GitHub's rule: letters, digits and single hyphens, not at either end, 1 to 39 characters. */
const LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

/** One pasted entry as a username: a leading "@" and github.com URLs are accepted. */
export function cleanLogin(raw: string): string {
  let value = raw.trim();
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#\s]+)/i.exec(value);
  if (url) value = url[1]!;
  return value.replace(/^@+/, "");
}

/**
 * The usernames in what the owner pasted: separated by spaces, commas or new lines; duplicates
 * (ignoring case) kept once, in order. `invalid` holds entries that can't be a GitHub username.
 */
export function parseLogins(text: string): { logins: string[]; invalid: string[] } {
  const logins: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const part of text.split(/[\s,;]+/)) {
    if (part === "") continue;
    const login = cleanLogin(part);
    const key = login.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    (LOGIN.test(login) ? logins : invalid).push(login);
  }
  return { logins, invalid };
}

export const GRANT_LABELS: Record<GrantOutcome, string> = {
  granted: "granted",
  already_full: "already full",
  pregranted: "not signed up yet (pre-granted)",
  blocked: "blocked (not changed)",
  not_found: "not a GitHub user",
  github_error: "GitHub didn't answer, try again",
};
