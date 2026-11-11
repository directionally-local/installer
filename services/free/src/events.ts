/**
 * Session events from Autopilot, and its GPU first run (gpu.*). Only the allowlisted props survive, each checked for type
 * and size; anything else is dropped before storage. Never prompts, completions, code, file
 * paths or file contents.
 */

import { plausibleEmail } from "./email-guard.js";

export const EVENT_TYPES = ["session.start", "session.end", "turn.end", "pr.opened", "error", "gpu.detected", "gpu.prompt", "gpu.option", "gpu.early_access", "gpu.result"] as const;
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

// ─── GPU first run ──────────────────────────────────────────────────────────
//
// Autopilot's GPU-aware first run: what GPU the machine has, whether the person wants a private
// model on it, which option they pick and how setting it up went. Sent as gpu.* events once
// signed in, and before sign-in as anonymous counts (POST /v1/telemetry/gpu, cleanGpuTelemetry).
// Counts and fixed words only: the GPU's marketing name is the one free-text field, and it is
// held to 64 characters of a small alphabet.

export const GPU_VENDORS = ["nvidia", "amd", "ascend", "none"] as const;
export const GPU_ANSWERS = ["yes", "no"] as const;
export const GPU_OPTIONS = ["free", "own_key", "gpus", "this_machine", "remote_server", "endpoint"] as const;
export const GPU_PATHS = ["this_machine", "remote_server", "endpoint"] as const;
export const GPU_OUTCOMES = ["ok", "failed"] as const;
export const GPU_ERROR_TYPES = [
  "cancelled",
  "no_docker",
  "no_toolkit",
  "toolkit_install_failed",
  "no_fit",
  "already_running",
  "launch_failed",
  "smoke_failed",
  "unreachable",
  "unauthorized",
  "http",
  "not_openai",
  "no_models",
  "save_failed",
  "other",
] as const;
/** The anonymous body's `event`: the gpu.* event type without its prefix. */
export const GPU_EVENTS = ["detected", "prompt", "early_access", "option", "result"] as const;
/** Vendors early access is offered for (no supported runtime for them yet). */
export const GPU_EARLY_ACCESS_VENDORS = ["amd", "ascend"] as const;

export type GpuVendor = (typeof GPU_VENDORS)[number];
export type GpuEvent = (typeof GPU_EVENTS)[number];

const GPU_MODEL = /^[A-Za-z0-9 ._()+/-]{1,64}$/;
const MAX_VRAM_GB = 100_000;
const MAX_GPU_COUNT = 64;

function oneOf<T extends string>(list: readonly T[], value: unknown): T | undefined {
  return typeof value === "string" && (list as readonly string[]).includes(value) ? (value as T) : undefined;
}

function plainObject(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
}

/** The GPU fields, each checked; anything missing, malformed or unknown is left out, and errorType without outcome failed. */
export function cleanGpuProps(input: unknown): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const raw = plainObject(input);
  if (!raw) return props;
  const vendor = oneOf(GPU_VENDORS, raw.gpuVendor);
  if (vendor) props.gpuVendor = vendor;
  if (typeof raw.gpuModel === "string" && GPU_MODEL.test(raw.gpuModel)) props.gpuModel = raw.gpuModel;
  if (typeof raw.gpuVramGb === "number" && Number.isFinite(raw.gpuVramGb) && raw.gpuVramGb >= 0 && raw.gpuVramGb <= MAX_VRAM_GB) props.gpuVramGb = Math.round(raw.gpuVramGb);
  if (typeof raw.gpuCount === "number" && Number.isInteger(raw.gpuCount) && raw.gpuCount >= 0 && raw.gpuCount <= MAX_GPU_COUNT) props.gpuCount = raw.gpuCount;
  for (const [key, list] of [
    ["answer", GPU_ANSWERS],
    ["option", GPU_OPTIONS],
    ["path", GPU_PATHS],
    ["outcome", GPU_OUTCOMES],
    ["errorType", GPU_ERROR_TYPES],
  ] as const) {
    const value = oneOf<string>(list, raw[key]);
    if (value) props[key] = value;
  }
  // An error type goes only with a failed outcome.
  if (props.outcome !== "failed") delete props.errorType;
  return props;
}

