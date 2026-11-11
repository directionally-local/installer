import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, createService, errorCode, MODEL, startBrowserFlow, type GitHubUserFixture, type Service } from "./harness.js";
import { basicLine, belowBarLine, limitLine, starterLine } from "../src/admission.js";
import { adminCookie, tools } from "./admin-web.js";

/**
 * The levels below the public bar: basic (an older account outside a creation batch: every model
 * on a smaller allowance), Starter (every model on a small allowance, or none), and a Starter
 * account flagged by the creation-batch check (no free tokens at all). Also the admin's
 * "re-check below-bar accounts" and what each level is told.
 */

const DAY = 86_400_000;
// The public bar as it is run: 1 year old with 100 contributions (the repos path off).
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
const OLD = "2019-01-01T00:00:00Z";
const YOUNG = "2026-06-01T00:00:00Z";
/** Below the public bar (few contributions) with nothing else: basic when old, Starter when young. */
const belowBar = (id: number, createdAt: string, extra: Partial<GitHubUserFixture> = {}): GitHubUserFixture => ({ id, login: `user${id}`, createdAt, publicRepos: 0, contributions: 10, social: 0, ...extra });
const body = (model = MODEL) => ({ model, messages: [{ role: "user", content: "hi" }] });

async function open(vars: Record<string, string> = {}): Promise<{ service: Service; admin: string }> {
  const service = await createService({ ...BAR, ...vars });
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  return { service, admin };
}

async function me(service: Service, token: string): Promise<Record<string, any>> {
  return (await (await service.request("GET", "/v1/me", { token })).json()) as Record<string, any>;
}

const chat = (service: Service, token: string, model = MODEL) => service.request("POST", "/v1/chat/completions", { token, body: body(model) });

/** A creation day `days` before the service's clock, as GitHub gives it. */
const daysAgo = (service: Service, days: number) => new Date(service.clock.now - days * DAY).toISOString();

/**
 * Fifteen accounts created within a day of each other, already signed up: the next one like them
 * is in a batch when it is younger than the public bar's age.
 */
async function batch(service: Service, day: string): Promise<void> {
  for (let id = 300; id < 315; id++) await service.signIn(belowBar(id, day));
}

// Words that would give away the private checks or the basic level's rule.
const HIDDEN = /follow|batch|signal|creat|oldest|fork|review|pull request|days old|year old with no/i;

