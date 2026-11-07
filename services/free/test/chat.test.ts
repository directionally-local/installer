import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, completion, createInvite, createService, errorCode, MODEL, sse, usage, type Service } from "./harness.js";

async function member(vars: Record<string, string> = {}): Promise<{ service: Service; token: string; adminToken: string }> {
  const service = await createService(vars);
  const adminToken = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const token = (await service.signIn({ id: 100, login: "alice" }, { invite: await createInvite(service, adminToken) })).access_token;
  return { service, token, adminToken };
}

const chat = (service: Service, token: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  service.request("POST", "/v1/chat/completions", { token, headers, body: { model: MODEL, messages: [{ role: "user", content: "hello" }], ...body } });

async function me(service: Service, token: string) {
  return ((await (await service.request("GET", "/v1/me", { token })).json()) as { allowance: { usedThisWeek: number; remaining: number; spentUsdThisWeek: number } }).allowance;
}

describe("chat completions", () => {
  it("forwards to OpenRouter with our key, routing and usage, and settles from real usage", async () => {
    const { service, token } = await member();
    service.setOpenRouter(() => completion(usage(1200, 34, 1000, 0.0021)));
    const response = await chat(service, token, { max_tokens: 500, models: ["other/model"], provider: { order: ["X"] } }, { "x-session-id": "session-abc" });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { choices: unknown[] }).choices.length, 1);

    const call = service.calls.openRouter[0]!;
    assert.equal(call.headers.authorization, "Bearer sk-or-test");
    assert.equal(call.body.model, MODEL);
    assert.deepEqual(call.body.usage, { include: true });
    assert.deepEqual(
      call.body.provider,
      { sort: "price", allow_fallbacks: true, quantizations: ["fp8", "mxfp8", "fp16", "bf16", "fp32"], data_collection: "deny" },
      "our routing replaces the client's: cheapest full-precision host that doesn't collect prompts",
    );
    assert.equal(call.body.models, undefined, "no model fallback");
    assert.equal(call.body.session_id, "session-abc");
    assert.match(String(call.body.user), /^dl-[0-9a-f]{32}$/);
    assert.equal(call.body.max_tokens, 500);

    // Cached tokens count at their price relative to input (0.02): 200 + 34 + ceil(1000 × 0.02).
    const allowance = await me(service, token);
    assert.equal(allowance.usedThisWeek, 254);
    assert.equal(allowance.remaining, 50_000_000 - 254);
    assert.equal(allowance.spentUsdThisWeek, 0.0021, "the USD cap uses the real reported cost");
    assert.equal(response.headers.get("x-dl-tokens-remaining"), String(50_000_000 - 254));
    assert.equal(response.headers.get("x-dl-quota-resets-at"), "2026-11-09T00:00:00.000Z");
  });

  it("routes to OpenRouter hosts from the env settings: order override, precision and data filters", async () => {
    const filters = { allow_fallbacks: true, quantizations: ["fp8", "mxfp8", "fp16", "bf16", "fp32"], data_collection: "deny" };
    for (const [vars, expected] of [
      [{}, { sort: "price", allow_fallbacks: true, quantizations: ["fp8", "mxfp8", "fp16", "bf16", "fp32"], data_collection: "deny" }],
      [{ OPENROUTER_PROVIDER_ORDER: "" }, { sort: "price", allow_fallbacks: true, quantizations: ["fp8", "mxfp8", "fp16", "bf16", "fp32"], data_collection: "deny" }],
      [{ OPENROUTER_PROVIDER_ORDER: "DeepInfra, novita/fp8" }, { order: ["deepinfra", "novita/fp8"], ...filters }],
      [{ OPENROUTER_QUANTIZATIONS: "bf16,fp16" }, { sort: "price", allow_fallbacks: true, quantizations: ["bf16", "fp16"], data_collection: "deny" }],
      [{ OPENROUTER_QUANTIZATIONS: "none" }, { sort: "price", allow_fallbacks: true, data_collection: "deny" }],
      [{ OPENROUTER_DATA_COLLECTION: "allow" }, { sort: "price", ...filters, data_collection: "allow" }],
    ] as const) {
      const { service, token } = await member(vars as Record<string, string>);
      assert.equal((await chat(service, token)).status, 200);
      assert.deepEqual(service.calls.openRouter.at(-1)!.body.provider, expected, JSON.stringify(vars));
    }
    const invalid: Array<Record<string, string>> = [{ OPENROUTER_PROVIDER_ORDER: "not a slug" }, { OPENROUTER_QUANTIZATIONS: "fp8,fp5" }, { OPENROUTER_DATA_COLLECTION: "maybe" }];
    for (const vars of invalid) {
      const broken = await createService(vars);
      assert.equal(await errorCode(await broken.request("POST", "/v1/device/code", { body: {} })), "misconfigured", JSON.stringify(vars));
    }
  });

  it("lets the admin change the routing at runtime, and validates it", async () => {
    const { service, token, adminToken } = await member();
    const set = (body: unknown) => service.request("POST", "/admin/config", { token: adminToken, body });
    assert.equal((await set({ openRouterProviderOrder: ["deepinfra"], openRouterQuantizations: ["bf16"], openRouterDataCollection: "allow" })).status, 200);
    await chat(service, token);
    assert.deepEqual(service.calls.openRouter.at(-1)!.body.provider, { order: ["deepinfra"], allow_fallbacks: true, quantizations: ["bf16"], data_collection: "allow" });
    for (const bad of [
      { openRouterProviderOrder: "deepinfra" },
      { openRouterProviderOrder: ["bad slug"] },
      { openRouterQuantizations: ["fp5"] },
      { openRouterQuantizations: "fp8" },
      { openRouterDataCollection: "sometimes" },
    ]) assert.equal((await set(bad)).status, 400, JSON.stringify(bad));
    await set({ openRouterProviderOrder: null, openRouterQuantizations: null, openRouterDataCollection: null });
    await chat(service, token);
    assert.deepEqual(service.calls.openRouter.at(-1)!.body.provider, { sort: "price", allow_fallbacks: true, quantizations: ["fp8", "mxfp8", "fp16", "bf16", "fp32"], data_collection: "deny" }, "cleared overrides go back to env");
  });

  it("leaves cached tokens out when COUNT_CACHED_TOKENS is false", async () => {
    const { service, token } = await member({ COUNT_CACHED_TOKENS: "false" });
    service.setOpenRouter(() => completion(usage(1200, 34, 1000)));
    await chat(service, token);
    assert.equal((await me(service, token)).usedThisWeek, 234);
  });

  it("weights cached tokens by CACHED_TOKEN_WEIGHT, which wins over COUNT_CACHED_TOKENS", async () => {
    for (const [vars, expected] of [
      [{ CACHED_TOKEN_WEIGHT: "1" }, 1234],
      [{ CACHED_TOKEN_WEIGHT: "0.5" }, 734],
      [{ CACHED_TOKEN_WEIGHT: "0.1", COUNT_CACHED_TOKENS: "false" }, 334],
      [{ COUNT_CACHED_TOKENS: "true" }, 254],
    ] as const) {
      const { service, token } = await member(vars);
      service.setOpenRouter(() => completion(usage(1200, 34, 1000, 0.0021)));
      await chat(service, token);
      const allowance = await me(service, token);
      assert.equal(allowance.usedThisWeek, expected, JSON.stringify(vars));
      assert.equal(allowance.spentUsdThisWeek, 0.0021);
    }
  });

  it("lets the admin change the cached-token weight at runtime", async () => {
    const { service, token, adminToken } = await member();
    service.setOpenRouter(() => completion(usage(1200, 34, 1000)));
    assert.equal((await service.request("POST", "/admin/config", { token: adminToken, body: { cachedTokenWeight: 0.25 } })).status, 200);
    await chat(service, token);
    assert.equal((await me(service, token)).usedThisWeek, 484);
    assert.equal((await service.request("POST", "/admin/config", { token: adminToken, body: { cachedTokenWeight: 1.5 } })).status, 400);
    await service.request("POST", "/admin/config", { token: adminToken, body: { cachedTokenWeight: null } });
    await chat(service, token);
    assert.equal((await me(service, token)).usedThisWeek, 484 + 254);
  });

  it("reads usage from the last chunk of a stream", async () => {
    const { service, token } = await member();
    service.setOpenRouter(() =>
      sse(
        [
          JSON.stringify({ choices: [{ delta: { content: "héllo" } }] }),
          JSON.stringify({ choices: [{ delta: { content: " wörld" } }] }),
          JSON.stringify({ choices: [], usage: usage(900, 50, 800, 0.0005) }),
        ],
        { split: true },
      ),
    );
    const response = await chat(service, token, { stream: true });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.ok(response.headers.get("x-dl-tokens-remaining"));
    const text = await response.text();
    assert.match(text, /héllo/);
    assert.match(text, /\[DONE\]/);
    assert.equal(service.calls.openRouter[0]!.body.stream, true);
    assert.equal((await me(service, token)).usedThisWeek, 100 + 50 + 16);
  });

  it("charges the whole reservation when a stream reports no usage", async () => {
    const { service, token } = await member();
    service.setOpenRouter(() => sse([JSON.stringify({ choices: [{ delta: { content: "hi" } }] })]));
    const response = await chat(service, token, { stream: true, max_tokens: 1000 });
    await response.text();
    const forwarded = service.calls.openRouter[0]!.body;
    const bodyBytes = new TextEncoder().encode(JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hello" }], stream: true, max_tokens: 1000 })).length;
    assert.equal(forwarded.max_tokens, 1000);
    assert.equal((await me(service, token)).usedThisWeek, Math.ceil(bodyBytes / 2) + 1000);
  });

  it("settles a stream the client abandons", async () => {
    const { service, token } = await member();
    service.setOpenRouter(() => sse([JSON.stringify({ choices: [{ delta: { content: "hi" } }] })]));
    const response = await chat(service, token, { stream: true, max_tokens: 300 });
    await response.body!.cancel();
    const allowance = await me(service, token);
    assert.ok(allowance.usedThisWeek > 300, "charged the reservation");
    assert.equal(allowance.remaining, 50_000_000 - allowance.usedThisWeek, "nothing left reserved");
  });

  it("clamps max_tokens so a request can't overshoot, then refuses with quota_exceeded", async () => {
    const { service, token, adminToken } = await member();
    await service.request("POST", "/admin/people/100/grant", { token: adminToken, body: { tokensPerWeek: 5000 } });
    service.setOpenRouter(() => completion(usage(40, 10)));
    await chat(service, token, { max_tokens: 100_000 });
    const firstMax = service.calls.openRouter[0]!.body.max_tokens as number;
    assert.ok(firstMax <= 5000 && firstMax > 0);

    await service.request("POST", "/admin/people/100/grant", { token: adminToken, body: { usedThisWeek: 4900 } });
    const refused = await chat(service, token);
    assert.equal(refused.status, 402);
    const body = (await refused.json()) as { error: { code: string; resetsAt: string; reason: string } };
    assert.equal(body.error.code, "quota_exceeded");
    assert.equal(body.error.reason, "tokens");
    assert.equal(body.error.resetsAt, "2026-11-09T00:00:00.000Z");
    assert.equal(refused.headers.get("x-dl-tokens-remaining"), "100");
    assert.equal(service.calls.openRouter.length, 1, "nothing was forwarded");
  });

  it("holds concurrent reservations against the same allowance", async () => {
    const { service, token, adminToken } = await member();
    await service.request("POST", "/admin/people/100/grant", { token: adminToken, body: { tokensPerWeek: 2000 } });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    service.setOpenRouter(async () => {
      await gate;
      return completion(usage(10, 10));
    });
    const first = chat(service, token, { max_tokens: 1900 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await chat(service, token, { max_tokens: 1900 });
    assert.equal(second.status, 402, "the first request's reservation is still held");
    release();
    assert.equal((await first).status, 200);
    assert.equal((await me(service, token)).usedThisWeek, 20);
  });

  it("ends a person's week at the spending cap too", async () => {
    const { service, token } = await member({ PER_PERSON_WEEKLY_USD_CAP: "0.01" });
    service.setOpenRouter(() => completion(usage(245_000, 100, 30_000, 0.012)));
    assert.equal((await chat(service, token)).status, 200);
    const refused = await chat(service, token);
    assert.equal(refused.status, 402);
    const body = (await refused.json()) as { error: { code: string; reason: string } };
    assert.equal(body.error.code, "quota_exceeded");
    assert.equal(body.error.reason, "spend");
    assert.equal((await me(service, token)).remaining, 0);
  });

  it("resets the allowance on Monday 00:00 UTC", async () => {
    const { service, token, adminToken } = await member();
    await service.request("POST", "/admin/people/100/grant", { token: adminToken, body: { usedThisWeek: 50_000_000 } });
    assert.equal(await errorCode(await chat(service, token)), "quota_exceeded");
    service.clock.now = Date.parse("2026-11-08T23:59:59.000Z");
    const refreshed = (await (await service.request("POST", "/v1/token/refresh", { body: { refresh_token: (await service.signIn({ id: 100, login: "alice" })).refresh_token } })).json()) as { access_token: string };
    assert.equal(await errorCode(await chat(service, refreshed.access_token)), "quota_exceeded");
    service.clock.now = Date.parse("2026-11-09T00:00:00.000Z");
    const response = await chat(service, refreshed.access_token);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-dl-quota-resets-at"), "2026-11-16T00:00:00.000Z");
  });

  it("refuses other models", async () => {
    const { service, token } = await member();
    for (const model of ["deepseek/deepseek-v4.1-flash", "openai/gpt-5", undefined]) {
      const response = await chat(service, token, { model });
      assert.equal(response.status, 400);
      assert.equal(await errorCode(response), "model_not_allowed");
      assert.ok(response.headers.get("x-dl-tokens-remaining"));
    }
    assert.equal(service.calls.openRouter.length, 0);
  });

  it("rate-limits each person to 60 requests a minute", async () => {
    // 60 requests without Autopilot's session events would hit dl_only first (dl-only.test.ts).
    const { service, token } = await member({ DL_ONLY: "false" });
    for (let index = 0; index < 60; index++) assert.equal((await chat(service, token)).status, 200);
    const limited = await chat(service, token);
    assert.equal(limited.status, 429);
    const body = (await limited.json()) as { error: { code: string; retryAfter: number } };
    assert.equal(body.error.code, "rate_limited");
    assert.ok(body.error.retryAfter >= 1);
    assert.equal(limited.headers.get("retry-after"), String(body.error.retryAfter));
    service.clock.now += 2000;
    assert.equal((await chat(service, token)).status, 200);
  });

  it("answers 401 invalid_token without a valid token", async () => {
    const { service } = await member();
    const response = await chat(service, "nope");
    assert.equal(response.status, 401);
    assert.equal(await errorCode(response), "invalid_token");
  });

  it("does not charge for an upstream error", async () => {
    const { service, token } = await member();
    service.setOpenRouter(() => Response.json({ error: { code: 500, message: "boom" } }, { status: 500 }));
    const response = await chat(service, token);
    assert.equal(response.status, 502);
    assert.equal(await errorCode(response), "upstream_error");
    assert.equal((await me(service, token)).usedThisWeek, 0);
  });

  it("charges reservations whose request never came back for their prompt, not the whole reservation", async () => {
    const { service, token } = await member();
    const person = service.account(100);
    const reserved = await person.reserve({ promptEstimate: 100, requestedMaxTokens: 400, limits: { weeklyTokens: 50_000_000, weeklyUsd: 5 }, now: service.clock.now });
    assert.equal(reserved.ok, true);
    assert.equal(await person.sweep(service.clock.now + 31 * 60_000), 1);
    // The prompt estimate (100), not the reservation (100 + 400 of output never delivered).
    assert.equal((await me(service, token)).usedThisWeek, 100);
    const spend = await service.directory().spend(service.clock.now);
    assert.equal(spend.requests, 1);
    assert.equal(spend.spentUsd, 0, "an abandoned request is never OpenRouter cash");
  });
});

describe("kill switch and global caps", () => {
  it("pauses inference from env", async () => {
    const { service, token } = await member();
    service.env.PAUSED = "true";
    const response = await chat(service, token);
    assert.equal(response.status, 503);
    assert.equal(await errorCode(response), "service_paused");
  });

  it("pauses and unpauses from the admin API", async () => {
    const { service, token, adminToken } = await member();
    assert.equal((await service.request("POST", "/admin/pause", { token: adminToken })).status, 200);
    assert.equal(await errorCode(await chat(service, token)), "service_paused");
    assert.equal(await errorCode(await chat(service, adminToken)), "service_paused", "the kill switch stops admins too");
    await service.request("POST", "/admin/unpause", { token: adminToken });
    assert.equal((await chat(service, token)).status, 200);
  });

  it("stops at the global weekly cap, not counting admins", async () => {
    const { service, token, adminToken } = await member({ GLOBAL_WEEKLY_USD_CAP: "0.05" });
    service.setOpenRouter(() => completion(usage(1000, 10, 0, 0.03)));
    for (let index = 0; index < 3; index++) assert.equal((await chat(service, adminToken)).status, 200, "admin spend is tracked apart");
    assert.equal((await chat(service, token)).status, 200);
    assert.equal((await chat(service, token)).status, 200);
    const stopped = await chat(service, token);
    assert.equal(stopped.status, 503);
    const body = (await stopped.json()) as { error: { code: string; reason: string; resetsAt: string; message: string; pausedForEveryone: boolean } };
    assert.equal(body.error.code, "global_weekly_budget_reached");
    assert.equal(body.error.reason, "weekly_budget");
    assert.equal(body.error.pausedForEveryone, true);
    assert.equal(body.error.resetsAt, "2026-11-09T00:00:00.000Z");
    assert.equal(body.error.message, "Free tokens are paused for everyone until 2026-11-09T00:00:00.000Z: this week's free budget is used up. Your own key still works.");
    assert.equal(stopped.headers.get("retry-after"), String((Date.parse("2026-11-09T00:00:00.000Z") - service.clock.now) / 1000));
    assert.equal((await chat(service, adminToken)).status, 200, "admins aren't stopped by the global caps");

    const spend = (await (await service.request("GET", "/admin/spend", { token: adminToken })).json()) as Record<string, number>;
    assert.equal(spend.spentUsd, 0.06);
    assert.equal(spend.adminSpentUsd, 0.12);

    service.clock.now = Date.parse("2026-11-09T00:00:00.000Z");
    assert.equal((await chat(service, (await service.signIn({ id: 100, login: "alice" })).access_token)).status, 200, "a new week, a new budget");
  });

  it("ends the free tier at the total cap", async () => {
    const { service, token } = await member({ GLOBAL_TOTAL_USD_CAP: "0.05", GLOBAL_WEEKLY_USD_CAP: "none" });
    service.setOpenRouter(() => completion(usage(1000, 10, 0, 0.03)));
    await chat(service, token);
    await chat(service, token);
    service.clock.now = Date.parse("2026-11-20T00:00:00.000Z");
    const fresh = (await service.signIn({ id: 100, login: "alice" })).access_token;
    const ended = await chat(service, fresh);
    assert.equal(ended.status, 503);
    const body = (await ended.json()) as { error: { code: string; reason: string; message: string; resetsAt: string | null; pausedForEveryone: boolean } };
    assert.equal(body.error.code, "global_total_budget_reached");
    assert.equal(body.error.reason, "total_budget");
    assert.equal(body.error.resetsAt, null);
    assert.equal(body.error.pausedForEveryone, true);
    assert.match(body.error.message, /^Free tokens are paused for everyone: .*total budget is used up\. Your own key still works\.$/);
  });
});
