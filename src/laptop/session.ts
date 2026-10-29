import { execFile, spawn } from "node:child_process";
import { constants, existsSync, readFileSync } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { palette } from "../ui.js";
import { RemoteApiError } from "./client.js";
import { describeError, pickModel, readAutopilotModel, type LaptopIO } from "./commands.js";
import { recordLastUsed, resolveTarget } from "./config.js";
import { detectGitHubRepository, snapshotWorkingTree } from "./git.js";
import { findSession, forgetSession, rememberSession, sessionsPath, type SessionKey } from "./session-store.js";
import { openRemoteForSession, withConnections, type RemoteOpener } from "./tunnel.js";

/**
 * `dl` inside a project: Autopilot's own interactive screen, attached to this repository's
 * conversation on the place agents run (`autopilot attach-remote`). The first time it starts
 * one from this checkout (base commit + uncommitted changes, as `dl run` sends them); after
 * that it reopens the same one. dl only finds the conversation, holds the SSH tunnel open,
 * and gets out of the way: Autopilot owns the terminal until the user detaches.
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
  /** `dl new`: forget this repository's conversation and start another. */
  fresh?: boolean;
  open?: RemoteOpener;
  /** The laptop's Autopilot default model; reads Autopilot's config unless replaced (tests). */
  autopilotModel?: () => Promise<string | undefined>;
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
  const { remote } = target;
  const key: SessionKey = { place: remote.name, repository, root };
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
          note(`The last conversation for ${repository} on ${remote.name} is gone; starting a new one.`);
          remembered = undefined;
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
            snapshot = await step(snapshotWorkingTree(root));
          } catch (error) {
            if (error instanceof Interrupted) throw error;
            note(`${describeError(error)}.`.replace(/\.\.$/, "."));
            return undefined;
          }
          const [workspaces, models, preferred] = await step(Promise.all([
            client.workspaces(),
            client.models(),
            input.model ? Promise.resolve(undefined) : (input.autopilotModel ?? (() => readAutopilotModel()))(),
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
        if (!autopilot || !(await step(ready))) return missing();
        // `dl new`: the old conversation keeps running on the place (dl runs lists it).
        if (input.fresh) await forgetSession(key, file);

        io.err(`\n  ${c.cyan("·")} Connecting to ${c.bold(remote.name)} · ${repository} …  ${c.dim(`(${detail})`)}\n`);
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
