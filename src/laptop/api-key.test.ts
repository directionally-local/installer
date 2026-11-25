import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { apiKeyCommand, apiKeyText, freeName, toolUrls, type ApiKeyDeps } from "./api-key.js";
import { palette } from "../ui.js";

const ORIGIN = "https://free.example.test";
const KEY = "dlk_100_abcdefabcdef_" + "x".repeat(43);

interface Call {
  method: string;
  url: string;
  auth: string | null;
  body: unknown;
}

/** A fake free tier's /v1/keys: `answers` by "METHOD path". */
function fakeFetch(answers: Record<string, { status: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    calls.push({ method, url, auth: headers.get("authorization"), body: init.body ? JSON.parse(String(init.body)) : undefined });
    const answer = answers[`${method} ${new URL(url).pathname}`] ?? { status: 404, body: { error: { code: "not_found", message: "nope" } } };
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  };
  return { calls, fetch };
}

function run(args: string[], deps: ApiKeyDeps) {
  const out: string[] = [];
  const err: string[] = [];
  return apiKeyCommand(args, { out: (text) => out.push(text), err: (text) => err.push(text) }, { env: { NO_COLOR: "1" }, terminal: false, token: async () => ({ ok: true, origin: ORIGIN, accessToken: "access-1" }), ...deps }).then((code) => ({ code, out: out.join(""), err: err.join("") }));
}

const listing = (keys: unknown[] = []) => ({ status: 200, body: { keys, max: 5, maxToolKeys: 3, toolKeys: true } });

