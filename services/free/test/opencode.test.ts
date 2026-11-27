import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, completion, createService, luminalUsage, MODEL, type Service } from "./harness.js";
import { forHarness, gptLimitMessage } from "../src/messages.js";

/**
 * OpenCode through `dl opencode`: a harness key for "opencode" on the chat completions endpoint
 * Autopilot uses, for DeepSeek (GPT-6 too only while `gpt6Clients` is "all"; gpt6-clients.test.ts), through the same reservation,
 * caps, share, dl-only check and refusals as Claude Code's, its usage recorded as OpenCode's.
 */

const LUNA = "gpt-6-luna";
const BOTH = { OPENAI_API_KEY: "sk-openai-test", LUMINAL_API_KEY: "lum-test" };

async function world(vars: Record<string, string> = {}) {
  const service = await createService({ OPEN_ADMISSION: "true", ...BOTH, ...vars });
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const tokens = await service.signIn({ id: 100, login: "alice" });
  return { service, admin, token: tokens.access_token };
}

async function mint(service: Service, token: string, harness = "opencode"): Promise<{ id: string; key: string; harness: string }> {
  const response = await service.request("POST", "/v1/harness-keys", { token, body: { harness } });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()) as never;
}

/** What OpenCode's OpenAI-compatible provider sends. */
const chat = (service: Service, key: string, body: Record<string, unknown> = {}) =>
  service.request("POST", "/v1/chat/completions", { token: key, body: { model: LUNA, messages: [{ role: "user", content: "hello" }], ...body } });

async function apiError(response: Response): Promise<{ code: string; message: string }> {
  return ((await response.json()) as { error: { code: string; message: string } }).error;
}

const requestRows = (service: Service) =>
  service.directory().ctx.storage.sql.exec("SELECT harness, model FROM requests WHERE github_id = 100 ORDER BY id").toArray().map((row: object) => ({ ...row }));

let eventId = 0;
const sessionEvent = (service: Service, key: string) =>
  service.request("POST", "/v1/events", { token: key, body: { events: [{ id: `oc${++eventId}`, type: "session.start", sessionId: "dl-opencode-1", at: new Date(service.clock.now).toISOString(), props: { harness: "claude-code" } }] } });

