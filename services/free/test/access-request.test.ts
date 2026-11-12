import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, createService, errorCode, type GitHubUserFixture, type Service } from "./harness.js";
import { parseAccessRequest } from "../src/access-request.js";
import { adminCookie, tools } from "./admin-web.js";

/**
 * Access requests from inside dl (/request): POST and GET /v1/access-request, the owner's alert,
 * the admin's Requests section on the Tools tab (grant or decline), and the email on a grant.
 * What a person writes is user content: never logged, never in an alert.
 */

const DAY = 86_400_000;
const BAR = {
  OPENAI_API_KEY: "sk-test",
  OPEN_ADMISSION: "true",
  STARTER_WEEKLY_TOKENS: "0",
  FULL_MIN_ACCOUNT_AGE_DAYS: "365",
  FULL_MIN_CONTRIBUTIONS: "100",
  FULL_MIN_PUBLIC_REPOS: "100000",
  NETWORK_SIGNUPS_PER_DAY: "1000",
  DOMAIN_SIGNUPS_PER_DAY: "1000",
  RESEND_API_KEY: "re_test_key",
  ALERT_WEBHOOK_URL: "https://alerts.test/hook",
};
const YOUNG = "2026-06-01T00:00:00Z";
const starter = (id: number, extra: Partial<GitHubUserFixture> = {}): GitHubUserFixture => ({ id, login: `user${id}`, createdAt: YOUNG, publicRepos: 0, contributions: 3, email: `user${id}@work.example`, ...extra });
const BUILDING = "a CLI that turns my lab's CSV exports into plots";

