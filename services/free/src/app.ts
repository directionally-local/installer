import type { DurableObjectNamespace } from "cloudflare:workers";
import { sha256Hex } from "../../shared/src/auth.js";
import { githubAuthorizeUrl, githubUserFromCode, type Fetch } from "../../shared/src/github.js";
import { hmacKey, signJwt, verifyJwt } from "../../shared/src/jwt.js";
import type { Limit } from "../../shared/src/rate-limit.js";
import type { AccountObject, Allowance, Limits } from "./account-object.js";
import type { AuthObject, Identity } from "./auth-object.js";
import { normalizeUserCode } from "./codes.js";
import { ConfigError, readFreeConfig, type FreeConfig } from "./config.js";
import type { DirectoryObject, RequestRecord } from "./directory-object.js";
import { apiError, json } from "./errors.js";
import { cleanBatch } from "./events.js";
import {
  DEVICE_TAKEN_MESSAGE,
  INVALID_INVITE_MESSAGE,
  isSignInRefusal,
  PAUSED_MESSAGE,
  signInRefusal,
  TOTAL_BUDGET_MESSAGE,
  weeklyBudgetMessage,
  type SignInRefusal,
} from "./messages.js";
import { confirmPage, donePage, enterCodePage, INVITE_ONLY_INTRO, invitePage, tooNewIntro } from "./pages.js";
import { ALLOWED_MODELS, chargedTokens, costOf, estimatePromptTokens, isAllowedModel, parseUsage, type Usage } from "./quota.js";
import type { RateLimiterObject } from "./rate-limit-object.js";
import { applyOverrides, parseSettingsUpdate, settingsView } from "./runtime-config.js";
import { meterStream } from "./sse.js";
import { DAY_MS, isoDay, weekEnd } from "./week.js";

/**
 * The free managed tier's HTTP surface: device-flow sign-in with GitHub, the account and
 * OpenAI-compatible inference endpoints, usage events, and the admin API. Inference goes to
 * OpenRouter on the service's key; nothing else is called for tokens.
 */

export const VERSION = "0.1.0";
export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const ACCESS_TTL_S = 3600;
const ISSUER = "directionallylocal-free";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const OAUTH_COOKIE = "__Host-dl_oauth";

const perMinute = (n: number): Limit => ({ capacity: n, perHour: n * 60 });
const LIMITS = {
  apiPerson: perMinute(60),
  apiIp: perMinute(60),
  deviceCodeIp: { capacity: 10, perHour: 10 },
  pollIp: perMinute(120),
  refreshIp: { capacity: 60, perHour: 60 },
  inviteAttemptIp: { capacity: 10, perHour: 10 },
  signupIp: { capacity: 3, perHour: 3 / 24 },
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
  COUNT_CACHED_TOKENS?: string;
  PAUSED?: string;
  PUBLIC_URL?: string;
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
  now: () => number;
  fetch: Fetch;
  ip: string;
  base: string;
}

