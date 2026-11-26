import type { Sql } from "./dashboard-data.js";
import { DAY_MS } from "./week.js";

/**
 * Agent requests: when dl's first run finds no coding agent it supports, the person can name the
 * one they use, and dl posts it here so the owner hears which agents to support next.
 *
 *   POST /v1/agent-request {name, os?, arch?, dlVersion?, found?}
 *     → 200 {ok: true}; 400 invalid_request (which field), 429 rate_limited
 *   GET  /admin/agent-requests (or /v1/admin/agent-requests) → {requests, total} (admins)
 *
 * Sign-in is optional: a valid Bearer (access token or dl key) attaches the GitHub login and
 * account id; a missing or invalid one never fails the request. No IP is kept. What people type
 * is user content: stored as plain text, sent to the owner in a plain-text email with control
 * characters removed, never logged. Limits: AGENT_REQUEST_IP per network, AGENT_REQUESTS_PER_DAY
 * in all a UTC day; the owner is emailed about the first AGENT_REQUEST_EMAILS_PER_DAY of them.
 */

export const AGENT_REQUEST_PATH = "/v1/agent-request";
/** Requests kept a UTC day, from everyone. */
export const AGENT_REQUESTS_PER_DAY = 500;
/** Owner emails a UTC day; the rest are kept without one. */
export const AGENT_REQUEST_EMAILS_PER_DAY = 50;
/** The largest body read, in bytes. */
export const AGENT_REQUEST_MAX_BYTES = 16 * 1024;
/** The most requests the admin read returns. */
export const AGENT_REQUESTS_LISTED = 500;
/** `found`: at most this many agents, each at most FOUND_ITEM_MAX characters. */
export const FOUND_MAX_ITEMS = 40;
export const FOUND_ITEM_MAX = 40;

/** The text fields: their longest (characters, after trimming), and whether required. */
export const AGENT_REQUEST_FIELDS = {
  name: { max: 80, required: true },
  os: { max: 40, required: false },
  arch: { max: 20, required: false },
  dlVersion: { max: 40, required: false },
} as const;
type TextField = keyof typeof AGENT_REQUEST_FIELDS;
const TEXT_FIELDS = Object.keys(AGENT_REQUEST_FIELDS) as TextField[];

export interface AgentRequestInput {
  name: string;
  os: string | null;
  arch: string | null;
  dlVersion: string | null;
  found: string[];
}

export interface AgentRequestAccount {
  githubId: number;
  login: string;
}

export interface AgentRequest extends AgentRequestInput {
  id: number;
  at: number;
  login: string | null;
  githubId: number | null;
}

/** One line of text: line breaks and tabs become spaces, other control characters go, trimmed. */
function clean(value: string): string {
  return value
    .replace(/[\t\n\r\u000b\u000c\u0085\u2028\u2029]+/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim();
}

const length = (text: string) => [...text].length;

/**
 * Checks a POST /v1/agent-request body. Unknown fields are ignored, so a newer dl can send more
 * without being refused by this service.
 */
export function parseAgentRequest(body: unknown): { ok: true; value: AgentRequestInput } | { ok: false; message: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, message: "Send a JSON object: {name, os?, arch?, dlVersion?, found?}." };
  const raw = body as Record<string, unknown>;
  const out: Record<string, string | null> = {};
  for (const field of TEXT_FIELDS) {
    const spec = AGENT_REQUEST_FIELDS[field];
    const value = raw[field];
    if (value === undefined || value === null) {
      if (spec.required) return { ok: false, message: `${field} is required.` };
      out[field] = null;
      continue;
    }
    if (typeof value !== "string") return { ok: false, message: `${field} must be a string.` };
    const text = clean(value);
    if (text === "") {
      if (spec.required) return { ok: false, message: `${field} is required.` };
      out[field] = null;
      continue;
    }
    if (length(text) > spec.max) return { ok: false, message: `${field} can be at most ${spec.max} characters.` };
    out[field] = text;
  }
  const found: string[] = [];
  if (raw.found !== undefined && raw.found !== null) {
    if (!Array.isArray(raw.found)) return { ok: false, message: "found must be a list of strings." };
    if (raw.found.length > FOUND_MAX_ITEMS) return { ok: false, message: `found can list at most ${FOUND_MAX_ITEMS} agents.` };
    for (const item of raw.found) {
      if (typeof item !== "string") return { ok: false, message: "found must be a list of strings." };
      const text = clean(item);
      if (length(text) > FOUND_ITEM_MAX) return { ok: false, message: `Each found agent can be at most ${FOUND_ITEM_MAX} characters.` };
      if (text !== "" && !found.includes(text)) found.push(text);
    }
  }
  return { ok: true, value: { name: out.name!, os: out.os ?? null, arch: out.arch ?? null, dlVersion: out.dlVersion ?? null, found } };
}

