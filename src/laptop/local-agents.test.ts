import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ChildProcess } from "node:child_process";
import type { ModelDeployment } from "../state.js";
import {
  agentSupport, CLAUDE_CONFLICTING_ENV, claudeCodeLaunch, installedAgents, launchLocalAgent, launchSpec, LOCAL_KEY, LOCAL_PROVIDER, localModelFrom,
  majorVersion, openCodeConfig, openCodeLaunch, outputLimit, parseAgent, piExtension, piLaunch, PI_EXTENSION, type LocalModel,
} from "./local-agents.js";

function deployment(extra: Partial<ModelDeployment> = {}): ModelDeployment {
  return { id: "qwen-new", repo: "Qwen/Qwen3-4B-Instruct-2507", container: "dl-model-8000", port: 8000, context: 32768, image: "vllm/vllm-openai:v0.20.0",
    flags: [], minVramMiB: 1, lastTest: { chat: true, tools: true, json: true, tokensPerSecond: 1, at: "" }, ...extra };
}

const MODEL: LocalModel = localModelFrom("default", deployment());

/** What a free tier session would have in the environment: none of it may reach a local agent's config. */
const FREE_TIER_ENV = {
  ANTHROPIC_BASE_URL: "https://free.directionallylocal.com/anthropic",
  ANTHROPIC_AUTH_TOKEN: "dlh_free_tier_harness_key",
  ANTHROPIC_API_KEY: "sk-ant-mine",
  ANTHROPIC_MODEL: "deepseek/deepseek-v4.1-flash-1017",
  CLAUDE_CODE_SUBAGENT_MODEL: "deepseek/deepseek-v4.1-flash-1017",
  OPENCODE_CONFIG_CONTENT: '{"provider":{"directionally-local":{}}}',
  PATH: "/usr/bin",
  HOME: "/home/me",
};

describe("the box's model, as the agents get it", () => {
  it("base URL, served id, context and output limit from the deployment", () => {
    assert.deepEqual(MODEL, { name: "default", model: "Qwen/Qwen3-4B-Instruct-2507", baseUrl: "http://127.0.0.1:8000/v1", context: 32768, output: 8192, engine: "vllm", image: "vllm/vllm-openai:v0.20.0" });
    assert.equal(outputLimit(131072), 32000);
    assert.equal(outputLimit(2048), 1024);
    assert.equal(localModelFrom("big", deployment({ engine: "sglang", port: 30001, host: "10.0.0.2" })).baseUrl, "http://10.0.0.2:30001/v1");
  });

  it("names people type", () => {
    assert.equal(parseAgent("claude"), "claude-code");
    assert.equal(parseAgent("Claude Code"), "claude-code");
    assert.equal(parseAgent("OpenCode"), "opencode");
    assert.equal(parseAgent("pi"), "pi");
    assert.equal(parseAgent("autopilot"), "autopilot");
    assert.equal(parseAgent("codex"), undefined);
    assert.equal(parseAgent(""), undefined);
  });
});

describe("what each agent needs from the engine", () => {
  it("Claude Code: the catalog's images serve /v1/messages (vLLM 0.11.1+, SGLang 0.5.9+)", () => {
    for (const image of ["vllm/vllm-openai:v0.20.0", "vllm/vllm-openai:v0.33.0", "vllm/vllm-openai:v0.34.0rc2", "vllm/vllm-openai:latest", "vllm/vllm-openai:v0.11.1"]) {
      assert.deepEqual(agentSupport("claude-code", { ...MODEL, image }), { ok: true }, image);
    }
    assert.deepEqual(agentSupport("claude-code", { ...MODEL, engine: "sglang", image: "lmsysorg/sglang:v0.5.23" }), { ok: true });
    const old = agentSupport("claude-code", { ...MODEL, image: "vllm/vllm-openai:v0.10.2" });
    assert.equal(old.ok, false);
    assert.match(!old.ok ? old.reason : "", /needs vLLM 0\.11\.1 or newer for the Messages API; this model runs 0\.10\.2/);
    const oldSglang = agentSupport("claude-code", { ...MODEL, engine: "sglang", image: "lmsysorg/sglang:v0.5.8" });
    assert.match(!oldSglang.ok ? oldSglang.reason : "", /SGLang 0\.5\.9/);
  });

  it("Claude Code: not on a context too small for its prompt; the others always", () => {
    const small = { ...MODEL, context: 8192 };
    const result = agentSupport("claude-code", small);
    assert.match(!result.ok ? result.reason : "", /needs a 32k context; this model runs 8k/);
    for (const agent of ["autopilot", "opencode", "pi"] as const) assert.deepEqual(agentSupport(agent, small), { ok: true });
  });
});

