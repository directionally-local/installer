import type { ModelDeployment } from "./state.js";
import type { System } from "./system.js";

export type FetchModel = (url: string, init?: RequestInit) => Promise<Response>;

/** The smoke test's steps, in order: the API answering, then each check. */
export type SmokeCheck = "ready" | "chat" | "speed" | "tools" | "json";

/** How each step is named on screen and in a failure ("Chat test: ..."). */
export const SMOKE_LABELS: Record<SmokeCheck, string> = {
  ready: "Startup",
  chat: "Chat test",
  speed: "Speed test",
  tools: "Tool call test",
  json: "JSON test",
};

/**
 * A smoke step that failed: which one, why in a few words (for the checklist), and why in a
 * sentence (for the message). Server logs never go in the message: they go to the run log.
 */
export class SmokeError extends Error {
  constructor(readonly check: SmokeCheck, readonly reason: string, readonly short: string = reason) {
    super(`${SMOKE_LABELS[check]}: ${reason}`);
    this.name = "SmokeError";
  }
}

/**
 * Thinking models (Qwen3, GLM) spend their reply on reasoning unless told not to; every check
 * turns thinking off so the answer is judged, not the thinking.
 */
export const NO_THINKING = { chat_template_kwargs: { enable_thinking: false } } as const;

interface Message { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: unknown[] }
interface Completion { choices?: Array<{ message?: Message; finish_reason?: string | null }>; usage?: { completion_tokens?: number } }

/** The visible answer: content without any <think>…</think> block (or an unclosed one). */
export function answerText(content: string | null | undefined): string {
  return String(content ?? "").replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
}

/** Whether a reply carried reasoning: a reasoning field, or a <think> block in the content. */
export function hasReasoning(message: Message | undefined): boolean {
  return !!(message?.reasoning_content?.trim() || message?.reasoning?.trim() || /<think>/.test(message?.content ?? ""));
}

/** Why a reply with no answer text had none, in a sentence and in a few words. */
export function noTextReason(message: Message | undefined, finishReason: string | null | undefined): { reason: string; short: string } {
  if (hasReasoning(message)) {
    return finishReason === "length"
      ? { reason: "the model returned no text, thinking mode used all tokens", short: "only thinking, out of tokens" }
      : { reason: "the model returned only thinking, no answer", short: "only thinking, no answer" };
  }
  return { reason: "the model returned no text", short: "no text" };
}

export interface SmokeOptions {
  /** Readiness polls without progress before giving up (5 s apart): 60 is 5 minutes. */
  attempts?: number;
  delay?: (ms: number) => Promise<void>;
  /** Called before each readiness poll; true when the download moved on (the wait doesn't count then). */
  waiting?: () => Promise<boolean>;
  /** Whether the server is still up; a stopped one fails at once instead of waiting it out. */
  running?: () => Promise<boolean>;
  /** Each step as it starts and passes. */
  onCheck?: (check: SmokeCheck, status: "start" | "done", detail?: string) => void;
}

/** At most an hour of polls, however long the download keeps moving. */
const MAX_POLLS = 720;

