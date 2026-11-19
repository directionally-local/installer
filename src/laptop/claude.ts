import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { platform } from "node:os";
import { delimiter, join } from "node:path";
import { findAutopilot, type AutopilotCommand } from "./autopilot.js";
import { freeTierAccessToken, type FreeTierToken } from "./free-tier-token.js";

/**
 * `dl claude [claude args...]`: the person's own Claude Code on the free tier, served by DeepSeek.
 *
 * 1. Free tier sign-in: Autopilot's (refreshed when it has expired). Not signed in: Autopilot's
 *    sign-in runs first (`autopilot auth directionally-local`), as on dl's first run.
 * 2. `claude` must be on PATH: dl never installs it, it prints the official install command.
 * 3. A short-lived harness key from the service (POST /v1/harness-keys): good for 15 minutes,
 *    refreshed every few minutes while Claude Code runs and revoked when it exits, so free tokens
 *    in Claude Code work only while dl claude runs. It goes to Claude Code in its environment
 *    (never on a command line, never logged or printed).
 * 4. Session events, as Autopilot sends them (POST /v1/events): session.start before Claude Code
 *    starts (so the dl-only check covers its requests), again every few hours for long sessions,
 *    and session.end when it exits. Counts only.
 * 5. Claude Code runs with every argument and the terminal passed through, with the environment
 *    below; its exit code is dl's. Nothing under ~/.claude is read or written.
 */

/** The model Claude Code is told to use for every role; the service serves DeepSeek whatever it names. */
export const CLAUDE_MODEL = "deepseek/deepseek-v4.1-flash-1017";
export const HARNESS = "claude-code";
/** The official install command, printed when `claude` isn't on PATH. */
export const CLAUDE_INSTALL = "curl -fsSL https://claude.ai/install.sh | bash";
export const CLAUDE_INSTALL_NPM = "npm install -g @anthropic-ai/claude-code";

/**
 * Variables the person may have set that would send Claude Code elsewhere or with another
 * credential: left out of Claude Code's environment for this run only (dl says which, once).
 */
export const CONFLICTING_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

/** Refresh the harness key this often (it lasts 15 minutes). */
export const REFRESH_EVERY_MS = 4 * 60_000;
/** Send session.start again this often: a session event covers the dl-only check for 24 hours. */
export const SESSION_EVENT_EVERY_MS = 6 * 3600_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** How long dl waits for session.end and the key's revocation after Claude Code exits. */
const CLEANUP_DEADLINE_MS = 3_000;

type Env = Record<string, string | undefined>;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ClaudeIO {
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface ClaudeDeps {
  env?: Env;
  /** A fresh free tier access token; Autopilot's sign-in, refreshed, unless replaced. */
  token?: () => Promise<FreeTierToken>;
  /** Runs the free tier sign-in in the terminal; Autopilot's unless replaced. True when it finished. */
  signIn?: () => Promise<boolean>;
  /** Where `claude` is; looked up on PATH unless replaced. */
  findClaude?: (env: Env) => Promise<string | undefined>;
  fetch?: Fetch;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
  clearInterval?: (timer: unknown) => void;
  /** Signals dl forwards to Claude Code; process.on unless replaced. */
  onSignal?: (signal: NodeJS.Signals, handler: () => void) => () => void;
  now?: () => number;
}

/** `claude` on PATH, or undefined. */
export async function claudeOnPath(env: Env = process.env): Promise<string | undefined> {
  const names = platform() === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
    }
  }
  return undefined;
}

/**
 * Claude Code's environment: the person's, without CONFLICTING_ENV, plus the free tier's. Returns
 * the names it left out too, so dl can say so once.
 */
export function claudeEnv(parent: Env, input: { origin: string; key: string }): { env: Env; removed: string[] } {
  const env: Env = { ...parent };
  const removed: string[] = [];
  for (const name of CONFLICTING_ENV) {
    if (env[name] !== undefined && env[name] !== "") removed.push(name);
    delete env[name];
  }
  Object.assign(env, {
    ANTHROPIC_BASE_URL: `${input.origin}/anthropic`,
    // Sent as `Authorization: Bearer`; unlike ANTHROPIC_API_KEY it needs no approval prompt.
    ANTHROPIC_AUTH_TOKEN: input.key,
    ANTHROPIC_MODEL: CLAUDE_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: CLAUDE_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: CLAUDE_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: CLAUDE_MODEL,
    // Older Claude Code versions read this one for background tasks.
    ANTHROPIC_SMALL_FAST_MODEL: CLAUDE_MODEL,
    CLAUDE_CODE_SUBAGENT_MODEL: CLAUDE_MODEL,
    // No telemetry, error reports or update checks to Anthropic; no pre-release request fields.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
  });
  return { env, removed };
}

