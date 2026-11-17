import { escapeHtml } from "../../shared/src/html.js";
import { DAY_MS, isoDay } from "./week.js";
import type { InstallOption, InstallPlan } from "./auth-object.js";

/**
 * dl.new's web sign-up: sign in with GitHub on dl.new, choose where dl runs and (on this
 * computer) the plan, then a personal one-time install command that installs dl signed in.
 *
 *   GET  /web/signin?return=<url>&state=<page state>[&ref=<referral>]
 *        → the CLI's own sign-in (a device code, GitHub, the details and invite steps, admission),
 *          then 303 to <url>#signin=<one-time code>&state=<page state>
 *   POST /web/session {code, state}        → {token, expires_in, login}: a web session (bearer)
 *   GET  /web/me                           → who, email, plan, trial, offers, referral link and joined count
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

/** Whether `raw` (the ?return= parameter) is the one page the web sign-up may return to: exact match, no lookalikes. */
export function allowedReturn(raw: string | null, signupUrl: string): boolean {
  return raw === null || raw === "" || raw === signupUrl;
}

/** CORS headers for the web page's origin, or none when the request came from elsewhere (or no browser). */
export function webCors(origin: string | null, allowed: string): Record<string, string> {
  if (origin !== allowed) return { vary: "origin" };
  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-methods": "GET, POST, OPTIONS",
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
