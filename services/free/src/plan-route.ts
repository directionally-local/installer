/**
 * One paid-plan request, end to end before it is reserved: which model serves, the meter it is
 * held to, and the notices the answer carries (plan-limits.ts), or the refusal. GPT-6.1 Sol goes
 * through the launch bonus (gpt6-bonus.ts); every other GPT-6 model is in no plan. app.ts `chat`
 * calls this for paying non-admin accounts only.
 */

import type { PlanState, ReserveMeter } from "./account-object.js";
import { BONUS_MODEL, BONUS_NAME, bonusBlock, bonusRefusalMessage, measuredRunRate, type BonusProjectionInput, type Gpt6BonusSettingsConfig, BONUS_ENDS_AT } from "./gpt6-bonus.js";
import { DEEPSEEK_MODEL, modelById, type FreeModel } from "./models.js";
import { decide, fallbackNotice, limitRefusal, meterFor, timeLeft, warningFor, type ModelMeter, type PlanDecisionConfig } from "./plan-limits.js";
import { PLAN_MODEL_KEYS, displayName, type PaidPlan } from "./plans.js";
import { weekEnd } from "./week.js";

/** The models a paid plan's meters are read for on every request. */
export const PLAN_METER_MODELS: readonly string[] = Object.values(PLAN_MODEL_KEYS);

export type PlanRouteConfig = PlanDecisionConfig & Gpt6BonusSettingsConfig & { gpt6PresendGuard: string; openaiCreditUsd: number };

export interface PlanServe {
  kind: "serve";
  /** The model that serves. */
  model: string;
  /** What its reservation is held to. */
  meter: ReserveMeter;
  /** The plan meter (tokens) for the 80% warning; undefined for the bonus. */
  view: ModelMeter | undefined;
  /** Shown at the start of the answer (and in x-dl-notice). */
  notices: string[];
  /** A fallback model serves in place of the requested one. */
  fellBack: boolean;
  /** Paid from the GPT-6 launch bonus. */
  bonus: boolean;
  /** The most output tokens to ask for (the bonus's cap); undefined: the model's own. */
  maxOutputTokens?: number;
}

export interface PlanRefuse {
  kind: "refuse";
  status: 402;
  code: string;
  message: string;
  details: Record<string, unknown>;
}

/** The grant check's inputs from the gate: the OpenAI credit left and this week's spend. */
export function bonusProjection(config: PlanRouteConfig, gate: { openaiCreditUsedUsd: number; openaiWeekCreditUsd: number }, now: number): Omit<BonusProjectionInput, "holders"> {
  return {
    weeklyUsd: config.gpt6BonusWeeklyUsd,
    runRateUsdPerWeek: config.gpt6BonusRunRateUsdPerWeek ?? measuredRunRate(gate.openaiWeekCreditUsd, now),
    remainingCreditUsd: config.openaiCreditUsd - gate.openaiCreditUsedUsd,
    now,
    endsAt: Math.min(config.gpt6BonusEndsAt ?? BONUS_ENDS_AT, BONUS_ENDS_AT),
  };
}

/** The reservation meter for a plan meter. */
export function tokenMeter(view: ModelMeter, cachedTokenWeight: number): ReserveMeter {
  return { kind: "tokens", model: view.model, limit: view.limit, cachedTokenWeight };
}

