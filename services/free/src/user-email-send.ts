import { base64urlDecode, base64urlEncode } from "../../shared/src/auth.js";
import type { FreeConfig } from "./config.js";
import { renderUserEmail, resetsText, type PlanResetValues, type PlanWarningValues, type PlanWelcomeValues, type TrialEmailValues, type UserEmailKind, type WeeklyResetValues } from "./user-emails.js";
import { classOfKind, emailBudgetOf, type EmailBudget, type EmailClass } from "./email-budget.js";
import { DAY_MS, weekEnd, weekStart } from "./week.js";

/**
 * Emails to the people on the free tier (the copy is in user-emails.ts). Two providers, picked
 * by `userEmailTransport`: Cloudflare Email Service through the optional `send_email` binding
 * USER_EMAIL when it exists, else Resend's HTTP API with RESEND_API_KEY. With neither, nothing
 * is sent and nothing fails; the runtime setting `userEmails` turns them all off without a deploy.
 * With both, `userEmailRoutes` splits them by class: codes and transactional mail stay on the
 * binding, bulk mail (lifecycle kinds and broadcasts) goes through Resend while the runtime
 * setting `broadcastEmailProvider` is "resend" (the default), counted against its own
 * `resendBulkDailyMax` and never the binding's budget. A failed Resend send is never retried
 * through the binding.
 *
 *   welcome      right after a new sign-up gives their email on the details step (app.ts)
 *   welcome_paid dl.new: right after a payment is claimed onto an account (paid-web.ts)
 *   plan_reset   dl.new: Mondays, paying accounts, once free tokens ended (app.ts scheduledPlanReset)
 *   didnt_start  daily cron: admitted 24 to 72 hours ago, no request yet
 *   plan_80      a paid plan's model at 80% of its weekly limit, once per model per week (app.ts chat)
 *   welcome_free dl.new: right after a GitHub sign-in made a Free plan account (trial-web.ts)
 *   free_80      the Free plan at 80% of its week, once per week (app.ts chat)
 *   free_100     the Free plan's week used up, once per week, at the first refused request (app.ts chat)
 *   week_80      when a request's settlement takes the week's usage to 80% of a pool's tokens
 *                or of the weekly dollar cap (once per week)
 *   gone_quiet   daily cron: requests on 2 or more days, none in the last 7 days
 *   weekly_reset Mondays from 01:00 UTC (the daily run, then the 10-minute ticks, through
 *                Tuesday when the daily limit leaves some for the next day): "{tokens} tokens,
 *                reset." to active free-allowance people who used dl in the last 28 days
 *                (weeklyResetTokens; app.ts scheduledWeeklyReset), once per week
 *
 * Only to people with an email who haven't pressed stop, never to admins (unless
 * USER_EMAILS_TO_ADMINS, for testing), at most one a day per person, each kind once per person
 * (week_80 once per week). The free tier's lifecycle kinds never go to accounts made on dl.new.
 * Every send takes from the day's email budget (email-budget.ts): bulk and lifecycle mail can
 * never use the share kept for transactional mail. Every send is claimed in the Directory's `user_emails` table before
 * the provider is called and marked after it, so nothing double-sends across retries or deploys;
 * with Resend, its Idempotency-Key also covers a crash between the two. A failed send is retried
 * once, on the next daily run. Failures are logged as counts, never with an address or the key.
 */

export const RESEND_URL = "https://api.resend.com/emails";
/** Where the unsubscribe link points when PUBLIC_URL isn't set. */
export const EMAIL_STOP_BASE = "https://free.directionallylocal.com";
/** The share of a weekly allowance that sends week_80. */
export const WEEK_EMAIL_SHARE = 0.8;
const RESEND_TIMEOUT_MS = 5000;
/** How long a send through the Email Service binding may take before it counts as failed. */
const BINDING_TIMEOUT_MS = 10_000;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** What the Directory hands back for a send it has reserved. */
export interface UserEmailClaim {
  githubId: number;
  email: string;
  kind: UserEmailKind;
  period: string;
}

