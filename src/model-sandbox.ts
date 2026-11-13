import { dirname, isAbsolute, normalize } from "node:path";
import { engine } from "./model-engines.js";
import { providerConfigText } from "./model-command.js";
import { envFile, HOTCELL_PORT, hotcellBin, parseEnvFile, PATHS, SERVICES, cellImage } from "./layout.js";
import { DEFAULT_DEPLOYMENT, readState, type ModelDeployment, type ModelSandbox } from "./state.js";
import type { System } from "./system.js";
import { compareSemver } from "./versions.js";

/**
 * `dl model up MODEL --workspace DIR`: Autopilot in a Hotcell cell next to the model.
 *
 * The cell (Hotcell's container driver, the image `dl up` builds for agent sessions) gets:
 * - exactly two host paths: DIR, bind-mounted read-write at /workspace (Hotcell's
 *   `--workspace-dir`, allowed by adding DIR to HOTCELL_WORKSPACE_ROOTS), and the agent's home,
 *   /var/lib/directionallylocal/workspaces/NAME/home, read-write at /home/agent (`--home-dir`,
 *   allowed by HOTCELL_HOME_ROOTS). HOME and every XDG directory (Autopilot's config, sessions and
 *   caches) are in that home, so nothing dl writes lands in DIR. No host home directory, no Docker
 *   socket, no GPU;
 * - one network, `dl-model[-NAME]-net`, created `--internal` with no host address on it (no
 *   route off the box, no host services)
 *   and shared with the model's container under the alias `model`, so Autopilot's provider is
 *   `http://model:8000/v1` and needs no key. With --allow-internet it also joins
 *   `…-net-egress`, an ordinary bridge with only this cell on it;
 * - Hotcell's gateway is not wired (no `--egress`): the cell holds no tokens;
 * - the uid:gid that owns DIR (Hotcell's `--user`), so the files the agent writes are the
 *   owner's; root only when root owns DIR. HOME, USER and LOGNAME are set, since the uid may have
 *   no passwd entry in the image.
 * The model's container is unchanged (`docker run` is byte for byte what it was) and joins the
 * network after its tests pass; it never mounts the workspace.
 */

