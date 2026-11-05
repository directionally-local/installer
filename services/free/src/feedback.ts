import { isHeaderSafeAddress } from "./alerts.js";

/**
 * Feedback from the client, emailed to the owner (POST /v1/feedback). Nothing here is stored:
 * the message and any reply address go into one email and are then gone. This module holds
 * the parts that don't need a request: checking the body, the public GitHub email lookup (with
 * its per-isolate cache), and the email itself.
 */

export const MAX_MESSAGE_CHARS = 5000;
export const MAX_EMAIL_CHARS = 254;
/** The longest a client field may be. */
export const MAX_CLIENT_CHARS = 40;
/** The client fields kept, in the order the email lists them. Anything else is ignored. */
export const CLIENT_FIELDS = ["dl", "autopilot", "os", "arch", "provider"] as const;
export type ClientField = (typeof CLIENT_FIELDS)[number];
export type ClientInfo = Partial<Record<ClientField, string>>;
export const PROVIDERS = ["free", "own-key"] as const;
const CLIENT_VALUE = /^[\w.\-+ ]+$/;
/** The largest request body read, in bytes: a 5,000-character message in any script fits. */
export const MAX_FEEDBACK_BYTES = 32 * 1024;

export const GITHUB_LOOKUP_TIMEOUT_MS = 3000;
export const GITHUB_LOOKUP_USER_AGENT = "dl-free-feedback";
export const EMAIL_CACHE_TTL_MS = 10 * 60_000;
/** Logins kept in the cache at most; the oldest entry goes first. */
const EMAIL_CACHE_MAX = 1000;

export interface Feedback {
  message: string;
  /** The reply address the person typed; undefined when they gave none (or only a noreply one). */
  email: string | undefined;
  client: ClientInfo;
}

export type Parsed = { ok: true; value: Feedback } | { ok: false; code: "invalid_request" | "invalid_email"; message: string };

/** GitHub's private relay addresses can't take a reply, so they never become Reply-To. */
export function isNoreplyAddress(email: string): boolean {
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  return domain === "noreply.github.com" || domain.endsWith(".noreply.github.com");
}

/** An address that can be a Reply-To: header-safe (one @, no spaces, CR or LF, ≤254) and not a GitHub noreply. */
export function usableReplyAddress(email: string): boolean {
  return email.length <= MAX_EMAIL_CHARS && isHeaderSafeAddress(email) && !isNoreplyAddress(email);
}

/** Checks a POST /v1/feedback body. */
export function parseFeedback(body: Record<string, unknown>): Parsed {
  const { message, email, client } = body;
  if (typeof message !== "string" || message.trim().length === 0) {
    return { ok: false, code: "invalid_request", message: "Send {message} with some text in it." };
  }
  if ([...message].length > MAX_MESSAGE_CHARS) {
    return { ok: false, code: "invalid_request", message: `The message is longer than ${MAX_MESSAGE_CHARS.toLocaleString("en-US")} characters.` };
  }
  let replyEmail: string | undefined;
  if (email !== undefined && email !== null && email !== "") {
    if (typeof email !== "string" || email.length > MAX_EMAIL_CHARS || !isHeaderSafeAddress(email)) {
      return { ok: false, code: "invalid_email", message: "That doesn't look like an email address: one @, no spaces, at most 254 characters." };
    }
    // A GitHub noreply address can't get a reply: treated as no address at all.
    replyEmail = isNoreplyAddress(email) ? undefined : email;
  }
  const info: ClientInfo = {};
  if (client !== undefined && client !== null) {
    if (typeof client !== "object" || Array.isArray(client)) return { ok: false, code: "invalid_request", message: "client must be an object." };
    for (const field of CLIENT_FIELDS) {
      const value = (client as Record<string, unknown>)[field];
      if (value === undefined || value === null || value === "") continue;
      if (typeof value !== "string" || value.length > MAX_CLIENT_CHARS || !CLIENT_VALUE.test(value)) {
        return { ok: false, code: "invalid_request", message: `client.${field} must be at most ${MAX_CLIENT_CHARS} letters, digits, spaces or . - + _` };
      }
      if (field === "provider" && !(PROVIDERS as readonly string[]).includes(value)) {
        return { ok: false, code: "invalid_request", message: 'client.provider is "free" or "own-key".' };
      }
      info[field] = value;
    }
  }
  return { ok: true, value: { message, email: replyEmail, client: info } };
}

