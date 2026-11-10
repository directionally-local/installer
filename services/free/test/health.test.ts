import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { constants as sqliteConstants, type DatabaseSync } from "node:sqlite";
import { ADMIN_ID, createInvite, createService, errorCode, MODEL, NOW, type Service } from "./harness.js";
import { cleanEvent } from "../src/events.js";

const DAY = 86_400_000;
const SQLITE_OK = (sqliteConstants as Record<string, number>).SQLITE_OK ?? 0;
const SQLITE_READ = (sqliteConstants as Record<string, number>).SQLITE_READ ?? 20;
const at = (iso: string) => Date.parse(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
const REPO_HASH = "ab".repeat(32);
const OTHER_MODEL = "openai/gpt-6-mini";

function directoryEntry(service: Service): { state: { db: DatabaseSync }; object: any } {
  service.directory();
  return service.namespaces.DIRECTORY!.instances.get("directory") as never;
}

async function adminCookie(service: Service): Promise<string> {
  const start = await service.request("GET", "/admin/signin");
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const oauthCookie = start.headers.get("set-cookie")!.split(";")[0]!;
  const response = await service.request("GET", `/device/callback?code=${encodeURIComponent(JSON.stringify({ id: ADMIN_ID, login: "owner" }))}&state=${encodeURIComponent(state)}`, {
    headers: { cookie: oauthCookie },
  });
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-dl_admin="))
    ?.split(";")[0];
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
  return parseCsv(await response.text());
}

/**
 * NOW is 2026-11-04 12:00 UTC; the 7-day window starts 10-28 12:00.
 * alice (100): s1 (3.5.0 macOS) three turns, an error, a PR, ended "exit"; s2 opened an hour ago, nothing since.
 * bob (101): s3 (3.4.0 Linux) one aborted turn, an error, then nothing (no end, two days old);
 * s4 opened and cleared with no turn; s5 on 10-20 (3.3.0), only in the 30-day window.
 * The admin (1) has a session, an error, tools and failed requests that must never show.
 */
async function scenario(): Promise<{ service: Service; cookie: string }> {
  const service = await createService();
  const directory = service.directory();
  const admit = (githubId: number, login: string, isAdmin = false) =>
    directory.admit({ githubId, login, isAdmin, inviteCode: undefined, clientDeviceId: null, accountTooNew: false, openAdmission: true, maxActive: 100, now: at("2026-10-01") });
  await admit(ADMIN_ID, "owner", true);
  await admit(100, "alice");
  await admit(101, "bob");

  let id = 0;
  const event = (githubId: number, sessionId: string, type: string, when: string, props: Record<string, unknown> = {}) => {
    const clean = cleanEvent({ id: `e${++id}`, type, sessionId, at: new Date(at(when)).toISOString(), props }, NOW);
    assert.ok(clean);
    return directory.recordEvents(githubId, [clean], NOW);
  };
  const start = (githubId: number, sessionId: string, when: string, autopilotVersion: string, os: string, model = MODEL) =>
    event(githubId, sessionId, "session.start", when, { model, provider: "directionally-local", autopilotVersion, os, repoHash: REPO_HASH });

  await start(100, "s1", "2026-11-03T10:00:00Z", "3.5.0", "darwin");
  await event(100, "s1", "turn.end", "2026-11-03T10:05:00Z", { turns: 1, toolCalls: { bash: 2, read: 1 }, durationMs: 1000, exitReason: "complete" });
  await event(100, "s1", "pr.opened", "2026-11-03T10:06:00Z", { repoHash: REPO_HASH });
  await event(100, "s1", "turn.end", "2026-11-03T10:07:00Z", { turns: 2, toolCalls: { bash: 1 }, durationMs: 1000, exitReason: "complete" });
  await event(100, "s1", "error", "2026-11-03T10:08:00Z", { errorCode: "http_429", model: MODEL });
  await event(100, "s1", "turn.end", "2026-11-03T10:08:00Z", { turns: 3, toolCalls: { edit: 1 }, durationMs: 1000, exitReason: "error" });
  await event(100, "s1", "session.end", "2026-11-03T10:10:00Z", { turns: 3, toolCalls: { bash: 3, read: 1, edit: 1 }, durationMs: 600_000, exitReason: "exit", repoHash: REPO_HASH });
  await start(100, "s2", "2026-11-04T11:00:00Z", "3.5.0", "darwin");

  await start(101, "s3", "2026-11-02T09:00:00Z", "3.4.0", "linux");
  await event(101, "s3", "error", "2026-11-02T09:01:00Z", { errorCode: "http_429" });
  await event(101, "s3", "turn.end", "2026-11-02T09:01:00Z", { turns: 1, toolCalls: { bash: 4 }, durationMs: 1000, exitReason: "aborted" });
  await start(101, "s4", "2026-11-01T09:00:00Z", "3.4.0", "linux");
  await event(101, "s4", "session.end", "2026-11-01T09:00:05Z", { turns: 0, durationMs: 5000, exitReason: "clear" });
  await start(101, "s5", "2026-10-20T09:00:00Z", "3.3.0", "linux");
  await event(101, "s5", "turn.end", "2026-10-20T09:01:00Z", { turns: 1, toolCalls: { bash: 1 }, exitReason: "complete" });
  await event(101, "s5", "session.end", "2026-10-20T09:02:00Z", { turns: 1, durationMs: 120_000, exitReason: "exit" });

  await start(ADMIN_ID, "s9", "2026-11-03T08:00:00Z", "3.6.0", "darwin", "admin/model");
  await event(ADMIN_ID, "s9", "error", "2026-11-03T08:01:00Z", { errorCode: "admin_only_error" });
  await event(ADMIN_ID, "s9", "turn.end", "2026-11-03T08:01:00Z", { turns: 1, toolCalls: { admin_tool: 9 }, exitReason: "guardrail" });

  const request = (githubId: number, when: string, status: string, model = MODEL) =>
    directory.recordRequest({ githubId, isAdmin: githubId === ADMIN_ID, at: at(when), model, promptTokens: 10, completionTokens: 0, cachedTokens: 0, chargedTokens: 10, costUsd: 0.001, status, latencyMs: 100 });
  for (let i = 0; i < 3; i++) await request(100, "2026-11-03", "ok");
  await request(100, "2026-11-03", "upstream_busy");
  await request(101, "2026-11-02", "stream_error", OTHER_MODEL);
  for (let i = 0; i < 5; i++) await request(ADMIN_ID, "2026-11-03", "upstream_error", "admin/model");

  const install = async (body: Record<string, unknown>, times: number) => {
    service.clock.now = at("2026-11-03");
    for (let i = 0; i < times; i++) assert.equal((await service.request("POST", "/v1/telemetry/install", { body, ip: `192.0.2.${i}` })).status, 204);
  };
  const base = { os: "darwin", arch: "arm64", mode: "laptop", dlVersion: "0.23.0", result: "ok", via: "home" };
  await install(base, 4);
  await install({ ...base, os: "linux", mode: "server" }, 2);
  await install({ ...base, os: "linux", mode: "server", result: "failed", failedStep: "node" }, 3);
  service.clock.now = NOW;
  return { service, cookie: await adminCookie(service) };
}

describe("admin dashboard health view", () => {
  it("computes errors, ends, versions, sessions, tools, models and installs, admins left out", async () => {
    const { service, cookie } = await scenario();

    assert.deepEqual(
      (await csv(service, cookie, "health-errors")).map((row) => [row.error_code, row.count, row.people, row.autopilot_version, row.version_count]),
      [
        ["http_429", "2", "2", "3.5.0", "1"],
        ["http_429", "2", "2", "3.4.0", "1"],
      ],
    );
    assert.deepEqual(
      (await csv(service, cookie, "health-request-failures")).map((row) => [row.status, row.model, row.failed, row.share_of_model_requests]),
      [
        ["stream_error", OTHER_MODEL, "1", "1"],
        ["upstream_busy", MODEL, "1", "0.25"],
      ],
    );

    const ends = await csv(service, cookie, "health-ends");
    assert.deepEqual(
      ends.filter((row) => row.autopilot_version === "all").map((row) => [row.end, row.sessions, row.share, row.normal]),
      [
        ["(no end event)", "1", "0.25", "false"],
        ["(open)", "1", "0.25", "true"],
        ["clear", "1", "0.25", "true"],
        ["exit", "1", "0.25", "true"],
      ],
    );
    assert.deepEqual(
      ends.filter((row) => row.autopilot_version === "3.4.0").map((row) => [row.os, row.end, row.sessions, row.share]),
      [
        ["linux", "(no end event)", "1", "0.5"],
        ["linux", "clear", "1", "0.5"],
      ],
    );
    assert.deepEqual(
      (await csv(service, cookie, "health-turns")).map((row) => [row.turn_end, row.turns, row.normal]),
      [
        ["complete", "2", "true"],
        ["aborted", "1", "false"],
        ["error", "1", "false"],
      ],
    );

    assert.deepEqual(
      (await csv(service, cookie, "health-versions")).map((row) => [row.kind, row.value, row.sessions, row.people, row.newest]),
      [
        ["autopilot_version", "3.5.0", "2", "1", "true"],
        ["autopilot_version", "3.4.0", "2", "1", "false"],
        ["os", "darwin", "2", "1", ""],
        ["os", "linux", "2", "1", ""],
      ],
    );

    assert.deepEqual((await csv(service, cookie, "health-sessions"))[0], {
      sessions: "4",
      people: "2",
      ended: "2",
      turns_median: "0",
      turns_p90: "3",
      duration_median_ms: "5000",
      duration_p90_ms: "600000",
      zero_turn_sessions: "2",
      prs_opened: "1",
      prs_per_100_sessions: "25",
    });

    // From turn.end only: session.end's repeat of s1's counts isn't added again.
    assert.deepEqual(
      (await csv(service, cookie, "health-tools")).map((row) => [row.tool, row.calls, row.sessions_using, row.share_of_sessions]),
      [
        ["bash", "7", "2", "1"],
        ["edit", "1", "1", "0.5"],
        ["read", "1", "1", "0.5"],
      ],
    );

    assert.deepEqual(
      (await csv(service, cookie, "health-models")).map((row) => [row.kind, row.model, row.count, row.failed]),
      [
        ["sessions", MODEL, "4", ""],
        ["requests", MODEL, "4", "1"],
        ["requests", OTHER_MODEL, "1", "1"],
      ],
    );
    assert.deepEqual(
      (await csv(service, cookie, "health-upstreams")).map((row) => row.upstream),
      ["openai", "luminal", "openrouter"],
    );

    assert.deepEqual(
      (await csv(service, cookie, "health-installs")).map((row) => [row.kind, row.os, row.mode, row.step, row.ok, row.failed, row.fail_share, row.top_failed_step]),
      [
        ["system", "linux", "server", "", "2", "3", "0.6", "node"],
        ["system", "darwin", "laptop", "", "4", "0", "0", ""],
        ["failed_step", "", "", "node", "", "3", "", ""],
      ],
    );

    // 30 days: bob's older session counts too.
    const month = (await csv(service, cookie, "health-sessions", "?days=30"))[0]!;
    assert.equal(month.sessions, "5");
    assert.ok((await csv(service, cookie, "health-versions", "?days=30")).some((row) => row.value === "3.3.0"));
    // 1 day: only s2 (an hour ago).
    assert.equal((await csv(service, cookie, "health-sessions", "?days=1"))[0]!.sessions, "1");
    // Anything else is 7 days.
    assert.equal((await csv(service, cookie, "health-sessions", "?days=9999"))[0]!.sessions, "4");
  });

  it("renders the page with takeaways, the window switch and the CSV links, and nothing of the admin's or the repo", async () => {
    const { service, cookie } = await scenario();
    const response = await service.request("GET", "/admin?view=health", { headers: { cookie } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.doesNotMatch(html, /<script|\sstyle="/i);
    assert.match(html, /<a href="\/admin\?view=health" aria-current="page">Health<\/a>/);
    assert.match(html, /<a href="\/admin\?view=simple">Simple<\/a>/);
    assert.match(html, /<a href="\/admin\?view=health&amp;days=7" aria-current="page">7 days<\/a>/);
    assert.match(html, /<a href="\/admin\?view=health&amp;days=30">30 days<\/a>/);
    for (const title of ["Errors", "Crashes and abnormal ends", "Versions", "Sessions", "Tools", "Models", "Installs"]) assert.match(html, new RegExp(`<h2>${title}</h2>`));
    assert.match(html, /Top error http_429: 2 times, 2 people, mostly from 3\.(4|5)\.0\./);
    assert.match(html, /40% of 5 requests failed, most as /);
    assert.match(html, /25% of sessions ended without a normal exit/);
    assert.match(html, /50% of turns ended in an error, guardrail or abort\./);
    assert.match(html, /50% of sessions on the newest version, 3\.5\.0/);
    assert.match(html, /Median session: 0 turns, 5\.0 s\. 50% were opened and left with no turn\. 25\.0 PRs per 100 sessions\./);
    assert.match(html, /bash is called most \(78% of calls\), in 100% of sessions\./);
    assert.match(html, /Linux arm64 server installs fail 60%, mostly at the Node\.js step\./);
    assert.match(html, /<tr class="bad"><td>\(no end event\) <span class="status blocked">abnormal<\/span>/);
    assert.match(html, /href="\/admin\/dashboard\/health-tools\.csv\?days=7" download/);
    for (const hidden of ["admin_only_error", "admin_tool", "admin/model", "3.6.0", REPO_HASH, "repoHash"]) assert.ok(!html.includes(hidden), hidden);
    for (const table of ["health-errors", "health-tools", "health-models", "health-versions"]) {
      const text = await (await service.request("GET", `/admin/dashboard/${table}.csv`, { headers: { cookie } })).text();
      for (const hidden of ["admin_only_error", "admin_tool", "admin/model", "3.6.0", REPO_HASH]) assert.ok(!text.includes(hidden), `${hidden} in ${table}`);
    }

    // The other views carry the fourth switch too.
    for (const view of ["simple", "full", "tools"]) {
      assert.match(await (await service.request("GET", `/admin?view=${view}`, { headers: { cookie } })).text(), /<a href="\/admin\?view=health">Health<\/a>/, view);
    }
  });

  it("renders with no data at all", async () => {
    const service = await createService();
    const html = await (await service.request("GET", "/admin?view=health&days=1", { headers: { cookie: await adminCookie(service) } })).text();
    assert.match(html, /Autopilot reported no errors\./);
    assert.match(html, /No tool calls reported\./);
    assert.match(html, /No installs counted\./);
  });

  it("is for admins only", async () => {
    const service = await createService();
    const adminToken = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const token = (await service.signIn({ id: 100, login: "alice" }, { invite: await createInvite(service, adminToken) })).access_token;
    const member = await service.request("GET", "/admin?view=health", { token });
    assert.equal(member.status, 403);
    assert.equal(await errorCode(member), "forbidden");
    assert.equal((await service.request("GET", "/admin/dashboard/health-errors.csv", { token })).status, 403);
    const signedOut = await service.request("GET", "/admin?view=health");
    assert.equal(signedOut.status, 401);
    assert.doesNotMatch(await signedOut.text(), /<h2>Errors<\/h2>/);
    assert.equal((await service.request("GET", "/admin/dashboard/health-errors.csv")).status, 401);
    assert.equal((await service.request("GET", "/admin?view=health", { token: adminToken })).status, 200);
    assert.equal((await service.request("GET", "/admin/dashboard/health-sessions.csv?days=30", { token: adminToken })).status, 200);
  });

  it("reads only HEALTH_COLUMNS, named props fields and never repoHash", async () => {
    const { HEALTH_COLUMNS, HEALTH_QUERY_TAG } = await import("../src/health-data.js");
    const { HEALTH_CSV_TABLES } = await import("../src/dashboard-page.js");
    const { service, cookie } = await scenario();
    const { state } = directoryEntry(service);
    const db = state.db as DatabaseSync & { setAuthorizer?: (callback: ((...args: unknown[]) => number) | null) => void };
    const statements: string[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = ((query: string) => {
      statements.push(query);
      return prepare(query);
    }) as typeof db.prepare;
    const reads: string[] = [];
    db.setAuthorizer?.((action, table, column) => {
      if (action === SQLITE_READ && statements.at(-1)?.startsWith(HEALTH_QUERY_TAG)) reads.push(`${table}.${column}`);
      return SQLITE_OK;
    });
    try {
      assert.equal((await service.request("GET", "/admin?view=health&days=30", { headers: { cookie } })).status, 200);
      for (const table of HEALTH_CSV_TABLES) await csv(service, cookie, table);
    } finally {
      db.prepare = prepare;
      db.setAuthorizer?.(null);
    }
    const health = statements.filter((statement) => statement.startsWith(HEALTH_QUERY_TAG));
    assert.ok(health.length > 0);
    for (const statement of health) {
      assert.doesNotMatch(statement, /repoHash|received_at|latency_ms|\bnote\b|device_id/i, statement);
      // props is read only through json_extract of a named field, or json_each of toolCalls.
      const code = statement.replace(/json_extract\(\w+\.?props, '\$\.(model|os|autopilotVersion|exitReason|errorCode|turns|durationMs)'\)/g, "").replace(/json_extract\(props, '\$\.(model|os|autopilotVersion|exitReason|errorCode|turns|durationMs)'\)/g, "").replace(/json_each\(\w+\.props, '\$\.toolCalls'\)/g, "");
      assert.doesNotMatch(code, /\bprops\b/, statement);
    }
    if (db.setAuthorizer) {
      assert.ok(reads.length > 0);
      const allowed = new Set(Object.entries({ ...HEALTH_COLUMNS, json_each: ["value", "key"] }).flatMap(([table, list]) => [...list, ""].map((column) => `${table}.${column}`)));
      for (const read of new Set(reads)) {
        const [table] = read.split(".");
        if (table === "null" || table === "undefined") continue;
        assert.ok(allowed.has(read), `reads ${read}`);
      }
    }
  });

  it("stays fast on a month of events", { timeout: 300_000 }, async () => {
    const service = await createService();
    const cookie = await adminCookie(service);
    const { state } = directoryEntry(service);
    const db = state.db;
    const PEOPLE = 2000;
    const SESSIONS = 40_000;
    const REQUESTS = 300_000;
    const span = 60 * DAY;
    let seed = 7;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    db.exec("BEGIN");
    const person = db.prepare("INSERT INTO people (github_id, login, status, admitted_at, admitted_via) VALUES (?, ?, 'active', ?, 'invite:1')");
    for (let i = 0; i < PEOPLE; i++) person.run(10_000 + i, `dev-${i}`, NOW - span);
    const insert = db.prepare("INSERT INTO events (github_id, id, type, session_id, at, props, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    let events = 0;
    const tools = ["bash", "read", "edit", "write", "grep", "web_fetch"];
    for (let s = 0; s < SESSIONS; s++) {
      const who = 10_000 + Math.floor(PEOPLE * random());
      const startAt = NOW - Math.floor(random() * span);
      const sid = `s${s}`;
      insert.run(who, `e${events++}`, "session.start", sid, startAt, JSON.stringify({ model: MODEL, autopilotVersion: `3.${Math.floor(random() * 6)}.0`, os: random() < 0.5 ? "darwin" : "linux", repoHash: REPO_HASH }), NOW);
      const turns = Math.floor(random() * 12);
      for (let t = 0; t < turns; t++) {
        const calls: Record<string, number> = {};
        for (const tool of tools) if (random() < 0.4) calls[tool] = 1 + Math.floor(random() * 5);
        insert.run(who, `e${events++}`, "turn.end", sid, startAt + t * 60_000, JSON.stringify({ turns: t + 1, toolCalls: calls, durationMs: 30_000, exitReason: random() < 0.9 ? "complete" : "error" }), NOW);
        if (random() < 0.05) insert.run(who, `e${events++}`, "error", sid, startAt + t * 60_000, JSON.stringify({ errorCode: `http_${random() < 0.5 ? 429 : 500}` }), NOW);
      }
      if (random() < 0.8) insert.run(who, `e${events++}`, "session.end", sid, startAt + turns * 60_000, JSON.stringify({ turns, durationMs: turns * 60_000, exitReason: "exit" }), NOW);
    }
    const request = db.prepare(
      `INSERT INTO requests (github_id, is_admin, at, model, prompt_tokens, completion_tokens, cached_tokens, charged_tokens, cost_usd, status, latency_ms) VALUES (?, 0, ?, ?, 10, 10, 0, 20, 0.0001, ?, 100)`,
    );
    for (let i = 0; i < REQUESTS; i++) request.run(10_000 + Math.floor(PEOPLE * random()), NOW - Math.floor(random() * span), MODEL, random() < 0.97 ? "ok" : "upstream_busy");
    db.exec("COMMIT");

    const timings: Record<string, number> = {};
    for (const days of [1, 7, 30]) {
      const began = performance.now();
      const response = await service.request("GET", `/admin?view=health&days=${days}`, { headers: { cookie } });
      await response.text();
      assert.equal(response.status, 200);
      timings[`${days}d`] = Math.round(performance.now() - began);
    }
    console.log(`health speed: ${events} events, ${REQUESTS} requests; ${JSON.stringify(timings)}`);
    assert.ok(timings["7d"]! < 2000, `7 days took ${timings["7d"]} ms`);
    assert.ok(timings["30d"]! < 4000, `30 days took ${timings["30d"]} ms`);
  });
});
