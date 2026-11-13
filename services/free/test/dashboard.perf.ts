// Speed checks for the admin dashboard on large, generated data sets. They time
// wall-clock page renders, so they depend on the machine: they are kept out of
// `npm test` (and so out of prepublish and the release's publish job) and run with
// `npm run test:perf`, which CI runs as a non-blocking job.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { ADMIN_ID, createService, MODEL, NOW, type Service } from "./harness.js";

const DAY = 86_400_000;
const REPO_HASH = "ab".repeat(32);

/** The directory object's in-memory database and its live object. */
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

    // A deploy of this code on an existing log: the roll-ups are built once, as the object starts.
    db.exec("DELETE FROM daily_activity; DELETE FROM person_totals; DELETE FROM settings WHERE key IN ('rollup:daily_activity', 'rollup:upstream_tokens_people', 'rollup:person_totals')");
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
    const home = await time("home", "/admin");
    await time("home again", "/admin");
    for (const table of ["weekly-active", "retention", "weekly-cost", "top-cost", "limits"]) await time(`${table}.csv`, `/admin/dashboard/${table}.csv`);

    const rows = (db.prepare("SELECT COUNT(*) AS n FROM daily_activity").get() as { n: number }).n;
    console.log(
      `dashboard speed: ${PEOPLE} people, ${REQUESTS} requests, ${EVENTS} events generated in ${Math.round(generateMs)} ms; ` +
        `roll-up of ${rows} rows built in ${Math.round(backfillMs)} ms; ${JSON.stringify(timings)}`,
    );
    assert.match(home, /Total Users/);
    assert.equal([...home.matchAll(/<tr data-q="dev-\d+">/g)].length, PEOPLE);
    assert.ok(timings.home! < 2000, `home took ${timings.home} ms`);
    assert.ok(timings["home again"]! < 2000);
  });
});

describe("admin health CSV speed", () => {
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
      // Each health CSV reads the whole window (health-data.ts), as the Health page did.
      const response = await service.request("GET", `/admin/dashboard/health-sessions.csv?days=${days}`, { headers: { cookie } });
      await response.text();
      assert.equal(response.status, 200);
      timings[`${days}d`] = Math.round(performance.now() - began);
    }
    console.log(`health speed: ${events} events, ${REQUESTS} requests; ${JSON.stringify(timings)}`);
    assert.ok(timings["7d"]! < 2000, `7 days took ${timings["7d"]} ms`);
    assert.ok(timings["30d"]! < 4000, `30 days took ${timings["30d"]} ms`);
  });
});
