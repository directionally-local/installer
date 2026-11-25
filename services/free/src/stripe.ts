import { timingSafeEqual } from "../../shared/src/auth.js";
import type { StripeConfig } from "./config.js";

/**
 * Stripe, through its REST API with fetch (no SDK, so the Worker stays portable):
 *
 *   POST /v1/checkout/sessions          Checkout for Pro (a subscription) or a top-up (a payment),
 *                                       with Stripe Tax (`automatic_tax[enabled]=true`) and only the
 *                                       billing address it needs (country, and a postal code where
 *                                       tax or the card needs one)
 *   POST /v1/billing_portal/sessions    the Customer Portal, for cancelling or changing the card
 *
 * Pro is priced inline (`price_data`: USD, monthly, the amount from PRO_PRICE_USD_MONTHLY), so no
 * Stripe Product or Price has to exist before the first checkout. The top-up is a Stripe Price id
 * from config (STRIPE_PRICE_TOPUP; see scripts/stripe-setup.mjs). Webhooks are verified with
 * STRIPE_WEBHOOK_SECRET (`verifyWebhook`).
 */

export const STRIPE_API = "https://api.stripe.com";
/** How old a webhook's signed timestamp may be (Stripe's own default). */
export const WEBHOOK_TOLERANCE_S = 300;

