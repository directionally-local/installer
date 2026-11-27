import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { ADMIN_ID, createService, exchangeBlock, liquidCompletion, liquidStream, luminalUsage, MODEL, openRelayCompletion, openRelayStream, openRelayUsage, sse, usage, type Service } from "./harness.js";
import { clientReply, scrubUpstream } from "../src/client-reply.js";

/**
 * What an upstream says it cost never reaches a client (client-reply.ts): OpenRouter's
 * `usage.cost`, Open Relay's `openrelay` block and cost header, Liquid's `exchange` block, any
 * `cost` block, streamed or not, on /v1/chat/completions and /anthropic. The service still records
 * the cost; the client keeps `model` and the standard `usage` token counts.
 */

const KIMI = "moonshotai/kimi-k3.1-pro";
const GLM_FLASH = "z-ai/glm-5.3-flash";
const OPENRELAY_ON = { OPENRELAY_API_KEY: "or_test_secret", OPENRELAY_STATUS: "on" };
const LIQUID_ON = { LIQUID_INFERENCE_API_KEY: "sk-liquid-test", LIQUID_STATUS: "on", LIQUID_PLANS: "all" };

/** Field names that would give an upstream's price away (the `model` it reports stays, by decision). */
const LEAKS = /cost|nano_usd|"usd"|"openrelay"|"exchange"|charge|supplier|"provider"|priced_at|estimated_usd/i;

/** A cost block in the shape a client was seeing, with more than one upstream's prices. */
const COST_BLOCK = { openrelay: { usd: 0.000023, input: 0.035, cached: 0.01 }, luminal: { usd: 0.00002 } };

let ips = 0;
const ip = () => `10.11.${Math.floor(++ips / 250) % 250}.${ips % 250}`;

async function member(vars: Record<string, string> = {}): Promise<{ service: Service; token: string }> {
  const service = await createService({ OPEN_ADMISSION: "true", ...vars });
  await service.signIn({ id: ADMIN_ID, login: "owner" });
  const token = (await service.signIn({ id: 100, login: "alice" })).access_token;
  return { service, token };
}

const chat = (service: Service, token: string, model: string, body: Record<string, unknown> = {}) =>
  service.request("POST", "/v1/chat/completions", { token, ip: ip(), body: { model, messages: [{ role: "user", content: "hello" }], ...body } });

function db(service: Service): DatabaseSync {
  service.directory();
  return (service.namespaces.DIRECTORY!.instances.get("directory")!.state as unknown as { db: DatabaseSync }).db;
}

/** The answer's text, asserted free of upstream prices in body and headers. */
async function clean(response: Response): Promise<string> {
  assert.equal(response.status, 200);
  for (const [name] of response.headers) assert.doesNotMatch(name, /cost|price|credit|openrelay|exchange/i, name);
  const text = await response.text();
  assert.doesNotMatch(text, LEAKS);
  return text;
}

/** The `usage` object of a JSON answer, or of the stream's last chunk that has one. */
function usageOf(text: string): Record<string, unknown> {
  if (!text.startsWith("data:")) return (JSON.parse(text) as { usage: Record<string, unknown> }).usage;
  const chunks = text.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)) as { usage?: Record<string, unknown> });
  return chunks.filter((chunk) => chunk.usage).at(-1)!.usage!;
}

