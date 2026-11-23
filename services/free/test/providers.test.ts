import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { ADMIN_ID, completion, createService, liquidCompletion, liquidStream, luminalUsage, MODEL, openaiResponse, responsesUsage, sse, usage, type Service } from "./harness.js";
import { readFreeConfig } from "../src/config.js";
import { FREE_MODELS, modelById } from "../src/models.js";
import { PROBE_CRON, PROBE_MAX_TOKENS, PROBE_PROMPT } from "../src/probes.js";
import { PROVIDERS, providerSettings, registryBlock } from "../src/providers.js";
import { parseSettingsUpdate } from "../src/runtime-config.js";

/**
 * The provider registry (providers.ts): OpenAI and Luminal moved into it unchanged, Liquid
 * Inference added as a registry provider (Kimi K3.1 Pro on, GLM 5.3 defined and off), the
 * shared open-models budget, the opt-in cap, out-of-credit hiding, the 80% alert, the speed
 * probes, and the public GET /v1/providers.
 */

const KIMI = "moonshotai/kimi-k3.1-pro";
const GLM = "z-ai/glm-5.3";
const LIQUID_KEY = "sk-architect-test-secret";
const HOOK = "https://alerts.test/hook";
/** Liquid with a key and on. */
const LIQUID_ON = { LIQUID_INFERENCE_API_KEY: LIQUID_KEY, LIQUID_STATUS: "on" };
const BASE_ENV = { OPENROUTER_API_KEY: "k", GITHUB_CLIENT_ID: "c", GITHUB_CLIENT_SECRET: "s", TOKEN_SIGNING_KEY: "x".repeat(32) };

let ips = 0;
const ip = () => `10.9.${Math.floor(++ips / 250) % 250}.${ips % 250}`;

async function member(vars: Record<string, string> = {}): Promise<{ service: Service; token: string; admin: string }> {
  const service = await createService({ OPEN_ADMISSION: "true", OPENAI_API_KEY: "sk-openai-test", LUMINAL_API_KEY: "lum-test", ALERT_WEBHOOK_URL: HOOK, ...vars });
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const token = (await service.signIn({ id: 100, login: "alice" })).access_token;
  return { service, token, admin };
}

