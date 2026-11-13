import type { AlertKind, FreeConfig } from "./config.js";

/**
 * Alerts to the owner's chat: free spend crossing 50%, 80% and 100% of the weekly cap (once
 * per threshold per week) and of the all-time cap (once per threshold, ever), the kill switch,
 * the queue starting, an OpenRouter host failing more than 20% of its requests over the
 * last hour, Luminal credit used crossing 50%, 80% and 100% of the balance (once each per
 * balance), Luminal-served usage pausing because the credit ran out, Luminal slowing people
 * down (10% or more of at least 10 requests rate limited or failed over the last 10 minutes,
 * or 3 people hit by it; at most every 30 minutes, then once when it's back to normal), and
 * the sign-up GitHub activity check letting people through because GitHub didn't answer (5
 * times in a UTC day, once a day).
 * Also two notes that aren't warnings: the first person admitted who isn't an admin (once,
 * ever), and a daily digest of the previous UTC day, sent by the 01:00 UTC cron trigger even
 * when every number is zero, so it doubles as a heartbeat (once per date).
 * Counts and dollars only, plus GitHub logins in those two.
 *
 * ALERT_WEBHOOK_URL picks the format from its host, or ALERT_WEBHOOK_KIND sets it:
 *
 *   discord   https://discord.com/api/webhooks/…            {"content": text}
 *   slack     https://hooks.slack.com/services/…             {"text": text}
 *   telegram  https://api.telegram.org/bot<token>/sendMessage {"chat_id", "text"}
 *             chat_id from ALERT_TELEGRAM_CHAT_ID, or a `chat_id` query parameter on the URL
 *
 * Any other URL gets `{"text": text, "content": text}`. A failed post is not retried.
 *
 * Email is the primary channel: Cloudflare's `send_email` binding `ALERT_EMAIL` sends from
 * ALERT_EMAIL_FROM (alerts@dl.new) to ALERT_EMAIL_TO, subject the short line, body the full
 * message with the numbers and a link to the dashboard. The binding is optional: where it
 * doesn't exist (Serverless Objects, local tests without it) alerts go to the webhook alone,
 * and with neither configured they are logged. With both, both get every alert.
 */

export const SPEND_THRESHOLDS = [0.5, 0.8, 1] as const;
/** A host is reported when it fails more than this share of its requests in the last hour… */
export const HOST_FAILURE_RATE = 0.2;
/** …with at least this many requests in that hour, so one bad request isn't news. */
export const HOST_MIN_REQUESTS = 20;
export const HOST_WINDOW_MS = 3_600_000;

export function resolveKind(url: string, kind: AlertKind): Exclude<AlertKind, "auto"> | "generic" {
  if (kind !== "auto") return kind;
  const host = new URL(url).hostname.toLowerCase();
  if (host === "discord.com" || host === "discordapp.com" || host.endsWith(".discord.com")) return "discord";
  if (host === "hooks.slack.com") return "slack";
  if (host === "api.telegram.org") return "telegram";
  return "generic";
}

/** The request that posts `text` to the webhook. */
export function alertRequest(url: string, kind: AlertKind, telegramChatId: string | undefined, text: string): { url: string; init: RequestInit } {
  const resolved = resolveKind(url, kind);
  const headers = { "content-type": "application/json" };
  switch (resolved) {
    case "discord":
      return { url, init: { method: "POST", headers, body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }) } };
    case "slack":
      return { url, init: { method: "POST", headers, body: JSON.stringify({ text }) } };
    case "telegram": {
      const parsed = new URL(url);
      const chatId = telegramChatId ?? parsed.searchParams.get("chat_id") ?? undefined;
      parsed.searchParams.delete("chat_id");
      return { url: parsed.toString(), init: { method: "POST", headers, body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }) } };
    }
    case "generic":
      return { url, init: { method: "POST", headers, body: JSON.stringify({ text, content: text }) } };
  }
}

