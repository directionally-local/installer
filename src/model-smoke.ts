import { request as httpRequest } from "node:http";
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";
import type { ModelDeployment } from "./state.js";
import type { System } from "./system.js";

/** fetch's shape. A transport with `reportsSent` calls init.onSent once the request is sent. */
export type FetchModel = ((url: string, init?: RequestInit) => Promise<Response>) & { reportsSent?: boolean };

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
  /** `curl` reproduces the failing request, when there was one. */
  constructor(readonly check: SmokeCheck, readonly reason: string, readonly short: string = reason, readonly curl?: string) {
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
  /** Writes a line to the run log only (never the screen): every request the smoke test makes. */
  record?: (line: string) => void;
  /** For tests: how long a check may wait for its answer once sent (30 s), and for a connection (10 s). */
  answerMs?: number;
  connectMs?: number;
}

/** At most an hour of polls, however long the download keeps moving. */
const MAX_POLLS = 720;

/** How long a check waits for its answer, counted from when the request was sent. */
export const ANSWER_MS = 30_000;
/** How long a check waits to connect and send its request. */
export const CONNECT_MS = 10_000;

/**
 * The model's API base URL: the one source of truth for the readiness probe, every smoke check,
 * the bench and Autopilot's provider. An explicit IPv4 address, never "localhost": Node may
 * resolve that to ::1, while the container is published on 127.0.0.1 only.
 */
export function modelApiBase(deployment: { port: number; host?: string | undefined }): string {
  const host = deployment.host ?? "127.0.0.1";
  return `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${deployment.port}/v1`;
}

/** Fetch options a transport may honour: onSent fires once the whole request is on the wire. */
export interface ModelRequestInit extends RequestInit { onSent?: () => void }

/**
 * A fetch over node:http, one fresh connection per request (no pooled keep-alive sockets),
 * that says when the request was actually sent. `lookup` is for tests (a resolver that
 * prefers ::1); IP literals never use it.
 */
export function createLocalFetch(options: { lookup?: LookupFunction } = {}): FetchModel {
  const call = (url: string, init: ModelRequestInit = {}): Promise<Response> => {
    const target = new URL(url);
    if (target.protocol !== "http:") return fetch(url, init);
    return new Promise<Response>((resolve, reject) => {
      const signal = init.signal ?? undefined;
      const reason = () => (signal?.reason instanceof Error ? signal.reason : Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
      if (signal?.aborted) { reject(reason()); return; }
      const body = typeof init.body === "string" ? init.body : undefined;
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
      if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
      const req = httpRequest({ hostname: target.hostname.replace(/^\[|\]$/g, ""), port: target.port || 80, path: `${target.pathname}${target.search}`,
        method: init.method ?? "GET", headers, agent: false, ...(options.lookup ? { lookup: options.lookup } : {}) });
      const abort = () => req.destroy(reason());
      signal?.addEventListener("abort", abort, { once: true });
      req.on("finish", () => init.onSent?.());
      req.on("error", (error) => { signal?.removeEventListener("abort", abort); reject(error); });
      req.on("response", (res) => {
        res.on("close", () => signal?.removeEventListener("abort", abort));
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) for (const item of value) responseHeaders.append(key, item);
          else if (value !== undefined) responseHeaders.set(key, value);
        }
        const status = res.statusCode ?? 0;
        const empty = status === 204 || status === 304 || init.method === "HEAD";
        if (empty) res.resume();
        resolve(new Response(empty ? null : Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, statusText: res.statusMessage ?? "", headers: responseHeaders }));
      });
      req.end(body);
    });
  };
  return Object.assign(call, { reportsSent: true });
}

/** The default transport: node:http, so the answer budget starts when the request is sent. */
export const localFetch = createLocalFetch();

