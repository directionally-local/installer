import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { main, splitPassthrough, type MainOptions } from "../cli.js";
import { PATHS } from "../layout.js";
import { PAIRED_NAME } from "../local/layout.js";
import { ScriptedPrompter } from "../prompt.js";
import { fakeTunnels, type FakeTunnel } from "../test-support/fake-tunnel.js";
import { DEFAULT_MODEL, type LaptopIO } from "./commands.js";
import { loadRemotes, saveRemote, type RemoteServer } from "./config.js";
import type { SetupOptions } from "./setup.js";
import { autopilotOnPath, bundledAutopilot, openSession, planSession, startHere, supportsAttachRemote, type AutopilotCommand, type SessionChild, type SessionInput, type SessionSpawner } from "./session.js";
import { loadSessions, rememberSession } from "./session-store.js";
import { createOpener, type RemoteOpener } from "./tunnel.js";

const TOKEN = "aster_laptop_token_0000000000000000000000000000000000";
const NEW_ID = "7c1d2e3f-0000-4000-8000-000000000000";
const NEW_ID_1 = "7c1d2e3f-0000-4000-8000-000000000001";
const OLD_ID = "3f2a9c1e-0000-4000-8000-000000000000";
const OTHER_ID = "9a8b7c6d-0000-4000-8000-000000000000";
const CHAT_ID = "c0ffee00-0000-4000-8000-000000000000";
const CHAT_ID_1 = "c0ffee00-0000-4000-8000-000000000001";

/** The parts of the API a session asks for: workspaces, models, and one conversation. */
class FakeApi {
  models = ["01-ai/yi-large", DEFAULT_MODEL];
  /** A newer server also says which provider the catalog comes from, and its default model. */
  provider: { id: string; name: string } | undefined;
  defaultModel: string | undefined;
  /** Conversation ID -> status; missing means 404. */
  readonly conversations = new Map<string, string>();
  /** Conversation ID -> the run it's working on, for the ones that are live. */
  readonly activeRuns = new Map<string, string>();
  readonly requests: string[] = [];
  private server: Server | undefined;
  url = "";

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    this.url = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const path = new URL(req.url ?? "/", this.url).pathname;
    this.requests.push(`${req.method} ${path}`);
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: { code: "invalid_credential", message: "no" } });
    if (path === "/api/v1/workspaces") return send(200, { workspaces: [{ id: "default", displayName: "Default" }] });
    if (path === "/api/v1/models") return send(200, { models: this.models, ...(this.provider ? { provider: this.provider } : {}), ...(this.defaultModel ? { defaultModel: this.defaultModel } : {}) });
    if (path === "/api/v1/conversations") return send(200, { conversations: [] });
    const id = decodeURIComponent(path.replace(/^\/api\/v1\/conversations\//, ""));
    const status = this.conversations.get(id);
    if (status) return send(200, { conversationId: id, workspaceId: "default", model: DEFAULT_MODEL, status, activeRunId: this.activeRuns.get(id) ?? null, lastEventId: 1, createdAt: "", updatedAt: "", kind: id.startsWith("c") ? "chat" : "code", ...(id.startsWith("c") ? {} : { repository: "me/app" }) });
    send(404, { error: { code: "not_found", message: "No such conversation" } });
  }
}

interface Launch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  patch?: string;
  patchMode?: number;
  /** Set when the fake refused a flag combination, as the real attach-remote does. */
  refused?: string;
  /** Whether every tunnel was still open when Autopilot started. */
  tunnelsOpen?: boolean;
}

/**
 * A stand-in for `autopilot attach-remote`: records how it was started, writes the state file
 * the way Autopilot does once the conversation exists, and exits with `code` (unless held).
 */
class FakeAutopilot {
  readonly launches: Launch[] = [];
  readonly children: Array<EventEmitter & SessionChild & { signals: string[] }> = [];
  code = 0;
  hold = false;
  tunnels: FakeTunnel[] = [];
  private codeCount = 0;
  private chatCount = 0;

  constructor(private readonly api: FakeApi) {}

  /** A new conversation's id: the first is the one tests name, later ones count up. */
  private nextId(chat: boolean): string {
    const count = chat ? this.chatCount++ : this.codeCount++;
    const base = chat ? CHAT_ID : NEW_ID;
    return count === 0 ? base : `${base.slice(0, -1)}${count}`;
  }

  readonly spawn = (command: string, args: string[], env: NodeJS.ProcessEnv): SessionChild => {
    const launch: Launch = { command, args, env, tunnelsOpen: this.tunnels.every((tunnel) => !tunnel.killed) };
    this.launches.push(launch);
    const child = Object.assign(new EventEmitter(), {
      signals: [] as string[],
      kill(signal?: NodeJS.Signals) {
        child.signals.push(signal ?? "SIGTERM");
        setImmediate(() => child.emit("exit", null, signal ?? "SIGTERM"));
        return true;
      },
    });
    this.children.push(child);
    void (async () => {
      const flag = (name: string) => args[args.indexOf(name) + 1];
      // Like the real attach-remote (checkFlags): reconnecting refuses every creation flag, exit 2.
      const creation = ["--workspace", "--kind", "--repo", "--model", "--base-commit", "--patch-file"].filter((name) => args.includes(name));
      if (args.includes("--conversation") && creation.length > 0) {
        launch.refused = `--conversation with ${creation.join(", ")}`;
        setImmediate(() => child.emit("exit", 2, null));
        return;
      }
      const patchFile = args.includes("--patch-file") ? flag("--patch-file") : undefined;
      if (patchFile) {
        launch.patch = await readFile(patchFile, "utf8");
        launch.patchMode = (await stat(patchFile)).mode & 0o777;
      }
      const chat = args.includes("--kind") && flag("--kind") === "chat";
      const id = args.includes("--conversation") ? flag("--conversation")! : this.nextId(chat);
      this.api.conversations.set(id, "ready");
      await writeFile(flag("--state-file")!, JSON.stringify(chat ? { conversationId: id } : { conversationId: id, branch: `aster/${id.slice(0, 8)}`, repository: flag("--repo") ?? "me/app" }));
      if (!this.hold) child.emit("exit", this.code, null);
    })();
    return child;
  };
}

