import { escapeHtml } from "../../shared/src/html.js";
import { barPath, creditProviders, grantUsdInput, ownCapText, shell, SIMPLE_STYLE, type SpendView } from "./dashboard-page.js";
import { atCap, GPU_DAYS, modelName, realAllowance, type HomeData, type HomePerson, type Tier } from "./home-data.js";
import { BRAND_ORIGIN, PRODUCT_NAME } from "./pages.js";
import type { PendingAccessRequest } from "./directory-object.js";
import { DAY_MS, WEEK_MS } from "./week.js";

/**
 * The admin home screen (GET /admin): four questions, each answered in one plain sentence, readable
 * on a phone in half a minute. "Are we OK?" (spend against the weekly budget and the credit left),
 * "Who's using it?", "Is anything broken?" (at most three problems, worst first, from fixed
 * thresholds) and "What needs me?" (pending /request asks, with Grant and Decline). When anything
 * is pending, "What needs me?" comes first. The detailed views (Simple, Full, Health, Tools) are
 * one row of links at the bottom. Server-rendered, no scripts, same CSP and look as the Simple view.
 */

// ─── Thresholds ───────────────────────────────────────────────────────────

/** "Watch it" when this week's spend at this pace would pass this share of the weekly budget. */
export const WATCH_BUDGET_SHARE = 0.5;
/** "Act now" past this share. */
export const ACT_BUDGET_SHARE = 0.8;
/** "Watch it" when the credit left lasts fewer weeks than this at this pace. */
export const WATCH_CREDIT_WEEKS = 8;
/** "Act now" below this many weeks. */
export const ACT_CREDIT_WEEKS = 4;
/** The week's own pace is used once this much of it has gone; before that, the last 7 days' average. */
export const PACE_MIN_ELAPSED_MS = DAY_MS;

/** A model whose requests fail more than this share this week is a problem (with at least MIN_REQUESTS). */
export const MODEL_FAIL_SHARE = 0.1;
/** An install platform failing more than this share this week (with at least MIN_INSTALLS). */
export const INSTALL_FAIL_SHARE = 0.15;
/** Sessions this week ending without a normal exit above this share (with at least MIN_SESSIONS). */
export const SESSION_ABNORMAL_SHARE = 0.25;
/** A provider failing at least this share of requests today, and at least SPIKE_FACTOR times its week's share. */
export const SPIKE_SHARE = 0.1;
export const SPIKE_FACTOR = 2;
export const MIN_REQUESTS = 20;
export const MIN_INSTALLS = 5;
export const MIN_SESSIONS = 20;
/** At most this many problems are shown. */
export const MAX_PROBLEMS = 3;
/** Rows in "Who's using it?" and request cards in "What needs me?". */
export const TOP_PEOPLE = 5;
export const MAX_REQUEST_CARDS = 5;

// ─── Words and numbers ────────────────────────────────────────────────────

/** Whole dollars from $10 up ("$1,969"), cents below ("$4.50"). */
export function money(value: number): string {
  if (value <= 0) return "$0";
  if (value >= 9.995) return `$${Math.round(value).toLocaleString("en-US")}`;
  if (value < 0.01) return "under 1 cent";
  return `$${value.toFixed(2)}`;
}

export function wholePercent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** "kenji, mara and 2 more". */
function names(list: string[]): string {
  if (list.length <= 1) return list.join("");
  if (list.length <= 3) return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
  return `${list.slice(0, 3).join(", ")} and ${list.length - 3} more`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const monthDay = (ms: number) => `${MONTHS[new Date(ms).getUTCMonth()]} ${new Date(ms).getUTCDate()}`;

/** "just now", "3 hours ago", "yesterday", "4 days ago", "Oct 2". */
export function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 60) return minutes < 2 ? "just now" : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  return monthDay(at);
}

