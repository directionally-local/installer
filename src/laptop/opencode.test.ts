import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  FREE_TIER_MODELS,
  KEY_ENV,
  majorVersion,
  OPENCODE_INSTALL,
  opencodeArgs,
  opencodeCommand,
  opencodeConfig,
  type OpencodeDeps,
} from "./opencode.js";
import { main } from "../cli.js";

const ORIGIN = "https://free.test";
const KEY = `dlh_100_abcdefabcdef_${"s".repeat(43)}`;

function capture() {
  let out = "";
  let err = "";
  return { io: { out: (t: string) => void (out += t), err: (t: string) => void (err += t) }, out: () => out, err: () => err };
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

/** A fake service: mints the key, lists models, takes events, refreshes and revokes. */
function fakeService(options: { mintStatus?: number; mintBody?: unknown; models?: Response } = {}) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers).entries()), body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/v1/harness-keys")) return Response.json(options.mintBody ?? { id: "abcdefabcdef", key: KEY, harness: "opencode", expiresAt: "x", ttlSeconds: 900 }, { status: options.mintStatus ?? 201 });
    if (url.endsWith("/v1/models")) return options.models ?? Response.json({ object: "list", data: FREE_TIER_MODELS.map((m) => ({ id: m.id, object: "model", name: m.name, context_window: m.contextWindow, max_output_tokens: m.maxOutputTokens, vision: m.vision })) });
    if (url.endsWith("/v1/events")) return Response.json({ accepted: 1 }, { status: 202 });
    return Response.json({ ok: true });
  };
  return { calls, fetch };
}

/** A fake `opencode`: records how it was started and exits as told. */
function fakeSpawn(exit: { code?: number | null; signal?: NodeJS.Signals | null } = { code: 0 }) {
  const started: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  const spawn = (command: string, args: string[], options: SpawnOptions): ChildProcess => {
    started.push({ command, args, options });
    const child = new EventEmitter() as ChildProcess;
    (child as unknown as { kill: () => boolean }).kill = () => true;
    setImmediate(() => child.emit("exit", exit.code ?? null, exit.signal ?? null));
    return child;
  };
  return { started, spawn };
}

function deps(overrides: Partial<OpencodeDeps> = {}): OpencodeDeps {
  return {
    env: { PATH: "/usr/bin", HOME: "/home/alice" },
    find: async () => "/usr/local/bin/opencode",
    version: async () => "2.3.1\n",
    token: async () => ({ ok: true, origin: ORIGIN, accessToken: "access-1" }),
    signIn: async () => {
      throw new Error("no sign-in expected");
    },
    setInterval: () => ({}),
    terminal: false,
    clearInterval: () => undefined,
    onSignal: () => () => undefined,
    ...overrides,
  };
}

const configOf = (options: SpawnOptions) => JSON.parse((options.env as Record<string, string>).OPENCODE_CONFIG_CONTENT!) as Record<string, any>;

