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
 *   trial_ended                   a new account (admitted at or after the trial cutoff) used its one-time trial
 *                                 (HTTP 402, with `trial` and `offers`): Pro or a top-up from here
 *
 * `not_invited` is still returned for a sign-in recorded before these codes existed, and by
 * the API for a token whose account isn't on the free tier.
 */

import { formatTokens } from "./admission.js";
import type { Harness } from "./account-object.js";

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
export const DL_ONLY_MESSAGE = "Your dl sign-in works inside dl only. To use free tokens in another tool, make an API key for it: run dl api-key. Or use your own API key in that tool.";

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

/**
 * dl Pro's prompt (phase 1), for a free account whose week of open models (DeepSeek) is used up,
 * while Pro is offered (`proOffered`). `price` as the offers show it ("$7/month"). The refusal
 * carries it as `proPrompt.text`; its `message` adds where to upgrade (`proPromptMessage`), for
 * agents that show the service's own words.
 */
export function proPromptText(price: string, limit?: string): string {
  return `You've hit this week's free ${limit ?? "limit"}. dl Pro: ${price} for higher limits and early access to new models.`;
}

/** The prompt with its Upgrade link, as one line: "… Upgrade: https://dl.new/account" */
export function proPromptMessage(price: string, upgradeUrl: string, limit?: string): string {
  return `${proPromptText(price, limit)} Upgrade: ${upgradeUrl}`;
}

/**
 * Which weekly limit a free refusal hit, named so a person can tell the token allowance from the
 * dollar one: "token limit on DeepSeek V4.1 Flash (~18.7M tokens, 95.5% caching applied)" or
 * "$8 spending limit on DeepSeek V4.1 Flash". `tokens` is the limit in real tokens at the plan
 * mix (`mixLabel` names the mix), `usd` the family's dollar cap.
 */
export function freeLimitName(input: { reason: "tokens" | "spend"; modelName: string; tokens?: number | null; usd?: number | null; mixLabel: string }): string {
  if (input.reason === "tokens") {
    const amount = input.tokens !== undefined && input.tokens !== null && input.tokens > 0 ? ` (~${formatTokens(input.tokens).replace(/k$/, "K")} tokens, ${input.mixLabel})` : "";
    return `token limit on ${input.modelName}${amount}`;
  }
  const usd = input.usd !== undefined && input.usd !== null && input.usd > 0 ? `$${Number.isInteger(input.usd) ? input.usd : input.usd.toFixed(2)} ` : "";
  return `${usd}spending limit on ${input.modelName}`;
}

/**
 * A new account's one-time trial is used up (402 trial_ended): free requests stop for good, and
 * Pro or a top-up keeps it going. `/upgrade` in dl opens both. `proPrice` as the offers show it
 * ("$3.99"); null while Pro isn't offered (`proOffered` off): then only the top-up is named.
 */
export function trialEndedMessage(tokens: number, proPrice: string | null = "$3.99"): string {
  const way = proPrice === null ? "Keep going with a top-up" : `Keep going with dl Pro for ${proPrice} a month, or add a top-up`;
  return `Your ${formatTokens(tokens)} free trial tokens are used up. ${way}: /upgrade`;
}

/**
 * GPT-6's weekly budget is used up but DeepSeek's isn't (402 gpt_limit): not a dead end. Pro
 * already has Pro, so its line leaves the offer out, as does a free account's while Pro isn't
 * offered (`proOffered` off).
 */
export function gptLimitMessage(plan: "free" | "pro" = "free", proOffered = true): string {
  if (plan === "pro") return "You've used this week's Pro GPT-6 allowance. DeepSeek V4.1 Flash still has usage this week: switch with /model.";
  return proOffered
    ? "You've used this week's GPT-6 allowance. DeepSeek V4.1 Flash still has free usage this week: switch with /model, or get dl Pro."
    : "You've used this week's GPT-6 allowance. DeepSeek V4.1 Flash still has free usage this week: switch with /model.";
}

export const QUEUED_SIGNED_IN =
  "Free tokens are busy this week, so you're in line for them; your terminal shows your place. Your own key and paid plans work now.";

export const CREDIT_EXHAUSTED_MESSAGE = "Free tokens are paused while we top up. Your own key still works.";
export const UPSTREAM_BUSY_MESSAGE = "The free tier is busy right now; retrying…";
export const UPSTREAM_UNAVAILABLE_MESSAGE = "The free tier's model provider is having trouble right now; retrying…";
export const UPSTREAM_TIMEOUT_MESSAGE = "The free tier's model provider didn't answer in time; retrying…";

