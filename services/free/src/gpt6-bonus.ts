/**
 * The GPT-6 launch bonus: every paying account gets $2/week of GPT-6.1 Sol usage in dl (never
 * Astra or Luna), on its own meter apart from the plan's, through 31 Jan 2027. Off until the
 * owner turns `gpt6Bonus` on.
 *
 * Conditions (the terms check, 25 Nov 2026):
 *   - Autopilot only: never tool keys, /anthropic or other harnesses (gpt6Clients stays "autopilot").
 *   - Paying accounts only; the per-user safety identifier on every OpenAI request and the
 *     pre-send guard on (the bonus is off while gpt6PresendGuard isn't "enforce").
 *   - A hard per-user cap ($2/week, `gpt6BonusWeeklyUsd`, enforced on the account's meter) and a
 *     cap on output tokens per bonus request (`gpt6BonusMaxOutputTokens`).
 *   - An optional wait after the first payment (`gpt6BonusDelayHours`, default 0).
 *   - Granting: before a NEW subscriber gets it, the projected bonus spend through the end
 *     (every holder at the weekly amount, pro-rated to the end) plus the projected Autopilot GPT-6
 *     usage over the same time (this week's OpenAI run rate, or `gpt6BonusRunRateUsdPerWeek`) must
 *     stay under the REMAINING OpenAI credit (openaiCreditUsd minus what is used). If not, they
 *     don't get it and the plan data says "fully claimed". Existing holders keep it.
 *   - Never on cash: with no OpenAI credit left the bonus stops for everyone.
 */

import { DAY_MS, WEEK_MS, weekStart } from "./week.js";
import type { MeterSql } from "./plan-meter.js";

export const BONUS_MODEL = "gpt-6.1-sol";
/** Default end: through 31 Jan 2027 (UTC). */
export const BONUS_ENDS_AT = Date.UTC(2027, 1, 1);
/** How the bonus is labelled wherever it's shown. */
export const BONUS_LABEL = "launch bonus, through 31 Jan 2027";
/** User-facing copy: never "OpenAI credits". */
export const BONUS_LINE = "$2/week of GPT-6.1 Sol usage in dl";
export const BONUS_FULLY_CLAIMED = "GPT-6 launch bonus: fully claimed";

export type Gpt6BonusSettingsConfig = {
  /** The bonus on or off (default off: gated on the terms check). */
  gpt6Bonus: boolean;
  /** USD a week per paying account. */
  gpt6BonusWeeklyUsd: number;
  /** When it ends for everyone (Unix ms). */
  gpt6BonusEndsAt: number | undefined;
  /** Hours after the first payment before it starts; 0 for none. */
  gpt6BonusDelayHours: number;
  /** The most output tokens one bonus request may ask for. */
  gpt6BonusMaxOutputTokens: number;
  /** Projected Autopilot GPT-6 spend a week for the grant check, USD; undefined: this week's measured OpenAI run rate. */
  gpt6BonusRunRateUsdPerWeek: number | undefined;
};

export const GPT6_BONUS_DEFAULTS: Gpt6BonusSettingsConfig = {
  gpt6Bonus: false,
  gpt6BonusWeeklyUsd: 2,
  gpt6BonusEndsAt: BONUS_ENDS_AT,
  gpt6BonusDelayHours: 0,
  gpt6BonusMaxOutputTokens: 16_384,
  gpt6BonusRunRateUsdPerWeek: undefined,
};

// ─── The projection ──────────────────────────────────────────────────────────

/** Weeks from `now` to `endsAt` (fractional; 0 past it). */
export function weeksLeft(now: number, endsAt: number): number {
  return Math.max(0, (endsAt - now) / WEEK_MS);
}

/**
 * This week's OpenAI spend as a weekly rate: spend so far over the time since Monday, counted as
 * at least one day so a Monday morning doesn't extrapolate a few minutes into a week.
 */
export function measuredRunRate(openaiWeekUsd: number, now: number): number {
  const elapsed = Math.max(DAY_MS, now - weekStart(now));
  return (Math.max(0, openaiWeekUsd) * WEEK_MS) / elapsed;
}

export interface BonusProjectionInput {
  /** Accounts holding the bonus now. */
  holders: number;
  weeklyUsd: number;
  /** Projected Autopilot GPT-6 spend a week (everyone, outside the bonus). */
  runRateUsdPerWeek: number;
  /** openaiCreditUsd minus the credit used so far. */
  remainingCreditUsd: number;
  now: number;
  endsAt: number;
}

/** Projected spend through the end with `holders` holders: their bonus pro-rated, plus the GPT-6 run rate. */
export function projectedSpend(input: Omit<BonusProjectionInput, "remainingCreditUsd">): number {
  const weeks = weeksLeft(input.now, input.endsAt);
  return (Math.max(0, input.holders) * input.weeklyUsd + Math.max(0, input.runRateUsdPerWeek)) * weeks;
}

