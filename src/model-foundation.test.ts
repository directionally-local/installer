import assert from "node:assert/strict";
import { afterEach, describe, it, test } from "node:test";
import { MODEL_CATALOG, fittingModels, recipe } from "./model-catalog.js";
import { checkGpuDocker, detectHardware, dockerArgs } from "./model-runtime.js";
import { answerText, SmokeError, smokeTest } from "./model-smoke.js";
import { fakeVllm, type FakeVllm } from "./test-support/fake-vllm.js";
import { readModelState, writeModelState, type ModelState } from "./state.js";
import { FakeModelSystem } from "./test-support/fake-model-system.js";

const sample: ModelState = { version: 1, active: { id: "qwen-old", repo: "Qwen/Qwen3-4B", container: "dl-model-1", port: 8000, context: 8192,
  image: "vllm/vllm-openai:v0.20.0", flags: ["--tool-call-parser", "hermes"], minVramMiB: 12288,
  lastTest: { chat: true, tools: true, json: true, tokensPerSecond: 19, at: "today" } } };

test("catalog only offers models that fit a single GPU, and rejects unknown models", () => {
  assert.equal(fittingModels(8192).length, 0);
  assert.deepEqual(fittingModels(12288).map((model) => model.id), ["qwen-old"]);
  assert.deepEqual(fittingModels(16384).map((model) => model.id), ["qwen-new", "qwen-old"], "qwen-new (no thinking phase) comes first");
  assert.equal(fittingModels(49152).length, 3);
  assert.throws(() => recipe("unknown"), /Unknown model/);
  assert.ok(MODEL_CATALOG.every((model) => model.image.startsWith("vllm/vllm-openai:") && model.flags.includes("--max-model-len")));
});

test("Nvidia, Docker and toolkit detection give actionable failures", async () => {
  const fake = new FakeModelSystem();
  const hardware = await detectHardware(fake);
  assert.equal(hardware.gpus[0]?.name, "NVIDIA RTX 6000");
  assert.equal(hardware.cuda, "12.8");
  await checkGpuDocker(fake);
  fake.gpu = "";
  await assert.rejects(detectHardware(fake), /No Nvidia GPU/);
  fake.gpu = "0, GPU, 49152, 30000, 570\n";
  fake.docker = false;
  await assert.rejects(checkGpuDocker(fake), /Docker/);
  fake.docker = true;
  fake.toolkit = false;
  await assert.rejects(checkGpuDocker(fake), /nvidia-container-toolkit/);
  fake.toolkit = true;
  fake.runtimes = "{}";
  await assert.rejects(checkGpuDocker(fake), /nvidia runtime/);
});

test("Docker recipe pins image, loopback port, cache, tools and context", () => {
  const args = dockerArgs(recipe("qwen-old"), 8000, 4096, 1).join(" ");
  assert.match(args, /--name dl-model-1/);
  assert.match(args, /127\.0\.0\.1:8000:8000/);
  assert.match(args, /dl-model-hf-cache/);
  assert.match(args, /--tool-call-parser hermes/);
  assert.match(args, /--max-model-len 4096/);
  assert.match(args, /--gpu-memory-utilization 0\.4/);
  assert.throws(() => dockerArgs(recipe("qwen-old"), 8000, 100000, 1), /Context length/);
});

test("model state is separate, private and fails closed on corruption", async () => {
  const fake = new FakeModelSystem();
  await writeModelState(fake, sample, "/tmp/model.json");
  assert.deepEqual(await readModelState(fake, "/tmp/model.json"), sample);
  assert.equal(fake.files.get("/tmp/model.json")?.mode, 0o600);
  await fake.writeFile("/tmp/model.json", "{broken");
  await assert.rejects(readModelState(fake, "/tmp/model.json"), /Invalid model state/);
});

