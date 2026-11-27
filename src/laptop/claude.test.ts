import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { CLAUDE_INSTALL, CLAUDE_MODEL, CLAUDE_OPUS_KIMI, UNRECOGNIZED_MODEL_PREFIX, claudeCommand, claudeEnv, claudeModelsLine, claudePrintMode, type ClaudeDeps } from "./claude.js";
import { FREE_TIER_MODELS } from "./opencode.js";
import { diverter } from "./harness-launch.js";
import { freeTierAccessToken } from "./free-tier-token.js";
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

/** A fake service: mints the key, takes events, refreshes and revokes; records every call. */
function fakeService(mintStatus = 201, mintBody: unknown = { id: "abcdefabcdef", key: KEY, harness: "claude-code", expiresAt: "x", ttlSeconds: 900 }) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers).entries()), body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/v1/harness-keys")) return Response.json(mintBody, { status: mintStatus });
    if (url.endsWith("/v1/events")) return Response.json({ accepted: 1 }, { status: 202 });
    return Response.json({ ok: true });
  };
  return { calls, fetch };
}

/** A fake `claude`: records how it was started and exits as told. */
function fakeSpawn(exit: { code?: number | null; signal?: NodeJS.Signals | null } = { code: 0 }) {
  const started: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  const killed: string[] = [];
  const spawn = (command: string, args: string[], options: SpawnOptions): ChildProcess => {
    started.push({ command, args, options });
    const child = new EventEmitter() as ChildProcess;
    (child as unknown as { kill: (signal: string) => boolean }).kill = (signal: string) => {
      killed.push(signal);
      return true;
    };
    setImmediate(() => child.emit("exit", exit.code ?? null, exit.signal ?? null));
    return child;
  };
  return { started, killed, spawn };
}