/** "$200", "$1,000", "$12.50". */
export function dollars(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  const whole = Number.isInteger(rounded);
  return `$${rounded.toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

export function percentOf(threshold: number): string {
  return `${Math.round(threshold * 100)}%`;
}

/** One alert: `subject` is the short line (email subject); `text` is the full message (chat, email body). */
export interface Alert {
  subject: string;
  text: string;
  /** The email's last line, when "once per threshold" isn't true of this alert. */
  footer?: string;
}

export function weeklySpendAlert(spentUsd: number, capUsd: number, threshold: number): Alert {
  return {
    subject: `dl free tier: ${percentOf(threshold)} of the ${dollars(capUsd)} weekly cap used`,
    text: `dl free tier: ${dollars(spentUsd)} of the ${dollars(capUsd)} weekly cap used (${percentOf(threshold)}). Resets Mon 00:00 UTC.`,
  };
}

export function totalSpendAlert(spentUsd: number, capUsd: number, threshold: number): Alert {
  return {
    subject: `dl free tier: ${percentOf(threshold)} of the ${dollars(capUsd)} all-time cap used`,
    text: `dl free tier: ${dollars(spentUsd)} of the ${dollars(capUsd)} all-time cap used (${percentOf(threshold)}). It doesn't reset; free tokens stop at 100% unless the cap is raised.`,
  };
}

/** All-time spend milestones that send an email, in dollars across every provider. */
export const SPEND_MILESTONES_USD = [50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 7000] as const;

/** The highest milestone at or below `totalUsd`, if it hasn't been announced yet. */
export function milestoneCrossed(totalUsd: number, sent: ReadonlySet<number>): { milestone: number; mark: number[] } | undefined {
  const reached = SPEND_MILESTONES_USD.filter((m) => totalUsd >= m);
  const fresh = reached.filter((m) => !sent.has(m));
  if (fresh.length === 0) return undefined;
  return { milestone: reached[reached.length - 1]!, mark: fresh };
}

/** A spend milestone: the total, where it went, this week's spend and who spent most this week. */
export function spendMilestoneAlert(input: {
  milestone: number;
  totalUsd: number;
  openaiUsd: number;
  luminalUsd: number;
  cashUsd: number;
  weekUsd: number;
  top: Array<{ login: string; usd: number }>;
}): Alert {
  const top = input.top.length ? ` Top this week: ${input.top.map((t) => `${t.login} ${dollars(t.usd)}`).join(", ")}.` : "";
  const cash = input.cashUsd > 0 ? `, OpenRouter cash ${dollars(input.cashUsd)}` : "";
  return {
    subject: `dl free tier: ${dollars(input.milestone)} spent so far`,
    text: `dl free tier: ${dollars(input.totalUsd)} spent in total (OpenAI ${dollars(input.openaiUsd)}, Luminal ${dollars(input.luminalUsd)}${cash}). This week: ${dollars(input.weekUsd)}.${top}`,
  };
}

/**
 * A payment just came in: who, what and how much (before tax), plus the running totals so the
 * owner sees the trend without opening Stripe. Sent once per payment id.
 */
export function paymentAlert(input: { login: string | undefined; kind: "pro" | "topup"; renewal: boolean; amountCents: number; payments: number; payers: number; totalCents: number }): Alert {
  const who = input.login ? `@${input.login}` : "someone";
  const what = input.kind === "topup" ? "a top-up" : input.renewal ? "a Pro renewal" : "Pro";
  const amount = dollars(input.amountCents / 100);
  const lines = [
    `dl free tier: ${who} paid ${amount} for ${what}.`,
    "",
    ...(input.login ? [`Login: @${input.login} (https://github.com/${input.login})`] : []),
    `Product: ${input.kind === "topup" ? "top-up" : input.renewal ? "Pro (renewal)" : "Pro (new)"}`,
    `Amount: ${amount} before tax`,
    `All time: ${input.payments} ${input.payments === 1 ? "payment" : "payments"} from ${input.payers} ${input.payers === 1 ? "person" : "people"}, ${dollars(input.totalCents / 100)} before tax`,
  ];
  return {
    subject: `dl: ${who} paid ${amount} (${input.kind === "topup" ? "top-up" : input.renewal ? "Pro renewal" : "Pro"})`,
    text: lines.join("\n"),
    footer: "Sent for every payment.",
  };
}

