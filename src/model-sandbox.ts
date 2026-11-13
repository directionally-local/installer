import { isAbsolute, normalize } from "node:path";
import { engine } from "./model-engines.js";
import { configureProvider } from "./model-command.js";
import { envFile, HOTCELL_PORT, hotcellBin, parseEnvFile, PATHS, SERVICES, cellImage } from "./layout.js";
import { DEFAULT_DEPLOYMENT, readState, type ModelDeployment, type ModelSandbox } from "./state.js";
import type { System } from "./system.js";
import { compareSemver } from "./versions.js";

/**
 * `dl model up MODEL --workspace DIR`: Autopilot in a Hotcell cell next to the model.
 *
 * The cell (Hotcell's container driver, the image `dl up` builds for agent sessions) gets:
 * - exactly one host path, DIR, bind-mounted read-write at /workspace (Hotcell's
 *   `--workspace-dir`, allowed by adding DIR to HOTCELL_WORKSPACE_ROOTS); no home directory,
 *   no Docker socket, no GPU;
 * - one network, `dl-model[-NAME]-net`, created `--internal` with no host address on it (no
 *   route off the box, no host services)
 *   and shared with the model's container under the alias `model`, so Autopilot's provider is
 *   `http://model:8000/v1` and needs no key. With --allow-internet it also joins
 *   `…-net-egress`, an ordinary bridge with only this cell on it;
 * - Hotcell's gateway is not wired (no `--egress`): the cell holds no tokens.
 * The model's container is unchanged (`docker run` is byte for byte what it was) and joins the
 * network after its tests pass; it never mounts the workspace.
 */

/** The Hotcell release with `--workspace-dir` and `--network` (directionally-local/hotcell#73). */
export const MIN_HOTCELL_FOR_SANDBOX = "0.1.39";
/** The model's DNS name on the sandbox network; the same across updates, so the cell's URL never changes. */
export const MODEL_ALIAS = "model";
/** Caps for the agent's cell: room for builds and tests, a fraction of a GPU box. */
export const SANDBOX_LIMITS = { memoryMb: 8192, cpus: 4, pids: 1024 } as const;
/** Where Autopilot lives in the cell image (layout.ts cellDockerfile). */
export const CELL_AUTOPILOT = "/opt/autopilot/node_modules/.bin/autopilot";
/** Autopilot's config, sessions and caches stay with the project, in DIR/.dl (git-ignored). */
export const SANDBOX_ENV: Readonly<Record<string, string>> = {
  XDG_CONFIG_HOME: "/workspace/.dl/config",
  XDG_STATE_HOME: "/workspace/.dl/state",
  XDG_DATA_HOME: "/workspace/.dl/data",
  XDG_CACHE_HOME: "/workspace/.dl/cache",
  AUTOPILOT_LAUNCHED_BY: "dl",
};

const prefix = (name: string) => (name === DEFAULT_DEPLOYMENT ? "dl-model" : `dl-model-${name}`);
export const sandboxNetwork = (name: string) => `${prefix(name)}-net`;
export const sandboxEgressNetwork = (name: string) => `${sandboxNetwork(name)}-egress`;
export const sandboxName = (name: string) => `${prefix(name)}-agent`;
/** Hotcell's container for a cell (`sbx-<id>`, its container driver's naming). */
export const cellContainer = (id: string) => `sbx-${id}`;

/**
 * Paths a workspace may not be, or be inside, or contain: the system, Docker's and Hotcell's
 * state, dl's install, and home directories (hotcell.service runs with ProtectHome, so it
 * couldn't see them anyway).
 */
const FORBIDDEN = ["/etc", "/root", "/home", "/proc", "/sys", "/dev", "/run", "/var/run", "/boot", "/usr", "/bin", "/sbin", "/lib",
  "/var/lib/docker", "/var/lib/hotcell", "/var/lib/autopilot", "/opt/directionallylocal", "/tmp", "/var/tmp"];

const inside = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/** A workspace path as given: absolute, not /, not a system or home directory, nor holding one. */
export function checkWorkspacePath(text: string): string {
  if (!isAbsolute(text)) throw new Error(`--workspace takes an absolute path (got "${text}").`);
  const path = normalize(text).replace(/\/+$/, "") || "/";
  if (/[,:\n]/.test(path)) throw new Error("--workspace can't contain a comma, a colon or a newline.");
  if (path === "/") throw new Error("--workspace can't be /: give the sandbox one project directory, such as /srv/project.");
  const bad = FORBIDDEN.find((root) => inside(path, root) || inside(root, path));
  if (bad) throw new Error(`--workspace ${path} ${inside(path, bad) ? "is inside" : "contains"} ${bad}; use a project directory such as /srv/project (home directories aren't visible to Hotcell's service).`);
  return path;
}

