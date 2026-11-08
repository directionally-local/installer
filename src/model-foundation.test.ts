import assert from "node:assert/strict";
import { test } from "node:test";
import { MODEL_CATALOG, fittingModels, recipe } from "./model-catalog.js";
import { checkGpuDocker, detectHardware, dockerArgs } from "./model-runtime.js";
import { smokeTest } from "./model-smoke.js";
import { readModelState, writeModelState, type ModelState } from "./state.js";
import { FakeModelSystem } from "./test-support/fake-model-system.js";

const sample: ModelState = { version: 1, active: { id: "qwen-old", repo: "Qwen/Qwen3-4B", container: "dl-model-1", port: 8000, context: 8192,
  image: "vllm/vllm-openai:v0.20.0", flags: ["--tool-call-parser", "hermes"], minVramMiB: 12288,
  lastTest: { chat: true, tools: true, json: true, tokensPerSecond: 19, at: "today" } } };

test("catalog only offers models that fit a single GPU, and rejects unknown models", () => {
  assert.equal(fittingModels(8192).length, 0);
  assert.deepEqual(fittingModels(12288).map((model) => model.id), ["qwen-old"]);
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
  const respond = async (_url: string, init?: RequestInit) => {
    const input = JSON.parse(String(init?.body)); calls.push(input);
    const message = input.tools ? { tool_calls: [{ function: { name: "ping", arguments: '{"value":1}' } }] } :
      input.response_format ? { content: '{"ok":true}' } : { content: "Hello" };
    return new Response(JSON.stringify({ choices: [{ message }], usage: { completion_tokens: 10 } }), { status: 200 });
  };
  const result = await smokeTest(sample.active, fake, respond, { attempts: 1 });
  assert.deepEqual([result.chat, result.tools, result.json], [true, true, true]);
  assert.ok(result.tokensPerSecond > 0);
  assert.equal(calls.length, 3);
  await assert.rejects(smokeTest(sample.active, fake, async () => new Response("bad", { status: 500 }), { attempts: 1 }), /vLLM logs.*model loading/s);
});