const chat = (service: Service, token: string, model: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  service.request("POST", "/v1/chat/completions", { token, ip: ip(), headers, body: { model, messages: [{ role: "user", content: "hello" }], ...body } });

async function errorOf(response: Response): Promise<Record<string, any>> {
  return ((await response.json()) as { error: Record<string, any> }).error;
}

async function listed(service: Service, token: string): Promise<string[]> {
  const body = (await (await service.request("GET", "/v1/models", { token, ip: ip() })).json()) as { data: Array<{ id: string }> };
  return body.data.map((model) => model.id);
}

function db(service: Service): DatabaseSync {
  service.directory();
  return (service.namespaces.DIRECTORY!.instances.get("directory")!.state as unknown as { db: DatabaseSync }).db;
}

async function scheduled(service: Service, cron: string, at = service.clock.now): Promise<void> {
  await (service.handler as unknown as { scheduled(controller: { cron: string; scheduledTime: number }, env: never): Promise<void> }).scheduled({ cron, scheduledTime: at }, service.env as never);
}

const alertTexts = (service: Service) => service.calls.webhooks.map((hook) => String(hook.body.text));

describe("provider registry: OpenAI and Luminal unchanged", () => {
  it("reads OpenAI's and Luminal's settings under their old names, and takes the generic names as aliases", () => {
    const config = readFreeConfig({ ...BASE_ENV, LUMINAL_CREDIT_USD: "1500", OPENAI_WEEKLY_CREDIT_USD: "900" });
    assert.equal(providerSettings(config, "luminal").creditUsd, 1500);
    assert.equal(providerSettings(config, "openai").weeklyCreditUsd, 900);
    assert.equal(providerSettings(config, "luminal").optIn, false);
    assert.deepEqual(parseSettingsUpdate({ "providerCredit.luminal": 3000, "providerWeeklyCredit.openai": "none" }), {
      changes: [
        { key: "luminalCreditUsd", value: 3000 },
        { key: "openaiWeeklyCreditUsd", value: null },
      ],
    });
    assert.deepEqual(
      PROVIDERS.map((provider) => [provider.id, provider.kind, provider.keyEnv]),
      [
        ["openai", "legacy", "OPENAI_API_KEY"],
        ["luminal", "legacy", "LUMINAL_API_KEY"],
        ["liquid", "registry", "LIQUID_INFERENCE_API_KEY"],
      ],
    );
  });

  it("an alias update changes the old setting", async () => {
    const { service, admin } = await member();
    const response = await service.request("POST", "/admin/config", { token: admin, body: { "providerCredit.luminal": 1234 } });
    assert.equal(response.status, 200);
    const view = (await (await service.request("GET", "/admin/config", { token: admin })).json()) as { effective: Record<string, unknown> };
    assert.equal(view.effective.luminalCreditUsd, 1234);
    assert.equal(view.effective["providerCredit.luminal"], 1234);
  });

  it("serves DeepSeek on Luminal and GPT-6 on OpenAI as before, with Liquid configured too", async () => {
    const { service, token } = await member(LIQUID_ON);
    service.setLuminal(() => completion(luminalUsage(100, 10)));
    service.setOpenAI(() => openaiResponse(responsesUsage(100, 10)));
    assert.equal((await chat(service, token, MODEL)).status, 200);
    assert.equal((await chat(service, token, "gpt-6-luna")).status, 200);
    assert.equal(service.calls.luminal.length, 1);
    assert.equal(service.calls.openai.length, 1);
    assert.equal(service.calls.liquid.length, 0);
    const rows = db(service).prepare("SELECT model, upstream FROM requests ORDER BY id").all();
    assert.deepEqual(
      rows.map((row) => [row.model, row.upstream]),
      [
        [MODEL, "luminal"],
        ["gpt-6-luna", "openai"],
      ],
    );
  });

  it("without a Liquid key, nothing about Liquid shows: models, status, /v1/me, and a request for Kimi is an unknown model", async () => {
    const { service, token } = await member();
    assert.deepEqual(await listed(service, token), ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra", MODEL]);
    const status = (await (await service.request("GET", "/v1/status", { ip: ip() })).json()) as { models: Array<{ id: string }> };
    assert.deepEqual(
      status.models.map((model) => model.id),
      ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra", MODEL],
    );
    const me = (await (await service.request("GET", "/v1/me", { token, ip: ip() })).json()) as { models: string[]; pools: Record<string, { models: string[] }> };
    assert.deepEqual(me.pools.deepseek!.models, [MODEL]);
    assert.ok(!me.models.includes(KIMI));
    const refused = await chat(service, token, KIMI);
    assert.equal(refused.status, 400);
    assert.equal((await errorOf(refused)).code, "model_not_allowed");
  });

  it("puts Kimi and GLM in the open-models budget, GLM off by default", () => {
    for (const id of [KIMI, GLM]) {
      const model = modelById(id)!;
      assert.equal(model.provider, "liquid");
      assert.equal(model.family, "deepseek", `${id} spends the open-models budget`);
      assert.equal(model.pool, "deepseek");
    }
    assert.deepEqual(providerSettings(readFreeConfig(BASE_ENV), "liquid").models, [KIMI]);
    assert.deepEqual(new Set(FREE_MODELS.map((model) => model.family)), new Set(["gpt6", "deepseek"]), "no new budget");
  });
});

describe("Liquid Inference routing", () => {
  it("sends Kimi to Liquid in its shape: exchange rules, top-level session id, nothing it would refuse", async () => {
    const { service, token } = await member(LIQUID_ON);
    const response = await chat(service, token, KIMI, { stream: true, max_tokens: 2000, reasoning: { effort: "high" }, provider: { order: ["x"] }, usage: { include: true }, exchange: { candidates: {} }, models: ["a"] }, { "x-session-id": "sess-1" });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(service.calls.liquid.length, 1);
    const { body, headers } = service.calls.liquid[0]!;
    assert.equal(headers.authorization, `Bearer ${LIQUID_KEY}`);
    assert.equal(body.model, "kimi-k3.1-pro");
    assert.equal(body.session_id, "sess-1");
    assert.equal(body.max_tokens, 2000);
    assert.deepEqual(body.stream_options, { include_usage: true });
    assert.deepEqual(body.reasoning, { effort: "high" });
    assert.match(String(body.user), /^dl-[0-9a-f]{32}$/);
    for (const field of ["provider", "usage", "models", "max_completion_tokens"]) assert.equal(body[field], undefined, field);
    assert.deepEqual(body.exchange, {
      candidates: { providers: { allow: ["deeprelay"] } },
      privacy: { retention: "none" },
      limits: { price: { input_usd_per_mtok: 2.1, cache_read_usd_per_mtok: 0.25, output_usd_per_mtok: 10.5 } },
      session: { sticky: true },
    });
    // The credit is charged what the exchange said; the person's allowance, Kimi's prices.
    const row = db(service).prepare("SELECT upstream, credit_usd, cost_usd, status FROM requests").get() as Record<string, any>;
    assert.equal(row.upstream, "liquid");
    assert.equal(row.status, "ok");
    assert.equal(row.credit_usd, 0.0004);
    assert.ok(Math.abs(row.cost_usd - (100 * 2.1 + 10 * 10.5) / 1e6) < 1e-12);
  });

  it("takes the seller list and price ceilings from the runtime settings", async () => {
    const { service, token, admin } = await member(LIQUID_ON);
    const set = await service.request("POST", "/admin/config", { token: admin, body: { "exchangeAllow.kimi-k3.1-pro": ["deeprelay", "EmpirioLabs AI"], "exchangeMaxPrices.kimi-k3.1-pro": [2, 0.2, 10] } });
    assert.equal(set.status, 200);
    assert.equal((await chat(service, token, KIMI)).status, 200);
    const exchange = service.calls.liquid[0]!.body.exchange as Record<string, any>;
    assert.deepEqual(exchange.candidates.providers.allow, ["deeprelay", "EmpirioLabs AI"]);
    assert.deepEqual(exchange.limits.price, { input_usd_per_mtok: 2, cache_read_usd_per_mtok: 0.2, output_usd_per_mtok: 10 });
  });

  it("charges the credit at the ceiling price plus fee when the exchange doesn't say", async () => {
    const { service, token } = await member(LIQUID_ON);
    service.setLiquid(() => Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "hi" } }], usage: luminalUsage(1_000_000, 0) }));
    assert.equal((await chat(service, token, KIMI)).status, 200);
    const row = db(service).prepare("SELECT credit_usd FROM requests").get() as { credit_usd: number };
    assert.ok(Math.abs(row.credit_usd - 2.205) < 1e-9);
  });

  it("is paused until the owner turns it on, and GLM stays unknown while it's off", async () => {
    const { service, token, admin } = await member({ LIQUID_INFERENCE_API_KEY: LIQUID_KEY });
    assert.ok(!(await listed(service, token)).includes(KIMI));
    const paused = await chat(service, token, KIMI);
    assert.equal(paused.status, 402);
    const error = await errorOf(paused);
    assert.equal(error.code, "provider_limit");
    assert.equal(error.reason, "paused");
    assert.equal(error.alternative, MODEL);
    assert.equal(service.calls.liquid.length, 0);
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { "providerStatus.liquid": "on" } })).status, 200);
    assert.ok((await listed(service, token)).includes(KIMI));
    assert.equal((await chat(service, token, KIMI)).status, 200);
    assert.equal((await errorOf(await chat(service, token, GLM))).code, "model_not_allowed");
  });

  it("passes Liquid's failures back as transient, with no fallback to another model", async () => {
    const { service, token } = await member(LIQUID_ON);
    service.setLiquid(() => Response.json({ error: { type: "unavailable", code: "model_unavailable" } }, { status: 503, headers: { "retry-after": "30" } }));
    const response = await chat(service, token, KIMI);
    assert.equal(response.status, 503);
    const error = await errorOf(response);
    assert.equal(error.upstream, "liquid");
    assert.equal(response.headers.get("retry-after"), "30");
    assert.equal(service.calls.luminal.length, 0);
  });
});

