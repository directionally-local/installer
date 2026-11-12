import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { PAIRED_NAME } from "../local/layout.js";
import { DL_UPDATE } from "./self-update.js";
import { dlVersion } from "../versions.js";
import { nodeAdvisory } from "../node-advisory.js";
import { PromptCancelled, TtyPrompter, type Prompter, type SelectOption } from "../prompt.js";
import { palette } from "../ui.js";
import { findAutopilot, supportsAttachRemote, type AutopilotCommand } from "./autopilot.js";
import { RemoteApiError, type RemoteClient, type RemoteConversation } from "./client.js";
import { describeError, pickModel, type LaptopIO } from "./commands.js";
import { referralForAutopilot, settleReferral, withReferral, type ReferralOptions } from "./referral.js";
import { placeModel, saveModel } from "./settings.js";
import { recordLastUsed, resolveTarget, type RemoteServer, type TargetReason } from "./config.js";
import { detectGitHubRepository, snapshotWorkingTree, type WorkingTreeSnapshot } from "./git.js";
import { describeSecretLocation, findLikelyProviderSecret, type SecretMatch } from "./secrets.js";
import { handoffFile, MAX_HANDOFFS, resultEnv, takeHandoff, type ModelUpRequest } from "./gpu-handoff.js";
import type { ModelUpResult } from "../model-first-run.js";
import { forgetSession, latestSession, rememberSession, sessionsFor, sessionsPath, type SessionKey } from "./session-store.js";
import { openRemoteForSession, withConnections, type RemoteOpener } from "./tunnel.js";

export { autopilotOnPath, bundledAutopilot, findAutopilot, supportsAttachRemote, type AutopilotCommand } from "./autopilot.js";

/**
 * Bare `dl`: an interactive Autopilot session. Where it runs depends on the place:
 *
 * - **Nothing set up yet**: plain `autopilot`, as on this computer (startHere). The sandbox
 *   stack is set up only when background tasks are asked for (`dl run`, `dl setup`).
 * - **This computer**: plain `autopilot` in this folder, with the terminal attached, exactly as
 *   if the person had typed it. A new session every time; `dl -c` is `autopilot -c`. It uses the
 *   person's own Autopilot config (the provider `autopilot connect` set up), works in any folder,
 *   and sends nothing anywhere. The agent edits the folder directly and stops when the terminal
 *   closes; `dl run` stays the sandboxed, background path.
 * - **A server**: Autopilot's interactive screen attached to a conversation on the server
 *   (`autopilot attach-remote`), which keeps running after the terminal closes. Every `dl`
 *   starts a new conversation: inside a GitHub repository that's the repository's code
 *   conversation (base commit + uncommitted changes, as `dl run` sends them); anywhere else a
 *   chat. `dl -c` reopens the latest one started from this folder on this server. dl only finds
 *   the conversation, holds the SSH tunnel open, and gets out of the way.
 */

const execFileAsync = promisify(execFile);

