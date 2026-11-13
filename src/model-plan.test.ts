import assert from "node:assert/strict";
import { test } from "node:test";
import { main } from "./cli.js";
import { modelCommand } from "./model-command.js";
import { planCommand, readOnly, shellCommand } from "./model-plan.js";
import type { Prompter } from "./prompt.js";
import type { RunOptions, RunResult } from "./system.js";
import { fixtureDir, fixtureSystem, readFixture, type GpuFixture } from "./test-support/gpu-fixtures.js";
import { PlainUi } from "./ui.js";

/** `dl model up MODEL --plan --hardware DIR` through the CLI, as a person would run it. */
async function cliPlan(fixture: GpuFixture, model: string, ...extra: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await main(["model", "up", model, "--plan", "--hardware", fixtureDir(fixture), ...extra], { out: (text) => { out += text; }, err: (text) => { err += text; } }, { terminal: false });
  return { code, out, err };
}

/** The plan's command as the argv `up` passes to docker (lines joined, shell quotes removed). */
function commandOf(plan: string): string {
  const command = plan.slice(plan.lastIndexOf("\nCommand") + 1).split("\n").slice(1).join("\n").trim();
  return command.replace(/ \\\n {4}/g, " ").replace(/'([^']*)'/g, "$1");
}

test("1x RTX PRO 5000 + qwen-new: the plan's docker command is byte for byte what 0.30.1 runs", async () => {
  const golden = JSON.parse(readFixture("rtx-pro-5000-1x", "golden-0.30.1.json")) as { dryRun: { docker: string[] } };
  const { code, out } = await cliPlan("rtx-pro-5000-1x", "qwen-new");
  assert.equal(code, 0);
  assert.equal(commandOf(out), golden.dryRun.docker[0]);
  assert.match(out, /Layout {5}one GPU\n/);
  assert.match(out, /needs {4}16 GB of GPU VRAM \(catalog\); vLLM reserves 40% of the GPU = 19\.1 GiB/);
});

test("4x RTX PRO 6000 PCIe + DeepSeek V4.1 Flash FP8: TP 4, the memory math, and a command that runs nothing", async () => {
  const { code, out, err } = await cliPlan("rtx-pro-6000-4x-pcie", "deepseek-v4.1-flash-fp8");
  assert.equal(err, "");
  assert.equal(code, 0);
  assert.match(out, /^Plan for deepseek-v4\.1-flash-fp8 \(deepseek-ai\/DeepSeek-V4\.1-Flash-1017\) · untested · hardware from /);
  assert.match(out, /Links {6}PCIe only \(NODE\), no NVLink/);
  assert.match(out, /Layout {5}tensor parallel over 4 GPUs .* · TP 4 × PP 1/);
  assert.match(out, / {2}weights {2}71\.5 GiB = \(475\.3 GiB − 189\.1 GiB in host RAM\) \/ 4 GPUs/);
  assert.match(out, / {2}RAM {6}221\.1 GiB container limit \(--memory\) = 189\.1 GiB in host RAM \+ 4 × 8\.0 GiB per GPU worker; 243\.2 GiB available/);
  assert.match(out, /Hugging Face API, \*\.safetensors of deepseek-ai\/DeepSeek-V4\.1-Flash-1017 \(48 shards\), 2026-11-13/, "--hardware never calls the network");
  assert.match(out, /Result {4}fits: GPU memory, host RAM, disk and driver\n/);
  assert.match(out, /No official recipe covers RTX PRO Blackwell \(sm120\)/);
  const command = commandOf(out);
  assert.match(command, /^docker run -d --name dl-model-1 --gpus all --ipc=host --memory 222g --memory-swap 222g -p 127\.0\.0\.1:8000:8000/);
  assert.match(command, /--tensor-parallel-size 4$/);
  assert.match(out, /--engram-config '\{"cpu_offload":true\}'/, "JSON flags are shell-quoted");
});

test("4x RTX PRO 6000 + DeepSeek V4.1 Flash FP4: planned, but blocked until an engine release loads it", async () => {
  const { code, out } = await cliPlan("rtx-pro-6000-4x-pcie", "deepseek-v4.1-flash-fp4");
  assert.equal(code, 1);
  assert.match(out, /Engine {5}SGLang · lmsysorg\/sglang:v0\.5\.23/);
  assert.match(out, /Result {4}fits on paper, but blocked \(see above\): GPU memory/);
  assert.match(out, /\nCommand \(once unblocked\)\ndocker run /);
  assert.match(commandOf(out), /lmsysorg\/sglang:v0\.5\.23 python3 -m sglang\.launch_server --model-path nvidia\/DeepSeek-V4\.1-Flash-1017-NVFP4/);
  assert.match(commandOf(out), /--tp-size 4$/);
});