export type Product = "pro" | "topup";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Stripe's error code (`card_declined`, `resource_missing`…), when it gave one. */
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Stripe's form encoding: nested objects as `a[b][c]=v`, arrays as `a[0][b]=v`. */
export function formEncode(value: Record<string, unknown>): string {
  const pairs: string[] = [];
  const walk = (prefix: string, node: unknown) => {
    if (node === undefined || node === null) return;
    if (Array.isArray(node)) node.forEach((item, index) => walk(`${prefix}[${index}]`, item));
    else if (typeof node === "object") for (const [key, child] of Object.entries(node)) walk(prefix ? `${prefix}[${key}]` : key, child);
    else pairs.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(node))}`);
  };
  walk("", value);
  return pairs.join("&");
}

async function call(fetcher: Fetch, secretKey: string, path: string, body: Record<string, unknown>, idempotencyKey?: string): Promise<Record<string, unknown>> {
  const response = await fetcher(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: formEncode(body),
  });
  const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message?: string } };
  if (!response.ok) throw new StripeError(parsed.error?.message ?? `Stripe answered ${response.status}.`, response.status);
  return parsed;
}

/** The Checkout Session parameters for a product (exported for tests). */
export function checkoutParams(input: {
  product: Product;
  config: StripeConfig;
  githubId: number;
  login: string;
  customerId: string | null;
  /** Pro's monthly price in USD cents (PRO_PRICE_USD_MONTHLY), charged with inline `price_data`. */
  proPriceCents?: number;
  /** A top-up: how many $1 units to start at, and the range the buyer may change it to on the page. */
  topup?: TopupQuantity;
}): Record<string, unknown> {
  const { product, config } = input;
  const price = config.priceTopup;
  // `topup_kind: usd`: a dollar top-up (usage dollars); a top-up session without it is the old token kind.
  const metadata = { github_id: String(input.githubId), github_login: input.login, product, ...(product === "topup" ? { topup_kind: "usd" } : {}) };
  const topup = input.topup;
  const line =
    product === "topup" && topup
      ? { price, quantity: topup.quantity, adjustable_quantity: { enabled: true, minimum: topup.minQuantity, maximum: topup.maxQuantity } }
      : product === "pro"
        ? { price_data: proPriceData(input.proPriceCents), quantity: 1 }
        : { price, quantity: 1 };
  return {
    mode: product === "pro" ? "subscription" : "payment",
    line_items: [line],
    // dl.new's success page says "You're on Pro." or, for a top-up, that the usage was added.
    success_url: product === "topup" ? `${config.successUrl}${config.successUrl.includes("?") ? "&" : "?"}product=topup` : config.successUrl,
    cancel_url: config.cancelUrl,
    client_reference_id: String(input.githubId),
    metadata,
    automatic_tax: { enabled: true },
    // "auto": Checkout asks only for what tax and the card need (often just the country).
    // "required" asked for a full street address, and most people left at that step.
    billing_address_collection: "auto",
    ...(input.customerId
      ? // Stripe Tax needs the address saved on an existing customer.
        { customer: input.customerId, customer_update: { address: "auto", name: "auto" } }
      : product === "topup"
        ? { customer_creation: "always" }
        : {}),
    ...(product === "pro" ? { subscription_data: { metadata } } : { payment_intent_data: { metadata } }),
  };
}

/** The name Pro's inline price shows on Checkout, receipts and the Customer Portal. */
export const PRO_PRODUCT_NAME = "dl Pro";

/**
 * Pro's inline price: USD, every month, tax added on top (exclusive, as the top-up's Price is).
 * Stripe keeps the price it creates for the subscription; nothing is set up ahead of time.
 */
export function proPriceData(cents: number | undefined): Record<string, unknown> {
  if (cents === undefined || !Number.isSafeInteger(cents) || cents <= 0) throw new StripeError("Pro has no price set.", 503);
  return {
    currency: "usd",
    unit_amount: cents,
    recurring: { interval: "month" },
    tax_behavior: "exclusive",
    // The same tax code as scripts/stripe-setup.mjs gives its products (electronically supplied services).
    product_data: { name: PRO_PRODUCT_NAME, tax_code: "txcd_10000000", metadata: { product: "pro" } },
  };
}

/** A dollar top-up's quantity ($1 units) and the range Checkout lets the buyer adjust it in. */
export interface TopupQuantity {
  quantity: number;
  minQuantity: number;
  maxQuantity: number;
}

export async function createCheckout(
  fetcher: Fetch,
  input: { product: Product; config: StripeConfig; githubId: number; login: string; customerId: string | null; idempotencyKey: string; proPriceCents?: number; topup?: TopupQuantity },
): Promise<{ id: string; url: string }> {
  let session: Record<string, unknown>;
  try {
    session = await call(fetcher, input.config.secretKey!, "/v1/checkout/sessions", checkoutParams(input), input.idempotencyKey);
  } catch (error) {
    // A customer saved from another Stripe account (after moving accounts) doesn't exist here:
    // start without it; checkout.session.completed then saves the new customer.
    if (!(input.customerId && isMissingCustomer(error))) throw error;
    session = await call(fetcher, input.config.secretKey!, "/v1/checkout/sessions", checkoutParams({ ...input, customerId: null }), `${input.idempotencyKey}-new-customer`);
  }
  if (typeof session.url !== "string" || typeof session.id !== "string") throw new StripeError("Stripe didn't return a Checkout URL.", 502);
  return { id: session.id, url: session.url };
}

/** Stripe's answer for a customer id this account doesn't have (e.g. one saved before moving accounts). */
export function isMissingCustomer(error: unknown): boolean {
  return error instanceof StripeError && /no such customer/i.test(error.message);
}

export async function createPortal(fetcher: Fetch, input: { config: StripeConfig; customerId: string }): Promise<{ url: string }> {
  const session = await call(fetcher, input.config.secretKey!, "/v1/billing_portal/sessions", { customer: input.customerId, return_url: input.config.portalReturnUrl });
  if (typeof session.url !== "string") throw new StripeError("Stripe didn't return a portal URL.", 502);
  return { url: session.url };
}

// ─── Webhooks ───────────────────────────────────────────────────────────────

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function signPayload(secret: string, timestamp: number, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`)));
}

export interface StripeEvent {
  id: string;
  type: string;
  /** Unix seconds. */
  created: number;
  /** `previous_attributes`: on *.updated events, the fields that changed, as they were. */
  data: { object: Record<string, any>; previous_attributes?: Record<string, any> };
}

