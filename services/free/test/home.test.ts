import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { constants as sqliteConstants, type DatabaseSync } from "node:sqlite";
import { ADMIN_ID, createService, MODEL, NOW, type Service } from "./harness.js";
import { adminCookie } from "./admin-web.js";
import { ADMIN_HOME_COLUMNS, ADMIN_HOME_QUERY_TAG, realAllowance, type AdminHomeData, type LevelSettings } from "../src/admin-home-data.js";
import { CSV_TABLES } from "../src/dashboard-page.js";
import { parseSettingsUpdate } from "../src/runtime-config.js";
import { readFreeConfig } from "../src/config.js";

/**
 * The admin home (GET /admin): the old Kimiflare Cloud admin dashboard's data in dl's model.
 * Stat cards, platform health, the paid row, the users table (sortable, searchable), the
 * personal caps (active and ended) and usage per day, week and month. Plus each person's real
 * allowance by level and the accessRequestAlerts setting. NOW is Wednesday 2026-11-04 12:00 UTC.
 */

const DAY = 86_400_000;
const SQLITE_OK = (sqliteConstants as Record<string, number>).SQLITE_OK ?? 0;
const SQLITE_READ = (sqliteConstants as Record<string, number>).SQLITE_READ ?? 20;

describe("home: real allowance per level", () => {
  const settings: LevelSettings = { weeklyTokens: 50_000_000, perPersonWeeklyUsd: 20, basicWeeklyTokens: 10_000_000, basicWeeklyUsd: 3, starterWeeklyTokens: 2_000_000, starterWeeklyUsd: 0.5 };
  const person = (level: string | null, extra: Partial<{ batchFlagged: boolean; grantTokens: number | null; grantUsd: number | null }> = {}) => ({ level, batchFlagged: false, grantTokens: null, grantUsd: null, ...extra });

  it("gives each level its own tokens and dollars, not the default 50M and $20", () => {
    // Without DeepSeek settings, DeepSeek's budget is the GPT-6 one.
    assert.deepEqual(realAllowance(person("full"), settings), { tier: "full", tokens: 50_000_000, usd: 20, deepseekUsd: 20 });
    assert.deepEqual(realAllowance(person(null), settings), { tier: "full", tokens: 50_000_000, usd: 20, deepseekUsd: 20 });
    assert.deepEqual(realAllowance(person("basic"), settings), { tier: "middle", tokens: 10_000_000, usd: 3, deepseekUsd: 3 });
    assert.deepEqual(realAllowance(person("starter"), settings), { tier: "small", tokens: 2_000_000, usd: 0.5, deepseekUsd: 0.5 });
    assert.deepEqual(realAllowance(person("starter", { batchFlagged: true }), settings), { tier: "no tokens", tokens: 0, usd: 0, deepseekUsd: 0 });
    // Basic switched off is served as Starter; Starter at 0 tokens is no tokens.
    assert.deepEqual(realAllowance(person("basic"), { ...settings, basicWeeklyTokens: 0 }), { tier: "small", tokens: 2_000_000, usd: 0.5, deepseekUsd: 0.5 });
    assert.deepEqual(realAllowance(person("starter"), { ...settings, starterWeeklyTokens: 0 }), { tier: "no tokens", tokens: 0, usd: 0, deepseekUsd: 0 });
    // An admin's grant sets Full's tokens and any level's GPT-6 dollars; DeepSeek gets the larger of the grant and its own.
    assert.deepEqual(realAllowance(person("full", { grantTokens: 80_000_000, grantUsd: 40 }), settings), { tier: "full", tokens: 80_000_000, usd: 40, deepseekUsd: 40 });
    assert.deepEqual(realAllowance(person("basic", { grantTokens: 80_000_000, grantUsd: 5 }), settings), { tier: "middle", tokens: 10_000_000, usd: 5, deepseekUsd: 5 });
    const two = { ...settings, perPersonWeeklyUsd: 2, deepseekWeeklyUsd: 8 };
    assert.deepEqual(realAllowance(person("full"), two), { tier: "full", tokens: 50_000_000, usd: 2, deepseekUsd: 8 });
    assert.deepEqual(realAllowance(person("full", { grantUsd: 20 }), two), { tier: "full", tokens: 50_000_000, usd: 20, deepseekUsd: 20 });
    assert.deepEqual(realAllowance(person("full", { grantUsd: 5 }), two), { tier: "full", tokens: 50_000_000, usd: 5, deepseekUsd: 8 });
  });
});