/** A new access request (/request in dl): who, and how many wait. Never what they wrote. */
export function accessRequestAlert(login: string, pending: number): Alert {
  return {
    subject: `dl free tier: new access request from @${login}`,
    text: `dl free tier: new access request from @${login} (${pending} pending). Answer it on the admin Tools tab.`,
    footer: 'Sent for every new access request. Set accessRequestAlerts to "daily" for one line in the daily digest instead, or "off".',
  };
}

export function pauseAlert(paused: boolean, login: string): Alert {
  return paused
    ? { subject: "dl free tier: free tokens paused (kill switch)", text: `dl free tier: free tokens paused for everyone by ${login} (kill switch).` }
    : { subject: "dl free tier: free tokens resumed (kill switch off)", text: `dl free tier: free tokens resumed by ${login} (kill switch off).` };
}

export function queueStartedAlert(weekUsd: number, capUsd: number | undefined, budget: "cash" | "credit" = "cash"): Alert {
  const what = budget === "credit" ? "weekly Luminal credit budget" : "weekly cap";
  const spend = capUsd === undefined ? "" : ` (${dollars(weekUsd)} of the ${dollars(capUsd)} ${what} used)`;
  return {
    subject: "dl free tier: the queue started",
    text: `dl free tier: the queue started${spend}. New sign-ups wait in line for free tokens until Monday's admission.`,
  };
}

export function hostFailureAlert(host: string, failures: number, requests: number): Alert {
  const rate = `${Math.round((failures / requests) * 100)}%`;
  return {
    subject: `dl free tier: OpenRouter host ${host} failing (${rate})`,
    text: `dl free tier: OpenRouter host ${host} failed ${failures} of ${requests} requests in the last hour (${rate}). New requests avoid it while it keeps failing.`,
  };
}

export function creditAlert(usedUsd: number, balanceUsd: number, threshold: number, provider = "Luminal"): Alert {
  const end = threshold >= 1 ? ` Free and Pro usage on ${provider} is paused until the credit is topped up and its credit setting raised.` : "";
  return {
    subject: `dl free tier: ${percentOf(threshold)} of the ${dollars(balanceUsd)} ${provider} credit used`,
    text: `dl free tier: ${dollars(usedUsd)} of the ${dollars(balanceUsd)} ${provider} credit used (${percentOf(threshold)}).${end}`,
  };
}

export function creditPausedAlert(usedUsd: number, balanceUsd: number, provider = "Luminal"): Alert {
  const setting = provider === "OpenAI" ? "openaiCreditUsd" : "luminalCreditUsd";
  return {
    subject: `dl free tier: ${provider} credit used up`,
    text: `dl free tier: ${provider}-served requests are refused with upstream_credit_exhausted: ${dollars(usedUsd)} of the ${dollars(balanceUsd)} ${provider} credit is used. Top up and raise ${setting} (POST /admin/config).`,
  };
}

/** Sign-ups a day let through because GitHub's API didn't answer the activity check, before the alert. */
export const GITHUB_CHECK_ERROR_ALERT = 5;

export function githubCheckErrorAlert(errors: number): Alert {
  return {
    subject: "dl free tier: GitHub activity check failing open",
    text: `dl free tier: GitHub's API didn't answer the sign-up activity check ${errors} times today (UTC), so those sign-ups were let through without it. Counts are in GET /admin/metrics (githubChecks).`,
  };
}

// ─── Luminal slowing people down ─────────────────────────────────────────────

