import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { FREE_TIER_MODELS, KEY_ENV } from "./opencode.js";
import { REFRESH_EVERY_MS, SESSION_EVENT_EVERY_MS, type LaunchDeps } from "./harness-launch.js";
import { T3_INSTALL, enableT3OpenCode, t3Command, t3Env, t3Refusal, t3SettingsPath, type T3Deps } from "./t3.js";
import { main } from "../cli.js";

const ORIGIN = "https://free.test";
const CLAUDE_KEY = `dlh_100_cccccccccccc_${"c".repeat(43)}`;
const OPENCODE_KEY = `dlh_100_oooooooooooo_${"o".repeat(43)}`;
const IDS = { "claude-code": "cccccccccccc", opencode: "oooooooooooo" } as const;
const KEYS = { "claude-code": CLAUDE_KEY, opencode: OPENCODE_KEY } as const;

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

/** A fake service: mints a key per harness, lists models, takes events, refreshes and revokes. */
function fakeService(options: { refuse?: "claude-code" | "opencode" } = {}) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers).entries()), body });
    if (url.endsWith("/v1/harness-keys")) {
      const harness = body.harness as "claude-code" | "opencode";
      if (options.refuse === harness) return Response.json({ error: { code: "harness_key_limit", message: "Too many keys." } }, { status: 409 });
      return Response.json({ id: IDS[harness], key: KEYS[harness], harness, expiresAt: "x", ttlSeconds: 900, otherHarnessShare: 0.5 }, { status: 201 });
    }
    if (url.endsWith("/v1/models")) return Response.json({ object: "list", data: FREE_TIER_MODELS.map((m) => ({ id: m.id, name: m.name, context_window: m.contextWindow, max_output_tokens: m.maxOutputTokens, vision: m.vision })) });
    if (url.endsWith("/v1/events")) return Response.json({ accepted: 1 }, { status: 202 });
    return Response.json({ ok: true });
  };
  return { calls, fetch };
}

function fakeSpawn(exit: { code?: number | null } = { code: 0 }) {
  const started: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  const spawn = (command: string, args: string[], options: SpawnOptions): ChildProcess => {
    started.push({ command, args, options });
    const child = new EventEmitter() as ChildProcess;
    (child as unknown as { kill: () => boolean }).kill = () => true;
    setImmediate(() => child.emit("exit", exit.code ?? null, null));
    return child;
  };
  return { started, spawn };
}

/** Timers the test fires by hand. */
function fakeTimers() {
  const timers: Array<{ fn: () => void; ms: number; stopped: boolean }> = [];
  return {
    timers,
    setInterval: (fn: () => void, ms: number) => {
      const timer: { fn: () => void; ms: number; stopped: boolean; unref?: () => void } = { fn, ms, stopped: false };
      timers.push(timer);
      return timer;
    },
    clearInterval: (timer: unknown) => void ((timer as { stopped: boolean }).stopped = true),
  };
}

/** A temp HOME per test run: T3 Code's settings go here, never the real ~/.t3. */
const HOME = mkdtempSync(join(tmpdir(), "dl-t3-test-"));
let settingsN = 0;
after(() => rm(HOME, { recursive: true, force: true }));

function deps(overrides: Partial<T3Deps> = {}): T3Deps {
  return {
    t3Settings: join(HOME, `run-${++settingsN}`, ".t3", "userdata", "settings.json"),
    env: { PATH: "/usr/bin", HOME: "/home/alice", ANTHROPIC_API_KEY: "sk-ant-mine", OPENCODE_CONFIG_CONTENT: "{}" },
    find: async () => "/home/alice/.local/bin/t3",
    cwd: "/nonexistent/dl-t3-test",
    token: async () => ({ ok: true, origin: ORIGIN, accessToken: "access-1" }),
    signIn: async () => {
      throw new Error("no sign-in expected");
    },
    setInterval: () => ({}),
    clearInterval: () => undefined,
    terminal: false,
    onSignal: () => () => undefined,
    ...overrides,
  };
}