// ─── The page ─────────────────────────────────────────────────────────────

// GPT-6 budgets pinned per level; DeepSeek keeps its default ($8). Pro: $6 GPT-6, $40 DeepSeek.
const VARS = {
  OPENAI_API_KEY: "sk-test",
  LUMINAL_API_KEY: "lm-test",
  OPEN_ADMISSION: "true",
  ALERT_WEBHOOK_URL: "https://alerts.test/hook",
  PER_PERSON_WEEKLY_USD_CAP: "20",
  BASIC_WEEKLY_TOKENS: "10000000",
  BASIC_WEEKLY_USD_CAP: "3",
  STARTER_WEEKLY_TOKENS: "5000000",
  STARTER_WEEKLY_USD_CAP: "0.5",
};

function db(service: Service): DatabaseSync {
  service.directory();
  return (service.namespaces.DIRECTORY!.instances.get("directory") as { state: { db: DatabaseSync } }).state.db;
}

/**
 * The owner (an admin) and six people: fullfay (Full, a $5 personal cap, two networks), basicbo
 * (Basic, a $2 cap set and then removed), smallsam (Starter), flaggedfy (batch-flagged Starter),
 * propat (Pro) and blockbea (blocked, with a $4 cap). Requests this week and last week.
 */
async function scenario(vars: Record<string, string> = {}): Promise<{ service: Service; cookie: string }> {
  const service = await createService({ ...VARS, ...vars });
  const directory = service.directory();
  const admit = (githubId: number, login: string, isAdmin = false, days = 10) =>
    directory.admit({ githubId, login, isAdmin, inviteCode: undefined, clientDeviceId: null, accountTooNew: false, openAdmission: true, maxActive: 100, now: NOW - days * DAY });
  await admit(ADMIN_ID, "owner", true, 30);
  await admit(100, "fullfay", false, 20);
  await admit(101, "basicbo", false, 15);
  await admit(102, "smallsam", false, 10);
  await admit(103, "flaggedfy", false, 9);
  await admit(104, "propat", false, 8);
  await admit(105, "blockbea", false, 7);
  const sql = db(service);
  sql.exec("UPDATE people SET level = 'basic' WHERE github_id = 101");
  sql.exec("UPDATE people SET level = 'starter' WHERE github_id IN (102, 103)");
  sql.exec("UPDATE people SET batch_flag = 1 WHERE github_id = 103");
  const request = (githubId: number, input: { costUsd: number; at?: number; model?: string; prompt?: number; completion?: number; paid?: boolean }) =>
    directory.recordRequest({
      githubId,
      isAdmin: githubId === ADMIN_ID,
      at: input.at ?? NOW - 3_600_000,
      model: input.model ?? "gpt-6-luna",
      promptTokens: input.prompt ?? 1000,
      completionTokens: input.completion ?? 100,
      cachedTokens: 0,
      chargedTokens: input.prompt ?? 1000,
      costUsd: input.costUsd,
      status: "ok",
      latencyMs: 100,
      ...(input.paid ? { paid: true } : {}),
    });
  await request(ADMIN_ID, { costUsd: 99, prompt: 1_000_000, completion: 500_000 });
  await request(100, { costUsd: 1.4, prompt: 4000, completion: 400 });
  await request(100, { costUsd: 0.5, at: NOW - 8 * DAY, model: MODEL, prompt: 30_000, completion: 3000 }); // DeepSeek, last week
  await request(101, { costUsd: 0.6, at: NOW - 2 * DAY, prompt: 2000, completion: 200 });
  await request(104, { costUsd: 0.3, prompt: 700, completion: 70, paid: true });
  // Personal caps: one active, one set and removed, one on an account that gets blocked.
  await directory.recordGrant({ githubId: 100, tokensPerWeek: undefined, usdPerWeek: 5, at: NOW - 2 * DAY });
  await directory.recordGrant({ githubId: 101, tokensPerWeek: undefined, usdPerWeek: 2, at: NOW - 5 * DAY });
  await directory.recordGrant({ githubId: 101, tokensPerWeek: undefined, usdPerWeek: null, at: NOW - DAY });
  await directory.recordGrant({ githubId: 105, tokensPerWeek: undefined, usdPerWeek: 4, at: NOW - 3 * DAY });
  await directory.setPersonStatus(105, "blocked", { githubId: ADMIN_ID, login: "owner", now: NOW - DAY });
  await directory.mirrorSubscription({ githubId: 104, state: "active", periodEnd: NOW + 20 * DAY, eventAt: NOW - 3 * DAY });
  await directory.recordPayment({ id: "in_pro", githubId: 104, kind: "pro", amountCents: 399, at: NOW - 3 * DAY });
  await directory.recordPayment({ id: "cs_topup", githubId: 102, kind: "topup", amountCents: 500, at: NOW - 2 * DAY });
  await directory.countFeedback(NOW - 2 * DAY);
  await directory.countFeedback(NOW - DAY);
  sql.exec("INSERT INTO person_networks (github_id, net_hash, first_at) VALUES (100, 'aaa', 0), (100, 'bbb', 0), (101, 'aaa', 0)");
  return { service, cookie: await adminCookie(service) };
}

