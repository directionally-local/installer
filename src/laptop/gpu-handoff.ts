import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelUpErrorType, ModelUpResult } from "../model-first-run.js";
import { AGENT_IDS, agentSupport, type AgentId, type LocalModel } from "./local-agents.js";

/**
 * The GPU first run's contract between dl and Autopilot (Autopilot's src/gpu/handoff.ts is the
 * other side; keep the two in step). Autopilot owns the screens and GPU detection; dl owns
 * `dl model up`.
 *
 * dl → Autopilot, as environment variables on plain `autopilot` (laptop mode, `dl` and the
 * install script's auto-start):
 * - DL_GPU_HANDOFF=PATH: dl can run `dl model up` here. When the person wants a private model
 *   on this machine's GPU, Autopilot writes the request below to PATH (0600, in a 0700 directory
 *   dl made) and exits.
 * - On the relaunch after that, also DL_GPU_RESULT=ok|failed, DL_GPU_ERROR=<error type> (failed
 *   only) and DL_GPU=<the detected GPU as JSON>, so Autopilot says how it went, sends the result
 *   count and doesn't probe the GPUs again.
 * - When it failed, also (since dl 0.28, all optional):
 *   DL_GPU_MODEL=<catalog id that was tried, e.g. qwen-old>,
 *   DL_GPU_REASON=<one short line: the test and why, e.g. "Chat test: the model returned no
 *   text, thinking mode used all tokens">,
 *   DL_GPU_LOG=<path of the run log, with vLLM's own log lines>.
 *   Autopilot shows its failure menu with these (Retry, See what failed, Pick another model,
 *   Continue without a local model). Autopilot owns that menu: it owns the screens and the
 *   other choices; dl owns running the setup again when asked.
 * - DL_GPU_HANDOFF is left out on the last relaunch dl allows (MAX_HANDOFFS), so Autopilot
 *   doesn't offer a retry dl wouldn't run.
 *
 * Autopilot → dl, the file at DL_GPU_HANDOFF:
 *   {"version":1,"action":"model-up","gpu":{"vendor":"nvidia","model":"NVIDIA RTX 4090","count":2,"vramGb":24}}
 * `gpu` is optional and only passed back. Two more optional fields (dl 0.28):
 *   "model":"qwen-old"  run this catalog model again, without the picker (Retry);
 *   "pick":true         show the picker, the model that just failed marked (Pick another model).
 *
 * Team chat (dl 0.39): on the relaunch after a model-up that succeeded, dl also sets
 * DL_CHAT_SETUP=1: it can set up the team chat. Autopilot then asks "How will your team use
 * it?" (Browser chat / Terminal agent / Both). Terminal opens the agent as before. Browser and
 * Both write
 *   {"version":1,"action":"chat-up","use":"browser"|"both"}
 * and exit: dl sets up Tailscale, `dl ui up` and `dl ui share`, and prints the admin link.
 * After "browser" dl exits there; after "both" it starts Autopilot once more (without
 * DL_GPU_RESULT or DL_CHAT_SETUP), which opens the agent. An Autopilot from before this never
 * asks; a dl from before this never sets DL_CHAT_SETUP, so the question isn't asked.
 *
 * Coding agent (with the team chat): on that same relaunch dl also sets DL_AGENTS, the agents besides
 * Autopilot it can open on the new model, as JSON:
 *   [{"id":"claude-code","installed":true},{"id":"opencode","installed":false},{"id":"pi","installed":true}]
 * (an agent that can't work on this model is left out). After "Terminal agent" or "Both",
 * Autopilot asks "Which coding agent?" (Autopilot, recommended and the default; then those).
 * Autopilot (or Esc) opens the session as before. Another agent after "Terminal agent" writes
 *   {"version":1,"action":"agent","agent":"claude-code"|"opencode"|"pi"}
 * and exits; after "Both" the chat-up request carries it: {"version":1,"action":"chat-up","use":"both","agent":"pi"}.
 * dl saves the choice for the box (plain dl opens that agent from then on) and opens it on the
 * model, or, when its CLI isn't installed, prints the install command and stops. Without
 * DL_AGENTS (an older dl) the question isn't asked; an older Autopilot never asks.
 *
 * Anything else (no file, another version or action) is ignored, so an older Autopilot that
 * never writes the file just runs as before, and an older dl that never sets DL_GPU_HANDOFF
 * gets Autopilot's screens without the "this machine" model setup (Autopilot then says to run
 * dl model up). An older dl ignores "model" and "pick" and shows its picker; an older
 * Autopilot ignores the new variables and says the setup failed, as before.
 */

export const HANDOFF_VERSION = 1;

export interface GpuSummary {
  vendor: "nvidia" | "amd" | "ascend";
  model: string;
  count: number;
  /** Per GPU, the largest card's, in GB. */
  vramGb: number;
}

