import assert from "node:assert/strict";
import { test } from "node:test";
import { modelCommand, type ModelCommandOptions } from "./model-command.js";
import type { Prompter } from "./prompt.js";
import { readDeployments, readModelState } from "./state.js";
import { fixtureSystem } from "./test-support/gpu-fixtures.js";
import { PlainUi } from "./ui.js";

function machine() {
  const system = fixtureSystem("rtx-pro-6000-4x-pcie");
  const lines: string[] = [];
  const prompter: Prompter = { choose: async () => "", select: async (_q, choices) => ({ value: choices[0]!.value }), secret: async () => "", text: async () => "" };
  const base: ModelCommandOptions = { system, ui: new PlainUi((line) => lines.push(line)), prompter, interactive: false,
    statePath: "/tmp/model.json", configPath: "/tmp/autopilot/config.json",
    // No network: the Hugging Face size lookup fails, so the preflight uses the catalog's size.
    fetch: async () => new Response("offline", { status: 503 }),
    smoke: async () => ({ chat: true, tools: true, json: true, tokensPerSecond: 20, at: "now" }),
    bench: async () => ({ levels: [{ concurrency: 1, requests: 1, ttftP50: 0.1, ttftP95: 0.1, decodeTokPerSec: 20 }] }) };
  const run = (action: string, args: string[], extra: Partial<ModelCommandOptions> = {}) => modelCommand(action, args, { ...base, ...extra });
  const runOf = (container: string) => system.modelCommands.find((command) => command.startsWith("run ") && command.includes(`--name ${container} `))!;
  return { system, lines, run, runOf };
}

test("two named deployments, each pinned to its own GPUs: separate containers, ports, GPUs and state", async () => {
  const { system, lines, run, runOf } = machine();
  assert.equal(await run("up", ["qwen-new"], { name: "team-a", gpus: "0,1" }), 0);
  assert.equal(await run("up", ["qwen-old"], { name: "team-b", gpus: "2,3" }), 0);
  const a = runOf("dl-model-team-a-1");
  const b = runOf("dl-model-team-b-1");
  // A single-GPU model on a pinned pair runs on the first; the container sees both, and only those.
  assert.match(a, /--gpus "device=0,1" --ipc=host -p 127\.0\.0\.1:8000:8000/);
  assert.match(b, /--gpus "device=2,3" --ipc=host -p 127\.0\.0\.1:8002:8000/, "8001 stays free for team-a's updates");
  const deployments = await readDeployments(system, "/tmp/model.json");
  assert.deepEqual(Object.keys(deployments).sort(), ["team-a", "team-b"]);
  assert.deepEqual([deployments["team-a"]!.active.devices, deployments["team-b"]!.active.devices], [[0, 1], [2, 3]]);
  assert.equal(JSON.parse(system.files.get("/tmp/model.json")!.content).version, 2);
  lines.length = 0;
  assert.equal(await run("list", []), 0);
  assert.equal(lines.join(""), [
    "ok team-a: qwen-new · vLLM · GPUs 0,1 · port 8000 · running\n",
    "ok team-b: qwen-old · vLLM · GPUs 2,3 · port 8002 · running\n",
  ].join(""));
});

test("a deployment can't take another's GPU or port", async () => {
  const { run } = machine();
  await run("up", ["qwen-new"], { name: "team-a", gpus: "0" });
  await assert.rejects(run("up", ["qwen-old"], { name: "team-b", gpus: "0,1" }), /GPU 0 is already used by deployment team-a/);
  await assert.rejects(run("up", ["qwen-old"], { name: "team-b", gpus: "1", port: "8000" }), /Port 8000 belongs to deployment team-a/);
  await assert.rejects(run("up", ["qwen-old"], { name: "team-b", gpus: "7" }), /No GPU 7 on this machine; it has 0, 1, 2, 3/);
  await assert.rejects(run("up", ["qwen-old"], { name: "Team B" }), /Deployment name "Team B" must be/);
});

test("update, rollback, status and bench target one deployment by name and leave the other alone", async () => {
  const { system, lines, run, runOf } = machine();
  await run("up", ["qwen-old"], { name: "team-a", gpus: "0" });
  await run("up", ["qwen-old"], { name: "team-b", gpus: "1" });
  assert.equal(await run("update", ["qwen-new"], { name: "team-a" }), 0);
  assert.match(runOf("dl-model-team-a-2"), /--gpus device=0 .*127\.0\.0\.1:8001:8000/, "the update keeps team-a's GPU, beside the old one");
  assert.ok(system.running.has("dl-model-team-b-1"));
  assert.ok(!system.running.has("dl-model-team-a-1"));
  assert.match(lines.join(""), /side-by-side/);
  lines.length = 0;
  assert.equal(await run("status", [], { name: "team-a" }), 0);
  assert.match(lines.join(""), /Model: Qwen\/Qwen3-4B-Instruct-2507[\s\S]*GPUs: 0\n[\s\S]*Previous: qwen-old · dl model rollback --name team-a/);
  assert.equal(await run("rollback", [], { name: "team-a" }), 0);
  const deployments = await readDeployments(system, "/tmp/model.json");
  assert.equal(deployments["team-a"]!.active.id, "qwen-old");
  assert.equal(deployments["team-b"]!.active.id, "qwen-old");
  assert.equal(deployments["team-b"]!.previous, undefined);
  await assert.rejects(run("rollback", [], { name: "team-c" }), /No deployment named team-c/);
});

test("the unnamed deployment keeps 0.30.1's state file until a named one is added", async () => {
  const { system, run } = machine();
  await run("up", ["qwen-new"], {});
  assert.equal(JSON.parse(system.files.get("/tmp/model.json")!.content).version, 1);
  await run("up", ["qwen-old"], { name: "side", gpus: "3" });
  assert.equal(JSON.parse(system.files.get("/tmp/model.json")!.content).version, 2);
  assert.equal((await readModelState(system, "/tmp/model.json"))?.active.id, "qwen-new", "the first-run setup still finds the default one");
});

test("a multi-GPU model with CPU offload is pinned, limited in host RAM, and its GPUs hidden from the other", async () => {
  const { run, runOf, system } = machine();
  assert.equal(await run("up", ["deepseek-v4.1-flash-fp8"], { name: "big", gpus: "0,1,2,3", port: "8100" }), 0);
  const big = runOf("dl-model-big-1");
  // Engram 203,073,076,240 B = 189.1 GiB, plus 8 GiB for each of 4 GPU workers = 221.1 GiB -> 222g.
  assert.match(big, /--gpus "device=0,1,2,3" --ipc=host --memory 222g --memory-swap 222g -p 127\.0\.0\.1:8100:8000/);
  assert.match(big, /--tensor-parallel-size 4$/);
  assert.equal((await readDeployments(system, "/tmp/model.json")).big!.active.memoryBytes, 203_073_076_240 + 4 * 8 * 1024 ** 3);
});
