/**
 * "On this computer": Hotcell + Autopilot as the current user's background services, so a
 * laptop runs its own agents with no server. No root, no sudo; everything lives under
 * ~/.directionallylocal (0700 dirs, 0600 secrets), and the services are LaunchAgents on
 * macOS or systemd user units on Linux. Safe to re-run: it repairs and keeps secrets.
 *
 * The OpenRouter key goes to Hotcell's keystore over stdin, as a 0600 file under
 * HOTCELL_HOME (HOTCELL_KEYSTORE=file), not the login Keychain:
 *   - Hotcell's Keychain backend writes through `security add-generic-password -w KEY`,
 *     which puts the key in a process argument list; the file path keeps it on stdin only.
 *   - Keychain entries are global to the login session and ignore HOTCELL_HOME, so ours
 *     would collide with (and overwrite) a user's own `hotcell keys add openrouter`.
 *   - A LaunchAgent reading the login keychain can hit an access prompt or a locked
 *     keychain (after a `security lock-keychain`, over SSH); a file never prompts.
 *   - Uninstall removes it with the rest; nothing is left in Keychain Access.
 * The file sits inside a 0700 directory in the user's home, which FileVault encrypts at rest.
 *
 * Networking: on macOS (Docker Desktop, OrbStack, colima) a container's host.docker.internal
 * reaches the host's loopback, so Hotcell's egress gateway and Autopilot's GitHub proxy
 * bind 127.0.0.1 and stay off the network. On Linux with Docker Engine they bind the
 * docker0 address instead, as on a server (loopback isn't reachable from the bridge).
 */
import { randomBytes } from "node:crypto";
import { hostname as osHostname, homedir } from "node:os";
import { join } from "node:path";
import { cellDockerfile, cellImage } from "../layout.js";
import type { RemoteServer } from "../laptop/config.js";
import { removeRemote } from "../laptop/config.js";
import type { Prompter } from "../prompt.js";
import { RealSystem, type System } from "../system.js";
import type { Ui } from "../ui.js";
import { checkComputer, computerProblems, localCapacity, servicePath, supportedPlatform, type ComputerFacts } from "./check.js";
import {
  LOCAL_SERVICES, PAIRED_NAME, PREFERRED_PORTS, autopilotXdg, localAsterConfig, localAutopilotBin, localAutopilotEnv,
  localGithubEnv, localHotcellBin, localHotcellEnv, localPaths, parseLocalEnvFile, serviceSpecs,
  type LocalPaths, type LocalPlatform, type LocalPorts, type Networking,
} from "./layout.js";
import { httpStatus, portFree } from "./probes.js";
import { installService, removeServices, serviceState, stopService, userId, type ServiceManager, type ServiceState } from "./services.js";
import { readLocalState, writeLocalState, type LocalState } from "./state.js";

