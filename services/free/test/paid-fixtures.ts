import assert from "node:assert/strict";
import type { Service } from "./harness.js";

/**
 * dl.new's paid launch in tests: a small stateful Stripe (Checkout Sessions, subscriptions,
 * customers, invoices, refunds, the portal) behind the harness's fetch, and helpers that walk a
 * person through pay → account. Nothing leaves the process.
 */

export const WEBHOOK_SECRET = "whsec_test_paid_0123456789";
export const PRICES = { starter: "price_starter123", plus: "price_plus123", max: "price_max123" } as const;
export const PAID_VARS = {
  OPEN_ADMISSION: "true",
  LUMINAL_API_KEY: "lum-test",
  STRIPE_SECRET_KEY: "sk_test_fake",
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_PRICE_STARTER: PRICES.starter,
  STRIPE_PRICE_PLUS: PRICES.plus,
  STRIPE_PRICE_MAX: PRICES.max,
};
export const DL = { origin: "https://dl.new" };
export const PAGE_STATE = "page-state-0123456789abcdef";

export interface FakeSession {
  id: string;
  mode: string;
  status: string;
  payment_status: string;
  metadata: Record<string, string>;
  price: string;
  customer: string | null;
  subscription: string | null;
  email: string | null;
  amount_total: number;
  created: number;
  form: URLSearchParams;
  /** The coupon Checkout applied (`discounts[0][coupon]`), or null. */
  coupon: string | null;
}

export interface FakeSubscription {
  id: string;
  customer: string;
  status: string;
  price: string;
  item: string;
  current_period_end: number;
  cancel_at_period_end: boolean;
  latest_invoice: string;
  metadata: Record<string, string>;
  /** Unix seconds while trialing, else null. */
  trial_end: number | null;
  /** Coupons on the subscription (the next invoice's discount). */
  discounts: string[];
}

export class FakeStripe {
  sessions = new Map<string, FakeSession>();
  subscriptions = new Map<string, FakeSubscription>();
  customers = new Map<string, Record<string, string>>();
  refunds: URLSearchParams[] = [];
  /** Set to refuse Checkout's terms consent the way Stripe does without a terms URL in the public details. */
  refuseTermsConsent = false;
  /** Set to make the next subscription update fail as a declined card. */
  declineNext = false;
  /** Set to make ending a trial now (the first real charge) fail as a declined card. */
  declineTrialEnd = false;
  /** Set to make ending a trial now fail as a Stripe error (not a decline). */
  failTrialEnd = false;
  /** Every subscription update's form, in order. */
  updates: Array<{ id: string; form: URLSearchParams }> = [];
  /** Coupons Stripe knows, with their percent off (duration once); others are refused at Checkout as Stripe does. */
  coupons = new Map<string, number>([["dlnew-bf-2026", 50]]);
  #n = 0;

  constructor(private readonly service: Service) {
    service.setStripe((path, form, method) => this.handle(path, form, method));
  }

  get now(): number {
    return Math.floor(this.service.clock.now / 1000);
  }