/** The same for a broadcast: `period` is the broadcast's id. */
export type BroadcastClaim = Omit<UserEmailClaim, "kind"> & { kind: "broadcast" };

/** The Directory's side (directory-object.ts). */
export interface UserEmailStore {
  claimUserEmail(input: { githubId: number; kind: UserEmailKind; period: string; now: number; adminIds: number[]; includeAdmins: boolean; retry?: boolean; dailyLimit?: number; budget?: EmailBudget; budgetClass?: EmailClass }): Promise<UserEmailClaim | undefined>;
  finishUserEmail(input: { githubId: number; kind: UserEmailKind; period: string; ok: boolean; now: number }): Promise<void>;
}

/**
 * Cloudflare Email Service's `send_email` binding, the builder form of `send()`
 * (https://developers.cloudflare.com/email-service/api/send-emails/workers-api/). It resolves to
 * `{messageId}` and throws an Error with a `code` such as E_RATE_LIMIT_EXCEEDED. No import is
 * needed, so this stays portable: off Cloudflare the binding is simply absent.
 */
export interface UserEmailBinding {
  send(message: {
    from: string | { email: string; name?: string };
    to: string;
    subject: string;
    text: string;
    replyTo?: string;
    headers?: Record<string, string>;
  }): Promise<{ messageId: string }>;
}

/** Where emails to users go: the Email Service binding, or Resend. */
export type UserEmailTransport = { provider: "cloudflare"; binding: UserEmailBinding } | { provider: "resend"; apiKey: string; fetch: Fetch };

/** The binding when it exists, else Resend when RESEND_API_KEY is set, else none (nothing is sent). */
export function userEmailTransport(binding: UserEmailBinding | undefined, config: Pick<FreeConfig, "resendApiKey">, fetcher: Fetch): UserEmailTransport | undefined {
  if (binding && typeof binding.send === "function") return { provider: "cloudflare", binding };
  if (config.resendApiKey !== undefined) return { provider: "resend", apiKey: config.resendApiKey, fetch: fetcher };
  return undefined;
}

/**
 * The provider per class of email. `transactional` carries codes and transactional mail (and
 * everything when there is one provider); `bulk` carries lifecycle mail and broadcasts, and
 * `bulkClass` is the budget class bulk mail takes: "resend_bulk" when it goes through Resend
 * beside the binding, else "bulk" (the binding's own budget, or Resend alone as before).
 */
export interface UserEmailRoutes {
  transactional: UserEmailTransport | undefined;
  bulk: UserEmailTransport | undefined;
  bulkClass: "bulk" | "resend_bulk";
}

/** Bulk mail goes through Resend when the key is set beside the binding and `broadcastEmailProvider` is "resend". */
export function userEmailRoutes(binding: UserEmailBinding | undefined, config: Pick<FreeConfig, "resendApiKey" | "broadcastEmailProvider">, fetcher: Fetch): UserEmailRoutes {
  const transactional = userEmailTransport(binding, config, fetcher);
  if (transactional?.provider === "cloudflare" && config.resendApiKey !== undefined && config.broadcastEmailProvider === "resend") {
    return { transactional, bulk: { provider: "resend", apiKey: config.resendApiKey, fetch: fetcher }, bulkClass: "resend_bulk" };
  }
  return { transactional, bulk: transactional, bulkClass: "bulk" };
}

/** The transport and budget class for one email of `kind` ("broadcast" is bulk). */
export function userEmailRoute(routes: UserEmailRoutes | undefined, kind: UserEmailKind | "broadcast"): { transport: UserEmailTransport | undefined; budgetClass: EmailClass } {
  if (classOfKind(kind) === "transactional") return { transport: routes?.transactional, budgetClass: "transactional" };
  return { transport: routes?.bulk, budgetClass: routes?.bulkClass ?? "bulk" };
}

/** Whether user emails go out at all: a provider, and the setting on. */
export function userEmailsOn(config: Pick<FreeConfig, "userEmails">, transport: UserEmailTransport | undefined): boolean {
  return transport !== undefined && config.userEmails;
}

// ─── The unsubscribe link ────────────────────────────────────────────────────