/**
 * What one request got from its upstream: an answer (`ok`, which includes a 400 for the
 * request itself), a 429 (`rate_limited`), or a failure: `error` (5xx, unreachable, the
 * service's key refused, an error body, a stream that failed part way) or `timeout` (no
 * response headers before the first-byte timeout). Timeouts are errors, counted apart.
 */
export type UpstreamOutcome = "ok" | "rate_limited" | "error" | "timeout";

/** The rolling window the Luminal slow-down alert looks at. */
export const SLOW_WINDOW_MS = 10 * 60_000;
/** It fires when at least this many requests in the window… */
export const SLOW_MIN_REQUESTS = 10;
/** …had this share or more rate limited or failed… */
export const SLOW_FAILURE_SHARE = 0.1;
/** …or when this many different people got a rate limit or a failure in the window. */
export const SLOW_PEOPLE = 3;
/** And never on fewer than this many failures: one slow reply at low traffic isn't an incident. */
export const SLOW_MIN_FAILURES = 3;
/** At most one slow-down email this often while it lasts. */
export const SLOW_REPEAT_MS = 30 * 60_000;
/** Back to normal: under this share with at least SLOW_MIN_REQUESTS in the window… */
export const SLOW_RECOVERED_SHARE = 0.02;
/** …or no failure at all for this long after the last slow-down email. */
export const SLOW_QUIET_MS = 30 * 60_000;

/** Luminal's last 10 minutes, admins included. */
export interface LuminalWindow {
  requests: number;
  rateLimited: number;
  errors: number;
  timeouts: number;
  /** Different people (GitHub ids) who got a rate limit, an error or a timeout. */
  people: number;
}

/** Who serves free requests now, and whether the service could switch to OpenRouter. */
export interface ServingContext {
  serving: "openai" | "luminal" | "openrouter" | "none";
  openRouterConfigured: boolean;
  /** The Tools page's routing switch: <base>/admin?view=tools#upstream. */
  switchUrl: string;
}

export function failuresOf(window: LuminalWindow): number {
  return window.rateLimited + window.errors + window.timeouts;
}

/** Whether Luminal is slowing people down, by the rate or by the people. */
export function luminalSlow(window: LuminalWindow): boolean {
  const failures = failuresOf(window);
  if (failures < SLOW_MIN_FAILURES) return false;
  return (window.requests >= SLOW_MIN_REQUESTS && failures / window.requests >= SLOW_FAILURE_SHARE - 1e-9) || window.people >= SLOW_PEOPLE;
}

function servingName(serving: ServingContext["serving"]): string {
  return serving === "luminal" ? "Luminal" : serving === "openrouter" ? "OpenRouter" : "none (no upstream key)";
}

function share(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%";
}

export function luminalSlowAlert(window: LuminalWindow, context: ServingContext): Alert {
  const failures = failuresOf(window);
  const rate = share(failures, window.requests);
  const action =
    context.serving === "openrouter"
      ? `OpenRouter is serving already, so new requests don't go to Luminal; these failures came before the switch. To switch back later: open ${context.switchUrl} → Routing → Luminal.`
      : context.openRouterConfigured
        ? `To switch to OpenRouter: open ${context.switchUrl} → Routing → OpenRouter (it spends OpenRouter credit until you switch back)`
        : `Switching to OpenRouter isn't possible: the service has no OPENROUTER_API_KEY. Set it (wrangler secret put OPENROUTER_API_KEY), then open ${context.switchUrl} → Routing → OpenRouter.`;
  return {
    subject: `dl free tier: Luminal is slowing people down (${rate} of requests in 10 min)`,
    text: [
      `dl free tier: Luminal is slowing people down. ${failures} of ${window.requests} Luminal requests in the last 10 minutes were rate limited or failed (${rate}).`,
      "",
      `Rate limited (Luminal 429): ${window.rateLimited}`,
      `Errors (5xx, unreachable, refused key, failed streams): ${window.errors}`,
      `Timeouts (no first byte in time): ${window.timeouts}`,
      `People affected: ${window.people}`,
      `Serving now: ${servingName(context.serving)}`,
      "",
      action,
      "",
      "Admin requests count here: they're real traffic.",
    ].join("\n"),
    footer: "Sent by the free tier service at most once every 30 minutes while Luminal keeps failing, then one email when it's back to normal. Counts only.",
  };
}

