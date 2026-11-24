import { ALLOCATOR_MODES } from "./allocator.js";
import { ACCESS_REQUEST_ALERT_MODES, GPT6_CLIENTS, GUARD_MODES, isAllowlistEntry, MAX_FIRST_BYTE_TIMEOUT_SECONDS, isKeepDays, MAX_HOST_COOLDOWN_MINUTES, MODERATION_MODES, RAW_LOG_MAX_KEEP_DAYS, RAW_LOG_MIN_KEEP_DAYS, PRO_MULTIPLIER_MAX, PRO_MULTIPLIER_MIN, UPSTREAMS, parseInstant, type FreeConfig } from "./config.js";
import { isEmailBlocklistEntry } from "./email-guard.js";
import { isPriceList, isRegistryModelList, isSellerList, PROVIDER_PLANS, PROVIDER_STATUSES } from "./providers.js";
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
  /**
   * The new-user trial's cutoff: accounts admitted at or after it get a one-time trial
   * (`trialTokens`) instead of the weekly free allowance. An ISO time or Unix ms; "none" turns the
   * trial off. Unset: no trial for anyone.
   */
  trialCutoff: { kind: "instant", env: "TRIAL_CUTOFF" },
  /** The one-time trial's tokens (prompt with cached, plus completion), every free model together. */
  trialTokens: { kind: "tokens", env: "TRIAL_TOKENS" },
  /** A Full person's weekly GPT-6 budget, USD (real reported cost, every GPT-6 model). */
  perPersonWeeklyUsdCap: { kind: "usd", env: "PER_PERSON_WEEKLY_USD_CAP" },
  /** A Full person's weekly DeepSeek budget, USD (DeepSeek has no token cap). */
  deepseekWeeklyUsdCap: { kind: "usd", env: "DEEPSEEK_WEEKLY_USD_CAP" },
  /** The personal weekly USD cap an admin's grant gives (never lowers a higher one); 0 or "none": a grant sets only the level. */
  grantWeeklyUsdCap: { kind: "usd", env: "GRANT_WEEKLY_USD_CAP" },
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
  /** The batch threshold grows to this many times the average window's peers (never below batchSize); 0: fixed batchSize. */
  batchDensityFactor: { kind: "count", env: "BATCH_DENSITY_FACTOR" },
  /** A Starter account's weekly tokens, every model; 0 for none. Batch-flagged accounts get none either way. */
  starterWeeklyTokens: { kind: "tokens", env: "STARTER_WEEKLY_TOKENS" },
  /** A Starter account's weekly GPT-6 budget, USD. */
  starterWeeklyUsdCap: { kind: "usd", env: "STARTER_WEEKLY_USD_CAP" },
  /** A Starter account's weekly DeepSeek budget, USD. */
  starterDeepseekWeeklyUsdCap: { kind: "usd", env: "STARTER_DEEPSEEK_WEEKLY_USD_CAP" },
  /** Below the public bar, accounts at least this many days old and not in a creation batch are basic. */
  basicMinAccountAgeDays: { kind: "count", env: "BASIC_MIN_ACCOUNT_AGE_DAYS" },
  /** A basic account's weekly tokens, every model; 0 turns the basic level off (Starter instead). */
  basicWeeklyTokens: { kind: "tokens", env: "BASIC_WEEKLY_TOKENS" },
  /** A basic account's weekly GPT-6 budget, USD. */
  basicWeeklyUsdCap: { kind: "usd", env: "BASIC_WEEKLY_USD_CAP" },
  /** A basic account's weekly DeepSeek budget, USD. */
  basicDeepseekWeeklyUsdCap: { kind: "usd", env: "BASIC_DEEPSEEK_WEEKLY_USD_CAP" },
  /** Pro's weekly open-models (DeepSeek) budget as a multiple of a Full free account's, 1 to 100 (default 4). */
  proOpenModelsMultiplier: { kind: "multiplier", env: "PRO_OPEN_MODELS_MULTIPLIER" },
  /** New sign-ins one network gets a day before the rest are Starter. */
  networkSignupsPerDay: { kind: "count", env: "NETWORK_SIGNUPS_PER_DAY" },
  /** Inboxes and domains that can't sign up for the free tier. */
  blockedEmails: { kind: "emails", env: "BLOCKED_EMAILS" },
  /** New accounts a day from one company or custom email domain. */
  domainSignupsPerDay: { kind: "count", env: "DOMAIN_SIGNUPS_PER_DAY" },
  /** Past domainSignupsPerDay, refuse the sign-up instead of placing a new account below Full at Starter. */
  domainLimitRefuse: { kind: "flag", env: "DOMAIN_LIMIT_REFUSE" },
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
  // Registry providers (providers.ts): `provider<Setting>.<id>`. OpenAI's and Luminal's credit
  // settings keep their names above; `providerCredit.openai` and the like are aliases (ALIASES).
  /** Liquid Inference "on" or "paused" (the default: it serves nothing until the owner turns it on). */
  "providerStatus.liquid": { kind: "providerStatus", env: "LIQUID_STATUS" },
  /** Prepaid Liquid credit, USD; raise it after a top-up. At 80% one alert; at 100% its models are hidden. */
  "providerCredit.liquid": { kind: "amount", env: "LIQUID_CREDIT_USD" },
  /** The most Liquid credit everyone but admins may use a week, USD; "none" for no weekly budget. */
  "providerWeeklyCredit.liquid": { kind: "usd", env: "LIQUID_WEEKLY_CREDIT_USD" },
  /**
   * One person's weekly Liquid spend at most, USD, while Liquid is opt-in or Pro-only (then it is
   * Pro's weekly Kimi ration, shown as "about N tokens"); "none" for no cap.
   */
  "providerPersonWeeklyUsd.liquid": { kind: "usd", env: "LIQUID_PERSON_WEEKLY_USD" },
  /** Liquid opt-in: served only to people who pick its models, held to the per-person cap. */
  "providerOptIn.liquid": { kind: "flag", env: "LIQUID_OPT_IN" },
  /**
   * Who gets Liquid's models: "pro" (the default: dl Pro subscribers and admins; a free account's
   * request gets 402 provider_limit, reason pro_only, with the Upgrade link) or "all" (every plan,
   * each held to providerPersonWeeklyUsd.liquid while opt-in). Replaces providerProFirst.liquid.
   */
  "providerPlans.liquid": { kind: "providerPlans", env: "LIQUID_PLANS" },
  /** The Liquid models that are on, by id; [] for none. */
  "providerModels.liquid": { kind: "models", env: "LIQUID_MODELS" },
  /** Sellers that may serve Kimi K3.1 Pro on Liquid (exchange `providers.allow`); [] for any that passes the other rules. */
  "exchangeAllow.kimi-k3.1-pro": { kind: "sellers", env: "LIQUID_ALLOW_KIMI_K3_1_PRO" },
  /** Kimi K3.1 Pro's price ceilings on Liquid, [input, cache read, output] USD per million tokens. */
  "exchangeMaxPrices.kimi-k3.1-pro": { kind: "prices", env: "LIQUID_MAX_PRICES_KIMI_K3_1_PRO" },
  /** Sellers that may serve GLM 5.3 on Liquid. */
  "exchangeAllow.glm-5.3": { kind: "sellers", env: "LIQUID_ALLOW_GLM_5_3" },
  /** GLM 5.3's price ceilings on Liquid, [input, cache read, output] USD per million tokens. */
  "exchangeMaxPrices.glm-5.3": { kind: "prices", env: "LIQUID_MAX_PRICES_GLM_5_3" },
  /** Sellers that may serve GLM 5.3 Flash on Liquid (default munitoai and tensorx, both zero-retention). */
  "exchangeAllow.glm-5.3-flash": { kind: "sellers", env: "LIQUID_ALLOW_GLM_5_3_FLASH" },
  /** GLM 5.3 Flash's price ceilings on Liquid, [input, cache read, output] USD per million tokens. */
  "exchangeMaxPrices.glm-5.3-flash": { kind: "prices", env: "LIQUID_MAX_PRICES_GLM_5_3_FLASH" },
  /**
   * The most of Liquid's weekly credit Kimi K3.1 Pro may use (everyone but admins), USD; past it
   * Kimi is at its weekly budget while GLM 5.3 Flash still has its share. "none": no share of its own.
   */
  "modelWeeklyCredit.liquid.kimi-k3.1-pro": { kind: "usd", env: "LIQUID_WEEKLY_CREDIT_KIMI_K3_1_PRO" },
  /** The most of Liquid's weekly credit GLM 5.3 Flash may use, USD; past it Open Relay serves GLM 5.3 Flash. "none": no share of its own. */
  "modelWeeklyCredit.liquid.glm-5.3-flash": { kind: "usd", env: "LIQUID_WEEKLY_CREDIT_GLM_5_3_FLASH" },
  /** One person's weekly GLM 5.3 Flash spend at most, USD, on every plan, Liquid and Open Relay together; past it DeepSeek serves them until Monday. "none" for no cap. */
  "modelPersonWeeklyUsd.glm-5.3-flash": { kind: "usd", env: "GLM_5_3_FLASH_PERSON_WEEKLY_USD" },
  /** Open Relay "on" or "paused" (the default: it isn't GLM 5.3 Flash's backup until the owner turns it on). */
  "providerStatus.openrelay": { kind: "providerStatus", env: "OPENRELAY_STATUS" },
  /** Prepaid Open Relay credit, USD (the key's own spend cap is the hard stop). At 80% one alert; at 100% DeepSeek serves instead. */
  "providerCredit.openrelay": { kind: "amount", env: "OPENRELAY_CREDIT_USD" },
  /** The most Open Relay credit everyone but admins may use a week, USD; past it DeepSeek serves until Monday. "none" for no weekly budget. */
  "providerWeeklyCredit.openrelay": { kind: "usd", env: "OPENRELAY_WEEKLY_CREDIT_USD" },
  /** One person's weekly Open Relay spend at most, USD, on every plan, on its models without a cap of their own (GLM 5.3 Flash has modelPersonWeeklyUsd.glm-5.3-flash). "none" for no cap. */
  "providerPersonWeeklyUsd.openrelay": { kind: "usd", env: "OPENRELAY_PERSON_WEEKLY_USD" },
  /** Open Relay opt-in (default false: GLM 5.3 Flash is listed for everyone). */
  "providerOptIn.openrelay": { kind: "flag", env: "OPENRELAY_OPT_IN" },
  /** Who gets Open Relay's models: "all" (the default) or "pro". */
  "providerPlans.openrelay": { kind: "providerPlans", env: "OPENRELAY_PLANS" },
  /** The Open Relay models that are on, by id; [] for none. */
  "providerModels.openrelay": { kind: "models", env: "OPENRELAY_MODELS" },
  /** The speed probes (probes.ts): one tiny request per model every 10 minutes; false stops them. */
  speedProbes: { kind: "flag", env: "SPEED_PROBES" },
  /** Emails to users (user-emails.ts) on or off; they also need the USER_EMAIL binding or RESEND_API_KEY. */
  userEmails: { kind: "flag", env: "USER_EMAILS" },
  /** Free tokens inside dl only: chat requests without session events are refused (app.ts). */
  dlOnly: { kind: "flag", env: "DL_ONLY" },
  /** Free tokens in other coding agents launched by dl (`dl claude`); false refuses them (harness_not_allowed). */
  allowOtherHarnesses: { kind: "flag", env: "ALLOW_OTHER_HARNESSES" },
  /** The share of the weekly free allowance (and the trial) other coding agents may use, 0 to 1 (Pro is exempt). */
  otherHarnessShare: { kind: "weight", env: "OTHER_HARNESS_SHARE" },
  /** API keys for any tool (`dl api-key`, POST /v1/keys {kind: "tool"}); false refuses new and existing ones (tool_keys_off). */
  toolKeys: { kind: "flag", env: "TOOL_KEYS" },
  /** Tool keys per account; 0 allows none. */
  toolKeysMax: { kind: "count", env: "TOOL_KEYS_MAX" },
  /** Chat requests a minute one tool key may make (the per-person limit still applies). */
  toolKeyRequestsPerMinute: { kind: "count", env: "TOOL_KEY_REQUESTS_PER_MINUTE" },
  /** dl Pro offered to new subscribers; false hides it (offers, refusals, checkout) while existing subscribers keep it. */
  proOffered: { kind: "flag", env: "PRO_OFFERED" },
  /** The owner's email about access requests: "each" (one per request), "daily" (in the daily digest) or "off". */
  accessRequestAlerts: { kind: "alertMode", env: "ACCESS_REQUEST_ALERTS" },
  /** The owner's email about "Don't have GitHub?" clicks and answers: "each", "daily" (in the daily digest) or "off". */
  noGithubAlerts: { kind: "alertMode", env: "NO_GITHUB_ALERTS" },
  /** With accessRequestAlerts "each": access-request emails a UTC day at most; the rest are counted in the daily digest. */
  accessRequestEmailsPerDay: { kind: "count", env: "ACCESS_REQUEST_EMAILS_PER_DAY" },
  /** Runway alerts (runway.ts): weekly pace past the global weekly cap, provider credit running out, global total cap nearly used. */
  runwayAlerts: { kind: "flag", env: "RUNWAY_ALERTS" },
  /** A provider is reported when its credit lasts fewer than this many days at the last 24 hours' burn; 0 turns that check off. */
  runwayAlertDays: { kind: "count", env: "RUNWAY_ALERT_DAYS" },
  /** The global total cap is reported when this share of it, or less, is left (0 to 1); 0 turns that check off. */
  runwayTotalCapShare: { kind: "weight", env: "RUNWAY_TOTAL_CAP_SHARE" },
  /** A short automated description and safety label per session (use-description.ts); false turns it off. */
  useDescriptions: { kind: "flag", env: "USE_DESCRIPTIONS" },
  /** Description calls a UTC day across everyone; 0 stops them. */
  useDescriptionDailyCap: { kind: "count", env: "USE_DESCRIPTION_DAILY_CAP" },
  /** Whole UTC days of raw request log and session events kept (rollups keep every all-time number); 0 keeps everything. */
  rawLogKeepDays: { kind: "keepDays", env: "RAW_LOG_KEEP_DAYS" },
  /** Security work (by its use description or the request's own words) served by DeepSeek only, never GPT-6 (security-route.ts); false turns it off. */
  securityOffGpt6: { kind: "flag", env: "SECURITY_OFF_GPT6" },
  /** GPT-6 pre-send checks (presend-guard.ts): "enforce" or "off". */
  gpt6PresendGuard: { kind: "guardMode", env: "GPT6_PRESEND_GUARD" },
  /** How long each pre-send check may take, in ms; past it the request isn't sent. */
  gpt6GuardTimeoutMs: { kind: "count", env: "GPT6_GUARD_TIMEOUT_MS" },
  /** A trusted free-plan person's weekly GPT-6 budget, USD (gpt6-trust.ts); 0 turns the trust gate off. */
  gpt6TrustedWeeklyUsdCap: { kind: "amount", env: "GPT6_TRUSTED_WEEKLY_USD_CAP" },
  /** Which coding agents get GPT-6: "autopilot" (Autopilot only; other agents dl launches get DeepSeek) or "all". */
  gpt6Clients: { kind: "gpt6Clients", env: "GPT6_CLIENTS" },
  /** Automated moderation review of high-risk labels (moderation.ts): "enforce", "shadow" (never blocks) or "off" (the plain high-risk email). */
  moderation: { kind: "moderationMode", env: "MODERATION" },
  /** The lowest confidence, 0 to 1, a "block" verdict needs to block in "enforce" mode. */
  moderationBlockConfidence: { kind: "weight", env: "MODERATION_BLOCK_CONFIDENCE" },
  /** GitHub logins or ids moderation never blocks (it still reviews and emails). */
  moderationAllowlist: { kind: "people", env: "MODERATION_ALLOWLIST" },
  /** Minutes before the same person is reviewed again for a label of the same category. */
  moderationCooldownMinutes: { kind: "count", env: "MODERATION_COOLDOWN_MINUTES" },
  /** Reviews a UTC day across everyone; past it, the plain high-risk email; 0 stops reviews. */
  moderationDailyCap: { kind: "count", env: "MODERATION_DAILY_CAP" },
  /** The token allocator (allocator.ts): "on" or "off". */
  allocator: { kind: "allocatorMode", env: "ALLOCATOR" },
  /** Every account's weekly start grant while the allocator is on; never lowers a higher allowance. */
  allocatorStartTokens: { kind: "tokens", env: "ALLOCATOR_START_TOKENS" },
  /** The share of the week's allowance, 0 to 1, that starts an allocator decision. */
  allocatorTriggerShare: { kind: "weight", env: "ALLOCATOR_TRIGGER_SHARE" },
  /** Milliseconds to wait for the allocator's answer. */
  allocatorTimeoutMs: { kind: "count", env: "ALLOCATOR_TIMEOUT_MS" },
  /** The one-time weekly grace, as a share of the allowance, when the allocator is down or failed. */
  allocatorGraceShare: { kind: "weight", env: "ALLOCATOR_GRACE_SHARE" },
} as const;

