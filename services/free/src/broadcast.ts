import { sha256Hex } from "../../shared/src/auth.js";
import { DAY_MS } from "./week.js";
import { FOOTER } from "./user-emails.js";

/**
 * One-off emails from the owner to a filtered set of people (check-ins):
 * POST /admin/emails/broadcast {subject, text, audience, signedUpFrom?, signedUpTo?, dryRun, skipIfSent?, githubIds?}.
 * With githubIds, only those accounts are candidates; every other rule still applies to them.
 * The copy has no em or en dashes (refused). It is usually lowercase like user-emails.ts, but
 * capitals aren't refused: proper nouns ("GPT-6", "OpenAI") are fine, and the dashboard only
 * notes "has capitals". Its id is a hash of the subject and text, so the same message never goes
 * to the same person twice, however often the call is retried and whatever the filters.
 */

export type BroadcastAudience = "full" | "basic" | "starter" | "all";

export interface BroadcastRequest {
  subject: string;
  text: string;
  audience: BroadcastAudience;
  /** Signed up (people.admitted_at) at or after this, Unix ms; null for no bound. */
  from: number | null;
  /** Signed up before this, Unix ms; null for no bound. A plain date includes that whole day. */
  to: number | null;
  dryRun: boolean;
  /** An earlier broadcast's id: people it was sent to are skipped (resending a reworded email to the rest). */
  skipIfSent: string | null;
  /** Only these accounts (GitHub ids) are candidates, still filtered by every other rule; null for no list. */
  githubIds?: number[] | null;
}

export const MAX_BROADCAST_SUBJECT = 200;
export const MAX_BROADCAST_TEXT = 10_000;
/** At most this many sends per call; call again (same subject and text) for the rest. */
export const BROADCAST_BATCH = 100;
/** At most this many accounts in an explicit recipient list (githubIds). */
export const MAX_BROADCAST_GITHUB_IDS = 500;

const URL_OR_ADDRESS = /\bhttps?:\/\/[^\s<>"]+|[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+/g;

/** Why the copy is refused, or undefined when it's fine. */
export function broadcastCopyProblem(subject: string, text: string): string | undefined {
  for (const [name, value] of [["subject", subject], ["text", text]] as const) {
    if (/[—–]/.test(value)) return `The ${name} has an em or en dash; use a comma, a colon or a new sentence.`;
  }
  if (/[\r\n]/.test(subject)) return "The subject is one line.";
  return undefined;
}

/** Whether the subject or text has a capital letter outside URLs and addresses: a note, never a refusal. */
export function hasCapitals(subject: string, text: string): boolean {
  return [subject, text].some((value) => /[A-Z]/.test(value.replace(URL_OR_ADDRESS, "")));
}

/** Line breaks as typed, whatever the browser sent (a form posts CRLF): "\n" only, so the id is the same either way. */
export function normalizeLineBreaks(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** The subject and text of a one-off email, checked: trimmed subject, text with trailing space removed. */
export function parseCopy(subject: unknown, text: unknown): { ok: true; subject: string; text: string } | { ok: false; message: string } {
  if (typeof subject !== "string" || subject.trim() === "" || subject.length > MAX_BROADCAST_SUBJECT) return { ok: false, message: `Send a subject and a text. The subject is 1 to ${MAX_BROADCAST_SUBJECT} characters.` };
  if (typeof text !== "string" || text.trim() === "" || text.length > MAX_BROADCAST_TEXT) return { ok: false, message: `The text is 1 to ${MAX_BROADCAST_TEXT} characters.` };
  const problem = broadcastCopyProblem(subject, text);
  if (problem) return { ok: false, message: problem };
  return { ok: true, subject: subject.trim(), text: normalizeLineBreaks(text).replace(/\s+$/, "") };
}

/** "2026-11-01" (the start of that UTC day) or a full ISO time. */
function parseTime(value: unknown, endOfDay: boolean): number | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return "invalid";
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const at = Date.parse(dateOnly ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(at)) return "invalid";
  return dateOnly && endOfDay ? at + DAY_MS : at;
}

export function parseBroadcast(body: Record<string, unknown>): { ok: true; value: BroadcastRequest } | { ok: false; message: string } {
  const usage =
    'Send {subject, text, audience: "full" | "basic" | "starter" | "all", signedUpFrom?, signedUpTo?, dryRun: true | false, skipIfSent?, githubIds?}; the dates are "YYYY-MM-DD" or ISO times.';
  const { audience, dryRun } = body;
  const copy = parseCopy(body.subject, body.text);
  if (!copy.ok) return { ok: false, message: copy.message };
  if (audience !== "full" && audience !== "basic" && audience !== "starter" && audience !== "all") return { ok: false, message: usage };
  if (typeof dryRun !== "boolean") return { ok: false, message: `${usage} dryRun is required, so a send is never an accident.` };
  const from = parseTime(body.signedUpFrom, false);
  const to = parseTime(body.signedUpTo, true);
  if (from === "invalid" || to === "invalid") return { ok: false, message: usage };
  const skip = body.skipIfSent;
  if (skip !== undefined && skip !== null && (typeof skip !== "string" || !/^b[0-9a-f]{16}$/.test(skip))) return { ok: false, message: `${usage} skipIfSent is an earlier broadcast's id.` };
  const githubIds = parseGithubIds(body.githubIds);
  if (githubIds === "invalid") return { ok: false, message: `${usage} githubIds is a list of 1 to ${MAX_BROADCAST_GITHUB_IDS} GitHub account ids (positive whole numbers).` };
  return { ok: true, value: { subject: copy.subject, text: copy.text, audience, from, to, dryRun, skipIfSent: typeof skip === "string" ? skip : null, githubIds } };
}

/** An optional explicit recipient list: 1 to MAX_BROADCAST_GITHUB_IDS positive integer ids, duplicates dropped. */
function parseGithubIds(value: unknown): number[] | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BROADCAST_GITHUB_IDS) return "invalid";
  if (!value.every((id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0)) return "invalid";
  return [...new Set(value as number[])];
}

/** The audience narrowed to an explicit recipient list, when there is one; order kept. */
export function onlyListed<T extends { githubId: number }>(audience: T[], githubIds: number[] | null | undefined): T[] {
  if (!githubIds) return audience;
  const listed = new Set(githubIds);
  return audience.filter((person) => listed.has(person.githubId));
}

/** The id recorded per person (user_emails kind "broadcast", period = id). */
export async function broadcastId(subject: string, text: string): Promise<string> {
  return `b${(await sha256Hex(`broadcast:${subject}\n${text}`)).slice(0, 16)}`;
}

/** The text with the same stop footer every user email has. */
export function broadcastBody(text: string, unsubscribeUrl: string): string {
  return `${text}\n\n${FOOTER.replace("{unsubscribeUrl}", unsubscribeUrl)}\n`;
}
