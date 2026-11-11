import { ACCESS_REQUEST_ALERT_MODES, MAX_FIRST_BYTE_TIMEOUT_SECONDS, MAX_HOST_COOLDOWN_MINUTES, UPSTREAMS, type FreeConfig } from "./config.js";
import { isEmailBlocklistEntry } from "./email-guard.js";
import { isProviderSlugList, isQuantizationList } from "./routing.js";

/**
 * Settings the owner can change while the service runs, without a release. Each one starts
 * from its `env` value; an admin override stored in the Directory object wins until it is
 * cleared again. Overrides are kept as JSON in the Directory's `settings` table under
 * `override:<name>`, and every change is logged with who made it and when.
 *
 *   GET  /admin/config   effective values, the env values, the overrides and the change log
 *   POST /admin/config   {name: value, ...}; `null` clears an override (back to env).
 *                        USD caps also take "none" (no cap at all).
 */

export const RUNTIME_SETTINGS = {
  /** Tokens per person per week. */
  weeklyTokens: { kind: "tokens", env: "WEEKLY_TOKENS" },
  /** USD per person per week (real reported cost). */
  perPersonWeeklyUsdCap: { kind: "usd", env: "PER_PERSON_WEEKLY_USD_CAP" },
  /** USD across everyone but admins, per week. */
  globalWeeklyUsdCap: { kind: "usd", env: "GLOBAL_WEEKLY_USD_CAP" },
  /** USD across everyone but admins, in total. */
  globalTotalUsdCap: { kind: "usd", env: "GLOBAL_TOTAL_USD_CAP" },
  /** Active non-admin people at most, while admission is invite-only. */
  maxActiveUsers: { kind: "count", env: "MAX_ACTIVE_USERS" },
  /** Accounts old enough get in without an invite. */
  openAdmission: { kind: "flag", env: "OPEN_ADMISSION" },
  /** Full access needs an account at least this many days old. */
  fullMinAccountAgeDays: { kind: "count", env: "FULL_MIN_ACCOUNT_AGE_DAYS" },
  /** ... and at least this many public repositories ... */
  fullMinPublicRepos: { kind: "count", env: "FULL_MIN_PUBLIC_REPOS" },
  /** ... or this many contributions in the last year. */
  fullMinContributions: { kind: "count", env: "FULL_MIN_CONTRIBUTIONS" },
  /** Additional account signals for Full (admission.ts levelChecks): with the public bar, one fewer than this is needed; never Full without it. */
  humanSignalsNeeded: { kind: "count", env: "HUMAN_SIGNALS_NEEDED" },
  /** ... weeks with a contribution in the last year ... */
  minActiveWeeks: { kind: "count", env: "MIN_ACTIVE_WEEKS" },
  /** ... days since the oldest owned non-fork repository was created ... */
  minRepoAgeDays: { kind: "count", env: "MIN_REPO_AGE_DAYS" },
  /** ... accounts followed plus repositories starred ... */
  minSocial: { kind: "count", env: "MIN_SOCIAL" },
  /** ... and followers. */
  minFollowers: { kind: "count", env: "MIN_FOLLOWERS" },
  /** Days either side of an account's creation day that count as one creation batch. */
  batchWindowDays: { kind: "count", env: "BATCH_WINDOW_DAYS" },
  /** Signed-up accounts in that window that make a batch (with 0 followers: Starter); 0 turns it off. */
  batchSize: { kind: "count", env: "BATCH_SIZE" },
  /** A Starter account's weekly tokens, every model; 0 for none. Batch-flagged accounts get none either way. */
  starterWeeklyTokens: { kind: "tokens", env: "STARTER_WEEKLY_TOKENS" },
  /** A Starter account's weekly USD cap. */
  starterWeeklyUsdCap: { kind: "usd", env: "STARTER_WEEKLY_USD_CAP" },
  /** Below the public bar, accounts at least this many days old and not in a creation batch are basic. */
  basicMinAccountAgeDays: { kind: "count", env: "BASIC_MIN_ACCOUNT_AGE_DAYS" },
  /** A basic account's weekly tokens, every model; 0 turns the basic level off (Starter instead). */
  basicWeeklyTokens: { kind: "tokens", env: "BASIC_WEEKLY_TOKENS" },
  /** A basic account's weekly USD cap. */
  basicWeeklyUsdCap: { kind: "usd", env: "BASIC_WEEKLY_USD_CAP" },
  /** New sign-ins one network gets a day before the rest are Starter. */
  networkSignupsPerDay: { kind: "count", env: "NETWORK_SIGNUPS_PER_DAY" },
  /** Inboxes and domains that can't sign up for the free tier. */
  blockedEmails: { kind: "emails", env: "BLOCKED_EMAILS" },
  /** New accounts a day from one company or custom email domain. */
  domainSignupsPerDay: { kind: "count", env: "DOMAIN_SIGNUPS_PER_DAY" },
  /** New accounts need a public repo or a contribution in the last year to skip the invite. */
  requireGithubActivity: { kind: "flag", env: "REQUIRE_GITHUB_ACTIVITY" },
  /** Cached prompt tokens' weight against the token allowance, 0 to 1. */
  cachedTokenWeight: { kind: "weight", env: "CACHED_TOKEN_WEIGHT" },
  /** OpenRouter hosts to try first; [] for none (cheapest first). */
  openRouterProviderOrder: { kind: "slugs", env: "OPENROUTER_PROVIDER_ORDER" },
  /** OpenRouter precision filter; [] for none. */
  openRouterQuantizations: { kind: "quantizations", env: "OPENROUTER_QUANTIZATIONS" },
  /** "deny" or "allow". */
  openRouterDataCollection: { kind: "dataCollection", env: "OPENROUTER_DATA_COLLECTION" },
  /** Minutes a host that failed a request is skipped; 0 turns it off. */
  openRouterHostCooldownMinutes: { kind: "minutes", env: "OPENROUTER_HOST_COOLDOWN_MINUTES" },
  /** Share of the weekly cap at which new sign-ups are queued, 0 to 1. */
  queueThreshold: { kind: "weight", env: "QUEUE_THRESHOLD" },
  /** Places a queued person moves up per referred friend who became weekly active. */
  queueReferralPlaces: { kind: "count", env: "QUEUE_REFERRAL_PLACES" },
  /** Tokens a week for each side of an active referral. */
  referralBonusTokens: { kind: "tokens", env: "REFERRAL_BONUS_TOKENS" },
  /** The most referral bonus tokens one person gets a week. */
  referralBonusCap: { kind: "tokens", env: "REFERRAL_BONUS_CAP" },
  /** "openai", "luminal" or "openrouter": which provider serves by default. */
  primaryUpstream: { kind: "upstream", env: "PRIMARY_UPSTREAM" },
  /** Prepaid OpenAI credit, USD; raise it after a top-up. */
  openaiCreditUsd: { kind: "amount", env: "OPENAI_CREDIT_USD" },
  /** Free OpenAI credit a week the queue protects, USD; "none" for no weekly credit budget. */
  openaiWeeklyCreditUsd: { kind: "usd", env: "OPENAI_WEEKLY_CREDIT_USD" },
  /** Seconds to wait for OpenAI's first byte before falling back. */
  openaiFirstByteTimeoutSeconds: { kind: "seconds", env: "OPENAI_FIRST_BYTE_TIMEOUT_SECONDS" },
  /** Prepaid Luminal credit, USD; raise it after a top-up. */
  luminalCreditUsd: { kind: "amount", env: "LUMINAL_CREDIT_USD" },
  /** Free Luminal credit a week the queue protects, USD; "none" for no weekly credit budget. */
  luminalWeeklyCreditUsd: { kind: "usd", env: "LUMINAL_WEEKLY_CREDIT_USD" },
  /** Seconds to wait for Luminal's first byte before a transient 503. */
  luminalFirstByteTimeoutSeconds: { kind: "seconds", env: "LUMINAL_FIRST_BYTE_TIMEOUT_SECONDS" },
  /** Emails to users (user-emails.ts) on or off; they also need the USER_EMAIL binding or RESEND_API_KEY. */
  userEmails: { kind: "flag", env: "USER_EMAILS" },
  /** Free tokens inside dl only: chat requests without session events are refused (app.ts). */
  dlOnly: { kind: "flag", env: "DL_ONLY" },
  /** The owner's email about access requests: "each" (one per request), "daily" (in the daily digest) or "off". */
  accessRequestAlerts: { kind: "alertMode", env: "ACCESS_REQUEST_ALERTS" },
} as const;

