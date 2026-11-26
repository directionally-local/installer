import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, completion, createService, luminalUsage, MODEL, type Service } from "./harness.js";
import { DL, emailSignIn, FakeStripe, githubRoundTrip, PAGE_STATE, PAID_VARS, webhook } from "./paid-fixtures.js";
import { parseAccountId } from "../src/accounts.js";
import { readFreeConfig } from "../src/config.js";
import { cardTrialLine, noCardTrialLine, noCardUsedUpMessage, trialCountedLimit, trialWarningNotice, TRIAL_DEFAULTS } from "../src/trials.js";
import { planCheckoutParams } from "../src/stripe.js";

/**
 * dl.new's free trials (trials.ts, trial-web.ts): a card trial on every plan (20M tokens at
 * 95.5% caching free, the plan starts when they're used or after 30 days, the launch offer's
 * coupon on the first real charge) and a no-card trial after GitHub (10M, one per GitHub account
 * and email, the free tier's account checks), each within its global budget.
 */

const KIMI = "moonshotai/kimi-k3.1-pro";
const INSIDE = Date.UTC(2026, 10, 28, 15); // the launch offer's window
const AFTER = Date.UTC(2026, 11, 2, 12); // after it
const KEYS = { OPENAI_API_KEY: "sk-openai-test", LIQUID_INFERENCE_API_KEY: "sk-liquid", LIQUID_STATUS: "on", DL_ONLY: "false", SPEED_PROBES: "false" };
// One request of luminalUsage(4000, 10, 3800) counts 200 + 76 + 10 = 286. A 5,000-token trial
// (95.5% caching applied) is 321 counted: the second request uses it up.
const SMALL = { CARD_TRIAL_TOKENS: "5000", NO_CARD_TRIAL_TOKENS: "5000" };

async function world(vars: Record<string, string> = {}, now = INSIDE) {
  const service = await createService({ ...PAID_VARS, ...KEYS, PAID_PLANS: "true", ALERT_EMAIL_TO: "owner@example.com", ...vars }, { userEmail: true, email: true });
  service.clock.now = now;
  service.setLuminal(() => completion(luminalUsage(4_000, 10, 3_800)));
  return { service, stripe: new FakeStripe(service) };
}

async function plans(service: Service): Promise<Record<string, any>> {
  const response = await service.request("GET", "/web/plans", { headers: DL });
  assert.equal(response.status, 200);
  return (await response.json()) as Record<string, any>;
}

async function startCheckout(service: Service, plan = "starter"): Promise<{ sessionId: string; trial: boolean }> {
  const response = await service.request("POST", "/web/checkout/plan", { body: { plan }, headers: DL });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as { sessionId: string; trial: boolean };
}

/** Pay → trial → email sign-up: the claimed trial account, its web token and an API key. */
async function trialAccount(service: Service, stripe: FakeStripe, plan = "starter", email = "tess@example.com") {
  const { sessionId, trial } = await startCheckout(service, plan);
  assert.equal(trial, true);
  stripe.startTrial(sessionId, email);
  const signedIn = await emailSignIn(service, email, sessionId);
  await service.settle();
  const token = signedIn.token;
  const made = await service.request("POST", "/web/api-keys", { token, body: { name: "cc" }, headers: DL });
  assert.equal(made.status, 201, await made.clone().text());
  const subscriptionId = stripe.sessions.get(sessionId)!.subscription!;
  return { account: parseAccountId(signedIn.account.accountId)!, token, key: ((await made.json()) as { key: string }).key, signedIn, sessionId, subscriptionId };
}

const chat = (service: Service, key: string, model = MODEL) => service.request("POST", "/v1/chat/completions", { token: key, body: { model, messages: [{ role: "user", content: "hello" }] } });

async function content(response: Response): Promise<string> {
  return ((await response.json()) as any).choices[0].message.content as string;
}