/** Autopilot's own free tier sign-in, in this terminal. */
async function autopilotSignIn(io: ClaudeIO, find: () => Promise<AutopilotCommand | undefined> = findAutopilot): Promise<boolean> {
  const autopilot = await find();
  if (!autopilot) {
    io.err("  dl claude needs the free tier sign-in, and Autopilot (which signs in) isn't installed. Reinstall dl: curl -fsSL https://dl.new | sh\n");
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

export async function claudeCommand(args: string[], io: ClaudeIO, deps: ClaudeDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const call: Fetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? Date.now;

  const claude = await (deps.findClaude ?? claudeOnPath)(env);
  if (!claude) {
    io.err(`  Claude Code isn't installed (no claude on PATH). Install it, then run dl claude again:\n\n    ${CLAUDE_INSTALL}\n\n  or with npm: ${CLAUDE_INSTALL_NPM}\n`);
    return 1;
  }

  const getToken = deps.token ?? (() => freeTierAccessToken({ env }));
  let token = await getToken();
  if (!token.ok && token.reason === "signed_out") {
    io.out("  dl claude uses your free tier sign-in. Signing in first (this also makes the free tier Autopilot's provider; change it with /provider).\n");
    if (!(await (deps.signIn ?? (() => autopilotSignIn(io)))())) {
      io.err("  Not signed in to the free tier, so dl claude can't start. Run dl claude again to retry.\n");
      return 1;
    }
    token = await getToken();
  }
  if (!token.ok) {
    io.err(`  ${token.reason === "signed_out" ? "Not signed in to the free tier. Run dl claude again to sign in." : token.message}\n`);
    return 1;
  }
  const { origin, accessToken } = token;

  // The harness key.
  let minted: Response;
  try {
    minted = await call(`${origin}/v1/harness-keys`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ harness: HARNESS }),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    io.err(`  Couldn't reach the free tier (${error instanceof Error ? error.message : String(error)}). Try again.\n`);
    return 1;
  }
  const mintedBody = await json(minted);
  if (minted.status !== 201 || typeof mintedBody?.key !== "string" || typeof mintedBody.id !== "string") {
    const message = typeof mintedBody?.error?.message === "string" ? mintedBody.error.message : `The free tier refused dl claude (HTTP ${minted.status}).`;
    io.err(`  ${message}\n`);
    return 1;
  }
  const key: string = mintedBody.key;
  const keyId: string = mintedBody.id;
  const asKey = (extra: Record<string, string> = {}) => ({ accept: "application/json", authorization: `Bearer ${key}`, ...extra });

  const sessionId = `dl-claude-${randomUUID()}`;
  const started = now();
  let eventCount = 0;
  const sendEvent = async (type: "session.start" | "session.end", props: Record<string, unknown> = {}) => {
    try {
      await call(`${origin}/v1/events`, {
        method: "POST",
        headers: asKey({ "content-type": "application/json" }),
        body: JSON.stringify({ events: [{ id: `${sessionId}-${++eventCount}`, type, sessionId, at: new Date(now()).toISOString(), props: { harness: HARNESS, os: platform(), ...props } }] }),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // Best effort: a lost event never stops the session.
    }
  };
  // Before Claude Code's first request, so the dl-only check counts them as dl's.
  await sendEvent("session.start");

  const { env: childEnv, removed } = claudeEnv(env, { origin, key });
  if (removed.length > 0) io.err(`  dl claude: not passing ${removed.join(", ")} to Claude Code for this session (it runs on dl's free tier).\n`);

  const every = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const stop = deps.clearInterval ?? ((timer: unknown) => clearInterval(timer as NodeJS.Timeout));
  const refresher = every(() => {
    void call(`${origin}/v1/harness-keys/${keyId}/refresh`, { method: "POST", headers: asKey(), redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).catch(() => undefined);
  }, REFRESH_EVERY_MS);
  const heartbeat = every(() => void sendEvent("session.start"), SESSION_EVENT_EVERY_MS);
  refresher.unref?.();
  heartbeat.unref?.();

  const child = (deps.spawn ?? nodeSpawn)(claude, args, { stdio: "inherit", env: childEnv as NodeJS.ProcessEnv });
  // Ctrl-C reaches Claude Code from the terminal itself; dl just mustn't die of it. Other
  // signals sent to dl alone are passed on, so Claude Code exits and dl still cleans up.
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
      io.err(`  Couldn't start Claude Code: ${error.message}\n`);
      resolve({ code: 1, reason: "spawn_failed" });
    });
    child.on("exit", (code, signal) => resolve(signal ? { code: 128 + (SIGNALS[signal] ?? 1), reason: `signal_${signal}` } : { code: code ?? 1, reason: "exit" }));
  });
  for (const off of unsubscribe) off();
  stop(refresher);
  stop(heartbeat);

  // Session end and the key's end, both best effort and bounded.
  await Promise.race([
    Promise.allSettled([
      sendEvent("session.end", { durationMs: Math.max(0, now() - started), exitReason: outcome.reason }),
      call(`${origin}/v1/harness-keys/${keyId}`, { method: "DELETE", headers: asKey(), redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).catch(() => undefined),
    ]),
    new Promise((resolve) => setTimeout(resolve, CLEANUP_DEADLINE_MS).unref?.()),
  ]);
  return outcome.code;
}

const SIGNALS: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
