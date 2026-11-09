import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ADMIN_ID,
  completion,
  createService,
  errorCode,
  functionCallItem,
  luminalUsage,
  messageItem,
  openaiResponse,
  responseObject,
  responsesSse,
  responsesTextEvents,
  responsesUsage,
  type Service,
} from "./harness.js";

/**
 * GPT-6 goes through OpenAI's Responses API (its chat completions API refuses function tools
 * while GPT-6 reasons). Clients still speak Chat Completions: the service translates both ways.
 */

const OPENAI = { OPENAI_API_KEY: "sk-openai-test" };
const BOTH = { OPENAI_API_KEY: "sk-openai-test", LUMINAL_API_KEY: "lum-test" };

const tools = [
  { type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
];

async function member(vars: Record<string, string> = OPENAI): Promise<{ service: Service; token: string; adminToken: string }> {
  const service = await createService({ OPEN_ADMISSION: "true", ...vars });
  const adminToken = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const token = (await service.signIn({ id: 100, login: "alice" })).access_token;
  return { service, token, adminToken };
}

const chat = (service: Service, token: string, body: Record<string, unknown>) =>
  service.request("POST", "/v1/chat/completions", { token, body: { model: "gpt-6-astra", messages: [{ role: "user", content: "hello" }], ...body } });

/** The data lines of a chat completions stream, parsed (`[DONE]` as the string). */
async function chunks(response: Response): Promise<unknown[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6))
    .map((data) => (data === "[DONE]" ? data : JSON.parse(data)));
}

const pools = async (service: Service, token: string) =>
  ((await (await service.request("GET", "/v1/me", { token })).json()) as { pools: Record<string, { usedThisWeek: number }> }).pools;

const openaiCreditUsed = async (service: Service, adminToken: string) =>
  ((await (await service.request("GET", "/admin/spend", { token: adminToken })).json()) as { openaiCredit: { usedUsd: number } }).openaiCredit.usedUsd;

const toolCallEvents = (callId: string, args: string[]) => {
  const item = functionCallItem(callId, "read_file", args.join(""));
  const done = responseObject(responsesUsage(200, 30, 0, 12), { output: [{ type: "reasoning", id: "rs_1", summary: [] }, item], model: "gpt-6-astra" });
  return [
    { type: "response.created", response: { ...done, status: "in_progress", output: [], usage: null } },
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } },
    { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } },
    { type: "response.output_item.added", output_index: 1, item: { ...item, arguments: "", status: "in_progress" } },
    ...args.map((delta) => ({ type: "response.function_call_arguments.delta", item_id: item.id, output_index: 1, delta })),
    { type: "response.function_call_arguments.done", item_id: item.id, output_index: 1, arguments: args.join("") },
    { type: "response.output_item.done", output_index: 1, item },
    { type: "response.completed", response: done },
  ];
};