// ─── The public GitHub email ─────────────────────────────────────────────────

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const emailCache = new Map<string, { email: string | null; at: number }>();

/** Empties the per-isolate cache, for tests. */
export function clearEmailCache(): void {
  emailCache.clear();
}

/**
 * The public email on `login`'s GitHub profile, or null: none set, a noreply address, not
 * usable as a header, GitHub said no, or no answer within the timeout. Unauthenticated
 * (`GET https://api.github.com/users/<login>`). A definite answer is cached per isolate for
 * 10 minutes; a failure isn't, so the next request asks again.
 */
export async function publicGithubEmail(login: string, fetcher: Fetch, now: number, timeoutMs = GITHUB_LOOKUP_TIMEOUT_MS): Promise<string | null> {
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) return null;
  const key = login.toLowerCase();
  const cached = emailCache.get(key);
  if (cached && now - cached.at < EMAIL_CACHE_TTL_MS) return cached.email;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(undefined);
    }, timeoutMs);
  });
  try {
    const lookup = (async () => {
      const response = await fetcher(`https://api.github.com/users/${encodeURIComponent(login)}`, {
        headers: { accept: "application/vnd.github+json", "user-agent": GITHUB_LOOKUP_USER_AGENT, "x-github-api-version": "2022-11-28" },
        signal: controller.signal,
      });
      if (response.status === 404) return { email: null };
      if (!response.ok) return undefined;
      const user = (await response.json().catch(() => undefined)) as { email?: unknown } | undefined;
      if (!user || typeof user !== "object") return undefined;
      return { email: typeof user.email === "string" && usableReplyAddress(user.email) ? user.email : null };
    })().catch(() => undefined);
    const answer = await Promise.race([lookup, timeout]);
    if (!answer) return null;
    if (emailCache.size >= EMAIL_CACHE_MAX && !emailCache.has(key)) emailCache.delete(emailCache.keys().next().value!);
    emailCache.delete(key);
    emailCache.set(key, { email: answer.email, at: now });
    return answer.email;
  } finally {
    clearTimeout(timer);
  }
}

// ─── The email to the owner ──────────────────────────────────────────────────

export interface Sender {
  login: string;
  githubId: number;
}

const CLIENT_LABELS: Record<ClientField, string> = { dl: "dl", autopilot: "Autopilot", os: "OS", arch: "Arch", provider: "Provider" };

/** "2026-11-04 12:00:00 UTC". */
function utc(at: number): string {
  const iso = new Date(at).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

/**
 * The owner's email: the message verbatim, then who sent it, where a reply goes, the client
 * and the time. `replySource` says where the address came from.
 */
export function feedbackEmail(input: {
  message: string;
  sender: Sender | undefined;
  replyTo: string | null;
  replySource: "given" | "github" | undefined;
  client: ClientInfo;
  at: number;
}): { subject: string; body: string } {
  const { sender, replyTo } = input;
  const lines = ["", "", "──────────"];
  lines.push(sender ? `From: @${sender.login} (https://github.com/${sender.login}), GitHub id ${sender.githubId}` : "From: not signed in");
  if (replyTo) {
    lines.push(`Reply to: ${replyTo} (${input.replySource === "github" ? "their public GitHub email" : "given with the feedback"}). Replying to this email reaches them.`);
  } else {
    lines.push("Reply to: no email given: they can't get a reply");
    if (sender) lines.push(`Reply through GitHub: open an issue mention or DM @${sender.login}`);
  }
  const client = CLIENT_FIELDS.filter((field) => input.client[field] !== undefined).map((field) => `${CLIENT_LABELS[field]} ${input.client[field]}`);
  lines.push(`Client: ${client.length > 0 ? client.join(", ") : "not given"}`);
  lines.push(`Time: ${utc(input.at)}`);
  lines.push("", "Sent by the free tier service. The message and the reply address aren't stored anywhere.");
  return {
    subject: sender ? `dl feedback from @${sender.login}` : "dl feedback (not signed in)",
    body: `${input.message}${lines.join("\n")}\n`,
  };
}
