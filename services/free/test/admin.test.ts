import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, completion, createInvite, createService, errorCode, MODEL, NOW, usage, type Service } from "./harness.js";

async function setup(): Promise<{ service: Service; adminToken: string; token: string }> {
  const service = await createService();
  const adminToken = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const token = (await service.signIn({ id: 100, login: "alice" }, { invite: await createInvite(service, adminToken) })).access_token;
  return { service, adminToken, token };
}

describe("admin auth", () => {
  it("needs a token from an admin GitHub account", async () => {
    const { service, token } = await setup();
    const anonymous = await service.request("GET", "/admin/people");
    assert.equal(anonymous.status, 401);
    assert.equal(await errorCode(anonymous), "invalid_token");
    const member = await service.request("GET", "/admin/people", { token });
    assert.equal(member.status, 403);
    assert.equal(await errorCode(member), "forbidden");
    for (const path of ["/admin/metrics", "/admin/spend", "/admin/invites", "/admin/people/100"]) {
      assert.equal((await service.request("GET", path, { token })).status, 403, path);
    }
  });
});

describe("admin endpoints", () => {
  it("lists people with this week's usage", async () => {
    const { service, adminToken, token } = await setup();
    service.setOpenRouter(() => completion(usage(300, 20, 100, 0.002)));
    await service.request("POST", "/v1/chat/completions", { token, body: { model: MODEL, messages: [] } });
    const body = (await (await service.request("GET", "/admin/people", { token: adminToken })).json()) as {
      people: Array<{ login: string; isAdmin: boolean; admittedVia: string; allowance: { usedThisWeek: number; spentUsdThisWeek: number; budgets: Record<string, { spentUsd: number }> } }>;
    };
    assert.deepEqual(body.people.map((person) => person.login), ["owner", "alice"]);
    assert.equal(body.people[0]!.isAdmin, true);
    assert.match(body.people[1]!.admittedVia, /^invite:/);
    // A DeepSeek request: DeepSeek's budget, not GPT-6's (the top-level fields).
    assert.equal(body.people[1]!.allowance.budgets.deepseek!.spentUsd, 0.002);
    assert.equal(body.people[1]!.allowance.budgets.gpt6!.spentUsd, 0);
    assert.equal(body.people[1]!.allowance.spentUsdThisWeek, 0);
    assert.equal(body.people[1]!.allowance.usedThisWeek, 0, "Luna's tokens are untouched");
    const pools = (await service.account(100).allowance(service.clock.now, { weeklyTokens: 50_000_000, weeklyUsd: undefined }, "deepseek")).pools;
    assert.equal(pools.deepseek.usedThisWeek, 200 + 20 + 2);
  });

  it("creates and lists invites without revealing stored codes", async () => {
    const { service, adminToken } = await setup();
    const created = await service.request("POST", "/admin/invites", { token: adminToken, body: { count: 3, note: "first cohort" } });
    assert.equal(created.status, 201);
    const { invites } = (await created.json()) as { invites: Array<{ code: string }> };
    assert.equal(invites.length, 3);
    for (const invite of invites) assert.match(invite.code, /^DL-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const listed = (await (await service.request("GET", "/admin/invites", { token: adminToken })).json()) as { invites: Array<Record<string, unknown>> };
    assert.equal(listed.invites.length, 4);
    assert.equal(listed.invites.filter((invite) => invite.usedBy === 100).length, 1);
    assert.ok(listed.invites.every((invite) => !("code" in invite)));
    assert.equal((await service.request("POST", "/admin/invites", { token: adminToken, body: { count: 500 } })).status, 400);
  });

  it("suspends and unsuspends", async () => {
    const { service, adminToken, token } = await setup();
    assert.equal((await service.request("POST", "/admin/people/100/suspend", { token: adminToken })).status, 200);
    const refused = await service.request("POST", "/v1/chat/completions", { token, body: { model: MODEL, messages: [] } });
    assert.equal(refused.status, 403);
    assert.equal(await errorCode(refused), "suspended");
    await service.request("POST", "/admin/people/100/unsuspend", { token: adminToken });
    assert.equal((await service.request("POST", "/v1/chat/completions", { token, body: { model: MODEL, messages: [] } })).status, 200);
    assert.equal((await service.request("POST", "/admin/people/999/suspend", { token: adminToken })).status, 404);
  });

  it("adjusts a grant and puts it back to the default", async () => {
    const { service, adminToken, token } = await setup();
    const set = await service.request("POST", "/admin/people/100/grant", { token: adminToken, body: { tokensPerWeek: 1_000_000, usdPerWeek: 1 } });
    const body = (await set.json()) as { allowance: { tokensPerWeek: number; usdPerWeek: number } };
    assert.equal(body.allowance.tokensPerWeek, 1_000_000);
    assert.equal(body.allowance.usdPerWeek, 1);
    await service.request("POST", "/admin/people/100/grant", { token: adminToken, body: { tokensPerWeek: null, usdPerWeek: null } });
    const me = (await (await service.request("GET", "/v1/me", { token })).json()) as { allowance: { tokensPerWeek: number; usdPerWeek: number } };
    assert.equal(me.allowance.tokensPerWeek, 50_000_000);
    assert.equal(me.allowance.usdPerWeek, 2);
    assert.equal((await service.request("POST", "/admin/people/100/grant", { token: adminToken, body: { tokensPerWeek: -1 } })).status, 400);
  });

  it("reports spend and caps", async () => {
    const { service, adminToken } = await setup();
    const body = (await (await service.request("GET", "/admin/spend", { token: adminToken })).json()) as Record<string, unknown>;
    assert.equal(body.weekStart, "2026-11-02T00:00:00.000Z");
    assert.equal(body.spentUsd, 0);
    assert.deepEqual(body.caps, { globalWeeklyUsd: 2000, globalTotalUsd: 7000, perPersonWeeklyUsd: 2, deepseekWeeklyUsd: 8, weeklyTokens: 50_000_000 });
    assert.equal(body.paused, false);
  });
});

describe("events", () => {
  it("keeps only allowlisted props, ignores duplicate ids and caps a call at 100", async () => {
    const { service, adminToken, token } = await setup();
    const repoHash = "a".repeat(64);
    const first = await service.request("POST", "/v1/events", {
      token,
      body: {
        events: [
          {
            id: "e1",
            type: "session.end",
            sessionId: "s1",
            at: "2026-11-04T11:00:00.000Z",
            props: { turns: 3, durationMs: 1500, toolCalls: { bash: 2, "bad name/../": 1 }, model: MODEL, prompt: "secret", path: "/home/x", repoHash, os: "darwin" },
          },
          { id: "e1", type: "session.end", props: {} },
          { id: "e2", type: "not.a.type" },
          { id: "e3", type: "pr.opened", sessionId: "s1", props: { repoHash: "https://github.com/x/y" } },
        ],
      },
    });
    assert.equal(first.status, 202);
    assert.deepEqual(await first.json(), { accepted: 2 });
    const again = await service.request("POST", "/v1/events", { token, body: { events: [{ id: "e1", type: "session.end" }, { id: "e4", type: "turn.end" }] } });
    assert.deepEqual(await again.json(), { accepted: 1 });

    type Detail = {
      events: { byType: Record<string, number>; recent: Array<{ id: string; props: Record<string, unknown> }> };
      sessions: { totalTurns: number; totalDurationMs: number };
    };
    const detail = (await (await service.request("GET", "/admin/people/100", { token: adminToken })).json()) as Detail;
    const stored = detail.events.recent.find((event) => event.id === "e1")!;
    assert.deepEqual(stored.props, { turns: 3, durationMs: 1500, model: MODEL, os: "darwin", repoHash, toolCalls: { bash: 2 } });
    assert.deepEqual(detail.events.recent.find((event) => event.id === "e3")!.props, {}, "a URL is not a hash");
    assert.equal(detail.sessions.totalTurns, 3);
    assert.equal(detail.sessions.totalDurationMs, 1500);

    const many = Array.from({ length: 150 }, (_, index) => ({ id: `bulk-${index}`, type: "turn.end" }));
    assert.deepEqual(await (await service.request("POST", "/v1/events", { token, body: { events: many } })).json(), { accepted: 100 });
    const after = (await (await service.request("GET", "/admin/people/100", { token: adminToken })).json()) as Detail;
    assert.equal(after.events.byType["turn.end"], 101);
  });

  it("needs a signed-in person", async () => {
    const { service } = await setup();
    assert.equal((await service.request("POST", "/v1/events", { body: { events: [] } })).status, 401);
  });
});

describe("metrics", () => {
  const DAY = 86_400_000;
  const MON = Date.parse("2026-10-26T00:00:00.000Z");

  async function fixture() {
    const service = await createService();
    const directory = service.directory();
    const admit = (githubId: number, at: number, isAdmin = false) =>
      directory.admit({ githubId, login: `p${githubId}`, isAdmin: true, inviteCode: undefined, clientDeviceId: null, accountTooNew: false, maxActive: 50, now: at }).then(() => isAdmin);
    await admit(ADMIN_ID, MON);
    await admit(10, MON + 1000);
    await admit(11, MON + DAY);
    await admit(12, MON + 7 * DAY + 1000);
    const record = (githubId: number, at: number, prompt: number, cached: number, out: number, cost: number, latency: number, status = "ok", isAdmin = false) =>
      directory.recordRequest({ githubId, isAdmin, at, model: MODEL, promptTokens: prompt, completionTokens: out, cachedTokens: cached, chargedTokens: prompt + out, costUsd: cost, status, latencyMs: latency });
    // Week of Oct 26: person 10 twice on Monday, 11 once on Tuesday (an error), the admin once.
    await record(10, MON + 3600_000, 1000, 900, 10, 0.01, 100);
    await record(10, MON + 7200_000, 2000, 1000, 20, 0.02, 300);
    await record(11, MON + DAY + 60_000, 500, 0, 5, 0.05, 200, "upstream_error");
    await record(ADMIN_ID, MON + 3600_000, 100, 0, 1, 0.5, 50, "ok", true);
    // Week of Nov 2: 10 again (second active week), 12 for the first time.
    await record(10, MON + 7 * DAY + 3600_000, 1000, 500, 10, 0.01, 400);
    await record(12, MON + 8 * DAY, 4000, 0, 100, 0.2, 1000);
    await directory.recordEvents(10, [
      { id: "a", type: "session.end", sessionId: "s", at: MON + 3700_000, props: {} },
      { id: "b", type: "pr.opened", sessionId: "s", at: MON + 3800_000, props: {} },
    ], NOW);
    await directory.recordEvents(11, [{ id: "c", type: "error", sessionId: "t", at: MON + DAY + 70_000, props: { errorCode: "x" } }], NOW);
    return service;
  }

  it("computes the daily series, weekly active, retention, funnel and top people", async () => {
    const service = await fixture();
    const adminToken = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const response = await service.request("GET", "/admin/metrics?from=2026-10-26&to=2026-11-03", { token: adminToken });
    assert.equal(response.status, 200);
    const metrics = (await response.json()) as any;

    assert.equal(metrics.daily.length, 9);
    const monday = metrics.daily[0];
    assert.deepEqual(
      { ...monday },
      {
        date: "2026-10-26",
        activePeople: 2,
        newSignups: 2,
        requests: 3,
        tokensIn: 3100,
        tokensCached: 1900,
        tokensOut: 31,
        cachedShare: 0.6129,
        costUsd: 0.53,
        errors: 0,
        errorEvents: 0,
        latencyP50Ms: 100,
        latencyP95Ms: 300,
      },
    );
    assert.equal(metrics.daily[1].errors, 1);
    assert.equal(metrics.daily[1].errorEvents, 1);
    assert.equal(metrics.daily[1].latencyP50Ms, 200);
    assert.equal(metrics.daily[2].requests, 0);
    assert.equal(metrics.daily[2].latencyP50Ms, null);

    assert.deepEqual(metrics.weeklyActive, [
      { weekStart: "2026-10-26", activePeople: 3 },
      { weekStart: "2026-11-02", activePeople: 2 },
    ]);

    const [october, november] = metrics.retention;
    assert.equal(october.signupWeek, "2026-10-26");
    assert.equal(october.size, 3);
    assert.deepEqual(october.weeks.map((week: any) => week.active), [3, 1]);
    assert.equal(october.weeks[1].rate, 0.3333);
    assert.equal(november.size, 1);
    assert.deepEqual(november.weeks.map((week: any) => week.active), [1]);

    assert.deepEqual(metrics.funnel, { signedIn: 4, firstRequest: 4, firstSessionEnd: 1, activeSecondWeek: 1, firstPrOpened: 1 });

    assert.deepEqual(metrics.top.byTokens.map((row: any) => row.githubId), [12, 10, 11, ADMIN_ID]);
    assert.deepEqual(metrics.top.byCost.map((row: any) => row.githubId), [ADMIN_ID, 12, 11, 10]);
    const ten = metrics.cacheByPerson.find((row: any) => row.githubId === 10);
    assert.equal(ten.tokensIn, 4000);
    assert.equal(ten.tokensCached, 2400);
    assert.equal(ten.cachedShare, 0.6);
    assert.equal(metrics.totals.costUsd, 0.29, "admin cost is reported apart");
    assert.equal(metrics.totals.adminCostUsd, 0.5);
  });

  it("summarises one person by week", async () => {
    const service = await fixture();
    const adminToken = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const detail = (await (await service.request("GET", "/admin/people/10", { token: adminToken })).json()) as any;
    assert.equal(detail.login, "p10");
    const weeks = detail.weekly.slice(-2);
    assert.deepEqual(weeks.map((week: any) => [week.weekStart, week.requests, week.tokensIn, week.cachedShare]), [
      ["2026-10-26", 2, 3000, 0.6333],
      ["2026-11-02", 1, 1000, 0.5],
    ]);
    assert.equal(detail.sessions.count, 1);
    assert.equal(detail.events.byType["pr.opened"], 1);
    assert.equal((await service.request("GET", "/admin/people/424242", { token: adminToken })).status, 404);
  });

  it("validates the range", async () => {
    const service = await createService();
    const adminToken = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    assert.equal((await service.request("GET", "/admin/metrics?from=2026-11-03&to=2026-11-01", { token: adminToken })).status, 400);
    assert.equal((await service.request("GET", "/admin/metrics?from=2024-01-01&to=2026-11-01", { token: adminToken })).status, 400);
    const defaults = (await (await service.request("GET", "/admin/metrics", { token: adminToken })).json()) as { daily: unknown[] };
    assert.equal(defaults.daily.length, 28);
  });
});
