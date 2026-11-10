import type { DurableObjectNamespace } from "cloudflare:workers";
import { randomToken, sha256Hex, timingSafeEqual } from "../../shared/src/auth.js";
import { githubAuthorizeUrl, githubPrimaryEmail, githubPublicProfile, githubSignInFromCode, githubUserByLogin, githubUserFromCode, type Fetch } from "../../shared/src/github.js";
import { githubSignals } from "../../shared/src/github-signals.js";
import { hmacKey, signJwt, verifyJwt } from "../../shared/src/jwt.js";
import type { Limit } from "../../shared/src/rate-limit.js";
import { MAX_SERVER_KEYS, parseServerKey, type AccountObject, type Allowance, type Limits, type ServerKeyView } from "./account-object.js";
import type { AuthObject, Identity } from "./auth-object.js";
import { normalizeUserCode } from "./codes.js";
import { ConfigError, readFreeConfig, type FreeConfig, type Upstream } from "./config.js";
import type { DirectoryObject, Gate, GithubCheckOutcome, HostFailure, LevelSignalRow, PersonRow, PersonState, PersonStatus, RequestRecord, SpendSummary } from "./directory-object.js";
import { createCheckout, createPortal, githubIdFrom, idOf, invoicePeriodEnd, invoiceSubscription, periodEnd, proState, StripeError, verifyWebhook, type Product, type StripeEvent } from "./stripe.js";
import { accessRequestAlert, deliverAlerts, isHeaderSafeAddress, pauseAlert, sendEmail, type Alert, type EmailBinding, type ServingContext, type UpstreamOutcome } from "./alerts.js";
import { policyOf, waitText } from "./queue.js";
import { normalizeReferralCode, referralLink } from "./referrals.js";
import { networkOf, rateLimitNetwork } from "./network.js";
import { feedbackEmail, MAX_FEEDBACK_BYTES, parseFeedback, publicGithubEmail, type Sender } from "./feedback.js";
import { apiError, json } from "./errors.js";
import { homePage } from "./home-page.js";
import { dashboardCsv, dashboardPage, deniedPage, healthCsv, healthPage, isCsvTable, isHealthCsvTable, signedInPage, signInPage, simpleDashboardPage, STARTER_ROWS, toolsPage, type SpendView, type StarterRow, type ToolsState } from "./dashboard-page.js";
import { ACCESS_REQUEST_MAX_BYTES, ACCESS_REQUEST_USAGE, ACCESS_REQUESTS_PER_DAY, parseAccessRequest } from "./access-request.js";
import { cleanBatch } from "./events.js";
import { cleanDownload, cleanInstall, MAX_TELEMETRY_BYTES } from "./telemetry.js";
import {
  BLOCKED_MESSAGE,
  DEVICE_TAKEN_MESSAGE,
  DL_ONLY_MESSAGE,
  INVALID_INVITE_MESSAGE,
  isSignInRefusal,
  CREDIT_EXHAUSTED_MESSAGE,
  PAUSED_MESSAGE,
  QUEUED_SIGNED_IN,
  UPSTREAM_BUSY_MESSAGE,
  UPSTREAM_TIMEOUT_MESSAGE,
  UPSTREAM_UNAVAILABLE_MESSAGE,
  queuedMessage,
  quotaMessage,
  signInRefusal,
  TOTAL_BUDGET_MESSAGE,
  weeklyBudgetMessage,
  type SignInRefusal,
} from "./messages.js";
import { confirmPage, detailsPage, donePage, emailStopPage, enterCodePage, INVITE_ONLY_INTRO, invitePage, NO_GITHUB_ACTIVITY_INTRO, signedInDonePage, tooNewIntro } from "./pages.js";
import { chargedTokens, costAtPrices, costOf, estimatePromptTokens, isAllowedModel, parseUsage, type Usage } from "./quota.js";
import { ALLOWED_MODELS, DEFAULT_MODEL, FREE_MODELS, POOLS, creditPrices, fallbackOf, modelById, type FreeModel, type Pool } from "./models.js";
import { emailBlocked, emailDomain, normalizeEmail, PUBLIC_EMAIL_DOMAINS } from "./email-guard.js";
import {
  ACCESS_REQUEST_PATH,
  basicLine,
  batchCounter,
  belowBarLine,
  CREDITS_REQUEST_EMAIL,
  dayOf,
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
import { freeStatus, type FreeStatus } from "./status.js";
import { HOSTS_OBJECT, hostOf, isNoHostError, providerPreferences } from "./routing.js";
import { applyOverrides, parseSettingsUpdate, settingsView } from "./runtime-config.js";
import { meterStream } from "./sse.js";
import { isResponse, toChatCompletion, toChatStream, toResponsesRequest } from "./openai-responses.js";
import { DAY_MS, isoDay, weekEnd, weekStart } from "./week.js";
import { healthWindow } from "./health-data.js";
import {
  deliverUserEmail,
  EMAIL_STOP_BASE,
  logUserEmails,
  sendPlainEmail,
  stopUrl,
  userEmailsOn,
  userEmailTransport,
  verifyStopToken,
  weekMostlyUsed,
  type UserEmailBinding,
  type UserEmailStore,
  type UserEmailTransport,
} from "./user-email-send.js";
import { renderUserEmail, resetsText, USER_EMAILS, type UserEmailKind } from "./user-emails.js";
import { BROADCAST_BATCH, broadcastBody, broadcastId, hasCapitals, parseBroadcast, parseCopy, type BroadcastRequest } from "./broadcast.js";
import { MAX_GRANT_LOGINS, parseLogins, type GrantResult } from "./grant.js";

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
 */

export const VERSION = "0.1.0";
export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const LUMINAL_URL = "https://flash.luminal.cloud/v1/chat/completions";
/** OpenAI's Responses API: its chat completions API refuses function tools while GPT-6 reasons. */
export const OPENAI_URL = "https://api.openai.com/v1/responses";
/** OpenRouter-only request fields Luminal's OpenAI-compatible API doesn't take. */
const OPENROUTER_ONLY_FIELDS = ["provider", "usage", "models", "route", "transforms", "plugins", "session_id", "reasoning", "max_tokens"] as const;
/** Retry-After for a transient Luminal error that didn't say, in seconds. */
const DEFAULT_RETRY_AFTER_S = 5;
export const ACCESS_TTL_S = 3600;
/** How long a revoked session id is remembered: past any access token from it (TTL plus verify leeway). */
const REVOKED_SESSION_TTL_MS = (ACCESS_TTL_S + 120) * 1000;
const ISSUER = "directionallylocal-free";
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
const CALLBACK_PATH = "/device/callback";
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
  // Feedback is an email to the owner: a few at a time is plenty.
  feedbackPersonHour: { capacity: 5, perHour: 5 },
  feedbackPersonDay: { capacity: 20, perHour: 20 / 24 },
  feedbackIp: { capacity: 10, perHour: 10 },
} satisfies Record<string, Limit>;

export interface Env {
  OPENROUTER_API_KEY?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
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
  TOPUP_PRICE_USD?: string;
  TOPUP_TOKENS?: string;
  TOPUP_VALID_DAYS?: string;
  ALERT_WEBHOOK_URL?: string;
  ALERT_WEBHOOK_KIND?: string;
  ALERT_TELEGRAM_CHAT_ID?: string;
  ALERT_EMAIL_TO?: string;
  ALERT_EMAIL_FROM?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_PRO?: string;
  STRIPE_PRICE_TOPUP?: string;
  BILLING_SUCCESS_URL?: string;
  BILLING_CANCEL_URL?: string;
  BILLING_PORTAL_RETURN_URL?: string;
  PRO_WEEKLY_USD_CAP?: string;
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
  /** A secret: Resend's API key for emails to users, when USER_EMAIL isn't bound. Never logged. */
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_REPLY_TO?: string;
  USER_EMAILS?: string;
  USER_EMAILS_TO_ADMINS?: string;
  DL_ONLY?: string;
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
}

