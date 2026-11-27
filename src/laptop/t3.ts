import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { claudeEnv, claudeModelsLine, CLAUDE_MODEL, CLAUDE_OPUS_KIMI } from "./claude.js";
import { claudeSettingsRefusal } from "./claude-settings.js";
import { launchHarness, type HarnessLaunch, type LaunchDeps, type LaunchIO } from "./harness-launch.js";
import { freeTierModels, opencodeEnv, PROVIDER_ID, DEFAULT_MODEL, FREE_TIER_MODELS, type FreeTierModel } from "./opencode.js";
import { hasKimi, KIMI_MODEL, planModelLabel } from "./plan-models.js";
import { TtyPrompter } from "../prompt.js";

/**
 * `dl t3 [t3 args...]`: the person's own T3 Code (github.com/pingdotgg/t3code, the `t3` command)
 * with its Claude Code and OpenCode agents on the free tier. The flow (sign-in, keys, session
 * events, exit code) is harness-launch.ts's; this file is how T3 Code is started.
 *
 * T3 Code is a server (`t3`, or `t3 serve` without a browser) that runs the agents on this
 * machine for its web, desktop and phone clients. It starts Claude Code (through the Agent SDK)
 * and OpenCode (`opencode serve`) with its own environment merged under each provider instance's
 * settings, so dl starts the server with the environment `dl claude` and `dl opencode` give
 * those agents, for this run only:
 *  - Claude Code: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and the model variables (claude.ts),
 *    with a claude-code harness key. Every request is served by DeepSeek, whatever Claude model
 *    T3 Code's picker names.
 *  - OpenCode: `OPENCODE_CONFIG_CONTENT` with the "dl" provider and its key in `DL_FREE_TIER_KEY`
 *    (opencode.ts), with an opencode harness key. T3 Code starts its own OpenCode server with
 *    this environment (unless the person set a Server URL in its settings).
 * Two keys, so each agent's requests are counted as that agent's (and get the other agents'
 * share of the allowance). Both are refreshed while `dl t3` runs and revoked when it exits.
 * One T3 Code file may be changed, only after asking at a terminal (or with --dl-enable-opencode
 * when there's none): its settings (~/.t3/userdata/settings.json) get the OpenCode provider
 * instance enabled, which T3 Code ships disabled (enableT3OpenCode). No other key in it is
 * touched, and the first change keeps a backup. No Claude Code or OpenCode file is touched.
 *
 * Only a server started by dl t3 has this: the desktop app opened from the Dock or Start menu,
 * the background service (`t3 service`, `t3 up`) and a server already running don't. Commands
 * that don't start a server are refused before sign-in, with what to run instead.
 */

export const HARNESSES = ["claude-code", "opencode"] as const;
/** The official install commands (t3.codes, the T3 Code README), printed when `t3` isn't on PATH. */
export const T3_INSTALL = "curl -fsSL https://t3.codes/install.sh | sh";
export const T3_INSTALL_NPM = "npm install -g t3";

/** `t3` subcommands that start the server dl gives the free tier to. */
const SERVER_COMMANDS = new Set(["serve", "start"]);
/** `t3` subcommands that run without dl's environment reaching the agents. */
const BACKGROUND_COMMANDS = new Set(["service", "up", "connect"]);
const OTHER_COMMANDS = new Set([
  "help",
  "app",
  "pair",
  "auth",
  "environment",
  "browser",
  "project",
  "thread",
  "status",
  "update",
  "install",
  "uninstall",
  "theme",
  "trace",
  "doctor",
  "policy",
  "triage",
]);

type Env = Record<string, string | undefined>;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface T3Deps extends LaunchDeps {
  /** T3 Code's settings file; ~/.t3/userdata/settings.json (HOME from the environment) unless replaced. */
  t3Settings?: string;
  /**
   * Asks a yes/no question; resolves true for yes. Asked on the terminal when stdin and stderr are
   * one, unless replaced; null when there's no terminal to ask on.
   */
  confirm?: ((question: string) => Promise<boolean>) | null;
}

/** dl t3's own flag (taken out before t3 sees the arguments): turn on OpenCode in T3 Code's settings without asking. */
export const ENABLE_OPENCODE_FLAG = "--dl-enable-opencode";