describe("OpenCode harness keys", () => {
  it("are minted for \"opencode\" and serve both model families on chat completions with gpt6Clients \"all\", recorded as OpenCode's", async () => {
    const { service, token } = await world({ GPT6_CLIENTS: "all" });
    const minted = await mint(service, token);
    assert.equal(minted.harness, "opencode");
    assert.match(minted.key, /^dlh_100_/);

    const luna = await chat(service, minted.key);
    assert.equal(luna.status, 200, await luna.clone().text());
    assert.equal(service.calls.openai.length, 1, "GPT-6 Luna on OpenAI");
    const deepseek = await chat(service, minted.key, { model: MODEL });
    assert.equal(deepseek.status, 200);
    assert.equal(service.calls.luminal.length, 1, "DeepSeek on Luminal");
    for (const model of ["gpt-6.1-sol", "gpt-6-astra"]) assert.equal((await chat(service, minted.key, { model })).status, 200, model);

    assert.deepEqual(requestRows(service), [
      { harness: "opencode", model: LUNA },
      { harness: "opencode", model: MODEL },
      { harness: "opencode", model: "gpt-6.1-sol" },
      { harness: "opencode", model: "gpt-6-astra" },
    ]);
  });

  it("stream like Autopilot's requests", async () => {
    const { service, token } = await world({ GPT6_CLIENTS: "all" });
    const { key } = await mint(service, token);
    const response = await chat(service, key, { stream: true });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.match(await response.text(), /\[DONE\]/);
  });

  it("list the models (dl opencode configures OpenCode from them), with what each can read", async () => {
    const { service, token } = await world();
    const { key } = await mint(service, token);
    const response = await service.request("GET", "/v1/models", { token: key });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: Array<{ id: string; context_window: number; max_output_tokens: number; vision: boolean }> };
    // GPT-6 is Autopilot only (gpt6Clients "autopilot", the default).
    assert.deepEqual(body.data.map((model) => model.id), [MODEL]);
    assert.deepEqual(body.data.at(-1), { id: MODEL, object: "model", owned_by: "luminal", name: "DeepSeek V4.1 Flash 1017", context_window: 1_048_576, max_output_tokens: 65_536, vision: false, access: "free" });
  });

  it("work nowhere else: not on the Anthropic endpoint, /v1/me or the keys", async () => {
    const { service, token } = await world();
    const { key } = await mint(service, token);
    const anthropic = await service.request("POST", "/anthropic/v1/messages", { token: key, body: { model: "x", max_tokens: 10, messages: [{ role: "user", content: "x" }] } });
    assert.equal(anthropic.status, 401);
    assert.equal((await service.request("GET", "/v1/me", { token: key })).status, 401);
    assert.equal((await service.request("POST", "/v1/keys", { token: key, body: { name: "box" } })).status, 401);
    assert.equal((await service.request("POST", "/v1/harness-keys", { token: key, body: { harness: "opencode" } })).status, 401);
  });

  it("say OpenCode's words when they expire", async () => {
    const { service, token } = await world();
    const { id, key } = await mint(service, token);
    assert.equal((await service.request("DELETE", `/v1/harness-keys/${id}`, { token: key })).status, 200);
    const expired = await chat(service, key);
    assert.equal(expired.status, 401);
    const error = await apiError(expired);
    assert.equal(error.code, "invalid_harness_key");
    assert.equal(error.message, "This dl opencode session's key has expired. Quit OpenCode and run dl opencode again.");
  });

  it("are refused while the kill switch is off, at minting and on requests, with nothing sent upstream", async () => {
    const { service, admin, token } = await world();
    const { key } = await mint(service, token);
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { allowOtherHarnesses: false } })).status, 200);
    const refused = await chat(service, key);
    assert.equal(refused.status, 403);
    const error = await apiError(refused);
    assert.equal(error.code, "harness_not_allowed");
    assert.equal(error.message, "Free tokens in OpenCode are switched off for now. Free tokens still work in dl (Autopilot), and OpenCode works with your own provider key.");
    assert.equal(service.calls.openai.length + service.calls.luminal.length, 0);
    const mintRefused = await service.request("POST", "/v1/harness-keys", { token, body: { harness: "opencode" } });
    assert.equal(mintRefused.status, 403);
    assert.match((await apiError(mintRefused)).message, /Free tokens in OpenCode are switched off/);
    // Autopilot is unaffected.
    assert.equal((await service.request("POST", "/v1/chat/completions", { token, body: { model: LUNA, messages: [{ role: "user", content: "x" }] } })).status, 200);
  });
});

