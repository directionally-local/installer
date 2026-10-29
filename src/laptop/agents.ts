import { randomUUID } from "node:crypto";
import { palette } from "../ui.js";
import type { RemoteClient, RemoteConversation, RemoteEvent } from "./client.js";
import { describeError, findRun, oneLine, type LaptopIO } from "./commands.js";
import { loadRemotes, resolveRemote } from "./config.js";
import { withConnections, type RemoteOpener } from "./tunnel.js";

/**
 * `dl agent list|prompt|read|wait`: the scripting surface for agents and humans. State comes
 * from the conversation itself (Aster's status, or the `state` newer servers send), never from
 * reading a terminal. The same data `dl sessions --json` shows, so a script and the deck agree.
 */

/** The states `dl agent` and the deck speak. */
export type AgentState = "working" | "blocked" | "idle" | "done" | "failed";

/** What `--until` accepts: the states worth waiting for. */
export const WAIT_STATES: AgentState[] = ["done", "blocked", "idle"];

const STATES = new Set<string>(["working", "blocked", "idle", "done", "failed"]);

/** How long `wait` and `prompt --wait` wait before giving up (exit 124). */
export const DEFAULT_TIMEOUT_MS = 30 * 60_000;

/** One conversation as one row: what `dl agent list --json` prints. */
export interface AgentSummary {
  /** The short ID `dl runs` and `dl agent` take. */
  id: string;
  conversationId: string;
  place: string;
  repository: string | null;
  kind: string | null;
  state: AgentState;
  /** The server's own status, for scripts that need the finer distinction. */
  status: string;
  title: string | null;
  model: string | null;
  costUsd: number | null;
  /** Seconds since the last event (or the last update, on older servers). */
  ageSeconds: number;
  lastActivityAt: string;
  branch: string | null;
  pullRequestNumber: number | null;
  pullRequestURL: string | null;
  waitingFor: { tool: string; summary: string } | null;
  lastError: string | null;
}

/** One line of an agent's output, as `dl agent read` prints it. */
export interface AgentLine {
  type: "assistant" | "tool";
  text: string;
  activity?: "started" | "failed";
}

const processIO: LaptopIO = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  color: process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== "dumb",
};

/**
 * The conversation's state: the server's `state` when it sends one (autopilot#1046), else
 * mapped from `status` so this works against today's servers too.
 */
export function agentState(conversation: RemoteConversation): AgentState {
  const reported = conversation.state;
  if (typeof reported === "string" && STATES.has(reported)) return reported as AgentState;
  if (conversation.status === "waiting_approval") return "blocked";
  if (conversation.activeRunId) return "working";
  switch (conversation.status) {
    case "running":
    case "provisioning":
      return "working";
    case "ready":
    case "paused":
      return "idle";
    case "completed":
    case "merged":
      return "done";
    case "failed":
    case "cancelled":
    case "interrupted":
      return "failed";
    default:
      return "idle";
  }
}

/** One conversation as a row, with its age measured from `now`. */
export function summarize(conversation: RemoteConversation, place: string, now = Date.now()): AgentSummary {
  const lastActivityAt = conversation.lastActivityAt ?? conversation.updatedAt ?? conversation.createdAt;
  const at = Date.parse(lastActivityAt);
  const waiting = conversation.waitingFor;
  return {
    id: conversation.conversationId.slice(0, 8),
    conversationId: conversation.conversationId,
    place,
    repository: conversation.repository ?? null,
    kind: conversation.kind ?? null,
    state: agentState(conversation),
    status: conversation.status,
    title: conversation.title?.trim() || null,
    model: conversation.model ?? null,
    costUsd: typeof conversation.costUsd === "number" ? conversation.costUsd : null,
    ageSeconds: Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 1000)) : 0,
    lastActivityAt,
    branch: conversation.branch ?? null,
    pullRequestNumber: conversation.pullRequestNumber ?? null,
    pullRequestURL: conversation.pullRequestURL ?? null,
    waitingFor: waiting ? { tool: waiting.tool ?? "", summary: waiting.summary ?? "" } : null,
    lastError: conversation.lastError ?? null,
  };
}

