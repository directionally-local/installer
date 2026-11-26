import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { ADMIN_ID, createInvite, createService, luminalUsage, MODEL, openaiResponse, openRelayCompletion, openRelayUsage, responsesUsage, type Service } from "./harness.js";
import { modelById } from "../src/models.js";
import { PLAN_CACHED_SHARE } from "../src/plans.js";
import { chargedTokens, costAtPrices, costAtPricesOrFallback, DEEPSEEK_MAX_OUTPUT_TOKENS, estimatedUsage, FALLBACK_USD_PER_MILLION_TOKENS, realisticPromptTokens, streamedOutputTokens, type Usage } from "../src/quota.js";

/**
 * Requests that end without the provider reporting usage: a client that hangs up, an upstream
 * that fails, a stream cut off part way. Before, each was charged its whole reservation (the
 * prompt at ~2 bytes a token, uncached, plus up to 65,536 tokens of output room) at $1 per
 * million tokens: about 100 times a normal DeepSeek agent request. Now: nothing when no output
 * was streamed; otherwise a realistic prompt at the person's cached share plus the output that
 * was streamed, at the model's own prices.
 */

const DEEPSEEK = modelById(MODEL)!;
const WEIGHT = 0.02; // the default cachedTokenWeight
let ips = 0;
const ip = () => `10.12.${Math.floor(++ips / 250) % 250}.${ips % 250}`;

async function member(vars: Record<string, string> = {}): Promise<{ service: Service; token: string; admin: string }> {
  const service = await createService({ LUMINAL_API_KEY: "lum-test", ...vars });
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const token = (await service.signIn({ id: 100, login: "alice" }, { invite: await createInvite(service, admin) })).access_token;
  return { service, token, admin };
}

/** A DeepSeek agent turn's request: about 400 KB of context (some 100k tokens). */
function agentBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { model: MODEL, messages: [{ role: "user", content: "x".repeat(400_000) }], stream: true, ...extra };
}
const bytesOf = (body: Record<string, unknown>) => new TextEncoder().encode(JSON.stringify(body)).length;
const chat = (service: Service, token: string, body: Record<string, unknown>) => service.request("POST", "/v1/chat/completions", { token, ip: ip(), body });

async function week(service: Service, token: string): Promise<{ tokens: number; usd: number }> {
  const body = (await (await service.request("GET", "/v1/me", { token })).json()) as { pools: Record<string, { usedThisWeek: number }>; budgets: Record<string, { spentUsd: number }> };
  return { tokens: body.pools.deepseek!.usedThisWeek, usd: body.budgets.deepseek!.spentUsd };
}

function db(service: Service): DatabaseSync {
  service.directory();
  return (service.namespaces.DIRECTORY!.instances.get("directory")!.state as unknown as { db: DatabaseSync }).db;
}
const lastRow = (service: Service) =>
  db(service).prepare("SELECT model, upstream, status, prompt_tokens, completion_tokens, cached_tokens, charged_tokens, cost_usd, credit_usd FROM requests ORDER BY id DESC LIMIT 1").get() as Record<string, any>;
const allRows = (service: Service) => db(service).prepare("SELECT model, upstream, status, charged_tokens, cost_usd, credit_usd FROM requests ORDER BY id").all() as Array<Record<string, any>>;

const chunk = (content: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;

/** An upstream stream: `parts` handed out one per read, then `end`: "error" (a reset), "hang" (never ends) or "done". */
function upstream(parts: string[], end: "error" | "hang" | "done"): Response {
  const encoder = new TextEncoder();
  const left = [...parts];
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = left.shift();
        if (next !== undefined) return controller.enqueue(encoder.encode(next));
        if (end === "error") return controller.error(new Error("connection reset"));
        if (end === "done") {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          return controller.close();
        }
        return new Promise<void>(() => {}); // the upstream goes quiet
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

/** One finished request with usage, at a 96% cached share (what agent traffic shows), so the person's share is known. */
async function prime(service: Service, token: string): Promise<void> {
  service.setLuminal(() => Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "ok" } }], usage: luminalUsage(100_000, 1_000, 96_000) }));
  const response = await chat(service, token, agentBody({ stream: false }));
  assert.equal(response.status, 200);
  await response.text();
}