describe("dl t3", () => {
  it("stops before signing in when Claude Code's settings set an Anthropic key (T3 Code runs Claude Code)", async () => {
    const project = join(HOME, "settings-key-project");
    await mkdir(join(project, ".claude"), { recursive: true });
    await writeFile(join(project, ".claude", "settings.local.json"), JSON.stringify({ apiKeyHelper: "print-my-anthropic-key" }));
    let minted = false;
    const errors: string[] = [];
    const code = await t3Command([], { out: () => undefined, err: (text) => void errors.push(text) }, deps({ cwd: project, token: async () => ((minted = true), { ok: true, origin: ORIGIN, accessToken: "a" }) }));
    assert.equal(code, 1);
    assert.equal(minted, false);
    assert.match(errors.join(""), /dl t3 won't start Claude Code/);
    assert.match(errors.join(""), /settings\.local\.json: apiKeyHelper/);
    assert.doesNotMatch(errors.join(""), /print-my-anthropic-key/);
  });

  it("starts t3 with the arguments as given, Claude Code and OpenCode each on its own harness key", async () => {
    const service = fakeService();
    const child = fakeSpawn({ code: 0 });
    const { io, err } = capture();
    const code = await t3Command(["serve", "--port", "3773"], io, deps({ fetch: service.fetch, spawn: child.spawn }));
    assert.equal(code, 0);

    const mints = service.calls.filter((c) => c.url === `${ORIGIN}/v1/harness-keys`);
    assert.deepEqual(mints.map((c) => c.body.harness), ["claude-code", "opencode"]);
    for (const mint of mints) assert.equal(mint.headers.authorization, "Bearer access-1");

    assert.equal(child.started.length, 1);
    const [started] = child.started;
    assert.equal(started!.command, "/home/alice/.local/bin/t3");
    assert.deepEqual(started!.args, ["serve", "--port", "3773"]);
    const env = started!.options.env as Record<string, string | undefined>;
    assert.equal(env.ANTHROPIC_BASE_URL, `${ORIGIN}/anthropic`);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, CLAUDE_KEY);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env[KEY_ENV], OPENCODE_KEY);
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
    assert.equal(config.provider.dl.options.baseURL, `${ORIGIN}/v1`);
    assert.equal(config.provider.dl.options.apiKey, `{env:${KEY_ENV}}`);
    assert.equal(env.HOME, "/home/alice");

    // The model list is read with the OpenCode key (the only kind /v1/models takes).
    const models = service.calls.find((c) => c.url.endsWith("/v1/models"));
    assert.equal(models?.headers.authorization, `Bearer ${OPENCODE_KEY}`);

    assert.match(err(), /not passing ANTHROPIC_API_KEY, OPENCODE_CONFIG_CONTENT to T3 Code/);
    assert.match(err(), /desktop app/);
    assert.doesNotMatch(err(), new RegExp(CLAUDE_KEY));
    assert.doesNotMatch(err(), new RegExp(OPENCODE_KEY));
  });

  it("sends each agent's session events with its own key, then revokes both keys", async () => {
    const service = fakeService();
    const { io } = capture();
    await t3Command([], io, deps({ fetch: service.fetch, spawn: fakeSpawn({ code: 3 }).spawn }));

    const events = service.calls.filter((c) => c.url === `${ORIGIN}/v1/events`);
    const byKey = (key: string) => events.filter((c) => c.headers.authorization === `Bearer ${key}`).map((c) => c.body.events[0]);
    for (const [harness, key] of Object.entries(KEYS)) {
      const mine = byKey(key);
      assert.deepEqual(mine.map((e) => e.type), ["session.start", "session.end"]);
      assert.equal(mine[0].props.harness, harness);
      assert.match(mine[0].sessionId, new RegExp(`^dl-t3-${harness}-`));
      assert.equal(mine[0].sessionId, mine[1].sessionId);
    }
    assert.notEqual(byKey(CLAUDE_KEY)[0].sessionId, byKey(OPENCODE_KEY)[0].sessionId);

    const revoked = service.calls.filter((c) => c.method === "DELETE");
    assert.deepEqual(revoked.map((c) => [c.url, c.headers.authorization]).sort(), [
      [`${ORIGIN}/v1/harness-keys/${IDS["claude-code"]}`, `Bearer ${CLAUDE_KEY}`],
      [`${ORIGIN}/v1/harness-keys/${IDS.opencode}`, `Bearer ${OPENCODE_KEY}`],
    ]);
  });

  it("refreshes both keys every few minutes while T3 Code runs, and stops when it exits", async () => {
    const service = fakeService();
    const timers = fakeTimers();
    const { io } = capture();
    let exitT3: () => void = () => undefined;
    const spawn = (): ChildProcess => {
      const child = new EventEmitter() as ChildProcess;
      (child as unknown as { kill: () => boolean }).kill = () => true;
      exitT3 = () => child.emit("exit", 0, null);
      return child;
    };
    const running = t3Command(["serve"], io, deps({ fetch: service.fetch, spawn, setInterval: timers.setInterval, clearInterval: timers.clearInterval }));
    while (timers.timers.length < 2) await new Promise((resolve) => setImmediate(resolve));

    const refresher = timers.timers.find((t) => t.ms === REFRESH_EVERY_MS)!;
    const heartbeat = timers.timers.find((t) => t.ms === SESSION_EVENT_EVERY_MS)!;
    refresher.fn();
    refresher.fn();
    await new Promise((resolve) => setImmediate(resolve));
    const refreshes = service.calls.filter((c) => c.url.endsWith("/refresh"));
    assert.equal(refreshes.length, 4);
    for (const [harness, key] of Object.entries(KEYS)) {
      const mine = refreshes.filter((c) => c.url === `${ORIGIN}/v1/harness-keys/${IDS[harness as keyof typeof IDS]}/refresh`);
      assert.equal(mine.length, 2);
      for (const call of mine) assert.equal(call.headers.authorization, `Bearer ${key}`);
    }

    heartbeat.fn();
    await new Promise((resolve) => setImmediate(resolve));
    const starts = service.calls.filter((c) => c.url.endsWith("/v1/events") && c.body.events[0].type === "session.start");
    assert.equal(starts.length, 4);

    exitT3();
    assert.equal(await running, 0);
    assert.ok(refresher.stopped && heartbeat.stopped);
  });

  it("stops before T3 Code starts when one of the keys is refused, revoking the other", async () => {
    const service = fakeService({ refuse: "opencode" });
    const child = fakeSpawn();
    const { io, err } = capture();
    assert.equal(await t3Command([], io, deps({ fetch: service.fetch, spawn: child.spawn })), 1);
    assert.equal(child.started.length, 0);
    assert.match(err(), /Too many keys/);
    const revoked = service.calls.filter((c) => c.method === "DELETE").map((c) => c.url);
    assert.deepEqual(revoked, [`${ORIGIN}/v1/harness-keys/${IDS["claude-code"]}`]);
  });

  it("prints the install commands when t3 isn't on PATH", async () => {
    const service = fakeService();
    const { io, err } = capture();
    assert.equal(await t3Command([], io, deps({ fetch: service.fetch, find: async () => undefined })), 1);
    assert.match(err(), /T3 Code isn't installed \(no t3 on PATH\)/);
    assert.ok(err().includes(T3_INSTALL));
    assert.ok(err().includes("npm install -g t3"));
    assert.equal(service.calls.length, 0);
  });

  it("refuses commands that don't start a server it can give free tokens to, before signing in", async () => {
    for (const args of [["thread", "list"], ["service", "install"], ["up"], ["app"]]) {
      const service = fakeService();
      const { io, err } = capture();
      const code = await t3Command(args, io, deps({ fetch: service.fetch, token: async () => assert.fail("no token expected") }));
      assert.equal(code, 1, args.join(" "));
      assert.equal(service.calls.length, 0);
      assert.ok(err().length > 0);
    }
  });

  it("is reached from dl's command line with every argument after t3", async () => {
    let seen: string[] | undefined;
    const { io } = capture();
    const code = await main(["t3", "serve", "--port", "3773", "--help"], io, { t3: async (args) => ((seen = args), 0) });
    assert.equal(code, 0);
    assert.deepEqual(seen, ["serve", "--port", "3773", "--help"]);
  });
});

