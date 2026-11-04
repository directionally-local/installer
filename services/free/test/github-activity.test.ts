import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, createInvite, createService, startBrowserFlow, type GitHubUserFixture, type Service } from "./harness.js";

const NO_ACTIVITY = "Your GitHub account has no public repositories or contributions yet, so it needs an invite code for the free tier.";

async function open(vars: Record<string, string> = {}): Promise<{ service: Service; admin: string }> {
  const service = await createService({ OPEN_ADMISSION: "true", ...vars });
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  return { service, admin };
}

const signedIn = (page: string) => /Signed in as/.test(page);
const askedForInvite = (page: string) => page.includes('name="invite_code"');

async function via(service: Service, admin: string, githubId: number): Promise<string | undefined> {
  const body = (await (await service.request("GET", "/admin/people", { token: admin })).json()) as { people: Array<{ githubId: number; admittedVia: string }> };
  return body.people.find((person) => person.githubId === githubId)?.admittedVia;
}

async function githubChecks(service: Service, admin: string): Promise<Record<string, number>> {
  const body = (await (await service.request("GET", "/admin/metrics", { token: admin })).json()) as { githubChecks: Record<string, number> };
  return body.githubChecks;
}

describe("the sign-up GitHub activity check", () => {
  it("lets an account with a public repository in without asking GitHub anything more", async () => {
    const { service, admin } = await open();
    const flow = await startBrowserFlow(service.request, { id: 100, login: "repos", publicRepos: 3 });
    assert.ok(signedIn(flow.page));
    assert.deepEqual(service.calls.githubGraphql, []);
    assert.equal(await via(service, admin, 100), "open");
  });

  it("lets an account with no public repository but a contribution in the last year in", async () => {
    const { service, admin } = await open();
    const flow = await startBrowserFlow(service.request, { id: 100, login: "contrib", publicRepos: 0, contributions: 4 });
    assert.ok(signedIn(flow.page));
    assert.deepEqual(service.calls.githubGraphql, ["contrib"]);
    assert.equal(await via(service, admin, 100), "open");
    assert.deepEqual(await githubChecks(service, admin), { contributions: 1, none: 0, error: 0 });
  });

  it("sends an account with neither to the invite step, says why, and lets it in with an invite", async () => {
    const { service, admin } = await open();
    const user: GitHubUserFixture = { id: 100, login: "empty", publicRepos: 0, contributions: 0 };
    const flow = await startBrowserFlow(service.request, user);
    assert.equal(flow.status, 200);
    assert.ok(askedForInvite(flow.page));
    assert.ok(flow.page.includes("Your GitHub account has no public repositories or contributions yet, so it needs an invite code for the free tier: enter your invite code."));

    // Without a code: the page and the terminal say the same thing.
    const ticket = /name="ticket" value="([^"]+)"/.exec(flow.page)![1]!;
    const page = await (await service.request("POST", "/device/no-invite", { form: { ticket } })).text();
    const body = (await (await service.request("POST", "/v1/device/token", { body: { device_code: flow.deviceCode } })).json()) as { error: { code: string; reason: string; message: string } };
    assert.equal(body.error.code, "no_github_activity");
    assert.equal(body.error.reason, "no_github_activity");
    assert.equal(body.error.message, `${NO_ACTIVITY} Ask a friend for an invite code, then run sign-in again and enter it on the sign-in page.`);
    assert.ok(page.includes(body.error.message));

    // With a code: in, as an invite.
    const again = await startBrowserFlow(service.request, user);
    assert.ok(askedForInvite(again.page));
    const ticket2 = /name="ticket" value="([^"]+)"/.exec(again.page)![1]!;
    const blank = await (await service.request("POST", "/device/invite", { form: { ticket: ticket2, invite_code: "" } })).text();
    assert.ok(blank.includes("no public repositories or contributions yet"), "the intro is kept when the code is missing");
    const joined = await (await service.request("POST", "/device/invite", { form: { ticket: ticket2, invite_code: await createInvite(service, admin) } })).text();
    assert.ok(signedIn(joined));
    assert.match((await via(service, admin, 100)) ?? "", /^invite:/);
    assert.deepEqual(await githubChecks(service, admin), { contributions: 0, none: 2, error: 0 });
  });

  for (const failure of ["error", "throw"] as const) {
    it(`lets the person in when GitHub's API fails (${failure}), and counts it`, async () => {
      const { service, admin } = await open();
      const flow = await startBrowserFlow(service.request, { id: 100, login: "unlucky", publicRepos: 0, contributions: failure });
      assert.ok(signedIn(flow.page));
      assert.equal(await via(service, admin, 100), "open");
      assert.deepEqual(await githubChecks(service, admin), { contributions: 0, none: 0, error: 1 });
    });
  }

  it("alerts once a day when GitHub errors let five sign-ups through", async () => {
    const { service } = await open({ ALERT_WEBHOOK_URL: "https://alerts.test/hook" });
    for (let i = 0; i < 6; i++) {
      // Different networks, so the per-network sign-up limit doesn't get in the way.
      const request: Service["request"] = (method, path, options = {}) => service.request(method, path, { ...options, ip: `198.51.100.${i + 1}` });
      assert.ok(signedIn((await startBrowserFlow(request, { id: 100 + i, login: `u${i}`, publicRepos: 0, contributions: "error" })).page));
    }
    const alerts = service.calls.webhooks.filter((call) => String(call.body.text).includes("activity check"));
    assert.equal(alerts.length, 1);
    assert.match(String(alerts[0]!.body.text), /didn't answer the sign-up activity check 5 times today/);
  });

  it("doesn't check when requireGithubActivity is off (env or admin override)", async () => {
    const env = await open({ REQUIRE_GITHUB_ACTIVITY: "false" });
    assert.ok(signedIn((await startBrowserFlow(env.service.request, { id: 100, login: "empty", publicRepos: 0, contributions: 0 })).page));
    assert.deepEqual(env.service.calls.githubGraphql, []);

    const { service, admin } = await open();
    const set = await service.request("POST", "/admin/config", { token: admin, body: { requireGithubActivity: false } });
    assert.equal(set.status, 200);
    assert.equal(((await set.json()) as { effective: Record<string, unknown> }).effective.requireGithubActivity, false);
    assert.ok(signedIn((await startBrowserFlow(service.request, { id: 100, login: "empty", publicRepos: 0, contributions: 0 })).page));
    assert.deepEqual(service.calls.githubGraphql, []);

    await service.request("POST", "/admin/config", { token: admin, body: { requireGithubActivity: true } });
    assert.ok(askedForInvite((await startBrowserFlow(service.request, { id: 101, login: "empty2", publicRepos: 0, contributions: 0 })).page));
  });

  it("doesn't check admins", async () => {
    const service = await createService({ OPEN_ADMISSION: "true" });
    const flow = await startBrowserFlow(service.request, { id: ADMIN_ID, login: "owner", publicRepos: 0, contributions: 0 });
    assert.ok(signedIn(flow.page));
    assert.deepEqual(service.calls.githubGraphql, []);
  });

  it("never re-checks people already admitted", async () => {
    const { service, admin } = await open();
    assert.ok(signedIn((await startBrowserFlow(service.request, { id: 100, login: "old", publicRepos: 2 })).page));
    // Later the account has nothing public; they still sign in, and GitHub isn't asked.
    assert.ok(signedIn((await startBrowserFlow(service.request, { id: 100, login: "old", publicRepos: 0, contributions: 0 })).page));
    assert.deepEqual(service.calls.githubGraphql, []);
    assert.equal(await via(service, admin, 100), "open");
  });

  it("asks a too-new account for an invite as before, without asking GitHub about activity", async () => {
    const { service } = await open();
    const flow = await startBrowserFlow(service.request, { id: 100, login: "fresh", createdAt: "2026-10-20T00:00:00Z", publicRepos: 0, contributions: 0 });
    assert.match(flow.page, /less than 30 days old/);
    assert.deepEqual(service.calls.githubGraphql, []);
  });

  it("shows the setting on the admin dashboard", async () => {
    const { service, admin } = await open();
    const csv = await service.request("GET", "/admin/dashboard/spend.csv", { token: admin });
    assert.equal(csv.status, 200);
    assert.match(await csv.text(), /,require_github_activity\r\n.*,true\r\n$/s);
    const page = await (await service.request("GET", "/admin", { token: admin })).text();
    assert.match(page, /GitHub activity check: on/);
  });
});
