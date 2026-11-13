import { escapeHtml } from "../../shared/src/html.js";
import { DOWNLOAD_ROUTES } from "./telemetry.js";
import { REGULAR_DAYS, RETENTION_DAYS, RETENTION_OFFSETS, type DashboardData } from "./dashboard-data.js";
import { BRAND_ORIGIN, BRAND_TOKENS, PRODUCT_NAME } from "./pages.js";
import { isoDay } from "./week.js";
import type { EarlyAccessLead, PendingAccessRequest } from "./directory-object.js";
import { hasCapitals, type BroadcastAudience } from "./broadcast.js";
import { GRANT_LABELS, grantUsdText, MAX_GRANT_LOGINS, MAX_GRANT_USD, type GrantResult } from "./grant.js";
import { GPU_VENDOR_NAMES, type HealthData } from "./health-data.js";

/**
 * The admin pages besides the home (admin-home-page.ts): sign-in, the Tools page and a CSV of
 * each table (/admin/dashboard/<table>.csv). No inline `style` attributes: the one stylesheet
 * carries a per-response nonce (and the home's one script the same nonce), so the pages work
 * under `default-src 'none'`. They wear the dl.new brand (tokens, Bricolage/Geist/Geist Mono and
 * the logo, loaded from dl.new and nothing else), light and dark following the device.
 * The forms are sign-out and the Tools page's (grants, requests, block or unblock, routing,
 * re-check, emails, leads); all but sign-out post back here with a CSRF token.
 */

/** Global spend, caps and settings, for the CSVs and the home page. */
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
  /** A Full person's GPT-6 budget, and DeepSeek budget (absent: the same). */
  perPersonWeeklyUsd: number | null;
  deepseekWeeklyUsd?: number | null;
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
  starterDeepseekWeeklyUsd?: number | null;
  /** The basic level: weekly tokens (0: off), dollar cap, and the account age it needs. Admin-only. */
  basicWeeklyTokens: number;
  basicWeeklyUsd: number | null;
  basicDeepseekWeeklyUsd?: number | null;
  basicMinAccountAgeDays: number;
  /** The public bar for Full (free tokens): account age, and public repositories or contributions. */
  fullMinAccountAgeDays: number;
  fullMinPublicRepos: number;
  fullMinContributions: number;
}

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

