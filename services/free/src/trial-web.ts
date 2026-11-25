/**
 * dl.new's free trials, the service side (trials.ts has the rules and the numbers):
 *
 *   - card trials: started when a trial Checkout is claimed, ended in Stripe when the trial's
 *     counted tokens are used (`convertTrial`, `trial_end=now` with the launch offer's coupon on
 *     that first real charge), or by Stripe itself after 30 days (the webhooks: `finishCardTrial`),
 *     and the coupon put on the subscription before that backstop (`trialWillEnd`);
 *   - no-card trials: the GitHub sign-in on dl.new/trial (`noCardTrialSignIn`) with the free
 *     tier's account checks, one per GitHub account and per verified email;
 *   - their emails: welcome_trial_card, welcome_trial_nocard, trial_card_80, trial_converted.
 *
 * Routed from paid-web.ts (claim, sign-in, webhooks) and app.ts (chat: conversion, 80% notice).
 */

import { account, alert, directory, grantLaunchBonus, runtime, spendTrialSignup, userEmail, type Ctx } from "./app.js";
import { emailBlocked, emailDomain, isDisposableDomain, normalizeEmail, PUBLIC_EMAIL_DOMAINS } from "./email-guard.js";
import { apiError } from "./errors.js";
import { BONUS_LINE } from "./gpt6-bonus.js";
import { PLANS, isPlanId, type PlanId } from "./plan-prices.js";
import { approxTokens, PLAN_MIX_LABEL, planLimits, type PlanSettingsConfig } from "./plans.js";
import { attachCoupon, endTrialNow, invoiceDiscountPercent, isCouponRefusal, periodEnd, planState, promoEligible, StripeError, subscriptionTrial } from "./stripe.js";
import {
  countedText,
  dayText,
  declinedRecently,
  realShare,
  trialCountedLimit,
  type TrialMeter,
  type TrialSettingsConfig,
} from "./trials.js";
import type { TrialEmailValues } from "./user-emails.js";
import { DAY_MS } from "./week.js";

type TrialConfig = TrialSettingsConfig & PlanSettingsConfig & { cachedTokenWeight: number; promoPercentOff: number };

// ─── Emails ─────────────────────────────────────────────────────────────────

function limitsText(plan: PlanId, config: PlanSettingsConfig & { cachedTokenWeight: number }): string {
  return planLimits(plan, config)
    .map((limit) => `- ${limit.name} ${approxTokens(limit.realTokens)}/week (${PLAN_MIX_LABEL})`)
    .join("\n");
}

/** The card trial emails' common values: the plan, its price, the launch offer line, the trial's size and end. */
export function cardTrialEmailValues(input: { plan: PlanId; config: TrialConfig; promoEligible: boolean; endsAt: number | null; realLimit?: number }): TrialEmailValues {
  const { plan, config } = input;
  return {
    plan: PLANS[plan].name,
    price: `$${PLANS[plan].priceUsd}/mo`,
    promo: input.promoEligible ? ` (first month ${config.promoPercentOff}% off)` : "",
    tokens: countedText(input.realLimit ?? config.cardTrialTokens),
    ends: input.endsAt === null ? `day ${config.cardTrialDays}` : dayText(input.endsAt),
    limits: limitsText(plan, config),
  };
}

async function sendCardWelcome(c: Ctx, accountNumber: number, plan: PlanId, trial: { promoEligible: boolean; endsAt: number | null; realLimit: number; subscriptionId: string }): Promise<void> {
  const { config } = await runtime(c);
  await userEmail(c, config, "welcome_trial_card", accountNumber, trial.subscriptionId, { trial: cardTrialEmailValues({ plan, config, promoEligible: trial.promoEligible, endsAt: trial.endsAt, realLimit: trial.realLimit }) });
}

