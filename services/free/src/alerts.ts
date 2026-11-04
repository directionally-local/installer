import type { AlertKind, FreeConfig } from "./config.js";

/**
 * Alerts to the owner's chat: free spend crossing 50%, 80% and 100% of the weekly cap (once
 * per threshold per week) and of the all-time cap (once per threshold, ever), the kill switch,
 * the queue starting, and an OpenRouter host failing more than 20% of its requests over the
 * last hour. Counts and dollars only.
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

export function pauseAlert(paused: boolean, login: string): Alert {
  return paused
    ? { subject: "dl free tier: free tokens paused (kill switch)", text: `dl free tier: free tokens paused for everyone by ${login} (kill switch).` }
    : { subject: "dl free tier: free tokens resumed (kill switch off)", text: `dl free tier: free tokens resumed by ${login} (kill switch off).` };
}

export function queueStartedAlert(weekUsd: number, capUsd: number | undefined): Alert {
  const spend = capUsd === undefined ? "" : ` (${dollars(weekUsd)} of the ${dollars(capUsd)} weekly cap used)`;
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
 * A small RFC 5322 message: plain text, UTF-8, base64 body. Enough for an alert; no
 * dependency needed.
 */
export function mimeMessage(input: { from: string; to: string; subject: string; body: string; now: number; messageId: string }): string {
  const domain = input.from.split("@")[1] ?? "dl.new";
  const body = base64(input.body.replace(/\r?\n/g, "\r\n")).replace(/.{1,76}/g, "$&\r\n");
  return [
    `From: dl free tier <${input.from}>`,
    `To: <${input.to}>`,
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

export function emailBody(alert: Alert, adminUrl: string): string {
  return `${alert.text}\n\nAdmin dashboard: ${adminUrl}\n\nSent by the free tier service once per threshold. Counts and dollars only.\n`;
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
        const raw = mimeMessage({ from: config.alertEmailFrom, to: config.alertEmailTo, subject: alert.subject, body: emailBody(alert, input.adminUrl), now: input.now, messageId: crypto.randomUUID() });
        // Only reached where the binding exists (Cloudflare); the module is never loaded elsewhere.
        const { EmailMessage } = await import("cloudflare:email"); // portable-exception: optional send_email binding
        await input.emailBinding.send(new EmailMessage(config.alertEmailFrom, config.alertEmailTo, raw));
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