/** The parts of a child process a session needs; tests pass a fake. */
export interface SessionChild {
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export type SessionSpawner = (command: string, args: string[], env: NodeJS.ProcessEnv, options?: { cwd?: string }) => SessionChild;

/** Where SIGINT/SIGTERM/SIGHUP arrive; `process` unless a test replaces it. */
export interface SignalSource {
  on(event: NodeJS.Signals, listener: () => void): unknown;
  off(event: NodeJS.Signals, listener: () => void): unknown;
}

export interface SessionInput {
  cwd: string;
  server?: string;
  model?: string;
  /** `dl -c`: on this computer `autopilot -c`; on a server, reopen the latest conversation started from this folder there. */
  continue?: boolean;
  /** What came after `--`: passed to plain Autopilot as is (this computer only). */
  args?: string[];
  /** `dl --no-local-changes`: start from the base commit and send no patch. */
  noLocalChanges?: boolean;
  /** Asks what to do when the local changes hold a key; the terminal's own unless replaced (tests). */
  prompter?: Prompter;
  open?: RemoteOpener;
  /** The model saved for the place with `dl model`; read from dl's config unless replaced (tests). */
  placeModel?: (place: string) => Promise<string | undefined>;
  /** Finds Autopilot; the one installed with dl, else one on PATH, unless replaced (tests). */
  autopilot?: () => Promise<AutopilotCommand | undefined>;
  /** Whether that Autopilot has `attach-remote`. */
  probe?: (autopilot: AutopilotCommand) => Promise<boolean>;
  spawn?: SessionSpawner;
  signals?: SignalSource;
  sessionsFile?: string;
  /** Where plain Autopilot's DL_REFERRAL comes from and is kept (referral.ts); the real environment and files unless replaced (tests). */
  referral?: ReferralOptions;
  /** The Node.js version plain Autopilot will run on; this process's unless replaced (tests). */
  nodeVersion?: string;
  /** Runs `dl model up` when Autopilot asks for it (gpu-handoff.ts); the real one unless replaced (tests). */
  modelUp?: (request: ModelUpRequest & { avoid?: string }, io: LaptopIO) => Promise<ModelUpResult>;
  /** Where the GPU handoff's private directory is made; the OS temp dir unless replaced (tests). */
  handoffTmp?: string;
}

const realSpawn: SessionSpawner = (command, args, env, options = {}) => spawn(command, args, { stdio: "inherit", env, ...(options.cwd ? { cwd: options.cwd } : {}) });

const FORWARDED: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];


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
 * Opens a session here: plain Autopilot when the place is this computer, else a conversation on
 * the server (code or chat). Returns undefined when there's no place to open it on (nothing set
 * up, or several and no default), after a one-line note, so the caller shows what to do instead.
 * `--server NAME` picks the place; without it, the default place decides.
 */
export async function openSession(input: SessionInput, io: LaptopIO): Promise<number | undefined> {
  const c = palette(io.color === true);
  let target;
  try {
    target = await resolveTarget(input.server);
  } catch (error) {
    if (input.server !== undefined) throw error;
    io.err(`  ${c.yellow("!")} ${describeError(error)}\n`);
    return undefined;
  }
  if (target.remote.name === PAIRED_NAME) return runPlainAutopilot(input, io);
  return startSession(await planSession(input.cwd), target, input, io);
}

/**
 * Bare `dl` on a laptop with nothing set up: plain Autopilot in this folder, as on a laptop
 * whose place is this computer. Nothing is installed or asked first: no Docker, no sandbox,
 * no GitHub token. Autopilot's own first run picks the provider and signs in. The one thing
 * it needs is a Node.js it can run on (the one running dl).
 */
export async function startHere(input: SessionInput, io: LaptopIO): Promise<number> {
  const node = nodeAdvisory(input.nodeVersion ?? process.versions.node);
  if (!node.ok) {
    const c = palette(io.color === true);
    io.err(`  ${c.red("✗")} ${node.message}\n    Update Node (nodejs.org, or your package manager), then run dl again.\n`);
    return 1;
  }
  return runPlainAutopilot(input, io);
}

/**
 * This computer: `autopilot [-c] [-m MODEL] [ARGS…]` in the folder, with the terminal attached
 * and the person's own environment (so their own Autopilot config and provider). Ctrl-C belongs
 * to Autopilot; SIGTERM and SIGHUP are passed on. Returns Autopilot's exit code.
 */
