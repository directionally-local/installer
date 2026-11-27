import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { ADMIN_ID, createService, MODEL, liquidCompletion, luminalUsage, openRelayUsage, sse, type Service } from "./harness.js";
import { modelById, onUpstream } from "../src/models.js";
import { openRelayRequest } from "../src/providers.js";
import {
  clampedMaxTokens,
  OPENRELAY_MAX_OUTPUT_TOKENS,
  openRelayRetryAfterSeconds,
  restoreToolNamesInCompletion,
  restoreToolNamesInStream,
  safeToolNames,
  strictComplete,
} from "../src/openrelay-shape.js";

/**
 * Open Relay's request rules (openrelay-shape.ts), each tested with the payload that drew its
 * opaque 400 in the probes of 27 Nov 2026, and only on Open Relay: other upstreams get the
 * client's request as it came.
 */

const KIMI = "moonshotai/kimi-k3.1-pro";
const deepseek = onUpstream(modelById(MODEL)!, "openrelay");
const kimi = onUpstream(modelById(KIMI)!, "openrelay");

// The probes' own payload parts (probe.py).
const TOOL = { type: "function", function: { name: "get_time", description: "Get the time", parameters: { type: "object", properties: { tz: { type: "string" } }, required: [] } } };
const U = { role: "user", content: "What time is it?" };
const U2 = { role: "user", content: "Thanks. Say ok." };
const OK = [{ role: "user", content: "Reply with exactly: ok" }];
const tool = (name: string, extra: Record<string, unknown> = {}) => ({ type: "function", function: { name, parameters: { type: "object", properties: {} }, ...extra } });

const shape = (model: typeof deepseek, body: Record<string, unknown>, maxTokens = 16, stream = false) => openRelayRequest(body, { model, maxTokens, stream });

