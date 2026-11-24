import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { ADMIN_ID, createService, startBrowserFlow, submitDetails, type GitHubUserFixture, type Service } from "./harness.js";
import { batchThreshold, levelChecks, type SignalThresholds } from "../src/admission.js";
import { normalizeEventCode } from "../src/event-codes.js";
import { adminCookie, tools } from "./admin-web.js";

/**
 * Sign-up rules that hold up on a busy day without turning real developers away: the
 * creation-batch threshold scales with sign-up volume, the per-domain limit places new accounts
 * at Starter instead of refusing them, and event codes let a class or hackathon sign up together.
 */

const DAY = 86_400_000;
// The public bar as it is run (1 year, 100 contributions), with the live batch rule.
const BAR = {
  OPENAI_API_KEY: "sk-test",
  OPEN_ADMISSION: "true",
  FULL_MIN_ACCOUNT_AGE_DAYS: "365",
  FULL_MIN_CONTRIBUTIONS: "100",
  FULL_MIN_PUBLIC_REPOS: "100000",
  BATCH_SIZE: "12",
  BATCH_WINDOW_DAYS: "2",
  NETWORK_SIGNUPS_PER_DAY: "1000",
  DOMAIN_SIGNUPS_PER_DAY: "1000",
};
const OLD = "2019-01-01T00:00:00Z";
const belowBar = (id: number, createdAt: string, extra: Partial<GitHubUserFixture> = {}): GitHubUserFixture => ({ id, login: `user${id}`, createdAt, publicRepos: 0, contributions: 10, social: 0, ...extra });
/** Clears the public bar: old, with plenty of contributions and the additional signals. */
const established = (id: number, extra: Partial<GitHubUserFixture> = {}): GitHubUserFixture => ({
  id,
  login: `user${id}`,
  createdAt: OLD,
  publicRepos: 5,
  contributions: 500,
  activeWeeks: 30,
  followers: 10,
  outsideCommits: 3,
  social: 40,
  ...extra,
});

async function open(vars: Record<string, string> = {}): Promise<{ service: Service; admin: string }> {
  const service = await createService({ ...BAR, ...vars });
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  return { service, admin };
}

function db(service: Service): DatabaseSync {
  service.directory();
  return (service.namespaces.DIRECTORY!.instances.get("directory")!.state as unknown as { db: DatabaseSync }).db;
}

/** People already signed up, written straight to the table: only their GitHub creation days matter here. */
function seed(service: Service, firstId: number, createdDays: number[]): void {
  const insert = db(service).prepare("INSERT INTO people (github_id, login, status, admitted_at, admitted_via, level, github_created_day) VALUES (?, ?, 'active', ?, 'open', 'starter', ?)");
  createdDays.forEach((day, index) => insert.run(firstId + index, `seed${firstId + index}`, service.clock.now - DAY, day));
}

/** The page sign-in ends on (the details page also says "Signed in as"). */
const DONE = /Return to your terminal/;
const today = (service: Service) => Math.floor(service.clock.now / DAY);
const isoOfDay = (day: number) => new Date(day * DAY).toISOString();

async function person(service: Service, admin: string, githubId: number): Promise<Record<string, any>> {
  const body = (await (await service.request("GET", "/admin/people", { token: admin })).json()) as { people: Array<Record<string, any>> };
  return body.people.find((row) => row.githubId === githubId)!;
}

/** One sign-up through the browser, from `ip`, giving `email` and (optionally) a code on the details step. */
async function signUp(service: Service, user: GitHubUserFixture, options: { ip?: string; email?: string; code?: string } = {}): Promise<{ status: number; page: string }> {
  const ip = options.ip ?? `198.51.100.${user.id % 250}`;
  const request: Service["request"] = (method, path, more = {}) => service.request(method, path, { ...more, ip });
  const flow = await startBrowserFlow(request, user, undefined, { stopAtDetails: true });
  return submitDetails(request, flow.page, { email: options.email ?? `${user.login}@example.com`, ...(options.code ? { invite: options.code } : {}) });
}

const RULES: SignalThresholds = { humanSignalsNeeded: 2, minActiveWeeks: 4, minRepoAgeDays: 90, minSocial: 5, minFollowers: 1, batchWindowDays: 2, batchSize: 12, batchDensityFactor: 3 };