/** "account 3 years old", "account 40 days old". */
export function accountAge(days: number | null): string {
  if (days === null) return "account age unknown";
  if (days >= 730) return `account ${Math.floor(days / 365)} years old`;
  if (days >= 365) return "account 1 year old";
  return `account ${plural(days, "day")} old`;
}

const PROVIDER = { openai: "OpenAI", luminal: "Luminal", openrouter: "OpenRouter" } as const;
const OS = { darwin: "macOS", linux: "Linux", win32: "Windows" } as Record<string, string>;

// ─── 1. Are we OK? ────────────────────────────────────────────────────────

export type Verdict = "Fine" | "Watch it" | "Act now";

export interface Outlook {
  verdict: Verdict;
  /** Why it isn't fine, in plain words; empty when it is. */
  reasons: string[];
  /** Free use this week (OpenAI and Luminal credit, OpenRouter cash), admins and paid plans left out. */
  spentUsd: number;
  /** The configured providers' weekly credit budgets added up; null for none. */
  budgetUsd: number | null;
  /** This week's free use by the reset at this pace. */
  projectedUsd: number;
  credits: Array<{ name: string; leftUsd: number }>;
  /** Weeks the credit left lasts at this pace (everyone's use); null without spend. */
  weeksLeft: number | null;
  /** Paused by the switch, no provider key, or a provider's credit used up. */
  stopped: "paused" | "no_key" | null;
  creditOut: string[];
  sentence: string;
}

/**
 * The spend verdict. Pace: once a day of the week has gone, this week's spend over the time gone;
 * before that, the average day of the last 7 full days (from the chart's numbers). Act now past
 * ACT_BUDGET_SHARE of the weekly budget or under ACT_CREDIT_WEEKS of credit, or when free requests
 * can't be served; watch it past WATCH_BUDGET_SHARE, under WATCH_CREDIT_WEEKS, or while paused.
 */
