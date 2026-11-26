import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PromptCancelled, type Prompter, type SelectOption } from "../prompt.js";
import { palette } from "../ui.js";
import { AGENT_CATALOG, AUTOPILOT_ID, findSpec, type AgentSpec, type DetectedAgent, type LaunchCommand } from "./agent-catalog.js";
import { agentRequest, DL_DEFAULT_MODEL, keyUrls, type AgentRequest, type DlKey } from "./dl-key.js";
import { COLLECTION_AT, COLLECTION_TEXT, scanStep } from "./onboarding.js";
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
  /** When the one-time "First tokens served" line was shown (ISO time). */
  firstTokensShown?: string;
}

export function agentHistoryPath(env: Env = process.env): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(env.HOME || homedir(), ".config");
  return join(configHome, "directionallylocal", "agents.json");
}

export async function readAgentHistory(path: string = agentHistoryPath()): Promise<AgentHistory> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { version?: unknown; lastUsed?: unknown; used?: unknown; firstTokensShown?: unknown };
    if (value.version !== 1) return { used: {} };
    const used = Object.fromEntries(Object.entries(value.used && typeof value.used === "object" ? value.used as Record<string, unknown> : {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    return { ...(typeof value.lastUsed === "string" ? { lastUsed: value.lastUsed } : {}), used, ...(typeof value.firstTokensShown === "string" ? { firstTokensShown: value.firstTokensShown } : {}) };
  } catch {
    return { used: {} };
  }
}

/** Marks `id` as the agent last opened through dl. */
export async function recordAgentUse(id: string, path: string = agentHistoryPath(), now: () => Date = () => new Date()): Promise<void> {
  const history = await readAgentHistory(path);
  await writeAgentHistory(path, { ...history, lastUsed: id, used: { ...history.used, [id]: now().toISOString() } });
}

/** Marks the one-time "First tokens served" line as shown, so it's never shown again. */
export async function markFirstTokensShown(path: string = agentHistoryPath(), now: () => Date = () => new Date()): Promise<void> {
  const history = await readAgentHistory(path);
  await writeAgentHistory(path, { ...history, firstTokensShown: now().toISOString() });
}

async function writeAgentHistory(path: string, history: AgentHistory): Promise<void> {
  const next = { version: 1, ...(history.lastUsed ? { lastUsed: history.lastUsed } : {}), used: history.used, ...(history.firstTokensShown ? { firstTokensShown: history.firstTokensShown } : {}) };
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
export const NOTHING_FOUND = "No agents here yet. Everyone starts somewhere.";
export const TYPE_NAME = "Type the name of the agent you use";
export const INSTALL_AUTOPILOT = "Install Autopilot — the agent we recommend. It's included in your plan.";
export const AUTOPILOT_ROW = "Autopilot — dl's own agent";
export const THANKS = "Never heard of it — telling Sina.";
/** The first row when an agent was used before: "Back to Claude Code?". */
export const backTo = (name: string) => `Back to ${name}?`;

/** The picker's rows: found agents (last used first, as "Back to <Agent>?"), then Autopilot (or Autopilot first, when it was last used). */
export function pickerOptions(found: readonly DetectedAgent[], history: AgentHistory, autopilotInstalled: boolean): SelectOption[] {
  const ordered = orderAgents(found, history);
  const rows: SelectOption[] = ordered.map((agent) => ({
    value: agent.id,
    label: agent.id === history.lastUsed ? backTo(agent.name) : agent.name,
    detail: describe(agent),
  }));
  const autopilot: SelectOption = history.lastUsed === AUTOPILOT_ID
    ? { value: AUTOPILOT_ID, label: backTo("Autopilot"), detail: autopilotInstalled ? "" : "downloads when picked" }
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
  /** The pause between the scan's lines (a terminal only); none unless given. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * After the first agent run through dl that served tokens: "First tokens served. ~9.9M left
   * this week (95.5% caching applied)." (onboarding.ts firstTokens); `done` when it's not to be
   * tried again. Never throws.
   */
  firstTokens?: (key: DlKey) => Promise<{ text?: string; done: boolean }>;
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

  // Back at the shell after an agent run: the first tokens served, once per install.
  const afterRun = async (code: number): Promise<number> => {
    if (code !== 0 || history.firstTokensShown || !deps.firstTokens) return code;
    const result = await deps.firstTokens(key).catch(() => ({ done: false } as { text?: string; done: boolean }));
    if (result.text) io.out(`\n  ${c.green("✓")} ${result.text}\n\n`);
    if (result.done) await markFirstTokensShown(deps.historyPath, deps.now).catch(() => undefined);
    return code;
  };

  const open = async (id: string, args: string[] = [], resume = false): Promise<number> => {
    if (id === AUTOPILOT_ID) {
      await record(id);
      return afterRun(await deps.autopilot(key, resume ? { continue: true } : {}));
    }
    const agent = found.find((one) => one.id === id);
    const spec = AGENT_CATALOG.find((one) => one.id === id);
    if (agent?.dl) {
      await record(id);
      return afterRun(await deps.launch(agent.dl, args));
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

  // The first time: each agent found, one line at a time (≤ 400 ms in all), then the picker.
  if (!history.lastUsed) await scanLines(deps, agents);
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

/** "✓ Claude Code   claude" per agent found, a beat apart at a terminal; "You've got a collection." with five or more. */
async function scanLines(deps: RouterDeps, agents: readonly DetectedAgent[]): Promise<void> {
  const { io } = deps;
  const c = palette(io.color === true);
  if (agents.length === 0) return;
  const width = Math.max(...agents.map((agent) => agent.name.length)) + 3;
  const step = deps.sleep ? scanStep(agents.length) : 0;
  io.out("\n");
  for (const [index, agent] of agents.entries()) {
    if (index > 0 && step > 0) await deps.sleep!(step);
    io.out(`  ${c.green("✓")} ${agent.name.padEnd(width)}${c.dim(agent.how.join(" · "))}\n`);
  }
  if (agents.length >= COLLECTION_AT) io.out(`  ${c.dim(COLLECTION_TEXT)}\n`);
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
  io.out(`\n  ${THANKS}\n`);
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
        "(Your key works in Cursor's chat and agent; Tab completion stays on Cursor's own models. The cursor-agent CLI runs only Cursor's models.)",
      ];
    case "cline":
      return [...compatible("In VS Code, open Cline's settings (the gear)"), "From a terminal with the Cline CLI: cline auth, then the same provider settings."];
    case "roo":
      return compatible("In VS Code, open Roo Code's settings (the gear)");
    case "kilo":
      return [
        "In Kilo Code, open Settings (the gear) → Providers, scroll down and click Custom provider.",
        "Provider ID: dl · Provider API: OpenAI Compatible",
        `Base URL: ${openai}`,
        "API key: your key (below).",
        `Models: add ${model} (or Fetch models), then Submit and pick it in the model list.`,
      ];
    case "zed":
      return [
        "Run agent: open settings, and under LLM Providers click Add Provider:",
        `  name dl, API URL ${openai}, model ${model}, context window 1000000`,
        "Paste your key (below) for dl there (or export DL_API_KEY=<your key>), then pick the model in the Agent panel.",
      ];
    case "continue":
      return [
        "Put this in ~/.continue/config.yaml (or add the model to your models list):",
        "  name: dl",
        "  version: 0.0.1",
        "  schema: v1",
        "  models:",
        "    - name: dl",
        "      provider: openai",
        `      model: ${model}`,
        `      apiBase: ${openai}`,
        `      apiKey: ${key.key}`,
        "      capabilities: [tool_use]",
        "The Continue CLI reads it too: cn --config ~/.continue/config.yaml",
      ];
    case "codex":
      return [
        "Codex CLI now talks only to the OpenAI Responses API (wire_api = \"responses\"; \"chat\" was removed), which dl doesn't serve yet, so Codex can't run on your plan today.",
        "Meanwhile pick another agent in dl (Claude Code, OpenCode, Pi), or use the key below in any tool that takes an OpenAI- or Anthropic-style base URL.",
      ];
    case "aider":
      return ["Run:", `  aider --openai-api-base ${openai} --openai-api-key ${key.key} --model openai/${model}`];
    case "qwen":
      return ["Run:", `  OPENAI_BASE_URL=${openai} OPENAI_API_KEY=${key.key} OPENAI_MODEL=${model} qwen`];
    case "goose":
      return [
        "Run goose configure → Custom Providers → Add A Custom Provider → OpenAI Compatible:",
        `  name dl, Provider API URL ${openai}, authentication Yes → Static API key → your key,`,
        `  models ${model}; Enter through the rest.`,
        "Then goose configure → Configure Providers → dl, and pick the model.",
      ];
    case "crush":
      return [
        "Add to ~/.config/crush/crushrc:",
        `  provider add dl --type completions --base-url ${openai} --api-key "$DL_API_KEY"`,
        `  model add dl/${model} --name "DeepSeek V4.1 Flash" --context-window 1000000 --default-max-tokens 32000`,
        `  model large dl/${model}`,
        "Then: export DL_API_KEY=<your key> and run crush.",
      ];
    case "amp":
      return [
        "In Amp's settings → Model Routing, click Add Provider → Custom URL:",
        `  base URL ${openai}, API format chat-completions, API key: your key (below)`,
        `  Model Mapping: ${model}`,
        "In the connection's Model Metadata Overrides, add the same model with Input Tokens 1000000, Output Tokens 32000, Tools: Yes.",
        "Pick it under Other Models in Amp's model selector.",
      ];
    case "warp":
      return [
        "Open Warp's Settings and search for inference endpoint.",
        `Endpoint URL: ${openai} · API key: your key (below) · model: ${model}`,
        "Save, then pick that model (not Auto) in the model picker. Works for local agent runs.",
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
