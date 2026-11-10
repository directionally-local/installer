import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createService, openaiResponse, responsesUsage, type Service } from "./harness.js";
import { modelById, type Pool } from "../src/models.js";
import { ESTIMATE_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS, estimateCostUsd } from "../src/quota.js";
import type { Limits } from "../src/account-object.js";

/**
 * The weekly dollar cap with requests in flight. Each reservation holds an estimated cost (the
 * prompt estimate at the uncached input price, plus the output up to ESTIMATE_OUTPUT_TOKENS at
 * the output price); a request whose estimate doesn't fit next to what is settled and in flight
 * is refused with reason "spend". A request with nothing else in flight still goes through while
 * any of the cap is left, so the overshoot is at most one request.
 */

const SOL = "gpt-6.1-sol";
const PROMPT = 100_000;
const FULL: Limits = { weeklyTokens: 50_000_000, weeklyUsd: 5 };
const BASIC: Limits = { weeklyTokens: 50_000_000, weeklyUsd: 3, level: "basic", levelTokens: 10_000_000 };
const STARTER: Limits = { weeklyTokens: 50_000_000, weeklyUsd: 0.5, level: "starter", levelTokens: 2_000_000 };

/** What one reservation of `prompt` tokens on `model` (asking for the most output) is held as. */
function estimate(model: string, prompt = PROMPT): number {
  return estimateCostUsd(prompt, MAX_OUTPUT_TOKENS, modelById(model)!.prices);
}

async function person(id = 100): Promise<{ service: Service; account: any }> {
  const service = await createService({ OPEN_ADMISSION: "true" });
  await service.signIn({ id, login: `user${id}` });
  return { service, account: service.account(id) };
}

function reserve(service: Service, account: any, limits: Limits, model = SOL, prompt = PROMPT) {
  const served = modelById(model)!;
  return account.reserve({ pool: served.pool as Pool, promptEstimate: prompt, requestedMaxTokens: undefined, limits, now: service.clock.now, provider: served.provider, model });
}

/** Reserves `n` requests at once, never settling them; returns the results in order. */
async function burst(service: Service, account: any, limits: Limits, n: number, model = SOL, prompt = PROMPT): Promise<any[]> {
  return Promise.all(Array.from({ length: n }, () => reserve(service, account, limits, model, prompt)));
}

/** How many of a burst the cap admits: the first always, then while the estimates fit. */
function admits(cap: number, each: number): number {
  let n = 1;
  while ((n + 1) * each <= cap) n++;
  return n;
}

