/**
 * The free tier's configuration, read from `env` only. Secrets (the OpenRouter key, the
 * GitHub OAuth app, the token signing key) are required; the knobs have defaults that match
 * the owner's decisions in installer#78.
 */

import { ALLOCATOR_MODES, type AllocatorMode } from "./allocator.js";
import { detectionRulesFrom, type DetectionRules, type DetectionRulesStatus, type ThresholdKey } from "./detection-rules.js";
import { DEFAULT_WEB_SIGNUP_URL } from "./web-signup.js";
import { isPriceList, isRegistryModelList, isSellerList, PROVIDER_PLANS, PROVIDER_STATUSES, REGISTRY_DEFAULTS, type ProviderId, type ProviderPlans, type ProviderStatus, type RegistrySettingsConfig } from "./providers.js";
import { FULL_PRECISION, isProviderSlugList, isQuantizationList, splitList, type DataCollection, type Quantization } from "./routing.js";

export class ConfigError extends Error {}

export interface FreeConfig extends RegistrySettingsConfig {
  /** Optional: without it the service never calls OpenRouter (Luminal serves, or nothing does). */
  openRouterApiKey: string | undefined;
  githubClientId: string;
  githubClientSecret: string;
  tokenSigningKey: string;
  /** GitHub numeric ids that may call the admin endpoints and skip the invite step. */
  adminGithubIds: ReadonlySet<number>;
  weeklyTokens: number;
  /**
   * The new-user trial's cutoff (TRIAL_CUTOFF, an ISO time or Unix ms; Unix ms here). Accounts
   * admitted at or after it get a one-time trial of `trialTokens` instead of the weekly free
   * allowance forever; accounts admitted before it keep the weekly free allowance (grandfathered).
   * Admins are never on trial. Undefined (the default): no trial for anyone.
   */
  trialCutoff: number | undefined;
  /** The one-time trial's tokens (TRIAL_TOKENS), counted as prompt (cached included) plus completion. */
  trialTokens: number;
  /**
   * Non-admin people at most while admission is invite-only. With open admission there is no
   * cap: the queue keeps spend inside the weekly budget instead (see queue.ts).
   */
  maxActiveUsers: number;
  /** USD across everyone but admins, this week. Undefined means no weekly stop. */
  globalWeeklyUsdCap: number | undefined;
  /** USD across everyone but admins, for the whole experiment. Undefined means no total stop. */
  globalTotalUsdCap: number | undefined;
  /**
   * A Full person's weekly GPT-6 budget (every GPT-6 model): their GPT-6 week ends at a pool's
   * tokens or at this much real cost, whichever comes first. DeepSeek has its own budget,
   * `deepseekWeeklyUsdCap`: it is much cheaper per token, so there is far more of it.
   */
  perPersonWeeklyUsdCap: number | undefined;
  /**
   * A Full person's weekly DeepSeek budget (DEEPSEEK_WEEKLY_USD_CAP). DeepSeek has no token cap,
   * so this is its only per-person limit. A personal cap (an admin's grant) applies to GPT-6;
   * DeepSeek then gets the larger of the personal cap and this.
   */
  deepseekWeeklyUsdCap: number | undefined;
  /**
   * The personal weekly dollar cap an admin's grant gives (GRANT_WEEKLY_USD_CAP): the Tools tab's
   * "Give free tokens", POST /admin/grant and granting a /request. A grant never lowers a higher
   * personal cap. Undefined or 0: a grant only sets Full, with no personal cap.
   */
  grantWeeklyUsdCap: number | undefined;
  /** GitHub accounts younger than this need an invite code even when admission is open. */
  minGithubAccountAgeDays: number;
  /** Full access needs an account at least this old (FULL_MIN_ACCOUNT_AGE_DAYS). */
  fullMinAccountAgeDays: number;
  /** ... and at least this many public repositories (FULL_MIN_PUBLIC_REPOS) ... */
  fullMinPublicRepos: number;
  /** ... or this many contributions in the last year (FULL_MIN_CONTRIBUTIONS). */
  fullMinContributions: number;
  /**
   * Additional account signals for Full (admission.ts `levelChecks`); the real values are set
   * in the private admin settings. Full needs the public bar and at least one fewer than this
   * many signals (HUMAN_SIGNALS_NEEDED); without the public bar, no number of them gives Full.
   */
  humanSignalsNeeded: number;
  /** Weeks with a contribution in the last year (MIN_ACTIVE_WEEKS). */
  minActiveWeeks: number;
  /** Age of the oldest owned non-fork repository (MIN_REPO_AGE_DAYS). */
  minRepoAgeDays: number;
  /** Accounts followed plus repositories starred (MIN_SOCIAL). */
  minSocial: number;
  /** Followers (MIN_FOLLOWERS). */
  minFollowers: number;
  /** Days either side of an account's creation that count as one batch (BATCH_WINDOW_DAYS). */
  batchWindowDays: number;
  /** Signed-up accounts in that window that make a batch, for accounts younger than the public bar's age; 0 turns it off (BATCH_SIZE). */
  batchSize: number;
  /**
   * Scales the batch threshold with sign-up volume: a creation window needs this many times the
   * average window's peers (and never fewer than `batchSize`); 0 keeps the fixed `batchSize`
   * (BATCH_DENSITY_FACTOR; admission.ts batchThreshold).
   */
  batchDensityFactor: number;
  /** A Starter account's weekly tokens (STARTER_WEEKLY_TOKENS), of every model. 0: no free tokens. */
  starterWeeklyTokens: number;
  /** A Starter account's weekly dollar cap (STARTER_WEEKLY_USD_CAP); undefined: tokens only. */
  starterWeeklyUsdCap: number | undefined;
  /** A Starter account's weekly DeepSeek budget (STARTER_DEEPSEEK_WEEKLY_USD_CAP); `starterWeeklyUsdCap` is its GPT-6 one. */
  starterDeepseekWeeklyUsdCap: number | undefined;
  /** The basic level (admission.ts BasicRule) needs an account at least this old (BASIC_MIN_ACCOUNT_AGE_DAYS). */
  basicMinAccountAgeDays: number;
  /** A basic account's weekly tokens, of every model (BASIC_WEEKLY_TOKENS); 0 turns the level off. */
  basicWeeklyTokens: number;
  /** A basic account's weekly dollar cap (BASIC_WEEKLY_USD_CAP); undefined: tokens only. */
  basicWeeklyUsdCap: number | undefined;
  /** A basic account's weekly DeepSeek budget (BASIC_DEEPSEEK_WEEKLY_USD_CAP); `basicWeeklyUsdCap` is its GPT-6 one. */
  basicDeepseekWeeklyUsdCap: number | undefined;
  /** New sign-ins one network gets a day before the rest are Starter (NETWORK_SIGNUPS_PER_DAY). */
  networkSignupsPerDay: number;
  /** Inboxes (`name@domain`) and domains (`@domain`) that can't sign up (BLOCKED_EMAILS, comma-separated). */
  blockedEmails: string[];
  /** New accounts a day from one company or custom email domain; public providers are exempt (DOMAIN_SIGNUPS_PER_DAY). */
  domainSignupsPerDay: number;
  /**
   * Past `domainSignupsPerDay`, refuse the sign-up (the old rule) instead of placing a new account
   * below Full at Starter, like the network limit does (DOMAIN_LIMIT_REFUSE; default off).
   */
  domainLimitRefuse: boolean;
  /**
   * Open admission: GitHub accounts at least `minGithubAccountAgeDays` old get in without an
   * invite code (still within `maxActiveUsers`). Off by default: invite-only for everyone.
   */
  openAdmission: boolean;
  /**
   * New accounts need some real GitHub activity to get in without an invite code: at least one
   * public repository, or at least one contribution in the last year. Accounts without either
   * are treated like accounts that are too new. If GitHub can't answer, the check passes.
   */
  requireGithubActivity: boolean;
  /** Kept for compatibility: false sets the cached-token weight to 0 unless CACHED_TOKEN_WEIGHT is set. */
  countCachedTokens: boolean;
  /**
   * How much one cached prompt token counts against the weekly token allowance, relative to
   * an uncached one. The USD caps always use the real reported cost.
   */
  cachedTokenWeight: number;
  /**
   * OpenRouter hosts to try first, as provider slugs (OPENROUTER_PROVIDER_ORDER, comma-separated).
   * Empty (the default) means no pinned host: the cheapest host that passes the filters first.
   */
  openRouterProviderOrder: readonly string[];
  /** Hosts allowed by precision (OPENROUTER_QUANTIZATIONS). Default: native FP8 and wider. Empty means no filter. */
  openRouterQuantizations: readonly Quantization[];
  /** `deny` (default) keeps only hosts that neither train on nor store prompts (OPENROUTER_DATA_COLLECTION). */
  openRouterDataCollection: DataCollection;
  /**
   * How long an OpenRouter host that just failed a request is skipped, in minutes
   * (OPENROUTER_HOST_COOLDOWN_MINUTES). 0 turns host avoidance off.
   */
  openRouterHostCooldownMinutes: number;
  /**
   * The queue starts when this week's free spend reaches this share of the weekly cap
   * (QUEUE_THRESHOLD, 0 to 1). Each Monday, the queue is admitted up to the same share.
   */
  queueThreshold: number;
  /** Places a queued person moves up for each referred friend who became weekly active (QUEUE_REFERRAL_PLACES). */
  queueReferralPlaces: number;
  /** Tokens a week each side of an active referral gets (REFERRAL_BONUS_TOKENS). */
  referralBonusTokens: number;
  /** The most referral bonus one person gets a week (REFERRAL_BONUS_CAP). */
  referralBonusCap: number;
  /** Referral links are this plus the code (REFERRAL_LINK_BASE). */
  referralLinkBase: string;
  /** What the paid plans are, for `/v1/me` and the 402 refusals. */
  offers: Offers;
  /** Where spend and health alerts go (ALERT_WEBHOOK_URL): Discord, Slack or Telegram. */
  alertWebhookUrl: string | undefined;
  /** ALERT_WEBHOOK_KIND: auto (from the URL), discord, slack or telegram. */
  alertWebhookKind: AlertKind;
  /** Where alert email goes (ALERT_EMAIL_TO); needs the ALERT_EMAIL send_email binding. */
  alertEmailTo: string | undefined;
  /** The alert email's sender (ALERT_EMAIL_FROM), on a zone with Email Routing on. */
  alertEmailFrom: string;
  /** Telegram's chat id (ALERT_TELEGRAM_CHAT_ID), unless the URL carries `chat_id`. */
  alertTelegramChatId: string | undefined;
  /** Stripe billing (stripe.ts). Without the secret key, the billing endpoints answer 503 billing_unavailable. */
  stripe: StripeConfig;
  /**
   * Pro's weekly open-models (DeepSeek) budget as a multiple of a Full free account's
   * (`deepseekWeeklyUsdCap`): PRO_OPEN_MODELS_MULTIPLIER, default 4; also a runtime setting.
   * Pro buys more open models only: its GPT-6 budget is the free plan's (GPT-6 stays for
   * trusted accounts, and paying is not a trust signal; gpt6-trust.ts).
   */
  proOpenModelsMultiplier: number;
  /**
   * Which provider serves chat requests first (PRIMARY_UPSTREAM): "openai" (the default),
   * "luminal" or "openrouter". A model's own provider always wins: this only decides what
   * happens when the model's provider has no key. OpenAI failures fall back to DeepSeek on
   * Luminal (see models.ts `fallback`); Luminal failures go back to the client as transient.
   */
  primaryUpstream: PrimaryUpstream;
  /** OpenAI's API key (OPENAI_API_KEY, a secret). Never logged. */
  openaiApiKey: string | undefined;
  /** Seconds to wait for OpenAI's response headers before falling back (OPENAI_FIRST_BYTE_TIMEOUT_SECONDS). */
  openaiFirstByteTimeoutSeconds: number;
  /** Prepaid OpenAI credit, USD (OPENAI_CREDIT_USD). At or past it, OpenAI-served usage falls back. */
  openaiCreditUsd: number;
  /** Free OpenAI credit a week the queue protects (OPENAI_WEEKLY_CREDIT_USD); undefined: no weekly budget. */
  openaiWeeklyCreditUsd: number | undefined;
  /** Luminal's API key (LUMINAL_API_KEY, a secret). Never logged. */
  luminalApiKey: string | undefined;
  /** Seconds to wait for Luminal's response headers before answering a transient 503 (LUMINAL_FIRST_BYTE_TIMEOUT_SECONDS). */
  luminalFirstByteTimeoutSeconds: number;
  /** Luminal list prices, USD per million tokens (LUMINAL_PRICE_INPUT, _CACHED, _OUTPUT). Luminal reports no cost. */
  luminalPrices: Prices;
  /**
   * The OpenRouter prices we were billed for the same model, USD per million tokens (OPENROUTER_PRICE_INPUT,
   * _CACHED, _OUTPUT). A Luminal request counts against the per-person dollar allowance at
   * these prices, so the allowance means the same whichever upstream served.
   */
  openRouterPrices: Prices;
  /** Prepaid Luminal credit, USD (LUMINAL_CREDIT_USD). At or past it, Luminal-served usage pauses. */
  luminalCreditUsd: number;
  /** Free Luminal credit a week the queue protects (LUMINAL_WEEKLY_CREDIT_USD); undefined: no weekly credit budget. */
  luminalWeeklyCreditUsd: number | undefined;
  /**
   * Liquid Inference's API key (LIQUID_INFERENCE_API_KEY, a secret). Never logged. Its other
   * settings are the registry ones (`providerCredit.liquid` and the like, providers.ts).
   */
  liquidApiKey: string | undefined;
  /** Seconds to wait for Liquid's response headers before a transient 503 (LIQUID_FIRST_BYTE_TIMEOUT_SECONDS). */
  liquidFirstByteTimeoutSeconds: number;
  /**
   * Open Relay's API key (OPENRELAY_API_KEY, a secret, `or_…`). Never logged. Its other settings
   * are the registry ones (`providerCredit.openrelay` and the like, providers.ts).
   */
  openrelayApiKey: string | undefined;
  /** Seconds to wait for Open Relay's response headers before a transient 503 (OPENRELAY_FIRST_BYTE_TIMEOUT_SECONDS). */
  openrelayFirstByteTimeoutSeconds: number;
  /** The speed probes (SPEED_PROBES, default on; also a runtime setting): one tiny request per model every 10 minutes (probes.ts). */
  speedProbes: boolean;
  /** The kill switch from `env`; the admin endpoint has its own, and either one pauses. */
  paused: boolean;
  /** The public origin for links, when the request's own origin isn't it (behind a proxy). */
  publicUrl: string | undefined;
  /**
   * dl.new's web sign-up page (WEB_SIGNUP_URL, an https URL; default https://dl.new/start): the
   * only page a web sign-in returns to and Pro checkout comes back to, and its origin the only one
   * the /web/* endpoints answer CORS for (web-signup.ts).
   */
  webSignupUrl: string;
  /**
   * Resend's API key (RESEND_API_KEY, a secret) for emails to users, used only when the USER_EMAIL
   * binding (Cloudflare Email Service) is absent. With neither, none are sent. Never logged.
   */
  resendApiKey: string | undefined;
  /** The sender of emails to users (EMAIL_FROM), name and address. */
  emailFrom: string;
  /** Where replies to them go (EMAIL_REPLY_TO). */
  emailReplyTo: string;
  /** Emails to users on or off (USER_EMAILS, default on); also a runtime setting. Needs the USER_EMAIL binding or `resendApiKey`. */
  userEmails: boolean;
  /** Send them to admins too (USER_EMAILS_TO_ADMINS), for testing. Off by default. */
  userEmailsToAdmins: boolean;
  /**
   * Free tokens work inside dl (Autopilot) only (DL_ONLY, default on); also a runtime setting.
   * A free-plan account that sends chat requests but no session events is refused (app.ts).
   */
  dlOnly: boolean;
  /**
   * Free tokens in other coding agents launched by dl (`dl claude`, `dl opencode`), ALLOW_OTHER_HARNESSES,
   * default on; also a runtime setting. Off: their requests get 403 `harness_not_allowed`.
   */
  allowOtherHarnesses: boolean;
  /**
   * The share (0 to 1) of a person's weekly free allowance, trial included, that other coding
   * agents (`dl claude`, `dl opencode`) may use: their requests are held to the allowance scaled by it, counted
   * against everything the week has used. Pro is exempt. OTHER_HARNESS_SHARE, default 0.5; also a runtime setting.
   */
  otherHarnessShare: number;
  /**
   * API keys for any tool (TOOL_KEYS, default on); also a runtime setting. A tool key is a `dlk_`
   * key of kind "tool" (`dl api-key`, POST /v1/keys {kind: "tool"}) that an account in good
   * standing (not blocked or suspended, with free tokens) pastes into any OpenAI- or
   * Anthropic-compatible tool. Its requests are never refused as dl_only; GPT-6 stays in
   * Autopilot, `otherHarnessShare` applies, and every other guard does too. Off: no new tool
   * keys (403 tool_keys_off) and existing ones are refused the same way (not deleted).
   */
  toolKeys: boolean;
  /** Tool keys per account (TOOL_KEYS_MAX, default 3); also a runtime setting. 0 allows none. */
  toolKeysMax: number;
  /** Chat requests a minute one tool key may make (TOOL_KEY_REQUESTS_PER_MINUTE, default 30), under the per-person limit; also a runtime setting. */
  toolKeyRequestsPerMinute: number;
  /**
   * Whether dl Pro is offered to anyone new (PRO_OFFERED, default on); also a runtime setting.
   * Off: `offers` leaves Pro out (the top-up stays), free users' refusals stop naming Pro, and a
   * new Pro checkout is refused (403 pro_not_offered). Existing subscribers keep their plan, their
   * Pro wording and the billing portal.
   */
  proOffered: boolean;
  /**
   * A short automated description of what each session is about, with a safety label
   * (use-description.ts), USE_DESCRIPTIONS, default on; also a runtime setting.
   */
  useDescriptions: boolean;
  /** Description calls a UTC day across everyone (USE_DESCRIPTION_DAILY_CAP, default 2000); also a runtime setting. */
  useDescriptionDailyCap: number;
  /**
   * Whole UTC days of the raw request log and session events the Directory keeps (RAW_LOG_KEEP_DAYS,
   * default 35; 0 keeps everything); older rows are pruned in small batches every 10 minutes. Every
   * all-time number reads rollups, so pruning changes none of them. Also a runtime setting.
   */
  rawLogKeepDays: number;
  /**
   * Security work is served by DeepSeek only, never GPT-6 (security-route.ts):
   * SECURITY_OFF_GPT6, default on; also a runtime setting.
   */
  securityOffGpt6: boolean;
  /**
   * The GPT-6 pre-send checks (presend-guard.ts), GPT6_PRESEND_GUARD: "enforce" (the default: every
   * non-admin GPT-6 request's new content is checked before it is sent, and anything flagged,
   * failed or late isn't sent) or "off". Also a runtime setting.
   */
  gpt6PresendGuard: GuardMode;
  /** How long each pre-send check may take, in ms (GPT6_GUARD_TIMEOUT_MS, default 4000); past it, the request isn't sent. */
  gpt6GuardTimeoutMs: number;
  /**
   * The GPT-6 trust gate (gpt6-trust.ts), GPT6_TRUSTED_WEEKLY_USD_CAP: 0 (the default) changes
   * nothing; above 0, GPT-6 is served only to trusted people, a free-plan one with this weekly
   * GPT-6 budget (a personal cap an admin set still wins). Also a runtime setting.
   */
  gpt6TrustedWeeklyUsdCap: number;
  /**
   * Which coding agents get GPT-6 (OpenAI's models), GPT6_CLIENTS: "autopilot" (the default: only
   * Autopilot, our own app, through a sign-in token or server key; another agent dl launches with a
   * harness key, `dl claude`, `dl opencode`, `dl pi`, `dl t3` and `dl proxy`, gets 402
   * provider_limit, reason "autopilot_only", pointing at DeepSeek) or "all" (every agent, for when
   * OpenAI approves giving other agents access). Admins are never held to it. Also a runtime setting.
   */
  gpt6Clients: Gpt6Clients;
  /**
   * Automated moderation review of high-risk labels (moderation.ts), MODERATION: "enforce" (the
   * default: a confident "block" verdict blocks the person), "shadow" (decides and emails, never
   * blocks) or "off" (no review: the owner gets today's high-risk email). Also a runtime setting.
   */
  moderation: ModerationMode;
  /** The lowest confidence (0 to 1) a "block" verdict needs to block (MODERATION_BLOCK_CONFIDENCE, default 0.85). */
  moderationBlockConfidence: number;
  /** GitHub ids or logins moderation never blocks (MODERATION_ALLOWLIST, comma-separated; logins lowercased). */
  moderationAllowlist: readonly string[];
  /** Minutes before the same person is reviewed again for the same category (MODERATION_COOLDOWN_MINUTES, default 60). */
  moderationCooldownMinutes: number;
  /** Reviews a UTC day across everyone (MODERATION_DAILY_CAP, default 300); past it, the plain high-risk email. */
  moderationDailyCap: number;
  /** The token allocator (allocator.ts), ALLOCATOR: "on" (the default) or "off". Also a runtime setting. */
  allocator: AllocatorMode;
  /** Every account's weekly start grant while the allocator is on (ALLOCATOR_START_TOKENS, default 1,000,000). */
  allocatorStartTokens: number;
  /** The share of the week's allowance (0 to 1) that starts a decision (ALLOCATOR_TRIGGER_SHARE, default 0.8). */
  allocatorTriggerShare: number;
  /** Milliseconds to wait for the allocator's answer (ALLOCATOR_TIMEOUT_MS, default 5000). */
  allocatorTimeoutMs: number;
  /** The one-time weekly grace when the allocator is down, as a share of the allowance (ALLOCATOR_GRACE_SHARE, default 0.2). */
  allocatorGraceShare: number;
  /**
   * The owner's email about access requests (/request in dl), ACCESS_REQUEST_ALERTS: "each" (one
   * per request, the default), "daily" (counted in the daily digest instead) or "off". Also a
   * runtime setting.
   */
  accessRequestAlerts: AccessRequestAlerts;
  /**
   * The owner's email about "Don't have GitHub?" clicks and answers (no-github.ts),
   * NO_GITHUB_ALERTS: "each" (the default), "daily" (in the daily digest) or "off". Also a runtime setting.
   */
  noGithubAlerts: AccessRequestAlerts;
  /**
   * With accessRequestAlerts "each", the most access-request emails a UTC day
   * (ACCESS_REQUEST_EMAILS_PER_DAY, default 20); past it the day's requests are counted in the
   * daily digest instead, so a burst can't bury the budget alerts. Also a runtime setting.
   */
  accessRequestEmailsPerDay: number;
  /**
   * Runway alerts (runway.ts, RUNWAY_ALERTS, default on): an email when this week's pace runs
   * past the global weekly cap, a provider's credit runs out within `runwayAlertDays` at the
   * last day's burn, or the global total cap is within `runwayTotalCapShare` of its end. Each
   * at most once a UTC day. Also runtime settings.
   */
  runwayAlerts: boolean;
  /** Days of credit left (at the last 24 hours' burn) below which a provider is reported (RUNWAY_ALERT_DAYS, default 7); 0 turns it off. */
  runwayAlertDays: number;
  /** The share of the global total cap left at which it is reported (RUNWAY_TOTAL_CAP_SHARE, 0 to 1, default 0.1); 0 turns it off. */
  runwayTotalCapShare: number;
  /**
   * The anti-abuse rules (detection-rules.ts): the DETECTION_RULES secret's over the public
   * defaults. Its thresholds are already folded into the settings above.
   */
  detection: DetectionRules;
  /** Where `detection` came from, with counts only: what /admin/config shows. */
  detectionStatus: DetectionRulesStatus;
}

