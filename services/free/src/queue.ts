import type { AccessRequestAlerts, FreeConfig, Upstream } from "./config.js";
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
 * When Luminal serves requests (`creditMode`: `primaryUpstream` is "luminal" and LUMINAL_API_KEY
 * is set), the cash caps stay near zero, so the queue watches Luminal credit instead: a new
 * sign-up waits once this week's free credit spend reaches `queueThreshold` of
 * `luminalWeeklyCreditUsd`, and Monday's admission fills the same share of that weekly credit
 * budget (no more than the credit left), with last week's free credit spend per active as the
 * average. The cash test still applies too, so OpenRouter spend can also start the queue.
 *
 * Order: oldest first, and each referred friend who became weekly active moves a person up
 * `queueReferralPlaces` places (25): sort by (place in line − 25 × friends, then place in line).
 */

/** The settings the Directory needs for the queue, referrals and alerts; overrides are applied there. */
export interface Policy {
  adminIds: number[];
  weeklyTokens: number;
  /** A Full person's GPT-6 budget, and DeepSeek budget: together, the most a new person costs a week. */
  perPersonWeeklyUsdCap: number | undefined;
  deepseekWeeklyUsdCap?: number | undefined;
  globalWeeklyUsdCap: number | undefined;
  globalTotalUsdCap: number | undefined;
  queueThreshold: number;
  queueReferralPlaces: number;
  referralBonusTokens: number;
  referralBonusCap: number;
  primaryUpstream: Upstream;
  /** LUMINAL_API_KEY is set; without it every request goes to OpenRouter. */
  luminalConfigured: boolean;
  luminalCreditUsd: number;
  luminalWeeklyCreditUsd: number | undefined;
  /** OPENAI_API_KEY is set. */
  openaiConfigured: boolean;
  openaiCreditUsd: number;
  openaiWeeklyCreditUsd: number | undefined;
  /** The owner's access-request emails: "daily" puts them in the daily digest. Optional for older callers: "each". */
  accessRequestAlerts?: AccessRequestAlerts;
}

/** Whether a prepaid-credit provider serves requests, so the queue and alerts watch its credit. */
export function creditMode(policy: Pick<Policy, "primaryUpstream" | "luminalConfigured"> & Partial<Pick<Policy, "openaiConfigured">>): boolean {
  // A credit provider serves when the primary is one and has a key, or when the primary has no
  // key and the other credit provider does (the same choice creditBudget makes).
  if (policy.primaryUpstream === "openai") return policy.openaiConfigured === true || policy.luminalConfigured === true;
  if (policy.primaryUpstream === "luminal") return policy.luminalConfigured === true || policy.openaiConfigured === true;
  return false;
}

/**
 * The credit balance and weekly budget the queue watches: the primary provider's when it has
 * a key, else whichever credit provider does (OpenAI first, then Luminal).
 */
export function creditBudget(
  policy: Pick<Policy, "primaryUpstream" | "openaiConfigured" | "luminalConfigured" | "openaiCreditUsd" | "openaiWeeklyCreditUsd" | "luminalCreditUsd" | "luminalWeeklyCreditUsd">,
): { balanceUsd: number; weeklyUsd: number | undefined; provider: "openai" | "luminal" } {
  const openai = { balanceUsd: policy.openaiCreditUsd, weeklyUsd: policy.openaiWeeklyCreditUsd, provider: "openai" as const };
  const luminal = { balanceUsd: policy.luminalCreditUsd, weeklyUsd: policy.luminalWeeklyCreditUsd, provider: "luminal" as const };
  if (policy.primaryUpstream === "openai" && policy.openaiConfigured) return openai;
  if (policy.primaryUpstream === "luminal" && policy.luminalConfigured) return luminal;
  if (policy.openaiConfigured) return openai;
  return luminal;
}