/** Autopilot's provider in the cell: the local model by its network alias, no key. */
export function sandboxProvider(deployment: Pick<ModelDeployment, "repo" | "engine">): { baseUrl: string; config: Record<string, unknown> } {
  const baseUrl = `http://${MODEL_ALIAS}:${engine(deployment.engine).containerPort}/v1`;
  return { baseUrl, config: { provider: "vllm", model: deployment.repo, providers: { vllm: { model: deployment.repo, baseUrl } } } };
}

export const sandboxConfigPath = (workspace: string) => `${workspace}/.dl/config/autopilot/config.json`;

export interface SandboxSpec {
  name: string;
  workspace: string;
  internet: boolean;
  image: string;
}

/** The commands that build the sandbox, in order: networks, the model's alias, the cell. */
export function sandboxCommands(spec: SandboxSpec, modelContainer: string): { networks: string[][]; connect: string[]; create: string[] } {
  const net = sandboxNetwork(spec.name);
  const labels = ["--label", "hotcell.attachable=true", "--label", `dl.model.deployment=${spec.name}`];
  // --internal: Docker gives the network no route off the box. inhibit_ipv4: the host takes no
  // address on it either, so host services listening on all addresses aren't reachable from it.
  const networks = [["network", "create", "--internal", "-o", "com.docker.network.bridge.inhibit_ipv4=true", ...labels, net],
    ...(spec.internet ? [["network", "create", ...labels, sandboxEgressNetwork(spec.name)]] : [])];
  const create = ["create", "--name", sandboxName(spec.name), "--image", spec.image, "--driver", "container",
    "--workspace-dir", spec.workspace, "--network", [net, ...(spec.internet ? [sandboxEgressNetwork(spec.name)] : [])].join(","),
    "--memory", String(SANDBOX_LIMITS.memoryMb), "--cpus", String(SANDBOX_LIMITS.cpus), "--pids", String(SANDBOX_LIMITS.pids),
    "--label", `dl.model.deployment=${spec.name}`,
    "--env", Object.entries(SANDBOX_ENV).map(([key, value]) => `${key}=${value}`).join(",")];
  return { networks, connect: ["network", "connect", "--alias", MODEL_ALIAS, net, modelContainer], create };
}

/** `docker exec -it …`: Autopilot in the cell, in the workspace. */
export function attachArgs(sandbox: Pick<ModelSandbox, "container">, extra: readonly string[] = []): string[] {
  return ["exec", "-it", "-w", "/workspace", sandbox.container, CELL_AUTOPILOT, ...extra];
}

/** What a sandbox needs from this machine, found before the model starts. */
export interface SandboxHost { image: string; apiKey: string; workspace: string }

/**
 * Before anything starts: a dl server install (Hotcell's service and the cell image), a Hotcell
 * new enough for host workspaces, root (Hotcell's settings are root's), and a workspace the
 * Hotcell service user can reach. Returns the workspace's real path (symlinks resolved).
 */