interface Ctx {
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
  /** The pause between emails to users (HandlerOptions.emailGapMs). */
  emailGapMs: number;
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
  fetch(request: Request, env: Env): Promise<Response>;
  scheduled(controller: ScheduledController, env: Env): Promise<void>;
} {
  const now = options.now ?? (() => Date.now());
  const fetcher: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const statusCache: Ctx["statusCache"] = { at: 0 };
  const emailGapMs = options.emailGapMs ?? EMAIL_GAP_MS;
  return {
    /**
     * Cron triggers. The only one is the daily digest (DIGEST_CRON); the weekly queue needs
     * none, it runs on the first request of the week. Never throws for an unknown cron.
     */
    async scheduled(controller: ScheduledController, env: Env): Promise<void> {
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
    },
    async fetch(request: Request, env: Env): Promise<Response> {
      let config: FreeConfig;
      try {
        config = readFreeConfig(env as unknown as Record<string, unknown>);
      } catch (error) {
        if (error instanceof ConfigError) return apiError(500, "misconfigured", error.message);
        throw error;
      }
      const url = new URL(request.url);
      const ip = clientIp(request);
      const ctx: Ctx = { request, url, env, config, now, fetch: fetcher, ip, ipNet: rateLimitNetwork(ip), base: config.publicUrl ?? url.origin, statusCache, emailGapMs };
      return route(ctx);
    },
  };
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
  if (method === "GET" && path === "/v1/me") return me(c);
  if (method === "GET" && path === "/v1/models") return models(c);
  if (method === "POST" && path === "/v1/chat/completions") return chat(c);
  if (method === "POST" && path === "/v1/events") return events(c);
  if (method === "POST" && path === "/v1/feedback") return feedback(c);
  if ((method === "GET" || method === "POST") && path === ACCESS_REQUEST_PATH) return accessRequest(c, method);
  if (method === "GET" && path === "/v1/feedback/reply-address") return feedbackReplyAddress(c);
  if (method === "POST" && path === "/v1/telemetry/download") return telemetry(c, "download");
  if (method === "POST" && path === "/v1/telemetry/install") return telemetry(c, "install");
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

async function limited(c: Ctx, key: string, limit: Limit): Promise<number | undefined> {
  const outcome = await c.env.RATE_LIMITER.getByName(key).spend(key, limit, 1, c.now());
  return outcome.allowed ? undefined : outcome.retryAfterSeconds;
}

function rateLimited(retryAfter: number, headers: Record<string, string> = {}): Response {
  return apiError(429, "rate_limited", `Too many requests. Try again in ${retryAfter} seconds.`, { retryAfter }, { "retry-after": String(retryAfter), ...headers });
}

async function readJson(c: Ctx): Promise<Record<string, unknown> | undefined> {
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
 * a batch-flagged Starter account gets 0 tokens.
 */
function limitsFor(config: FreeConfig, bonusTokens = 0, level: Level = "full", batchFlagged = false): Limits {
  const served = servedLevel(level, config);
  const base = { weeklyTokens: config.weeklyTokens, proTokensPerWeek: config.offers.pro.tokensPerWeek, proUsdPerWeek: config.proWeeklyUsdCap };
  if (served === "full") return { ...base, weeklyUsd: config.perPersonWeeklyUsdCap, level: "full", ...(bonusTokens > 0 ? { bonusTokens } : {}) };
  if (served === "basic") return { ...base, weeklyUsd: config.basicWeeklyUsdCap, level: "basic", levelTokens: config.basicWeeklyTokens };
  return { ...base, weeklyUsd: config.starterWeeklyUsdCap, level: "starter", levelTokens: batchFlagged ? 0 : config.starterWeeklyTokens };
}

/**
 * One person's limits as their own requests get them: their level (basic with its tokens off is
 * Starter), the creation-batch flag (0 tokens) and this week's referral bonus. For admin views of
 * someone else, where `runtime(c)` holds the caller.
 */
async function personLimits(c: Ctx, config: FreeConfig, githubId: number, now: number): Promise<{ level: Level; limits: Limits }> {
  const person = (await directory(c).gate(now, policyOf(c.config), githubId)).person;
  const level = servedLevel(person?.level ?? "full", config);
  return { level, limits: limitsFor(config, person?.bonusTokens, level, person?.batchFlagged === true) };
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
function peopleChecks(people: LevelSignalRow[], config: FreeConfig, now: number): Map<number, LevelChecks> {
  const rules = signalThresholds(config);
  const peers = batchCounter(
    people.map((person) => person.github_created_day ?? null),
    rules.batchWindowDays,
  );
  const out = new Map<number, LevelChecks>();
  for (const person of people) {
    // The count includes the person's own row; the check counts the others.
    const day = person.github_created_day ?? null;
    const batchPeers = Math.max(0, peers(day) - (day === null ? 0 : 1));
    out.set(person.github_id, levelChecks(storedSignals(person), levelThresholds(config), rules, { now, batchPeers }));
  }
  return out;
}

const signingKeys = new Map<string, Promise<CryptoKey>>();
function signingKey(config: FreeConfig): Promise<CryptoKey> {
  let key = signingKeys.get(config.tokenSigningKey);
  if (!key) {
    key = hmacKey(config.tokenSigningKey);
    signingKeys.set(config.tokenSigningKey, key);
  }
  return key;
}

/** `sid` is the refresh-token family: the sign-in session the access token belongs to. */
async function tokenResponse(c: Ctx, identity: Identity, refreshToken: string, sid: string): Promise<Response> {
  const iat = Math.floor(c.now() / 1000);
  const accessToken = await signJwt(
    { iss: ISSUER, typ: "access", sub: String(identity.githubId), login: identity.login, sid, iat, exp: iat + ACCESS_TTL_S, jti: crypto.randomUUID() },
    await signingKey(c.config),
  );
  return json({ access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: ACCESS_TTL_S });
}

/** Who is calling: from a sign-in session's access token, or from a server key. */
interface Caller extends Identity {
  via: "access" | "key";
  /** The sign-in session, for access tokens issued since sessions were tracked. */
  sid?: string;
}

/**
 * The person behind a valid access token, or a 401. With `keys`, a server key is accepted
 * too. An access token from a revoked session is refused like an expired one.
 */
async function authenticate(c: Ctx, options: { keys?: boolean } = {}): Promise<Caller | Response> {
  const header = c.request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  const invalid = () => apiError(401, "invalid_token", "Sign in again: the access token is missing, invalid or expired.", {}, { "www-authenticate": 'Bearer error="invalid_token"' });
  if (!match) return invalid();
  const bearer = match[1]!;
  if (bearer.startsWith("dlk_")) {
    const invalidKey = () =>
      apiError(401, "invalid_key", "This server key is invalid or was revoked. Create a new one from a signed-in machine.", {}, { "www-authenticate": 'Bearer error="invalid_token"' });
    const parsed = parseServerKey(bearer);
    if (!options.keys || !parsed) return options.keys ? invalidKey() : invalid();
    const owner = await account(c, parsed.githubId).verifyKey(parsed.id, parsed.secret, c.now());
    return owner ? { ...owner, via: "key" } : invalidKey();
  }
  const claims = await verifyJwt(bearer, await signingKey(c.config), Math.floor(c.now() / 1000));
  if (!claims || claims.typ !== "access" || claims.iss !== ISSUER || typeof claims.login !== "string") return invalid();
  const githubId = Number(claims.sub);
  if (!Number.isSafeInteger(githubId) || githubId <= 0) return invalid();
  const sid = typeof claims.sid === "string" ? claims.sid : undefined;
  if (!(await account(c, githubId).sessionAllowed(sid, claims.iat))) return invalid();
  return { githubId, login: claims.login, via: "access", ...(sid ? { sid } : {}) };
}

function account(c: Ctx, githubId: number) {
  return c.env.ACCOUNT.getByName(`gh:${githubId}`);
}

function directory(c: Ctx) {
  return c.env.DIRECTORY.getByName("directory");
}

function auth(c: Ctx) {
  return c.env.AUTH.getByName("auth");
}

/** The OpenRouter hosts that failed recently (see rate-limit-object.ts). */
function hosts(c: Ctx) {
  return c.env.RATE_LIMITER.getByName(HOSTS_OBJECT);
}

/** The config with the admin's runtime overrides applied, the kill switch, and non-admin spend. */
interface Runtime {
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
}

/**
 * Read once per request: an override changed mid-request applies from the next one. The
 * Directory also runs Monday's queue admission here, on the first request of the week.
 */
function runtime(c: Ctx): Promise<Runtime> {
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
    }));
  return c.runtimeState;
}

/** Sends alerts by email and/or webhook; never fails the request. */
async function alert(c: Ctx, alerts: readonly Alert[]): Promise<void> {
  await deliver(c, alerts);
}

/** Whether a provider has a key and credit left. */
function providerReady(provider: Upstream, config: FreeConfig, gate: { creditUsedUsd: number; openaiCreditUsedUsd: number }): boolean {
  if (provider === "openai") return config.openaiApiKey !== undefined && gate.openaiCreditUsedUsd < config.openaiCreditUsd;
  if (provider === "luminal") return config.luminalApiKey !== undefined && gate.creditUsedUsd < config.luminalCreditUsd;
  return config.openRouterApiKey !== undefined;
}

/** Whether a provider is out of credit, as opposed to having no key at all. */
function providerExhausted(provider: Upstream, config: FreeConfig, gate: { creditUsedUsd: number; openaiCreditUsedUsd: number }): boolean {
  if (provider === "openai") return config.openaiApiKey !== undefined && gate.openaiCreditUsedUsd >= config.openaiCreditUsd;
  if (provider === "luminal") return config.luminalApiKey !== undefined && gate.creditUsedUsd >= config.luminalCreditUsd;
  return false;
}

/** A provider's prepaid credit balance, for the pause alert. */
function providerCredit(provider: Upstream, config: FreeConfig): number {
  return provider === "openai" ? config.openaiCreditUsd : config.luminalCreditUsd;
}

/**
 * The model and provider that serve: the requested model on its own provider when that has a
 * key and credit, else its fallback (any OpenAI model → DeepSeek on Luminal). DeepSeek can also
 * be served by OpenRouter, the old upstream, when Luminal has no key. Undefined when nothing can.
 */
