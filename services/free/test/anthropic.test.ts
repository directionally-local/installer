import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  anthropicError,
  anthropicUsage,
  DOCUMENT_OMITTED,
  errorStatus,
  estimateInputTokens,
  IMAGE_OMITTED,
  stopReasonOf,
  toAnthropicMessage,
  toAnthropicStream,
  toChatRequest,
} from "../src/anthropic.js";

/**
 * Anthropic Messages ⇄ Chat Completions (anthropic.ts), with no service around it: requests
 * Claude Code sends, translated for DeepSeek, and DeepSeek's answers translated back.
 */

const MODEL = "deepseek/deepseek-v4.1-flash-1017";
const OPTIONS = { model: MODEL, vision: false };

function translate(body: Record<string, unknown>) {
  const out = toChatRequest(body, OPTIONS);
  assert.ok(out.ok, out.ok ? "" : out.message);
  return out;
}

/** An OpenAI-style stream of these chunks, cut into `size`-byte pieces. */
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

/** The events of an Anthropic stream: [name, data]. */
async function events(stream: ReadableStream<Uint8Array>): Promise<Array<[string, Record<string, any>]>> {
  const text = await new Response(stream).text();
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const name = /^event: (.+)$/m.exec(block)![1]!;
      const data = JSON.parse(/^data: (.+)$/m.exec(block)![1]!) as Record<string, any>;
      assert.equal(data.type, name, "event name and data type agree");
      return [name, data];
    });
}

const delta = (d: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) => ({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: d, finish_reason: finish, ...extra }] });
const usageChunk = (prompt: number, completion: number, cached = 0) => ({ id: "c1", choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, prompt_tokens_details: { cached_tokens: cached } } });

describe("Anthropic requests → chat completions", () => {
  it("maps system (string and blocks), text, tools, tool_choice, sampling and stop sequences", () => {
    const out = translate({
      model: "claude-sonnet-4-5",
      max_tokens: 32000,
      temperature: 0.2,
      top_p: 0.9,
      top_k: 40,
      stop_sequences: ["</done>"],
      metadata: { user_id: "someone" },
      thinking: { type: "enabled", budget_tokens: 4000 },
      system: [{ type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } }, { type: "text", text: "Be brief." }],
      messages: [{ role: "user", content: "hello" }],
      tools: [
        { name: "Read", description: "Read a file", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
        { type: "web_search_20250305", name: "web_search", max_uses: 5 },
      ],
      tool_choice: { type: "any", disable_parallel_tool_use: true },
      stream: true,
    });
    assert.equal(out.model, "claude-sonnet-4-5", "toChatRequest keeps the asked name; the answer reports the served model (app.ts)");
    assert.equal(out.thinking, true);
    assert.equal(out.stream, true);
    assert.deepEqual(out.body, {
      model: MODEL,
      messages: [
        { role: "system", content: "You are Claude Code.\n\nBe brief." },
        { role: "user", content: "hello" },
      ],
      stream: true,
      max_tokens: 32000,
      temperature: 0.2,
      top_p: 0.9,
      stop: ["</done>"],
      tools: [{ type: "function", function: { name: "Read", description: "Read a file", parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } } }],
      tool_choice: "required",
      parallel_tool_calls: false,
    });
    assert.ok(!("metadata" in out.body) && !("thinking" in out.body) && !("top_k" in out.body));
  });

  it("maps every tool_choice", () => {
    const tools = [{ name: "Bash", input_schema: { type: "object" } }];
    const choice = (tool_choice: unknown) => translate({ messages: [{ role: "user", content: "x" }], tools, tool_choice }).body.tool_choice;
    assert.equal(choice({ type: "auto" }), "auto");
    assert.equal(choice({ type: "none" }), "none");
    assert.deepEqual(choice({ type: "tool", name: "Bash" }), { type: "function", function: { name: "Bash" } });
    assert.equal(choice(undefined), undefined);
  });

  it("round-trips tool_use and tool_result, nested content and is_error included, in chat order", () => {
    const out = translate({
      messages: [
        { role: "user", content: [{ type: "text", text: "read a.ts" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I should read it.", signature: "dl" },
            { type: "text", text: "Reading." },
            { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.ts" } },
            { type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "line 1" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
            { type: "tool_result", tool_use_id: "toolu_2", is_error: true, content: "ls: not found" },
            { type: "text", text: "and then?" },
          ],
        },
      ],
    });
    assert.deepEqual(out.body.messages, [
      { role: "user", content: "read a.ts" },
      {
        role: "assistant",
        content: "Reading.",
        tool_calls: [
          { id: "toolu_1", type: "function", function: { name: "Read", arguments: '{"file_path":"a.ts"}' } },
          { id: "toolu_2", type: "function", function: { name: "Bash", arguments: '{"command":"ls"}' } },
        ],
        reasoning_content: "I should read it.",
      },
      { role: "tool", tool_call_id: "toolu_1", content: `line 1\n${IMAGE_OMITTED}` },
      { role: "tool", tool_call_id: "toolu_2", content: "Error: ls: not found" },
      { role: "user", content: "and then?" },
    ]);
  });

  it("drops images and documents with a note when the model can't read them, and keeps images when it can", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
    const messages = [{ role: "user", content: [image, { type: "document", source: { type: "base64", media_type: "application/pdf", data: "AA" } }, { type: "text", text: "what is this?" }] }];
    assert.deepEqual(translate({ messages }).body.messages, [{ role: "user", content: `${IMAGE_OMITTED}\n\n${DOCUMENT_OMITTED}\n\nwhat is this?` }]);
    const seeing = toChatRequest({ messages: [{ role: "user", content: [image, { type: "text", text: "x" }] }] }, { model: MODEL, vision: true });
    assert.ok(seeing.ok);
    assert.deepEqual(seeing.body.messages, [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }, { type: "text", text: "x" }] }]);
  });

  it("refuses a body without messages, or with an unknown role", () => {
    assert.equal(toChatRequest({}, OPTIONS).ok, false);
    assert.equal(toChatRequest({ messages: [{ role: "tool", content: "x" }] }, OPTIONS).ok, false);
  });
});