describe("T3 Code's environment and arguments", () => {
  it("combines Claude Code's and OpenCode's free tier variables, each with its own key", () => {
    const { env, removed } = t3Env({ PATH: "/bin", ANTHROPIC_BASE_URL: "https://elsewhere", ANTHROPIC_MODEL: "opus" }, { origin: ORIGIN, claudeKey: "ck", opencodeKey: "ok", models: FREE_TIER_MODELS });
    assert.deepEqual(removed, ["ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL"]);
    assert.equal(env.PATH, "/bin");
    assert.equal(env.ANTHROPIC_BASE_URL, `${ORIGIN}/anthropic`);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "ck");
    assert.equal(env.ANTHROPIC_MODEL, "deepseek/deepseek-v4.1-flash-1017");
    assert.equal(env[KEY_ENV], "ok");
    assert.equal(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).model, "dl/deepseek/deepseek-v4.1-flash-1017");
  });

  it("lets server-starting commands through and names the others", () => {
    for (const args of [[], ["serve"], ["start"], ["--port", "3773"], ["--no-browser"], ["./my-project"], ["my-project"]]) assert.equal(t3Refusal(args), undefined, args.join(" "));
    assert.match(t3Refusal(["thread", "start", ".", "hi"])!, /Run it as t3 thread/);
    assert.match(t3Refusal(["service", "install"])!, /background service/);
    assert.match(t3Refusal(["up", "--lan"])!, /background service/);
    assert.match(t3Refusal(["app"])!, /desktop app/);
  });
});