  handle(path: string, form: URLSearchParams, method: string): Response {
    if (method === "POST" && path === "/v1/checkout/sessions") {
      if (this.refuseTermsConsent && form.get("consent_collection[terms_of_service]")) {
        return Response.json(
          { error: { type: "invalid_request_error", message: "You cannot collect consent to your terms of service unless a URL is set in the Stripe Dashboard. Update your public business details at https://dashboard.stripe.com/settings/public to add a terms of service URL." } },
          { status: 400 },
        );
      }
      const coupon = form.get("discounts[0][coupon]");
      if (coupon !== null && !this.coupons.has(coupon)) {
        return Response.json({ error: { type: "invalid_request_error", code: "resource_missing", param: "discounts[0][coupon]", message: `No such coupon: '${coupon}'` } }, { status: 400 });
      }
      if (coupon !== null && form.get("allow_promotion_codes") !== null) {
        return Response.json({ error: { type: "invalid_request_error", message: "You may only specify one of these parameters: allow_promotion_codes, discounts." } }, { status: 400 });
      }
      const id = `cs_test_${String(++this.#n).padStart(12, "a")}`;
      const metadata: Record<string, string> = {};
      for (const [key, value] of form) {
        const match = /^metadata\[(\w+)\]$/.exec(key);
        if (match) metadata[match[1]!] = value;
      }
      this.sessions.set(id, { id, mode: form.get("mode")!, status: "open", payment_status: "unpaid", metadata, price: form.get("line_items[0][price]")!, customer: null, subscription: null, email: null, amount_total: 0, created: this.now, form, coupon });
      return Response.json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
    }
    let match = /^\/v1\/checkout\/sessions\/(.+)$/.exec(path);
    if (method === "GET" && match) {
      const session = this.sessions.get(match[1]!);
      if (!session) return Response.json({ error: { message: "No such checkout.session", code: "resource_missing" } }, { status: 404 });
      return Response.json(this.sessionObject(session, form.getAll("expand[0]").includes("subscription")));
    }
    match = /^\/v1\/subscriptions\/(.+)$/.exec(path);
    if (match) {
      const subscription = this.subscriptions.get(match[1]!);
      if (!subscription) return Response.json({ error: { message: "No such subscription" } }, { status: 404 });
      if (method === "POST") {
        if (this.declineNext && form.get("items[0][price]")) {
          this.declineNext = false;
          return Response.json({ error: { message: "Your card was declined.", code: "card_declined" } }, { status: 402 });
        }
        this.updates.push({ id: subscription.id, form });
        if (form.get("trial_end") === "now") {
          if (this.declineTrialEnd) return Response.json({ error: { message: "Your card was declined.", code: "card_declined" } }, { status: 402 });
          if (this.failTrialEnd) return Response.json({ error: { type: "api_error", message: "An error occurred with our connection to Stripe." } }, { status: 500 });
          const coupon = form.get("discounts[0][coupon]");
          if (coupon !== null && !this.coupons.has(coupon)) return Response.json({ error: { message: `No such coupon: '${coupon}'`, code: "resource_missing" } }, { status: 400 });
          if (coupon) subscription.discounts = [coupon];
          subscription.status = "active";
          subscription.trial_end = null;
          subscription.current_period_end = this.now + 30 * 86_400;
          subscription.latest_invoice = `in_trial_end_${subscription.id}`;
          return Response.json(this.subscriptionObject(subscription));
        }
        if (form.get("discounts[0][coupon]") !== null) {
          const coupon = form.get("discounts[0][coupon]")!;
          if (!this.coupons.has(coupon)) return Response.json({ error: { message: `No such coupon: '${coupon}'`, code: "resource_missing" } }, { status: 400 });
          subscription.discounts = [coupon];
          return Response.json(this.subscriptionObject(subscription));
        }
        for (const [key, value] of form) {
          const meta = /^metadata\[(\w+)\]$/.exec(key);
          if (meta) subscription.metadata[meta[1]!] = value;
        }
        if (form.get("items[0][price]")) subscription.price = form.get("items[0][price]")!;
        return Response.json({ ...this.subscriptionObject(subscription), latest_invoice: { id: "in_upgrade", amount_paid: 1300 } });
      }
      if (method === "DELETE") {
        subscription.status = "canceled";
        return Response.json(this.subscriptionObject(subscription));
      }
      return Response.json(this.subscriptionObject(subscription));
    }
    match = /^\/v1\/customers\/(.+)$/.exec(path);
    if (method === "POST" && match) {
      const customer = this.customers.get(match[1]!) ?? {};
      for (const [key, value] of form) customer[key] = value;
      this.customers.set(match[1]!, customer);
      return Response.json({ id: match[1], ...customer });
    }
    match = /^\/v1\/invoices\/(.+)$/.exec(path);
    if (method === "GET" && match) return Response.json({ id: match[1], payment_intent: `pi_for_${match[1]}` });
    if (method === "POST" && path === "/v1/refunds") {
      // Stripe refuses to refund a payment that was refunded in full already.
      const payment = form.get("payment_intent") ?? form.get("charge");
      if (this.refunds.some((refund) => (refund.get("payment_intent") ?? refund.get("charge")) === payment)) {
        return Response.json({ error: { type: "invalid_request_error", code: "charge_already_refunded", message: "Charge has already been refunded." } }, { status: 400 });
      }
      this.refunds.push(form);
      return Response.json({ id: `re_${this.refunds.length}`, amount: 700 });
    }
    if (method === "POST" && path === "/v1/billing_portal/sessions") return Response.json({ id: "bps_1", url: "https://billing.stripe.com/p/session/test_1" });
    throw new Error(`fake Stripe: unexpected ${method} ${path}`);
  }

