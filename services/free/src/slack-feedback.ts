import type { ClientInfo } from "./feedback.js";
import type { Sql } from "./dashboard-data.js";
import { DAY_MS } from "./week.js";

/**
 * New feedback, "unsupported coding agent" requests and provider inquiries, posted to a Slack
 * Incoming Webhook (SLACK_FEEDBACK_WEBHOOK_URL). Email is still sent as before; Slack is a
 * second, optional channel. A post is fire-and-forget (the request never waits or fails for it)
 * and gives up after 3 seconds. At most 200 posts go out a UTC day, all three sources together.
 *
 * Slack message text escapes &, < and > in everything people typed, and long text is cut at
 * about 2,500 characters with a "(truncated)" note. The webhook URL itself is never logged.
 * Only a per-day count is stored: feedback's message and reply address still aren't stored.
 */

export const SLACK_FEEDBACK_WEBHOOK_ENV = "SLACK_FEEDBACK_WEBHOOK_URL";
export const SLACK_FEEDBACK_DAILY_CAP = 200;
export const SLACK_FEEDBACK_TIMEOUT_MS = 3000;
export const SLACK_TEXT_MAX_CHARS = 2500;
export const SLACK_TRUNCATED_NOTE = "… (truncated)";

export interface SlackSender {
  login: string;
  githubId?: number;
}

export type SlackItem =
  | { kind: "feedback"; at: number; message: string; sender?: SlackSender | undefined; client: ClientInfo; replyTo?: string | null }
  | {
      kind: "agent-request";
      at: number;
      name: string;
      os?: string | null;
      arch?: string | null;
      dlVersion?: string | null;
      found?: readonly string[];
      account?: SlackSender | null;
    }
  | {
      kind: "provider-inquiry";
      at: number;
      company: string;
      name: string;
      email: string;
      website?: string | null;
      models?: string | null;
      regions?: string | null;
      credits?: string | null;
      notes?: string | null;
    };

export const SLACK_FEEDBACK_SCHEMA = [
  // Slack posts about new feedback, agent requests and provider inquiries, per UTC day: a count
  // only, so the 200-a-day cap holds across isolates. Never any message text.
  `CREATE TABLE IF NOT EXISTS slack_feedback_daily (
     day INTEGER PRIMARY KEY,
     n   INTEGER NOT NULL
   )`,
];

/** Whether one more Slack post is allowed this UTC day; counts it when it is. */
export function takeSlackPost(sql: Sql, at: number, cap = SLACK_FEEDBACK_DAILY_CAP): boolean {
  const day = Math.floor(at / DAY_MS);
  const before = sql.exec<{ n: number }>("SELECT n FROM slack_feedback_daily WHERE day = ?", day).toArray()[0]?.n ?? 0;
  if (before >= cap) return false;
  sql.exec("INSERT INTO slack_feedback_daily (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1", day);
  return true;
}

/** Slack mrkdwn treats &, < and > specially; & first so the escapes themselves aren't escaped. */
export function escapeSlackText(value: string): string {
  return value.replace(/[&<>]/g, (char) => (char === "&" ? "&amp;" : char === "<" ? "&lt;" : "&gt;"));
}

/** Cuts `value` at `max` characters (not UTF-16 units) and marks it. */
export function truncateSlackText(value: string, max = SLACK_TEXT_MAX_CHARS): string {
  const characters = [...value];
  if (characters.length <= max) return value;
  return `${characters.slice(0, max).join("")}${SLACK_TRUNCATED_NOTE}`;
}

function quote(value: string): string {
  return truncateSlackText(value)
    .split("\n")
    .map((line) => `> ${escapeSlackText(line)}`)
    .join("\n");
}

