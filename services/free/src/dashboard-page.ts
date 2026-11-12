import { escapeHtml } from "../../shared/src/html.js";
import { DOWNLOAD_ROUTES } from "./telemetry.js";
import { averageRetention, COHORT_WEEKS, DAILY_COHORTS, FUNNEL_DAYS, REGULAR_DAYS, RETENTION_DAYS, RETENTION_OFFSETS, TOKEN_LIMIT_SHARE, WEEKS_SHOWN, type DailyCohort, type DashboardData, type InstallFunnelRow } from "./dashboard-data.js";
import { ABUSE_DAYS, type AbuseData, type AbusePerson, type SimpleData } from "./abuse.js";
import { BRAND_ORIGIN, BRAND_TOKENS, PRODUCT_NAME } from "./pages.js";
import { isoDay } from "./week.js";
import type { LevelChecks } from "./admission.js";
import type { EarlyAccessLead, PendingAccessRequest } from "./directory-object.js";
import { hasCapitals, type BroadcastAudience } from "./broadcast.js";
import { GRANT_LABELS, grantUsdText, MAX_GRANT_LOGINS, MAX_GRANT_USD, type GrantResult } from "./grant.js";
import { FREE_MODELS } from "./models.js";
import { creditBudget, creditMode } from "./queue.js";
import { GPU_OPTION_NAMES, GPU_VENDOR_NAMES, HEALTH_WINDOWS, healthTakeaways, INSTALL_STEPS, NORMAL_SESSION_ENDS, NO_END, STILL_OPEN, type HealthData } from "./health-data.js";

/** One Starter account on the full dashboard: its stored signals and which checks pass. Admin-only. */
export interface StarterRow {
  githubId: number;
  login: string;
  admittedAt: number;
  levelReason: string | null;
  accountAgeDays: number | null;
  publicRepos: number | null;
  contributions: number | null;
  followers: number | null;
  activeWeeks: number | null;
  outsideContributions: number | null;
  oldestRepoAt: number | null;
  social: number | null;
  checks: LevelChecks;
}

/** The full dashboard shows this many Starter accounts, newest first. */
export const STARTER_ROWS = 50;

/**
 * The admin dashboard as server-rendered HTML, plus a CSV of each table. No scripts and no
 * inline `style` attributes: the one stylesheet carries a per-response nonce, so the page works
 * under `default-src 'none'`. It wears the dl.new brand (tokens, Bricolage/Geist/Geist Mono and
 * the logo, loaded from dl.new and nothing else), light and dark following the device. Charts
 * are small inline SVGs with presentation attributes and a `<title>` per bar for the value.
 * The only forms are sign-out, block/unblock, the routing setting (primaryUpstream) switch and the Tools
 * tab's two forms; all but sign-out post back here with a CSRF token.
 *
 * The home screen (home-page.ts) is the default at /admin. Behind it, four tabs: the full view
 * at /admin?view=full (every table), a simple one at /admin?view=simple,
 * four cards readable at a glance (sign-ups, growth, tokens per person, red flags), mostly
 * inline SVG charts, and Tools at /admin?view=tools (give free tokens by GitHub username, write
 * an email to users), whose buttons post a form and get the page back, and Health at
 * /admin?view=health (errors, crashes, versions, sessions, tools, models, installs and GPUs from
 * Autopilot's session events and the anonymous counts; health-data.ts). Switching is a plain link: no scripts.
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
  /** The GitHub account check at sign-up: off gives everyone Full. */
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
  /** Luminal's weekly credit budget; null for none. */
  weeklyCreditUsd: number | null;
  /** OpenAI credit: the balance, used since the start, used this week (all, and free usage only), the weekly budget. */
  openaiCreditUsd: number;
  openaiCreditUsedUsd: number;
  openaiCreditWeekUsd: number;
  openaiFreeCreditWeekUsd: number;
  openaiWeeklyCreditUsd: number | null;
  /** A Starter account's weekly tokens (a batch-flagged one gets none), and its dollar cap. */
  starterWeeklyTokens: number;
  starterWeeklyUsd: number | null;
  /** The basic level: weekly tokens (0: off), dollar cap, and the account age it needs. Admin-only. */
  basicWeeklyTokens: number;
  basicWeeklyUsd: number | null;
  basicMinAccountAgeDays: number;
  /** The public bar for Full (free tokens): account age, and public repositories or contributions. */
  fullMinAccountAgeDays: number;
  fullMinPublicRepos: number;
  fullMinContributions: number;
}

/** The red banner shows at this share of either cap. */
export const BANNER_SHARE = 0.8;

/** The Health view's tables (healthCsv); they take ?days= like the page. */
export const HEALTH_CSV_TABLES = [
  "health-errors",
  "health-request-failures",
  "health-ends",
  "health-turns",
  "health-versions",
  "health-sessions",
  "health-tools",
  "health-models",
  "health-upstreams",
  "health-installs",
  "health-gpus",
] as const;
export type HealthCsvTable = (typeof HEALTH_CSV_TABLES)[number];

export const CSV_TABLES = ["early-access", "spend", "weekly-active", "retention", "retention-daily", "weekly-cost", "top-cost", "limits", "queue", "referrals", "funnel", "install-funnel", "installs", "paid", "upstreams", ...HEALTH_CSV_TABLES] as const;
export type CsvTable = (typeof CSV_TABLES)[number];

export function isCsvTable(name: string): name is CsvTable {
  return (CSV_TABLES as readonly string[]).includes(name);
}

