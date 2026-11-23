/**
 * Pre-send safety checks for GPT-6. Before a non-admin's GPT-6 request is forwarded to OpenAI,
 * its NEW content is checked by two classifiers at once:
 *
 *   1. OpenAI's Moderation API (omni-moderation-latest) on the company's OpenAI key: "flagged"
 *      stops the request.
 *   2. gpt-oss-safeguard-20b on OpenRouter, told the policy in DETECTION_RULES's `guardPolicy`
 *      (detection-rules.ts: private in production, a generic default here). It answers "1"
 *      (violates) or "0".
 *
 * The checks fail CLOSED: a flag from either, an error, an unreadable answer or no answer within
 * `gpt6GuardTimeoutMs` (each) means the request is not sent to OpenAI. The client gets the
 * GPT-6 limit's refusal pointing at DeepSeek (402 gpt_limit, `alternative`), which every agent
 * already turns into "switch to DeepSeek". A flag also holds the session and the person's UTC day
 * off GPT-6 and is recorded as a high-risk use label (model "presend:openai" or
 * "presend:safeguard"), so the moderation reviewer looks at it.
 *
 * What is checked is the new content only: the latest user message, and every tool result after
 * the last assistant turn, cut to GUARD_INPUT_CHARS (each long part read from both ends, see
 * fitToBudget). Every request shape the service sees is read the same way: chat completions
 * (Autopilot, OpenCode), Anthropic Messages (Claude Code; translated to chat completions before
 * the guard, but its blocks are read here too), and Responses input items.
 *
 * Nothing here stores or logs content: the Directory gets an outcome and a reason code.
 */

import { fitToBudget } from "./security-route.js";
import { costOf, parseUsage } from "./quota.js";

export const MODERATION_URL = "https://api.openai.com/v1/moderations";
export const MODERATION_MODEL = "omni-moderation-latest";
export const SAFEGUARD_URL = "https://openrouter.ai/api/v1/chat/completions";
export const SAFEGUARD_MODEL = "openai/gpt-oss-safeguard-20b";
export const SAFEGUARD_MAX_TOKENS = 400;

/** How much new content the checkers see, in all (head and tail of long parts). */
export const GUARD_INPUT_CHARS = 12_000;

/** The refusal's message (code gpt_limit). Says nothing about why: the reason code is logged. */
export const GUARD_GPT6_MESSAGE = "GPT-6 can't take this request on the free tier. DeepSeek V4.1 Flash still works: switch with /model.";

/** The daily counters (Directory `gpt6_guard_daily`), as /admin/metrics shows them. */
export const GUARD_OUTCOMES = ["passed", "flagged_openai", "flagged_safeguard", "error"] as const;
export type GuardOutcome = (typeof GUARD_OUTCOMES)[number];

export type Checker = "openai" | "safeguard";

/** One checker's answer: a pass, a flag, or why it couldn't say (a code, never content). */
export type CheckResult = { verdict: "pass" } | { verdict: "flag" } | { verdict: "error"; reason: string };

export interface GuardSpend {
  tokens: number;
  cashUsd: number;
}

export interface GuardResult {
  /** "pass": both passed; "flag": at least one flagged; "error": none flagged, at least one failed. */
  verdict: "pass" | "flag" | "error";
  openai: CheckResult;
  safeguard: CheckResult;
  /** The checkers that flagged, OpenAI's first. */
  flaggedBy: Checker[];
  /** A short code for the log: "ok", "flagged:openai", "openai:timeout", ... Never content. */
  reason: string;
  /** What the safeguard call cost (OpenRouter's reported cost), for internal accounting. */
  spend: GuardSpend;
  /** The text the checkers saw (for the moderation reviewer of a flag; in flight only). */
  text: string;
}

type Json = Record<string, unknown>;
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

function isObject(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// ─── What is new in a request ───────────────────────────────────────────────

/** Text of a content value: a string, or text parts (text, input_text, output_text). Tool results are left out. */
function plainTexts(content: unknown, out: string[]): void {
  if (typeof content === "string") {
    if (content) out.push(content);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (typeof part === "string") {
      if (part) out.push(part);
      continue;
    }
    if (!isObject(part)) continue;
    if ((part.type === "text" || part.type === "input_text" || part.type === "output_text") && typeof part.text === "string" && part.text) out.push(part.text);
  }
}

/** Text of an Anthropic message's tool_result blocks. */
function toolResultTexts(content: unknown, out: string[]): void {
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (isObject(part) && part.type === "tool_result") plainTexts(part.content, out);
  }
}

/** Whether a user message carries the person's own words (not only tool results). */
function hasOwnText(content: unknown): boolean {
  const texts: string[] = [];
  plainTexts(content, texts);
  return texts.length > 0;
}

