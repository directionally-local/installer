import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { newInviteCode, newUserCode, normalizeInviteCode, normalizeUserCode } from "../src/codes.js";
import { ConfigError, readFreeConfig } from "../src/config.js";
import { cleanBatch, cleanProps } from "../src/events.js";
import { chargedTokens, costOf, isAllowedModel, MAX_OUTPUT_TOKENS, parseUsage, planReservation } from "../src/quota.js";
import { meterStream, type StreamOutcome } from "../src/sse.js";
import { weekEnd, weekStart } from "../src/week.js";

const BASE_ENV = { OPENROUTER_API_KEY: "k", GITHUB_CLIENT_ID: "c", GITHUB_CLIENT_SECRET: "s", TOKEN_SIGNING_KEY: "x".repeat(32) };

describe("reservation planning", () => {
  it("reserves the prompt estimate plus the output cap", () => {
    assert.deepEqual(planReservation(1000, 500, 10_000), { amount: 1500, maxTokens: 500 });
    assert.deepEqual(planReservation(1000, undefined, 1_000_000), { amount: 1000 + MAX_OUTPUT_TOKENS, maxTokens: MAX_OUTPUT_TOKENS });
    assert.deepEqual(planReservation(1000, 10 ** 9, 1_000_000), { amount: 1000 + MAX_OUTPUT_TOKENS, maxTokens: MAX_OUTPUT_TOKENS });
  });

  it("clamps output to what is left, and refuses when not even a short answer fits", () => {
    assert.deepEqual(planReservation(1000, 5000, 2000), { amount: 2000, maxTokens: 1000 });
    assert.equal(planReservation(1000, 5000, 1100), undefined);
    assert.deepEqual(planReservation(1000, 50, 1050), { amount: 1050, maxTokens: 50 });
  });
});

describe("usage", () => {
  it("parses OpenRouter usage, cost and cached tokens", () => {
    assert.deepEqual(parseUsage({ prompt_tokens: 10, completion_tokens: 2, cost: 0.5, prompt_tokens_details: { cached_tokens: 4 } }), {
      promptTokens: 10,
      completionTokens: 2,
      cachedTokens: 4,
      costUsd: 0.5,
    });
    assert.equal(parseUsage({ completion_tokens: 2 }), undefined);
    assert.equal(parseUsage(null), undefined);
  });

  it("charges cached tokens at their weight, rounding up", () => {
    const usage = { promptTokens: 100, completionTokens: 5, cachedTokens: 90, costUsd: undefined };
    assert.equal(chargedTokens(usage, 1), 105);
    assert.equal(chargedTokens(usage, 0), 15);
    assert.equal(chargedTokens(usage, 0.02), 10 + 5 + 2, "90 × 0.02 = 1.8, rounded up");
    assert.equal(chargedTokens(usage, 0.5), 10 + 5 + 45);
    assert.equal(chargedTokens({ ...usage, cachedTokens: 0 }, 0.02), 105);
    assert.equal(chargedTokens(usage, 7), 105, "clamped to 1");
    assert.equal(costOf(usage, 0), 105 / 1_000_000);
  });

  it("allows only the dated model", () => {
    assert.equal(isAllowedModel("deepseek/deepseek-v4.1-flash-1017"), true);
    assert.equal(isAllowedModel("deepseek/deepseek-v4.1-flash"), false);
  });
});

describe("stream metering", () => {
  async function run(text: string, chunkSize = 5): Promise<{ out: string; outcome: StreamOutcome }> {
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < bytes.length; index += chunkSize) controller.enqueue(bytes.slice(index, index + chunkSize));
        controller.close();
      },
    });
    let outcome!: StreamOutcome;
    const out = await new Response(meterStream(body, async (result) => void (outcome = result))).text();
    return { out, outcome };
  }

  it("passes bytes through and finds usage across chunk and CRLF boundaries", async () => {
    const text = `: OPENROUTER PROCESSING\r\n\r\ndata: {"choices":[{"delta":{"content":"ü"}}]}\r\n\r\ndata: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\r\n\r\ndata: [DONE]\r\n\r\n`;
    const { out, outcome } = await run(text, 3);
    assert.equal(out, text);
    assert.equal(outcome.usage?.promptTokens, 7);
    assert.equal(outcome.errored, false);
  });

  it("reports a stream with an error and no usage", async () => {
    const { outcome } = await run(`data: {"error":{"message":"x"}}\n\n`);
    assert.equal(outcome.usage, undefined);
    assert.equal(outcome.errored, true);
  });

  it("reads a final line with no trailing newline", async () => {
    const { outcome } = await run(`data: {"usage":{"prompt_tokens":1,"completion_tokens":1}}`);
    assert.equal(outcome.usage?.completionTokens, 1);
  });
});

describe("events", () => {
  it("drops props outside the allowlist", () => {
    assert.deepEqual(cleanProps({ turns: 2.7, prompt: "x", code: "y", filePath: "/a", errorCode: "E1", autopilotVersion: "3.1.2", toolCalls: [] }), {
      turns: 2,
      errorCode: "E1",
      autopilotVersion: "3.1.2",
    });
    assert.deepEqual(cleanProps({ model: "m".repeat(101), durationMs: -1, os: 3 }), {});
    assert.deepEqual(cleanProps("nope"), {});
  });

  it("dedupes ids in a batch and keeps the first 100", () => {
    const batch = cleanBatch({ events: [{ id: "a", type: "turn.end" }, { id: "a", type: "turn.end" }, { id: "b", type: "error", at: "not a date" }] }, 5);
    assert.deepEqual(batch.map((event) => [event.id, event.at]), [["a", 5], ["b", 5]]);
    assert.equal(cleanBatch({ events: Array.from({ length: 120 }, (_, index) => ({ id: `e${index}`, type: "turn.end" })) }, 0).length, 100);
    assert.deepEqual(cleanBatch({}, 0), []);
  });
});