  /** Checkout completed and paid: a customer and an active subscription on the session's price. */
  pay(sessionId: string, email = "payer@example.com"): FakeSession {
    const session = this.sessions.get(sessionId)!;
    const n = this.sessions.size;
    session.status = "complete";
    session.payment_status = "paid";
    session.customer = `cus_${n}`;
    session.subscription = `sub_${n}`;
    session.email = email;
    session.amount_total = Math.round(this.subtotal(session) * (1 - (session.coupon ? this.coupons.get(session.coupon)! : 0) / 100));
    this.subscriptions.set(session.subscription, {
      id: session.subscription,
      customer: session.customer,
      status: "active",
      price: session.price,
      item: `si_${n}`,
      current_period_end: this.now + 30 * 86_400,
      cancel_at_period_end: false,
      latest_invoice: `in_first_${n}`,
      metadata: { ...session.metadata },
      trial_end: null,
      discounts: session.coupon ? [session.coupon] : [],
    });
    return session;
  }

  /** A card trial's Checkout completed: the card saved, $0 now, the subscription trialing for its trial_period_days. */
  startTrial(sessionId: string, email = "payer@example.com"): FakeSession {
    const session = this.sessions.get(sessionId)!;
    const days = Number(session.form.get("subscription_data[trial_period_days]"));
    assert.ok(days > 0, "not a trial Checkout");
    const n = this.sessions.size;
    session.status = "complete";
    session.payment_status = "no_payment_required";
    session.customer = `cus_${n}`;
    session.subscription = `sub_${n}`;
    session.email = email;
    session.amount_total = 0;
    this.subscriptions.set(session.subscription, {
      id: session.subscription,
      customer: session.customer,
      status: "trialing",
      price: session.price,
      item: `si_${n}`,
      current_period_end: this.now + days * 86_400,
      cancel_at_period_end: false,
      latest_invoice: `in_trial_${n}`,
      metadata: { ...this.subscriptionMetadata(session.form) },
      trial_end: this.now + days * 86_400,
      discounts: [],
    });
    return session;
  }

  subscriptionMetadata(form: URLSearchParams): Record<string, string> {
    const metadata: Record<string, string> = {};
    for (const [key, value] of form) {
      const match = /^subscription_data\[metadata\]\[(\w+)\]$/.exec(key);
      if (match) metadata[match[1]!] = value;
    }
    return metadata;
  }

  /** The session's price before any discount, in cents. */
  subtotal(session: FakeSession): number {
    return session.price === PRICES.plus ? 2000 : session.price === PRICES.max ? 6000 : 700;
  }

  sessionObject(session: FakeSession, expand: boolean): Record<string, unknown> {
    const subscription = session.subscription ? this.subscriptions.get(session.subscription) : undefined;
    const paid = session.status === "complete" && session.payment_status === "paid";
    const discount = paid ? this.subtotal(session) - session.amount_total : 0;
    return {
      amount_subtotal: paid ? this.subtotal(session) : 0,
      total_details: { amount_discount: discount, amount_shipping: 0, amount_tax: 0 },
      discounts: session.coupon ? [{ coupon: session.coupon, promotion_code: null }] : [],
      id: session.id,
      object: "checkout.session",
      mode: session.mode,
      status: session.status,
      payment_status: session.payment_status,
      metadata: session.metadata,
      customer: session.customer,
      subscription: expand && subscription ? this.subscriptionObject(subscription) : session.subscription,
      customer_details: session.email ? { email: session.email } : null,
      amount_total: session.amount_total,
      created: session.created,
      // Checkout can't complete without the checkbox when it was required.
      consent: session.status === "complete" && session.form.get("consent_collection[terms_of_service]") === "required" ? { terms_of_service: "accepted", promotions: null } : null,
    };
  }