describe("the open-models budget is shared", () => {
  it("Kimi's spend counts against the same weekly budget as DeepSeek's", async () => {
    // A $0.50 open-models week; a Kimi request that costs it all at Kimi's prices.
    const { service, token } = await member({ ...LIQUID_ON, DEEPSEEK_WEEKLY_USD_CAP: "0.5", LIQUID_PERSON_WEEKLY_USD: "none" });
    service.setLiquid(() => liquidCompletion(luminalUsage(240_000, 0), 0.1));
    assert.equal((await chat(service, token, KIMI)).status, 200);
    const me = (await (await service.request("GET", "/v1/me", { token, ip: ip() })).json()) as { budgets: { deepseek: { spentUsd: number; usdPerWeek: number } } };
    assert.ok(me.budgets.deepseek.spentUsd >= 0.5, `spent ${me.budgets.deepseek.spentUsd}`);
    const deepseek = await chat(service, token, MODEL);
    assert.equal(deepseek.status, 402);
    assert.equal((await errorOf(deepseek)).code, "quota_exceeded");
    const kimi = await chat(service, token, KIMI);
    assert.equal(kimi.status, 402);
    assert.equal((await errorOf(kimi)).code, "quota_exceeded");
  });
});

describe("opt-in cap", () => {
  it("holds one person to the per-person weekly Liquid spend, then hides Kimi and points at DeepSeek", async () => {
    const { service, token, admin } = await member({ ...LIQUID_ON, LIQUID_PERSON_WEEKLY_USD: "0.001" });
    service.setLiquid(() => liquidCompletion(luminalUsage(100, 10), 0.002));
    const models = (await (await service.request("GET", "/v1/models", { token, ip: ip() })).json()) as { data: Array<{ id: string; access: string }> };
    assert.equal(models.data.find((model) => model.id === KIMI)?.access, "opt-in");
    assert.equal((await chat(service, token, KIMI)).status, 200);
    const capped = await chat(service, token, KIMI);
    assert.equal(capped.status, 402);
    const error = await errorOf(capped);
    assert.deepEqual(
      { code: error.code, reason: error.reason, alternative: error.alternative, family: error.family, provider: error.provider, resetsAt: error.resetsAt },
      { code: "provider_limit", reason: "person_cap", alternative: MODEL, family: "deepseek", provider: "liquid", resetsAt: "2026-11-09T00:00:00.000Z" },
    );
    assert.ok(!(await listed(service, token)).includes(KIMI));
    assert.equal(service.calls.liquid.length, 1);
    // DeepSeek still works, and another person (here the admin) isn't held by alice's spend.
    assert.equal((await chat(service, token, MODEL)).status, 200);
    assert.equal((await chat(service, admin, KIMI)).status, 200);
  });

  it("stops everyone at the provider's weekly budget, admins' spend left out of it", async () => {
    const { service, token, admin } = await member({ ...LIQUID_ON, LIQUID_WEEKLY_CREDIT_USD: "0.003", LIQUID_PERSON_WEEKLY_USD: "none" });
    service.setLiquid(() => liquidCompletion(luminalUsage(100, 10), 0.002));
    assert.equal((await chat(service, admin, KIMI)).status, 200);
    assert.equal((await chat(service, token, KIMI)).status, 200);
    assert.equal((await chat(service, token, KIMI)).status, 200);
    const stopped = await chat(service, token, KIMI);
    assert.equal(stopped.status, 402);
    assert.equal((await errorOf(stopped)).reason, "weekly_budget");
  });
});