describe("chat completions → Anthropic messages", () => {
  const options = { model: "claude-sonnet-4-5", thinking: false, stopSequences: [] as string[] };

  it("answers text with end_turn and Anthropic usage (cache reads apart)", () => {
    const message = toAnthropicMessage(
      { choices: [{ message: { role: "assistant", content: "Hello", reasoning_content: "hmm" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60 } } },
      options,
    );
    assert.match(String(message.id), /^msg_[0-9a-f]{24}$/);
    assert.deepEqual({ ...message, id: "x" }, {
      id: "x",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text: "Hello" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 40, output_tokens: 7, cache_read_input_tokens: 60, cache_creation_input_tokens: 0 },
    });
  });

  it("answers tool calls as tool_use blocks, thinking first when asked for", () => {
    const message = toAnthropicMessage(
      {
        choices: [
          {
            message: { content: null, reasoning_content: "Read it first.", tool_calls: [{ id: "call_1", type: "function", function: { name: "Read", arguments: '{"file_path":"a.ts"}' } }, { id: "call_2", type: "function", function: { name: "Bash", arguments: "not json" } }] },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
      { ...options, thinking: true },
    );
    assert.deepEqual(message.content, [
      { type: "thinking", thinking: "Read it first.", signature: "dl" },
      { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "a.ts" } },
      { type: "tool_use", id: "call_2", name: "Bash", input: {} },
    ]);
    assert.equal(message.stop_reason, "tool_use");
  });

  it("maps stop reasons", () => {
    assert.equal(stopReasonOf("stop", false), "end_turn");
    assert.equal(stopReasonOf("length", false), "max_tokens");
    assert.equal(stopReasonOf("length", true), "max_tokens");
    assert.equal(stopReasonOf("tool_calls", true), "tool_use");
    assert.equal(stopReasonOf("stop", true), "tool_use");
    assert.equal(stopReasonOf("content_filter", false), "refusal");
    assert.equal(stopReasonOf("stop", false, "</done>"), "stop_sequence");
    const stopped = toAnthropicMessage({ choices: [{ message: { content: "a" }, finish_reason: "stop", stop_reason: "</done>" }] }, { ...options, stopSequences: ["</done>"] });
    assert.equal(stopped.stop_reason, "stop_sequence");
    assert.equal(stopped.stop_sequence, "</done>");
  });

  it("reads usage defensively", () => {
    assert.deepEqual(anthropicUsage(undefined), { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    assert.deepEqual(anthropicUsage({ prompt_tokens: 5, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 9 } }).cache_read_input_tokens, 5, "cached never exceeds the prompt");
  });
});

describe("chat completion streams → Anthropic's event sequence", () => {
  const options = { model: "claude-haiku-4-5", thinking: false, stopSequences: [] as string[] };

  it("streams text: message_start, ping, one text block, message_delta with usage, message_stop", async () => {
    const out = await events(toAnthropicStream(chunkStream([delta({ role: "assistant", content: "" }), delta({ content: "Hel" }), delta({ content: "lo" }), delta({}, "stop"), usageChunk(100, 2, 40)], { size: 7 }), options));
    assert.deepEqual(
      out.map(([name]) => name),
      ["message_start", "ping", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"],
    );
    assert.equal(out[0]![1].message.model, "claude-haiku-4-5");
    assert.equal(out[0]![1].message.role, "assistant");
    assert.deepEqual(out[2]![1], { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    assert.equal(out[3]![1].delta.text + out[4]![1].delta.text, "Hello");
    assert.deepEqual(out[6]![1], {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { input_tokens: 60, output_tokens: 2, cache_read_input_tokens: 40, cache_creation_input_tokens: 0 },
    });
  });

  it("streams tool calls whose arguments are split across chunks, after text, as input_json_delta", async () => {
    const chunks = [
      delta({ content: "Let me look." }),
      delta({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "Read", arguments: "" } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '{"file_' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: 'path":"a.ts"}' } }] }),
      delta({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "Bash", arguments: '{"command":' } }] }),
      delta({ tool_calls: [{ index: 1, function: { arguments: '"ls"}' } }] }),
      delta({}, "tool_calls"),
      usageChunk(50, 20),
    ];
    const out = await events(toAnthropicStream(chunkStream(chunks, { size: 5 }), options));
    const starts = out.filter(([name]) => name === "content_block_start").map(([, data]) => data);
    assert.deepEqual(starts, [
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_a", name: "Read", input: {} } },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "call_b", name: "Bash", input: {} } },
    ]);
    const json = (index: number) =>
      out
        .filter(([name, data]) => name === "content_block_delta" && data.index === index && data.delta.type === "input_json_delta")
        .map(([, data]) => data.delta.partial_json)
        .join("");
    assert.deepEqual(JSON.parse(json(1)), { file_path: "a.ts" });
    assert.deepEqual(JSON.parse(json(2)), { command: "ls" });
    // Each block stops before the next starts.
    const order = out.filter(([name]) => name.startsWith("content_block_start") || name === "content_block_stop").map(([name, data]) => `${name}:${data.index}`);
    assert.deepEqual(order, ["content_block_start:0", "content_block_stop:0", "content_block_start:1", "content_block_stop:1", "content_block_start:2", "content_block_stop:2"]);
    assert.equal(out.at(-2)![1].delta.stop_reason, "tool_use");
    assert.equal(out.at(-1)![0], "message_stop");
  });

  it("streams reasoning as a signed thinking block only when thinking was asked for", async () => {
    const chunks = [delta({ reasoning_content: "think" }), delta({ content: "ok" }), delta({}, "stop"), usageChunk(1, 1)];
    const without = await events(toAnthropicStream(chunkStream(chunks), options));
    assert.equal(without.filter(([name]) => name === "content_block_start").length, 1);
    const withThinking = await events(toAnthropicStream(chunkStream(chunks), { ...options, thinking: true }));
    const deltas = withThinking.filter(([name]) => name === "content_block_delta").map(([, data]) => data.delta);
    assert.deepEqual(deltas, [
      { type: "thinking_delta", thinking: "think" },
      { type: "signature_delta", signature: "dl" },
      { type: "text_delta", text: "ok" },
    ]);
  });

  it("maps a length stop to max_tokens", async () => {
    const out = await events(toAnthropicStream(chunkStream([delta({ content: "a" }), delta({}, "length"), usageChunk(1, 1)]), options));
    assert.equal(out.at(-2)![1].delta.stop_reason, "max_tokens");
  });

  it("ends a stream that fails part way with an error event, not message_stop", async () => {
    const cut = await events(toAnthropicStream(chunkStream([delta({ content: "a" })], { done: false }), options));
    assert.deepEqual(cut.at(-1), ["error", { type: "error", error: { type: "api_error", message: "The model provider's answer ended early. Try again." } }]);
    assert.ok(!cut.some(([name]) => name === "message_stop"));
    const failed = await events(toAnthropicStream(chunkStream([delta({ content: "a" }), { error: { message: "boom" } }]), options));
    assert.equal(failed.at(-1)![1].error.message, "boom");
  });
});