/** One turn of a request, whatever its shape. */
interface Turn {
  kind: "user" | "assistant" | "tool" | "other";
  /** The person's own words (user turns). */
  own: string[];
  /** Tool output (tool turns, and tool_result blocks inside user turns). */
  tool: string[];
}

/** Chat completions or Anthropic `messages`. */
function messageTurns(messages: unknown[]): Turn[] {
  return messages.map((message): Turn => {
    if (!isObject(message)) return { kind: "other", own: [], tool: [] };
    const { role, content } = message;
    if (role === "assistant") return { kind: "assistant", own: [], tool: [] };
    if (role === "tool" || role === "function") {
      const tool: string[] = [];
      plainTexts(content, tool);
      return { kind: "tool", own: [], tool };
    }
    if (role === "user") {
      const own: string[] = [];
      const tool: string[] = [];
      plainTexts(content, own);
      toolResultTexts(content, tool);
      return { kind: hasOwnText(content) ? "user" : "tool", own, tool };
    }
    return { kind: "other", own: [], tool: [] };
  });
}

/** Responses `input`: a string, or items (messages, function calls and their outputs). */
function inputTurns(input: unknown): Turn[] {
  if (typeof input === "string") return [{ kind: "user", own: input ? [input] : [], tool: [] }];
  if (!Array.isArray(input)) return [];
  return input.map((item): Turn => {
    if (!isObject(item)) return { kind: "other", own: [], tool: [] };
    const type = item.type ?? "message";
    if (type === "message") {
      if (item.role === "assistant") return { kind: "assistant", own: [], tool: [] };
      if (item.role === "user") {
        const own: string[] = [];
        plainTexts(item.content, own);
        return { kind: "user", own, tool: [] };
      }
      return { kind: "other", own: [], tool: [] };
    }
    if (type === "function_call" || type === "custom_tool_call" || type === "reasoning") return { kind: "assistant", own: [], tool: [] };
    if (type === "function_call_output" || type === "custom_tool_call_output") {
      const tool: string[] = [];
      plainTexts(item.output, tool);
      return { kind: "tool", own: [], tool };
    }
    return { kind: "other", own: [], tool: [] };
  });
}

/**
 * The new content of a request, as separate texts: the latest user message (the person's own
 * words, wherever it is), then every user message and tool result after the last assistant turn,
 * in order. Reads chat completions and Anthropic `messages`, and Responses `input`. System,
 * developer and assistant content is never included.
 */
export function newContentTexts(body: Json): string[] {
  const turns = Array.isArray(body.messages) ? messageTurns(body.messages) : body.input !== undefined ? inputTurns(body.input) : [];
  let lastAssistant = -1;
  let latestUser = -1;
  turns.forEach((turn, index) => {
    if (turn.kind === "assistant") lastAssistant = index;
    if (turn.kind === "user" && turn.own.length > 0) latestUser = index;
  });
  const texts: string[] = [];
  if (latestUser >= 0 && latestUser < lastAssistant) texts.push(...turns[latestUser]!.own);
  for (const turn of turns.slice(lastAssistant + 1)) texts.push(...turn.own, ...turn.tool);
  return texts;
}

/** newContentTexts fitted to `budget` characters (fitToBudget) and joined: what the checkers are sent. */
export function guardInput(body: Json, budget = GUARD_INPUT_CHARS): string {
  return fitToBudget(newContentTexts(body), budget).filter(Boolean).join("\n\n");
}

// ─── The checkers ───────────────────────────────────────────────────────────

/** `run` with `ms` to finish (its answer read included), else an "error" with reason "timeout". */
async function withTimeout(ms: number, run: (signal: AbortSignal) => Promise<CheckResult>): Promise<CheckResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CheckResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ verdict: "error", reason: "timeout" });
    }, Math.max(1, ms));
  });
  const work = run(controller.signal).catch((): CheckResult => ({ verdict: "error", reason: controller.signal.aborted ? "timeout" : "network" }));
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** OpenAI's Moderation API on `input`: a flag when any result is flagged. */
export async function openaiModeration(fetcher: Fetch, apiKey: string | undefined, input: string, timeoutMs: number): Promise<CheckResult> {
  if (!apiKey) return { verdict: "error", reason: "no_key" };
  return withTimeout(timeoutMs, async (signal) => {
    const response = await fetcher(MODERATION_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: MODERATION_MODEL, input }),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { verdict: "error", reason: `http_${response.status}` };
    }
    const parsed = (await response.json().catch(() => undefined)) as { results?: unknown } | undefined;
    const results = Array.isArray(parsed?.results) ? parsed!.results : undefined;
    if (!results || results.length === 0 || !results.every((result) => isObject(result) && typeof result.flagged === "boolean")) return { verdict: "error", reason: "unparsable" };
    return results.some((result) => (result as { flagged: boolean }).flagged) ? { verdict: "flag" } : { verdict: "pass" };
  });
}