describe("one-run launches on the local model", () => {
  it("Claude Code: the engine's Messages API, every role on the served model, limits, no Anthropic traffic; the person's ANTHROPIC_* left out", () => {
    const spec = claudeCodeLaunch(MODEL, FREE_TIER_ENV, ["-p", "hi"]);
    assert.equal(spec.command, "claude");
    assert.deepEqual(spec.args, ["-p", "hi"]);
    assert.equal(spec.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8000", "Claude Code adds /v1/messages itself");
    assert.equal(spec.env.ANTHROPIC_AUTH_TOKEN, LOCAL_KEY);
    assert.equal(spec.env.ANTHROPIC_API_KEY, undefined);
    for (const name of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]) {
      assert.equal(spec.env[name], "Qwen/Qwen3-4B-Instruct-2507", name);
    }
    assert.equal(spec.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "32768");
    assert.equal(spec.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "8192");
    assert.equal(spec.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
    assert.deepEqual(spec.removed.sort(), ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]);
    assert.equal(spec.env.HOME, "/home/me");
    assert.equal(spec.file, undefined, "no config file anywhere");
    assert.ok(CLAUDE_CONFLICTING_ENV.includes("CLAUDE_CODE_OAUTH_TOKEN"));
  });

  it("OpenCode: OPENCODE_CONFIG_CONTENT with an OpenAI-compatible provider at the engine, the served model and its limits", () => {
    const config = openCodeConfig(MODEL);
    assert.deepEqual(config, {
      $schema: "https://opencode.ai/config.json",
      model: `${LOCAL_PROVIDER}/Qwen/Qwen3-4B-Instruct-2507`,
      provider: { [LOCAL_PROVIDER]: { npm: "@ai-sdk/openai-compatible", name: "This box (dl model)", options: { baseURL: "http://127.0.0.1:8000/v1" },
        models: { "Qwen/Qwen3-4B-Instruct-2507": { name: "Qwen/Qwen3-4B-Instruct-2507", tool_call: true, limit: { context: 32768, output: 8192 } } } } },
    });
    const v1 = openCodeLaunch(MODEL, FREE_TIER_ENV, ["-c"], 1);
    assert.deepEqual(JSON.parse(v1.env.OPENCODE_CONFIG_CONTENT!), config, "the person's own inline config is replaced for this run");
    assert.deepEqual(v1.removed, ["OPENCODE_CONFIG_CONTENT"]);
    assert.deepEqual(v1.args, ["-c"], "OpenCode 1 rejects --standalone");
    assert.equal(v1.env.ANTHROPIC_AUTH_TOKEN, FREE_TIER_ENV.ANTHROPIC_AUTH_TOKEN, "other variables are the person's");
    assert.ok(!JSON.stringify(config).includes("directionallylocal.com"));
  });

  it("OpenCode 2: a private server (--standalone), so the shared background one doesn't ignore the config", () => {
    assert.deepEqual(openCodeLaunch(MODEL, {}, [], 2).args, ["--standalone"]);
    assert.deepEqual(openCodeLaunch(MODEL, {}, ["-c"], 2).args, ["--standalone", "-c"]);
    assert.deepEqual(openCodeLaunch(MODEL, {}, ["run", "fix it"], 2).args, ["run", "--standalone", "fix it"]);
    assert.deepEqual(openCodeLaunch(MODEL, {}, [], undefined).args, [], "unknown version: as OpenCode 1");
    assert.equal(majorVersion("1.19.6\n"), 1);
    assert.equal(majorVersion("opencode 2.3.2"), 2);
    assert.equal(majorVersion(""), undefined);
  });

  it("Pi: a one-run extension registering the engine, the served model and its limits; ~/.pi untouched", () => {
    const spec = piLaunch(MODEL, FREE_TIER_ENV, ["-c"]);
    assert.equal(spec.command, "pi");
    assert.deepEqual(spec.args, ["-e", join("{dir}", PI_EXTENSION), "--provider", LOCAL_PROVIDER, "--model", "Qwen/Qwen3-4B-Instruct-2507", "-c"]);
    assert.equal(spec.env.PI_CODING_AGENT_DIR, undefined, "the person's own agent dir, settings and sign-ins");
    assert.equal(spec.env.PI_SKIP_VERSION_CHECK, "1");
    assert.equal(spec.file?.name, PI_EXTENSION);
    const source = piExtension(MODEL);
    assert.equal(spec.file?.contents, source);
    // The extension is plain JavaScript: run its factory against a fake Pi.
    const registered: unknown[] = [];
    const factory = new Function("source", `return ${source.replace(/^\/\/.*\n/, "").replace("export default function", "function")}`)() as (pi: unknown) => void;
    factory({ registerProvider: (...args: unknown[]) => registered.push(args) });
    assert.deepEqual(registered, [[LOCAL_PROVIDER, {
      name: "This box (dl model)", baseUrl: "http://127.0.0.1:8000/v1", apiKey: LOCAL_KEY, api: "openai-completions",
      models: [{ type: "chat", id: "Qwen/Qwen3-4B-Instruct-2507", name: "Qwen/Qwen3-4B-Instruct-2507", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 8192, compat: { maxTokensField: "max_tokens" } }],
    }]]);
  });

  it("dl -c is each agent's -c; arguments pass through", () => {
    assert.deepEqual(launchSpec("claude-code", MODEL, {}, { continue: true, args: ["--verbose"] }).args, ["-c", "--verbose"]);
    assert.deepEqual(launchSpec("opencode", MODEL, {}, { continue: true, opencodeMajor: 2 }).args, ["--standalone", "-c"]);
    assert.deepEqual(launchSpec("pi", MODEL, {}, { args: ["hello"] }).args.slice(-1), ["hello"]);
  });
});

