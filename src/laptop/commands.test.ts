import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cancel, connect, pull, run, runs, servers, watch, type LaptopIO } from "./commands.js";
import { fakeTunnels } from "../test-support/fake-tunnel.js";
import { loadRemotes, saveRemote } from "./config.js";
import { createOpener } from "./tunnel.js";

/**
 * A small stand-in for a Directionally Local server's API (Autopilot's /api/v1): device
 * pairing, code conversations, turns, SSE events, listing, and cancel.
 */
class FakeServer {
  approved = false;
  readonly created: Array<Record<string, unknown>> = [];
  readonly cancelled: string[] = [];
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
    if (path === "/api/v1/models") return send(200, { models: ["test/model"] });
    if (path === "/api/v1/conversations" && req.method === "POST") {
      this.created.push(body);
      this.conversation = { conversationId: "3f2a9c1e-0000-4000-8000-000000000000", workspaceId: "default", model: "test/model", status: "ready", activeRunId: null, lastEventId: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), kind: "code", repository: "me/app", branch: "aster/3f2a9c1e" };
      return send(201, this.conversation);
    }
    if (path === "/api/v1/conversations" && req.method === "GET") return send(200, { conversations: this.conversation ? [this.conversation] : [] });
    if (path.endsWith("/turns")) {
      this.conversation = { ...this.conversation, status: "completed", lastEventId: 4, pullRequestURL: "https://github.com/me/app/pull/42" };
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
        [4, "completed", {}],
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
    assert.equal(await run({ task: "fix the flaky test", cwd: dir, repository: "me/app" }, runIO), 0);
    assert.match(String(fake.created[0]?.patch), /\+local edit/);
    const text = runIO.text();
    assert.match(text, /Sending to box: me\/app at [0-9a-f]{7} \+ 1 local change/);
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

  it("reaches a server set up over SSH through a tunnel that each command opens and closes", { timeout: 30_000 }, async () => {
    await saveRemote({
      name: "box", url: "http://127.0.0.1:4096", token: "aster_laptop_token_0000000000000000000000000000000000", credentialId: "cred-1",
      expiresAt: "2027-01-01T00:00:00.000Z", addedAt: "2026-10-28T00:00:00.000Z", ssh: { target: "root@203.0.113.10" },
    });
    const port = Number(new URL(fake.url).port);
    const tunnels = fakeTunnels(port, { delayMs: 5 });
    const open = createOpener({ spawn: tunnels.spawn, pollMs: 5 });
    const dir = await checkout();
    assert.equal(await run({ task: "fix it", cwd: dir, repository: "me/app", open }, capture()), 0);
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
    assert.match(list.text(), /box +ssh root@203\.0\.113\.10/);
  });

  it("says why a task can't be found when the tunnel fails", async () => {
    await saveRemote({
      name: "box", url: "http://127.0.0.1:4096", token: "t", credentialId: "c", expiresAt: "2027-01-01T00:00:00.000Z", addedAt: "2026-10-28T00:00:00.000Z", ssh: { target: "root@203.0.113.10" },
    });
    const open = createOpener({ spawn: fakeTunnels(undefined, { failWith: "ssh: connect to host 203.0.113.10 port 22: Operation timed out" }).spawn, pollMs: 5 });
    await assert.rejects(() => cancel({ id: "3f2a9c1e", open }, capture()), /No task 3f2a9c1e on any connected server\nbox: Couldn't open an SSH tunnel to box[\s\S]*Operation timed out/);
  });

  it("guides a laptop that isn't connected yet", async () => {
    const io = capture();
    await assert.rejects(() => runs({}, io), /isn't connected to a server yet\. Run: dl connect/);
    assert.equal(await servers([], io), 0);
    assert.match(io.text(), /Not connected to a server yet\. {2}dl setup {2}or, for a server someone else set up: dl connect https:\/\/your-server/);
  });
});
