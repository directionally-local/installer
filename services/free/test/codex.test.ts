import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ADMIN_ID, completion, createService, luminalUsage, MODEL, sse, type Service } from "./harness.js";
import { REASONING_PREFIX } from "../src/responses.js";

/**
 * Codex CLI through `dl codex` (or with a dl key by hand): POST /v1/responses, translated onto the
 * chat completions path (responses.ts), so it gets the same auth, plan limits, model routing,
 * history repair, metering and refusals as every other agent. The requests are the ones Codex
 * 0.172.0 sent (test/fixtures).
 */

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as { headers: Record<string, string>; body: Record<string, any> };
const FIRST = fixture("codex-0.172.0-first-request.json");
const TOOL_RESULT = fixture("codex-0.172.0-tool-result-request.json");
/** The headers Codex sends that matter here (its session id among them), not its auth. */
const CODEX_HEADERS = Object.fromEntries(Object.entries(FIRST.headers).filter(([name]) => name !== "authorization"));
const SESSION = FIRST.headers["session-id"]!;

async function world(vars: Record<string, string> = {}) {
  const service = await createService({ OPEN_ADMISSION: "true", LUMINAL_API_KEY: "lum-test", ...vars });
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const tokens = await service.signIn({ id: 100, login: "alice" });
  return { service, admin, token: tokens.access_token };
}

async function mint(service: Service, token: string): Promise<{ id: string; key: string; harness: string; otherHarnessShare: number }> {
  const response = await service.request("POST", "/v1/harness-keys", { token, body: { harness: "codex" } });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()) as never;
}

const responses = (service: Service, key: string, body: Record<string, unknown>, headers: Record<string, string> = CODEX_HEADERS) =>
  service.request("POST", "/v1/responses", { token: key, headers, body });

/** A Responses event stream's events (the `event:` name is the data's type). */
async function events(response: Response): Promise<Array<Record<string, any>>> {
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  return (await response.text())
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const data = JSON.parse(/^data: (.+)$/m.exec(block)![1]!) as Record<string, any>;
      assert.equal(data.type, /^event: (.+)$/m.exec(block)![1]);
      return data;
    });
}

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => JSON.stringify({ id: "c1", choices: [{ index: 0, delta, finish_reason: finish }] });

const requestRows = (service: Service) =>
  service.directory().ctx.storage.sql.exec("SELECT harness, model, session_key FROM requests WHERE github_id = 100 ORDER BY id").toArray().map((row: object) => ({ ...row }));

describe("Codex harness keys", () => {
  it("are minted for \"codex\" with the whole allowance by default", async () => {
    const { service, token } = await world();
    const minted = await mint(service, token);
    assert.equal(minted.harness, "codex");
    assert.match(minted.key, /^dlh_100_/);
    assert.equal(minted.otherHarnessShare, 1);
  });

  it("work on /v1/responses and /v1/models only, not on chat completions or the Anthropic endpoint", async () => {
    const { service, token } = await world();
    const { key } = await mint(service, token);
    assert.equal((await service.request("GET", "/v1/models", { token: key })).status, 200);
    assert.equal((await service.request("POST", "/v1/chat/completions", { token: key, body: { model: MODEL, messages: [{ role: "user", content: "x" }] } })).status, 401);
    assert.equal((await service.request("POST", "/anthropic/v1/messages", { token: key, body: { model: "x", max_tokens: 10, messages: [{ role: "user", content: "x" }] } })).status, 401);
  });
});

