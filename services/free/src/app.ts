import type { DurableObjectNamespace } from "cloudflare:workers";
import { randomToken, sha256Hex, timingSafeEqual } from "../../shared/src/auth.js";
import { githubAuthorizeUrl, githubContributionsLastYear, githubSignInFromCode, githubUserFromCode, type Fetch } from "../../shared/src/github.js";
import { hmacKey, signJwt, verifyJwt } from "../../shared/src/jwt.js";
import type { Limit } from "../../shared/src/rate-limit.js";
import { MAX_SERVER_KEYS, parseServerKey, type AccountObject, type Allowance, type Limits, type ServerKeyView } from "./account-object.js";
import type { AuthObject, Identity } from "./auth-object.js";
import { normalizeUserCode } from "./codes.js";
import { ConfigError, readFreeConfig, type FreeConfig, type Upstream } from "./config.js";
import type { DirectoryObject, Gate, GithubCheckOutcome, HostFailure, PersonState, PersonStatus, RequestRecord } from "./directory-object.js";
import { createCheckout, createPortal, githubIdFrom, idOf, invoicePeriodEnd, invoiceSubscription, periodEnd, proState, StripeError, verifyWebhook, type Product, type StripeEvent } from "./stripe.js";
import { deliverAlerts, pauseAlert, sendEmail, type Alert, type EmailBinding, type ServingContext, type UpstreamOutcome } from "./alerts.js";
import { policyOf, waitText } from "./queue.js";
import { normalizeReferralCode, referralLink } from "./referrals.js";
import { networkOf, rateLimitNetwork } from "./network.js";
import { feedbackEmail, MAX_FEEDBACK_BYTES, parseFeedback, publicGithubEmail, type Sender } from "./feedback.js";
import { apiError, json } from "./errors.js";
import { dashboardCsv, dashboardPage, deniedPage, isCsvTable, signedInPage, signInPage, type SpendView } from "./dashboard-page.js";
import { cleanBatch } from "./events.js";
import { cleanDownload, cleanInstall, MAX_TELEMETRY_BYTES } from "./telemetry.js";
import {
  BLOCKED_MESSAGE,
  DEVICE_TAKEN_MESSAGE,
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
import { confirmPage, donePage, enterCodePage, INVITE_ONLY_INTRO, invitePage, NO_GITHUB_ACTIVITY_INTRO, signedInDonePage, tooNewIntro } from "./pages.js";
import { ALLOWED_MODELS, chargedTokens, costAtPrices, costOf, estimatePromptTokens, isAllowedModel, parseUsage, type Usage } from "./quota.js";
import type { RateLimiterObject } from "./rate-limit-object.js";
import { chooseUpstream } from "./upstream-choice.js";
import { HOSTS_OBJECT, hostOf, isNoHostError, providerPreferences } from "./routing.js";
import { applyOverrides, parseSettingsUpdate, settingsView } from "./runtime-config.js";
import { meterStream } from "./sse.js";
import { DAY_MS, isoDay, weekEnd } from "./week.js";

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
/** Luminal's id for the one model the free tier serves. */
export const LUMINAL_MODELS: Readonly<Record<(typeof ALLOWED_MODELS)[number], string>> = {
  "deepseek/deepseek-v4.1-flash-1017": "deepseek-ai/DeepSeek-V4.1-Flash-1017",
};
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
  LUMINAL_FIRST_BYTE_TIMEOUT_SECONDS?: string;
  LUMINAL_PRICE_INPUT?: string;
  LUMINAL_PRICE_CACHED?: string;
  LUMINAL_PRICE_OUTPUT?: string;
  OPENROUTER_PRICE_INPUT?: string;
  OPENROUTER_PRICE_CACHED?: string;
  OPENROUTER_PRICE_OUTPUT?: string;
  LUMINAL_CREDIT_USD?: string;
  LUMINAL_WEEKLY_CREDIT_USD?: string;
  /** Cloudflare's send_email binding for alert email; optional (absent off Cloudflare). */
  ALERT_EMAIL?: EmailBinding;
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

export function createHandler(options: HandlerOptions = {}): {
  fetch(request: Request, env: Env): Promise<Response>;
  scheduled(controller: ScheduledController, env: Env): Promise<void>;
} {
  const now = options.now ?? (() => Date.now());
  const fetcher: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
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
      const ctx: Ctx = { request, url, env, config, now, fetch: fetcher, ip, ipNet: rateLimitNetwork(ip), base: config.publicUrl ?? url.origin };
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
  if (method === "GET" && path === "/v1/me") return me(c);
  if (method === "GET" && path === "/v1/models") return models(c);
  if (method === "POST" && path === "/v1/chat/completions") return chat(c);
  if (method === "POST" && path === "/v1/events") return events(c);
  if (method === "POST" && path === "/v1/feedback") return feedback(c);
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

/** `bonusTokens`: this week's referral bonus, added on top of the weekly allowance. */
function limitsFor(config: FreeConfig, bonusTokens = 0): Limits {
  return {
    weeklyTokens: config.weeklyTokens,
    weeklyUsd: config.perPersonWeeklyUsdCap,
    proTokensPerWeek: config.offers.pro.tokensPerWeek,
    proUsdPerWeek: config.proWeeklyUsdCap,
    ...(bonusTokens > 0 ? { bonusTokens } : {}),
  };
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
      ...(gate.person ? { person: gate.person } : {}),
    }));
  return c.runtimeState;
}

