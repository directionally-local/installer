/**
 * The free tier's configuration, read from `env` only. Secrets (the OpenRouter key, the
 * GitHub OAuth app, the token signing key) are required; the knobs have defaults that match
 * the owner's decisions in installer#78.
 */

import { FULL_PRECISION, isProviderSlugList, isQuantizationList, splitList, type DataCollection, type Quantization } from "./routing.js";

export class ConfigError extends Error {}

export interface FreeConfig {
  /** Optional: without it the service never calls OpenRouter (Luminal serves, or nothing does). */
  openRouterApiKey: string | undefined;
  githubClientId: string;
  githubClientSecret: string;
  tokenSigningKey: string;
  /** GitHub numeric ids that may call the admin endpoints and skip the invite step. */
  adminGithubIds: ReadonlySet<number>;
  weeklyTokens: number;
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
   * A person's week ends at their pool's tokens or at this much real cost, whichever comes
   * first. At the mix the free tier actually sees (95% of input tokens cached, output under
   * 1% of all tokens) a person who uses every pool costs about $9.35 a week at list prices,
   * so $20 leaves room for a much less cache-friendly week before the cap binds.
   */
  perPersonWeeklyUsdCap: number | undefined;
  /** GitHub accounts younger than this need an invite code even when admission is open. */
  minGithubAccountAgeDays: number;
  /** Full access needs an account at least this old (FULL_MIN_ACCOUNT_AGE_DAYS). */
  fullMinAccountAgeDays: number;
  /** ... and at least this many public repositories (FULL_MIN_PUBLIC_REPOS) ... */
  fullMinPublicRepos: number;
  /** ... or this many contributions in the last year (FULL_MIN_CONTRIBUTIONS). */
  fullMinContributions: number;
  /** A Starter account's weekly tokens (STARTER_WEEKLY_TOKENS): DeepSeek only. */
  starterWeeklyTokens: number;
  /** New sign-ins one network gets a day before the rest are Starter (NETWORK_SIGNUPS_PER_DAY). */
  networkSignupsPerDay: number;
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
  /** Pro's weekly dollar ceiling (PRO_WEEKLY_USD_CAP); undefined (the default) means tokens only. */
  proWeeklyUsdCap: number | undefined;
  /**
   * Which provider serves chat requests first (PRIMARY_UPSTREAM): "openai" (the default),
   * "luminal" or "openrouter". A model's own provider always wins: this only decides what
   * happens when the model's provider has no key. OpenAI failures fall back to DeepSeek on
   * Luminal (see models.ts `fallback`); Luminal failures go back to the client as transient.
   */
  primaryUpstream: Upstream;
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
  /** The kill switch from `env`; the admin endpoint has its own, and either one pauses. */
  paused: boolean;
  /** The public origin for links, when the request's own origin isn't it (behind a proxy). */
  publicUrl: string | undefined;
  /** Resend's API key (RESEND_API_KEY, a secret) for emails to users. Without it none are sent. Never logged. */
  resendApiKey: string | undefined;
  /** The sender of emails to users (EMAIL_FROM), name and address. */
  emailFrom: string;
  /** Where replies to them go (EMAIL_REPLY_TO). */
  emailReplyTo: string;
  /** Emails to users on or off (USER_EMAILS, default on); also a runtime setting. Needs `resendApiKey`. */
  userEmails: boolean;
  /** Send them to admins too (USER_EMAILS_TO_ADMINS), for testing. Off by default. */
  userEmailsToAdmins: boolean;
}

export type Upstream = "openai" | "luminal" | "openrouter";
export const UPSTREAMS: readonly Upstream[] = ["openai", "luminal", "openrouter"];

/** USD per million tokens. Cached is the price of a cached prompt token; reasoning is billed as output. */
export interface Prices {
  input: number;
  cached: number;
  output: number;
}

export type AlertKind = "auto" | "discord" | "slack" | "telegram";

export interface Offers {
  pro: { priceUsdMonthly: number; tokensPerWeek: number };
  topup: { priceUsd: number; tokens: number; validDays: number };
}

export interface StripeConfig {
  secretKey: string | undefined;
  webhookSecret: string | undefined;
  pricePro: string | undefined;
  priceTopup: string | undefined;
  successUrl: string;
  cancelUrl: string;
  portalReturnUrl: string;
}

