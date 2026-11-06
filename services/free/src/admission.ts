/**
 * Account levels for the free tier, as plain arithmetic (the Directory object keeps the rows).
 *
 * `full` is for accounts that look like working developers: old enough, and with either some
 * public repositories or a real contribution history. `starter` is everyone else: a small
 * allowance on DeepSeek only, enough to try the thing, not enough to farm.
 *
 * The point is to make account farming unprofitable without turning away real developers:
 * plenty of real people have no public repositories because their work is private, so the
 * contribution count (private ones included when the person shows them) is an equal path.
 */

export type Level = "full" | "starter";

/** What GitHub told us about an account, as numbers only. */
export interface GithubSignals {
  /** Whole days since the account was created. */
  accountAgeDays: number;
  publicRepos: number;
  followers: number;
  /** Contributions in the last 12 months, public plus the private ones the person shows. */
  contributions: number;
  restrictedContributions: number;
}

/** The thresholds, from runtime config so the owner can change them without a release. */
export interface LevelThresholds {
  minAccountAgeDays: number;
  minPublicRepos: number;
  minContributions: number;
}

/** Why an account is at its level. */
export type LevelReason = "qualifies" | "account_too_new" | "few_repos_and_contributions" | "network_limit" | "invite" | "admin";

/** Whether the signals clear the bar for `full`. */
export function qualifiesForFull(signals: GithubSignals, thresholds: LevelThresholds): boolean {
  if (signals.accountAgeDays < thresholds.minAccountAgeDays) return false;
  return signals.publicRepos >= thresholds.minPublicRepos || signals.contributions >= thresholds.minContributions;
}

export function levelFor(signals: GithubSignals, thresholds: LevelThresholds): Level {
  return qualifiesForFull(signals, thresholds) ? "full" : "starter";
}

/** Why the level is what it is, for the admin page and the person's own message. */
export function levelReason(signals: GithubSignals, thresholds: LevelThresholds): LevelReason {
  if (qualifiesForFull(signals, thresholds)) return "qualifies";
  return signals.accountAgeDays < thresholds.minAccountAgeDays ? "account_too_new" : "few_repos_and_contributions";
}

/** "90 days", "3 public repositories", "50 contributions in the last year". */
export function thresholdText(thresholds: LevelThresholds): string {
  return `a GitHub account at least ${thresholds.minAccountAgeDays} days old with ${thresholds.minPublicRepos} public repositories or ${thresholds.minContributions} contributions in the last year`;
}

/**
 * The honest sentence for a Starter account: what it gets, why, and the three ways up. No
 * accusation, and no hint that anything was done wrong.
 */
export function starterLine(thresholds: LevelThresholds, starterTokens: number): string {
  return `Starter access: DeepSeek only, ${formatTokens(starterTokens)} tokens a week. Full access (GPT-6 and the bigger allowance) needs ${thresholdText(thresholds)}. Keep using GitHub, use an invite code, or bring your own key.`;
}

/** "5M", "1.2M", "800k". */
export function formatTokens(n: number): string {
  const abs = Math.abs(n);
  const trim = (v: number) => v.toFixed(1).replace(/\.0$/, "");
  if (abs >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (abs >= 1_000) return `${trim(n / 1_000)}k`;
  return String(Math.round(n));
}