/** Check the actual OpenAI-compatible API rather than trusting a healthy container alone. */
export async function smokeTest(deployment: Pick<ModelDeployment, "repo" | "port" | "container">, _system: System, call: FetchModel = fetch, options: SmokeOptions = {}): Promise<ModelDeployment["lastTest"]> {
  const base = `http://127.0.0.1:${deployment.port}/v1`;
  const url = `${base}/chat/completions`;
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const report = options.onCheck ?? (() => {});
  const attempts = options.attempts ?? 60;

  const post = async (check: SmokeCheck, body: Record<string, unknown>): Promise<Response> => {
    let response: Response;
    try {
      response = await call(url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: deployment.repo, ...NO_THINKING, ...body }), signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new SmokeError(check, timedOut ? "no answer in 30 s" : `the request failed (${error instanceof Error ? error.message : String(error)})`, timedOut ? "no answer in 30 s" : "request failed");
    }
    if (!response.ok) {
      const text = (await response.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 120);
      throw new SmokeError(check, `the server answered HTTP ${response.status}${text ? ` (${text})` : ""}`, `HTTP ${response.status}`);
    }
    return response;
  };
  const complete = async (check: SmokeCheck, body: Record<string, unknown>): Promise<Completion> => {
    const response = await post(check, { max_tokens: 256, ...body });
    try {
      return await response.json() as Completion;
    } catch {
      throw new SmokeError(check, "the server's answer wasn't JSON", "not JSON");
    }
  };

  // 1. The API answers: vLLM serves /v1/models only once the model is loaded.
  report("ready", "start");
  for (let idle = 0, polls = 0; ; polls++) {
    const moved = await options.waiting?.().catch(() => false);
    if (!moved) idle++;
    try {
      const response = await call(`${base}/models`, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) break;
    } catch { /* not listening yet */ }
    if (options.running && !(await options.running().catch(() => true))) throw new SmokeError("ready", "vLLM stopped while loading the model", "vLLM stopped");
    if (idle >= attempts || polls >= MAX_POLLS) {
      const minutes = Math.max(1, Math.round(attempts * 5 / 60));
      throw new SmokeError("ready", `vLLM wasn't ready after ${minutes} minute${minutes === 1 ? "" : "s"} without progress`, "not ready in time");
    }
    await delay(5000);
  }
  report("ready", "done");

  // 2. Chat: a short answer, judged on its text (thinking doesn't count).
  report("chat", "start");
  const chat = await complete("chat", { messages: [{ role: "user", content: "Reply with one short sentence." }] });
  const chatChoice = chat.choices?.[0];
  if (!answerText(chatChoice?.message?.content)) {
    const why = noTextReason(chatChoice?.message, chatChoice?.finish_reason);
    throw new SmokeError("chat", why.reason, why.short);
  }
  report("chat", "done");

  // 3. Speed: decode-only throughput. Stream the reply and divide completion tokens by
  // (last token time - first token time), excluding time to first token.
  report("speed", "start");
  const response = await post("speed", { messages: [{ role: "user", content: "Count from 1 to 200, separated by spaces." }], max_tokens: 512, stream: true, stream_options: { include_usage: true } });
  if (!response.body) throw new SmokeError("speed", "the stream had no body", "no stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let finish: string | null = null;
  let completionTokens = 0;
  let firstTokenAt: number | undefined;
  let lastTokenAt: number | undefined;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try { chunk = await reader.read(); } catch { throw new SmokeError("speed", "the stream stopped before the end (no answer in 30 s)", "stream stopped"); }
    const { done, value } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) {
      const line = event.split("\n").find((part) => part.startsWith("data:"));
      if (!line) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let parsed: { choices?: Array<{ delta?: Message; finish_reason?: string | null }>; usage?: { completion_tokens?: number } };
      try { parsed = JSON.parse(data); } catch { continue; }
      const choice = parsed.choices?.[0];
      const delta = choice?.delta;
      const thought = (delta?.reasoning_content ?? "") + (delta?.reasoning ?? "");
      if (thought + (delta?.content ?? "")) {
        const now = performance.now();
        if (firstTokenAt === undefined) firstTokenAt = now;
        lastTokenAt = now;
        content += delta?.content ?? "";
        reasoning += thought;
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (parsed.usage?.completion_tokens) completionTokens = parsed.usage.completion_tokens;
    }
  }
  if (!answerText(content)) {
    const why = noTextReason({ content, reasoning_content: reasoning }, finish);
    throw new SmokeError("speed", why.reason, why.short);
  }
  const decodeSeconds = firstTokenAt !== undefined && lastTokenAt !== undefined ? (lastTokenAt - firstTokenAt) / 1000 : 0;
  // Short replies arrive in a single chunk, collapsing the decode window to milliseconds and
  // inflating tok/s by orders of magnitude; a 50 ms floor keeps the figure honest-ish.
  const tokensPerSecond = Math.round(completionTokens / Math.max(decodeSeconds, 0.05) * 10) / 10;
  report("speed", "done", `${tokensPerSecond} tokens/sec`);

  // 4. A forced tool call with the right argument.
  report("tools", "start");
  const tool = await complete("tools", { messages: [{ role: "user", content: "Call ping with value 1." }],
    tools: [{ type: "function", function: { name: "ping", description: "Check a value", parameters: { type: "object", properties: { value: { type: "integer" } }, required: ["value"] } } }], tool_choice: { type: "function", function: { name: "ping" } } });
  const calls = tool.choices?.[0]?.message?.tool_calls as Array<{ function?: { name?: string; arguments?: string } }> | undefined;
  let value: unknown;
  try { value = JSON.parse(calls?.[0]?.function?.arguments ?? "null")?.value; } catch { value = undefined; }
  if (calls?.[0]?.function?.name !== "ping" || value !== 1) throw new SmokeError("tools", "the model didn't call ping with value 1", "no ping(1) call");
  report("tools", "done");

  // 5. JSON mode.
  report("json", "start");
  const json = await complete("json", { messages: [{ role: "user", content: "Return JSON with ok true." }], response_format: { type: "json_object" } });
  let ok = false;
  try { ok = JSON.parse(answerText(json.choices?.[0]?.message?.content) || "null")?.ok === true; } catch { ok = false; }
  if (!ok) throw new SmokeError("json", "the model didn't return JSON with ok true", "not {ok: true}");
  report("json", "done");

  return { chat: true, tools: true, json: true, tokensPerSecond, at: new Date().toISOString() };
}