async function runPlainAutopilot(input: SessionInput, io: LaptopIO): Promise<number> {
  const c = palette(io.color === true);
  const autopilot = await (input.autopilot ?? findAutopilot)();
  if (!autopilot) {
    io.err(`  ${c.red("✗")} The Autopilot that comes with dl isn't installed. Update: ${c.bold(DL_UPDATE)}\n`);
    return 1;
  }
  const args = [
    ...autopilot.args,
    ...(input.continue ? ["-c"] : []),
    ...(input.model ? ["-m", input.model] : []),
    ...(input.args ?? []),
  ];
  const referral = await referralForAutopilot({ env: process.env, ...input.referral });
  const signals = input.signals ?? process;
  let child: SessionChild | undefined;
  // Autopilot gets Ctrl-C from the terminal itself; dl must not die of it underneath.
  const handlers = FORWARDED.map((name) => {
    const handler = () => {
      if (child && name !== "SIGINT") child.kill(name);
    };
    signals.on(name, handler);
    return [name, handler] as const;
  });
  // The GPU first run (gpu-handoff.ts): where Autopilot asks dl to run `dl model up`.
  const handoff = await handoffFile(input.handoffTmp).catch(() => undefined);
  try {
    let gpuEnv: Record<string, string> = {};
    let lastFailed: string | undefined;
    for (let round = 0; ; round++) {
      const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null } | Error>((resolve) => {
        // AUTOPILOT_LAUNCHED_BY tells Autopilot dl started it, so its own hints (the exit line's
        // "continue with") name dl's commands and the product, not `autopilot resume ID`.
        // DL_REFERRAL: the invite link's code, from the environment or kept from an earlier run
        // until the free tier sign-in (Autopilot's) credits it. See referral.ts.
        // DL_VERSION and DL_UPDATE_COMMAND: Autopilot names dl (not itself) in its header and gives
        // dl's own update command, never npm i -g autopilot-ai, which dl wouldn't use. Set here so a
        // DL_VERSION left over from the install script (its version pin) can't leak through.
        // DL_GPU_HANDOFF and, after a model setup, DL_GPU_RESULT/DL_GPU_ERROR/DL_GPU: gpu-handoff.ts.
        const env = withReferral({
          ...process.env,
          AUTOPILOT_LAUNCHED_BY: "dl",
          DL_VERSION: dlVersion(),
          DL_UPDATE_COMMAND: DL_UPDATE,
          // Not on the last relaunch allowed: Autopilot mustn't offer a retry dl wouldn't run.
          ...(handoff && round < MAX_HANDOFFS ? { DL_GPU_HANDOFF: handoff.path } : {}),
          ...gpuEnv,
        }, referral);
        const started = (input.spawn ?? realSpawn)(autopilot.command, args, env, { cwd: input.cwd });
        child = started;
        started.on("exit", (code, signal) => resolve({ code, signal }));
        started.on("error", (error) => resolve(error));
      });
      if (outcome instanceof Error) {
        io.err(`  ${c.red("✗")} Couldn't start Autopilot: ${outcome.message}. Update: ${c.bold(DL_UPDATE)}\n`);
        return 1;
      }
      const request = handoff && round < MAX_HANDOFFS ? await takeHandoff(handoff.path) : undefined;
      if (!request) {
        if (outcome.code !== null) return outcome.code;
        return outcome.signal === "SIGINT" ? 130 : outcome.signal === "SIGHUP" ? 129 : outcome.signal === "SIGTERM" ? 143 : 1;
      }
      // Autopilot asked for a private model on this GPU: dl model up, then Autopilot again,
      // which opens on the new provider (or, when it failed, says so and asks again).
      // The request may name a model to retry, or ask for the picker with the last failure marked.
      child = undefined;
      const result = await (input.modelUp ?? realModelUp)({ ...request, ...(lastFailed && !request.model ? { avoid: lastFailed } : {}) }, io);
      if (!result.ok && result.errorType !== "cancelled") {
        // One short line and where the details are; vLLM's own logs stay in the log file.
        io.err(`\n  ${c.red("✗")} ${result.message}\n${result.log ? `    ${c.dim(`Log: ${result.log}`)}\n` : ""}`);
      }
      lastFailed = result.ok ? undefined : result.model;
      gpuEnv = resultEnv(result, request.gpu);
    }
  } finally {
    if (referral) await settleReferral({ env: process.env, ...input.referral });
    await handoff?.cleanup().catch(() => {});
    for (const [name, handler] of handlers) signals.off(name, handler);
  }
}

