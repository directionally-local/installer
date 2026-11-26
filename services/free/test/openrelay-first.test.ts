import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { ADMIN_ID, createService, liquidCompletion, luminalUsage, MODEL, type Service } from "./harness.js";
import { readFreeConfig } from "../src/config.js";
import { creditPrices, isFirstChoice, modelById, onUpstream, upstreamsOf } from "../src/models.js";
import { contextTooLong, firstChoiceUpstreams, isRegistryModelList, providerSettings, registryRoute } from "../src/providers.js";

/**
 * Open Relay as the first-choice upstream of DeepSeek V4.1 Flash and Kimi K3.1 Pro (models.ts
 * `firstChoice`): off until `providerModels.openrelay` lists them and Open Relay is on; then it
 * serves first, and the model's usual upstream (DeepSeek: Luminal; Kimi: Liquid) serves on a
 * failure before anything reaches the client (429, 5xx, a timeout, a prompt longer than Open
 * Relay takes) or once Open Relay's budget is used. GLM 5.3 Flash stays off unless listed.
 */

const KIMI = "moonshotai/kimi-k3.1-pro";
const GLM_FLASH = "z-ai/glm-5.3-flash";
const KEY = "or_test_secret";
const BASE_ENV = { OPENROUTER_API_KEY: "k", GITHUB_CLIENT_ID: "c", GITHUB_CLIENT_SECRET: "s", TOKEN_SIGNING_KEY: "x".repeat(32) };
/** Open Relay on for DeepSeek and Kimi only (GLM 5.3 Flash off), as the owner would switch it on. */
const FIRST = { OPENRELAY_API_KEY: KEY, OPENRELAY_STATUS: "on", OPENRELAY_MODELS: `${MODEL},${KIMI}` };
const LIQUID = { LIQUID_INFERENCE_API_KEY: "sk-architect-test-secret", LIQUID_STATUS: "on" };

let ips = 0;
const ip = () => `10.13.${Math.floor(++ips / 250) % 250}.${ips % 250}`;

async function member(vars: Record<string, string> = {}): Promise<{ service: Service; token: string; admin: string }> {
  const service = await createService({ OPEN_ADMISSION: "true", OPENAI_API_KEY: "sk-openai-test", LUMINAL_API_KEY: "lum-test", ...vars });
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const token = (await service.signIn({ id: 100, login: "alice" })).access_token;
  return { service, token, admin };
}

const chat = (service: Service, token: string, model: string, body: Record<string, unknown> = {}) =>
  service.request("POST", "/v1/chat/completions", { token, ip: ip(), body: { model, messages: [{ role: "user", content: "hello" }], ...body } });

function db(service: Service): DatabaseSync {
  service.directory();
  return (service.namespaces.DIRECTORY!.instances.get("directory")!.state as unknown as { db: DatabaseSync }).db;
}

function rows(service: Service): Array<Record<string, any>> {
  return db(service).prepare("SELECT model, upstream, status, credit_usd, cost_usd, cached_tokens FROM requests ORDER BY id").all() as Array<Record<string, any>>;
}

/** Chat-completions usage with cached prompt tokens, as Open Relay reports it. */
function cachedUsage(prompt: number, cached: number, completion: number): Record<string, unknown> {
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, prompt_tokens_details: { cached_tokens: cached } };
}

function answer(usage: Record<string, unknown>, costNanoUsd?: number): Response {
  return Response.json({
    id: "or_1",
    object: "chat.completion",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi" } }],
    usage,
    ...(costNanoUsd !== undefined ? { openrelay: { cost_nano_usd: costNanoUsd, priced_at: "online" } } : {}),
  });
}