export type AccessRequestAlerts = "each" | "daily" | "off";
export type ModerationMode = "off" | "shadow" | "enforce";
export type GuardMode = "off" | "enforce";
export type Gpt6Clients = "autopilot" | "all";
export const GPT6_CLIENTS: readonly Gpt6Clients[] = ["autopilot", "all"];
export const GUARD_MODES: readonly GuardMode[] = ["off", "enforce"];
export const MODERATION_MODES: readonly ModerationMode[] = ["off", "shadow", "enforce"];

/** A GitHub login or numeric id, as moderationAllowlist holds it (lowercased). */
export function isAllowlistEntry(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value.trim());
}
export const ACCESS_REQUEST_ALERT_MODES: readonly AccessRequestAlerts[] = ["each", "daily", "off"];

/** Who served a request: a provider (providers.ts), or OpenRouter, the old upstream. */
export type Upstream = ProviderId | "openrouter";
/** The upstreams PRIMARY_UPSTREAM can name. A registry provider never serves by default. */
export type PrimaryUpstream = "openai" | "luminal" | "openrouter";
export const UPSTREAMS: readonly PrimaryUpstream[] = ["openai", "luminal", "openrouter"];

/** USD per million tokens. Cached is the price of a cached prompt token; reasoning is billed as output. */
export interface Prices {
  input: number;
  cached: number;
  output: number;
}