describe("the basic level", () => {
  it("gives an older account below the bar every model on the basic allowance", async () => {
    const { service } = await open();
    const { access_token: token } = await service.signIn(belowBar(100, OLD));
    const mine = await me(service, token);
    assert.equal(mine.level, "basic");
    assert.equal(mine.allowance.tokensPerWeek, 10_000_000);
    assert.equal(mine.allowance.usdPerWeek, 3);
    assert.equal(mine.pools.sol.tokensPerWeek, 10_000_000);
    assert.equal(mine.pools.astra.tokensPerWeek, 3_000_000);
    const response = await chat(service, token, "gpt-6-luna");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-dl-fallback"), null, "GPT-6 itself, no fallback");
    assert.equal(service.calls.openai.length, 1);
  });

  it("keeps a young account, and a batch-flagged one old enough for basic, on Starter; an established account from a busy day isn't flagged", async () => {
    const { service, admin } = await open({ BASIC_MIN_ACCOUNT_AGE_DAYS: "180" });
    await service.signIn(belowBar(100, YOUNG));
    const day = daysAgo(service, 200);
    await batch(service, day);
    await service.signIn(belowBar(101, day, { followers: 11, outsideCommits: 1, social: 30 }));
    for (let id = 400; id < 415; id++) await service.signIn(belowBar(id, OLD));
    await service.signIn(belowBar(102, OLD));
    const people = ((await (await service.request("GET", "/admin/people", { token: admin })).json()) as { people: Array<Record<string, any>> }).people;
    const level = (id: number) => people.find((row) => row.githubId === id)?.level;
    assert.equal(level(100), "starter");
    assert.equal(level(101), "starter", "old enough for basic, but in a creation batch, followers or not");
    // Older than the public bar's age: never in a batch (its level here is the network cap's business).
    const established = people.find((row) => row.githubId === 102)!;
    assert.equal(established.checks.batchPeers, 15);
    assert.equal(established.checks.creationBatch, false);
  });

  it("is off with basicWeeklyTokens 0: the same account is Starter and refused like today", async () => {
    const { service } = await open({ BASIC_WEEKLY_TOKENS: "0" });
    const { access_token: token } = await service.signIn(belowBar(100, OLD));
    assert.equal((await me(service, token)).level, "starter");
    const response = await chat(service, token);
    assert.equal(response.status, 403);
    assert.equal(await errorCode(response), "below_bar");
  });

  it("is served as Starter when the setting goes to 0 after sign-up, and as basic again when it comes back", async () => {
    const { service, admin } = await open();
    const { access_token: token } = await service.signIn(belowBar(100, OLD));
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { basicWeeklyTokens: 0 } })).status, 200);
    assert.equal(await errorCode(await chat(service, token)), "below_bar");
    assert.equal((await me(service, token)).level, "starter");
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { basicWeeklyTokens: null } })).status, 200);
    assert.equal((await chat(service, token)).status, 200);
  });

  it("answers basic_limit when the week is used up: what it gets, Monday, /request and /provider", async () => {
    const { service } = await open({ BASIC_WEEKLY_TOKENS: "100" });
    const { access_token: token } = await service.signIn(belowBar(100, OLD));
    const response = await chat(service, token);
    assert.equal(response.status, 402);
    const error = ((await response.json()) as { error: Record<string, any> }).error;
    assert.equal(error.code, "basic_limit");
    assert.equal(error.request, "/v1/access-request");
    assert.equal(
      error.message,
      "You've used this week's free Basic allowance (100 tokens a week of every model, GPT-6 included, up to $3). It resets on Monday. Need more? Type /request in dl and tell us what you're building, or use your own API key with /provider.",
    );
    assert.doesNotMatch(error.message, HIDDEN);
  });

  it("shows the basic line and the invite field on the sign-in page, and never the rule", async () => {
    const { service } = await open();
    const flow = await startBrowserFlow(service.request, belowBar(100, OLD), undefined, { stopAtDetails: true });
    assert.match(flow.page, /Basic access: a smaller free allowance, 10M tokens a week of every model, GPT-6 included, up to \$3\. It resets every Monday\. Want more\? Type \/request in dl/);
    assert.match(flow.page, /name="invite_code"/);
    const line = /Basic access:[^<]*/.exec(flow.page)![0];
    assert.doesNotMatch(line, HIDDEN);
    assert.doesNotMatch(line, /365|year/);
  });

  it("is never given to an admin-set or invited level, and Full stays Full", async () => {
    const { service, admin } = await open({ BASIC_WEEKLY_TOKENS: "0" });
    await service.signIn(belowBar(100, OLD));
    await service.signIn({ id: 101, login: "dev", createdAt: OLD, publicRepos: 0, contributions: 250, activeWeeks: 30 });
    assert.equal((await service.request("POST", "/admin/people/100/level", { token: admin, body: { level: "starter" } })).status, 200);
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { basicWeeklyTokens: 10_000_000 } })).status, 200);
    const outcome = (await (await service.request("POST", "/v1/admin/recheck-below-bar", { token: admin })).json()) as Record<string, number>;
    assert.deepEqual(outcome, { checked: 0, raised: 0, flagged: 0, starter: 0 });
    const people = ((await (await service.request("GET", "/admin/people", { token: admin })).json()) as { people: Array<Record<string, any>> }).people;
    assert.equal(people.find((row) => row.githubId === 100)?.level, "starter");
    assert.equal(people.find((row) => row.githubId === 100)?.levelReason, "admin");
    assert.equal(people.find((row) => row.githubId === 101)?.level, "full");
  });

  it("re-checks admin-set Starter levels only when asked, and hands raised ones back to the rules", async () => {
    const { service, admin } = await open({ BASIC_WEEKLY_TOKENS: "0" });
    await service.signIn(belowBar(100, OLD));
    await service.signIn(belowBar(102, YOUNG));
    await service.signIn({ id: 101, login: "dev", createdAt: OLD, publicRepos: 0, contributions: 3 });
    for (const id of [100, 102]) assert.equal((await service.request("POST", `/admin/people/${id}/level`, { token: admin, body: { level: "starter" } })).status, 200);
    assert.equal((await service.request("POST", "/admin/people/101/level", { token: admin, body: { level: "full" } })).status, 200);
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { basicWeeklyTokens: 10_000_000 } })).status, 200);
    const outcome = (await (await service.request("POST", "/v1/admin/recheck-below-bar", { token: admin, body: { includeAdminStarters: true } })).json()) as Record<string, number>;
    assert.equal(outcome.raised, 1);
    const people = ((await (await service.request("GET", "/admin/people", { token: admin })).json()) as { people: Array<Record<string, any>> }).people;
    const row = (id: number) => people.find((person) => person.githubId === id)!;
    assert.equal(row(100).level, "basic");
    assert.equal(row(100).levelReason, null, "back to the automatic rules");
    assert.equal(row(102).level, "starter", "too young for basic");
    assert.equal(row(101).level, "full", "an admin grant of Full is never touched");
    assert.equal(row(101).levelReason, "admin");
  });
});