describe("errors and token counts", () => {
  it("uses Anthropic's error shape and types", () => {
    assert.deepEqual(anthropicError(402, "Used up.", "trial_ended"), { type: "error", error: { type: "billing_error", message: "Used up.", code: "trial_ended" } });
    assert.equal((anthropicError(401, "x").error as { type: string }).type, "authentication_error");
    assert.equal((anthropicError(429, "x").error as { type: string }).type, "rate_limit_error");
  });

  it("keeps transient statuses (Claude Code retries them) and turns final refusals into 403", () => {
    assert.equal(errorStatus(503, true), 503);
    assert.equal(errorStatus(429, true), 429);
    assert.equal(errorStatus(503, false), 403);
    assert.equal(errorStatus(402, false), 402);
    assert.equal(errorStatus(502, false), 502);
  });

  it("estimates input tokens at about 4 characters each", () => {
    const body = { system: "x".repeat(400), messages: [{ role: "user", content: "y".repeat(400) }] };
    const estimate = estimateInputTokens(body);
    assert.ok(estimate > 200 && estimate < 260, String(estimate));
  });
});

describe("system messages inside messages", () => {
  it("keeps a system-role message (as Claude Code sends) as a system message instead of refusing", () => {
    const out = toChatRequest(
      { messages: [{ role: "system", content: [{ type: "text", text: "be brief" }] }, { role: "user", content: "hi" }], max_tokens: 10 },
      { model: "deepseek/deepseek-v4.1-flash-1017", vision: false },
    );
    assert.equal(out.ok, true);
    if (!out.ok) return;
    const messages = out.body.messages as Array<{ role: string; content: unknown }>;
    assert.deepEqual(messages[0], { role: "system", content: "be brief" });
    assert.equal(messages[1]!.role, "user");
  });

  it("still refuses an unknown role", () => {
    const out = toChatRequest({ messages: [{ role: "tool", content: "x" }] }, { model: "m", vision: false });
    assert.equal(out.ok, false);
  });
});