/** Grouped by place, then repository; blocked first within a repository, then newest first. */
export function sortAgents(agents: AgentSummary[]): AgentSummary[] {
  return [...agents].sort((a, b) =>
    a.place.localeCompare(b.place) ||
    (a.repository ?? "").localeCompare(b.repository ?? "") ||
    Number(b.state === "blocked") - Number(a.state === "blocked") ||
    b.lastActivityAt.localeCompare(a.lastActivityAt) ||
    a.id.localeCompare(b.id));
}

/**
 * Every conversation on every place this laptop is connected to. A place that doesn't answer
 * is reported instead of failing the whole list.
 */
export async function listAgents(input: { server?: string; open?: RemoteOpener; now?: () => number } = {}): Promise<{
  agents: AgentSummary[];
  unreachable: Array<{ place: string; error: string }>;
}> {
  const remotes = input.server ? [await resolveRemote(input.server)] : await loadRemotes();
  if (remotes.length === 0) throw new Error("Nothing is set up yet. Run: dl setup  (or, for a server someone else set up: dl connect https://your-server)");
  const now = input.now ?? Date.now;
  const agents: AgentSummary[] = [];
  const unreachable: Array<{ place: string; error: string }> = [];
  await withConnections(input.open, async (connections) => {
    for (const remote of remotes) {
      try {
        const list = await (await connections.client(remote)).listConversations(200);
        for (const entry of list) agents.push(summarize(entry, remote.name, now()));
      } catch (error) {
        unreachable.push({ place: remote.name, error: describeError(error) });
      }
    }
  });
  return { agents: sortAgents(agents), unreachable };
}

const GLYPHS: Record<AgentState, (c: ReturnType<typeof palette>) => string> = {
  working: (c) => c.cyan("◐"),
  blocked: (c) => c.yellow("!"),
  idle: (c) => c.dim("○"),
  done: (c) => c.green("✓"),
  failed: (c) => c.red("✗"),
};

/** `dl agent list` without --json: places, then repositories, then one line per agent. */
export function renderAgents(agents: AgentSummary[], io: LaptopIO, c = palette(io.color === true)): void {
  if (agents.length === 0) {
    io.out(`\n  No agents yet. From inside a GitHub repository:  ${c.bold("dl")}\n\n`);
    return;
  }
  io.out("\n");
  let place: string | undefined;
  let repository: string | null | undefined;
  for (const agent of agents) {
    if (agent.place !== place) {
      place = agent.place;
      repository = undefined;
      io.out(`  ${c.bold(place)}\n`);
    }
    if (agent.repository !== repository) {
      repository = agent.repository;
      io.out(`    ${c.dim(repository ?? "(no repository)")}\n`);
    }
    const title = agent.title ?? agent.branch ?? "";
    const cost = agent.costUsd !== null ? `  ${c.dim(`$${agent.costUsd.toFixed(2)}`)}` : "";
    const pr = agent.pullRequestURL ? `  ${c.dim(agent.pullRequestURL)}` : "";
    const waiting = agent.state === "blocked" && agent.waitingFor?.summary ? `  ${c.yellow(oneLine(agent.waitingFor.summary, 40))}` : "";
    io.out(`      ${GLYPHS[agent.state](c)} ${agent.id}  ${agent.state.padEnd(8)} ${formatAge(agent.ageSeconds).padStart(4)}  ${oneLine(title, 48)}${cost}${pr}${waiting}\n`);
  }
  io.out(`\n  ${c.dim("Send a follow-up:")} dl agent prompt <id> "…"   ${c.dim("Wait for one:")} dl agent wait <id>\n\n`);
}