describe("out of credit", () => {
  it("hides the provider's models and answers 402 with DeepSeek as the alternative", async () => {
    const { service, token, admin } = await member({ ...LIQUID_ON, LIQUID_CREDIT_USD: "0.003", LIQUID_PERSON_WEEKLY_USD: "none" });
    service.setLiquid(() => liquidCompletion(luminalUsage(100, 10), 0.004));
    assert.equal((await chat(service, token, KIMI)).status, 200);
    assert.ok(!(await listed(service, token)).includes(KIMI));
    assert.ok(!(await listed(service, admin)).includes(KIMI), "admins too: there's no credit");
    for (const caller of [token, admin]) {
      const refused = await chat(service, caller, KIMI);
      assert.equal(refused.status, 402);
      const error = await errorOf(refused);
      assert.equal(error.code, "provider_limit");
      assert.equal(error.reason, "out_of_credit");
      assert.equal(error.alternative, MODEL);
      assert.equal(error.resetsAt, null);
    }
    assert.equal(service.calls.liquid.length, 1);
    const providers = (await (await service.request("GET", "/v1/providers", { ip: ip() })).json()) as { providers: Array<{ id: string; models: Array<{ id: string; status: string }> }> };
    assert.equal(providers.providers.find((provider) => provider.id === "liquid")!.models[0]!.status, "out_of_credit");
    // Raising the credit after a top-up brings it back.
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { "providerCredit.liquid": 100 } })).status, 200);
    assert.ok((await listed(service, token)).includes(KIMI));
  });

  it("registryBlock says why, in order", () => {
    const config = readFreeConfig({ ...BASE_ENV, ...LIQUID_ON, LIQUID_CREDIT_USD: "10", LIQUID_WEEKLY_CREDIT_USD: "5", LIQUID_PERSON_WEEKLY_USD: "1" });
    const kimi = modelById(KIMI)!;
    assert.equal(registryBlock(config, kimi, { usedUsd: {}, weekUsd: {} }, 0), undefined);
    assert.equal(registryBlock(config, kimi, { usedUsd: {}, weekUsd: {} }, 1), "person_cap");
    assert.equal(registryBlock(config, kimi, { usedUsd: {}, weekUsd: { liquid: 5 } }, 0), "weekly_budget");
    assert.equal(registryBlock(config, kimi, { usedUsd: { liquid: 10 }, weekUsd: { liquid: 5 } }, 1), "out_of_credit");
    assert.equal(registryBlock({ ...config, liquidApiKey: undefined }, kimi, { usedUsd: {}, weekUsd: {} }), "no_key");
    assert.equal(registryBlock(config, modelById(MODEL)!, { usedUsd: { liquid: 99 }, weekUsd: {} }), undefined, "never DeepSeek");
  });
});

