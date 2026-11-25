import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, completion, createService, luminalUsage, MODEL, type Service } from "./harness.js";
import { buy, DL, emailSignIn, FakeStripe, PAID_VARS, webhook } from "./paid-fixtures.js";
import { activePromoCoupon, PROMO_DEFAULTS, promoPrice, promoView, welcomePromoLine } from "../src/plan-prices.js";
import { checkoutPromo } from "../src/stripe.js";
import { readFreeConfig } from "../src/config.js";
import { parseSettingsUpdate } from "../src/runtime-config.js";

/**
 * dl.new's launch offer (Black Friday 2026): 50% off the first month on every plan for Checkouts
 * started from Fri 27 Nov 00:00 UTC to Mon 30 Nov 23:59:59 UTC, as a Stripe coupon applied
 * without a code; and `freeForever`, the accounts exempt from the end of free tokens.
 */

const START = Date.UTC(2026, 10, 27);
const END = Date.UTC(2026, 11, 1);
const INSIDE = Date.UTC(2026, 10, 28, 15);

async function world(vars: Record<string, string> = {}, now = INSIDE) {
  const service = await createService({ ...PAID_VARS, ALERT_EMAIL_TO: "owner@example.com", ...vars }, { userEmail: true, email: true });
  service.clock.now = now;
  const stripe = new FakeStripe(service);
  return { service, stripe };
}