export async function sandboxPreflight(system: System, workspaceText: string): Promise<SandboxHost> {
  const given = checkWorkspacePath(workspaceText);
  const install = await readState(system);
  if (!install) throw new Error("--workspace runs the agent in a Hotcell sandbox, which needs dl's server install: run sudo dl up first (Hotcell, and the image agents run in).");
  if (compareSemver(install.hotcellVersion, MIN_HOTCELL_FOR_SANDBOX) < 0) {
    throw new Error(`Hotcell ${install.hotcellVersion} can't mount one workspace or join the model's network; --workspace needs Hotcell ${MIN_HOTCELL_FOR_SANDBOX} or newer (sudo dl up updates it).`);
  }
  const env = parseEnvFile(await system.readFile(PATHS.hotcellEnv));
  if (!env.HOTCELL_API_KEY) throw new Error(`Can't read Hotcell's settings (${PATHS.hotcellEnv}); run dl model up --workspace as root (sudo).`);
  if (!(await system.exists(hotcellBin()))) throw new Error("Hotcell isn't installed here; run sudo dl up first.");
  const real = await system.probe("realpath", ["-e", given]);
  if (real.code !== 0) throw new Error(`--workspace ${given} doesn't exist; create the directory first.`);
  const workspace = checkWorkspacePath(real.stdout.trim());
  if ((await system.probe("test", ["-d", workspace])).code !== 0) throw new Error(`--workspace ${workspace} isn't a directory.`);
  // hotcell.service checks the path itself (it resolves symlinks against its allow list).
  if ((await system.probe("runuser", ["-u", "hotcell", "--", "test", "-x", workspace])).code !== 0) {
    throw new Error(`Hotcell's service user can't reach ${workspace}; let it in (e.g. chmod o+x on each parent directory) or pick a directory under /srv.`);
  }
  if ((await system.probe("docker", ["image", "inspect", install.image])).code !== 0) throw new Error(`The agent image ${install.image} is missing; sudo dl up rebuilds it.`);
  return { image: install.image, apiKey: env.HOTCELL_API_KEY, workspace };
}

/** The image the plan names: what dl's server install builds for the pinned Autopilot. */
export function plannedImage(autopilotVersion: string): string {
  return cellImage(autopilotVersion);
}

async function hotcell(system: System, apiKey: string, args: string[]) {
  return system.run("/usr/bin/node", [hotcellBin(), ...args], {
    env: { HOTCELL_API_KEY: apiKey, HOTCELL_ENDPOINT: `http://127.0.0.1:${HOTCELL_PORT}`, NO_COLOR: "1" },
    describe: `hotcell ${args.join(" ")}`,
  });
}

/** HOTCELL_WORKSPACE_ROOTS with `dir` added (add) or taken out; true when the file changed. */
export async function setWorkspaceRoot(system: System, dir: string, add: boolean): Promise<boolean> {
  const values = parseEnvFile(await system.readFile(PATHS.hotcellEnv));
  const roots = (values.HOTCELL_WORKSPACE_ROOTS ?? "").split(",").filter(Boolean);
  const next = add ? [...new Set([...roots, dir])] : roots.filter((root) => root !== dir);
  if (next.join(",") === roots.join(",")) return false;
  if (next.length) values.HOTCELL_WORKSPACE_ROOTS = next.join(",");
  else delete values.HOTCELL_WORKSPACE_ROOTS;
  await system.writeFile(PATHS.hotcellEnv, envFile("Hotcell daemon (sandboxes + credential gateway)", values), { mode: 0o640, owner: "root:hotcell", secret: true });
  return true;
}

async function restartHotcell(system: System, sleep: (ms: number) => Promise<void>): Promise<void> {
  await system.run("systemctl", ["restart", SERVICES.hotcell]);
  if (system.dryRun) return;
  for (let attempt = 0; attempt < 60; attempt++) {
    if ((await system.probe("curl", ["-fsS", "-o", "/dev/null", `http://127.0.0.1:${HOTCELL_PORT}/`])).code === 0) return;
    await sleep(1000);
  }
  throw new Error("Hotcell didn't come back after adding the workspace; check: journalctl -u hotcell -n 50");
}

/**
 * What `docker inspect` must show for the cell, checked right after Hotcell creates it (an
 * older Hotcell would ignore the options and give a volume and the default bridge): exactly one
 * workspace mount, the host directory; no other host path but Hotcell's agent binary (read-only)
 * and socket directory; no Docker socket; only the sandbox networks; no GPU; not privileged.
 */
