import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  failedStream,
  FILE_OMITTED,
  IMAGE_OMITTED,
  REASONING_PREFIX,
  reasoningOf,
  responseAsStream,
  responsesError,
  responsesUsage,
  sealReasoning,
  streamFailure,
  toChatRequest,
  toResponse,
  toResponsesStream,
  type ToolNames,
} from "../src/responses.js";

/**
 * OpenAI Responses ⇄ Chat Completions (responses.ts), with no service around it: requests Codex
 * CLI sends (recorded from Codex 0.172.0 in test/fixtures), translated into chat completions, and
 * chat answers translated back into what Codex's Responses client parses.
 */

const MODEL = "deepseek/deepseek-v4.1-flash-1017";
const OPTIONS = { vision: false };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as { headers: Record<string, string>; body: Record<string, any> };
const FIRST = fixture("codex-0.172.0-first-request.json");
const TOOL_RESULT = fixture("codex-0.172.0-tool-result-request.json");

function translate(body: Record<string, unknown>, options = OPTIONS) {
  const out = toChatRequest(body, options);
  assert.ok(out.ok, out.ok ? "" : out.message);
  return out;
}

/** An OpenAI-style chat stream of these chunks, cut into `size`-byte pieces. */
function chunkStream(chunks: unknown[], options: { size?: number; done?: boolean } = {}): ReadableStream<Uint8Array> {
  const text = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + (options.done === false ? "" : "data: [DONE]\n\n");
  const bytes = new TextEncoder().encode(text);
  const size = options.size ?? bytes.length;
  return new ReadableStream({
    start(controller) {
      for (let at = 0; at < bytes.length; at += size) controller.enqueue(bytes.slice(at, at + size));
      controller.close();
    },
  });
}

/** The events of a Responses stream, checked the way Codex reads them: `event:` names the data's `type`. */
function parseEvents(text: string): Array<Record<string, any>> {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const name = /^event: (.+)$/m.exec(block)![1]!;
      const data = JSON.parse(/^data: (.+)$/m.exec(block)![1]!) as Record<string, any>;
      assert.equal(data.type, name, "event name and data type agree");
      return data;
    });
}

async function events(stream: ReadableStream<Uint8Array>): Promise<Array<Record<string, any>>> {
  return parseEvents(await new Response(stream).text());
}

const delta = (d: Record<string, unknown>, finish: string | null = null) => ({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: d, finish_reason: finish }] });
const usageChunk = (prompt: number, completion: number, cached = 0, reasoning = 0) => ({
  id: "c1",
  choices: [],
  usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, prompt_tokens_details: { cached_tokens: cached }, completion_tokens_details: { reasoning_tokens: reasoning } },
});

const answerOptions = (tools: ToolNames = new Map()) => ({ model: MODEL, tools, echo: {}, createdAt: 1_795_000_000, id: "resp_test" });