describe("codes", () => {
  it("makes and normalizes user codes", () => {
    for (let index = 0; index < 50; index++) assert.match(newUserCode(), /^[BCDFGHJKLMNPQRSTVWXZ]{4}-\d{4}$/);
    assert.equal(normalizeUserCode(" bcdf 1234 "), "BCDF-1234");
    assert.equal(normalizeUserCode("BCDF-12345"), undefined);
  });

  it("makes and normalizes invite codes", () => {
    const code = newInviteCode();
    assert.match(code, /^DL-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.equal(normalizeInviteCode(code.toLowerCase().replace(/-/g, " ")), code);
    assert.equal(normalizeInviteCode(code.slice(3)), code);
  });
});

describe("weeks", () => {
  it("start on Monday 00:00 UTC", () => {
    assert.equal(new Date(weekStart(Date.parse("2026-11-08T23:59:59Z"))).toISOString(), "2026-11-02T00:00:00.000Z");
    assert.equal(new Date(weekStart(Date.parse("2026-11-09T00:00:00Z"))).toISOString(), "2026-11-09T00:00:00.000Z");
    assert.equal(new Date(weekEnd(Date.parse("2026-11-04T12:00:00Z"))).toISOString(), "2026-11-09T00:00:00.000Z");
  });
});

describe("config", () => {
  it("applies the owner's defaults", () => {
    const config = readFreeConfig(BASE_ENV);
    assert.equal(config.weeklyTokens, 50_000_000);
    assert.equal(config.maxActiveUsers, 50);
    assert.equal(config.globalWeeklyUsdCap, 250);
    assert.equal(config.globalTotalUsdCap, 1000);
    assert.equal(config.perPersonWeeklyUsdCap, 5);
    assert.equal(config.minGithubAccountAgeDays, 30);
    assert.equal(config.countCachedTokens, true);
    assert.equal(config.paused, false);
    assert.equal(config.adminGithubIds.size, 0);
  });

  it("parses overrides and refuses bad values", () => {
    const config = readFreeConfig({ ...BASE_ENV, ADMIN_GITHUB_IDS: "1, 2", GLOBAL_WEEKLY_USD_CAP: "none", PAUSED: "yes", WEEKLY_TOKENS: "15_000_000" });
    assert.deepEqual([...config.adminGithubIds], [1, 2]);
    assert.equal(config.globalWeeklyUsdCap, undefined);
    assert.equal(config.paused, true);
    assert.equal(config.weeklyTokens, 15_000_000);
    assert.throws(() => readFreeConfig({ ...BASE_ENV, TOKEN_SIGNING_KEY: "short" }), ConfigError);
    assert.throws(() => readFreeConfig({ ...BASE_ENV, ADMIN_GITHUB_IDS: "octocat" }), ConfigError);
    assert.throws(() => readFreeConfig({ ...BASE_ENV, PAUSED: "maybe" }), ConfigError);
    assert.throws(() => readFreeConfig({ ...BASE_ENV, OPENROUTER_API_KEY: "" }), /OPENROUTER_API_KEY/);
  });

  it("reads the OpenRouter provider order", () => {
    assert.deepEqual(readFreeConfig(BASE_ENV).openRouterProviderOrder, ["deepseek"]);
    assert.deepEqual(readFreeConfig({ ...BASE_ENV, OPENROUTER_PROVIDER_ORDER: "" }).openRouterProviderOrder, []);
    assert.deepEqual(readFreeConfig({ ...BASE_ENV, OPENROUTER_PROVIDER_ORDER: "none" }).openRouterProviderOrder, []);
    assert.deepEqual(readFreeConfig({ ...BASE_ENV, OPENROUTER_PROVIDER_ORDER: " deepseek , morph/fp8 ," }).openRouterProviderOrder, ["deepseek", "morph/fp8"]);
    for (const bad of ["deep seek", "a;b", Array.from({ length: 11 }, (_, i) => `p${i}`).join(",")]) {
      assert.throws(() => readFreeConfig({ ...BASE_ENV, OPENROUTER_PROVIDER_ORDER: bad }), /OPENROUTER_PROVIDER_ORDER/);
    }
  });

  it("reads the cached-token weight, with COUNT_CACHED_TOKENS=false meaning 0", () => {
    assert.equal(readFreeConfig(BASE_ENV).cachedTokenWeight, 0.02);
    assert.equal(readFreeConfig({ ...BASE_ENV, COUNT_CACHED_TOKENS: "false" }).cachedTokenWeight, 0);
    assert.equal(readFreeConfig({ ...BASE_ENV, COUNT_CACHED_TOKENS: "true" }).cachedTokenWeight, 0.02);
    assert.equal(readFreeConfig({ ...BASE_ENV, CACHED_TOKEN_WEIGHT: "0.3" }).cachedTokenWeight, 0.3);
    assert.equal(readFreeConfig({ ...BASE_ENV, CACHED_TOKEN_WEIGHT: "1", COUNT_CACHED_TOKENS: "false" }).cachedTokenWeight, 1);
    for (const bad of ["-0.1", "1.5", "lots"]) assert.throws(() => readFreeConfig({ ...BASE_ENV, CACHED_TOKEN_WEIGHT: bad }), /CACHED_TOKEN_WEIGHT/);
  });
});
