import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFreeConfig } from "../src/config.js";
import { applyOverrides, parseSettingsUpdate, readOverrides, settingsView } from "../src/runtime-config.js";
import { ADMIN_ID, completion, createInvite, createService, errorCode, MODEL, usage, type Service } from "./harness.js";

const BASE_ENV = { OPENROUTER_API_KEY: "k", GITHUB_CLIENT_ID: "c", GITHUB_CLIENT_SECRET: "s", TOKEN_SIGNING_KEY: "x".repeat(32) };

describe("runtime settings (units)", () => {
  it("parses updates, refusing unknown names and bad values", () => {
    assert.deepEqual(parseSettingsUpdate({ weeklyTokens: 60_000_000, globalTotalUsdCap: "none", openAdmission: true, maxActiveUsers: null }), {
      changes: [
        { key: "weeklyTokens", value: 60_000_000 },
        { key: "globalTotalUsdCap", value: null },
        { key: "openAdmission", value: true },
        { key: "maxActiveUsers", value: undefined },
      ],
    });
    for (const bad of [{}, { weeklyTokens: -1 }, { weeklyTokens: 1.5 }, { weeklyTokens: "50M" }, { perPersonWeeklyUsdCap: -5 }, { openAdmission: "yes" }, { maxActiveUsers: 2_000_000 }, { weeklyToken: 5 }, { paused: true }]) {
      assert.ok("error" in parseSettingsUpdate(bad), JSON.stringify(bad));
    }
  });

  it("applies overrides over env, with null USD caps meaning no cap", () => {
    const config = readFreeConfig(BASE_ENV);
    const next = applyOverrides(config, { weeklyTokens: 10, globalWeeklyUsdCap: null, perPersonWeeklyUsdCap: 2, openAdmission: true });
    assert.equal(next.weeklyTokens, 10);
    assert.equal(next.globalWeeklyUsdCap, undefined);
    assert.equal(next.perPersonWeeklyUsdCap, 2);
    assert.equal(next.openAdmission, true);
    assert.equal(next.globalTotalUsdCap, 7000, "untouched settings keep the env value");
    assert.deepEqual(settingsView(config), {
      weeklyTokens: 50_000_000,
      perPersonWeeklyUsdCap: 20,
      globalWeeklyUsdCap: 2000,
      globalTotalUsdCap: 7000,
      maxActiveUsers: 50,
      openAdmission: false,
      requireGithubActivity: true,
      cachedTokenWeight: 0.02,
      openRouterProviderOrder: [],
      openRouterQuantizations: ["fp8", "mxfp8", "fp16", "bf16", "fp32"],
      openRouterDataCollection: "deny",
      openRouterHostCooldownMinutes: 10,
      queueThreshold: 0.8,
      queueReferralPlaces: 25,
      referralBonusTokens: 10_000_000,
      referralBonusCap: 50_000_000,
      primaryUpstream: "openai",
      openaiCreditUsd: 5000,
      openaiWeeklyCreditUsd: 2000,
      openaiFirstByteTimeoutSeconds: 30,
      luminalCreditUsd: 2000,
      luminalWeeklyCreditUsd: 250,
      luminalFirstByteTimeoutSeconds: 30,
    });
  });

  it("ignores stored overrides that no longer validate", () => {
    assert.deepEqual(
      readOverrides([
        { key: "override:weeklyTokens", value: "-3" },
        { key: "override:maxActiveUsers", value: "not json" },
        { key: "override:gone", value: "1" },
        { key: "override:openAdmission", value: "true" },
        { key: "paused", value: "1" },
      ]),
      { openAdmission: true },
    );
  });
});

async function setup(vars: Record<string, string> = {}): Promise<{ service: Service; admin: string; token: string }> {
  const service = await createService(vars);
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const token = (await service.signIn({ id: 100, login: "alice" }, { invite: await createInvite(service, admin) })).access_token;
  return { service, admin, token };
}

const chat = (service: Service, token: string) => service.request("POST", "/v1/chat/completions", { token, body: { model: MODEL, messages: [], max_tokens: 300 } });
const allowance = async (service: Service, token: string) =>
  ((await (await service.request("GET", "/v1/me", { token })).json()) as { allowance: { tokensPerWeek: number; usdPerWeek: number | null } }).allowance;

