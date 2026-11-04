import type { FreeConfig } from "./config.js";
import { DAY_MS, WEEK_MS, weekEnd } from "./week.js";

/**
 * The queue for free tokens, as plain arithmetic (the Directory object keeps the rows).
 *
 * While this week's free spend is at or above `queueThreshold` of the weekly cap, or anyone is
 * already waiting, a new sign-up still gets an account (identity, referral link, own-key use,
 * paid plans) but waits in line for free tokens. People already in keep their allowance.
 *
 * Every Monday 00:00 UTC (lazily, on the first request of the week, or the Directory's alarm),
 * the queue is admitted oldest first, as many as the forecast allows:
 *
 *   avg      = last week's free cost / last week's actives   (non-admin people with a free request)
 *              (no data yet: the per-person weekly USD cap, or $5)
 *   budget   = queueThreshold × weekly cap, and no more than what is left of the all-time cap
 *   admitted = the largest N with avg × (actives + N) ≤ budget, i.e. floor(budget / avg) − actives,
 *              at least 0 and at most the queue's length. No weekly cap: everyone.
 *
 * Order: oldest first, and each referred friend who became weekly active moves a person up
 * `queueReferralPlaces` places (25): sort by (place in line − 25 × friends, then place in line).
 */

/** The settings the Directory needs for the queue, referrals and alerts; overrides are applied there. */
export interface Policy {
  adminIds: number[];
  weeklyTokens: number;
  perPersonWeeklyUsdCap: number | undefined;
  globalWeeklyUsdCap: number | undefined;
  globalTotalUsdCap: number | undefined;
  queueThreshold: number;
  queueReferralPlaces: number;
  referralBonusTokens: number;
  referralBonusCap: number;
}

export function policyOf(config: FreeConfig): Policy {
  return {
    adminIds: [...config.adminGithubIds],
    weeklyTokens: config.weeklyTokens,
    perPersonWeeklyUsdCap: config.perPersonWeeklyUsdCap,
    globalWeeklyUsdCap: config.globalWeeklyUsdCap,
    globalTotalUsdCap: config.globalTotalUsdCap,
    queueThreshold: config.queueThreshold,
    queueReferralPlaces: config.queueReferralPlaces,
    referralBonusTokens: config.referralBonusTokens,
    referralBonusCap: config.referralBonusCap,
  };
}

/** Used when last week has no free cost to average. */
export const FALLBACK_AVG_USD = 5;

export interface Forecast {
  /** Average free cost per active person last week, or the fallback. */
  avgUsd: number;
  actives: number;
  /** USD the forecast fills up to; null when there is no weekly cap. */
  budgetUsd: number | null;
  /** How many may be admitted (before limiting to the queue's length). */
  room: number;
}

/** How many people the budget has room for this week. */
export function forecast(input: {
  lastWeekUsd: number;
  lastWeekActives: number;
  policy: Pick<Policy, "globalWeeklyUsdCap" | "globalTotalUsdCap" | "queueThreshold" | "perPersonWeeklyUsdCap">;
  totalSpentUsd: number;
}): Forecast {
  const { policy } = input;
  const avgUsd = input.lastWeekActives > 0 && input.lastWeekUsd > 0 ? input.lastWeekUsd / input.lastWeekActives : (policy.perPersonWeeklyUsdCap ?? FALLBACK_AVG_USD) || FALLBACK_AVG_USD;
  if (policy.globalWeeklyUsdCap === undefined) return { avgUsd, actives: input.lastWeekActives, budgetUsd: null, room: Number.MAX_SAFE_INTEGER };
  let budgetUsd = policy.queueThreshold * policy.globalWeeklyUsdCap;
  if (policy.globalTotalUsdCap !== undefined) budgetUsd = Math.min(budgetUsd, Math.max(0, policy.globalTotalUsdCap - input.totalSpentUsd));
  // A hair of tolerance so 200 / 5 is 40, not 39.99999.
  const room = Math.max(0, Math.floor(budgetUsd / avgUsd + 1e-9) - input.lastWeekActives);
  return { avgUsd, actives: input.lastWeekActives, budgetUsd, room };
}

/** Whether a new sign-up waits: free spend at the threshold, or people already waiting. */
export function shouldQueue(input: { weekUsd: number; queueLength: number; policy: Pick<Policy, "globalWeeklyUsdCap" | "queueThreshold"> }): boolean {
  if (input.queueLength > 0) return true;
  const cap = input.policy.globalWeeklyUsdCap;
  return cap !== undefined && input.weekUsd >= input.policy.queueThreshold * cap;
}

export interface Waiting {
  githubId: number;
  queuedAt: number;
  /** Referred friends who became weekly active. */
  activeFriends: number;
}

/** The line, front first: oldest first, each active friend moving a person up `places` places. */
export function queueOrder(waiting: Waiting[], places: number): Waiting[] {
  const base = [...waiting].sort((a, b) => a.queuedAt - b.queuedAt || a.githubId - b.githubId);
  return base
    // Moving up 25 places from 51 means taking place 26, ahead of who held it.
    .map((person, index) => ({ person, index, key: index - places * person.activeFriends - (person.activeFriends > 0 ? 0.5 : 0) }))
    .sort((a, b) => a.key - b.key || a.index - b.index)
    .map((entry) => entry.person);
}

/**
 * When a person at `position` (1 = next) can expect free tokens: the Monday after enough
 * weekly admissions of `perWeek` people (at least 1) have reached them.
 */
export function etaAt(position: number, perWeek: number, now: number): number {
  const weeks = Math.max(1, Math.ceil(position / Math.max(1, perWeek)));
  return weekEnd(now) + (weeks - 1) * WEEK_MS;
}

/** "about 3 days", "about 2 weeks". */
export function waitText(eta: number, now: number): string {
  const days = Math.max(1, Math.ceil((eta - now) / DAY_MS));
  if (days < 14) return `about ${days} day${days === 1 ? "" : "s"}`;
  return `about ${Math.round(days / 7)} weeks`;
}
