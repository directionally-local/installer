/**
 * Account levels for the free tier, as plain arithmetic (the Directory object keeps the rows).
 *
 * `full` is for accounts that look like working developers: old enough, and with either some
 * public repositories or a real contribution history. `basic` is the middle: below that bar, but
 * an older account that isn't part of a creation batch, with every model on a smaller weekly
 * allowance (its own runtime settings; 0 tokens turns it off). `starter` is everyone else: every
 * model on a small allowance (or none), enough to try the thing, not enough to farm. A Starter
 * account flagged by the creation-batch check gets no free tokens at all, whatever the setting.
 *
 * The point is to make account farming unprofitable without turning away real developers:
 * plenty of real people have no public repositories because their work is private, so the
 * contribution count (private ones included when the person shows them) is an equal path.
 *
 * On top of that public bar, a handful of additional account signals (from the same public
 * GitHub data, read with the sign-in token) with thresholds that live in the private admin
 * settings: see `levelChecks`. None of them is named in anything a person is shown.
 */

import { DAY_MS } from "./week.js";

export type Level = "full" | "basic" | "starter";

/** What GitHub told us about an account, as numbers only. */
export interface GithubSignals {
  /** Whole days since the account was created. */
  accountAgeDays: number;
  publicRepos: number;
  followers: number;
  /** Contributions in the last 12 months, public plus the private ones the person shows. */
  contributions: number;
  restrictedContributions: number;
  /** The UTC day (days since 1970-01-01) the GitHub account was created; null when unknown. */
  createdDay?: number | null;
  /** Additional account signals (see `levelChecks`); null or missing when never read. */
  activeWeeks?: number | null;
  outsideContributions?: number | null;
  /** When the oldest owned non-fork repository was created (Unix ms); null for none or unknown. */
  oldestRepoCreatedAt?: number | null;
  social?: number | null;
}

/** The thresholds, from runtime config so the owner can change them without a release. */
export interface LevelThresholds {
  minAccountAgeDays: number;
  minPublicRepos: number;
  minContributions: number;
}

/**
 * The additional checks' thresholds: runtime settings, so the real values stay in the private
 * admin settings. Never shown to the person.
 */
export interface SignalThresholds {
  /** Signals needed without the public bar; one fewer with it. */
  humanSignalsNeeded: number;
  minActiveWeeks: number;
  minRepoAgeDays: number;
  minSocial: number;
  minFollowers: number;
  /** Days either side of an account's creation day that count as the same batch. */
  batchWindowDays: number;
  /** Accounts already signed up in that window that make a batch; 0 turns the check off. */
  batchSize: number;
}

/** Which checks an account passes, for the decision and for the admin pages. */
export interface LevelChecks {
  publicBar: boolean;
  activeWeeks: boolean;
  outsideContributions: boolean;
  oldRepo: boolean;
  social: boolean;
  followers: boolean;
  /** How many of the five signals above pass. */
  humanSignals: number;
  /** Accounts already signed up whose GitHub account was created in the same window. */
  batchPeers: number;
  creationBatch: boolean;
  full: boolean;
}

/** Why an account is at its level. */
export type LevelReason = "qualifies" | "account_too_new" | "few_repos_and_contributions" | "network_limit" | "invite" | "admin";

/** Whether the signals clear the public bar (the one the person is told about). */
export function meetsPublicBar(signals: GithubSignals, thresholds: LevelThresholds): boolean {
  if (signals.accountAgeDays < thresholds.minAccountAgeDays) return false;
  return signals.publicRepos >= thresholds.minPublicRepos || signals.contributions >= thresholds.minContributions;
}

/**
 * Every check, from the signals, the public bar, the additional thresholds, the time and how
 * many accounts already signed up were created in the same window (`batchPeers`).
 *
 * Full = not in a creation batch, and either enough additional signals on their own or the
 * public bar plus one fewer. A missing signal counts as not passing.
 */
export function levelChecks(signals: GithubSignals, bar: LevelThresholds, rules: SignalThresholds, context: { now: number; batchPeers: number }): LevelChecks {
  const atLeast = (value: number | null | undefined, min: number) => typeof value === "number" && value >= min;
  const publicBar = meetsPublicBar(signals, bar);
  const activeWeeks = atLeast(signals.activeWeeks, rules.minActiveWeeks);
  const outsideContributions = atLeast(signals.outsideContributions, 1);
  const repoAt = signals.oldestRepoCreatedAt;
  const oldRepo = typeof repoAt === "number" && context.now - repoAt >= rules.minRepoAgeDays * DAY_MS;
  const social = atLeast(signals.social, rules.minSocial);
  const followers = atLeast(signals.followers, rules.minFollowers);
  const humanSignals = [activeWeeks, outsideContributions, oldRepo, social, followers].filter(Boolean).length;
  const creationBatch = rules.batchSize > 0 && context.batchPeers >= rules.batchSize && signals.followers === 0;
  const full = !creationBatch && (humanSignals >= rules.humanSignalsNeeded || (publicBar && humanSignals >= rules.humanSignalsNeeded - 1));
  return { publicBar, activeWeeks, outsideContributions, oldRepo, social, followers, humanSignals, batchPeers: context.batchPeers, creationBatch, full };
}

/**
 * The basic level's rule, from runtime settings: an account at least `minAccountAgeDays` old,
 * not flagged by the creation-batch check. `weeklyTokens` 0 turns the level off. Never shown to
 * the person: the basic line says what the level gets, not who gets it.
 */
export interface BasicRule {
  minAccountAgeDays: number;
  weeklyTokens: number;
}