export function checkCellInspect(text: string, expected: { workspace: string; networks: readonly string[] }): string[] {
  const problems: string[] = [];
  let parsed: { Mounts?: Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean }>; Networks?: Record<string, unknown>; DeviceRequests?: unknown[] | null; Privileged?: boolean };
  try { parsed = JSON.parse(text) as typeof parsed; } catch { return ["docker inspect gave no readable answer"]; }
  const mounts = parsed.Mounts ?? [];
  const workspace = mounts.filter((mount) => mount.Destination === "/workspace");
  if (workspace.length !== 1 || workspace[0]!.Type !== "bind" || workspace[0]!.Source !== expected.workspace || workspace[0]!.RW === false) {
    problems.push(`/workspace is ${workspace.map((mount) => `${mount.Type} ${mount.Source ?? ""}`).join(", ") || "not mounted"}, not ${expected.workspace}`);
  }
  for (const mount of mounts) {
    if (mount.Destination === "/workspace") continue;
    const agent = mount.Destination === "/hotcell-agent" && mount.RW === false;
    const socket = mount.Destination === "/run/hotcell" && (mount.Source ?? "").includes("hotcell");
    if (!agent && !socket) problems.push(`unexpected mount ${mount.Source ?? "?"} → ${mount.Destination ?? "?"}`);
  }
  if (mounts.some((mount) => /docker\.sock/.test(`${mount.Source ?? ""}${mount.Destination ?? ""}`))) problems.push("the Docker socket is mounted");
  const networks = Object.keys(parsed.Networks ?? {}).sort();
  if (networks.join(",") !== [...expected.networks].sort().join(",")) problems.push(`networks are ${networks.join(", ") || "none"}, not ${expected.networks.join(", ")}`);
  if (parsed.DeviceRequests && parsed.DeviceRequests.length) problems.push("the cell can request GPUs");
  if (parsed.Privileged) problems.push("the cell is privileged");
  return problems;
}

export const INSPECT_FORMAT = '{"Mounts":{{json .Mounts}},"Networks":{{json .NetworkSettings.Networks}},"DeviceRequests":{{json .HostConfig.DeviceRequests}},"Privileged":{{json .HostConfig.Privileged}}}';

/**
 * Checks run inside the cell once it is up; each failure exits with its own code. The model
 * answers at its alias; the workspace is writable; no Docker socket and no GPU device; and,
 * without --allow-internet, nothing outside answers.
 */
export function cellChecks(baseUrl: string, internet: boolean): string {
  const fetchOk = (url: string) => `node -e "fetch('${url}',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"`;
  return [
    `${fetchOk(`${baseUrl}/models`)} || exit 11`,
    "test -w /workspace || exit 12",
    "test ! -e /var/run/docker.sock && test ! -e /run/docker.sock || exit 13",
    "! ls /dev/nvidia* >/dev/null 2>&1 || exit 14",
    ...(internet ? [] : [`! ${fetchOk("https://registry.npmjs.org/")} || exit 15`, "! awk 'NR>1 && $2==\"00000000\"' /proc/net/route | grep -q . || exit 16"]),
  ].join("; ");
}

const CHECK_FAILURES: Record<number, string> = {
  11: "the model doesn't answer from the sandbox",
  12: "the workspace isn't writable from the sandbox (the cell runs as root; check the directory's mount options)",
  13: "the Docker socket is visible in the sandbox",
  14: "a GPU device is visible in the sandbox",
  15: "the internet answers from a sandbox that shouldn't reach it",
  16: "the sandbox has a default route (its network should be internal)",
};

export interface AttachOptions {
  system: System;
  host: SandboxHost;
  name: string;
  internet: boolean;
  sleep?: (ms: number) => Promise<void>;
  step?: (label: string, detail?: string) => void;
}

/**
 * Builds the sandbox for a serving deployment and checks it; undoes its own steps when one
 * fails (the model keeps serving).
 */
