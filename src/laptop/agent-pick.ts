import { readDlKey, type DlKey } from "./dl-key.js";
import { telemetryOff } from "./telemetry.js";

/**
 * Router tracking: which coding agent someone picks in dl's router (bare `dl`, "Back to X?") or
 * opens with `dl <agent>`, sent to the service (POST /v1/agent-pick, services/free/src/agent-picks.ts)
 * with the dl key, so the owner can see which agents people choose and whether they stay and pay.
 * Agent ids only: the one picked, whether it's dl's first run here, and the ids of the agents dl
 * found on this computer (catalog ids, never paths). Never content.
 *
 * Fire and forget: nothing waits on it, it gives up after AGENT_PICK_TIMEOUT_MS and it never
 * throws. Off with DL_NO_TELEMETRY or DO_NOT_TRACK (telemetry.ts), and in CI.
 */

export interface AgentPickReport {
  agent: string;
  firstRun: boolean;
  /** The agents dl found here; left out when dl didn't look (`dl claude`). */
  found?: string[];
  dlVersion: string;
}

export const AGENT_PICK_TIMEOUT_MS = 1_000;

type Env = Record<string, string | undefined>;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Sends one pick with the key; true when the service took it. Never throws. */
export async function sendAgentPick(pick: AgentPickReport, key: Pick<DlKey, "key" | "baseUrl">, deps: { env?: Env; fetch?: Fetch } = {}): Promise<boolean> {
  if (telemetryOff(deps.env ?? process.env)) return false;
  const call = deps.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  try {
    const response = await call(`${key.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1/agent-pick`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${key.key}` },
      body: JSON.stringify({ agent: pick.agent, firstRun: pick.firstRun, ...(pick.found ? { found: pick.found } : {}), dlVersion: pick.dlVersion }),
      redirect: "error",
      signal: AbortSignal.timeout(AGENT_PICK_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status === 202;
  } catch {
    return false;
  }
}

/**
 * Starts sending a pick and returns at once: `dl <agent>`'s, with the saved dl key (none: nothing
 * is sent). The promise is for tests; callers don't wait on it.
 */
export function notePick(pick: AgentPickReport, deps: { env?: Env; fetch?: Fetch; key?: () => Promise<DlKey | undefined> } = {}): Promise<boolean> {
  const env = deps.env ?? process.env;
  if (telemetryOff(env)) return Promise.resolve(false);
  return (async () => {
    const key = await (deps.key ?? (() => readDlKey(env)))().catch(() => undefined);
    return key ? sendAgentPick(pick, key, deps) : false;
  })().catch(() => false);
}