const page = async (service: Service, cookie: string, path = "/admin") => {
  const response = await service.request("GET", path, { headers: { cookie } });
  assert.equal(response.status, 200);
  return response.text();
};

/** The users table's rows: each cell's text, keyed by the row's login. */
function userRows(html: string): Map<string, string[]> {
  const body = /<table id="users">[^]*?<tbody>([^]*?)<\/tbody>/.exec(html)![1]!;
  const rows = [...body.matchAll(/<tr data-q="[^"]*">([^]*?)<\/tr>/g)].map((match) =>
    [...match[1]!.matchAll(/<td[^>]*>([^]*?)<\/td>/g)].map((cell) => cell[1]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()),
  );
  return new Map(rows.map((cells) => [cells[0]!.split(" ")[0]!, cells]));
}

/** A stat card's value by its label. */
const card = (html: string, label: string) => new RegExp(`<div class="stat"><b>([^<]*)</b><span>${label}</span>`).exec(html)?.[1];
const quick = (html: string, label: string) => new RegExp(`<div><b>([^<]*)</b><span>${label}</span></div>`).exec(html)?.[1];

describe("home: the data", () => {
  it("adds up each person's all-time use, this week's spend and plan, admins marked and left out of the totals", async () => {
    const { service } = await scenario();
    const data = (await service.directory().adminHome({ now: NOW, adminIds: [ADMIN_ID] })) as AdminHomeData;
    const user = (login: string) => data.users.find((row) => row.login === login)!;
    assert.deepEqual(
      data.users.map((row) => row.login),
      ["blockbea", "propat", "flaggedfy", "smallsam", "basicbo", "fullfay", "owner"],
    );
    const fay = user("fullfay");
    assert.deepEqual(
      { prompt: fay.promptTokens, completion: fay.completionTokens, requests: fay.requests, last: fay.lastActiveAt, grant: fay.grantUsd, networks: fay.networks, plan: fay.plan, admin: fay.admin },
      { prompt: 34_000, completion: 3400, requests: 2, last: NOW - 3_600_000, grant: 5, networks: 2, plan: "free", admin: false },
    );
    assert.equal(Math.round(fay.costUsd * 100), 190);
    assert.equal(Math.round(fay.weekGptUsd * 100), 140);
    assert.equal(fay.weekDeepseekUsd, 0);
    assert.equal(user("propat").plan, "pro");
    assert.equal(user("blockbea").status, "blocked");
    assert.equal(user("owner").admin, true);
    assert.equal(user("owner").promptTokens, 1_000_000);
    assert.equal(user("smallsam").requests, 0);
    assert.equal(user("smallsam").lastActiveAt, null);

    assert.equal(data.totalUsers, 7);
    assert.equal(data.blockedUsers, 1);
    assert.deepEqual(data.totals, { promptTokens: 36_700, completionTokens: 3670, costUsd: data.totals.costUsd, requests: 4 });
    assert.equal(Math.round(data.totals.costUsd * 100), 280);
    // The last 7 days: fullfay's GPT-6, basicbo's and propat's requests; not last week's, not the admin's.
    assert.deepEqual(data.last7, { promptTokens: 6700, completionTokens: 670 });
    assert.deepEqual(data.subscriptions, { active: 1, pastDue: 0, canceled: 0 });
    assert.deepEqual(data.payments, { topups: 1, topupCents: 500, proCents: 399 });
    assert.deepEqual(data.feedback, { total: 2, sinceDay: Math.floor((NOW - 2 * DAY) / DAY) });
  });

  it("lists active caps with when they were set, and ended ones: removed, or on a blocked account", async () => {
    const { service } = await scenario();
    const data = (await service.directory().adminHome({ now: NOW, adminIds: [ADMIN_ID] })) as AdminHomeData;
    assert.deepEqual(
      data.activeGrants.map((row) => [row.login, row.weeklyUsd, row.setAt, row.endedHow]),
      [["fullfay", 5, NOW - 2 * DAY, null]],
    );
    assert.deepEqual(
      data.endedGrants.map((row) => [row.login, row.weeklyUsd, row.setAt, row.endedAt, row.endedHow]),
      [
        ["basicbo", 2, NOW - 5 * DAY, NOW - DAY, "removed"],
        ["blockbea", 4, NOW - 3 * DAY, null, "blocked"],
      ],
    );
    // A raise replaces the open entry.
    await service.directory().recordGrant({ githubId: 100, tokensPerWeek: undefined, usdPerWeek: 20, at: NOW - 3_600_000 });
    const after = (await service.directory().adminHome({ now: NOW, adminIds: [ADMIN_ID] })) as AdminHomeData;
    assert.deepEqual(after.activeGrants.map((row) => [row.login, row.weeklyUsd, row.setAt]), [["fullfay", 20, NOW - 3_600_000]]);
    assert.deepEqual(after.endedGrants[0] && [after.endedGrants[0].login, after.endedGrants[0].weeklyUsd, after.endedGrants[0].endedHow], ["fullfay", 5, "replaced"]);
    // The same cap again changes nothing.
    await service.directory().recordGrant({ githubId: 100, tokensPerWeek: undefined, usdPerWeek: 20, at: NOW });
    assert.equal(((await service.directory().adminHome({ now: NOW, adminIds: [ADMIN_ID] })) as AdminHomeData).endedGrants.length, 3);
  });

  it("sums usage per day, week and month, admins left out", async () => {
    const { service } = await scenario();
    const { usage } = (await service.directory().adminHome({ now: NOW, adminIds: [ADMIN_ID] })) as AdminHomeData;
    assert.equal(usage.day.length, 30);
    assert.equal(usage.week.length, 12);
    assert.equal(usage.month.length, 12);
    const day = (iso: string) => usage.day.find((row) => row.start === Date.parse(`${iso}T00:00:00Z`))!;
    assert.deepEqual(day("2026-11-04"), { start: Date.parse("2026-11-04T00:00:00Z"), promptTokens: 4700, completionTokens: 470, requests: 2 });
    assert.deepEqual(day("2026-11-02"), { start: Date.parse("2026-11-02T00:00:00Z"), promptTokens: 2000, completionTokens: 200, requests: 1 });
    assert.deepEqual(usage.week.at(-1), { start: Date.parse("2026-11-02T00:00:00Z"), promptTokens: 6700, completionTokens: 670, requests: 3 });
    assert.deepEqual(usage.week.at(-2), { start: Date.parse("2026-10-26T00:00:00Z"), promptTokens: 30_000, completionTokens: 3000, requests: 1 });
    assert.deepEqual(usage.month.at(-1), { start: Date.parse("2026-11-01T00:00:00Z"), promptTokens: 6700, completionTokens: 670, requests: 3 });
    assert.deepEqual(usage.month.at(-2), { start: Date.parse("2026-10-01T00:00:00Z"), promptTokens: 30_000, completionTokens: 3000, requests: 1 });
    assert.equal(usage.month[0]!.start, Date.parse("2025-12-01T00:00:00Z"));
  });

  it("builds per-person totals and daily tokens from an existing log once, the same as it keeps them", async () => {
    const { service } = await scenario();
    const entry = service.namespaces.DIRECTORY!.instances.get("directory") as { state: { db: DatabaseSync }; object: any };
    const sql = entry.state.db;
    const read = () => ({
      totals: sql.prepare("SELECT * FROM person_totals ORDER BY github_id").all().map((row) => ({ ...row })),
      daily: sql.prepare("SELECT day, github_id, prompt_tokens, completion_tokens FROM daily_activity ORDER BY day, github_id").all().map((row) => ({ ...row })),
    });
    const live = read();
    assert.equal(live.totals.length, 4);
    sql.exec("DELETE FROM person_totals; DELETE FROM settings WHERE key = 'rollup:person_totals'; UPDATE daily_activity SET prompt_tokens = 0, completion_tokens = 0");
    // The columns as if just added: drop them, then start again.
    sql.exec("ALTER TABLE daily_activity DROP COLUMN prompt_tokens; ALTER TABLE daily_activity DROP COLUMN completion_tokens");
    entry.object = new entry.object.constructor(entry.state, service.env);
    assert.deepEqual(read(), live);
  });
});