const roots: string[] = [];
let root: string;
let api: FakeApi;
let autopilot: FakeAutopilot;
const previous = { remotes: process.env.AUTOPILOT_REMOTES_FILE, xdg: process.env.XDG_CONFIG_HOME };

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "dl-session-test-")));
  roots.push(root);
  process.env.AUTOPILOT_REMOTES_FILE = join(root, "remotes.json");
  process.env.XDG_CONFIG_HOME = join(root, "config");
  api = new FakeApi();
  await api.start();
  autopilot = new FakeAutopilot(api);
});

afterEach(async () => {
  await api.stop();
  for (const [key, value] of [["AUTOPILOT_REMOTES_FILE", previous.remotes], ["XDG_CONFIG_HOME", previous.xdg]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const AUTOPILOT: AutopilotCommand = { command: "/usr/local/bin/node", args: ["/opt/dl/node_modules/autopilot-ai/bin/autopilot.mjs"] };

function place(name: string, url: string, extra: Partial<RemoteServer> = {}): RemoteServer {
  return { name, url, token: TOKEN, credentialId: `cred-${name}`, expiresAt: "2027-01-01T00:00:00.000Z", addedAt: "2026-10-28T00:00:00.000Z", ...extra };
}

function capture(): LaptopIO & { text: () => string } {
  let text = "";
  return { out: (chunk) => { text += chunk; }, err: (chunk) => { text += chunk; }, color: false, text: () => text };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
}

/** A clone with one pushed commit whose origin says GitHub (the commits come from a local bare repository). */
async function checkout(name = "checkout"): Promise<string> {
  const origin = join(root, `${name}-origin.git`);
  const dir = join(root, name);
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  execFileSync("git", ["clone", "--quiet", origin, dir], { stdio: "ignore" });
  await writeFile(join(dir, "README.md"), "hello\n");
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "initial");
  git(dir, "push", "--quiet", "origin", "main");
  git(dir, "remote", "set-url", "origin", "git@github.com:me/app.git");
  return dir;
}

function session(input: Partial<SessionInput> & { cwd: string }, io: LaptopIO): Promise<number | undefined> {
  return openSession({
    autopilot: async () => AUTOPILOT,
    probe: async () => true,
    placeModel: async () => undefined,
    spawn: autopilot.spawn,
    signals: new EventEmitter(),
    ...input,
  }, io);
}

const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

describe("dl inside a project", () => {
  it("starts a new conversation every time, and dl -c reopens the latest", { timeout: 30_000 }, async () => {
    await saveRemote(place("dl-test", api.url));
    const dir = await checkout();
    await writeFile(join(dir, "README.md"), "hello\nlocal edit\n");
    const first = capture();
    assert.equal(await session({ cwd: dir }, first), 0);

    const launch = autopilot.launches[0]!;
    assert.equal(launch.command, AUTOPILOT.command);
    const args = launch.args.slice(1);
    assert.equal(launch.args[0], AUTOPILOT.args[0]);
    assert.equal(args[0], "attach-remote");
    assert.equal(flag(args, "--workspace"), "default");
    assert.equal(flag(args, "--repo"), "me/app");
    assert.equal(flag(args, "--model"), DEFAULT_MODEL);
    assert.equal(flag(args, "--base-commit"), git(dir, "rev-parse", "HEAD"));
    assert.equal(flag(args, "--title"), "dl-test · me/app");
    assert.equal(args.includes("--conversation"), false);
    assert.match(launch.patch ?? "", /\+local edit/);
    assert.equal(launch.patchMode, 0o600);
    assert.equal(existsSync(flag(args, "--patch-file")!), false, "the patch file is deleted afterwards");
    assert.equal(existsSync(flag(args, "--state-file")!), false, "so is the state file");
    assert.equal(launch.env.AUTOPILOT_REMOTE_URL, api.url);
    assert.equal(launch.env.AUTOPILOT_REMOTE_TOKEN, TOKEN);
    assert.ok(!launch.args.some((arg) => arg.includes(TOKEN)), "the token is never in argv");
    assert.match(first.text(), /· Connecting to dl-test · me\/app … {2}\(new conversation from [0-9a-f]{7} \+ 1 local change, deepseek\/deepseek-v4\.1-flash-1017\)\n/);
    assert.match(first.text(), /It keeps running on dl-test\. Type dl -c here to come back, or dl runs\.\n/);

    const file = join(root, "config", "directionallylocal", "sessions.json");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, "config", "directionallylocal"))).mode & 0o777, 0o700);
    assert.deepEqual((await loadSessions(file)).map(({ updatedAt: _, ...entry }) => entry), [
      { place: "dl-test", repository: "me/app", root: dir, conversationId: NEW_ID, branch: "aster/7c1d2e3f" },
    ]);

    // Bare dl again: another conversation, not the first one.
    const again = capture();
    assert.equal(await session({ cwd: join(dir) }, again), 0);
    const second = autopilot.launches[1]!.args.slice(1);
    assert.equal(second.includes("--conversation"), false);
    assert.equal(flag(second, "--repo"), "me/app");
    assert.match(again.text(), /new conversation from/);
    assert.deepEqual((await loadSessions(file)).map((entry) => entry.conversationId).sort(), [NEW_ID, NEW_ID_1].sort());

    // dl -c: the latest one started from this checkout.
    const resumed = capture();
    assert.equal(await session({ cwd: join(dir), continue: true }, resumed), 0);
    const reconnect = autopilot.launches[2]!.args.slice(1);
    assert.equal(flag(reconnect, "--conversation"), NEW_ID_1);
    assert.equal(reconnect.includes("--workspace"), false);
    assert.equal(reconnect.includes("--patch-file"), false);
    assert.match(resumed.text(), /Connecting to dl-test · me\/app … {2}\(7c1d2e3f\)/);
    assert.equal((await loadSessions(file)).length, 2);
  });

  it("uses the server's default model when the place has none saved", { timeout: 30_000 }, async () => {
    await saveRemote(place("dl-test", api.url));
    api.models = ["01-ai/yi-large", "moonshotai/kimi-k2.6"];
    api.provider = { id: "openrouter", name: "OpenRouter" };
    api.defaultModel = "moonshotai/kimi-k2.6";
    const dir = await checkout();
    assert.equal(await session({ cwd: dir }, capture()), 0);
    assert.equal(flag(autopilot.launches[0]!.args, "--model"), "moonshotai/kimi-k2.6", "the server's default, not a hard-coded id");
  });

  it("asks before sending local changes that look like a key, and starts from the base commit", { timeout: 30_000 }, async () => {
    await saveRemote(place("dl-test", api.url));
    const dir = await checkout();
    await writeFile(join(dir, "connect.test.ts"), 'const apiKey = "sk-deepseek-1234567890abcdefghij";\n');
    const prompter = new ScriptedPrompter({ "How should this session start?": "" });
    const io = capture();
    assert.equal(await session({ cwd: dir, prompter }, io), 0);
    assert.match(io.text(), /! Your local changes include something that looks like an API key:\n {4}connect\.test\.ts:1\n/);
    assert.match(io.text(), /Agents get a copy of your changes, and keys never leave this computer\./);
    assert.ok(prompter.asked.some((question) => question.includes("How should this session start?")), prompter.asked.join("\n"));
    const args = autopilot.launches[0]!.args;
    assert.equal(args.includes("--patch-file"), false, "no patch is sent");
    assert.equal(flag(args, "--base-commit"), git(dir, "rev-parse", "HEAD"));
    assert.match(io.text(), /new conversation from [0-9a-f]{7}, /, "the detail says no local changes");
  });

  it("Cancel at that question opens nothing", { timeout: 30_000 }, async () => {
    await saveRemote(place("dl-test", api.url));
    const dir = await checkout();
    await writeFile(join(dir, "connect.test.ts"), 'const apiKey = "sk-deepseek-1234567890abcdefghij";\n');
    const prompter = new ScriptedPrompter({ "How should this session start?": "cancel" });
    assert.equal(await session({ cwd: dir, prompter }, capture()), 130);
    assert.equal(autopilot.launches.length, 0, "no session");
  });

  it("dl --no-local-changes sends no patch and asks nothing", { timeout: 30_000 }, async () => {
    await saveRemote(place("dl-test", api.url));
    const dir = await checkout();
    await writeFile(join(dir, "connect.test.ts"), 'const apiKey = "sk-deepseek-1234567890abcdefghij";\n');
    const prompter = new ScriptedPrompter({});
    const io = capture();
    assert.equal(await session({ cwd: dir, noLocalChanges: true, prompter }, io), 0);
    assert.deepEqual(prompter.asked, [], "nothing to ask");
    assert.equal(autopilot.launches[0]!.args.includes("--patch-file"), false);
    assert.doesNotMatch(io.text(), /looks like an API key/);
  });

  it("says how to start without local changes when attach-remote refuses the patch", { timeout: 30_000 }, async () => {
    await saveRemote(place("dl-test", api.url));
    const dir = await checkout();
    autopilot.code = 3;
    const io = capture();
    assert.equal(await session({ cwd: dir }, io), 1);
    assert.match(io.text(), /Start without your local changes: dl --no-local-changes/);
  });

  it("dl -c picks the latest conversation for this folder and place", { timeout: 30_000 }, async () => {
    await saveRemote(place("dl-test", api.url));
    await saveRemote(place("other", api.url));
    const dir = await checkout();
    const clone = await checkout("second");
    await rememberSession({ place: "dl-test", repository: "me/app", root: dir, conversationId: OLD_ID });
    await rememberSession({ place: "dl-test", repository: "me/app", root: dir, conversationId: NEW_ID });
    await rememberSession({ place: "other", repository: "me/app", root: dir, conversationId: OTHER_ID });
    for (const id of [OLD_ID, NEW_ID, OTHER_ID]) api.conversations.set(id, "completed");

    const byDefault = capture();
    assert.equal(await session({ cwd: dir, continue: true }, byDefault), 0);
    assert.equal(flag(autopilot.launches[0]!.args, "--conversation"), NEW_ID, "the latest here on the default place");
    // Two places: the line says why this one, and how to pick the other (once, not a second "on dl-test").
    assert.match(byDefault.text(), /· Connecting to dl-test \(default\) · me\/app … .*\n {4}dl use NAME to change where dl runs\n/);
    assert.equal(byDefault.text().match(/dl-test/g)?.length, 2, "the place is named on the Connecting line and the goodbye line only");

    const named = capture();
    assert.equal(await session({ cwd: dir, server: "other", continue: true }, named), 0);
    assert.equal(flag(autopilot.launches[1]!.args, "--conversation"), OTHER_ID, "another place keeps its own");
    assert.match(named.text(), /· Connecting to other · me\/app/);
    assert.doesNotMatch(named.text(), /dl use NAME/, "a place named with --server needs no hint");

    // Another checkout has no earlier session here: -c starts a new one.
    const elsewhere = capture();
    assert.equal(await session({ cwd: clone, continue: true }, elsewhere), 0);
    assert.equal(flag(autopilot.launches[2]!.args, "--conversation"), undefined);
    assert.match(elsewhere.text(), /! No earlier session here; starting a new one\./);

    // Bare dl here starts another, not the latest.
    assert.equal(await session({ cwd: dir }, capture()), 0);
    assert.equal(flag(autopilot.launches[3]!.args, "--conversation"), undefined);
  });

  it("dl -c starts a new conversation when the remembered one is gone", { timeout: 30_000 }, async () => {
    await saveRemote(place("dl-test", api.url));
    const dir = await checkout();
    for (const status of [undefined, "destroyed"]) {
      await rememberSession({ place: "dl-test", repository: "me/app", root: dir, conversationId: OLD_ID });
      api.conversations.delete(OLD_ID);
      if (status) api.conversations.set(OLD_ID, status);
      const io = capture();
      assert.equal(await session({ cwd: dir, continue: true }, io), 0);
      assert.match(io.text(), /! The last conversation for me\/app on dl-test is gone; starting a new one\./);
      assert.equal(flag(autopilot.launches.at(-1)!.args, "--conversation"), undefined);
      assert.equal(flag(autopilot.launches.at(-1)!.args, "--repo"), "me/app");
      assert.ok(!(await loadSessions()).some((entry) => entry.conversationId === OLD_ID), "the gone one is forgotten");
    }
  });

  it("dl new is an alias of bare dl: a new conversation, the old one stays in the history", { timeout: 30_000 }, async () => {
    await saveRemote(place("dl-test", api.url));
    const dir = await checkout();
    await rememberSession({ place: "dl-test", repository: "me/app", root: dir, conversationId: OLD_ID });
    api.conversations.set(OLD_ID, "ready");
    assert.equal(await session({ cwd: dir }, capture()), 0);
    assert.equal(flag(autopilot.launches[0]!.args, "--conversation"), undefined);
    assert.deepEqual((await loadSessions()).map((entry) => entry.conversationId).sort(), [NEW_ID, OLD_ID].sort());
  });

  it("says in one line when an earlier session here is still live", { timeout: 30_000 }, async () => {
    await saveRemote(place("dl-test", api.url));
    const dir = await checkout();
    const clone = await checkout("second");
    await rememberSession({ place: "dl-test", repository: "me/app", root: dir, conversationId: OLD_ID });
    api.conversations.set(OLD_ID, "running");
    api.activeRuns.set(OLD_ID, "run-1");

    const working = capture();
    assert.equal(await session({ cwd: dir }, working), 0);
    assert.match(working.text(), / {2}1 earlier session here is still working · dl -c to rejoin\n/);
    assert.equal(working.text().match(/earlier session/g)?.length, 1, "one line, nothing else");

    // Waiting for the person reads differently.
    api.conversations.set(OLD_ID, "waiting_approval");
    api.activeRuns.delete(OLD_ID);
    const waiting = capture();
    assert.equal(await session({ cwd: dir }, waiting), 0);
    assert.match(waiting.text(), /1 earlier session here is waiting for you · dl -c to rejoin/);

    // Two live ones: plural.
    api.conversations.set(NEW_ID, "running");
    api.activeRuns.set(NEW_ID, "run-2");
    const both = capture();
    assert.equal(await session({ cwd: dir }, both), 0);
    assert.match(both.text(), /2 earlier sessions here are still working · dl -c to rejoin/);

    // Nothing live: no line.
    for (const id of [OLD_ID, NEW_ID]) {
      api.conversations.set(id, "completed");
      api.activeRuns.delete(id);
    }
    const quiet = capture();
    assert.equal(await session({ cwd: dir }, quiet), 0);
    assert.doesNotMatch(quiet.text(), /earlier session/);

    // Another checkout has no earlier session here, so nothing to say.
    api.conversations.set(OLD_ID, "running");
    api.activeRuns.set(OLD_ID, "run-1");
    const elsewhere = capture();
    assert.equal(await session({ cwd: clone }, elsewhere), 0);
    assert.doesNotMatch(elsewhere.text(), /earlier session/);
  });

  it("holds the SSH tunnel open for the whole session and closes it when Autopilot exits", { timeout: 30_000 }, async () => {
    await saveRemote(place("box", "http://127.0.0.1:4096", { ssh: { target: "root@203.0.113.10" } }));
    const tunnels = fakeTunnels(Number(new URL(api.url).port), { delayMs: 5 });
    autopilot.tunnels = tunnels.spawned;
    const open = createOpener({ spawn: tunnels.spawn, pollMs: 5 });
    const dir = await checkout();
    assert.equal(await session({ cwd: dir, open }, capture()), 0);
    assert.equal(tunnels.spawned.length, 1);
    const launch = autopilot.launches[0]!;
    assert.equal(launch.tunnelsOpen, true, "open while Autopilot runs");
    const port = Number(tunnels.spawned[0]!.args.at(-2)!.split(":")[1]);
    assert.equal(launch.env.AUTOPILOT_REMOTE_URL, `http://127.0.0.1:${port}`, "Autopilot talks to the local end of the tunnel");
    assert.equal(tunnels.spawned[0]!.killed, true, "closed afterwards");
  });

  it("doesn't stop on Ctrl-C while Autopilot runs, and passes SIGTERM and SIGHUP on", { timeout: 30_000 }, async () => {
    await saveRemote(place("dl-test", api.url));
    const dir = await checkout();
    const signals = new EventEmitter();
    autopilot.hold = true;
    const io = capture();
    const running = session({ cwd: dir, signals }, io);
    while (autopilot.children.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const child = autopilot.children[0]!;
    signals.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(child.signals, [], "Autopilot gets Ctrl-C from the terminal itself");
    signals.emit("SIGTERM");
    assert.equal(await running, 1);
    assert.deepEqual(child.signals, ["SIGTERM"]);
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) assert.equal(signals.listenerCount(name), 0, `${name} handler removed`);
    assert.doesNotMatch(io.text(), /It keeps running/);
    assert.deepEqual((await loadSessions()).map((entry) => entry.conversationId), [NEW_ID], "remembered even so");
  });

  it("Ctrl-C before Autopilot starts stops dl and closes the connection", async () => {
    await saveRemote(place("dl-test", api.url));
    const dir = await checkout();
    const signals = new EventEmitter();
    let closed = false;
    const open: RemoteOpener = async () => {
      setTimeout(() => signals.emit("SIGINT"), 5);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { url: api.url, close: async () => { closed = true; } };
    };
    const running = session({ cwd: dir, signals, open }, capture());
    assert.equal(await running, 130);
    assert.equal(closed, true);
    assert.equal(autopilot.launches.length, 0);
  });

  it("opens a new chat outside a repository every time, with the place's default model", { timeout: 30_000 }, async () => {
    await saveRemote(place("dl-test", api.url));
    api.models = ["deepseek-v4-pro", "deepseek-v4-flash"];
    api.provider = { id: "deepseek", name: "DeepSeek" };
    api.defaultModel = "deepseek-v4-pro";
    const plain = join(root, "plain");
    await mkdir(plain);
    const first = capture();
    assert.equal(await session({ cwd: plain }, first), 0);
    const args = autopilot.launches[0]!.args.slice(1);
    assert.equal(args[0], "attach-remote");
    assert.equal(flag(args, "--kind"), "chat");
    assert.equal(flag(args, "--workspace"), "default");
    assert.equal(flag(args, "--model"), "deepseek-v4-pro", "the model chosen in Autopilot's picker, as the place reports it");
    assert.equal(flag(args, "--title"), "dl-test · chat");
    assert.ok(!args.includes("--repo") && !args.includes("--base-commit") && !args.includes("--patch-file"), "no repository, no snapshot");
    assert.match(first.text(), /· Connecting to dl-test · chat … {2}\(new chat, deepseek-v4-pro\)\n/);
    assert.match(first.text(), /It keeps running on dl-test\. Type dl -c here to come back/);
    assert.deepEqual((await loadSessions()).map(({ updatedAt: _, ...entry }) => entry), [{ place: "dl-test", root: await realpath(plain), kind: "chat", conversationId: CHAT_ID }]);

    // Bare dl again in the same directory: another chat, not the first one.
    const again = capture();
    assert.equal(await session({ cwd: plain }, again), 0);
    assert.equal(flag(autopilot.launches[1]!.args, "--conversation"), undefined);
    assert.equal(flag(autopilot.launches[1]!.args, "--kind"), "chat");
    assert.match(again.text(), /new chat, deepseek-v4-pro/);

    // dl -c: the latest chat here, with no creation flags (attach-remote refuses them).
    const resumed = capture();
    assert.equal(await session({ cwd: plain, continue: true }, resumed), 0);
    assert.equal(flag(autopilot.launches[2]!.args, "--conversation"), CHAT_ID_1);
    assert.equal(autopilot.launches[2]!.args.includes("--kind"), false, "reopening passes no creation flags, which attach-remote refuses");
    assert.equal(autopilot.launches[2]!.refused, undefined);
    assert.match(resumed.text(), /Connecting to dl-test · chat … {2}\(c0ffee00\)/);

    // Another directory gets its own.
    const other = join(root, "other");
    await mkdir(other);
    assert.equal(await session({ cwd: other }, capture()), 0);
    assert.equal(flag(autopilot.launches[3]!.args, "--conversation"), undefined);
    assert.equal((await loadSessions()).length, 3);

    // dl new: the same as bare dl.
    assert.equal(await session({ cwd: plain }, capture()), 0);
    assert.equal(flag(autopilot.launches[4]!.args, "--conversation"), undefined);
    assert.equal((await loadSessions()).length, 4);
  });

  it("opens a chat in a repository that can't have a code session, saying why in one line", { timeout: 30_000 }, async () => {
    await saveRemote(place("dl-test", api.url));
    const elsewhere = join(root, "gitlab");
    git(root, "init", "--quiet", elsewhere);
    git(elsewhere, "remote", "add", "origin", "https://gitlab.com/me/app.git");
    const io = capture();
    assert.equal(await session({ cwd: elsewhere }, io), 0);
    assert.match(io.text(), /! gitlab's origin isn't on GitHub, so this is a chat, not a session on its code\.\n\n {2}· Connecting to dl-test · chat …/);
    assert.equal(flag(autopilot.launches[0]!.args, "--kind"), "chat");
    assert.deepEqual(await planSession(elsewhere), { kind: "chat", root: await realpath(elsewhere), note: "gitlab's origin isn't on GitHub, so this is a chat, not a session on its code." });

    const noRemote = join(root, "loose");
    git(root, "init", "--quiet", noRemote);
    assert.match((await planSession(noRemote)).note ?? "", /loose has no origin remote, so this is a chat/);

    // A GitHub repository with nothing pushed yet can't start a code session: the note, and no chat in its place.
    const fresh = join(root, "fresh");
    git(root, "init", "--quiet", fresh);
    git(fresh, "remote", "add", "origin", "https://github.com/me/fresh.git");
    const empty = capture();
    assert.equal(await session({ cwd: fresh }, empty), undefined);
    assert.match(empty.text(), /! This repository has no commits yet; push a first commit before running remotely\./);
    assert.equal(autopilot.launches.length, 1);
  });

  it("says to pick a place when several are set up and none is the default", async () => {
    await saveRemote(place("a", api.url));
    await saveRemote(place("b", api.url));
    const file = JSON.parse(await readFile(process.env.AUTOPILOT_REMOTES_FILE!, "utf8")) as Record<string, unknown>;
    delete file.default;
    await writeFile(process.env.AUTOPILOT_REMOTES_FILE!, JSON.stringify(file));
    const io = capture();
    assert.equal(await session({ cwd: await checkout() }, io), undefined);
    assert.match(io.text(), /! Several places are set up \(a, b\)\. Pick one with --server NAME/);
    await assert.rejects(() => session({ cwd: join(root, "checkout"), server: "nope" }, capture()), /Nothing named "nope" is set up/);
  });

  it("says how to update when Autopilot is missing or too old", { timeout: 30_000 }, async () => {
    await saveRemote(place("dl-test", api.url));
    const dir = await checkout();
    const missing = capture();
    assert.equal(await session({ cwd: dir, autopilot: async () => undefined }, missing), 1);
    assert.match(missing.text(), /✗ The Autopilot that comes with dl isn't installed\. Update: npm install -g directionallylocal/);
    const old = capture();
    assert.equal(await session({ cwd: dir, probe: async () => false }, old), 1);
    assert.match(old.text(), /✗ The Autopilot that comes with dl is too old to open a session\. Update: npm install -g directionallylocal/);
    assert.equal(autopilot.launches.length, 0);
    autopilot.code = 2;
    const unknown = capture();
    assert.equal(await session({ cwd: dir }, unknown), 1);
    assert.match(unknown.text(), /too old to open a session\. Update: npm install -g directionallylocal/);
    const failed = capture();
    autopilot.code = 1;
    assert.equal(await session({ cwd: dir }, failed), 1);
    assert.doesNotMatch(failed.text(), /Update:|It keeps running/, "Autopilot already said what went wrong");
  });
});