/** trial_card_80, once per trial (the chat claims the notice first). */
export async function sendTrial80(c: Ctx, accountNumber: number, trial: TrialMeter): Promise<void> {
  const { config } = await runtime(c);
  if (trial.kind !== "card" || !isPlanId(trial.plan)) return;
  const usedReal = realShare(trial.counted, trial.limit, trial.realLimit);
  await userEmail(c, config, "trial_card_80", accountNumber, trial.subscriptionId ?? "", {
    trial: {
      ...cardTrialEmailValues({ plan: trial.plan, config, promoEligible: trial.promoCoupon !== null, endsAt: trial.endsAt, realLimit: trial.realLimit }),
      share: String(Math.min(99, Math.max(80, Math.floor((trial.counted / Math.max(1, trial.limit)) * 100)))),
      used: approxTokens(usedReal),
      left: approxTokens(Math.max(0, trial.realLimit - usedReal)),
    },
  });
}

// ─── Card trials ────────────────────────────────────────────────────────────

/**
 * A claimed trial Checkout: the Directory's record and the account's meter. One card trial per
 * account: a second one gets a trial of 0 tokens, so its plan starts at the first request (or
 * right here, `convertTrial`). An open no-card trial ends: the plan's trial replaces it.
 */
export async function startCardTrialOnClaim(c: Ctx, accountNumber: number, input: { plan: PlanId; subscriptionId: string; subscription: Record<string, any> | null; startedAt: number; promoEligible?: string }): Promise<void> {
  const { config } = await runtime(c);
  const dir = directory(c);
  const person = account(c, accountNumber);
  const repeat = await dir.hadOtherCardTrial(accountNumber, input.subscriptionId);
  const trial = input.subscription ? subscriptionTrial(input.subscription) : { trialing: true, trialEnd: input.startedAt + config.cardTrialDays * DAY_MS };
  const limit = repeat ? 0 : trialCountedLimit("card", config);
  const realLimit = repeat ? 0 : config.cardTrialTokens;
  const before = await person.trial(c.now());
  if (before && before.kind === "nocard" && before.active) {
    await person.endTrial({ reason: "plan", at: c.now() });
    await dir.endTrial({ account: accountNumber, kind: "nocard", reason: "plan", at: c.now() });
  }
  await dir.recordCardTrial({ subscriptionId: input.subscriptionId, plan: input.plan, limit, startedAt: input.startedAt, endsAt: trial.trialEnd, account: accountNumber });
  const started = await person.startTrial({ kind: "card", limit, realLimit, startedAt: input.startedAt, endsAt: trial.trialEnd, plan: input.plan, subscriptionId: input.subscriptionId, promoCoupon: input.promoEligible ?? null });
  if (repeat) {
    // A second card trial on one account: the plan starts now.
    const task = convertTrial(c, accountNumber).catch(() => "failed");
    if (c.background) c.background(task);
    else await task;
    return;
  }
  if (started) {
    const welcome = sendCardWelcome(c, accountNumber, input.plan, { promoEligible: input.promoEligible !== undefined, endsAt: trial.trialEnd, realLimit, subscriptionId: input.subscriptionId }).catch((error) =>
      console.error("trial: welcome failed", error instanceof Error ? error.message : "error"),
    );
    if (c.background) c.background(welcome);
    else await welcome;
  }
}

/** A plan claimed without a trial: an open no-card trial ends (the plan replaces it). */
export async function endNoCardTrialForPlan(c: Ctx, accountNumber: number): Promise<void> {
  const person = account(c, accountNumber);
  const before = await person.trial(c.now());
  if (before && before.kind === "nocard" && before.active) {
    await person.endTrial({ reason: "plan", at: c.now() });
    await directory(c).endTrial({ account: accountNumber, kind: "nocard", reason: "plan", at: c.now() });
  }
}

/**
 * The card trial is over and the plan started (Stripe charged the first month): the meter
 * closes, the Directory stops projecting it, the GPT-6 launch bonus is granted (paying now),
 * and trial_converted goes out once. `promoPercent`: what the first charge took off, if anything.
 */
