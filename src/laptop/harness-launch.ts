import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { platform } from "node:os";
import { delimiter, join } from "node:path";
import { findAutopilot, type AutopilotCommand } from "./autopilot.js";
import { freeTierAccessToken, type FreeTierToken } from "./free-tier-token.js";
import { browserSignIn, dlKeyPlan, readDlKey, type DlKey } from "./dl-key.js";
import { palette } from "../ui.js";
import { oneLine } from "./printable.js";
import { telemetryOff } from "./telemetry.js";

/**
 * Another coding agent on the free tier, launched by dl (`dl claude`, `dl opencode`, `dl pi`, `dl codex`, `dl t3`). The flow is
 * the same for each; what differs (the binary, how it is told where the free tier is) is the
 * agent's `HarnessLaunch`.
 *
 * 1. Sign-in: dl's own (a dl key from dl.new, dl-key.ts), which every agent uses as its key
 *    directly (steps 3 and 4 are then skipped). Without one, an older Autopilot free tier
 *    sign-in (refreshed when it has expired) still works; with neither, dl's browser sign-in
 *    runs first. Autopilot isn't needed for any of it.
 * 2. The agent must be on PATH: dl never installs it, it prints the official install command.
 * 3. A short-lived harness key from the service (POST /v1/harness-keys {harness}), one per agent
 *    (`dl t3` runs two: Claude Code and OpenCode, each counted as itself): good for 15
 *    minutes, refreshed every few minutes while the agent runs and revoked when it exits, so free
 *    tokens in it work only while dl runs it. Refreshing extends the same key (the string doesn't
 *    change), so the agent reads it once at start. It goes to the agent in its environment (never
 *    on a command line, never logged or printed).
 * 4. Session events, as Autopilot sends them (POST /v1/events): session.start before the agent
 *    starts (so the dl-only check covers its requests), again every few hours for long sessions,
 *    and session.end when it exits. Counts only. With DL_NO_TELEMETRY, DO_NOT_TRACK or CI
 *    (telemetry.ts), only the bare session.start the dl-only check needs: no props, no session.end.
 * 5. In a terminal, one dim line says what part of the free allowance this agent gets, only when
 *    it is less than all of it (the service's `otherHarnessShare`, from the harness key's response).
 * 6. The agent runs with the person's arguments and the terminal passed through, with the
 *    environment its `prepare` returns; its exit code is dl's. Its own config files are never
 *    read or written.
 */

/** The coding agents dl launches on free tokens: the service's `HARNESSES`. */
export type Harness = "claude-code" | "opencode" | "pi" | "codex";

type Env = Record<string, string | undefined>;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface LaunchIO {
  out: (text: string) => void;
  err: (text: string) => void;
}

/** What one agent needs from the shared flow. */
export interface HarnessLaunch {
  harness: Harness;
  /** How the person runs it through dl: "dl claude". */
  command: string;
  /** The agent's name: "Claude Code". */
  product: string;
  /** Prefix of the session id in dl's session events: "dl-claude". */
  sessionPrefix: string;
  /** Printed (indented, after a blank line) when the agent isn't on PATH. */
  missing: string;
  /** Executable names looked up on PATH, in order. */
  binaries: { posix: string[]; win32: string[] };
  /**
   * More agents this one starts itself (`dl t3`: T3 Code runs Claude Code and OpenCode). Each gets
   * its own harness key, so its requests are counted as that agent's; `prepare` gets them in `keys`.
   */
  alsoHarnesses?: Harness[];
  /**
   * The agent's own diagnostic lines on stdout (`[claude-code:unrecognized_model] …` in print
   * mode), moved to stderr so a script's stdout is only the agent's answer. Stdout goes through
   * dl only when `when` says so for these arguments (and whether stdout is a terminal); an
   * interactive agent keeps the terminal itself.
   */
  stdoutDiagnostics?: { prefix: string; when: (args: string[], stdoutIsTerminal: boolean) => boolean };
  /** Checked before sign-in: a message stops dl here, before any key is made. */
  check?: (args: string[], context: { env: Env; cwd: string }) => string | undefined | Promise<string | undefined>;
  /**
   * The agent's environment and arguments for this run. `removed` names the person's variables
   * left out (dl says so once); `notes` are said once too. An `error` stops before the agent
   * starts (the key is revoked). `sessionId` is the one dl's session events carry; `cleanup`
   * runs once the agent has exited (temporary files). `models` is the one line naming the plan's
   * models in this agent and how to switch (plan-models.ts), shown at a terminal before it starts.
   * `plan` starts before the keys are minted; await it alongside the agent's own model fetch so a
   * slow /v1/me doesn't add its timeout to every launch.
   */
  prepare: (input: { env: Env; args: string[]; origin: string; key: string; keys: Partial<Record<Harness, string>>; binary: string; sessionId: string; plan: Promise<string | null> }) => Promise<
    | { env: Env; args: string[]; removed: string[]; notes?: string[]; models?: string; cleanup?: () => Promise<void> }
    | { error: string }
  >;
}

