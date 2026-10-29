import { execFile, spawn } from "node:child_process";
import { constants, existsSync, readFileSync } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PromptCancelled, type Prompter, type SelectOption } from "../prompt.js";
import { palette } from "../ui.js";
import { RemoteApiError, type RemoteClient } from "./client.js";
import { describeError, pickModel, type LaptopIO } from "./commands.js";
import { laptopModel } from "./settings.js";
import { loadRemotes, recordLastUsed, resolveRemote, resolveTarget, type RemoteServer } from "./config.js";
import {
  activityAt, ageLabel, isBlocked, listConversationsAcross, pickerOrder, resolveConversationId, summarize, type ConversationSummary,
} from "./conversations.js";
import { detectGitHubRepository, snapshotWorkingTree } from "./git.js";
import {
  findSession, forgetConversation, rememberSession, sessionsPath, touchSession, type SessionEntry, type SessionKey,
} from "./session-store.js";
import { openRemoteForSession, withConnections, type RemoteOpener } from "./tunnel.js";

/**
 * `dl` inside a project: Autopilot's own interactive screen, attached to this repository's
 * conversation on the place agents run (`autopilot attach-remote`). The first time it starts
 * one from this checkout (base commit + uncommitted changes, as `dl run` sends them); after
 * that it reopens the most recent one, and `dl attach` can open any of them from anywhere.
 * dl only finds the conversation, holds the SSH tunnel open, and gets out of the way:
 * Autopilot owns the terminal until the user detaches.
 */

const execFileAsync = promisify(execFile);

/** How to start Autopilot: `command ...args attach-remote …`. */
export interface AutopilotCommand {
  command: string;
  args: string[];
}

/** The parts of a child process a session needs; tests pass a fake. */
export interface SessionChild {
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export type SessionSpawner = (command: string, args: string[], env: NodeJS.ProcessEnv) => SessionChild;

/** Where SIGINT/SIGTERM/SIGHUP arrive; `process` unless a test replaces it. */
export interface SignalSource {
  on(event: NodeJS.Signals, listener: () => void): unknown;
  off(event: NodeJS.Signals, listener: () => void): unknown;
}

export interface SessionInput {
  cwd: string;
  server?: string;
  model?: string;
  /** `dl new`: start another conversation, keeping the previous ones reachable. */
  fresh?: boolean;
  open?: RemoteOpener;
  /** This laptop's default model (dl model, else Autopilot's); read from their configs unless replaced (tests). */
  autopilotModel?: () => Promise<string | undefined>;
  /** Finds Autopilot; the one installed with dl, else one on PATH, unless replaced (tests). */
  autopilot?: () => Promise<AutopilotCommand | undefined>;
  /** Whether that Autopilot has `attach-remote`. */
  probe?: (autopilot: AutopilotCommand) => Promise<boolean>;
  spawn?: SessionSpawner;
  signals?: SignalSource;
  sessionsFile?: string;
  /** Asks which conversation to reopen when several are running; none means never ask. */
  prompter?: Prompter;
  /** The clock for ages in the picker (tests). */
  now?: () => number;
}

export interface AttachInput {
  /** A conversation ID or unique prefix; without one, a picker. */
  id?: string;
  /** Limit the search to one place. */
  server?: string;
  cwd: string;
  open?: RemoteOpener;
  autopilot?: () => Promise<AutopilotCommand | undefined>;
  probe?: (autopilot: AutopilotCommand) => Promise<boolean>;
  spawn?: SessionSpawner;
  signals?: SignalSource;
  sessionsFile?: string;
  /** The picker; without one, `dl attach` needs an ID. */
  prompter?: Prompter;
  now?: () => number;
}

const realSpawn: SessionSpawner = (command, args, env) => spawn(command, args, { stdio: "inherit", env });

const FORWARDED: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

const UPDATE = "npm install -g directionallylocal";

class Interrupted extends Error {}

/** Ctrl-C (or a hang-up) before Autopilot starts stops dl; once it runs, Autopilot owns Ctrl-C. */
interface SessionControl {
  step<T>(work: Promise<T>): Promise<T>;
  setChild(child: SessionChild): void;
  dispose(): void;
}

function sessionControl(signals: SignalSource): SessionControl {
  let child: SessionChild | undefined;
  let interrupt: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { interrupt = () => reject(new Interrupted()); });
  interrupted.catch(() => {});
  const handlers = FORWARDED.map((name) => {
    const handler = () => {
      if (!child) interrupt();
      else if (name !== "SIGINT") child.kill(name);
    };
    signals.on(name, handler);
    return [name, handler] as const;
  });
  return {
    step: <T>(work: Promise<T>) => Promise.race([work, interrupted]),
    setChild: (started) => { child = started; },
    dispose: () => { for (const [name, handler] of handlers) signals.off(name, handler); },
  };
}

