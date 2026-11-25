/**
 * dl.new's paid plans (docs/web-api-paid.md): Starter $7, Plus $20, Max $60 a month, each with
 * fixed per-model weekly limits. This table is what the plan cards, Checkout's descriptions and
 * the account page show. The limits themselves are part B's (metering and enforcement): the
 * numbers here are the owner-approved spec's, in REAL tokens at the assumed caching mix, always
 * shown with CACHING_LABEL. What is enforced is counted tokens (`countedTokens`).
 *
 * Stripe Prices are config (STRIPE_PRICE_STARTER, STRIPE_PRICE_PLUS, STRIPE_PRICE_MAX), never
 * created by the service.
 */

import { DEEPSEEK_MODEL } from "./models.js";

export const PLAN_IDS = ["starter", "plus", "max"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface PlanModel {
  id: string;
  name: string;
  /** Real tokens a week at the assumed caching mix (the number people see). */
  tokensPerWeek: number;
}

export interface PlanSpec {
  id: PlanId;
  name: string;
  priceUsd: number;
  models: readonly PlanModel[];
}

const KIMI_MODEL = "moonshotai/kimi-k3.1-pro";

/**
 * The spec's per-model limits. Part B owns these numbers (and adds Max's other open models,
 * each with its own limit); keep the order: plan cards and Checkout list models as written.
 */
export const PLANS: Record<PlanId, PlanSpec> = {
  starter: { id: "starter", name: "dl.new Starter", priceUsd: 7, models: [{ id: DEEPSEEK_MODEL, name: "DeepSeek V4.1 Flash", tokensPerWeek: 62_000_000 }] },
  plus: {
    id: "plus",
    name: "dl.new Plus",
    priceUsd: 20,
    models: [
      { id: DEEPSEEK_MODEL, name: "DeepSeek V4.1 Flash", tokensPerWeek: 150_000_000 },
      { id: KIMI_MODEL, name: "Kimi K3.1", tokensPerWeek: 1_500_000 },
    ],
  },
  max: {
    id: "max",
    name: "dl.new Max",
    priceUsd: 60,
    models: [
      { id: DEEPSEEK_MODEL, name: "DeepSeek V4.1 Flash", tokensPerWeek: 450_000_000 },
      { id: KIMI_MODEL, name: "Kimi K3.1", tokensPerWeek: 4_000_000 },
    ],
  },
};

/** The caching mix the shown numbers assume: 95.5% cached input, 3.8% fresh input, 0.7% output. */
export const ASSUMED_MIX = { cached: 0.955, fresh: 0.038, output: 0.007 } as const;
export const CACHING_LABEL = "(95.5% caching applied)";
/** Full refund on request within this many days of the first payment. */
export const REFUND_DAYS = 7;
/** An unclaimed paid Checkout can be claimed (and its email link works) this long. */
export const CLAIM_DAYS = 7;

/** Counted tokens per real token at the assumed mix: cached × weight + fresh + output (0.0641 at weight 0.02). */
export function realToCounted(cachedTokenWeight: number): number {
  return ASSUMED_MIX.cached * cachedTokenWeight + ASSUMED_MIX.fresh + ASSUMED_MIX.output;
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

/** "~62M", "~1.5M": the short form plan cards and emails use. */
export function approxTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `~${Number.isInteger(millions) ? millions : millions.toFixed(1).replace(/\.0$/, "")}M`;
  }
  return `~${Math.round(tokens / 1000)}K`;
}

/**
 * The plan's line for Checkout, receipts and emails, e.g.
 * "DeepSeek V4.1 Flash ~150M/week + Kimi K3.1 ~1.5M/week (95.5% caching applied). Weekly limits reset Mon 00:00 UTC."
 */
export function planDescription(plan: PlanSpec): string {
  const models = plan.models.map((model) => `${model.name} ${approxTokens(model.tokensPerWeek)}/week`).join(" + ");
  return `${models} ${CACHING_LABEL}. Weekly limits reset Mon 00:00 UTC.`;
}

/** The plan a Stripe Price id is, from the configured prices; undefined for any other price. */
export function planOfPrice(prices: Partial<Record<PlanId, string>>, priceId: unknown): PlanId | undefined {
  if (typeof priceId !== "string") return undefined;
  return PLAN_IDS.find((plan) => prices[plan] === priceId);
}

/** The public catalog (GET /web/plans). */
export function plansView(input: { cachedTokenWeight: number; available: boolean }) {
  const ratio = realToCounted(input.cachedTokenWeight);
  return {
    plans: PLAN_IDS.map((id) => {
      const plan = PLANS[id];
      return {
        id,
        name: plan.name,
        priceUsd: plan.priceUsd,
        interval: "month",
        description: planDescription(plan),
        models: plan.models.map((model) => ({ id: model.id, name: model.name, tokensPerWeek: model.tokensPerWeek, approx: approxTokens(model.tokensPerWeek), countedTokensPerWeek: Math.round(model.tokensPerWeek * ratio) })),
      };
    }),
    caching: { assumedCachedShare: ASSUMED_MIX.cached, label: CACHING_LABEL, cachedTokenWeight: input.cachedTokenWeight, realToCounted: Math.round(ratio * 10_000) / 10_000 },
    refundDays: REFUND_DAYS,
    available: input.available,
  };
}