export function outlook(spend: SpendView, home: Pick<HomeData, "now" | "weekStart" | "spendDays">): Outlook {
  const providers = creditProviders(spend).filter((row) => row.configured || row.usedUsd > 0);
  const spentUsd = providers.reduce((sum, row) => sum + row.freeWeekUsd, 0) + spend.weekUsd;
  const allWeekUsd = providers.reduce((sum, row) => sum + row.weekUsd, 0);
  const budgets = providers.filter((row) => row.configured && row.weeklyBudgetUsd !== null);
  const budgetUsd = budgets.length > 0 ? budgets.reduce((sum, row) => sum + row.weeklyBudgetUsd!, 0) : null;

  const elapsed = Math.max(0, home.now - home.weekStart);
  const remaining = Math.max(0, home.weekStart + WEEK_MS - home.now);
  const today = Math.floor(home.now / DAY_MS) * DAY_MS;
  const lastWeekDays = home.spendDays.filter((row) => row.day < today).slice(-7);
  const recentPerMs = lastWeekDays.reduce((sum, row) => sum + row.openai + row.luminal + row.openrouter, 0) / (7 * DAY_MS);
  const early = elapsed < PACE_MIN_ELAPSED_MS;
  const freePerMs = early ? recentPerMs : spentUsd / elapsed;
  const allPerMs = early ? recentPerMs : allWeekUsd / elapsed;
  const projectedUsd = spentUsd + freePerMs * remaining;

  const configured = providers.filter((row) => row.configured);
  const credits = configured.map((row) => ({ name: row.name, leftUsd: Math.max(0, row.balanceUsd - row.usedUsd) }));
  const leftUsd = credits.reduce((sum, row) => sum + row.leftUsd, 0);
  const weeklyBurn = allPerMs * WEEK_MS;
  const weeksLeft = configured.length > 0 && weeklyBurn > 0 ? leftUsd / weeklyBurn : null;
  const creditOut = configured.filter((row) => row.usedUsd >= row.balanceUsd).map((row) => row.name);
  const stopped = spend.paused ? "paused" : spend.serving === "none" ? "no_key" : null;

  const reasons: string[] = [];
  let act = false;
  let watch = false;
  if (stopped === "no_key") {
    act = true;
    reasons.push("Free requests aren't being served: no provider key is set.");
  } else if (stopped === "paused") {
    watch = true;
    reasons.push("Free tokens are paused for everyone.");
  }
  if (creditOut.length > 0) {
    act = true;
    reasons.push(`${names(creditOut)} credit is used up.`);
  }
  const share = budgetUsd !== null && budgetUsd > 0 ? projectedUsd / budgetUsd : null;
  if (share !== null && share > ACT_BUDGET_SHARE) act = true;
  else if (share !== null && share > WATCH_BUDGET_SHARE) watch = true;
  if (weeksLeft !== null && weeksLeft < ACT_CREDIT_WEEKS) act = true;
  else if (weeksLeft !== null && weeksLeft < WATCH_CREDIT_WEEKS) watch = true;
  const verdict: Verdict = act ? "Act now" : watch ? "Watch it" : "Fine";

  const spentPart = budgetUsd !== null ? `${money(spentUsd)} spent this week of a ${money(budgetUsd)} weekly budget` : `${money(spentUsd)} spent this week`;
  const pacePart = freePerMs > 0 ? `; at this pace about ${money(projectedUsd)} by Monday.` : ".";
  const weeksText = weeksLeft === null ? "" : weeksLeft >= 52 ? ", more than a year at this pace" : weeksLeft < 1 ? ", less than a week at this pace" : `, about ${plural(Math.round(weeksLeft), "week")} at this pace`;
  const creditPart = credits.length > 0 ? ` Credits left: ${credits.map((row) => `${money(row.leftUsd)} ${row.name}`).join(", ")}${weeksText}.` : "";
  const sentence = `${verdict}. ${reasons.length > 0 ? `${reasons.join(" ")} ` : ""}${spentPart}${pacePart}${creditPart}`;
  return { verdict, reasons, spentUsd, budgetUsd, projectedUsd, credits, weeksLeft, stopped, creditOut, sentence };
}

// ─── 2. Who's using it? ───────────────────────────────────────────────────

const TIER_WORDS: Record<Tier, string> = { full: "full", middle: "middle", small: "small", "no tokens": "no tokens" };

export interface PersonRow {
  githubId: number;
  login: string | null;
  tier: Tier;
  costUsd: number;
  capUsd: number | null;
  /** The cap is an admin's personal one (a grant), not the level's. */
  ownCap: boolean;
  atCap: boolean;
}

export function personRows(people: readonly HomePerson[], spend: SpendView): PersonRow[] {
  return people.map((person) => {
    const allowance = realAllowance(person, spend);
    return { githubId: person.githubId, login: person.login, tier: allowance.tier, costUsd: person.costUsd, capUsd: allowance.usd, ownCap: person.grantUsd !== null, atCap: atCap(person, allowance) };
  });
}

export function usersSentence(home: Pick<HomeData, "people">): string {
  const { today, week, signupsToday } = home.people;
  const used = `${plural(today, "person", "people")} used dl today, ${week.toLocaleString("en-US")} this week.`;
  return `${used} ${signupsToday === 0 ? "No new sign-ups today." : `${plural(signupsToday, "new sign-up")} today.`}`;
}

/** "GPUs (7 days): 12 Nvidia, 3 AMD, 1 Ascend · 5 chose own GPUs · 2 early access", or null with none. */
export function gpuSentence(home: Pick<HomeData, "gpus">): string | null {
  const { nvidia, amd, ascend, ownGpus, earlyAccess } = home.gpus;
  if (nvidia + amd + ascend + ownGpus + earlyAccess === 0) return null;
  const n = (value: number) => value.toLocaleString("en-US");
  return `GPUs (${GPU_DAYS} days): ${n(nvidia)} Nvidia, ${n(amd)} AMD, ${n(ascend)} Ascend · ${n(ownGpus)} chose own GPUs · ${n(earlyAccess)} early access`;
}