export type AlertKind = "auto" | "discord" | "slack" | "telegram";

export interface Offers {
  /** `valueLine`: one short sentence a client shows next to the price (PRO_VALUE_LINE). */
  pro: { priceUsdMonthly: number; tokensPerWeek: number; valueLine: string };
  /**
   * Top-ups add usage dollars: `quantity` units of `unitPriceUsd` (from `minQuantity` to
   * `maxQuantity`), each adding `usageMultiplier` times its price, valid `validDays`.
   * `legacyTokens`: what a checkout started under the old token top-up still grants.
   */
  topup: { unitPriceUsd: number; minQuantity: number; maxQuantity: number; usageMultiplier: number; validDays: number; legacyTokens: number };
}

export interface StripeConfig {
  secretKey: string | undefined;
  webhookSecret: string | undefined;
  priceTopup: string | undefined;
  successUrl: string;
  cancelUrl: string;
  portalReturnUrl: string;
}

export const DEFAULTS = {
  weeklyTokens: 50_000_000,
  trialTokens: 10_000_000,
  maxActiveUsers: 50,
  countCachedTokens: true,
  globalWeeklyUsdCap: 2000,
  globalTotalUsdCap: 7000,
  /**
   * Two weekly dollar budgets per person. GPT-6 (every GPT-6 model) is the tighter one; DeepSeek
   * is much cheaper per token for us and fast, so its budget is several times larger.
   */
  perPersonWeeklyUsdCap: 2,
  deepseekWeeklyUsdCap: 8,
  grantWeeklyUsdCap: 20,
  minGithubAccountAgeDays: 30,
  fullMinAccountAgeDays: 90,
  fullMinPublicRepos: 3,
  fullMinContributions: 50,
  // The farm-detection thresholds below are generic public starting values; production sets its
  // own in the DETECTION_RULES secret's `thresholds` (detection-rules.ts) or in /admin/config.
  humanSignalsNeeded: 2,
  minActiveWeeks: 4,
  minRepoAgeDays: 90,
  minSocial: 5,
  minFollowers: 1,
  batchWindowDays: 2,
  batchSize: 10,
  batchDensityFactor: 3,
  // Publicly there is only Free and Pro: by default basic and Starter get exactly Full's weekly
  // tokens and dollar budgets (the settings can still differ later).
  starterWeeklyTokens: 50_000_000,
  starterWeeklyUsdCap: 2,
  starterDeepseekWeeklyUsdCap: 8,
  basicMinAccountAgeDays: 180,
  basicWeeklyTokens: 50_000_000,
  basicWeeklyUsdCap: 2,
  basicDeepseekWeeklyUsdCap: 8,
  networkSignupsPerDay: 3,
  blockedEmails: [],
  domainSignupsPerDay: 10,
  domainLimitRefuse: false,
  openAdmission: false,
  requireGithubActivity: true,
  dlOnly: true,
  allowOtherHarnesses: true,
  otherHarnessShare: 0.5,
  toolKeys: true,
  toolKeysMax: 3,
  toolKeyRequestsPerMinute: 30,
  proOffered: true,
  accessRequestAlerts: "each" as AccessRequestAlerts,
  noGithubAlerts: "each" as AccessRequestAlerts,
  accessRequestEmailsPerDay: 20,
  runwayAlerts: true,
  runwayAlertDays: 7,
  runwayTotalCapShare: 0.1,
  useDescriptions: true,
  useDescriptionDailyCap: 2000,
  rawLogKeepDays: 35,
  securityOffGpt6: true,
  gpt6PresendGuard: "enforce" as GuardMode,
  gpt6GuardTimeoutMs: 4000,
  gpt6TrustedWeeklyUsdCap: 0,
  gpt6Clients: "autopilot" as Gpt6Clients,
  moderation: "enforce" as ModerationMode,
  moderationBlockConfidence: 0.85,
  moderationAllowlist: [] as string[],
  moderationCooldownMinutes: 60,
  moderationDailyCap: 300,
  allocator: "on" as AllocatorMode,
  allocatorStartTokens: 1_000_000,
  allocatorTriggerShare: 0.8,
  allocatorTimeoutMs: 5_000,
  allocatorGraceShare: 0.2,
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
  openRouterProviderOrder: [] as readonly string[],
  openRouterQuantizations: FULL_PRECISION,
  openRouterDataCollection: "deny" as DataCollection,
  openRouterHostCooldownMinutes: 10,
  queueThreshold: 0.8,
  queueReferralPlaces: 25,
  referralBonusTokens: 10_000_000,
  referralBonusCap: 50_000_000,
  referralLinkBase: "https://dl.new/r/",
  /** Dollars and cents: $7 a month (dl Pro phase 1). Checkout prices it inline (stripe.ts), so no Stripe Price is needed. */
  proPriceUsdMonthly: 7,
  /**
   * Pro's weekly tokens sit well above what its weekly dollar ceiling buys on the default model,
   * so the dollar ceiling is the limit that binds, on cheap and expensive models alike.
   */
  proTokensPerWeek: 300_000_000,
  proOpenModelsMultiplier: 4,
  proValueLine: "Higher limits and early access to new models.",
  /** Top-ups: $1 units, 2 to 20 of them; each $1 adds $1.25 of usage, for 90 days. */
  topupUnitPriceUsd: 1,
  topupMinQuantity: 2,
  topupMaxQuantity: 20,
  topupUsageMultiplier: 1.25,
  topupValidDays: 90,
  /** The old token top-up ($3 for 50M tokens): checkouts started before dollar top-ups still get what they paid for. */
  topupLegacyTokens: 50_000_000,
  alertEmailFrom: "alerts@dl.new",
  billingSuccessUrl: "https://dl.new/billing/success",
  billingCancelUrl: "https://dl.new/billing/cancel",
  billingPortalReturnUrl: "https://dl.new/billing",
  primaryUpstream: "openai" as PrimaryUpstream,
  openaiFirstByteTimeoutSeconds: 30,
  openaiCreditUsd: 5000,
  openaiWeeklyCreditUsd: 2000,
  luminalFirstByteTimeoutSeconds: 30,
  /** https://luminal.com/pricing, 2026-11-04. */
  luminalPrices: { input: 0.1425, cached: 0.0029, output: 0.57 } as Prices,
  /**
   * What OpenRouter actually billed us: the prices of the cheapest full-precision host that
   * served the free tier (Morph), as listed by OpenRouter's endpoints API
   * (https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash-1017/endpoints) on
   * 2026-11-04, and matched by a real billed request. So a person's week ends where it did
   * before Luminal. Recheck against `requests.cost_usd` of OpenRouter rows if hosts change.
   */
  openRouterPrices: { input: 0.035, cached: 0.006, output: 0.315 } as Prices,
  luminalCreditUsd: 2000,
  luminalWeeklyCreditUsd: 250,
  emailFrom: "sina <sina@directionallylocal.com>",
  emailReplyTo: "contact@directionallylocal.com",
} as const;