/**
 * Opens the session, or returns undefined when this isn't a project dl can open one for
 * (not a Git repository, origin not on GitHub, nothing pushed yet, or no place to pick),
 * after a one-line note for the last three, so the caller shows the overview instead.
 */
export async function projectSession(input: SessionInput, io: LaptopIO): Promise<number | undefined> {
  const c = palette(io.color === true);
  const note = (text: string) => io.err(`  ${c.yellow("!")} ${text}\n`);
  const root = await gitRoot(input.cwd);
  if (!root) return undefined;
  let repository: string;
  try {
    repository = await detectGitHubRepository(root);
  } catch {
    note(`${basename(root)}'s origin isn't on GitHub, so there's no agent conversation to open here.`);
    return undefined;
  }
  let target;
  try {
    target = await resolveTarget(input.server);
  } catch (error) {
    if (input.server !== undefined) throw error;
    note(describeError(error));
    return undefined;
  }
  const { remote, reason } = target;
  const key: SessionKey = { place: remote.name, repository, root };
  const file = input.sessionsFile ?? sessionsPath();
  const autopilot = await (input.autopilot ?? findAutopilot)();
  // Asked while the tunnel opens; it only matters right before launching.
  const ready = autopilot ? (input.probe ?? supportsAttachRemote)(autopilot).catch(() => false) : Promise.resolve(false);
  const control = sessionControl(input.signals ?? process);

  try {
    return await withConnections(input.open ?? openRemoteForSession, async (connections) => {
      const client = await control.step(connections.client(remote));
      let remembered = input.fresh ? undefined : await findSession(key, file);
      if (remembered) {
        const alive = await control.step(client.getConversation(remembered.conversationId).then(
          (conversation) => conversation.status !== "destroyed",
          (error: unknown) => {
            if (error instanceof RemoteApiError && (error.status === 404 || error.status === 410)) return false;
            throw error;
          },
        ));
        if (!alive) {
          await forgetConversation(key, remembered.conversationId, file);
          note(`The last conversation for ${repository} on ${remote.name} is gone; starting a new one.`);
          remembered = undefined;
        }
      }
      // Several agents running for this repository: offer the others, with the one `dl`
      // would reopen preselected (Enter keeps the default).
      let pickedAnother = false;
      if (!input.fresh && remembered && input.prompter) {
        let picked: string | undefined;
        try {
          picked = await control.step(quickPick(client, remote, repository, remembered, input.prompter, input.now?.() ?? Date.now()));
        } catch (error) {
          if (error instanceof PromptCancelled) {
            io.err("\n");
            return 130;
          }
          throw error;
        }
        if (picked && picked !== remembered.conversationId) {
          remembered = { ...remembered, conversationId: picked };
          pickedAnother = true;
        }
      }

      const scratch = await mkdtemp(join(tmpdir(), "dl-session-"));
      try {
        const stateFile = join(scratch, "state.json");
        const args = ["attach-remote", "--state-file", stateFile, "--title", `${remote.name} · ${repository}`];
        let detail: string;
        if (remembered) {
          args.push("--conversation", remembered.conversationId);
          detail = remembered.conversationId.slice(0, 8);
        } else {
          let snapshot;
          try {
            snapshot = await control.step(snapshotWorkingTree(root));
          } catch (error) {
            if (error instanceof Interrupted) throw error;
            note(`${describeError(error)}.`.replace(/\.\.$/, "."));
            return undefined;
          }
          const [workspaces, models, preferred] = await control.step(Promise.all([
            client.workspaces(),
            client.models(),
            input.model ? Promise.resolve(undefined) : (input.autopilotModel ?? laptopModel)(),
          ]));
          const workspace = workspaces[0];
          if (!workspace) throw new Error(`${remote.name} has no workspace this laptop can use`);
          const model = pickModel(models, input.model, preferred);
          args.push("--workspace", workspace.id, "--repo", repository, "--model", model, "--base-commit", snapshot.baseCommit);
          if (snapshot.patch) {
            const patchFile = join(scratch, "changes.patch");
            await writeFile(patchFile, snapshot.patch, { mode: 0o600 });
            args.push("--patch-file", patchFile);
          }
          const changes = snapshot.files.length ? ` + ${snapshot.files.length} local change${snapshot.files.length === 1 ? "" : "s"}` : "";
          detail = `new conversation from ${snapshot.baseCommit.slice(0, 7)}${changes}, ${model}`;
        }
        if (!autopilot || !(await control.step(ready))) return missingAutopilot(autopilot, io, c);

        // The place is on the Connecting line already; with more than one set up, also why this
        // one and how to pick another, as `dl run` does (a place named with --server needs neither).
        const chosen = reason === "default" || reason === "last used";
        io.err(`\n  ${c.cyan("·")} Connecting to ${c.bold(remote.name)}${chosen ? ` ${c.dim(`(${reason})`)}` : ""} · ${repository} …  ${c.dim(`(${detail})`)}\n`);
        if (chosen) io.err(`    ${c.dim("dl use NAME to change where dl runs")}\n`);
        // The token goes in the environment only: argv is visible to every user on the machine.
        const env = { ...process.env, AUTOPILOT_REMOTE_URL: client.baseUrl, AUTOPILOT_REMOTE_TOKEN: remote.token };
        const code = await launchAutopilot({
          autopilot,
          args,
          env,
          spawn: input.spawn ?? realSpawn,
          stateFile,
          control,
          initialId: pickedAnother ? undefined : remembered?.conversationId,
          onConversation: async (state) => {
            await rememberSession({ ...key, conversationId: state.conversationId, ...(state.branch ? { branch: state.branch } : {}) }, file);
          },
        });
        if (code === 2) return missingAutopilot(autopilot, io, c);
        if (code !== 0) return 1;
        await recordLastUsed(remote.name).catch(() => undefined);
        io.err(`\n  It keeps running on ${c.bold(remote.name)}. Type ${c.bold("dl")} here to come back, or ${c.bold("dl runs")}.\n\n`);
        return 0;
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    });
  } catch (error) {
    if (!(error instanceof Interrupted)) throw error;
    io.err("\n");
    return 130;
  } finally {
    control.dispose();
  }
}

/**
 * `dl attach [ID]`: open any conversation, from anywhere. With an ID (or a prefix unique
 * across places) it goes straight there; without one, a picker of every conversation on
 * every place, blocked ones first. It reuses the same tunnel and Autopilot launch as `dl`.
 */
export async function attachSession(input: AttachInput, io: LaptopIO): Promise<number> {
  const c = palette(io.color === true);
  const note = (text: string) => io.err(`  ${c.yellow("!")} ${text}\n`);
  const remotes = input.server ? [await resolveRemote(input.server)] : await loadRemotes();
  if (remotes.length === 0) throw new Error("Nothing is set up yet. Run: dl setup");
  const file = input.sessionsFile ?? sessionsPath();
  const autopilot = await (input.autopilot ?? findAutopilot)();
  const ready = autopilot ? (input.probe ?? supportsAttachRemote)(autopilot).catch(() => false) : Promise.resolve(false);
  const control = sessionControl(input.signals ?? process);

  try {
    return await withConnections(input.open ?? openRemoteForSession, async (connections) => {
      const listing = await control.step(listConversationsAcross(remotes, connections, { limit: 200 }));
      for (const entry of listing.unreachable) note(`${entry.place}: ${entry.reason}`);
      // Agents only: a chat conversation has no branch or cell to attach to.
      const rows = listing.rows.filter((row) => row.kind !== "chat");
      let chosen: ConversationSummary | undefined;
      if (input.id !== undefined) {
        chosen = resolveConversationId(input.id, rows, listing.unreachable);
      } else {
        if (!input.prompter) throw new Error("dl attach needs an ID here (there's no terminal to pick on). Try: dl attach ID");
        chosen = await control.step(pickConversation(rows, input.prompter, input.now?.() ?? Date.now()));
        if (!chosen) {
          io.err("\n");
          return 130;
        }
      }
      const remote = remotes.find((entry) => entry.name === chosen.place);
      if (!remote) throw new Error(`No place named "${chosen.place}" is set up`);
      const client = await control.step(connections.client(remote));
      const repository = chosen.repository ?? "conversation";
      const scratch = await mkdtemp(join(tmpdir(), "dl-attach-"));
      try {
        const stateFile = join(scratch, "state.json");
        const args = ["attach-remote", "--state-file", stateFile, "--title", `${remote.name} · ${repository}`, "--conversation", chosen.conversationId];
        if (!autopilot || !(await control.step(ready))) return missingAutopilot(autopilot, io, c);
        io.err(`\n  ${c.cyan("·")} Connecting to ${c.bold(remote.name)} · ${repository} …  ${c.dim(`(${chosen.conversationId.slice(0, 8)})`)}\n`);
        const env = { ...process.env, AUTOPILOT_REMOTE_URL: client.baseUrl, AUTOPILOT_REMOTE_TOKEN: remote.token };
        const code = await launchAutopilot({
          autopilot,
          args,
          env,
          spawn: input.spawn ?? realSpawn,
          stateFile,
          control,
          onConversation: async (state) => {
            await rememberAttached(chosen!, state, input.cwd, file);
          },
        });
        if (code === 2) return missingAutopilot(autopilot, io, c);
        if (code !== 0) return 1;
        await recordLastUsed(remote.name).catch(() => undefined);
        io.err(`\n  It keeps running on ${c.bold(remote.name)}. Type ${c.bold("dl")} here to come back, or ${c.bold("dl runs")}.\n\n`);
        return 0;
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    });
  } catch (error) {
    if (!(error instanceof Interrupted)) throw error;
    io.err("\n");
    return 130;
  } finally {
    control.dispose();
  }
}

/** Runs Autopilot on the conversation, remembering it as soon as it exists. 0 ok, 1 failed, 2 couldn't start. */
async function launchAutopilot(input: {
  autopilot: AutopilotCommand;
  args: string[];
  env: NodeJS.ProcessEnv;
  spawn: SessionSpawner;
  stateFile: string;
  control: SessionControl;
  /** The conversation it's opening, so the first poll doesn't save it again. */
  initialId?: string;
  onConversation: (state: { conversationId: string; branch?: string }) => Promise<void>;
}): Promise<number> {
  let saved = input.initialId;
  const save = async () => {
    const state = await readState(input.stateFile);
    if (!state || state.conversationId === saved) return;
    saved = state.conversationId;
    await input.onConversation(state);
  };
  // Remember it as soon as it exists, so a closed terminal doesn't lose it.
  const poll = setInterval(() => { void save().catch(() => {}); }, 500);
  poll.unref?.();
  const outcome = await new Promise<{ code: number | null } | Error>((resolve) => {
    const started = input.spawn(input.autopilot.command, [...input.autopilot.args, ...input.args], input.env);
    input.control.setChild(started);
    started.on("exit", (code) => resolve({ code }));
    started.on("error", (error) => resolve(error));
  }).finally(() => clearInterval(poll));
  await save().catch(() => {});
  if (outcome instanceof Error) return 2;
  if (outcome.code === 2) return 2;
  return outcome.code === 0 ? 0 : 1;
}

function missingAutopilot(autopilot: AutopilotCommand | undefined, io: LaptopIO, c: ReturnType<typeof palette>): number {
  io.err(`  ${c.red("✗")} The Autopilot that comes with dl ${autopilot ? "is too old to open a session" : "isn't installed"}. Update: ${c.bold(UPDATE)}\n`);
  return 1;
}

/** The picker's options: short ID, then state, repository, title and age. */
export function attachOptions(rows: ConversationSummary[], now = Date.now()): SelectOption[] {
  return rows.map((row) => ({
    value: `${row.place}/${row.conversationId}`,
    label: row.conversationId.slice(0, 8),
    detail: [row.state, row.repository ?? "", row.title ?? "", ageLabel(activityAt(row), now)].filter(Boolean).join(" · "),
  }));
}

async function pickConversation(rows: ConversationSummary[], prompter: Prompter, now: number): Promise<ConversationSummary | undefined> {
  if (rows.length === 0) throw new Error("No conversations on any connected place yet. Start one: dl");
  const ordered = pickerOrder(rows);
  const options = attachOptions(ordered, now);
  try {
    const picked = await prompter.select("Attach to", options, 0);
    return ordered.find((row) => `${row.place}/${row.conversationId}` === picked.value);
  } catch (error) {
    if (error instanceof PromptCancelled) return undefined;
    throw error;
  }
}

/**
 * `dl` in a repository with more than one agent running: the others, with the one it would
 * reopen preselected. undefined when there's nothing to choose between.
 */
async function quickPick(
  client: RemoteClient,
  remote: RemoteServer,
  repository: string,
  remembered: SessionEntry,
  prompter: Prompter,
  now: number,
): Promise<string | undefined> {
  const list = await client.listConversations(200).catch(() => []);
  const rows = list
    .filter((entry) => entry.repository === repository && (entry.kind === undefined || entry.kind === "code"))
    .map((entry) => summarize(entry, remote.name))
    .filter((entry) => entry.state === "running" || isBlocked(entry.state) || entry.conversationId === remembered.conversationId);
  const active = rows.filter((entry) => entry.state === "running" || isBlocked(entry.state));
  if (active.length < 2 || !rows.some((entry) => entry.conversationId === remembered.conversationId)) return undefined;
  const ordered = pickerOrder(rows);
  const options = attachOptions(ordered, now);
  const initial = Math.max(0, ordered.findIndex((entry) => entry.conversationId === remembered.conversationId));
  try {
    const picked = await prompter.select("Which conversation?", options, initial);
    return picked.value.slice(picked.value.indexOf("/") + 1);
  } catch (error) {
    if (error instanceof PromptCancelled) return undefined;
    throw error;
  }
}

/**
 * Attaching makes that conversation the one `dl` reopens: bump it when it's already
 * remembered, or remember it when this is a checkout of the same repository.
 */
async function rememberAttached(
  chosen: ConversationSummary,
  state: { conversationId: string; branch?: string },
  cwd: string,
  file: string,
): Promise<void> {
  if (await touchSession(chosen.place, state.conversationId, file)) return;
  const root = await gitRoot(cwd);
  if (!root || !chosen.repository) return;
  let repository: string;
  try {
    repository = await detectGitHubRepository(root);
  } catch {
    return;
  }
  if (repository !== chosen.repository) return;
  await rememberSession({
    place: chosen.place,
    repository,
    root,
    conversationId: state.conversationId,
    ...(state.branch ? { branch: state.branch } : {}),
  }, file);
}

/** What `attach-remote --state-file` wrote, once the conversation exists. */
async function readState(path: string): Promise<{ conversationId: string; branch?: string } | undefined> {
  const raw = await readFile(path, "utf8").catch(() => undefined);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { conversationId?: unknown; branch?: unknown };
    if (typeof parsed.conversationId !== "string" || !parsed.conversationId) return undefined;
    return { conversationId: parsed.conversationId, ...(typeof parsed.branch === "string" && parsed.branch ? { branch: parsed.branch } : {}) };
  } catch {
    return undefined; // still being written
  }
}

async function gitRoot(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The Autopilot installed with dl (run with this Node), else an `autopilot` on PATH. */
export async function findAutopilot(): Promise<AutopilotCommand | undefined> {
  const bundled = bundledAutopilot();
  if (bundled) return { command: process.execPath, args: [bundled] };
  const onPath = await autopilotOnPath();
  return onPath ? { command: onPath, args: [] } : undefined;
}

/**
 * autopilot-ai's bin script, found from where Node resolves the package for dl. Its exports
 * don't include package.json, so the entry point is resolved and its package root found above it.
 */
export function bundledAutopilot(resolve: (specifier: string) => string = (specifier) => import.meta.resolve(specifier)): string | undefined {
  for (const specifier of ["autopilot-ai/package.json", "autopilot-ai"]) {
    let dir: string;
    try {
      dir = dirname(fileURLToPath(resolve(specifier)));
    } catch {
      continue;
    }
    for (;;) {
      const manifest = join(dir, "package.json");
      if (existsSync(manifest)) {
        try {
          const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown; bin?: unknown };
          if (pkg.name === "autopilot-ai") {
            const bin = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin as Record<string, unknown> | undefined)?.autopilot;
            const path = typeof bin === "string" ? resolvePath(dir, bin) : undefined;
            return path && existsSync(path) ? path : undefined;
          }
        } catch {
          // not a readable manifest; keep looking up
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

export async function autopilotOnPath(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, "autopilot");
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
  }
  return undefined;
}

/** An Autopilot that knows `attach-remote` lists its options (an older one prints its general help). */
export async function supportsAttachRemote(autopilot: AutopilotCommand): Promise<boolean> {
  try {
    const { stdout, stderr } = await execFileAsync(autopilot.command, [...autopilot.args, "attach-remote", "--help"], {
      timeout: 30_000,
      env: { ...process.env, NO_COLOR: "1" },
    });
    return `${stdout}${stderr}`.includes("--state-file");
  } catch {
    return false;
  }
}