/** A connection error's code and message: "ECONNREFUSED connect ECONNREFUSED 127.0.0.1:8000". */
export function connectionError(error: unknown): string {
  const seen = new Set<unknown>();
  let current: unknown = error;
  let code: string | undefined;
  const messages: string[] = [];
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const item = current as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
    if (!code && typeof item.code === "string") code = item.code;
    if (typeof item.message === "string" && item.message && !messages.includes(item.message)) messages.push(item.message);
    current = item.cause ?? (Array.isArray(item.errors) ? item.errors[0] : undefined);
  }
  if (!messages.length) messages.push(String(error));
  const message = messages.at(-1)!;
  return code && !message.startsWith(code) ? `${code} ${message}` : message;
}

/** A single-line, copy-pasteable curl for a smoke request (same URL, headers and JSON body). */
export function curlLine(method: string, url: string, body?: Record<string, unknown>, maxSeconds = ANSWER_MS / 1000): string {
  const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
  const parts = ["curl", "-sS", "--max-time", String(maxSeconds)];
  if (method !== "GET") parts.push("-X", method);
  parts.push(quote(url));
  if (body) parts.push("-H", quote("content-type: application/json"), "-d", quote(JSON.stringify(body)));
  return parts.join(" ");
}

class Timeout extends Error {
  constructor(readonly phase: "connect" | "answer") { super(phase === "connect" ? "connect timeout" : "answer timeout"); this.name = "TimeoutError"; }
}

