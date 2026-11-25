/**
 * What dl.new's pages show of the paid plans (CONTRACT.md "Part B"): the public plan catalogue
 * (plan cards, Checkout line items, the welcome email) and one account's usage this week (the
 * dashboard's bars, tiles, per-day chart and by-tool table). Pure functions over what
 * AccountObject.planState / meters and DirectoryObject.gpt6BonusStatus return.
 */

import type { PlanState } from "./account-object.js";
import { BONUS_FULLY_CLAIMED, BONUS_LABEL, BONUS_LINE, type BonusView, type Gpt6BonusSettingsConfig, BONUS_ENDS_AT } from "./gpt6-bonus.js";
import type { MeterSnapshot } from "./plan-meter.js";
import { PAID_PLANS, PLAN_MIX, PLAN_MIX_LABEL, approxTokens, countedFactor, planLimits, planName, type PaidPlan, type PlanSettingsConfig, type PlanTier } from "./plans.js";
import { isoDay, weekEnd } from "./week.js";

type Config = PlanSettingsConfig & Gpt6BonusSettingsConfig & { cachedTokenWeight: number; paidPlans: boolean };

/** How the numbers are converted, for "how we get ~62M" and the real-to-counted line. */
export function mixView(cachedTokenWeight: number) {
  return { cached: PLAN_MIX.cached, fresh: PLAN_MIX.fresh, output: PLAN_MIX.output, label: PLAN_MIX_LABEL, cachedTokenWeight, countedFactor: countedFactor(cachedTokenWeight) };
}

/** The bonus for the plan page (no account): on, its copy, and whether new subscribers still get it. */
export function bonusOffer(config: Config, fullyClaimed: boolean, now: number) {
  const endsAt = Math.min(config.gpt6BonusEndsAt ?? BONUS_ENDS_AT, BONUS_ENDS_AT);
  const enabled = config.gpt6Bonus && now < endsAt;
  return {
    enabled,
    label: BONUS_LABEL,
    line: BONUS_LINE,
    weeklyUsd: config.gpt6BonusWeeklyUsd,
    fullyClaimed: enabled && fullyClaimed,
    /** The plan page's line when fully claimed. */
    fullyClaimedText: BONUS_FULLY_CLAIMED,
    endsAt: new Date(endsAt).toISOString(),
  };
}

/**
 * The plan catalogue: each plan's models with their weekly limits, real tokens (what users see,
 * "~62M (95.5% caching applied)") and counted (what is enforced). `text` is the line a plan card,
 * a Checkout line item or the welcome email shows per model.
 */
export function planCatalog(config: Config, bonus: { fullyClaimed: boolean }, now: number) {
  return {
    plans: PAID_PLANS.map((plan) => ({
      id: plan,
      name: planName(plan),
      models: planLimits(plan, config).map((limit) => ({
        model: limit.model,
        name: limit.name,
        realTokensPerWeek: limit.realTokens,
        countedTokensPerWeek: limit.countedTokens,
        text: `${limit.name} ${approxTokens(limit.realTokens)}/week (${PLAN_MIX_LABEL})`,
      })),
    })),
    mix: mixView(config.cachedTokenWeight),
    resets: "Mon 00:00 UTC",
    bonus: bonusOffer(config, bonus.fullyClaimed, now),
  };
}