/** The longest first-byte wait for Luminal, in seconds. */
export const MAX_FIRST_BYTE_TIMEOUT_SECONDS = 300;

/** The longest host cooldown, in minutes: a day. */
export const MAX_HOST_COOLDOWN_MINUTES = 1440;

export function readFreeConfig(env: Record<string, unknown>): FreeConfig {
  const signingKey = required(env, "TOKEN_SIGNING_KEY");
  if (new TextEncoder().encode(signingKey).length < 32) throw new ConfigError("TOKEN_SIGNING_KEY must be at least 32 bytes.");
  const detection = detectionRulesFrom(joinedSecret(env, "DETECTION_RULES"));
  // A farm-detection threshold: its env var, else the secret's value, else the public default.
  const threshold = (key: ThresholdKey, name: string) => whole(env[name], detection.rules.thresholds[key] ?? DEFAULTS[key], name);
  return {
    openRouterApiKey: text(env.OPENROUTER_API_KEY),
    githubClientId: required(env, "GITHUB_CLIENT_ID"),
    githubClientSecret: required(env, "GITHUB_CLIENT_SECRET"),
    tokenSigningKey: signingKey,
    adminGithubIds: githubIds(text(env.ADMIN_GITHUB_IDS)),
    weeklyTokens: whole(env.WEEKLY_TOKENS, DEFAULTS.weeklyTokens, "WEEKLY_TOKENS"),
    trialCutoff: instant(env.TRIAL_CUTOFF, "TRIAL_CUTOFF"),
    trialTokens: whole(env.TRIAL_TOKENS, DEFAULTS.trialTokens, "TRIAL_TOKENS"),
    maxActiveUsers: whole(env.MAX_ACTIVE_USERS, DEFAULTS.maxActiveUsers, "MAX_ACTIVE_USERS"),
    globalWeeklyUsdCap: usd(env.GLOBAL_WEEKLY_USD_CAP, DEFAULTS.globalWeeklyUsdCap, "GLOBAL_WEEKLY_USD_CAP"),
    globalTotalUsdCap: usd(env.GLOBAL_TOTAL_USD_CAP, DEFAULTS.globalTotalUsdCap, "GLOBAL_TOTAL_USD_CAP"),
    perPersonWeeklyUsdCap: usd(env.PER_PERSON_WEEKLY_USD_CAP, DEFAULTS.perPersonWeeklyUsdCap, "PER_PERSON_WEEKLY_USD_CAP"),
    deepseekWeeklyUsdCap: usd(env.DEEPSEEK_WEEKLY_USD_CAP, DEFAULTS.deepseekWeeklyUsdCap, "DEEPSEEK_WEEKLY_USD_CAP"),
    grantWeeklyUsdCap: usd(env.GRANT_WEEKLY_USD_CAP, DEFAULTS.grantWeeklyUsdCap, "GRANT_WEEKLY_USD_CAP"),
    minGithubAccountAgeDays: whole(env.MIN_GITHUB_ACCOUNT_AGE_DAYS, DEFAULTS.minGithubAccountAgeDays, "MIN_GITHUB_ACCOUNT_AGE_DAYS"),
    fullMinAccountAgeDays: whole(env.FULL_MIN_ACCOUNT_AGE_DAYS, DEFAULTS.fullMinAccountAgeDays, "FULL_MIN_ACCOUNT_AGE_DAYS"),
    fullMinPublicRepos: whole(env.FULL_MIN_PUBLIC_REPOS, DEFAULTS.fullMinPublicRepos, "FULL_MIN_PUBLIC_REPOS"),
    fullMinContributions: whole(env.FULL_MIN_CONTRIBUTIONS, DEFAULTS.fullMinContributions, "FULL_MIN_CONTRIBUTIONS"),
    humanSignalsNeeded: threshold("humanSignalsNeeded", "HUMAN_SIGNALS_NEEDED"),
    minActiveWeeks: threshold("minActiveWeeks", "MIN_ACTIVE_WEEKS"),
    minRepoAgeDays: threshold("minRepoAgeDays", "MIN_REPO_AGE_DAYS"),
    minSocial: threshold("minSocial", "MIN_SOCIAL"),
    minFollowers: threshold("minFollowers", "MIN_FOLLOWERS"),
    batchWindowDays: threshold("batchWindowDays", "BATCH_WINDOW_DAYS"),
    batchSize: threshold("batchSize", "BATCH_SIZE"),
    batchDensityFactor: threshold("batchDensityFactor", "BATCH_DENSITY_FACTOR"),
    starterWeeklyTokens: whole(env.STARTER_WEEKLY_TOKENS, DEFAULTS.starterWeeklyTokens, "STARTER_WEEKLY_TOKENS"),
    starterWeeklyUsdCap: usd(env.STARTER_WEEKLY_USD_CAP, DEFAULTS.starterWeeklyUsdCap, "STARTER_WEEKLY_USD_CAP"),
    starterDeepseekWeeklyUsdCap: usd(env.STARTER_DEEPSEEK_WEEKLY_USD_CAP, DEFAULTS.starterDeepseekWeeklyUsdCap, "STARTER_DEEPSEEK_WEEKLY_USD_CAP"),
    basicMinAccountAgeDays: threshold("basicMinAccountAgeDays", "BASIC_MIN_ACCOUNT_AGE_DAYS"),
    basicWeeklyTokens: whole(env.BASIC_WEEKLY_TOKENS, DEFAULTS.basicWeeklyTokens, "BASIC_WEEKLY_TOKENS"),
    basicWeeklyUsdCap: usd(env.BASIC_WEEKLY_USD_CAP, DEFAULTS.basicWeeklyUsdCap, "BASIC_WEEKLY_USD_CAP"),
    basicDeepseekWeeklyUsdCap: usd(env.BASIC_DEEPSEEK_WEEKLY_USD_CAP, DEFAULTS.basicDeepseekWeeklyUsdCap, "BASIC_DEEPSEEK_WEEKLY_USD_CAP"),
    networkSignupsPerDay: whole(env.NETWORK_SIGNUPS_PER_DAY, DEFAULTS.networkSignupsPerDay, "NETWORK_SIGNUPS_PER_DAY"),
    blockedEmails: env.BLOCKED_EMAILS === undefined ? [...DEFAULTS.blockedEmails] : String(env.BLOCKED_EMAILS).split(",").map((v) => v.trim()).filter(Boolean),
    domainSignupsPerDay: threshold("domainSignupsPerDay", "DOMAIN_SIGNUPS_PER_DAY"),
    domainLimitRefuse: flag(env.DOMAIN_LIMIT_REFUSE, DEFAULTS.domainLimitRefuse, "DOMAIN_LIMIT_REFUSE"),
    openAdmission: flag(env.OPEN_ADMISSION, DEFAULTS.openAdmission, "OPEN_ADMISSION"),
    requireGithubActivity: flag(env.REQUIRE_GITHUB_ACTIVITY, DEFAULTS.requireGithubActivity, "REQUIRE_GITHUB_ACTIVITY"),
    countCachedTokens: flag(env.COUNT_CACHED_TOKENS, DEFAULTS.countCachedTokens, "COUNT_CACHED_TOKENS"),
    cachedTokenWeight: cachedWeight(env),
    openRouterProviderOrder: providerOrder(env.OPENROUTER_PROVIDER_ORDER),
    openRouterQuantizations: quantizations(env.OPENROUTER_QUANTIZATIONS),
    openRouterDataCollection: dataCollection(env.OPENROUTER_DATA_COLLECTION),
    openRouterHostCooldownMinutes: hostCooldown(env.OPENROUTER_HOST_COOLDOWN_MINUTES),
    queueThreshold: share(env.QUEUE_THRESHOLD, DEFAULTS.queueThreshold, "QUEUE_THRESHOLD"),
    queueReferralPlaces: whole(env.QUEUE_REFERRAL_PLACES, DEFAULTS.queueReferralPlaces, "QUEUE_REFERRAL_PLACES"),
    referralBonusTokens: whole(env.REFERRAL_BONUS_TOKENS, DEFAULTS.referralBonusTokens, "REFERRAL_BONUS_TOKENS"),
    referralBonusCap: whole(env.REFERRAL_BONUS_CAP, DEFAULTS.referralBonusCap, "REFERRAL_BONUS_CAP"),
    referralLinkBase: text(env.REFERRAL_LINK_BASE) ?? DEFAULTS.referralLinkBase,
    offers: {
      pro: {
        priceUsdMonthly: price(env.PRO_PRICE_USD_MONTHLY, DEFAULTS.proPriceUsdMonthly, "PRO_PRICE_USD_MONTHLY"),
        tokensPerWeek: whole(env.PRO_TOKENS_PER_WEEK, DEFAULTS.proTokensPerWeek, "PRO_TOKENS_PER_WEEK"),
        valueLine: valueLine(env.PRO_VALUE_LINE),
      },
      topup: {
        unitPriceUsd: price(env.TOPUP_UNIT_PRICE_USD, DEFAULTS.topupUnitPriceUsd, "TOPUP_UNIT_PRICE_USD"),
        ...quantities(env),
        usageMultiplier: multiplier(env.TOPUP_USAGE_MULTIPLIER),
        validDays: whole(env.TOPUP_VALID_DAYS, DEFAULTS.topupValidDays, "TOPUP_VALID_DAYS"),
        legacyTokens: whole(env.TOPUP_TOKENS, DEFAULTS.topupLegacyTokens, "TOPUP_TOKENS"),
      },
    },
    alertWebhookUrl: webhookUrl(env.ALERT_WEBHOOK_URL),
    alertWebhookKind: alertKind(env.ALERT_WEBHOOK_KIND),
    alertTelegramChatId: text(env.ALERT_TELEGRAM_CHAT_ID),
    alertEmailTo: emailAddress(env.ALERT_EMAIL_TO, "ALERT_EMAIL_TO"),
    alertEmailFrom: emailAddress(env.ALERT_EMAIL_FROM, "ALERT_EMAIL_FROM") ?? DEFAULTS.alertEmailFrom,
    stripe: {
      secretKey: text(env.STRIPE_SECRET_KEY),
      webhookSecret: text(env.STRIPE_WEBHOOK_SECRET),
      priceTopup: stripeId(env.STRIPE_PRICE_TOPUP, "price_", "STRIPE_PRICE_TOPUP"),
      successUrl: httpsUrl(env.BILLING_SUCCESS_URL, "BILLING_SUCCESS_URL") ?? DEFAULTS.billingSuccessUrl,
      cancelUrl: httpsUrl(env.BILLING_CANCEL_URL, "BILLING_CANCEL_URL") ?? DEFAULTS.billingCancelUrl,
      portalReturnUrl: httpsUrl(env.BILLING_PORTAL_RETURN_URL, "BILLING_PORTAL_RETURN_URL") ?? DEFAULTS.billingPortalReturnUrl,
    },
    proOpenModelsMultiplier: proMultiplier(env.PRO_OPEN_MODELS_MULTIPLIER),
    primaryUpstream: upstream(env.PRIMARY_UPSTREAM),
    openaiApiKey: text(env.OPENAI_API_KEY),
    openaiFirstByteTimeoutSeconds: timeoutSeconds(env.OPENAI_FIRST_BYTE_TIMEOUT_SECONDS, DEFAULTS.openaiFirstByteTimeoutSeconds, "OPENAI_FIRST_BYTE_TIMEOUT_SECONDS"),
    openaiCreditUsd: amount(env.OPENAI_CREDIT_USD, DEFAULTS.openaiCreditUsd, "OPENAI_CREDIT_USD"),
    openaiWeeklyCreditUsd: usd(env.OPENAI_WEEKLY_CREDIT_USD, DEFAULTS.openaiWeeklyCreditUsd, "OPENAI_WEEKLY_CREDIT_USD"),
    luminalApiKey: text(env.LUMINAL_API_KEY),
    luminalFirstByteTimeoutSeconds: timeoutSeconds(env.LUMINAL_FIRST_BYTE_TIMEOUT_SECONDS, DEFAULTS.luminalFirstByteTimeoutSeconds, "LUMINAL_FIRST_BYTE_TIMEOUT_SECONDS"),
    luminalPrices: prices(env, "LUMINAL_PRICE", DEFAULTS.luminalPrices),
    openRouterPrices: prices(env, "OPENROUTER_PRICE", DEFAULTS.openRouterPrices),
    luminalCreditUsd: amount(env.LUMINAL_CREDIT_USD, DEFAULTS.luminalCreditUsd, "LUMINAL_CREDIT_USD"),
    luminalWeeklyCreditUsd: usd(env.LUMINAL_WEEKLY_CREDIT_USD, DEFAULTS.luminalWeeklyCreditUsd, "LUMINAL_WEEKLY_CREDIT_USD"),
    liquidApiKey: text(env.LIQUID_INFERENCE_API_KEY),
    liquidFirstByteTimeoutSeconds: timeoutSeconds(env.LIQUID_FIRST_BYTE_TIMEOUT_SECONDS, 30, "LIQUID_FIRST_BYTE_TIMEOUT_SECONDS"),
    openrelayApiKey: text(env.OPENRELAY_API_KEY),
    openrelayFirstByteTimeoutSeconds: timeoutSeconds(env.OPENRELAY_FIRST_BYTE_TIMEOUT_SECONDS, 30, "OPENRELAY_FIRST_BYTE_TIMEOUT_SECONDS"),
    speedProbes: flag(env.SPEED_PROBES, true, "SPEED_PROBES"),
    ...registrySettings(env),
    paused: flag(env.PAUSED, false, "PAUSED"),
    publicUrl: text(env.PUBLIC_URL)?.replace(/\/+$/, ""),
    webSignupUrl: webSignupUrl(env.WEB_SIGNUP_URL),
    resendApiKey: text(env.RESEND_API_KEY),
    emailFrom: sender(env.EMAIL_FROM) ?? DEFAULTS.emailFrom,
    emailReplyTo: emailAddress(env.EMAIL_REPLY_TO, "EMAIL_REPLY_TO") ?? DEFAULTS.emailReplyTo,
    userEmails: flag(env.USER_EMAILS, true, "USER_EMAILS"),
    userEmailsToAdmins: flag(env.USER_EMAILS_TO_ADMINS, false, "USER_EMAILS_TO_ADMINS"),
    dlOnly: flag(env.DL_ONLY, DEFAULTS.dlOnly, "DL_ONLY"),
    allowOtherHarnesses: flag(env.ALLOW_OTHER_HARNESSES, DEFAULTS.allowOtherHarnesses, "ALLOW_OTHER_HARNESSES"),
    otherHarnessShare: share(env.OTHER_HARNESS_SHARE, DEFAULTS.otherHarnessShare, "OTHER_HARNESS_SHARE"),
    toolKeys: flag(env.TOOL_KEYS, DEFAULTS.toolKeys, "TOOL_KEYS"),
    toolKeysMax: whole(env.TOOL_KEYS_MAX, DEFAULTS.toolKeysMax, "TOOL_KEYS_MAX"),
    toolKeyRequestsPerMinute: whole(env.TOOL_KEY_REQUESTS_PER_MINUTE, DEFAULTS.toolKeyRequestsPerMinute, "TOOL_KEY_REQUESTS_PER_MINUTE"),
    proOffered: flag(env.PRO_OFFERED, DEFAULTS.proOffered, "PRO_OFFERED"),
    accessRequestAlerts: accessRequestAlerts(env.ACCESS_REQUEST_ALERTS),
    noGithubAlerts: alertMode(env.NO_GITHUB_ALERTS, DEFAULTS.noGithubAlerts, "NO_GITHUB_ALERTS"),
    accessRequestEmailsPerDay: whole(env.ACCESS_REQUEST_EMAILS_PER_DAY, DEFAULTS.accessRequestEmailsPerDay, "ACCESS_REQUEST_EMAILS_PER_DAY"),
    runwayAlerts: flag(env.RUNWAY_ALERTS, DEFAULTS.runwayAlerts, "RUNWAY_ALERTS"),
    runwayAlertDays: whole(env.RUNWAY_ALERT_DAYS, DEFAULTS.runwayAlertDays, "RUNWAY_ALERT_DAYS"),
    runwayTotalCapShare: share(env.RUNWAY_TOTAL_CAP_SHARE, DEFAULTS.runwayTotalCapShare, "RUNWAY_TOTAL_CAP_SHARE"),
    useDescriptions: flag(env.USE_DESCRIPTIONS, DEFAULTS.useDescriptions, "USE_DESCRIPTIONS"),
    useDescriptionDailyCap: whole(env.USE_DESCRIPTION_DAILY_CAP, DEFAULTS.useDescriptionDailyCap, "USE_DESCRIPTION_DAILY_CAP"),
    rawLogKeepDays: keepDays(env.RAW_LOG_KEEP_DAYS),
    securityOffGpt6: flag(env.SECURITY_OFF_GPT6, DEFAULTS.securityOffGpt6, "SECURITY_OFF_GPT6"),
    gpt6PresendGuard: guardMode(env.GPT6_PRESEND_GUARD),
    gpt6GuardTimeoutMs: whole(env.GPT6_GUARD_TIMEOUT_MS, DEFAULTS.gpt6GuardTimeoutMs, "GPT6_GUARD_TIMEOUT_MS"),
    gpt6TrustedWeeklyUsdCap: amount(env.GPT6_TRUSTED_WEEKLY_USD_CAP, DEFAULTS.gpt6TrustedWeeklyUsdCap, "GPT6_TRUSTED_WEEKLY_USD_CAP"),
    gpt6Clients: gpt6Clients(env.GPT6_CLIENTS),
    moderation: moderationMode(env.MODERATION),
    moderationBlockConfidence: share(env.MODERATION_BLOCK_CONFIDENCE, DEFAULTS.moderationBlockConfidence, "MODERATION_BLOCK_CONFIDENCE"),
    moderationAllowlist: moderationAllowlist(env.MODERATION_ALLOWLIST),
    moderationCooldownMinutes: whole(env.MODERATION_COOLDOWN_MINUTES, DEFAULTS.moderationCooldownMinutes, "MODERATION_COOLDOWN_MINUTES"),
    moderationDailyCap: whole(env.MODERATION_DAILY_CAP, DEFAULTS.moderationDailyCap, "MODERATION_DAILY_CAP"),
    allocator: allocatorMode(env.ALLOCATOR),
    allocatorStartTokens: whole(env.ALLOCATOR_START_TOKENS, DEFAULTS.allocatorStartTokens, "ALLOCATOR_START_TOKENS"),
    allocatorTriggerShare: share(env.ALLOCATOR_TRIGGER_SHARE, DEFAULTS.allocatorTriggerShare, "ALLOCATOR_TRIGGER_SHARE"),
    allocatorTimeoutMs: whole(env.ALLOCATOR_TIMEOUT_MS, DEFAULTS.allocatorTimeoutMs, "ALLOCATOR_TIMEOUT_MS"),
    allocatorGraceShare: share(env.ALLOCATOR_GRACE_SHARE, DEFAULTS.allocatorGraceShare, "ALLOCATOR_GRACE_SHARE"),
    detection: detection.rules,
    detectionStatus: detection.status,
  };
}

