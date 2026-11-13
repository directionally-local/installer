import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, completion, createService, MODEL, NOW, openaiResponse, responsesUsage, usage, type Service } from "./harness.js";
import { modelById, type Pool } from "../src/models.js";
import { MAX_OUTPUT_TOKENS, estimateCostUsd } from "../src/quota.js";
import type { Limits } from "../src/account-object.js";

/**
 * Two weekly dollar budgets per person: GPT-6 (every GPT-6 model) and DeepSeek. Each request
 * counts against its own model's budget only. When GPT-6's runs out while DeepSeek's has room, a
 * GPT-6 request gets 402 gpt_limit pointing at DeepSeek; with both out, the usual limit codes.
 */

const LUNA = "gpt-6-luna";
const SOL = "gpt-6.1-sol";
const DEEPSEEK = MODEL;
const GPT_LIMIT_MESSAGE = "You've used this week's GPT-6 allowance. DeepSeek V4.1 Flash still has free usage this week: switch with /model, or get dl Pro.";
const RESETS = "2026-11-09T00:00:00.000Z";

/** The defaults' shape: GPT-6 $2, DeepSeek $8. */
const FULL: Limits = { weeklyTokens: 50_000_000, weeklyUsd: 2, deepseekWeeklyUsd: 8 };

async function member(vars: Record<string, string> = {}): Promise<{ service: Service; token: string; admin: string }> {
  const service = await createService({ OPEN_ADMISSION: "true", OPENAI_API_KEY: "sk-openai-test", ...vars });
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const token = (await service.signIn({ id: 100, login: "alice" })).access_token;
  return { service, token, admin };
}

const chat = (service: Service, token: string, model: string) =>
  service.request("POST", "/v1/chat/completions", { token, body: { model, messages: [{ role: "user", content: "hello" }] } });

async function me(service: Service, token: string): Promise<Record<string, any>> {
  return (await (await service.request("GET", "/v1/me", { token })).json()) as Record<string, any>;
}

async function errorOf(response: Response): Promise<Record<string, any>> {
  return ((await response.json()) as { error: Record<string, any> }).error;
}

function reserve(service: Service, account: any, limits: Limits, model: string, prompt = 100_000) {
  const served = modelById(model)!;
  return account.reserve({ pool: served.pool as Pool, promptEstimate: prompt, requestedMaxTokens: undefined, limits, now: service.clock.now, provider: served.provider, model });
}

