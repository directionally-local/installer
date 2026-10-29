import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { PromptCancelled, ScriptedPrompter, type SelectOption, type SelectResult } from "../prompt.js";
import { RecordingUi } from "../ui.js";
import { withCatalog } from "../test-support/fake-catalog.js";
import { checkModelId, DEFAULT_MODEL, loadSettings, modelCommand, modelOptions, preferredModel, saveModel, type ModelCommandDeps } from "./settings.js";

let root: string;
let file: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dl-settings-"));
  file = join(root, "directionallylocal", "config.json");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
const PRICES = { "moonshotai/kimi-k2.6": { inputPerMTok: 0.6, outputPerMTok: 2.5 }, "z-ai/glm-5": { inputPerMTok: 0, outputPerMTok: 0 } };

class RecordingSelect extends ScriptedPrompter {
  readonly selects: Array<{ options: SelectOption[]; initial: number }> = [];
  override async select(question: string, options: SelectOption[], initial = 0): Promise<SelectResult> {
    this.selects.push({ options, initial });
    return super.select(question, options, initial);
  }
}

function command(answers: Record<string, string>, extra: Partial<ModelCommandDeps> = {}) {
  let text = "";
  const prompter = new RecordingSelect(answers);
  const deps: ModelCommandDeps = {
    newUi: () => new RecordingUi(),
    prompter,
    write: (chunk) => { text += chunk; },
    color: false,
    interactive: true,
    fetch: offline,
    autopilotModel: async () => undefined,
    settingsFile: file,
    ...extra,
  };
  return { deps, prompter, text: () => text };
}

describe("dl's model setting", () => {
  it("saves the model privately and reads it back; a damaged file reads as unset", async () => {
    assert.deepEqual(await loadSettings(file), {});
    await saveModel("moonshotai/kimi-k2.6", file);
    assert.deepEqual(await loadSettings(file), { model: "moonshotai/kimi-k2.6" });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { version: 1, model: "moonshotai/kimi-k2.6" });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await writeFile(file, "{not json");
    assert.deepEqual(await loadSettings(file), {});
  });

  it("prefers dl's setting, then Autopilot's default", async () => {
    assert.equal(await preferredModel(async () => undefined, file), undefined);
    assert.deepEqual(await preferredModel(async () => "openai/gpt-6-luna", file), { model: "openai/gpt-6-luna", source: "autopilot" });
    await saveModel("moonshotai/kimi-k2.6", file);
    assert.deepEqual(await preferredModel(async () => "openai/gpt-6-luna", file), { model: "moonshotai/kimi-k2.6", source: "dl" });
  });

  it("lists the suggestions with prices, keeps the current model in the list, and ends with a typed ID", () => {
    const options = modelOptions("z-ai/glm-5", PRICES, "Model ID");
    assert.deepEqual(options.map((option) => option.value), ["z-ai/glm-5", "moonshotai/kimi-k2.6", "another"], "suggestions OpenRouter doesn't list are left out");
    assert.equal(options[0]!.detail, "your current model · free");
    assert.equal(options[1]!.detail, "strong at agentic coding · $0.6 in / $2.5 out per M tokens");
    assert.equal(options.at(-1)!.input?.prompt, "Model ID");
    const unpriced = modelOptions(DEFAULT_MODEL, undefined, "Model ID");
    assert.equal(unpriced[0]!.value, DEFAULT_MODEL, "without prices, every suggestion stays, the default first");
    assert.equal(unpriced[0]!.detail, "fast and cheap");
  });

  it("checks a typed model ID, against OpenRouter's list when it has one", () => {
    assert.deepEqual(checkModelId(" z-ai/glm-5 ", PRICES), { ok: true, model: "z-ai/glm-5" });
    assert.deepEqual(checkModelId("someone/new-model", undefined), { ok: true, model: "someone/new-model" });
    assert.match((checkModelId("glm-5", undefined) as { message: string }).message, /isn't an OpenRouter model ID/);
    assert.match((checkModelId("someone/missing", PRICES) as { message: string }).message, /OpenRouter has no model someone\/missing/);
  });
});

describe("dl model", () => {
  it("says which model it is, and where that comes from, without a terminal", async () => {
    const run = command({}, { interactive: false, autopilotModel: async () => "openai/gpt-6-luna" });
    assert.equal(await modelCommand([], run.deps), 0);
    assert.match(run.text(), /Model {2}openai\/gpt-6-luna {2}\(Autopilot's default\)\n {2}Change it: dl model <id>/);
    const unset = command({}, { interactive: false });
    assert.equal(await modelCommand([], unset.deps), 0);
    assert.match(unset.text(), new RegExp(`Model {2}${DEFAULT_MODEL.replace(/[./]/g, "\\$&")} {2}\\(dl's default\\)`));
  });

  it("sets a model by ID, checked against OpenRouter", async () => {
    const online = withCatalog(offline);
    const run = command({}, { fetch: online });
    assert.equal(await modelCommand(["moonshotai/kimi-k2.6"], run.deps), 0);
    assert.equal((await loadSettings(file)).model, "moonshotai/kimi-k2.6");
    assert.match(run.text(), /✓ Model {2}moonshotai\/kimi-k2\.6\n {2}Used by dl run and new sessions/);
    const missing = command({}, { fetch: online });
    assert.equal(await modelCommand(["someone/missing"], missing.deps), 1);
    assert.match(missing.text(), /OpenRouter has no model someone\/missing/);
    assert.equal((await loadSettings(file)).model, "moonshotai/kimi-k2.6", "unchanged");
    assert.equal(await modelCommand(["a/b", "c/d"], command({}).deps), 2);
  });

  it("picks from the list on a terminal, with the current model preselected", async () => {
    await saveModel("moonshotai/kimi-k2.6", file);
    const run = command({ Model: "anthropic/claude-sonnet-5.5" });
    assert.equal(await modelCommand([], run.deps), 0);
    const shown = run.prompter.selects[0]!;
    assert.equal(shown.options[shown.initial]!.value, "moonshotai/kimi-k2.6");
    assert.equal((await loadSettings(file)).model, "anthropic/claude-sonnet-5.5");

    const typed = command({ "Model ID": "z-ai/glm-5", Model: "another" });
    assert.equal(await modelCommand([], typed.deps), 0);
    assert.equal((await loadSettings(file)).model, "z-ai/glm-5");
  });

  it("leaves the model alone when the list is cancelled", async () => {
    await saveModel("moonshotai/kimi-k2.6", file);
    const run = command({});
    run.deps.prompter.select = async () => { throw new PromptCancelled(); };
    assert.equal(await modelCommand([], run.deps), 130);
    assert.match(run.text(), /Unchanged: moonshotai\/kimi-k2\.6/);
    assert.equal((await loadSettings(file)).model, "moonshotai/kimi-k2.6");
  });
});