/** The registry providers' settings from env (REGISTRY_ENV), else their defaults. */
function registrySettings(env: Record<string, unknown>): RegistrySettingsConfig {
  const d = REGISTRY_DEFAULTS;
  const list = (name: string, fallback: readonly string[], valid: (value: readonly unknown[]) => boolean, rule: string): readonly string[] => {
    const raw = text(env[name]);
    if (raw === undefined) return fallback;
    const parts = raw.toLowerCase() === "none" ? [] : raw.split(",").map((part) => part.trim()).filter(Boolean);
    if (!valid(parts)) throw new ConfigError(`${name} must be ${rule} (got "${raw}").`);
    return parts;
  };
  const priceList = (name: string, fallback: readonly number[]): readonly number[] => {
    const raw = text(env[name]);
    if (raw === undefined) return fallback;
    const parts = raw.split(",").map((part) => Number(part.trim()));
    if (!isPriceList(parts)) throw new ConfigError(`${name} must be three prices, input,cached,output USD per million tokens (got "${raw}").`);
    return parts;
  };
  const status = (name: string, fallback: ProviderStatus): ProviderStatus => {
    const raw = text(env[name])?.toLowerCase();
    if (raw === undefined) return fallback;
    if (!(PROVIDER_STATUSES as readonly string[]).includes(raw)) throw new ConfigError(`${name} must be "on" or "paused" (got "${raw}").`);
    return raw as ProviderStatus;
  };
  const plans = (name: string, fallback: ProviderPlans): ProviderPlans => {
    const raw = text(env[name])?.toLowerCase();
    if (raw === undefined) return fallback;
    if (!(PROVIDER_PLANS as readonly string[]).includes(raw)) throw new ConfigError(`${name} must be "pro" or "all" (got "${raw}").`);
    return raw as ProviderPlans;
  };
  const sellers = "a comma-separated list of up to 10 seller handles";
  return {
    "providerStatus.liquid": status("LIQUID_STATUS", d["providerStatus.liquid"]),
    "providerCredit.liquid": amount(env.LIQUID_CREDIT_USD, d["providerCredit.liquid"], "LIQUID_CREDIT_USD"),
    "providerWeeklyCredit.liquid": usd(env.LIQUID_WEEKLY_CREDIT_USD, d["providerWeeklyCredit.liquid"]!, "LIQUID_WEEKLY_CREDIT_USD"),
    "providerPersonWeeklyUsd.liquid": usd(env.LIQUID_PERSON_WEEKLY_USD, d["providerPersonWeeklyUsd.liquid"]!, "LIQUID_PERSON_WEEKLY_USD"),
    "providerOptIn.liquid": flag(env.LIQUID_OPT_IN, d["providerOptIn.liquid"], "LIQUID_OPT_IN"),
    "providerPlans.liquid": plans("LIQUID_PLANS", d["providerPlans.liquid"]),
    "providerModels.liquid": list("LIQUID_MODELS", d["providerModels.liquid"], isRegistryModelList, "a comma-separated list of Liquid model ids"),
    "exchangeAllow.kimi-k3.1-pro": list("LIQUID_ALLOW_KIMI_K3_1_PRO", d["exchangeAllow.kimi-k3.1-pro"], isSellerList, sellers),
    "exchangeMaxPrices.kimi-k3.1-pro": priceList("LIQUID_MAX_PRICES_KIMI_K3_1_PRO", d["exchangeMaxPrices.kimi-k3.1-pro"]),
    "exchangeAllow.glm-5.3": list("LIQUID_ALLOW_GLM_5_3", d["exchangeAllow.glm-5.3"], isSellerList, sellers),
    "exchangeMaxPrices.glm-5.3": priceList("LIQUID_MAX_PRICES_GLM_5_3", d["exchangeMaxPrices.glm-5.3"]),
    "exchangeAllow.glm-5.3-flash": list("LIQUID_ALLOW_GLM_5_3_FLASH", d["exchangeAllow.glm-5.3-flash"], isSellerList, sellers),
    "exchangeMaxPrices.glm-5.3-flash": priceList("LIQUID_MAX_PRICES_GLM_5_3_FLASH", d["exchangeMaxPrices.glm-5.3-flash"]),
    "modelWeeklyCredit.liquid.kimi-k3.1-pro": usd(env.LIQUID_WEEKLY_CREDIT_KIMI_K3_1_PRO, d["modelWeeklyCredit.liquid.kimi-k3.1-pro"]!, "LIQUID_WEEKLY_CREDIT_KIMI_K3_1_PRO"),
    "modelWeeklyCredit.liquid.glm-5.3-flash": usd(env.LIQUID_WEEKLY_CREDIT_GLM_5_3_FLASH, d["modelWeeklyCredit.liquid.glm-5.3-flash"]!, "LIQUID_WEEKLY_CREDIT_GLM_5_3_FLASH"),
    "modelPersonWeeklyUsd.glm-5.3-flash": usd(env.GLM_5_3_FLASH_PERSON_WEEKLY_USD, d["modelPersonWeeklyUsd.glm-5.3-flash"]!, "GLM_5_3_FLASH_PERSON_WEEKLY_USD"),
    "providerStatus.openrelay": status("OPENRELAY_STATUS", d["providerStatus.openrelay"]),
    "providerCredit.openrelay": amount(env.OPENRELAY_CREDIT_USD, d["providerCredit.openrelay"], "OPENRELAY_CREDIT_USD"),
    "providerWeeklyCredit.openrelay": usd(env.OPENRELAY_WEEKLY_CREDIT_USD, d["providerWeeklyCredit.openrelay"]!, "OPENRELAY_WEEKLY_CREDIT_USD"),
    "providerPersonWeeklyUsd.openrelay": usd(env.OPENRELAY_PERSON_WEEKLY_USD, d["providerPersonWeeklyUsd.openrelay"]!, "OPENRELAY_PERSON_WEEKLY_USD"),
    "providerOptIn.openrelay": flag(env.OPENRELAY_OPT_IN, d["providerOptIn.openrelay"], "OPENRELAY_OPT_IN"),
    "providerPlans.openrelay": plans("OPENRELAY_PLANS", d["providerPlans.openrelay"]),
    "providerModels.openrelay": list("OPENRELAY_MODELS", d["providerModels.openrelay"], isRegistryModelList, "a comma-separated list of Open Relay model ids"),
  };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * A secret that may be split into parts: Cloudflare caps one secret at about 5 KB, so a longer
 * value is stored as NAME, NAME_2, NAME_3, ... and joined here in order (up to NAME_9). NAME
 * alone, unsplit, still works.
 */
export function joinedSecret(env: Record<string, unknown>, name: string): string | undefined {
  const first = env[name];
  if (typeof first !== "string") return first === undefined ? undefined : String(first);
  let joined = first;
  for (let part = 2; part <= 9; part++) {
    const next = env[`${name}_${part}`];
    if (typeof next !== "string") break;
    joined += next;
  }
  return joined;
}

function required(env: Record<string, unknown>, name: string): string {
  const value = text(env[name]);
  if (!value) throw new ConfigError(`${name} is required.`);
  return value;
}

/**
 * The fewest and most days of raw log RAW_LOG_KEEP_DAYS may keep (0 keeps everything): the longest
 * window read from the raw log is 30 days (the Health view, the allocator's history), plus a day.
 */
export const RAW_LOG_MIN_KEEP_DAYS = 31;
export const RAW_LOG_MAX_KEEP_DAYS = 3650;

/** 0 (keep everything) or RAW_LOG_MIN_KEEP_DAYS to RAW_LOG_MAX_KEEP_DAYS. */
export function isKeepDays(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && (value === 0 || (value >= RAW_LOG_MIN_KEEP_DAYS && value <= RAW_LOG_MAX_KEEP_DAYS));
}

function keepDays(value: unknown): number {
  const days = whole(value, DEFAULTS.rawLogKeepDays, "RAW_LOG_KEEP_DAYS");
  if (!isKeepDays(days)) throw new ConfigError(`RAW_LOG_KEEP_DAYS must be 0 (keep everything) or ${RAW_LOG_MIN_KEEP_DAYS} to ${RAW_LOG_MAX_KEEP_DAYS} (got "${days}").`);
  return days;
}

function whole(value: unknown, fallback: number, name: string): number {
  const raw = text(value);
  if (raw === undefined) return fallback;
  const parsed = Number(raw.replace(/_/g, ""));
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new ConfigError(`${name} must be a whole number (got "${raw}").`);
  return parsed;
}

/**
 * A moment as Unix ms, from an ISO time ("2026-11-20T00:00:00Z") or Unix ms. Undefined when unset
 * or "none"/"off".
 */
export function parseInstant(value: unknown): number | undefined | "invalid" {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : "invalid";
  if (typeof value !== "string") return "invalid";
  const raw = value.trim();
  if (raw === "" || ["none", "off"].includes(raw.toLowerCase())) return undefined;
  if (/^\d+$/.test(raw)) {
    const ms = Number(raw);
    return Number.isSafeInteger(ms) && ms > 0 ? ms : "invalid";
  }
  // A date and a time with its zone, so nobody gets a cutoff in the server's local time.
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/.test(raw)) return "invalid";
  const ms = Date.parse(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : "invalid";
}

function instant(value: unknown, name: string): number | undefined {
  const parsed = parseInstant(text(value));
  if (parsed === "invalid") throw new ConfigError(`${name} must be an ISO time like 2026-11-20T00:00:00Z, Unix ms, or "none" (got "${String(value)}").`);
  return parsed;
}

/** A share from 0 to 1. */
function share(value: unknown, fallback: number, name: string): number {
  const raw = text(value);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new ConfigError(`${name} must be a number from 0 to 1 (got "${raw}").`);
  return parsed;
}

/** A number of dollars, always set. */
function amount(value: unknown, fallback: number, name: string): number {
  const raw = text(value);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) throw new ConfigError(`${name} must be a number of dollars (got "${raw}").`);
  return parsed;
}