// ─── 3. Is anything broken? ───────────────────────────────────────────────

export interface Problem {
  /** Higher is worse; the list is sorted by it. */
  severity: number;
  text: string;
  href: string;
}

/** Every problem the data shows, worst first; the page shows MAX_PROBLEMS. */
export function problems(home: HomeData, spend: SpendView, view: Outlook = outlook(spend, home), people: PersonRow[] = personRows(home.spenders, spend)): Problem[] {
  const found: Problem[] = [];
  const budget = "/admin?view=full#budget";
  if (view.stopped === "no_key") found.push({ severity: 100, text: "Free requests aren't being served: no provider key is set.", href: budget });
  if (view.creditOut.length > 0) found.push({ severity: 100, text: `${names(view.creditOut)} credit is used up.`, href: budget });
  if (view.budgetUsd !== null && view.budgetUsd > 0) {
    const share = view.projectedUsd / view.budgetUsd;
    if (share > WATCH_BUDGET_SHARE) {
      found.push({
        severity: share > ACT_BUDGET_SHARE ? 90 : 40,
        text: `At this pace spend reaches ${money(view.projectedUsd)} by Monday, ${wholePercent(share)} of the weekly budget.`,
        href: budget,
      });
    }
  }
  if (view.weeksLeft !== null && view.weeksLeft < WATCH_CREDIT_WEEKS) {
    found.push({
      severity: view.weeksLeft < ACT_CREDIT_WEEKS ? 90 : 40,
      text: view.weeksLeft < 1 ? "The credit left runs out within a week at this pace." : `The credit left runs out in about ${plural(Math.round(view.weeksLeft), "week")} at this pace.`,
      href: budget,
    });
  }
  // A provider failing much more today than over the week.
  for (const upstream of ["openai", "luminal", "openrouter"] as const) {
    const today = home.providers.find((row) => row.upstream === upstream && row.window === "today");
    const week = home.providers.find((row) => row.upstream === upstream && row.window === "week");
    if (!today || today.requests < MIN_REQUESTS) continue;
    const todayShare = today.errors / today.requests;
    const weekShare = week && week.requests > 0 ? week.errors / week.requests : 0;
    if (todayShare >= SPIKE_SHARE && todayShare >= SPIKE_FACTOR * weekShare) {
      found.push({ severity: 70 + 20 * todayShare, text: `${PROVIDER[upstream]} fails ${wholePercent(todayShare)} of requests today, against ${wholePercent(weekShare)} this week.`, href: "/admin?view=full#upstream" });
    }
  }
  for (const model of home.models) {
    if (model.requests < MIN_REQUESTS) continue;
    const share = model.failed / model.requests;
    if (share > MODEL_FAIL_SHARE) found.push({ severity: 50 + 40 * share, text: `${modelName(model.model)} requests fail ${wholePercent(share)} of the time this week.`, href: "/admin?view=health#errors" });
  }
  if (home.sessions.judged >= MIN_SESSIONS) {
    const share = home.sessions.abnormal / home.sessions.judged;
    if (share > SESSION_ABNORMAL_SHARE) found.push({ severity: 30 + 20 * share, text: `${wholePercent(share)} of sessions this week ended without a normal exit.`, href: "/admin?view=health#ends" });
  }
  for (const row of home.installs) {
    const total = row.ok + row.failed;
    if (total < MIN_INSTALLS) continue;
    const share = row.failed / total;
    if (share > INSTALL_FAIL_SHARE) {
      found.push({ severity: 30 + 30 * share, text: `${OS[row.os] ?? row.os} ${row.arch} ${row.mode} installs fail ${wholePercent(share)} of the time this week.`, href: "/admin?view=health#installs" });
    }
  }
  const capped = people.filter((row) => row.atCap);
  if (capped.length > 0) {
    const who = names(capped.map((row) => row.login ?? `#${row.githubId}`));
    found.push({ severity: 10, text: capped.length === 1 ? `${who} is at their weekly cap.` : `${capped.length} people are at their weekly cap: ${who}.`, href: "/admin?view=full#limits" });
  }
  return found.sort((a, b) => b.severity - a.severity);
}

