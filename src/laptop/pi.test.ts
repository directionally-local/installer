import { EventEmitter } from "node:events";
import { access, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { FREE_TIER_MODELS } from "./opencode.js";
import { EXTENSION_FILE, KEY_ENV, PI_COMPAT, PI_INSTALL_NPM, piArgs, piCommand, piExtension, piProvider, type PiDeps } from "./pi.js";
import { main } from "../cli.js";

const ORIGIN = "https://free.test";
const KEY = `dlh_100_abcdefabcdef_${"s".repeat(43)}`;
const DEEPSEEK = "deepseek/deepseek-v4.1-flash-1017";

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

function fakeService(options: { mintStatus?: number; mintBody?: unknown; models?: Response } = {}) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers).entries()), body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/v1/harness-keys")) return Response.json(options.mintBody ?? { id: "abcdefabcdef", key: KEY, harness: "pi", expiresAt: "x", ttlSeconds: 900, otherHarnessShare: 0.5 }, { status: options.mintStatus ?? 201 });
    if (url.endsWith("/v1/models")) return options.models ?? Response.json({ object: "list", data: FREE_TIER_MODELS.map((m) => ({ id: m.id, object: "model", name: m.name, context_window: m.contextWindow, max_output_tokens: m.maxOutputTokens, vision: m.vision })) });
    if (url.endsWith("/v1/events")) return Response.json({ accepted: 1 }, { status: 202 });
    return Response.json({ ok: true });
  };
  return { calls, fetch };
}

/** A fake `pi`: records how it was started, what its extension said then, and exits as told. */
function fakeSpawn(exit: { code?: number | null; signal?: NodeJS.Signals | null } = { code: 0 }) {
  const started: Array<{ command: string; args: string[]; options: SpawnOptions; extension: Promise<string> }> = [];
  const spawn = (command: string, args: string[], options: SpawnOptions): ChildProcess => {
    const extension = readFile(args[args.indexOf("-e") + 1]!, "utf8");
    started.push({ command, args, options, extension });
    const child = new EventEmitter() as ChildProcess;
    (child as unknown as { kill: () => boolean }).kill = () => true;
    // Exits once the extension has been read, as Pi would after loading it.
    void extension.finally(() => setImmediate(() => child.emit("exit", exit.code ?? null, exit.signal ?? null)));
    return child;
  };
  return { started, spawn };
}

async function deps(overrides: Partial<PiDeps> = {}): Promise<PiDeps> {
  return {
    env: { PATH: "/usr/bin", HOME: "/home/alice" },
    find: async () => "/usr/local/bin/pi",
    token: async () => ({ ok: true, origin: ORIGIN, accessToken: "access-1" }),
    signIn: async () => {
      throw new Error("no sign-in expected");
    },
    setInterval: () => ({}),
    terminal: false,
    clearInterval: () => undefined,
    onSignal: () => () => undefined,
    tmp: await mkdtemp(join(tmpdir(), "dl-pi-test-")),
    ...overrides,
  };
}

