import { base64urlDecode, base64urlEncode } from "../../shared/src/auth.js";
import type { FreeConfig } from "./config.js";
import { renderUserEmail, resetsText, type UserEmailKind } from "./user-emails.js";
import { weekEnd } from "./week.js";

/**
 * Emails to the people on the free tier (the copy is in user-emails.ts), sent through Resend's
 * HTTP API with RESEND_API_KEY. Without the key nothing is sent and nothing fails; the runtime
 * setting `userEmails` turns them all off without a deploy.
 *
 *   welcome      right after a new sign-up gives their email on the details step (app.ts)
 *   didnt_start  daily cron: admitted 24 to 72 hours ago, no request yet
 *   week_80      when a request's settlement takes the week's usage to 80% of a pool's tokens
 *                or of the weekly dollar cap (once per week)
 *   gone_quiet   daily cron: requests on 2 or more days, none in the last 7 days
 *
 * Only to people with an email who haven't pressed stop, never to admins (unless
 * USER_EMAILS_TO_ADMINS, for testing), at most one a day per person, each kind once per person
 * (week_80 once per week). Every send is claimed in the Directory's `user_emails` table before
 * the call to Resend and marked after it, so nothing double-sends across retries or deploys;
 * Resend's Idempotency-Key covers a crash between the two. A failed send is retried once, on
 * the next daily run. Failures are logged as counts, never with an address or the key.
 */

export const RESEND_URL = "https://api.resend.com/emails";
/** Where the unsubscribe link points when PUBLIC_URL isn't set. */
export const EMAIL_STOP_BASE = "https://free.directionallylocal.com";
/** The share of a weekly allowance that sends week_80. */
export const WEEK_EMAIL_SHARE = 0.8;
const RESEND_TIMEOUT_MS = 5000;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** What the Directory hands back for a send it has reserved. */
export interface UserEmailClaim {
  githubId: number;
  email: string;
  kind: UserEmailKind;
  period: string;
}

/** The Directory's side (directory-object.ts). */
export interface UserEmailStore {
  claimUserEmail(input: { githubId: number; kind: UserEmailKind; period: string; now: number; adminIds: number[]; includeAdmins: boolean; retry?: boolean }): Promise<UserEmailClaim | undefined>;
  finishUserEmail(input: { githubId: number; kind: UserEmailKind; period: string; ok: boolean; now: number }): Promise<void>;
}

/** Whether user emails go out at all: a Resend key, and the setting on. */
export function userEmailsOn(config: Pick<FreeConfig, "resendApiKey" | "userEmails">): boolean {
  return config.resendApiKey !== undefined && config.userEmails;
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
  unsubscribeUrl: string;
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
      headers: { "List-Unsubscribe": `<${input.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    }),
  };
}

async function post(fetcher: Fetch, init: RequestInit): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);
  try {
    const response = await fetcher(RESEND_URL, { ...init, signal: controller.signal });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Claims, sends and records one email. "skipped" when the Directory says no (no email, stopped,
 * an admin, already sent, already one today) or emails are off. Never throws.
 */
export async function deliverUserEmail(input: {
  store: UserEmailStore;
  fetch: Fetch;
  config: FreeConfig;
  signingKey: CryptoKey;
  base: string;
  kind: UserEmailKind;
  githubId: number;
  period: string;
  now: number;
  retry?: boolean;
}): Promise<"sent" | "failed" | "skipped"> {
  const { config } = input;
  if (!userEmailsOn(config)) return "skipped";
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
    });
  } catch {
    return "failed";
  }
  if (!claim) return "skipped";
  const unsubscribeUrl = await stopUrl(input.base, input.signingKey, claim.githubId);
  const email = renderUserEmail(claim.kind, { resets: resetsText(weekEnd(input.now)), unsubscribeUrl });
  const ok = await post(
    input.fetch,
    resendRequest({
      apiKey: config.resendApiKey!,
      from: config.emailFrom,
      replyTo: config.emailReplyTo,
      to: claim.email,
      subject: email.subject,
      text: email.body,
      unsubscribeUrl,
      idempotencyKey: `dl-user-email-${claim.kind}-${claim.githubId}-${claim.period || "once"}`,
    }),
  );
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

/**
 * Whether an allowance is at or past 80% of any pool's weekly tokens or of the weekly dollar cap.
 * Free plan only: Pro and top-ups aren't "this week's free tokens".
 */
export function weekMostlyUsed(allowance: {
  plan: string;
  usdPerWeek: number | null;
  spentUsdThisWeek: number;
  pools: Record<string, { tokensPerWeek: number; usedThisWeek: number }>;
}): boolean {
  if (allowance.plan !== "free") return false;
  if (allowance.usdPerWeek !== null && allowance.usdPerWeek > 0 && allowance.spentUsdThisWeek >= allowance.usdPerWeek * WEEK_EMAIL_SHARE) return true;
  return Object.values(allowance.pools).some((pool) => pool.tokensPerWeek > 0 && pool.usedThisWeek >= pool.tokensPerWeek * WEEK_EMAIL_SHARE);
}