// ─── Chart ────────────────────────────────────────────────────────────────

/** Spend per day, stacked by provider, oldest first; a value over today and the biggest day. */
function spendChart(days: HomeData["spendDays"], keys: Array<"openai" | "luminal" | "openrouter">, width: number, kind: "wide" | "narrow"): string {
  const height = 132;
  const top = 18;
  const bottom = 20;
  const plot = height - top - bottom;
  const total = (row: (typeof days)[number]) => keys.reduce((sum, key) => sum + row[key], 0);
  const max = Math.max(1, ...days.map(total));
  const slot = width / Math.max(1, days.length);
  const barWidth = Math.min(kind === "wide" ? 22 : 12, slot * 0.6);
  const biggest = days.reduce((best, row, index) => (total(row) > total(days[best]!) ? index : best), 0);
  const last = days.length - 1;
  const colour = { openai: "c1", luminal: "c2", openrouter: "c3" } as const;
  const parts = days.map((row, index) => {
    const x = index * slot + (slot - barWidth) / 2;
    let y = top + plot;
    const sum = total(row);
    const segments = keys
      .filter((key) => row[key] > 0)
      .map((key, i, shown) => {
        const h = (row[key] / max) * plot;
        y -= h;
        // The top segment gets the rounded end; the ones below stay square, with a 1.5px gap.
        const isTop = i === shown.length - 1;
        const gap = isTop ? 0 : 1.5;
        return h - gap > 0.5 ? (isTop ? `<path class="${colour[key]}" d="${barPath(x, y, barWidth, h)}"></path>` : `<rect class="${colour[key]}" x="${x.toFixed(1)}" y="${(y + gap).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${(h - gap).toFixed(1)}"></rect>`) : "";
      })
      .join("");
    const when = index === last ? "Today" : `${WEEKDAYS[new Date(row.day).getUTCDay()]!.slice(0, 3)} ${monthDay(row.day)}`;
    const split = keys.filter((key) => row[key] > 0).map((key) => `${PROVIDER[key]} ${money(row[key])}`).join(", ");
    const label = (index === last || (index === biggest && sum > 0)) && sum > 0;
    return `<g><title>${escapeHtml(`${when}: ${money(sum)}${split ? ` (${split})` : ""}`)}</title><rect class="hit" x="${(index * slot).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${height - bottom}"></rect>${segments}${
      label ? `<text class="v" x="${(x + barWidth / 2).toFixed(1)}" y="${(top + plot - (sum / max) * plot - 5).toFixed(1)}" text-anchor="middle">${escapeHtml(money(sum))}</text>` : ""
    }</g>`;
  });
  const first = days[0];
  return `<svg class="chart ${kind}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Spend per day, last ${days.length} days, by provider">
<line class="axis" x1="0" x2="${width}" y1="${top + plot + 0.5}" y2="${top + plot + 0.5}"></line>
${parts.join("\n")}
${first ? `<text x="0" y="${height - 4}">${escapeHtml(monthDay(first.day))}</text>` : ""}<text x="${width}" y="${height - 4}" text-anchor="end">today</text>
</svg>`;
}

/** A thin bar: spent against the cap. */
function capBar(spent: number, cap: number | null, at: boolean): string {
  const width = 100;
  const filled = cap === null || cap <= 0 ? 0 : Math.min(1, spent / cap) * width;
  return `<svg class="cap" viewBox="0 0 ${width} 6" preserveAspectRatio="none" aria-hidden="true"><rect class="track" x="0" y="0" width="${width}" height="6" rx="3"></rect>${
    filled > 0 ? `<rect class="${at ? "full" : "fill"}" x="0" y="0" width="${filled.toFixed(2)}" height="6" rx="3"></rect>` : ""
  }</svg>`;
}