function utc(at: number): string {
  const iso = new Date(at).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

function who(who: SlackSender | null | undefined): string {
  if (!who) return "not signed in";
  return `@${escapeSlackText(who.login)} (https://github.com/${encodeURIComponent(who.login)})`;
}

const CLIENT_LABELS: Record<keyof ClientInfo, string> = { dl: "dl", autopilot: "Autopilot", os: "OS", arch: "Arch", provider: "Provider" };
const CLIENT_ORDER: Array<keyof ClientInfo> = ["dl", "autopilot", "os", "arch", "provider"];

function feedbackLines(item: Extract<SlackItem, { kind: "feedback" }>): string[] {
  const lines = ["*Feedback* (POST /v1/feedback)", `From: ${who(item.sender)}`, quote(item.message)];
  const client = CLIENT_ORDER.filter((field) => item.client[field] !== undefined).map((field) => `${CLIENT_LABELS[field]} ${escapeSlackText(item.client[field]!)}`);
  if (client.length > 0) lines.push(`Client: ${client.join(", ")}`);
  if (item.replyTo) lines.push(`Reply to: ${escapeSlackText(item.replyTo)}`);
  lines.push(`Time: ${utc(item.at)}`);
  return lines;
}

function agentRequestLines(item: Extract<SlackItem, { kind: "agent-request" }>): string[] {
  const lines = ["*Unsupported coding agent* (POST /v1/agent-request)", `From: ${who(item.account)}`, `Agent: ${escapeSlackText(item.name)}`];
  const platform = [item.os, item.arch].filter((part): part is string => part !== null && part !== undefined && part !== "").join("/");
  if (platform) lines.push(`OS/arch: ${escapeSlackText(platform)}`);
  if (item.dlVersion) lines.push(`dl version: ${escapeSlackText(item.dlVersion)}`);
  if (item.found && item.found.length > 0) lines.push(`Agents dl found: ${item.found.map(escapeSlackText).join(", ")}`);
  lines.push(`Time: ${utc(item.at)}`);
  return lines;
}

function providerInquiryLines(item: Extract<SlackItem, { kind: "provider-inquiry" }>): string[] {
  const lines = [
    "*Provider inquiry* (POST /web/provider-inquiry)",
    `Company: ${escapeSlackText(item.company)}`,
    `Name: ${escapeSlackText(item.name)}`,
  ];
  const optional: Array<[string, string | null | undefined]> = [
    ["Website", item.website],
    ["Models", item.models],
    ["Regions", item.regions],
    ["Credits", item.credits],
  ];
  for (const [label, value] of optional) if (value) lines.push(`${label}: ${escapeSlackText(value)}`);
  if (item.notes) lines.push("Notes:", quote(item.notes));
  lines.push(`Reply to: ${escapeSlackText(item.email)}`, `Time: ${utc(item.at)}`);
  return lines;
}

/** The one compact Slack message for an item. */
export function slackMessage(item: SlackItem): string {
  const lines = item.kind === "feedback" ? feedbackLines(item) : item.kind === "agent-request" ? agentRequestLines(item) : providerInquiryLines(item);
  return lines.join("\n");
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Posts one message, giving up (and aborting the fetch) after `timeoutMs`. Never throws. */
export async function postSlackMessage(webhookUrl: string, item: SlackItem, fetcher: Fetch, timeoutMs = SLACK_FEEDBACK_TIMEOUT_MS): Promise<boolean> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(false);
    }, timeoutMs);
  });
  try {
    const post = (async () => {
      const response = await fetcher(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: slackMessage(item) }),
        signal: controller.signal,
      });
      if (!response.ok) {
        console.error("slack feedback failed", response.status);
        return false;
      }
      return true;
    })().catch((error) => {
      console.error("slack feedback failed", error instanceof Error ? error.name : "error");
      return false;
    });
    return await Promise.race([post, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface SlackContext {
  env: {
    SLACK_FEEDBACK_WEBHOOK_URL?: string;
    DIRECTORY: { getByName(name: string): { takeSlackPost(at: number): Promise<boolean> } };
  };
  fetch: Fetch;
  now: () => number;
  background?: (task: Promise<unknown>) => void;
}

/** Posts in the background when the secret is set and the day's cap allows it; never awaited. */
export function queueSlackFeedback(c: SlackContext, item: SlackItem): void {
  const webhookUrl = c.env.SLACK_FEEDBACK_WEBHOOK_URL;
  if (!webhookUrl) return;
  const task = (async () => {
    try {
      const allowed = await c.env.DIRECTORY.getByName("directory").takeSlackPost(c.now());
      if (!allowed) return;
      await postSlackMessage(webhookUrl, item, c.fetch);
    } catch (error) {
      console.error("slack feedback failed", error instanceof Error ? error.name : "error");
    }
  })();
  if (c.background) c.background(task);
  else void task;
}
