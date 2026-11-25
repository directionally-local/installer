import { escapeHtml } from "../../shared/src/html.js";
import { DAY_MS, isoDay } from "./week.js";
import type { InstallOption, InstallPlan } from "./auth-object.js";

/**
 * dl.new's web sign-up: sign in with GitHub on dl.new, choose where dl runs and (on this
 * computer) the plan, then a personal one-time install command that installs dl signed in.
 *
 *   GET  /web/signin?return=<url: WEB_SIGNUP_URL or WEB_API_URL>&state=<page state>[&ref=<referral>]
 *        → the CLI's own sign-in (a device code, GitHub, the details and invite steps, admission),
 *          then 303 to <url>#signin=<one-time code>&state=<page state>
 *   POST /web/session {code, state}        → {token, expires_in, login}: a web session (bearer)
 *   GET  /web/me                           → who, email, plan, trial, tool keys' allowance, offers, referral link and joined count
 *   GET  /web/keys                         → the account's tool keys (api.dl.new)
 *   POST /web/keys {name}                  → a tool key, shown once (POST /v1/keys {kind: "tool"}'s checks)
 *   DELETE /web/keys/:id                   → revokes one of the account's own tool keys
 *   POST /web/email {email, updates?}      → saves the contact email (the details step's checks)
 *   POST /web/choice {option}              → counted (funnel only)
 *   POST /web/checkout                     → {url}: Stripe Checkout for Pro, back to <url>?checkout=done|cancel
 *   POST /web/install-code {option, plan}  → {code, expires_in}: shown as curl -fsSL https://dl.new/i/<code> | sh
 *   POST /v1/install-code/exchange {code, device_id?} (from the installed dl, not the page)
 *        → the device-code poll's tokens, plus {option, plan}
 *   POST /v1/telemetry/web {step: "visited"} (from the dl.new Worker when it serves /start)
 *
 * The web session is a JWT of its own type ("web"): no access token accepts it and it can't call
 * the inference API, only /web/*. The /web/* JSON endpoints answer CORS for the web page's origin
 * only, and refuse a request whose Origin header is another site. They take the session as a
 * bearer header, which a browser never sends on its own, so there is nothing for CSRF to ride on.
 */

/** Where the web sign-up returns to unless WEB_SIGNUP_URL says otherwise. */
export const DEFAULT_WEB_SIGNUP_URL = "https://dl.new/start";
/**
 * api.dl.new's key page unless WEB_API_URL says otherwise: a web sign-in may return there too
 * (its script finishes the sign-in itself), and its origin is the other one /web/* answers CORS
 * for. The API is served on the same host (api.dl.new/v1/*, api.dl.new/anthropic/*).
 */
export const DEFAULT_WEB_API_URL = "https://api.dl.new/";
/** How long a web session lasts: time to choose, pay and copy the command. */
export const WEB_SESSION_TTL_S = 3600;
/** The page's random state: base64url, 16 to 128 characters. */
export const WEB_STATE = /^[A-Za-z0-9_-]{16,128}$/;
/** A one-time handoff code or install code as issued (base64url). */
export const ONE_TIME_CODE = /^[A-Za-z0-9_-]{22,64}$/;

/** The steps counted, in funnel order. Counts only: nothing about who. */
export const WEB_STEPS = ["visited", "signed_in", "chose_computer", "chose_gpu", "plan_free", "plan_pro", "command_shown", "code_exchanged"] as const;
export type WebStep = (typeof WEB_STEPS)[number];
export interface WebFunnelRow {
  day: number;
  step: string;
  n: number;
}

const STEP_LABELS: Record<WebStep, string> = {
  visited: "Visited",
  signed_in: "Signed in",
  chose_computer: "This computer",
  chose_gpu: "Nvidia GPU",
  plan_free: "Free trial",
  plan_pro: "Pro checkout",
  command_shown: "Command shown",
  code_exchanged: "Installed",
};

export function isInstallOption(value: unknown): value is InstallOption {
  return value === "computer" || value === "gpu";
}

export function isInstallPlan(value: unknown): value is InstallPlan {
  return value === "free" || value === "pro";
}

/** The plan as stored with an install code: only "this computer" has one. */
export function planFor(option: InstallOption, plan: unknown): InstallPlan | null {
  return option === "computer" && isInstallPlan(plan) ? plan : null;
}

/**
 * The page a web sign-in returns to for `raw` (the ?return= parameter): one of `pages` by exact
 * match, no lookalikes; the first (the sign-up page) when none is given; undefined otherwise.
 */
export function allowedReturn(raw: string | null, pages: readonly [string, ...string[]]): string | undefined {
  if (raw === null || raw === "") return pages[0];
  return pages.find((page) => page === raw);
}