export async function finishCardTrial(c: Ctx, accountNumber: number, input: { subscriptionId?: string; promoPercent: number | null; reason?: "used" | "expired" }): Promise<boolean> {
  const person = account(c, accountNumber);
  const trial = await person.trial(c.now());
  if (!trial || trial.kind !== "card") return false;
  const reason = input.reason ?? (trial.usedUp ? "used" : "expired");
  const ended = await person.endTrial({ reason, at: c.now(), ...(input.subscriptionId ? { subscriptionId: input.subscriptionId } : {}) });
  if (!ended) return false;
  await directory(c).endTrial({ ...(trial.subscriptionId ? { subscriptionId: trial.subscriptionId } : { account: accountNumber }), kind: "card", reason, at: c.now() });
  const { config } = await runtime(c);
  const granted = await grantLaunchBonus(c, accountNumber).catch(() => false);
  const plan = isPlanId(trial.plan) ? trial.plan : ((await person.billing()).tier ?? "starter");
  const task = userEmail(c, config, "trial_converted", accountNumber, trial.subscriptionId ?? String(trial.startedAt), {
    trial: {
      plan: PLANS[plan].name,
      price: `$${PLANS[plan].priceUsd}/mo`,
      promo: input.promoPercent ? ` first month ${input.promoPercent}% off.` : "",
      reason: reason === "used" ? `you used your ${countedText(trial.realLimit)} free trial tokens, so your plan started and your card was charged.` : "your free trial ended, so your plan started and your card was charged.",
      limits: limitsText(plan, config),
      bonus: granted ? `plus ${BONUS_LINE}, launch bonus through 31 Jan 2027.\n` : "",
    },
  }).catch(() => "failed");
  if (c.background) c.background(task);
  else await task;
  return true;
}

export type ConversionResult = "converted" | "declined" | "busy" | "failed" | "none";

/**
 * Ends a used card trial in Stripe now (`trial_end=now`): the first real charge happens at once,
 * with the launch offer's coupon when the Checkout was eligible (a refused coupon: the charge
 * goes ahead at full price and the owner is told). One caller at a time; a declined card holds
 * further attempts off for DECLINE_HOLD_MS.
 */
export async function convertTrial(c: Ctx, accountNumber: number): Promise<ConversionResult> {
  const person = account(c, accountNumber);
  const now = c.now();
  const trial = await person.trial(now);
  if (!trial || trial.kind !== "card" || !trial.active) return "none";
  if (declinedRecently(trial, now)) return "declined";
  const billing = await person.billing();
  const subscriptionId = trial.subscriptionId ?? billing.subscriptionId;
  const key = c.config.stripe.secretKey;
  if (!subscriptionId || !key) return "failed";
  if (!(await person.claimTrialConversion(now))) return "busy";
  const end = (coupon: string | undefined) => endTrialNow(c.fetch, key, { subscriptionId, ...(coupon ? { coupon } : {}), idempotencyKey: `trial-end-${subscriptionId}-${coupon ?? "none"}-${Math.floor(now / 60_000)}` });
  let subscription: Record<string, any>;
  let promoApplied = trial.promoCoupon !== null;
  try {
    try {
      subscription = await end(trial.promoCoupon ?? undefined);
    } catch (error) {
      if (!trial.promoCoupon || !isCouponRefusal(error)) throw error;
      promoApplied = false;
      await alert(c, [{ subject: "dl.new: launch offer coupon refused at a trial's first charge", text: `Stripe refused the coupon "${trial.promoCoupon}" when a card trial ended (subscription ${subscriptionId}): ${error instanceof Error ? error.message : "error"}. The first month was charged at full price. Check the coupon has no redeem-by date before the last trial ends.` }]);
      subscription = await end(undefined);
    }
  } catch (error) {
    if (error instanceof StripeError && error.status === 402) {
      await person.releaseTrialConversion(now);
      return "declined";
    }
    await person.releaseTrialConversion();
    console.error("trial: conversion failed", error instanceof StripeError ? error.status : "error");
    return "failed";
  }
  const state = planState(subscription.status);
  await person.applySubscription({ subscriptionId, state, periodEnd: periodEnd(subscription), cancelAtPeriodEnd: subscription.cancel_at_period_end === true, eventAt: Math.floor(now / 1000), trial: subscriptionTrial(subscription), paymentFailed: false });
  await directory(c).mirrorSubscription({ githubId: accountNumber, state, periodEnd: periodEnd(subscription), eventAt: Math.floor(now / 1000) });
  if (subscription.status === "trialing") {
    await person.releaseTrialConversion();
    return "failed";
  }
  const { config } = await runtime(c);
  await finishCardTrial(c, accountNumber, { subscriptionId, promoPercent: promoApplied ? config.promoPercentOff : null, reason: "used" });
  return "converted";
}