function stopMessage(githubId: number): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`email-stop:${githubId}`);
}

/** The link's `t`: an HMAC of the person's id with the token signing key. */
export async function stopToken(key: CryptoKey, githubId: number): Promise<string> {
  return base64urlEncode(new Uint8Array(await crypto.subtle.sign("HMAC", key, stopMessage(githubId))));
}

/** Whether `token` is the link's HMAC for `githubId` (constant-time). */
export async function verifyStopToken(key: CryptoKey, githubId: number, token: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return false;
  try {
    return await crypto.subtle.verify("HMAC", key, base64urlDecode(token), stopMessage(githubId));
  } catch {
    return false;
  }
}

export async function stopUrl(base: string, key: CryptoKey, githubId: number): Promise<string> {
  return `${base}/email/stop?u=${githubId}&t=${await stopToken(key, githubId)}`;
}

// ─── Sending ─────────────────────────────────────────────────────────────────

/** The request to Resend for one plain-text email. */
export function resendRequest(input: {
  apiKey: string;
  from: string;
  replyTo: string;
  to: string;
  subject: string;
  text: string;
  /** Left out for a transactional email (a sign-in code, a receipt link): no List-Unsubscribe headers. */
  unsubscribeUrl?: string;
  idempotencyKey: string;
}): RequestInit {
  return {
    method: "POST",
    headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json", "idempotency-key": input.idempotencyKey },
    body: JSON.stringify({
      from: input.from,
      to: [input.to],
      reply_to: input.replyTo,
      subject: input.subject,
      text: input.text,
      ...(input.unsubscribeUrl ? { headers: { "List-Unsubscribe": `<${input.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } } : {}),
    }),
  };
}

async function post(fetcher: Fetch, init: RequestInit): Promise<SendOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);
  try {
    const response = await fetcher(RESEND_URL, { ...init, signal: controller.signal });
    await response.body?.cancel();
    if (response.ok) return { ok: true };
    // The status only: never the key, the address or the response body.
    console.error(`resend send failed: http_${response.status}`);
    return { ok: false, code: `http_${response.status}` };
  } catch (error) {
    const name = error instanceof Error && /^[A-Za-z0-9_]{1,64}$/.test(error.name) ? error.name : "error";
    console.error(`resend send failed: ${name}`);
    return { ok: false, code: "network" };
  } finally {
    clearTimeout(timer);
  }
}

/** "sina <sina@directionallylocal.com>" as the binding's `{email, name}`; a bare address as is. */
export function bindingSender(from: string): string | { email: string; name: string } {
  const match = /^\s*([^<>]*?)\s*<([^<>\s]+)>\s*$/.exec(from);
  if (!match) return from.trim();
  return match[1] ? { email: match[2]!, name: match[1] } : match[2]!;
}

/** The binding's message for one plain-text email: the same fields and headers as Resend's. */
export function bindingMessage(input: { from: string; replyTo: string; to: string; subject: string; text: string; unsubscribeUrl?: string }): Parameters<UserEmailBinding["send"]>[0] {
  return {
    from: bindingSender(input.from),
    to: input.to,
    replyTo: input.replyTo,
    subject: input.subject,
    text: input.text,
    ...(input.unsubscribeUrl ? { headers: { "List-Unsubscribe": `<${input.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } } : {}),
  };
}

async function sendThroughBinding(binding: UserEmailBinding, message: Parameters<UserEmailBinding["send"]>[0]): Promise<SendOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("timed out"), { code: "timeout" })), BINDING_TIMEOUT_MS);
    });
    const result = await Promise.race([binding.send(message), timeout]);
    return { ok: true, ...(typeof result?.messageId === "string" ? { messageId: result.messageId } : {}) };
  } catch (error) {
    // The error code only (E_RATE_LIMIT_EXCEEDED and the like): never the message or address.
    const code = (error as { code?: unknown } | null)?.code;
    return { ok: false, code: typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : "error" };
  } finally {
    clearTimeout(timer);
  }
}

/** What one send came to. `code` is the provider's error code, safe to show an admin or log. */
export interface SendOutcome {
  ok: boolean;
  code?: string;
  messageId?: string;
}

