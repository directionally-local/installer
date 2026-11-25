import { escapeHtml } from "../../shared/src/html.js";
import type { Sql } from "./dashboard-data.js";
import { plausibleEmail } from "./email-guard.js";
import { DAY_MS, isoDay } from "./week.js";

/**
 * Provider inquiries: inference companies that want dl to route traffic to them fill a form on
 * dl.new/providers, which posts here. No sign-in.
 *
 *   POST /web/provider-inquiry {company, name, email, website?, models?, regions?, credits?, notes?}
 *     → 200 {ok: true}; 400 invalid_request (which field), 429 rate_limited, 405 other methods
 *   GET  /v1/admin/provider-inquiries → {inquiries, total} (admins)
 *
 * What people write is user content: stored as plain text (no IP), shown escaped on the admin
 * Tools tab, sent to the owner in a plain-text email with control characters removed, never
 * logged. Limits: PROVIDER_INQUIRY_IP per network, and PROVIDER_INQUIRIES_PER_DAY in all a UTC
 * day; the owner is emailed about the first PROVIDER_INQUIRY_EMAILS_PER_DAY of them, the rest are
 * only kept (the Tools tab lists them).
 */

export const PROVIDER_INQUIRY_PATH = "/web/provider-inquiry";
/** Inquiries kept a UTC day, from everyone. */
export const PROVIDER_INQUIRIES_PER_DAY = 200;
/** Owner emails about inquiries a UTC day; the rest are kept without one. */
export const PROVIDER_INQUIRY_EMAILS_PER_DAY = 50;
/** The largest body read, in bytes: every field at its longest in any script fits. */
export const PROVIDER_INQUIRY_MAX_BYTES = 32 * 1024;
/** The most inquiries the admin read returns. */
export const PROVIDER_INQUIRIES_LISTED = 500;
/** The most the Tools card shows. */
const CARD_SHOWN = 50;

/** Every field, its longest (in characters, after trimming), and whether it's required. Order: the email's. */
export const PROVIDER_INQUIRY_FIELDS = {
  company: { max: 120, required: true, label: "Company" },
  name: { max: 120, required: true, label: "Name" },
  email: { max: 200, required: true, label: "Email" },
  website: { max: 300, required: false, label: "Website" },
  models: { max: 500, required: false, label: "Models" },
  regions: { max: 300, required: false, label: "Regions" },
  credits: { max: 200, required: false, label: "Credits" },
  notes: { max: 2000, required: false, label: "Notes" },
} as const;
export type ProviderInquiryField = keyof typeof PROVIDER_INQUIRY_FIELDS;
const FIELD_NAMES = Object.keys(PROVIDER_INQUIRY_FIELDS) as ProviderInquiryField[];
/** The one field that may hold several lines. */
const MULTILINE: ProviderInquiryField = "notes";

export interface ProviderInquiryInput {
  company: string;
  name: string;
  email: string;
  website: string | null;
  models: string | null;
  regions: string | null;
  credits: string | null;
  notes: string | null;
}

export interface ProviderInquiry extends ProviderInquiryInput {
  id: number;
  at: number;
}

/**
 * A field's text, made safe to show and to mail: control characters go (a single-line field's
 * line breaks and tabs become spaces; notes keep their line breaks, tabs become spaces), then it's trimmed.
 */
function clean(value: string, multiline: boolean): string {
  const text = multiline
    ? value.replace(/\r\n?/g, "\n").replace(/\t/g, " ").replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/g, "")
    : value.replace(/[\t\n\r\u000b\u000c\u2028\u2029]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "");
  return text.trim();
}

/** Checks a POST /web/provider-inquiry body. */
export function parseProviderInquiry(body: unknown): { ok: true; value: ProviderInquiryInput } | { ok: false; message: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, message: "Send a JSON object: {company, name, email, website?, models?, regions?, credits?, notes?}." };
  const raw = body as Record<string, unknown>;
  const unknown = Object.keys(raw).find((key) => !(FIELD_NAMES as string[]).includes(key));
  if (unknown !== undefined) return { ok: false, message: `Unknown field: ${unknown.slice(0, 40)}.` };
  const out: Record<string, string | null> = {};
  for (const field of FIELD_NAMES) {
    const spec = PROVIDER_INQUIRY_FIELDS[field];
    const value = raw[field];
    if (value === undefined || value === null) {
      if (spec.required) return { ok: false, message: `${field} is required.` };
      out[field] = null;
      continue;
    }
    if (typeof value !== "string") return { ok: false, message: `${field} must be a string.` };
    const text = clean(value, field === MULTILINE);
    if (text === "") {
      if (spec.required) return { ok: false, message: `${field} is required.` };
      out[field] = null;
      continue;
    }
    if ([...text].length > spec.max) return { ok: false, message: `${field} can be at most ${spec.max} characters.` };
    out[field] = text;
  }
  if (!plausibleEmail(out.email!)) return { ok: false, message: "email must be a valid email address." };
  return { ok: true, value: out as unknown as ProviderInquiryInput };
}

// ─── Storage (the Directory's SQL) ────────────────────────────────────────────

export const PROVIDER_INQUIRY_SCHEMA = [
  // What a company sent from dl.new/providers. User content; never an IP.
  `CREATE TABLE IF NOT EXISTS provider_inquiries (
     id      INTEGER PRIMARY KEY,
     at      INTEGER NOT NULL,
     company TEXT NOT NULL,
     name    TEXT NOT NULL,
     email   TEXT NOT NULL,
     website TEXT,
     models  TEXT,
     regions TEXT,
     credits TEXT,
     notes   TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS provider_inquiries_at ON provider_inquiries (at)`,
];