/** A price in dollars and cents ("3.99", "10"): never more than two decimals, so it shows exactly. */
function price(value: unknown, fallback: number, name: string): number {
  const raw = text(value);
  if (raw === undefined) return fallback;
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) throw new ConfigError(`${name} must be dollars and cents, e.g. "3.99" (got "${raw}").`);
  return Number(raw);
}

/** TOPUP_MIN_QUANTITY and TOPUP_MAX_QUANTITY: 1 to 100 units, the minimum no more than the maximum. */
function quantities(env: Record<string, unknown>): { minQuantity: number; maxQuantity: number } {
  const minQuantity = whole(env.TOPUP_MIN_QUANTITY, DEFAULTS.topupMinQuantity, "TOPUP_MIN_QUANTITY");
  const maxQuantity = whole(env.TOPUP_MAX_QUANTITY, DEFAULTS.topupMaxQuantity, "TOPUP_MAX_QUANTITY");
  if (minQuantity < 1 || maxQuantity > 100 || minQuantity > maxQuantity) {
    throw new ConfigError(`TOPUP_MIN_QUANTITY and TOPUP_MAX_QUANTITY must be 1 to 100 with the minimum no more than the maximum (got ${minQuantity} and ${maxQuantity}).`);
  }
  return { minQuantity, maxQuantity };
}