export type RuntimeKey = keyof typeof RUNTIME_SETTINGS;
type Kind = (typeof RUNTIME_SETTINGS)[RuntimeKey]["kind"];

/** A stored override: a number, a boolean, null for "no cap" (USD caps only), a list or a word. */
export type OverrideValue = number | boolean | null | string | string[];
export type Overrides = Partial<Record<RuntimeKey, OverrideValue>>;

/** One change: `value` undefined clears the override. */
export interface SettingChange {
  key: RuntimeKey;
  value: OverrideValue | undefined;
}

const MAX_TOKENS = 10_000_000_000;
const MAX_COUNT = 1_000_000;
const MAX_USD = 1_000_000;

export function isRuntimeKey(key: string): key is RuntimeKey {
  return Object.prototype.hasOwnProperty.call(RUNTIME_SETTINGS, key);
}

/** The value for `kind`, or "invalid". Accepts what the admin API takes. */
export function validateValue(kind: Kind, value: unknown): OverrideValue | "invalid" {
  switch (kind) {
    case "tokens":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOKENS ? value : "invalid";
    case "count":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT ? value : "invalid";
    case "usd":
      if (value === null || (typeof value === "string" && ["none", "off"].includes(value.toLowerCase()))) return null;
      return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_USD ? value : "invalid";
    case "flag":
      return typeof value === "boolean" ? value : "invalid";
    case "weight":
      return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : "invalid";
    case "emails":
      return Array.isArray(value) && value.length <= 500 && value.every(isEmailBlocklistEntry) ? value.map((v) => v.trim().toLowerCase()) : "invalid";
    case "slugs":
      return Array.isArray(value) && isProviderSlugList(value) ? value.map((slug) => slug.toLowerCase()) : "invalid";
    case "quantizations":
      return Array.isArray(value) && isQuantizationList(value) ? [...value] : "invalid";
    case "dataCollection":
      return value === "allow" || value === "deny" ? value : "invalid";
    case "minutes":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_HOST_COOLDOWN_MINUTES ? value : "invalid";
    case "upstream":
      return typeof value === "string" && (UPSTREAMS as readonly string[]).includes(value) ? value : "invalid";
    case "amount":
      return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_USD ? value : "invalid";
    case "seconds":
      return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_FIRST_BYTE_TIMEOUT_SECONDS ? value : "invalid";
    case "alertMode":
      return typeof value === "string" && (ACCESS_REQUEST_ALERT_MODES as readonly string[]).includes(value) ? value : "invalid";
  }
}

