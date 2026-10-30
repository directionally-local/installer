import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { palette } from "../ui.js";
import { findAutopilot, supportsAttachRemote, type AutopilotCommand } from "./autopilot.js";
import { RemoteApiError } from "./client.js";
import { describeError, pickModel, type LaptopIO } from "./commands.js";
import { laptopModel } from "./settings.js";
import { recordLastUsed, resolveTarget } from "./config.js";
import { detectGitHubRepository, snapshotWorkingTree } from "./git.js";
import { findSession, forgetSession, rememberSession, sessionsPath, type SessionKey } from "./session-store.js";
import { openRemoteForSession, withConnections, type RemoteOpener } from "./tunnel.js";

export { autopilotOnPath, bundledAutopilot, findAutopilot, supportsAttachRemote, type AutopilotCommand } from "./autopilot.js";

/**
 * `dl` anywhere: Autopilot's own interactive screen, attached to a conversation on the place
 * agents run (`autopilot attach-remote`). Inside a GitHub repository that's the repository's
 * code conversation, started the first time from this checkout (base commit + uncommitted
 * changes, as `dl run` sends them) and reopened after that. Anywhere else it's a chat on the
 * place, remembered per directory so `dl` again resumes it. dl only finds the conversation,
 * holds the SSH tunnel open, and gets out of the way: Autopilot owns the terminal until the
 * user detaches.
 */

const execFileAsync = promisify(execFile);

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
  /** `dl new`: forget this directory's conversation and start another. */
  fresh?: boolean;
  open?: RemoteOpener;
  /** This laptop's default model for the place (dl model, else Autopilot's); read from their configs unless replaced (tests). */
  autopilotModel?: (place: string) => Promise<string | undefined>;
  /** Finds Autopilot; the one installed with dl, else one on PATH, unless replaced (tests). */
  autopilot?: () => Promise<AutopilotCommand | undefined>;
  /** Whether that Autopilot has `attach-remote`. */
  probe?: (autopilot: AutopilotCommand) => Promise<boolean>;
  spawn?: SessionSpawner;
  signals?: SignalSource;
  sessionsFile?: string;
}

const realSpawn: SessionSpawner = (command, args, env) => spawn(command, args, { stdio: "inherit", env });

const FORWARDED: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

const UPDATE = "npm install -g directionallylocal";

class Interrupted extends Error {}

/** What kind of conversation this directory gets, and why when it isn't the repository's. */
export interface SessionPlan {
  kind: "code" | "chat";
  /** The checkout's top level (code), or the directory itself (chat). */
  root: string;
  /** owner/name on GitHub (code). */
  repository?: string;
  /** One line said before a chat opens in a repository that can't have a code session. */
  note?: string;
}

/**
 * Inside a GitHub repository with something pushed: its code session. Anywhere else a chat,
 * with one line saying why when the directory is a repository (origin elsewhere, nothing pushed yet).
 */
export async function planSession(cwd: string): Promise<SessionPlan> {
  const root = await gitRoot(cwd);
  const here = await realpath(cwd).catch(() => cwd);
  if (!root) return { kind: "chat", root: here };
  try {
    const repository = await detectGitHubRepository(root);
    return { kind: "code", root, repository };
  } catch (error) {
    const message = describeError(error);
    const why = /no "origin" git remote/.test(message) ? `${basename(root)} has no origin remote` : `${basename(root)}'s origin isn't on GitHub`;
    return { kind: "chat", root: here, note: `${why}, so this is a chat, not a session on its code.` };
  }
}

/**
 * Opens the session for this directory (code or chat), or returns undefined when there's no
 * place to open it on (nothing set up, or several and no default), after a one-line note, so
 * the caller shows what to do instead.
 */
export async function openSession(input: SessionInput, io: LaptopIO): Promise<number | undefined> {
  return startSession(await planSession(input.cwd), input, io);
}

/**
 * The repository's code session, or undefined (after a one-line note) when this directory
 * can't have one: kept for `dl new`, which only makes sense where a conversation belongs.
 */
export async function projectSession(input: SessionInput, io: LaptopIO): Promise<number | undefined> {
  const plan = await planSession(input.cwd);
  if (plan.kind === "code") return startSession(plan, input, io);
  if (plan.note) io.err(`  ${palette(io.color === true).yellow("!")} ${plan.note}\n`);
  return undefined;
}

