/**
 * The free tier's configuration, read from `env` only. Secrets (the OpenRouter key, the
 * GitHub OAuth app, the token signing key) are required; the knobs have defaults that match
 * the owner's decisions in installer#78.
 */

import { FULL_PRECISION, isProviderSlugList, isQuantizationList, splitList, type DataCollection, type Quantization } from "./routing.js";

export class ConfigError extends Error {}

export interface FreeConfig {
  openRouterApiKey: string;
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
  /** The kill switch from `env`; the admin endpoint has its own, and either one pauses. */
  paused: boolean;
  /** The public origin for links, when the request's own origin isn't it (behind a proxy). */
  publicUrl: string | undefined;
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
} as const;

/** The longest host cooldown, in minutes: a day. */
export const MAX_HOST_COOLDOWN_MINUTES = 1440;

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