/** TOPUP_USAGE_MULTIPLIER: usage dollars per dollar paid, 0.5 to 5. */
function multiplier(value: unknown): number {
  const raw = text(value);
  if (raw === undefined) return DEFAULTS.topupUsageMultiplier;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0.5 || parsed > 5) throw new ConfigError(`TOPUP_USAGE_MULTIPLIER must be a number from 0.5 to 5 (got "${raw}").`);
  return parsed;
}

/** PRO_OPEN_MODELS_MULTIPLIER: a number from 1 to 100 (default 4). */
function proMultiplier(value: unknown): number {
  const raw = text(value);
  if (raw === undefined) return DEFAULTS.proOpenModelsMultiplier;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < PRO_MULTIPLIER_MIN || parsed > PRO_MULTIPLIER_MAX) {
    throw new ConfigError(`PRO_OPEN_MODELS_MULTIPLIER must be a number from ${PRO_MULTIPLIER_MIN} to ${PRO_MULTIPLIER_MAX} (got "${raw}").`);
  }
  return parsed;
}

export const PRO_MULTIPLIER_MIN = 1;
export const PRO_MULTIPLIER_MAX = 100;

/** PRO_VALUE_LINE: one short sentence, at most 80 characters. */
function valueLine(value: unknown): string {
  const raw = text(value);
  if (raw === undefined) return DEFAULTS.proValueLine;
  if (raw.length > 80 || /[\r\n]/.test(raw)) throw new ConfigError(`PRO_VALUE_LINE must be one line of at most 80 characters (got "${raw}").`);
  return raw;
}

