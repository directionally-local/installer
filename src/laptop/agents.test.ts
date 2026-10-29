import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { agentCommand, agentState, formatAge, listAgents, parseDuration, summarize } from "./agents.js";
import { main } from "../cli.js";
import { saveRemote, type RemoteServer } from "./config.js";
import type { LaptopIO } from "./commands.js";

/**
 * A stand-in for a place's Aster API: conversation summaries, turns, and the event stream.
 * `queue` moves a conversation through statuses on successive GETs, which is how `wait` sees
 * an agent change state without a real one running.
 */
class FakeAgents {
  conversations: Array<Record<string, unknown>> = [];
  events = new Map<string, Array<[number, string, Record<string, unknown>]>>();
  turns: Array<{ id: string; text: string }> = [];
  queue = new Map<string, string[]>();
  url = "";
  private server: Server | undefined;

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
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: { code: "invalid_credential", message: "no" } });
    if (path === "/api/v1/conversations" && req.method === "GET") return send(200, { conversations: this.conversations });
    const match = /^\/api\/v1\/conversations\/([^/]+)(\/turns|\/events)?$/.exec(path);
    if (!match) return send(404, { error: { code: "not_found", message: path } });
    const id = decodeURIComponent(match[1]!);
    const conversation = this.conversations.find((entry) => entry.conversationId === id);
    if (!conversation) return send(404, { error: { code: "not_found", message: id } });
    if (match[2] === "/turns") {
      this.turns.push({ id, text: String(body.text ?? "") });
      conversation.status = "running";
      conversation.activeRunId = "run-1";
      return send(202, { runId: "run-1", status: "running" });
    }
    if (match[2] === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const after = Number(req.headers["last-event-id"] ?? 0);
      for (const [eventId, type, data] of this.events.get(id) ?? []) {
        if (eventId > after) res.write(`id: ${eventId}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      }
      return res.end();
    }
    const next = this.queue.get(id);
    if (next && next.length) {
      const status = next.shift()!;
      conversation.status = status;
      conversation.activeRunId = status === "running" ? "run-1" : null;
    }
    return send(200, conversation);
  }
}

const TOKEN = "aster_laptop_token_0000000000000000000000000000000000";
const ID = "3f2a9c1e-0000-4000-8000-000000000000";

const roots: string[] = [];
let box: FakeAgents;
let laptop: FakeAgents;
const previous = process.env.AUTOPILOT_REMOTES_FILE;

beforeEach(async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dl-agents-")));
  roots.push(root);
  process.env.AUTOPILOT_REMOTES_FILE = join(root, "remotes.json");
  box = new FakeAgents();
  laptop = new FakeAgents();
  await box.start();
  await laptop.start();
});

afterEach(async () => {
  await box.stop();
  await laptop.stop();
  if (previous === undefined) delete process.env.AUTOPILOT_REMOTES_FILE;
  else process.env.AUTOPILOT_REMOTES_FILE = previous;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function place(name: string, url: string): RemoteServer {
  return { name, url, token: TOKEN, credentialId: `cred-${name}`, expiresAt: "2027-01-01T00:00:00.000Z", addedAt: "2026-10-28T00:00:00.000Z" };
}

function capture(): LaptopIO & { outText: () => string; errText: () => string } {
  let out = "";
  let err = "";
  return {
    out: (chunk) => { out += chunk; },
    err: (chunk) => { err += chunk; },
    color: false,
    outText: () => out,
    errText: () => err,
  };
}

function conversation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conversationId: ID,
    workspaceId: "default",
    model: "test/model",
    status: "ready",
    activeRunId: null,
    lastEventId: 1,
    createdAt: "2026-10-29T10:00:00.000Z",
    updatedAt: "2026-10-29T10:00:00.000Z",
    kind: "code",
    repository: "me/app",
    branch: "aster/3f2a9c1e",
    ...overrides,
  };
}

describe("dl agent", () => {
  it("lists every agent as JSON, grouped by place and repository, blocked first", async () => {
    await saveRemote(place("box", box.url));
    await saveRemote(place("laptop", laptop.url));
    box.conversations = [
      conversation({ conversationId: "aaaa1111-0000-4000-8000-000000000000", status: "running", activeRunId: "run-1", lastActivityAt: "2026-10-29T11:59:00.000Z", title: "fix the flaky test", costUsd: 0.42 }),
      conversation({ conversationId: "bbbb2222-0000-4000-8000-000000000000", status: "waiting_approval", lastActivityAt: "2026-10-29T11:50:00.000Z", title: "add retries", waitingFor: { tool: "shell", summary: "rm -rf build" } }),
      conversation({ conversationId: "cccc3333-0000-4000-8000-000000000000", status: "completed", lastActivityAt: "2026-10-29T11:00:00.000Z", pullRequestURL: "https://github.com/me/app/pull/7", pullRequestNumber: 7 }),
      conversation({ conversationId: "dddd4444-0000-4000-8000-000000000000", repository: "other/lib", status: "failed", lastActivityAt: "2026-10-29T11:30:00.000Z", lastError: "boom" }),
    ];
    laptop.conversations = [conversation({ conversationId: "eeee5555-0000-4000-8000-000000000000", repository: "me/site", status: "ready", lastActivityAt: "2026-10-29T11:45:00.000Z" })];

    const now = Date.parse("2026-10-29T12:00:00.000Z");
    const { agents, unreachable } = await listAgents({ now: () => now });
    assert.deepEqual(unreachable, []);
    assert.deepEqual(agents.map((agent) => [agent.place, agent.repository, agent.id, agent.state]), [
      ["box", "me/app", "bbbb2222", "blocked"],
      ["box", "me/app", "aaaa1111", "working"],
      ["box", "me/app", "cccc3333", "done"],
      ["box", "other/lib", "dddd4444", "failed"],
      ["laptop", "me/site", "eeee5555", "idle"],
    ]);
    const blocked = agents[0]!;
    assert.equal(blocked.title, "add retries");
    assert.deepEqual(blocked.waitingFor, { tool: "shell", summary: "rm -rf build" });
    assert.equal(blocked.ageSeconds, 600);
    assert.equal(agents[1]!.costUsd, 0.42);
    assert.equal(agents[1]!.ageSeconds, 60);
    assert.equal(agents[2]!.pullRequestNumber, 7);
    assert.equal(agents[3]!.lastError, "boom");

    const io = capture();
    assert.equal(await agentCommand(["list"], { json: true }, io), 0);
    const rows = JSON.parse(io.outText()) as Array<Record<string, unknown>>;
    assert.equal(rows.length, 5);
    assert.equal(rows[0]!.state, "blocked");
    assert.equal(rows[0]!.place, "box");
    assert.equal(io.errText(), "");

    const human = capture();
    assert.equal(await agentCommand(["list"], {}, human), 0);
    assert.match(human.outText(), /\n {2}box\n {4}me\/app\n {6}! bbbb2222 {2}blocked/);
    assert.match(human.outText(), /\n {2}laptop\n {4}me\/site\n {6}○ eeee5555 {2}idle/);
    assert.match(human.outText(), /Send a follow-up: dl agent prompt <id>/);
  });

  it("limits to one place with --server, and reports a place that doesn't answer", async () => {
    await saveRemote(place("box", box.url));
    await saveRemote(place("laptop", laptop.url));
    await saveRemote(place("gone", "http://127.0.0.1:9"));
    box.conversations = [conversation()];
    laptop.conversations = [conversation({ conversationId: "eeee5555-0000-4000-8000-000000000000" })];

    const io = capture();
    assert.equal(await agentCommand(["list"], { json: true }, io), 0);
    assert.match(io.errText(), /✗ gone: /);
    assert.deepEqual((JSON.parse(io.outText()) as Array<{ place: string }>).map((row) => row.place), ["box", "laptop"]);

    const one = capture();
    assert.equal(await agentCommand(["list"], { json: true, server: "box" }, one), 0);
    assert.deepEqual((JSON.parse(one.outText()) as Array<{ place: string }>).map((row) => row.place), ["box"]);
    assert.equal(one.errText(), "");
  });

  it("sends a follow-up, and with --wait waits for the state it's told", async () => {
    await saveRemote(place("box", box.url));
    box.conversations = [conversation()];

    const sent = capture();
    assert.equal(await agentCommand(["prompt", "3f2a9c1e", "also", "fix", "lint"], {}, sent), 0);
    assert.deepEqual(box.turns, [{ id: ID, text: "also fix lint" }]);
    assert.match(sent.outText(), /✓ Sent to 3f2a9c1e on box/);

    box.queue.set(ID, ["running", "completed"]);
    const waited = capture();
    assert.equal(await agentCommand(["prompt", "3f2a9c1e", "go"], { wait: true, pollMs: 1, sleep: async () => {} }, waited), 0);
    assert.match(waited.outText(), /✓ Sent to 3f2a9c1e on box\n {2}✓ 3f2a9c1e done/);

    box.queue.set(ID, ["waiting_approval"]);
    const blocked = capture();
    assert.equal(await agentCommand(["prompt", "3f2a9c1e", "go"], { until: "blocked", pollMs: 1, sleep: async () => {} }, blocked), 0);
    assert.match(blocked.outText(), /✓ 3f2a9c1e blocked/);

    box.queue.set(ID, ["failed"]);
    const failed = capture();
    assert.equal(await agentCommand(["prompt", "3f2a9c1e", "go"], { wait: true, pollMs: 1, sleep: async () => {} }, failed), 1);
    assert.match(failed.errText(), /✗ 3f2a9c1e failed/);

    const json = capture();
    assert.equal(await agentCommand(["prompt", "3f2a9c1e", "go"], { json: true }, json), 0);
    assert.deepEqual(JSON.parse(json.outText()), { id: "3f2a9c1e", conversationId: ID, place: "box", sent: true });
  });

  it("waits: 0 when reached, 1 when it fails or finishes first, 124 on timeout", async () => {
    await saveRemote(place("box", box.url));
    box.conversations = [conversation({ status: "running", activeRunId: "run-1" })];

    box.queue.set(ID, ["waiting_approval"]);
    const reached = capture();
    assert.equal(await agentCommand(["wait", "3f2a9c1e"], { until: "blocked", pollMs: 1, sleep: async () => {} }, reached), 0);
    assert.match(reached.outText(), /✓ 3f2a9c1e blocked/);

    box.queue.set(ID, ["failed"]);
    const failed = capture();
    assert.equal(await agentCommand(["wait", "3f2a9c1e"], { pollMs: 1, sleep: async () => {} }, failed), 1);
    assert.match(failed.errText(), /✗ 3f2a9c1e failed/);

    box.queue.set(ID, ["completed"]);
    const finished = capture();
    assert.equal(await agentCommand(["wait", "3f2a9c1e"], { until: "blocked", pollMs: 1, sleep: async () => {} }, finished), 1);
    assert.match(finished.errText(), /! 3f2a9c1e finished \(done\) before it was blocked/);

    box.queue.set(ID, []);
    box.conversations[0]!.status = "running";
    box.conversations[0]!.activeRunId = "run-1";
    const timedOut = capture();
    assert.equal(await agentCommand(["wait", "3f2a9c1e"], { timeout: "20ms", pollMs: 1 }, timedOut), 124);
    assert.match(timedOut.errText(), /! 3f2a9c1e is still working after 20ms; gave up waiting/);

    const json = capture();
    box.queue.set(ID, ["completed"]);
    assert.equal(await agentCommand(["wait", "3f2a9c1e"], { json: true, pollMs: 1, sleep: async () => {} }, json), 0);
    assert.deepEqual(JSON.parse(json.outText()), { id: "3f2a9c1e", conversationId: ID, place: "box", state: "done", reached: true });
  });

  it("reads the last assistant and tool lines, as text or JSON", async () => {
    await saveRemote(place("box", box.url));
    box.conversations = [conversation({ status: "completed", lastEventId: 6 })];
    box.events.set(ID, [
      [1, "user.message", { text: "fix it" }],
      [2, "tool.activity", { tool: "shell", activity: "started", input: "npm test" }],
      [3, "assistant.delta", { text: "Fixed the " }],
      [4, "assistant.delta", { text: "flaky test.\nSecond line." }],
      [5, "tool.activity", { tool: "shell", activity: "failed" }],
      [6, "completed", {}],
    ]);

    const io = capture();
    assert.equal(await agentCommand(["read", "3f2a9c1e"], { lines: "2" }, io), 0);
    assert.equal(io.outText(), "Second line.\n  › shell failed\n");

    const all = capture();
    assert.equal(await agentCommand(["read", "3f2a9c1e"], {}, all), 0);
    assert.equal(all.outText(), "  › shell npm test\nFixed the flaky test.\nSecond line.\n  › shell failed\n");

    const json = capture();
    assert.equal(await agentCommand(["read", "3f2a9c1e"], { json: true }, json), 0);
    const parsed = JSON.parse(json.outText()) as { state: string; lines: Array<{ type: string; text: string }> };
    assert.equal(parsed.state, "done");
    assert.deepEqual(parsed.lines, [
      { type: "tool", text: "shell npm test", activity: "started" },
      { type: "assistant", text: "Fixed the flaky test." },
      { type: "assistant", text: "Second line." },
      { type: "tool", text: "shell failed", activity: "failed" },
    ]);

    box.conversations = [conversation({ status: "ready", lastEventId: 0 })];
    const empty = capture();
    assert.equal(await agentCommand(["read", "3f2a9c1e"], {}, empty), 0);
    assert.match(empty.outText(), /No output yet\./);
  });

  it("exits 2 on usage errors and 1 when the agent isn't there", async () => {
    await saveRemote(place("box", box.url));
    box.conversations = [conversation()];
    const io = capture();
    assert.equal(await agentCommand([], {}, io), 2);
    assert.match(io.errText(), /Usage: dl agent list\|prompt\|read\|wait/);
    assert.equal(await agentCommand(["nope"], {}, io), 2);
    assert.equal(await agentCommand(["list", "extra"], {}, io), 2);
    assert.equal(await agentCommand(["prompt", "3f2a9c1e"], {}, io), 2);
    assert.equal(await agentCommand(["read"], {}, io), 2);
    assert.equal(await agentCommand(["read", "3f2a9c1e"], { lines: "0" }, io), 2);
    assert.equal(await agentCommand(["wait", "3f2a9c1e"], { until: "nope" }, io), 2);
    assert.equal(await agentCommand(["wait", "3f2a9c1e"], { timeout: "soon" }, io), 2);

    const missing = capture();
    assert.equal(await agentCommand(["wait", "deadbeef"], {}, missing), 1);
    assert.match(missing.errText(), /✗ No agent deadbeef on any connected server/);
  });

  it("maps a conversation's status to a state, and prefers the server's own state", () => {
    const base = { conversationId: ID, workspaceId: "default", model: "m", activeRunId: null, lastEventId: 0, createdAt: "", updatedAt: "" };
    assert.equal(agentState({ ...base, status: "running" }), "working");
    assert.equal(agentState({ ...base, status: "provisioning" }), "working");
    assert.equal(agentState({ ...base, status: "waiting_approval" }), "blocked");
    assert.equal(agentState({ ...base, status: "ready" }), "idle");
    assert.equal(agentState({ ...base, status: "paused" }), "idle");
    assert.equal(agentState({ ...base, status: "completed" }), "done");
    assert.equal(agentState({ ...base, status: "merged" }), "done");
    assert.equal(agentState({ ...base, status: "failed" }), "failed");
    assert.equal(agentState({ ...base, status: "cancelled" }), "failed");
    assert.equal(agentState({ ...base, status: "ready", activeRunId: "run-1" }), "working");
    assert.equal(agentState({ ...base, status: "running", state: "blocked" }), "blocked", "the server's state wins");
    assert.equal(agentState({ ...base, status: "something-new" }), "idle");
  });

  it("summarizes a conversation with its age, and formats ages and durations", () => {
    const now = Date.parse("2026-10-29T12:00:00.000Z");
    const row = summarize({ conversationId: ID, workspaceId: "w", model: "m", status: "completed", activeRunId: null, lastEventId: 3, createdAt: "2026-10-29T09:00:00.000Z", updatedAt: "2026-10-29T11:00:00.000Z", title: "  fix it  " }, "box", now);
    assert.equal(row.id, "3f2a9c1e");
    assert.equal(row.title, "fix it");
    assert.equal(row.ageSeconds, 3_600);
    assert.equal(row.lastActivityAt, "2026-10-29T11:00:00.000Z");
    assert.equal(row.costUsd, null);
    assert.equal(row.waitingFor, null);

    assert.equal(formatAge(12), "12s");
    assert.equal(formatAge(300), "5m");
    assert.equal(formatAge(7_200), "2h");
    assert.equal(formatAge(172_800), "2d");

    assert.equal(parseDuration("30s"), 30_000);
    assert.equal(parseDuration("5m"), 300_000);
    assert.equal(parseDuration("2h"), 7_200_000);
    assert.equal(parseDuration("500ms"), 500);
    assert.equal(parseDuration("90"), 90_000);
    assert.equal(parseDuration("soon"), undefined);
  });

  it("is wired into dl, with usage errors exiting 2", async () => {
    await saveRemote(place("box", box.url));
    box.conversations = [conversation({ status: "completed" })];
    let out = "";
    let err = "";
    const io = { out: (text: string) => { out += text; }, err: (text: string) => { err += text; } };
    assert.equal(await main(["agent", "list", "--json"], io), 0);
    assert.equal((JSON.parse(out) as unknown[]).length, 1);
    out = "";
    err = "";
    assert.equal(await main(["agent"], io), 2);
    assert.match(err, /Usage: dl agent list\|prompt\|read\|wait/);
    out = "";
    assert.equal(await main(["agent", "read", "3f2a9c1e", "--lines", "1"], io), 0);
    assert.match(out, /No output yet\./);
  });
});
