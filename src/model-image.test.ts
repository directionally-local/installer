import assert from "node:assert/strict";
import { test } from "node:test";
import { main } from "./cli.js";
import { recipe } from "./model-catalog.js";
import { caveatsFor, modelCommand, type ModelCommandOptions } from "./model-command.js";
import { chooseImage, isOfficial, parseImageRef, unofficialWarning, withImage } from "./model-image.js";
import { containerSpec } from "./model-runtime.js";
import type { Prompter } from "./prompt.js";
import { readDeployments } from "./state.js";
import { fixtureDir, fixtureSystem, readFixture, type GpuFixture } from "./test-support/gpu-fixtures.js";
import { PlainUi } from "./ui.js";

async function cliPlan(fixture: GpuFixture, model: string, ...extra: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await main(["model", "up", model, "--plan", "--hardware", fixtureDir(fixture), ...extra], { out: (text) => { out += text; }, err: (text) => { err += text; } }, { terminal: false });
  return { code, out: out.replace(`hardware from ${fixtureDir(fixture)}`, "hardware from HARDWARE"), err };
}

test("4x RTX PRO 6000 PCIe + DeepSeek V4.1 Flash FP8 --plan, verbatim, with the catalog image", async () => {
  const { code, out, err } = await cliPlan("rtx-pro-6000-4x-pcie", "deepseek-v4.1-flash-fp8");
  assert.equal(err, "");
  assert.equal(code, 0);
  assert.equal(out, readFixture("rtx-pro-6000-4x-pcie", "plan-deepseek-v4.1-flash-fp8.txt"));
});

test("4x RTX PRO 6000 PCIe + DeepSeek V4.1 Flash FP8 --plan --image v0.34.0rc2, verbatim", async () => {
  const { code, out, err } = await cliPlan("rtx-pro-6000-4x-pcie", "deepseek-v4.1-flash-fp8", "--image", "vllm/vllm-openai:v0.34.0rc2");
  assert.equal(err, "");
  assert.equal(code, 0);
  assert.equal(out, readFixture("rtx-pro-6000-4x-pcie", "plan-deepseek-v4.1-flash-fp8-image-v0.34.0rc2.txt"));
  assert.match(out, /Engine {5}vLLM · vllm\/vllm-openai:v0\.34\.0rc2 \(--image; catalog default v0\.33\.0\)\n/);
  assert.doesNotMatch(out, /Expect to need a newer image/, "the caveat doesn't repeat its advice for the image it names");
  assert.doesNotMatch(out, /verified it\b(?!\.)|is verified|was verified/);
  assert.doesNotMatch(out, /Warning/, "the official repository gets no warning");
});

test("an override the caveat doesn't name keeps the caveat's advice; another repository is warned about, not refused", async () => {
  const { code, out } = await cliPlan("rtx-pro-6000-4x-pcie", "deepseek-v4.1-flash-fp8", "--image", "registry.example.com:5000/team/vllm:v0.34.0rc2");
  assert.equal(code, 0);
  assert.match(out, /Engine {5}vLLM · registry\.example\.com:5000\/team\/vllm:v0\.34\.0rc2 \(--image; catalog default vllm\/vllm-openai:v0\.33\.0\)\n/);
  assert.match(out, /\nWarning {4}registry\.example\.com:5000\/team\/vllm isn't vLLM's official image \(vllm\/vllm-openai\); using it as given\.\n/);
  assert.match(out, /on the release tag\. Expect to need a newer image\./);
  assert.match(out.replace(/ \\\n {4}/g, " "), / registry\.example\.com:5000\/team\/vllm:v0\.34\.0rc2 --model deepseek-ai/);
  const sglang = await cliPlan("rtx-pro-6000-4x-pcie", "deepseek-v4.1-flash-fp4", "--image", "lmsysorg/sglang:nightly");
  assert.equal(sglang.code, 1, "a blocked entry stays blocked");
  assert.match(sglang.out, /Engine {5}SGLang · lmsysorg\/sglang:nightly \(--image; catalog default v0\.5\.23\)\n/);
  assert.doesNotMatch(sglang.out, /Warning/);
  assert.match(sglang.out, /can't be started yet: .*\(--image doesn't lift this: dl starts no blocked entry\)/);
  assert.match(sglang.out.replace(/ \\\n {4}/g, " "), / lmsysorg\/sglang:nightly python3 -m sglang\.launch_server/);
});

