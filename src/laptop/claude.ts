import { platform } from "node:os";
import { claudeSettingsRefusal } from "./claude-settings.js";
import { launchHarness, onPath, type HarnessLaunch, type LaunchDeps, type LaunchIO } from "./harness-launch.js";
import { FREE_TIER_MODELS, freeTierModels, type FreeTierModel } from "./opencode.js";
import { hasKimi, KIMI_MODEL, planModelLabel, planModelsLine } from "./plan-models.js";

/**
 * `dl claude [claude args...]`: the person's own Claude Code on the dl plan: DeepSeek, and Kimi K3.1
 * as Opus on Plus and Max.
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

/**
 * The model Claude Code is told to use for every role on Free and Starter, and for every role but
 * Opus on Plus and Max (where Opus is Kimi K3.1: CLAUDE_OPUS_KIMI). The service serves DeepSeek
 * for any Claude model name; an open-model id it names exactly goes through the plan.
 */
export const CLAUDE_MODEL = "deepseek/deepseek-v4.1-flash-1017";
/** On a plan with Kimi (its id in the key's /v1/models), Claude Code's Opus is Kimi K3.1. */
export const CLAUDE_OPUS_KIMI = KIMI_MODEL;
/** The models' real context window (DeepSeek V4.1 Flash and Kimi K3.1: 1M), declared to Claude Code, which doesn't know them. */
export const CLAUDE_CONTEXT_WINDOW = 1_048_576;
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
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
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
 *
 * `models` is what the key may use (its /v1/models). With Kimi K3.1 there (Plus, Max), Opus is
 * Kimi and every other role DeepSeek, so Claude Code's own /model picker switches between them,
 * each row named for its model (the _NAME/_DESCRIPTION variables Claude Code reads when
 * ANTHROPIC_BASE_URL is a gateway); `plan` names the plan in those labels. Without Kimi, every
 * role (Fable included) is DeepSeek. Claude Code's duplicate-row check compares each row's
 * `value`, which for a family override is the role alias ("opus", "sonnet", "haiku", "fable"),
 * not the model id: the four rows never collapse, so on Free each description says which role
 * it is and that they are all the same model. `ANTHROPIC_DEFAULT_MODEL` is the picker's Default
 * row: set it explicitly, or Claude Code can show the Opus (Kimi) model there. Subagents stay on
 * DeepSeek.
 */