describe("dl opencode", () => {
  it("mints an opencode key, sends session.start first, and runs opencode with a private server, the person's arguments, and the free tier in its environment", async () => {
    const service = fakeService();
    const child = fakeSpawn();
    let eventsAtSpawn = -1;
    const spawn = (command: string, args: string[], options: SpawnOptions) => {
      eventsAtSpawn = service.calls.filter((call) => call.url.endsWith("/v1/events")).length;
      return child.spawn(command, args, options);
    };
    const { io, err } = capture();
    const code = await opencodeCommand(["run", "fix the test", "--model", "dl/gpt-6.1-sol"], io, deps({ fetch: service.fetch, spawn }));
    assert.equal(code, 0);
    assert.equal(err(), "");

    const mint = service.calls[0]!;
    assert.deepEqual([mint.method, mint.url, mint.headers.authorization, mint.body], ["POST", `${ORIGIN}/v1/harness-keys`, "Bearer access-1", { harness: "opencode" }]);
    const models = service.calls.find((call) => call.url.endsWith("/v1/models"))!;
    assert.equal(models.headers.authorization, `Bearer ${KEY}`);
    const events = service.calls.filter((call) => call.url.endsWith("/v1/events"));
    assert.equal(eventsAtSpawn, 1, "session.start went out before OpenCode started");
    assert.deepEqual(events.map((call) => call.body.events[0].type), ["session.start", "session.end"]);
    assert.match(events[0]!.body.events[0].sessionId, /^dl-opencode-/);
    assert.equal(events[0]!.body.events[0].props.harness, "opencode");
    assert.ok(service.calls.some((call) => call.method === "DELETE" && call.url === `${ORIGIN}/v1/harness-keys/abcdefabcdef`), "the key ends with the session");

    const [run] = child.started;
    assert.equal(run!.command, "/usr/local/bin/opencode");
    assert.deepEqual(run!.args, ["--standalone", "run", "fix the test", "--model", "dl/gpt-6.1-sol"]);
    assert.equal(run!.options.stdio, "inherit");
    const env = run!.options.env as Record<string, string>;
    assert.equal(env[KEY_ENV], KEY);
    assert.equal(env.HOME, "/home/alice", "the rest of the environment passes through");
    assert.deepEqual(configOf(run!.options), opencodeConfig({ origin: ORIGIN, models: FREE_TIER_MODELS }));
    assert.ok(!run!.args.some((arg) => arg.includes(KEY)), "the key is never on the command line");
    assert.ok(!env.OPENCODE_CONFIG_CONTENT!.includes(KEY), "nor in the config: OpenCode reads it from the environment");
  });

  it("says once, dimmed, in a terminal that Autopilot gets 2× the free allowance; nothing when piped", async () => {
    const mintBody = { id: "abcdefabcdef", key: KEY, harness: "opencode", expiresAt: "x", ttlSeconds: 900, otherHarnessShare: 0.5 };
    const shown = capture();
    assert.equal(await opencodeCommand([], shown.io, deps({ fetch: fakeService({ mintBody }).fetch, spawn: fakeSpawn().spawn, terminal: true })), 0);
    assert.equal(shown.err(), "  \x1b[2mFree tokens: Autopilot gets 2× the allowance of other agents. Just type dl.\x1b[22m\n");
    const piped = capture();
    assert.equal(await opencodeCommand([], piped.io, deps({ fetch: fakeService({ mintBody }).fetch, spawn: fakeSpawn().spawn })), 0);
    assert.equal(piped.err(), "");
  });

  it("passes OpenCode's exit code through, and 128+n for a signal", async () => {
    for (const [exit, expected] of [[{ code: 4 }, 4], [{ code: null, signal: "SIGTERM" as const }, 143]] as const) {
      assert.equal(await opencodeCommand([], capture().io, deps({ fetch: fakeService().fetch, spawn: fakeSpawn(exit).spawn })), expected);
    }
  });

  it("gives OpenCode 1 (no shared server, no --standalone) the person's arguments as they are", async () => {
    const child = fakeSpawn();
    await opencodeCommand(["--continue"], capture().io, deps({ version: async () => "1.14.3", fetch: fakeService().fetch, spawn: child.spawn }));
    assert.deepEqual(child.started[0]!.args, ["--continue"]);
  });

  it("refuses --server, whose server dl can't configure, and ends the key", async () => {
    const service = fakeService();
    const child = fakeSpawn();
    const { io, err } = capture();
    assert.equal(await opencodeCommand(["--server", "http://localhost:4096"], io, deps({ fetch: service.fetch, spawn: child.spawn })), 1);
    assert.match(err(), /can't use --server/);
    assert.equal(child.started.length, 0);
    assert.ok(service.calls.some((call) => call.method === "DELETE"));
  });

  it("replaces the person's OPENCODE_CONFIG_CONTENT for this run only, and says so", async () => {
    const child = fakeSpawn();
    const parent = { PATH: "/usr/bin", OPENCODE_CONFIG_CONTENT: '{"model":"anthropic/x"}', OPENCODE_CONFIG: "/home/alice/oc.json" };
    const { io, err } = capture();
    await opencodeCommand([], io, deps({ env: parent, fetch: fakeService().fetch, spawn: child.spawn }));
    const env = child.started[0]!.options.env as Record<string, string>;
    assert.equal(configOf(child.started[0]!.options).model, "dl/deepseek/deepseek-v4.1-flash-1017");
    assert.equal(env.OPENCODE_CONFIG, "/home/alice/oc.json", "their config file still loads, below dl's");
    assert.equal(parent.OPENCODE_CONFIG_CONTENT, '{"model":"anthropic/x"}', "dl's own environment is unchanged");
    assert.equal(err(), "  dl opencode: not passing OPENCODE_CONFIG_CONTENT to OpenCode for this session (it runs on dl's free tier).\n");
  });

  it("uses the built-in model list when the service's can't be read", async () => {
    const child = fakeSpawn();
    await opencodeCommand([], capture().io, deps({ fetch: fakeService({ models: new Response("nope", { status: 500 }) }).fetch, spawn: child.spawn }));
    assert.deepEqual(Object.keys(configOf(child.started[0]!.options).provider.dl.models), FREE_TIER_MODELS.map((model) => model.id));
  });

  it("prints the official install command and stops when opencode isn't on PATH", async () => {
    const service = fakeService();
    const child = fakeSpawn();
    const { io, err } = capture();
    assert.equal(await opencodeCommand([], io, deps({ find: async () => undefined, fetch: service.fetch, spawn: child.spawn })), 1);
    assert.ok(err().includes("OpenCode isn't installed (no opencode on PATH)"));
    assert.ok(err().includes(OPENCODE_INSTALL));
    assert.equal(service.calls.length, 0);
    assert.equal(child.started.length, 0);
  });

  it("runs the free tier sign-in first when not signed in, and stops if it fails", async () => {
    let signedIn = false;
    const child = fakeSpawn();
    const { io, out } = capture();
    const code = await opencodeCommand([], io, deps({
      token: async () => (signedIn ? { ok: true, origin: ORIGIN, accessToken: "access-2" } : { ok: false, reason: "signed_out" }),
      signIn: async () => (signedIn = true),
      fetch: fakeService().fetch,
      spawn: child.spawn,
    }));
    assert.equal(code, 0);
    assert.match(out(), /dl opencode uses your free tier sign-in\. Signing in first/);
    assert.equal(child.started.length, 1);

    const failed = capture();
    assert.equal(await opencodeCommand([], failed.io, deps({ token: async () => ({ ok: false, reason: "signed_out" }), signIn: async () => false, spawn: child.spawn })), 1);
    assert.match(failed.err(), /so dl opencode can't start/);
    assert.equal(child.started.length, 1);
  });

  it("stops when the service refuses the key (the kill switch)", async () => {
    const child = fakeSpawn();
    const { io, err } = capture();
    const refused = fakeService({ mintStatus: 403, mintBody: { error: { code: "harness_not_allowed", message: "Free tokens in OpenCode are switched off for now." } } });
    assert.equal(await opencodeCommand([], io, deps({ fetch: refused.fetch, spawn: child.spawn })), 1);
    assert.match(err(), /switched off for now/);
    assert.equal(child.started.length, 0);
  });

  it("never reads or writes OpenCode's config files", async () => {
    const home = await mkdtemp(join(tmpdir(), "dl-opencode-home-"));
    try {
      const own = join(home, ".config", "opencode");
      await mkdir(own, { recursive: true });
      await writeFile(join(own, "opencode.json"), '{"model":"anthropic/x"}');
      await opencodeCommand([], capture().io, deps({ env: { PATH: "/usr/bin", HOME: home, XDG_CONFIG_HOME: join(home, ".config") }, fetch: fakeService().fetch, spawn: fakeSpawn().spawn }));
      assert.deepEqual(await readdir(home), [".config"]);
      assert.deepEqual(await readdir(own), ["opencode.json"]);
      assert.equal(await readFile(join(own, "opencode.json"), "utf8"), '{"model":"anthropic/x"}');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("is reached from main with every argument after `opencode`, flags included", async () => {
    let got: string[] | undefined;
    const code = await main(["opencode", "--continue", "-m", "dl/gpt-6-astra", "--help"], capture().io, { opencode: async (args) => ((got = args), 5) });
    assert.equal(code, 5);
    assert.deepEqual(got, ["--continue", "-m", "dl/gpt-6-astra", "--help"]);
  });
});

/** A model the service may list for a run (GPT-6, were it opened to other agents). */
const LUNA = { id: "gpt-6-luna", name: "GPT-6 Luna", contextWindow: 1_050_000, maxOutputTokens: 128_000, vision: true };

describe("OpenCode's config for a run", () => {
  it("adds an OpenAI-compatible provider \"dl\" at the service's /v1 with the models the service lists, DeepSeek V4.1 Flash by default", () => {
    const config = opencodeConfig({ origin: ORIGIN, models: [LUNA, ...FREE_TIER_MODELS] });
    assert.equal(config.$schema, "https://opencode.ai/config.json");
    assert.equal(config.model, "dl/deepseek/deepseek-v4.1-flash-1017");
    assert.equal(config.small_model, "dl/deepseek/deepseek-v4.1-flash-1017");
    const provider = (config.provider as Record<string, any>).dl;
    assert.equal(provider.npm, "@ai-sdk/openai-compatible");
    assert.deepEqual(provider.options, { baseURL: `${ORIGIN}/v1`, apiKey: `{env:${KEY_ENV}}`, includeUsage: true });
    assert.deepEqual(provider.models["gpt-6-luna"], { name: "GPT-6 Luna", tool_call: true, attachment: true, modalities: { input: ["text", "image"], output: ["text"] }, limit: { context: 1_050_000, output: 128_000 } });
    assert.deepEqual(provider.models["deepseek/deepseek-v4.1-flash-1017"], { name: "DeepSeek V4.1 Flash 1017", tool_call: true, attachment: false, modalities: { input: ["text"], output: ["text"] }, limit: { context: 1_048_576, output: 65_536 } });
    assert.deepEqual(Object.keys(provider.models), ["gpt-6-luna", "deepseek/deepseek-v4.1-flash-1017"]);
  });

  it("falls back to the first model when DeepSeek isn't listed", () => {
    const config = opencodeConfig({ origin: ORIGIN, models: [LUNA] });
    assert.equal(config.model, "dl/gpt-6-luna");
    assert.equal(config.small_model, "dl/gpt-6-luna");
  });

  it("keeps the built-in list in step with the service's models other agents get (no GPT-6: Autopilot only)", async () => {
    // Read at run time: the service is outside dl's TypeScript project.
    const service = new URL("../../services/free/src/models.ts", import.meta.url).href;
    const { FREE_MODELS, DEFAULT_MODEL } = (await import(service)) as {
      FREE_MODELS: Array<{ id: string; name: string; contextWindow: number; maxOutputTokens: number; vision: boolean; provider: string; family: string }>;
      DEFAULT_MODEL: string;
    };
    // Not a registry provider's (opt-in) models: they serve only while that provider has a key
    // and is on, so dl offers them only when the service's /v1/models lists them.
    const { isRegistryProvider } = (await import(new URL("../../services/free/src/providers.ts", import.meta.url).href)) as { isRegistryProvider(value: unknown): boolean };
    assert.deepEqual(
      FREE_TIER_MODELS,
      FREE_MODELS.filter((model) => !isRegistryProvider(model.provider) && model.family !== "gpt6").map((model) => ({ id: model.id, name: model.name, contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens, vision: model.vision })),
    );
    assert.equal(DEFAULT_MODEL, "gpt-6-luna");
    assert.ok(FREE_TIER_MODELS.every((model) => !model.id.startsWith("gpt-")), "no GPT-6 in dl's built-in list");
  });

  it("reads OpenCode's major version, and adds --standalone on 2 or an unknown version only", () => {
    assert.equal(majorVersion("2.3.1\n"), 2);
    assert.equal(majorVersion("opencode 1.14.3"), 1);
    assert.equal(majorVersion(""), undefined);
    assert.deepEqual(opencodeArgs(["-c"], 2), ["--standalone", "-c"]);
    assert.deepEqual(opencodeArgs(["-c"], undefined), ["--standalone", "-c"]);
    assert.deepEqual(opencodeArgs(["--standalone"], 2), ["--standalone"]);
    assert.deepEqual(opencodeArgs(["-c"], 1), ["-c"]);
  });
});
