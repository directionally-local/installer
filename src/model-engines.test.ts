import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { MODEL_CATALOG, type ModelRecipe } from "./model-catalog.js";
import { modelCommand, type ModelCommandOptions } from "./model-command.js";
import { engine, SGLANG, VLLM } from "./model-engines.js";
import { modelUpErrorType } from "./model-first-run.js";
import { dockerArgs } from "./model-runtime.js";
import { SmokeError, smokeTest } from "./model-smoke.js";
import type { Prompter } from "./prompt.js";
import { FakeModelSystem } from "./test-support/fake-model-system.js";
import { fakeVllm } from "./test-support/fake-vllm.js";
import { PlainUi } from "./ui.js";

/** A small SGLang entry, so the engine can be exercised without a blocked or multi-GPU model. */
const SMALL_SGLANG: ModelRecipe = { id: "qwen-sglang", repo: "Qwen/Qwen3-4B-Instruct-2507", engine: "sglang", minVramMiB: 16384, gpuMemoryUtilization: 0.4,
  image: "lmsysorg/sglang:v0.5.23", flags: ["--tool-call-parser", "qwen", "--context-length", "32768"], defaultContext: 32768 };

before(() => { (MODEL_CATALOG as ModelRecipe[]).push(SMALL_SGLANG); });
after(() => { (MODEL_CATALOG as ModelRecipe[]).splice(MODEL_CATALOG.indexOf(SMALL_SGLANG), 1); });

function fixture() {
  const system = new FakeModelSystem();
  const lines: string[] = [];
  const prompter: Prompter = { choose: async () => "", select: async (_q, choices) => ({ value: choices[0]!.value }), secret: async () => "", text: async () => "" };
  const options: ModelCommandOptions = { system, ui: new PlainUi((line) => lines.push(line)), prompter, interactive: false,
    configPath: "/tmp/autopilot/config.json", statePath: "/tmp/model.json", logDir: "/tmp/logs",
    smoke: async (deployment) => ({ chat: true, tools: true, json: true, tokensPerSecond: deployment.repo.includes("2507") ? 30 : 10, at: "now" }),
    bench: async () => ({ levels: [{ concurrency: 1, requests: 1, ttftP50: 0.1, ttftP95: 0.1, decodeTokPerSec: 50 }] }) };
  return { system, lines, options };
}

test("the catalog entry picks the engine; vLLM stays the default", () => {
  assert.equal(engine(undefined), VLLM);
  assert.equal(engine("sglang"), SGLANG);
  const args = dockerArgs(SMALL_SGLANG, 8001, 16384, 2);
  const text = args.join(" ");
  assert.match(text, /-p 127\.0\.0\.1:8001:30000/, "SGLang listens on 30000 inside the container");
  assert.match(text, /lmsysorg\/sglang:v0\.5\.23 python3 -m sglang\.launch_server --model-path Qwen\/Qwen3-4B-Instruct-2507 --served-model-name Qwen\/Qwen3-4B-Instruct-2507 --host 0\.0\.0\.0 --port 30000/);
  assert.match(text, /--context-length 16384 --mem-fraction-static 0\.4$/);
  assert.equal(text.match(/--context-length/g)?.length, 1, "the recipe's context is replaced, not repeated");
});

test("SGLang: up, update side by side from vLLM, rollback and bench behind the same interface", async () => {
  const { system, options, lines } = fixture();
  assert.equal(await modelCommand("up", ["qwen-old"], options), 0);
  assert.equal(await modelCommand("update", ["qwen-sglang"], options), 0);
  const run = system.modelCommands.find((command) => command.includes("sglang.launch_server"))!;
  assert.match(run, /--name dl-model-2 .*127\.0\.0\.1:8001:30000/);
  const state = JSON.parse(system.files.get("/tmp/model.json")!.content);
  assert.equal(state.active.engine, "sglang");
  assert.equal(state.previous.engine, undefined, "vLLM deployments keep their 0.30.1 shape");
  assert.equal(JSON.parse(system.files.get("/tmp/autopilot/config.json")!.content).providers.vllm.baseUrl, "http://127.0.0.1:8001/v1",
    "Autopilot reaches SGLang through the same OpenAI-compatible provider");
  assert.match(lines.join(""), /Start the SGLang container/);
  system.vllmLogs = "Prefill batch, #new-seq: 1, #new-token: 100, #cached-token: 300, token usage: 0.1\nPrefill batch, #new-seq: 1, #new-token: 100, #cached-token: 500\n";
  options.bench = undefined;
  options.fetch = async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "1 2" } }], usage: { completion_tokens: 8 } })}\n\ndata: [DONE]\n\n`, { status: 200 });
  assert.equal(await modelCommand("bench", [], options), 0);
  assert.match(lines.join(""), /Prefix cache: 80% hits \(SGLang logs\)/);
  options.bench = async () => ({ levels: [{ concurrency: 1, requests: 1, ttftP50: 0.1, ttftP95: 0.1, decodeTokPerSec: 50 }] });
  assert.equal(await modelCommand("rollback", [], options), 0);
  assert.ok(system.running.has("dl-model-1"));
  assert.ok(!system.running.has("dl-model-2"));
  assert.equal(JSON.parse(system.files.get("/tmp/model.json")!.content).previous.engine, "sglang", "rolling forward again restarts SGLang");
});

test("SGLang's startup logs and failures land in the run log, and failures name SGLang", async () => {
  const { system, options } = fixture();
  system.vllmLogs = "The server is fired up and ready to roll!\n";
  assert.equal(await modelCommand("up", ["qwen-sglang"], options), 0);
  const log = [...system.files.entries()].find(([path]) => path.startsWith("/tmp/logs/"))![1].content;
  assert.match(log, /SGLang logs \(dl-model-1, last 50 lines\):\n {2}The server is fired up and ready to roll!/);
  const failing = fixture();
  failing.options.smoke = async () => { throw new SmokeError("ready", "SGLang stopped while loading the model", "SGLang stopped"); };
  const error = await modelCommand("up", ["qwen-sglang"], failing.options).catch((caught: Error) => caught);
  assert.match(String(error), /The SGLang container (is still running|stopped): docker logs dl-model-1/);
  assert.equal(modelUpErrorType(new Error("Could not start SGLang: no GPU")), "launch_failed");
});

test("the smoke test speaks the same OpenAI API to SGLang, and names it when it never starts", async () => {
  const server = await fakeVllm({ thinking: "none" });
  try {
    const result = await smokeTest({ repo: "Qwen/Qwen3-4B-Instruct-2507", container: "dl-model-1", port: server.port }, new FakeModelSystem(), fetch, { attempts: 1, engineLabel: "SGLang" });
    assert.equal(result.json, true);
  } finally { await server.close(); }
  const down = await fakeVllm({ notReadyFor: 100 });
  try {
    const error = await smokeTest({ repo: "x", container: "dl-model-1", port: down.port }, new FakeModelSystem(), fetch, { attempts: 5, delay: async () => {}, running: async () => false, engineLabel: "SGLang" }).catch((caught: unknown) => caught);
    assert.ok(error instanceof SmokeError);
    assert.equal(error.message, "Startup: SGLang stopped while loading the model");
  } finally { await down.close(); }
});