export function policyOf(config: FreeConfig): Policy {
  return {
    adminIds: [...config.adminGithubIds],
    weeklyTokens: config.weeklyTokens,
    perPersonWeeklyUsdCap: config.perPersonWeeklyUsdCap,
    deepseekWeeklyUsdCap: config.deepseekWeeklyUsdCap,
    globalWeeklyUsdCap: config.globalWeeklyUsdCap,
    globalTotalUsdCap: config.globalTotalUsdCap,
    queueThreshold: config.queueThreshold,
    queueReferralPlaces: config.queueReferralPlaces,
    referralBonusTokens: config.referralBonusTokens,
    referralBonusCap: config.referralBonusCap,
    primaryUpstream: config.primaryUpstream,
    luminalConfigured: config.luminalApiKey !== undefined,
    luminalCreditUsd: config.luminalCreditUsd,
    luminalWeeklyCreditUsd: config.luminalWeeklyCreditUsd,
    openaiConfigured: config.openaiApiKey !== undefined,
    openaiCreditUsd: config.openaiCreditUsd,
    openaiWeeklyCreditUsd: config.openaiWeeklyCreditUsd,
    accessRequestAlerts: config.accessRequestAlerts,
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
  policy: Pick<Policy, "globalWeeklyUsdCap" | "globalTotalUsdCap" | "queueThreshold" | "perPersonWeeklyUsdCap"> & Partial<Pick<Policy, "deepseekWeeklyUsdCap">>;
  totalSpentUsd: number;
}): Forecast {
  const { policy } = input;
  // With no spend to go on, a new person is assumed to use both weekly budgets in full.
  const perPerson = policy.perPersonWeeklyUsdCap === undefined ? undefined : policy.perPersonWeeklyUsdCap + (policy.deepseekWeeklyUsdCap ?? 0);
  const avgUsd = input.lastWeekActives > 0 && input.lastWeekUsd > 0 ? input.lastWeekUsd / input.lastWeekActives : (perPerson ?? FALLBACK_AVG_USD) || FALLBACK_AVG_USD;
  if (policy.globalWeeklyUsdCap === undefined) return { avgUsd, actives: input.lastWeekActives, budgetUsd: null, room: Number.MAX_SAFE_INTEGER };
  let budgetUsd = policy.queueThreshold * policy.globalWeeklyUsdCap;
  if (policy.globalTotalUsdCap !== undefined) budgetUsd = Math.min(budgetUsd, Math.max(0, policy.globalTotalUsdCap - input.totalSpentUsd));
  // A hair of tolerance so 200 / 5 is 40, not 39.99999.
  const room = Math.max(0, Math.floor(budgetUsd / avgUsd + 1e-9) - input.lastWeekActives);
  return { avgUsd, actives: input.lastWeekActives, budgetUsd, room };
}

/**
 * The forecast in credit mode: the same arithmetic over last week's free Luminal credit spend,
 * a budget of `queueThreshold` × the weekly credit budget, and no more than the credit left.
 */
export function creditForecast(input: {
  lastWeekCreditUsd: number;
  lastWeekActives: number;
  policy: Pick<Policy, "queueThreshold" | "perPersonWeeklyUsdCap" | "luminalCreditUsd" | "luminalWeeklyCreditUsd"> & Partial<Pick<Policy, "primaryUpstream" | "openaiCreditUsd" | "openaiWeeklyCreditUsd" | "deepseekWeeklyUsdCap">>;
  creditUsedUsd: number;
}): Forecast {
  const { policy } = input;
  const budget = creditBudget({
    ...policy,
    openaiCreditUsd: policy.openaiCreditUsd ?? 0,
    openaiWeeklyCreditUsd: policy.openaiWeeklyCreditUsd,
  } as Policy);
  return forecast({
    lastWeekUsd: input.lastWeekCreditUsd,
    lastWeekActives: input.lastWeekActives,
    policy: { globalWeeklyUsdCap: budget.weeklyUsd, globalTotalUsdCap: budget.balanceUsd, queueThreshold: policy.queueThreshold, perPersonWeeklyUsdCap: policy.perPersonWeeklyUsdCap, deepseekWeeklyUsdCap: policy.deepseekWeeklyUsdCap },
    totalSpentUsd: input.creditUsedUsd,
  });
}

/** Whether a new sign-up waits: free spend at the threshold, or people already waiting. */
export function shouldQueue(input: {
  weekUsd: number;
  /** This week's free Luminal credit spend; only counts in credit mode. */
  weekCreditUsd?: number;
  queueLength: number;
  policy: Pick<Policy, "globalWeeklyUsdCap" | "queueThreshold"> &
    Partial<Pick<Policy, "primaryUpstream" | "luminalConfigured" | "luminalWeeklyCreditUsd" | "luminalCreditUsd" | "openaiConfigured" | "openaiWeeklyCreditUsd" | "openaiCreditUsd">>;
}): boolean {
  if (input.queueLength > 0) return true;
  const { policy } = input;
  const cap = policy.globalWeeklyUsdCap;
  if (cap !== undefined && input.weekUsd >= policy.queueThreshold * cap) return true;
  if (policy.primaryUpstream === undefined) return false;
  const inCreditMode = creditMode({ primaryUpstream: policy.primaryUpstream, luminalConfigured: policy.luminalConfigured === true, openaiConfigured: policy.openaiConfigured === true });
  if (!inCreditMode) return false;
  const budget = creditBudget({
    primaryUpstream: policy.primaryUpstream,
    openaiConfigured: policy.openaiConfigured === true,
    luminalConfigured: policy.luminalConfigured === true,
    openaiCreditUsd: policy.openaiCreditUsd ?? 0,
    openaiWeeklyCreditUsd: policy.openaiWeeklyCreditUsd,
    luminalCreditUsd: policy.luminalCreditUsd ?? 0,
    luminalWeeklyCreditUsd: policy.luminalWeeklyCreditUsd,
  });
  return budget.weeklyUsd !== undefined && (input.weekCreditUsd ?? 0) >= policy.queueThreshold * budget.weeklyUsd;
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
