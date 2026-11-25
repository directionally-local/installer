import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, createService, MODEL, type GitHubUserFixture, type Service } from "./harness.js";
import { signatureHeader } from "../src/stripe.js";
import { proDigestLine } from "../src/pro-funnel.js";
import { readFreeConfig } from "../src/config.js";
import { policyOf } from "../src/queue.js";

/**
 * dl Pro, phase 1: $7 a month for 4x the free open-models budget. A free account whose week of
 * DeepSeek is used up gets the prompt (Autopilot's 402, `dl status` and dl.new/account); Upgrade
 * starts a Checkout priced inline; the webhook moves the plan; and the funnel (saw the prompt,
 * clicked Upgrade, paid, cancelled) is counted per UTC day for /v1/admin/metrics and the digest.
 */

const DAY = 86_400_000;
const SECRET = "whsec_test_0123456789abcdef";
const BILLING = { STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_PRICE_TOPUP: "price_topup123", OPEN_ADMISSION: "true" };
const PROMPT = "You've hit this week's free limit. dl Pro: $7/month for higher limits and early access to new models.";
/** The prompt on a refusal: the same, naming the limit that ran out. */
const SPEND_PROMPT = PROMPT.replace("free limit.", "free $8 spending limit on DeepSeek V4.1 Flash.");
const PAGE = "https://dl.new/start";
const ORIGIN = "https://dl.new";
const STATE = "page-state-0123456789abcdef";

let counter = 0;

async function world(vars: Record<string, string> = {}) {
  const service = await createService({ ...BILLING, ...vars });
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const token = (await service.signIn({ id: 100, login: "alice" })).access_token;
  return { service, admin, token };
}

const chat = (service: Service, token: string) =>
  service.request("POST", "/v1/chat/completions", { token, ip: `10.9.0.${++counter % 250}`, body: { model: MODEL, messages: [{ role: "user", content: "hi" }] } });

async function errorOf(response: Response): Promise<Record<string, any>> {
  return ((await response.json()) as { error: Record<string, any> }).error;
}

async function useUpDeepseek(service: Service, admin: string, githubId = 100, usd = 8): Promise<void> {
  const response = await service.request("POST", `/admin/people/${githubId}/grant`, { token: admin, body: { deepseekSpentUsdThisWeek: usd } });
  assert.equal(response.status, 200, await response.clone().text());
}

async function deliver(service: Service, type: string, object: Record<string, unknown>, id = `evt_${++counter}`): Promise<Response> {
  const at = Math.floor(service.clock.now / 1000);
  const body = JSON.stringify({ id, object: "event", type, created: at, data: { object } });
  return service.request("POST", "/v1/billing/webhook", { body, headers: { "stripe-signature": await signatureHeader(SECRET, at, body) } });
}

const proSession = (githubId: number) => ({
  id: `cs_pro_${githubId}`,
  object: "checkout.session",
  mode: "subscription",
  client_reference_id: String(githubId),
  customer: `cus_${githubId}`,
  subscription: `sub_${githubId}`,
  payment_status: "paid",
  amount_subtotal: 700,
  amount_total: 700,
  metadata: { github_id: String(githubId), product: "pro" },
});

const subscription = (githubId: number, status: string, extra: Record<string, unknown> = {}) => ({
  id: `sub_${githubId}`,
  object: "subscription",
  customer: `cus_${githubId}`,
  status,
  cancel_at_period_end: false,
  metadata: { github_id: String(githubId), product: "pro" },
  ...extra,
});

async function funnel(service: Service, admin: string): Promise<{ days: Array<Record<string, number | string>>; activePro: number }> {
  const metrics = (await (await service.request("GET", "/v1/admin/metrics", { token: admin })).json()) as { proFunnel: { days: Array<Record<string, number | string>>; activePro: number } };
  return metrics.proFunnel;
}

async function today(service: Service, admin: string): Promise<Record<string, number | string>> {
  return (await funnel(service, admin)).days.at(-1)!;
}

