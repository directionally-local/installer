import { accountIdOf, isPaidAccountNumber } from "./accounts.js";
import { emailBody, sendEmail, type Alert } from "./alerts.js";
import { directory, type Ctx } from "./app.js";
import { isPlanId, PLANS, planOfPrice, type PlanId } from "./plan-prices.js";
import { checkoutPromo, idOf, invoiceAmount, invoicePrices, invoiceSubscription, isTrialCheckout, periodEnd, promoEligible, subscriptionPrice, type StripeEvent } from "./stripe.js";

/**
 * The owner's email about dl.new plan money, one per Stripe event (webhooks retry; each event id
 * emails at most once):
 *
 *   checkout.session.completed, card trial       → "dl.new: card trial started (Starter)"
 *   checkout.session.completed, paid             → "dl.new: new Plus subscription ($10 first month)"
 *   invoice.paid, money taken, not the first     → "dl.new: payment ($20, Plus renewal)"
 *     (the first invoice of a paid Checkout is the Checkout's email)
 *   customer.subscription.updated, price change  → "dl.new: upgraded (Plus to Max)" / "downgraded"
 *   customer.subscription.updated, set to end    → "dl.new: cancelled (Max)" / "cancellation undone"
 *   customer.subscription.deleted                → "dl.new: subscription ended (Max)"
 *
 * Plain text: plan, amount, currency, discount, the customer's email, the account and the Stripe
 * ids. Never a secret. Sent through the ALERT_EMAIL binding to ALERT_EMAIL_TO; a failure logs the
 * error's name only and never fails the webhook.
 */

export interface OwnerPaymentFacts {
  /** The customer's email: from the event, else the plan's Checkout. */
  email: string | null;
  /** The dl.new account the Stripe customer belongs to; undefined before the claim. */
  account: number | undefined;
}

