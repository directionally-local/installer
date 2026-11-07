import { escapeHtml } from "../../shared/src/html.js";
import { DOWNLOAD_ROUTES } from "./telemetry.js";
import { COHORT_WEEKS, FUNNEL_DAYS, REGULAR_DAYS, RETENTION_OFFSETS, TOKEN_LIMIT_SHARE, WEEKS_SHOWN, type DashboardData, type InstallFunnelRow } from "./dashboard-data.js";
import { ABUSE_DAYS, type AbuseData, type AbusePerson, type SimpleData } from "./abuse.js";
import { BRAND_ORIGIN, BRAND_TOKENS, PRODUCT_NAME } from "./pages.js";
import { isoDay } from "./week.js";

/**
 * The admin dashboard as server-rendered HTML, plus a CSV of each table. No scripts and no
 * inline `style` attributes: the one stylesheet carries a per-response nonce, so the page works
 * under `default-src 'none'`. It wears the dl.new brand (tokens, Bricolage/Geist/Geist Mono and
 * the logo, loaded from dl.new and nothing else), light and dark following the device. Charts
 * are small inline SVGs with presentation attributes and a `<title>` per bar for the value.
 * The only forms are sign-out, block/unblock and the "Serve from" upstream switch; the last
 * two post back here with a CSRF token.
 *
 * Two views: the full one (the default, every table) and a simple one at /admin?view=simple,
 * four cards readable at a glance (sign-ups, growth, tokens per person, red flags), mostly
 * inline SVG charts. Switching is a plain link: no scripts.
 */

/** Global spend, caps and admission, for the first section. */
export interface SpendView {
  weekUsd: number;
  totalUsd: number;
  adminWeekUsd: number;
  adminTotalUsd: number;
  weeklyCapUsd: number | null;
  totalCapUsd: number | null;
  resetsAt: number;
  paused: boolean;
  pausedByEnv: boolean;
  openAdmission: boolean;
  /** New accounts need a public repo or a contribution in the last year to skip the invite. */
  requireGithubActivity: boolean;
  maxActiveUsers: number;
  weeklyTokens: number;
  perPersonWeeklyUsd: number | null;
  /** Share of the weekly cap at which sign-ups queue. */
  queueThreshold: number;
  /** The provider setting, and whether each provider has a key. */
  primaryUpstream: "openai" | "luminal" | "openrouter";
  luminalConfigured: boolean;
  /** Who serves free requests now (chooseUpstream); "none" when no upstream key is set, so requests get 503 no_upstream. */
  serving: "openai" | "luminal" | "openrouter" | "none";
  /** Whether the service has an OPENROUTER_API_KEY, so the switch to OpenRouter can work. */
  openRouterConfigured: boolean;
  /** Whether the service has an OPENAI_API_KEY. */
  openaiConfigured: boolean;
  /** Luminal credit: the balance, used since the start, used this week (all, and free usage only). */
  creditUsd: number;
  creditUsedUsd: number;
  creditWeekUsd: number;
  freeCreditWeekUsd: number;
  /** The weekly credit budget the queue protects; null for none. */
  weeklyCreditUsd: number | null;
  /** A Starter account's weekly tokens. */
  starterWeeklyTokens: number;
}

/** The red banner shows at this share of either cap. */
export const BANNER_SHARE = 0.8;

export const CSV_TABLES = ["spend", "weekly-active", "retention", "weekly-cost", "top-cost", "limits", "queue", "referrals", "funnel", "install-funnel", "installs", "paid", "upstreams"] as const;
export type CsvTable = (typeof CSV_TABLES)[number];

export function isCsvTable(name: string): name is CsvTable {
  return (CSV_TABLES as readonly string[]).includes(name);
}

