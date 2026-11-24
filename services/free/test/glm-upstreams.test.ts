import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { ADMIN_ID, createService, liquidCompletion, liquidStream, luminalUsage, MODEL, openRelayCompletion, openRelayUsage, type Service } from "./harness.js";
import { readFreeConfig } from "../src/config.js";
import { modelById, onUpstream } from "../src/models.js";
import { PROBE_CRON } from "../src/probes.js";
import { accessOf, approxTokens, modelPlans, personCapUsd, proOnly, registryRoute } from "../src/providers.js";
import { signatureHeader } from "../src/stripe.js";

/**
 * GLM 5.3 Flash's two upstreams (models.ts `backups`): Liquid Inference first, Open Relay as the
 * backup, then DeepSeek. Liquid serves; a Liquid failure before anything reaches the client (429,
 * 5xx, a timeout, "no eligible offer") goes to Open Relay; both failing goes to DeepSeek. Each
 * attempt is accounted to the upstream that made it. GLM 5.3 Flash is free for everyone though
 * Liquid's other model (Kimi) is a dl Pro perk, its per-person cap holds across both upstreams,
 * and its weekly share of Liquid's credit keeps it and Kimi from starving each other.
 */

const GLM_FLASH = "z-ai/glm-5.3-flash";
const KIMI = "moonshotai/kimi-k3.1-pro";
const LIQUID_KEY = "sk-architect-test-secret";
const OPENRELAY_KEY = "or_test_secret";
/** Both upstreams with a key and on; Liquid's plans left at the default ("pro": Kimi is a Pro perk). */
const BOTH = { LIQUID_INFERENCE_API_KEY: LIQUID_KEY, LIQUID_STATUS: "on", OPENRELAY_API_KEY: OPENRELAY_KEY, OPENRELAY_STATUS: "on" };
const BASE_ENV = { OPENROUTER_API_KEY: "k", GITHUB_CLIENT_ID: "c", GITHUB_CLIENT_SECRET: "s", TOKEN_SIGNING_KEY: "x".repeat(32) };
const SECRET = "whsec_test_0123456789abcdef";
const BILLING = { STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_PRICE_TOPUP: "price_topup123" };

let ips = 0;
const ip = () => `10.11.${Math.floor(++ips / 250) % 250}.${ips % 250}`;

async function member(vars: Record<string, string> = {}): Promise<{ service: Service; token: string; admin: string }> {
  const service = await createService({ OPEN_ADMISSION: "true", OPENAI_API_KEY: "sk-openai-test", LUMINAL_API_KEY: "lum-test", ...vars });
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const token = (await service.signIn({ id: 100, login: "alice" })).access_token;
  return { service, token, admin };
}

const chat = (service: Service, token: string, model: string, body: Record<string, unknown> = {}) =>
  service.request("POST", "/v1/chat/completions", { token, ip: ip(), body: { model, messages: [{ role: "user", content: "hello" }], ...body } });

async function errorOf(response: Response): Promise<Record<string, any>> {
  return ((await response.json()) as { error: Record<string, any> }).error;
}

function db(service: Service): DatabaseSync {
  service.directory();
  return (service.namespaces.DIRECTORY!.instances.get("directory")!.state as unknown as { db: DatabaseSync }).db;
}

function rows(service: Service): Array<Record<string, any>> {
  return db(service).prepare("SELECT model, upstream, status, credit_usd FROM requests ORDER BY id").all() as Array<Record<string, any>>;
}

async function scheduled(service: Service, cron: string, at = service.clock.now): Promise<void> {
  await (service.handler as unknown as { scheduled(controller: { cron: string; scheduledTime: number }, env: never): Promise<void> }).scheduled({ cron, scheduledTime: at }, service.env as never);
}