// ─── The page ─────────────────────────────────────────────────────────────

const HOME_STYLE = `${SIMPLE_STYLE}
main.home { max-width: 40rem; grid-template-columns: minmax(0, 1fr); gap: 16px; }
.card h2 { font-size: 15px; font-weight: 600; color: var(--k-muted); margin: 0 0 6px; }
.say { font-size: 19px; line-height: 1.4; font-weight: 600; margin: 0 0 14px; color: var(--k-text); }
.say:last-child { margin-bottom: 0; }
.verdict { display: inline-block; padding: 0 8px; border-radius: 6px; margin-right: 2px; }
.verdict.fine { color: var(--k-ok); background: var(--k-ok-bg); }
.verdict.watch { color: var(--k-flag); background: var(--k-flag-bg); }
.verdict.act { color: var(--k-stop); background: var(--k-stop-bg); }
.legend { flex-wrap: wrap; }
.people { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.people li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 10px; align-items: baseline; font-size: 14px; }
.people .who { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.people a { color: var(--k-text); font: 600 14px var(--mono); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.people a:hover { text-decoration: underline; }
.people .tier { color: var(--k-muted); font-size: 12.5px; flex: none; }
.people .amt { font-variant-numeric: tabular-nums; color: var(--k-muted); font-size: 13px; text-align: right; }
.people .amt b { color: var(--k-text); font-weight: 600; }
.people svg.cap { grid-column: 1 / -1; width: 100%; height: 6px; display: block; }
svg.cap .track { fill: var(--k-border); }
svg.cap .fill { fill: var(--c-1); }
svg.cap .full { fill: var(--k-stop); }
.capword { color: var(--k-stop); font-weight: 600; font-size: 12.5px; }
.problems { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.problems li { padding: 10px 12px; border-radius: 8px; background: var(--k-flag-bg); font-size: 15px; line-height: 1.4; }
.problems a { color: var(--k-muted); font-size: 13px; white-space: nowrap; }
.reqs { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.req { border: 1px solid var(--k-border); border-radius: 10px; padding: 12px 14px; display: grid; gap: 6px; background: var(--k-bg); min-width: 0; }
.req p { margin: 0; }
.req-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 2px 10px; align-items: baseline; }
.req-head a { color: var(--k-text); font: 600 14px var(--mono); text-decoration: none; overflow-wrap: anywhere; }
.hint { margin: 0; font-size: 12.5px; color: var(--k-muted); }
.req-text { font-size: 14px; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.req form { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 4px 0 0; }
.usd-in { display: inline-flex; align-items: center; gap: 6px; font-size: 14px; color: var(--k-muted); }
.usd-in input { width: 5.5rem; font: 16px/1.45 var(--body); color: var(--k-text); background: var(--k-card); border: 1px solid var(--k-border); border-radius: 8px; padding: 7px 10px; margin: 0; min-height: 40px; }
.usd-in input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.btn { font: 600 14px var(--body); padding: 8px 16px; border-radius: 8px; border: 1px solid var(--k-border); background: var(--k-card); color: var(--k-text); cursor: pointer; min-height: 40px; }
.btn:hover { border-color: var(--k-muted); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #FFFFFF; }
.msg { margin: 0 0 12px; padding: 10px 12px; border-radius: 8px; font-size: 14px; background: var(--k-ok-bg); }
.msg.err { background: var(--k-stop-bg); }
.more { margin: 10px 0 0; font-size: 13px; }
.more a { color: var(--k-muted); }
.details { max-width: 40rem; margin: 0 auto; padding: 0 32px 40px; display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 13px; color: var(--k-muted); }
.details a { color: var(--k-muted); }
@media (max-width: 760px) { .details { padding: 0 16px 32px; } .say { font-size: 17px; } }
`;

