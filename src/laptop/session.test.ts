import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { main } from "../cli.js";
import { PATHS } from "../layout.js";
import { ScriptedPrompter } from "../prompt.js";
import { fakeTunnels, type FakeTunnel } from "../test-support/fake-tunnel.js";
import { DEFAULT_MODEL, type LaptopIO } from "./commands.js";
import { saveRemote, type RemoteServer } from "./config.js";
import { autopilotOnPath, bundledAutopilot, openSession, planSession, projectSession, supportsAttachRemote, type AutopilotCommand, type SessionChild, type SessionInput } from "./session.js";
import { loadSessions, rememberSession } from "./session-store.js";
import { createOpener, type RemoteOpener } from "./tunnel.js";

const TOKEN = "aster_laptop_token_0000000000000000000000000000000000";
const NEW_ID = "7c1d2e3f-0000-4000-8000-000000000000";
const OLD_ID = "3f2a9c1e-0000-4000-8000-000000000000";
const CHAT_ID = "c0ffee00-0000-4000-8000-000000000000";

/** The parts of the API a session asks for: workspaces, models, and one conversation. */
class FakeApi {
  models = ["01-ai/yi-large", DEFAULT_MODEL];
  /** A newer server also says which provider the catalog comes from, and its default model. */
  provider: { id: string; name: string } | undefined;
  defaultModel: string | undefined;
  /** Conversation ID -> status; missing means 404. */
  readonly conversations = new Map<string, string>();
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
    if (status) return send(200, { conversationId: id, workspaceId: "default", model: DEFAULT_MODEL, status, activeRunId: null, lastEventId: 1, createdAt: "", updatedAt: "", kind: id.startsWith("c") ? "chat" : "code", ...(id.startsWith("c") ? {} : { repository: "me/app" }) });
    send(404, { error: { code: "not_found", message: "No such conversation" } });
  }
}

interface Launch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  patch?: string;
  patchMode?: number;
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

  constructor(private readonly api: FakeApi) {}

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
      const patchFile = args.includes("--patch-file") ? flag("--patch-file") : undefined;
      if (patchFile) {
        launch.patch = await readFile(patchFile, "utf8");
        launch.patchMode = (await stat(patchFile)).mode & 0o777;
      }
      const chat = args.includes("--kind") && flag("--kind") === "chat";
      const id = args.includes("--conversation") ? flag("--conversation")! : chat ? CHAT_ID : NEW_ID;
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

