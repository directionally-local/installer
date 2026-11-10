import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { constants as sqliteConstants, type DatabaseSync } from "node:sqlite";
import { ADMIN_ID, createService, MODEL, NOW, type Service } from "./harness.js";
import { adminCookie, csrfOf } from "./admin-web.js";
import type { SpendView } from "../src/dashboard-page.js";
import { atCap, HOME_COLUMNS, HOME_QUERY_TAG, realAllowance, type HomeData, type LevelSettings } from "../src/home-data.js";
import { MAX_PROBLEMS, money, outlook, problems, usersSentence } from "../src/home-page.js";
import { parseSettingsUpdate } from "../src/runtime-config.js";
import { readFreeConfig } from "../src/config.js";

/**
 * The admin home screen (GET /admin): the spend verdict's rules, the problem thresholds, each
 * person's real allowance by level, the order of the blocks, escaping, admin-only access, and the
 * accessRequestAlerts setting. NOW is Wednesday 2026-11-04 12:00 UTC: 2.5 days into the week.
 */

const DAY = 86_400_000;
const WEEK_START = Date.parse("2026-11-02T00:00:00Z");
const SQLITE_OK = (sqliteConstants as Record<string, number>).SQLITE_OK ?? 0;
const SQLITE_READ = (sqliteConstants as Record<string, number>).SQLITE_READ ?? 20;

/** Today's-like numbers: $75 of free use 2.5 days in, $4,939 OpenAI and $1,969 Luminal credit left. */
function spendFixture(overrides: Partial<SpendView> = {}): SpendView {
  return {
    weekUsd: 0,
    totalUsd: 0,
    adminWeekUsd: 0,
    adminTotalUsd: 0,
    weeklyCapUsd: 2000,
    totalCapUsd: null,
    resetsAt: WEEK_START + 7 * DAY,
    paused: false,
    pausedByEnv: false,
    openAdmission: true,
    requireGithubActivity: true,
    maxActiveUsers: 50,
    weeklyTokens: 50_000_000,
    perPersonWeeklyUsd: 20,
    queueThreshold: 0.8,
    primaryUpstream: "openai",
    luminalConfigured: true,
    serving: "openai",
    openRouterConfigured: false,
    openaiConfigured: true,
    creditUsd: 2000,
    creditUsedUsd: 31,
    creditWeekUsd: 16,
    freeCreditWeekUsd: 15,
    weeklyCreditUsd: null,
    openaiCreditUsd: 5000,
    openaiCreditUsedUsd: 61,
    openaiCreditWeekUsd: 62,
    openaiFreeCreditWeekUsd: 60,
    openaiWeeklyCreditUsd: 2000,
    starterWeeklyTokens: 2_000_000,
    starterWeeklyUsd: 0.5,
    basicWeeklyTokens: 10_000_000,
    basicWeeklyUsd: 3,
    basicMinAccountAgeDays: 365,
    fullMinAccountAgeDays: 365,
    fullMinPublicRepos: 100_000,
    fullMinContributions: 100,
    ...overrides,
  };
}

function homeFixture(overrides: Partial<HomeData> = {}): HomeData {
  const spendDays = Array.from({ length: 14 }, (_, index) => ({ day: Math.floor(NOW / DAY) * DAY - (13 - index) * DAY, openai: 20 + index, luminal: 5, openrouter: 0 }));
  return {
    now: NOW,
    weekStart: WEEK_START,
    spendDays,
    people: { today: 23, week: 61, signupsToday: 4 },
    spenders: [],
    models: [],
    installs: [],
    sessions: { judged: 0, abnormal: 0 },
    providers: [],
    ...overrides,
  };
}

