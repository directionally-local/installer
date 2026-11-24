import type { Sql } from "./dashboard-data.js";
import { DAY_MS } from "./week.js";

/**
 * Event codes: multi-use sign-up codes for a class, a workshop or a hackathon, made by an admin
 * (POST /admin/event-codes or the Tools tab). A group often signs up together from one network
 * and one email domain, with GitHub accounts made the same week, which is exactly what the
 * per-network limit, the per-domain limit and the creation-batch check stop. A valid event code
 * skips those three for a new sign-up; nothing else (blocked emails, one account per inbox and
 * per device, the queue and the GitHub activity check all still apply).
 *
 * A code has a maximum number of uses and an expiry, and an admin can end it early. By default a
 * sign-up with a code gets the level its own GitHub signals give (as if it were alone on its
 * network), so the token allocator starts it like any new account; a code made with `full`
 * gives Full like an invite does. Uses are counted per code, with who used it, for the admin.
 *
 * Only a hash of each code is stored (like invite codes): the code is shown once, when made.
 */

export const EVENT_CODE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS event_codes (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     code_hash  TEXT NOT NULL UNIQUE,
     note       TEXT,
     max_uses   INTEGER NOT NULL,
     uses       INTEGER NOT NULL DEFAULT 0,
     expires_at INTEGER NOT NULL,
     full       INTEGER NOT NULL DEFAULT 0,
     created_by INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     ended_at   INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS event_code_uses (
     code_id   INTEGER NOT NULL,
     github_id INTEGER NOT NULL,
     login     TEXT NOT NULL,
     at        INTEGER NOT NULL,
     PRIMARY KEY (code_id, github_id)
   )`,
];

/** The most uses one code may have, and the longest it may stay open. */
export const EVENT_CODE_MAX_USES = 1000;
export const EVENT_CODE_MAX_DAYS = 60;

// The invite codes' alphabet: consonants and digits with no look-alikes (codes.ts).
const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";

/** `EV-XXXX-XXXX`: the prefix keeps it apart from invite codes (`DL-XXXX-XXXX`) in the same field. */
export function newEventCode(): string {
  const limit = 256 - (256 % ALPHABET.length);
  let out = "";
  while (out.length < 8) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < limit && out.length < 8) out += ALPHABET[byte % ALPHABET.length];
    }
  }
  return `EV-${out.slice(0, 4)}-${out.slice(4)}`;
}

/** `ev-bcdf-2345`, `EV BCDF 2345` and `evbcdf2345` all become `EV-BCDF-2345`; anything else is undefined. */
export function normalizeEventCode(input: string): string | undefined {
  const compact = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^EV[A-Z0-9]{8}$/.test(compact)) return undefined;
  return `EV-${compact.slice(2, 6)}-${compact.slice(6)}`;
}

export interface EventCodeInput {
  note: string | null;
  maxUses: number;
  /** Days from now until the code stops working. */
  days: number;
  /** Sign-ups with the code get Full (like an invite) instead of their own signals' level. */
  full: boolean;
}

/** An admin's request body (JSON or the Tools form's fields), checked; an error says what to fix. */
export function parseEventCodeInput(body: Record<string, unknown>): EventCodeInput | { error: string } {
  const maxUses = Number(body.maxUses);
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > EVENT_CODE_MAX_USES) return { error: `maxUses must be 1 to ${EVENT_CODE_MAX_USES}.` };
  const days = body.days === undefined || body.days === "" ? 7 : Number(body.days);
  if (!Number.isInteger(days) || days < 1 || days > EVENT_CODE_MAX_DAYS) return { error: `days must be 1 to ${EVENT_CODE_MAX_DAYS}.` };
  // JSON true, or a ticked form checkbox; anything else is the default (the person's own level).
  const full = body.full === true || body.full === "1" || body.full === "on";
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 200) : null;
  return { note, maxUses, days, full };
}

export interface EventCodeRow {
  id: number;
  note: string | null;
  maxUses: number;
  uses: number;
  expiresAt: number;
  full: boolean;
  createdBy: number;
  createdAt: number;
  endedAt: number | null;
  /** "open", "used_up", "expired" or "ended". */
  status: EventCodeStatus;
  /** Who signed up with it, first first. */
  people: Array<{ githubId: number; login: string; at: number }>;
}

export type EventCodeStatus = "open" | "used_up" | "expired" | "ended";

interface StoredCode {
  id: number;
  note: string | null;
  max_uses: number;
  uses: number;
  expires_at: number;
  full: number;
  created_by: number;
  created_at: number;
  ended_at: number | null;
}

function statusOf(row: Pick<StoredCode, "max_uses" | "uses" | "expires_at" | "ended_at">, now: number): EventCodeStatus {
  if (row.ended_at !== null) return "ended";
  if (row.expires_at <= now) return "expired";
  if (row.uses >= row.max_uses) return "used_up";
  return "open";
}

export function insertEventCode(sql: Sql, input: EventCodeInput & { codeHash: string; createdBy: number; now: number }): number {
  return sql
    .exec<{ id: number }>(
      "INSERT INTO event_codes (code_hash, note, max_uses, expires_at, full, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
      input.codeHash,
      input.note,
      input.maxUses,
      input.now + input.days * DAY_MS,
      input.full ? 1 : 0,
      input.createdBy,
      input.now,
    )
    .toArray()[0]!.id;
}

/** The code with this hash when it can still be used, else why not ("invalid" for no such code). */
export function lookupEventCode(sql: Sql, codeHash: string, now: number): { ok: true; id: number; full: boolean } | { ok: false; reason: "invalid" | Exclude<EventCodeStatus, "open"> } {
  const row = sql.exec<StoredCode>("SELECT * FROM event_codes WHERE code_hash = ?", codeHash).toArray()[0];
  if (!row) return { ok: false, reason: "invalid" };
  const status = statusOf(row, now);
  return status === "open" ? { ok: true, id: row.id, full: row.full === 1 } : { ok: false, reason: status };
}

/**
 * Counts one use, atomically with the sign-up (the caller is inside the admission transaction):
 * false when the code can no longer be used (used up, expired or ended since it was checked).
 */
export function useEventCode(sql: Sql, input: { id: number; githubId: number; login: string; now: number }): boolean {
  const row = sql.exec<StoredCode>("SELECT * FROM event_codes WHERE id = ?", input.id).toArray()[0];
  if (!row || statusOf(row, input.now) !== "open") return false;
  sql.exec("UPDATE event_codes SET uses = uses + 1 WHERE id = ?", input.id);
  sql.exec("INSERT OR IGNORE INTO event_code_uses (code_id, github_id, login, at) VALUES (?, ?, ?, ?)", input.id, input.githubId, input.login, input.now);
  return true;
}

/** Ends a code now; false when there is no such code or it already ended. */
export function endEventCode(sql: Sql, id: number, now: number): boolean {
  const row = sql.exec<{ ended_at: number | null }>("SELECT ended_at FROM event_codes WHERE id = ?", id).toArray()[0];
  if (!row || row.ended_at !== null) return false;
  sql.exec("UPDATE event_codes SET ended_at = ? WHERE id = ?", now, id);
  return true;
}

/** Every code, newest first, with its uses (codes themselves are never stored). */
export function listEventCodes(sql: Sql, now: number): EventCodeRow[] {
  const uses = new Map<number, EventCodeRow["people"]>();
  for (const use of sql.exec<{ code_id: number; github_id: number; login: string; at: number }>("SELECT * FROM event_code_uses ORDER BY at").toArray()) {
    const list = uses.get(use.code_id) ?? [];
    list.push({ githubId: use.github_id, login: use.login, at: use.at });
    uses.set(use.code_id, list);
  }
  return sql
    .exec<StoredCode>("SELECT * FROM event_codes ORDER BY id DESC")
    .toArray()
    .map((row) => ({
      id: row.id,
      note: row.note,
      maxUses: row.max_uses,
      uses: row.uses,
      expiresAt: row.expires_at,
      full: row.full === 1,
      createdBy: row.created_by,
      createdAt: row.created_at,
      endedAt: row.ended_at,
      status: statusOf(row, now),
      people: uses.get(row.id) ?? [],
    }));
}

/** Whether this person signed up with an event code: the creation-batch check leaves them out for good. */
export function signedUpWithEventCode(sql: Sql, githubId: number): boolean {
  return sql.exec("SELECT 1 FROM event_code_uses WHERE github_id = ? LIMIT 1", githubId).toArray().length > 0;
}
