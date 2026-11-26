import { platform } from "node:os";
import { claudeSettingsRefusal } from "./claude-settings.js";
import { launchHarness, onPath, type HarnessLaunch, type LaunchDeps, type LaunchIO } from "./harness-launch.js";

/**
 * `dl claude [claude args...]`: the person's own Claude Code on the free tier, served by DeepSeek.
 * The flow is shared with `dl opencode` (harness-launch.ts); this file is Claude Code's part.
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
 *    below; its exit code is dl's. Nothing under ~/.claude is written. Its settings files are
 *    read first (claude-settings.ts): one that sets an Anthropic key or apiKeyHelper stops dl
 *    claude, since that key would win over dl's and go to the free tier.
 */

/** The model Claude Code is told to use for every role; the service serves DeepSeek whatever it names. */
export const CLAUDE_MODEL = "deepseek/deepseek-v4.1-flash-1017";
export const HARNESS = "claude-code" as const;
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

export { REFRESH_EVERY_MS, SESSION_EVENT_EVERY_MS } from "./harness-launch.js";

type Env = Record<string, string | undefined>;

export type ClaudeIO = LaunchIO;

export interface ClaudeDeps extends Omit<LaunchDeps, "find"> {
  /** Where `claude` is; looked up on PATH unless replaced. */
  findClaude?: (env: Env) => Promise<string | undefined>;
}

const BINARIES = { posix: ["claude"], win32: ["claude.exe", "claude.cmd", "claude"] };

/** `claude` on PATH, or undefined. */
export async function claudeOnPath(env: Env = process.env): Promise<string | undefined> {
  return onPath(platform() === "win32" ? BINARIES.win32 : BINARIES.posix, env);
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

/**
 * What Claude Code prints on stdout in print mode (`claude -p`) the first time it sees a model it
 * doesn't know, as dl's DeepSeek is: one `[claude-code:unrecognized_model] {"model":…}` line
 * before the answer. dl moves it to stderr, so `dl claude -p "…"`'s stdout is only the answer.
 */
export const UNRECOGNIZED_MODEL_PREFIX = "[claude-code:unrecognized_model]";

/** Print mode (`-p`, `--print`), or stdout that isn't a terminal (a script reading it). */
export function claudePrintMode(args: string[], stdoutIsTerminal: boolean): boolean {
  return !stdoutIsTerminal || args.some((arg) => arg === "-p" || arg === "--print" || arg.startsWith("--print="));
}

/** `dl claude` for the shared launcher (harness-launch.ts). */
export const CLAUDE_LAUNCH: HarnessLaunch = {
  harness: HARNESS,
  command: "dl claude",
  product: "Claude Code",
  sessionPrefix: "dl-claude",
  missing: `${CLAUDE_INSTALL}\n\n  or with npm: ${CLAUDE_INSTALL_NPM}`,
  binaries: BINARIES,
  stdoutDiagnostics: { prefix: UNRECOGNIZED_MODEL_PREFIX, when: claudePrintMode },
  check: (_args, { env, cwd }) => claudeSettingsRefusal("dl claude", "dl's free tier", { env, cwd }),
  prepare: async ({ env, args, origin, key }) => ({ ...claudeEnv(env, { origin, key }), args }),
};

export async function claudeCommand(args: string[], io: ClaudeIO, deps: ClaudeDeps = {}): Promise<number> {
  const { findClaude, ...rest } = deps;
  return launchHarness(CLAUDE_LAUNCH, args, io, { ...rest, ...(findClaude ? { find: findClaude } : {}) });
}