export async function attachSandbox(options: AttachOptions, deployment: ModelDeployment): Promise<ModelSandbox> {
  const { system, host, name, internet } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const spec: SandboxSpec = { name, workspace: host.workspace, internet, image: host.image };
  const commands = sandboxCommands(spec, deployment.container);
  const networks = [sandboxNetwork(name), ...(internet ? [sandboxEgressNetwork(name)] : [])];
  const undo: Array<() => Promise<unknown>> = [];
  try {
    for (const args of commands.networks) {
      const network = args.at(-1)!;
      if ((await system.probe("docker", ["network", "inspect", network])).code === 0) await system.run("docker", ["network", "rm", network]);
      await system.run("docker", args);
      undo.push(() => system.run("docker", ["network", "rm", network], { allowFailure: true }));
    }
    await system.run("docker", commands.connect);
    undo.push(() => system.run("docker", ["network", "disconnect", "-f", sandboxNetwork(name), deployment.container], { allowFailure: true }));
    options.step?.("Network", `${networks.join(" + ")} · the model as ${MODEL_ALIAS}`);
    if (await setWorkspaceRoot(system, host.workspace, true)) {
      undo.push(async () => { if (await setWorkspaceRoot(system, host.workspace, false)) await restartHotcell(system, sleep); });
      await restartHotcell(system, sleep);
    }
    const provider = sandboxProvider(deployment);
    await system.mkdir(`${host.workspace}/.dl`, { mode: 0o755 });
    await system.writeFile(`${host.workspace}/.dl/.gitignore`, "# dl's sandbox: Autopilot's config, sessions and caches\n*\n", { mode: 0o644 });
    await writeSandboxConfig(system, host.workspace, deployment);
    const created = await hotcell(system, host.apiKey, commands.create);
    const id = created.stdout.trim().split("\n").at(-1)?.trim() ?? "";
    if (!/^[0-9a-f]{6,64}$/.test(id) && !system.dryRun) throw new Error(`Hotcell didn't return a sandbox id (got "${id}")`);
    undo.push(() => hotcell(system, host.apiKey, ["rm", id]).catch(() => undefined));
    const sandbox: ModelSandbox = { id: id || "dry-run", container: cellContainer(id || "dry-run"), workspace: host.workspace, networks, internet, image: host.image, createdAt: new Date().toISOString() };
    if (!system.dryRun) {
      const inspect = await system.probe("docker", ["inspect", "--format", INSPECT_FORMAT, sandbox.container]);
      const problems = checkCellInspect(inspect.stdout, { workspace: host.workspace, networks });
      if (problems.length) throw new Error(`The sandbox isn't isolated as planned: ${problems.join("; ")}`);
      const model = await system.probe("docker", ["inspect", "--format", "{{json .Mounts}}", deployment.container]);
      if (model.stdout.includes(host.workspace)) throw new Error(`The model container ${deployment.container} can see ${host.workspace}`);
      const checked = await system.probe("docker", ["exec", sandbox.container, "sh", "-c", cellChecks(provider.baseUrl, internet)]);
      if (checked.code !== 0) throw new Error(`Sandbox check failed: ${CHECK_FAILURES[checked.code] ?? `exit ${checked.code}: ${(checked.stderr || checked.stdout).trim().split("\n").at(-1)}`}`);
    }
    options.step?.("Sandbox", `${sandboxName(name)} (${id || "dry run"}) · ${host.workspace} → /workspace · ${internet ? "internet allowed" : "no internet"}`);
    return sandbox;
  } catch (error) {
    if (!system.dryRun) for (const step of undo.reverse()) await step().catch(() => undefined);
    throw error;
  }
}

/** The cell's Autopilot config, in the workspace (the cell's XDG_CONFIG_HOME), pointed at `deployment`. */
export async function writeSandboxConfig(system: System, workspace: string, deployment: ModelDeployment): Promise<void> {
  // Same merge as the host's config, so a model picked in the cell's /model menu for another provider survives.
  await configureProvider({ system }, { ...deployment, host: MODEL_ALIAS, port: engine(deployment.engine).containerPort }, sandboxConfigPath(workspace));
}

/** After an update or rollback switched: the alias moves to `next`, and the cell's config names its model. */
export async function repointSandbox(system: System, sandbox: ModelSandbox, next: ModelDeployment, old: ModelDeployment | undefined): Promise<void> {
  const network = sandbox.networks[0]!;
  if (old && old.container !== next.container) await system.run("docker", ["network", "disconnect", "-f", network, old.container], { allowFailure: true });
  await system.run("docker", ["network", "disconnect", "-f", network, next.container], { allowFailure: true });
  await system.run("docker", ["network", "connect", "--alias", MODEL_ALIAS, network, next.container]);
  await writeSandboxConfig(system, sandbox.workspace, next);
}

/** `dl model down`: the cell, its networks and its workspace permission; never the workspace's files. */
export async function removeSandbox(system: System, sandbox: ModelSandbox, sleep?: (ms: number) => Promise<void>): Promise<void> {
  const env = parseEnvFile(await system.readFile(PATHS.hotcellEnv));
  if (env.HOTCELL_API_KEY) await hotcell(system, env.HOTCELL_API_KEY, ["rm", sandbox.id]).catch(() => undefined);
  else await system.run("docker", ["rm", "-f", sandbox.container], { allowFailure: true });
  for (const network of [...sandbox.networks].reverse()) await system.run("docker", ["network", "rm", network], { allowFailure: true });
  if (await setWorkspaceRoot(system, sandbox.workspace, false)) await restartHotcell(system, sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms))));
}
