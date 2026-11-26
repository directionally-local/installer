import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { claudeEnv } from "./claude.js";
import { claudeSettingsRefusal } from "./claude-settings.js";
import { launchHarness, type HarnessLaunch, type LaunchDeps, type LaunchIO } from "./harness-launch.js";
import { freeTierModels, opencodeEnv, PROVIDER_ID, DEFAULT_MODEL } from "./opencode.js";

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
 * One T3 Code file is changed: its settings (~/.t3/userdata/settings.json) get the OpenCode
 * provider instance enabled, which T3 Code ships disabled (enableT3OpenCode). No other key in it
 * is touched, and the first change keeps a backup. No Claude Code or OpenCode file is touched.
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
}

/** What dl t3 merges into T3 Code's settings: OpenCode, which T3 Code ships disabled, turned on. */
export const OPENCODE_INSTANCE = { driver: "opencode", enabled: true } as const;

export function t3SettingsPath(env: Env): string {
  return join(env.HOME || homedir(), ".t3", "userdata", "settings.json");
}

/**
 * Turns on T3 Code's OpenCode provider instance (`providerInstances.opencode`), which T3 Code
 * ships disabled ("Provider instance "opencode" is disabled for project …"), so the dl/… models
 * dl t3 gives it can be picked. Creates the file when missing; keeps every other key, including
 * the instance's own; writes nothing when it's already on. The first time it changes an existing
 * file it copies it to settings.json.dl-backup. A file that isn't a JSON object is left alone.
 * Returns what happened: "enabled", "unchanged", or why it couldn't.
 */
export async function enableT3OpenCode(path: string): Promise<{ result: "enabled" | "unchanged" } | { error: string }> {
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
  if (current?.driver === OPENCODE_INSTANCE.driver && current.enabled === true) return { result: "unchanged" };
  const next = { ...settings, providerInstances: { ...instances, opencode: { ...current, ...OPENCODE_INSTANCE } } };
  try {
    await mkdir(dirname(path), { recursive: true });
    if (text !== undefined) await copyFile(path, `${path}.dl-backup`, fsConstants.COPYFILE_EXCL /* only the first time */).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    const temp = `${path}.dl-${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, path);
  } catch (error) {
    return { error: `couldn't write ${path}: ${(error as Error).message}` };
  }
  return { result: "enabled" };
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
export function t3Env(parent: Env, input: { origin: string; claudeKey: string; opencodeKey: string; models: Parameters<typeof opencodeEnv>[1]["models"] }): { env: Env; removed: string[] } {
  const claude = claudeEnv(parent, { origin: input.origin, key: input.claudeKey });
  const opencode = opencodeEnv(claude.env, { origin: input.origin, key: input.opencodeKey, models: input.models });
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
    check: async (args, { env, cwd }) => t3Refusal(args) ?? (await claudeSettingsRefusal("dl t3", "dl's free tier", { env, cwd })),
    prepare: async ({ env, args, origin, keys }) => {
      const claudeKey = keys["claude-code"];
      const opencodeKey = keys.opencode;
      if (!claudeKey || !opencodeKey) return { error: "The free tier didn't give dl t3 a key for each agent. Try again." };
      const models = await freeTierModels(call, origin, opencodeKey);
      const settingsPath = deps.t3Settings ?? t3SettingsPath(env);
      const enabled = await enableT3OpenCode(settingsPath);
      return {
        ...t3Env(env, { origin, claudeKey, opencodeKey, models }),
        args,
        notes: [
          ...("error" in enabled
            ? [`OpenCode is off in T3 Code by default and dl couldn't turn it on (${enabled.error}). Turn it on in T3 Code's settings.`]
            : enabled.result === "enabled"
              ? [`Turned on OpenCode in T3 Code's settings (${settingsPath}); it's off by default.`]
              : []),
          `Claude Code and OpenCode in this T3 Code server use free tokens until you stop it. In OpenCode pick a ${PROVIDER_ID}/… model (${PROVIDER_ID}/${DEFAULT_MODEL}); Claude Code is served by DeepSeek whatever model T3 Code shows.`,
          "The T3 Code desktop app and t3 service don't get free tokens; use this server's web page. If T3 Code says a server is already running, quit it first (or add --base-dir DIR).",
        ],
      };
    },
  };
}

export async function t3Command(args: string[], io: LaunchIO, deps: T3Deps = {}): Promise<number> {
  return launchHarness(t3Launch(deps), args, io, deps);
}