async function account(service: Service, token: string): Promise<Record<string, any>> {
  return (await (await service.request("GET", "/web/account", { token, headers: DL })).json()) as Record<string, any>;
}

function emailsTo(service: Service, to: string): Array<{ subject: string; text: string }> {
  return service.calls.userEmail.filter((entry) => entry.to === to).map((entry) => ({ subject: String(entry.subject), text: String(entry.text) }));
}

function trialEnds(stripe: FakeStripe): Array<{ id: string; form: URLSearchParams }> {
  return stripe.updates.filter((update) => update.form.get("trial_end") === "now");
}

async function admin(service: Service): Promise<string> {
  return (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
}

const config = readFreeConfig({ TOKEN_SIGNING_KEY: "x".repeat(32), OPENROUTER_API_KEY: "k", GITHUB_CLIENT_ID: "i", GITHUB_CLIENT_SECRET: "s" });

describe("trials: the numbers and the copy", () => {
  it("sizes trials in real tokens at 95.5% caching and enforces them in counted tokens", () => {
    assert.deepEqual(
      { cardTrialTokens: config.cardTrialTokens, noCardTrialTokens: config.noCardTrialTokens, cardTrialDays: config.cardTrialDays, trialBudgetUsd: config.trialBudgetUsd, noCardTrialBudgetUsd: config.noCardTrialBudgetUsd },
      { cardTrialTokens: 20_000_000, noCardTrialTokens: 10_000_000, cardTrialDays: 30, trialBudgetUsd: 300, noCardTrialBudgetUsd: 200 },
    );
    assert.equal(TRIAL_DEFAULTS.cardTrial && TRIAL_DEFAULTS.noCardTrial, true);
    assert.equal(trialCountedLimit("card", config), 1_282_000);
    assert.equal(trialCountedLimit("nocard", config), 641_000);
  });

  it("says exactly what the owner wrote", () => {
    assert.equal(cardTrialLine(config), "First 20M tokens free (95.5% caching applied). Card required; your plan starts when you've used them or after 30 days.");
    assert.equal(noCardTrialLine(config), "No card? Get 10M tokens free (95.5% caching applied). Sign in with GitHub.");
    assert.equal(noCardUsedUpMessage(10_000_000), "Your 10M free tokens are used up. Pick a plan at dl.new to keep going.");
    assert.equal(
      trialWarningNotice({ kind: "card", counted: 1_040_000, limit: 1_282_000, realLimit: 20_000_000, planName: "Starter" }),
      "Free trial: 81% used (~16.2M of 20M at 95.5% caching). Your Starter plan starts at 20M, ~3.8M left.",
    );
    assert.equal(trialWarningNotice({ kind: "nocard", counted: 520_000, limit: 641_000, realLimit: 10_000_000 }), "Free trial: 81% used (~8.1M of 10M at 95.5% caching), ~1.9M left. Pick a plan at dl.new to keep going.");
  });

  it("shows both trials on /web/plans and /v1/plans", async () => {
    const { service } = await world();
    const body = await plans(service);
    assert.deepEqual(body.trials.card, {
      enabled: true,
      available: true,
      fullyClaimed: false,
      tokens: 20_000_000,
      countedTokens: 1_282_000,
      days: 30,
      line: "First 20M tokens free (95.5% caching applied). Card required; your plan starts when you've used them or after 30 days.",
      fullyClaimedText: "Free trial: fully claimed",
    });
    assert.equal(body.trials.noCard.line, "No card? Get 10M tokens free (95.5% caching applied). Sign in with GitHub.");
    assert.equal(body.trials.noCard.available, true);
    const pub = (await (await service.request("GET", "/v1/plans")).json()) as any;
    assert.equal(pub.trials.card.countedTokens, 1_282_000);
  });
});

describe("trials: the card trial's Checkout", () => {
  it("collects the card, charges $0 for 30 days, cancels without a card, and puts the launch coupon on it for the first paid month", async () => {
    const { service, stripe } = await world();
    const { sessionId, trial } = await startCheckout(service, "plus");
    assert.equal(trial, true);
    const form = stripe.sessions.get(sessionId)!.form;
    assert.equal(form.get("subscription_data[trial_period_days]"), "30");
    assert.equal(form.get("subscription_data[trial_settings][end_behavior][missing_payment_method]"), "cancel");
    assert.equal(form.get("payment_method_collection"), "always");
    // The coupon is on the trial Checkout, so the page shows the discounted first paid month
    // (Stripe keeps a duration-once coupon for the first invoice after the trial).
    assert.equal(form.get("discounts[0][coupon]"), "dlnew-bf-2026");
    assert.equal(form.get("allow_promotion_codes"), null, "Stripe takes discounts or allow_promotion_codes, never both");
    assert.equal(form.get("metadata[promo]"), "dlnew-bf-2026");
    assert.equal(form.get("metadata[promo_eligible]"), "dlnew-bf-2026");
    assert.equal(form.get("subscription_data[metadata][promo_eligible]"), "dlnew-bf-2026");
    assert.equal(form.get("subscription_data[metadata][trial]"), "card");
    // The line above the button says when the discounted month comes.
    const offer = form.get("custom_text[submit][message]");
    assert.equal(offer, "Launch offer: your first paid month is 50% off ($10 instead of $20). It's applied when your free 20M tokens are used or after 30 days.");
    assert.ok(offer!.length <= 1200);
    assert.equal(form.get("consent_collection[terms_of_service]"), "required", "the terms consent stays");
    assert.ok(form.get("custom_text[terms_of_service_acceptance][message]"));
  });

  it("names the plan's own prices in the offer line", async () => {
    const { service, stripe } = await world();
    const { sessionId } = await startCheckout(service, "starter");
    assert.equal(
      stripe.sessions.get(sessionId)!.form.get("custom_text[submit][message]"),
      "Launch offer: your first paid month is 50% off ($3.50 instead of $7). It's applied when your free 20M tokens are used or after 30 days.",
    );
  });

  it("shows no offer line on a trial Checkout outside the offer's window", async () => {
    const { service, stripe } = await world({}, AFTER);
    const { sessionId, trial } = await startCheckout(service, "starter");
    assert.equal(trial, true);
    const form = stripe.sessions.get(sessionId)!.form;
    assert.equal(form.get("custom_text[submit][message]"), null);
    assert.equal(form.get("discounts[0][coupon]"), null);
    assert.equal(form.get("allow_promotion_codes"), "false");
    assert.ok(form.get("custom_text[terms_of_service_acceptance][message]"));
  });

  it("records no eligibility outside the offer's window", () => {
    const params = planCheckoutParams({ plan: "starter", price: "price_x", successUrl: "https://dl.new/account", cancelUrl: "https://dl.new/", trial: { days: 30 } }) as any;
    assert.equal(params.subscription_data.metadata.promo_eligible, undefined);
    assert.equal(params.discounts, undefined);
  });

  it("is a plain paid Checkout (coupon on it in the window) once the card trial budget is fully claimed", async () => {
    const { service, stripe } = await world({ TRIAL_BUDGET_USD: "0.1" });
    const body = await plans(service);
    assert.equal(body.trials.card.fullyClaimed, true);
    assert.equal(body.trials.card.available, false);
    const { sessionId, trial } = await startCheckout(service);
    assert.equal(trial, false);
    const form = stripe.sessions.get(sessionId)!.form;
    assert.equal(form.get("subscription_data[trial_period_days]"), null);
    assert.equal(form.get("discounts[0][coupon]"), "dlnew-bf-2026");
  });

  it("is off with cardTrial false", async () => {
    const { service } = await world({ CARD_TRIAL: "false" });
    const body = await plans(service);
    assert.equal(body.trials.card.enabled, false);
    assert.equal(body.trials.card.available, false);
    assert.equal(body.trials.card.fullyClaimed, false);
    assert.equal((await startCheckout(service)).trial, false);
  });
});

describe("trials: a card trial in use", () => {
  it("claims the $0 Checkout, shows the trial meter, sends the trial welcome, and records no payment", async () => {
    const { service, stripe } = await world();
    const { token, signedIn } = await trialAccount(service, stripe, "starter");
    assert.equal(signedIn.claimed?.plan, "starter");
    const me = await account(service, token);
    assert.equal(me.plan.id, "starter");
    assert.equal(me.plan.trialing, true);
    assert.equal(me.plan.trialEndsAt, new Date(INSIDE - (INSIDE % 1000) + 30 * 86_400_000).toISOString());
    assert.equal(me.trial.kind, "card");
    assert.equal(me.trial.status, "active");
    assert.equal(me.trial.tokens, 20_000_000);
    assert.equal(me.trial.countedLimit, 1_282_000);
    assert.equal(me.trial.daysLeft, 30);
    const welcome = emailsTo(service, "tess@example.com").find((m) => m.subject !== "Your dl.new code");
    assert.equal(welcome!.subject, "your dl.new key is ready");
    assert.match(welcome!.text, /your first 20M tokens are free \(95\.5% caching applied\)/);
    assert.match(welcome!.text, /your card is charged \$7\/mo \(first month 50% off\), when you've used the 20M or on 28 dec/);
    const checkouts = (await (await service.request("GET", "/admin/paid/checkouts?status=all", { token: await admin(service) })).json()) as any;
    assert.deepEqual(checkouts.checkouts[0].trial, { promoEligible: "dlnew-bf-2026" });
    assert.equal(checkouts.checkouts[0].amountCents, 0);
  });

  it("serves DeepSeek only during the trial: Kimi falls back with 'starts when your plan starts', and plan bars stay at 0", async () => {
    const { service, stripe } = await world();
    const { token, key } = await trialAccount(service, stripe, "plus");
    const kimi = await chat(service, key, KIMI);
    assert.equal(kimi.status, 200, await kimi.clone().text());
    assert.match(kimi.headers.get("x-dl-notice") ?? "", /Kimi K3\.1 starts when your plan starts\. Now using DeepSeek V4\.1 Flash\./);
    assert.match(await content(kimi), /^\[dl\.new\] Kimi K3\.1 starts when your plan starts\./);
    assert.equal(kimi.headers.get("x-dl-fallback"), null);
    const me = await account(service, token);
    assert.equal(me.trial.countedUsed, 286);
    assert.equal(me.limits[0].countedUsed, 0, "trial usage never counts against the plan's week");
    const week = (await (await service.request("GET", "/web/usage", { token, headers: DL })).json()) as any;
    assert.equal(week.trial.countedUsed, 286);
    assert.equal(week.totals.countedTokens, 286);
    const budgets = (await (await service.request("GET", "/admin/paid/trials", { token: await admin(service) })).json()) as any;
    assert.equal(budgets.budgets.card.trials, 1);
    assert.equal(budgets.trials[0].counted, 286);
  });

  it("starts the plan when the trial is used up: trial_end=now with the launch coupon on the first real charge, the 80% notice and the emails", async () => {
    const { service, stripe } = await world(SMALL);
    const { token, key, subscriptionId } = await trialAccount(service, stripe, "plus");
    assert.equal((await chat(service, key)).status, 200);
    const second = await chat(service, key);
    assert.equal(second.status, 200);
    assert.match(await content(second), /^\[dl\.new\] Free trial: 89% used \(~4\.5K of 5K at 95\.5% caching\)\. Your Plus plan starts at 5K, ~545 left\./);
    await service.settle();
    const ends = trialEnds(stripe);
    assert.equal(ends.length, 1, "Stripe ends the trial once");
    assert.equal(ends[0]!.id, subscriptionId);
    assert.equal(ends[0]!.form.get("discounts[0][coupon]"), "dlnew-bf-2026");
    assert.equal(ends[0]!.form.get("payment_behavior"), "error_if_incomplete");
    const me = await account(service, token);
    assert.equal(me.trial, null);
    assert.equal(me.plan.trialing, false);
    // Kimi now: the plan has started.
    const kimi = await chat(service, key, KIMI);
    assert.equal(kimi.status, 200);
    assert.equal(kimi.headers.get("x-dl-notice"), null);
    const mail = emailsTo(service, "tess@example.com");
    assert.ok(mail.some((m) => m.subject === "your free trial is 89% used" && /your plan starts at 5K, ~545 left/.test(m.text)), JSON.stringify(mail.map((m) => m.subject)));
    const started = mail.find((m) => m.subject === "your dl.new plan started")!;
    assert.match(started.text, /your plan started: dl\.new Plus, \$20\/mo\. first month 50% off\./);
    assert.match(started.text, /you used your 5K free trial tokens/);
    // The webhooks that follow don't send it again.
    await webhook(service, "customer.subscription.updated", stripe.subscriptionObject(stripe.subscriptions.get(subscriptionId)!));
    assert.equal(emailsTo(service, "tess@example.com").filter((m) => m.subject === "your dl.new plan started").length, 1);
  });

  it("puts no coupon on the first charge when the Checkout was outside the window", async () => {
    const { service, stripe } = await world(SMALL, AFTER);
    const { key } = await trialAccount(service, stripe);
    await chat(service, key);
    await chat(service, key);
    await service.settle();
    assert.equal(trialEnds(stripe)[0]!.form.get("discounts[0][coupon]"), null);
  });

  it("refuses with a clear error when the first real charge is declined, without asking Stripe again at once", async () => {
    const { service, stripe } = await world(SMALL);
    const { key } = await trialAccount(service, stripe);
    stripe.declineTrialEnd = true;
    await chat(service, key);
    await chat(service, key);
    await service.settle();
    const refused = await chat(service, key);
    assert.equal(refused.status, 402);
    const body = (await refused.json()) as any;
    assert.equal(body.error.code, "trial_payment_failed");
    assert.match(body.error.message, /Update your card at dl\.new\/billing/);
    const calls = trialEnds(stripe).length;
    await chat(service, key);
    assert.equal(trialEnds(stripe).length, calls, "held off after a decline");
  });

  it("ends by Stripe's 30-day backstop: trial_will_end puts the coupon on the subscription, the plan starts on the webhooks", async () => {
    const { service, stripe } = await world();
    const { token, subscriptionId } = await trialAccount(service, stripe, "starter");
    const subscription = stripe.subscriptions.get(subscriptionId)!;
    const willEnd = await webhook(service, "customer.subscription.trial_will_end", stripe.subscriptionObject(subscription));
    assert.equal(willEnd.body.outcome, "plan_trial_coupon_attached");
    assert.deepEqual(subscription.discounts, ["dlnew-bf-2026"]);
    // A $0 trial invoice is no payment.
    const zero = await webhook(service, "invoice.paid", { id: "in_trial_x", customer: subscription.customer, billing_reason: "subscription_create", amount_paid: 0, total: 0, subscription: subscriptionId, lines: { data: [{ price: { id: subscription.price }, period: { end: subscription.trial_end } }] } });
    assert.equal(zero.body.outcome, "plan_trial_invoice");
    assert.equal((await account(service, token)).trial.status, "active");
    // Day 30: Stripe charges the first month (with the coupon) and the subscription is active.
    service.clock.now += 30 * 86_400_000;
    subscription.status = "active";
    subscription.trial_end = null;
    await webhook(service, "invoice.paid", { id: "in_first_real", customer: subscription.customer, billing_reason: "subscription_cycle", amount_paid: 350, total: 350, subtotal: 700, total_discount_amounts: [{ amount: 350 }], subscription: subscriptionId, lines: { data: [{ price: { id: subscription.price }, period: { end: Math.floor(service.clock.now / 1000) + 30 * 86_400 } }] } });
    await webhook(service, "customer.subscription.updated", stripe.subscriptionObject(subscription));
    await service.settle();
    // The 7-day web session has expired by now: sign in again.
    const me = (await emailSignIn(service, "tess@example.com")).account;
    assert.equal(token.length > 0, true);
    assert.equal(me.trial, null);
    assert.equal(me.plan.status, "active");
    const started = emailsTo(service, "tess@example.com").filter((m) => m.subject === "your dl.new plan started");
    assert.equal(started.length, 1);
    assert.match(started[0]!.text, /first month 50% off\./);
    assert.match(started[0]!.text, /your free trial ended/);
    assert.equal(trialEnds(stripe).length, 0, "Stripe ended it, not us");
  });

  it("gives a second card trial on one account no free tokens: its plan starts at once", async () => {
    const { service, stripe } = await world();
    const first = await trialAccount(service, stripe, "starter", "twice@example.com");
    // Cancel the first, then pay again from the same account.
    stripe.subscriptions.get(first.subscriptionId)!.status = "canceled";
    await webhook(service, "customer.subscription.deleted", stripe.subscriptionObject(stripe.subscriptions.get(first.subscriptionId)!));
    const { sessionId } = await startCheckout(service, "starter");
    stripe.startTrial(sessionId, "twice@example.com");
    const claimed = await service.request("POST", "/web/checkout/claim", { token: first.token, body: { sessionId }, headers: DL });
    assert.equal(claimed.status, 200, await claimed.clone().text());
    assert.equal(((await claimed.json()) as any).claimed.trial, "repeat", "the claim says the plan started without a trial");
    await service.settle();
    assert.equal(trialEnds(stripe).length, 1);
    assert.equal(trialEnds(stripe)[0]!.id, stripe.sessions.get(sessionId)!.subscription);
    const started = emailsTo(service, "twice@example.com").filter((m) => m.subject === "your dl.new plan started");
    assert.equal(started.length, 1);
    assert.match(started[0]!.text, /your dl\.new account already had its free trial \(one per account\), so this plan started when you set it up and your card was charged\./);
    assert.doesNotMatch(started[0]!.text, /you used your 0/);
  });

  it("offers no trial at Checkout to a signed-in account that had one", async () => {
    const { service, stripe } = await world();
    const first = await trialAccount(service, stripe, "starter", "again@example.com");
    const signedIn = await service.request("POST", "/web/checkout/plan", { token: first.token, body: { plan: "plus" }, headers: DL });
    assert.equal(signedIn.status, 200, await signedIn.clone().text());
    const { sessionId, trial } = (await signedIn.json()) as { sessionId: string; trial: boolean };
    assert.equal(trial, false);
    assert.equal(stripe.sessions.get(sessionId)!.form.get("subscription_data[trial_period_days]"), null);
    // Signed out, or a bad token: the trial is offered as before.
    assert.equal((await startCheckout(service, "plus")).trial, true);
    const stale = await service.request("POST", "/web/checkout/plan", { token: "not-a-token", body: { plan: "plus" }, headers: DL });
    assert.equal(((await stale.json()) as any).trial, true);
  });

  it("promises no free tokens before the claim: the claim email says a repeat trial's plan starts at setup", async () => {
    const { service, stripe } = await world();
    const { sessionId } = await startCheckout(service, "starter");
    const session = stripe.startTrial(sessionId, "anon@example.com");
    await webhook(service, "checkout.session.completed", stripe.sessionObject(session, false));
    const claim = emailsTo(service, "anon@example.com").find((m) => m.subject === "Finish setting up dl.new")!;
    assert.ok(claim);
    assert.doesNotMatch(claim.text, /has started/);
    assert.match(claim.text, /on a first dl\.new trial, the first 20M tokens are free/);
    assert.match(claim.text, /One free trial per account: if your dl\.new account already had one, your plan starts when you finish setting up, and your card is charged then\./);
  });

  it("tells the owner when a repeat trial's plan doesn't start, and the next request starts it", async () => {
    const { service, stripe } = await world();
    const first = await trialAccount(service, stripe, "starter", "retry@example.com");
    stripe.subscriptions.get(first.subscriptionId)!.status = "canceled";
    await webhook(service, "customer.subscription.deleted", stripe.subscriptionObject(stripe.subscriptions.get(first.subscriptionId)!));
    const { sessionId } = await startCheckout(service, "starter");
    stripe.startTrial(sessionId, "retry@example.com");
    stripe.failTrialEnd = true;
    const errors = console.error;
    console.error = () => {};
    try {
      const claimed = await service.request("POST", "/web/checkout/claim", { token: first.token, body: { sessionId }, headers: DL });
      assert.equal(claimed.status, 200, await claimed.clone().text());
      await service.settle();
    } finally {
      console.error = errors;
    }
    assert.ok(service.calls.emails.some((message) => message.raw.includes("Subject: dl.new: a repeat card trial's plan didn't start")));
    const subscriptionId = stripe.sessions.get(sessionId)!.subscription!;
    assert.equal(stripe.subscriptions.get(subscriptionId)!.status, "trialing");
    // Stripe answers again: the next request starts the plan.
    stripe.failTrialEnd = false;
    service.clock.now += 60_000;
    assert.equal((await chat(service, first.key)).status, 200);
    await service.settle();
    assert.equal(stripe.subscriptions.get(subscriptionId)!.status, "active");
  });
});

describe("trials: the no-card trial", () => {
  async function noCard(service: Service, user: { id: number; login: string; email?: string; createdAt?: string; publicRepos?: number }) {
    const fragment = await githubRoundTrip(service, user, "https://dl.new/trial");
    assert.match(fragment, /^signin=/);
    return service.request("POST", "/web/auth/github/session", { body: { code: fragment.slice("signin=".length), state: PAGE_STATE, trial: true }, headers: DL });
  }

  it("starts after GitHub: a dl.new account with 10M tokens of DeepSeek, its welcome, a key, and the meter", async () => {
    const { service } = await world();
    const response = await noCard(service, { id: 7001, login: "nocard", email: "nocard@example.com" });
    assert.equal(response.status, 200, await response.clone().text());
    const body = (await response.json()) as any;
    assert.equal(body.created, true);
    assert.equal(body.trialStarted, true);
    assert.equal(body.account.plan, null);
    assert.equal(body.account.trial.kind, "no_card");
    assert.equal(body.account.trial.tokens, 10_000_000);
    assert.equal(body.account.trial.countedLimit, 641_000);
    await service.settle();
    const welcome = emailsTo(service, "nocard@example.com").find((m) => m.subject !== "Your dl.new code");
    assert.equal(welcome!.subject, "your dl.new key is ready");
    assert.match(welcome!.text, /10M tokens of deepseek v4\.1 flash \(95\.5% caching applied\), no card needed/);
    const made = await service.request("POST", "/web/api-keys", { token: body.token, body: { name: "cc" }, headers: DL });
    assert.equal(made.status, 201, await made.clone().text());
    const key = ((await made.json()) as { key: string }).key;
    const kimi = await chat(service, key, KIMI);
    assert.equal(kimi.status, 200, await kimi.clone().text());
    assert.match(kimi.headers.get("x-dl-notice") ?? "", /Kimi K3\.1 isn't in the free trial\. Now using DeepSeek V4\.1 Flash\./);
  });

  it("stops at its size with the owner's message, after the 80% notice in the tool", async () => {
    const { service } = await world(SMALL);
    const body = (await (await noCard(service, { id: 7002, login: "small", email: "small@example.com" })).json()) as any;
    const key = ((await (await service.request("POST", "/web/api-keys", { token: body.token, body: { name: "cc" }, headers: DL })).json()) as { key: string }).key;
    assert.equal((await chat(service, key)).status, 200);
    const second = await chat(service, key);
    assert.match(await content(second), /^\[dl\.new\] Free trial: 89% used \(~4\.5K of 5K at 95\.5% caching\), ~545 left\. Pick a plan at dl\.new to keep going\./);
    await service.settle();
    const third = await chat(service, key);
    assert.equal(third.status, 402);
    assert.deepEqual(((await third.json()) as any).error.message, "Your 5K free tokens are used up. Pick a plan at dl.new to keep going.");
    const me = await account(service, body.token);
    assert.equal(me.trial.status, "used_up");
  });

  it("is one per GitHub account and per verified email", async () => {
    const { service } = await world();
    const first = (await (await noCard(service, { id: 7003, login: "one", email: "one@example.com" })).json()) as any;
    // The same GitHub account signs in again: its account, no second trial.
    const again = (await (await noCard(service, { id: 7003, login: "one", email: "one@example.com" })).json()) as any;
    assert.equal(again.account.accountId, first.account.accountId);
    assert.equal(again.created, false);
    // Another GitHub account with the same verified email.
    const other = await noCard(service, { id: 7004, login: "two", email: "one@example.com" });
    assert.equal(other.status, 403);
    assert.deepEqual([((await other.json()) as any).error.code], ["trial_unavailable"]);
  });

  it("keeps the free tier's account checks: below the bar, disposable email", async () => {
    const { service } = await world();
    const young = await noCard(service, { id: 7005, login: "young", email: "young@example.com", createdAt: "2026-11-20T00:00:00Z", publicRepos: 0 });
    assert.equal(young.status, 403);
    assert.equal(((await young.json()) as any).error.reason, "not_eligible");
    const disposable = await noCard(service, { id: 7006, login: "temp", email: "temp@mailinator.com" });
    assert.equal(disposable.status, 403);
  });

  it("is refused once its budget is fully claimed, and /web/plans says so", async () => {
    const { service } = await world({ NO_CARD_TRIAL_BUDGET_USD: "0.05" });
    assert.equal((await plans(service)).trials.noCard.fullyClaimed, true);
    const response = await noCard(service, { id: 7007, login: "late", email: "late@example.com" });
    assert.equal(response.status, 403);
    const error = ((await response.json()) as any).error;
    assert.equal(error.reason, "fully_claimed");
    assert.match(error.message, /fully claimed/);
  });

  it("leaves a free-tier account from before the launch as it is: signed in, no trial", async () => {
    const { service } = await world();
    await service.signIn({ id: 7008, login: "legacy" });
    const response = await noCard(service, { id: 7008, login: "legacy", email: "legacy@example.com" });
    assert.equal(response.status, 200);
    const body = (await response.json()) as any;
    assert.equal(body.created, false);
    assert.equal(body.account.trial, null);
    assert.deepEqual(body.account.legacy, { plan: "free" });
  });

  it("ends when the account picks a plan (without a trial)", async () => {
    const { service, stripe } = await world({ CARD_TRIAL: "false" });
    const body = (await (await noCard(service, { id: 7009, login: "upgrader", email: "up@example.com" })).json()) as any;
    const { sessionId } = await startCheckout(service, "starter");
    stripe.pay(sessionId, "up@example.com");
    const claimed = await service.request("POST", "/web/checkout/claim", { token: body.token, body: { sessionId }, headers: DL });
    assert.equal(claimed.status, 200, await claimed.clone().text());
    const me = await account(service, body.token);
    assert.equal(me.trial, null);
    assert.equal(me.plan.id, "starter");
  });
});
