import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { promisify } from "node:util";
import { isModelNotPriced } from "../model-prices.js";
import { palette } from "../ui.js";
import { RemoteApiError, RemoteClient, TERMINAL_STATUSES, type RemoteConversation, type RemoteEvent } from "./client.js";
import {
  defaultRemoteName, loadRemotes, loadRemotesFile, normalizeServerUrl, recordLastUsed, REMOTE_NAME_RE, removeRemote, renameRemote, resolveRemote, resolveTarget,
  saveRemote, setDefaultRemote, type RemoteServer, type TargetReason,
} from "./config.js";
import { PAIRED_NAME } from "../local/layout.js";
import { detectGitHubRepository, snapshotWorkingTree } from "./git.js";
import { DEFAULT_MODEL, laptopModel } from "./settings.js";
import { sshCommandLine } from "./ssh.js";
import { openBrowser } from "./open-browser.js";
import { withConnections, type Connections, type RemoteOpener } from "./tunnel.js";
import { outdatedServers, type LatestVersions } from "./update.js";
import type { SshExec } from "./ssh.js";

export { DEFAULT_MODEL, readAutopilotModel } from "./settings.js";

/**
 * `dl` on a laptop: send tasks to where agents run (this computer, or your own server),
 * follow them, and check out the pull requests. It talks to the server's API directly (the
 * same one Autopilot's `--on` uses, and shares its list of servers), so the laptop needs
 * nothing else.
 * Servers set up with `dl setup` are reached through an SSH tunnel that each command
 * opens and closes (see tunnel.ts); `open` lets tests swap the tunnel out.
 */

const execFileAsync = promisify(execFile);
const RUN_END_EVENTS = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** The model a task gets when neither -m nor the laptop's Autopilot picks one the server offers. */

export interface LaptopIO {
  out: (text: string) => void;
  err: (text: string) => void;
  color?: boolean;
}

export const processIO: LaptopIO = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  color: process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== "dumb",
};

/** `dl connect <url>`: pair this laptop with a server. No keys are copied. */
export async function connect(
  input: { url: string; name?: string; open?: boolean; signal?: AbortSignal; sleep?: (ms: number) => Promise<void> },
  io = processIO,
): Promise<RemoteServer> {
  const c = palette(io.color === true);
  const url = normalizeServerUrl(input.url);
  const name = input.name ?? defaultRemoteName(url);
  if (!REMOTE_NAME_RE.test(name)) throw new Error("Server names are 1-40 lowercase letters, digits, or dashes");
  const anonymous = new RemoteClient(url, undefined);
  const device = await anonymous.startDeviceAuthorization(clientName());
  io.out(`\n  ${c.bold("Connect this laptop")} ${c.dim(`to ${url}`)}\n\n`);
  io.out(`  Approve code ${c.bold(device.userCode)} in the browser you approve laptops with:\n     ${device.verificationUriComplete}\n`);
  if (input.open !== false && openBrowser(device.verificationUriComplete)) io.out(`     ${c.dim("(opened it for you)")}\n`);
  io.out(`  ${c.dim(`Or on the server: dl connect-laptop ${device.userCode}`)}\n\n  ${c.cyan("·")} Waiting for approval…\n`);
  const credential = await anonymous.waitForCredential(device, {
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.sleep ? { sleep: input.sleep } : {}),
  });
  const remote: RemoteServer = {
    name,
    url,
    token: credential.token,
    credentialId: credential.credentialId,
    expiresAt: credential.expiresAt,
    addedAt: new Date().toISOString(),
  };
  await new RemoteClient(url, remote.token).health();
  await saveRemote(remote);
  io.out(`${rewrite(io)}  ${c.green("✓")} Connected as ${c.bold(name)}  ${c.dim(`until ${remote.expiresAt.slice(0, 10)}`)}\n\n`);
  io.out(`  ${c.dim("Next, from inside a GitHub repository:")}\n     ${c.bold('dl run "fix the flaky checkout test"')}\n\n`);
  return remote;
}