test("bad image references are refused with a clear message", async () => {
  for (const [ref, why] of [
    ["", /needs a container image/], ["vllm/vllm openai:v1", /has spaces/], ["https://hub.docker.com/vllm/vllm-openai", /is a URL/],
    ["vLLM/vllm-openai:v1", /capital letters/], ["vllm/vllm-openai:", /invalid tag/], ["vllm/vllm-openai:-x", /invalid tag/],
    ["vllm/vllm-openai@sha256:abc", /digest/], ["vllm//vllm-openai", /isn't a valid image name/], ["vllm/vllm-openai:a:b", /invalid registry|isn't a valid/],
  ] as const) assert.throws(() => parseImageRef(ref), why, ref);
  assert.deepEqual(parseImageRef("vllm/vllm-openai:v0.34.0rc2"), { repository: "vllm/vllm-openai", tag: "v0.34.0rc2" });
  const digest = `sha256:${"a".repeat(64)}`;
  assert.deepEqual(parseImageRef(`localhost:5000/vllm-openai:v1@${digest}`), { repository: "localhost:5000/vllm-openai", tag: "v1", digest });
  assert.deepEqual(parseImageRef("ubuntu"), { repository: "ubuntu" });
  assert.ok(isOfficial("vllm", "docker.io/vllm/vllm-openai:nightly"));
  assert.equal(unofficialWarning("sglang", "SGLang", "lmsysorg/sglang:v0.5.24"), undefined);
  const { code, out, err } = await cliPlan("rtx-pro-5000-1x", "qwen-new", "--image", "Vllm/x");
  assert.equal(code, 1);
  assert.equal(out, "");
  assert.match(err, /"Vllm\/x" has capital letters in its name/);
});

test("the image is part of the container's recipe hash", () => {
  const model = recipe("deepseek-v4.1-flash-fp8");
  const spec = (image?: string) => containerSpec(withImage(model, chooseImage(model, image)), 8000, 131072, 1, { computeCap: "12.0" });
  assert.equal(spec(), spec("vllm/vllm-openai:v0.33.0"), "the catalog image given as --image is no override");
  assert.notEqual(spec(), spec("vllm/vllm-openai:v0.34.0rc2"));
  assert.notEqual(spec("vllm/vllm-openai:v0.34.0rc2"), spec("vllm/vllm-openai:nightly"));
  assert.equal(withImage(model, chooseImage(model, "vllm/vllm-openai:v0.34.0rc2")).minCuda, undefined, "the override's CUDA requirement is unknown");
  assert.deepEqual(withImage(model, chooseImage(model, "vllm/vllm-openai:v0.34.0rc2")).flags, model.flags, "the catalog's flags stay");
  assert.equal(caveatsFor(model, [{ computeCap: "12.0" }])[0]!.endsWith("Expect to need a newer image."), true);
});

function machine() {
  const system = fixtureSystem("rtx-pro-6000-4x-pcie");
  const lines: string[] = [];
  const prompter: Prompter = { choose: async () => "", select: async (_q, choices) => ({ value: choices[0]!.value }), secret: async () => "", text: async () => "" };
  const base: ModelCommandOptions = { system, ui: new PlainUi((line) => lines.push(line)), prompter, interactive: false,
    statePath: "/tmp/model.json", configPath: "/tmp/autopilot/config.json",
    fetch: async () => new Response("offline", { status: 503 }),
    smoke: async () => ({ chat: true, tools: true, json: true, tokensPerSecond: 20, at: "now" }),
    bench: async () => ({ levels: [{ concurrency: 1, requests: 1, ttftP50: 0.1, ttftP95: 0.1, decodeTokPerSec: 20 }] }) };
  const run = (action: string, args: string[], extra: Partial<ModelCommandOptions> = {}) => modelCommand(action, args, { ...base, ...extra });
  const runOf = (container: string) => system.modelCommands.filter((command) => command.startsWith("run ") && command.includes(`--name ${container} `)).at(-1)!;
  const active = async () => (await readDeployments(system, "/tmp/model.json"))["default"]!.active;
  return { system, lines, run, runOf, active };
}