describe("launchLocalAgent", () => {
  let tmp: string;
  beforeEach(async () => { tmp = await mkdtemp(join(tmpdir(), "dl-agents-test-")); });
  afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

  const io = () => { let out = ""; let err = ""; return { io: { out: (t: string) => { out += t; }, err: (t: string) => { err += t; } }, out: () => out, err: () => err }; };
  const answering = async (url: string) => (url === "http://127.0.0.1:8000/v1/models" ? new Response("{}", { status: 200 }) : new Response("", { status: 404 }));

  /** A fake CLI: records how it was started, exits with `code` (or a signal). */
  function fakeSpawn(exit: { code?: number; signal?: NodeJS.Signals } = { code: 0 }) {
    const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: string; files: Record<string, string> }> = [];
    const spawn = (command: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string | URL }) => {
      const files: Record<string, string> = {};
      const extension = args[args.indexOf("-e") + 1];
      if (args.includes("-e") && extension) {
        files.path = extension;
        files.contents = readFileSync(extension, "utf8");
        files.mode = (statSync(extension).mode & 0o777).toString(8);
      }
      calls.push({ command, args, env: options.env ?? {}, ...(options.cwd ? { cwd: String(options.cwd) } : {}), files });
      const child = new EventEmitter() as EventEmitter & { kill: (signal?: string) => boolean };
      child.kill = () => true;
      setImmediate(() => child.emit("exit", exit.signal ? null : exit.code ?? 0, exit.signal ?? null));
      return child as unknown as ChildProcess;
    };
    return { calls, spawn };
  }
  const noSignals = () => () => {};

  it("starts the CLI from PATH with the spec, passes its exit code, removes the temporary file", async () => {
    const fake = fakeSpawn({ code: 3 });
    const out = io();
    const code = await launchLocalAgent("pi", MODEL, { continue: true }, out.io, {
      env: { PATH: "/x" }, find: async (name) => `/opt/bin/${name}`, fetch: answering, spawn: fake.spawn, onSignal: noSignals, tmp, cwd: "/work/repo",
    });
    assert.equal(code, 3);
    const [call] = fake.calls;
    assert.equal(call!.command, "/opt/bin/pi");
    assert.equal(call!.cwd, "/work/repo");
    assert.ok(call!.files.path!.startsWith(tmp));
    assert.equal(call!.files.mode, "600");
    assert.match(call!.files.contents!, /registerProvider\("dl-local"/);
    assert.equal(call!.args.at(-1), "-c");
    assert.deepEqual(await readdir(tmp), [], "the extension's directory is gone");
    assert.equal(out.err(), "");
  });

  it("a signal's exit is 128 + its number", async () => {
    const fake = fakeSpawn({ signal: "SIGTERM" });
    assert.equal(await launchLocalAgent("claude-code", MODEL, {}, io().io, { env: {}, find: async () => "/opt/bin/claude", fetch: answering, spawn: fake.spawn, onSignal: noSignals }), 143);
  });

  it("OpenCode's version decides --standalone", async () => {
    const fake = fakeSpawn();
    await launchLocalAgent("opencode", MODEL, {}, io().io, { env: {}, find: async () => "/opt/bin/opencode", fetch: answering, spawn: fake.spawn, onSignal: noSignals, version: async () => "2.3.2" });
    await launchLocalAgent("opencode", MODEL, {}, io().io, { env: {}, find: async () => "/opt/bin/opencode", fetch: answering, spawn: fake.spawn, onSignal: noSignals, version: async () => "1.19.6" });
    assert.deepEqual(fake.calls.map((call) => call.args), [["--standalone"], []]);
    assert.ok(fake.calls.every((call) => JSON.parse(call.env.OPENCODE_CONFIG_CONTENT!).provider[LOCAL_PROVIDER].options.baseURL === "http://127.0.0.1:8000/v1"));
  });

  it("not installed: the official install command, nothing started", async () => {
    const fake = fakeSpawn();
    const out = io();
    assert.equal(await launchLocalAgent("claude-code", MODEL, {}, out.io, { env: {}, find: async () => undefined, fetch: answering, spawn: fake.spawn }), 1);
    assert.match(out.err(), /Claude Code isn't installed \(no claude on PATH\)/);
    assert.match(out.err(), /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/);
    assert.match(out.err(), /dl agent set autopilot/);
    assert.equal(fake.calls.length, 0);
  });

  it("a model that isn't answering, or one the agent can't use, stops before starting it", async () => {
    const fake = fakeSpawn();
    const out = io();
    assert.equal(await launchLocalAgent("pi", MODEL, {}, out.io, { env: {}, find: async () => "/opt/bin/pi", fetch: async () => { throw new Error("ECONNREFUSED"); }, spawn: fake.spawn }), 1);
    assert.match(out.err(), /isn't answering, so Pi can't start\. See dl model status/);
    const small = io();
    assert.equal(await launchLocalAgent("claude-code", { ...MODEL, context: 8192 }, {}, small.io, { env: {}, find: async () => "/opt/bin/claude", fetch: answering, spawn: fake.spawn }), 1);
    assert.match(small.err(), /needs a 32k context/);
    assert.equal(fake.calls.length, 0);
  });

  it("says once which of the person's variables it left out; never the free tier's URL or key", async () => {
    const fake = fakeSpawn();
    const out = io();
    await launchLocalAgent("claude-code", MODEL, {}, out.io, { env: FREE_TIER_ENV, find: async () => "/opt/bin/claude", fetch: answering, spawn: fake.spawn, onSignal: noSignals });
    assert.match(out.err(), /not passing ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, ANTHROPIC_MODEL, CLAUDE_CODE_SUBAGENT_MODEL to Claude Code/);
    const env = fake.calls[0]!.env;
    assert.ok(!Object.values(env).some((value) => value === FREE_TIER_ENV.ANTHROPIC_AUTH_TOKEN || value?.includes("directionallylocal.com") || value?.includes("deepseek")));
  });

  it("which CLIs are installed", async () => {
    const installed = await installedAgents({}, async (name) => (name === "pi" ? "/opt/bin/pi" : undefined));
    assert.deepEqual(installed, { autopilot: true, "claude-code": false, opencode: false, pi: true });
    assert.equal(existsSync(join(tmp, "never")), false);
  });
});