/**
 * Sends one plain-text email from `config.emailFrom`, Reply-To `config.emailReplyTo`, with the
 * List-Unsubscribe headers, through either provider. Never throws.
 */
export async function sendPlainEmail(
  transport: UserEmailTransport,
  config: Pick<FreeConfig, "emailFrom" | "emailReplyTo">,
  input: { to: string; subject: string; text: string; unsubscribeUrl?: string; idempotencyKey: string },
): Promise<SendOutcome> {
  const fields = { from: config.emailFrom, replyTo: config.emailReplyTo, to: input.to, subject: input.subject, text: input.text, unsubscribeUrl: input.unsubscribeUrl };
  if (transport.provider === "cloudflare") return sendThroughBinding(transport.binding, bindingMessage(fields));
  return post(transport.fetch, resendRequest({ ...fields, apiKey: transport.apiKey, idempotencyKey: input.idempotencyKey }));
}

/**
 * Claims, sends and records one email. "skipped" when the Directory says no (no email, stopped,
 * an admin, already sent, already one today) or emails are off. Never throws.
 */
export async function deliverUserEmail(input: {
  store: UserEmailStore;
  /** The providers (userEmailRoutes): the kind's class picks one. */
  routes: UserEmailRoutes | undefined;
  config: FreeConfig;
  signingKey: CryptoKey;
  base: string;
  kind: UserEmailKind;
  githubId: number;
  period: string;
  now: number;
  retry?: boolean;
  /** weekly_reset's values (its {tokens}, {grows} and {login}). */
  weeklyReset?: WeeklyResetValues;
  /** plan_80's values (the model and its numbers). */
  planWarning?: PlanWarningValues;
  /** welcome_paid's values (the plan, its limits, the bonus line). */
  planWelcome?: PlanWelcomeValues;
  /** plan_reset's values (last week per model). */
  planReset?: PlanResetValues;
  /** The trial emails' values (trials.ts). */
  trial?: TrialEmailValues;
  /** Claim only while fewer than this many emails to users were claimed today (every kind). */
  dailyLimit?: number;
}): Promise<"sent" | "failed" | "skipped"> {
  const { config } = input;
  const { transport, budgetClass } = userEmailRoute(input.routes, input.kind);
  if (!transport || !userEmailsOn(config, transport)) return "skipped";
  let claim: UserEmailClaim | undefined;
  try {
    claim = await input.store.claimUserEmail({
      githubId: input.githubId,
      kind: input.kind,
      period: input.period,
      now: input.now,
      adminIds: [...config.adminGithubIds],
      includeAdmins: config.userEmailsToAdmins,
      ...(input.retry ? { retry: true } : {}),
      ...(input.dailyLimit !== undefined ? { dailyLimit: input.dailyLimit } : {}),
      budget: emailBudgetOf(config),
      budgetClass,
    });
  } catch {
    return "failed";
  }
  if (!claim) return "skipped";
  const unsubscribeUrl = await stopUrl(input.base, input.signingKey, claim.githubId);
  const email = renderUserEmail(claim.kind, { resets: resetsText(weekEnd(input.now)), unsubscribeUrl, proOffered: config.proOffered, ...(input.weeklyReset ? { weeklyReset: input.weeklyReset } : {}), ...(input.planWarning ? { planWarning: input.planWarning } : {}), ...(input.planWelcome ? { planWelcome: input.planWelcome } : {}), ...(input.planReset ? { planReset: input.planReset } : {}), ...(input.trial ? { trial: input.trial } : {}) });
  const { ok } = await sendPlainEmail(transport, config, {
    to: claim.email,
    subject: email.subject,
    text: email.body,
    unsubscribeUrl,
    idempotencyKey: `dl-user-email-${claim.kind}-${claim.githubId}-${claim.period || "once"}`,
  });
  try {
    await input.store.finishUserEmail({ githubId: claim.githubId, kind: claim.kind, period: claim.period, ok, now: input.now });
  } catch {
    // The claim stays pending; the next daily run counts it as a failed attempt.
  }
  return ok ? "sent" : "failed";
}