test("up --image runs and records the image; status and list show it; update keeps it, --image replaces it, rollback restores it", async () => {
  const { lines, run, runOf, active } = machine();
  assert.equal(await run("up", ["qwen-new"], { image: "vllm/vllm-openai:v0.34.0rc2" }), 0);
  assert.match(runOf("dl-model-1"), / vllm\/vllm-openai:v0\.34\.0rc2 --model Qwen\/Qwen3-4B-Instruct-2507 --served-model-name Qwen\/Qwen3-4B-Instruct-2507 --tool-call-parser hermes /);
  assert.match(lines.join(""), /Image: vllm\/vllm-openai:v0\.34\.0rc2 \(--image; catalog default v0\.20\.0\)\n/);
  assert.deepEqual([(await active()).image, (await active()).catalogImage], ["vllm/vllm-openai:v0.34.0rc2", "vllm/vllm-openai:v0.20.0"]);

  lines.length = 0;
  await run("status", []);
  assert.match(lines.join(""), /Image: vllm\/vllm-openai:v0\.34\.0rc2 \(--image; catalog default v0\.20\.0\)\n/);
  lines.length = 0;
  await run("list", []);
  assert.equal(lines.join(""), "ok default: qwen-new · vLLM · vllm/vllm-openai:v0.34.0rc2 (--image; catalog default v0.20.0) · GPUs all · port 8000 · running\n");

  // An update without --image keeps it, and says so.
  lines.length = 0;
  assert.equal(await run("update", ["qwen-old"]), 0);
  assert.match(lines.join(""), /Image: vllm\/vllm-openai:v0\.34\.0rc2, kept from the current deployment's --image \(pass --image to change it\)\n/);
  assert.match(runOf("dl-model-2"), / vllm\/vllm-openai:v0\.34\.0rc2 --model Qwen\/Qwen3-4B /);
  assert.equal((await active()).image, "vllm/vllm-openai:v0.34.0rc2");

  // --image again replaces it; the catalog's own image ends the override.
  assert.equal(await run("update", ["qwen-new"], { image: "vllm/vllm-openai:nightly" }), 0);
  assert.match(runOf("dl-model-1"), / vllm\/vllm-openai:nightly --model Qwen\/Qwen3-4B-Instruct-2507 /);
  assert.deepEqual([(await active()).image, (await active()).catalogImage], ["vllm/vllm-openai:nightly", "vllm/vllm-openai:v0.20.0"]);

  // Rollback restores the previous deployment's image (and that it was an override).
  assert.equal(await run("rollback", []), 0);
  assert.match(runOf("dl-model-2"), / vllm\/vllm-openai:v0\.34\.0rc2 --model Qwen\/Qwen3-4B /);
  assert.deepEqual([(await active()).id, (await active()).image, (await active()).catalogImage], ["qwen-old", "vllm/vllm-openai:v0.34.0rc2", "vllm/vllm-openai:v0.20.0"]);
  await assert.rejects(run("rollback", [], { image: "vllm/vllm-openai:v1" }), /--image goes with dl model up and dl model update; rollback restores the previous deployment's image/);

  assert.equal(await run("update", ["qwen-new"], { image: "vllm/vllm-openai:v0.20.0" }), 0);
  assert.deepEqual([(await active()).image, (await active()).catalogImage], ["vllm/vllm-openai:v0.20.0", undefined]);
});

test("a running container with another image isn't reused", async () => {
  const { system, lines, run } = machine();
  await assert.rejects(run("up", ["qwen-new"], { smoke: async () => { throw new Error("smoke failed"); } }), /smoke failed/);
  assert.ok(system.running.has("dl-model-1"), "the failed attempt's container is kept for a retry");
  lines.length = 0;
  assert.equal(await run("up", ["qwen-new"], { image: "vllm/vllm-openai:v0.34.0rc2" }), 0);
  assert.doesNotMatch(lines.join(""), /already running/);
  assert.ok(system.modelCommands.includes("rm -f dl-model-1"), "the old-image container is replaced");
});

test("up --image warns once about a non-official repository and notes the skipped driver check", async () => {
  const { lines, run } = machine();
  assert.equal(await run("up", ["deepseek-v4.1-flash-fp8"], { image: "ghcr.io/someone/vllm:sm120" }), 0);
  const text = lines.join("");
  assert.equal(text.match(/isn't vLLM's official image/g)?.length, 1);
  assert.match(text, /ghcr\.io\/someone\/vllm isn't vLLM's official image \(vllm\/vllm-openai\); using it as given\./);
  assert.match(text, /CUDA: this image's requirement is unknown; the driver check is skipped \(the catalog image needs 13\.0\)/);
});