describe("OpenCode's share and refusals", () => {
  it("gets otherHarnessShare of the week, in OpenCode's words, when it is set below 1", async () => {
    const { service, token } = await world({ DEEPSEEK_WEEKLY_USD_CAP: "1", OTHER_HARNESS_SHARE: "0.5" });
    const { key } = await mint(service, token);
    // 10M uncached prompt tokens at $0.035/M: $0.35 a request.
    service.setLuminal(() => completion(luminalUsage(10_000_000, 0)));
    assert.equal((await chat(service, key, { model: MODEL })).status, 200);
    assert.equal((await chat(service, key, { model: MODEL })).status, 200);
    const refused = await chat(service, key, { model: MODEL });
    assert.equal(refused.status, 402);
    const error = await apiError(refused);
    assert.equal(error.code, "harness_limit");
    assert.match(error.message, /^OpenCode through dl gets half of your free allowance, and that part is used up\. It resets at 2026-11-09T00:00:00\.000Z\. For more, get dl Pro: run dl and type \/upgrade\.$/);
    assert.equal((await service.request("POST", "/v1/chat/completions", { token, body: { model: MODEL, messages: [{ role: "user", content: "x" }] } })).status, 200);
  });

  it("gives OpenCode the whole allowance by default (otherHarnessShare 1)", async () => {
    const { service, token } = await world({ DEEPSEEK_WEEKLY_USD_CAP: "1" });
    const { key } = await mint(service, token);
    service.setLuminal(() => completion(luminalUsage(10_000_000, 0)));
    const statuses = [];
    for (let index = 0; index < 3; index++) statuses.push((await chat(service, key, { model: MODEL })).status);
    assert.deepEqual(statuses, [200, 200, 200]);
  });

  it("is covered by dl's session events for the dl-only check (dlOnly on), like Autopilot", async () => {
    const { service, token } = await world({ DL_ONLY: "true" });
    const { key } = await mint(service, token);
    for (let index = 0; index < 20; index++) {
      assert.equal((await chat(service, key, { model: MODEL })).status, 200);
      service.clock.now += 1000;
    }
    const refused = await chat(service, key, { model: MODEL });
    assert.equal(refused.status, 403);
    const error = await apiError(refused);
    assert.equal(error.code, "dl_only");
    assert.equal(error.message, "Free tokens in OpenCode work only while it runs from dl opencode. Quit OpenCode and run dl opencode again, or use your own provider key.");
    assert.equal((await sessionEvent(service, key)).status, 202);
    assert.equal((await chat(service, key, { model: MODEL })).status, 200);
    const stored = service.directory().ctx.storage.sql.exec("SELECT props FROM events WHERE github_id = 100").toArray() as Array<{ props: string }>;
    assert.deepEqual(JSON.parse(stored[0]!.props), { harness: "opencode" }, "the key's harness, whatever the body said");
  });

  it("counts on the admin people list with the other tools", async () => {
    const { service, admin, token } = await world();
    const { key } = await mint(service, token);
    service.setLuminal(() => completion(luminalUsage(100, 10)));
    await chat(service, key, { model: MODEL });
    const people = (await (await service.request("GET", "/admin/people", { token: admin })).json()) as { people: Array<{ githubId: number; otherHarnessThisWeek: { requests: number } }> };
    assert.equal(people.people.find((person) => person.githubId === 100)!.otherHarnessThisWeek.requests, 1);
  });
});

describe("Claude Code alongside OpenCode", () => {
  it("keeps its key off chat completions and /v1/models, and on the Anthropic endpoint", async () => {
    const { service, token } = await world();
    const { key } = await mint(service, token, "claude-code");
    assert.equal((await chat(service, key, { model: MODEL })).status, 401);
    assert.equal((await service.request("GET", "/v1/models", { token: key })).status, 401);
    const messages = await service.request("POST", "/anthropic/v1/messages", { token: key, body: { model: "claude-sonnet-4-5", max_tokens: 10, messages: [{ role: "user", content: "x" }] } });
    assert.equal(messages.status, 200);
    const expired = await service.request("POST", "/anthropic/v1/messages", { token: key.replace(/.$/, (last) => (last === "a" ? "b" : "a")), body: { model: "x", max_tokens: 10, messages: [{ role: "user", content: "x" }] } });
    assert.match(((await expired.json()) as { error: { message: string } }).error.message, /^This dl claude session's key has expired\. Quit Claude Code and run dl claude again\.$/);
  });
});

describe("forHarness", () => {
  it("points OpenCode at its own /models for DeepSeek when GPT-6's week is used, and Claude Code at dl Pro", () => {
    assert.equal(forHarness(gptLimitMessage("free"), "opencode"), "You've used this week's GPT-6 allowance. DeepSeek V4.1 Flash still has free usage this week: pick it in /models, or get dl Pro: run dl and type /upgrade.");
    assert.equal(forHarness(gptLimitMessage("pro"), "opencode"), "You've used this week's Pro GPT-6 allowance. DeepSeek V4.1 Flash still has usage this week: pick it in /models.");
    assert.equal(forHarness(gptLimitMessage("free")), "You've used this week's GPT-6 allowance. DeepSeek V4.1 Flash still has free usage this week: get dl Pro: run dl and type /upgrade.");
  });
});