  subscriptionObject(subscription: FakeSubscription): Record<string, unknown> {
    return {
      id: subscription.id,
      object: "subscription",
      customer: subscription.customer,
      status: subscription.status,
      cancel_at_period_end: subscription.cancel_at_period_end,
      latest_invoice: subscription.latest_invoice,
      metadata: subscription.metadata,
      trial_end: subscription.trial_end,
      discounts: subscription.discounts,
      items: { data: [{ id: subscription.item, price: { id: subscription.price }, current_period_end: subscription.current_period_end }] },
    };
  }
}

/** POSTs a signed Stripe event to the webhook. */
export async function webhook(service: Service, type: string, object: Record<string, unknown>, id = `evt_${type}_${Math.random().toString(36).slice(2)}`): Promise<{ status: number; body: Record<string, unknown> }> {
  const { signatureHeader } = await import("../src/stripe.js");
  const created = Math.floor(service.clock.now / 1000);
  const body = JSON.stringify({ id, object: "event", type, created, data: { object } });
  const header = await signatureHeader(WEBHOOK_SECRET, created, body);
  const response = await service.request("POST", "/v1/billing/webhook", { body, headers: { "stripe-signature": header } });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Starts Checkout for a plan from dl.new and pays it. */
export async function buy(service: Service, stripe: FakeStripe, plan: "starter" | "plus" | "max" = "starter", email = "payer@example.com"): Promise<FakeSession> {
  const response = await service.request("POST", "/web/checkout/plan", { body: { plan }, headers: DL });
  assert.equal(response.status, 200, await response.clone().text());
  const { sessionId } = (await response.json()) as { sessionId: string };
  return stripe.pay(sessionId, email);
}

/** The 6-digit code in the last email sent to `to`. */
export function lastCode(service: Service, to: string): string {
  const message = [...service.calls.userEmail].reverse().find((entry) => entry.to === to);
  assert.ok(message, `no email to ${to}`);
  const match = /\b(\d{6})\b/.exec(String(message.text));
  assert.ok(match, String(message.text));
  return match[1]!;
}

export interface SessionResponse {
  token: string;
  expiresIn: number;
  created: boolean;
  claimed: { plan: string; sessionId: string } | null;
  account: Record<string, any>;
}

/** Email sign-up or sign-in end to end: the code, then the session response. */
export async function emailSignIn(service: Service, email: string, sessionId?: string): Promise<SessionResponse> {
  const start = await service.request("POST", "/web/auth/email/start", { body: { email, ...(sessionId ? { sessionId } : {}) }, headers: DL });
  assert.equal(start.status, 200, await start.clone().text());
  const verify = await service.request("POST", "/web/auth/email/verify", { body: { email, code: lastCode(service, email), ...(sessionId ? { sessionId } : {}) }, headers: DL });
  assert.equal(verify.status, 200, await verify.clone().text());
  return (await verify.json()) as SessionResponse;
}

/** dl.new's GitHub sign-in up to the page's one-time code (or the error fragment). */
export async function githubRoundTrip(service: Service, user: { id: number; login: string; email?: string | null; createdAt?: string; publicRepos?: number; contributions?: number }, returnTo = "https://dl.new/account"): Promise<string> {
  const start = await service.request("GET", `/web/auth/github?return=${encodeURIComponent(returnTo)}&state=${PAGE_STATE}`);
  assert.equal(start.status, 302, await start.clone().text());
  const location = new URL(start.headers.get("location")!);
  assert.equal(location.origin, "https://github.com");
  assert.equal(location.searchParams.get("scope"), "user:email");
  const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
  const callback = await service.request("GET", `/device/callback?code=${encodeURIComponent(JSON.stringify(user))}&state=${location.searchParams.get("state")}`, { headers: { cookie } });
  assert.equal(callback.status, 303);
  const back = callback.headers.get("location")!;
  assert.ok(back.startsWith(`${returnTo}#`), back);
  return back.slice(returnTo.length + 1);
}
