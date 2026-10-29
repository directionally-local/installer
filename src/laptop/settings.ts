import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fetchModelPrices, type ModelPriceTable } from "../model-prices.js";
import { PromptCancelled, TtyPrompter, type Prompter, type SelectOption } from "../prompt.js";
import { palette, PlainUi, TerminalUi, type Ui } from "../ui.js";
import type { LaptopIO } from "./commands.js";
import { autopilotConfigPath } from "./credentials.js";

/**
 * dl's own settings on this laptop (~/.config/directionallylocal/config.json). Today only
 * the model tasks and sessions use when none is named with -m. It's dl's, so people who
 * never installed Autopilot can set it; Autopilot's own default is still honoured when
 * dl has none.
 */

/** What tasks and sessions use when neither -m, dl model nor Autopilot names a model. */
export const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash-1017";

export interface Settings {
  model?: string;
  /** Setup asked once whether this computer should be the default place; it doesn't ask again. */
  askedLocalDefault?: boolean;
}

/** The suggestions setup and `dl model` offer first; any OpenRouter ID works too. */
export const SUGGESTED_MODELS: Array<{ id: string; note: string }> = [
  { id: "deepseek/deepseek-v4.1-flash-1017", note: "fast and cheap" },
  { id: "moonshotai/kimi-k2.6", note: "strong at agentic coding" },
  { id: "anthropic/claude-sonnet-5.5", note: "stronger, pricier" },
  { id: "openai/gpt-6.1-sol", note: "stronger, pricier" },
];

export const OPENROUTER_ID_EXAMPLE = "provider/model, e.g. z-ai/glm-5";

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(configHome, "directionallylocal", "config.json");
}

export async function loadSettings(path = settingsPath()): Promise<Settings> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as { model?: unknown; askedLocalDefault?: unknown };
    return {
      ...(typeof parsed.model === "string" && parsed.model.trim() ? { model: parsed.model.trim() } : {}),
      ...(parsed.askedLocalDefault === true ? { askedLocalDefault: true } : {}),
    };
  } catch {
    // A damaged file only loses the saved model; the next save rewrites it.
    return {};
  }
}

export async function saveModel(model: string, path = settingsPath()): Promise<void> {
  await saveSettings({ model }, path);
}