function stripeId(value: unknown, prefix: string, name: string): string | undefined {
  const raw = text(value);
  if (raw === undefined) return undefined;
  if (!raw.startsWith(prefix) || !/^[A-Za-z0-9_]+$/.test(raw)) throw new ConfigError(`${name} must be a Stripe id starting with ${prefix} (got "${raw}").`);
  return raw;
}

/** WEB_SIGNUP_URL: an https URL with a path and nothing after it (no query, no fragment). */
function webSignupUrl(value: unknown): string {
  const raw = httpsUrl(value, "WEB_SIGNUP_URL");
  if (raw === undefined) return DEFAULT_WEB_SIGNUP_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("WEB_SIGNUP_URL must be an https URL.");
  }
  if (url.search || url.hash || url.username || url.password || url.href !== raw) throw new ConfigError("WEB_SIGNUP_URL must be a plain https URL like https://dl.new/start.");
  return raw;
}

function httpsUrl(value: unknown, name: string): string | undefined {
  const raw = text(value);
  if (raw === undefined) return undefined;
  if (!/^https:\/\/\S+$/.test(raw)) throw new ConfigError(`${name} must be an https URL.`);
  return raw;
}

function webhookUrl(value: unknown): string | undefined {
  const raw = text(value);
  if (raw === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("ALERT_WEBHOOK_URL must be an https URL.");
  }
  if (url.protocol !== "https:") throw new ConfigError("ALERT_WEBHOOK_URL must be an https URL.");
  return raw;
}

function emailAddress(value: unknown, name: string): string | undefined {
  const raw = text(value);
  if (raw === undefined) return undefined;
  if (!/^[^\s@<>"(),;:]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(raw)) throw new ConfigError(`${name} must be one email address (got "${raw}").`);
  return raw;
}

/** "name <address>" or a bare address, one line. */
function sender(value: unknown): string | undefined {
  const raw = text(value);
  if (raw === undefined) return undefined;
  if (!/^([^<>\r\n"]*<[^\s@<>"(),;:]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}>|[^\s@<>"(),;:]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})$/.test(raw)) {
    throw new ConfigError(`EMAIL_FROM must be "name <address>" or one email address (got "${raw}").`);
  }
  return raw;
}

function alertKind(value: unknown): AlertKind {
  const raw = text(value)?.toLowerCase();
  if (raw === undefined) return "auto";
  if (raw === "auto" || raw === "discord" || raw === "slack" || raw === "telegram") return raw;
  throw new ConfigError(`ALERT_WEBHOOK_KIND must be auto, discord, slack or telegram (got "${raw}").`);
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

/** Unset or empty (or "none") means no pinned host. */
function providerOrder(value: unknown): readonly string[] {
  const slugs = splitList(value) ?? DEFAULTS.openRouterProviderOrder;
  if (!isProviderSlugList(slugs)) throw new ConfigError(`OPENROUTER_PROVIDER_ORDER must be up to 10 comma-separated provider slugs, e.g. "deepinfra,novita" (got "${String(value)}").`);
  return slugs;
}

/** Unset means native precision and wider; empty (or "none") means no precision filter. */
function quantizations(value: unknown): readonly Quantization[] {
  const levels = splitList(value) ?? DEFAULTS.openRouterQuantizations;
  if (!isQuantizationList(levels)) throw new ConfigError(`OPENROUTER_QUANTIZATIONS must be comma-separated OpenRouter quantization levels, e.g. "fp8,bf16" (got "${String(value)}").`);
  return levels;
}

function dataCollection(value: unknown): DataCollection {
  const raw = text(value)?.toLowerCase();
  if (raw === undefined) return DEFAULTS.openRouterDataCollection;
  if (raw === "allow" || raw === "deny") return raw;
  throw new ConfigError(`OPENROUTER_DATA_COLLECTION must be "deny" or "allow" (got "${raw}").`);
}

function hostCooldown(value: unknown): number {
  const minutes = whole(value, DEFAULTS.openRouterHostCooldownMinutes, "OPENROUTER_HOST_COOLDOWN_MINUTES");
  if (minutes > MAX_HOST_COOLDOWN_MINUTES) throw new ConfigError(`OPENROUTER_HOST_COOLDOWN_MINUTES must be 0 to ${MAX_HOST_COOLDOWN_MINUTES} (got "${minutes}").`);
  return minutes;
}

function alertMode(value: unknown, fallback: AccessRequestAlerts, name: string): AccessRequestAlerts {
  const raw = text(value)?.toLowerCase();
  if (raw === undefined) return fallback;
  if ((ACCESS_REQUEST_ALERT_MODES as readonly string[]).includes(raw)) return raw as AccessRequestAlerts;
  throw new ConfigError(`${name} must be "each", "daily" or "off" (got "${raw}").`);
}

function guardMode(value: unknown): GuardMode {
  const raw = text(value)?.toLowerCase();
  if (raw === undefined) return DEFAULTS.gpt6PresendGuard;
  if ((GUARD_MODES as readonly string[]).includes(raw)) return raw as GuardMode;
  throw new ConfigError(`GPT6_PRESEND_GUARD must be "off" or "enforce" (got "${raw}").`);
}

function gpt6Clients(value: unknown): Gpt6Clients {
  const raw = text(value)?.toLowerCase();
  if (raw === undefined) return DEFAULTS.gpt6Clients;
  if ((GPT6_CLIENTS as readonly string[]).includes(raw)) return raw as Gpt6Clients;
  throw new ConfigError(`GPT6_CLIENTS must be "autopilot" or "all" (got "${raw}").`);
}

function accessRequestAlerts(value: unknown): AccessRequestAlerts {
  const raw = text(value)?.toLowerCase();
  if (raw === undefined) return DEFAULTS.accessRequestAlerts;
  if ((ACCESS_REQUEST_ALERT_MODES as readonly string[]).includes(raw)) return raw as AccessRequestAlerts;
  throw new ConfigError(`ACCESS_REQUEST_ALERTS must be "each", "daily" or "off" (got "${raw}").`);
}

function moderationMode(value: unknown): ModerationMode {
  const raw = text(value)?.toLowerCase();
  if (raw === undefined) return DEFAULTS.moderation;
  if ((MODERATION_MODES as readonly string[]).includes(raw)) return raw as ModerationMode;
  throw new ConfigError(`MODERATION must be "off", "shadow" or "enforce" (got "${raw}").`);
}

function allocatorMode(value: unknown): AllocatorMode {
  const raw = text(value)?.toLowerCase();
  if (raw === undefined) return DEFAULTS.allocator;
  if ((ALLOCATOR_MODES as readonly string[]).includes(raw)) return raw as AllocatorMode;
  throw new ConfigError(`ALLOCATOR must be "on" or "off" (got "${raw}").`);
}

function moderationAllowlist(value: unknown): readonly string[] {
  const entries = (text(value) ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  for (const entry of entries) if (!isAllowlistEntry(entry)) throw new ConfigError(`MODERATION_ALLOWLIST must be comma-separated GitHub logins or ids (got "${entry}").`);
  return entries.map((entry) => entry.toLowerCase());
}

function upstream(value: unknown): PrimaryUpstream {
  const raw = text(value)?.toLowerCase();
  if (raw === undefined) return DEFAULTS.primaryUpstream;
  if ((UPSTREAMS as readonly string[]).includes(raw)) return raw as PrimaryUpstream;
  throw new ConfigError(`PRIMARY_UPSTREAM must be "openai", "luminal" or "openrouter" (got "${raw}").`);
}

function timeoutSeconds(value: unknown, fallback: number, name: string): number {
  const raw = text(value);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_FIRST_BYTE_TIMEOUT_SECONDS) {
    throw new ConfigError(`${name} must be more than 0 and at most ${MAX_FIRST_BYTE_TIMEOUT_SECONDS} (got "${raw}").`);
  }
  return parsed;
}

/** `<prefix>_INPUT`, `<prefix>_CACHED` and `<prefix>_OUTPUT`, in USD per million tokens. */
function prices(env: Record<string, unknown>, prefix: string, fallback: Prices): Prices {
  return {
    input: amount(env[`${prefix}_INPUT`], fallback.input, `${prefix}_INPUT`),
    cached: amount(env[`${prefix}_CACHED`], fallback.cached, `${prefix}_CACHED`),
    output: amount(env[`${prefix}_OUTPUT`], fallback.output, `${prefix}_OUTPUT`),
  };
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