export function createHandler(options: HandlerOptions = {}): { fetch(request: Request, env: Env): Promise<Response> } {
  const now = options.now ?? (() => Date.now());
  const fetcher: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      let config: FreeConfig;
      try {
        config = readFreeConfig(env as unknown as Record<string, unknown>);
      } catch (error) {
        if (error instanceof ConfigError) return apiError(500, "misconfigured", error.message);
        throw error;
      }
      const url = new URL(request.url);
      const ctx: Ctx = { request, url, env, config, now, fetch: fetcher, ip: clientIp(request), base: config.publicUrl ?? url.origin };
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
  if (method === "GET" && path === "/v1/me") return me(c);
  if (method === "GET" && path === "/v1/models") return models(c);
  if (method === "POST" && path === "/v1/chat/completions") return chat(c);
  if (method === "POST" && path === "/v1/events") return events(c);

  if (method === "GET" && path === "/device") return devicePage(c);
  if (method === "GET" && path === "/device/authorize") return deviceAuthorize(c);
  if (method === "GET" && path === "/device/callback") return deviceCallback(c);
  if (method === "POST" && path === "/device/deny") return deviceDeny(c);
  if (method === "POST" && path === "/device/invite") return deviceInvite(c);
  if (method === "POST" && path === "/device/no-invite") return deviceNoInvite(c);

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

function limitsFor(config: FreeConfig): Limits {
  return { weeklyTokens: config.weeklyTokens, weeklyUsd: config.perPersonWeeklyUsdCap };
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

async function tokenResponse(c: Ctx, identity: Identity, refreshToken: string): Promise<Response> {
  const iat = Math.floor(c.now() / 1000);
  const accessToken = await signJwt(
    { iss: ISSUER, typ: "access", sub: String(identity.githubId), login: identity.login, iat, exp: iat + ACCESS_TTL_S, jti: crypto.randomUUID() },
    await signingKey(c.config),
  );
  return json({ access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: ACCESS_TTL_S });
}

/** The person behind a valid access token, or a 401. */
async function authenticate(c: Ctx): Promise<Identity | Response> {
  const header = c.request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  const invalid = () => apiError(401, "invalid_token", "Sign in again: the access token is missing, invalid or expired.", {}, { "www-authenticate": 'Bearer error="invalid_token"' });
  if (!match) return invalid();
  const claims = await verifyJwt(match[1]!, await signingKey(c.config), Math.floor(c.now() / 1000));
  if (!claims || claims.typ !== "access" || claims.iss !== ISSUER || typeof claims.login !== "string") return invalid();
  const githubId = Number(claims.sub);
  if (!Number.isSafeInteger(githubId) || githubId <= 0) return invalid();
  return { githubId, login: claims.login };
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

/** The config with the admin's runtime overrides applied, the kill switch, and non-admin spend. */
interface Runtime {
  config: FreeConfig;
  paused: boolean;
  weekUsd: number;
  totalUsd: number;
}

/** Read once per request: an override changed mid-request applies from the next one. */
function runtime(c: Ctx): Promise<Runtime> {
  c.runtimeState ??= directory(c)
    .gate(c.now())
    .then((gate) => ({ config: applyOverrides(c.config, gate.overrides), paused: c.config.paused || gate.paused, weekUsd: gate.weekUsd, totalUsd: gate.totalUsd }));
  return c.runtimeState;
}

async function isPaused(c: Ctx): Promise<boolean> {
  return c.config.paused || (await runtime(c)).paused;
}

function pausedError(headers: Record<string, string> = {}): Response {
  return apiError(503, "service_paused", PAUSED_MESSAGE, { reason: "paused", pausedForEveryone: true, resetsAt: null }, headers);
}

// ─── Sign-in: the CLI side ──────────────────────────────────────────────────

async function deviceCode(c: Ctx): Promise<Response> {
  if (await isPaused(c)) return pausedError();
  const retry = await limited(c, `device:ip:${c.ip}`, LIMITS.deviceCodeIp);
  if (retry !== undefined) return rateLimited(retry);
  const body = (await readJson(c)) ?? {};
  const deviceId = typeof body.device_id === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(body.device_id) ? body.device_id : null;
  const issued = await auth(c).issueDeviceCode({ clientDeviceId: deviceId, now: c.now() });
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
  const retry = await limited(c, `poll:ip:${c.ip}`, LIMITS.pollIp);
  if (retry !== undefined) return rateLimited(retry);
  const body = await readJson(c);
  const code = body?.device_code;
  if (typeof code !== "string" || !code) return apiError(400, "invalid_request", "Send {device_code}.");
  const result = await auth(c).poll(code, c.now());
  if (result.status === "approved") return tokenResponse(c, result, result.refreshToken);
  const reason = "reason" in result ? result.reason : undefined;
  // Each refusal has its own code; the message is the one the browser page showed.
  if ((result.status === "not_invited" || result.status === "denied") && isSignInRefusal(reason)) {
    const { config } = await runtime(c);
    return apiError(400, reason, signInRefusal(reason, config.minGithubAccountAgeDays).message, { reason });
  }
  if (result.status === "denied" && reason === "service_paused") return apiError(400, "service_paused", PAUSED_MESSAGE, { reason: "paused" });
  const [errorCode, message] = POLL_MESSAGES[result.status];
  const detail = result.status === "denied" && reason === "device_taken" ? DEVICE_TAKEN_MESSAGE : undefined;
  return apiError(400, errorCode, detail ?? message, {
    ...(result.status === "slow_down" ? { interval: result.interval } : {}),
    ...("reason" in result && result.reason ? { reason: result.reason } : {}),
  });
}

async function refresh(c: Ctx): Promise<Response> {
  const retry = await limited(c, `refresh:ip:${c.ip}`, LIMITS.refreshIp);
  if (retry !== undefined) return rateLimited(retry);
  const body = await readJson(c);
  const token = body?.refresh_token;
  const invalid = () => apiError(401, "invalid_grant", "The refresh token is invalid, expired or already used. Sign in again.");
  if (typeof token !== "string" || !token) return invalid();
  const rotated = await auth(c).rotate(token, c.now());
  if (!rotated) return invalid();
  return tokenResponse(c, rotated, rotated.refreshToken);
}

// ─── Sign-in: the browser side ──────────────────────────────────────────────

async function devicePage(c: Ctx): Promise<Response> {
  const raw = c.url.searchParams.get("user_code");
  if (!raw) return enterCodePage();
  const userCode = normalizeUserCode(raw);
  const found = userCode ? await auth(c).lookup(userCode, c.now()) : undefined;
  if (!userCode || !found) return enterCodePage("That code is unknown or has expired. Start sign-in again in your terminal.");
  if (found.status !== "pending") return donePage("Code already used", "This code was already used. Start sign-in again in your terminal if you need to.", 409);
  return confirmPage(userCode);
}

async function deviceAuthorize(c: Ctx): Promise<Response> {
  const userCode = normalizeUserCode(c.url.searchParams.get("user_code") ?? "");
  if (await isPaused(c)) {
    // Tell the waiting terminal too, instead of letting its code run out.
    if (userCode) await auth(c).deny(userCode, c.now(), "service_paused");
    return donePage("Paused", PAUSED_MESSAGE, 503);
  }
  const begun = userCode ? await auth(c).beginOAuth(userCode, c.now()) : undefined;
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
  const user = code
    ? await githubUserFromCode(
        { clientId: c.config.githubClientId, clientSecret: c.config.githubClientSecret },
        code,
        `${c.base}/device/callback`,
        c.fetch,
        "directionallylocal-free",
      )
    : undefined;
  if (!user) return donePage("GitHub sign-in failed", "GitHub didn't confirm who you are. Open the link from your terminal and try again.", 502);

  const identity: Identity = { githubId: user.id, login: user.login };
  const minAgeMs = c.config.minGithubAccountAgeDays * DAY_MS;
  const accountTooNew = minAgeMs > 0 && (user.createdAt === undefined || c.now() - user.createdAt < minAgeMs);
  return admitAndFinish(c, claimed.deviceRef, claimed.clientDeviceId, identity, undefined, accountTooNew);
}

/**
 * Runs admission and records the outcome on the device code, then renders the page for it.
 * `inviteCode` is set on the invite step only. With open admission, an account old enough
 * gets in without one (within the per-network sign-up limit and the cohort size).
 */
async function admitAndFinish(
  c: Ctx,
  deviceRef: string,
  clientDeviceId: string | null,
  identity: Identity,
  inviteCode: string | undefined,
  accountTooNew: boolean,
  ticket?: string,
): Promise<Response> {
  const isAdmin = c.config.adminGithubIds.has(identity.githubId);
  const { config } = await runtime(c);
  const signupKey = `signup:ip:${c.ip}`;
  const openEligible = config.openAdmission && !accountTooNew && inviteCode === undefined;
  const signupsLeft = openEligible ? (await c.env.RATE_LIMITER.getByName(signupKey).check(signupKey, LIMITS.signupIp, 1, c.now())).allowed : true;
  const result = await directory(c).admit({
    githubId: identity.githubId,
    login: identity.login,
    isAdmin,
    inviteCode,
    clientDeviceId,
    accountTooNew,
    openAdmission: openEligible && signupsLeft,
    maxActive: config.maxActiveUsers,
    now: c.now(),
  });
  if (result.ok) {
    if (result.created && (result.via === "invite" || result.via === "open")) await c.env.RATE_LIMITER.getByName(signupKey).spend(signupKey, LIMITS.signupIp, 1, c.now());
    await account(c, identity.githubId).activate({ githubId: identity.githubId, login: identity.login, isAdmin, now: c.now() });
    await auth(c).decide(deviceRef, "approved", identity, c.now());
    return donePage("You're signed in", `Signed in as ${identity.login}. Return to your terminal; you can close this tab.`);
  }
  const intro = accountTooNew ? tooNewIntro(config.minGithubAccountAgeDays) : INVITE_ONLY_INTRO;
  const refuse = async (code: SignInRefusal, status: "not_invited" | "denied", httpStatus: number) => {
    await auth(c).decide(deviceRef, status, identity, c.now(), code);
    const { heading, message } = signInRefusal(code, config.minGithubAccountAgeDays);
    return donePage(heading, message, httpStatus);
  };
  switch (result.reason) {
    case "needs_invite": {
      if (openEligible && !signupsLeft) return refuse("too_many_signups", "denied", 429);
      const issued = await auth(c).decide(deviceRef, "needs_invite", identity, c.now(), accountTooNew ? "account_too_new" : "invite_required");
      return invitePage(issued.ticket ?? "", identity.login, undefined, intro);
    }
    case "invalid_invite":
      return invitePage(ticket ?? "", identity.login, INVALID_INVITE_MESSAGE, intro);
    case "cohort_full":
      return refuse("cohort_full", "not_invited", 403);
    case "device_taken":
      await auth(c).decide(deviceRef, "denied", identity, c.now(), result.reason);
      return donePage("Can't sign in", DEVICE_TAKEN_MESSAGE, 403);
  }
}

async function deviceInvite(c: Ctx): Promise<Response> {
  const form = await readForm(c);
  const ticket = form.get("ticket") ?? "";
  const found = ticket ? await auth(c).ticket(ticket, c.now()) : undefined;
  if (!found) return donePage("Sign-in expired", "This step expired. Start sign-in again in your terminal.", 400);
  const retry = await limited(c, `invite:ip:${c.ip}`, LIMITS.inviteAttemptIp);
  if (retry !== undefined) return invitePage(ticket, found.login, `Too many attempts. Try again in ${Math.ceil(retry / 60)} minutes.`);
  const signups = await c.env.RATE_LIMITER.getByName(`signup:ip:${c.ip}`).check(`signup:ip:${c.ip}`, LIMITS.signupIp, 1, c.now());
  if (!signups.allowed) return invitePage(ticket, found.login, "Too many new accounts from this network today. Try again tomorrow.");
  const tooNew = found.reason === "account_too_new";
  const inviteCode = (form.get("invite_code") ?? "").trim();
  if (!inviteCode) return invitePage(ticket, found.login, "Enter an invite code.", tooNew ? tooNewIntro((await runtime(c)).config.minGithubAccountAgeDays) : INVITE_ONLY_INTRO);
  return admitAndFinish(c, found.deviceRef, found.clientDeviceId, found, inviteCode, tooNew, ticket);
}

async function deviceNoInvite(c: Ctx): Promise<Response> {
  const form = await readForm(c);
  const ticket = form.get("ticket") ?? "";
  const found = ticket ? await auth(c).ticket(ticket, c.now()) : undefined;
  if (!found) return donePage("Sign-in expired", "This step expired. Start sign-in again in your terminal.", 400);
  const code: SignInRefusal = found.reason === "account_too_new" ? "account_too_new" : "invite_required";
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
    (await limited(c, `api:gh:${identity.githubId}`, LIMITS.apiPerson)) ?? (await limited(c, `api:ip:${c.ip}`, LIMITS.apiIp));
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

async function me(c: Ctx): Promise<Response> {
  const identity = await authenticate(c);
  if (identity instanceof Response) return identity;
  const guarded = await apiGuard(c, identity);
  if (guarded) return guarded;
  const allowance = await account(c, identity.githubId).allowance(c.now(), limitsFor((await runtime(c)).config));
  if (!allowance.exists) return apiError(403, "not_invited", "This GitHub account isn't on the free tier.");
  return json({
    login: identity.login,
    githubId: identity.githubId,
    status: allowance.status,
    allowance: allowanceView(allowance),
    models: [...ALLOWED_MODELS],
  });
}

async function models(c: Ctx): Promise<Response> {
  const identity = await authenticate(c);
  if (identity instanceof Response) return identity;
  const guarded = await apiGuard(c, identity);
  if (guarded) return guarded;
  return json({ object: "list", data: ALLOWED_MODELS.map((id) => ({ id, object: "model", owned_by: "openrouter" })) });
}

async function events(c: Ctx): Promise<Response> {
  const identity = await authenticate(c);
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

// ─── Inference ──────────────────────────────────────────────────────────────

function quotaHeaders(allowance: Allowance): Record<string, string> {
  return { "x-dl-tokens-remaining": String(allowance.remaining), "x-dl-quota-resets-at": new Date(allowance.resetsAt).toISOString() };
}

async function chat(c: Ctx): Promise<Response> {
  const identity = await authenticate(c);
  if (identity instanceof Response) {
    identity.headers.set("x-dl-quota-resets-at", new Date(weekEnd(c.now())).toISOString());
    return identity;
  }
  const person = account(c, identity.githubId);
  const isAdmin = c.config.adminGithubIds.has(identity.githubId);
  if (c.config.paused) return pausedError(quotaHeaders(await person.allowance(c.now(), limitsFor(c.config))));
  const gate = await runtime(c);
  const limits = limitsFor(gate.config);
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
  if (!isAdmin) {
    // The global caps read as a pause for everyone, with when it ends; a person's own key still works.
    const { globalTotalUsdCap: total, globalWeeklyUsdCap: weekly } = gate.config;
    if (total !== undefined && gate.totalUsd >= total) {
      return apiError(503, "global_total_budget_reached", TOTAL_BUDGET_MESSAGE, { reason: "total_budget", pausedForEveryone: true, resetsAt: null }, await headers());
    }
    if (weekly !== undefined && gate.weekUsd >= weekly) {
      const resumes = weekEnd(c.now());
      const resetsAt = new Date(resumes).toISOString();
      const retryAfter = String(Math.max(1, Math.ceil((resumes - c.now()) / 1000)));
      return apiError(503, "global_weekly_budget_reached", weeklyBudgetMessage(resetsAt), { reason: "weekly_budget", pausedForEveryone: true, resetsAt }, { ...(await headers()), "retry-after": retryAfter });
    }
  }

  const requestedMax = numberOrUndefined(body.max_tokens) ?? numberOrUndefined(body.max_completion_tokens);
  const reservation = await person.reserve({ promptEstimate: estimatePromptTokens(bodyBytes), requestedMaxTokens: requestedMax, limits, now: c.now() });
  if (!reservation.ok) {
    const quota = quotaHeaders(reservation.allowance);
    if (reservation.code === "quota_exceeded") {
      const resetsAt = new Date(reservation.allowance.resetsAt).toISOString();
      const what = reservation.reason === "spend" ? "spending allowance" : "token allowance";
      return apiError(402, "quota_exceeded", `This week's free ${what} is used up. It resets at ${resetsAt}.`, { resetsAt, reason: reservation.reason }, quota);
    }
    if (reservation.code === "suspended") return apiError(403, "suspended", "This account is suspended from the free tier.", {}, quota);
    return apiError(403, "not_invited", "This GitHub account isn't on the free tier.", {}, quota);
  }

  const stream = body.stream === true;
  const upstreamBody: Record<string, unknown> = { ...body, max_tokens: reservation.maxTokens, usage: { include: true } };
  delete upstreamBody.max_completion_tokens;
  // Never fall back to another model, and route on our terms: cheapest provider first, sticky per session.
  delete upstreamBody.models;
  delete upstreamBody.route;
  upstreamBody.provider = { sort: "price" };
  upstreamBody.user = `dl-${(await sha256Hex(`free:${identity.githubId}`)).slice(0, 32)}`;
  const sessionId = c.request.headers.get("x-session-id") ?? (typeof body.session_id === "string" ? body.session_id : undefined);
  if (sessionId && /^[\x21-\x7e]{1,256}$/.test(sessionId)) upstreamBody.session_id = sessionId;
  else delete upstreamBody.session_id;
  if (stream) upstreamBody.stream_options = { include_usage: true };

  const started = c.now();
  const settle = async (usage: Usage | undefined, status: string, chargeNothing = false) => {
    const charged = chargeNothing ? 0 : usage ? chargedTokens(usage, c.config.countCachedTokens) : undefined;
    const cost = chargeNothing ? 0 : usage ? costOf(usage, 0) : undefined;
    const settled = await person.settle({ reservationId: reservation.reservationId, charged, costUsd: cost, limits, now: c.now() });
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
      status,
      latencyMs: c.now() - started,
    };
    await directory(c).recordRequest(record);
    return settled.allowance;
  };

  let upstream: Response;
  try {
    upstream = await c.fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${c.config.openRouterApiKey}`,
        "content-type": "application/json",
        "http-referer": "https://directionallylocal.com",
        "x-title": "Directionally Local",
        ...(upstreamBody.session_id ? { "x-session-id": String(upstreamBody.session_id) } : {}),
      },
      body: JSON.stringify(upstreamBody),
    });
  } catch {
    const allowance = await settle(undefined, "upstream_error", true);
    return apiError(502, "upstream_error", "The model provider couldn't be reached. Try again.", {}, quotaHeaders(allowance));
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    const allowance = await settle(undefined, "upstream_error", true);
    const quota = quotaHeaders(allowance);
    if (upstream.status === 429) {
      const retryAfter = Math.max(1, Number(upstream.headers.get("retry-after")) || 10);
      return rateLimited(retryAfter, quota);
    }
    return apiError(upstream.status >= 500 ? 502 : upstream.status === 402 ? 503 : 400, upstream.status === 402 ? "service_paused" : "upstream_error", upstreamMessage(text), { upstreamStatus: upstream.status }, quota);
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  if (stream && upstream.body && contentType.includes("text/event-stream")) {
    const metered = meterStream(upstream.body, async ({ usage, errored }) => {
      await settle(usage, usage ? (errored ? "stream_error" : "ok") : "no_usage");
    });
    return new Response(metered, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", ...quotaHeaders(reservation.allowance) },
    });
  }

  const text = await upstream.text();
  let usage: Usage | undefined;
  try {
    usage = parseUsage((JSON.parse(text) as { usage?: unknown }).usage);
  } catch {
    usage = undefined;
  }
  const allowance = await settle(usage, usage ? "ok" : "no_usage");
  return new Response(text, {
    status: 200,
    headers: { "content-type": contentType || "application/json", "cache-control": "no-store", ...quotaHeaders(allowance) },
  });
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
    await directory(c).setPaused(rest === "pause", actor);
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
        };
      }),
    );
    return json({ people: rows });
  }

  const match = /^people\/(\d+)(?:\/(suspend|unsuspend|grant))?$/.exec(rest);
  if (match) {
    const githubId = Number(match[1]);
    const action = match[2];
    if (!action && method === "GET") {
      const detail = await directory(c).personDetail(githubId, now);
      if (!detail) return apiError(404, "not_found", "No such person.");
      const allowance = await account(c, githubId).allowance(now, limits);
      return json({ ...detail, allowance: allowanceView(allowance) });
    }
    if ((action === "suspend" || action === "unsuspend") && method === "POST") {
      const status = action === "suspend" ? "suspended" : "active";
      if (!(await directory(c).setPersonStatus(githubId, status))) return apiError(404, "not_found", "No such person.");
      await account(c, githubId).setStatus(status);
      return json({ githubId, status });
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
      return json({ githubId, allowance: allowanceView(allowance) });
    }
  }
  return apiError(404, "not_found", `${method} /admin/${rest} isn't a route.`);
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
