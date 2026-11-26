import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PromptCancelled, type Prompter, type SelectOption } from "../prompt.js";
import { palette } from "../ui.js";
import { AGENT_CATALOG, AUTOPILOT_ID, findSpec, type AgentSpec, type DetectedAgent, type LaunchCommand } from "./agent-catalog.js";
import { agentRequest, DL_DEFAULT_MODEL, keyUrls, type AgentRequest, type DlKey } from "./dl-key.js";
import { oneLine } from "./printable.js";

/**
 * Bare `dl` on a laptop: a router for the person's own coding agent. dl signs in once (dl.new,
 * in the browser: dl-key.ts), finds the coding agents on this computer (agent-catalog.ts), and
 * asks which one to use; picking one sets it up on the dl key and, for a CLI dl knows, starts it.
 * dl remembers the choice: the next `dl` lists the same agents with the last one used on top,
 * already selected, so Enter opens it again. `dl claude` (and dl opencode, pi, t3, autopilot)
 * opens one directly and becomes the last used.
 *
 * Autopilot, dl's own agent, is a quiet last row ("downloads when picked"): it isn't installed
 * with dl, and is downloaded only when it's picked. With no agent found, dl asks which agent the
 * person uses (and tells the service, so we can add it), or offers to install Autopilot.
 */

type Env = Record<string, string | undefined>;

export interface RouterIO {
  out: (text: string) => void;
  err: (text: string) => void;
  color?: boolean;
}

/** What dl remembers about the agents opened through it. */
export interface AgentHistory {
  lastUsed?: string;
  /** Agent id → when it was last opened through dl (ISO time). */
  used: Record<string, string>;
}

export function agentHistoryPath(env: Env = process.env): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(env.HOME || homedir(), ".config");
  return join(configHome, "directionallylocal", "agents.json");
}

