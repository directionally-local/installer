import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { FREE_TIER_MODELS } from "./opencode.js";
import { CODEX_INSTALL, choices, codexArgs, codexCommand, codexConfigToml, KEY_ENV, providerOverrides } from "./codex.js";
import type { LaunchDeps } from "./harness-launch.js";
import { main } from "../cli.js";

const ORIGIN = "https://free.test";
const KEY = `dlh_100_abcdefabcdef_${"s".repeat(43)}`;
const DL_KEY = `dl_sk_${"k".repeat(40)}`;
const DEEPSEEK = "deepseek/deepseek-v4.1-flash-1017";
const KIMI = { id: "moonshotai/kimi-k3.1-pro", name: "Kimi K3.1 Pro", contextWindow: 262_144, maxOutputTokens: 32_768, vision: false };

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

function fakeService(options: { mintStatus?: number; mintBody?: unknown } = {}) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers).entries()), body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/v1/harness-keys")) return Response.json(options.mintBody ?? { id: "abcdefabcdef", key: KEY, harness: "codex", expiresAt: "x", ttlSeconds: 900, otherHarnessShare: 1 }, { status: options.mintStatus ?? 201 });
    if (url.endsWith("/v1/models")) return Response.json({ object: "list", data: [...FREE_TIER_MODELS, KIMI].map((m) => ({ id: m.id, object: "model", name: m.name, context_window: m.contextWindow, max_output_tokens: m.maxOutputTokens, vision: m.vision })) });
    if (url.endsWith("/v1/events")) return Response.json({ accepted: 1 }, { status: 202 });
    return Response.json({ ok: true });
  };
  return { calls, fetch };
}

/** A fake `codex`: records how it was started and exits as told. */
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

function deps(overrides: Partial<LaunchDeps> = {}): LaunchDeps {
  return {
    env: { PATH: "/usr/bin", HOME: "/home/alice" },
    find: async () => "/usr/local/bin/codex",
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

/** The `-c` overrides in Codex's arguments, as key → value. */
function overrides(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== "-c") continue;
    const [key, ...value] = args[index + 1]!.split("=");
    out[key!] = value.join("=");
  }
  return out;
}

