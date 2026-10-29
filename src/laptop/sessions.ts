import { palette } from "../ui.js";
import { TERMINAL_STATUSES, type RemoteConversation } from "./client.js";
import { describeError, processIO, where, type LaptopIO } from "./commands.js";
import { loadRemotes, resolveRemote, type RemoteServer } from "./config.js";
import { withConnections, type Connections, type RemoteOpener } from "./tunnel.js";

/**
 * `dl sessions`: every conversation on every place this laptop is connected to, with the
 * state a sidebar needs. The server's own `state`/`costUsd`/`lastActivityAt` are used when
 * it sends them (autopilot#1046); older servers only send `status`, which is mapped here.
 * A place that doesn't answer is shown as unreachable instead of failing the command.
 */

export type SessionState = "working" | "blocked" | "idle" | "done" | "failed";

const SESSION_STATES: readonly SessionState[] = ["working", "blocked", "idle", "done", "failed"];

/** Finished conversations older than this are hidden unless `--all`. */
export const FINISHED_MAX_AGE_SECONDS = 24 * 60 * 60;

export interface SessionRow {
  place: string;
  repository: string;
  /** The short ID `dl watch` and `dl pull` take. */
  id: string;
  conversationId: string;
  state: SessionState;
  /** The server's raw status, for scripts that know it. */
  status: string;
  title?: string;
  branch?: string;
  costUsd?: number;
  lastActivityAt: string;
  ageSeconds: number;
  pullRequest?: { number?: number; url?: string };
  waitingFor?: { tool?: string; summary?: string };
  lastError?: string;
}

export interface RepositorySessions {
  repository: string;
  sessions: SessionRow[];
}

export interface PlaceSessions {
  place: string;
  /** This computer, its URL, or the SSH destination, as `dl servers` shows it. */
  location: string;
  reachable: boolean;
  error?: string;
  repositories: RepositorySessions[];
}

export interface SessionsReport {
  places: PlaceSessions[];
  /** Finished conversations left out because they're older than a day. */
  hidden: number;
}

export interface SessionsInput {
  /** Limit to one place. */
  server?: string;
  json?: boolean;
  /** Include finished conversations older than a day. */
  all?: boolean;
  open?: RemoteOpener;
  /** The clock, for tests. */
  now?: () => number;
}

export async function sessions(input: SessionsInput = {}, io: LaptopIO = processIO): Promise<void> {
  const remotes = input.server ? [await resolveRemote(input.server)] : await loadRemotes();
  if (remotes.length === 0) {
    throw new Error("Nothing is set up yet. Run: dl setup  (or, for a server someone else set up: dl connect https://your-server)");
  }
  const now = (input.now ?? Date.now)();
  const report = await withConnections(input.open, (connections) => collectSessions(remotes, connections, { all: input.all === true, now }));
  if (input.json) {
    io.out(`${JSON.stringify(toJson(report), null, 2)}\n`);
    return;
  }
  render(report, io);
}

/** Asks every place for its conversations; a place that fails becomes an unreachable entry. */
export async function collectSessions(
  remotes: RemoteServer[],
  connections: Connections,
  options: { all: boolean; now: number },
): Promise<SessionsReport> {
  const places: PlaceSessions[] = [];
  let hidden = 0;
  for (const remote of remotes) {
    let conversations: RemoteConversation[];
    try {
      conversations = await (await connections.client(remote)).listConversations(200);
    } catch (error) {
      places.push({ place: remote.name, location: where(remote), reachable: false, error: describeError(error), repositories: [] });
      continue;
    }
    const rows: SessionRow[] = [];
    for (const conversation of conversations) {
      // Chat conversations aren't agents; a server that doesn't say is assumed to be code.
      if (conversation.kind === "chat") continue;
      const row = toRow(remote.name, conversation, options.now);
      if (!options.all && isFinished(row) && row.ageSeconds > FINISHED_MAX_AGE_SECONDS) {
        hidden++;
        continue;
      }
      rows.push(row);
    }
    places.push({ place: remote.name, location: where(remote), reachable: true, repositories: groupByRepository(rows) });
  }
  return { places, hidden };
}