/** What dl t3 merges into T3 Code's settings: OpenCode, which T3 Code ships disabled, turned on. */
export const OPENCODE_INSTANCE = { driver: "opencode", enabled: true } as const;
/** T3 Code's own id for its Claude agent provider instance (CLAUDE_DRIVER_KIND in T3 Code). */
export const CLAUDE_INSTANCE = "claudeAgent";
/**
 * T3 Code 0.1.11's Claude models, by slug. Its picker names rows from its own model manifest
 * ("Claude Opus 5.5", "Claude Sonnet 5.5", …) and ignores ANTHROPIC_DEFAULT_*_MODEL_NAME; its
 * `customModels` setting renames catalog models by slug (`providerModelsFromSettings` in T3
 * Code), so dl writes these names there. Update the slugs when T3 Code moves to new models.
 */
export const T3_CLAUDE_MODELS = [
  { slug: "claude-opus-5-5", kind: "opus" },
  { slug: "claude-sonnet-5-5", kind: "deepseek" },
  { slug: "claude-fable-5-2", kind: "deepseek" },
  { slug: "claude-haiku-5-5", kind: "deepseek" },
] as const;

export function t3SettingsPath(env: Env): string {
  return join(env.HOME || homedir(), ".t3", "userdata", "settings.json");
}

/** The `customModels` entries that name dl's models in T3 Code's Claude picker. */
export function t3ClaudeCustomModels(models: readonly FreeTierModel[] = FREE_TIER_MODELS, plan: string | null = null): Array<{ slug: string; name: string }> {
  const kimi = hasKimi(models);
  return T3_CLAUDE_MODELS.map(({ slug, kind }) => ({
    slug,
    name: planModelLabel({ id: kind === "opus" && kimi ? CLAUDE_OPUS_KIMI : CLAUDE_MODEL }, plan),
  }));
}

/** Whether an entry is one dl wrote: a T3 Claude slug named "dl / …". */
function isDlCustomModel(entry: unknown): boolean {
  return (
    isObject(entry) &&
    typeof entry.slug === "string" &&
    typeof entry.name === "string" &&
    entry.name.startsWith("dl / ") &&
    T3_CLAUDE_MODELS.some((model) => model.slug === entry.slug)
  );
}

/** `customModels` without dl's entries, from this run or one that crashed: the person's own setting. */
function withoutDlCustomModels(existing: unknown): unknown[] | undefined {
  if (existing === undefined) return [];
  if (!Array.isArray(existing)) return undefined;
  return existing.filter((entry) => !isDlCustomModel(entry));
}

/** Existing `customModels` with dl's names merged in, keeping every entry it doesn't name. */
function mergeCustomModels(existing: unknown, desired: ReadonlyArray<{ slug: string; name: string }>): unknown[] | undefined {
  if (existing !== undefined && !Array.isArray(existing)) return undefined;
  const intended = new Map(desired.map((entry) => [entry.slug, entry.name]));
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (const entry of existing ?? []) {
    const slug = typeof entry === "string" ? entry : isObject(entry) && typeof entry.slug === "string" ? entry.slug : undefined;
    if (slug === undefined || !intended.has(slug)) {
      out.push(entry);
      continue;
    }
    seen.add(slug);
    out.push(isObject(entry) ? { ...entry, name: intended.get(slug) } : { slug, name: intended.get(slug) });
  }
  for (const { slug, name } of desired) if (!seen.has(slug)) out.push({ slug, name });
  return out;
}

async function writeT3Settings(path: string, settings: Record<string, unknown>, options: { backup?: boolean } = {}): Promise<string | undefined> {
  try {
    await mkdir(dirname(path), { recursive: true });
    if (options.backup) await copyFile(path, `${path}.dl-backup`, fsConstants.COPYFILE_EXCL /* only the first time */).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    const temp = `${path}.dl-${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, path);
    return undefined;
  } catch (error) {
    return `couldn't write ${path}: ${(error as Error).message}`;
  }
}