/** Logs a run's outcome as counts only. */
export function logUserEmails(where: string, outcomes: Array<"sent" | "failed" | "skipped">): void {
  const sent = outcomes.filter((outcome) => outcome === "sent").length;
  const failed = outcomes.filter((outcome) => outcome === "failed").length;
  if (failed > 0) console.error(`user emails (${where}): ${sent} sent, ${failed} failed`);
  else if (sent > 0) console.log(`user emails (${where}): ${sent} sent`);
}

/** Whether a trial account on the free plan has used 80% of its trial tokens. */
export function trialMostlyUsed(allowance: { plan: string; trial: { tokens: number; used: number } | null }): boolean {
  const trial = allowance.trial;
  return allowance.plan === "free" && trial !== null && trial.tokens > 0 && trial.used >= trial.tokens * WEEK_EMAIL_SHARE;
}

/**
 * Whether an allowance is at or past 80% of any pool's weekly tokens or of the weekly dollar cap.
 * Free plan only: Pro and top-ups aren't "this week's free tokens".
 */
export function weekMostlyUsed(allowance: {
  plan: string;
  usdPerWeek: number | null;
  spentUsdThisWeek: number;
  pools: Record<string, { tokensPerWeek: number | null; usedThisWeek: number }>;
}): boolean {
  if (allowance.plan !== "free") return false;
  if (allowance.usdPerWeek !== null && allowance.usdPerWeek > 0 && allowance.spentUsdThisWeek >= allowance.usdPerWeek * WEEK_EMAIL_SHARE) return true;
  return Object.values(allowance.pools).some((pool) => pool.tokensPerWeek !== null && pool.tokensPerWeek > 0 && pool.usedThisWeek >= pool.tokensPerWeek * WEEK_EMAIL_SHARE);
}

// ─── weekly_reset ────────────────────────────────────────────────────────────

/** The first week weekly_reset goes out: Monday 30 Nov 2026. Nothing before it. */
export const WEEKLY_RESET_FIRST_WEEK = Date.UTC(2026, 10, 30);
/** The run starts at the daily run (01:00 UTC Monday); the 10-minute ticks join from 01:30. */
const WEEKLY_RESET_TICK_FROM_MS = 90 * 60_000;
/** It runs Monday and Tuesday (UTC) only: what Monday's daily limit left goes on Tuesday. */
const WEEKLY_RESET_DAYS = 2;

/** Why someone otherwise eligible doesn't get weekly_reset. */
export type WeeklyResetSkip = "trial" | "pro" | "no_allowance" | "not_active";

/**
 * The weekly tokens weekly_reset tells this person about: their own allowance's `tokensPerWeek`,
 * as `dl status` shows it. A skip instead when the account isn't active, is on the one-time
 * trial, on Pro (not free tokens), or has no weekly free tokens.
 */
export function weeklyResetTokens(
  allowance: { plan: string; status: string | null; tokensPerWeek: number | null; trial: unknown },
  onTrial: boolean,
): number | WeeklyResetSkip {
  if (allowance.status !== null && allowance.status !== "active") return "not_active";
  if (onTrial || allowance.trial !== null) return "trial";
  if (allowance.plan !== "free") return "pro";
  if (allowance.tokensPerWeek === null || allowance.tokensPerWeek <= 0) return "no_allowance";
  return allowance.tokensPerWeek;
}

/**
 * Whether a scheduled run at `now` may send weekly_reset: Monday from 01:00 UTC (the daily run;
 * the 10-minute ticks from 01:30) through the end of Tuesday, from WEEKLY_RESET_FIRST_WEEK on.
 */
export function weeklyResetWindow(now: number, via: "daily" | "tick"): boolean {
  const monday = weekStart(now);
  if (monday < WEEKLY_RESET_FIRST_WEEK) return false;
  const since = now - monday;
  return since >= (via === "daily" ? 60 * 60_000 : WEEKLY_RESET_TICK_FROM_MS) && since < WEEKLY_RESET_DAYS * DAY_MS;
}