describe("80% credit alert", () => {
  it("sends one alert when Liquid's credit passes 80%, and no more", async () => {
    const { service, token } = await member({ ...LIQUID_ON, LIQUID_CREDIT_USD: "1", LIQUID_WEEKLY_CREDIT_USD: "none", LIQUID_PERSON_WEEKLY_USD: "none" });
    for (const charge of [0.5, 0.35, 0.05, 0.05]) {
      service.setLiquid(() => liquidCompletion(luminalUsage(100, 10), charge));
      assert.equal((await chat(service, token, KIMI)).status, 200);
    }
    const liquid = alertTexts(service).filter((text) => text.includes("Liquid Inference credit"));
    assert.equal(liquid.length, 1);
    assert.match(liquid[0]!, /\$0\.85 of the \$1 Liquid Inference credit used/);
    assert.match(liquid[0]!, /providerCredit\.liquid/);
  });

  it("puts Liquid's credit in the daily digest once it's on", async () => {
    const { service, token } = await member({ ...LIQUID_ON, LIQUID_PERSON_WEEKLY_USD: "none" });
    service.setLiquid(() => liquidCompletion(luminalUsage(100, 10), 2));
    assert.equal((await chat(service, token, KIMI)).status, 200);
    service.clock.now += 86_400_000;
    await scheduled(service, "0 1 * * *");
    const digest = alertTexts(service).find((text) => text.includes("daily digest"))!;
    assert.match(digest, /Liquid Inference credit left: \$98 of \$100 \(\$2 of \$25 this week; on\)/);
  });
});