describe("admin config", () => {
  it("is admins only", async () => {
    const { service, token } = await setup();
    assert.equal((await service.request("GET", "/admin/config", { token })).status, 403);
    assert.equal((await service.request("POST", "/admin/config", { token, body: { weeklyTokens: 1 } })).status, 403);
  });

  it("shows the env values until something is overridden", async () => {
    const { service, admin } = await setup({ WEEKLY_TOKENS: "40000000" });
    const view = (await (await service.request("GET", "/admin/config", { token: admin })).json()) as Record<string, any>;
    assert.equal(view.effective.weeklyTokens, 40_000_000);
    assert.deepEqual(view.effective, view.env);
    assert.deepEqual(view.overrides, {});
    assert.deepEqual(view.log, []);
  });

  it("changes the weekly token allowance and per-person USD cap without a release", async () => {
    const { service, admin, token } = await setup();
    const set = await service.request("POST", "/admin/config", { token: admin, body: { weeklyTokens: 1000, perPersonWeeklyUsdCap: 2.5 } });
    assert.equal(set.status, 200);
    const lowered = await allowance(service, token);
    assert.equal(lowered.tokensPerWeek, 1000);
    assert.equal(lowered.usdPerWeek, 2.5);
    service.setOpenRouter(() => completion(usage(800, 100)));
    assert.equal((await chat(service, token)).status, 200);
    const refused = await chat(service, token);
    assert.equal(refused.status, 402, "the lower allowance applies to the next request");
    assert.equal(await errorCode(refused), "quota_exceeded");

    await service.request("POST", "/admin/config", { token: admin, body: { weeklyTokens: null, perPersonWeeklyUsdCap: null } });
    const back = await allowance(service, token);
    assert.equal(back.tokensPerWeek, 50_000_000);
    assert.equal(back.usdPerWeek, 20);
  });

  it("a per-person grant still wins over the runtime default", async () => {
    const { service, admin, token } = await setup();
    await service.request("POST", "/admin/people/100/grant", { token: admin, body: { tokensPerWeek: 7 } });
    await service.request("POST", "/admin/config", { token: admin, body: { weeklyTokens: 1000 } });
    assert.equal((await allowance(service, token)).tokensPerWeek, 7);
  });

  it("changes the global weekly and total caps, pausing and resuming free tokens", async () => {
    const { service, admin, token } = await setup();
    service.setOpenRouter(() => completion(usage(100, 10, 0, 0.03)));
    assert.equal((await chat(service, token)).status, 200);

    await service.request("POST", "/admin/config", { token: admin, body: { globalWeeklyUsdCap: 0.02 } });
    assert.equal(await errorCode(await chat(service, token)), "global_weekly_budget_reached");
    await service.request("POST", "/admin/config", { token: admin, body: { globalWeeklyUsdCap: "none" } });
    assert.equal((await chat(service, token)).status, 200);

    await service.request("POST", "/admin/config", { token: admin, body: { globalTotalUsdCap: 0.05 } });
    assert.equal(await errorCode(await chat(service, token)), "global_total_budget_reached");
    await service.request("POST", "/admin/config", { token: admin, body: { globalTotalUsdCap: 100 } });
    assert.equal((await chat(service, token)).status, 200);

    const spend = (await (await service.request("GET", "/admin/spend", { token: admin })).json()) as { caps: Record<string, number | null> };
    assert.deepEqual(spend.caps, { globalWeeklyUsd: null, globalTotalUsd: 100, perPersonWeeklyUsd: 20, weeklyTokens: 50_000_000 });
  });

  it("validates input and changes nothing on a bad request", async () => {
    const { service, admin } = await setup();
    for (const body of [{ weeklyTokens: -1 }, { weeklyTokens: 5, maxActiveUsers: "many" }, { nope: 1 }, {}, "[]"]) {
      const response = await service.request("POST", "/admin/config", { token: admin, body });
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(await errorCode(response), "invalid_request");
    }
    const view = (await (await service.request("GET", "/admin/config", { token: admin })).json()) as Record<string, any>;
    assert.deepEqual(view.overrides, {});
  });

  it("logs who changed what and when, including pauses", async () => {
    const { service, admin } = await setup();
    await service.request("POST", "/admin/config", { token: admin, body: { weeklyTokens: 60_000_000 } });
    service.clock.now += 60_000;
    await service.request("POST", "/admin/config", { token: admin, body: { weeklyTokens: 60_000_000 } }); // no change, no entry
    await service.request("POST", "/admin/config", { token: admin, body: { weeklyTokens: null, globalTotalUsdCap: "none" } });
    await service.request("POST", "/admin/pause", { token: admin });
    const view = (await (await service.request("GET", "/admin/config", { token: admin })).json()) as { log: Array<Record<string, unknown>>; paused: boolean };
    assert.equal(view.paused, true);
    assert.deepEqual(
      view.log.map(({ key, oldValue, newValue, changedBy, changedByLogin }) => ({ key, oldValue, newValue, changedBy, changedByLogin })),
      [
        { key: "paused", oldValue: false, newValue: true, changedBy: ADMIN_ID, changedByLogin: "owner" },
        { key: "globalTotalUsdCap", oldValue: "(env)", newValue: null, changedBy: ADMIN_ID, changedByLogin: "owner" },
        { key: "weeklyTokens", oldValue: 60_000_000, newValue: "(env)", changedBy: ADMIN_ID, changedByLogin: "owner" },
        { key: "weeklyTokens", oldValue: "(env)", newValue: 60_000_000, changedBy: ADMIN_ID, changedByLogin: "owner" },
      ],
    );
    assert.equal(view.log.at(-1)!.changedAt, "2026-11-04T12:00:00.000Z");
  });
});
