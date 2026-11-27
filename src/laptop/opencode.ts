import { execFile } from "node:child_process";
import { launchHarness, type HarnessLaunch, type LaunchDeps, type LaunchIO } from "./harness-launch.js";
import { planModelName, planModelsLine, planOrder } from "./plan-models.js";

/**
 * `dl opencode [opencode args...]`: the person's own OpenCode (github.com/anomalyco/opencode, was
 * sst/opencode) on the free tier. The flow (sign-in, harness key, session events, exit code) is
 * harness-launch.ts's; this file is how OpenCode is told where the free tier is.
 *
 * OpenCode speaks the OpenAI-compatible chat completions API, which the free tier serves to
 * Autopilot, with the same allowance, caps and refusals as Autopilot's (the whole allowance by
 * default). It gets DeepSeek V4.1 Flash: GPT-6 is available in Autopilot for now (the service's
 * `gpt6Clients`), so it isn't offered here; the service's /v1/models says what a run may use.
 *
 * How it's configured, for this run only and without touching any OpenCode file:
 *  - `OPENCODE_CONFIG_CONTENT`: inline config that OpenCode 1 and 2 both read, merged above the
 *    person's global and project files. It adds a provider "dl" (`@ai-sdk/openai-compatible`,
 *    `baseURL` the service's /v1), lists the free tier's models with their context and output
 *    limits, and makes dl/deepseek/deepseek-v4.1-flash-1017 the model (and for titles). Their own providers and
 *    settings stay; they can switch to them in /models as usual. It's the OpenCode 1 config shape,
 *    which OpenCode 2 reads unchanged (and maps the package to its built-in compatible runtime).
 *  - The key isn't in that config: it says `{env:DL_FREE_TIER_KEY}`, and the key is in that
 *    variable. The harness key is refreshed by id, so the string OpenCode read at start stays
 *    good for the whole run; no longer TTL is needed.
 *  - OpenCode 2 runs sessions in a shared background server by default, which has its own
 *    environment and would never see the config or key. dl starts it with `--standalone`: a
 *    private server for this run, started by OpenCode with this environment. OpenCode 1 has no
 *    shared server (and no such flag), so it gets none. `--server URL` can't be used: that server
 *    can't be given the free tier.
 */

export const HARNESS = "opencode" as const;
/** The provider id in OpenCode: models are `dl/<free tier model id>`. */
export const PROVIDER_ID = "dl";
/** The variable OpenCode reads the harness key from (`{env:...}` in the config). */
export const KEY_ENV = "DL_FREE_TIER_KEY";
/** The official install commands (opencode.ai/docs), printed when `opencode` isn't on PATH. */
export const OPENCODE_INSTALL = "curl -fsSL https://opencode.ai/v2/install | bash";
export const OPENCODE_INSTALL_NPM = "npm install -g @opencode/cli";

/** Variables that would replace dl's inline config: left out for this run only (dl says so). */
export const CONFLICTING_ENV = ["OPENCODE_CONFIG_CONTENT"] as const;

export interface FreeTierModel {
  id: string;
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  vision: boolean;
}

/**
 * The free tier's models other agents may use (services/free/src/models.ts), for when the
 * service's /v1/models can't be read: DeepSeek only, as GPT-6 is available in Autopilot for
 * now. dl asks the service first, so a model opened to other agents shows up without a new dl.
 */
export const FREE_TIER_MODELS: readonly FreeTierModel[] = [
  { id: "deepseek/deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash 1017", contextWindow: 1_048_576, maxOutputTokens: 65_536, vision: false },
];
/** OpenCode's default model under "dl": DeepSeek V4.1 Flash. */
export const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash-1017";
/** The cheap model OpenCode uses for session titles. */
export const SMALL_MODEL = "deepseek/deepseek-v4.1-flash-1017";

type Env = Record<string, string | undefined>;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** OpenCode's inline config for this run (the OpenCode 1 shape, which OpenCode 2 reads too). */
export function opencodeConfig(input: { origin: string; models: readonly FreeTierModel[] }): Record<string, unknown> {
  const ids = input.models.map((model) => model.id);
  const main = ids.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : ids[0]!;
  const small = ids.includes(SMALL_MODEL) ? SMALL_MODEL : main;
  return {
    $schema: "https://opencode.ai/config.json",
    model: `${PROVIDER_ID}/${main}`,
    small_model: `${PROVIDER_ID}/${small}`,
    provider: {
      [PROVIDER_ID]: {
        name: "dl free tier",
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: `${input.origin}/v1`,
          apiKey: `{env:${KEY_ENV}}`,
          includeUsage: true,
        },
        models: Object.fromEntries(
          input.models.map((model) => [
            model.id,
            {
              name: model.name,
              tool_call: true,
              attachment: model.vision,
              modalities: { input: model.vision ? ["text", "image"] : ["text"], output: ["text"] },
              limit: { context: model.contextWindow, output: model.maxOutputTokens },
            },
          ]),
        ),
      },
    },
  };
}

