import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { createService, luminalUsage, MODEL, openRelayUsage, sse, type Service } from "./harness.js";
import { degenerate, DegenerateWatch, guardStream } from "../src/degenerate.js";

/**
 * Degenerate upstream output (degenerate.ts): Open Relay's DeepSeek V4.1 Flash streamed
 * `<|place_holder_mm_span_0442|>` over and over, with no tool call, on 27 Nov 2026. Junk from the
 * start is dropped before the client sees a byte and the turn goes to the next upstream; junk
 * later cuts the stream with an error; neither is charged.
 */

const JUNK = "<|place_holder_mm_span_0442|>";
const KEY = "or_test_secret";
const FIRST = { OPENRELAY_API_KEY: KEY, OPENRELAY_STATUS: "on", OPENRELAY_MODELS: MODEL };

let ips = 0;
const ip = () => `10.21.${Math.floor(++ips / 250) % 250}.${ips % 250}`;

async function member(vars: Record<string, string> = {}): Promise<{ service: Service; token: string }> {
  const service = await createService({ OPEN_ADMISSION: "true", OPENAI_API_KEY: "sk-openai-test", LUMINAL_API_KEY: "lum-test", ...vars });
  const token = (await service.signIn({ id: 100, login: "alice" })).access_token;
  return { service, token };
}

const chat = (service: Service, token: string, body: Record<string, unknown> = {}) =>
  service.request("POST", "/v1/chat/completions", { token, ip: ip(), body: { model: MODEL, messages: [{ role: "user", content: "plan the fix" }], ...body } });

function rows(service: Service): Array<Record<string, any>> {
  service.directory();
  const db = (service.namespaces.DIRECTORY!.instances.get("directory")!.state as unknown as { db: DatabaseSync }).db;
  return db.prepare("SELECT upstream, status, charged_tokens, cost_usd, credit_usd FROM requests ORDER BY id").all() as Array<Record<string, any>>;
}

/** A stream of `text` pieces as reasoning, then `tail` chunks, then usage. */
function reasoningStream(pieces: string[], tail: Array<Record<string, unknown>> = []): Response {
  const chunks = [
    ...pieces.map((piece) => ({ choices: [{ index: 0, delta: { reasoning_content: piece }, finish_reason: null }] })),
    ...tail,
    { choices: [], usage: openRelayUsage(1_000, 50_000) },
  ];
  return sse(chunks.map((chunk) => JSON.stringify(chunk)), { split: true });
}

/** Captures `console.error` lines while `run` runs. */
async function captureErrors(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    await run();
  } finally {
    console.error = original;
  }
  return lines;
}

describe("degenerate output: the check", () => {
  it("knows repeated special tokens and repetition, and passes ordinary output", () => {
    assert.equal(degenerate(JUNK.repeat(8)), "special_tokens");
    assert.equal(degenerate("<｜end▁of▁sentence｜>".repeat(10)), "special_tokens");
    assert.equal(degenerate("ab".repeat(1024)), "repetition");
    assert.equal(degenerate("I'll read install.sh first, then the release workflow, and plan the change.".repeat(3)), undefined);
    // A chat template mentions its tokens: a few, among other text, aren't junk.
    const template = "{% for m in messages %}<|im_start|>{{ m.role }}\n{{ m.content }}<|im_end|>\n{% endfor %}<|im_start|>assistant\n";
    assert.equal(degenerate(template.repeat(4)), undefined);
    // A long divider in code isn't 2,048 characters of one thing.
    assert.equal(degenerate(`// ${"=".repeat(120)}\nconst x = 1;\n`.repeat(20)), undefined);
  });

  it("watches a stream as it grows and counts what it saw", () => {
    const watch = new DegenerateWatch();
    assert.equal(watch.push("Let me look at install.sh. "), undefined);
    let verdict;
    for (let index = 0; index < 20 && !verdict; index += 1) verdict = watch.push(JUNK);
    assert.equal(verdict?.reason, "special_tokens");
    assert.ok(verdict!.outputChars > 200 && verdict!.outputChars < 600);
  });

  it("guardStream replays a good head unchanged and stops a junk head before passing anything", async () => {
    const good = reasoningStream(["Reading the files. ", "Then planning."]);
    const original = await good.clone().text();
    const passed = await guardStream(good.body!, { onDegenerate: () => assert.fail("not junk") });
    assert.ok("stream" in passed);
    assert.equal(await new Response(passed.stream).text(), original);

    const junk = await guardStream(reasoningStream(Array(200).fill(JUNK)).body!, { onDegenerate: () => assert.fail("caught in the head") });
    assert.ok("degenerate" in junk);
    assert.equal(junk.degenerate.reason, "special_tokens");
  });

  it("doesn't hold a quiet stream back past the head wait, and still cuts it when it turns to junk", async () => {
    const encoder = new TextEncoder();
    const line = (delta: Record<string, unknown>) => encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
    let reads = 0;
    let release: () => void = () => undefined;
    const quiet = new Promise<void>((resolve) => (release = resolve));
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        reads += 1;
        if (reads === 1) return controller.enqueue(line({ role: "assistant", content: "" }));
        if (reads === 2) await quiet; // thinks before its first token
        if (reads < 200) return controller.enqueue(line({ reasoning_content: JUNK }));
        controller.close();
      },
    });
    let caught: string | undefined;
    const started = Date.now();
    const guarded = await guardStream(body, { headWaitMs: 50, onDegenerate: (info) => (caught = info.reason) });
    assert.ok("stream" in guarded, "answered before the head was judged");
    assert.ok(Date.now() - started < 1_000);
    release();
    const text = await new Response(guarded.stream).text();
    assert.equal(caught, "special_tokens");
    assert.ok(text.includes('"code":"degenerate_stream"'));
    assert.ok((text.match(/place_holder/g) ?? []).length < 20);
  });
});