const RULES: Record<Kind, string> = {
  tokens: `a whole number of tokens, 0 to ${MAX_TOKENS}`,
  count: `a whole number, 0 to ${MAX_COUNT}`,
  usd: `a number of dollars, 0 to ${MAX_USD}, or "none" for no cap`,
  flag: "true or false",
  weight: "a number from 0 to 1",
  emails: 'a list of up to 500 inboxes or domains, e.g. ["name@gmail.com", "@example.com"], or [] for none',
  slugs: 'a list of up to 10 OpenRouter provider slugs, e.g. ["deepinfra", "novita"], or [] for none',
  quantizations: 'a list of OpenRouter quantization levels, e.g. ["fp8", "bf16"], or [] for no filter',
  dataCollection: '"deny" or "allow"',
  minutes: `a whole number of minutes, 0 to ${MAX_HOST_COOLDOWN_MINUTES} (0 turns it off)`,
  upstream: '"openai", "luminal" or "openrouter"',
  amount: `a number of dollars, 0 to ${MAX_USD}`,
  seconds: `a number of seconds, more than 0 and at most ${MAX_FIRST_BYTE_TIMEOUT_SECONDS}`,
  alertMode: '"each", "daily" or "off"',
};

/**
 * Parses an admin update body. `null` clears an override; anything else must be valid for its
 * setting. Unknown names are refused so a typo can't silently do nothing.
 */
export function parseSettingsUpdate(body: Record<string, unknown>): { changes: SettingChange[] } | { error: string } {
  const entries = Object.entries(body);
  if (entries.length === 0) return { error: `Send one or more of ${Object.keys(RUNTIME_SETTINGS).join(", ")}.` };
  const changes: SettingChange[] = [];
  for (const [key, raw] of entries) {
    if (!isRuntimeKey(key)) return { error: `"${key}" isn't a runtime setting. Use ${Object.keys(RUNTIME_SETTINGS).join(", ")}.` };
    if (raw === null) {
      changes.push({ key, value: undefined });
      continue;
    }
    const kind = RUNTIME_SETTINGS[key].kind;
    const value = validateValue(kind, raw);
    if (value === "invalid") return { error: `${key} must be ${RULES[kind]} (or null to go back to the env value).` };
    changes.push({ key, value });
  }
  return { changes };
}

/** Overrides read back from storage; anything that no longer validates is ignored. */
export function readOverrides(stored: Array<{ key: string; value: string }>): Overrides {
  const out: Overrides = {};
  for (const row of stored) {
    if (!row.key.startsWith("override:")) continue;
    const key = row.key.slice("override:".length);
    if (!isRuntimeKey(key)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      continue;
    }
    const value = validateValue(RUNTIME_SETTINGS[key].kind, parsed);
    if (value !== "invalid") out[key] = value;
  }
  return out;
}

/** The config with overrides applied. */
export function applyOverrides<T extends Partial<FreeConfig>>(config: T, overrides: Overrides): T {
  const next: T = { ...config };
  for (const [key, value] of Object.entries(overrides) as Array<[RuntimeKey, OverrideValue]>) {
    if (!(key in config)) continue;
    switch (RUNTIME_SETTINGS[key].kind) {
      case "usd":
        (next as unknown as Record<string, unknown>)[key] = value === null ? undefined : value;
        break;
      default:
        (next as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return next;
}

/** The runtime settings of a config, as the admin API shows them (no secrets). */
export function settingsView(config: FreeConfig): Record<RuntimeKey, OverrideValue> {
  const out = {} as Record<RuntimeKey, OverrideValue>;
  for (const key of Object.keys(RUNTIME_SETTINGS) as RuntimeKey[]) {
    const value = (config as unknown as Record<string, unknown>)[key];
    out[key] = value === undefined ? null : Array.isArray(value) ? [...(value as string[])] : (value as OverrideValue);
  }
  return out;
}
