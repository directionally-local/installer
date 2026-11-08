import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PATHS } from "./layout.js";
import type { System } from "./system.js";

/**
 * tailscale: private HTTPS on the tailnet. loopback: no exposure; reach it over an SSH tunnel.
 * ssh: like loopback, but set up from the laptop, which keeps its own SSH tunnel to it.
 */
export type AccessMode = "tailscale" | "loopback" | "ssh";

export const ACCESS_MODES: readonly AccessMode[] = ["tailscale", "loopback", "ssh"];

/** How people reach this server, in words (the address alone means little for a tunnel). */
export function describeAccess(access: InstallState["access"]): string {
  return access.mode === "ssh" ? "over SSH from your laptop" : access.url;
}

/** What `up` installed, so `doctor`, `status`, and `uninstall` know what's there. */
export interface InstallState {
  version: 1;
  installedAt: string;
  updatedAt: string;
  release: string;
  autopilotVersion: string;
  hotcellVersion: string;
  image: string;
  access: { mode: AccessMode; url: string };
}

export async function readState(system: System): Promise<InstallState | undefined> {
  const raw = await system.readFile(PATHS.state);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as InstallState;
    return parsed.version === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** GPU model serving is local to the host, not part of the server installation. */
export interface ModelDeployment {
  id: string;
  repo: string;
  container: string;
  port: number;
  context: number;
  /** Kept so rollback can restart this exact recipe even if the catalog changes. */
  image: string;
  flags: readonly string[];
  minVramMiB: number;
  lastTest: { chat: boolean; tools: boolean; json: boolean; tokensPerSecond: number; at: string };
}

export interface ModelState { version: 1; active: ModelDeployment; previous?: ModelDeployment }

export function modelStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_STATE_HOME?.trim() || join(env.HOME || homedir(), ".local", "state"), "directionallylocal", "model.json");
}

export async function readModelState(system: System, path = modelStatePath()): Promise<ModelState | undefined> {
  const raw = await system.readFile(path);
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") throw new Error("invalid model state");
    const state = value as Partial<ModelState>;
    if (state.version !== 1 || !validDeployment(state.active) || (state.previous !== undefined && !validDeployment(state.previous))) throw new Error("invalid model state");
    return state as ModelState;
  } catch { throw new Error(`Invalid model state at ${path}; fix it before changing containers.`); }
}

function validDeployment(value: unknown): value is ModelDeployment {
  if (!value || typeof value !== "object") return false;
  const deployment = value as Partial<ModelDeployment>;
  return typeof deployment.id === "string" && typeof deployment.repo === "string" && typeof deployment.container === "string"
    && Number.isInteger(deployment.port) && Number.isInteger(deployment.context)
    && typeof deployment.image === "string" && Array.isArray(deployment.flags) && typeof deployment.minVramMiB === "number"
    && !!deployment.lastTest && typeof deployment.lastTest.chat === "boolean" && typeof deployment.lastTest.tools === "boolean"
    && typeof deployment.lastTest.json === "boolean" && typeof deployment.lastTest.tokensPerSecond === "number" && typeof deployment.lastTest.at === "string";
}

export async function writeModelState(system: System, state: ModelState, path = modelStatePath()): Promise<void> {
  await system.mkdir(dirname(path), { mode: 0o700 });
  await system.writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export async function writeState(system: System, state: InstallState): Promise<void> {
  // Readable by everyone: versions and the address aren't secret, and any login can see the
  // status. Secrets in this directory (a Tailscale key, briefly) are written 0600.
  await system.mkdir(PATHS.stateDir, { mode: 0o755 });
  await system.writeFile(PATHS.state, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o644 });
}
