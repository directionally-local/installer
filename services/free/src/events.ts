/**
 * Session events from Autopilot. Only the allowlisted props survive, each checked for type
 * and size; anything else is dropped before storage. Never prompts, completions, code, file
 * paths or file contents.
 */

export const EVENT_TYPES = ["session.start", "session.end", "turn.end", "pr.opened", "error"] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export const MAX_EVENTS_PER_CALL = 100;

export interface CleanEvent {
  id: string;
  type: EventType;
  sessionId: string | null;
  at: number;
  props: Record<string, unknown>;
}

const ID = /^[A-Za-z0-9._:-]{1,64}$/;
const SHORT_TEXT: Record<string, number> = {
  model: 100,
  provider: 64,
  exitReason: 64,
  errorCode: 64,
  autopilotVersion: 32,
  os: 32,
};
const COUNTS = ["turns", "durationMs"] as const;
const MAX_TOOLS = 100;
const FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

/** Keeps only the allowlisted props, each well-formed. */
export function cleanProps(input: unknown): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return props;
  const raw = input as Record<string, unknown>;
  for (const key of COUNTS) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) props[key] = Math.floor(value);
  }
  for (const [key, limit] of Object.entries(SHORT_TEXT)) {
    const value = raw[key];
    if (typeof value === "string" && value.length > 0 && value.length <= limit) props[key] = value;
  }
  if (typeof raw.repoHash === "string" && /^[0-9a-f]{64}$/.test(raw.repoHash)) props.repoHash = raw.repoHash;
  const tools = raw.toolCalls;
  if (tools && typeof tools === "object" && !Array.isArray(tools)) {
    const clean: Record<string, number> = {};
    let kept = 0;
    for (const [name, value] of Object.entries(tools as Record<string, unknown>)) {
      if (kept >= MAX_TOOLS) break;
      if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(name)) continue;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
      clean[name] = Math.floor(value);
      kept++;
    }
    if (kept > 0) props.toolCalls = clean;
  }
  return props;
}

/** One event, cleaned, or undefined when it can't be stored (bad id or unknown type). */
export function cleanEvent(input: unknown, now: number): CleanEvent | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  if (typeof raw.id !== "string" || !ID.test(raw.id)) return undefined;
  if (typeof raw.type !== "string" || !(EVENT_TYPES as readonly string[]).includes(raw.type)) return undefined;
  const sessionId = typeof raw.sessionId === "string" && ID.test(raw.sessionId) ? raw.sessionId : null;
  const parsedAt = typeof raw.at === "string" ? Date.parse(raw.at) : Number.NaN;
  const at = Number.isFinite(parsedAt) && parsedAt <= now + FUTURE_SKEW_MS ? parsedAt : now;
  return { id: raw.id, type: raw.type as EventType, sessionId, at, props: cleanProps(raw.props) };
}

/** The first `MAX_EVENTS_PER_CALL` storable events, with duplicate ids within the batch dropped. */
export function cleanBatch(input: unknown, now: number): CleanEvent[] {
  const list = input && typeof input === "object" ? (input as { events?: unknown }).events : undefined;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: CleanEvent[] = [];
  for (const item of list.slice(0, MAX_EVENTS_PER_CALL)) {
    const event = cleanEvent(item, now);
    if (!event || seen.has(event.id)) continue;
    seen.add(event.id);
    out.push(event);
  }
  return out;
}