/** Sends alerts by email and/or webhook; never fails the request. */
async function alert(c: Ctx, alerts: readonly Alert[]): Promise<void> {
  await deliver(c, alerts);
}

/** Who serves now and where to switch, for the Luminal slow-down emails. */
function servingContext(c: Ctx, config: FreeConfig): ServingContext {
  return {
    serving: chooseUpstream(config.primaryUpstream, c.config) ?? "none",
    openRouterConfigured: c.config.openRouterApiKey !== undefined,
    switchUrl: `${c.base}/admin#upstream`,
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
  const location = githubAuthorizeUrl({ clientId: c.config.githubClientId }, `${c.base}/device/callback`, begun.state);
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
  const minAgeMs = c.config.minGithubAccountAgeDays * DAY_MS;
  const accountTooNew = minAgeMs > 0 && (user.createdAt === undefined || c.now() - user.createdAt < minAgeMs);
  const inviteReason: InviteReason | undefined = accountTooNew
    ? "account_too_new"
    : (await hasGithubActivity(c, user.id, user.publicRepos, signIn.accessToken))
      ? undefined
      : "no_github_activity";
  return admitAndFinish(c, claimed.deviceRef, claimed.clientDeviceId, identity, undefined, inviteReason, undefined, claimed.referralCode ?? undefined);
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
async function hasGithubActivity(c: Ctx, githubId: number, publicRepos: number | undefined, accessToken: string): Promise<boolean> {
  const { config } = await runtime(c);
  if (!config.requireGithubActivity || c.config.adminGithubIds.has(githubId)) return true;
  if (publicRepos !== undefined && publicRepos > 0) return true;
  if (await directory(c).getPerson(githubId)) return true;
  let outcome: GithubCheckOutcome;
  try {
    outcome = (await githubContributionsLastYear(accessToken, c.fetch, GITHUB_USER_AGENT, GITHUB_CHECK_TIMEOUT_MS)) > 0 ? "contributions" : "none";
  } catch (error) {
    console.warn("GitHub activity check failed open:", error instanceof Error ? error.message : String(error));
    outcome = "error";
  }
  const checkAlert = await directory(c).countGithubCheck(outcome, c.now());
  if (checkAlert) await alert(c, [checkAlert]);
  return outcome !== "none";
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
): Promise<Response> {
  const isAdmin = c.config.adminGithubIds.has(identity.githubId);
  const { config } = await runtime(c);
  const signupKey = `signup:ip:${c.ipNet}`;
  const needsInvite = inviteReason !== undefined;
  const openEligible = config.openAdmission && !needsInvite && inviteCode === undefined;
  const signupsLeft = openEligible ? (await c.env.RATE_LIMITER.getByName(signupKey).check(signupKey, LIMITS.signupIp, 1, c.now())).allowed : true;
  const result = await directory(c).admit({
    githubId: identity.githubId,
    login: identity.login,
    isAdmin,
    inviteCode,
    clientDeviceId,
    accountTooNew: needsInvite,
    openAdmission: openEligible && signupsLeft,
    // With open admission there is no cap on people: the queue keeps free spend in budget.
    inviteOnly: !config.openAdmission,
    maxActive: config.maxActiveUsers,
    referralCode,
    networkHash: await networkHash(c),
    policy: policyOf(config),
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
      if (openEligible && !signupsLeft) return refuse("too_many_signups", "denied", 429);
      const issued = await auth(c).decide(deviceRef, "needs_invite", identity, c.now(), inviteReason ?? "invite_required");
      return invitePage(issued.ticket ?? "", identity.login, undefined, intro);
    }
    case "invalid_invite":
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
  return admitAndFinish(c, found.deviceRef, found.clientDeviceId, found, inviteCode, inviteReason, ticket, found.referralCode ?? undefined);
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
  const allowance = await account(c, identity.githubId).allowance(c.now(), limitsFor(config, person?.bonusTokens));
  if (!allowance.exists) return apiError(403, "not_invited", "This GitHub account isn't on the free tier.");
  // A Pro subscriber isn't waiting for anything; their place is kept if Pro ends.
  const queue = allowance.plan === "pro" ? null : (person?.queue ?? null);
  const view = allowanceView(allowance);
  return json({
    login: identity.login,
    githubId: identity.githubId,
    status: allowance.status,
    allowance: queue ? { ...view, remaining: 0 } : view,
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
  return json({ object: "list", data: ALLOWED_MODELS.map((id) => ({ id, object: "model", owned_by: "openrouter" })) });
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
  const limits = limitsFor(gate.config, gate.person?.bonusTokens);
  const link = linkFor(gate.config, gate.person);
  const headers = async () => quotaHeaders(await person.allowance(c.now(), limits));

  const guarded = await apiGuard(c, identity, headers);
  if (guarded) return guarded;

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

  if (gate.paused) return pausedError(await headers());
  // Which upstream serves: the setting, unless Luminal has no key. Never switched mid-request.
  const upstream = chooseUpstream(gate.config.primaryUpstream, c.config);
  // No upstream the service may use: never fall back to anything else.
  if (!upstream) return apiError(503, "upstream_unavailable", "Free tokens are unavailable right now. Try again later, or use your own key: /provider.", { reason: "no_upstream" }, await headers());
  if (upstream === "luminal" && gate.creditUsedUsd >= gate.config.luminalCreditUsd) {
    // The credit is used up: free and Pro usage pause (admins too) until it is topped up.
    const paused = await directory(c).creditPausedAlert(gate.config.luminalCreditUsd, c.now());
    if (paused) await alert(c, [paused]);
    return apiError(503, "upstream_credit_exhausted", CREDIT_EXHAUSTED_MESSAGE, { reason: "credit_exhausted", pausedForEveryone: true, resetsAt: null }, await headers());
  }
  // Why free tokens are unavailable to a free-plan person right now, if they are: queued, or a
  // global cap reached. Pro and top-ups still work; the reservation decides which applies.
  const place = isAdmin ? null : (gate.person?.queue ?? null);
  const { globalTotalUsdCap: total, globalWeeklyUsdCap: weekly } = gate.config;
  const freeBlock: (() => Promise<Response>) | undefined = isAdmin
    ? undefined
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
  const reservation = await person.reserve({
    promptEstimate: estimatePromptTokens(bodyBytes),
    requestedMaxTokens: requestedMax,
    limits: { ...limits, freeBlocked: freeBlock !== undefined },
    now: c.now(),
  });
  if (!reservation.ok) {
    const quota = quotaHeaders(reservation.allowance);
    if (reservation.code === "quota_exceeded") {
      if (freeBlock && reservation.allowance.plan === "free") return freeBlock();
      const resetsAt = new Date(reservation.allowance.resetsAt).toISOString();
      return apiError(402, "quota_exceeded", quotaMessage(reservation.reason, resetsAt, reservation.allowance.plan), { resetsAt, reason: reservation.reason, offers: offers(gate.config), referralLink: link }, quota);
    }
    if (reservation.code === "blocked") return blockedError(quota);
    if (reservation.code === "suspended") return apiError(403, "suspended", "This account is suspended from the free tier.", {}, quota);
    return apiError(403, "not_invited", "This GitHub account isn't on the free tier.", {}, quota);
  }

  const stream = body.stream === true;
  const upstreamBody: Record<string, unknown> = { ...body, max_tokens: reservation.maxTokens, usage: { include: true } };
  delete upstreamBody.max_completion_tokens;
  // Never fall back to another model, and route on our terms (see routing.ts): the cheapest
  // full-precision host that doesn't collect prompts, unless the owner pinned an order, and
  // not a host that failed a request in the last few minutes.
  delete upstreamBody.models;
  delete upstreamBody.route;
  const cooldownMs = gate.config.openRouterHostCooldownMinutes * 60_000;
  const failingHosts = cooldownMs > 0 && upstream === "openrouter" ? await hosts(c).failingHosts(c.now() - cooldownMs) : [];
  upstreamBody.provider = providerPreferences(gate.config, failingHosts);
  upstreamBody.user = `dl-${(await sha256Hex(`free:${identity.githubId}`)).slice(0, 32)}`;
  const sessionId = c.request.headers.get("x-session-id") ?? (typeof body.session_id === "string" ? body.session_id : undefined);
  if (sessionId && /^[\x21-\x7e]{1,256}$/.test(sessionId)) upstreamBody.session_id = sessionId;
  else delete upstreamBody.session_id;
  if (stream) upstreamBody.stream_options = { include_usage: true };

  const started = c.now();
  /**
   * `host` is who served or failed the request; with `failure`, it goes on the failing list too.
   * A Luminal request is charged to the person's dollar allowance at OpenRouter prices, so the
   * allowance means the same on either upstream, and its Luminal price goes to the credit.
   */
  const settle = async (
    usage: Usage | undefined,
    status: string,
    options: { chargeNothing?: boolean; host?: string; failure?: HostFailure; ttfbMs?: number; ttftMs?: number; upstreamError?: boolean; outcome?: UpstreamOutcome } = {},
  ) => {
    const { chargeNothing = false, host, failure } = options;
    if (host && failure && cooldownMs > 0) await hosts(c).markHostFailing(host, c.now());
    const charged = chargeNothing ? 0 : usage ? chargedTokens(usage, gate.config.cachedTokenWeight) : undefined;
    const cost = chargeNothing ? 0 : usage ? (upstream === "luminal" ? costAtPrices(usage, gate.config.openRouterPrices) : costOf(usage, 0)) : undefined;
    const settled = await person.settle({ reservationId: reservation.reservationId, charged, costUsd: cost, limits, now: c.now() });
    // Without usage, the credit is charged what the allowance was: the reservation at the fallback price.
    const creditUsd = upstream !== "luminal" || chargeNothing ? 0 : usage ? costAtPrices(usage, gate.config.luminalPrices) : settled.costUsd;
    const record: RequestRecord = {
      githubId: identity.githubId,
      isAdmin,
      at: started,
      model: String(body.model),
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
      upstream,
      creditUsd,
      ttfbMs: options.ttfbMs ?? null,
      ttftMs: options.ttftMs ?? null,
      ...(options.upstreamError ? { upstreamError: true } : {}),
      ...(options.outcome ? { upstreamOutcome: options.outcome } : {}),
    };
    await alert(c, await directory(c).recordRequest(record, policyOf(gate.config), servingContext(c, gate.config)));
    return settled.allowance;
  };

  if (upstream === "luminal") return luminalChat(c, { body, stream, maxTokens: reservation.maxTokens, user: String(upstreamBody.user), started, settle, timeoutSeconds: gate.config.luminalFirstByteTimeoutSeconds, reservedAllowance: reservation.allowance });

  const send = (payload: Record<string, unknown>) =>
    c.fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${c.config.openRouterApiKey}`,
        "content-type": "application/json",
        "http-referer": "https://directionallylocal.com",
        "x-title": "Directionally Local",
        ...(payload.session_id ? { "x-session-id": String(payload.session_id) } : {}),
      },
      body: JSON.stringify(payload),
    });

  let response: Response;
  let errorText: string | undefined;
  try {
    response = await send(upstreamBody);
    if (!response.ok) {
      errorText = await response.text().catch(() => "");
      // Skipping the failing hosts left none: ask once more with every host allowed.
      if (failingHosts.length > 0 && isNoHostError(response.status, errorText)) {
        response = await send({ ...upstreamBody, provider: providerPreferences(gate.config) });
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
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", ...quotaHeaders(reservation.allowance) },
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
  const payload: Record<string, unknown> = { ...body, model: LUMINAL_MODELS[body.model as keyof typeof LUMINAL_MODELS], max_completion_tokens: input.maxTokens, user: input.user };
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
        luminalConfigured: c.config.luminalApiKey !== undefined,
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
    const people = await directory(c).listPeople();
    const rows = await Promise.all(
      people.map(async (person) => {
        const allowance = await account(c, person.github_id).allowance(now, limits);
        return {
          githubId: person.github_id,
          login: person.login,
          status: person.status,
          isAdmin: c.config.adminGithubIds.has(person.github_id),
          admittedAt: new Date(person.admitted_at).toISOString(),
          admittedVia: person.admitted_via,
          allowance: allowanceView(allowance),
          serverKeys: await account(c, person.github_id).keyCount(),
        };
      }),
    );
    return json({ people: rows });
  }

  const match = /^people\/(\d+)(?:\/(suspend|unsuspend|block|unblock|grant|revoke-tokens))?$/.exec(rest);
  if (match) {
    const githubId = Number(match[1]);
    const action = match[2];
    if (!action && method === "GET") {
      const detail = await directory(c).personDetail(githubId, now);
      if (!detail) return apiError(404, "not_found", "No such person.");
      const allowance = await account(c, githubId).allowance(now, limits);
      return json({ ...detail, allowance: allowanceView(allowance), serverKeys: await account(c, githubId).keyCount() });
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
        limits,
        now,
      });
      if (!allowance) return apiError(404, "not_found", "No such person.");
      await directory(c).recordGrant({ githubId, tokensPerWeek: tokensPerWeek as number | null | undefined, usdPerWeek: usdPerWeek as number | null | undefined });
      return json({ githubId, allowance: allowanceView(allowance) });
    }
  }
  return apiError(404, "not_found", `${method} /admin/${rest} isn't a route.`);
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
  const metrics = await directory(c).metrics({ from, to, now });
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
// no Strict cookie, and the POSTs (sign-out, block/unblock from the abuse section, and the
// "Serve from" upstream switch) also require a same-origin request; block/unblock and the
// upstream switch also carry a CSRF token bound to the session.

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
  if (origin !== null) return origin === new URL(c.base).origin || origin === c.url.origin;
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
  return new Response(null, { status: 303, headers: { location: "/admin#abuse", "cache-control": "no-store" } });
}

/**
 * POST /admin/dashboard/upstream: the dashboard's "Serve from" switch. Sets the primaryUpstream
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
  if (choice !== "luminal" && choice !== "openrouter") return deniedPage("Not changed", "Choose Luminal or OpenRouter.", 400);
  const key = choice === "luminal" ? c.config.luminalApiKey : c.config.openRouterApiKey;
  if (!key) {
    const secret = choice === "luminal" ? "LUMINAL_API_KEY" : "OPENROUTER_API_KEY";
    return deniedPage("Not changed", `The service has no ${secret}, so ${choice === "luminal" ? "Luminal" : "OpenRouter"} can't serve. Set the secret first.`, 409);
  }
  await directory(c).updateOverrides([{ key: "primaryUpstream", value: choice }], { githubId: session.githubId, login: session.login, now: c.now() });
  return new Response(null, { status: 303, headers: { location: "/admin#upstream", "cache-control": "no-store" } });
}

async function adminWeb(c: Ctx, path: string, method: string): Promise<Response> {
  if (path === "/admin/signin" && method === "GET") return adminSignIn(c);
  if (path === "/admin/signout" && method === "POST") return adminSignOut(c);
  if (path === "/admin/dashboard/upstream" && method === "POST") return adminWebUpstream(c);
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
  const weekParam = c.url.searchParams.get("week");
  const topWeek = weekParam && /^\d{4}-\d{2}-\d{2}$/.test(weekParam) ? Date.parse(`${weekParam}T00:00:00Z`) : Number.NaN;
  const [data, spend, abuse] = await Promise.all([
    directory(c).dashboard({
      now,
      adminIds: [...c.config.adminGithubIds],
      limits: { weeklyTokens: config.weeklyTokens, weeklyUsd: config.perPersonWeeklyUsdCap ?? null },
      policy: policyOf(c.config),
      ...(Number.isFinite(topWeek) ? { topWeek } : {}),
    }),
    directory(c).spend(now),
    csv === undefined ? directory(c).abuse({ now, adminIds: [...c.config.adminGithubIds] }) : undefined,
  ]);
  const view: SpendView = {
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
    creditUsd: config.luminalCreditUsd,
    creditUsedUsd: spend.creditUsedUsd,
    creditWeekUsd: spend.creditWeekUsd,
    freeCreditWeekUsd: spend.freeCreditWeekUsd,
    weeklyCreditUsd: config.luminalWeeklyCreditUsd ?? null,
  };
  if (csv !== undefined && isCsvTable(csv)) return dashboardCsv(csv, data, view);
  return dashboardPage({ data, spend: view, login: identity.login, signOut: viaCookie, ...(abuse ? { abuse } : {}), ...(csrf ? { csrf } : {}) });
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
