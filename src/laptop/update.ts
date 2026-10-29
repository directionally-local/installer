import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Prompter } from "../prompt.js";
import { palette } from "../ui.js";
import { resolveRemote, type RemoteServer, type SshAccess } from "./config.js";
import { EventReplayer, type UiFactory } from "./remote-install.js";
import { checkServer, type ServerFacts, type SshExec } from "./ssh.js";
import { withConnections, type RemoteOpener } from "./tunnel.js";

/**
 * `dl update [NAME]`: bring a server's Autopilot, Hotcell and sandbox image up to date over
 * SSH, without the questions `dl setup` asks. It never restarts the services under a running
 * task: it asks, waits with `--wait`, and waits by default when nobody is there to answer.
 *
 * It also knows when a server is behind, so `dl status` can say so once a day.
 */

export interface UpdateIO {
  out: (text: string) => void;
  err: (text: string) => void;
  color?: boolean;
}

export interface ServerVersions {
  autopilot: string;
  hotcell: string;
}

export interface LatestVersions extends ServerVersions {
  /** Unix milliseconds of the npm lookup. */
  checkedAt: number;
}

const execFileAsync = promisify(execFile);
const DAY_MS = 24 * 60 * 60 * 1000;
const STATE_FILE = "/etc/directionallylocal/state.json";

/** Non-root users run the server commands with sudo; checkServer made sure it needs no password. */
function sudo(facts: Pick<ServerFacts, "root">): string {
  return facts.root ? "" : "sudo -n ";
}

/** The versions a server has installed, from the state file `dl up` writes (world-readable). */
export async function serverVersions(access: SshAccess, ssh: SshExec): Promise<ServerVersions | undefined> {
  const result = await ssh(access, `cat ${STATE_FILE}`);
  if (result.code !== 0) return undefined;
  try {
    const state = JSON.parse(result.stdout) as { autopilotVersion?: unknown; hotcellVersion?: unknown };
    return typeof state.autopilotVersion === "string" && typeof state.hotcellVersion === "string"
      ? { autopilot: state.autopilotVersion, hotcell: state.hotcellVersion }
      : undefined;
  } catch {
    return undefined;
  }
}

