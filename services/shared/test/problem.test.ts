import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { json, problem, problemBody, PROBLEM_BASE } from "../src/problem.js";

describe("problem details", () => {
  it("builds an RFC 9457 body with a stable type URL", () => {
    const body = problemBody(409, "name-taken", "Name taken", "alice is leased until 2026-11-28.");
    assert.equal(body.type, `${PROBLEM_BASE}/name-taken`);
    assert.equal(body.title, "Name taken");
    assert.equal(body.status, 409);
    assert.equal(body.detail, "alice is leased until 2026-11-28.");
  });

  it("omits detail when there is none", () => {
    assert.equal("detail" in problemBody(404, "not-found", "Not found"), false);
  });

  it("returns problem+json with the status and extra headers", async () => {
    const response = problem(429, "rate-limited", "Too many requests", "Try again in 30 seconds.", { "retry-after": "30" });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("content-type"), "application/problem+json; charset=utf-8");
    assert.equal(response.headers.get("retry-after"), "30");
    const body = await response.json() as { type: string; status: number };
    assert.equal(body.status, 429);
    assert.match(body.type, /rate-limited$/);
  });

  it("returns JSON that is never cached", async () => {
    const response = json({ ok: true }, 201);
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { ok: true });
  });
});
