import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ADMIN_ID, completion, createService, errorCode, luminalUsage, MODEL, NOW, openaiUsage, usage, type Service } from "./harness.js";

/**
 * OpenAI as the default provider: GPT-6 Luna first, DeepSeek on Luminal as the automatic
 * fallback, and one weekly token pool per model tier.
 */

const LUNA = "gpt-6-luna";
const SOL = "gpt-6.1-sol";
const ASTRA = "gpt-6-astra";
const DEEPSEEK = MODEL;

const OPENAI = { OPENAI_API_KEY: "sk-openai-test" };
const BOTH = { OPENAI_API_KEY: "sk-openai-test", LUMINAL_API_KEY: "lum-test" };

async function member(vars: Record<string, string> = {}): Promise<{ service: Service; token: string; adminToken: string }> {
  const service = await createService({ OPEN_ADMISSION: "true", ...vars });
  const adminToken = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const token = (await service.signIn({ id: 100, login: "alice" })).access_token;
  return { service, token, adminToken };
}

const chat = (service: Service, token: string, body: Record<string, unknown> = {}) =>
  service.request("POST", "/v1/chat/completions", { token, body: { model: LUNA, messages: [{ role: "user", content: "hello" }], ...body } });

const me = async (service: Service, token: string) =>
  (await (await service.request("GET", "/v1/me", { token })).json()) as {
    allowance: { tokensPerWeek: number; remaining: number };
    pools: Record<string, { tokensPerWeek: number; usedThisWeek: number; remaining: number; models: string[] }>;
  };

describe("OpenAI as the default provider", () => {
  it("serves GPT-6 Luna on OpenAI, with max_completion_tokens and no OpenRouter fields", async () => {
    const { service, token } = await member(OPENAI);
    const response = await chat(service, token);
    assert.equal(response.status, 200);
    assert.equal(service.calls.openai.length, 1);
    assert.equal(service.calls.luminal.length, 0);
    const sent = service.calls.openai[0]!.body;
    assert.equal(sent.model, "gpt-6-luna");
    assert.equal(sent.max_completion_tokens, 32_768);
    assert.equal(sent.max_tokens, undefined);
    assert.equal(sent.provider, undefined);
    assert.equal(sent.usage, undefined);
    assert.equal(service.calls.openai[0]!.headers.authorization, "Bearer sk-openai-test");
  });

  it("prices the request at OpenAI's list prices and charges the OpenAI credit", async () => {
    const { service, token, adminToken } = await member(OPENAI);
    service.setOpenAI(() => completion(openaiUsage(1_000_000, 1_000_000, 0)));
    assert.equal((await chat(service, token)).status, 200);
    const spend = (await (await service.request("GET", "/admin/spend", { token: adminToken })).json()) as {
      openaiCredit: { usedUsd: number; balanceUsd: number; leftUsd: number };
      luminalCredit: { usedUsd: number };
    };
    // Luna: $0.10 input + $0.50 output per million.
    assert.equal(spend.openaiCredit.usedUsd, 0.6);
    assert.equal(spend.openaiCredit.balanceUsd, 5000);
    assert.equal(spend.openaiCredit.leftUsd, 4999.4);
    assert.equal(spend.luminalCredit.usedUsd, 0);
  });

  it("falls back to DeepSeek on Luminal when OpenAI fails, and says so", async () => {
    const { service, token } = await member(BOTH);
    service.setOpenAI(() => new Response("upstream exploded", { status: 503 }));
    const response = await chat(service, token);
    assert.equal(response.status, 200);
    assert.equal(service.calls.openai.length, 1);
    assert.equal(service.calls.luminal.length, 1);
    assert.equal(service.calls.luminal[0]!.body.model, "deepseek-ai/DeepSeek-V4.1-Flash-1017");
    assert.equal(response.headers.get("x-dl-fallback"), DEEPSEEK);
  });

  it("falls back on a 429 and on a network error too", async () => {
    for (const failure of [() => new Response("busy", { status: 429 }), () => { throw new TypeError("fetch failed"); }]) {
      const { service, token } = await member(BOTH);
      service.setOpenAI(failure as never);
      const response = await chat(service, token);
      assert.equal(response.status, 200);
      assert.equal(service.calls.luminal.length, 1);
      assert.equal(response.headers.get("x-dl-fallback"), DEEPSEEK);
    }
  });

  it("falls back when OpenAI's credit is used up", async () => {
    const { service, token } = await member({ ...BOTH, OPENAI_CREDIT_USD: "0" });
    const response = await chat(service, token);
    assert.equal(response.status, 200);
    assert.equal(service.calls.openai.length, 0, "OpenAI isn't called at all");
    assert.equal(service.calls.luminal.length, 1);
    assert.equal(response.headers.get("x-dl-fallback"), DEEPSEEK);
  });

  it("falls back for Sol and Astra too, and charges their own pool", async () => {
    const { service, token } = await member(BOTH);
    service.setOpenAI(() => new Response("down", { status: 503 }));
    service.setLuminal(() => completion(luminalUsage(1000, 1000, 0)));
    const response = await chat(service, token, { model: SOL });
    assert.equal(response.status, 200);
    assert.equal(service.calls.luminal.length, 1);
    assert.equal(response.headers.get("x-dl-fallback"), DEEPSEEK);
    // The person asked for Sol, so Sol's pool paid, not Luna's.
    const body = await me(service, token);
    assert.equal(body.pools.sol!.usedThisWeek, 2000);
    assert.equal(body.pools.luna!.usedThisWeek, 0);
  });

  it("serves DeepSeek on Luminal when it is picked by hand", async () => {
    const { service, token } = await member(BOTH);
    const response = await chat(service, token, { model: DEEPSEEK });
    assert.equal(response.status, 200);
    assert.equal(service.calls.openai.length, 0);
    assert.equal(service.calls.luminal.length, 1);
    assert.equal(response.headers.get("x-dl-fallback"), null);
  });
});