/** The safeguard's answer: "1" flags, "0" passes, anything else can't be read. */
export function safeguardVerdict(text: unknown): CheckResult {
  if (typeof text !== "string") return { verdict: "error", reason: "unparsable" };
  const match = /^\s*([01])[\s.]*$/.exec(text);
  if (!match) return { verdict: "error", reason: "unparsable" };
  return match[1] === "1" ? { verdict: "flag" } : { verdict: "pass" };
}

/** gpt-oss-safeguard-20b on OpenRouter, told `policy`, on `input`; with what the call cost. */
export async function safeguardCheck(
  fetcher: Fetch,
  input: { apiKey: string | undefined; policy: string; text: string; timeoutMs: number; user: string; dataCollection: string },
): Promise<{ result: CheckResult; spend: GuardSpend }> {
  const spend: GuardSpend = { tokens: 0, cashUsd: 0 };
  if (!input.apiKey) return { result: { verdict: "error", reason: "no_key" }, spend };
  const result = await withTimeout(input.timeoutMs, async (signal) => {
    const response = await fetcher(SAFEGUARD_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json", "http-referer": "https://directionallylocal.com", "x-title": "Directionally Local" },
      body: JSON.stringify({
        model: SAFEGUARD_MODEL,
        messages: [
          { role: "system", content: input.policy },
          { role: "user", content: input.text },
        ],
        reasoning: { effort: "low" },
        max_tokens: SAFEGUARD_MAX_TOKENS,
        temperature: 0,
        stream: false,
        usage: { include: true },
        provider: { data_collection: input.dataCollection },
        user: input.user,
      }),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { verdict: "error", reason: `http_${response.status}` };
    }
    const parsed = (await response.json().catch(() => undefined)) as { usage?: unknown; choices?: Array<{ message?: { content?: unknown } }> } | undefined;
    const usage = parseUsage(parsed?.usage);
    if (usage) {
      spend.tokens = usage.promptTokens + usage.completionTokens;
      spend.cashUsd = costOf(usage, 0);
    }
    return safeguardVerdict(parsed?.choices?.[0]?.message?.content);
  });
  return { result, spend };
}

/**
 * Both checks on a request's new content, at once. An empty new content (nothing but images, or
 * an assistant prefill) has nothing to check and passes without a call.
 */
export async function runGuard(
  fetcher: Fetch,
  input: { body: Json; openaiApiKey: string | undefined; openRouterApiKey: string | undefined; policy: string; timeoutMs: number; user: string; dataCollection: string },
): Promise<GuardResult> {
  const text = guardInput(input.body);
  if (!text.trim()) return { verdict: "pass", openai: { verdict: "pass" }, safeguard: { verdict: "pass" }, flaggedBy: [], reason: "empty", spend: { tokens: 0, cashUsd: 0 }, text };
  const [openai, safeguard] = await Promise.all([
    openaiModeration(fetcher, input.openaiApiKey, text, input.timeoutMs),
    safeguardCheck(fetcher, { apiKey: input.openRouterApiKey, policy: input.policy, text, timeoutMs: input.timeoutMs, user: input.user, dataCollection: input.dataCollection }),
  ]);
  const flaggedBy: Checker[] = [];
  if (openai.verdict === "flag") flaggedBy.push("openai");
  if (safeguard.result.verdict === "flag") flaggedBy.push("safeguard");
  const failed = [openai.verdict === "error" ? `openai:${openai.reason}` : undefined, safeguard.result.verdict === "error" ? `safeguard:${safeguard.result.reason}` : undefined].filter(Boolean) as string[];
  const verdict = flaggedBy.length > 0 ? "flag" : failed.length > 0 ? "error" : "pass";
  const reason = verdict === "flag" ? flaggedBy.map((checker) => `flagged:${checker}`).join(",") : verdict === "error" ? failed.join(",") : "ok";
  return { verdict, openai, safeguard: safeguard.result, flaggedBy, reason, spend: safeguard.spend, text };
}

/** The daily counters one result adds to: each checker that flagged, else "error" or "passed". */
export function outcomesOf(result: Pick<GuardResult, "verdict" | "flaggedBy">): GuardOutcome[] {
  if (result.verdict === "flag") return result.flaggedBy.map((checker) => (checker === "openai" ? "flagged_openai" : "flagged_safeguard"));
  return [result.verdict === "error" ? "error" : "passed"];
}