/**
 * Keeps an inquiry unless PROVIDER_INQUIRIES_PER_DAY (`perDay`) were already kept this UTC day.
 * `email`: whether the owner should be emailed about it (the first `emailsPerDay` of the day).
 */
export function saveProviderInquiry(
  sql: Sql,
  input: { now: number; inquiry: ProviderInquiryInput; perDay?: number; emailsPerDay?: number },
): { ok: true; id: number; today: number; email: boolean } | { ok: false } {
  const day = Math.floor(input.now / DAY_MS);
  const before = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM provider_inquiries WHERE at >= ? AND at < ?", day * DAY_MS, (day + 1) * DAY_MS).toArray()[0]?.n ?? 0;
  if (before >= (input.perDay ?? PROVIDER_INQUIRIES_PER_DAY)) return { ok: false };
  const q = input.inquiry;
  const row = sql
    .exec<{ id: number }>(
      "INSERT INTO provider_inquiries (at, company, name, email, website, models, regions, credits, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
      input.now,
      q.company,
      q.name,
      q.email,
      q.website,
      q.models,
      q.regions,
      q.credits,
      q.notes,
    )
    .toArray()[0];
  const today = before + 1;
  return { ok: true, id: row?.id ?? 0, today, email: today <= (input.emailsPerDay ?? PROVIDER_INQUIRY_EMAILS_PER_DAY) };
}

/** The newest inquiries first (at most `limit`), and how many are kept in all. */
export function listProviderInquiries(sql: Sql, limit = PROVIDER_INQUIRIES_LISTED): { inquiries: ProviderInquiry[]; total: number } {
  const inquiries = sql.exec<ProviderInquiry>("SELECT id, at, company, name, email, website, models, regions, credits, notes FROM provider_inquiries ORDER BY at DESC, id DESC LIMIT ?", limit).toArray();
  const total = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM provider_inquiries").toArray()[0]?.n ?? 0;
  return { inquiries: inquiries.map((row) => ({ ...row })), total };
}

// ─── The owner's email ────────────────────────────────────────────────────────

/** The owner's plain-text email: subject `Provider inquiry: <company>` (one line), every field. */
export function providerInquiryEmail(inquiry: ProviderInquiryInput, at: number, today: number): { subject: string; body: string } {
  const lines = FIELD_NAMES.map((field) => {
    const value = inquiry[field];
    const label = `${PROVIDER_INQUIRY_FIELDS[field].label}:`;
    if (value === null) return `${label} (not given)`;
    return field === MULTILINE && value.includes("\n") ? `${label}\n${value}` : `${label} ${value}`;
  });
  const when = new Date(at).toISOString().replace("T", " ").slice(0, 16);
  return {
    subject: `Provider inquiry: ${inquiry.company}`.replace(/[\r\n]+/g, " "),
    body: [
      "A new provider inquiry from dl.new/providers.",
      "",
      ...lines,
      "",
      `Time: ${when} UTC`,
      `Inquiries today: ${today}`,
      "",
      "List: GET /v1/admin/provider-inquiries, or the admin Tools tab.",
      `Sent for each inquiry, up to ${PROVIDER_INQUIRY_EMAILS_PER_DAY} a UTC day; past that they are kept and listed only. Everything above was typed by the sender.`,
      "",
    ].join("\n"),
  };
}

// ─── Admin ────────────────────────────────────────────────────────────────────

/** The admin JSON: ISO times. */
export function providerInquiriesJson(list: { inquiries: ProviderInquiry[]; total: number }): Record<string, unknown> {
  return { total: list.total, inquiries: list.inquiries.map((inquiry) => ({ ...inquiry, at: new Date(inquiry.at).toISOString() })) };
}

/** The Tools tab's card: the newest inquiries. User content: escaped. */
export function providerInquiriesCard(list: { inquiries: ProviderInquiry[]; total: number }): string {
  const cell = (value: string | null) => (value === null ? "–" : escapeHtml(value));
  const rows = list.inquiries
    .slice(0, CARD_SHOWN)
    .map(
      (q) =>
        `<tr><td>${escapeHtml(isoDay(q.at))}</td><td>${cell(q.company)}</td><td>${cell(q.name)}</td><td><code>${cell(q.email)}</code></td><td>${cell(q.website)}</td><td>${cell(q.models)}</td><td>${cell(q.regions)}</td><td>${cell(q.credits)}</td><td>${cell(q.notes)}</td></tr>`,
    )
    .join("");
  const table =
    list.inquiries.length === 0
      ? `<p class="hint">No inquiries yet.</p>`
      : `<div class="leads-wrap"><table class="leads"><thead><tr><th>Date</th><th>Company</th><th>Name</th><th>Email</th><th>Website</th><th>Models</th><th>Regions</th><th>Credits</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  return `<section class="card" id="provider-inquiries" aria-label="Provider inquiries">
<h2>Provider inquiries</h2>
<p class="lede">Companies that asked, on dl.new/providers, for dl to route traffic to them.</p>
${table}
<p class="hint">${list.total} in all${list.total > CARD_SHOWN ? `; the newest ${CARD_SHOWN} shown` : ""} · <code>GET /v1/admin/provider-inquiries</code></p>
</section>`;
}
