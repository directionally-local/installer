import assert from "node:assert/strict";
import { test } from "node:test";
import { modelCommand } from "./model-command.js";
import type { Prompter } from "./prompt.js";
import type { RunOptions, RunResult } from "./system.js";
import { fixtureSystem, readFixture } from "./test-support/gpu-fixtures.js";
import { PlainUi } from "./ui.js";

/**
 * What 0.30.1 printed, ran and wrote for `dl model up qwen-new` on one RTX PRO 5000 (48 GB),
 * captured from that release's code against the same fixture. Multi-GPU support must leave the
 * single-GPU path byte for byte as it was.
 */
const GOLDEN = JSON.parse(readFixture("rtx-pro-5000-1x", "golden-0.30.1.json")) as {
  dryRun: { output: string; docker: string[] };
  real: { output: string; docker: string[]; state: string; config: string };
};

async function upQwenNew(dryRun: boolean) {
  const system = fixtureSystem("rtx-pro-5000-1x");
  const docker: string[] = [];
  if (dryRun) {
    Object.defineProperty(system, "dryRun", { value: true });
    system.run = async (command: string, args: string[], _options?: RunOptions): Promise<RunResult> => {
      docker.push([command, ...args].join(" "));
      return { code: 0, stdout: "", stderr: "" };
    };
  }
  const lines: string[] = [];
  const prompter: Prompter = { choose: async () => "", select: async () => ({ value: "" }), secret: async () => "", text: async () => "" };
  await modelCommand("up", ["qwen-new"], { system, ui: new PlainUi((line) => lines.push(line)), prompter, interactive: false,
    statePath: "/tmp/x/model.json", configPath: "/tmp/x/c.json",
    smoke: async () => ({ chat: true, tools: true, json: true, tokensPerSecond: 42, at: "2026-11-13T00:00:00.000Z" }) });
  return { output: lines.join(""), docker: dryRun ? docker : system.modelCommands.map((command) => `docker ${command}`), system };
}

test("1x RTX PRO 5000 + qwen-new: the dry run prints and plans exactly what 0.30.1 did", async () => {
  const run = await upQwenNew(true);
  assert.equal(run.output, GOLDEN.dryRun.output);
  assert.deepEqual(run.docker, GOLDEN.dryRun.docker);
});

test("1x RTX PRO 5000 + qwen-new: up runs the same docker command and writes the same state and provider", async () => {
  const run = await upQwenNew(false);
  assert.equal(run.output, GOLDEN.real.output);
  assert.deepEqual(run.docker, GOLDEN.real.docker);
  assert.equal(run.system.files.get("/tmp/x/model.json")?.content, GOLDEN.real.state);
  assert.equal(run.system.files.get("/tmp/x/c.json")?.content, GOLDEN.real.config);
});