describe("dl t3 turns on T3 Code's OpenCode", () => {
  it("creates ~/.t3/userdata/settings.json under HOME when missing, and says so with the dl/… hint", async () => {
    const home = join(HOME, "fresh");
    const path = t3SettingsPath({ HOME: home });
    assert.equal(path, join(home, ".t3", "userdata", "settings.json"));
    const service = fakeService();
    const { io, err } = capture();
    assert.equal(await t3Command(["serve"], io, deps({ fetch: service.fetch, spawn: fakeSpawn().spawn, t3Settings: undefined, env: { PATH: "/usr/bin", HOME: home } })), 0);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { providerInstances: { opencode: { driver: "opencode", enabled: true } } });
    assert.match(err(), /Turned on OpenCode in T3 Code's settings/);
    assert.match(err(), /In OpenCode pick a dl\/… model/);
    assert.deepEqual((await readdir(join(home, ".t3", "userdata"))).sort(), ["settings.json"], "nothing to back up");
  });

  it("keeps every other key, backs the file up once, and leaves it alone when it's already on", async () => {
    const dir = join(HOME, "merge");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "settings.json");
    const original = { theme: "dark", providerInstances: { claude: { driver: "claude", enabled: true }, opencode: { driver: "opencode", enabled: false, serverUrl: "" } } };
    await writeFile(path, JSON.stringify(original));
    assert.deepEqual(await enableT3OpenCode(path), { result: "enabled" });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      theme: "dark",
      providerInstances: { claude: { driver: "claude", enabled: true }, opencode: { driver: "opencode", enabled: true, serverUrl: "" } },
    });
    assert.deepEqual(JSON.parse(await readFile(`${path}.dl-backup`, "utf8")), original);
    assert.deepEqual(await enableT3OpenCode(path), { result: "unchanged" });
    // Turned off again by the person: on again, and the first backup stays.
    await writeFile(path, JSON.stringify({ providerInstances: { opencode: { driver: "opencode", enabled: false } } }));
    assert.deepEqual(await enableT3OpenCode(path), { result: "enabled" });
    assert.deepEqual(JSON.parse(await readFile(`${path}.dl-backup`, "utf8")), original);
    assert.deepEqual((await readdir(dir)).sort(), ["settings.json", "settings.json.dl-backup"]);
  });

  it("never clobbers a file it can't read as settings; T3 Code still starts, with a note", async () => {
    const dir = join(HOME, "broken");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "settings.json");
    await writeFile(path, "{ not json");
    const service = fakeService();
    const child = fakeSpawn();
    const { io, err } = capture();
    assert.equal(await t3Command([], io, deps({ fetch: service.fetch, spawn: child.spawn, t3Settings: path })), 0);
    assert.equal(child.started.length, 1);
    assert.equal(await readFile(path, "utf8"), "{ not json");
    assert.match(err(), /couldn't turn it on \(.*isn't valid JSON/);
    await writeFile(path, JSON.stringify({ providerInstances: [] }));
    assert.match((await enableT3OpenCode(path) as { error: string }).error, /providerInstances .* isn't an object/);
  });
});