/**
 * Checks a `Stripe-Signature` header (`t=<unix seconds>,v1=<hex HMAC-SHA256>`, possibly
 * several v1) over `<t>.<raw body>` with the endpoint's signing secret, as Stripe documents,
 * and that `t` is within 5 minutes. Returns the parsed event, or a reason it was refused.
 */
export async function verifyWebhook(rawBody: string, header: string | null, secret: string, nowMs: number): Promise<{ event: StripeEvent } | { error: string }> {
  if (!header) return { error: "missing Stripe-Signature" };
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2).map((piece) => piece.trim());
    if (key === "t" && value && /^\d+$/.test(value)) timestamp = Number(value);
    if (key === "v1" && value) signatures.push(value);
  }
  if (timestamp === undefined || signatures.length === 0) return { error: "malformed Stripe-Signature" };
  if (Math.abs(nowMs / 1000 - timestamp) > WEBHOOK_TOLERANCE_S) return { error: "timestamp outside the tolerance" };
  const expected = await signPayload(secret, timestamp, rawBody);
  if (!signatures.some((signature) => signature.length === expected.length && timingSafeEqual(signature, expected))) return { error: "signature mismatch" };
  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { error: "body isn't JSON" };
  }
  const shaped = event as Partial<StripeEvent>;
  if (typeof shaped.id !== "string" || typeof shaped.type !== "string" || typeof shaped.created !== "number" || !shaped.data || typeof shaped.data.object !== "object") {
    return { error: "not a Stripe event" };
  }
  return { event: shaped as StripeEvent };
}

/** The test helper's and the setup script's header: `t=…,v1=…`. */
export async function signatureHeader(secret: string, timestamp: number, payload: string): Promise<string> {
  return `t=${timestamp},v1=${await signPayload(secret, timestamp, payload)}`;
}

// ─── Reading events ─────────────────────────────────────────────────────────

/** A Stripe id field that may be expanded into an object. */
export function idOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") return (value as { id: string }).id;
  return undefined;
}

export function githubIdFrom(...candidates: unknown[]): number | undefined {
  for (const candidate of candidates) {
    const id = typeof candidate === "string" && /^\d{1,16}$/.test(candidate) ? Number(candidate) : typeof candidate === "number" ? candidate : Number.NaN;
    if (Number.isSafeInteger(id) && id > 0) return id;
  }
  return undefined;
}

/** A subscription's period end (Unix ms): on the subscription in older API versions, on its items in newer ones. */
export function periodEnd(subscription: Record<string, any>): number | null {
  const seconds = subscription.current_period_end ?? subscription.items?.data?.[0]?.current_period_end;
  return typeof seconds === "number" ? seconds * 1000 : null;
}

/** The subscription an invoice belongs to, and its metadata, across API versions. */
export function invoiceSubscription(invoice: Record<string, any>): { subscriptionId: string | undefined; metadata: Record<string, unknown> } {
  const details = invoice.parent?.subscription_details ?? invoice.subscription_details ?? {};
  return {
    subscriptionId: idOf(details.subscription) ?? idOf(invoice.subscription),
    metadata: (details.metadata as Record<string, unknown> | undefined) ?? {},
  };
}

/** An invoice's period end (Unix ms): the subscription line's period, else the invoice's own. */
export function invoicePeriodEnd(invoice: Record<string, any>): number | null {
  const lines = (invoice.lines?.data ?? []) as Array<{ period?: { end?: number } }>;
  const ends = lines.map((line) => line.period?.end).filter((end): end is number => typeof end === "number");
  if (ends.length > 0) return Math.max(...ends) * 1000;
  return typeof invoice.period_end === "number" ? invoice.period_end * 1000 : null;
}

/** Stripe subscription statuses, reduced to what access needs. */
export function proState(status: unknown): "active" | "past_due" | "canceled" {
  if (status === "active" || status === "trialing") return "active";
  if (status === "canceled" || status === "incomplete_expired") return "canceled";
  return "past_due";
}

// ─── dl.new's plans (plan-prices.ts, docs/web-api-paid.md) ────────────────────────