async function makePro(service: Service, githubId: number): Promise<void> {
  const at = Math.floor(service.clock.now / 1000);
  const object = { id: `cs_pro_${githubId}`, object: "checkout.session", mode: "subscription", client_reference_id: String(githubId), customer: `cus_${githubId}`, subscription: `sub_${githubId}`, payment_status: "paid", amount_subtotal: 700, amount_total: 700, metadata: { github_id: String(githubId), product: "pro" } };
  const body = JSON.stringify({ id: `evt_pro_${githubId}`, object: "event", type: "checkout.session.completed", created: at, data: { object } });
  const response = await service.request("POST", "/v1/billing/webhook", { body, headers: { "stripe-signature": await signatureHeader(SECRET, at, body) } });
  assert.equal(response.status, 200, await response.clone().text());
}

/** Liquid's "no offer met the requirements", as it answered live on 2026-11-24. */
const noOffer = () => Response.json({ error: { message: "no offer met the requirements.", type: "liquid_error", code: "no_eligible_offer", param: "exchange.allowed_providers", retryable: false } }, { status: 400 });

describe("GLM 5.3 Flash upstreams: settings", () => {
  it("is Liquid first (munitoai and tensorx, zero retention, ceilings), then Open Relay, then DeepSeek", () => {
    const config = readFreeConfig({ ...BASE_ENV });
    const glm = modelById(GLM_FLASH)!;
    assert.deepEqual([glm.provider, glm.upstreamModel, glm.backups?.map((entry) => [entry.provider, entry.upstreamModel])], ["liquid", "glm-5.3-flash", [["openrelay", "openrelay/glm-5.3-flash"]]]);
    assert.equal(glm.fallback, MODEL);
    assert.deepEqual(config["exchangeAllow.glm-5.3-flash"], ["munitoai", "tensorx"]);
    assert.deepEqual(config["exchangeMaxPrices.glm-5.3-flash"], [0.2, 0.05, 0.5]);
    // Liquid's $25 a week split so neither model starves the other; $0.50 a person across both upstreams.
    assert.equal(config["providerWeeklyCredit.liquid"], 25);
    assert.equal(config["modelWeeklyCredit.liquid.glm-5.3-flash"], 10);
    assert.equal(config["modelWeeklyCredit.liquid.kimi-k3.1-pro"], 15);
    assert.equal(personCapUsd(config, glm), 0.5);
    assert.equal(approxTokens(glm, 0.5), 15_000_000);
    // On Open Relay it is Open Relay's wire id, with no exchange rules; its id and budget stay.
    const relay = onUpstream(glm, "openrelay");
    assert.deepEqual([relay.id, relay.provider, relay.upstreamModel, relay.exchange, relay.family], [GLM_FLASH, "openrelay", "openrelay/glm-5.3-flash", undefined, "deepseek"]);
  });

  it("reads its env names", () => {
    const config = readFreeConfig({ ...BASE_ENV, LIQUID_ALLOW_GLM_5_3_FLASH: "munitoai", LIQUID_MAX_PRICES_GLM_5_3_FLASH: "0.05,0.03,0.15", LIQUID_WEEKLY_CREDIT_GLM_5_3_FLASH: "5", LIQUID_WEEKLY_CREDIT_KIMI_K3_1_PRO: "none", GLM_5_3_FLASH_PERSON_WEEKLY_USD: "1" });
    assert.deepEqual(config["exchangeAllow.glm-5.3-flash"], ["munitoai"]);
    assert.deepEqual(config["exchangeMaxPrices.glm-5.3-flash"], [0.05, 0.03, 0.15]);
    assert.equal(config["modelWeeklyCredit.liquid.glm-5.3-flash"], 5);
    assert.equal(config["modelWeeklyCredit.liquid.kimi-k3.1-pro"], undefined);
    assert.equal(config["modelPersonWeeklyUsd.glm-5.3-flash"], 1);
  });

  it("the Pro-only rule is per model: Kimi is Pro-only on Liquid, GLM 5.3 Flash on Liquid is free for everyone", () => {
    const config = readFreeConfig({ ...BASE_ENV, ...BOTH });
    assert.equal(config["providerPlans.liquid"], "pro");
    const glm = modelById(GLM_FLASH)!;
    const kimi = modelById(KIMI)!;
    assert.deepEqual([modelPlans(config, kimi), proOnly(config, kimi), accessOf(config, kimi)], ["pro", true, "pro"]);
    assert.deepEqual([modelPlans(config, glm), proOnly(config, glm), accessOf(config, glm)], ["all", false, "free"]);
    const spend = { usedUsd: {}, weekUsd: {} };
    assert.equal(registryRoute(config, kimi, spend, 0, "free").block, "pro_only");
    assert.deepEqual(registryRoute(config, glm, spend, 0, "free"), { upstreams: ["liquid", "openrelay"] });
  });

  it("registryRoute: skips an upstream at its limit, blocks only when none can serve, then the person cap", () => {
    const config = readFreeConfig({ ...BASE_ENV, ...BOTH });
    const glm = modelById(GLM_FLASH)!;
    // GLM's share of Liquid's week used: Open Relay only.
    assert.deepEqual(registryRoute(config, glm, { usedUsd: {}, weekUsd: {}, modelWeekUsd: { "liquid:z-ai/glm-5.3-flash": 10 } }).upstreams, ["openrelay"]);
    // Liquid's whole week used, or its credit: Open Relay only.
    assert.deepEqual(registryRoute(config, glm, { usedUsd: {}, weekUsd: { liquid: 25 } }).upstreams, ["openrelay"]);
    assert.deepEqual(registryRoute(config, glm, { usedUsd: { liquid: 100 }, weekUsd: {} }).upstreams, ["openrelay"]);
    // Both at a limit: blocked, about the first one whose limit a fallback may follow.
    assert.deepEqual(registryRoute(config, glm, { usedUsd: {}, weekUsd: { liquid: 25, openrelay: 25 } }), { upstreams: [], block: "weekly_budget", blockProvider: "liquid" });
    assert.deepEqual(registryRoute({ ...config, "providerStatus.liquid": "paused" }, glm, { usedUsd: { openrelay: 200 }, weekUsd: {} }), { upstreams: [], block: "out_of_credit", blockProvider: "openrelay" });
    assert.deepEqual(registryRoute({ ...config, liquidApiKey: undefined, openrelayApiKey: undefined }, glm, { usedUsd: {}, weekUsd: {} }), { upstreams: [], block: "no_key", blockProvider: "liquid" });
    // The person cap, after the upstreams.
    assert.equal(registryRoute(config, glm, { usedUsd: {}, weekUsd: {} }, 0.5, "free").block, "person_cap");
    assert.equal(registryRoute(config, glm, { usedUsd: {}, weekUsd: {} }, 0.49, "free").block, undefined);
  });
});