/** `1.2.10` is newer than `1.2.9`; a pre-release suffix is ignored, since npm's `latest` has none. */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string) => version.replace(/^v/, "").split(/[.+-]/).slice(0, 3).map((part) => Number(part) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

/** "Autopilot 2.7.0 → 2.7.2 · Hotcell 1.4.0 → 1.4.1", or undefined when the server is current. */
export function behindNotice(server: ServerVersions, latest: ServerVersions): string | undefined {
  const parts: string[] = [];
  if (compareVersions(server.autopilot, latest.autopilot) < 0) parts.push(`Autopilot ${server.autopilot} → ${latest.autopilot}`);
  if (compareVersions(server.hotcell, latest.hotcell) < 0) parts.push(`Hotcell ${server.hotcell} → ${latest.hotcell}`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function versionsCachePath(env: NodeJS.ProcessEnv = process.env): string {
  const cacheHome = env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
  return join(cacheHome, "directionallylocal", "versions.json");
}

async function npmVersion(pkg: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("npm", ["view", pkg, "version"], { timeout: 15_000 });
    const version = stdout.trim();
    return /^\d+\.\d+\.\d+/.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * npm's newest Autopilot and Hotcell, looked up at most once a day. Offline keeps the last
 * answer rather than pretending the server is current.
 */
export async function latestVersions(options: {
  cacheFile?: string;
  npm?: (pkg: string) => Promise<string | undefined>;
  now?: () => number;
  maxAgeMs?: number;
} = {}): Promise<LatestVersions | undefined> {
  const path = options.cacheFile ?? versionsCachePath();
  const now = (options.now ?? Date.now)();
  const maxAge = options.maxAgeMs ?? DAY_MS;
  const cached = await readCache(path);
  if (cached && now - cached.checkedAt < maxAge) return cached;

  const npm = options.npm ?? npmVersion;
  const [autopilot, hotcell] = await Promise.all([npm("autopilot-ai"), npm("hotcell")]);
  if (!autopilot || !hotcell) return cached;
  const fresh: LatestVersions = { autopilot, hotcell, checkedAt: now };
  await writeCache(path, fresh);
  return fresh;
}

async function readCache(path: string): Promise<LatestVersions | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<LatestVersions>;
    return typeof parsed.autopilot === "string" && typeof parsed.hotcell === "string" && typeof parsed.checkedAt === "number"
      ? { autopilot: parsed.autopilot, hotcell: parsed.hotcell, checkedAt: parsed.checkedAt }
      : undefined;
  } catch {
    return undefined;
  }
}

async function writeCache(path: string, versions: LatestVersions): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(versions, null, 2)}\n`, { mode: 0o644 });
    await rename(temp, path);
  } catch {
    // A cache that can't be written only costs another lookup next time.
  }
}

/** How many tasks are running on a server, or undefined when it can't be asked. */
export async function runningTasks(remote: RemoteServer, open?: RemoteOpener): Promise<number | undefined> {
  try {
    return await withConnections(open, async (connections) => {
      const list = await (await connections.client(remote)).listConversations(200);
      return list.filter((entry) => entry.activeRunId !== null).length;
    });
  } catch {
    return undefined;
  }
}

/** Servers that are behind npm, for `dl status`. One SSH round trip each, and a cached lookup. */
export async function outdatedServers(
  remotes: RemoteServer[],
  deps: { ssh: SshExec; latest?: () => Promise<LatestVersions | undefined> },
): Promise<Array<{ name: string; notice: string }>> {
  const latest = await (deps.latest ?? (() => latestVersions()))();
  if (!latest) return [];
  const outdated: Array<{ name: string; notice: string }> = [];
  for (const remote of remotes) {
    if (!remote.ssh) continue;
    const server = await serverVersions(remote.ssh, deps.ssh);
    if (!server) continue;
    const notice = behindNotice(server, latest);
    if (notice) outdated.push({ name: remote.name, notice });
  }
  return outdated;
}

export interface UpdateDeps {
  ssh: SshExec;
  open?: RemoteOpener;
  prompter: Prompter;
  newUi: UiFactory;
  io: UpdateIO;
  /** Whether there's someone to answer a question. Without one, `dl update` waits. */
  interactive: boolean;
  /** `--wait`: wait for running tasks instead of asking. */
  wait?: boolean;
  /** How many tasks are running; tests replace it. */
  running?: (remote: RemoteServer) => Promise<number | undefined>;
  sleep?: (ms: number) => Promise<void>;
}

/** `dl update [NAME] [--wait]`: update a server over SSH, without interrupting its tasks. */
export async function update(args: string[], deps: UpdateDeps): Promise<number> {
  const c = palette(deps.io.color === true);
  const name = args.find((arg) => !arg.startsWith("-"));
  const remote = await resolveRemote(name);
  if (!remote.ssh) {
    deps.io.err(`\n  ${c.red("✗")} ${remote.name} wasn't set up over SSH, so this laptop can't update it.\n  On the server: ${c.bold("sudo dl up")}\n\n`);
    return 1;
  }

  const facts = await checkServer(remote.ssh, deps.ssh, remote.name);
  const before = await serverVersions(remote.ssh, deps.ssh);
  const running = deps.running ?? ((target: RemoteServer) => runningTasks(target, deps.open));

  const count = await running(remote);
  if (count === undefined) {
    deps.io.err(`  ${c.yellow("!")} Couldn't ask ${remote.name} what's running; updating anyway.\n`);
  } else if (count > 0) {
    if (!(await settleRunning(remote, count, deps, running, c))) return 1;
  }

  deps.io.out(`\n  ${c.bold("Updating")} ${remote.name}${before ? c.dim(`  (Autopilot ${before.autopilot} · Hotcell ${before.hotcell})`) : ""}\n\n`);
  const replay = new EventReplayer(deps.newUi);
  // No --access: the server keeps the way it's reached. `{}` means "no new answers", so a
  // missing key fails at once instead of waiting for a prompt nobody can see.
  const result = await deps.ssh(remote.ssh, `${sudo(facts)}dl up --answers-stdin --events json`, {
    input: "{}\n",
    onStdoutLine: (line) => replay.line(line),
  });
  replay.finish();
  if (result.code !== 0 || replay.error) {
    deps.io.err(`\n  ${c.red("✗")} Updating ${remote.name} failed: ${replay.error ?? `dl up exited with ${result.code}`}\n`);
    for (const line of replay.tail()) deps.io.err(`    ${c.dim(line)}\n`);
    deps.io.err("\n");
    return 1;
  }

  const after = await serverVersions(remote.ssh, deps.ssh);
  const changed = before && after && (before.autopilot !== after.autopilot || before.hotcell !== after.hotcell);
  const versions = after ? `  ${c.dim(`Autopilot ${after.autopilot} · Hotcell ${after.hotcell}`)}` : "";
  deps.io.out(`\n  ${c.green("✓")} ${remote.name} is up to date${changed ? "" : c.dim("  (already was)")}${versions}\n\n`);
  return 0;
}

/**
 * Decides what to do about running tasks: wait when asked or when nobody can answer, and
 * otherwise ask. Returns whether to go ahead.
 */
async function settleRunning(
  remote: RemoteServer,
  count: number,
  deps: UpdateDeps,
  running: (remote: RemoteServer) => Promise<number | undefined>,
  c: ReturnType<typeof palette>,
): Promise<boolean> {
  const tasks = `${count} task${count === 1 ? "" : "s"}`;
  if (deps.wait || !deps.interactive) {
    deps.io.out(`  ${c.cyan("·")} ${tasks} running on ${remote.name}; waiting for ${count === 1 ? "it" : "them"} to finish (Ctrl-C stops waiting).\n`);
    await waitForIdle(remote, deps, running);
    return true;
  }
  const answer = (await deps.prompter.text(`  ${tasks} running on ${remote.name}. Update now and interrupt ${count === 1 ? "it" : "them"}? [y/N] `)).trim().toLowerCase();
  if (answer === "y" || answer === "yes") return true;
  deps.io.out(`  ${c.dim("Not updating. Wait for them, then run")} dl update ${remote.name}${c.dim(", or add --wait.")}\n\n`);
  return false;
}

async function waitForIdle(
  remote: RemoteServer,
  deps: UpdateDeps,
  running: (remote: RemoteServer) => Promise<number | undefined>,
): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (;;) {
    const count = await running(remote);
    if (count === undefined || count === 0) return;
    await sleep(15_000);
  }
}
