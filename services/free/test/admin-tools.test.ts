import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, createService, NOW, startBrowserFlow, type Service } from "./harness.js";
import { cleanLogin, parseLogins } from "../src/grant.js";

/**
 * The dashboard's Tools tab: giving free tokens by GitHub username (POST /v1/admin/grant and the
 * tab's form), pre-grants used at the first sign-up, and writing an email to users from the tab
 * (test, preview, the in-page confirm, send and send the rest).
 */

const DAY = 86_400_000;
const YOUNG = "2026-06-01T00:00:00Z"; // below the age bar: Starter on its own signals
// The public bar as it is run, with no Starter allowance (see account-signals.test.ts).
const BAR = {
  OPENAI_API_KEY: "sk-test",
  OPEN_ADMISSION: "true",
  STARTER_WEEKLY_TOKENS: "0",
  FULL_MIN_ACCOUNT_AGE_DAYS: "365",
  FULL_MIN_CONTRIBUTIONS: "100",
  FULL_MIN_PUBLIC_REPOS: "100000",
  NETWORK_SIGNUPS_PER_DAY: "1000",
  DOMAIN_SIGNUPS_PER_DAY: "1000",
};

/** GitHub's public users endpoint: these logins exist (any case), everything else is a 404. */
const GITHUB: Record<string, number> = { alice: 100, bob: 101, carol: 102, dave: 103, erin: 104 };