describe("GLM 5.3 Flash upstreams: routing", () => {
  it("Liquid serves: its wire id, the zero-retention sellers and ceilings; the credit is charged on Liquid; Open Relay isn't called", async () => {
    const { service, token } = await member(BOTH);
    const response = await chat(service, token, GLM_FLASH, { stream: true, max_tokens: 1000 });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-dl-fallback"), null);
    assert.match(await response.text(), /1, 2, 3/);
    assert.equal(service.calls.liquid.length, 1);
    assert.equal(service.calls.openrelay.length, 0);
    const { body } = service.calls.liquid[0]!;
    assert.equal(body.model, "glm-5.3-flash");
    assert.deepEqual(body.exchange, {
      candidates: { providers: { allow: ["munitoai", "tensorx"] } },
      privacy: { retention: "none" },
      limits: { price: { input_usd_per_mtok: 0.2, cache_read_usd_per_mtok: 0.05, output_usd_per_mtok: 0.5 } },
      session: { sticky: true },
    });
    assert.deepEqual(rows(service).map((row) => [row.model, row.upstream, row.status, row.credit_usd]), [[GLM_FLASH, "liquid", "ok", 0.0004]]);
    const models = (await (await service.request("GET", "/v1/models", { token, ip: ip() })).json()) as { data: Array<Record<string, any>> };
    const glm = models.data.find((model) => model.id === GLM_FLASH)!;
    assert.deepEqual([glm.owned_by, glm.access, glm.ration.usdPerWeek], ["liquid", "free", 0.5]);
  });

  for (const [label, failure] of [
    ["429", () => Response.json({ error: { message: "busy" } }, { status: 429, headers: { "retry-after": "3" } })],
    ["503", () => Response.json({ error: { message: "no offer" } }, { status: 503 })],
    ["502", () => new Response("bad gateway", { status: 502 })],
    ["no eligible offer (400)", noOffer],
    ["a network error", () => Promise.reject(new Error("connect ECONNREFUSED"))],
  ] as const) {
    it(`Liquid ${label} before any bytes: Open Relay serves the same model, nothing charged on Liquid`, async () => {
      const { service, token } = await member(BOTH);
      service.setLiquid(failure as () => Response);
      const response = await chat(service, token, GLM_FLASH, { stream: true });
      assert.equal(response.status, 200);
      // Same model: no fallback header.
      assert.equal(response.headers.get("x-dl-fallback"), null);
      assert.match(await response.text(), /1, 2, 3/);
      assert.equal(service.calls.liquid.length, 1);
      assert.equal(service.calls.openrelay.length, 1);
      assert.equal(service.calls.openrelay[0]!.body.model, "openrelay/glm-5.3-flash");
      assert.equal(service.calls.openrelay[0]!.body.exchange, undefined);
      const [liquid, relay] = rows(service);
      assert.deepEqual([liquid!.model, liquid!.upstream, liquid!.credit_usd], [GLM_FLASH, "liquid", 0]);
      assert.deepEqual([relay!.model, relay!.upstream, relay!.status, relay!.credit_usd], [GLM_FLASH, "openrelay", "ok", 0.000023355]);
      assert.equal(service.calls.luminal.length, 0);
    });
  }

  it("Liquid timing out before its first byte: Open Relay serves", async () => {
    const { service, token } = await member({ ...BOTH, LIQUID_FIRST_BYTE_TIMEOUT_SECONDS: "0.05" });
    service.setLiquid((_body, init) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    const response = await chat(service, token, GLM_FLASH);
    assert.equal(response.status, 200);
    assert.deepEqual(rows(service).map((row) => [row.upstream, row.status]), [["liquid", "upstream_timeout"], ["openrelay", "ok"]]);
  });

  it("both fail: DeepSeek serves, with x-dl-fallback", async () => {
    const { service, token } = await member(BOTH);
    service.setLiquid(noOffer);
    service.setOpenRelay(() => Response.json({ error: { message: "tokens rate limit exceeded; retry after 9s" } }, { status: 429, headers: { "retry-after": "9" } }));
    const response = await chat(service, token, GLM_FLASH);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-dl-fallback"), MODEL);
    assert.deepEqual(rows(service).map((row) => [row.model, row.upstream, row.status]), [
      [GLM_FLASH, "liquid", "upstream_no_offer"],
      [GLM_FLASH, "openrelay", "upstream_busy"],
      [MODEL, "luminal", "ok"],
    ]);
  });

  it("all three fail: the last failure goes back as transient", async () => {
    const { service, token } = await member(BOTH);
    service.setLiquid(noOffer);
    service.setOpenRelay(() => Response.json({ error: {} }, { status: 503 }));
    service.setLuminal(() => Response.json({ error: {} }, { status: 429, headers: { "retry-after": "4" } }));
    const response = await chat(service, token, GLM_FLASH);
    assert.equal(response.status, 429);
    assert.equal((await errorOf(response)).retryable, true);
    assert.equal(response.headers.get("x-dl-fallback"), MODEL);
  });

  it("a request error (400) from Liquid goes back as it is: no other upstream", async () => {
    const { service, token } = await member(BOTH);
    service.setLiquid(() => Response.json({ error: { message: "unsupported_parameter: logit_bias", code: "unsupported_parameter" } }, { status: 400 }));
    const response = await chat(service, token, GLM_FLASH);
    assert.equal(response.status, 400);
    assert.equal(service.calls.openrelay.length, 0);
  });

  it("a stream that started on Liquid stays there", async () => {
    const { service, token } = await member(BOTH);
    service.setLiquid(() => liquidStream(luminalUsage(100, 10)));
    const response = await chat(service, token, GLM_FLASH, { stream: true });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(service.calls.openrelay.length, 0);
  });
});

describe("GLM 5.3 Flash upstreams: access", () => {
  it("is free for a free account on Liquid while Kimi there stays a dl Pro perk", async () => {
    const { service, token } = await member(BOTH);
    const kimi = await chat(service, token, KIMI);
    assert.equal(kimi.status, 402);
    assert.deepEqual(((await errorOf(kimi)) as Record<string, any>).reason, "pro_only");
    const glm = await chat(service, token, GLM_FLASH);
    assert.equal(glm.status, 200);
    assert.equal(service.calls.liquid.length, 1, "GLM 5.3 Flash went to Liquid; Kimi never did");
    assert.equal(service.calls.liquid[0]!.body.model, "glm-5.3-flash");
    const ids = ((await (await service.request("GET", "/v1/models", { token, ip: ip() })).json()) as { data: Array<{ id: string }> }).data.map((model) => model.id);
    assert.ok(ids.includes(GLM_FLASH));
    assert.ok(!ids.includes(KIMI));
    const me = (await (await service.request("GET", "/v1/me", { token, ip: ip() })).json()) as Record<string, any>;
    assert.deepEqual(me.proModels.map((model: Record<string, any>) => model.id), [KIMI]);
    assert.deepEqual(me.cappedModels.map((model: Record<string, any>) => [model.id, model.provider, model.access, model.usdPerWeek]), [[GLM_FLASH, "liquid", "free", 0.5]]);
  });

  it("Pro's Kimi ration isn't spent by GLM 5.3 Flash, and GLM's cap isn't spent by Kimi", async () => {
    const { service, token } = await member({ ...BOTH, ...BILLING, LIQUID_PERSON_WEEKLY_USD: "0.0005", GLM_5_3_FLASH_PERSON_WEEKLY_USD: "0.0005" });
    await makePro(service, 100);
    // Each Liquid request is charged $0.0004 (the harness's exchange estimate).
    assert.equal((await chat(service, token, GLM_FLASH)).status, 200);
    assert.equal((await chat(service, token, KIMI)).status, 200);
    assert.equal((await chat(service, token, KIMI)).status, 200);
    assert.equal((await errorOf(await chat(service, token, KIMI))).reason, "person_cap");
    assert.equal((await chat(service, token, GLM_FLASH)).status, 200);
    const people = db(service).prepare("SELECT provider, usd FROM provider_person_weeks WHERE github_id = 100 ORDER BY provider").all() as Array<{ provider: string; usd: number }>;
    assert.deepEqual(people.map((row) => [row.provider, Math.round(row.usd * 1e6) / 1e6]), [["liquid", 0.0008], [`model:${GLM_FLASH}`, 0.0008]]);
  });
});

describe("GLM 5.3 Flash upstreams: caps", () => {
  it("the person cap holds across both upstreams together, then DeepSeek (402 for Autopilot)", async () => {
    // $0.0004 on Liquid, then $0.000023 on Open Relay: past $0.0004.
    const { service, token } = await member({ ...BOTH, GLM_5_3_FLASH_PERSON_WEEKLY_USD: "0.0004" });
    service.setLiquid(() => liquidCompletion(luminalUsage(100, 10), 0.0003));
    assert.equal((await chat(service, token, GLM_FLASH)).status, 200);
    service.setLiquid(noOffer);
    assert.equal((await chat(service, token, GLM_FLASH)).status, 200);
    service.setOpenRelay(() => openRelayCompletion(openRelayUsage(100, 10), 200_000));
    assert.equal((await chat(service, token, GLM_FLASH)).status, 200);
    const capped = await chat(service, token, GLM_FLASH);
    assert.equal(capped.status, 402);
    const error = await errorOf(capped);
    assert.deepEqual([error.code, error.reason, error.alternative], ["provider_limit", "person_cap", MODEL]);
    assert.match(error.message, /^You've used this week's free GLM 5\.3 Flash/);
    // Liquid was tried three times (served the first), Open Relay served the other two.
    assert.deepEqual([service.calls.liquid.length, service.calls.openrelay.length], [3, 2]);
  });

  it("GLM's weekly share of Liquid used: Open Relay serves GLM, and Kimi keeps Liquid", async () => {
    const { service, token, admin } = await member({ ...BOTH, LIQUID_PLANS: "all", LIQUID_PERSON_WEEKLY_USD: "none", GLM_5_3_FLASH_PERSON_WEEKLY_USD: "none", LIQUID_WEEKLY_CREDIT_GLM_5_3_FLASH: "0.0004" });
    assert.equal((await chat(service, token, GLM_FLASH)).status, 200);
    assert.equal((await chat(service, token, GLM_FLASH)).status, 200);
    assert.equal((await chat(service, token, KIMI)).status, 200);
    assert.deepEqual(rows(service).map((row) => [row.model, row.upstream]), [
      [GLM_FLASH, "liquid"],
      [GLM_FLASH, "openrelay"],
      [KIMI, "liquid"],
    ]);
    // The admin view shows GLM on both providers, with its share and spend on each.
    const view = (await (await service.request("GET", "/v1/admin/providers", { token: admin })).json()) as { providers: Array<Record<string, any>> };
    const liquid = view.providers.find((provider) => provider.id === "liquid")!;
    const relay = view.providers.find((provider) => provider.id === "openrelay")!;
    const glmOnLiquid = liquid.models.find((model: Record<string, any>) => model.id === GLM_FLASH);
    assert.deepEqual([glmOnLiquid.role, glmOnLiquid.on, glmOnLiquid.userWeekUsd, glmOnLiquid.weeklyShareUsd], ["primary", true, 0.0004, 0.0004]);
    assert.deepEqual(liquid.models.find((model: Record<string, any>) => model.id === KIMI).weeklyShareUsd, 15);
    const glmOnRelay = relay.models.find((model: Record<string, any>) => model.id === GLM_FLASH);
    assert.deepEqual([glmOnRelay.role, glmOnRelay.on, glmOnRelay.userWeekUsd, glmOnRelay.weeklyShareUsd], ["backup", true, 0.000023, null]);
  });

  it("Kimi's weekly share of Liquid used: Kimi is at its weekly budget, GLM keeps Liquid", async () => {
    const { service, token } = await member({ ...BOTH, LIQUID_PLANS: "all", LIQUID_PERSON_WEEKLY_USD: "none", LIQUID_WEEKLY_CREDIT_KIMI_K3_1_PRO: "0.0004" });
    assert.equal((await chat(service, token, KIMI)).status, 200);
    const refused = await errorOf(await chat(service, token, KIMI));
    assert.deepEqual([refused.reason, refused.provider], ["weekly_budget", "liquid"]);
    assert.equal((await chat(service, token, GLM_FLASH)).status, 200);
    assert.equal(rows(service).at(-1)!.upstream, "liquid");
  });

  it("both upstreams at their weekly budgets: Autopilot gets 402, another agent gets DeepSeek", async () => {
    const { service, token } = await member({ ...BOTH, GLM_5_3_FLASH_PERSON_WEEKLY_USD: "none", LIQUID_WEEKLY_CREDIT_GLM_5_3_FLASH: "0.0001", OPENRELAY_WEEKLY_CREDIT_USD: "0.00001" });
    assert.equal((await chat(service, token, GLM_FLASH)).status, 200);
    assert.equal((await chat(service, token, GLM_FLASH)).status, 200);
    const refused = await errorOf(await chat(service, token, GLM_FLASH));
    assert.deepEqual([refused.code, refused.reason, refused.provider, refused.alternative], ["provider_limit", "weekly_budget", "liquid", MODEL]);
    const key = ((await (await service.request("POST", "/v1/harness-keys", { token, body: { harness: "opencode" } })).json()) as { key: string }).key;
    const served = await chat(service, key, GLM_FLASH);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("x-dl-fallback"), MODEL);
  });
});