/**
 * The slow-down is over: the window is under 2% with enough requests, or nothing failed for
 * 30 minutes after the last email. With no Luminal requests at all in that time (OpenRouter
 * serving, or nobody using it), it doesn't claim Luminal recovered: nobody tried it.
 */
export function luminalRecoveredAlert(input: { window: LuminalWindow; quietRequests: number; openedAt: number; now: number }, context: ServingContext): Alert {
  const { window } = input;
  const minutes = Math.max(1, Math.round((input.now - input.openedAt) / 60_000));
  const untried = window.requests < SLOW_MIN_REQUESTS && input.quietRequests === 0;
  const evidence =
    window.requests >= SLOW_MIN_REQUESTS
      ? `${failuresOf(window)} of ${window.requests} Luminal requests failed or were rate limited in the last 10 minutes (${share(failuresOf(window), window.requests)}).`
      : untried
        ? "No requests went to Luminal in the last 30 minutes, so nothing failed, but nothing tested it either."
        : `No Luminal request failed or was rate limited in the last 30 minutes (${input.quietRequests} requests).`;
  const back =
    context.serving === "openrouter"
      ? ` It spends OpenRouter credit until you switch back: open ${context.switchUrl} → Routing → Luminal.`
      : "";
  return {
    subject: untried ? "dl free tier: Luminal alert cleared (no Luminal requests in 30 min)" : "dl free tier: Luminal back to normal",
    text: [
      `dl free tier: ${untried ? "the Luminal slow-down alert is cleared" : "Luminal is back to normal"}, ${minutes} minutes after the first slow-down email. ${evidence}`,
      "",
      `Serving now: ${servingName(context.serving)}.${back}`,
    ].join("\n"),
    footer: "Sent once per slow-down, when it ends. Counts only.",
  };
}

// ─── First sign-up and the daily digest ──────────────────────────────────────

/** "2026-11-04 12:00 UTC (20:00 Singapore)". Singapore is UTC+8 all year. */
export function utcAndSingapore(at: number): string {
  const utc = new Date(at).toISOString();
  const sgt = new Date(at + 8 * 3_600_000).toISOString();
  return `${utc.slice(0, 10)} ${utc.slice(11, 16)} UTC (${sgt.slice(11, 16)} Singapore${sgt.slice(0, 10) === utc.slice(0, 10) ? "" : `, ${sgt.slice(0, 10)}`})`;
}

/** How someone got in: open admission or an invite code, and whether they came by a referral link. */
export interface SignupHow {
  via: "open" | "invite";
  referral: boolean;
}

export function signupHowText(how: SignupHow): string {
  const base = how.via === "open" ? "open admission" : "invite code";
  return how.referral ? `referral link, ${base}` : base;
}

/** The first person admitted who isn't an admin. Sent once, ever. */
export function firstSignupAlert(input: { login: string; how: SignupHow; at: number; queued: boolean }): Alert {
  return {
    subject: `dl free tier: your first user, @${input.login}`,
    text: [
      `dl free tier: your first user, @${input.login}.`,
      "",
      `Login: @${input.login} (https://github.com/${input.login})`,
      `How they got in: ${signupHowText(input.how)}`,
      `Time: ${utcAndSingapore(input.at)}`,
      `Free tokens: ${input.queued ? "waiting in the queue until Monday's admission" : "available now"}`,
    ].join("\n"),
    footer: "Sent once, ever: for the first person admitted who isn't an admin.",
  };
}