describe("the weekly dollar cap with requests in flight", () => {
  it("counts only the output up to ESTIMATE_OUTPUT_TOKENS, at the uncached input price", () => {
    const prices = modelById(SOL)!.prices;
    assert.equal(estimateCostUsd(PROMPT, MAX_OUTPUT_TOKENS, prices), (PROMPT * prices.input + ESTIMATE_OUTPUT_TOKENS * prices.output) / 1e6);
    assert.equal(estimateCostUsd(PROMPT, 1_000, prices), (PROMPT * prices.input + 1_000 * prices.output) / 1e6);
  });

  it("refuses parallel reservations once their estimates fill the cap", async () => {
    const { service, account } = await person();
    const results = await burst(service, account, BASIC, 20);
    const expected = admits(3, estimate(SOL));
    assert.equal(expected, 10, "ten $0.28 Sol estimates fit under $3");
    assert.equal(results.filter((r) => r.ok).length, expected);
    for (const refused of results.filter((r) => !r.ok)) {
      assert.equal(refused.code, "quota_exceeded");
      assert.equal(refused.reason, "spend");
    }
    // The tokens were fine: it's the dollars in flight that stopped the rest.
    assert.ok(results[0].allowance.pools.sol.remaining > 0);
  });

  it("releases a reservation's estimate when it settles", async () => {
    const { service, account } = await person();
    const held = (await burst(service, account, BASIC, 10)).filter((r) => r.ok);
    assert.equal(held.length, 10);
    assert.equal((await reserve(service, account, BASIC)).ok, false, "the cap is full of estimates");
    await account.settle({ reservationId: held[0].reservationId, charged: 2_000, costUsd: 0.04, limits: BASIC, now: service.clock.now });
    // $0.04 settled + 9 estimates + this one = $2.86: fits.
    assert.equal((await reserve(service, account, BASIC)).ok, true);
    assert.equal((await reserve(service, account, BASIC)).ok, false);
  });

  it("holds an abandoned reservation's estimate until the alarm sweeps it, then charges only the prompt", async () => {
    const { service, account } = await person();
    assert.equal((await burst(service, account, BASIC, 10)).filter((r) => r.ok).length, 10);
    service.clock.now += 31 * 60_000;
    // Expired but not yet swept: it still counts, since it will be charged.
    assert.equal((await reserve(service, account, BASIC)).ok, false);
    assert.equal(await account.sweep(service.clock.now), 10);
    const after = await account.allowance(service.clock.now, BASIC, "sol");
    // Each was charged its prompt estimate at the input price: 100k × $2/M = $0.20.
    assert.equal(after.spentUsdThisWeek, 2);
    const results = await burst(service, account, BASIC, 5);
    // $2 settled leaves room for three $0.28 estimates.
    assert.equal(results.filter((r) => r.ok).length, admits(1, estimate(SOL)));
    assert.equal(results.filter((r) => r.ok).length, 3);
  });

  it("stops sequential use at the cap, the last request going through while any of it is left", async () => {
    const { service, account } = await person();
    let requests = 0;
    for (;;) {
      const result = await reserve(service, account, BASIC);
      if (!result.ok) {
        assert.equal(result.reason, "spend");
        break;
      }
      requests++;
      await account.settle({ reservationId: result.reservationId, charged: 10_000, costUsd: 0.4, limits: BASIC, now: service.clock.now });
    }
    const after = await account.allowance(service.clock.now, BASIC, "sol");
    // $0.40 a request: seven leave $0.20 of the $3, and the eighth (estimated at $0.28) still runs.
    assert.equal(requests, 8);
    assert.ok(Math.abs(after.spentUsdThisWeek - 3.2) < 1e-9, `spent ${after.spentUsdThisWeek}`);
  });

  it("lets a request through alone when its estimate is larger than the room left, but not next to another", async () => {
    const { service, account } = await person();
    const tight: Limits = { ...BASIC, weeklyUsd: 0.1 };
    const results = await burst(service, account, tight, 3);
    assert.deepEqual(
      results.map((r) => r.ok),
      [true, false, false],
    );
  });

  it("caps every level, a per-person cap and every model's pool the same way", async () => {
    const levels: Array<[string, Limits]> = [
      ["full", FULL],
      ["basic", BASIC],
      ["starter", STARTER],
    ];
    const models = ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra", "deepseek/deepseek-v4.1-flash-1017"];
    let id = 1000;
    for (const [level, base] of levels) {
      for (const model of models) {
        // A small prompt, so the token allowances never stop anything first.
        const prompt = 1_000;
        const each = estimate(model, prompt);
        const limits: Limits = { ...base, weeklyUsd: each * 3.5 };
        const { service, account } = await person(id++);
        const results = await burst(service, account, limits, 6, model, prompt);
        assert.equal(results.filter((r) => r.ok).length, 3, `${level} on ${model}`);
        assert.ok(results.filter((r) => !r.ok).every((r) => r.reason === "spend"), `${level} on ${model}`);
      }
      // A per-person cap set by an admin is held the same way.
      const { service, account } = await person(id++);
      await account.setGrant({ tokensPerWeek: undefined, usdPerWeek: estimate(SOL) * 2.5, usedThisWeek: undefined, spentUsdThisWeek: undefined, limits: base, now: service.clock.now });
      const results = await burst(service, account, base, 5);
      assert.equal(results.filter((r) => r.ok).length, 2, `${level} with a per-person cap`);
    }
  });

  it("leaves Pro uncapped unless Pro has its own cap, and then holds that one", async () => {
    const { service, account } = await person();
    await account.applySubscription({ subscriptionId: "sub_1", state: "active", periodEnd: service.clock.now + 30 * 86_400_000, eventAt: 1 });
    // The free cap ($0.10) doesn't apply to Pro, and Pro has no cap of its own here.
    const uncapped: Limits = { ...FULL, weeklyUsd: 0.1, proTokensPerWeek: 50_000_000 };
    const results = await burst(service, account, uncapped, 20);
    assert.ok(results.every((r) => r.ok && r.paid));

    const other = await person(101);
    await other.account.applySubscription({ subscriptionId: "sub_2", state: "active", periodEnd: other.service.clock.now + 30 * 86_400_000, eventAt: 1 });
    const capped: Limits = { ...uncapped, proUsdPerWeek: 3 };
    const held = await burst(other.service, other.account, capped, 20);
    assert.equal(held.filter((r) => r.ok).length, admits(3, estimate(SOL)));
    assert.ok(held.filter((r) => !r.ok).every((r) => r.reason === "spend"));
  });
});