async function startSession(plan: SessionPlan, input: SessionInput, io: LaptopIO): Promise<number | undefined> {
  const c = palette(io.color === true);
  const note = (text: string) => io.err(`  ${c.yellow("!")} ${text}\n`);
  let target;
  try {
    target = await resolveTarget(input.server);
  } catch (error) {
    if (input.server !== undefined) throw error;
    note(describeError(error));
    return undefined;
  }
  const { remote, reason } = target;
  const key: SessionKey = plan.kind === "code"
    ? { place: remote.name, repository: plan.repository!, root: plan.root }
    : { place: remote.name, root: plan.root, kind: "chat" };
  const subject = plan.kind === "code" ? plan.repository! : "chat";
  const file = input.sessionsFile ?? sessionsPath();
  const autopilot = await (input.autopilot ?? findAutopilot)();
  // Asked while the tunnel opens; it only matters right before launching.
  const ready = autopilot ? (input.probe ?? supportsAttachRemote)(autopilot).catch(() => false) : Promise.resolve(false);
  const missing = () => {
    io.err(`  ${c.red("✗")} The Autopilot that comes with dl ${autopilot ? "is too old to open a session" : "isn't installed"}. Update: ${c.bold(UPDATE)}\n`);
    return 1;
  };

  // Ctrl-C (or a hang-up) before Autopilot starts stops dl, closing the tunnel on the way out;
  // once it runs, Autopilot handles Ctrl-C itself and dl only passes on SIGTERM/SIGHUP.
  const signals = input.signals ?? process;
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
  const step = <T>(work: Promise<T>): Promise<T> => Promise.race([work, interrupted]);

  try {
    return await withConnections(input.open ?? openRemoteForSession, async (connections) => {
      const client = await step(connections.client(remote));
      let remembered = input.fresh ? undefined : await findSession(key, file);
      if (remembered) {
        const alive = await step(client.getConversation(remembered.conversationId).then(
          (conversation) => conversation.status !== "destroyed",
          (error: unknown) => {
            if (error instanceof RemoteApiError && (error.status === 404 || error.status === 410)) return false;
            throw error;
          },
        ));
        if (!alive) {
          await forgetSession(key, file);
          note(`The last ${plan.kind === "code" ? `conversation for ${subject}` : "chat"} on ${remote.name} is gone; starting a new one.`);
          remembered = undefined;
        }
      }

      const scratch = await mkdtemp(join(tmpdir(), "dl-session-"));
      try {
        const stateFile = join(scratch, "state.json");
        const args = ["attach-remote", ...(plan.kind === "chat" ? ["--kind", "chat"] : []), "--state-file", stateFile, "--title", `${remote.name} · ${subject}`];
        let detail: string;
        if (remembered) {
          args.push("--conversation", remembered.conversationId);
          detail = remembered.conversationId.slice(0, 8);
        } else {
          let snapshot;
          if (plan.kind === "code") {
            try {
              snapshot = await step(snapshotWorkingTree(plan.root));
            } catch (error) {
              if (error instanceof Interrupted) throw error;
              note(`${describeError(error)}.`.replace(/\.\.$/, "."));
              return undefined;
            }
          }
          const [workspaces, catalog, preferred] = await step(Promise.all([
            client.workspaces(),
            client.catalog(),
            input.model ? Promise.resolve(undefined) : (input.autopilotModel ?? laptopModel)(remote.name),
          ]));
          const workspace = workspaces[0];
          if (!workspace) throw new Error(`${remote.name} has no workspace this laptop can use`);
          const model = pickModel(catalog, input.model, preferred);
          args.push("--workspace", workspace.id, "--model", model);
          if (snapshot) {
            args.push("--repo", plan.repository!, "--base-commit", snapshot.baseCommit);
            if (snapshot.patch) {
              const patchFile = join(scratch, "changes.patch");
              await writeFile(patchFile, snapshot.patch, { mode: 0o600 });
              args.push("--patch-file", patchFile);
            }
            const changes = snapshot.files.length ? ` + ${snapshot.files.length} local change${snapshot.files.length === 1 ? "" : "s"}` : "";
            detail = `new conversation from ${snapshot.baseCommit.slice(0, 7)}${changes}, ${model}`;
          } else {
            detail = `new chat, ${model}`;
          }
        }
        if (!autopilot || !(await step(ready))) return missing();
        // `dl new`: the old conversation keeps running on the place (dl runs lists it).
        if (input.fresh) await forgetSession(key, file);

        if (plan.note) note(plan.note);
        // The place is on the Connecting line already; with more than one set up, also why this
        // one and how to pick another, as `dl run` does (a place named with --server needs neither).
        const chosen = reason === "default" || reason === "last used";
        io.err(`\n  ${c.cyan("·")} Connecting to ${c.bold(remote.name)}${chosen ? ` ${c.dim(`(${reason})`)}` : ""} · ${subject} …  ${c.dim(`(${detail})`)}\n`);
        if (chosen) io.err(`    ${c.dim("dl use NAME to change where dl runs")}\n`);
        // The token goes in the environment only: argv is visible to every user on the machine.
        const env = { ...process.env, AUTOPILOT_REMOTE_URL: client.baseUrl, AUTOPILOT_REMOTE_TOKEN: remote.token };
        let saved = remembered?.conversationId;
        const save = async () => {
          const state = await readState(stateFile);
          if (!state || state.conversationId === saved) return;
          saved = state.conversationId;
          await rememberSession({ ...key, conversationId: state.conversationId, ...(state.branch ? { branch: state.branch } : {}) }, file);
        };
        // Remember it as soon as it exists, so a closed terminal doesn't lose it.
        const poll = setInterval(() => { void save().catch(() => {}); }, 500);
        poll.unref?.();
        const outcome = await new Promise<{ code: number | null } | Error>((resolve) => {
          const started = (input.spawn ?? realSpawn)(autopilot.command, [...autopilot.args, ...args], env);
          child = started;
          started.on("exit", (code) => resolve({ code }));
          started.on("error", (error) => resolve(error));
        }).finally(() => clearInterval(poll));
        await save().catch(() => {});
        if (outcome instanceof Error) return missing();
        if (outcome.code === 2) return missing();
        if (outcome.code !== 0) return 1;
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
    for (const [name, handler] of handlers) signals.off(name, handler);
  }
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
