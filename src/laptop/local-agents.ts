import { execFile, spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { localFetch, modelApiBase, type FetchModel } from "../model-smoke.js";
import { DEFAULT_DEPLOYMENT, modelStatePath, readDeployments, type ModelDeployment } from "../state.js";
import type { System } from "../system.js";
import { claudeSettingsRefusal } from "./claude-settings.js";

/**
 * The coding agents dl can open on this box's own model (`dl model up`): Autopilot, Claude Code,
 * OpenCode and Pi. Autopilot is dl's own and is pointed at the model by `dl model up` (its vllm
 * provider). The others are the person's own CLIs, started for one run with their settings for
 * the local model injected through the environment, a flag or a temporary file. Their own config
 * files (~/.claude, ~/.config/opencode, ~/.pi) are never written; Claude Code's settings are read
 * once before it starts, to stop when they set an Anthropic key (claude-settings.ts).
 *
 * Local models only: nothing here talks to the free tier or uses its keys (dl claude and
 * dl opencode do that). The model is the box's deployment, on 127.0.0.1, with no key.
 *
 * Each launch is a plain description (command, args, env, a temporary file to write) built by a
 * pure function, so tests check exactly what an agent gets; `launchLocalAgent` runs it with the
 * terminal attached and returns its exit code.
 */

export type AgentId = "autopilot" | "claude-code" | "opencode" | "pi";

/** The agents in menu order: Autopilot first and the default. */
export const AGENT_IDS: readonly AgentId[] = ["autopilot", "claude-code", "opencode", "pi"];

export interface AgentInfo {
  id: AgentId;
  label: string;
  /** One short line for the menu. */
  note: string;
  /** The command on PATH; Autopilot's comes with dl. */
  binary?: string;
  /** The official install commands, printed when the CLI isn't on PATH (dl never installs them). */
  install?: readonly string[];
}

export const AGENTS: Readonly<Record<AgentId, AgentInfo>> = {
  autopilot: { id: "autopilot", label: "Autopilot", note: "comes with dl, made for local models" },
  "claude-code": {
    id: "claude-code", label: "Claude Code", binary: "claude", note: "Anthropic's CLI, on your model through its Messages API",
    install: ["curl -fsSL https://claude.ai/install.sh | bash", "npm install -g @anthropic-ai/claude-code"],
  },
  opencode: {
    id: "opencode", label: "OpenCode", binary: "opencode", note: "open-source agent, on your model as an OpenAI-compatible provider",
    install: ["curl -fsSL https://opencode.ai/v2/install | bash", "npm install -g @opencode/cli"],
  },
  pi: {
    id: "pi", label: "Pi", binary: "pi", note: "minimal open-source agent, on your model as an OpenAI-compatible provider",
    install: ["curl -fsSL https://pi.dev/install.sh | sh", "npm install -g --ignore-scripts @earendil-works/pi-coding-agent"],
  },
};

/** "claude", "Claude Code", "claude-code", "OpenCode"… → the agent's id. */
export function parseAgent(text: string | undefined): AgentId | undefined {
  const key = (text ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (key === "claude" || key === "claudecode") return "claude-code";
  if (key === "open-code") return "opencode";
  return (AGENT_IDS as readonly string[]).includes(key) ? key as AgentId : undefined;
}

/** The box's model, as the agents need it. */
export interface LocalModel {
  /** The deployment's name ("default" unless dl model up --name). */
  name: string;
  /** The served model id (vLLM's/SGLang's --served-model-name: the Hugging Face repo). */
  model: string;
  /** The OpenAI-compatible base, http://127.0.0.1:PORT/v1. */
  baseUrl: string;
  /** The context the engine was started with (tokens). */
  context: number;
  /** The output limit the agents are told: a quarter of the context, at most 32,000. */
  output: number;
  engine: "vllm" | "sglang";
  image: string;
}

/** A quarter of the context for output (the rest is the prompt), at most 32,000 tokens. */
export function outputLimit(context: number): number {
  return Math.max(1024, Math.min(32_000, Math.floor(context / 4)));
}

export function localModelFrom(name: string, deployment: ModelDeployment): LocalModel {
  return {
    name, model: deployment.repo, baseUrl: modelApiBase(deployment), context: deployment.context,
    output: outputLimit(deployment.context), engine: deployment.engine ?? "vllm", image: deployment.image,
  };
}

/**
 * The deployment the agents use: the default one, else the only one, else the first by name (with
 * several, `dl model up --name` users pick with --name on dl agent). Undefined when none.
 */
export async function readLocalModel(system: System, options: { statePath?: string; name?: string } = {}): Promise<LocalModel | undefined> {
  const deployments = await readDeployments(system, options.statePath ?? modelStatePath()).catch(() => ({} as Awaited<ReturnType<typeof readDeployments>>));
  const names = Object.keys(deployments).sort();
  const name = options.name !== undefined ? (names.includes(options.name) ? options.name : undefined)
    : names.includes(DEFAULT_DEPLOYMENT) ? DEFAULT_DEPLOYMENT : names[0];
  return name ? localModelFrom(name, deployments[name]!.active) : undefined;
}

// ── What each agent needs from the model ───────────────────────────────────

/**
 * Claude Code speaks only Anthropic's Messages API (POST /v1/messages). vLLM serves it from
 * 0.11.1 (PR #22627) and SGLang from 0.5.9; every image in dl's catalog is newer (vLLM 0.20.0
 * and 0.33.0, SGLang 0.5.23), so it talks to the engine directly, with no translator. An image
 * from --image with an older version tag is reported unsupported; a tag without a version
 * (latest, nightly) is assumed new.
 */
export const MESSAGES_API_SINCE: Readonly<Record<"vllm" | "sglang", readonly [number, number, number]>> = { vllm: [0, 11, 1], sglang: [0, 5, 9] };

/** Claude Code's system prompt and tools alone take well over 16k tokens: below this it can't work. */
export const CLAUDE_CODE_MIN_CONTEXT = 32_768;

function imageVersion(image: string): [number, number, number] | undefined {
  const tag = image.includes(":") ? image.slice(image.lastIndexOf(":") + 1) : "";
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(tag);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function older(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

export type Support = { ok: true } | { ok: false; reason: string };

/** Whether `agent` can work on `model`, and why not. */
export function agentSupport(agent: AgentId, model: LocalModel): Support {
  if (agent !== "claude-code") return { ok: true };
  const version = imageVersion(model.image);
  const since = MESSAGES_API_SINCE[model.engine];
  const label = model.engine === "sglang" ? "SGLang" : "vLLM";
  if (version && older(version, since)) {
    return { ok: false, reason: `needs ${label} ${since.join(".")} or newer for the Messages API; this model runs ${version.join(".")} (dl model update)` };
  }
  if (model.context < CLAUDE_CODE_MIN_CONTEXT) {
    return { ok: false, reason: `needs a ${CLAUDE_CODE_MIN_CONTEXT / 1024}k context; this model runs ${Math.floor(model.context / 1024)}k (dl model update --context ${CLAUDE_CODE_MIN_CONTEXT})` };
  }
  return { ok: true };
}

// ── Launches ───────────────────────────────────────────────────────────────

type Env = Record<string, string | undefined>;

const execFileAsync = promisify(execFile);

export interface LaunchSpec {
  command: string;
  args: string[];
  env: Env;
  /** Variables of the person's left out for this run (said once). */
  removed: string[];
  /** A file written before the start, in a private temporary directory removed afterwards; `{dir}` in args is that directory. */
  file?: { name: string; contents: string };
}

/** The provider id the agents' configs use for the local model. */
export const LOCAL_PROVIDER = "dl-local";
/** Sent where an agent insists on a key; the engine runs without one (127.0.0.1 only). */
export const LOCAL_KEY = "dl-local-no-key";

/**
 * The person's variables that would send Claude Code elsewhere or with another credential: left
 * out for this run only. (The same list as dl claude's; one shared launcher will hold it.)
 */
export const CLAUDE_CONFLICTING_ENV = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
] as const;

/** One-run OpenCode config variables of the person's that would replace dl's. */
export const OPENCODE_CONFLICTING_ENV = ["OPENCODE_CONFIG_CONTENT"] as const;

function without(parent: Env, names: readonly string[]): { env: Env; removed: string[] } {
  const env: Env = { ...parent };
  const removed: string[] = [];
  for (const name of names) {
    if (env[name] !== undefined && env[name] !== "") removed.push(name);
    delete env[name];
  }
  return { env, removed };
}

/** The engine's root, for clients that add /v1 themselves (Claude Code: ANTHROPIC_BASE_URL + /v1/messages). */
function apiRoot(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "");
}

/**
 * Claude Code on the engine's own Messages API: ANTHROPIC_BASE_URL at the engine, a dummy
 * ANTHROPIC_AUTH_TOKEN (a credential must be set, or a saved claude.ai login would be used
 * instead), every model role on the served model, the context and output limits, and no traffic
 * to Anthropic (telemetry, error reports, update checks).
 */
export function claudeCodeLaunch(model: LocalModel, parent: Env, args: readonly string[]): LaunchSpec {
  const { env, removed } = without(parent, CLAUDE_CONFLICTING_ENV);
  Object.assign(env, {
    ANTHROPIC_BASE_URL: apiRoot(model.baseUrl),
    ANTHROPIC_AUTH_TOKEN: LOCAL_KEY,
    ANTHROPIC_MODEL: model.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model.model,
    ANTHROPIC_SMALL_FAST_MODEL: model.model,
    CLAUDE_CODE_SUBAGENT_MODEL: model.model,
    // An unknown model id is otherwise assumed to have a 1M context, so it would never compact in time.
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(model.context),
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(model.output),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
  });
  return { command: AGENTS["claude-code"].binary!, args: [...args], env, removed };
}

/**
 * OpenCode's one-run config: OPENCODE_CONFIG_CONTENT, merged over the person's own config files
 * (it ranks above them; only an administrator's managed config ranks higher). The provider is
 * OpenCode's OpenAI-compatible one at the engine, with the served model and its limits, chosen
 * as the model. The config shape is OpenCode 1's, which OpenCode 2 also reads.
 */
export function openCodeConfig(model: LocalModel): Record<string, unknown> {
  return {
    $schema: "https://opencode.ai/config.json",
    model: `${LOCAL_PROVIDER}/${model.model}`,
    provider: {
      [LOCAL_PROVIDER]: {
        npm: "@ai-sdk/openai-compatible",
        name: "This box (dl model)",
        options: { baseURL: model.baseUrl },
        models: { [model.model]: { name: model.model, tool_call: true, limit: { context: model.context, output: model.output } } },
      },
    },
  };
}

/**
 * OpenCode 2 loads config in a server process, and by default its terminal UI connects to one
 * shared background server per user, which never sees this run's environment. `--standalone`
 * ("Run with a private server instead of the background service") starts a private one that
 * inherits it. OpenCode 1 has no shared server and rejects the flag, so it's added for 2 only.
 */
export function openCodeLaunch(model: LocalModel, parent: Env, args: readonly string[], major: number | undefined): LaunchSpec {
  const { env, removed } = without(parent, OPENCODE_CONFLICTING_ENV);
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(openCodeConfig(model));
  const standalone = major !== undefined && major >= 2;
  const withFlag = !standalone ? [...args] : args[0] === "run" ? ["run", "--standalone", ...args.slice(1)] : ["--standalone", ...args];
  return { command: AGENTS.opencode.binary!, args: withFlag, env, removed };
}

/** The major version in `opencode --version`'s output ("1.19.6", "opencode 2.3.2"), or undefined. */
export function majorVersion(output: string | undefined): number | undefined {
  const match = /(\d+)\.\d+\.\d+/.exec(output ?? "");
  return match ? Number(match[1]) : undefined;
}

/** File name of Pi's one-run extension. */
export const PI_EXTENSION = "dl-local-model.ts";

/**
 * Pi's one-run provider: an extension file (`pi -e FILE`) that registers the engine as an
 * OpenAI-compatible provider with the served model and its limits. Pi reads models.json only
 * from its own agent directory, so an extension is how a provider is added without touching
 * ~/.pi; the person's settings, sign-ins, extensions and sessions stay as they are.
 * Plain JavaScript, so it needs nothing imported.
 */
export function piExtension(model: LocalModel): string {
  const provider = {
    name: "This box (dl model)",
    baseUrl: model.baseUrl,
    // Pi offers a model only when it has a key; the engine ignores it.
    apiKey: LOCAL_KEY,
    api: "openai-completions",
    models: [{
      type: "chat", id: model.model, name: model.model, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.context, maxTokens: model.output,
      compat: { maxTokensField: "max_tokens" },
    }],
  };
  return `// Written by dl for one run of Pi on this box's model; removed when Pi exits.\nexport default function (pi) {\n  pi.registerProvider(${JSON.stringify(LOCAL_PROVIDER)}, ${JSON.stringify(provider, null, 2).replace(/\n/g, "\n  ")});\n}\n`;
}

export function piLaunch(model: LocalModel, parent: Env, args: readonly string[]): LaunchSpec {
  const env: Env = { ...parent, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
  return {
    command: AGENTS.pi.binary!,
    args: ["-e", join("{dir}", PI_EXTENSION), "--provider", LOCAL_PROVIDER, "--model", model.model, ...args],
    env, removed: [], file: { name: PI_EXTENSION, contents: piExtension(model) },
  };
}

/** `continue`: each CLI's own flag for the latest session here (all three use -c). */
export function launchSpec(agent: Exclude<AgentId, "autopilot">, model: LocalModel, parent: Env, options: { continue?: boolean; args?: readonly string[]; opencodeMajor?: number } = {}): LaunchSpec {
  const args = [...(options.continue ? ["-c"] : []), ...(options.args ?? [])];
  if (agent === "claude-code") return claudeCodeLaunch(model, parent, args);
  if (agent === "opencode") return openCodeLaunch(model, parent, args, options.opencodeMajor);
  return piLaunch(model, parent, args);
}

// ── Running one ─────────────────────────────────────────────────────────────

/** `name` on PATH, or undefined. */
export async function onPath(name: string, env: Env = process.env): Promise<string | undefined> {
  const names = platform() === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const candidate of names.map((n) => join(dir, n))) {
      if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
    }
  }
  return undefined;
}

/** Whether each agent's CLI is installed (Autopilot always: it comes with dl). */
export async function installedAgents(env: Env = process.env, find: (name: string, env: Env) => Promise<string | undefined> = onPath): Promise<Record<AgentId, boolean>> {
  const result = { autopilot: true } as Record<AgentId, boolean>;
  for (const id of AGENT_IDS) if (id !== "autopilot") result[id] = Boolean(await find(AGENTS[id].binary!, env));
  return result;
}

/** What to print when an agent's CLI isn't installed. */
export function installMessage(agent: Exclude<AgentId, "autopilot">): string {
  const info = AGENTS[agent];
  const [first, ...rest] = info.install!;
  return `  ${info.label} isn't installed (no ${info.binary} on PATH). Install it, then run dl again:\n\n    ${first}\n${rest.map((line) => `\n  or: ${line}\n`).join("")}\n  Or open Autopilot instead: dl agent set autopilot\n`;
}

export interface LaunchIO {
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface LaunchDeps {
  env?: Env;
  find?: (name: string, env: Env) => Promise<string | undefined>;
  fetch?: FetchModel;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  /** `BINARY --version`'s output (OpenCode 1 or 2); runs it unless replaced. */
  version?: (binary: string) => Promise<string | undefined>;
  /** Signals passed on to the agent; process.on unless replaced. */
  onSignal?: (signal: NodeJS.Signals, handler: () => void) => () => void;
  tmp?: string;
  cwd?: string;
}

const SIGNALS: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };

/**
 * Opens `agent` on the box's model with the terminal attached: every argument passed through,
 * its exit code returned. Stops first, with what to do, when the CLI isn't installed, the agent
 * can't work on this model, or the model isn't answering.
 */
export async function launchLocalAgent(agent: Exclude<AgentId, "autopilot">, model: LocalModel, options: { continue?: boolean; args?: readonly string[] }, io: LaunchIO, deps: LaunchDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const info = AGENTS[agent];
  const binary = await (deps.find ?? onPath)(info.binary!, env);
  if (!binary) {
    io.err(installMessage(agent));
    return 1;
  }
  const support = agentSupport(agent, model);
  if (!support.ok) {
    io.err(`  ${info.label} can't run on ${model.model} here: it ${support.reason}.\n  Open Autopilot instead: dl agent set autopilot\n`);
    return 1;
  }
  if (agent === "claude-code") {
    const refused = await claudeSettingsRefusal("dl", "this box's model", { env, cwd: deps.cwd ?? process.cwd() });
    if (refused) {
      io.err(`  ${refused}\n`);
      return 1;
    }
  }
  if (!(await answers(deps.fetch ?? localFetch, `${model.baseUrl}/models`))) {
    io.err(`  The model on this box (${model.model}, ${model.baseUrl}) isn't answering, so ${info.label} can't start. See dl model status.\n`);
    return 1;
  }
  const opencodeMajor = agent === "opencode" ? majorVersion(await (deps.version ?? realVersion)(binary)) : undefined;
  const spec = launchSpec(agent, model, env, { ...options, ...(opencodeMajor !== undefined ? { opencodeMajor } : {}) });
  if (spec.removed.length) io.err(`  dl: not passing ${spec.removed.join(", ")} to ${info.label} for this session (it runs on this box's model).\n`);
  let dir: string | undefined;
  try {
    if (spec.file) {
      dir = await mkdtemp(join(deps.tmp ?? tmpdir(), "dl-agent-"));
      await writeFile(join(dir, spec.file.name), spec.file.contents, { mode: 0o600 });
    }
    const args = spec.args.map((arg) => dir ? arg.replace("{dir}", dir) : arg);
    const child = (deps.spawn ?? nodeSpawn)(binary, args, { stdio: "inherit", env: spec.env as NodeJS.ProcessEnv, ...(deps.cwd ? { cwd: deps.cwd } : {}) });
    // Ctrl-C reaches the agent from the terminal itself; dl just mustn't die of it.
    const onSignal = deps.onSignal ?? ((signal: NodeJS.Signals, handler: () => void) => {
      process.on(signal, handler);
      return () => process.off(signal, handler);
    });
    const unsubscribe = [onSignal("SIGINT", () => undefined), ...(["SIGTERM", "SIGHUP"] as const).map((signal) => onSignal(signal, () => child.kill(signal)))];
    const code = await new Promise<number>((resolve) => {
      child.on("error", (error) => {
        io.err(`  Couldn't start ${info.label}: ${error.message}\n`);
        resolve(1);
      });
      child.on("exit", (status, signal) => resolve(signal ? 128 + (SIGNALS[signal] ?? 1) : status ?? 1));
    });
    for (const off of unsubscribe) off();
    return code;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function realVersion(binary: string): Promise<string | undefined> {
  const { stdout } = await execFileAsync(binary, ["--version"], { timeout: 10_000 }).catch(() => ({ stdout: "" }));
  return stdout || undefined;
}

async function answers(call: FetchModel, url: string): Promise<boolean> {
  try {
    const response = await call(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(3_000) });
    return response.ok;
  } catch {
    return false;
  }
}