/** A stand-in for plain `autopilot`: records how it was started and exits with `code` (unless held). */
class FakePlainAutopilot {
  readonly launches: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string | undefined }> = [];
  readonly children: Array<EventEmitter & SessionChild & { signals: string[] }> = [];
  code: number | null = 0;
  hold = false;
  readonly spawn: SessionSpawner = (command, args, env, options = {}) => {
    this.launches.push({ command, args, env, cwd: options.cwd });
    const child = Object.assign(new EventEmitter(), {
      signals: [] as string[],
      kill(signal?: NodeJS.Signals) {
        child.signals.push(signal ?? "SIGTERM");
        setImmediate(() => child.emit("exit", null, signal ?? "SIGTERM"));
        return true;
      },
    });
    this.children.push(child);
    if (!this.hold) setImmediate(() => child.emit("exit", this.code, null));
    return child;
  };
}

describe("dl on this computer", () => {
  let plain: FakePlainAutopilot;
  beforeEach(() => { plain = new FakePlainAutopilot(); });
  const local = (input: Partial<SessionInput> & { cwd: string }, io: LaptopIO) => session({ spawn: plain.spawn, ...input }, io);

  it("starts plain autopilot in this folder, a new session every time, with nothing sent anywhere", async () => {
    await saveRemote(place(PAIRED_NAME, api.url));
    const dir = await checkout();
    await writeFile(join(dir, "README.md"), "hello\nlocal edit\n");
    const io = capture();
    assert.equal(await local({ cwd: dir }, io), 0);
    assert.equal(await local({ cwd: dir }, io), 0);
    assert.equal(plain.launches.length, 2);
    for (const launch of plain.launches) {
      assert.equal(launch.command, AUTOPILOT.command);
      assert.deepEqual(launch.args, AUTOPILOT.args, "just `autopilot`: no attach-remote, no flags");
      assert.equal(launch.cwd, dir);
      assert.equal(launch.env.AUTOPILOT_REMOTE_URL, undefined);
      assert.equal(launch.env.AUTOPILOT_REMOTE_TOKEN, undefined);
    }
    assert.equal(io.text(), "", "dl gets out of the way: Autopilot owns the terminal");
    assert.deepEqual(api.requests, [], "the local server isn't asked anything");
    assert.equal(autopilot.launches.length, 0);
    assert.deepEqual(await loadSessions(), [], "nothing remembered: going back is Autopilot's /resume and -c");
  });

  it("works in a folder that isn't a git repository, or whose origin isn't on GitHub", async () => {
    await saveRemote(place(PAIRED_NAME, api.url));
    const loose = join(root, "loose");
    await mkdir(loose);
    const gitlab = join(root, "gitlab");
    git(root, "init", "--quiet", gitlab);
    git(gitlab, "remote", "add", "origin", "https://gitlab.com/me/app.git");
    const fresh = join(root, "fresh");
    git(root, "init", "--quiet", fresh);
    git(fresh, "remote", "add", "origin", "https://github.com/me/fresh.git");
    for (const dir of [loose, gitlab, fresh]) {
      const io = capture();
      assert.equal(await local({ cwd: dir }, io), 0, dir);
      assert.equal(plain.launches.at(-1)!.cwd, dir);
      assert.equal(io.text(), "", "no chat note, no push-first note");
    }
  });

  it("dl -c is autopilot -c; -m and what came after -- pass through", async () => {
    await saveRemote(place(PAIRED_NAME, api.url));
    const dir = join(root, "plain");
    await mkdir(dir);
    assert.equal(await local({ cwd: dir, continue: true }, capture()), 0);
    assert.deepEqual(plain.launches[0]!.args, [...AUTOPILOT.args, "-c"]);
    assert.equal(await local({ cwd: dir, model: "deepseek-v4-pro", args: ["--session", "abc", "fix it"] }, capture()), 0);
    assert.deepEqual(plain.launches[1]!.args, [...AUTOPILOT.args, "-m", "deepseek-v4-pro", "--session", "abc", "fix it"]);
    assert.equal(await local({ cwd: dir, continue: true, args: ["--verbose"] }, capture()), 0);
    assert.deepEqual(plain.launches[2]!.args, [...AUTOPILOT.args, "-c", "--verbose"]);
  });

  it("returns Autopilot's exit code, and says how to update when it's missing", async () => {
    await saveRemote(place(PAIRED_NAME, api.url));
    const dir = join(root, "plain");
    await mkdir(dir);
    plain.code = 7;
    assert.equal(await local({ cwd: dir }, capture()), 7);
    const missing = capture();
    assert.equal(await local({ cwd: dir, autopilot: async () => undefined }, missing), 1);
    assert.match(missing.text(), /✗ The Autopilot that comes with dl isn't installed\. Update: npm install -g directionallylocal/);
  });

  it("leaves Ctrl-C to Autopilot and passes SIGTERM and SIGHUP on", async () => {
    await saveRemote(place(PAIRED_NAME, api.url));
    const dir = join(root, "plain");
    await mkdir(dir);
    const signals = new EventEmitter();
    plain.hold = true;
    const running = local({ cwd: dir, signals }, capture());
    while (plain.children.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const child = plain.children[0]!;
    signals.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(child.signals, [], "Autopilot gets Ctrl-C from the terminal itself");
    signals.emit("SIGHUP");
    assert.equal(await running, 129);
    assert.deepEqual(child.signals, ["SIGHUP"]);
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) assert.equal(signals.listenerCount(name), 0, `${name} handler removed`);
  });

  it("with a server too, the default place decides, and --server forces the server", { timeout: 30_000 }, async () => {
    await saveRemote(place(PAIRED_NAME, api.url));
    await saveRemote(place("box", api.url));
    const dir = await checkout();
    // This computer is the default (the first one set up): plain autopilot.
    assert.equal(await local({ cwd: dir }, capture()), 0);
    assert.equal(plain.launches.length, 1);
    // --server box: attach-remote on the server, unchanged.
    const named = capture();
    assert.equal(await session({ cwd: dir, server: "box" }, named), 0);
    assert.equal(autopilot.launches.length, 1);
    assert.equal(autopilot.launches[0]!.args[1], "attach-remote");
    assert.equal(flag(autopilot.launches[0]!.args, "--repo"), "me/app");
    assert.match(named.text(), /· Connecting to box · me\/app/);
    // The server as the default: bare dl goes there.
    const file = JSON.parse(await readFile(process.env.AUTOPILOT_REMOTES_FILE!, "utf8")) as Record<string, unknown>;
    await writeFile(process.env.AUTOPILOT_REMOTES_FILE!, JSON.stringify({ ...file, default: "box" }));
    assert.equal(await session({ cwd: dir }, capture()), 0);
    assert.equal(autopilot.launches.length, 2);
    assert.equal(plain.launches.length, 1, "not plain autopilot");
    assert.equal(autopilot.launches[1]!.args[1], "attach-remote");
    // ...and --server this-computer brings it back here.
    assert.equal(await local({ cwd: dir, server: PAIRED_NAME }, capture()), 0);
    assert.deepEqual(plain.launches.at(-1)!.args, AUTOPILOT.args);
  });
});

describe("arguments after --", () => {
  it("are split off before dl reads its own flags", () => {
    assert.deepEqual(splitPassthrough(["-c"]), { argv: ["-c"], passthrough: [] });
    assert.deepEqual(splitPassthrough(["-c", "--", "--session", "abc"]), { argv: ["-c"], passthrough: ["--session", "abc"] });
    assert.deepEqual(splitPassthrough(["--", "-m", "x", "--", "y"]), { argv: [], passthrough: ["-m", "x", "--", "y"] });
  });
});

describe("finding Autopilot", () => {
  it("uses the autopilot-ai installed with dl, else one on PATH", async () => {
    assert.match(bundledAutopilot() ?? "", /node_modules[\\/]autopilot-ai[\\/]bin[\\/]autopilot\.mjs$/);
    assert.equal(bundledAutopilot(() => { throw new Error("not found"); }), undefined);
    const bin = join(root, "bin");
    await mkdir(bin);
    assert.equal(await autopilotOnPath({ PATH: bin }), undefined);
    await writeFile(join(bin, "autopilot"), "#!/bin/sh\n");
    assert.equal(await autopilotOnPath({ PATH: bin }), undefined, "not executable");
    await chmod(join(bin, "autopilot"), 0o755);
    assert.equal(await autopilotOnPath({ PATH: `/nonexistent:${bin}` }), join(bin, "autopilot"));
  });

  it("knows an Autopilot has attach-remote when its help lists --state-file", async () => {
    const script = async (name: string, body: string) => {
      const path = join(root, name);
      await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      return { command: path, args: [] };
    };
    assert.equal(await supportsAttachRemote(await script("new", `[ "$1" = attach-remote ] && echo "  --state-file <path>  where to write the conversation"`)), true);
    assert.equal(await supportsAttachRemote(await script("old", `echo "Usage: autopilot [options] [command] [task...]"`)), false);
    assert.equal(await supportsAttachRemote(await script("broken", "exit 1")), false);
    assert.equal(await supportsAttachRemote({ command: join(root, "nope"), args: [] }), false);
  });
});

describe("dl routing for projects", () => {
  it("dl status with nothing set up is the overview of what to type", async () => {
    const cwd = process.cwd();
    const plain = join(root, "plain");
    await mkdir(plain);
    process.chdir(plain);
    try {
      let text = "";
      const io = { out: (chunk: string) => { text += chunk; }, err: (chunk: string) => { text += chunk; } };
      // Not at a terminal, dl new can't open a session, and says so.
      assert.equal(await main(["new"], io, { terminal: false, root: false, serverState: async () => undefined }), 1);
      assert.match(text, /dl new starts a new session in a terminal: dl/);
      await saveRemote(place("dl-test", api.url));
      text = "";
      assert.equal(await main(["status"], io, { terminal: true, root: false, serverState: async () => undefined }), 0);
      assert.match(text, /on this laptop/, "dl status: the overview, anywhere");
      assert.match(text.replace(/\x1b\[[0-9;]*m/g, ""), /Talk to an agent: type {2}dl/);
    } finally {
      process.chdir(cwd);
    }
  });
});

const plainText = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

describe("dl the first time on a laptop", () => {
  let plain: FakePlainAutopilot;
  let setups: SetupOptions[];
  beforeEach(() => { plain = new FakePlainAutopilot(); setups = []; });

  /** main() as a laptop with nothing set up sees it: not root, no server state, fakes for Autopilot and setup. */
  const laptop = (prompter?: ScriptedPrompter, extra: Partial<MainOptions> = {}): MainOptions => ({
    terminal: true,
    root: false,
    serverState: async () => undefined,
    session: { autopilot: async () => AUTOPILOT, probe: async () => true, placeModel: async () => undefined, spawn: plain.spawn, signals: new EventEmitter() },
    setup: async (options) => { setups.push(options); return 0; },
    ...(prompter ? { prompter } : {}),
    ...extra,
  });

  async function inside<T>(dir: string, work: () => Promise<T>): Promise<T> {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      return await work();
    } finally {
      process.chdir(cwd);
    }
  }

  it("bare dl is plain autopilot in this folder, with nothing set up, installed or asked first", async () => {
    const dir = join(root, "fresh");
    await mkdir(dir);
    const io = capture();
    const prompter = new ScriptedPrompter({});
    assert.equal(await inside(dir, () => main([], io, laptop(prompter))), 0);
    assert.equal(plain.launches.length, 1);
    assert.deepEqual(plain.launches[0]!.args, AUTOPILOT.args, "just `autopilot`: its own first run picks the provider");
    assert.equal(plain.launches[0]!.cwd, dir);
    assert.equal(plain.launches[0]!.env.AUTOPILOT_LAUNCHED_BY, "dl", "Autopilot knows dl started it, so its exit hint says dl -c");
    assert.equal(plain.launches[0]!.env.PATH, process.env.PATH, "the rest of the environment is the person's own");
    assert.deepEqual(setups, [], "no setup wizard: no place, no Docker, no sandbox image, no services");
    assert.deepEqual(prompter.asked, [], "nothing asked: no place, no provider picker, no GitHub token");
    assert.equal(io.text(), "", "dl gets out of the way");
    assert.deepEqual(await loadRemotes(), [], "nothing saved: still nothing set up");
    // dl -c and dl new are plain autopilot too, and what came after -- passes through.
    assert.equal(await inside(dir, () => main(["-c"], capture(), laptop())), 0);
    assert.deepEqual(plain.launches[1]!.args, [...AUTOPILOT.args, "-c"]);
    assert.equal(await inside(dir, () => main(["new", "--", "--verbose"], capture(), laptop())), 0);
    assert.deepEqual(plain.launches[2]!.args, [...AUTOPILOT.args, "--verbose"]);
    assert.equal(api.requests.length, 0);
  });

  it("only needs a Node that Autopilot runs on", async () => {
    const dir = join(root, "fresh");
    await mkdir(dir);
    const io = capture();
    assert.equal(await startHere({ cwd: dir, autopilot: async () => AUTOPILOT, spawn: plain.spawn, signals: new EventEmitter(), nodeVersion: "20.11.0" }, io), 1);
    assert.match(io.text(), /✗ Node\.js 20 is unsupported[\s\S]*Update Node \(nodejs\.org, or your package manager\), then run dl again\./);
    assert.equal(plain.launches.length, 0);
    assert.equal(await startHere({ cwd: dir, autopilot: async () => AUTOPILOT, spawn: plain.spawn, signals: new EventEmitter(), nodeVersion: "24.22.1" }, capture()), 0);
    assert.equal(plain.launches.length, 1);
  });

  it("as root, or without a terminal, says what this is instead", async () => {
    for (const [options, says] of [[{ root: true }, /isn't set up on this machine/], [{ terminal: false }, /on this laptop[\s\S]*dl -c {7}continue the last session there/]] as const) {
      const io = capture();
      assert.equal(await main([], io, laptop(undefined, options)), 0);
      assert.match(io.text(), says);
      assert.equal(plain.launches.length, 0);
      assert.deepEqual(setups, []);
    }
  });

  it("with this computer set up, bare dl and dl -c are unchanged; with a server as the default, so is the session there", { timeout: 30_000 }, async () => {
    await saveRemote(place(PAIRED_NAME, api.url));
    const dir = await checkout();
    assert.equal(await inside(dir, () => main([], capture(), laptop())), 0);
    assert.equal(await inside(dir, () => main(["-c"], capture(), laptop())), 0);
    assert.deepEqual(plain.launches.map((launch) => launch.args), [AUTOPILOT.args, [...AUTOPILOT.args, "-c"]]);
    assert.deepEqual(setups, []);

    await saveRemote(place("box", api.url));
    const file = JSON.parse(await readFile(process.env.AUTOPILOT_REMOTES_FILE!, "utf8")) as Record<string, unknown>;
    await writeFile(process.env.AUTOPILOT_REMOTES_FILE!, JSON.stringify({ ...file, default: "box" }));
    const io = capture();
    assert.equal(await inside(dir, () => main([], io, laptop(undefined, { session: { autopilot: async () => AUTOPILOT, probe: async () => true, placeModel: async () => undefined, spawn: autopilot.spawn, signals: new EventEmitter() } }))), 0);
    assert.equal(autopilot.launches[0]!.args[1], "attach-remote");
    assert.match(plainText(io.text()), /· Connecting to box \(default\) · me\/app/);
    assert.equal(plain.launches.length, 2, "not plain autopilot");
  });

  it("dl run with nowhere to send tasks asks where they run, sets that up, then sends the task", { timeout: 30_000 }, async () => {
    const dir = await checkout();
    const runs: Array<{ task: string; cwd: string }> = [];
    for (const [answer, expected] of [["2", "local"], ["1", "server"]] as const) {
      setups = [];
      const prompter = new ScriptedPrompter({ "Where should they run?": answer });
      const io = capture();
      const code = await inside(dir, () => main(["run", "fix", "the", "test"], io, laptop(prompter, {
        setup: async (options) => { setups.push(options); await saveRemote(place(expected === "local" ? PAIRED_NAME : "box", api.url)); return 0; },
        run: async (input) => { runs.push({ task: input.task, cwd: input.cwd }); return 0; },
      })));
      assert.equal(code, 0);
      assert.match(plainText(io.text()), /Background tasks keep going when this laptop sleeps\./);
      assert.deepEqual(prompter.asked.map((question) => plainText(question).trim()), ["Where should they run?"]);
      assert.equal(setups.length, 1);
      assert.equal(setups[0]!.place, expected, "straight into that setup, without asking where again");
      assert.equal(runs.at(-1)!.task, "fix the test");
      await writeFile(process.env.AUTOPILOT_REMOTES_FILE!, JSON.stringify({ remotes: [] }));
    }
    assert.equal(runs.length, 2);
  });

  it("dl run asks nothing once a place is set up, and outside a GitHub repository stops before asking", async () => {
    const loose = join(root, "loose");
    await mkdir(loose);
    const prompter = new ScriptedPrompter({});
    const io = capture();
    assert.equal(await inside(loose, () => main(["run", "fix it"], io, laptop(prompter, { run: async () => 0 }))), 1);
    assert.match(io.text(), /no "origin" git remote; pass --repo owner\/name/);
    assert.deepEqual(prompter.asked, []);
    assert.deepEqual(setups, []);

    await saveRemote(place("box", api.url));
    let sent = 0;
    assert.equal(await inside(loose, () => main(["run", "fix it"], capture(), laptop(prompter, { run: async () => { sent++; return 0; } }))), 0);
    assert.equal(sent, 1);
    assert.deepEqual(prompter.asked, []);
    assert.deepEqual(setups, []);
  });

  it("dl setup still sets things up when asked", async () => {
    assert.equal(await main(["setup"], capture(), laptop()), 0);
    assert.equal(setups.length, 1);
    assert.equal(setups[0]!.place, undefined, "its own question: where should they run");
  });
});