describe("degenerate output: the service", () => {
  it("drops a junk stream from Open Relay, charges nothing for it, and Luminal answers the turn", async () => {
    const { service, token } = await member(FIRST);
    service.setOpenRelay(() => reasoningStream(Array(2_000).fill(JUNK)));
    service.setLuminal(() => sse([JSON.stringify({ choices: [{ index: 0, delta: { content: "Plan: verify the bundle." }, finish_reason: "stop" }] }), JSON.stringify({ choices: [], usage: luminalUsage(1_000, 20) })]));
    let body = "";
    const logged = await captureErrors(async () => {
      const response = await chat(service, token, { stream: true });
      assert.equal(response.status, 200);
      body = await response.text();
    });
    assert.ok(!body.includes("place_holder"), "no junk reached the client");
    assert.ok(body.includes("Plan: verify the bundle."));
    assert.equal(service.calls.luminal.length, 1);
    const [dropped, served] = rows(service);
    assert.deepEqual([dropped!.upstream, dropped!.status, dropped!.charged_tokens, dropped!.cost_usd, dropped!.credit_usd], ["openrelay", "degenerate_stream", 0, 0, 0]);
    assert.deepEqual([served!.upstream, served!.status], ["luminal", "ok"]);
    const event = logged.map((line) => { try { return JSON.parse(line); } catch { return undefined; } }).find((parsed) => parsed?.event === "free.degenerate_stream");
    assert.deepEqual({ ...event, outputChars: undefined }, { event: "free.degenerate_stream", upstream: "openrelay", model: "openrelay/deepseek-v4.1-flash", stage: "head", reason: "special_tokens", outputChars: undefined, retried: true });
  });

  it("cuts a stream that turns to junk after good output with an error, and charges nothing", async () => {
    const { service, token } = await member(FIRST);
    const good = Array.from({ length: 30 }, (_, index) => `Step ${index}: read the next file and note what it does. `);
    service.setOpenRelay(() => reasoningStream([...good, ...Array(2_000).fill(JUNK)], [{ choices: [{ index: 0, delta: { content: "never sent" }, finish_reason: "stop" }] }]));
    let body = "";
    const logged = await captureErrors(async () => {
      const response = await chat(service, token, { stream: true });
      assert.equal(response.status, 200);
      body = await response.text();
    });
    assert.ok(body.includes("Step 0:"), "the good part passed");
    assert.ok(body.includes('"code":"degenerate_stream"'));
    assert.ok(body.trimEnd().endsWith("data: [DONE]"));
    assert.ok(!body.includes("never sent"));
    // Junk passes only until it is half the window (about 60 tokens after this much good output), not 2,000.
    assert.ok((body.match(/place_holder/g) ?? []).length < 100, "only a window's worth of junk passed");
    assert.equal(service.calls.luminal.length, 0);
    assert.deepEqual(rows(service).map((row) => [row.upstream, row.status, row.charged_tokens, row.cost_usd]), [["openrelay", "degenerate_stream", 0, 0]]);
    assert.ok(logged.some((line) => line.includes('"stage":"stream"')));
  });

  it("drops a junk non-streamed answer and retries on Luminal", async () => {
    const { service, token } = await member(FIRST);
    service.setOpenRelay(() => Response.json({ id: "or_1", object: "chat.completion", choices: [{ index: 0, finish_reason: "length", message: { role: "assistant", content: "", reasoning_content: JUNK.repeat(500) } }], usage: openRelayUsage(1_000, 8_000) }));
    await captureErrors(async () => {
      const response = await chat(service, token);
      assert.equal(response.status, 200);
      assert.ok(!(await response.text()).includes("place_holder"));
    });
    assert.deepEqual(rows(service).map((row) => [row.upstream, row.status]), [["openrelay", "degenerate_stream"], ["luminal", "ok"]]);
  });

  it("with no upstream after it, a junk head goes back as a retryable error, not charged", async () => {
    const { service, token } = await member();
    service.setLuminal(() => reasoningStream(Array(200).fill(JUNK)));
    await captureErrors(async () => {
      const response = await chat(service, token, { stream: true });
      assert.equal(response.status, 503);
      const parsed = (await response.json()) as { error: { code: string; retryable: boolean } };
      assert.equal(parsed.error.code, "upstream_degenerate");
      assert.equal(parsed.error.retryable, true);
    });
    assert.deepEqual(rows(service).map((row) => [row.upstream, row.status, row.charged_tokens]), [["luminal", "degenerate_stream", 0]]);
  });

  it("passes an ordinary Open Relay stream through unchanged", async () => {
    const { service, token } = await member(FIRST);
    const pieces = Array.from({ length: 80 }, (_, index) => `thought ${index}; `);
    service.setOpenRelay(() => reasoningStream(pieces, [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "{\"path\":\"install.sh\"}" } }] }, finish_reason: "tool_calls" }] }]));
    const expected = await reasoningStream(pieces, [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "{\"path\":\"install.sh\"}" } }] }, finish_reason: "tool_calls" }] }]).text();
    const response = await chat(service, token, { stream: true });
    assert.equal(await response.text(), expected);
    assert.deepEqual(rows(service).map((row) => [row.upstream, row.status]), [["openrelay", "ok"]]);
  });
});