/** Whether one more holder still fits under the remaining credit. */
export function canGrantOneMore(input: BonusProjectionInput): boolean {
  if (input.remainingCreditUsd <= 0 || input.now >= input.endsAt) return false;
  return projectedSpend({ ...input, holders: input.holders + 1 }) < input.remainingCreditUsd;
}

// ─── Grants (the Directory's storage) ────────────────────────────────────────

export const BONUS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS gpt6_bonus_grants (
     github_id  INTEGER PRIMARY KEY,
     granted_at INTEGER NOT NULL
   )`,
];

export function bonusHolders(sql: MeterSql): number {
  return sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM gpt6_bonus_grants").toArray()[0]?.n ?? 0;
}

/**
 * The grant for one account: already held (true), granted now when one more fits the projection
 * (true), or not (false). Call inside the Directory's single-threaded object so two new
 * subscribers can't both take the last room.
 */
export function grantBonus(sql: MeterSql, githubId: number, projection: Omit<BonusProjectionInput, "holders">): { granted: boolean; holders: number; fullyClaimed: boolean } {
  const held = sql.exec("SELECT 1 FROM gpt6_bonus_grants WHERE github_id = ?", githubId).toArray().length > 0;
  const holders = bonusHolders(sql);
  const room = canGrantOneMore({ ...projection, holders });
  if (held) return { granted: true, holders, fullyClaimed: !room };
  if (!room) return { granted: false, holders, fullyClaimed: true };
  sql.exec("INSERT INTO gpt6_bonus_grants (github_id, granted_at) VALUES (?, ?)", githubId, projection.now);
  return { granted: true, holders: holders + 1, fullyClaimed: !canGrantOneMore({ ...projection, holders: holders + 1 }) };
}

// ─── Eligibility of one request ──────────────────────────────────────────────

export type BonusBlock =
  /** `gpt6Bonus` off, past the end, or the pre-send guard isn't enforcing. */
  | "off"
  /** Not a paying account. */
  | "not_paying"
  /** Another agent, a tool key or /anthropic: Autopilot only. */
  | "client"
  /** Inside the wait after the first payment. */
  | "waiting"
  /** No OpenAI credit left: the bonus never runs on cash. */
  | "no_credit";

/** Whether a request may use the bonus at all (before the grant and the per-user meter). */
export function bonusBlock(input: {
  config: Gpt6BonusSettingsConfig & { gpt6PresendGuard: string };
  paying: boolean;
  paidSince: number | null;
  /** Another agent or a tool key ("tool"); undefined for Autopilot. */
  agent: string | undefined;
  remainingCreditUsd: number;
  now: number;
}): BonusBlock | undefined {
  const { config, now } = input;
  if (!config.gpt6Bonus || config.gpt6PresendGuard !== "enforce" || now >= Math.min(config.gpt6BonusEndsAt ?? BONUS_ENDS_AT, BONUS_ENDS_AT)) return "off";
  if (!input.paying) return "not_paying";
  if (input.agent !== undefined) return "client";
  if (input.remainingCreditUsd <= 0) return "no_credit";
  if (config.gpt6BonusDelayHours > 0 && (input.paidSince === null || now < input.paidSince + config.gpt6BonusDelayHours * 3_600_000)) return "waiting";
  return undefined;
}

/** "GPT-6 launch bonus used up until Mon 00:00 UTC" (the fallback notice's first part). */
export const BONUS_NAME = "GPT-6 launch bonus";

/** The refusal when the bonus can't be used and DeepSeek can't stand in (fallback off). */
export function bonusRefusalMessage(block: BonusBlock | "used_up" | "not_granted", resetsIn: string, delayHours = 0): string {
  switch (block) {
    case "used_up":
      return `This week's GPT-6 launch bonus ($2/week of GPT-6.1 Sol usage in dl) is used up, resumes Mon 00:00 UTC (in ${resetsIn}). DeepSeek V4.1 Flash is in your plan.`;
    case "not_granted":
      return "The GPT-6 launch bonus is fully claimed. DeepSeek V4.1 Flash is in your plan.";
    case "waiting":
      return `The GPT-6 launch bonus starts ${delayHours} hours after your first payment. DeepSeek V4.1 Flash is in your plan.`;
    case "client":
      return "The GPT-6 launch bonus works in dl (Autopilot) only. DeepSeek V4.1 Flash is in your plan.";
    default:
      return "GPT-6 isn't in dl.new plans. DeepSeek V4.1 Flash is in your plan.";
  }
}

/** The view of the bonus for /v1/me and the dashboard (CONTRACT.md "Part B"). */
export interface BonusView {
  enabled: boolean;
  label: string;
  line: string;
  /** Whether this account holds the bonus. */
  granted: boolean;
  /** Plan page: no room for new subscribers ("GPT-6 launch bonus: fully claimed"). */
  fullyClaimed: boolean;
  weeklyUsd: number;
  spentUsd: number;
  leftUsd: number;
  endsAt: string | null;
}
