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
 * Full refund on request within this many hours of the first payment (the runtime setting
 * `refundWindowHours`, REFUND_WINDOW_HOURS; default 24), as long as no plan model's weekly meter
 * is at 100% (refundBlock). The admin's {"force": true} overrides both.
 */
export const REFUND_WINDOW_HOURS = 24;
/** An unclaimed paid Checkout can be claimed (and its email link works) this long. Separate from the refund window. */
export const CLAIM_DAYS = 7;

/** "24 hours", "1 hour". */
export function refundWindowText(hours: number): string {
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/** The refund policy as every page and email says it: "Full refund within 24 hours of your first payment, if you haven't reached your weekly limit." */
export function refundPolicy(hours: number): string {
  return `Full refund within ${refundWindowText(hours)} of your first payment, if you haven't reached your weekly limit.`;
}

/**
 * The checkbox text on the plan Checkout (Stripe's terms-of-service consent, `checkoutTermsConsent`):
 * the EU/UK waiver of the 14-day right of withdrawal once the plan starts, and the refund rule.
 */
export function checkoutConsentMessage(hours: number, termsUrl: string): string {
  return `I want my dl.new plan to start right away and understand I lose my 14-day right to cancel once it starts. Refunds: within ${refundWindowText(hours)} of the first payment, if the weekly limit hasn't been reached. [Terms](${termsUrl}).`;
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
  /** The refund window (runtime setting `refundWindowHours`). */
  refundWindowHours: number;
}) {
  const { catalog } = input;
  return {
    plans: PLAN_IDS.map((id) => {
      const plan = PLANS[id];
      const models = catalog.plans.find((entry) => entry.id === id)?.models ?? [];
      return {
        id,
        name: plan.name,
        priceUsd: plan.priceUsd,
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
    refundWindowHours: input.refundWindowHours,
    /** "Full refund within 24 hours of your first payment, if you haven't reached your weekly limit." */
    refundPolicy: refundPolicy(input.refundWindowHours),
    /** The GPT-6 launch bonus offer (plan-usage.ts bonusOffer): `fullyClaimed` shows "GPT-6 launch bonus: fully claimed". */
    gpt6Bonus: catalog.bonus,
    available: input.available,
  };
}
