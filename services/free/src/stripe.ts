import { timingSafeEqual } from "../../shared/src/auth.js";
import type { StripeConfig } from "./config.js";

/**
 * Stripe, through its REST API with fetch (no SDK, so the Worker stays portable):
 *
 *   POST /v1/checkout/sessions          Checkout for Pro (a subscription) or a top-up (a payment),
 *                                       with Stripe Tax (`automatic_tax[enabled]=true`) and the
 *                                       billing address collected
 *   POST /v1/billing_portal/sessions    the Customer Portal, for cancelling or changing the card
 *
 * Prices are Stripe Price ids from config (STRIPE_PRICE_PRO, STRIPE_PRICE_TOPUP); see
 * scripts/stripe-setup.mjs. Webhooks are verified with STRIPE_WEBHOOK_SECRET (`verifyWebhook`).
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
export function checkoutParams(input: { product: Product; config: StripeConfig; githubId: number; login: string; customerId: string | null }): Record<string, unknown> {
  const { product, config } = input;
  const price = product === "pro" ? config.pricePro : config.priceTopup;
  const metadata = { github_id: String(input.githubId), github_login: input.login, product };
  return {
    mode: product === "pro" ? "subscription" : "payment",
    line_items: [{ price, quantity: 1 }],
    success_url: config.successUrl,
    cancel_url: config.cancelUrl,
    client_reference_id: String(input.githubId),
    metadata,
    automatic_tax: { enabled: true },
    billing_address_collection: "required",
    ...(input.customerId
      ? // Stripe Tax needs the address saved on an existing customer.
        { customer: input.customerId, customer_update: { address: "auto", name: "auto" } }
      : product === "topup"
        ? { customer_creation: "always" }
        : {}),
    ...(product === "pro" ? { subscription_data: { metadata } } : { payment_intent_data: { metadata } }),
  };
}

export async function createCheckout(
  fetcher: Fetch,
  input: { product: Product; config: StripeConfig; githubId: number; login: string; customerId: string | null; idempotencyKey: string },
): Promise<{ id: string; url: string }> {
  const session = await call(fetcher, input.config.secretKey!, "/v1/checkout/sessions", checkoutParams(input), input.idempotencyKey);
  if (typeof session.url !== "string" || typeof session.id !== "string") throw new StripeError("Stripe didn't return a Checkout URL.", 502);
  return { id: session.id, url: session.url };
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
  data: { object: Record<string, any> };
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
