import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ConnectResult } from "../provider.js";
import { ConnectCancelled } from "./connect.js";
import { saveRemote, type RemoteServer } from "./config.js";
import { DEFAULT_MODEL, loadSettings, modelCommand, preferredModel, saveModel, type ModelCommandDeps } from "./settings.js";

let root: string;
const previous = process.env.AUTOPILOT_REMOTES_FILE;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dl-settings-"));
  process.env.AUTOPILOT_REMOTES_FILE = join(root, "remotes.json");
});

afterEach(async () => {
  if (previous === undefined) delete process.env.AUTOPILOT_REMOTES_FILE;
  else process.env.AUTOPILOT_REMOTES_FILE = previous;
  await rm(root, { recursive: true, force: true });
});

const CHOSEN: ConnectResult = { provider: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKey: "sk-x", apiKeyEnv: "DEEPSEEK_API_KEY", keyRequired: true, model: "deepseek-v4-pro" };

function place(name: string): RemoteServer {
  return { name, url: "http://127.0.0.1:4096", token: "t", credentialId: "c", expiresAt: "2027-01-01T00:00:00.000Z", addedAt: "2026-10-28T00:00:00.000Z" };
}

function command(overrides: Partial<ModelCommandDeps> = {}) {
  let text = "";
  const connected: Array<{ modelOnly: true }> = [];
  const deps: ModelCommandDeps = {
    write: (chunk) => { text += chunk; },
    color: false,
    interactive: true,
    connect: async (options) => { connected.push(options); return CHOSEN; },
    autopilotModel: async () => undefined,
    settingsFile: join(root, "config.json"),
    ...overrides,
  };
  return { deps, connected, text: () => text };
}

describe("dl's model setting", () => {
  it("saves each place's model privately and reads it back; a damaged file reads as unset", async () => {
    const file = join(root, "config.json");
    await saveModel("deepseek-v4-pro", file, "box");
    await saveModel("kimi-k2.6", file, "this-computer");
    assert.deepEqual(await loadSettings(file), { model: "kimi-k2.6", placeModels: { box: "deepseek-v4-pro", "this-computer": "kimi-k2.6" } });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { version: 1, model: "kimi-k2.6", placeModels: { box: "deepseek-v4-pro", "this-computer": "kimi-k2.6" } });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await writeFile(file, "{not json");
    assert.deepEqual(await loadSettings(file), {});
  });

  it("prefers the place's model, then the last one chosen, then Autopilot's", async () => {
    const file = join(root, "config.json");
    assert.deepEqual(await preferredModel(async () => "openai/gpt-6-luna", file, "box"), { model: "openai/gpt-6-luna", source: "autopilot" });
    await saveModel("kimi-k2.6", file, "this-computer");
    assert.deepEqual(await preferredModel(async () => "openai/gpt-6-luna", file, "box"), { model: "kimi-k2.6", source: "dl" }, "the last choice, for a place without its own");
    await saveModel("deepseek-v4-pro", file, "box");
    assert.deepEqual(await preferredModel(async () => undefined, file, "box"), { model: "deepseek-v4-pro", source: "dl" });
    assert.deepEqual(await preferredModel(async () => undefined, file, "this-computer"), { model: "kimi-k2.6", source: "dl" });
    assert.equal(await preferredModel(async () => undefined, join(root, "none.json")), undefined);
  });
});

describe("dl model", () => {
  it("says which model it is, and where that comes from, without a terminal", async () => {
    await saveRemote(place("box"));
    const run = command({ interactive: false, autopilotModel: async () => "openai/gpt-6-luna" });
    assert.equal(await modelCommand([], run.deps), 0);
    assert.match(run.text(), /Model on box {2}openai\/gpt-6-luna {2}\(Autopilot's default\)\n {2}Change it: dl model <id>/);
    assert.deepEqual(run.connected, [], "no picker without a terminal");
    const unset = command({ interactive: false });
    assert.equal(await modelCommand([], unset.deps), 0);
    assert.match(unset.text(), new RegExp(`${DEFAULT_MODEL.replace(/[./]/g, "\\$&")} {2}\\(dl's default\\)`));
  });

  it("sets a model by ID for the place, as given", async () => {
    await saveRemote(place("box"));
    const file = join(root, "config.json");
    const run = command();
    assert.equal(await modelCommand(["deepseek-v4-flash"], run.deps), 0);
    assert.deepEqual(await loadSettings(file), { model: "deepseek-v4-flash", placeModels: { box: "deepseek-v4-flash" } });
    assert.match(run.text(), /✓ Model on box {2}deepseek-v4-flash\n/);
    assert.deepEqual(run.connected, []);
    assert.equal(await modelCommand(["a/b", "c/d"], command({}).deps), 2);
    assert.equal(await modelCommand(["not a model"], command({}).deps), 1);
    assert.equal((await loadSettings(file)).placeModels?.box, "deepseek-v4-flash", "unchanged");
  });

  it("runs Autopilot's own model picker on a terminal and keeps what it chose for the place", async () => {
    await saveRemote(place("box"));
    await saveRemote(place("other"));
    const run = command({ server: "other" });
    assert.equal(await modelCommand([], run.deps), 0);
    assert.deepEqual(run.connected, [{ modelOnly: true }], "only the model: the provider stays");
    assert.deepEqual((await loadSettings(join(root, "config.json"))).placeModels, { other: "deepseek-v4-pro" });
    assert.match(run.text(), /✓ Model on other {2}deepseek-v4-pro\n {2}Used by dl run and new sessions/);
  });

  it("leaves the model alone when the picker is cancelled", async () => {
    await saveRemote(place("box"));
    await saveModel("kimi-k2.6", join(root, "config.json"), "box");
    const run = command({ connect: async () => { throw new ConnectCancelled(); } });
    assert.equal(await modelCommand([], run.deps), 130);
    assert.match(run.text(), /Unchanged: kimi-k2\.6/);
    assert.equal((await loadSettings(join(root, "config.json"))).placeModels?.box, "kimi-k2.6");
  });

  it("works before any place is set up: the choice applies to the first one", async () => {
    const run = command();
    assert.equal(await modelCommand([], run.deps), 0);
    assert.deepEqual(await loadSettings(join(root, "config.json")), { model: "deepseek-v4-pro" });
    assert.match(run.text(), /✓ Model {2}deepseek-v4-pro/);
  });
});
