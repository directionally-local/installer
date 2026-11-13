import assert from "node:assert/strict";
import { test } from "node:test";
import { fittingModels, MODEL_CATALOG, recipe } from "./model-catalog.js";
import { modelCommand } from "./model-command.js";
import { TESTED_MODELS } from "./model-first-run.js";
import { chooseParallelism } from "./model-parallel.js";
import { detectHardware, dockerArgs } from "./model-runtime.js";
import type { Prompter } from "./prompt.js";
import { fixtureSystem } from "./test-support/gpu-fixtures.js";
import { PlainUi } from "./ui.js";

const MULTI = ["deepseek-v4.1-flash-fp8", "deepseek-v4.1-flash-fp4", "glm-5.3-flash"];

test("multi-GPU entries: untested, sized from their files, and never with a guessed flag", () => {
  for (const id of MULTI) {
    const model = recipe(id);
    assert.ok(!TESTED_MODELS.has(id), `${id} hasn't run on real hardware`);
    assert.ok(model.memory && model.memory.weightsBytes > 0 && model.memory.kvBytesPerToken > 0, `${id} has sizes for the preflight`);
    assert.equal(model.minCuda, "13.0", "vLLM and SGLang images are CUDA 13 only now");
    assert.ok(!model.flags.some((flag) => /speculative/.test(flag)), "speculative decoding is opt-in, not on by default");
    assert.ok(model.maxContext! >= model.defaultContext);
  }
  assert.equal(recipe("deepseek-v4.1-flash-fp8").repo, "deepseek-ai/DeepSeek-V4.1-Flash-1017");
  assert.match(recipe("deepseek-v4.1-flash-fp4").blocked!, /#47935.*#61530/);
  assert.equal(recipe("deepseek-v4.1-flash-fp4").engine, "sglang");
});

test("4x RTX PRO 6000 (PCIe): DeepSeek V4.1 Flash FP8 fits, runs TP 4 with the Blackwell flags and Engram in host RAM", async () => {
  const hardware = await detectHardware(fixtureSystem("rtx-pro-6000-4x-pcie"));
  assert.deepEqual(fittingModels(hardware.gpus).map((model) => model.id).filter((id) => MULTI.includes(id)), MULTI);
  const model = recipe("deepseek-v4.1-flash-fp8");
  const layout = chooseParallelism(model, hardware.gpus, hardware.topology)!;
  assert.deepEqual([layout.tp, layout.pp, layout.ep], [4, 1, false]);
  assert.match(layout.why, /recipe runs tensor parallel/);
  const args = dockerArgs(model, 8000, 131072, 1, { parallel: layout, computeCap: "12.0" }).join(" ");
  assert.match(args, /-e VLLM_ENGINE_READY_TIMEOUT_S=3600/);
  assert.match(args, /--engram-config \{"cpu_offload":true\}/);
  assert.match(args, /--attention-config \{"backend":"FLASHINFER_MLA_SPARSE_DSV41".*--kv-cache-dtype fp8 --max-num-seqs 128/);
  assert.match(args, /--max-model-len 131072 --gpu-memory-utilization 0\.92 --tensor-parallel-size 4$/);
  assert.doesNotMatch(args, /VLLM_USE_V2_MODEL_RUNNER/);
});

test("8x H100 (NVLink): DeepSeek V4.1 Flash FP8 runs TP 8 with the recipe's H100 settings", async () => {
  const hardware = await detectHardware(fixtureSystem("h100-8x-nvlink"));
  const model = recipe("deepseek-v4.1-flash-fp8");
  const layout = chooseParallelism(model, hardware.gpus, hardware.topology)!;
  assert.deepEqual([layout.tp, layout.interconnect.kind], [8, "nvlink"]);
  const args = dockerArgs(model, 8000, 131072, 1, { parallel: layout, computeCap: "9.0" }).join(" ");
  assert.match(args, /-e VLLM_USE_V2_MODEL_RUNNER=1 -e PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True/);
  assert.match(args, /--max-num-batched-tokens 4096/);
  assert.doesNotMatch(args, /attention-config/);
  // GLM-5.3-Flash documents only TP 4, and 4x 80 GB is short of its 306 GiB of FP8 weights.
  assert.equal(chooseParallelism(recipe("glm-5.3-flash"), hardware.gpus, hardware.topology), undefined);
});

test("a blocked entry is never started: up says why and points at the plan", async () => {
  const system = fixtureSystem("rtx-pro-6000-4x-pcie");
  const prompter: Prompter = { choose: async () => "", select: async () => ({ value: "" }), secret: async () => "", text: async () => "" };
  await assert.rejects(modelCommand("up", ["deepseek-v4.1-flash-fp4"], { system, ui: new PlainUi(() => {}), prompter, interactive: false, statePath: "/tmp/m.json", configPath: "/tmp/c.json" }),
    /deepseek-v4\.1-flash-fp4 can't be started yet: no released engine image loads it yet.*--plan/);
  assert.equal(system.modelCommands.length, 0);
  assert.ok(MODEL_CATALOG.some((model) => model.id === "deepseek-v4.1-flash-fp4"));
});
