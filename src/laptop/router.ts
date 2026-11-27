import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PromptCancelled, type Prompter, type SelectOption } from "../prompt.js";
import { palette } from "../ui.js";
import { AGENT_CATALOG, AUTOPILOT_ID, findSpec, type AgentSpec, type DetectedAgent, type LaunchCommand } from "./agent-catalog.js";
import type { AgentPickReport } from "./agent-pick.js";
import { agentRequest, DL_DEFAULT_MODEL, keyUrls, type AgentRequest, type DlKey } from "./dl-key.js";
import { COLLECTION_AT, COLLECTION_TEXT, scanStep } from "./onboarding.js";
import { oneLine } from "./printable.js";
import { KIMI_MODEL, planModelName, planModelsLine, planOrder } from "./plan-models.js";

/**
 * Bare `dl` on a laptop: a router for the person's own coding agent. dl signs in once (dl.new,
 * in the browser: dl-key.ts), finds the coding agents on this computer (agent-catalog.ts), and
 * asks which one to use; picking one sets it up on the dl key and, for a CLI dl knows, starts it.
 * dl remembers the choice: the next `dl` puts "Back to <the last one>?" on top, already selected,
 * so Enter opens it again. `dl claude` (and dl opencode, pi, t3, autopilot)
 * opens one directly and becomes the last used.
 *
 * Autopilot, dl's own agent, is the recommendation at the top ("Use our coding agent", included in
 * the plan), above the agents found: it isn't installed with dl, and is downloaded only when it's
 * picked. With no agent found, Autopilot is first there too, then a field for the agent the person
 * uses (dl tells the service, so we can add it).
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

export const FIRST_QUESTION = "Which one do you want to use?";
export const AGAIN_QUESTION = "Which coding agent?";
export const NOTHING_FOUND = "No agents here yet. Everyone starts somewhere.";
export const TYPE_NAME = "Type the name of the agent you use";
/** The heading over Autopilot, first in the picker. */
export const OUR_AGENT = "Use our coding agent";
/** The heading over the agents found here. */
export const ALSO_FOUND = "I also found these on your computer";
/** The heading over the typed name, when nothing was found. */
export const ANOTHER_AGENT = "Or tell us which agent you use";
export const AUTOPILOT_ROW = "Autopilot";
export const AUTOPILOT_PITCH = "— recommended · included in your plan";
export const AUTOPILOT_DOWNLOADS = "(downloads when picked)";
export const THANKS = "Never heard of it — telling Sina.";
/** The first row when an agent was used before: "Back to Claude Code?". */
export const backTo = (name: string) => `Back to ${name}?`;

/** Autopilot's row: dl's recommendation, first under "Use our coding agent". */
function autopilotRow(autopilotInstalled: boolean, heading?: string): SelectOption {
  return { value: AUTOPILOT_ID, label: AUTOPILOT_ROW, accent: AUTOPILOT_PITCH, ...(autopilotInstalled ? {} : { detail: AUTOPILOT_DOWNLOADS }), ...(heading ? { heading } : {}) };
}

/**
 * The picker's rows. With an agent used before and still here, "Back to <Agent>?" first (already
 * selected, so Enter opens it again); then Autopilot under "Use our coding agent" (first, and so
 * selected, when nothing was used before); then the other agents found, under "I also found these
 * on your computer", most recently used first.
 */
