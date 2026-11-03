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
  /** GitHub accounts younger than this need an invite code even when admission is open. */
  minGithubAccountAgeDays: number;
  /**
   * Open admission: GitHub accounts at least `minGithubAccountAgeDays` old get in without an
   * invite code (still within `maxActiveUsers`). Off by default: invite-only for everyone.
   */
  openAdmission: boolean;
  /** Kept for compatibility: false sets the cached-token weight to 0 unless CACHED_TOKEN_WEIGHT is set. */
  countCachedTokens: boolean;
  /**
   * How much one cached prompt token counts against the weekly token allowance, relative to
   * an uncached one. The USD caps always use the real reported cost.
   */
  cachedTokenWeight: number;
  /**
   * OpenRouter hosts to try first, as provider slugs (OPENROUTER_PROVIDER_ORDER, comma-separated).
   * Fallbacks stay on, so an outage at these hosts doesn't stop the free tier. Empty means no
   * preference: the cheapest host first.
   */
  openRouterProviderOrder: readonly string[];
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
  openAdmission: false,
  /**
   * OpenRouter's cache-read price over its input price for deepseek/deepseek-v4.1-flash-1017,
   * from https://openrouter.ai/api/v1/models on 2026-11-03: input $0.30/M, cache read
   * $0.006/M (and $0.15/M vs $0.003/M in its off-peak windows), so 0.02 at every hour.
   *
   * These are list prices. The host a request lands on bills its own prices, and their ratio
   * can be very different: one cheap host lists $0.035/M input and $0.006/M cache read (about
   * 0.17). After a week of real traffic, recheck the weight against what was actually billed
   * (`requests.cost_usd` against cached and uncached tokens), and change it with
   * `POST /admin/config {"cachedTokenWeight": ...}` if needed.
   */
  cachedTokenWeight: 0.02,
  /** DeepSeek's own host on OpenRouter (its endpoint tag is `deepseek`). */
  openRouterProviderOrder: ["deepseek"],
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
    openAdmission: flag(env.OPEN_ADMISSION, DEFAULTS.openAdmission, "OPEN_ADMISSION"),
    countCachedTokens: flag(env.COUNT_CACHED_TOKENS, DEFAULTS.countCachedTokens, "COUNT_CACHED_TOKENS"),
    cachedTokenWeight: cachedWeight(env),
    openRouterProviderOrder: providerOrder(env.OPENROUTER_PROVIDER_ORDER),
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

/** CACHED_TOKEN_WEIGHT (0 to 1) when set; otherwise 0 when COUNT_CACHED_TOKENS is false, else the default. */
function cachedWeight(env: Record<string, unknown>): number {
  const raw = text(env.CACHED_TOKEN_WEIGHT);
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new ConfigError(`CACHED_TOKEN_WEIGHT must be a number from 0 to 1 (got "${raw}").`);
    return parsed;
  }
  return flag(env.COUNT_CACHED_TOKENS, DEFAULTS.countCachedTokens, "COUNT_CACHED_TOKENS") ? DEFAULTS.cachedTokenWeight : 0;
}

/** Unset means the default; empty (or "none") means no preference. */
function providerOrder(value: unknown): readonly string[] {
  if (value === undefined || value === null) return DEFAULTS.openRouterProviderOrder;
  const raw = String(value).trim();
  if (raw === "" || raw.toLowerCase() === "none") return [];
  const slugs = raw.split(",").map((part) => part.trim()).filter(Boolean);
  if (slugs.length > 10 || slugs.some((slug) => !/^[a-z0-9][a-z0-9._/-]{0,63}$/i.test(slug))) {
    throw new ConfigError(`OPENROUTER_PROVIDER_ORDER must be up to 10 comma-separated provider slugs, e.g. "deepseek" (got "${raw}").`);
  }
  return slugs;
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
