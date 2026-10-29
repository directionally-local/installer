import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatAge, formatCost, sessionState, sessions, type SessionState } from "./sessions.js";
import { saveRemote, type RemoteServer } from "./config.js";
import type { LaptopIO } from "./commands.js";

/**
 * A stand-in for one place's API: only the conversation list `dl sessions` reads. Each test
 * gives it the conversations it should return, in whatever order a server might.
 */
class FakePlace {
  conversations: Array<Record<string, unknown>> = [];
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
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const path = new URL(req.url ?? "/", this.url).pathname;
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: { code: "invalid_credential", message: "no" } });
    if (path === "/api/v1/conversations") return send(200, { conversations: this.conversations });
    send(404, { error: { code: "not_found", message: path } });
  }
}

const TOKEN = "aster_laptop_token_0000000000000000000000000000000000";
const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const now = () => NOW;

const roots: string[] = [];
const previous = process.env.AUTOPILOT_REMOTES_FILE;
const places: FakePlace[] = [];

beforeEach(async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dl-sessions-")));
  roots.push(root);
  process.env.AUTOPILOT_REMOTES_FILE = join(root, "remotes.json");
});

afterEach(async () => {
  await Promise.all(places.splice(0).map((place) => place.stop()));
  if (previous === undefined) delete process.env.AUTOPILOT_REMOTES_FILE;
  else process.env.AUTOPILOT_REMOTES_FILE = previous;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function place(name: string): Promise<FakePlace> {
  const fake = new FakePlace();
  await fake.start();
  places.push(fake);
  await saveRemote(remote(name, fake.url));
  return fake;
}

function remote(name: string, url: string): RemoteServer {
  return { name, url, token: TOKEN, credentialId: `cred-${name}`, expiresAt: "2027-01-01T00:00:00.000Z", addedAt: "2026-10-28T00:00:00.000Z" };
}

/** A URL nothing listens on: a port that was open a moment ago. */
async function deadUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

function conversation(input: {
  id: string;
  repository?: string;
  status?: string;
  state?: string;
  title?: string;
  costUsd?: number;
  minutesAgo?: number;
  activeRunId?: string | null;
  pullRequest?: number;
  kind?: "chat" | "code";
}): Record<string, unknown> {
  const at = new Date(NOW - (input.minutesAgo ?? 0) * 60_000).toISOString();
  return {
    conversationId: input.id,
    workspaceId: "default",
    model: "test/model",
    status: input.status ?? "ready",
    activeRunId: input.activeRunId ?? null,
    lastEventId: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: at,
    kind: input.kind ?? "code",
    repository: input.repository ?? "me/app",
    ...(input.state ? { state: input.state } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
    ...(input.minutesAgo !== undefined ? { lastActivityAt: at } : {}),
    ...(input.pullRequest !== undefined
      ? { pullRequestNumber: input.pullRequest, pullRequestURL: `https://github.com/${input.repository ?? "me/app"}/pull/${input.pullRequest}` }
      : {}),
  };
}

function capture(): LaptopIO & { text: () => string } {
  let text = "";
  return { out: (chunk) => { text += chunk; }, err: (chunk) => { text += chunk; }, color: false, text: () => text };
}

/** The order things appear in the output, for asserting grouping and ordering. */
function order(text: string, needles: string[]): string[] {
  return [...needles].sort((a, b) => text.indexOf(a) - text.indexOf(b));
}

describe("dl sessions", () => {
  it("groups by place then repository, newest first, blocked first within a repository", async () => {
    const box = await place("box");
    box.conversations = [
      conversation({ id: "aaaaaaaa-0000-4000-8000-000000000000", repository: "me/app", state: "working", title: "Add retries", minutesAgo: 1, costUsd: 0.42 }),
      conversation({ id: "bbbbbbbb-0000-4000-8000-000000000000", repository: "me/app", state: "blocked", title: "Fix the flaky test", minutesAgo: 10, costUsd: 0.11 }),
      conversation({ id: "cccccccc-0000-4000-8000-000000000000", repository: "me/other", state: "working", title: "Tidy the uploader", minutesAgo: 5 }),
      conversation({ id: "dddddddd-0000-4000-8000-000000000000", repository: "me/other", state: "done", title: "Bump deps", minutesAgo: 2, pullRequest: 7 }),
      conversation({ id: "eeeeeeee-0000-4000-8000-000000000000", repository: "me/app", kind: "chat", title: "Just chatting" }),
    ];
    const laptop = await place("laptop");
    laptop.conversations = [
      conversation({ id: "ffffffff-0000-4000-8000-000000000000", repository: "me/app", state: "working", title: "Write docs", minutesAgo: 3 }),
    ];

    const io = capture();
    await sessions({ now }, io);
    const text = io.text();

    assert.match(text, /box {2}http:\/\/127\.0\.0\.1:\d+ {2}2 working · 1 blocked · 1 done/);
    assert.match(text, /laptop {2}http:\/\/127\.0\.0\.1:\d+ {2}1 working/);
    // Places in the order they're set up; repositories by their newest conversation.
    assert.deepEqual(order(text, ["box", "laptop"]), ["box", "laptop"]);
    assert.ok(text.indexOf("me/app") < text.indexOf("me/other"), "me/app's newest is newer");
    // Blocked floats above a newer working conversation in the same repository.
    assert.deepEqual(order(text, ["Fix the flaky test", "Add retries"]), ["Fix the flaky test", "Add retries"]);
    // No blocked ones in me/other: newest first.
    assert.deepEqual(order(text, ["Bump deps", "Tidy the uploader"]), ["Bump deps", "Tidy the uploader"]);
    // The second place comes after everything on the first.
    assert.ok(text.indexOf("Write docs") > text.indexOf("Tidy the uploader"));
    // Chat conversations aren't agents.
    assert.doesNotMatch(text, /Just chatting/);
    // One row: short id, state, age, title, cost, PR.
    assert.match(text, /! bbbbbbbb blocked +10m {2}Fix the flaky test +\$0\.11/);
    assert.match(text, /✓ dddddddd done +2m {2}Bump deps +#7/);
    assert.match(text, /Follow one: dl watch <id>/);
  });

  it("prints the same rows as JSON, with unreachable places kept apart", async () => {
    const box = await place("box");
    box.conversations = [
      conversation({ id: "aaaaaaaa-0000-4000-8000-000000000000", repository: "me/app", state: "blocked", title: "Fix the flaky test", minutesAgo: 10, costUsd: 0.42, pullRequest: 7 }),
      conversation({ id: "bbbbbbbb-0000-4000-8000-000000000000", repository: "me/app", status: "running", activeRunId: "run-1", title: "Add retries", minutesAgo: 1 }),
    ];
    await saveRemote(remote("gone", await deadUrl()));

    const io = capture();
    await sessions({ json: true, now }, io);
    const parsed = JSON.parse(io.text()) as {
      sessions: Array<Record<string, unknown>>;
      unreachable: Array<{ place: string; error: string }>;
      hidden: number;
    };

    assert.deepEqual(parsed.sessions.map((row) => row.id), ["aaaaaaaa", "bbbbbbbb"]);
    assert.deepEqual(parsed.sessions[0], {
      place: "box",
      repository: "me/app",
      id: "aaaaaaaa",
      conversationId: "aaaaaaaa-0000-4000-8000-000000000000",
      state: "blocked",
      status: "ready",
      title: "Fix the flaky test",
      costUsd: 0.42,
      lastActivityAt: "2026-10-29T11:50:00.000Z",
      ageSeconds: 600,
      pullRequest: { number: 7, url: "https://github.com/me/app/pull/7" },
    });
    assert.equal(parsed.sessions[1]?.state, "working", "status running with an active run");
    assert.equal(parsed.unreachable.length, 1);
    assert.equal(parsed.unreachable[0]?.place, "gone");
    assert.match(parsed.unreachable[0]?.error ?? "", /fetch failed|ECONNREFUSED/);
    assert.equal(parsed.hidden, 0);
  });

  it("shows a place that doesn't answer as unreachable, and still lists the others", async () => {
    const box = await place("box");
    box.conversations = [conversation({ id: "aaaaaaaa-0000-4000-8000-000000000000", state: "working", title: "Add retries", minutesAgo: 1 })];
    await saveRemote(remote("gone", await deadUrl()));

    const io = capture();
    await sessions({ now }, io);
    const text = io.text();
    assert.match(text, /✗ gone {2}http:\/\/127\.0\.0\.1:\d+ {2}unreachable/);
    assert.match(text, /Add retries/);
    assert.match(text, /1 working/);
  });

  it("hides finished conversations older than a day unless --all", async () => {
    const box = await place("box");
    box.conversations = [
      conversation({ id: "aaaaaaaa-0000-4000-8000-000000000000", state: "done", title: "Old and done", minutesAgo: 2 * 24 * 60 }),
      conversation({ id: "bbbbbbbb-0000-4000-8000-000000000000", state: "failed", title: "Old and failed", minutesAgo: 3 * 24 * 60 }),
      conversation({ id: "cccccccc-0000-4000-8000-000000000000", state: "done", title: "Done an hour ago", minutesAgo: 60 }),
      conversation({ id: "dddddddd-0000-4000-8000-000000000000", state: "working", title: "Still working", minutesAgo: 5 * 24 * 60 }),
    ];

    const recent = capture();
    await sessions({ now }, recent);
    assert.doesNotMatch(recent.text(), /Old and done|Old and failed/);
    assert.match(recent.text(), /Done an hour ago/);
    assert.match(recent.text(), /Still working/, "only finished ones age out");
    assert.match(recent.text(), /2 finished older than a day hidden; --all shows them/);

    const all = capture();
    await sessions({ all: true, now }, all);
    assert.match(all.text(), /Old and done/);
    assert.match(all.text(), /Old and failed/);
    assert.doesNotMatch(all.text(), /hidden; --all/);

    const json = capture();
    await sessions({ json: true, now }, json);
    assert.equal((JSON.parse(json.text()) as { hidden: number }).hidden, 2);
  });

  it("limits to one place with --server", async () => {
    const box = await place("box");
    box.conversations = [conversation({ id: "aaaaaaaa-0000-4000-8000-000000000000", title: "On box", minutesAgo: 1 })];
    const laptop = await place("laptop");
    laptop.conversations = [conversation({ id: "bbbbbbbb-0000-4000-8000-000000000000", title: "On laptop", minutesAgo: 1 })];

    const io = capture();
    await sessions({ server: "box", now }, io);
    assert.match(io.text(), /On box/);
    assert.doesNotMatch(io.text(), /On laptop/);
    assert.doesNotMatch(io.text(), /laptop {2}http/);
  });

  it("says when nothing is set up", async () => {
    await assert.rejects(() => sessions({ now }, capture()), /Nothing is set up yet\. Run: dl setup/);
  });
});

describe("session state", () => {
  it("uses the server's state when it sends one", () => {
    assert.equal(sessionState({ state: "blocked", status: "ready", activeRunId: null }), "blocked");
    assert.equal(sessionState({ state: "done", status: "running", activeRunId: "run-1" }), "done");
    assert.equal(sessionState({ state: "nonsense", status: "ready", activeRunId: null }), "idle", "unknown states fall back to status");
  });

  it("maps today's statuses when the server doesn't", () => {
    const cases: Array<[string, string | null, SessionState]> = [
      ["waiting_approval", "run-1", "blocked"],
      ["running", "run-1", "working"],
      ["provisioning", "run-1", "working"],
      ["ready", "run-1", "working"],
      ["ready", null, "idle"],
      ["paused", null, "idle"],
      ["completed", null, "done"],
      ["merged", null, "done"],
      ["destroyed", null, "done"],
      ["failed", null, "failed"],
      ["cancelled", null, "failed"],
      ["interrupted", null, "failed"],
      ["something-new", null, "idle"],
    ];
    for (const [status, activeRunId, expected] of cases) {
      assert.equal(sessionState({ status, activeRunId }), expected, status);
    }
  });
});

describe("sessions formatting", () => {
  it("writes ages people read at a glance", () => {
    assert.equal(formatAge(0), "0s");
    assert.equal(formatAge(59), "59s");
    assert.equal(formatAge(60), "1m");
    assert.equal(formatAge(3_600), "1h");
    assert.equal(formatAge(86_400), "1d");
    assert.equal(formatAge(90 * 86_400), "3mo");
    assert.equal(formatAge(400 * 86_400), "1y");
  });

  it("writes costs, and nothing when the server doesn't report one", () => {
    assert.equal(formatCost(undefined), "");
    assert.equal(formatCost(0), "$0.00");
    assert.equal(formatCost(0.004), "<$0.01");
    assert.equal(formatCost(0.42), "$0.42");
    assert.equal(formatCost(12.5), "$12.50");
  });
});