/** T3 Code's settings now, or undefined when the file is gone or isn't a JSON object. */
async function readT3Settings(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await readFile(path, "utf8");
    if (text.trim() === "") return {};
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** What a run did to T3 Code's settings; `cleanup` puts the person's own customModels back. */
export interface T3SettingsRun {
  result: "enabled" | "named" | "unchanged" | "declined";
  cleanup?: () => Promise<void>;
}

/**
 * Points T3 Code's settings at dl's models for this run. It turns on T3 Code's OpenCode provider
 * instance (`providerInstances.opencode`), which T3 Code ships disabled ("Provider instance
 * "opencode" is disabled for project …"), so the dl/… models dl t3 gives it can be picked; that
 * stays on. It also names its Claude models in
 * `providerInstances.claudeAgent.config.customModels` ("dl / DeepSeek V4.1 Flash (Free)"): T3
 * Code's picker lists its own Claude names and does not read the ANTHROPIC_DEFAULT_*_MODEL_NAME
 * variables, while `customModels` renames catalog models by slug. Those names are for this run
 * only: they are written without asking (nothing permanent), `cleanup` restores the person's exact
 * customModels, and a run that writes them first removes any dl entries a crashed earlier run left.
 * `allow` is asked only for the permanent change, turning OpenCode on; false leaves OpenCode off
 * ("declined") but still names the Claude models for the run. Creates the file when missing; keeps
 * every other key, every other provider instance and every custom model entry it doesn't name;
 * writes nothing when nothing is needed. The first time it changes an existing file it copies it to
 * settings.json.dl-backup. A file that isn't a JSON object is left alone. Returns what happened:
 * "enabled" (OpenCode on), "named" (dl's Claude names are set for the run), "unchanged",
 * "declined" (OpenCode stays off), or why it couldn't.
 */
export async function enableT3OpenCode(
  path: string,
  options: { allow?: () => Promise<boolean>; models?: readonly FreeTierModel[]; plan?: string | null } = {},
): Promise<T3SettingsRun | { error: string }> {
  let text: string | undefined;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { error: `couldn't read ${path}: ${(error as Error).message}` };
  }
  let settings: Record<string, unknown> = {};
  if (text !== undefined && text.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { error: `${path} isn't valid JSON, so dl left it alone` };
    }
    if (!isObject(parsed)) return { error: `${path} isn't a JSON object, so dl left it alone` };
    settings = parsed;
  }
  const instances = settings.providerInstances;
  if (instances !== undefined && !isObject(instances)) return { error: `providerInstances in ${path} isn't an object, so dl left it alone` };
  const current = instances?.opencode;
  if (current !== undefined && !isObject(current)) return { error: `providerInstances.opencode in ${path} isn't an object, so dl left it alone` };
  const currentClaude = instances?.[CLAUDE_INSTANCE];
  if (currentClaude !== undefined && !isObject(currentClaude)) return { error: `providerInstances.${CLAUDE_INSTANCE} in ${path} isn't an object, so dl left it alone` };
  const claudeConfig = currentClaude?.config;
  if (claudeConfig !== undefined && !isObject(claudeConfig)) return { error: `providerInstances.${CLAUDE_INSTANCE}.config in ${path} isn't an object, so dl left it alone` };

  const hadCustomModels = claudeConfig !== undefined && Object.hasOwn(claudeConfig, "customModels");
  const currentCustom = hadCustomModels ? (claudeConfig as Record<string, unknown>).customModels : undefined;
  const cleaned = withoutDlCustomModels(currentCustom);
  if (cleaned === undefined) return { error: `providerInstances.${CLAUDE_INSTANCE}.config.customModels in ${path} isn't a list, so dl left it alone` };
  const named = mergeCustomModels(cleaned, t3ClaudeCustomModels(options.models ?? FREE_TIER_MODELS, options.plan ?? null))!;
  const needsNames = JSON.stringify(currentCustom) !== JSON.stringify(named);
  const leftovers = hadCustomModels && JSON.stringify(currentCustom) !== JSON.stringify(cleaned);
  const manageNames = needsNames || leftovers;

  const openCodeOn = current?.driver === OPENCODE_INSTANCE.driver && current.enabled === true;
  if (openCodeOn && !manageNames) return { result: "unchanged" };

  // Only turning OpenCode on is permanent, so only that is asked; dl's Claude names are for this
  // run and are written whether or not the person lets dl change their provider.
  const turnOn = openCodeOn || (options.allow ? await options.allow() : false);
  const providerInstances: Record<string, unknown> = {
    ...instances,
    ...(turnOn && !openCodeOn ? { opencode: { ...current, ...OPENCODE_INSTANCE } } : {}),
    ...(needsNames ? { [CLAUDE_INSTANCE]: { driver: CLAUDE_INSTANCE, ...currentClaude, config: { ...claudeConfig, customModels: named } } } : {}),
  };
  if (needsNames || (turnOn && !openCodeOn)) {
    const problem = await writeT3Settings(path, { ...settings, providerInstances }, { backup: text !== undefined });
    if (problem) return { error: problem };
  }
  const result = openCodeOn ? "named" : turnOn ? "enabled" : "declined";
  if (!manageNames && !(turnOn && !openCodeOn)) return { result };
  // Put customModels back the way the person had it (dl entries from a crash are not theirs).
  const cleanup = async () => {
    const now = await readT3Settings(path);
    const nowInstances = now?.providerInstances;
    if (!isObject(nowInstances)) return;
    const nowClaude = nowInstances[CLAUDE_INSTANCE];
    if (!isObject(nowClaude)) return;
    const nowConfig = nowClaude.config;
    if (nowConfig !== undefined && !isObject(nowConfig)) return;
    const config: Record<string, unknown> = { ...(nowConfig ?? {}) };
    // If customModels held only dl's (a crashed run), there is nothing of the person's to keep.
    const restoreCustom = hadCustomModels && !(cleaned.length === 0 && leftovers) ? cleaned : undefined;
    if (restoreCustom !== undefined) config.customModels = restoreCustom;
    else delete config.customModels;
    const instance: Record<string, unknown> = { ...nowClaude };
    if (Object.keys(config).length > 0) instance.config = config;
    else delete instance.config;
    const nextInstances: Record<string, unknown> = { ...nowInstances };
    // An instance with nothing but its driver is T3 Code's default: don't leave one behind.
    if (Object.keys(instance).every((key) => key === "driver")) delete nextInstances[CLAUDE_INSTANCE];
    else nextInstances[CLAUDE_INSTANCE] = instance;
    const restored: Record<string, unknown> = { ...now, providerInstances: nextInstances };
    if (Object.keys(nextInstances).length === 0) delete restored.providerInstances;
    // The file didn't exist before dl created it just for its run-only names: remove it again.
    if (Object.keys(restored).length === 0 && text === undefined) {
      await rm(path, { force: true });
      return;
    }
    await writeT3Settings(path, restored);
  };
  return { result, cleanup };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Why `dl t3 ARGS` can't give the free tier to what ARGS run, or undefined when they start the
 * server (`t3`, `t3 serve`, `t3 start`, `t3 PATH`, flags only).
 */