describe("the Starter allowance", () => {
  it("serves every model until the token cap, then answers starter_limit", async () => {
    const { service } = await open({ STARTER_WEEKLY_TOKENS: "2000000", BASIC_WEEKLY_TOKENS: "0" });
    const { access_token: token } = await service.signIn(belowBar(100, YOUNG));
    const mine = await me(service, token);
    assert.equal(mine.level, "starter");
    assert.equal(mine.allowance.tokensPerWeek, 2_000_000);
    assert.equal(mine.allowance.usdPerWeek, 0.5);
    const response = await chat(service, token, "gpt-6-luna");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-dl-fallback"), null);
    // The token cap: the next week's allowance is too small for a request.
    const small = await open({ STARTER_WEEKLY_TOKENS: "100", BASIC_WEEKLY_TOKENS: "0" });
    const { access_token: other } = await small.service.signIn(belowBar(101, YOUNG));
    const refused = await chat(small.service, other);
    assert.equal(refused.status, 402);
    const error = ((await refused.json()) as { error: Record<string, any> }).error;
    assert.equal(error.code, "starter_limit");
    assert.equal(error.reason, "tokens");
    assert.equal(error.request, "/v1/access-request");
    assert.match(error.message, /^You've used this week's free Starter allowance \(100 tokens a week of every model, GPT-6 included, up to \$0\.50\)\. It resets on Monday\./);
  });

  it("stops at the Starter dollar cap", async () => {
    const { service } = await open({ STARTER_WEEKLY_TOKENS: "2000000", STARTER_WEEKLY_USD_CAP: "0.000001", BASIC_WEEKLY_TOKENS: "0" });
    const { access_token: token } = await service.signIn(belowBar(100, YOUNG));
    assert.equal((await chat(service, token)).status, 200);
    const refused = await chat(service, token);
    assert.equal(refused.status, 402);
    const error = ((await refused.json()) as { error: Record<string, any> }).error;
    assert.equal(error.code, "starter_limit");
    assert.equal(error.reason, "spend");
  });

  it("gives a batch-flagged account nothing, with the usual below_bar refusal and never the reason", async () => {
    const { service } = await open({ STARTER_WEEKLY_TOKENS: "2000000" });
    const day = daysAgo(service, 200);
    await batch(service, day);
    const { access_token: token } = await service.signIn(belowBar(100, day));
    const mine = await me(service, token);
    assert.equal(mine.level, "starter");
    assert.equal(mine.allowance.tokensPerWeek, 0);
    assert.doesNotMatch(JSON.stringify(mine), /batch|creat/i);
    const response = await chat(service, token);
    assert.equal(response.status, 403);
    const error = ((await response.json()) as { error: Record<string, any> }).error;
    assert.equal(error.code, "below_bar");
    assert.equal(error.request, "/v1/access-request");
    assert.doesNotMatch(error.message, HIDDEN);
    // The sign-in page tells it what everyone with no free tokens is told.
    const flow = await startBrowserFlow(service.request, belowBar(100, day), undefined, { stopAtDetails: true });
    assert.match(flow.page, /Free tokens are for established GitHub accounts/);
    assert.doesNotMatch(flow.page, /Starter access/);
  });
});