export function isHealthCsvTable(name: string): name is HealthCsvTable {
  return (HEALTH_CSV_TABLES as readonly string[]).includes(name);
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
td.wrap { white-space: normal; min-width: 11rem; }
td.used svg { margin-top: 4px; min-width: 8rem; height: 6px; }
.switch { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 10px; }
button.on { background: var(--ink); color: var(--on-ink); border-color: var(--ink); cursor: default; }
.banner { background: var(--accent); color: #fff; border-radius: 10px; padding: 10px 14px; margin: 14px 0 0; font-weight: 600; }
.signin { max-width: 28rem; margin: 10vh auto 0; text-align: center; display: grid; gap: 14px; justify-items: center; }
.signin .btn { display: inline-flex; padding: 12px 20px; border-radius: 12px; background: var(--ink); color: var(--on-ink); text-decoration: none; font-weight: 600; }
[role="alert"] { margin: 0; }
.views { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
.views a { font: 500 12px var(--body); padding: 2px 9px; border-radius: 6px; text-decoration: none; color: var(--muted); }
.views a[aria-current="page"] { background: var(--ink); color: var(--on-ink); }
.takeaway { margin: 0 0 4px; font-weight: 600; }
tr.bad td { color: var(--accent); }
.health-views { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; margin: 4px 0 0; }
`;

export function nonce(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function shell(title: string, body: string, status = 200, headers: Record<string, string> = {}, head = "", style = STYLE): Response {
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

/** Compact counts for big numbers: 412, 12.3k, 41.2M, 2.3B (three significant digits, trailing zeros dropped). */
export function compact(value: number): string {
  const units: Array<[number, string]> = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "k"]];
  const rounded = Math.round(value);
  for (const [size, unit] of units) {
    if (Math.abs(rounded) < size) continue;
    const scaled = rounded / size;
    const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
    const text = Number(scaled.toFixed(digits));
    // 999.95k rounds to 1000k: say 1M.
    if (text >= 1000 && size < 1e12) return compact(1000 * size * Math.sign(rounded));
    return `${text}${unit}`;
  }
  return String(rounded);
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
/** Why a step failed, when install.sh said (`step:reason` in the failed-steps table). */
const REASON_LABELS: Record<string, string> = {
  termux: "Android (Termux)",
  arm32: "32-bit ARM system",
  musl: "musl Linux (Alpine)",
  tools: "no tar or gzip",
  glibc: "glibc older than 2.28",
  fetch: "couldn't reach nodejs.org",
  download: "download failed",
  checksum: "checksum didn't match",
  unpack: "couldn't unpack",
  run: "Node.js doesn't run here",
  unpatched: "Node.js missing the fix",
};
function stepLabel(step: string): string {
  const [name = "", reason] = step.split(":");
  const label = STEP_LABELS[name] ?? name;
  return reason ? `${label}: ${REASON_LABELS[reason] ?? reason}` : label;
}

const short = (ms: number) => isoDay(ms).slice(5);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Nov 8" (UTC). */
const monthDay = (ms: number) => `${MONTHS[new Date(ms).getUTCMonth()]} ${new Date(ms).getUTCDate()}`;

/** "Average D1 16% · D7 5%": day 1 and day 7 over the cohorts that have reached them, weighted by size. */
function retentionAverages(cohorts: readonly DailyCohort[]): string {
  const part = (offset: 1 | 7) => {
    const average = averageRetention(cohorts, offset);
    return average === null ? `D${offset} –` : `D${offset} <b>${percent(average.share)}</b> <span class="muted">(${count(average.cohorts)} cohort${average.cohorts === 1 ? "" : "s"}, ${count(average.people)} people)</span>`;
  };
  return `Average ${part(1)} · ${part(7)}, weighted by cohort size.`;
}

// ─── Abuse ────────────────────────────────────────────────────────────────

/**
 * "Routing setting: OpenAI / Luminal / OpenRouter" (primaryUpstream): one button per upstream, the current one pressed. Only
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
  return `<div class="switch"><span>Routing setting:</span>${button("openai", "OpenAI", spend.openaiConfigured)}${button("luminal", "Luminal", spend.luminalConfigured)}${button("openrouter", "OpenRouter", spend.openRouterConfigured)}</div>
<p class="note">This setting doesn't move GPT-6 traffic: GPT-6 models always go to OpenAI and DeepSeek to Luminal. OpenAI and Luminal route the same; they only pick whose weekly credit budget the waiting line watches (OpenAI is the default). OpenRouter sends DeepSeek requests to OpenRouter, paid in cash instead of Luminal credit, until you switch back; GPT-6 stays on OpenAI.${spend.openRouterConfigured ? "" : " OpenRouter can't be chosen: the service has no OPENROUTER_API_KEY."} This is the primaryUpstream setting; it takes effect on the next request, nothing switches back on its own, and each switch is in the admin log.</p>`;
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

/** Starter accounts and why: each stored signal, marked when its check passes. */
function startersSection(rows: StarterRow[], total: number): string {
  const num = (value: number | null) => (value === null ? "–" : count(value));
  const mark = (text: string, pass: boolean) => (pass ? `<strong title="passes">${text}</strong>` : `<span class="muted">${text}</span>`);
  const body = rows.map((row) => {
    const c = row.checks;
    return `<tr><td class="l">${who(row.login, row.githubId)}</td><td>${when(row.admittedAt)}</td><td class="l">${escapeHtml(row.levelReason ?? "–")}</td><td>${num(row.accountAgeDays)}</td><td>${num(row.publicRepos)}</td><td>${num(row.contributions)}</td><td>${mark(c.publicBar ? "yes" : "no", c.publicBar)}</td><td>${mark(num(row.activeWeeks), c.activeWeeks)}</td><td>${mark(num(row.outsideContributions), c.outsideContributions)}</td><td>${mark(row.oldestRepoAt === null ? "–" : escapeHtml(isoDay(row.oldestRepoAt)), c.oldRepo)}</td><td>${mark(num(row.social), c.social)}</td><td>${mark(num(row.followers), c.followers)}</td><td>${count(c.humanSignals)}</td><td>${c.creationBatch ? `<strong>yes</strong> <span class="muted">(${count(c.batchPeers)})</span>` : `<span class="muted">no (${count(c.batchPeers)})</span>`}</td><td>${c.full ? "<strong>yes</strong>" : "no"}</td></tr>`;
  });
  return `<section id="starters">
<div class="head"><h2>Starter accounts</h2><span class="muted">${count(total)} in all${total > rows.length ? `, newest ${rows.length} shown` : ""}. Admins left out.</span></div>
<div class="scroll"><table>
<thead><tr><th class="l">GitHub login</th><th>Signed up (UTC)</th><th class="l">Reason</th><th>Age (days)</th><th>Public repos</th><th>Contributions</th><th>Public bar</th><th>Active weeks</th><th>Outside contributions</th><th>Oldest repo</th><th>Following + stars</th><th>Followers</th><th>Signals passing</th><th>Creation batch (peers)</th><th>Passes now</th></tr></thead>
<tbody>
${body.length === 0 ? `<tr><td colspan="15" class="l muted">No Starter accounts.</td></tr>` : body.join("\n")}
</tbody></table></div>
<p class="note">The signals stored at the last sign-in or re-check, under today's thresholds (the level settings in /admin/config). Bold: the check passes. "Passes now" yes on a Starter account means it would be promoted at its next re-check or sign-in; an admin-set level stands either way. Numbers only.</p>
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

/**
 * The waiting line, as the code runs it (queue.ts `shouldQueue`, `creditBudget`): which weekly
 * credit budget it watches, the spend at which new open sign-ups start to wait, the spend it
 * compares, and when that spend would get there at this week's pace.
 */
export function queueStart(spend: SpendView, data: DashboardData): { startUsd: number | null; budgetUsd: number | null; provider: string | null; watchedUsd: number; text: string } {
  const policy = {
    primaryUpstream: spend.primaryUpstream,
    openaiConfigured: spend.openaiConfigured,
    luminalConfigured: spend.luminalConfigured,
    openaiCreditUsd: spend.openaiCreditUsd,
    openaiWeeklyCreditUsd: spend.openaiWeeklyCreditUsd ?? undefined,
    luminalCreditUsd: spend.creditUsd,
    luminalWeeklyCreditUsd: spend.weeklyCreditUsd ?? undefined,
  };
  const budget = creditMode(policy) ? creditBudget(policy) : undefined;
  const budgetUsd = budget?.weeklyUsd ?? null;
  const provider = budget ? PROVIDER_NAMES[budget.provider] : null;
  const startUsd = budgetUsd === null ? null : spend.queueThreshold * budgetUsd;
  // shouldQueue compares this week's free Luminal credit spend, whichever budget it watches.
  const watchedUsd = spend.freeCreditWeekUsd;
  const result = (text: string) => ({ startUsd, budgetUsd, provider, watchedUsd, text });
  if (data.queue.waiting > 0) return result(`On: ${count(data.queue.waiting)} waiting. New open sign-ups join the line.`);
  if (startUsd === null) return result(budget ? "No weekly credit budget, so credit spend never starts the line." : spend.primaryUpstream === "openrouter" ? "Routed to OpenRouter: credit spend doesn't start the line." : "No OpenAI or Luminal key: credit spend doesn't start the line.");
  if (watchedUsd >= startUsd) return result("On: new open sign-ups wait for free tokens.");
  const left = `${usd(startUsd - watchedUsd)} to go.`;
  const elapsed = data.now - data.currentWeek;
  if (watchedUsd <= 0 || elapsed < 3_600_000) return result(`${left} Too early in the week for a pace.`);
  const at = data.currentWeek + (elapsed * startUsd) / watchedUsd;
  return result(at < spend.resetsAt ? `${left} At this week's pace: ${weekday(at)} ${new Date(at).toISOString().slice(11, 16)} UTC.` : `${left} Not this week at this week's pace.`);
}

/** Any repository count at or above this means the repositories path to Full is switched off. */
export const REPOS_PATH_OFF = 100_000;

/**
 * Who gets in and who gets free tokens, from the effective settings. Only the public bar: the
 * private account checks' thresholds are never shown here.
 */
export function admissionText(spend: SpendView, admitted: number): string {
  const usd = (value: number | null) => (value === null ? "" : `, up to $${value}`);
  const starter = spend.starterWeeklyTokens > 0 ? `${tokens(spend.starterWeeklyTokens)} tokens a week of every model${usd(spend.starterWeeklyUsd)} (none for creation-batch accounts)` : "no free tokens";
  const basic =
    spend.basicWeeklyTokens > 0
      ? `Basic, for accounts at least ${count(spend.basicMinAccountAgeDays)} days old outside a creation batch: ${tokens(spend.basicWeeklyTokens)} tokens a week of every model${usd(spend.basicWeeklyUsd)}`
      : "";
  const parts: string[] = [];
  if (spend.fullMinAccountAgeDays > 0) parts.push(`at least ${count(spend.fullMinAccountAgeDays)} days old`);
  const paths = [`${count(spend.fullMinContributions)}+ contributions in the last year`];
  if (spend.fullMinPublicRepos < REPOS_PATH_OFF) paths.push(`${count(spend.fullMinPublicRepos)}+ public repos`);
  parts.push(`with ${paths.join(" or ")}`);
  const bar = spend.requireGithubActivity
    ? `Free tokens (Full) need a GitHub account ${parts.join(" ")}, and the private account checks count too; below that, ${basic ? `${basic}; everyone else, Starter` : "Starter"}: ${starter}.`
    : "GitHub account check off: everyone gets Full.";
  const who = spend.openAdmission
    ? `Admission: open, any GitHub account can sign up; ${count(admitted)} admitted, no cap while open.`
    : `Admission: invite-only; ${count(admitted)} of ${count(spend.maxActiveUsers)} admitted. An invite always gives Full.`;
  return `${who} ${bar}`;
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

const PROVIDER_NAMES = { openai: "OpenAI", luminal: "Luminal", openrouter: "OpenRouter" } as const;

/** One row per prepaid-credit provider, from the effective config and the spend counters. */
export function creditProviders(spend: SpendView): Array<{ id: "openai" | "luminal"; name: string; configured: boolean; balanceUsd: number; usedUsd: number; weekUsd: number; freeWeekUsd: number; weeklyBudgetUsd: number | null }> {
  return [
    { id: "openai", name: "OpenAI", configured: spend.openaiConfigured, balanceUsd: spend.openaiCreditUsd, usedUsd: spend.openaiCreditUsedUsd, weekUsd: spend.openaiCreditWeekUsd, freeWeekUsd: spend.openaiFreeCreditWeekUsd, weeklyBudgetUsd: spend.openaiWeeklyCreditUsd },
    { id: "luminal", name: "Luminal", configured: spend.luminalConfigured, balanceUsd: spend.creditUsd, usedUsd: spend.creditUsedUsd, weekUsd: spend.creditWeekUsd, freeWeekUsd: spend.freeCreditWeekUsd, weeklyBudgetUsd: spend.weeklyCreditUsd },
  ];
}

/** Spend across providers: the prepaid credit, plus the older metered OpenRouter cash (admins included). */
export function spendTotals(spend: SpendView): { allTimeUsd: number; weekUsd: number; meteredAllTimeUsd: number; meteredWeekUsd: number } {
  const providers = creditProviders(spend);
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  const meteredAllTimeUsd = round(spend.totalUsd + spend.adminTotalUsd);
  const meteredWeekUsd = round(spend.weekUsd + spend.adminWeekUsd);
  return {
    allTimeUsd: round(providers.reduce((sum, row) => sum + row.usedUsd, 0) + meteredAllTimeUsd),
    weekUsd: round(providers.reduce((sum, row) => sum + row.weekUsd, 0) + meteredWeekUsd),
    meteredAllTimeUsd,
    meteredWeekUsd,
  };
}

/** The red banner's sentences: a provider's credit, or its weekly credit budget, past BANNER_SHARE. */
function creditWarnings(spend: SpendView): string[] {
  return creditProviders(spend).flatMap((row) => {
    const share = row.balanceUsd > 0 ? row.usedUsd / row.balanceUsd : row.usedUsd > 0 ? 1 : 0;
    const weekShare = row.weeklyBudgetUsd !== null && row.weeklyBudgetUsd > 0 ? row.freeWeekUsd / row.weeklyBudgetUsd : 0;
    return [
      ...(share >= BANNER_SHARE ? [`${percent(share)} of the ${usd(row.balanceUsd)} ${row.name} credit used (${usd(row.usedUsd)}).`] : []),
      ...(weekShare >= BANNER_SHARE ? [`${percent(weekShare)} of this week's ${usd(row.weeklyBudgetUsd)} ${row.name} credit budget used (${usd(row.freeWeekUsd)}).`] : []),
    ];
  });
}

/**
 * Where each model goes right now, as app.ts `servingModel` decides: GPT-6 models to OpenAI
 * (DeepSeek on Luminal when OpenAI has no key or credit), DeepSeek to Luminal, or to OpenRouter
 * when the routing setting says so or Luminal has no key.
 */
export function routes(spend: SpendView): { gpt: string; deepseek: string } {
  const luminalReady = spend.luminalConfigured && spend.creditUsedUsd < spend.creditUsd;
  const openaiReady = spend.openaiConfigured && spend.openaiCreditUsedUsd < spend.openaiCreditUsd;
  const deepseek =
    spend.primaryUpstream === "openrouter" && spend.openRouterConfigured
      ? "OpenRouter"
      : luminalReady
        ? "Luminal"
        : !spend.luminalConfigured && spend.openRouterConfigured
          ? "OpenRouter"
          : "nowhere";
  const gpt = openaiReady ? "OpenAI" : luminalReady ? "DeepSeek on Luminal (fallback)" : "nowhere";
  return { gpt, deepseek };
}

/** Model names per provider, from models.ts. */
function modelNames(provider: "openai" | "luminal"): string {
  return FREE_MODELS.filter((model) => model.provider === provider)
    .map((model) => model.name)
    .join(", ");
}

/** The Simple / Full / Tools / Health switch: four links, the current one marked. */
function viewToggle(current: "simple" | "full" | "tools" | "health"): string {
  const link = (view: "simple" | "full" | "tools" | "health", label: string) => `<a href="/admin?view=${view}"${current === view ? ` aria-current="page"` : ""}>${label}</a>`;
  return `<nav class="views" aria-label="Dashboard view"><a href="/admin">Home</a>${link("simple", "Simple")}${link("full", "Full")}${link("tools", "Tools")}${link("health", "Health")}</nav>`;
}