describe("scrubUpstream", () => {
  it("drops cost blocks, upstream blocks and money fields in usage; keeps model and token counts", () => {
    const body = {
      id: "gen-1",
      model: MODEL,
      provider: "SomeHost",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.001, is_byok: false, cost_details: { upstream_inference_cost: 0.001 }, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 3 } },
      cost: COST_BLOCK,
      openrelay: { cost_nano_usd: 23_355, priced_at: "online" },
      exchange: exchangeBlock(0.0002),
    };
    assert.equal(scrubUpstream(body), true);
    assert.deepEqual(body, {
      id: "gen-1",
      model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: "hi" } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 3 } },
    });
  });

  it("drops an upstream error's metadata but leaves dl's own refusal fields", () => {
    const upstream = { error: { message: "boom", code: 502, metadata: { provider_name: "SomeHost", raw: "x" } } };
    assert.equal(scrubUpstream(upstream), true);
    assert.deepEqual(upstream, { error: { message: "boom", code: 502 } });
    const ours = { error: { code: "plan_limit", message: "Used up.", resetsAt: "2026-12-07T00:00:00.000Z", upstream: "openrelay", provider: "openrelay", pro: { priceUsd: 20 } } };
    const copy = structuredClone(ours);
    assert.equal(scrubUpstream(ours), false);
    assert.deepEqual(ours, copy);
  });

  it("keeps only OpenAI's top-level fields on a completion or chunk", () => {
    const extras = {
      metrics: { time_to_first_token_ms: 412, speculative_decoding: { accepted: 30, drafted: 40 } },
      prompt_text: "<|user|>hello",
      service_tier: "default",
      native_finish_reason: "stop",
    };
    const body = { id: "c1", object: "chat.completion", created: 1, model: MODEL, system_fingerprint: "fp", ...extras, choices: [{ index: 0, message: { role: "assistant", content: "hi", reasoning_content: "r" } }], usage: usage(5, 2, 0, 0) };
    assert.equal(scrubUpstream(body), true);
    assert.deepEqual(Object.keys(body), ["id", "object", "created", "model", "system_fingerprint", "choices", "usage"]);
    assert.equal(body.choices[0]!.message.reasoning_content, "r");
    const chunk = { id: "c1", object: "chat.completion.chunk", ...extras, choices: [{ index: 0, delta: { content: "hi" } }] };
    assert.equal(scrubUpstream(chunk), true);
    assert.deepEqual(Object.keys(chunk), ["id", "object", "choices"]);
    // An error chunk keeps its error.
    const failed = { id: "c1", choices: [], error: { message: "boom" }, metrics: {} };
    scrubUpstream(failed);
    assert.deepEqual(failed, { id: "c1", choices: [], error: { message: "boom" } });
  });

  it("passes a clean answer byte for byte", async () => {
    const text = `{"id":"x",  "model":"m","usage":{"prompt_tokens":1}}`;
    assert.equal(await (await clientReply(new Response(text, { headers: { "content-type": "application/json" } }))).text(), text);
    const stream = `data: {"choices":[]}\n\ndata: [DONE]\n\n`;
    assert.equal(await (await clientReply(new Response(stream, { headers: { "content-type": "text/event-stream" } }))).text(), stream);
  });

  it("scrubs a stream whose lines straddle chunk boundaries, and drops cost headers", async () => {
    const response = clientReply(sse([JSON.stringify({ choices: [{ index: 0, delta: { content: "héllo" } }] }), JSON.stringify({ choices: [], usage: usage(5, 2), cost: COST_BLOCK })], { split: true }));
    const reply = await response;
    assert.match(await clean(reply), /héllo/);
    const headers = (await clientReply(new Response("{}", { headers: { "content-type": "application/json", "OpenRelay-Cost-Nano-USD": "5", "x-dl-tokens-remaining": "9" } }))).headers;
    assert.equal(headers.get("openrelay-cost-nano-usd"), null);
    assert.equal(headers.get("x-dl-tokens-remaining"), "9");
  });
});