/** What the old code charged without usage: the whole reservation at $1/M. */
function before(body: Record<string, unknown>): { tokens: number; usd: number } {
  const tokens = Math.ceil(bytesOf(body) / 2) + DEEPSEEK_MAX_OUTPUT_TOKENS;
  return { tokens, usd: (tokens * FALLBACK_USD_PER_MILLION_TOKENS) / 1_000_000 };
}

describe("requests that end without usage", () => {
  it("charges nothing when the client cancels before any output", async () => {
    const { service, token } = await member();
    await prime(service, token);
    const start = await week(service, token);
    // The upstream sends its role chunk (no content) and then thinks; the client gives up.
    service.setLuminal(() => upstream([`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] })}\n\n`], "hang"));
    const response = await chat(service, token, agentBody());
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    const after = await week(service, token);
    assert.deepEqual([after.tokens - start.tokens, after.usd - start.usd], [0, 0], `before the fix: ${JSON.stringify(before(agentBody()))}`);
    const row = lastRow(service);
    assert.deepEqual([row.status, row.charged_tokens, row.cost_usd], ["no_usage", 0, 0]);
    // The upstream read the prompt: the credit records a realistic estimate of it, at Luminal's prices.
    const prompt = realisticPromptTokens(Math.ceil(bytesOf(agentBody()) / 2));
    const expected = costAtPrices({ promptTokens: prompt, cachedTokens: Math.floor(prompt * 0.96), completionTokens: 0, costUsd: undefined }, DEEPSEEK.creditPrices!);
    assert.ok(Math.abs(row.credit_usd - expected) < 1e-9, `credit ${row.credit_usd} vs ${expected}`);
  });

  it("charges nothing when the upstream fails before any output", async () => {
    const { service, token } = await member();
    await prime(service, token);
    const start = await week(service, token);
    service.setLuminal(() => upstream([], "error"));
    const response = await chat(service, token, agentBody());
    await assert.rejects(response.text());
    // An error object in the stream instead of content: the same.
    service.setLuminal(() => upstream([`data: ${JSON.stringify({ error: { message: "overloaded" } })}\n\n`], "done"));
    await (await chat(service, token, agentBody())).text();
    const after = await week(service, token);
    assert.deepEqual([after.tokens - start.tokens, after.usd - start.usd], [0, 0]);
    for (const row of allRows(service).slice(-2)) assert.deepEqual([row.status, row.charged_tokens, row.cost_usd, row.credit_usd], ["no_usage", 0, 0, 0]);
  });

  it("charges nothing for a non-streamed answer that is an error without usage", async () => {
    const { service, token } = await member();
    service.setLuminal(() => Response.json({ error: { message: "upstream exploded" } }));
    await (await chat(service, token, agentBody({ stream: false }))).text();
    assert.deepEqual(await week(service, token), { tokens: 0, usd: 0 });
  });

  it("charges a stream cut off part way a realistic prompt at the person's cached share, plus the output streamed, at DeepSeek's prices", async () => {
    const { service, token } = await member();
    await prime(service, token);
    const start = await week(service, token);
    // 200 chunks of 6 characters, then the connection resets: about 400 output tokens.
    service.setLuminal(() => upstream(Array.from({ length: 200 }, () => chunk("abcdef")), "error"));
    const response = await chat(service, token, agentBody());
    await assert.rejects(response.text());
    const after = await week(service, token);

    const promptTokens = realisticPromptTokens(Math.ceil(bytesOf(agentBody()) / 2));
    const usage: Usage = { promptTokens, cachedTokens: Math.floor(promptTokens * 0.96), completionTokens: streamedOutputTokens(1200, 200), costUsd: undefined };
    assert.equal(usage.completionTokens, 400);
    assert.equal(after.tokens - start.tokens, chargedTokens(usage, WEIGHT));
    assert.ok(Math.abs(after.usd - start.usd - costAtPrices(usage, DEEPSEEK.prices)) < 1e-6);
    // Before: ~265k tokens and ~$0.27; now ~4.5k tokens and ~$0.0003 (a normal turn's cost).
    const old = before(agentBody());
    assert.ok(old.usd / (after.usd - start.usd) > 100, `before $${old.usd}, now $${after.usd - start.usd}`);
    const row = lastRow(service);
    assert.deepEqual([row.status, row.prompt_tokens, row.completion_tokens, row.cached_tokens], ["no_usage", usage.promptTokens, 400, usage.cachedTokens]);
    assert.ok(Math.abs(row.credit_usd - costAtPrices(usage, DEEPSEEK.creditPrices!)) < 1e-9, "the credit records the same estimate at Luminal's prices");
  });

  it("charges the output a client read before hanging up, so aborting late doesn't dodge the charge", async () => {
    const { service, token } = await member();
    await prime(service, token);
    const start = await week(service, token);
    // 3,000 characters of output in one read, then the upstream keeps going; the client aborts.
    service.setLuminal(() => upstream([Array.from({ length: 500 }, () => chunk("abcdef")).join("")], "hang"));
    const response = await chat(service, token, agentBody());
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    const after = await week(service, token);
    const row = lastRow(service);
    assert.equal(row.completion_tokens, 1000, "3,000 characters ≈ 1,000 tokens");
    assert.ok(after.tokens - start.tokens >= 1000);
    assert.ok(after.usd - start.usd >= (1000 * DEEPSEEK.prices.output) / 1_000_000);
  });

  it("uses the plan mix's cached share when the person's own isn't known yet, not an uncached prompt", async () => {
    const { service, token } = await member();
    service.setLuminal(() => upstream([chunk("abc")], "error"));
    await assert.rejects((await chat(service, token, agentBody())).text());
    const promptTokens = realisticPromptTokens(Math.ceil(bytesOf(agentBody()) / 2));
    const usage: Usage = { promptTokens, cachedTokens: Math.floor(promptTokens * PLAN_CACHED_SHARE), completionTokens: 1, costUsd: undefined };
    const after = await week(service, token);
    assert.equal(after.tokens, chargedTokens(usage, WEIGHT));
    assert.ok(Math.abs(after.usd - costAtPrices(usage, DEEPSEEK.prices)) < 1e-6, "DeepSeek's own prices, never the $1/M fallback");
    // A new account's cut-off ~100k-token agent turn: before, ~100k counted (all fresh); now ~4%+ of that.
    const uncached = chargedTokens({ ...usage, cachedTokens: 0 }, WEIGHT);
    assert.ok(uncached / after.tokens > 15, `uncached ${uncached}, now ${after.tokens}`);
    const row = lastRow(service);
    assert.equal(row.cached_tokens, usage.cachedTokens);
  });

  it("charges the abandoned reservation the alarm sweeps nothing", async () => {
    const { service, token } = await member();
    await prime(service, token);
    const start = await week(service, token);
    service.setLuminal(() => new Promise<Response>(() => {}));
    void chat(service, token, agentBody());
    await new Promise((resolve) => setTimeout(resolve, 50));
    service.clock.now += 31 * 60_000;
    assert.equal(await service.account(100).sweep(service.clock.now), 1);
    const after = await week(service, token);
    assert.deepEqual([after.tokens - start.tokens, after.usd - start.usd], [0, 0]);
    const row = lastRow(service);
    assert.deepEqual([row.status, row.charged_tokens], ["abandoned", 0]);
    assert.ok(row.credit_usd > 0, "the provider most likely read the prompt: the credit records an estimate");
  });
});

