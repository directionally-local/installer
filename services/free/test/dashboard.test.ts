import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { constants as sqliteConstants, type DatabaseSync } from "node:sqlite";
import { ADMIN_ID, createInvite, createService, errorCode, MODEL, NOW, type Service } from "./harness.js";

const DAY = 86_400_000;
/** SQLite's authorizer codes; node:sqlite's `constants` doesn't list them in every Node version. */
const SQLITE_OK = (sqliteConstants as Record<string, number>).SQLITE_OK ?? 0;
const SQLITE_READ = (sqliteConstants as Record<string, number>).SQLITE_READ ?? 20;
const at = (iso: string) => Date.parse(iso.length === 10 ? `${iso}T12:00:00Z` : iso);

/** The directory object's in-memory database and its live object. */
function directoryEntry(service: Service): { state: { db: DatabaseSync }; object: any } {
  service.directory();
  return service.namespaces.DIRECTORY!.instances.get("directory") as never;
}

/** The browser sign-in for the dashboard, up to the page after GitHub. */
async function browserSignIn(
  service: Service,
  user: { id: number; login: string },
  callbackPath = "/device/callback",
): Promise<{ response: Response; cookie: string | undefined; location: string }> {
  const start = await service.request("GET", "/admin/signin");
  assert.equal(start.status, 302);
  const location = start.headers.get("location")!;
  const state = new URL(location).searchParams.get("state")!;
  const oauthCookie = start.headers.get("set-cookie")!.split(";")[0]!;
  const response = await service.request("GET", `${callbackPath}?code=${encodeURIComponent(JSON.stringify(user))}&state=${encodeURIComponent(state)}`, {
    headers: { cookie: oauthCookie },
  });
  const session = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith("__Host-dl_admin="))
    ?.split(";")[0];
  return { response, cookie: session, location };
}

async function adminCookie(service: Service): Promise<string> {
  const { cookie } = await browserSignIn(service, { id: ADMIN_ID, login: "owner" });
  assert.ok(cookie);
  return cookie;
}

function parseCsv(text: string): Array<Record<string, string>> {
  const [header, ...rows] = text.trim().split("\r\n").map((line) => line.split(","));
  return rows.map((row) => Object.fromEntries(header!.map((name, index) => [name, row[index] ?? ""])));
}

