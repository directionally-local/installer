/**
 * dl.new's paid plans (Starter, Plus, Max): which models each one includes and its fixed weekly
 * limit per model. No multipliers and no shared pool: every model has its own meter.
 *
 * Limits are set and shown in REAL tokens with caching applied ("~62M a week (95.5% caching
 * applied)"), and enforced in COUNTED tokens: cached input at `cachedTokenWeight` (0.02 live),
 * fresh input and output in full (quota.ts chargedTokens). The two are converted at the plan mix:
 * 95.5% cached input, 3.8% fresh input, 0.7% output, so
 *
 *   counted = real x (0.955 x cachedTokenWeight + 0.038 + 0.007)
 *           = real x 0.0641 at cachedTokenWeight 0.02.
 *
 * The real-token numbers are runtime settings (`planTokens.<plan>.<model>`), so they change
 * without a deploy; the counted limits follow from them and the live `cachedTokenWeight`.
 *
 * GPT-6 is in no plan. Paying accounts may get GPT-6.1 Sol as a launch bonus (gpt6-bonus.ts).
 */

import { DEEPSEEK_MODEL, modelById, type FreeModel } from "./models.js";
import type { Prices } from "./config.js";

export const PAID_PLANS = ["starter", "plus", "max"] as const;
export type PaidPlan = (typeof PAID_PLANS)[number];
/** An account's plan: one of the paid plans, or "none" (not paying). */
export type PlanTier = PaidPlan | "none";

export function isPaidPlan(value: unknown): value is PaidPlan {
  return typeof value === "string" && (PAID_PLANS as readonly string[]).includes(value);
}

/** The models a plan can include, by their short setting name. */
export const PLAN_MODEL_KEYS = { deepseek: DEEPSEEK_MODEL, kimi: "moonshotai/kimi-k3.1-pro" } as const;
export type PlanModelKey = keyof typeof PLAN_MODEL_KEYS;

/** The caching mix the plan numbers are quoted at: share of real tokens that are cached input, fresh input and output. */
export const PLAN_MIX = { cached: 0.955, fresh: 0.038, output: 0.007 } as const;
/**
 * The cached share of prompt tokens at the plan mix (about 0.9617): what an estimate assumes for a
 * person whose own share isn't known yet (too little usage reported to tell).
 */
export const PLAN_CACHED_SHARE = PLAN_MIX.cached / (PLAN_MIX.cached + PLAN_MIX.fresh);
/** How the plan numbers are labelled wherever they are shown. */
export const PLAN_MIX_LABEL = "95.5% caching applied";

/** Counted tokens per real token at the plan mix: 0.0641 at cachedTokenWeight 0.02. */
export function countedFactor(cachedTokenWeight: number): number {
  const weight = Math.min(1, Math.max(0, cachedTokenWeight));
  return PLAN_MIX.cached * weight + PLAN_MIX.fresh + PLAN_MIX.output;
}

/** A real-token limit as the counted tokens it is enforced at (rounded to a whole token). */
export function countedLimit(realTokens: number, cachedTokenWeight: number): number {
  return Math.round(Math.max(0, realTokens) * countedFactor(cachedTokenWeight));
}

/** The plan settings as the config keeps them: `planTokens.<plan>.<model>`, real tokens a week. */
export type PlanSettingsConfig = {
  "planTokens.starter.deepseek": number;
  "planTokens.plus.deepseek": number;
  "planTokens.plus.kimi": number;
  "planTokens.max.deepseek": number;
  "planTokens.max.kimi": number;
};

/**
 * The owner's numbers (25 Nov 2026), real tokens a week at the plan mix. A model a plan doesn't
 * list isn't in it: Starter is DeepSeek only. Max is DeepSeek and Kimi only for launch (no GLM).
 */
export const PLAN_DEFAULTS: PlanSettingsConfig = {
  "planTokens.starter.deepseek": 62_000_000,
  "planTokens.plus.deepseek": 150_000_000,
  "planTokens.plus.kimi": 1_500_000,
  "planTokens.max.deepseek": 450_000_000,
  "planTokens.max.kimi": 4_000_000,
};

/** Every plan setting name, with its env var. */
export const PLAN_SETTING_ENV: Readonly<Record<keyof PlanSettingsConfig, string>> = {
  "planTokens.starter.deepseek": "PLAN_TOKENS_STARTER_DEEPSEEK",
  "planTokens.plus.deepseek": "PLAN_TOKENS_PLUS_DEEPSEEK",
  "planTokens.plus.kimi": "PLAN_TOKENS_PLUS_KIMI",
  "planTokens.max.deepseek": "PLAN_TOKENS_MAX_DEEPSEEK",
  "planTokens.max.kimi": "PLAN_TOKENS_MAX_KIMI",
};

/** The models of each plan, in the order they're shown (the default model first). */
const PLAN_MODELS: Readonly<Record<PaidPlan, readonly PlanModelKey[]>> = {
  starter: ["deepseek"],
  plus: ["deepseek", "kimi"],
  max: ["deepseek", "kimi"],
};