describe("parallel requests through the API", () => {
  it("refuses a basic person's parallel Sol requests once the in-flight estimates fill the $3 cap", async () => {
    const service = await createService({
      OPENAI_API_KEY: "sk-test",
      OPEN_ADMISSION: "true",
      STARTER_WEEKLY_TOKENS: "0",
      FULL_MIN_ACCOUNT_AGE_DAYS: "365",
      FULL_MIN_CONTRIBUTIONS: "100",
      FULL_MIN_PUBLIC_REPOS: "100000",
      NETWORK_SIGNUPS_PER_DAY: "1000",
    });
    const { access_token: token } = await service.signIn({ id: 100, login: "user100", createdAt: "2019-01-01T00:00:00Z", publicRepos: 0, contributions: 10, social: 0 });
    const me = (await (await service.request("GET", "/v1/me", { token })).json()) as Record<string, any>;
    assert.equal(me.level, "basic");
    assert.equal(me.allowance.usdPerWeek, 3);

    // Every answer waits until released: they are all in flight together.
    const waiting: Array<() => void> = [];
    service.setOpenAI(() => new Promise<Response>((resolve) => waiting.push(() => resolve(openaiResponse(responsesUsage(100_000, 2_000, 95_000))))));
    // About 200 kB of prompt: an estimate of 100k tokens, so $0.28 held per request.
    const content = "x".repeat(200_000);
    const body = { model: SOL, messages: [{ role: "user", content }] };
    const pending = Array.from({ length: 16 }, () => service.request("POST", "/v1/chat/completions", { token, body }));
    for (let i = 0; i < 50 && waiting.length < 10; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(waiting.length, 10, "ten requests reached OpenAI");
    for (const release of waiting) release();
    const responses = await Promise.all(pending);
    assert.equal(responses.filter((r) => r.status === 200).length, 10);
    const refused = responses.filter((r) => r.status === 402);
    assert.equal(refused.length, 6);
    for (const response of refused) {
      const error = ((await response.json()) as { error: Record<string, any> }).error;
      assert.equal(error.code, "basic_limit");
      assert.equal(error.reason, "spend");
    }
    // Settled at what they really cost, the cap has room again.
    const after = (await (await service.request("GET", "/v1/me", { token })).json()) as Record<string, any>;
    assert.ok(after.allowance.spentUsdThisWeek < 1, `spent ${after.allowance.spentUsdThisWeek}`);
    waiting.length = 0;
    const again = service.request("POST", "/v1/chat/completions", { token, body });
    for (let i = 0; i < 50 && waiting.length < 1; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    for (const release of waiting) release();
    assert.equal((await again).status, 200);
  });
});