/** Whether an account below the public bar gets the basic level. */
export function qualifiesForBasic(signals: Pick<GithubSignals, "accountAgeDays">, checks: Pick<LevelChecks, "creationBatch">, rule: BasicRule): boolean {
  return rule.weeklyTokens > 0 && !checks.creationBatch && signals.accountAgeDays >= rule.minAccountAgeDays;
}

/** Full when every check passes; else basic when `basic` is given and the account qualifies; else starter. */
export function levelFor(checks: LevelChecks, signals?: GithubSignals, basic?: BasicRule): Level {
  if (checks.full) return "full";
  return signals && basic && qualifiesForBasic(signals, checks, basic) ? "basic" : "starter";
}

/**
 * Why the level is what it is, for the admin page and the person's own message. A Starter
 * account is given one of the public reasons only: the additional checks are never named.
 */
export function levelReason(signals: GithubSignals, thresholds: LevelThresholds, checks: LevelChecks): LevelReason {
  if (checks.full) return "qualifies";
  return signals.accountAgeDays < thresholds.minAccountAgeDays ? "account_too_new" : "few_repos_and_contributions";
}

/**
 * Creation-batch counts for a list of accounts at once (the admin pages): for each creation
 * day, how many of `days` fall within `windowDays` of it. The caller leaves the account itself out.
 */
export function batchCounter(days: Array<number | null>, windowDays: number): (day: number | null) => number {
  const sorted = days.filter((day): day is number => day !== null).sort((a, b) => a - b);
  const firstAtLeast = (value: number) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return (day) => (day === null ? 0 : firstAtLeast(day + windowDays + 1) - firstAtLeast(day - windowDays));
}

/** The UTC day of a time (Unix ms). */
export function dayOf(at: number): number {
  return Math.floor(at / DAY_MS);
}

/** "90 days", "3 public repositories", "50 contributions in the last year". */
export function thresholdText(thresholds: LevelThresholds): string {
  return `a GitHub account at least ${thresholds.minAccountAgeDays} days old with ${thresholds.minPublicRepos} public repositories or ${thresholds.minContributions} contributions in the last year`;
}

/**
 * The honest sentence for a Starter account: what it gets, why, and the ways up. No
 * accusation, and no hint that anything was done wrong. With no Starter tokens (the setting at
 * 0, or an account that gets none), the below-the-bar line.
 */
export function starterLine(thresholds: LevelThresholds, starterTokens: number, starterUsd?: number): string {
  if (starterTokens <= 0) return belowBarLine(thresholds);
  return `Starter access: a small free allowance to try dl, ${allowanceText(starterTokens, starterUsd)}. It resets every Monday. The full free tier is for established GitHub accounts: ${barText(thresholds)}. Want more? Type /request in dl and tell us what you're building. Or use your own API key with /provider.`;
}

/** The bar in plain words: "1 year old with 100+ contributions in the last year". */
function barText(t: LevelThresholds): string {
  const years = t.minAccountAgeDays / 365;
  const age = Number.isInteger(years) && years >= 1 ? `${years} year${years === 1 ? "" : "s"}` : `${t.minAccountAgeDays} days`;
  // A huge repos minimum means that path is switched off: don't mention it.
  const repos = t.minPublicRepos <= 1000 ? ` or ${t.minPublicRepos}+ public repositories` : "";
  return `at least ${age} old with ${t.minContributions}+ contributions in the last year${repos}`;
}

/** Where people below the bar can ask for free credits when /request in dl isn't at hand. */
export const CREDITS_REQUEST_EMAIL = "contact@directionallylocal.com";

/** The endpoint dl's /request command posts to (app.ts). Refusals carry it as `request`. */
export const ACCESS_REQUEST_PATH = "/v1/access-request";

/**
 * What an account below the bar is told when it gets no free tokens at all: who free tokens are
 * for, how to ask for them anyway (/request in dl, or email), and the own-key way.
 */
export function belowBarLine(thresholds: LevelThresholds): string {
  return `Free tokens are for established GitHub accounts: ${barText(thresholds)}. Not there yet? Type /request in dl and tell us what you're building, and we may give you free tokens (or email ${CREDITS_REQUEST_EMAIL}). Or use your own API key with /provider.`;
}

/** "10M tokens a week of every model, GPT-6 included, up to $3" (no dollar part without a cap). */
function allowanceText(weeklyTokens: number, weeklyUsd: number | undefined): string {
  const usd = weeklyUsd === undefined ? "" : `, up to $${Number.isInteger(weeklyUsd) ? weeklyUsd : weeklyUsd.toFixed(2)}`;
  return `${formatTokens(weeklyTokens)} tokens a week of every model, GPT-6 included${usd}`;
}

/**
 * The sign-in page's line for a basic account: what it gets and how to ask for more. Never why:
 * the rule behind the level is private.
 */
export function basicLine(weeklyTokens: number, weeklyUsd: number | undefined): string {
  return `Basic access: a smaller free allowance, ${allowanceText(weeklyTokens, weeklyUsd)}. It resets every Monday. Want more? Type /request in dl and tell us what you're building. Or use your own API key with /provider.`;
}

/** What a basic or Starter account is told when this week's allowance is used up. */
export function limitLine(level: "basic" | "starter", weeklyTokens: number, weeklyUsd: number | undefined): string {
  const name = level === "basic" ? "Basic" : "Starter";
  return `You've used this week's free ${name} allowance (${allowanceText(weeklyTokens, weeklyUsd)}). It resets on Monday. Need more? Type /request in dl and tell us what you're building, or use your own API key with /provider.`;
}

/** "5M", "1.2M", "800k". */
export function formatTokens(n: number): string {
  const abs = Math.abs(n);
  const trim = (v: number) => v.toFixed(1).replace(/\.0$/, "");
  if (abs >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (abs >= 1_000) return `${trim(n / 1_000)}k`;
  return String(Math.round(n));
}