/** The daily digest's numbers: one UTC day, and its Monday-to-Sunday week up to the end of that day. Admins left out. */
export interface DailyDigest {
  /** The UTC day reported, YYYY-MM-DD. */
  date: string;
  signups: { count: number; people: Array<{ login: string; how: SignupHow }> };
  /** People with a request that day. */
  active: number;
  usage: DigestUsage;
  /** Payments that day: revenue before tax. */
  payments: { count: number; usd: number };
  installs: {
    ok: number;
    failed: number;
    platforms: Array<{ os: string; arch: string; mode: string; ok: number; failed: number }>;
    failedSteps: Array<{ step: string; failed: number }>;
  };
  week: {
    /** The Monday, YYYY-MM-DD. */
    start: string;
    signups: number;
    /** People with a request that week. */
    active: number;
    usage: DigestUsage;
    payments: { count: number; usd: number };
    /** The weekly Luminal credit budget for free usage (luminalWeeklyCreditUsd); undefined: none. */
    creditBudgetUsd: number | undefined;
  };
  /** Luminal credit: the balance and what's left of it now (everyone, since the start). */
  credit: { balanceUsd: number; leftUsd: number };
  queueWaiting: number;
  paused: boolean;
  /** Only with accessRequestAlerts "daily": requests made that day (logins, at most DIGEST_MAX_LOGINS) and how many wait now. */
  accessRequests?: { count: number; logins: string[]; pending: number };
}