describe("dl codex", () => {
  it("mints a codex key, sends session.start first, and runs codex with dl's provider for this run, DeepSeek, the person's arguments and the key in its environment", async () => {
    const service = fakeService();
    const spawned = fakeSpawn();
    const out = capture();
    const code = await codexCommand(["exec", "fix the failing test"], out.io, deps({ fetch: service.fetch, spawn: spawned.spawn }));
    assert.equal(code, 0, out.err());

    const mint = service.calls.find((call) => call.url.endsWith("/v1/harness-keys"))!;
    assert.deepEqual(mint.body, { harness: "codex" });
    const order = service.calls.map((call) => `${call.method} ${new URL(call.url).pathname}${call.body?.events ? ` ${call.body.events[0].type}` : ""}`);
    assert.deepEqual(order, ["POST /v1/harness-keys", "GET /v1/models", "POST /v1/events session.start", "POST /v1/events session.end", "DELETE /v1/harness-keys/abcdefabcdef"]);
    assert.match(service.calls[2]!.body.events[0].sessionId, /^dl-codex-/);
    assert.equal(service.calls[2]!.body.events[0].props.harness, "codex");

    const run = spawned.started[0]!;
    assert.equal(run.command, "/usr/local/bin/codex");
    // dl's overrides first, so they reach the subcommand; the person's arguments after, as they are.
    assert.deepEqual(run.args.slice(-2), ["exec", "fix the failing test"]);
    assert.deepEqual(overrides(run.args), {
      "model_providers.dl.name": '"dl"',
      "model_providers.dl.base_url": `"${ORIGIN}/v1"`,
      "model_providers.dl.env_key": '"DL_API_KEY"',
      "model_providers.dl.env_key_instructions": '"Run Codex through dl (dl codex), or set DL_API_KEY to your key from dl.new/keys."',
      "model_providers.dl.wire_api": '"responses"',
      "model_providers.dl.http_headers": '{ "x-dl-harness" = "codex" }',
      model_provider: '"dl"',
      model: `"${DEEPSEEK}"`,
      model_context_window: "1048576",
      web_search: '"disabled"',
    });
    const env = run.options.env as Record<string, string>;
    assert.equal(env[KEY_ENV], KEY);
    assert.equal(env.HOME, "/home/alice");
    assert.ok(!("CODEX_HOME" in env), "the person's Codex home: sessions, resume and their config stay");
    assert.equal(run.args.join(" ").includes(KEY), false, "the key is never on the command line");
  });

  it("uses a dl key from dl.new as the key directly: nothing minted, no session events", async () => {
    const service = fakeService();
    const spawned = fakeSpawn();
    const out = capture();
    const code = await codexCommand([], out.io, deps({ fetch: service.fetch, spawn: spawned.spawn, token: undefined, dlKey: async () => ({ key: DL_KEY, baseUrl: "https://api.dl.new", anthropicBaseUrl: "https://api.dl.new/anthropic" }) as never }));
    assert.equal(code, 0, out.err());
    // The plan is read too, for the provider's name (dl (Plus) on a paid plan).
    assert.deepEqual(service.calls.map((call) => `${call.method} ${call.url}`).sort(), ["GET https://api.dl.new/v1/me", "GET https://api.dl.new/v1/models"]);
    const run = spawned.started[0]!;
    assert.equal((run.options.env as Record<string, string>)[KEY_ENV], DL_KEY);
    assert.equal(overrides(run.args)["model_providers.dl.base_url"], '"https://api.dl.new/v1"');
  });

  it("leaves the model, or provider and model, to the person when they choose", () => {
    for (const given of [["-m", "moonshotai/kimi-k3.1-pro"], ["--model=x"], ["-c", "model=\"x\""], ["exec", "--model", "x", "hi"]]) {
      const args = codexArgs(given, ORIGIN, FREE_TIER_MODELS);
      assert.deepEqual(args.slice(-given.length), given);
      const set = overrides(args.slice(0, -given.length));
      assert.equal(set.model_provider, '"dl"', given.join(" "));
      assert.equal(set.model, undefined, given.join(" "));
      assert.equal(set.model_context_window, undefined, given.join(" "));
    }
    for (const given of [["--oss"], ["-p", "work"], ["--profile=work"], ["-c", "model_provider=\"openai\""], ["--config", "profile=\"x\""]]) {
      const set = overrides(codexArgs(given, ORIGIN, FREE_TIER_MODELS).slice(0, -given.length));
      assert.equal(set.model_provider, undefined, given.join(" "));
      assert.equal(set.model, undefined, given.join(" "));
      assert.equal(set["model_providers.dl.wire_api"], '"responses"', "the dl provider is still there to pick");
    }
    // After `--` it's a prompt, not a flag.
    assert.deepEqual(choices(["--", "-m", "x"]), { provider: false, model: false });
  });

  it("falls back to the first listed model when DeepSeek isn't listed", () => {
    assert.equal(overrides(codexArgs([], ORIGIN, [KIMI])).model, `"${KIMI.id}"`);
  });

  it("names the provider for the plan: dl on Free, dl (Plus) on a paid plan", () => {
    assert.equal(overrides(codexArgs([], ORIGIN, FREE_TIER_MODELS))["model_providers.dl.name"], '"dl"');
    assert.equal(overrides(codexArgs([], ORIGIN, FREE_TIER_MODELS, "plus"))["model_providers.dl.name"], '"dl (Plus)"');
    assert.equal(overrides(codexArgs([], ORIGIN, FREE_TIER_MODELS, "max"))["model_providers.dl.name"], '"dl (Max)"');
    assert.equal(codexConfigToml("https://api.dl.new", DEEPSEEK, "plus").find((line) => line.startsWith("name = ")), 'name = "dl (Plus)"');
  });

  it("writes provider overrides Codex reads as TOML", () => {
    assert.ok(providerOverrides("https://api.dl.new").every((one) => /^model_providers\.dl\.[a-z_]+=("[^"\\]*"|\{ .* \})$/.test(one)));
    assert.deepEqual(codexConfigToml("https://api.dl.new", DEEPSEEK), [
      `model = "${DEEPSEEK}"`,
      'model_provider = "dl"',
      'web_search = "disabled"',
      "",
      "[model_providers.dl]",
      'name = "dl"',
      'base_url = "https://api.dl.new/v1"',
      'env_key = "DL_API_KEY"',
      'wire_api = "responses"',
    ]);
  });

  it("passes Codex's exit code through, and 128+n for a signal", async () => {
    for (const [exit, expected] of [[{ code: 3 }, 3], [{ signal: "SIGTERM" as const }, 143]] as const) {
      assert.equal(await codexCommand([], capture().io, deps({ fetch: fakeService().fetch, spawn: fakeSpawn(exit).spawn })), expected);
    }
  });

  it("prints the npm install command and stops when codex isn't on PATH", async () => {
    const service = fakeService();
    const out = capture();
    assert.equal(await codexCommand([], out.io, deps({ fetch: service.fetch, find: async () => undefined })), 1);
    assert.match(out.err(), /Codex isn't installed \(no codex on PATH\)/);
    assert.ok(out.err().includes(CODEX_INSTALL));
    assert.equal(CODEX_INSTALL, "npm install -g @openai/codex");
    assert.equal(service.calls.length, 0);
  });

  it("stops when the service refuses the key (the kill switch)", async () => {
    const service = fakeService({ mintStatus: 403, mintBody: { error: { code: "harness_not_allowed", message: "Free tokens in Codex are switched off for now." } } });
    const out = capture();
    assert.equal(await codexCommand([], out.io, deps({ fetch: service.fetch, spawn: fakeSpawn().spawn })), 1);
    assert.match(out.err(), /Free tokens in Codex are switched off/);
  });

  it("names the plan's models and how to switch, at a terminal", async () => {
    const out = capture();
    assert.equal(await codexCommand([], out.io, deps({ fetch: fakeService().fetch, spawn: fakeSpawn().spawn, terminal: true, env: { PATH: "/usr/bin", NO_COLOR: "1" } })), 0);
    assert.match(out.err(), /DeepSeek V4\.1 Flash.*Kimi K3\.1.*switch with \/model/);
  });

  it("is reached from main with every argument after `codex`, flags included", async () => {
    const seen: string[][] = [];
    const code = await main(["codex", "resume", "--last"], capture().io, { codex: async (args) => (seen.push(args), 0), recordAgentUse: async () => undefined });
    assert.equal(code, 0);
    assert.deepEqual(seen, [["resume", "--last"]]);
  });
});
