import type { RemoteConversation } from "./client.js";
import { describeError } from "./commands.js";
import type { RemoteServer } from "./config.js";
import type { Connections } from "./tunnel.js";

/**
 * Conversations across every place this laptop is connected to, as `dl attach` (and, later,
 * `dl sessions`) needs them: one flat list with the place, a state that doesn't depend on
 * screen-scraping, and the summary fields newer servers send. Places that don't answer are
 * reported instead of failing the whole listing.
 */

/** A conversation plus where it lives and the state to show for it. */
export interface ConversationSummary extends RemoteConversation {
  /** The place's name, as in `dl servers`. */
  place: string;
  /** `running`, `waiting_approval`, `completed`, `failed`, … (the server's, or mapped from status). */
  state: string;
  title?: string;
  lastActivityAt?: string;
  costUsd?: number;
}

/** States that mean the agent is waiting for a person. */
const BLOCKED_STATES = new Set(["waiting_approval", "waiting_input", "needs_approval", "blocked"]);

/** The state to show: the server's summary when it has one, else mapped from status. */
export function conversationState(conversation: RemoteConversation): string {
  if (typeof conversation.state === "string" && conversation.state.trim()) return conversation.state.trim();
  if (conversation.activeRunId) return "running";
  return conversation.status;
}

export function isBlocked(state: string): boolean {
  return BLOCKED_STATES.has(state);
}

export function summarize(conversation: RemoteConversation, place: string): ConversationSummary {
  return {
    ...conversation,
    place,
    state: conversationState(conversation),
    ...(typeof conversation.title === "string" && conversation.title.trim() ? { title: conversation.title.trim() } : {}),
    ...(typeof conversation.lastActivityAt === "string" && conversation.lastActivityAt ? { lastActivityAt: conversation.lastActivityAt } : {}),
    ...(typeof conversation.costUsd === "number" ? { costUsd: conversation.costUsd } : {}),
  };
}

/** When it last did anything, for ordering and the age column. */
export function activityAt(conversation: ConversationSummary): string {
  return conversation.lastActivityAt ?? conversation.updatedAt ?? conversation.createdAt ?? "";
}

/**
 * The picker's order: blocked conversations first (they need someone), then the most
 * recently active. Ties fall back to the ID so the order is stable.
 */
export function pickerOrder(rows: ConversationSummary[]): ConversationSummary[] {
  return [...rows].sort((a, b) => {
    const blocked = Number(isBlocked(b.state)) - Number(isBlocked(a.state));
    if (blocked !== 0) return blocked;
    return activityAt(b).localeCompare(activityAt(a)) || a.conversationId.localeCompare(b.conversationId);
  });
}

/** "now", "5m", "3h", "2d": how long ago something happened. */
export function ageLabel(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const ms = Math.max(0, now - then);
  if (ms < 60_000) return "now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export interface ConversationListing {
  rows: ConversationSummary[];
  /** Places that couldn't be asked, with why. */
  unreachable: Array<{ place: string; reason: string }>;
}

/** Every conversation on every place, newest first within each place. */
export async function listConversationsAcross(
  remotes: RemoteServer[],
  connections: Connections,
  options: { limit?: number; kind?: "code" } = {},
): Promise<ConversationListing> {
  const rows: ConversationSummary[] = [];
  const unreachable: Array<{ place: string; reason: string }> = [];
  for (const remote of remotes) {
    try {
      const list = await (await connections.client(remote)).listConversations(options.limit ?? 200);
      for (const entry of list) {
        if (options.kind && entry.kind !== options.kind) continue;
        rows.push(summarize(entry, remote.name));
      }
    } catch (error) {
      unreachable.push({ place: remote.name, reason: describeError(error) });
    }
  }
  return { rows, unreachable };
}

/** The one conversation an ID (or unique prefix) names, across every place. */
export function resolveConversationId(id: string, rows: ConversationSummary[], unreachable: Array<{ place: string; reason: string }> = []): ConversationSummary {
  const needle = id.trim().toLowerCase();
  if (!/^[0-9a-f-]{4,36}$/.test(needle)) throw new Error("Conversation IDs are the short hex IDs dl attach shows");
  const matches = rows.filter((row) => row.conversationId.toLowerCase().startsWith(needle));
  const why = unreachable.length ? `\n${unreachable.map((entry) => `${entry.place}: ${entry.reason}`).join("\n")}` : "";
  if (matches.length === 0) throw new Error(`No conversation ${id} on any connected place${why}`);
  if (matches.length > 1) throw new Error(`${id} matches several conversations; use more characters`);
  return matches[0]!;
}