describe("dl pi", () => {
  it("mints a pi key, sends session.start first, and runs pi with a one-run extension, DeepSeek, the person's arguments and the key in its environment", async () => {
    const service = fakeService();
    const spawned = fakeSpawn();
    const out = capture();
    const d = await deps({ fetch: service.fetch, spawn: spawned.spawn });
    const code = await piCommand(["-p", "fix the failing test"], out.io, d);
    assert.equal(code, 0, out.err());

    const mint = service.calls.find((call) => call.url.endsWith("/v1/harness-keys"))!;
    assert.deepEqual(mint.body, { harness: "pi" });
    assert.equal(mint.headers.authorization, "Bearer access-1");
    const order = service.calls.map((call) => `${call.method} ${new URL(call.url).pathname}${call.body?.events ? ` ${call.body.events[0].type}` : ""}`);
    assert.deepEqual(order, ["POST /v1/harness-keys", "GET /v1/models", "POST /v1/events session.start", "POST /v1/events session.end", "DELETE /v1/harness-keys/abcdefabcdef"]);
    const sessionId: string = service.calls[2]!.body.events[0].sessionId;
    assert.match(sessionId, /^dl-pi-/);
    assert.equal(service.calls[2]!.body.events[0].props.harness, "pi");

    const run = spawned.started[0]!;
    assert.equal(run.command, "/usr/local/bin/pi");
    const extension = run.args[1]!;
    assert.deepEqual(run.args, ["-e", extension, "--provider", "dl", "--model", `dl/${DEEPSEEK}`, "-p", "fix the failing test"]);
    assert.equal(extension.endsWith(EXTENSION_FILE), true);
    const env = run.options.env as Record<string, string>;
    assert.equal(env[KEY_ENV], KEY);
    assert.equal(env.HOME, "/home/alice");
    assert.equal(env.PI_SKIP_VERSION_CHECK, "1");
    assert.equal(run.args.join(" ").includes(KEY), false, "the key is never on the command line");

    const text = await run.extension;
    assert.equal(text.includes(KEY), false, "the key is never in the file");
    assert.match(text, /pi\.registerProvider\("dl"/);
    assert.equal(text.includes("x-session-id"), false, "Pi sends its own session id; a static header would replace it");
    assert.match(text, /"apiKey": "\$DL_FREE_TIER_KEY"/);
    // The extension's directory is gone once Pi exits.
    assert.deepEqual(await readdir(d.tmp!), []);
    await rm(d.tmp!, { recursive: true, force: true });
  });

  it("writes the extension readable only by the person", async () => {
    const service = fakeService();
    let mode = 0;
    const d = await deps({
      fetch: service.fetch,
      spawn: (command, args, options) => {
        const child = new EventEmitter() as ChildProcess;
        void stat(args[1]!).then((s) => {
          mode = s.mode & 0o777;
          setImmediate(() => child.emit("exit", 0, null));
        });
        return child;
      },
    });
    assert.equal(await piCommand([], capture().io, d), 0);
    assert.equal(mode, 0o600);
    await rm(d.tmp!, { recursive: true, force: true });
  });

  it("leaves the provider and model to the person when they pass --model, --models or --provider", async () => {
    for (const given of [["--model", "anthropic/claude-sonnet-4-5"], ["--models=dl/*"], ["--provider", "dl", "--model", "gpt-6-luna"]]) {
      assert.deepEqual(piArgs(given, "/tmp/x.js", FREE_TIER_MODELS), ["-e", "/tmp/x.js", ...given]);
    }
    // After `--` it's a prompt, not a flag.
    assert.deepEqual(piArgs(["--", "--model"], "/tmp/x.js", FREE_TIER_MODELS).slice(2, 6), ["--provider", "dl", "--model", `dl/${DEEPSEEK}`]);
  });

  it("says once in a terminal what part of the free allowance Pi gets when that is less than all", async () => {
    const service = fakeService();
    const out = capture();
    const d = await deps({ fetch: service.fetch, spawn: fakeSpawn().spawn, terminal: true, env: { PATH: "/usr/bin", NO_COLOR: "1" } });
    assert.equal(await piCommand([], out.io, d), 0);
    assert.match(out.err(), /this agent gets 50% of your weekly free allowance/);
    assert.doesNotMatch(out.err(), /Autopilot/);
    await rm(d.tmp!, { recursive: true, force: true });
  });

  it("passes Pi's exit code through, and 128+n for a signal", async () => {
    for (const [exit, expected] of [[{ code: 3 }, 3], [{ signal: "SIGTERM" as const }, 143]] as const) {
      const d = await deps({ fetch: fakeService().fetch, spawn: fakeSpawn(exit).spawn });
      assert.equal(await piCommand([], capture().io, d), expected);
      await rm(d.tmp!, { recursive: true, force: true });
    }
  });

  it("prints the npm install command and stops when pi isn't on PATH", async () => {
    const service = fakeService();
    const out = capture();
    const d = await deps({ fetch: service.fetch, find: async () => undefined });
    assert.equal(await piCommand([], out.io, d), 1);
    assert.match(out.err(), /Pi isn't installed \(no pi on PATH\)/);
    assert.ok(out.err().includes(PI_INSTALL_NPM));
    assert.equal(PI_INSTALL_NPM, "npm install -g @earendil-works/pi-coding-agent");
    assert.equal(service.calls.length, 0);
    await rm(d.tmp!, { recursive: true, force: true });
  });

  it("stops when the service refuses the key (the kill switch)", async () => {
    const service = fakeService({ mintStatus: 403, mintBody: { error: { code: "harness_not_allowed", message: "Free tokens in Pi are switched off for now." } } });
    const out = capture();
    const d = await deps({ fetch: service.fetch, spawn: fakeSpawn().spawn });
    assert.equal(await piCommand([], out.io, d), 1);
    assert.match(out.err(), /Free tokens in Pi are switched off/);
    await rm(d.tmp!, { recursive: true, force: true });
  });

  it("is reached from main with every argument after `pi`, flags included", async () => {
    const seen: string[][] = [];
    const code = await main(["pi", "-c", "--thinking", "high"], capture().io, { pi: async (args) => (seen.push(args), 0), reportPick: () => undefined });
    assert.equal(code, 0);
    assert.deepEqual(seen, [["-c", "--thinking", "high"]]);
  });
});

/** A model the service may list for a run (GPT-6, were it opened to other agents). */
const LUNA = { id: "gpt-6-luna", name: "GPT-6 Luna", contextWindow: 1_050_000, maxOutputTokens: 128_000, vision: true };

describe("Pi's provider for a run", () => {
  it("is OpenAI-compatible at the service's /v1, with the listed models, their limits and what they can read", () => {
    const provider = piProvider({ origin: ORIGIN, models: [LUNA, ...FREE_TIER_MODELS] }) as any;
    assert.equal(provider.name, "dl", "the same provider heading as OpenCode");
    assert.equal(provider.baseUrl, `${ORIGIN}/v1`);
    assert.equal(provider.api, "openai-completions");
    assert.equal(provider.apiKey, "$DL_FREE_TIER_KEY");
    assert.deepEqual(provider.headers, { "x-dl-harness": "pi" });
    assert.equal(provider.compat, undefined, "Pi reads compat per model only");
    const deepseek = provider.models.find((model: any) => model.id === DEEPSEEK);
    assert.deepEqual(deepseek, { type: "chat", id: DEEPSEEK, name: "dl / DeepSeek V4.1 Flash (Free)", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 65_536, compat: PI_COMPAT });
    assert.equal(PI_COMPAT.sendSessionAffinityHeaders, true);
    assert.equal(PI_COMPAT.sessionAffinityFormat, "openrouter");
    assert.deepEqual(provider.models.find((model: any) => model.id === "gpt-6-luna").input, ["text", "image"]);
  });

  it("is a plain JavaScript extension Pi can load", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dl-pi-ext-"));
    const file = join(dir, "ext.mjs");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, piExtension({ origin: ORIGIN, models: FREE_TIER_MODELS }));
    const registered: Array<[string, any]> = [];
    const loaded = (await import(file)) as { default: (pi: unknown) => void };
    loaded.default({ registerProvider: (name: string, config: unknown) => registered.push([name, config]) });
    assert.equal(registered[0]![0], "dl");
    assert.equal(registered[0]![1].models.length, FREE_TIER_MODELS.length);
    await access(file);
    await rm(dir, { recursive: true, force: true });
  });

  it("falls back to the first listed model when DeepSeek isn't listed", () => {
    assert.deepEqual(piArgs([], "/x.js", [LUNA]), ["-e", "/x.js", "--provider", "dl", "--model", "dl/gpt-6-luna"]);
  });
});
