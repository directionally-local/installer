import { escapeHtml } from "../../shared/src/html.js";
import { DOWNLOAD_ROUTES } from "./telemetry.js";
import { COHORT_WEEKS, FUNNEL_DAYS, REGULAR_DAYS, RETENTION_OFFSETS, TOKEN_LIMIT_SHARE, WEEKS_SHOWN, type DashboardData, type InstallFunnelRow } from "./dashboard-data.js";
import { PRODUCT_NAME } from "./pages.js";
import { isoDay } from "./week.js";

/**
 * The admin dashboard as server-rendered HTML, plus a CSV of each table. No scripts, no
 * external fonts or images, no inline `style` attributes: the one stylesheet carries a
 * per-response nonce, so the page works under `default-src 'none'`. Colours are the system
 * colours (`Canvas`, `CanvasText`, …), so light and dark follow the device. Charts are small
 * inline SVGs with presentation attributes and a `<title>` per bar for the value.
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
  /** The upstream setting, and whether Luminal has a key (without one, OpenRouter serves). */
  primaryUpstream: "luminal" | "openrouter";
  luminalConfigured: boolean;
  /** Luminal credit: the balance, used since the start, used this week (all, and free usage only). */
  creditUsd: number;
  creditUsedUsd: number;
  creditWeekUsd: number;
  freeCreditWeekUsd: number;
  /** The weekly credit budget the queue protects; null for none. */
  weeklyCreditUsd: number | null;
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
    "content-security-policy": `default-src 'none'; style-src ${nonce ? `'nonce-${nonce}'` : "'none'"}; img-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

const STYLE = `
:root { color-scheme: light dark; --ink: CanvasText; --bg: Canvas; --muted: GrayText; --accent: #2f6fdb;
  --line: color-mix(in srgb, CanvasText 18%, Canvas); --soft: color-mix(in srgb, var(--accent) 35%, Canvas); }