test("smoke test checks chat, tool arguments, JSON mode and measures throughput", async () => {
  const fake = new FakeModelSystem();
  const calls: unknown[] = [];
  const respond = async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/models")) return new Response(JSON.stringify({ data: [{ id: "Qwen/Qwen3-4B" }] }), { status: 200 });
    const input = JSON.parse(String(init?.body)); calls.push(input);
    if (input.stream) {
      const sse = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: " world" } }] })}`,
        `data: ${JSON.stringify({ choices: [], usage: { completion_tokens: 10 } })}`,
        "data: [DONE]",
      ].join("\n\n");
      return new Response(`${sse}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    const message = input.tools ? { tool_calls: [{ function: { name: "ping", arguments: '{"value":1}' } }] } :
      input.response_format ? { content: '{"ok":true}' } : { content: "Hello" };
    return new Response(JSON.stringify({ choices: [{ message }], usage: { completion_tokens: 10 } }), { status: 200 });
  };
  const result = await smokeTest(sample.active, fake, respond, { attempts: 1 });
  assert.deepEqual([result.chat, result.tools, result.json], [true, true, true]);
  assert.ok(result.tokensPerSecond > 0);
  assert.equal(calls.length, 4, "chat, speed, tools, JSON");
  const failed = await smokeTest(sample.active, fake, async () => new Response("bad", { status: 500 }), { attempts: 1, delay: async () => {} }).catch((error: unknown) => error);
  assert.ok(failed instanceof SmokeError);
  assert.equal(failed.message, "Startup: vLLM wasn't ready after 1 minute without progress");
  assert.doesNotMatch(failed.message, /model loading/, "server logs never go in the message");
});

describe("smoke test against a fake vLLM serving a thinking model", () => {
  let server: FakeVllm | undefined;
  afterEach(async () => { await server?.close(); server = undefined; });
  const at = (port: number) => ({ repo: "Qwen/Qwen3-4B", container: "dl-model-1", port });

  it("turns thinking off on every check, so Qwen3-4B passes", async () => {
    server = await fakeVllm({ thinking: "reasoning_content" });
    const steps: string[] = [];
    const result = await smokeTest(at(server.port), new FakeModelSystem(), fetch, { attempts: 1, onCheck: (check, status) => steps.push(`${status} ${check}`) });
    assert.equal(result.chat, true);
    const posts = server.requests.filter((request) => request.body);
    assert.equal(posts.length, 4);
    for (const post of posts) assert.deepEqual(post.body!.chat_template_kwargs, { enable_thinking: false });
    assert.deepEqual(steps, ["start ready", "done ready", "start chat", "done chat", "start speed", "done speed", "start tools", "done tools", "start json", "done json"]);
  });

  it("a reply that is all reasoning_content, cut off by the token limit, names the test and the reason", async () => {
    server = await fakeVllm({ thinking: "reasoning_content", alwaysThinks: true });
    const error = await smokeTest(at(server.port), new FakeModelSystem(), fetch, { attempts: 1 }).catch((caught: unknown) => caught);
    assert.ok(error instanceof SmokeError);
    assert.equal(error.message, "Chat test: the model returned no text, thinking mode used all tokens");
    assert.equal(error.check, "chat");
    assert.equal(error.short, "only thinking, out of tokens");
  });

  it("an inline <think> block isn't text; only thinking that stopped on its own says so", async () => {
    server = await fakeVllm({ thinking: "inline", alwaysThinks: true, thinkingFinish: "stop" });
    const error = await smokeTest(at(server.port), new FakeModelSystem(), fetch, { attempts: 1 }).catch((caught: unknown) => caught);
    assert.ok(error instanceof SmokeError);
    assert.equal(error.message, "Chat test: the model returned only thinking, no answer");
  });

  it("text after a closed <think> block counts as the answer", () => {
    assert.equal(answerText("<think>hmm</think>\n\nReady."), "Ready.");
    assert.equal(answerText("<think>still thinking"), "");
    assert.equal(answerText("Ready."), "Ready.");
  });

  it("waits while vLLM loads, and fails at once when it stops", async () => {
    server = await fakeVllm({ thinking: "none", notReadyFor: 3 });
    let polls = 0;
    await smokeTest(at(server.port), new FakeModelSystem(), fetch, { attempts: 2, delay: async () => {}, waiting: async () => (polls++, true) });
    assert.equal(polls, 4, "the download moving on doesn't use up the attempts");
    await server.close();
    server = await fakeVllm({ notReadyFor: 100 });
    const stopped = await smokeTest(at(server.port), new FakeModelSystem(), fetch, { attempts: 5, delay: async () => {}, running: async () => false }).catch((caught: unknown) => caught);
    assert.ok(stopped instanceof SmokeError);
    assert.equal(stopped.message, "Startup: vLLM stopped while loading the model");
  });
});
