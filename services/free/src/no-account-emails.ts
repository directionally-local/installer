/**
 * The two emails dl.new sends to a verified address with no account yet (paid-web.ts):
 *
 *   - the sign-in code with a short welcome, when someone asks for an email code for an address
 *     with no account (entering it answers 403 no_account with a `pending` token, as GitHub and
 *     Google do, and the site sends them to pick a plan);
 *   - a welcome after "Continue with GitHub/Google" finds no account, at most once per address
 *     per 7 days.
 *
 * Plain, no hype: no refund promise, no "cancel anytime", and "(95.5% caching applied)" after
 * every token number. The card-trial clause goes only while card trials are open.
 */

import { PLANS } from "./plan-prices.js";
import { PLAN_MIX_LABEL } from "./plans.js";
import { countedText } from "./trials.js";

export interface NoAccountOffer {
  /** The site's address, like "https://dl.new". */
  site: string;
  /** The card trial's real tokens while card trials are open, else null. */
  trialTokens: number | null;
}

/** "Starter is $7/mo, and your first 20M tokens (95.5% caching applied) are free with a card." */
export function planOfferLine(offer: NoAccountOffer): string {
  const price = `Starter is $${PLANS.starter.priceUsd}/mo`;
  if (offer.trialTokens === null || offer.trialTokens <= 0) return `${price}.`;
  return `${price}, and your first ${countedText(offer.trialTokens)} tokens (${PLAN_MIX_LABEL}) are free with a card.`;
}

/** The sign-in code for an address with no account, with the welcome. */
export function newAddressCodeEmail(input: NoAccountOffer & { code: string; minutes: number }): { subject: string; text: string } {
  return {
    subject: "Your dl.new sign-in code",
    text: [
      "Welcome to dl.new. Your sign-in code:",
      "",
      `    ${input.code}`,
      "",
      `It works for ${input.minutes} minutes. If you didn't ask for it, ignore this email.`,
      "",
      `To finish setting up, pick a plan: ${input.site}`,
      planOfferLine(input),
      "",
      "dl.new",
    ].join("\n"),
  };
}

/** The welcome after a GitHub or Google sign-in that found no account. */
export function noAccountWelcomeEmail(input: NoAccountOffer & { via: "github" | "google" }): { subject: string; text: string } {
  const via = input.via === "github" ? "GitHub" : "Google";
  return {
    subject: "Welcome to dl.new",
    text: [
      `Welcome to dl.new. You signed in with ${via}; there's no plan on this address yet.`,
      "",
      `To finish setting up, pick a plan: ${input.site}`,
      planOfferLine(input),
      "",
      "If you didn't sign in to dl.new, ignore this email.",
      "",
      "dl.new",
    ].join("\n"),
  };
}