// ─── Other coding agents through dl (`dl claude`, `dl opencode`) ────────────

/** How each coding agent dl launches is named in its refusals. */
export const HARNESS_WORDS: Readonly<Record<Harness, { product: string; command: string; own: string }>> = {
  "claude-code": { product: "Claude Code", command: "dl claude", own: "your own Anthropic account" },
  opencode: { product: "OpenCode", command: "dl opencode", own: "your own provider key" },
  pi: { product: "Pi", command: "dl pi", own: "your own provider key" },
};

/** A harness key that expired, was revoked, or whose sign-in ended (401 invalid_harness_key). */
export function harnessKeyExpiredMessage(harness?: Harness): string {
  if (!harness) return "This dl session's free tier key has expired. Quit the tool and run it from dl again (dl claude, dl opencode, dl pi).";
  const { product, command } = HARNESS_WORDS[harness];
  return `This ${command} session's free tier key has expired. Quit ${product} and run ${command} again.`;
}

/** Claude Code's: what `dl claude` users have always seen. */
export const HARNESS_KEY_EXPIRED_MESSAGE = harnessKeyExpiredMessage("claude-code");

/** The kill switch (`allowOtherHarnesses` off): 403 harness_not_allowed. */
export function harnessNotAllowedMessage(harness: Harness = "claude-code"): string {
  const { product, own } = HARNESS_WORDS[harness];
  return `Free tokens in ${product} are switched off for now. Free tokens still work in dl (Autopilot), and ${product} works with ${own}.`;
}

export const HARNESS_NOT_ALLOWED_MESSAGE = harnessNotAllowedMessage("claude-code");

/**
 * Another agent's share of the week (or of the trial) is used up while the account still has
 * free usage left for Autopilot (402 harness_limit). `share` is 0 to 1. A free account is pointed
 * at dl Pro only while Pro is offered (`proOffered`).
 */
export function harnessLimitMessage(share: number, resetsAt: string | undefined, plan: "free" | "pro" = "free", harness: Harness = "claude-code", proOffered = true): string {
  const part = share >= 1 ? "all" : share <= 0 ? "none" : share === 0.5 ? "half" : `${Math.round(share * 100)}%`;
  const when = resetsAt ? ` It resets at ${resetsAt}.` : "";
  const { product } = HARNESS_WORDS[harness];
  return plan === "pro"
    ? `${product} through dl gets ${part} of your Pro allowance, and that part is used up.${when} The rest works in Autopilot: type dl.`
    : `${product} through dl gets ${part} of your free allowance, and that part is used up.${when} Your remaining free usage works in Autopilot: type dl.${proOffered ? " Or get dl Pro: run dl and type /upgrade." : ""}`;
}

/**
 * A refusal written for Autopilot, reworded for another coding agent: dl's slash commands are
 * typed in dl, not in that agent. OpenCode switches models in its own /models, so the GPT-6
 * limit's pointer to DeepSeek stays for it; Claude Code through dl has only DeepSeek.
 */
export function forHarness(message: string, harness: Harness = "claude-code"): string {
  const { product, command, own } = HARNESS_WORDS[harness];
  if (message === DL_ONLY_MESSAGE) return `Free tokens in ${product} work only while it runs from ${command}. Quit ${product} and run ${command} again, or use ${own}.`;
  const reworded = message
    .replace(/: \/upgrade$/, ": run dl and type /upgrade")
    .replace(/Type \/request in dl/g, "Run dl and type /request");
  const models =
    harness === "opencode"
      ? reworded
          .replace(/switch with \/model, or get dl Pro\./, "pick it in /models, or get dl Pro: run dl and type /upgrade.")
          .replace(/switch with \/model\./, "pick it in /models.")
      : harness === "pi"
      ? reworded.replace(/switch with \/model, or get dl Pro\./, "pick it in /model, or get dl Pro: run dl and type /upgrade.").replace(/switch with \/model\./, "pick it in /model.")
      : reworded.replace(/switch with \/model, or get dl Pro\./, "get dl Pro: run dl and type /upgrade.");
  return models.replace(/use your own key: \/provider\./, `use ${product} with ${own}.`);
}