/** The Hotcell release with `--workspace-dir`, `--network`, `--user` and `--home-dir` (hotcell#73, hotcell#75). */
export const MIN_HOTCELL_FOR_SANDBOX = "0.1.40";
/** Where the agent's home is mounted in the cell (Hotcell's `--home-dir`). */
export const SANDBOX_HOME = "/home/agent";
/** The host directory that holds each deployment's agent home (HOTCELL_HOME_ROOTS). */
export const HOMES_ROOT = "/var/lib/directionallylocal/workspaces";
/** The agent's home on the host for a deployment. */
export const sandboxHomeDir = (name: string) => `${HOMES_ROOT}/${name}/home`;
/** Directories dl makes in the home, as the user the cell runs as. */
const HOME_DIRS = [".config", ".config/autopilot", ".local", ".local/state", ".local/share", ".cache"];
/** A file the agent creates in /workspace from inside the cell; its owner on the host is checked, then it is removed. */
const OWNER_CHECK = ".dl-owner-check";
/** The model's DNS name on the sandbox network; the same across updates, so the cell's URL never changes. */
export const MODEL_ALIAS = "model";
/** Caps for the agent's cell: room for builds and tests, a fraction of a GPU box. */
export const SANDBOX_LIMITS = { memoryMb: 8192, cpus: 4, pids: 1024 } as const;
/** Where Autopilot lives in the cell image (layout.ts cellDockerfile). */
export const CELL_AUTOPILOT = "/opt/autopilot/node_modules/.bin/autopilot";
/** Autopilot's config, sessions and caches: all in the agent's home, outside the workspace. */
export const SANDBOX_ENV: Readonly<Record<string, string>> = {
  HOME: SANDBOX_HOME,
  XDG_CONFIG_HOME: `${SANDBOX_HOME}/.config`,
  XDG_STATE_HOME: `${SANDBOX_HOME}/.local/state`,
  XDG_DATA_HOME: `${SANDBOX_HOME}/.local/share`,
  XDG_CACHE_HOME: `${SANDBOX_HOME}/.cache`,
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
 * state, dl's install and the agents' homes, and home directories (hotcell.service runs with
 * ProtectHome, so it couldn't see them anyway).
 */
const FORBIDDEN = ["/etc", "/root", "/home", "/proc", "/sys", "/dev", "/run", "/var/run", "/boot", "/usr", "/bin", "/sbin", "/lib",
  "/var/lib/docker", "/var/lib/hotcell", "/var/lib/autopilot", "/var/lib/directionallylocal", "/opt/directionallylocal", "/tmp", "/var/tmp"];

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

/** The cell's Autopilot config on the host: in the agent's home (its XDG_CONFIG_HOME). */
export const sandboxConfigPath = (home: string) => `${home}/.config/autopilot/config.json`;

export interface SandboxSpec {
  name: string;
  workspace: string;
  internet: boolean;
  image: string;
  /** The workspace owner's numeric uid:gid; absent when root owns it (the cell runs as root). */
  user?: string | undefined;
}

/** Who owns the workspace: the cell runs as them. */
export interface WorkspaceOwner { uid: number; gid: number }

/** The uid:gid the cell runs as, or undefined for root (as before). */
export const ownerUser = (owner: WorkspaceOwner): string | undefined => (owner.uid === 0 ? undefined : `${owner.uid}:${owner.gid}`);
/** "1000:1000" or "root", for messages and status lines. */
export const userText = (user: string | undefined): string => user ?? "root";

/** `stat` of the workspace (its real path): the owner's uid and gid. */
export async function workspaceOwner(system: System, workspace: string): Promise<WorkspaceOwner> {
  const result = await system.probe("stat", ["-c", "%u:%g", workspace]);
  const match = /^(\d+):(\d+)$/.exec(result.stdout.trim());
  if (result.code !== 0 || !match) throw new Error(`Can't read who owns ${workspace} (stat failed); the agent runs as the folder's owner.`);
  return { uid: Number(match[1]), gid: Number(match[2]) };
}

/** `setpriv` arguments that run `args` as `user` (numeric uid:gid, no supplementary groups); root when absent. */
const asUser = (user: string | undefined, args: string[]) => {
  const [uid, gid] = (user ?? "0:0").split(":");
  return ["--reuid", uid!, "--regid", gid!, "--clear-groups", "--", ...args];
};

/**
 * The cell's environment: HOME and the XDG directories in the agent's home, and for a non-root
 * owner USER and LOGNAME too, so Autopilot, git and npm never need a passwd entry for the uid.
 */
export function sandboxEnv(spec: Pick<SandboxSpec, "user">): Record<string, string> {
  return { ...SANDBOX_ENV, ...(spec.user ? { USER: "dl", LOGNAME: "dl" } : {}) };
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
    "--workspace-dir", spec.workspace, "--home-dir", sandboxHomeDir(spec.name), ...(spec.user ? ["--user", spec.user] : []),
    "--network", [net, ...(spec.internet ? [sandboxEgressNetwork(spec.name)] : [])].join(","),
    "--memory", String(SANDBOX_LIMITS.memoryMb), "--cpus", String(SANDBOX_LIMITS.cpus), "--pids", String(SANDBOX_LIMITS.pids),
    "--label", `dl.model.deployment=${spec.name}`,
    "--env", Object.entries(sandboxEnv(spec)).map(([key, value]) => `${key}=${value}`).join(",")];
  return { networks, connect: ["network", "connect", "--alias", MODEL_ALIAS, net, modelContainer], create };
}

/** `docker exec -it …`: Autopilot in the cell, in the workspace, as the user the cell runs as. */
export function attachArgs(sandbox: Pick<ModelSandbox, "container" | "user">, extra: readonly string[] = []): string[] {
  return ["exec", "-it", ...(sandbox.user ? ["-u", sandbox.user] : []), "-w", "/workspace", sandbox.container, CELL_AUTOPILOT, ...extra];
}

/** What a sandbox needs from this machine, found before the model starts. */
export interface SandboxHost { image: string; apiKey: string; workspace: string; owner: WorkspaceOwner }

/**
 * Before anything starts: a dl server install (Hotcell's service and the cell image), a Hotcell
 * new enough for host workspaces, a home outside them and a cell user, root (Hotcell's settings
 * are root's), and a workspace the Hotcell service user can reach. Returns the workspace's real
 * path (symlinks resolved) and its owner, whom the agent runs as.
 */
export async function sandboxPreflight(system: System, workspaceText: string): Promise<SandboxHost> {
  const given = checkWorkspacePath(workspaceText);
  const install = await readState(system);
  if (!install) throw new Error("--workspace runs the agent in a Hotcell sandbox, which needs dl's server install: run sudo dl up first (Hotcell, and the image agents run in).");
  if (compareSemver(install.hotcellVersion, MIN_HOTCELL_FOR_SANDBOX) < 0) {
    throw new Error(`Hotcell ${install.hotcellVersion} can't run the agent as the workspace's owner with its home outside the workspace; --workspace needs Hotcell ${MIN_HOTCELL_FOR_SANDBOX} or newer (sudo dl up installs the Hotcell this dl pins). dl never falls back to running the agent as root.`);
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
  const owner = await workspaceOwner(system, workspace);
  if ((await system.probe("docker", ["image", "inspect", install.image])).code !== 0) throw new Error(`The agent image ${install.image} is missing; sudo dl up rebuilds it.`);
  return { image: install.image, apiKey: env.HOTCELL_API_KEY, workspace, owner };
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

/** A comma-separated root list in Hotcell's settings with `dir` added or taken out; true when it changed. */
async function setHotcellRoot(system: System, key: "HOTCELL_WORKSPACE_ROOTS" | "HOTCELL_HOME_ROOTS", dir: string, add: boolean): Promise<boolean> {
  const values = parseEnvFile(await system.readFile(PATHS.hotcellEnv));
  const roots = (values[key] ?? "").split(",").filter(Boolean);
  const next = add ? [...new Set([...roots, dir])] : roots.filter((root) => root !== dir);
  if (next.join(",") === roots.join(",")) return false;
  if (next.length) values[key] = next.join(",");
  else delete values[key];
  await system.writeFile(PATHS.hotcellEnv, envFile("Hotcell daemon (sandboxes + credential gateway)", values), { mode: 0o640, owner: "root:hotcell", secret: true });
  return true;
}

/** HOTCELL_WORKSPACE_ROOTS with `dir` added (add) or taken out; true when the file changed. */
export const setWorkspaceRoot = (system: System, dir: string, add: boolean) => setHotcellRoot(system, "HOTCELL_WORKSPACE_ROOTS", dir, add);

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
 * older Hotcell would ignore the options and give a volume, the default bridge and root):
 * exactly two host directories, the workspace and the agent's home, both read-write; no other
 * host path but Hotcell's agent binary (read-only) and socket directory; no Docker socket; only
 * the sandbox networks; no GPU; not privileged; the expected user.
 */
export function checkCellInspect(text: string, expected: { workspace: string; home: string; networks: readonly string[]; user?: string | undefined }): string[] {
  const problems: string[] = [];
  let parsed: { Mounts?: Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean }>; Networks?: Record<string, unknown>; DeviceRequests?: unknown[] | null; Privileged?: boolean; User?: string };
  try { parsed = JSON.parse(text) as typeof parsed; } catch { return ["docker inspect gave no readable answer"]; }
  const mounts = parsed.Mounts ?? [];
  for (const [destination, source] of [["/workspace", expected.workspace], [SANDBOX_HOME, expected.home]] as const) {
    const found = mounts.filter((mount) => mount.Destination === destination);
    if (found.length !== 1 || found[0]!.Type !== "bind" || found[0]!.Source !== source || found[0]!.RW === false) {
      problems.push(`${destination} is ${found.map((mount) => `${mount.Type} ${mount.Source ?? ""}`).join(", ") || "not mounted"}, not ${source}`);
    }
  }
  for (const mount of mounts) {
    if (mount.Destination === "/workspace" || mount.Destination === SANDBOX_HOME) continue;
    const agent = mount.Destination === "/hotcell-agent" && mount.RW === false;
    const socket = mount.Destination === "/run/hotcell" && (mount.Source ?? "").includes("hotcell");
    if (!agent && !socket) problems.push(`unexpected mount ${mount.Source ?? "?"} → ${mount.Destination ?? "?"}`);
  }
  if (mounts.some((mount) => /docker\.sock/.test(`${mount.Source ?? ""}${mount.Destination ?? ""}`))) problems.push("the Docker socket is mounted");
  const networks = Object.keys(parsed.Networks ?? {}).sort();
  if (networks.join(",") !== [...expected.networks].sort().join(",")) problems.push(`networks are ${networks.join(", ") || "none"}, not ${expected.networks.join(", ")}`);
  if (parsed.DeviceRequests && parsed.DeviceRequests.length) problems.push("the cell can request GPUs");
  if (parsed.Privileged) problems.push("the cell is privileged");
  // An older Hotcell ignores --user: the cell would run as root.
  const user = parsed.User ?? "";
  if (expected.user ? user !== expected.user : !/^(|root|0|0:0)$/.test(user)) problems.push(`the cell runs as ${user || "root"}, not ${userText(expected.user)}`);
  return problems;
}

export const INSPECT_FORMAT = '{"Mounts":{{json .Mounts}},"Networks":{{json .NetworkSettings.Networks}},"DeviceRequests":{{json .HostConfig.DeviceRequests}},"Privileged":{{json .HostConfig.Privileged}},"User":{{json .Config.User}}}';

/**
 * Checks run inside the cell once it is up, as the user the cell runs as; each failure exits with
 * its own code. The model answers at its alias; the agent is that user; the workspace and its home
 * are writable (and the agent writes a file whose host owner dl checks next); no Docker socket and
 * no GPU device; and, without --allow-internet, nothing outside answers.
 */
export function cellChecks(baseUrl: string, internet: boolean, user?: string): string {
  const fetchOk = (url: string) => `node -e "fetch('${url}',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"`;
  return [
    `${fetchOk(`${baseUrl}/models`)} || exit 11`,
    "test -w /workspace || exit 12",
    `test "$(id -u):$(id -g)" = "${user ?? "0:0"}" || exit 17`,
    `test "$HOME" = ${SANDBOX_HOME} && test -w ${SANDBOX_HOME} || exit 18`,
    `touch /workspace/${OWNER_CHECK} || exit 12`,
    "test ! -e /var/run/docker.sock && test ! -e /run/docker.sock || exit 13",
    "! ls /dev/nvidia* >/dev/null 2>&1 || exit 14",
    ...(internet ? [] : [`! ${fetchOk("https://registry.npmjs.org/")} || exit 15`, "! awk 'NR>1 && $2==\"00000000\"' /proc/net/route | grep -q . || exit 16"]),
  ].join("; ");
}

const CHECK_FAILURES: Record<number, string> = {
  11: "the model doesn't answer from the sandbox",
  12: "the workspace isn't writable from the sandbox (check the directory's owner and mount options)",
  13: "the Docker socket is visible in the sandbox",
  14: "a GPU device is visible in the sandbox",
  15: "the internet answers from a sandbox that shouldn't reach it",
  16: "the sandbox has a default route (its network should be internal)",
  17: "the agent in the sandbox doesn't run as the workspace's owner",
  18: `the agent's home (${SANDBOX_HOME}) isn't its HOME or isn't writable`,
};

/**
 * What is in the workspace, for comparing before and after the cell is made: every path (find,
 * as root: it runs nothing from the workspace) and, in a git repository, `git status` run as the
 * owner (a repository's config can run commands) without taking git's index lock.
 */
async function workspaceSnapshot(system: System, workspace: string, user: string | undefined): Promise<{ paths: Set<string>; git: string }> {
  const listing = await system.probe("find", [workspace, "-mindepth", "1", "-printf", "%P\\n"]);
  const git = await system.probe("setpriv", asUser(user, ["env", "HOME=/nonexistent", "GIT_OPTIONAL_LOCKS=0", "GIT_CONFIG_NOSYSTEM=1",
    "git", "-C", workspace, "status", "--porcelain", "--untracked-files=all"]));
  return { paths: new Set(listing.stdout.split("\n").filter(Boolean)), git: git.code === 0 ? git.stdout : "" };
}

/** Whatever dl (or the cell's checks) left in the workspace; empty when it is as it was. */
function workspaceChanges(before: { paths: Set<string>; git: string }, after: { paths: Set<string>; git: string }): string[] {
  const added = [...after.paths].filter((path) => !before.paths.has(path));
  const gitLines = new Set(before.git.split("\n"));
  const changed = after.git.split("\n").filter((line) => line && !gitLines.has(line)).map((line) => `git: ${line.trim()}`);
  return [...added, ...changed];
}

export interface AttachOptions {
  system: System;
  host: SandboxHost;
  name: string;
  internet: boolean;
  sleep?: (ms: number) => Promise<void>;
  step?: (label: string, detail?: string) => void;
  note?: (label: string, detail: string) => void;
}

/**
 * Builds the sandbox for a serving deployment and checks it; undoes its own steps when one
 * fails (the model keeps serving).
 */
export async function attachSandbox(options: AttachOptions, deployment: ModelDeployment): Promise<ModelSandbox> {
  const { system, host, name, internet } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const user = ownerUser(host.owner);
  const spec: SandboxSpec = { name, workspace: host.workspace, internet, image: host.image, user };
  const home = sandboxHomeDir(name);
  const commands = sandboxCommands(spec, deployment.container);
  const networks = [sandboxNetwork(name), ...(internet ? [sandboxEgressNetwork(name)] : [])];
  const undo: Array<() => Promise<unknown>> = [];
  try {
    await noteOldDotDl(system, host.workspace, options.note);
    for (const args of commands.networks) {
      const network = args.at(-1)!;
      if ((await system.probe("docker", ["network", "inspect", network])).code === 0) await system.run("docker", ["network", "rm", network]);
      await system.run("docker", args);
      undo.push(() => system.run("docker", ["network", "rm", network], { allowFailure: true }));
    }
    await system.run("docker", commands.connect);
    undo.push(() => system.run("docker", ["network", "disconnect", "-f", sandboxNetwork(name), deployment.container], { allowFailure: true }));
    options.step?.("Network", `${networks.join(" + ")} · the model as ${MODEL_ALIAS}`);
    const addedWorkspace = await setHotcellRoot(system, "HOTCELL_WORKSPACE_ROOTS", host.workspace, true);
    // HOMES_ROOT stays allowed: it holds only dl's agent homes.
    const addedHome = await setHotcellRoot(system, "HOTCELL_HOME_ROOTS", HOMES_ROOT, true);
    if (addedWorkspace) undo.push(async () => { if (await setWorkspaceRoot(system, host.workspace, false)) await restartHotcell(system, sleep); });
    if (addedWorkspace || addedHome) await restartHotcell(system, sleep);
    const madeHome = await prepareSandboxHome(system, home, user);
    if (madeHome) undo.push(() => removeHome(system, home));
    await writeSandboxConfig(system, home, deployment, user);
    const sandbox = await createCell(system, host.apiKey, spec, commands.create, networks, deployment);
    options.step?.("Sandbox", `${sandboxName(name)} (${sandbox.id === "dry-run" ? "dry run" : sandbox.id}) · ${host.workspace} → /workspace · runs as ${userText(user)} · ${internet ? "internet allowed" : "no internet"}`);
    return sandbox;
  } catch (error) {
    if (!system.dryRun) for (const step of undo.reverse()) await step().catch(() => undefined);
    throw error;
  }
}

/** dl 0.33.0 kept the agent's files in DIR/.dl; dl leaves that folder alone and says so once. */
async function noteOldDotDl(system: System, workspace: string, note?: (label: string, detail: string) => void): Promise<void> {
  if ((await system.probe("stat", ["-c", "%F", `${workspace}/.dl`])).code === 0) {
    note?.("Old .dl", `${workspace}/.dl is from dl 0.33.0; the agent no longer uses it and dl leaves it untouched (delete it when you no longer need its sessions)`);
  }
}

/**
 * `hotcell create`, then what Docker shows for the cell, the checks from inside it, who owns a
 * file the agent writes, and that the workspace holds nothing it didn't hold before; the cell is
 * removed again when any of them fails.
 */
async function createCell(system: System, apiKey: string, spec: SandboxSpec, create: string[], networks: string[], deployment: ModelDeployment): Promise<ModelSandbox> {
  const before = system.dryRun ? undefined : await workspaceSnapshot(system, spec.workspace, spec.user);
  const created = await hotcell(system, apiKey, create);
  const id = created.stdout.trim().split("\n").at(-1)?.trim() ?? "";
  if (!/^[0-9a-f]{6,64}$/.test(id) && !system.dryRun) throw new Error(`Hotcell didn't return a sandbox id (got "${id}")`);
  const home = sandboxHomeDir(spec.name);
  const sandbox: ModelSandbox = { id: id || "dry-run", container: cellContainer(id || "dry-run"), workspace: spec.workspace, home, networks, internet: spec.internet, image: spec.image,
    createdAt: new Date().toISOString(), ...(spec.user ? { user: spec.user } : {}) };
  if (system.dryRun) return sandbox;
  try {
    const inspect = await system.probe("docker", ["inspect", "--format", INSPECT_FORMAT, sandbox.container]);
    const problems = checkCellInspect(inspect.stdout, { workspace: spec.workspace, home, networks, user: spec.user });
    if (problems.length) throw new Error(`The sandbox isn't isolated as planned: ${problems.join("; ")}`);
    const model = await system.probe("docker", ["inspect", "--format", "{{json .Mounts}}", deployment.container]);
    if (model.stdout.includes(spec.workspace)) throw new Error(`The model container ${deployment.container} can see ${spec.workspace}`);
    const checked = await system.probe("docker", ["exec", ...(spec.user ? ["-u", spec.user] : []), sandbox.container, "sh", "-c", cellChecks(sandboxProvider(deployment).baseUrl, spec.internet, spec.user)]);
    const marker = `${spec.workspace}/${OWNER_CHECK}`;
    const owner = (await system.probe("stat", ["-c", "%u:%g", marker])).stdout.trim();
    await system.run("setpriv", asUser(spec.user, ["rm", "-f", marker]), { allowFailure: true });
    if (checked.code !== 0) throw new Error(`Sandbox check failed: ${CHECK_FAILURES[checked.code] ?? `exit ${checked.code}: ${(checked.stderr || checked.stdout).trim().split("\n").at(-1)}`}`);
    if (owner !== (spec.user ?? "0:0")) throw new Error(`Sandbox check failed: a file the agent wrote in ${spec.workspace} belongs to ${owner || "nobody"} on the host, not ${spec.user ?? "0:0"}`);
    const changes = workspaceChanges(before!, await workspaceSnapshot(system, spec.workspace, spec.user));
    if (changes.length) throw new Error(`Sandbox check failed: making the sandbox changed ${spec.workspace} (${changes.slice(0, 5).join(", ")}${changes.length > 5 ? ", …" : ""})`);
    return sandbox;
  } catch (error) {
    await hotcell(system, apiKey, ["rm", sandbox.id]).catch(() => undefined);
    throw error;
  }
}

/**
 * The agent's home on the host, made before the cell starts: `HOMES_ROOT/NAME` (root's, 0755) and
 * `…/home`, owned by the user the cell runs as, 0700. A home left by an earlier owner is handed
 * over (chown -R -h changes links themselves, never follows them); its directories are then made
 * as that user (setpriv), so a link the agent left there can't point a write elsewhere. True when
 * the home is new.
 */
export async function prepareSandboxHome(system: System, home: string, user: string | undefined): Promise<boolean> {
  await system.mkdir(dirname(home), { mode: 0o755 });
  const found = await system.probe("stat", ["-c", "%F", home]);
  if (found.code === 0 && found.stdout.trim() !== "directory") throw new Error(`${home} is a ${found.stdout.trim()}, not a directory; remove it, then run this again.`);
  if (found.code !== 0) await system.mkdir(home, { mode: 0o700 });
  else await system.run("chmod", ["700", home]);
  await system.run("chown", ["-R", "-h", user ?? "0:0", home]);
  await system.run("setpriv", asUser(user, ["mkdir", "-p", "-m", "700", ...HOME_DIRS.map((dir) => `${home}/${dir}`)]));
  return found.code !== 0;
}

/** `dl model down`, or an undo: the agent's home and its deployment folder, only under HOMES_ROOT. */
async function removeHome(system: System, home: string): Promise<void> {
  if (!inside(home, HOMES_ROOT) || home === HOMES_ROOT) return;
  await system.remove(home);
  await system.run("rmdir", [dirname(home)], { allowFailure: true });
}

/** Writes `path` as `user`: a new file renamed into place, so a link at `path` is replaced, not followed. */
async function writeAsUser(system: System, user: string | undefined, path: string, content: string, mode: number): Promise<void> {
  await system.run("setpriv", asUser(user, ["sh", "-c", 'umask 077 && cat > "$1.dl-new" && chmod "$2" "$1.dl-new" && mv -f "$1.dl-new" "$1"', "sh", path, mode.toString(8)]),
    { input: content, describe: `write ${path} as ${userText(user)}` });
}

/** The cell's Autopilot config, in the agent's home (the cell's XDG_CONFIG_HOME), pointed at `deployment`. */
export async function writeSandboxConfig(system: System, home: string, deployment: ModelDeployment, user?: string): Promise<void> {
  // Same merge as the host's config, so a model picked in the cell's /model menu for another provider survives.
  const target = { ...deployment, host: MODEL_ALIAS, port: engine(deployment.engine).containerPort };
  const path = sandboxConfigPath(home);
  const current = await system.probe("setpriv", asUser(user, ["cat", path]));
  await writeAsUser(system, user, path, providerConfigText(current.code === 0 ? current.stdout : undefined, target, path), 0o600);
}

/**
 * After an update or rollback switched: the alias moves to `next`, and the cell's config names its
 * model. The workspace's owner is read again; when it changed, or the sandbox is dl 0.33.0's (its
 * config inside the workspace), the cell is made again as the owner with its home outside the
 * workspace (a cell's user and mounts are fixed when it is created). Returns the sandbox as it now is.
 */
export async function repointSandbox(system: System, name: string, sandbox: ModelSandbox, next: ModelDeployment, old: ModelDeployment | undefined,
  notice?: (text: string) => void): Promise<ModelSandbox> {
  const owner = await workspaceOwner(system, sandbox.workspace);
  const user = ownerUser(owner);
  const remake = user !== sandbox.user || !sandbox.home;
  let apiKey = "";
  if (remake) {
    const install = await readState(system);
    if (compareSemver(install?.hotcellVersion ?? "0.0.0", MIN_HOTCELL_FOR_SANDBOX) < 0) {
      throw new Error(`the sandbox must be made again (${!sandbox.home ? "its home moves out of the workspace" : `${sandbox.workspace} now belongs to ${userText(user)}`}), which needs Hotcell ${MIN_HOTCELL_FOR_SANDBOX} or newer (sudo dl up)`);
    }
    apiKey = parseEnvFile(await system.readFile(PATHS.hotcellEnv)).HOTCELL_API_KEY ?? "";
    if (!apiKey) throw new Error(`Can't read Hotcell's settings (${PATHS.hotcellEnv}); run this as root (sudo).`);
  }
  const network = sandbox.networks[0]!;
  if (old && old.container !== next.container) await system.run("docker", ["network", "disconnect", "-f", network, old.container], { allowFailure: true });
  await system.run("docker", ["network", "disconnect", "-f", network, next.container], { allowFailure: true });
  await system.run("docker", ["network", "connect", "--alias", MODEL_ALIAS, network, next.container]);
  if (!remake) {
    await writeSandboxConfig(system, sandbox.home!, next, user);
    return sandbox;
  }
  if (user !== sandbox.user) notice?.(`${sandbox.workspace} now belongs to ${userText(user)} (was ${userText(sandbox.user)}): the sandbox is made again to run as ${userText(user)}`);
  if (!sandbox.home) notice?.(`made again with its home in ${sandboxHomeDir(name)}; ${sandbox.workspace}/.dl from dl 0.33.0 is left untouched`);
  const spec: SandboxSpec = { name, workspace: sandbox.workspace, internet: sandbox.internet, image: sandbox.image, user };
  const home = sandboxHomeDir(name);
  if (await setHotcellRoot(system, "HOTCELL_HOME_ROOTS", HOMES_ROOT, true)) await restartHotcell(system, (ms) => new Promise<void>((done) => setTimeout(done, ms)));
  await prepareSandboxHome(system, home, user);
  await writeSandboxConfig(system, home, next, user);
  await hotcell(system, apiKey, ["rm", sandbox.id]);
  try {
    return await createCell(system, apiKey, spec, sandboxCommands(spec, next.container).create, sandbox.networks, next);
  } catch (error) {
    throw new SandboxRemovedError(`${error instanceof Error ? error.message : String(error)}; the old sandbox is removed`);
  }
}

/** The sandbox was removed while being made again: the state must forget it. */
export class SandboxRemovedError extends Error {
  override name = "SandboxRemovedError";
}

/** `dl model down`: the cell, its networks, its home and its workspace permission; never the workspace's files. */
export async function removeSandbox(system: System, sandbox: ModelSandbox, sleep?: (ms: number) => Promise<void>): Promise<void> {
  const env = parseEnvFile(await system.readFile(PATHS.hotcellEnv));
  if (env.HOTCELL_API_KEY) await hotcell(system, env.HOTCELL_API_KEY, ["rm", sandbox.id]).catch(() => undefined);
  else await system.run("docker", ["rm", "-f", sandbox.container], { allowFailure: true });
  for (const network of [...sandbox.networks].reverse()) await system.run("docker", ["network", "rm", network], { allowFailure: true });
  if (sandbox.home) await removeHome(system, sandbox.home);
  if (await setWorkspaceRoot(system, sandbox.workspace, false)) await restartHotcell(system, sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms))));
}