export interface LaunchDeps {
  env?: Env;
  /** A fresh free tier access token; Autopilot's sign-in, refreshed, unless replaced. */
  token?: () => Promise<FreeTierToken>;
  /** dl's own sign-in (dl-key.ts); read from dl's config unless replaced. */
  dlKey?: () => Promise<DlKey | undefined>;
  /** Runs the sign-in in the terminal; dl's browser sign-in (dl.new) unless replaced. True when it finished. */
  signIn?: () => Promise<boolean>;
  /** Where the agent's binary is; looked up on PATH unless replaced. */
  find?: (env: Env) => Promise<string | undefined>;
  fetch?: Fetch;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
  clearInterval?: (timer: unknown) => void;
  /** Signals dl forwards to the agent; process.on unless replaced. */
  onSignal?: (signal: NodeJS.Signals, handler: () => void) => () => void;
  now?: () => number;
  /** Whether dl's output is a terminal (the Autopilot nudge shows only there); stderr's unless replaced. */
  terminal?: boolean;
  /** Whether stdout is a terminal (HarnessLaunch.stdoutDiagnostics); process.stdout's unless replaced. */
  stdoutIsTerminal?: boolean;
  /** The folder the agent starts in (its project settings); process.cwd() unless replaced. */
  cwd?: string;
}

/** How long dl waits, once the agent has exited, for the rest of its piped stdout (a process it left behind may hold it). */
const STDOUT_DRAIN_MS = 2_000;

/**
 * Splits a stream into lines and sends each to `out`, or to `err` when it starts with `prefix`.
 * A line whose start already differs from `prefix` passes through at once, so streamed output
 * isn't held back to the end of the line.
 */
export function diverter(prefix: string, out: (text: string) => void, err: (text: string) => void): { write: (chunk: string) => void; end: () => void } {
  /** The start of the current line, held while it could still be a diagnostic. */
  let held = "";
  /** Where the rest of the current line goes, once known. */
  let to: ((text: string) => void) | undefined;
  return {
    write: (chunk) => {
      let rest = chunk;
      while (rest.length > 0) {
        const newline = rest.indexOf("\n");
        const piece = newline === -1 ? rest : rest.slice(0, newline + 1);
        rest = newline === -1 ? "" : rest.slice(newline + 1);
        if (!to) {
          held += piece;
          if (held.startsWith(prefix)) to = err;
          else if (!prefix.startsWith(held.replace(/\n$/, "")) || newline !== -1) to = out;
          if (to) {
            to(held);
            held = "";
          }
        } else {
          to(piece);
        }
        if (newline !== -1) to = undefined;
      }
    },
    end: () => {
      if (held !== "") out(held);
      held = "";
      to = undefined;
    },
  };
}

/**
 * The one line `dl claude` and `dl opencode` show before the agent starts, only when the service
 * holds this agent to part of the free allowance (`otherHarnessShare` below 1): a plain statement
 * of that part, no pointer to another agent. Nothing when the share is the whole allowance (the
 * default) or unknown.
 */
export function allowanceNote(share: unknown): string | undefined {
  if (typeof share !== "number" || !Number.isFinite(share) || share >= 1) return undefined;
  const part = share <= 0 ? "none" : `${Math.round(share * 100)}%`;
  return `Free tokens: this agent gets ${part} of your weekly free allowance.`;
}