describe("Open Relay first: settings", () => {
  it("is tried before DeepSeek's and Kimi's own upstreams, at its own prices", () => {
    const deepseek = modelById(MODEL)!;
    const kimi = modelById(KIMI)!;
    assert.deepEqual(upstreamsOf(deepseek).map((upstream) => [upstream.provider, upstream.upstreamModel]), [["openrelay", "openrelay/deepseek-v4.1-flash"], ["luminal", "deepseek-ai/DeepSeek-V4.1-Flash-1017"]]);
    assert.deepEqual(upstreamsOf(kimi).map((upstream) => [upstream.provider, upstream.upstreamModel]), [["openrelay", "openrelay/kimi-k3.1-pro"], ["liquid", "kimi-k3.1-pro"]]);
    assert.deepEqual(creditPrices(onUpstream(deepseek, "openrelay")), { input: 0.035, cached: 0.01, output: 0.33 });
    assert.deepEqual(creditPrices(onUpstream(kimi, "openrelay")), { input: 0.24, cached: 0.2, output: 7 });
    // On Open Relay, Kimi carries no exchange rules; the person's allowance prices stay the model's.
    assert.equal(onUpstream(kimi, "openrelay").exchange, undefined);
    assert.deepEqual(onUpstream(deepseek, "openrelay").prices, deepseek.prices);
    assert.ok(isFirstChoice(deepseek, "openrelay") && !isFirstChoice(deepseek, "luminal"));
  });

  it("is off by default: Open Relay's default models leave them out, and GLM 5.3 Flash stays off when only they are listed", () => {
    const defaults = readFreeConfig({ ...BASE_ENV, OPENRELAY_API_KEY: KEY, OPENRELAY_STATUS: "on" });
    assert.deepEqual(providerSettings(defaults, "openrelay").models, [GLM_FLASH]);
    assert.deepEqual(firstChoiceUpstreams(defaults, modelById(MODEL)!, { usedUsd: {}, weekUsd: {} }), []);
    const on = readFreeConfig({ ...BASE_ENV, ...FIRST });
    assert.deepEqual(providerSettings(on, "openrelay").models, [MODEL, KIMI]);
    assert.deepEqual(firstChoiceUpstreams(on, modelById(MODEL)!, { usedUsd: {}, weekUsd: {} }), ["openrelay"]);
    assert.deepEqual(registryRoute(on, modelById(GLM_FLASH)!, { usedUsd: {}, weekUsd: {} }).upstreams, []);
    assert.ok(isRegistryModelList([MODEL, KIMI]));
    assert.ok(!isRegistryModelList(["gpt-6-luna"]));
  });

  it("leaves Open Relay out once its credit, its week or a model's share of it is used", () => {
    const config = readFreeConfig({ ...BASE_ENV, ...FIRST, OPENRELAY_WEEKLY_CREDIT_DEEPSEEK_V4_1_FLASH: "3" });
    assert.equal(config["modelWeeklyCredit.openrelay.deepseek-v4.1-flash-1017"], 3);
    const deepseek = modelById(MODEL)!;
    assert.deepEqual(firstChoiceUpstreams(config, deepseek, { usedUsd: { openrelay: 200 }, weekUsd: {} }), []);
    assert.deepEqual(firstChoiceUpstreams(config, deepseek, { usedUsd: {}, weekUsd: { openrelay: 25 } }), []);
    assert.deepEqual(firstChoiceUpstreams(config, deepseek, { usedUsd: {}, weekUsd: {}, modelWeekUsd: { [`openrelay:${MODEL}`]: 3 } }), []);
    // Kimi: Liquid serves alone, and the block named is Liquid's own.
    const kimi = modelById(KIMI)!;
    const liquid = readFreeConfig({ ...BASE_ENV, ...FIRST, ...LIQUID });
    assert.deepEqual(registryRoute(liquid, kimi, { usedUsd: {}, weekUsd: { openrelay: 25 } }).upstreams, ["liquid"]);
    assert.deepEqual(registryRoute(liquid, kimi, { usedUsd: {}, weekUsd: {} }).upstreams, ["openrelay", "liquid"]);
  });

  it("knows Open Relay's context error", () => {
    assert.ok(contextTooLong(JSON.stringify({ error: { message: "too long", type: "invalid_request_error", code: "context_length_exceeded" } })));
    assert.ok(!contextTooLong(JSON.stringify({ error: { code: "invalid_request_error" } })));
    assert.ok(!contextTooLong("not json"));
  });

  it("is switched on through /admin/config", async () => {
    const { service, token, admin } = await member({ OPENRELAY_API_KEY: KEY });
    assert.equal((await chat(service, token, MODEL)).status, 200);
    assert.equal(service.calls.openrelay.length, 0);
    const set = await service.request("POST", "/admin/config", { token: admin, body: { "providerStatus.openrelay": "on", "providerModels.openrelay": [MODEL, KIMI] } });
    assert.equal(set.status, 200, await set.clone().text());
    assert.equal((await chat(service, token, MODEL)).status, 200);
    assert.equal(service.calls.openrelay.length, 1);
    assert.equal(service.calls.luminal.length, 1);
  });
});