describe("home: are we OK?", () => {
  it("reads today's-like numbers as one plain sentence", () => {
    const view = outlook(spendFixture(), homeFixture());
    assert.equal(view.verdict, "Fine");
    assert.equal(view.sentence, "Fine. $75 spent this week of a $2,000 weekly budget; at this pace about $210 by Monday. Credits left: $4,939 OpenAI, $1,969 Luminal, about 32 weeks at this pace.");
    assert.doesNotMatch(view.sentence, /—/);
  });

  it("watches past 50% of the weekly budget by Monday, acts past 80%", () => {
    // 2.5 days in: spend × 7 / 2.5 by Monday.
    const at = (openaiFree: number) => outlook(spendFixture({ openaiFreeCreditWeekUsd: openaiFree, freeCreditWeekUsd: 0, openaiCreditWeekUsd: 0, creditWeekUsd: 0 }), homeFixture());
    assert.equal(at(357).verdict, "Fine"); // $999.60 by Monday: 49.98%
    assert.equal(at(358).verdict, "Watch it"); // $1,002.40: 50.1%
    assert.equal(at(571).verdict, "Watch it"); // $1,598.80: 79.9%
    assert.equal(at(572).verdict, "Act now"); // $1,601.60: 80.1%
    assert.match(at(572).sentence, /^Act now\. \$572 spent this week of a \$2,000 weekly budget; at this pace about \$1,602 by Monday\./);
  });

  it("watches under 8 weeks of credit at this pace, acts under 4", () => {
    // $100 of credit use in 2.5 days is $280 a week.
    const at = (left: number) =>
      outlook(spendFixture({ openaiFreeCreditWeekUsd: 0, freeCreditWeekUsd: 0, openaiCreditWeekUsd: 100, creditWeekUsd: 0, openaiCreditUsd: left, openaiCreditUsedUsd: 0, creditUsd: 0, creditUsedUsd: 0, luminalConfigured: false }), homeFixture());
    assert.equal(at(2300).verdict, "Fine"); // 8.2 weeks
    assert.equal(at(2200).verdict, "Watch it"); // 7.9 weeks
    assert.equal(at(1150).verdict, "Watch it"); // 4.1 weeks
    assert.equal(at(1100).verdict, "Act now"); // 3.9 weeks
    assert.match(at(1100).sentence, /Credits left: \$1,100 OpenAI, about 4 weeks at this pace\.$/);
  });

  it("acts when free requests can't be served or a credit is used up, and watches while paused", () => {
    assert.equal(outlook(spendFixture({ serving: "none" }), homeFixture()).verdict, "Act now");
    const out = outlook(spendFixture({ creditUsedUsd: 2000 }), homeFixture());
    assert.equal(out.verdict, "Act now");
    assert.match(out.sentence, /^Act now\. Luminal credit is used up\. /);
    const paused = outlook(spendFixture({ paused: true }), homeFixture());
    assert.equal(paused.verdict, "Watch it");
    assert.match(paused.sentence, /^Watch it\. Free tokens are paused for everyone\. \$75 spent/);
  });

  it("uses the last 7 days' average while the week is under a day old", () => {
    const monday = WEEK_START + 6 * 3_600_000;
    const days = Array.from({ length: 14 }, (_, index) => ({ day: Math.floor(monday / DAY) * DAY - (13 - index) * DAY, openai: 10, luminal: 0, openrouter: 0 }));
    const view = outlook(spendFixture({ openaiFreeCreditWeekUsd: 2, freeCreditWeekUsd: 0, openaiCreditWeekUsd: 2, creditWeekUsd: 0 }), homeFixture({ now: monday, spendDays: days }));
    // $2 so far plus $10 a day for the 6.75 days left.
    assert.equal(Math.round(view.projectedUsd), 70);
  });

  it("rounds dollars to whole ones from $10 up", () => {
    assert.equal(money(0), "$0");
    assert.equal(money(4.5), "$4.50");
    assert.equal(money(9.994), "$9.99");
    assert.equal(money(75.4), "$75");
    assert.equal(money(4938.6), "$4,939");
  });
});

