import { launchHarness, type HarnessLaunch, type LaunchDeps, type LaunchIO } from "./harness-launch.js";
import { DEFAULT_MODEL, freeTierModels, type FreeTierModel } from "./opencode.js";
import { planModelName, planModelsLine, planOrder } from "./plan-models.js";

/**
 * `dl codex [codex args...]`: the person's own Codex CLI (github.com/openai/codex, npm
 * @openai/codex, binary `codex`) on their dl plan. The flow (sign-in, key, session events, exit
 * code) is harness-launch.ts's; this file is how Codex is told where dl is.
 *
 * Codex speaks only the OpenAI Responses API (`wire_api = "responses"`), which the service serves
 * at /v1/responses (services/free/src/responses.ts), translated onto the same chat completions
 * path every agent uses: the plan's models (DeepSeek V4.1 Flash by default, the others in /model),
 * on the same allowance.
 *
 * How it's configured, for this run only, without touching ~/.codex/config.toml: `-c` overrides
 * on Codex's command line (Codex's own way to set config for one run, read as TOML values), put
 * before the person's arguments so they reach subcommands too (`dl codex exec …`, `dl codex
 * resume …`). They define a provider `dl` (base URL the service's /v1, `wire_api = "responses"`,
 * the key from DL_API_KEY) and pick it with the default model, unless the person picks a provider
 * or model themselves (`-m`, `--oss`, `-p`, or their own `-c model…`), which then win. The
 * person's Codex home stays as it is: sessions, `codex resume`, MCP servers, AGENTS.md and
 * their own config all work. (A separate CODEX_HOME would hide them, and Codex refuses to put its
 * helper binaries under a temporary one.)
 *  - The key is only in Codex's environment (DL_API_KEY), never on its command line.
 *  - `x-dl-harness: codex` lets the service word an expired key's refusal for Codex.
 *  - Hosted web search is off: the service has none, so Codex doesn't offer the model a tool
 *    that can't run.
 *  - The model's context window, from the service's /v1/models: Codex doesn't know dl's models,
 *    so without it Codex would guess (it still warns that it has no metadata for the model).
 */

export const HARNESS = "codex" as const;
/** The provider id in Codex's config. */
export const PROVIDER_ID = "dl";
/** The variable Codex reads the key from (the provider's `env_key`). */
export const KEY_ENV = "DL_API_KEY";
/** The npm package and official install command, printed when `codex` isn't on PATH. */
export const CODEX_PACKAGE = "@openai/codex";
export const CODEX_INSTALL = `npm install -g ${CODEX_PACKAGE}`;

type Env = Record<string, string | undefined>;

/** A TOML string (what Codex's `-c key=value` reads): JSON's escaping is valid TOML basic-string escaping. */
const toml = (value: string) => JSON.stringify(value);

/** The `-c` overrides that define the dl provider (also what the by-hand steps put in config.toml). */
export function providerOverrides(origin: string): string[] {
  const at = `model_providers.${PROVIDER_ID}`;
  return [
    `${at}.name=${toml("dl")}`,
    `${at}.base_url=${toml(`${origin}/v1`)}`,
    `${at}.env_key=${toml(KEY_ENV)}`,
    `${at}.env_key_instructions=${toml("Run Codex through dl (dl codex), or set DL_API_KEY to your key from dl.new/keys.")}`,
    `${at}.wire_api=${toml("responses")}`,
    `${at}.http_headers={ "x-dl-harness" = ${toml(HARNESS)} }`,
  ];
}

/** What the person chose themselves on Codex's command line (dl doesn't choose that, then). */
export function choices(args: readonly string[]): { provider: boolean; model: boolean } {
  let provider = false;
  let model = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") break;
    if (arg === "--oss" || /^--(profile|local-provider)(=|$)/.test(arg) || arg === "-p") provider = true;
    if (/^--model(=|$)/.test(arg) || arg === "-m" || /^-m./.test(arg)) model = true;
    // -c key=value / --config key=value / -ckey=value
    const config = arg === "-c" || arg === "--config" ? args[index + 1] : /^--config=/.test(arg) ? arg.slice("--config=".length) : /^-c./.test(arg) ? arg.slice(2) : undefined;
    if (config !== undefined) {
      const key = config.split("=")[0]!.trim();
      if (key === "model_provider" || key === "profile") provider = true;
      if (key === "model") model = true;
    }
  }
  return { provider, model };
}

/** The default model: DeepSeek V4.1 Flash when the plan has it, else the plan's first. */
function mainModel(models: readonly FreeTierModel[]): FreeTierModel {
  return models.find((model) => model.id === DEFAULT_MODEL) ?? models[0]!;
}

/** Codex's arguments: dl's `-c` overrides first, then the person's own, as they are. */
export function codexArgs(args: readonly string[], origin: string, models: readonly FreeTierModel[]): string[] {
  const picked = choices(args);
  const main = mainModel(models);
  const overrides = [
    ...providerOverrides(origin),
    ...(picked.provider ? [] : [`model_provider=${toml(PROVIDER_ID)}`]),
    ...(picked.provider || picked.model ? [] : [`model=${toml(main.id)}`, `model_context_window=${main.contextWindow}`]),
    `web_search=${toml("disabled")}`,
  ];
  return [...overrides.flatMap((override) => ["-c", override]), ...args];
}

/** Codex's environment: the person's, plus the key. */
export function codexEnv(parent: Env, key: string): Env {
  return { ...parent, [KEY_ENV]: key };
}

/** The line after dl codex sets up Codex: the plan's models, and how to switch. */
export function codexModelsLine(models: readonly FreeTierModel[]): string {
  return planModelsLine(planOrder(models).map(planModelName), "switch with /model");
}

/**
 * The config.toml for setting Codex up by hand (router.ts's steps): the same provider, with the
 * key in DL_API_KEY. `models` are the plan's ids, the default first.
 */
export function codexConfigToml(origin: string, model: string): string[] {
  return [
    `model = ${toml(model)}`,
    `model_provider = ${toml(PROVIDER_ID)}`,
    `web_search = ${toml("disabled")}`,
    "",
    `[model_providers.${PROVIDER_ID}]`,
    `name = ${toml("dl")}`,
    `base_url = ${toml(`${origin}/v1`)}`,
    `env_key = ${toml(KEY_ENV)}`,
    `wire_api = ${toml("responses")}`,
  ];
}

export function codexLaunch(deps: LaunchDeps = {}): HarnessLaunch {
  const call = deps.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  return {
    harness: HARNESS,
    command: "dl codex",
    product: "Codex",
    sessionPrefix: "dl-codex",
    missing: CODEX_INSTALL,
    binaries: { posix: ["codex"], win32: ["codex.cmd", "codex.exe", "codex"] },
    prepare: async ({ env, args, origin, key }) => {
      const models = await freeTierModels(call, origin, key);
      return { env: codexEnv(env, key), args: codexArgs(args, origin, models), removed: [], models: codexModelsLine(models) };
    },
  };
}

export async function codexCommand(args: string[], io: LaunchIO, deps: LaunchDeps = {}): Promise<number> {
  return launchHarness(codexLaunch(deps), args, io, deps);
}
