import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, allowServerKeys, completion, createService, MODEL, NOW, usage, type Service } from "./harness.js";
import { checkoutParams, formEncode, signatureHeader, verifyWebhook } from "../src/stripe.js";

const DAY = 86_400_000;
const SECRET = "whsec_test_0123456789abcdef";
const VARS = {
  STRIPE_SECRET_KEY: "sk_test_fake",
  STRIPE_WEBHOOK_SECRET: SECRET,
  STRIPE_PRICE_PRO: "price_pro123",
  STRIPE_PRICE_TOPUP: "price_topup123",
};

let eventCounter = 0;

async function service(vars: Record<string, string> = {}): Promise<Service> {
  return createService({ ...VARS, ...vars });
}

/** A person signed in, with a server key for chat (it outlives the clock jumps below) and an access token for billing. */
async function person(svc: Service, id = 100): Promise<{ access: string; key: string }> {
  const tokens = await svc.signIn({ id, login: `user${id}` }, { invite: await invite(svc) });
  allowServerKeys(svc, id);
  const key = await svc.request("POST", "/v1/keys", { token: tokens.access_token, body: { name: `k${id}` } });
  return { access: tokens.access_token, key: ((await key.json()) as { key: string }).key };
}

async function invite(svc: Service): Promise<string> {
  const admin = (await svc.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const response = await svc.request("POST", "/admin/invites", { token: admin, body: { count: 1 } });
  return ((await response.json()) as { invites: Array<{ code: string }> }).invites[0]!.code;
}

/** Delivers a Stripe event to the webhook, signed with the test secret (real HMAC-SHA256). */
async function deliver(svc: Service, type: string, object: Record<string, unknown>, options: { id?: string; created?: number } = {}): Promise<Response> {
  const event = { id: options.id ?? `evt_${++eventCounter}`, object: "event", type, created: options.created ?? Math.floor(svc.clock.now / 1000), data: { object } };
  const body = JSON.stringify(event);
  const header = await signatureHeader(SECRET, Math.floor(svc.clock.now / 1000), body);
  return svc.request("POST", "/v1/billing/webhook", { body, headers: { "stripe-signature": header } });
}

const proSession = (githubId: number, extra: Record<string, unknown> = {}) => ({
  id: `cs_pro_${githubId}`,
  object: "checkout.session",
  mode: "subscription",
  client_reference_id: String(githubId),
  customer: `cus_${githubId}`,
  subscription: `sub_${githubId}`,
  payment_status: "paid",
  amount_subtotal: 1000,
  amount_total: 1090,
  metadata: { github_id: String(githubId), product: "pro" },
  ...extra,
});

const topupSession = (githubId: number, id = `cs_topup_${githubId}`, extra: Record<string, unknown> = {}) => ({
  id,
  object: "checkout.session",
  mode: "payment",
  client_reference_id: String(githubId),
  customer: `cus_${githubId}`,
  payment_status: "paid",
  amount_subtotal: 300,
  amount_total: 327,
  metadata: { github_id: String(githubId), product: "topup" },
  ...extra,
});

const invoice = (githubId: number, id: string, periodEndSec: number) => ({
  id,
  object: "invoice",
  customer: `cus_${githubId}`,
  amount_paid: 1090,
  total_excluding_tax: 1000,
  parent: { subscription_details: { subscription: `sub_${githubId}`, metadata: { github_id: String(githubId), product: "pro" } } },
  lines: { data: [{ period: { start: periodEndSec - 30 * 86400, end: periodEndSec } }] },
});

const subscriptionObject = (githubId: number, status: string, extra: Record<string, unknown> = {}) => ({
  id: `sub_${githubId}`,
  object: "subscription",
  customer: `cus_${githubId}`,
  status,
  cancel_at_period_end: false,
  metadata: { github_id: String(githubId), product: "pro" },
  items: { data: [{ current_period_end: Math.floor((NOW + 30 * DAY) / 1000) }] },
  ...extra,
});

const me = async (svc: Service, token: string) => (await (await svc.request("GET", "/v1/me", { token, ip: `10.7.0.${++eventCounter % 250}` })).json()) as Record<string, any>;
const chat = (svc: Service, token: string) =>
  svc.request("POST", "/v1/chat/completions", { token, ip: `10.6.0.${++eventCounter % 250}`, body: { model: MODEL, messages: [{ role: "user", content: "hi" }] } });

describe("Stripe webhook signatures", () => {
  const body = JSON.stringify({ id: "evt_1", type: "invoice.paid", created: 1, data: { object: {} } });
  const now = 1_800_000_000_000;
  const t = now / 1000;

  it("accepts Stripe's signature over `<t>.<body>` with the endpoint secret", async () => {
    const header = await signatureHeader(SECRET, t, body);
    const verified = await verifyWebhook(body, header, SECRET, now);
    assert.ok("event" in verified);
    assert.equal(verified.event.id, "evt_1");
    // Several v1 signatures (a secret being rolled): any one may match.
    const rolled = `t=${t},v1=${"0".repeat(64)},${header.split(",")[1]}`;
    assert.ok("event" in (await verifyWebhook(body, rolled, SECRET, now)));
  });

  it("matches a signature computed independently", async () => {
    // HMAC-SHA256("whsec_test_0123456789abcdef", "1800000000.{}") computed with node:crypto.
    const { createHmac } = await import("node:crypto");
    const expected = createHmac("sha256", SECRET).update(`${t}.{}`).digest("hex");
    assert.equal(await signatureHeader(SECRET, t, "{}"), `t=${t},v1=${expected}`);
  });

  it("refuses a wrong secret, a changed body, an old timestamp and a malformed header", async () => {
    const header = await signatureHeader(SECRET, t, body);
    assert.deepEqual(await verifyWebhook(body, header, "whsec_other", now), { error: "signature mismatch" });
    assert.deepEqual(await verifyWebhook(body.replace("invoice.paid", "invoice.payment_failed"), header, SECRET, now), { error: "signature mismatch" });
    assert.deepEqual(await verifyWebhook(body, header, SECRET, now + 301_000), { error: "timestamp outside the tolerance" });
    assert.deepEqual(await verifyWebhook(body, "v1=abc", SECRET, now), { error: "malformed Stripe-Signature" });
    assert.deepEqual(await verifyWebhook(body, null, SECRET, now), { error: "missing Stripe-Signature" });
  });

  it("answers 400 to an unsigned delivery and 503 without a webhook secret", async () => {
    const svc = await service();
    const body = JSON.stringify({ id: "evt_x", type: "invoice.paid", created: 1, data: { object: {} } });
    const unsigned = await svc.request("POST", "/v1/billing/webhook", { body, headers: { "stripe-signature": `t=${Math.floor(NOW / 1000)},v1=${"a".repeat(64)}` } });
    assert.equal(unsigned.status, 400);
    assert.equal(((await unsigned.json()) as { error: { code: string } }).error.code, "invalid_signature");
    const bare = await createService();
    assert.equal((await bare.request("POST", "/v1/billing/webhook", { body })).status, 503);
  });
});

describe("Checkout and the portal", () => {
  it("encodes Stripe's nested form parameters", () => {
    assert.equal(formEncode({ a: 1, b: { c: "x y" }, d: [{ e: true }], f: undefined }), "a=1&b%5Bc%5D=x%20y&d%5B0%5D%5Be%5D=true");
  });

  it("creates a Pro subscription checkout with Stripe Tax and the billing address", async () => {
    const svc = await service();
    const { access } = await person(svc);
    const response = await svc.request("POST", "/v1/billing/checkout", { token: access, body: { product: "pro" } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    const call = svc.calls.stripe[0]!;
    assert.equal(call.path, "/v1/checkout/sessions");
    assert.equal(call.headers.authorization, "Bearer sk_test_fake");
    assert.match(call.headers["idempotency-key"]!, /^[0-9a-f-]{36}$/);
    const form = Object.fromEntries(call.form.entries());
    assert.deepEqual(form, {
      mode: "subscription",
      "line_items[0][price]": "price_pro123",
      "line_items[0][quantity]": "1",
      success_url: "https://dl.new/billing/success",
      cancel_url: "https://dl.new/billing/cancel",
      client_reference_id: "100",
      "metadata[github_id]": "100",
      "metadata[github_login]": "user100",
      "metadata[product]": "pro",
      "automatic_tax[enabled]": "true",
      billing_address_collection: "required",
      "subscription_data[metadata][github_id]": "100",
      "subscription_data[metadata][github_login]": "user100",
      "subscription_data[metadata][product]": "pro",
    });
  });

  it("creates a one-time top-up checkout, reusing the Stripe customer once there is one", async () => {
    const svc = await service();
    const { access } = await person(svc);
    await svc.request("POST", "/v1/billing/checkout", { token: access, body: { product: "topup" } });
    let form = Object.fromEntries(svc.calls.stripe[0]!.form.entries());
    assert.equal(form.mode, "payment");
    assert.equal(form["line_items[0][price]"], "price_topup123");
    assert.equal(form.customer_creation, "always");
    assert.equal(form["payment_intent_data[metadata][github_id]"], "100");
    assert.equal(form["automatic_tax[enabled]"], "true");
    assert.equal(form.success_url, "https://dl.new/billing/success?product=topup", "the success page says tokens were added, not Pro");

    await deliver(svc, "checkout.session.completed", topupSession(100));
    await svc.request("POST", "/v1/billing/checkout", { token: access, body: { product: "topup" } });
    form = Object.fromEntries(svc.calls.stripe[1]!.form.entries());
    assert.equal(form.customer, "cus_100");
    assert.equal(form["customer_update[address]"], "auto");
    assert.equal(form.customer_creation, undefined);
    assert.deepEqual(checkoutParams({ product: "pro", config: { secretKey: "k", webhookSecret: undefined, pricePro: "price_p", priceTopup: "price_t", successUrl: "https://s", cancelUrl: "https://c", portalReturnUrl: "https://r" }, githubId: 1, login: "a", customerId: null }).automatic_tax, { enabled: true });
  });

  it("refuses bad requests, server keys, a second Pro, and says when billing isn't set up", async () => {
    const svc = await service();
    const { access, key } = await person(svc);
    assert.equal((await svc.request("POST", "/v1/billing/checkout", { token: access, body: { product: "gold" } })).status, 400);
    assert.equal((await svc.request("POST", "/v1/billing/checkout", { token: key, body: { product: "pro" } })).status, 401);
    assert.equal((await svc.request("POST", "/v1/billing/checkout", { body: { product: "pro" } })).status, 401);
    await deliver(svc, "checkout.session.completed", proSession(100));
    const again = await svc.request("POST", "/v1/billing/checkout", { token: access, body: { product: "pro" } });
    assert.equal(again.status, 409);
    assert.equal(((await again.json()) as { error: { code: string } }).error.code, "already_pro");

    const bare = await createService();
    const tokens = await bare.signIn({ id: 100, login: "u" }, { invite: await invite(bare) });
    const unavailable = await bare.request("POST", "/v1/billing/checkout", { token: tokens.access_token, body: { product: "pro" } });
    assert.equal(unavailable.status, 503);
    assert.equal(((await unavailable.json()) as { error: { code: string } }).error.code, "billing_unavailable");
  });

  it("answers 502 when Stripe refuses", async () => {
    const svc = await service();
    const { access } = await person(svc);
    svc.setStripe(() => Response.json({ error: { message: "No such price" } }, { status: 400 }));
    const response = await svc.request("POST", "/v1/billing/checkout", { token: access, body: { product: "pro" } });
    assert.equal(response.status, 502);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "billing_error");
  });

  it("opens the Customer Portal for someone who has bought something", async () => {
    const svc = await service();
    const { access } = await person(svc);
    const none = await svc.request("POST", "/v1/billing/portal", { token: access });
    assert.equal(none.status, 404);
    await deliver(svc, "checkout.session.completed", proSession(100));
    const response = await svc.request("POST", "/v1/billing/portal", { token: access });
    assert.deepEqual(await response.json(), { url: "https://billing.stripe.com/p/session/test_1" });
    const call = svc.calls.stripe.at(-1)!;
    assert.equal(call.path, "/v1/billing_portal/sessions");
    assert.deepEqual(Object.fromEntries(call.form.entries()), { customer: "cus_100", return_url: "https://dl.new/billing" });
  });
});

describe("Pro through its payment events", () => {
  it("goes Pro on checkout, renews on invoice.paid, drops to free (not to nothing) on a failed payment, and ends on deletion", async () => {
    const svc = await service();
    const { key } = await person(svc);
    assert.equal((await me(svc, key)).plan, "free");

    assert.equal((await deliver(svc, "checkout.session.completed", proSession(100))).status, 200);
    let body = await me(svc, key);
    assert.equal(body.plan, "pro");
    assert.equal(body.allowance.tokensPerWeek, 300_000_000);
    assert.equal(body.allowance.usdPerWeek, 6, "Pro's weekly GPT-6 budget (PRO_WEEKLY_USD_CAP, default $6)");
    assert.equal(body.budgets.deepseek.usdPerWeek, 40, "Pro's weekly DeepSeek budget (PRO_DEEPSEEK_WEEKLY_USD_CAP, default $40)");

    const periodEnd = Math.floor((NOW + 30 * DAY) / 1000);
    await deliver(svc, "invoice.paid", invoice(100, "in_1", periodEnd));
    body = await me(svc, key);
    assert.equal(body.pro.periodEnd, new Date(periodEnd * 1000).toISOString());

    svc.clock.now += 60_000;
    await deliver(svc, "invoice.payment_failed", invoice(100, "in_2", periodEnd));
    body = await me(svc, key);
    assert.equal(body.plan, "free");
    assert.equal(body.allowance.tokensPerWeek, 50_000_000);
    assert.equal((await chat(svc, key)).status, 200, "still has the free allowance");

    svc.clock.now += 60_000;
    await deliver(svc, "customer.subscription.updated", subscriptionObject(100, "active"));
    assert.equal((await me(svc, key)).plan, "pro");

    svc.clock.now += 60_000;
    await deliver(svc, "customer.subscription.updated", subscriptionObject(100, "active", { cancel_at_period_end: true }));
    body = await me(svc, key);
    assert.equal(body.plan, "pro", "cancelled at period end: Pro until then");
    assert.equal(body.pro.cancelAtPeriodEnd, true);

    svc.clock.now += 60_000;
    await deliver(svc, "customer.subscription.deleted", subscriptionObject(100, "canceled"));
    assert.equal((await me(svc, key)).plan, "free");
  });

  it("ignores an older event that arrives after a newer one", async () => {
    const svc = await service();
    const { key } = await person(svc);
    const at = Math.floor(NOW / 1000);
    await deliver(svc, "checkout.session.completed", proSession(100), { created: at });
    await deliver(svc, "customer.subscription.deleted", subscriptionObject(100, "canceled"), { created: at + 100 });
    const late = await deliver(svc, "customer.subscription.updated", subscriptionObject(100, "active"), { created: at + 50 });
    assert.equal(((await late.json()) as { outcome: string }).outcome, "stale");
    assert.equal((await me(svc, key)).plan, "free");
  });

  it("ends Pro after its paid period (plus 3 days' grace) even if the cancel event never comes", async () => {
    const svc = await service();
    const { key } = await person(svc);
    await deliver(svc, "checkout.session.completed", proSession(100));
    await deliver(svc, "invoice.paid", invoice(100, "in_1", Math.floor((NOW + 5 * DAY) / 1000)));
    svc.clock.now = NOW + 7 * DAY;
    assert.equal((await me(svc, key)).plan, "pro");
    svc.clock.now = NOW + 9 * DAY;
    assert.equal((await me(svc, key)).plan, "free");
  });

  it("lets a Pro subscriber create and use server keys, and only while Pro lasts", async () => {
    const svc = await service();
    const tokens = await svc.signIn({ id: 200, login: "user200" }, { invite: await invite(svc) });
    const create = (name: string) => svc.request("POST", "/v1/keys", { token: tokens.access_token, body: { name } });
    assert.equal(((await (await create("before")).json()) as { error: { code: string } }).error.code, "server_keys_unavailable");
    await deliver(svc, "checkout.session.completed", proSession(200));
    await deliver(svc, "invoice.paid", invoice(200, "in_1", Math.floor((NOW + 5 * DAY) / 1000)));
    const created = await create("pro-box");
    assert.equal(created.status, 201);
    const { key } = (await created.json()) as { key: string };
    assert.equal((await chat(svc, key)).status, 200);
    svc.clock.now = NOW + 9 * DAY;
    const refused = await chat(svc, key);
    assert.equal(refused.status, 403);
    assert.equal(((await refused.json()) as { error: { code: string } }).error.code, "server_keys_unavailable");
  });

  it("handles each event id once", async () => {
    const svc = await service();
    await person(svc);
    await deliver(svc, "checkout.session.completed", proSession(100));
    const first = await deliver(svc, "invoice.paid", invoice(100, "in_1", Math.floor((NOW + 30 * DAY) / 1000)), { id: "evt_same" });
    assert.deepEqual(await first.json(), { received: true, outcome: "pro_active" });
    const again = await deliver(svc, "invoice.paid", invoice(100, "in_1", Math.floor((NOW + 30 * DAY) / 1000)), { id: "evt_same" });
    assert.deepEqual(await again.json(), { received: true, duplicate: true });
    const spend = (await (await svc.request("GET", "/admin/dashboard/paid.csv", { token: (await svc.signIn({ id: ADMIN_ID, login: "owner" })).access_token })).text()).trim().split("\r\n");
    assert.match(spend[1]!, /^1,0,0,10,10,/, "one subscriber, $10 revenue once (before tax)");
  });

  it("uses Pro's weekly allowance as paid usage, outside the free budget", async () => {
    const svc = await service({ GLOBAL_WEEKLY_USD_CAP: "1" });
    const free = await person(svc, 100);
    const pro = await person(svc, 101);
    await deliver(svc, "checkout.session.completed", proSession(101));
    svc.setOpenRouter(() => completion(usage(1000, 1000, 0, 2)));
    // Pro spends $2 twice: past the $1 free cap, and it doesn't count toward it.
    assert.equal((await chat(svc, pro.key)).status, 200);
    assert.equal((await chat(svc, pro.key)).status, 200);
    assert.equal((await chat(svc, free.key)).status, 200, "free spend is still $0");
    assert.equal((await chat(svc, free.key)).status, 503, "now the free $1 cap is reached");
    assert.equal((await chat(svc, pro.key)).status, 200, "Pro carries on");
    const spend = svc.directory().spend(svc.clock.now);
    const summary = await spend;
    assert.equal(summary.spentUsd, 2);
    assert.equal(summary.paidUsd, 6);
    assert.equal(summary.paidRequests, 3);
  });
});

describe("top-ups", () => {
  it("an old token top-up checkout adds 50M tokens for 30 days, used after the weekly allowance, then expires", async () => {
    // DeepSeek has no token cap: its week ends at its dollar budget.
    const svc = await service({ DEEPSEEK_WEEKLY_USD_CAP: "0.01" });
    const { key } = await person(svc);
    svc.setOpenRouter(() => completion(usage(20_000, 20_000, 0, 0.01)));
    assert.equal((await chat(svc, key)).status, 200, "the weekly allowance first");
    assert.equal((await chat(svc, key)).status, 402, "used up, no top-up yet");

    const purchase = await deliver(svc, "checkout.session.completed", topupSession(100));
    assert.equal(((await purchase.json()) as { outcome: string }).outcome, "topup_granted");
    assert.equal((await me(svc, key)).topupTokensLeft, 50_000_000);

    assert.equal((await chat(svc, key)).status, 200, "now from the top-up");
    const after = await me(svc, key);
    assert.equal(after.topupTokensLeft, 50_000_000 - 40_000);
    assert.equal(after.pools.deepseek.usedThisWeek, 40_000, "the week's counter is unchanged");
    assert.equal((await svc.directory().spend(svc.clock.now)).paidRequests, 1, "top-up use is paid usage");

    // A second delivery of the same purchase (a new event id, same session) doesn't add twice.
    await deliver(svc, "checkout.session.completed", topupSession(100));
    assert.equal((await me(svc, key)).topupTokensLeft, 50_000_000 - 40_000);

    // 30 days later it's gone.
    svc.clock.now = NOW + 30 * DAY + 1000;
    assert.equal((await me(svc, key)).topupTokensLeft, 0);
    svc.clock.now = NOW + 29 * DAY;
    assert.equal((await me(svc, key)).topupTokensLeft, 50_000_000 - 40_000);
  });

  it("isn't granted for an unpaid session", async () => {
    const svc = await service();
    const { key } = await person(svc);
    const response = await deliver(svc, "checkout.session.completed", topupSession(100, "cs_unpaid", { payment_status: "unpaid" }));
    assert.equal(((await response.json()) as { outcome: string }).outcome, "unpaid");
    assert.equal((await me(svc, key)).topupTokensLeft, 0);
  });

  it("works while the free budget is used up or the person is queued", async () => {
    const svc = await service({ GLOBAL_WEEKLY_USD_CAP: "1", OPEN_ADMISSION: "true" });
    svc.setOpenRouter(() => completion(usage(10, 10, 0, 1)));
    const free = await person(svc, 100);
    assert.equal((await chat(svc, free.key)).status, 200); // $1: the free cap and the queue threshold
    assert.equal((await chat(svc, free.key)).status, 503);
    await deliver(svc, "checkout.session.completed", topupSession(100));
    assert.equal((await chat(svc, free.key)).status, 200, "a top-up is paid usage");

    // An open sign-up now waits in line; a top-up or Pro lets them work anyway.
    const queuedTokens = await svc.signIn({ id: 300, login: "late" });
    allowServerKeys(svc, 300);
    const keyResponse = await svc.request("POST", "/v1/keys", { token: queuedTokens.access_token, body: { name: "k" } });
    const queuedKey = ((await keyResponse.json()) as { key: string }).key;
    const refused = await chat(svc, queuedKey);
    assert.equal(refused.status, 402);
    assert.equal(((await refused.json()) as { error: { code: string } }).error.code, "free_tier_queued");
    await deliver(svc, "checkout.session.completed", proSession(300));
    assert.equal((await chat(svc, queuedKey)).status, 200);
    assert.equal((await me(svc, queuedKey)).queue, null, "Pro isn't waiting for anything");
  });
});

describe("the dashboard's paid section", () => {
  it("shows subscribers, top-ups, revenue and paid usage cost", async () => {
    const svc = await service();
    const pro = await person(svc, 100);
    await person(svc, 101);
    await deliver(svc, "checkout.session.completed", proSession(100));
    await deliver(svc, "invoice.paid", invoice(100, "in_1", Math.floor((NOW + 30 * DAY) / 1000)));
    await deliver(svc, "checkout.session.completed", topupSession(101));
    svc.setOpenRouter(() => completion(usage(10, 10, 0, 0.25)));
    await chat(svc, pro.key);
    const admin = (await svc.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const html = await (await svc.request("GET", "/admin?view=full", { token: admin })).text();
    assert.match(html, /Pro subscribers<b>1<\/b>/);
    assert.match(html, /Top-ups<b>1 <span class="muted">this week<\/span><\/b>/);
    assert.match(html, /Revenue, before tax<b>\$13\.00 <span class="muted">this week<\/span><\/b>/);
    assert.match(html, /Paid usage cost<b>\$0\.250 <span class="muted">this week<\/span><\/b>/);
  });
});

describe("payment alert", () => {
  const emailed = (svc: Service) =>
    svc.calls.emails.map((email) => {
      const [head, body] = email.raw.split("\r\n\r\n") as [string, string];
      const subject = /\r\nSubject: ([^\r\n]*)\r\n/.exec(head)![1]!;
      const text = new TextDecoder().decode(Uint8Array.from(atob(body.replace(/\r\n/g, "")), (char) => char.charCodeAt(0)));
      return { subject, text };
    }).filter((email) => email.subject.startsWith("dl: "));

  it("emails the owner once per payment: who, what, how much, and the running totals", async () => {
    const svc = await createService({ ...VARS, ALERT_EMAIL_TO: "owner@example.com" }, { email: true });
    await person(svc, 100);
    await person(svc, 101);
    await deliver(svc, "checkout.session.completed", topupSession(100, "cs_t1", { metadata: { github_id: "100", product: "topup", topup_kind: "usd" } }));
    let mails = emailed(svc);
    assert.equal(mails.length, 1);
    assert.equal(mails[0]!.subject, "dl: @user100 paid $3 (top-up)");
    assert.match(mails[0]!.text, /@user100 paid \$3 for a top-up/);
    assert.match(mails[0]!.text, /All time: 1 payment from 1 person, \$3 before tax/);

    await deliver(svc, "checkout.session.completed", proSession(101));
    assert.equal(emailed(svc).length, 1, "the Pro checkout itself isn't the payment; its invoice is");
    const periodEnd = Math.floor((NOW + 30 * DAY) / 1000);
    await deliver(svc, "invoice.paid", { ...invoice(101, "in_1", periodEnd), billing_reason: "subscription_create" });
    await deliver(svc, "invoice.paid", { ...invoice(101, "in_1", periodEnd), billing_reason: "subscription_create" }, { id: "evt_replay" });
    await deliver(svc, "invoice.paid", { ...invoice(101, "in_2", periodEnd), billing_reason: "subscription_cycle" });
    mails = emailed(svc);
    assert.deepEqual(mails.map((m) => m.subject), ["dl: @user100 paid $3 (top-up)", "dl: @user101 paid $10 (Pro)", "dl: @user101 paid $10 (Pro renewal)"], "a replayed invoice under a new event id isn't a second email");
    assert.match(mails[2]!.text, /All time: 3 payments from 2 people, \$23 before tax/);
  });
});