/**
 * A subscription event for a claimed plan: the billing row's trial flags follow Stripe, and a
 * trial that is over in Stripe (active, or ended) closes here. `promoPercent` from the invoice
 * when there is one.
 */
export async function trialFromSubscription(c: Ctx, accountNumber: number, subscription: Record<string, any>, deleted: boolean): Promise<void> {
  const person = account(c, accountNumber);
  const trial = await person.trial(c.now());
  if (!trial || trial.kind !== "card" || trial.endedAt !== null) return;
  if (trial.subscriptionId && typeof subscription.id === "string" && subscription.id !== trial.subscriptionId) return;
  if (deleted || subscription.status === "canceled" || subscription.status === "incomplete_expired") {
    if (await person.endTrial({ reason: "canceled", at: c.now() })) await directory(c).endTrial({ ...(trial.subscriptionId ? { subscriptionId: trial.subscriptionId } : { account: accountNumber }), kind: "card", reason: "canceled", at: c.now() });
    return;
  }
  if (subscription.status === "active") {
    const discounted = (Array.isArray(subscription.discounts) && subscription.discounts.length > 0) || (subscription.discount !== null && subscription.discount !== undefined);
    const { config } = await runtime(c);
    await finishCardTrial(c, accountNumber, { subscriptionId: subscription.id, promoPercent: discounted && trial.promoCoupon ? config.promoPercentOff : null });
  }
}

/** invoice.paid with money taken while the account's card trial is open: the plan started. */
export async function trialFromInvoice(c: Ctx, accountNumber: number, invoice: Record<string, any>, subscriptionId: string): Promise<void> {
  const person = account(c, accountNumber);
  const trial = await person.trial(c.now());
  if (!trial || trial.kind !== "card" || trial.endedAt !== null) return;
  if (trial.subscriptionId && trial.subscriptionId !== subscriptionId) return;
  const percent = invoiceDiscountPercent(invoice);
  await person.applySubscription({ subscriptionId, state: "active", periodEnd: undefined, eventAt: Math.floor(c.now() / 1000), trial: { trialing: false, trialEnd: null } });
  await finishCardTrial(c, accountNumber, { subscriptionId, promoPercent: percent > 0 ? percent : null });
}

/**
 * customer.subscription.trial_will_end (3 days before Stripe's 30-day backstop, and when a trial
 * is ended now): a trialing subscription whose Checkout was in the launch offer's window gets
 * the coupon now, so it lands on the first real charge, never on the $0 trial invoice.
 */
export async function trialWillEnd(c: Ctx, subscription: Record<string, any>): Promise<string> {
  const coupon = promoEligible(subscription);
  if (subscription.status !== "trialing" || !coupon || typeof subscription.id !== "string") return "trial_will_end";
  const discounted = (Array.isArray(subscription.discounts) && subscription.discounts.length > 0) || (subscription.discount !== null && subscription.discount !== undefined);
  if (discounted) return "trial_coupon_present";
  const key = c.config.stripe.secretKey;
  if (!key) return "trial_will_end";
  try {
    await attachCoupon(c.fetch, key, { subscriptionId: subscription.id, coupon, idempotencyKey: `trial-coupon-${subscription.id}` });
    return "trial_coupon_attached";
  } catch (error) {
    await alert(c, [{ subject: "dl.new: launch offer coupon not attached before a trial's first charge", text: `Stripe refused the coupon "${coupon}" for subscription ${subscription.id}: ${error instanceof Error ? error.message : "error"}. Its first month will be charged at full price unless you add the coupon in the Stripe Dashboard before the trial ends.` }]);
    return "trial_coupon_failed";
  }
}

// ─── No-card trials ─────────────────────────────────────────────────────────

/** What dl.new/trial's GitHub callback read (AuthObject handoff `details`). */
export interface TrialCheck {
  trial: true;
  level: string;
  batchFlagged: boolean;
  networkLimited: boolean;
}

export function parseTrialCheck(details: string | null): TrialCheck | undefined {
  if (!details) return undefined;
  try {
    const parsed = JSON.parse(details) as Partial<TrialCheck>;
    return parsed.trial === true && typeof parsed.level === "string" ? { trial: true, level: parsed.level, batchFlagged: parsed.batchFlagged === true, networkLimited: parsed.networkLimited === true } : undefined;
  } catch {
    return undefined;
  }
}