describe("Codex's requests → chat completions", () => {
  it("translates Codex 0.172.0's first request: developer prompts as system, its function tools and namespace, no hosted tools", () => {
    const out = translate(FIRST.body);
    const { body } = out;
    assert.equal(body.model, MODEL);
    assert.equal(body.stream, true);
    const messages = body.messages as Array<Record<string, any>>;
    assert.deepEqual(messages.map((message) => message.role), ["system", "system", "user", "user"]);
    assert.match(messages[0]!.content, /^You are a coding agent running in the Codex CLI/);
    assert.equal(messages[3]!.content, "say hi");
    const names = (body.tools as Array<Record<string, any>>).map((tool) => tool.function.name);
    assert.ok(names.includes("exec_command"));
    assert.ok(names.includes("multi_agent_v1__spawn_agent"), "a namespace's functions, prefixed with it");
    assert.ok(!names.some((name) => name.includes("web_search")), "hosted web search has no chat form");
    for (const tool of body.tools as Array<Record<string, any>>) {
      assert.equal(tool.type, "function");
      assert.match(tool.function.name, /^[A-Za-z0-9_-]{1,64}$/);
      assert.equal(tool.function.parameters.type, "object");
      assert.ok(!("strict" in tool.function));
    }
    assert.deepEqual(out.tools.get("multi_agent_v1__spawn_agent"), { name: "spawn_agent", namespace: "multi_agent_v1" });
    assert.equal(body.tool_choice, "auto");
    assert.equal(body.parallel_tool_calls, true);
    // Responses-only fields go no further.
    for (const field of ["input", "include", "store", "prompt_cache_key", "client_metadata", "reasoning", "instructions"]) assert.ok(!(field in body), field);
    assert.equal(out.sessionHint, FIRST.body.prompt_cache_key, "Codex's conversation id");
  });

  it("translates Codex's follow-up: reasoning, commentary and the call become one assistant message, then the tool output", () => {
    const { body } = translate(TOOL_RESULT.body);
    const messages = body.messages as Array<Record<string, any>>;
    assert.deepEqual(messages.slice(4), [
      {
        role: "assistant",
        content: "Let me run it.",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "exec_command", arguments: '{"cmd":"echo recorded-hi"}' } }],
        reasoning_content: "thinking about it",
      },
      { role: "tool", tool_call_id: "call_1", content: "Chunk ID: dd6263\nWall time: 0.0000 seconds\nProcess exited with code 0\nOriginal token count: 3\nOutput:\nrecorded-hi\n" },
    ]);
  });

  it("takes instructions, string input and easy messages", () => {
    assert.deepEqual(translate({ model: MODEL, instructions: "Be brief.", input: "hello" }).body.messages, [
      { role: "system", content: "Be brief." },
      { role: "user", content: "hello" },
    ]);
    assert.deepEqual(translate({ model: MODEL, input: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: [{ type: "input_text", text: "c" }] }] }).body.messages, [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ]);
  });

  it("keeps images for a model that reads them and leaves a note otherwise; files are notes", () => {
    const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }, { type: "input_file", file_data: "x" }] }];
    assert.deepEqual(translate({ model: MODEL, input }).body.messages, [{ role: "user", content: `look\n\n${IMAGE_OMITTED}\n\n${FILE_OMITTED}` }]);
    assert.deepEqual(translate({ model: MODEL, input }, { vision: true }).body.messages, [
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }, { type: "text", text: FILE_OMITTED }] },
    ]);
  });

  it("maps namespaced and freeform tool calls in the history back to the names the model was given", () => {
    const out = translate({
      model: MODEL,
      tools: [
        { type: "namespace", name: "multi_agent_v1", tools: [{ type: "function", name: "spawn_agent", parameters: { type: "object", properties: {} } }] },
        { type: "custom", name: "apply_patch", description: "Edit files.", format: { type: "grammar", syntax: "lark", definition: "start: patch" } },
      ],
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
        { type: "function_call", name: "spawn_agent", namespace: "multi_agent_v1", arguments: "{}", call_id: "c1" },
        { type: "function_call_output", call_id: "c1", output: [{ type: "input_text", text: "spawned" }] },
        { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch", call_id: "c2" },
        { type: "custom_tool_call_output", call_id: "c2", output: "Done" },
      ],
    });
    const messages = out.body.messages as Array<Record<string, any>>;
    assert.equal(messages[1]!.tool_calls[0].function.name, "multi_agent_v1__spawn_agent");
    assert.deepEqual(messages[2], { role: "tool", tool_call_id: "c1", content: "spawned" });
    assert.deepEqual(messages[3]!.tool_calls[0].function, { name: "apply_patch", arguments: '{"input":"*** Begin Patch"}' });
    assert.deepEqual(messages[4], { role: "tool", tool_call_id: "c2", content: "Done" });
    const patch = (out.body.tools as Array<Record<string, any>>).find((tool) => tool.function.name === "apply_patch")!;
    assert.deepEqual(patch.function.parameters.required, ["input"]);
    assert.match(patch.function.description, /Edit files\.[\s\S]*lark grammar:\nstart: patch/);
    assert.deepEqual(out.tools.get("apply_patch"), { name: "apply_patch", custom: true });
  });

  it("maps tool_choice, max_output_tokens, sampling, reasoning effort and text.format", () => {
    const tools = [{ type: "function", name: "f", parameters: { type: "object", properties: {} } }];
    const { body } = translate({ model: MODEL, input: "x", tools, tool_choice: { type: "function", name: "f" }, parallel_tool_calls: false, max_output_tokens: 500, temperature: 0.2, top_p: 0.9, reasoning: { effort: "xhigh", summary: "auto" }, text: { format: { type: "json_schema", name: "out", schema: { type: "object" }, strict: true }, verbosity: "low" } });
    assert.deepEqual(body.tool_choice, { type: "function", function: { name: "f" } });
    assert.equal(body.parallel_tool_calls, false);
    assert.equal(body.max_tokens, 500);
    assert.equal(body.temperature, 0.2);
    assert.equal(body.top_p, 0.9);
    assert.deepEqual(body.reasoning, { effort: "high" });
    assert.deepEqual(body.response_format, { type: "json_schema", json_schema: { name: "out", schema: { type: "object" }, strict: true } });
    assert.equal(translate({ model: MODEL, input: "x", tools, tool_choice: "required" }).body.tool_choice, "required");
    assert.ok(!("reasoning" in translate({ model: MODEL, input: "x", reasoning: { effort: "none" } }).body));
    assert.ok(!("tool_choice" in translate({ model: MODEL, input: "x", tool_choice: "auto" }).body), "no tools, no tool_choice");
  });

  it("refuses what needs a stored response, and empty input", () => {
    for (const [body, param] of [
      [{ model: MODEL, input: "x", previous_response_id: "resp_1" }, "previous_response_id"],
      [{ model: MODEL, input: "x", conversation: "conv_1" }, "conversation"],
      [{ model: MODEL, input: "x", background: true }, "background"],
      [{ model: MODEL, input: [{ type: "item_reference", id: "msg_1" }] }, "input[0]"],
      [{ model: MODEL, input: [] }, "input"],
      [{ input: "x" }, "model"],
    ] as const) {
      const out = toChatRequest(body as Record<string, unknown>, OPTIONS);
      assert.ok(!out.ok);
      assert.equal(out.param, param);
    }
    const stored = toChatRequest({ model: MODEL, input: "x", previous_response_id: "resp_1" }, OPTIONS);
    assert.ok(!stored.ok && /send the whole conversation in input/i.test(stored.message));
    // A null or empty previous_response_id is no previous response; store: true is just not kept.
    assert.ok(toChatRequest({ model: MODEL, input: "x", previous_response_id: null, store: true }, OPTIONS).ok);
  });

  it("round-trips reasoning text through encrypted_content, and drops anyone else's encrypted reasoning", () => {
    const sealed = sealReasoning("héllo ✓ reasoning");
    assert.ok(sealed.startsWith(REASONING_PREFIX));
    assert.equal(reasoningOf({ type: "reasoning", encrypted_content: sealed, summary: [] }), "héllo ✓ reasoning");
    assert.equal(reasoningOf({ type: "reasoning", encrypted_content: "gAAAAopaque", summary: [] }), undefined);
    const { body } = translate({ model: MODEL, input: [{ type: "message", role: "user", content: "x" }, { type: "reasoning", encrypted_content: "gAAAAopaque", summary: [] }, { type: "message", role: "assistant", content: [{ type: "output_text", text: "y" }] }] });
    assert.deepEqual((body.messages as unknown[])[1], { role: "assistant", content: "y" });
  });
});

