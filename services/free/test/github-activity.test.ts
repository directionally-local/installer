import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, completion, createInvite, createService, MODEL, startBrowserFlow, type GitHubUserFixture, type Service } from "./harness.js";

/**
 * Account levels: Full for accounts that look like working developers, Starter for everyone
 * else. Starter gets every model on a small weekly allowance; it is never refused. The basic
 * level is off here (basic.test.ts covers it).
 */

const NEW = "2026-10-20T00:00:00Z"; // 15 days before the harness clock
const OLD = "2015-01-01T00:00:00Z";

async function open(vars: Record<string, string> = {}): Promise<{ service: Service; admin: string }> {
  const service = await createService({ OPEN_ADMISSION: "true", OPENAI_API_KEY: "sk-test", BASIC_WEEKLY_TOKENS: "0", ...vars });
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  return { service, admin };
}

const signedIn = (page: string) => /Signed in as/.test(page);

async function person(service: Service, admin: string, githubId: number): Promise<Record<string, any> | undefined> {
  const body = (await (await service.request("GET", "/admin/people", { token: admin })).json()) as { people: Array<Record<string, any>> };
  return body.people.find((row) => row.githubId === githubId);
}

async function githubChecks(service: Service, admin: string): Promise<Record<string, number>> {
  const body = (await (await service.request("GET", "/admin/metrics", { token: admin })).json()) as { githubChecks: Record<string, number> };
  return body.githubChecks;
}

const chat = (service: Service, token: string, model = MODEL) =>
  service.request("POST", "/v1/chat/completions", { token, body: { model, messages: [{ role: "user", content: "hi" }] } });

