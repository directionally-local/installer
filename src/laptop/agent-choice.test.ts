import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ScriptedPrompter } from "../prompt.js";
import { agentChoicePath, agentCommand, agentOptions, readAgentChoice, saveAgentChoice } from "./agent-choice.js";
import type { AgentId, LocalModel } from "./local-agents.js";

const MODEL: LocalModel = { name: "default", model: "Qwen/Qwen3-4B", baseUrl: "http://127.0.0.1:8000/v1", context: 32768, output: 8192, engine: "vllm", image: "vllm/vllm-openai:v0.20.0" };
const ALL: Record<AgentId, boolean> = { autopilot: true, "claude-code": true, opencode: true, pi: true };

describe("the box's coding agent", () => {
  let dir: string;
  let path: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "dl-agent-choice-")); path = join(dir, "state", "agent.json"); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  const io = () => { let out = ""; let err = ""; return { io: { out: (t: string) => { out += t; }, err: (t: string) => { err += t; } }, out: () => out, err: () => err }; };

  it("kept beside dl model's state, 0600; unset or unreadable is Autopilot (undefined)", async () => {
    assert.equal(agentChoicePath({ XDG_STATE_HOME: "/s" }), "/s/directionallylocal/agent.json");
    assert.equal(await readAgentChoice(path), undefined);
    await saveAgentChoice("opencode", path, () => new Date("2026-11-19T00:00:00Z"));
    assert.equal(await readAgentChoice(path), "opencode");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 1, agent: "opencode", at: "2026-11-19T00:00:00.000Z" });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });

  it("the menu: Autopilot recommended first; install first, and not with this model", () => {
    const options = agentOptions({ ...MODEL, context: 8192 }, { ...ALL, pi: false });
    assert.deepEqual(options.map((o) => [o.value, o.label]), [
      ["autopilot", "Autopilot (recommended)"],
      ["claude-code", "Claude Code (not with this model)"],
      ["opencode", "OpenCode"],
      ["pi", "Pi (install first)"],
    ]);
    assert.match(options[1]!.detail!, /needs a 32k context/);
  });

  it("dl agent set NAME saves it; a bad name is a usage error", async () => {
    const out = io();
    assert.equal(await agentCommand(["set", "claude"], { io: out.io, interactive: false, model: async () => MODEL, installed: async () => ALL, path }), 0);
    assert.equal(await readAgentChoice(path), "claude-code");
    assert.match(out.out(), /Plain dl opens Claude Code from now on, on this box's model \(Qwen\/Qwen3-4B\)/);
    const bad = io();
    assert.equal(await agentCommand(["set", "codex"], { io: bad.io, interactive: false, model: async () => MODEL, installed: async () => ALL, path }), 2);
    assert.match(bad.err(), /autopilot, claude-code, opencode, pi/);
    assert.equal(await readAgentChoice(path), "claude-code");
  });

  it("dl agent set for a CLI that isn't installed saves it and prints the install command", async () => {
    const out = io();
    assert.equal(await agentCommand(["set", "pi"], { io: out.io, interactive: false, model: async () => MODEL, installed: async () => ({ ...ALL, pi: false }), path }), 0);
    assert.equal(await readAgentChoice(path), "pi");
    assert.match(out.out(), /curl -fsSL https:\/\/pi\.dev\/install\.sh \| sh/);
  });

  it("an agent that can't work on the model isn't saved", async () => {
    const out = io();
    assert.equal(await agentCommand(["set", "claude-code"], { io: out.io, interactive: false, model: async () => ({ ...MODEL, context: 8192 }), installed: async () => ALL, path }), 1);
    assert.equal(await readAgentChoice(path), undefined);
  });

  it("dl agent: says which, and on a terminal asks with the current one selected", async () => {
    await saveAgentChoice("opencode", path);
    const plain = io();
    assert.equal(await agentCommand([], { io: plain.io, interactive: false, model: async () => MODEL, installed: async () => ALL, path }), 0);
    assert.match(plain.out(), /Plain dl opens OpenCode on Qwen\/Qwen3-4B/);
    const prompter = new ScriptedPrompter({ "Which coding agent?": "autopilot" });
    const asked = io();
    assert.equal(await agentCommand([], { io: asked.io, interactive: true, prompter, model: async () => MODEL, installed: async () => ALL, path }), 0);
    assert.equal(await readAgentChoice(path), "autopilot");
  });
});
