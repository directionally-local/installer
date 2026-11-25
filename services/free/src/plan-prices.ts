/**
 * dl.new's paid plans as sold (docs/web-api-paid.md): Starter $7, Plus $20, Max $60 a month, the
 * names Stripe shows, the claim and refund windows, and the Price ids from config
 * (STRIPE_PRICE_STARTER, STRIPE_PRICE_PLUS, STRIPE_PRICE_MAX; never created by the service).
 *
 * The per-model weekly limits are part B's (`plans.ts`, `planLimits()`, runtime settings
 * `planTokens.<plan>.<model>`): every page, email and description here reads them from there.
 * Numbers are REAL tokens at the assumed caching mix, always shown with CACHING_LABEL; what is
 * enforced is counted tokens.
 */

import { PLAN_MIX, PLAN_MIX_LABEL, approxTokens, countedFactor, type PlanModelLimit } from "./plans.js";

export const PLAN_IDS = ["starter", "plus", "max"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface PlanSpec {
  id: PlanId;
  name: string;
  priceUsd: number;
}

/** In card order. */
export const PLANS: Record<PlanId, PlanSpec> = {
  starter: { id: "starter", name: "dl.new Starter", priceUsd: 7 },
  plus: { id: "plus", name: "dl.new Plus", priceUsd: 20 },
  max: { id: "max", name: "dl.new Max", priceUsd: 60 },
};

/** The caching mix the shown numbers assume: 95.5% cached input, 3.8% fresh input, 0.7% output (plans.ts PLAN_MIX). */
export const ASSUMED_MIX = PLAN_MIX;
export const CACHING_LABEL = `(${PLAN_MIX_LABEL})`;
/**
 * The admin refund's window (POST /admin/paid/refund): within this many hours of the first payment
 * (the runtime setting `refundWindowHours`, REFUND_WINDOW_HOURS; default 24), as long as no plan
 * model's weekly meter is at 100% (refundBlock); {"force": true} overrides both. Internal only:
 * no page or email promises a refund.
 */
export const REFUND_WINDOW_HOURS = 24;
/** An unclaimed paid Checkout can be claimed (and its email link works) this long. Separate from the refund window. */
export const CLAIM_DAYS = 7;

/** "24 hours", "1 hour". */
export function refundWindowText(hours: number): string {
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/**
 * The checkbox text on the plan Checkout (Stripe's terms-of-service consent, `checkoutTermsConsent`):
 * the EU/UK waiver of the 14-day right of withdrawal once the plan starts. No refund promise
 * anywhere a customer reads it; refunds are the owner's call (POST /admin/paid/refund).
 */
export function checkoutConsentMessage(termsUrl: string): string {
  return `I want my dl.new plan to start right away and understand I lose my 14-day right to withdraw once it starts. [Terms](${termsUrl}).`;
}

/** Why a refund isn't allowed: past the window, or a plan model's weekly limit reached this week. */
export type RefundBlock = "window_passed" | "limit_reached";

/** The reason as the refund-request answer and the admin view show it. */
export const REFUND_BLOCK_TEXT: Record<RefundBlock, string> = {
  window_passed: "refund window passed",
  limit_reached: "weekly limit reached",
};

/**
 * Whether the first payment may be refunded now: within `hours` of it, and no plan model at 100%
 * of its weekly limit (`limitsReached`, the models' names). Undefined when it may.
 */
export function refundBlock(input: { firstPaidAt: number | null; now: number; hours: number; limitsReached: readonly string[] }): RefundBlock | undefined {
  if (input.firstPaidAt === null || input.now > input.firstPaidAt + input.hours * 3_600_000) return "window_passed";
  if (input.limitsReached.length > 0) return "limit_reached";
  return undefined;
}

/** Counted tokens per real token at the assumed mix: cached × weight + fresh + output (0.0641 at weight 0.02). */
export function realToCounted(cachedTokenWeight: number): number {
  return countedFactor(cachedTokenWeight);
}

export function countedTokens(realTokens: number, cachedTokenWeight: number): number {
  return Math.round(realTokens * realToCounted(cachedTokenWeight));
}

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && (PLAN_IDS as readonly string[]).includes(value);
}

/** Whether `to` is a higher plan than `from`. */
export function isUpgrade(from: PlanId, to: PlanId): boolean {
  return PLAN_IDS.indexOf(to) > PLAN_IDS.indexOf(from);
}

/**
 * The plan's line for receipts, emails and the account page, from its limits (`planLimits()`), e.g.
 * "DeepSeek V4.1 Flash ~150M/week + Kimi K3.1 ~1.5M/week (95.5% caching applied). Weekly limits reset Mon 00:00 UTC."
 */
export function planDescription(limits: readonly Pick<PlanModelLimit, "name" | "realTokens">[]): string {
  const models = limits.map((limit) => `${limit.name} ${approxTokens(limit.realTokens)}/week`).join(" + ");
  return `${models} ${CACHING_LABEL}. Weekly limits reset Mon 00:00 UTC.`;
}

/** The plan a Stripe Price id is, from the configured prices; undefined for any other price. */
export function planOfPrice(prices: Partial<Record<PlanId, string>>, priceId: unknown): PlanId | undefined {
  if (typeof priceId !== "string") return undefined;
  return PLAN_IDS.find((plan) => prices[plan] === priceId);
}

/**
 * The public catalog (GET /web/plans): A's prices and names with part B's catalogue
 * (`planCatalog()`: each model's real and counted tokens a week, its `text`, the bonus offer).
 */
export function plansView(input: {
  catalog: {
    plans: ReadonlyArray<{ id: string; models: ReadonlyArray<{ model: string; name: string; realTokensPerWeek: number; countedTokensPerWeek: number; text: string }> }>;
    mix: { cachedTokenWeight: number; countedFactor: number };
    bonus: unknown;
    resets: string;
  };
  available: boolean;
  /** The launch offer now (promoView); inactive when left out. */
  promo?: PromoView;
}) {
  const { catalog } = input;
  const promo = input.promo ?? INACTIVE_PROMO;
  return {
    plans: PLAN_IDS.map((id) => {
      const plan = PLANS[id];
      const models = catalog.plans.find((entry) => entry.id === id)?.models ?? [];
      return {
        id,
        name: plan.name,
        priceUsd: plan.priceUsd,
        /** The first month's price while the offer runs (3.5 / 10 / 30 at 50%), else null. */
        promoPriceUsd: promo.active && promo.percentOff !== null ? promoPrice(plan.priceUsd, promo.percentOff) : null,
        interval: "month",
        description: planDescription(models.map((model) => ({ name: model.name, realTokens: model.realTokensPerWeek }))),
        models: models.map((model) => ({
          id: model.model,
          name: model.name,
          tokensPerWeek: model.realTokensPerWeek,
          approx: approxTokens(model.realTokensPerWeek),
          countedTokensPerWeek: model.countedTokensPerWeek,
          text: model.text,
        })),
      };
    }),
    caching: { assumedCachedShare: ASSUMED_MIX.cached, label: CACHING_LABEL, cachedTokenWeight: catalog.mix.cachedTokenWeight, realToCounted: Math.round(catalog.mix.countedFactor * 10_000) / 10_000 },
    resets: catalog.resets,
    /** The GPT-6 launch bonus offer (plan-usage.ts bonusOffer): `fullyClaimed` shows "GPT-6 launch bonus: fully claimed". */
    gpt6Bonus: catalog.bonus,
    /** The launch offer: {active, percentOff, label, endsAt}; only `active: true` may show a discount. */
    promo,
    available: input.available,
  };
}

// ─── The launch offer (Black Friday 2026) ──────────────────────────────────

/**
 * The offer's defaults (runtime settings `promoCouponId`, `promoStartsAt`, `promoEndsAt`,
 * `promoPercentOff`, `promoLabel`): 50% off the first month on every plan for Checkouts started
 * from Fri 27 Nov 2026 00:00 UTC up to (not including) Tue 1 Dec 2026 00:00 UTC. The coupon is
 * Stripe's (duration "once", so renewals are full price); the owner creates it in Stripe.
 */
export const PROMO_DEFAULTS = {
  promoCouponId: "dlnew-bf-2026",
  promoStartsAt: Date.UTC(2026, 10, 27),
  promoEndsAt: Date.UTC(2026, 11, 1),
  promoPercentOff: 50,
  promoLabel: "first month, ends Mon 30 Nov",
} as const;

export interface PromoSettingsConfig {
  /** The Stripe coupon id; undefined ("none") turns the offer off. */
  promoCouponId: string | undefined;
  /** Unix ms, inclusive; undefined: no offer. */
  promoStartsAt: number | undefined;
  /** Unix ms, exclusive; undefined: no offer. */
  promoEndsAt: number | undefined;
  /** What the pages and emails say, 1 to 100 (the coupon itself decides what Stripe takes off). */
  promoPercentOff: number;
  /** "first month, ends Mon 30 Nov". */
  promoLabel: string;
}

export interface PromoView {
  active: boolean;
  percentOff: number | null;
  label: string | null;
  endsAt: string | null;
}

const INACTIVE_PROMO: PromoView = { active: false, percentOff: null, label: null, endsAt: null };

/** The coupon for a plan Checkout started at `now`, or undefined outside the window (or with the offer off). */
export function activePromoCoupon(config: PromoSettingsConfig, now: number): string | undefined {
  const { promoCouponId, promoStartsAt, promoEndsAt, promoPercentOff } = config;
  if (!promoCouponId || promoStartsAt === undefined || promoEndsAt === undefined || !(promoPercentOff > 0)) return undefined;
  return now >= promoStartsAt && now < promoEndsAt ? promoCouponId : undefined;
}

/** A price after `percentOff`, in dollars with cents: 7 at 50% → 3.5. */
export function promoPrice(priceUsd: number, percentOff: number): number {
  return Math.round(priceUsd * (100 - percentOff)) / 100;
}

/** /web/plans' `promo`. Inactive: everything but `active` is null, so no page can show a discount Checkout won't apply. */
export function promoView(config: PromoSettingsConfig, now: number): PromoView {
  if (activePromoCoupon(config, now) === undefined) return INACTIVE_PROMO;
  return { active: true, percentOff: config.promoPercentOff, label: config.promoLabel, endsAt: new Date(config.promoEndsAt!).toISOString() };
}

/** welcome_paid's sentence for a first payment that had the discount: " Your first month was 50% off. It renews at $7/mo." */
export function welcomePromoLine(plan: PlanId, percentOff: number | null): string {
  if (percentOff === null || !(percentOff > 0)) return "";
  return ` Your first month was ${percentOff}% off. It renews at $${PLANS[plan].priceUsd}/mo.`;
}