describe("chat answers → Responses", () => {
  it("turns a completion into a response with reasoning, message and function call items, and usage with cached tokens", () => {
    const tools: ToolNames = new Map([["multi_agent_v1__spawn_agent", { name: "spawn_agent", namespace: "multi_agent_v1" }]]);
    const response = toResponse(
      {
        choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: "On it.", reasoning_content: "plan", tool_calls: [{ id: "call_9", type: "function", function: { name: "multi_agent_v1__spawn_agent", arguments: '{"task":"x"}' } }] } }],
        usage: usageChunk(1000, 50, 800, 20).usage,
      },
      answerOptions(tools),
    );
    assert.equal(response.object, "response");
    assert.equal(response.status, "completed");
    assert.equal(response.store, false);
    assert.equal(response.model, MODEL);
    const output = response.output as Array<Record<string, any>>;
    assert.deepEqual(output.map((item) => item.type), ["reasoning", "message", "function_call"]);
    assert.equal(output[0]!.encrypted_content, sealReasoning("plan"));
    assert.deepEqual(output[1]!.content, [{ type: "output_text", text: "On it.", annotations: [] }]);
    assert.deepEqual({ ...output[2], id: undefined }, { type: "function_call", id: undefined, status: "completed", call_id: "call_9", name: "spawn_agent", namespace: "multi_agent_v1", arguments: '{"task":"x"}' });
    assert.deepEqual(response.usage, { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 20 }, total_tokens: 1050 });
  });

  it("says incomplete at the output limit", () => {
    const response = toResponse({ choices: [{ finish_reason: "length", message: { content: "cut" } }] }, answerOptions());
    assert.equal(response.status, "incomplete");
    assert.deepEqual(response.incomplete_details, { reason: "max_output_tokens" });
  });

  it("streams the event sequence Codex parses: reasoning, text, a function call, then response.completed with usage", async () => {
    const stream = chunkStream(
      [
        delta({ role: "assistant", reasoning_content: "Think" }),
        delta({ reasoning_content: "ing." }),
        delta({ content: "Running " }),
        delta({ content: "it ✓" }),
        delta({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "exec_command", arguments: '{"cmd":' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }),
        delta({ tool_calls: [{ index: 1, id: "call_2", type: "function", function: { name: "exec_command", arguments: '{"cmd":"pwd"}' } }] }),
        delta({}, "tool_calls"),
        usageChunk(300, 25, 200, 5),
      ],
      { size: 7 },
    );
    const list = await events(toResponsesStream(stream, answerOptions()));
    assert.deepEqual(list.map((event) => event.type), [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.reasoning_text.delta",
      "response.reasoning_text.delta",
      "response.reasoning_text.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);
    assert.deepEqual(list.map((event) => event.sequence_number), list.map((_, index) => index));
    assert.equal(list[0]!.response.id, "resp_test");
    const done = list.filter((event) => event.type === "response.output_item.done").map((event) => event.item);
    assert.deepEqual(done[0], { type: "reasoning", id: done[0].id, summary: [], content: [{ type: "reasoning_text", text: "Thinking." }], encrypted_content: sealReasoning("Thinking.") });
    assert.deepEqual(done[1].content, [{ type: "output_text", text: "Running it ✓", annotations: [] }]);
    assert.deepEqual([done[2].call_id, done[2].name, done[2].arguments, done[2].status], ["call_1", "exec_command", '{"cmd":"ls"}', "completed"]);
    assert.deepEqual([done[3].call_id, done[3].arguments, list.at(-1)!.response.output.length], ["call_2", '{"cmd":"pwd"}', 4]);
    // Output indexes count up across items; Codex needs ids on each.
    assert.deepEqual(list.filter((event) => event.type === "response.output_item.added").map((event) => event.output_index), [0, 1, 2, 3]);
    const completed = list.at(-1)!.response;
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.usage, { input_tokens: 300, input_tokens_details: { cached_tokens: 200 }, output_tokens: 25, output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 325 });
  });

  it("gives a freeform tool's call back as a custom_tool_call with its raw input", async () => {
    const tools: ToolNames = new Map([["apply_patch", { name: "apply_patch", custom: true }]]);
    const list = await events(
      toResponsesStream(
        chunkStream([delta({ tool_calls: [{ index: 0, id: "call_p", function: { name: "apply_patch", arguments: '{"input":"*** Begin' } }] }), delta({ tool_calls: [{ index: 0, function: { arguments: ' Patch"}' } }] }), delta({}, "tool_calls"), usageChunk(10, 5)]),
        answerOptions(tools),
      ),
    );
    assert.deepEqual(list.map((event) => event.type).slice(2), ["response.output_item.added", "response.custom_tool_call_input.delta", "response.custom_tool_call_input.done", "response.output_item.done", "response.completed"]);
    const item = list.find((event) => event.type === "response.output_item.done")!.item;
    assert.deepEqual([item.type, item.name, item.call_id, item.input], ["custom_tool_call", "apply_patch", "call_p", "*** Begin Patch"]);
  });

  it("ends a stream cut off part way with response.failed (Codex retries it), and at the output limit with response.incomplete", async () => {
    const cut = await events(toResponsesStream(chunkStream([delta({ content: "partial" })], { done: false }), answerOptions()));
    assert.equal(cut.at(-1)!.type, "response.failed");
    assert.equal(cut.at(-1)!.response.error.code, "server_error");
    const errored = await events(toResponsesStream(chunkStream([delta({ content: "a" }), { error: { message: "boom" } }]), answerOptions()));
    assert.deepEqual([errored.at(-1)!.type, errored.at(-1)!.response.error.message], ["response.failed", "boom"]);
    const limit = await events(toResponsesStream(chunkStream([delta({ content: "a" }), delta({}, "length"), usageChunk(5, 5)]), answerOptions()));
    assert.equal(limit.at(-1)!.type, "response.incomplete");
    assert.deepEqual(limit.at(-1)!.response.incomplete_details, { reason: "max_output_tokens" });
  });

  it("sends a whole response as the same event sequence when the upstream didn't stream", () => {
    const response = toResponse({ choices: [{ finish_reason: "stop", message: { content: "hi", reasoning_content: "r" } }], usage: usageChunk(3, 2).usage }, answerOptions());
    const list = parseEvents(responseAsStream(response));
    assert.deepEqual(list.map((event) => event.type), [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.reasoning_text.delta",
      "response.reasoning_text.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    assert.deepEqual(list.at(-1)!.response.usage, responsesUsage(usageChunk(3, 2).usage));
  });
});

describe("refusals", () => {
  it("picks the code Codex acts on: retried when transient, shown and not retried otherwise", () => {
    assert.deepEqual(streamFailure(429, { code: "rate_limited", message: "Slow down.", retryable: true }, 7), { code: "rate_limit_exceeded", message: "Slow down.", dlCode: "rate_limited", retryAfter: 7 });
    assert.equal(streamFailure(503, { code: "upstream_unavailable", message: "Busy; retrying…" }).code, "server_error");
    assert.deepEqual(streamFailure(402, { code: "quota_exceeded", message: "You've used this week's allowance." }, 30), { code: "invalid_prompt", message: "You've used this week's allowance.", dlCode: "quota_exceeded" });
    assert.equal(streamFailure(400, { code: "upstream_error", message: "The model provider refused the request: the conversation is longer than the model's context window. Compact it or start a new one." }).code, "context_length_exceeded");
    assert.equal(streamFailure(400, { code: "upstream_error", message: "The model provider's content policy refused the request." }).code, "content_policy_violation");
  });

  it("streams a refusal as response.created then response.failed, the retry delay where Codex reads it", () => {
    const list = parseEvents(failedStream({ code: "rate_limit_exceeded", message: "Slow down.", retryAfter: 7, dlCode: "rate_limited" }, answerOptions()));
    assert.deepEqual(list.map((event) => event.type), ["response.created", "response.failed"]);
    assert.deepEqual(list[1]!.response.error, { code: "rate_limit_exceeded", message: "Slow down.", dl_code: "rate_limited", headers: { "retry-after": "7" } });
    assert.equal(list[1]!.response.status, "failed");
  });

  it("has OpenAI's error body shape", () => {
    assert.deepEqual(responsesError(402, "Used up.", "quota_exceeded", { resetsAt: "x" }), { error: { message: "Used up.", type: "insufficient_quota", code: "quota_exceeded", param: null, resetsAt: "x" } });
    assert.equal((responsesError(401, "Bad key.") as any).error.type, "authentication_error");
  });
});