/**
 * `dl run "task"`: the task runs in its own sandbox on the server, starting from this
 * checkout (uncommitted changes go along). Follows it until it ends; Ctrl-C only detaches.
 */
export async function run(input: {
  task: string;
  cwd: string;
  server?: string;
  model?: string;
  preferredModel?: string;
  repository?: string;
  detach?: boolean;
  signal?: AbortSignal;
  open?: RemoteOpener;
  /** This laptop's default model (dl model, else Autopilot's); read from their configs unless replaced (tests). */
  autopilotModel?: () => Promise<string | undefined>;
}, io = processIO): Promise<number> {
  const { remote, reason } = await resolveTarget(input.server);
  const preferred = input.preferredModel ?? await (input.autopilotModel ?? laptopModel)();
  return withConnections(input.open, async (connections) => runOn(await connections.client(remote), remote, reason, { ...input, ...(preferred ? { preferredModel: preferred } : {}) }, io));
}

async function runOn(client: RemoteClient, remote: RemoteServer, reason: TargetReason, input: Parameters<typeof run>[0], io: LaptopIO): Promise<number> {
  const c = palette(io.color === true);
  const repository = input.repository ?? await detectGitHubRepository(input.cwd);
  const snapshot = await snapshotWorkingTree(input.cwd);
  const [workspaces, models] = await Promise.all([client.workspaces(), client.models()]);
  const workspace = workspaces[0];
  if (!workspace) throw new Error(`${remote.name} has no workspace this laptop can use`);
  const model = pickModel(models, input.model, input.preferredModel);

  const changes = snapshot.files.length ? ` + ${snapshot.files.length} local change${snapshot.files.length === 1 ? "" : "s"}` : "";
  const why = reason === "default" || reason === "last used" ? ` ${c.dim(`(${reason})`)}` : "";
  io.err(`\n  ${c.cyan("·")} Sending to ${c.bold(remote.name)}${why}: ${repository} at ${snapshot.baseCommit.slice(0, 7)}${changes}  ${c.dim(model)}\n`);
  const conversation = await client.createCodeConversation({
    workspaceId: workspace.id,
    model,
    repository,
    baseCommit: snapshot.baseCommit,
    ...(snapshot.patch ? { patch: snapshot.patch } : {}),
    idempotencyKey: `dl-${randomUUID()}`,
  });
  await client.submitTurn(conversation.conversationId, input.task, `dl-${randomUUID()}`);
  // Only a fallback (a default, or the only place, always wins), so failing to write it is harmless.
  await recordLastUsed(remote.name).catch(() => undefined);
  const id = conversation.conversationId.slice(0, 8);
  io.err(`${rewrite(io)}  ${c.green("✓")} Started ${c.bold(id)} on ${remote.name}  ${c.dim(`branch ${conversation.branch ?? "?"}`)}\n`);
  if (input.detach) {
    io.err(`\n  ${c.dim("It runs on its own. Follow it:")} dl watch ${id}\n\n`);
    return 0;
  }
  io.err(`  ${c.dim(`Ctrl-C stops watching; the task keeps running (dl watch ${id}).`)}\n\n`);
  return follow(client, remote, conversation.conversationId, conversation.lastEventId, input.signal, io);
}

/** `dl runs`: tasks on every connected server, newest first. */
export async function runs(input: { server?: string; json?: boolean; open?: RemoteOpener }, io = processIO): Promise<void> {
  const remotes = input.server ? [await resolveRemote(input.server)] : await loadRemotes();
  if (remotes.length === 0) throw new Error("Nothing is set up yet. Run: dl setup  (or, for a server someone else set up: dl connect https://your-server)");
  return withConnections(input.open, (connections) => listRuns(remotes, connections, input.json === true, io));
}