export type RuntimeKey = keyof typeof RUNTIME_SETTINGS;
type Kind = (typeof RUNTIME_SETTINGS)[RuntimeKey]["kind"];

/** A stored override: a number, a boolean, null for "no cap" (USD caps only), a list or a word. */
export type OverrideValue = number | boolean | null | string | string[] | number[];

/**
 * Other names for settings: the generic provider names of OpenAI's and Luminal's credit settings.
 * An update under an alias changes the setting it names; the admin view shows both.
 */
export const ALIASES: Readonly<Record<string, RuntimeKey>> = {
  "providerCredit.openai": "openaiCreditUsd",
  "providerWeeklyCredit.openai": "openaiWeeklyCreditUsd",
  "providerCredit.luminal": "luminalCreditUsd",
  "providerWeeklyCredit.luminal": "luminalWeeklyCreditUsd",
};
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
    case "keepDays":
      return isKeepDays(value) ? value : "invalid";
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
    case "multiplier":
      return typeof value === "number" && Number.isFinite(value) && value >= PRO_MULTIPLIER_MIN && value <= PRO_MULTIPLIER_MAX ? value : "invalid";
    case "seconds":
      return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_FIRST_BYTE_TIMEOUT_SECONDS ? value : "invalid";
    case "alertMode":
      return typeof value === "string" && (ACCESS_REQUEST_ALERT_MODES as readonly string[]).includes(value) ? value : "invalid";
    case "guardMode":
      return typeof value === "string" && (GUARD_MODES as readonly string[]).includes(value) ? value : "invalid";
    case "gpt6Clients":
      return typeof value === "string" && (GPT6_CLIENTS as readonly string[]).includes(value) ? value : "invalid";
    case "moderationMode":
      return typeof value === "string" && (MODERATION_MODES as readonly string[]).includes(value) ? value : "invalid";
    case "allocatorMode":
      return typeof value === "string" && (ALLOCATOR_MODES as readonly string[]).includes(value) ? value : "invalid";
    case "people":
      return Array.isArray(value) && value.length <= 500 && value.every(isAllowlistEntry) ? value.map((v) => v.trim().toLowerCase()) : "invalid";
    case "providerStatus":
      return typeof value === "string" && (PROVIDER_STATUSES as readonly string[]).includes(value) ? value : "invalid";
    case "providerPlans":
      return typeof value === "string" && (PROVIDER_PLANS as readonly string[]).includes(value) ? value : "invalid";
    case "models":
      return Array.isArray(value) && isRegistryModelList(value) ? [...value] : "invalid";
    case "sellers":
      return Array.isArray(value) && isSellerList(value) ? value.map((v) => v.trim()) : "invalid";
    case "prices":
      return Array.isArray(value) && isPriceList(value) ? [...value] : "invalid";
    case "instant": {
      // Stored as Unix ms; "none" (null) turns it off whatever the env says.
      const parsed = parseInstant(value);
      return parsed === "invalid" ? "invalid" : (parsed ?? null);
    }
  }
}

