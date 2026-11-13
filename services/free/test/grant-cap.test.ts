import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, createService, startBrowserFlow, type GitHubUserFixture, type Service } from "./harness.js";
import { adminCookie, tools } from "./admin-web.js";
import { parseGrantUsd } from "../src/grant.js";
import { USER_EMAILS } from "../src/user-emails.js";

/**
 * A grant (the Tools tab's "Give free tokens", POST /admin/grant, and granting a /request from
 * the Tools tab, the home screen or POST /admin/access-requests/:id/grant) sets Full and a
 * personal weekly dollar cap: the grantWeeklyUsdCap setting (default 20), or the amount the
 * admin picked. It never lowers a higher personal cap; 0 keeps the old behaviour (Full only).
 * A pre-grant's cap is set at the first sign-in.
 */

const YOUNG = "2026-06-01T00:00:00Z"; // below the age bar: Starter on its own signals
const BAR = {
  OPENAI_API_KEY: "sk-test",
  OPEN_ADMISSION: "true",
  STARTER_WEEKLY_TOKENS: "0",
  FULL_MIN_ACCOUNT_AGE_DAYS: "365",
  FULL_MIN_CONTRIBUTIONS: "100",
  FULL_MIN_PUBLIC_REPOS: "100000",
  NETWORK_SIGNUPS_PER_DAY: "1000",
  DOMAIN_SIGNUPS_PER_DAY: "1000",
  // Full's own cap is small now; a grant is what gives more.
  PER_PERSON_WEEKLY_USD_CAP: "1",
};
const GITHUB: Record<string, number> = { alice: 100, bob: 101, carol: 102 };
const starter = (id: number, extra: Partial<GitHubUserFixture> = {}): GitHubUserFixture => ({ id, login: `user${id}`, createdAt: YOUNG, publicRepos: 0, contributions: 3, ...extra });
const BUILDING = "a CLI that turns my lab's CSV exports into plots";