export interface HomeInput {
  home: HomeData;
  spend: SpendView;
  requests: PendingAccessRequest[];
  /** The grantWeeklyUsdCap setting: the Grant forms' default weekly dollar cap (0: Full only). */
  grantUsd: number;
  signOut: boolean;
  /** Only with a browser session: the Grant and Decline forms need it. */
  csrf?: string;
  /** What the last Grant or Decline did. */
  notice?: { error: boolean; text: string };
}

/** Longest "what they're building" shown before the two-line clamp; the full text is on the Tools tab. */
const BUILDING_CHARS = 180;

function requestCard(request: PendingAccessRequest, now: number, csrf: string | undefined, grantUsd: number): string {
  const building = request.building.length > BUILDING_CHARS ? `${request.building.slice(0, BUILDING_CHARS - 1).trimEnd()}…` : request.building;
  const form = csrf
    ? `<form method="post" action="/admin/dashboard/tools"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="tool" value="request"><input type="hidden" name="from" value="home"><input type="hidden" name="id" value="${request.id}">${grantUsdInput(grantUsd, `Weekly dollar cap for ${request.login}`)}<button class="btn primary" type="submit" name="action" value="grant">Grant</button><button class="btn" type="submit" name="action" value="decline">Decline</button></form>`
    : "";
  return `<li class="req">
<div class="req-head"><a href="https://github.com/${encodeURIComponent(request.login)}" rel="noopener noreferrer nofollow" target="_blank">@${escapeHtml(request.login)}</a><span class="hint">${escapeHtml(ago(request.at, now))}</span></div>
<p class="hint">${escapeHtml(accountAge(request.accountAgeDays))}${request.personalUsdPerWeek !== null ? ` · ${escapeHtml(ownCapText(request.personalUsdPerWeek))}` : ""}</p>
<p class="req-text">${escapeHtml(building)}</p>
${form}
</li>`;
}

