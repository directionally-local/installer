import { dirname, join } from "node:path";
import { pendingSignUps, publicUrl, readUiState, uiStatePath, UI_CONTAINER, UI_SPEC_LABEL } from "./chat-ui.js";
import { containerRunning, inspectContainer } from "./model-runtime.js";
import { localFetch, modelApiBase, type FetchModel } from "./model-smoke.js";
import { describeAccess, modelStatePath, readDeployments, type InstallState } from "./state.js";
import type { System } from "./system.js";
import { HTTPS_CERTS_URL, tailscaleState } from "./tailscale.js";
import { palette } from "./ui.js";
import { parseAgentChoice } from "./laptop/agent-choice.js";
import { AGENTS, type AgentId } from "./laptop/local-agents.js";

/**
 * What a GPU box runs, in a few lines: for `dl status`, and printed by plain `dl` before it does
 * what it always does. Only on a machine with dl model deployments or a team chat; anywhere
 * else (a laptop) there is nothing to say and nothing is probed beyond two state files.
 */
export interface BoxSummaryOptions {
  system: System;
  /** dl model's state file; ui.json sits beside it. */
  statePath?: string;
  /** For the models' and Open WebUI's APIs; the real one unless replaced. */
  fetch?: FetchModel;
  color?: boolean;
  /** The server install (dl up), when there is one. */
  serverState?: InstallState;
  /** The box's saved coding agent; agent.json beside the model's state unless replaced. */
  agentChoice?: () => Promise<AgentId | undefined>;
}

export interface BoxRow { ok: boolean | undefined; label: string; detail: string }

export async function boxRows(options: BoxSummaryOptions): Promise<BoxRow[] | undefined> {
  const { system } = options;
  const statePath = options.statePath ?? modelStatePath();
  const deployments = await readDeployments(system, statePath).catch((): Awaited<ReturnType<typeof readDeployments>> => ({}));
  const chat = await readUiState(system, uiStatePath(statePath)).catch(() => undefined);
  const names = Object.keys(deployments).sort();
  if (!names.length && !chat) return undefined;
  const call = options.fetch ?? localFetch;
  const rows: BoxRow[] = [];
  for (const name of names) {
    const active = deployments[name]!.active;
    const running = await containerRunning(system, active.container);
    const healthy = running && await answers(call, `${modelApiBase(active)}/models`);
    rows.push({ ok: healthy, label: names.length === 1 ? "Model" : `Model ${name}`,
      detail: `${active.id} · port ${active.port} · ${healthy ? "healthy" : running ? "not answering · dl model status" : "stopped · dl model status"}` });
  }
  if (!names.length) rows.push({ ok: false, label: "Model", detail: "none · dl model up" });
  // The coding agent plain dl opens here (agent-choice.ts).
  const agent = (await (options.agentChoice ?? (async () => parseAgentChoice(await system.readFile(join(dirname(statePath), "agent.json")))))().catch(() => undefined)) ?? "autopilot";
  rows.push({ ok: undefined, label: "Coding agent", detail: `${AGENTS[agent].label}${agent === "autopilot" ? " (default)" : names.length ? " on the model" : " · needs a model"} · dl agent to change` });
  if (chat) {
    const running = (await inspectContainer(system, UI_CONTAINER, UI_SPEC_LABEL))?.running === true;
    const pending = running ? await pendingSignUps({ fetch: call }, chat) : undefined;
    rows.push({ ok: running, label: "Team chat",
      detail: running ? [`running · ${publicUrl(chat)}`, ...(chat.share ? [] : ["this machine only"]), ...(pending ? [`${pending.length} waiting for approval`] : [])].join(" · ") : "stopped · dl ui up" });
  } else {
    rows.push({ ok: undefined, label: "Team chat", detail: "not set up · dl ui up" });
  }
  const server = options.serverState;
  const sandbox = names.map((name) => deployments[name]!.sandbox).find(Boolean);
  rows.push(server
    ? { ok: true, label: "Agent server", detail: `installed (dl up) · ${describeAccess(server.access)}` }
    : sandbox
      ? { ok: true, label: "Agent server", detail: `sandbox for ${sandbox.workspace} · dl model attach` }
      : { ok: undefined, label: "Agent server", detail: "none · dl opens the agent in this terminal" });
  const tailscale = await tailscaleState(system);
  rows.push(tailscale.state === "ready"
    ? { ok: true, label: "Tailscale", detail: `signed in as ${tailscale.name.split(".")[0]} · HTTPS on` }
    : tailscale.state === "no-https"
      ? { ok: false, label: "Tailscale", detail: `signed in · HTTPS certificates off (${HTTPS_CERTS_URL})` }
      : { ok: undefined, label: "Tailscale", detail: tailscale.state === "missing" ? "not installed" : "not signed in" });
  return rows;
}

/** The summary as printed: a heading and one row per part, or undefined on a machine that isn't a GPU box. */
export async function boxSummary(options: BoxSummaryOptions): Promise<string | undefined> {
  const rows = await boxRows(options);
  if (!rows) return undefined;
  const c = palette(options.color === true);
  const width = Math.max(...rows.map((row) => row.label.length)) + 2;
  const glyph = (ok: boolean | undefined) => ok === true ? c.green("✓") : ok === false ? c.red("✗") : c.dim("·");
  return `\n  ${c.bold("This GPU box")}\n${rows.map((row) => `  ${glyph(row.ok)} ${row.label.padEnd(width)}${row.ok === false ? row.detail : c.dim(row.detail)}\n`).join("")}\n`;
}

async function answers(call: FetchModel, url: string): Promise<boolean> {
  try {
    const response = await call(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(3_000) });
    return response.ok;
  } catch {
    return false;
  }
}
