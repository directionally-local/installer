/**
 * Whether this computer can run the agents: platform, Docker (whichever runtime the user
 * has), a patched Node, git, and disk. Read-only: every probe goes through `System`.
 */
import { dirname, join } from "node:path";
import { agentCapacity, parseDfFreeGb, parseInterfaceIp, parseOsRelease } from "../detect.js";
import { nodeAdvisory } from "../node-advisory.js";
import type { System } from "../system.js";
import { LOCAL_CELL_MEMORY_MB, LOCAL_MIN_DISK_GB, type LocalPlatform } from "./layout.js";

export interface DockerFacts {
  /** The DOCKER_HOST the services get, e.g. unix:///Users/me/.docker/run/docker.sock. */
  host: string;
  /** "Docker Desktop", "OrbStack", "colima", … */
  runtime: string;
  version: string;
  /** What the Docker VM (or host) has: sandboxes share it. */
  memoryMb: number;
  cpus: number;
}

export interface ComputerFacts {
  platform: NodeJS.Platform;
  /** e.g. "macOS 15.1" or "Ubuntu 24.04.1 LTS". */
  osName: string;
  arch: string;
  /** The Node the services run on: this one, through a path that survives upgrades. */
  node: { path: string; version: string };
  git: string | undefined;
  diskFreeGb: number;
  dockerCli: string | undefined;
  docker: DockerFacts | undefined;
  /** Docker Desktop or OrbStack is installed but not running (macOS: we can open it). */
  dockerApp: string | undefined;
  /** Linux: the docker0 address sandboxes reach the host on; undefined behind a VM (Docker Desktop). */
  bridgeIp: string | undefined;
  /** Linux: a systemd user manager answers. */
  systemdUser: boolean;
  /** Linux: the docker CLI said permission denied (not in the docker group). */
  dockerDenied: boolean;
}

export interface CheckOptions {
  home: string;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  nodeVersion?: string;
}

const DOCKER_INFO = "{{.ServerVersion}}|{{.OperatingSystem}}|{{.MemTotal}}|{{.NCPU}}";

export async function checkComputer(system: System, options: CheckOptions): Promise<ComputerFacts> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home;
  const [osName, df, git] = await Promise.all([
    describeOs(system, platform),
    system.probe("df", ["-Pk", home]),
    system.probe("git", ["--version"]),
  ]);
  const dockerCli = await findDockerCli(system, home);
  const { docker, denied } = dockerCli ? await findDocker(system, dockerCli, home, platform, env) : { docker: undefined, denied: false };
  const dockerApp = platform === "darwin" && !docker ? await installedDockerApp(system, home) : undefined;
  const bridge = platform === "linux" ? await system.probe("ip", ["-4", "-o", "addr", "show", "docker0"]) : undefined;
  const systemd = platform === "linux" ? await system.probe("systemctl", ["--user", "is-system-running"]) : undefined;
  const execPath = options.execPath ?? process.execPath;
  return {
    platform,
    osName,
    arch: options.arch ?? process.arch,
    node: { path: await stableNodePath(system, execPath), version: options.nodeVersion ?? process.versions.node },
    git: git.code === 0 ? git.stdout.trim().replace(/^git version /, "") : undefined,
    diskFreeGb: parseDfFreeGb(df.stdout),
    dockerCli,
    docker,
    dockerApp,
    bridgeIp: bridge ? parseInterfaceIp(bridge.stdout) : undefined,
    // "degraded" (one failed unit somewhere) still runs ours fine.
    systemdUser: systemd ? ["running", "degraded", "starting"].includes(systemd.stdout.trim()) : false,
    dockerDenied: denied,
  };
}