describe("Open Relay DeepSeek: tool names", () => {
  it("renames fs.read, fs:read and fs/read (probe u_tool_name_with_dot, ds_tool_name_*) and leaves fs_read and fs-read", () => {
    for (const name of ["fs.read", "fs:read", "fs/read"]) {
      const { payload, toolNames } = shape(deepseek, { messages: OK, max_tokens: 16, tools: [tool(name)] });
      const sent = (payload.tools as Array<{ function: { name: string } }>)[0]!.function.name;
      assert.equal(sent, "fs__read");
      assert.match(sent, /^[A-Za-z0-9_-]+$/);
      assert.equal(toolNames?.get("fs__read"), name);
    }
    for (const name of ["fs_read", "fs-read"]) {
      const body = { messages: OK, max_tokens: 16, tools: [tool(name)] };
      const { payload, toolNames } = shape(deepseek, body);
      assert.equal(payload.tools, body.tools);
      assert.equal(toolNames, undefined);
    }
  });

  it("never collides: with fs__read taken, and fs.read and fs:read both present, each gets its own name", () => {
    const renamed = safeToolNames(["fs__read", "fs.read", "fs:read", "fs__read_2"])!;
    assert.deepEqual([...renamed], [["fs.read", "fs__read_3"], ["fs:read", "fs__read_4"]]);
    const long = safeToolNames(["a".repeat(70) + ".x"])!;
    assert.ok([...long.values()][0]!.length <= 64);
  });

  it("renames in tool_choice and the history (assistant tool_calls, tool results), never in the client's body", () => {
    const body = {
      tools: [tool("fs.read"), TOOL],
      tool_choice: { type: "function", function: { name: "fs.read" } },
      messages: [
        U,
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "fs.read", arguments: "{}" } }, { id: "call_2", type: "function", function: { name: "get_time", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", name: "fs.read", content: "file" },
        { role: "tool", tool_call_id: "call_2", content: "12:00" },
        U2,
      ],
    };
    const before = JSON.stringify(body);
    const { payload } = shape(deepseek, body);
    assert.equal(JSON.stringify(body), before);
    const sent = JSON.stringify(payload);
    assert.ok(!sent.includes("fs.read"));
    assert.deepEqual(payload.tool_choice, { type: "function", function: { name: "fs__read" } });
    const messages = payload.messages as Array<Record<string, any>>;
    assert.deepEqual(messages[1]!.tool_calls.map((call: any) => call.function.name), ["fs__read", "get_time"]);
    assert.equal(messages[2]!.name, "fs__read");
    assert.equal(messages[3], body.messages[3]);
  });

  it("leaves Kimi's tool names alone (it takes fs.read)", () => {
    const body = { messages: [U], tools: [tool("fs.read")] };
    const { payload, toolNames } = shape(kimi, body);
    assert.equal(payload.tools, body.tools);
    assert.equal(toolNames, undefined);
  });

  it("gives the client's names back in a completion", () => {
    const names = new Map([["fs__read", "fs.read"]]);
    const text = JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "fs__read", arguments: "{\"path\":\"a\"}" } }, { id: "d", type: "function", function: { name: "get_time", arguments: "{}" } }] } }] });
    const back = JSON.parse(restoreToolNamesInCompletion(text, names));
    assert.deepEqual(back.choices[0].message.tool_calls.map((call: any) => call.function.name), ["fs.read", "get_time"]);
    assert.equal(back.choices[0].message.tool_calls[0].function.arguments, "{\"path\":\"a\"}");
    const plain = JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "hi" } }] });
    assert.equal(restoreToolNamesInCompletion(plain, names), plain);
    assert.equal(restoreToolNamesInCompletion("not json", names), "not json");
  });

  it("gives the client's names back in stream deltas, whole or split across chunks", async () => {
    const names = new Map([["fs__read", "fs.read"]]);
    const chunk = (calls: unknown[]) => JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: calls }, finish_reason: null }] });
    const upstream = sse([
      chunk([{ index: 0, id: "c1", type: "function", function: { name: "fs__read", arguments: "" } }]),
      chunk([{ index: 0, function: { arguments: "{\"path\":" } }]),
      chunk([{ index: 1, id: "c2", type: "function", function: { name: "fs_", arguments: "" } }]),
      chunk([{ index: 1, function: { name: "_read" } }]),
      chunk([{ index: 1, function: { arguments: "{}" } }]),
      chunk([{ index: 2, id: "c3", type: "function", function: { name: "fs", arguments: "" } }]),
      chunk([{ index: 2, function: { name: "_list", arguments: "{}" } }]),
      JSON.stringify({ choices: [], usage: openRelayUsage(10, 5) }),
    ], { split: true });
    const text = await new Response(restoreToolNamesInStream(upstream.body!, names)).text();
    const deltas = text.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
    const assembled = new Map<number, string>();
    for (const delta of deltas) for (const call of delta.choices[0]?.delta?.tool_calls ?? []) assembled.set(call.index, (assembled.get(call.index) ?? "") + (call.function?.name ?? ""));
    assert.deepEqual([...assembled], [[0, "fs.read"], [1, "fs.read"], [2, "fs_list"]]);
    assert.ok(text.includes("data: [DONE]"));
    assert.ok(text.includes("\"usage\""));
  });
});