/** Refresh the harness key this often (it lasts 15 minutes). */
export const REFRESH_EVERY_MS = 4 * 60_000;
/** Send session.start again this often: a session event covers the dl-only check for 24 hours. */
export const SESSION_EVENT_EVERY_MS = 6 * 3600_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** How long dl waits for session.end and the key's revocation after the agent exits. */
const CLEANUP_DEADLINE_MS = 3_000;

/** The first of `names` on PATH, or undefined. */
export async function onPath(names: string[], env: Env = process.env): Promise<string | undefined> {
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
    }
  }
  return undefined;
}

/** Autopilot's own free tier sign-in, in this terminal. */
export async function autopilotSignIn(io: LaunchIO, command: string, find: () => Promise<AutopilotCommand | undefined> = findAutopilot): Promise<boolean> {
  const autopilot = await find();
  if (!autopilot) {
    io.err(`  ${command} needs the free tier sign-in, and Autopilot (which signs in) isn't installed. Reinstall dl: curl -fsSL https://dl.new | sh\n`);
    return false;
  }
  const child = nodeSpawn(autopilot.command, [...autopilot.args, "auth", "directionally-local"], { stdio: "inherit" });
  const code = await new Promise<number>((resolve) => {
    child.on("error", () => resolve(1));
    child.on("exit", (status) => resolve(status ?? 1));
  });
  return code === 0;
}

function json(response: Response): Promise<Record<string, any> | undefined> {
  return response.json().catch(() => undefined) as Promise<Record<string, any> | undefined>;
}