export function pickerOptions(found: readonly DetectedAgent[], history: AgentHistory, autopilotInstalled: boolean): SelectOption[] {
  const ordered = orderAgents(found, history);
  const last = history.lastUsed === AUTOPILOT_ID ? undefined : ordered.find((agent) => agent.id === history.lastUsed);
  const back: SelectOption[] = history.lastUsed === AUTOPILOT_ID
    ? [{ value: AUTOPILOT_ID, label: backTo("Autopilot"), ...(autopilotInstalled ? {} : { detail: AUTOPILOT_DOWNLOADS.slice(1, -1) }) }]
    : last ? [{ value: last.id, label: backTo(last.name), detail: describe(last) }] : [];
  const autopilot = history.lastUsed === AUTOPILOT_ID ? [] : [autopilotRow(autopilotInstalled, OUR_AGENT)];
  const others: SelectOption[] = ordered.filter((agent) => agent !== last).map((agent, index) => ({
    value: agent.id,
    label: agent.name,
    detail: describe(agent),
    ...(index === 0 ? { heading: ALSO_FOUND } : {}),
  }));
  return [...back, ...autopilot, ...others];
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
  /**
   * Tells the service which agent was picked (agent-pick.ts): fire and forget, so it must return
   * at once and never throw. Not called for `dl -c`, which isn't a pick.
   */
  pick?: (pick: AgentPickReport, key: DlKey) => void;
  dlVersion: string;
  historyPath?: string;
  now?: () => Date;
  /** The pause between the scan's lines (a terminal only); none unless given. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * After the first agent run through dl that served tokens: "First tokens served. ~9.9M left
   * this week (95.5% caching applied)." (onboarding.ts firstTokens). It's marked as shown only
   * when a line was printed. Never throws.
   */
  firstTokens?: (key: DlKey) => Promise<{ text?: string; done: boolean }>;
  /** The model ids the key may use (its GET /v1/models), for the by-hand steps; DeepSeek only when not given or unreadable. Never throws. */
  models?: (key: DlKey) => Promise<readonly string[]>;
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
  const models = () => keyModels(deps, key);
  // Router tracking: the pick, whether it's the first here, and the agents found. Never waited on.
  const notePick = (id: string) => {
    try {
      deps.pick?.({ agent: id, firstRun: !history.lastUsed, found: found.map((one) => one.id).filter((one) => one !== AUTOPILOT_ID), dlVersion: deps.dlVersion }, key);
    } catch {
      // A pick that can't be sent is dropped.
    }
  };

  // Back at the shell after an agent run: the first tokens served, once per install.
  const afterRun = async (code: number): Promise<number> => {
    if (code !== 0 || history.firstTokensShown || !deps.firstTokens) return code;
    const result = await deps.firstTokens(key).catch(() => ({ done: false } as { text?: string; done: boolean }));
    // Marked only once the line is printed: a `done` without a line isn't "shown".
    if (!result.text) return code;
    io.out(`\n  ${c.green("✓")} ${result.text}\n\n`);
    await markFirstTokensShown(deps.historyPath, deps.now).catch(() => undefined);
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
      io.out(keyCard(key, c, await models()));
      await deps.report(agentRequest(spec.name, found.map((one) => one.id), deps.dlVersion), key);
      return 0;
    }
    await record(id);
    io.out(setupText(spec, key, c, await models()));
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
  if (agents.length === 0 && history.lastUsed !== AUTOPILOT_ID) return nothingFound(deps, key, autopilotInstalled, found, open, notePick);

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
  notePick(picked.value);
  return open(picked.value);
}

/** The scan's line, filled in a beat apart at a terminal: "Looking on your computer… ✓ Claude Code  ✓ Cursor", then "You've got a collection." with five or more. */
export const SCAN_TEXT = "Looking on your computer…";

async function scanLines(deps: RouterDeps, agents: readonly DetectedAgent[]): Promise<void> {
  const { io } = deps;
  const c = palette(io.color === true);
  if (agents.length === 0) return;
  const step = deps.sleep ? scanStep(agents.length) : 0;
  io.out(`\n  ${c.dim(SCAN_TEXT)}`);
  for (const [index, agent] of agents.entries()) {
    if (index > 0 && step > 0) await deps.sleep!(step);
    io.out(`${index === 0 ? " " : "  "}${c.green("✓")} ${agent.name}`);
  }
  io.out(agents.length >= COLLECTION_AT ? `  ${c.dim(COLLECTION_TEXT)}\n` : "\n");
}

/** The nothing-found screen's rows: Autopilot first (selected), then a field for the agent they use. */
export function nothingFoundOptions(autopilotInstalled: boolean): SelectOption[] {
  return [
    autopilotRow(autopilotInstalled, OUR_AGENT),
    { value: "name", label: TYPE_NAME, heading: ANOTHER_AGENT, input: { prompt: `  ${TYPE_NAME} (Enter to skip)\n  › `, placeholder: `${TYPE_NAME} (Enter to skip)`, inline: true, allowEmpty: true } },
  ];
}

