import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, allowServerKeys, completion, createService, MODEL, usage, type Service } from "./harness.js";
import { ConfigError, readFreeConfig } from "../src/config.js";
// app.js imports cloudflare:workers, which the harness maps once it has loaded.
const { ADMIN_PEOPLE_CONCURRENCY, mapLimited, offers, topupUsage, usdLabel } = await import("../src/app.js");
import type { Limits } from "../src/account-object.js";

/**
 * dl Pro as the way to keep going: its price shown exactly ("$3.99/month"), its weekly dollar
 * ceiling held like the free caps, top-ups bounded by their tokens, and the admin people list
 * staying within a bounded number of Durable Object calls at a time.
 */

const BASE = { TOKEN_SIGNING_KEY: "x".repeat(32), OPENROUTER_API_KEY: "k", GITHUB_CLIENT_ID: "i", GITHUB_CLIENT_SECRET: "s" };

function config(vars: Record<string, string> = {}) {
  return readFreeConfig({ ...BASE, ...vars });
}

describe("the Pro offer", () => {
  it("defaults to $3.99 a month with $6 of GPT-6 and $40 of DeepSeek a week, and dollar top-ups from $2", () => {
    const shown = offers(config());
    assert.deepEqual(shown.pro, {
      priceUsdMonthly: 3.99,
      price: "$3.99/month",
      tokensPerWeek: 300_000_000,
      usdPerWeek: 6,
      deepseekUsdPerWeek: 40,
      valueLine: "Lots of DeepSeek every week, plus more GPT-6.",
    });
    // The value line names no amounts: they are runtime settings.
    assert.doesNotMatch(shown.pro.valueLine, /\$|\d+x|\d+M/);
    assert.deepEqual(shown.topup, { unitPriceUsd: 1, minQuantity: 2, maxQuantity: 20, usageMultiplier: 1.25, validDays: 90, fromPrice: "$2" });
  });

  it("shows prices exactly, never rounded to whole dollars", () => {
    assert.equal(usdLabel(3.99), "$3.99");
    assert.equal(usdLabel(4), "$4");
    assert.equal(usdLabel(10), "$10");
    assert.equal(usdLabel(0.5), "$0.50");
    assert.equal(offers(config({ PRO_PRICE_USD_MONTHLY: "10" })).pro.price, "$10/month");
    assert.equal(offers(config({ PRO_PRICE_USD_MONTHLY: "4.5" })).pro.price, "$4.50/month");
  });

  it("takes the price as dollars and cents, and the value line as one short line", () => {
    assert.equal(config({ PRO_PRICE_USD_MONTHLY: "3.99" }).offers.pro.priceUsdMonthly, 3.99);
    assert.throws(() => config({ PRO_PRICE_USD_MONTHLY: "3.999" }), ConfigError);
    assert.throws(() => config({ PRO_PRICE_USD_MONTHLY: "$4" }), ConfigError);
    assert.throws(() => config({ TOPUP_UNIT_PRICE_USD: "-1" }), ConfigError);
    assert.throws(() => config({ TOPUP_MIN_QUANTITY: "30" }), ConfigError);
    assert.throws(() => config({ TOPUP_USAGE_MULTIPLIER: "50" }), ConfigError);
    assert.equal(config({ TOPUP_USAGE_MULTIPLIER: "1.5" }).offers.topup.usageMultiplier, 1.5);
    assert.equal(config({ PRO_VALUE_LINE: "Every model, more each week." }).offers.pro.valueLine, "Every model, more each week.");
    assert.throws(() => config({ PRO_VALUE_LINE: "x".repeat(81) }), ConfigError);
  });

  it("has a $6 weekly GPT-6 ceiling and $40 of DeepSeek by default; \"none\" means tokens only", () => {
    assert.equal(config().proWeeklyUsdCap, 6);
    assert.equal(config().proDeepseekWeeklyUsdCap, 40);
    assert.equal(config({ PRO_DEEPSEEK_WEEKLY_USD_CAP: "none" }).proDeepseekWeeklyUsdCap, undefined);
    assert.equal(config({ PRO_WEEKLY_USD_CAP: "12.5" }).proWeeklyUsdCap, 12.5);
    assert.equal(config({ PRO_WEEKLY_USD_CAP: "none" }).proWeeklyUsdCap, undefined);
    assert.equal(offers(config({ PRO_WEEKLY_USD_CAP: "none" })).pro.usdPerWeek, null);
  });

  it("matches the deployed config: Pro $3.99 with a $6 GPT-6 ceiling, top-ups $2 to $20 at 1.25x for 90 days", async () => {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(new URL("../wrangler.cloudflare.jsonc", import.meta.url), "utf8");
    const vars = (JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")) as { vars: Record<string, string> }).vars;
    assert.equal(vars.PRO_PRICE_USD_MONTHLY, "3.99");
    assert.equal(vars.PRO_WEEKLY_USD_CAP, "6");
    assert.equal(vars.TOPUP_UNIT_PRICE_USD, "1");
    assert.equal(vars.TOPUP_MIN_QUANTITY, "2");
    assert.equal(vars.TOPUP_MAX_QUANTITY, "20");
    assert.equal(vars.TOPUP_USAGE_MULTIPLIER, "1.25");
    assert.equal(vars.TOPUP_VALID_DAYS, "90");
    assert.ok(Number(vars.PRO_TOKENS_PER_WEEK) >= 100_000_000);
    assert.ok(!raw.includes("price_"), "Stripe price ids are secrets, never in the repo");
  });
});

const SECRET = "whsec_test_0123456789abcdef";
const BILLING = { STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_PRICE_PRO: "price_pro123", STRIPE_PRICE_TOPUP: "price_topup123" };

async function goPro(svc: Service, githubId: number): Promise<void> {
  const { signatureHeader } = await import("../src/stripe.js");
  const session = {
    id: `cs_pro_${githubId}`,
    object: "checkout.session",
    mode: "subscription",
    client_reference_id: String(githubId),
    customer: `cus_${githubId}`,
    subscription: `sub_${githubId}`,
    payment_status: "paid",
    amount_subtotal: 399,
    amount_total: 399,
    metadata: { github_id: String(githubId), product: "pro" },
  };
  const body = JSON.stringify({ id: `evt_pro_${githubId}`, object: "event", type: "checkout.session.completed", created: Math.floor(svc.clock.now / 1000), data: { object: session } });
  const header = await signatureHeader(SECRET, Math.floor(svc.clock.now / 1000), body);
  assert.equal((await svc.request("POST", "/v1/billing/webhook", { body, headers: { "stripe-signature": header } })).status, 200);
}

describe("Pro's weekly dollar ceiling", () => {
  it("stops Pro's DeepSeek at $40 a week through the API, as a spend limit, and says it is Pro's", async () => {
    const svc = await createService({ ...BILLING, OPEN_ADMISSION: "true" });
    const admin = (await svc.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const tokens = await svc.signIn({ id: 100, login: "user100" });
    allowServerKeys(svc, 100);
    const key = ((await (await svc.request("POST", "/v1/keys", { token: tokens.access_token, body: { name: "k" } })).json()) as { key: string }).key;
    await goPro(svc, 100);
    const me = (await (await svc.request("GET", "/v1/me", { token: key })).json()) as { plan: string; allowance: { usdPerWeek: number | null } };
    assert.equal(me.plan, "pro");
    assert.equal(me.allowance.usdPerWeek, 6);

    svc.setOpenRouter(() => completion(usage(1000, 1000, 0, 0.01)));
    const chat = () => svc.request("POST", "/v1/chat/completions", { token: key, body: { model: MODEL, messages: [{ role: "user", content: "hi" }] } });
    assert.equal((await chat()).status, 200);
    // GPT-6's Pro week used up doesn't touch DeepSeek's.
    await svc.request("POST", "/admin/people/100/grant", { token: admin, body: { spentUsdThisWeek: 6 } });
    assert.equal((await chat()).status, 200);
    await svc.request("POST", "/admin/people/100/grant", { token: admin, body: { deepseekSpentUsdThisWeek: 40 } });
    const refused = await chat();
    assert.equal(refused.status, 402);
    const error = ((await refused.json()) as { error: { code: string; reason: string; message: string } }).error;
    assert.equal(error.code, "quota_exceeded");
    assert.equal(error.reason, "spend");
    assert.match(error.message, /Pro/);
  });

  it("holds Pro's ceiling against the estimates of requests in flight, like the free caps", async () => {
    const svc = await createService({ OPEN_ADMISSION: "true" });
    await svc.signIn({ id: 100, login: "user100" });
    const account = svc.account(100) as any;
    await account.applySubscription({ subscriptionId: "sub_1", state: "active", periodEnd: svc.clock.now + 30 * 86_400_000, eventAt: 1 });
    const limits: Limits = { weeklyTokens: 50_000_000, weeklyUsd: 0.1, proTokensPerWeek: 300_000_000, proUsdPerWeek: config().proWeeklyUsdCap };
    const reserve = () => account.reserve({ pool: "astra", promptEstimate: 100_000, requestedMaxTokens: undefined, limits, now: svc.clock.now, model: "gpt-6-astra" });
    const results = await Promise.all(Array.from({ length: 40 }, reserve));
    const held = results.filter((r) => r.ok);
    assert.ok(held.length > 1 && held.length < 40, `some, not all, in flight (${held.length})`);
    assert.ok(results.filter((r) => !r.ok).every((r) => r.reason === "spend"));
  });
});

describe("token top-ups (the old product)", () => {
  it("never buy more than their tokens: an overshoot past the last top-up counts on the week, tokens and dollars", async () => {
    const svc = await createService({ OPEN_ADMISSION: "true" });
    await svc.signIn({ id: 100, login: "user100" });
    const account = svc.account(100) as any;
    const now = svc.clock.now;
    const limits: Limits = { weeklyTokens: 0, weeklyUsd: 3 };
    await account.grantTopup({ id: "cs_1", tokens: 10_000, createdAt: now, expiresAt: now + 30 * 86_400_000 });
    const held = await account.reserve({ promptEstimate: 1_000, requestedMaxTokens: 2_000, limits, now, model: MODEL });
    assert.ok(held.ok);
    assert.equal(held.source, "topup");
    // Parallel requests can't hold more than the top-up has left.
    const second = await account.reserve({ promptEstimate: 1_000, requestedMaxTokens: 20_000, limits, now, model: MODEL });
    assert.ok(second.ok);
    assert.ok(held.amount + second.amount <= 10_000);
    await account.settle({ reservationId: second.reservationId, charged: 0, costUsd: 0, limits, now });
    // The provider reports 12,000 tokens for $1.20: 10,000 from the top-up, 2,000 ($0.20) on the week.
    const settled = await account.settle({ reservationId: held.reservationId, charged: 12_000, costUsd: 1.2, limits, now });
    assert.equal(settled.allowance.topupTokensLeft, 0);
    assert.equal(settled.allowance.usedThisWeek, 2_000);
    assert.equal(settled.allowance.spentUsdThisWeek, 0.2);
  });
});

describe("dollar top-ups", () => {
  const LIMITS: Limits = { weeklyTokens: 50_000_000, weeklyUsd: 1 };

  async function holder(): Promise<{ svc: Service; account: any }> {
    const svc = await createService({ OPEN_ADMISSION: "true" });
    await svc.signIn({ id: 100, login: "user100" });
    return { svc, account: svc.account(100) as any };
  }

  it("adds each paid dollar times the multiplier, to the cent", () => {
    assert.equal(topupUsage(200, 1.25), 2.5);
    assert.equal(topupUsage(2000, 1.25), 25);
    assert.equal(topupUsage(700, 1.25), 8.75);
  });

  it("spends the weekly allowance first, then the top-up, then refuses", async () => {
    const { svc, account } = await holder();
    const now = svc.clock.now;
    await account.grantCredit({ id: "cs_1", usd: 2.5, createdAt: now, expiresAt: now + 90 * 86_400_000 });
    const reserve = () => account.reserve({ promptEstimate: 1_000, requestedMaxTokens: 1_000, limits: LIMITS, now, model: MODEL });
    const weekly = await reserve();
    assert.equal(weekly.source, "weekly");
    let settled = await account.settle({ reservationId: weekly.reservationId, charged: 2_000, costUsd: 1, limits: LIMITS, now });
    assert.equal(settled.allowance.topupUsdLeft, 2.5, "the week paid for it");
    const first = await reserve();
    assert.equal(first.source, "credit");
    assert.equal(first.paid, true);
    settled = await account.settle({ reservationId: first.reservationId, charged: 2_000, costUsd: 2, limits: LIMITS, now });
    assert.equal(settled.allowance.topupUsdLeft, 0.5);
    assert.equal(settled.allowance.spentUsdThisWeek, 1, "top-up spend isn't on the week");
    const last = await reserve();
    assert.equal(last.source, "credit");
    // $0.75 against $0.50 left: the $0.25 past the balance goes on the week.
    settled = await account.settle({ reservationId: last.reservationId, charged: 3_000, costUsd: 0.75, limits: LIMITS, now });
    assert.equal(settled.allowance.topupUsdLeft, 0);
    assert.equal(settled.allowance.spentUsdThisWeek, 1.25);
    const refused = await reserve();
    assert.equal(refused.ok, false);
    assert.equal(refused.code, "quota_exceeded");
  });

  it("holds requests in flight against the balance, like the dollar caps", async () => {
    const { svc, account } = await holder();
    const now = svc.clock.now;
    const spent: Limits = { ...LIMITS, weeklyUsd: 0 };
    await account.grantCredit({ id: "cs_1", usd: 2.5, createdAt: now, expiresAt: now + 90 * 86_400_000 });
    const results = await Promise.all(
      Array.from({ length: 30 }, () => account.reserve({ pool: "sol", promptEstimate: 100_000, requestedMaxTokens: undefined, limits: spent, now, model: "gpt-6.1-sol" })),
    );
    const held = results.filter((r) => r.ok);
    assert.ok(held.length > 1 && held.length < 30, `some, not all, in flight (${held.length})`);
    assert.ok(held.every((r) => r.source === "credit"));
    const allowance = await account.allowance(now, spent);
    assert.ok(allowance.topupUsdLeft < 2.5 && allowance.topupUsdLeft >= 0);
  });

  it("expires after its validity, soonest first", async () => {
    const { svc, account } = await holder();
    const now = svc.clock.now;
    const DAY = 86_400_000;
    await account.grantCredit({ id: "cs_1", usd: 2.5, createdAt: now, expiresAt: now + 90 * DAY });
    await account.grantCredit({ id: "cs_2", usd: 5, createdAt: now + DAY, expiresAt: now + 91 * DAY });
    let allowance = await account.allowance(now + DAY, LIMITS);
    assert.equal(allowance.topupUsdLeft, 7.5);
    assert.equal(allowance.topupUsdExpiresAt, now + 90 * DAY);
    allowance = await account.allowance(now + 90 * DAY + 1, LIMITS);
    assert.equal(allowance.topupUsdLeft, 5);
    assert.equal(allowance.topupUsdExpiresAt, now + 91 * DAY);
    allowance = await account.allowance(now + 91 * DAY + 1, LIMITS);
    assert.equal(allowance.topupUsdLeft, 0);
    assert.equal(allowance.topupUsdExpiresAt, null);
  });

  it("uses old token top-ups before dollar ones, exactly as bought", async () => {
    const { svc, account } = await holder();
    const now = svc.clock.now;
    const spent: Limits = { ...LIMITS, weeklyUsd: 0 };
    await account.grantTopup({ id: "cs_old", tokens: 50_000_000, createdAt: now, expiresAt: now + 30 * 86_400_000 });
    await account.grantCredit({ id: "cs_new", usd: 2.5, createdAt: now, expiresAt: now + 90 * 86_400_000 });
    const held = await account.reserve({ promptEstimate: 1_000, requestedMaxTokens: 1_000, limits: spent, now, model: MODEL });
    assert.equal(held.source, "topup");
    const settled = await account.settle({ reservationId: held.reservationId, charged: 2_000, costUsd: 0.5, limits: spent, now });
    assert.equal(settled.allowance.topupTokensLeft, 50_000_000 - 2_000);
    assert.equal(settled.allowance.topupUsdLeft, 2.5);
  });
});

describe("dollar top-ups through Stripe", () => {
  async function signed(svc: Service, type: string, object: Record<string, unknown>, id: string): Promise<Response> {
    const { signatureHeader } = await import("../src/stripe.js");
    const body = JSON.stringify({ id, object: "event", type, created: Math.floor(svc.clock.now / 1000), data: { object } });
    return svc.request("POST", "/v1/billing/webhook", { body, headers: { "stripe-signature": await signatureHeader(SECRET, Math.floor(svc.clock.now / 1000), body) } });
  }
  const session = (id: string, subtotalCents: number, kind: "usd" | undefined) => ({
    id,
    object: "checkout.session",
    mode: "payment",
    client_reference_id: "100",
    customer: "cus_100",
    payment_status: "paid",
    amount_subtotal: subtotalCents,
    amount_total: Math.round(subtotalCents * 1.09),
    metadata: { github_id: "100", product: "topup", ...(kind ? { topup_kind: kind } : {}) },
  });

  async function setup(): Promise<{ svc: Service; access: string; key: string }> {
    const svc = await createService({ ...BILLING, OPEN_ADMISSION: "true" });
    const tokens = await svc.signIn({ id: 100, login: "user100" });
    allowServerKeys(svc, 100);
    const key = ((await (await svc.request("POST", "/v1/keys", { token: tokens.access_token, body: { name: "k" } })).json()) as { key: string }).key;
    return { svc, access: tokens.access_token, key };
  }

  it("opens Checkout with an adjustable quantity of 2 to 20, starting where asked", async () => {
    const { svc, access } = await setup();
    assert.equal((await svc.request("POST", "/v1/billing/checkout", { token: access, body: { product: "topup" } })).status, 200);
    let form = svc.calls.stripe.at(-1)!.form;
    assert.equal(form.get("line_items[0][price]"), "price_topup123");
    assert.equal(form.get("line_items[0][quantity]"), "2");
    assert.equal(form.get("line_items[0][adjustable_quantity][enabled]"), "true");
    assert.equal(form.get("line_items[0][adjustable_quantity][minimum]"), "2");
    assert.equal(form.get("line_items[0][adjustable_quantity][maximum]"), "20");
    assert.equal(form.get("metadata[topup_kind]"), "usd");
    assert.equal((await svc.request("POST", "/v1/billing/checkout", { token: access, body: { product: "topup", quantity: 10 } })).status, 200);
    form = svc.calls.stripe.at(-1)!.form;
    assert.equal(form.get("line_items[0][quantity]"), "10");
    for (const quantity of [1, 21, 2.5, "five"]) {
      assert.equal((await svc.request("POST", "/v1/billing/checkout", { token: access, body: { product: "topup", quantity } })).status, 400, `quantity ${quantity}`);
    }
    // Pro is still one subscription.
    assert.equal((await svc.request("POST", "/v1/billing/checkout", { token: access, body: { product: "pro" } })).status, 200);
    assert.equal(svc.calls.stripe.at(-1)!.form.get("line_items[0][quantity]"), "1");
    assert.equal(svc.calls.stripe.at(-1)!.form.get("line_items[0][adjustable_quantity][enabled]"), null);
  });

  it("adds paid dollars × 1.25 for 90 days, once per session, and still honours an old token checkout", async () => {
    const { svc, key } = await setup();
    const me = async () => (await (await svc.request("GET", "/v1/me", { token: key })).json()) as { topupUsdLeft: number; topupUsdExpiresAt: string | null; topupTokensLeft: number };
    assert.equal((await signed(svc, "checkout.session.completed", session("cs_usd", 500, "usd"), "evt_1")).status, 200);
    let body = await me();
    assert.equal(body.topupUsdLeft, 6.25);
    assert.equal(body.topupUsdExpiresAt, new Date(svc.clock.now + 90 * 86_400_000).toISOString());
    // The same session again (a retried or second event) adds nothing.
    await signed(svc, "checkout.session.completed", session("cs_usd", 500, "usd"), "evt_2");
    assert.equal((await me()).topupUsdLeft, 6.25);
    // A checkout started under the old token top-up still gets its 50M tokens.
    await signed(svc, "checkout.session.completed", session("cs_old", 300, undefined), "evt_3");
    body = await me();
    assert.equal(body.topupTokensLeft, 50_000_000);
    assert.equal(body.topupUsdLeft, 6.25);
  });
});

describe("the admin people list at scale", () => {
  async function seeded(people: number): Promise<{ svc: Service; admin: string }> {
    const svc = await createService();
    const admin = (await svc.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    svc.directory();
    const db = (svc.namespaces.DIRECTORY!.instances.get("directory") as any).state.db;
    db.exec("BEGIN");
    const insert = db.prepare("INSERT INTO people (github_id, login, status, admitted_at, admitted_via) VALUES (?, ?, 'active', ?, 'invite:1')");
    const network = db.prepare("INSERT INTO person_networks (github_id, net_hash, first_at) VALUES (?, ?, ?)");
    for (let index = 0; index < people; index++) {
      const id = 10_000 + index;
      insert.run(id, `dev-${index}`, svc.clock.now - 86_400_000 + index);
      network.run(id, `net-${index}`, svc.clock.now);
      if (index % 10 === 0) network.run(id, "shared-net", svc.clock.now);
    }
    db.exec("COMMIT");
    return { svc, admin };
  }

  /** Counts calls into every object of a namespace, and how many are in flight at once (each takes a turn of the event loop). */
  function instrument(svc: Service, name: "ACCOUNT" | "DIRECTORY"): { calls: number; inFlight: number; peak: number; methods: Map<string, number> } {
    const stats = { calls: 0, inFlight: 0, peak: 0, methods: new Map<string, number>() };
    const namespace = svc.namespaces[name]! as any;
    const original = namespace.getByName.bind(namespace);
    namespace.getByName = (key: string) => {
      const target = original(key);
      return new Proxy(target, {
        get(object, property) {
          const value = object[property];
          if (typeof value !== "function" || typeof property !== "string") return value;
          return async (...args: unknown[]) => {
            stats.calls++;
            stats.methods.set(property, (stats.methods.get(property) ?? 0) + 1);
            stats.inFlight++;
            stats.peak = Math.max(stats.peak, stats.inFlight);
            try {
              await new Promise((resolve) => setImmediate(resolve));
              return await value.apply(object, args);
            } finally {
              stats.inFlight--;
            }
          };
        },
      });
    };
    return stats;
  }

  it("lists 600 people with one account call each, a bounded number at once, and a few Directory reads", { timeout: 120_000 }, async () => {
    const { svc, admin } = await seeded(600);
    const accounts = instrument(svc, "ACCOUNT");
    const directories = instrument(svc, "DIRECTORY");
    const response = await svc.request("GET", "/v1/admin/people", { token: admin });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { people: Array<Record<string, any>>; nextCursor: string | null; total: number };
    assert.equal(body.people.length, 601, "everyone, the admin too, without a limit (as before)");
    assert.equal(body.nextCursor, null);
    assert.equal(body.total, 601);
    assert.ok(accounts.peak <= ADMIN_PEOPLE_CONCURRENCY, `at most ${ADMIN_PEOPLE_CONCURRENCY} account calls at once (saw ${accounts.peak})`);
    assert.equal(accounts.methods.get("adminSummary"), 601, "one account call per person");
    assert.equal(accounts.methods.get("allowance") ?? 0, 0);
    assert.equal(accounts.methods.get("keyCount") ?? 0, 0);
    assert.equal(directories.methods.get("networkCount") ?? 0, 0, "network counts come from one query");
    assert.ok(directories.calls < 20, `a few Directory calls, not one per person (saw ${directories.calls})`);
    // The response shape is unchanged.
    const row = body.people.find((person) => person.githubId === 10_000)!;
    assert.equal(row.login, "dev-0");
    assert.equal(row.networks, 2);
    assert.equal(row.serverKeys, 0);
    assert.equal(typeof row.allowance.tokensPerWeek, "number");
    assert.equal(row.personalCap, null);
    assert.equal(body.people.find((person) => person.githubId === 10_001)!.networks, 1);
  });

  it("pages with ?limit and ?cursor, and filters before it calls any account", { timeout: 120_000 }, async () => {
    const { svc, admin } = await seeded(600);
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `/admin/people?limit=250${cursor ? `&cursor=${cursor}` : ""}`;
      const body = (await (await svc.request("GET", query, { token: admin })).json()) as { people: Array<{ githubId: number }>; nextCursor: string | null; total: number };
      assert.ok(body.people.length <= 250);
      assert.equal(body.total, 601);
      seen.push(...body.people.map((person) => person.githubId));
      cursor = body.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    assert.equal(pages, 3);
    assert.equal(seen.length, 601);
    assert.equal(new Set(seen).size, 601, "no one twice");

    const accounts = instrument(svc, "ACCOUNT");
    const shared = (await (await svc.request("GET", "/admin/people?shared=1", { token: admin })).json()) as { people: Array<{ networks: number }> };
    assert.equal(shared.people.length, 60);
    assert.ok(shared.people.every((person) => person.networks > 1));
    assert.equal(accounts.methods.get("adminSummary"), 60, "only the people listed are looked up");

    assert.equal((await svc.request("GET", "/admin/people?limit=0", { token: admin })).status, 400);
    assert.equal((await svc.request("GET", "/admin/people?limit=501", { token: admin })).status, 400);
    assert.equal((await svc.request("GET", "/admin/people?cursor=nope", { token: admin })).status, 400);
  });

  it("runs work at most `limit` at a time, in order", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimited(
      Array.from({ length: 100 }, (_, index) => index),
      7,
      async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight--;
        return n * 2;
      },
    );
    assert.equal(peak, 7);
    assert.deepEqual(out, Array.from({ length: 100 }, (_, index) => index * 2));
  });
});