describe("Open Relay DeepSeek: strict tools", () => {
  it("drops strict on a schema with an optional property (probe u3_tool_strict)", () => {
    const body = { messages: [U], max_tokens: 16, tools: [{ type: "function", function: { ...TOOL.function, strict: true } }] };
    const { payload } = shape(deepseek, body);
    const fn = (payload.tools as Array<{ function: Record<string, unknown> }>)[0]!.function;
    assert.equal("strict" in fn, false);
    assert.deepEqual(fn.parameters, TOOL.function.parameters);
    assert.equal((body.tools[0]!.function as Record<string, unknown>).strict, true);
  });

  it("keeps strict on a strict-complete schema, and keeps strict: false", () => {
    const complete = { type: "object", properties: { tz: { type: "string" }, opts: { type: "object", properties: { a: { type: "integer" } }, required: ["a"], additionalProperties: false } }, required: ["tz", "opts"], additionalProperties: false };
    assert.ok(strictComplete(complete));
    const body = { messages: OK, tools: [tool("ok", { strict: true, parameters: complete }), tool("noop", { strict: false })] };
    assert.equal(shape(deepseek, body).payload.tools, body.tools);
    assert.ok(!strictComplete({ ...complete, properties: { ...complete.properties, opts: { type: "object", properties: { a: { type: "integer" } }, required: [] , additionalProperties: false } } }));
    assert.ok(!strictComplete({ type: "array", items: { type: "object", properties: { a: {} } } }));
  });

  it("leaves strict on Kimi (it takes it)", () => {
    const body = { messages: [U], tools: [{ type: "function", function: { ...TOOL.function, strict: true } }] };
    assert.equal(shape(kimi, body).payload.tools, body.tools);
  });
});

describe("Open Relay DeepSeek: reasoning effort with tools (workaround for its placeholder-token runaway)", () => {
  it("sends unset or medium effort as high when tools are present; low and high as sent", () => {
    assert.equal(shape(deepseek, { messages: [U], tools: [TOOL] }).payload.reasoning_effort, "high");
    assert.equal(shape(deepseek, { messages: [U], tools: [TOOL], reasoning_effort: "medium" }).payload.reasoning_effort, "high");
    assert.equal(shape(deepseek, { messages: [U], tools: [TOOL], reasoning: { effort: "medium" } }).payload.reasoning_effort, "high");
    assert.equal(shape(deepseek, { messages: [U], tools: [TOOL], reasoning_effort: "low" }).payload.reasoning_effort, "low");
    assert.equal(shape(deepseek, { messages: [U], tools: [TOOL], reasoning_effort: "high" }).payload.reasoning_effort, "high");
  });

  it("leaves effort alone without tools, and on Kimi", () => {
    assert.equal("reasoning_effort" in shape(deepseek, { messages: [U] }).payload, false);
    assert.equal(shape(deepseek, { messages: [U], tools: [], reasoning_effort: "medium" }).payload.reasoning_effort, "medium");
    assert.equal("reasoning_effort" in shape(kimi, { messages: [U], tools: [TOOL] }).payload, false);
    assert.equal(shape(kimi, { messages: [U], tools: [TOOL], reasoning_effort: "medium" }).payload.reasoning_effort, "medium");
  });
});

describe("Open Relay: max_tokens and unsupported fields", () => {
  it("holds max_tokens inside the window after the prompt (probe ds_max_tokens_393216, q2_max_tokens_too_large)", () => {
    assert.equal(shape(deepseek, { messages: OK }, 393_216).payload.max_tokens, OPENRELAY_MAX_OUTPUT_TOKENS);
    assert.equal(shape(deepseek, { messages: [U] }, 10_000_000).payload.max_tokens, OPENRELAY_MAX_OUTPUT_TOKENS);
    assert.equal(clampedMaxTokens(65_536, 380_000, 393_216), 13_216);
    assert.equal(clampedMaxTokens(65_536, 250_000, 262_144), 12_144);
    // An estimate past the window still leaves room to answer; Open Relay's context error moves it on.
    assert.equal(clampedMaxTokens(65_536, 500_000, 393_216), 4_096);
    assert.equal(clampedMaxTokens(2_000, 10, 393_216), 2_000);
    const long = [{ role: "user", content: "x".repeat(1_000_000) }];
    const sent = shape(kimi, { messages: long }, 65_536).payload.max_tokens as number;
    assert.ok(sent < 65_536 && sent >= 4_096);
  });

  it("never sends Kimi max_tokens 0 (probe q3_max_tokens_zero) nor top_logprobs (probe r3_logprobs)", () => {
    const { payload } = shape(kimi, { messages: [U], logprobs: true, top_logprobs: 2, max_completion_tokens: 0 }, 0);
    assert.equal(payload.max_tokens, 1);
    assert.equal("top_logprobs" in payload, false);
    assert.equal("logprobs" in payload, false);
    assert.equal("max_completion_tokens" in payload, false);
  });
});