/** The state a sidebar draws: the server's own when it sends one, else mapped from `status`. */
export function sessionState(conversation: Pick<RemoteConversation, "state" | "status" | "activeRunId">): SessionState {
  if (isSessionState(conversation.state)) return conversation.state;
  const status = (conversation.status ?? "").toLowerCase();
  if (status === "waiting_approval" || status === "waiting-approval" || status === "blocked") return "blocked";
  if (TERMINAL_STATUSES.has(status)) return status === "completed" || status === "merged" || status === "destroyed" ? "done" : "failed";
  // Today's servers may still say "ready" while a run is active.
  if (conversation.activeRunId) return "working";
  if (status === "running" || status === "provisioning" || status === "working") return "working";
  return "idle";
}

function isSessionState(value: unknown): value is SessionState {
  return typeof value === "string" && (SESSION_STATES as readonly string[]).includes(value);
}

function isFinished(row: SessionRow): boolean {
  return row.state === "done" || row.state === "failed";
}

function toRow(place: string, conversation: RemoteConversation, now: number): SessionRow {
  const activity = activityTime(conversation, now);
  const pullRequest = conversation.pullRequestNumber !== undefined || conversation.pullRequestURL
    ? {
      ...(conversation.pullRequestNumber !== undefined ? { number: conversation.pullRequestNumber } : {}),
      ...(conversation.pullRequestURL ? { url: conversation.pullRequestURL } : {}),
    }
    : undefined;
  return {
    place,
    repository: conversation.repository ?? "",
    id: conversation.conversationId.slice(0, 8),
    conversationId: conversation.conversationId,
    state: sessionState(conversation),
    status: conversation.status,
    ...(conversation.title ? { title: conversation.title } : {}),
    ...(conversation.branch ? { branch: conversation.branch } : {}),
    ...(typeof conversation.costUsd === "number" && Number.isFinite(conversation.costUsd) ? { costUsd: conversation.costUsd } : {}),
    lastActivityAt: new Date(activity).toISOString(),
    ageSeconds: Math.max(0, Math.round((now - activity) / 1000)),
    ...(pullRequest ? { pullRequest } : {}),
    ...(conversation.waitingFor ? { waitingFor: conversation.waitingFor } : {}),
    ...(conversation.lastError ? { lastError: conversation.lastError } : {}),
  };
}

/** When the conversation last did anything: the server's field, else its timestamps. */
function activityTime(conversation: RemoteConversation, now: number): number {
  for (const value of [conversation.lastActivityAt, conversation.updatedAt, conversation.createdAt]) {
    if (typeof value !== "string") continue;
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return now;
}

/** Grouped by repository, newest repository first, blocked first and then newest within one. */
export function groupByRepository(rows: SessionRow[]): RepositorySessions[] {
  const byRepository = new Map<string, SessionRow[]>();
  for (const row of rows) {
    const key = row.repository || "(no repository)";
    const list = byRepository.get(key);
    if (list) list.push(row);
    else byRepository.set(key, [row]);
  }
  const repositories = [...byRepository].map(([repository, sessions]) => ({ repository, sessions: sortSessions(sessions) }));
  repositories.sort((a, b) => newest(b.sessions) - newest(a.sessions) || a.repository.localeCompare(b.repository));
  return repositories;
}

function sortSessions(rows: SessionRow[]): SessionRow[] {
  return [...rows].sort((a, b) =>
    blockedRank(a) - blockedRank(b) ||
    Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt) ||
    a.id.localeCompare(b.id));
}

function blockedRank(row: SessionRow): number {
  return row.state === "blocked" ? 0 : 1;
}

function newest(rows: SessionRow[]): number {
  return rows.reduce((latest, row) => Math.max(latest, Date.parse(row.lastActivityAt)), 0);
}

