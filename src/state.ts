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
  /** Where the API listens on this machine; 127.0.0.1 (the published address) when unset. */
  host?: string;
  context: number;
  /** Kept so rollback can restart this exact recipe even if the catalog changes. */
  image: string;
  /** Set when `image` came from --image: the catalog's image it replaced. */
  catalogImage?: string;
  flags: readonly string[];
  minVramMiB: number;
  /** Fraction of GPU VRAM this deployment reserves; kept for rollback. */
  gpuMemoryUtilization?: number;
  /** A multi-GPU deployment's layout: host GPU indices and tensor/pipeline/expert parallel sizes. */
  parallel?: { gpus: number[]; tp: number; pp: number; ep: boolean };
  /** The deployment's name, when it isn't the default one. */
  name?: string;
  /** Host GPUs the container is limited to (`--gpus "device=…"`); unset: it sees every GPU. */
  devices?: number[];
  /** The container's memory limit in bytes (`--memory`), for models that keep weights in host RAM. */
  memoryBytes?: number;
  /** Container environment (`-e`), when the recipe sets any; kept for rollback. */
  env?: Record<string, string>;
  /** The serving engine; vLLM when unset. */
  engine?: "vllm" | "sglang";
  lastTest: { chat: boolean; tools: boolean; json: boolean; tokensPerSecond: number; at: string };
}

/**
 * Autopilot in a Hotcell cell beside a deployment (`dl model up --workspace`): the cell sees one
 * host directory and reaches the model on `networks[0]`; the deployment's update keeps it.
 */
export interface ModelSandbox {
  /** Hotcell's sandbox id, and its Docker container (`sbx-<id>`). */
  id: string;
  container: string;
  /** The host directory mounted at /workspace (its real path). */
  workspace: string;
  /** The internal network shared with the model, then the egress network with --allow-internet. */
  networks: string[];
  internet: boolean;
  image: string;
  createdAt: string;
}

export interface ModelState { version: 1; active: ModelDeployment; previous?: ModelDeployment; sandbox?: ModelSandbox }

/** The name of the deployment `dl model` works on without --name (the only one before named deployments). */
export const DEFAULT_DEPLOYMENT = "default";

/**
 * Several deployments on one machine, by name, each with its own containers, port and GPUs.
 * Written as version 2 only once there is more than the default one, so a machine with a single
 * unnamed deployment keeps the version 1 file earlier dl versions read.
 */
export interface ModelStateV2 { version: 2; deployments: Record<string, Omit<ModelState, "version">> }

/** Every deployment by name (the version 1 file's is "default"); empty when there is none. */
export async function readDeployments(system: System, path = modelStatePath()): Promise<Record<string, Omit<ModelState, "version">>> {
  const raw = await system.readFile(path);
  if (!raw) return {};
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(`Invalid model state at ${path}; fix it before changing containers.`); }
  if ((value as { version?: unknown } | null)?.version === 1) {
    const state = await readModelState(system, path);
    return state ? { [DEFAULT_DEPLOYMENT]: { active: state.active, ...(state.previous ? { previous: state.previous } : {}), ...(state.sandbox ? { sandbox: state.sandbox } : {}) } } : {};
  }
  const deployments = (value as Partial<ModelStateV2> | null)?.deployments;
  if ((value as { version?: unknown }).version !== 2 || !deployments || typeof deployments !== "object" || Array.isArray(deployments)
    || !Object.values(deployments).every((entry) => entry && validDeployment(entry.active) && (entry.previous === undefined || validDeployment(entry.previous)) && (entry.sandbox === undefined || validSandbox(entry.sandbox)))) {
    throw new Error(`Invalid model state at ${path}; fix it before changing containers.`);
  }
  return deployments;
}

/** Sets (or, with undefined, removes) one deployment and keeps the others. */
export async function writeDeployment(system: System, name: string, entry: Omit<ModelState, "version"> | undefined, path = modelStatePath()): Promise<void> {
  const all = { ...(await readDeployments(system, path)) };
  if (entry) all[name] = entry;
  else delete all[name];
  const names = Object.keys(all);
  if (names.length === 0) { await system.remove(path); return; }
  if (names.length === 1 && names[0] === DEFAULT_DEPLOYMENT) {
    const only = all[DEFAULT_DEPLOYMENT]!;
    await writeModelState(system, { version: 1, active: only.active, ...(only.previous ? { previous: only.previous } : {}), ...(only.sandbox ? { sandbox: only.sandbox } : {}) }, path);
    return;
  }
  await system.mkdir(dirname(path), { mode: 0o700 });
  await system.writeFile(path, `${JSON.stringify({ version: 2, deployments: all } satisfies ModelStateV2, null, 2)}\n`, { mode: 0o600 });
}

export function modelStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_STATE_HOME?.trim() || join(env.HOME || homedir(), ".local", "state"), "directionallylocal", "model.json");
}

/** The default deployment (all the first-run setup knows about), from either file version. */
export async function readModelState(system: System, path = modelStatePath()): Promise<ModelState | undefined> {
  const raw = await system.readFile(path);
  if (!raw) return undefined;
  if (/"version":\s*2\b/.test(raw)) {
    const entry = (await readDeployments(system, path))[DEFAULT_DEPLOYMENT];
    return entry ? { version: 1, ...entry } : undefined;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") throw new Error("invalid model state");
    const state = value as Partial<ModelState>;
    if (state.version !== 1 || !validDeployment(state.active) || (state.previous !== undefined && !validDeployment(state.previous)) || (state.sandbox !== undefined && !validSandbox(state.sandbox))) throw new Error("invalid model state");
    return state as ModelState;
  } catch { throw new Error(`Invalid model state at ${path}; fix it before changing containers.`); }
}

function validSandbox(value: unknown): value is ModelSandbox {
  const sandbox = value as Partial<ModelSandbox> | null;
  return !!sandbox && typeof sandbox === "object" && typeof sandbox.id === "string" && typeof sandbox.container === "string"
    && typeof sandbox.workspace === "string" && Array.isArray(sandbox.networks) && sandbox.networks.length > 0 && typeof sandbox.internet === "boolean";
}

function validDeployment(value: unknown): value is ModelDeployment {
  if (!value || typeof value !== "object") return false;
  const deployment = value as Partial<ModelDeployment>;
  return typeof deployment.id === "string" && typeof deployment.repo === "string" && typeof deployment.container === "string"
    && Number.isInteger(deployment.port) && Number.isInteger(deployment.context)
    && typeof deployment.image === "string" && (deployment.catalogImage === undefined || typeof deployment.catalogImage === "string") && Array.isArray(deployment.flags) && typeof deployment.minVramMiB === "number"
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