export function claudeEnv(parent: Env, input: { origin: string; key: string; models?: readonly FreeTierModel[]; plan?: string | null }): { env: Env; removed: string[] } {
  const env: Env = { ...parent };
  const removed: string[] = [];
  for (const name of CONFLICTING_ENV) {
    if (env[name] !== undefined && env[name] !== "") removed.push(name);
    delete env[name];
  }
  const kimi = hasKimi(input.models ?? FREE_TIER_MODELS);
  const plan = input.plan ?? null;
  const deepseek = planModelLabel({ id: CLAUDE_MODEL }, plan);
  const kimiLabel = planModelLabel({ id: CLAUDE_OPUS_KIMI }, plan);
  // Claude Code keeps every family row (its duplicate check uses the role alias as the value),
  // so each description names its role; on Free all four say they are the same DeepSeek model.
  const sameOnFree = (role: string) => `On your dl plan · ${role}: the same DeepSeek model on every Free row`;
  Object.assign(env, {
    ANTHROPIC_BASE_URL: `${input.origin}/anthropic`,
    // Sent as `Authorization: Bearer`; unlike ANTHROPIC_API_KEY it needs no approval prompt.
    ANTHROPIC_AUTH_TOKEN: input.key,
    // DeepSeek on every plan; on Plus/Max /model moves to Opus (Kimi) explicitly.
    ANTHROPIC_MODEL: CLAUDE_MODEL,
    // The Default row. Without it Claude Code may show Opus's model (Kimi on Plus/Max) as the default.
    ANTHROPIC_DEFAULT_MODEL: CLAUDE_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: kimi ? CLAUDE_OPUS_KIMI : CLAUDE_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: kimi ? kimiLabel : deepseek,
    ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION: kimi ? "On your dl plan · Opus: Kimi K3.1, the stronger model, with a smaller weekly limit" : sameOnFree("Opus"),
    ANTHROPIC_DEFAULT_SONNET_MODEL: CLAUDE_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: deepseek,
    ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION: kimi ? "On your dl plan · Sonnet: DeepSeek V4.1 Flash, with the larger weekly limit" : sameOnFree("Sonnet"),
    ANTHROPIC_DEFAULT_HAIKU_MODEL: CLAUDE_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: deepseek,
    ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION: kimi ? "On your dl plan · Haiku: DeepSeek V4.1 Flash, same as Sonnet and Fable" : sameOnFree("Haiku"),
    // Fable: DeepSeek like Sonnet and Haiku (only Opus is Kimi on Plus/Max). Claude Code 2.1.332
    // reads these three names; without them its own Fable row ("Fable 5.2 · $8/$40 per Mtok") stays.
    ANTHROPIC_DEFAULT_FABLE_MODEL: CLAUDE_MODEL,
    ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: deepseek,
    ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION: kimi ? "On your dl plan · Fable: DeepSeek V4.1 Flash, same as Sonnet and Haiku" : sameOnFree("Fable"),
    // Older Claude Code versions read this one for background tasks.
    ANTHROPIC_SMALL_FAST_MODEL: CLAUDE_MODEL,
    CLAUDE_CODE_SUBAGENT_MODEL: CLAUDE_MODEL,
    // Claude Code's documented way to set an unrecognized model's window; without it, it warns
    // "doesn't recognize the model … assumes a context window of …" on every start.
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(CLAUDE_CONTEXT_WINDOW),
    // No telemetry, error reports or update checks to Anthropic; no pre-release request fields.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
  });
  return { env, removed };
}

/** The line after dl claude sets up Claude Code: which plan model each /model row is. */
export function claudeModelsLine(models: readonly FreeTierModel[], plan: string | null = null): string {
  const deepseek = planModelLabel({ id: CLAUDE_MODEL }, plan);
  if (!hasKimi(models)) return planModelsLine([deepseek]);
  return planModelsLine([`${deepseek} as Sonnet`, `${planModelLabel({ id: CLAUDE_OPUS_KIMI }, plan)} as Opus`], "switch with /model");
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

/** `dl claude` for the shared launcher (harness-launch.ts). The key's /v1/models says whether Opus is Kimi. */
export function claudeLaunch(deps: LaunchDeps = {}): HarnessLaunch {
  const call = deps.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  return {
    harness: HARNESS,
    command: "dl claude",
    product: "Claude Code",
    sessionPrefix: "dl-claude",
    missing: `${CLAUDE_INSTALL}\n\n  or with npm: ${CLAUDE_INSTALL_NPM}`,
    binaries: BINARIES,
    stdoutDiagnostics: { prefix: UNRECOGNIZED_MODEL_PREFIX, when: claudePrintMode },
    check: (_args, { env, cwd }) => claudeSettingsRefusal("dl claude", "dl's free tier", { env, cwd }),
    prepare: async ({ env, args, origin, key, plan: planPromise }) => {
      // A claude-code harness key (the old free tier sign-in) can't list models: DeepSeek only then.
      // /v1/me's plan is already in flight; wait for both together.
      const [models, plan] = await Promise.all([key.startsWith("dlh_") ? FREE_TIER_MODELS : freeTierModels(call, origin, key), planPromise]);
      return { ...claudeEnv(env, { origin, key, models, plan }), args, models: claudeModelsLine(models, plan) };
    },
  };
}

export async function claudeCommand(args: string[], io: ClaudeIO, deps: ClaudeDeps = {}): Promise<number> {
  const { findClaude, ...rest } = deps;
  return launchHarness(claudeLaunch(rest), args, io, { ...rest, ...(findClaude ? { find: findClaude } : {}) });
}