describe("home: real allowance per level", () => {
  const settings: LevelSettings = { weeklyTokens: 50_000_000, perPersonWeeklyUsd: 20, basicWeeklyTokens: 10_000_000, basicWeeklyUsd: 3, starterWeeklyTokens: 2_000_000, starterWeeklyUsd: 0.5 };
  const person = (level: string | null, extra: Partial<{ batchFlagged: boolean; grantTokens: number | null; grantUsd: number | null }> = {}) => ({ level, batchFlagged: false, grantTokens: null, grantUsd: null, ...extra });

  it("gives each level its own tokens and dollars, not the default 50M and $20", () => {
    assert.deepEqual(realAllowance(person("full"), settings), { tier: "full", tokens: 50_000_000, usd: 20 });
    assert.deepEqual(realAllowance(person(null), settings), { tier: "full", tokens: 50_000_000, usd: 20 });
    assert.deepEqual(realAllowance(person("basic"), settings), { tier: "middle", tokens: 10_000_000, usd: 3 });
    assert.deepEqual(realAllowance(person("starter"), settings), { tier: "small", tokens: 2_000_000, usd: 0.5 });
    assert.deepEqual(realAllowance(person("starter", { batchFlagged: true }), settings), { tier: "no tokens", tokens: 0, usd: 0 });
    // Basic switched off is served as Starter; Starter at 0 tokens is no tokens.
    assert.deepEqual(realAllowance(person("basic"), { ...settings, basicWeeklyTokens: 0 }), { tier: "small", tokens: 2_000_000, usd: 0.5 });
    assert.deepEqual(realAllowance(person("starter"), { ...settings, starterWeeklyTokens: 0 }), { tier: "no tokens", tokens: 0, usd: 0 });
    // An admin's grant sets Full's tokens and any level's dollars.
    assert.deepEqual(realAllowance(person("full", { grantTokens: 80_000_000, grantUsd: 40 }), settings), { tier: "full", tokens: 80_000_000, usd: 40 });
    assert.deepEqual(realAllowance(person("basic", { grantTokens: 80_000_000, grantUsd: 5 }), settings), { tier: "middle", tokens: 10_000_000, usd: 5 });
  });

  it("is at cap at the dollar cap or within 1% of the tokens, never with no tokens", () => {
    assert.equal(atCap({ costUsd: 3, tokens: 0 }, { tokens: 10_000_000, usd: 3 }), true);
    assert.equal(atCap({ costUsd: 2.9, tokens: 9_900_000 }, { tokens: 10_000_000, usd: 3 }), true);
    assert.equal(atCap({ costUsd: 2.9, tokens: 9_800_000 }, { tokens: 10_000_000, usd: 3 }), false);
    assert.equal(atCap({ costUsd: 0, tokens: 0 }, { tokens: 0, usd: 0 }), false);
  });
});