/** What stops setup before it changes anything, each with how to fix it. */
export function computerProblems(facts: ComputerFacts): string[] {
  const problems: string[] = [];
  const unsupported = localUnsupported(facts.platform);
  if (unsupported) return [unsupported];
  if (facts.platform === "linux" && !facts.systemdUser) {
    problems.push("A systemd user session is needed to keep the agents running (systemctl --user). Log in to a desktop session, or set up a server instead.");
  }
  const node = nodeAdvisory(facts.node.version);
  if (!node.ok) {
    problems.push(`${node.message} ${facts.platform === "darwin" ? "Update Node (brew upgrade node, or nodejs.org)" : "Update Node (nodejs.org or your package manager)"}, then run this again.`);
  }
  if (!facts.git) {
    problems.push(facts.platform === "darwin" ? "git isn't installed. Install it with: xcode-select --install" : "git isn't installed. Install it with your package manager (e.g. sudo apt install git).");
  }
  if (!facts.docker) problems.push(dockerFix(facts));
  if (facts.diskFreeGb < LOCAL_MIN_DISK_GB) {
    problems.push(`At least ${LOCAL_MIN_DISK_GB} GB of free disk is needed for the sandbox image and workspaces (found ${facts.diskFreeGb} GB).`);
  }
  return problems;
}

function dockerFix(facts: ComputerFacts): string {
  if (facts.platform === "linux") {
    if (facts.dockerDenied) return "Docker is installed but you can't use it. Add yourself to the docker group (sudo usermod -aG docker $USER), log out and back in, then run this again.";
    if (facts.dockerCli) return "Docker isn't running. Start it (sudo systemctl start docker, or open Docker Desktop), then run this again.";
    return "Docker isn't installed. Install Docker Engine (https://docs.docker.com/engine/install/) or Docker Desktop, then run this again.";
  }
  if (facts.dockerApp) return `${facts.dockerApp} is installed but didn't start. Open it, wait until it says it's running, then run this again.`;
  if (facts.dockerCli) return "Docker isn't running. Start Docker Desktop, OrbStack, or colima (colima start), then run this again.";
  return "Docker isn't installed. Install Docker Desktop (https://www.docker.com/products/docker-desktop/), OrbStack (brew install orbstack), or colima (brew install colima docker && colima start), then run this again.";
}

/** How many agents fit at once, by what Docker has (the VM on macOS). */
export function localCapacity(docker: Pick<DockerFacts, "memoryMb" | "cpus">): number {
  return agentCapacity({ memoryMb: docker.memoryMb, cpus: docker.cpus }, LOCAL_CELL_MEMORY_MB);
}

/**
 * Why agents can't run on this computer's platform, or undefined on macOS and Linux. The
 * local setup is POSIX throughout (sh, launchd or systemd --user, unix sockets), so other
 * platforms are refused before anything runs. WSL reports "linux" and takes the Linux path.
 */
export function localUnsupported(platform: NodeJS.Platform): string | undefined {
  if (supportedPlatform(platform)) return undefined;
  if (platform === "win32") {
    return "Running on this computer isn't supported on Windows yet; connect a server instead (dl setup, then \"On my own server\"). "
      + "Inside WSL 2, dl runs as on Linux (it needs systemd and Docker there).";
  }
  return `Running agents on this computer works on macOS and Linux, not ${platform}. Connect a server instead: dl setup, then "On my own server".`;
}

export function supportedPlatform(platform: NodeJS.Platform): LocalPlatform | undefined {
  return platform === "darwin" || platform === "linux" ? platform : undefined;
}

async function describeOs(system: System, platform: NodeJS.Platform): Promise<string> {
  if (platform === "darwin") {
    const version = (await system.probe("sw_vers", ["-productVersion"])).stdout.trim();
    return version ? `macOS ${version}` : "macOS";
  }
  if (platform === "linux") return parseOsRelease(await system.readFile("/etc/os-release") ?? "").prettyName || "Linux";
  return platform;
}

