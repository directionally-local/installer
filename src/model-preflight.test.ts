import assert from "node:assert/strict";
import { test } from "node:test";
import { recipe } from "./model-catalog.js";
import { modelCommand } from "./model-command.js";
import { hostResources, preflight, type HostResources } from "./model-preflight.js";
import { detectHardware, type Hardware } from "./model-runtime.js";
import type { Prompter } from "./prompt.js";
import { fixtureSystem } from "./test-support/gpu-fixtures.js";
import { PlainUi } from "./ui.js";

const GiB = 1024 ** 3;

async function proBox(): Promise<{ hardware: Hardware; host: HostResources }> {
  const system = fixtureSystem("rtx-pro-6000-4x-pcie");
  return { hardware: await detectHardware(system), host: await hostResources(system) };
}

function check(hardware: Hardware, host: HostResources, id: string, context: number, usable = hardware.gpus) {
  const model = recipe(id);
  return preflight({ model, context, hardware, usable, host })!;
}

test("host RAM and disk come from /proc/meminfo and df under Docker's root", async () => {
  const { host } = await proBox();
  assert.equal(host.ramTotalBytes, 263_750_000 * 1024);
  assert.equal(host.ramAvailableBytes, 255_000_000 * 1024);
  assert.equal(host.diskAvailableBytes, 3_800_000_000_000);
  assert.equal(host.diskPath, "/var/lib/docker");
});

test("4x RTX PRO 6000 + DeepSeek V4.1 Flash FP8 at 128k: weights, KV, indexer buffer, Engram RAM and disk all fit", async () => {
  const { hardware, host } = await proBox();
  const result = check(hardware, host, "deepseek-v4.1-flash-fp8", 131072);
  assert.deepEqual(result.problems, []);
  const gpu = result.gpus[0]!;
  // (510,296,708,312 - 203,073,076,240) / 4 bytes of weights per GPU.
  assert.equal(gpu.weightsBytes, 76_805_908_018);
  assert.equal(gpu.kvBytes, 890 * 131072, "MLA KV is whole on every GPU");
  assert.equal(gpu.bufferBytes, 2 * 8192 * 131072, "the indexer's [batched tokens x context] logits buffer, 2 GiB");
  assert.equal(Math.round(gpu.budgetBytes / GiB * 10) / 10, 87.9, "92% of 97,887 MiB");
  assert.ok(gpu.leftBytes > 14 * GiB);
  assert.equal(result.ramNeedBytes, 203_073_076_240 + 4 * 8 * GiB);
});

test("too long a context says exactly what's short and offers the longest that fits", async () => {
  const { hardware, host } = await proBox();
  const result = check(hardware, host, "deepseek-v4.1-flash-fp8", 1048576);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0]!, /^needs 4x 71\.5 GiB for weights \+ 0\.9 GiB KV \+ 16\.0 GiB indexer buffer at 1M per GPU; each GPU reserves 87\.9 GiB \(92% of 95\.6 GiB\)$/);
  assert.match(result.suggestions[0]!, /^a shorter context: --context \d+$/);
  const shorter = Number(result.suggestions[0]!.split(" ").at(-1));
  assert.ok(shorter > 131072 && shorter < 1048576);
  assert.deepEqual(check(hardware, host, "deepseek-v4.1-flash-fp8", shorter).problems, [], "the suggested context does fit");
});

test("two of four GPUs: short of VRAM, and the nearest fit is more GPUs", async () => {
  const { hardware, host } = await proBox();
  const result = check(hardware, host, "deepseek-v4.1-flash-fp8", 131072, hardware.gpus.slice(0, 2));
  assert.match(result.problems.join("; "), /needs 2x 143\.1 GiB for weights/);
  assert.ok(result.suggestions.includes("more GPUs: it also runs on 4 (this machine has 4; widen --gpus)"));
});

test("not enough system RAM for the Engram tables: says how much, and that FP4's smaller tables would fit", async () => {
  const { hardware } = await proBox();
  const host: HostResources = { ramTotalBytes: 210 * GiB, ramAvailableBytes: 200 * GiB, diskAvailableBytes: 4e12, diskPath: "/var/lib/docker" };
  const result = check(hardware, host, "deepseek-v4.1-flash-fp8", 131072);
  assert.deepEqual(result.problems, ["system RAM: needs 221.1 GiB (189.1 GiB offloaded + 32.0 GiB for 4 GPU workers), has 200.0 GiB available of 210.0 GiB"]);
  assert.equal(result.suggestions.length, 1);
  assert.match(result.suggestions[0]!, /^deepseek-v4\.1-flash-fp4 \(once it can run: no released engine image/);
});

test("disk and driver: the weights need room, and CUDA 13 images need a CUDA 13 driver", async () => {
  const { hardware, host } = await proBox();
  const result = check({ ...hardware, cuda: "12.8" }, { ...host, diskAvailableBytes: 300 * GiB }, "deepseek-v4.1-flash-fp8", 131072);
  assert.deepEqual(result.problems, [
    "disk: needs 475.3 GiB for the weights, /var/lib/docker has 300.0 GiB free (less is needed if they're already in the cache)",
    "the Nvidia driver supports CUDA 12.8; vllm/vllm-openai:v0.33.0 needs CUDA 13.0 (driver R580 or newer)",
  ]);
});

test("up runs the preflight before anything starts or downloads, and stops on a shortfall", async () => {
  const system = fixtureSystem("rtx-pro-6000-4x-pcie");
  const lines: string[] = [];
  const prompter: Prompter = { choose: async () => "", select: async () => ({ value: "" }), secret: async () => "", text: async () => "" };
  const sizes: string[] = [];
  const error = await modelCommand("up", ["deepseek-v4.1-flash-fp8"], { system, ui: new PlainUi((line) => lines.push(line)), prompter, interactive: false,
    statePath: "/tmp/m.json", configPath: "/tmp/c.json", context: "1048576",
    fetch: async (url) => { sizes.push(url); return new Response("[]", { status: 200 }); } }).catch((caught: Error) => caught);
  assert.match(String(error), /deepseek-v4\.1-flash-fp8 doesn't fit: needs 4x 71\.5 GiB for weights[\s\S]*Nearest that fits: a shorter context: --context \d+; deepseek-v4\.1-flash-fp4 \(once it can run: [^\n]*\); more GPUs: it also runs on 8 \(this machine has 4\)\./);
  assert.deepEqual(sizes, ["https://huggingface.co/api/models/deepseek-ai/DeepSeek-V4.1-Flash-1017/tree/main"], "the size comes from the Hugging Face API first");
  assert.equal(system.modelCommands.length, 0, "no container started, nothing downloaded");
  assert.match(lines.join(""), /FAILED Memory: 71\.5 GiB weights/);
  assert.match(lines.join(""), /No official recipe covers RTX PRO Blackwell \(sm120\)/);
});