@supports (color: AccentColor) { :root { --accent: AccentColor; } }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 64rem; padding: 1rem; font: 15px/1.45 system-ui, sans-serif; background: var(--bg); color: var(--ink); }
header { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; align-items: baseline; justify-content: space-between; }
h1 { font-size: 1.3rem; margin: 0.5rem 0; }
h2 { font-size: 1.1rem; margin: 2rem 0 0.5rem; }
h3 { font-size: 0.95rem; margin: 1.25rem 0 0.4rem; }
section { border-top: 1px solid var(--line); }
.muted, figcaption, .note { color: var(--muted); }
.note { font-size: 0.85rem; }
.head { display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; align-items: baseline; justify-content: space-between; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { padding: 0.3rem 0.5rem; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
th:first-child, td:first-child { text-align: left; }
th { font-weight: 600; font-size: 0.85rem; }
td.l, th.l { text-align: left; }
tr.sel td { font-weight: 600; }
a { color: LinkText; }
button { font: inherit; padding: 0.3rem 0.8rem; }
form { display: inline; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 0.75rem; }
.tile { border: 1px solid var(--line); border-radius: 6px; padding: 0.6rem 0.75rem; }
.tile b { display: block; font-size: 1.35rem; font-variant-numeric: tabular-nums; }
.state { font-weight: 600; }
svg { display: block; width: 100%; height: auto; max-height: 14rem; }
svg text { fill: var(--muted); font: 11px system-ui, sans-serif; }
.bar { fill: var(--accent); }
.bar-soft { fill: var(--soft); }
.track { fill: var(--line); }
.axis { stroke: var(--line); stroke-width: 1; }
.key { display: inline-block; width: 0.8rem; height: 0.8rem; border-radius: 2px; vertical-align: -0.1rem; margin-right: 0.3rem; background: var(--accent); }
.key.soft { background: var(--soft); }
.banner { background: #b3261e; color: #fff; border-radius: 6px; padding: 0.6rem 0.9rem; margin: 0.75rem 0; font-weight: 600; }
.alltime { border: 2px solid var(--line); border-radius: 8px; padding: 0.75rem 1rem; margin: 0.75rem 0; }
.alltime b { display: block; font-size: 2rem; font-variant-numeric: tabular-nums; }
`;

export function nonce(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function shell(title: string, body: string, status = 200, headers: Record<string, string> = {}, head = ""): Response {
  const styleNonce = nonce();
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${head}<title>${escapeHtml(title)}</title>
<style nonce="${styleNonce}">${STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", ...dashboardHeaders(styleNonce), ...headers } });
}

/** Signed out: one link that starts GitHub sign-in. */
export function signInPage(message?: string, status = 200): Response {
  return shell(
    `Admin · ${PRODUCT_NAME}`,
    `<h1>${escapeHtml(PRODUCT_NAME)}: admin</h1>
${message ? `<p role="alert"><strong>${escapeHtml(message)}</strong></p>` : ""}
<p>The usage dashboard is for admins. Sign in with the GitHub account listed as an admin.</p>
<p><a href="/admin/signin">Sign in with GitHub</a></p>`,
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
    `<h1>${escapeHtml(PRODUCT_NAME)}: admin</h1>
<p>Signed in as <strong>${escapeHtml(login)}</strong>. <a href="/admin">Open the dashboard</a>.</p>`,
    200,
    headers,
    `<meta http-equiv="refresh" content="0;url=/admin">\n`,
  );
}

export function deniedPage(heading: string, message: string, status: number, headers: Record<string, string> = {}): Response {
  return shell(`${heading} · ${PRODUCT_NAME}`, `<h1>${escapeHtml(heading)}</h1>\n<p>${escapeHtml(message)}</p>\n<p><a href="/admin">Back</a></p>`, status, headers);
}

// ─── Formatting ───────────────────────────────────────────────────────────

const day = (ms: number) => isoDay(ms);
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const weekday = (ms: number) => `${WEEKDAYS[new Date(ms).getUTCDay()]} ${isoDay(ms)}`;

function usd(value: number | null): string {
  if (value === null) return "–";
  if (value === 0) return "$0";
  if (value >= 100) return `$${value.toFixed(0)}`;
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

// ─── The page ─────────────────────────────────────────────────────────────

export function dashboardPage(input: { data: DashboardData; spend: SpendView; login: string; signOut: boolean }): Response {
  const { data, spend } = input;
  const currentWeek = data.currentWeek;
  const thisOrDate = (week: number) => (week === currentWeek ? `${day(week)} (this week)` : day(week));

  const weeklyCapReached = spend.weeklyCapUsd !== null && spend.weekUsd >= spend.weeklyCapUsd;
  const luminalServing = spend.primaryUpstream === "luminal" && spend.luminalConfigured;
  const creditShare = spend.creditUsd > 0 ? spend.creditUsedUsd / spend.creditUsd : spend.creditUsedUsd > 0 ? 1 : 0;
  const creditOut = luminalServing && spend.creditUsedUsd >= spend.creditUsd;
  const totalCapReached = spend.totalCapUsd !== null && spend.totalUsd >= spend.totalCapUsd;
  const state = spend.paused
    ? `Paused for everyone${spend.pausedByEnv ? " (PAUSED in env)" : " (admin switch)"}`
    : creditOut
      ? "Paused: Luminal credit used up (upstream_credit_exhausted)"
      : totalCapReached
      ? "Free tokens stopped: total budget reached"
      : weeklyCapReached
        ? `Free tokens stopped until ${weekday(spend.resetsAt)}: weekly budget reached`
        : "Serving";

  const weekShare = spend.weeklyCapUsd !== null && spend.weeklyCapUsd > 0 ? spend.weekUsd / spend.weeklyCapUsd : 0;
  const totalShare = spend.totalCapUsd !== null && spend.totalCapUsd > 0 ? spend.totalUsd / spend.totalCapUsd : 0;
  const warnings = [
    ...(weekShare >= BANNER_SHARE ? [`${percent(weekShare)} of the ${cap(spend.weeklyCapUsd)} weekly cap used (${usd(spend.weekUsd)}).`] : []),
    ...(totalShare >= BANNER_SHARE ? [`${percent(totalShare)} of the ${cap(spend.totalCapUsd)} all-time cap used (${usd(spend.totalUsd)}).`] : []),
    ...(creditShare >= BANNER_SHARE ? [`${percent(creditShare)} of the ${usd(spend.creditUsd)} Luminal credit used (${usd(spend.creditUsedUsd)}).`] : []),
  ];
  const banner = warnings.length > 0 ? `<p class="banner" role="alert">${warnings.map(escapeHtml).join(" ")}</p>` : "";
  const allTime = `<div class="alltime">All-time free cash spend<b>${usd(spend.totalUsd)} <span class="muted">of ${escapeHtml(cap(spend.totalCapUsd))}</span></b>${meter(spend.totalUsd, spend.totalCapUsd, "all-time spend against the all-time cap")}<span class="note">${spend.totalCapUsd === null ? "No all-time cap." : `${usd(Math.max(0, spend.totalCapUsd - spend.totalUsd))} left. Free tokens stop at the cap.`}</span></div>`;

  const spendSection = `<section>
<div class="head"><h2>Global spend</h2>${csvLink("spend")}</div>
<div class="tiles">
<div class="tile">This week, since ${escapeHtml(day(currentWeek))}<b>${usd(spend.weekUsd)} <span class="muted">of ${escapeHtml(cap(spend.weeklyCapUsd))}</span></b>${meter(spend.weekUsd, spend.weeklyCapUsd, "weekly spend against the weekly cap")}<span class="note">Resets ${escapeHtml(weekday(spend.resetsAt))} 00:00 UTC</span></div>
<div class="tile">Since the start<b>${usd(spend.totalUsd)} <span class="muted">of ${escapeHtml(cap(spend.totalCapUsd))}</span></b>${meter(spend.totalUsd, spend.totalCapUsd, "total spend against the total cap")}<span class="note">Admin use, not counted: ${usd(spend.adminWeekUsd)} this week, ${usd(spend.adminTotalUsd)} in all</span></div>
<div class="tile">State<b class="state">${escapeHtml(state)}</b><span class="note">Admission: ${spend.openAdmission ? `open (old enough GitHub accounts${spend.requireGithubActivity ? " with a public repo or a contribution in the last year" : ""}); ${count(data.people.admitted)} admitted, no cap while open` : `invite-only; ${count(data.people.admitted)} of ${count(spend.maxActiveUsers)} admitted`}. GitHub activity check: ${spend.requireGithubActivity ? "on" : "off"}. Queue starts at ${escapeHtml(percent(spend.queueThreshold))} of the weekly cap. Per person: ${escapeHtml(tokens(spend.weeklyTokens))} tokens or ${escapeHtml(cap(spend.perPersonWeeklyUsd))} a week.</span></div>
</div>
<p class="note">Caps are the effective values, with admin overrides applied.</p>
</section>`;

  const upstreamRow = (row: DashboardData["upstreams"][number]) =>
    `<tr><td>${row.upstream === "luminal" ? "Luminal" : "OpenRouter"}</td><td>${count(row.requests)}</td><td>${count(row.errors)}${row.requests > 0 ? ` <span class="muted">(${percent(row.errors / row.requests)})</span>` : ""}</td><td>${ms(row.medianTtftMs)}</td><td>${ms(row.p90TtftMs)}</td><td>${ms(row.medianTtfbMs)}</td><td>${row.cacheHitShare === null ? "–" : percent(row.cacheHitShare)}</td><td>${usd(row.creditUsd)}</td><td>${usd(row.cashUsd)}</td></tr>`;
  const upstreamTable = (window: "today" | "week") => `<div class="scroll"><table>
<thead><tr><th>${window === "today" ? "Today (UTC)" : `This week, since ${escapeHtml(day(currentWeek))}`}</th><th>Requests</th><th>Errors</th><th>TTFT median</th><th>TTFT p90</th><th>TTFB median</th><th>Cache hits</th><th>Credit</th><th>Cash</th></tr></thead>
<tbody>
${data.upstreams.filter((row) => row.window === window).map(upstreamRow).join("\n")}
</tbody></table></div>`;
  const serving = luminalServing ? "Luminal" : spend.primaryUpstream === "luminal" ? "OpenRouter (no LUMINAL_API_KEY)" : "OpenRouter";
  const upstreamSection = `<section>
<div class="head"><h2>Upstreams</h2>${csvLink("upstreams")}</div>
<div class="tiles">
<div class="tile">Luminal credit used<b>${usd(spend.creditUsedUsd)} <span class="muted">of ${usd(spend.creditUsd)}</span></b>${meter(spend.creditUsedUsd, spend.creditUsd, "Luminal credit used against the balance")}<span class="note">${usd(Math.max(0, spend.creditUsd - spend.creditUsedUsd))} left. Luminal-served usage pauses at the balance.</span></div>
<div class="tile">Credit this week<b>${usd(spend.freeCreditWeekUsd)} <span class="muted">of ${escapeHtml(cap(spend.weeklyCreditUsd))}</span></b>${meter(spend.freeCreditWeekUsd, spend.weeklyCreditUsd, "free credit this week against the weekly credit budget")}<span class="note">Free usage; ${usd(spend.creditWeekUsd)} with admins and paid plans. The queue starts at ${escapeHtml(percent(spend.queueThreshold))} of the weekly credit budget.</span></div>
<div class="tile">Serving<b class="state">${escapeHtml(serving)}</b><span class="note">primaryUpstream: ${escapeHtml(spend.primaryUpstream)}. No automatic switch between upstreams.</span></div>
</div>
${upstreamTable("today")}
${upstreamTable("week")}
<p class="note">Admins included. TTFT: time to the first content chunk (text, reasoning or a tool call); TTFB: time to the response headers. Errors: 429, 5xx, timeouts, unreachable and failed streams. Credit is Luminal's prepaid credit at its list prices; cash is OpenRouter's reported cost, the only spend the caps count.</p>
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

  const limitsSection = `<section>
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

  const header = `<header>
<h1>${escapeHtml(PRODUCT_NAME)}: admin</h1>
<span class="muted">Signed in as <strong>${escapeHtml(input.login)}</strong>${
    input.signOut ? ` · <form method="post" action="/admin/signout"><button type="submit">Sign out</button></form>` : ""
  }</span>
</header>
<p class="note">${count(data.people.admitted)} people admitted, ${count(data.people.activeThisWeek)} active this week. Admins are left out of every number. Updated ${escapeHtml(new Date(data.now).toISOString().slice(0, 16).replace("T", " "))} UTC. Counts, tokens, cost and times only.</p>`;

  return shell(`Admin · ${PRODUCT_NAME}`, [header, banner, allTime, spendSection, upstreamSection, queueSection, referralSection, paidSection, funnelSection, activeSection, retentionSection, costSection, limitsSection].join("\n"));
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