describe("dl Pro phase 1: the prompt", () => {
  it("shows the prompt with the Upgrade link when a free account's week of open models is used up, counted once a day", async () => {
    const { service, admin, token } = await world();
    assert.equal((await chat(service, token)).status, 200);
    await useUpDeepseek(service, admin);
    const error = await errorOf(await chat(service, token));
    assert.equal(error.code, "quota_exceeded");
    assert.equal(error.message, `${SPEND_PROMPT} Upgrade: https://dl.new/account`);
    assert.deepEqual(error.proPrompt, { text: SPEND_PROMPT, price: "$7/month", upgradeUrl: "https://dl.new/account" });
    assert.equal(error.offers.pro.price, "$7/month");
    // A retry the same day is the same person seeing it.
    await chat(service, token);
    assert.equal((await today(service, admin)).seen, 1);
  });

  it("doesn't show it before the limit, on Pro, to admins, or while Pro isn't offered", async () => {
    const { service, admin, token } = await world();
    const me = async (t: string) => (await (await service.request("GET", "/v1/me", { token: t })).json()) as Record<string, any>;
    assert.equal((await me(token)).proPrompt, null, "not before the limit");
    await useUpDeepseek(service, admin, ADMIN_ID);
    assert.equal((await errorOf(await chat(service, admin))).proPrompt, undefined, "not for admins");
    await useUpDeepseek(service, admin);
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { proOffered: false } })).status, 200);
    const off = await errorOf(await chat(service, token));
    assert.equal(off.code, "quota_exceeded");
    assert.equal(off.proPrompt, undefined);
    assert.doesNotMatch(off.message, /dl Pro/);
    assert.equal((await me(token)).proPrompt, null);
    assert.equal((await today(service, admin)).seen, 0);
  });

  it("gives /v1/me the prompt for `dl status`, which counts it as seen only with ?prompt=shown", async () => {
    const { service, admin, token } = await world();
    await useUpDeepseek(service, admin);
    const body = (await (await service.request("GET", "/v1/me", { token })).json()) as Record<string, any>;
    assert.deepEqual(body.proPrompt, { text: PROMPT, price: "$7/month", upgradeUrl: "https://dl.new/account" });
    assert.equal((await today(service, admin)).seen, 0);
    await service.request("GET", "/v1/me?prompt=shown", { token });
    assert.equal((await today(service, admin)).seen, 1);
  });

  it("gives Pro 4x the free open-models budget, and no more GPT-6", async () => {
    const { service, admin, token } = await world();
    assert.equal((await deliver(service, "checkout.session.completed", proSession(100))).status, 200);
    const body = (await (await service.request("GET", "/v1/me", { token })).json()) as Record<string, any>;
    assert.equal(body.plan, "pro");
    assert.equal(body.budgets.deepseek.usdPerWeek, 32);
    assert.equal(body.budgets.gpt6.usdPerWeek, 2);
    // Past the free $8, Pro still works; the prompt is never shown to Pro.
    await useUpDeepseek(service, admin, 100, 8);
    assert.equal((await chat(service, token)).status, 200);
    await useUpDeepseek(service, admin, 100, 32);
    const error = await errorOf(await chat(service, token));
    assert.equal(error.code, "quota_exceeded");
    assert.equal(error.proPrompt, undefined);
    // The multiplier is a runtime setting.
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { proOpenModelsMultiplier: 5 } })).status, 200);
    assert.equal(((await (await service.request("GET", "/v1/me", { token })).json()) as Record<string, any>).budgets.deepseek.usdPerWeek, 40);
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { proOpenModelsMultiplier: 0.5 } })).status, 400);
  });
});

describe("dl Pro phase 1: Upgrade, payment and cancellation", () => {
  it("counts clicked, paid and cancelled once each, and the digest says so", async () => {
    const { service, admin, token } = await world();
    await useUpDeepseek(service, admin);
    await chat(service, token);
    // Upgrade: a subscription Checkout, $7 a month in USD, for this GitHub id.
    const checkout = await service.request("POST", "/v1/billing/checkout", { token, body: { product: "pro" } });
    assert.equal(checkout.status, 200, await checkout.clone().text());
    const form = service.calls.stripe.at(-1)!.form;
    assert.equal(form.get("mode"), "subscription");
    assert.equal(form.get("client_reference_id"), "100");
    assert.equal(form.get("line_items[0][price_data][currency]"), "usd");
    assert.equal(form.get("line_items[0][price_data][unit_amount]"), "700");
    assert.equal(form.get("line_items[0][price_data][recurring][interval]"), "month");
    assert.equal(form.get("line_items[0][price]"), null, "no Stripe Price id");
    assert.equal(form.get("discounts[0][coupon]"), null);
    assert.equal(form.get("allow_promotion_codes"), null);
    assert.equal(form.get("subscription_data[trial_period_days]"), null);

    assert.equal((await deliver(service, "checkout.session.completed", proSession(100))).status, 200);
    assert.equal(((await (await service.request("GET", "/v1/me", { token })).json()) as Record<string, any>).plan, "pro");
    // Set to end at the period's end (the Customer Portal), then ended: one cancellation.
    await deliver(service, "customer.subscription.updated", subscription(100, "active", { cancel_at_period_end: true }));
    await deliver(service, "customer.subscription.updated", subscription(100, "active", { cancel_at_period_end: true }));
    let day = await today(service, admin);
    assert.deepEqual([day.seen, day.clicked, day.paid, day.cancelled], [1, 1, 1, 1]);
    assert.equal((await funnel(service, admin)).activePro, 1, "still Pro until the period ends");
    service.clock.now += 60_000;
    await deliver(service, "customer.subscription.deleted", subscription(100, "canceled"));
    day = await today(service, admin);
    assert.equal(day.cancelled, 1);
    assert.equal((await funnel(service, admin)).activePro, 0);
    assert.equal(((await (await service.request("GET", "/v1/me", { token })).json()) as Record<string, any>).plan, "free");

    // The digest for that day, made the next morning (counts only, admins left out).
    const next = Math.floor(service.clock.now / DAY) * DAY + DAY + 60 * 60_000;
    const digest = await service.directory().dailyDigest(next, policyOf(readFreeConfig(service.env)), false);
    assert.match(digest!.text, /\nPaid: none\ndl Pro: 1 saw the prompt, 1 clicked Upgrade, 1 paid, 1 cancelled \(total active Pro: 0\)\n/);
  });

  it("refuses an unsigned or wrongly signed webhook", async () => {
    const { service, token } = await world();
    const body = JSON.stringify({ id: "evt_x", object: "event", type: "checkout.session.completed", created: Math.floor(service.clock.now / 1000), data: { object: proSession(100) } });
    assert.equal((await service.request("POST", "/v1/billing/webhook", { body })).status, 400);
    const forged = await signatureHeader("whsec_someone_else", Math.floor(service.clock.now / 1000), body);
    assert.equal((await service.request("POST", "/v1/billing/webhook", { body, headers: { "stripe-signature": forged } })).status, 400);
    assert.equal(((await (await service.request("GET", "/v1/me", { token })).json()) as Record<string, any>).plan, "free");
  });

  it("writes the digest line with numbers", () => {
    assert.equal(proDigestLine({ seen: 12, clicked: 3, paid: 1, cancelled: 0 }, 4), "dl Pro: 12 saw the prompt, 3 clicked Upgrade, 1 paid, 0 cancelled (total active Pro: 4)");
  });
});