/** OpenCode's environment: the person's, without CONFLICTING_ENV, plus the config and key. */
export function opencodeEnv(parent: Env, input: { origin: string; key: string; models: readonly FreeTierModel[] }): { env: Env; removed: string[] } {
  const env: Env = { ...parent };
  const removed: string[] = [];
  for (const name of CONFLICTING_ENV) {
    if (env[name] !== undefined && env[name] !== "") removed.push(name);
    delete env[name];
  }
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(opencodeConfig(input));
  env[KEY_ENV] = input.key;
  return { env, removed };
}

/** The major version `opencode --version` printed ("2.1.0", "opencode 1.14.3"), or undefined. */
export function majorVersion(output: string): number | undefined {
  const match = /(\d+)\.\d+\.\d+/.exec(output);
  return match ? Number(match[1]) : undefined;
}

/** `opencode --version`'s output, or "" when it fails or takes too long. */
export function opencodeVersion(binary: string, env: Env): Promise<string> {
  return new Promise((resolve) => {
    execFile(binary, ["--version"], { env: env as NodeJS.ProcessEnv, timeout: 10_000, maxBuffer: 64 * 1024 }, (error, stdout) => resolve(error ? "" : String(stdout)));
  });
}

/** Whether the person asked for a specific server (`--server URL`, `--server=URL`). */
function namesServer(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "--") return false;
    if (arg === "--server" || arg.startsWith("--server=")) return true;
  }
  return false;
}

/**
 * OpenCode's arguments: the person's, after `--standalone` on OpenCode 2 (unless they gave it).
 * An unknown version is taken as 2, the current one.
 */
export function opencodeArgs(args: string[], major: number | undefined): string[] {
  if (major !== undefined && major < 2) return args;
  if (args.includes("--standalone")) return args;
  return ["--standalone", ...args];
}

/** The free tier's models from its /v1/models (the harness key reads it), or the built-in list. */
export async function freeTierModels(fetchImpl: Fetch, origin: string, key: string): Promise<readonly FreeTierModel[]> {
  try {
    const response = await fetchImpl(`${origin}/v1/models`, { method: "GET", headers: { accept: "application/json", authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return FREE_TIER_MODELS;
    const body = (await response.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) return FREE_TIER_MODELS;
    const models: FreeTierModel[] = [];
    for (const item of body.data as Array<Record<string, unknown>>) {
      if (typeof item?.id !== "string" || !item.id) continue;
      const known = FREE_TIER_MODELS.find((model) => model.id === item.id);
      const positive = (value: unknown, fallback: number | undefined) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback);
      const contextWindow = positive(item.context_window, known?.contextWindow);
      const maxOutputTokens = positive(item.max_output_tokens, known?.maxOutputTokens);
      if (contextWindow === undefined || maxOutputTokens === undefined) continue;
      models.push({
        id: item.id,
        name: typeof item.name === "string" && item.name ? item.name : (known?.name ?? item.id),
        contextWindow,
        maxOutputTokens,
        vision: typeof item.vision === "boolean" ? item.vision : (known?.vision ?? false),
      });
    }
    return models.length > 0 ? models : FREE_TIER_MODELS;
  } catch {
    return FREE_TIER_MODELS;
  }
}

/** The line after dl opencode sets up OpenCode: the plan's models, under the dl provider in /models. */
export function opencodeModelsLine(models: readonly FreeTierModel[]): string {
  return planModelsLine(planOrder(models).map(planModelName), `switch with /models (under ${PROVIDER_ID})`);
}

export interface OpencodeDeps extends LaunchDeps {
  /** `opencode --version`'s output; runs it unless replaced. */
  version?: (binary: string, env: Env) => Promise<string>;
}

export function opencodeLaunch(deps: OpencodeDeps = {}): HarnessLaunch {
  const call: Fetch = deps.fetch ?? ((url, init) => fetch(url, init));
  return {
    harness: HARNESS,
    command: "dl opencode",
    product: "OpenCode",
    sessionPrefix: "dl-opencode",
    missing: `${OPENCODE_INSTALL}\n\n  or with npm: ${OPENCODE_INSTALL_NPM}`,
    binaries: { posix: ["opencode"], win32: ["opencode.exe", "opencode.cmd", "opencode"] },
    prepare: async ({ env, args, origin, key, binary }) => {
      if (namesServer(args)) {
        return { error: "dl opencode can't use --server: free tokens are set up in the OpenCode server dl opencode starts. Leave --server out, or use that server with your own provider." };
      }
      const [version, models] = await Promise.all([(deps.version ?? opencodeVersion)(binary, env), freeTierModels(call, origin, key)]);
      return { ...opencodeEnv(env, { origin, key, models }), args: opencodeArgs(args, majorVersion(version)), models: opencodeModelsLine(models) };
    },
  };
}

export async function opencodeCommand(args: string[], io: LaunchIO, deps: OpencodeDeps = {}): Promise<number> {
  return launchHarness(opencodeLaunch(deps), args, io, deps);
}