async function csv(service: Service, cookie: string, table: string, query = ""): Promise<Array<Record<string, string>>> {
  const response = await service.request("GET", `/admin/dashboard/${table}.csv${query}`, { headers: { cookie } });
  assert.equal(response.status, 200, table);
  assert.match(response.headers.get("content-type")!, /^text\/csv/);
  assert.match(response.headers.get("content-disposition")!, /^attachment; filename="free-/);
  return parseCsv(await response.text());
}

describe("admin dashboard sign-in", () => {
  it("signs an admin in through GitHub with exactly the registered callback", async () => {
    const service = await createService();
    const signedOut = await service.request("GET", "/admin");
    assert.equal(signedOut.status, 401);
    assert.match(await signedOut.text(), /href="\/admin\/signin"/);

    const { response, cookie, location } = await browserSignIn(service, { id: ADMIN_ID, login: "owner" });
    const authorize = new URL(location);
    assert.equal(authorize.origin + authorize.pathname, "https://github.com/login/oauth/authorize");
    assert.equal(authorize.searchParams.get("redirect_uri"), "https://free.test/device/callback");
    assert.equal(service.calls.githubTokens.at(-1)?.redirect_uri, "https://free.test/device/callback");
    assert.equal(response.status, 200);
    assert.match(await response.text(), /http-equiv="refresh" content="0;url=\/admin"/);
    const setCookies = response.headers.getSetCookie();
    const session = setCookies.find((value) => value.startsWith("__Host-dl_admin="))!;
    for (const attribute of ["Path=/", "HttpOnly", "Secure", "SameSite=Strict", "Max-Age=3600"]) assert.ok(session.includes(attribute), attribute);
    assert.ok(setCookies.some((value) => value.startsWith("__Host-dl_admin_oauth=;") && value.includes("Max-Age=0")));

    const page = await service.request("GET", "/admin", { headers: { cookie: cookie! } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Signed in as <strong>owner<\/strong>/);
    assert.match(html, /Weekly active developers/);
  });

  it("refuses people who aren't admins, without a session", async () => {
    const service = await createService();
    const { response, cookie } = await browserSignIn(service, { id: 100, login: "alice" });
    assert.equal(response.status, 403);
    assert.equal(cookie, undefined);
  });

  it("needs the state with the browser that started it, once", async () => {
    const service = await createService();
    const start = await service.request("GET", "/admin/signin");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const oauthCookie = start.headers.get("set-cookie")!.split(";")[0]!;
    const code = encodeURIComponent(JSON.stringify({ id: ADMIN_ID, login: "owner" }));
    const otherBrowser = await service.request("GET", `/device/callback?code=${code}&state=${state}`, { headers: { cookie: "__Host-dl_admin_oauth=someone-else" } });
    assert.equal(otherBrowser.status, 400);
    // The failed attempt used the state up.
    const retried = await service.request("GET", `/device/callback?code=${code}&state=${state}`, { headers: { cookie: oauthCookie } });
    assert.equal(retried.status, 400);
    assert.equal(service.calls.githubTokens.length, 0);
  });

  it("can't replay an admin sign-in", async () => {
    const service = await createService();
    const start = await service.request("GET", "/admin/signin");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
    const path = `/device/callback?code=${encodeURIComponent(JSON.stringify({ id: ADMIN_ID, login: "owner" }))}&state=${state}`;
    const first = await service.request("GET", path, { headers: { cookie } });
    assert.equal(first.status, 200);
    assert.ok(first.headers.getSetCookie().some((value) => value.startsWith("__Host-dl_admin=")));
    const replay = await service.request("GET", path, { headers: { cookie } });
    assert.equal(replay.status, 400);
    assert.ok(!replay.headers.getSetCookie().some((value) => value.startsWith("__Host-dl_admin=")));
  });

  it("still finishes sign-ins at the old /device/callback/admin path", async () => {
    const service = await createService();
    const { response, cookie } = await browserSignIn(service, { id: ADMIN_ID, login: "owner" }, "/device/callback/admin");
    assert.equal(response.status, 200);
    assert.ok(cookie);
    assert.equal(service.calls.githubTokens.at(-1)?.redirect_uri, "https://free.test/device/callback/admin");
  });

  it("keeps the session cookie and bearer tokens apart, and expires the session", async () => {
    const service = await createService();
    const cookie = await adminCookie(service);
    const sessionToken = cookie.slice("__Host-dl_admin=".length);
    assert.equal((await service.request("GET", "/admin/people", { token: sessionToken })).status, 401);
    const accessToken = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    assert.equal((await service.request("GET", "/admin", { headers: { cookie: `__Host-dl_admin=${accessToken}` } })).status, 401);
    assert.equal((await service.request("GET", "/admin", { token: accessToken })).status, 200);
    service.clock.now += 3600_000 + 1000;
    assert.equal((await service.request("GET", "/admin", { headers: { cookie } })).status, 401);
  });

  it("stops a session when its id leaves ADMIN_GITHUB_IDS", async () => {
    const service = await createService();
    const cookie = await adminCookie(service);
    service.env.ADMIN_GITHUB_IDS = "2";
    assert.equal((await service.request("GET", "/admin", { headers: { cookie } })).status, 401);
  });

  it("signs out only from the site itself, and the cookie stops working", async () => {
    const service = await createService();
    const cookie = await adminCookie(service);
    const crossSite = await service.request("POST", "/admin/signout", { headers: { cookie, origin: "https://evil.example" } });
    assert.equal(crossSite.status, 403);
    assert.equal((await service.request("GET", "/admin", { headers: { cookie } })).status, 200);
    const out = await service.request("POST", "/admin/signout", { headers: { cookie, origin: "https://free.test" } });
    assert.equal(out.status, 303);
    assert.match(out.headers.get("set-cookie")!, /^__Host-dl_admin=; .*Max-Age=0/);
    assert.equal((await service.request("GET", "/admin", { headers: { cookie } })).status, 401);
  });

  it("serves the page and CSVs to an admin bearer token, and 403 to anyone else", async () => {
    const service = await createService();
    const adminToken = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const token = (await service.signIn({ id: 100, login: "alice" }, { invite: await createInvite(service, adminToken) })).access_token;
    const member = await service.request("GET", "/admin/dashboard/limits.csv", { token });
    assert.equal(member.status, 403);
    assert.equal(await errorCode(member), "forbidden");
    assert.equal((await service.request("GET", "/admin", { token })).status, 403);
    assert.equal((await service.request("GET", "/admin/dashboard/limits.csv", { token: adminToken })).status, 200);
    assert.equal((await service.request("GET", "/admin/dashboard/nope.csv", { token: adminToken })).status, 404);
    assert.equal((await service.request("GET", "/admin/dashboard/limits.csv")).status, 401);
  });
});

describe("admin dashboard page", () => {
  it("is plain HTML that works under a strict content security policy", async () => {
    const service = await createService();
    const response = await service.request("GET", "/admin", { headers: { cookie: await adminCookie(service) } });
    const csp = response.headers.get("content-security-policy")!;
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|script-src/);
    const nonce = /style-src 'nonce-([0-9a-f]+)'/.exec(csp)![1];
    const html = await response.text();
    assert.ok(html.includes(`<style nonce="${nonce}">`));
    assert.doesNotMatch(html, /<script|\sstyle="|<link|@import|url\(/i);
    assert.doesNotMatch(html, /(?:src|href)="(?:https?:)?\/\//i);
    assert.match(html, /name="viewport"/);
    assert.match(html, /color-scheme: light dark/);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});

describe("admin dashboard numbers", () => {
  /**
   * NOW is Wednesday 2026-11-04; this week started Monday 2026-11-02.
   * A (100) and B (101) signed up the week of 10-12, C (102) the week of 10-26.
   * The admin (1) is busy every day and must never show up.
   */
  async function scenario(): Promise<{ service: Service; cookie: string }> {
    const service = await createService({ PER_PERSON_WEEKLY_USD_CAP: "5" });
    const directory = service.directory();
    const admit = (githubId: number, login: string, when: string, isAdmin = false) =>
      directory.admit({ githubId, login, isAdmin, inviteCode: undefined, clientDeviceId: null, accountTooNew: false, openAdmission: true, maxActive: 100, now: at(when) });
    await admit(ADMIN_ID, "owner", "2026-10-12", true);
    await admit(100, "alice", "2026-10-12");
    await admit(101, "bob", "2026-10-13");
    await admit(102, "carol", "2026-10-26");
    const request = (githubId: number, when: string, costUsd: number, chargedTokens = 1000) =>
      directory.recordRequest({
        githubId,
        isAdmin: githubId === ADMIN_ID,
        at: at(when),
        model: MODEL,
        promptTokens: chargedTokens,
        completionTokens: 0,
        cachedTokens: 0,
        chargedTokens,
        costUsd,
        status: "ok",
        latencyMs: 100,
      });
    let eventId = 0;
    const event = (githubId: number, when: string) =>
      directory.recordEvents(githubId, [{ id: `e${++eventId}`, type: "session.start", sessionId: "s", at: at(when), props: {} }], NOW);

    // Week of 10-12: alice on three days, bob on one (an event).
    await request(100, "2026-10-12", 0.1);
    await request(100, "2026-10-13", 0.1);
    await event(100, "2026-10-14");
    await event(101, "2026-10-13");
    // Week of 10-19: alice once.
    await request(100, "2026-10-20", 0.2);
    // Week of 10-26: bob once; carol on three days (two things on the 26th count once).
    await request(101, "2026-10-27", 0.1);
    await request(102, "2026-10-26", 0.2);
    await event(102, "2026-10-26T18:00:00Z");
    await event(102, "2026-10-27");
    await request(102, "2026-10-29", 0.4);
    // This week: alice passes $5 on Tuesday; carol has a 1M-token grant and reaches 99% of it on Wednesday.
    await request(100, "2026-11-02", 3);
    await request(100, "2026-11-03", 2.5);
    await directory.recordGrant({ githubId: 102, tokensPerWeek: 1_000_000, usdPerWeek: undefined });
    await request(102, "2026-11-03", 0.2, 500_000);
    await request(102, "2026-11-04T09:00:00Z", 0.3, 495_000);
    // The admin, every day, heavily.
    for (let day = at("2026-10-12"); day <= NOW; day += DAY) {
      await request(ADMIN_ID, new Date(day).toISOString(), 50, 60_000_000);
      await event(ADMIN_ID, new Date(day).toISOString());
    }
    return { service, cookie: await adminCookie(service) };
  }

  it("counts weekly actives on 3+ days and on any day", async () => {
    const { service, cookie } = await scenario();
    const rows = await csv(service, cookie, "weekly-active");
    assert.equal(rows.length, 8);
    const byWeek = Object.fromEntries(rows.map((row) => [row.week_start, [Number(row.active_3_plus_days), Number(row.active_any_day)]]));
    assert.deepEqual(byWeek["2026-09-14"], [0, 0]);
    assert.deepEqual(byWeek["2026-10-12"], [1, 2]);
    assert.deepEqual(byWeek["2026-10-19"], [0, 1]);
    assert.deepEqual(byWeek["2026-10-26"], [1, 2]);
    assert.deepEqual(byWeek["2026-11-02"], [0, 2]);
  });

  it("shows retention by sign-up week for weeks that have ended", async () => {
    const { service, cookie } = await scenario();
    const rows = await csv(service, cookie, "retention");
    assert.deepEqual(
      rows.map((row) => [row.signup_week, row.people, row.week_1_active, row.week_1_share, row.week_2_active, row.week_2_share, row.week_4_active]),
      [
        ["2026-10-26", "1", "", "", "", "", ""],
        ["2026-10-12", "2", "1", "0.5", "1", "0.5", ""],
      ],
    );
  });

  it("reports cost per person per week with the median and the top 10", async () => {
    const { service, cookie } = await scenario();
    const weeks = Object.fromEntries((await csv(service, cookie, "weekly-cost")).map((row) => [row.week_start, row]));
    assert.equal(weeks["2026-11-02"]!.people, "2");
    assert.equal(Number(weeks["2026-11-02"]!.total_usd), 6);
    assert.equal(Number(weeks["2026-11-02"]!.median_usd_per_person), 3);
    assert.equal(Number(weeks["2026-10-26"]!.median_usd_per_person), 0.35);
    assert.equal(weeks["2026-10-19"]!.people, "1");
    const top = await csv(service, cookie, "top-cost");
    assert.deepEqual(top.map((row) => [row.week_start, row.rank, row.github_login, row.cost_usd]), [
      ["2026-11-02", "1", "alice", "5.5"],
      ["2026-11-02", "2", "carol", "0.5"],
    ]);
    const earlier = await csv(service, cookie, "top-cost", "?week=2026-10-26");
    assert.deepEqual(earlier.map((row) => row.github_login), ["carol", "bob"]);
  });

  it("lists who reached the token or dollar allowance, and on which day", async () => {
    const { service, cookie } = await scenario();
    const rows = await csv(service, cookie, "limits");
    assert.deepEqual(
      rows.map((row) => [row.week_start, row.github_login, row.reached_on, row.reached, row.token_allowance, row.usd_allowance]),
      [
        ["2026-11-02", "alice", "2026-11-03", "usd", "50000000", "5"],
        ["2026-11-02", "carol", "2026-11-04", "tokens", "1000000", "5"],
      ],
    );
    const html = await (await service.request("GET", "/admin", { headers: { cookie } })).text();
    assert.match(html, /Tue 2026-11-03/);
  });

  it("shows global spend against the caps, with admins kept apart", async () => {
    const { service, cookie } = await scenario();
    const [row] = await csv(service, cookie, "spend");
    assert.equal(Number(row!.week_usd), 6);
    assert.equal(row!.weekly_cap_usd, "250");
    assert.equal(row!.total_cap_usd, "1000");
    assert.ok(Number(row!.admin_week_usd) > 100);
    assert.equal(row!.paused, "false");
    assert.equal(row!.admitted, "3");
    const adminToken = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    await service.request("POST", "/admin/pause", { token: adminToken });
    const html = await (await service.request("GET", "/admin", { headers: { cookie } })).text();
    assert.match(html, /Paused for everyone/);
    assert.doesNotMatch(html, /<td>owner</);
  });

  it("builds the roll-up from an existing log the same as it keeps it", async () => {
    const { service } = await scenario();
    const entry = directoryEntry(service);
    const read = () => entry.state.db.prepare("SELECT * FROM daily_activity ORDER BY day, github_id").all();
    const live = read();
    assert.ok(live.length > 0);
    entry.state.db.exec("DELETE FROM daily_activity; DELETE FROM settings WHERE key = 'rollup:daily_activity'");
    entry.object = new entry.object.constructor(entry.state, service.env);
    assert.deepEqual(read(), live);
  });

  it("copies admin grants for the limit table", async () => {
    const service = await createService();
    const adminToken = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    await service.signIn({ id: 100, login: "alice" }, { invite: await createInvite(service, adminToken) });
    const grants = () => directoryEntry(service).state.db.prepare("SELECT * FROM grants").all().map((row) => ({ ...row }));
    await service.request("POST", "/admin/people/100/grant", { token: adminToken, body: { tokensPerWeek: 1_000_000 } });
    assert.deepEqual(grants(), [{ github_id: 100, weekly_tokens: 1_000_000, weekly_usd: null }]);
    await service.request("POST", "/admin/people/100/grant", { token: adminToken, body: { usdPerWeek: 2 } });
    assert.deepEqual(grants(), [{ github_id: 100, weekly_tokens: 1_000_000, weekly_usd: 2 }]);
    await service.request("POST", "/admin/people/100/grant", { token: adminToken, body: { tokensPerWeek: null, usdPerWeek: null } });
    assert.deepEqual(grants(), []);
  });
});

describe("admin dashboard install funnel", () => {
  it("shows scripts served → installs → sign-ups → first request → active, per day and per week, with a CSV", async () => {
    const service = await createService();
    const directory = service.directory();
    const post = async (kind: "download" | "install", body: Record<string, unknown>, when: string, times = 1) => {
      service.clock.now = at(when);
      for (let i = 0; i < times; i++) assert.equal((await service.request("POST", `/v1/telemetry/${kind}`, { body, ip: `192.0.2.${i}` })).status, 204);
    };
    const install = { os: "darwin", arch: "arm64", mode: "laptop", dlVersion: "0.13.0", result: "ok", via: "home" };
    await post("download", { route: "home", client: "curl" }, "2026-11-03", 5);
    await post("download", { route: "invite", client: "wget" }, "2026-11-03", 2);
    await post("download", { route: "run", client: "curl" }, "2026-11-04", 3);
    await post("download", { route: "home", client: "curl" }, "2026-10-28", 4);
    await post("install", install, "2026-11-03", 4);
    await post("install", { ...install, os: "linux", arch: "x64", mode: "server", result: "failed", failedStep: "dl_up" }, "2026-11-03", 2);
    await post("install", { ...install, result: "failed", failedStep: "node" }, "2026-11-04");
    service.clock.now = NOW;
    const admit = (githubId: number, login: string, when: string, isAdmin = false) =>
      directory.admit({ githubId, login, isAdmin, inviteCode: undefined, clientDeviceId: null, accountTooNew: false, openAdmission: true, maxActive: 100, now: at(when) });
    await admit(ADMIN_ID, "owner", "2026-11-03", true);
    await admit(100, "alice", "2026-11-03");
    await admit(101, "bob", "2026-11-03");
    await admit(102, "carol", "2026-10-28");
    const request = (githubId: number, when: string) =>
      directory.recordRequest({ githubId, isAdmin: githubId === ADMIN_ID, at: at(when), model: MODEL, promptTokens: 10, completionTokens: 0, cachedTokens: 0, chargedTokens: 10, costUsd: 0.01, status: "ok", latencyMs: 100 });
    await request(100, "2026-11-03");
    await request(100, "2026-11-04");
    await request(102, "2026-10-28");
    await request(102, "2026-10-29");
    await request(102, "2026-10-30");
    await request(102, "2026-11-04");
    await request(ADMIN_ID, "2026-11-03");

    const cookie = await adminCookie(service);
    const rows = await csv(service, cookie, "install-funnel");
    const row = (period: string, start: string) => rows.find((r) => r.period === period && r.start === start)!;
    assert.equal(rows.filter((r) => r.period === "day").length, 14);
    assert.equal(rows.filter((r) => r.period === "week").length, 8);
    assert.deepEqual(row("day", "2026-11-03"), {
      period: "day", start: "2026-11-03", scripts_served: "7", served_home: "5", served_invite: "2", served_private_invite: "0", served_continue: "0", served_run: "0",
      installs_ok: "4", installs_failed: "2", signed_up: "2", first_request: "1", active: "1",
    });
    assert.deepEqual(
      [row("day", "2026-11-04").scripts_served, row("day", "2026-11-04").installs_failed, row("day", "2026-11-04").active],
      ["3", "1", "2"],
    );
    const thisWeek = row("week", "2026-11-02");
    assert.deepEqual([thisWeek.scripts_served, thisWeek.installs_ok, thisWeek.installs_failed, thisWeek.signed_up, thisWeek.first_request, thisWeek.active], ["10", "4", "3", "2", "1", "0"]);
    const lastWeek = row("week", "2026-10-26");
    assert.deepEqual([lastWeek.scripts_served, lastWeek.signed_up, lastWeek.first_request, lastWeek.active], ["4", "1", "1", "1"], "carol: 3 request days");

    const installs = await csv(service, cookie, "installs");
    assert.deepEqual(
      installs.map((r) => [r.kind, r.os, r.arch, r.mode, r.step, r.ok, r.failed]),
      [
        ["system", "darwin", "arm64", "laptop", "", "4", "1"],
        ["system", "linux", "x64", "server", "", "0", "2"],
        ["failed_step", "", "", "", "dl_up", "", "2"],
        ["failed_step", "", "", "", "node", "", "1"],
      ],
    );

    const html = await (await service.request("GET", "/admin", { headers: { cookie } })).text();
    assert.match(html, /<h2>Funnel<\/h2>/);
    assert.match(html, /Anonymous counts: one per script served/);
    assert.match(html, /can't be joined to people/);
    assert.match(html, /Server setup \(dl up\)<\/td><td>2</);
    assert.match(html, /macOS arm64<\/td><td>laptop<\/td><td>4<\/td><td>1</);
    assert.match(html, /install-funnel\.csv/);
    assert.match(html, /<h3>By sign-up week<\/h3>/);
  });
});

describe("admin dashboard privacy", () => {
  // Columns that hold anything but counts, tokens, cost, time or who: never read by the dashboard.
  const FORBIDDEN = ["props", "session_id", "type", "model", "status", "received_at", "latency_ms", "note", "code_hash", "device_id", "old_value", "new_value", "changed_by_login"];
  const TABLES = new Set(["daily_activity", "people", "grants", "spend_weeks", "settings", "json_each", "queue", "queue_runs", "referrals", "subscriptions", "payments", "upstream_daily", "upstream_timings", "download_daily", "install_daily"]);

  it("reads only allowed tables and columns", async () => {
    const { DASHBOARD_COLUMNS } = await import("../src/dashboard-data.js");
    const service = await createService();
    const cookie = await adminCookie(service);
    const { state } = directoryEntry(service);
    const db = state.db as DatabaseSync & { setAuthorizer?: (callback: ((...args: unknown[]) => number) | null) => void };

    // Every statement the Directory runs while the page and the CSVs are served.
    const statements: string[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = ((query: string) => {
      statements.push(query);
      return prepare(query);
    }) as typeof db.prepare;
    // Where node:sqlite has it, SQLite itself reports each column read.
    const reads: string[] = [];
    db.setAuthorizer?.((action, table, column) => {
      if (action === SQLITE_READ) reads.push(`${table}.${column}`);
      return SQLITE_OK;
    });
    try {
      assert.equal((await service.request("GET", "/admin", { headers: { cookie } })).status, 200);
      for (const table of ["spend", "weekly-active", "retention", "weekly-cost", "top-cost", "limits", "queue", "referrals", "funnel", "install-funnel", "installs", "paid", "upstreams"]) await csv(service, cookie, table);
    } finally {
      db.prepare = prepare;
      db.setAuthorizer?.(null);
    }

    assert.ok(statements.length > 0);
    for (const statement of statements) {
      const code = statement.replace(/'[^']*'/g, "''");
      for (const word of FORBIDDEN) assert.doesNotMatch(code, new RegExp(`\\b${word}\\b`, "i"), `${word} in: ${statement}`);
      const ctes = new Set([...code.matchAll(/\b(\w+)\s+AS\s*\(/gi)].map((match) => match[1]!.toLowerCase()));
      for (const match of code.matchAll(/\b(?:FROM|JOIN)\s+(\w+)/gi)) {
        const table = match[1]!.toLowerCase();
        assert.ok(TABLES.has(table) || ctes.has(table), `table ${table} in: ${statement}`);
      }
    }
    if (db.setAuthorizer) {
      assert.ok(reads.length > 0);
      const allowed = new Set(Object.entries({ ...DASHBOARD_COLUMNS, json_each: ["value"] }).flatMap(([table, columns]) => [...columns, ""].map((column) => `${table}.${column}`)));
      for (const read of new Set(reads)) {
        const [table] = read.split(".");
        if (table === "null" || table === "undefined") continue; // subquery and CTE columns
        assert.ok(allowed.has(read), `reads ${read}`);
      }
    }
  });
});

describe("admin dashboard speed", () => {
  it("loads in under 2 seconds with 5,000 accounts and 1M request rows", { timeout: 300_000 }, async () => {
    const service = await createService();
    const cookie = await adminCookie(service);
    const entry = directoryEntry(service);
    const db = entry.state.db;

    const PEOPLE = 5000;
    const REQUESTS = 1_000_000;
    const EVENTS = 200_000;
    const span = 12 * 7 * DAY;
    const start = NOW - span;
    // mulberry32: small, seeded, and good enough to spread rows over people and days.
    let seed = 42;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    const generated = performance.now();
    db.exec("BEGIN");
    const person = db.prepare("INSERT INTO people (github_id, login, status, admitted_at, admitted_via) VALUES (?, ?, 'active', ?, 'invite:1')");
    for (let index = 0; index < PEOPLE; index++) person.run(10_000 + index, `dev-${index}`, start + Math.floor(random() * span));
    const insertRequest = db.prepare(
      `INSERT INTO requests (github_id, is_admin, at, model, prompt_tokens, completion_tokens, cached_tokens, charged_tokens, cost_usd, status, latency_ms)
       VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, 'ok', ?)`,
    );
    for (let index = 0; index < REQUESTS; index++) {
      // A skewed mix: a few heavy users, a long tail.
      const who = 10_000 + Math.floor(PEOPLE * random() ** 2);
      const prompt = 2000 + Math.floor(random() * 60_000);
      const cached = Math.floor(prompt * random());
      const out = Math.floor(random() * 4000);
      const charged = prompt - cached + out + Math.ceil(cached * 0.02);
      insertRequest.run(who, start + Math.floor(random() * span), MODEL, prompt, out, cached, charged, charged * 3e-7, 800 + Math.floor(random() * 4000));
    }
    const insertEvent = db.prepare("INSERT INTO events (github_id, id, type, session_id, at, props, received_at) VALUES (?, ?, 'turn', 's', ?, '{}', ?)");
    for (let index = 0; index < EVENTS; index++) insertEvent.run(10_000 + Math.floor(PEOPLE * random()), `e${index}`, start + Math.floor(random() * span), NOW);
    db.exec("COMMIT");
    const generateMs = performance.now() - generated;

    // A deploy of this code on an existing log: the roll-up is built once, as the object starts.
    db.exec("DELETE FROM daily_activity; DELETE FROM settings WHERE key = 'rollup:daily_activity'");
    const backfill = performance.now();
    entry.object = new entry.object.constructor(entry.state, service.env);
    const backfillMs = performance.now() - backfill;

    const timings: Record<string, number> = {};
    const time = async (name: string, path: string) => {
      const began = performance.now();
      const response = await service.request("GET", path, { headers: { cookie } });
      const body = await response.text();
      timings[name] = Math.round(performance.now() - began);
      assert.equal(response.status, 200, `${name}: ${body.slice(0, 200)}`);
      return body;
    };
    const html = await time("page", "/admin");
    await time("page again", "/admin");
    for (const table of ["weekly-active", "retention", "weekly-cost", "top-cost", "limits"]) await time(`${table}.csv`, `/admin/dashboard/${table}.csv`);

    const rows = (db.prepare("SELECT COUNT(*) AS n FROM daily_activity").get() as { n: number }).n;
    console.log(
      `dashboard speed: ${PEOPLE} people, ${REQUESTS} requests, ${EVENTS} events generated in ${Math.round(generateMs)} ms; ` +
        `roll-up of ${rows} rows built in ${Math.round(backfillMs)} ms; ${JSON.stringify(timings)}`,
    );
    assert.match(html, /dev-\d+/);
    assert.ok(timings.page! < 2000, `page took ${timings.page} ms`);
    assert.ok(timings["page again"]! < 2000);
  });
});