describe("Open Relay first: DeepSeek", () => {
  it("serves on Luminal while Open Relay doesn't list it", async () => {
    const { service, token } = await member({ OPENRELAY_API_KEY: KEY, OPENRELAY_STATUS: "on" });
    assert.equal((await chat(service, token, MODEL)).status, 200);
    assert.equal(service.calls.openrelay.length, 0);
    assert.deepEqual(rows(service).map((row) => row.upstream), ["luminal"]);
  });

  it("serves on Open Relay first: its wire id, its reported cost on its credit, the person charged DeepSeek's prices", async () => {
    const { service, token } = await member(FIRST);
    service.setOpenRelay(() => answer(cachedUsage(10_000, 8_000, 100), 135_000));
    const response = await chat(service, token, MODEL);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-dl-fallback"), null);
    assert.equal(service.calls.luminal.length, 0);
    assert.equal(service.calls.openrelay[0]!.body.model, "openrelay/deepseek-v4.1-flash");
    const [row] = rows(service);
    assert.deepEqual({ model: row!.model, upstream: row!.upstream, status: row!.status, cached: row!.cached_tokens, credit: row!.credit_usd }, { model: MODEL, upstream: "openrelay", status: "ok", cached: 8_000, credit: 0.000135 });
    // DeepSeek's allowance prices: 2,000 fresh, 8,000 cached, 100 out.
    assert.ok(Math.abs(row!.cost_usd - (2_000 * 0.035 + 8_000 * 0.006 + 100 * 0.315) / 1e6) < 1e-12);
  });

  it("charges the credit Open Relay's prices, cached tokens at the cached price, when it reports no cost", async () => {
    const { service, token } = await member(FIRST);
    service.setOpenRelay(() => answer(cachedUsage(1_000_000, 800_000, 100_000)));
    assert.equal((await chat(service, token, MODEL)).status, 200);
    assert.ok(Math.abs(rows(service)[0]!.credit_usd - (200_000 * 0.035 + 800_000 * 0.01 + 100_000 * 0.33) / 1e6) < 1e-9);
  });

  it("on 429, 502, 503 and a too-long prompt, Luminal serves the same model before anything reaches the client", async () => {
    const { service, token } = await member(FIRST);
    const failures = [
      () => Response.json({ error: { type: "rate_limit_error" } }, { status: 429 }),
      () => Response.json({ error: { type: "api_error" } }, { status: 502 }),
      () => Response.json({ error: { type: "api_error" } }, { status: 503 }),
      () => Response.json({ error: { message: "prompt too long", type: "invalid_request_error", code: "context_length_exceeded" } }, { status: 400 }),
    ];
    for (const failure of failures) {
      service.setOpenRelay(failure);
      const response = await chat(service, token, MODEL);
      assert.equal(response.status, 200);
      // The same model answered: no fallback header.
      assert.equal(response.headers.get("x-dl-fallback"), null);
    }
    assert.equal(service.calls.luminal.length, 4);
    assert.deepEqual(rows(service).map((row) => [row.model, row.upstream, row.status, row.credit_usd > 0]), [
      [MODEL, "openrelay", "upstream_busy", false],
      [MODEL, "luminal", "ok", true],
      [MODEL, "openrelay", "upstream_error", false],
      [MODEL, "luminal", "ok", true],
      [MODEL, "openrelay", "upstream_error", false],
      [MODEL, "luminal", "ok", true],
      [MODEL, "openrelay", "upstream_context", false],
      [MODEL, "luminal", "ok", true],
    ]);
  });

  it("on a timeout before the first byte, Luminal serves", async () => {
    const { service, token } = await member({ ...FIRST, OPENRELAY_FIRST_BYTE_TIMEOUT_SECONDS: "0.05" });
    service.setOpenRelay((_body, init) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    assert.equal((await chat(service, token, MODEL)).status, 200);
    assert.deepEqual(rows(service).map((row) => [row.upstream, row.status]), [["openrelay", "upstream_timeout"], ["luminal", "ok"]]);
  });

  it("an Open Relay balance refusal (402) goes on to Luminal", async () => {
    const { service, token } = await member(FIRST);
    service.setOpenRelay(() => Response.json({ error: { message: "insufficient balance; add funds to continue", type: "insufficient_quota", code: "insufficient_balance" } }, { status: 402 }));
    assert.equal((await chat(service, token, MODEL)).status, 200);
    assert.deepEqual(rows(service).map((row) => row.upstream), ["openrelay", "luminal"]);
  });

  it("past Open Relay's weekly budget, Luminal serves until Monday", async () => {
    const { service, token } = await member({ ...FIRST, OPENRELAY_WEEKLY_CREDIT_USD: "0.0001" });
    service.setOpenRelay(() => answer(cachedUsage(1_000, 0, 10), 150_000));
    assert.equal((await chat(service, token, MODEL)).status, 200);
    assert.equal((await chat(service, token, MODEL)).status, 200);
    assert.equal((await chat(service, token, MODEL)).status, 200);
    assert.deepEqual(rows(service).map((row) => row.upstream), ["openrelay", "luminal", "luminal"]);
  });

  it("with Luminal out of the way too, a failure on Open Relay goes back as transient", async () => {
    const { service, token } = await member({ ...FIRST, LUMINAL_API_KEY: "", OPENROUTER_API_KEY: "" });
    service.setOpenRelay(() => Response.json({ error: { type: "api_error" } }, { status: 503, headers: { "retry-after": "4" } }));
    const response = await chat(service, token, MODEL);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "4");
    // And with Open Relay fine, it serves DeepSeek although Luminal can't.
    service.setOpenRelay(() => answer(cachedUsage(100, 0, 10), 5_000));
    assert.equal((await chat(service, token, MODEL)).status, 200);
  });

  it("stays listed under Luminal on /v1/providers, with Open Relay beside it", async () => {
    const { service } = await member(FIRST);
    const pub = (await (await service.request("GET", "/v1/providers", { ip: ip() })).json()) as { providers: Array<Record<string, any>> };
    assert.ok(!(pub.providers.find((provider) => provider.id === "openrelay")?.models ?? []).some((model: Record<string, any>) => model.id === MODEL));
    const deepseek = pub.providers.find((provider) => provider.id === "luminal")!.models.find((model: Record<string, any>) => model.id === MODEL);
    assert.deepEqual(deepseek.backups.map((backup: Record<string, any>) => [backup.provider, backup.status]), [["openrelay", "on"]]);
  });
});