export function dashboardPage(input: { data: DashboardData; spend: SpendView; login: string; signOut: boolean; abuse?: AbuseData; csrf?: string; starters?: { rows: StarterRow[]; total: number } }): Response {
  const { data, spend } = input;
  const currentWeek = data.currentWeek;
  const thisOrDate = (week: number) => (week === currentWeek ? `${day(week)} (this week)` : day(week));
  const state = freeTierState(spend);
  const warnings = creditWarnings(spend);
  const banner = warnings.length > 0 ? `<p class="banner" role="alert">${warnings.map(escapeHtml).join(" ")}</p>` : "";
  const queue = queueStart(spend, data);

  const totals = spendTotals(spend);
  const providers = creditProviders(spend);
  const route = routes(spend);
  const providerRow = (row: ReturnType<typeof creditProviders>[number]) => {
    const serves = row.id === "openai" ? modelNames("openai") : `${modelNames("luminal")}; the GPT-6 fallback`;
    const budget = row.weeklyBudgetUsd === null ? "" : ` <span class="muted">free ${usd(row.freeWeekUsd)} of ${usd(row.weeklyBudgetUsd)} budget</span>`;
    return `<tr><td>${row.name}${row.configured ? "" : ` <span class="muted">(no key)</span>`}</td><td class="l wrap">${escapeHtml(serves)}</td><td class="used">${usd(row.usedUsd)} <span class="muted">of ${usd(row.balanceUsd)}</span>${meter(row.usedUsd, row.balanceUsd, `${row.name} credit used against the balance`)}</td><td>${usd(row.weekUsd)}${budget}</td><td>${usd(Math.max(0, row.balanceUsd - row.usedUsd))}</td></tr>`;
  };
  const meteredRow = `<tr><td>OpenRouter <span class="muted">(older, metered)</span></td><td class="l wrap">${route.deepseek === "OpenRouter" ? "DeepSeek, now" : "Nothing now; DeepSeek only when routed there"}</td><td>${usd(totals.meteredAllTimeUsd)} <span class="muted">cash, no balance</span></td><td>${usd(totals.meteredWeekUsd)}</td><td>–</td></tr>`;
  const creditNames = providers.map((row) => `${row.name} ${usd(row.usedUsd)}`).join(" + ");
  const budgetSection = `<section id="budget">
<div class="head"><h2>Spend</h2>${csvLink("spend")}</div>
<div class="tiles">
<div class="tile lead">Spent, all time<b>${usd(totals.allTimeUsd)}</b><span class="note">${creditNames} + ${usd(totals.meteredAllTimeUsd)} older metered OpenRouter spend, from before prepaid credit. Admins and paid plans included.</span></div>
<div class="tile lead">Spent this week<b>${usd(totals.weekUsd)}</b><span class="note">${providers.map((row) => `${row.name} ${usd(row.weekUsd)}`).join(" + ")}${totals.meteredWeekUsd > 0 ? ` + OpenRouter ${usd(totals.meteredWeekUsd)}` : ""}, since ${escapeHtml(day(currentWeek))}. Resets ${escapeHtml(weekday(spend.resetsAt))} 00:00 UTC.</span></div>
<div class="tile lead">Waiting line starts at<b>${queue.startUsd === null ? "–" : `${usd(queue.startUsd)} <span class="muted">a week</span>`}</b><span class="note">${
    queue.startUsd === null
      ? ""
      : `New open sign-ups get an account but wait in line for free tokens once this week's free Luminal credit spend (${usd(queue.watchedUsd)} so far) reaches this: ${escapeHtml(percent(spend.queueThreshold))} of the ${usd(queue.budgetUsd)} ${escapeHtml(queue.provider ?? "")} weekly credit budget. Invites skip the line; Mondays let it in as far as the budget allows. `
  }${escapeHtml(queue.text)}${spend.weeklyCapUsd === null ? "" : ` Free OpenRouter cash past ${usd(spend.queueThreshold * spend.weeklyCapUsd)} this week also starts it.`}</span></div>
<div class="tile">State<b class="state">${escapeHtml(state)}</b><span class="note">${escapeHtml(admissionText(spend, data.people.admitted))} Per person: ${escapeHtml(tokens(spend.weeklyTokens))} tokens or ${escapeHtml(cap(spend.perPersonWeeklyUsd))} a week.</span></div>
</div>
<h3>By provider</h3>
<div class="scroll"><table>
<thead><tr><th class="l">Provider</th><th class="l">Serves</th><th>Used / balance</th><th>This week</th><th>Left</th></tr></thead>
<tbody>
${providers.map(providerRow).join("\n")}
${meteredRow}
</tbody></table></div>
<p class="note">Effective values, with admin overrides applied. Credit is each provider's prepaid credit at its list prices; admins and paid plans count against it. "Free" is usage outside admins and paid plans, what the weekly budgets and the waiting line watch.</p>
</section>`;

  const UPSTREAM_NAMES_SHOWN = { openai: "OpenAI", luminal: "Luminal", openrouter: "OpenRouter" } as const;
  type UpstreamRowData = DashboardData["upstreamTotals"][number] & Partial<Pick<DashboardData["upstreams"][number], "medianTtftMs" | "p90TtftMs" | "medianTtfbMs">>;
  const upstreamRow = (label: string, row: UpstreamRowData, total = false) => {
    const cells = [
      escapeHtml(label),
      count(row.requests),
      `${count(row.errors)}${row.requests > 0 ? ` <span class="muted">(${percent(row.errors / row.requests)})</span>` : ""}`,
      ms(row.medianTtftMs ?? null),
      ms(row.p90TtftMs ?? null),
      ms(row.medianTtfbMs ?? null),
      row.users === null ? "–" : count(row.users),
      compact(row.promptTokens),
      compact(row.cachedTokens),
      compact(row.completionTokens),
      row.cacheHitShare === null ? "–" : percent(row.cacheHitShare),
      usd(row.creditUsd),
      usd(row.cashUsd),
    ];
    // The Total row: bold, with a rule above it.
    return `<tr${total ? ` class="group sel"` : ""}>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
  };
  const upstreamTable = (window: "today" | "week" | "all_time") => {
    const heading =
      window === "today" ? "Today (UTC)" : window === "week" ? `This week, since ${escapeHtml(day(currentWeek))}` : `All time${data.upstreamsSince === null ? "" : `, since ${escapeHtml(day(data.upstreamsSince))}`}`;
    const total = data.upstreamTotals.find((row) => row.window === window);
    return `<div class="scroll"><table>
<thead><tr><th>${heading}</th><th>Requests</th><th>Errors</th><th>TTFT median</th><th>TTFT p90</th><th>TTFB median</th><th>Users</th><th>Tokens in</th><th>Cached</th><th>Tokens out</th><th>Cache hits</th><th>Credit</th><th>Cash</th></tr></thead>
<tbody>
${data.upstreams
  .filter((row) => row.window === window)
  .map((row) => upstreamRow(UPSTREAM_NAMES_SHOWN[row.upstream], row))
  .join("\n")}
${total ? upstreamRow("Total", total, true) : ""}
</tbody></table></div>`;
  };
  const upstreamSection = `<section id="upstream">
<div class="head"><h2>Upstreams</h2>${csvLink("upstreams")}</div>
<div class="tiles">
<div class="tile lead">GPT-6 models go to<b class="state">${escapeHtml(route.gpt)}</b><span class="note">Each model goes to its own provider. GPT-6 falls back to DeepSeek on Luminal when OpenAI fails or its credit runs out.</span></div>
<div class="tile lead">DeepSeek goes to<b class="state">${escapeHtml(route.deepseek)}</b><span class="note">${route.deepseek === "nowhere" ? "No provider can serve DeepSeek: set LUMINAL_API_KEY, or route it to OpenRouter." : "Luminal, unless the routing setting below says OpenRouter or Luminal has no key."}</span></div>
</div>
${upstreamSwitch(spend, input.csrf)}
${upstreamTable("today")}
${upstreamTable("week")}
${upstreamTable("all_time")}
<p class="note">Admins included, except in Users: the distinct people each upstream served (the Total counts each person once). Tokens in are prompt tokens, cached ones included; Cached is how many of them were cache hits; tokens out are completion tokens. All time has no timings: they're kept 15 days. TTFT: time to the first content chunk (text, reasoning or a tool call); TTFB: time to the response headers. Errors: 429, 5xx, timeouts, unreachable and failed streams. Credit is the provider's prepaid credit (OpenAI or Luminal) at its list prices; cash is OpenRouter's reported cost, when OpenRouter serves.</p>
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

  const dailyRetentionSection = `<section id="retention-daily">