describe("two weekly budgets: accounting", () => {
  it("counts each request against its own model's budget only", async () => {
    const { service, token } = await member();
    service.setOpenAI(() => openaiResponse(responsesUsage(1000, 1000)));
    service.setOpenRouter(() => completion(usage(1000, 100, 0, 0.25)));
    assert.equal((await chat(service, token, LUNA)).status, 200);
    assert.equal((await chat(service, token, DEEPSEEK)).status, 200);
    const body = await me(service, token);
    const lunaCost = (1000 * 0.1 + 1000 * 0.5) / 1e6;
    assert.ok(Math.abs(body.budgets.gpt6.spentUsd - lunaCost) < 1e-9, `GPT-6 spent ${body.budgets.gpt6.spentUsd}`);
    assert.equal(body.budgets.deepseek.spentUsd, 0.25);
    assert.equal(body.budgets.gpt6.usdPerWeek, 2);
    assert.equal(body.budgets.deepseek.usdPerWeek, 8);
    // Luna's tokens and DeepSeek's are kept apart too.
    assert.equal(body.pools.luna.usedThisWeek, 2000);
    assert.equal(body.pools.deepseek.usedThisWeek, 1100);
  });

  it("keeps the older /v1/me fields on the GPT-6 budget, with both budgets beside them and no level", async () => {
    const { service, token, admin } = await member();
    await service.request("POST", "/admin/people/100/grant", { token: admin, body: { spentUsdThisWeek: 0.5, deepseekSpentUsdThisWeek: 3 } });
    const body = await me(service, token);
    assert.equal(body.allowance.usdPerWeek, 2, "older Autopilot reads the GPT-6 budget here");
    assert.equal(body.allowance.spentUsdThisWeek, 0.5);
    assert.deepEqual(body.allowance.budgets, { gpt6: { usdPerWeek: 2, spentUsd: 0.5, tokensThisWeek: 0 }, deepseek: { usdPerWeek: 8, spentUsd: 3, tokensThisWeek: 0 } });
    assert.deepEqual(body.budgets, body.allowance.budgets);
    assert.equal(body.pools.deepseek.tokensPerWeek, null);
    assert.equal(body.pools.deepseek.family, "deepseek");
    assert.equal(body.pools.sol.family, "gpt6");
    assert.equal(body.level, undefined);
    assert.equal(body.levelReason, undefined);
    assert.equal(body.offers.pro.valueLine, "Lots of DeepSeek every week, plus more GPT-6.");
  });

  it("holds in-flight estimates per budget: GPT-6's full of estimates doesn't stop DeepSeek, and DeepSeek's don't count for GPT-6", async () => {
    const { service } = await member();
    const account = service.account(100) as any;
    const sol = estimateCostUsd(100_000, MAX_OUTPUT_TOKENS, modelById(SOL)!.prices);
    const gpt = await Promise.all(Array.from({ length: 20 }, () => reserve(service, account, FULL, SOL)));
    const held = gpt.filter((r) => r.ok).length;
    assert.equal(held, Math.floor(2 / sol), "GPT-6's $2 holds as many Sol estimates as fit");
    const refused = gpt.find((r) => !r.ok);
    assert.equal(refused.family, "gpt6");
    assert.equal(refused.reason, "spend");
    assert.equal(refused.deepseekLeft, true);
    // DeepSeek's budget is untouched by GPT-6's estimates.
    const deepseek = await Promise.all(Array.from({ length: 5 }, () => reserve(service, account, FULL, DEEPSEEK)));
    assert.ok(deepseek.every((r) => r.ok));
    // A fresh account: DeepSeek in flight never stops GPT-6.
    const other = (await createService({ OPEN_ADMISSION: "true" })) as Service;
    await other.signIn({ id: 101, login: "bob" });
    const second = other.account(101) as any;
    const tight: Limits = { weeklyTokens: 50_000_000, weeklyUsd: 1, deepseekWeeklyUsd: 0.01 };
    const ds = await Promise.all(Array.from({ length: 5 }, () => reserve(other, second, tight, DEEPSEEK)));
    assert.equal(ds.filter((r) => r.ok).length, 1, "DeepSeek's small budget fills");
    assert.equal((await reserve(other, second, tight, SOL)).ok, true, "GPT-6 still has its own room");
  });

  it("spends a dollar top-up on either budget once that budget's week is used up", async () => {
    const { service, token, admin } = await member();
    await service.request("POST", "/admin/people/100/grant", { token: admin, body: { spentUsdThisWeek: 2 } });
    await (service.account(100) as any).grantCredit({ id: "cs_1", usd: 2.5, createdAt: NOW, expiresAt: NOW + 90 * 86_400_000 });
    service.setOpenAI(() => openaiResponse(responsesUsage(1000, 1000)));
    assert.equal((await chat(service, token, LUNA)).status, 200, "GPT-6 from the top-up, no gpt_limit");
    const after = await me(service, token);
    assert.ok(after.topupUsdLeft < 2.5);
    assert.equal(after.budgets.gpt6.spentUsd, 2, "the week's GPT-6 counter is unchanged");
  });
});

describe("two weekly budgets: refusals", () => {
  it("answers gpt_limit when only GPT-6's week is used up, with DeepSeek as the alternative", async () => {
    const { service, token, admin } = await member();
    await service.request("POST", "/admin/people/100/grant", { token: admin, body: { spentUsdThisWeek: 2 } });
    for (const model of [LUNA, SOL, "gpt-6-astra"]) {
      const refused = await chat(service, token, model);
      assert.equal(refused.status, 402, model);
      const error = await errorOf(refused);
      assert.equal(error.code, "gpt_limit");
      assert.equal(error.message, GPT_LIMIT_MESSAGE);
      assert.equal(error.family, "gpt6");
      assert.equal(error.resetsAt, RESETS);
      assert.equal(error.alternative, DEEPSEEK);
      assert.equal(error.offers.pro.price, "$3.99/month");
      assert.doesNotMatch(error.message, /basic|starter/i);
    }
    assert.equal(service.calls.openai.length, 0, "nothing was forwarded");
    // DeepSeek itself still works.
    assert.equal((await chat(service, token, DEEPSEEK)).status, 200);
  });

  it("answers the usual quota_exceeded when both weeks are used up", async () => {
    const { service, token, admin } = await member();
    await service.request("POST", "/admin/people/100/grant", { token: admin, body: { spentUsdThisWeek: 2, deepseekSpentUsdThisWeek: 8 } });
    for (const model of [LUNA, DEEPSEEK]) {
      const error = await errorOf(await chat(service, token, model));
      assert.equal(error.code, "quota_exceeded", model);
      assert.equal(error.reason, "spend");
      assert.ok(error.offers);
    }
  });

  it("answers the level's code (with free wording) for a smaller level when both weeks are used up, gpt_limit when only GPT-6's is", async () => {
    const { service, admin } = await member({ FULL_MIN_ACCOUNT_AGE_DAYS: "365", FULL_MIN_CONTRIBUTIONS: "100", FULL_MIN_PUBLIC_REPOS: "100000", NETWORK_SIGNUPS_PER_DAY: "1000" });
    const { access_token: token } = await service.signIn({ id: 200, login: "young", createdAt: "2026-06-01T00:00:00Z", publicRepos: 0, contributions: 10, social: 0 });
    assert.equal((await service.directory().getPerson(200))?.level, "starter");
    const mine = await me(service, token);
    assert.deepEqual(mine.budgets, { gpt6: { usdPerWeek: 2, spentUsd: 0, tokensThisWeek: 0 }, deepseek: { usdPerWeek: 8, spentUsd: 0, tokensThisWeek: 0 } }, "the same budgets as Full by default");
    await service.request("POST", "/admin/people/200/grant", { token: admin, body: { spentUsdThisWeek: 2 } });
    assert.equal((await errorOf(await chat(service, token, LUNA))).code, "gpt_limit");
    await service.request("POST", "/admin/people/200/grant", { token: admin, body: { deepseekSpentUsdThisWeek: 8 } });
    const error = await errorOf(await chat(service, token, LUNA));
    assert.equal(error.code, "starter_limit");
    assert.doesNotMatch(error.message, /basic|starter/i);
    assert.match(error.message, /^You've used this week's free allowance/);
  });

  it("doesn't point at DeepSeek when nothing can serve it", async () => {
    const { service, token, admin } = await member({ OPENROUTER_API_KEY: "" });
    await service.request("POST", "/admin/people/100/grant", { token: admin, body: { spentUsdThisWeek: 2 } });
    assert.equal((await errorOf(await chat(service, token, LUNA))).code, "quota_exceeded");
  });
});

