import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createService, type Service } from "./harness.js";
import { buy, DL, emailSignIn, FakeStripe, PAID_VARS, PRICES, WEBHOOK_SECRET } from "./paid-fixtures.js";
import { parseAccountId } from "../src/accounts.js";
import type { StripeEvent } from "../src/stripe.js";

// After the harness: the module reaches app.ts, which needs its cloudflare: stubs.
const { ownerPaymentAlert } = await import("../src/owner-payment-alerts.js");

/**
 * The owner's email about dl.new plan money: card trial started, paid, plan changed, cancelled,
 * ended. One per Stripe event id; a failed email never fails the webhook.
 */

async function world(vars: Record<string, string> = {}) {
  const service = await createService({ ...PAID_VARS, ALERT_EMAIL_TO: "owner@example.com", ...vars }, { userEmail: true, email: true });
  const stripe = new FakeStripe(service);
  return { service, stripe };
}

/** POSTs a signed Stripe event, with `previous_attributes` when given. */
async function send(service: Service, type: string, object: Record<string, unknown>, id: string, previous?: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const { signatureHeader } = await import("../src/stripe.js");
  const created = Math.floor(service.clock.now / 1000);
  const body = JSON.stringify({ id, object: "event", type, created, data: { object, ...(previous ? { previous_attributes: previous } : {}) } });
  const response = await service.request("POST", "/v1/billing/webhook", { body, headers: { "stripe-signature": await signatureHeader(WEBHOOK_SECRET, created, body) } });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** The owner's alert emails, decoded. */
function mails(service: Service): Array<{ subject: string; body: string }> {
  return service.calls.emails.map((message) => {
    const [head, body = ""] = message.raw.split("\r\n\r\n");
    return { subject: /^Subject: (.*)$/m.exec(head!)?.[1] ?? "", body: Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8") };
  });
}

async function startTrial(service: Service, stripe: FakeStripe, plan: "starter" | "plus" | "max", email: string) {
  const response = await service.request("POST", "/web/checkout/plan", { body: { plan }, headers: DL });
  assert.equal(response.status, 200, await response.clone().text());
  return stripe.startTrial(((await response.json()) as { sessionId: string }).sessionId, email);
}

const PRICE_MAP = { starter: PRICES.starter, plus: PRICES.plus, max: PRICES.max };
const event = (type: string, object: Record<string, unknown>, previous?: Record<string, unknown>): StripeEvent => ({ id: `evt_${type}`, type, created: 1_800_000_000, data: { object, ...(previous ? { previous_attributes: previous } : {}) } });
const facts = { email: "pat@example.com", account: undefined };

describe("owner payment alerts: which events and what they say", () => {
  it("a paid Checkout: plan, amount, currency, discount, customer, Stripe ids", () => {
    const message = ownerPaymentAlert(
      event("checkout.session.completed", { id: "cs_1", customer: "cus_1", subscription: "sub_1", payment_status: "paid", currency: "usd", amount_subtotal: 2000, amount_total: 1000, total_details: { amount_discount: 1000, amount_tax: 0 }, discounts: [{ coupon: "dlnew-bf-2026" }], metadata: { product: "plan", plan: "plus", promo: "dlnew-bf-2026" } }),
      PRICE_MAP,
      facts,
    )!;
    assert.equal(message.subject, "dl.new: new Plus subscription ($10 first month)");
    assert.match(message.text, /Plan: Plus \(\$20\/month\)/);
    assert.match(message.text, /Amount: \$10 USD \(subtotal \$20, discount \$10, tax \$0\)/);
    assert.match(message.text, /Discount: dlnew-bf-2026/);
    assert.match(message.text, /Customer: pat@example\.com/);
    assert.match(message.text, /Account: not set up yet/);
    assert.match(message.text, /Stripe: event evt_checkout\.session\.completed, checkout cs_1, subscription sub_1, customer cus_1/);
  });

  it("a card trial Checkout, an unpaid Checkout and other products", () => {
    const trial = ownerPaymentAlert(event("checkout.session.completed", { id: "cs_2", payment_status: "no_payment_required", amount_total: 0, metadata: { product: "plan", plan: "starter", trial: "card", promo_eligible: "dlnew-bf-2026" } }), PRICE_MAP, { email: null, account: 2 ** 50 + 7 })!;
    assert.equal(trial.subject, "dl.new: card trial started (Starter)");
    assert.match(trial.text, /Discount: launch offer dlnew-bf-2026 on the first charge/);
    assert.match(trial.text, /Customer: unknown/);
    assert.match(trial.text, /Account: acct_/);
    assert.equal(ownerPaymentAlert(event("checkout.session.completed", { payment_status: "unpaid", metadata: { product: "plan", plan: "plus" } }), PRICE_MAP, facts), undefined);
    assert.equal(ownerPaymentAlert(event("checkout.session.completed", { payment_status: "paid", metadata: { product: "topup" } }), PRICE_MAP, facts), undefined);
  });

  it("invoice.paid: money taken after the first invoice (renewal, trial conversion), never $0 or the Checkout's own", () => {
    const invoice = (extra: Record<string, unknown>) => ({ id: "in_1", customer: "cus_1", currency: "usd", subtotal: 6000, amount_paid: 6000, total_discount_amounts: [], lines: { data: [{ price: { id: PRICES.max } }] }, parent: { subscription_details: { subscription: "sub_1", metadata: {} } }, ...extra });
    const renewal = ownerPaymentAlert(event("invoice.paid", invoice({ billing_reason: "subscription_cycle" })), PRICE_MAP, facts)!;
    assert.equal(renewal.subject, "dl.new: payment ($60, Max renewal)");
    assert.match(renewal.text, /invoice in_1, subscription sub_1, customer cus_1/);
    const discounted = ownerPaymentAlert(event("invoice.paid", invoice({ billing_reason: "subscription_update", amount_paid: 3000, total_discount_amounts: [{ amount: 3000 }], discounts: [{ coupon: { id: "dlnew-bf-2026", percent_off: 50 } }] })), PRICE_MAP, facts)!;
    assert.equal(discounted.subject, "dl.new: payment ($30, Max plan change or trial end)");
    assert.match(discounted.text, /Discount: dlnew-bf-2026 \(50% off\)/);
    assert.equal(ownerPaymentAlert(event("invoice.paid", invoice({ billing_reason: "subscription_create" })), PRICE_MAP, facts), undefined);
    assert.equal(ownerPaymentAlert(event("invoice.paid", invoice({ billing_reason: "subscription_cycle", amount_paid: 0 })), PRICE_MAP, facts), undefined);
    assert.equal(ownerPaymentAlert(event("invoice.paid", invoice({ billing_reason: "subscription_cycle", lines: { data: [{ price: { id: "price_other" } }] } })), PRICE_MAP, facts), undefined);
  });

  it("subscription changes: upgrade, downgrade, cancel, undo; nothing for other updates", () => {
    const sub = (price: string, extra: Record<string, unknown> = {}) => ({ id: "sub_1", customer: "cus_1", status: "active", cancel_at_period_end: false, cancel_at: null, items: { data: [{ price: { id: price }, current_period_end: 1_802_000_000 }] }, ...extra });
    assert.equal(ownerPaymentAlert(event("customer.subscription.updated", sub(PRICES.max), { items: { data: [{ price: { id: PRICES.plus } }] } }), PRICE_MAP, facts)!.subject, "dl.new: upgraded (Plus to Max)");
    assert.equal(ownerPaymentAlert(event("customer.subscription.updated", sub(PRICES.starter), { items: { data: [{ price: { id: PRICES.max } }] } }), PRICE_MAP, facts)!.subject, "dl.new: downgraded (Max to Starter)");
    const cancelled = ownerPaymentAlert(event("customer.subscription.updated", sub(PRICES.max, { cancel_at_period_end: true, cancellation_details: { reason: "cancellation_requested", feedback: "too_expensive" } }), { cancel_at_period_end: false }), PRICE_MAP, facts)!;
    assert.equal(cancelled.subject, "dl.new: cancelled (Max)");
    assert.match(cancelled.text, /Ends: 2027-02-07 \d\d:\d\d UTC/);
    assert.match(cancelled.text, /Reason: cancellation_requested, too_expensive/);
    // Newer API versions: cancel_at set instead.
    assert.equal(ownerPaymentAlert(event("customer.subscription.updated", sub(PRICES.plus, { cancel_at: 1_802_000_000 }), { cancel_at: null }), PRICE_MAP, facts)!.subject, "dl.new: cancelled (Plus)");
    assert.equal(ownerPaymentAlert(event("customer.subscription.updated", sub(PRICES.plus), { cancel_at_period_end: true }), PRICE_MAP, facts)!.subject, "dl.new: cancellation undone (Plus)");
    assert.equal(ownerPaymentAlert(event("customer.subscription.updated", sub(PRICES.plus), { status: "trialing" }), PRICE_MAP, facts), undefined);
    assert.equal(ownerPaymentAlert(event("customer.subscription.updated", sub(PRICES.plus)), PRICE_MAP, facts), undefined);
    assert.equal(ownerPaymentAlert(event("customer.subscription.deleted", sub(PRICES.max, { status: "canceled", ended_at: 1_802_000_000 })), PRICE_MAP, facts)!.subject, "dl.new: subscription ended (Max)");
    assert.equal(ownerPaymentAlert(event("customer.subscription.deleted", sub(PRICES.starter, { status: "canceled", trial_end: 1_802_000_000, ended_at: 1_801_000_000 })), PRICE_MAP, facts)!.subject, "dl.new: card trial ended unpaid (Starter)");
  });

  it("never puts control characters from Stripe into the body", () => {
    const message = ownerPaymentAlert(event("checkout.session.completed", { payment_status: "paid", amount_total: 700, metadata: { product: "plan", plan: "starter" } }), PRICE_MAP, { email: "a@b.c\r\nBcc: x@y.z", account: undefined })!;
    assert.match(message.text, /Customer: a@b\.c Bcc: x@y\.z\n/);
  });
});

describe("owner payment alerts: through the webhook", () => {
  it("emails once per event id for a paid Checkout, with the account once claimed", async () => {
    const { service, stripe } = await world({ CARD_TRIAL: "false" });
    const session = await buy(service, stripe, "plus", "pat@example.com");
    const object = stripe.sessionObject(session, false);
    assert.equal((await send(service, "checkout.session.completed", object, "evt_cs_1")).body.outcome, "plan_unclaimed");
    assert.deepEqual(mails(service).map((mail) => mail.subject), ["dl.new: new Plus subscription ($20 first month)"]);
    assert.match(mails(service)[0]!.body, /Customer: pat@example\.com/);
    assert.match(mails(service)[0]!.body, new RegExp(`checkout ${session.id}`));
    assert.equal(service.calls.emails[0]!.to, "owner@example.com");
    // A retry of the same event, and the claim, email nothing more.
    await send(service, "checkout.session.completed", object, "evt_cs_1");
    const signedIn = await emailSignIn(service, "pat@example.com", session.id);
    assert.equal(mails(service).length, 1, mails(service).map((mail) => mail.subject).join(" | "));
    // An upgrade after the claim names the account; the email comes from the Checkout.
    const subscription = stripe.subscriptions.get(session.subscription!)!;
    subscription.price = PRICES.max;
    await send(service, "customer.subscription.updated", stripe.subscriptionObject(subscription), "evt_up_1", { items: { data: [{ price: { id: PRICES.plus } }] } });
    const upgrade = mails(service)[1]!;
    assert.equal(upgrade.subject, "dl.new: upgraded (Plus to Max)");
    assert.match(upgrade.body, new RegExp(`Account: ${signedIn.account.accountId}`));
    assert.match(upgrade.body, /Customer: pat@example\.com/);
    assert.ok(parseAccountId(signedIn.account.accountId));
    // Cancel at period end, then the end.
    subscription.cancel_at_period_end = true;
    await send(service, "customer.subscription.updated", stripe.subscriptionObject(subscription), "evt_cancel_1", { cancel_at_period_end: false });
    subscription.status = "canceled";
    await send(service, "customer.subscription.deleted", stripe.subscriptionObject(subscription), "evt_del_1");
    assert.deepEqual(mails(service).slice(2).map((mail) => mail.subject), ["dl.new: cancelled (Max)", "dl.new: subscription ended (Max)"]);
    // A renewal invoice emails; the Checkout's own first invoice doesn't.
    const invoice = (id: string, reason: string) => ({ id, customer: session.customer, customer_email: "pat@example.com", billing_reason: reason, amount_paid: 2000, subtotal: 2000, parent: { subscription_details: { subscription: subscription.id, metadata: subscription.metadata } }, lines: { data: [{ price: { id: PRICES.plus }, period: { end: subscription.current_period_end } }] } });
    await send(service, "invoice.paid", invoice("in_first", "subscription_create"), "evt_in_1");
    await send(service, "invoice.paid", invoice("in_renew", "subscription_cycle"), "evt_in_2");
    assert.deepEqual(mails(service).slice(4).map((mail) => mail.subject), ["dl.new: payment ($20, Plus renewal)"]);
  });

  it("emails when a card trial starts", async () => {
    const { service, stripe } = await world();
    const session = await startTrial(service, stripe, "starter", "tri@example.com");
    assert.equal((await send(service, "checkout.session.completed", stripe.sessionObject(session, false), "evt_trial_1")).status, 200);
    assert.deepEqual(mails(service).map((mail) => mail.subject), ["dl.new: card trial started (Starter)"]);
    assert.match(mails(service)[0]!.body, /Customer: tri@example\.com/);
  });

  it("a failed email never fails the webhook, and logs only the error's name", async () => {
    const { service, stripe } = await world({ CARD_TRIAL: "false" });
    (service as any).env.ALERT_EMAIL.send = async () => {
      throw new TypeError("smtp said pat@example.com is secret");
    };
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      const session = await buy(service, stripe, "max", "pat@example.com");
      const result = await send(service, "checkout.session.completed", stripe.sessionObject(session, false), "evt_fail_1");
      assert.equal(result.status, 200);
      assert.equal(result.body.outcome, "plan_unclaimed");
    } finally {
      console.error = original;
    }
    const line = logged.find((args) => args[0] === "owner payment alert failed");
    assert.deepEqual(line, ["owner payment alert failed", "TypeError"]);
    assert.ok(!JSON.stringify(logged).includes("pat@example.com"));
  });
});