describe("Open Relay first: Kimi K3.1 Pro", () => {
  it("serves on Open Relay first in its shape, then Liquid on a failure", async () => {
    const { service, admin } = await member({ ...FIRST, ...LIQUID });
    service.setOpenRelay(() => answer(cachedUsage(5_000, 4_864, 16), 1_096_560));
    assert.equal((await chat(service, admin, KIMI)).status, 200);
    const sent = service.calls.openrelay[0]!.body;
    assert.equal(sent.model, "openrelay/kimi-k3.1-pro");
    assert.equal(sent.exchange, undefined);
    assert.equal(service.calls.liquid.length, 0);
    service.setOpenRelay(() => Response.json({ error: { type: "api_error" } }, { status: 503 }));
    service.setLiquid(() => liquidCompletion(luminalUsage(100, 10)));
    const response = await chat(service, admin, KIMI);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-dl-fallback"), null);
    assert.deepEqual(rows(service).map((row) => [row.model, row.upstream, row.status]), [
      [KIMI, "openrelay", "ok"],
      [KIMI, "openrelay", "upstream_error"],
      [KIMI, "liquid", "ok"],
    ]);
    assert.equal(rows(service)[0]!.credit_usd, 0.00109656);
  });

  it("keeps Kimi a dl Pro perk on Open Relay, and listed under Liquid", async () => {
    const { service, token } = await member({ ...FIRST, ...LIQUID });
    const refused = await chat(service, token, KIMI);
    assert.equal(refused.status, 402);
    assert.equal(((await refused.json()) as { error: { reason: string } }).error.reason, "pro_only");
    assert.equal(service.calls.openrelay.length, 0);
    const pub = (await (await service.request("GET", "/v1/providers", { ip: ip() })).json()) as { providers: Array<Record<string, any>> };
    assert.ok(pub.providers.find((provider) => provider.id === "liquid")!.models.some((model: Record<string, any>) => model.id === KIMI));
  });

  it("GLM 5.3 Flash stays off on Open Relay while only DeepSeek and Kimi are listed", async () => {
    const { service, token } = await member(FIRST);
    const response = await chat(service, token, GLM_FLASH);
    assert.notEqual(response.status, 200);
    assert.equal(service.calls.openrelay.length, 0);
  });
});