describe("POST /v1/responses", () => {
  it("serves Codex's recorded turn as a stream: its tools and prompts reach DeepSeek, the answer comes back as Responses events, usage settles", async () => {
    const { service, token } = await world();
    const { key } = await mint(service, token);
    service.setLuminal((body) => {
      assert.equal(body.stream, true);
      return sse(
        [
          chunk({ role: "assistant", reasoning_content: "Run echo." }),
          chunk({ content: "Running it." }),
          chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "exec_command", arguments: '{"cmd":' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: '"echo hi"}' } }] }),
          chunk({}, "tool_calls"),
          JSON.stringify({ id: "c1", choices: [], usage: luminalUsage(12_000, 40, 11_000) }),
        ],
        { split: true },
      );
    });
    const response = await responses(service, key, FIRST.body);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-dl-served-model"), MODEL);
    const list = await events(response);
    assert.deepEqual(list.map((event) => event.type).filter((type) => !type.endsWith(".delta")), [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.reasoning_text.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);
    const completed = list.at(-1)!.response;
    assert.equal(completed.model, MODEL);
    assert.deepEqual(completed.usage, { input_tokens: 12_000, input_tokens_details: { cached_tokens: 11_000 }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 12_040 });
    const call = completed.output.find((item: Record<string, unknown>) => item.type === "function_call");
    assert.deepEqual([call.name, call.call_id, call.arguments], ["exec_command", "call_1", '{"cmd":"echo hi"}']);

    const sent = service.calls.luminal.at(-1)!.body;
    assert.equal(sent.model, "deepseek-ai/DeepSeek-V4.1-Flash-1017");
    const messages = sent.messages as Array<Record<string, any>>;
    assert.deepEqual(messages.map((message) => message.role), ["system", "system", "user", "user"]);
    assert.ok((sent.tools as Array<Record<string, any>>).some((tool) => tool.function.name === "exec_command"));
    for (const field of ["input", "include", "store", "prompt_cache_key", "client_metadata"]) assert.ok(!(field in sent), field);
    // Settled on DeepSeek's week, recorded as Codex's under its session id.
    const me = (await (await service.request("GET", "/v1/me", { token })).json()) as { budgets: { deepseek: { tokensThisWeek: number } } };
    assert.equal(me.budgets.deepseek.tokensThisWeek, 12_040);
    assert.deepEqual(requestRows(service), [{ harness: "codex", model: MODEL, session_key: SESSION }]);
  });

  it("sends Codex's follow-up with the tool output and the reasoning it was given back", async () => {
    const { service, token } = await world();
    const { key } = await mint(service, token);
    // The reasoning item Codex replays is the one the service sealed.
    assert.ok(TOOL_RESULT.body.input.some((item: Record<string, unknown>) => item.type === "reasoning" && String(item.encrypted_content).startsWith(REASONING_PREFIX)));
    service.setLuminal(() => sse([chunk({ role: "assistant", content: "done" }), chunk({}, "stop"), JSON.stringify({ id: "c1", choices: [], usage: luminalUsage(100, 1) })]));
    const list = await events(await responses(service, key, TOOL_RESULT.body));
    assert.equal(list.at(-1)!.type, "response.completed");
    const messages = service.calls.luminal.at(-1)!.body.messages as Array<Record<string, any>>;
    assert.deepEqual(messages.slice(4).map((message) => [message.role, message.reasoning_content ?? null, message.tool_call_id ?? null]), [
      ["assistant", "thinking about it", null],
      ["tool", null, "call_1"],
    ]);
  });

  it("repairs a history an interrupted call left broken, as for any agent", async () => {
    const { service, token } = await world();
    const { key } = await mint(service, token);
    const input = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
      { type: "function_call", name: "exec_command", arguments: "{}", call_id: "call_a" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "never mind" }] },
    ];
    service.setLuminal(() => completion(luminalUsage(10, 1)));
    assert.equal((await responses(service, key, { model: MODEL, input, tools: [{ type: "function", name: "exec_command", parameters: { type: "object", properties: {} } }] })).status, 200);
    const messages = service.calls.luminal.at(-1)!.body.messages as Array<Record<string, any>>;
    assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "tool", "user"]);
  });

  it("answers a request that doesn't stream with a response object", async () => {
    const { service, token } = await world();
    const { key } = await mint(service, token);
    service.setLuminal(() => completion(luminalUsage(20, 2, 10)));
    const response = await responses(service, key, { model: MODEL, instructions: "Be brief.", input: "hello", store: false });
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, any>;
    assert.equal(body.object, "response");
    assert.equal(body.status, "completed");
    assert.equal(body.instructions, "Be brief.");
    assert.deepEqual(body.output.map((item: Record<string, unknown>) => item.type), ["message"]);
    assert.equal(body.output[0].content[0].text, "hi");
    assert.deepEqual(body.usage.input_tokens_details, { cached_tokens: 10 });
  });

  it("streams a whole answer when the upstream didn't stream", async () => {
    const { service, token } = await world();
    const { key } = await mint(service, token);
    service.setLuminal(() => completion(luminalUsage(10, 1)));
    const list = await events(await responses(service, key, { model: MODEL, input: "hi", stream: true }));
    assert.deepEqual([list[0]!.type, list.at(-1)!.type], ["response.created", "response.completed"]);
  });

  it("works with a tool key (a dl key from dl.new is one), counted under the tool Codex names itself as", async () => {
    const { service, token } = await world();
    const made = await service.request("POST", "/v1/keys", { token, body: { name: "codex", kind: "tool" } });
    assert.equal(made.status, 201);
    const { key } = (await made.json()) as { key: string };
    service.setLuminal(() => completion(luminalUsage(10, 1)));
    const response = await responses(service, key, { model: MODEL, input: "hi" }, { ...CODEX_HEADERS });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(requestRows(service).map((row: Record<string, unknown>) => row.harness), ["tool:codex"]);
  });

  it("refuses a used-up allowance inside the stream, in Codex's words, with the code Codex shows and doesn't retry", async () => {
    const { service, admin, token } = await world({ DEEPSEEK_WEEKLY_USD_CAP: "1", OTHER_HARNESS_SHARE: "0.5" });
    const { key } = await mint(service, token);
    service.setLuminal(() => completion(luminalUsage(10_000_000, 0)));
    assert.equal((await responses(service, key, { model: MODEL, input: "x" })).status, 200);
    assert.equal((await responses(service, key, { model: MODEL, input: "x" })).status, 200);
    const refused = await responses(service, key, { model: MODEL, input: "x", stream: true });
    assert.equal(refused.status, 200);
    const list = await events(refused);
    assert.deepEqual(list.map((event) => event.type), ["response.created", "response.failed"]);
    const error = list[1]!.response.error;
    assert.equal(error.code, "invalid_prompt");
    assert.equal(error.dl_code, "harness_limit");
    assert.match(error.message, /^Codex through dl gets half of your free allowance, and that part is used up\./);
    // Without a stream: the HTTP status and OpenAI's error shape.
    const plain = await responses(service, key, { model: MODEL, input: "x" });
    assert.equal(plain.status, 402);
    const body = (await plain.json()) as { error: Record<string, unknown> };
    assert.deepEqual([body.error.type, body.error.code], ["insufficient_quota", "harness_limit"]);
    // Counted under client codex.
    const metrics = (await (await service.request("GET", "/admin/metrics", { token: admin })).json()) as { refusals: Array<{ reason: string; client: string; count: number }> };
    assert.ok(metrics.refusals.some((row) => row.client === "codex" && row.count >= 2));
  });

  it("says Codex's words when the key expired, and names a model the plan doesn't serve", async () => {
    const { service, token } = await world();
    const { id, key } = await mint(service, token);
    const other = await mint(service, token);
    const unknown = await events(await responses(service, other.key, { model: "gpt-5.5", input: "x", stream: true }));
    assert.equal(unknown[1]!.response.error.dl_code, "model_not_allowed");
    assert.match(unknown[1]!.response.error.message, /deepseek\/deepseek-v4\.1-flash-1017/);
    assert.equal((await service.request("DELETE", `/v1/harness-keys/${id}`, { token: key })).status, 200);
    const expired = await responses(service, key, { model: MODEL, input: "x", stream: true });
    assert.equal(expired.status, 401);
    const body = (await expired.json()) as { error: { message: string; type: string } };
    assert.equal(body.error.message, "This dl codex session's free tier key has expired. Quit Codex and run dl codex again.");
    assert.equal(body.error.type, "authentication_error");
  });

  it("refuses previous_response_id and every other responses route: nothing is stored", async () => {
    const { service, token } = await world();
    const { key } = await mint(service, token);
    const chained = await responses(service, key, { model: MODEL, input: "x", previous_response_id: "resp_1" });
    assert.equal(chained.status, 400);
    const body = (await chained.json()) as { error: { param: string; message: string } };
    assert.equal(body.error.param, "previous_response_id");
    assert.equal(service.calls.luminal.length, 0);
    assert.equal((await service.request("GET", "/v1/responses/resp_1", { token: key })).status, 404);
    assert.equal((await service.request("POST", "/v1/responses", { body: { model: MODEL, input: "x" } })).status, 401);
  });
});