describe("home: the page", () => {
  it("shows the stat cards, platform health and the paid row", async () => {
    const { service, cookie } = await scenario();
    const html = await page(service, cookie);
    assert.equal(card(html, "Total Users"), "7");
    assert.equal(card(html, "Active Grants"), "1");
    assert.match(card(html, "Global Budget")!, /^\$\d+\.\d\d \/ (\$[\d,.]+|no cap)$/);
    assert.equal(card(html, "Est. Cost"), "$2.80");
    assert.equal(card(html, "Feedback"), "2");
    assert.equal(card(html, "7-Day Prompts"), "6.7k");
    assert.match(html, /<h2>Platform Health<\/h2>/);
    assert.equal(quick(html, "Total Cost"), "$2.80");
    assert.equal(quick(html, "Total Tokens"), "40.4k");
    assert.equal(quick(html, "Paying Users"), "1");
    assert.equal(quick(html, "Active"), "1");
    assert.equal(quick(html, "Past Due"), "0");
    assert.equal(quick(html, "Canceled"), "0");
    assert.equal(quick(html, "MRR"), "$3.99");
    assert.equal(quick(html, "Top-ups"), "1");
    assert.equal(quick(html, "Top-up Revenue"), "$5.00");
    // The old home and views are gone; Tools is linked.
    assert.doesNotMatch(html, /Are we OK|Who's using it|Is anything broken|What needs me|view=simple|view=full|view=health/);
    assert.match(html, /<nav class="views" aria-label="Admin pages"><a href="\/admin" aria-current="page">Home<\/a><a href="\/admin\?view=tools">Tools<\/a><\/nav>/);
  });

  it("lists every user with plan, grant limit, use, remaining, networks and dates", async () => {
    const { service, cookie } = await scenario();
    const rows = userRows(await page(service, cookie));
    assert.equal(rows.size, 7);
    // User, Plan, Grant Limit, Input Used, Remaining, Output, Cost, Requests, Last Active, Networks, Joined.
    assert.deepEqual(rows.get("fullfay"), ["fullfay", "Free", "$5.00 own DeepSeek $8.00", "34k", "$3.60 DeepSeek $8.00", "3.4k", "$1.90", "2", "Nov 4, 2026", "2", "Oct 15, 2026"]);
    assert.deepEqual(rows.get("basicbo"), ["basicbo", "Free", "$3.00 DeepSeek $8.00", "2k", "$2.40 DeepSeek $8.00", "200", "$0.60", "1", "Nov 2, 2026", "1", "Oct 20, 2026"]);
    assert.deepEqual(rows.get("flaggedfy")!.slice(1, 5), ["Free", "$0.00 DeepSeek $0.00", "0", "$0.00 DeepSeek $0.00"]);
    assert.deepEqual(rows.get("propat")!.slice(1, 8), ["Pro", "$6.00 DeepSeek $40.00", "700", "—", "70", "$0.30", "1"]);
    assert.deepEqual(rows.get("blockbea")!.slice(1, 5), ["Blocked", "$4.00 own DeepSeek $8.00", "0", "—"]);
    assert.deepEqual(rows.get("owner")!.slice(0, 2), ["owner Admin", "Free"]);
    assert.deepEqual(rows.get("smallsam")!.slice(7, 9), ["0", "—"]);
  });

  it("sorts every column and searches, with a nonce'd script the CSP allows and no inline styles", async () => {
    const { service, cookie } = await scenario();
    const response = await service.request("GET", "/admin", { headers: { cookie } });
    const html = await response.text();
    const heads = [...html.matchAll(/<th(?: class="l")? data-type="([ns])"[^>]*><button type="button">([^<]+)<\/button><\/th>/g)].map((match) => `${match[2]}:${match[1]}`);
    assert.deepEqual(heads, ["User:s", "Plan:s", "Grant Limit:n", "Input Used:n", "Remaining:n", "Output:n", "Cost:n", "Requests:n", "Last Active:n", "Networks:n", "Joined:n"]);
    assert.match(html, /<th data-type="n" aria-sort="descending"><button type="button">Joined<\/button><\/th>/);
    assert.match(html, /<td data-v="34000">34k<\/td>/);
    assert.match(html, /<input type="search" id="user-search" class="search" placeholder="Search users" aria-label="Search users" autocomplete="off" hidden>/);
    const csp = response.headers.get("content-security-policy")!;
    const nonce = /script-src 'nonce-([0-9a-f]{32})'/.exec(csp)?.[1];
    assert.ok(nonce, csp);
    assert.match(csp, new RegExp(`style-src 'nonce-${nonce}'`));
    assert.doesNotMatch(csp, /unsafe-inline/);
    assert.equal([...html.matchAll(/<script/g)].length, 1);
    assert.match(html, new RegExp(`<script nonce="${nonce}">`));
    assert.doesNotMatch(html, /\sstyle="/);
    // Day / Week / Month without a script.
    assert.match(html, /<input type="radio" name="period" id="p-day" checked><input type="radio" name="period" id="p-week"><input type="radio" name="period" id="p-month">/);
    for (const kind of ["day", "week", "month"]) assert.match(html, new RegExp(`<div class="panel ${kind}">`));
    assert.match(html, /<title>Nov 4: 4,700 input, 470 output, 2 requests<\/title>/);
    // The Tools page has no script.
    const tools = await service.request("GET", "/admin?view=tools", { headers: { cookie } });
    assert.doesNotMatch(tools.headers.get("content-security-policy")!, /script-src/);
    assert.doesNotMatch(await tools.text(), /<script/);
  });

  it("escapes logins", async () => {
    const { service, cookie } = await scenario();
    db(service).exec(`UPDATE people SET login = '<img src=x onerror="alert(1)">' WHERE github_id = 102`);
    const html = await page(service, cookie);
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /<tr data-q="&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;">/);
    assert.match(html, /<td data-v="&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;">&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;<\/td>/);
  });

  it("shows active and ended grants", async () => {
    const { service, cookie } = await scenario();
    const html = await page(service, cookie);
    const section = /<section class="card" id="grants">([^]*?)<\/section>/.exec(html)![1]!;
    assert.match(section, /<h2>Active Grants <span class="n">\(1\)<\/span><\/h2>/);
    assert.match(section, /<tr><td>fullfay<\/td><td>\$5\.00<\/td><td>—<\/td><td>Nov 2, 2026<\/td><\/tr>/);
    assert.match(section, /<h2 class="gap">Expired \/ Revoked <span class="n">\(2\)<\/span><\/h2>/);
    assert.match(section, /<tr><td>basicbo<\/td><td>\$2\.00<\/td><td>—<\/td><td>Oct 30, 2026<\/td><td>Nov 3, 2026<\/td><td class="l">removed<\/td><\/tr>/);
    assert.match(section, /<tr><td>blockbea<\/td><td>\$4\.00<\/td><td>—<\/td><td>Nov 1, 2026<\/td><td>—<\/td><td class="l">blocked<\/td><\/tr>/);
  });

  it("is the page for any view but Tools, and every CSV still downloads", async () => {
    const { service, cookie } = await scenario();
    const strip = (html: string) => html.replace(/[0-9a-f]{32}/g, "");
    const home = strip(await page(service, cookie));
    for (const view of ["simple", "full", "health", "nope"]) assert.equal(strip(await page(service, cookie, `/admin?view=${view}`)), home, view);
    for (const table of CSV_TABLES) {
      const response = await service.request("GET", `/admin/dashboard/${table}.csv`, { headers: { cookie } });
      assert.equal(response.status, 200, table);
      assert.match(response.headers.get("content-type")!, /^text\/csv/, table);
    }
    assert.equal((await service.request("GET", "/admin/dashboard/nope.csv", { headers: { cookie } })).status, 404);
  });

  it("is for admins only", async () => {
    const { service } = await scenario();
    const signedOut = await service.request("GET", "/admin");
    assert.equal(signedOut.status, 401);
    assert.doesNotMatch(await signedOut.text(), /fullfay|Total Users/);
    const member = (await service.signIn({ id: 100, login: "fullfay" })).access_token;
    const refused = await service.request("GET", "/admin", { token: member });
    assert.equal(refused.status, 403);
    assert.doesNotMatch(await refused.text(), /Total Users/);
    const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const bearer = await service.request("GET", "/admin", { token: admin });
    assert.equal(bearer.status, 200);
    const html = await bearer.text();
    assert.match(html, /Total Users/);
    assert.doesNotMatch(html, /name="csrf"|Sign out/);
  });

  it("reads only its own columns, every query tagged, and never the request log", async () => {
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
      if (action === SQLITE_READ && statements.at(-1)?.startsWith(ADMIN_HOME_QUERY_TAG)) reads.push(`${table}.${column}`);
      return SQLITE_OK;
    });
    try {
      await page(service, cookie);
    } finally {
      sql.prepare = prepare;
      sql.setAuthorizer?.(null);
    }
    assert.ok(statements.some((statement) => statement.startsWith(ADMIN_HOME_QUERY_TAG)));
    const allowed = new Set(Object.entries(ADMIN_HOME_COLUMNS).flatMap(([table, list]) => [...list, ""].map((column) => `${table}.${column}`)));
    for (const read of new Set(reads)) {
      const [table] = read.split(".");
      if (table === "null" || table === "undefined") continue;
      assert.ok(allowed.has(read), `reads ${read}`);
    }
    assert.ok(!reads.some((read) => read.startsWith("requests.") || read.startsWith("people.email")));
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

  it("holds basic and Starter accounts to their own allowance in the limits CSV", async () => {
    const { service, cookie } = await scenario({ BASIC_WEEKLY_USD_CAP: "3" });
    // basicbo reaches its $3: $0.60 on Monday and $2.40 now.
    await service.directory().recordRequest({ githubId: 101, isAdmin: false, at: NOW - 3_600_000, model: "gpt-6-luna", promptTokens: 1000, completionTokens: 0, cachedTokens: 0, chargedTokens: 1000, costUsd: 2.4, status: "ok", latencyMs: 100 });
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
