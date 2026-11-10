import assert from "node:assert/strict";
import { test } from "node:test";
import { modelCommand, type ModelCommandOptions } from "./model-command.js";
import { FakeModelSystem } from "./test-support/fake-model-system.js";
import { PlainUi } from "./ui.js";
import type { Prompter } from "./prompt.js";
import type { ModelDeployment } from "./state.js";
import type { System, RunOptions, RunResult } from "./system.js";

function fixture() {
  const system = new FakeModelSystem();
  const lines: string[] = [];
  const answers: string[] = [];
  let failNew = false;
  let failOld = false;
  const prompter: Prompter = {
    choose: async () => "qwen-old", select: async (_question, choices) => ({ value: choices[0]!.value }),
    secret: async () => "", text: async () => answers.shift() ?? "",
  };
  const options: ModelCommandOptions = { system, ui: new PlainUi((line) => lines.push(line)), prompter, interactive: true,
    configPath: "/tmp/autopilot/config.json", statePath: "/tmp/model.json",
    smoke: async (deployment: Pick<ModelDeployment, "repo" | "port" | "container">) => {
      if (failNew && deployment.repo.includes("2507")) throw new Error("smoke failed: model loading\nvLLM logs: crash");
      if (failOld && !deployment.repo.includes("2507")) throw new Error("smoke failed: JSON mode did not return {ok:true}\nvLLM logs: ok");
      return { chat: true, tools: true, json: true, tokensPerSecond: deployment.repo.includes("2507") ? 25 : 10, at: "now" };
    } };
  return { system, lines, answers, options, failNew: () => { failNew = true; }, failOld: () => { failOld = true; } };
}

test("up configures vllm provider and state; status shows GPU and tests", async () => {
  const { system, options, lines } = fixture();
  assert.equal(await modelCommand("up", ["qwen-old"], options), 0);
  assert.ok(system.running.has("dl-model-1"));
  const config = JSON.parse(system.files.get("/tmp/autopilot/config.json")!.content);
  assert.equal(config.provider, "vllm");
  assert.equal(config.providers.vllm.baseUrl, "http://127.0.0.1:8000/v1");
  assert.equal(await modelCommand("status", [], options), 0);
  assert.match(lines.join(""), /GPU 0.*49152.*Last test.*10 tokens\/sec/s);
  assert.equal(system.modelCommands.length, 1);
});

test("update compares both, switches provider, and rollback restores old deployment", async () => {
  const { system, options, lines } = fixture();
  await modelCommand("up", ["qwen-old"], options);
  assert.equal(await modelCommand("update", ["qwen-new"], options), 0);
  assert.ok(system.running.has("dl-model-2"));
  assert.ok(!system.running.has("dl-model-1"));
  assert.match(lines.join(""), /old .*10 tok\/s.*new .*25 tok\/s/);
  assert.equal(JSON.parse(system.files.get("/tmp/model.json")!.content).previous.port, 8000);
  assert.equal(await modelCommand("rollback", [], options), 0);
  assert.ok(system.running.has("dl-model-1"));
  assert.ok(!system.running.has("dl-model-2"));
  assert.equal(JSON.parse(system.files.get("/tmp/autopilot/config.json")!.content).providers.vllm.baseUrl, "http://127.0.0.1:8000/v1");
});

test("update chooses side-by-side when the GPU reservation fits in free VRAM", async () => {
  const { system, options, lines } = fixture();
  await modelCommand("up", ["qwen-old"], options);
  system.gpu = "0, GPU, 49152, 29491, 570.86\n"; // qwen-old reserves 0.4 * 49152, rest free
  assert.equal(await modelCommand("update", ["qwen-new"], options), 0);
  assert.match(lines.join(""), /side-by-side/);
  assert.ok(!lines.join("").match(/Accept downtime/));
  assert.ok(system.running.has("dl-model-2"));
  assert.ok(!system.running.has("dl-model-1"));
});