async function admin(service: Service): Promise<string> {
  return (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
}

async function plans(service: Service): Promise<Record<string, any>> {
  const response = await service.request("GET", "/web/plans", { headers: DL });
  assert.equal(response.status, 200);
  return (await response.json()) as Record<string, any>;
}

async function checkoutForm(service: Service, stripe: FakeStripe, plan = "plus"): Promise<URLSearchParams> {
  const response = await service.request("POST", "/web/checkout/plan", { body: { plan }, headers: DL });
  assert.equal(response.status, 200, await response.clone().text());
  return stripe.sessions.get(((await response.json()) as { sessionId: string }).sessionId)!.form;
}

function welcomeTo(service: Service, to: string): string {
  const message = service.calls.userEmail.find((entry) => entry.to === to && entry.subject === "your dl.new key is ready");
  assert.ok(message, `no welcome to ${to}`);
  return String(message.text);
}

/** The owner's alert emails, decoded (subject and body). */
function alerts(service: Service): string[] {
  return service.calls.emails.map((message) => {
    const [head, body = ""] = message.raw.split("\r\n\r\n");
    return `${head}\n${Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8")}`;
  });
}

const config = readFreeConfig({ TOKEN_SIGNING_KEY: "x".repeat(32), OPENROUTER_API_KEY: "k", GITHUB_CLIENT_ID: "i", GITHUB_CLIENT_SECRET: "s" });

describe("the launch offer: window", () => {
  it("defaults to 50% off with coupon dlnew-bf-2026 from 27 Nov 00:00 UTC up to 1 Dec 00:00 UTC", () => {
    assert.equal(config.promoCouponId, "dlnew-bf-2026");
    assert.equal(config.promoStartsAt, START);
    assert.equal(config.promoEndsAt, END);
    assert.equal(config.promoPercentOff, 50);
    assert.equal(config.promoLabel, "first month, ends Mon 30 Nov");
    assert.deepEqual({ ...PROMO_DEFAULTS }, { promoCouponId: "dlnew-bf-2026", promoStartsAt: START, promoEndsAt: END, promoPercentOff: 50, promoLabel: "first month, ends Mon 30 Nov" });
  });

  it("is on from the first millisecond of Fri 27 Nov to the last of Mon 30 Nov, and off either side", () => {
    assert.equal(activePromoCoupon(config, START - 1), undefined, "Thu 26 Nov 23:59:59.999");
    assert.equal(activePromoCoupon(config, START), "dlnew-bf-2026", "Fri 27 Nov 00:00");
    assert.equal(activePromoCoupon(config, Date.UTC(2026, 10, 30, 23, 59, 59)), "dlnew-bf-2026", "Mon 30 Nov 23:59:59");
    assert.equal(activePromoCoupon(config, END - 1), "dlnew-bf-2026");
    assert.equal(activePromoCoupon(config, END), undefined, "Tue 1 Dec 00:00");
    assert.equal(activePromoCoupon({ ...config, promoCouponId: undefined }, INSIDE), undefined, "coupon none: off");
    assert.equal(activePromoCoupon({ ...config, promoStartsAt: undefined }, INSIDE), undefined);
    assert.deepEqual(promoView(config, END), { active: false, percentOff: null, label: null, endsAt: null });
    assert.deepEqual(promoView(config, START), { active: true, percentOff: 50, label: "first month, ends Mon 30 Nov", endsAt: "2026-12-01T00:00:00.000Z" });
  });

  it("prices the first month at 3.50, 10 and 30", () => {
    assert.deepEqual([7, 20, 60].map((price) => promoPrice(price, 50)), [3.5, 10, 30]);
    assert.equal(promoPrice(7, 30), 4.9);
  });

  it("takes the settings from the env and the admin, and refuses bad values", () => {
    const env = readFreeConfig({ TOKEN_SIGNING_KEY: "x".repeat(32), GITHUB_CLIENT_ID: "i", GITHUB_CLIENT_SECRET: "s", PROMO_COUPON_ID: "none", PROMO_PERCENT_OFF: "30", FREE_FOREVER: "123, 456" });
    assert.equal(env.promoCouponId, undefined);
    assert.equal(env.promoPercentOff, 30);
    assert.deepEqual(env.freeForever, [123, 456]);
    assert.throws(() => readFreeConfig({ TOKEN_SIGNING_KEY: "x".repeat(32), GITHUB_CLIENT_ID: "i", GITHUB_CLIENT_SECRET: "s", PROMO_PERCENT_OFF: "0" }), /PROMO_PERCENT_OFF/);
    assert.throws(() => readFreeConfig({ TOKEN_SIGNING_KEY: "x".repeat(32), GITHUB_CLIENT_ID: "i", GITHUB_CLIENT_SECRET: "s", FREE_FOREVER: "octocat" }), /FREE_FOREVER/);
    assert.deepEqual(parseSettingsUpdate({ promoCouponId: "none", promoPercentOff: 40, promoLabel: " first month ", freeForever: [12, "34", 12] }), {
      changes: [
        { key: "promoCouponId", value: null },
        { key: "promoPercentOff", value: 40 },
        { key: "promoLabel", value: "first month" },
        { key: "freeForever", value: [12, 34] },
      ],
    });
    for (const bad of [{ promoCouponId: "bad coupon!" }, { promoPercentOff: 0 }, { promoPercentOff: 101 }, { promoLabel: "" }, { freeForever: ["octocat"] }, { freeForever: 12 }]) {
      assert.ok("error" in parseSettingsUpdate(bad), JSON.stringify(bad));
    }
  });
});

describe("the launch offer: plan cards", () => {
  it("shows nothing outside the window", async () => {
    const { service } = await world({}, START - 1);
    const body = await plans(service);
    assert.deepEqual(body.promo, { active: false, percentOff: null, label: null, endsAt: null });
    assert.deepEqual(body.plans.map((plan: any) => plan.promoPriceUsd), [null, null, null]);
    service.clock.now = END;
    assert.equal((await plans(service)).promo.active, false);
  });

  it("shows the offer and each plan's first-month price inside it, on /web/plans and /v1/plans", async () => {
    const { service } = await world();
    const body = await plans(service);
    assert.deepEqual(body.promo, { active: true, percentOff: 50, label: "first month, ends Mon 30 Nov", endsAt: "2026-12-01T00:00:00.000Z" });
    assert.deepEqual(body.plans.map((plan: any) => [plan.id, plan.priceUsd, plan.promoPriceUsd]), [["starter", 7, 3.5], ["plus", 20, 10], ["max", 60, 30]]);
    const pub = (await (await service.request("GET", "/v1/plans")).json()) as Record<string, any>;
    assert.equal(pub.promo.active, true);
    assert.deepEqual(pub.plans.map((plan: any) => [plan.id, plan.priceUsd, plan.promoPriceUsd]), [["starter", 7, 3.5], ["plus", 20, 10], ["max", 60, 30]]);
  });

  it("stops showing it when the owner turns it off", async () => {
    const { service } = await world();
    assert.equal((await service.request("POST", "/admin/config", { token: await admin(service), body: { promoCouponId: "none" } })).status, 200);
    assert.equal((await plans(service)).promo.active, false);
  });
});

describe("the launch offer: Checkout", () => {
  it("puts the coupon on plan Checkouts inside the window, with promotion codes still off", async () => {
    const { service, stripe } = await world();
    const form = await checkoutForm(service, stripe, "max");
    assert.equal(form.get("discounts[0][coupon]"), "dlnew-bf-2026");
    // Stripe takes discounts or allow_promotion_codes, never both; with discounts, codes can't be entered.
    assert.equal(form.get("allow_promotion_codes"), null);
    assert.equal(form.get("metadata[promo]"), "dlnew-bf-2026");
    assert.equal(form.get("metadata[plan]"), "max");
    assert.equal(form.get("line_items[0][price]"), "price_max123", "the full price; the coupon takes off the first month");
  });

  it("uses no coupon before or after the window", async () => {
    const { service, stripe } = await world({}, START - 1);
    let form = await checkoutForm(service, stripe);
    assert.equal(form.get("discounts[0][coupon]"), null);
    assert.equal(form.get("allow_promotion_codes"), "false");
    service.clock.now = END;
    form = await checkoutForm(service, stripe);
    assert.equal(form.get("discounts[0][coupon]"), null);
    assert.equal(form.get("metadata[promo]"), null);
  });

  it("never fails Checkout when Stripe refuses the coupon: full price, the offer off, the owner told", async () => {
    const { service, stripe } = await world();
    stripe.coupons.clear();
    const warned: unknown[][] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warned.push(args);
    let form: URLSearchParams;
    try {
      form = await checkoutForm(service, stripe, "starter");
    } finally {
      console.warn = warn;
    }
    assert.equal(form.get("discounts[0][coupon]"), null, "retried without the coupon");
    assert.equal(form.get("allow_promotion_codes"), "false");
    assert.match(String(warned[0]?.[0]), /coupon/);
    const offAlerts = alerts(service).filter((text) => text.includes("launch offer turned off"));
    assert.equal(offAlerts.length, 1);
    assert.match(offAlerts[0]!, /POST \/admin\/config \{"promoCouponId": "dlnew-bf-2026"\}/);
    const owner = await admin(service);
    const settings = (await (await service.request("GET", "/admin/config", { token: owner })).json()) as any;
    assert.equal(settings.effective.promoCouponId, null);
    // The page stops promising it, and the next Checkout doesn't ask Stripe again.
    assert.equal((await plans(service)).promo.active, false);
    const before = service.calls.stripe.filter((call) => call.path === "/v1/checkout/sessions").length;
    assert.equal((await checkoutForm(service, stripe, "plus")).get("discounts[0][coupon]"), null);
    assert.equal(service.calls.stripe.filter((call) => call.path === "/v1/checkout/sessions").length, before + 1);
    assert.equal(service.calls.emails.filter((message) => message.raw.includes("launch offer turned off")).length, 1, "alerted once");
    // Back on once the coupon exists.
    stripe.coupons.set("dlnew-bf-2026", 50);
    assert.equal((await service.request("POST", "/admin/config", { token: owner, body: { promoCouponId: "dlnew-bf-2026" } })).status, 200);
    assert.equal((await plans(service)).promo.active, true);
    assert.equal((await checkoutForm(service, stripe, "plus")).get("discounts[0][coupon]"), "dlnew-bf-2026");
  });

  it("still fails as before on other Stripe errors", async () => {
    const { service } = await world();
    service.setStripe(() => Response.json({ error: { message: "Something else went wrong" } }, { status: 500 }));
    const response = await service.request("POST", "/web/checkout/plan", { body: { plan: "plus" }, headers: DL });
    assert.equal(response.status, 502);
  });
});

describe("the launch offer: after paying", () => {
  it("records the discount on the payment, shows it to the admin and says it in the welcome email", async () => {
    const { service, stripe } = await world();
    const session = await buy(service, stripe, "plus", "bf@example.com");
    assert.equal(session.amount_total, 1000);
    await emailSignIn(service, "bf@example.com", session.id);
    await service.settle();
    const text = welcomeTo(service, "bf@example.com");
    assert.ok(text.includes("thanks for subscribing to dl.new Plus. Your first month was 50% off. It renews at $20/mo.\n"), text);
    const owner = await admin(service);
    const claimed = (await (await service.request("GET", "/admin/paid/checkouts?status=claimed", { token: owner })).json()) as any;
    assert.deepEqual(claimed.checkouts[0].promo, { coupon: "dlnew-bf-2026", discountCents: 1000, percentOff: 50 });
    assert.equal(claimed.checkouts[0].amountCents, 1000);
  });

  it("has no offer line or promo for a full-price payment", async () => {
    const { service, stripe } = await world({}, START - 1);
    const session = await buy(service, stripe, "starter", "full@example.com");
    assert.equal(session.amount_total, 700);
    await emailSignIn(service, "full@example.com", session.id);
    await service.settle();
    assert.doesNotMatch(welcomeTo(service, "full@example.com"), /first month|renews/);
    const claimed = (await (await service.request("GET", "/admin/paid/checkouts?status=claimed", { token: await admin(service) })).json()) as any;
    assert.equal(claimed.checkouts[0].promo, null);
  });

  it("keys the welcome line to the checkout, not the clock: paid in the window, claimed after it", async () => {
    const { service, stripe } = await world({}, END - 60_000);
    const session = await buy(service, stripe, "starter", "late@example.com");
    service.clock.now = END + 3 * 3_600_000;
    await emailSignIn(service, "late@example.com", session.id);
    await service.settle();
    assert.ok(welcomeTo(service, "late@example.com").includes("Your first month was 50% off. It renews at $7/mo."));
  });

  it("records the discount from the webhook on an unclaimed payment, in the claim email and the owner's alert", async () => {
    const { service, stripe } = await world();
    const session = await buy(service, stripe, "max", "hook@example.com");
    const result = await webhook(service, "checkout.session.completed", stripe.sessionObject(session, false));
    assert.equal(result.body.outcome, "plan_unclaimed");
    const claim = service.calls.userEmail.find((entry) => entry.to === "hook@example.com" && entry.subject === "Finish setting up dl.new");
    assert.match(String(claim?.text), /Thanks for subscribing to dl\.new Max \(first month 50% off, then \$60\/month\)/);
    assert.ok(alerts(service).some((text) => text.includes("paid $30.00 for dl.new Max (launch offer dlnew-bf-2026, $30.00 off)")));
    const unclaimed = (await (await service.request("GET", "/admin/paid/checkouts", { token: await admin(service) })).json()) as any;
    assert.deepEqual(unclaimed.checkouts[0].promo, { coupon: "dlnew-bf-2026", discountCents: 3000, percentOff: 50 });
  });

  it("refunds what was actually paid: the first invoice's payment in full, no amount of its own", async () => {
    const { service, stripe } = await world();
    const session = await buy(service, stripe, "plus", "ref@example.com");
    const signedIn = await emailSignIn(service, "ref@example.com", session.id);
    const refund = await service.request("POST", "/admin/paid/refund", { token: await admin(service), body: { accountId: signedIn.account.accountId } });
    assert.equal(refund.status, 200, await refund.clone().text());
    const form = stripe.refunds[0]!;
    assert.equal(form.get("payment_intent"), `pi_for_${stripe.subscriptions.get(session.subscription!)!.latest_invoice}`);
    assert.equal(form.get("amount"), null, "Stripe refunds the whole charge: the discounted $10, never the list $20");
  });

  it("reads Stripe's discount from a Checkout Session", () => {
    assert.equal(checkoutPromo({ total_details: { amount_discount: 0 } }), null);
    assert.equal(checkoutPromo({}), null);
    assert.deepEqual(checkoutPromo({ amount_subtotal: 700, total_details: { amount_discount: 350 }, discounts: [{ coupon: { id: "dlnew-bf-2026" } }] }), { coupon: "dlnew-bf-2026", discountCents: 350, percentOff: 50 });
    assert.deepEqual(checkoutPromo({ amount_subtotal: 0, total_details: { amount_discount: 350 }, metadata: { promo: "dlnew-bf-2026" } }), { coupon: "dlnew-bf-2026", discountCents: 350, percentOff: 0 });
    assert.equal(welcomePromoLine("max", 50), " Your first month was 50% off. It renews at $60/mo.");
    assert.equal(welcomePromoLine("max", null), "");
  });
});

describe("freeForever", () => {
  const KEYS = { OPENAI_API_KEY: "sk-openai-test", LUMINAL_API_KEY: "lum-test", OPEN_ADMISSION: "true", DL_ONLY: "false", PAID_PLANS: "true" };
  const chat = (service: Service, token: string) => service.request("POST", "/v1/chat/completions", { token, body: { model: MODEL, messages: [{ role: "user", content: "hello" }] } });

  it("keeps listed accounts on their free allowance past freeEndsAt; everyone else gets plan_required", async () => {
    const service = await createService({ ...KEYS, FREE_FOREVER: "100" });
    service.setLuminal(() => completion(luminalUsage(100, 10)));
    await service.signIn({ id: 100, login: "alice" });
    await service.signIn({ id: 200, login: "bob" });
    service.clock.now = Date.UTC(2026, 11, 8) + 60_000;
    const alice = (await service.signIn({ id: 100, login: "alice" })).access_token;
    const bob = (await service.signIn({ id: 200, login: "bob" })).access_token;
    assert.equal((await chat(service, alice)).status, 200, "on the list");
    const refused = await chat(service, bob);
    assert.equal(refused.status, 402);
    assert.equal(((await refused.json()) as any).error.code, "plan_required");
    // The admin sees it, on the list and on the person.
    const owner = await admin(service);
    const people = (await (await service.request("GET", "/admin/people", { token: owner })).json()) as any;
    const byId = new Map(people.people.map((person: any) => [person.githubId, person]));
    assert.equal((byId.get(100) as any).freeForever, true);
    assert.equal((byId.get(200) as any).freeForever, false);
    assert.equal(((await (await service.request("GET", "/admin/people/100", { token: owner })).json()) as any).freeForever, true);
    // A runtime setting: the owner adds bob without a release.
    assert.equal((await service.request("POST", "/admin/config", { token: owner, body: { freeForever: [100, 200] } })).status, 200);
    assert.equal((await chat(service, bob)).status, 200);
  });

  it("still applies blocks to listed accounts", async () => {
    const service = await createService({ ...KEYS, FREE_FOREVER: "100" });
    service.setLuminal(() => completion(luminalUsage(100, 10)));
    const alice = (await service.signIn({ id: 100, login: "alice" })).access_token;
    service.clock.now = Date.UTC(2026, 11, 8) + 60_000;
    const owner = await admin(service);
    assert.equal((await service.request("POST", "/admin/people/100/block", { token: owner })).status, 200);
    const refused = await chat(service, alice);
    assert.notEqual(refused.status, 200);
    assert.notEqual(((await refused.json()) as any).error?.code, "plan_required");
  });
});