export const TRIAL_NOT_ELIGIBLE_MESSAGE = "This GitHub account can't get the no-card trial. Pick a plan at dl.new to start (your first 20M tokens are free with a card).";
export const TRIAL_USED_MESSAGE = "This GitHub account or email already had the no-card trial. Pick a plan at dl.new to keep going.";
export const TRIAL_CLAIMED_MESSAGE = "The no-card trial is fully claimed right now. Pick a plan at dl.new to start.";
export const TRIAL_OFF_MESSAGE = "The no-card trial isn't available right now. Pick a plan at dl.new to start.";

/**
 * The no-card trial for a new GitHub sign-in: the free tier's account checks (the level from the
 * GitHub signals: account age, activity and the creation-batch check; the per-network and
 * per-domain sign-up limits; blocked and disposable emails), then the Directory makes the account
 * and takes the trial in one step (one per GitHub account and per verified email, within the
 * budget). Returns the new account, the existing account for a GitHub sign-in that has one
 * (signed in as usual, no trial), or the refusal (403 trial_unavailable, with `reason`).
 */
export async function noCardTrialSignIn(c: Ctx, input: { githubId: number; login: string; email: string; check: TrialCheck | undefined }): Promise<{ account: number; created: boolean } | Response> {
  const { config } = await runtime(c);
  const refuse = (reason: string, message: string) => apiError(403, "trial_unavailable", message, { reason, plansUrl: "https://dl.new" });
  const dir = directory(c);
  const existing = await dir.resolveIdentity("github", String(input.githubId), c.now());
  if (existing !== undefined) return { account: existing, created: false };
  if (!config.noCardTrial) return refuse("off", TRIAL_OFF_MESSAGE);
  const norm = normalizeEmail(input.email);
  if (!input.check) return refuse("not_eligible", TRIAL_NOT_ELIGIBLE_MESSAGE);
  // The free tier's checks: below the bar (Starter) or batch-flagged, a busy network past its daily sign-ups.
  if (input.check.level === "starter" || input.check.batchFlagged || input.check.networkLimited) return refuse("not_eligible", TRIAL_NOT_ELIGIBLE_MESSAGE);
  if (isDisposableDomain(emailDomain(norm)) || emailBlocked(norm, config.blockedEmails)) return refuse("not_eligible", TRIAL_NOT_ELIGIBLE_MESSAGE);
  if (await dir.emailInUse(norm, 0)) return refuse("used", TRIAL_USED_MESSAGE);
  const domain = emailDomain(norm);
  if (!PUBLIC_EMAIL_DOMAINS.has(domain) && input.check.level !== "full" && (await dir.domainSignupsSince(domain, c.now() - DAY_MS)) >= config.domainSignupsPerDay) return refuse("not_eligible", TRIAL_NOT_ELIGIBLE_MESSAGE);
  const started = await dir.startNoCardTrial({ githubId: input.githubId, login: input.login, email: input.email, emailNorm: norm, config, now: c.now() });
  if (!started.ok) {
    if (started.reason === "existing") return { account: started.account, created: false };
    if (started.reason === "fully_claimed") return refuse("fully_claimed", TRIAL_CLAIMED_MESSAGE);
    if (started.reason === "off") return refuse("off", TRIAL_OFF_MESSAGE);
    return refuse("used", TRIAL_USED_MESSAGE);
  }
  const person = account(c, started.account);
  const stored = await dir.getPerson(started.account);
  await person.activate({ githubId: started.account, login: stored?.login ?? input.login, isAdmin: false, now: c.now() });
  await person.startTrial({ kind: "nocard", limit: started.limit, realLimit: config.noCardTrialTokens, startedAt: c.now(), endsAt: null });
  await spendTrialSignup(c);
  const welcome = userEmail(c, config, "welcome_trial_nocard", started.account, "", { trial: { tokens: countedText(config.noCardTrialTokens) } }).catch(() => "failed");
  if (c.background) c.background(welcome);
  else await welcome;
  return { account: started.account, created: true };
}