export interface ModelUpRequest {
  version: 1;
  action: "model-up";
  gpu?: GpuSummary;
  /** A catalog id to run again without the picker. */
  model?: string;
  /** Show the picker. */
  pick?: boolean;
}

/** An agent other than Autopilot, picked in "Which coding agent?". */
export type OtherAgent = Exclude<AgentId, "autopilot">;

export interface ChatUpRequest {
  version: 1;
  action: "chat-up";
  use: "browser" | "both";
  /** After "both": the agent to open instead of Autopilot. */
  agent?: OtherAgent;
}

export interface AgentRequest {
  version: 1;
  action: "agent";
  agent: OtherAgent;
}

export type HandoffRequest = ModelUpRequest | ChatUpRequest | AgentRequest;

function otherAgent(value: unknown): OtherAgent | undefined {
  return value === "claude-code" || value === "opencode" || value === "pi" ? value : undefined;
}

/** DL_AGENTS for the relaunch after a model that passed (see above). */
export function agentsEnv(model: LocalModel | undefined, installed: Record<AgentId, boolean>): Record<string, string> {
  if (!model) return {};
  const agents = AGENT_IDS.filter((id): id is OtherAgent => id !== "autopilot" && agentSupport(id, model).ok).map((id) => ({ id, installed: installed[id] }));
  return { DL_AGENTS: JSON.stringify(agents) };
}

/** Relaunches after a model-up request, at most: a loop of failures ends in plain Autopilot. */
export const MAX_HANDOFFS = 5;

/** A private directory for the request file; `cleanup` removes it. */
export async function handoffFile(tmp: string = tmpdir()): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmp, "dl-gpu-"));
  return { path: join(dir, "handoff.json"), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function gpuFrom(value: unknown): GpuSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.vendor !== "nvidia" && raw.vendor !== "amd" && raw.vendor !== "ascend") return undefined;
  const model = typeof raw.model === "string" ? raw.model.replace(/[^A-Za-z0-9 ._()+/-]/g, "").slice(0, 64) : "";
  const count = typeof raw.count === "number" && Number.isInteger(raw.count) && raw.count >= 0 && raw.count <= 64 ? raw.count : 0;
  const vramGb = typeof raw.vramGb === "number" && Number.isFinite(raw.vramGb) && raw.vramGb >= 0 && raw.vramGb <= 100_000 ? Math.round(raw.vramGb) : 0;
  return { vendor: raw.vendor, model, count, vramGb };
}

/** The request Autopilot wrote, or undefined (none, unreadable, or not one this dl knows). */
export function parseHandoff(text: string): HandoffRequest | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const object = raw as Record<string, unknown>;
  if (object.version !== HANDOFF_VERSION) return undefined;
  if (object.action === "chat-up") {
    if (object.use !== "browser" && object.use !== "both") return undefined;
    const agent = object.use === "both" ? otherAgent(object.agent) : undefined;
    return { version: 1, action: "chat-up", use: object.use, ...(agent ? { agent } : {}) };
  }
  if (object.action === "agent") {
    const agent = otherAgent(object.agent);
    return agent ? { version: 1, action: "agent", agent } : undefined;
  }
  if (object.action !== "model-up") return undefined;
  const gpu = gpuFrom(object.gpu);
  const model = typeof object.model === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(object.model) ? object.model : undefined;
  return { version: 1, action: "model-up", ...(gpu ? { gpu } : {}), ...(model ? { model } : {}), ...(object.pick === true ? { pick: true } : {}) };
}

/** Reads and removes the request, so each one is acted on once. */
export async function takeHandoff(path: string): Promise<HandoffRequest | undefined> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  await rm(path, { force: true });
  return parseHandoff(text);
}

/** One printable line of at most `max` characters: no control characters, no line breaks. */
function oneLine(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** The environment for the relaunch after a model-up request. */
export function resultEnv(result: ModelUpResult, gpu: GpuSummary | undefined): Record<string, string> {
  const reason = result.ok ? "" : oneLine(result.message, 200);
  return {
    DL_GPU_RESULT: result.ok ? "ok" : "failed",
    // The model is up: Autopilot may ask how the team will use it (team chat, above).
    ...(result.ok ? { DL_CHAT_SETUP: "1" } : {}),
    ...(result.ok ? {} : { DL_GPU_ERROR: result.errorType satisfies ModelUpErrorType }),
    ...(gpu ? { DL_GPU: JSON.stringify(gpu) } : {}),
    ...(!result.ok && result.model ? { DL_GPU_MODEL: result.model } : {}),
    ...(reason ? { DL_GPU_REASON: reason } : {}),
    ...(!result.ok && result.log ? { DL_GPU_LOG: result.log } : {}),
  };
}