describe("the creation-batch threshold scales with sign-up volume", () => {
  it("is batchSize on a quiet week and grows with the young accounts signed up", () => {
    assert.equal(batchThreshold(RULES, 0, 365), 12);
    assert.equal(batchThreshold(RULES, 200, 365), 12, "200 young accounts: under 3 peers a window on average, 3x is still under 12");
    // A launch: 3,000 young accounts hold about 41 peers per 5-day window on average.
    assert.equal(batchThreshold(RULES, 3000, 365), 124);
    assert.equal(batchThreshold({ ...RULES, batchDensityFactor: 0 }, 3000, 365), 12, "factor 0: the fixed rule");
    assert.equal(batchThreshold({ ...RULES, batchSize: 0 }, 3000, 365), 0, "batchSize 0: the check is off");
  });

  it("keeps flagging a farm on a launch day, and stops flagging the ordinary young accounts", () => {
    const young = { accountAgeDays: 30, publicRepos: 0, followers: 0, contributions: 0, restrictedContributions: 0 };
    const bar = { minAccountAgeDays: 365, minPublicRepos: 3, minContributions: 100 };
    const at = (batchPeers: number, youngAccounts: number, rules = RULES) => levelChecks(young, bar, rules, { now: 0, batchPeers, youngAccounts }).creationBatch;
    assert.equal(at(45, 3000), false, "an ordinary window on a launch day");
    assert.equal(at(45, 3000, { ...RULES, batchDensityFactor: 0 }), true, "which the fixed rule flagged");
    assert.equal(at(200, 3000), true, "200 accounts made the same few days: a farm");
    assert.equal(at(12, 50), true, "a quiet week: the fixed batchSize as before");
  });

  it("at sign-in: a busy launch doesn't flag a young account from an ordinary window, a farm still is flagged", async () => {
    const { service, admin } = await open();
    // 1,500 young accounts already signed up, spread over the last year: about 20 per 5-day
    // window, so the fixed batchSize of 12 flagged nearly every young sign-up.
    const now = today(service);
    seed(service, 10_000, Array.from({ length: 1500 }, (_, index) => now - 5 - (index % 355)));
    // A farm: 150 accounts made on two days, 100 days ago.
    seed(service, 20_000, Array.from({ length: 150 }, (_, index) => now - 100 - (index % 2)));
    await signUp(service, belowBar(100, isoOfDay(now - 200)));
    const ordinary = await person(service, admin, 100);
    assert.ok(ordinary.checks.batchPeers >= 12, `an ordinary window here holds ${ordinary.checks.batchPeers} peers`);
    assert.ok(ordinary.checks.batchThreshold > ordinary.checks.batchPeers);
    assert.equal(ordinary.checks.creationBatch, false);
    assert.equal((await service.directory().getPerson(100))?.batch_flag, 0);

    await signUp(service, belowBar(101, isoOfDay(now - 100)));
    const farm = await person(service, admin, 101);
    assert.equal(farm.checks.creationBatch, true);
    assert.equal((await service.directory().getPerson(101))?.batch_flag, 1);

    // The old fixed rule, for comparison: the ordinary account is flagged too.
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { batchDensityFactor: 0 } })).status, 200);
    assert.equal((await person(service, admin, 100)).checks.creationBatch, true);
  });

  it("is a runtime setting that the admin config shows", async () => {
    const { service, admin } = await open({ BATCH_DENSITY_FACTOR: "5" });
    const body = (await (await service.request("GET", "/admin/config", { token: admin })).json()) as { effective: Record<string, unknown> };
    assert.equal(body.effective.batchDensityFactor, 5);
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { batchDensityFactor: 2 } })).status, 200);
    const after = (await (await service.request("GET", "/admin/config", { token: admin })).json()) as { effective: Record<string, unknown> };
    assert.equal(after.effective.batchDensityFactor, 2);
  });
});

