import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, createService, type Service } from "./harness.js";
import { AGENT_REQUESTS_PER_DAY, AGENT_REQUEST_EMAILS_PER_DAY, parseAgentRequest } from "../src/agent-request.js";

/** POST /v1/agent-request (dl's "my coding agent isn't supported"), its owner email, and the admin list. */

const VARS = { OPEN_ADMISSION: "true", ALERT_EMAIL_TO: "owner@example.com", ALERT_WEBHOOK_URL: "" };
const VALID = { name: "Aider", os: "darwin", arch: "arm64", dlVersion: "0.48.0", found: ["claude", "opencode"] };

function decode(raw: string): { subject: string; body: string; head: string } {
  const [head, body] = raw.split("\r\n\r\n") as [string, string];
  const subject = /\r\nSubject: ([^\r\n]*)\r\n/.exec(head)![1]!;
  const text = new TextDecoder().decode(Uint8Array.from(atob(body.replace(/\r\n/g, "")), (char) => char.charCodeAt(0)));
  return { subject, body: text.replace(/\r\n/g, "\n"), head };
}

const mails = (s: Service) => s.calls.emails.map((call) => decode(call.raw)).filter((mail) => mail.subject.startsWith("dl: unsupported coding agent"));
const submit = (s: Service, body: unknown, options: { ip?: string; token?: string } = {}) =>
  s.request("POST", "/v1/agent-request", { body, ip: options.ip ?? "203.0.113.7", ...(options.token ? { token: options.token } : {}) });

async function open(): Promise<{ s: Service; admin: string }> {
  const s = await createService(VARS, { email: true });
  const admin = (await s.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  s.calls.emails.length = 0;
  return { s, admin };
}

async function list(s: Service, admin: string, path = "/admin/agent-requests"): Promise<{ total: number; requests: Array<Record<string, unknown>> }> {
  const response = await s.request("GET", path, { token: admin });
  assert.equal(response.status, 200);
  return (await response.json()) as { total: number; requests: Array<Record<string, unknown>> };
}

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  return ((await response.json()) as { error: { code: string; message: string } }).error;
}