describe("Open Relay: its 429's wait", () => {
  it("reads 'retry after Ns' from the message, else the header", () => {
    const body = JSON.stringify({ error: { code: "rate_limit_error", message: "tokens rate limit exceeded; retry after 74s", type: "rate_limit_error" } });
    assert.equal(openRelayRetryAfterSeconds(body), 74);
    assert.equal(openRelayRetryAfterSeconds("{}", "9"), 9);
    assert.equal(openRelayRetryAfterSeconds(JSON.stringify({ error: { type: "rate_limit_error" } })), undefined);
    assert.equal(openRelayRetryAfterSeconds("retry after 2.5s"), 3);
  });
});

// On the service: Open Relay first for DeepSeek and Kimi, Luminal and Liquid behind.
const KEY = "or_test_secret";
const FIRST = { OPENRELAY_API_KEY: KEY, OPENRELAY_STATUS: "on", OPENRELAY_MODELS: `${MODEL},${KIMI}` };
let ips = 0;
const ip = () => `10.14.${Math.floor(++ips / 250) % 250}.${ips % 250}`;

async function member(vars: Record<string, string> = {}): Promise<{ service: Service; token: string; admin: string }> {
  const service = await createService({ OPEN_ADMISSION: "true", OPENAI_API_KEY: "sk-openai-test", LUMINAL_API_KEY: "lum-test", ...FIRST, ...vars });
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const token = (await service.signIn({ id: 100, login: "alice" })).access_token;
  return { service, token, admin };
}

const chat = (service: Service, token: string, body: Record<string, unknown>, model = MODEL) =>
  service.request("POST", "/v1/chat/completions", { token, ip: ip(), body: { model, messages: [U], ...body } });

function rows(service: Service): Array<Record<string, any>> {
  service.directory();
  const db = (service.namespaces.DIRECTORY!.instances.get("directory")!.state as unknown as { db: DatabaseSync }).db;
  return db.prepare("SELECT upstream, status FROM requests ORDER BY id").all() as Array<Record<string, any>>;
}