export function t3Refusal(args: string[]): string | undefined {
  const first = args[0];
  if (first === undefined || first.startsWith("-") || SERVER_COMMANDS.has(first)) return undefined;
  if (BACKGROUND_COMMANDS.has(first)) {
    return `dl t3 can't give free tokens to T3 Code's background service: it runs without dl. Run dl t3 serve in a terminal (or tmux) instead, and reach it from your other devices as T3 Code's remote access docs say.`;
  }
  if (first === "app") {
    return "dl t3 can't give free tokens to the T3 Code desktop app: it starts its own server without dl. Run dl t3 to use T3 Code in your browser on free tokens.";
  }
  if (OTHER_COMMANDS.has(first)) {
    return `t3 ${first} doesn't start T3 Code's server, so there's nothing for dl t3 to give free tokens to. Run it as t3 ${first} (it works with the server dl t3 started).`;
  }
  return undefined; // A project folder: `t3 ./my-project`.
}

/**
 * T3 Code's environment: the person's, with Claude Code's free tier variables (claude-code key)
 * and OpenCode's (opencode key). `removed` lists the person's variables left out, once each.
 */
export function t3Env(parent: Env, input: { origin: string; claudeKey: string; opencodeKey: string; models: Parameters<typeof opencodeEnv>[1]["models"]; plan?: string | null }): { env: Env; removed: string[] } {
  const claude = claudeEnv(parent, { origin: input.origin, key: input.claudeKey, models: input.models, plan: input.plan });
  const opencode = opencodeEnv(claude.env, { origin: input.origin, key: input.opencodeKey, models: input.models, plan: input.plan });
  return { env: opencode.env, removed: [...claude.removed, ...opencode.removed] };
}