describe("POST /v1/agent-request", () => {
  it("keeps a request without sign-in, emails the owner, and answers {ok: true}", async () => {
    const { s, admin } = await open();
    const response = await submit(s, VALID);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });

    const data = await list(s, admin);
    assert.equal(data.total, 1);
    const stored = data.requests[0]!;
    assert.deepEqual(
      { name: stored.name, os: stored.os, arch: stored.arch, dlVersion: stored.dlVersion, found: stored.found, login: stored.login, githubId: stored.githubId },
      { ...VALID, login: null, githubId: null },
    );
    assert.equal(stored.at, "2026-11-04T12:00:00.000Z");
    assert.equal("ip" in stored, false);
    // The /v1 spelling lists the same.
    assert.equal((await list(s, admin, "/v1/admin/agent-requests")).total, 1);

    const sent = mails(s);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.subject, 'dl: unsupported coding agent "Aider"');
    for (const line of ["Agent: Aider", "OS/arch: darwin/arm64", "dl version: 0.48.0", "Agents dl found: claude, opencode", "Account: (not signed in)"]) {
      assert.ok(sent[0]!.body.includes(line), line);
    }
  });

  it("attaches the account from a valid access token or dl key", async () => {
    const { s, admin } = await open();
    const alice = (await s.signIn({ id: 4242, login: "alice" })).access_token;
    assert.equal((await submit(s, VALID, { token: alice })).status, 200);
    const { key } = (await (await s.request("POST", "/v1/keys", { token: alice, body: { name: "box", kind: "tool" } })).json()) as { key?: string };
    assert.ok(key);
    assert.equal((await submit(s, { name: "Goose" }, { token: key })).status, 200);
    const data = await list(s, admin);
    for (const stored of data.requests) {
      assert.equal(stored.login, "alice");
      assert.equal(stored.githubId, 4242);
    }
    assert.match(mails(s)[0]!.body, /Account: alice \(id 4242\)/);
  });

  it("never fails on an invalid or expired token: the request is kept without an account", async () => {
    const { s, admin } = await open();
    for (const token of ["nonsense", "dlk_bad", "dl_bad", "dlh_bad", "eyJhbGciOiJFUzI1NiJ9.e30.x"]) {
      const response = await submit(s, VALID, { token });
      assert.equal(response.status, 200, token);
    }
    const data = await list(s, admin);
    assert.equal(data.total, 5);
    assert.ok(data.requests.every((stored) => stored.login === null && stored.githubId === null));
  });

  it("keeps CR/LF out of the subject and headers", async () => {
    const { s } = await open();
    assert.equal((await submit(s, { name: 'Evil"\r\nBcc: x@evil.example' })).status, 200);
    const sent = mails(s)[0]!;
    assert.equal(sent.subject, 'dl: unsupported coding agent "Evil" Bcc: x@evil.example"');
    assert.doesNotMatch(sent.head, /\r\nBcc:/);
    assert.match(sent.body, /OS\/arch: \(not given\)/);
    assert.match(sent.body, /Agents dl found: \(none\)/);
  });

  it("refuses bad bodies with 400 invalid_request", async () => {
    const { s, admin } = await open();
    const cases: Array<[unknown, string]> = [
      [{}, "name is required."],
      [{ name: "   " }, "name is required."],
      [{ name: 7 }, "name must be a string."],
      [{ name: "x".repeat(81) }, "name can be at most 80 characters."],
      [{ name: "a", os: "o".repeat(41) }, "os can be at most 40 characters."],
      [{ name: "a", arch: "a".repeat(21) }, "arch can be at most 20 characters."],
      [{ name: "a", dlVersion: "v".repeat(41) }, "dlVersion can be at most 40 characters."],
      [{ name: "a", found: "claude" }, "found must be a list of strings."],
      [{ name: "a", found: [1] }, "found must be a list of strings."],
      [{ name: "a", found: Array.from({ length: 41 }, (_, i) => `a${i}`) }, "found can list at most 40 agents."],
      [{ name: "a", found: ["f".repeat(41)] }, "Each found agent can be at most 40 characters."],
      [["Aider"], "Send a JSON object: {name, os?, arch?, dlVersion?, found?}."],
    ];
    for (const [body, message] of cases) {
      const response = await submit(s, body);
      assert.equal(response.status, 400, message);
      assert.deepEqual(await errorOf(response), { code: "invalid_request", message });
    }
    const huge = await submit(s, JSON.stringify({ name: "a", extra: "x".repeat(20_000) }));
    assert.equal(huge.status, 400);
    assert.equal((await list(s, admin)).total, 0);
    // At the limits is fine; unknown fields are ignored.
    const edge = await submit(s, { name: "x".repeat(80), found: Array.from({ length: 40 }, () => "f".repeat(40)), newer: true });
    assert.equal(edge.status, 200);
  });

  it("rate limits a network to 10 an hour with 429 rate_limited", async () => {
    const { s, admin } = await open();
    for (let i = 0; i < 10; i++) assert.equal((await submit(s, VALID)).status, 200);
    const refused = await submit(s, VALID);
    assert.equal(refused.status, 429);
    assert.equal((await errorOf(refused)).code, "rate_limited");
    assert.ok(Number(refused.headers.get("retry-after")) > 0);
    assert.equal((await submit(s, VALID, { ip: "198.51.100.9" })).status, 200);
    assert.equal((await list(s, admin)).total, 11);
  });

  it("keeps at most AGENT_REQUESTS_PER_DAY a UTC day, and emails only the first AGENT_REQUEST_EMAILS_PER_DAY", async () => {
    const { s, admin } = await open();
    for (let i = 0; i < AGENT_REQUESTS_PER_DAY; i++) assert.equal((await submit(s, VALID, { ip: `10.${Math.floor(i / 200)}.${i % 200}.1` })).status, 200);
    const refused = await submit(s, VALID, { ip: "192.0.2.1" });
    assert.equal(refused.status, 429);
    assert.equal((await list(s, admin)).total, AGENT_REQUESTS_PER_DAY);
    assert.equal(mails(s).length, AGENT_REQUEST_EMAILS_PER_DAY);
    s.clock.now += 86_400_000;
    assert.equal((await submit(s, VALID, { ip: "192.0.2.1" })).status, 200);
  });

  it("still answers {ok: true} when the email fails, and without an email binding", async () => {
    const { s, admin } = await open();
    s.env.ALERT_EMAIL = {
      async send() {
        throw new Error("boom");
      },
    };
    assert.equal((await submit(s, VALID)).status, 200);
    delete s.env.ALERT_EMAIL;
    assert.equal((await submit(s, VALID)).status, 200);
    assert.equal((await list(s, admin)).total, 2);
  });

  it("is admins-only to list", async () => {
    const { s } = await open();
    const someone = (await s.signIn({ id: 4242, login: "someone" })).access_token;
    assert.equal((await s.request("GET", "/admin/agent-requests", { token: someone })).status, 403);
    assert.equal((await s.request("GET", "/admin/agent-requests")).status, 401);
  });
});

describe("parseAgentRequest", () => {
  it("trims, drops empty and duplicate found entries, and flattens line breaks", () => {
    assert.deepEqual(parseAgentRequest({ name: " Ai\nder ", os: "", found: ["claude", " claude ", ""] }), {
      ok: true,
      value: { name: "Ai der", os: null, arch: null, dlVersion: null, found: ["claude"] },
    });
  });
});
