/**
 * The free tier's configuration, read from `env` only. Secrets (the OpenRouter key, the
 * GitHub OAuth app, the token signing key) are required; the knobs have defaults that match
 * the owner's decisions in installer#78.
 */

export class ConfigError extends Error {}

export interface FreeConfig {
  openRouterApiKey: string;
  githubClientId: string;
  githubClientSecret: string;
  tokenSigningKey: string;
  /** GitHub numeric ids that may call the admin endpoints and skip the invite step. */
  adminGithubIds: ReadonlySet<number>;
  weeklyTokens: number;
  maxActiveUsers: number;
  /** USD across everyone but admins, this week. Undefined means no weekly stop. */
  globalWeeklyUsdCap: number | undefined;
  /** USD across everyone but admins, for the whole experiment. Undefined means no total stop. */
  globalTotalUsdCap: number | undefined;
  /** A person's week ends at `weeklyTokens` or at this much real cost, whichever comes first. */
  perPersonWeeklyUsdCap: number | undefined;
  /** GitHub accounts younger than this can't sign up. */
  minGithubAccountAgeDays: number;
  countCachedTokens: boolean;
  /** The kill switch from `env`; the admin endpoint has its own, and either one pauses. */
  paused: boolean;
  /** The public origin for links, when the request's own origin isn't it (behind a proxy). */
  publicUrl: string | undefined;
}

export const DEFAULTS = {
  weeklyTokens: 50_000_000,
  maxActiveUsers: 50,
  countCachedTokens: true,
  globalWeeklyUsdCap: 250,
  globalTotalUsdCap: 1000,
  perPersonWeeklyUsdCap: 5,
  minGithubAccountAgeDays: 30,
} as const;

export function readFreeConfig(env: Record<string, unknown>): FreeConfig {
  const signingKey = required(env, "TOKEN_SIGNING_KEY");
  if (new TextEncoder().encode(signingKey).length < 32) throw new ConfigError("TOKEN_SIGNING_KEY must be at least 32 bytes.");
  return {
    openRouterApiKey: required(env, "OPENROUTER_API_KEY"),
    githubClientId: required(env, "GITHUB_CLIENT_ID"),
    githubClientSecret: required(env, "GITHUB_CLIENT_SECRET"),
    tokenSigningKey: signingKey,
    adminGithubIds: githubIds(text(env.ADMIN_GITHUB_IDS)),
    weeklyTokens: whole(env.WEEKLY_TOKENS, DEFAULTS.weeklyTokens, "WEEKLY_TOKENS"),
    maxActiveUsers: whole(env.MAX_ACTIVE_USERS, DEFAULTS.maxActiveUsers, "MAX_ACTIVE_USERS"),
    globalWeeklyUsdCap: usd(env.GLOBAL_WEEKLY_USD_CAP, DEFAULTS.globalWeeklyUsdCap, "GLOBAL_WEEKLY_USD_CAP"),
    globalTotalUsdCap: usd(env.GLOBAL_TOTAL_USD_CAP, DEFAULTS.globalTotalUsdCap, "GLOBAL_TOTAL_USD_CAP"),
    perPersonWeeklyUsdCap: usd(env.PER_PERSON_WEEKLY_USD_CAP, DEFAULTS.perPersonWeeklyUsdCap, "PER_PERSON_WEEKLY_USD_CAP"),
    minGithubAccountAgeDays: whole(env.MIN_GITHUB_ACCOUNT_AGE_DAYS, DEFAULTS.minGithubAccountAgeDays, "MIN_GITHUB_ACCOUNT_AGE_DAYS"),
    countCachedTokens: flag(env.COUNT_CACHED_TOKENS, DEFAULTS.countCachedTokens, "COUNT_CACHED_TOKENS"),
    paused: flag(env.PAUSED, false, "PAUSED"),
    publicUrl: text(env.PUBLIC_URL)?.replace(/\/+$/, ""),
  };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function required(env: Record<string, unknown>, name: string): string {
  const value = text(env[name]);
  if (!value) throw new ConfigError(`${name} is required.`);
  return value;
}

function whole(value: unknown, fallback: number, name: string): number {
  const raw = text(value);
  if (raw === undefined) return fallback;
  const parsed = Number(raw.replace(/_/g, ""));
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new ConfigError(`${name} must be a whole number (got "${raw}").`);
  return parsed;
}

/** Dollars. `none` (or `off`) turns the cap off; unset means the default. */
function usd(value: unknown, fallback: number, name: string): number | undefined {
  const raw = text(value);
  if (raw === undefined) return fallback;
  if (["none", "off"].includes(raw.toLowerCase())) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) throw new ConfigError(`${name} must be a number of dollars or "none" (got "${raw}").`);
  return parsed;
}

function flag(value: unknown, fallback: boolean, name: string): boolean {
  const raw = text(value)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new ConfigError(`${name} must be true or false (got "${raw}").`);
}

function githubIds(raw: string | undefined): ReadonlySet<number> {
  const ids = new Set<number>();
  for (const part of (raw ?? "").split(/[\s,]+/)) {
    if (!part) continue;
    const id = Number(part);
    if (!Number.isSafeInteger(id) || id <= 0) throw new ConfigError(`ADMIN_GITHUB_IDS must be numeric GitHub ids (got "${part}").`);
    ids.add(id);
  }
  return ids;
}