/** "12s", "5m", "3h", "2d": how long ago something happened. */
export function formatAge(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

/** `30s`, `5m`, `2h`, `500ms`; a bare number is seconds. Undefined when it isn't a duration. */
export function parseDuration(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/i.exec(text.trim());
  if (!match) return undefined;
  const unit = (match[2] ?? "s").toLowerCase() as "ms" | "s" | "m" | "h" | "d";
  const factor = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return Math.round(Number(match[1]) * factor);
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

interface WaitOptions {
  until: AgentState;
  timeoutMs: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface WaitOutcome {
  code: number;
  state: AgentState;
  reached: boolean;
  until: AgentState;
  timeoutMs: number;
  conversation: RemoteConversation;
}

/** Polls the conversation until it reaches `until`; 0 reached, 1 failed or finished first, 124 timeout. */
async function waitFor(client: RemoteClient, conversationId: string, options: WaitOptions): Promise<WaitOutcome> {
  const pollMs = options.pollMs ?? 2_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const conversation = await client.getConversation(conversationId);
    const state = agentState(conversation);
    if (state === options.until) return { code: 0, state, reached: true, until: options.until, timeoutMs: options.timeoutMs, conversation };
    if (state === "failed" || state === "done") return { code: 1, state, reached: false, until: options.until, timeoutMs: options.timeoutMs, conversation };
    const left = deadline - Date.now();
    if (left <= 0) return { code: 124, state, reached: false, until: options.until, timeoutMs: options.timeoutMs, conversation };
    await sleep(Math.min(pollMs, left));
  }
}

function report(outcome: WaitOutcome, conversationId: string, place: string, json: boolean, io: LaptopIO, c: ReturnType<typeof palette>): void {
  const id = conversationId.slice(0, 8);
  if (json) {
    io.out(`${JSON.stringify({ id, conversationId, place, state: outcome.state, reached: outcome.reached }, null, 2)}\n`);
    return;
  }
  if (outcome.reached) {
    io.out(`  ${c.green("✓")} ${c.bold(id)} ${outcome.state}\n`);
    return;
  }
  if (outcome.code === 124) {
    io.err(`  ${c.yellow("!")} ${id} is still ${outcome.state} after ${formatDuration(outcome.timeoutMs)}; gave up waiting\n`);
    return;
  }
  if (outcome.state === "failed") {
    const reason = outcome.conversation.lastError?.trim();
    io.err(`  ${c.red("✗")} ${id} failed${reason ? `\n    ${oneLine(reason, 200)}` : ""}\n`);
    return;
  }
  io.err(`  ${c.yellow("!")} ${id} finished (${outcome.state}) before it was ${outcome.until}\n`);
}

/** `dl agent prompt ID "text"`: send a follow-up, optionally waiting for a state. */
export async function promptAgent(input: {
  id: string;
  text: string;
  server?: string;
  wait?: boolean;
  until?: AgentState;
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  json?: boolean;
  open?: RemoteOpener;
}, io = processIO): Promise<number> {
  const c = palette(io.color === true);
  return withConnections(input.open, async (connections) => {
    const { remote, run: found } = await findRun(input.id, input.server, connections, "agent");
    const client = await connections.client(remote);
    const id = found.conversationId.slice(0, 8);
    await client.submitTurn(found.conversationId, input.text, `dl-${randomUUID()}`);
    if (!input.wait) {
      if (input.json) io.out(`${JSON.stringify({ id, conversationId: found.conversationId, place: remote.name, sent: true }, null, 2)}\n`);
      else io.out(`  ${c.green("✓")} Sent to ${c.bold(id)} on ${remote.name}\n`);
      return 0;
    }
    const outcome = await waitFor(client, found.conversationId, {
      until: input.until ?? "done",
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(input.pollMs !== undefined ? { pollMs: input.pollMs } : {}),
      ...(input.sleep ? { sleep: input.sleep } : {}),
    });
    if (input.json) {
      io.out(`${JSON.stringify({ id, conversationId: found.conversationId, place: remote.name, sent: true, state: outcome.state, reached: outcome.reached }, null, 2)}\n`);
    } else {
      io.out(`  ${c.green("✓")} Sent to ${c.bold(id)} on ${remote.name}\n`);
      report(outcome, found.conversationId, remote.name, false, io, c);
    }
    return outcome.code;
  });
}

/** `dl agent wait ID`: block until the conversation reaches a state. */
export async function waitAgent(input: {
  id: string;
  server?: string;
  until?: AgentState;
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  json?: boolean;
  open?: RemoteOpener;
}, io = processIO): Promise<number> {
  const c = palette(io.color === true);
  return withConnections(input.open, async (connections) => {
    const { remote, run: found } = await findRun(input.id, input.server, connections, "agent");
    const client = await connections.client(remote);
    const outcome = await waitFor(client, found.conversationId, {
      until: input.until ?? "done",
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(input.pollMs !== undefined ? { pollMs: input.pollMs } : {}),
      ...(input.sleep ? { sleep: input.sleep } : {}),
    });
    report(outcome, found.conversationId, remote.name, input.json === true, io, c);
    return outcome.code;
  });
}

/** `dl agent read ID`: the last N assistant/tool lines from the event stream. */
export async function readAgent(input: {
  id: string;
  server?: string;
  lines?: number;
  json?: boolean;
  open?: RemoteOpener;
  idleMs?: number;
}, io = processIO): Promise<number> {
  const c = palette(io.color === true);
  return withConnections(input.open, async (connections) => {
    const { remote, run: found } = await findRun(input.id, input.server, connections, "agent");
    const client = await connections.client(remote);
    // The list's lastEventId can lag; the conversation itself is the snapshot to read up to.
    const conversation = await client.getConversation(found.conversationId);
    const lines = await recentLines(client, conversation.conversationId, conversation.lastEventId, input.lines ?? 20, input.idleMs ?? 10_000);
    if (input.json) {
      io.out(`${JSON.stringify({ id: conversation.conversationId.slice(0, 8), conversationId: conversation.conversationId, place: remote.name, state: agentState(conversation), lines }, null, 2)}\n`);
      return 0;
    }
    if (lines.length === 0) {
      io.out(`  ${c.dim("No output yet.")}\n`);
      return 0;
    }
    for (const line of lines) io.out(line.type === "tool" ? `  ${c.dim(`› ${line.text}`)}\n` : `${line.text}\n`);
    return 0;
  });
}

/**
 * Replays the stream up to `lastEventId` and keeps the last `limit` lines. Assistant deltas
 * are joined before splitting, so a line split across chunks still reads as one line.
 */
async function recentLines(client: RemoteClient, conversationId: string, lastEventId: number, limit: number, idleMs: number): Promise<AgentLine[]> {
  if (lastEventId <= 0) return [];
  const lines: AgentLine[] = [];
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), idleMs);
    timer.unref?.();
  };
  const push = (line: AgentLine) => {
    lines.push(line);
    if (lines.length > limit) lines.shift();
  };
  let assistant = "";
  const flush = () => {
    for (const raw of assistant.split("\n")) {
      const text = raw.trimEnd();
      if (text.trim()) push({ type: "assistant", text });
    }
    assistant = "";
  };
  arm();
  try {
    for await (const event of client.eventSnapshot(conversationId, 0, controller.signal)) {
      const line = eventLine(event);
      if (line === "assistant") {
        assistant += assistantText(event);
      } else if (line) {
        flush();
        push(line);
      }
      if (event.id >= lastEventId) break;
      arm();
    }
  } catch {
    // The stream dropped or went quiet; what arrived is what we show.
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
  flush();
  return lines;
}