async function nothingFound(
  deps: RouterDeps,
  key: DlKey,
  autopilotInstalled: boolean,
  found: readonly DetectedAgent[],
  open: (id: string) => Promise<number>,
  notePick: (id: string) => void = () => undefined,
): Promise<number> {
  const { io } = deps;
  const c = palette(io.color === true);
  io.out(`\n  ${c.bold(NOTHING_FOUND)}\n`);
  let answer;
  try {
    answer = await deps.prompter.select(`\n  ${c.bold(FIRST_QUESTION)}\n  ${c.cyan("›")} `, nothingFoundOptions(autopilotInstalled), 0);
  } catch (error) {
    if (error instanceof PromptCancelled) return 130;
    throw error;
  }
  if (answer.value === AUTOPILOT_ID) {
    notePick(AUTOPILOT_ID);
    return open(AUTOPILOT_ID);
  }
  const name = oneLine(answer.text ?? "", 80).trim();
  if (!name) {
    io.out(`\n  ${c.dim("Your key and base URLs, for any agent that takes them:")}\n`);
    io.out(keyCard(key, c, await keyModels(deps, key)));
    io.out(`  ${c.dim("Install a coding agent and run dl again, or pick Autopilot: dl autopilot")}\n\n`);
    return 0;
  }
  // An agent dl knows but didn't find here (installed somewhere dl doesn't look): its own steps.
  const known = findSpec(name);
  if (known && known.id !== AUTOPILOT_ID && !known.noCustomModels) {
    notePick(known.id);
    await recordAgentUse(known.id, deps.historyPath, deps.now).catch(() => undefined);
    io.out(setupText(known, key, c, await keyModels(deps, key)));
    return 0;
  }
  await deps.report(agentRequest(name, found.map((one) => one.id), deps.dlVersion), key);
  io.out(`\n  ${THANKS}\n`);
  io.out(keyCard(key, c, await keyModels(deps, key)));
  io.out(`  ${c.dim("In its settings, add an OpenAI-compatible (or Anthropic-compatible) provider with these.")}\n\n`);
  return 0;
}

type Colors = ReturnType<typeof palette>;

/** The key's model ids from deps.models, or DeepSeek alone. */
async function keyModels(deps: Pick<RouterDeps, "models">, key: DlKey): Promise<readonly string[]> {
  const ids = deps.models ? await deps.models(key).catch(() => [] as readonly string[]) : [];
  return ids.length ? ids : [DL_DEFAULT_MODEL];
}

/** The key, base URLs and the plan's model ids, aligned. */
export function keyCard(key: DlKey, c: Colors, models: readonly string[] = [DL_DEFAULT_MODEL]): string {
  const urls = keyUrls(key);
  const ids = orderedIds(models);
  const row = (label: string, value: string, note = "") => `    ${c.dim(label.padEnd(17))}${value}${note ? `   ${c.dim(note)}` : ""}\n`;
  const modelRows = ids.length > 1
    ? ids.map((id, index) => row(index === 0 ? "Models" : "", id.padEnd(Math.max(...ids.map((one) => one.length))), `(${planModelName({ id })}${index === 0 ? ", the default" : ""})`)).join("")
    : row("Model", ids[0]!, "(GET /v1/models lists what your key may use)");
  return `\n${row("Key", c.bold(key.key))}${row("OpenAI-style", urls.openai)}${row("Anthropic-style", urls.anthropic)}${modelRows}\n`;
}

/** The ids, DeepSeek first then Kimi; DeepSeek alone when there are none. */
function orderedIds(models: readonly string[]): string[] {
  const ids = planOrder(models.map((id) => ({ id }))).map((model) => model.id);
  return ids.length ? ids : [DL_DEFAULT_MODEL];
}

/** How to switch models in an agent set up by hand, for the line after its steps. */
const SWITCH_HOW: Partial<Record<string, string>> = {
  "claude-code": "switch with /model (Opus is Kimi K3.1)",
  cline: "switch by changing the Model ID in Cline's settings",
  roo: "switch by changing the Model ID in Roo Code's settings",
  openhands: "switch by changing the Custom Model in OpenHands' settings",
  aider: "switch with /model inside aider",
  qwen: "switch with OPENAI_MODEL, or /model inside Qwen Code",
  crush: "switch with ctrl+p → Switch Model",
};