export async function launchHarness(spec: HarnessLaunch, args: string[], io: LaunchIO, deps: LaunchDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const call: Fetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? Date.now;
  const { command, product } = spec;

  const refused = await spec.check?.(args, { env, cwd: deps.cwd ?? process.cwd() });
  if (refused) {
    io.err(`  ${refused}\n`);
    return 1;
  }

  const binary = await (deps.find ?? ((env: Env) => onPath(platform() === "win32" ? spec.binaries.win32 : spec.binaries.posix, env)))(env);
  if (!binary) {
    io.err(`  ${product} isn't installed (no ${spec.binaries.posix[0]} on PATH). Install it, then run ${command} again:\n\n    ${spec.missing}\n`);
    return 1;
  }

  // dl's own sign-in (a dl key from dl.new) first; an older Autopilot free tier sign-in still
  // works where there's no dl key; with neither, dl's browser sign-in runs now.
  // (A test that replaces `token` tests that older path alone.)
  const readKey = deps.dlKey ?? (deps.token ? async () => undefined : () => readDlKey(env));
  const getToken = deps.token ?? (() => freeTierAccessToken({ env }));
  let dlKey = await readKey();
  let token: FreeTierToken | undefined;
  if (!dlKey) {
    token = await getToken();
    if (!token.ok && token.reason === "signed_out") {
      io.out(`  ${command} uses your dl sign-in. Signing in first.\n`);
      if (!(await (deps.signIn ?? (() => browserSignIn(io, { env, intro: false }).then(Boolean)))())) {
        io.err(`  Not signed in, so ${command} can't start. Run ${command} again to retry.\n`);
        return 1;
      }
      dlKey = await readKey();
      if (!dlKey) token = await getToken();
    }
    if (!dlKey && token && !token.ok) {
      io.err(`  ${token.reason === "signed_out" ? `Not signed in. Run ${command} again to sign in.` : token.message}\n`);
      return 1;
    }
  }
  const origin = dlKey ? dlKey.baseUrl : (token as Extract<FreeTierToken, { ok: true }>).origin;

  // dl's own key names its plan in every picker, read fresh from /v1/me so an upgrade is followed;
  // the saved plan is the fallback, and an older Autopilot free tier sign-in is Free. Start it now so
  // it overlaps key minting and the agent's model fetch; prepare awaits it where the labels are made.
  const plan = dlKey ? dlKeyPlan(dlKey, { fetch: call }).then((fresh) => fresh ?? dlKey!.plan ?? null) : Promise.resolve(null);

  // The harness keys: the agent's, then one for each agent it starts itself. A dl key is a key
  // already: every agent uses it, with nothing to make, refresh or revoke.
  const minted: MintedKey[] = [];
  const revokeAll = () => Promise.all(minted.map((one) => one.revoke()));
  const cleanup = (work: Promise<unknown>) => Promise.race([work, new Promise((resolve) => setTimeout(resolve, CLEANUP_DEADLINE_MS).unref?.())]);
  const harnesses = [spec.harness, ...(spec.alsoHarnesses ?? []).filter((other) => other !== spec.harness)];
  if (!dlKey) {
    const accessToken = (token as Extract<FreeTierToken, { ok: true }>).accessToken;
    for (const harness of harnesses) {
      const one = await mintKey(call, origin, accessToken, harness, command);
      if ("error" in one) {
        io.err(`  ${one.error}\n`);
        await cleanup(revokeAll());
        return 1;
      }
      minted.push(one);
    }
  }
  const primary = minted[0];
  const key = dlKey ? dlKey.key : primary!.key;
  const keys: Partial<Record<Harness, string>> = dlKey ? Object.fromEntries(harnesses.map((harness) => [harness, dlKey!.key])) : Object.fromEntries(minted.map((one) => [one.harness, one.key]));

  // One session per harness key (so per agent): `dl claude` has one, `dl t3` one for each agent
  // T3 runs. A dl key's requests are the account's own: no session events.
  const sessions = minted.map((one) => ({ ...one, id: minted.length === 1 ? `${spec.sessionPrefix}-${randomUUID()}` : `${spec.sessionPrefix}-${one.harness}-${randomUUID()}`, count: 0 }));
  const prepared = await spec.prepare({ env, args, origin, key, keys, binary, plan, sessionId: sessions[0]?.id ?? `${spec.sessionPrefix}-${randomUUID()}` });
  if ("error" in prepared) {
    io.err(`  ${prepared.error}\n`);
    await cleanup(revokeAll());
    return 1;
  }

  const started = now();
  const optedOut = telemetryOff(env);
  const sendEvents = async (type: "session.start" | "session.end", props: Record<string, unknown> = {}) => {
    if (optedOut && type === "session.end") return;
    await Promise.all(
      sessions.map(async (session) => {
        try {
          await call(`${origin}/v1/events`, {
            method: "POST",
            headers: session.headers({ "content-type": "application/json" }),
            body: JSON.stringify({ events: [{ id: `${session.id}-${++session.count}`, type, sessionId: session.id, at: new Date(now()).toISOString(), props: optedOut ? {} : { harness: session.harness, os: platform(), ...props } }] }),
            redirect: "error",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
        } catch {
          // Best effort: a lost event never stops the session.
        }
      }),
    );
  };
  // Before the agent's first request, so the dl-only check counts them as dl's.
  await sendEvents("session.start");

  if (prepared.removed.length > 0) io.err(`  ${command}: not passing ${prepared.removed.join(", ")} to ${product} for this session (it runs on dl's free tier).\n`);
  for (const note of prepared.notes ?? []) io.err(`  ${command}: ${note}\n`);
  const nudge = primary ? allowanceNote(primary.otherHarnessShare) : undefined;
  const atTerminal = deps.terminal ?? process.stderr.isTTY === true;
  if (prepared.models && atTerminal) io.err(`  ${palette(!env.NO_COLOR && env.TERM !== "dumb").dim(prepared.models)}\n`);
  if (nudge && atTerminal) {
    io.err(`  ${palette(!env.NO_COLOR && env.TERM !== "dumb").dim(nudge)}\n`);
  }

  const every = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const stop = deps.clearInterval ?? ((timer: unknown) => clearInterval(timer as NodeJS.Timeout));
  const refresher = every(() => {
    for (const one of minted) {
      void call(`${origin}/v1/harness-keys/${one.id}/refresh`, { method: "POST", headers: one.headers(), redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).catch(() => undefined);
    }
  }, REFRESH_EVERY_MS);
  const heartbeat = every(() => void sendEvents("session.start"), SESSION_EVENT_EVERY_MS);
  refresher.unref?.();
  heartbeat.unref?.();

  const diagnostics = spec.stdoutDiagnostics;
  const divert = diagnostics?.when(prepared.args, deps.stdoutIsTerminal ?? process.stdout.isTTY === true) === true;
  const child = (deps.spawn ?? nodeSpawn)(binary, prepared.args, { stdio: divert ? ["inherit", "pipe", "inherit"] : "inherit", env: prepared.env as NodeJS.ProcessEnv });
  let drained: Promise<void> = Promise.resolve();
  if (divert && diagnostics && child.stdout) {
    const lines = diverter(diagnostics.prefix, io.out, io.err);
    const stdout = child.stdout;
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => lines.write(chunk));
    drained = new Promise<void>((resolve) => {
      stdout.on("end", resolve);
      stdout.on("error", () => resolve());
    }).then(() => lines.end());
  }
  // Ctrl-C reaches the agent from the terminal itself; dl just mustn't die of it. Other signals
  // sent to dl alone are passed on, so the agent exits and dl still cleans up.
  const onSignal = deps.onSignal ?? ((signal: NodeJS.Signals, handler: () => void) => {
    process.on(signal, handler);
    return () => process.off(signal, handler);
  });
  const unsubscribe = [
    onSignal("SIGINT", () => undefined),
    ...(["SIGTERM", "SIGHUP"] as const).map((signal) => onSignal(signal, () => child.kill(signal))),
  ];

  const outcome = await new Promise<{ code: number; reason: string }>((resolve) => {
    child.on("error", (error) => {
      io.err(`  Couldn't start ${product}: ${error.message}\n`);
      resolve({ code: 1, reason: "spawn_failed" });
    });
    child.on("exit", (code, signal) => resolve(signal ? { code: 128 + (SIGNALS[signal] ?? 1), reason: `signal_${signal}` } : { code: code ?? 1, reason: "exit" }));
  });
  if (divert) {
    let timer: NodeJS.Timeout | undefined;
    // Ended, or held open by something the agent left running: stop reading it either way.
    await Promise.race([drained, new Promise<void>((resolve) => { timer = setTimeout(resolve, STDOUT_DRAIN_MS); timer.unref?.(); })]);
    clearTimeout(timer);
    child.stdout?.destroy();
  }
  for (const off of unsubscribe) off();
  stop(refresher);
  stop(heartbeat);
  await prepared.cleanup?.().catch(() => undefined);

  // Session end and the key's end, both best effort and bounded.
  await cleanup(Promise.allSettled([sendEvents("session.end", { durationMs: Math.max(0, now() - started), exitReason: outcome.reason }), revokeAll()]));
  return outcome.code;
}

interface MintedKey {
  harness: Harness;
  id: string;
  key: string;
  otherHarnessShare: unknown;
  /** Request headers that authenticate with this key. */
  headers: (extra?: Record<string, string>) => Record<string, string>;
  revoke: () => Promise<unknown>;
}

/** One harness key from the service (POST /v1/harness-keys), or what to tell the person. */
async function mintKey(call: Fetch, origin: string, accessToken: string, harness: Harness, command: string): Promise<MintedKey | { error: string }> {
  let response: Response;
  try {
    response = await call(`${origin}/v1/harness-keys`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ harness }),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return { error: `Couldn't reach the free tier (${error instanceof Error ? error.message : String(error)}). Try again.` };
  }
  const body = await json(response);
  if (response.status !== 201 || typeof body?.key !== "string" || typeof body.id !== "string") {
    return { error: typeof body?.error?.message === "string" ? oneLine(body.error.message, 500) : `The free tier refused ${command} (HTTP ${response.status}).` };
  }
  const key: string = body.key;
  const id: string = body.id;
  const headers = (extra: Record<string, string> = {}) => ({ accept: "application/json", authorization: `Bearer ${key}`, ...extra });
  const revoke = () => call(`${origin}/v1/harness-keys/${id}`, { method: "DELETE", headers: headers(), redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).catch(() => undefined);
  return { harness, id, key, otherHarnessShare: body.otherHarnessShare, headers, revoke };
}

const SIGNALS: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
