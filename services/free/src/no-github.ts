import { escapeHtml } from "../../shared/src/html.js";
import { utcAndSingapore, type Alert } from "./alerts.js";
import type { AccessRequestAlerts } from "./config.js";
import type { Sql } from "./dashboard-data.js";
import { plausibleEmail } from "./email-guard.js";
import { DAY_MS, isoDay } from "./week.js";

/**
 * "Don't have GitHub?": a small link under every "Sign in with GitHub" button (the device sign-in
 * page here, dl.new's sign-up form) to a page that counts the click and lets the person leave an
 * email, and what they use instead, to hear when other sign-in options open.
 *
 *   GET  /no-github?from=device|web|dlnew  → counts the click (per UTC day and source), emails the owner, shows the form
 *   POST /no-github {from, email?, uses?}  → stores the lead, emails the owner, says thanks
 *   GET  /v1/admin/no-github?days=         → clicks per day and source, and the leads (admins)
 *
 * Both are rate limited per network (the caller's IPv4 address or IPv6 /64). No IP is stored: a
 * lead keeps a keyed hash of the network, only to drop the same anonymous answer sent twice.
 *
 * The owner's email (alerts.ts, the same sender and address as every "dl free tier:" alert) is
 * set by the runtime setting noGithubAlerts: "each" (one per click and per lead, the default),
 * "daily" (a line in the daily digest instead) or "off". At most NO_GITHUB_EMAILS_PER_DAY are
 * sent a UTC day; past that, what wasn't emailed is counted in the next daily digest.
 */

export const NO_GITHUB_PATH = "/no-github";
export const NO_GITHUB_SOURCES = ["device", "web", "dlnew", "other"] as const;
export type NoGithubSource = (typeof NO_GITHUB_SOURCES)[number];
export type NoGithubAlerts = AccessRequestAlerts;
/** Owner emails about clicks and leads a UTC day; the rest go to the daily digest. */
export const NO_GITHUB_EMAILS_PER_DAY = 50;
/** The longest "what do you use instead?" answer kept. */
export const NO_GITHUB_USES_MAX = 100;
/** The most leads GET /v1/admin/no-github and the Tools card list. */
export const NO_GITHUB_LEADS_MAX = 1000;

const SOURCE_NAMES: Record<NoGithubSource, string> = { device: "the dl sign-in page", web: "the web sign-up", dlnew: "dl.new", other: "an unknown page" };

export function noGithubSource(value: string | null | undefined): NoGithubSource {
  return (NO_GITHUB_SOURCES as readonly string[]).includes(value ?? "") ? (value as NoGithubSource) : "other";
}

// ─── Storage (the Directory's SQL) ────────────────────────────────────────────

export const NO_GITHUB_SCHEMA = [
  // Clicks on "Don't have GitHub?": per UTC day and source. Counts only.
  `CREATE TABLE IF NOT EXISTS no_github_clicks (
     day    INTEGER NOT NULL,
     source TEXT NOT NULL,
     count  INTEGER NOT NULL,
     PRIMARY KEY (day, source)
   ) WITHOUT ROWID`,
  // What people chose to leave on that page: an email (optional) and what they use instead of
  // GitHub (optional, one line). Never an IP: `ip_hash` is a keyed hash of the network, only to
  // drop the same anonymous answer twice. One row per inbox; a repeat refreshes it.
  `CREATE TABLE IF NOT EXISTS no_github_leads (
     id      INTEGER PRIMARY KEY,
     at      INTEGER NOT NULL,
     source  TEXT NOT NULL,
     email   TEXT,
     uses    TEXT,
     ip_hash TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS no_github_leads_at ON no_github_leads (at)`,
  // Owner emails about the above per UTC day: sent, and held for the daily digest (the
  // "daily" setting, or past NO_GITHUB_EMAILS_PER_DAY).
  `CREATE TABLE IF NOT EXISTS no_github_alerts (
     day  INTEGER PRIMARY KEY,
     sent INTEGER NOT NULL DEFAULT 0,
     held INTEGER NOT NULL DEFAULT 0
   )`,
];

