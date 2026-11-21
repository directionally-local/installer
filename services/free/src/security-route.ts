/**
 * Security work is served by DeepSeek only, never GPT-6. OpenAI flags security requests on GPT-6
 * against our organisation ("Cyber Abuse" warnings), so a person doing security work (defensive
 * or offensive) keeps DeepSeek V4.1 Flash and is refused GPT-6 with the GPT-6 limit's refusal
 * (402 gpt_limit, `alternative` DeepSeek, `reason` "security"), which every client already turns
 * into "switch to DeepSeek".
 *
 * Two ways a (person, session) is held off GPT-6, and the person with it for the rest of the UTC day:
 *
 *   1. Its use description (use-description.ts) says security: a category in SECURITY_CATEGORIES
 *      or a "high" risk. The description is made after the session's first request, so this
 *      catches the requests after it.
 *   2. Before a GPT-6 request is forwarded, the request's text matches one of the keyword rules
 *      (detection-rules.ts: private in production, from the DETECTION_RULES secret): plain
 *      regular expressions, run locally, no network call. This catches the first request.
 *      The text is every user message (string content and text parts) and every tool result, up
 *      to SECURITY_PRECHECK_BUDGET characters in all; a part longer than its share is read from
 *      both ends (its start and its end), so harmless padding never pushes a request out of view.
 *
 * A pre-check match is also recorded as a use description (keywordLabel: "Keyword match:
 * <rule>", no model call), so it shows on the admin page and a high one gets a moderation review
 * (moderation.ts).
 *
 * DeepSeek requests and admins are never affected; the `securityOffGpt6` runtime setting turns it
 * off. Holds and refusal counts live in the Directory (`gpt6_holds`, `security_refusals_daily`).
 */

import { DEFAULT_DETECTION_RULES, type DetectionRules } from "./detection-rules.js";
import type { UseLabel } from "./use-description.js";

/** The refusal's message (code gpt_limit). */
export const SECURITY_GPT6_MESSAGE = "GPT-6 isn't available for security work on the free tier. DeepSeek V4.1 Flash still works: switch with /model.";

/** The gpt_limit refusal's `reason` for security work (the weekly limit's are "tokens" / "usd"). */
export const SECURITY_REASON = "security";

/** Use-description categories that hold a session off GPT-6 (a "high" risk does too, whatever its category). */
export const SECURITY_CATEGORIES: ReadonlySet<string> = new Set(["security-defensive", "security-offensive", "malware", "credential-theft"]);

/** Whether a session's use description holds it (and its person, for the day) off GPT-6. */
export function labelKeepsOffGpt6(label: Pick<UseLabel, "risk" | "category"> | undefined): boolean {
  return label !== undefined && (label.risk === "high" || SECURITY_CATEGORIES.has(label.category));
}

/** How much of a request's text the pre-check reads, in all (64 KB of text, in UTF-16 units). */
export const SECURITY_PRECHECK_BUDGET = 65_536;

/** The use description recorded for a pre-check match (no model call): the rule's category and risk. */
export function keywordLabel(signal: string, rules: DetectionRules = DEFAULT_DETECTION_RULES): UseLabel {
  const rule = rules.keywords.find((candidate) => candidate.id === signal);
  return { use: `Keyword match: ${signal}`, risk: rule?.risk ?? "low", category: rule?.category ?? "security-offensive" };
}

/**
 * The first keyword rule any of `texts` matches, by `id`, or undefined for none. Each text is
 * read on its own (a rule's patterns must all match the same text), in full: fit long input to
 * SECURITY_PRECHECK_BUDGET first (precheckTexts does). A "high" rule wins over an earlier "low"
 * one, so a harmless-looking mention can't hide a worse one.
 */
export function securitySignal(texts: string | readonly string[] | undefined, rules: DetectionRules = DEFAULT_DETECTION_RULES): string | undefined {
  if (texts === undefined) return undefined;
  let first: string | undefined;
  for (const text of typeof texts === "string" ? [texts] : texts) {
    if (!text) continue;
    for (const rule of rules.keywords) {
      const high = rule.risk === "high";
      if (first !== undefined && !high) continue;
      if (!rule.all.every((pattern) => pattern.test(text))) continue;
      if (high) return rule.id;
      first ??= rule.id;
    }
  }
  return first;
}

/** The text of a message's content: a string, or its text parts (and tool_result parts' text). */
function partTexts(content: unknown, out: string[]): void {
  if (typeof content === "string") {
    if (content) out.push(content);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const { type, text, content: nested } = part as { type?: unknown; text?: unknown; content?: unknown };
    if (typeof text === "string" && (type === "text" || type === "input_text") && text) out.push(text);
    else if (type === "tool_result") partTexts(nested, out);
  }
}

/**
 * What the pre-check reads from a chat completions body: the text of every user message and every
 * tool result (`tool` or `function` messages, and `tool_result` parts), in order; never system,
 * developer or assistant messages. Fitted to `budget` characters in all (fitToBudget).
 */
export function precheckTexts(body: Record<string, unknown>, budget = SECURITY_PRECHECK_BUDGET): string[] {
  const messages = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];
  const texts: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const { role, content } = message as { role?: unknown; content?: unknown };
    if (role === "user" || role === "tool" || role === "function") partTexts(content, texts);
  }
  return fitToBudget(texts, budget);
}

/**
 * `texts` cut to `budget` characters in all. Short texts are kept whole and what they leave is
 * shared evenly among the longer ones; a text longer than its share keeps the first half of its
 * share and the last half (joined by a newline), so its end is always read.
 */
export function fitToBudget(texts: readonly string[], budget = SECURITY_PRECHECK_BUDGET): string[] {
  let total = 0;
  for (const text of texts) total += text.length;
  if (total <= budget) return [...texts];
  const order = texts.map((_, index) => index).sort((a, b) => texts[a]!.length - texts[b]!.length);
  const shares = new Array<number>(texts.length);
  let left = budget;
  let remaining = texts.length;
  for (const index of order) {
    const share = Math.min(texts[index]!.length, Math.floor(left / remaining));
    shares[index] = share;
    left -= share;
    remaining--;
  }
  return texts.map((text, index) => {
    const share = shares[index]!;
    if (text.length <= share) return text;
    if (share <= 0) return "";
    const head = Math.ceil(share / 2);
    return `${text.slice(0, head)}\n${text.slice(text.length - (share - head))}`;
  });
}

/** When a security hold made today ends: the next UTC midnight, as an ISO time. */
export function securityHoldEnds(now: number): string {
  const day = 86_400_000;
  return new Date((Math.floor(now / day) + 1) * day).toISOString();
}
