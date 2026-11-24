import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { ADMIN_ID, createService, errorCode, MODEL, NOW, type Service } from "./harness.js";
import { PROBE_CRON } from "../src/probes.js";
import { DL_ONLY_MIN_REQUESTS, outsideDl } from "../src/abuse.js";
import { trustFacts } from "../src/gpt6-trust.js";
import { readFreeConfig } from "../src/config.js";

// After the harness: it resolves cloudflare:workers.
const { DirectoryObject, PRUNE_BATCH_ROWS } = await import("../src/directory-object.js");

/**
 * The raw request log and session events keep RAW_LOG_KEEP_DAYS whole UTC days; everything that
 * looks further back reads rollups. Pruning must change no admin number and no request-time
 * decision (the dl-only check, GPT-6 trust).
 */

const DAY = 86_400_000;
/** Old activity: the week of NOW (a Wednesday), 60 days before "today". */
const OLD = NOW;
const TODAY = NOW + 60 * DAY;

function entry(service: Service): { state: { db: DatabaseSync; storage: { sql: never } } } {
  service.directory();
  return service.namespaces.DIRECTORY!.instances.get("directory") as never;
}
const db = (service: Service) => entry(service).state.db;
const sql = (service: Service) => entry(service).state.storage.sql;
const count = (service: Service, table: string) => (db(service).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

async function scheduled(service: Service, cron: string, at = service.clock.now): Promise<void> {
  await (service.handler as unknown as { scheduled(controller: { cron: string; scheduledTime: number }, env: never): Promise<void> }).scheduled({ cron, scheduledTime: at }, service.env as never);
}

async function fixture(vars: Record<string, string> = {}) {
  const service = await createService({ SPEED_PROBES: "false", ...vars });
  const directory = service.directory();
  const admit = (githubId: number, at: number) =>
    directory.admit({ githubId, login: `p${githubId}`, isAdmin: true, inviteCode: undefined, clientDeviceId: null, accountTooNew: false, maxActive: 50, now: at });
  for (const id of [ADMIN_ID, 10, 11, 12, 13]) await admit(id, OLD - DAY);
  const record = (githubId: number, at: number, options: { prompt?: number; cached?: number; out?: number; cost?: number; latency?: number; status?: string; isAdmin?: boolean } = {}) =>
    directory.recordRequest({
      githubId,
      isAdmin: options.isAdmin ?? false,
      at,
      model: MODEL,
      promptTokens: options.prompt ?? 1000,
      completionTokens: options.out ?? 10,
      cachedTokens: options.cached ?? 100,
      chargedTokens: (options.prompt ?? 1000) + (options.out ?? 10),
      costUsd: options.cost ?? 0.01,
      status: options.status ?? "ok",
      latencyMs: options.latency ?? 200,
    });
  // 60 days ago: 10 works in dl (a 6-turn session, a PR); 11 has an error; the admin; 12 uses
  // free tokens outside dl (no session events); 13 only sends events.
  for (let i = 0; i < 3; i++) await record(10, OLD + i * 60_000, { latency: 100 + i * 100 });
  await record(11, OLD + DAY, { status: "upstream_error", cost: 0.05 });
  await record(ADMIN_ID, OLD + 3_600_000, { cost: 0.5, isAdmin: true });
  for (let i = 0; i < DL_ONLY_MIN_REQUESTS; i++) await record(12, OLD + 2 * DAY + i * 1000);
  await directory.recordEvents(
    10,
    [
      { id: "start", type: "session.start", sessionId: "s1", at: OLD, props: {} },
      ...Array.from({ length: 6 }, (_, i) => ({ id: `turn${i}`, type: "turn.end", sessionId: "s1", at: OLD + i, props: {} })),
      { id: "end", type: "session.end", sessionId: "s1", at: OLD + 600_000, props: { durationMs: 600_000, turns: 6 } },
      { id: "pr", type: "pr.opened", sessionId: "s1", at: OLD + 700_000, props: {} },
    ],
    OLD + 700_000,
  );
  await directory.recordEvents(11, [{ id: "err", type: "error", sessionId: "t", at: OLD + DAY + 1000, props: { errorCode: "x" } }], OLD + DAY + 1000);
  await directory.recordEvents(13, [{ id: "e13", type: "session.start", sessionId: "u", at: OLD + 3 * DAY, props: {} }], OLD + 3 * DAY);
  // Recent: 10 and 11 again, inside the kept days.
  await record(10, TODAY - 2 * DAY, { latency: 900 });
  await record(11, TODAY - DAY, { latency: 50 });
  await directory.recordEvents(10, [{ id: "recent", type: "session.start", sessionId: "s2", at: TODAY - 2 * DAY, props: {} }], TODAY - 2 * DAY);
  service.clock.now = TODAY;
  const adminToken = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  return { service, directory, adminToken, record };
}

/** Every admin view that reads the raw log or its rollups, without what is allowed to differ. */
async function views(service: Service, adminToken: string) {
  const metrics = (await (await service.request("GET", "/admin/metrics?from=2026-10-01&to=2027-01-03", { token: adminToken })).json()) as Record<string, unknown>;
  const { storage, generatedAt, ...rest } = metrics;
  void generatedAt;
  const people: Record<number, unknown> = {};
  for (const id of [10, 11, 12, 13]) {
    const detail = (await (await service.request("GET", `/admin/people/${id}`, { token: adminToken })).json()) as { events: { recent: unknown[] } };
    // The latest 20 events are raw: only the kept ones are listed.
    people[id] = { ...detail, events: { ...detail.events, recent: undefined } };
  }
  // The admin page, without its per-response nonce.
  const home = (await (await service.request("GET", "/admin", { token: adminToken })).text()).replace(/nonce="[^"]*"/g, 'nonce=""');
  const candidates = await service.directory().userEmailCandidates(service.clock.now);
  return { metrics: rest, storage: storage as Record<string, any>, people, home, candidates };
}

describe("raw log retention", () => {
  it("keeps every admin number, the dl-only check and GPT-6 trust the same after pruning", async () => {
    const { service, adminToken } = await fixture();
    const before = await views(service, adminToken);
    const dlOnlyBefore = [10, 11, 12, 13].map((id) => outsideDl(sql(service), id, TODAY));
    const trustBefore = trustFacts(sql(service), TODAY);
    assert.deepEqual(dlOnlyBefore, [false, false, true, false], "12 used free tokens outside dl");
    assert.equal(trustBefore.get(10)!.multiTurn, true);
    assert.equal(before.storage.rows.requests, 27);
    assert.equal(before.storage.oldestRequestAt, new Date(OLD).toISOString());
    assert.equal(typeof before.storage.databaseBytes, "number");
    assert.ok(before.storage.databaseBytes > 0);
    assert.equal(before.storage.rawLogKeepDays, 35);
    // The pruned days are in the numbers compared below.
    const oldDay = (before.metrics.daily as Array<Record<string, unknown>>).find((day) => day.date === "2026-11-04")!;
    assert.deepEqual([oldDay.requests, oldDay.activePeople, oldDay.latencyP50Ms, oldDay.latencyP95Ms], [4, 2, 200, 300]);
    assert.equal((before.metrics.daily as Array<Record<string, unknown>>).find((day) => day.date === "2026-11-05")!.errorEvents, 1);
    assert.deepEqual(before.metrics.funnel, { signedIn: 5, firstRequest: 4, firstSessionEnd: 1, activeSecondWeek: 2, firstPrOpened: 1 });
    assert.deepEqual((before.people[10] as any).sessions, { count: 2, started: 2, ended: 1, totalDurationMs: 600_000, totalTurns: 6, lastEventAt: new Date(TODAY - 2 * DAY).toISOString() });

    await scheduled(service, PROBE_CRON);

    // Only the kept days are left in the raw log.
    assert.equal(count(service, "requests"), 2);
    assert.equal(count(service, "events"), 1);
    const after = await views(service, adminToken);
    assert.deepEqual(after.metrics, before.metrics, "GET /admin/metrics is unchanged, latency of the pruned days included");
    assert.deepEqual(after.people, before.people, "GET /admin/people/:id is unchanged");
    assert.equal(after.home, before.home, "the admin page is unchanged");
    assert.deepEqual(after.candidates, before.candidates, "emails to users pick the same people");
    assert.deepEqual([10, 11, 12, 13].map((id) => outsideDl(sql(service), id, TODAY)), dlOnlyBefore, "the dl-only check is unchanged");
    assert.deepEqual(trustFacts(sql(service), TODAY), trustBefore, "GPT-6 trust's facts are unchanged");
    assert.deepEqual(after.storage.pruned.requests, 25);
    assert.deepEqual(after.storage.pruned.events, 11);
    assert.equal(after.storage.rows.requests, 2);
    assert.equal(after.storage.oldestRequestAt, new Date(TODAY - 2 * DAY).toISOString());

    // A session event covers what came before it, pruned requests included.
    await service.directory().recordEvents(12, [{ id: "late", type: "session.start", sessionId: "z", at: TODAY, props: {} }], TODAY);
    assert.equal(outsideDl(sql(service), 12, TODAY + 1000), false);
    assert.equal(outsideDl(sql(service), 12, TODAY + 2 * DAY), false, "no uncovered requests since");
  });

  it("builds the rollups from an existing log the same as it keeps them", async () => {
    const { service, adminToken } = await fixture();
    const kept = await views(service, adminToken);
    // As if the rollups had never been kept: emptied, then rebuilt from the raw log on start.
    const database = db(service);
    for (const table of ["person_daily", "person_events", "person_event_types"]) database.exec(`DELETE FROM ${table}`);
    database.exec("UPDATE daily_activity SET error_events = 0");
    database.exec("DELETE FROM settings WHERE key = 'rollup:raw_log'");
    const state = entry(service).state;
    const rebuilt = new DirectoryObject(state as never, service.env as never);
    (service.namespaces.DIRECTORY!.instances.get("directory") as { object: unknown }).object = rebuilt;
    const again = await views(service, adminToken);
    assert.deepEqual(again.metrics, kept.metrics);
    assert.deepEqual(again.people, kept.people);
    assert.equal(again.home, kept.home);
    assert.deepEqual(again.candidates, kept.candidates);
  });

  it("prunes in bounded steps and can be turned off or set at runtime", async () => {
    const { service, adminToken, record } = await fixture();
    for (let i = 0; i < PRUNE_BATCH_ROWS; i++) await record(11, OLD + 5 * DAY + i);
    const first = await service.directory().pruneRawLogs(TODAY, 35);
    assert.equal(first.requests, PRUNE_BATCH_ROWS, "one step deletes at most a batch");
    assert.equal(first.more, true);
    const second = await service.directory().pruneRawLogs(TODAY, 35);
    assert.equal(second.requests, 25);
    assert.equal(second.more, false);

    // 0 keeps everything; under 31 days is refused (the Health view and the allocator read 30).
    assert.equal(await errorCode(await service.request("POST", "/admin/config", { token: adminToken, body: { rawLogKeepDays: 10 } })), "invalid_request");
    assert.equal((await service.request("POST", "/admin/config", { token: adminToken, body: { rawLogKeepDays: 0 } })).status, 200);
    await record(11, OLD + 6 * DAY);
    assert.deepEqual(await service.directory().pruneRawLogs(TODAY, 35), { keepDays: 0, requests: 0, events: 0, more: false });
    assert.equal((await service.request("POST", "/admin/config", { token: adminToken, body: { rawLogKeepDays: 60 } })).status, 200);
    const metrics = (await (await service.request("GET", "/admin/metrics", { token: adminToken })).json()) as { storage: { rawLogKeepDays: number } };
    assert.equal(metrics.storage.rawLogKeepDays, 60);
    // 60 days back from today's start is OLD's day: the request 6 days after it is kept.
    assert.equal((await service.directory().pruneRawLogs(TODAY, 35)).requests, 0);
  });

  it("reads RAW_LOG_KEEP_DAYS: 0 or 31 to 3650", () => {
    const env = { OPENROUTER_API_KEY: "k", GITHUB_CLIENT_ID: "c", GITHUB_CLIENT_SECRET: "s", TOKEN_SIGNING_KEY: "x".repeat(32) };
    assert.equal(readFreeConfig(env).rawLogKeepDays, 35);
    assert.equal(readFreeConfig({ ...env, RAW_LOG_KEEP_DAYS: "0" }).rawLogKeepDays, 0);
    assert.equal(readFreeConfig({ ...env, RAW_LOG_KEEP_DAYS: "90" }).rawLogKeepDays, 90);
    for (const bad of ["7", "30", "4000", "-1", "x"]) assert.throws(() => readFreeConfig({ ...env, RAW_LOG_KEEP_DAYS: bad }), /RAW_LOG_KEEP_DAYS/);
  });
});
