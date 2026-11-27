import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, createService, MODEL, type Service } from "./harness.js";
import { repairToolHistory, STOPPED_TOOL_RESULT } from "../src/tool-history.js";
import { GENERIC, REJECTED_AFTER_REPAIR } from "../src/upstream-errors.js";

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

  // Open Relay's probes (27 Nov 2026): both DeepSeek and Kimi give an opaque 400 for these.
  const probeTool = { type: "function", function: { name: "get_time", description: "Get the time", parameters: { type: "object", properties: { tz: { type: "string" } }, required: [] } } };
  const probeAsk = { role: "user", content: "What time is it?" };
  const probeCall = { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_time", arguments: "{}" } }] };
  const probeResult = { role: "tool", tool_call_id: "call_1", content: "12:00" };
  const probeNext = { role: "user", content: "Thanks. Say ok." };

  it("drops an orphan tool result with no tool call before it (probe d_orphan_tool_result_no_call)", () => {
    const body = { tools: [probeTool], messages: [probeAsk, probeResult, probeNext], max_tokens: 16 };
    const out = repairToolHistory(body.messages);
    assert.deepEqual(out.messages, [probeAsk, probeNext]);
    assert.deepEqual([out.added, out.dropped], [0, 1]);
  });

  it("drops an extra tool result with an unknown tool_call_id (probe e_tool_result_unknown_id)", () => {
    const body = { tools: [probeTool], messages: [probeAsk, probeCall, probeResult, { role: "tool", tool_call_id: "call_zzz", content: "x" }, probeNext], max_tokens: 16 };
    const out = repairToolHistory(body.messages);
    assert.deepEqual(out.messages, [probeAsk, probeCall, probeResult, probeNext]);
    assert.deepEqual([out.added, out.dropped], [0, 1]);
  });

  it("drops a tool result whose tool_call_id is missing, and an orphan that opens the history", () => {
    const out = repairToolHistory([probeResult, probeAsk, probeCall, { role: "tool", content: "no id" }, probeResult, probeNext]);
    assert.deepEqual(out.messages, [probeAsk, probeCall, probeResult, probeNext]);
    assert.deepEqual([out.added, out.dropped], [0, 2]);
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

  /** Runs `fn` with console.error captured; returns the structured refusal lines it logged. */
  async function refusalLogs(fn: () => Promise<void>): Promise<Array<Record<string, unknown>>> {
    const original = console.error;
    const lines: Array<Record<string, unknown>> = [];
    console.error = (...args: unknown[]) => {
      try {
        const parsed = JSON.parse(String(args[0])) as Record<string, unknown>;
        if (parsed.event === "free.upstream_unknown_refusal") lines.push(parsed);
      } catch {
        // not a structured line
      }
    };
    try {
      await fn();
    } finally {
      console.error = original;
    }
    return lines;
  }

  it("with no upstream after Open Relay, its 400 goes back with what to do, never 'refused' alone or 'start over'", async () => {
    const { service, token } = await member({ LUMINAL_API_KEY: "", OPENROUTER_API_KEY: "" });
    service.setOpenRelay(rejected);
    let error = { code: "", message: "" };
    const logs = await refusalLogs(async () => {
      const response = await chat(service, token, [ask]);
      assert.equal(response.status, 400);
      ({ error } = (await response.json()) as { error: { code: string; message: string } });
    });
    assert.equal(error.code, "upstream_error");
    assert.equal(error.message, GENERIC);
    assert.doesNotMatch(error.message, /\/clear|new conversation/);
    assert.ok(!error.message.includes("rejected by the model"), "the provider's text isn't passed on");
    assert.equal(logs.length, 1);
    assert.equal(logs[0]!.historyRepaired, false);
  });

  it("a repaired history the upstreams still reject keeps the conversation, and is logged", async () => {
    const { service, token } = await member({ LUMINAL_API_KEY: "", OPENROUTER_API_KEY: "" });
    service.setOpenRelay(rejected);
    const broken = [system, ask, assistant("a", "b"), result("a", STOPPED_TOOL_RESULT), result("a", "late"), next];
    let error = { code: "", message: "" };
    const logs = await refusalLogs(async () => {
      const response = await chat(service, token, broken);
      assert.equal(response.status, 400);
      ({ error } = (await response.json()) as { error: { code: string; message: string } });
    });
    assert.equal(error.code, "upstream_error");
    assert.equal(error.message, REJECTED_AFTER_REPAIR);
    assert.match(error.message, /Send your message again/);
    assert.doesNotMatch(error.message, /\/clear|new conversation/);
    assert.equal(logs.length, 1);
    assert.deepEqual(
      { repaired: logs[0]!.historyRepaired, added: logs[0]!.resultsAdded, dropped: logs[0]!.resultsDropped, provider: logs[0]!.provider, status: logs[0]!.upstreamStatus },
      { repaired: true, added: 1, dropped: 1, provider: "openrelay", status: 400 },
    );
    assert.ok(!JSON.stringify(logs[0]).includes("late"), "no content in the log");
  });

  it("a request that succeeds logs nothing", async () => {
    const { service, token } = await member();
    const logs = await refusalLogs(async () => {
      const response = await chat(service, token, [ask]);
      assert.equal(response.status, 200);
    });
    assert.equal(logs.length, 0);
  });
});