function assistantText(event: RemoteEvent): string {
  const data = event.data;
  return typeof data.text === "string" ? data.text : typeof data.delta === "string" ? data.delta : "";
}

/** "assistant" for a delta (accumulated), a line for a tool call, undefined for anything else. */
function eventLine(event: RemoteEvent): AgentLine | "assistant" | undefined {
  if (event.type === "assistant.delta") return "assistant";
  if (event.type !== "tool.activity") return undefined;
  const tool = String(event.data.tool ?? "tool");
  if (event.data.activity === "failed") return { type: "tool", text: `${tool} failed`, activity: "failed" };
  if (event.data.activity !== "started") return undefined;
  const input = typeof event.data.input === "string" ? ` ${oneLine(event.data.input, 110)}` : "";
  return { type: "tool", text: `${tool}${input}`, activity: "started" };
}

class UsageError extends Error {}

const USAGE: Record<string, string> = {
  list: "dl agent list [--json]",
  prompt: 'dl agent prompt ID "text" [--wait] [--until done|blocked|idle] [--timeout DURATION]',
  read: "dl agent read ID [--lines N] [--json]",
  wait: "dl agent wait ID [--until done|blocked|idle] [--timeout DURATION]",
};

function parseUntil(text: string | undefined, usage: string): AgentState | undefined {
  if (text === undefined) return undefined;
  if (!WAIT_STATES.includes(text as AgentState)) throw new UsageError(`--until takes done, blocked or idle\n  Usage: ${usage}`);
  return text as AgentState;
}