/** Security headers every dashboard response carries. `nonce` allows the one stylesheet. */
export function dashboardHeaders(nonce?: string): Record<string, string> {
  return {
    "content-security-policy": `default-src 'none'; style-src ${nonce ? `'nonce-${nonce}'` : "'none'"}; img-src ${nonce ? BRAND_ORIGIN : "'none'"}; font-src ${nonce ? BRAND_ORIGIN : "'none'"}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

/** The dl.new tokens, laid out dense: summary tiles first, then tables. */
const STYLE = `${BRAND_TOKENS}
:root { --soft: color-mix(in srgb, var(--ink) 22%, var(--surface)); --warn: var(--accent); }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; min-height: 100vh; color: var(--ink); font: 14px/1.45 var(--body); -webkit-font-smoothing: antialiased;
  background-color: var(--bg);
  background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px);
  background-size: 40px 40px; background-position: center top;
  padding: 0 max(16px, env(safe-area-inset-right, 0px)) 48px max(16px, env(safe-area-inset-left, 0px));
}
.page { max-width: 84rem; margin: 0 auto; }
a { color: inherit; text-underline-offset: 3px; }
a:hover { color: var(--accent); }
a:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
header.top { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; justify-content: space-between; padding: 16px 0 14px; border-bottom: 1px solid var(--line); }
.mark { display: inline-flex; align-items: center; gap: 10px; text-decoration: none; }
.mark img { width: 28px; height: 28px; border-radius: 7px; }
.mark span { font: 700 17px var(--display); letter-spacing: -.01em; }
.mark .tag { font: 500 11px var(--mono); letter-spacing: .06em; text-transform: uppercase; color: var(--muted); border: 1px solid var(--line); border-radius: 6px; padding: 2px 6px; background: var(--surface); }
.who { color: var(--muted); display: inline-flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; }
.who strong { color: var(--ink); font-weight: 600; }
h1 { font: 700 26px/1.1 var(--display); letter-spacing: -.02em; margin: 18px 0 4px; }
h2 { font: 700 18px/1.2 var(--display); letter-spacing: -.01em; margin: 0; }
h3 { font: 600 13px var(--body); margin: 16px 0 6px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
section { margin-top: 18px; background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; }
.lede { margin: 0 0 4px; color: var(--muted); }
.muted, figcaption, .note { color: var(--muted); }
.note { font-size: 12.5px; margin: 8px 0 0; }
.head { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; justify-content: space-between; margin: 0 0 10px; }
.head a { font: 500 12px var(--mono); }
.scroll { overflow-x: auto; margin-top: 10px; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { padding: 5px 8px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; vertical-align: top; }
td { font-family: var(--mono); font-size: 12.5px; }
th { font: 600 11.5px var(--body); color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
th:first-child, td:first-child { text-align: left; padding-left: 0; }
td.l, th.l { text-align: left; }
tbody tr:last-child td { border-bottom: 0; }
tr.sel td { font-weight: 700; }
tr.group td { border-top: 2px solid var(--line); }
button { font: 500 12.5px var(--body); padding: 4px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); cursor: pointer; }
button:hover { border-color: var(--ink); }
button.danger { border-color: var(--accent); color: var(--accent); }
button.danger:hover { background: var(--accent); color: var(--on-ink); }
form { display: inline; margin: 0; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: 10px; }
.tile { background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; display: grid; gap: 4px; align-content: start; color: var(--muted); font-size: 12.5px; }
.tile b { display: block; color: var(--ink); font: 600 22px/1.15 var(--mono); letter-spacing: -.01em; font-variant-numeric: tabular-nums; }
.tile b .muted { font-size: 13px; font-weight: 500; }
.tile .note { margin: 0; }
.tile.lead { border-color: var(--ink); }
.state { font-family: var(--display) !important; font-size: 17px !important; }
.status { font: 600 10.5px var(--mono); text-transform: uppercase; letter-spacing: .05em; padding: 1px 5px; border-radius: 5px; border: 1px solid var(--line); color: var(--muted); }
.status.blocked { border-color: var(--accent); color: var(--accent); }
svg { display: block; width: 100%; height: auto; max-height: 14rem; }
svg text { fill: var(--muted); font: 11px var(--mono); }
.bar { fill: var(--ink); }
.bar-soft { fill: var(--soft); }
.bar-warn { fill: var(--warn); }
.track { fill: var(--line); }
.axis { stroke: var(--line); stroke-width: 1; }
.key { display: inline-block; width: 0.8rem; height: 0.8rem; border-radius: 2px; vertical-align: -0.1rem; margin-right: 0.3rem; background: var(--ink); }
.key.soft { background: var(--soft); }
.serving { margin: 12px 0 0; padding: 10px 14px; border: 1px solid var(--ink); border-radius: 10px; background: var(--surface); display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; }
.serving strong { font: 700 17px var(--display); }
.switch { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 10px; }
button.on { background: var(--ink); color: var(--on-ink); border-color: var(--ink); cursor: default; }
.banner { background: var(--accent); color: #fff; border-radius: 10px; padding: 10px 14px; margin: 14px 0 0; font-weight: 600; }
.signin { max-width: 28rem; margin: 10vh auto 0; text-align: center; display: grid; gap: 14px; justify-items: center; }
.signin .btn { display: inline-flex; padding: 12px 20px; border-radius: 12px; background: var(--ink); color: var(--on-ink); text-decoration: none; font-weight: 600; }
[role="alert"] { margin: 0; }
.views { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
.views a { font: 500 12px var(--body); padding: 2px 9px; border-radius: 6px; text-decoration: none; color: var(--muted); }
.views a[aria-current="page"] { background: var(--ink); color: var(--on-ink); }
`;

export function nonce(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function shell(title: string, body: string, status = 200, headers: Record<string, string> = {}, head = "", style = STYLE): Response {
  const styleNonce = nonce();
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${head}<title>${escapeHtml(title)}</title>
<style nonce="${styleNonce}">${style}</style>
</head>
<body>
${style === STYLE ? `<div class="page">\n${body}\n</div>` : body}
</body>
</html>
`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", ...dashboardHeaders(styleNonce), ...headers } });
}

/** The dl mark (logo from dl.new) and an "admin" tag; `extra` goes on the right. */
function markHeader(extra = ""): string {
  return `<header class="top"><a class="mark" href="/admin"><img src="${BRAND_ORIGIN}/logo-64.webp" alt="" width="28" height="28"><span>${escapeHtml(PRODUCT_NAME)}</span><span class="tag">admin</span></a>${extra}</header>`;
}
const MARK_HEADER = markHeader();

/** Signed out: one link that starts GitHub sign-in. */
export function signInPage(message?: string, status = 200): Response {
  return shell(
    `Admin · ${PRODUCT_NAME}`,
    `${MARK_HEADER}
<main class="signin">
<h1>${escapeHtml(PRODUCT_NAME)}: admin</h1>
${message ? `<p role="alert"><strong>${escapeHtml(message)}</strong></p>` : ""}
<p class="lede">The usage dashboard is for admins. Sign in with the GitHub account listed as an admin.</p>
<p><a class="btn" href="/admin/signin">Sign in with GitHub</a></p>
</main>`,
    status,
  );
}

/**
 * After GitHub: the session cookie is set here, then the browser moves on to /admin by itself.
 * A same-site step is needed because the trip back from GitHub is a cross-site navigation, and
 * a SameSite=Strict cookie set during it isn't sent on the redirect that ends it.
 */
export function signedInPage(login: string, headers: Record<string, string>): Response {
  return shell(
    `Signed in · ${PRODUCT_NAME}`,
    `${MARK_HEADER}
<main class="signin">
<h1>${escapeHtml(PRODUCT_NAME)}: admin</h1>
<p>Signed in as <strong>${escapeHtml(login)}</strong>. <a href="/admin">Open the dashboard</a>.</p>
</main>`,
    200,
    headers,
    `<meta http-equiv="refresh" content="0;url=/admin">\n`,
  );
}

export function deniedPage(heading: string, message: string, status: number, headers: Record<string, string> = {}): Response {
  return shell(`${heading} · ${PRODUCT_NAME}`, `${MARK_HEADER}\n<main class="signin">\n<h1>${escapeHtml(heading)}</h1>\n<p>${escapeHtml(message)}</p>\n<p><a href="/admin">Back</a></p>\n</main>`, status, headers);
}

// ─── Formatting ───────────────────────────────────────────────────────────

const day = (ms: number) => isoDay(ms);
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const weekday = (ms: number) => `${WEEKDAYS[new Date(ms).getUTCDay()]} ${isoDay(ms)}`;

function usd(value: number | null): string {
  if (value === null) return "–";
  if (value === 0) return "$0";
  if (value >= 100) return `$${Math.round(value).toLocaleString("en-US")}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(3)}`;
}

function count(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function tokens(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(Math.round(value));
}

function percent(share: number): string {
  return `${(share * 100).toFixed(share > 0 && share < 0.1 ? 1 : 0)}%`;
}

/** "3 days", "5 hours". */
function waited(ms: number): string {
  const hours = Math.max(0, Math.floor(ms / 3_600_000));
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${Math.floor(hours / 24)} days`;
}

function ms(value: number | null): string {
  if (value === null) return "–";
  return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
}

function cap(value: number | null): string {
  return value === null ? "no cap" : usd(value);
}

function csvLink(table: CsvTable, query = ""): string {
  return `<a href="/admin/dashboard/${table}.csv${query}" download>CSV</a>`;
}

function who(login: string | null, githubId: number): string {
  return login ? escapeHtml(login) : `<span class="muted">#${githubId}</span>`;
}

// ─── Charts ───────────────────────────────────────────────────────────────

interface Bar {
  label: string;
  value: number;
  /** Drawn inside `value` from the baseline: a subset of it. */
  inner?: number;
  title: string;
}

/** A small column chart: one bar per week, optional inner bar for a subset, one y scale. */
function columns(bars: Bar[], format: (value: number) => string, label: string): string {
  const width = 640;
  const height = 180;
  const top = 14;
  const bottom = 22;
  const left = 4;
  const plot = height - top - bottom;
  const max = Math.max(1e-9, ...bars.map((bar) => bar.value));
  const slot = (width - left) / Math.max(1, bars.length);
  const barWidth = Math.min(48, slot * 0.6);
  const y = (value: number) => top + plot - (value / max) * plot;
  const parts = bars.map((bar, index) => {
    const x = left + index * slot + (slot - barWidth) / 2;
    const outer = Math.max(0, top + plot - y(bar.value));
    const inner = bar.inner === undefined ? 0 : Math.max(0, top + plot - y(bar.inner));
    return `<g><title>${escapeHtml(bar.title)}</title>
<rect class="${bar.inner === undefined ? "bar" : "bar-soft"}" x="${x.toFixed(1)}" y="${(top + plot - outer).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${outer.toFixed(1)}" rx="2"></rect>
${bar.inner !== undefined ? `<rect class="bar" x="${x.toFixed(1)}" y="${(top + plot - inner).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${inner.toFixed(1)}" rx="2"></rect>` : ""}
<text x="${(x + barWidth / 2).toFixed(1)}" y="${(top + plot - outer - 3).toFixed(1)}" text-anchor="middle">${escapeHtml(format(bar.value))}</text>
<text x="${(x + barWidth / 2).toFixed(1)}" y="${height - 6}" text-anchor="middle">${escapeHtml(bar.label)}</text></g>`;
  });
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(label)}">
<line class="axis" x1="0" x2="${width}" y1="${top + plot + 0.5}" y2="${top + plot + 0.5}"></line>
${parts.join("\n")}
</svg>`;
}

/** A horizontal meter: spent against a cap. */
function meter(value: number, max: number | null, label: string): string {
  const width = 300;
  const filled = max === null || max <= 0 ? 0 : Math.min(1, value / max) * width;
  return `<svg viewBox="0 0 ${width} 10" role="img" aria-label="${escapeHtml(label)}" preserveAspectRatio="none">
<rect class="track" x="0" y="0" width="${width}" height="10" rx="3"></rect>
<rect class="bar" x="0" y="0" width="${filled.toFixed(1)}" height="10" rx="3"></rect>
</svg>`;
}

/** Column headings for where a script was served. */
const ROUTE_LABELS: Record<(typeof DOWNLOAD_ROUTES)[number], string> = {
  home: "dl.new",
  invite: "Invite",
  private_invite: "Private invite",
  continue: "Continue",
  run: "directionallylocal.run",
};
/** install.sh's steps, as the failed-steps table names them. */
const STEP_LABELS: Record<string, string> = {
  "": "(not said)",
  preflight: "Checks (system, user, curl)",
  node: "Installing Node.js",
  install_dl: "Installing dl",
  path: "Putting dl on PATH",
  dl_up: "Server setup (dl up)",
};

const short = (ms: number) => isoDay(ms).slice(5);

// ─── Abuse ────────────────────────────────────────────────────────────────

/**
 * "Serve from: Luminal / OpenRouter": one button per upstream, the current one pressed. Only
 * with a CSRF token (a browser session); an upstream without a key can't be chosen.
 */
function upstreamSwitch(spend: SpendView, csrf: string | undefined): string {
  if (!csrf) return "";
  const secret = { openai: "OPENAI_API_KEY", luminal: "LUMINAL_API_KEY", openrouter: "OPENROUTER_API_KEY" } as const;
  const button = (upstream: "openai" | "luminal" | "openrouter", label: string, configured: boolean) => {
    if (spend.primaryUpstream === upstream) return `<button type="button" class="on" disabled aria-pressed="true">${label}</button>`;
    if (!configured) return `<button type="button" disabled title="No ${secret[upstream]}">${label}</button>`;
    return `<form method="post" action="/admin/dashboard/upstream"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="upstream" value="${upstream}"><button type="submit"${upstream === "openrouter" ? ` class="danger"` : ""}>${label}</button></form>`;
  };
  return `<div class="switch"><span>Serve from:</span>${button("openai", "OpenAI", spend.openaiConfigured)}${button("luminal", "Luminal", spend.luminalConfigured)}${button("openrouter", "OpenRouter", spend.openRouterConfigured)}</div>
<p class="note">Takes effect on the next request; nothing switches back on its own. OpenAI is the default; a model's own provider serves it, and GPT-6 Luna falls back to DeepSeek on Luminal when OpenAI fails or its credit runs out. OpenRouter spends OpenRouter credit (cash) until you switch back.${spend.openRouterConfigured ? "" : " OpenRouter can't be chosen: the service has no OPENROUTER_API_KEY."} Each switch is in the admin log.</p>`;
}

/** Block (or Unblock, when blocked) for one person; nothing without a CSRF token (bearer views). */
function actionForm(person: AbusePerson, csrf: string | undefined): string {
  if (!csrf || person.status === null) return "";
  const blocked = person.status === "blocked";
  return `<form method="post" action="/admin/dashboard/people/${person.githubId}/${blocked ? "unblock" : "block"}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit"${blocked ? "" : ` class="danger"`}>${blocked ? "Unblock" : "Block"}</button></form>`;
}

function statusChip(status: string | null): string {
  if (status === null || status === "active") return "";
  return ` <span class="status ${status === "blocked" ? "blocked" : ""}">${escapeHtml(status)}</span>`;
}

/** Login (or #id), with a chip when not active. */
function personCell(person: AbusePerson): string {
  return `${who(person.login, person.githubId)}${statusChip(person.status)}`;
}

function when(ms: number | null): string {
  return ms === null ? "–" : escapeHtml(new Date(ms).toISOString().slice(0, 16).replace("T", " "));
}

/** A config-log key as the admin log shows it. */
function logKey(key: string): string {
  const person = /^person_status:(\d+):(.*)$/.exec(key);
  return person ? `status of ${escapeHtml(person[2])} <span class="muted">#${person[1]}</span>` : escapeHtml(key);
}

function logValue(value: unknown): string {
  return escapeHtml(typeof value === "string" ? value : JSON.stringify(value));
}

function abuseSection(abuse: AbuseData, csrf: string | undefined): string {
  const today = abuse.githubChecks[0];
  const usageCells = (person: AbusePerson) => `<td>${count(person.weekRequests)}</td><td>${tokens(person.weekTokens)}</td><td>${usd(person.weekCreditUsd)}</td>`;
  const clusterRows = abuse.clusters.flatMap((cluster) =>
    cluster.members.map(
      (member, index) =>
        `<tr${index === 0 ? ` class="group"` : ""}><td class="l">${index === 0 ? `<code>${escapeHtml(cluster.net)}</code> <span class="muted">${cluster.members.length} accounts</span>` : ""}</td><td class="l">${personCell(member)}</td><td>${member.githubId}</td><td>${when(member.admittedAt)}</td><td>${when(member.seenAt)}</td>${usageCells(member)}<td class="l">${actionForm(member, csrf)}</td></tr>`,
    ),
  );
  const refusalRows = abuse.deviceRefusals.map(
    (row) =>
      `<tr><td>${when(row.at)}</td><td class="l">${personCell(row.person)}</td><td class="l"><code>${escapeHtml(row.device)}</code></td><td class="l">${personCell(row.holder)}</td><td>${count(row.attempts)}</td><td class="l">${actionForm(row.person, csrf)} ${actionForm(row.holder, csrf)}</td></tr>`,
  );
  const referralRows = abuse.sameNetworkReferrals.map(
    (row) => `<tr><td>${when(row.at)}</td><td class="l">${personCell(row.referrer)}</td><td class="l">${personCell(row.referred)}</td><td class="l">${actionForm(row.referrer, csrf)} ${actionForm(row.referred, csrf)}</td></tr>`,
  );
  const topRows = abuse.topUsers.map(
    (row) =>
      `<tr><td class="l">${personCell(row)}</td><td>${row.githubId}</td><td>${count(row.weekRequests)}</td><td>${tokens(row.weekTokens)}</td><td>${usd(row.weekCostUsd)}</td><td>${usd(row.weekCreditUsd)}</td><td>${row.activeDays}</td><td>${row.weekRequests > 0 && row.weekSessions === 0 ? `<strong>0</strong>` : count(row.weekSessions)}</td><td>${row.sharedWith > 0 ? `<strong>${row.sharedWith}</strong>` : "0"}</td><td class="l">${actionForm(row, csrf)}</td></tr>`,
  );
  const blockedRows = abuse.blocked.map((row) => `<tr><td class="l">${personCell(row)}</td><td>${row.githubId}</td><td>${when(row.admittedAt)}</td><td class="l">${actionForm(row, csrf)}</td></tr>`);
  const checkRows = abuse.githubChecks.map((row) => `<tr><td>${escapeHtml(weekday(row.day))}</td><td>${count(row.contributions)}</td><td>${count(row.none)}</td><td>${count(row.error)}</td></tr>`);
  const empty = (columns: number, text: string) => `<tr><td colspan="${columns}" class="l muted">${escapeHtml(text)}</td></tr>`;
  return `<section id="abuse">
<div class="head"><h2>Abuse</h2><span class="muted">Admins left out. Device refusals and checks: last ${ABUSE_DAYS} days.</span></div>
<div class="tiles">
<div class="tile">Shared networks<b>${count(abuse.clusterCount)}</b><span class="note">${count(abuse.clusteredAccounts)} accounts sign in from a network another account also uses.</span></div>
<div class="tile">Second-account device sign-ins<b>${count(abuse.deviceRefusalCount)}</b><span class="note">Refused with device_taken: the device already holds another account's grant.</span></div>
<div class="tile">Same-network referrals<b>${count(abuse.sameNetworkReferralCount)}</b><span class="note">Referral sign-ups from the referrer's own network; they earn no bonus.</span></div>
<div class="tile">Blocked<b>${count(abuse.blocked.length)}</b><span class="note">No requests, no token refresh, no new sign-in.</span></div>
<div class="tile">GitHub check today<b>${today ? `${count(today.none)} <span class="muted">none</span>` : "0"}</b><span class="note">${today ? `${count(today.contributions)} passed on contributions, ${count(today.error)} let through on a GitHub error.` : "No contribution lookups today."}</span></div>
</div>
<h3>Accounts sharing a network</h3>
<div class="scroll"><table>
<thead><tr><th class="l">Network</th><th class="l">GitHub login</th><th>GitHub id</th><th>Signed up (UTC)</th><th>First on network</th><th>Requests</th><th>Tokens</th><th>Credit</th><th class="l"></th></tr></thead>
<tbody>
${clusterRows.length === 0 ? empty(9, "No network is shared by two accounts.") : clusterRows.join("\n")}
</tbody></table></div>
<h3>Devices that tried a second account</h3>
<div class="scroll"><table>
<thead><tr><th>When (UTC)</th><th class="l">Tried to sign in</th><th class="l">Device</th><th class="l">Holds the grant</th><th>Refusals, ${ABUSE_DAYS} days</th><th class="l"></th></tr></thead>
<tbody>
${refusalRows.length === 0 ? empty(6, "No device_taken refusals.") : refusalRows.join("\n")}
</tbody></table></div>
<h3>Referral pairs on the same network</h3>
<div class="scroll"><table>
<thead><tr><th>Signed up (UTC)</th><th class="l">Referrer</th><th class="l">Referred</th><th class="l"></th></tr></thead>
<tbody>
${referralRows.length === 0 ? empty(4, "No referral pair shares a network.") : referralRows.join("\n")}
</tbody></table></div>
<h3>Top users this week</h3>
<div class="scroll"><table>
<thead><tr><th class="l">GitHub login</th><th>GitHub id</th><th>Requests</th><th>Tokens</th><th>Cost</th><th>Credit</th><th>Days active</th><th>dl sessions this week</th><th>Shares a network with</th><th class="l"></th></tr></thead>
<tbody>
${topRows.length === 0 ? empty(10, "No requests this week.") : topRows.join("\n")}
</tbody></table></div>
<h3>Blocked accounts</h3>
<div class="scroll"><table>
<thead><tr><th class="l">GitHub login</th><th>GitHub id</th><th>Signed up (UTC)</th><th class="l"></th></tr></thead>
<tbody>
${blockedRows.length === 0 ? empty(4, "Nobody is blocked.") : blockedRows.join("\n")}
</tbody></table></div>
<h3>GitHub activity check, per day</h3>
<div class="scroll"><table>
<thead><tr><th>Day (UTC)</th><th>Passed on contributions</th><th>None (sent to invite)</th><th>Error (let through)</th></tr></thead>
<tbody>
${checkRows.length === 0 ? empty(4, "No contribution lookups.") : checkRows.join("\n")}
</tbody></table></div>
<p class="note">Networks are keyed hashes of the sign-in address (IPv4, or the IPv6 /64), shortened: shared office, campus and mobile networks show up too, so check usage and sign-up times before blocking. Tokens, cost and credit are this week's, since Monday 00:00 UTC. dl sessions: distinct sessions in the events Autopilot sent this week; requests with no sessions usually mean the free token is used from another tool. Block ends free-tier use at once: requests and token refresh get a 403 that names the contact address, and the account can't sign in again until it is unblocked. Each block and unblock is in the admin log.</p>
</section>`;
}

function adminLogSection(abuse: AbuseData): string {
  return `<section id="log">
<div class="head"><h2>Admin log</h2><span class="muted">Settings, pause and block changes, newest first</span></div>
<div class="scroll"><table>
<thead><tr><th>When (UTC)</th><th class="l">By</th><th class="l">Change</th><th class="l">From</th><th class="l">To</th></tr></thead>
<tbody>
${
  abuse.adminLog.length === 0
    ? `<tr><td colspan="5" class="l muted">No changes yet.</td></tr>`
    : abuse.adminLog.map((row) => `<tr><td>${when(row.at)}</td><td class="l">${escapeHtml(row.byLogin)}</td><td class="l">${logKey(row.key)}</td><td class="l">${logValue(row.oldValue)}</td><td class="l">${logValue(row.newValue)}</td></tr>`).join("\n")
}
</tbody></table></div>
</section>`;
}

// ─── The page ─────────────────────────────────────────────────────────────

/** When this week's free credit spend would reach the queue's start, at this week's pace so far. */
function queueStart(spend: SpendView, data: DashboardData): { startUsd: number | null; text: string } {
  const startUsd = spend.weeklyCreditUsd === null ? null : spend.queueThreshold * spend.weeklyCreditUsd;
  if (data.queue.waiting > 0) return { startUsd, text: `On: ${count(data.queue.waiting)} waiting. New open sign-ups join the line.` };
  if (startUsd === null) return { startUsd, text: "No weekly credit budget, so credit never starts the queue." };
  if (spend.freeCreditWeekUsd >= startUsd) return { startUsd, text: "On: new open sign-ups wait for free tokens." };
  const left = `${usd(startUsd - spend.freeCreditWeekUsd)} of free credit to go.`;
  const elapsed = data.now - data.currentWeek;
  if (spend.freeCreditWeekUsd <= 0 || elapsed < 3_600_000) return { startUsd, text: `${left} Too early in the week for a pace.` };
  const at = data.currentWeek + (elapsed * startUsd) / spend.freeCreditWeekUsd;
  return {
    startUsd,
    text: at < spend.resetsAt ? `${left} At this week's pace: ${weekday(at)} ${new Date(at).toISOString().slice(11, 16)} UTC.` : `${left} Not this week at this week's pace.`,
  };
}

/** "Serving", or why free requests aren't served. */
function freeTierState(spend: SpendView): string {
  // The launch budget is the Luminal credit. The OpenRouter cash caps still exist in config and
  // still stop free tokens if OpenRouter spend reaches them, so the state says so when they do,
  // but they aren't shown as a budget.
  const weeklyCapReached = spend.weeklyCapUsd !== null && spend.weekUsd >= spend.weeklyCapUsd;
  const luminalServing = spend.serving === "luminal";
  const creditOut = luminalServing && spend.creditUsedUsd >= spend.creditUsd;
  const totalCapReached = spend.totalCapUsd !== null && spend.totalUsd >= spend.totalCapUsd;
  return spend.paused
    ? `Paused for everyone${spend.pausedByEnv ? " (PAUSED in env)" : " (admin switch)"}`
    : spend.serving === "none"
      ? "Not serving: no upstream key (503 no_upstream)"
      : creditOut
      ? "Paused: Luminal credit used up (upstream_credit_exhausted)"
      : totalCapReached
      ? "Free tokens stopped: OpenRouter all-time cap reached"
      : weeklyCapReached
        ? `Free tokens stopped until ${weekday(spend.resetsAt)}: OpenRouter weekly cap reached`
        : "Serving";
}

/** The red banner's sentences: the Luminal credit, or this week's credit budget, past BANNER_SHARE. */
function creditWarnings(spend: SpendView): string[] {
  const creditShare = spend.creditUsd > 0 ? spend.creditUsedUsd / spend.creditUsd : spend.creditUsedUsd > 0 ? 1 : 0;
  const weekCreditShare = spend.weeklyCreditUsd !== null && spend.weeklyCreditUsd > 0 ? spend.freeCreditWeekUsd / spend.weeklyCreditUsd : 0;
  return [
    ...(creditShare >= BANNER_SHARE ? [`${percent(creditShare)} of the ${usd(spend.creditUsd)} Luminal credit used (${usd(spend.creditUsedUsd)}).`] : []),
    ...(weekCreditShare >= BANNER_SHARE ? [`${percent(weekCreditShare)} of this week's ${usd(spend.weeklyCreditUsd)} credit budget used (${usd(spend.freeCreditWeekUsd)}).`] : []),
  ];
}

/** Who serves now, as the dashboard names it. */
function servingName(spend: SpendView): string {
  return spend.serving === "openai"
    ? "OpenAI"
    : spend.serving === "luminal"
      ? "Luminal"
      : spend.serving === "openrouter"
        ? spend.primaryUpstream === "luminal" ? "OpenRouter (no LUMINAL_API_KEY)" : "OpenRouter"
        : "None (no OPENAI_API_KEY, LUMINAL_API_KEY or OPENROUTER_API_KEY)";
}

/** The Simple / Full switch: two links, the current one marked. */
function viewToggle(current: "simple" | "full"): string {
  const link = (view: "simple" | "full", label: string) => `<a href="/admin?view=${view}"${current === view ? ` aria-current="page"` : ""}>${label}</a>`;
  return `<nav class="views" aria-label="Dashboard view">${link("simple", "Simple")}${link("full", "Full")}</nav>`;
}

export function dashboardPage(input: { data: DashboardData; spend: SpendView; login: string; signOut: boolean; abuse?: AbuseData; csrf?: string }): Response {
  const { data, spend } = input;
  const currentWeek = data.currentWeek;
  const thisOrDate = (week: number) => (week === currentWeek ? `${day(week)} (this week)` : day(week));
  const state = freeTierState(spend);
  const warnings = creditWarnings(spend);
  const banner = warnings.length > 0 ? `<p class="banner" role="alert">${warnings.map(escapeHtml).join(" ")}</p>` : "";
  const queue = queueStart(spend, data);

  const budgetSection = `<section id="budget">
<div class="head"><h2>Budget: Luminal credit</h2>${csvLink("spend")}</div>
<div class="tiles">
<div class="tile lead">Luminal credit used<b>${usd(spend.creditUsedUsd)} <span class="muted">of ${usd(spend.creditUsd)}</span></b>${meter(spend.creditUsedUsd, spend.creditUsd, "Luminal credit used against the balance")}<span class="note">${usd(Math.max(0, spend.creditUsd - spend.creditUsedUsd))} left. Luminal-served usage pauses at the balance.</span></div>
<div class="tile lead">Credit this week<b>${usd(spend.freeCreditWeekUsd)} <span class="muted">of ${escapeHtml(cap(spend.weeklyCreditUsd))}</span></b>${meter(spend.freeCreditWeekUsd, spend.weeklyCreditUsd, "free credit this week against the weekly credit budget")}<span class="note">Free usage since ${escapeHtml(day(currentWeek))}; ${usd(spend.creditWeekUsd)} with admins and paid plans. Resets ${escapeHtml(weekday(spend.resetsAt))} 00:00 UTC.</span></div>
<div class="tile lead">Queue starts at<b>${queue.startUsd === null ? "–" : usd(queue.startUsd)}${spend.weeklyCreditUsd === null ? "" : ` <span class="muted">${escapeHtml(percent(spend.queueThreshold))} of ${usd(spend.weeklyCreditUsd)}</span>`}</b><span class="note">${escapeHtml(queue.text)}${spend.serving === "openrouter" ? " Luminal isn't serving, so the queue watches OpenRouter spend instead." : ""}</span></div>
<div class="tile">State<b class="state">${escapeHtml(state)}</b><span class="note">Admission: ${spend.openAdmission ? `open (old enough GitHub accounts${spend.requireGithubActivity ? " with a public repo or a contribution in the last year" : ""}); ${count(data.people.admitted)} admitted, no cap while open` : `invite-only; ${count(data.people.admitted)} of ${count(spend.maxActiveUsers)} admitted`}. GitHub activity check: ${spend.requireGithubActivity ? "on" : "off"}. Per person: ${escapeHtml(tokens(spend.weeklyTokens))} tokens or ${escapeHtml(cap(spend.perPersonWeeklyUsd))} a week.</span></div>
</div>
<p class="note">Effective values, with admin overrides applied. Credit is Luminal's prepaid credit at its list prices; admins count against it.</p>
</section>`;

  const upstreamRow = (row: DashboardData["upstreams"][number]) =>
    `<tr><td>${row.upstream === "openai" ? "OpenAI" : row.upstream === "luminal" ? "Luminal" : "OpenRouter"}</td><td>${count(row.requests)}</td><td>${count(row.errors)}${row.requests > 0 ? ` <span class="muted">(${percent(row.errors / row.requests)})</span>` : ""}</td><td>${ms(row.medianTtftMs)}</td><td>${ms(row.p90TtftMs)}</td><td>${ms(row.medianTtfbMs)}</td><td>${row.cacheHitShare === null ? "–" : percent(row.cacheHitShare)}</td><td>${usd(row.creditUsd)}</td><td>${usd(row.cashUsd)}</td></tr>`;
  const upstreamTable = (window: "today" | "week") => `<div class="scroll"><table>
<thead><tr><th>${window === "today" ? "Today (UTC)" : `This week, since ${escapeHtml(day(currentWeek))}`}</th><th>Requests</th><th>Errors</th><th>TTFT median</th><th>TTFT p90</th><th>TTFB median</th><th>Cache hits</th><th>Credit</th><th>Cash</th></tr></thead>
<tbody>
${data.upstreams.filter((row) => row.window === window).map(upstreamRow).join("\n")}
</tbody></table></div>`;
  const serving = servingName(spend);
  const upstreamSection = `<section id="upstream">
<div class="head"><h2>Upstreams</h2>${csvLink("upstreams")}</div>
<div class="tiles">
<div class="tile lead">Serving<b class="state">${escapeHtml(serving)}</b><span class="note">primaryUpstream: ${escapeHtml(spend.primaryUpstream)}. ${spend.serving === "none" ? "Free requests get 503 no_upstream until a key is set." : "A model's own provider serves it; GPT-6 Luna falls back to DeepSeek when OpenAI fails."}</span></div>
</div>
${upstreamSwitch(spend, input.csrf)}
${upstreamTable("today")}
${upstreamTable("week")}
<p class="note">Admins included. TTFT: time to the first content chunk (text, reasoning or a tool call); TTFB: time to the response headers. Errors: 429, 5xx, timeouts, unreachable and failed streams. Credit is Luminal's prepaid credit at its list prices; cash is OpenRouter's reported cost, when OpenRouter serves.</p>
</section>`;

  const activeSection = `<section>
<div class="head"><h2>Weekly active developers</h2>${csvLink("weekly-active")}</div>
<figure>
${columns(
  data.weeklyActive.map((week) => ({
    label: short(week.weekStart),
    value: week.active,
    inner: week.regular,
    title: `Week of ${day(week.weekStart)}: ${week.regular} on ${REGULAR_DAYS}+ days, ${week.active} on any day`,
  })),
  (value) => String(value),
  `Weekly active developers, last ${WEEKS_SHOWN} weeks`,
)}
<figcaption><span class="key"></span>${REGULAR_DAYS} or more days <span class="key soft"></span>any day</figcaption>
</figure>
<div class="scroll"><table>
<thead><tr><th>Week of (Mon, UTC)</th><th>Active on ${REGULAR_DAYS}+ days</th><th>Active on any day</th></tr></thead>
<tbody>
${[...data.weeklyActive]
  .reverse()
  .map((week) => `<tr><td>${escapeHtml(thisOrDate(week.weekStart))}</td><td>${count(week.regular)}</td><td>${count(week.active)}</td></tr>`)
  .join("\n")}
</tbody></table></div>
<p class="note">Distinct GitHub accounts with a request or a session event on that many separate UTC days, Monday to Sunday. This week is still running.</p>
</section>`;

  const retentionSection = `<section>
<div class="head"><h2>Cohort retention</h2>${csvLink("retention")}</div>
<div class="scroll"><table>
<thead><tr><th>Signed up, week of</th><th>People</th>${RETENTION_OFFSETS.map((offset) => `<th>Week ${offset}</th>`).join("")}</tr></thead>
<tbody>
${
  data.cohorts.length === 0
    ? `<tr><td colspan="${2 + RETENTION_OFFSETS.length}" class="l muted">No sign-ups in the last ${COHORT_WEEKS} weeks.</td></tr>`
    : data.cohorts
        .map(
          (cohort) =>
            `<tr><td>${escapeHtml(thisOrDate(cohort.weekStart))}</td><td>${count(cohort.size)}</td>${cohort.retained
              .map((cell) => (cell ? `<td title="${cell.active} of ${cohort.size}">${percent(cell.share)} <span class="muted">(${cell.active})</span></td>` : `<td class="muted">–</td>`))
              .join("")}</tr>`,
        )
        .join("\n")
}
</tbody></table></div>
<p class="note">People grouped by the week they were admitted (week 0); the share with any activity in the given week after it. Weeks that haven't ended show –.</p>
</section>`;

  const topWeek = data.topWeek;
  const costSection = `<section>
<div class="head"><h2>Cost per user per week</h2>${csvLink("weekly-cost")}</div>
<figure>
${columns(
  data.weeklyCost.map((week) => ({ label: short(week.weekStart), value: week.costUsd, title: `Week of ${day(week.weekStart)}: ${usd(week.costUsd)} across ${week.people} people` })),
  (value) => usd(value),
  `Total cost per week, last ${WEEKS_SHOWN} weeks`,
)}
<figcaption>Total cost per week</figcaption>
</figure>
<div class="scroll"><table>
<thead><tr><th>Week of</th><th>People</th><th>Requests</th><th>Tokens</th><th>Total</th><th>Median per person</th><th>Mean per person</th></tr></thead>
<tbody>
${[...data.weeklyCost]
  .reverse()
  .map(
    (week) =>
      `<tr${week.weekStart === topWeek ? ` class="sel"` : ""}><td><a href="/admin?week=${day(week.weekStart)}#top">${escapeHtml(thisOrDate(week.weekStart))}</a></td><td>${count(week.people)}</td><td>${count(week.requests)}</td><td>${tokens(week.tokens)}</td><td>${usd(week.costUsd)}</td><td>${usd(week.medianUsd)}</td><td>${usd(week.meanUsd)}</td></tr>`,
  )
  .join("\n")}
</tbody></table></div>
<p class="note">Real cost as OpenRouter reported it. People: accounts with at least one request that week; the median and mean are over them. Tokens are charged tokens (cached prompt tokens weighted). Pick a week for its top 10.</p>
<div class="head" id="top"><h2>Top 10 by cost, week of ${escapeHtml(day(topWeek))}</h2>${csvLink("top-cost", `?week=${day(topWeek)}`)}</div>
<div class="scroll"><table>
<thead><tr><th>GitHub login</th><th>GitHub id</th><th>Requests</th><th>Tokens</th><th>Cost</th><th>Share of week</th><th>Days active</th></tr></thead>
<tbody>
${(() => {
  const weekTotal = data.weeklyCost.find((week) => week.weekStart === topWeek)?.costUsd ?? 0;
  return data.top.length === 0
    ? `<tr><td colspan="7" class="l muted">No requests that week.</td></tr>`
    : data.top
        .map(
          (person) =>
            `<tr><td>${who(person.login, person.githubId)}</td><td>${person.githubId}</td><td>${count(person.requests)}</td><td>${tokens(person.tokens)}</td><td>${usd(person.costUsd)}</td><td>${weekTotal > 0 ? percent(person.costUsd / weekTotal) : "–"}</td><td>${person.activeDays}</td></tr>`,
        )
        .join("\n");
})()}
</tbody></table></div>
</section>`;

  const limitsSection = `<section id="limits">
<div class="head"><h2>Who hit the limit</h2>${csvLink("limits")}</div>
<div class="scroll"><table>
<thead><tr><th>Week of</th><th class="l">GitHub login</th><th class="l">Reached on</th><th class="l">Allowance</th><th>Tokens used</th><th>Cost</th></tr></thead>
<tbody>
${
  data.limitHits.length === 0
    ? `<tr><td colspan="6" class="l muted">Nobody reached their allowance this week or last.</td></tr>`
    : data.limitHits
        .map(
          (hit) =>
            `<tr><td>${escapeHtml(thisOrDate(hit.weekStart))}</td><td class="l">${who(hit.login, hit.githubId)}</td><td class="l">${escapeHtml(weekday(hit.day))}</td><td class="l">${
              hit.reached === "both" ? "tokens and $" : hit.reached === "tokens" ? "tokens" : "$"
            }</td><td>${tokens(hit.tokens)} <span class="muted">/ ${tokens(hit.tokenLimit)}</span></td><td>${usd(hit.costUsd)} <span class="muted">/ ${escapeHtml(cap(hit.usdLimit))}</span></td></tr>`,
        )
        .join("\n")
}
</tbody></table></div>
<p class="note">This week and last. The day is the UTC day a person's running total first reached their weekly allowance: ${Math.round(TOKEN_LIMIT_SHARE * 100)}% of the token allowance (the last few requests' worth can't be reserved) or all of the dollar allowance. Allowances are today's values, including per-person grants.</p>
</section>`;

  const q = data.queue;
  const queueSection = `<section>
<div class="head"><h2>Queue for free tokens</h2>${csvLink("queue")}</div>
<div class="tiles">
<div class="tile">Waiting now<b>${count(q.waiting)}</b><span class="note">${q.oldestQueuedAt === null ? "Nobody waiting." : `Longest wait: ${escapeHtml(waited(data.now - q.oldestQueuedAt))}, since ${escapeHtml(weekday(q.oldestQueuedAt))}`}</span></div>
<div class="tile">Admitted this Monday<b>${q.thisWeek ? count(q.thisWeek.admitted) : "–"}</b><span class="note">${
    q.thisWeek
      ? `${count(q.thisWeek.waitingBefore)} were waiting. Forecast: ${usd(q.thisWeek.avgUsd)} per active × (${count(q.thisWeek.actives)} actives + admitted) ≤ ${escapeHtml(cap(q.thisWeek.budgetUsd))}.`
      : "This week's admission runs on the first request of the week."
  }</span></div>
<div class="tile">Ever queued<b>${count(q.everQueued)}</b><span class="note">${count(q.admittedEver)} let in so far.</span></div>
</div>
</section>`;

  const r = data.referrals;
  const referralSection = `<section>
<div class="head"><h2>Referrals</h2>${csvLink("referrals")}</div>
<div class="tiles">
<div class="tile">Links used<b>${count(r.linksUsed)}</b><span class="note">Sign-ups that carried a code; ${count(r.blocked)} didn't count (own code, unknown code or same network).</span></div>
<div class="tile">Sign-ups via referral<b>${count(r.signups)}</b><span class="note">${count(r.becameActive)} became weekly active (${REGULAR_DAYS}+ request days in a week).</span></div>
<div class="tile">Bonus tokens granted this week<b>${escapeHtml(tokens(r.bonusTokensThisWeek))}</b><span class="note">A week, across ${count(r.peopleWithBonus)} people. Counts within the free budget.</span></div>
</div>
</section>`;

  const p = data.paid;
  const paidSection = `<section>
<div class="head"><h2>Paid plans</h2>${csvLink("paid")}</div>
<div class="tiles">
<div class="tile">Pro subscribers<b>${count(p.proSubscribers)}</b><span class="note">Active subscriptions now.</span></div>
<div class="tile">Top-ups<b>${count(p.topupsThisWeek)} <span class="muted">this week</span></b><span class="note">${count(p.topupsThisMonth)} this month.</span></div>
<div class="tile">Revenue, before tax<b>${usd(p.revenueWeekUsd)} <span class="muted">this week</span></b><span class="note">${usd(p.revenueMonthUsd)} this month (UTC).</span></div>
<div class="tile">Paid usage cost<b>${usd(p.paidCostWeekUsd)} <span class="muted">this week</span></b><span class="note">${usd(p.paidCostMonthUsd)} this month, ${count(p.paidRequestsWeek)} requests this week. Not counted against the free caps.</span></div>
</div>
</section>`;

  const f = data.installFunnel;
  const of = (part: number, whole: number) => (whole > 0 ? ` <span class="muted">(${percent(part / whole)})</span>` : "");
  const routeTitle = (row: InstallFunnelRow) =>
    DOWNLOAD_ROUTES.filter((route) => row.downloadsByRoute[route] > 0)
      .map((route) => `${ROUTE_LABELS[route]} ${count(row.downloadsByRoute[route])}`)
      .join(" · ");
  const funnelTable = (rows: InstallFunnelRow[], period: "day" | "week") => `<div class="scroll"><table>
<thead><tr><th>${period === "day" ? "Day" : "Week of"}</th><th>Scripts served*</th>${DOWNLOAD_ROUTES.map((route) => `<th>${escapeHtml(ROUTE_LABELS[route])}</th>`).join("")}<th>Installs ok*</th><th>Installs failed*</th><th>Sign-ups</th><th>First request</th><th>${period === "day" ? "Active that day" : "Weekly active"}</th></tr></thead>
<tbody>
${rows
  .map(
    (row) =>
      `<tr><td>${escapeHtml(period === "day" ? weekday(row.start) : thisOrDate(row.start))}</td><td title="${escapeHtml(routeTitle(row))}">${count(row.downloads)}</td>${DOWNLOAD_ROUTES.map((route) => `<td class="muted">${count(row.downloadsByRoute[route])}</td>`).join("")}<td>${count(row.installsOk)}${of(row.installsOk, row.downloads)}</td><td>${count(row.installsFailed)}</td><td>${count(row.signedUp)}${of(row.signedUp, row.installsOk)}</td><td>${count(row.firstRequest)}</td><td>${count(row.active)}</td></tr>`,
  )
  .join("\n")}
</tbody></table></div>`;
  const funnelSection = `<section>
<div class="head"><h2>Funnel</h2><span>${csvLink("install-funnel")} · ${csvLink("installs")}</span></div>
<p class="note">Scripts served → installs finished → free tier sign-ups → first request → active. * Anonymous counts: one per script served (dl.new and directionallylocal.run) and one per install that finished, with no IP, account or device, so they can't be joined to people or to each other. A percentage is of the column before it. Installs skip CI and anyone with DL_NO_TELEMETRY=1 or DO_NOT_TRACK=1; directionallylocal.run serves the same script to laptops and servers, so the split is in installs.</p>
<h3>Last ${FUNNEL_DAYS} days</h3>
${funnelTable(f.days, "day")}
<h3>Per week</h3>
${funnelTable(f.weeks, "week")}
<p class="note">Sign-ups: people admitted that period. First request: people whose first request was in it. Active: a request that day; for a week, requests on ${REGULAR_DAYS} or more of its days. Admins left out. Days and weeks are UTC.</p>
<div class="tiles">
<div class="tile">Installs by system, last ${WEEKS_SHOWN} weeks*<div class="scroll"><table>
<thead><tr><th>System</th><th>Mode</th><th>Ok</th><th>Failed</th></tr></thead>
<tbody>
${f.platforms.length === 0 ? `<tr><td colspan="4" class="l muted">No installs counted yet.</td></tr>` : f.platforms.map((row) => `<tr><td>${escapeHtml(`${row.os === "darwin" ? "macOS" : "Linux"} ${row.arch}`)}</td><td>${escapeHtml(row.mode)}</td><td>${count(row.ok)}</td><td>${count(row.failed)}</td></tr>`).join("\n")}
</tbody></table></div></div>
<div class="tile">Top failed steps, last ${WEEKS_SHOWN} weeks*<div class="scroll"><table>
<thead><tr><th>Step</th><th>Failed</th></tr></thead>
<tbody>
${f.failedSteps.length === 0 ? `<tr><td colspan="2" class="l muted">No failed installs.</td></tr>` : f.failedSteps.map((row) => `<tr><td>${escapeHtml(STEP_LABELS[row.step] ?? row.step)}</td><td>${count(row.failed)}</td></tr>`).join("\n")}
</tbody></table></div></div>
</div>
<h3>By sign-up week</h3>
<div class="scroll"><table>
<thead><tr><th>Signed up, week of</th><th>Sign-ups</th><th>First request</th><th>Weekly active</th></tr></thead>
<tbody>
${data.funnel
  .map(
    (row) =>
      `<tr${row.weekStart === null ? ` class="sel"` : ""}><td>${row.weekStart === null ? "All time" : escapeHtml(thisOrDate(row.weekStart))}</td><td>${count(row.signedUp)}</td><td>${count(row.firstRequest)}${row.signedUp > 0 ? ` <span class="muted">(${percent(row.firstRequest / row.signedUp)})</span>` : ""}</td><td>${count(row.weeklyActive)}${row.signedUp > 0 ? ` <span class="muted">(${percent(row.weeklyActive / row.signedUp)})</span>` : ""}</td></tr>`,
  )
  .join("\n")}
</tbody></table></div>
<p class="note">The same people followed from the week they signed up. Weekly active: requests on ${REGULAR_DAYS} or more days of some Monday–Sunday week. Admins left out.</p>
</section>`;

  const header = `${markHeader(
    `<span class="who">${viewToggle("full")}Signed in as <strong>${escapeHtml(input.login)}</strong>${
      input.signOut ? `<form method="post" action="/admin/signout"><button type="submit">Sign out</button></form>` : ""
    }</span>`,
  )}
<h1>Free tier</h1>
<p class="serving">Serving from <strong>${escapeHtml(serving)}</strong> <a href="#upstream">Switch upstream</a></p>
<p class="lede">${count(data.people.admitted)} people admitted, ${count(data.people.activeThisWeek)} active this week. Admins are left out of every number but the credit. Updated ${escapeHtml(new Date(data.now).toISOString().slice(0, 16).replace("T", " "))} UTC. Counts, tokens, cost and times only.</p>`;

  const abuse = input.abuse ? abuseSection(input.abuse, input.csrf) : "";
  const log = input.abuse ? adminLogSection(input.abuse) : "";
  return shell(`Admin · ${PRODUCT_NAME}`, [header, banner, budgetSection, abuse, upstreamSection, queueSection, referralSection, paidSection, funnelSection, activeSection, retentionSection, costSection, limitsSection, log].join("\n"));
}

// ─── The simple view ──────────────────────────────────────────────────────

/**
 * The simple view's stylesheet: a desktop admin app's cards (white panels with a 1px border,
 * 10px radius, bold numbers over small muted labels) in the dl tokens, light and dark. Charts
 * come in two drawings, wide and narrow, so their text stays the same size on a phone.
 */
const SIMPLE_STYLE = `${BRAND_TOKENS}
:root {
  --k-bg: #F9FAFB; --k-card: #FFFFFF; --k-text: #111827; --k-muted: #6B7280; --k-faint: #9CA3AF; --k-border: #E5E7EB; --k-axis: #D1D5DB;
  --k-shadow: 0 1px 2px 0 rgb(0 0 0 / .04); --k-up: #047857; --k-down: #B91C1C; --k-flag: #B45309; --k-flag-bg: rgba(245, 158, 11, .1);
  --k-ok: #047857; --k-ok-bg: rgba(16, 185, 129, .1); --k-stop: #B91C1C; --k-stop-bg: rgba(239, 68, 68, .09);
  --c-1: #2A78D6; --c-2: #EB6834;
}
@media (prefers-color-scheme: dark) {
  :root {
    --k-bg: #0B0E12; --k-card: #161A21; --k-text: #E6E9EE; --k-muted: #8A919E; --k-faint: #646B78; --k-border: #262B34; --k-axis: #3A404B;
    --k-shadow: none; --k-up: #34D399; --k-down: #F87171; --k-flag: #FBBF24; --k-flag-bg: rgba(251, 191, 36, .1);
    --k-ok: #34D399; --k-ok-bg: rgba(52, 211, 153, .12); --k-stop: #F87171; --k-stop-bg: rgba(248, 113, 113, .12);
    --c-1: #3987E5; --c-2: #D95926;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; min-height: 100vh; background: var(--k-bg); color: var(--k-text); font: 14px/1.5 var(--body); -webkit-font-smoothing: antialiased; }
a { color: inherit; }
a:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }
.bar { background: var(--k-card); border-bottom: 1px solid var(--k-border); }
.bar > div { max-width: 80rem; margin: 0 auto; padding: 14px 32px; display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; }
.brand { display: flex; align-items: center; gap: 10px; text-decoration: none; margin-right: auto; }
.logo { width: 34px; height: 34px; border-radius: 10px; background: color-mix(in srgb, var(--accent) 8%, transparent); display: grid; place-items: center; flex: none; }
.logo img { width: 22px; height: 22px; border-radius: 6px; display: block; }
.brand b { font: 600 16px var(--mono); }
.pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-size: 12.5px; font-weight: 600; }
.pill::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.pill.open { color: var(--k-ok); background: var(--k-ok-bg); }
.pill.paused { color: var(--k-stop); background: var(--k-stop-bg); }
.views { display: flex; gap: 4px; background: var(--k-bg); border: 1px solid var(--k-border); border-radius: 8px; padding: 3px; }
.views a { padding: 5px 13px; border-radius: 6px; font-size: 13px; font-weight: 500; color: var(--k-muted); text-decoration: none; }
.views a[aria-current="page"] { background: var(--accent); color: #FFFFFF; }
.bar form { margin: 0; }
.out { padding: 6px 10px; border-radius: 8px; border: 1px solid var(--k-border); background: transparent; color: var(--k-muted); font: 500 13px var(--body); cursor: pointer; }
.out:hover { color: var(--k-text); }
main { max-width: 80rem; margin: 0 auto; padding: 28px 32px 48px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; }
.card { background: var(--k-card); border: 1px solid var(--k-border); border-radius: 10px; padding: 24px; box-shadow: var(--k-shadow); min-width: 0; }
.span2 { grid-column: span 2; }
h2 { font-size: 15px; font-weight: 600; color: var(--k-muted); margin: 0 0 12px; }
.big { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; margin: 0 0 16px; }
.big b { font-size: 34px; font-weight: 700; letter-spacing: -.02em; line-height: 1.1; font-variant-numeric: tabular-nums; }
.big span { font-size: 13px; color: var(--k-muted); }
.growth { display: grid; gap: 20px; }
.growth div { display: flex; flex-direction: column; gap: 2px; }
.growth b { font-size: 34px; font-weight: 700; letter-spacing: -.02em; line-height: 1.1; font-variant-numeric: tabular-nums; display: flex; align-items: center; gap: 8px; }
.growth .l { font-size: 13px; font-weight: 500; }
.growth .s { font-size: 12px; color: var(--k-faint); }
.up { color: var(--k-up); }
.down { color: var(--k-down); }
.flat { color: var(--k-muted); }
.arrow { font-size: 20px; }
svg.chart { display: block; width: 100%; height: auto; overflow: visible; }
svg.chart.narrow { display: none; }
svg.chart text { fill: var(--k-muted); font: 11px var(--body); font-variant-numeric: tabular-nums; }
svg.chart text.v { fill: var(--k-text); font-weight: 600; }
svg.chart text.who { fill: var(--k-text); font-size: 12px; }
svg.chart .axis { stroke: var(--k-axis); stroke-width: 1; }
svg.chart .hit { fill: transparent; }
svg.chart g:hover .hit { fill: color-mix(in srgb, var(--k-text) 5%, transparent); }
svg.chart .c1 { fill: var(--c-1); }
svg.chart .c2 { fill: var(--c-2); }
.legend { display: flex; gap: 16px; margin: 0 0 12px; font-size: 12px; color: var(--k-muted); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
.legend i.c1 { background: var(--c-1); }
.legend i.c2 { background: var(--c-2); }
.flags { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.flags li { display: flex; gap: 10px; align-items: baseline; padding: 9px 12px; border-radius: 8px; background: var(--k-flag-bg); font-size: 13.5px; line-height: 1.35; }
.flags li::before { content: "!"; flex: none; width: 16px; height: 16px; border-radius: 50%; background: var(--k-flag); color: var(--k-card); font: 700 11px/16px var(--body); text-align: center; transform: translateY(2px); }
.flags a { text-decoration: none; }
.flags a:hover { text-decoration: underline; }
.none { color: var(--k-muted); margin: 0; }
.empty { color: var(--k-muted); margin: 8px 0 0; }
@media (max-width: 1100px) { main { grid-template-columns: minmax(0, 1fr); } .span2 { grid-column: auto; } .growth { grid-template-columns: 1fr 1fr; } }
@media (max-width: 760px) {
  .bar > div { padding: 12px 16px; }
  main { padding: 16px 16px 40px; gap: 14px; }
  .card { padding: 18px; }
  .big b, .growth b { font-size: 28px; }
  svg.chart.wide { display: none; }
  svg.chart.narrow { display: block; }
}
`;

/** A bar's path: square at the baseline, 3px rounded at the far end. */
function barPath(x: number, y: number, width: number, height: number, horizontal = false): string {
  const r = Math.min(3, horizontal ? width : height, horizontal ? height / 2 : width / 2);
  if (horizontal) return `M${x.toFixed(1)} ${y.toFixed(1)}h${(width - r).toFixed(1)}a${r} ${r} 0 0 1 ${r} ${r}v${(height - 2 * r).toFixed(1)}a${r} ${r} 0 0 1 -${r} ${r}h-${(width - r).toFixed(1)}z`;
  return `M${x.toFixed(1)} ${(y + height).toFixed(1)}v-${(height - r).toFixed(1)}a${r} ${r} 0 0 1 ${r} -${r}h${(width - 2 * r).toFixed(1)}a${r} ${r} 0 0 1 ${r} ${r}v${(height - r).toFixed(1)}z`;
}

/** Sign-ups per day, oldest first: thin columns, a value on the largest and on today, a title on each. */
function signupChart(days: Array<{ day: number; n: number }>, width: number, kind: "wide" | "narrow"): string {
  const height = 150;
  const top = 18;
  const bottom = 20;
  const plot = height - top - bottom;
  const max = Math.max(1, ...days.map((row) => row.n));
  const slot = width / Math.max(1, days.length);
  const barWidth = Math.min(kind === "wide" ? 14 : 10, slot * 0.55);
  const largest = days.reduce((best, row, index) => (row.n > (days[best]?.n ?? -1) ? index : best), 0);
  const last = days.length - 1;
  const parts = days.map((row, index) => {
    const x = index * slot + (slot - barWidth) / 2;
    const h = (row.n / max) * plot;
    const label = (index === largest && row.n > 0) || index === last;
    const when = index === last ? "Today" : weekday(row.day);
    return `<g><title>${escapeHtml(`${when}: ${row.n} sign-up${row.n === 1 ? "" : "s"}`)}</title><rect class="hit" x="${(index * slot).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${height - bottom}"></rect>${
      h > 0 ? `<path class="c1" d="${barPath(x, top + plot - h, barWidth, h)}"></path>` : ""
    }${label ? `<text class="v" x="${(x + barWidth / 2).toFixed(1)}" y="${(top + plot - h - 5).toFixed(1)}" text-anchor="middle">${count(row.n)}</text>` : ""}</g>`;
  });
  const first = days[0];
  const axisLabels = `${first ? `<text x="0" y="${height - 4}">${escapeHtml(short(first.day))}</text>` : ""}<text x="${width}" y="${height - 4}" text-anchor="end">today</text>`;
  return `<svg class="chart ${kind}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="New sign-ups per day, last ${days.length} days">
<line class="axis" x1="0" x2="${width}" y1="${top + plot + 0.5}" y2="${top + plot + 0.5}"></line>
${parts.join("\n")}
${axisLabels}
</svg>`;
}

/** Tokens this week per person, most first: one thin bar per login, coloured by level. */
function tokenChart(rows: SimpleData["topTokens"], width: number, kind: "wide" | "narrow"): string {
  const rowHeight = 24;
  const labelWidth = kind === "wide" ? 140 : 96;
  const right = 48;
  const barHeight = 10;
  const max = Math.max(1, ...rows.map((row) => row.tokens));
  const plot = width - labelWidth - right;
  const height = rows.length * rowHeight;
  const chars = kind === "wide" ? 20 : 13;
  const parts = rows.map((row, index) => {
    const y = index * rowHeight;
    const w = Math.max(2, (row.tokens / max) * plot);
    const name = row.login ?? `#${row.githubId}`;
    const shown = name.length > chars ? `${name.slice(0, chars - 1)}…` : name;
    const level = row.level === "starter" ? "Starter" : "Full";
    return `<g><title>${escapeHtml(`${name}: ${tokens(row.tokens)} tokens this week (${level})`)}</title><rect class="hit" x="0" y="${y}" width="${width}" height="${rowHeight}"></rect><text class="who" x="${labelWidth - 10}" y="${y + rowHeight / 2 + 4}" text-anchor="end">${escapeHtml(shown)}</text><path class="${row.level === "starter" ? "c2" : "c1"}" d="${barPath(labelWidth, y + (rowHeight - barHeight) / 2, w, barHeight, true)}"></path>${
      index === 0 ? `<text class="v" x="${(labelWidth + w + 6).toFixed(1)}" y="${y + rowHeight / 2 + 4}">${escapeHtml(tokens(row.tokens))}</text>` : ""
    }</g>`;
  });
  return `<svg class="chart ${kind}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Tokens used this week per person, top ${rows.length}">
<line class="axis" x1="${labelWidth - 0.5}" x2="${labelWidth - 0.5}" y1="0" y2="${height}"></line>
${parts.join("\n")}
</svg>`;
}

/** Week-over-week change: "+25%", or "—" when the week before had none (never "Infinity%"). */
export function growth(current: number, previous: number): { text: string; trend: "up" | "down" | "flat" } {
  if (previous <= 0) return { text: "—", trend: "flat" };
  const share = (current - previous) / previous;
  const rounded = Math.round(share * 100);
  if (rounded === 0) return { text: "0%", trend: "flat" };
  return { text: `${rounded > 0 ? "+" : "−"}${Math.abs(rounded).toLocaleString("en-US")}%`, trend: rounded > 0 ? "up" : "down" };
}

/** "kenji, mara and 2 more". */
function names(list: string[]): string {
  return list.length <= 3 ? list.join(", ") : `${list.slice(0, 3).join(", ")} and ${list.length - 3} more`;
}

/** At most five one-line red flags from numbers the data already has; empty when nothing stands out. */
export function redFlags(data: DashboardData, spend: SpendView, simple: SimpleData, abuse: AbuseData | undefined): Array<{ text: string; href: string }> {
  const flags: Array<{ text: string; href: string }> = [];
  const label = (login: string | null, id: number) => login ?? `#${id}`;
  // At or near the weekly cap: who reached it (with per-person grants), and who is past 80% of their level's tokens.
  const hits = data.limitHits.filter((hit) => hit.weekStart === data.currentWeek);
  const hitIds = new Set(hits.map((hit) => hit.githubId));
  const allowance = (level: string | null) => (level === "starter" ? spend.starterWeeklyTokens : spend.weeklyTokens);
  const near = simple.topTokens.filter((row) => !hitIds.has(row.githubId) && row.tokens >= BANNER_SHARE * allowance(row.level));
  const capped = [...hits.map((hit) => label(hit.login, hit.githubId)), ...near.map((row) => label(row.login, row.githubId))];
  if (capped.length > 0) flags.push({ text: `Near weekly cap: ${names(capped)}`, href: "/admin?view=full#limits" });
  // Free tokens used from another tool: requests, but not one session event from Autopilot.
  if (simple.outsideDl.length > 0) {
    flags.push({ text: `Used outside dl: ${names(simple.outsideDl.map((row) => `${label(row.login, row.githubId)} (${count(row.requests)} requests, 0 dl sessions)`))}`, href: "/admin?view=full#abuse" });
  }
  // Starter accounts using a lot: half their week or more, not already listed at the cap.
  const busyStarters = simple.topTokens.filter((row) => row.level === "starter" && !hitIds.has(row.githubId) && !near.includes(row) && row.tokens >= 0.5 * spend.starterWeeklyTokens);
  if (busyStarters.length > 0) flags.push({ text: `Busy Starter: ${names(busyStarters.map((row) => `${label(row.login, row.githubId)} (${tokens(row.tokens)})`))}`, href: "/admin?view=full#abuse" });
  if (abuse && abuse.clusterCount > 0) {
    flags.push({ text: `${count(abuse.clusteredAccounts)} accounts share ${abuse.clusterCount === 1 ? "a network" : `${count(abuse.clusterCount)} networks`}`, href: "/admin?view=full#abuse" });
  }
  if (simple.bursts.length > 0) {
    const burst = simple.bursts[0]!;
    flags.push({ text: `Burst: ${count(burst.accounts)} sign-ups, one network, ${WEEKDAYS[new Date(burst.day).getUTCDay()]} ${short(burst.day)}${simple.bursts.length > 1 ? ` (+${simple.bursts.length - 1} more)` : ""}`, href: "/admin?view=full#abuse" });
  }
  if (simple.failing.length > 0) {
    flags.push({
      text: `Failing requests: ${names(simple.failing.map((row) => `${label(row.login, row.githubId)} (${count(row.failed)}/${count(row.requests)})`))}`,
      href: "/admin?view=full#upstream",
    });
  }
  return flags.slice(0, 5);
}

/**
 * GET /admin?view=simple: four cards readable in a few seconds. Sign-ups per day with the total,
 * week-over-week growth, tokens this week per person by level, and red flags when there are any.
 * The header carries the Simple / Full switch and whether the free tier is open.
 */
export function simpleDashboardPage(input: { data: DashboardData; spend: SpendView; signOut: boolean; simple: SimpleData; abuse?: AbuseData }): Response {
  const { data, spend, simple } = input;
  const open = freeTierState(spend) === "Serving";

  const header = `<header class="bar"><div>
<a class="brand" href="/admin?view=simple"><span class="logo"><img src="${BRAND_ORIGIN}/logo-64.webp" alt="" width="22" height="22"></span><b>${escapeHtml(PRODUCT_NAME)} admin</b></a>
<span class="pill ${open ? "open" : "paused"}" title="${escapeHtml(freeTierState(spend))}">Free tier ${open ? "open" : "paused"}</span>
${viewToggle("simple")}
${input.signOut ? `<form method="post" action="/admin/signout"><button type="submit" class="out">Sign out</button></form>` : ""}
</div></header>`;

  // installFunnel.days is newest first; the chart reads oldest first.
  const days = [...data.installFunnel.days].reverse().map((row) => ({ day: row.start, n: row.signedUp }));
  const lastFortnight = days.reduce((sum, row) => sum + row.n, 0);
  const signups = `<section class="card span2" id="signups" aria-label="Sign-ups">
<h2>Sign-ups</h2>
<p class="big"><b>${count(data.people.admitted)}</b><span>so far · ${count(lastFortnight)} in ${days.length} days</span></p>
${signupChart(days, 800, "wide")}
${signupChart(days, 320, "narrow")}
</section>`;

  // Sign-ups: the last 7 days against the 7 before. Weekly active: the last full week against the one before.
  const newest = data.installFunnel.days;
  const sum = (rows: typeof newest) => rows.reduce((total, row) => total + row.signedUp, 0);
  const signupsNow = sum(newest.slice(0, 7));
  const signupsBefore = sum(newest.slice(7, 14));
  const weeks = data.weeklyActive;
  const activeNow = weeks[weeks.length - 2]?.active ?? 0;
  const activeBefore = weeks[weeks.length - 3]?.active ?? 0;
  const arrow = { up: "▲", down: "▼", flat: "" } as const;
  const stat = (name: string, now: number, before: number, span: string) => {
    const change = growth(now, before);
    return `<div><span class="l">${escapeHtml(name)}</span><b class="${change.trend}">${change.trend === "flat" ? "" : `<span class="arrow" aria-hidden="true">${arrow[change.trend]}</span>`}${escapeHtml(change.text)}</b><span class="s">${count(now)} vs ${count(before)}, ${escapeHtml(span)}</span></div>`;
  };
  const growthCard = `<section class="card" id="growth" aria-label="Growth">
<h2>Week over week</h2>
<div class="growth">
${stat("Sign-ups", signupsNow, signupsBefore, "last 7 days")}
${stat("Weekly active people", activeNow, activeBefore, "last full week")}
</div>
</section>`;

  const tokenCard = `<section class="card span2" id="tokens" aria-label="Tokens per person">
<h2>Tokens this week, per person</h2>
${
  simple.topTokens.length === 0
    ? `<p class="empty">No tokens used this week.</p>`
    : `<div class="legend"><span><i class="c1"></i>Full</span><span><i class="c2"></i>Starter</span></div>
${tokenChart(simple.topTokens, 800, "wide")}
${tokenChart(simple.topTokens, 320, "narrow")}`
}
</section>`;

  const flags = redFlags(data, spend, simple, input.abuse);
  const flagCard = `<section class="card" id="flags" aria-label="Red flags">
<h2>Red flags</h2>
${flags.length === 0 ? `<p class="none">No red flags.</p>` : `<ul class="flags">\n${flags.map((flag) => `<li><a href="${flag.href}">${escapeHtml(flag.text)}</a></li>`).join("\n")}\n</ul>`}
</section>`;

  return shell(`Admin · ${PRODUCT_NAME}`, `${header}\n<main>\n${signups}\n${growthCard}\n${tokenCard}\n${flagCard}\n</main>`, 200, {}, "", SIMPLE_STYLE);
}

// ─── CSV ──────────────────────────────────────────────────────────────────

function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = typeof value === "number" ? String(Math.round(value * 1e6) / 1e6) : String(value);
  // Keep spreadsheets from reading a value as a formula.
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((row) => row.map(csvField).join(",")).join("\r\n") + "\r\n";
}

export function dashboardCsv(table: CsvTable, data: DashboardData, spend: SpendView): Response {
  let body: string;
  switch (table) {
    case "spend":
      body = csv(
        ["week_start", "week_usd", "weekly_cap_usd", "total_usd", "total_cap_usd", "admin_week_usd", "admin_total_usd", "paused", "paused_by_env", "open_admission", "admitted", "max_active_users", "resets_at", "primary_upstream", "luminal_credit_usd", "luminal_credit_used_usd", "free_credit_week_usd", "weekly_credit_usd", "require_github_activity"],
        [[day(data.currentWeek), spend.weekUsd, spend.weeklyCapUsd, spend.totalUsd, spend.totalCapUsd, spend.adminWeekUsd, spend.adminTotalUsd, spend.paused, spend.pausedByEnv, spend.openAdmission, data.people.admitted, spend.maxActiveUsers, new Date(spend.resetsAt).toISOString(), spend.primaryUpstream, spend.creditUsd, spend.creditUsedUsd, spend.freeCreditWeekUsd, spend.weeklyCreditUsd, spend.requireGithubActivity]],
      );
      break;
    case "weekly-active":
      body = csv(["week_start", `active_${REGULAR_DAYS}_plus_days`, "active_any_day"], data.weeklyActive.map((week) => [day(week.weekStart), week.regular, week.active]));
      break;
    case "retention":
      body = csv(
        ["signup_week", "people", ...RETENTION_OFFSETS.flatMap((offset) => [`week_${offset}_active`, `week_${offset}_share`])],
        data.cohorts.map((cohort) => [day(cohort.weekStart), cohort.size, ...cohort.retained.flatMap((cell) => (cell ? [cell.active, cell.share] : [null, null]))]),
      );
      break;
    case "weekly-cost":
      body = csv(
        ["week_start", "people", "requests", "charged_tokens", "total_usd", "median_usd_per_person", "mean_usd_per_person"],
        data.weeklyCost.map((week) => [day(week.weekStart), week.people, week.requests, week.tokens, week.costUsd, week.medianUsd, week.meanUsd]),
      );
      break;
    case "top-cost":
      body = csv(
        ["week_start", "rank", "github_login", "github_id", "requests", "charged_tokens", "cost_usd", "days_active"],
        data.top.map((person, index) => [day(data.topWeek), index + 1, person.login, person.githubId, person.requests, person.tokens, person.costUsd, person.activeDays]),
      );
      break;
    case "queue": {
      const q = data.queue;
      body = csv(
        ["waiting", "oldest_queued_at", "admitted_this_monday", "waiting_before_this_monday", "forecast_avg_usd", "forecast_actives", "forecast_budget_usd", "ever_queued", "admitted_ever"],
        [[q.waiting, q.oldestQueuedAt === null ? null : new Date(q.oldestQueuedAt).toISOString(), q.thisWeek?.admitted ?? null, q.thisWeek?.waitingBefore ?? null, q.thisWeek?.avgUsd ?? null, q.thisWeek?.actives ?? null, q.thisWeek?.budgetUsd ?? null, q.everQueued, q.admittedEver]],
      );
      break;
    }
    case "referrals": {
      const r = data.referrals;
      body = csv(["links_used", "signups", "blocked", "became_active", "bonus_tokens_this_week", "people_with_bonus"], [[r.linksUsed, r.signups, r.blocked, r.becameActive, r.bonusTokensThisWeek, r.peopleWithBonus]]);
      break;
    }
    case "paid": {
      const p = data.paid;
      body = csv(
        ["pro_subscribers", "topups_this_week", "topups_this_month", "revenue_week_usd", "revenue_month_usd", "paid_cost_week_usd", "paid_cost_month_usd", "paid_requests_week"],
        [[p.proSubscribers, p.topupsThisWeek, p.topupsThisMonth, p.revenueWeekUsd, p.revenueMonthUsd, p.paidCostWeekUsd, p.paidCostMonthUsd, p.paidRequestsWeek]],
      );
      break;
    }
    case "upstreams":
      body = csv(
        ["window", "upstream", "requests", "errors", "ttft_median_ms", "ttft_p90_ms", "ttfb_median_ms", "cache_hit_share", "credit_usd", "cash_usd"],
        [
          ...data.upstreams.map((row) => [row.window, row.upstream, row.requests, row.errors, row.medianTtftMs, row.p90TtftMs, row.medianTtfbMs, row.cacheHitShare, row.creditUsd, row.cashUsd]),
          ["all_time", "luminal_credit", null, null, null, null, null, null, spend.creditUsedUsd, null],
        ],
      );
      break;
    case "funnel":
      body = csv(["signup_week", "signed_up", "first_request", "weekly_active"], data.funnel.map((row) => [row.weekStart === null ? "all" : day(row.weekStart), row.signedUp, row.firstRequest, row.weeklyActive]));
      break;
    case "install-funnel":
      body = csv(
        ["period", "start", "scripts_served", ...DOWNLOAD_ROUTES.map((route) => `served_${route}`), "installs_ok", "installs_failed", "signed_up", "first_request", "active"],
        (["day", "week"] as const).flatMap((period) =>
          (period === "day" ? data.installFunnel.days : data.installFunnel.weeks).map((row) => [
            period,
            day(row.start),
            row.downloads,
            ...DOWNLOAD_ROUTES.map((route) => row.downloadsByRoute[route]),
            row.installsOk,
            row.installsFailed,
            row.signedUp,
            row.firstRequest,
            row.active,
          ]),
        ),
      );
      break;
    case "installs":
      body = csv(
        ["kind", "os", "arch", "mode", "step", "ok", "failed"],
        [
          ...data.installFunnel.platforms.map((row) => ["system", row.os, row.arch, row.mode, null, row.ok, row.failed]),
          ...data.installFunnel.failedSteps.map((row) => ["failed_step", null, null, null, row.step || "unknown", null, row.failed]),
        ],
      );
      break;
    case "limits":
      body = csv(
        ["week_start", "github_login", "github_id", "reached_on", "reached", "token_day", "usd_day", "charged_tokens", "token_allowance", "cost_usd", "usd_allowance"],
        data.limitHits.map((hit) => [
          day(hit.weekStart),
          hit.login,
          hit.githubId,
          day(hit.day),
          hit.reached,
          hit.tokenDay === null ? null : day(hit.tokenDay),
          hit.usdDay === null ? null : day(hit.usdDay),
          hit.tokens,
          hit.tokenLimit,
          hit.costUsd,
          hit.usdLimit,
        ]),
      );
      break;
  }
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="free-${table}-${day(data.now)}.csv"`,
      ...dashboardHeaders(),
    },
  });
}