/** Everything a test (or an unusual machine) can override; defaults are this computer. */
export interface LocalOptions {
  system?: System;
  home?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  nodeVersion?: string;
  hostname?: string;
  autopilotVersion?: string;
  hotcellVersion?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface SetupInput extends LocalOptions {
  ui: Ui;
  /** Kept for the wizard's call shape; setup asks nothing (it's given the keys). */
  prompter: Prompter;
  answers: { openrouterKey: string; githubToken: string };
}

const SETUP_LOG = "setup.log";

/** Where setup sends other tools' output (npm, docker build); shown only when something fails. */
export function localSetupLog(home = homedir()): string {
  return join(home, ".directionallylocal", "logs", SETUP_LOG);
}

interface Context {
  system: System;
  home: string;
  platform: LocalPlatform;
  paths: LocalPaths;
  sleep: (ms: number) => Promise<void>;
}

function context(options: LocalOptions, logName?: string): Context & { rawPlatform: NodeJS.Platform } {
  const home = options.home ?? homedir();
  const rawPlatform = options.platform ?? process.platform;
  // Unsupported platforms still get paths (for a clear refusal); nothing is written there.
  const platform = supportedPlatform(rawPlatform) ?? "linux";
  return {
    // Other tools' output goes to a log file (or nowhere), never the screen.
    system: options.system ?? new RealSystem(() => {}, logName ? { outputLog: join(home, ".directionallylocal", "logs", logName) } : {}),
    home,
    platform,
    rawPlatform,
    paths: localPaths(home, platform),
    sleep: options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

/** Checks this computer without changing anything, e.g. before the wizard asks for keys. */
export async function checkThisComputer(options: LocalOptions = {}): Promise<{ facts: ComputerFacts; problems: string[] }> {
  const ctx = context(options);
  const facts = await checkComputer(ctx.system, checkOptions(ctx, options));
  return { facts, problems: computerProblems(facts) };
}

/** What setting up here made: the connection to save, and how many agents fit at once (an estimate). */
export interface LocalSetupResult {
  remote: RemoteServer;
  capacity: number;
}

export async function setUpOnThisComputer(input: SetupInput): Promise<LocalSetupResult> {
  const { ui } = input;
  const ctx = context(input, SETUP_LOG);
  const { system, paths, platform } = ctx;
  const now = () => (input.now ?? (() => new Date()))().toISOString();

  ui.plan([
    { id: "check", label: "Checking this computer" },
    { id: "software", label: "Installing Hotcell + Autopilot" },
    { id: "image", label: "Building the sandbox image" },
    { id: "services", label: "Starting services" },
    { id: "connect", label: "Connecting" },
  ]);
  const step = async <T>(id: string, work: () => Promise<{ value: T; detail?: string }>): Promise<T> => {
    ui.start(id);
    try {
      const { value, detail } = await work();
      ui.done(id, detail);
      return value;
    } catch (error) {
      ui.fail(id, (error as Error).message);
      throw error;
    }
  };

  const { facts, uid } = await step("check", async () => {
    let facts = await checkComputer(system, checkOptions(ctx, input));
    const unsupported = computerProblems(facts);
    if (ctx.rawPlatform !== "darwin" && ctx.rawPlatform !== "linux") throw new Error(unsupported[0]);
    const uid = await userId(system);
    if (!facts.docker && facts.dockerApp && platform === "darwin") {
      ui.start("check", `opening ${facts.dockerApp}`);
      facts = await openDockerApp(ctx, facts, input);
    }
    const problems = computerProblems(facts);
    if (problems.length > 0) throw new Error(`This computer can't run agents yet:\n  - ${problems.join("\n  - ")}`);
    const docker = facts.docker!;
    return {
      value: { facts, uid },
      detail: `${facts.osName} · ${docker.runtime} ${docker.version} · Node ${facts.node.version} · ${facts.diskFreeGb} GB free`,
    };
  });
  const docker = facts.docker!;
  const node = facts.node.path;
  const manager: ServiceManager = { platform, paths, uid, sleep: ctx.sleep };

  const { autopilotVersion, hotcellVersion, release } = await step("software", async () => {
    for (const dir of [paths.root, paths.config, paths.logs, paths.releases, paths.hotcellHome, paths.autopilotHome]) {
      await system.mkdir(dir, { mode: 0o700 });
    }
    const autopilot = input.autopilotVersion ?? await latestVersion(system, "autopilot-ai");
    const hotcell = input.hotcellVersion ?? await latestVersion(system, "hotcell");
    const name = `autopilot-${autopilot}_hotcell-${hotcell}`;
    const releaseDir = join(paths.releases, name);
    if (!(await system.exists(join(releaseDir, "node_modules", "autopilot-ai", "package.json")) && await system.exists(join(releaseDir, "node_modules", "hotcell", "package.json")))) {
      await system.mkdir(releaseDir, { mode: 0o700 });
      await system.run("npm", ["install", "--prefix", releaseDir, "--no-audit", "--no-fund", "--omit=dev", `autopilot-ai@${autopilot}`, `hotcell@${hotcell}`], { inherit: true });
    }
    await system.run("ln", ["-sfn", releaseDir, paths.current]);

    // Secrets first, so a later failure never needs them again.
    const openrouterKey = input.answers.openrouterKey.trim();
    if (openrouterKey) {
      await system.run(node, [localHotcellBin(paths), "keys", "add", "openrouter", "--stdin"], {
        input: openrouterKey,
        env: hotcellCliEnv(paths),
        describe: "hotcell keys add openrouter --stdin",
      });
    } else if (!(await hotcellHasKey(system, node, paths, "openrouter"))) {
      throw new Error("An OpenRouter key is needed; none is stored on this computer yet.");
    }
    const githubToken = input.answers.githubToken.trim();
    if (githubToken) {
      await system.writeFile(paths.githubEnv, localGithubEnv(githubToken), { mode: 0o600, secret: true });
    } else if (!parseLocalEnvFile(await system.readFile(paths.githubEnv)).GITHUB_TOKEN) {
      throw new Error("A GitHub token is needed; none is stored on this computer yet.");
    }
    return { value: { autopilotVersion: autopilot, hotcellVersion: hotcell, release: name }, detail: `Autopilot ${autopilot} · Hotcell ${hotcell}` };
  });

  const image = cellImage(autopilotVersion);
  const dockerEnv = { DOCKER_HOST: docker.host };
  const dockerCli = facts.dockerCli!;
  await step("image", async () => {
    const built = await ensureCellImage(system, dockerCli, dockerEnv, image, autopilotVersion);
    return { value: undefined, detail: built ? "already built" : `Node 24 · Autopilot ${autopilotVersion}` };
  });

  const ports = await step("services", async () => {
    // Stop ours first: a re-run keeps its ports, and they must be free to check.
    for (const service of ["autopilot", "hotcell"] as const) await stopService(system, manager, service);
    const net: Networking = { listenHost: platform === "linux" && facts.bridgeIp ? facts.bridgeIp : "127.0.0.1" };
    const previous = parseLocalEnvFile(await system.readFile(paths.hotcellEnv));
    const previousAutopilot = parseLocalEnvFile(await system.readFile(paths.autopilotEnv));
    const ports = await choosePorts(ctx, node, net, previousPorts(previous, previousAutopilot));
    const apiKey = previous.HOTCELL_API_KEY || randomBytes(24).toString("hex");
    await system.writeFile(paths.hotcellEnv, localHotcellEnv({ paths, apiKey, ports, net }), { mode: 0o600, secret: true });
    if (!(await system.readFile(paths.asterConfig))) await system.writeFile(paths.asterConfig, localAsterConfig(paths), { mode: 0o600 });
    await ensureWorkspace(system, paths);
    await system.writeFile(paths.autopilotEnv, localAutopilotEnv({ paths, hotcellApiKey: apiKey, image, ports, net }), { mode: 0o600, secret: true });

    const specs = serviceSpecs({ paths, node, path: servicePath(facts), dockerHost: docker.host, ports });
    for (const spec of Object.values(specs)) await rotateLog(system, spec.log);
    await installService(system, manager, specs.hotcell);
    await waitUntil(ctx, "Hotcell", join(paths.logs, LOCAL_SERVICES.hotcell.log), async () =>
      await httpStatus(system, node, `http://127.0.0.1:${ports.hotcell}/`) > 0);
    await checkSandboxReach(system, dockerCli, dockerEnv, image, ports.hotcellEgress, ctx.paths);
    await installService(system, manager, specs.autopilot);
    // Without a token the Aster API answers 401: up, and refusing strangers.
    await waitUntil(ctx, "Autopilot", join(paths.logs, LOCAL_SERVICES.autopilot.log), async () =>
      await httpStatus(system, node, `http://127.0.0.1:${ports.autopilot}/api/v1/health`) === 401);
    await pruneReleases(system, paths, release);
    return { value: ports, detail: `start at login · logs in ${tilde(paths.logs, ctx.home)}` };
  });

  const url = `http://127.0.0.1:${ports.autopilot}`;
  return await step("connect", async () => {
    const name = `${machineName(input.hostname)} (this computer)`;
    const created = await autopilotCli(system, node, paths, ["aster", "token", "create", "--name", name, "--workspace", "default", "--expires-in-days", "365", "--json"], true);
    const credential = lastJsonLine<{ credentialId: string; token: string; expiresAt: number | string }>(created.stdout);
    if (created.code !== 0 || !credential?.token || !credential.credentialId) {
      throw new Error(`Couldn't create this computer's credential: ${(created.stderr || created.stdout).trim().split("\n").at(-1) ?? "no output"}`);
    }
    // One credential per computer: earlier runs' are revoked once the new one exists.
    const listed = lastJsonLine<Array<{ id: string; name: string; status: string }>>((await autopilotCli(system, node, paths, ["aster", "token", "list", "--json"])).stdout) ?? [];
    for (const old of listed.filter((entry) => entry.name === name && entry.status === "active" && entry.id !== credential.credentialId)) {
      await autopilotCli(system, node, paths, ["aster", "token", "revoke", old.id]);
    }
    const status = await httpStatus(system, node, `${url}/api/v1/health`, credential.token);
    if (status !== 200) throw new Error(`Autopilot didn't accept this computer's credential (HTTP ${status}).`);

    const at = now();
    const previous = await readLocalState(system, paths);
    const state: LocalState = {
      version: 1,
      kind: "this-computer",
      platform,
      installedAt: previous?.installedAt ?? at,
      updatedAt: at,
      release,
      autopilotVersion,
      hotcellVersion,
      image,
      url,
      ports,
      dockerHost: docker.host,
      dockerRuntime: docker.runtime,
    };
    await writeLocalState(system, paths, state);
    const remote: RemoteServer = {
      name: PAIRED_NAME,
      url,
      token: credential.token,
      credentialId: credential.credentialId,
      expiresAt: new Date(credential.expiresAt).toISOString(),
      addedAt: at,
    };
    // The address is an implementation detail here; how many fit goes on the wizard's Ready line.
    return { value: { remote, capacity: localCapacity(docker) }, detail: "this computer · tasks pause while it sleeps" };
  });
}

export interface UninstallInput extends LocalOptions {
  ui: Ui;
  /** Also delete configuration, keys, conversations, workspaces, logs, and the sandbox image. */
  purge?: boolean;
  /** Drops the saved "this-computer" connection; the laptop config's removeRemote by default. */
  forgetRemote?: (name: string) => Promise<boolean>;
}

/**
 * Stops and removes the services and the installed software. Keys, configuration, and
 * conversations stay (so setting up again picks up where it was) unless `purge`.
 */
export async function uninstallFromThisComputer(input: UninstallInput): Promise<void> {
  const { ui } = input;
  const ctx = context(input, "uninstall.log");
  const { system, paths, platform } = ctx;
  const state = await readLocalState(system, paths);
  ui.plan([
    { id: "services", label: "Stopping services" },
    { id: "sandboxes", label: "Removing sandboxes" },
    { id: "software", label: "Removing Hotcell + Autopilot" },
    ...(input.purge ? [{ id: "data", label: "Removing keys and data" }] : []),
  ]);
  const step = async (id: string, work: () => Promise<string | undefined>) => {
    ui.start(id);
    try {
      ui.done(id, await work());
    } catch (error) {
      ui.fail(id, (error as Error).message);
      throw error;
    }
  };

  const uid = await userId(system);
  const manager: ServiceManager = { platform, paths, uid, sleep: ctx.sleep };
  await step("services", async () => {
    await removeServices(system, manager);
    return platform === "darwin" ? "LaunchAgents removed" : "user units removed";
  });

  const dockerCli = (await system.probe("sh", ["-c", "command -v docker"])).stdout.trim() || "docker";
  const dockerEnv = state?.dockerHost ? { env: { DOCKER_HOST: state.dockerHost } } : {};
  await step("sandboxes", async () => {
    // Only Autopilot's cells: a user's own Hotcell sandboxes carry sbx.managed too.
    const listed = await system.probe(dockerCli, ["ps", "-aq", "--filter", "label=sbx.managed=true", "--filter", "label=autopilot.conversation_id"], dockerEnv);
    const containers = listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    if (containers.length > 0) await system.run(dockerCli, ["rm", "-f", ...containers], { allowFailure: true, ...dockerEnv });
    return containers.length > 0 ? `${containers.length} removed` : "none running";
  });

  await step("software", async () => {
    await system.remove(paths.current);
    await system.remove(paths.releases);
    await system.remove(paths.state);
    await (input.forgetRemote ?? ((name: string) => removeRemote(name)))(PAIRED_NAME).catch(() => false);
    return input.purge ? undefined : `kept keys and data in ${tilde(paths.root, ctx.home)}`;
  });

  if (input.purge) {
    await step("data", async () => {
      if (state?.image) await system.run(dockerCli, ["image", "rm", state.image], { allowFailure: true, ...dockerEnv });
      await system.remove(paths.root);
      return `${tilde(paths.root, ctx.home)} deleted`;
    });
  }
}

export interface LocalStatus {
  installed: boolean;
  state: LocalState | undefined;
  services: Record<"hotcell" | "autopilot", ServiceState>;
  /** Autopilot answers on its port (401 without a token). */
  answering: boolean;
  capacity: number | undefined;
  dockerRunning: boolean;
  paths: LocalPaths;
  platform: NodeJS.Platform;
}

/** `dl local status`: is it running, where, and how much fits. Read-only. */
export async function localStatus(options: LocalOptions = {}): Promise<LocalStatus> {
  const ctx = context(options);
  const { system, paths, platform } = ctx;
  const state = await readLocalState(system, paths);
  const uid = (await system.probe("id", ["-u"])).stdout.trim();
  const manager: ServiceManager = { platform, paths, uid, sleep: ctx.sleep };
  const [hotcell, autopilot] = await Promise.all([serviceState(system, manager, "hotcell"), serviceState(system, manager, "autopilot")]);
  const node = options.execPath ?? process.execPath;
  const answering = state ? await httpStatus(system, node, `${state.url}/api/v1/health`) === 401 : false;
  let capacity: number | undefined;
  let dockerRunning = false;
  if (state) {
    const cli = (await system.probe("sh", ["-c", "command -v docker"])).stdout.trim() || "docker";
    const info = await system.probe(cli, ["info", "--format", "{{.MemTotal}}|{{.NCPU}}"], { env: { DOCKER_HOST: state.dockerHost } });
    const [mem, cpus] = info.stdout.trim().split("|");
    if (info.code === 0 && mem) {
      dockerRunning = true;
      capacity = localCapacity({ memoryMb: Math.round(Number(mem) / 1024 / 1024), cpus: Number(cpus) || 0 });
    }
  }
  return { installed: Boolean(state), state, services: { hotcell, autopilot }, answering, capacity, dockerRunning, paths, platform: ctx.rawPlatform };
}

function checkOptions(ctx: Context, options: LocalOptions) {
  return {
    home: ctx.home,
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.arch ? { arch: options.arch } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.execPath ? { execPath: options.execPath } : {}),
    ...(options.nodeVersion ? { nodeVersion: options.nodeVersion } : {}),
  };
}

/** Docker Desktop / OrbStack installed but not running: open it and wait for the daemon. */
async function openDockerApp(ctx: Context, facts: ComputerFacts, options: LocalOptions): Promise<ComputerFacts> {
  const app = facts.dockerApp === "OrbStack" ? "OrbStack" : "Docker";
  await ctx.system.run("open", ["-g", "-a", app], { allowFailure: true });
  for (let attempt = 0; attempt < 45; attempt++) {
    await ctx.sleep(2_000);
    const again = await checkComputer(ctx.system, checkOptions(ctx, options));
    if (again.docker) return again;
  }
  return facts;
}

export function hotcellCliEnv(paths: LocalPaths): Record<string, string> {
  return { HOME: paths.hotcellHome, HOTCELL_HOME: paths.hotcellHome, HOTCELL_KEYSTORE: "file" };
}

async function hotcellHasKey(system: System, node: string, paths: LocalPaths, provider: string): Promise<boolean> {
  if (!(await system.exists(localHotcellBin(paths)))) return false;
  const result = await system.probe(node, [localHotcellBin(paths), "keys", "ls"], { env: hotcellCliEnv(paths) });
  return result.code === 0 && new RegExp(`^\\s*${provider}\\b`, "m").test(result.stdout);
}

/** Autopilot's own CLI against the service's config and database (never its secrets). */
function autopilotCli(system: System, node: string, paths: LocalPaths, args: string[], secretOutput = false) {
  return system.run(node, [localAutopilotBin(paths), ...args], {
    allowFailure: true,
    env: {
      HOME: paths.autopilotHome,
      ...autopilotXdg(paths),
      AUTOPILOT_ASTER_CONFIG: paths.asterConfig,
      AUTOPILOT_ASTER_DB: join(paths.autopilotHome, "aster.db"),
    },
    describe: `autopilot ${args.join(" ")}`,
    ...(secretOutput ? { secretOutput: true } : {}),
  });
}

async function latestVersion(system: System, pkg: string): Promise<string> {
  const result = await system.probe("npm", ["view", pkg, "version"]);
  const version = result.stdout.trim();
  if (result.code !== 0 || !/^\d+\.\d+\.\d+/.test(version)) throw new Error(`Couldn't look up the latest ${pkg} on npm${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  return version;
}

/** Builds the sandbox image unless it exists; returns whether it already did. */
async function ensureCellImage(system: System, cli: string, env: Record<string, string>, image: string, autopilotVersion: string): Promise<boolean> {
  if ((await system.probe(cli, ["image", "inspect", image], { env })).code === 0) return true;
  const dir = (await system.run("mktemp", ["-d"])).stdout.trim();
  try {
    await system.run("npm", ["pack", `autopilot-ai@${autopilotVersion}`, "--pack-destination", dir, "--silent"]);
    await system.run("sh", ["-c", 'mv "$1"/autopilot-ai-*.tgz "$1"/autopilot.tgz', "sh", dir]);
    await system.writeFile(join(dir, "Dockerfile"), cellDockerfile());
    await system.run(cli, ["build", "--pull", "-q", "-t", image, dir], { inherit: true, env });
  } finally {
    await system.remove(dir);
  }
  return false;
}

/**
 * Proves a sandbox can reach the egress gateway the way cells will (host.docker.internal,
 * mapped like Hotcell maps it). Catches a runtime that doesn't forward to the host.
 */
async function checkSandboxReach(system: System, cli: string, env: Record<string, string>, image: string, port: number, paths: LocalPaths): Promise<void> {
  const script = `fetch("http://host.docker.internal:${port}/").then(r=>console.log(r.status),()=>console.log(0))`;
  const result = await system.run(cli, ["run", "--rm", "--add-host", "host.docker.internal:host-gateway", image, "node", "-e", script], { allowFailure: true, env });
  if (!(Number(result.stdout.trim()) > 0)) {
    throw new Error(`Sandboxes can't reach Hotcell's gateway at host.docker.internal:${port}. `
      + `Check that your Docker runtime forwards host.docker.internal to this computer; details in ${join(paths.logs, "setup.log")}`);
  }
}

function previousPorts(hotcell: Record<string, string>, autopilot: Record<string, string>): Partial<LocalPorts> {
  const port = (value: string | undefined) => {
    const parsed = Number(value?.split(":").at(-1));
    return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : undefined;
  };
  const entries: Array<[keyof LocalPorts, number | undefined]> = [
    ["autopilot", port(autopilot.AUTOPILOT_PUBLIC_URL)],
    ["hotcell", port(hotcell.HOTCELL_PORT)],
    ["hotcellProxy", port(hotcell.HOTCELL_PROXY_PORT)],
    ["hotcellEgress", port(hotcell.HOTCELL_EGRESS_PORT)],
    ["githubProxy", port(autopilot.AUTOPILOT_ASTER_GITHUB_PROXY_LISTEN)],
  ];
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined)) as Partial<LocalPorts>;
}

/**
 * Each port: what this computer used before (ours; it may take a moment to be released
 * after the stop), else the preferred one, else the next free one above it.
 */
async function choosePorts(ctx: Context, node: string, net: Networking, previous: Partial<LocalPorts>): Promise<LocalPorts> {
  const chosen = new Set<number>();
  const result = {} as LocalPorts;
  for (const key of Object.keys(PREFERRED_PORTS) as Array<keyof LocalPorts>) {
    const host = key === "hotcellEgress" || key === "githubProxy" ? net.listenHost : "127.0.0.1";
    const free = (port: number) => !chosen.has(port) && portFree(ctx.system, node, host, port);
    let pick: number | undefined;
    const before = previous[key];
    if (before !== undefined) {
      for (let attempt = 0; attempt < 5 && pick === undefined; attempt++) {
        if (await free(before)) pick = before;
        else await ctx.sleep(500);
      }
    }
    for (let port = PREFERRED_PORTS[key]; pick === undefined && port < PREFERRED_PORTS[key] + 200; port++) {
      if (await free(port)) pick = port;
    }
    if (pick === undefined) throw new Error(`No free port near ${PREFERRED_PORTS[key]} for ${key}.`);
    chosen.add(pick);
    result[key] = pick;
  }
  return result;
}

/** The default workspace: an empty Git repository Aster requires as a root. */
async function ensureWorkspace(system: System, paths: LocalPaths): Promise<void> {
  if (await system.exists(join(paths.workspace, ".git"))) return;
  await system.mkdir(paths.workspace, { mode: 0o700 });
  const git = (args: string[]) => system.run("git", ["-C", paths.workspace, ...args]);
  await git(["init", "--quiet", "--initial-branch=main"]);
  await system.writeFile(join(paths.workspace, "README.md"), "# Default workspace\n", { mode: 0o600 });
  await git(["add", "README.md"]);
  await git(["-c", "user.name=Autopilot", "-c", "user.email=autopilot@localhost", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Initialize workspace"]);
}

/** launchd and systemd's append: never rotate; keep each log under ~20 MB across runs. */
async function rotateLog(system: System, log: string): Promise<void> {
  const size = Number((await system.probe("wc", ["-c", log])).stdout.trim().split(/\s+/)[0]);
  if (size > 20 * 1024 * 1024) await system.run("mv", ["-f", log, `${log}.1`], { allowFailure: true });
}

/** Older releases go once the new one is running; the current one stays. */
async function pruneReleases(system: System, paths: LocalPaths, keep: string): Promise<void> {
  const listed = await system.probe("ls", ["-1", paths.releases]);
  for (const name of listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
    if (name !== keep && /^autopilot-.+_hotcell-.+$/.test(name)) await system.remove(join(paths.releases, name));
  }
}

async function waitUntil(ctx: Context, what: string, log: string, ready: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await ready()) return;
    await ctx.sleep(1_000);
  }
  throw new Error(`${what} didn't come up; see ${tilde(log, ctx.home)}`);
}

function lastJsonLine<T>(stdout: string): T | undefined {
  try {
    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as T;
  } catch {
    return undefined;
  }
}

function machineName(name = osHostname()): string {
  return name.replace(/\.local$/i, "").trim() || "This computer";
}

function tilde(path: string, home: string): string {
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