export async function readAgentHistory(path: string = agentHistoryPath()): Promise<AgentHistory> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { version?: unknown; lastUsed?: unknown; used?: unknown };
    if (value.version !== 1) return { used: {} };
    const used = Object.fromEntries(Object.entries(value.used && typeof value.used === "object" ? value.used as Record<string, unknown> : {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    return { ...(typeof value.lastUsed === "string" ? { lastUsed: value.lastUsed } : {}), used };
  } catch {
    return { used: {} };
  }
}

/** Marks `id` as the agent last opened through dl. */
export async function recordAgentUse(id: string, path: string = agentHistoryPath(), now: () => Date = () => new Date()): Promise<void> {
  const history = await readAgentHistory(path);
  const next = { version: 1, lastUsed: id, used: { ...history.used, [id]: now().toISOString() } };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

/** The ids of the found agents, most recently used first, then in catalog order. */
export function orderAgents(found: readonly DetectedAgent[], history: AgentHistory): DetectedAgent[] {
  const catalogIndex = (id: string) => {
    const index = AGENT_CATALOG.findIndex((spec) => spec.id === id);
    return index === -1 ? AGENT_CATALOG.length : index;
  };
  const rank = (agent: DetectedAgent) => agent.id === history.lastUsed ? Number.POSITIVE_INFINITY : Date.parse(history.used[agent.id] ?? "") || 0;
  return [...found].sort((a, b) => rank(b) - rank(a) || catalogIndex(a.id) - catalogIndex(b.id));
}

export const FIRST_QUESTION = "I found these on your computer. Which one do you want to use?";
export const AGAIN_QUESTION = "Which coding agent?";
export const NOTHING_FOUND = "No coding agent found.";
export const TYPE_NAME = "Type the name of the agent you use";
export const INSTALL_AUTOPILOT = "Install Autopilot — the agent we recommend. It's included in your plan.";
export const AUTOPILOT_ROW = "Autopilot — dl's own agent";
export const THANKS = "Thanks — we'll add support. Meanwhile here's your key and base URL to set it up yourself:";

/** The picker's rows: found agents (last used first, marked), then Autopilot (or Autopilot first, when it was last used). */
export function pickerOptions(found: readonly DetectedAgent[], history: AgentHistory, autopilotInstalled: boolean): SelectOption[] {
  const ordered = orderAgents(found, history);
  const rows: SelectOption[] = ordered.map((agent) => ({
    value: agent.id,
    label: agent.name,
    detail: describe(agent),
    ...(agent.id === history.lastUsed ? { accent: "last used" } : {}),
  }));
  const autopilot: SelectOption = history.lastUsed === AUTOPILOT_ID
    ? { value: AUTOPILOT_ID, label: AUTOPILOT_ROW, accent: "last used", detail: autopilotInstalled ? "" : "downloads when picked" }
    : { value: AUTOPILOT_ID, label: AUTOPILOT_ROW, quiet: true, detail: autopilotInstalled ? "" : "downloads when picked" };
  if (!autopilot.detail) delete autopilot.detail;
  return history.lastUsed === AUTOPILOT_ID ? [autopilot, ...rows] : [...rows, autopilot];
}

function describe(agent: DetectedAgent): string {
  const how = agent.how.join(" · ");
  if (agent.noCustomModels) return `${how} · doesn't take other models yet`;
  if (agent.dl) return how;
  return `${how} · set up by hand`;
}

export interface RouterDeps {
  io: RouterIO;
  prompter: Prompter;
  env?: Env;
  /** The dl key, signing in first when there's none; undefined when sign-in didn't finish (already said). */
  signIn: () => Promise<DlKey | undefined>;
  detect: () => Promise<DetectedAgent[]>;
  autopilotInstalled: () => Promise<boolean>;
  /** Starts a CLI dl knows (`dl claude`…) with these arguments; its exit code. */
  launch: (command: LaunchCommand, args: string[]) => Promise<number>;
  /** Downloads Autopilot when needed and starts it on the key; its exit code. */
  autopilot: (key: DlKey, options: { continue?: boolean }) => Promise<number>;
  /** Tells the service about an agent dl doesn't know; never throws. */
  report: (request: AgentRequest, key: DlKey) => Promise<unknown>;
  dlVersion: string;
  historyPath?: string;
  now?: () => Date;
}

/** `dl -c`: what continuing means for each CLI (its own latest session in this folder). */
const CONTINUE_ARGS: Record<LaunchCommand, string[]> = { claude: ["--continue"], opencode: ["--continue"], pi: ["--continue"], t3: [] };

/** Bare `dl` (and `dl -c`): sign in if needed, then the picker (or the nothing-found screen), then the agent. */
export async function routerHome(deps: RouterDeps, options: { continue?: boolean } = {}): Promise<number> {
  const { io } = deps;
  const c = palette(io.color === true);
  const key = await deps.signIn();
  if (!key) return 1;
  const [found, autopilotInstalled, history] = await Promise.all([
    deps.detect().catch(() => [] as DetectedAgent[]),
    deps.autopilotInstalled().catch(() => false),
    readAgentHistory(deps.historyPath),
  ]);
  const record = (id: string) => recordAgentUse(id, deps.historyPath, deps.now).catch(() => undefined);

  const open = async (id: string, args: string[] = [], resume = false): Promise<number> => {
    if (id === AUTOPILOT_ID) {
      await record(id);
      return deps.autopilot(key, resume ? { continue: true } : {});
    }
    const agent = found.find((one) => one.id === id);
    const spec = AGENT_CATALOG.find((one) => one.id === id);
    if (agent?.dl) {
      await record(id);
      return deps.launch(agent.dl, args);
    }
    if (!spec) return 1;
    if (agent?.noCustomModels || spec.noCustomModels) {
      io.out(`\n  ${c.bold(spec.name)} only runs its own models for now, so dl can't route it. We've noted that you use it.\n`);
      io.out(`  ${c.dim("Pick another agent with dl, or use the key and base URLs below in any tool that takes them:")}\n`);
      io.out(keyCard(key, c));
      await deps.report(agentRequest(spec.name, found.map((one) => one.id), deps.dlVersion), key);
      return 0;
    }
    await record(id);
    io.out(setupText(spec, key, c));
    return 0;
  };

  // `dl -c`: the last agent's own latest session, when it's a CLI dl starts.
  if (options.continue && history.lastUsed) {
    const last = history.lastUsed;
    const agent = found.find((one) => one.id === last);
    if (last === AUTOPILOT_ID) return open(last, [], true);
    if (agent?.dl) return open(last, CONTINUE_ARGS[agent.dl]);
  }

  const agents = found.filter((one) => one.id !== AUTOPILOT_ID);
  if (agents.length === 0 && history.lastUsed !== AUTOPILOT_ID) return nothingFound(deps, key, found, open);

  const question = history.lastUsed ? AGAIN_QUESTION : FIRST_QUESTION;
  let picked;
  try {
    picked = await deps.prompter.select(`\n  ${c.bold(question)}\n  ${c.cyan("›")} `, pickerOptions(agents, history, autopilotInstalled), 0);
  } catch (error) {
    if (error instanceof PromptCancelled) return 130;
    throw error;
  }
  return open(picked.value);
}

async function nothingFound(
  deps: RouterDeps,
  key: DlKey,
  found: readonly DetectedAgent[],
  open: (id: string) => Promise<number>,
): Promise<number> {
  const { io } = deps;
  const c = palette(io.color === true);
  io.out(`\n  ${c.bold(NOTHING_FOUND)}\n`);
  let answer;
  try {
    answer = await deps.prompter.select(`\n  ${c.bold("Which agent do you use?")}\n  ${c.cyan("›")} `, [
      { value: "name", label: TYPE_NAME, input: { prompt: `  ${TYPE_NAME} (Enter to skip)\n  › `, placeholder: `${TYPE_NAME} (Enter to skip)`, inline: true, allowEmpty: true } },
      { value: AUTOPILOT_ID, label: INSTALL_AUTOPILOT },
    ], 0);
  } catch (error) {
    if (error instanceof PromptCancelled) return 130;
    throw error;
  }
  if (answer.value === AUTOPILOT_ID) return open(AUTOPILOT_ID);
  const name = oneLine(answer.text ?? "", 80).trim();
  if (!name) {
    io.out(`\n  ${c.dim("Your key and base URLs, for any agent that takes them:")}\n`);
    io.out(keyCard(key, c));
    io.out(`  ${c.dim("Install a coding agent and run dl again, or pick Autopilot: dl autopilot")}\n\n`);
    return 0;
  }
  // An agent dl knows but didn't find here (installed somewhere dl doesn't look): its own steps.
  const known = findSpec(name);
  if (known && known.id !== AUTOPILOT_ID && !known.noCustomModels) {
    await recordAgentUse(known.id, deps.historyPath, deps.now).catch(() => undefined);
    io.out(setupText(known, key, c));
    return 0;
  }
  await deps.report(agentRequest(name, found.map((one) => one.id), deps.dlVersion), key);
  io.out(`\n  ${c.green("✓")} ${THANKS}\n`);
  io.out(keyCard(key, c));
  io.out(`  ${c.dim("In its settings, add an OpenAI-compatible (or Anthropic-compatible) provider with these.")}\n\n`);
  return 0;
}

type Colors = ReturnType<typeof palette>;

/** The key, base URLs and model, aligned. */
export function keyCard(key: DlKey, c: Colors, model: string = DL_DEFAULT_MODEL): string {
  const urls = keyUrls(key);
  const row = (label: string, value: string, note = "") => `    ${c.dim(label.padEnd(17))}${value}${note ? `   ${c.dim(note)}` : ""}\n`;
  return `\n${row("Key", c.bold(key.key))}${row("OpenAI-style", urls.openai)}${row("Anthropic-style", urls.anthropic)}${row("Model", model, "(GET /v1/models lists the others)")}\n`;
}

/** Exactly where the key and URLs go, for an agent dl doesn't start itself. */
export function setupSteps(spec: AgentSpec, key: DlKey, model: string = DL_DEFAULT_MODEL): string[] {
  const { openai, anthropic } = keyUrls(key);
  const compatible = (where: string) => [
    `${where} → API Provider: OpenAI Compatible.`,
    `Base URL: ${openai}`,
    "API Key: your key (below).",
    `Model ID: ${model}`,
  ];
  switch (spec.id) {
    case "cursor":
      return [
        "Open Cursor Settings → Models.",
        "Under API Keys, turn on OpenAI API Key and paste your key (below).",
        `Turn on Override OpenAI Base URL and enter ${openai}`,
        `Add a custom model named ${model} and pick it in the chat.`,
      ];
    case "cline":
      return [...compatible("In VS Code, open Cline's settings (the gear)"), "From a terminal with the Cline CLI: cline auth, then the same provider settings."];
    case "roo":
      return compatible("In VS Code, open Roo Code's settings (the gear)");
    case "kilo":
      return compatible("In VS Code, open Kilo Code's settings (the gear)");
    case "zed":
      return [
        "Open Zed's settings (zed: open settings) and add:",
        `  "language_models": { "openai_compatible": { "dl": { "api_url": "${openai}",`,
        `    "available_models": [{ "name": "${model}", "max_tokens": 128000 }] } } }`,
        "Then in the Agent panel's settings, paste your key (below) for dl and pick the model.",
      ];
    case "continue":
      return [
        "Add a model to ~/.continue/config.yaml:",
        "  models:",
        "    - name: dl",
        "      provider: openai",
        `      model: ${model}`,
        `      apiBase: ${openai}`,
        `      apiKey: ${key.key}`,
      ];
    case "codex":
      return [
        "Add to ~/.codex/config.toml:",
        `  model = "${model}"`,
        '  model_provider = "dl"',
        "  [model_providers.dl]",
        '  name = "dl"',
        `  base_url = "${openai}"`,
        '  env_key = "DL_API_KEY"',
        '  wire_api = "chat"',
        "Then: export DL_API_KEY=<your key> and run codex.",
      ];
    case "aider":
      return ["Run:", `  aider --openai-api-base ${openai} --openai-api-key ${key.key} --model openai/${model}`];
    case "qwen":
      return ["Run:", `  OPENAI_BASE_URL=${openai} OPENAI_API_KEY=${key.key} OPENAI_MODEL=${model} qwen`];
    case "goose":
      return [
        "Run goose configure → Configure Providers → OpenAI, with:",
        `  host ${key.baseUrl}, base path v1/chat/completions, your key, model ${model}.`,
      ];
    case "crush":
      return [
        "Add a provider to ~/.config/crush/crush.json:",
        `  "providers": { "dl": { "type": "openai-compat", "base_url": "${openai}", "api_key": "<your key>",`,
        `    "models": [{ "id": "${model}", "name": "DeepSeek V4.1 Flash" }] } }`,
      ];
    case "openhands":
      return ["Settings → LLM → Advanced:", `  Custom Model: openai/${model}`, `  Base URL: ${openai}`, "  API Key: your key (below)."];
    case "claude-code":
      return ["Install the Claude Code CLI (curl -fsSL https://claude.ai/install.sh | bash), then run dl claude.", `Or set ANTHROPIC_BASE_URL=${anthropic} and ANTHROPIC_AUTH_TOKEN=<your key> for it.`];
    case "opencode":
      return ["Install the OpenCode CLI (curl -fsSL https://opencode.ai/install | bash), then run dl opencode."];
    case "pi":
      return ["Install Pi (npm i -g @earendil-works/pi-coding-agent), then run dl pi."];
    case "t3":
      return ["Install the T3 Code CLI (npm i -g t3), then run dl t3."];
    default:
      return [`In ${spec.name}'s settings, add an OpenAI-compatible provider with the base URL, key and model below.`, `(Tools that speak Anthropic's API use ${anthropic}.)`];
  }
}

/** The whole "set up <agent>" screen: steps, then the key card. */
export function setupText(spec: AgentSpec, key: DlKey, c: Colors): string {
  const steps = setupSteps(spec, key);
  let n = 0;
  // Numbered steps; indented lines are text to copy (kept as they are), "(…)" lines a quiet note.
  const lines = steps.map((line) => line.startsWith("  ") ? `       ${line.slice(2)}` : line.startsWith("(") ? `       ${c.dim(line)}` : `    ${c.cyan(`${++n}.`)} ${line}`);
  return `\n  ${c.bold(`Set up ${spec.name} with dl`)}\n\n${lines.join("\n")}\n${keyCard(key, c)}  ${c.dim(`dl shows this again when you pick ${spec.name}. Your key works in every agent.`)}\n\n`;
}

/** Autopilot's environment for a run on the dl key: the key always; dl's plan as its provider only when it has none yet. */
export function autopilotKeyEnv(key: DlKey, autopilotProvider: string | undefined): Env {
  return { AUTOPILOT_DL_FREE_TOKEN: key.key, ...(autopilotProvider ? {} : { AUTOPILOT_PROVIDER: "directionally-local" }) };
}

/** The saved active provider in Autopilot's config.json, or undefined. */
export async function autopilotProvider(file: string): Promise<string | undefined> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as { provider?: unknown };
    return typeof value.provider === "string" && value.provider ? value.provider : undefined;
  } catch {
    return undefined;
  }
}