/** Any Stripe call: GET reads (query string), POST writes (form body), DELETE cancels. */
export async function stripeRequest(
  fetcher: Fetch,
  secretKey: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body: Record<string, unknown> = {},
  idempotencyKey?: string,
): Promise<Record<string, any>> {
  const encoded = formEncode(body);
  const url = method === "POST" || !encoded ? `${STRIPE_API}${path}` : `${STRIPE_API}${path}?${encoded}`;
  const response = await fetcher(url, {
    method,
    headers: {
      authorization: `Bearer ${secretKey}`,
      ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    ...(method === "POST" ? { body: encoded } : {}),
  });
  const parsed = (await response.json().catch(() => ({}))) as Record<string, any> & { error?: { message?: string; code?: string; decline_code?: string } };
  if (!response.ok) throw new StripeError(parsed.error?.message ?? `Stripe answered ${response.status}.`, response.status, parsed.error?.code);
  return parsed;
}

/**
 * Checkout for a plan, before any account exists: subscription mode, the plan's Price, no promotion
 * codes, Stripe Tax as dl Pro has it, and the plan in the session's and the subscription's metadata
 * (`product: "plan"`), so the webhooks know it. The account is linked when the session is claimed.
 */
/**
 * `termsConsent`: the checkbox text; Checkout then requires the terms-of-service consent (Stripe
 * needs a terms URL in the account's public details, else it refuses: isTermsConsentRefusal).
 */
/**
 * `trial` (trials.ts): a card trial. The card is collected now and nothing is charged:
 * `trial_period_days` is the 30-day backstop, and without a payment method at its end the
 * subscription is canceled, never left unpaid. While the launch offer runs, its coupon (`coupon`)
 * goes on the trial Checkout too, so the page shows the first paid month's discount; Stripe
 * keeps a duration-once coupon for the first invoice with an amount, not the $0 trial invoice.
 * `promo_eligible` (session and subscription metadata) still records it, so trial end
 * (trial-web.ts) puts it back if the subscription has no discount left by then.
 * `trial.offerText`: Checkout's line above the button (`custom_text.submit`) explaining when.
 */
export function planCheckoutParams(input: { plan: string; price: string; successUrl: string; cancelUrl: string; campaign?: string; termsConsent?: string; coupon?: string; trial?: { days: number; promoEligible?: string; offerText?: string } }): Record<string, unknown> {
  const metadata: Record<string, string> = { product: "plan", plan: input.plan, ...(input.campaign ? { campaign: input.campaign } : {}) };
  if (input.trial) {
    const trialMeta = { ...metadata, trial: "card", ...(input.trial.promoEligible ? { promo_eligible: input.trial.promoEligible } : {}) };
    return {
      mode: "subscription",
      line_items: [{ price: input.price, quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      // Stripe takes either `discounts` or `allow_promotion_codes`, never both; codes stay off either way.
      ...(input.coupon ? { discounts: [{ coupon: input.coupon }] } : { allow_promotion_codes: false }),
      payment_method_collection: "always",
      automatic_tax: { enabled: true },
      billing_address_collection: "auto",
      metadata: input.coupon ? { ...trialMeta, promo: input.coupon } : trialMeta,
      subscription_data: { metadata: trialMeta, trial_period_days: input.trial.days, trial_settings: { end_behavior: { missing_payment_method: "cancel" } } },
      ...(input.termsConsent ? { consent_collection: { terms_of_service: "required" } } : {}),
      ...(input.termsConsent || input.trial.offerText
        ? {
            custom_text: {
              ...(input.termsConsent ? { terms_of_service_acceptance: { message: input.termsConsent } } : {}),
              ...(input.trial.offerText ? { submit: { message: input.trial.offerText } } : {}),
            },
          }
        : {}),
    };
  }
  return {
    mode: "subscription",
    line_items: [{ price: input.price, quantity: 1 }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    // The launch offer's coupon (duration "once": the first invoice only), applied without a code.
    // Stripe takes either `discounts` or `allow_promotion_codes`, never both; codes stay off either way.
    ...(input.coupon ? { discounts: [{ coupon: input.coupon }] } : { allow_promotion_codes: false }),
    automatic_tax: { enabled: true },
    billing_address_collection: "auto",
    metadata: input.coupon ? { ...metadata, promo: input.coupon } : metadata,
    subscription_data: { metadata },
    ...(input.termsConsent
      ? { consent_collection: { terms_of_service: "required" }, custom_text: { terms_of_service_acceptance: { message: input.termsConsent } } }
      : {}),
  };
}

/**
 * Stripe refused the launch offer's coupon at Checkout (it doesn't exist, expired, or ran out of
 * redemptions): a 400/404 about the coupon or the discounts parameter.
 */
export function isCouponRefusal(error: unknown): boolean {
  return error instanceof StripeError && (error.status === 400 || error.status === 404) && /coupon|discounts/i.test(error.message);
}

/**
 * A completed Checkout Session's discount: the coupon, the cents taken off and the percent of the
 * first month (from Stripe's amounts), or null when nothing was taken off.
 */
export function checkoutPromo(session: Record<string, any>): { coupon: string; discountCents: number; percentOff: number } | null {
  const discountCents = Number(session.total_details?.amount_discount ?? 0);
  if (!Number.isFinite(discountCents) || discountCents <= 0) return null;
  const first = Array.isArray(session.discounts) ? session.discounts[0] : undefined;
  const coupon = idOf(first?.coupon) ?? idOf(first?.discount?.coupon) ?? (typeof session.metadata?.promo === "string" ? session.metadata.promo : undefined) ?? "discount";
  const subtotal = Number(session.amount_subtotal ?? 0);
  const percentOff = subtotal > 0 ? Math.round((discountCents / subtotal) * 100) : 0;
  return { coupon, discountCents: Math.round(discountCents), percentOff };
}

/** Stripe refused the terms-of-service consent (no terms URL in the account's public details). */
export function isTermsConsentRefusal(error: unknown): boolean {
  return error instanceof StripeError && error.status === 400 && /terms[ _]of[ _]service|consent_collection/i.test(error.message);
}

/** Whether a completed Checkout Session carries the customer's terms-of-service consent. */
export function termsAccepted(session: Record<string, any>): boolean {
  return session.consent?.terms_of_service === "accepted";
}

export async function createPlanCheckout(fetcher: Fetch, input: { secretKey: string; plan: string; price: string; successUrl: string; cancelUrl: string; campaign?: string; termsConsent?: string; coupon?: string; trial?: { days: number; promoEligible?: string; offerText?: string }; idempotencyKey: string }): Promise<{ id: string; url: string }> {
  const session = await stripeRequest(fetcher, input.secretKey, "POST", "/v1/checkout/sessions", planCheckoutParams(input), input.idempotencyKey);
  if (typeof session.url !== "string" || typeof session.id !== "string") throw new StripeError("Stripe didn't return a Checkout URL.", 502);
  return { id: session.id, url: session.url };
}

/** A Checkout Session id as Stripe makes them (the page passes it back from the success URL). */
export const CHECKOUT_SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;

/** The price id of a subscription's (first) item. */
export function subscriptionPrice(subscription: Record<string, any>): string | undefined {
  return idOf(subscription.items?.data?.[0]?.price);
}

/** The price ids on an invoice's lines, across API versions. */
export function invoicePrices(invoice: Record<string, any>): string[] {
  const lines = (invoice.lines?.data ?? []) as Array<Record<string, any>>;
  return lines.map((line) => idOf(line.price) ?? idOf(line.pricing?.price_details?.price)).filter((id): id is string => typeof id === "string");
}

/**
 * A dl.new plan subscription's state: active and past due keep the plan (Stripe retries a failed
 * renewal per its dunning settings), unpaid and canceled end it, incomplete hasn't started.
 */
export function planState(status: unknown): "active" | "past_due" | "canceled" {
  if (status === "active" || status === "trialing") return "active";
  if (status === "past_due") return "past_due";
  return "canceled";
}

/** The payment behind an invoice, for a refund: its PaymentIntent or charge, across API versions. */
export async function invoicePayment(fetcher: Fetch, secretKey: string, invoiceId: string): Promise<{ payment_intent: string } | { charge: string } | undefined> {
  const invoice = await stripeRequest(fetcher, secretKey, "GET", `/v1/invoices/${encodeURIComponent(invoiceId)}`);
  const intent = idOf(invoice.payment_intent);
  if (intent) return { payment_intent: intent };
  const charge = idOf(invoice.charge);
  if (charge) return { charge };
  // Newer API versions list an invoice's payments separately.
  const payments = await stripeRequest(fetcher, secretKey, "GET", "/v1/invoice_payments", { invoice: invoiceId });
  const paid = ((payments.data ?? []) as Array<Record<string, any>>).find((entry) => entry.status === "paid") ?? payments.data?.[0];
  const viaPayment = idOf(paid?.payment?.payment_intent);
  if (viaPayment) return { payment_intent: viaPayment };
  const viaCharge = idOf(paid?.payment?.charge);
  return viaCharge ? { charge: viaCharge } : undefined;
}

// ─── Card trials (trials.ts) ────────────────────────────────────────────────

/** A subscription's trial as Stripe has it: trialing, and its trial_end (Unix ms). */
export function subscriptionTrial(subscription: Record<string, any>): { trialing: boolean; trialEnd: number | null } {
  const trialing = subscription.status === "trialing";
  return { trialing, trialEnd: trialing && typeof subscription.trial_end === "number" ? subscription.trial_end * 1000 : null };
}

/** Whether a completed Checkout Session is a dl.new card trial: no payment taken, a trial on the subscription. */
export function isTrialCheckout(session: Record<string, any>): boolean {
  return session.metadata?.trial === "card" && session.payment_status === "no_payment_required";
}

/** The launch offer's coupon a trial Checkout was eligible for (started inside the window), or undefined. */
export function promoEligible(object: Record<string, any>): string | undefined {
  const value = object?.metadata?.promo_eligible;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Ends a card trial now, so Stripe makes the first real charge at once (`trial_end=now`), with the
 * launch offer's coupon on that charge when the Checkout was eligible. `error_if_incomplete`: a
 * declined card is a 402 and the subscription stays as it was (still trialing).
 */
export async function endTrialNow(fetcher: Fetch, secretKey: string, input: { subscriptionId: string; coupon?: string; idempotencyKey: string }): Promise<Record<string, any>> {
  return stripeRequest(
    fetcher,
    secretKey,
    "POST",
    `/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
    { trial_end: "now", proration_behavior: "none", payment_behavior: "error_if_incomplete", ...(input.coupon ? { discounts: [{ coupon: input.coupon }] } : {}) },
    input.idempotencyKey,
  );
}

/** Puts a coupon on a subscription (the next invoice: the first real charge after its trial). */
export async function attachCoupon(fetcher: Fetch, secretKey: string, input: { subscriptionId: string; coupon: string; idempotencyKey: string }): Promise<Record<string, any>> {
  return stripeRequest(fetcher, secretKey, "POST", `/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`, { discounts: [{ coupon: input.coupon }] }, input.idempotencyKey);
}

/** An invoice's discount as a percent of its subtotal (0 without one), across API versions. */
export function invoiceDiscountPercent(invoice: Record<string, any>): number {
  const amounts = (invoice.total_discount_amounts ?? []) as Array<{ amount?: number }>;
  const discount = amounts.reduce((sum, entry) => sum + (typeof entry.amount === "number" ? entry.amount : 0), 0);
  const subtotal = Number(invoice.subtotal ?? 0);
  return discount > 0 && subtotal > 0 ? Math.round((discount / subtotal) * 100) : 0;
}

/** What an invoice charged, in cents (amount_paid, else total). */
export function invoiceAmount(invoice: Record<string, any>): number {
  const value = Number(invoice.amount_paid ?? invoice.total ?? 0);
  return Number.isFinite(value) ? Math.round(value) : 0;
}