describe("no upstream cost reaches a client", () => {
  it("OpenRouter: usage.cost, a cost block and the host leave the answer, streamed or not; usage counts stay", async () => {
    const { service, token } = await member();
    service.setOpenRouter((body) => {
      const extra = { provider: "SomeHost", cost: COST_BLOCK };
      if (body.stream) return sse([JSON.stringify({ model: MODEL, ...extra, choices: [{ index: 0, delta: { content: "hi" } }] }), JSON.stringify({ model: MODEL, ...extra, choices: [], usage: { ...usage(100, 10, 40), cost_details: { upstream_inference_cost: 0.001 } } })]);
      return Response.json({ id: "gen-1", object: "chat.completion", model: MODEL, ...extra, choices: [{ index: 0, message: { role: "assistant", content: "hi" } }], usage: usage(100, 10, 40) });
    });
    for (const stream of [false, true]) {
      const text = await clean(await chat(service, token, MODEL, { stream }));
      assert.match(text, new RegExp(`"model":"${MODEL.replace(/[./]/g, "\\$&")}"`));
      assert.deepEqual(usageOf(text), { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 40 } });
    }
    // Still charged what OpenRouter said it cost.
    const costs = (db(service).prepare("SELECT cost_usd FROM requests ORDER BY id").all() as Array<{ cost_usd: number }>).map((row) => row.cost_usd);
    assert.equal(costs.length, 2);
    for (const cost of costs) assert.ok(cost > 0);
  });

  it("Open Relay: its cost block and header leave the answer, streamed or not; the credit is still charged", async () => {
    const { service, token } = await member(OPENRELAY_ON);
    service.setOpenRelay((body) => {
      if (body.stream) return openRelayStream(openRelayUsage(100, 10));
      const answer = openRelayCompletion(openRelayUsage(100, 10));
      return answer.json().then((json) => Response.json({ ...(json as object), cost: COST_BLOCK }, { headers: answer.headers }));
    });
    for (const stream of [false, true]) {
      const text = await clean(await chat(service, token, GLM_FLASH, { stream }));
      assert.equal(usageOf(text).prompt_tokens, 100);
    }
    const credits = (db(service).prepare("SELECT credit_usd FROM requests ORDER BY id").all() as Array<{ credit_usd: number }>).map((row) => row.credit_usd);
    assert.deepEqual(credits, [0.000023355, 0.000023355]);
  });

  it("Liquid: the exchange block leaves the answer, streamed or not", async () => {
    const { service, token } = await member(LIQUID_ON);
    service.setLiquid((body) => (body.stream ? liquidStream(luminalUsage(100, 10), 0.0002) : liquidCompletion(luminalUsage(100, 10), 0.0002)));
    for (const stream of [false, true]) {
      const text = await clean(await chat(service, token, KIMI, { stream }));
      assert.equal(usageOf(text).completion_tokens, 10);
    }
  });

  it("Luminal through /anthropic: no cost in the Claude Code answer, streamed or not", async () => {
    const { service, token } = await member({ LUMINAL_API_KEY: "lum-test" });
    service.setLuminal((body) => {
      if (body.stream) return sse([JSON.stringify({ choices: [{ index: 0, delta: { content: "hi" } }] }), JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { ...luminalUsage(100, 10), cost: 0.001 }, cost: COST_BLOCK })]);
      return Response.json({ id: "l1", object: "chat.completion", model: MODEL, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi" } }], usage: { ...luminalUsage(100, 10), cost: 0.001 }, cost: COST_BLOCK });
    });
    const minted = await service.request("POST", "/v1/harness-keys", { token, body: { harness: "claude-code" } });
    const { key } = (await minted.json()) as { key: string };
    for (const stream of [false, true]) {
      const text = await clean(await service.request("POST", "/anthropic/v1/messages?beta=true", { token: key, ip: ip(), headers: { "anthropic-version": "2023-06-01" }, body: { model: "claude-sonnet-4-5", max_tokens: 256, stream, messages: [{ role: "user", content: "hello" }] } }));
      assert.match(text, /input_tokens/);
    }
    // The same upstream answer on /v1/chat/completions.
    for (const stream of [false, true]) await clean(await chat(service, token, MODEL, { stream }));
  });

  it("DeepSeek's metrics, prompt_text and service_tier reach no client, on any route, streamed or not", async () => {
    const { service, token } = await member({ LUMINAL_API_KEY: "lum-test" });
    const extras = { metrics: { time_to_first_token_ms: 412, speculative_decoding: { accepted: 30, drafted: 40 } }, prompt_text: "<|user|>hello", service_tier: "default" };
    const upstream = (body: Record<string, unknown>) =>
      body.stream
        ? sse([JSON.stringify({ id: "d1", object: "chat.completion.chunk", model: MODEL, ...extras, choices: [{ index: 0, delta: { content: "hi" } }] }), JSON.stringify({ id: "d1", object: "chat.completion.chunk", model: MODEL, ...extras, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: usage(100, 10, 0, 0) })])
        : Response.json({ id: "d1", object: "chat.completion", created: 1, model: MODEL, ...extras, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi" } }], usage: usage(100, 10, 0, 0) });
    service.setOpenRouter(upstream);
    service.setLuminal(upstream);
    const NONSTANDARD = /metrics|time_to_first_token|speculative|prompt_text|service_tier/;
    for (const stream of [false, true]) {
      const text = await clean(await chat(service, token, MODEL, { stream }));
      assert.doesNotMatch(text, NONSTANDARD);
      assert.deepEqual(usageOf(text), { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 0 } });
      if (!stream) assert.deepEqual(Object.keys(JSON.parse(text) as object), ["id", "object", "created", "model", "choices", "usage"]);
    }
    const claude = (await (await service.request("POST", "/v1/harness-keys", { token, body: { harness: "claude-code" } })).json()) as { key: string };
    for (const stream of [false, true]) {
      const text = await clean(await service.request("POST", "/anthropic/v1/messages?beta=true", { token: claude.key, ip: ip(), headers: { "anthropic-version": "2023-06-01" }, body: { model: "claude-sonnet-4-5", max_tokens: 256, stream, messages: [{ role: "user", content: "hello" }] } }));
      assert.doesNotMatch(text, NONSTANDARD);
      assert.match(text, /"output_tokens":10/);
      if (!stream) assert.deepEqual(Object.keys(JSON.parse(text) as object), ["id", "type", "role", "model", "content", "stop_reason", "stop_sequence", "usage"]);
    }
    const codex = (await (await service.request("POST", "/v1/harness-keys", { token, body: { harness: "codex" } })).json()) as { key: string };
    for (const stream of [false, true]) {
      const text = await clean(await service.request("POST", "/v1/responses", { token: codex.key, ip: ip(), headers: { originator: "codex_cli_rs" }, body: { model: MODEL, input: "hello", stream } }));
      assert.doesNotMatch(text, NONSTANDARD);
      assert.match(text, /"output_tokens":10/);
    }
  });

  it("an upstream error inside a stream loses its host metadata", async () => {
    const { service, token } = await member();
    service.setOpenRouter(() => sse([JSON.stringify({ provider: "SomeHost", choices: [{ index: 0, delta: { content: "hi" } }] }), JSON.stringify({ error: { message: "Upstream failed", code: 502, metadata: { provider_name: "SomeHost", raw: "cost exceeded" } } })]));
    const text = await (await chat(service, token, MODEL, { stream: true })).text();
    assert.match(text, /Upstream failed/);
    assert.doesNotMatch(text, /SomeHost|metadata|cost/);
  });
});