/** One model's weekly limit on a plan. */
export interface PlanModelLimit {
  /** The model id clients send. */
  model: string;
  name: string;
  /** Real tokens a week at the plan mix: what users are shown ("~62M (95.5% caching applied)"). */
  realTokens: number;
  /** Counted tokens a week: what is enforced. */
  countedTokens: number;
}

/** A plan's models and their limits, the default model first. A model set to 0 tokens is left out. */
export function planLimits(plan: PaidPlan, config: PlanSettingsConfig & { cachedTokenWeight: number }): PlanModelLimit[] {
  return PLAN_MODELS[plan]
    .map((key) => {
      const model = modelById(PLAN_MODEL_KEYS[key])!;
      const realTokens = config[`planTokens.${plan}.${key}` as keyof PlanSettingsConfig];
      return { model: model.id, name: displayName(model), realTokens, countedTokens: countedLimit(realTokens, config.cachedTokenWeight) };
    })
    .filter((limit) => limit.realTokens > 0);
}

/** One model's limit on a plan, or undefined when the plan doesn't include it. */
export function planLimitFor(plan: PaidPlan, modelId: string, config: PlanSettingsConfig & { cachedTokenWeight: number }): PlanModelLimit | undefined {
  return planLimits(plan, config).find((limit) => limit.model === modelId);
}

/** The model a plan serves when a client names none of its models (Claude Code's own names): DeepSeek on every plan. */
export function planDefaultModel(_plan: PaidPlan): string {
  return DEEPSEEK_MODEL;
}

/** The cheapest plan that includes `modelId` with more than `plan` gives, for the upgrade line; undefined at the top. */
export function upgradeFor(plan: PaidPlan, modelId: string, config: PlanSettingsConfig & { cachedTokenWeight: number }): { plan: PaidPlan; limit: PlanModelLimit } | undefined {
  const mine = planLimitFor(plan, modelId, config)?.realTokens ?? 0;
  for (const next of PAID_PLANS.slice(PAID_PLANS.indexOf(plan) + 1)) {
    const limit = planLimitFor(next, modelId, config);
    if (limit && limit.realTokens > mine) return { plan: next, limit };
  }
  return undefined;
}

/** The name users see: "Kimi K3.1" and "DeepSeek V4.1 Flash", without the catalogue's suffixes. */
export function displayName(model: Pick<FreeModel, "id" | "name">): string {
  if (model.id === DEEPSEEK_MODEL) return "DeepSeek V4.1 Flash";
  if (model.id === PLAN_MODEL_KEYS.kimi) return "Kimi K3.1";
  return model.name;
}

/** "Starter", "Plus", "Max". */
export function planName(plan: PaidPlan): string {
  return plan === "starter" ? "Starter" : plan === "plus" ? "Plus" : "Max";
}

/**
 * Tokens as plan copy writes them: "~62M", "~1.5M", "~450M", "~96K". Rounded to at most one
 * decimal; the tilde says it's an estimate at the plan mix.
 */
export function approxTokens(tokens: number): string {
  const whole = Math.max(0, Math.round(tokens));
  for (const [size, unit] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) {
    if (whole >= size) {
      const value = whole / size;
      const shown = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
      return `~${shown}${unit}`;
    }
  }
  return `~${whole}`;
}

// ─── Cost math ───────────────────────────────────────────────────────────────

/** Weeks in an average month. */
export const WEEKS_PER_MONTH = 52 / 12;

/** USD per million real tokens at the plan mix, at `prices` (USD per million tokens). */
export function usdPerMillionReal(prices: Prices): number {
  return PLAN_MIX.cached * prices.cached + PLAN_MIX.fresh * prices.input + PLAN_MIX.output * prices.output;
}

/** One line of a plan's cost: a model fully used for a week, and for an average month. */
export interface PlanCostLine {
  model: string;
  realTokens: number;
  usdPerMillionReal: number;
  usdPerWeek: number;
  usdPerMonth: number;
}

/**
 * What a fully used plan costs us, per model and in total, at the given USD per million real
 * tokens per model (a measured cost, or `usdPerMillionReal(creditPrices(model))`).
 */
export function planCost(plan: PaidPlan, config: PlanSettingsConfig & { cachedTokenWeight: number }, perMillion: (modelId: string) => number): { lines: PlanCostLine[]; usdPerWeek: number; usdPerMonth: number } {
  const lines = planLimits(plan, config).map((limit) => {
    const rate = perMillion(limit.model);
    const usdPerWeek = (limit.realTokens / 1_000_000) * rate;
    return { model: limit.model, realTokens: limit.realTokens, usdPerMillionReal: rate, usdPerWeek, usdPerMonth: usdPerWeek * WEEKS_PER_MONTH };
  });
  const usdPerWeek = lines.reduce((sum, line) => sum + line.usdPerWeek, 0);
  return { lines, usdPerWeek, usdPerMonth: usdPerWeek * WEEKS_PER_MONTH };
}