/** Check the actual OpenAI-compatible API rather than trusting a healthy container alone. */
export async function smokeTest(deployment: Pick<ModelDeployment, "repo" | "port" | "container" | "host">, _system: System, call: FetchModel = localFetch, options: SmokeOptions = {}): Promise<ModelDeployment["lastTest"]> {
  const base = modelApiBase(deployment);
  const url = `${base}/chat/completions`;
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const report = options.onCheck ?? (() => {});
  const record = options.record ?? (() => {});
  const attempts = options.attempts ?? 60;
  const answerMs = options.answerMs ?? ANSWER_MS;
  const connectMs = options.connectMs ?? CONNECT_MS;
  const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;

  /**
   * One request, logged: method, URL, start, duration, then the HTTP status or the error.
   * With a transport that reports sending (the default), the answer budget starts once the
   * request is on the wire; until then only the connect budget runs, and running out of it is a
   * connection error, never "no answer". The budget also covers reading the answer.
   */
  const send = async (check: SmokeCheck, method: "GET" | "POST", target: string, body: Record<string, unknown> | undefined, budget: number) => {
    const controller = new AbortController();
    const startedAt = new Date();
    const started = performance.now();
    let sentAt: number | undefined;
    const reportsSent = (call as { reportsSent?: boolean }).reportsSent === true;
    let timer = setTimeout(() => controller.abort(new Timeout(reportsSent ? "connect" : "answer")), reportsSent ? connectMs : budget);
    const onSent = () => {
      if (sentAt !== undefined) return;
      sentAt = performance.now();
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Timeout("answer")), budget);
    };
    const curl = curlLine(method, target, body, Math.max(1, Math.ceil(budget / 1000)));
    const head = `smoke ${check} ${method} ${target} started ${startedAt.toISOString()}`;
    const elapsed = () => `${Math.round(performance.now() - started)} ms`;
    const sentText = () => (reportsSent ? (sentAt === undefined ? ", never sent" : `, sent after ${Math.round(sentAt - started)} ms`) : "");
    /** Why it failed, from what aborted it or what the transport threw. */
    const failure = (error: unknown, during: "request" | "answer"): SmokeError => {
      clearTimeout(timer);
      const why = controller.signal.aborted ? controller.signal.reason : error;
      let reason: string;
      let short: string;
      if (why instanceof Timeout && why.phase === "answer") {
        reason = `no answer in ${seconds(budget)}`;
        short = reason;
      } else if (why instanceof Timeout) {
        reason = `could not connect to ${target} in ${seconds(connectMs)}`;
        short = "could not connect";
      } else if (during === "request" && (sentAt === undefined || !reportsSent)) {
        const detail = connectionError(error);
        reason = `could not reach ${target} (${detail})`;
        short = `connection failed${/^E[A-Z]+/.test(detail) ? ` (${detail.split(" ")[0]})` : ""}`;
      } else {
        const detail = connectionError(error);
        reason = `the connection dropped before the answer finished (${detail})`;
        short = "connection dropped";
      }
      record(`${head}: FAILED after ${elapsed()}${sentText()}: ${reason}${why instanceof Timeout ? "" : ` [${connectionError(error)}]`}`);
      return new SmokeError(check, reason, short, curl);
    };
    let response: Response;
    try {
      const init: ModelRequestInit = { method, signal: controller.signal, onSent,
        ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) };
      response = await call(target, init);
    } catch (error) {
      throw failure(error, "request");
    }
    if (!response.ok) {
      const text = (await response.text().catch(() => "")).replace(/\s+/g, " ").trim();
      clearTimeout(timer);
      record(`${head}: HTTP ${response.status} after ${elapsed()}${sentText()}: ${text.slice(0, 300) || "(empty body)"}`);
      const excerpt = text.slice(0, 120);
      throw new SmokeError(check, `the server answered HTTP ${response.status}${excerpt ? ` (${excerpt})` : ""}`, `HTTP ${response.status}`, curl);
    }
    return {
      response,
      curl,
      /** The answer arrived: log it and stop the clock. */
      done: (note = "") => { clearTimeout(timer); record(`${head}: HTTP ${response.status} after ${elapsed()}${sentText()}${note}`); },
      failure: (error: unknown) => failure(error, "answer"),
      /** Fail with a reason about the answer itself (not the transport), logged and with the curl. */
      invalid: (reason: string, short: string, excerpt = "") => {
        clearTimeout(timer);
        record(`${head}: HTTP ${response.status} after ${elapsed()}${sentText()}, but ${reason}${excerpt ? `: ${excerpt.replace(/\s+/g, " ").slice(0, 300)}` : ""}`);
        return new SmokeError(check, reason, short, curl);
      },
    };
  };

  const chatBody = (body: Record<string, unknown>) => ({ model: deployment.repo, ...NO_THINKING, ...body });
  const complete = async (check: SmokeCheck, body: Record<string, unknown>) => {
    const sent = await send(check, "POST", url, chatBody({ max_tokens: 256, ...body }), answerMs);
    let text: string;
    try { text = await sent.response.text(); } catch (error) { throw sent.failure(error); }
    let parsed: Completion;
    try { parsed = JSON.parse(text) as Completion; } catch { throw sent.invalid("the server's answer wasn't JSON", "not JSON", text); }
    sent.done();
    return { completion: parsed, sent, text };
  };

  // 1. The API answers: vLLM serves /v1/models only once the model is loaded.
  report("ready", "start");
  for (let idle = 0, polls = 0; ; polls++) {
    const moved = await options.waiting?.().catch(() => false);
    if (!moved) idle++;
    let lastError: SmokeError | undefined;
    try {
      const probe = await send("ready", "GET", `${base}/models`, undefined, 10_000);
      // Read the answer so the connection is done with before the checks start.
      await probe.response.arrayBuffer().catch(() => undefined);
      probe.done();
      break;
    } catch (error) { lastError = error instanceof SmokeError ? error : undefined; /* not listening yet */ }
    if (options.running && !(await options.running().catch(() => true))) throw new SmokeError("ready", "vLLM stopped while loading the model", "vLLM stopped", lastError?.curl);
    if (idle >= attempts || polls >= MAX_POLLS) {
      const minutes = Math.max(1, Math.round(attempts * 5 / 60));
      throw new SmokeError("ready", `vLLM wasn't ready after ${minutes} minute${minutes === 1 ? "" : "s"} without progress`, "not ready in time", lastError?.curl ?? curlLine("GET", `${base}/models`, undefined, 10));
    }
    await delay(5000);
  }
  report("ready", "done");

  // 2. Chat: a short answer, judged on its text (thinking doesn't count).
  report("chat", "start");
  const chat = await complete("chat", { messages: [{ role: "user", content: "Reply with one short sentence." }] });
  const chatChoice = chat.completion.choices?.[0];
  if (!answerText(chatChoice?.message?.content)) {
    const why = noTextReason(chatChoice?.message, chatChoice?.finish_reason);
    record(`smoke chat answer: ${chat.text.replace(/\s+/g, " ").slice(0, 300)}`);
    throw new SmokeError("chat", why.reason, why.short, chat.sent.curl);
  }
  report("chat", "done");

  // 3. Speed: decode-only throughput. Stream the reply and divide completion tokens by
  // (last token time - first token time), excluding time to first token.
  report("speed", "start");
  const stream = await send("speed", "POST", url, chatBody({ messages: [{ role: "user", content: "Count from 1 to 200, separated by spaces." }], max_tokens: 512, stream: true, stream_options: { include_usage: true } }), answerMs);
  if (!stream.response.body) throw stream.invalid("the stream had no body", "no stream");
  const reader = stream.response.body.getReader();
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
    try { chunk = await reader.read(); } catch (error) {
      const failed = stream.failure(error);
      throw new SmokeError("speed", `the stream stopped before the end (${failed.reason})`, "stream stopped", failed.curl);
    }
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
    throw stream.invalid(why.reason, why.short, reasoning || content);
  }
  stream.done(`, ${completionTokens} tokens streamed`);
  const decodeSeconds = firstTokenAt !== undefined && lastTokenAt !== undefined ? (lastTokenAt - firstTokenAt) / 1000 : 0;
  // Short replies arrive in a single chunk, collapsing the decode window to milliseconds and
  // inflating tok/s by orders of magnitude; a 50 ms floor keeps the figure honest-ish.
  const tokensPerSecond = Math.round(completionTokens / Math.max(decodeSeconds, 0.05) * 10) / 10;
  report("speed", "done", `${tokensPerSecond} tokens/sec`);

  // 4. A forced tool call with the right argument.
  report("tools", "start");
  const tool = await complete("tools", { messages: [{ role: "user", content: "Call ping with value 1." }],
    tools: [{ type: "function", function: { name: "ping", description: "Check a value", parameters: { type: "object", properties: { value: { type: "integer" } }, required: ["value"] } } }], tool_choice: { type: "function", function: { name: "ping" } } });
  const calls = tool.completion.choices?.[0]?.message?.tool_calls as Array<{ function?: { name?: string; arguments?: string } }> | undefined;
  let value: unknown;
  try { value = JSON.parse(calls?.[0]?.function?.arguments ?? "null")?.value; } catch { value = undefined; }
  if (calls?.[0]?.function?.name !== "ping" || value !== 1) {
    record(`smoke tools answer: ${tool.text.replace(/\s+/g, " ").slice(0, 300)}`);
    throw new SmokeError("tools", "the model didn't call ping with value 1", "no ping(1) call", tool.sent.curl);
  }
  report("tools", "done");

  // 5. JSON mode.
  report("json", "start");
  const json = await complete("json", { messages: [{ role: "user", content: "Return JSON with ok true." }], response_format: { type: "json_object" } });
  let ok = false;
  try { ok = JSON.parse(answerText(json.completion.choices?.[0]?.message?.content) || "null")?.ok === true; } catch { ok = false; }
  if (!ok) {
    record(`smoke json answer: ${json.text.replace(/\s+/g, " ").slice(0, 300)}`);
    throw new SmokeError("json", "the model didn't return JSON with ok true", "not {ok: true}", json.sent.curl);
  }
  report("json", "done");

  return { chat: true, tools: true, json: true, tokensPerSecond, at: new Date().toISOString() };
}
