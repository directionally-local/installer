import type { DurableObjectNamespace } from "cloudflare:workers";
import { isProxyRouter, PROXY_ROUTER_MESSAGE } from "./abuse.js";
import { randomToken, sha256Hex, timingSafeEqual } from "../../shared/src/auth.js";
import { githubAuthorizeUrl, githubPrimaryEmail, githubPublicProfile, githubSignInFromCode, githubUserByLogin, githubUserFromCode, type Fetch, type GitHubAppCredentials } from "../../shared/src/github.js";
import { githubSignals } from "../../shared/src/github-signals.js";
import { hmacKey, signJwt, verifyJwt } from "../../shared/src/jwt.js";
import type { Limit } from "../../shared/src/rate-limit.js";
import { HARNESSES, HARNESS_KEY_TTL_MS, MAX_HARNESS_KEYS, MAX_SERVER_KEYS, parseHarnessKey, parseServerKey, type AccountObject, type Harness, type KeyKind, type Allowance, type Limits, type Plan, type ServerKeyView } from "./account-object.js";
import { TOOL_KEYS_OFF_MESSAGE, TOOL_KEYS_UNAVAILABLE_MESSAGE, TOOL_KEY_NOT_HERE_MESSAGE, forTool, toolClient, toolLimitMessage, toolName } from "./tool-keys.js";
import type { AuthObject, Identity } from "./auth-object.js";
import { normalizeUserCode } from "./codes.js";
import { accountObjectName, API_KEY_PREFIX, parseApiKey } from "./accounts.js";
import { sendOwnerPaymentAlert } from "./owner-payment-alerts.js";
import { applyPlanEvent, githubCallback, githubStart, googleCallback, googleStart, paidAdmin, paidV1, paidWebRoute } from "./paid-web.js";
import { GOOGLE_CALLBACK_PATH } from "./google.js";
import type { KeyFormat } from "./account-object.js";
import { ConfigError, readFreeConfig, type FreeConfig, type Upstream } from "./config.js";
import type { DirectoryObject, Gate, GithubCheckOutcome, HostFailure, LevelSignalRow, PersonRow, PersonState, PersonStatus, RequestRecord, SpendSummary, UseClient } from "./directory-object.js";
import type { ProFunnelStep } from "./pro-funnel.js";
import { createCheckout, createPortal, githubIdFrom, isMissingCustomer, idOf, invoicePeriodEnd, invoiceSubscription, periodEnd, proState, StripeError, verifyWebhook, type Product, type StripeEvent } from "./stripe.js";
import { accessRequestAlert, deliverAlerts, isHeaderSafeAddress, pauseAlert, sendEmail, type Alert, type EmailBinding, type ServingContext, type UpstreamOutcome } from "./alerts.js";
import { policyOf, waitText } from "./queue.js";
import { normalizeReferralCode, referralLink } from "./referrals.js";
import { networkOf, rateLimitNetwork } from "./network.js";
import { feedbackEmail, MAX_FEEDBACK_BYTES, parseFeedback, publicGithubEmail, type Sender } from "./feedback.js";
import { apiError, json } from "./errors.js";
import { adminHomePage } from "./admin-home-page.js";
import { dashboardCsv, deniedPage, earlyAccessCsv, healthCsv, isCsvTable, isHealthCsvTable, noGithubCsv, signedInPage, signInPage, toolsPage, type SpendView, type ToolsState } from "./dashboard-page.js";
import { PROVIDER_INQUIRY_MAX_BYTES, parseProviderInquiry, providerInquiriesJson, providerInquiryEmail } from "./provider-inquiry.js";
import { NO_GITHUB_PATH, noGithubBody, noGithubClickAlert, noGithubJson, noGithubLeadAlert, noGithubSource, parseNoGithubLead } from "./no-github.js";
import { ACCESS_REQUEST_MAX_BYTES, ACCESS_REQUEST_USAGE, ACCESS_REQUESTS_PER_DAY, parseAccessRequest } from "./access-request.js";
import { cleanBatch, cleanGpuTelemetry, earlyAccessEmail, type GpuCount } from "./events.js";
import { cleanDownload, cleanInstall, MAX_TELEMETRY_BYTES } from "./telemetry.js";
import {
  BLOCKED_MESSAGE,
  DEVICE_TAKEN_MESSAGE,
  DL_ONLY_MESSAGE,
  harnessKeyExpiredMessage,
  harnessNotAllowedMessage,
  harnessLimitMessage,
  HARNESS_WORDS,
  forHarness,
  SERVER_KEYS_UNAVAILABLE_MESSAGE,
  INVALID_INVITE_MESSAGE,
  isSignInRefusal,
  CREDIT_EXHAUSTED_MESSAGE,
  PAUSED_MESSAGE,
  QUEUED_SIGNED_IN,
  UPSTREAM_BUSY_MESSAGE,
  UPSTREAM_TIMEOUT_MESSAGE,
  UPSTREAM_UNAVAILABLE_MESSAGE,
  queuedMessage,
  gptLimitMessage,
  freeLimitName,
  proPromptMessage,
  proPromptText,
  quotaMessage,
  signInRefusal,
  trialEndedMessage,
  TOTAL_BUDGET_MESSAGE,
  weeklyBudgetMessage,
  type SignInRefusal,
} from "./messages.js";
import { confirmPage, detailsPage, donePage, emailStopPage, enterCodePage, INVITE_ONLY_INTRO, invitePage, NO_GITHUB_ACTIVITY_INTRO, shell, signedInDonePage, tooNewIntro } from "./pages.js";
import { chargedTokens, costAtPrices, costOf, estimatePromptTokens, isAllowedModel, MIN_OUTPUT_TOKENS, parseUsage, streamedOutputTokens, type Usage } from "./quota.js";
import { ALLOWED_MODELS, DEEPSEEK_MODEL, DEFAULT_MODEL, FAMILIES, FREE_MODELS, POOLS, creditPrices, fallbackOf, familyOfPool, modelById, onUpstream, type Family, type FreeModel, type Pool } from "./models.js";
import { emailBlocked, emailDomain, normalizeEmail, plausibleEmail, PUBLIC_EMAIL_DOMAINS } from "./email-guard.js";
import { normalizeEventCode, parseEventCodeInput, type EventCodeRow } from "./event-codes.js";
import {
  ACCESS_REQUEST_PATH,
  basicLine,
  batchCounter,
  belowBarLine,
  CREDITS_REQUEST_EMAIL,
  dayOf,
  isSignupLimitReason,
  levelChecks,
  levelFor,
  levelReason,
  limitLine,
  qualifiesForBasic,
  starterLine,
  type BasicRule,
  type GithubSignals,
  type Level,
  type LevelChecks,
  type LevelReason,
  type LevelThresholds,
  type SignalThresholds,
} from "./admission.js";
import type { RateLimiterObject } from "./rate-limit-object.js";
import { chooseUpstream, providerConfigured } from "./upstream-choice.js";
import { upstreamRefusal } from "./upstream-errors.js";
import { freeStatus, type FreeStatus } from "./status.js";
import { HOSTS_OBJECT, hostOf, isNoHostError, providerPreferences } from "./routing.js";
import { applyOverrides, parseSettingsUpdate, settingsView } from "./runtime-config.js";
import { AUTOPILOT_ONLY_MESSAGE, AUTOPILOT_ONLY_REASON, heldFromClient, modelClients, type ModelClient } from "./gpt6-clients.js";
import { meterStream, outputChars } from "./sse.js";
import type { RegistryProviderId, RegistryRoute } from "./providers.js";
import { accessOf, approxTokens, configuredUpstreams, offeredModels, exchangeUsage, mergedUsage, exchangeRules, FALLBACK_BLOCKS, isRegistryProvider, formatRationTokens, listedUpstream, liquidPayload, modelPlans, openRelayPayload, personCapUsd, personSpendKey, proOnly, providerFallbackNotice, providerKey, providerLimitMessage, providerModels, providerSettings, providerSpec, PROVIDERS, rationOf, registryBlock, registryRoute, reportedCharge, resetDay, upstreamBlock, type ProviderBlock, type ProviderSpend } from "./providers.js";
import { PROBE_CRON, probeOnce, probeTargets } from "./probes.js";
import { measureKey } from "./provider-store.js";
import { isResponse, toChatCompletion, toChatStream, toResponsesRequest } from "./openai-responses.js";
import { anthropicError, errorStatus, estimateInputTokens, toAnthropicMessage, toAnthropicStream, toChatRequest } from "./anthropic.js";
import { DAY_MS, isoDay, weekEnd, weekStart, WEEK_MS } from "./week.js";
import { planResetValues } from "./plan-reset.js";
import { FREE_ENDED_CODE, FREE_ENDED_MESSAGE, PLAN_MIX_LABEL, freeEnded, freeEndedFor, limitRefusal, meterFor, realFromCounted, warningEmailValues, withNotices } from "./plan-limits.js";
import { convertTrial, sendTrial80 } from "./trial-web.js";
import { capacityFull, freeCapacityFullMessage, FREE_PLAN_URL, FREE_PLAN_WARN_SHARE, freePlanCountedLimit, freePlanEmailValues, freePlanLimitMessage, freePlanOn, freePlanWarning, notOnFreeNotice, starterLine as freeStarterLine } from "./free-plan.js";
import { noCardUsedUpMessage, notInTrialNotice, trialsOffer, startsWithPlanNotice, TRIAL_CONVERTING_MESSAGE, TRIAL_PAYMENT_FAILED_MESSAGE, TRIAL_WARN_SHARE, trialWarningNotice, type TrialMeter } from "./trials.js";
import { displayName as planDisplayName, isPaidPlan, planLimitFor, planName as planTitle } from "./plans.js";
import { PLAN_METER_MODELS, afterMeterFull, anthropicModelFor, bonusProjection, dueWarning, planRoute, tokenMeter, type PlanServe } from "./plan-route.js";
import { bonusAccountView, mixView, planCatalog, planLimitsView, planUsageView } from "./plan-usage.js";
import { isPlanId, PLANS, promoPrice, promoView } from "./plan-prices.js";
import { BONUS_MODEL, bonusBlock } from "./gpt6-bonus.js";
import type { PlanState } from "./account-object.js";
import { allocateIfDue, allocatedLimits, anthropicSessionHint, limitedLevel, rescue, sessionKeyOf, stageOf, stepOf, usedShare, type AllocatorRun } from "./allocator.js";
import { healthWindow } from "./health-data.js";
import {
  deliverUserEmail,
  EMAIL_STOP_BASE,
  logUserEmails,
  sendPlainEmail,
  stopUrl,
  userEmailsOn,
  userEmailRoute,
  userEmailRoutes,
  userEmailTransport,
  type UserEmailRoutes,
  verifyStopToken,
  trialMostlyUsed,
  weekMostlyUsed,
  WEEKLY_RESET_FIRST_WEEK,
  weeklyResetTokens,
  weeklyResetWindow,
  type UserEmailBinding,
  type UserEmailStore,
  type UserEmailTransport,
  type WeeklyResetSkip,
} from "./user-email-send.js";
import { renderUserEmail, resetsText, USER_EMAILS, type PlanWarningValues, type PlanWelcomeValues, type TrialEmailValues, type UserEmailKind, type WeeklyResetValues } from "./user-emails.js";
import { emailBudgetOf } from "./email-budget.js";
import { BROADCAST_BATCH, broadcastBody, broadcastId, hasCapitals, onlyListed, parseBroadcast, parseCopy, type BroadcastRequest } from "./broadcast.js";
import { refusalsCsv, refusalsView, requestClient, requestRefusalReason, type RefusalClient, type RefusalReason } from "./refusals.js";
import { allowedReturn, CAMPAIGN_CLIENT_STEPS, campaignFromParams, campaignTotals, isInstallOption, ONE_TIME_CODE, parseCampaign, planFor, WEB_SESSION_TTL_S, WEB_STATE, webCors, webFunnelCsv, type Campaign, type CampaignStep, type WebStep } from "./web-signup.js";
import { grantUsdText, MAX_GRANT_LOGINS, MAX_GRANT_USD, parseGrantUsd, parseLogins, type GrantResult } from "./grant.js";
import { completionText, isUseRisk, parseUseLabel, USE_DESCRIPTIONS_PER_PERSON_PER_DAY, USE_KEEP_DAYS, USE_MAX_TOKENS, USE_REASONING_ROOM, USE_TIMEOUT_SECONDS, useInput, useMessages, type UseInput } from "./use-description.js";
import { fitToBudget, keywordLabel, precheckTexts, SECURITY_GPT6_MESSAGE, SECURITY_REASON, securityHoldEnds, securitySignal } from "./security-route.js";
import { GUARD_GPT6_MESSAGE, outcomesOf, runGuard } from "./presend-guard.js";
import { TRUST_REASON, UNTRUSTED_GPT6_MESSAGE, type Trust } from "./gpt6-trust.js";
import {
  allowlisted,
  MODERATION_INPUT_CHARS,
  MODERATION_MAX_TOKENS,
  MODERATION_REASONING_ROOM,
  MODERATION_RETRY_ROOM,
  MODERATION_TIMEOUT_SECONDS,
  MODERATION_VERDICTS,
  moderationAction,
  moderationMessages,
  parseModeration,
  REVIEW_FAILED,
  type ModerationAction,
  type ModerationFailure,
  type ModerationVerdict,
  type TriggerLabel,
} from "./moderation.js";
import type { ModerationLimits } from "./directory-object.js";

/**
 * The free managed tier's HTTP surface: device-flow sign-in with GitHub, the account and
 * OpenAI-compatible inference endpoints, usage events, and the admin API. Inference goes to
 * one upstream, `primaryUpstream`: Luminal (the default, on prepaid credit) or OpenRouter, both
 * on the service's keys. There is no automatic switch between them (see `chat`).
 *
 * Sign-out: `POST /v1/token/revoke` with the access token as the bearer and/or
 * `{refresh_token}` ends that sign-in session: its refresh tokens are deleted and its access
 * tokens stop working at once. Admins: `POST /admin/people/:id/revoke-tokens` ends every
 * session and deletes every server key of one person.
 *
 * Server keys, for machines that run unattended (an access token lives an hour, and a server
 * shouldn't hold a refresh token chain). All three need a signed-in access token:
 *
 *   POST   /v1/keys {name}  → 201 {id, name, key, createdAt, lastUsedAt: null}; `key` is shown only here
 *   GET    /v1/keys         → {keys: [{id, name, createdAt, lastUsedAt}], max}
 *   DELETE /v1/keys/:id     → {id, revoked: true}, or 404 key_not_found
 *
 * A key (`dlk_<githubId>_<id>_<secret>`) works as the bearer on /v1/chat/completions,
 * /v1/models, /v1/me and /v1/events and charges the same account as its owner's sign-in.
 * Only the secret's SHA-256 is stored. At most 5 keys per account (409 key_limit_reached);
 * names are unique per account (409 key_name_taken). A bad or revoked key is 401 invalid_key.
 *
 * Tool keys (tool-keys.ts): `POST /v1/keys {name, kind: "tool"}` makes the same kind of key for
 * any OpenAI- or Anthropic-compatible tool, for any account in good standing (no grant needed),
 * at most `toolKeysMax` of them. It works on /v1/chat/completions, /v1/models, /v1/me and
 * /anthropic/v1/messages (not /v1/events), is served like another coding agent, and is never
 * refused as dl_only. GET /v1/keys lists both kinds, each with its `kind`.
 */

export const VERSION = "0.1.0";
export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const LUMINAL_URL = "https://flash.luminal.cloud/v1/chat/completions";
/** Liquid Inference's chat completions (providers.ts). */
export const LIQUID_URL = `${providerSpec("liquid").baseUrl}/chat/completions`;
/** Open Relay's chat completions (providers.ts). */
export const OPENRELAY_URL = `${providerSpec("openrelay").baseUrl}/chat/completions`;
/** OpenAI's Responses API: its chat completions API refuses function tools while GPT-6 reasons. */
export const OPENAI_URL = "https://api.openai.com/v1/responses";
/** OpenRouter-only request fields Luminal's OpenAI-compatible API doesn't take. */
const OPENROUTER_ONLY_FIELDS = ["provider", "usage", "models", "route", "transforms", "plugins", "session_id", "reasoning", "max_tokens"] as const;
/** Retry-After for a transient Luminal error that didn't say, in seconds. */
const DEFAULT_RETRY_AFTER_S = 5;
export const ACCESS_TTL_S = 3600;
/** How long a revoked session id is remembered: past any access token from it (TTL plus verify leeway). */
const REVOKED_SESSION_TTL_MS = (ACCESS_TTL_S + 120) * 1000;
export const ISSUER = "directionallylocal-free";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const OAUTH_COOKIE = "__Host-dl_oauth";
/** The admin dashboard's browser session (see `adminWeb`). */
const ADMIN_COOKIE = "__Host-dl_admin";
/** Binds an admin GitHub round trip to the browser that started it. */
const ADMIN_OAUTH_COOKIE = "__Host-dl_admin_oauth";
const ADMIN_SESSION_TTL_S = 3600;
/**
 * The OAuth app's one registered callback. GitHub matches redirect URIs exactly, so admin
 * sign-in comes back here too; the stored state's purpose says which flow to finish.
 */
export const CALLBACK_PATH = "/device/callback";
/**
 * Where admin sign-in used to come back to. Kept as an alias for a while: harmless if it was
 * added to the OAuth app, and it finishes any sign-in started before the change.
 */
const LEGACY_ADMIN_CALLBACK_PATH = "/device/callback/admin";

const perMinute = (n: number): Limit => ({ capacity: n, perHour: n * 60 });
// Per-network limits (an IPv4 address or an IPv6 /64) are generous: an office, a classroom or
// a meetup shares one address, and requests are already limited per signed-in person. Sign-ups
// and invite attempts stay tight.
const LIMITS = {
  apiPerson: perMinute(60),
  apiIp: perMinute(600),
  deviceCodeIp: { capacity: 60, perHour: 60 },
  adminSignInIp: { capacity: 10, perHour: 10 },
  // Device-code polling, every 5 s per sign-in in progress: raised with deviceCodeIp.
  pollIp: perMinute(720),
  refreshIp: { capacity: 600, perHour: 600 },
  inviteAttemptIp: { capacity: 10, perHour: 10 },
  signupIp: { capacity: 3, perHour: 3 / 24 },
  referralLookupIp: perMinute(60),
  statusIp: perMinute(120),
  // Download counts come from the dl.new and directionallylocal.run Workers, which share a few
  // Cloudflare addresses, so this one is generous; install counts come from people's machines.
  telemetryDownloadIp: perMinute(600),
  telemetryInstallIp: { capacity: 20, perHour: 20 },
  // A GPU first run sends a handful of counts (detected, prompt, option, result) per machine.
  telemetryGpuIp: { capacity: 60, perHour: 60 },
  // Feedback is an email to the owner: a few at a time is plenty.
  feedbackPersonHour: { capacity: 5, perHour: 5 },
  feedbackPersonDay: { capacity: 20, perHour: 20 / 24 },
  feedbackIp: { capacity: 10, perHour: 10 },
  // dl.new's web sign-up (web-signup.ts). Handoff and install codes are 256 and 160 random bits,
  // so these limits only keep the endpoints cheap; an office can still sign several people up.
  webSessionIp: { capacity: 30, perHour: 30 },
  installCodePerson: { capacity: 10, perHour: 10 },
  installExchangeIp: { capacity: 20, perHour: 20 },
  telemetryWebIp: perMinute(600),
  // "Don't have GitHub?" (no-github.ts): each counted click and answer emails the owner.
  noGithubClickIp: { capacity: 20, perHour: 20 },
  noGithubLeadIp: { capacity: 5, perHour: 5 },
  // dl.new/providers' form (provider-inquiry.ts): each kept inquiry can email the owner.
  providerInquiryIp: { capacity: 5, perHour: 5 },
} satisfies Record<string, Limit>;

export interface Env {
  OPENROUTER_API_KEY?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  TOKEN_SIGNING_KEY?: string;
  ADMIN_GITHUB_IDS?: string;
  WEEKLY_TOKENS?: string;
  MAX_ACTIVE_USERS?: string;
  GLOBAL_WEEKLY_USD_CAP?: string;
  GLOBAL_TOTAL_USD_CAP?: string;
  PER_PERSON_WEEKLY_USD_CAP?: string;
  MIN_GITHUB_ACCOUNT_AGE_DAYS?: string;
  OPEN_ADMISSION?: string;
  REQUIRE_GITHUB_ACTIVITY?: string;
  COUNT_CACHED_TOKENS?: string;
  CACHED_TOKEN_WEIGHT?: string;
  OPENROUTER_PROVIDER_ORDER?: string;
  OPENROUTER_QUANTIZATIONS?: string;
  OPENROUTER_DATA_COLLECTION?: string;
  OPENROUTER_HOST_COOLDOWN_MINUTES?: string;
  PAUSED?: string;
  PUBLIC_URL?: string;
  QUEUE_THRESHOLD?: string;
  QUEUE_REFERRAL_PLACES?: string;
  REFERRAL_BONUS_TOKENS?: string;
  REFERRAL_BONUS_CAP?: string;
  REFERRAL_LINK_BASE?: string;
  PRO_PRICE_USD_MONTHLY?: string;
  PRO_TOKENS_PER_WEEK?: string;
  PRO_VALUE_LINE?: string;
  TOPUP_UNIT_PRICE_USD?: string;
  TOPUP_MIN_QUANTITY?: string;
  TOPUP_MAX_QUANTITY?: string;
  TOPUP_USAGE_MULTIPLIER?: string;
  TOPUP_VALID_DAYS?: string;
  /** Tokens a checkout started under the old token top-up still grants (default 50M). */
  TOPUP_TOKENS?: string;
  ALERT_WEBHOOK_URL?: string;
  ALERT_WEBHOOK_KIND?: string;
  ALERT_TELEGRAM_CHAT_ID?: string;
  ALERT_EMAIL_TO?: string;
  ALERT_EMAIL_FROM?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_TOPUP?: string;
  /** dl.new's plans' monthly Prices (plan-prices.ts), made in Stripe by the owner. */
  STRIPE_PRICE_STARTER?: string;
  STRIPE_PRICE_PLUS?: string;
  STRIPE_PRICE_MAX?: string;
  BILLING_SUCCESS_URL?: string;
  BILLING_CANCEL_URL?: string;
  BILLING_PORTAL_RETURN_URL?: string;
  PRO_OPEN_MODELS_MULTIPLIER?: string;
  PRIMARY_UPSTREAM?: string;
  /** A secret. Without it, OpenRouter serves every request. Never logged. */
  LUMINAL_API_KEY?: string;
  /** A secret. The default provider. Never logged. */
  OPENAI_API_KEY?: string;
  OPENAI_CREDIT_USD?: string;
  OPENAI_FIRST_BYTE_TIMEOUT_SECONDS?: string;
  LUMINAL_FIRST_BYTE_TIMEOUT_SECONDS?: string;
  LUMINAL_PRICE_INPUT?: string;
  LUMINAL_PRICE_CACHED?: string;
  LUMINAL_PRICE_OUTPUT?: string;
  OPENROUTER_PRICE_INPUT?: string;
  OPENROUTER_PRICE_CACHED?: string;
  OPENROUTER_PRICE_OUTPUT?: string;
  LUMINAL_CREDIT_USD?: string;
  LUMINAL_WEEKLY_CREDIT_USD?: string;
  /** A secret: Liquid Inference's API key. Never logged. Its settings are LIQUID_* (config.ts registrySettings). */
  LIQUID_INFERENCE_API_KEY?: string;
  /** A secret: Open Relay's API key (`or_…`). Never logged. Its settings are OPENRELAY_* (config.ts registrySettings). */
  OPENRELAY_API_KEY?: string;
  SPEED_PROBES?: string;
  /** A secret: Resend's API key for emails to users, when USER_EMAIL isn't bound. Never logged. */
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_REPLY_TO?: string;
  USER_EMAILS?: string;
  USER_EMAILS_TO_ADMINS?: string;
  DL_ONLY?: string;
  RAW_LOG_KEEP_DAYS?: string;
  ALLOW_OTHER_HARNESSES?: string;
  OTHER_HARNESS_SHARE?: string;
  /** Cloudflare's send_email binding for alert email; optional (absent off Cloudflare). */
  ALERT_EMAIL?: EmailBinding;
  /**
   * Cloudflare Email Service's send_email binding for emails to users; optional (absent off
   * Cloudflare). When it exists it is used instead of Resend.
   */
  USER_EMAIL?: UserEmailBinding;
  AUTH: DurableObjectNamespace<AuthObject>;
  DIRECTORY: DurableObjectNamespace<DirectoryObject>;
  ACCOUNT: DurableObjectNamespace<AccountObject>;
  RATE_LIMITER: DurableObjectNamespace<RateLimiterObject>;
}

export interface HandlerOptions {
  /** The clock, for tests. */
  now?: () => number;
  /** Outbound fetch (OpenRouter and GitHub), for tests. */
  fetch?: Fetch;
  /** The pause between emails to users in the daily run and a broadcast (Resend allows 2 requests a second); tests set 0. */
  emailGapMs?: number;
  /**
   * Takes work that runs beside a request and is never awaited by it (use descriptions,
   * moderation reviews). Tests pass a collector to wait for it. Left out, the runtime's execution
   * context takes it (BackgroundContext); with neither, the work just runs on, and on Workers it
   * is cancelled as soon as the response has been sent.
   */
  background?: (task: Promise<unknown>) => void;
}

/**
 * The fetch handler's third argument on Workers (ExecutionContext), when the runtime gives one.
 * Its keep-alive method keeps background work (a use description, a moderation review: a model call
 * and Durable Object writes, seconds long) alive after the response is sent; without it Workers
 * cancels that work when the response ends, so a review of a short request never finished. It is
 * optional: a runtime without it (Serverless Objects) gets the old behaviour.
 */
export interface BackgroundContext {
  waitUntil(task: Promise<unknown>): void; // portable-exception: optional, used only when the runtime passes it
}

export interface Ctx {
  request: Request;
  url: URL;
  env: Env;
  /** The config from `env` only; use `runtime(c)` for values the owner can override. */
  config: FreeConfig;
  /** This request's runtime view, read once (see `runtime`). */
  runtimeState?: Promise<Runtime>;
  /** The signed-in caller, set before `runtime` so it also reads their queue place and bonus. */
  callerId?: number;
  now: () => number;
  fetch: Fetch;
  ip: string;
  /** What per-IP limits key on: the IPv4 address, or the IPv6 /64 (see network.ts). */
  ipNet: string;
  base: string;
  /** This isolate's last /v1/status answer (see `status`). */
  statusCache: { value?: FreeStatus; at: number };
  /** This isolate's last /v1/providers answer (see `providersPublic`). */
  providersCache: { value?: PublicProviders; at: number };
  /** The pause between emails to users (HandlerOptions.emailGapMs). */
  emailGapMs: number;
  /** HandlerOptions.background. */
  background?: (task: Promise<unknown>) => void;
}

/** The daily digest's cron: 01:00 UTC, 09:00 in Singapore. Must match `triggers.crons` in both wrangler configs. */
export const DIGEST_CRON = "0 1 * * *";
/** Where the digest's dashboard link points when PUBLIC_URL isn't set (a cron run has no request URL). */
const DEFAULT_PUBLIC_URL = "https://free.directionallylocal.com";

/** What a cron trigger hands the Worker: the cron expression that fired and when it was due. */
export interface ScheduledController {
  cron: string;
  scheduledTime: number;
}

/**
 * The default pause between emails to users: Resend allows 2 requests a second. Email Service
 * publishes no per-second rate (only a daily quota that grows), so the same pace is used for it.
 */
const EMAIL_GAP_MS = 600;

export function createHandler(options: HandlerOptions = {}): {
  fetch(request: Request, env: Env, execution?: BackgroundContext): Promise<Response>;
  scheduled(controller: ScheduledController, env: Env): Promise<void>;
} {
  const now = options.now ?? (() => Date.now());
  const fetcher: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const statusCache: Ctx["statusCache"] = { at: 0 };
  const providersCache: Ctx["providersCache"] = { at: 0 };
  const emailGapMs = options.emailGapMs ?? EMAIL_GAP_MS;
  return {
    /**
     * Cron triggers: the daily digest (DIGEST_CRON), and every 10 minutes (PROBE_CRON) the speed
     * probes and the runway check. The weekly queue needs none, it runs on the first request of
     * the week. Never throws for an unknown cron.
     */
    async scheduled(controller: ScheduledController, env: Env): Promise<void> {
      if (controller.cron === PROBE_CRON) {
        try {
          await runProbes(env, fetcher, now, Number.isFinite(controller.scheduledTime) ? controller.scheduledTime : now());
        } catch (error) {
          console.error("speed probes: run failed", error instanceof Error ? error.name : "error");
        }
        // The same 10-minute trigger checks the runway (runway.ts), probes on or off.
        try {
          await runRunway(env, fetcher, now);
        } catch (error) {
          console.error("runway alerts: run failed", error instanceof Error ? error.name : "error");
        }
        // The same 10-minute tick prunes the raw log in small steps.
        try {
          await pruneRawLogs(env, now);
        } catch (error) {
          console.error("raw log pruning: run failed", error instanceof Error ? error.name : "error");
        }
        // Mondays from 01:30 UTC through Tuesday, it carries on the weekly_reset email where the
        // daily run stopped (nothing on other days, without touching the Directory).
        try {
          const at = now();
          if (weeklyResetWindow(at, "tick")) await scheduledWeeklyReset(env, readFreeConfig(env as unknown as Record<string, unknown>), fetcher, at, emailGapMs, "tick");
        } catch (error) {
          console.error("user emails (weekly_reset): run failed", error instanceof Error ? error.name : "error");
        }
        // The same for paying accounts' plan_reset (once free tokens have ended).
        try {
          const at = now();
          if (weeklyResetWindow(at, "tick")) await scheduledPlanReset(env, readFreeConfig(env as unknown as Record<string, unknown>), fetcher, at, emailGapMs, "tick");
        } catch (error) {
          console.error("user emails (plan_reset): run failed", error instanceof Error ? error.name : "error");
        }
        return;
      }
      if (controller.cron !== DIGEST_CRON) {
        console.error("scheduled: unknown cron", controller.cron);
        return;
      }
      const config = readFreeConfig(env as unknown as Record<string, unknown>);
      // The time it was due, so a late or retried run still reports the day before 01:00 UTC.
      const at = Number.isFinite(controller.scheduledTime) ? controller.scheduledTime : now();
      const digest = await env.DIRECTORY.getByName("directory").dailyDigest(at, policyOf(config), config.paused);
      if (digest) await deliver({ config, env, fetch: fetcher, base: config.publicUrl ?? DEFAULT_PUBLIC_URL, now }, [digest]);
      try {
        await scheduledUserEmails(env, config, fetcher, now(), emailGapMs);
      } catch (error) {
        console.error("user emails (daily): run failed", error instanceof Error ? error.name : "error");
      }
      // After the daily emails, so they go first within the day's limit.
      try {
        await scheduledWeeklyReset(env, config, fetcher, now(), emailGapMs, "daily");
      } catch (error) {
        console.error("user emails (weekly_reset): run failed", error instanceof Error ? error.name : "error");
      }
      try {
        await scheduledPlanReset(env, config, fetcher, now(), emailGapMs, "daily");
      } catch (error) {
        console.error("user emails (plan_reset): run failed", error instanceof Error ? error.name : "error");
      }
    },
    async fetch(request: Request, env: Env, execution?: BackgroundContext): Promise<Response> {
      let config: FreeConfig;
      try {
        config = readFreeConfig(env as unknown as Record<string, unknown>);
      } catch (error) {
        if (error instanceof ConfigError) return apiError(500, "misconfigured", error.message);
        throw error;
      }
      const url = new URL(request.url);
      const ip = clientIp(request);
      const background = options.background ?? backgroundOf(execution);
      // api.dl.new serves only the API (Cloudflare routes its /v1/* and /anthropic/* here; its
      // other paths are dl.new's key page), so links made from a request there use the service's own address.
      const base = config.publicUrl ?? (url.origin === new URL(config.webApiUrl).origin ? DEFAULT_PUBLIC_URL : url.origin);
      const ctx: Ctx = { request, url, env, config, now, fetch: fetcher, ip, ipNet: rateLimitNetwork(ip), base, statusCache, providersCache, emailGapMs, ...(background ? { background } : {}) };
      return route(ctx);
    },
  };
}

/** The execution context's way to keep a task alive past the response, when there is one. */
function backgroundOf(execution: BackgroundContext | undefined): ((task: Promise<unknown>) => void) | undefined {
  if (!execution || typeof execution.waitUntil !== "function") return undefined; // portable-exception: optional, see BackgroundContext
  return (task) => execution.waitUntil(task); // portable-exception: optional, see BackgroundContext
}

export default createHandler();

async function route(c: Ctx): Promise<Response> {
  const path = c.url.pathname.replace(/\/+$/, "") || "/";
  const method = c.request.method;
  if (path === "/health") return json({ ok: true, service: "free", version: VERSION });

  if (method === "POST" && path === "/v1/device/code") return deviceCode(c);
  if (method === "POST" && path === "/v1/device/token") return deviceToken(c);
  if (method === "POST" && path === "/v1/token/refresh") return refresh(c);
  if (method === "POST" && path === "/v1/token/revoke") return revoke(c);
  if (path === "/v1/keys" || path.startsWith("/v1/keys/")) return keys(c, path.slice("/v1/keys".length).replace(/^\//, ""), method);
  if (path === "/v1/status" && (method === "GET" || method === "OPTIONS")) return status(c);
  if (path === "/v1/providers" && (method === "GET" || method === "OPTIONS")) return providersPublic(c);
  if (method === "GET" && path === "/v1/me") return me(c);
  if (path === "/v1/plans" && (method === "GET" || method === "OPTIONS")) return plansPublic(c);
  if (method === "GET" && path === "/v1/usage") return usage(c);
  if (method === "POST" && path === "/v1/plan/fallback") return planFallback(c);
  if (method === "GET" && path === "/v1/models") return models(c);
  if (method === "POST" && path === "/v1/chat/completions") return chatCompletions(c);
  if (method === "POST" && path === "/v1/events") return events(c);
  if (path === "/v1/harness-keys" || path.startsWith("/v1/harness-keys/")) return harnessKeys(c, path.slice("/v1/harness-keys".length).replace(/^\//, ""), method);
  if (path.startsWith("/anthropic/")) return anthropic(c, path.slice("/anthropic".length), method);
  if (method === "POST" && path === "/v1/feedback") return feedback(c);
  if ((method === "GET" || method === "POST") && path === ACCESS_REQUEST_PATH) return accessRequest(c, method);
  if (method === "GET" && path === "/v1/feedback/reply-address") return feedbackReplyAddress(c);
  if (method === "POST" && path === "/v1/telemetry/download") return telemetry(c, "download");
  if (method === "POST" && path === "/v1/telemetry/install") return telemetry(c, "install");
  if (method === "POST" && path === "/v1/telemetry/gpu") return telemetry(c, "gpu");
  if (method === "POST" && path === "/v1/telemetry/web") return webTelemetry(c);
  if (method === "POST" && path === "/v1/install-code/exchange") return installCodeExchange(c);
  if (path.startsWith("/v1/cli-login/")) {
    const handled = paidV1(c, path, method);
    if (handled) return handled;
  }
  if (path.startsWith("/web/")) return web(c, path, method);
  if (method === "GET" && path.startsWith("/v1/referrals/")) return referralLookup(c, path.slice("/v1/referrals/".length));
  if (method === "POST" && path === "/v1/billing/checkout") return billingCheckout(c);
  if (method === "POST" && path === "/v1/billing/portal") return billingPortal(c);
  if (method === "POST" && path === "/v1/billing/webhook") return billingWebhook(c);

  if (method === "GET" && path === "/device") return devicePage(c);
  if (method === "GET" && path === "/device/authorize") return deviceAuthorize(c);
  if (method === "GET" && path === CALLBACK_PATH) return oauthCallback(c);
  if (method === "POST" && path === "/device/deny") return deviceDeny(c);
  if (method === "POST" && path === "/device/invite") return deviceInvite(c);
  if (method === "POST" && path === "/device/no-invite") return deviceNoInvite(c);
  if (method === "POST" && path === "/device/details") return deviceDetails(c);
  if ((method === "GET" || method === "POST") && path === "/email/stop") return emailStop(c, method);
  if ((method === "GET" || method === "POST") && path === NO_GITHUB_PATH) return noGithub(c, method);
  if (method === "GET" && path === LEGACY_ADMIN_CALLBACK_PATH) return adminCallback(c, LEGACY_ADMIN_CALLBACK_PATH);

  if (path === "/admin" || path === "/admin/signin" || path === "/admin/signout" || path.startsWith("/admin/dashboard/")) return adminWeb(c, path, method);

  const adminPath = path.startsWith("/v1/admin/") ? path.slice(3) : path;
  if (adminPath.startsWith("/admin/")) return admin(c, adminPath.slice("/admin/".length), method);

  return apiError(404, "not_found", `${method} ${c.url.pathname} isn't a route.`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

export async function limited(c: Ctx, key: string, limit: Limit): Promise<number | undefined> {
  const outcome = await c.env.RATE_LIMITER.getByName(key).spend(key, limit, 1, c.now());
  return outcome.allowed ? undefined : outcome.retryAfterSeconds;
}

export function rateLimited(retryAfter: number, headers: Record<string, string> = {}): Response {
  return apiError(429, "rate_limited", `Too many requests. Try again in ${retryAfter} seconds.`, { retryAfter }, { "retry-after": String(retryAfter), ...headers });
}

export async function readJson(c: Ctx): Promise<Record<string, unknown> | undefined> {
  try {
    const value = (await c.request.json()) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function readForm(c: Ctx): Promise<URLSearchParams> {
  return new URLSearchParams(await c.request.text());
}

/** The level a person is served at: basic with its tokens set to 0 (the level off) is Starter. */
function servedLevel(level: Level, config: FreeConfig): Level {
  return level === "basic" && config.basicWeeklyTokens <= 0 ? "starter" : level;
}

/**
 * Below the bar with no free tokens at all: Starter with the setting at 0, or a Starter account
 * the creation-batch check flagged (never said to the person).
 */
function noFreeTokens(level: Level, config: FreeConfig, batchFlagged: boolean): boolean {
  return servedLevel(level, config) === "starter" && (batchFlagged || config.starterWeeklyTokens <= 0);
}

/** The basic level's rule, from the effective config. Admin-only: never in a response to the person. */
function basicRule(config: FreeConfig): BasicRule {
  return { minAccountAgeDays: config.basicMinAccountAgeDays, weeklyTokens: config.basicWeeklyTokens };
}

/**
 * The allowance's limits for a level. `bonusTokens`: this week's referral bonus, added on top of
 * Full's weekly allowance. Basic and Starter get every model on their own tokens and dollar cap;
 * a batch-flagged Starter account gets 0 tokens. `trial`: the account is on the one-time trial,
 * of `trialTokens` plus `trialBonusTokens` (its referral bonus, see `trialBonuses` in referrals.ts).
 */
function limitsFor(config: FreeConfig, bonusTokens = 0, level: Level = "full", batchFlagged = false, trial = false, trialBonusTokens = 0): Limits {
  const limits = levelLimits(config, bonusTokens, level, batchFlagged);
  return trial ? { ...limits, trialTokens: config.trialTokens + Math.max(0, trialBonusTokens) } : limits;
}

/**
 * Whether an account is on the new-user trial: the trial is on (`trialCutoff` set), the account
 * was admitted at or after the cutoff, and it isn't an admin. Everyone admitted before the cutoff
 * is grandfathered: the weekly free allowance as before. Unknown admission (no Directory row): not on trial.
 */
export function onTrial(config: Pick<FreeConfig, "trialCutoff" | "adminGithubIds">, githubId: number, admittedAt: number | null | undefined): boolean {
  if (config.trialCutoff === undefined || admittedAt === null || admittedAt === undefined) return false;
  if (config.adminGithubIds.has(githubId)) return false;
  return admittedAt >= config.trialCutoff;
}

function levelLimits(config: FreeConfig, bonusTokens: number, level: Level, batchFlagged: boolean): Limits {
  const served = servedLevel(level, config);
  // Two weekly dollar budgets: `weeklyUsd` is GPT-6's (every GPT-6 model), `deepseekWeeklyUsd`
  // DeepSeek's. A setting of "none" is no cap (null).
  const base = {
    weeklyTokens: config.weeklyTokens,
    proTokensPerWeek: config.offers.pro.tokensPerWeek,
    proDeepseekUsdPerWeek: proDeepseekWeeklyUsd(config),
  };
  if (served === "full") return { ...base, weeklyUsd: config.perPersonWeeklyUsdCap, deepseekWeeklyUsd: config.deepseekWeeklyUsdCap ?? null, level: "full", ...(bonusTokens > 0 ? { bonusTokens } : {}) };
  if (served === "basic") return { ...base, weeklyUsd: config.basicWeeklyUsdCap, deepseekWeeklyUsd: config.basicDeepseekWeeklyUsdCap ?? null, level: "basic", levelTokens: config.basicWeeklyTokens };
  // A batch-flagged Starter account gets nothing of either.
  if (batchFlagged) return { ...base, weeklyUsd: 0, deepseekWeeklyUsd: 0, level: "starter", levelTokens: 0 };
  return { ...base, weeklyUsd: config.starterWeeklyUsdCap, deepseekWeeklyUsd: config.starterDeepseekWeeklyUsdCap ?? null, level: "starter", levelTokens: config.starterWeeklyTokens };
}

/**
 * Pro's weekly open-models (DeepSeek) budget: `proOpenModelsMultiplier` times a Full free
 * account's (`deepseekWeeklyUsdCap`); null (no cap) when the free one has none.
 */
export function proDeepseekWeeklyUsd(config: Pick<FreeConfig, "deepseekWeeklyUsdCap" | "proOpenModelsMultiplier">): number | null {
  if (config.deepseekWeeklyUsdCap === undefined) return null;
  return Math.round(config.deepseekWeeklyUsdCap * config.proOpenModelsMultiplier * 1e6) / 1e6;
}

/**
 * One person's limits as their own requests get them: their level (basic with its tokens off is
 * Starter), the creation-batch flag (0 tokens) and this week's referral bonus. For admin views of
 * someone else, where `runtime(c)` holds the caller.
 */
async function personLimits(c: Ctx, config: FreeConfig, githubId: number, now: number): Promise<{ level: Level; limits: Limits }> {
  const person = (await directory(c).gate(now, policyOf(c.config), githubId)).person;
  const level = servedLevel(person?.level ?? "full", config);
  return { level, limits: allocated(config, limitsFor(config, person?.bonusTokens, level, person?.batchFlagged === true, onTrial(config, githubId, person?.admittedAt), person?.trialBonusTokens), githubId, person, now) };
}

/**
 * `limits` with the token allocator applied (allocator.ts): the start grant, the step reached and
 * this week's grace. Admins, blocked accounts and unknown people are left as they are.
 */
function allocated(config: FreeConfig, limits: Limits, githubId: number, person: Pick<PersonState, "blocked" | "bonusTokens" | "allocator"> | undefined, now: number): Limits {
  if (!person || person.blocked || config.adminGithubIds.has(githubId)) return limits;
  return allocatedLimits(limits, {
    settings: config,
    state: person.allocator ?? null,
    week: weekStart(now),
    steps: { starter: levelLimits(config, 0, "starter", false), basic: levelLimits(config, 0, "basic", false), full: levelLimits(config, person.bonusTokens, "full", false) },
  });
}

/** What an allocator decision needs from this request (allocator.ts AllocatorRun). */
async function allocatorRun(c: Ctx, config: FreeConfig, githubId: number): Promise<AllocatorRun> {
  return {
    directory: directory(c),
    fetch: c.fetch,
    now: () => c.now(),
    apiKey: c.config.openRouterApiKey,
    settings: config,
    rules: config.detection,
    user: await safetyIdentifier(githubId),
    fullTokens: config.weeklyTokens,
  };
}

/** An event code as the admin API shows it: times as ISO strings, who used it. */
function eventCodeView(row: EventCodeRow): Record<string, unknown> {
  return {
    ...row,
    expiresAt: new Date(row.expiresAt).toISOString(),
    createdAt: new Date(row.createdAt).toISOString(),
    endedAt: row.endedAt === null ? null : new Date(row.endedAt).toISOString(),
    people: row.people.map((person) => ({ ...person, at: new Date(person.at).toISOString() })),
  };
}

/** The level thresholds, from the effective config. */
function levelThresholds(config: FreeConfig): LevelThresholds {
  return { minAccountAgeDays: config.fullMinAccountAgeDays, minPublicRepos: config.fullMinPublicRepos, minContributions: config.fullMinContributions };
}

/** The additional checks' thresholds, from the effective config. Admin-only: never in a response to the person. */
function signalThresholds(config: FreeConfig): SignalThresholds {
  return {
    humanSignalsNeeded: config.humanSignalsNeeded,
    minActiveWeeks: config.minActiveWeeks,
    minRepoAgeDays: config.minRepoAgeDays,
    minSocial: config.minSocial,
    minFollowers: config.minFollowers,
    batchWindowDays: config.batchWindowDays,
    batchSize: config.batchSize,
    batchDensityFactor: config.batchDensityFactor,
  };
}

/** A people row's stored signals, as admission.ts takes them. */
function storedSignals(person: LevelSignalRow): GithubSignals {
  return {
    accountAgeDays: person.account_age_days ?? 0,
    publicRepos: person.public_repos ?? 0,
    followers: person.followers ?? 0,
    contributions: person.contributions ?? 0,
    restrictedContributions: person.restricted_contributions ?? 0,
    createdDay: person.github_created_day ?? null,
    activeWeeks: person.active_weeks ?? null,
    outsideContributions: person.outside_contributions ?? null,
    oldestRepoCreatedAt: person.oldest_repo_at ?? null,
    social: person.social ?? null,
  };
}

/**
 * Every person's stored signals and the checks they pass today, for the admin people API and
 * the dashboard: why someone is Starter. Admin-only.
 */
function peopleChecks(people: LevelSignalRow[], config: FreeConfig, now: number, eventSignups: ReadonlySet<number> = new Set()): Map<number, LevelChecks> {
  const rules = signalThresholds(config);
  const peers = batchCounter(
    people.map((person) => person.github_created_day ?? null),
    rules.batchWindowDays,
  );
  const bar = levelThresholds(config);
  const youngSince = dayOf(now) - bar.minAccountAgeDays;
  const youngAccounts = people.filter((person) => person.github_created_day !== null && person.github_created_day !== undefined && person.github_created_day >= youngSince).length;
  const out = new Map<number, LevelChecks>();
  for (const person of people) {
    // The count includes the person's own row; the check counts the others.
    const day = person.github_created_day ?? null;
    // Someone who signed up with an event code is never in a creation batch.
    const batchPeers = eventSignups.has(person.github_id) ? 0 : Math.max(0, peers(day) - (day === null ? 0 : 1));
    out.set(person.github_id, levelChecks(storedSignals(person), bar, rules, { now, batchPeers, youngAccounts }));
  }
  return out;
}

const signingKeys = new Map<string, Promise<CryptoKey>>();
export function signingKey(config: FreeConfig): Promise<CryptoKey> {
  let key = signingKeys.get(config.tokenSigningKey);
  if (!key) {
    key = hmacKey(config.tokenSigningKey);
    signingKeys.set(config.tokenSigningKey, key);
  }
  return key;
}

/** `sid` is the refresh-token family: the sign-in session the access token belongs to. */
async function tokenResponse(c: Ctx, identity: Identity, refreshToken: string, sid: string): Promise<Response> {
  return json(await tokenBody(c, identity, refreshToken, sid));
}

async function tokenBody(c: Ctx, identity: Identity, refreshToken: string, sid: string) {
  const iat = Math.floor(c.now() / 1000);
  const accessToken = await signJwt(
    { iss: ISSUER, typ: "access", sub: String(identity.githubId), login: identity.login, sid, iat, exp: iat + ACCESS_TTL_S, jti: crypto.randomUUID() },
    await signingKey(c.config),
  );
  return { access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: ACCESS_TTL_S };
}

/** Who is calling: from a sign-in session's access token, or from a server key. */
/** The 401 on /v1 and /anthropic for a caller with no auth or a bad dl.new API key (`dl_sk_`, `dlk_`). */
export const API_KEY_MISSING_MESSAGE = "Missing or invalid API key. Create one at dl.new/keys.";

interface Caller extends Identity {
  /** "harness": a harness key from `dl claude` or `dl opencode` (see HARNESS_KEY in account-object.ts). */
  via: "access" | "key" | "harness";
  /** With a harness key: which coding agent, and the key's id. */
  harness?: Harness;
  harnessKeyId?: string;
  /** With a `dlk_` key: its kind and id ("tool": a key for any tool, see tool-keys.ts). */
  keyKind?: KeyKind;
  keyId?: string;
  /** The sign-in session, for access tokens issued since sessions were tracked. */
  sid?: string;
}

/**
 * The person behind a valid access token, or a 401. With `keys`, a server key is accepted
 * too, from an account allowed keys (`serverKeysAllowed`); with `ungrantedKeys` as well, from
 * any account (only /request, so a server with an old key can ask for a grant). With `toolKeys`,
 * a tool key too (tool-keys.ts), while the `toolKeys` setting is on. With `harness`,
 * a harness key: any (true), or only one minted for one of the listed agents. An access token
 * from a revoked session is refused like an expired one.
 */
async function authenticate(
  c: Ctx,
  options: { keys?: boolean; ungrantedKeys?: boolean; toolKeys?: boolean; harness?: boolean | readonly Harness[]; apiKeyHeader?: boolean } = {},
): Promise<Caller | Response> {
  // Anthropic clients may send the key as `x-api-key` instead (apiKeyHeader: the Anthropic endpoint).
  const apiKey = options.apiKeyHeader ? c.request.headers.get("x-api-key")?.trim() : undefined;
  const header = c.request.headers.get("authorization") ?? (apiKey ? `Bearer ${apiKey}` : "");
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  // On the model APIs (/v1, /anthropic) a caller with no auth, or with an API key, gets the
  // API-key wording; a dl or Autopilot access token keeps "Sign in again".
  const modelApi = /^\/(?:v1|anthropic)\//.test(c.url.pathname);
  const bearer = match?.[1] ?? "";
  const apiKeyCaller = modelApi && (!match || bearer.startsWith(API_KEY_PREFIX) || bearer.startsWith("dlk_"));
  const invalid = () =>
    apiError(401, "invalid_token", apiKeyCaller ? API_KEY_MISSING_MESSAGE : "Sign in again: the access token is missing, invalid or expired.", {}, { "www-authenticate": 'Bearer error="invalid_token"' });
  if (!match) return invalid();
  if (bearer.startsWith("dlh_")) {
    // A harness key works only where `harness` allows it, and only for the agents it lists:
    // Claude Code's on the Anthropic endpoint, OpenCode's on chat completions; never on keys.
    const parsed = parseHarnessKey(bearer);
    if (!options.harness || !parsed) return invalid();
    const only = Array.isArray(options.harness) ? (options.harness as readonly Harness[]) : undefined;
    const owner = await account(c, parsed.githubId).verifyHarnessKey(parsed.id, parsed.secret, c.now());
    // An expired key's agent isn't known any more: where several may call, dl's `x-dl-harness`
    // header (sent by dl pi) picks the words, else the first listed agent's.
    const hinted = c.request.headers.get("x-dl-harness");
    const named = only?.length === 1 ? only[0] : (only?.find((harness) => harness === hinted) ?? only?.[0]);
    if (!owner) return apiError(401, "invalid_harness_key", harnessKeyExpiredMessage(named), {}, { "www-authenticate": 'Bearer error="invalid_token"' });
    if (only && !only.includes(owner.harness)) return invalid();
    return { githubId: owner.githubId, login: owner.login, via: "harness", harness: owner.harness, harnessKeyId: parsed.id, ...(owner.sid ? { sid: owner.sid } : {}) };
  }
  if (bearer.startsWith("dlk_")) {
    const invalidKey = () =>
      apiError(401, "invalid_key", modelApi ? API_KEY_MISSING_MESSAGE : "This server key is invalid or was revoked. Create a new one from a signed-in machine.", {}, { "www-authenticate": 'Bearer error="invalid_token"' });
    const parsed = parseServerKey(bearer);
    if (!options.keys || !parsed) return options.keys ? invalidKey() : invalid();
    const found = await account(c, parsed.githubId).verifyKey(parsed.id, parsed.secret, c.now(), toolName(c.request.headers));
    if (!found) return invalidKey();
    const { kind, paid: _paid, ...owner } = found;
    // A tool key (tool-keys.ts) works only where `toolKeys` allows it, while the setting is on,
    // and needs no grant: who may make one is checked when it is made, and every request still
    // meets the blocks and refusals below it.
    if (kind === "tool") {
      if (!options.toolKeys) return apiError(403, "tool_key_not_allowed", TOOL_KEY_NOT_HERE_MESSAGE);
      if (!applyOverrides(c.config, await directory(c).overrides()).toolKeys) return apiError(403, "tool_keys_off", TOOL_KEYS_OFF_MESSAGE);
      return { ...owner, via: "key", keyKind: "tool", keyId: parsed.id };
    }
    if (options.ungrantedKeys) return { ...owner, via: "key", keyKind: "server", keyId: parsed.id };
    // A key kept from before keys needed a grant stops working until an admin grants them (it
    // isn't deleted). Blocked and suspended accounts are left to the refusals they get today.
    const stored = await directory(c).getPerson(owner.githubId);
    if ((!stored || stored.status === "active") && !(await serverKeysAllowed(c, owner.githubId, stored))) return serverKeysUnavailable();
    return { ...owner, via: "key", keyKind: "server", keyId: parsed.id };
  }
  if (bearer.startsWith(API_KEY_PREFIX)) {
    // dl.new's API keys (accounts.ts): tool keys tied to the account, not a GitHub id.
    const invalidKey = () => apiError(401, "invalid_key", API_KEY_MISSING_MESSAGE, {}, { "www-authenticate": 'Bearer error="invalid_token"' });
    const parsed = parseApiKey(bearer);
    if (!options.keys || !parsed) return options.keys ? invalidKey() : invalid();
    if (!options.toolKeys) return apiError(403, "tool_key_not_allowed", TOOL_KEY_NOT_HERE_MESSAGE);
    const found = await account(c, parsed.account).verifyKey(parsed.id, parsed.secret, c.now(), toolName(c.request.headers));
    if (!found || found.kind !== "tool") return invalidKey();
    const { kind: _kind, paid, ...owner } = found;
    // The tool keys switch is for free accounts; a paying one's keys always work.
    if (!paid && !applyOverrides(c.config, await directory(c).overrides()).toolKeys) return apiError(403, "tool_keys_off", TOOL_KEYS_OFF_MESSAGE);
    return { ...owner, via: "key", keyKind: "tool", keyId: parsed.id };
  }
  const claims = await verifyJwt(bearer, await signingKey(c.config), Math.floor(c.now() / 1000));
  if (!claims || claims.typ !== "access" || claims.iss !== ISSUER || typeof claims.login !== "string") return invalid();
  const githubId = Number(claims.sub);
  if (!Number.isSafeInteger(githubId) || githubId <= 0) return invalid();
  const sid = typeof claims.sid === "string" ? claims.sid : undefined;
  if (!(await account(c, githubId).sessionAllowed(sid, claims.iat))) return invalid();
  return { githubId, login: claims.login, via: "access", ...(sid ? { sid } : {}) };
}

/** An account's Durable Object (accounts.ts accountObjectName: `gh:<n>` as before, `acct:<n>` for dl.new's). */
export function account(c: Ctx, githubId: number) {
  return c.env.ACCOUNT.getByName(accountObjectName(githubId));
}

export function directory(c: Ctx) {
  return c.env.DIRECTORY.getByName("directory");
}

export function auth(c: Ctx) {
  return c.env.AUTH.getByName("auth");
}

/** The OpenRouter hosts that failed recently (see rate-limit-object.ts). */
function hosts(c: Ctx) {
  return c.env.RATE_LIMITER.getByName(HOSTS_OBJECT);
}

/** The config with the admin's runtime overrides applied, the kill switch, and non-admin spend. */
export interface Runtime {
  config: FreeConfig;
  paused: boolean;
  weekUsd: number;
  totalUsd: number;
  /** Luminal credit used since the start, by everyone. */
  creditUsedUsd: number;
  /** Free Luminal credit spend this week, and how many wait: what the queue watches. */
  weekCreditUsd: number;
  /** OpenAI credit used since the start, and free OpenAI spend this week. */
  openaiCreditUsedUsd: number;
  openaiWeekCreditUsd: number;
  waiting: number;
  /** The caller's queue place, referral numbers and bonus, when `c.callerId` was set. */
  person?: PersonState;
  /** Every provider's credit used (providers.ts). */
  providerSpend: ProviderSpend;
  /** The caller's spend on each registry provider this week, when `c.callerId` was set. */
  personProviderWeekUsd?: Partial<Record<string, number>>;
}

/**
 * Read once per request: an override changed mid-request applies from the next one. The
 * Directory also runs Monday's queue admission here, on the first request of the week.
 */
export function runtime(c: Ctx): Promise<Runtime> {
  c.runtimeState ??= directory(c)
    .gate(c.now(), policyOf(c.config), c.callerId)
    .then((gate: Gate) => ({
      config: applyOverrides(c.config, gate.overrides),
      paused: c.config.paused || gate.paused,
      weekUsd: gate.weekUsd,
      totalUsd: gate.totalUsd,
      creditUsedUsd: gate.creditUsedUsd,
      weekCreditUsd: gate.weekCreditUsd,
      openaiCreditUsedUsd: gate.openaiCreditUsedUsd,
      openaiWeekCreditUsd: gate.openaiWeekCreditUsd,
      waiting: gate.waiting,
      ...(gate.person ? { person: gate.person } : {}),
      providerSpend: gate.providerSpend,
      ...(gate.personProviderWeekUsd ? { personProviderWeekUsd: gate.personProviderWeekUsd } : {}),
    }));
  return c.runtimeState;
}

/** Sends alerts by email and/or webhook; never fails the request. */
export async function alert(c: Ctx, alerts: readonly Alert[]): Promise<void> {
  await deliver(c, alerts);
}

/** What the provider checks read from the request's runtime view. */
type ProviderGate = { creditUsedUsd: number; openaiCreditUsedUsd: number; providerSpend?: ProviderSpend };

/** Whether a provider has a key and credit left (a registry provider: also on, inside its weekly budget). */
function providerReady(provider: Upstream, config: FreeConfig, gate: ProviderGate): boolean {
  if (provider === "openai") return config.openaiApiKey !== undefined && gate.openaiCreditUsedUsd < config.openaiCreditUsd;
  if (provider === "luminal") return config.luminalApiKey !== undefined && gate.creditUsedUsd < config.luminalCreditUsd;
  if (isRegistryProvider(provider)) {
    const settings = providerSettings(config, provider);
    const spend = gate.providerSpend ?? { usedUsd: {}, weekUsd: {} };
    return (
      providerKey(config, provider) !== undefined &&
      settings.status === "on" &&
      (spend.usedUsd[provider] ?? 0) < settings.creditUsd &&
      (settings.weeklyCreditUsd === undefined || (spend.weekUsd[provider] ?? 0) < settings.weeklyCreditUsd)
    );
  }
  return config.openRouterApiKey !== undefined;
}

/** Whether a provider is out of credit, as opposed to having no key at all. */
function providerExhausted(provider: Upstream, config: FreeConfig, gate: ProviderGate): boolean {
  if (provider === "openai") return config.openaiApiKey !== undefined && gate.openaiCreditUsedUsd >= config.openaiCreditUsd;
  if (provider === "luminal") return config.luminalApiKey !== undefined && gate.creditUsedUsd >= config.luminalCreditUsd;
  if (isRegistryProvider(provider)) return providerKey(config, provider) !== undefined && (gate.providerSpend?.usedUsd[provider] ?? 0) >= providerSettings(config, provider).creditUsd;
  return false;
}

/**
 * Why a registry provider's model can't serve this caller now (providers.ts registryBlock), or
 * undefined. Admins skip the opt-in cap; nothing else.
 */
function blockFor(model: FreeModel, config: FreeConfig, gate: Pick<Runtime, "providerSpend" | "personProviderWeekUsd">, isAdmin: boolean, plan?: Plan): ProviderBlock | undefined {
  return routeFor(model, config, gate, isAdmin, plan).block;
}

/**
 * A registry model's upstreams that can serve this caller now, in order, and the block when none
 * can or the caller can't use it (providers.ts registryRoute). The person's spend is the one their
 * cap counts (personSpendKey: the model's own across upstreams, or the provider's).
 */
function routeFor(model: FreeModel, config: FreeConfig, gate: Pick<Runtime, "providerSpend" | "personProviderWeekUsd">, isAdmin: boolean, plan?: Plan): RegistryRoute {
  if (!isRegistryProvider(model.provider)) return { upstreams: [] };
  return registryRoute(config, model, gate.providerSpend, isAdmin ? undefined : (gate.personProviderWeekUsd?.[personSpendKey(model)] ?? 0), isAdmin ? undefined : plan);
}

/**
 * The caller's plan when it matters for a registry provider (one of `models` is Pro-only and the
 * caller isn't an admin), else undefined: one Account read, only then.
 */
async function planForProviders(c: Ctx, config: FreeConfig, githubId: number, models: readonly FreeModel[]): Promise<Plan | undefined> {
  if (c.config.adminGithubIds.has(githubId) || !models.some((model) => proOnly(config, model))) return undefined;
  return account(c, githubId).plan(c.now());
}

/**
 * A capped model's weekly ration for one person, as /v1/me and /v1/models show it, or null (no
 * per-person cap: not Pro-only, opt-in or a provider that caps everyone). `resetsAt` is the week's end.
 */
function rationView(config: FreeConfig, model: FreeModel, weekUsd: Partial<Record<string, number>> | undefined, now: number) {
  if (!capped(config, model)) return null;
  const ration = rationOf(config, model, weekUsd?.[personSpendKey(model)] ?? 0);
  return ration ? { ...ration, resetsAt: new Date(weekEnd(now)).toISOString() } : null;
}

/** Whether a person's weekly use of a model is capped (providers.ts personCapUsd): Pro's ration, opt-in, or the model's own cap (GLM 5.3 Flash). */
function capped(config: FreeConfig, model: FreeModel): boolean {
  return isRegistryProvider(model.provider) && personCapUsd(config, model) !== undefined;
}

/** A provider's prepaid credit balance, for the pause alert. */
function providerCredit(provider: Upstream, config: FreeConfig): number {
  return provider === "openai" ? config.openaiCreditUsd : config.luminalCreditUsd;
}

/**
 * The model and provider that serve: the requested model on its own provider when that has a
 * key and credit, else its fallback (any OpenAI model → DeepSeek on Luminal). DeepSeek can also
 * be served by OpenRouter, the old upstream, when Luminal has no key. Undefined when nothing can.
 * A registry model is served by the first of its upstreams that can (GLM 5.3 Flash: Liquid, then
 * Open Relay), `model` being it as that upstream serves it (models.ts onUpstream); `backups` are
 * the others that can, in order, for a failure before anything reaches the client.
 */
function servingModel(
  requested: FreeModel,
  gate: ProviderGate,
  config: FreeConfig,
): { model: FreeModel; provider: Upstream; fallback: boolean; backups?: RegistryProviderId[] } | undefined {
  const primary = config.primaryUpstream;
  if (isRegistryProvider(requested.provider)) {
    const [first, ...backups] = registryRoute(config, requested, gate.providerSpend ?? { usedUsd: {}, weekUsd: {} }).upstreams;
    return first ? { model: onUpstream(requested, first), provider: first, fallback: false, backups } : undefined;
  }
  // The owner's explicit switch wins when that provider can serve this model.
  if (primary === "openrouter" && requested.provider === "luminal" && config.openRouterApiKey) return { model: requested, provider: "openrouter", fallback: false };
  if (primary === "luminal" && requested.provider === "luminal" && providerReady("luminal", config, gate)) return { model: requested, provider: "luminal", fallback: false };
  if (primary === "openai" && requested.provider === "openai" && providerReady("openai", config, gate)) return { model: requested, provider: "openai", fallback: false };
  // Otherwise the model's own provider, then its fallback.
  if (providerReady(requested.provider, config, gate)) return { model: requested, provider: requested.provider, fallback: false };
  const backup = fallbackOf(requested.id);
  if (backup && providerReady(backup.provider, config, gate)) return { model: backup, provider: backup.provider, fallback: true };
  // DeepSeek can also be served by OpenRouter, the old upstream, when Luminal has no key at all.
  if (requested.provider === "luminal" && !config.luminalApiKey && config.openRouterApiKey) return { model: requested, provider: "openrouter", fallback: false };
  return undefined;
}

/** Whether a model can serve right now: its provider, or its fallback, or OpenRouter for DeepSeek. */
function modelAvailable(model: FreeModel, config: FreeConfig, gate: ProviderGate): boolean {
  return servingModel(model, gate, config) !== undefined;
}

/** Who serves now and where to switch, for the Luminal slow-down emails. */
function servingContext(c: Ctx, config: FreeConfig): ServingContext {
  return {
    serving: chooseUpstream(config.primaryUpstream, c.config) ?? "none",
    openRouterConfigured: c.config.openRouterApiKey !== undefined,
    switchUrl: `${c.base}/admin?view=tools#upstream`,
  };
}

/** `alert` without a request: for cron runs too. */
async function deliver(c: Pick<Ctx, "config" | "env" | "fetch" | "base" | "now">, alerts: readonly Alert[]): Promise<void> {
  if (alerts.length === 0) return;
  await deliverAlerts({ alerts, config: c.config, emailBinding: c.env.ALERT_EMAIL, fetch: c.fetch, adminUrl: `${c.base}/admin`, now: c.now() });
}

/** The old token top-up lasted 30 days; a late webhook for one still grants it that long. */
const LEGACY_TOPUP_DAYS = 30;

/** Usage dollars a dollar top-up adds: the paid amount (cents, before tax) times the multiplier, to the cent. */
export function topupUsage(paidCents: number, multiplier: number): number {
  return Math.round(paidCents * multiplier) / 100;
}

/**
 * POST /admin/reset-week: starts this week over for everyone not blocked, both budgets (GPT-6 and
 * DeepSeek): tokens and dollars back to 0. Top-ups, plans and personal caps stay. `dryRun` only
 * counts. One account call per person, at most ADMIN_PEOPLE_CONCURRENCY at once.
 */
async function resetWeek(c: Ctx, now: number, dryRun: boolean): Promise<{ dryRun: boolean; people: number; reset: number; skippedBlocked: number }> {
  const people = await directory(c).listPeople();
  const open = people.filter((person) => person.status !== "blocked");
  const skippedBlocked = people.length - open.length;
  if (dryRun) return { dryRun, people: open.length, reset: 0, skippedBlocked };
  const done = await mapLimited(open, ADMIN_PEOPLE_CONCURRENCY, (person) => account(c, person.github_id).resetWeek(now));
  return { dryRun, people: open.length, reset: done.filter(Boolean).length, skippedBlocked };
}

/** Account calls the admin people list keeps in flight at once. */
export const ADMIN_PEOPLE_CONCURRENCY = 16;
/** The most people one page of the admin people list holds (`?limit=`). */
export const ADMIN_PEOPLE_MAX_LIMIT = 500;

/** `fn` over `items`, at most `limit` at a time, results in the items' order. */
export async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** A person's place in the admin people list (admitted first, then GitHub id): `<admittedAt>-<githubId>`. */
function peopleCursor(person: { admitted_at: number; github_id: number }): string {
  return `${String(person.admitted_at).padStart(15, "0")}-${String(person.github_id).padStart(16, "0")}`;
}

/** `?limit=` (1 to ADMIN_PEOPLE_MAX_LIMIT; none: everyone) and `?cursor=` (a previous page's `nextCursor`). */
function peoplePage(params: URLSearchParams): { limit: number | undefined; after: string | undefined } | { error: string } {
  const rawLimit = params.get("limit");
  const rawCursor = params.get("cursor");
  const limit = rawLimit === null || rawLimit === "" ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > ADMIN_PEOPLE_MAX_LIMIT)) return { error: `limit must be 1 to ${ADMIN_PEOPLE_MAX_LIMIT}.` };
  if (rawCursor !== null && rawCursor !== "" && !/^\d{15}-\d{16}$/.test(rawCursor)) return { error: "cursor must be a nextCursor from a previous page." };
  return { limit, after: rawCursor === null || rawCursor === "" ? undefined : rawCursor };
}

/** "$3.99", "$3", "$10": dollars and cents as a client shows them, never rounded to whole dollars. */
export function usdLabel(amount: number): string {
  const cents = Math.round(amount * 100);
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

/**
 * The paid offers, from config (Stripe billing sells them). `price` is the exact text to show
 * ("$3.99/month"), so a client never formats or rounds the number itself; `usdPerWeek` is Pro's
 * weekly GPT-6 budget and `deepseekUsdPerWeek` its DeepSeek one (null: no dollar cap), and
 * `valueLine` one short sentence to show with it. While Pro isn't offered (`proOffered` off) there
 * is no `pro` at all, so clients (Autopilot, dl.new) offer only the top-up; existing subscribers
 * see their plan in `plan` and manage it from the billing portal.
 */
export function offers(config: FreeConfig) {
  const { pro, topup } = config.offers;
  return {
    ...(config.proOffered ? { pro: proOffer(config, pro) } : {}),
    // A dollar top-up: whole units of `unitPriceUsd`, each adding `usageMultiplier` times its price in usage.
    topup: {
      unitPriceUsd: topup.unitPriceUsd,
      minQuantity: topup.minQuantity,
      maxQuantity: topup.maxQuantity,
      usageMultiplier: topup.usageMultiplier,
      validDays: topup.validDays,
      fromPrice: usdLabel(topup.unitPriceUsd * topup.minQuantity),
    },
  };
}

/** Pro as `offers` shows it. */
function proOffer(config: FreeConfig, pro: FreeConfig["offers"]["pro"]) {
  return {
    priceUsdMonthly: pro.priceUsdMonthly,
    price: `${usdLabel(pro.priceUsdMonthly)}/month`,
    tokensPerWeek: pro.tokensPerWeek,
    // Pro's DeepSeek budget (`openModelsMultiplier` times the free one). Pro adds no GPT-6:
    // `usdPerWeek`, the GPT-6 field older clients read, is the free plan's.
    usdPerWeek: config.perPersonWeeklyUsdCap ?? null,
    deepseekUsdPerWeek: proDeepseekWeeklyUsd(config),
    openModelsMultiplier: config.proOpenModelsMultiplier,
    valueLine: pro.valueLine,
  };
}

/** Where [Upgrade] goes outside Autopilot: dl.new/account (the web sign-up's origin), which starts Pro's checkout. */
function upgradeUrl(c: Ctx): string {
  return `${webOrigin(c)}/account`;
}

/**
 * dl Pro's prompt (phase 1) while Pro is offered: `view` is what a refusal or /v1/me carries
 * (`proPrompt`: the exact text, the price, and the Upgrade link), `message` the one-line version.
 * Null while Pro isn't offered (`proOffered` off).
 */
function proPromptFor(c: Ctx, config: FreeConfig, limit?: string): { view: { text: string; price: string; upgradeUrl: string }; message: string } | null {
  if (!config.proOffered) return null;
  const price = `${usdLabel(config.offers.pro.priceUsdMonthly)}/month`;
  const url = upgradeUrl(c);
  return { view: { text: proPromptText(price, limit), price, upgradeUrl: url }, message: proPromptMessage(price, url, limit) };
}

/**
 * The limit a quota refusal hit, by name (messages.ts freeLimitName): the asked pool's weekly
 * tokens (as real tokens at the plan mix) or its family's dollar budget. GPT-6's dollar budget
 * is shared by every GPT-6 model, so it is named "GPT-6".
 */
function refusalLimitName(allowance: Allowance, reason: "tokens" | "spend", family: Family, model: FreeModel, cachedTokenWeight: number): string {
  const modelName = reason === "spend" && family === "gpt6" ? "GPT-6" : planDisplayName(model);
  const counted = allowance.tokensPerWeek;
  return freeLimitName({
    reason,
    modelName,
    tokens: counted === null || counted <= 0 ? null : realFromCounted(counted, cachedTokenWeight),
    usd: allowance.usdPerWeek,
    mixLabel: PLAN_MIX_LABEL,
  });
}

/** Whether a free account's week of open models (DeepSeek) is used up: its dollar budget, or its tokens on a smaller level. */
function openModelsUsedUp(allowance: Allowance): boolean {
  const budget = allowance.budgets.deepseek;
  const pool = allowance.pools.deepseek;
  return (budget.usdPerWeek !== null && budget.spentUsd >= budget.usdPerWeek) || (pool.tokensPerWeek !== null && (pool.remaining ?? 1) <= 0);
}

/** The prompt for an account page or `dl status`: free (not on the trial, not an admin), its open models used up, Pro offered. */
function accountProPrompt(c: Ctx, config: FreeConfig, githubId: number, allowance: Allowance) {
  if (c.config.adminGithubIds.has(githubId) || allowance.plan !== "free" || allowance.trial || !openModelsUsedUp(allowance)) return null;
  return proPromptFor(c, config);
}

/** Counts a step of dl Pro's funnel (pro-funnel.ts), once per person a day; never fails the request. */
async function countPro(c: Ctx, step: ProFunnelStep, githubId: number): Promise<void> {
  if (c.config.adminGithubIds.has(githubId)) return;
  await bestEffort(`pro funnel: ${step} not counted`, () => directory(c).countProStep({ step, githubId, now: c.now() }));
}

function linkFor(config: FreeConfig, person: PersonState | undefined): string | null {
  return person?.referral ? referralLink(config.referralLinkBase, person.referral.code) : null;
}

/**
 * GET /no-github?from=: counts the click and shows the form; POST keeps the answer (no-github.ts).
 * Each counted click and answer emails the owner per noGithubAlerts. Over the per-network limit a
 * GET still shows the page but counts nothing, and a POST gets 429.
 */
async function noGithub(c: Ctx, method: string): Promise<Response> {
  const mode = (await runtime(c)).config.noGithubAlerts;
  if (method === "GET") {
    const source = noGithubSource(c.url.searchParams.get("from"));
    if ((await limited(c, `nogithub:ip:${c.ipNet}`, LIMITS.noGithubClickIp)) === undefined) {
      const now = c.now();
      // The count and the email are best effort: the page must show even if counting fails
      // (right after a deploy the Directory can still run the previous code for a while).
      await bestEffort("no-github: click not counted", async () => {
        const click = await directory(c).noGithubClick({ now, source, mode });
        if (click.email) await alert(c, [noGithubClickAlert(source, now, click)]);
      });
    }
    return shell("No GitHub account?", noGithubBody(source));
  }
  const form = await readForm(c);
  const source = noGithubSource(form.get("from"));
  const parsed = parseNoGithubLead(form);
  if (!parsed.ok) return shell("No GitHub account?", noGithubBody(source, parsed.message, form), 400);
  const retry = await limited(c, `nogithub-lead:ip:${c.ipNet}`, LIMITS.noGithubLeadIp);
  if (retry !== undefined) return donePage("Too many tries", `Too many answers from this network. Try again in ${Math.ceil(retry / 60)} minutes.`, 429);
  const now = c.now();
  // Never the IP: a keyed hash of the network, only to drop the same anonymous answer twice.
  const ipHash = await sha256Hex(`nogithub:${c.config.tokenSigningKey}:${networkOf(c.ip) ?? c.ipNet}`);
  const lead = await bestEffort("no-github: answer not saved", () => directory(c).noGithubLead({ ...parsed, now, source, ipHash, mode }));
  if (!lead) return donePage("Try again", "We couldn't save that just now. Please try again in a minute.", 503);
  if (lead.email) await bestEffort("no-github: answer email failed", () => alert(c, [noGithubLeadAlert(source, now, parsed, lead.repeat, lead)]));
  return parsed.email
    ? donePage("Thanks", "We'll email you when other ways to sign in open. Only about that.")
    : donePage("Thanks", "Thanks for telling us.");
}

/** Runs `work`, logging (never throwing) a failure: undefined if it threw. */
async function bestEffort<T>(label: string, work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work();
  } catch (error) {
    console.error(label, error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

/** A keyed hash of the caller's network (IPv4 address or IPv6 /64), for referral anti-abuse. */
async function networkHash(c: Ctx): Promise<string | undefined> {
  const network = networkOf(c.ip);
  return network ? sha256Hex(`net:${c.config.tokenSigningKey}:${network}`) : undefined;
}

async function isPaused(c: Ctx): Promise<boolean> {
  return c.config.paused || (await runtime(c)).paused;
}

/** The 403 a blocked account gets on chat, refresh, keys and sign-in polling. */
export function blockedError(headers: Record<string, string> = {}): Response {
  return apiError(403, "blocked", BLOCKED_MESSAGE, {}, headers);
}

function pausedError(headers: Record<string, string> = {}): Response {
  return apiError(503, "service_paused", PAUSED_MESSAGE, { reason: "paused", pausedForEveryone: true, resetsAt: null }, headers);
}

// ─── Emails to users (user-email-send.ts) ────────────────────────────────────

/** The provider for codes and transactional emails to users: the USER_EMAIL binding, else Resend, else none. */
export function userEmailVia(c: Pick<Ctx, "env" | "config" | "fetch">): UserEmailTransport | undefined {
  return userEmailTransport(c.env.USER_EMAIL, c.config, c.fetch);
}

/**
 * The providers per class with the runtime `config` (its `broadcastEmailProvider`): bulk mail
 * through Resend beside the binding, everything else as `userEmailVia` (user-email-send.ts).
 */
export function userEmailRoutesVia(c: Pick<Ctx, "env" | "fetch">, config: FreeConfig): UserEmailRoutes {
  return userEmailRoutes(c.env.USER_EMAIL, config, c.fetch);
}

/** Sends one email to a user if it should go. Never throws and never fails the request. */
export async function userEmail(
  c: Ctx,
  config: FreeConfig,
  kind: UserEmailKind,
  githubId: number,
  period: string,
  values: { planWarning?: PlanWarningValues; planWelcome?: PlanWelcomeValues; trial?: TrialEmailValues } = {},
): Promise<"sent" | "failed" | "skipped"> {
  const routes = userEmailRoutesVia(c, config);
  if (!userEmailsOn(config, userEmailRoute(routes, kind).transport)) return "skipped";
  const outcome = await deliverUserEmail({
    store: directory(c) as unknown as UserEmailStore,
    routes,
    config,
    signingKey: await signingKey(c.config),
    base: c.config.publicUrl ?? EMAIL_STOP_BASE,
    kind,
    githubId,
    period,
    now: c.now(),
    ...(values.planWarning ? { planWarning: values.planWarning } : {}),
    ...(values.planWelcome ? { planWelcome: values.planWelcome } : {}),
    ...(values.trial ? { trial: values.trial } : {}),
  });
  logUserEmails(kind, [outcome]);
  return outcome;
}

/**
 * The daily run's emails: last run's failures once more, then "didn't start" and "gone quiet".
 * The runtime setting `userEmails` applies (the admin overrides are read here, as a request would).
 */
async function scheduledUserEmails(env: Env, envConfig: FreeConfig, fetcher: Fetch, now: number, gapMs: number): Promise<void> {
  const transport = userEmailVia({ env, config: envConfig, fetch: fetcher });
  if (!transport) return;
  const store = env.DIRECTORY.getByName("directory");
  const config = applyOverrides(envConfig, await store.overrides());
  if (!userEmailsOn(config, transport)) return;
  const routes = userEmailRoutes(env.USER_EMAIL, config, fetcher);
  const candidates = await store.userEmailCandidates(now);
  const jobs: Array<{ kind: UserEmailKind; githubId: number; period: string; retry?: boolean }> = [
    ...candidates.retries.map((job) => ({ ...job, retry: true })),
    ...candidates.didntStart.map((githubId) => ({ kind: "didnt_start" as const, githubId, period: "" })),
    ...candidates.goneQuiet.map((githubId) => ({ kind: "gone_quiet" as const, githubId, period: "" })),
  ];
  const key = await signingKey(config);
  const outcomes: Array<"sent" | "failed" | "skipped"> = [];
  // The day's budget (email-budget.ts) stops bulk mail short of the transactional reserve.
  for (const job of jobs.slice(0, config.userEmailsDailyMax)) {
    const outcome = await deliverUserEmail({
      store: store as unknown as UserEmailStore,
      routes,
      config,
      signingKey: key,
      base: config.publicUrl ?? EMAIL_STOP_BASE,
      ...job,
      now,
    });
    outcomes.push(outcome);
    if (outcome !== "skipped" && gapMs > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
  }
  logUserEmails("daily", outcomes);
}

/** weekly_reset: sends per run at most (the day's total stays within the email budget's bulk share). */
const WEEKLY_RESET_BATCH = 100;
/** weekly_reset: candidates per Directory call. */
const WEEKLY_RESET_PAGE = 100;

/**
 * One weekly_reset candidate's own weekly tokens, as `dl status` shows them (their limits as their
 * own requests get them, and their Account object's allowance), or why they don't get it.
 */
async function weeklyResetFor(env: Env, config: FreeConfig, candidate: { githubId: number; person: PersonState }, now: number): Promise<number | WeeklyResetSkip> {
  const { githubId, person } = candidate;
  if (person.blocked) return "not_active";
  const trial = onTrial(config, githubId, person.admittedAt);
  const limits = allocated(config, limitsFor(config, person.bonusTokens, person.level, person.batchFlagged, trial, person.trialBonusTokens), githubId, person, now);
  const allowance = await env.ACCOUNT.getByName(accountObjectName(githubId)).allowance(now, limits);
  return weeklyResetTokens(allowance, trial);
}

/** weekly_reset's {tokens}, {grows} and {login} for one person: the invite link's code is their referral code (their login). */
function weeklyResetValues(config: FreeConfig, candidate: { login: string; person: PersonState }, tokens: number): WeeklyResetValues {
  return { tokens, fullTokens: config.weeklyTokens, login: candidate.person.referral?.code ?? candidate.login.toLowerCase() };
}

/**
 * The Monday "tokens reset" email, weekly_reset. Runs from the daily run on Monday (after its
 * other emails) and from the 10-minute ticks after it, Monday and Tuesday (weeklyResetWindow).
 * Each run sends at most WEEKLY_RESET_BATCH, and only while the day's email budget has bulk room
 * (email-budget.ts: never the transactional reserve); it goes through people in github id order and keeps
 * its place in the Directory, so the next run carries on. A day whose pass reached the end is
 * done; Tuesday starts over for anyone Monday's one-a-day cap held back. The user_emails row
 * (kind weekly_reset, period the week's Monday) keeps it to once a week per person. Needs the
 * `userEmails` and `weeklyResetEmail` settings on.
 */
async function scheduledWeeklyReset(env: Env, envConfig: FreeConfig, fetcher: Fetch, now: number, gapMs: number, via: "daily" | "tick"): Promise<void> {
  if (!weeklyResetWindow(now, via)) return;
  const transport = userEmailVia({ env, config: envConfig, fetch: fetcher });
  if (!transport) return;
  const store = env.DIRECTORY.getByName("directory");
  const config = applyOverrides(envConfig, await store.overrides());
  if (!userEmailsOn(config, transport) || !config.weeklyResetEmail) return;
  const routes = userEmailRoutes(env.USER_EMAIL, config, fetcher);
  const day = Math.floor(now / DAY_MS);
  const saved = await store.weeklyResetProgress();
  if (saved && saved.day === day && saved.done) return;
  let after = saved && saved.day === day ? saved.after : 0;
  let room = Math.min(WEEKLY_RESET_BATCH, (await store.emailBudgetToday(now, emailBudgetOf(config))).room[routes.bulkClass]);
  if (room <= 0) return;
  const key = await signingKey(config);
  const policy = policyOf(config);
  const period = String(weekStart(now));
  const outcomes: Array<"sent" | "failed" | "skipped"> = [];
  let done = false;
  while (room > 0) {
    const page = await store.weeklyResetCandidates({ now, after, limit: WEEKLY_RESET_PAGE, policy, adminIds: [...config.adminGithubIds], includeAdmins: config.userEmailsToAdmins });
    if (page.last === null) {
      done = true;
      break;
    }
    for (const candidate of page.people) {
      if (room <= 0) break;
      const tokens = await weeklyResetFor(env, config, candidate, now);
      if (typeof tokens === "number") {
        const outcome = await deliverUserEmail({
          store: store as unknown as UserEmailStore,
          routes,
          config,
          signingKey: key,
          base: config.publicUrl ?? EMAIL_STOP_BASE,
          kind: "weekly_reset",
          githubId: candidate.githubId,
          period,
          now,
          weeklyReset: weeklyResetValues(config, candidate, tokens),
        });
        outcomes.push(outcome);
        if (outcome !== "skipped") {
          room--;
          if (gapMs > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
        }
      }
      after = candidate.githubId;
    }
    // Past admins at the end of the page too, unless the run stopped inside it.
    if (room > 0) after = page.last;
    await store.setWeeklyResetProgress({ day, after, done: false });
  }
  await store.setWeeklyResetProgress({ day, after, done });
  logUserEmails("weekly_reset", outcomes);
}

/** plan_reset: candidates per Directory call. */
const PLAN_RESET_PAGE = 100;

/**
 * The Monday email to paying dl.new accounts, plan_reset ("Your ~62M tokens reset."): last
 * week's tokens per plan model, the caching rate, the counted math, sessions and failovers,
 * the dashboard and the billing links. Same window and switches as weekly_reset (Monday from
 * 01:00 UTC through Tuesday; `userEmails` and `weeklyResetEmail` on), and only once free tokens
 * have ended (`freeEndsAt`): before then the free tier's Monday email covers everyone. Bulk mail:
 * it stops at the day's bulk share (email-budget.ts) and carries on in the next run. Once a week
 * per person (kind plan_reset, period the week's Monday).
 */
async function scheduledPlanReset(env: Env, envConfig: FreeConfig, fetcher: Fetch, now: number, gapMs: number, via: "daily" | "tick"): Promise<void> {
  if (!weeklyResetWindow(now, via)) return;
  const transport = userEmailVia({ env, config: envConfig, fetch: fetcher });
  if (!transport) return;
  const store = env.DIRECTORY.getByName("directory");
  const config = applyOverrides(envConfig, await store.overrides());
  if (!userEmailsOn(config, transport) || !config.weeklyResetEmail || !freeEnded(config.freeEndsAt, now)) return;
  const routes = userEmailRoutes(env.USER_EMAIL, config, fetcher);
  let room = (await store.emailBudgetToday(now, emailBudgetOf(config))).room[routes.bulkClass];
  if (room <= 0) return;
  const key = await signingKey(config);
  const period = String(weekStart(now));
  const lastWeekStart = weekStart(now) - WEEK_MS;
  const outcomes: Array<"sent" | "failed" | "skipped"> = [];
  let after = 0;
  while (room > 0) {
    const page = await store.planResetCandidates({ now, after, limit: PLAN_RESET_PAGE, adminIds: [...config.adminGithubIds], includeAdmins: config.userEmailsToAdmins });
    if (page.last === null) break;
    for (const githubId of page.people) {
      if (room <= 0) break;
      const person = env.ACCOUNT.getByName(accountObjectName(githubId));
      const state = await person.planState(now, []);
      if (state.tier === "none") continue;
      const [lastWeek, sessions] = await Promise.all([person.meters(now, weekStart(now) - 1), store.sessionsBetween(githubId, lastWeekStart, weekStart(now))]);
      const outcome = await deliverUserEmail({
        store: store as unknown as UserEmailStore,
        routes,
        config,
        signingKey: key,
        base: config.publicUrl ?? EMAIL_STOP_BASE,
        kind: "plan_reset",
        githubId,
        period,
        now,
        planReset: planResetValues({ plan: state.tier, lastWeek, config, sessions }),
      });
      outcomes.push(outcome);
      if (outcome !== "skipped") {
        room--;
        if (gapMs > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
      }
    }
    after = page.last;
  }
  logUserEmails("plan_reset", outcomes);
}

/**
 * GET /admin/emails/weekly-reset: a dry run of this week's weekly_reset. Sends nothing and
 * records nothing: who would still get it this week (`count`, of them `belowFull`), who is
 * skipped and why, what already went this week, and 3 rendered samples (with the calling admin's
 * own stop link). Works while the settings are off.
 */
async function adminWeeklyResetPreview(c: Ctx, config: FreeConfig, adminId: number): Promise<Response> {
  const now = c.now();
  const week = weekStart(now);
  const policy = policyOf(config);
  const unsubscribeUrl = await stopUrl(config.publicUrl ?? EMAIL_STOP_BASE, await signingKey(config), adminId);
  const skipped: Record<WeeklyResetSkip, number> = { trial: 0, pro: 0, no_allowance: 0, not_active: 0 };
  const samples: Array<{ githubId: number; login: string; tokens: number; belowFull: boolean; subject: string; body: string }> = [];
  let count = 0;
  let belowFull = 0;
  let after = 0;
  for (;;) {
    const page = await directory(c).weeklyResetCandidates({ now, after, limit: WEEKLY_RESET_PAGE, policy, adminIds: [...c.config.adminGithubIds], includeAdmins: config.userEmailsToAdmins });
    if (page.last === null) break;
    for (const candidate of page.people) {
      const tokens = await weeklyResetFor(c.env, config, candidate, now);
      if (typeof tokens !== "number") {
        skipped[tokens]++;
        continue;
      }
      count++;
      const below = tokens < config.weeklyTokens;
      if (below) belowFull++;
      if (samples.length < 3) {
        const email = renderUserEmail("weekly_reset", { resets: resetsText(weekEnd(now)), unsubscribeUrl, weeklyReset: weeklyResetValues(config, candidate, tokens) });
        samples.push({ githubId: candidate.githubId, login: candidate.login, tokens, belowFull: below, subject: email.subject, body: email.body });
      }
    }
    after = page.last;
  }
  const thisWeek = (await directory(c).weeklyResetCounts(week, week))[0] ?? { sent: 0, failed: 0 };
  return json({
    week: isoDay(week),
    firstWeek: isoDay(WEEKLY_RESET_FIRST_WEEK),
    on: config.weeklyResetEmail,
    emailsOn: config.userEmails,
    provider: userEmailVia(c)?.provider ?? null,
    fullTokens: config.weeklyTokens,
    count,
    belowFull,
    skipped,
    alreadyThisWeek: { sent: thisWeek.sent, failed: thisWeek.failed },
    samples,
  });
}

/**
 * GET /email/stop?u=<github id>&t=<hmac>: a page with one button. POST (the button, or a mail
 * app's one-click List-Unsubscribe-Post) stops every email to users for that person. The HMAC
 * uses the token signing key, so a link can't be made for someone else.
 */
async function emailStop(c: Ctx, method: string): Promise<Response> {
  const raw = c.url.searchParams.get("u") ?? "";
  const githubId = /^[1-9][0-9]{0,15}$/.test(raw) ? Number(raw) : NaN;
  const token = c.url.searchParams.get("t") ?? "";
  if (!Number.isSafeInteger(githubId) || !(await verifyStopToken(await signingKey(c.config), githubId, token))) {
    return donePage("Link not valid", "This link isn't valid. Use the link at the bottom of the email.", 400);
  }
  if (method === "GET") return emailStopPage(`/email/stop?u=${githubId}&t=${encodeURIComponent(token)}`);
  await directory(c).setEmailStop(githubId);
  return donePage("Emails stopped", "You won't get these emails from dl again. You can close this tab.");
}

// ─── Sign-in: the CLI side ──────────────────────────────────────────────────

async function deviceCode(c: Ctx): Promise<Response> {
  if (await isPaused(c)) return pausedError();
  const retry = await limited(c, `device:ip:${c.ipNet}`, LIMITS.deviceCodeIp);
  if (retry !== undefined) return rateLimited(retry);
  const body = (await readJson(c)) ?? {};
  const deviceId = typeof body.device_id === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(body.device_id) ? body.device_id : null;
  const referralCode = normalizeReferralCode(body.referral_code) ?? null;
  const issued = await auth(c).issueDeviceCode({ clientDeviceId: deviceId, referralCode, now: c.now() });
  const verificationUri = `${c.base}/device`;
  return json({
    device_code: issued.deviceCode,
    user_code: issued.userCode,
    verification_uri: verificationUri,
    verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(issued.userCode)}`,
    interval: issued.interval,
    expires_in: Math.round((issued.expiresAt - c.now()) / 1000),
  });
}

const POLL_MESSAGES = {
  pending: ["authorization_pending", "Waiting for you to finish signing in in the browser."],
  slow_down: ["slow_down", "Polling too fast; wait longer between polls."],
  expired: ["expired_token", "The sign-in code expired. Start again."],
  denied: ["access_denied", "Sign-in was cancelled or refused."],
  not_invited: ["not_invited", "This GitHub account isn't on the free tier yet: it needs an invite code, or the current cohort is full."],
} as const;

async function deviceToken(c: Ctx): Promise<Response> {
  const retry = await limited(c, `poll:ip:${c.ipNet}`, LIMITS.pollIp);
  if (retry !== undefined) return rateLimited(retry);
  const body = await readJson(c);
  const code = body?.device_code;
  if (typeof code !== "string" || !code) return apiError(400, "invalid_request", "Send {device_code}.");
  const result = await auth(c).poll(code, c.now());
  if (result.status === "approved") return tokenResponse(c, result, result.refreshToken, result.family);
  const reason = "reason" in result ? result.reason : undefined;
  // Each refusal has its own code; the message is the one the browser page showed.
  if ((result.status === "not_invited" || result.status === "denied") && isSignInRefusal(reason)) {
    const { config } = await runtime(c);
    return apiError(400, reason, signInRefusal(reason, config.minGithubAccountAgeDays).message, { reason });
  }
  if (result.status === "denied" && reason === "service_paused") return apiError(400, "service_paused", PAUSED_MESSAGE, { reason: "paused" });
  if (result.status === "denied" && reason === "blocked") return apiError(403, "blocked", BLOCKED_MESSAGE, { reason: "blocked" });
  const [errorCode, message] = POLL_MESSAGES[result.status];
  const detail = result.status === "denied" && reason === "device_taken" ? DEVICE_TAKEN_MESSAGE : undefined;
  return apiError(400, errorCode, detail ?? message, {
    ...(result.status === "slow_down" ? { interval: result.interval } : {}),
    ...("reason" in result && result.reason ? { reason: result.reason } : {}),
  });
}

async function refresh(c: Ctx): Promise<Response> {
  const retry = await limited(c, `refresh:ip:${c.ipNet}`, LIMITS.refreshIp);
  if (retry !== undefined) return rateLimited(retry);
  const body = await readJson(c);
  const token = body?.refresh_token;
  const invalid = () => apiError(401, "invalid_grant", "The refresh token is invalid, expired or already used. Sign in again.");
  if (typeof token !== "string" || !token) return invalid();
  // A blocked account's refresh token stays unused (no rotation), so an unblock lets it work again.
  const family = await auth(c).familyOf(token);
  if (family && (await directory(c).getPerson(family.githubId))?.status === "blocked") return blockedError();
  const rotated = await auth(c).rotate(token, c.now());
  if (!rotated) return invalid();
  return tokenResponse(c, rotated, rotated.refreshToken, rotated.family);
}

/**
 * Sign-out. Ends the caller's sign-in session: the access token's (when sent as the bearer)
 * and the refresh token's (when sent in the body), which must be the same person's. Refresh
 * then fails, and the session's access tokens stop working at once. Unknown refresh tokens are
 * not an error (RFC 7009 §2.2), so a retried sign-out succeeds.
 */
async function revoke(c: Ctx): Promise<Response> {
  const retry = await limited(c, `refresh:ip:${c.ipNet}`, LIMITS.refreshIp);
  if (retry !== undefined) return rateLimited(retry);
  const body = (await readJson(c)) ?? {};
  const refreshToken = typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : undefined;
  let caller: Caller | undefined;
  if (c.request.headers.has("authorization")) {
    const authenticated = await authenticate(c);
    if (authenticated instanceof Response) {
      if (!refreshToken) return authenticated;
    } else {
      caller = authenticated;
    }
  }
  if (!caller && !refreshToken) return apiError(400, "invalid_request", "Send the access token as the bearer, {refresh_token}, or both.");
  const sessions = new Set<string>();
  let githubId = caller?.githubId;
  if (caller?.sid) sessions.add(caller.sid);
  if (refreshToken) {
    const found = await auth(c).familyOf(refreshToken);
    if (found && (githubId === undefined || found.githubId === githubId)) {
      sessions.add(found.family);
      githubId = found.githubId;
    }
  }
  const sids = [...sessions];
  if (sids.length > 0 && githubId !== undefined) {
    await auth(c).revokeFamilies(sids);
    await account(c, githubId).revokeSessions({ sids, until: c.now() + REVOKED_SESSION_TTL_MS, now: c.now() });
  }
  return json({ revoked: true, sessions: sids.length });
}

// ─── Server keys ────────────────────────────────────────────────────────────

const KEY_NAME = /^[\x20-\x7e]{1,64}$/;
/** API keys (dl_sk_) an account on a dl.new plan may hold: one per tool and machine (cli-login makes one each). */
export const PAID_KEYS_MAX = 10;

export function keyView(key: ServerKeyView) {
  return {
    id: key.id,
    name: key.name,
    kind: key.kind,
    createdAt: new Date(key.createdAt).toISOString(),
    lastUsedAt: key.lastUsedAt === null ? null : new Date(key.lastUsedAt).toISOString(),
    /** A tool key's last tool ("cursor", "opencode"…, tool-keys.ts), null for a server key or one never used. */
    lastTool: key.lastTool,
  };
}

/**
 * Who may create and use server keys: admins, people whose level an admin set (a grant from the
 * Tools tab, an answered /request, a pre-grant), and Pro subscribers. A key spends free tokens
 * with no dl session behind it, so for everyone else it is by request.
 */
async function serverKeysAllowed(c: Ctx, githubId: number, stored: PersonRow | undefined): Promise<boolean> {
  if (c.config.adminGithubIds.has(githubId) || stored?.level_reason === "admin") return true;
  return (await account(c, githubId).plan(c.now())) === "pro";
}

function serverKeysUnavailable(): Response {
  return apiError(403, "server_keys_unavailable", SERVER_KEYS_UNAVAILABLE_MESSAGE);
}

/**
 * Whether an account may make a tool key (tool-keys.ts): in good standing, the people the sign-up
 * checks gave free tokens to. Admins and Pro always; else not blocked (an active account; the
 * account object refuses suspended and blocked ones too) and not below the bar with no free
 * tokens, the way `chat` reads it.
 */
async function toolKeysAllowed(c: Ctx, githubId: number, stored: PersonRow | undefined): Promise<boolean> {
  if (c.config.adminGithubIds.has(githubId)) return true;
  if (!stored || stored.status !== "active") return false;
  if ((await account(c, githubId).plan(c.now())) === "pro") return true;
  const gate = await runtime(c);
  if (!gate.person || gate.person.blocked) return false;
  const level = servedLevel(gate.person.level ?? "full", gate.config);
  const trial = onTrial(gate.config, githubId, gate.person.admittedAt);
  const limits = allocated(gate.config, limitsFor(gate.config, gate.person.bonusTokens, level, gate.person.batchFlagged === true, trial, gate.person.trialBonusTokens), githubId, gate.person, c.now());
  return !(limits.level === "starter" && (limits.levelTokens ?? 0) <= 0);
}

/**
 * POST/GET /v1/keys and DELETE /v1/keys/:id. Managing keys takes a signed-in access token, not a
 * key. Anyone may list and revoke their keys; creating a server key needs `serverKeysAllowed`,
 * a tool key (`{kind: "tool"}`) `toolKeysAllowed` and the `toolKeys` setting on.
 */
async function keys(c: Ctx, rest: string, method: string): Promise<Response> {
  const identity = await authenticate(c);
  if (identity instanceof Response) return identity;
  const guarded = await apiGuard(c, identity);
  if (guarded) return guarded;
  const person = account(c, identity.githubId);
  // Before any runtime(c): it is read once per request, with the caller's state (toolKeysAllowed).
  c.callerId = identity.githubId;

  if (rest === "" && method === "GET") {
    const { config } = await runtime(c);
    return json({ keys: (await person.listKeys()).map(keyView), max: MAX_SERVER_KEYS, maxToolKeys: config.toolKeysMax, toolKeys: config.toolKeys });
  }
  if (rest === "" && method === "POST") {
    const body = await readJson(c);
    const kind = body?.kind === undefined ? "server" : body.kind;
    if (kind !== "server" && kind !== "tool") return apiError(400, "invalid_request", 'Send {name, kind?}: kind is "server" (the default) or "tool".');
    return createKey(c, identity.githubId, body?.name, kind, "dl api-key revoke ID");
  }
  if (/^[a-z0-9]{12}$/.test(rest) && method === "DELETE") {
    if (!(await person.revokeKey(rest))) return apiError(404, "key_not_found", "No key with that id on this account.");
    return json({ id: rest, revoked: true });
  }
  return apiError(404, "not_found", `${method} /v1/keys/${rest} isn't a route.`);
}

/**
 * Makes a key of one kind for an account, with every check POST /v1/keys has (POST /web/keys
 * makes tool keys the same way): the name, who may make one (`toolKeysAllowed` and the `toolKeys`
 * setting for a tool key, `serverKeysAllowed` for a server key), the per-kind limit, the
 * account's state. `revokeHint`: how to revoke one, for the limit's message.
 */
export async function createKey(c: Ctx, githubId: number, rawName: unknown, kind: KeyKind, revokeHint: string, format: KeyFormat = "dlk"): Promise<Response> {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!KEY_NAME.test(name)) return apiError(400, "invalid_request", kind === "tool" ? "Send {name}: 1 to 64 printable characters, e.g. the tool's name." : "Send {name}: 1 to 64 printable characters, e.g. the server's hostname.");
  const person = account(c, githubId);
  const stored = await directory(c).getPerson(githubId);
  let max = MAX_SERVER_KEYS;
  if (kind === "tool") {
    const { config } = await runtime(c);
    // A dl.new plan's keys (dl_sk_) aren't held to the free tier's tool key switch and checks.
    // ... nor are an open no-card trial's (trials.ts).
    const paid = format === "dl_sk" && ((await person.paidPlan(c.now())) !== null || (await person.trialAccess(c.now())));
    if (!paid && !config.toolKeys) return apiError(403, "tool_keys_off", TOOL_KEYS_OFF_MESSAGE);
    if (!paid && stored?.status === "active" && !(await toolKeysAllowed(c, githubId, stored))) return apiError(403, "tool_keys_unavailable", TOOL_KEYS_UNAVAILABLE_MESSAGE);
    max = paid ? Math.max(config.toolKeysMax, PAID_KEYS_MAX) : config.toolKeysMax;
  } else if (stored?.status === "active" && !(await serverKeysAllowed(c, githubId, stored))) {
    return serverKeysUnavailable();
  }
  const created = await person.createKey({ name, now: c.now(), kind, max, format });
  if (created.ok) return json({ ...keyView(created.view), key: created.key }, 201);
  switch (created.code) {
    case "key_limit_reached":
      return kind === "tool"
        ? apiError(409, "key_limit_reached", `This account already has ${max} API keys for other tools. Revoke one first (${revokeHint}).`, { max })
        : apiError(409, "key_limit_reached", `This account already has ${MAX_SERVER_KEYS} server keys. Revoke one first.`, { max: MAX_SERVER_KEYS });
    case "key_name_taken":
      return apiError(409, "key_name_taken", "This account already has a key with that name.");
    case "suspended":
      return apiError(403, "suspended", "This account is suspended from the free tier.");
    case "blocked":
      return blockedError();
    case "not_invited":
      return apiError(403, "not_invited", "This GitHub account isn't on the free tier.");
  }
}

// ─── Sign-in: the browser side ──────────────────────────────────────────────

/** `?ref=<referral code>` is carried through the page to GitHub sign-in. */
async function devicePage(c: Ctx): Promise<Response> {
  const raw = c.url.searchParams.get("user_code");
  const ref = normalizeReferralCode(c.url.searchParams.get("ref") ?? undefined);
  if (!raw) return enterCodePage(undefined, ref);
  const userCode = normalizeUserCode(raw);
  const found = userCode ? await auth(c).lookup(userCode, c.now()) : undefined;
  if (!userCode || !found) return enterCodePage("That code is unknown or has expired. Start sign-in again in your terminal.", ref);
  if (found.status !== "pending") return donePage("Code already used", "This code was already used. Start sign-in again in your terminal if you need to.", 409);
  return confirmPage(userCode, ref);
}

async function deviceAuthorize(c: Ctx): Promise<Response> {
  const userCode = normalizeUserCode(c.url.searchParams.get("user_code") ?? "");
  if (await isPaused(c)) {
    // Tell the waiting terminal too, instead of letting its code run out.
    if (userCode) await auth(c).deny(userCode, c.now(), "service_paused");
    await countRefusal(c, "signin_paused");
    return donePage("Paused", PAUSED_MESSAGE, 503);
  }
  const ref = normalizeReferralCode(c.url.searchParams.get("ref") ?? undefined);
  const begun = userCode ? await auth(c).beginOAuth(userCode, c.now(), ref) : undefined;
  if (!begun) return enterCodePage("That code is unknown, used or expired. Start sign-in again in your terminal.");
  return toGitHub(c, begun);
}

/** The redirect to GitHub for a device code's round trip, with the cookie that binds it to this browser. */
function toGitHub(c: Ctx, begun: { state: string; browser: string }): Response {
  // `user:email` (read-only) prefills the contact email the next step asks for.
  const location = githubAuthorizeUrl({ clientId: c.config.githubClientId }, `${c.base}/device/callback`, begun.state, SIGN_IN_SCOPE);
  return new Response(null, {
    status: 302,
    headers: {
      location,
      "set-cookie": `${OAUTH_COOKIE}=${begun.browser}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

export function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

/**
 * The registered callback, shared by device sign-in and admin dashboard sign-in. The state's
 * stored purpose picks the flow (an unknown state goes to the device flow, which refuses it);
 * each flow then claims the state for its own purpose only, with its own browser cookie.
 */
async function oauthCallback(c: Ctx): Promise<Response> {
  const state = c.url.searchParams.get("state");
  const purpose = state ? await auth(c).oauthPurpose(state, c.now()) : undefined;
  if (purpose === "account") return githubCallback(c);
  return purpose === "admin" ? adminCallback(c, CALLBACK_PATH) : deviceCallback(c);
}

async function deviceCallback(c: Ctx): Promise<Response> {
  const state = c.url.searchParams.get("state");
  const browser = readCookie(c.request, OAUTH_COOKIE);
  const claimed = state && browser ? await auth(c).claimOAuthState(state, browser, c.now()) : undefined;
  if (!claimed) return donePage("Sign-in expired", "This sign-in link is invalid, used or expired. Start again from your terminal.", 400);

  if (c.url.searchParams.get("error")) {
    await auth(c).decide(claimed.deviceRef, "denied", undefined, c.now());
    return donePage("Sign-in cancelled", "GitHub sign-in was cancelled. You can close this tab.");
  }
  const code = c.url.searchParams.get("code");
  const signIn = code
    ? await githubSignInFromCode(
        { clientId: c.config.githubClientId, clientSecret: c.config.githubClientSecret },
        code,
        `${c.base}/device/callback`,
        c.fetch,
        GITHUB_USER_AGENT,
      )
    : undefined;
  if (!signIn) return donePage("GitHub sign-in failed", "GitHub didn't confirm who you are. Open the link from your terminal and try again.", 502);
  const { user } = signIn;

  const identity: Identity = { githubId: user.id, login: user.login };
  const read = await readSignals(c, user, signIn.accessToken);
  // An admin gave this account free tokens before it signed up (grant.ts): Full, the admin's choice.
  const level: SignInLevel = (await directory(c).hasPregrant(user.id)) ? { ...read, level: "full", levelReason: "admin" } : read;
  const person = await directory(c).getPerson(user.id);
  // The details step: the contact email, asked once, and the level's line with an invite field
  // for a basic or Starter account. A returning Full account that already gave an email goes
  // straight through.
  if (person?.status !== "blocked") {
    const below = effectiveLevel(person, level) !== "full";
    if (!person?.email || below) {
      const email = person?.email ?? (await githubPrimaryEmail(signIn.accessToken, c.fetch, GITHUB_USER_AGENT, GITHUB_CHECK_TIMEOUT_MS));
      const details: SignInDetails = { level };
      const issued = await auth(c).decide(claimed.deviceRef, "needs_details", identity, c.now(), undefined, JSON.stringify(details));
      return detailsPage(issued.ticket ?? "", identity.login, {
        ...(email ? { email } : {}),
        updates: person?.email_updates === 1,
        ...(below ? { starter: await levelDetails(c, person, level) } : {}),
      });
    }
  }
  return admitAndFinish(c, claimed.deviceRef, claimed.clientDeviceId, identity, undefined, undefined, undefined, claimed.referralCode ?? undefined, level);
}

/** The GitHub scope device sign-in asks for: read-only email addresses, to prefill the contact email. */
const SIGN_IN_SCOPE = "user:email";

/** What the callback carries to the details step on the device code. */
interface SignInDetails {
  level: SignInLevel;
}

function parseDetails(raw: string | null): SignInDetails {
  try {
    const parsed = JSON.parse(raw ?? "") as SignInDetails;
    if (parsed && typeof parsed === "object" && parsed.level && (parsed.level.level === "full" || parsed.level.level === "basic" || parsed.level.level === "starter")) return parsed;
  } catch {
    // Fall through: an unreadable step is treated as a plain Full sign-in.
  }
  return { level: { level: "full", levelReason: "qualifies" } };
}

/** The level this sign-in will leave the account at: an admin's choice or a redeemed invite stands. */
function effectiveLevel(person: { level: Level; level_reason: LevelReason | null } | undefined, signIn: SignInLevel): Level {
  if (person && (person.level_reason === "admin" || person.level_reason === "invite")) return person.level;
  return signIn.level;
}

/** The details step's line for a basic or Starter account: what it gets, never why. */
async function levelDetails(c: Ctx, person: PersonRow | undefined, signIn: SignInLevel): Promise<{ line: string }> {
  const { config } = await runtime(c);
  const level = servedLevel(effectiveLevel(person, signIn), config);
  if (level === "basic") return { line: basicLine(config.basicWeeklyTokens, config.basicWeeklyUsdCap, config.basicDeepseekWeeklyUsdCap, config.proOffered) };
  const flagged = signIn.batchFlagged === true || person?.batch_flag === 1;
  return { line: starterLine(levelThresholds(config), flagged ? 0 : config.starterWeeklyTokens, config.starterWeeklyUsdCap, config.starterDeepseekWeeklyUsdCap, config.proOffered) };
}

/** The welcome email for the level a new sign-up was admitted at. */
function welcomeKind(level: Level, batchFlagged: boolean, config: FreeConfig, trial = false): UserEmailKind {
  const served = servedLevel(level, config);
  // On the trial, every level with free tokens gets the trial's welcome (no weekly promise).
  if (trial && !noFreeTokens(served, config, batchFlagged)) return "welcome_trial";
  if (served === "full") return "welcome";
  if (served === "basic") return "welcome_basic";
  return noFreeTokens(served, config, batchFlagged) ? "welcome_starter" : "welcome_starter_small";
}

const EMAIL_BLOCKED_MESSAGE = "This email can't be used for the free tier. Use your own API key instead, or write to contact@directionallylocal.com.";
const EMAIL_IN_USE_MESSAGE = "This email is already used by another dl account. Each person gets one free account.";
const DOMAIN_LIMIT_MESSAGE = "Too many new free accounts from this email domain today. Try again tomorrow, or write to contact@directionallylocal.com.";
const EVENT_CODE_INVALID_MESSAGE = "That event code isn't valid, is used up or has expired. Check it with your organizer, or leave it empty to continue.";
const EVENT_CODE_EXISTING_MESSAGE = "Event codes are for new accounts, and this one is already signed up. Leave the code empty to continue.";

/**
 * The level a sign-up with an event code gets: what its own signals give with the creation-batch
 * check left out (a class's GitHub accounts are often made the same week), or Full when the
 * code was made to give Full.
 */
function eventCodeLevel(c: Ctx, config: FreeConfig, signIn: SignInLevel, full: boolean): SignInLevel {
  if (full) return { ...signIn, level: "full", levelReason: "invite", batchFlagged: false };
  if (!signIn.signals || signIn.levelReason === "admin") return { ...signIn, batchFlagged: false };
  const thresholds = levelThresholds(config);
  const checks = levelChecks(signIn.signals, thresholds, signalThresholds(config), { now: c.now(), batchPeers: 0 });
  return { signals: signIn.signals, level: levelFor(checks, signIn.signals, basicRule(config)), levelReason: levelReason(signIn.signals, thresholds, checks), batchFlagged: false };
}

/**
 * POST /device/details: the step after GitHub. Saves the contact email and the updates choice,
 * and redeems an invite code or an event code when a basic or Starter account gives one, then
 * finishes sign-in.
 */
async function deviceDetails(c: Ctx): Promise<Response> {
  const form = await readForm(c);
  const ticket = form.get("ticket") ?? "";
  const found = ticket ? await auth(c).ticket(ticket, c.now(), "needs_details") : undefined;
  if (!found) return donePage("Sign-in expired", "This step expired. Start sign-in again in your terminal.", 400);
  const details = parseDetails(found.details);
  const person = await directory(c).getPerson(found.githubId);
  const starter = effectiveLevel(person, details.level) !== "full" ? await levelDetails(c, person, details.level) : undefined;
  const email = (form.get("email") ?? "").trim();
  const updates = form.get("updates") === "1";
  const typed = starter ? (form.get("invite_code") ?? "").trim() || undefined : undefined;
  // One field takes both kinds of code: `EV-…` is an event code, anything else an invite code.
  const eventCode = typed !== undefined ? normalizeEventCode(typed) : undefined;
  const inviteCode = eventCode === undefined ? typed : undefined;
  const again = (error: string) => detailsPage(ticket, found.login, { email, updates, ...(starter ? { starter } : {}), error });
  if (!plausibleEmail(email)) return again("Enter an email address we can reach you at.");
  const { config: guard } = await runtime(c);
  // An event code: checked before the email rules, since it lifts the per-domain limit.
  let event: { id: number; full: boolean } | undefined;
  if (eventCode !== undefined) {
    if (person) return again(EVENT_CODE_EXISTING_MESSAGE);
    // Only wrong codes count against the network: a whole class enters the same code from one network.
    const attemptKey = `event:ip:${c.ipNet}`;
    const attempts = await c.env.RATE_LIMITER.getByName(attemptKey).check(attemptKey, LIMITS.inviteAttemptIp, 1, c.now());
    if (!attempts.allowed) {
      await countRefusal(c, "invite_rate_limited", found.githubId);
      return again(`Too many wrong codes. Try again in ${Math.ceil((attempts.retryAfterSeconds ?? 3600) / 60)} minutes, or leave the code empty.`);
    }
    const lookup = await directory(c).eventCodeFor(await sha256Hex(eventCode), c.now());
    if (!lookup.ok) {
      await c.env.RATE_LIMITER.getByName(attemptKey).spend(attemptKey, LIMITS.inviteAttemptIp, 1, c.now());
      await countRefusal(c, "event_code_invalid", found.githubId);
      return again(EVENT_CODE_INVALID_MESSAGE);
    }
    event = { id: lookup.id, full: lookup.full };
  }
  // One free account per inbox, no blocked inboxes or domains, and a daily limit per company
  // domain: past it a new account below Full gets in at Starter (or is refused, with
  // domainLimitRefuse). An event code lifts the domain limit, nothing else here.
  const inbox = normalizeEmail(email);
  let domainLimited = false;
  if (!c.config.adminGithubIds.has(found.githubId)) {
    if (emailBlocked(inbox, guard.blockedEmails)) {
      // Blocked as an address, or only through its domain's `@domain` entry.
      await countRefusal(c, emailBlocked(inbox, guard.blockedEmails.filter((entry) => !entry.trim().startsWith("@"))) ? "email_blocked" : "email_domain_blocked", found.githubId);
      return again(EMAIL_BLOCKED_MESSAGE);
    }
    if (await directory(c).emailInUse(inbox, found.githubId)) {
      await countRefusal(c, "email_in_use", found.githubId);
      return again(EMAIL_IN_USE_MESSAGE);
    }
    const domain = emailDomain(inbox);
    if (!person && !event && !PUBLIC_EMAIL_DOMAINS.has(domain) && (await directory(c).domainSignupsSince(domain, c.now() - DAY_MS)) >= guard.domainSignupsPerDay) {
      if (guard.domainLimitRefuse) {
        await countRefusal(c, "email_domain_daily_cap", found.githubId);
        return again(DOMAIN_LIMIT_MESSAGE);
      }
      domainLimited = true;
    }
  }
  if (inviteCode) {
    const retry = await limited(c, `invite:ip:${c.ipNet}`, LIMITS.inviteAttemptIp);
    if (retry !== undefined) {
      await countRefusal(c, "invite_rate_limited", found.githubId);
      return again(`Too many invite attempts. Try again in ${Math.ceil(retry / 60)} minutes, or leave the code empty.`);
    }
  }
  // Like the network limit: an account that qualifies for Full on its own signals stays Full.
  const signedIn: SignInLevel = domainLimited && details.level.level !== "full" ? { ...details.level, level: "starter", levelReason: "domain_limit" } : details.level;
  const level: SignInLevel = inviteCode ? { ...details.level, level: "full", levelReason: "invite" } : event ? eventCodeLevel(c, guard, details.level, event.full) : signedIn;
  const response = await admitAndFinish(c, found.deviceRef, found.clientDeviceId, found, inviteCode, undefined, ticket, found.referralCode ?? undefined, level, {
    onInvalidInvite: () => again("That invite code isn't valid or was already used. Check it, or leave it empty to continue."),
    ...(event ? { eventCodeId: event.id, onInvalidEventCode: () => again(EVENT_CODE_INVALID_MESSAGE) } : {}),
  });
  // Saved for anyone admitted (new or returning); a refusal leaves nothing to save it on.
  const saved = await directory(c).setEmail(found.githubId, email, updates, c.now());
  // The welcome email, for a new sign-up only: nobody was in the Directory before this step.
  // Not for someone still waiting in line for free tokens: the Directory checks.
  if (saved && !person) {
    const config = (await runtime(c)).config;
    // The welcome for the level the person was admitted at (a network limit can lower it).
    const admittedAs = await directory(c).getPerson(found.githubId);
    const kind = welcomeKind(admittedAs?.level ?? level.level, admittedAs ? admittedAs.batch_flag === 1 : level.batchFlagged === true, config, onTrial(config, found.githubId, admittedAs?.admitted_at));
    await userEmail(c, config, kind, found.githubId, "");
  }
  return response;
}

export const GITHUB_USER_AGENT = "directionallylocal-free";

/** The sign-in OAuth app's credentials, for public GitHub reads at the app's rate limit. */
function githubApp(config: FreeConfig): GitHubAppCredentials {
  return { clientId: config.githubClientId, clientSecret: config.githubClientSecret };
}
/** How long the sign-up activity check waits for GitHub's GraphQL API before letting the person through. */
export const GITHUB_CHECK_TIMEOUT_MS = 5000;

/** Why an account needs an invite code even when admission is open. */
type InviteReason = "account_too_new" | "no_github_activity";

function inviteReasonOf(reason: string | null): InviteReason | undefined {
  return reason === "account_too_new" || reason === "no_github_activity" ? reason : undefined;
}

function inviteIntro(reason: InviteReason | undefined, minAccountAgeDays: number): string {
  if (reason === "account_too_new") return tooNewIntro(minAccountAgeDays);
  if (reason === "no_github_activity") return NO_GITHUB_ACTIVITY_INTRO;
  return INVITE_ONLY_INTRO;
}

/**
 * The sign-up GitHub activity check (`requireGithubActivity`): an account passes with at least
 * one public repository (from the /user response already read) or, only when it has none, at
 * least one contribution in the last year (one GraphQL call with the person's own token, which
 * needs no scope). Admins and people already admitted are never checked. It fails open: when
 * GitHub errors or is slow, the person passes, and the outcome is counted (an alert goes out
 * when that happens often in a day).
 */
/**
 * Once a week, a basic or Starter account's public profile is re-read (age, public repositories,
 * followers) and it is promoted (Starter to basic or Full, basic to Full) when it now
 * qualifies. Promotion only, and only for accounts an admin or an invite didn't set. The new
 * level, or undefined when nothing changed.
 */
async function recheckStarter(c: Ctx, identity: Identity, config: FreeConfig): Promise<Level | undefined> {
  const person = await directory(c).getPerson(identity.githubId);
  if (!person || (person.level !== "starter" && person.level !== "basic") || person.level_reason === "admin" || person.level_reason === "invite") return undefined;
  const week = weekStart(c.now());
  // An account placed at Starter by the network or email-domain limit is re-checked soon after
  // sign-in (it may already qualify on its own signals), then on the weekly cadence.
  const since = isSignupLimitReason(person.level_reason) ? c.now() - 60 * 60_000 : week;
  if (person.signals_at !== null && person.signals_at >= since) return undefined;
  const profile = await githubPublicProfile(identity.login, c.fetch, GITHUB_USER_AGENT, GITHUB_CHECK_TIMEOUT_MS, githubApp(c.config));
  if (!profile) return undefined;
  // The public profile, plus what only sign-in can read (contributions and the additional
  // signals) as stored then: no token here.
  const signals: GithubSignals = {
    ...storedSignals(person),
    accountAgeDays: profile.createdAt === undefined ? 0 : Math.max(0, Math.floor((c.now() - profile.createdAt) / DAY_MS)),
    publicRepos: profile.publicRepos ?? 0,
    followers: profile.followers ?? 0,
    createdDay: profile.createdAt === undefined ? person.github_created_day : dayOf(profile.createdAt),
  };
  const after = await directory(c).recheckLevel(identity.githubId, signals, levelThresholds(config), signalThresholds(config), c.now(), basicRule(config));
  return after !== undefined && after !== person.level ? after : undefined;
}

/** The GitHub signals read at sign-in, and the level they give. */
interface SignInLevel {
  signals?: GithubSignals;
  level: Level;
  levelReason: LevelReason;
  /** The creation-batch check flagged the account (below the bar: no free tokens). Never shown. */
  batchFlagged?: boolean;
}

/**
 * Reads the account's GitHub signals with the token sign-in already has (no new scopes) and
 * turns them into a level. Fails open to Full when GitHub can't answer: a real developer
 * shouldn't be punished for GitHub being slow, and the window is short.
 */
async function readSignals(c: Ctx, user: { id: number; createdAt: number | undefined; publicRepos: number | undefined }, accessToken: string): Promise<SignInLevel> {
  const { config } = await runtime(c);
  const thresholds = levelThresholds(config);
  const accountAgeDays = user.createdAt === undefined ? 0 : Math.max(0, Math.floor((c.now() - user.createdAt) / DAY_MS));
  const publicRepos = user.publicRepos ?? 0;
  // Admins are always Full, and so is everyone when the owner turns the activity check off.
  if (c.config.adminGithubIds.has(user.id) || !config.requireGithubActivity) return { level: "full", levelReason: "qualifies" };
  let followers = 0;
  let contributions = 0;
  let restrictedContributions = 0;
  let extra: Pick<GithubSignals, "activeWeeks" | "outsideContributions" | "oldestRepoCreatedAt" | "social"> = {};
  let outcome: GithubCheckOutcome;
  try {
    const read = await githubSignals(accessToken, c.fetch, GITHUB_USER_AGENT, GITHUB_CHECK_TIMEOUT_MS);
    followers = read.followers;
    contributions = read.contributions;
    restrictedContributions = read.restrictedContributions;
    extra = { activeWeeks: read.activeWeeks, outsideContributions: read.outsideContributions, oldestRepoCreatedAt: read.oldestRepoCreatedAt, social: read.social };
    outcome = contributions > 0 ? "contributions" : "none";
  } catch (error) {
    console.warn("GitHub signals read failed open:", error instanceof Error ? error.message : String(error));
    outcome = "error";
  }
  const checkAlert = await directory(c).countGithubCheck(outcome, c.now());
  if (checkAlert) await alert(c, [checkAlert]);
  const createdDay = user.createdAt === undefined ? null : dayOf(user.createdAt);
  const signals: GithubSignals = { accountAgeDays, publicRepos, followers, contributions, restrictedContributions, createdDay, ...extra };
  if (outcome === "error") return { signals, level: "full", levelReason: "qualifies" };
  const rules = signalThresholds(config);
  const [batchPeers, youngAccounts] = await Promise.all([
    directory(c).creationBatchPeers(createdDay, rules.batchWindowDays, user.id),
    directory(c).youngAccounts(dayOf(c.now()) - thresholds.minAccountAgeDays),
  ]);
  const checks = levelChecks(signals, thresholds, rules, { now: c.now(), batchPeers, youngAccounts });
  return { signals, level: levelFor(checks, signals, basicRule(config)), levelReason: levelReason(signals, thresholds, checks), batchFlagged: !checks.full && checks.creationBatch };
}

/**
 * The no-card trial's account check (trial-web.ts), at dl.new's GitHub callback: the free tier's
 * own rules, as a sign-up would meet them. The level from the GitHub signals (account age,
 * activity, the creation-batch check), the per-network sign-up limit (past it, only an account
 * that is Full on its own signals), and whether GitHub failed open. Never throws.
 */
export async function trialAccountCheck(c: Ctx, user: { id: number; createdAt: number | undefined; publicRepos: number | undefined }, accessToken: string): Promise<{ level: Level; levelReason: string; batchFlagged: boolean; networkLimited: boolean; accountAgeDays: number | null }> {
  // The GitHub account's age, for the Free plan's minimum (free-plan.ts); null when GitHub didn't say.
  const accountAgeDays = user.createdAt === undefined ? null : Math.max(0, Math.floor((c.now() - user.createdAt) / DAY_MS));
  try {
    const signIn = await readSignals(c, user, accessToken);
    const { config } = await runtime(c);
    const signupKey = `signup:ip:${c.ipNet}`;
    const signupLimit = { capacity: config.networkSignupsPerDay, perHour: config.networkSignupsPerDay / 24 };
    const left = (await c.env.RATE_LIMITER.getByName(signupKey).check(signupKey, signupLimit, 1, c.now())).allowed;
    return { level: signIn.level, levelReason: signIn.levelReason, batchFlagged: signIn.batchFlagged === true, networkLimited: !left && signIn.level !== "full", accountAgeDays };
  } catch (error) {
    console.warn("trial account check failed open:", error instanceof Error ? error.message : "error");
    return { level: "full", levelReason: "qualifies", batchFlagged: false, networkLimited: false, accountAgeDays };
  }
}

/** Counts a no-card trial against the network's daily sign-ups, as an admission does. */
export async function spendTrialSignup(c: Ctx): Promise<void> {
  const signupKey = `signup:ip:${c.ipNet}`;
  await c.env.RATE_LIMITER.getByName(signupKey).spend(signupKey, LIMITS.signupIp, 1, c.now());
}

/**
 * Runs admission and records the outcome on the device code, then renders the page for it.
 * `inviteCode` is set on the invite step only. With open admission, an account old enough
 * and with some GitHub activity (`inviteReason` undefined) gets in without one (within the
 * per-network sign-up limit and the cohort size).
 */
async function admitAndFinish(
  c: Ctx,
  deviceRef: string,
  clientDeviceId: string | null,
  identity: Identity,
  inviteCode: string | undefined,
  inviteReason: InviteReason | undefined,
  ticket?: string,
  referralCode?: string,
  signIn?: SignInLevel,
  options: { onInvalidInvite?: () => Response; eventCodeId?: number; onInvalidEventCode?: () => Response } = {},
): Promise<Response> {
  const isAdmin = c.config.adminGithubIds.has(identity.githubId);
  const { config } = await runtime(c);
  const signupKey = `signup:ip:${c.ipNet}`;
  const openEligible = config.openAdmission && inviteCode === undefined;
  // An event code's group signs up from one network: the network limit neither applies nor counts them.
  const withEvent = options.eventCodeId !== undefined;
  const signupLimit = { capacity: config.networkSignupsPerDay, perHour: config.networkSignupsPerDay / 24 };
  const signupsLeft = openEligible && !withEvent ? (await c.env.RATE_LIMITER.getByName(signupKey).check(signupKey, signupLimit, 1, c.now())).allowed : true;
  // Beyond the network's daily sign-ups, a non-qualifying account still gets in, as Starter.
  // An account that already qualifies for Full on its own signals stays Full: a shared office,
  // campus or conference network must not downgrade real developers.
  const networkLimited = signIn !== undefined && !signupsLeft && signIn.level !== "full";
  const level: Level = networkLimited ? "starter" : (signIn?.level ?? "full");
  const levelReason: LevelReason = networkLimited ? "network_limit" : (signIn?.levelReason ?? "qualifies");
  const result = await directory(c).admit({
    githubId: identity.githubId,
    login: identity.login,
    isAdmin,
    inviteCode,
    clientDeviceId,
    accountTooNew: false,
    openAdmission: openEligible,
    // With open admission there is no cap on people: the queue keeps free spend in budget.
    inviteOnly: !config.openAdmission,
    maxActive: config.maxActiveUsers,
    referralCode,
    networkHash: await networkHash(c),
    policy: policyOf(config),
    ...(signIn ? { signals: signIn.signals, level, levelReason, batchFlagged: signIn.batchFlagged === true && level !== "full" } : {}),
    starterTokens: config.starterWeeklyTokens > 0,
    ...(withEvent && openEligible ? { eventCodeId: options.eventCodeId } : {}),
    now: c.now(),
  });
  if (result.ok) {
    // The gates a sign-in got through: an invite, a placement below Full, the waitlist.
    if (inviteCode !== undefined) await countRefusal(c, "invite_accepted", identity.githubId);
    if (withEvent && result.created && result.via === "open") await countRefusal(c, "event_code_used", identity.githubId);
    if (result.created && !isAdmin && level !== "full" && (levelReason === "account_too_new" || levelReason === "few_repos_and_contributions" || isSignupLimitReason(levelReason))) {
      await countRefusal(c, levelReason, identity.githubId);
    }
    if (result.queued) await countRefusal(c, "queued", identity.githubId);
    if (result.created && !withEvent && (result.via === "invite" || result.via === "open")) await c.env.RATE_LIMITER.getByName(signupKey).spend(signupKey, LIMITS.signupIp, 1, c.now());
    await account(c, identity.githubId).activate({ githubId: identity.githubId, login: identity.login, isAdmin, now: c.now() });
    // A pre-grant's personal weekly dollar cap, now that the account exists.
    if (result.grantUsdPerWeek !== undefined) await raiseGrantCap(c, identity.githubId, result.grantUsdPerWeek);
    await auth(c).decide(deviceRef, "approved", identity, c.now());
    if (result.queueStarted) await alert(c, [await directory(c).queueStartedAlert(c.now(), policyOf(c.config))]);
    if (result.firstSignup) await alert(c, [result.firstSignup]);
    // A dl.new web sign-up: back to the page with a one-time code instead of "return to your terminal".
    const web = await auth(c).finishWebSignIn(deviceRef, identity, c.now());
    if (web) {
      await countWebStep(c, "signed_in");
      // A sign-in from a tagged link (a blog post's dl.new link): counted under its campaign.
      if (web.campaign) {
        await countCampaignStep(c, web.campaign, "signed_in");
        if (result.created) await countCampaignStep(c, web.campaign, "signed_up");
      }
      return new Response(null, {
        status: 303,
        headers: { location: `${web.returnUrl}#signin=${web.code}`, "cache-control": "no-store", "referrer-policy": "no-referrer" },
      });
    }
    const queued = result.queued ? ` ${QUEUED_SIGNED_IN}` : "";
    const invite =
      config.referralBonusTokens > 0
        ? { link: referralLink(config.referralLinkBase, result.referralCode), bonusTokens: config.referralBonusTokens, capTokens: config.referralBonusCap }
        : undefined;
    return signedInDonePage(`Signed in as ${identity.login}.${queued} Return to your terminal; you can close this tab.`, invite);
  }
  const intro = inviteIntro(inviteReason, config.minGithubAccountAgeDays);
  const refuse = async (code: SignInRefusal, status: "not_invited" | "denied", httpStatus: number) => {
    await countRefusal(c, code === "too_many_signups" ? "network_signup_limit" : code, identity.githubId);
    await auth(c).decide(deviceRef, status, identity, c.now(), code);
    const { heading, message } = signInRefusal(code, config.minGithubAccountAgeDays);
    return donePage(heading, message, httpStatus);
  };
  switch (result.reason) {
    case "needs_invite": {
      await countRefusal(c, inviteReason ?? "invite_required", identity.githubId);
      await countRefusal(c, "invite_page_shown", identity.githubId);
      const issued = await auth(c).decide(deviceRef, "needs_invite", identity, c.now(), inviteReason ?? "invite_required");
      return invitePage(issued.ticket ?? "", identity.login, undefined, intro);
    }
    case "invalid_event_code":
      await countRefusal(c, "event_code_invalid", identity.githubId);
      if (options.onInvalidEventCode) return options.onInvalidEventCode();
      return donePage("Code no longer valid", EVENT_CODE_INVALID_MESSAGE, 400);
    case "invalid_invite":
      await countRefusal(c, "invite_code_invalid", identity.githubId);
      if (options.onInvalidInvite) return options.onInvalidInvite();
      return invitePage(ticket ?? "", identity.login, INVALID_INVITE_MESSAGE, intro);
    case "cohort_full":
      return refuse("cohort_full", "not_invited", 403);
    case "device_taken":
      await countRefusal(c, "device_taken", identity.githubId);
      await auth(c).decide(deviceRef, "denied", identity, c.now(), result.reason);
      return donePage("Can't sign in", DEVICE_TAKEN_MESSAGE, 403);
    case "blocked":
      await countRefusal(c, "blocked", identity.githubId);
      await auth(c).decide(deviceRef, "denied", identity, c.now(), result.reason);
      return donePage("Account blocked", BLOCKED_MESSAGE, 403);
  }
}

async function deviceInvite(c: Ctx): Promise<Response> {
  const form = await readForm(c);
  const ticket = form.get("ticket") ?? "";
  const found = ticket ? await auth(c).ticket(ticket, c.now()) : undefined;
  if (!found) return donePage("Sign-in expired", "This step expired. Start sign-in again in your terminal.", 400);
  const retry = await limited(c, `invite:ip:${c.ipNet}`, LIMITS.inviteAttemptIp);
  if (retry !== undefined) {
    await countRefusal(c, "invite_rate_limited", found.githubId);
    return invitePage(ticket, found.login, `Too many attempts. Try again in ${Math.ceil(retry / 60)} minutes.`);
  }
  const signups = await c.env.RATE_LIMITER.getByName(`signup:ip:${c.ipNet}`).check(`signup:ip:${c.ipNet}`, LIMITS.signupIp, 1, c.now());
  if (!signups.allowed) {
    await countRefusal(c, "network_signup_limit", found.githubId);
    return invitePage(ticket, found.login, "Too many new accounts from this network today. Try again tomorrow.");
  }
  const inviteReason = inviteReasonOf(found.reason);
  const inviteCode = (form.get("invite_code") ?? "").trim();
  if (!inviteCode) return invitePage(ticket, found.login, "Enter an invite code.", inviteIntro(inviteReason, (await runtime(c)).config.minGithubAccountAgeDays));
  return admitAndFinish(c, found.deviceRef, found.clientDeviceId, found, inviteCode, inviteReason, ticket, found.referralCode ?? undefined, { level: "full", levelReason: "invite" });
}

async function deviceNoInvite(c: Ctx): Promise<Response> {
  const form = await readForm(c);
  const ticket = form.get("ticket") ?? "";
  const found = ticket ? await auth(c).ticket(ticket, c.now()) : undefined;
  if (!found) return donePage("Sign-in expired", "This step expired. Start sign-in again in your terminal.", 400);
  const code: SignInRefusal = inviteReasonOf(found.reason) ?? "invite_required";
  await auth(c).decide(found.deviceRef, "not_invited", found, c.now(), code);
  const { heading, message } = signInRefusal(code, (await runtime(c)).config.minGithubAccountAgeDays);
  return donePage(heading, message);
}

async function deviceDeny(c: Ctx): Promise<Response> {
  const form = await readForm(c);
  const userCode = normalizeUserCode(form.get("user_code") ?? "");
  if (userCode) await auth(c).deny(userCode, c.now());
  return donePage("Sign-in cancelled", "Nothing was signed in. You can close this tab.");
}

// ─── Account, models, events ────────────────────────────────────────────────

async function apiGuard(c: Ctx, identity: Identity, headers: () => Promise<Record<string, string>> = async () => ({})): Promise<Response | undefined> {
  const retry =
    (await limited(c, `api:gh:${identity.githubId}`, LIMITS.apiPerson)) ?? (await limited(c, `api:ip:${c.ipNet}`, LIMITS.apiIp));
  return retry === undefined ? undefined : rateLimited(retry, await headers());
}

/**
 * An allowance as /v1/me and the admin API show it. The top-level fields describe the Luna pool
 * and the GPT-6 budget, as older clients read them; `budgets` has both weekly dollar budgets.
 */
function allowanceView(allowance: Allowance) {
  return {
    tokensPerWeek: allowance.tokensPerWeek,
    usedThisWeek: allowance.usedThisWeek,
    remaining: allowance.remaining,
    resetsAt: new Date(allowance.resetsAt).toISOString(),
    usdPerWeek: allowance.budgets.gpt6.usdPerWeek,
    spentUsdThisWeek: allowance.budgets.gpt6.spentUsd,
    budgets: budgetsView(allowance),
  };
}

/**
 * Both weekly dollar budgets: `{gpt6: {usdPerWeek, spentUsd, tokensThisWeek}, deepseek: {...}}`
 * (usdPerWeek null: no cap). `tokensThisWeek` counts every token processed the normal way (prompt
 * with cached, plus completion), not the weighted count the token allowances use.
 */
function budgetsView(allowance: Allowance) {
  const { gpt6, deepseek } = allowance.budgets;
  return {
    gpt6: { usdPerWeek: gpt6.usdPerWeek, spentUsd: gpt6.spentUsd, tokensThisWeek: gpt6.tokensThisWeek },
    deepseek: { usdPerWeek: deepseek.usdPerWeek, spentUsd: deepseek.spentUsd, tokensThisWeek: deepseek.tokensThisWeek },
  };
}

const STATUS_TTL_MS = 30_000;
const STATUS_CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-max-age": "86400" };

/**
 * GET /v1/status, public: whether a new person gets free tokens, a waitlist or a pause (see
 * status.ts). Computed at most once per 30 s per isolate; no amounts or counts in it.
 */
async function status(c: Ctx): Promise<Response> {
  if (c.request.method === "OPTIONS") return new Response(null, { status: 204, headers: STATUS_CORS });
  const retry = await limited(c, `status:ip:${c.ipNet}`, LIMITS.statusIp);
  if (retry !== undefined) return rateLimited(retry, STATUS_CORS);
  const now = c.now();
  if (!c.statusCache.value || now - c.statusCache.at >= STATUS_TTL_MS || now < c.statusCache.at) {
    const gate = await runtime(c);
    c.statusCache.value = freeStatus({
      now,
      paused: gate.paused,
      upstream: chooseUpstream(gate.config.primaryUpstream, c.config),
      creditUsedUsd: gate.creditUsedUsd,
      luminalCreditUsd: gate.config.luminalCreditUsd,
      weekUsd: gate.weekUsd,
      weekCreditUsd: chooseUpstream(gate.config.primaryUpstream, c.config) === "openai" ? gate.openaiWeekCreditUsd : gate.weekCreditUsd,
      waiting: gate.waiting,
      policy: policyOf(gate.config),
      models: offeredModels(gate.config).map((model) => ({ id: model.id, available: modelAvailable(model, gate.config, gate) })),
    });
    c.statusCache.at = now;
  }
  return json(c.statusCache.value, 200, { ...STATUS_CORS, "cache-control": "public, max-age=30" });
}

// ─── Providers: GET /v1/providers, speed probes ─────────────────────────────

const PROVIDERS_TTL_MS = 60_000;
/** Where the website keeps the providers' links tagged. */
const PROVIDER_UTM = "utm_source=dl.new&utm_medium=referral&utm_campaign=providers";

/** GET /v1/providers: the contract dl.new and the clients read. Change it only with them. */
export interface PublicProviders {
  updatedAt: string;
  providers: Array<{
    id: string;
    name: string;
    website: string;
    url: string;
    logo: string;
    models: Array<{
      id: string;
      name: string;
      family: string;
      contextWindow: number;
      access: "free" | "trusted" | "opt-in" | "pro";
      /** The coding agents it can be used in: GPT-6 is ["autopilot"] while `gpt6Clients` is "autopilot". */
      clients: ModelClient[];
      status: "on" | "paused" | "out_of_credit";
      tokensPerSecond: number | null;
      ttftMs: number | null;
      successRate24h: number | null;
      measuredAt: string | null;
      /**
       * The other upstreams that serve this model when this one can't (GLM 5.3 Flash under Liquid
       * Inference: Open Relay), in the order they're tried, each with its own status and measured
       * speed; absent for a model with one upstream. A model is listed once, under its first.
       */
      backups?: Array<{
        provider: string;
        name: string;
        website: string;
        status: "on" | "paused" | "out_of_credit";
        tokensPerSecond: number | null;
        ttftMs: number | null;
        successRate24h: number | null;
        measuredAt: string | null;
      }>;
    }>;
  }>;
}

/**
 * GET /v1/providers, public (no sign-in, CORS *): every provider that has a key, its models that
 * are on, and their measured speed (provider-store.ts modelMeasures: real traffic when there's
 * enough of it, else the speed probes). Computed at most once a minute per isolate, cached a
 * minute by browsers. Never credit amounts, keys, spend or terms: only whether a model serves.
 */
async function providersPublic(c: Ctx): Promise<Response> {
  if (c.request.method === "OPTIONS") return new Response(null, { status: 204, headers: STATUS_CORS });
  const retry = await limited(c, `providers:ip:${c.ipNet}`, LIMITS.statusIp);
  if (retry !== undefined) return rateLimited(retry, STATUS_CORS);
  const now = c.now();
  if (!c.providersCache.value || now - c.providersCache.at >= PROVIDERS_TTL_MS || now < c.providersCache.at) {
    const gate = await runtime(c);
    const measures = await directory(c).providerMeasures(now);
    c.providersCache.value = publicProviders(gate, measures, now);
    c.providersCache.at = now;
  }
  return json(c.providersCache.value, 200, { ...STATUS_CORS, "cache-control": "public, max-age=60" });
}

function publicProviders(gate: Runtime, measures: Record<string, { tokensPerSecond: number | null; ttftMs: number | null; successRate24h: number | null; measuredAt: number | null }>, now: number): PublicProviders {
  const { config } = gate;
  const providers: PublicProviders["providers"] = [];
  for (const spec of PROVIDERS) {
    if (providerKey(config, spec.id) === undefined) continue;
    const settings = providerSettings(config, spec.id);
    // A registry model is listed under the first upstream it's configured on (listedUpstream).
    const models = providerModels(spec.id).filter((model) => (isRegistryProvider(model.provider) ? listedUpstream(config, model) === spec.id : settings.models.includes(model.id)));
    if (models.length === 0) continue;
    providers.push({
      id: spec.id,
      name: spec.name,
      website: spec.website,
      url: `${spec.website}${spec.website.includes("?") ? "&" : "?"}${PROVIDER_UTM}`,
      logo: `/logos/${spec.id}.svg`,
      models: models.map((model) => {
        const measure = measures[measureKey(model.id, spec.id, model.provider)];
        const backups = isRegistryProvider(model.provider) ? configuredUpstreams(config, model).filter((provider) => provider !== spec.id) : [];
        return {
          id: model.id,
          name: model.name,
          family: model.line,
          contextWindow: model.contextWindow,
          access: accessOf(config, model),
          clients: modelClients(model, config.gpt6Clients),
          status: publicStatus(model, gate),
          tokensPerSecond: measure?.tokensPerSecond ?? null,
          ttftMs: measure?.ttftMs ?? null,
          successRate24h: measure?.successRate24h ?? null,
          measuredAt: measure?.measuredAt != null ? new Date(measure.measuredAt).toISOString() : null,
          ...(backups.length > 0 ? { backups: backups.map((provider) => {
            const backup = providerSpec(provider);
            const measured = measures[measureKey(model.id, provider, model.provider)];
            const block = gate.paused ? "paused" : upstreamBlock(config, model, provider, gate.providerSpend);
            return {
              provider,
              name: backup.name,
              website: backup.website,
              status: block === undefined ? ("on" as const) : block === "out_of_credit" ? ("out_of_credit" as const) : ("paused" as const),
              tokensPerSecond: measured?.tokensPerSecond ?? null,
              ttftMs: measured?.ttftMs ?? null,
              successRate24h: measured?.successRate24h ?? null,
              measuredAt: measured?.measuredAt != null ? new Date(measured.measuredAt).toISOString() : null,
            };
          }) } : {}),
        };
      }),
    });
  }
  return { updatedAt: new Date(now).toISOString(), providers };
}

/** "on", "out_of_credit", or "paused" for anything else that stops a model serving everyone. */
function publicStatus(model: FreeModel, gate: Runtime): "on" | "paused" | "out_of_credit" {
  if (gate.paused) return "paused";
  const provider = model.provider as Upstream;
  // A registry model is on while any of its upstreams can serve it (registryRoute).
  if (isRegistryProvider(provider)) {
    const block = registryBlock(gate.config, model, gate.providerSpend);
    return block === undefined ? "on" : block === "out_of_credit" ? "out_of_credit" : "paused";
  }
  if (providerExhausted(provider, gate.config, gate)) return "out_of_credit";
  return providerReady(provider, gate.config, gate) ? "on" : "paused";
}

/** The runway check (runway.ts), on the 10-minute cron: at most one email, of the conditions new today. */
async function runRunway(env: Env, fetcher: Fetch, now: () => number): Promise<void> {
  const config = readFreeConfig(env as unknown as Record<string, unknown>);
  const found = await env.DIRECTORY.getByName("directory").runwayAlerts(now(), policyOf(config));
  if (found) await deliver({ config, env, fetch: fetcher, base: config.publicUrl ?? DEFAULT_PUBLIC_URL, now }, [found]);
}

/** The speed probes' cron run (probes.ts): one probe per model that can serve, recorded in the Directory. */
/** Pruning steps (DirectoryObject.pruneRawLogs, PRUNE_BATCH_ROWS rows of each raw table) at most per 10-minute tick. */
export const PRUNE_STEPS_PER_RUN = 10;

/**
 * Drops raw request log and session events older than `rawLogKeepDays`, a bounded step at a time,
 * each its own short call so requests run in between. At most PRUNE_STEPS_PER_RUN steps a tick:
 * a backlog clears over several ticks.
 */
async function pruneRawLogs(env: Env, now: () => number): Promise<void> {
  const config = readFreeConfig(env as unknown as Record<string, unknown>);
  const directoryStub = env.DIRECTORY.getByName("directory");
  for (let step = 0; step < PRUNE_STEPS_PER_RUN; step++) {
    const result = await directoryStub.pruneRawLogs(now(), config.rawLogKeepDays);
    if (!result.more) return;
  }
}

async function runProbes(env: Env, fetcher: Fetch, now: () => number, at: number): Promise<void> {
  const envConfig = readFreeConfig(env as unknown as Record<string, unknown>);
  const directoryStub = env.DIRECTORY.getByName("directory");
  const gate = await directoryStub.gate(now());
  const config = applyOverrides(envConfig, gate.overrides);
  if (!config.speedProbes || config.paused || gate.paused) return;
  const targets = probeTargets(config, gate.providerSpend, at);
  // One at a time, so no probe's timing includes another's.
  const alerts: Alert[] = [];
  for (const target of targets) alerts.push(...(await directoryStub.recordProbe(await probeOnce(fetcher, config, target, now), policyOf(envConfig))));
  if (alerts.length > 0) await deliver({ config, env, fetch: fetcher, base: config.publicUrl ?? DEFAULT_PUBLIC_URL, now }, alerts);
}

/**
 * GET /v1/me. Besides the allowance (with this week's referral bonus included; `remaining` is
 * 0 while queued): `plan`, `topupTokensLeft`, `queue` (null, or `{position, etaAt}`),
 * `referral` and `offers`. See the README for the exact shapes.
 */
// ─── Paid plans: catalogue, usage, fallback setting (plans.ts, plan-usage.ts) ──

/** Part A's account numbers for accounts made by the paid sign-up start here (CONTRACT.md). */
const PAID_ACCOUNTS_FROM = 2 ** 50;

/**
 * The plan catalogue with the GPT-6 launch bonus's state (`bonus.fullyClaimed`: no room for new
 * subscribers). Part A's pages and Checkout read this (or `planCatalogFor`).
 */
export async function planCatalogFor(c: Ctx) {
  const gate = await runtime(c);
  const status = await directory(c).gpt6BonusStatus(undefined, bonusProjection(gate.config, gate, c.now()));
  return planCatalog(gate.config, status, c.now());
}

/**
 * One account's plan usage this week (plan-usage.ts planUsageView): what the dashboard shows. `at`:
 * a time in an earlier week to read that week's meters instead (this week and the four before it
 * are kept); the plan is today's.
 */
export async function planUsageFor(c: Ctx, githubId: number, at = c.now()) {
  c.callerId ??= githubId;
  const gate = await runtime(c);
  const person = account(c, githubId);
  const [state, meters, bonus] = await Promise.all([
    person.planState(c.now(), PLAN_METER_MODELS),
    person.meters(c.now(), at),
    directory(c).gpt6BonusStatus(githubId, bonusProjection(gate.config, gate, c.now())),
  ]);
  return planUsageView({ state, meters, config: gate.config, bonus, now: at });
}

/**
 * One account's plan bars and GPT-6 launch bonus (`/web/account` `limits` and `gpt6Bonus`,
 * CONTRACT.md): null without a plan or without the bonus.
 */
export async function planAccountFor(c: Ctx, githubId: number, now = c.now()) {
  const gate = await runtime(c);
  const person = account(c, githubId);
  const [state, meters] = await Promise.all([person.planState(now, PLAN_METER_MODELS), person.meters(now)]);
  const bonus = state.tier === "none" ? { granted: false, fullyClaimed: false } : await directory(c).gpt6BonusStatus(githubId, bonusProjection(gate.config, gate, now));
  return {
    state,
    meters,
    limits: planLimitsView({ state, meters, config: gate.config, now }),
    gpt6Bonus: bonusAccountView({ state, meters, config: gate.config, granted: bonus.granted, now }),
  };
}

/**
 * Grants the GPT-6 launch bonus to an account that just started paying, when it is on and a new
 * subscriber still fits the projection (gpt6-bonus.ts): paying users get it right away, so the
 * welcome email can say so. The request-time conditions (Autopilot only, the pre-send guard,
 * the $2/week meter, credit left) still apply to every use. True when the account holds it.
 */
export async function grantLaunchBonus(c: Ctx, githubId: number): Promise<boolean> {
  const gate = await runtime(c);
  const now = c.now();
  if (!gate.config.paidPlans) return false;
  const projection = bonusProjection(gate.config, gate, now);
  const block = bonusBlock({ config: gate.config, paying: true, paidSince: now, agent: undefined, remainingCreditUsd: projection.remainingCreditUsd, now });
  if (block !== undefined && block !== "waiting") return false;
  return (await directory(c).gpt6BonusGrant(githubId, projection)).granted;
}

/** GET /v1/plans: public, like /v1/status. */
async function plansPublic(c: Ctx): Promise<Response> {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET", "cache-control": "public, max-age=60" };
  if (c.request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const [catalog, gate] = await Promise.all([planCatalogFor(c), runtime(c)]);
  // The launch offer, as /web/plans has it: `promo`, and each plan's first-month price while it runs.
  const promo = promoView(gate.config, c.now());
  const plans = catalog.plans.map((plan) => {
    const price = isPlanId(plan.id) ? PLANS[plan.id].priceUsd : undefined;
    return { ...plan, priceUsd: price ?? null, promoPriceUsd: promo.active && price !== undefined && promo.percentOff !== null ? promoPrice(price, promo.percentOff) : null };
  });
  const trials = trialsOffer(gate.config, await directory(c).trialBudgets(gate.config, c.now()));
  return json({ ...catalog, plans, promo, trials }, 200, cors);
}

/** GET /v1/usage: the caller's plan usage this week (a sign-in, a server key or a tool key). */
async function usage(c: Ctx): Promise<Response> {
  const identity = await authenticate(c, { keys: true, toolKeys: true });
  if (identity instanceof Response) return identity;
  const guarded = await apiGuard(c, identity);
  if (guarded) return guarded;
  return json(await planUsageFor(c, identity.githubId));
}

/** POST /v1/plan/fallback {on: boolean}: fall back to DeepSeek at a model's limit (on, the default) or refuse. */
async function planFallback(c: Ctx): Promise<Response> {
  const identity = await authenticate(c, {});
  if (identity instanceof Response) return identity;
  const guarded = await apiGuard(c, identity);
  if (guarded) return guarded;
  const body = await readJson(c);
  if (!body || typeof body.on !== "boolean") return apiError(400, "invalid_request", 'Send {"on": true} or {"on": false}.');
  await account(c, identity.githubId).setPlanFallback(body.on);
  return json({ fallback: body.on });
}

async function me(c: Ctx): Promise<Response> {
  const identity = await authenticate(c, { keys: true, toolKeys: true });
  if (identity instanceof Response) return identity;
  const guarded = await apiGuard(c, identity);
  if (guarded) return guarded;
  c.callerId = identity.githubId;
  const { config, person } = await runtime(c);
  const limits = allocated(config, limitsFor(config, person?.bonusTokens, person?.level ?? "full", person?.batchFlagged === true, onTrial(config, identity.githubId, person?.admittedAt), person?.trialBonusTokens), identity.githubId, person, c.now());
  const allowance = await account(c, identity.githubId).allowance(c.now(), limits);
  if (!allowance.exists) return apiError(403, "not_invited", "This GitHub account isn't on the free tier.");
  // A Pro subscriber isn't waiting for anything; their place is kept if Pro ends.
  const queue = allowance.plan === "pro" ? null : (person?.queue ?? null);
  const view = allowanceView(allowance);
  return json({
    login: identity.login,
    githubId: identity.githubId,
    /** The contact email given at sign-in (the caller's own), or null; dl prefills it in its forms. */
    "email": person?.email ?? null,
    status: allowance.status,
    // No level here: publicly there is only Free and Pro (`plan`). The internal level shows only
    // in the budgets it sets.
    /** The thresholds a Full account must clear, from the effective config. */
    thresholds: levelThresholds(config),
    /** The GitHub signals the level came from, as numbers only. */
    signals: person?.signals ?? null,
    allowance: queue ? { ...view, remaining: 0 } : view,
    /** Both weekly dollar budgets (also in `allowance.budgets`): GPT-6 (every GPT-6 model) and DeepSeek. */
    budgets: view.budgets,
    /**
     * Each model's weekly allowance, so a client can show what each one has left; null tokens: no
     * token cap. `tokensPerWeek`, `usedThisWeek` and `remaining` are counted tokens (cached input
     * at `mix.cachedTokenWeight`); `realTokensPerWeek` and `realUsedThisWeek` are the same as real
     * tokens at the plan mix (`mix.label`), the numbers to show a person.
     */
    pools: Object.fromEntries(
      POOLS.map((pool) => {
        const p = allowance.pools[pool];
        const real = (counted: number) => Math.round(realFromCounted(counted, config.cachedTokenWeight));
        return [
          pool,
          {
            tokensPerWeek: p.tokensPerWeek,
            usedThisWeek: p.usedThisWeek,
            remaining: queue ? 0 : p.remaining,
            realTokensPerWeek: p.tokensPerWeek === null ? null : real(p.tokensPerWeek),
            realUsedThisWeek: real(p.usedThisWeek),
            family: familyOfPool(pool),
            resetsAt: new Date(allowance.resetsAt).toISOString(),
            models: offeredModels(config).filter((model) => model.pool === pool).map((model) => model.id),
          },
        ];
      }),
    ),
    /** How counted tokens become real ones: the plan mix, its label and the cached-token weight. */
    mix: mixView(config.cachedTokenWeight),
    models: offeredModels(config).map((model) => model.id),
    /**
     * The models only dl Pro gets (providers.ts `plans` "pro"), stated upfront: for each, whether
     * this account may use it, its weekly ration in dollars and about how many tokens, and for
     * Pro what is left and when it resets. `text` is one line to show as it is.
     */
    proModels: await proModelsView(c, config, identity.githubId, allowance.plan),
    /**
     * The free models with a weekly cap a person on every plan (GLM 5.3 Flash on Open Relay):
     * the cap in dollars and about how many tokens, what is left and when it resets, the model that
     * serves past it, and one line to show as it is.
     */
    cappedModels: await cappedModelsView(c, config, identity.githubId),
    /** The part of the allowance (0 to 1) other agents launched by dl (dl claude, dl opencode) get; Autopilot gets all of it. */
    otherHarnessShare: config.otherHarnessShare,
    plan: allowance.plan,
    topupTokensLeft: allowance.topupTokensLeft,
    /** Dollar top-ups: usage dollars left and when the soonest-expiring one with usage left ends. */
    topupUsdLeft: allowance.topupUsdLeft,
    topupUsdExpiresAt: allowance.topupUsdExpiresAt === null ? null : new Date(allowance.topupUsdExpiresAt).toISOString(),
    pro: allowance.plan === "pro" || allowance.proPeriodEnd !== null
      ? { periodEnd: allowance.proPeriodEnd === null ? null : new Date(allowance.proPeriodEnd).toISOString(), cancelAtPeriodEnd: allowance.proCancelAtPeriodEnd }
      : null,
    "queue": queue ? { position: queue.position, etaAt: new Date(queue.etaAt).toISOString(), waiting: queue.waiting } : null,
    referral: person?.referral
      ? {
          code: person.referral.code,
          link: linkFor(config, person),
          joined: person.referral.joined,
          activeThisWeek: person.referral.activeThisWeek,
          bonusTokensPerWeek: person.bonusTokens,
          bonusCapPerWeek: config.referralBonusCap,
          /**
           * Whether the referral bonus is added to this account's allowance: only Full-level free
           * accounts get it (levelLimits), never Pro. Clients hide the bonus line when false.
           */
          bonusApplies: allowance.plan !== "pro" && (limits.level ?? "full") === "full",
        }
      : null,
    offers: offers(config),
    /**
     * The one-time trial, for an account admitted at or after the trial cutoff: `{tokens, used,
     * remaining, ended}` (tokens counted as prompt with cached, plus completion, every free model
     * together). Null for everyone else (grandfathered accounts keep the weekly free allowance).
     */
    trial: trialView(allowance),
    /**
     * dl Pro's prompt, when this free account's week of open models is used up and Pro is
     * offered: `{text, price, upgradeUrl}`, else null. `?prompt=shown` (dl status) counts it as seen.
     */
    proPrompt: await (async () => {
      const prompt = queue ? null : accountProPrompt(c, config, identity.githubId, allowance);
      if (prompt && c.url.searchParams.get("prompt") === "shown") await countPro(c, "seen", identity.githubId);
      return prompt?.view ?? null;
    })(),
  });
}

/** /v1/me `proModels`: every offered Pro-only model, with this person's ration. */
async function proModelsView(c: Ctx, config: FreeConfig, githubId: number, plan: Plan) {
  const models = offeredModels(config).filter((model) => proOnly(config, model));
  if (models.length === 0) return [];
  const isAdmin = c.config.adminGithubIds.has(githubId);
  const available = plan === "pro" || isAdmin;
  const weekUsd = available && !isAdmin ? await directory(c).personProviderWeek(githubId, c.now()) : undefined;
  return models.map((model) => {
    const cap = personCapUsd(config, model);
    const approxTokensPerWeek = cap === undefined ? null : approxTokens(model, cap);
    // Admins aren't held to it, so they get no ration.
    const ration = available && !isAdmin ? rationView(config, model, weekUsd, c.now()) : null;
    return {
      id: model.id,
      name: model.name,
      provider: model.provider,
      access: "pro" as const,
      available,
      usdPerWeek: cap ?? null,
      approxTokensPerWeek,
      ration,
      text: proModelText(model, available, approxTokensPerWeek, ration),
    };
  });
}

/** /v1/me `cappedModels`: every offered model with a per-person weekly cap that isn't Pro-only. */
async function cappedModelsView(c: Ctx, config: FreeConfig, githubId: number) {
  const models = offeredModels(config).filter((model) => capped(config, model) && !proOnly(config, model));
  if (models.length === 0) return [];
  const isAdmin = c.config.adminGithubIds.has(githubId);
  const weekUsd = isAdmin ? undefined : await directory(c).personProviderWeek(githubId, c.now());
  return models.map((model) => {
    const cap = personCapUsd(config, model)!;
    const approxTokensPerWeek = approxTokens(model, cap);
    const ration = isAdmin ? null : rationView(config, model, weekUsd, c.now());
    const fallback = model.fallback ? modelById(model.fallback) : undefined;
    const after = fallback ? `then ${fallback.name}` : "then other free models";
    const text = !ration
      ? `${model.name}: free, about ${formatRationTokens(approxTokensPerWeek)} tokens a week, ${after}.`
      : ration.remainingUsd <= 0
        ? `${model.name}: this week's free tokens are used up; ${fallback?.name ?? "other free models"} serves until it resets on ${resetDay(ration.resetsAt)}.`
        : `${model.name}: about ${formatRationTokens(ration.approxTokensLeft)} of ${formatRationTokens(ration.approxTokensPerWeek)} free tokens left this week (resets ${resetDay(ration.resetsAt)}), ${after}.`;
    return {
      id: model.id,
      name: model.name,
      // The upstream it's listed under (GLM 5.3 Flash: Liquid while it's configured, else Open Relay).
      provider: listedUpstream(config, model) ?? model.provider,
      access: accessOf(config, model),
      usdPerWeek: cap,
      approxTokensPerWeek,
      ration,
      fallback: fallback?.id ?? null,
      text,
    };
  });
}

/** The one line /v1/me gives a Pro-only model: the perk for a free account, the ration left for Pro. */
function proModelText(model: FreeModel, available: boolean, approxTokensPerWeek: number | null, ration: ReturnType<typeof rationView>): string {
  const perWeek = approxTokensPerWeek ? `about ${formatRationTokens(approxTokensPerWeek)} tokens a week` : null;
  if (!available) return perWeek ? `${model.name} is a dl Pro perk: ${perWeek}, then DeepSeek.` : `${model.name} is a dl Pro perk.`;
  if (!ration) return `${model.name} is included with dl Pro.`;
  if (ration.remainingUsd <= 0) return `${model.name}: this week's dl Pro ration is used up. It resets on ${resetDay(ration.resetsAt)}; DeepSeek keeps working.`;
  return `${model.name} with dl Pro: about ${formatRationTokens(ration.approxTokensLeft)} of ${formatRationTokens(ration.approxTokensPerWeek)} tokens left this week (resets ${resetDay(ration.resetsAt)}).`;
}

/** `{tokens, used, remaining, ended}` for a trial account, else null. */
function trialView(allowance: Allowance): { tokens: number; used: number; remaining: number; ended: boolean } | null {
  const trial = allowance.trial;
  return trial ? { tokens: trial.tokens, used: Math.min(trial.used, trial.tokens), remaining: Math.max(0, trial.tokens - trial.used), ended: trial.ended } : null;
}

// ─── Billing ────────────────────────────────────────────────────────────────

function billingReady(c: Ctx, product?: Product): Response | undefined {
  const { stripe } = c.config;
  // Pro is priced inline (stripe.ts proPriceData): only the top-up needs a Stripe Price id.
  const price = product === "topup" ? stripe.priceTopup : "n/a";
  if (!stripe.secretKey || !price) return apiError(503, "billing_unavailable", "Paid plans aren't available yet. Your own key and the free tier still work.");
  return undefined;
}

/**
 * POST /v1/billing/checkout {product: "pro" | "topup"} → {url}: a Stripe Checkout page with
 * Stripe Tax and the billing address. Needs a signed-in access token (not a server key).
 */
async function billingCheckout(c: Ctx): Promise<Response> {
  const identity = await authenticate(c);
  if (identity instanceof Response) return identity;
  const guarded = await apiGuard(c, identity);
  if (guarded) return guarded;
  const body = (await readJson(c)) ?? {};
  const product = body.product;
  if (product !== "pro" && product !== "topup") return apiError(400, "invalid_request", 'Send {product: "pro"} or {product: "topup"}.');
  // A top-up's quantity in $1 units (default the minimum); the buyer can still change it on Checkout, within the range.
  const range = c.config.offers.topup;
  const quantity = body.quantity === undefined || body.quantity === null ? range.minQuantity : Number(body.quantity);
  if (product === "topup" && (!Number.isInteger(quantity) || quantity < range.minQuantity || quantity > range.maxQuantity)) {
    return apiError(400, "invalid_request", `quantity must be a whole number from ${range.minQuantity} to ${range.maxQuantity}.`);
  }
  return checkoutFor(c, identity, product, quantity, c.config.stripe);
}

/**
 * The refusal of a new Pro checkout while Pro isn't offered (`proOffered` off): 403
 * pro_not_offered. The top-up and the billing portal still work.
 */
function proNotOffered(): Response {
  return apiError(403, "pro_not_offered", "dl Pro isn't open to new subscribers. A one-time top-up still works: type /upgrade in dl.");
}

/** A Stripe Checkout page for `product`, returning to the URLs in `stripe` (the CLI's, or dl.new's web sign-up). */
async function checkoutFor(c: Ctx, identity: Identity, product: Product, quantity: number, stripe: FreeConfig["stripe"]): Promise<Response> {
  const range = c.config.offers.topup;
  const unavailable = billingReady(c, product);
  if (unavailable) return unavailable;
  const person = account(c, identity.githubId);
  const { config } = await runtime(c);
  const allowance = await person.allowance(c.now(), limitsFor(config));
  if (!allowance.exists) return apiError(403, "not_invited", "This GitHub account isn't on the free tier.");
  if (allowance.status === "blocked") return blockedError();
  if (allowance.status === "suspended") return apiError(403, "suspended", "This account is suspended from the free tier.");
  if (product === "pro" && allowance.plan === "pro") return apiError(409, "already_pro", "This account already has Pro. Manage it from the billing portal.");
  if (product === "pro" && !config.proOffered) return proNotOffered();
  // dl Pro's funnel: an Upgrade click (from Autopilot's /upgrade, the limit's screen, or dl.new).
  if (product === "pro") await countPro(c, "clicked", identity.githubId);
  const billing = await person.billing();
  try {
    const session = await createCheckout(c.fetch, {
      product,
      config: stripe,
      githubId: identity.githubId,
      login: identity.login,
      customerId: billing.customerId,
      idempotencyKey: crypto.randomUUID(),
      proPriceCents: Math.round(config.offers.pro.priceUsdMonthly * 100),
      ...(product === "topup" ? { topup: { quantity, minQuantity: range.minQuantity, maxQuantity: range.maxQuantity } } : {}),
    });
    return json({ url: session.url });
  } catch (error) {
    if (error instanceof StripeError) return apiError(502, "billing_error", "Stripe couldn't start the checkout. Try again in a minute.");
    throw error;
  }
}

/** POST /v1/billing/portal → {url}: Stripe's Customer Portal, for cancelling Pro or changing the card. */
async function billingPortal(c: Ctx): Promise<Response> {
  const identity = await authenticate(c);
  if (identity instanceof Response) return identity;
  const guarded = await apiGuard(c, identity);
  if (guarded) return guarded;
  const unavailable = billingReady(c);
  if (unavailable) return unavailable;
  const billing = await account(c, identity.githubId).billing();
  if (!billing.customerId) return apiError(404, "no_billing_account", "There is nothing to manage yet: this account hasn't bought anything.");
  try {
    return json(await createPortal(c.fetch, { config: c.config.stripe, customerId: billing.customerId }));
  } catch (error) {
    if (isMissingCustomer(error)) return apiError(404, "no_billing_account", "There is nothing to manage yet: this account hasn't bought anything.");
    if (error instanceof StripeError) return apiError(502, "billing_error", "Stripe couldn't open the billing portal. Try again in a minute.");
    throw error;
  }
}

/**
 * POST /v1/billing/webhook: Stripe's events, verified with STRIPE_WEBHOOK_SECRET and handled
 * once per event id. Handled: checkout.session.completed, invoice.paid,
 * invoice.payment_failed, customer.subscription.updated and customer.subscription.deleted;
 * anything else is acknowledged and ignored.
 */
async function billingWebhook(c: Ctx): Promise<Response> {
  const secret = c.config.stripe.webhookSecret;
  if (!secret) return apiError(503, "billing_unavailable", "Billing isn't configured.");
  const raw = await c.request.text();
  const verified = await verifyWebhook(raw, c.request.headers.get("stripe-signature"), secret, c.now());
  if ("error" in verified) return apiError(400, "invalid_signature", `Webhook refused: ${verified.error}.`);
  const { event } = verified;
  if (await directory(c).billingEventSeen(event.id)) return json({ received: true, duplicate: true });
  const outcome = await applyBillingEvent(c, event);
  // The owner's email about dl.new plan money (trial, payment, plan change, cancellation): once per
  // event id, and never fails the webhook (owner-payment-alerts.ts).
  await sendOwnerPaymentAlert(c, event);
  await directory(c).markBillingEvent(event.id, event.type, c.now());
  return json({ received: true, outcome });
}

/** Applies one event. Every step is idempotent on its own, so a retried delivery is harmless. */
async function applyBillingEvent(c: Ctx, event: StripeEvent): Promise<string> {
  // dl.new's plans (paid-web.ts); everything else (dl Pro, top-ups) as before.
  const plan = await applyPlanEvent(c, event);
  if (plan !== undefined) return plan;
  const object = event.data.object;
  const eventAt = event.created;
  const customerId = idOf(object.customer);
  const owner = async (...candidates: unknown[]) => githubIdFrom(...candidates) ?? (customerId ? await directory(c).customerOwner(customerId) : undefined);
  const subscription = async (githubId: number, input: { subscriptionId: string; state: "active" | "past_due" | "canceled"; periodEnd: number | null | undefined; cancelAtPeriodEnd?: boolean }) => {
    const person = account(c, githubId);
    const before = await person.billing();
    const applied = await person.applySubscription({ ...input, ...(customerId ? { customerId } : {}), eventAt });
    if (!applied) return "stale";
    const state = await person.billing();
    // dl Pro's funnel: a cancellation is counted once, when the subscription is first set to end
    // (cancel at period end, from the Customer Portal) or ends without that.
    const ending = (s: { subscriptionId: string | null; proState: string; cancelAtPeriodEnd: boolean }) => s.subscriptionId === input.subscriptionId && (s.proState === "canceled" || s.cancelAtPeriodEnd);
    if (ending(state) && !ending(before)) await countPro(c, "cancelled", githubId);
    await directory(c).mirrorSubscription({ githubId, state: state.proState, periodEnd: state.periodEnd, eventAt });
    return `pro_${input.state}`;
  };

  switch (event.type) {
    case "checkout.session.completed": {
      const githubId = githubIdFrom(object.client_reference_id, object.metadata?.github_id);
      if (githubId === undefined) return "ignored";
      if (customerId) {
        await directory(c).mapCustomer(customerId, githubId);
        await account(c, githubId).setCustomer(customerId);
      }
      const product = object.metadata?.product ?? (object.mode === "subscription" ? "pro" : "topup");
      if (product === "topup") {
        if (object.payment_status !== "paid") return "unpaid";
        const { legacyTokens, usageMultiplier, validDays } = c.config.offers.topup;
        const createdAt = eventAt * 1000;
        const paidCents = cents(object.amount_subtotal ?? object.amount_total);
        if (object.metadata?.topup_kind === "usd") {
          // Usage dollars: what was paid before tax (quantity × the unit price) times the multiplier.
          const usd = topupUsage(paidCents, usageMultiplier);
          if (usd <= 0) return "ignored";
          await account(c, githubId).grantCredit({ id: String(object.id), usd, createdAt, expiresAt: createdAt + validDays * DAY_MS });
          await alert(c, [await directory(c).recordPayment({ id: String(object.id), githubId, kind: "topup", amountCents: paidCents, at: createdAt })].filter(isAlert));
          return "topup_granted";
        }
        // A checkout started under the old token top-up: the tokens it was sold with, for 30 days.
        await account(c, githubId).grantTopup({ id: String(object.id), tokens: legacyTokens, createdAt, expiresAt: createdAt + LEGACY_TOPUP_DAYS * DAY_MS });
        await alert(c, [await directory(c).recordPayment({ id: String(object.id), githubId, kind: "topup", amountCents: paidCents, at: createdAt })].filter(isAlert));
        return "topup_granted";
      }
      const subscriptionId = idOf(object.subscription);
      if (!subscriptionId) return "ignored";
      const outcome = await subscription(githubId, { subscriptionId, state: "active", periodEnd: undefined });
      // dl Pro's funnel: paid (each completed Pro checkout is one event, handled once).
      if (outcome !== "stale") await countPro(c, "paid", githubId);
      return outcome;
    }
    case "invoice.paid":
    case "invoice.payment_failed": {
      const { subscriptionId, metadata } = invoiceSubscription(object);
      if (!subscriptionId) return "ignored";
      const githubId = await owner(metadata.github_id);
      if (githubId === undefined) return "ignored";
      if (event.type === "invoice.payment_failed") return subscription(githubId, { subscriptionId, state: "past_due", periodEnd: undefined });
      const renewal = object.billing_reason === "subscription_cycle";
      await alert(c, [await directory(c).recordPayment({ id: String(object.id), githubId, kind: "pro", amountCents: cents(object.total_excluding_tax ?? object.subtotal ?? object.amount_paid), at: eventAt * 1000, renewal })].filter(isAlert));
      return subscription(githubId, { subscriptionId, state: "active", periodEnd: invoicePeriodEnd(object) });
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const githubId = await owner(object.metadata?.github_id);
      if (githubId === undefined || typeof object.id !== "string") return "ignored";
      return subscription(githubId, {
        subscriptionId: object.id,
        state: event.type === "customer.subscription.deleted" ? "canceled" : proState(object.status),
        periodEnd: periodEnd(object),
        cancelAtPeriodEnd: object.cancel_at_period_end === true,
      });
    }
    default:
      return "ignored";
  }
}

function isAlert(value: Alert | undefined): value is Alert {
  return value !== undefined;
}

function cents(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
}

/**
 * GET /v1/referrals/<code>, public, for the dl.new invite page: 200 {valid: true, login,
 * bonusTokensPerWeek} for an admitted, unsuspended account's code, else 404 {valid: false}.
 * Nothing else: no id, usage or dates. Cacheable for 5 minutes.
 */
async function referralLookup(c: Ctx, raw: string): Promise<Response> {
  const retry = await limited(c, `referral:ip:${c.ipNet}`, LIMITS.referralLookupIp);
  if (retry !== undefined) return rateLimited(retry);
  const cache = { "cache-control": "public, max-age=300" };
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return json({ valid: false }, 404, cache);
  }
  const code = normalizeReferralCode(decoded);
  const owner = code ? await directory(c).referralCodeOwner(code) : undefined;
  if (!owner) return json({ valid: false }, 404, cache);
  return json({ valid: true, login: owner.login, bonusTokensPerWeek: (await runtime(c)).config.referralBonusTokens }, 200, cache);
}

/**
 * The free models this person can use: GPT-6 only for people with a GPT-6 budget (admins,
 * personal grants) who pass the GPT-6 trust gate (gpt6-trust.ts) when it is on. While GPT-6 is
 * paused on the free tier, tools reading this (dl opencode, the unknown-model refusal) offer DeepSeek only.
 */
async function modelsFor(c: Ctx, config: FreeConfig, githubId: number, person: Runtime["person"]): Promise<readonly FreeModel[]> {
  const listed = await modelsByBudget(c, config, githubId, person);
  // A registry provider's model this person can't use now (paused, out of credit, its weekly
  // budget or their opt-in cap used) isn't listed: a request for it gets 402 provider_limit.
  const gate = await runtime(c);
  const isAdmin = c.config.adminGithubIds.has(githubId);
  const personProviderWeekUsd = gate.personProviderWeekUsd ?? (isAdmin || !listed.some((model) => isRegistryProvider(model.provider)) ? undefined : await directory(c).personProviderWeek(githubId, c.now()));
  // A Pro-only provider's models (providers.ts `plans`) aren't listed for a free account.
  const plan = await planForProviders(c, config, githubId, listed);
  return listed.filter((model) => blockFor(model, config, { providerSpend: gate.providerSpend, ...(personProviderWeekUsd ? { personProviderWeekUsd } : {}) }, isAdmin, plan) === undefined);
}

async function modelsByBudget(c: Ctx, config: FreeConfig, githubId: number, person: Runtime["person"]): Promise<readonly FreeModel[]> {
  const offered = offeredModels(config);
  if (c.config.adminGithubIds.has(githubId)) return offered;
  // With the trust gate on, GPT-6 is listed only for trusted people, at the trusted budget.
  const trust = await gpt6TrustFor(c, config, githubId);
  if (trust && !trust.trusted) return offered.filter((model) => model.family !== "gpt6");
  const ownLimits = allocated(config, limitsFor(config, person?.bonusTokens, person?.level ?? "full", person?.batchFlagged === true, onTrial(config, githubId, person?.admittedAt), person?.trialBonusTokens), githubId, person, c.now());
  const allowance = await account(c, githubId).allowance(c.now(), trust?.trusted ? withTrustedGpt6Cap(ownLimits, config) : ownLimits);
  const gpt6 = allowance.budgets.gpt6.usdPerWeek;
  return gpt6 !== null && gpt6 <= 0 ? offered.filter((model) => model.family !== "gpt6") : offered;
}

async function models(c: Ctx): Promise<Response> {
  // OpenCode's harness key may list them too (dl opencode reads the list to configure it).
  const identity = await authenticate(c, { keys: true, toolKeys: true, harness: ["opencode", "pi"] });
  if (identity instanceof Response) return identity;
  const guarded = await apiGuard(c, identity);
  if (guarded) return guarded;
  const { config, person } = await runtime(c);
  // GPT-6 isn't offered to another agent's harness key, or a tool key, while it is Autopilot only (gpt6-clients.ts).
  const harness = otherAgent(identity);
  const isAdmin = c.config.adminGithubIds.has(identity.githubId);
  const listed = (await modelsFor(c, config, identity.githubId, person)).filter((model) => !heldFromClient(model, config.gpt6Clients, harness, isAdmin));
  const weekUsd = listed.some((model) => capped(config, model)) ? await directory(c).personProviderWeek(identity.githubId, c.now()) : undefined;
  return json({
    object: "list",
    data: listed.map((model) => ({
      id: model.id,
      object: "model",
      owned_by: isRegistryProvider(model.provider) ? (listedUpstream(config, model) ?? model.provider) : model.provider,
      name: model.name,
      context_window: model.contextWindow,
      max_output_tokens: model.maxOutputTokens,
      vision: model.vision,
      // "free", "trusted" (GPT-6), "opt-in" (a credit-limited provider, with its own weekly cap)
      // or "pro" (dl Pro only; listed for Pro and admins, never for a free account).
      access: accessOf(config, model),
      // A capped model's weekly ration for this person (Pro-only, or GLM 5.3 Flash's cap), else
      // absent (see /v1/me `proModels` and `cappedModels`).
      ...(capped(config, model) ? { ration: rationView(config, model, weekUsd, c.now()) } : {}),
    })),
  });
}

async function events(c: Ctx): Promise<Response> {
  const identity = await authenticate(c, { keys: true, harness: true });
  if (identity instanceof Response) return identity;
  const guarded = await apiGuard(c, identity);
  if (guarded) return guarded;
  const body = await readJson(c);
  if (!body || !Array.isArray(body.events)) return apiError(400, "invalid_request", "Send {events: [...]}, at most 100.");
  const allowance = await account(c, identity.githubId).allowance(c.now(), limitsFor((await runtime(c)).config));
  if (!allowance.exists) return apiError(403, "not_invited", "This GitHub account isn't on the free tier.");
  const batch = cleanBatch(body, c.now());
  // dl's own session events for another coding agent say which, whatever the body claimed.
  const cleaned = identity.harness ? batch.map((event) => ({ ...event, props: { ...event.props, harness: identity.harness } })) : batch;
  const accepted = await directory(c).recordEvents(identity.githubId, cleaned, c.now());
  return json({ accepted }, 202);
}

// ─── Other coding agents through dl (`dl claude`, `dl opencode`) ────────────

/**
 * Harness keys: what `dl claude` hands Claude Code and `dl opencode` hands OpenCode (see
 * HARNESS_KEY in account-object.ts).
 *
 *   POST   /v1/harness-keys {harness: "claude-code" | "opencode" | "pi"}  → 201 {id, key, harness, expiresAt, ttlSeconds, otherHarnessShare}
 *          (a signed-in access token only: not a server key, not another harness key)
 *   POST   /v1/harness-keys/:id/refresh                → {id, expiresAt}: another HARNESS_KEY_TTL_MS
 *   DELETE /v1/harness-keys/:id                         → {id, revoked: true}
 *
 * Refresh and revoke take the access token or that same harness key, so dl needs the sign-in only
 * to start. A Claude Code key works on /anthropic/v1/messages (and count_tokens), an OpenCode
 * or Pi key on /v1/chat/completions and /v1/models; both on /v1/events, and nowhere else. 403 harness_not_allowed while `allowOtherHarnesses` is off; 409 harness_key_limit past
 * MAX_HARNESS_KEYS running at once.
 */
async function harnessKeys(c: Ctx, rest: string, method: string): Promise<Response> {
  const identity = await authenticate(c, { harness: rest !== "" });
  if (identity instanceof Response) return identity;
  const guarded = await apiGuard(c, identity);
  if (guarded) return guarded;
  const person = account(c, identity.githubId);
  if (rest === "" && method === "POST") {
    if (identity.via !== "access") return apiError(403, "forbidden", "Harness keys are made from a signed-in dl.");
    const body = await readJson(c);
    const harness = body?.harness;
    if (typeof harness !== "string" || !(HARNESSES as readonly string[]).includes(harness)) {
      return apiError(400, "invalid_request", `Send {harness}: one of ${HARNESSES.join(", ")}.`);
    }
    if (!(await runtime(c)).config.allowOtherHarnesses) {
      await countRefusal(c, "harness_not_allowed", identity.githubId, requestClient(harness as string, "harness_not_allowed"));
      return apiError(403, "harness_not_allowed", harnessNotAllowedMessage(harness as Harness));
    }
    const created = await person.createHarnessKey({ harness: harness as Harness, sid: identity.sid, now: c.now() });
    if (created.ok) {
      // otherHarnessShare: this agent's part of the allowance (Autopilot gets all of it); dl says so at start.
      const { otherHarnessShare } = (await runtime(c)).config;
      return json({ id: created.id, key: created.key, harness, expiresAt: new Date(created.expiresAt).toISOString(), ttlSeconds: HARNESS_KEY_TTL_MS / 1000, otherHarnessShare }, 201);
    }
    switch (created.code) {
      case "harness_key_limit":
        return apiError(409, "harness_key_limit", `At most ${MAX_HARNESS_KEYS} ${HARNESS_WORDS[harness as Harness].command} sessions can run at once. Quit one first.`, { max: MAX_HARNESS_KEYS });
      case "blocked":
        return blockedError();
      case "suspended":
        return apiError(403, "suspended", "This account is suspended from the free tier.");
      case "not_invited":
        return apiError(403, "not_invited", "This GitHub account isn't on the free tier.");
    }
  }
  const match = /^([a-z0-9]{12})(\/refresh)?$/.exec(rest);
  if (match) {
    const id = match[1]!;
    // A harness key may refresh or end only itself.
    if (identity.via === "key" || (identity.via === "harness" && identity.harnessKeyId !== id)) return apiError(403, "forbidden", "This key can't manage that harness key.");
    if (match[2] && method === "POST") {
      const expiresAt = await person.refreshHarnessKey(id, c.now());
      if (expiresAt === undefined) return apiError(404, "harness_key_not_found", harnessKeyExpiredMessage(identity.harness));
      return json({ id, expiresAt: new Date(expiresAt).toISOString() });
    }
    if (!match[2] && method === "DELETE") {
      if (!(await person.revokeHarnessKey(id))) return apiError(404, "harness_key_not_found", "No harness key with that id on this account.");
      return json({ id, revoked: true });
    }
  }
  return apiError(404, "not_found", `${method} /v1/harness-keys/${rest} isn't a route.`);
}

/** Copies the quota and retry headers of an answer from `chat` onto an Anthropic-shaped one. */
function passHeaders(from: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of from.headers) if (name.startsWith("x-dl-") || name === "retry-after") out[name] = value;
  return out;
}

/** An Anthropic-shaped error answer. */
function anthropicErrorResponse(status: number, message: string, code?: string, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}): Response {
  return json(anthropicError(status, message, code, extra), status, headers);
}

/** Our `{error: {code, message, ...}}` answer from `chat` (or `authenticate`) → Anthropic's error shape, our message reworded for Claude Code (or, `tool`, for a tool key). */
async function toAnthropicErrorResponse(response: Response, tool = false): Promise<Response> {
  const body = parseJson(await response.text()) as { error?: Record<string, unknown> } | undefined;
  const error = body?.error ?? {};
  const code = typeof error.code === "string" ? error.code : undefined;
  const message = typeof error.message === "string" ? (tool ? forTool(error.message) : forHarness(error.message)) : "The free tier refused the request.";
  const status = errorStatus(response.status, error.retryable === true);
  const extra: Record<string, unknown> = {};
  for (const key of ["resetsAt", "retryAfter", "trial", "share"]) if (error[key] !== undefined) extra[key] = error[key];
  return anthropicErrorResponse(status, message, code, passHeaders(response), extra);
}

/**
 * The Anthropic Messages endpoint for Claude Code through `dl claude` (see anthropic.ts):
 * `POST /anthropic/v1/messages` (Claude Code adds `?beta=true`) and
 * `POST /anthropic/v1/messages/count_tokens`. Auth is a harness key, or a tool key (any
 * Anthropic-style tool, tool-keys.ts), as `x-api-key` or `Authorization: Bearer`. Every request is served by DeepSeek, whatever model it names, and
 * goes through `chat` like any other: the same reservation, caps, trial, Pro, queue, dl-only
 * check and refusals, with the allowance scaled by `otherHarnessShare`.
 */
async function anthropic(c: Ctx, path: string, method: string): Promise<Response> {
  if (method !== "POST" || (path !== "/v1/messages" && path !== "/v1/messages/count_tokens")) {
    return anthropicErrorResponse(404, `${method} /anthropic${path} isn't a route: the free tier serves POST /anthropic/v1/messages.`, "not_found");
  }
  const identity = await authenticate(c, { harness: ["claude-code"], apiKeyHeader: true, keys: true, toolKeys: true });
  if (identity instanceof Response) return toAnthropicErrorResponse(identity);
  const tool = identity.keyKind === "tool";
  if (identity.via !== "harness" && !tool) return anthropicErrorResponse(401, "Use the key dl claude sets (run dl claude), or an API key from dl api-key.", "invalid_token");
  const raw = await c.request.text();
  const bodyBytes = new TextEncoder().encode(raw).length;
  if (bodyBytes > MAX_BODY_BYTES) return anthropicErrorResponse(413, "The request body is larger than 8 MB.", "request_too_large");
  const input = parseJson(raw);
  if (!input || typeof input !== "object" || Array.isArray(input)) return anthropicErrorResponse(400, "The body must be one JSON object.", "invalid_request");
  const request = input as Record<string, unknown>;
  if (path === "/v1/messages/count_tokens") {
    const guarded = await apiGuard(c, identity);
    if (guarded) return toAnthropicErrorResponse(guarded, tool);
    return json({ input_tokens: estimateInputTokens(request) });
  }
  // Claude Code's own model names (claude-*) go to the plan's default model (DeepSeek); an exact
  // open-model id it names (ANTHROPIC_MODEL=moonshotai/kimi-k3.1-pro) is served when the plan has it.
  const model = anthropicModelFor(request.model);
  const translated = toChatRequest(request, { model: model.id, vision: model.vision });
  if (!translated.ok) return anthropicErrorResponse(400, translated.message, "invalid_request");
  const hint = anthropicSessionHint(request);
  const answer = await countedChat(c, identity, await chat(c, { identity, body: translated.body, bodyBytes, ...(hint ? { sessionHint: hint } : {}) }));
  if (answer.status !== 200) return toAnthropicErrorResponse(answer, tool);
  const options = { model: translated.model, thinking: translated.thinking, stopSequences: Array.isArray(translated.body.stop) ? (translated.body.stop as string[]) : [] };
  const headers = passHeaders(answer);
  const contentType = answer.headers.get("content-type") ?? "";
  if (translated.stream && answer.body && contentType.includes("text/event-stream")) {
    return new Response(toAnthropicStream(answer.body, options), { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", ...headers } });
  }
  const completion = parseJson(await answer.text()) as Record<string, unknown> | undefined;
  if (!completion || typeof completion !== "object" || completion.error) {
    // dl's own words for an error body, never the provider's message (upstream-errors.ts).
    const message = completion?.error ? upstreamRefusal(JSON.stringify(completion)).message : "The model provider sent an answer that couldn't be read. Try again.";
    return anthropicErrorResponse(502, message, "upstream_error", headers);
  }
  const message = toAnthropicMessage(completion, options);
  if (!translated.stream) return json(message, 200, headers);
  // A stream was asked for but the upstream answered in one piece: send it as one stream.
  return new Response(messageAsStream(message), { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", ...headers } });
}

/** A whole Anthropic message as its event sequence (for an upstream that didn't stream). */
function messageAsStream(message: Record<string, unknown>): string {
  const lines: string[] = [];
  const send = (name: string, data: Record<string, unknown>) => lines.push(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  const usage = message.usage as Record<string, number>;
  send("message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 } } });
  (message.content as Array<Record<string, unknown>>).forEach((block, index) => {
    if (block.type === "text") {
      send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else if (block.type === "thinking") {
      send("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      send("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } });
      send("content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } });
    } else {
      send("content_block_start", { type: "content_block_start", index, content_block: { ...block, input: {} } });
      send("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    }
    send("content_block_stop", { type: "content_block_stop", index });
  });
  send("message_delta", { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: message.stop_sequence }, usage });
  send("message_stop", { type: "message_stop" });
  return lines.join("");
}

// ─── Access requests ────────────────────────────────────────────────────────

/**
 * POST /v1/access-request {building, link?} → 201 {status: "pending"}; GET → {status, at?}.
 * dl's /request command: any signed-in person who isn't blocked asks for (more) free tokens, or
 * for server keys. Accepts any server key of the account, granted or not. One pending at a time
 * (409 already_pending), not for Full with server keys already (409 already_full), at most
 * ACCESS_REQUESTS_PER_DAY a day (429). What they wrote is user content: stored as plain text and
 * shown only on the admin Tools tab (escaped). Never logged, never in an alert or a metric.
 */
async function accessRequest(c: Ctx, method: string): Promise<Response> {
  // The server_keys_unavailable refusal says to type /request: it works with any key, so it can
  // be typed on the server itself.
  const identity = await authenticate(c, { keys: true, ungrantedKeys: true });
  if (identity instanceof Response) return identity;
  const guarded = await apiGuard(c, identity);
  if (guarded) return guarded;
  c.callerId = identity.githubId;
  const [{ person }, stored] = await Promise.all([runtime(c), directory(c).getPerson(identity.githubId)]);
  if (!stored) return apiError(403, "not_invited", "This GitHub account isn't on the free tier.");
  if (person?.blocked || stored.status === "blocked") return blockedError();
  if (method === "GET") {
    const found = await directory(c).accessRequestStatus(identity.githubId);
    return json(found ? { status: found.status, at: new Date(found.at).toISOString() } : { status: "none" });
  }
  // Full without server keys may still ask: that is how keys are granted.
  if (c.config.adminGithubIds.has(identity.githubId) || (stored.level === "full" && (await serverKeysAllowed(c, identity.githubId, stored)))) {
    return apiError(409, "already_full", "You already have free tokens.");
  }
  if (Number(c.request.headers.get("content-length") ?? 0) > ACCESS_REQUEST_MAX_BYTES) return apiError(400, "invalid_request", ACCESS_REQUEST_USAGE);
  const text = await c.request.text();
  if (new TextEncoder().encode(text).length > ACCESS_REQUEST_MAX_BYTES) return apiError(400, "invalid_request", ACCESS_REQUEST_USAGE);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return apiError(400, "invalid_request", ACCESS_REQUEST_USAGE);
  }
  const parsed = parseAccessRequest(body);
  if (!parsed.ok) return apiError(400, "invalid_request", parsed.message);
  const result = await directory(c).submitAccessRequest({ githubId: identity.githubId, login: identity.login, building: parsed.building, link: parsed.link, now: c.now(), perDay: ACCESS_REQUESTS_PER_DAY });
  if (!result.ok) {
    if (result.reason === "already_pending") return apiError(409, "already_pending", "Your request is already waiting for an answer. You'll get an email when it's granted.");
    return rateLimited(result.retryAfterSeconds ?? 3600);
  }
  // The owner hears who asked and how many wait: never what they wrote. "daily" leaves it to the
  // daily digest, "off" to the admin Tools page. With "each", at most accessRequestEmailsPerDay
  // a UTC day: past that the day's requests are in the daily digest, so a burst can't bury the
  // budget and pause alerts.
  const { config: live } = await runtime(c);
  if (live.accessRequestAlerts === "each" && result.todayCount <= live.accessRequestEmailsPerDay) {
    await alert(c, [accessRequestAlert(identity.login, result.pendingCount, result.todayCount === live.accessRequestEmailsPerDay ? live.accessRequestEmailsPerDay : undefined)]);
  }
  return json({ status: "pending" }, 201);
}

// ─── Feedback ───────────────────────────────────────────────────────────────

/**
 * POST /v1/feedback {message, email?, client?} → {ok: true, replyTo}: one email to the owner
 * (ALERT_EMAIL to ALERT_EMAIL_TO), Reply-To the person when an address is known: the one they
 * gave, else their public GitHub email. Sign-in is optional; a bearer that is sent must be
 * valid (401 otherwise, so the client can refresh). Nothing is stored: not the message, not the
 * address. Limits: 10 an hour per network; signed in, also 5 an hour and 20 a day per person.
 */
async function feedback(c: Ctx): Promise<Response> {
  let sender: Sender | undefined;
  if (c.request.headers.has("authorization")) {
    const identity = await authenticate(c, { keys: true });
    if (identity instanceof Response) return identity;
    sender = { login: identity.login, githubId: identity.githubId };
  }
  if (Number(c.request.headers.get("content-length") ?? 0) > MAX_FEEDBACK_BYTES) return apiError(413, "too_large", "Feedback is at most 5,000 characters.");
  const text = await c.request.text();
  if (new TextEncoder().encode(text).length > MAX_FEEDBACK_BYTES) return apiError(413, "too_large", "Feedback is at most 5,000 characters.");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return apiError(400, "invalid_request", "Send {message, email?, client?} as JSON.");
  const parsed = parseFeedback(body as Record<string, unknown>);
  if (!parsed.ok) return apiError(400, parsed.code, parsed.message);
  const { alertEmailTo, alertEmailFrom } = c.config;
  const binding = c.env.ALERT_EMAIL;
  if (!binding || !alertEmailTo) return apiError(503, "feedback_unavailable", "Feedback can't be sent from this service right now.");

  // The network's key is a salted hash, so the address isn't kept even in the rate limiter.
  const net = await sha256Hex(`feedback:${c.config.tokenSigningKey}:${c.ipNet}`);
  const buckets: Array<[string, Limit]> = [[`feedback:ip:${net}`, LIMITS.feedbackIp]];
  if (sender) buckets.push([`feedback:gh:${sender.githubId}:hour`, LIMITS.feedbackPersonHour], [`feedback:gh:${sender.githubId}:day`, LIMITS.feedbackPersonDay]);
  // Check every bucket before spending any, so a refusal by one doesn't use up the others.
  let retry = 0;
  for (const [key, limit] of buckets) {
    const outcome = await c.env.RATE_LIMITER.getByName(key).check(key, limit, 1, c.now());
    if (!outcome.allowed) retry = Math.max(retry, outcome.retryAfterSeconds);
  }
  if (retry > 0) return rateLimited(retry);
  for (const [key, limit] of buckets) await c.env.RATE_LIMITER.getByName(key).spend(key, limit, 1, c.now());

  const { message, email, client } = parsed.value;
  const looked = email === undefined && sender ? await publicGithubEmail(sender.login, c.fetch, c.now()) : null;
  const replyTo = email ?? looked;
  const mail = feedbackEmail({ message, sender, replyTo, replySource: email ? "given" : looked ? "github" : undefined, client, at: c.now() });
  try {
    await sendEmail(binding, {
      from: alertEmailFrom,
      to: alertEmailTo,
      fromName: "dl feedback",
      subject: mail.subject,
      body: mail.body,
      now: c.now(),
      ...(replyTo ? { replyTo } : {}),
    });
  } catch (error) {
    // The error only: never the message or the address.
    console.error("feedback email failed", error instanceof Error ? error.name : "error");
    return apiError(502, "feedback_failed", "The feedback couldn't be sent. Try again in a minute.");
  }
  // A count for the admin home; the email went, so a failure here doesn't fail the request.
  await directory(c)
    .countFeedback(c.now())
    .catch(() => console.error("feedback count failed"));
  return json({ ok: true, replyTo: replyTo ?? null });
}

/**
 * GET /v1/feedback/reply-address → {email}: the public email on the signed-in person's GitHub
 * profile (null when there's none), so the client can say where replies will go before sending.
 */
async function feedbackReplyAddress(c: Ctx): Promise<Response> {
  const identity = await authenticate(c, { keys: true });
  if (identity instanceof Response) return identity;
  const guarded = await apiGuard(c, identity);
  if (guarded) return guarded;
  const email = await publicGithubEmail(identity.login, c.fetch, c.now());
  return json({ email });
}

/**
 * POST /v1/telemetry/download {route, client} and POST /v1/telemetry/install {os, arch, mode,
 * dlVersion, result, failedStep?, via}: anonymous counts for the install funnel (telemetry.ts).
 * POST /v1/telemetry/gpu {event, gpuVendor?, gpuModel?, gpuVramGb?, gpuCount?, answer?, option?,
 * path?, outcome?, errorType?}: Autopilot's GPU first run before sign-in (events.ts
 * cleanGpuTelemetry; signed in, the same goes to /v1/events as gpu.* events). No sign-in. Each adds one to that day's total for its values; nothing else is kept. The rate
 * limit is per IP, keyed by a hash salted with the signing key and the day, so the address
 * itself is never stored. 204 when counted.
 */
async function telemetry(c: Ctx, kind: "download" | "install" | "gpu"): Promise<Response> {
  const day = Math.floor(c.now() / DAY_MS);
  const ipKey = await sha256Hex(`telemetry:${c.config.tokenSigningKey}:${day}:${c.ipNet}`);
  const retry = await limited(c, `telemetry:${kind}:${ipKey}`, kind === "download" ? LIMITS.telemetryDownloadIp : kind === "gpu" ? LIMITS.telemetryGpuIp : LIMITS.telemetryInstallIp);
  if (retry !== undefined) return rateLimited(retry);
  if (Number(c.request.headers.get("content-length") ?? 0) > MAX_TELEMETRY_BYTES) return apiError(413, "too_large", "A telemetry body is under 1 KB.");
  const text = await c.request.text();
  if (text.length > MAX_TELEMETRY_BYTES) return apiError(413, "too_large", "A telemetry body is under 1 KB.");
  const body = parseJson(text);
  if (kind === "download") {
    const count = cleanDownload(body);
    if (typeof count === "string") return apiError(400, "invalid_request", count);
    await directory(c).countDownload(count, day);
  } else if (kind === "gpu") {
    const count = cleanGpuTelemetry(body);
    if (typeof count === "string") return apiError(400, "invalid_request", count);
    await directory(c).countGpu(count, day);
    await saveEarlyAccessLead(c, body, count);
  } else {
    const count = cleanInstall(body);
    if (typeof count === "string") return apiError(400, "invalid_request", count);
    await directory(c).countInstall(count, day);
  }
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

/**
 * A "yes" to GPU early access may carry an email address (events.ts earlyAccessEmail): kept, apart from
 * the anonymous count, in early_access_leads, one row per inbox and vendor. A malformed or
 * blocked (blockedEmails) address is dropped silently; the count above stands either way. The
 * address is never logged.
 */
async function saveEarlyAccessLead(c: Ctx, body: unknown, count: GpuCount): Promise<void> {
  const email = earlyAccessEmail(body, count);
  if (!email) return;
  const emailNorm = normalizeEmail(email);
  const { blockedEmails } = applyOverrides(c.config, await directory(c).overrides());
  if (emailBlocked(emailNorm, blockedEmails)) return;
  await directory(c).saveEarlyAccessLead({ at: c.now(), vendor: count.gpuVendor, gpuModel: count.gpuModel, vramGb: count.gpuVramGb, email, emailNorm });
}

// ─── Inference ──────────────────────────────────────────────────────────────

/** No `x-dl-tokens-remaining` for a pool without a token cap (DeepSeek): its dollar budget is the limit. */
function quotaHeaders(allowance: Allowance): Record<string, string> {
  const resets = { "x-dl-quota-resets-at": new Date(allowance.resetsAt).toISOString() };
  return allowance.remaining === null ? resets : { "x-dl-tokens-remaining": String(allowance.remaining), ...resets };
}

/**
 * A chat request that arrived in another API's shape (see anthropic.ts): the caller, already
 * authenticated with a harness key, and the request translated to a chat completions body.
 */
interface TranslatedChat {
  identity: Caller;
  body: Record<string, unknown>;
  /** The original body's size: what the prompt estimate is made from. */
  bodyBytes: number;
}

/**
 * `POST /v1/chat/completions`: Autopilot's (a sign-in or a server key), and OpenCode's through
 * `dl opencode` (its harness key). OpenCode's refusals are reworded for it (`forHarness`): dl's
 * slash commands are typed in dl.
 */
async function chatCompletions(c: Ctx): Promise<Response> {
  const identity = await authenticate(c, { keys: true, toolKeys: true, harness: ["opencode", "pi"] });
  if (identity instanceof Response) {
    identity.headers.set("x-dl-quota-resets-at", new Date(weekEnd(c.now())).toISOString());
    return identity;
  }
  const answer = await countedChat(c, identity, await chat(c, { identity }));
  return identity.harness ? rewordedForHarness(answer, identity.harness) : identity.keyKind === "tool" ? reworded(answer, forTool) : answer;
}

/**
 * The agent a caller counts as for GPT-6 and the other agents' share: a harness key's, "tool" for
 * a tool key (tool-keys.ts), undefined for Autopilot (a sign-in token or a server key).
 */
function otherAgent(identity: Caller): string | undefined {
  return identity.via === "harness" ? identity.harness : identity.keyKind === "tool" ? "tool" : undefined;
}

/** Our `{error: {code, message, ...}}` refusal with its message reworded for `harness`; anything else as it is. */
function rewordedForHarness(response: Response, harness: Harness): Promise<Response> {
  return reworded(response, (message) => forHarness(message, harness));
}

/** Our `{error: {code, message, ...}}` refusal with its message passed through `reword`; anything else as it is. */
async function reworded(response: Response, reword: (message: string) => string): Promise<Response> {
  if (response.status < 400 || !(response.headers.get("content-type") ?? "").includes("application/json")) return response;
  const text = await response.text();
  const body = parseJson(text) as { error?: Record<string, unknown> } | undefined;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  if (!body?.error || typeof body.error.message !== "string") return new Response(text, { status: response.status, headers });
  return new Response(JSON.stringify({ ...body, error: { ...body.error, message: reword(body.error.message) } }), { status: response.status, headers });
}

/** Which weekly budgets each other agent may spend: Claude Code through dl is DeepSeek only. */
const HARNESS_FAMILIES: Readonly<Record<Harness, readonly Family[]>> = {
  "claude-code": ["deepseek"],
  opencode: FAMILIES,
  pi: FAMILIES,
};

async function chat(c: Ctx, input: { identity: Caller; body?: Record<string, unknown>; bodyBytes?: number; sessionHint?: string }): Promise<Response> {
  const { identity } = input;
  const translated = input.body ? (input as TranslatedChat) : undefined;
  const person = account(c, identity.githubId);
  const isAdmin = c.config.adminGithubIds.has(identity.githubId);
  if (c.config.paused) return pausedError(quotaHeaders(await person.allowance(c.now(), limitsFor(c.config))));
  c.callerId = identity.githubId;
  const gate = await runtime(c);
  if (gate.person?.blocked) return blockedError();
  // Another coding agent launched by dl (`dl claude`, `dl opencode`): the kill switch, then a smaller share of
  // the allowance (`otherHarnessShare`, applied to the limits below). Admins too: it's a switch.
  const harness = identity.via === "harness" ? identity.harness : undefined;
  if (harness && !gate.config.allowOtherHarnesses) return apiError(403, "harness_not_allowed", harnessNotAllowedMessage(harness));
  // A tool key (tool-keys.ts): any tool, served like another coding agent (`agent` "tool"): GPT-6
  // held back while it is Autopilot only, the other agents' share, a fallback model served
  // rather than refused; its own rate limit below.
  const tool = identity.keyKind === "tool";
  const agent = harness ?? (tool ? "tool" : undefined);
  // A Starter or basic account is re-checked once a week from its public profile, and promoted
  // if it now qualifies. The one move down: a basic account the creation-batch check now flags
  // goes to Starter with no free tokens (directory-object.ts recheckLevel).
  if (gate.person && (gate.person.level === "starter" || gate.person.level === "basic") && !isAdmin) {
    const changed = await recheckStarter(c, identity, gate.config);
    if (changed) gate.person.level = changed;
    if (changed === "starter") gate.person.batchFlagged = true;
  }
  const level = servedLevel(gate.person?.level ?? "full", gate.config);
  const batchFlagged = gate.person?.batchFlagged === true;
  const trial = onTrial(gate.config, identity.githubId, gate.person?.admittedAt);
  const baseLimits = limitsFor(gate.config, gate.person?.bonusTokens, level, batchFlagged, trial, gate.person?.trialBonusTokens);
  // The token allocator (allocator.ts): the start grant, the step reached and this week's grace.
  let fullLimits = allocated(gate.config, baseLimits, identity.githubId, gate.person, c.now());
  let limits: Limits = agent ? { ...fullLimits, harnessShare: gate.config.otherHarnessShare } : fullLimits;
  const allocatorOn = gate.config.allocator === "on" && !isAdmin && !trial && gate.person !== undefined && !gate.person.blocked;
  const link = linkFor(gate.config, gate.person);
  const headers = async () => quotaHeaders(await person.allowance(c.now(), limits));

  const guarded = await apiGuard(c, identity, headers);
  if (guarded) return guarded;
  // Paid plans (plans.ts): the tier, the fallback setting and this week's meters. Admins skip
  // plans; a non-paying account past `freeEndsAt` is refused (the end of free tokens), unless
  // it is on the `freeForever` list (its free allowance and level go on as before).
  let planState: PlanState | undefined = isAdmin ? undefined : await person.planState(c.now(), PLAN_METER_MODELS);
  let paidPlan = gate.config.paidPlans && planState && planState.tier !== "none" ? planState.tier : undefined;
  // A free trial (trials.ts): DeepSeek only, held to the trial's counted tokens. A used no-card
  // trial is refused; a used card trial starts its plan in Stripe now (the first real charge).
  let trialMeter: TrialMeter | undefined = planState?.trial?.active ? planState.trial : undefined;
  if (trialMeter && trialMeter.usedUp) {
    if (trialMeter.kind === "nocard") return apiError(402, "trial_used_up", noCardUsedUpMessage(trialMeter.realLimit), { reason: "trial_used_up", plansUrl: "https://dl.new" }, await headers());
    const converted = await convertTrial(c, identity.githubId);
    if (converted === "declined") return apiError(402, "trial_payment_failed", TRIAL_PAYMENT_FAILED_MESSAGE, { reason: "trial_payment_failed", billingUrl: "https://dl.new/billing" }, await headers());
    if (converted !== "converted") return apiError(503, "trial_converting", TRIAL_CONVERTING_MESSAGE, { retryable: true }, { ...(await headers()), "retry-after": "30" });
    planState = await person.planState(c.now(), PLAN_METER_MODELS);
    paidPlan = gate.config.paidPlans && planState.tier !== "none" ? planState.tier : undefined;
    trialMeter = undefined;
  }
  // dl.new's Free plan (free-plan.ts): no plan, on Free, and the switch on. With the switch off a
  // Free account is refused below like any account without a plan.
  const onFree = !isAdmin && !trialMeter && planState !== undefined && planState.tier === "none" && planState.freePlan && freePlanOn(gate.config);
  // Accounts made by the paid sign-up (part A's account numbers, from 2^50) never had free tokens.
  if (!trialMeter && !onFree && planState && planState.tier === "none" && (freeEndedFor(gate.config, identity.githubId, c.now()) || identity.githubId >= PAID_ACCOUNTS_FROM)) {
    return apiError(402, FREE_ENDED_CODE, FREE_ENDED_MESSAGE, { reason: "free_ended", plansUrl: "https://dl.new" }, await headers());
  }
  // The Free plan's week used up (the 402 with the upgrade line, and free_100 once a week), then
  // its global weekly dollar cap (every Free account together).
  const freeRefusal = async (extraHeaders: Record<string, string>) => {
    if (await person.claimPlanNotice("free:100", c.now())) {
      const task = userEmail(c, gate.config, "free_100", identity.githubId, String(weekStart(c.now())), { trial: freePlanEmailValues({ counted: freePlanCountedLimit(gate.config), config: gate.config }) }).catch(() => "failed");
      if (c.background) c.background(task);
      else await task;
    }
    return apiError(402, "free_plan_limit", freePlanLimitMessage(gate.config.freePlanWeeklyRealTokens, gate.config), { reason: "free_plan_limit", plansUrl: FREE_PLAN_URL, upgrade: { url: FREE_PLAN_URL, line: freeStarterLine(gate.config) }, resetsAt: new Date(weekEnd(c.now())).toISOString() }, extraHeaders);
  };
  let freeMeter: { limit: number; counted: number } | undefined;
  if (onFree && planState) {
    const limit = freePlanCountedLimit(gate.config);
    const counted = planState.counted[DEEPSEEK_MODEL] ?? 0;
    if (counted >= limit) return freeRefusal(await headers());
    if (capacityFull((await directory(c).freePlanWeek(c.now())).usd, gate.config)) {
      return apiError(402, "free_capacity_full", freeCapacityFullMessage(gate.config), { reason: "free_capacity_full", plansUrl: FREE_PLAN_URL, upgrade: { url: FREE_PLAN_URL, line: freeStarterLine(gate.config) }, resetsAt: new Date(weekEnd(c.now())).toISOString() }, await headers());
    }
    freeMeter = { limit, counted };
  }
  if (tool && identity.keyId) {
    const retry = await limited(c, `api:key:${identity.githubId}:${identity.keyId}`, perMinute(Math.max(1, gate.config.toolKeyRequestsPerMinute)));
    if (retry !== undefined) return rateLimited(retry, await headers());
  }
  // Below the bar with no free tokens: say who free tokens are for and how to ask anyway. The
  // refusal is counted per day for the sign-up funnel (ids and days only).
  if (!isAdmin && fullLimits.level === "starter" && (fullLimits.levelTokens ?? 0) <= 0) {
    await directory(c).recordRefusal(identity.githubId, c.now());
    return apiError(403, "below_bar", belowBarLine(levelThresholds(gate.config)), { contact: CREDITS_REQUEST_EMAIL, request: ACCESS_REQUEST_PATH }, await headers());
  }

  let body: Record<string, unknown>;
  let bodyBytes: number;
  if (translated) {
    body = translated.body;
    bodyBytes = translated.bodyBytes;
  } else {
    const raw = await c.request.text();
    bodyBytes = new TextEncoder().encode(raw).length;
    if (bodyBytes > MAX_BODY_BYTES) return apiError(413, "request_too_large", "The request body is larger than 8 MB.", {}, await headers());
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed as Record<string, unknown>;
    } catch {
      return apiError(400, "invalid_request", "The body must be one JSON object.", {}, await headers());
    }
  }
  // A registry provider's model before it has a key or while it's off is as unknown as any other.
  if (!isAllowedModel(body.model) || !offeredModels(gate.config).some((model) => model.id === body.model)) {
    // Only the models this person can use here: DeepSeek, GPT-6 too with a GPT-6 budget and trust.
    const families = harness ? HARNESS_FAMILIES[harness] : FAMILIES;
    const allowed = (await modelsFor(c, gate.config, identity.githubId, gate.person))
      .filter((model) => families.includes(model.family) && !heldFromClient(model, gate.config.gpt6Clients, agent, isAdmin))
      .map((model) => model.id);
    return apiError(400, "model_not_allowed", `The free tier serves ${allowed.join(", ")} only.`, { allowed }, await headers());
  }
  let requested = modelById(body.model)!;
  // What the client asked for, whatever serves (a plan's fallback, a provider's failover).
  const asked = requested;
  // Claude Code gets DeepSeek only; OpenCode and Pi, every model.
  if (harness && !HARNESS_FAMILIES[harness].includes(requested.family)) {
    return apiError(400, "model_not_allowed", `Claude Code through dl is served by ${DEEPSEEK_MODEL} only.`, { allowed: [DEEPSEEK_MODEL] }, await headers());
  }
  // GPT-6 in Autopilot only (gpt6Clients "autopilot", gpt6-clients.ts): another agent's harness
  // key gets the provider limit's shape pointing at DeepSeek. Admins pass, for testing.
  if (heldFromClient(requested, gate.config.gpt6Clients, agent, isAdmin)) {
    return apiError(
      402,
      "provider_limit",
      AUTOPILOT_ONLY_MESSAGE,
      { family: requested.family, provider: requested.provider, reason: AUTOPILOT_ONLY_REASON, resetsAt: null, alternative: DEEPSEEK_MODEL, clients: ["autopilot"] },
      await headers(),
    );
  }
  // A paid plan (plans.ts, plan-route.ts): the model that serves and the meter it's held to, a
  // fallback to DeepSeek at a model's limit (with its notice), or the plan's refusal. The
  // provider's per-person caps (Pro's ration) don't apply: the plan's meter replaces them.
  let planServe: PlanServe | undefined;
  const deepseekAvailable = () => modelAvailable(modelById(DEEPSEEK_MODEL)!, gate.config, gate);
  if (trialMeter) {
    // The trial serves DeepSeek V4.1 Flash only: any other model falls back to it with a notice
    // ("Kimi K3.1 starts when your plan starts."), whatever the fallback setting says.
    const notices: string[] = [];
    if (requested.id !== DEEPSEEK_MODEL) {
      const trialPlan = trialMeter.kind === "card" && isPaidPlan(trialMeter.plan) ? trialMeter.plan : undefined;
      const inPlan = trialPlan !== undefined && (planLimitFor(trialPlan, requested.id, gate.config) !== undefined || requested.id === BONUS_MODEL);
      notices.push(inPlan ? startsWithPlanNotice(requested.id === BONUS_MODEL ? "The GPT-6 launch bonus" : planDisplayName(requested)) : notInTrialNotice(planDisplayName(requested)));
    }
    planServe = {
      kind: "serve",
      model: DEEPSEEK_MODEL,
      meter: { kind: "trial", model: DEEPSEEK_MODEL, limit: trialMeter.limit, cachedTokenWeight: gate.config.cachedTokenWeight },
      view: undefined,
      notices,
      fellBack: requested.id !== DEEPSEEK_MODEL,
      bonus: false,
    };
    requested = modelById(DEEPSEEK_MODEL)!;
  } else if (freeMeter) {
    // The Free plan serves DeepSeek V4.1 Flash only: any other model falls back to it with a
    // notice ("Kimi K3.1 isn't on the Free plan."), held to the week's counted cap.
    planServe = {
      kind: "serve",
      model: DEEPSEEK_MODEL,
      meter: { kind: "tokens", model: DEEPSEEK_MODEL, limit: freeMeter.limit, cachedTokenWeight: gate.config.cachedTokenWeight },
      view: undefined,
      notices: requested.id !== DEEPSEEK_MODEL ? [notOnFreeNotice(planDisplayName(requested))] : [],
      fellBack: requested.id !== DEEPSEEK_MODEL,
      bonus: false,
    };
    requested = modelById(DEEPSEEK_MODEL)!;
  } else if (paidPlan && planState) {
    const routed = await planRoute({
      plan: paidPlan,
      state: planState,
      requested,
      agent,
      config: gate.config,
      deepseekAvailable: deepseekAvailable(),
      gate,
      grantBonus: (projection) => directory(c).gpt6BonusGrant(identity.githubId, projection),
      now: c.now(),
    });
    if (routed.kind === "refuse") return apiError(routed.status, routed.code, routed.message, routed.details, await headers());
    planServe = routed;
    requested = modelById(routed.model)!;
  }
  // A registry provider's model (providers.ts) that can't serve this person now: the GPT-6
  // limit's shape, pointing at DeepSeek. Out of credit, paused, its weekly budget or the
  // person's opt-in cap; checked before anything is reserved or sent.
  // A Pro-only provider (`provider<Plans>.<id>` "pro") refuses a free account (reason pro_only)
  // with the Upgrade link, and holds Pro to its weekly ration (person_cap, with the reset day).
  // A model with a fallback (GLM 5.3 Flash → DeepSeek) past its provider's credit or weekly
  // budget, or the person's cap: Autopilot gets the 402 below and switches itself (with its own
  // line); another agent launched by dl can't, so its fallback serves the request instead, with
  // `x-dl-fallback` and the reason in `x-dl-notice`.
  // GLM 5.3 Flash has two upstreams (Liquid, then Open Relay): it's blocked only when neither can
  // serve; the block names the upstream it is about. Its Pro-only rule and person cap are its own.
  const providerPlan = planServe ? "pro" : await planForProviders(c, gate.config, identity.githubId, [requested]);
  const route = routeFor(requested, gate.config, planServe ? { ...gate, personProviderWeekUsd: {} } : gate, isAdmin, providerPlan);
  const block = route.block;
  let effective = requested;
  let fallbackNotice: string | undefined;
  if (block) {
    const spec = providerSpec(route.blockProvider ?? (requested.provider as RegistryProviderId));
    const cap = personCapUsd(gate.config, requested);
    const resetsAt = block === "weekly_budget" || block === "person_cap" ? new Date(weekEnd(c.now())).toISOString() : null;
    const backup = requested.fallback ? modelById(requested.fallback) : undefined;
    if (agent && backup && FALLBACK_BLOCKS.includes(block) && modelAvailable(backup, gate.config, gate)) {
      effective = backup;
      const approx = cap !== undefined ? approxTokens(requested, cap) : undefined;
      fallbackNotice = providerFallbackNotice(requested, block, spec.name, backup.name, { resetsAt, ...(approx !== undefined ? { approxTokensPerWeek: approx } : {}) });
    }
  }
  if (block && effective === requested) {
    const spec = providerSpec(route.blockProvider ?? (requested.provider as RegistryProviderId));
    const plans = modelPlans(gate.config, requested);
    const cap = personCapUsd(gate.config, requested);
    const resetsAt = block === "weekly_budget" || block === "person_cap" ? new Date(weekEnd(c.now())).toISOString() : null;
    const pro = plans === "pro" && (block === "pro_only" || block === "person_cap");
    const upgrade = block === "pro_only" && gate.config.proOffered ? upgradeUrl(c) : null;
    const approxTokensPerWeek = cap !== undefined ? approxTokens(requested, cap) : undefined;
    const message = providerLimitMessage(requested, block, spec.name, plans, { ...(approxTokensPerWeek !== undefined ? { approxTokensPerWeek } : {}), upgradeUrl: upgrade, resetsAt });
    // The Pro-only refusal is a Pro prompt: counted as seen in Pro's funnel (once a person a day).
    if (upgrade) await countPro(c, "seen", identity.githubId);
    return apiError(
      402,
      "provider_limit",
      message,
      {
        family: requested.family,
        provider: spec.id,
        reason: block,
        resetsAt,
        alternative: DEEPSEEK_MODEL,
        ...(pro ? { plans: "pro", approxTokensPerWeek: approxTokensPerWeek ?? null } : {}),
        ...(block === "pro_only" ? { upgradeUrl: upgrade } : {}),
      },
      await headers(),
    );
  }
  // Every level gets every model; basic and Starter on their smaller allowance.
  const sessionId = c.request.headers.get("x-session-id") ?? (typeof body.session_id === "string" ? body.session_id : undefined);
  // Any agent's session id, for the token allocator's session counts (allocator.ts).
  const sessionKey = sessionKeyOf(c.request.headers, body, input.sessionHint);
  // The session use descriptions and keyword labels are kept under: the client's session id, else
  // the allocator's key (Claude Code's x-claude-code-session-id or metadata.user_id session).
  const labelSession = sessionId ?? sessionKey;
  // Which coding agent asked: a dl-launched one by its harness key, any tool by a tool key, else Autopilot.
  const client: UseClient = harness ?? (tool ? "tool" : "autopilot");
  // What the request row keeps as its client: the harness, or `tool:<name>` from the tool's User-Agent.
  const recordedClient = harness ?? (tool ? toolClient(c.request.headers) : undefined);

  // Account-pooling routers (resale or sharing of free accounts) are refused outright: the free
  // tier is for one person's own coding, not an upstream for a proxy.
  if (!isAdmin && isProxyRouter(sessionId, c.request.headers.get("user-agent"), gate.config.detection)) {
    return apiError(403, "proxy_not_allowed", PROXY_ROUTER_MESSAGE, {}, await headers());
  }

  // Security work never goes to GPT-6 (security-route.ts): a session its use description labels
  // security, or whose text (user messages and tool results) the local pre-check matches, gets
  // the GPT-6 limit's refusal pointing at DeepSeek, for that session and the person's rest of the
  // UTC day. A match on any model is also recorded as the session's use description (no model
  // call), beside the request.
  const gpt6Check = requested.family === "gpt6" && !isAdmin && gate.config.securityOffGpt6;
  const precheck = gpt6Check || (!isAdmin && gate.config.useDescriptions) ? precheckTexts(body) : undefined;
  const signal = securitySignal(precheck, gate.config.detection);
  if (signal && precheck && gate.config.useDescriptions) {
    // A high match is reviewed by moderation, which sees what the pre-check read, cut to
    // MODERATION_INPUT_CHARS. The text lives only in this task; nothing stores it.
    const reviewText = fitToBudget(precheck, MODERATION_INPUT_CHARS).join("\n\n");
    const task = recordKeywordMatch(c, gate, { githubId: identity.githubId, sessionId: labelSession, client, signal, reviewText });
    if (c.background) c.background(task);
  }
  if (gpt6Check) {
    const held = await directory(c).gpt6SecurityCheck({ githubId: identity.githubId, sessionId: labelSession, now: c.now(), ...(signal ? { signal } : {}) });
    if (held) {
      return apiError(402, "gpt_limit", SECURITY_GPT6_MESSAGE, { family: "gpt6", resetsAt: securityHoldEnds(c.now()), reason: SECURITY_REASON, alternative: DEEPSEEK_MODEL }, await headers());
    }
  }

  // GPT-6 for non-admins, after the keyword pre-check: the trust gate (gpt6-trust.ts; on once
  // gpt6TrustedWeeklyUsdCap is above 0), then the pre-send checks of the request's new content
  // (presend-guard.ts). Every agent's GPT-6 request comes through here, whatever its API shape.
  // The GPT-6 launch bonus (planServe.bonus) skips the trust gate: an active paid plan is trusted
  // for the bonus only (its own $2/week meter, Autopilot only, the pre-send guard below). GPT-6
  // outside the bonus still needs trust.
  let trustedGpt6 = false;
  if (requested.family === "gpt6" && !isAdmin) {
    const trust = planServe?.bonus ? undefined : await gpt6TrustFor(c, gate.config, identity.githubId);
    if (trust && !trust.trusted) {
      return apiError(402, "gpt_limit", UNTRUSTED_GPT6_MESSAGE, { family: "gpt6", resetsAt: new Date(weekEnd(c.now())).toISOString(), reason: TRUST_REASON, alternative: DEEPSEEK_MODEL }, await headers());
    }
    if (trust) {
      trustedGpt6 = true;
      fullLimits = withTrustedGpt6Cap(fullLimits, gate.config);
      limits = withTrustedGpt6Cap(limits, gate.config);
    }
    if (gate.config.gpt6PresendGuard === "enforce") {
      const stopped = await presendGuard(c, gate, { githubId: identity.githubId, sessionId: labelSession, client, body });
      if (stopped) return apiError(402, "gpt_limit", GUARD_GPT6_MESSAGE, { family: "gpt6", resetsAt: securityHoldEnds(c.now()), reason: SECURITY_REASON, alternative: DEEPSEEK_MODEL }, await headers());
    }
  }

  if (gate.paused) return pausedError(await headers());
  // Which model actually serves: the requested one when its provider has a key and credit left,
  // else its fallback (GPT-6 Luna → DeepSeek). Never another model.
  let serving = servingModel(effective, gate, gate.config);
  if (!serving) {
    if (providerExhausted(requested.provider, gate.config, gate)) {
      // The credit is used up: free and Pro usage pause (admins too) until it is topped up.
      const paused = await directory(c).creditPausedAlert(providerCredit(requested.provider, gate.config), c.now(), requested.provider === "openai" ? "openai" : "luminal");
      if (paused) await alert(c, [paused]);
      return apiError(503, "upstream_credit_exhausted", CREDIT_EXHAUSTED_MESSAGE, { reason: "credit_exhausted", pausedForEveryone: true, resetsAt: null }, await headers());
    }
    return apiError(503, "upstream_unavailable", "Free tokens are unavailable right now. Try again later, or use your own key: /provider.", { reason: "no_upstream" }, await headers());
  }
  // Why free tokens are unavailable to a free-plan person right now, if they are: queued, or a
  // global cap reached. Pro and top-ups still work; the reservation decides which applies.
  const place = isAdmin ? null : (gate.person?.queue ?? null);
  const { globalTotalUsdCap: total, globalWeeklyUsdCap: weekly } = gate.config;
  // Free tokens work inside dl only: a sign-in token with no session event in the last day that
  // made many requests no session event covers is in another tool (abuse.ts). Server keys (dl's server
  // mode) are left out; like the blocks below, Pro and top-ups still work.
  const outsideDl = gate.config.dlOnly && identity.via !== "key" && gate.person?.outsideDl === true;
  const freeBlock: (() => Promise<Response>) | undefined = isAdmin
    ? undefined
    : outsideDl
      ? async () => apiError(403, "dl_only", DL_ONLY_MESSAGE, {}, await headers())
      : place
        ? async () =>
            apiError(
              402,
              "free_tier_queued",
              queuedMessage(place.position, waitText(place.etaAt, c.now())),
              { position: place.position, etaAt: new Date(place.etaAt).toISOString(), offers: offers(gate.config), referralLink: link },
              await headers(),
            )
        : total !== undefined && gate.totalUsd >= total
          ? async () => apiError(503, "global_total_budget_reached", TOTAL_BUDGET_MESSAGE, { reason: "total_budget", pausedForEveryone: true, resetsAt: null }, await headers())
          : weekly !== undefined && gate.weekUsd >= weekly
            ? async () => {
                // The global caps read as a pause for everyone, with when it ends; a person's own key still works.
                const resumes = weekEnd(c.now());
                const resetsAt = new Date(resumes).toISOString();
                const retryAfter = String(Math.max(1, Math.ceil((resumes - c.now()) / 1000)));
                return apiError(503, "global_weekly_budget_reached", weeklyBudgetMessage(resetsAt), { reason: "weekly_budget", pausedForEveryone: true, resetsAt }, { ...(await headers()), "retry-after": retryAfter });
              }
            : undefined;

  const askedMax = numberOrUndefined(body.max_tokens) ?? numberOrUndefined(body.max_completion_tokens);
  // The GPT-6 launch bonus caps output per request.
  const requestedMax = planServe?.maxOutputTokens !== undefined ? Math.min(askedMax ?? planServe.maxOutputTokens, planServe.maxOutputTokens) : askedMax;
  const promptEstimate = estimatePromptTokens(bodyBytes);
  // The requested model’s pool pays for the request, even when its fallback serves it: someone
  // who asks for Sol spends Sol’s allowance, not Luna’s.
  let pool = effective.pool;
  // On a paid plan every attempt is held to the meter of the model that serves it: the plan's
  // meter for its own model (a backup upstream included), DeepSeek's for a fallback to it.
  const meterOf = (modelId: string) => {
    // A trial: its own meter for DeepSeek, nothing for any other model.
    if (planServe && trialMeter) return modelId === planServe.model ? planServe.meter : { kind: "trial" as const, model: modelId, limit: 0, cachedTokenWeight: gate.config.cachedTokenWeight };
    // The Free plan: the week's meter for DeepSeek, nothing for any other model.
    if (planServe && freeMeter) return modelId === planServe.model ? planServe.meter : { kind: "tokens" as const, model: modelId, limit: 0, cachedTokenWeight: gate.config.cachedTokenWeight };
    if (!planServe || !paidPlan || !planState) return undefined;
    if (modelId === planServe.model) return planServe.meter;
    const view = meterFor(paidPlan, modelId, planState.counted[modelId] ?? 0, gate.config);
    return view ? tokenMeter(view, gate.config.cachedTokenWeight) : { kind: "tokens" as const, model: modelId, limit: 0, cachedTokenWeight: gate.config.cachedTokenWeight };
  };
  const reserveFor = (pool: Pool, serves: { model: FreeModel; provider: Upstream }) => {
    const meter = meterOf(serves.model.id);
    return person.reserve({
      pool,
      promptEstimate,
      requestedMaxTokens: requestedMax,
      limits: { ...limits, freeBlocked: freeBlock !== undefined },
      now: c.now(),
      provider: serves.provider,
      model: serves.model.id,
      ...(meter ? { meter } : {}),
    });
  };
  let reservation = await reserveFor(pool, serving);
  // The trial filled up between the read and the reservation (requests in parallel).
  if (!reservation.ok && reservation.code === "plan_limit" && trialMeter) {
    if (trialMeter.kind === "nocard") return apiError(402, "trial_used_up", noCardUsedUpMessage(trialMeter.realLimit), { reason: "trial_used_up", plansUrl: "https://dl.new" }, quotaHeaders(reservation.allowance));
    const task = convertTrial(c, identity.githubId).catch(() => "failed");
    if (c.background) c.background(task);
    return apiError(503, "trial_converting", TRIAL_CONVERTING_MESSAGE, { retryable: true }, { ...quotaHeaders(reservation.allowance), "retry-after": "30" });
  }
  // The Free plan's week filled up between the read and the reservation (requests in parallel).
  if (!reservation.ok && reservation.code === "plan_limit" && freeMeter) return freeRefusal(quotaHeaders(reservation.allowance));
  // The meter filled up between the plan's read and the reservation (requests in parallel):
  // DeepSeek in its place when allowed, else the plan's refusal.
  if (!reservation.ok && reservation.code === "plan_limit" && planServe && paidPlan && planState) {
    const next = afterMeterFull({ plan: paidPlan, state: planState, served: planServe, deepseekAvailable: deepseekAvailable(), config: gate.config, now: c.now() });
    if (next.kind === "refuse") return apiError(next.status, next.code, next.message, next.details, quotaHeaders(reservation.allowance));
    const nextModel = modelById(next.model)!;
    const nextServing = servingModel(nextModel, gate, gate.config);
    if (!nextServing) return apiError(503, "upstream_unavailable", UPSTREAM_UNAVAILABLE_MESSAGE, { retryable: true }, quotaHeaders(reservation.allowance));
    planServe = next;
    requested = nextModel;
    effective = nextModel;
    serving = nextServing;
    pool = nextModel.pool;
    reservation = await reserveFor(pool, nextServing);
    if (!reservation.ok && reservation.code === "plan_limit") {
      const view = meterFor(paidPlan, next.model, Number.MAX_SAFE_INTEGER, gate.config);
      const refusal = view ? limitRefusal(paidPlan, view, c.now(), gate.config, planState.fallback) : undefined;
      if (refusal) return apiError(refusal.status, refusal.code, refusal.message, refusal.details, quotaHeaders(reservation.allowance));
    }
  }
  // Out of tokens on a limited allowance: the allocator is waited for (or its grace given) rather
  // than refusing on our own system's account (allocator.ts rescue).
  if (
    !reservation.ok &&
    reservation.code === "quota_exceeded" &&
    reservation.reason === "tokens" &&
    reservation.allowance.plan === "free" &&
    !freeBlock &&
    allocatorOn &&
    limitedLevel(fullLimits) &&
    // Another agent's smaller share (otherHarnessShare) used up while the whole allowance isn't: that refusal stands.
    (!agent || gate.config.otherHarnessShare >= 1 || ((await person.allowance(c.now(), fullLimits, pool)).remaining ?? Infinity) < promptEstimate + MIN_OUTPUT_TOKENS)
  ) {
    const state = gate.person?.allocator ?? null;
    const step = stepOf(fullLimits, state, weekStart(c.now()));
    const next = await rescue(await allocatorRun(c, gate.config, identity.githubId), {
      githubId: identity.githubId,
      fromTokens: step,
      usedThisWeek: reservation.allowance.usedThisWeek,
      stage: stageOf(step, state),
      state,
      ...(c.background ? { background: c.background } : {}),
    });
    if (next && gate.person) {
      gate.person.allocator = next;
      fullLimits = allocated(gate.config, baseLimits, identity.githubId, gate.person, c.now());
      if (trustedGpt6) fullLimits = withTrustedGpt6Cap(fullLimits, gate.config);
      limits = agent ? { ...fullLimits, harnessShare: gate.config.otherHarnessShare } : fullLimits;
      reservation = await reserveFor(pool, serving);
    }
  }
  if (!reservation.ok) {
    const quota = quotaHeaders(reservation.allowance);
    if (reservation.code === "plan_limit") return apiError(503, "upstream_unavailable", UPSTREAM_UNAVAILABLE_MESSAGE, { retryable: true }, quota);
    // Another coding agent's share is used up while the whole allowance isn't: say so, and that
    // Autopilot can still use the rest.
    if (agent && (reservation.code === "quota_exceeded" || reservation.code === "trial_ended") && !(freeBlock && reservation.allowance.plan === "free")) {
      const whole = await person.allowance(c.now(), fullLimits, pool);
      const wholeLeft = whole.remaining === null || whole.remaining > 0;
      if (wholeLeft && !(whole.plan === "free" && whole.trial?.ended)) {
        const resetsAt = reservation.code === "trial_ended" ? undefined : new Date(reservation.allowance.resetsAt).toISOString();
        const message = harness ? harnessLimitMessage(gate.config.otherHarnessShare, resetsAt, reservation.allowance.plan, harness, gate.config.proOffered) : toolLimitMessage(gate.config.otherHarnessShare, resetsAt, reservation.allowance.plan);
        return apiError(402, "harness_limit", message, { harness: agent, share: gate.config.otherHarnessShare, ...(resetsAt ? { resetsAt } : {}), offers: offers(gate.config) }, quota);
      }
    }
    if (reservation.code === "quota_exceeded") {
      if (freeBlock && reservation.allowance.plan === "free") return freeBlock();
      const resetsAt = new Date(reservation.allowance.resetsAt).toISOString();
      // GPT-6's week used up while DeepSeek's isn't: point there instead of a dead end.
      if (reservation.family === "gpt6" && reservation.deepseekLeft && modelAvailable(modelById(DEEPSEEK_MODEL)!, gate.config, gate)) {
        return apiError(
          402,
          "gpt_limit",
          gptLimitMessage(reservation.allowance.plan, gate.config.proOffered),
          { family: "gpt6", resetsAt, reason: reservation.reason, alternative: DEEPSEEK_MODEL, offers: offers(gate.config) },
          quota,
        );
      }
      // Which limit ran out (the token allowance or the dollar one), named in the refusal.
      const limitName = refusalLimitName(reservation.allowance, reservation.reason, reservation.family, serving.model, gate.config.cachedTokenWeight);
      // dl Pro's prompt: a free account's week of open models (DeepSeek) is used up, Pro is offered.
      const proPrompt =
        !isAdmin && reservation.allowance.plan === "free" && !reservation.allowance.trial && (reservation.family === "deepseek" || !reservation.deepseekLeft) ? proPromptFor(c, gate.config, limitName) : null;
      if (proPrompt) await countPro(c, "seen", identity.githubId);
      // A basic or Starter week used up: what the level gets, when it resets, and the ways to more.
      if (!isAdmin && reservation.allowance.plan === "free" && (level === "basic" || level === "starter")) {
        return apiError(
          402,
          `${level}_limit`,
          proPrompt
            ? `${proPrompt.message}, or type /request in dl and tell us what you're building.`
            : limitLine(level, limits.levelTokens ?? 0, limits.weeklyUsd, limits.deepseekWeeklyUsd ?? undefined, limitName),
          { resetsAt, reason: reservation.reason, family: reservation.family, request: ACCESS_REQUEST_PATH, offers: offers(gate.config), referralLink: link, ...(proPrompt ? { proPrompt: proPrompt.view } : {}) },
          quota,
        );
      }
      return apiError(
        402,
        "quota_exceeded",
        proPrompt ? proPrompt.message : quotaMessage(reservation.reason, resetsAt, reservation.allowance.plan),
        { resetsAt, reason: reservation.reason, family: reservation.family, offers: offers(gate.config), referralLink: link, ...(proPrompt ? { proPrompt: proPrompt.view } : {}) },
        quota,
      );
    }
    if (reservation.code === "trial_ended") {
      return apiError(402, "trial_ended", trialEndedMessage(reservation.trial.tokens, gate.config.proOffered ? usdLabel(gate.config.offers.pro.priceUsdMonthly) : null), { trial: trialView(reservation.allowance), offers: offers(gate.config) }, quota);
    }
    if (reservation.code === "blocked") return blockedError(quota);
    if (reservation.code === "suspended") return apiError(403, "suspended", "This account is suspended from the free tier.", {}, quota);
    return apiError(403, "not_invited", "This GitHub account isn't on the free tier.", {}, quota);
  }

  const stream = body.stream === true;
  const user = await safetyIdentifier(identity.githubId);
  const cooldownMs = gate.config.openRouterHostCooldownMinutes * 60_000;
  const failingHosts = cooldownMs > 0 && serving.provider === "openrouter" ? await hosts(c).failingHosts(c.now() - cooldownMs) : [];
  const started = c.now();
  const trustSession = sessionId ?? (identity.harnessKeyId ? `harness:${identity.harnessKeyId}` : undefined);

  /**
   * Settles one attempt against the model that served it: the person's allowance at that
   * model's list prices, and the provider's credit at its own. `host` is who served or failed
   * the request; with `failure`, it goes on the failing list too.
   */
  const settle = async (
    model: FreeModel,
    provider: Upstream,
    reservationId: string,
    usage: Usage | undefined,
    status: string,
    options: { chargeNothing?: boolean; host?: string; failure?: HostFailure; ttfbMs?: number; ttftMs?: number; upstreamError?: boolean; outcome?: UpstreamOutcome; creditUsd?: number; outputTokens?: number } = {},
  ) => {
    const { chargeNothing = false, host, failure } = options;
    if (host && failure && cooldownMs > 0) await hosts(c).markHostFailing(host, c.now());
    const charged = chargeNothing ? 0 : usage ? chargedTokens(usage, gate.config.cachedTokenWeight) : undefined;
    const cost = chargeNothing ? 0 : usage ? (provider === "openrouter" ? costOf(usage, 0) : costAtPrices(usage, model.prices)) : undefined;
    const rawTokens = chargeNothing ? 0 : usage ? usage.promptTokens + usage.completionTokens : undefined;
    // Without usage the person is charged an estimate (AccountObject.settle): nothing when no
    // output was streamed, else a realistic prompt plus the output streamed, at the model's prices.
    const noUsage = charged === undefined ? { outputTokens: options.outputTokens ?? 0, prices: model.prices, cachedTokenWeight: gate.config.cachedTokenWeight } : undefined;
    // A backup provider or a fallback model served (a plan's fallback, a provider's failover).
    const failover = model.id !== asked.id || provider !== serving!.provider;
    const meter = { tool: recordedClient ?? "autopilot", failover, bonus: planServe?.bonus === true && model.id === planServe.model, ...(trialMeter ? { trial: true } : {}) };
    const settled = await person.settle({ reservationId, charged, costUsd: cost, ...(rawTokens !== undefined ? { rawTokens } : {}), ...(usage && !chargeNothing ? { usage } : {}), ...(noUsage ? { noUsage } : {}), meter, limits, now: c.now() });
    const estimated = settled.estimate?.usage;
    // A card trial just used up: its plan starts now (Stripe's first real charge), beside the request.
    if (trialMeter?.kind === "card" && settled.trial?.active && settled.trial.usedUp) {
      const task = convertTrial(c, identity.githubId).catch(() => "failed");
      if (c.background) c.background(task);
    }
    // A provider that reports its charge (Liquid's `exchange.charge.total_usd`) is charged that.
    // Without usage, the credit gets our best estimate of what the provider billed, apart from
    // the person's charge: the estimate charged when output was streamed; the prompt alone when
    // the client went away before any output (the upstream read it; OpenAI bills input on a
    // cancelled stream); nothing when the upstream itself failed first, or on Open Relay, which
    // doesn't bill a request it didn't finish.
    const creditUsd =
      chargeNothing || provider === "openrouter"
        ? 0
        : options.creditUsd !== undefined
          ? options.creditUsd
          : usage
            ? costAtPrices(usage, creditPrices(model))
            : provider === "openrelay"
              ? 0
              : estimated
                ? costAtPrices(estimated, creditPrices(model))
                : !options.upstreamError && settled.estimate
                  ? costAtPrices(settled.estimate.prompt, creditPrices(model))
                  : 0;
    const counted = usage ?? estimated;
    const record: RequestRecord = {
      githubId: identity.githubId,
      isAdmin,
      at: started,
      model: model.id,
      promptTokens: counted?.promptTokens ?? 0,
      completionTokens: counted?.completionTokens ?? 0,
      cachedTokens: counted?.cachedTokens ?? 0,
      chargedTokens: settled.charged,
      costUsd: settled.costUsd,
      ...(settled.paid ? { paid: true } : {}),
      status,
      latencyMs: c.now() - started,
      ...(host ? { host } : {}),
      ...(host && failure ? { hostFailure: failure } : {}),
      upstream: provider,
      creditUsd,
      ttfbMs: options.ttfbMs ?? null,
      ttftMs: options.ttftMs ?? null,
      ...(options.upstreamError ? { upstreamError: true } : {}),
      ...(options.outcome ? { upstreamOutcome: options.outcome } : {}),
      ...(failover ? { failover: true } : {}),
      ...(identity.via === "key" ? { viaKey: true } : {}),
      ...(recordedClient ? { harness: recordedClient } : {}),
      // The requested model's budget paid, even when its fallback served.
      family: effective.family,
      ...(sessionKey ? { sessionKey } : {}),
      // Multi-turn use for GPT-6's trust gate, from any agent: the session id, or the harness key of a dl opencode run.
      ...(trustSession ? { trustSession } : {}),
      ...(trialMeter ? { trial: trialMeter.kind } : {}),
      ...(freeMeter ? { freePlan: true } : {}),
    };
    await alert(c, await directory(c).recordRequest(record, policyOf(gate.config), servingContext(c, gate.config)));
    // Most of the week's free tokens used: one email a week, on the settlement that crossed 80%.
    // On the trial, most of the trial instead (once): its weekly allowance isn't what it runs out of.
    // A paying account gets plan_80 per model instead (below), never week_80.
    if (!settled.paid && !paidPlan && !isAdmin && userEmailsOn(gate.config, userEmailVia(c))) {
      if (trial) {
        if (trialMostlyUsed(settled.allowance)) await userEmail(c, gate.config, "trial_80", identity.githubId, "");
      } else if (weekMostlyUsed(settled.allowance)) {
        await userEmail(c, gate.config, "week_80", identity.githubId, String(weekStart(c.now())));
      }
    }
    // Most of a limited allowance used: an allocator decision beside the request (allocator.ts).
    if (!settled.paid && allocatorOn && settled.allowance.plan === "free" && limitedLevel(fullLimits) && usedShare({ tokensPerWeek: fullLimits.levelTokens ?? null, usedThisWeek: settled.allowance.usedThisWeek }) >= gate.config.allocatorTriggerShare) {
      const state = gate.person?.allocator ?? null;
      const step = stepOf(fullLimits, state, weekStart(c.now()));
      const task = allocatorRun(c, gate.config, identity.githubId).then((run) => allocateIfDue(run, { githubId: identity.githubId, fromTokens: step, usedThisWeek: settled.allowance.usedThisWeek, stage: stageOf(step, state) }));
      if (c.background) c.background(task);
    }
    return settled.allowance;
  };

  /**
   * What to try next when an attempt fails before anything reaches the client (429, 5xx, a
   * timeout, Liquid's "no eligible offer"): a registry model's other upstreams that can serve, in
   * order (GLM 5.3 Flash: Open Relay after Liquid), then the model's fallback (DeepSeek) when its
   * provider is ready. OpenAI's models have only the fallback.
   */
  const nextSteps = (model: FreeModel, backups: readonly RegistryProviderId[]): Step[] => {
    const requestedModel = modelById(model.id)!;
    const steps: Step[] = backups.map((provider) => ({ model: onUpstream(requestedModel, provider), provider, fallback: false }));
    const backup = fallbackOf(model.id);
    if (backup && providerReady(backup.provider, gate.config, gate)) steps.push({ model: backup, provider: backup.provider, fallback: true });
    return steps;
  };

  /** A retry on the first of `steps`, with a fresh reservation, and the rest after it; undefined with none. */
  const retryOn = (steps: readonly Step[]): (() => Promise<Response>) | undefined => {
    const [next, ...rest] = steps;
    if (!next) return undefined;
    return async (): Promise<Response> => {
      const again = await reserveFor(pool, next);
      if (!again.ok) return apiError(503, "upstream_unavailable", UPSTREAM_UNAVAILABLE_MESSAGE, { retryable: true }, quotaHeaders(again.allowance));
      const response = await attempt(next.model, next.provider, again, rest);
      if (!next.fallback) return response;
      // Tell the client which model actually answered, so it can say so.
      const headers = new Headers(response.headers);
      if (!headers.has("x-dl-fallback")) headers.set("x-dl-fallback", next.model.id);
      return new Response(response.body, { status: response.status, headers });
    };
  };

  /** One attempt on `model`, with a fresh reservation; on a failure before any bytes, `then` in order (nextSteps). */
  const attempt = (model: FreeModel, provider: Upstream, res: Extract<typeof reservation, { ok: true }>, then: readonly Step[] = []): Promise<Response> => {
    const settleFor: Settle = (usage, status, options) => settle(model, provider, res.reservationId, usage, status, options);
    const retry = retryOn(then);
    if (provider === "openai") {
      return openaiChat(c, { model, body, stream, maxTokens: res.maxTokens, user, sessionId, started, settle: settleFor, timeoutSeconds: gate.config.openaiFirstByteTimeoutSeconds, reservedAllowance: res.allowance, ...(retry ? { retry } : {}) });
    }
    if (provider === "openrelay") {
      return openRelayChat(c, { model, body, stream, maxTokens: res.maxTokens, user, started, settle: settleFor, timeoutSeconds: gate.config.openrelayFirstByteTimeoutSeconds, reservedAllowance: res.allowance, ...(retry ? { retry } : {}) });
    }
    if (provider === "liquid") {
      // Liquid keeps a conversation on the seller that holds its prompt cache by session id: Claude
      // Code's own session id (x-claude-code-session-id, metadata.user_id) when the client sends no x-session-id.
      return liquidChat(c, { model, config: gate.config, body, stream, maxTokens: res.maxTokens, user, sessionId: sessionId ?? sessionKey ?? undefined, started, settle: settleFor, timeoutSeconds: gate.config.liquidFirstByteTimeoutSeconds, reservedAllowance: res.allowance, ...(retry ? { retry } : {}) });
    }
    if (provider === "luminal") {
      return luminalChat(c, { model, body, stream, maxTokens: res.maxTokens, user, started, settle: settleFor, timeoutSeconds: gate.config.luminalFirstByteTimeoutSeconds, reservedAllowance: res.allowance });
    }
    return openRouterChat(c, { model, config: gate.config, body, stream, maxTokens: res.maxTokens, user, sessionId, started, settle: settleFor, reservedAllowance: res.allowance, failingHosts });
  };

  // What this session is about, beside the request and never awaited by it (use-description.ts).
  // The input is taken now, before anything else touches the body.
  if (!isAdmin && gate.config.useDescriptions) {
    const task = describeUse(c, gate, { githubId: identity.githubId, sessionId: labelSession, client, input: useInput(body), user });
    if (c.background) c.background(task);
  }
  // OpenAI's models and registry models retry on what nextSteps gives; Luminal and OpenRouter don't.
  const retries = serving.provider === "openai" || isRegistryProvider(serving.provider) ? nextSteps(serving.model, serving.backups ?? []) : [];
  const answered = await attempt(serving.model, serving.provider, reservation, retries);
  // A paid plan's notices: its fallback's, and the 80% warning once per model per week (also by email).
  const notices = [...(planServe?.notices ?? [])];
  const warning = planServe ? dueWarning(planServe) : undefined;
  if (warning && planServe?.view && answered.status === 200 && (await person.claimPlanNotice(`warn:${planServe.view.model}`, c.now()))) {
    notices.push(warning);
    const values = warningEmailValues(planServe.view);
    const task = userEmail(c, gate.config, "plan_80", identity.githubId, `${weekStart(c.now())}:${planServe.view.model}`, { planWarning: values });
    if (c.background) c.background(task);
    else await task;
  }
  // A trial's 80% notice, once per trial (and, for a card trial, the trial_card_80 email).
  if (trialMeter && answered.status === 200 && trialMeter.counted >= trialMeter.limit * TRIAL_WARN_SHARE && trialMeter.counted < trialMeter.limit && (await person.claimTrialWarning())) {
    const planName = trialMeter.kind === "card" && isPaidPlan(trialMeter.plan) ? planTitle(trialMeter.plan) : undefined;
    notices.push(trialWarningNotice({ kind: trialMeter.kind, counted: trialMeter.counted, limit: trialMeter.limit, realLimit: trialMeter.realLimit, ...(planName ? { planName } : {}) }));
    if (trialMeter.kind === "card") {
      const task = sendTrial80(c, identity.githubId, trialMeter).catch(() => undefined);
      if (c.background) c.background(task);
      else await task;
    }
  }
  // The Free plan's 80% notice in the tool and free_80, once per week, each with the upgrade line.
  if (freeMeter && answered.status === 200 && freeMeter.counted >= freeMeter.limit * FREE_PLAN_WARN_SHARE && freeMeter.counted < freeMeter.limit && (await person.claimPlanNotice("free:80", c.now()))) {
    notices.push(freePlanWarning({ counted: freeMeter.counted, limit: freeMeter.limit, realLimit: gate.config.freePlanWeeklyRealTokens, config: gate.config }));
    const task = userEmail(c, gate.config, "free_80", identity.githubId, String(weekStart(c.now())), { trial: freePlanEmailValues({ counted: freeMeter.counted, config: gate.config }) }).catch(() => "failed");
    if (c.background) c.background(task);
    else await task;
  }
  const response = notices.length > 0 ? await withNotices(answered, notices, serving.model.id) : answered;
  const fellBackTo = serving.fallback ? serving.model.id : effective !== requested ? effective.id : undefined;
  if (!fellBackTo) return response;
  // The requested model's provider couldn't serve it, so its fallback did: say which, and why
  // when it was a limit (a header value: printable ASCII only).
  const outHeaders = new Headers(response.headers);
  outHeaders.set("x-dl-fallback", fellBackTo);
  if (fallbackNotice) outHeaders.set("x-dl-notice", fallbackNotice.replace(/[^\x20-\x7e]/g, ""));
  return new Response(response.body, { status: response.status, headers: outHeaders });

}

/** The per-person `safety_identifier` / `user` sent upstream: a hash, never the GitHub id itself. */
async function safetyIdentifier(githubId: number): Promise<string> {
  return `dl-${(await sha256Hex(`free:${githubId}`)).slice(0, 32)}`;
}

/** Where the owner blocks or unblocks someone by hand: the admin Tools tab's form. */
const blockUrl = (c: Ctx) => `${c.base}/admin?view=tools#block`;

/** What the Directory needs to claim a moderation review for a high label; undefined with moderation off. */
function moderationLimits(config: FreeConfig): ModerationLimits | undefined {
  if (config.moderation === "off") return undefined;
  return { cooldownMs: config.moderationCooldownMinutes * 60_000, dailyCap: config.moderationDailyCap, model: DEEPSEEK_MODEL };
}

/**
 * GPT-6 trust for a non-admin (gpt6-trust.ts; the caller leaves admins out), or undefined while
 * the trust gate is off (`gpt6TrustedWeeklyUsdCap` 0).
 */
async function gpt6TrustFor(c: Ctx, config: FreeConfig, githubId: number): Promise<Trust | undefined> {
  if (!(config.gpt6TrustedWeeklyUsdCap > 0)) return undefined;
  return directory(c).gpt6Trust({ githubId, now: c.now() });
}

/** A trusted person's limits: the trusted weekly GPT-6 budget for the free plan (a personal cap an admin set still wins; Pro keeps its own). */
function withTrustedGpt6Cap<T extends Limits>(limits: T, config: FreeConfig): T {
  return { ...limits, weeklyUsd: config.gpt6TrustedWeeklyUsdCap };
}

/**
 * The pre-send checks of a non-admin's GPT-6 request (presend-guard.ts): true when the request
 * must not be sent (flagged, a checker failed or was late). The outcome is counted; a flag is
 * stored as a high-risk label (holding the session and day off GPT-6), and its moderation review
 * or alert runs beside the response. Logs a reason code, never content.
 */
async function presendGuard(c: Ctx, gate: Runtime, input: { githubId: number; sessionId: string | null; client: UseClient; body: Record<string, unknown> }): Promise<boolean> {
  const { config } = gate;
  let result: Awaited<ReturnType<typeof runGuard>>;
  try {
    result = await runGuard(c.fetch, {
      body: input.body,
      openaiApiKey: config.openaiApiKey,
      openRouterApiKey: config.openRouterApiKey,
      policy: config.detection.guardPolicy,
      timeoutMs: config.gpt6GuardTimeoutMs,
      user: await safetyIdentifier(input.githubId),
    });
  } catch (error) {
    console.error(`gpt6 presend guard failed: ${error instanceof Error ? error.name : "error"}`);
    result = { verdict: "error", openai: { verdict: "error", reason: "crash" }, safeguard: { verdict: "error", reason: "crash" }, flaggedBy: [], reason: "crash", spend: { tokens: 0, cashUsd: 0 }, text: "" };
  }
  if (result.verdict !== "pass") console.log(`gpt6 presend guard: ${result.verdict} (${result.reason})`);
  const moderation = moderationLimits(config);
  const stored = directory(c)
    .recordGpt6Guard({
      githubId: input.githubId,
      sessionId: input.sessionId,
      client: input.client,
      outcomes: outcomesOf(result),
      ...(result.flaggedBy[0] ? { flaggedBy: result.flaggedBy[0] } : {}),
      spend: result.spend,
      now: c.now(),
      blockUrl: blockUrl(c),
      ...(moderation ? { moderation } : {}),
    })
    .catch((error: unknown) => {
      console.error(`gpt6 presend record failed: ${error instanceof Error ? error.name : "error"}`);
      return undefined;
    });
  if (result.verdict !== "flag") {
    // A pass or a failure: only counters and cost, beside the request.
    if (c.background) c.background(stored);
    else await stored;
    return result.verdict !== "pass";
  }
  // A flag: the hold and the label are stored before the answer; the review or alert runs beside it.
  const outcome = await stored;
  if (outcome) {
    const followUp = (async () => {
      try {
        await alert(c, outcome.alerts);
        // The reviewer sees what the checkers saw, cut to its own size (in flight only).
        if (outcome.review) await moderate(c, gate, { githubId: input.githubId, ...outcome.review, text: result.text.slice(0, MODERATION_INPUT_CHARS) });
      } catch (error) {
        console.error(`gpt6 presend review failed: ${error instanceof Error ? error.name : "error"}`);
      }
    })();
    if (c.background) c.background(followUp);
    else await followUp;
  }
  return true;
}

/**
 * Records a pre-check match as a use description and sends its alert, if any, or runs the
 * moderation review a high match claimed. Never throws.
 */
async function recordKeywordMatch(c: Ctx, gate: Runtime, input: { githubId: number; sessionId: string | null; client: UseClient; signal: string; reviewText: string }): Promise<void> {
  try {
    const moderation = moderationLimits(gate.config);
    const outcome = await directory(c).recordKeywordMatch({
      githubId: input.githubId,
      sessionId: input.sessionId,
      client: input.client,
      signal: input.signal,
      label: keywordLabel(input.signal, gate.config.detection),
      now: c.now(),
      blockUrl: blockUrl(c),
      ...(moderation ? { moderation } : {}),
    });
    await alert(c, outcome.alerts);
    if (outcome.review) await moderate(c, gate, { githubId: input.githubId, ...outcome.review, text: input.reviewText });
  } catch (error) {
    console.error("keyword match record failed", error instanceof Error ? error.name : "error");
  }
}

/**
 * Describes the session this request belongs to, when it is due (see use-description.ts and the
 * Directory's claimUseDescription): one DeepSeek V4.1 Flash call on the company key (Luminal,
 * or OpenRouter where Luminal has no key or credit), then the label and its cost recorded, and
 * for a "high" risk a moderation review (or, with moderation off, the owner's alert). Never throws and is never awaited by the request: any
 * failure just means no description.
 */
async function describeUse(c: Ctx, gate: Runtime, input: { githubId: number; sessionId: string | null; client: UseClient; input: UseInput | undefined; user: string }): Promise<void> {
  try {
    const { config } = gate;
    const provider: Upstream | undefined = providerReady("luminal", config, gate) ? "luminal" : config.openRouterApiKey ? "openrouter" : undefined;
    if (!provider) return;
    const claim = await directory(c).claimUseDescription({
      githubId: input.githubId,
      sessionId: input.sessionId,
      hasInput: input.input !== undefined,
      now: c.now(),
      perPersonCap: USE_DESCRIPTIONS_PER_PERSON_PER_DAY,
      globalCap: config.useDescriptionDailyCap,
    });
    if (!claim || !input.input) return;
    const messages = useMessages(input.input, config.detection);
    const result = await internalDeepseek(c, config, provider, { messages, maxTokens: USE_MAX_TOKENS, reasoningRoom: USE_REASONING_ROOM, timeoutSeconds: USE_TIMEOUT_SECONDS, user: input.user });
    if ("failure" in result) {
      console.error(`use description call failed: ${result.failure}`);
      return;
    }
    const label = parseUseLabel(result.text);
    const moderation = moderationLimits(config);
    const outcome = await directory(c).recordUseDescription({
      githubId: input.githubId,
      sessionId: input.sessionId,
      client: input.client,
      label,
      model: DEEPSEEK_MODEL,
      ...result.cost,
      now: c.now(),
      blockUrl: blockUrl(c),
      ...(moderation ? { moderation } : {}),
    });
    await alert(c, outcome.alerts);
    // A high label: the reviewer sees what the labeller saw (never stored).
    if (outcome.review) await moderate(c, gate, { githubId: input.githubId, ...outcome.review, text: labellerText(input.input) });
  } catch (error) {
    console.error("use description failed", error instanceof Error ? error.name : "error");
  }
}

/** The text the use-description labeller was shown, for the moderation reviewer. */
function labellerText(input: UseInput): string {
  const previous = input.previous ? `(end of the previous message) ${input.previous}\n\n` : "";
  return `${previous}${input.text}\n\nTools called: ${input.tools.length > 0 ? input.tools.join(", ") : "none"}`;
}

/**
 * One internal, non-streamed DeepSeek V4.1 Flash call on the company key (use descriptions and
 * moderation reviews): Luminal asked to reason little, with room for it, or OpenRouter asked not
 * to reason. Its cost is for the internal spend bucket, never a person's allowance. A timeout or
 * an error status is a `failure` code ("timeout", "http_<status>"); a thrown fetch is the caller's
 * to catch.
 */
async function internalDeepseek(
  c: Ctx,
  config: FreeConfig,
  provider: Upstream,
  input: { messages: Array<{ role: string; content: string }>; maxTokens: number; reasoningRoom: number; timeoutSeconds: number; user: string },
): Promise<{ text: string | undefined; cost: { upstream: Upstream; tokens: number; cashUsd: number; creditUsd: number } } | { failure: ModerationFailure }> {
  const model = modelById(DEEPSEEK_MODEL)!;
  const payload: Record<string, unknown> =
    provider === "luminal"
      ? { model: model.upstreamModel, messages: input.messages, max_completion_tokens: input.maxTokens + input.reasoningRoom, temperature: 0, stream: false, reasoning_effort: "low", user: input.user }
      : { model: model.id, messages: input.messages, max_tokens: input.maxTokens, temperature: 0, stream: false, reasoning: { enabled: false }, usage: { include: true }, provider: { ...providerPreferences(config), data_collection: "deny" }, user: input.user };
  const response = await fetchWithTimeout(
    c.fetch,
    provider === "luminal" ? LUMINAL_URL : OPENROUTER_URL,
    {
      method: "POST",
      headers:
        provider === "luminal"
          ? { authorization: `Bearer ${c.config.luminalApiKey}`, "content-type": "application/json" }
          : { authorization: `Bearer ${c.config.openRouterApiKey}`, "content-type": "application/json", "http-referer": "https://directionallylocal.com", "x-title": "Directionally Local" },
      body: JSON.stringify(payload),
    },
    input.timeoutSeconds * 1000,
  );
  if (response === "timeout") return { failure: "timeout" };
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { failure: `http_${response.status}` };
  }
  const parsed = parseJson(await response.text());
  const usage = parseUsage((parsed as { usage?: unknown } | undefined)?.usage);
  return {
    text: completionText(parsed),
    cost: {
      upstream: provider,
      tokens: usage ? usage.promptTokens + usage.completionTokens : 0,
      cashUsd: provider === "openrouter" && usage ? costOf(usage, 0) : 0,
      creditUsd: provider === "luminal" && usage ? costAtPrices(usage, creditPrices(model)) : 0,
    },
  };
}

/**
 * Runs a claimed moderation review (moderation.ts): the case from the Directory, one DeepSeek
 * call with the flagged text (in flight only), then the action (a confident block in "enforce"
 * mode blocks the person and revokes their tokens, the admin block's own code path), the decision
 * stored and the owner emailed. Any failure on the way is a "watch" with confidence 0, never a
 * block. Never throws; runs beside the request, never awaited by it.
 */
async function moderate(c: Ctx, gate: Runtime, input: { githubId: number; decisionId: number; label: TriggerLabel; text: string }): Promise<void> {
  try {
    const { config } = gate;
    const now = c.now();
    const facts = await directory(c).moderationCase({ githubId: input.githubId, decisionId: input.decisionId, label: input.label, now });
    if (!facts) return;
    let answer = REVIEW_FAILED;
    // Why the review failed, when it did: stored on the decision and logged (a code, never content).
    let failure: ModerationFailure | null = "no_provider";
    let cost: { upstream: Upstream; tokens: number; cashUsd: number; creditUsd: number } = { upstream: "luminal", tokens: 0, cashUsd: 0, creditUsd: 0 };
    const provider: Upstream | undefined = providerReady("luminal", config, gate) ? "luminal" : config.openRouterApiKey ? "openrouter" : undefined;
    if (provider) {
      try {
        // An empty answer usually means the reasoning used up the output tokens: one retry with more room.
        for (const reasoningRoom of [MODERATION_REASONING_ROOM, MODERATION_RETRY_ROOM]) {
          const result = await internalDeepseek(c, config, provider, {
            messages: moderationMessages(input.text, facts, config.detection),
            maxTokens: MODERATION_MAX_TOKENS,
            reasoningRoom,
            timeoutSeconds: MODERATION_TIMEOUT_SECONDS,
            user: await safetyIdentifier(input.githubId),
          });
          if ("failure" in result) {
            failure = result.failure;
            break;
          }
          cost = { ...result.cost, tokens: cost.tokens + result.cost.tokens, cashUsd: cost.cashUsd + result.cost.cashUsd, creditUsd: cost.creditUsd + result.cost.creditUsd };
          answer = parseModeration(result.text);
          failure = answer !== REVIEW_FAILED ? null : result.text?.trim() ? "unparsable" : "empty_answer";
          if (failure !== "empty_answer") break;
        }
      } catch (error) {
        failure = "network";
        console.error("moderation review call failed", error instanceof Error ? error.name : "error");
      }
    }
    if (failure) console.error(`moderation review failed: ${failure} (${provider ?? "no provider"})`);
    let action: ModerationAction = moderationAction({
      answer,
      mode: config.moderation,
      threshold: config.moderationBlockConfidence,
      isAdmin: c.config.adminGithubIds.has(input.githubId),
      allowlisted: allowlisted(config.moderationAllowlist, input.githubId, facts.login),
      alreadyBlocked: facts.status === "blocked",
    });
    if (action === "blocked") {
      // The admin block's own path; the config log shows "moderation" as who did it.
      const status = await setBlocked(c, input.githubId, true, { githubId: 0, login: "moderation", now });
      if (status === "blocked") await revokeTokens(c, input.githubId, now);
      else action = "none";
    }
    const alerts = await directory(c).finishModeration({
      decisionId: input.decisionId,
      githubId: input.githubId,
      answer,
      failure,
      action,
      mode: config.moderation,
      label: input.label,
      model: DEEPSEEK_MODEL,
      ...cost,
      now: c.now(),
      blockUrl: blockUrl(c),
    });
    await alert(c, alerts);
    console.log(`moderation review: ${answer.verdict} ${answer.confidence} ${action}${failure ? ` (failed: ${failure})` : ""}`);
  } catch (error) {
    console.error("moderation review failed", error instanceof Error ? error.name : "error");
  }
}

/**
 * One request to OpenRouter (the old upstream; production doesn't use it). Routing is on our
 * terms (see routing.ts): the cheapest full-precision host that doesn't collect prompts,
 * unless the owner pinned an order, and not a host that failed a request recently.
 */
async function openRouterChat(
  c: Ctx,
  input: {
    model: FreeModel;
    config: FreeConfig;
    body: Record<string, unknown>;
    stream: boolean;
    maxTokens: number;
    user: string;
    sessionId: string | undefined;
    started: number;
    settle: Settle;
    reservedAllowance: Allowance;
    failingHosts: readonly string[];
  },
): Promise<Response> {
  const { body, stream, started, settle, model } = input;
  // OpenRouter's id for the model is the public one (the Luminal id is Luminal's own).
  const payload: Record<string, unknown> = { ...body, model: model.id, max_tokens: input.maxTokens, usage: { include: true } };
  delete payload.max_completion_tokens;
  delete payload.models;
  delete payload.route;
  payload.provider = providerPreferences(input.config, input.failingHosts);
  payload.user = input.user;
  if (input.sessionId && /^[\x21-\x7e]{1,256}$/.test(input.sessionId)) payload.session_id = input.sessionId;
  else delete payload.session_id;
  if (stream) payload.stream_options = { include_usage: true };

  const send = (outgoing: Record<string, unknown>) =>
    c.fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${c.config.openRouterApiKey}`,
        "content-type": "application/json",
        "http-referer": "https://directionallylocal.com",
        "x-title": "Directionally Local",
        ...(outgoing.session_id ? { "x-session-id": String(outgoing.session_id) } : {}),
      },
      body: JSON.stringify(outgoing),
    });

  let response: Response;
  let errorText: string | undefined;
  try {
    response = await send(payload);
    if (!response.ok) {
      errorText = await response.text().catch(() => "");
      // Skipping the failing hosts left none: ask once more with every host allowed.
      if (input.failingHosts.length > 0 && isNoHostError(response.status, errorText)) {
        response = await send({ ...payload, provider: providerPreferences(input.config) });
        errorText = response.ok ? undefined : await response.text().catch(() => "");
      }
    }
  } catch {
    const allowance = await settle(undefined, "upstream_error", { chargeNothing: true, upstreamError: true });
    return apiError(502, "upstream_error", "The model provider couldn't be reached. Try again.", {}, quotaHeaders(allowance));
  }
  const ttfbMs = c.now() - started;

  if (!response.ok) {
    const text = errorText ?? "";
    const host = response.status >= 500 ? hostOf(parseJson(text)) : undefined;
    const failure: HostFailure | undefined = host ? { kind: "http_5xx", upstreamStatus: response.status } : undefined;
    const upstreamError = response.status === 429 || response.status >= 500;
    const allowance = await settle(undefined, "upstream_error", { chargeNothing: true, ttfbMs, upstreamError, ...(response.status === 429 ? { outcome: "rate_limited" as const } : {}), ...(host ? { host } : {}), ...(failure ? { failure } : {}) });
    const quota = quotaHeaders(allowance);
    if (response.status === 429) {
      const retryAfter = Math.max(1, Number(response.headers.get("retry-after")) || 10);
      return rateLimited(retryAfter, quota);
    }
    if (response.status === 402) return apiError(503, "service_paused", "The model provider paused the service's account. Try again later.", { upstreamStatus: response.status }, quota);
    return apiError(response.status >= 500 ? 502 : 400, "upstream_error", upstreamRefusal(text).message, upstreamDetails(response.status, text), quota);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (stream && response.body && contentType.includes("text/event-stream")) {
    const metered = meterStream(
      response.body,
      async ({ usage, errored, upstreamFailed, host, firstContentAt, outputTokens }) => {
        await settle(usage, usage ? (errored ? "stream_error" : "ok") : "no_usage", {
          ttfbMs,
          outputTokens,
          ...(firstContentAt !== undefined ? { ttftMs: firstContentAt - started } : {}),
          ...(upstreamFailed ? { upstreamError: true } : {}),
          ...(host ? { host } : {}),
          ...(upstreamFailed ? { failure: { kind: "stream", upstreamStatus: null } as HostFailure } : {}),
        });
      },
      c.now,
    );
    return new Response(metered, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", ...quotaHeaders(input.reservedAllowance) },
    });
  }

  const text = await response.text();
  const parsed = parseJson(text) as { usage?: unknown; error?: unknown } | undefined;
  const usage = parseUsage(parsed?.usage);
  const host = hostOf(parsed);
  const failure: HostFailure | undefined = parsed?.error ? { kind: "error_body", upstreamStatus: null } : undefined;
  const allowance = await settle(usage, usage ? "ok" : "no_usage", {
    ttfbMs,
    ttftMs: c.now() - started,
    outputTokens: usage ? 0 : streamedOutputTokens(outputChars(parsed), 0),
    ...(failure ? { upstreamError: true } : {}),
    ...(host ? { host } : {}),
    ...(failure ? { failure } : {}),
  });
  return new Response(text, {
    status: 200,
    headers: { "content-type": contentType || "application/json", "cache-control": "no-store", ...quotaHeaders(allowance) },
  });
}

type Settle = (
  usage: Usage | undefined,
  status: string,
  options?: { chargeNothing?: boolean; ttfbMs?: number; ttftMs?: number; upstreamError?: boolean; outcome?: UpstreamOutcome; creditUsd?: number; outputTokens?: number },
) => Promise<Allowance>;

/** One more place to send a request that failed before any bytes: the model as `provider` serves it, and whether it is another model (the fallback). */
type Step = { model: FreeModel; provider: Upstream; fallback: boolean };

/**
 * One request to Luminal. There is no switch to OpenRouter on failure: a 429, a 5xx, no
 * response before the first-byte timeout, or a network error goes back to the client as a
 * transient error with Retry-After, and the client retries. A stream that fails part way is
 * passed through as it is, like OpenRouter's.
 */
async function luminalChat(
  c: Ctx,
  input: {
    model: FreeModel;
    body: Record<string, unknown>;
    stream: boolean;
    maxTokens: number;
    user: string;
    started: number;
    settle: Settle;
    timeoutSeconds: number;
    reservedAllowance: Allowance;
  },
): Promise<Response> {
  const { body, stream } = input;
  const payload: Record<string, unknown> = { ...body, model: input.model.upstreamModel, max_completion_tokens: input.maxTokens, user: input.user };
  // OpenRouter's `reasoning: {effort}` is `reasoning_effort` in the OpenAI shape.
  const effort = (body.reasoning as { effort?: unknown } | undefined)?.effort;
  if (typeof effort === "string" && payload.reasoning_effort === undefined) payload.reasoning_effort = effort;
  for (const field of OPENROUTER_ONLY_FIELDS) delete payload[field];
  if (stream) payload.stream_options = { include_usage: true };
  else delete payload.stream_options;
  return compatibleChat(c, { upstream: "luminal", url: LUMINAL_URL, key: c.config.luminalApiKey, payload }, input);
}

/**
 * One request to Liquid Inference (providers.ts): the client's request as `liquidPayload` shapes
 * it, with the model's exchange rules. Failures go back as Luminal's do (transient, with
 * Retry-After), or with `retry` (a model with another upstream: GLM 5.3 Flash → Open Relay) go
 * there; "no eligible offer" (400 `no_eligible_offer`) counts as such a failure. The credit is
 * charged what the exchange reports it charged, when it says.
 */
async function liquidChat(
  c: Ctx,
  input: {
    model: FreeModel;
    config: FreeConfig;
    body: Record<string, unknown>;
    stream: boolean;
    maxTokens: number;
    user: string;
    sessionId: string | undefined;
    started: number;
    settle: Settle;
    timeoutSeconds: number;
    reservedAllowance: Allowance;
    retry?: () => Promise<Response>;
  },
): Promise<Response> {
  const rules = exchangeRules(input.config, input.model)!;
  const payload = liquidPayload(input.body, { model: input.model, maxTokens: input.maxTokens, stream: input.stream, user: input.user, sessionId: input.sessionId, rules });
  return compatibleChat(c, { upstream: "liquid", url: LIQUID_URL, key: c.config.liquidApiKey, payload }, input);
}

/**
 * One request to Open Relay (providers.ts): the client's request as `openRelayPayload` shapes it.
 * Failures go back as Luminal's do (429, 502 and 503 are transient, with Retry-After), or with
 * `retry` (GLM 5.3 Flash: DeepSeek) go there; past a limit the fallback is decided before this (see chat). The credit is charged the cost Open Relay
 * reports (`openrelay.cost_nano_usd`), else the usage at the model's prices; a stream cut off
 * before its last chunk isn't billed by Open Relay; the person is charged the output it streamed (see settle).
 */
async function openRelayChat(
  c: Ctx,
  input: {
    model: FreeModel;
    body: Record<string, unknown>;
    stream: boolean;
    maxTokens: number;
    user: string;
    started: number;
    settle: Settle;
    timeoutSeconds: number;
    reservedAllowance: Allowance;
    retry?: () => Promise<Response>;
  },
): Promise<Response> {
  const payload = openRelayPayload(input.body, { model: input.model, maxTokens: input.maxTokens, stream: input.stream, user: input.user });
  return compatibleChat(c, { upstream: "openrelay", url: OPENRELAY_URL, key: c.config.openrelayApiKey, payload }, input);
}

/**
 * One chat completions request to Luminal, Liquid or Open Relay, already in its shape. With
 * `retry`, a failure before anything reaches the client (429, 5xx, a timeout or network error,
 * Liquid's "no eligible offer", or the provider refusing the service's key) is settled as
 * nothing charged and handed to it instead of going back.
 */
async function compatibleChat(
  c: Ctx,
  target: { upstream: "luminal" | "liquid" | "openrelay"; url: string; key: string | undefined; payload: Record<string, unknown> },
  input: { stream: boolean; started: number; settle: Settle; timeoutSeconds: number; reservedAllowance: Allowance; retry?: () => Promise<Response> },
): Promise<Response> {
  const { stream, started, settle } = input;
  const { payload } = target;

  const transient = async (status: 429 | 503, code: string, message: string, retryAfterHeader: string | null, record: { status: string; outcome: UpstreamOutcome; ttfbMs?: number }) => {
    const allowance = await settle(undefined, record.status, { chargeNothing: true, upstreamError: true, outcome: record.outcome, ...(record.ttfbMs !== undefined ? { ttfbMs: record.ttfbMs } : {}) });
    if (input.retry) return input.retry();
    const retryAfter = Math.max(1, Math.ceil(Number(retryAfterHeader)) || DEFAULT_RETRY_AFTER_S);
    return apiError(status, code, message, { retryAfter, retryable: true, upstream: target.upstream }, { ...quotaHeaders(allowance), "retry-after": String(retryAfter) });
  };

  let response: Response | "timeout";
  try {
    response = await fetchWithTimeout(
      c.fetch,
      target.url,
      {
        method: "POST",
        headers: { authorization: `Bearer ${target.key}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
      input.timeoutSeconds * 1000,
    );
  } catch {
    return transient(503, "upstream_unavailable", UPSTREAM_UNAVAILABLE_MESSAGE, null, { status: "upstream_unreachable", outcome: "error" });
  }
  if (response === "timeout") return transient(503, "upstream_timeout", UPSTREAM_TIMEOUT_MESSAGE, null, { status: "upstream_timeout", outcome: "timeout" });
  const ttfbMs = c.now() - started;

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const retryAfter = response.headers.get("retry-after");
    if (response.status === 429) return transient(429, "upstream_busy", UPSTREAM_BUSY_MESSAGE, retryAfter, { status: "upstream_busy", outcome: "rate_limited", ttfbMs });
    if (response.status >= 500) return transient(503, "upstream_unavailable", UPSTREAM_UNAVAILABLE_MESSAGE, retryAfter, { status: "upstream_error", outcome: "error", ttfbMs });
    // Liquid: no seller's offer passes the rules right now (live: 400, code `no_eligible_offer`).
    if (target.upstream === "liquid" && noEligibleOffer(text)) return transient(503, "upstream_unavailable", UPSTREAM_UNAVAILABLE_MESSAGE, retryAfter, { status: "upstream_no_offer", outcome: "error", ttfbMs });
    // A 4xx: the request itself (400), or the service's key or account (401, 402, 403).
    const ours = response.status === 401 || response.status === 402 || response.status === 403;
    if (ours && input.retry) {
      await settle(undefined, "upstream_error", { chargeNothing: true, ttfbMs, upstreamError: true });
      return input.retry();
    }
    const allowance = await settle(undefined, "upstream_error", { chargeNothing: true, ttfbMs, ...(ours ? { upstreamError: true } : {}) });
    return apiError(ours ? 502 : 400, "upstream_error", ours ? "The model provider refused the service's key. Try again later." : upstreamRefusal(text).message, ours ? { upstreamStatus: response.status } : upstreamDetails(response.status, text), quotaHeaders(allowance));
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (stream && response.body && contentType.includes("text/event-stream")) {
    const metered = meterStream(
      response.body,
      async ({ usage, errored, upstreamFailed, firstContentAt, chargeUsd, outputTokens }) => {
        await settle(usage, usage ? (errored ? "stream_error" : "ok") : "no_usage", {
          ttfbMs,
          outputTokens,
          ...(firstContentAt !== undefined ? { ttftMs: firstContentAt - started } : {}),
          ...(upstreamFailed ? { upstreamError: true } : {}),
          ...(chargeUsd !== undefined ? { creditUsd: chargeUsd } : {}),
        });
      },
      c.now,
    );
    return new Response(metered, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", ...quotaHeaders(input.reservedAllowance) },
    });
  }

  const text = await response.text();
  const parsed = parseJson(text) as { usage?: unknown; error?: unknown } | undefined;
  const usage = mergedUsage(parseUsage(parsed?.usage), exchangeUsage(parsed));
  const charge = reportedCharge(parsed, response.headers.get("openrelay-cost-nano-usd"));
  const allowance = await settle(usage, usage ? "ok" : "no_usage", { ttfbMs, ttftMs: c.now() - started, outputTokens: usage ? 0 : streamedOutputTokens(outputChars(parsed), 0), ...(parsed?.error ? { upstreamError: true } : {}), ...(charge !== undefined ? { creditUsd: charge } : {}) });
  return new Response(text, {
    status: 200,
    headers: { "content-type": contentType || "application/json", "cache-control": "no-store", ...quotaHeaders(allowance) },
  });
}

/** Whether a Liquid error body says no offer met the request's rules (`error.code` "no_eligible_offer"). */
export function noEligibleOffer(text: string): boolean {
  const parsed = parseJson(text) as { error?: { code?: unknown } } | undefined;
  return parsed?.error?.code === "no_eligible_offer";
}

/**
 * One request to OpenAI, the default provider, through the Responses API: the client's chat
 * completions request is translated to a Responses request, and the answer back to a chat
 * completion or chunk stream (see openai-responses.ts). On a 429, a 5xx, a network error or no
 * response before the first-byte timeout, it retries once on the model's fallback (DeepSeek on
 * Luminal) when the caller gave one. A 4xx about the request itself is passed through.
 */
async function openaiChat(
  c: Ctx,
  input: {
    model: FreeModel;
    body: Record<string, unknown>;
    stream: boolean;
    maxTokens: number;
    user: string;
    sessionId: string | undefined;
    started: number;
    settle: Settle;
    timeoutSeconds: number;
    reservedAllowance: Allowance;
    /** Retries on the model's fallback; undefined when it has none. */
    retry?: () => Promise<Response>;
  },
): Promise<Response> {
  const { body, stream, started, settle } = input;
  const payload = toResponsesRequest(body, { model: input.model.upstreamModel, maxTokens: input.maxTokens, user: input.user, stream });

  const transient = async (status: 429 | 503, code: string, message: string, retryAfterHeader: string | null, record: { status: string; outcome: UpstreamOutcome; ttfbMs?: number }) => {
    const allowance = await settle(undefined, record.status, { chargeNothing: true, upstreamError: true, outcome: record.outcome, ...(record.ttfbMs !== undefined ? { ttfbMs: record.ttfbMs } : {}) });
    if (input.retry) return input.retry();
    const retryAfter = Math.max(1, Math.ceil(Number(retryAfterHeader)) || DEFAULT_RETRY_AFTER_S);
    return apiError(status, code, message, { retryAfter, retryable: true, upstream: "openai" }, { ...quotaHeaders(allowance), "retry-after": String(retryAfter) });
  };

  let response: Response | "timeout";
  try {
    response = await fetchWithTimeout(
      c.fetch,
      OPENAI_URL,
      {
        method: "POST",
        headers: { authorization: `Bearer ${c.config.openaiApiKey}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
      input.timeoutSeconds * 1000,
    );
  } catch {
    return transient(503, "upstream_unavailable", UPSTREAM_UNAVAILABLE_MESSAGE, null, { status: "upstream_unreachable", outcome: "error" });
  }
  if (response === "timeout") return transient(503, "upstream_timeout", UPSTREAM_TIMEOUT_MESSAGE, null, { status: "upstream_timeout", outcome: "timeout" });
  const ttfbMs = c.now() - started;

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const retryAfter = response.headers.get("retry-after");
    if (response.status === 429) return transient(429, "upstream_busy", UPSTREAM_BUSY_MESSAGE, retryAfter, { status: "upstream_busy", outcome: "rate_limited", ttfbMs });
    if (response.status >= 500) return transient(503, "upstream_unavailable", UPSTREAM_UNAVAILABLE_MESSAGE, retryAfter, { status: "upstream_error", outcome: "error", ttfbMs });
    // 402 is OpenAI's "out of credit": the fallback is the whole point of it.
    if (response.status === 402) return transient(503, "upstream_credit_exhausted", CREDIT_EXHAUSTED_MESSAGE, retryAfter, { status: "upstream_error", outcome: "error", ttfbMs });
    // 401/403: the service's key or account.
    const ours = response.status === 401 || response.status === 403;
    const allowance = await settle(undefined, "upstream_error", { chargeNothing: true, ttfbMs, ...(ours ? { upstreamError: true } : {}) });
    return apiError(ours ? 502 : 400, "upstream_error", ours ? "The model provider refused the service's key. Try again later." : upstreamRefusal(text).message, ours ? { upstreamStatus: response.status } : upstreamDetails(response.status, text), quotaHeaders(allowance));
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (stream && response.body && contentType.includes("text/event-stream")) {
    const metered = meterStream(
      toChatStream(response.body),
      async ({ usage, errored, upstreamFailed, firstContentAt, outputTokens }) => {
        await settle(usage, usage ? (errored ? "stream_error" : "ok") : "no_usage", {
          ttfbMs,
          outputTokens,
          ...(firstContentAt !== undefined ? { ttftMs: firstContentAt - started } : {}),
          ...(upstreamFailed ? { upstreamError: true } : {}),
        });
      },
      c.now,
    );
    return new Response(metered, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", ...quotaHeaders(input.reservedAllowance) },
    });
  }

  const upstreamText = await response.text();
  const upstream = parseJson(upstreamText) as { error?: unknown } | undefined;
  // A finished response becomes a chat completion; anything else (an error body) passes as it is.
  const translated = isResponse(upstream) && !upstream.error;
  const text = translated ? JSON.stringify(toChatCompletion(upstream)) : upstreamText;
  const parsed = parseJson(text) as { usage?: unknown; error?: unknown } | undefined;
  const usage = parseUsage(parsed?.usage);
  const allowance = await settle(usage, usage ? "ok" : "no_usage", { ttfbMs, ttftMs: c.now() - started, outputTokens: usage ? 0 : streamedOutputTokens(outputChars(parsed), 0), ...(parsed?.error ? { upstreamError: true } : {}) });
  return new Response(text, {
    status: 200,
    headers: { "content-type": translated ? "application/json" : contentType || "application/json", "cache-control": "no-store", ...quotaHeaders(allowance) },
  });
}

/**
 * `fetch`, or "timeout" when no response (headers) arrived within `ms`; the request is then
 * aborted. A network error still throws.
 */
async function fetchWithTimeout(fetcher: Fetch, url: string, init: RequestInit, ms: number): Promise<Response | "timeout"> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  const request = fetcher(url, { ...init, signal: controller.signal });
  try {
    const result = await Promise.race([request, timeout]);
    if (result === "timeout") {
      controller.abort();
      // The aborted request rejects later; nothing waits for it.
      request.catch(() => undefined);
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * A provider refusal's details: its HTTP status and, when it gave a plain identifier as its code
 * or type, that as `upstreamReason`. Never the provider's message (upstream-errors.ts).
 */
function upstreamDetails(status: number, text: string): Record<string, unknown> {
  const { reason } = upstreamRefusal(text);
  return { upstreamStatus: status, ...(reason ? { upstreamReason: reason } : {}) };
}

// ─── Admin ──────────────────────────────────────────────────────────────────

async function admin(c: Ctx, rest: string, method: string): Promise<Response> {
  const identity = await authenticate(c);
  if (identity instanceof Response) return identity;
  if (!c.config.adminGithubIds.has(identity.githubId)) return apiError(403, "forbidden", "Admins only.");
  const retry = await limited(c, `admin:gh:${identity.githubId}`, LIMITS.apiPerson);
  if (retry !== undefined) return rateLimited(retry);
  const now = c.now();
  const { config, paused } = await runtime(c);
  const limits = limitsFor(config);
  const actor = { githubId: identity.githubId, login: identity.login, now };
  // dl.new's paid plans: unclaimed payments, refunds (paid-web.ts).
  if (rest.startsWith("paid/")) return paidAdmin(c, rest.slice("paid/".length), method);

  if (method === "GET" && rest === "metrics") return adminMetrics(c);
  if (method === "GET" && rest === "no-github") {
    // "Don't have GitHub?" clicks per day and source over ?days= (1 to 366, default 30), and the answers.
    const raw = c.url.searchParams.get("days");
    const days = raw === null ? 30 : Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > 366) return apiError(400, "invalid_request", "Use ?days=1 to 366.");
    const until = Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;
    return json({ days, ...noGithubJson(await directory(c).noGithub({ from: until - days * DAY_MS, until })) });
  }
  if (method === "GET" && rest === "provider-inquiries") {
    // dl.new/providers' inquiries (provider-inquiry.ts), newest first. User content.
    return json(providerInquiriesJson(await directory(c).providerInquiries()));
  }
  if (method === "GET" && rest === "providers") {
    // Each provider's credit (balance, used, left, this week, the probes' share) and the speed
    // probes over ?hours= (1 to 360, default 24), newest first. Admins only: amounts live here,
    // never in the public /v1/providers.
    const raw = c.url.searchParams.get("hours");
    const hours = raw === null ? 24 : Number(raw);
    if (!Number.isInteger(hours) || hours < 1 || hours > 360) return apiError(400, "invalid_request", "Use ?hours=1 to 360.");
    const view = await directory(c).providersAdmin(now, policyOf(c.config), now - hours * 3_600_000);
    return json({
      hours,
      providers: view.providers,
      probes: view.probes.map((probe) => ({ ...probe, at: new Date(probe.at).toISOString() })),
    });
  }
  if (method === "GET" && rest === "tool-usage") {
    // Which tools people use dl API keys in (tool-keys.ts): per tool, over ?days= (1 to 30,
    // default 7), requests, people and charged tokens, from the request log (so within its
    // retention). Names only, from the User-Agent; counts, no content.
    const raw = c.url.searchParams.get("days");
    const days = raw === null ? 7 : Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > 30) return apiError(400, "invalid_request", "Use ?days=1 to 30.");
    return json({ days, tools: await directory(c).toolUsage(now - days * DAY_MS) });
  }
  if (method === "GET" && rest === "uses") {
    // Recent use descriptions: ?days= (1 to 90, default 7), ?risk= (none: all, the default; low:
    // low and high; high), ?githubId=, ?limit= (1 to 1000, default 200). Newest first.
    const params = c.url.searchParams;
    const days = params.get("days") === null ? 7 : Number(params.get("days"));
    const risk = params.get("risk") ?? "none";
    const limit = params.get("limit") === null ? 200 : Number(params.get("limit"));
    const githubId = params.get("githubId") === null ? undefined : Number(params.get("githubId"));
    if (!Number.isInteger(days) || days < 1 || days > USE_KEEP_DAYS || !isUseRisk(risk) || !Number.isInteger(limit) || limit < 1 || limit > 1000 || (githubId !== undefined && (!Number.isSafeInteger(githubId) || githubId <= 0))) {
      return apiError(400, "invalid_request", `Use ?days=1 to ${USE_KEEP_DAYS}, ?risk=none|low|high (that risk or worse), ?githubId= and ?limit=1 to 1000.`);
    }
    const rows = await directory(c).useDescriptions({ since: now - days * DAY_MS, minRisk: risk, limit, ...(githubId !== undefined ? { githubId } : {}) });
    return json({ days, risk, uses: rows.map((row) => ({ ...row, at: new Date(row.at).toISOString() })) });
  }
  if (method === "GET" && rest === "moderation") {
    // Automated moderation decisions: ?days= (1 to 90, default 7), ?verdict= (block, watch or
    // pass; all by default), ?limit= (1 to 1000, default 200). Newest first. No user content.
    const params = c.url.searchParams;
    const days = params.get("days") === null ? 7 : Number(params.get("days"));
    const verdict = params.get("verdict") || undefined;
    const limit = params.get("limit") === null ? 200 : Number(params.get("limit"));
    if (!Number.isInteger(days) || days < 1 || days > USE_KEEP_DAYS || (verdict !== undefined && !(MODERATION_VERDICTS as readonly string[]).includes(verdict)) || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
      return apiError(400, "invalid_request", `Use ?days=1 to ${USE_KEEP_DAYS}, ?verdict=block|watch|pass and ?limit=1 to 1000.`);
    }
    const rows = await directory(c).moderationDecisions({ since: now - days * DAY_MS, limit, ...(verdict ? { verdict: verdict as ModerationVerdict } : {}) });
    return json({
      days,
      verdict: verdict ?? null,
      decisions: rows.map((row) => ({ login: row.login, githubId: row.githubId, verdict: row.verdict, confidence: row.confidence, reason: row.reason, action: row.action, category: row.category, sessionId: row.sessionId, labelId: row.labelId, model: row.model, error: row.error, at: new Date(row.at).toISOString() })),
    });
  }
  if (method === "GET" && rest === "allocator") {
    // Token allocator decisions and graces (allocator.ts): ?days= (1 to 90, default 7), ?limit=
    // (1 to 1000, default 200), newest first, and counts per UTC day. No content.
    const params = c.url.searchParams;
    const days = params.get("days") === null ? 7 : Number(params.get("days"));
    const limit = params.get("limit") === null ? 200 : Number(params.get("limit"));
    if (!Number.isInteger(days) || days < 1 || days > 90 || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
      return apiError(400, "invalid_request", "Use ?days=1 to 90 and ?limit=1 to 1000.");
    }
    const report = await directory(c).allocatorReport({ since: now - days * DAY_MS, limit, days, now });
    return json({ days, allocator: config.allocator, decisions: report.decisions.map((row) => ({ ...row, at: new Date(row.at).toISOString() })), daily: report.daily });
  }
  if (method === "POST" && rest === "recheck-below-bar") {
    const body = (await readJson(c)) ?? {};
    return json(await recheckBelowBar(c, config, actor, body.includeAdminStarters === true));
  }
  if (method === "GET" && rest === "access-requests") {
    const pending = await directory(c).pendingAccessRequests(now);
    return json({ requests: pending.map((request) => ({ ...request, at: new Date(request.at).toISOString() })) });
  }
  const decide = /^access-requests\/(\d+)\/(grant|decline)$/.exec(rest);
  if (decide && method === "POST") {
    const body = (await readJson(c)) ?? {};
    const note = typeof body.note === "string" && body.note.trim() !== "" ? body.note.trim().slice(0, 300) : null;
    const usd = parseGrantUsd(body.usdPerWeek);
    if (usd === "invalid" || (usd !== undefined && typeof body.usdPerWeek !== "number")) return apiError(400, "invalid_request", GRANT_USD_USAGE);
    const result = await decideAccessRequest(c, config, Number(decide[1]), decide[2] as "grant" | "decline", note, actor, usd);
    return "code" in result ? failed(result) : json(result);
  }
  if (method === "POST" && rest === "emails/test") return adminTestEmail(c, identity.githubId);
  if (method === "GET" && rest === "emails/weekly-reset") return adminWeeklyResetPreview(c, config, identity.githubId);
  if (method === "POST" && rest === "emails/broadcast") return adminBroadcast(c, config);
  if (method === "POST" && rest === "grant") {
    const body = (await readJson(c)) ?? {};
    const logins = body.logins;
    const usage = `Send {logins: ["octocat", ...]}: 1 to ${MAX_GRANT_LOGINS} GitHub usernames (a leading @ or a github.com URL is fine).`;
    if (!Array.isArray(logins) || logins.length === 0 || logins.length > MAX_GRANT_LOGINS || !logins.every((login) => typeof login === "string")) return apiError(400, "invalid_request", usage);
    const usd = parseGrantUsd(body.usdPerWeek);
    if (usd === "invalid" || (usd !== undefined && typeof body.usdPerWeek !== "number")) return apiError(400, "invalid_request", GRANT_USD_USAGE);
    const results = await grantLogins(c, config, logins.join("\n"), actor, usd);
    return "status" in results ? failed(results) : json({ results });
  }
  if (method === "GET" && rest === "spend") {
    const spend = await directory(c).spend(now);
    return json({
      ...spend,
      weekStart: new Date(spend.weekStart).toISOString(),
      resetsAt: new Date(spend.resetsAt).toISOString(),
      paid: { usd: spend.paidUsd, tokens: spend.paidTokens, requests: spend.paidRequests },
      // The service's own model calls this week (use descriptions): never a person's allowance or the caps.
      internal: { usd: spend.internalUsd, creditUsd: spend.internalCreditUsd, tokens: spend.internalTokens, requests: spend.internalRequests },
      upstream: {
        primary: config.primaryUpstream,
        serving: chooseUpstream(config.primaryUpstream, c.config) ?? "none",
        openaiConfigured: c.config.openaiApiKey !== undefined,
        luminalConfigured: c.config.luminalApiKey !== undefined,
      },
      openaiCredit: {
        balanceUsd: config.openaiCreditUsd,
        usedUsd: spend.openaiCreditUsedUsd,
        leftUsd: Math.max(0, Math.round((config.openaiCreditUsd - spend.openaiCreditUsedUsd) * 1e6) / 1e6),
        weekUsd: spend.openaiCreditWeekUsd,
        freeWeekUsd: spend.openaiFreeCreditWeekUsd,
        weeklyBudgetUsd: config.openaiWeeklyCreditUsd ?? null,
      },
      luminalCredit: {
        balanceUsd: config.luminalCreditUsd,
        usedUsd: spend.creditUsedUsd,
        leftUsd: Math.max(0, Math.round((config.luminalCreditUsd - spend.creditUsedUsd) * 1e6) / 1e6),
        weekUsd: spend.creditWeekUsd,
        freeWeekUsd: spend.freeCreditWeekUsd,
        weeklyBudgetUsd: config.luminalWeeklyCreditUsd ?? null,
      },
      caps: {
        globalWeeklyUsd: config.globalWeeklyUsdCap ?? null,
        globalTotalUsd: config.globalTotalUsdCap ?? null,
        // The per-person weekly budgets of a Full account: GPT-6 (every GPT-6 model) and DeepSeek.
        perPersonWeeklyUsd: config.perPersonWeeklyUsdCap ?? null,
        deepseekWeeklyUsd: config.deepseekWeeklyUsdCap ?? null,
        weeklyTokens: config.weeklyTokens,
      },
      paused,
      pausedByEnv: c.config.paused,
    });
  }
  if (method === "POST" && (rest === "pause" || rest === "unpause")) {
    if (await directory(c).setPaused(rest === "pause", actor)) await alert(c, [pauseAlert(rest === "pause", identity.login)]);
    return json({ paused: c.config.paused || rest === "pause", pausedByEnv: c.config.paused });
  }
  if (rest === "config") {
    if (method === "POST") {
      const body = await readJson(c);
      if (!body) return apiError(400, "invalid_request", "Send a JSON object of settings, e.g. {\"weeklyTokens\": 60000000}.");
      const parsed = parseSettingsUpdate(body);
      if ("error" in parsed) return apiError(400, "invalid_request", parsed.error);
      await directory(c).updateOverrides(parsed.changes, actor);
      return adminConfigView(c);
    }
    if (method === "GET") return adminConfigView(c);
  }
  if (rest === "queue" && method === "GET") {
    const queue = await directory(c).queueView(now, policyOf(c.config));
    return json({
      waiting: queue.waiting.map((person) => ({ ...person, queuedAt: new Date(person.queuedAt).toISOString() })),
      runs: queue.runs.map((run) => ({ ...run, weekStart: isoDay(run.weekStart), ranAt: new Date(run.ranAt).toISOString() })),
      forecast: { ...queue.forecast, room: queue.forecast.room === Number.MAX_SAFE_INTEGER ? null : queue.forecast.room },
    });
  }
  if (rest === "queue/admit" && method === "POST") {
    const body = (await readJson(c)) ?? {};
    const count = Number(body.count);
    if (!Number.isInteger(count) || count < 1 || count > 10_000) return apiError(400, "invalid_request", "Send {count}: 1 to 10000 people to let in now, front of the line first.");
    return json({ admitted: await directory(c).admitFromQueue(count, now, policyOf(c.config)) });
  }
  if (rest === "invites") {
    if (method === "GET") return json({ invites: await directory(c).listInvites() });
    if (method === "POST") {
      const body = (await readJson(c)) ?? {};
      const count = body.count === undefined ? 1 : Number(body.count);
      if (!Number.isInteger(count) || count < 1 || count > 100) return apiError(400, "invalid_request", "count must be 1 to 100.");
      const note = typeof body.note === "string" ? body.note.slice(0, 200) : null;
      return json({ invites: await directory(c).createInvites({ count, note, createdBy: identity.githubId, now }) }, 201);
    }
  }
  if (rest === "event-codes") {
    if (method === "GET") return json({ eventCodes: (await directory(c).listEventCodes(now)).map(eventCodeView) });
    if (method === "POST") {
      const input = parseEventCodeInput((await readJson(c)) ?? {});
      if ("error" in input) return apiError(400, "invalid_request", input.error);
      const made = await directory(c).createEventCode({ ...input, createdBy: identity.githubId, now });
      return json({ id: made.id, code: made.code, maxUses: input.maxUses, full: input.full, note: input.note, expiresAt: new Date(made.expiresAt).toISOString() }, 201);
    }
  }
  const endEvent = /^event-codes\/(\d+)\/end$/.exec(rest);
  if (endEvent && method === "POST") {
    if (!(await directory(c).endEventCode(Number(endEvent[1]), now))) return apiError(404, "not_found", "No such event code, or it already ended.");
    return json({ ended: true });
  }
  if (method === "POST" && rest === "reset-week") {
    const body = (await readJson(c)) ?? {};
    if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") return apiError(400, "invalid_request", "Send {dryRun: true} to count first, or {} to reset.");
    return json(await resetWeek(c, now, body.dryRun === true));
  }
  if (method === "GET" && rest === "people") {
    const levelFilter = c.url.searchParams.get("level");
    const sharedOnly = c.url.searchParams.get("shared") === "1";
    const page = peoplePage(c.url.searchParams);
    if ("error" in page) return apiError(400, "invalid_request", page.error);
    // The Directory's per-person data in a few whole-table reads, not one call per person.
    const people = await directory(c).listPeople();
    const [caps, networks, sessions, trialBonus, harnessUsage, uses, allocatorStates, trusts] = await Promise.all([
      directory(c).personalCaps(),
      directory(c).networkCounts(),
      directory(c).weekSessions(now),
      directory(c).trialBonuses(policyOf(config)),
      directory(c).weekHarnessUsage(now),
      directory(c).useSummaries(weekStart(now)),
      directory(c).allocatorStates(),
      directory(c).gpt6TrustAll({ now, adminIds: [...c.config.adminGithubIds] }),
    ]);
    const checks = peopleChecks(people, config, now, await directory(c).eventCodeSignups());
    // Filter and page before any account call, so a page costs one account call per person on it.
    const ordered = people
      .filter((person) => (levelFilter === null || person.level === levelFilter) && (!sharedOnly || (networks.get(person.github_id) ?? 0) > 1))
      .sort((a, b) => a.admitted_at - b.admitted_at || a.github_id - b.github_id);
    const from = page.after === undefined ? 0 : ordered.findIndex((person) => peopleCursor(person) > page.after!);
    const slice = from < 0 ? [] : page.limit === undefined ? ordered.slice(from) : ordered.slice(from, from + page.limit);
    const last = slice.at(-1);
    const nextCursor = page.limit !== undefined && last !== undefined && from + slice.length < ordered.length ? peopleCursor(last) : null;
    // One account call per person (allowance and key count together), at most ADMIN_PEOPLE_CONCURRENCY at once:
    // hundreds of Durable Object calls started together drop connections (Cloudflare error 1101).
    const rows = await mapLimited(slice, ADMIN_PEOPLE_CONCURRENCY, async (person) => {
      const trial = onTrial(config, person.github_id, person.admitted_at);
      // As the person's own requests get it: the level, then the token allocator (its start grant,
      // the step reached and this week's grace). Referral bonuses aren't counted here.
      const levelLimitsNow = limitsFor(config, 0, person.level, person.batch_flag === 1, trial, trialBonus.get(person.github_id));
      const limits = allocated(config, levelLimitsNow, person.github_id, { blocked: person.status === "blocked", bonusTokens: 0, allocator: allocatorStates.get(person.github_id) ?? null }, now);
      const { allowance, serverKeys, toolKeys } = await account(c, person.github_id).adminSummary(now, limits);
      return {
        githubId: person.github_id,
        login: person.login,
        status: person.status,
        isAdmin: c.config.adminGithubIds.has(person.github_id),
        admittedAt: new Date(person.admitted_at).toISOString(),
        admittedVia: person.admitted_via,
        // "trial": admitted at or after the trial cutoff, held to the one-time trial on the free plan;
        // "grandfathered": the weekly free allowance as before (everyone, while the trial is off).
        access: trial ? "trial" : "grandfathered",
        trial: trialView(allowance),
        level: person.level,
        levelReason: person.level_reason,
        // On the `freeForever` list: free tokens never end for them (moderation, caps and blocks still apply).
        freeForever: config.freeForever.includes(person.github_id),
        signals: {
          accountAgeDays: person.account_age_days,
          publicRepos: person.public_repos,
          followers: person.followers,
          contributions: person.contributions,
          restrictedContributions: person.restricted_contributions,
          githubCreatedDay: person.github_created_day === null ? null : isoDay(person.github_created_day * DAY_MS),
          activeWeeks: person.active_weeks,
          outsideContributions: person.outside_contributions,
          oldestRepoCreatedAt: person.oldest_repo_at === null ? null : new Date(person.oldest_repo_at).toISOString(),
          social: person.social,
          checkedAt: person.signals_at === null ? null : new Date(person.signals_at).toISOString(),
        },
        // Which checks the stored signals pass under today's settings: why someone is Starter.
        checks: checks.get(person.github_id),
        // The contact email from the sign-in step, and whether they asked for product updates.
        contact: { address: person.email ?? null, updates: person.email_updates === null ? null : person.email_updates === 1 },
        networks: networks.get(person.github_id) ?? 0,
        allowance: allowanceView(allowance),
        // An admin's own weekly caps for this person (a grant, or POST /admin/people/:id/grant); null: the level's.
        personalCap: caps.get(person.github_id) ?? null,
        serverKeys,
        toolKeys,
        // Distinct dl sessions (from Autopilot's session events) since Monday 00:00 UTC.
        dlSessionsThisWeek: sessions.get(person.github_id) ?? 0,
        // Requests and charged tokens from other tools through dl (`dl claude`, `dl opencode`) since Monday 00:00 UTC.
        otherHarnessThisWeek: harnessUsage.get(person.github_id) ?? { requests: 0, tokens: 0 },
        // The automated description of their latest described session (use-description.ts), and
        // the worst safety label since Monday 00:00 UTC (null: nothing described this week).
        use: uses.get(person.github_id)?.use ?? null,
        useAt: uses.has(person.github_id) ? new Date(uses.get(person.github_id)!.at).toISOString() : null,
        worstRiskThisWeek: uses.get(person.github_id)?.worstRisk ?? null,
        // Whether GPT-6's trust gate (gpt6-trust.ts) would serve them now, and why (worked out fresh, not the hour's cache).
        gpt6Trusted: trusts.get(person.github_id)?.trusted ?? false,
        gpt6TrustReasons: trusts.get(person.github_id)?.reasons ?? ["unknown"],
      };
    });
    // Without `limit`, everyone (as before) and `nextCursor: null`; with it, pass `nextCursor` back as `cursor`.
    return json({ people: rows, nextCursor, total: ordered.length });
  }

  const match = /^people\/(\d+)(?:\/(suspend|unsuspend|block|unblock|grant|revoke-tokens|level))?$/.exec(rest);
  if (match) {
    const githubId = Number(match[1]);
    const action = match[2];
    if (!action && method === "GET") {
      const detail = await directory(c).personDetail(githubId, now);
      if (!detail) return apiError(404, "not_found", "No such person.");
      const own = await personLimits(c, config, githubId, now);
      const allowance = await account(c, githubId).allowance(now, own.limits);
      const personalCap = (await directory(c).personalCaps()).get(githubId) ?? null;
      return json({
        ...detail,
        level: own.level,
        freeForever: config.freeForever.includes(githubId),
        access: own.limits.trialTokens !== undefined ? "trial" : "grandfathered",
        trial: trialView(allowance),
        allowance: allowanceView(allowance),
        personalCap,
        serverKeys: await account(c, githubId).keyCount("server"),
        toolKeys: await account(c, githubId).keyCount("tool"),
      });
    }
    if (action === "revoke-tokens" && method === "POST") {
      // Ends every sign-in session and deletes every server key; the person can sign in again.
      if (!(await directory(c).getPerson(githubId))) return apiError(404, "not_found", "No such person.");
      return json({ githubId, ...(await revokeTokens(c, githubId, now)) });
    }
    if ((action === "suspend" || action === "unsuspend") && method === "POST") {
      const status = action === "suspend" ? "suspended" : "active";
      if (!(await directory(c).setPersonStatus(githubId, status))) return apiError(404, "not_found", "No such person.");
      await account(c, githubId).setStatus(status);
      return json({ githubId, status });
    }
    if ((action === "block" || action === "unblock") && method === "POST") {
      const status = await setBlocked(c, githubId, action === "block", actor);
      return status ? json({ githubId, status }) : apiError(404, "not_found", "No such person.");
    }
    if (action === "level" && method === "POST") {
      const body = (await readJson(c)) ?? {};
      const level = body.level;
      if (level !== "full" && level !== "basic" && level !== "starter") return apiError(400, "invalid_request", 'Send {level: "full"}, {level: "basic"} or {level: "starter"}.');
      if (!(await directory(c).setLevel(githubId, level, actor))) return apiError(404, "not_found", "No such person.");
      return json({ githubId, level });
    }
    if (action === "grant" && method === "POST") {
      const body = (await readJson(c)) ?? {};
      const tokensPerWeek = nullableWhole(body.tokensPerWeek);
      const usdPerWeek = nullableAmount(body.usdPerWeek);
      const usedThisWeek = nullableWhole(body.usedThisWeek);
      const spentUsdThisWeek = nullableAmount(body.spentUsdThisWeek);
      const deepseekSpentUsdThisWeek = nullableAmount(body.deepseekSpentUsdThisWeek);
      if ([tokensPerWeek, usdPerWeek, usedThisWeek, spentUsdThisWeek, deepseekSpentUsdThisWeek].includes("invalid") || usedThisWeek === null || spentUsdThisWeek === null || deepseekSpentUsdThisWeek === null) {
        return apiError(
          400,
          "invalid_request",
          "Send any of {tokensPerWeek, usdPerWeek} (a number, or null for the default) and {usedThisWeek, spentUsdThisWeek, deepseekSpentUsdThisWeek} (numbers; usdPerWeek and spentUsdThisWeek are GPT-6's).",
        );
      }
      const allowance = await account(c, githubId).setGrant({
        tokensPerWeek: tokensPerWeek as number | null | undefined,
        usdPerWeek: usdPerWeek as number | null | undefined,
        usedThisWeek: usedThisWeek as number | undefined,
        spentUsdThisWeek: spentUsdThisWeek as number | undefined,
        deepseekSpentUsdThisWeek: deepseekSpentUsdThisWeek as number | undefined,
        limits: (await personLimits(c, config, githubId, now)).limits,
        now,
      });
      if (!allowance) return apiError(404, "not_found", "No such person.");
      await directory(c).recordGrant({ githubId, tokensPerWeek: tokensPerWeek as number | null | undefined, usdPerWeek: usdPerWeek as number | null | undefined, at: now });
      return json({ githubId, allowance: allowanceView(allowance) });
    }
  }
  return apiError(404, "not_found", `${method} /admin/${rest} isn't a route.`);
}

/** A failure the admin JSON routes answer with apiError, and the dashboard shows as a line. */
interface AdminFailure {
  status: number;
  code: string;
  message: string;
  extra?: Record<string, unknown>;
}

const NO_EMAIL_PROVIDER: AdminFailure = { status: 503, code: "emails_unavailable", message: "No email provider: bind USER_EMAIL (Cloudflare Email Service) or set RESEND_API_KEY." };

const failed = (failure: AdminFailure) => apiError(failure.status, failure.code, failure.message, failure.extra);

/**
 * POST /admin/emails/test {kind, to} or {subject, text, to?}: one email sent to `to`, exactly as a
 * person would get it (copy, sender, Reply-To, headers, provider). With `kind`, a user email of
 * that kind; with `subject` and `text`, a one-off email as a broadcast would send it (same checks,
 * same stop footer), and `to` defaults to the admin's own contact email. Its stop link is the
 * calling admin's own. Nothing about any person changes: no user_emails row, no one-a-day cap. It
 * works while the `userEmails` setting is off, so the owner can look before turning them on.
 */
async function adminTestEmail(c: Ctx, adminId: number): Promise<Response> {
  const body = (await readJson(c)) ?? {};
  const result = await sendTestEmail(c, adminId, body);
  return "status" in result ? failed(result) : json(result);
}

async function sendTestEmail(c: Ctx, adminId: number, body: Record<string, unknown>): Promise<{ sent: true; provider: string; kind: string; to: string; messageId: string | null } | AdminFailure> {
  const kinds = Object.keys(USER_EMAILS) as UserEmailKind[];
  const typed = body.subject !== undefined || body.text !== undefined;
  const invalid = (message: string): AdminFailure => ({ status: 400, code: "invalid_request", message });
  const usage = `Send {kind, to} (kind is one of ${kinds.join(", ")}) or {subject, text, to?}; to is one email address.`;
  let to = typeof body.to === "string" ? body.to.trim() : "";
  if (typed && to === "") to = (await directory(c).getPerson(adminId))?.email ?? "";
  if (!isHeaderSafeAddress(to)) return invalid(typed && body.to === undefined ? "You have no contact email on the free tier; send {to}." : usage);
  const kind = body.kind as UserEmailKind;
  if (!typed && !kinds.includes(kind)) return invalid(usage);
  const copy = typed ? parseCopy(body.subject, body.text) : undefined;
  if (copy && !copy.ok) return invalid(copy.message);
  // The provider the real email would use: typed copy as a broadcast (bulk), a kind by its class.
  const transport = userEmailRoute(userEmailRoutesVia(c, (await runtime(c)).config), copy ? "broadcast" : kind).transport;
  if (!transport) return NO_EMAIL_PROVIDER;
  const unsubscribeUrl = await stopUrl(c.config.publicUrl ?? EMAIL_STOP_BASE, await signingKey(c.config), adminId);
  const email = copy?.ok
    ? { subject: copy.subject, body: broadcastBody(copy.text, unsubscribeUrl) }
    : renderUserEmail(kind, {
        resets: resetsText(weekEnd(c.now())),
        unsubscribeUrl,
        // weekly_reset as a Full person sees it, with the admin's own invite link.
        ...(kind === "weekly_reset" ? { weeklyReset: { tokens: c.config.weeklyTokens, fullTokens: c.config.weeklyTokens, login: ((await directory(c).getPerson(adminId))?.login ?? "dl").toLowerCase() } } : {}),
      });
  const outcome = await sendPlainEmail(transport, c.config, { to, subject: email.subject, text: email.body, unsubscribeUrl, idempotencyKey: `dl-test-email-${crypto.randomUUID()}` });
  if (!outcome.ok) return { status: 502, code: "email_failed", message: `The provider refused it, code ${outcome.code ?? "error"}.`, extra: { provider: transport.provider, code: outcome.code ?? "error" } };
  return { sent: true, provider: transport.provider, kind: copy ? "broadcast" : kind, to, messageId: outcome.messageId ?? null };
}

/**
 * POST /admin/emails/broadcast {subject, text, audience, signedUpFrom?, signedUpTo?, dryRun, skipIfSent?, githubIds?}: a
 * one-off email, see broadcast.ts, to active people of the audience's level who signed up in the
 * range (and, with githubIds, are on that list). Never to blocked or suspended accounts, people who pressed stop, or admins; each gets the
 * stop link and the List-Unsubscribe headers. The broadcast's id (a hash of subject and text) is
 * recorded per person, so a retried call never sends twice; the one-a-day cap applies, and
 * people already emailed today are left for a call tomorrow. At most BROADCAST_BATCH sends per
 * call, paced like the daily run; call again for the rest. dryRun sends nothing.
 */
async function adminBroadcast(c: Ctx, config: FreeConfig): Promise<Response> {
  const body = await readJson(c);
  const parsed = parseBroadcast(body ?? {});
  if (!parsed.ok) return apiError(400, "invalid_request", parsed.message);
  const result = await runBroadcast(c, config, parsed.value);
  return "status" in result ? failed(result) : json(result);
}

type BroadcastOutcome =
  | { dryRun: true; id: string; provider: string | null; count: number; waitingForTomorrow: number; hasCapitals: boolean; sample: Array<{ githubId: number; login: string; address: string }> }
  | { dryRun: false; id: string; provider: string; sent: number; failed: number; skipped: number; remaining: number; waitingForTomorrow: number; stoppedBy: string | null };

async function runBroadcast(c: Ctx, config: FreeConfig, request: BroadcastRequest): Promise<BroadcastOutcome | AdminFailure> {
  // Bulk mail: through Resend beside the binding while broadcastEmailProvider is "resend".
  const routes = userEmailRoutesVia(c, config);
  const transport = routes.bulk;
  if (!request.dryRun && !transport) return NO_EMAIL_PROVIDER;
  if (!request.dryRun && !config.userEmails) return { status: 409, code: "emails_off", message: "Emails to users are off (the userEmails setting)." };
  const id = await broadcastId(request.subject, request.text);
  const filter = { adminIds: [...c.config.adminGithubIds], includeAdmins: config.userEmailsToAdmins };
  const everyone = await directory(c).broadcastAudience({ id, audience: request.audience, from: request.from, to: request.to, now: c.now(), skipIfSent: request.skipIfSent, ...filter });
  const audience = onlyListed(everyone, request.githubIds);
  const ready = audience.filter((person) => !person.emailedToday);
  const waiting = audience.length - ready.length;
  if (request.dryRun) {
    return {
      dryRun: true,
      id,
      provider: transport?.provider ?? null,
      count: ready.length,
      waitingForTomorrow: waiting,
      hasCapitals: hasCapitals(request.subject, request.text),
      sample: ready.slice(0, 3).map((person) => ({ githubId: person.githubId, login: person.login, address: person.email })),
    };
  }
  const key = await signingKey(c.config);
  const base = c.config.publicUrl ?? EMAIL_STOP_BASE;
  let sent = 0;
  let failedCount = 0;
  let skipped = 0;
  let stoppedBy: string | null = null;
  // Broadcasts are bulk mail: never past the day's bulk share (email-budget.ts), or through
  // Resend, never past resendBulkDailyMax (and never the binding's budget).
  const budget = emailBudgetOf(config);
  const budgetClass = routes.bulkClass;
  const room = (await directory(c).emailBudgetToday(c.now(), budget)).room[budgetClass];
  if (room < Math.min(BROADCAST_BATCH, ready.length)) stoppedBy = "daily_budget";
  const batch = ready.slice(0, Math.min(BROADCAST_BATCH, room));
  for (const [index, person] of batch.entries()) {
    const claim = await directory(c).claimBroadcast({ githubId: person.githubId, id, now: c.now(), skipIfSent: request.skipIfSent, budget, budgetClass, ...filter });
    if (!claim) {
      skipped++;
      continue;
    }
    const unsubscribeUrl = await stopUrl(base, key, claim.githubId);
    const outcome = await sendPlainEmail(transport!, c.config, {
      to: claim.email,
      subject: request.subject,
      text: broadcastBody(request.text, unsubscribeUrl),
      unsubscribeUrl,
      idempotencyKey: `dl-broadcast-${id}-${claim.githubId}`,
    });
    await directory(c).finishUserEmail({ githubId: claim.githubId, kind: "broadcast", period: id, ok: outcome.ok, now: c.now() });
    if (outcome.ok) sent++;
    else failedCount++;
    // The provider's rate or daily limit: stop here; the rest go on a later call.
    if (outcome.code === "E_RATE_LIMIT_EXCEEDED" || outcome.code === "E_DAILY_LIMIT_EXCEEDED" || outcome.code === "http_429") {
      stoppedBy = outcome.code;
      break;
    }
    if (index < batch.length - 1 && c.emailGapMs > 0) await new Promise((resolve) => setTimeout(resolve, c.emailGapMs));
  }
  if (failedCount > 0) console.error(`user emails (broadcast via ${transport!.provider}): ${sent} sent, ${failedCount} failed`);
  else if (sent > 0) console.log(`user emails (broadcast via ${transport!.provider}): ${sent} sent`);
  return { dryRun: false, id, provider: transport!.provider, sent, failed: failedCount, skipped, remaining: ready.length - sent - skipped, waitingForTomorrow: waiting, stoppedBy };
}

/**
 * Gives free tokens to the GitHub usernames in `text` (grant.ts parseLogins; at most
 * MAX_GRANT_LOGINS, or nothing is done). Each is resolved to its id
 * through GitHub's public API, then raised to Full, left alone when blocked, or pre-granted when
 * it has no account yet. Logs counts only.
 */
async function grantLogins(c: Ctx, config: FreeConfig, text: string, actor: { githubId: number; login: string; now: number }, requestedUsd?: number): Promise<GrantResult[] | AdminFailure> {
  const { logins, invalid } = parseLogins(text);
  if (logins.length + invalid.length === 0) return { status: 400, code: "invalid_request", message: "Paste one or more GitHub usernames." };
  if (logins.length > MAX_GRANT_LOGINS) return { status: 400, code: "invalid_request", message: `At most ${MAX_GRANT_LOGINS} usernames at a time; this has ${logins.length}.` };
  const usd = grantUsd(config, requestedUsd);
  const results: GrantResult[] = [];
  for (const input of logins) {
    const user = await githubUserByLogin(input, c.fetch, GITHUB_USER_AGENT, GITHUB_CHECK_TIMEOUT_MS, githubApp(c.config));
    if (user === "not_found" || user === "error") {
      results.push({ input, outcome: user === "error" ? "github_error" : "not_found" });
      continue;
    }
    const outcome = await directory(c).grantFull(user.id, user.login, actor, usd);
    const cap = await grantCapAfter(c, user.id, outcome, usd);
    results.push({ input, outcome, login: user.login, githubId: user.id, ...(cap !== undefined ? { usdPerWeek: cap } : {}) });
  }
  for (const input of invalid) results.push({ input, outcome: "not_found" });
  const counts = new Map<string, number>();
  for (const result of results) counts.set(result.outcome, (counts.get(result.outcome) ?? 0) + 1);
  console.log(`admin grant: ${[...counts].map(([outcome, n]) => `${n} ${outcome}`).join(", ") || "nothing"}`);
  return results;
}

/**
 * The personal weekly dollar cap a grant gives: the admin's amount, or the grantWeeklyUsdCap
 * setting. Undefined for none (0, or the setting off): the grant only sets the level.
 */
function grantUsd(config: FreeConfig, requested: number | undefined): number | undefined {
  const usd = requested ?? config.grantWeeklyUsdCap;
  return usd !== undefined && usd > 0 ? usd : undefined;
}

/**
 * Raises a signed-up person's personal weekly dollar cap to `usd` (never lowers a higher one)
 * and mirrors it in the Directory's grants table. Returns the cap now in place.
 */
async function raiseGrantCap(c: Ctx, githubId: number, usd: number | undefined): Promise<number | undefined> {
  if (usd === undefined) return undefined;
  const cap = await account(c, githubId).raiseUsdCap(usd);
  if (cap !== undefined) await directory(c).recordGrant({ githubId, tokensPerWeek: undefined, usdPerWeek: cap, at: c.now() });
  return cap;
}

/**
 * After a grant's level change: the personal cap for a signed-up person (granted or already
 * Full), or the one a pre-grant keeps for the first sign-in. Undefined for none.
 */
async function grantCapAfter(c: Ctx, githubId: number, outcome: "granted" | "already_full" | "pregranted" | "blocked", usd: number | undefined): Promise<number | undefined> {
  if (outcome === "granted" || outcome === "already_full") return raiseGrantCap(c, githubId, usd);
  if (outcome === "pregranted") return (await directory(c).pregrantUsd(githubId)) ?? undefined;
  return undefined;
}

const GRANT_USD_USAGE = `usdPerWeek is optional: a number of dollars, 0 to ${MAX_GRANT_USD} (0: no personal cap, only Full). Left out: the grantWeeklyUsdCap setting.`;
const GRANT_USD_FORM_ERROR = `The weekly dollar cap must be 0 to ${MAX_GRANT_USD} (0: only Full, no personal cap).`;

/** The line after answering a request on the Tools tab. */
function requestAnswerText(result: { login: string; status: "granted" | "declined"; usdPerWeek?: number }): string {
  if (result.status === "declined") return `Declined ${result.login}'s request.`;
  const cap = result.usdPerWeek !== undefined ? ` with ${grantUsdText(result.usdPerWeek)} a week` : "";
  return `Granted: ${result.login} is Full now${cap}, and gets an email.`;
}

/** What the admin's "re-check below-bar accounts" did: counts only. */
export interface RecheckOutcome {
  /** Active non-admin Starter accounts looked at (not set by an admin or an invite). */
  checked: number;
  /** Raised to basic. */
  raised: number;
  /** Still Starter, and flagged by the creation-batch check: no free tokens. */
  flagged: number;
  /** Still Starter, not flagged: the Starter allowance. */
  starter: number;
}

/**
 * Re-evaluates every active non-admin Starter account from its stored signals (the account's
 * age counted to today from its creation day) and raises the ones that qualify to basic. Also
 * stores each one's creation-batch flag again. Never lowers anyone; blocked and suspended
 * accounts and redeemed invites are left alone, and so are admin-set Starter levels unless
 * `includeAdminStarters` ({"includeAdminStarters": true} in the body): then they're re-checked like
 * anyone else, and a raised one goes back to the automatic rules.
 */
async function recheckBelowBar(c: Ctx, config: FreeConfig, actor: { githubId: number; login: string; now: number }, includeAdminStarters = false): Promise<RecheckOutcome> {
  const now = c.now();
  const people = await directory(c).recheckSignals();
  const checks = peopleChecks(people, config, now, await directory(c).eventCodeSignups());
  const rule = basicRule(config);
  const today = Math.floor(now / DAY_MS);
  const raise: number[] = [];
  const flags: Array<{ githubId: number; flagged: boolean }> = [];
  let flagged = 0;
  for (const person of people) {
    if (person.level !== "starter" || person.status !== "active" || person.level_reason === "invite") continue;
    if (person.level_reason === "admin" && !includeAdminStarters) continue;
    if (c.config.adminGithubIds.has(person.github_id)) continue;
    const check = checks.get(person.github_id)!;
    const stored = person.account_age_days ?? 0;
    const elapsed = person.signals_at === null ? 0 : Math.max(0, Math.floor((now - person.signals_at) / DAY_MS));
    const accountAgeDays = person.github_created_day !== null && person.github_created_day !== undefined ? Math.max(0, today - person.github_created_day) : stored + elapsed;
    flags.push({ githubId: person.github_id, flagged: check.creationBatch });
    if (qualifiesForBasic({ accountAgeDays }, check, rule)) raise.push(person.github_id);
    else if (check.creationBatch) flagged++;
  }
  const { raised } = await directory(c).raiseToBasic({ raise, flags, actor, includeAdminStarters });
  console.log(`admin recheck below bar: ${flags.length} checked, ${raised} raised to basic, ${flagged} flagged`);
  return { checked: flags.length, raised, flagged, starter: flags.length - raised - flagged };
}

/**
 * An admin grants (Full, reason "admin", like the Tools tab's grant) or declines a pending
 * access request. A grant emails the person (access_granted); a decline sends nothing.
 */
async function decideAccessRequest(
  c: Ctx,
  config: FreeConfig,
  id: number,
  decision: "grant" | "decline",
  note: string | null,
  actor: { githubId: number; login: string; now: number },
  requestedUsd?: number,
): Promise<{ id: number; githubId: number; login: string; status: "granted" | "declined"; usdPerWeek?: number } | AdminFailure> {
  const usd = decision === "grant" ? grantUsd(config, requestedUsd) : undefined;
  const result = await directory(c).decideAccessRequest({ id, decision, note, actor, ...(usd !== undefined ? { usdPerWeek: usd } : {}) });
  if (!result) return { status: 404, code: "not_found", message: "No such pending request." };
  if (result.status === "blocked") return { status: 409, code: "blocked", message: `${result.login} is blocked; unblock the account first.` };
  const cap = result.outcome ? await grantCapAfter(c, result.githubId, result.outcome, usd) : undefined;
  if (result.status === "granted") {
    const person = await directory(c).getPerson(result.githubId);
    await userEmail(c, config, onTrial(config, result.githubId, person?.admitted_at) ? "access_granted_trial" : "access_granted", result.githubId, String(id));
  }
  console.log(`admin access request ${result.status}`);
  return { id, githubId: result.githubId, login: result.login, status: result.status, ...(cap !== undefined ? { usdPerWeek: cap } : {}) };
}

/**
 * Blocks or unblocks a person (people.status and the account's copy), logged in the config log.
 * Blocked: chat, refresh and server keys answer 403 "blocked", and sign-in is refused. Unblocking
 * sets the status back to active. Returns the new status, or undefined for no such person.
 */
async function setBlocked(c: Ctx, githubId: number, blocked: boolean, actor: { githubId: number; login: string; now: number }): Promise<PersonStatus | undefined> {
  const status: PersonStatus = blocked ? "blocked" : "active";
  if (!(await directory(c).setPersonStatus(githubId, status, actor))) return undefined;
  await account(c, githubId).setStatus(status);
  return status;
}

/** Ends every sign-in session of a person and deletes every key, server and tool (they can sign in again unless blocked). */
async function revokeTokens(c: Ctx, githubId: number, now: number): Promise<{ sessions: number; serverKeys: number }> {
  const sessions = await auth(c).revokeAllFor(githubId);
  await account(c, githubId).revokeSessions({ sids: sessions, until: now + REVOKED_SESSION_TTL_MS, notBefore: Math.floor(now / 1000), now });
  const serverKeys = await account(c, githubId).revokeAllKeys();
  return { sessions: sessions.length, serverKeys };
}

function nullableWhole(value: unknown): number | null | undefined | "invalid" {
  if (value === undefined || value === null) return value;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : "invalid";
}

function nullableAmount(value: unknown): number | null | undefined | "invalid" {
  if (value === undefined || value === null) return value;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : "invalid";
}

/** What GET/POST /admin/config return: effective values, env values, overrides and the change log. */
async function adminConfigView(c: Ctx): Promise<Response> {
  const gate = await directory(c).gate(c.now());
  return json({
    effective: settingsView(applyOverrides(c.config, gate.overrides)),
    env: settingsView(c.config),
    overrides: gate.overrides,
    paused: c.config.paused || gate.paused,
    pausedByEnv: c.config.paused,
    // Whether the private DETECTION_RULES secret is loaded, and counts: never the rules.
    detectionRules: c.config.detectionStatus,
    log: await directory(c).configLog(),
  });
}

async function adminMetrics(c: Ctx): Promise<Response> {
  const now = c.now();
  const parse = (name: string) => {
    const raw = c.url.searchParams.get(name);
    if (!raw) return undefined;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  };
  const to = parse("to") ?? now;
  const from = parse("from") ?? to - 27 * DAY_MS;
  if (Number.isNaN(to) || Number.isNaN(from) || from > to) return apiError(400, "invalid_request", "from and to must be ISO dates with from <= to.");
  if (to - from > 366 * DAY_MS) return apiError(400, "invalid_request", "The range can't be longer than 366 days.");
  const [metrics, refusals, noGithub, guard, pro, campaigns, weeklyReset] = await Promise.all([
    directory(c).metrics({ from, to, now, adminIds: [...c.config.adminGithubIds], rawLogKeepDays: c.config.rawLogKeepDays }),
    directory(c).refusals(Math.floor(from / DAY_MS), Math.floor(to / DAY_MS)),
    directory(c).noGithubDays({ from: Math.floor(from / DAY_MS) * DAY_MS, until: Math.floor(to / DAY_MS) * DAY_MS + DAY_MS }),
    // GPT-6's pre-send checks per UTC day, and how many non-admins its trust gate would serve now.
    directory(c).gpt6GuardMetrics({ from, to: to + DAY_MS, now, adminIds: [...c.config.adminGithubIds] }),
    // dl Pro's funnel per UTC day (people who saw the prompt, clicked Upgrade, paid, cancelled) and Pro now.
    directory(c).proFunnel({ from: Math.floor(from / DAY_MS) * DAY_MS, until: Math.floor(to / DAY_MS) * DAY_MS + DAY_MS, adminIds: [...c.config.adminGithubIds] }),
    // dl.new's link campaigns per UTC day (web-signup.ts): tags and counts only.
    directory(c).campaignRows(Math.floor(from / DAY_MS), Math.floor(to / DAY_MS)),
    // The Monday "tokens reset" email per week (its Monday): sent and failed.
    directory(c).weeklyResetCounts(from, to),
  ]);
  return json({
    ...metrics,
    refusals: refusalsView(refusals),
    noGithub,
    gpt6Guard: guard.days,
    gpt6Trusted: guard.trustedPeople,
    proFunnel: { days: pro.days, activePro: pro.activePro },
    campaigns: {
      days: campaigns.map((row) => ({ date: isoDay(row.day * DAY_MS), source: row.source, medium: row.medium, campaign: row.campaign, ref: row.ref, step: row.step, n: row.n })),
      totals: campaignTotals(campaigns),
    },
    weeklyResetEmails: weeklyReset.map((row) => ({ week: isoDay(row.week), sent: row.sent, failed: row.failed })),
    generatedAt: new Date(now).toISOString(),
    today: isoDay(now),
  });
}

// ─── Admin dashboard (browser) ──────────────────────────────────────────────
//
// GET /admin is a server-rendered page; GET /admin/dashboard/<table>.csv downloads one table.
// Both take an admin's browser session or, for scripts, an admin access token as the bearer.
//
// Browser sign-in is the OAuth web flow against the same GitHub app, with exactly its
// registered redirect_uri, /device/callback (the app matches redirect URIs exactly). GET
// /admin/signin stores a one-time `state` (hashed, 10 minutes, purpose "admin") and sets a
// SameSite=Lax cookie binding it to this browser. /device/callback finishes an admin sign-in
// when the state's stored purpose is "admin", and the device flow otherwise; the callback must
// bring back both the state and the cookie.
// Only a GitHub id in ADMIN_GITHUB_IDS gets a session: a signed token (typ "admin", 1 hour,
// with a session id) in an HttpOnly, Secure, SameSite=Strict, __Host- cookie. It can't be used
// as a bearer token, and a bearer token can't be used as it. Every request checks the id is
// still an admin and the session wasn't signed out. Pages only read, cross-site requests carry
// no Strict cookie, and the POSTs (sign-out, block/unblock from the abuse section, the
// routing setting (primaryUpstream) switch, and the Tools tab's forms) also require a same-origin request;
// all but sign-out also carry a CSRF token bound to the session.

function adminCookie(value: string, maxAge: number): string {
  return `${ADMIN_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

const CLEAR_ADMIN_OAUTH = `${ADMIN_OAUTH_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

interface AdminSession extends Identity {
  sid: string;
  exp: number;
}

/** The admin behind the session cookie, or undefined (no cookie, bad, expired, signed out, or no longer an admin). */
async function adminSession(c: Ctx): Promise<AdminSession | undefined> {
  const token = readCookie(c.request, ADMIN_COOKIE);
  if (!token) return undefined;
  const claims = await verifyJwt(token, await signingKey(c.config), Math.floor(c.now() / 1000), 0);
  if (!claims || claims.typ !== "admin" || claims.iss !== ISSUER || typeof claims.login !== "string" || typeof claims.sid !== "string") return undefined;
  const githubId = Number(claims.sub);
  if (!Number.isSafeInteger(githubId) || !c.config.adminGithubIds.has(githubId)) return undefined;
  if (!(await account(c, githubId).sessionAllowed(claims.sid, claims.iat))) return undefined;
  return { githubId, login: claims.login, sid: claims.sid, exp: claims.exp };
}

/** Whether a state-changing browser request came from this site's own page. */
function sameOrigin(c: Ctx): boolean {
  const origin = c.request.headers.get("origin");
  // `Origin: null` is what a browser sends when the page's referrer policy hides it (the
  // dashboard sends `no-referrer`). Treat it like a missing Origin and fall back to Fetch
  // Metadata, which the browser still sets for the form POST.
  if (origin !== null && origin !== "null") return origin === new URL(c.base).origin || origin === c.url.origin;
  return c.request.headers.get("sec-fetch-site") === "same-origin";
}

/** The CSRF token for the dashboard's forms: a keyed hash of the admin session's id. */
function adminCsrf(c: Ctx, session: AdminSession): Promise<string> {
  return sha256Hex(`admin-csrf:${c.config.tokenSigningKey}:${session.sid}`);
}

/** POST /admin/dashboard/people/:id/(block|unblock): a form on the dashboard, then back to it. */
async function adminWebPersonAction(c: Ctx, githubId: number, action: "block" | "unblock"): Promise<Response> {
  const session = await adminSession(c);
  if (!session) return deniedPage("Signed out", "Sign in to the dashboard again, then retry.", 401);
  const form = await readForm(c);
  if (!sameOrigin(c) || !timingSafeEqual(form.get("csrf") ?? "", await adminCsrf(c, session))) {
    return deniedPage("Not changed", "Block and unblock only from the dashboard itself.", 403);
  }
  const retry = await limited(c, `admin:gh:${session.githubId}`, LIMITS.apiPerson);
  if (retry !== undefined) return rateLimited(retry);
  const status = await setBlocked(c, githubId, action === "block", { githubId: session.githubId, login: session.login, now: c.now() });
  if (!status) return deniedPage("No such person", `No free tier account has GitHub id ${githubId}.`, 404);
  return new Response(null, { status: 303, headers: { location: "/admin?view=tools#block", "cache-control": "no-store" } });
}

/**
 * POST /admin/dashboard/upstream: the dashboard's routing setting switch. Sets the primaryUpstream
 * override (logged in the admin log like any setting), then back to the dashboard. Refused when
 * the chosen upstream has no key, since it couldn't serve.
 */
async function adminWebUpstream(c: Ctx): Promise<Response> {
  const session = await adminSession(c);
  if (!session) return deniedPage("Signed out", "Sign in to the dashboard again, then retry.", 401);
  const form = await readForm(c);
  if (!sameOrigin(c) || !timingSafeEqual(form.get("csrf") ?? "", await adminCsrf(c, session))) {
    return deniedPage("Not changed", "Switch the upstream only from the dashboard itself.", 403);
  }
  const retry = await limited(c, `admin:gh:${session.githubId}`, LIMITS.apiPerson);
  if (retry !== undefined) return rateLimited(retry);
  const choice = form.get("upstream");
  if (choice !== "openai" && choice !== "luminal" && choice !== "openrouter") return deniedPage("Not changed", "Choose OpenAI, Luminal or OpenRouter.", 400);
  const key = choice === "openai" ? c.config.openaiApiKey : choice === "luminal" ? c.config.luminalApiKey : c.config.openRouterApiKey;
  if (!key) {
    const secret = choice === "openai" ? "OPENAI_API_KEY" : choice === "luminal" ? "LUMINAL_API_KEY" : "OPENROUTER_API_KEY";
    const name = choice === "openai" ? "OpenAI" : choice === "luminal" ? "Luminal" : "OpenRouter";
    return deniedPage("Not changed", `The service has no ${secret}, so ${name} can't serve. Set the secret first.`, 409);
  }
  await directory(c).updateOverrides([{ key: "primaryUpstream", value: choice }], { githubId: session.githubId, login: session.login, now: c.now() });
  return new Response(null, { status: 303, headers: { location: "/admin?view=tools#upstream", "cache-control": "no-store" } });
}

async function adminWeb(c: Ctx, path: string, method: string): Promise<Response> {
  if (path === "/admin/signin" && method === "GET") return adminSignIn(c);
  if (path === "/admin/signout" && method === "POST") return adminSignOut(c);
  if (path === "/admin/dashboard/upstream" && method === "POST") return adminWebUpstream(c);
  if (path === "/admin/dashboard/tools" && method === "POST") return adminWebTools(c);
  const personAction = /^\/admin\/dashboard\/people\/(\d{1,15})\/(block|unblock)$/.exec(path);
  if (personAction && method === "POST") return adminWebPersonAction(c, Number(personAction[1]), personAction[2] as "block" | "unblock");
  const csv = /^\/admin\/dashboard\/([a-z-]+)\.csv$/.exec(path)?.[1];
  if (method !== "GET" || (path !== "/admin" && (csv === undefined || !isCsvTable(csv)))) {
    return apiError(404, "not_found", `${method} ${c.url.pathname} isn't a route.`);
  }

  let identity: Identity;
  let viaCookie = false;
  let csrf: string | undefined;
  if (c.request.headers.has("authorization")) {
    const caller = await authenticate(c);
    if (caller instanceof Response) return caller;
    if (!c.config.adminGithubIds.has(caller.githubId)) return apiError(403, "forbidden", "Admins only.");
    identity = caller;
  } else {
    const session = await adminSession(c);
    if (!session) {
      return csv === undefined
        ? signInPage(undefined, 401)
        : apiError(401, "invalid_token", "Sign in at /admin first, or send an admin access token as the bearer.");
    }
    identity = session;
    viaCookie = true;
    csrf = await adminCsrf(c, session);
  }
  const retry = await limited(c, `admin:gh:${identity.githubId}`, LIMITS.apiPerson);
  if (retry !== undefined) return rateLimited(retry);

  const now = c.now();
  const { config, paused } = await runtime(c);
  if (csv === undefined && c.url.searchParams.get("view") === "tools") return toolsPage(await toolsState(c, config, identity, viaCookie, csrf, { grant: { text: "" }, compose: emptyEmailForm() }));
  // Any other view (the old Simple, Full and Health ones included) is the home page.
  if (csv === undefined) return adminHomeResponse(c, config, paused, now, identity.login, viaCookie);
  if (!isCsvTable(csv)) return apiError(404, "not_found", `GET ${c.url.pathname} isn't a route.`);
  if (csv === "early-access") return earlyAccessCsv(await directory(c).earlyAccessLeads(), now);
  if (csv === "no-github" || csv === "no-github-clicks") return noGithubCsv(csv, await directory(c).noGithub({ from: 0, until: Math.floor(now / DAY_MS) * DAY_MS + DAY_MS }), now);
  if (csv === "web-signup") return webFunnelCsvResponse(c);
  if (csv === "refusals") return refusalsCsvResponse(c);
  // The health CSVs read only health-data.ts's queries.
  if (isHealthCsvTable(csv)) {
    return healthCsv(csv, await directory(c).health({ now, adminIds: [...c.config.adminGithubIds], days: healthWindow(c.url.searchParams.get("days")) }));
  }
  const weekParam = c.url.searchParams.get("week");
  const topWeek = weekParam && /^\d{4}-\d{2}-\d{2}$/.test(weekParam) ? Date.parse(`${weekParam}T00:00:00Z`) : Number.NaN;
  const [data, spend] = await Promise.all([
    directory(c).dashboard({
      now,
      adminIds: [...c.config.adminGithubIds],
      limits: {
        weeklyTokens: config.weeklyTokens,
        weeklyUsd: config.perPersonWeeklyUsdCap ?? null,
        levels: { basicTokens: config.basicWeeklyTokens, basicUsd: config.basicWeeklyUsdCap ?? null, starterTokens: config.starterWeeklyTokens, starterUsd: config.starterWeeklyUsdCap ?? null },
      },
      policy: policyOf(c.config),
      ...(Number.isFinite(topWeek) ? { topWeek } : {}),
    }),
    directory(c).spend(now),
  ]);
  return dashboardCsv(csv, data, spendView(c, config, paused, spend));
}

/** GET /admin: the home page, from the Directory's admin-home reads and the spend counters. */
async function adminHomeResponse(c: Ctx, config: FreeConfig, paused: boolean, now: number, login: string, signOut: boolean): Promise<Response> {
  const [data, spend, webFunnel, flaggedUses, refusals] = await Promise.all([
    directory(c).adminHome({ now, adminIds: [...c.config.adminGithubIds], trialCutoff: config.trialCutoff }),
    directory(c).spend(now),
    directory(c).webFunnel(),
    directory(c).useDescriptions({ since: now - 7 * DAY_MS, minRisk: "low", limit: 50 }),
    directory(c).refusals(Math.floor(now / DAY_MS) - 29),
  ]);
  const view = spendView(c, config, paused, spend);
  return adminHomePage({
    data,
    spend: view,
    settings: {
      weeklyTokens: config.weeklyTokens,
      perPersonWeeklyUsd: config.perPersonWeeklyUsdCap ?? null,
      deepseekWeeklyUsd: config.deepseekWeeklyUsdCap ?? null,
      basicWeeklyTokens: config.basicWeeklyTokens,
      basicWeeklyUsd: config.basicWeeklyUsdCap ?? null,
      basicDeepseekWeeklyUsd: config.basicDeepseekWeeklyUsdCap ?? null,
      starterWeeklyTokens: config.starterWeeklyTokens,
      starterWeeklyUsd: config.starterWeeklyUsdCap ?? null,
      starterDeepseekWeeklyUsd: config.starterDeepseekWeeklyUsdCap ?? null,
      ...(config.allocator === "on" ? { allocatorStartTokens: config.allocatorStartTokens } : {}),
      proOpenModelsMultiplier: config.proOpenModelsMultiplier,
      proDeepseekWeeklyUsd: proDeepseekWeeklyUsd(config),
      proPriceUsdMonthly: config.offers.pro.priceUsdMonthly,
      proOffered: config.proOffered,
    },
    login,
    signOut,
    webFunnel,
    flaggedUses,
    refusals,
    now,
  });
}

/** The dashboard's spend, caps and settings, from the effective config and the spend counters. */
function spendView(c: Ctx, config: FreeConfig, paused: boolean, spend: SpendSummary): SpendView {
  return {
    weekUsd: spend.spentUsd,
    totalUsd: spend.totalSpentUsd,
    adminWeekUsd: spend.adminSpentUsd,
    adminTotalUsd: spend.adminTotalSpentUsd,
    weeklyCapUsd: config.globalWeeklyUsdCap ?? null,
    totalCapUsd: config.globalTotalUsdCap ?? null,
    resetsAt: spend.resetsAt,
    paused,
    pausedByEnv: c.config.paused,
    openAdmission: config.openAdmission,
    requireGithubActivity: config.requireGithubActivity,
    maxActiveUsers: config.maxActiveUsers,
    weeklyTokens: config.weeklyTokens,
    perPersonWeeklyUsd: config.perPersonWeeklyUsdCap ?? null,
    deepseekWeeklyUsd: config.deepseekWeeklyUsdCap ?? null,
    queueThreshold: config.queueThreshold,
    primaryUpstream: config.primaryUpstream,
    luminalConfigured: c.config.luminalApiKey !== undefined,
    serving: chooseUpstream(config.primaryUpstream, c.config) ?? "none",
    openRouterConfigured: c.config.openRouterApiKey !== undefined,
    openaiConfigured: c.config.openaiApiKey !== undefined,
    creditUsd: config.luminalCreditUsd,
    creditUsedUsd: spend.creditUsedUsd,
    creditWeekUsd: spend.creditWeekUsd,
    freeCreditWeekUsd: spend.freeCreditWeekUsd,
    weeklyCreditUsd: config.luminalWeeklyCreditUsd ?? null,
    openaiCreditUsd: config.openaiCreditUsd,
    openaiCreditUsedUsd: spend.openaiCreditUsedUsd,
    openaiCreditWeekUsd: spend.openaiCreditWeekUsd,
    openaiFreeCreditWeekUsd: spend.openaiFreeCreditWeekUsd,
    openaiWeeklyCreditUsd: config.openaiWeeklyCreditUsd ?? null,
    starterWeeklyTokens: config.starterWeeklyTokens,
    starterWeeklyUsd: config.starterWeeklyUsdCap ?? null,
    starterDeepseekWeeklyUsd: config.starterDeepseekWeeklyUsdCap ?? null,
    basicWeeklyTokens: config.basicWeeklyTokens,
    basicWeeklyUsd: config.basicWeeklyUsdCap ?? null,
    basicDeepseekWeeklyUsd: config.basicDeepseekWeeklyUsdCap ?? null,
    basicMinAccountAgeDays: config.basicMinAccountAgeDays,
    fullMinAccountAgeDays: config.fullMinAccountAgeDays,
    fullMinPublicRepos: config.fullMinPublicRepos,
    fullMinContributions: config.fullMinContributions,
  };
}

/** Sign-up days the Tools tab's cohort picker lists. */
const COHORT_PICKER_DAYS = 14;

function emptyEmailForm(): ToolsState["compose"] {
  return { subject: "", text: "", audience: "full", from: "", to: "", testTo: "" };
}

/** What a Tools form post adds to the page: the forms' contents and what the action did. */
type ToolsPosted = Pick<ToolsState, "grant" | "compose"> & Partial<Pick<ToolsState, "requestNotice" | "recheck" | "leadNotice" | "block" | "eventCodeNotice">>;

/** Everything the Tools tab shows besides what was just posted. */
async function toolsState(
  c: Ctx,
  config: FreeConfig,
  identity: Identity,
  signOut: boolean,
  csrf: string | undefined,
  posted: ToolsPosted,
): Promise<ToolsState> {
  const [cohorts, me, requests, leads, noGithub, eventCodes, providerInquiries] = await Promise.all([
    directory(c).broadcastCohorts({ days: COHORT_PICKER_DAYS, adminIds: [...c.config.adminGithubIds], includeAdmins: config.userEmailsToAdmins }),
    directory(c).getPerson(identity.githubId),
    directory(c).pendingAccessRequests(c.now()),
    directory(c).earlyAccessLeads(),
    directory(c).noGithub({ from: Math.floor(c.now() / DAY_MS) * DAY_MS - 13 * DAY_MS, until: Math.floor(c.now() / DAY_MS) * DAY_MS + DAY_MS }),
    directory(c).listEventCodes(c.now()),
    directory(c).providerInquiries(),
  ]);
  return {
    login: identity.login,
    signOut,
    ...(csrf ? { csrf } : {}),
    adminEmail: me?.email ?? null,
    emailsOn: config.userEmails,
    provider: userEmailVia(c)?.provider ?? null,
    cohorts,
    requests,
    leads,
    noGithub,
    providerInquiries,
    grantUsd: config.grantWeeklyUsdCap ?? 0,
    routing: {
      primaryUpstream: config.primaryUpstream,
      openaiConfigured: c.config.openaiApiKey !== undefined,
      luminalConfigured: c.config.luminalApiKey !== undefined,
      openRouterConfigured: c.config.openRouterApiKey !== undefined,
    },
    block: { login: "" },
    eventCodes,
    ...posted,
  };
}

/** Binds the in-page "yes, send" to exactly the copy and audience that were counted. */
function confirmToken(csrf: string, form: ToolsState["compose"]): Promise<string> {
  return sha256Hex(`broadcast-confirm:${csrf}:${JSON.stringify([form.subject, form.text, form.audience, form.from, form.to])}`);
}

/**
 * POST /admin/dashboard/tools: the Tools tab's two forms, rendered again with the result (no
 * scripts: every button posts the form). `tool=grant` gives free tokens to the pasted usernames.
 * `tool=email` with `action`: pick or clear a sign-up day, send a test to the admin (or an
 * address), preview who gets it (a dry run), confirm (a dry run that shows the count and a
 * "yes, send" button carrying a token bound to the copy and audience), and send (only with that
 * token; same copy means the same broadcast id, so "send the rest" never sends twice).
 */
async function adminWebTools(c: Ctx): Promise<Response> {
  const session = await adminSession(c);
  if (!session) return deniedPage("Signed out", "Sign in to the dashboard again, then retry.", 401);
  const form = await readForm(c);
  const csrf = await adminCsrf(c, session);
  if (!sameOrigin(c) || !timingSafeEqual(form.get("csrf") ?? "", csrf)) return deniedPage("Not changed", "Use the tools only from the dashboard itself.", 403);
  const retry = await limited(c, `admin:gh:${session.githubId}`, LIMITS.apiPerson);
  if (retry !== undefined) return rateLimited(retry);
  const { config } = await runtime(c);
  const actor = { githubId: session.githubId, login: session.login, now: c.now() };
  const state = (posted: ToolsPosted) => toolsState(c, config, session, true, csrf, posted).then(toolsPage);

  if (form.get("tool") === "early-access-delete") {
    // A deletion request: every lead for that inbox goes (normalized, so name+tag@ and Gmail's dots match).
    const email = (form.get("email") ?? "").trim().slice(0, 254);
    const removed = plausibleEmail(email) ? await directory(c).deleteEarlyAccessLeads(normalizeEmail(email)) : -1;
    const leadNotice =
      removed < 0 ? { error: true, text: "Enter the email to delete." } : { error: removed === 0, text: removed === 0 ? "No early-access lead has that email." : `Deleted ${removed === 1 ? "1 lead" : `${removed} leads`}.` };
    return state({ grant: { text: "" }, compose: emptyEmailForm(), leadNotice });
  }

  if (form.get("tool") === "block") {
    // Block or unblock by GitHub username (the people table's login, any case).
    const login = (form.get("login") ?? "").trim().replace(/^@/, "").slice(0, 39);
    const action = form.get("action");
    const answer = (notice: { error: boolean; text: string }) => state({ grant: { text: "" }, compose: emptyEmailForm(), block: { login, notice } });
    if (!login || (action !== "block" && action !== "unblock")) return answer({ error: true, text: "Type a GitHub username, then Block or Unblock." });
    const person = await directory(c).personByLogin(login);
    if (!person) return answer({ error: true, text: `No free tier account has the username ${login}.` });
    if (action === "block" && c.config.adminGithubIds.has(person.githubId)) return answer({ error: true, text: `${person.login} is an admin; admins can't be blocked here.` });
    const status = await setBlocked(c, person.githubId, action === "block", actor);
    if (!status) return answer({ error: true, text: `No free tier account has the username ${login}.` });
    return state({ grant: { text: "" }, compose: emptyEmailForm(), block: { login: "", notice: { error: false, text: `${person.login} is ${status === "blocked" ? "blocked" : "unblocked"}.` } } });
  }
  if (form.get("tool") === "event-code") {
    const answer = (eventCodeNotice: NonNullable<ToolsState["eventCodeNotice"]>) => state({ grant: { text: "" }, compose: emptyEmailForm(), eventCodeNotice });
    if (form.get("action") === "end") {
      const ended = await directory(c).endEventCode(Number(form.get("id")), c.now());
      return answer(ended ? { error: false, text: "Ended: the code no longer works." } : { error: true, text: "No such open event code." });
    }
    const input = parseEventCodeInput({ note: form.get("note") ?? undefined, maxUses: form.get("max_uses") ?? undefined, days: form.get("days") ?? undefined, full: form.get("full") ?? undefined });
    if ("error" in input) return answer({ error: true, text: input.error.replace("maxUses", "Uses").replace("days", "Open for") });
    const made = await directory(c).createEventCode({ ...input, createdBy: session.githubId, now: c.now() });
    return answer({ error: false, text: `Made. Share this code; it is shown only now (${input.maxUses} uses, ${input.days} days${input.full ? ", Full" : ""}):`, code: made.code });
  }
  if (form.get("tool") === "recheck") {
    return state({ grant: { text: "" }, compose: emptyEmailForm(), recheck: await recheckBelowBar(c, config, actor) });
  }
  if (form.get("tool") === "request") {
    const id = Number(form.get("id"));
    const action = form.get("action");
    const note = (form.get("note") ?? "").trim().slice(0, 300) || null;
    const answer = (requestNotice: { error: boolean; text: string }) => state({ grant: { text: "" }, compose: emptyEmailForm(), requestNotice });
    if (!Number.isSafeInteger(id) || (action !== "grant" && action !== "decline")) return answer({ error: true, text: "Pick Grant or Decline on a request." });
    const usd = action === "grant" ? parseGrantUsd(form.get("usd") ?? undefined) : undefined;
    if (usd === "invalid") return answer({ error: true, text: GRANT_USD_FORM_ERROR });
    const result = await decideAccessRequest(c, config, id, action, note, actor, usd);
    return answer("code" in result ? { error: true, text: result.message } : { error: false, text: requestAnswerText(result) });
  }

  if (form.get("tool") === "grant") {
    const text = (form.get("logins") ?? "").slice(0, 20_000);
    const usd = parseGrantUsd(form.get("usd") ?? undefined);
    if (usd === "invalid") return state({ grant: { text, error: GRANT_USD_FORM_ERROR }, compose: emptyEmailForm() });
    const results = await grantLogins(c, config, text, actor, usd);
    return state({ grant: "status" in results ? { text, error: results.message } : { text: "", results }, compose: emptyEmailForm() });
  }

  const audience = form.get("audience");
  const day = (name: string) => {
    const value = form.get(name) ?? "";
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
  };
  const draft: ToolsState["compose"] = {
    subject: (form.get("subject") ?? "").slice(0, 1000),
    text: (form.get("text") ?? "").replace(/\r\n?/g, "\n").slice(0, 20_000),
    audience: audience === "basic" || audience === "starter" || audience === "all" ? audience : "full",
    from: day("from"),
    to: day("to"),
    testTo: (form.get("test_to") ?? "").trim().slice(0, 254),
  };
  const action = form.get("action") ?? "";
  const picked = /^pick:(\d{4}-\d{2}-\d{2})$/.exec(action)?.[1];
  if (picked) return state({ grant: { text: "" }, compose: { ...draft, from: picked, to: picked } });
  if (action === "clear") return state({ grant: { text: "" }, compose: { ...draft, from: "", to: "" } });
  if (action === "test") {
    const result = await sendTestEmail(c, session.githubId, { subject: draft.subject, text: draft.text, ...(draft.testTo ? { to: draft.testTo } : {}) });
    const notice = "status" in result ? { error: true, text: result.message } : { error: false, text: `Test sent to ${result.to}.` };
    return state({ grant: { text: "" }, compose: { ...draft, notice } });
  }
  if (action !== "preview" && action !== "confirm" && action !== "send") return state({ grant: { text: "" }, compose: draft });

  const parsed = parseBroadcast({ subject: draft.subject, text: draft.text, audience: draft.audience, signedUpFrom: draft.from || undefined, signedUpTo: draft.to || undefined, dryRun: action !== "send" });
  if (!parsed.ok) return state({ grant: { text: "" }, compose: { ...draft, notice: { error: true, text: parsed.message } } });
  const token = await confirmToken(csrf, draft);
  const sending = action === "send" && timingSafeEqual(form.get("confirm") ?? "", token);
  const result = await runBroadcast(c, config, { ...parsed.value, dryRun: !sending });
  if ("status" in result) return state({ grant: { text: "" }, compose: { ...draft, notice: { error: true, text: result.message } } });
  if (!result.dryRun) return state({ grant: { text: "" }, compose: { ...draft, confirm: token, sent: result } });
  const preview = { count: result.count, waitingForTomorrow: result.waitingForTomorrow, sample: result.sample.map((person) => person.login) };
  if (action === "preview") return state({ grant: { text: "" }, compose: { ...draft, preview } });
  // Confirm, or a send whose copy or audience changed since it was counted: count (again) and ask.
  const changed = action === "send" ? { notice: { error: true, text: "The message or the audience changed since the count. Check the new count, then send." } } : {};
  return state({ grant: { text: "" }, compose: { ...draft, preview, ...(result.count > 0 ? { confirm: token, confirming: true } : {}), ...changed } });
}

async function adminSignIn(c: Ctx): Promise<Response> {
  const retry = await limited(c, `admin-signin:ip:${c.ipNet}`, LIMITS.adminSignInIp);
  if (retry !== undefined) return signInPage(`Too many sign-in attempts. Try again in ${Math.ceil(retry / 60)} minutes.`, 429);
  const begun = await auth(c).beginAdminOAuth(c.now());
  return new Response(null, {
    status: 302,
    headers: {
      location: githubAuthorizeUrl({ clientId: c.config.githubClientId }, `${c.base}${CALLBACK_PATH}`, begun.state),
      "set-cookie": `${ADMIN_OAUTH_COOKIE}=${begun.browser}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

/** `callbackPath` is the path GitHub sent the browser back to; the code exchange must name the same redirect_uri. */
async function adminCallback(c: Ctx, callbackPath: string): Promise<Response> {
  const state = c.url.searchParams.get("state");
  const browser = readCookie(c.request, ADMIN_OAUTH_COOKIE);
  const clear = { "set-cookie": CLEAR_ADMIN_OAUTH };
  if (!state || !browser || !(await auth(c).claimAdminOAuthState(state, browser, c.now()))) {
    return deniedPage("Sign-in expired", "This sign-in link is invalid, used or expired. Start again.", 400, clear);
  }
  if (c.url.searchParams.get("error")) return deniedPage("Sign-in cancelled", "GitHub sign-in was cancelled.", 400, clear);
  const code = c.url.searchParams.get("code");
  const user = code
    ? await githubUserFromCode(
        { clientId: c.config.githubClientId, clientSecret: c.config.githubClientSecret },
        code,
        `${c.base}${callbackPath}`,
        c.fetch,
        "directionallylocal-free",
      )
    : undefined;
  if (!user) return deniedPage("GitHub sign-in failed", "GitHub didn't confirm who you are. Try again.", 502, clear);
  if (!c.config.adminGithubIds.has(user.id)) return deniedPage("Admins only", `${user.login} isn't an admin of the free tier.`, 403, clear);

  const iat = Math.floor(c.now() / 1000);
  const token = await signJwt(
    { iss: ISSUER, typ: "admin", sub: String(user.id), login: user.login, sid: `admin_${randomToken(16)}`, iat, exp: iat + ADMIN_SESSION_TTL_S },
    await signingKey(c.config),
  );
  const response = signedInPage(user.login, clear);
  response.headers.append("set-cookie", adminCookie(token, ADMIN_SESSION_TTL_S));
  return response;
}

async function adminSignOut(c: Ctx): Promise<Response> {
  if (!sameOrigin(c)) return deniedPage("Not signed out", "Sign out from the dashboard itself.", 403);
  const session = await adminSession(c);
  if (session) {
    // Remembered until the token would have expired anyway.
    await account(c, session.githubId).revokeSessions({ sids: [session.sid], until: (session.exp + 60) * 1000, now: c.now() });
  }
  return new Response(null, { status: 303, headers: { location: "/admin", "set-cookie": adminCookie("", 0), "cache-control": "no-store" } });
}

// ─── dl.new's web sign-up (web-signup.ts) ───────────────────────────────────

/** Counts one step of the web sign-up funnel (counts only). Never fails the request. */
async function countWebStep(c: Ctx, step: WebStep): Promise<void> {
  try {
    await directory(c).countWebStep(step, Math.floor(c.now() / DAY_MS));
  } catch (error) {
    console.error("web funnel: count failed", error instanceof Error ? error.name : "error");
  }
}

/** Counts one step of a link campaign (web-signup.ts; tags and counts only). Never fails the request. */
async function countCampaignStep(c: Ctx, campaign: Campaign, step: CampaignStep): Promise<void> {
  try {
    await directory(c).countCampaignStep(campaign, step, Math.floor(c.now() / DAY_MS));
  } catch (error) {
    console.error("campaigns: count failed", error instanceof Error ? error.name : "error");
  }
}

/**
 * Counts one refusal or gate per UTC day and reason (refusals.ts): counts only, and `githubId`
 * only for the day's distinct-people count (hashed with a daily salt). Never fails the request.
 */
async function countRefusal(c: Ctx, reason: RefusalReason, githubId?: number, client: RefusalClient | `tool:${string}` = "signin"): Promise<void> {
  try {
    await directory(c).countRefusal(reason, client, c.now(), githubId);
  } catch (error) {
    console.error("refusals: count failed", error instanceof Error ? error.name : "error");
  }
}

/**
 * Counts a chat refusal (refusals.ts requestRefusalReason) from the response, which is returned
 * as it is, under the caller's client: every coding agent path goes through here.
 */
async function countedChat(c: Ctx, identity: Caller, response: Response): Promise<Response> {
  if (response.status < 400 || !(response.headers.get("content-type") ?? "").includes("application/json")) return response;
  const body = parseJson(await response.clone().text()) as { error?: { code?: unknown; reason?: unknown } } | undefined;
  const reason = requestRefusalReason(response.status, body?.error);
  // A tool key's refusals count under the tool that met them (`tool:<name>`, tool-keys.ts).
  if (reason) await countRefusal(c, reason, identity.githubId, identity.keyKind === "tool" ? toolClient(c.request.headers) : requestClient(otherAgent(identity), reason));
  return response;
}

/** POST /v1/telemetry/web {step: "visited"}: the dl.new Worker counts each /start page it serves. */
async function webTelemetry(c: Ctx): Promise<Response> {
  const day = Math.floor(c.now() / DAY_MS);
  const ipKey = await sha256Hex(`telemetry:${c.config.tokenSigningKey}:${day}:${c.ipNet}`);
  const retry = await limited(c, `telemetry:web:${ipKey}`, LIMITS.telemetryWebIp);
  if (retry !== undefined) return rateLimited(retry);
  if (Number(c.request.headers.get("content-length") ?? 0) > MAX_TELEMETRY_BYTES) return apiError(413, "too_large", "A telemetry body is under 1 KB.");
  const text = await c.request.text();
  if (text.length > MAX_TELEMETRY_BYTES) return apiError(413, "too_large", "A telemetry body is under 1 KB.");
  const body = parseJson(text) as { step?: unknown; campaign?: unknown } | undefined;
  // A link campaign's step: a tagged visit (the Worker), or an install or sign-in click (the page,
  // under the visit's first-touch tags). A campaign that isn't plain tags is left out, not refused.
  const step = typeof body?.step === "string" && CAMPAIGN_CLIENT_STEPS.has(body.step) ? (body.step as CampaignStep) : undefined;
  const campaign = parseCampaign(body?.campaign);
  // The other steps are counted where they happen, by the service itself.
  if (!step || (step !== "visited" && !campaign)) return apiError(400, "invalid_request", 'Send {"step": "visited"}, optionally with a "campaign".');
  if (step === "visited") await countWebStep(c, "visited");
  if (campaign) await countCampaignStep(c, campaign, step);
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

/** The web sign-up page's origin (WEB_SIGNUP_URL's, dl.new). */
export function webOrigin(c: Ctx): string {
  return new URL(c.config.webSignupUrl).origin;
}

/** The web pages' origins (dl.new's, and WEB_API_URL's, api.dl.new): the only ones /web/* answers CORS for. */
function webOrigins(c: Ctx): string[] {
  return [webOrigin(c), new URL(c.config.webApiUrl).origin];
}

/** A plain page for a web sign-in that can't start, with the way back to the web page. */
function webSignInProblem(c: Ctx, heading: string, message: string, status: number): Response {
  return donePage(heading, `${message} Start again at ${c.config.webSignupUrl}.`, status);
}

/**
 * GET /web/signin?return=<WEB_SIGNUP_URL or WEB_API_URL>&state=<the page's random state>[&ref=<referral>]:
 * starts the CLI's own browser sign-in (device code, GitHub, the details and invite steps,
 * admission) for the web page. `return` may only be one of the configured pages itself (no open
 * redirect): dl.new/start, or api.dl.new's key page, which finishes the sign-in itself.
 */
async function webSignIn(c: Ctx): Promise<Response> {
  const signupUrl = allowedReturn(c.url.searchParams.get("return"), [c.config.webSignupUrl, c.config.webApiUrl]);
  if (!signupUrl) return webSignInProblem(c, "Sign-in link not valid", "This sign-in link isn't valid.", 400);
  const state = c.url.searchParams.get("state") ?? "";
  if (!WEB_STATE.test(state)) return webSignInProblem(c, "Sign-in link not valid", "This sign-in link isn't valid.", 400);
  if (await isPaused(c)) return donePage("Paused", PAUSED_MESSAGE, 503);
  const retry = await limited(c, `device:ip:${c.ipNet}`, LIMITS.deviceCodeIp);
  if (retry !== undefined) return webSignInProblem(c, "Too many sign-ins", `Too many sign-ins from this network. Try again in ${Math.ceil(retry / 60)} minutes.`, 429);
  const ref = normalizeReferralCode(c.url.searchParams.get("ref") ?? undefined) ?? null;
  // The link campaign the page's visit came from (first touch), if any: counted when the sign-in finishes.
  const campaign = campaignFromParams(c.url.searchParams);
  const issued = await auth(c).issueDeviceCode({ clientDeviceId: null, referralCode: ref, now: c.now(), web: { returnUrl: signupUrl, state, ...(campaign ? { campaign } : {}) } });
  const begun = await auth(c).beginOAuth(issued.userCode, c.now());
  if (!begun) return webSignInProblem(c, "Sign-in didn't start", "Something went wrong starting the sign-in.", 500);
  return toGitHub(c, begun);
}

/** The person behind a web session (a JWT of type "web"), or a 401. */
async function webCaller(c: Ctx): Promise<Identity | Response> {
  const match = /^Bearer\s+(\S+)$/i.exec(c.request.headers.get("authorization") ?? "");
  const invalid = () => apiError(401, "invalid_token", "Your dl.new sign-in expired. Sign in with GitHub again.");
  if (!match) return invalid();
  const claims = await verifyJwt(match[1]!, await signingKey(c.config), Math.floor(c.now() / 1000));
  if (!claims || claims.typ !== "web" || claims.iss !== ISSUER || typeof claims.login !== "string") return invalid();
  const githubId = Number(claims.sub);
  if (!Number.isSafeInteger(githubId) || githubId <= 0) return invalid();
  // A dl.new session (paid-web.ts) carries its own id: signing out ends it everywhere.
  if (typeof claims.sid === "string" && !(await account(c, githubId).sessionAllowed(claims.sid, Number(claims.iat)))) return invalid();
  return { githubId, login: claims.login };
}

/** The admitted, unblocked person behind a web session, or the response that refuses them. */
async function webPerson(c: Ctx): Promise<{ identity: Identity; person: PersonRow } | Response> {
  const identity = await webCaller(c);
  if (identity instanceof Response) return identity;
  const guarded = await apiGuard(c, identity);
  if (guarded) return guarded;
  const person = await directory(c).getPerson(identity.githubId);
  if (!person) return apiError(403, "not_invited", "This GitHub account isn't on the free tier.");
  if (person.status === "blocked") return blockedError();
  return { identity, person };
}

type WebHandler = (c: Ctx) => Promise<Response>;
type WebRoute = Partial<Record<"GET" | "POST" | "PUT" | "DELETE", WebHandler>>;

const WEB_ROUTES: Record<string, WebRoute> = {
  "/web/session": { POST: webSession },
  "/web/me": { GET: webMe },
  "/web/email": { POST: webEmail },
  "/web/choice": { POST: webChoice },
  "/web/checkout": { POST: webCheckout },
  "/web/portal": { POST: webPortal },
  "/web/install-code": { POST: webInstallCode },
  "/web/keys": { GET: webKeys, POST: webCreateKey },
  "/web/provider-inquiry": { POST: webProviderInquiry },
};

/** A /web/* path's route: the table above, or /web/keys/<id>. */
function webRoute(path: string): WebRoute | undefined {
  const key = /^\/web\/keys\/([a-z0-9]{12})$/.exec(path);
  if (key) return { DELETE: (c) => webRevokeKey(c, key[1]!) };
  return WEB_ROUTES[path];
}

/** /web/*: the sign-in redirect, and the JSON endpoints the web pages call (CORS for their origins only). */
async function web(c: Ctx, path: string, method: string): Promise<Response> {
  if (path === "/web/signin") return method === "GET" ? webSignIn(c) : apiError(405, "method_not_allowed", "GET /web/signin.");
  // dl.new's own GitHub sign-in (paid-web.ts): a navigation, not a fetch.
  if (path === "/web/auth/github") return method === "GET" ? githubStart(c) : apiError(405, "method_not_allowed", "GET /web/auth/github.");
  // "Continue with Google" (paid-web.ts): navigations too. Off (a 404) without GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.
  if (path === "/web/auth/google" || path === GOOGLE_CALLBACK_PATH) {
    if (!c.config.google) return apiError(404, "not_found", "Google sign-in isn't on.");
    if (method !== "GET") return apiError(405, "method_not_allowed", `GET ${path}.`);
    return path === GOOGLE_CALLBACK_PATH ? googleCallback(c) : googleStart(c);
  }
  const route = webRoute(path) ?? paidWebRoute(path);
  if (!route) return apiError(404, "not_found", `${method} ${c.url.pathname} isn't a route.`);
  const origin = c.request.headers.get("origin");
  const origins = webOrigins(c);
  const cors = webCors(origin, origins);
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "cache-control": "no-store" } });
  const handle = route[method as keyof WebRoute];
  if (!handle) return apiError(405, "method_not_allowed", `${Object.keys(route).join(" or ")} ${path}.`, {}, cors);
  // A page on another site gets nothing, whatever it sends (its browser wouldn't show it the answer anyway).
  if (origin !== null && !origins.includes(origin)) return apiError(403, "forbidden_origin", "Only dl.new can call this.", {}, cors);
  const response = await handle(c);
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(cors)) headers.set(name, value);
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

/** GET /web/keys: the account's API keys for other tools (tool keys only), for api.dl.new. */
async function webKeys(c: Ctx): Promise<Response> {
  const found = await webPerson(c);
  if (found instanceof Response) return found;
  c.callerId = found.identity.githubId;
  const { config } = await runtime(c);
  const keys = (await account(c, found.identity.githubId).listKeys()).filter((key) => key.kind === "tool").map(keyView);
  return json({ keys, max: config.toolKeysMax, toolKeys: config.toolKeys });
}

/** POST /web/keys {name}: a tool key, with every check and limit of POST /v1/keys {kind: "tool"}; shown once. */
async function webCreateKey(c: Ctx): Promise<Response> {
  const found = await webPerson(c);
  if (found instanceof Response) return found;
  c.callerId = found.identity.githubId;
  const body = (await readJson(c)) ?? {};
  return createKey(c, found.identity.githubId, body.name, "tool", "on api.dl.new or with dl api-key revoke ID");
}

/** DELETE /web/keys/:id: revokes one of the account's own tool keys (a server key isn't touched here). */
async function webRevokeKey(c: Ctx, id: string): Promise<Response> {
  const found = await webPerson(c);
  if (found instanceof Response) return found;
  if (!(await account(c, found.identity.githubId).revokeKey(id, "tool"))) return apiError(404, "key_not_found", "No API key with that id on this account.");
  return json({ id, revoked: true });
}

/** POST /web/session {code, state}: the one-time code from the sign-in's redirect → a web session for the page. */
async function webSession(c: Ctx): Promise<Response> {
  const retry = await limited(c, `websession:ip:${c.ipNet}`, LIMITS.webSessionIp);
  if (retry !== undefined) return rateLimited(retry);
  const body = (await readJson(c)) ?? {};
  const invalid = () => apiError(400, "invalid_grant", "This sign-in is invalid, used or expired. Sign in with GitHub again.");
  if (typeof body.code !== "string" || !ONE_TIME_CODE.test(body.code) || typeof body.state !== "string" || !WEB_STATE.test(body.state)) return invalid();
  const identity = await auth(c).claimWebHandoff(body.code, body.state, c.now());
  if (!identity) return invalid();
  if ((await directory(c).getPerson(identity.githubId))?.status === "blocked") return blockedError();
  const iat = Math.floor(c.now() / 1000);
  const token = await signJwt({ iss: ISSUER, typ: "web", sub: String(identity.githubId), login: identity.login, iat, exp: iat + WEB_SESSION_TTL_S, jti: crypto.randomUUID() }, await signingKey(c.config));
  return json({ token, expires_in: WEB_SESSION_TTL_S, login: identity.login });
}

/** GET /web/me: what the web page shows: who, the contact email, the plan, the trial, the offers and the invite link. */
async function webMe(c: Ctx): Promise<Response> {
  const found = await webPerson(c);
  if (found instanceof Response) return found;
  const { identity, person: stored } = found;
  c.callerId = identity.githubId;
  const { config, person } = await runtime(c);
  const limits = allocated(config, limitsFor(config, person?.bonusTokens, person?.level ?? "full", person?.batchFlagged === true, onTrial(config, identity.githubId, person?.admittedAt), person?.trialBonusTokens), identity.githubId, person, c.now());
  // The week as a tool key sees it too: DeepSeek's pool (the model tools get; GPT-6 stays in
  // Autopilot), with the other agents' share applied (all of it on Pro).
  const [allowance, tools] = await Promise.all([
    account(c, identity.githubId).allowance(c.now(), limits),
    account(c, identity.githubId).allowance(c.now(), { ...limits, harnessShare: config.otherHarnessShare }, "deepseek"),
  ]);
  return json({
    login: identity.login,
    "email": stored.email,
    emailUpdates: stored.email_updates === 1,
    plan: allowance.plan,
    trial: trialView(allowance),
    /** The free weekly tokens, for an account not on the trial (grandfathered); 0 when there are none. */
    weeklyTokens: allowance.trial ? 0 : allowance.tokensPerWeek,
    /**
     * What API keys for other tools may use this week (tool-keys.ts), for api.dl.new: `share` of
     * the allowance (otherHarnessShare; 1 on Pro), DeepSeek's weekly tokens with the share applied
     * (null: no token cap), what the account used of them this week (all of it, Autopilot too: a
     * tool key is refused once the week's use reaches its share) and when the week resets.
     */
    toolAllowance: {
      share: tools.plan === "pro" ? 1 : Math.min(1, Math.max(0, config.otherHarnessShare)),
      tokensPerWeek: tools.tokensPerWeek,
      usedThisWeek: tools.usedThisWeek,
      resetsAt: new Date(tools.resetsAt).toISOString(),
    },
    offers: offers(config),
    /** Pro's state for the account page: when it renews or ends, and whether it was set to end. */
    pro: allowance.plan === "pro" || allowance.proPeriodEnd !== null
      ? { periodEnd: allowance.proPeriodEnd === null ? null : new Date(allowance.proPeriodEnd).toISOString(), cancelAtPeriodEnd: allowance.proCancelAtPeriodEnd }
      : null,
    /** dl Pro's prompt (`{text, price, upgradeUrl}`) when the week's open models are used up; dl.new/account shows it (counted as seen). */
    proPrompt: await (async () => {
      const prompt = accountProPrompt(c, config, identity.githubId, allowance);
      if (prompt) await countPro(c, "seen", identity.githubId);
      return prompt?.view ?? null;
    })(),
    /**
     * The invite link and what a referral earns, so the page can describe it. `kind`: "trial" for
     * an account on the trial (each friend who becomes weekly active adds `bonusTokens` once to both
     * people's trial, up to `capTokens` in all; `trialBonusTokens` earned so far), "weekly" otherwise
     * (`bonusTokens` a week to both while both stay weekly active, up to `capTokens` a week).
     */
    referral: person?.referral
      ? {
          link: linkFor(config, person),
          joined: person.referral.joined,
          kind: allowance.trial ? "trial" : "weekly",
          bonusTokens: config.referralBonusTokens,
          capTokens: config.referralBonusCap,
          trialBonusTokens: allowance.trial ? person.trialBonusTokens : 0,
        }
      : null,
  });
}

/** POST /web/email {email, updates?}: the contact email, with the same checks as the sign-in's details step. */
async function webEmail(c: Ctx): Promise<Response> {
  const found = await webPerson(c);
  if (found instanceof Response) return found;
  const { identity, person } = found;
  const body = (await readJson(c)) ?? {};
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!plausibleEmail(email)) return apiError(400, "invalid_email", "Enter an email address we can reach you at.");
  const inbox = normalizeEmail(email);
  if (!c.config.adminGithubIds.has(identity.githubId)) {
    const { config: guard } = await runtime(c);
    if (emailBlocked(inbox, guard.blockedEmails)) return apiError(400, "email_blocked", EMAIL_BLOCKED_MESSAGE);
    if (await directory(c).emailInUse(inbox, identity.githubId)) return apiError(409, "email_in_use", EMAIL_IN_USE_MESSAGE);
  }
  const updates = typeof body.updates === "boolean" ? body.updates : person.email_updates === 1;
  await directory(c).setEmail(identity.githubId, email, updates, c.now());
  return json({ email, emailUpdates: updates });
}

/** POST /web/choice {option}: "this computer" or "my Nvidia GPU" was chosen (counted only). */
async function webChoice(c: Ctx): Promise<Response> {
  const found = await webPerson(c);
  if (found instanceof Response) return found;
  const body = (await readJson(c)) ?? {};
  if (!isInstallOption(body.option)) return apiError(400, "invalid_request", 'Send {option: "computer"} or {option: "gpu"}.');
  await countWebStep(c, body.option === "gpu" ? "chose_gpu" : "chose_computer");
  return json({ ok: true });
}

/**
 * POST /web/provider-inquiry {company, name, email, website?, models?, regions?, credits?, notes?}
 * → {ok: true}: dl.new/providers' form (provider-inquiry.ts). No sign-in. Kept in the Directory
 * (no IP), and emailed to the owner (ALERT_EMAIL to ALERT_EMAIL_TO, Reply-To the sender) for the
 * first PROVIDER_INQUIRY_EMAILS_PER_DAY a UTC day. 5 an hour per network, PROVIDER_INQUIRIES_PER_DAY
 * in all a UTC day (429 past either).
 */
async function webProviderInquiry(c: Ctx): Promise<Response> {
  if (Number(c.request.headers.get("content-length") ?? 0) > PROVIDER_INQUIRY_MAX_BYTES) return apiError(400, "invalid_request", "The inquiry is too large.");
  const text = await c.request.text();
  if (new TextEncoder().encode(text).length > PROVIDER_INQUIRY_MAX_BYTES) return apiError(400, "invalid_request", "The inquiry is too large.");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const parsed = parseProviderInquiry(body);
  if (!parsed.ok) return apiError(400, "invalid_request", parsed.message);
  const retry = await limited(c, `provider-inquiry:ip:${c.ipNet}`, LIMITS.providerInquiryIp);
  if (retry !== undefined) return rateLimited(retry);
  const now = c.now();
  const saved = await directory(c).saveProviderInquiry({ now, inquiry: parsed.value });
  if (!saved.ok) return rateLimited(Math.max(1, Math.ceil((Math.floor(now / DAY_MS) * DAY_MS + DAY_MS - now) / 1000)));
  const binding = c.env.ALERT_EMAIL;
  const { alertEmailTo, alertEmailFrom } = c.config;
  if (saved.email && binding && alertEmailTo) {
    const mail = providerInquiryEmail(parsed.value, now, saved.today);
    const sender = parsed.value.email;
    try {
      await sendEmail(binding, { from: alertEmailFrom, to: alertEmailTo, fromName: "dl providers", subject: mail.subject, body: mail.body, now, ...(isHeaderSafeAddress(sender) ? { replyTo: sender } : {}) });
    } catch (error) {
      // Kept already, and listed for admins: the error's name only, never what was sent.
      console.error("provider inquiry email failed", error instanceof Error ? error.name : "error");
    }
  }
  return json({ ok: true });
}

/** POST /web/checkout: Stripe Checkout for Pro, coming back to the web page (?checkout=done or ?checkout=cancel). */
async function webCheckout(c: Ctx): Promise<Response> {
  const found = await webPerson(c);
  if (found instanceof Response) return found;
  // Refused before it counts as a Pro checkout on the funnel (checkoutFor checks again, after `already_pro`).
  if (!(await runtime(c)).config.proOffered) return proNotOffered();
  // {return: "account"}: from dl.new/account, which Checkout comes back to; else the sign-up page.
  const body = (await readJson(c)) ?? {};
  const fromAccount = body.return === "account";
  if (!fromAccount) await countWebStep(c, "plan_pro");
  const page = fromAccount ? upgradeUrl(c) : c.config.webSignupUrl;
  return checkoutFor(c, found.identity, "pro", c.config.offers.topup.minQuantity, { ...c.config.stripe, successUrl: `${page}?checkout=done`, cancelUrl: `${page}?checkout=cancel` });
}

/** POST /web/portal → {url}: Stripe's Customer Portal for dl.new/account (manage or cancel Pro), coming back there. */
async function webPortal(c: Ctx): Promise<Response> {
  const found = await webPerson(c);
  if (found instanceof Response) return found;
  const unavailable = billingReady(c);
  if (unavailable) return unavailable;
  const billing = await account(c, found.identity.githubId).billing();
  if (!billing.customerId) return apiError(404, "no_billing_account", "There is nothing to manage yet: this account hasn't bought anything.");
  try {
    return json(await createPortal(c.fetch, { config: { ...c.config.stripe, portalReturnUrl: upgradeUrl(c) }, customerId: billing.customerId }));
  } catch (error) {
    if (isMissingCustomer(error)) return apiError(404, "no_billing_account", "There is nothing to manage yet: this account hasn't bought anything.");
    if (error instanceof StripeError) return apiError(502, "billing_error", "Stripe couldn't open the billing portal. Try again in a minute.");
    throw error;
  }
}

/**
 * POST /web/install-code {option, plan}: the personal install command's one-time code (see
 * AuthObject.issueInstallCode). The page shows `curl -fsSL https://dl.new/i/<code> | sh`.
 */
async function webInstallCode(c: Ctx): Promise<Response> {
  const found = await webPerson(c);
  if (found instanceof Response) return found;
  const retry = await limited(c, `installcode:gh:${found.identity.githubId}`, LIMITS.installCodePerson);
  if (retry !== undefined) return rateLimited(retry);
  const body = (await readJson(c)) ?? {};
  if (!isInstallOption(body.option)) return apiError(400, "invalid_request", 'Send {option: "computer" | "gpu", plan?: "free" | "pro"}.');
  const plan = planFor(body.option, body.plan);
  if (body.option === "computer" && !plan) return apiError(400, "invalid_request", 'On this computer, send plan "free" or "pro".');
  const issued = await auth(c).issueInstallCode({ identity: found.identity, option: body.option, plan, now: c.now() });
  if (plan === "free") await countWebStep(c, "plan_free");
  await countWebStep(c, "command_shown");
  return json({ code: issued.code, expires_in: Math.round((issued.expiresAt - c.now()) / 1000) });
}

/**
 * POST /v1/install-code/exchange {code, device_id?}: the installed dl (Autopilot) trades the
 * install command's code, once, for a sign-in session, as the device-code poll would give it,
 * plus what the person chose (`option`, `plan`). A device id is bound as device-code sign-in
 * binds one. Used, expired or unknown codes are 400 invalid_install_code (sign in with the device
 * code instead). Codes are never logged.
 */
async function installCodeExchange(c: Ctx): Promise<Response> {
  const retry = await limited(c, `installcode:ip:${c.ipNet}`, LIMITS.installExchangeIp);
  if (retry !== undefined) return rateLimited(retry);
  if (await isPaused(c)) return pausedError();
  const body = (await readJson(c)) ?? {};
  const invalid = (reason: string) =>
    apiError(400, "invalid_install_code", reason === "used" ? "This install command was already used." : "This install command expired or isn't valid.", { reason });
  if (typeof body.code !== "string" || !ONE_TIME_CODE.test(body.code)) return invalid("unknown");
  const deviceId = typeof body.device_id === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(body.device_id) ? body.device_id : null;
  const redeemed = await auth(c).redeemInstallCode(body.code, c.now());
  if (!redeemed.ok) return invalid(redeemed.reason);
  const identity: Identity = { githubId: redeemed.githubId, login: redeemed.login };
  const person = await directory(c).getPerson(identity.githubId);
  if (!person) return apiError(403, "not_invited", "This GitHub account isn't on the free tier.");
  if (person.status === "blocked") return blockedError();
  if (deviceId && (await directory(c).bindDevice({ ...identity, deviceId, now: c.now() })) === "device_taken") {
    await countRefusal(c, "device_taken", identity.githubId);
    return apiError(403, "device_taken", DEVICE_TAKEN_MESSAGE, { reason: "device_taken" });
  }
  const session = await auth(c).issueSession(identity, c.now());
  await countWebStep(c, "code_exchanged");
  return json({ ...(await tokenBody(c, identity, session.refreshToken, session.family)), login: identity.login, option: redeemed.option, plan: redeemed.plan });
}

/** GET /admin/dashboard/refusals.csv: every kept day's refusal counts per reason. */
async function refusalsCsvResponse(c: Ctx): Promise<Response> {
  return new Response(refusalsCsv(await directory(c).refusals()), {
    status: 200,
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="free-refusals-${isoDay(c.now())}.csv"`, "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

/** GET /admin/dashboard/web-signup.csv: the web sign-up funnel per day. */
async function webFunnelCsvResponse(c: Ctx): Promise<Response> {
  return new Response(webFunnelCsv(await directory(c).webFunnel()), {
    status: 200,
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="free-web-signup-${isoDay(c.now())}.csv"`, "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}