/** The line after an agent's setup steps: the plan's models, and how to switch in that agent. */
export function setupModelsLine(models: readonly string[], spec?: Pick<AgentSpec, "id" | "name">): string {
  const how = (spec && SWITCH_HOW[spec.id]) ?? `switch in ${spec?.name ?? "the agent"}'s model picker`;
  return planModelsLine(orderedIds(models).map((id) => planModelName({ id })), how);
}

/**
 * Exactly where the key and URLs go, for an agent dl doesn't start itself. `models` is what the
 * key may use (its /v1/models ids), the default first: on Plus and Max that's DeepSeek and Kimi
 * K3.1, and each agent's steps add both, so the person can switch in the agent.
 */
export function setupSteps(spec: AgentSpec, key: DlKey, models: readonly string[] = [DL_DEFAULT_MODEL]): string[] {
  const { openai, anthropic } = keyUrls(key);
  const ordered = orderedIds(models);
  const model = ordered[0]!;
  const others = ordered.slice(1);
  /** "deepseek/…" or "deepseek/… and moonshotai/…", with a prefix on each. */
  const all = (prefix = "", joiner = " and ") => ordered.map((id) => `${prefix}${id}`).join(joiner);
  const kimi = others.includes(KIMI_MODEL);
  const compatible = (where: string) => [
    `${where} → API Provider: OpenAI Compatible.`,
    `Base URL: ${openai}`,
    "API Key: your key (below).",
    `Model ID: ${model}`,
    ...others.map((id) => `(For ${planModelName({ id })}, change Model ID to ${id}.)`),
  ];
  switch (spec.id) {
    case "cursor":
      return [
        "Open Cursor Settings → Models.",
        "Under API Keys, turn on OpenAI API Key and paste your key (below).",
        `Turn on Override OpenAI Base URL and enter ${openai}`,
        `Add ${others.length ? "custom models named" : "a custom model named"} ${all()} and pick ${others.length ? "one" : "it"} in the chat.`,
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
        `Models: add ${all()} (or Fetch models), then Submit and pick ${others.length ? "one" : "it"} in the model list.`,
      ];
    case "zed":
      return [
        "Run agent: open settings, and under LLM Providers click Add Provider:",
        `  name dl, API URL ${openai}, ${others.length ? "models" : "model"} ${all()}, context window 1000000`,
        "Paste your key (below) for dl there (or export DL_API_KEY=<your key>), then pick the model in the Agent panel.",
      ];
    case "continue":
      return [
        "Put this in ~/.continue/config.yaml (or add the model to your models list):",
        "  name: dl",
        "  version: 0.0.1",
        "  schema: v1",
        "  models:",
        ...ordered.flatMap((id) => [
          `    - name: ${id === model ? "dl" : `dl ${planModelName({ id })}`}`,
          "      provider: openai",
          `      model: ${id}`,
          `      apiBase: ${openai}`,
          `      apiKey: ${key.key}`,
          "      capabilities: [tool_use]",
        ]),
        "The Continue CLI reads it too: cn --config ~/.continue/config.yaml",
      ];
    case "codex":
      return [
        "Codex CLI now talks only to the OpenAI Responses API (wire_api = \"responses\"; \"chat\" was removed), which dl doesn't serve yet, so Codex can't run on your plan today.",
        "Meanwhile pick another agent in dl (Claude Code, OpenCode, Pi), or use the key below in any tool that takes an OpenAI- or Anthropic-style base URL.",
      ];
    case "aider":
      return ["Run:", `  aider --openai-api-base ${openai} --openai-api-key ${key.key} --model openai/${model}`, ...others.map((id) => `(For ${planModelName({ id })}: --model openai/${id}, or /model openai/${id} inside aider.)`)];
    case "qwen":
      return ["Run:", `  OPENAI_BASE_URL=${openai} OPENAI_API_KEY=${key.key} OPENAI_MODEL=${model} qwen`, ...others.map((id) => `(For ${planModelName({ id })}: OPENAI_MODEL=${id}.)`)];
    case "goose":
      return [
        "Run goose configure → Custom Providers → Add A Custom Provider → OpenAI Compatible:",
        `  name dl, Provider API URL ${openai}, authentication Yes → Static API key → your key,`,
        `  models ${all("", ", ")}; Enter through the rest.`,
        "Then goose configure → Configure Providers → dl, and pick the model.",
      ];
    case "crush":
      return [
        "Add to ~/.config/crush/crushrc:",
        `  provider add dl --type completions --base-url ${openai} --api-key "$DL_API_KEY"`,
        ...ordered.map((id) => `  model add dl/${id} --name "${planModelName({ id })}" --context-window 1000000 --default-max-tokens 32000`),
        `  model large dl/${model}`,
        "Then: export DL_API_KEY=<your key> and run crush.",
      ];
    case "amp":
      return [
        "In Amp's settings → Model Routing, click Add Provider → Custom URL:",
        `  base URL ${openai}, API format chat-completions, API key: your key (below)`,
        `  Model Mapping: ${all("", ", ")}`,
        `In the connection's Model Metadata Overrides, add the same ${others.length ? "models" : "model"} with Input Tokens 1000000, Output Tokens 32000, Tools: Yes.`,
        "Pick it under Other Models in Amp's model selector.",
      ];
    case "warp":
      return [
        "Open Warp's Settings and search for inference endpoint.",
        `Endpoint URL: ${openai} · API key: your key (below) · ${others.length ? "models" : "model"}: ${all()}`,
        `Save, then pick ${others.length ? "one" : "that model"} (not Auto) in the model picker. Works for local agent runs.`,
      ];
    case "openhands":
      return ["Settings → LLM → Advanced:", `  Custom Model: openai/${model}`, `  Base URL: ${openai}`, "  API Key: your key (below).", ...others.map((id) => `(For ${planModelName({ id })}, change Custom Model to openai/${id}.)`)];
    case "claude-code":
      return [
        "Install the Claude Code CLI (curl -fsSL https://claude.ai/install.sh | bash), then run dl claude.",
        `Or set ANTHROPIC_BASE_URL=${anthropic} and ANTHROPIC_AUTH_TOKEN=<your key> for it${kimi ? `, with ANTHROPIC_DEFAULT_OPUS_MODEL=${KIMI_MODEL} and ANTHROPIC_DEFAULT_SONNET_MODEL=${model}` : ""}.`,
      ];
    case "opencode":
      return ["Install the OpenCode CLI (curl -fsSL https://opencode.ai/install | bash), then run dl opencode."];
    case "pi":
      return ["Install Pi (npm i -g @earendil-works/pi-coding-agent), then run dl pi."];
    case "t3":
      return ["Install the T3 Code CLI (npm i -g t3), then run dl t3."];
    default:
      return [`In ${spec.name}'s settings, add an OpenAI-compatible provider with the base URL, key and ${others.length ? "models" : "model"} below.`, `(Tools that speak Anthropic's API use ${anthropic}.)`];
  }
}

/** The whole "set up <agent>" screen: steps, then the key card and the plan's models. */
export function setupText(spec: AgentSpec, key: DlKey, c: Colors, models: readonly string[] = [DL_DEFAULT_MODEL]): string {
  const steps = setupSteps(spec, key, models);
  let n = 0;
  // Numbered steps; indented lines are text to copy (kept as they are), "(…)" lines a quiet note.
  const lines = steps.map((line) => line.startsWith("  ") ? `       ${line.slice(2)}` : line.startsWith("(") ? `       ${c.dim(line)}` : `    ${c.cyan(`${++n}.`)} ${line}`);
  return `\n  ${c.bold(`Set up ${spec.name} with dl`)}\n\n${lines.join("\n")}\n${keyCard(key, c, models)}${spec.id === "codex" ? "" : `  ${setupModelsLine(models, spec)}\n`}  ${c.dim(`dl shows this again when you pick ${spec.name}. Your key works in every agent.`)}\n\n`;
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