<div class="head"><h2>Daily retention</h2>${csvLink("retention-daily")}</div>
<div class="scroll"><table>
<thead><tr><th>Signed up (UTC)</th><th>People</th>${RETENTION_DAYS.map((offset) => `<th>D${offset}</th>`).join("")}</tr></thead>
<tbody>
${
  data.dailyCohorts.length === 0
    ? `<tr><td colspan="${2 + RETENTION_DAYS.length}" class="l muted">No sign-ups yet.</td></tr>`
    : data.dailyCohorts
        .map(
          (cohort) =>
            `<tr><td>${escapeHtml(weekday(cohort.day))}</td><td>${count(cohort.size)}</td>${cohort.retained
              .map((cell) => (cell ? `<td title="${cell.active} of ${cohort.size}">${percent(cell.share)} <span class="muted">(${cell.active})</span></td>` : `<td class="muted">–</td>`))
              .join("")}</tr>`,
        )
        .join("\n")
}
</tbody></table></div>
<p class="note">${retentionAverages(data.dailyCohorts)} People grouped by the UTC day they were admitted (the last ${DAILY_COHORTS} days with sign-ups; admins and blocked accounts left out); the share who made at least one request on day N after it. A day shows – until it has ended (UTC).</p>
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
${f.failedSteps.length === 0 ? `<tr><td colspan="2" class="l muted">No failed installs.</td></tr>` : f.failedSteps.map((row) => `<tr><td>${escapeHtml(stepLabel(row.step))}</td><td>${count(row.failed)}</td></tr>`).join("\n")}
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
<p class="serving"><span>Each model goes to its own provider:</span><span>GPT-6 → <strong>${escapeHtml(route.gpt)}</strong></span><span>DeepSeek → <strong>${escapeHtml(route.deepseek)}</strong></span><a href="#upstream">Routing</a></p>
<p class="lede">${count(data.people.admitted)} people admitted, ${count(data.people.activeThisWeek)} active this week. Admins are left out of every number but spend. Updated ${escapeHtml(new Date(data.now).toISOString().slice(0, 16).replace("T", " "))} UTC. Counts, tokens, cost and times only.</p>`;

  const abuse = input.abuse ? abuseSection(input.abuse, input.csrf) : "";
  const log = input.abuse ? adminLogSection(input.abuse) : "";
  const starters = input.starters ? startersSection(input.starters.rows, input.starters.total) : "";
  return shell(`Admin · ${PRODUCT_NAME}`, [header, banner, budgetSection, abuse, upstreamSection, queueSection, referralSection, paidSection, funnelSection, activeSection, retentionSection, dailyRetentionSection, costSection, limitsSection, starters, log].join("\n"));
}

// ─── The simple view ──────────────────────────────────────────────────────

/**
 * The simple view's stylesheet: a desktop admin app's cards (white panels with a 1px border,
 * 10px radius, bold numbers over small muted labels) in the dl tokens, light and dark. Charts
 * come in two drawings, wide and narrow, so their text stays the same size on a phone.
 */
export const SIMPLE_STYLE = `${BRAND_TOKENS}
:root {
  --k-bg: #F9FAFB; --k-card: #FFFFFF; --k-text: #111827; --k-muted: #6B7280; --k-faint: #9CA3AF; --k-border: #E5E7EB; --k-axis: #D1D5DB;
  --k-shadow: 0 1px 2px 0 rgb(0 0 0 / .04); --k-up: #047857; --k-down: #B91C1C; --k-flag: #B45309; --k-flag-bg: rgba(245, 158, 11, .1);
  --k-ok: #047857; --k-ok-bg: rgba(16, 185, 129, .1); --k-stop: #B91C1C; --k-stop-bg: rgba(239, 68, 68, .09);
  --c-1: #2A78D6; --c-2: #EB6834; --c-3: #1A9C7B;
}
@media (prefers-color-scheme: dark) {
  :root {
    --k-bg: #0B0E12; --k-card: #161A21; --k-text: #E6E9EE; --k-muted: #8A919E; --k-faint: #646B78; --k-border: #262B34; --k-axis: #3A404B;
    --k-shadow: none; --k-up: #34D399; --k-down: #F87171; --k-flag: #FBBF24; --k-flag-bg: rgba(251, 191, 36, .1);
    --k-ok: #34D399; --k-ok-bg: rgba(52, 211, 153, .12); --k-stop: #F87171; --k-stop-bg: rgba(248, 113, 113, .12);
    --c-1: #3987E5; --c-2: #D95926; --c-3: #2BB592;
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
.span3 { grid-column: 1 / -1; }
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
svg.chart .c3 { fill: var(--c-3); }
svg.chart .cell { fill: var(--k-card); }
svg.chart text.on { fill: #FFFFFF; font-weight: 600; }
svg.chart.narrow text.on { font-weight: 500; }
svg.chart.heat.narrow text.who, svg.chart.heat.narrow text.v { font-size: 11px; }
svg.chart text.in { fill: var(--k-text); }
svg.chart text.h { fill: var(--k-muted); font-weight: 600; }
svg.chart.heat.wide { max-width: 1000px; }
.avg { margin: 14px 0 0; font-size: 13px; color: var(--k-muted); }
.caption { margin: -4px 0 12px; font-size: 13px; color: var(--k-muted); }
.sub { margin: 20px 0 8px; font-size: 14px; font-weight: 600; color: var(--k-text); }
.funnel { display: grid; max-width: 36rem; font-size: 13px; font-variant-numeric: tabular-nums; }
.funnel > div { display: grid; grid-template-columns: minmax(3.5rem, 1.2fr) repeat(4, minmax(0, 1fr)); gap: 6px; padding: 5px 0; border-bottom: 1px solid var(--k-border); align-items: end; }
.funnel span { text-align: right; min-width: 0; }
.funnel span:first-child { text-align: left; }
.funnel .fh span { color: var(--k-muted); font-weight: 600; font-size: 12px; line-height: 1.25; }
.avg b { color: var(--k-text); font-variant-numeric: tabular-nums; }
.avg .muted { color: var(--k-faint); }
.legend { display: flex; gap: 16px; margin: 0 0 12px; font-size: 12px; color: var(--k-muted); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
.legend i.c1 { background: var(--c-1); }
.legend i.c2 { background: var(--c-2); }
.legend i.c3 { background: var(--c-3); }
.flags { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.flags li { display: flex; gap: 10px; align-items: baseline; padding: 9px 12px; border-radius: 8px; background: var(--k-flag-bg); font-size: 13.5px; line-height: 1.35; }
.flags li::before { content: "!"; flex: none; width: 16px; height: 16px; border-radius: 50%; background: var(--k-flag); color: var(--k-card); font: 700 11px/16px var(--body); text-align: center; transform: translateY(2px); }
.flags a { text-decoration: none; }
.flags a:hover { text-decoration: underline; }
.none { color: var(--k-muted); margin: 0; }
.empty { color: var(--k-muted); margin: 8px 0 0; }
@media (max-width: 1100px) { main { grid-template-columns: minmax(0, 1fr); } .span2, .span3 { grid-column: auto; } .growth { grid-template-columns: 1fr 1fr; } }
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
export function barPath(x: number, y: number, width: number, height: number, horizontal = false): string {
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
    const level = row.level === "starter" ? "Starter" : row.level === "basic" ? "Basic" : "Full";
    const colour = row.level === "starter" ? "c2" : row.level === "basic" ? "c3" : "c1";
    return `<g><title>${escapeHtml(`${name}: ${tokens(row.tokens)} tokens this week (${level})`)}</title><rect class="hit" x="0" y="${y}" width="${width}" height="${rowHeight}"></rect><text class="who" x="${labelWidth - 10}" y="${y + rowHeight / 2 + 4}" text-anchor="end">${escapeHtml(shown)}</text><path class="${colour}" d="${barPath(labelWidth, y + (rowHeight - barHeight) / 2, w, barHeight, true)}"></path>${
      index === 0 ? `<text class="v" x="${(labelWidth + w + 6).toFixed(1)}" y="${y + rowHeight / 2 + 4}">${escapeHtml(tokens(row.tokens))}</text>` : ""
    }</g>`;
  });
  return `<svg class="chart ${kind}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Tokens used this week per person, top ${rows.length}">
<line class="axis" x1="${labelWidth - 0.5}" x2="${labelWidth - 0.5}" y1="0" y2="${height}"></line>
${parts.join("\n")}
</svg>`;
}

/** A cell's label: whole percents ("8%", "<1%"), so it fits a narrow cell; the tooltip has the exact share. */
function wholePercent(share: number): string {
  return share > 0 && share < 0.005 ? "<1%" : `${Math.round(share * 100)}%`;
}

/** Cell colour: one hue, more opaque for a higher share (square root, so small shares still differ). */
function heatOpacity(share: number): number {
  return 0.08 + 0.92 * Math.sqrt(Math.max(0, Math.min(1, share)));
}

/**
 * The retention triangle: one row per sign-up day (newest at the top) with its size, one cell per
 * day after it with the share who made a request, coloured by that share; days still to come are
 * left blank. The narrow drawing drops the last column (D14) when there are more than eight.
 */
function retentionChart(cohorts: readonly DailyCohort[], width: number, kind: "wide" | "narrow"): string {
  const wide = kind === "wide";
  const offsets = wide || RETENTION_DAYS.length <= 8 ? [...RETENTION_DAYS] : RETENTION_DAYS.slice(0, 8);
  const labelWidth = wide ? 110 : 42;
  const sizeWidth = wide ? 64 : 30;
  const lead = wide ? 14 : 4;
  // A wider gap before a column that isn't the next day (D14 after D7).
  const breaks = offsets.filter((offset, index) => index > 0 && offset !== offsets[index - 1]! + 1).length;
  const breakGap = wide ? 10 : 6;
  const gap = 2;
  const cellWidth = (width - labelWidth - sizeWidth - lead - breaks * breakGap) / offsets.length;
  const cellHeight = wide ? 30 : 24;
  const header = 22;
  const height = header + cohorts.length * (cellHeight + gap);
  const font = wide ? 12 : 10;
  const columnX: number[] = [];
  let x = labelWidth + sizeWidth + lead;
  offsets.forEach((offset, index) => {
    if (index > 0 && offset !== offsets[index - 1]! + 1) x += breakGap;
    columnX.push(x);
    x += cellWidth;
  });
  const head = `<text class="h" x="0" y="${header - 8}">${wide ? "Signed up" : "Day"}</text><text class="h" x="${labelWidth + sizeWidth - 6}" y="${header - 8}" text-anchor="end">${wide ? "People" : "N"}</text>${offsets
    .map((offset, index) => `<text class="h" x="${(columnX[index]! + cellWidth / 2).toFixed(1)}" y="${header - 8}" text-anchor="middle">D${offset}</text>`)
    .join("")}`;
  const rows = cohorts.map((cohort, row) => {
    const y = header + row * (cellHeight + gap);
    const middle = (y + cellHeight / 2 + font * 0.36).toFixed(1);
    const name = monthDay(cohort.day);
    const cells = offsets.map((offset, index) => {
      const cell = cohort.retained[RETENTION_DAYS.indexOf(offset)];
      if (!cell) return "";
      const opacity = heatOpacity(cell.share);
      const cx = columnX[index]!;
      return `<g><title>${escapeHtml(`${name} · ${count(cohort.size)} ${cohort.size === 1 ? "person" : "people"} · D${offset} ${percent(cell.share)} (${count(cell.active)})`)}</title><rect class="c1" x="${(cx + gap / 2).toFixed(1)}" y="${y}" width="${(cellWidth - gap).toFixed(1)}" height="${cellHeight}" rx="3" fill-opacity="${opacity.toFixed(3)}"></rect><text class="${opacity > 0.62 ? "on" : "in"}" x="${(cx + cellWidth / 2).toFixed(1)}" y="${middle}" text-anchor="middle" font-size="${font}">${escapeHtml(wholePercent(cell.share))}</text></g>`;
    });
    return `<g><g><title>${escapeHtml(`${name} · ${count(cohort.size)} ${cohort.size === 1 ? "person" : "people"}`)}</title><rect class="hit" x="0" y="${y}" width="${labelWidth + sizeWidth}" height="${cellHeight}"></rect><text class="who" x="0" y="${middle}">${escapeHtml(name)}</text><text class="v" x="${labelWidth + sizeWidth - 6}" y="${middle}" text-anchor="end">${count(cohort.size)}</text></g>${cells.join("")}</g>`;
  });
  return `<svg class="chart heat ${kind}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Retention by sign-up day: share active on days ${offsets.join(", ")} after signing up">
${head}
${rows.join("\n")}
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
  const allowance = (level: string | null) => (level === "starter" ? spend.starterWeeklyTokens : level === "basic" ? spend.basicWeeklyTokens : spend.weeklyTokens);
  const near = simple.topTokens.filter((row) => !hitIds.has(row.githubId) && row.tokens >= BANNER_SHARE * allowance(row.level));
  const capped = [...hits.map((hit) => label(hit.login, hit.githubId)), ...near.map((row) => label(row.login, row.githubId))];
  if (capped.length > 0) flags.push({ text: `Near weekly cap: ${names(capped)}`, href: "/admin?view=full#limits" });
  // Free tokens used from another tool: requests, but not one session event from Autopilot.
  if (simple.outsideDl.length > 0) {
    flags.push({ text: `Used outside dl: ${names(simple.outsideDl.map((row) => `${label(row.login, row.githubId)} (${count(row.requests)} requests, 0 dl sessions)`))}`, href: "/admin?view=full#abuse" });
  }
  // Starter accounts using a lot: half their week or more, not already listed at the cap.
  const busyStarters = simple.topTokens.filter((row) => row.level === "starter" && spend.starterWeeklyTokens > 0 && !hitIds.has(row.githubId) && !near.includes(row) && row.tokens >= 0.5 * spend.starterWeeklyTokens);
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

/** Sign-up days shown in the Simple view's funnel. */
const FUNNEL_TABLE_DAYS = 7;

/** The sign-up funnel per day, newest first: signed up, got tokens, refused, refused but opened dl. Compact for a phone. */
function signupFunnelTable(rows: DashboardData["signupFunnel"]): string {
  if (rows.length === 0) return "";
  const cell = (text: string, role = "cell") => `<span role="${role}">${escapeHtml(text)}</span>`;
  const body = rows
    .slice(0, FUNNEL_TABLE_DAYS)
    .map((row) => `<div role="row">${cell(monthDay(row.day), "rowheader")}${cell(count(row.signedUp))}${cell(count(row.gotTokens))}${cell(count(row.refused))}${cell(count(row.refusedOpened))}</div>`)
    .join("");
  return `<h3 class="sub">Sign-ups by day</h3>
<div class="funnel" role="table" aria-label="Sign-ups by day: signed up, got free tokens, refused, refused but opened dl that day">
<div role="row" class="fh">${cell("Day", "columnheader")}${cell("Signed up", "columnheader")}${cell("Got tokens", "columnheader")}${cell("Refused", "columnheader")}${cell("Refused, opened dl", "columnheader")}</div>
${body}
</div>
<p class="avg">Opened dl: a dl session or a refused request on the sign-up day (UTC).</p>`;
}

/**
 * GET /admin?view=simple: five cards readable in a few seconds. Sign-ups per day with the total,
 * week-over-week growth, tokens this week per person by level, red flags when there are any, and
 * retention by sign-up day.
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
    : `<div class="legend"><span><i class="c1"></i>Full</span><span><i class="c3"></i>Basic</span><span><i class="c2"></i>Starter</span></div>
${tokenChart(simple.topTokens, 800, "wide")}
${tokenChart(simple.topTokens, 320, "narrow")}`
}
</section>`;

  const flags = redFlags(data, spend, simple, input.abuse);
  const flagCard = `<section class="card" id="flags" aria-label="Red flags">
<h2>Red flags</h2>
${flags.length === 0 ? `<p class="none">No red flags.</p>` : `<ul class="flags">\n${flags.map((flag) => `<li><a href="${flag.href}">${escapeHtml(flag.text)}</a></li>`).join("\n")}\n</ul>`}
</section>`;

  const retentionCard = `<section class="card span3" id="retention" aria-label="Retention">
<h2>Retention</h2>
<p class="caption">Counts only people who could use dl: they had free tokens at sign-up (Full, Basic, an admin's grant, or a Starter allowance). People refused free tokens are in the funnel below.</p>
${
  data.dailyCohorts.length === 0
    ? `<p class="empty">No sign-ups with free tokens yet.</p>`
    : `${retentionChart(data.dailyCohorts, 1000, "wide")}
${retentionChart(data.dailyCohorts, 320, "narrow")}
<p class="avg">${retentionAverages(data.dailyCohorts)}</p>`
}
${signupFunnelTable(data.signupFunnel)}
</section>`;

  return shell(`Admin · ${PRODUCT_NAME}`, `${header}\n<main>\n${signups}\n${growthCard}\n${tokenCard}\n${flagCard}\n${retentionCard}\n</main>`, 200, {}, "", SIMPLE_STYLE);
}

// ─── Tools ────────────────────────────────────────────────────────────────

/** What the Tools tab shows: the forms as posted, and what the last button did. */
export interface ToolsState {
  login: string;
  signOut: boolean;
  /** Only with a browser session: the forms need it. A bearer view shows no forms. */
  csrf?: string;
  /** The admin's own contact email: where "send me a test" goes when no address is typed. */
  adminEmail: string | null;
  /** The userEmails setting; sending is refused while it's off (a test still goes). */
  emailsOn: boolean;
  provider: string | null;
  /** Sign-up days, newest first, with the people a broadcast can reach at each level. */
  cohorts: Array<{ day: number; full: number; basic: number; starter: number }>;
  grant: { text: string; results?: GrantResult[]; error?: string };
  /** The grantWeeklyUsdCap setting: the grant forms' default weekly dollar cap (0: Full only). */
  grantUsd: number;
  /** Pending access requests (/request in dl), newest first. `building` and `link` are user content. */
  requests: PendingAccessRequest[];
  /** What the last Grant or Decline did. */
  requestNotice?: { error: boolean; text: string };
  /** GPU early-access leads, newest first: emails people chose to leave (user content, escaped). */
  leads: EarlyAccessLead[];
  /** What the last "delete a lead" did. */
  leadNotice?: { error: boolean; text: string };
  /** What the last "re-check below-bar accounts" did. */
  recheck?: { checked: number; raised: number; flagged: number; starter: number };
  /** The email being written. */
  compose: {
    subject: string;
    text: string;
    audience: BroadcastAudience;
    /** "YYYY-MM-DD" or "" for no bound; both inclusive. */
    from: string;
    to: string;
    testTo: string;
    notice?: { error: boolean; text: string };
    preview?: { count: number; waitingForTomorrow: number; sample: string[] };
    /** The token that lets "yes, send" (and "send the rest") through for this copy and audience. */
    confirm?: string;
    /** Show the in-page confirm step. */
    confirming?: boolean;
    sent?: { sent: number; failed: number; remaining: number; waitingForTomorrow: number; stoppedBy: string | null };
  };
}

/** The simple view's look, plus forms: fields at 16px so a phone doesn't zoom in on them. */
const TOOLS_STYLE = `${SIMPLE_STYLE}
main.tools { max-width: 46rem; grid-template-columns: minmax(0, 1fr); }
.card h2 { color: var(--k-text); font-size: 17px; margin: 0 0 4px; }
.card .lede { margin: 0 0 14px; color: var(--k-muted); font-size: 13.5px; }
.tools form { display: grid; gap: 14px; margin: 0; }
.field { display: grid; gap: 6px; }
.field > span, legend { font-size: 13px; font-weight: 600; color: var(--k-muted); }
fieldset { border: 0; margin: 0; padding: 0; display: grid; gap: 8px; min-width: 0; }
legend { padding: 0; margin-bottom: 6px; }
input[type="text"], input[type="email"], input[type="date"], textarea {
  width: 100%; font: 16px/1.45 var(--body); color: var(--k-text); background: var(--k-card);
  border: 1px solid var(--k-border); border-radius: 8px; padding: 9px 11px; margin: 0;
}
input[type="date"] { min-height: 42px; min-width: 0; max-width: 100%; display: block; -webkit-appearance: none; appearance: none; }
.dates .field { min-width: 0; }
textarea { resize: vertical; min-height: 6rem; }
textarea.letter { min-height: 14rem; }
input:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.usd-in { display: inline-flex; align-items: center; gap: 6px; font-size: 14px; color: var(--k-muted); }
.usd-in input { width: 6.5rem; font: 16px/1.45 var(--body); color: var(--k-text); background: var(--k-card); border: 1px solid var(--k-border); border-radius: 8px; padding: 8px 10px; margin: 0; min-height: 40px; }
.usd-in input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.dates { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; }
.btn { font: 600 14px var(--body); padding: 9px 14px; border-radius: 8px; border: 1px solid var(--k-border); background: var(--k-card); color: var(--k-text); cursor: pointer; min-height: 40px; }
.btn:hover { border-color: var(--k-muted); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #FFFFFF; }
.btn.quiet { border-color: transparent; color: var(--k-muted); padding-left: 6px; padding-right: 6px; }
.btn:disabled { opacity: .5; cursor: default; }
.seg { display: inline-flex; gap: 4px; background: var(--k-bg); border: 1px solid var(--k-border); border-radius: 8px; padding: 3px; flex-wrap: wrap; }
.seg label { position: relative; }
.seg input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; }
.seg span { display: block; padding: 6px 14px; border-radius: 6px; font-size: 14px; font-weight: 500; color: var(--k-muted); }
.seg input:checked + span { background: var(--k-text); color: var(--k-card); }
.seg input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 1px; }
.days { display: grid; grid-template-columns: repeat(auto-fill, minmax(8.5rem, 1fr)); gap: 6px; }
.day { text-align: left; font: 13px/1.3 var(--body); padding: 7px 10px; border-radius: 8px; border: 1px solid var(--k-border); background: var(--k-card); color: var(--k-text); cursor: pointer; display: grid; gap: 1px; }
.day b { font-weight: 600; }
.day small { color: var(--k-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.day[aria-pressed="true"] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.hint { margin: 0; font-size: 12.5px; color: var(--k-muted); }
.caps { margin: 0; font-size: 12.5px; color: var(--k-flag); }
.msg { margin: 0; padding: 10px 12px; border-radius: 8px; font-size: 14px; background: var(--k-ok-bg); color: var(--k-text); }
.msg.err { background: var(--k-stop-bg); }
.msg.flag { background: var(--k-flag-bg); }
.panel { border: 1px solid var(--k-border); border-radius: 10px; padding: 14px; display: grid; gap: 10px; background: var(--k-bg); }
.panel.confirm { border-color: var(--accent); }
.panel p { margin: 0; }
.big2 { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
.nums { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 0; }
.nums div { display: grid; gap: 2px; }
.nums dt { font-size: 12px; color: var(--k-muted); }
.nums dd { margin: 0; font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
.results { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.results li { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 2px 10px; padding: 7px 10px; border-radius: 8px; background: var(--k-bg); font-size: 14px; }
.results code { font: 13.5px var(--mono); overflow-wrap: anywhere; }
.chip { font-size: 12.5px; font-weight: 600; }
.chip.ok { color: var(--k-ok); }
.chip.no { color: var(--k-stop); }
.chip.mid { color: var(--k-muted); }
.reqs { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.req { border: 1px solid var(--k-border); border-radius: 10px; padding: 12px 14px; display: grid; gap: 6px; background: var(--k-bg); min-width: 0; }
.req p { margin: 0; }
.req-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 2px 10px; align-items: baseline; }
.req-head a { color: var(--k-text); text-decoration: none; }
.req-head code { font: 600 14px var(--mono); overflow-wrap: anywhere; }
.req-text { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; }
.req-link { font-size: 13.5px; overflow-wrap: anywhere; }
.req-link a { color: var(--accent); }
.req-actions { display: grid; gap: 8px; margin-top: 4px; }
.leads-wrap { overflow-x: auto; }
.leads { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.leads th, .leads td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--k-border); white-space: nowrap; }
.leads th { font-size: 12px; font-weight: 600; color: var(--k-muted); }
.leads td.num { text-align: right; font-variant-numeric: tabular-nums; }
.leads code { font: 13px var(--mono); }
textarea.emails { font: 13px/1.5 var(--mono); min-height: 4rem; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (max-width: 520px) { .nums { grid-template-columns: repeat(2, minmax(0, 1fr)); } .actions .btn { flex: 1 1 auto; } }
`;

const GRANT_TONE: Record<GrantResult["outcome"], "ok" | "no" | "mid"> = {
  granted: "ok",
  already_full: "mid",
  pregranted: "ok",
  blocked: "no",
  not_found: "no",
  github_error: "no",
};

function plural(n: number, one: string, many = `${one}s`): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}

/**
 * The grant forms' weekly dollar cap: a small number field, prefilled with the
 * grantWeeklyUsdCap setting. Shared with the home screen's request cards.
 */
export function grantUsdInput(defaultUsd: number, label = "Weekly dollar cap"): string {
  return `<label class="usd-in"><span class="sr">${escapeHtml(label)}</span>$<input type="number" name="usd" min="0" max="${MAX_GRANT_USD}" step="any" inputmode="decimal" value="${escapeHtml(String(defaultUsd))}"> a week</label>`;
}

/** "own cap $20 a week": a person's personal weekly dollar cap, for the admin lists. */
export function ownCapText(usd: number): string {
  return `own cap ${grantUsdText(usd)} a week`;
}

function grantCard(state: ToolsState): string {
  const { grant, csrf } = state;
  const results = grant.results
    ? `<ul class="results" aria-label="Results">${grant.results
        .map(
          (result) =>
            `<li><code>${escapeHtml(result.login ?? result.input)}</code><span class="chip ${GRANT_TONE[result.outcome]}">${escapeHtml(GRANT_LABELS[result.outcome])}</span>${result.usdPerWeek !== undefined ? `<span class="hint">${escapeHtml(ownCapText(result.usdPerWeek))}</span>` : ""}</li>`,
        )
        .join("")}</ul>`
    : "";
  return `<section class="card" id="grant" aria-label="Give free tokens">
<h2>Give free tokens</h2>
<p class="lede">Full level for these GitHub accounts, as an admin's choice, with their own weekly dollar cap. Someone who hasn't signed up yet gets both at their first sign-up. Blocked accounts are left alone.</p>
${
  csrf
    ? `<form method="post" action="/admin/dashboard/tools#grant">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="tool" value="grant">
<label class="field"><span>GitHub usernames</span><textarea name="logins" rows="3" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="octocat, @hubot&#10;github.com/someone">${escapeHtml(grant.text)}</textarea></label>
<p class="hint">Separated by spaces, commas or new lines; @name and github.com links work. Up to ${MAX_GRANT_LOGINS} at a time.</p>
<div class="field"><span>Weekly dollar cap</span><div class="row">${grantUsdInput(state.grantUsd)}</div></div>
<p class="hint">Their own cap each week, e.g. $3 for a hobbyist, $20 for a serious builder. It never lowers a higher cap they already have; 0 gives Full only.</p>
<div class="row"><button class="btn primary" type="submit">Give free tokens</button></div>
${grant.error ? `<p class="msg err" role="alert">${escapeHtml(grant.error)}</p>` : ""}
${results}
</form>`
    : `<p class="hint">Sign in at /admin in a browser to use this.</p>`
}
</section>`;
}

/** "https://example.com/x" shown as text with a link; anything that isn't http(s) as text only. */
function requestLink(link: string | null): string {
  if (!link) return "";
  const safe = /^https?:\/\//i.test(link);
  return safe
    ? `<p class="req-link"><a href="${escapeHtml(link)}" rel="noopener noreferrer nofollow" target="_blank">${escapeHtml(link)}</a></p>`
    : `<p class="req-link">${escapeHtml(link)}</p>`;
}

/** Days, rounded down: "3 years", "200 days". */
function ageText(days: number | null): string {
  if (days === null) return "age unknown";
  return days >= 730 ? `${Math.floor(days / 365)} years` : `${count(days)} days`;
}

/**
 * Pending access requests, newest first: who, their level and numbers, what they're building
 * (user content, escaped), and Grant (Full, as an admin's choice) or Decline with an optional note.
 */
function requestsCard(state: ToolsState): string {
  const { csrf, requests } = state;
  const notice = state.requestNotice ? `<p class="msg${state.requestNotice.error ? " err" : ""}" role="${state.requestNotice.error ? "alert" : "status"}">${escapeHtml(state.requestNotice.text)}</p>` : "";
  const items = requests.map((request) => {
    const level = request.level === null ? "not signed up" : request.level === "basic" ? "Basic" : request.level === "starter" ? "Starter" : "Full";
    const facts = [level, ageText(request.accountAgeDays), `${request.contributions === null ? "–" : count(request.contributions)} contributions`, plural(request.sessionsThisWeek, "dl session") + " this week"];
    if (request.personalUsdPerWeek !== null) facts.push(ownCapText(request.personalUsdPerWeek));
    const actions = csrf
      ? `<form method="post" action="/admin/dashboard/tools#requests" class="req-actions">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="tool" value="request"><input type="hidden" name="id" value="${request.id}">
<label class="field"><span class="sr">Note (optional)</span><input type="text" name="note" maxlength="300" placeholder="Note (optional, only you see it)" autocomplete="off"></label>
<div class="row">${grantUsdInput(state.grantUsd, `Weekly dollar cap for ${request.login}`)}<button class="btn primary" type="submit" name="action" value="grant">Grant</button><button class="btn" type="submit" name="action" value="decline">Decline</button></div>
</form>`
      : "";
    return `<li class="req">
<div class="req-head"><a href="https://github.com/${encodeURIComponent(request.login)}" rel="noopener noreferrer nofollow" target="_blank"><code>@${escapeHtml(request.login)}</code></a><span class="hint">${escapeHtml(when(request.at))}</span></div>
<p class="hint">${facts.map(escapeHtml).join(" · ")}</p>
<p class="req-text">${escapeHtml(request.building)}</p>
${requestLink(request.link)}
${actions}
</li>`;
  });
  return `<section class="card" id="requests" aria-label="Requests">
<h2>Requests</h2>
<p class="lede">People asking for free tokens from inside dl (/request). Grant gives Full, as an admin's choice, with the weekly dollar cap next to it, and emails them; Decline sends nothing.</p>
${notice}
${requests.length === 0 ? `<p class="hint">No pending requests.</p>` : `<ul class="reqs">${items.join("\n")}</ul>`}
${csrf ? "" : `<p class="hint">Sign in at /admin in a browser to answer them.</p>`}
</section>`;
}

/** "Re-check below-bar accounts": raises qualifying Starter accounts to basic from stored signals. */
function recheckCard(state: ToolsState): string {
  const { csrf, recheck } = state;
  const result = recheck
    ? `<div class="panel" role="status"><dl class="nums"><div><dt>Checked</dt><dd>${count(recheck.checked)}</dd></div><div><dt>Raised to Basic</dt><dd>${count(recheck.raised)}</dd></div><div><dt>Starter</dt><dd>${count(recheck.starter)}</dd></div><div><dt>Batch-flagged</dt><dd>${count(recheck.flagged)}</dd></div></dl></div>`
    : "";
  return `<section class="card" id="recheck" aria-label="Re-check below-bar accounts">
<h2>Re-check below-bar accounts</h2>
<p class="lede">Looks at every active Starter account (not admins, not admin-set levels) from its stored signals, raises the ones that now qualify to Basic, and stores the creation-batch flag again. Never lowers anyone; blocked accounts are left alone.</p>
${
  csrf
    ? `<form method="post" action="/admin/dashboard/tools#recheck"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="tool" value="recheck"><div class="row"><button class="btn primary" type="submit">Re-check below-bar accounts</button></div></form>`
    : `<p class="hint">Sign in at /admin in a browser to use this.</p>`
}
${result}
</section>`;
}

/** Leads shown in the table; the CSV and the copy box have them all. */
const LEADS_SHOWN = 200;

/**
 * "GPU early access": the emails people left after saying yes to early access for their AMD or
 * Ascend GPU (POST /v1/telemetry/gpu), newest first, with a CSV, a box holding every address to
 * copy, and a form that deletes one person's leads on request. Emails are user content: escaped.
 */
function leadsCard(state: ToolsState): string {
  const { leads, csrf } = state;
  const notice = state.leadNotice ? `<p class="msg${state.leadNotice.error ? " err" : ""}" role="${state.leadNotice.error ? "alert" : "status"}">${escapeHtml(state.leadNotice.text)}</p>` : "";
  const rows = leads
    .slice(0, LEADS_SHOWN)
    .map(
      (lead) =>
        `<tr><td><code>${escapeHtml(lead.email)}</code></td><td>${escapeHtml(GPU_VENDOR_NAMES[lead.vendor] ?? lead.vendor)}</td><td>${escapeHtml(lead.gpuModel || "–")}</td><td class="num">${lead.vramGb >= 0 ? `${count(lead.vramGb)} GB` : "–"}</td><td>${escapeHtml(isoDay(lead.at))}</td></tr>`,
    );
  const emails = [...new Set(leads.map((lead) => lead.email))];
  const table =
    leads.length === 0
      ? `<p class="hint">No emails yet.</p>`
      : `<div class="leads-wrap"><table class="leads"><thead><tr><th>Email</th><th>Vendor</th><th>GPU</th><th>VRAM</th><th>Date</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>
${leads.length > LEADS_SHOWN ? `<p class="hint">The newest ${count(LEADS_SHOWN)} of ${count(leads.length)}; the CSV has them all.</p>` : ""}
<p class="hint">${plural(leads.length, "lead")} · ${csvLink("early-access")}</p>
<label class="field"><span>All ${plural(emails.length, "email")}, to copy</span><textarea class="emails" readonly rows="3" spellcheck="false">${escapeHtml(emails.join(", "))}</textarea></label>`;
  const remove = csrf
    ? `<form method="post" action="/admin/dashboard/tools#leads"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="tool" value="early-access-delete">
<label class="field"><span>Delete on request</span><input type="email" name="email" maxlength="254" placeholder="someone@example.com" autocomplete="off" autocapitalize="off"></label>
<div class="row"><button class="btn" type="submit">Delete their leads</button></div></form>`
    : "";
  return `<section class="card" id="leads" aria-label="GPU early access">
<h2>GPU early access</h2>
<p class="lede">Emails people chose to leave after saying yes to early access for their AMD or Ascend GPU. Only for telling them when support is ready. The anonymous counts are in Health.</p>
${notice}
${table}
${remove}
</section>`;
}

/** GET /admin/dashboard/early-access.csv: every lead, newest first. */
export function earlyAccessCsv(leads: EarlyAccessLead[], now: number): Response {
  const body = csv(
    ["email", "vendor", "gpu_model", "vram_gb", "date"],
    leads.map((lead) => [lead.email, lead.vendor, lead.gpuModel, lead.vramGb >= 0 ? lead.vramGb : null, isoDay(lead.at)]),
  );
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="free-early-access-${isoDay(now)}.csv"`, ...dashboardHeaders() },
  });
}

function emailCard(state: ToolsState): string {
  const { compose: email, csrf } = state;
  if (!csrf) {
    return `<section class="card" id="email" aria-label="Write an email"><h2>Write an email</h2><p class="hint">Sign in at /admin in a browser to use this.</p></section>`;
  }
  const radio = (value: BroadcastAudience, label: string) =>
    `<label><input type="radio" name="audience" value="${value}"${email.audience === value ? " checked" : ""}><span>${label}</span></label>`;
  const single = email.from !== "" && email.from === email.to ? email.from : "";
  const dayButtons = state.cohorts.map((row) => {
    const value = isoDay(row.day);
    return `<button type="submit" class="day" name="action" value="pick:${value}" aria-pressed="${single === value}"><b>${escapeHtml(`${WEEKDAYS[new Date(row.day).getUTCDay()]} ${monthDay(row.day)}`)}</b><small>${count(row.full)} full · ${count(row.basic)} basic · ${count(row.starter)} starter</small></button>`;
  });
  const capitals = (email.subject !== "" || email.text !== "") && hasCapitals(email.subject, email.text);
  const preview = email.preview;
  const sent = email.sent;
  const confirmField = email.confirm ? `<input type="hidden" name="confirm" value="${escapeHtml(email.confirm)}">` : "";
  const sample = preview && preview.sample.length > 0 ? ` For example ${escapeHtml(preview.sample.join(", "))}.` : "";
  const waiting = (n: number) => (n > 0 ? ` ${plural(n, "more person", "more people")} already had an email today; they can get it tomorrow.` : "");
  const outcome = [
    email.notice ? `<p class="msg${email.notice.error ? " err" : ""}" role="${email.notice.error ? "alert" : "status"}">${escapeHtml(email.notice.text)}</p>` : "",
    preview && !email.confirming && !sent
      ? `<div class="panel" role="status"><p><span class="big2">${count(preview.count)}</span> ${preview.count === 1 ? "person gets" : "people get"} it now.${sample}</p>${waiting(preview.waitingForTomorrow) ? `<p class="hint">${escapeHtml(waiting(preview.waitingForTomorrow).trim())}</p>` : ""}</div>`
      : "",
    preview && email.confirming
      ? `<div class="panel confirm" role="alert"><p><strong>Send this to ${plural(preview.count, "person", "people")} now?</strong>${sample}</p>${waiting(preview.waitingForTomorrow) ? `<p class="hint">${escapeHtml(waiting(preview.waitingForTomorrow).trim())}</p>` : ""}${state.emailsOn ? "" : `<p class="msg err">Emails to users are off (the userEmails setting), so this will be refused.</p>`}<div class="row actions"><button class="btn primary" type="submit" name="action" value="send">Yes, send to ${plural(preview.count, "person", "people")}</button><button class="btn" type="submit" name="action" value="cancel">Cancel</button></div></div>`
      : "",
    sent
      ? `<div class="panel" role="status"><dl class="nums"><div><dt>Sent</dt><dd>${count(sent.sent)}</dd></div><div><dt>Waiting for tomorrow</dt><dd>${count(sent.waitingForTomorrow)}</dd></div><div><dt>Remaining</dt><dd>${count(sent.remaining)}</dd></div><div><dt>Failed</dt><dd>${count(sent.failed)}</dd></div></dl>${
          sent.stoppedBy ? `<p class="hint">The provider's limit stopped this batch (${escapeHtml(sent.stoppedBy)}); send the rest later.</p>` : ""
        }${sent.failed > 0 ? `<p class="hint">Failed sends are tried again on the next send, up to 3 times.</p>` : ""}${
          sent.remaining > 0 ? `<div class="row"><button class="btn primary" type="submit" name="action" value="send">Send the rest (${count(sent.remaining)})</button></div>` : ""
        }</div>`
      : "",
  ].join("");
  return `<section class="card" id="email" aria-label="Write an email">
<h2>Write an email</h2>
<p class="lede">Plain text, sent exactly as typed, from the usual sender with the stop link under it. Never to blocked accounts, people who pressed stop, or admins; at most one email a day each.</p>
${state.emailsOn ? "" : `<p class="msg flag">Emails to users are off (the userEmails setting): tests and previews work, sending doesn't.</p>`}
${state.provider ? "" : `<p class="msg err">No email provider is set up (USER_EMAIL or RESEND_API_KEY): nothing can be sent.</p>`}
<form method="post" action="/admin/dashboard/tools#email-actions">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="tool" value="email">${confirmField}
<button type="submit" name="action" value="preview" class="sr" tabindex="-1" aria-hidden="true">Preview</button>
<label class="field"><span>Subject</span><input type="text" name="subject" value="${escapeHtml(email.subject)}" maxlength="200" autocomplete="off"></label>
<label class="field"><span>Text</span><textarea class="letter" name="text" rows="12">\n${escapeHtml(email.text)}</textarea></label>
${capitals ? `<p class="caps">Has capitals. Fine for names like GPT-6 or OpenAI; it still sends.</p>` : ""}
<fieldset><legend>Who gets it</legend><div class="seg">${radio("full", "Full")}${radio("basic", "Basic")}${radio("starter", "Starter")}${radio("all", "Everyone")}</div></fieldset>
<fieldset><legend>Signed up (UTC, both days included)</legend>
<div class="dates"><label class="field"><span>From</span><input type="date" name="from" value="${escapeHtml(email.from)}"></label><label class="field"><span>To</span><input type="date" name="to" value="${escapeHtml(email.to)}"></label></div>
${
  dayButtons.length > 0
    ? `<p class="hint">Or pick a sign-up day. People an email can reach:</p><div class="days">${dayButtons.join("")}</div>`
    : `<p class="hint">Nobody an email can reach has signed up yet.</p>`
}
${email.from || email.to ? `<div class="row"><button class="btn quiet" type="submit" name="action" value="clear">Any sign-up day</button></div>` : ""}
</fieldset>
<label class="field"><span>Send the test to</span><input type="email" name="test_to" value="${escapeHtml(email.testTo)}" placeholder="${escapeHtml(state.adminEmail ?? "you@example.com")}" autocomplete="email" autocapitalize="off"></label>
<div class="row actions" id="email-actions"><button class="btn" type="submit" name="action" value="test">Send me a test</button><button class="btn" type="submit" name="action" value="preview">Preview who gets it</button><button class="btn primary" type="submit" name="action" value="confirm">Send…</button></div>
${outcome}
</form>
</section>`;
}

/**
 * GET /admin?view=tools, and what POST /admin/dashboard/tools answers: two cards, "Give free
 * tokens" (paste GitHub usernames) and "Write an email" (a plain one-off email to a level and a
 * sign-up range, with a test, a preview and an in-page confirm). Same look as the simple view.
 */
export function toolsPage(state: ToolsState): Response {
  const header = `<header class="bar"><div>
<a class="brand" href="/admin?view=simple"><span class="logo"><img src="${BRAND_ORIGIN}/logo-64.webp" alt="" width="22" height="22"></span><b>${escapeHtml(PRODUCT_NAME)} admin</b></a>
${viewToggle("tools")}
${state.signOut ? `<form method="post" action="/admin/signout"><button type="submit" class="out">Sign out</button></form>` : ""}
</div></header>`;
  return shell(`Tools · ${PRODUCT_NAME}`, `${header}\n<main class="tools">\n${requestsCard(state)}\n${grantCard(state)}\n${recheckCard(state)}\n${emailCard(state)}\n${leadsCard(state)}\n</main>`, 200, {}, "", TOOLS_STYLE);
}

// ─── Health ───────────────────────────────────────────────────────────────

const OS_NAMES: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows" };
const osLabel = (os: string) => OS_NAMES[os] ?? os;
const UPSTREAM_LABELS: Record<string, string> = { openai: "OpenAI", luminal: "Luminal", openrouter: "OpenRouter" };

/** A compact table: header cells, body rows (already HTML), and what to say when there are none. */
function healthTable(head: string[], rows: string[], empty: string): string {
  return `<div class="scroll"><table>
<thead><tr>${head.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")}</tr></thead>
<tbody>
${rows.length === 0 ? `<tr><td colspan="${head.length}" class="l muted">${escapeHtml(empty)}</td></tr>` : rows.join("\n")}
</tbody></table></div>`;
}

/** A row; `bad` marks it (colour plus a word, so it doesn't rest on colour alone). */
function healthRow(cells: string[], bad = false): string {
  return `<tr${bad ? ` class="bad"` : ""}>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
}

const abnormalChip = ` <span class="status blocked">abnormal</span>`;
const shareCell = (n: number, share: number) => `${count(n)} <span class="muted">(${percent(share)})</span>`;

/**
 * GET /admin?view=health: what Autopilot's session events and the request log say about bugs,
 * crashes and what gets used (health-data.ts), over the last 1, 7 or 30 days. Eight sections,
 * each a one-line takeaway, compact tables and a CSV. Same look as the full view.
 */
export function healthPage(input: { health: HealthData; login: string; signOut: boolean }): Response {
  const h = input.health;
  const say = healthTakeaways(h);
  const query = `?days=${h.days}`;
  const section = (id: string, title: string, csvs: Array<CsvTable>, takeaway: string, body: string, note: string) => `<section id="${id}">
<div class="head"><h2>${escapeHtml(title)}</h2><span>${csvs.map((table) => csvLink(table, query)).join(" · ")}</span></div>
<p class="takeaway">${escapeHtml(takeaway)}</p>
${body}
<p class="note">${note}</p>
</section>`;
  const windowSwitch = `<nav class="views" aria-label="Window">${HEALTH_WINDOWS.map(
    (days) => `<a href="/admin?view=health&amp;days=${days}"${days === h.days ? ` aria-current="page"` : ""}>${days === 1 ? "1 day" : `${days} days`}</a>`,
  ).join("")}</nav>`;

  const header = `${markHeader(
    `<span class="who">${viewToggle("health")}Signed in as <strong>${escapeHtml(input.login)}</strong>${
      input.signOut ? `<form method="post" action="/admin/signout"><button type="submit">Sign out</button></form>` : ""
    }</span>`,
  )}
<h1>Health</h1>
<div class="health-views">${windowSwitch}<span class="muted">Last ${h.days === 1 ? "24 hours" : `${h.days} days`}, to ${escapeHtml(new Date(h.now).toISOString().slice(0, 16).replace("T", " "))} UTC.</span></div>
<p class="lede">From Autopilot's session events (sent only while the free tier is the provider) and the free tier's request log. Admins left out except where a section says. Counts and outcomes only: never prompts, code, paths or repositories.</p>`;

  const errors = section(
    "errors",
    "Errors",
    ["health-errors", "health-request-failures"],
    say.errors,
    `<h3>Reported by Autopilot (${count(h.errors.total)}, ${count(h.errors.people)} people)</h3>
${healthTable(
  ["Error code", "Count", "People", "Autopilot versions"],
  h.errors.codes.map((row) =>
    healthRow([
      escapeHtml(row.code),
      count(row.count),
      count(row.people),
      escapeHtml(
        row.versions
          .slice(0, 4)
          .map((version) => `${version.version} ×${version.count}`)
          .join(", ") + (row.versions.length > 4 ? ", …" : ""),
      ),
    ]),
  ),
  "No errors reported.",
)}
<h3>Free tier requests that failed (${count(h.requests.failed)} of ${count(h.requests.total)})</h3>
${healthTable(
  ["Status", "Model", "Failed", "Of the model's requests"],
  h.requests.failures.map((row) => healthRow([escapeHtml(row.status), escapeHtml(row.model), count(row.count), percent(row.share)])),
  "No failed requests.",
)}`,
    "Error codes are what a failed turn carried: a provider code, an HTTP status (http_429) or an error class, never the message. Versions come from the session's start. Request statuses: upstream_busy (429), upstream_error (5xx), upstream_timeout, upstream_unreachable, stream_error, abandoned.",
  );

  const endLabel = (end: string) => escapeHtml(end);
  const ends = section(
    "ends",
    "Crashes and abnormal ends",
    ["health-ends", "health-turns"],
    say.ends,
    `<h3>How sessions ended (${count(h.ends.sessions)} started)</h3>
${healthTable(
  ["End", "Sessions", "Share"],
  h.ends.overall.map((row) => healthRow([`${endLabel(row.end)}${row.normal ? "" : abnormalChip}`, count(row.count), percent(row.share)], !row.normal)),
  "No sessions started.",
)}
<h3>By Autopilot version and OS</h3>
${healthTable(
  ["Version", "OS", "Sessions", "Abnormal", "Most common"],
  h.ends.split.map((row) =>
    healthRow([escapeHtml(row.version), escapeHtml(osLabel(row.os)), count(row.sessions), row.abnormal > 0 ? shareCell(row.abnormal, row.share) : "0", row.top === null ? "–" : escapeHtml(row.top)], row.abnormal > 0),
  ),
  "No sessions started.",
)}
<h3>How turns ended (${count(h.ends.turnTotal)})</h3>
${healthTable(
  ["Turn end", "Turns", "Share"],
  h.ends.turns.map((row) => healthRow([`${endLabel(row.end)}${row.normal ? "" : abnormalChip}`, count(row.count), percent(row.share)], !row.normal)),
  "No turns.",
)}`,
    `Sessions started in the window. Autopilot sends a session end only for ${NORMAL_SESSION_ENDS.map((end) => `"${end}"`).join(" and ")} (/clear); a crash or a killed terminal sends none, so ${escapeHtml(NO_END)} is a session with no end whose last event is over 6 hours old, and ${escapeHtml(STILL_OPEN)} one active more recently. Turns end complete, needs_input, aborted (Esc), guardrail or error.`,
  );

  const versions = section(
    "versions",
    "Versions",
    ["health-versions"],
    say.versions,
    `<div class="tiles">
<div class="tile">Autopilot version${healthTable(
      ["Version", "Sessions", "People"],
      h.versions.versions.map((row) => healthRow([`${escapeHtml(row.version)}${row.version === h.versions.latest ? ` <span class="muted">newest</span>` : ""}`, shareCell(row.count, row.share), count(row.people)])),
      "No sessions.",
    )}</div>
<div class="tile">OS${healthTable(
      ["OS", "Sessions", "People"],
      h.versions.os.map((row) => healthRow([escapeHtml(osLabel(row.os)), shareCell(row.count, row.share), count(row.people)])),
      "No sessions.",
    )}</div>
</div>`,
    "From each session's start. A person on two versions counts under both.",
  );

  const s = h.sessions;
  const durationText = (value: number | null) => (value === null ? "–" : value >= 60_000 ? `${(value / 60_000).toFixed(value >= 600_000 ? 0 : 1)} min` : ms(value));
  const sessions = section(
    "sessions",
    "Sessions",
    ["health-sessions"],
    say.sessions,
    `<div class="tiles">
<div class="tile">Sessions<b>${count(s.sessions)}</b><span class="note">${count(s.people)} people; ${count(s.ended)} sent an end</span></div>
<div class="tile">Turns per session<b>${s.turnsMedian === null ? "–" : count(s.turnsMedian)} <span class="muted">median</span></b><span class="note">p90 ${s.turnsP90 === null ? "–" : count(s.turnsP90)}</span></div>
<div class="tile">Duration<b>${durationText(s.durationMedianMs)} <span class="muted">median</span></b><span class="note">p90 ${durationText(s.durationP90Ms)}; ended sessions only</span></div>
<div class="tile">Opened and left<b>${count(s.zeroTurns)}</b><span class="note">${s.sessions > 0 ? `${percent(s.zeroTurns / s.sessions)} of sessions had no turn` : "no sessions"}</span></div>
<div class="tile">PRs opened<b>${count(s.prs)}</b><span class="note">${s.prsPer100 === null ? "–" : s.prsPer100.toFixed(1)} per 100 sessions</span></div>
</div>`,
    "Sessions started in the window. Turns: the session end's count, or its turn events when it sent no end. PRs: a pull request URL a tool printed in that session.",
  );

  const tools = section(
    "tools",
    "Tools",
    ["health-tools"],
    say.tools,
    healthTable(
      ["Tool", "Calls", "Sessions using it"],
      h.tools.tools.map((row) => healthRow([escapeHtml(row.tool), shareCell(row.calls, h.tools.calls > 0 ? row.calls / h.tools.calls : 0), shareCell(row.sessions, row.share)])),
      "No tool calls reported.",
    ),
    `Summed from each turn's end (the session end repeats the same counts). Sessions using it: of the ${count(h.tools.sessions)} sessions with a turn in the window. Names only, never arguments.`,
  );

  const upstreams = h.models.upstreams.filter((row) => row.requests > 0 || row.medianTtftMs !== null);
  const models = section(
    "models",
    "Models",
    ["health-models", "health-upstreams"],
    say.models,
    `<div class="tiles">
<div class="tile">Sessions by model${healthTable(
      ["Model", "Sessions"],
      h.models.sessions.map((row) => healthRow([escapeHtml(row.model), shareCell(row.count, row.share)])),
      "No sessions.",
    )}</div>
<div class="tile">Requests by model${healthTable(
      ["Model", "Requests", "Failed"],
      h.models.requests.map((row) => healthRow([escapeHtml(row.model), shareCell(row.requests, row.share), row.requests > 0 ? shareCell(row.failed, row.failed / row.requests) : "0"])),
      "No requests.",
    )}</div>
</div>
<h3>Time to first token by upstream</h3>
${healthTable(
  ["Upstream", "Requests", "Errors", "TTFT median", "TTFT p90"],
  upstreams.map((row) => healthRow([UPSTREAM_LABELS[row.upstream] ?? row.upstream, count(row.requests), count(row.errors), ms(row.medianTtftMs), ms(row.p90TtftMs)])),
  "No upstream requests.",
)}`,
    "Sessions by the model at their start; requests from the free tier's log. The upstream table is the Full view's, over this window: admins included (no person is stored with it), counts by UTC day, timings kept 15 days.",
  );

  const installRows = h.installs.platforms.map((row) =>
    healthRow(
      [
        escapeHtml(`${osLabel(row.os)} ${row.arch}`),
        escapeHtml(row.mode),
        count(row.ok),
        count(row.failed),
        row.ok + row.failed > 0 ? percent(row.failShare) : "–",
        row.topStep === null ? "–" : escapeHtml(INSTALL_STEPS[row.topStep] ?? row.topStep),
      ],
      row.failed > 0,
    ),
  );
  const installs = section(
    "installs",
    "Installs",
    ["health-installs"],
    say.installs,
    `${healthTable(["System", "Mode", "Ok", "Failed", "Fail share", "Mostly fails at"], installRows, "No installs counted.")}
<h3>Failed steps</h3>
${healthTable(
  ["Step", "Failed"],
  h.installs.failedSteps.map((row) => healthRow([escapeHtml(STEP_LABELS[row.step] ?? row.step), count(row.failed)])),
  "No failed installs.",
)}`,
    `Anonymous counts from install.sh, by UTC day since ${escapeHtml(day(h.fromDay))}: they can't be joined to people, so admins are in them.`,
  );

  const g = h.gpus;
  const gpuName = (vendor: string) => escapeHtml(GPU_VENDOR_NAMES[vendor] ?? vendor);
  const optionName = (option: string) => escapeHtml(GPU_OPTION_NAMES[option] ?? option);
  const gpus = section(
    "gpus",
    "GPUs",
    ["health-gpus"],
    say.gpus,
    `<div class="tiles">
<div class="tile">First runs by GPU${healthTable(["GPU", "First runs"], g.detected.map((row) => healthRow([gpuName(row.vendor), count(row.count)])), "No first runs.")}</div>
<div class="tile">Private model on this GPU?${healthTable(["Answer", "Count"], [healthRow(["Yes", count(g.prompt.yes)]), healthRow(["No", count(g.prompt.no)])], "No answers.")}</div>
<div class="tile">Options picked${healthTable(["Option", "Count"], g.options.map((row) => healthRow([optionName(row.option), count(row.count)])), "No options picked.")}</div>
<div class="tile">Early access${healthTable(["GPU", "Yes", "No"], g.earlyAccess.map((row) => healthRow([gpuName(row.vendor), count(row.yes), count(row.no)])), "No answers.")}</div>
</div>
<h3>Setups by path</h3>
${healthTable(
  ["Path", "Ok", "Failed", "Top errors"],
  g.results.map((row) =>
    healthRow(
      [
        optionName(row.path),
        count(row.ok),
        count(row.failed),
        row.errors.length === 0 ? "–" : escapeHtml(row.errors.slice(0, 3).map((error) => `${error.errorType} (${error.count.toLocaleString("en-US")})`).join(", ")),
      ],
      row.failed > 0,
    ),
  ),
  "No setups.",
)}`,
    `Anonymous counts from Autopilot's GPU first run before sign-in, by UTC day since ${escapeHtml(day(h.fromDay))}: one per step per machine, with no IP, account or device, so they can't be joined to people and admins are in them. A machine that runs the first run again is counted again.`,
  );

  return shell(`Health · ${PRODUCT_NAME}`, [header, errors, ends, versions, sessions, tools, models, installs, gpus].join("\n"));
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

export function dashboardCsv(table: Exclude<CsvTable, HealthCsvTable | "early-access">, data: DashboardData, spend: SpendView): Response {
  let body: string;
  switch (table) {
    case "spend": {
      const totals = spendTotals(spend);
      body = csv(
        ["week_start", "week_usd", "weekly_cap_usd", "total_usd", "total_cap_usd", "admin_week_usd", "admin_total_usd", "paused", "paused_by_env", "open_admission", "admitted", "max_active_users", "resets_at", "primary_upstream", "luminal_credit_usd", "luminal_credit_used_usd", "free_credit_week_usd", "weekly_credit_usd", "require_github_activity", "luminal_credit_week_usd", "openai_credit_usd", "openai_credit_used_usd", "openai_credit_week_usd", "openai_free_credit_week_usd", "openai_weekly_credit_usd", "metered_total_usd", "spent_all_time_usd", "spent_week_usd"],
        [[day(data.currentWeek), spend.weekUsd, spend.weeklyCapUsd, spend.totalUsd, spend.totalCapUsd, spend.adminWeekUsd, spend.adminTotalUsd, spend.paused, spend.pausedByEnv, spend.openAdmission, data.people.admitted, spend.maxActiveUsers, new Date(spend.resetsAt).toISOString(), spend.primaryUpstream, spend.creditUsd, spend.creditUsedUsd, spend.freeCreditWeekUsd, spend.weeklyCreditUsd, spend.requireGithubActivity, spend.creditWeekUsd, spend.openaiCreditUsd, spend.openaiCreditUsedUsd, spend.openaiCreditWeekUsd, spend.openaiFreeCreditWeekUsd, spend.openaiWeeklyCreditUsd, totals.meteredAllTimeUsd, totals.allTimeUsd, totals.weekUsd]],
      );
      break;
    }
    case "weekly-active":
      body = csv(["week_start", `active_${REGULAR_DAYS}_plus_days`, "active_any_day"], data.weeklyActive.map((week) => [day(week.weekStart), week.regular, week.active]));
      break;
    case "retention":
      body = csv(
        ["signup_week", "people", ...RETENTION_OFFSETS.flatMap((offset) => [`week_${offset}_active`, `week_${offset}_share`])],
        data.cohorts.map((cohort) => [day(cohort.weekStart), cohort.size, ...cohort.retained.flatMap((cell) => (cell ? [cell.active, cell.share] : [null, null]))]),
      );
      break;
    case "retention-daily":
      body = csv(
        ["cohort", "size", ...RETENTION_DAYS.map((offset) => `d${offset}`)],
        data.dailyCohorts.map((cohort) => [day(cohort.day), cohort.size, ...cohort.retained.map((cell) => cell?.share ?? null)]),
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
        ["window", "upstream", "requests", "errors", "ttft_median_ms", "ttft_p90_ms", "ttfb_median_ms", "cache_hit_share", "credit_usd", "cash_usd", "users", "prompt_tokens", "cached_tokens", "completion_tokens"],
        [
          ...data.upstreams.map((row) => [
            row.window,
            row.upstream,
            row.requests,
            row.errors,
            row.medianTtftMs,
            row.p90TtftMs,
            row.medianTtfbMs,
            row.cacheHitShare,
            row.creditUsd,
            row.cashUsd,
            row.users,
            row.promptTokens,
            row.cachedTokens,
            row.completionTokens,
          ]),
          ...data.upstreamTotals.map((row) => [
            row.window,
            "total",
            row.requests,
            row.errors,
            null,
            null,
            null,
            row.cacheHitShare,
            row.creditUsd,
            row.cashUsd,
            row.users,
            row.promptTokens,
            row.cachedTokens,
            row.completionTokens,
          ]),
          ["all_time", "luminal_credit", null, null, null, null, null, null, spend.creditUsedUsd, null, null, null, null, null],
          ["all_time", "openai_credit", null, null, null, null, null, null, spend.openaiCreditUsedUsd, null, null, null, null, null],
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

/** One Health table as CSV (see healthPage); the file name carries the window. */
export function healthCsv(table: HealthCsvTable, h: HealthData): Response {
  let body: string;
  switch (table) {
    case "health-errors":
      body = csv(
        ["error_code", "count", "people", "autopilot_version", "version_count"],
        h.errors.codes.flatMap((row) =>
          row.versions.length === 0 ? [[row.code, row.count, row.people, null, null]] : row.versions.map((version) => [row.code, row.count, row.people, version.version, version.count]),
        ),
      );
      break;
    case "health-request-failures":
      body = csv(["status", "model", "failed", "share_of_model_requests"], h.requests.failures.map((row) => [row.status, row.model, row.count, row.share]));
      break;
    case "health-ends":
      body = csv(
        ["autopilot_version", "os", "end", "sessions", "share", "normal"],
        [...h.ends.overall.map((row) => ["all", "all", row.end, row.count, row.share, row.normal]), ...h.ends.detail.map((row) => [row.version, row.os, row.end, row.count, row.share, row.normal])],
      );
      break;
    case "health-turns":
      body = csv(["turn_end", "turns", "share", "normal"], h.ends.turns.map((row) => [row.end, row.count, row.share, row.normal]));
      break;
    case "health-versions":
      body = csv(
        ["kind", "value", "sessions", "share", "people", "newest"],
        [...h.versions.versions.map((row) => ["autopilot_version", row.version, row.count, row.share, row.people, row.version === h.versions.latest]), ...h.versions.os.map((row) => ["os", row.os, row.count, row.share, row.people, null])],
      );
      break;
    case "health-sessions": {
      const s = h.sessions;
      body = csv(
        ["sessions", "people", "ended", "turns_median", "turns_p90", "duration_median_ms", "duration_p90_ms", "zero_turn_sessions", "prs_opened", "prs_per_100_sessions"],
        [[s.sessions, s.people, s.ended, s.turnsMedian, s.turnsP90, s.durationMedianMs, s.durationP90Ms, s.zeroTurns, s.prs, s.prsPer100]],
      );
      break;
    }
    case "health-tools":
      body = csv(["tool", "calls", "sessions_using", "share_of_sessions"], h.tools.tools.map((row) => [row.tool, row.calls, row.sessions, row.share]));
      break;
    case "health-models":
      body = csv(
        ["kind", "model", "count", "share", "failed"],
        [...h.models.sessions.map((row) => ["sessions", row.model, row.count, row.share, null]), ...h.models.requests.map((row) => ["requests", row.model, row.requests, row.share, row.failed])],
      );
      break;
    case "health-upstreams":
      body = csv(["upstream", "requests", "errors", "ttft_median_ms", "ttft_p90_ms", "ttfb_median_ms"], h.models.upstreams.map((row) => [row.upstream, row.requests, row.errors, row.medianTtftMs, row.p90TtftMs, row.medianTtfbMs]));
      break;
    case "health-installs":
      body = csv(
        ["kind", "os", "arch", "mode", "step", "ok", "failed", "fail_share", "top_failed_step"],
        [
          ...h.installs.platforms.map((row) => ["system", row.os, row.arch, row.mode, null, row.ok, row.failed, row.failShare, row.topStep]),
          ...h.installs.failedSteps.map((row) => ["failed_step", null, null, null, row.step || "unknown", null, row.failed, null, null]),
        ],
      );
      break;
    case "health-gpus":
      body = csv(["event", "vendor", "answer", "option", "path", "outcome", "error_type", "count"], h.gpus.rows.map((row) => [row.event, row.vendor, row.answer, row.option, row.path, row.outcome, row.errorType, row.count]));
      break;
  }
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="free-${table}-${h.days}d-${day(h.now)}.csv"`,
      ...dashboardHeaders(),
    },
  });
}