export const DEFAULTS = {
  weeklyTokens: 50_000_000,
  maxActiveUsers: 50,
  countCachedTokens: true,
  globalWeeklyUsdCap: 2000,
  globalTotalUsdCap: 7000,
  perPersonWeeklyUsdCap: 20,
  minGithubAccountAgeDays: 30,
  fullMinAccountAgeDays: 90,
  fullMinPublicRepos: 3,
  fullMinContributions: 50,
  starterWeeklyTokens: 5_000_000,
  networkSignupsPerDay: 3,
  openAdmission: false,
  requireGithubActivity: true,
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
  proPriceUsdMonthly: 10,
  proTokensPerWeek: 100_000_000,
  topupPriceUsd: 3,
  topupTokens: 50_000_000,
  topupValidDays: 30,
  alertEmailFrom: "alerts@dl.new",
  billingSuccessUrl: "https://dl.new/billing/success",
  billingCancelUrl: "https://dl.new/billing/cancel",
  billingPortalReturnUrl: "https://dl.new/billing",
  primaryUpstream: "openai" as Upstream,
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
  return {
    openRouterApiKey: text(env.OPENROUTER_API_KEY),
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
    fullMinAccountAgeDays: whole(env.FULL_MIN_ACCOUNT_AGE_DAYS, DEFAULTS.fullMinAccountAgeDays, "FULL_MIN_ACCOUNT_AGE_DAYS"),
    fullMinPublicRepos: whole(env.FULL_MIN_PUBLIC_REPOS, DEFAULTS.fullMinPublicRepos, "FULL_MIN_PUBLIC_REPOS"),
    fullMinContributions: whole(env.FULL_MIN_CONTRIBUTIONS, DEFAULTS.fullMinContributions, "FULL_MIN_CONTRIBUTIONS"),
    starterWeeklyTokens: whole(env.STARTER_WEEKLY_TOKENS, DEFAULTS.starterWeeklyTokens, "STARTER_WEEKLY_TOKENS"),
    networkSignupsPerDay: whole(env.NETWORK_SIGNUPS_PER_DAY, DEFAULTS.networkSignupsPerDay, "NETWORK_SIGNUPS_PER_DAY"),
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
        priceUsdMonthly: amount(env.PRO_PRICE_USD_MONTHLY, DEFAULTS.proPriceUsdMonthly, "PRO_PRICE_USD_MONTHLY"),
        tokensPerWeek: whole(env.PRO_TOKENS_PER_WEEK, DEFAULTS.proTokensPerWeek, "PRO_TOKENS_PER_WEEK"),
      },
      topup: {
        priceUsd: amount(env.TOPUP_PRICE_USD, DEFAULTS.topupPriceUsd, "TOPUP_PRICE_USD"),
        tokens: whole(env.TOPUP_TOKENS, DEFAULTS.topupTokens, "TOPUP_TOKENS"),
        validDays: whole(env.TOPUP_VALID_DAYS, DEFAULTS.topupValidDays, "TOPUP_VALID_DAYS"),
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
      pricePro: stripeId(env.STRIPE_PRICE_PRO, "price_", "STRIPE_PRICE_PRO"),
      priceTopup: stripeId(env.STRIPE_PRICE_TOPUP, "price_", "STRIPE_PRICE_TOPUP"),
      successUrl: httpsUrl(env.BILLING_SUCCESS_URL, "BILLING_SUCCESS_URL") ?? DEFAULTS.billingSuccessUrl,
      cancelUrl: httpsUrl(env.BILLING_CANCEL_URL, "BILLING_CANCEL_URL") ?? DEFAULTS.billingCancelUrl,
      portalReturnUrl: httpsUrl(env.BILLING_PORTAL_RETURN_URL, "BILLING_PORTAL_RETURN_URL") ?? DEFAULTS.billingPortalReturnUrl,
    },
    proWeeklyUsdCap: text(env.PRO_WEEKLY_USD_CAP) === undefined ? undefined : usd(env.PRO_WEEKLY_USD_CAP, 0, "PRO_WEEKLY_USD_CAP"),
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
    paused: flag(env.PAUSED, false, "PAUSED"),
    publicUrl: text(env.PUBLIC_URL)?.replace(/\/+$/, ""),
    resendApiKey: text(env.RESEND_API_KEY),
    emailFrom: sender(env.EMAIL_FROM) ?? DEFAULTS.emailFrom,
    emailReplyTo: emailAddress(env.EMAIL_REPLY_TO, "EMAIL_REPLY_TO") ?? DEFAULTS.emailReplyTo,
    userEmails: flag(env.USER_EMAILS, true, "USER_EMAILS"),
    userEmailsToAdmins: flag(env.USER_EMAILS_TO_ADMINS, false, "USER_EMAILS_TO_ADMINS"),
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

function stripeId(value: unknown, prefix: string, name: string): string | undefined {
  const raw = text(value);
  if (raw === undefined) return undefined;
  if (!raw.startsWith(prefix) || !/^[A-Za-z0-9_]+$/.test(raw)) throw new ConfigError(`${name} must be a Stripe id starting with ${prefix} (got "${raw}").`);
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

function upstream(value: unknown): Upstream {
  const raw = text(value)?.toLowerCase();
  if (raw === undefined) return DEFAULTS.primaryUpstream;
  if ((UPSTREAMS as readonly string[]).includes(raw)) return raw as Upstream;
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
