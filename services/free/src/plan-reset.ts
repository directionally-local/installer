/**
 * plan_reset (user-emails.ts): the Monday email to paying dl.new accounts, "Your ~62M tokens
 * reset.", with last week per plan model: real tokens, the caching rate, and the counted math
 * (cached input x cachedTokenWeight, fresh input and output in full) against the counted limit,
 * plus sessions and failovers. Pure: app.ts scheduledPlanReset reads the meters and sends.
 */

import type { MeterSnapshot } from "./plan-meter.js";
import { approxTokens, PLAN_MIX_LABEL, planLimits, planName, type PaidPlan, type PlanSettingsConfig } from "./plans.js";
import { shortTokens, type PlanResetValues } from "./user-emails.js";

const count = (n: number) => Math.round(n).toLocaleString("en-US");

/** "2%" for 0.02, "2.5%" for 0.025. */
export function percentText(share: number): string {
  return `${Math.round(share * 1000) / 10}%`;
}

/** One plan model's lines for last week. */
function modelLines(limit: { name: string; realTokens: number; countedTokens: number }, row: MeterSnapshot["models"][number] | undefined, weight: number): string {
  const head = `- ${limit.name}, weekly limit ${approxTokens(limit.realTokens)} (${PLAN_MIX_LABEL})`;
  if (!row || row.requests === 0) return `${head}: not used last week`;
  const cached = row.cached;
  const fresh = Math.max(0, row.prompt - row.cached);
  const output = row.output;
  const caching = row.prompt > 0 ? percentText(cached / row.prompt) : "0%";
  return [
    `${head}: ${shortTokens(row.prompt + output)} tokens, ${caching} cached`,
    `  counted: ${count(cached)} cached x ${percentText(weight)} = ${count(cached * weight)}, + ${count(fresh)} fresh + ${count(output)} output = ${count(row.counted)} of ${count(limit.countedTokens)}`,
  ].join("\n");
}

/**
 * plan_reset's values for one account: its plan, last week's meters (a snapshot of that week),
 * the live cachedTokenWeight and plan settings, and last week's sessions.
 */
export function planResetValues(input: { plan: PaidPlan; lastWeek: MeterSnapshot; config: PlanSettingsConfig & { cachedTokenWeight: number }; sessions: number }): PlanResetValues {
  const { plan, lastWeek, config } = input;
  const limits = planLimits(plan, config);
  const main = limits[0];
  return {
    tokens: main ? approxTokens(main.realTokens) : "",
    plan: `dl.new ${planName(plan)}`,
    models: limits.map((limit) => modelLines(limit, lastWeek.models.find((row) => row.model === limit.model), config.cachedTokenWeight)).join("\n"),
    cachedpct: percentText(config.cachedTokenWeight),
    sessions: count(input.sessions),
    failovers: count(lastWeek.models.reduce((sum, row) => sum + row.failovers, 0)),
  };
}