describe("home: is anything broken?", () => {
  const spend = spendFixture();
  const texts = (home: HomeData) => problems(home, spend).map((problem) => problem.text);

  it("says nothing for healthy numbers", () => {
    assert.deepEqual(texts(homeFixture()), []);
  });

  it("flags a model failing more than 10% of at least 20 requests this week", () => {
    assert.deepEqual(texts(homeFixture({ models: [{ model: "gpt-6-astra", requests: 100, failed: 10 }] })), []);
    assert.deepEqual(texts(homeFixture({ models: [{ model: "gpt-6-astra", requests: 19, failed: 19 }] })), []);
    const found = problems(homeFixture({ models: [{ model: "gpt-6-astra", requests: 100, failed: 57 }] }), spend);
    assert.equal(found[0]!.text, "GPT-6 Astra requests fail 57% of the time this week.");
    assert.equal(found[0]!.href, "/admin?view=health#errors");
  });

  it("flags an install platform failing more than 15% of at least 5 installs", () => {
    assert.deepEqual(texts(homeFixture({ installs: [{ os: "linux", arch: "arm64", mode: "server", ok: 17, failed: 3 }] })), []);
    assert.deepEqual(texts(homeFixture({ installs: [{ os: "linux", arch: "arm64", mode: "server", ok: 2, failed: 2 }] })), []);
    assert.deepEqual(texts(homeFixture({ installs: [{ os: "darwin", arch: "arm64", mode: "laptop", ok: 8, failed: 2 }] })), ["macOS arm64 laptop installs fail 20% of the time this week."]);
  });

  it("flags more than 25% of at least 20 sessions ending abnormally", () => {
    assert.deepEqual(texts(homeFixture({ sessions: { judged: 100, abnormal: 25 } })), []);
    assert.deepEqual(texts(homeFixture({ sessions: { judged: 19, abnormal: 19 } })), []);
    assert.deepEqual(texts(homeFixture({ sessions: { judged: 100, abnormal: 31 } })), ["31% of sessions this week ended without a normal exit."]);
  });

  it("flags a provider failing 10%+ today at twice its week's share", () => {
    const providers = (todayErrors: number, weekErrors: number): HomeData["providers"] => [
      { upstream: "luminal", window: "today", requests: 100, errors: todayErrors },
      { upstream: "luminal", window: "week", requests: 1000, errors: weekErrors },
    ];
    assert.deepEqual(texts(homeFixture({ providers: providers(9, 10) })), []);
    assert.deepEqual(texts(homeFixture({ providers: providers(14, 100) })), []); // 14% today against 10%: not twice
    assert.deepEqual(texts(homeFixture({ providers: providers(14, 30) })), ["Luminal fails 14% of requests today, against 3% this week."]);
  });

  it("flags people at their real cap", () => {
    const people = [
      { githubId: 7, login: "kenji", level: "basic", batchFlagged: false, grantTokens: null, grantUsd: null, costUsd: 3, tokens: 1_000_000 },
      { githubId: 8, login: "mara", level: "full", batchFlagged: false, grantTokens: null, grantUsd: null, costUsd: 3, tokens: 1_000_000 },
    ];
    assert.deepEqual(texts(homeFixture({ spenders: people })), ["kenji is at their weekly cap."]);
  });

  it("puts the worst first and the page shows three", () => {
    const home = homeFixture({
      models: [{ model: "gpt-6-astra", requests: 100, failed: 57 }],
      installs: [{ os: "linux", arch: "x64", mode: "server", ok: 6, failed: 4 }],
      sessions: { judged: 100, abnormal: 40 },
      providers: [{ upstream: "openai", window: "today", requests: 50, errors: 20 }],
    });
    const found = texts(home);
    assert.equal(found.length, 4);
    assert.deepEqual(found.slice(0, MAX_PROBLEMS), [
      "OpenAI fails 40% of requests today, against 0% this week.",
      "GPT-6 Astra requests fail 57% of the time this week.",
      "Linux x64 server installs fail 40% of the time this week.",
    ]);
    // Spend past the budget outranks them.
    const pricey = problems(home, spendFixture({ openaiFreeCreditWeekUsd: 650 }));
    assert.match(pricey[0]!.text, /^At this pace spend reaches \$1,8\d\d by Monday, 9\d% of the weekly budget\.$/);
  });

  it("counts people in plain words", () => {
    assert.equal(usersSentence(homeFixture()), "23 people used dl today, 61 this week. 4 new sign-ups today.");
    assert.equal(usersSentence(homeFixture({ people: { today: 1, week: 1, signupsToday: 0 } })), "1 person used dl today, 1 this week. No new sign-ups today.");
  });
});

// ─── The page ─────────────────────────────────────────────────────────────

const VARS = { OPENAI_API_KEY: "sk-test", LUMINAL_API_KEY: "lm-test", OPEN_ADMISSION: "true", ALERT_WEBHOOK_URL: "https://alerts.test/hook" };

function db(service: Service): DatabaseSync {
  service.directory();
  return (service.namespaces.DIRECTORY!.instances.get("directory") as { state: { db: DatabaseSync } }).state.db;
}

/** Four people this week at four levels, and an admin who must never show. */
async function scenario(vars: Record<string, string> = {}): Promise<{ service: Service; cookie: string }> {
  const service = await createService({ ...VARS, ...vars });
  const directory = service.directory();
  const admit = (githubId: number, login: string, isAdmin = false) =>
    directory.admit({ githubId, login, isAdmin, inviteCode: undefined, clientDeviceId: null, accountTooNew: false, openAdmission: true, maxActive: 100, now: NOW - 10 * DAY });
  await admit(ADMIN_ID, "owner", true);
  await admit(100, "fullfay");
  await admit(101, "basicbo");
  await admit(102, "smallsam");
  await admit(103, "flaggedfy");
  const sql = db(service);
  sql.exec("UPDATE people SET level = 'basic' WHERE github_id = 101");
  sql.exec("UPDATE people SET level = 'starter' WHERE github_id IN (102, 103)");
  sql.exec("UPDATE people SET batch_flag = 1 WHERE github_id = 103");
  const request = (githubId: number, costUsd: number, at = NOW - 3_600_000) =>
    directory.recordRequest({ githubId, isAdmin: githubId === ADMIN_ID, at, model: MODEL, promptTokens: 1000, completionTokens: 0, cachedTokens: 0, chargedTokens: 1000, costUsd, status: "ok", latencyMs: 100 });
  await request(ADMIN_ID, 99);
  await request(100, 12.4);
  await request(101, 3);
  await request(102, 0.2);
  await request(103, 0.01);
  return { service, cookie: await adminCookie(service) };
}