describe("Open Relay first: cache hit rate per upstream", () => {
  it("/admin/providers shows fresh, cached and output tokens, the hit rate and the credit per upstream and model", async () => {
    const { service, token, admin } = await member(FIRST);
    service.setOpenRelay(() => answer(cachedUsage(4_847, 0, 13), 173_935));
    assert.equal((await chat(service, token, MODEL)).status, 200);
    service.setOpenRelay(() => answer(cachedUsage(4_847, 4_608, 16), 59_725));
    assert.equal((await chat(service, token, MODEL)).status, 200);
    service.setOpenRelay(() => Response.json({ error: { type: "api_error" } }, { status: 503 }));
    service.setLuminal(() => answer(luminalUsage(1_000, 10, 500)));
    assert.equal((await chat(service, token, MODEL)).status, 200);
    const owner = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const view = (await (await service.request("GET", "/v1/admin/providers?days=7", { token: owner ?? admin })).json()) as { days: number; usage: Array<Record<string, any>>; providers: Array<Record<string, any>> };
    assert.equal(view.days, 7);
    const openrelay = view.usage.find((row) => row.upstream === "openrelay" && row.model === MODEL)!;
    assert.deepEqual(
      { requests: openrelay.requests, errors: openrelay.errors, fresh: openrelay.freshTokens, cached: openrelay.cachedTokens, output: openrelay.outputTokens, hit: openrelay.cacheHitRate, credit: openrelay.creditUsd },
      { requests: 3, errors: 1, fresh: 4_847 + 239, cached: 4_608, output: 29, hit: Math.round((4_608 / 9_694) * 10_000) / 10_000, credit: 0.000234 },
    );
    assert.deepEqual(openrelay.atPrices, { freshUsd: 0.000178, cachedUsd: 0.000046, outputUsd: 0.00001, cacheSavedUsd: 0.000115 });
    const luminal = view.usage.find((row) => row.upstream === "luminal" && row.model === MODEL)!;
    assert.deepEqual({ requests: luminal.requests, cached: luminal.cachedTokens, hit: luminal.cacheHitRate }, { requests: 1, cached: 500, hit: 0.5 });
    const models = view.providers.find((provider) => provider.id === "openrelay")!.models as Array<Record<string, any>>;
    assert.deepEqual(models.map((model) => [model.id, model.role, model.on]), [[MODEL, "first", true], [KIMI, "first", true], [GLM_FLASH, "backup", false]]);
    assert.equal((await service.request("GET", "/v1/admin/providers?days=61", { token: owner })).status, 400);
  });
});