export async function planRoute(input: {
  plan: PaidPlan;
  state: PlanState;
  requested: FreeModel;
  /** Another agent or a tool key; undefined for Autopilot. */
  agent: string | undefined;
  config: PlanRouteConfig;
  /** Whether DeepSeek can serve right now. */
  deepseekAvailable: boolean;
  gate: { openaiCreditUsedUsd: number; openaiWeekCreditUsd: number };
  /** Grants (or keeps) the bonus for this account: the Directory's gpt6BonusGrant. */
  grantBonus: (projection: Omit<BonusProjectionInput, "holders">) => Promise<{ granted: boolean }>;
  now: number;
}): Promise<PlanServe | PlanRefuse> {
  const { plan, state, requested, config, now } = input;
  const weight = config.cachedTokenWeight;
  const resetsAt = new Date(weekEnd(now)).toISOString();
  if (requested.family === "gpt6") {
    const gptRefusal = (reason: string, message: string): PlanRefuse => ({
      kind: "refuse",
      status: 402,
      code: "gpt_limit",
      message,
      details: { family: "gpt6", reason, plan, alternative: DEEPSEEK_MODEL, resetsAt: reason === "bonus_used_up" ? resetsAt : null },
    });
    if (requested.id !== BONUS_MODEL) return gptRefusal("not_in_plan", `${displayName(requested)} isn't in dl.new plans. DeepSeek V4.1 Flash is in your plan.`);
    const projection = bonusProjection(config, input.gate, now);
    const block = bonusBlock({ config, paying: true, paidSince: state.paidSince, agent: input.agent, remainingCreditUsd: projection.remainingCreditUsd, now });
    if (block) return gptRefusal(`bonus_${block}`, bonusRefusalMessage(block, timeLeft(now, weekEnd(now)), config.gpt6BonusDelayHours));
    const grant = await input.grantBonus(projection);
    if (!grant.granted) return gptRefusal("bonus_fully_claimed", bonusRefusalMessage("not_granted", ""));
    if (state.bonusUsd >= config.gpt6BonusWeeklyUsd) {
      const deepseek = meterFor(plan, DEEPSEEK_MODEL, state.counted[DEEPSEEK_MODEL] ?? 0, config);
      if (state.fallback && input.deepseekAvailable && deepseek && deepseek.counted < deepseek.limit) {
        return { kind: "serve", model: DEEPSEEK_MODEL, meter: tokenMeter(deepseek, weight), view: deepseek, notices: [fallbackNotice(BONUS_NAME, deepseek.name)], fellBack: true, bonus: false };
      }
      return gptRefusal("bonus_used_up", bonusRefusalMessage("used_up", timeLeft(now, weekEnd(now))));
    }
    return {
      kind: "serve",
      model: BONUS_MODEL,
      meter: { kind: "bonus", model: BONUS_MODEL, limit: config.gpt6BonusWeeklyUsd, cachedTokenWeight: weight },
      view: undefined,
      notices: [],
      fellBack: false,
      bonus: true,
      maxOutputTokens: config.gpt6BonusMaxOutputTokens,
    };
  }
  const decision = decide({ plan, requested: requested.id, counted: state.counted, fallback: state.fallback, deepseekAvailable: input.deepseekAvailable, config, now });
  if (decision.kind === "refuse") return decision;
  return {
    kind: "serve",
    model: decision.model,
    meter: tokenMeter(decision.meter, weight),
    view: decision.meter,
    notices: decision.fallbackNotice ? [decision.fallbackNotice] : [],
    fellBack: decision.fellBack,
    bonus: false,
  };
}

/**
 * When the reservation found the meter full after all (requests in parallel): the next answer
 * for the same request with that meter counted as used up: DeepSeek in its place, or the refusal.
 */
export function afterMeterFull(input: { plan: PaidPlan; state: PlanState; served: PlanServe; deepseekAvailable: boolean; config: PlanRouteConfig; now: number }): PlanServe | PlanRefuse {
  const { plan, state, served, config, now } = input;
  if (served.bonus) {
    return { kind: "refuse", status: 402, code: "gpt_limit", message: bonusRefusalMessage("used_up", timeLeft(now, weekEnd(now))), details: { family: "gpt6", reason: "bonus_used_up", plan, alternative: DEEPSEEK_MODEL, resetsAt: new Date(weekEnd(now)).toISOString() } };
  }
  const counted = { ...state.counted, [served.model]: Number.MAX_SAFE_INTEGER };
  if (served.model !== DEEPSEEK_MODEL) {
    const decision = decide({ plan, requested: served.model, counted, fallback: state.fallback, deepseekAvailable: input.deepseekAvailable, config, now });
    if (decision.kind === "serve") return { kind: "serve", model: decision.model, meter: tokenMeter(decision.meter, config.cachedTokenWeight), view: decision.meter, notices: decision.fallbackNotice ? [decision.fallbackNotice] : [], fellBack: true, bonus: false };
    return decision;
  }
  const view = served.view ?? meterFor(plan, DEEPSEEK_MODEL, state.counted[DEEPSEEK_MODEL] ?? 0, config)!;
  return limitRefusal(plan, { ...view, counted: Math.max(view.counted, view.limit) }, now, config, state.fallback);
}

/** The 80% warning for the meter that serves, when it is due (whether it was shown this week is the caller's to claim). */
export function dueWarning(served: PlanServe): string | undefined {
  return served.view ? warningFor(served.view) : undefined;
}

/** The model a Claude Code request is served by: an exact open-model id it names, else the plan's default (DeepSeek). */
export function anthropicModelFor(named: unknown): FreeModel {
  const model = modelById(named);
  if (model && model.family === "deepseek") return model;
  return modelById(DEEPSEEK_MODEL)!;
}