describe("a failed attempt and then a backup", () => {
  it("charges only the backup that answered: GPT-6 Luna failing over to DeepSeek", async () => {
    const { service, token } = await member({ OPENAI_API_KEY: "sk-openai-test" });
    service.setOpenAI(() => Response.json({ error: { message: "overloaded" } }, { status: 500 }));
    service.setLuminal(() => Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "ok" } }], usage: luminalUsage(10_000, 200, 8_000) }));
    const response = await chat(service, token, { model: "gpt-6-luna", messages: [{ role: "user", content: "hello" }] });
    assert.equal(response.status, 200);
    await response.text();
    const me = (await (await service.request("GET", "/v1/me", { token })).json()) as { pools: Record<string, { usedThisWeek: number }> };
    // The requested model's budget pays for its fallback; either way, the backup's usage is charged once.
    const usage: Usage = { promptTokens: 10_000, cachedTokens: 8_000, completionTokens: 200, costUsd: undefined };
    assert.equal(me.pools.luna!.usedThisWeek + me.pools.deepseek!.usedThisWeek, chargedTokens(usage, WEIGHT), "the failed attempt adds nothing");
    const [failed, served] = allRows(service);
    assert.deepEqual([failed!.status, failed!.charged_tokens, failed!.cost_usd, failed!.credit_usd], ["upstream_error", 0, 0, 0]);
    assert.equal(served!.status, "ok");
  });

  it("charges only the backup that answered: GLM 5.3 Flash on Liquid failing over to Open Relay", async () => {
    const { service, token } = await member({ OPEN_ADMISSION: "true", LIQUID_INFERENCE_API_KEY: "sk-liquid", LIQUID_STATUS: "on", OPENRELAY_API_KEY: "or_test", OPENRELAY_STATUS: "on" });
    service.setLiquid(() => Response.json({ error: { message: "busy" } }, { status: 503 }));
    service.setOpenRelay(() => openRelayCompletion(openRelayUsage(5_000, 100)));
    const response = await chat(service, token, { model: "z-ai/glm-5.3-flash", messages: [{ role: "user", content: "hello" }] });
    assert.equal(response.status, 200);
    await response.text();
    const [failed, served] = allRows(service);
    assert.deepEqual([failed!.upstream, failed!.charged_tokens, failed!.cost_usd, failed!.credit_usd], ["liquid", 0, 0, 0]);
    assert.deepEqual([served!.upstream, served!.status], ["openrelay", "ok"]);
    assert.equal(served!.charged_tokens, 5_100);
  });
});

