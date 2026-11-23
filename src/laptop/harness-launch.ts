import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { platform } from "node:os";
import { delimiter, join } from "node:path";
import { findAutopilot, type AutopilotCommand } from "./autopilot.js";
import { freeTierAccessToken, type FreeTierToken } from "./free-tier-token.js";
import { palette } from "../ui.js";

/**
 * Another coding agent on the free tier, launched by dl (`dl claude`, `dl opencode`, `dl pi`). The flow is
 * the same for each; what differs (the binary, how it is told where the free tier is) is the
 * agent's `HarnessLaunch`.
 *
 * 1. Free tier sign-in: Autopilot's (refreshed when it has expired). Not signed in: Autopilot's
 *    sign-in runs first (`autopilot auth directionally-local`), as on dl's first run.
 * 2. The agent must be on PATH: dl never installs it, it prints the official install command.
 * 3. A short-lived harness key from the service (POST /v1/harness-keys {harness}): good for 15
 *    minutes, refreshed every few minutes while the agent runs and revoked when it exits, so free
 *    tokens in it work only while dl runs it. Refreshing extends the same key (the string doesn't
 *    change), so the agent reads it once at start. It goes to the agent in its environment (never
 *    on a command line, never logged or printed).
 * 4. Session events, as Autopilot sends them (POST /v1/events): session.start before the agent
 *    starts (so the dl-only check covers its requests), again every few hours for long sessions,
 *    and session.end when it exits. Counts only.
 * 5. In a terminal, one dim line says Autopilot gets more of the free allowance (the service's
 *    `otherHarnessShare`, from the harness key's response).
 * 6. The agent runs with the person's arguments and the terminal passed through, with the
 *    environment its `prepare` returns; its exit code is dl's. Its own config files are never
 *    read or written.
 */

/** The coding agents dl launches on free tokens: the service's `HARNESSES`. */
export type Harness = "claude-code" | "opencode" | "pi";

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
   * The agent's environment and arguments for this run. `removed` names the person's variables
   * left out (dl says so once); `notes` are said once too. An `error` stops before the agent
   * starts (the key is revoked). `sessionId` is the one dl's session events carry; `cleanup`
   * runs once the agent has exited (temporary files).
   */
  prepare: (input: { env: Env; args: string[]; origin: string; key: string; binary: string; sessionId: string }) => Promise<
    | { env: Env; args: string[]; removed: string[]; notes?: string[]; cleanup?: () => Promise<void> }
    | { error: string }
  >;
}

export interface LaunchDeps {
  env?: Env;
  /** A fresh free tier access token; Autopilot's sign-in, refreshed, unless replaced. */
  token?: () => Promise<FreeTierToken>;
  /** Runs the free tier sign-in in the terminal; Autopilot's unless replaced. True when it finished. */
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
}

/**
 * The one line `dl claude` and `dl opencode` show before the agent starts: other agents get
 * `share` of the free allowance (the service's `otherHarnessShare`), Autopilot all of it. "2×"
 * only when the share is exactly half; nothing when the share is the whole allowance.
 */