describe("GLM 5.3 Flash upstreams: alerts", () => {
  it("Liquid's 80% credit alert says GLM 5.3 Flash moves to Open Relay and Kimi is hidden", async () => {
    const { service, token } = await member({ ...BOTH, LIQUID_PLANS: "all", LIQUID_PERSON_WEEKLY_USD: "none", LIQUID_CREDIT_USD: "0.0005", ALERT_WEBHOOK_URL: "https://alerts.test/hook" });
    assert.equal((await chat(service, token, GLM_FLASH)).status, 200);
    const texts = service.calls.webhooks.map((hook) => String(hook.body.text));
    assert.ok(
      texts.some((text) => text.includes("Liquid Inference credit used") && text.includes("At 100%: Kimi K3.1 Pro is hidden and requests for it get 402 provider_limit with DeepSeek as the alternative; GLM 5.3 Flash moves to Open Relay, then DeepSeek V4.1 Flash 1017.")),
      texts.join("\n"),
    );
  });
});

describe("GLM 5.3 Flash upstreams: /v1/providers and probes", () => {
  it("lists GLM 5.3 Flash once, under Liquid, with Open Relay as its backup; each upstream probed and measured on its own", async () => {
    const { service } = await member(BOTH);
    const at = Date.parse("2026-11-04T13:10:00.000Z");
    service.clock.now = at;
    await scheduled(service, PROBE_CRON, at);
    assert.deepEqual(service.calls.liquid.map((call) => call.body.model), ["kimi-k3.1-pro", "glm-5.3-flash"]);
    assert.deepEqual(service.calls.openrelay.map((call) => call.body.model), ["openrelay/glm-5.3-flash"]);
    const probes = db(service).prepare("SELECT provider, model, ok FROM provider_probes WHERE model = ? ORDER BY provider").all(GLM_FLASH) as Array<Record<string, any>>;
    assert.deepEqual(probes.map((row) => [row.provider, row.ok]), [["liquid", 1], ["openrelay", 1]]);
    service.clock.now += 61_000;
    const pub = (await (await service.request("GET", "/v1/providers", { ip: ip() })).json()) as { providers: Array<Record<string, any>> };
    const listedUnder = pub.providers.filter((provider) => provider.models.some((model: Record<string, any>) => model.id === GLM_FLASH)).map((provider) => provider.id);
    assert.deepEqual(listedUnder, ["liquid"]);
    const glm = pub.providers.find((provider) => provider.id === "liquid")!.models.find((model: Record<string, any>) => model.id === GLM_FLASH);
    assert.deepEqual([glm.access, glm.status, glm.contextWindow], ["free", "on", 262_144]);
    assert.ok(glm.measuredAt !== null);
    assert.equal(glm.backups.length, 1);
    const backup = glm.backups[0];
    assert.deepEqual([backup.provider, backup.name, backup.website, backup.status], ["openrelay", "Open Relay", "https://openrelay.inc/", "on"]);
    assert.ok(backup.measuredAt !== null);
    // Open Relay has no model of its own, so it isn't a card of its own.
    assert.ok(!pub.providers.some((provider) => provider.id === "openrelay"));
  });

  it("without Liquid's key, Open Relay is where it's listed, with no backup", async () => {
    const { service } = await member({ OPENRELAY_API_KEY: OPENRELAY_KEY, OPENRELAY_STATUS: "on" });
    const pub = (await (await service.request("GET", "/v1/providers", { ip: ip() })).json()) as { providers: Array<Record<string, any>> };
    const glm = pub.providers.find((provider) => provider.id === "openrelay")!.models[0];
    assert.equal(glm.id, GLM_FLASH);
    assert.equal(glm.backups, undefined);
  });
});