function first<T>(sql: Sql, query: string, ...bindings: unknown[]): T | undefined {
  return sql.exec<T>(query, ...bindings).toArray()[0];
}

/** Whether to email the owner now, taking one from today's allowance; otherwise holds it for the digest. */
function claimAlert(sql: Sql, day: number, mode: NoGithubAlerts, perDay: number): boolean {
  if (mode === "off") return false;
  const sent = first<{ sent: number }>(sql, "SELECT sent FROM no_github_alerts WHERE day = ?", day)?.sent ?? 0;
  const email = mode === "each" && sent < perDay;
  sql.exec(
    `INSERT INTO no_github_alerts (day, sent, held) VALUES (?, ?, ?)
     ON CONFLICT (day) DO UPDATE SET sent = sent + excluded.sent, held = held + excluded.held`,
    day,
    email ? 1 : 0,
    email ? 0 : 1,
  );
  return email;
}

export interface NoGithubCounts {
  /** Clicks today from this source, and from every source. */
  sourceToday: number;
  today: number;
  /** Clicks ever, and leads kept. */
  total: number;
  leads: number;
}

function counts(sql: Sql, day: number, source: NoGithubSource): NoGithubCounts {
  const row = first<{ source_today: number; today: number; total: number; leads: number }>(
    sql,
    `SELECT (SELECT COALESCE(SUM(count), 0) FROM no_github_clicks WHERE day = ? AND source = ?) AS source_today,
            (SELECT COALESCE(SUM(count), 0) FROM no_github_clicks WHERE day = ?) AS today,
            (SELECT COALESCE(SUM(count), 0) FROM no_github_clicks) AS total,
            (SELECT COUNT(*) FROM no_github_leads) AS leads`,
    day,
    source,
    day,
  );
  return { sourceToday: row?.source_today ?? 0, today: row?.today ?? 0, total: row?.total ?? 0, leads: row?.leads ?? 0 };
}

/** Counts a click; `email` says whether the owner should get an email about it now. */
export function recordNoGithubClick(sql: Sql, input: { now: number; source: NoGithubSource; mode: NoGithubAlerts; perDay?: number }): NoGithubCounts & { email: boolean } {
  const day = Math.floor(input.now / DAY_MS);
  sql.exec("INSERT INTO no_github_clicks (day, source, count) VALUES (?, ?, 1) ON CONFLICT (day, source) DO UPDATE SET count = count + 1", day, input.source);
  const email = claimAlert(sql, day, input.mode, input.perDay ?? NO_GITHUB_EMAILS_PER_DAY);
  return { ...counts(sql, day, input.source), email };
}

/**
 * Keeps a lead. With an email, one row per address (case-insensitive): a repeat refreshes it.
 * Without one, the same answer from the same network the same UTC day is dropped (`stored`
 * false, no email to the owner).
 */
export function saveNoGithubLead(
  sql: Sql,
  input: { now: number; source: NoGithubSource; email: string | null; uses: string | null; ipHash: string; mode: NoGithubAlerts; perDay?: number },
): NoGithubCounts & { stored: boolean; repeat: boolean; email: boolean } {
  const day = Math.floor(input.now / DAY_MS);
  let repeat = false;
  if (input.email !== null) {
    const existing = first<{ id: number }>(sql, "SELECT id FROM no_github_leads WHERE lower(email) = lower(?) ORDER BY id LIMIT 1", input.email);
    if (existing) {
      repeat = true;
      sql.exec("UPDATE no_github_leads SET at = ?, source = ?, email = ?, uses = COALESCE(?, uses), ip_hash = ? WHERE id = ?", input.now, input.source, input.email, input.uses, input.ipHash, existing.id);
    }
  } else {
    const same = first<{ id: number }>(
      sql,
      "SELECT id FROM no_github_leads WHERE email IS NULL AND ip_hash = ? AND uses IS ? AND at >= ? AND at < ? LIMIT 1",
      input.ipHash,
      input.uses,
      day * DAY_MS,
      (day + 1) * DAY_MS,
    );
    if (same) return { ...counts(sql, day, input.source), stored: false, repeat: true, email: false };
  }
  if (!repeat) sql.exec("INSERT INTO no_github_leads (at, source, email, uses, ip_hash) VALUES (?, ?, ?, ?, ?)", input.now, input.source, input.email, input.uses, input.ipHash);
  const email = claimAlert(sql, day, input.mode, input.perDay ?? NO_GITHUB_EMAILS_PER_DAY);
  return { ...counts(sql, day, input.source), stored: true, repeat, email };
}