describe("two weekly budgets: Pro, personal caps and creation batches", () => {
  it("gives Pro $6 of GPT-6 and $40 of DeepSeek, and a gpt_limit without the Pro offer", async () => {
    const { service, token, admin } = await member();
    const account = service.account(100) as any;
    await account.applySubscription({ subscriptionId: "sub_1", state: "active", periodEnd: service.clock.now + 30 * 86_400_000, eventAt: 1 });
    const body = await me(service, token);
    assert.equal(body.plan, "pro");
    assert.deepEqual(body.budgets, { gpt6: { usdPerWeek: 6, spentUsd: 0, tokensThisWeek: 0 }, deepseek: { usdPerWeek: 40, spentUsd: 0, tokensThisWeek: 0 } });
    await service.request("POST", "/admin/people/100/grant", { token: admin, body: { spentUsdThisWeek: 6 } });
    const error = await errorOf(await chat(service, token, LUNA));
    assert.equal(error.code, "gpt_limit");
    assert.equal(error.message, "You've used this week's Pro GPT-6 allowance. DeepSeek V4.1 Flash still has usage this week: switch with /model.");
    assert.equal((await chat(service, token, DEEPSEEK)).status, 200);
  });

  it("applies a personal cap to GPT-6, and gives DeepSeek the larger of it and the level's budget", async () => {
    const { service, token, admin } = await member();
    await service.request("POST", "/admin/people/100/grant", { token: admin, body: { usdPerWeek: 20 } });
    assert.deepEqual((await me(service, token)).budgets, { gpt6: { usdPerWeek: 20, spentUsd: 0, tokensThisWeek: 0 }, deepseek: { usdPerWeek: 20, spentUsd: 0, tokensThisWeek: 0 } });
    await service.request("POST", "/admin/people/100/grant", { token: admin, body: { usdPerWeek: 5 } });
    assert.deepEqual((await me(service, token)).budgets, { gpt6: { usdPerWeek: 5, spentUsd: 0, tokensThisWeek: 0 }, deepseek: { usdPerWeek: 8, spentUsd: 0, tokensThisWeek: 0 } });
    // Back to the level's own.
    await service.request("POST", "/admin/people/100/grant", { token: admin, body: { usdPerWeek: null } });
    assert.deepEqual((await me(service, token)).budgets, { gpt6: { usdPerWeek: 2, spentUsd: 0, tokensThisWeek: 0 }, deepseek: { usdPerWeek: 8, spentUsd: 0, tokensThisWeek: 0 } });
  });

  it("gives a batch-flagged account nothing of either budget", async () => {
    const { service } = await member();
    const account = service.account(100) as any;
    const flagged: Limits = { weeklyTokens: 50_000_000, weeklyUsd: 0, deepseekWeeklyUsd: 0, level: "starter", levelTokens: 0 };
    const allowance = await account.allowance(service.clock.now, flagged);
    assert.deepEqual(allowance.budgets, { gpt6: { usdPerWeek: 0, spentUsd: 0, tokensThisWeek: 0 }, deepseek: { usdPerWeek: 0, spentUsd: 0, tokensThisWeek: 0 } });
    assert.equal(allowance.pools.deepseek.tokensPerWeek, 0);
    for (const model of [LUNA, DEEPSEEK]) {
      const result = await reserve(service, account, flagged, model, 1000);
      assert.equal(result.ok, false, model);
      assert.equal(result.deepseekLeft, false);
    }
  });
});