export function t3Launch(deps: T3Deps = {}): HarnessLaunch {
  const call: Fetch = deps.fetch ?? ((url, init) => fetch(url, init));
  return {
    harness: "claude-code",
    alsoHarnesses: ["opencode"],
    command: "dl t3",
    product: "T3 Code",
    sessionPrefix: "dl-t3",
    missing: `${T3_INSTALL}\n\n  or with npm: ${T3_INSTALL_NPM}`,
    binaries: { posix: ["t3"], win32: ["t3.exe", "t3.cmd", "t3"] },
    check: async (args, { env, cwd }) => t3Refusal(withoutDlFlags(args)) ?? (await claudeSettingsRefusal("dl t3", "dl's free tier", { env, cwd })),
    prepare: async ({ env, args, origin, keys, plan: planPromise }) => {
      const claudeKey = keys["claude-code"];
      const opencodeKey = keys.opencode;
      if (!claudeKey || !opencodeKey) return { error: "The free tier didn't give dl t3 a key for each agent. Try again." };
      const [models, plan] = await Promise.all([freeTierModels(call, origin, opencodeKey), planPromise()]);
      const settingsPath = deps.t3Settings ?? t3SettingsPath(env);
      const enabled = await enableT3OpenCode(settingsPath, { allow: openCodeConsent(args, settingsPath, deps.confirm), models, plan });
      return {
        ...t3Env(env, { origin, claudeKey, opencodeKey, models, plan }),
        args: withoutDlFlags(args),
        models: t3ModelsLine(models, plan),
        ...("error" in enabled || !enabled.cleanup ? {} : { cleanup: enabled.cleanup }),
        notes: [
          ...("error" in enabled
            ? [`OpenCode is off in T3 Code by default and dl couldn't set up its agents (${enabled.error}). Turn it on in T3 Code's settings.`]
            : enabled.result === "enabled"
              ? [`Turned on OpenCode in T3 Code's settings (${settingsPath}); it's off by default. dl also named its Claude models for this run without asking; they're put back when dl t3 stops.`]
              : enabled.result === "named"
                ? [`Named dl's Claude models in T3 Code's settings for this run without asking (${settingsPath}); they're put back when dl t3 stops.`]
                : enabled.result === "declined"
                  ? [`OpenCode is off in T3 Code (it ships that way); dl didn't turn it on. It named its Claude models for this run without asking and puts them back when dl t3 stops. Turn OpenCode on in T3 Code's settings, or run dl t3 ${ENABLE_OPENCODE_FLAG} to let dl do it.`]
                  : []),
          `Claude Code and OpenCode in this T3 Code server use your dl plan until you stop it. In OpenCode pick a ${PROVIDER_ID}/… model (${PROVIDER_ID}/${DEFAULT_MODEL}); ${t3ClaudeModels(models, plan)}`,
          "The T3 Code desktop app and t3 service don't get free tokens; use this server's web page. If T3 Code says a server is already running, quit it first (or add --base-dir DIR).",
        ],
      };
    },
  };
}

/** What Claude Code in T3 Code is served by: Opus is Kimi K3.1 on a plan with Kimi, everything else DeepSeek. */
function t3ClaudeModels(models: readonly FreeTierModel[], plan: string | null = null): string {
  const deepseek = planModelLabel({ id: DEFAULT_MODEL }, plan);
  if (!hasKimi(models)) return `Claude Code is served by ${deepseek} whatever model T3 Code shows.`;
  return `in Claude Code, Opus is ${planModelLabel({ id: KIMI_MODEL }, plan)} and Sonnet, Haiku or a full Claude model name ${deepseek}.`;
}

/** The line after dl t3 starts: the plan's models in both agents. */
export function t3ModelsLine(models: readonly FreeTierModel[], plan: string | null = null): string {
  return `${claudeModelsLine(models, plan).replace(/ — switch with \/model$/, "")}${hasKimi(models) ? " — switch in T3 Code's model picker" : ""}`;
}

/** `args` without dl t3's own flags, which t3 doesn't know. */
function withoutDlFlags(args: string[]): string[] {
  return args.filter((arg) => arg !== ENABLE_OPENCODE_FLAG);
}

/**
 * Whether dl may write T3 Code's settings: yes with --dl-enable-opencode; else the person's answer
 * at a terminal; else no.
 */
function openCodeConsent(args: string[], path: string, confirm: ((question: string) => Promise<boolean>) | null | undefined): () => Promise<boolean> {
  if (args.includes(ENABLE_OPENCODE_FLAG)) return async () => true;
  if (!confirm) return async () => false;
  return () => confirm(`\n  T3 Code ships its OpenCode agent turned off. dl t3 can turn it on in ${path}\n  (providerInstances.opencode; nothing else permanent changes, and a backup is kept).\n  Turn it on? [Y/n] `);
}

export async function t3Command(args: string[], io: LaunchIO, deps: T3Deps = {}): Promise<number> {
  const confirm = deps.confirm !== undefined ? deps.confirm : process.stdin.isTTY === true && process.stderr.isTTY === true ? ttyConfirm() : null;
  return launchHarness(t3Launch({ ...deps, confirm }), args, io, deps);
}

function ttyConfirm(): (question: string) => Promise<boolean> {
  const prompter = new TtyPrompter();
  return async (question) => !/^n/i.test((await prompter.text(question)).trim());
}