/** Requests and tokens of people who aren't admins; dollars of free usage only. */
export interface DigestUsage {
  requests: number;
  tokensIn: number;
  tokensCached: number;
  tokensOut: number;
  /** Luminal credit used by free usage (not paid, not admins). */
  freeCreditUsd: number;
  /**
   * OpenRouter (cash) spend by everyone, admins and paid usage included. The free tier runs on
   * Luminal credit alone, so this should be 0; the digest warns when it isn't.
   */
  openRouterUsd: number;
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

function weekday(date: string): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${date}T00:00:00Z`).getUTCDay()]!;
}

function payments(value: { count: number; usd: number }): string {
  return value.count === 0 ? "none" : `${dollars(value.usd)} from ${count(value.count)} payment${value.count === 1 ? "" : "s"}`;
}

/** Requests and tokens, then `credit` (the free credit line), then a warning when OpenRouter cost anything. */
function usageLines(usage: DigestUsage, indent: string, credit: string): string[] {
  return [
    `${indent}Requests: ${count(usage.requests)}`,
    `${indent}Tokens: ${count(usage.tokensIn)} in (${count(usage.tokensCached)} cached), ${count(usage.tokensOut)} out`,
    `${indent}${credit}`,
    ...(usage.openRouterUsd > 0 ? [`${indent}OpenRouter spend: ${dollars(usage.openRouterUsd)} (should be $0)`] : []),
  ];
}

/** At most this many logins in the digest; the rest are counted. */
export const DIGEST_MAX_LOGINS = 20;

/** The daily digest. Sent every day, zeros included: it doubles as a heartbeat. */
export function dailyDigestAlert(digest: DailyDigest): Alert {
  const { signups, week } = digest;
  const lines = [`dl free tier: daily digest for ${weekday(digest.date)} ${digest.date} (UTC). Admins left out.`, "", `New sign-ups: ${count(signups.count)}`];
  if (signups.people.length > 0) {
    lines.push(`  ${signups.people.map((person) => `@${person.login} (${signupHowText(person.how)})`).join(", ")}`);
    if (signups.count > signups.people.length) lines.push(`  and ${count(signups.count - signups.people.length)} more`);
  }
  lines.push(`Active people: ${count(digest.active)}`, ...usageLines(digest.usage, "", `Free credit spent: ${dollars(digest.usage.freeCreditUsd)} (Luminal credit)`));
  lines.push(`Luminal credit left: ${dollars(digest.credit.leftUsd)} of ${dollars(digest.credit.balanceUsd)}`);
  lines.push(`Paid: ${payments(digest.payments)}`);
  lines.push(`Installs: ${count(digest.installs.ok)} finished, ${count(digest.installs.failed)} failed`);
  for (const platform of digest.installs.platforms) {
    lines.push(`  ${platform.os} ${platform.arch} ${platform.mode}: ${count(platform.ok)} ok, ${count(platform.failed)} failed`);
  }
  if (digest.installs.failedSteps.length > 0) {
    lines.push(`  Failed at: ${digest.installs.failedSteps.map((step) => `${step.step || "(not said)"} ${count(step.failed)}`).join(", ")}`);
  }
  lines.push("", `This week so far (Mon ${week.start} to ${digest.date}):`);
  const budget =
    week.creditBudgetUsd === undefined || week.creditBudgetUsd <= 0
      ? " (no weekly credit budget)"
      : ` of the ${dollars(week.creditBudgetUsd)} weekly credit budget (${Math.round((week.usage.freeCreditUsd / week.creditBudgetUsd) * 100)}%)`;
  lines.push(`  Sign-ups: ${count(week.signups)}`, `  Active people: ${count(week.active)}`, ...usageLines(week.usage, "  ", `Free credit spent: ${dollars(week.usage.freeCreditUsd)}${budget}`));
  lines.push(`  Paid: ${payments(week.payments)}`);
  lines.push("", `Queue: ${count(digest.queueWaiting)} waiting`, `Free tokens: ${digest.paused ? "PAUSED (kill switch)" : "on"}`);
  const asks = digest.accessRequests;
  if (asks) {
    lines.push(`Access requests: ${count(asks.count)} new, ${count(asks.pending)} waiting for an answer${asks.pending > 0 ? " (answer them on the admin Tools page)" : ""}`);
    if (asks.logins.length > 0) lines.push(`  ${asks.logins.map((login) => `@${login}`).join(", ")}${asks.count > asks.logins.length ? ` and ${count(asks.count - asks.logins.length)} more` : ""}`);
  }
  return {
    subject: `dl free tier: daily, ${digest.date}: ${count(signups.count)} new, ${count(digest.active)} active`,
    text: lines.join("\n"),
    footer: "Sent by the free tier service every day at 01:00 UTC (09:00 Singapore), even when nothing happened. Counts and dollars only.",
  };
}

/**
 * The highest threshold newly crossed, or undefined. `sent` holds the thresholds already
 * alerted; every threshold at or below the highest crossed one is marked, so a jump from 40%
 * to 100% sends one message, not three.
 */
export function crossed(share: number, sent: ReadonlySet<number>): { threshold: number; mark: number[] } | undefined {
  const reached = SPEND_THRESHOLDS.filter((threshold) => share >= threshold - 1e-9);
  const fresh = reached.filter((threshold) => !sent.has(threshold));
  if (fresh.length === 0) return undefined;
  return { threshold: Math.max(...fresh), mark: fresh };
}

// ─── Delivery ───────────────────────────────────────────────────────────────

/** Cloudflare's `send_email` binding: `send(new EmailMessage(from, to, raw))`. */
export interface EmailBinding {
  send(message: unknown): Promise<unknown>;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** UTF-8 to base64 with web APIs only. */
function base64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** An RFC 2047 header word when the value isn't plain ASCII. */
function headerValue(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ");
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${base64(clean)}?=`;
}

/**
 * A reply address safe to put in a header: printable ASCII with no spaces, exactly one `@`, none
 * of the characters that mean something in an address header (`<>()[],;:"\\`), at most 254
 * characters. CR and LF are never allowed, so a value can't start a new header.
 */
export function isHeaderSafeAddress(value: string): boolean {
  return value.length <= 254 && /^[^\s@<>()[\],;:"\\]+@[^\s@<>()[\],;:"\\]+$/.test(value) && /^[\x21-\x7e]+$/.test(value);
}