// ─── Storage (the Directory's SQL) ────────────────────────────────────────────

export const AGENT_REQUEST_SCHEMA = [
  // Coding agents people asked dl to support (agent-request.ts). User content; never an IP.
  `CREATE TABLE IF NOT EXISTS agent_requests (
     id         INTEGER PRIMARY KEY,
     at         INTEGER NOT NULL,
     name       TEXT NOT NULL,
     os         TEXT,
     arch       TEXT,
     dl_version TEXT,
     found      TEXT NOT NULL,
     github_id  INTEGER,
     login      TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS agent_requests_at ON agent_requests (at)`,
];

/**
 * Keeps a request unless `perDay` (AGENT_REQUESTS_PER_DAY) were already kept this UTC day.
 * `email`: whether the owner should be emailed (the first `emailsPerDay` of the day).
 */
export function saveAgentRequest(
  sql: Sql,
  input: { now: number; request: AgentRequestInput; account: AgentRequestAccount | null; perDay?: number; emailsPerDay?: number },
): { ok: true; id: number; today: number; email: boolean } | { ok: false } {
  const day = Math.floor(input.now / DAY_MS);
  const before = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM agent_requests WHERE at >= ? AND at < ?", day * DAY_MS, (day + 1) * DAY_MS).toArray()[0]?.n ?? 0;
  if (before >= (input.perDay ?? AGENT_REQUESTS_PER_DAY)) return { ok: false };
  const r = input.request;
  const row = sql
    .exec<{ id: number }>(
      "INSERT INTO agent_requests (at, name, os, arch, dl_version, found, github_id, login) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
      input.now,
      r.name,
      r.os,
      r.arch,
      r.dlVersion,
      JSON.stringify(r.found),
      input.account?.githubId ?? null,
      input.account?.login ?? null,
    )
    .toArray()[0];
  const today = before + 1;
  return { ok: true, id: row?.id ?? 0, today, email: today <= (input.emailsPerDay ?? AGENT_REQUEST_EMAILS_PER_DAY) };
}

function parseFound(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** The newest requests first (at most `limit`), and how many are kept in all. */
export function listAgentRequests(sql: Sql, limit = AGENT_REQUESTS_LISTED): { requests: AgentRequest[]; total: number } {
  const rows = sql
    .exec<{ id: number; at: number; name: string; os: string | null; arch: string | null; dl_version: string | null; found: string; github_id: number | null; login: string | null }>(
      "SELECT id, at, name, os, arch, dl_version, found, github_id, login FROM agent_requests ORDER BY at DESC, id DESC LIMIT ?",
      limit,
    )
    .toArray();
  const total = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM agent_requests").toArray()[0]?.n ?? 0;
  return {
    total,
    requests: rows.map((row) => ({ id: row.id, at: row.at, name: row.name, os: row.os, arch: row.arch, dlVersion: row.dl_version, found: parseFound(row.found), githubId: row.github_id, login: row.login })),
  };
}

// ─── The owner's email ────────────────────────────────────────────────────────

/** The owner's plain-text email: subject `dl: unsupported coding agent "<name>"` (one line). */
export function agentRequestEmail(request: AgentRequestInput, account: AgentRequestAccount | null, at: number, today: number): { subject: string; body: string } {
  const when = new Date(at).toISOString().replace("T", " ").slice(0, 16);
  const platform = [request.os, request.arch].filter((part) => part !== null).join("/");
  return {
    subject: `dl: unsupported coding agent "${request.name}"`.replace(/[\r\n]+/g, " "),
    body: [
      "Someone asked dl to support a coding agent it doesn't know yet.",
      "",
      `Agent: ${request.name}`,
      `OS/arch: ${platform || "(not given)"}`,
      `dl version: ${request.dlVersion ?? "(not given)"}`,
      `Agents dl found: ${request.found.length ? request.found.join(", ") : "(none)"}`,
      `Account: ${account ? `${account.login} (id ${account.githubId})` : "(not signed in)"}`,
      "",
      `Time: ${when} UTC`,
      `Requests today: ${today}`,
      "",
      "List: GET /admin/agent-requests.",
      `Sent for each request, up to ${AGENT_REQUEST_EMAILS_PER_DAY} a UTC day; past that they are kept and listed only. The agent name was typed by the sender.`,
      "",
    ].join("\n"),
  };
}

/** The admin JSON: ISO times. */
export function agentRequestsJson(list: { requests: AgentRequest[]; total: number }): Record<string, unknown> {
  return { total: list.total, requests: list.requests.map((request) => ({ ...request, at: new Date(request.at).toISOString() })) };
}