function session(input: Partial<SessionInput> & { cwd: string }, io: LaptopIO, open: typeof openSession | typeof projectSession = openSession): Promise<number | undefined> {
  return open({
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
  it("creates a conversation from this checkout the first time, then reconnects to it", { timeout: 30_000 }, async () => {
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
    assert.match(first.text(), /It keeps running on dl-test\. Type dl here to come back, or dl runs\.\n/);

    const file = join(root, "config", "directionallylocal", "sessions.json");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, "config", "directionallylocal"))).mode & 0o777, 0o700);
    assert.deepEqual((await loadSessions(file)).map(({ updatedAt: _, ...entry }) => entry), [
      { place: "dl-test", repository: "me/app", root: dir, conversationId: NEW_ID, branch: "aster/7c1d2e3f" },
    ]);

    const again = capture();
    assert.equal(await session({ cwd: join(dir) }, again), 0);
    const reconnect = autopilot.launches[1]!.args.slice(1);
    assert.equal(flag(reconnect, "--conversation"), NEW_ID);
    assert.equal(reconnect.includes("--workspace"), false);
    assert.equal(reconnect.includes("--patch-file"), false);
    assert.match(again.text(), /Connecting to dl-test · me\/app … {2}\(7c1d2e3f\)/);
    assert.equal((await loadSessions(file)).length, 1);
  });

  it("checks the place has a provider before opening anything", { timeout: 30_000 }, async () => {
    await saveRemote(place("dl-test", api.url));
    const dir = await checkout();
    const asked: string[] = [];
    const io = capture();
    assert.equal(await session({ cwd: dir, ensureProvider: async (remote) => { asked.push(remote.name); return false; } }, io), undefined);
    assert.deepEqual(asked, ["dl-test"]);
    assert.equal(autopilot.launches.length, 0, "no session before the provider is set up");
    assert.equal(io.text(), "", "the check says its own line; nothing else is printed");
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

  it("keeps one conversation per place and per checkout", { timeout: 30_000 }, async () => {
    await saveRemote(place("dl-test", api.url));
    await saveRemote(place("other", api.url));
    const dir = await checkout();
    const clone = await checkout("second");
    await rememberSession({ place: "dl-test", repository: "me/app", root: dir, conversationId: OLD_ID });
    api.conversations.set(OLD_ID, "completed");
    const byDefault = capture();
    assert.equal(await session({ cwd: clone }, byDefault), 0);
    assert.equal(flag(autopilot.launches[0]!.args, "--conversation"), undefined, "another checkout starts its own");
    // Two places: the line says why this one, and how to pick the other (once, not a second "on dl-test").
    assert.match(byDefault.text(), /· Connecting to dl-test \(default\) · me\/app … .*\n {4}dl use NAME to change where dl runs\n/);
    assert.equal(byDefault.text().match(/dl-test/g)?.length, 2, "the place is named on the Connecting line and the goodbye line only");
    const named = capture();
    assert.equal(await session({ cwd: dir, server: "other" }, named), 0);
    assert.equal(flag(autopilot.launches[1]!.args, "--conversation"), undefined, "another place starts its own");
    assert.match(named.text(), /· Connecting to other · me\/app/);
    assert.doesNotMatch(named.text(), /dl use NAME/, "a place named with --server needs no hint");
    assert.equal(await session({ cwd: dir }, capture()), 0);
    assert.equal(flag(autopilot.launches[2]!.args, "--conversation"), OLD_ID, "the default place reopens it");
    assert.equal((await loadSessions()).length, 3);
  });

  it("starts a new conversation when the remembered one is gone", { timeout: 30_000 }, async () => {
    await saveRemote(place("dl-test", api.url));
    const dir = await checkout();
    for (const status of [undefined, "destroyed"]) {
      await rememberSession({ place: "dl-test", repository: "me/app", root: dir, conversationId: OLD_ID });
      api.conversations.delete(OLD_ID);
      if (status) api.conversations.set(OLD_ID, status);
      const io = capture();
      assert.equal(await session({ cwd: dir }, io), 0);
      assert.match(io.text(), /! The last conversation for me\/app on dl-test is gone; starting a new one\./);
      assert.equal(flag(autopilot.launches.at(-1)!.args, "--conversation"), undefined);
      assert.equal(flag(autopilot.launches.at(-1)!.args, "--repo"), "me/app");
      assert.deepEqual((await loadSessions()).map((entry) => entry.conversationId), [NEW_ID]);
    }
  });

  it("dl new starts a fresh conversation and forgets the remembered one", { timeout: 30_000 }, async () => {
    await saveRemote(place("dl-test", api.url));
    const dir = await checkout();
    await rememberSession({ place: "dl-test", repository: "me/app", root: dir, conversationId: OLD_ID });
    api.conversations.set(OLD_ID, "ready");
    assert.equal(await session({ cwd: dir, fresh: true }, capture()), 0);
    assert.equal(flag(autopilot.launches[0]!.args, "--conversation"), undefined);
    assert.ok(!api.requests.includes(`GET /api/v1/conversations/${OLD_ID}`), "doesn't even ask about the old one");
    assert.deepEqual((await loadSessions()).map((entry) => entry.conversationId), [NEW_ID]);
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

  it("opens a chat outside a repository, remembered per directory, with the place's default model", { timeout: 30_000 }, async () => {
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
    assert.match(first.text(), /It keeps running on dl-test\. Type dl here to come back/);
    assert.deepEqual((await loadSessions()).map(({ updatedAt: _, ...entry }) => entry), [{ place: "dl-test", root: await realpath(plain), kind: "chat", conversationId: CHAT_ID }]);

    // dl again in the same directory resumes it; another directory gets its own.
    const again = capture();
    assert.equal(await session({ cwd: plain }, again), 0);
    assert.equal(flag(autopilot.launches[1]!.args, "--conversation"), CHAT_ID);
    assert.equal(flag(autopilot.launches[1]!.args, "--kind"), "chat");
    assert.match(again.text(), /Connecting to dl-test · chat … {2}\(c0ffee00\)/);
    const other = join(root, "other");
    await mkdir(other);
    assert.equal(await session({ cwd: other }, capture()), 0);
    assert.equal(flag(autopilot.launches[2]!.args, "--conversation"), undefined);
    assert.equal((await loadSessions()).length, 2);

    // dl new: a fresh chat here.
    assert.equal(await session({ cwd: plain, fresh: true }, capture()), 0);
    assert.equal(flag(autopilot.launches[3]!.args, "--conversation"), undefined);
    assert.equal((await loadSessions()).length, 2);
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

    // projectSession (dl new's older contract) still opens code sessions only, with the same note.
    const quiet = capture();
    assert.equal(await session({ cwd: elsewhere }, quiet, projectSession), undefined);
    assert.match(quiet.text(), /! gitlab's origin isn't on GitHub/);
    const plain = join(root, "plain");
    await mkdir(plain);
    assert.equal(await session({ cwd: plain }, capture(), projectSession), undefined);
    assert.deepEqual(await planSession(plain), { kind: "chat", root: await realpath(plain) });
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
  it("dl new with nothing set up says what to do; dl status is the overview", async () => {
    const cwd = process.cwd();
    const plain = join(root, "plain");
    await mkdir(plain);
    process.chdir(plain);
    try {
      let text = "";
      const io = { out: (chunk: string) => { text += chunk; }, err: (chunk: string) => { text += chunk; } };
      assert.equal(await main(["new"], io, { terminal: true }), 1);
      assert.match(text, /dl new starts a fresh conversation once something is set up: dl/);
      // On an installed server, dl status shows the server's overview instead.
      if (!existsSync(PATHS.state)) {
        await saveRemote(place("dl-test", api.url));
        text = "";
        assert.equal(await main(["status"], io, { terminal: true }), 0);
        assert.match(text, /on this laptop/, "dl status: the overview, anywhere");
        assert.match(text.replace(/\x1b\[[0-9;]*m/g, ""), /Talk to an agent: type {2}dl/);
      }
    } finally {
      process.chdir(cwd);
    }
  });
});