describe("weekly pools", () => {
  it("gives Luna and DeepSeek one 50M pool, Sol 10M and Astra 3M", async () => {
    const { service, token } = await member(OPENAI);
    const body = await me(service, token);
    assert.equal(body.pools.luna!.tokensPerWeek, 50_000_000);
    assert.equal(body.pools.sol!.tokensPerWeek, 10_000_000);
    assert.equal(body.pools.astra!.tokensPerWeek, 3_000_000);
    assert.deepEqual(body.pools.luna!.models, [LUNA, DEEPSEEK]);
    assert.deepEqual(body.pools.sol!.models, [SOL]);
    assert.deepEqual(body.pools.astra!.models, [ASTRA]);
    // The default allowance reads as the Luna pool.
    assert.equal(body.allowance.tokensPerWeek, 50_000_000);
  });

  it("charges the pool of the model that served, not a second allowance", async () => {
    const { service, token } = await member(OPENAI);
    service.setOpenAI(() => completion(openaiUsage(1000, 1000, 0)));
    assert.equal((await chat(service, token, { model: SOL })).status, 200);
    let body = await me(service, token);
    assert.equal(body.pools.sol!.usedThisWeek, 2000);
    assert.equal(body.pools.luna!.usedThisWeek, 0);

    // Luna and DeepSeek share the Luna pool.
    assert.equal((await chat(service, token, { model: LUNA })).status, 200);
    body = await me(service, token);
    assert.equal(body.pools.luna!.usedThisWeek, 2000);
    assert.equal(body.pools.sol!.usedThisWeek, 2000);
  });

  it("refuses Sol once its own 10M pool is used, while Luna still works", async () => {
    const { service, token, adminToken } = await member(OPENAI);
    await service.request("POST", "/admin/people/100/grant", { token: adminToken, body: { usedThisWeek: 50_000_000 } });
    // The grant sets the Luna pool; Sol keeps its own.
    assert.equal((await chat(service, token, { model: SOL })).status, 200);
    const refused = await chat(service, token, { model: LUNA });
    assert.equal(refused.status, 402);
    assert.equal(await errorCode(refused), "quota_exceeded");
  });
});

describe("status and models", () => {
  it("lists every free model with its provider", async () => {
    const { service, token } = await member(OPENAI);
    const body = (await (await service.request("GET", "/v1/models", { token })).json()) as { data: Array<{ id: string; owned_by: string }> };
    assert.deepEqual(body.data.map((model) => [model.id, model.owned_by]), [
      [LUNA, "openai"],
      [SOL, "openai"],
      [ASTRA, "openai"],
      [DEEPSEEK, "luminal"],
    ]);
  });

  it("says which models can serve now, without amounts", async () => {
    const openai = await createService({ ...OPENAI, OPENROUTER_API_KEY: "" });
    const body = (await (await openai.request("GET", "/v1/status")).json()) as { models: Array<{ id: string; available: boolean }> };
    assert.deepEqual(body.models, [
      { id: LUNA, available: true },
      { id: SOL, available: true },
      { id: ASTRA, available: true },
      { id: DEEPSEEK, available: false },
    ]);

    // OpenAI out of credit: every OpenAI model still serves through DeepSeek.
    const spent = await createService({ ...BOTH, OPENAI_CREDIT_USD: "0", OPENROUTER_API_KEY: "" });
    const after = (await (await spent.request("GET", "/v1/status")).json()) as { models: Array<{ id: string; available: boolean }> };
    assert.deepEqual(after.models, [
      { id: LUNA, available: true },
      { id: SOL, available: true },
      { id: ASTRA, available: true },
      { id: DEEPSEEK, available: true },
    ]);
  });
});
