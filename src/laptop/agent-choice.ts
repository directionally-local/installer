import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { modelStatePath } from "../state.js";
import type { Prompter, SelectOption } from "../prompt.js";
import { palette } from "../ui.js";
import { AGENT_IDS, AGENTS, agentSupport, installedAgents, installMessage, parseAgent, type AgentId, type LocalModel } from "./local-agents.js";

/**
 * Which coding agent plain `dl` opens on this box: chosen in the GPU first run ("Which coding
 * agent?", asked by Autopilot after "Terminal agent" or "Both") or with `dl agent set NAME`, and
 * kept beside the model's state (agent.json next to model.json): it belongs to this box, like
 * its model. Unset means Autopilot.
 */

export interface AgentChoice { version: 1; agent: AgentId; at: string }

export function agentChoicePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(modelStatePath(env)), "agent.json");
}

/** The saved choice, or undefined (none, unreadable, or not one this dl knows: Autopilot then). */
export async function readAgentChoice(path: string = agentChoicePath()): Promise<AgentId | undefined> {
  return parseAgentChoice(await readFile(path, "utf8").catch(() => undefined));
}

/** agent.json's agent, or undefined. */
export function parseAgentChoice(text: string | undefined): AgentId | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as Partial<AgentChoice>;
    return value?.version === 1 && typeof value.agent === "string" ? parseAgent(value.agent) : undefined;
  } catch {
    return undefined;
  }
}

export async function saveAgentChoice(agent: AgentId, path: string = agentChoicePath(), now: () => Date = () => new Date()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify({ version: 1, agent, at: now().toISOString() } satisfies AgentChoice)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

export const AGENT_QUESTION = "Which coding agent?";

/** The menu's options, as dl's own prompt shows them (Autopilot's first run shows the same). */
export function agentOptions(model: LocalModel | undefined, installed: Record<AgentId, boolean>): SelectOption[] {
  return AGENT_IDS.map((id) => {
    const info = AGENTS[id];
    const support = model ? agentSupport(id, model) : { ok: true as const };
    const label = id === "autopilot" ? `${info.label} (recommended)` : !support.ok ? `${info.label} (not with this model)` : installed[id] ? info.label : `${info.label} (install first)`;
    return { value: id, label, detail: support.ok ? info.note : support.reason };
  });
}

export interface AgentCommandDeps {
  io: { out: (text: string) => void; err: (text: string) => void; color?: boolean };
  /** The box's model; undefined when none is set up. */
  model: () => Promise<LocalModel | undefined>;
  prompter?: Prompter;
  /** A terminal to ask on. */
  interactive: boolean;
  path?: string;
  installed?: () => Promise<Record<AgentId, boolean>>;
}

/**
 * `dl agent`: the agent plain dl opens here, and (on a terminal) the menu to change it.
 * `dl agent set NAME`: change it (autopilot, claude-code, opencode, pi).
 */
export async function agentCommand(args: string[], deps: AgentCommandDeps): Promise<number> {
  const { io } = deps;
  const c = palette(io.color === true);
  const path = deps.path ?? agentChoicePath();
  const names = AGENT_IDS.join(", ");
  const [sub, value, ...extra] = args;
  if (sub !== undefined && sub !== "set") {
    io.err(`  Usage: dl agent [set NAME]   ${c.dim(`(NAME: ${names})`)}\n`);
    return 2;
  }
  const model = await deps.model();
  const installed = await (deps.installed ?? (() => installedAgents()))();
  const current = (await readAgentChoice(path)) ?? "autopilot";
  let picked: AgentId | undefined;
  if (sub === "set") {
    picked = parseAgent(value);
    if (!picked || extra.length) {
      io.err(`  Usage: dl agent set NAME   ${c.dim(`(NAME: ${names})`)}\n`);
      return 2;
    }
  } else {
    io.out(`  Plain dl opens ${c.bold(AGENTS[current].label)}${model ? ` on ${model.model}` : ""}.\n`);
    if (!model) io.out(c.dim("  No model on this box yet (dl model up): only Autopilot can open, on its own provider.\n"));
    if (!deps.interactive || !deps.prompter) {
      io.out(c.dim(`  Change it: dl agent set NAME (${names})\n`));
      return 0;
    }
    const options = agentOptions(model, installed);
    const answer = await deps.prompter.select(AGENT_QUESTION, options, Math.max(0, AGENT_IDS.indexOf(current)));
    picked = parseAgent(answer.value);
    if (!picked) return 1;
  }
  if (picked !== "autopilot" && model) {
    const support = agentSupport(picked, model);
    if (!support.ok) {
      io.err(`  ${AGENTS[picked].label} can't run on ${model.model} here: it ${support.reason}. Kept ${AGENTS[current].label}.\n`);
      return 1;
    }
  }
  await saveAgentChoice(picked, path);
  io.out(`  ${c.green("✓")} Plain dl opens ${AGENTS[picked].label} from now on${picked !== "autopilot" ? `, on this box's model${model ? ` (${model.model})` : ""}` : ""}.\n`);
  if (picked !== "autopilot" && !model) io.out(c.dim("  It needs a model on this box first: dl model up. Until then dl opens Autopilot.\n"));
  if (picked !== "autopilot" && !installed[picked]) io.out(installMessage(picked));
  return 0;
}
