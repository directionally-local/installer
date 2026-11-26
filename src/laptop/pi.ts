import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchHarness, type HarnessLaunch, type LaunchDeps, type LaunchIO } from "./harness-launch.js";
import { DEFAULT_MODEL, freeTierModels, type FreeTierModel } from "./opencode.js";

/**
 * `dl pi [pi args...]`: the person's own Pi (github.com/earendil-works/pi, npm
 * @earendil-works/pi-coding-agent, binary `pi`) on the free tier. The flow (sign-in, harness key,
 * session events, exit code) is harness-launch.ts's; this file is how Pi is told where the free
 * tier is.
 *
 * Pi speaks the OpenAI-compatible chat completions API (`openai-completions`), which the free tier
 * serves to Autopilot and OpenCode, so the models the person may use there work in Pi: DeepSeek
 * V4.1 Flash by default, and any others /v1/models lists for them, on the same allowance
 * (not GPT-6: it is available in Autopilot for now).
 *
 * How it's configured, for this run only and without touching ~/.pi:
 *  - A one-run extension file (`pi -e FILE`, in a private temporary directory removed when Pi
 *    exits) registers a provider "dl" with `baseUrl` the service's /v1 and the models from the
 *    service's /v1/models (per person). Pi reads models.json only from its own directory, so an
 *    extension is how a provider is added without writing there; the person's settings, sign-ins,
 *    extensions and sessions stay as they are, and their other providers stay in /model.
 *  - The key isn't in that file: it says `$DL_FREE_TIER_KEY`, which Pi resolves on every request,
 *    and the key is in that variable. The harness key is refreshed by id while dl pi runs, so the
 *    string Pi read stays good for the whole run. (Pi's `!command` key would run a command per
 *    request; a command minting a key per request would also hit the service's limit of live
 *    harness keys, and refreshing by id already keeps this one fresh.)
 *  - Session ids: Pi sends its own session id as `x-session-id` on every request
 *    (`sendSessionAffinityHeaders` with `sessionAffinityFormat: "openrouter"`), so each Pi session
 *    (/new included) gets its own use label and allocator session. A static x-session-id header
 *    would replace it (Pi merges provider headers last), so there is none. `x-dl-harness: pi` lets
 *    the service word an expired key's refusal for Pi.
 *  - Compatibility flags go on each model: Pi ignores a legacy provider's own `compat`.
 *  - `--provider dl --model <default>` pick DeepSeek unless the person passes their own
 *    --provider/--model (or --models), which then win.
 */

export const HARNESS = "pi" as const;
/** The provider id in Pi: models are `dl/<free tier model id>`. */
export const PROVIDER_ID = "dl";
/** The variable Pi reads the harness key from (`$DL_FREE_TIER_KEY` in the extension). */
export const KEY_ENV = "DL_FREE_TIER_KEY";
/** File name of the one-run extension. */
export const EXTENSION_FILE = "dl-free-tier.js";
/** The npm package and official install commands, printed when `pi` isn't on PATH. */
export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_INSTALL_NPM = `npm install -g ${PI_PACKAGE}`;
export const PI_INSTALL = "curl -fsSL https://pi.dev/install.sh | sh";

type Env = Record<string, string | undefined>;

/** The free tier's models that reason (models.ts `reasoning`): every model it serves today. */
const REASONING = (_id: string) => true;

/**
 * What the service's chat completions take, for Pi's `openai-completions` (checked against Pi
 * 1.6.0's requests): the service is neither api.openai.com nor OpenRouter, so this is said rather
 * than guessed from the URL.
 */
export const PI_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  supportsUsageInStreaming: true,
  maxTokensField: "max_tokens",
  // Pi's session id as x-session-id on every request.
  sendSessionAffinityHeaders: true,
  sessionAffinityFormat: "openrouter",
  promptCacheKeyMode: "disabled",
} as const;

/** The provider Pi gets (Pi's legacy `ProviderConfig` shape for `pi.registerProvider`). */
export function piProvider(input: { origin: string; models: readonly FreeTierModel[] }): Record<string, unknown> {
  return {
    name: "dl free tier",
    baseUrl: `${input.origin}/v1`,
    apiKey: `$${KEY_ENV}`,
    api: "openai-completions",
    headers: { "x-dl-harness": HARNESS },
    models: input.models.map((model) => ({
      type: "chat",
      id: model.id,
      name: model.name,
      reasoning: REASONING(model.id),
      input: model.vision ? ["text", "image"] : ["text"],
      // Free tokens: Pi shows no dollar cost.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow,
      maxTokens: model.maxOutputTokens,
      compat: PI_COMPAT,
    })),
  };
}

/** The extension file's text: plain JavaScript, so it needs nothing imported. */
export function piExtension(input: { origin: string; models: readonly FreeTierModel[] }): string {
  return `// Written by dl pi for one run of Pi on dl's free tier; removed when Pi exits. No key in here.\nexport default function (pi) {\n  pi.registerProvider(${JSON.stringify(PROVIDER_ID)}, ${JSON.stringify(piProvider(input), null, 2).replace(/\n/g, "\n  ")});\n}\n`;
}

/** Whether the person picked a model or provider themselves (then dl doesn't). */
function picksModel(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === "--") return false;
    if (/^--(model|models|provider)(=|$)/.test(arg)) return true;
  }
  return false;
}

/** Pi's arguments: the extension, then dl's provider and model unless the person chose, then theirs. */
export function piArgs(args: readonly string[], extension: string, models: readonly FreeTierModel[]): string[] {
  const ids = models.map((model) => model.id);
  const main = ids.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : ids[0]!;
  return ["-e", extension, ...(picksModel(args) ? [] : ["--provider", PROVIDER_ID, "--model", `${PROVIDER_ID}/${main}`]), ...args];
}

/** Pi's environment: the person's, plus the key; Pi's version check and install telemetry off. */
export function piEnv(parent: Env, key: string): Env {
  return { ...parent, [KEY_ENV]: key, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
}

export interface PiDeps extends LaunchDeps {
  /** Where the temporary extension directory goes; the OS's unless replaced. */
  tmp?: string;
}

export function piLaunch(deps: PiDeps = {}): HarnessLaunch {
  const call = deps.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  return {
    harness: HARNESS,
    command: "dl pi",
    product: "Pi",
    sessionPrefix: "dl-pi",
    missing: `${PI_INSTALL_NPM}\n\n  or: ${PI_INSTALL}`,
    binaries: { posix: ["pi"], win32: ["pi.cmd", "pi.exe", "pi"] },
    prepare: async ({ env, args, origin, key }) => {
      const models = await freeTierModels(call, origin, key);
      const dir = await mkdtemp(join(deps.tmp ?? tmpdir(), "dl-pi-"));
      const file = join(dir, EXTENSION_FILE);
      await writeFile(file, piExtension({ origin, models }), { mode: 0o600 });
      return {
        env: piEnv(env, key),
        args: piArgs(args, file, models),
        removed: [],
        cleanup: () => rm(dir, { recursive: true, force: true }),
      };
    },
  };
}

export async function piCommand(args: string[], io: LaunchIO, deps: PiDeps = {}): Promise<number> {
  return launchHarness(piLaunch(deps), args, io, deps);
}