async function setup(vars: Record<string, string> = BAR, options: { userEmail?: boolean } = {}): Promise<{ s: Service; admin: string }> {
  const s = await createService(vars, options);
  s.setGithubProfile((login) => {
    const id = GITHUB[login.toLowerCase()];
    return id ? Response.json({ login: login.toLowerCase(), id, type: "User", email: null }) : Response.json({ message: "Not Found" }, { status: 404 });
  });
  const admin = (await s.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  return { s, admin };
}

const grant = async (s: Service, token: string, logins: unknown) => {
  const response = await s.request("POST", "/v1/admin/grant", { token, body: { logins } });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};

/** The dashboard's browser session for the admin. */
async function adminCookie(s: Service): Promise<string> {
  const start = await s.request("GET", "/admin/signin");
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const oauthCookie = start.headers.get("set-cookie")!.split(";")[0]!;
  const response = await s.request("GET", `/device/callback?code=${encodeURIComponent(JSON.stringify({ id: ADMIN_ID, login: "owner" }))}&state=${encodeURIComponent(state)}`, {
    headers: { cookie: oauthCookie },
  });
  return response.headers.getSetCookie().find((cookie) => cookie.startsWith("__Host-dl_admin="))!.split(";")[0]!;
}

const csrfOf = (html: string) => /name="csrf" value="([0-9a-f]{64})"/.exec(html)![1]!;
const confirmOf = (html: string) => /name="confirm" value="([0-9a-f]{64})"/.exec(html)?.[1];

/** The Tools tab's form, posted the way a browser on the page posts it. */
async function tools(s: Service, cookie: string, form: Record<string, string>): Promise<{ status: number; html: string }> {
  const page = await (await s.request("GET", "/admin?view=tools", { headers: { cookie } })).text();
  const response = await s.request("POST", "/admin/dashboard/tools", { headers: { cookie, origin: "https://free.test" }, form: { csrf: csrfOf(page), ...form } });
  return { status: response.status, html: await response.text() };
}

describe("reading pasted GitHub usernames", () => {
  it("splits on spaces, commas and new lines, accepts @ and github.com links, and keeps each once", () => {
    assert.deepEqual(parseLogins("alice, @bob\nhttps://github.com/Carol/\n  github.com/dave?tab=repos www.github.com/erin ALICE,,"), {
      logins: ["alice", "bob", "Carol", "dave", "erin"],
      invalid: [],
    });
    assert.deepEqual(parseLogins("ok-name -bad bad- a--b x_y " + "z".repeat(40)), { logins: ["ok-name"], invalid: ["-bad", "bad-", "a--b", "x_y", "z".repeat(40)] });
    assert.deepEqual(parseLogins("  \n , "), { logins: [], invalid: [] });
    assert.equal(cleanLogin("@@octocat"), "octocat");
    assert.equal(cleanLogin("http://github.com/octocat/hello-world"), "octocat");
  });
});

describe("POST /v1/admin/grant", () => {
  it("raises an existing Starter account to Full with reason admin, looked up by id through GitHub's public API", async () => {
    const { s, admin } = await setup();
    await startBrowserFlow(s.request, { id: 100, login: "alice", createdAt: YOUNG });
    assert.equal((await s.directory().getPerson(100)).level, "starter");
    const before = s.calls.githubProfiles.length;
    const { status, body } = await grant(s, admin, ["@Alice"]);
    assert.equal(status, 200);
    assert.deepEqual(body.results, [{ input: "Alice", outcome: "granted", login: "alice", githubId: 100 }]);
    const lookup = s.calls.githubProfiles.slice(before);
    assert.deepEqual(lookup.map((call) => call.login), ["Alice"]);
    assert.equal(lookup[0]!.headers["user-agent"], "directionallylocal-free");
    // With the OAuth app's credentials, so the lookup gets the app's rate limit, not a shared IP's.
    assert.equal(lookup[0]!.headers.authorization, `Basic ${btoa("gh-client:gh-secret")}`);
    const person = await s.directory().getPerson(100);
    assert.deepEqual([person.level, person.level_reason], ["full", "admin"]);
    // The admin's choice stands at the next sign-in.
    await startBrowserFlow(s.request, { id: 100, login: "alice", createdAt: YOUNG });
    assert.equal((await s.directory().getPerson(100)).level, "full");
    // And a second grant says so.
    assert.equal((await grant(s, admin, ["alice"])).body.results[0].outcome, "already_full");
  });

  it("never changes a blocked account", async () => {
    const { s, admin } = await setup();
    await startBrowserFlow(s.request, { id: 101, login: "bob", createdAt: YOUNG });
    assert.equal((await s.request("POST", "/admin/people/101/block", { token: admin })).status, 200);
    const { body } = await grant(s, admin, ["bob"]);
    assert.equal(body.results[0].outcome, "blocked");
    const person = await s.directory().getPerson(101);
    assert.deepEqual([person.status, person.level], ["blocked", "starter"]);
  });

  it("pre-grants someone who hasn't signed up: Full with reason admin at the first sign-up, used once", async () => {
    const { s, admin } = await setup();
    const { body } = await grant(s, admin, ["carol"]);
    assert.deepEqual(body.results, [{ input: "carol", outcome: "pregranted", login: "carol", githubId: 102 }]);
    assert.equal(await s.directory().getPerson(102), undefined);
    // Below the bar on its own signals, so the details step would offer the Starter invite field: it doesn't.
    const flow = await startBrowserFlow(s.request, { id: 102, login: "carol", createdAt: YOUNG }, undefined, { stopAtDetails: true });
    assert.doesNotMatch(flow.page, /name="invite_code"/);
    const done = await startBrowserFlow(s.request, { id: 102, login: "carol", createdAt: YOUNG });
    assert.match(done.page, /Signed in as carol/);
    const person = await s.directory().getPerson(102);
    assert.deepEqual([person.level, person.level_reason, person.status], ["full", "admin", "active"]);
    const row = s.namespaces.DIRECTORY!.instances.get("directory")!.state.db.prepare("SELECT used_at FROM pregrants WHERE github_id = 102").get() as { used_at: number | null };
    assert.notEqual(row.used_at, null);
    assert.equal(await s.directory().hasPregrant(102), false);
  });

  it("lets a pre-granted account in while admission is invite-only", async () => {
    const { s, admin } = await setup({ ...BAR, OPEN_ADMISSION: "false" });
    await grant(s, admin, ["dave"]);
    const done = await startBrowserFlow(s.request, { id: 103, login: "dave" });
    assert.match(done.page, /Signed in as dave/);
    assert.equal((await s.directory().getPerson(103)).level, "full");
    // Someone else still needs an invite.
    const other = await startBrowserFlow(s.request, { id: 104, login: "erin" });
    assert.doesNotMatch(other.page, /Signed in as erin/);
  });

  it("reports unknown and invalid usernames, and GitHub not answering, without changing anything", async () => {
    const { s, admin } = await setup();
    const { body } = await grant(s, admin, ["nobody-here", "not_valid", "alice"]);
    assert.deepEqual(
      body.results.map((r: Record<string, unknown>) => [r.input, r.outcome]),
      [
        ["nobody-here", "not_found"],
        ["alice", "pregranted"],
        ["not_valid", "not_found"],
      ],
    );
    s.setGithubProfile(() => new Response("rate limited", { status: 403 }));
    assert.equal((await grant(s, admin, ["bob"])).body.results[0].outcome, "github_error");
    assert.equal(await s.directory().hasPregrant(101), false);
  });

  it("is for admins only and checks its input", async () => {
    const { s, admin } = await setup();
    await startBrowserFlow(s.request, { id: 100, login: "alice", createdAt: YOUNG });
    const user = (await s.signIn({ id: 101, login: "bob" })).access_token;
    assert.equal((await grant(s, user, ["alice"])).status, 403);
    assert.equal((await s.request("POST", "/v1/admin/grant", { body: { logins: ["alice"] } })).status, 401);
    assert.equal((await s.directory().getPerson(100)).level, "starter");
    assert.equal((await grant(s, admin, [])).status, 400);
    assert.equal((await grant(s, admin, "alice")).status, 400);
    assert.equal((await grant(s, admin, Array.from({ length: 51 }, (_, i) => `user${i}`))).status, 400);
  });
});

describe("the dashboard's Tools tab", () => {
  it("is a third tab, admin-only, with both tools", async () => {
    const { s } = await setup();
    const cookie = await adminCookie(s);
    const response = await s.request("GET", "/admin?view=tools", { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy")!, /default-src 'none'/);
    const html = await response.text();
    assert.match(html, /<a href="\/admin\?view=tools" aria-current="page">Tools<\/a>/);
    assert.match(html, /<h2>Give free tokens<\/h2>/);
    assert.match(html, /<h2>Write an email<\/h2>/);
    assert.doesNotMatch(html, /<script/);
    assert.equal((await s.request("GET", "/admin?view=tools")).status, 401);
    const page = await (await s.request("GET", "/admin?view=tools", { headers: { cookie } })).text();
    const forged = await s.request("POST", "/admin/dashboard/tools", { headers: { cookie, origin: "https://evil.example" }, form: { csrf: csrfOf(page), tool: "grant", logins: "alice" } });
    assert.equal(forged.status, 403);
    const noToken = await s.request("POST", "/admin/dashboard/tools", { headers: { cookie, origin: "https://free.test" }, form: { tool: "grant", logins: "alice" } });
    assert.equal(noToken.status, 403);
    assert.equal(await s.directory().hasPregrant(100), false);
  });

  it("gives free tokens to pasted usernames and lists each result", async () => {
    const { s, admin } = await setup();
    await startBrowserFlow(s.request, { id: 100, login: "alice", createdAt: YOUNG });
    await startBrowserFlow(s.request, { id: 101, login: "bob", createdAt: YOUNG });
    await s.request("POST", "/admin/people/101/block", { token: admin });
    const cookie = await adminCookie(s);
    const { status, html } = await tools(s, cookie, { tool: "grant", logins: "@alice, bob\ngithub.com/carol ghost" });
    assert.equal(status, 200);
    assert.match(html, /<code>alice<\/code><span class="chip ok">granted<\/span>/);
    assert.match(html, /<code>bob<\/code><span class="chip no">blocked \(not changed\)<\/span>/);
    assert.match(html, /<code>carol<\/code><span class="chip ok">not signed up yet \(pre-granted\)<\/span>/);
    assert.match(html, /<code>ghost<\/code><span class="chip no">not a GitHub user<\/span>/);
    assert.equal((await s.directory().getPerson(100)).level, "full");
  });

  describe("writing an email", () => {
    /** People on two sign-up days, with emails; the admin has an email too. */
    async function people(): Promise<{ s: Service; cookie: string }> {
      const { s } = await setup({ OPEN_ADMISSION: "true", NETWORK_SIGNUPS_PER_DAY: "1000", DOMAIN_SIGNUPS_PER_DAY: "1000" }, { userEmail: true });
      s.clock.now = NOW - 2 * DAY;
      await startBrowserFlow(s.request, { id: 100, login: "alice" });
      await startBrowserFlow(s.request, { id: 101, login: "bob" });
      s.clock.now = NOW - DAY;
      await startBrowserFlow(s.request, { id: 102, login: "carol" });
      s.clock.now = NOW + DAY; // nobody had an email today
      s.calls.userEmail.length = 0;
      return { s, cookie: await adminCookie(s) };
    }
    const COPY = { tool: "email", subject: "a quick check-in", text: "hey,\r\n\r\nhow is dl going with GPT-6?\r\n\r\nsina", audience: "all" };

    it("lists sign-up days with reachable people, and a day fills the range", async () => {
      const { s, cookie } = await people();
      const page = await (await s.request("GET", "/admin?view=tools", { headers: { cookie } })).text();
      assert.match(page, /value="pick:2026-11-02"[^>]*><b>Mon Nov 2<\/b><small>2 full · 0 basic · 0 starter<\/small>/);
      assert.match(page, /value="pick:2026-11-03"[^>]*><b>Tue Nov 3<\/b><small>1 full · 0 basic · 0 starter<\/small>/);
      const { html } = await tools(s, cookie, { ...COPY, action: "pick:2026-11-02" });
      assert.match(html, /name="from" value="2026-11-02"/);
      assert.match(html, /name="to" value="2026-11-02"/);
      assert.match(html, /value="pick:2026-11-02" aria-pressed="true"/);
      // What was typed comes back as typed.
      assert.match(html, /<textarea class="letter" name="text" rows="12">\nhey,\n\nhow is dl going with GPT-6\?\n\nsina<\/textarea>/);
      assert.match(html, /Has capitals/);
    });

    it("sends a test with the typed subject and text to the admin's own address", async () => {
      const { s, cookie } = await people();
      const { html } = await tools(s, cookie, { ...COPY, action: "test" });
      assert.match(html, /Test sent to owner\.1@example\.com/);
      assert.equal(s.calls.userEmail.length, 1);
      const message = s.calls.userEmail[0]!;
      assert.equal(message.to, "owner.1@example.com");
      assert.equal(message.subject, "a quick check-in");
      assert.match(String(message.text), /^hey,\n\nhow is dl going with GPT-6\?\n\nsina\n\n/);
      assert.equal(message.html, undefined);
      // Or to a typed address.
      await tools(s, cookie, { ...COPY, action: "test", test_to: "me@example.org" });
      assert.equal(s.calls.userEmail[1]!.to, "me@example.org");
    });

    it("previews the count and samples, confirms in the page, sends, and sends the rest without sending twice", async () => {
      const { s, cookie } = await people();
      const preview = await tools(s, cookie, { ...COPY, action: "preview" });
      assert.match(preview.html, /<span class="big2">3<\/span> people get it now\. For example alice, bob, carol\./);
      const day = await tools(s, cookie, { ...COPY, from: "2026-11-02", to: "2026-11-02", action: "preview" });
      assert.match(day.html, /<span class="big2">2<\/span> people get it now/);

      const confirm = await tools(s, cookie, { ...COPY, action: "confirm" });
      assert.match(confirm.html, /Send this to 3 people now\?/);
      assert.match(confirm.html, /value="send">Yes, send to 3 people<\/button>/);
      assert.equal(s.calls.userEmail.length, 0, "nothing sent before the confirm");
      const token = confirmOf(confirm.html)!;

      // A send without the token, or after the text changed, only counts and asks again.
      const changed = await tools(s, cookie, { ...COPY, text: "something else", confirm: token, action: "send" });
      assert.match(changed.html, /changed since the count/);
      assert.equal(s.calls.userEmail.length, 0);

      // The provider stops the batch after one: the rest stays for "send the rest".
      let calls = 0;
      s.setUserEmail(() => {
        calls++;
        if (calls === 2) throw Object.assign(new Error("slow down"), { code: "E_RATE_LIMIT_EXCEEDED" });
        return { messageId: `m${calls}` };
      });
      const first = await tools(s, cookie, { ...COPY, confirm: token, action: "send" });
      assert.match(first.html, /<dt>Sent<\/dt><dd>1<\/dd>/);
      assert.match(first.html, /<dt>Remaining<\/dt><dd>2<\/dd>/);
      assert.match(first.html, /<dt>Failed<\/dt><dd>1<\/dd>/);
      assert.match(first.html, /value="send">Send the rest \(2\)<\/button>/);
      const again = confirmOf(first.html)!;
      s.setUserEmail(() => ({ messageId: "ok" }));
      const rest = await tools(s, cookie, { ...COPY, confirm: again, action: "send" });
      assert.match(rest.html, /<dt>Sent<\/dt><dd>2<\/dd>/);
      assert.match(rest.html, /<dt>Remaining<\/dt><dd>0<\/dd>/);
      assert.doesNotMatch(rest.html, /Send the rest/);
      // Four tries in all: the refused one, then bob again and carol.
      assert.deepEqual(s.calls.userEmail.map((message) => message.to), ["alice.100@example.com", "bob.101@example.com", "bob.101@example.com", "carol.102@example.com"]);
      // Once more: nobody left.
      const done = await tools(s, cookie, { ...COPY, confirm: again, action: "send" });
      assert.match(done.html, /<dt>Sent<\/dt><dd>0<\/dd>/);
      assert.equal(s.calls.userEmail.length, 4);
    });

    it("refuses em dashes with a message and sends nothing", async () => {
      const { s, cookie } = await people();
      const { html } = await tools(s, cookie, { ...COPY, text: "hey — there", action: "confirm" });
      assert.match(html, /class="msg err" role="alert">The text has an em or en dash/);
      assert.doesNotMatch(html, /Send this to/);
      const test = await tools(s, cookie, { ...COPY, subject: "a – b", action: "test" });
      assert.match(test.html, /The subject has an em or en dash/);
      assert.equal(s.calls.userEmail.length, 0);
    });
  });
});