test("8x H100 NVLink + DeepSeek V4.1 Flash FP8: TP 8 over NVLink with the recipe's H100 settings", async () => {
  const { code, out } = await cliPlan("h100-8x-nvlink", "deepseek-v4.1-flash-fp8");
  assert.equal(code, 0);
  assert.match(out, /Links {6}NVLink \(NV18\) between every pair/);
  assert.match(out, /TP 8 × PP 1/);
  assert.match(out, /Settings {3}sm 9\.0: Hopper/);
  assert.match(out, / {2}buffer {3}1\.0 GiB = 2 B × 4096 batched tokens × 131072/);
  assert.match(commandOf(out), /-e VLLM_USE_V2_MODEL_RUNNER=1 .*--max-num-batched-tokens 4096 .*--tensor-parallel-size 8$/);
});

test("--gpus and --name in a plan: pinned devices, the named container, and a shortfall with the nearest fit", async () => {
  const pinned = await cliPlan("rtx-pro-6000-4x-pcie", "deepseek-v4.1-flash-fp8", "--gpus", "0,1", "--name", "big", "--port", "8100");
  assert.equal(pinned.code, 1);
  assert.match(pinned.out, /Result {4}doesn't fit\n {2}- needs 2x 143\.1 GiB for weights/);
  assert.match(pinned.out, /nearest that fits: .*more GPUs: it also runs on 4 \(this machine has 4; widen --gpus\)/);
  assert.match(commandOf(pinned.out), /--name dl-model-big-1 --gpus "device=0,1" .*127\.0\.0\.1:8100:8000/);
  const glm = await cliPlan("h100-8x-nvlink", "glm-5.3-flash");
  assert.equal(glm.code, 1, "4x 80 GB is short of GLM-5.3-Flash's FP8 weights at its only documented size");
  assert.match(glm.out, /GPU 0 .* used\n.*GPU|Container {2}dl-model-1 · sees GPU 0, 1, 2, 3 only/s);
});

test("the plan runs nothing: no Docker, no writes, only nvidia-smi and df", async () => {
  const system = fixtureSystem("rtx-pro-6000-4x-pcie");
  const before = new Map(system.files);
  let out = "";
  const code = await planCommand({ system, model: "deepseek-v4.1-flash-fp8", out: (text) => { out += text; }, statePath: "/tmp/model.json",
    fetch: async () => new Response("offline", { status: 503 }) });
  assert.equal(code, 0);
  assert.deepEqual(system.modelCommands, []);
  assert.deepEqual(system.commands, []);
  assert.deepEqual(new Map(system.files), before);
  assert.ok(system.probes.every((probe) => /^(nvidia-smi|df)( |$)/.test(probe)), system.probes.join("\n"));
  const guard = readOnly(system);
  await assert.rejects(guard.run("docker", ["run"]), /never runs commands/);
  await assert.rejects(guard.writeFile("/tmp/x", "y"), /never writes files/);
  assert.equal((await guard.probe("docker", ["info"])).code, 1, "Docker isn't even probed");
  assert.match(out, /Nothing was run, downloaded or written/);
});

test("the plan's command is exactly what up runs for the same machine and options", async () => {
  const system = fixtureSystem("rtx-pro-6000-4x-pcie");
  let out = "";
  await planCommand({ system, model: "deepseek-v4.1-flash-fp8", name: "big", gpus: "0,1,2,3", port: "8100", out: (text) => { out += text; }, statePath: "/tmp/model.json",
    fetch: async () => new Response("offline", { status: 503 }) });
  const dry = fixtureSystem("rtx-pro-6000-4x-pcie");
  Object.defineProperty(dry, "dryRun", { value: true });
  const ran: string[] = [];
  dry.run = async (command: string, args: string[], _options?: RunOptions): Promise<RunResult> => { ran.push([command, ...args].join(" ")); return { code: 0, stdout: "", stderr: "" }; };
  const prompter: Prompter = { choose: async () => "", select: async () => ({ value: "" }), secret: async () => "", text: async () => "" };
  await modelCommand("up", ["deepseek-v4.1-flash-fp8"], { system: dry, ui: new PlainUi(() => {}), prompter, interactive: false, statePath: "/tmp/model.json", configPath: "/tmp/c.json",
    name: "big", gpus: "0,1,2,3", port: "8100", fetch: async () => new Response("offline", { status: 503 }) });
  assert.equal(commandOf(out), ran.find((line) => line.startsWith("docker run")));
});

test("shell quoting keeps flags with their values and quotes what a shell would read", () => {
  assert.equal(shellCommand(["run", "--gpus", '"device=0,1"', "--engram-config", '{"a":true}']), `docker run --gpus '"device=0,1"' --engram-config '{"a":true}'`);
});