/**
 * A small RFC 5322 message: plain text, UTF-8, base64 body. Enough for an alert; no
 * dependency needed. `replyTo` adds a Reply-To header; it must pass `isHeaderSafeAddress`
 * (a CR or LF, or anything else that could change the header, throws).
 */
export function mimeMessage(input: { from: string; to: string; subject: string; body: string; now: number; messageId: string; fromName?: string; replyTo?: string }): string {
  if (input.replyTo !== undefined && !isHeaderSafeAddress(input.replyTo)) throw new Error("mimeMessage: replyTo isn't a plain email address");
  const domain = input.from.split("@")[1] ?? "dl.new";
  const body = base64(input.body.replace(/\r?\n/g, "\r\n")).replace(/.{1,76}/g, "$&\r\n");
  const name = (input.fromName ?? "dl free tier").replace(/[^\w .-]/g, "");
  return [
    `From: ${name} <${input.from}>`,
    `To: <${input.to}>`,
    ...(input.replyTo !== undefined ? [`Reply-To: <${input.replyTo}>`] : []),
    `Subject: ${headerValue(input.subject)}`,
    `Date: ${new Date(input.now).toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${input.messageId}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ].join("\r\n");
}

/**
 * Sends one plain-text email through the `send_email` binding, from `from` to `to`. Throws
 * when the binding refuses it; callers decide whether that matters.
 */
export async function sendEmail(
  binding: EmailBinding,
  input: { from: string; to: string; subject: string; body: string; now: number; fromName?: string; replyTo?: string },
): Promise<void> {
  const raw = mimeMessage({ ...input, messageId: crypto.randomUUID() });
  // Only reached where the binding exists (Cloudflare); the module is never loaded elsewhere.
  const { EmailMessage } = await import("cloudflare:email"); // portable-exception: optional send_email binding
  await binding.send(new EmailMessage(input.from, input.to, raw));
}

export function emailBody(alert: Alert, adminUrl: string): string {
  const footer = alert.footer ?? "Sent by the free tier service once per threshold. Counts and dollars only.";
  return `${alert.text}\n\nAdmin dashboard: ${adminUrl}\n\n${footer}\n`;
}

/**
 * Sends alerts to every configured channel. Never throws: a failed alert must not fail the
 * request that triggered it. Returns the channels each alert reached, for tests.
 */
export async function deliverAlerts(input: {
  alerts: readonly Alert[];
  config: Pick<FreeConfig, "alertEmailTo" | "alertEmailFrom" | "alertWebhookUrl" | "alertWebhookKind" | "alertTelegramChatId">;
  emailBinding: EmailBinding | undefined;
  fetch: Fetch;
  adminUrl: string;
  now: number;
}): Promise<Array<Array<"email" | "webhook" | "log">>> {
  const out: Array<Array<"email" | "webhook" | "log">> = [];
  for (const alert of input.alerts) {
    const reached: Array<"email" | "webhook" | "log"> = [];
    const { config } = input;
    if (input.emailBinding && config.alertEmailTo) {
      try {
        await sendEmail(input.emailBinding, { from: config.alertEmailFrom, to: config.alertEmailTo, subject: alert.subject, body: emailBody(alert, input.adminUrl), now: input.now });
        reached.push("email");
      } catch (error) {
        console.error("alert email failed", error instanceof Error ? error.message : String(error));
      }
    }
    if (config.alertWebhookUrl) {
      try {
        const request = alertRequest(config.alertWebhookUrl, config.alertWebhookKind, config.alertTelegramChatId, alert.text);
        const response = await input.fetch(request.url, request.init);
        if (response.ok) reached.push("webhook");
        else console.error("alert webhook failed", response.status);
      } catch (error) {
        console.error("alert webhook failed", error instanceof Error ? error.message : String(error));
      }
    }
    if (reached.length === 0) {
      console.log(`alert: ${alert.text}`);
      reached.push("log");
    }
    out.push(reached);
  }
  return out;
}