describe("dl api-key", () => {
  it("makes a tool key with the sign-in and prints it once with both base URLs and an example", async () => {
    const fake = fakeFetch({
      "GET /v1/keys": listing([{ id: "aaaaaaaaaaaa", name: "tools", kind: "tool", createdAt: "2026-11-20T00:00:00.000Z", lastUsedAt: null }]),
      "POST /v1/keys": { status: 201, body: { id: "abcdefabcdef", name: "tools-2", kind: "tool", key: KEY, createdAt: "2026-11-24T00:00:00.000Z", lastUsedAt: null } },
    });
    const result = await run([], { fetch: fake.fetch });
    assert.equal(result.code, 0, result.err);
    const post = fake.calls.find((call) => call.method === "POST")!;
    assert.deepEqual(post.body, { name: "tools-2", kind: "tool" }, "a name no key has yet");
    assert.equal(post.auth, "Bearer access-1");
    assert.match(result.out, new RegExp(KEY));
    assert.match(result.out, /base URL {2}https:\/\/free\.example\.test\/v1\n/);
    assert.match(result.out, /base URL {2}https:\/\/free\.example\.test\/anthropic\n/);
    assert.match(result.out, /curl https:\/\/free\.example\.test\/v1\/chat\/completions -H "Authorization: Bearer dlk_/);
    assert.match(result.out, /GPT-6 is in Autopilot only/);
  });

  it("gives the hosted free tier's keys api.dl.new's base URLs, and still makes them at the sign-in's origin", async () => {
    const fake = fakeFetch({ "GET /v1/keys": listing(), "POST /v1/keys": { status: 201, body: { id: "abcdefabcdef", name: "tools", kind: "tool", key: KEY } } });
    const result = await run([], { fetch: fake.fetch, token: async () => ({ ok: true, origin: "https://free.directionallylocal.com", accessToken: "access-1" }) });
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /base URL {2}https:\/\/api\.dl\.new\/v1\n/);
    assert.match(result.out, /base URL {2}https:\/\/api\.dl\.new\/anthropic\n/);
    assert.doesNotMatch(result.out, /free\.directionallylocal\.com/);
    assert.ok(fake.calls.every((call) => call.url.startsWith("https://free.directionallylocal.com/v1/keys")));
  });

  it("takes a name", async () => {
    const fake = fakeFetch({ "GET /v1/keys": listing(), "POST /v1/keys": { status: 201, body: { id: "abcdefabcdef", name: "cursor", kind: "tool", key: KEY } } });
    const result = await run(["cursor"], { fetch: fake.fetch });
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(fake.calls.find((call) => call.method === "POST")!.body, { name: "cursor", kind: "tool" });
  });

  it("says the service's refusal, and where to see the keys at the limit", async () => {
    const fake = fakeFetch({ "GET /v1/keys": listing(), "POST /v1/keys": { status: 409, body: { error: { code: "key_limit_reached", message: "This account already has 3 API keys for other tools. Revoke one first (dl api-key revoke ID)." } } } });
    const result = await run(["zed"], { fetch: fake.fetch });
    assert.equal(result.code, 1);
    assert.match(result.err, /already has 3 API keys/);
    assert.match(result.err, /dl api-key list/);
  });

  it("takes back a server key an older free tier made instead, and says tool keys aren't there yet", async () => {
    const fake = fakeFetch({
      "GET /v1/keys": { status: 200, body: { keys: [], max: 5 } },
      "POST /v1/keys": { status: 201, body: { id: "abcdefabcdef", name: "tools", key: KEY } },
      "DELETE /v1/keys/abcdefabcdef": { status: 200, body: { id: "abcdefabcdef", revoked: true } },
    });
    const result = await run([], { fetch: fake.fetch });
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.out, /dlk_/, "the key isn't printed");
    assert.ok(fake.calls.some((call) => call.method === "DELETE"));
    assert.match(result.err, /doesn't offer API keys for other tools yet/);
  });

  it("lists only tool keys, never secrets", async () => {
    const fake = fakeFetch({
      "GET /v1/keys": listing([
        { id: "aaaaaaaaaaaa", name: "cursor", kind: "tool", createdAt: "2026-11-20T00:00:00.000Z", lastUsedAt: "2026-11-23T08:30:00.000Z" },
        { id: "bbbbbbbbbbbb", name: "hetzner-1", kind: "server", createdAt: "2026-11-01T00:00:00.000Z", lastUsedAt: null },
      ]),
    });
    const result = await run(["list"], { fetch: fake.fetch });
    assert.equal(result.code, 0);
    assert.match(result.out, /aaaaaaaaaaaa {2}cursor .*last used 2026-11-23 08:30/);
    assert.doesNotMatch(result.out, /hetzner-1/);
    assert.match(result.out, /\(1 of 3\)/);
  });

  it("revokes by id", async () => {
    const fake = fakeFetch({ "DELETE /v1/keys/aaaaaaaaaaaa": { status: 200, body: { id: "aaaaaaaaaaaa", revoked: true } } });
    const result = await run(["revoke", "aaaaaaaaaaaa"], { fetch: fake.fetch });
    assert.equal(result.code, 0);
    assert.match(result.out, /Revoked aaaaaaaaaaaa/);
    const bad = await run(["revoke", "nope"], { fetch: fake.fetch });
    assert.equal(bad.code, 2);
  });

  it("asks to sign in first when there is no sign-in and no terminal", async () => {
    const fake = fakeFetch({});
    const result = await run(["cursor"], { fetch: fake.fetch, token: async () => ({ ok: false, reason: "signed_out" }) });
    assert.equal(result.code, 1);
    assert.match(result.err, /Run dl once to sign in/);
    assert.equal(fake.calls.length, 0);
  });

  it("prints usage for --help and bad arguments", async () => {
    assert.match((await run(["--help"], {})).out, /Usage: dl api-key/);
    assert.equal((await run(["a", "b"], {})).code, 2);
  });
});

describe("api-key helpers", () => {
  it("picks a free name", () => {
    assert.equal(freeName("tools", []), "tools");
    assert.equal(freeName("tools", ["tools", "tools-2"]), "tools-3");
  });

  it("builds the base URLs", () => {
    assert.deepEqual(toolUrls(ORIGIN), { openai: `${ORIGIN}/v1`, anthropic: `${ORIGIN}/anthropic` });
    // The hosted free tier: api.dl.new, not the sign-in's origin.
    assert.deepEqual(toolUrls("https://free.directionallylocal.com"), { openai: "https://api.dl.new/v1", anthropic: "https://api.dl.new/anthropic" });
    assert.deepEqual(toolUrls("https://free.directionallylocal.com/"), { openai: "https://api.dl.new/v1", anthropic: "https://api.dl.new/anthropic" });
    assert.match(apiKeyText({ origin: ORIGIN, key: KEY, name: "x", max: 3, color: palette(false) }), /At most 3 keys/);
  });
});
