import assert from "node:assert/strict";
import { test } from "node:test";
import { fitGpus, fittingModels, type ModelRecipe } from "./model-catalog.js";
import { detectHardware } from "./model-runtime.js";
import { interconnect, parseTopology } from "./model-topology.js";
import { fixtureSystem, readFixture } from "./test-support/gpu-fixtures.js";

test("every GPU is detected with its index, name, VRAM and UUID", async () => {
  const hardware = await detectHardware(fixtureSystem("rtx-pro-6000-4x-pcie"));
  assert.equal(hardware.gpus.length, 4);
  assert.deepEqual(hardware.gpus.map((gpu) => gpu.index), [0, 1, 2, 3]);
  assert.equal(hardware.gpus[3]!.name, "NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition");
  assert.equal(hardware.gpus[3]!.totalMiB, 97887);
  assert.equal(hardware.gpus[3]!.uuid, "GPU-6b2d1f3e-0000-4000-8000-000000006003");
  assert.equal(hardware.gpus[3]!.computeCap, "12.0");
  assert.equal(hardware.cuda, "13.0");
  assert.deepEqual(hardware.topology?.gpus, [0, 1, 2, 3]);
});

test("one GPU skips nvidia-smi topo -m: it has no links", async () => {
  const system = fixtureSystem("rtx-pro-5000-1x");
  const hardware = await detectHardware(system);
  assert.equal(hardware.gpus.length, 1);
  assert.equal(hardware.topology, undefined);
  assert.ok(!system.probes.some((probe) => probe.includes("topo")));
});

test("topo -m: NVLink everywhere on 8x H100, PCIe only on 4x RTX PRO 6000", () => {
  const h100 = parseTopology(readFixture("h100-8x-nvlink", "topo.txt"))!;
  assert.deepEqual(h100.gpus, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(h100.links[0]![7], "NV18");
  assert.deepEqual(interconnect(h100), { kind: "nvlink", worst: "NV18", text: "NVLink (NV18) between every pair" });
  const pcie = parseTopology(readFixture("rtx-pro-6000-4x-pcie", "topo.txt"))!;
  assert.deepEqual(interconnect(pcie), { kind: "pcie", worst: "NODE", text: "PCIe only (NODE), no NVLink" });
  assert.equal(interconnect(pcie, [2]).kind, "single");
});

test("the slowest pair decides: one PCIe hop among NVLinks is PCIe, and SYS is worse than PIX", () => {
  const mixed = parseTopology([
    "\tGPU0\tGPU1\tGPU2\tGPU3\tCPU Affinity\tNUMA Affinity",
    "GPU0\t X \tNV4\tPIX\tSYS\t0-15\t0",
    "GPU1\tNV4\t X \tSYS\tPIX\t0-15\t0",
    "GPU2\tPIX\tSYS\t X \tNV4\t16-31\t1",
    "GPU3\tSYS\tPIX\tNV4\t X \t16-31\t1",
  ].join("\n"))!;
  assert.equal(interconnect(mixed, [0, 1]).kind, "nvlink");
  assert.equal(interconnect(mixed, [0, 2]).worst, "PIX");
  assert.equal(interconnect(mixed).worst, "SYS");
  assert.equal(parseTopology("garbage"), undefined);
  assert.equal(interconnect(undefined, [0, 1]).kind, "pcie", "unknown topology is planned as PCIe, the cautious choice");
});

test("models that fit count every usable GPU (or a subset), not GPU 0", () => {
  const big: ModelRecipe = { id: "big", repo: "x/big", minVramMiB: 60_000, minTotalVramMiB: 300_000, parallel: { tp: [2, 4, 8] },
    gpuMemoryUtilization: 0.9, image: "vllm/vllm-openai:v0", flags: [], defaultContext: 8192 };
  const four = Array.from({ length: 4 }, (_, index) => ({ index, totalMiB: 97887 }));
  assert.deepEqual(fitGpus(big, four)?.map((gpu) => gpu.index), [0, 1, 2, 3]);
  assert.equal(fitGpus(big, four.slice(0, 2)), undefined, "two GPUs are 191 GB, short of 300 GB");
  assert.equal(fitGpus(big, [{ index: 0, totalMiB: 400_000 }]), undefined, "tp 1 isn't supported");
  const eight = Array.from({ length: 8 }, (_, index) => ({ index, totalMiB: 81559 }));
  assert.equal(fitGpus(big, eight)?.length, 8, "the most GPUs it supports, for KV cache room");
  // One GPU, as before: the single-GPU entries fit exactly as they did.
  assert.deepEqual(fittingModels(16384).map((model) => model.id), ["qwen-new", "qwen-old"]);
  assert.deepEqual(fittingModels([{ index: 0, totalMiB: 16384 }, { index: 1, totalMiB: 16384 }]).map((model) => model.id), ["qwen-new", "qwen-old"],
    "two 16 GB GPUs don't make a single-GPU model fit a 32 GB requirement");
});

test("layout: tensor parallel over NVLink, pipeline parallel over PCIe unless the recipe says tensor", async () => {
  const { chooseParallelism, parallelFlags } = await import("./model-parallel.js");
  const moe: ModelRecipe = { id: "moe", repo: "x/moe", minVramMiB: 40_000, minTotalVramMiB: 300_000, parallel: { tp: [4, 8], ep: true },
    gpuMemoryUtilization: 0.9, image: "vllm/vllm-openai:v0", flags: [], defaultContext: 8192 };
  const h100 = await detectHardware(fixtureSystem("h100-8x-nvlink"));
  const nv = chooseParallelism(moe, h100.gpus, h100.topology)!;
  assert.deepEqual([nv.tp, nv.pp, nv.ep, nv.gpus.length, nv.interconnect.kind], [8, 1, true, 8, "nvlink"]);
  assert.deepEqual(parallelFlags(nv), ["--tensor-parallel-size", "8", "--enable-expert-parallel"]);
  assert.deepEqual(parallelFlags(nv, "sglang"), ["--tp-size", "8", "--ep-size", "8"]);
  const pro = await detectHardware(fixtureSystem("rtx-pro-6000-4x-pcie"));
  const pcie = chooseParallelism(moe, pro.gpus, pro.topology)!;
  assert.deepEqual([pcie.tp, pcie.pp, pcie.ep], [1, 4, false]);
  assert.match(pcie.why, /pipeline parallel over 4 GPUs \(PCIe only \(NODE\), no NVLink\)/);
  assert.deepEqual(parallelFlags(pcie), ["--pipeline-parallel-size", "4"]);
  const recipeTp = chooseParallelism({ ...moe, parallel: { ...moe.parallel!, pcie: "tp", pcieWhy: "its recipe runs TP 4" } }, pro.gpus, pro.topology)!;
  assert.deepEqual([recipeTp.tp, recipeTp.pp, recipeTp.ep], [4, 1, true]);
  assert.match(recipeTp.why, /its recipe runs TP 4/);
  const one = chooseParallelism({ ...moe, minTotalVramMiB: 40_000, parallel: undefined }, pro.gpus, pro.topology)!;
  assert.deepEqual([one.gpus, one.tp, parallelFlags(one).length], [[0], 1, 0], "one GPU adds no flags: single-GPU commands stay as they were");
});