/** One anonymous GPU first-run count, as stored: "" for a word not sent, -1 for a number not sent. */
export interface GpuCount {
  event: GpuEvent;
  gpuVendor: GpuVendor | "";
  gpuModel: string;
  gpuVramGb: number;
  gpuCount: number;
  answer: (typeof GPU_ANSWERS)[number] | "";
  option: (typeof GPU_OPTIONS)[number] | "";
  path: (typeof GPU_PATHS)[number] | "";
  outcome: (typeof GPU_OUTCOMES)[number] | "";
  errorType: (typeof GPU_ERROR_TYPES)[number] | "";
}

/**
 * The anonymous body `{event, gpuVendor?, gpuModel?, gpuVramGb?, gpuCount?, answer?, option?,
 * path?, outcome?, errorType?}`, or a reason it was refused. Each event needs its own fields
 * (detected: gpuVendor; prompt: gpuVendor and answer; early_access: gpuVendor amd or ascend and
 * answer; option: option; result: outcome and path); a malformed optional field is dropped, as is
 * errorType unless the outcome is failed (where it defaults to "other"). Other keys are ignored.
 */
export function cleanGpuTelemetry(input: unknown): GpuCount | string {
  const raw = plainObject(input);
  if (!raw) return "Send {event, gpuVendor?, gpuModel?, gpuVramGb?, gpuCount?, answer?, option?, path?, outcome?, errorType?}.";
  const event = oneOf(GPU_EVENTS, raw.event);
  if (!event) return `event is one of ${GPU_EVENTS.join(", ")}.`;
  const props = cleanGpuProps(raw);
  const need = (key: string, list: readonly string[]): string | undefined => (props[key] === undefined ? `${key} is one of ${list.join(", ")}.` : undefined);
  const missing =
    event === "detected"
      ? need("gpuVendor", GPU_VENDORS)
      : event === "prompt"
        ? (need("gpuVendor", GPU_VENDORS) ?? need("answer", GPU_ANSWERS))
        : event === "early_access"
          ? (oneOf(GPU_EARLY_ACCESS_VENDORS, raw.gpuVendor) ? undefined : `gpuVendor is one of ${GPU_EARLY_ACCESS_VENDORS.join(", ")}.`) ?? need("answer", GPU_ANSWERS)
          : event === "option"
            ? need("option", GPU_OPTIONS)
            : (need("outcome", GPU_OUTCOMES) ?? need("path", GPU_PATHS));
  if (missing) return missing;
  const word = <T extends string>(key: string) => (props[key] as T | undefined) ?? "";
  const outcome = word<GpuCount["outcome"]>("outcome");
  return {
    event,
    gpuVendor: word<GpuCount["gpuVendor"]>("gpuVendor"),
    gpuModel: word("gpuModel"),
    gpuVramGb: (props.gpuVramGb as number | undefined) ?? -1,
    gpuCount: (props.gpuCount as number | undefined) ?? -1,
    answer: word<GpuCount["answer"]>("answer"),
    option: word<GpuCount["option"]>("option"),
    path: word<GpuCount["path"]>("path"),
    outcome,
    errorType: outcome === "failed" ? word<GpuCount["errorType"]>("errorType") || "other" : "",
  };
}

/**
 * The optional `email` a "yes" to early access may carry (Autopilot asks for one after the Yes),
 * trimmed, or undefined: on any other event or answer, or when it isn't a plausible address of
 * at most 254 characters. A bad email is dropped, never a reason to refuse the count. It is kept
 * apart from the anonymous counts (directory-object.ts early_access_leads).
 */
export function earlyAccessEmail(input: unknown, count: GpuCount): string | undefined {
  if (count.event !== "early_access" || count.answer !== "yes") return undefined;
  const raw = plainObject(input)?.email;
  if (typeof raw !== "string") return undefined;
  const email = raw.trim();
  return plausibleEmail(email) ? email : undefined;
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
  // gpu.* events carry only the GPU fields; the others only the session fields.
  const props = raw.type.startsWith("gpu.") ? cleanGpuProps(raw.props) : cleanProps(raw.props);
  return { id: raw.id, type: raw.type as EventType, sessionId, at, props };
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