describe("GPT-6 through OpenAI's Responses API", () => {
  it("answers a text turn as a chat completion", async () => {
    const { service, token } = await member();
    service.setOpenAI(() => openaiResponse(responsesUsage(50, 5), { output: [{ type: "reasoning", id: "rs_1", summary: [] }, messageItem("Hello there")], model: "gpt-6-astra" }));
    const response = await chat(service, token, { messages: [{ role: "system", content: "Be brief." }, { role: "user", content: [{ type: "text", text: "hello" }] }] });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { object: string; model: string; choices: Array<{ message: { role: string; content: string; tool_calls?: unknown }; finish_reason: string }>; usage: Record<string, unknown> };
    assert.equal(body.object, "chat.completion");
    assert.equal(body.model, "gpt-6-astra");
    assert.deepEqual(body.choices[0]!.message, { role: "assistant", content: "Hello there" });
    assert.equal(body.choices[0]!.finish_reason, "stop");
    assert.equal(body.usage.prompt_tokens, 50);
    assert.equal(body.usage.completion_tokens, 5);

    const sent = service.calls.openai[0]!.body;
    assert.equal(sent.model, "gpt-6-astra");
    assert.equal(sent.store, false);
    assert.equal(sent.stream, false);
    assert.equal(sent.reasoning, undefined, "no reasoning setting when the client gave none");
    assert.deepEqual(sent.input, [
      { type: "message", role: "system", content: "Be brief." },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    ]);
    assert.equal(typeof sent.user, "string");
  });

  it("sends tools with reasoning on, for every GPT-6 model", async () => {
    for (const model of ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"]) {
      const { service, token } = await member();
      const response = await chat(service, token, { model, tools, tool_choice: "auto", parallel_tool_calls: false, reasoning_effort: "high", temperature: 0.2, top_p: 0.9 });
      assert.equal(response.status, 200, model);
      const sent = service.calls.openai[0]!.body;
      assert.deepEqual(sent.tools, [{ type: "function", name: "read_file", description: "Read a file", parameters: tools[0]!.function.parameters, strict: false }]);
      assert.equal(sent.tool_choice, "auto");
      assert.equal(sent.parallel_tool_calls, false);
      assert.deepEqual(sent.reasoning, { effort: "high" }, "the client's effort, never forced off");
      // GPT-6 refuses sampling settings.
      assert.equal(sent.temperature, undefined);
      assert.equal(sent.top_p, undefined);
    }
  });

  it("maps OpenRouter's reasoning.effort and a named tool_choice", async () => {
    const { service, token } = await member();
    await chat(service, token, { tools, reasoning: { effort: "low" }, tool_choice: { type: "function", function: { name: "read_file" } } });
    const sent = service.calls.openai[0]!.body;
    assert.deepEqual(sent.reasoning, { effort: "low" });
    assert.deepEqual(sent.tool_choice, { type: "function", name: "read_file" });
  });

  it("answers a tool call turn with tool_calls and finish_reason tool_calls", async () => {
    const { service, token } = await member();
    service.setOpenAI(() =>
      openaiResponse(responsesUsage(200, 30, 0, 12), { output: [{ type: "reasoning", id: "rs_1", summary: [] }, functionCallItem("call_abc", "read_file", '{"path":"README.md"}')], model: "gpt-6-astra" }),
    );
    const response = await chat(service, token, { tools, reasoning_effort: "low" });
    const body = (await response.json()) as { choices: Array<{ message: { content: unknown; tool_calls: unknown }; finish_reason: string }> };
    assert.equal(body.choices[0]!.message.content, null);
    assert.deepEqual(body.choices[0]!.message.tool_calls, [{ id: "call_abc", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' } }]);
    assert.equal(body.choices[0]!.finish_reason, "tool_calls");
  });

  it("streams a tool call turn as chat chunks: id and name, argument deltas, finish, usage, [DONE]", async () => {
    const { service, token } = await member();
    service.setOpenAI(() => responsesSse(toolCallEvents("call_abc", ['{"pa', 'th":"README', '.md"}']), { split: true }));
    const response = await chat(service, token, { tools, reasoning_effort: "low", stream: true, stream_options: { include_usage: true } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const data = await chunks(response);
    assert.equal(data.at(-1), "[DONE]");
    const parsed = data.slice(0, -1) as Array<{ object: string; choices: Array<{ delta: Record<string, unknown>; finish_reason: string | null }>; usage?: Record<string, unknown> }>;
    assert.ok(parsed.every((chunk) => chunk.object === "chat.completion.chunk"));
    const deltas = parsed.flatMap((chunk) => chunk.choices.map((choice) => choice.delta));
    assert.deepEqual(deltas[0], { role: "assistant", content: "" });
    const calls = deltas.flatMap((delta) => (delta.tool_calls as Array<Record<string, unknown>> | undefined) ?? []);
    assert.deepEqual(calls[0], { index: 0, id: "call_abc", type: "function", function: { name: "read_file", arguments: "" } });
    assert.equal(calls.map((call) => (call.function as { arguments: string }).arguments).join(""), '{"path":"README.md"}');
    assert.ok(calls.slice(1).every((call) => call.index === 0 && call.id === undefined));
    const finish = parsed.flatMap((chunk) => chunk.choices.map((choice) => choice.finish_reason)).filter(Boolean);
    assert.deepEqual(finish, ["tool_calls"]);
    const last = parsed.at(-1)!;
    assert.deepEqual(last.choices, []);
    assert.equal(last.usage!.prompt_tokens, 200);
    assert.equal(last.usage!.completion_tokens, 30);
    assert.deepEqual(last.usage!.completion_tokens_details, { reasoning_tokens: 12 });
    assert.equal(service.calls.openai[0]!.body.stream, true);
    // The stream's usage settled the reservation: 230 tokens from Astra's pool.
    assert.equal((await pools(service, token)).astra!.usedThisWeek, 230);
  });

  it("streams text deltas", async () => {
    const { service, token } = await member();
    service.setOpenAI(() => responsesSse(responsesTextEvents("Hi!", responsesUsage(10, 3))));
    const data = (await chunks(await chat(service, token, { stream: true }))) as Array<{ choices?: Array<{ delta: { content?: string }; finish_reason: string | null }> }>;
    const text = data.flatMap((chunk) => (typeof chunk === "string" ? [] : chunk.choices!.map((choice) => choice.delta.content ?? ""))).join("");
    assert.equal(text, "Hi!");
    assert.ok(data.some((chunk) => typeof chunk !== "string" && chunk.choices!.some((choice) => choice.finish_reason === "stop")));
  });

  it("sends a tool result follow-up as function_call and function_call_output items", async () => {
    const { service, token } = await member();
    await chat(service, token, {
      tools,
      messages: [
        { role: "developer", content: "Use tools." },
        { role: "user", content: "Read README.md" },
        { role: "assistant", content: "Reading it.", tool_calls: [{ id: "call_abc", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' } }] },
        { role: "tool", tool_call_id: "call_abc", content: "# Hello" },
        { role: "user", content: [{ type: "text", text: "And this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "low" } }] },
      ],
    });
    assert.deepEqual(service.calls.openai[0]!.body.input, [
      { type: "message", role: "developer", content: "Use tools." },
      { type: "message", role: "user", content: "Read README.md" },
      { type: "message", role: "assistant", content: "Reading it." },
      { type: "function_call", call_id: "call_abc", name: "read_file", arguments: '{"path":"README.md"}' },
      { type: "function_call_output", call_id: "call_abc", output: "# Hello" },
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "And this?" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "low" },
        ],
      },
    ]);
  });

  it("reports cached and reasoning tokens and charges them as before", async () => {
    const { service, token, adminToken } = await member();
    // 1M input of which 500k cached, 1M output of which 400k reasoning.
    service.setOpenAI(() => openaiResponse(responsesUsage(1_000_000, 1_000_000, 500_000, 400_000)));
    const response = await chat(service, token, { model: "gpt-6-luna" });
    const body = (await response.json()) as { usage: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details: { cached_tokens: number }; completion_tokens_details: { reasoning_tokens: number } } };
    assert.equal(body.usage.prompt_tokens, 1_000_000);
    assert.equal(body.usage.completion_tokens, 1_000_000, "reasoning tokens are part of the output");
    assert.equal(body.usage.prompt_tokens_details.cached_tokens, 500_000);
    assert.equal(body.usage.completion_tokens_details.reasoning_tokens, 400_000);
    // Allowance: 500k uncached + 1M output + 500k cached at the 0.02 weight.
    assert.equal((await pools(service, token)).luna!.usedThisWeek, 1_510_000);
    // Credit at Luna's list prices: $0.05 uncached + $0.005 cached + $0.50 output.
    assert.equal(await openaiCreditUsed(service, adminToken), 0.555);
  });

  it("maps an incomplete response (output cap) to finish_reason length, streamed or not", async () => {
    const { service, token } = await member();
    service.setOpenAI(() => openaiResponse(responsesUsage(10, 256), { status: "incomplete", incompleteReason: "max_output_tokens", output: [messageItem("partial")] }));
    const body = (await (await chat(service, token, {})).json()) as { choices: Array<{ finish_reason: string; message: { content: string } }> };
    assert.equal(body.choices[0]!.finish_reason, "length");
    assert.equal(body.choices[0]!.message.content, "partial");

    service.setOpenAI(() => responsesSse(responsesTextEvents("part", responsesUsage(10, 256), { status: "incomplete", incompleteReason: "max_output_tokens" })));
    const data = (await chunks(await chat(service, token, { stream: true }))) as Array<{ choices?: Array<{ finish_reason: string | null }> }>;
    assert.equal(data.at(-1), "[DONE]");
    assert.ok(data.some((chunk) => typeof chunk !== "string" && chunk.choices!.some((choice) => choice.finish_reason === "length")));
  });

  it("sends the reservation's output cap as max_output_tokens", async () => {
    const { service, token } = await member();
    await chat(service, token, { max_tokens: 1000 });
    assert.equal(service.calls.openai[0]!.body.max_output_tokens, 1000);
    assert.equal(service.calls.openai[0]!.body.max_tokens, undefined);
  });

  it("passes a request error through with the same mapping as before, charging nothing", async () => {
    const { service, token } = await member();
    service.setOpenAI(() => Response.json({ error: { message: "Invalid value for 'reasoning.effort'", type: "invalid_request_error" } }, { status: 400 }));
    const response = await chat(service, token, { reasoning_effort: "bogus" });
    assert.equal(response.status, 400);
    assert.equal(await errorCode(response), "upstream_error");
    assert.equal((await pools(service, token)).astra!.usedThisWeek, 0);
  });

  it("falls back to DeepSeek on a provider error, with the client's chat request", async () => {
    const { service, token } = await member(BOTH);
    service.setOpenAI(() => new Response("down", { status: 500 }));
    service.setLuminal(() => completion(luminalUsage(100, 10)));
    const response = await chat(service, token, { tools, reasoning_effort: "high" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-dl-fallback"), "deepseek/deepseek-v4.1-flash-1017");
    // DeepSeek still gets Chat Completions, untouched by the Responses translation.
    const sent = service.calls.luminal[0]!.body;
    assert.deepEqual(sent.messages, [{ role: "user", content: "hello" }]);
    assert.deepEqual(sent.tools, tools);
    assert.equal(sent.reasoning_effort, "high");
    assert.equal(sent.input, undefined);
  });

  it("falls back to DeepSeek when no response comes before the first-byte timeout", async () => {
    const { service, token } = await member({ ...BOTH, OPENAI_FIRST_BYTE_TIMEOUT_SECONDS: "0.05" });
    service.setOpenAI((_body, init) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    const response = await chat(service, token, { tools, stream: true });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-dl-fallback"), "deepseek/deepseek-v4.1-flash-1017");
    assert.equal(service.calls.luminal.length, 1);
  });

  it("passes a stream that fails part way through as an error, without [DONE]", async () => {
    const { service, token } = await member();
    service.setOpenAI(() =>
      responsesSse([
        { type: "response.created", response: responseObject(undefined, { status: "in_progress", output: [] }) },
        { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hel" },
        { type: "response.failed", response: { ...responseObject(undefined, { status: "failed", output: [] }), error: { code: "server_error", message: "Something broke" } } },
      ]),
    );
    const data = await chunks(await chat(service, token, { stream: true }));
    assert.notEqual(data.at(-1), "[DONE]");
    assert.deepEqual((data.at(-1) as { error: unknown }).error, { message: "Something broke", code: "server_error" });
  });
});