describe("two weekly budgets: tokens counted the normal way", () => {
  it("counts every token processed per budget (cached included), next to the weighted token allowance", async () => {
    const { service, token } = await member();
    // 1200 prompt tokens of which 1000 cached, 34 completion: 1234 processed, 254 charged at weight 0.02.
    service.setOpenRouter(() => completion(usage(1200, 34, 1000, 0.002)));
    service.setOpenAI(() => openaiResponse(responsesUsage(5000, 500, 4000)));
    assert.equal((await chat(service, token, DEEPSEEK)).status, 200);
    assert.equal((await chat(service, token, DEEPSEEK)).status, 200);
    assert.equal((await chat(service, token, LUNA)).status, 200);
    const body = await me(service, token);
    assert.equal(body.budgets.deepseek.tokensThisWeek, 2 * 1234);
    assert.equal(body.pools.deepseek.usedThisWeek, 2 * 254, "the charged count is kept as it was");
    assert.equal(body.budgets.gpt6.tokensThisWeek, 5500);
    assert.ok(body.pools.luna.usedThisWeek < 5500);
    // A new week starts at 0.
    service.clock.now = Date.parse(RESETS);
    const fresh = (await service.signIn({ id: 100, login: "alice" })).access_token;
    const next = await me(service, fresh);
    assert.equal(next.budgets.deepseek.tokensThisWeek, 0);
    assert.equal(next.budgets.gpt6.tokensThisWeek, 0);
  });
});

describe("POST /admin/reset-week", () => {
  it("counts with dryRun, then starts the week over for everyone not blocked, both budgets", async () => {
    const { service, token, admin } = await member();
    const bob = (await service.signIn({ id: 101, login: "bob" })).access_token;
    await service.signIn({ id: 102, login: "mallory" });
    assert.equal((await service.request("POST", "/admin/people/102/block", { token: admin })).status, 200);
    service.setOpenRouter(() => completion(usage(1000, 100, 0, 0.5)));
    service.setOpenAI(() => openaiResponse(responsesUsage(1000, 1000)));
    for (const who of [token, bob]) {
      assert.equal((await chat(service, who, DEEPSEEK)).status, 200);
      assert.equal((await chat(service, who, LUNA)).status, 200);
    }
    await service.request("POST", "/admin/people/101/grant", { token: admin, body: { spentUsdThisWeek: 2, deepseekSpentUsdThisWeek: 8 } });
    await service.request("POST", "/admin/people/102/grant", { token: admin, body: { spentUsdThisWeek: 1.5 } });
    assert.equal((await errorOf(await chat(service, bob, LUNA))).code, "quota_exceeded");

    const counted = await service.request("POST", "/admin/reset-week", { token: admin, body: { dryRun: true } });
    assert.deepEqual(await counted.json(), { dryRun: true, people: 3, reset: 0, skippedBlocked: 1 });
    assert.equal((await me(service, bob)).budgets.deepseek.spentUsd, 8, "a dry run changes nothing");

    const done = await service.request("POST", "/admin/reset-week", { token: admin, body: {} });
    assert.deepEqual(await done.json(), { dryRun: false, people: 3, reset: 3, skippedBlocked: 1 });
    for (const who of [token, bob]) {
      const body = await me(service, who);
      assert.deepEqual(body.budgets, { gpt6: { usdPerWeek: 2, spentUsd: 0, tokensThisWeek: 0 }, deepseek: { usdPerWeek: 8, spentUsd: 0, tokensThisWeek: 0 } });
      assert.equal(body.pools.luna.usedThisWeek, 0);
      assert.equal(body.pools.deepseek.usedThisWeek, 0);
    }
    assert.equal((await chat(service, bob, LUNA)).status, 200, "usable again");
    // The blocked account was left alone.
    const blocked = await (service.account(102) as any).allowance(service.clock.now, FULL);
    assert.equal(blocked.budgets.gpt6.spentUsd, 1.5);

    assert.equal((await service.request("POST", "/admin/reset-week", { token: admin, body: { dryRun: "yes" } })).status, 400);
    assert.equal((await service.request("POST", "/admin/reset-week", { token, body: {} })).status, 403, "admins only");
  });
});
