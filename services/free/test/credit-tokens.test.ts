import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, completion, createInvite, createService, errorCode, luminalUsage, MODEL, usage, type Service } from "./harness.js";
import { DL, githubRoundTrip, PAGE_STATE, PAID_VARS } from "./paid-fixtures.js";

/**
 * POST /admin/people/:id/credit-tokens {countedTokens, reason, model?}: gives back tokens an
 * upstream fault charged (a runaway stream), off this week's usage on one model, floored at 0,
 * on every meter (the plan's per-model meter and the free tier's weekly counters), and logged.
 */

const credit = (service: Service, token: string, id: number, body: unknown) => service.request("POST", `/admin/people/${id}/credit-tokens`, { token, body });

describe("crediting tokens back", () => {
  it("takes the credit off the free tier's DeepSeek tokens and dollars, never below 0, and logs it", async () => {
    const service = await createService();
    const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const token = (await service.signIn({ id: 100, login: "alice" }, { invite: await createInvite(service, admin) })).access_token;
    service.setOpenRouter(() => completion(usage(300, 20, 100, 0.002)));
    assert.equal((await service.request("POST", "/v1/chat/completions", { token, body: { model: MODEL, messages: [] } })).status, 200);
    await service.settle();
    const before = (await (await service.request("GET", "/admin/people/100", { token: admin })).json()) as any;
    assert.ok(before.allowance.budgets.deepseek.spentUsd > 0);
    assert.ok(before.allowance.budgets.deepseek.tokensThisWeek > 0);

    const response = await credit(service, admin, 100, { countedTokens: 1_000_000, reason: "runaway upstream stream" });
    assert.equal(response.status, 200, await response.clone().text());
    const body = (await response.json()) as any;
    assert.equal(body.model, MODEL);
    assert.equal(body.requested, 1_000_000);
    assert.equal(body.credited.familyTokens, before.allowance.budgets.deepseek.tokensThisWeek);
    assert.equal(body.allowance.budgets.deepseek.spentUsd, 0);
    assert.equal(body.allowance.budgets.deepseek.tokensThisWeek, 0);

    const config = (await (await service.request("GET", "/admin/config", { token: admin })).json()) as any;
    const entry = config.log.find((row: any) => row.key === "credit_tokens:100:alice");
    assert.ok(entry, JSON.stringify(config.log.map((row: any) => row.key)));
    assert.equal(entry.newValue.reason, "runaway upstream stream");
    assert.equal(entry.newValue.countedTokens, 1_000_000);
    assert.equal(entry.changedByLogin, "owner");
  });

  it("refuses non-admins, a bad body and an unknown person", async () => {
    const service = await createService();
    const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const token = (await service.signIn({ id: 100, login: "alice" }, { invite: await createInvite(service, admin) })).access_token;
    assert.equal((await credit(service, token, 100, { countedTokens: 10, reason: "x" })).status, 403);
    for (const body of [{}, { countedTokens: 10 }, { countedTokens: 0, reason: "x" }, { countedTokens: 1.5, reason: "x" }, { countedTokens: 10, reason: "x", model: "nope/nope" }]) {
      const response = await credit(service, admin, 100, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(await errorCode(response), "invalid_request");
    }
    assert.equal((await credit(service, admin, 999, { countedTokens: 10, reason: "x" })).status, 404);
  });

  it("gives a Free plan account its week back on the plan's meter, so a refused account can chat again", async () => {
    const NOW = Date.UTC(2026, 10, 26, 9);
    const KEYS = { OPENAI_API_KEY: "sk-openai-test", LIQUID_INFERENCE_API_KEY: "sk-liquid", LIQUID_STATUS: "on", DL_ONLY: "false", SPEED_PROBES: "false" };
    // 286 counted a request against a 321-counted week (free-plan.test.ts): the 3rd is refused.
    const service = await createService({ ...PAID_VARS, ...KEYS, PAID_PLANS: "true", FREE_PLAN_WEEKLY_REAL_TOKENS: "5000" }, { userEmail: true, email: true });
    service.clock.now = NOW;
    service.setLuminal(() => completion(luminalUsage(4_000, 10, 3_800)));
    const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { freePlan: "on" } })).status, 200);
    const fragment = await githubRoundTrip(service, { id: 8031, login: "junk", email: "junk@example.com" }, "https://dl.new/signin");
    const signedIn = await service.request("POST", "/web/auth/github/session", { body: { code: fragment.slice("signin=".length), state: PAGE_STATE }, headers: DL });
    assert.equal(signedIn.status, 200, await signedIn.clone().text());
    const session = ((await signedIn.json()) as any).token as string;
    const made = await service.request("POST", "/web/api-keys", { token: session, body: { name: "cc" }, headers: DL });
    const key = ((await made.json()) as { key: string }).key;
    const chat = () => service.request("POST", "/v1/chat/completions", { token: key, body: { model: MODEL, messages: [{ role: "user", content: "hello" }] } });
    assert.equal((await chat()).status, 200);
    await service.settle();
    assert.equal((await chat()).status, 200);
    await service.settle();
    assert.equal((await chat()).status, 402);

    // A dl.new account is listed by its account number, not the GitHub id.
    const people = ((await (await service.request("GET", "/admin/people", { token: admin })).json()) as any).people as Array<{ githubId: number; isAdmin: boolean }>;
    const id = people.find((person) => !person.isAdmin)!.githubId;
    const response = await credit(service, admin, id, { countedTokens: 400, reason: "runaway upstream stream" });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(((await response.json()) as any).credited.planCounted, 400);
    assert.equal((await chat()).status, 200);
  });
});