describe("re-check below-bar accounts", () => {
  it("raises qualifying Starter accounts to basic from stored signals, and stores the batch flag", async () => {
    const { service, admin } = await open({ BASIC_WEEKLY_TOKENS: "0", BASIC_MIN_ACCOUNT_AGE_DAYS: "180" });
    await service.signIn(belowBar(100, OLD)); // qualifies once basic is on
    await service.signIn(belowBar(101, YOUNG)); // too young
    const day = daysAgo(service, 200);
    await batch(service, day); // 300..314: old enough for basic, mostly not flagged when they signed up
    await service.signIn(belowBar(102, day)); // flagged
    await service.signIn(belowBar(103, OLD)); // blocked: left alone
    assert.equal((await service.request("POST", "/admin/people/103/block", { token: admin })).status, 200);

    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { basicWeeklyTokens: 10_000_000 } })).status, 200);
    const response = await service.request("POST", "/v1/admin/recheck-below-bar", { token: admin });
    assert.equal(response.status, 200);
    const outcome = (await response.json()) as Record<string, number>;
    // 100, 101, 102 and the fifteen batch accounts; 103 is blocked. Everyone in the batch window is flagged now.
    assert.deepEqual(outcome, { checked: 18, raised: 1, flagged: 16, starter: 1 });
    const people = ((await (await service.request("GET", "/admin/people", { token: admin })).json()) as { people: Array<Record<string, any>> }).people;
    const level = (id: number) => people.find((row) => row.githubId === id)?.level;
    assert.equal(level(100), "basic");
    assert.equal(level(101), "starter");
    assert.equal(level(102), "starter");
    assert.equal(level(103), "starter");
    assert.equal(people.find((row) => row.githubId === 103)?.status, "blocked");
    // Running it again changes nothing.
    const again = (await (await service.request("POST", "/v1/admin/recheck-below-bar", { token: admin })).json()) as Record<string, number>;
    assert.equal(again.raised, 0);
  });

  it("counts an account's age to today, from its creation day", async () => {
    const { service, admin } = await open({ BASIC_WEEKLY_TOKENS: "0" });
    // 350 days old at sign-up: too young for basic then, old enough 20 days later.
    const created = new Date(service.clock.now - 350 * DAY).toISOString();
    await service.signIn(belowBar(100, created));
    service.clock.now += 20 * DAY;
    const fresh = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    assert.equal((await service.request("POST", "/admin/config", { token: fresh, body: { basicWeeklyTokens: 10_000_000 } })).status, 200);
    const outcome = (await (await service.request("POST", "/v1/admin/recheck-below-bar", { token: fresh })).json()) as Record<string, number>;
    assert.equal(outcome.raised, 1);
    assert.ok(admin);
  });

  it("is a button on the Tools tab that reports the counts", async () => {
    const { service } = await open({ BASIC_WEEKLY_TOKENS: "0" });
    await service.signIn(belowBar(100, OLD));
    const cookie = await adminCookie(service);
    const page = await (await service.request("GET", "/admin?view=tools", { headers: { cookie } })).text();
    assert.match(page, /<button class="btn primary" type="submit">Re-check below-bar accounts<\/button>/);
    const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    await service.request("POST", "/admin/config", { token: admin, body: { basicWeeklyTokens: 10_000_000 } });
    const { html } = await tools(service, cookie, { tool: "recheck" });
    assert.match(html, /<dt>Checked<\/dt><dd>1<\/dd><\/div><div><dt>Raised to Basic<\/dt><dd>1<\/dd>/);
  });
});