/** A Liquid stream that takes 400 ms to its first token and 1 s for 100 tokens after it. */
function timedStream(service: Service, completionTokens = 100): Response {
  const encoder = new TextEncoder();
  const chunks = [
    { delay: 400, data: { choices: [{ index: 0, delta: { content: "1, 2, 3" } }] } },
    { delay: 1000, data: { choices: [], usage: luminalUsage(20, completionTokens), exchange: { job_id: "job_p", provider_slug: "deeprelay", status: "settled", charge: { total_usd: 0.001 } } } },
  ];
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks[index++];
        if (!next) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }
        service.clock.now += next.delay;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(next.data)}\n\n`));
      },
    }, { highWaterMark: 0 }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("speed probes", () => {
  it("sends one tiny stream per model that can serve, and records time to first token and tokens a second", async () => {
    const { service, admin } = await member(LIQUID_ON);
    service.setLiquid(() => timedStream(service));
    service.setLuminal(() => timedStream(service, 50));
    service.setOpenAI(() => Response.json({ error: { message: "busy" } }, { status: 503 }));
    // The top of an hour: the pricey models (Astra, Kimi) are probed too.
    const at = Date.parse("2026-11-04T13:00:00.000Z");
    service.clock.now = at;
    await scheduled(service, PROBE_CRON, at);
    assert.equal(service.calls.liquid.length, 1);
    const probe = service.calls.liquid[0]!.body;
    assert.equal(probe.model, "kimi-k3.1-pro");
    assert.equal(probe.max_tokens, PROBE_MAX_TOKENS);
    assert.equal(probe.stream, true);
    assert.deepEqual(probe.messages, [{ role: "user", content: PROBE_PROMPT }]);
    assert.deepEqual((probe.exchange as Record<string, unknown>).privacy, { retention: "none" });
    assert.equal(service.calls.luminal.length, 1);
    assert.equal(service.calls.openai.length, 3, "Luna, Sol and Astra");
    const rows = db(service).prepare("SELECT at, provider, model, ok, ttft_ms, tokens_per_second, cost_usd, error FROM provider_probes ORDER BY model").all() as Array<Record<string, any>>;
    const kimi = rows.find((row) => row.model === KIMI)!;
    assert.deepEqual({ ok: kimi.ok, ttft: kimi.ttft_ms, tps: kimi.tokens_per_second, cost: kimi.cost_usd }, { ok: 1, ttft: 400, tps: 100, cost: 0.001 });
    assert.equal(rows.filter((row) => row.provider === "openai").every((row) => row.ok === 0 && row.error === "http_503"), true);
    // Probes aren't anyone's usage: no request rows, but the cost is on Liquid's credit.
    assert.equal((db(service).prepare("SELECT COUNT(*) AS n FROM requests").get() as { n: number }).n, 0);
    const view = (await (await service.request("GET", "/v1/admin/providers", { token: admin })).json()) as { providers: Array<Record<string, any>>; probes: Array<Record<string, any>> };
    const liquid = view.providers.find((provider) => provider.id === "liquid")!;
    assert.equal(liquid.usedUsd, 0.001);
    assert.equal(liquid.probeWeekUsd, 0.001);
    assert.equal(liquid.leftUsd, 99.999);
    assert.equal(view.probes.length, rows.length);
    // The public endpoint shows the probe's numbers while there's no real traffic.
    const pub = (await (await service.request("GET", "/v1/providers", { ip: ip() })).json()) as { providers: Array<{ id: string; models: Array<Record<string, any>> }> };
    const kimiPublic = pub.providers.find((provider) => provider.id === "liquid")!.models[0]!;
    assert.deepEqual(
      { tps: kimiPublic.tokensPerSecond, ttft: kimiPublic.ttftMs, success: kimiPublic.successRate24h, at: kimiPublic.measuredAt },
      // The probes run one at a time; Kimi's started after Luminal's 1.4 s one.
      { tps: 100, ttft: 400, success: 1, at: new Date(kimi.at).toISOString() },
    );
  });

  it("probes pricey models only at the top of the hour, and skips paused or spent providers", async () => {
    const { service } = await member({ LIQUID_INFERENCE_API_KEY: LIQUID_KEY });
    service.setLuminal(() => sse([JSON.stringify({ choices: [{ index: 0, delta: { content: "1" } }] }), JSON.stringify({ choices: [], usage: luminalUsage(20, 5) })]));
    const at = Date.parse("2026-11-04T13:10:00.000Z");
    service.clock.now = at;
    await scheduled(service, PROBE_CRON, at);
    assert.equal(service.calls.liquid.length, 0, "Liquid is paused by default");
    assert.deepEqual(
      service.calls.openai.map((call) => call.body.model),
      ["gpt-6-luna", "gpt-6.1-sol"],
      "Astra only hourly",
    );
    assert.equal(service.calls.luminal.length, 1);
  });

  it("is off with the speedProbes setting", async () => {
    const { service } = await member({ ...LIQUID_ON, SPEED_PROBES: "false" });
    await scheduled(service, PROBE_CRON);
    assert.equal(service.calls.liquid.length + service.calls.luminal.length + service.calls.openai.length, 0);
  });

  it("skips a provider out of credit", async () => {
    const { service, token } = await member({ ...LIQUID_ON, LIQUID_CREDIT_USD: "0.001", LIQUID_PERSON_WEEKLY_USD: "none" });
    service.setLiquid(() => liquidCompletion(luminalUsage(100, 10), 0.002));
    assert.equal((await chat(service, token, KIMI)).status, 200);
    const before = service.calls.liquid.length;
    const at = Date.parse("2026-11-04T13:00:00.000Z");
    await scheduled(service, PROBE_CRON, at);
    assert.equal(service.calls.liquid.length, before);
  });
});

describe("GET /v1/providers", () => {
  it("returns exactly the contract: no auth, CORS for anyone, cached a minute", async () => {
    const { service } = await member(LIQUID_ON);
    const response = await service.request("GET", "/v1/providers", { ip: ip() });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("cache-control"), "public, max-age=60");
    const body = (await response.json()) as Record<string, any>;
    assert.deepEqual(Object.keys(body), ["updatedAt", "providers"]);
    assert.equal(body.updatedAt, new Date(service.clock.now).toISOString());
    assert.deepEqual(
      body.providers.map((provider: Record<string, unknown>) => provider.id),
      ["openai", "luminal", "liquid"],
    );
    const liquid = body.providers[2];
    assert.deepEqual(liquid, {
      id: "liquid",
      name: "Liquid Inference",
      website: "https://liquidinference.ai/",
      url: "https://liquidinference.ai/?utm_source=dl.new&utm_medium=referral&utm_campaign=providers",
      logo: "/logos/liquid.svg",
      models: [
        {
          id: KIMI,
          name: "Kimi K3.1 Pro",
          family: "kimi",
          contextWindow: 1_048_576,
          access: "opt-in",
          status: "on",
          tokensPerSecond: null,
          ttftMs: null,
          successRate24h: null,
          measuredAt: null,
        },
      ],
    });
    const deepseek = body.providers[1].models[0];
    assert.deepEqual([deepseek.id, deepseek.family, deepseek.access, deepseek.status], [MODEL, "deepseek", "free", "on"]);
    assert.deepEqual(
      body.providers[0].models.map((model: Record<string, unknown>) => [model.id, model.family, model.access]),
      [
        ["gpt-6-luna", "gpt6", "trusted"],
        ["gpt-6.1-sol", "gpt6", "trusted"],
        ["gpt-6-astra", "gpt6", "trusted"],
      ],
    );
    for (const provider of body.providers) {
      assert.deepEqual(Object.keys(provider), ["id", "name", "website", "url", "logo", "models"]);
      for (const model of provider.models) {
        assert.deepEqual(Object.keys(model), ["id", "name", "family", "contextWindow", "access", "status", "tokensPerSecond", "ttftMs", "successRate24h", "measuredAt"]);
      }
    }
    const preflight = await service.request("OPTIONS", "/v1/providers", { ip: ip() });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  });

  it("never shows keys, credit, spend or terms", async () => {
    const { service, token } = await member({ ...LIQUID_ON, LIQUID_CREDIT_USD: "123.45", LIQUID_PERSON_WEEKLY_USD: "none" });
    service.setLiquid(() => liquidCompletion(luminalUsage(100, 10), 0.0789));
    assert.equal((await chat(service, token, KIMI)).status, 200);
    service.clock.now += 61_000;
    const text = await (await service.request("GET", "/v1/providers", { ip: ip() })).text();
    for (const secret of [LIQUID_KEY, "sk-openai-test", "lum-test", "sk-or-test", "123.45", "0.0789", "credit", "usd", "deeprelay", "price", "allow"]) {
      assert.ok(!text.toLowerCase().includes(secret.toLowerCase()), `public output has ${secret}`);
    }
  });

  it("uses real traffic once a model has enough of it", async () => {
    const { service, token } = await member(LIQUID_ON);
    const ttft = 300;
    service.setLuminal(() => {
      service.clock.now += ttft;
      return sse([JSON.stringify({ choices: [{ index: 0, delta: { content: "hi" } }] }), JSON.stringify({ choices: [], usage: luminalUsage(100, 200) })]);
    });
    for (let index = 0; index < 20; index++) {
      const response = await chat(service, token, MODEL, { stream: true });
      await response.text();
    }
    const body = (await (await service.request("GET", "/v1/providers", { ip: ip() })).json()) as { providers: Array<{ id: string; models: Array<Record<string, any>> }> };
    const deepseek = body.providers.find((provider) => provider.id === "luminal")!.models[0]!;
    assert.equal(deepseek.successRate24h, 1);
    assert.equal(deepseek.ttftMs, ttft);
  });
});

describe("admin providers", () => {
  it("shows each provider's credit used and left, to admins only", async () => {
    const { service, token, admin } = await member({ ...LIQUID_ON, LIQUID_PERSON_WEEKLY_USD: "none" });
    service.setLiquid(() => liquidCompletion(luminalUsage(100, 10), 1.5));
    service.setOpenRouter(() => completion(usage(100, 10)));
    assert.equal((await chat(service, token, KIMI)).status, 200);
    assert.equal((await service.request("GET", "/v1/admin/providers", { token })).status, 403);
    const view = (await (await service.request("GET", "/v1/admin/providers", { token: admin })).json()) as { providers: Array<Record<string, any>> };
    const liquid = view.providers.find((provider) => provider.id === "liquid")!;
    assert.deepEqual(
      { balance: liquid.balanceUsd, used: liquid.usedUsd, left: liquid.leftUsd, week: liquid.userWeekUsd, free: liquid.freeWeekUsd, weekly: liquid.weeklyBudgetUsd, status: liquid.status },
      { balance: 100, used: 1.5, left: 98.5, week: 1.5, free: 1.5, weekly: 25, status: "on" },
    );
    assert.deepEqual(
      view.providers.map((provider) => provider.id),
      ["openai", "luminal", "liquid"],
    );
  });
});