/** CORS headers for one of the web pages' origins, or none when the request came from elsewhere (or no browser). */
export function webCors(origin: string | null, allowed: readonly string[]): Record<string, string> {
  if (origin === null || !allowed.includes(origin)) return { vary: "origin" };
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

/** Totals per step since `sinceDay` (inclusive), in funnel order. */
export function funnelTotals(rows: readonly WebFunnelRow[], sinceDay = 0): Array<{ step: WebStep; n: number }> {
  return WEB_STEPS.map((step) => ({ step, n: rows.filter((row) => row.step === step && row.day >= sinceDay).reduce((sum, row) => sum + row.n, 0) }));
}

/** The admin home's "Web sign-up funnel" card: the last 7 days and all time, with the CSV link. */
export function webFunnelCard(rows: readonly WebFunnelRow[], now: number): string {
  const today = Math.floor(now / DAY_MS);
  const week = funnelTotals(rows, today - 6);
  const all = funnelTotals(rows);
  const cell = (n: number) => n.toLocaleString("en-US");
  const body = WEB_STEPS.map((step, index) => `<tr><td>${escapeHtml(STEP_LABELS[step])}</td><td class="num">${cell(week[index]!.n)}</td><td class="num">${cell(all[index]!.n)}</td></tr>`).join("");
  return `<section class="card" id="web-funnel"><h2>Web sign-up funnel</h2>
<p class="empty">dl.new: sign in, choose, install command, then the installed dl signing in with it. Counts only. <a href="/admin/dashboard/web-signup.csv">CSV</a></p>
<table><thead><tr><th>Step</th><th class="num">Last 7 days</th><th class="num">All time</th></tr></thead><tbody>${body}</tbody></table>
</section>`;
}

/** One row per day with a column per step. */
export function webFunnelCsv(rows: readonly WebFunnelRow[]): string {
  const days = [...new Set(rows.map((row) => row.day))].sort((a, b) => a - b);
  const lines = [["day", ...WEB_STEPS].join(",")];
  for (const day of days) {
    lines.push([isoDay(day * DAY_MS), ...WEB_STEPS.map((step) => String(rows.find((row) => row.day === day && row.step === step)?.n ?? 0))].join(","));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Link campaigns: dl.new links carry `utm_source`, `utm_medium` and `utm_campaign` (blog posts:
 * `blog`, `post`, the post's slug). The dl.new Worker counts a tagged visit, the page counts an
 * install or sign-in click under the visit's first-touch campaign, and a web sign-in started with
 * one (`/web/signin?...&utm_campaign=…`) counts as `signed_in` and, for a new account,
 * `signed_up`. Counts per UTC day and tags only: nothing about who.
 */
export const CAMPAIGN_STEPS = ["visited", "install_click", "signup_started", "signed_in", "signed_up"] as const;
export type CampaignStep = (typeof CAMPAIGN_STEPS)[number];
/** The steps the dl.new Worker and page may send (the others are counted by the service itself). */
export const CAMPAIGN_CLIENT_STEPS: ReadonlySet<string> = new Set<CampaignStep>(["visited", "install_click", "signup_started"]);
/** How many different tag combinations are kept a day; the rest are counted under `_other`. */
export const CAMPAIGN_KEYS_PER_DAY = 500;
export const CAMPAIGN_OTHER = "_other";

/** A link's tags: lowercase, at most 64 characters each; `ref` is the referring host, or "". */
export interface Campaign {
  source: string;
  medium: string;
  campaign: string;
  ref: string;
}
export interface CampaignRow extends Campaign {
  day: number;
  step: string;
  n: number;
}

const TAG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HOST = /^[a-z0-9]([a-z0-9.-]{0,98}[a-z0-9])?$/;

/** One tag, lowercased, or "" when missing; undefined when it isn't a plain tag. */
function tag(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") return undefined;
  const lower = value.trim().toLowerCase();
  return lower === "" ? "" : TAG.test(lower) ? lower : undefined;
}

/**
 * The campaign in `raw` ({source, medium, campaign, ref}), or undefined when there is none or any
 * tag isn't plain (letters, digits, `.`, `_`, `-`). A campaign needs `campaign`; the rest may be "".
 */
export function parseCampaign(raw: unknown): Campaign | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const source = tag(value.source);
  const medium = tag(value.medium);
  const campaign = tag(value.campaign);
  const ref = tag(value.ref);
  if (source === undefined || medium === undefined || !campaign || ref === undefined) return undefined;
  if (ref !== "" && !HOST.test(ref)) return undefined;
  return { source, medium, campaign, ref };
}

/** The campaign on a `/web/signin` link: `utm_source`, `utm_medium`, `utm_campaign`, `utm_ref`. */
export function campaignFromParams(params: URLSearchParams): Campaign | undefined {
  return parseCampaign({ source: params.get("utm_source"), medium: params.get("utm_medium"), campaign: params.get("utm_campaign"), ref: params.get("utm_ref") });
}

export interface CampaignTotals extends Campaign, Record<CampaignStep, number> {}

/** Totals per tag combination (all steps) over `rows`, most visited first. */
export function campaignTotals(rows: readonly CampaignRow[]): CampaignTotals[] {
  const byKey = new Map<string, CampaignTotals>();
  for (const row of rows) {
    const key = JSON.stringify([row.source, row.medium, row.campaign, row.ref]);
    let totals = byKey.get(key);
    if (!totals) {
      totals = { source: row.source, medium: row.medium, campaign: row.campaign, ref: row.ref, ...(Object.fromEntries(CAMPAIGN_STEPS.map((step) => [step, 0])) as Record<CampaignStep, number>) };
      byKey.set(key, totals);
    }
    if ((CAMPAIGN_STEPS as readonly string[]).includes(row.step)) totals[row.step as CampaignStep] += row.n;
  }
  return [...byKey.values()].sort((a, b) => b.visited - a.visited || a.campaign.localeCompare(b.campaign));
}