async function findDockerCli(system: System, home: string): Promise<string | undefined> {
  const onPath = (await system.probe("sh", ["-c", "command -v docker"])).stdout.trim();
  if (onPath) return onPath;
  // Launched from a GUI or a fresh shell, the runtimes' own bin dirs may not be on PATH.
  for (const candidate of [
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    "/Applications/Docker.app/Contents/Resources/bin/docker",
    join(home, ".orbstack", "bin", "docker"),
    "/usr/bin/docker",
  ]) {
    if (await system.exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The Docker endpoint to use. Hotcell talks to Docker through DOCKER_HOST (not the CLI's
 * context), and a LaunchAgent has none of the shell's environment, so this resolves the
 * endpoint once and the services get it explicitly. A DOCKER_HOST the user set wins.
 */
async function findDocker(
  system: System,
  cli: string,
  home: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<{ docker: DockerFacts | undefined; denied: boolean }> {
  const candidates: string[] = [];
  if (env.DOCKER_HOST?.trim()) {
    candidates.push(env.DOCKER_HOST.trim());
  } else {
    const context = (await system.probe(cli, ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"])).stdout.trim();
    if (context) candidates.push(context);
    const sockets = platform === "darwin"
      ? [join(home, ".docker", "run", "docker.sock"), join(home, ".orbstack", "run", "docker.sock"), join(home, ".colima", "default", "docker.sock"), join(home, ".colima", "docker.sock"), "/var/run/docker.sock"]
      : ["/var/run/docker.sock", ...(env.XDG_RUNTIME_DIR ? [join(env.XDG_RUNTIME_DIR, "docker.sock")] : [])];
    for (const socket of sockets) if (await system.exists(socket)) candidates.push(`unix://${socket}`);
  }
  let denied = false;
  for (const host of [...new Set(candidates)]) {
    const info = await system.probe(cli, ["info", "--format", DOCKER_INFO], { env: { DOCKER_HOST: host } });
    if (/permission denied/i.test(info.stderr)) denied = true;
    const [version, os, memTotal, ncpu] = info.stdout.trim().split("|");
    if (info.code !== 0 || !version) continue;
    return {
      docker: {
        host,
        runtime: runtimeName(host, os ?? ""),
        version,
        memoryMb: Math.round(Number(memTotal) / 1024 / 1024) || 0,
        cpus: Number(ncpu) || 0,
      },
      denied: false,
    };
  }
  return { docker: undefined, denied };
}

function runtimeName(host: string, os: string): string {
  if (host.includes("/.orbstack/") || /orbstack/i.test(os)) return "OrbStack";
  if (host.includes("/.colima/")) return "colima";
  if (/docker desktop/i.test(os) || host.includes("/.docker/run/")) return "Docker Desktop";
  if (host.includes("/run/user/")) return "Docker (rootless)";
  return "Docker";
}

/** Docker Desktop or OrbStack, installed as an app; undefined when neither is. */
export async function installedDockerApp(system: System, home: string): Promise<string | undefined> {
  for (const [name, path] of [
    ["Docker Desktop", "/Applications/Docker.app"],
    ["OrbStack", "/Applications/OrbStack.app"],
    ["Docker Desktop", join(home, "Applications", "Docker.app")],
    ["OrbStack", join(home, "Applications", "OrbStack.app")],
  ] as const) {
    if (await system.exists(path)) return name;
  }
  return undefined;
}

/**
 * A Node path that survives upgrades: Homebrew's versioned Cellar path disappears on the
 * next `brew upgrade`, but its opt/ link follows the formula, security fixes included.
 */
export async function stableNodePath(system: System, execPath: string): Promise<string> {
  const match = execPath.match(/^(.*)\/Cellar\/(node(?:@\d+)?)\/[^/]+\/bin\/node$/);
  if (match) {
    const opt = `${match[1]}/opt/${match[2]}/bin/node`;
    if (await system.exists(opt)) return opt;
  }
  return execPath;
}

/** PATH for the services: Node, the docker CLI, git, and the system's basics. */
export function servicePath(facts: Pick<ComputerFacts, "node" | "dockerCli">): string {
  const dirs = [dirname(facts.node.path), ...(facts.dockerCli ? [dirname(facts.dockerCli)] : []), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return [...new Set(dirs)].join(":");
}