describe("dl Pro phase 1: dl.new/account", () => {
  const ghCode = (user: GitHubUserFixture) => encodeURIComponent(JSON.stringify(user));

  async function webToken(service: Service, user: GitHubUserFixture): Promise<string> {
    const start = await service.request("GET", `/web/signin?return=${encodeURIComponent(PAGE)}&state=${STATE}`);
    const location = new URL(start.headers.get("location")!);
    const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
    let response = await service.request("GET", `/device/callback?code=${ghCode(user)}&state=${location.searchParams.get("state")}`, { headers: { cookie } });
    const page = await response.clone().text();
    if (page.includes('action="/device/details"')) {
      const ticket = /name="ticket" value="([^"]+)"/.exec(page)![1]!;
      response = await service.request("POST", "/device/details", { form: { ticket, email: "someone@example.com" } });
    }
    const code = response.headers.get("location")!.slice(`${PAGE}#signin=`.length);
    const session = await service.request("POST", "/web/session", { body: { code, state: STATE }, headers: { origin: ORIGIN } });
    return ((await session.json()) as { token: string }).token;
  }

  it("shows the plan and the prompt (counted), starts Checkout coming back to /account, and opens the portal", async () => {
    const { service, admin } = await world();
    const web = await webToken(service, { id: 200, login: "webby" });
    const meNow = async () => (await (await service.request("GET", "/web/me", { token: web, headers: { origin: ORIGIN } })).json()) as Record<string, any>;
    let me = await meNow();
    assert.equal(me.plan, "free");
    assert.equal(me.proPrompt, null);
    await useUpDeepseek(service, admin, 200);
    me = await meNow();
    assert.deepEqual(me.proPrompt, { text: PROMPT, price: "$7/month", upgradeUrl: "https://dl.new/account" });
    assert.equal((await today(service, admin)).seen, 1);

    const checkout = await service.request("POST", "/web/checkout", { token: web, body: { return: "account" }, headers: { origin: ORIGIN } });
    assert.equal(checkout.status, 200, await checkout.clone().text());
    const form = service.calls.stripe.at(-1)!.form;
    assert.equal(form.get("success_url"), "https://dl.new/account?checkout=done");
    assert.equal(form.get("cancel_url"), "https://dl.new/account?checkout=cancel");
    assert.equal(form.get("client_reference_id"), "200");
    assert.equal((await today(service, admin)).clicked, 1);

    assert.equal((await service.request("POST", "/web/portal", { token: web, headers: { origin: ORIGIN } })).status, 404, "nothing bought yet");
    await deliver(service, "checkout.session.completed", proSession(200));
    me = await meNow();
    assert.equal(me.plan, "pro");
    assert.equal(me.proPrompt, null);
    const portal = await service.request("POST", "/web/portal", { token: web, headers: { origin: ORIGIN } });
    assert.equal(portal.status, 200, await portal.clone().text());
    assert.equal(service.calls.stripe.at(-1)!.form.get("return_url"), "https://dl.new/account");
  });
});