/** `3s`, `12m`, `4h`, `2d`, `3mo`, `1y`. */
export function formatAge(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  if (value < 60) return `${value}s`;
  const minutes = Math.floor(value / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

/** `$0.42`, `<$0.01`, or nothing when the server doesn't report a cost. */
export function formatCost(cost: number | undefined): string {
  if (cost === undefined || !Number.isFinite(cost)) return "";
  if (cost > 0 && cost < 0.01) return "<$0.01";
  return `$${cost.toFixed(2)}`;
}

const GLYPH: Record<SessionState, (c: ReturnType<typeof palette>) => string> = {
  working: (c) => c.cyan("◐"),
  blocked: (c) => c.yellow("!"),
  idle: (c) => c.dim("○"),
  done: (c) => c.green("✓"),
  failed: (c) => c.red("✗"),
};

const STATE_ORDER: SessionState[] = ["working", "blocked", "idle", "done", "failed"];

function render(report: SessionsReport, io: LaptopIO): void {
  const c = palette(io.color === true);
  io.out("\n");
  let shown = 0;
  for (const place of report.places) {
    if (!place.reachable) {
      io.out(`  ${c.red("✗")} ${c.bold(place.place)}  ${c.dim(place.location)}  ${c.red("unreachable")}  ${c.dim(place.error ?? "")}\n\n`);
      continue;
    }
    const rows = place.repositories.flatMap((repository) => repository.sessions);
    shown += rows.length;
    const counts = countStates(rows);
    io.out(`  ${c.bold(place.place)}  ${c.dim(place.location)}${counts ? `  ${c.dim(counts)}` : ""}\n`);
    if (place.repositories.length === 0) {
      io.out(`    ${c.dim("no conversations")}\n\n`);
      continue;
    }
    for (const repository of place.repositories) {
      io.out(`\n    ${c.bold(repository.repository)}\n`);
      for (const row of repository.sessions) io.out(`${rowLine(row, c)}\n`);
    }
    io.out("\n");
  }
  if (shown === 0) {
    io.out(`  ${c.dim("No conversations yet. From inside a GitHub repository:")} ${c.bold("dl")}\n\n`);
  } else {
    io.out(`  ${c.dim("Follow one:")} dl watch <id>   ${c.dim("Check one out:")} dl pull <id>\n\n`);
  }
  if (report.hidden > 0) {
    io.out(`  ${c.dim(`${report.hidden} finished older than a day hidden; --all shows them`)}\n\n`);
  }
}

function rowLine(row: SessionRow, c: ReturnType<typeof palette>): string {
  const title = oneLine(row.title ?? row.branch ?? "—", 44);
  const cost = formatCost(row.costUsd);
  const pr = row.pullRequest?.number !== undefined ? `#${row.pullRequest.number}` : row.pullRequest?.url ? "PR" : "";
  return `      ${GLYPH[row.state](c)} ${row.id.padEnd(8)} ${row.state.padEnd(8)} ${formatAge(row.ageSeconds).padStart(4)}  ${title.padEnd(44)}  ${cost.padStart(7)}  ${pr}`.trimEnd();
}

function countStates(rows: SessionRow[]): string {
  const counts = new Map<SessionState, number>();
  for (const row of rows) counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
  return STATE_ORDER
    .filter((state) => counts.has(state))
    .map((state) => `${counts.get(state)} ${state}`)
    .join(" · ");
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The `--json` shape: flat rows in display order, plus the places that didn't answer. */
function toJson(report: SessionsReport): unknown {
  return {
    sessions: report.places.flatMap((place) => place.repositories.flatMap((repository) => repository.sessions.map((row) => ({
      place: row.place,
      repository: row.repository,
      id: row.id,
      conversationId: row.conversationId,
      state: row.state,
      status: row.status,
      ...(row.title !== undefined ? { title: row.title } : {}),
      ...(row.branch !== undefined ? { branch: row.branch } : {}),
      ...(row.costUsd !== undefined ? { costUsd: row.costUsd } : {}),
      lastActivityAt: row.lastActivityAt,
      ageSeconds: row.ageSeconds,
      ...(row.pullRequest ? { pullRequest: row.pullRequest } : {}),
      ...(row.waitingFor ? { waitingFor: row.waitingFor } : {}),
      ...(row.lastError ? { lastError: row.lastError } : {}),
    })))),
    unreachable: report.places
      .filter((place) => !place.reachable)
      .map((place) => ({ place: place.place, error: place.error ?? "unreachable" })),
    hidden: report.hidden,
  };
}