function servingModel(
  requested: FreeModel,
  gate: { creditUsedUsd: number; openaiCreditUsedUsd: number },
  config: FreeConfig,
): { model: FreeModel; provider: Upstream; fallback: boolean } | undefined {
  const primary = config.primaryUpstream;
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
function modelAvailable(model: FreeModel, config: FreeConfig, gate: { creditUsedUsd: number; openaiCreditUsedUsd: number }): boolean {
  return servingModel(model, gate, config) !== undefined;
}

/** Who serves now and where to switch, for the Luminal slow-down emails. */
function servingContext(c: Ctx, config: FreeConfig): ServingContext {
  return {
    serving: chooseUpstream(config.primaryUpstream, c.config) ?? "none",
    openRouterConfigured: c.config.openRouterApiKey !== undefined,
    switchUrl: `${c.base}/admin?view=full#upstream`,
  };
}

/** `alert` without a request: for cron runs too. */
async function deliver(c: Pick<Ctx, "config" | "env" | "fetch" | "base" | "now">, alerts: readonly Alert[]): Promise<void> {
  if (alerts.length === 0) return;
  await deliverAlerts({ alerts, config: c.config, emailBinding: c.env.ALERT_EMAIL, fetch: c.fetch, adminUrl: `${c.base}/admin`, now: c.now() });
}

/** The paid offers, from config (Stripe billing sells them). */
function offers(config: FreeConfig) {
  return {
    pro: { priceUsdMonthly: config.offers.pro.priceUsdMonthly, tokensPerWeek: config.offers.pro.tokensPerWeek },
    topup: { priceUsd: config.offers.topup.priceUsd, tokens: config.offers.topup.tokens, validDays: config.offers.topup.validDays },
  };
}

function linkFor(config: FreeConfig, person: PersonState | undefined): string | null {
  return person?.referral ? referralLink(config.referralLinkBase, person.referral.code) : null;
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
function blockedError(headers: Record<string, string> = {}): Response {
  return apiError(403, "blocked", BLOCKED_MESSAGE, {}, headers);
}

function pausedError(headers: Record<string, string> = {}): Response {
  return apiError(503, "service_paused", PAUSED_MESSAGE, { reason: "paused", pausedForEveryone: true, resetsAt: null }, headers);
}

// ─── Emails to users (user-email-send.ts) ────────────────────────────────────

/** The provider for emails to users: the USER_EMAIL binding, else Resend, else none. */
function userEmailVia(c: Pick<Ctx, "env" | "config" | "fetch">): UserEmailTransport | undefined {
  return userEmailTransport(c.env.USER_EMAIL, c.config, c.fetch);
}

/** Sends one email to a user if it should go. Never throws and never fails the request. */
async function userEmail(c: Ctx, config: FreeConfig, kind: UserEmailKind, githubId: number, period: string): Promise<void> {
  const transport = userEmailVia(c);
  if (!userEmailsOn(config, transport)) return;
  const outcome = await deliverUserEmail({
    store: directory(c) as unknown as UserEmailStore,
    transport,
    config,
    signingKey: await signingKey(c.config),
    base: c.config.publicUrl ?? EMAIL_STOP_BASE,
    kind,
    githubId,
    period,
    now: c.now(),
  });
  logUserEmails(kind, [outcome]);
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
  const candidates = await store.userEmailCandidates(now);
  const jobs: Array<{ kind: UserEmailKind; githubId: number; period: string; retry?: boolean }> = [
    ...candidates.retries.map((job) => ({ ...job, retry: true })),
    ...candidates.didntStart.map((githubId) => ({ kind: "didnt_start" as const, githubId, period: "" })),
    ...candidates.goneQuiet.map((githubId) => ({ kind: "gone_quiet" as const, githubId, period: "" })),
  ];
  const key = await signingKey(config);
  const outcomes: Array<"sent" | "failed" | "skipped"> = [];
  for (const job of jobs.slice(0, MAX_DAILY_USER_EMAILS)) {
    const outcome = await deliverUserEmail({
      store: store as unknown as UserEmailStore,
      transport,
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

/** At most this many emails to users per daily run; the rest wait a day. */
const MAX_DAILY_USER_EMAILS = 300;

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

function keyView(key: ServerKeyView) {
  return {
    id: key.id,
    name: key.name,
    createdAt: new Date(key.createdAt).toISOString(),
    lastUsedAt: key.lastUsedAt === null ? null : new Date(key.lastUsedAt).toISOString(),
  };
}

/** POST/GET /v1/keys and DELETE /v1/keys/:id. Managing keys takes a signed-in access token, not a key. */
async function keys(c: Ctx, rest: string, method: string): Promise<Response> {
  const identity = await authenticate(c);
  if (identity instanceof Response) return identity;
  const guarded = await apiGuard(c, identity);
  if (guarded) return guarded;
  const person = account(c, identity.githubId);

  if (rest === "" && method === "GET") return json({ keys: (await person.listKeys()).map(keyView), max: MAX_SERVER_KEYS });
  if (rest === "" && method === "POST") {
    const body = await readJson(c);
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!KEY_NAME.test(name)) return apiError(400, "invalid_request", "Send {name}: 1 to 64 printable characters, e.g. the server's hostname.");
    const created = await person.createKey({ name, now: c.now() });
    if (created.ok) return json({ ...keyView(created.view), key: created.key }, 201);
    switch (created.code) {
      case "key_limit_reached":
        return apiError(409, "key_limit_reached", `This account already has ${MAX_SERVER_KEYS} server keys. Revoke one first.`, { max: MAX_SERVER_KEYS });
      case "key_name_taken":
        return apiError(409, "key_name_taken", "This account already has a server key with that name.");
      case "suspended":
        return apiError(403, "suspended", "This account is suspended from the free tier.");
      case "blocked":
        return blockedError();
      case "not_invited":
        return apiError(403, "not_invited", "This GitHub account isn't on the free tier.");
    }
  }
  if (/^[a-z0-9]{12}$/.test(rest) && method === "DELETE") {
    if (!(await person.revokeKey(rest))) return apiError(404, "key_not_found", "No server key with that id on this account.");
    return json({ id: rest, revoked: true });
  }
  return apiError(404, "not_found", `${method} /v1/keys/${rest} isn't a route.`);
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
    return donePage("Paused", PAUSED_MESSAGE, 503);
  }
  const ref = normalizeReferralCode(c.url.searchParams.get("ref") ?? undefined);
  const begun = userCode ? await auth(c).beginOAuth(userCode, c.now(), ref) : undefined;
  if (!begun) return enterCodePage("That code is unknown, used or expired. Start sign-in again in your terminal.");
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

function readCookie(request: Request, name: string): string | undefined {
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
  if (level === "basic") return { line: basicLine(config.basicWeeklyTokens, config.basicWeeklyUsdCap) };
  const flagged = signIn.batchFlagged === true || person?.batch_flag === 1;
  return { line: starterLine(levelThresholds(config), flagged ? 0 : config.starterWeeklyTokens, config.starterWeeklyUsdCap) };
}

/** The welcome email for the level a new sign-up was admitted at. */
function welcomeKind(level: Level, batchFlagged: boolean, config: FreeConfig): UserEmailKind {
  const served = servedLevel(level, config);
  if (served === "full") return "welcome";
  if (served === "basic") return "welcome_basic";
  return noFreeTokens(served, config, batchFlagged) ? "welcome_starter" : "welcome_starter_small";
}

const EMAIL_BLOCKED_MESSAGE = "This email can't be used for the free tier. Use your own API key instead, or write to contact@directionallylocal.com.";
const EMAIL_IN_USE_MESSAGE = "This email is already used by another dl account. Each person gets one free account.";
const DOMAIN_LIMIT_MESSAGE = "Too many new free accounts from this email domain today. Try again tomorrow, or write to contact@directionallylocal.com.";

/** A plausible address: one @, a dot in the domain, no spaces, at most 254 characters. */
function validEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * POST /device/details: the step after GitHub. Saves the contact email and the updates choice,
 * and redeems an invite code when a Starter account gives one, then finishes sign-in.
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
  const inviteCode = starter ? (form.get("invite_code") ?? "").trim() || undefined : undefined;
  const again = (error: string) => detailsPage(ticket, found.login, { email, updates, ...(starter ? { starter } : {}), error });
  if (!validEmail(email)) return again("Enter an email address we can reach you at.");
  // One free account per inbox, no blocked inboxes or domains, and a daily cap per company domain.
  const { config: guard } = await runtime(c);
  const inbox = normalizeEmail(email);
  if (!c.config.adminGithubIds.has(found.githubId)) {
    if (emailBlocked(inbox, guard.blockedEmails)) return again(EMAIL_BLOCKED_MESSAGE);
    if (await directory(c).emailInUse(inbox, found.githubId)) return again(EMAIL_IN_USE_MESSAGE);
    const domain = emailDomain(inbox);
    if (!person && !PUBLIC_EMAIL_DOMAINS.has(domain) && (await directory(c).domainSignupsSince(domain, c.now() - DAY_MS)) >= guard.domainSignupsPerDay) {
      return again(DOMAIN_LIMIT_MESSAGE);
    }
  }
  if (inviteCode) {
    const retry = await limited(c, `invite:ip:${c.ipNet}`, LIMITS.inviteAttemptIp);
    if (retry !== undefined) return again(`Too many invite attempts. Try again in ${Math.ceil(retry / 60)} minutes, or leave the code empty.`);
  }
  const level: SignInLevel = inviteCode ? { ...details.level, level: "full", levelReason: "invite" } : details.level;
  const response = await admitAndFinish(c, found.deviceRef, found.clientDeviceId, found, inviteCode, undefined, ticket, found.referralCode ?? undefined, level, {
    onInvalidInvite: () => again("That invite code isn't valid or was already used. Check it, or leave it empty to continue."),
  });
  // Saved for anyone admitted (new or returning); a refusal leaves nothing to save it on.
  const saved = await directory(c).setEmail(found.githubId, email, updates, c.now());
  // The welcome email, for a new sign-up only: nobody was in the Directory before this step.
  // Not for someone still waiting in line for free tokens: the Directory checks.
  if (saved && !person) {
    const config = (await runtime(c)).config;
    // The welcome for the level the person was admitted at (a network limit can lower it).
    const admittedAs = await directory(c).getPerson(found.githubId);
    const kind = welcomeKind(admittedAs?.level ?? level.level, admittedAs ? admittedAs.batch_flag === 1 : level.batchFlagged === true, config);
    await userEmail(c, config, kind, found.githubId, "");
  }
  return response;
}

const GITHUB_USER_AGENT = "directionallylocal-free";
/** How long the sign-up activity check waits for GitHub's GraphQL API before letting the person through. */
const GITHUB_CHECK_TIMEOUT_MS = 5000;

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
  // A network-limited account is re-checked soon after sign-in (it may already qualify on its
  // own signals), then on the weekly cadence.
  const since = person.level_reason === "network_limit" ? c.now() - 60 * 60_000 : week;
  if (person.signals_at !== null && person.signals_at >= since) return undefined;
  const profile = await githubPublicProfile(identity.login, c.fetch, GITHUB_USER_AGENT, GITHUB_CHECK_TIMEOUT_MS);
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
  const batchPeers = await directory(c).creationBatchPeers(createdDay, rules.batchWindowDays, user.id);
  const checks = levelChecks(signals, thresholds, rules, { now: c.now(), batchPeers });
  return { signals, level: levelFor(checks, signals, basicRule(config)), levelReason: levelReason(signals, thresholds, checks), batchFlagged: !checks.full && checks.creationBatch };
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
  options: { onInvalidInvite?: () => Response } = {},
): Promise<Response> {
  const isAdmin = c.config.adminGithubIds.has(identity.githubId);
  const { config } = await runtime(c);
  const signupKey = `signup:ip:${c.ipNet}`;
  const openEligible = config.openAdmission && inviteCode === undefined;
  const signupLimit = { capacity: config.networkSignupsPerDay, perHour: config.networkSignupsPerDay / 24 };
  const signupsLeft = openEligible ? (await c.env.RATE_LIMITER.getByName(signupKey).check(signupKey, signupLimit, 1, c.now())).allowed : true;
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
    now: c.now(),
  });
  if (result.ok) {
    if (result.created && (result.via === "invite" || result.via === "open")) await c.env.RATE_LIMITER.getByName(signupKey).spend(signupKey, LIMITS.signupIp, 1, c.now());
    await account(c, identity.githubId).activate({ githubId: identity.githubId, login: identity.login, isAdmin, now: c.now() });
    await auth(c).decide(deviceRef, "approved", identity, c.now());
    if (result.queueStarted) await alert(c, [await directory(c).queueStartedAlert(c.now(), policyOf(c.config))]);
    if (result.firstSignup) await alert(c, [result.firstSignup]);
    const queued = result.queued ? ` ${QUEUED_SIGNED_IN}` : "";
    const invite =
      config.referralBonusTokens > 0
        ? { link: referralLink(config.referralLinkBase, result.referralCode), bonusTokens: config.referralBonusTokens, capTokens: config.referralBonusCap }
        : undefined;
    return signedInDonePage(`Signed in as ${identity.login}.${queued} Return to your terminal; you can close this tab.`, invite);
  }
  const intro = inviteIntro(inviteReason, config.minGithubAccountAgeDays);
  const refuse = async (code: SignInRefusal, status: "not_invited" | "denied", httpStatus: number) => {
    await auth(c).decide(deviceRef, status, identity, c.now(), code);
    const { heading, message } = signInRefusal(code, config.minGithubAccountAgeDays);
    return donePage(heading, message, httpStatus);
  };
  switch (result.reason) {
    case "needs_invite": {
      const issued = await auth(c).decide(deviceRef, "needs_invite", identity, c.now(), inviteReason ?? "invite_required");
      return invitePage(issued.ticket ?? "", identity.login, undefined, intro);
    }
    case "invalid_invite":
      if (options.onInvalidInvite) return options.onInvalidInvite();
      return invitePage(ticket ?? "", identity.login, INVALID_INVITE_MESSAGE, intro);
    case "cohort_full":
      return refuse("cohort_full", "not_invited", 403);
    case "device_taken":
      await auth(c).decide(deviceRef, "denied", identity, c.now(), result.reason);
      return donePage("Can't sign in", DEVICE_TAKEN_MESSAGE, 403);
    case "blocked":
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
  if (retry !== undefined) return invitePage(ticket, found.login, `Too many attempts. Try again in ${Math.ceil(retry / 60)} minutes.`);
  const signups = await c.env.RATE_LIMITER.getByName(`signup:ip:${c.ipNet}`).check(`signup:ip:${c.ipNet}`, LIMITS.signupIp, 1, c.now());
  if (!signups.allowed) return invitePage(ticket, found.login, "Too many new accounts from this network today. Try again tomorrow.");
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

function allowanceView(allowance: Allowance) {
  return {
    tokensPerWeek: allowance.tokensPerWeek,
    usedThisWeek: allowance.usedThisWeek,
    remaining: allowance.remaining,
    resetsAt: new Date(allowance.resetsAt).toISOString(),
    usdPerWeek: allowance.usdPerWeek,
    spentUsdThisWeek: allowance.spentUsdThisWeek,
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
      models: FREE_MODELS.map((model) => ({ id: model.id, available: modelAvailable(model, gate.config, gate) })),
    });
    c.statusCache.at = now;
  }
  return json(c.statusCache.value, 200, { ...STATUS_CORS, "cache-control": "public, max-age=30" });
}

/**
 * GET /v1/me. Besides the allowance (with this week's referral bonus included; `remaining` is
 * 0 while queued): `plan`, `topupTokensLeft`, `queue` (null, or `{position, etaAt}`),
 * `referral` and `offers`. See the README for the exact shapes.
 */
async function me(c: Ctx): Promise<Response> {
  const identity = await authenticate(c, { keys: true });
  if (identity instanceof Response) return identity;
  const guarded = await apiGuard(c, identity);
  if (guarded) return guarded;
  c.callerId = identity.githubId;
  const { config, person } = await runtime(c);
  const allowance = await account(c, identity.githubId).allowance(c.now(), limitsFor(config, person?.bonusTokens, person?.level ?? "full", person?.batchFlagged === true));
  if (!allowance.exists) return apiError(403, "not_invited", "This GitHub account isn't on the free tier.");
  // A Pro subscriber isn't waiting for anything; their place is kept if Pro ends.
  const queue = allowance.plan === "pro" ? null : (person?.queue ?? null);
  const view = allowanceView(allowance);
  return json({
    login: identity.login,
    githubId: identity.githubId,
    status: allowance.status,
    /** "full", "basic" or "starter": what this account may use. */
    level: servedLevel(person?.level ?? "full", config),
    /** Why the level is what it is, so a client can explain without guessing. */
    levelReason: person?.levelReason ?? null,
    /** The thresholds a Full account must clear, from the effective config. */
    thresholds: levelThresholds(config),
    /** The GitHub signals the level came from, as numbers only. */
    signals: person?.signals ?? null,
    allowance: queue ? { ...view, remaining: 0 } : view,
    /** Each model's weekly allowance, so a client can show what each one has left. */
    pools: Object.fromEntries(
      POOLS.map((pool) => [
        pool,
        {
          tokensPerWeek: allowance.pools[pool].tokensPerWeek,
          usedThisWeek: allowance.pools[pool].usedThisWeek,
          remaining: queue ? 0 : allowance.pools[pool].remaining,
          resetsAt: new Date(allowance.resetsAt).toISOString(),
          models: FREE_MODELS.filter((model) => model.pool === pool).map((model) => model.id),
        },
      ]),
    ),
    models: [...ALLOWED_MODELS],
    plan: allowance.plan,
    topupTokensLeft: allowance.topupTokensLeft,
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
        }
      : null,
    offers: offers(config),
  });
}