function parseTimeout(text: string | undefined, usage: string): number | undefined {
  if (text === undefined) return undefined;
  const ms = parseDuration(text);
  if (ms === undefined) throw new UsageError(`--timeout takes a duration like 30s, 5m or 2h\n  Usage: ${usage}`);
  return ms;
}

export interface AgentCommandOptions {
  json?: boolean;
  wait?: boolean;
  until?: string;
  timeout?: string;
  lines?: string;
  server?: string;
  open?: RemoteOpener;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** `dl agent …`: list, prompt, read, wait. Usage errors exit 2; everything else 0, 1 or 124. */
export async function agentCommand(args: string[], options: AgentCommandOptions, io = processIO): Promise<number> {
  const [sub, ...rest] = args;
  const c = palette(io.color === true);
  const usage = (text: string) => {
    io.err(`  Usage: ${text}\n`);
    return 2;
  };
  const server = options.server ? { server: options.server } : {};
  const open = options.open ? { open: options.open } : {};
  const polling = {
    ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  };
  try {
    switch (sub) {
      case "list": {
        if (rest.length > 0) return usage(USAGE.list!);
        const { agents, unreachable } = await listAgents({ ...server, ...open });
        for (const entry of unreachable) io.err(`  ${c.red("✗")} ${entry.place}: ${entry.error}\n`);
        if (options.json) io.out(`${JSON.stringify(agents, null, 2)}\n`);
        else renderAgents(agents, io, c);
        return agents.length === 0 && unreachable.length > 0 ? 1 : 0;
      }
      case "prompt": {
        const id = rest[0];
        const text = rest.slice(1).join(" ").trim();
        if (!id || !text) return usage(USAGE.prompt!);
        const until = parseUntil(options.until, USAGE.prompt!);
        const timeoutMs = parseTimeout(options.timeout, USAGE.prompt!);
        return await promptAgent({
          id, text, ...server, ...open, ...polling,
          wait: Boolean(options.wait || until),
          ...(until ? { until } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          json: Boolean(options.json),
        }, io);
      }
      case "read": {
        const id = rest[0];
        if (!id || rest.length > 1) return usage(USAGE.read!);
        let lines: number | undefined;
        if (options.lines !== undefined) {
          lines = /^\d+$/.test(options.lines.trim()) ? Number(options.lines) : undefined;
          if (lines === undefined || lines < 1) return usage(USAGE.read!);
        }
        return await readAgent({ id, ...server, ...open, ...(lines !== undefined ? { lines } : {}), json: Boolean(options.json) }, io);
      }
      case "wait": {
        const id = rest[0];
        if (!id || rest.length > 1) return usage(USAGE.wait!);
        const until = parseUntil(options.until, USAGE.wait!);
        const timeoutMs = parseTimeout(options.timeout, USAGE.wait!);
        return await waitAgent({
          id, ...server, ...open, ...polling,
          ...(until ? { until } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          json: Boolean(options.json),
        }, io);
      }
      default:
        return usage("dl agent list|prompt|read|wait …");
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`  ${error.message}\n`);
      return 2;
    }
    io.err(`  ${c.red("✗")} ${describeError(error)}\n`);
    return 1;
  }
}