/** Security headers every dashboard response carries. `nonce` allows the one stylesheet (and, with `script`, the one script). */
export function dashboardHeaders(nonce?: string, script = false): Record<string, string> {
  return {
    "content-security-policy": `default-src 'none'; style-src ${nonce ? `'nonce-${nonce}'` : "'none'"};${nonce && script ? ` script-src 'nonce-${nonce}';` : ""} img-src ${nonce ? BRAND_ORIGIN : "'none'"}; font-src ${nonce ? BRAND_ORIGIN : "'none'"}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
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

export function shell(title: string, body: string, status = 200, headers: Record<string, string> = {}, head = "", style = STYLE, script = ""): Response {
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
${script ? `<script nonce="${styleNonce}">${script}</script>\n` : ""}</body>
</html>
`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", ...dashboardHeaders(styleNonce, script !== ""), ...headers } });
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

function count(value: number): string {
  return Math.round(value).toLocaleString("en-US");
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

function when(ms: number | null): string {
  return ms === null ? "–" : escapeHtml(new Date(ms).toISOString().slice(0, 16).replace("T", " "));
}

function csvLink(table: CsvTable, query = ""): string {
  return `<a href="/admin/dashboard/${table}.csv${query}" download>CSV</a>`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Nov 8" (UTC). */
const monthDay = (ms: number) => `${MONTHS[new Date(ms).getUTCMonth()]} ${new Date(ms).getUTCDate()}`;

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

// ─── Shared look (Home and Tools) ─────────────────────────────────────────

/**
 * The Home and Tools stylesheet: a desktop admin app's cards (white panels with a 1px border,
 * 10px radius, bold numbers over small muted labels) in the dl tokens, light and dark.
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
.views { display: flex; gap: 4px; background: var(--k-bg); border: 1px solid var(--k-border); border-radius: 8px; padding: 3px; }
.views a { padding: 5px 13px; border-radius: 6px; font-size: 13px; font-weight: 500; color: var(--k-muted); text-decoration: none; }
.views a[aria-current="page"] { background: var(--accent); color: #FFFFFF; }
.bar form { margin: 0; }
.out { padding: 6px 10px; border-radius: 8px; border: 1px solid var(--k-border); background: transparent; color: var(--k-muted); font: 500 13px var(--body); cursor: pointer; }
.out:hover { color: var(--k-text); }
main { max-width: 80rem; margin: 0 auto; padding: 28px 32px 48px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; }
.card { background: var(--k-card); border: 1px solid var(--k-border); border-radius: 10px; padding: 24px; box-shadow: var(--k-shadow); min-width: 0; }
h2 { font-size: 15px; font-weight: 600; color: var(--k-muted); margin: 0 0 12px; }
svg.chart { display: block; width: 100%; height: auto; overflow: visible; }
svg.chart text { fill: var(--k-muted); font: 11px var(--body); font-variant-numeric: tabular-nums; }
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
.empty { color: var(--k-muted); margin: 8px 0 0; }
@media (max-width: 1100px) { main { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 760px) {
  .bar > div { padding: 12px 16px; }
  main { padding: 16px 16px 40px; gap: 14px; }
  .card { padding: 18px; }
}
`;

/** A bar's path: square at the baseline, 3px rounded at the far end. */
export function barPath(x: number, y: number, width: number, height: number, horizontal = false): string {
  const r = Math.min(3, horizontal ? width : height, horizontal ? height / 2 : width / 2);
  if (horizontal) return `M${x.toFixed(1)} ${y.toFixed(1)}h${(width - r).toFixed(1)}a${r} ${r} 0 0 1 ${r} ${r}v${(height - 2 * r).toFixed(1)}a${r} ${r} 0 0 1 -${r} ${r}h-${(width - r).toFixed(1)}z`;
  return `M${x.toFixed(1)} ${(y + height).toFixed(1)}v-${(height - r).toFixed(1)}a${r} ${r} 0 0 1 ${r} -${r}h${(width - 2 * r).toFixed(1)}a${r} ${r} 0 0 1 ${r} ${r}v${(height - r).toFixed(1)}z`;
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
  /** The routing setting (primaryUpstream) and which upstreams have a key. */
  routing: Pick<SpendView, "primaryUpstream" | "openaiConfigured" | "luminalConfigured" | "openRouterConfigured">;
  /** The block form: the login typed and what the last block or unblock did. */
  block: { login: string; notice?: { error: boolean; text: string } };
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

/** The shared look, plus forms: fields at 16px so a phone doesn't zoom in on them. */
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
.switch form { display: inline; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (max-width: 520px) { .nums { grid-template-columns: repeat(2, minmax(0, 1fr)); } .actions .btn { flex: 1 1 auto; } }
`;

/** The Home / Tools switch: two links, the current one marked. */
export function adminNav(current: "home" | "tools"): string {
  const link = (href: string, page: "home" | "tools", label: string) => `<a href="${href}"${current === page ? ` aria-current="page"` : ""}>${label}</a>`;
  return `<nav class="views" aria-label="Admin pages">${link("/admin", "home", "Home")}${link("/admin?view=tools", "tools", "Tools")}</nav>`;
}

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
 * grantWeeklyUsdCap setting.
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

/** "Block or unblock": by GitHub username; a blocked account gets no free tokens and can't sign in. */
function blockCard(state: ToolsState): string {
  const { csrf, block } = state;
  const notice = block.notice ? `<p class="msg${block.notice.error ? " err" : ""}" role="status">${escapeHtml(block.notice.text)}</p>` : "";
  return `<section class="card" id="block" aria-label="Block or unblock">
<h2>Block or unblock</h2>
<p class="lede">A blocked account gets no free tokens, can't refresh its token or sign in again, and isn't emailed. Unblock restores all of it. Each change is in the admin log. Blocked accounts show as Blocked on Home.</p>
${
  csrf
    ? `<form method="post" action="/admin/dashboard/tools#block"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="tool" value="block">
<label class="field"><span>GitHub username</span><input type="text" name="login" value="${escapeHtml(block.login)}" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>
<div class="row"><button class="btn primary" type="submit" name="action" value="block">Block</button><button class="btn" type="submit" name="action" value="unblock">Unblock</button></div>
${notice}
</form>`
    : `<p class="hint">Sign in at /admin in a browser to use this.</p>`
}
</section>`;
}

/**
 * "Routing" (primaryUpstream): one button per upstream, the current one pressed. Only with a
 * CSRF token (a browser session); an upstream without a key can't be chosen.
 */
function routingCard(state: ToolsState): string {
  const { csrf, routing } = state;
  const secret = { openai: "OPENAI_API_KEY", luminal: "LUMINAL_API_KEY", openrouter: "OPENROUTER_API_KEY" } as const;
  const button = (upstream: "openai" | "luminal" | "openrouter", label: string, configured: boolean) => {
    if (routing.primaryUpstream === upstream) return `<button type="button" class="btn primary" disabled aria-pressed="true">${label}</button>`;
    if (!configured || !csrf) return `<button type="button" class="btn" disabled${configured ? "" : ` title="No ${secret[upstream]}"`}>${label}</button>`;
    return `<form method="post" action="/admin/dashboard/upstream"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="upstream" value="${upstream}"><button class="btn" type="submit">${label}</button></form>`;
  };
  return `<section class="card" id="upstream" aria-label="Routing">
<h2>Routing</h2>
<p class="lede">This setting doesn't move GPT-6 traffic: GPT-6 models always go to OpenAI and DeepSeek to Luminal. OpenAI and Luminal route the same; they only pick whose weekly credit budget the waiting line watches (OpenAI is the default). OpenRouter sends DeepSeek requests to OpenRouter, paid in cash instead of Luminal credit, until you switch back; GPT-6 stays on OpenAI.${routing.openRouterConfigured ? "" : " OpenRouter can't be chosen: the service has no OPENROUTER_API_KEY."} It takes effect on the next request, nothing switches back on its own, and each switch is in the admin log.</p>
<div class="row switch">${button("openai", "OpenAI", routing.openaiConfigured)}${button("luminal", "Luminal", routing.luminalConfigured)}${button("openrouter", "OpenRouter", routing.openRouterConfigured)}</div>
${csrf ? "" : `<p class="hint">Sign in at /admin in a browser to switch.</p>`}
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
 * GET /admin?view=tools, and what POST /admin/dashboard/tools answers: the actions. Access
 * requests, "Give free tokens" (paste GitHub usernames), block or unblock, the routing setting,
 * the below-bar re-check, "Write an email" (a plain one-off email to a level and a sign-up range,
 * with a test, a preview and an in-page confirm) and the GPU early-access leads.
 */
export function toolsPage(state: ToolsState): Response {
  const header = `<header class="bar"><div>
<a class="brand" href="/admin"><span class="logo"><img src="${BRAND_ORIGIN}/logo-64.webp" alt="" width="22" height="22"></span><b>${escapeHtml(PRODUCT_NAME)} admin</b></a>
${adminNav("tools")}
${state.signOut ? `<form method="post" action="/admin/signout"><button type="submit" class="out">Sign out</button></form>` : ""}
</div></header>`;
  const cards = [requestsCard(state), grantCard(state), blockCard(state), routingCard(state), recheckCard(state), emailCard(state), leadsCard(state)];
  return shell(`Tools · ${PRODUCT_NAME}`, `${header}\n<main class="tools">\n${cards.join("\n")}\n</main>`, 200, {}, "", TOOLS_STYLE);
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