const toolCallAnswer = (name: string) =>
  Response.json({ id: "or_1", object: "chat.completion", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_9", type: "function", function: { name, arguments: "{}" } }] } }], usage: openRelayUsage(100, 10) });

describe("Open Relay rules on the service", () => {
  it("sends DeepSeek safe tool names and gives the client its own back; Luminal gets them as they came", async () => {
    const { service, token } = await member();
    service.setOpenRelay((body) => {
      const names = (body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
      return names.includes("fs.read") ? Response.json({ error: { code: "invalid_request_error", message: "the request was rejected by the model", type: "invalid_request_error" } }, { status: 400 }) : toolCallAnswer("fs__read");
    });
    const response = await chat(service, token, { tools: [tool("fs.read")], tool_choice: { type: "function", function: { name: "fs.read" } } });
    assert.equal(response.status, 200);
    const answer = (await response.json()) as any;
    assert.equal(answer.choices[0].message.tool_calls[0].function.name, "fs.read");
    assert.equal((service.calls.openrelay[0]!.body.tool_choice as any).function.name, "fs__read");
    assert.equal(service.calls.luminal.length, 0);
    // Open Relay down: Luminal serves the client's own names.
    service.setOpenRelay(() => Response.json({ error: { type: "api_error" } }, { status: 503 }));
    assert.equal((await chat(service, token, { tools: [tool("fs.read")] })).status, 200);
    assert.equal((service.calls.luminal[0]!.body.tools as any)[0].function.name, "fs.read");
  });

  it("gives the client's names back in a stream", async () => {
    const { service, token } = await member();
    service.setOpenRelay(() =>
      sse([
        JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "fs__read", arguments: "" } }] }, finish_reason: null }] }),
        JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] }, finish_reason: "tool_calls" }] }),
        JSON.stringify({ choices: [], usage: openRelayUsage(100, 10), openrelay: { cost_nano_usd: 1000, priced_at: "online" } }),
      ]),
    );
    const response = await chat(service, token, { stream: true, tools: [tool("fs.read")] });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(text.includes("\"name\":\"fs.read\""));
    assert.ok(!text.includes("fs__read"));
    assert.deepEqual(rows(service).map((row) => [row.upstream, row.status]), [["openrelay", "ok"]]);
  });

  it("on a 429 that names its wait, Luminal serves now and Open Relay is skipped until the wait is over", async () => {
    const { service, token } = await member();
    service.setOpenRelay(() => Response.json({ error: { code: "rate_limit_error", message: "tokens rate limit exceeded; retry after 74s", type: "rate_limit_error" } }, { status: 429 }));
    assert.equal((await chat(service, token, {})).status, 200);
    assert.equal(service.calls.openrelay.length, 1);
    service.setOpenRelay((body) => (body.stream ? sse([]) : toolCallAnswer("x")));
    service.clock.now += 30_000;
    assert.equal((await chat(service, token, {})).status, 200);
    assert.equal(service.calls.openrelay.length, 1);
    service.clock.now += 45_000;
    assert.equal((await chat(service, token, {})).status, 200);
    assert.equal(service.calls.openrelay.length, 2);
    assert.deepEqual(rows(service).map((row) => [row.upstream, row.status]), [
      ["openrelay", "upstream_busy"],
      ["luminal", "ok"],
      ["luminal", "ok"],
      ["openrelay", "ok"],
    ]);
  });

  it("with no upstream behind it, a cooling-down Open Relay still serves, and its 429 says how long to wait", async () => {
    const { service, token } = await member({ LUMINAL_API_KEY: "", OPENROUTER_API_KEY: "" });
    service.setOpenRelay(() => Response.json({ error: { code: "rate_limit_error", message: "tokens rate limit exceeded; retry after 12s", type: "rate_limit_error" } }, { status: 429 }));
    const busy = await chat(service, token, {});
    assert.equal(busy.status, 429);
    assert.equal(busy.headers.get("retry-after"), "12");
    service.setOpenRelay(() => toolCallAnswer("x"));
    assert.equal((await chat(service, token, {})).status, 200);
    assert.equal(service.calls.openrelay.length, 2);
  });

  it("Kimi: a cooling-down Open Relay gives way to Liquid; no top_logprobs and no max_tokens 0 on Open Relay", async () => {
    const { service, admin } = await member({ LIQUID_INFERENCE_API_KEY: "sk-architect-test-secret", LIQUID_STATUS: "on" });
    service.setLiquid(() => liquidCompletion(luminalUsage(100, 10)));
    service.setOpenRelay(() => toolCallAnswer("x"));
    assert.equal((await chat(service, admin, { logprobs: true, top_logprobs: 2, max_tokens: 0 }, KIMI)).status, 200);
    const sent = service.calls.openrelay[0]!.body;
    assert.equal("top_logprobs" in sent, false);
    assert.ok((sent.max_tokens as number) >= 1);
    service.setOpenRelay(() => Response.json({ error: { code: "rate_limit_error", message: "tokens rate limit exceeded; retry after 60s", type: "rate_limit_error" } }, { status: 429 }));
    assert.equal((await chat(service, admin, {}, KIMI)).status, 200);
    assert.equal((await chat(service, admin, {}, KIMI)).status, 200);
    assert.equal(service.calls.openrelay.length, 2);
    assert.equal(service.calls.liquid.length, 2);
  });
});