const page = async (service: Service, cookie: string, path = "/admin") => {
  const response = await service.request("GET", path, { headers: { cookie } });
  assert.equal(response.status, 200);
  return response.text();
};

describe("home: the page", () => {
  it("answers four questions with each person's real cap, no admin, details at the bottom", async () => {
    const { service, cookie } = await scenario();
    const html = await page(service, cookie);
    const headings = [...html.matchAll(/<h2 id="[a-z]+-h">([^<]+)<\/h2>/g)].map((match) => match[1]);
    assert.deepEqual(headings, ["Are we OK?", "Who's using it?", "Is anything broken?", "What needs me?"]);
    assert.match(html, /<span class="verdict fine">Fine\.<\/span>/);
    assert.match(html, /4 people used dl today, 4 this week\. No new sign-ups today\./);
    assert.doesNotMatch(html, />owner</);
    assert.match(html, /fullfay<\/a> <span class="tier">full<\/span><\/span><span class="amt"><b>\$12<\/b> of \$20<\/span>/);
    assert.match(html, /basicbo<\/a> <span class="tier">middle<\/span><\/span><span class="amt"><span class="capword">at cap<\/span> <b>\$3\.00<\/b> of \$3\.00<\/span>/);
    assert.match(html, /smallsam<\/a> <span class="tier">small<\/span><\/span><span class="amt"><b>\$0\.20<\/b> of \$0\.50<\/span>/);
    assert.match(html, /flaggedfy<\/a> <span class="tier">no tokens<\/span>/);
    assert.match(html, /basicbo is at their weekly cap\. <a href="\/admin\?view=full#limits">see details<\/a>/);
    assert.match(html, /<p class="say">Nothing\. No one is waiting for an answer\.<\/p>/);
    assert.match(html, /<nav class="details" aria-label="Details"><span>Details:<\/span><a href="\/admin\?view=simple">Simple<\/a><a href="\/admin\?view=full">Full<\/a><a href="\/admin\?view=health">Health<\/a><a href="\/admin\?view=tools">Tools<\/a><\/nav>/);
    // No scripts, no inline styles, no wide tables, no jargon, no em dashes in what it says.
    assert.doesNotMatch(html, /<script|\sstyle="|<table/i);
    const text = html.replace(/<style[^]*?<\/style>/, "").replace(/<[^>]+>/g, " ");
    for (const word of ["ttft", "pool", "upstream", "D1", "—"]) assert.ok(!text.includes(word), word);
    const csp = (await service.request("GET", "/admin", { headers: { cookie } })).headers.get("content-security-policy")!;
    assert.match(csp, /default-src 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|script-src/);
  });

  it("puts what needs me first when anything waits, escaped and cut to two lines, and answers it in place", async () => {
    const { service, cookie } = await scenario();
    const directory = service.directory();
    const building = `<script>alert("x")</script> & a tool for ${"very ".repeat(60)}long things`;
    await directory.submitAccessRequest({ githubId: 102, login: "smallsam", building, link: null, now: NOW - 2 * 3_600_000, perDay: 3 });
    db(service).exec("UPDATE people SET account_age_days = 800 WHERE github_id = 102");
    const html = await page(service, cookie);
    const headings = [...html.matchAll(/<h2 id="[a-z]+-h">([^<]+)<\/h2>/g)].map((match) => match[1]);
    assert.equal(headings[0], "What needs me?");
    assert.match(html, /1 person asks for free tokens\./);
    assert.match(html, /@smallsam<\/a><span class="hint">2 hours ago<\/span>/);
    assert.match(html, /account 2 years old/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; a tool/);
    assert.match(html, /…<\/p>/);
    assert.doesNotMatch(html, /long things/);
    assert.match(html, /<button class="btn primary" type="submit" name="action" value="grant">Grant<\/button><button class="btn" type="submit" name="action" value="decline">Decline<\/button>/);

    const id = /name="id" value="(\d+)"/.exec(html)![1]!;
    const done = await service.request("POST", "/admin/dashboard/tools", { headers: { cookie, origin: "https://free.test" }, form: { csrf: csrfOf(html), tool: "request", from: "home", id, action: "decline" } });
    const after = await done.text();
    assert.equal(done.status, 200);
    assert.match(after, /<h2 id="ok-h">Are we OK\?<\/h2>/);
    assert.match(after, /Declined smallsam&#39;s request\./);
    assert.match(after, /Nothing\. No one is waiting for an answer\./);
    // A forged post is refused.
    const forged = await service.request("POST", "/admin/dashboard/tools", { headers: { cookie, origin: "https://evil.example" }, form: { csrf: csrfOf(html), tool: "request", from: "home", id, action: "grant" } });
    assert.equal(forged.status, 403);
  });

  it("is for admins only", async () => {
    const { service } = await scenario();
    const signedOut = await service.request("GET", "/admin");
    assert.equal(signedOut.status, 401);
    assert.doesNotMatch(await signedOut.text(), /Are we OK/);
    const member = (await service.signIn({ id: 100, login: "fullfay" })).access_token;
    const refused = await service.request("GET", "/admin", { token: member });
    assert.equal(refused.status, 403);
    assert.doesNotMatch(await refused.text(), /Are we OK|fullfay/);
    const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const bearer = await service.request("GET", "/admin", { token: admin });
    assert.equal(bearer.status, 200);
    // A bearer view gets no forms.
    assert.doesNotMatch(await bearer.text(), /name="csrf"/);
  });

  it("reads only its own small set of columns, every query tagged", async () => {
    const { service, cookie } = await scenario();
    const sql = db(service) as DatabaseSync & { setAuthorizer?: (callback: ((...args: unknown[]) => number) | null) => void };
    const statements: string[] = [];
    const prepare = sql.prepare.bind(sql);
    sql.prepare = ((query: string) => {
      statements.push(query);
      return prepare(query);
    }) as typeof sql.prepare;
    const reads: string[] = [];
    sql.setAuthorizer?.((action, table, column) => {
      if (action === SQLITE_READ && statements.at(-1)?.startsWith(HOME_QUERY_TAG)) reads.push(`${table}.${column}`);
      return SQLITE_OK;
    });
    try {
      await page(service, cookie);
    } finally {
      sql.prepare = prepare;
      sql.setAuthorizer?.(null);
    }
    assert.ok(statements.some((statement) => statement.startsWith(HOME_QUERY_TAG)));
    const allowed = new Set(Object.entries({ ...HOME_COLUMNS, json_each: ["value"] }).flatMap(([table, list]) => [...list, ""].map((column) => `${table}.${column}`)));
    for (const read of new Set(reads)) {
      const [table] = read.split(".");
      if (table === "null" || table === "undefined") continue;
      assert.ok(allowed.has(read), `reads ${read}`);
    }
  });
});

describe("person detail allowance", () => {
  it("shows each person's own level allowance, not the default", async () => {
    const { service } = await scenario({ BASIC_WEEKLY_TOKENS: "10000000", BASIC_WEEKLY_USD_CAP: "3", STARTER_WEEKLY_TOKENS: "2000000", STARTER_WEEKLY_USD_CAP: "0.5" });
    const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const detail = async (id: number) => (await (await service.request("GET", `/v1/admin/people/${id}`, { token: admin })).json()) as { level: string; allowance: { tokensPerWeek: number; usdPerWeek: number | null } };
    const basic = await detail(101);
    assert.equal(basic.level, "basic");
    assert.equal(basic.allowance.tokensPerWeek, 10_000_000);
    assert.equal(basic.allowance.usdPerWeek, 3);
    const starter = await detail(102);
    assert.equal(starter.allowance.tokensPerWeek, 2_000_000);
    assert.equal(starter.allowance.usdPerWeek, 0.5);
    const flagged = await detail(103);
    assert.equal(flagged.allowance.tokensPerWeek, 0);
    const full = await detail(100);
    assert.equal(full.level, "full");
    assert.equal(full.allowance.usdPerWeek, 20);
  });

  it("holds basic and Starter accounts to their own allowance in the full view's limits table", async () => {
    const { service, cookie } = await scenario({ BASIC_WEEKLY_USD_CAP: "3" });
    const rows = (await (await service.request("GET", "/admin/dashboard/limits.csv", { headers: { cookie } })).text()).trim().split("\r\n");
    const header = rows[0]!.split(",");
    const logins = rows.slice(1).map((row) => row.split(",")[header.indexOf("github_login")]);
    assert.deepEqual(logins, ["basicbo"]);
  });
});

describe("accessRequestAlerts", () => {
  const ask = async (service: Service, id: number) => {
    const { access_token: token } = await service.signIn({ id, login: `asker${id}`, createdAt: "2026-06-01T00:00:00Z", publicRepos: 0, contributions: 3 });
    const response = await service.request("POST", "/v1/access-request", { token, body: { building: "a CLI that turns CSV exports into plots" } });
    assert.equal(response.status, 201);
  };
  const alerts = (service: Service) => service.calls.webhooks.map((call) => JSON.stringify(call.body)).filter((text) => text.includes("access request"));
  const BAR = { OPEN_ADMISSION: "true", FULL_MIN_ACCOUNT_AGE_DAYS: "365", FULL_MIN_CONTRIBUTIONS: "100", FULL_MIN_PUBLIC_REPOS: "100000", NETWORK_SIGNUPS_PER_DAY: "1000", ALERT_WEBHOOK_URL: "https://alerts.test/hook", OPENAI_API_KEY: "sk-test" };

  it("is a runtime setting: each (the default), daily or off", () => {
    assert.equal(readFreeConfig({ ...BAR, GITHUB_CLIENT_ID: "x", GITHUB_CLIENT_SECRET: "y", TOKEN_SIGNING_KEY: "k".repeat(40) } as never).accessRequestAlerts, "each");
    assert.deepEqual(parseSettingsUpdate({ accessRequestAlerts: "daily" }), { changes: [{ key: "accessRequestAlerts", value: "daily" }] });
    assert.deepEqual(parseSettingsUpdate({ accessRequestAlerts: "off" }), { changes: [{ key: "accessRequestAlerts", value: "off" }] });
    assert.ok("error" in parseSettingsUpdate({ accessRequestAlerts: "hourly" }));
  });

  it("sends one alert per request by default", async () => {
    const service = await createService(BAR);
    await ask(service, 200);
    assert.equal(alerts(service).length, 1);
  });

  it("sends none with off, and with daily puts them in the daily digest", async () => {
    const off = await createService({ ...BAR, ACCESS_REQUEST_ALERTS: "off" });
    await ask(off, 200);
    assert.equal(alerts(off).length, 0);

    const service = await createService(BAR);
    const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    assert.equal((await service.request("POST", "/v1/admin/config", { token: admin, body: { accessRequestAlerts: "daily" } })).status, 200);
    await ask(service, 200);
    await ask(service, 201);
    assert.equal(alerts(service).length, 0);
    const { DIGEST_CRON } = await import("../src/app.js");
    const nextDay = Date.parse("2026-11-05T01:00:00Z");
    service.clock.now = nextDay;
    await (service.handler as unknown as { scheduled(controller: { cron: string; scheduledTime: number }, env: never): Promise<void> }).scheduled({ cron: DIGEST_CRON, scheduledTime: nextDay }, service.env as never);
    const digest = service.calls.webhooks.map((call) => JSON.stringify(call.body)).find((text) => text.includes("daily digest"));
    assert.ok(digest);
    assert.match(digest, /Access requests: 2 new, 2 waiting for an answer/);
    assert.match(digest, /@asker200, @asker201/);
    assert.doesNotMatch(digest, /CSV exports/);
  });
});