/** The real first-run model setup, on this terminal (model-first-run.ts). */
async function realModelUp(request: ModelUpRequest & { avoid?: string }, io: LaptopIO): Promise<ModelUpResult> {
  const [{ firstRunModelUp }, { RealSystem }, { TerminalUi }] = await Promise.all([import("../model-first-run.js"), import("../system.js"), import("../ui.js")]);
  const root = typeof process.getuid === "function" && process.getuid() === 0;
  // Keys typed while Autopilot was closing (an extra Enter) or the terminal's late replies to
  // its queries must not answer dl's first question: the prompts ignore input for a moment.
  return firstRunModelUp({
    system: new RealSystem(), ui: new TerminalUi(io.out, undefined, io.color === true), prompter: new TtyPrompter({ settleMs: 300 }), root,
    ...(request.model && !request.pick ? { model: request.model } : {}),
    ...(request.avoid ? { avoid: request.avoid } : {}),
  });
}

async function startSession(plan: SessionPlan, target: { remote: RemoteServer; reason: TargetReason }, input: SessionInput, io: LaptopIO): Promise<number | undefined> {
  const c = palette(io.color === true);
  const note = (text: string) => io.err(`  ${c.yellow("!")} ${text}\n`);
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
    io.err(`  ${c.red("✗")} The Autopilot that comes with dl ${autopilot ? "is too old to open a session" : "isn't installed"}. Update: ${c.bold(DL_UPDATE)}\n`);
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
      // Bare `dl` always starts a new conversation; `dl -c` reopens the latest here.
      let remembered = input.continue ? await latestSession(key, file) : undefined;
      if (input.continue && !remembered) note("No earlier session here; starting a new one.");
      // The model the conversation starts on: dl's pick for a new one, the conversation's own for
      // a reopened one. Compared against the model it ends on, so a /model switch in the session
      // becomes the place's model for next time.
      let startModel: string | undefined;
      if (remembered) {
        const existing = await step(findConversation(client, remembered.conversationId));
        if (!existing) {
          await forgetSession(remembered.conversationId, file);
          note(`The last ${plan.kind === "code" ? `conversation for ${subject}` : "chat"} on ${remote.name} is gone; starting a new one.`);
          remembered = undefined;
        } else {
          startModel = existing.model;
        }
      }
      // Starting a new one: say when an earlier session here is still live, so nobody thinks
      // they left it running by accident. Nothing else.
      const earlier = remembered ? [] : await step(liveEarlierSessions(key, client, file));

      const scratch = await mkdtemp(join(tmpdir(), "dl-session-"));
      try {
        const stateFile = join(scratch, "state.json");
        const args = ["attach-remote", "--state-file", stateFile, "--title", `${remote.name} · ${subject}`];
        let detail: string;
        if (remembered) {
          args.push("--conversation", remembered.conversationId);
          detail = remembered.conversationId.slice(0, 8);
        } else {
          let snapshot;
          if (plan.kind === "code") {
            try {
              snapshot = await step(snapshotWorkingTree(plan.root, { localChanges: input.noLocalChanges !== true }));
            } catch (error) {
              if (error instanceof Interrupted) throw error;
              note(`${describeError(error)}.`.replace(/\.\.$/, "."));
              return undefined;
            }
            // A key-shaped change is refused by the server anyway; ask here, before any network
            // call, so the answer names the file and offers a way forward.
            const secret = snapshot.patch ? findLikelyProviderSecret(snapshot.patch) : undefined;
            if (secret) {
              const start = await step(askAboutLocalSecret(secret, snapshot, input, io));
              if (!start) return 130;
              snapshot = { ...snapshot, patch: "", files: [] };
            }
          }
          const [workspaces, catalog, preferred] = await step(Promise.all([
            client.workspaces(),
            client.catalog(),
            input.model ? Promise.resolve(undefined) : (input.placeModel ?? placeModel)(remote.name),
          ]));
          const workspace = workspaces[0];
          if (!workspace) throw new Error(`${remote.name} has no workspace this laptop can use`);
          const model = pickModel(catalog, input.model, preferred);
          startModel = model;
          // Creation flags only: attach-remote refuses them next to --conversation.
          args.push(...(plan.kind === "chat" ? ["--kind", "chat"] : []), "--workspace", workspace.id, "--model", model);
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

        if (plan.note) note(plan.note);
        if (earlier.length > 0) {
          const count = earlier.length;
          const waiting = earlier.every((conversation) => conversation.status === "waiting_approval");
          io.err(`  ${c.dim(`${count} earlier session${count === 1 ? "" : "s"} here ${count === 1 ? "is" : "are"} ${waiting ? "waiting for you" : "still working"} · dl -c to rejoin`)}`);
          io.err("\n");
        }
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
        // A model switched with /model inside the session is the place's model from now on, so
        // the next session (and dl run) uses it instead of falling back to the default.
        if (saved && startModel) {
          const ended = await client.getConversation(saved).catch(() => undefined);
          if (ended?.model && ended.model !== startModel) await saveModel(ended.model, undefined, remote.name).catch(() => undefined);
        }
        if (outcome.code === 2) return missing();
        // attach-remote's own code for "the patch holds a key": it already said where.
        if (outcome.code === 3) {
          note(`Start without your local changes: dl --no-local-changes`);
          return 1;
        }
        if (outcome.code !== 0) return 1;
        await recordLastUsed(remote.name).catch(() => undefined);
        io.err(`\n  It keeps running on ${c.bold(remote.name)}. Type ${c.bold("dl -c")} here to come back, or ${c.bold("dl runs")}.\n\n`);
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

/**
 * The local changes hold something key-shaped. Says where (never what), then offers the two
 * ways forward: start from the base commit without them (the default), or stop. Returns
 * whether to start.
 */
async function askAboutLocalSecret(match: SecretMatch, snapshot: WorkingTreeSnapshot, input: SessionInput, io: LaptopIO): Promise<boolean> {
  const c = palette(io.color === true);
  io.err(
    `\n  ${c.yellow("!")} Your local changes include something that looks like an API key:\n`
    + `    ${describeSecretLocation(match)}\n`
    + `  Agents get a copy of your changes, and keys never leave this computer.\n\n`,
  );
  const options: SelectOption[] = [
    { value: "base", label: `Start from ${snapshot.baseCommit.slice(0, 7)} without my local changes` },
    { value: "cancel", label: "Cancel" },
  ];
  const prompter = input.prompter ?? new TtyPrompter({ color: io.color === true });
  try {
    const { value } = await prompter.select(`  ${c.bold("How should this session start?")}`, options, 0);
    return value === "base";
  } catch (error) {
    if (error instanceof PromptCancelled) return false;
    throw error;
  }
}

/** A remembered conversation, if it still exists on the place (destroyed and gone both count as not). */
async function findConversation(client: RemoteClient, conversationId: string): Promise<RemoteConversation | undefined> {
  try {
    const conversation = await client.getConversation(conversationId);
    return conversation.status === "destroyed" ? undefined : conversation;
  } catch (error) {
    if (error instanceof RemoteApiError && (error.status === 404 || error.status === 410)) return undefined;
    throw error;
  }
}

/**
 * The conversations started from this folder on this place that are still working or waiting
 * for the person. Ones the place no longer has are forgotten on the way.
 */
async function liveEarlierSessions(key: SessionKey, client: RemoteClient, file: string): Promise<RemoteConversation[]> {
  const entries = await sessionsFor(key, file);
  if (entries.length === 0) return [];
  const found = await Promise.all(entries.map(async (entry) => {
    try {
      return { entry, conversation: await client.getConversation(entry.conversationId) };
    } catch (error) {
      if (error instanceof RemoteApiError && (error.status === 404 || error.status === 410)) return { entry, gone: true as const };
      throw error;
    }
  }));
  const live: RemoteConversation[] = [];
  for (const result of found) {
    if ("gone" in result || result.conversation.status === "destroyed") {
      await forgetSession(result.entry.conversationId, file);
      continue;
    }
    const { conversation } = result;
    if (conversation.activeRunId !== null || conversation.status === "waiting_approval") live.push(conversation);
  }
  return live;
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