function deps(overrides: Partial<ClaudeDeps> = {}): ClaudeDeps {
  return {
    env: { PATH: "/usr/bin", HOME: "/home/alice" },
    cwd: "/nonexistent/dl-claude-test",
    findClaude: async () => "/usr/local/bin/claude",
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

describe("dl claude", () => {
  it("refuses to start, before signing in, when Claude Code's settings set an Anthropic key; DL_ALLOW_CLAUDE_SETTINGS_KEY=1 starts anyway", async () => {
    const home = await mkdtemp(join(tmpdir(), "dl-claude-settings-"));
    try {
      await mkdir(join(home, ".claude"), { recursive: true });
      await writeFile(join(home, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "sk-ant-oat-secret" } }));
      const service = fakeService();
      const child = fakeSpawn({ code: 0 });
      const { io, err } = capture();
      let asked = false;
      const env = { PATH: "/usr/bin", HOME: home };
      const code = await claudeCommand(["-p", "hi"], io, deps({ env, fetch: service.fetch, spawn: child.spawn, token: async () => ((asked = true), { ok: true, origin: ORIGIN, accessToken: "access-1" }) }));
      assert.equal(code, 1);
      assert.equal(asked, false, "no sign-in, no key minted");
      assert.equal(service.calls.length, 0);
      assert.equal(child.started.length, 0);
      assert.match(err(), /dl claude won't start Claude Code/);
      assert.match(err(), /~\/\.claude\/settings\.json: env\.ANTHROPIC_AUTH_TOKEN/);
      assert.match(err(), /DL_ALLOW_CLAUDE_SETTINGS_KEY=1/);
      assert.doesNotMatch(err(), /sk-ant-oat-secret/);

      const allowed = await claudeCommand(["-p", "hi"], capture().io, deps({ env: { ...env, DL_ALLOW_CLAUDE_SETTINGS_KEY: "1" }, fetch: service.fetch, spawn: child.spawn }));
      assert.equal(allowed, 0);
      assert.equal(child.started.length, 1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("opted out (DL_NO_TELEMETRY, DO_NOT_TRACK or CI): only the bare session.start the dl-only check needs", async () => {
    for (const optOut of [{ DL_NO_TELEMETRY: "1" }, { DO_NOT_TRACK: "yes" }, { CI: "true" }]) {
      const service = fakeService();
      const code = await claudeCommand(["-p", "hi"], capture().io, deps({ fetch: service.fetch, spawn: fakeSpawn({ code: 0 }).spawn, env: { PATH: "/usr/bin", HOME: "/home/alice", ...optOut } }));
      assert.equal(code, 0);
      const events = service.calls.filter((call) => call.url.endsWith("/v1/events")).map((call) => call.body.events[0]);
      assert.deepEqual(events.map((event) => event.type), ["session.start"], JSON.stringify(optOut));
      assert.deepEqual(events[0].props, {});
      assert.ok(service.calls.some((call) => call.method === "DELETE"), "the key is still revoked");
    }
    // Not an opt-out: empty, 0 or false.
    const service = fakeService();
    await claudeCommand(["-p", "hi"], capture().io, deps({ fetch: service.fetch, spawn: fakeSpawn({ code: 0 }).spawn, env: { PATH: "/usr/bin", HOME: "/home/alice", DL_NO_TELEMETRY: "0", DO_NOT_TRACK: "false", CI: "" } }));
    assert.deepEqual(service.calls.filter((call) => call.url.endsWith("/v1/events")).map((call) => call.body.events[0].type), ["session.start", "session.end"]);
  });

  it("mints a harness key, sends session.start before Claude Code starts, runs claude with every argument and the free tier env, then ends the session", async () => {
    const service = fakeService();
    const child = fakeSpawn({ code: 0 });
    let eventsAtSpawn = -1;
    const spawn = (command: string, args: string[], options: SpawnOptions) => {
      eventsAtSpawn = service.calls.filter((call) => call.url.endsWith("/v1/events")).length;
      return child.spawn(command, args, options);
    };
    const { io, err } = capture();
    const code = await claudeCommand(["-p", "fix the bug", "--model", "opus", "--", "x"], io, deps({ fetch: service.fetch, spawn }));
    assert.equal(code, 0);
    assert.equal(err(), "");

    const [mint, start, end, revoke] = service.calls;
    assert.deepEqual([mint!.method, mint!.url, mint!.headers.authorization, mint!.body], ["POST", `${ORIGIN}/v1/harness-keys`, "Bearer access-1", { harness: "claude-code" }]);
    assert.equal(start!.url, `${ORIGIN}/v1/events`);
    assert.equal(start!.headers.authorization, `Bearer ${KEY}`, "events go as the harness key");
    assert.equal(start!.body.events[0].type, "session.start");
    assert.match(start!.body.events[0].sessionId, /^dl-claude-/);
    assert.equal(start!.body.events[0].props.harness, "claude-code");
    assert.equal(eventsAtSpawn, 1, "session.start went out before Claude Code started");
    const ends = [end!, revoke!].sort((a, b) => a.method.localeCompare(b.method));
    assert.deepEqual([ends[0]!.method, ends[0]!.url], ["DELETE", `${ORIGIN}/v1/harness-keys/abcdefabcdef`]);
    assert.equal(ends[1]!.body.events[0].type, "session.end");
    assert.equal(ends[1]!.body.events[0].sessionId, start!.body.events[0].sessionId);
    assert.equal(ends[1]!.body.events[0].props.exitReason, "exit");

    const [run] = child.started;
    assert.equal(run!.command, "/usr/local/bin/claude");
    assert.deepEqual(run!.args, ["-p", "fix the bug", "--model", "opus", "--", "x"]);
    assert.deepEqual(run!.options.stdio, ["inherit", "pipe", "inherit"], "print mode: stdout goes through dl, for Claude Code's diagnostic line");
    const env = run!.options.env as Record<string, string>;
    assert.deepEqual(
      Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith("ANTHROPIC_") || name.startsWith("CLAUDE_CODE_"))),
      {
        ANTHROPIC_BASE_URL: `${ORIGIN}/anthropic`,
        ANTHROPIC_AUTH_TOKEN: KEY,
        ANTHROPIC_MODEL: CLAUDE_MODEL,
        ANTHROPIC_DEFAULT_OPUS_MODEL: CLAUDE_MODEL,
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "DeepSeek V4.1 Flash",
        ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION: "On your dl plan",
        ANTHROPIC_DEFAULT_SONNET_MODEL: CLAUDE_MODEL,
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "DeepSeek V4.1 Flash",
        ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION: "On your dl plan",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: CLAUDE_MODEL,
        ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: "DeepSeek V4.1 Flash",
        ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION: "On your dl plan",
        ANTHROPIC_SMALL_FAST_MODEL: CLAUDE_MODEL,
        CLAUDE_CODE_SUBAGENT_MODEL: CLAUDE_MODEL,
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1048576",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
      },
    );
    assert.equal(env.HOME, "/home/alice", "the rest of the environment passes through");
    assert.ok(!run!.args.some((arg) => arg.includes(KEY)), "the key is never on the command line");
  });

  it("passes Claude Code's exit code through, and 128+n for a signal", async () => {
    for (const [exit, expected] of [[{ code: 3 }, 3], [{ code: null, signal: "SIGTERM" as const }, 143]] as const) {
      const code = await claudeCommand([], capture().io, deps({ fetch: fakeService().fetch, spawn: fakeSpawn(exit).spawn }));
      assert.equal(code, expected);
    }
  });

  it("says once, dimmed, before Claude Code starts in a terminal, what part of the free allowance it gets when that is less than all", async () => {
    const mint = { id: "abcdefabcdef", key: KEY, harness: "claude-code", expiresAt: "x", ttlSeconds: 900, otherHarnessShare: 0.5 };
    const { io, err } = capture();
    let errAtSpawn = "";
    const child = fakeSpawn();
    const spawn = (command: string, args: string[], options: SpawnOptions) => {
      errAtSpawn = err();
      return child.spawn(command, args, options);
    };
    assert.equal(await claudeCommand([], io, deps({ fetch: fakeService(201, mint).fetch, spawn, terminal: true })), 0);
    assert.equal(errAtSpawn, "  \x1b[2mModel on your plan: DeepSeek V4.1 Flash\x1b[22m\n  \x1b[2mFree tokens: this agent gets 50% of your weekly free allowance.\x1b[22m\n");
    assert.equal(err(), errAtSpawn, "the plan's model and the share, before Claude Code starts");

    // NO_COLOR: the same line, plain.
    const plain = capture();
    await claudeCommand([], plain.io, deps({ env: { PATH: "/usr/bin", NO_COLOR: "1" }, fetch: fakeService(201, mint).fetch, spawn: fakeSpawn().spawn, terminal: true }));
    assert.equal(plain.err(), "  Model on your plan: DeepSeek V4.1 Flash\n  Free tokens: this agent gets 50% of your weekly free allowance.\n");
  });

  it("states another share plainly, and leaves the line out at the whole allowance or when the service sends none", async () => {
    const run = async (extra: Record<string, unknown>) => {
      const { io, err } = capture();
      const mint = { id: "abcdefabcdef", key: KEY, harness: "claude-code", expiresAt: "x", ttlSeconds: 900, ...extra };
      await claudeCommand([], io, deps({ env: { PATH: "/usr/bin", NO_COLOR: "1" }, fetch: fakeService(201, mint).fetch, spawn: fakeSpawn().spawn, terminal: true }));
      return err();
    };
    const model = "  Model on your plan: DeepSeek V4.1 Flash\n";
    assert.equal(await run({ otherHarnessShare: 0.25 }), `${model}  Free tokens: this agent gets 25% of your weekly free allowance.\n`);
    assert.equal(await run({}), model);
    assert.equal(await run({ otherHarnessShare: 1 }), model);
  });

  it("shows no allowance line when the output isn't a terminal, or when the free tier refuses", async () => {
    const mint = { id: "abcdefabcdef", key: KEY, harness: "claude-code", expiresAt: "x", ttlSeconds: 900, otherHarnessShare: 0.5 };
    const piped = capture();
    assert.equal(await claudeCommand([], piped.io, deps({ fetch: fakeService(201, mint).fetch, spawn: fakeSpawn().spawn, terminal: false })), 0);
    assert.equal(piped.err(), "");

    const refused = capture();
    const body = { error: { code: "harness_not_allowed", message: "Free tokens in Claude Code are switched off for now." } };
    assert.equal(await claudeCommand([], refused.io, deps({ fetch: fakeService(403, body).fetch, spawn: fakeSpawn().spawn, terminal: true })), 1);
    assert.doesNotMatch(refused.err(), /Free tokens: this agent gets/);
  });

  it("refreshes the key while Claude Code runs, and forwards SIGTERM to it", async () => {
    const service = fakeService();
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const handlers = new Map<string, () => void>();
    let child: ReturnType<typeof fakeSpawn> | undefined;
    const spawn = (command: string, args: string[], options: SpawnOptions) => {
      // While Claude Code runs: the timers fire, then SIGTERM arrives.
      for (const timer of timers) timer.fn();
      queueMicrotask(() => handlers.get("SIGTERM")!());
      return child!.spawn(command, args, options);
    };
    child = fakeSpawn({ code: null, signal: "SIGTERM" });
    await claudeCommand([], capture().io, deps({
      fetch: service.fetch,
      spawn,
      setInterval: (fn, ms) => {
        timers.push({ fn, ms });
        return {};
      },
      onSignal: (signal, handler) => {
        handlers.set(signal, handler);
        return () => handlers.delete(signal);
      },
    }));
    assert.deepEqual(timers.map((timer) => timer.ms).sort((a, b) => a - b), [4 * 60_000, 6 * 3600_000]);
    assert.ok(service.calls.some((call) => call.method === "POST" && call.url === `${ORIGIN}/v1/harness-keys/abcdefabcdef/refresh` && call.headers.authorization === `Bearer ${KEY}`));
    assert.deepEqual(child.killed, ["SIGTERM"]);
    assert.ok(handlers.has("SIGINT") === false, "handlers are removed after Claude Code exits");
  });

  it("leaves the person's ANTHROPIC_* variables out of Claude Code's environment only, and says so once", async () => {
    const child = fakeSpawn();
    const parent = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-mine", ANTHROPIC_BASE_URL: "https://proxy.example", CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_BETAS: "x" };
    const { io, err } = capture();
    await claudeCommand([], io, deps({ env: parent, fetch: fakeService().fetch, spawn: child.spawn }));
    const env = child.started[0]!.options.env as Record<string, string | undefined>;
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
    assert.equal(env.ANTHROPIC_BASE_URL, `${ORIGIN}/anthropic`);
    assert.equal(env.ANTHROPIC_BETAS, "x");
    assert.equal(parent.ANTHROPIC_API_KEY, "sk-ant-mine", "dl's own environment is unchanged");
    assert.equal(err(), "  dl claude: not passing ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, CLAUDE_CODE_USE_BEDROCK to Claude Code for this session (it runs on dl's free tier).\n");
    assert.ok(!err().includes("sk-ant-mine"));
  });

  it("prints the official install command and stops when claude isn't on PATH", async () => {
    const service = fakeService();
    const child = fakeSpawn();
    const { io, err } = capture();
    const code = await claudeCommand([], io, deps({ findClaude: async () => undefined, fetch: service.fetch, spawn: child.spawn }));
    assert.equal(code, 1);
    assert.ok(err().includes(CLAUDE_INSTALL));
    assert.equal(service.calls.length, 0);
    assert.equal(child.started.length, 0);
  });

  it("runs the free tier sign-in first when not signed in, then carries on", async () => {
    let signedIn = false;
    const child = fakeSpawn();
    const { io, out } = capture();
    const code = await claudeCommand([], io, deps({
      token: async () => (signedIn ? { ok: true, origin: ORIGIN, accessToken: "access-2" } : { ok: false, reason: "signed_out" }),
      signIn: async () => (signedIn = true),
      fetch: fakeService().fetch,
      spawn: child.spawn,
    }));
    assert.equal(code, 0);
    assert.match(out(), /Signing in first/);
    assert.equal(child.started.length, 1);
  });

  it("stops without starting Claude Code when sign-in fails or the service refuses the key", async () => {
    const child = fakeSpawn();
    const { io, err } = capture();
    assert.equal(await claudeCommand([], io, deps({ token: async () => ({ ok: false, reason: "signed_out" }), signIn: async () => false, spawn: child.spawn })), 1);
    const refused = fakeService(403, { error: { code: "harness_not_allowed", message: "Free tokens in Claude Code are switched off for now." } });
    assert.equal(await claudeCommand([], io, deps({ fetch: refused.fetch, spawn: child.spawn })), 1);
    assert.match(err(), /switched off for now/);
    assert.equal(child.started.length, 0);
  });

  it("never touches ~/.claude", async () => {
    const home = await mkdtemp(join(tmpdir(), "dl-claude-home-"));
    try {
      await claudeCommand([], capture().io, deps({ env: { PATH: "/usr/bin", HOME: home }, fetch: fakeService().fetch, spawn: fakeSpawn().spawn }));
      assert.deepEqual(await readdir(home), []);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("is reached from main with every argument after `claude`, flags included", async () => {
    let got: string[] | undefined;
    const code = await main(["claude", "--resume", "-p", "hi", "--help"], capture().io, { claude: async (args) => ((got = args), 7), reportPick: () => undefined });
    assert.equal(code, 7);
    assert.deepEqual(got, ["--resume", "-p", "hi", "--help"]);
  });
});

describe("Claude Code's [claude-code:unrecognized_model] line", () => {
  const LINE = `${UNRECOGNIZED_MODEL_PREFIX} {"model":"${CLAUDE_MODEL}","query_source":"sdk"}\n`;

  /** A fake `claude -p` that prints `chunks` on its piped stdout, then exits. */
  function printingSpawn(chunks: string[]) {
    const started: SpawnOptions[] = [];
    const spawn = (_command: string, _args: string[], options: SpawnOptions): ChildProcess => {
      started.push(options);
      const child = new EventEmitter() as ChildProcess;
      (child as unknown as { kill: () => boolean }).kill = () => true;
      const stdout = new PassThrough();
      if (Array.isArray(options.stdio) && options.stdio[1] === "pipe") (child as unknown as { stdout: PassThrough }).stdout = stdout;
      setImmediate(() => {
        for (const chunk of chunks) stdout.write(chunk);
        stdout.end();
        child.emit("exit", 0, null);
      });
      return child;
    };
    return { started, spawn };
  }

  it("goes to stderr in print mode; stdout is only the answer", async () => {
    const child = printingSpawn([LINE.slice(0, 10), LINE.slice(10) + "o", "k\n"]);
    const { io, out, err } = capture();
    assert.equal(await claudeCommand(["-p", "say ok"], io, deps({ fetch: fakeService().fetch, spawn: child.spawn, stdoutIsTerminal: true })), 0);
    assert.equal(out(), "ok\n");
    assert.match(err(), /\[claude-code:unrecognized_model\] \{"model"/);
  });

  it("goes to stderr when a script reads stdout, -p or not", async () => {
    const child = printingSpawn([LINE, "answer\n"]);
    const { io, out } = capture();
    assert.equal(await claudeCommand(["--output-format", "json"], io, deps({ fetch: fakeService().fetch, spawn: child.spawn, stdoutIsTerminal: false })), 0);
    assert.equal(out(), "answer\n");
  });

  it("leaves an interactive Claude Code the terminal", async () => {
    const child = printingSpawn([]);
    assert.equal(await claudeCommand([], capture().io, deps({ fetch: fakeService().fetch, spawn: child.spawn, stdoutIsTerminal: true })), 0);
    assert.equal(child.started[0]!.stdio, "inherit");
    assert.equal(claudePrintMode(["--print"], true), true);
    assert.equal(claudePrintMode(["--model", "opus"], true), false);
  });

  it("passes other lines through as they come, however they're split", () => {
    let out = "";
    let err = "";
    const lines = diverter(UNRECOGNIZED_MODEL_PREFIX, (t) => void (out += t), (t) => void (err += t));
    lines.write("hel");
    assert.equal(out, "hel", "a line that can't be the diagnostic isn't held back");
    lines.write("lo\n[claude");
    assert.equal(out, "hello\n", "a line that might be is held");
    lines.write("-code:unrecognized_model] {}\n[claude is fine\n\n");
    lines.write("tail");
    lines.end();
    assert.equal(out, "hello\n[claude is fine\n\ntail");
    assert.equal(err, "[claude-code:unrecognized_model] {}\n");
  });
});

describe("claudeEnv", () => {
  const KIMI = { id: CLAUDE_OPUS_KIMI, name: "Kimi K3.1 Pro", contextWindow: 1_048_576, maxOutputTokens: 131_072, vision: true };
  const role = (env: Record<string, string | undefined>) => ({
    model: env.ANTHROPIC_MODEL,
    opus: [env.ANTHROPIC_DEFAULT_OPUS_MODEL, env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME],
    sonnet: [env.ANTHROPIC_DEFAULT_SONNET_MODEL, env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME],
    haiku: [env.ANTHROPIC_DEFAULT_HAIKU_MODEL, env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME],
    small: env.ANTHROPIC_SMALL_FAST_MODEL,
    subagents: env.CLAUDE_CODE_SUBAGENT_MODEL,
  });

  it("on a plan with Kimi (Plus, Max): Opus is Kimi K3.1, Sonnet, Haiku and background work DeepSeek, starting on Sonnet", () => {
    const { env } = claudeEnv({}, { origin: ORIGIN, key: KEY, models: [...FREE_TIER_MODELS, KIMI] });
    assert.deepEqual(role(env), {
      model: "sonnet",
      opus: [CLAUDE_OPUS_KIMI, "Kimi K3.1"],
      sonnet: [CLAUDE_MODEL, "DeepSeek V4.1 Flash"],
      haiku: [CLAUDE_MODEL, "DeepSeek V4.1 Flash"],
      small: CLAUDE_MODEL,
      subagents: CLAUDE_MODEL,
    });
    assert.match(env.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION!, /smaller weekly limit/);
    assert.equal(claudeModelsLine([...FREE_TIER_MODELS, KIMI]), "Models on your plan: DeepSeek V4.1 Flash (Sonnet), Kimi K3.1 (Opus) — switch with /model");
  });

  it("on Free and Starter (no Kimi in the key's models, or none given): every role DeepSeek", () => {
    for (const models of [FREE_TIER_MODELS, undefined]) {
      const { env } = claudeEnv({}, { origin: ORIGIN, key: KEY, ...(models ? { models } : {}) });
      assert.deepEqual(role(env), { model: CLAUDE_MODEL, opus: [CLAUDE_MODEL, "DeepSeek V4.1 Flash"], sonnet: [CLAUDE_MODEL, "DeepSeek V4.1 Flash"], haiku: [CLAUDE_MODEL, "DeepSeek V4.1 Flash"], small: CLAUDE_MODEL, subagents: CLAUDE_MODEL });
    }
    assert.equal(claudeModelsLine(FREE_TIER_MODELS), "Model on your plan: DeepSeek V4.1 Flash");
  });

  it("dl claude on a dl key reads the key's /v1/models: a Plus key gets Kimi as Opus and the line, a failed lookup DeepSeek only", async () => {
    const models = (data: unknown, status = 200) => async (url: string): Promise<Response> =>
      url.endsWith("/v1/models") ? Response.json(data, { status }) : Response.json({ ok: true });
    const run = async (fetch: (url: string) => Promise<Response>) => {
      const child = fakeSpawn({ code: 0 });
      const out = capture();
      await claudeCommand([], out.io, deps({
        env: { PATH: "/usr/bin", NO_COLOR: "1" },
        dlKey: async () => ({ key: "dl_sk_0123456789abcdef", plan: "plus", baseUrl: "https://api.dl.new", anthropicBaseUrl: "https://api.dl.new/anthropic", savedAt: "" }),
        fetch,
        spawn: child.spawn,
        terminal: true,
      }));
      return { env: child.started[0]!.options.env as Record<string, string>, err: out.err() };
    };
    const plus = await run(models({ data: [
      { id: CLAUDE_MODEL, name: "DeepSeek V4.1 Flash 1017", context_window: 1_048_576, max_output_tokens: 65_536 },
      { id: CLAUDE_OPUS_KIMI, name: "Kimi K3.1 Pro", context_window: 1_048_576, max_output_tokens: 131_072, vision: true },
    ] }));
    assert.equal(plus.env.ANTHROPIC_DEFAULT_OPUS_MODEL, CLAUDE_OPUS_KIMI);
    assert.equal(plus.env.ANTHROPIC_DEFAULT_SONNET_MODEL, CLAUDE_MODEL);
    assert.equal(plus.err, "  Models on your plan: DeepSeek V4.1 Flash (Sonnet), Kimi K3.1 (Opus) — switch with /model\n");
    const starter = await run(models({ data: [{ id: CLAUDE_MODEL, name: "DeepSeek V4.1 Flash 1017", context_window: 1_048_576, max_output_tokens: 65_536 }] }));
    assert.equal(starter.env.ANTHROPIC_DEFAULT_OPUS_MODEL, CLAUDE_MODEL);
    assert.equal(starter.err, "  Model on your plan: DeepSeek V4.1 Flash\n");
    const down = await run(models({ error: "nope" }, 503));
    assert.equal(down.env.ANTHROPIC_DEFAULT_OPUS_MODEL, CLAUDE_MODEL);
  });

  it("lists only variables that were set", () => {
    assert.deepEqual(claudeEnv({ ANTHROPIC_MODEL: "", PATH: "/bin" }, { origin: ORIGIN, key: KEY }).removed, []);
  });
});

describe("the free tier access token for dl claude", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dl-token-"));
    file = join(dir, "config.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const save = (saved: Record<string, unknown>) => writeFile(file, JSON.stringify({ provider: "directionally-local", model: "m", providers: { "directionally-local": saved, openrouter: { apiKey: "sk-or" } } }));

  it("uses a fresh saved token as it is, without the network", async () => {
    await save({ apiKey: "access-1", refreshToken: "refresh-1", expiresAt: 10_000_000 });
    const token = await freeTierAccessToken({ env: {}, file, now: () => 1_000, fetch: async () => assert.fail("no refresh") });
    assert.deepEqual(token, { ok: true, origin: "https://free.directionallylocal.com", accessToken: "access-1" });
  });

  it("refreshes an expired one and saves the new pair in place, keeping everything else", async () => {
    await save({ apiKey: "old", refreshToken: "refresh-1", expiresAt: 1_000, baseUrl: "https://free.test/v1" });
    const sent: unknown[] = [];
    const token = await freeTierAccessToken({
      env: {},
      file,
      now: () => 5_000,
      fetch: async (url, init) => {
        sent.push([url, JSON.parse(String(init.body))]);
        return Response.json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 });
      },
    });
    assert.deepEqual(token, { ok: true, origin: "https://free.test", accessToken: "access-2" });
    assert.deepEqual(sent, [["https://free.test/v1/token/refresh", { refresh_token: "refresh-1" }]]);
    const config = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(config.providers["directionally-local"], { apiKey: "access-2", refreshToken: "refresh-2", expiresAt: 3_605_000, baseUrl: "https://free.test/v1" });
    assert.deepEqual(config.providers.openrouter, { apiKey: "sk-or" });
    assert.equal(config.model, "m");
  });

  it("takes the pair another process rotated to when the refresh lost the race", async () => {
    await save({ apiKey: "old", refreshToken: "refresh-1", expiresAt: 1_000 });
    const token = await freeTierAccessToken({
      env: {},
      file,
      now: () => 5_000,
      sleep: async () => undefined,
      fetch: async () => {
        await save({ apiKey: "theirs", refreshToken: "refresh-2", expiresAt: 9_000_000 });
        return Response.json({ error: { code: "invalid_grant", message: "x" } }, { status: 400 });
      },
    });
    assert.deepEqual(token, { ok: true, origin: "https://free.directionallylocal.com", accessToken: "theirs" });
  });

  it("is signed out with no saved sign-in, or a refused refresh token", async () => {
    assert.deepEqual(await freeTierAccessToken({ env: {}, file }), { ok: false, reason: "signed_out" });
    await save({ apiKey: "old", refreshToken: "refresh-1", expiresAt: 1_000 });
    const refused = await freeTierAccessToken({ env: {}, file, now: () => 5_000, sleep: async () => undefined, fetch: async () => Response.json({ error: { code: "invalid_grant" } }, { status: 400 }) });
    assert.deepEqual(refused, { ok: false, reason: "signed_out" });
  });
});

describe("dl claude on a dl key (dl's own sign-in)", () => {
  it("gives Claude Code the dl key and api.dl.new/anthropic directly: no harness key, no events, no Autopilot", async () => {
    const service = fakeService();
    const child = fakeSpawn({ code: 0 });
    const code = await claudeCommand([], capture().io, deps({
      dlKey: async () => ({ key: "dl_sk_0123456789abcdef", plan: "starter", baseUrl: "https://api.dl.new", anthropicBaseUrl: "https://api.dl.new/anthropic", savedAt: "" }),
      token: async () => { throw new Error("the older sign-in isn't read"); },
      fetch: service.fetch,
      spawn: child.spawn,
    }));
    assert.equal(code, 0);
    assert.deepEqual(service.calls.map((call) => `${call.method} ${call.url}`), ["GET https://api.dl.new/v1/models"], "nothing to mint, refresh, revoke or count; only the key's models");
    const env = child.started[0]!.options.env as Record<string, string>;
    assert.equal(env.ANTHROPIC_BASE_URL, "https://api.dl.new/anthropic");
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "dl_sk_0123456789abcdef");
  });

  it("signs in in the browser (not through Autopilot) when there's no key, then uses it", async () => {
    let key: { key: string; plan: null; baseUrl: string; anthropicBaseUrl: string; savedAt: string } | undefined;
    const child = fakeSpawn({ code: 0 });
    const { io, out } = capture();
    const code = await claudeCommand([], io, deps({
      dlKey: async () => key,
      token: async () => ({ ok: false, reason: "signed_out" }),
      signIn: async () => { key = { key: "dl_sk_new0123456789", plan: null, baseUrl: "https://api.dl.new", anthropicBaseUrl: "https://api.dl.new/anthropic", savedAt: "" }; return true; },
      fetch: fakeService().fetch,
      spawn: child.spawn,
    }));
    assert.equal(code, 0);
    assert.match(out(), /uses your dl sign-in\. Signing in first\./);
    assert.equal((child.started[0]!.options.env as Record<string, string>).ANTHROPIC_AUTH_TOKEN, "dl_sk_new0123456789");
  });
});