describe("the no-usage estimate", () => {
  it("is nothing without output, and the model's prices with it; $1/M only for a model with none", () => {
    assert.equal(estimatedUsage(200_000, 0, 0.96), undefined);
    const usage = estimatedUsage(200_000, 500, 0.96)!;
    assert.deepEqual(usage, { promptTokens: 100_000, cachedTokens: 96_000, completionTokens: 500, costUsd: undefined });
    assert.equal(costAtPricesOrFallback(usage, DEEPSEEK.prices), costAtPrices(usage, DEEPSEEK.prices));
    assert.equal(costAtPricesOrFallback(usage, undefined), (100_500 * FALLBACK_USD_PER_MILLION_TOKENS) / 1_000_000);
    assert.equal(streamedOutputTokens(0, 0), 0);
    assert.equal(streamedOutputTokens(30, 50), 50, "a chunk is about a token");
    assert.equal(streamedOutputTokens(3000, 10), 1000, "or the characters, when they say more");
  });

  it("is counted per day in the admin metrics", async () => {
    const { service, token, admin } = await member();
    await prime(service, token);
    service.setLuminal(() => upstream([chunk("abcdef")], "error"));
    await assert.rejects((await chat(service, token, agentBody())).text());
    service.setLuminal(() => upstream([], "error"));
    await assert.rejects((await chat(service, token, agentBody())).text());
    const metrics = (await (await service.request("GET", "/admin/metrics", { token: admin })).json()) as { daily: Array<Record<string, number>> };
    const today = metrics.daily.at(-1)!;
    assert.equal(today.noUsageRequests, 2);
    assert.equal(today.noUsagePeople, 1);
    assert.ok(today.noUsageChargedTokens! > 0 && today.noUsageChargedTokens! < 10_000);
    assert.ok(today.noUsageCostUsd! > 0 && today.noUsageCostUsd! < 0.01);
  });
});