const RULES: Record<Kind, string> = {
  tokens: `a whole number of tokens, 0 to ${MAX_TOKENS}`,
  count: `a whole number, 0 to ${MAX_COUNT}`,
  keepDays: `0 (keep everything) or a whole number of days, ${RAW_LOG_MIN_KEEP_DAYS} to ${RAW_LOG_MAX_KEEP_DAYS}`,
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
  multiplier: `a number from ${PRO_MULTIPLIER_MIN} to ${PRO_MULTIPLIER_MAX}`,
  seconds: `a number of seconds, more than 0 and at most ${MAX_FIRST_BYTE_TIMEOUT_SECONDS}`,
  alertMode: '"each", "daily" or "off"',
  guardMode: '"enforce" or "off"',
  gpt6Clients: '"autopilot" (GPT-6 in Autopilot only) or "all" (every coding agent)',
  moderationMode: '"enforce", "shadow" or "off"',
  allocatorMode: '"on" or "off"',
  people: 'a list of up to 500 GitHub logins or numeric ids, e.g. ["octocat", "12345"], or [] for none',
  providerStatus: '"on" or "paused"',
  providerPlans: '"pro" (dl Pro and admins only) or "all"',
  models: 'a list of the provider\'s model ids, e.g. ["moonshotai/kimi-k3.1-pro"], or [] for none',
  sellers: 'a list of up to 10 seller handles, e.g. ["deeprelay"], or [] for any seller that passes the other rules',
  prices: "three prices, [input, cache read, output], USD per million tokens",
  instant: 'an ISO time with its zone, e.g. "2026-11-20T00:00:00Z", Unix ms, or "none" to turn it off',
};

/**
 * Parses an admin update body. `null` clears an override; anything else must be valid for its
 * setting. Unknown names are refused so a typo can't silently do nothing.
 */
export function parseSettingsUpdate(body: Record<string, unknown>): { changes: SettingChange[] } | { error: string } {
  const entries = Object.entries(body);
  if (entries.length === 0) return { error: `Send one or more of ${Object.keys(RUNTIME_SETTINGS).join(", ")}.` };
  const changes: SettingChange[] = [];
  for (const [name, raw] of entries) {
    const key = ALIASES[name] ?? name;
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
      case "instant":
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
  const read = (key: RuntimeKey): OverrideValue => {
    const value = (config as unknown as Record<string, unknown>)[key];
    return value === undefined ? null : Array.isArray(value) ? ([...value] as OverrideValue) : (value as OverrideValue);
  };
  for (const key of Object.keys(RUNTIME_SETTINGS) as RuntimeKey[]) out[key] = read(key);
  for (const [alias, key] of Object.entries(ALIASES)) (out as Record<string, OverrideValue>)[alias] = read(key);
  return out;
}