export function autopilotNudge(share: unknown): string | undefined {
  if (typeof share === "number" && share >= 1) return undefined;
  return share === 0.5
    ? "Free tokens: Autopilot gets 2× the allowance of other agents. Just type dl."
    : "Free tokens: Autopilot gets more of the allowance than other agents. Just type dl.";
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

  const binary = await (deps.find ?? ((env: Env) => onPath(platform() === "win32" ? spec.binaries.win32 : spec.binaries.posix, env)))(env);
  if (!binary) {
    io.err(`  ${product} isn't installed (no ${spec.binaries.posix[0]} on PATH). Install it, then run ${command} again:\n\n    ${spec.missing}\n`);
    return 1;
  }

  const getToken = deps.token ?? (() => freeTierAccessToken({ env }));
  let token = await getToken();
  if (!token.ok && token.reason === "signed_out") {
    io.out(`  ${command} uses your free tier sign-in. Signing in first (this also makes the free tier Autopilot's provider; change it with /provider).\n`);
    if (!(await (deps.signIn ?? (() => autopilotSignIn(io, command)))())) {
      io.err(`  Not signed in to the free tier, so ${command} can't start. Run ${command} again to retry.\n`);
      return 1;
    }
    token = await getToken();
  }
  if (!token.ok) {
    io.err(`  ${token.reason === "signed_out" ? `Not signed in to the free tier. Run ${command} again to sign in.` : token.message}\n`);
    return 1;
  }
  const { origin, accessToken } = token;

  // The harness key.
  let minted: Response;
  try {
    minted = await call(`${origin}/v1/harness-keys`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ harness: spec.harness }),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    io.err(`  Couldn't reach the free tier (${error instanceof Error ? error.message : String(error)}). Try again.\n`);
    return 1;
  }
  const mintedBody = await json(minted);
  if (minted.status !== 201 || typeof mintedBody?.key !== "string" || typeof mintedBody.id !== "string") {
    const message = typeof mintedBody?.error?.message === "string" ? mintedBody.error.message : `The free tier refused ${command} (HTTP ${minted.status}).`;
    io.err(`  ${message}\n`);
    return 1;
  }
  const key: string = mintedBody.key;
  const keyId: string = mintedBody.id;
  const asKey = (extra: Record<string, string> = {}) => ({ accept: "application/json", authorization: `Bearer ${key}`, ...extra });
  const revoke = () => call(`${origin}/v1/harness-keys/${keyId}`, { method: "DELETE", headers: asKey(), redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).catch(() => undefined);

  const sessionId = `${spec.sessionPrefix}-${randomUUID()}`;
  const prepared = await spec.prepare({ env, args, origin, key, binary, sessionId });
  if ("error" in prepared) {
    io.err(`  ${prepared.error}\n`);
    await Promise.race([revoke(), new Promise((resolve) => setTimeout(resolve, CLEANUP_DEADLINE_MS).unref?.())]);
    return 1;
  }

  const started = now();
  let eventCount = 0;
  const sendEvent = async (type: "session.start" | "session.end", props: Record<string, unknown> = {}) => {
    try {
      await call(`${origin}/v1/events`, {
        method: "POST",
        headers: asKey({ "content-type": "application/json" }),
        body: JSON.stringify({ events: [{ id: `${sessionId}-${++eventCount}`, type, sessionId, at: new Date(now()).toISOString(), props: { harness: spec.harness, os: platform(), ...props } }] }),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // Best effort: a lost event never stops the session.
    }
  };
  // Before the agent's first request, so the dl-only check counts them as dl's.
  await sendEvent("session.start");

  if (prepared.removed.length > 0) io.err(`  ${command}: not passing ${prepared.removed.join(", ")} to ${product} for this session (it runs on dl's free tier).\n`);
  for (const note of prepared.notes ?? []) io.err(`  ${command}: ${note}\n`);
  const nudge = autopilotNudge(mintedBody.otherHarnessShare);
  if (nudge && (deps.terminal ?? process.stderr.isTTY === true)) {
    io.err(`  ${palette(!env.NO_COLOR && env.TERM !== "dumb").dim(nudge)}\n`);
  }

  const every = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const stop = deps.clearInterval ?? ((timer: unknown) => clearInterval(timer as NodeJS.Timeout));
  const refresher = every(() => {
    void call(`${origin}/v1/harness-keys/${keyId}/refresh`, { method: "POST", headers: asKey(), redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).catch(() => undefined);
  }, REFRESH_EVERY_MS);
  const heartbeat = every(() => void sendEvent("session.start"), SESSION_EVENT_EVERY_MS);
  refresher.unref?.();
  heartbeat.unref?.();

  const child = (deps.spawn ?? nodeSpawn)(binary, prepared.args, { stdio: "inherit", env: prepared.env as NodeJS.ProcessEnv });
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
  for (const off of unsubscribe) off();
  stop(refresher);
  stop(heartbeat);
  await prepared.cleanup?.().catch(() => undefined);

  // Session end and the key's end, both best effort and bounded.
  await Promise.race([
    Promise.allSettled([sendEvent("session.end", { durationMs: Math.max(0, now() - started), exitReason: outcome.reason }), revoke()]),
    new Promise((resolve) => setTimeout(resolve, CLEANUP_DEADLINE_MS).unref?.()),
  ]);
  return outcome.code;
}

const SIGNALS: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