function pct(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

/**
 * One account's usage this week. Each plan model gets its bar: counted used against the counted
 * limit, and the same as real tokens at the plan mix (`usedAtPlanMix` of `realLimit`), plus the
 * person's own caching rate. Models used outside the plan (free usage before it, GLM) are listed
 * without a limit.
 */
export function planUsageView(input: {
  state: PlanState;
  meters: MeterSnapshot;
  config: Config;
  bonus: { granted: boolean; fullyClaimed: boolean };
  now: number;
}) {
  const { state, meters, config, now } = input;
  const plan: PlanTier = state.tier;
  const limits = plan === "none" ? [] : planLimits(plan as PaidPlan, config);
  const rowOf = (model: string) => meters.models.find((row) => row.model === model);
  const modelView = (model: string, name: string, limit?: { realTokens: number; countedTokens: number }) => {
    const row = rowOf(model);
    // The plan's bar leaves out what a free trial used this week (trials.ts): it never counts against the plan.
    const counted = Math.max(0, (row?.counted ?? 0) - (limit ? (row?.trialCounted ?? 0) : 0));
    const cached = row?.cached ?? 0;
    const prompt = row?.prompt ?? 0;
    const output = row?.output ?? 0;
    return {
      model,
      name,
      realLimit: limit?.realTokens ?? null,
      countedLimit: limit?.countedTokens ?? null,
      countedUsed: counted,
      /** The bar: counted used as real tokens at the plan mix ("19.6M of ~62M"). */
      usedAtPlanMix: limit && limit.countedTokens > 0 ? Math.round((counted / limit.countedTokens) * limit.realTokens) : null,
      usedShare: limit && limit.countedTokens > 0 ? Math.min(1, counted / limit.countedTokens) : null,
      realTokens: prompt + output,
      cachedInput: cached,
      freshInput: prompt - cached,
      output,
      /** This person's caching on the model ("at your caching rate (95.7%)"). */
      cachingPct: pct(cached, prompt),
      requests: row?.requests ?? 0,
      failovers: row?.failovers ?? 0,
    };
  };
  const models = limits.map((limit) => modelView(limit.model, limit.name, limit));
  for (const row of meters.models) {
    if (!limits.some((limit) => limit.model === row.model) && row.model !== "gpt-6.1-sol") models.push(modelView(row.model, row.model));
  }
  const sum = (pick: (row: MeterSnapshot["models"][number]) => number) => meters.models.reduce((total, row) => total + pick(row), 0);
  const cachedInput = sum((row) => row.cached);
  const promptTokens = sum((row) => row.prompt);
  const output = sum((row) => row.output);
  const counted = sum((row) => row.counted);
  const real = promptTokens + output;
  const weekly = config.gpt6BonusWeeklyUsd;
  const bonusEnabled = config.gpt6Bonus && now < Math.min(config.gpt6BonusEndsAt ?? BONUS_ENDS_AT, BONUS_ENDS_AT);
  const bonus: BonusView = {
    enabled: bonusEnabled && plan !== "none",
    label: BONUS_LABEL,
    line: BONUS_LINE,
    granted: input.bonus.granted,
    fullyClaimed: input.bonus.fullyClaimed,
    weeklyUsd: weekly,
    spentUsd: Math.round(meters.bonusUsd * 100) / 100,
    leftUsd: Math.max(0, Math.round((weekly - meters.bonusUsd) * 100) / 100),
    endsAt: new Date(Math.min(config.gpt6BonusEndsAt ?? BONUS_ENDS_AT, BONUS_ENDS_AT)).toISOString(),
  };
  return {
    plan,
    plansEnforced: config.paidPlans,
    fallback: state.fallback,
    weekStart: new Date(meters.weekStart).toISOString(),
    resetsAt: new Date(weekEnd(now)).toISOString(),
    mix: mixView(config.cachedTokenWeight),
    models,
    totals: {
      realTokens: real,
      countedTokens: counted,
      cachedInput,
      /** What the cached input counted as (cachedTokenWeight each). */
      cachedCountedAs: Math.ceil(cachedInput * config.cachedTokenWeight),
      freshInput: promptTokens - cachedInput,
      output,
      cachingPct: pct(cachedInput, promptTokens),
      /** Real tokens per counted token ("1 counted = 15.6 real"). */
      realToCounted: counted > 0 ? Math.round((real / counted) * 10) / 10 : null,
      requests: sum((row) => row.requests),
      failovers: sum((row) => row.failovers),
    },
    days: meters.days.map((day) => ({ date: isoDay(day.day), counted: day.counted, real: day.real, byModel: day.byModel })),
    tools: meters.tools,
    bonus,
  };
}

/**
 * `/web/account` `limits[]` and `/web/usage` `models[].limit` (CONTRACT.md part A): one entry per
 * model of the plan, the bar's data. `state` is "warning" from 80%, "used_up" at the limit.
 */
export function planLimitsView(input: { state: PlanState; meters: MeterSnapshot; config: Config; now: number }) {
  const { state, meters, config, now } = input;
  if (state.tier === "none") return null;
  const resetsAt = new Date(weekEnd(now)).toISOString();
  return planLimits(state.tier, config).map((limit) => {
    const row = meters.models.find((entry) => entry.model === limit.model);
    const countedUsed = Math.max(0, (row?.counted ?? 0) - (row?.trialCounted ?? 0));
    const percent = limit.countedTokens > 0 ? Math.min(100, Math.floor((countedUsed / limit.countedTokens) * 100)) : 100;
    return {
      model: limit.model,
      name: limit.name,
      tokensPerWeek: limit.realTokens,
      countedTokensPerWeek: limit.countedTokens,
      countedUsed,
      /** Real tokens processed (prompt with cached, plus output). */
      realUsed: (row?.prompt ?? 0) + (row?.output ?? 0),
      /** The bar in real tokens at the plan mix: "19.6M of ~62M". */
      usedAtPlanMix: limit.countedTokens > 0 ? Math.round((countedUsed / limit.countedTokens) * limit.realTokens) : 0,
      cachingShare: row && row.prompt > 0 ? Math.round((row.cached / row.prompt) * 1000) / 1000 : null,
      percent,
      resetsAt,
      state: countedUsed >= limit.countedTokens ? ("used_up" as const) : countedUsed >= limit.countedTokens * 0.8 ? ("warning" as const) : ("ok" as const),
    };
  });
}

/** `/web/account` `gpt6Bonus` (CONTRACT.md): the account's bonus this week, or null without it. */
export function bonusAccountView(input: { state: PlanState; meters: MeterSnapshot; config: Config; granted: boolean; now: number }) {
  const { config, now } = input;
  const endsAt = Math.min(config.gpt6BonusEndsAt ?? BONUS_ENDS_AT, BONUS_ENDS_AT);
  if (!config.gpt6Bonus || now >= endsAt || input.state.tier === "none" || !input.granted) return null;
  const used = Math.round(input.meters.bonusUsd * 100) / 100;
  return {
    usdPerWeek: config.gpt6BonusWeeklyUsd,
    usedUsd: used,
    leftUsd: Math.max(0, Math.round((config.gpt6BonusWeeklyUsd - input.meters.bonusUsd) * 100) / 100),
    resetsAt: new Date(weekEnd(now)).toISOString(),
    until: "2027-01-31",
    label: BONUS_LABEL,
    line: BONUS_LINE,
  };
}
