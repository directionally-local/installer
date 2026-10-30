import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseConnectState } from "../provider.js";
import { ConnectCancelled, runAutopilotConnect, type ConnectSpawner } from "./connect.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "dl-connect-test-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const AUTOPILOT = { command: "/usr/local/bin/node", args: ["/opt/dl/node_modules/autopilot-ai/bin/autopilot.mjs"] };

const DEEPSEEK = { provider: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKey: "sk-deepseek-0000", apiKeyEnv: "DEEPSEEK_API_KEY", keyRequired: true, model: "deepseek-v4-pro", authHeader: "authorization", authFormat: "Bearer {key}" };
const OLLAMA = { provider: "ollama", name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", apiKey: null, apiKeyEnv: null, keyRequired: false, model: "qwen3:32b", authHeader: "authorization", authFormat: "Bearer {key}" };

/** A stand-in for `autopilot connect`: records how it was started, writes the state file, exits with `code`. */
function fakeConnect(state: unknown, code = 0) {
  const launches: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv; dirMode?: number; fileMode?: number }> = [];
  const spawn: ConnectSpawner = async (command, args, env) => {
    const launch: (typeof launches)[number] = { command, args, env };
    launches.push(launch);
    const file = args[args.indexOf("--state-file") + 1]!;
    launch.dirMode = (await stat(dirname(file))).mode & 0o777;
    if (code === 0) {
      await writeFile(file, JSON.stringify(state), { mode: 0o600 });
      launch.fileMode = (await stat(file)).mode & 0o777;
    }
    return code;
  };
  return { spawn, launches };
}

describe("autopilot connect from dl", () => {
  it("runs Autopilot's picker with the user's own environment and reads what it chose from a private file, then deletes it", async () => {
    const fake = fakeConnect(DEEPSEEK);
    const result = await runAutopilotConnect({}, { autopilot: async () => AUTOPILOT, spawn: fake.spawn, env: { HOME: "/Users/me", PATH: "/usr/bin" }, tmp: root });
    assert.deepEqual(result, DEEPSEEK);
    const launch = fake.launches[0]!;
    assert.equal(launch.command, AUTOPILOT.command);
    assert.deepEqual(launch.args.slice(0, 2), [AUTOPILOT.args[0], "connect"]);
    assert.equal(launch.args[2], "--state-file");
    assert.ok(launch.args[3]!.startsWith(join(root, "dl-connect-")), "a fresh private directory");
    assert.equal(launch.args.includes("--model-only"), false);
    assert.equal(launch.env.HOME, "/Users/me", "the user's normal HOME: their own autopilot is configured too");
    assert.equal(launch.dirMode, 0o700);
    assert.equal(launch.fileMode, 0o600);
    assert.equal(existsSync(launch.args[3]!), false, "the file, with the key in it, is gone");
    assert.deepEqual(await readdir(root), [], "and so is its directory");
  });

  it("asks only for the model with --model-only", async () => {
    const fake = fakeConnect({ ...DEEPSEEK, model: "deepseek-v4-flash" });
    const result = await runAutopilotConnect({ modelOnly: true }, { autopilot: async () => AUTOPILOT, spawn: fake.spawn, tmp: root });
    assert.equal(result.model, "deepseek-v4-flash");
    assert.ok(fake.launches[0]!.args.includes("--model-only"));
  });

  it("takes a keyless provider as is", async () => {
    const fake = fakeConnect(OLLAMA);
    const result = await runAutopilotConnect({}, { autopilot: async () => AUTOPILOT, spawn: fake.spawn, tmp: root });
    assert.deepEqual(result, OLLAMA);
  });

  it("reports a cancel (exit 1) as such, an Autopilot without connect (exit 2) as too old, and cleans up either way", async () => {
    const cancelled = fakeConnect(DEEPSEEK, 1);
    await assert.rejects(() => runAutopilotConnect({}, { autopilot: async () => AUTOPILOT, spawn: cancelled.spawn, tmp: root }), ConnectCancelled);
    const old = fakeConnect(DEEPSEEK, 2);
    await assert.rejects(() => runAutopilotConnect({}, { autopilot: async () => AUTOPILOT, spawn: old.spawn, tmp: root }), /too old to pick a provider[\s\S]*npm install -g directionallylocal/);
    await assert.rejects(() => runAutopilotConnect({}, { autopilot: async () => undefined, spawn: old.spawn, tmp: root }), /isn't installed/);
    assert.deepEqual(await readdir(root), []);
  });

  it("checks the state file: a missing key for a provider that needs one, an odd provider id, a keyless one", () => {
    assert.deepEqual(parseConnectState(JSON.stringify(DEEPSEEK)), DEEPSEEK);
    assert.deepEqual(parseConnectState(JSON.stringify(OLLAMA)), OLLAMA);
    assert.deepEqual(parseConnectState(JSON.stringify({ provider: "ollama", model: "qwen3:32b", apiKey: null })).keyRequired, false, "known keyless providers need no keyRequired");
    assert.throws(() => parseConnectState(JSON.stringify({ ...DEEPSEEK, apiKey: null })), /no key for deepseek/);
    assert.throws(() => parseConnectState(JSON.stringify({ ...DEEPSEEK, model: "" })), /lacks "model"/);
    assert.throws(() => parseConnectState(JSON.stringify({ ...DEEPSEEK, provider: "Deep Seek!" })), /can't use/);
    assert.throws(() => parseConnectState("{nope"), (error: Error) => !error.message.includes("nope"));
    // A custom provider: dl knows only what Autopilot wrote.
    const custom = parseConnectState(JSON.stringify({ provider: "myproxy", name: "My proxy", baseUrl: "https://llm.example.com/v1", apiKey: "k", apiKeyEnv: "MYPROXY_API_KEY", keyRequired: true, model: "m", authHeader: "x-api-key", authFormat: "{key}" }));
    assert.equal(custom.authHeader, "x-api-key");
  });
});