describe("the per-domain daily limit places new accounts at Starter", () => {
  it("lets colleagues past the limit in at Starter, keeps a Full account Full, and still refuses blocked emails", async () => {
    const { service, admin } = await open({ DOMAIN_SIGNUPS_PER_DAY: "2", BLOCKED_EMAILS: "@farm.example" });
    const young = (id: number) => belowBar(id, new Date(service.clock.now - 30 * DAY).toISOString());
    for (const id of [101, 102]) assert.match((await signUp(service, young(id), { email: `p${id}@company.example` })).page, DONE);
    const third = await signUp(service, young(103), { email: "p103@company.example" });
    assert.match(third.page, DONE, "not refused");
    assert.doesNotMatch(third.page, /Too many new free accounts/);
    const row = await service.directory().getPerson(103);
    assert.equal(row?.level, "starter");
    assert.equal(row?.level_reason, "domain_limit");
    // Someone who clears the bar on their own keeps Full, like on a shared network.
    assert.match((await signUp(service, established(104), { email: "p104@company.example" })).page, DONE);
    assert.equal((await service.directory().getPerson(104))?.level, "full");
    // The blocklist is untouched.
    assert.match((await signUp(service, young(105), { email: "x@farm.example" })).page, /can.{0,6}t be used/);
    const metrics = await (await service.request("GET", "/admin/metrics", { token: admin })).text();
    assert.match(metrics, /domain_limit/);
  });

  it("refuses as before with domainLimitRefuse", async () => {
    const { service, admin } = await open({ DOMAIN_SIGNUPS_PER_DAY: "1" });
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { domainLimitRefuse: true } })).status, 200);
    const young = (id: number) => belowBar(id, new Date(service.clock.now - 30 * DAY).toISOString());
    assert.match((await signUp(service, young(101), { email: "a@company.example" })).page, DONE);
    assert.match((await signUp(service, young(102), { email: "b@company.example" })).page, /Too many new free accounts/);
  });
});