async function setup(vars: Record<string, string> = {}): Promise<{ s: Service; admin: string }> {
  const s = await createService({ ...BAR, ...vars });
  s.setGithubProfile((login) => {
    const id = GITHUB[login.toLowerCase()];
    return id ? Response.json({ login: login.toLowerCase(), id, type: "User", email: null }) : Response.json({ message: "Not Found" }, { status: 404 });
  });
  const admin = (await s.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  return { s, admin };
}

const grant = async (s: Service, admin: string, body: Record<string, unknown>) => {
  const response = await s.request("POST", "/v1/admin/grant", { token: admin, body });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};

/** The admin's view of one person: their allowance and personal cap. */
const person = async (s: Service, admin: string, id: number) => (await (await s.request("GET", `/admin/people/${id}`, { token: admin })).json()) as Record<string, any>;

/** A Starter person with a pending /request; returns the request id. */
async function requested(s: Service, admin: string, id = 100): Promise<number> {
  const { access_token: token } = await s.signIn(starter(id));
  assert.equal((await s.request("POST", "/v1/access-request", { token, body: { building: BUILDING } })).status, 201);
  const { requests } = (await (await s.request("GET", "/v1/admin/access-requests", { token: admin })).json()) as { requests: Array<Record<string, any>> };
  return requests.find((request) => request.githubId === id)!.id as number;
}

describe("a grant's weekly dollar cap", () => {
  it("sets Full and the grantWeeklyUsdCap setting (default 20) as the person's own weekly cap", async () => {
    const { s, admin } = await setup();
    await startBrowserFlow(s.request, { id: 100, login: "alice", createdAt: YOUNG });
    const { body } = await grant(s, admin, { logins: ["alice"] });
    assert.deepEqual(body.results, [{ input: "alice", outcome: "granted", login: "alice", githubId: 100, usdPerWeek: 20 }]);
    const view = await person(s, admin, 100);
    assert.equal(view.level, "full");
    assert.equal(view.allowance.usdPerWeek, 20);
    assert.deepEqual(view.personalCap, { tokensPerWeek: null, usdPerWeek: 20 });
  });

  it("gives already-Full people the cap too", async () => {
    const { s, admin } = await setup();
    await s.signIn({ id: 100, login: "alice" });
    assert.equal((await s.request("POST", "/admin/people/100/level", { token: admin, body: { level: "full" } })).status, 200);
    // Full, with the level's own $1.
    assert.equal((await person(s, admin, 100)).allowance.usdPerWeek, 1);
    const { body } = await grant(s, admin, { logins: ["alice"] });
    assert.equal(body.results[0].outcome, "already_full");
    assert.equal(body.results[0].usdPerWeek, 20);
    assert.equal((await person(s, admin, 100)).allowance.usdPerWeek, 20);
  });

  it("never lowers a higher personal cap, and raises a lower one", async () => {
    const { s, admin } = await setup();
    await s.signIn({ id: 100, login: "alice" });
    await s.signIn({ id: 101, login: "bob" });
    assert.equal((await s.request("POST", "/admin/people/100/grant", { token: admin, body: { usdPerWeek: 50 } })).status, 200);
    assert.equal((await s.request("POST", "/admin/people/101/grant", { token: admin, body: { usdPerWeek: 5 } })).status, 200);
    const { body } = await grant(s, admin, { logins: ["alice", "bob"] });
    assert.deepEqual(
      body.results.map((result: Record<string, unknown>) => [result.login, result.usdPerWeek]),
      [
        ["alice", 50],
        ["bob", 20],
      ],
    );
    assert.equal((await person(s, admin, 100)).allowance.usdPerWeek, 50);
    assert.equal((await person(s, admin, 101)).allowance.usdPerWeek, 20);
    // A smaller grant later doesn't take anything away either.
    await grant(s, admin, { logins: ["bob"], usdPerWeek: 3 });
    assert.equal((await person(s, admin, 101)).allowance.usdPerWeek, 20);
  });

  it("with the setting at 0 (or none), a grant only sets Full, as before", async () => {
    for (const value of [0, "none"]) {
      const { s, admin } = await setup();
      assert.equal((await s.request("POST", "/admin/config", { token: admin, body: { grantWeeklyUsdCap: value } })).status, 200);
      await startBrowserFlow(s.request, { id: 100, login: "alice", createdAt: YOUNG });
      const { body } = await grant(s, admin, { logins: ["alice", "carol"] });
      assert.deepEqual(body.results, [
        { input: "alice", outcome: "granted", login: "alice", githubId: 100 },
        { input: "carol", outcome: "pregranted", login: "carol", githubId: 102 },
      ]);
      const view = await person(s, admin, 100);
      assert.equal(view.level, "full");
      assert.equal(view.allowance.usdPerWeek, 1, "the level's own cap");
      assert.equal(view.personalCap, null);
      await startBrowserFlow(s.request, { id: 102, login: "carol", createdAt: YOUNG });
      assert.equal((await person(s, admin, 102)).allowance.usdPerWeek, 1);
    }
  });

  it("keeps a pre-grant's cap for the first sign-in, and a second pre-grant never lowers it", async () => {
    const { s, admin } = await setup();
    assert.equal((await grant(s, admin, { logins: ["carol"], usdPerWeek: 12 })).body.results[0].usdPerWeek, 12);
    assert.equal((await grant(s, admin, { logins: ["carol"], usdPerWeek: 4 })).body.results[0].usdPerWeek, 12);
    await startBrowserFlow(s.request, { id: 102, login: "carol", createdAt: YOUNG });
    const view = await person(s, admin, 102);
    assert.deepEqual([(await s.directory().getPerson(102)).level_reason, view.level], ["admin", "full"]);
    assert.equal(view.allowance.usdPerWeek, 12);
    assert.deepEqual(view.personalCap, { tokensPerWeek: null, usdPerWeek: 12 });
    // Used once: signing in again keeps it, nothing else changes.
    await startBrowserFlow(s.request, { id: 102, login: "carol", createdAt: YOUNG });
    assert.equal((await person(s, admin, 102)).allowance.usdPerWeek, 12);
  });

  it("takes a per-grant amount (0 for Full only) and refuses a bad one", async () => {
    const { s, admin } = await setup();
    await startBrowserFlow(s.request, { id: 100, login: "alice", createdAt: YOUNG });
    await startBrowserFlow(s.request, { id: 101, login: "bob", createdAt: YOUNG });
    assert.equal((await grant(s, admin, { logins: ["alice"], usdPerWeek: 3 })).body.results[0].usdPerWeek, 3);
    assert.equal((await person(s, admin, 100)).allowance.usdPerWeek, 3);
    const none = await grant(s, admin, { logins: ["bob"], usdPerWeek: 0 });
    assert.equal(none.body.results[0].outcome, "granted");
    assert.equal(none.body.results[0].usdPerWeek, undefined);
    assert.equal((await person(s, admin, 101)).personalCap, null);
    for (const bad of [-1, 1001, "20", true]) assert.equal((await grant(s, admin, { logins: ["alice"], usdPerWeek: bad })).status, 400, JSON.stringify(bad));
    assert.deepEqual([parseGrantUsd(undefined), parseGrantUsd(""), parseGrantUsd(" $7.5 "), parseGrantUsd("0"), parseGrantUsd("abc")], [undefined, undefined, 7.5, 0, "invalid"]);
  });

  it("grants an access request with the setting's cap, or the amount sent", async () => {
    const { s, admin } = await setup();
    const first = await requested(s, admin, 100);
    const answer = await s.request("POST", `/v1/admin/access-requests/${first}/grant`, { token: admin, body: {} });
    assert.equal(((await answer.json()) as Record<string, unknown>).usdPerWeek, 20);
    assert.equal((await person(s, admin, 100)).allowance.usdPerWeek, 20);
    const second = await requested(s, admin, 101);
    const small = await s.request("POST", `/v1/admin/access-requests/${second}/grant`, { token: admin, body: { usdPerWeek: 3 } });
    assert.equal(((await small.json()) as Record<string, unknown>).usdPerWeek, 3);
    assert.equal((await person(s, admin, 101)).allowance.usdPerWeek, 3);
    const third = await requested(s, admin, 102);
    assert.equal((await s.request("POST", `/v1/admin/access-requests/${third}/grant`, { token: admin, body: { usdPerWeek: "lots" } })).status, 400);
  });

  it("the Tools tab: an amount field on the grant form and on each request, and the cap shown", async () => {
    const { s, admin } = await setup();
    const cookie = await adminCookie(s);
    const page = await (await s.request("GET", "/admin?view=tools", { headers: { cookie } })).text();
    assert.match(page, /<input type="number" name="usd" min="0" max="1000" step="any" inputmode="decimal" value="20">/);
    await startBrowserFlow(s.request, { id: 100, login: "alice", createdAt: YOUNG });
    const granted = await tools(s, cookie, { tool: "grant", logins: "alice", usd: "3" });
    assert.match(granted.html, /<code>alice<\/code><span class="chip ok">granted<\/span><span class="hint">own cap \$3 a week<\/span>/);
    assert.equal((await person(s, admin, 100)).allowance.usdPerWeek, 3);
    const bad = await tools(s, cookie, { tool: "grant", logins: "alice", usd: "-2" });
    assert.match(bad.html, /The weekly dollar cap must be 0 to 1000/);

    const id = await requested(s, admin, 101);
    const listed = await (await s.request("GET", "/admin?view=tools", { headers: { cookie } })).text();
    assert.match(listed, /Weekly dollar cap for user101<\/span>\$<input type="number" name="usd"/);
    // A person with their own cap shows it on the request.
    await s.request("POST", "/admin/people/101/grant", { token: admin, body: { usdPerWeek: 2.5 } });
    assert.match(await (await s.request("GET", "/admin?view=tools", { headers: { cookie } })).text(), /dl sessions this week · own cap \$2\.50 a week/);
    const answered = await tools(s, cookie, { tool: "request", id: String(id), action: "grant", usd: "10" });
    assert.match(answered.html, /Granted: user101 is Full now with \$10 a week, and gets an email\./);
    assert.equal((await person(s, admin, 101)).allowance.usdPerWeek, 10);
  });

  it("shows the personal cap in the admin people list", async () => {
    const { s, admin } = await setup();
    await startBrowserFlow(s.request, { id: 100, login: "alice", createdAt: YOUNG });
    await startBrowserFlow(s.request, { id: 101, login: "bob", createdAt: YOUNG });
    await grant(s, admin, { logins: ["alice"], usdPerWeek: 6 });
    const { people } = (await (await s.request("GET", "/admin/people", { token: admin })).json()) as { people: Array<Record<string, any>> };
    assert.deepEqual(people.find((row) => row.githubId === 100)!.personalCap, { tokensPerWeek: null, usdPerWeek: 6 });
    assert.equal(people.find((row) => row.githubId === 101)!.personalCap, null);
  });
});

describe("the access_granted email", () => {
  it("says they get more free usage each week, with no amounts, in lowercase and without dashes", () => {
    const { subject, body } = USER_EMAILS.access_granted;
    assert.match(body, /more free usage each week/);
    assert.doesNotMatch(body, /full weekly allowance/);
    assert.doesNotMatch(body, /\$|\d[\d,.]*\s*(?:m\b|million|tokens|dollars|usd)/i, "no amounts");
    for (const text of [subject, body]) {
      assert.equal(text, text.toLowerCase());
      assert.doesNotMatch(text, /[—–]/);
    }
  });
});