async function open(): Promise<{ s: Service; admin: string }> {
  const s = await createService(BAR);
  const admin = (await s.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  return { s, admin };
}

const submit = async (s: Service, token: string, body: unknown) => {
  const response = await s.request("POST", "/v1/access-request", { token, body: body as Record<string, unknown> });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};
const status = async (s: Service, token: string) => (await (await s.request("GET", "/v1/access-request", { token })).json()) as Record<string, any>;
const pending = async (s: Service, admin: string) => ((await (await s.request("GET", "/v1/admin/access-requests", { token: admin })).json()) as { requests: Array<Record<string, any>> }).requests;
const decide = (s: Service, admin: string, id: number, decision: "grant" | "decline") => s.request("POST", `/v1/admin/access-requests/${id}/${decision}`, { token: admin, body: {} });

describe("POST /v1/access-request: what it takes", () => {
  it("checks building (10 to 600 characters after trimming) and an optional http(s) link of at most 300", () => {
    assert.deepEqual(parseAccessRequest({ building: `  ${BUILDING}  ` }), { ok: true, building: BUILDING, link: null });
    assert.deepEqual(parseAccessRequest({ building: BUILDING, link: " https://github.com/me/plots " }), { ok: true, building: BUILDING, link: "https://github.com/me/plots" });
    assert.deepEqual(parseAccessRequest({ building: BUILDING, link: "" }), { ok: true, building: BUILDING, link: null });
    for (const bad of [
      null,
      [],
      {},
      { building: 42 },
      { building: "   short   " },
      { building: "x".repeat(601) },
      { building: BUILDING, link: 7 },
      { building: BUILDING, link: "github.com/me" },
      { building: BUILDING, link: "javascript:alert(1)" },
      { building: BUILDING, link: "ftp://example.com/x" },
      { building: BUILDING, link: `https://example.com/${"a".repeat(300)}` },
    ]) {
      assert.equal(parseAccessRequest(bad).ok, false, JSON.stringify(bad));
    }
    assert.equal(parseAccessRequest({ building: "x".repeat(600) }).ok, true);
  });

  it("answers 400 invalid_request with a clear message, and needs a sign-in", async () => {
    const { s } = await open();
    const { access_token: token } = await s.signIn(starter(100));
    const short = await submit(s, token, { building: "hi" });
    assert.equal(short.status, 400);
    assert.equal(short.body.error.code, "invalid_request");
    assert.match(short.body.error.message, /at least 10 characters/);
    const link = await submit(s, token, { building: BUILDING, link: "not a url" });
    assert.equal(link.status, 400);
    assert.match(link.body.error.message, /http:\/\/ or https:\/\//);
    const notJson = await s.request("POST", "/v1/access-request", { token, body: "{nope" });
    assert.equal(notJson.status, 400);
    assert.equal((await s.request("POST", "/v1/access-request", { body: { building: BUILDING } })).status, 401);
    assert.equal((await s.request("GET", "/v1/access-request")).status, 401);
  });
});

describe("POST /v1/access-request", () => {
  it("stores one pending request, says so on GET, refuses a second while it waits, and alerts the owner without the content", async () => {
    const { s } = await open();
    const { access_token: token } = await s.signIn(starter(100));
    assert.deepEqual(await status(s, token), { status: "none" });
    const first = await submit(s, token, { building: BUILDING, link: "https://github.com/me/plots" });
    assert.equal(first.status, 201);
    assert.deepEqual(first.body, { status: "pending" });
    const now = await status(s, token);
    assert.equal(now.status, "pending");
    assert.equal(now.at, new Date(s.clock.now).toISOString());
    const second = await submit(s, token, { building: `${BUILDING}, again` });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, "already_pending");
    const alerts = s.calls.webhooks.map((call) => JSON.stringify(call.body)).filter((text) => text.includes("access request"));
    assert.equal(alerts.length, 1);
    assert.match(alerts[0]!, /new access request from @user100 \(1 pending\)/);
    assert.doesNotMatch(alerts[0]!, /CSV|plots|github\.com\/me/);
  });

  it("refuses admins and Full accounts that may have server keys with already_full", async () => {
    const { s, admin } = await open();
    const { access_token: dev } = await s.signIn({ id: 101, login: "dev", createdAt: "2019-01-01T00:00:00Z", publicRepos: 0, contributions: 250, activeWeeks: 30 });
    // Full on its own signals, without server keys: may ask for them.
    assert.equal((await submit(s, dev, { building: "a build server for my side project, to run dl on" })).status, 201);
    await s.request("POST", "/admin/people/101/level", { token: admin, body: { level: "full" } });
    const full = await submit(s, dev, { building: BUILDING });
    assert.equal(full.status, 409);
    assert.equal(full.body.error.code, "already_full");
    assert.equal((await submit(s, admin, { building: BUILDING })).body.error.code, "already_full");
  });

  it("takes basic accounts, and refuses blocked ones", async () => {
    const { s, admin } = await open();
    const { access_token: basic } = await s.signIn(starter(102, { createdAt: "2019-01-01T00:00:00Z" }));
    assert.equal((await submit(s, basic, { building: BUILDING })).status, 201);
    const { access_token: blocked } = await s.signIn(starter(103));
    assert.equal((await s.request("POST", "/admin/people/103/block", { token: admin })).status, 200);
    const refused = await s.request("POST", "/v1/access-request", { token: blocked, body: { building: BUILDING } });
    assert.equal(refused.status, 403);
    assert.equal(await errorCode(refused), "blocked");
  });

  it("allows 3 submissions per person a day, then 429", async () => {
    const { s, admin } = await open();
    const { access_token: token } = await s.signIn(starter(100));
    for (let i = 0; i < 3; i++) {
      assert.equal((await submit(s, token, { building: `${BUILDING} #${i}` })).status, 201);
      const [request] = await pending(s, admin);
      assert.equal((await decide(s, admin, request!.id, "decline")).status, 200);
    }
    const fourth = await submit(s, token, { building: BUILDING });
    assert.equal(fourth.status, 429);
    assert.equal(fourth.body.error.code, "rate_limited");
    s.clock.now += DAY + 1000;
    const fresh = (await s.signIn(starter(100))).access_token;
    assert.equal((await submit(s, fresh, { building: BUILDING })).status, 201);
  });
});

describe("answering access requests", () => {
  it("grants Full (reason admin) from the admin API, emails the person, and GET says granted", async () => {
    const { s } = await open();
    await s.signIn(starter(100));
    s.clock.now += DAY; // the welcome went yesterday
    const { access_token: token } = await s.signIn(starter(100));
    const admin = (await s.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    await submit(s, token, { building: BUILDING });
    const [request] = await pending(s, admin);
    assert.equal(request!.login, "user100");
    assert.equal(request!.level, "starter");
    assert.equal(request!.building, BUILDING);
    const before = s.calls.resend.length;
    const granted = await decide(s, admin, request!.id, "grant");
    assert.equal(granted.status, 200);
    assert.equal(((await granted.json()) as Record<string, unknown>).status, "granted");
    const people = ((await (await s.request("GET", "/admin/people", { token: admin })).json()) as { people: Array<Record<string, any>> }).people;
    const row = people.find((person) => person.githubId === 100)!;
    assert.equal(row.level, "full");
    assert.equal(row.levelReason, "admin");
    assert.equal((await status(s, token)).status, "granted");
    const sent = s.calls.resend.slice(before);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.headers["idempotency-key"], `dl-user-email-access_granted-100-${request!.id}`);
    assert.match(String(sent[0]!.body.text), /^hey,\n\nyou're in\. you now have the full free tier: /);
    assert.deepEqual(await pending(s, admin), []);
    // Answered once only.
    assert.equal((await decide(s, admin, request!.id, "decline")).status, 404);
    // Full now: a new request is refused.
    assert.equal((await submit(s, token, { building: BUILDING })).body.error.code, "already_full");
  });

  it("sends the grant email even on the day of the welcome", async () => {
    const { s, admin } = await open();
    const { access_token: token } = await s.signIn(starter(100));
    await submit(s, token, { building: BUILDING });
    const [request] = await pending(s, admin);
    await decide(s, admin, request!.id, "grant");
    assert.deepEqual(
      s.calls.resend.map((call) => call.headers["idempotency-key"]),
      ["dl-user-email-welcome_starter-100-once", `dl-user-email-access_granted-100-${request!.id}`],
    );
  });

  it("declines without an email, and GET says declined", async () => {
    const { s, admin } = await open();
    const { access_token: token } = await s.signIn(starter(100));
    await submit(s, token, { building: BUILDING });
    const [request] = await pending(s, admin);
    const before = s.calls.resend.length;
    assert.equal((await decide(s, admin, request!.id, "decline")).status, 200);
    assert.equal(s.calls.resend.length, before);
    assert.equal((await status(s, token)).status, "declined");
    const people = ((await (await s.request("GET", "/admin/people", { token: admin })).json()) as { people: Array<Record<string, any>> }).people;
    assert.equal(people.find((person) => person.githubId === 100)!.level, "starter");
  });

  it("lists pending requests newest first on the Tools tab, escaped, with the link as text and a nofollow link, and grants from there", async () => {
    const { s } = await open();
    const { access_token: first } = await s.signIn(starter(100));
    const { access_token: second } = await s.signIn(starter(101));
    await submit(s, first, { building: "<script>alert('x')</script> & a plotting tool", link: "https://example.com/a?b=<c>&d=\"e\"" });
    s.clock.now += 60_000;
    await submit(s, second, { building: BUILDING });
    const cookie = await adminCookie(s);
    const page = await (await s.request("GET", "/admin?view=tools", { headers: { cookie } })).text();
    assert.doesNotMatch(page, /<script>alert/);
    assert.match(page, /&lt;script&gt;alert\(&#39;x&#39;\)&lt;\/script&gt; &amp; a plotting tool/);
    assert.match(page, /<a href="https:\/\/example\.com\/a\?b=&lt;c&gt;&amp;d=&quot;e&quot;" rel="noopener noreferrer nofollow" target="_blank">https:\/\/example\.com\/a\?b=&lt;c&gt;&amp;d=&quot;e&quot;<\/a>/);
    assert.match(page, /href="https:\/\/github\.com\/user100"/);
    assert.ok(page.indexOf("@user101") < page.indexOf("@user100"), "newest first");
    assert.match(page, /Starter · \d+ days · 3 contributions · 0 dl sessions this week/);
    const id = /name="id" value="(\d+)"/.exec(page.slice(page.indexOf("@user100")))![1]!;
    const { html } = await tools(s, cookie, { tool: "request", id, action: "grant", note: "looks real" });
    assert.match(html, /Granted: user100 is Full now with \$20 a week, and gets an email\./);
    assert.doesNotMatch(html, /@user100<\/code>/);
    assert.match(html, /@user101<\/code>/);
    const declined = await tools(s, cookie, { tool: "request", id: /name="id" value="(\d+)"/.exec(html)![1]!, action: "decline" });
    assert.match(declined.html, /Declined user101&#39;s request\./);
    assert.match(declined.html, /No pending requests\./);
  });

  it("never writes what a person wrote to the logs", async () => {
    const { s, admin } = await open();
    const { access_token: token } = await s.signIn(starter(100));
    const lines: string[] = [];
    const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    for (const name of Object.keys(original) as Array<keyof typeof original>) {
      console[name] = (...args: unknown[]) => {
        lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg) ?? String(arg))).join(" "));
      };
    }
    try {
      await submit(s, token, { building: "SECRET-PROJECT-ZEBRA for my team", link: "https://zebra.example/secret-link" });
      await submit(s, token, { building: "SECRET-PROJECT-ZEBRA again" });
      await submit(s, token, { building: "SECRET", link: "https://zebra.example/too-short" });
      const [request] = await pending(s, admin);
      await decide(s, admin, request!.id, "grant");
      const cookie = await adminCookie(s);
      await s.request("GET", "/admin?view=tools", { headers: { cookie } });
    } finally {
      Object.assign(console, original);
    }
    assert.ok(lines.length > 0, "something was logged");
    const all = lines.join("\n");
    assert.doesNotMatch(all, /ZEBRA|zebra\.example|secret-link|too-short/i);
    for (const call of [...s.calls.webhooks, ...s.calls.emails]) assert.doesNotMatch(JSON.stringify(call), /ZEBRA|zebra\.example/i);
  });
});
