#!/usr/bin/env node
/**
 * One-time Stripe setup for the free tier's paid plans, in TEST mode. Not run by CI or deploys.
 *
 *   STRIPE_SECRET_KEY=sk_test_... node services/free/scripts/stripe-setup.mjs \
 *     [--webhook https://free.directionallylocal.com/v1/billing/webhook]
 *
 * Creates, through Stripe's API:
 *   - Product "dl Pro" with a Price of $3.99 a month (recurring), tax behaviour exclusive
 *   - Product "dl top-up" with a one-time Price of $1.00 (bought 2 to 20 at a time), tax behaviour exclusive
 *   - with --webhook: an endpoint for checkout.session.completed, invoice.paid,
 *     invoice.payment_failed, customer.subscription.updated and customer.subscription.deleted
 *
 * Prints the values to set: STRIPE_PRICE_PRO, STRIPE_PRICE_TOPUP and, with --webhook,
 * STRIPE_WEBHOOK_SECRET (shown by Stripe only at creation). Refuses a live key: for live mode,
 * repeat the same steps in the Dashboard (or run this with a live key after removing the check,
 * deliberately). Each run creates new objects; run it once.
 */

const key = process.env.STRIPE_SECRET_KEY ?? "";
if (!key.startsWith("sk_test_") && !key.startsWith("rk_test_")) {
  console.error("Set STRIPE_SECRET_KEY to a test-mode key (sk_test_…). This script never touches live mode.");
  process.exit(2);
}
const webhookIndex = process.argv.indexOf("--webhook");
const webhookUrl = webhookIndex > 0 ? process.argv[webhookIndex + 1] : undefined;
if (webhookIndex > 0 && !/^https:\/\//.test(webhookUrl ?? "")) {
  console.error("--webhook needs the https URL of POST /v1/billing/webhook.");
  process.exit(2);
}

/** Stripe's form encoding: nested objects as a[b]=v, arrays as a[0]=v. */
function form(value, prefix = "", pairs = []) {
  if (value === undefined || value === null) return pairs;
  if (Array.isArray(value)) value.forEach((item, index) => form(item, `${prefix}[${index}]`, pairs));
  else if (typeof value === "object") for (const [name, child] of Object.entries(value)) form(child, prefix ? `${prefix}[${name}]` : name, pairs);
  else pairs.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
  return pairs;
}

async function stripe(path, body) {
  const response = await fetch(`https://api.stripe.com${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" },
    body: form(body).join("&"),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`${path}: ${json.error?.message ?? response.status}`);
  return json;
}

// txcd_10000000: "General - Electronically Supplied Services". Change it in the Dashboard if
// your tax adviser prefers a SaaS code.
const pro = await stripe("/v1/products", {
  name: "dl Pro",
  description: "More usage every week on the Directionally Local managed tier, every model.",
  tax_code: "txcd_10000000",
  metadata: { product: "pro" },
  default_price_data: { currency: "usd", unit_amount: 399, recurring: { interval: "month" }, tax_behavior: "exclusive" },
});
const topup = await stripe("/v1/products", {
  name: "dl top-up",
  description: "Each $1 adds $1.25 of usage, spent after the weekly allowance, valid 90 days.",
  tax_code: "txcd_10000000",
  metadata: { product: "topup" },
  default_price_data: { currency: "usd", unit_amount: 100, tax_behavior: "exclusive" },
});

console.log(`STRIPE_PRICE_PRO=${pro.default_price}`);
console.log(`STRIPE_PRICE_TOPUP=${topup.default_price}`);

if (webhookUrl) {
  const endpoint = await stripe("/v1/webhook_endpoints", {
    url: webhookUrl,
    description: "Directionally Local free tier billing",
    enabled_events: ["checkout.session.completed", "invoice.paid", "invoice.payment_failed", "customer.subscription.updated", "customer.subscription.deleted"],
  });
  console.log(`STRIPE_WEBHOOK_SECRET=${endpoint.secret}`);
}