/** Merges into dl's settings, keeping what's already there. */
export async function saveSettings(changes: Settings, path = settingsPath()): Promise<void> {
  const settings = { ...(await loadSettings(path)), ...changes };
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify({ version: 1, ...settings }, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

/** The model to use when none is named: dl's setting, else Autopilot's default, with where it came from. */
export async function preferredModel(autopilotModel: () => Promise<string | undefined>, path?: string): Promise<{ model: string; source: "dl" | "autopilot" } | undefined> {
  const { model } = await loadSettings(path);
  if (model) return { model, source: "dl" };
  const fromAutopilot = await autopilotModel();
  return fromAutopilot ? { model: fromAutopilot, source: "autopilot" } : undefined;
}

/** This laptop's default model: the one set with `dl model`, else Autopilot's. */
export async function laptopModel(): Promise<string | undefined> {
  return (await preferredModel(() => readAutopilotModel()))?.model;
}

/**
 * The laptop's Autopilot default model: KIMI_MODEL (Autopilot's own override) or the
 * `model` in its config. undefined when neither is set or the config can't be read.
 */
export async function readAutopilotModel(sources: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  readFile?: (path: string) => Promise<string | undefined>;
} = {}): Promise<string | undefined> {
  const env = sources.env ?? process.env;
  const fromEnv = env.KIMI_MODEL?.trim();
  if (fromEnv) return fromEnv;
  const read = sources.readFile ?? ((path: string) => readFile(path, "utf8").catch(() => undefined));
  const raw = await read(autopilotConfigPath(env, sources.home ?? homedir()));
  if (!raw) return undefined;
  try {
    const model = (JSON.parse(raw) as { model?: unknown }).model;
    return typeof model === "string" && model.trim() ? model.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** OpenRouter's prices, or undefined when they can't be fetched: the list then just has no prices. */
export async function modelPrices(fetchImpl: typeof fetch = fetch): Promise<ModelPriceTable | undefined> {
  return fetchModelPrices(fetchImpl).then(({ table }) => table, () => undefined);
}

/**
 * The picker's options: the suggestions (with prices when known, and the current model
 * added if it isn't one), then "Another model", which takes a typed ID.
 */
export function modelOptions(current: string | undefined, prices: ModelPriceTable | undefined, anotherPrompt: string): SelectOption[] {
  const known = prices ? SUGGESTED_MODELS.filter((entry) => entry.id.toLowerCase() in prices) : SUGGESTED_MODELS;
  const entries = current && !known.some((entry) => entry.id === current) ? [{ id: current, note: "your current model" }, ...known] : known;
  return [
    ...entries.map((entry) => ({ value: entry.id, label: entry.id, detail: [entry.note, priceLabel(prices?.[entry.id.toLowerCase()])].filter(Boolean).join(" · ") })),
    { value: "another", label: "Another model", detail: "any OpenRouter model ID", input: { prompt: anotherPrompt, placeholder: OPENROUTER_ID_EXAMPLE } },
  ];
}

function priceLabel(price: { inputPerMTok: number; outputPerMTok: number } | undefined): string {
  if (!price) return "";
  if (price.inputPerMTok === 0 && price.outputPerMTok === 0) return "free";
  return `$${price.inputPerMTok} in / $${price.outputPerMTok} out per M tokens`;
}

/** A typed model ID, or why it isn't one. Checked against OpenRouter's catalog when it's known. */
export function checkModelId(text: string, prices: ModelPriceTable | undefined): { ok: true; model: string } | { ok: false; message: string } {
  const model = text.trim();
  if (!/^[a-z0-9][\w.-]*\/[\w.:-]+$/i.test(model)) return { ok: false, message: `"${model}" isn't an OpenRouter model ID (${OPENROUTER_ID_EXAMPLE})` };
  if (prices && !(model.toLowerCase() in prices)) return { ok: false, message: `OpenRouter has no model ${model} (see https://openrouter.ai/models)` };
  return { ok: true, model };
}

/** The arrow-key list of models, with `current` preselected; a typed ID gets 3 tries. */
export async function askModel(prompter: Prompter, ui: Ui, current: string, prices: ModelPriceTable | undefined): Promise<string> {
  const options = modelOptions(current, prices, ui.prompt("Model ID", OPENROUTER_ID_EXAMPLE));
  const initial = Math.max(0, options.findIndex((option) => option.value === current));
  for (let attempt = 1; ; attempt++) {
    const picked = await prompter.select(ui.prompt("Model", "used for tasks and sessions"), options, initial);
    if (picked.value !== "another") return picked.value;
    const checked = checkModelId(picked.text ?? "", prices);
    if (checked.ok) return checked.model;
    if (attempt >= 3) throw new Error(checked.message);
    ui.rejected(`${checked.message}. Try again.`);
  }
}

export interface ModelCommandDeps {
  newUi: () => Ui;
  prompter: Prompter;
  write: (text: string) => void;
  color: boolean;
  /** Whether there's a terminal to show the list on. */
  interactive: boolean;
  fetch: typeof fetch;
  autopilotModel: () => Promise<string | undefined>;
  settingsFile?: string;
}

/**
 * `dl model [ID]`: the model `dl run` and new sessions use when -m doesn't name one. With an
 * ID, sets it; without, picks from a list on a terminal, or says which it is otherwise.
 */
export async function modelCommand(args: string[], deps: ModelCommandDeps): Promise<number> {
  const c = palette(deps.color);
  const current = await preferredModel(deps.autopilotModel, deps.settingsFile);
  const model = current?.model ?? DEFAULT_MODEL;
  const from = current?.source === "dl" ? "set with dl model" : current?.source === "autopilot" ? "Autopilot's default" : "dl's default";
  if (args.length > 1) {
    deps.write(`\n  ${c.red("✗")} dl model takes one model ID, e.g. dl model ${DEFAULT_MODEL}\n\n`);
    return 2;
  }
  if (args.length === 0 && !deps.interactive) {
    deps.write(`\n  ${c.bold("Model")}  ${model}  ${c.dim(`(${from})`)}\n  ${c.dim("Change it:")} dl model <id>  ${c.dim("(model IDs: https://openrouter.ai/models)")}\n\n`);
    return 0;
  }
  const prices = await modelPrices(deps.fetch);
  let chosen: string;
  if (args[0] !== undefined) {
    const checked = checkModelId(args[0], prices);
    if (!checked.ok) {
      deps.write(`\n  ${c.red("✗")} ${checked.message}\n\n`);
      return 1;
    }
    chosen = checked.model;
  } else {
    const ui = deps.newUi();
    deps.write("\n");
    try {
      chosen = await askModel(deps.prompter, ui, model, prices);
    } catch (error) {
      if (!(error instanceof PromptCancelled)) throw error;
      deps.write(`  ${c.dim(`Unchanged: ${model}`)}\n\n`);
      return 130;
    }
    ui.finish();
  }
  await saveModel(chosen, deps.settingsFile);
  deps.write(`\n  ${c.green("✓")} ${c.bold("Model")}  ${chosen}\n  ${c.dim("Used by dl run and new sessions. A running session keeps its model; switch it there with")} /model\n\n`);
  return 0;
}

/** `dl model` with the real terminal and network. */
export async function model(args: string[], options: { io: LaptopIO; terminal: boolean }): Promise<number> {
  const { io, terminal } = options;
  const color = io.color === true;
  return modelCommand(args, {
    newUi: () => terminal ? new TerminalUi(io.out, undefined, color) : new PlainUi(io.out),
    prompter: new TtyPrompter({ color }),
    write: io.out,
    color,
    interactive: terminal,
    fetch: globalThis.fetch,
    autopilotModel: () => readAutopilotModel(),
  });
}
