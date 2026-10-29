import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cancel, connect, DEFAULT_MODEL, failureHint, failureReason, laptopHome, pickModel, pull, readAutopilotModel, run, runs, servers, use, watch, wrap, type LaptopIO } from "./commands.js";
import { fakeTunnels } from "../test-support/fake-tunnel.js";
import { loadRemotes, loadRemotesFile, saveRemote, type RemoteServer } from "./config.js";
import { createOpener } from "./tunnel.js";

/**
 * A small stand-in for a Directionally Local server's API (Autopilot's /api/v1): device
 * pairing, code conversations, turns, SSE events, listing, and cancel.
 */
class FakeServer {
  approved = false;
  /** In the order OpenRouter's catalog might list them: the first is never the right pick. */
  models = ["01-ai/yi-large", DEFAULT_MODEL, "test/model"];
  readonly created: Array<Record<string, unknown>> = [];
  readonly cancelled: string[] = [];
  /** The run fails with this reason instead of completing. */
  failWith: string | undefined;
  /** Which field the failed event carries the reason in. */
  failKey: "error" | "reason" = "error";
  private conversation: Record<string, unknown> | undefined;
  private server: Server | undefined;
  url = "";

  async start(): Promise<void> {
    this.server = createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    this.url = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await new Promise<Record<string, unknown>>((resolve) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
      req.on("end", () => resolve(raw ? JSON.parse(raw) as Record<string, unknown> : {}));
    });
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const path = new URL(req.url ?? "/", this.url).pathname;
    if (path === "/api/v1/auth/device") return send(200, { deviceCode: "dev-1", userCode: "BCDF-GHJK", verificationUri: `${this.url}/api/v1/auth/approve`, verificationUriComplete: `${this.url}/api/v1/auth/approve?code=BCDF-GHJK`, expiresIn: 600, interval: 1 });
    if (path === "/api/v1/auth/device/token") {
      return this.approved
        ? send(200, { token: "aster_laptop_token_0000000000000000000000000000000000", credentialId: "cred-1", name: "laptop", workspaceIds: ["default"], scopes: [], expiresAt: "2027-01-01T00:00:00.000Z" })
        : send(400, { error: { code: "authorization_pending", message: "waiting" } });
    }
    if (req.headers.authorization !== "Bearer aster_laptop_token_0000000000000000000000000000000000") return send(401, { error: { code: "invalid_credential", message: "no" } });
    if (path === "/api/v1/health") return send(200, { status: "ok", capabilities: [] });
    if (path === "/api/v1/workspaces") return send(200, { workspaces: [{ id: "default", displayName: "Default" }] });
    if (path === "/api/v1/models") return send(200, { models: this.models });
    if (path === "/api/v1/conversations" && req.method === "POST") {
      this.created.push(body);
      this.conversation = { conversationId: "3f2a9c1e-0000-4000-8000-000000000000", workspaceId: "default", model: "test/model", status: "ready", activeRunId: null, lastEventId: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), kind: "code", repository: "me/app", branch: "aster/3f2a9c1e" };
      return send(201, this.conversation);
    }
    if (path === "/api/v1/conversations" && req.method === "GET") return send(200, { conversations: this.conversation ? [this.conversation] : [] });
    if (path.endsWith("/turns")) {
      this.conversation = this.failWith
        ? { ...this.conversation, status: "failed", lastEventId: 4 }
        : { ...this.conversation, status: "completed", lastEventId: 4, pullRequestURL: "https://github.com/me/app/pull/42" };
      return send(202, { runId: "run-1", status: "running" });
    }
    if (path.endsWith("/cancel")) {
      this.cancelled.push(path);
      return send(200, { ...this.conversation, status: "cancelled" });
    }
    if (path.endsWith("/events")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const after = Number(req.headers["last-event-id"] ?? 0);
      const events = [
        [2, "tool.activity", { tool: "shell", activity: "started", input: "npm test" }],
        [3, "assistant.delta", { text: "Fixed the flaky test." }],
        [4, this.failWith ? "failed" : "completed", this.failWith ? { [this.failKey]: this.failWith } : {}],
      ] as const;
      for (const [id, type, data] of events) if (id > after) res.write(`id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      return;
    }
    if (path.startsWith("/api/v1/conversations/")) return send(200, this.conversation);
    send(404, { error: { code: "not_found", message: path } });
  }
}

const roots: string[] = [];
let fake: FakeServer;
const previous = process.env.AUTOPILOT_REMOTES_FILE;

beforeEach(async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dl-laptop-")));
  roots.push(root);
  process.env.AUTOPILOT_REMOTES_FILE = join(root, "remotes.json");
  process.env.DL_NO_BROWSER = "1";
  fake = new FakeServer();
  await fake.start();
});

afterEach(async () => {
  await fake.stop();
  if (previous === undefined) delete process.env.AUTOPILOT_REMOTES_FILE;
  else process.env.AUTOPILOT_REMOTES_FILE = previous;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const noAutopilotModel = async () => undefined;
const TOKEN = "aster_laptop_token_0000000000000000000000000000000000";

function place(name: string, url: string): RemoteServer {
  return { name, url, token: TOKEN, credentialId: `cred-${name}`, expiresAt: "2027-01-01T00:00:00.000Z", addedAt: "2026-10-28T00:00:00.000Z" };
}

function capture(): LaptopIO & { text: () => string } {
  let text = "";
  return { out: (chunk) => { text += chunk; }, err: (chunk) => { text += chunk; }, color: false, text: () => text };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
}

async function checkout(): Promise<string> {
  const root = roots[0]!;
  const origin = join(root, "origin.git");
  const dir = join(root, "checkout");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  execFileSync("git", ["clone", "--quiet", origin, dir], { stdio: "ignore" });
  await writeFile(join(dir, "README.md"), "hello\n");
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "initial");
  git(dir, "push", "--quiet", "origin", "main");
  return dir;
}

describe("dl on a laptop", () => {
  it("connects, runs a task with local changes, lists it, replays it, and pulls its branch", { timeout: 30_000 }, async () => {
    const io = capture();
    const connecting = connect({ url: fake.url, name: "box", sleep: async () => { fake.approved = true; } }, io);
    await connecting;
    assert.match(io.text(), /Approve code BCDF-GHJK in the browser you approve laptops with/);
    assert.match(io.text(), /Or on the server: dl connect-laptop BCDF-GHJK/);
    assert.match(io.text(), /✓ Connected as box/);
    assert.match(io.text(), /Next, from inside a GitHub repository:\n +dl run "fix the flaky checkout test"/);
    assert.doesNotMatch(io.text(), /\x1b\[/, "no cursor codes without a terminal");
    assert.deepEqual((await loadRemotes()).map((remote) => remote.name), ["box"]);

    const dir = await checkout();
    await writeFile(join(dir, "README.md"), "hello\nlocal edit\n");
    const runIO = capture();
    assert.equal(await run({ task: "fix the flaky test", cwd: dir, repository: "me/app", autopilotModel: noAutopilotModel }, runIO), 0);
    assert.match(String(fake.created[0]?.patch), /\+local edit/);
    assert.equal(fake.created[0]?.model, DEFAULT_MODEL, "not the first in the catalog");
    const text = runIO.text();
    assert.match(text, /Sending to box: me\/app at [0-9a-f]{7} \+ 1 local change {2}deepseek\/deepseek-v4\.1-flash-1017\n/);
    assert.match(text, /✓ Started 3f2a9c1e on box/);
    assert.match(text, /› shell npm test/);
    assert.match(text, /Fixed the flaky test\./);
    assert.match(text, /✓ 3f2a9c1e done {2}https:\/\/github\.com\/me\/app\/pull\/42/);
    assert.match(text, /Check it out here: dl pull 3f2a9c1e/);

    const listIO = capture();
    await runs({}, listIO);
    assert.match(listIO.text(), /✓ 3f2a9c1e {2}completed +me\/app/);

    const replay = capture();
    assert.equal(await watch({ id: "3f2a9c1e" }, replay), 0);
    assert.match(replay.text(), /Fixed the flaky test\./);

    git(dir, "stash", "--quiet");
    git(dir, "push", "--quiet", "origin", "HEAD:refs/heads/aster/3f2a9c1e");
    const pullIO = capture();
    await pull({ id: "3f2a9c1e", cwd: dir }, pullIO);
    assert.equal(git(dir, "branch", "--show-current"), "aster/3f2a9c1e");

    const stopIO = capture();
    await cancel({ id: "3f2a9c1e" }, stopIO);
    assert.equal(fake.cancelled.length, 1);
  });

  it("explains a model the server has no price for", { timeout: 30_000 }, async () => {
    await saveRemote(place("box", fake.url));
    const dir = await checkout();
    fake.failWith = "HTTP 403: model not priced: openai/gpt-6-luna — a spend cap applies, so the gateway can only forward models with a known price (add it via HOTCELL_MODEL_PRICES)";
    const io = capture();
    assert.equal(await run({ task: "fix it", cwd: dir, repository: "me/app", autopilotModel: noAutopilotModel }, io), 1);
    assert.match(io.text(), /✗ 3f2a9c1e failed\n {4}HTTP 403: model not priced[\s\S]*\n {2}This model isn't in your server's price list yet\. Run dl setup to refresh it, or pick another model with -m\./);
    const replay = capture();
    assert.equal(await watch({ id: "3f2a9c1e" }, replay), 1);
    assert.match(replay.text(), /isn't in your server's price list yet/);

    fake.failWith = "Docker went away";
    const other = capture();
    assert.equal(await run({ task: "fix it", cwd: dir, repository: "me/app", autopilotModel: noAutopilotModel }, other), 1);
    assert.match(other.text(), /✗ 3f2a9c1e failed/);
    assert.doesNotMatch(other.text(), /price list/);
  });

  it("reaches a server set up over SSH through a tunnel that each command opens and closes", { timeout: 30_000 }, async () => {
    await saveRemote({
      name: "box", url: "http://127.0.0.1:4096", token: "aster_laptop_token_0000000000000000000000000000000000", credentialId: "cred-1",
      expiresAt: "2027-01-01T00:00:00.000Z", addedAt: "2026-10-28T00:00:00.000Z", ssh: { target: "root@203.0.113.10" },
    });
    const port = Number(new URL(fake.url).port);
    const tunnels = fakeTunnels(port, { delayMs: 5 });
    const open = createOpener({ spawn: tunnels.spawn, pollMs: 5 });
    const dir = await checkout();
    assert.equal(await run({ task: "fix it", cwd: dir, repository: "me/app", open, autopilotModel: noAutopilotModel }, capture()), 0);
    const listIO = capture();
    await runs({ open }, listIO);
    assert.match(listIO.text(), /✓ 3f2a9c1e {2}completed +me\/app/);
    assert.equal(await watch({ id: "3f2a9c1e", open }, capture()), 0);
    await cancel({ id: "3f2a9c1e", open }, capture());
    assert.equal(fake.cancelled.length, 1);
    assert.equal(tunnels.spawned.length, 4, "one tunnel per command");
    for (const tunnel of tunnels.spawned) {
      assert.equal(tunnel.killed, true, "closed when the command ended");
      assert.match(tunnel.args.at(-2)!, /^127\.0\.0\.1:\d+:127\.0\.0\.1:4096$/);
      assert.equal(tunnel.args.at(-1), "root@203.0.113.10");
    }
    const list = capture();
    assert.equal(await servers([], list), 0);
    assert.match(list.text(), /● box +ssh root@203\.0\.113\.10/);
  });

  it("says why a task can't be found when the tunnel fails", async () => {
    await saveRemote({
      name: "box", url: "http://127.0.0.1:4096", token: "t", credentialId: "c", expiresAt: "2027-01-01T00:00:00.000Z", addedAt: "2026-10-28T00:00:00.000Z", ssh: { target: "root@203.0.113.10" },
    });
    const open = createOpener({ spawn: fakeTunnels(undefined, { failWith: "ssh: connect to host 203.0.113.10 port 22: Operation timed out" }).spawn, pollMs: 5 });
    await assert.rejects(() => cancel({ id: "3f2a9c1e", open }, capture()), /No task 3f2a9c1e on any connected server\nbox: Couldn't open an SSH tunnel to box[\s\S]*Operation timed out/);
  });

  it("renames a server with dl servers rename", async () => {
    await saveRemote({
      name: "91-107-187-162", url: "http://127.0.0.1:4096", token: "t", credentialId: "c", expiresAt: "2027-01-01T00:00:00.000Z", addedAt: "2026-10-28T00:00:00.000Z", ssh: { target: "root@91.107.187.162" },
    });
    const io = capture();
    assert.equal(await servers(["rename", "91-107-187-162", "hetzner"], io), 0);
    assert.match(io.text(), /✓ Renamed 91-107-187-162 to hetzner/);
    assert.deepEqual((await loadRemotes()).map((remote) => [remote.name, remote.ssh?.target]), [["hetzner", "root@91.107.187.162"]]);

    const bad = capture();
    assert.equal(await servers(["rename", "hetzner", "My Box"], bad), 1);
    assert.match(bad.text(), /✗ "My Box" can't be a server name/);
    assert.equal(await servers(["rename", "nope", "x"], bad), 1);
    assert.match(bad.text(), /No server named "nope"\. Connected: hetzner\./);
    assert.equal(await servers(["rename", "hetzner"], bad), 2);
    assert.match(bad.text(), /Usage: dl servers rename OLD NEW/);
  });

  it("guides a laptop that isn't connected yet", async () => {
    const io = capture();
    await assert.rejects(() => runs({}, io), /Nothing is set up yet\. Run: dl setup {2}\(or, for a server someone else set up: dl connect/);
    assert.equal(await servers([], io), 0);
    assert.match(io.text(), /Nothing set up yet\. {2}dl setup {2}or, for a server someone else set up: dl connect https:\/\/your-server/);
  });

  it("picks the model: -m, else the laptop's model, else DeepSeek Flash, never the first in the catalog", { timeout: 30_000 }, async () => {
    await saveRemote(place("box", fake.url));
    const dir = await checkout();
    const sent = async (input: { model?: string; autopilotModel?: () => Promise<string | undefined> }) => {
      const io = capture();
      assert.equal(await run({ task: "fix it", cwd: dir, repository: "me/app", detach: true, autopilotModel: noAutopilotModel, ...input }, io), 0);
      const model = String(fake.created.at(-1)?.model);
      assert.match(io.text(), new RegExp(`Sending to box: me/app at [0-9a-f]{7} {2}${model.replace(/[./]/g, "\\$&")}\n`), "the first line names the model");
      return model;
    };
    assert.equal(await sent({ model: "test/model", autopilotModel: async () => "01-ai/yi-large" }), "test/model");
    assert.equal(await sent({ autopilotModel: async () => "test/model" }), "test/model");
    assert.equal(await sent({ autopilotModel: async () => "someone/not-offered" }), DEFAULT_MODEL);
    assert.equal(await sent({}), DEFAULT_MODEL);
    await assert.rejects(() => sent({ model: "someone/not-offered" }), /doesn't offer someone\/not-offered\. Pick one: dl run -m <model> "task" {2}\(model IDs: https:\/\/openrouter\.ai\/models\)/);
    fake.models = ["01-ai/yi-large", "test/model"];
    await assert.rejects(() => sent({ autopilotModel: async () => "someone/not-offered" }), /doesn't offer your model \(someone\/not-offered\) or deepseek\/deepseek-v4\.1-flash-1017\. Pick one: dl run -m <model>/);
  });

  it("chooses the model in order, and explains how to pick when none fits", () => {
    const catalog = ["01-ai/yi-large", DEFAULT_MODEL, "openai/gpt-5"];
    assert.equal(pickModel(catalog, "openai/gpt-5", DEFAULT_MODEL), "openai/gpt-5");
    assert.equal(pickModel(catalog, undefined, "openai/gpt-5"), "openai/gpt-5");
    assert.equal(pickModel(catalog, undefined, "kimi-k2.6"), DEFAULT_MODEL, "a Requesty-style ID the server doesn't offer");
    assert.equal(pickModel(catalog, undefined, undefined), DEFAULT_MODEL);
    assert.throws(() => pickModel(["01-ai/yi-large"], undefined, undefined), /doesn't offer deepseek\/deepseek-v4\.1-flash-1017\. Pick one: dl run -m <model> "task" {2}\(model IDs: https:\/\/openrouter\.ai\/models\)/);
    assert.throws(() => pickModel(["01-ai/yi-large"], undefined, DEFAULT_MODEL), /doesn't offer deepseek\/deepseek-v4\.1-flash-1017\. Pick one/);
    assert.throws(() => pickModel([], undefined, undefined), /offers no models/);
  });

  it("reads the laptop's Autopilot model from KIMI_MODEL or its config", async () => {
    const files: Record<string, string> = {
      "/home/me/.config/kimiflare/config.json": JSON.stringify({ model: "openai/gpt-5", openrouterApiKey: "sk-or-x" }),
      "/xdg/kimiflare/config.json": JSON.stringify({ model: " anthropic/claude-x " }),
      "/bad/kimiflare/config.json": "{ not json",
      "/nomodel/kimiflare/config.json": JSON.stringify({ model: 3 }),
    };
    const readFile = async (path: string) => files[path];
    const read = (env: NodeJS.ProcessEnv) => readAutopilotModel({ env, home: "/home/me", readFile });
    assert.equal(await read({}), "openai/gpt-5");
    assert.equal(await read({ KIMI_MODEL: "moonshotai/kimi-k2.6" }), "moonshotai/kimi-k2.6", "Autopilot's own override wins");
    assert.equal(await read({ XDG_CONFIG_HOME: "/xdg" }), "anthropic/claude-x");
    assert.equal(await read({ XDG_CONFIG_HOME: "/bad" }), undefined);
    assert.equal(await read({ XDG_CONFIG_HOME: "/nomodel" }), undefined);
    assert.equal(await read({ XDG_CONFIG_HOME: "/missing" }), undefined);
  });

  it("sends tasks to the default when several places are set up, and dl use changes it", { timeout: 30_000 }, async () => {
    await saveRemote(place("box", fake.url));
    await saveRemote(place("this-computer", fake.url));
    const dir = await checkout();
    const runIO = capture();
    assert.equal(await run({ task: "fix it", cwd: dir, repository: "me/app", detach: true, autopilotModel: noAutopilotModel }, runIO), 0);
    assert.match(runIO.text(), /Sending to box \(default\): me\/app/);
    assert.equal((await loadRemotesFile()).lastUsed, "box");

    const list = capture();
    await servers([], list);
    assert.match(list.text(), /● box +http:\/\/127\.0\.0\.1:\d+/);
    assert.match(list.text(), /○ this-computer +this computer/);
    assert.match(list.text(), /Change it: dl use NAME/);

    const shown = capture();
    assert.equal(await use([], shown), 0);
    assert.match(shown.text(), /Tasks go to box unless you pass --server NAME\. {2}Change it: dl use NAME \(box, this-computer\)/);
    const bad = capture();
    assert.equal(await use(["nope"], bad), 1);
    assert.match(bad.text(), /✗ Nothing named "nope" is set up\. Set up: box, this-computer/);
    const set = capture();
    assert.equal(await use(["this-computer"], set), 0);
    assert.match(set.text(), /✓ Tasks now go to this-computer this computer unless you pass --server NAME/);
    assert.equal((await loadRemotesFile()).default, "this-computer");

    const again = capture();
    assert.equal(await run({ task: "fix it", cwd: dir, repository: "me/app", detach: true, autopilotModel: noAutopilotModel }, again), 0);
    assert.match(again.text(), /Sending to this-computer \(default\): /);
    const named = capture();
    assert.equal(await run({ task: "fix it", cwd: dir, repository: "me/app", server: "box", detach: true, autopilotModel: noAutopilotModel }, named), 0);
    assert.match(named.text(), /Sending to box: /);

    const home = capture();
    assert.equal(await laptopHome(home, undefined, async () => "test/model"), true);
    assert.match(home.text(), /Coding agents that run on this computer or your own server/);
    assert.match(home.text(), /Model +test\/model +dl model\n/);
    assert.match(home.text(), /Runs on +○ box http:\/\/127\.0\.0\.1:\d+, ● this-computer this computer +dl servers · dl use NAME/);
  });

  it("shows why a task failed, in dl run, dl watch and dl runs", { timeout: 30_000 }, async () => {
    await saveRemote(place("box", fake.url));
    const dir = await checkout();
    fake.failKey = "reason";
    fake.failWith = "kimiflare: context window exceeded (~104,215 tokens needed, 103,424 available of 128,000)";
    const io = capture();
    assert.equal(await run({ task: "fix it", cwd: dir, repository: "me/app", autopilotModel: noAutopilotModel }, io), 1);
    assert.match(io.text(), /✗ 3f2a9c1e failed\n {4}kimiflare: context window exceeded/);
    assert.match(io.text(), /pick a model with a bigger window: dl model/);

    const replay = capture();
    assert.equal(await watch({ id: "3f2a9c1e" }, replay), 1);
    assert.match(replay.text(), /✗ 3f2a9c1e failed\n {4}kimiflare: context window exceeded/);

    const list = capture();
    await runs({}, list);
    assert.match(list.text(), /✗ 3f2a9c1e {2}failed +me\/app[\s\S]*\n {6}kimiflare: context window exceeded/);
  });

  it("reads a failure reason from the final event, and hints at the ones it knows", () => {
    assert.equal(failureReason(undefined), undefined);
    assert.equal(failureReason({ id: 1, type: "failed", data: {} }), undefined);
    assert.equal(failureReason({ id: 1, type: "failed", data: { reason: "  boom  " } }), "boom");
    assert.equal(failureReason({ id: 1, type: "failed", data: { error: "boom" } }), "boom");
    assert.equal(failureReason({ id: 1, type: "failed", data: { message: "boom" } }), "boom");
    assert.equal(failureReason({ id: 1, type: "failed", data: { reason: 42 } }), undefined);

    assert.equal(failureHint("context window exceeded (~104,215 tokens needed)"), "pick a model with a bigger window: dl model");
    assert.equal(failureHint("HTTP 403: model not priced: openai/gpt-6-luna"), "pick another model: dl model");
    assert.equal(failureHint("git_push_failed: remote rejected"), "check the GitHub token: dl keys github");
    assert.equal(failureHint("429 rate limit"), "wait a moment, or check the OpenRouter key: dl keys openrouter");
    assert.equal(failureHint("Docker went away"), undefined);
  });

  it("bounds a long reason to three lines", () => {
    assert.deepEqual(wrap("short reason", 100, 3), ["short reason"]);
    const long = Array.from({ length: 60 }, (_, index) => `word${index}`).join(" ");
    const lines = wrap(long, 40, 3);
    assert.equal(lines.length, 3);
    assert.ok(lines.every((line) => line.length <= 40), lines.join("|"));
    assert.match(lines[2]!, /…$/);
  });

  it("dl use with nothing set up points at dl setup", async () => {
    const io = capture();
    assert.equal(await use([], io), 0);
    assert.match(io.text(), /Nothing set up yet\. {2}dl setup/);
  });
});
