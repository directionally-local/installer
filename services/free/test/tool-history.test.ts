import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, createService, MODEL, type Service } from "./harness.js";
import { repairToolHistory, STOPPED_TOOL_RESULT } from "../src/tool-history.js";

/**
 * A history broken by an interrupted tool call is made valid before any upstream sees it, and
 * Open Relay's opaque 400 goes on to the next upstream instead of back to the person.
 */

const system = { role: "system", content: "You are a coding agent." };
const ask = { role: "user", content: "check pr 5" };
const call = (id: string, name = "github_pr_checks") => ({ id, type: "function", function: { name, arguments: "{}" } });
const assistant = (...ids: string[]) => ({ role: "assistant", content: "", tool_calls: ids.map((id) => call(id)) });
const result = (id: string, content: string) => ({ role: "tool", tool_call_id: id, content, name: "github_pr_checks" });
const next = { role: "user", content: "say hi" };

describe("repairToolHistory", () => {
  it("leaves a valid history alone (the same array)", () => {
    const messages = [system, ask, assistant("a", "b"), result("b", "2"), result("a", "1"), { role: "assistant", content: "done" }, next];
    const out = repairToolHistory(messages);
    assert.equal(out.messages, messages);
    assert.deepEqual([out.added, out.dropped], [0, 0]);
    assert.equal(repairToolHistory([]).messages.length, 0);
  });

  it("drops a second result for a call already answered (stopped, then the tool's late result)", () => {
    const out = repairToolHistory([system, ask, assistant("a"), result("a", STOPPED_TOOL_RESULT), result("a", "error: aborted"), next]);
    assert.deepEqual(out.messages, [system, ask, assistant("a"), result("a", STOPPED_TOOL_RESULT), next]);
    assert.deepEqual([out.added, out.dropped], [0, 1]);
  });

  it("drops a result that comes after the next user message", () => {
    const out = repairToolHistory([system, ask, assistant("a"), result("a", STOPPED_TOOL_RESULT), next, result("a", "late")]);
    assert.deepEqual(out.messages, [system, ask, assistant("a"), result("a", STOPPED_TOOL_RESULT), next]);
    assert.deepEqual([out.added, out.dropped], [0, 1]);
  });

  it("gives a call left without a result a (stopped) one, right after its assistant message", () => {
    const out = repairToolHistory([system, ask, assistant("a", "b"), result("a", "1"), next]);
    assert.deepEqual(out.messages, [system, ask, assistant("a", "b"), result("a", "1"), { role: "tool", tool_call_id: "b", content: STOPPED_TOOL_RESULT, name: "github_pr_checks" }, next]);
    assert.deepEqual([out.added, out.dropped], [1, 0]);
    // At the very end too.
    assert.equal(repairToolHistory([ask, assistant("a")]).added, 1);
  });

  it("drops results for calls the assistant message didn't make, and tool results with no calls before them", () => {
    const out = repairToolHistory([system, result("x", "stray"), ask, assistant("a"), result("a", "1"), result("zz", "unknown"), next]);
    assert.deepEqual(out.messages, [system, ask, assistant("a"), result("a", "1"), next]);
    assert.equal(out.dropped, 2);
  });

  it("never touches the text of what it keeps, nor anything that isn't a message", () => {
    const odd = [ask, "not a message", assistant("a"), result("a", "1"), null, next];
    assert.equal(repairToolHistory(odd).messages, odd);
  });
});

const KEY = "or_test_secret";
const FIRST = { OPENRELAY_API_KEY: KEY, OPENRELAY_STATUS: "on", OPENRELAY_MODELS: MODEL };
let ips = 0;
const ip = () => `10.14.${Math.floor(++ips / 250) % 250}.${ips % 250}`;

async function member(vars: Record<string, string> = {}): Promise<{ service: Service; token: string }> {
  const service = await createService({ OPEN_ADMISSION: "true", OPENAI_API_KEY: "sk-openai-test", LUMINAL_API_KEY: "lum-test", ...FIRST, ...vars });
  await service.signIn({ id: ADMIN_ID, login: "owner" });
  const token = (await service.signIn({ id: 100, login: "alice" })).access_token;
  return { service, token };
}

const chat = (service: Service, token: string, messages: unknown[]) => service.request("POST", "/v1/chat/completions", { token, ip: ip(), body: { model: MODEL, messages } });

/** Open Relay's live answer to a broken history (26 Nov 2026). */
const rejected = () => Response.json({ error: { code: "invalid_request_error", message: "the request was rejected by the model", type: "invalid_request_error" } }, { status: 400 });

describe("broken histories on the free tier", () => {
  it("sends Open Relay a repaired history: one result per call", async () => {
    const { service, token } = await member();
    const broken = [system, ask, assistant("a"), result("a", STOPPED_TOOL_RESULT), result("a", "error: aborted"), next];
    const response = await chat(service, token, broken);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(service.calls.luminal.length, 0);
    assert.deepEqual(service.calls.openrelay[0]!.body.messages, [system, ask, assistant("a"), result("a", STOPPED_TOOL_RESULT), next]);
  });

  it("on Open Relay's opaque 400, Luminal serves the same model before anything reaches the client", async () => {
    const { service, token } = await member();
    service.setOpenRelay(rejected);
    const response = await chat(service, token, [ask]);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get("x-dl-fallback"), null);
    assert.equal(service.calls.openrelay.length, 1);
    assert.equal(service.calls.luminal.length, 1);
  });

  it("with no upstream after Open Relay, its 400 goes back with what to do about it, never 'refused' alone", async () => {
    const { service, token } = await member({ LUMINAL_API_KEY: "", OPENROUTER_API_KEY: "" });
    service.setOpenRelay(rejected);
    const response = await chat(service, token, [ask]);
    assert.equal(response.status, 400);
    const { error } = (await response.json()) as { error: { code: string; message: string; upstreamReason?: string } };
    assert.equal(error.code, "upstream_error");
    assert.match(error.message, /interrupted step/);
    assert.match(error.message, /dl update/);
    assert.ok(!error.message.includes("rejected by the model"), "the provider's text isn't passed on");
  });
});
