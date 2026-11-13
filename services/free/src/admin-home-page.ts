import { escapeHtml } from "../../shared/src/html.js";
import { realAllowance, USAGE_PERIODS, type AdminGrantRow, type AdminHomeData, type AdminUserRow, type LevelSettings, type UsagePeriod, type UsagePeriodKind } from "./admin-home-data.js";
import { adminNav, barPath, compact, creditProviders, shell, SIMPLE_STYLE, spendTotals, type SpendView } from "./dashboard-page.js";
import { BRAND_ORIGIN, PRODUCT_NAME } from "./pages.js";
import { DAY_MS } from "./week.js";

/**
 * The admin home (GET /admin): the data the old Kimiflare Cloud admin dashboard showed, in dl's
 * model, on one page. Six stat cards, Platform Health and the paid plans, usage per day, week or
 * month, every user in a sortable, searchable table, and the admin-set personal caps (active and
 * ended). The actions (grants, requests, blocking, routing, emails) are on the Tools page.
 * Server-rendered; one small script (nonce'd) sorts and searches the users table, and the page
 * reads fine without it.
 */

/** What the page needs besides the data: the allowance settings, Pro's caps and price, and the spend counters. */
export interface AdminHomeInput {
  data: AdminHomeData;
  spend: SpendView;
  settings: LevelSettings & { proWeeklyUsd: number | null; proDeepseekWeeklyUsd: number | null; proPriceUsdMonthly: number };
  login: string;
  signOut: boolean;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthDay = (ms: number) => `${MONTHS[new Date(ms).getUTCMonth()]} ${new Date(ms).getUTCDate()}`;
const date = (ms: number | null) => (ms === null ? "—" : `${monthDay(ms)}, ${new Date(ms).getUTCFullYear()}`);

/** Dollars: cents under $100, whole dollars above. */
export function dollars(value: number): string {
  if (value >= 100) return `$${Math.round(value).toLocaleString("en-US")}`;
  return `$${value.toFixed(2)}`;
}

/** A cap: "no cap" for none. */
const capText = (value: number | null) => (value === null ? "no cap" : dollars(value));

const PLAN_LABELS = { pro: "Pro", past_due: "Past due", canceled: "Canceled", free: "Free", blocked: "Blocked" } as const;

/** Blocked overrides the plan: it's what decides whether the account is served. */
export function planLabel(user: Pick<AdminUserRow, "plan" | "status">): (typeof PLAN_LABELS)[keyof typeof PLAN_LABELS] {
  return user.status === "blocked" ? PLAN_LABELS.blocked : PLAN_LABELS[user.plan];
}

/**
 * A person's weekly dollar caps and what's left this week. Pro (and past due) get Pro's caps;
 * everyone else their personal cap if an admin set one, else their level's. Remaining is the
 * GPT-6 budget less this week's GPT-6 spend from the daily roll-up (an admin's weekly reset
 * isn't seen there); none for Pro, whose use is paid, for blocked accounts, and for no cap.
 */
export function userCaps(user: AdminUserRow, settings: AdminHomeInput["settings"]): { usd: number | null; deepseekUsd: number | null; own: boolean; remaining: number | null; deepseekRemaining: number | null } {
  if (user.plan === "pro" || user.plan === "past_due") return { usd: settings.proWeeklyUsd, deepseekUsd: settings.proDeepseekWeeklyUsd, own: false, remaining: null, deepseekRemaining: null };
  const allowance = realAllowance({ level: user.level, batchFlagged: user.batchFlagged, grantTokens: user.grantTokens, grantUsd: user.grantUsd }, settings);
  const blocked = user.status === "blocked";
  return {
    usd: allowance.usd,
    deepseekUsd: allowance.deepseekUsd,
    own: user.grantUsd !== null,
    remaining: blocked || allowance.usd === null ? null : Math.max(0, allowance.usd - user.weekGptUsd),
    deepseekRemaining: blocked || allowance.deepseekUsd === null ? null : Math.max(0, allowance.deepseekUsd - user.weekDeepseekUsd),
  };
}

/**
 * The global budget, as the old Kimiflare dashboard showed it: all-time credit used across the
 * providers against their total prepaid credit (OpenAI + Luminal). Without credit configured,
 * all-time spend against the global all-time cap.
 */
export function globalBudget(spend: SpendView): { usedUsd: number; totalUsd: number | null } {
  const providers = creditProviders(spend).filter((row) => row.configured);
  if (providers.length > 0) {
    return { usedUsd: providers.reduce((sum, row) => sum + row.usedUsd, 0), totalUsd: providers.reduce((sum, row) => sum + row.balanceUsd, 0) };
  }
  return { usedUsd: spendTotals(spend).allTimeUsd, totalUsd: spend.totalCapUsd };
}

const STYLE = `${SIMPLE_STYLE}
main.home { display: block; }
main.home > section { margin: 0 0 20px; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; margin: 0 0 20px; }
.stat { background: var(--k-card); border: 1px solid var(--k-border); border-radius: 10px; padding: 14px 16px; box-shadow: var(--k-shadow); display: grid; gap: 2px; min-width: 0; }
.stat b { font-size: 22px; font-weight: 700; letter-spacing: -.02em; line-height: 1.2; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.stat span { font-size: 12.5px; color: var(--k-muted); font-weight: 500; }
.stat small { font-size: 11.5px; color: var(--k-faint); }
.two { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; }
.quick { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; }
.quick div { background: var(--k-bg); border-radius: 8px; padding: 10px 12px; display: grid; gap: 2px; }
.quick b { font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; }
.quick span { font-size: 12px; color: var(--k-muted); }
.card h2 { color: var(--k-text); font-size: 15px; margin: 0 0 12px; }
.card h2 .n { color: var(--k-muted); font-weight: 500; }
.head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; margin: 0 0 12px; }
.head h2 { margin: 0; }
.tabs { display: inline-flex; gap: 2px; padding: 3px; border: 1px solid var(--k-border); border-radius: 8px; background: var(--k-bg); }
.tabs input { position: absolute; opacity: 0; pointer-events: none; }
.tabs label { padding: 4px 12px; border-radius: 6px; font-size: 13px; font-weight: 500; color: var(--k-muted); cursor: pointer; }
.usage > .panel { display: none; }
#p-day:checked ~ .head .tabs label[for="p-day"], #p-week:checked ~ .head .tabs label[for="p-week"], #p-month:checked ~ .head .tabs label[for="p-month"] { background: var(--accent); color: #FFFFFF; }
#p-day:checked ~ .panel.day, #p-week:checked ~ .panel.week, #p-month:checked ~ .panel.month { display: block; }
.usage > input { position: absolute; opacity: 0; pointer-events: none; }
#p-day:focus-visible ~ .head .tabs label[for="p-day"], #p-week:focus-visible ~ .head .tabs label[for="p-week"], #p-month:focus-visible ~ .head .tabs label[for="p-month"] { outline: 2px solid var(--accent); outline-offset: 2px; }
.totals { display: flex; flex-wrap: wrap; gap: 6px 24px; margin: 0 0 12px; font-size: 12.5px; color: var(--k-muted); }
.totals b { display: block; font-size: 17px; color: var(--k-text); font-variant-numeric: tabular-nums; }
.tools-link { font-size: 13px; color: var(--k-muted); margin: 0 0 16px; }
.tools-link a { color: var(--k-text); font-weight: 600; }
.pager { display: flex; align-items: center; justify-content: flex-end; gap: 12px; margin: 12px 0 0; font-size: 13px; color: var(--k-muted); font-variant-numeric: tabular-nums; }
.pager button { min-height: 36px; padding: 6px 12px; border: 1px solid var(--k-border); border-radius: 8px; background: var(--k-bg); color: var(--k-text); font: inherit; cursor: pointer; }
.pager button:disabled { opacity: .4; cursor: default; }
.search { width: min(100%, 280px); min-height: 36px; padding: 6px 10px; border: 1px solid var(--k-border); border-radius: 8px; background: var(--k-bg); color: var(--k-text); font: 16px var(--body); }
.scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; border: 1px solid var(--k-border); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; font-variant-numeric: tabular-nums; }
th, td { padding: 7px 10px; text-align: right; white-space: nowrap; border-bottom: 1px solid var(--k-border); }
th:first-child, td:first-child { text-align: left; }
td.l, th.l { text-align: left; }
thead th { background: var(--k-card); font-size: 12px; font-weight: 600; color: var(--k-muted); }
th button { all: unset; cursor: pointer; display: inline-flex; gap: 4px; align-items: center; }
th button::after { content: "↕"; color: var(--k-faint); font-size: 11px; }
th[aria-sort="ascending"] button::after { content: "↑"; color: var(--accent); }
th[aria-sort="descending"] button::after { content: "↓"; color: var(--accent); }
th button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover td { background: color-mix(in srgb, var(--k-text) 3%, transparent); }
.sub { display: block; font-size: 11.5px; color: var(--k-faint); margin: 0; font-weight: 400; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11.5px; font-weight: 600; background: var(--k-bg); color: var(--k-muted); }
.badge.pro { color: var(--k-ok); background: var(--k-ok-bg); }
.badge.past_due { color: var(--k-flag); background: var(--k-flag-bg); }
.badge.blocked { color: var(--k-stop); background: var(--k-stop-bg); }
.badge.admin { color: var(--c-1); background: color-mix(in srgb, var(--c-1) 12%, transparent); margin-left: 6px; }
svg.meter { display: block; width: 64px; height: 4px; border-radius: 2px; margin: 3px 0 0 auto; }
svg.meter .track { fill: var(--k-border); }
svg.meter .left { fill: var(--c-3); }
svg.meter .low { fill: var(--k-stop); }
.empty { color: var(--k-muted); margin: 0; }
.card h2.gap { margin-top: 20px; }
.count { font-size: 12.5px; color: var(--k-muted); }
@media (max-width: 900px) { .two { grid-template-columns: minmax(0, 1fr); } }
svg.chart.narrow { display: none; }
@media (max-width: 760px) {
  svg.chart.wide { display: none; }
  svg.chart.narrow { display: block; }
  .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .stat { padding: 12px; }
  .stat b { font-size: 19px; }
}
`;

/** Users per page in the table. */
export const USERS_PER_PAGE = 50;

/**
 * Sorts the users table by any column (data-v, else the text), filters it by the search box and
 * shows it a page at a time. The server already hides every row past the first page.
 */
const SCRIPT = `(() => {
  const table = document.getElementById("users");
  if (!table) return;
  const PER = ${USERS_PER_PAGE};
  const body = table.tBodies[0];
  let rows = Array.from(body.rows);
  const search = document.getElementById("user-search");
  const shown = document.getElementById("user-count");
  const pager = document.getElementById("user-pager");
  const prev = document.getElementById("user-prev");
  const next = document.getElementById("user-next");
  const where = document.getElementById("user-page");
  let page = 0;
  let q = "";
  const render = () => {
    const hits = rows.filter((row) => !q || row.dataset.q.includes(q));
    const pages = Math.max(1, Math.ceil(hits.length / PER));
    if (page >= pages) page = pages - 1;
    const from = page * PER;
    const visible = new Set(hits.slice(from, from + PER));
    for (const row of rows) row.hidden = !visible.has(row);
    shown.textContent = q ? hits.length + " of " + rows.length : String(rows.length);
    where.textContent = hits.length === 0 ? "No users" : (from + 1) + "–" + Math.min(from + PER, hits.length) + " of " + hits.length;
    prev.disabled = page === 0;
    next.disabled = page >= pages - 1;
    pager.hidden = false;
  };
  search.hidden = false;
  search.addEventListener("input", () => { q = search.value.trim().toLowerCase(); page = 0; render(); });
  prev.addEventListener("click", () => { if (page > 0) { page--; render(); } });
  next.addEventListener("click", () => { page++; render(); });
  const heads = Array.from(table.tHead.rows[0].cells);
  heads.forEach((th, index) => {
    const button = th.querySelector("button");
    if (!button) return;
    button.addEventListener("click", () => {
      const numeric = th.dataset.type === "n";
      const dir = th.getAttribute("aria-sort") === (numeric ? "descending" : "ascending") ? (numeric ? "ascending" : "descending") : (numeric ? "descending" : "ascending");
      for (const other of heads) other.removeAttribute("aria-sort");
      th.setAttribute("aria-sort", dir);
      const value = (row) => { const cell = row.cells[index]; const v = cell.dataset.v ?? cell.textContent.trim().toLowerCase(); return numeric ? Number(v) : v; };
      const sign = dir === "ascending" ? 1 : -1;
      rows.sort((a, b) => { const x = value(a), y = value(b); return (x < y ? -1 : x > y ? 1 : 0) * sign; });
      for (const row of rows) body.appendChild(row);
      page = 0;
      render();
    });
  });
  render();
})();`;

function stat(label: string, value: string, note = ""): string {
  return `<div class="stat"><b>${value}</b><span>${escapeHtml(label)}</span>${note ? `<small>${escapeHtml(note)}</small>` : ""}</div>`;
}

function quick(label: string, value: string): string {
  return `<div><b>${value}</b><span>${escapeHtml(label)}</span></div>`;
}

const PERIOD_LABELS: Record<UsagePeriodKind, string> = { day: "Day", week: "Week", month: "Month" };

function periodLabel(kind: UsagePeriodKind, start: number): string {
  if (kind === "month") return `${MONTHS[new Date(start).getUTCMonth()]} ${String(new Date(start).getUTCFullYear()).slice(2)}`;
  return monthDay(start);
}

/**
 * Input and output tokens per period as paired columns; each pair's title has the exact numbers
 * and requests. Two drawings, wide and narrow, so the text stays readable on a phone.
 */
export function usageChart(kind: UsagePeriodKind, periods: UsagePeriod[], drawing: "wide" | "narrow" = "wide"): string {
  const width = drawing === "wide" ? 1100 : 360;
  const height = drawing === "wide" ? 220 : 200;
  const left = 44;
  const bottom = 22;
  const top = 8;
  const max = Math.max(1, ...periods.map((row) => Math.max(row.promptTokens, row.completionTokens)));
  const plotH = height - top - bottom;
  const slot = (width - left) / periods.length;
  const bar = Math.max(1, Math.min(18, (slot - 3) / 2));
  // Labels counted back from the latest period, so it always has one and they never touch.
  const every = Math.ceil(periods.length / (drawing === "wide" ? 12 : 5));
  const ticks = [0, 0.5, 1].map((share) => {
    const y = top + plotH * (1 - share);
    return `<line class="axis" x1="${left}" x2="${width}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"></line><text x="${left - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end">${compact(max * share)}</text>`;
  });
  const groups = periods.map((row, index) => {
    const x = left + index * slot + (slot - 2 * bar - 1) / 2;
    const h = (value: number) => (value / max) * plotH;
    const col = (value: number, dx: number, cls: string) => (value > 0 ? `<path class="${cls}" d="${barPath(x + dx, top + plotH - Math.max(h(value), 1), bar, Math.max(h(value), 1))}"></path>` : "");
    const label = (periods.length - 1 - index) % every === 0 ? `<text x="${(left + index * slot + slot / 2).toFixed(1)}" y="${height - 6}" text-anchor="middle">${escapeHtml(periodLabel(kind, row.start))}</text>` : "";
    const title = `${periodLabel(kind, row.start)}: ${row.promptTokens.toLocaleString("en-US")} input, ${row.completionTokens.toLocaleString("en-US")} output, ${row.requests.toLocaleString("en-US")} requests`;
    return `<g><title>${escapeHtml(title)}</title><rect class="hit" x="${(left + index * slot).toFixed(1)}" y="${top}" width="${slot.toFixed(1)}" height="${plotH}"></rect>${col(row.promptTokens, 0, "c1")}${col(row.completionTokens, bar + 1, "c2")}${label}</g>`;
  });
  return `<svg class="chart ${drawing}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Input and output tokens per ${kind}">${ticks.join("")}${groups.join("")}</svg>`;
}

function usagePanel(kind: UsagePeriodKind, periods: UsagePeriod[]): string {
  const sum = (key: "promptTokens" | "completionTokens" | "requests") => periods.reduce((total, row) => total + row[key], 0);
  const input = sum("promptTokens");
  const output = sum("completionTokens");
  const span = `last ${USAGE_PERIODS[kind]} ${kind}s`;
  return `<div class="panel ${kind}">
<div class="totals"><span>Input Tokens<b>${compact(input)}</b></span><span>Output Tokens<b>${compact(output)}</b></span><span>Total<b>${compact(input + output)}</b></span><span>Requests<b>${sum("requests").toLocaleString("en-US")}</b></span><span>Range<b>${escapeHtml(span)}</b></span></div>
<div class="legend"><span><i class="c1"></i>Input</span><span><i class="c2"></i>Output</span></div>
${usageChart(kind, periods, "wide")}
${usageChart(kind, periods, "narrow")}
</div>`;
}

/** What's left of a cap as a thin bar: an SVG, since the CSP allows no inline styles. */
function meter(left: number, cap: number | null): string {
  const share = cap && cap > 0 ? Math.min(1, left / cap) : 0;
  return `<svg class="meter" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true"><rect class="track" width="100" height="4"></rect><rect class="${share < 0.2 ? "low" : "left"}" width="${(share * 100).toFixed(1)}" height="4"></rect></svg>`;
}

function userCell(user: AdminUserRow): string {
  return `${escapeHtml(user.login)}${user.admin ? `<span class="badge admin">Admin</span>` : ""}`;
}

function usersTable(users: AdminUserRow[], settings: AdminHomeInput["settings"]): string {
  const head = (label: string, type: "n" | "s", initial?: "descending") =>
    `<th${type === "s" ? ` class="l"` : ""} data-type="${type}"${initial ? ` aria-sort="${initial}"` : ""}><button type="button">${escapeHtml(label)}</button></th>`;
  const rows = users.map((user, index) => {
    const caps = userCaps(user, settings);
    const plan = planLabel(user);
    const planClass = user.status === "blocked" ? "blocked" : user.plan;
    const limit =
      caps.usd === null && caps.deepseekUsd === null
        ? `<td data-v="-1">no cap</td>`
        : `<td data-v="${caps.usd ?? -1}">${capText(caps.usd)}${caps.own ? ` <span class="muted">own</span>` : ""}<span class="sub">DeepSeek ${capText(caps.deepseekUsd)}</span></td>`;
    const remaining =
      caps.remaining === null
        ? `<td data-v="-1">—</td>`
        : `<td data-v="${caps.remaining.toFixed(4)}">${dollars(caps.remaining)}${meter(caps.remaining, caps.usd)}${caps.deepseekRemaining === null ? "" : `<span class="sub">DeepSeek ${dollars(caps.deepseekRemaining)}</span>`}</td>`;
    return `<tr data-q="${escapeHtml(user.login.toLowerCase())}"${index >= USERS_PER_PAGE ? " hidden" : ""}>
<td data-v="${escapeHtml(user.login.toLowerCase())}">${userCell(user)}</td>
<td class="l"><span class="badge ${planClass}">${plan}</span></td>
${limit}
<td data-v="${user.promptTokens}">${compact(user.promptTokens)}</td>
${remaining}
<td data-v="${user.completionTokens}">${compact(user.completionTokens)}</td>
<td data-v="${user.costUsd.toFixed(6)}">${dollars(user.costUsd)}</td>
<td data-v="${user.requests}">${user.requests.toLocaleString("en-US")}</td>
<td data-v="${user.lastActiveAt ?? 0}">${date(user.lastActiveAt)}</td>
<td data-v="${user.networks}">${user.networks}</td>
<td data-v="${user.joinedAt}">${date(user.joinedAt)}</td>
</tr>`;
  });
  return `<div class="scroll"><table id="users">
<thead><tr>${head("User", "s")}${head("Plan", "s")}${head("Grant Limit", "n")}${head("Input Used", "n")}${head("Remaining", "n")}${head("Output", "n")}${head("Cost", "n")}${head("Requests", "n")}${head("Last Active", "n")}${head("Networks", "n")}${head("Joined", "n", "descending")}</tr></thead>
<tbody>
${rows.join("\n")}
</tbody>
</table></div>
<nav class="pager" id="user-pager" aria-label="Users pages" hidden><button type="button" id="user-prev">← Previous</button><span id="user-page"></span><button type="button" id="user-next">Next →</button></nav>`;
}

function grantsTable(rows: AdminGrantRow[], ended: boolean): string {
  if (rows.length === 0) return `<p class="empty">${ended ? "None." : "No personal caps set."}</p>`;
  const body = rows.map((row) => {
    const who = row.login ? escapeHtml(row.login) : `<span class="muted">#${row.githubId}</span>`;
    const tokens = row.weeklyTokens === null ? "—" : compact(row.weeklyTokens);
    const endedCells = ended ? `<td>${date(row.endedAt)}</td><td class="l">${escapeHtml(row.endedHow ?? "")}</td>` : "";
    return `<tr><td>${who}</td><td>${row.weeklyUsd === null ? "—" : dollars(row.weeklyUsd)}</td><td>${tokens}</td><td>${date(row.setAt)}</td>${endedCells}</tr>`;
  });
  return `<div class="scroll"><table>
<thead><tr><th>User</th><th>Weekly $ cap</th><th>Weekly tokens</th><th>Granted</th>${ended ? `<th>Ended</th><th class="l">How</th>` : ""}</tr></thead>
<tbody>${body.join("")}</tbody>
</table></div>`;
}

export function adminHomePage(input: AdminHomeInput): Response {
  const { data, spend, settings } = input;
  const budget = globalBudget(spend);
  const paying = data.subscriptions.active + data.subscriptions.pastDue;
  const totalTokens = data.totals.promptTokens + data.totals.completionTokens;
  const feedbackNote = data.feedback.sinceDay === null ? "none counted yet" : `since ${date(data.feedback.sinceDay * DAY_MS)}`;

  const header = `<header class="bar"><div>
<a class="brand" href="/admin"><span class="logo"><img src="${BRAND_ORIGIN}/logo-64.webp" alt="" width="22" height="22"></span><b>${escapeHtml(PRODUCT_NAME)} admin</b></a>
${adminNav("home")}
${input.signOut ? `<form method="post" action="/admin/signout"><button type="submit" class="out">Sign out</button></form>` : ""}
</div></header>`;

  const cards = `<div class="cards">
${stat("Total Users", data.totalUsers.toLocaleString("en-US"), `${data.blockedUsers.toLocaleString("en-US")} blocked`)}
${stat("Active Grants", data.activeGrants.length.toLocaleString("en-US"), "personal weekly caps")}
${stat("Global Budget", `${dollars(budget.usedUsd)} / ${budget.totalUsd === null ? "no cap" : dollars(budget.totalUsd)}`, "credit used, all time")}
${stat("Est. Cost", dollars(data.totals.costUsd), "all time, at list prices")}
${stat("Feedback", data.feedback.total.toLocaleString("en-US"), feedbackNote)}
${stat("7-Day Prompts", compact(data.last7.promptTokens), "input tokens, last 7 days")}
</div>`;

  const health = `<section class="card"><h2>Platform Health</h2><div class="quick">
${quick("Total Users", data.totalUsers.toLocaleString("en-US"))}
${quick("Active Grants", data.activeGrants.length.toLocaleString("en-US"))}
${quick("Total Cost", dollars(data.totals.costUsd))}
${quick("Total Tokens", compact(totalTokens))}
</div></section>`;

  const paid = `<section class="card"><h2>Paid</h2><div class="quick">
${quick("Paying Users", paying.toLocaleString("en-US"))}
${quick("Active", data.subscriptions.active.toLocaleString("en-US"))}
${quick("Past Due", data.subscriptions.pastDue.toLocaleString("en-US"))}
${quick("Canceled", data.subscriptions.canceled.toLocaleString("en-US"))}
${quick("MRR", dollars(paying * settings.proPriceUsdMonthly))}
${quick("Top-ups", data.payments.topups.toLocaleString("en-US"))}
${quick("Top-up Revenue", dollars(data.payments.topupCents / 100))}
</div></section>`;

  const kinds: UsagePeriodKind[] = ["day", "week", "month"];
  const usage = `<section class="card usage" id="usage">
${kinds.map((kind) => `<input type="radio" name="period" id="p-${kind}"${kind === "day" ? " checked" : ""}>`).join("")}
<div class="head"><h2>Usage Analytics</h2><div class="tabs" role="group" aria-label="Period">${kinds.map((kind) => `<label for="p-${kind}">${PERIOD_LABELS[kind]}</label>`).join("")}</div></div>
${kinds.map((kind) => usagePanel(kind, data.usage[kind])).join("\n")}
</section>`;

  const users = `<section class="card" id="users-card">
<div class="head"><h2>Users <span class="n">(<span id="user-count">${data.users.length}</span>)</span></h2><input type="search" id="user-search" class="search" placeholder="Search users" aria-label="Search users" autocomplete="off" hidden></div>
${usersTable(data.users, settings)}
</section>`;

  const grants = `<section class="card" id="grants">
<h2>Active Grants <span class="n">(${data.activeGrants.length})</span></h2>
${grantsTable(data.activeGrants, false)}
<h2 class="gap">Expired / Revoked <span class="n">(${data.endedGrants.length})</span></h2>
${grantsTable(data.endedGrants, true)}
</section>`;

  const body = `${header}
<main class="home">
<p class="tools-link">Grants, requests, blocking, routing and emails are on <a href="/admin?view=tools">Tools</a>. Admins are left out of every total and marked in the table.</p>
${cards}
<div class="two">${health}${paid}</div>
${usage}
${users}
${grants}
</main>`;
  return shell(`Admin · ${PRODUCT_NAME}`, body, 200, {}, "", STYLE, SCRIPT);
}
