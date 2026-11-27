import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, completion, createService, luminalUsage, MODEL, type Service } from "./harness.js";
import { forHarness, gptLimitMessage } from "../src/messages.js";
import { requestClient } from "../src/refusals.js";

/**
 * Pi through `dl pi`: a harness key for "pi" on the OpenAI-compatible chat completions endpoint
 * (Pi's `openai-completions` API), for the open models and, per the access rules, every other
 * model the person may use (like OpenCode's), on the share for other agents, with its own words
 * in refusals and its own client in the refusal counts.
 */

const LUNA = "gpt-6-luna";
const BOTH = { OPENAI_API_KEY: "sk-openai-test", LUMINAL_API_KEY: "lum-test" };

async function world(vars: Record<string, string> = {}) {
  const service = await createService({ OPEN_ADMISSION: "true", ...BOTH, ...vars });
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const tokens = await service.signIn({ id: 100, login: "alice" });
  return { service, admin, token: tokens.access_token };
}

async function mint(service: Service, token: string, harness = "pi"): Promise<{ id: string; key: string; harness: string; otherHarnessShare: number }> {
  const response = await service.request("POST", "/v1/harness-keys", { token, body: { harness } });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()) as never;
}

/** What Pi's openai-completions provider sends through dl pi (dl adds x-session-id). */
const chat = (service: Service, key: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  service.request("POST", "/v1/chat/completions", { token: key, headers, body: { model: MODEL, messages: [{ role: "user", content: "hello" }], ...body } });

async function apiError(response: Response): Promise<{ code: string; message: string }> {
  return ((await response.json()) as { error: { code: string; message: string } }).error;
}

const requestRows = (service: Service) =>
  service.directory().ctx.storage.sql.exec("SELECT harness, model, session_key FROM requests WHERE github_id = 100 ORDER BY id").toArray().map((row: object) => ({ ...row }));

describe("Pi harness keys", () => {
  it("are minted for \"pi\" with the whole allowance by default", async () => {
    const { service, token } = await world();
    const minted = await mint(service, token);
    assert.equal(minted.harness, "pi");
    assert.match(minted.key, /^dlh_100_/);
    assert.equal(minted.otherHarnessShare, 1);
  });

  it("serve DeepSeek (and GPT-6 with gpt6Clients \"all\") on chat completions, recorded as Pi's under dl pi's session id", async () => {
    const { service, token } = await world({ GPT6_CLIENTS: "all" });
    const { key } = await mint(service, token);
    const deepseek = await chat(service, key, {}, { "x-session-id": "dl-pi-abc" });
    assert.equal(deepseek.status, 200, await deepseek.clone().text());
    assert.equal(service.calls.luminal.length, 1, "DeepSeek on Luminal");
    assert.equal((await chat(service, key, { model: LUNA }, { "x-session-id": "dl-pi-abc" })).status, 200);
    assert.deepEqual(requestRows(service), [
      { harness: "pi", model: MODEL, session_key: "dl-pi-abc" },
      { harness: "pi", model: LUNA, session_key: "dl-pi-abc" },
    ]);
  });

  it("stream", async () => {
    const { service, token } = await world({ GPT6_CLIENTS: "all" });
    const { key } = await mint(service, token);
    const response = await chat(service, key, { model: LUNA, stream: true, stream_options: { include_usage: true } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.match(await response.text(), /\[DONE\]/);
  });

  it("list the models (dl pi configures Pi from them)", async () => {
    const { service, token } = await world();
    const { key } = await mint(service, token);
    const response = await service.request("GET", "/v1/models", { token: key });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: Array<{ id: string }> };
    assert.ok(body.data.some((model) => model.id === MODEL));
  });

  it("work nowhere else: not on the Anthropic endpoint, /v1/me or the keys", async () => {
    const { service, token } = await world();
    const { key } = await mint(service, token);
    const anthropic = await service.request("POST", "/anthropic/v1/messages", { token: key, body: { model: "x", max_tokens: 10, messages: [{ role: "user", content: "x" }] } });
    assert.equal(anthropic.status, 401);
    assert.equal((await service.request("GET", "/v1/me", { token: key })).status, 401);
    assert.equal((await service.request("POST", "/v1/harness-keys", { token: key, body: { harness: "pi" } })).status, 401);
  });

  it("say Pi's words when they expire and when the kill switch is off, counted under client pi", async () => {
    const { service, admin, token } = await world();
    const { id, key } = await mint(service, token);
    const second = await mint(service, token);
    assert.equal((await service.request("DELETE", `/v1/harness-keys/${id}`, { token: key })).status, 200);
    const expired = await chat(service, key, {}, { "x-dl-harness": "pi" });
    assert.equal(expired.status, 401);
    assert.equal((await apiError(expired)).message, "This dl pi session key has expired. Quit Pi and run dl pi again.");

    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { allowOtherHarnesses: false } })).status, 200);
    const refused = await chat(service, second.key);
    assert.equal(refused.status, 403);
    const error = await apiError(refused);
    assert.equal(error.code, "harness_not_allowed");
    assert.equal(error.message, "Free tokens in Pi are switched off for now. Free tokens still work in dl (Autopilot), and Pi works with your own provider key.");
    const mintRefused = await service.request("POST", "/v1/harness-keys", { token, body: { harness: "pi" } });
    assert.equal(mintRefused.status, 403);
    const metrics = (await (await service.request("GET", "/admin/metrics", { token: admin })).json()) as { refusals: Array<{ reason: string; client: string; count: number }> };
    assert.equal(metrics.refusals.find((row) => row.reason === "harness_not_allowed" && row.client === "pi")?.count, 2);
  });
});

describe("Pi's share and refusals", () => {
  it("gets otherHarnessShare of the week, in Pi's words, when it is set below 1", async () => {
    const { service, token } = await world({ DEEPSEEK_WEEKLY_USD_CAP: "1", OTHER_HARNESS_SHARE: "0.5" });
    const { key } = await mint(service, token);
    // 10M uncached prompt tokens at $0.035/M: $0.35 a request.
    service.setLuminal(() => completion(luminalUsage(10_000_000, 0)));
    assert.equal((await chat(service, key)).status, 200);
    assert.equal((await chat(service, key)).status, 200);
    const refused = await chat(service, key);
    assert.equal(refused.status, 402);
    const error = await apiError(refused);
    assert.equal(error.code, "harness_limit");
    assert.match(error.message, /^Pi through dl gets half of your free allowance, and that part is used up\./);
    assert.equal((await service.request("POST", "/v1/chat/completions", { token, body: { model: MODEL, messages: [{ role: "user", content: "x" }] } })).status, 200);
  });

  it("words the dl-only refusal for dl pi", () => {
    assert.equal(requestClient("pi", "dl_only"), "pi");
    assert.equal(forHarness(gptLimitMessage("free"), "pi"), "You've used this week's GPT-6 allowance. DeepSeek V4.1 Flash still has free usage this week: pick it in /model, or get dl Pro: run dl and type /upgrade.");
  });
});