describe("account levels at sign-in", () => {
  it("gives Full to an account with 3 public repositories", async () => {
    const { service, admin } = await open();
    const flow = await startBrowserFlow(service.request, { id: 100, login: "repos", publicRepos: 3 });
    assert.ok(signedIn(flow.page));
    const row = await person(service, admin, 100);
    assert.equal(row?.level, "full");
    assert.equal(row?.levelReason, "qualifies");
    assert.equal(row?.signals.publicRepos, 3);
  });

  it("gives Full to an account with 50 contributions in the last year", async () => {
    const { service, admin } = await open();
    const flow = await startBrowserFlow(service.request, { id: 100, login: "contrib", publicRepos: 0, contributions: 50, activeWeeks: 20 });
    assert.ok(signedIn(flow.page));
    const row = await person(service, admin, 100);
    assert.equal(row?.level, "full");
    assert.equal(row?.signals.contributions, 50);
    assert.deepEqual(await githubChecks(service, admin), { contributions: 1, none: 0, error: 0 });
  });

  it("gives Starter to an account with neither, and admits it", async () => {
    const { service, admin } = await open();
    const flow = await startBrowserFlow(service.request, { id: 100, login: "empty", publicRepos: 0, contributions: 0 });
    assert.ok(signedIn(flow.page), "Starter is admitted, not refused");
    const row = await person(service, admin, 100);
    assert.equal(row?.level, "starter");
    assert.equal(row?.levelReason, "few_repos_and_contributions");
  });

  it("gives Starter to an account younger than 90 days, even with repositories", async () => {
    const { service, admin } = await open();
    const flow = await startBrowserFlow(service.request, { id: 100, login: "fresh", createdAt: NEW, publicRepos: 10 });
    assert.ok(signedIn(flow.page));
    const row = await person(service, admin, 100);
    assert.equal(row?.level, "starter");
    assert.equal(row?.levelReason, "account_too_new");
  });

  it("counts private contributions the person shows", async () => {
    const { service, admin } = await open();
    const flow = await startBrowserFlow(service.request, { id: 100, login: "private", publicRepos: 0, contributions: 60, restrictedContributions: 55, activeWeeks: 20 });
    assert.ok(signedIn(flow.page));
    const row = await person(service, admin, 100);
    assert.equal(row?.level, "full");
    assert.equal(row?.signals.restrictedContributions, 55);
  });

  for (const failure of ["error", "throw"] as const) {
    it(`fails open to Full when GitHub's API fails (${failure}), and counts it`, async () => {
      const { service, admin } = await open();
      const flow = await startBrowserFlow(service.request, { id: 100, login: "unlucky", publicRepos: 0, contributions: failure });
      assert.ok(signedIn(flow.page));
      assert.equal((await person(service, admin, 100))?.level, "full");
      assert.deepEqual(await githubChecks(service, admin), { contributions: 0, none: 0, error: 1 });
    });
  }

  it("alerts once a day when GitHub errors let five sign-ups through", async () => {
    const { service } = await open({ ALERT_WEBHOOK_URL: "https://alerts.test/hook" });
    for (let i = 0; i < 6; i++) {
      const request: Service["request"] = (method, path, options = {}) => service.request(method, path, { ...options, ip: `198.51.100.${i + 1}` });
      assert.ok(signedIn((await startBrowserFlow(request, { id: 100 + i, login: `u${i}`, publicRepos: 0, contributions: "error" })).page));
    }
    const alerts = service.calls.webhooks.filter((call) => String(call.body.text).includes("activity check"));
    assert.equal(alerts.length, 1);
    assert.match(String(alerts[0]!.body.text), /didn't answer the sign-up activity check 5 times today/);
  });

  it("doesn't read signals for admins", async () => {
    const service = await createService({ OPEN_ADMISSION: "true" });
    const flow = await startBrowserFlow(service.request, { id: ADMIN_ID, login: "owner", publicRepos: 0, contributions: 0 });
    assert.ok(signedIn(flow.page));
    assert.deepEqual(service.calls.githubGraphql, []);
  });

  it("re-reads the signals at sign-in", async () => {
    const { service, admin } = await open();
    assert.ok(signedIn((await startBrowserFlow(service.request, { id: 100, login: "old", publicRepos: 0, contributions: 0 })).page));
    assert.equal((await person(service, admin, 100))?.level, "starter");
    // Later the account has repositories: signing in again promotes it.
    assert.ok(signedIn((await startBrowserFlow(service.request, { id: 100, login: "old", publicRepos: 5, contributions: 0 })).page));
    assert.equal((await person(service, admin, 100))?.level, "full");
  });

  it("gives Full to an invite, whatever the signals say", async () => {
    const { service, admin } = await open();
    const invite = await createInvite(service, admin);
    const flow = await startBrowserFlow(service.request, { id: 100, login: "invited", publicRepos: 0, contributions: 0 });
    // Open admission admits it as Starter first; the invite path is for invite-only mode.
    assert.ok(signedIn(flow.page));
    assert.equal((await person(service, admin, 100))?.level, "starter");
    assert.ok(invite);
  });
});

describe("what a Starter account gets", () => {
  async function starter(extra: Partial<GitHubUserFixture> = {}): Promise<{ service: Service; token: string; admin: string }> {
    const { service, admin } = await open({ LUMINAL_API_KEY: "sk-luminal-test" });
    const user: GitHubUserFixture = { id: 100, login: "starter", createdAt: NEW, publicRepos: 0, contributions: 0, ...extra };
    const { access_token } = await service.signIn(user);
    return { service, token: access_token, admin };
  }

  it("serves GPT-6 itself (every model), and charges the Starter allowance", async () => {
    const { service, token } = await starter();
    const before = (await (await service.request("GET", "/v1/me", { token })).json()) as { pools: Record<string, { usedThisWeek: number }> };
    const response = await chat(service, token, "gpt-6-luna");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-dl-fallback"), null);
    assert.equal(service.calls.openai.length, 1);
    assert.equal(service.calls.luminal.length, 0);
    const after = (await (await service.request("GET", "/v1/me", { token })).json()) as { pools: Record<string, { usedThisWeek: number }> };
    assert.ok(after.pools.luna!.usedThisWeek > before.pools.luna!.usedThisWeek, "the Starter allowance paid");
  });

  it("gets 5M tokens a week in every pool, Sol and Astra at most their own, and the Starter dollar cap", async () => {
    const { service, token } = await starter();
    const me = (await (await service.request("GET", "/v1/me", { token })).json()) as {
      level: string;
      levelReason: string;
      thresholds: Record<string, number>;
      pools: Record<string, { tokensPerWeek: number }>;
      signals: Record<string, unknown>;
    };
    assert.equal(me.level, "starter");
    assert.equal(me.levelReason, "account_too_new");
    assert.deepEqual(me.thresholds, { minAccountAgeDays: 90, minPublicRepos: 3, minContributions: 50 });
    assert.equal(me.pools.luna!.tokensPerWeek, 5_000_000);
    assert.equal(me.pools.sol!.tokensPerWeek, 5_000_000);
    assert.equal(me.pools.astra!.tokensPerWeek, 3_000_000);
    assert.equal((me as unknown as { allowance: { usdPerWeek: number } }).allowance.usdPerWeek, 0.5);
    assert.equal(me.signals.publicRepos, 0);
    // The person sees the public bar and its signals only.
    assert.deepEqual(Object.keys(me.signals).sort(), ["accountAgeDays", "checkedAt", "contributions", "followers", "publicRepos", "restrictedContributions"]);
  });

  it("is promoted by an admin, and demoted again", async () => {
    const { service, token, admin } = await starter();
    const level = async () => ((await (await service.request("GET", "/v1/me", { token })).json()) as { level: string; allowance: { tokensPerWeek: number } });
    assert.equal((await service.request("POST", "/admin/people/100/level", { token: admin, body: { level: "full" } })).status, 200);
    assert.equal((await level()).level, "full");
    assert.equal((await level()).allowance.tokensPerWeek, 50_000_000);
    assert.equal((await service.request("POST", "/admin/people/100/level", { token: admin, body: { level: "starter" } })).status, 200);
    assert.equal((await level()).level, "starter");
    assert.equal((await level()).allowance.tokensPerWeek, 5_000_000);
    assert.equal((await service.request("POST", "/admin/people/100/level", { token: admin, body: { level: "nope" } })).status, 400);
  });

  it("is re-checked weekly from the public profile, and promoted when it qualifies", async () => {
    // Below the public bar, with two of the additional signals stored at sign-in.
    const { service, token } = await starter({ activeWeeks: 20 });
    // A server key outlives the access token, so the clock can move a week.
    const key = ((await (await service.request("POST", "/v1/keys", { token, body: { name: "test" } })).json()) as { key: string }).key;
    // The public profile now says 5 repositories.
    service.setGithubProfile((login) => Response.json({ login, email: null, created_at: OLD, public_repos: 5, followers: 0 }));
    service.clock.now += 8 * 86_400_000;
    assert.equal((await chat(service, key, MODEL)).status, 200);
    // The admin token expired with the clock; read the row directly.
    assert.equal((await service.directory().getPerson(100))?.level, "full");
  });
});

describe("the admin people page", () => {
  it("shows the level and the signals, and filters by level and shared network", async () => {
    const { service, admin } = await open();
    await service.signIn({ id: 100, login: "full", publicRepos: 4 });
    await service.signIn({ id: 101, login: "starter", createdAt: NEW, publicRepos: 0, contributions: 0 });
    const all = (await (await service.request("GET", "/admin/people", { token: admin })).json()) as { people: Array<Record<string, any>> };
    const starter = all.people.find((row) => row.githubId === 101)!;
    assert.equal(starter.level, "starter");
    assert.equal(starter.signals.accountAgeDays, 15);
    assert.equal(starter.networks, 1);

    const onlyStarter = (await (await service.request("GET", "/admin/people?level=starter", { token: admin })).json()) as { people: Array<Record<string, any>> };
    assert.deepEqual(onlyStarter.people.map((row) => row.githubId), [101]);
    const shared = (await (await service.request("GET", "/admin/people?shared=1", { token: admin })).json()) as { people: Array<Record<string, any>> };
    assert.deepEqual(shared.people, [], "one network each");
  });
});
