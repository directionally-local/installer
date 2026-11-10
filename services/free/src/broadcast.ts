import { sha256Hex } from "../../shared/src/auth.js";
import { DAY_MS } from "./week.js";
import { FOOTER } from "./user-emails.js";

/**
 * One-off emails from the owner to a filtered set of people (check-ins):
 * POST /admin/emails/broadcast {subject, text, audience, signedUpFrom?, signedUpTo?, dryRun}.
 * The copy follows the same rules as user-emails.ts: lowercase (URLs and addresses aside) and no
 * em or en dashes. Its id is a hash of the subject and text, so the same message never goes to
 * the same person twice, however often the call is retried and whatever the filters.
 */

export type BroadcastAudience = "full" | "starter" | "all";

export interface BroadcastRequest {
  subject: string;
  text: string;
  audience: BroadcastAudience;
  /** Signed up (people.admitted_at) at or after this, Unix ms; null for no bound. */
  from: number | null;
  /** Signed up before this, Unix ms; null for no bound. A plain date includes that whole day. */
  to: number | null;
  dryRun: boolean;
}

export const MAX_BROADCAST_SUBJECT = 200;
export const MAX_BROADCAST_TEXT = 10_000;
/** At most this many sends per call; call again (same subject and text) for the rest. */
export const BROADCAST_BATCH = 100;

const URL_OR_ADDRESS = /\bhttps?:\/\/[^\s<>"]+|[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+/g;

/** Why the copy is refused, or undefined when it's fine. */
export function broadcastCopyProblem(subject: string, text: string): string | undefined {
  for (const [name, value] of [["subject", subject], ["text", text]] as const) {
    if (/[—–]/.test(value)) return `The ${name} has an em or en dash; use a comma, a colon or a new sentence.`;
    if (/[A-Z]/.test(value.replace(URL_OR_ADDRESS, ""))) return `The ${name} has an uppercase letter outside a URL or an email address; keep it lowercase.`;
  }
  if (/[\r\n]/.test(subject)) return "The subject is one line.";
  return undefined;
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
    'Send {subject, text, audience: "full" | "starter" | "all", signedUpFrom?, signedUpTo?, dryRun: true | false}; the dates are "YYYY-MM-DD" or ISO times.';
  const { subject, text, audience, dryRun } = body;
  if (typeof subject !== "string" || subject.trim() === "" || subject.length > MAX_BROADCAST_SUBJECT) return { ok: false, message: `${usage} The subject is 1 to ${MAX_BROADCAST_SUBJECT} characters.` };
  if (typeof text !== "string" || text.trim() === "" || text.length > MAX_BROADCAST_TEXT) return { ok: false, message: `${usage} The text is 1 to ${MAX_BROADCAST_TEXT} characters.` };
  if (audience !== "full" && audience !== "starter" && audience !== "all") return { ok: false, message: usage };
  if (typeof dryRun !== "boolean") return { ok: false, message: `${usage} dryRun is required, so a send is never an accident.` };
  const from = parseTime(body.signedUpFrom, false);
  const to = parseTime(body.signedUpTo, true);
  if (from === "invalid" || to === "invalid") return { ok: false, message: usage };
  const problem = broadcastCopyProblem(subject, text);
  if (problem) return { ok: false, message: problem };
  return { ok: true, value: { subject: subject.trim(), text: text.replace(/\s+$/, ""), audience, from, to, dryRun } };
}

/** The id recorded per person (user_emails kind "broadcast", period = id). */
export async function broadcastId(subject: string, text: string): Promise<string> {
  return `b${(await sha256Hex(`broadcast:${subject}\n${text}`)).slice(0, 16)}`;
}

/** The text with the same stop footer every user email has. */
export function broadcastBody(text: string, unsubscribeUrl: string): string {
  return `${text}\n\n${FOOTER.replace("{unsubscribeUrl}", unsubscribeUrl)}\n`;
}
