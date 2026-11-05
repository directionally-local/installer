import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { ADMIN_ID, createService, NOW, type Service } from "./harness.js";
import { weekStart } from "../src/week.js";

type Status = { free: string; reason: string | null; message: string; opensAt: string | null; updatedAt: string };

function db(service: Service): DatabaseSync {
  service.directory();
  return (service.namespaces.DIRECTORY!.instances.get("directory") as { state: { db: DatabaseSync } }).state.db;
}

/** This week's non-admin spend: cash (OpenRouter) and free Luminal credit; credit also counts toward the all-time total. */
function seedSpend(service: Service, spend: { usd?: number; freeCreditUsd?: number; creditUsd?: number }): void {
  db(service)
    .prepare("INSERT INTO spend_weeks (week_start, usd, tokens, requests, admin_usd, admin_tokens, admin_requests, credit_usd, free_credit_usd) VALUES (?, ?, 1, 1, 0, 0, 0, ?, ?)")
    .run(weekStart(NOW), spend.usd ?? 0, spend.creditUsd ?? spend.freeCreditUsd ?? 0, spend.freeCreditUsd ?? 0);
}

async function get(service: Service): Promise<{ response: Response; body: Status; text: string }> {
  const response = await service.request("GET", "/v1/status");
  const text = await response.text();
  return { response, body: JSON.parse(text) as Status, text };
}

/** Only these keys, and no digits outside the two timestamps. */
function assertNoNumbers(text: string, body: Status): void {
  assert.deepEqual(Object.keys(body).sort(), ["free", "message", "opensAt", "reason", "updatedAt"]);
  const stripped = text.replace(/"(opensAt|updatedAt)":"[^"]*"/g, "").replace(/opens on \w+ \d{1,2} \w+/, "");
  assert.doesNotMatch(stripped, /\d/, `numbers leaked: ${text}`);
}

const LUMINAL = { LUMINAL_API_KEY: "lum-test", PRIMARY_UPSTREAM: "luminal", LUMINAL_CREDIT_USD: "1000", LUMINAL_WEEKLY_CREDIT_USD: "250", OPEN_ADMISSION: "true" };

describe("GET /v1/status", () => {
  it("is open with no auth, cacheable for 30 s, CORS for anyone, no numbers", async () => {
    const service = await createService({ OPEN_ADMISSION: "true", GLOBAL_WEEKLY_USD_CAP: "250" });
    const { response, body, text } = await get(service);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, max-age=30");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(body, { free: "open", reason: null, message: "", opensAt: null, updatedAt: new Date(NOW).toISOString() });
    assertNoNumbers(text, body);
    const preflight = await service.request("OPTIONS", "/v1/status");
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  });

  it("waitlist when this week's cash spend reaches the queue threshold (80%)", async () => {
    const below = await createService({ OPEN_ADMISSION: "true", GLOBAL_WEEKLY_USD_CAP: "250" });
    seedSpend(below, { usd: 199 });
    assert.equal((await get(below)).body.free, "open");

    const service = await createService({ OPEN_ADMISSION: "true", GLOBAL_WEEKLY_USD_CAP: "250" });
    seedSpend(service, { usd: 200 });
    const { body, text } = await get(service);
    assert.deepEqual(body, {
      free: "waitlist",
      reason: "weekly_budget",
      message: "The free tier is at capacity this week: new sign-ups join a waitlist that opens on Monday 9 November.",
      opensAt: "2026-11-09T00:00:00.000Z",
      updatedAt: new Date(NOW).toISOString(),
    });
    assertNoNumbers(text, body);
  });

  it("waitlist when Luminal serves and free credit this week reaches 80% of the weekly credit budget", async () => {
    const service = await createService(LUMINAL);
    seedSpend(service, { freeCreditUsd: 200 });
    assert.equal((await get(service)).body.free, "waitlist");
  });

  it("waitlist when people are already waiting, even with no spend", async () => {
    const service = await createService({ OPEN_ADMISSION: "true", GLOBAL_WEEKLY_USD_CAP: "250" });
    // This week's admission already ran, so the person stays in line.
    db(service).prepare("INSERT INTO queue_runs (week_start, ran_at, admitted, waiting_before, avg_usd, actives, budget_usd) VALUES (?, ?, 0, 0, 5, 0, 200)").run(weekStart(NOW), weekStart(NOW));
    db(service).prepare("INSERT INTO queue (github_id, queued_at) VALUES (?, ?)").run(500, NOW - 1000);
    const { body } = await get(service);
    assert.equal(body.free, "waitlist");
    assert.equal(body.opensAt, "2026-11-09T00:00:00.000Z");
  });

  it("paused when the Luminal credit is used up", async () => {
    const service = await createService(LUMINAL);
    seedSpend(service, { creditUsd: 1000 });
    const { body, text } = await get(service);
    assert.deepEqual(body, {
      free: "paused",
      reason: "credit_exhausted",
      message: "The free tier is paused: high demand used up this round of free tokens. Bring your own key, or check back soon.",
      opensAt: null,
      updatedAt: new Date(NOW).toISOString(),
    });
    assertNoNumbers(text, body);
  });

  it("paused by the env kill switch and by the admin's", async () => {
    const env = await createService({ PAUSED: "true" });
    const { body } = await get(env);
    assert.deepEqual(body, { free: "paused", reason: "kill_switch", message: "The free tier is paused for now. Bring your own key, or check back soon.", opensAt: null, updatedAt: new Date(NOW).toISOString() });

    const service = await createService();
    const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    assert.equal((await service.request("POST", "/admin/pause", { token: admin })).status, 200);
    assert.equal((await get(service)).body.reason, "kill_switch");
  });

  it("paused when no upstream may serve", async () => {
    const service = await createService({ OPENROUTER_API_KEY: "" });
    const { body } = await get(service);
    assert.equal(body.free, "paused");
    assert.equal(body.reason, "no_upstream");
    assert.equal(body.message, "The free tier is paused for now. Bring your own key, or check back soon.");
  });

  it("is computed at most once per 30 s", async () => {
    const service = await createService({ OPEN_ADMISSION: "true", GLOBAL_WEEKLY_USD_CAP: "250" });
    assert.equal((await get(service)).body.free, "open");
    seedSpend(service, { usd: 240 });
    service.clock.now = NOW + 29_000;
    const cached = (await get(service)).body;
    assert.equal(cached.free, "open");
    assert.equal(cached.updatedAt, new Date(NOW).toISOString());
    service.clock.now = NOW + 30_000;
    assert.equal((await get(service)).body.free, "waitlist");
  });

  it("is rate limited per network, generously", async () => {
    const service = await createService();
    for (let index = 0; index < 120; index += 1) assert.equal((await service.request("GET", "/v1/status")).status, 200);
    const limited = await service.request("GET", "/v1/status");
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("access-control-allow-origin"), "*");
    assert.equal((await service.request("GET", "/v1/status", { ip: "198.51.100.9" })).status, 200);
  });
});