async function listRuns(remotes: RemoteServer[], connections: Connections, json: boolean, io: LaptopIO): Promise<void> {
  const c = palette(io.color === true);
  const rows: Array<RemoteConversation & { server: string }> = [];
  for (const remote of remotes) {
    try {
      const list = await (await connections.client(remote)).listConversations();
      rows.push(...list.filter((entry) => entry.kind === "code").map((entry) => ({ ...entry, server: remote.name })));
    } catch (error) {
      io.err(`  ${c.red("✗")} ${remote.name}: ${describeError(error)}\n`);
    }
  }
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (json) {
    io.out(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  if (rows.length === 0) {
    io.out(`\n  No tasks yet. From inside a GitHub repository:  ${c.bold('dl run "fix the flaky checkout test"')}\n\n`);
    return;
  }
  const reasons = await failureReasons(rows, remotes, connections);
  io.out("\n");
  for (const entry of rows) {
    const running = entry.activeRunId !== null;
    const glyph = running ? c.cyan("◐") : entry.status === "completed" || entry.status === "merged" ? c.green("✓") : ["failed", "interrupted"].includes(entry.status) ? c.red("✗") : c.dim("○");
    const multi = remotes.length > 1 ? `${entry.server}  ` : "";
    io.out(`  ${glyph} ${entry.conversationId.slice(0, 8)}  ${multi}${(running ? "running" : entry.status).padEnd(11)} ${(entry.repository ?? "").padEnd(26)} ${c.dim(entry.pullRequestURL ?? entry.branch ?? "")}\n`);
    const reason = reasons.get(entry.conversationId);
    if (reason) io.out(`      ${c.dim(oneLine(reason, 100))}\n`);
  }
  io.out(`\n  ${c.dim("Follow one:")} dl watch <id>   ${c.dim("Check one out:")} dl pull <id>\n\n`);
}

/** `dl watch <id>`: replay and follow a task's output. */
export async function watch(input: { id: string; server?: string; signal?: AbortSignal; open?: RemoteOpener }, io = processIO): Promise<number> {
  return withConnections(input.open, async (connections) => {
    const { remote, run: found } = await findRun(input.id, input.server, connections);
    const client = await connections.client(remote);
    const finished = TERMINAL_STATUSES.has(found.status) && !found.activeRunId;
    return follow(client, remote, found.conversationId, 0, input.signal, io, finished ? found.lastEventId : undefined);
  });
}

export async function cancel(input: { id: string; server?: string; open?: RemoteOpener }, io = processIO): Promise<void> {
  const c = palette(io.color === true);
  await withConnections(input.open, async (connections) => {
    const { remote, run: found } = await findRun(input.id, input.server, connections);
    await (await connections.client(remote)).cancel(found.conversationId);
    io.out(`  ${c.green("✓")} Stopped ${found.conversationId.slice(0, 8)}\n`);
  });
}

/** `dl pull <id>`: check out a task's branch here. */
export async function pull(input: { id: string; server?: string; cwd: string; open?: RemoteOpener }, io = processIO): Promise<void> {
  const c = palette(io.color === true);
  // The server is only asked for the branch name; the code itself comes from GitHub.
  const { run: found } = await withConnections(input.open, (connections) => findRun(input.id, input.server, connections));
  const branch = found.branch;
  if (!branch) throw new Error("That task has no branch");
  if (found.activeRunId) io.err(`  ${c.yellow("!")} It's still running; you'll get what it has pushed so far.\n`);
  const git = (args: string[]) => execFileAsync("git", ["-C", input.cwd, ...args]);
  try {
    await git(["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  } catch {
    throw new Error(`Branch ${branch} isn't on GitHub yet (a task pushes it when it finishes a step)`);
  }
  const exists = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false);
  if (exists) {
    await git(["switch", branch]);
    await git(["merge", "--ff-only", `origin/${branch}`]);
  } else {
    await git(["switch", "-c", branch, "--track", `origin/${branch}`]);
  }
  io.out(`  ${c.green("✓")} On ${c.bold(branch)}${found.pullRequestURL ? `  ${c.dim(found.pullRequestURL)}` : ""}\n`);
}

/** `dl servers [remove NAME | rename OLD NEW]`: the servers this laptop is connected to. */
export async function servers(args: string[], io = processIO): Promise<number> {
  const c = palette(io.color === true);
  if (args[0] === "rename") return renameServer(args.slice(1), io);
  if (args[0] === "remove") {
    const name = args[1] ?? "";
    const removed = (await loadRemotes()).find((remote) => remote.name === name);
    if (!removed || !(await removeRemote(name))) {
      io.err(`  ${c.red("✗")} Not connected to "${name}".\n`);
      return 1;
    }
    const onServer = `sudo dl laptops remove "${clientName()}"`;
    io.out(`  ${c.green("✓")} Forgot ${name}. To disconnect it on the server too: ${removed.ssh ? `${sshCommandLine(removed.ssh)} '${onServer}'` : onServer}\n`);
    return 0;
  }
  const remotes = await loadRemotes();
  if (remotes.length === 0) {
    io.out(`\n  Nothing set up yet.  ${c.bold("dl setup")}  ${c.dim("or, for a server someone else set up:")} ${c.bold("dl connect https://your-server")}\n\n`);
    return 0;
  }
  const current = await defaultName();
  io.out("\n");
  for (const remote of remotes) io.out(`  ${mark(remote, current, c)} ${remote.name.padEnd(16)} ${where(remote)}  ${c.dim(`until ${remote.expiresAt.slice(0, 10)}`)}\n`);
  io.out(remotes.length > 1 ? `\n  ${c.dim(`● is where tasks go without --server. Change it: dl use NAME`)}\n\n` : "\n");
  return 0;
}

/** `dl use [NAME]`: set, or show, where commands go when no --server is given. */
export async function use(args: string[], io = processIO): Promise<number> {
  const c = palette(io.color === true);
  const name = args[0];
  if (name === undefined) {
    const file = await loadRemotesFile();
    if (file.remotes.length === 0) {
      io.out(`  Nothing set up yet.  ${c.bold("dl setup")}\n`);
      return 0;
    }
    const current = await defaultName();
    io.out(current
      ? `  Tasks go to ${c.bold(current)} unless you pass --server NAME.${file.remotes.length > 1 ? `  ${c.dim(`Change it: dl use NAME (${file.remotes.map((entry) => entry.name).join(", ")})`)}` : ""}\n`
      : `  No default yet. Pick one: dl use NAME  ${c.dim(`(${file.remotes.map((entry) => entry.name).join(", ")})`)}\n`);
    return 0;
  }
  try {
    const remote = await setDefaultRemote(name);
    io.out(`  ${c.green("✓")} Tasks now go to ${c.bold(remote.name)} ${c.dim(where(remote))} unless you pass --server NAME.\n`);
    return 0;
  } catch (error) {
    io.err(`  ${c.red("✗")} ${describeError(error)}\n`);
    return 1;
  }
}

/** Where a command without --server goes, or undefined when that's ambiguous. */
async function defaultName(): Promise<string | undefined> {
  return resolveTarget(undefined).then((target) => target.remote.name, () => undefined);
}

function mark(remote: RemoteServer, current: string | undefined, c: ReturnType<typeof palette>): string {
  return remote.name === current ? c.green("●") : c.dim("○");
}

/** `dl servers rename OLD NEW`: only this laptop's name for it; the server doesn't change. */
export async function renameServer(args: string[], io = processIO, path?: string): Promise<number> {
  const c = palette(io.color === true);
  const [from, to] = args;
  if (!from || !to || args.length > 2) {
    io.err(`  Usage: dl servers rename OLD NEW   ${c.dim("(names: lowercase letters, digits, and dashes)")}\n`);
    return 2;
  }
  try {
    await renameRemote(from, to, path);
  } catch (error) {
    io.err(`  ${c.red("✗")} ${(error as Error).message}.\n`.replace(/\.\.\n$/, ".\n"));
    return 1;
  }
  io.out(`  ${c.green("✓")} Renamed ${from} to ${c.bold(to)}  ${c.dim(`dl run --server ${to} …`)}\n`);
  return 0;
}

/** `dl` on a laptop: what this is, which servers it's connected to, what to type next. */
export async function laptopHome(
  io = processIO,
  open?: RemoteOpener,
  model: () => Promise<string | undefined> = laptopModel,
  versions?: { ssh: SshExec; latest?: () => Promise<LatestVersions | undefined> },
): Promise<boolean> {
  const c = palette(io.color === true);
  const remotes = await loadRemotes();
  if (remotes.length === 0) return false;
  let running = 0;
  let total = 0;
  await withConnections(open, async (connections) => {
    for (const remote of remotes) {
      const list = await connections.client(remote).then((client) => client.listConversations()).catch(() => undefined);
      running += list?.filter((entry) => entry.activeRunId !== null).length ?? 0;
      total += list?.length ?? 0;
    }
  });
  const [current, chosen, outdated] = await Promise.all([
    defaultName(),
    model(),
    versions ? outdatedServers(remotes, versions).catch(() => []) : Promise.resolve([]),
  ]);
  io.out(`\n  ${c.bold("Directionally Local")}  ${c.dim("on this laptop")}\n\n`);
  io.out("  Coding agents that run on this computer or your own server: send a task, get a pull request back.\n\n");
  io.out(`  ${c.dim("Runs on".padEnd(11))}${remotes.map((remote) => `${mark(remote, current, c)} ${remote.name} ${c.dim(where(remote))}`).join(", ")}   ${c.dim(remotes.length > 1 ? "dl servers · dl use NAME" : "dl servers")}\n`);
  io.out(`  ${c.dim("Tasks".padEnd(11))}${running} running · ${total} in all   ${c.dim("dl runs")}\n`);
  io.out(`  ${c.dim("Model".padEnd(11))}${chosen ?? DEFAULT_MODEL}   ${c.dim("dl model")}\n`);
  for (const entry of outdated) io.out(`  ${c.yellow("!")} ${entry.name} is behind: ${entry.notice}   ${c.dim(`dl update ${entry.name}`)}\n`);
  io.out("\n");
  io.out(`  ${c.dim("Start a session: cd into a GitHub repository, then type")}  ${c.bold("dl")}\n`);
  io.out(`  ${c.dim("Or hand off a one-off task:")}  ${c.bold('dl run "fix the flaky checkout test"')}\n\n`);
  return true;
}

async function follow(
  client: RemoteClient,
  remote: RemoteServer,
  conversationId: string,
  cursor: number,
  signal: AbortSignal | undefined,
  io: LaptopIO,
  replayUntil?: number,
): Promise<number> {
  const c = palette(io.color === true);
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener("abort", stop, { once: true });
  const renderer = new EventRenderer(io, c);
  let outcome: string | undefined;
  let finalEvent: RemoteEvent | undefined;
  try {
    if (replayUntil === undefined || replayUntil > cursor) {
      for await (const event of client.events(conversationId, cursor, controller.signal)) {
        renderer.render(event);
        if (RUN_END_EVENTS.has(event.type)) {
          outcome = event.type;
          finalEvent = event;
        }
        if (replayUntil === undefined ? RUN_END_EVENTS.has(event.type) : event.id >= replayUntil) break;
      }
    }
    if (replayUntil !== undefined && !controller.signal.aborted) outcome ??= "completed";
  } finally {
    signal?.removeEventListener("abort", stop);
    controller.abort();
  }
  renderer.finish();
  const id = conversationId.slice(0, 8);
  if (!outcome) {
    io.err(`\n  ${c.dim(`Stopped watching ${id}; it keeps running on ${remote.name}.`)} dl watch ${id}\n`);
    return 0;
  }
  const final = await client.getConversation(conversationId);
  if (outcome === "completed") {
    io.err(`\n  ${c.green("✓")} ${c.bold(id)} done${final.pullRequestURL ? `  ${final.pullRequestURL}` : c.dim("  (no changes, so no pull request)")}\n`);
    if (final.pullRequestURL) io.err(`  ${c.dim("Check it out here:")} dl pull ${id}\n`);
    io.err("\n");
    return 0;
  }
  io.err(`\n  ${c.red("✗")} ${id} ${outcome}\n`);
  const reason = failureReason(finalEvent);
  if (reason) for (const line of wrap(reason, 100, 3)) io.err(`    ${c.dim(line)}\n`);
  if (renderer.unpriced || isModelNotPriced(JSON.stringify(final))) {
    io.err(`  This model isn't in your server's price list yet. Run ${c.bold("dl setup")} to refresh it, or pick another model with -m.\n`);
  } else {
    const hint = reason ? failureHint(reason) : undefined;
    if (hint) io.err(`  ${c.dim(hint)}\n`);
  }
  io.err("\n");
  return 1;
}

/** Writes the agent's text as it streams and one line per tool call. */
class EventRenderer {
  private midLine = false;
  /** Hotcell refused the model for lack of a price (a stale price list on the server). */
  unpriced = false;

  constructor(private readonly io: LaptopIO, private readonly c: ReturnType<typeof palette>) {}

  render(event: RemoteEvent): void {
    const data = event.data;
    if (event.type !== "assistant.delta" && !this.unpriced && isModelNotPriced(JSON.stringify(data))) this.unpriced = true;
    if (event.type === "assistant.delta") {
      const text = typeof data.text === "string" ? data.text : typeof data.delta === "string" ? data.delta : "";
      if (!text) return;
      this.io.out(text);
      this.midLine = !text.endsWith("\n");
      return;
    }
    if (event.type === "tool.activity" && data.activity === "started") {
      const input = typeof data.input === "string" ? ` ${oneLine(data.input, 110)}` : "";
      this.line(`  ${this.c.dim(`› ${String(data.tool ?? "tool")}${input}`)}`);
      return;
    }
    if (event.type === "tool.activity" && data.activity === "failed") {
      this.line(`  ${this.c.red(`✗ ${String(data.tool ?? "tool")} failed`)}`);
      return;
    }
    if (event.type === "checkpoint.created" && typeof data.message === "string") {
      this.line(`  ${this.c.dim(`● ${oneLine(data.message, 100)}`)}`);
    }
  }

  finish(): void {
    if (this.midLine) this.io.out("\n");
    this.midLine = false;
  }

  private line(text: string): void {
    this.finish();
    this.io.out(`${text}\n`);
  }
}

async function findRun(id: string, server: string | undefined, connections: Connections): Promise<{ remote: RemoteServer; run: RemoteConversation }> {
  const needle = id.trim().toLowerCase();
  if (!/^[0-9a-f-]{4,36}$/.test(needle)) throw new Error("Task IDs are the short hex IDs dl runs shows");
  const remotes = server ? [await resolveRemote(server)] : await loadRemotes();
  const matches: Array<{ remote: RemoteServer; run: RemoteConversation }> = [];
  const unreachable: string[] = [];
  for (const remote of remotes) {
    const list = await connections.client(remote).then((client) => client.listConversations(200)).catch((error: unknown) => {
      unreachable.push(`${remote.name}: ${describeError(error)}`);
      return [];
    });
    for (const entry of list) if (entry.conversationId.startsWith(needle)) matches.push({ remote, run: entry });
  }
  // Say why when a server couldn't be asked (e.g. its SSH tunnel failed), rather than "no task".
  if (matches.length === 0) throw new Error(`No task ${id} on ${server ?? "any connected server"}${unreachable.length ? `\n${unreachable.join("\n")}` : ""}`);
  if (matches.length > 1) throw new Error(`${id} matches several tasks; use more characters`);
  return matches[0]!;
}

/**
 * The task's model: -m/--model; else the laptop's default (dl model, else Autopilot's), if the server offers it;
 * else DEFAULT_MODEL, if offered. Never just the first in the server's list (that's the
 * whole OpenRouter catalog, in no useful order).
 */
export function pickModel(models: string[], requested: string | undefined, preferred: string | undefined): string {
  const how = `Pick one: dl run -m <model> "task"  (model IDs: https://openrouter.ai/models)`;
  if (requested) {
    if (!models.includes(requested)) throw new Error(`The server doesn't offer ${requested}. ${how}`);
    return requested;
  }
  if (preferred && models.includes(preferred)) return preferred;
  if (models.includes(DEFAULT_MODEL)) return DEFAULT_MODEL;
  if (models.length === 0) throw new Error("The server offers no models; check its OpenRouter key (on the server: dl doctor)");
  const tried = preferred && preferred !== DEFAULT_MODEL ? `your model (${preferred}) or ${DEFAULT_MODEL}` : DEFAULT_MODEL;
  throw new Error(`The server doesn't offer ${tried}. ${how}`);
}


/** Where a place is, as people know it: this computer, its URL, or the SSH destination its tunnel goes to. */
export function where(remote: RemoteServer): string {
  if (remote.ssh) return `ssh ${remote.ssh.target}${remote.ssh.port ? `:${remote.ssh.port}` : ""}`;
  return remote.name === PAIRED_NAME ? "this computer" : remote.url;
}

function clientName(): string {
  const host = hostname().replace(/\.local$/, "").replace(/[^\p{L}\p{N} ._'()@-]/gu, "-").slice(0, 40) || "laptop";
  return `${host} (dl)`;
}

/** On a terminal, replace the previous "·" line with its outcome; elsewhere just add a line. */
function rewrite(io: LaptopIO): string {
  return io.color === true ? "\x1b[1F\x1b[2K" : "";
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The reason a run ended, from its final event. Servers have used `reason`, `error` and `message`. */
export function failureReason(event: RemoteEvent | undefined): string | undefined {
  if (!event) return undefined;
  for (const key of ["reason", "error", "message", "detail"]) {
    const value = event.data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** A next step for the reasons we recognise, or undefined. */
export function failureHint(reason: string): string | undefined {
  const text = reason.toLowerCase();
  if (/context window|token limit|too many tokens|maximum context/.test(text)) return "pick a model with a bigger window: dl model";
  if (/not priced|no such model|model not found|not offered|unknown model/.test(text)) return "pick another model: dl model";
  if (/rate limit|429|quota/.test(text)) return "wait a moment, or check the OpenRouter key: dl keys openrouter";
  if (/git_push_failed|push failed|permission denied|bad credentials|401/.test(text)) return "check the GitHub token: dl keys github";
  if (/out of memory|oom|killed/.test(text)) return "the sandbox ran out of memory; try a smaller task";
  return undefined;
}

/** `text` broken into at most `maxLines` lines of `width`, with an ellipsis when it was cut. */
export function wrap(text: string, width: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = `${kept[maxLines - 1]!.slice(0, width - 1)}…`;
  return kept;
}

/** How many failed tasks `dl runs` asks about; each one is a request. */
const REASON_LOOKUPS = 10;

/** One line per failed task, from its final event. */
async function failureReasons(
  rows: Array<RemoteConversation & { server: string }>,
  remotes: RemoteServer[],
  connections: Connections,
): Promise<Map<string, string>> {
  const reasons = new Map<string, string>();
  let lookups = 0;
  for (const entry of rows) {
    if (lookups >= REASON_LOOKUPS) break;
    if (entry.activeRunId !== null || !["failed", "interrupted"].includes(entry.status)) continue;
    const remote = remotes.find((candidate) => candidate.name === entry.server);
    if (!remote) continue;
    lookups++;
    const event = await connections.client(remote)
      .then((client) => client.lastEvent(entry.conversationId, entry.lastEventId))
      .catch(() => undefined);
    const reason = failureReason(event);
    if (reason) reasons.set(entry.conversationId, reason);
  }
  return reasons;
}

export function describeError(error: unknown): string {
  if (error instanceof RemoteApiError) return `${error.message} (${error.code})`;
  return error instanceof Error ? error.message : String(error);
}