test("an incumbent that fails its smoke re-test warns but does not stop the switch", async () => {
  const { system, options, lines, failOld } = fixture();
  await modelCommand("up", ["qwen-old"], options);
  failOld();
  assert.equal(await modelCommand("update", ["qwen-new"], options), 0);
  assert.ok(system.running.has("dl-model-2"));
  assert.ok(!system.running.has("dl-model-1"));
  assert.match(lines.join(""), /failed its smoke re-test|Switching anyway/);
  assert.equal(JSON.parse(system.files.get("/tmp/model.json")!.content).active.id, "qwen-new");
  assert.equal(JSON.parse(system.files.get("/tmp/autopilot/config.json")!.content).providers.vllm.baseUrl, "http://127.0.0.1:8001/v1");
});

test("failed update removes candidate and preserves old provider and state", async () => {
  const { system, options, failNew } = fixture();
  await modelCommand("up", ["qwen-old"], options);
  failNew();
  await assert.rejects(modelCommand("update", ["qwen-new"], options), /vLLM logs/);
  assert.ok(system.running.has("dl-model-1"));
  assert.ok(!system.running.has("dl-model-2"));
  assert.equal(JSON.parse(system.files.get("/tmp/model.json")!.content).active.id, "qwen-old");
  assert.equal(JSON.parse(system.files.get("/tmp/autopilot/config.json")!.content).providers.vllm.baseUrl, "http://127.0.0.1:8000/v1");
});

test("insufficient free VRAM asks before downtime and restores old after failure", async () => {
  const { system, options, answers, failNew } = fixture();
  await modelCommand("up", ["qwen-old"], options);
  system.gpu = "0, GPU, 49152, 1024, 570\n";
  answers.push("", "", "n");
  assert.equal(await modelCommand("update", ["qwen-new"], options), 130);
  assert.ok(system.running.has("dl-model-1"));
  answers.push("", "", "yes"); failNew();
  await assert.rejects(modelCommand("update", ["qwen-new"], options), /smoke failed/);
  assert.ok(system.running.has("dl-model-1"));
});

test("dry run prints every planned Docker command without writing state or provider", async () => {
  class DryFake extends FakeModelSystem {
    constructor() { super(); Object.defineProperty(this, "dryRun", { value: true }); }
    override async run(command: string, args: string[], _options?: RunOptions): Promise<RunResult> {
      this.modelCommands.push([command, ...args].join(" "));
      return { code: 0, stdout: "", stderr: "" };
    }
  }
  const dry = new DryFake();
  const { options, lines } = fixture();
  options.system = dry as System;
  assert.equal(await modelCommand("up", ["qwen-old"], options), 0);
  assert.match(dry.modelCommands.join(""), /docker run/);
  assert.equal(dry.files.size, 1);
  assert.match(lines.join(""), /No model, provider or state changed/);
});

test("non-interactive up uses defaults and names a model when none is given", async () => {
  const { system, options } = fixture();
  options.interactive = false;
  await assert.rejects(modelCommand("up", [], options), /Name a model/);
  assert.equal(await modelCommand("up", ["qwen-old"], options), 0);
  const state = JSON.parse(system.files.get("/tmp/model.json")!.content);
  assert.equal(state.active.port, 8000);
  assert.equal(state.active.context, 32768);
});

test("a stale spare container stops the update before the current model is touched", async () => {
  const { system, options } = fixture();
  await modelCommand("up", ["qwen-old"], options);
  system.running.add("dl-model-2");
  await assert.rejects(modelCommand("update", ["qwen-new"], options), /Spare container dl-model-2 is running/);
  assert.ok(system.running.has("dl-model-1"));
  assert.ok(system.running.has("dl-model-2"));
});

test("status with no model says how to start one", async () => {
  const { options, lines } = fixture();
  assert.equal(await modelCommand("status", [], options), 0);
  assert.match(lines.join(""), /none · dl model up/);
});