/** An event's plan alert, or undefined when it isn't one of the events above. */
export function ownerPaymentAlert(event: StripeEvent, prices: Partial<Record<PlanId, string>>, facts: OwnerPaymentFacts): Alert | undefined {
  const object = event.data.object ?? {};
  const currency = typeof object.currency === "string" ? object.currency : "usd";
  const ids = (extra: Array<[string, unknown]>): string => {
    const parts = [["event", event.id], ...extra, ["customer", idOf(object.customer)]]
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
      .map(([name, id]) => `${name} ${id}`);
    return `Stripe: ${parts.join(", ")}`;
  };
  const who = [`Customer: ${clean(facts.email) ?? "unknown"}`, `Account: ${accountLabel(facts.account)}`];

  switch (event.type) {
    case "checkout.session.completed": {
      if (object.metadata?.product !== "plan" || !isPlanId(object.metadata?.plan)) return undefined;
      const plan: PlanId = object.metadata.plan;
      const name = shortName(plan);
      const stripe = ids([["checkout", object.id], ["subscription", idOf(object.subscription)]]);
      if (isTrialCheckout(object)) {
        const offer = promoEligible(object);
        return alert(`dl.new: card trial started (${name})`, [
          `Card trial started: ${PLANS[plan].name}, card saved, nothing charged.`,
          "",
          `Plan: ${name} (${money(PLANS[plan].priceUsd * 100, "usd")}/month after the trial)`,
          `Amount: ${money(0, currency)} now`,
          `Discount: ${offer ? `launch offer ${offer} on the first charge` : "none"}`,
          ...who,
          stripe,
        ]);
      }
      if (object.payment_status !== "paid") return undefined;
      const total = cents(object.amount_total);
      const subtotal = cents(object.amount_subtotal ?? object.amount_total);
      const discount = cents(object.total_details?.amount_discount);
      const tax = cents(object.total_details?.amount_tax);
      const promo = checkoutPromo(object);
      const beforeTax = total - tax;
      return alert(`dl.new: new ${name} subscription (${money(beforeTax, currency)} first month)`, [
        `New subscription: ${PLANS[plan].name}, paid at Checkout.`,
        "",
        `Plan: ${name} (${money(PLANS[plan].priceUsd * 100, "usd")}/month)`,
        `Amount: ${money(total, currency)} ${upper(currency)} (subtotal ${money(subtotal, currency)}, discount ${money(discount, currency)}, tax ${money(tax, currency)})`,
        `Discount: ${promo ? `${promo.coupon}${promo.percentOff ? ` (${promo.percentOff}% off)` : ""}` : discount > 0 ? money(discount, currency) : "none"}`,
        ...who,
        stripe,
      ]);
    }
    case "invoice.paid": {
      const plan = invoicePrices(object).map((price) => planOfPrice(prices, price)).find((id): id is PlanId => id !== undefined) ?? planOf(invoiceSubscription(object).metadata.plan);
      if (!plan) return undefined;
      const paid = invoiceAmount(object);
      // The first invoice of a Checkout is that Checkout's email; a $0 invoice is no payment.
      if (paid <= 0 || object.billing_reason === "subscription_create") return undefined;
      const name = shortName(plan);
      const reason = object.billing_reason === "subscription_cycle" ? "renewal" : object.billing_reason === "subscription_update" ? "plan change or trial end" : "payment";
      const subtotal = cents(object.subtotal);
      const discount = discountOf(object);
      const tax = cents(object.tax ?? sumAmounts(object.total_taxes));
      return alert(`dl.new: payment (${money(paid, currency)}, ${name} ${reason})`, [
        `Payment received: ${PLANS[plan].name} (${reason}${object.billing_reason === "subscription_cycle" ? "; also the first charge after a card trial" : ""}).`,
        "",
        `Plan: ${name} (${money(PLANS[plan].priceUsd * 100, "usd")}/month)`,
        `Amount: ${money(paid, currency)} ${upper(currency)} (subtotal ${money(subtotal, currency)}, discount ${money(discount, currency)}, tax ${money(tax, currency)})`,
        `Discount: ${couponOf(object) ?? (discount > 0 ? money(discount, currency) : "none")}`,
        ...who,
        ids([["invoice", object.id], ["subscription", invoiceSubscription(object).subscriptionId]]),
      ]);
    }
    case "customer.subscription.updated": {
      const plan = planOfPrice(prices, subscriptionPrice(object)) ?? planOf(object.metadata?.plan);
      if (!plan) return undefined;
      const previous = event.data.previous_attributes ?? {};
      const name = shortName(plan);
      const stripe = ids([["subscription", object.id]]);
      const before = planOfPrice(prices, idOf(previous.items?.data?.[0]?.price));
      if (before && before !== plan) {
        const up = PLAN_ORDER.indexOf(plan) > PLAN_ORDER.indexOf(before);
        return alert(`dl.new: ${up ? "upgraded" : "downgraded"} (${shortName(before)} to ${name})`, [
          `Plan ${up ? "upgraded" : "downgraded"}: ${PLANS[before].name} to ${PLANS[plan].name}.`,
          "",
          `Plan: ${name} (${money(PLANS[plan].priceUsd * 100, "usd")}/month), was ${shortName(before)} (${money(PLANS[before].priceUsd * 100, "usd")}/month)`,
          `Status: ${String(object.status ?? "unknown")}`,
          ...who,
          stripe,
        ]);
      }
      const ending = (value: Record<string, any>) => value.cancel_at_period_end === true || typeof value.cancel_at === "number";
      const changed = "cancel_at_period_end" in previous || "cancel_at" in previous;
      if (!changed) return undefined;
      const was = ending({ cancel_at_period_end: previous.cancel_at_period_end ?? object.cancel_at_period_end, cancel_at: "cancel_at" in previous ? previous.cancel_at : object.cancel_at });
      const now = ending(object);
      if (was === now) return undefined;
      if (now) {
        const end = typeof object.cancel_at === "number" ? object.cancel_at * 1000 : periodEnd(object);
        return alert(`dl.new: cancelled (${name})`, [
          `Cancelled: ${PLANS[plan].name}${object.status === "trialing" ? " (during the card trial)" : ""}. It stays on until it ends.`,
          "",
          `Plan: ${name} (${money(PLANS[plan].priceUsd * 100, "usd")}/month)`,
          `Ends: ${end ? new Date(end).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "unknown"}`,
          `Reason: ${cancellationReason(object)}`,
          ...who,
          stripe,
        ]);
      }
      return alert(`dl.new: cancellation undone (${name})`, [`Cancellation undone: ${PLANS[plan].name} renews again.`, "", `Plan: ${name} (${money(PLANS[plan].priceUsd * 100, "usd")}/month)`, ...who, stripe]);
    }
    case "customer.subscription.deleted": {
      const plan = planOfPrice(prices, subscriptionPrice(object)) ?? planOf(object.metadata?.plan);
      if (!plan) return undefined;
      const name = shortName(plan);
      const inTrial = typeof object.trial_end === "number" && typeof object.ended_at === "number" && object.ended_at <= object.trial_end;
      return alert(`dl.new: ${inTrial ? "card trial ended unpaid" : "subscription ended"} (${name})`, [
        `${inTrial ? "Card trial ended without a payment" : "Subscription ended"}: ${PLANS[plan].name}. The plan is off.`,
        "",
        `Plan: ${name} (${money(PLANS[plan].priceUsd * 100, "usd")}/month)`,
        `Reason: ${cancellationReason(object)}`,
        ...who,
        ids([["subscription", object.id]]),
      ]);
    }
  }
  return undefined;
}