describe("event codes", () => {
  const make = async (service: Service, admin: string, body: Record<string, unknown>) => {
    const response = await service.request("POST", "/admin/event-codes", { token: admin, body });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };

  it("normalizes what people type", () => {
    assert.equal(normalizeEventCode("ev-bcdf-2345"), "EV-BCDF-2345");
    assert.equal(normalizeEventCode(" EV BCDF 2345 "), "EV-BCDF-2345");
    assert.equal(normalizeEventCode("DL-BCDF-2345"), undefined, "an invite code is not an event code");
  });

  it("lets a class sign up from one network and one domain, with accounts made the same week, at their own level", async () => {
    // Production's limits: 3 a network, 5 a domain.
    const { service, admin } = await open({ NETWORK_SIGNUPS_PER_DAY: "3", DOMAIN_SIGNUPS_PER_DAY: "5" });
    const made = await make(service, admin, { maxUses: 30, days: 3, note: "Intro to agents, lab 2" });
    assert.equal(made.status, 201);
    assert.match(made.body.code, /^EV-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    // 20 accounts created over two days, a week ago: past batchSize 12.
    const created = (index: number) => new Date(service.clock.now - (7 + (index % 2)) * DAY).toISOString();
    for (let index = 0; index < 20; index++) {
      const id = 200 + index;
      const result = await signUp(service, belowBar(id, created(index)), { ip: "203.0.113.9", email: `s${id}@uni.example`, code: made.body.code.toLowerCase() });
      assert.match(result.page, DONE, `student ${index}`);
      const row = await service.directory().getPerson(id);
      assert.equal(row?.level, "starter", "their own signals' level: a young account below the bar");
      assert.equal(row?.level_reason, "account_too_new", "not a network or domain limit");
      assert.equal(row?.batch_flag, 0, "not a creation batch");
    }
    // Without the code, the next one from the same network and domain meets every rule.
    await signUp(service, belowBar(250, created(0)), { ip: "203.0.113.9", email: "late@uni.example" });
    const late = await service.directory().getPerson(250);
    assert.equal(late?.level_reason, "domain_limit", "the class's sign-ups count toward the domain's day");
    assert.equal(late?.batch_flag, 1);
    // Uses are counted, with who.
    const list = (await (await service.request("GET", "/admin/event-codes", { token: admin })).json()) as { eventCodes: Array<Record<string, any>> };
    assert.equal(list.eventCodes.length, 1);
    assert.equal(list.eventCodes[0]!.uses, 20);
    assert.equal(list.eventCodes[0]!.status, "open");
    assert.equal(list.eventCodes[0]!.people.length, 20);
    assert.equal(list.eventCodes[0]!.note, "Intro to agents, lab 2");
    assert.equal("code" in list.eventCodes[0]!, false, "the code is shown once, never listed");
    // The weekly re-check and the admin's re-check don't flag them as a batch later.
    const recheck = (await (await service.request("POST", "/admin/recheck-below-bar", { token: admin, body: {} })).json()) as Record<string, number>;
    assert.ok((recheck.checked ?? 0) >= 20);
    assert.equal((await service.directory().getPerson(205))?.batch_flag, 0);
    assert.equal((await person(service, admin, 205)).checks.creationBatch, false);
  });

  it("stops at its maximum uses, at its expiry and when ended, and can give Full", async () => {
    const opened = await open();
    const service = opened.service;
    let admin = opened.admin;
    const two = (await make(service, admin, { maxUses: 2, days: 1 })).body.code as string;
    const young = (id: number) => belowBar(id, new Date(service.clock.now - 10 * DAY).toISOString());
    assert.match((await signUp(service, young(301), { code: two })).page, DONE);
    assert.match((await signUp(service, young(302), { code: two })).page, DONE);
    const third = await signUp(service, young(303), { code: two });
    assert.equal(third.status, 400);
    assert.match(third.page, /isn.{0,6}t valid, is used up or has expired/);
    assert.equal(await service.directory().getPerson(303), undefined, "nobody is admitted on a refused code");

    const soon = (await make(service, admin, { maxUses: 10, days: 1 })).body.code as string;
    service.clock.now += 2 * DAY;
    assert.match((await signUp(service, young(304), { code: soon })).page, /used up or has expired/);
    admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;

    const full = await make(service, admin, { maxUses: 5, days: 2, full: true });
    assert.equal(full.body.full, true);
    assert.match((await signUp(service, young(305), { code: full.body.code })).page, DONE);
    assert.equal((await service.directory().getPerson(305))?.level, "full");
    assert.equal((await service.request("POST", `/admin/event-codes/${full.body.id}/end`, { token: admin })).status, 200);
    assert.match((await signUp(service, young(306), { code: full.body.code })).page, /used up or has expired/);
    assert.equal((await service.request("POST", `/admin/event-codes/${full.body.id}/end`, { token: admin })).status, 404);

    // Wrong codes, bad input, and non-admins.
    assert.match((await signUp(service, young(307), { code: "EV-ZZZZ-ZZZZ" })).page, /isn.{0,6}t valid/);
    assert.equal((await make(service, admin, { maxUses: 0 })).status, 400);
    assert.equal((await make(service, admin, { maxUses: 5, days: 365 })).status, 400);
    const member = (await service.signIn(young(308))).access_token;
    assert.equal((await service.request("POST", "/admin/event-codes", { token: member, body: { maxUses: 5 } })).status, 403);
  });

  it("is for new accounts only", async () => {
    const { service, admin } = await open();
    const code = (await make(service, admin, { maxUses: 5 })).body.code as string;
    const young = belowBar(401, new Date(service.clock.now - 10 * DAY).toISOString());
    assert.match((await signUp(service, young)).page, DONE);
    const again = await signUp(service, young, { code });
    assert.equal(again.status, 400);
    assert.match(again.page, /Event codes are for new accounts/);
  });

  it("is made, listed and ended on the Tools tab", async () => {
    const { service } = await open();
    const cookie = await adminCookie(service);
    const made = await tools(service, cookie, { tool: "event-code", action: "create", note: "Hack night", max_uses: "40", days: "2", full: "0" });
    assert.equal(made.status, 200);
    const code = /<code>(EV-[A-Z0-9]{4}-[A-Z0-9]{4})<\/code>/.exec(made.html)?.[1];
    assert.ok(code, "the new code is shown");
    assert.match(made.html, /Hack night/);
    assert.match(made.html, /0 of 40 used/);
    await signUp(service, belowBar(501, new Date(service.clock.now - 10 * DAY).toISOString()), { code });
    const page = await (await service.request("GET", "/admin?view=tools", { headers: { cookie } })).text();
    assert.match(page, /1 of 40 used/);
    assert.match(page, /@user501/);
    assert.doesNotMatch(page, new RegExp(code!), "the code is shown only when made");
    const id = /name="id" value="(\d+)"><div class="row"><button class="btn" type="submit" name="action" value="end">/.exec(page)?.[1];
    assert.ok(id);
    const ended = await tools(service, cookie, { tool: "event-code", action: "end", id: id! });
    assert.match(ended.html, /Ended: the code no longer works/);
    assert.match(ended.html, /chip mid">Ended/);
    const bad = await tools(service, cookie, { tool: "event-code", action: "create", max_uses: "0", days: "2" });
    assert.match(bad.html, /msg err/);
  });
});