// ─── Billing ────────────────────────────────────────────────────────────────

function billingReady(c: Ctx, product?: Product): Response | undefined {
  const { stripe } = c.config;
  const price = product === "pro" ? stripe.pricePro : product === "topup" ? stripe.priceTopup : "n/a";
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
  const unavailable = billingReady(c, product);
  if (unavailable) return unavailable;
  const person = account(c, identity.githubId);
  const allowance = await person.allowance(c.now(), limitsFor((await runtime(c)).config));
  if (!allowance.exists) return apiError(403, "not_invited", "This GitHub account isn't on the free tier.");
  if (allowance.status === "blocked") return blockedError();
  if (allowance.status === "suspended") return apiError(403, "suspended", "This account is suspended from the free tier.");
  if (product === "pro" && allowance.plan === "pro") return apiError(409, "already_pro", "This account already has Pro. Manage it from the billing portal.");
  const billing = await person.billing();
  try {
    const session = await createCheckout(c.fetch, {
      product,
      config: c.config.stripe,
      githubId: identity.githubId,
      login: identity.login,
      customerId: billing.customerId,
      idempotencyKey: crypto.randomUUID(),
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
  await directory(c).markBillingEvent(event.id, event.type, c.now());
  return json({ received: true, outcome });
}

/** Applies one event. Every step is idempotent on its own, so a retried delivery is harmless. */
async function applyBillingEvent(c: Ctx, event: StripeEvent): Promise<string> {
  const object = event.data.object;
  const eventAt = event.created;
  const customerId = idOf(object.customer);
  const owner = async (...candidates: unknown[]) => githubIdFrom(...candidates) ?? (customerId ? await directory(c).customerOwner(customerId) : undefined);
  const subscription = async (githubId: number, input: { subscriptionId: string; state: "active" | "past_due" | "canceled"; periodEnd: number | null | undefined; cancelAtPeriodEnd?: boolean }) => {
    const person = account(c, githubId);
    const applied = await person.applySubscription({ ...input, ...(customerId ? { customerId } : {}), eventAt });
    if (!applied) return "stale";
    const state = await person.billing();
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
        const { tokens, validDays } = c.config.offers.topup;
        const createdAt = eventAt * 1000;
        await account(c, githubId).grantTopup({ id: String(object.id), tokens, createdAt, expiresAt: createdAt + validDays * DAY_MS });
        await directory(c).recordPayment({ id: String(object.id), githubId, kind: "topup", amountCents: cents(object.amount_subtotal ?? object.amount_total), at: createdAt });
        return "topup_granted";
      }
      const subscriptionId = idOf(object.subscription);
      if (!subscriptionId) return "ignored";
      return subscription(githubId, { subscriptionId, state: "active", periodEnd: undefined });
    }
    case "invoice.paid":
    case "invoice.payment_failed": {
      const { subscriptionId, metadata } = invoiceSubscription(object);
      if (!subscriptionId) return "ignored";
      const githubId = await owner(metadata.github_id);
      if (githubId === undefined) return "ignored";
      if (event.type === "invoice.payment_failed") return subscription(githubId, { subscriptionId, state: "past_due", periodEnd: undefined });
      await directory(c).recordPayment({ id: String(object.id), githubId, kind: "pro", amountCents: cents(object.total_excluding_tax ?? object.subtotal ?? object.amount_paid), at: eventAt * 1000 });
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

async function models(c: Ctx): Promise<Response> {
  const identity = await authenticate(c, { keys: true });
  if (identity instanceof Response) return identity;
  const guarded = await apiGuard(c, identity);
  if (guarded) return guarded;
  return json({
    object: "list",
    data: FREE_MODELS.map((model) => ({
      id: model.id,
      object: "model",
      owned_by: model.provider,
      name: model.name,
      context_window: model.contextWindow,
      max_output_tokens: model.maxOutputTokens,
    })),
  });
}

async function events(c: Ctx): Promise<Response> {
  const identity = await authenticate(c, { keys: true });
  if (identity instanceof Response) return identity;
  const guarded = await apiGuard(c, identity);
  if (guarded) return guarded;
  const body = await readJson(c);
  if (!body || !Array.isArray(body.events)) return apiError(400, "invalid_request", "Send {events: [...]}, at most 100.");
  const allowance = await account(c, identity.githubId).allowance(c.now(), limitsFor((await runtime(c)).config));
  if (!allowance.exists) return apiError(403, "not_invited", "This GitHub account isn't on the free tier.");
  const cleaned = cleanBatch(body, c.now());
  const accepted = await directory(c).recordEvents(identity.githubId, cleaned, c.now());
  return json({ accepted }, 202);
}

// ─── Access requests ────────────────────────────────────────────────────────

/**
 * POST /v1/access-request {building, link?} → 201 {status: "pending"}; GET → {status, at?}.
 * dl's /request command: any signed-in person who isn't blocked asks for (more) free tokens.
 * One pending at a time (409 already_pending), not for Full (409 already_full), at most
 * ACCESS_REQUESTS_PER_DAY a day (429). What they wrote is user content: stored as plain text and
 * shown only on the admin Tools tab (escaped). Never logged, never in an alert or a metric.
 */
async function accessRequest(c: Ctx, method: string): Promise<Response> {
  const identity = await authenticate(c, { keys: true });
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
  if (stored.level === "full" || c.config.adminGithubIds.has(identity.githubId)) {
    return apiError(409, "already_full", "You already have the full free tier.");
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
  // daily digest, "off" to the admin home screen.
  if ((await runtime(c)).config.accessRequestAlerts === "each") await alert(c, [accessRequestAlert(identity.login, result.pendingCount)]);
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
 * No sign-in. Each adds one to that day's total for its values; nothing else is kept. The rate
 * limit is per IP, keyed by a hash salted with the signing key and the day, so the address
 * itself is never stored. 204 when counted.
 */
async function telemetry(c: Ctx, kind: "download" | "install"): Promise<Response> {
  const day = Math.floor(c.now() / DAY_MS);
  const ipKey = await sha256Hex(`telemetry:${c.config.tokenSigningKey}:${day}:${c.ipNet}`);
  const retry = await limited(c, `telemetry:${kind}:${ipKey}`, kind === "download" ? LIMITS.telemetryDownloadIp : LIMITS.telemetryInstallIp);
  if (retry !== undefined) return rateLimited(retry);
  if (Number(c.request.headers.get("content-length") ?? 0) > MAX_TELEMETRY_BYTES) return apiError(413, "too_large", "A telemetry body is under 1 KB.");
  const text = await c.request.text();
  if (text.length > MAX_TELEMETRY_BYTES) return apiError(413, "too_large", "A telemetry body is under 1 KB.");
  const body = parseJson(text);
  if (kind === "download") {
    const count = cleanDownload(body);
    if (typeof count === "string") return apiError(400, "invalid_request", count);
    await directory(c).countDownload(count, day);
  } else {
    const count = cleanInstall(body);
    if (typeof count === "string") return apiError(400, "invalid_request", count);
    await directory(c).countInstall(count, day);
  }
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

// ─── Inference ──────────────────────────────────────────────────────────────

function quotaHeaders(allowance: Allowance): Record<string, string> {
  return { "x-dl-tokens-remaining": String(allowance.remaining), "x-dl-quota-resets-at": new Date(allowance.resetsAt).toISOString() };
}

async function chat(c: Ctx): Promise<Response> {
  const identity = await authenticate(c, { keys: true });
  if (identity instanceof Response) {
    identity.headers.set("x-dl-quota-resets-at", new Date(weekEnd(c.now())).toISOString());
    return identity;
  }
  const person = account(c, identity.githubId);
  const isAdmin = c.config.adminGithubIds.has(identity.githubId);
  if (c.config.paused) return pausedError(quotaHeaders(await person.allowance(c.now(), limitsFor(c.config))));
  c.callerId = identity.githubId;
  const gate = await runtime(c);
  if (gate.person?.blocked) return blockedError();
  // A Starter account is re-checked once a week from its public profile, and promoted if it
  // now qualifies. Promotion only: nobody is demoted mid-week.
  if (gate.person && (gate.person.level === "starter" || gate.person.level === "basic") && !isAdmin) {
    const promoted = await recheckStarter(c, identity, gate.config);
    if (promoted) gate.person.level = promoted;
  }
  const level = servedLevel(gate.person?.level ?? "full", gate.config);
  const batchFlagged = gate.person?.batchFlagged === true;
  const limits = limitsFor(gate.config, gate.person?.bonusTokens, level, batchFlagged);
  const link = linkFor(gate.config, gate.person);
  const headers = async () => quotaHeaders(await person.allowance(c.now(), limits));

  const guarded = await apiGuard(c, identity, headers);
  if (guarded) return guarded;
  // Below the bar with no free tokens: say who free tokens are for and how to ask anyway. The
  // refusal is counted per day for the sign-up funnel (ids and days only).
  if (!isAdmin && noFreeTokens(level, gate.config, batchFlagged)) {
    await directory(c).recordRefusal(identity.githubId, c.now());
    return apiError(403, "below_bar", belowBarLine(levelThresholds(gate.config)), { contact: CREDITS_REQUEST_EMAIL, request: ACCESS_REQUEST_PATH }, await headers());
  }

  const raw = await c.request.text();
  const bodyBytes = new TextEncoder().encode(raw).length;
  if (bodyBytes > MAX_BODY_BYTES) return apiError(413, "request_too_large", "The request body is larger than 8 MB.", {}, await headers());
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return apiError(400, "invalid_request", "The body must be one JSON object.", {}, await headers());
  }
  if (!isAllowedModel(body.model)) {
    return apiError(400, "model_not_allowed", `The free tier serves ${ALLOWED_MODELS.join(", ")} only.`, { allowed: [...ALLOWED_MODELS] }, await headers());
  }
  const requested = modelById(body.model)!;
  // Every level gets every model; basic and Starter on their smaller allowance.
  const effective = requested;

  if (gate.paused) return pausedError(await headers());
  // Which model actually serves: the requested one when its provider has a key and credit left,
  // else its fallback (GPT-6 Luna → DeepSeek). Never another model.
  const serving = servingModel(effective, gate, gate.config);
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
  // Free tokens work inside dl only: a sign-in token that made many requests in the last day
  // while Autopilot sent no session event is in another tool (abuse.ts). Server keys (dl's server
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

  const requestedMax = numberOrUndefined(body.max_tokens) ?? numberOrUndefined(body.max_completion_tokens);
  const promptEstimate = estimatePromptTokens(bodyBytes);
  // The requested model’s pool pays for the request, even when its fallback serves it: someone
  // who asks for Sol spends Sol’s allowance, not Luna’s.
  const pool = effective.pool;
  const reserveFor = (pool: Pool, serves: { model: FreeModel; provider: Upstream }) =>
    person.reserve({
      pool,
      promptEstimate,
      requestedMaxTokens: requestedMax,
      limits: { ...limits, freeBlocked: freeBlock !== undefined },
      now: c.now(),
      provider: serves.provider,
      model: serves.model.id,
    });
  const reservation = await reserveFor(pool, serving);
  if (!reservation.ok) {
    const quota = quotaHeaders(reservation.allowance);
    if (reservation.code === "quota_exceeded") {
      if (freeBlock && reservation.allowance.plan === "free") return freeBlock();
      const resetsAt = new Date(reservation.allowance.resetsAt).toISOString();
      // A basic or Starter week used up: what the level gets, when it resets, and the ways to more.
      if (!isAdmin && reservation.allowance.plan === "free" && (level === "basic" || level === "starter")) {
        return apiError(
          402,
          `${level}_limit`,
          limitLine(level, limits.levelTokens ?? 0, limits.weeklyUsd),
          { resetsAt, reason: reservation.reason, request: ACCESS_REQUEST_PATH, offers: offers(gate.config), referralLink: link },
          quota,
        );
      }
      return apiError(402, "quota_exceeded", quotaMessage(reservation.reason, resetsAt, reservation.allowance.plan), { resetsAt, reason: reservation.reason, offers: offers(gate.config), referralLink: link }, quota);
    }
    if (reservation.code === "blocked") return blockedError(quota);
    if (reservation.code === "suspended") return apiError(403, "suspended", "This account is suspended from the free tier.", {}, quota);
    return apiError(403, "not_invited", "This GitHub account isn't on the free tier.", {}, quota);
  }

  const stream = body.stream === true;
  const user = `dl-${(await sha256Hex(`free:${identity.githubId}`)).slice(0, 32)}`;
  const sessionId = c.request.headers.get("x-session-id") ?? (typeof body.session_id === "string" ? body.session_id : undefined);
  const cooldownMs = gate.config.openRouterHostCooldownMinutes * 60_000;
  const failingHosts = cooldownMs > 0 && serving.provider === "openrouter" ? await hosts(c).failingHosts(c.now() - cooldownMs) : [];
  const started = c.now();

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
    options: { chargeNothing?: boolean; host?: string; failure?: HostFailure; ttfbMs?: number; ttftMs?: number; upstreamError?: boolean; outcome?: UpstreamOutcome } = {},
  ) => {
    const { chargeNothing = false, host, failure } = options;
    if (host && failure && cooldownMs > 0) await hosts(c).markHostFailing(host, c.now());
    const charged = chargeNothing ? 0 : usage ? chargedTokens(usage, gate.config.cachedTokenWeight) : undefined;
    const cost = chargeNothing ? 0 : usage ? (provider === "openrouter" ? costOf(usage, 0) : costAtPrices(usage, model.prices)) : undefined;
    const settled = await person.settle({ reservationId, charged, costUsd: cost, limits, now: c.now() });
    // Without usage, the credit is charged what the allowance was: the reservation at the fallback price.
    const creditUsd = chargeNothing || provider === "openrouter" ? 0 : usage ? costAtPrices(usage, creditPrices(model)) : settled.costUsd;
    const record: RequestRecord = {
      githubId: identity.githubId,
      isAdmin,
      at: started,
      model: model.id,
      promptTokens: usage?.promptTokens ?? 0,
      completionTokens: usage?.completionTokens ?? 0,
      cachedTokens: usage?.cachedTokens ?? 0,
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
      ...(identity.via === "key" ? { viaKey: true } : {}),
    };
    await alert(c, await directory(c).recordRequest(record, policyOf(gate.config), servingContext(c, gate.config)));
    // Most of the week's free tokens used: one email a week, on the settlement that crossed 80%.
    if (!settled.paid && !isAdmin && userEmailsOn(gate.config, userEmailVia(c)) && weekMostlyUsed(settled.allowance)) {
      await userEmail(c, gate.config, "week_80", identity.githubId, String(weekStart(c.now())));
    }
    return settled.allowance;
  };

  /** One attempt on `model`, with a fresh reservation. OpenAI retries on its fallback when it can. */
  const attempt = (model: FreeModel, provider: Upstream, res: Extract<typeof reservation, { ok: true }>): Promise<Response> => {
    const settleFor: Settle = (usage, status, options) => settle(model, provider, res.reservationId, usage, status, options);
    if (provider === "openai") {
      const backup = fallbackOf(model.id);
      const retry =
        backup && providerReady(backup.provider, gate.config, gate)
          ? async (): Promise<Response> => {
              const again = await reserveFor(pool, { model: backup, provider: backup.provider });
              if (!again.ok) return apiError(503, "upstream_unavailable", UPSTREAM_UNAVAILABLE_MESSAGE, { retryable: true }, quotaHeaders(again.allowance));
              const response = await attempt(backup, backup.provider, again);
              // Tell the client which model actually answered, so it can say so.
              const headers = new Headers(response.headers);
              headers.set("x-dl-fallback", backup.id);
              return new Response(response.body, { status: response.status, headers });
            }
          : undefined;
      return openaiChat(c, { model, body, stream, maxTokens: res.maxTokens, user, sessionId, started, settle: settleFor, timeoutSeconds: gate.config.openaiFirstByteTimeoutSeconds, reservedAllowance: res.allowance, ...(retry ? { retry } : {}) });
    }
    if (provider === "luminal") {
      return luminalChat(c, { model, body, stream, maxTokens: res.maxTokens, user, started, settle: settleFor, timeoutSeconds: gate.config.luminalFirstByteTimeoutSeconds, reservedAllowance: res.allowance });
    }
    return openRouterChat(c, { model, config: gate.config, body, stream, maxTokens: res.maxTokens, user, sessionId, started, settle: settleFor, reservedAllowance: res.allowance, failingHosts });
  };

  const response = await attempt(serving.model, serving.provider, reservation);
  if (!serving.fallback) return response;
  // The requested model's provider couldn't serve it, so its fallback did: say which.
  const outHeaders = new Headers(response.headers);
  outHeaders.set("x-dl-fallback", serving.model.id);
  return new Response(response.body, { status: response.status, headers: outHeaders });

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
    return apiError(response.status >= 500 ? 502 : response.status === 402 ? 503 : 400, response.status === 402 ? "service_paused" : "upstream_error", upstreamMessage(text), { upstreamStatus: response.status }, quota);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (stream && response.body && contentType.includes("text/event-stream")) {
    const metered = meterStream(
      response.body,
      async ({ usage, errored, upstreamFailed, host, firstContentAt }) => {
        await settle(usage, usage ? (errored ? "stream_error" : "ok") : "no_usage", {
          ttfbMs,
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
  options?: { chargeNothing?: boolean; ttfbMs?: number; ttftMs?: number; upstreamError?: boolean; outcome?: UpstreamOutcome },
) => Promise<Allowance>;

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
  const { body, stream, started, settle } = input;
  const payload: Record<string, unknown> = { ...body, model: input.model.upstreamModel, max_completion_tokens: input.maxTokens, user: input.user };
  // OpenRouter's `reasoning: {effort}` is `reasoning_effort` in the OpenAI shape.
  const effort = (body.reasoning as { effort?: unknown } | undefined)?.effort;
  if (typeof effort === "string" && payload.reasoning_effort === undefined) payload.reasoning_effort = effort;
  for (const field of OPENROUTER_ONLY_FIELDS) delete payload[field];
  if (stream) payload.stream_options = { include_usage: true };
  else delete payload.stream_options;

  const transient = async (status: 429 | 503, code: string, message: string, retryAfterHeader: string | null, record: { status: string; outcome: UpstreamOutcome; ttfbMs?: number }) => {
    const allowance = await settle(undefined, record.status, { chargeNothing: true, upstreamError: true, outcome: record.outcome, ...(record.ttfbMs !== undefined ? { ttfbMs: record.ttfbMs } : {}) });
    const retryAfter = Math.max(1, Math.ceil(Number(retryAfterHeader)) || DEFAULT_RETRY_AFTER_S);
    return apiError(status, code, message, { retryAfter, retryable: true, upstream: "luminal" }, { ...quotaHeaders(allowance), "retry-after": String(retryAfter) });
  };

  let response: Response | "timeout";
  try {
    response = await fetchWithTimeout(
      c.fetch,
      LUMINAL_URL,
      {
        method: "POST",
        headers: { authorization: `Bearer ${c.config.luminalApiKey}`, "content-type": "application/json" },
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
    // A 4xx: the request itself (400), or the service's key or account (401, 402, 403).
    const ours = response.status === 401 || response.status === 402 || response.status === 403;
    const allowance = await settle(undefined, "upstream_error", { chargeNothing: true, ttfbMs, ...(ours ? { upstreamError: true } : {}) });
    return apiError(ours ? 502 : 400, "upstream_error", ours ? "The model provider refused the service's key. Try again later." : upstreamMessage(text), { upstreamStatus: response.status }, quotaHeaders(allowance));
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (stream && response.body && contentType.includes("text/event-stream")) {
    const metered = meterStream(
      response.body,
      async ({ usage, errored, upstreamFailed, firstContentAt }) => {
        await settle(usage, usage ? (errored ? "stream_error" : "ok") : "no_usage", {
          ttfbMs,
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

  const text = await response.text();
  const parsed = parseJson(text) as { usage?: unknown; error?: unknown } | undefined;
  const usage = parseUsage(parsed?.usage);
  const allowance = await settle(usage, usage ? "ok" : "no_usage", { ttfbMs, ttftMs: c.now() - started, ...(parsed?.error ? { upstreamError: true } : {}) });
  return new Response(text, {
    status: 200,
    headers: { "content-type": contentType || "application/json", "cache-control": "no-store", ...quotaHeaders(allowance) },
  });
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
    return apiError(ours ? 502 : 400, "upstream_error", ours ? "The model provider refused the service's key. Try again later." : upstreamMessage(text), { upstreamStatus: response.status }, quotaHeaders(allowance));
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (stream && response.body && contentType.includes("text/event-stream")) {
    const metered = meterStream(
      toChatStream(response.body),
      async ({ usage, errored, upstreamFailed, firstContentAt }) => {
        await settle(usage, usage ? (errored ? "stream_error" : "ok") : "no_usage", {
          ttfbMs,
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
  const allowance = await settle(usage, usage ? "ok" : "no_usage", { ttfbMs, ttftMs: c.now() - started, ...(parsed?.error ? { upstreamError: true } : {}) });
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

function upstreamMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string") return `The model provider refused the request: ${parsed.error.message.slice(0, 300)}`;
  } catch {
    // not JSON
  }
  return "The model provider refused the request.";
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

  if (method === "GET" && rest === "metrics") return adminMetrics(c);
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
    const result = await decideAccessRequest(c, config, Number(decide[1]), decide[2] as "grant" | "decline", note, actor);
    return "code" in result ? failed(result) : json(result);
  }
  if (method === "POST" && rest === "emails/test") return adminTestEmail(c, identity.githubId);
  if (method === "POST" && rest === "emails/broadcast") return adminBroadcast(c, config);
  if (method === "POST" && rest === "grant") {
    const body = (await readJson(c)) ?? {};
    const logins = body.logins;
    const usage = `Send {logins: ["octocat", ...]}: 1 to ${MAX_GRANT_LOGINS} GitHub usernames (a leading @ or a github.com URL is fine).`;
    if (!Array.isArray(logins) || logins.length === 0 || logins.length > MAX_GRANT_LOGINS || !logins.every((login) => typeof login === "string")) return apiError(400, "invalid_request", usage);
    const results = await grantLogins(c, logins.join("\n"), actor);
    return "status" in results ? failed(results) : json({ results });
  }
  if (method === "GET" && rest === "spend") {
    const spend = await directory(c).spend(now);
    return json({
      ...spend,
      weekStart: new Date(spend.weekStart).toISOString(),
      resetsAt: new Date(spend.resetsAt).toISOString(),
      paid: { usd: spend.paidUsd, tokens: spend.paidTokens, requests: spend.paidRequests },
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
        perPersonWeeklyUsd: config.perPersonWeeklyUsdCap ?? null,
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
  if (method === "GET" && rest === "people") {
    const levelFilter = c.url.searchParams.get("level");
    const sharedOnly = c.url.searchParams.get("shared") === "1";
    const people = await directory(c).listPeople();
    const checks = peopleChecks(people, config, now);
    const sessions = await directory(c).weekSessions(now);
    const rows = await Promise.all(
      people.map(async (person) => {
        const allowance = await account(c, person.github_id).allowance(now, limitsFor(config, 0, person.level, person.batch_flag === 1));
        return {
          githubId: person.github_id,
          login: person.login,
          status: person.status,
          isAdmin: c.config.adminGithubIds.has(person.github_id),
          admittedAt: new Date(person.admitted_at).toISOString(),
          admittedVia: person.admitted_via,
          level: person.level,
          levelReason: person.level_reason,
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
          networks: await directory(c).networkCount(person.github_id),
          allowance: allowanceView(allowance),
          serverKeys: await account(c, person.github_id).keyCount(),
          // Distinct dl sessions (from Autopilot's session events) since Monday 00:00 UTC.
          dlSessionsThisWeek: sessions.get(person.github_id) ?? 0,
        };
      }),
    );
    const filtered = rows.filter((row) => (levelFilter === null || row.level === levelFilter) && (!sharedOnly || row.networks > 1));
    return json({ people: filtered });
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
      return json({ ...detail, level: own.level, allowance: allowanceView(allowance), serverKeys: await account(c, githubId).keyCount() });
    }
    if (action === "revoke-tokens" && method === "POST") {
      // Ends every sign-in session and deletes every server key; the person can sign in again.
      if (!(await directory(c).getPerson(githubId))) return apiError(404, "not_found", "No such person.");
      const sessions = await auth(c).revokeAllFor(githubId);
      await account(c, githubId).revokeSessions({ sids: sessions, until: now + REVOKED_SESSION_TTL_MS, notBefore: Math.floor(now / 1000), now });
      const serverKeys = await account(c, githubId).revokeAllKeys();
      return json({ githubId, sessions: sessions.length, serverKeys });
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
      if ([tokensPerWeek, usdPerWeek, usedThisWeek, spentUsdThisWeek].includes("invalid") || usedThisWeek === null || spentUsdThisWeek === null) {
        return apiError(400, "invalid_request", "Send any of {tokensPerWeek, usdPerWeek} (a number, or null for the default) and {usedThisWeek, spentUsdThisWeek} (numbers).");
      }
      const allowance = await account(c, githubId).setGrant({
        tokensPerWeek: tokensPerWeek as number | null | undefined,
        usdPerWeek: usdPerWeek as number | null | undefined,
        usedThisWeek: usedThisWeek as number | undefined,
        spentUsdThisWeek: spentUsdThisWeek as number | undefined,
        limits: (await personLimits(c, config, githubId, now)).limits,
        now,
      });
      if (!allowance) return apiError(404, "not_found", "No such person.");
      await directory(c).recordGrant({ githubId, tokensPerWeek: tokensPerWeek as number | null | undefined, usdPerWeek: usdPerWeek as number | null | undefined });
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
  const transport = userEmailVia(c);
  if (!transport) return NO_EMAIL_PROVIDER;
  const unsubscribeUrl = await stopUrl(c.config.publicUrl ?? EMAIL_STOP_BASE, await signingKey(c.config), adminId);
  const email = copy?.ok
    ? { subject: copy.subject, body: broadcastBody(copy.text, unsubscribeUrl) }
    : renderUserEmail(kind, { resets: resetsText(weekEnd(c.now())), unsubscribeUrl });
  const outcome = await sendPlainEmail(transport, c.config, { to, subject: email.subject, text: email.body, unsubscribeUrl, idempotencyKey: `dl-test-email-${crypto.randomUUID()}` });
  if (!outcome.ok) return { status: 502, code: "email_failed", message: `The provider refused it, code ${outcome.code ?? "error"}.`, extra: { provider: transport.provider, code: outcome.code ?? "error" } };
  return { sent: true, provider: transport.provider, kind: copy ? "broadcast" : kind, to, messageId: outcome.messageId ?? null };
}

/**
 * POST /admin/emails/broadcast {subject, text, audience, signedUpFrom?, signedUpTo?, dryRun}: a
 * one-off email, see broadcast.ts, to active people of the audience's level who signed up in the
 * range. Never to blocked or suspended accounts, people who pressed stop, or admins; each gets the
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
  const transport = userEmailVia(c);
  if (!request.dryRun && !transport) return NO_EMAIL_PROVIDER;
  if (!request.dryRun && !config.userEmails) return { status: 409, code: "emails_off", message: "Emails to users are off (the userEmails setting)." };
  const id = await broadcastId(request.subject, request.text);
  const filter = { adminIds: [...c.config.adminGithubIds], includeAdmins: config.userEmailsToAdmins };
  const audience = await directory(c).broadcastAudience({ id, audience: request.audience, from: request.from, to: request.to, now: c.now(), ...filter });
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
  const batch = ready.slice(0, BROADCAST_BATCH);
  for (const [index, person] of batch.entries()) {
    const claim = await directory(c).claimBroadcast({ githubId: person.githubId, id, now: c.now(), ...filter });
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
  if (failedCount > 0) console.error(`user emails (broadcast): ${sent} sent, ${failedCount} failed`);
  else if (sent > 0) console.log(`user emails (broadcast): ${sent} sent`);
  return { dryRun: false, id, provider: transport!.provider, sent, failed: failedCount, skipped, remaining: ready.length - sent - skipped, waitingForTomorrow: waiting, stoppedBy };
}

/**
 * Gives free tokens to the GitHub usernames in `text` (grant.ts parseLogins; at most
 * MAX_GRANT_LOGINS, or nothing is done). Each is resolved to its id
 * through GitHub's public API, then raised to Full, left alone when blocked, or pre-granted when
 * it has no account yet. Logs counts only.
 */
async function grantLogins(c: Ctx, text: string, actor: { githubId: number; login: string; now: number }): Promise<GrantResult[] | AdminFailure> {
  const { logins, invalid } = parseLogins(text);
  if (logins.length + invalid.length === 0) return { status: 400, code: "invalid_request", message: "Paste one or more GitHub usernames." };
  if (logins.length > MAX_GRANT_LOGINS) return { status: 400, code: "invalid_request", message: `At most ${MAX_GRANT_LOGINS} usernames at a time; this has ${logins.length}.` };
  const results: GrantResult[] = [];
  for (const input of logins) {
    const user = await githubUserByLogin(input, c.fetch, GITHUB_USER_AGENT, GITHUB_CHECK_TIMEOUT_MS);
    if (user === "not_found" || user === "error") {
      results.push({ input, outcome: user === "error" ? "github_error" : "not_found" });
      continue;
    }
    const outcome = await directory(c).grantFull(user.id, user.login, actor);
    results.push({ input, outcome, login: user.login, githubId: user.id });
  }
  for (const input of invalid) results.push({ input, outcome: "not_found" });
  const counts = new Map<string, number>();
  for (const result of results) counts.set(result.outcome, (counts.get(result.outcome) ?? 0) + 1);
  console.log(`admin grant: ${[...counts].map(([outcome, n]) => `${n} ${outcome}`).join(", ") || "nothing"}`);
  return results;
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
  const checks = peopleChecks(people, config, now);
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
): Promise<{ id: number; githubId: number; login: string; status: "granted" | "declined" } | AdminFailure> {
  const result = await directory(c).decideAccessRequest({ id, decision, note, actor });
  if (!result) return { status: 404, code: "not_found", message: "No such pending request." };
  if (result.status === "blocked") return { status: 409, code: "blocked", message: `${result.login} is blocked; unblock the account first.` };
  if (result.status === "granted") await userEmail(c, config, "access_granted", result.githubId, String(id));
  console.log(`admin access request ${result.status}`);
  return { id, githubId: result.githubId, login: result.login, status: result.status };
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
  const metrics = await directory(c).metrics({ from, to, now, adminIds: [...c.config.adminGithubIds] });
  return json({ ...metrics, generatedAt: new Date(now).toISOString(), today: isoDay(now) });
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
  return new Response(null, { status: 303, headers: { location: "/admin?view=full#abuse", "cache-control": "no-store" } });
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
  return new Response(null, { status: 303, headers: { location: "/admin?view=full#upstream", "cache-control": "no-store" } });
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
  if (csv === undefined && c.url.searchParams.get("view") === "tools") {
    return toolsPage(await toolsState(c, config, identity, viaCookie, csrf, { grant: { text: "" }, compose: emptyEmailForm() }));
  }
  // The Health view and its CSVs read only health-data.ts's queries.
  if ((csv === undefined && c.url.searchParams.get("view") === "health") || (csv !== undefined && isHealthCsvTable(csv))) {
    const health = await directory(c).health({ now, adminIds: [...c.config.adminGithubIds], days: healthWindow(c.url.searchParams.get("days")) });
    return csv !== undefined && isHealthCsvTable(csv) ? healthCsv(csv, health) : healthPage({ health, login: identity.login, signOut: viaCookie });
  }
  // The home screen is the default; Simple and Full are opt-in (?view=simple, ?view=full).
  const viewName = c.url.searchParams.get("view");
  if (csv === undefined && viewName !== "simple" && viewName !== "full") return homeResponse(c, config, paused, now, csrf, viaCookie);
  const simple = csv === undefined && viewName === "simple";
  const weekParam = c.url.searchParams.get("week");
  const topWeek = weekParam && /^\d{4}-\d{2}-\d{2}$/.test(weekParam) ? Date.parse(`${weekParam}T00:00:00Z`) : Number.NaN;
  const [data, spend, abuse, simpleData] = await Promise.all([
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
    csv === undefined ? directory(c).abuse({ now, adminIds: [...c.config.adminGithubIds] }) : undefined,
    simple ? directory(c).simple({ now, adminIds: [...c.config.adminGithubIds] }) : undefined,
  ]);
  const view = spendView(c, config, paused, spend);
  if (csv !== undefined && isCsvTable(csv) && !isHealthCsvTable(csv)) return dashboardCsv(csv, data, view);
  if (simpleData) return simpleDashboardPage({ data, spend: view, signOut: viaCookie, simple: simpleData, ...(abuse ? { abuse } : {}) });
  const starters = await startersView(c, config, now);
  return dashboardPage({ data, spend: view, login: identity.login, signOut: viaCookie, starters, ...(abuse ? { abuse } : {}), ...(csrf ? { csrf } : {}) });
}

/** GET /admin: the home screen, from the small home reads, the spend counters and the pending requests. */
async function homeResponse(c: Ctx, config: FreeConfig, paused: boolean, now: number, csrf: string | undefined, signOut: boolean, notice?: { error: boolean; text: string }): Promise<Response> {
  const [home, spend, requests] = await Promise.all([
    directory(c).home({ now, adminIds: [...c.config.adminGithubIds] }),
    directory(c).spend(now),
    directory(c).pendingAccessRequests(now),
  ]);
  return homePage({ home, spend: spendView(c, config, paused, spend), requests, signOut, ...(csrf ? { csrf } : {}), ...(notice ? { notice } : {}) });
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
    basicWeeklyTokens: config.basicWeeklyTokens,
    basicWeeklyUsd: config.basicWeeklyUsdCap ?? null,
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

/** Everything the Tools tab shows besides what was just posted. */
async function toolsState(
  c: Ctx,
  config: FreeConfig,
  identity: Identity,
  signOut: boolean,
  csrf: string | undefined,
  posted: Pick<ToolsState, "grant" | "compose"> & Partial<Pick<ToolsState, "requestNotice" | "recheck">>,
): Promise<ToolsState> {
  const [cohorts, me, requests] = await Promise.all([
    directory(c).broadcastCohorts({ days: COHORT_PICKER_DAYS, adminIds: [...c.config.adminGithubIds], includeAdmins: config.userEmailsToAdmins }),
    directory(c).getPerson(identity.githubId),
    directory(c).pendingAccessRequests(c.now()),
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
  const { config, paused } = await runtime(c);
  const actor = { githubId: session.githubId, login: session.login, now: c.now() };
  const state = (posted: Pick<ToolsState, "grant" | "compose"> & Partial<Pick<ToolsState, "requestNotice" | "recheck">>) => toolsState(c, config, session, true, csrf, posted).then(toolsPage);

  if (form.get("tool") === "recheck") {
    return state({ grant: { text: "" }, compose: emptyEmailForm(), recheck: await recheckBelowBar(c, config, actor) });
  }
  if (form.get("tool") === "request") {
    const id = Number(form.get("id"));
    const action = form.get("action");
    const note = (form.get("note") ?? "").trim().slice(0, 300) || null;
    // The home screen's cards post here too (from=home), and get the home screen back.
    const home = form.get("from") === "home";
    const answer = (requestNotice: { error: boolean; text: string }) =>
      home ? homeResponse(c, config, paused, c.now(), csrf, true, requestNotice) : state({ grant: { text: "" }, compose: emptyEmailForm(), requestNotice });
    if (!Number.isSafeInteger(id) || (action !== "grant" && action !== "decline")) return answer({ error: true, text: "Pick Grant or Decline on a request." });
    const result = await decideAccessRequest(c, config, id, action, note, actor);
    return answer(
      "code" in result
        ? { error: true, text: result.message }
        : { error: false, text: result.status === "granted" ? `Granted: ${result.login} is Full now, and gets an email.` : `Declined ${result.login}'s request.` },
    );
  }

  if (form.get("tool") === "grant") {
    const text = (form.get("logins") ?? "").slice(0, 20_000);
    const results = await grantLogins(c, text, actor);
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

/** The full dashboard's Starter accounts: stored signals and checks, newest first, admins left out. */
async function startersView(c: Ctx, config: FreeConfig, now: number): Promise<{ rows: StarterRow[]; total: number }> {
  const people = await directory(c).levelSignals();
  const checks = peopleChecks(people, config, now);
  const starters = people.filter((person) => person.level === "starter" && !c.config.adminGithubIds.has(person.github_id)).reverse();
  const rows = starters.slice(0, STARTER_ROWS).map(
    (person): StarterRow => ({
      githubId: person.github_id,
      login: person.login,
      admittedAt: person.admitted_at,
      levelReason: person.level_reason,
      accountAgeDays: person.account_age_days,
      publicRepos: person.public_repos,
      contributions: person.contributions,
      followers: person.followers,
      activeWeeks: person.active_weeks ?? null,
      outsideContributions: person.outside_contributions ?? null,
      oldestRepoAt: person.oldest_repo_at ?? null,
      social: person.social ?? null,
      checks: checks.get(person.github_id)!,
    }),
  );
  return { rows, total: starters.length };
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
