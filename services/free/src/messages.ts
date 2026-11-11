/**
 * The sentences behind every refusal a person can meet, in one place, so the browser page and
 * the terminal (which shows `error.message` for codes it doesn't know) say the same thing.
 *
 * Sign-in refusals come back from `POST /v1/device/token` as `{error: {code, message, reason}}`
 * (HTTP 400, the RFC 8628 error shape); inference refusals from `POST /v1/chat/completions`.
 *
 *   code                          when
 *   account_too_new               GitHub account younger than MIN_GITHUB_ACCOUNT_AGE_DAYS, no invite code used
 *   no_github_activity            GitHub account with no public repository and no contribution in the last year
 *                                 (requireGithubActivity), no invite code used
 *   invite_required               invite-only (or not yet eligible for open admission), no invite code used
 *   cohort_full                   MAX_ACTIVE_USERS people are already in
 *   too_many_signups              too many new accounts from one network today
 *   access_denied                 cancelled in the browser; reason "device_taken" when the device holds another account's grant
 *   blocked                       an admin blocked the account (HTTP 403 on chat, refresh and keys; sign-in refused)
 *   service_paused                the owner paused the free tier (reason "paused")
 *   global_weekly_budget_reached  this week's global USD cap is used up (resetsAt: when it resumes)
 *   global_total_budget_reached   the total USD cap is used up (resetsAt: null; resumes only if the owner raises it)
 *   upstream_credit_exhausted     the Luminal credit is used up (503; free and Pro usage pause until it is topped up)
 *   upstream_busy                 Luminal answered 429 (HTTP 429, Retry-After): transient, retry
 *   upstream_unavailable          Luminal answered 5xx or couldn't be reached (HTTP 503, Retry-After): transient, retry
 *   upstream_timeout              Luminal sent nothing before the first-byte timeout (HTTP 503, Retry-After): transient, retry
 *
 * `not_invited` is still returned for a sign-in recorded before these codes existed, and by
 * the API for a token whose account isn't on the free tier.
 */

export const SIGN_IN_REFUSALS = ["account_too_new", "no_github_activity", "invite_required", "cohort_full", "too_many_signups"] as const;
export type SignInRefusal = (typeof SIGN_IN_REFUSALS)[number];

export function isSignInRefusal(value: unknown): value is SignInRefusal {
  return typeof value === "string" && (SIGN_IN_REFUSALS as readonly string[]).includes(value);
}

/** Why an account with no public repository and no recent contribution needs an invite. */
export const NO_GITHUB_ACTIVITY_REASON = "Your GitHub account has no public repositories or contributions yet, so it needs an invite code for the free tier.";

export function signInRefusal(code: SignInRefusal, minAccountAgeDays: number): { heading: string; message: string } {
  switch (code) {
    case "account_too_new":
      return {
        heading: "Invite code needed",
        message: `This GitHub account is less than ${minAccountAgeDays} days old, so it needs an invite code for the free tier. Run sign-in again and enter your code on the sign-in page.`,
      };
    case "no_github_activity":
      return {
        heading: "Invite code needed",
        message: `${NO_GITHUB_ACTIVITY_REASON} Ask a friend for an invite code, then run sign-in again and enter it on the sign-in page.`,
      };
    case "invite_required":
      return {
        heading: "Invite code needed",
        message: "The free tier is invite-only for now, and this GitHub account needs an invite code. Run sign-in again and enter your code on the sign-in page.",
      };
    case "cohort_full":
      return {
        heading: "The free tier is full",
        message: "Every place on the free tier is taken right now. Try again later; your own key still works.",
      };
    case "too_many_signups":
      return {
        heading: "Too many sign-ups",
        message: "Too many new free-tier accounts were created from this network today. Try again tomorrow.",
      };
  }
}

export const BLOCKED_MESSAGE = "This account is blocked from the free tier. Contact contact@directionallylocal.com.";

/** The dl-only refusal (code dl_only): free tokens were used from another tool. */
export const DL_ONLY_MESSAGE = "Free tokens work inside dl only. Run dl to keep using them, or use your own API key in any tool.";

/** The refusal (code server_keys_unavailable) for creating or using a server key without being granted them. */
export const SERVER_KEYS_UNAVAILABLE_MESSAGE =
  "Server keys on the free tier are by request. Type /request in dl and say what server you want to run it on, or use your own API key on the server.";

export const DEVICE_TAKEN_MESSAGE = "This device already has a free allowance under another GitHub account; sign in with that account instead.";
export const INVALID_INVITE_MESSAGE = "That invite code isn't valid or was already used.";

export const PAUSED_MESSAGE = "Free tokens are paused for everyone right now; your own key still works. Try the free tier again later.";

export function weeklyBudgetMessage(resetsAt: string): string {
  return `Free tokens are paused for everyone until ${resetsAt}: this week's free budget is used up. Your own key still works.`;
}

export const TOTAL_BUDGET_MESSAGE = "Free tokens are paused for everyone: the free tier's total budget is used up. Your own key still works.";

/** The 402 a queued person gets for free tokens (`free_tier_queued`). `wait` is e.g. "about 3 days". */
export function queuedMessage(position: number, wait: string): string {
  return `You're #${position} in line for free tokens (${wait}). Each friend who starts using dl moves you up. Your own key works now.`;
}

/** The 402 for a used-up weekly allowance (`quota_exceeded`). */
export function quotaMessage(reason: "tokens" | "spend", resetsAt: string, plan: "free" | "pro" = "free"): string {
  const what = reason === "spend" ? "spending allowance" : "token allowance";
  return `This week's ${plan === "pro" ? "Pro" : "free"} ${what} is used up. It resets at ${resetsAt}.`;
}

export const QUEUED_SIGNED_IN =
  "Free tokens are busy this week, so you're in line for them; your terminal shows your place. Your own key and paid plans work now.";

export const CREDIT_EXHAUSTED_MESSAGE = "Free tokens are paused while we top up. Your own key still works.";
export const UPSTREAM_BUSY_MESSAGE = "The free tier is busy right now; retrying…";
export const UPSTREAM_UNAVAILABLE_MESSAGE = "The free tier's model provider is having trouble right now; retrying…";
export const UPSTREAM_TIMEOUT_MESSAGE = "The free tier's model provider didn't answer in time; retrying…";