/**
 * Emails the owner about a plan event (above), once per event id. Never throws: the webhook's
 * handling must not depend on it. Without ALERT_EMAIL and ALERT_EMAIL_TO it does nothing.
 */
export async function sendOwnerPaymentAlert(c: Ctx, event: StripeEvent): Promise<boolean> {
  try {
    const binding = c.env.ALERT_EMAIL;
    const to = c.config.alertEmailTo;
    if (!binding || !to) return false;
    const prices = c.config.stripe.prices ?? {};
    // Cheap check first: most events aren't these.
    if (!ownerPaymentAlert(event, prices, { email: null, account: undefined })) return false;
    const dir = directory(c);
    const object = event.data.object ?? {};
    const customerId = idOf(object.customer);
    const account = customerId ? await dir.customerOwner(customerId) : undefined;
    let email = stringOr(object.customer_details?.email) ?? stringOr(object.customer_email);
    if (!email) {
      const subscriptionId = event.type.startsWith("customer.subscription.") ? idOf(object.id) : invoiceSubscription(object).subscriptionId;
      if (subscriptionId) email = (await dir.paidCheckoutBySubscription(subscriptionId))?.email ?? null;
    }
    const message = ownerPaymentAlert(event, prices, { email, account });
    if (!message) return false;
    if (!(await dir.markOwnerPaymentAlert(event.id, c.now()))) return false;
    await sendEmail(binding, { from: c.config.alertEmailFrom, to, subject: message.subject, body: emailBody(message, `${c.base}/admin`), now: c.now(), fromName: "dl.new" });
    return true;
  } catch (error) {
    console.error("owner payment alert failed", error instanceof Error ? error.name : "error");
    return false;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const PLAN_ORDER: readonly PlanId[] = ["starter", "plus", "max"];

function alert(subject: string, lines: string[]): Alert {
  return { subject, text: lines.join("\n"), footer: "Sent once per Stripe event (dl.new plans). Amounts as Stripe reports them; no card details." };
}

function shortName(plan: PlanId): string {
  return PLANS[plan].name.replace(/^dl\.new /, "");
}

function planOf(value: unknown): PlanId | undefined {
  return isPlanId(value) ? value : undefined;
}

function cents(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.round(number) : 0;
}

function sumAmounts(list: unknown): number {
  return Array.isArray(list) ? list.reduce((sum: number, entry) => sum + cents((entry as { amount?: unknown })?.amount), 0) : 0;
}

function discountOf(invoice: Record<string, any>): number {
  return sumAmounts(invoice.total_discount_amounts);
}

function couponOf(invoice: Record<string, any>): string | undefined {
  const sources = [invoice.discount, ...(Array.isArray(invoice.discounts) ? invoice.discounts : [])];
  for (const source of sources) {
    const coupon = source?.coupon ?? source?.source?.coupon;
    const id = idOf(coupon);
    if (id) return typeof coupon?.percent_off === "number" ? `${id} (${coupon.percent_off}% off)` : id;
  }
  return undefined;
}

function upper(currency: string): string {
  return currency.toUpperCase();
}

/** "$10" or "$10.50" in dollars; "10.50 EUR" otherwise. */
function money(amount: number, currency: string): string {
  const value = amount / 100;
  const text = Number.isInteger(value) ? String(value) : value.toFixed(2);
  return currency.toLowerCase() === "usd" ? `$${text}` : `${text} ${upper(currency)}`;
}

function accountLabel(account: number | undefined): string {
  if (account === undefined) return "not set up yet (unclaimed: GET /admin/paid/checkouts)";
  return isPaidAccountNumber(account) ? accountIdOf(account) : `GitHub id ${account}`;
}

function cancellationReason(subscription: Record<string, any>): string {
  const details = subscription.cancellation_details ?? {};
  const parts = [details.reason, details.feedback].filter((part): part is string => typeof part === "string" && part.length > 0).map((part) => clean(part)!);
  return parts.length > 0 ? parts.join(", ") : "not given";
}

function stringOr(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A value from Stripe made safe for one line of plain text: no control characters, at most 200 characters. */
function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim().slice(0, 200);
  return text.length > 0 ? text : null;
}