export function homePage(input: HomeInput): Response {
  const { home, spend, requests, csrf } = input;
  const view = outlook(spend, home);
  const people = personRows(home.spenders, spend);
  const found = problems(home, spend, view, people).slice(0, MAX_PROBLEMS);

  const header = `<header class="bar"><div>
<a class="brand" href="/admin"><span class="logo"><img src="${BRAND_ORIGIN}/logo-64.webp" alt="" width="22" height="22"></span><b>${escapeHtml(PRODUCT_NAME)} admin</b></a>
${input.signOut ? `<form method="post" action="/admin/signout"><button type="submit" class="out">Sign out</button></form>` : ""}
</div></header>`;

  const verdictClass = view.verdict === "Fine" ? "fine" : view.verdict === "Watch it" ? "watch" : "act";
  const rest = view.sentence.slice(view.verdict.length + 1);
  const keys = (["openai", "luminal", "openrouter"] as const).filter((key) => key !== "openrouter" || home.spendDays.some((row) => row.openrouter > 0));
  const legend = keys.map((key) => `<span><i class="${{ openai: "c1", luminal: "c2", openrouter: "c3" }[key]}"></i>${PROVIDER[key]}</span>`).join("");
  const ok = `<section class="card" id="ok" aria-labelledby="ok-h">
<h2 id="ok-h">Are we OK?</h2>
<p class="say"><span class="verdict ${verdictClass}">${escapeHtml(view.verdict)}.</span>${escapeHtml(rest)}</p>
<div class="legend" aria-label="Spend per day, last ${home.spendDays.length} days">${legend}<span>Spend per day, last ${home.spendDays.length} days</span></div>
${spendChart(home.spendDays, [...keys], 640, "wide")}
${spendChart(home.spendDays, [...keys], 340, "narrow")}
</section>`;

  const top = people.slice(0, TOP_PEOPLE);
  const rows = top.map((row) => {
    const name = row.login ?? `#${row.githubId}`;
    const link = row.login ? `<a href="https://github.com/${encodeURIComponent(row.login)}" rel="noopener noreferrer nofollow" target="_blank">${escapeHtml(name)}</a>` : `<a href="/admin?view=full#top">${escapeHtml(name)}</a>`;
    const amount = row.capUsd === null ? `<b>${escapeHtml(money(row.costUsd))}</b>, no cap` : `<b>${escapeHtml(money(row.costUsd))}</b> of ${escapeHtml(money(row.capUsd))}${row.ownCap ? " (own cap)" : ""}`;
    return `<li><span class="who">${link} <span class="tier">${escapeHtml(TIER_WORDS[row.tier])}</span></span><span class="amt">${row.atCap ? `<span class="capword">at cap</span> ` : ""}${amount}</span>${capBar(row.costUsd, row.capUsd, row.atCap)}</li>`;
  });
  const gpuLine = gpuSentence(home);
  const using = `<section class="card" id="using" aria-labelledby="using-h">
<h2 id="using-h">Who's using it?</h2>
<p class="say">${escapeHtml(usersSentence(home))}</p>
${rows.length > 0 ? `<h3 class="sub">Spent most this week</h3><ul class="people">${rows.join("\n")}</ul>` : `<p class="none">Nobody has used free tokens this week.</p>`}
${gpuLine ? `<p class="more"><a href="/admin?view=health#gpus">${escapeHtml(gpuLine)}</a></p>` : ""}
</section>`;

  const broken = `<section class="card" id="broken" aria-labelledby="broken-h">
<h2 id="broken-h">Is anything broken?</h2>
${
  found.length === 0
    ? `<p class="say">Nothing looks broken.</p>`
    : `<ul class="problems">${found.map((problem) => `<li>${escapeHtml(problem.text)} <a href="${escapeHtml(problem.href)}">see details</a></li>`).join("\n")}</ul>`
}
</section>`;

  const notice = input.notice ? `<p class="msg${input.notice.error ? " err" : ""}" role="${input.notice.error ? "alert" : "status"}">${escapeHtml(input.notice.text)}</p>` : "";
  const shown = requests.slice(0, MAX_REQUEST_CARDS);
  const needs = `<section class="card" id="needs" aria-labelledby="needs-h">
<h2 id="needs-h">What needs me?</h2>
${notice}${
    requests.length === 0
      ? `<p class="say">Nothing. No one is waiting for an answer.</p>`
      : `<p class="say">${requests.length === 1 ? "1 person asks" : `${requests.length.toLocaleString("en-US")} people ask`} for free tokens.</p>
<ul class="reqs">${shown.map((request) => requestCard(request, home.now, csrf, input.grantUsd)).join("\n")}</ul>
${requests.length > shown.length ? `<p class="more"><a href="/admin?view=tools#requests">${plural(requests.length - shown.length, "more request")} on the Tools tab</a></p>` : ""}
${csrf ? `<p class="more">Grant gives full free tokens with the weekly dollar cap next to it, and emails them. Decline sends nothing.</p>` : `<p class="more">Sign in at /admin in a browser to answer them.</p>`}`
  }
</section>`;

  const blocks = requests.length > 0 ? [needs, ok, using, broken] : [ok, using, broken, needs];
  const details = `<nav class="details" aria-label="Details"><span>Details:</span><a href="/admin?view=simple">Simple</a><a href="/admin?view=full">Full</a><a href="/admin?view=health">Health</a><a href="/admin?view=tools">Tools</a></nav>`;
  return shell(`Admin · ${PRODUCT_NAME}`, `${header}\n<main class="home">\n${blocks.join("\n")}\n</main>\n${details}`, 200, {}, "", HOME_STYLE);
}