export interface NoGithubLead {
  at: number;
  source: string;
  email: string | null;
  uses: string | null;
}

export interface NoGithubDay {
  /** YYYY-MM-DD (UTC). */
  date: string;
  /** Clicks per source. */
  clicks: Record<NoGithubSource, number>;
  total: number;
  /** Leads first left that day (a repeat counts on its latest day). */
  leads: number;
}

export interface NoGithubReport {
  days: NoGithubDay[];
  totals: { clicks: number; leads: number; emails: number };
  /** Newest first, at most NO_GITHUB_LEADS_MAX. User content: escape it. */
  leads: NoGithubLead[];
}

/** Clicks and leads per UTC day in [from, until), oldest first, days with nothing left out. */
export function noGithubDays(sql: Sql, from: number, until: number): NoGithubDay[] {
  const fromDay = Math.floor(from / DAY_MS);
  const untilDay = Math.ceil(until / DAY_MS);
  const days = new Map<number, NoGithubDay>();
  const dayOf = (day: number) => {
    let row = days.get(day);
    if (!row) {
      row = { date: isoDay(day * DAY_MS), clicks: { device: 0, web: 0, dlnew: 0, other: 0 }, total: 0, leads: 0 };
      days.set(day, row);
    }
    return row;
  };
  for (const row of sql.exec<{ day: number; source: string; count: number }>("SELECT day, source, count FROM no_github_clicks WHERE day >= ? AND day < ?", fromDay, untilDay).toArray()) {
    const target = dayOf(row.day);
    target.clicks[noGithubSource(row.source)] += row.count;
    target.total += row.count;
  }
  for (const row of sql.exec<{ day: number; n: number }>(`SELECT at / ${DAY_MS} AS day, COUNT(*) AS n FROM no_github_leads WHERE at >= ? AND at < ? GROUP BY day`, fromDay * DAY_MS, untilDay * DAY_MS).toArray()) {
    dayOf(Math.floor(row.day)).leads += row.n;
  }
  return [...days.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
}

export function noGithubReport(sql: Sql, input: { from: number; until: number }): NoGithubReport {
  const totals = first<{ clicks: number; leads: number; emails: number }>(
    sql,
    `SELECT (SELECT COALESCE(SUM(count), 0) FROM no_github_clicks) AS clicks,
            (SELECT COUNT(*) FROM no_github_leads) AS leads,
            (SELECT COUNT(*) FROM no_github_leads WHERE email IS NOT NULL) AS emails`,
  );
  const leads = sql
    .exec<NoGithubLead>("SELECT at, source, email, uses FROM no_github_leads ORDER BY at DESC, id DESC LIMIT ?", NO_GITHUB_LEADS_MAX)
    .toArray()
    .map((row) => ({ at: row.at, source: row.source, email: row.email, uses: row.uses }));
  return { days: noGithubDays(sql, input.from, input.until), totals: { clicks: totals?.clicks ?? 0, leads: totals?.leads ?? 0, emails: totals?.emails ?? 0 }, leads };
}

/**
 * The daily digest's line for the UTC day starting at `from`, when something that day wasn't
 * emailed (noGithubAlerts "daily", or past the day's email cap); undefined otherwise.
 */
export function noGithubDigestLine(sql: Sql, from: number): string | undefined {
  const day = Math.floor(from / DAY_MS);
  const held = first<{ held: number }>(sql, "SELECT held FROM no_github_alerts WHERE day = ?", day)?.held ?? 0;
  if (held === 0) return undefined;
  const [today] = noGithubDays(sql, day * DAY_MS, (day + 1) * DAY_MS);
  const clicks = today?.total ?? 0;
  const by = today ? NO_GITHUB_SOURCES.filter((source) => today.clicks[source] > 0).map((source) => `${source} ${today.clicks[source]}`) : [];
  return `Don't have GitHub?: ${clicks} ${clicks === 1 ? "click" : "clicks"}${by.length ? ` (${by.join(", ")})` : ""}, ${today?.leads ?? 0} left an email or answer. GET /v1/admin/no-github`;
}

/** The digest with the "Don't have GitHub?" line added, when there is one. */
export function withNoGithubLine(alert: Alert, line: string | undefined): Alert {
  return line ? { ...alert, text: `${alert.text}\n${line}` } : alert;
}

// ─── The form ─────────────────────────────────────────────────────────────────

/** A POSTed form: an optional email (a plausible address) and an optional one-line answer. At least one. */
export function parseNoGithubLead(form: URLSearchParams): { ok: true; email: string | null; uses: string | null } | { ok: false; message: string } {
  const rawEmail = (form.get("email") ?? "").trim();
  const rawUses = (form.get("uses") ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (rawEmail !== "" && !plausibleEmail(rawEmail)) return { ok: false, message: "That email address doesn't look right." };
  if (rawUses.length > NO_GITHUB_USES_MAX) return { ok: false, message: `Keep the answer to ${NO_GITHUB_USES_MAX} characters.` };
  if (rawEmail === "" && rawUses === "") return { ok: false, message: "Leave an email, or tell us what you use instead." };
  return { ok: true, email: rawEmail === "" ? null : rawEmail, uses: rawUses === "" ? null : rawUses };
}

const PLAIN_INPUT = "font:500 17px var(--body);text-transform:none;letter-spacing:0;text-align:left";

/** The page's body (pages.ts wraps it). */
export function noGithubBody(source: NoGithubSource, problem?: string, form?: URLSearchParams): string {
  const error = problem ? `<p role="alert"><strong>${escapeHtml(problem)}</strong></p>\n` : "";
  return `<h1>No GitHub account?</h1>
${error}<p class="lede">dl's free tier uses GitHub to keep bots out. Leave your email and we'll tell you when other sign-in options open.</p>
<form method="post" action="${NO_GITHUB_PATH}" style="display:grid;gap:14px">
  <input type="hidden" name="from" value="${escapeHtml(source)}">
  <label class="field"><span>Email (optional)</span>
    <input type="email" name="email" autocomplete="email" maxlength="254" value="${escapeHtml(form?.get("email") ?? "")}">
  </label>
  <label class="field"><span>What do you use instead? (GitLab, Bitbucket, none…)</span>
    <input type="text" name="uses" maxlength="${NO_GITHUB_USES_MAX}" autocomplete="off" style="${PLAIN_INPUT}" value="${escapeHtml(form?.get("uses") ?? "")}">
  </label>
  <button class="btn" type="submit">Keep me posted</button>
</form>
<p class="fine">We only use the email to tell you about other sign-in options. dl itself works without GitHub: bring your own API key or a local model.</p>`;
}

// ─── Owner emails ─────────────────────────────────────────────────────────────

const FOOTER = `Sent for every click and every answer, up to ${NO_GITHUB_EMAILS_PER_DAY} a UTC day; past that they're counted in the daily digest. Set noGithubAlerts to "daily" for one line in the digest instead, or "off".`;

function countLines(source: NoGithubSource, at: number, c: NoGithubCounts): string[] {
  return [
    `Source: ${SOURCE_NAMES[source]} (from=${source})`,
    `Time: ${utcAndSingapore(at)}`,
    `Clicks today: ${c.sourceToday} from ${SOURCE_NAMES[source]}, ${c.today} in all`,
    `Clicks so far: ${c.total}. Answers kept: ${c.leads}.`,
  ];
}

export function noGithubClickAlert(source: NoGithubSource, at: number, c: NoGithubCounts): Alert {
  return {
    subject: `dl free tier: someone clicked Don't have GitHub? (from ${SOURCE_NAMES[source]})`,
    text: [`dl free tier: someone clicked "Don't have GitHub?" on ${SOURCE_NAMES[source]}.`, "", ...countLines(source, at, c), "", "List: GET /v1/admin/no-github"].join("\n"),
    footer: FOOTER,
  };
}

export function noGithubLeadAlert(source: NoGithubSource, at: number, lead: { email: string | null; uses: string | null }, repeat: boolean, c: NoGithubCounts): Alert {
  const what = lead.email ? "left an email" : "answered";
  return {
    subject: `dl free tier: someone ${what} after Don't have GitHub? (from ${SOURCE_NAMES[source]})`,
    text: [
      `dl free tier: someone ${what} on the "Don't have GitHub?" page${repeat ? " (again: the same address as before)" : ""}.`,
      "",
      `Email: ${lead.email ?? "(none)"}`,
      `Uses instead: ${lead.uses ?? "(not said)"}`,
      ...countLines(source, at, c),
      "",
      "List: GET /v1/admin/no-github",
    ].join("\n"),
    footer: FOOTER,
  };
}

// ─── Admin ────────────────────────────────────────────────────────────────────

/** The admin JSON: ISO times. */
export function noGithubJson(report: NoGithubReport): Record<string, unknown> {
  return { ...report, leads: report.leads.map((lead) => ({ ...lead, at: new Date(lead.at).toISOString() })) };
}

/** The Tools tab's card: clicks per day and source (the last days with any), the newest answers, two CSVs. */
export function noGithubCard(report: NoGithubReport, shown = 50): string {
  const days = [...report.days].reverse().slice(0, 14);
  const dayRows = days
    .map((day) => `<tr><td>${escapeHtml(day.date)}</td>${NO_GITHUB_SOURCES.map((source) => `<td class="num">${day.clicks[source]}</td>`).join("")}<td class="num">${day.total}</td><td class="num">${day.leads}</td></tr>`)
    .join("");
  const leadRows = report.leads
    .slice(0, shown)
    .map((lead) => `<tr><td>${lead.email ? `<code>${escapeHtml(lead.email)}</code>` : "–"}</td><td>${escapeHtml(lead.uses ?? "–")}</td><td>${escapeHtml(lead.source)}</td><td>${escapeHtml(isoDay(lead.at))}</td></tr>`)
    .join("");
  const clicks =
    days.length === 0
      ? `<p class="hint">No clicks yet.</p>`
      : `<div class="leads-wrap"><table class="leads"><thead><tr><th>Day</th>${NO_GITHUB_SOURCES.map((source) => `<th>${source}</th>`).join("")}<th>Clicks</th><th>Answers</th></tr></thead><tbody>${dayRows}</tbody></table></div>`;
  const leads =
    report.leads.length === 0
      ? `<p class="hint">No answers yet.</p>`
      : `<div class="leads-wrap"><table class="leads"><thead><tr><th>Email</th><th>Uses instead</th><th>From</th><th>Date</th></tr></thead><tbody>${leadRows}</tbody></table></div>`;
  return `<section class="card" id="no-github" aria-label="Don't have GitHub?">
<h2>Don't have GitHub?</h2>
<p class="lede">Clicks on the link under "Sign in with GitHub", and what people chose to leave: an email to hear about other sign-in options, and what they use instead.</p>
${clicks}
${leads}
<p class="hint">${report.totals.clicks} clicks, ${report.totals.leads} answers (${report.totals.emails} with an email) · <a href="/admin/dashboard/no-github.csv" download>Answers CSV</a> · <a href="/admin/dashboard/no-github-clicks.csv" download>Clicks CSV</a></p>
</section>`;
}

/** The two CSV tables' header and rows. */
export function noGithubCsvRows(table: "no-github" | "no-github-clicks", report: NoGithubReport): { header: string[]; rows: unknown[][] } {
  if (table === "no-github") return { header: ["date", "source", "email", "uses"], rows: report.leads.map((lead) => [isoDay(lead.at), lead.source, lead.email, lead.uses]) };
  return { header: ["date", ...NO_GITHUB_SOURCES, "total", "answers"], rows: report.days.map((day) => [day.date, ...NO_GITHUB_SOURCES.map((source) => day.clicks[source]), day.total, day.leads]) };
}