describe("what each level is told", () => {
  const bar = { minAccountAgeDays: 365, minPublicRepos: 100_000, minContributions: 100 };
  it("words the Starter line for a small allowance and for none", () => {
    assert.equal(
      starterLine(bar, 2_000_000, 0.5),
      "Starter access: a small free allowance to try dl, 2M tokens a week of every model, GPT-6 included, up to $0.50. It resets every Monday. The full free tier is for established GitHub accounts: at least 1 year old with 100+ contributions in the last year. Want more? Type /request in dl and tell us what you're building. Or use your own API key with /provider.",
    );
    assert.equal(starterLine(bar, 0, 0.5), belowBarLine(bar));
    assert.equal(
      belowBarLine(bar),
      "Free tokens are for established GitHub accounts: at least 1 year old with 100+ contributions in the last year. Not there yet? Type /request in dl and tell us what you're building, and we may give you free tokens (or email contact@directionallylocal.com). Or use your own API key with /provider.",
    );
    assert.equal(
      basicLine(10_000_000, 3),
      "Basic access: a smaller free allowance, 10M tokens a week of every model, GPT-6 included, up to $3. It resets every Monday. Want more? Type /request in dl and tell us what you're building. Or use your own API key with /provider.",
    );
    assert.equal(basicLine(10_000_000, undefined), "Basic access: a smaller free allowance, 10M tokens a week of every model, GPT-6 included. It resets every Monday. Want more? Type /request in dl and tell us what you're building. Or use your own API key with /provider.");
    for (const line of [starterLine(bar, 2_000_000, 0.5), belowBarLine(bar), basicLine(10_000_000, 3), limitLine("basic", 10_000_000, 3), limitLine("starter", 2_000_000, 0.5)]) assert.doesNotMatch(line, HIDDEN);
  });

  it("sends the welcome for the level: basic, a small Starter allowance, or none", async () => {
    const vars = { RESEND_API_KEY: "re_test_key" };
    const text = (s: Service, index = 0) => String(s.calls.resend[index]!.body.text);
    const key = (s: Service, index = 0) => s.calls.resend[index]!.headers["idempotency-key"];

    const basic = await open(vars);
    await startBrowserFlow(basic.service.request, { ...belowBar(100, OLD), email: "a@work.example" });
    assert.equal(key(basic.service), "dl-user-email-welcome_basic-100-once");
    assert.match(text(basic.service), /smaller weekly allowance of every model, gpt-6 included/);
    assert.match(text(basic.service), /type \/request inside dl/);
    assert.match(text(basic.service), /discord\.gg/);
    assert.doesNotMatch(text(basic.service), /\$20|year old|365/);

    const small = await open({ ...vars, STARTER_WEEKLY_TOKENS: "2000000" });
    await startBrowserFlow(small.service.request, { ...belowBar(101, YOUNG), email: "b@work.example" });
    assert.equal(key(small.service), "dl-user-email-welcome_starter_small-101-once");
    assert.match(text(small.service), /small weekly allowance to try every model/);
    assert.match(text(small.service), /type \/request inside dl/);
    assert.match(text(small.service), /contact@directionallylocal\.com/);

    const none = await open(vars);
    await startBrowserFlow(none.service.request, { ...belowBar(102, YOUNG), email: "c@work.example" });
    assert.equal(key(none.service), "dl-user-email-welcome_starter-102-once");
    assert.match(text(none.service), /type \/request inside dl/);
    assert.match(text(none.service), /email contact@directionallylocal\.com with your github username instead/);
    assert.match(text(none.service), /discord\.gg/);

    // A batch-flagged sign-up gets the no-tokens welcome even with a Starter allowance.
    const flagged = await open({ ...vars, STARTER_WEEKLY_TOKENS: "2000000" });
    const day = daysAgo(flagged.service, 200);
    await batch(flagged.service, day);
    const before = flagged.service.calls.resend.length;
    await startBrowserFlow(flagged.service.request, { ...belowBar(103, day), email: "d@work.example" });
    assert.equal(key(flagged.service, before), "dl-user-email-welcome_starter-103-once");
    for (const s of [basic.service, small.service, none.service, flagged.service]) for (const call of s.calls.resend) assert.doesNotMatch(String(call.body.text), /batch|follow|signal/);
  });
});
