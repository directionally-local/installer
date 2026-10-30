import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ConnectResult } from "../provider.js";
import { palette } from "../ui.js";
import type { LaptopIO } from "./commands.js";
import { ConnectCancelled, runAutopilotConnect } from "./connect.js";
import { resolveTarget } from "./config.js";
import { autopilotConfigPath } from "./credentials.js";

/**
 * dl's own settings on this laptop (~/.config/directionallylocal/config.json): the model
 * tasks and sessions use when none is named with -m, per place (each place has its own
 * provider, so its own model). Models are never picked here: `dl model` runs Autopilot's own
 * picker (`autopilot connect --model-only`) and keeps what it chose.
 */

/** The last resort when neither -m, a saved model, the place's default nor Autopilot names one; used only if the place offers it. */
export const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash-1017";

export interface Settings {
  /** The model last chosen, for places without one of their own. */
  model?: string;
  /** Each place's model, by its name in `dl servers`. */
  placeModels?: Record<string, string>;
  /** Setup asked once whether this computer should be the default place; it doesn't ask again. */
  askedLocalDefault?: boolean;
}

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
    const parsed = JSON.parse(raw) as { model?: unknown; placeModels?: unknown; askedLocalDefault?: unknown };
    const placeModels = typeof parsed.placeModels === "object" && parsed.placeModels !== null && !Array.isArray(parsed.placeModels)
      ? Object.fromEntries(Object.entries(parsed.placeModels as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== ""))
      : {};
    return {
      ...(typeof parsed.model === "string" && parsed.model.trim() ? { model: parsed.model.trim() } : {}),
      ...(Object.keys(placeModels).length > 0 ? { placeModels } : {}),
      ...(parsed.askedLocalDefault === true ? { askedLocalDefault: true } : {}),
    };
  } catch {
    // A damaged file only loses the saved model; the next save rewrites it.
    return {};
  }
}

/** Keeps the model as the place's (when named) and as the laptop's last choice. */
export async function saveModel(model: string, path = settingsPath(), place?: string): Promise<void> {
  const settings = await loadSettings(path);
  await saveSettings({ model, ...(place ? { placeModels: { ...settings.placeModels, [place]: model } } : {}) }, path);
}

/** Merges into dl's settings, keeping what's already there. */
export async function saveSettings(changes: Settings, path = settingsPath()): Promise<void> {
  const settings = { ...(await loadSettings(path)), ...changes };
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify({ version: 1, ...settings }, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

/** The model to use when none is named: the place's, else dl's last choice, else Autopilot's default, with where it came from. */
export async function preferredModel(autopilotModel: () => Promise<string | undefined>, path?: string, place?: string): Promise<{ model: string; source: "dl" | "autopilot" } | undefined> {
  const settings = await loadSettings(path);
  const model = (place ? settings.placeModels?.[place] : undefined) ?? settings.model;
  if (model) return { model, source: "dl" };
  const fromAutopilot = await autopilotModel();
  return fromAutopilot ? { model: fromAutopilot, source: "autopilot" } : undefined;
}

/** This laptop's default model for a place: the one set with `dl model`, else Autopilot's. */
export async function laptopModel(place?: string): Promise<string | undefined> {
  return (await preferredModel(() => readAutopilotModel(), undefined, place))?.model;
}

/**
 * The model saved for one place with `dl model`, and nothing else. A session asks for this
 * rather than laptopModel: Autopilot's own default is a laptop-wide choice that the place
 * may not serve, and a place with no model of its own should use the server's defaultModel.
 */
export async function placeModel(place: string, path?: string): Promise<string | undefined> {
  return (await loadSettings(path)).placeModels?.[place];
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

export interface ModelCommandDeps {
  write: (text: string) => void;
  color: boolean;
  /** Whether there's a terminal for Autopilot's picker. */
  interactive: boolean;
  /** Autopilot's model picker (`autopilot connect --model-only`); the real one unless replaced. */
  connect?: (options: { modelOnly: true }) => Promise<ConnectResult>;
  autopilotModel: () => Promise<string | undefined>;
  /** The place the model is for (`--server NAME`, else the default one). */
  server?: string;
  settingsFile?: string;
  remotesFile?: string;
}

/**
 * `dl model [ID]`: the model `dl run` and new sessions use on a place when -m doesn't name
 * one. With an ID, sets it; without, Autopilot's own picker on a terminal, or says which it is otherwise.
 */
export async function modelCommand(args: string[], deps: ModelCommandDeps): Promise<number> {
  const c = palette(deps.color);
  if (args.length > 1) {
    deps.write(`\n  ${c.red("✗")} dl model takes one model ID, e.g. dl model deepseek-v4-pro\n\n`);
    return 2;
  }
  let place: string | undefined;
  try {
    place = (await resolveTarget(deps.server, deps.remotesFile)).remote.name;
  } catch (error) {
    if (deps.server !== undefined) throw error;
    // No place yet: the model is kept as the laptop's default and applies to the first place set up.
  }
  const current = await preferredModel(deps.autopilotModel, deps.settingsFile, place);
  const from = current?.source === "dl" ? "set with dl model" : current?.source === "autopilot" ? "Autopilot's default" : "dl's default";
  const where = place ? ` ${c.dim(`on ${place}`)}` : "";
  if (args.length === 0 && !deps.interactive) {
    deps.write(`\n  ${c.bold("Model")}${where}  ${current?.model ?? DEFAULT_MODEL}  ${c.dim(`(${from})`)}\n  ${c.dim("Change it:")} dl model <id>  ${c.dim("(or dl model on a terminal, for the list)")}\n\n`);
    return 0;
  }
  let chosen: string;
  if (args[0] !== undefined) {
    chosen = args[0].trim();
    if (!chosen || /\s/.test(chosen)) {
      deps.write(`\n  ${c.red("✗")} "${args[0]}" isn't a model ID.\n\n`);
      return 1;
    }
  } else {
    try {
      chosen = (await (deps.connect ?? ((options) => runAutopilotConnect(options)))({ modelOnly: true })).model;
    } catch (error) {
      if (!(error instanceof ConnectCancelled)) throw error;
      deps.write(`  ${c.dim(`Unchanged: ${current?.model ?? DEFAULT_MODEL}`)}\n\n`);
      return 130;
    }
  }
  await saveModel(chosen, deps.settingsFile, place);
  deps.write(`\n  ${c.green("✓")} ${c.bold("Model")}${where}  ${chosen}\n  ${c.dim("Used by dl run and new sessions. A running session keeps its model; switch it there with")} /model\n\n`);
  return 0;
}

/** `dl model` with the real terminal and Autopilot. */
export async function model(args: string[], options: { io: LaptopIO; terminal: boolean; server?: string }): Promise<number> {
  const { io, terminal } = options;
  return modelCommand(args, {
    write: io.out,
    color: io.color === true,
    interactive: terminal,
    autopilotModel: () => readAutopilotModel(),
    ...(options.server ? { server: options.server } : {}),
  });
}
