/**
 * Anthropic Messages ⇄ Chat Completions, for Claude Code launched by `dl claude`.
 *
 * Claude Code speaks the Anthropic Messages API to whatever `ANTHROPIC_BASE_URL` names; dl points
 * it at `<service>/anthropic`, so it posts to `/anthropic/v1/messages` (with `?beta=true`) and,
 * optionally, `/anthropic/v1/messages/count_tokens`. The request is translated into the chat
 * completions body the rest of the service already serves (reservation, routing, settlement and
 * every refusal stay in app.ts `chat`), always for the DeepSeek model, and the answer (a JSON
 * body or a server-sent-event stream) is translated back into an Anthropic `message` or its
 * event sequence.
 *
 * Supported: `system` (a string or text blocks), `messages` with text, image (dropped with a
 * note when the model can't read images), tool_use, tool_result (string or nested blocks,
 * `is_error`), thinking blocks (passed back as `reasoning_content`); `tools` with
 * `input_schema` (custom tools only: server tools such as web search are dropped), `tool_choice`
 * (auto, any, tool, none, `disable_parallel_tool_use`), `max_tokens`, `temperature`, `top_p`,
 * `stop_sequences`, `stream`. Ignored: `metadata`, `top_k`, `cache_control`, `container`,
 * `mcp_servers`, `service_tier` and `thinking` (the model reasons on its own; its reasoning comes
 * back as thinking blocks only when the request asked for thinking).
 *
 * Nothing here keeps content: it only reshapes what passes through.
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** What replaces an image the serving model can't read. */
export const IMAGE_OMITTED = "[An image was attached here, but the free tier's model can't read images, so it was left out.]";
/** What replaces a document block (PDFs and the like). */
export const DOCUMENT_OMITTED = "[A document was attached here, but the free tier's model can't read documents, so it was left out.]";
/** The signature on thinking blocks the service makes: Claude Code sends it back unchanged, and nothing checks it. */
export const THINKING_SIGNATURE = "dl";

export interface AnthropicRequestOptions {
  /** The free tier model id that serves (DeepSeek). */
  model: string;
  /** Whether that model reads images. */
  vision: boolean;
}

export type Translated = { ok: true; body: Json; thinking: boolean; stream: boolean; model: string } | { ok: false; message: string };

/** An Anthropic Messages request body → a chat completions body for `options.model`. */
export function toChatRequest(input: Json, options: AnthropicRequestOptions): Translated {
  if (!Array.isArray(input.messages) || input.messages.length === 0) return { ok: false, message: "messages: send at least one message." };
  const messages: Json[] = [];
  const system = systemText(input.system);
  if (system) messages.push({ role: "system", content: system });
  for (const message of input.messages) {
    if (!isObject(message)) return { ok: false, message: "messages: each message must be an object." };
    const role = str(message.role);
    if (role === "user") messages.push(...userMessages(message.content, options));
    else if (role === "assistant") {
      const assistant = assistantMessage(message.content);
      if (assistant) messages.push(assistant);
    } else if (role === "system") {
      // Claude Code can put system text inside messages too (not only in `system`): keep it as a system message.
      const text = systemText(message.content);
      if (text) messages.push({ role: "system", content: text });
    } else return { ok: false, message: `messages: role must be "user", "assistant" or "system" (got ${JSON.stringify(role ?? null)}).` };
  }
  const stream = input.stream === true;
  const body: Json = { model: options.model, messages, stream };
  if (typeof input.max_tokens === "number" && Number.isFinite(input.max_tokens) && input.max_tokens > 0) body.max_tokens = Math.floor(input.max_tokens);
  if (typeof input.temperature === "number" && Number.isFinite(input.temperature)) body.temperature = input.temperature;
  if (typeof input.top_p === "number" && Number.isFinite(input.top_p)) body.top_p = input.top_p;
  const stops = Array.isArray(input.stop_sequences) ? input.stop_sequences.filter((stop): stop is string => typeof stop === "string" && stop.length > 0).slice(0, 16) : [];
  if (stops.length > 0) body.stop = stops;
  const tools = chatTools(input.tools);
  if (tools.length > 0) {
    body.tools = tools;
    const choice = toolChoice(input.tool_choice);
    if (choice !== undefined) body.tool_choice = choice;
    if (isObject(input.tool_choice) && input.tool_choice.disable_parallel_tool_use === true) body.parallel_tool_calls = false;
  }
  const thinking = isObject(input.thinking) && (input.thinking.type === "enabled" || input.thinking.type === "adaptive");
  return { ok: true, body, thinking, stream, model: str(input.model) ?? options.model };
}

function systemText(system: unknown): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .filter(isObject)
    .map((block) => (block.type === "text" ? (str(block.text) ?? "") : ""))
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/** A block's text for a tool result or a note: text as is, images and documents as notes. */
function blockText(block: unknown, options: AnthropicRequestOptions): string {
  if (typeof block === "string") return block;
  if (!isObject(block)) return "";
  if (block.type === "text") return str(block.text) ?? "";
  if (block.type === "image") return options.vision ? "" : IMAGE_OMITTED;
  if (block.type === "document") return DOCUMENT_OMITTED;
  return "";
}

/**
 * One Anthropic user message → chat messages: each tool_result becomes a `tool` message (they
 * come first, right after the assistant's tool calls), then the rest as one user message.
 */
function userMessages(content: unknown, options: AnthropicRequestOptions): Json[] {
  if (typeof content === "string") return [{ role: "user", content }];
  if (!Array.isArray(content)) return [];
  const out: Json[] = [];
  const parts: Json[] = [];
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === "tool_result") {
      const nested = typeof block.content === "string" ? block.content : Array.isArray(block.content) ? block.content.map((part) => blockText(part, options)).filter(Boolean).join("\n") : "";
      const text = block.is_error === true ? `Error: ${nested || "the tool failed."}` : nested;
      out.push({ role: "tool", tool_call_id: str(block.tool_use_id) ?? "", content: text });
    } else if (block.type === "text") {
      const text = str(block.text) ?? "";
      if (text) parts.push({ type: "text", text });
    } else if (block.type === "image") {
      const source = isObject(block.source) ? block.source : undefined;
      const url =
        source?.type === "base64" && typeof source.media_type === "string" && typeof source.data === "string"
          ? `data:${source.media_type};base64,${source.data}`
          : source?.type === "url"
            ? str(source.url)
            : undefined;
      if (options.vision && url) parts.push({ type: "image_url", image_url: { url } });
      else parts.push({ type: "text", text: IMAGE_OMITTED });
    } else if (block.type === "document") {
      parts.push({ type: "text", text: DOCUMENT_OMITTED });
    }
  }
  if (parts.length > 0) out.push({ role: "user", content: parts.every((part) => part.type === "text") ? parts.map((part) => part.text).join("\n\n") : parts });
  return out;
}

/** One Anthropic assistant message → one chat assistant message (text, tool calls, reasoning). */
function assistantMessage(content: unknown): Json | undefined {
  if (typeof content === "string") return content ? { role: "assistant", content } : undefined;
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  const reasoning: string[] = [];
  const calls: Json[] = [];
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === "text" && typeof block.text === "string" && block.text) texts.push(block.text);
    else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) reasoning.push(block.thinking);
    else if (block.type === "tool_use") {
      calls.push({ id: str(block.id) ?? "", type: "function", function: { name: str(block.name) ?? "", arguments: JSON.stringify(isObject(block.input) ? block.input : {}) } });
    }
  }
  if (texts.length === 0 && calls.length === 0) return undefined;
  return {
    role: "assistant",
    content: texts.length > 0 ? texts.join("\n\n") : null,
    ...(calls.length > 0 ? { tool_calls: calls } : {}),
    ...(reasoning.length > 0 ? { reasoning_content: reasoning.join("\n\n") } : {}),
  };
}

/** Custom tools only: a server tool (one with a `type` other than "custom") has no function form. */
function chatTools(tools: unknown): Json[] {
  if (!Array.isArray(tools)) return [];
  const out: Json[] = [];
  for (const tool of tools) {
    if (!isObject(tool) || typeof tool.name !== "string") continue;
    if (tool.type !== undefined && tool.type !== "custom") continue;
    out.push({
      type: "function",
      function: { name: tool.name, ...(typeof tool.description === "string" ? { description: tool.description } : {}), parameters: isObject(tool.input_schema) ? tool.input_schema : { type: "object", properties: {} } },
    });
  }
  return out;
}

function toolChoice(choice: unknown): unknown {
  if (!isObject(choice)) return undefined;
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  if (choice.type === "tool" && typeof choice.name === "string") return { type: "function", function: { name: choice.name } };
  return undefined;
}

// ─── Answers ────────────────────────────────────────────────────────────────

export type StopReason = "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "refusal";

/**
 * A chat finish reason → Anthropic's stop reason. `matched` is the stop string the server says
 * ended the text (vLLM-style servers put it in the choice's `stop_reason`), when it is one of
 * the request's stop sequences.
 */
export function stopReasonOf(finish: unknown, toolCalls: boolean, matched?: string): StopReason {
  if (finish === "tool_calls" || finish === "function_call" || (toolCalls && finish !== "length")) return "tool_use";
  if (finish === "length") return "max_tokens";
  if (finish === "content_filter") return "refusal";
  if (matched !== undefined) return "stop_sequence";
  return "end_turn";
}

/** The stop sequence that ended the text, when the server said which and the request had it. */
function matchedStop(choice: Json | undefined, stops: readonly string[]): string | undefined {
  const said = str(choice?.stop_reason) ?? str(choice?.matched_stop);
  return said !== undefined && stops.includes(said) ? said : undefined;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** Chat usage → Anthropic's: input_tokens is the uncached part, cache reads apart (as Anthropic counts them). */
export function anthropicUsage(usage: unknown): AnthropicUsage {
  const u = isObject(usage) ? usage : {};
  const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
  const prompt = n(u.prompt_tokens);
  const cached = Math.min(prompt, n(isObject(u.prompt_tokens_details) ? u.prompt_tokens_details.cached_tokens : undefined));
  return { input_tokens: prompt - cached, output_tokens: n(u.completion_tokens), cache_read_input_tokens: cached, cache_creation_input_tokens: 0 };
}

export function messageId(): string {
  return `msg_${[...crypto.getRandomValues(new Uint8Array(12))].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export interface AnswerOptions {
  /** The free tier model id that answered (DeepSeek), whatever claude-* name the request asked for. */
  model: string;
  /** Whether the request asked for thinking: reasoning comes back as thinking blocks only then. */
  thinking: boolean;
  stopSequences: readonly string[];
}

/** A chat completion → an Anthropic `message`. */
export function toAnthropicMessage(completion: Json, options: AnswerOptions): Json {
  const choice = Array.isArray(completion.choices) && isObject(completion.choices[0]) ? completion.choices[0] : undefined;
  const message = isObject(choice?.message) ? choice.message : {};
  const content: Json[] = [];
  const reasoning = str(message.reasoning_content) ?? str(message.reasoning);
  if (options.thinking && reasoning) content.push({ type: "thinking", thinking: reasoning, signature: THINKING_SIGNATURE });
  const text = str(message.content);
  if (text) content.push({ type: "text", text });
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls.filter(isObject) : [];
  for (const call of calls) {
    const fn = isObject(call.function) ? call.function : {};
    content.push({ type: "tool_use", id: str(call.id) || toolId(), name: str(fn.name) ?? "", input: parseArguments(fn.arguments) });
  }
  const matched = matchedStop(choice, options.stopSequences);
  return {
    id: messageId(),
    type: "message",
    role: "assistant",
    model: options.model,
    content,
    stop_reason: stopReasonOf(choice?.finish_reason, calls.length > 0, matched),
    stop_sequence: matched ?? null,
    usage: anthropicUsage(completion.usage),
  };
}

function toolId(): string {
  return `toolu_${[...crypto.getRandomValues(new Uint8Array(12))].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Tool arguments as an object: `{}` for empty or unparsable ones (the model's mistake, shown to it as a tool error). */
function parseArguments(raw: unknown): Json {
  if (isObject(raw)) return raw;
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function event(name: string, data: Json): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * A chat completions event stream → Anthropic's: `message_start`, `ping`, then per content block
 * `content_block_start`, its deltas (`thinking_delta`, `text_delta`, `input_json_delta`) and
 * `content_block_stop`, then `message_delta` (stop reason and usage) and `message_stop`. A tool
 * call's arguments stream as they come, split across chunks however the upstream split them.
 * Tool calls are expected in order, as every OpenAI-compatible server sends them; a stream that
 * fails part way ends with an `error` event instead of `message_stop`.
 */
export function toAnthropicStream(upstream: ReadableStream<Uint8Array>, options: AnswerOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let started = false;
  let finished = false;
  let index = -1;
  let open: { kind: "text" | "thinking" | "tool"; tool?: number } | undefined;
  const toolBlocks = new Map<number, number>();
  let sawTool = false;
  let finish: unknown;
  let matched: string | undefined;
  let usage: AnthropicUsage | undefined;
  let failure: string | undefined;
  const id = messageId();

  const start = (out: string[]) => {
    if (started) return;
    started = true;
    out.push(
      event("message_start", {
        type: "message_start",
        message: { id, type: "message", role: "assistant", model: options.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      }),
      event("ping", { type: "ping" }),
    );
  };
  const close = (out: string[]) => {
    if (!open) return;
    if (open.kind === "thinking") out.push(event("content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: THINKING_SIGNATURE } }));
    out.push(event("content_block_stop", { type: "content_block_stop", index }));
    open = undefined;
  };
  const begin = (out: string[], kind: "text" | "thinking" | "tool", block: Json, tool?: number) => {
    close(out);
    index += 1;
    open = { kind, ...(tool !== undefined ? { tool } : {}) };
    out.push(event("content_block_start", { type: "content_block_start", index, content_block: block }));
  };
  const delta = (out: string[], payload: Json) => out.push(event("content_block_delta", { type: "content_block_delta", index, delta: payload }));

  const handle = (chunk: Json, out: string[]) => {
    if (isObject(chunk.error)) {
      failure = str(chunk.error.message) ?? "The model provider failed the request.";
      return;
    }
    if (chunk.usage) usage = anthropicUsage(chunk.usage);
    const choice = Array.isArray(chunk.choices) && isObject(chunk.choices[0]) ? chunk.choices[0] : undefined;
    if (!choice) return;
    start(out);
    const d = isObject(choice.delta) ? choice.delta : {};
    const reasoning = str(d.reasoning_content) ?? str(d.reasoning);
    if (options.thinking && reasoning) {
      if (open?.kind !== "thinking") begin(out, "thinking", { type: "thinking", thinking: "", signature: "" });
      delta(out, { type: "thinking_delta", thinking: reasoning });
    }
    const text = str(d.content);
    if (text) {
      if (open?.kind !== "text") begin(out, "text", { type: "text", text: "" });
      delta(out, { type: "text_delta", text });
    }
    if (Array.isArray(d.tool_calls)) {
      for (const call of d.tool_calls) {
        if (!isObject(call)) continue;
        const position = typeof call.index === "number" ? call.index : 0;
        const fn = isObject(call.function) ? call.function : {};
        if (!toolBlocks.has(position)) {
          sawTool = true;
          begin(out, "tool", { type: "tool_use", id: str(call.id) || toolId(), name: str(fn.name) ?? "", input: {} }, position);
          toolBlocks.set(position, index);
        } else if (open?.kind !== "tool" || open.tool !== position) {
          // Out of order: an earlier call's block is closed. Never seen from real servers.
          continue;
        }
        const args = str(fn.arguments);
        if (args) delta(out, { type: "input_json_delta", partial_json: args });
      }
    }
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      finish = choice.finish_reason;
      matched = matchedStop(choice, options.stopSequences);
    }
  };

  const scan = (final: boolean): string[] => {
    const out: string[] = [];
    const lines = buffer.split("\n");
    buffer = final ? "" : (lines.pop() ?? "");
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === "[DONE]") {
        finished = true;
        continue;
      }
      try {
        const parsed = JSON.parse(data) as unknown;
        if (isObject(parsed)) handle(parsed, out);
      } catch {
        // A partial or non-JSON line carries nothing.
      }
    }
    return out;
  };

  const end = (): string[] => {
    const out: string[] = [];
    if (failure !== undefined || (!finished && finish === undefined)) {
      start(out);
      close(out);
      out.push(event("error", { type: "error", error: { type: "api_error", message: failure ?? "The model provider's answer ended early. Try again." } }));
      return out;
    }
    start(out);
    close(out);
    const final = usage ?? anthropicUsage(undefined);
    out.push(
      event("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReasonOf(finish, sawTool, matched), stop_sequence: matched ?? null },
        usage: { input_tokens: final.input_tokens, output_tokens: final.output_tokens, cache_read_input_tokens: final.cache_read_input_tokens, cache_creation_input_tokens: 0 },
      }),
      event("message_stop", { type: "message_stop" }),
    );
    return out;
  };

  const reader = upstream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } catch {
          failure ??= "The model provider's answer was cut off. Try again.";
          buffer += decoder.decode();
          const out = [...scan(true), ...end()];
          controller.enqueue(encoder.encode(out.join("")));
          controller.close();
          return;
        }
        if (result.done) {
          buffer += decoder.decode();
          const out = [...scan(true), ...end()];
          controller.enqueue(encoder.encode(out.join("")));
          controller.close();
          return;
        }
        buffer += decoder.decode(result.value, { stream: true });
        const out = scan(false);
        if (out.length > 0) {
          controller.enqueue(encoder.encode(out.join("")));
          return;
        }
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

// ─── Errors and token counts ────────────────────────────────────────────────

/** Anthropic's error type for an HTTP status. */
export function errorType(status: number): string {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 402) return "billing_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  if (status === 529) return "overloaded_error";
  return "api_error";
}

/**
 * Refusals that are about the plan or our policy, not the key: on /anthropic they go out as 402
 * (billing_error) so Claude Code shows our message instead of "Failed to authenticate" (which it
 * says for any 403). dl and Autopilot still get their 403s and parse these codes; the mapping
 * happens only in the Anthropic error translation (`toAnthropicErrorResponse` in app.ts).
 */
export const BILLING_REFUSAL_CODES: ReadonlySet<string> = new Set(["harness_not_allowed", "dl_only", "below_bar", "blocked"]);

/**
 * The status an error goes out with. Claude Code retries 429 and 5xx answers; a refusal that a
 * retry can't change (a pause for everyone, a used-up budget, a plan or policy refusal) goes out
 * as 402 (billing_error), which Claude Code shows verbatim without retrying and without calling
 * it a login problem (a 403 makes it say "Failed to authenticate"). Transient ones (`retryable`)
 * keep theirs, Retry-After included; a 502 (the provider failed) stays 502 so it is retried. Real
 * auth failures (401) stay 401, and a 403 with any other code stays 403.
 */
export function errorStatus(status: number, retryable: boolean, code?: string): number {
  if (retryable) return status;
  if (status === 429 || status >= 500) return status === 502 ? 502 : 402;
  if (status === 403 && code !== undefined && BILLING_REFUSAL_CODES.has(code)) return 402;
  return status;
}

/** `{type: "error", error: {type, message}}`, with our code next to them so a client can tell refusals apart. */
export function anthropicError(status: number, message: string, code?: string, extra: Json = {}): Json {
  return { type: "error", error: { type: errorType(status), message, ...(code ? { code } : {}), ...extra } };
}

/**
 * An estimate for `count_tokens`: Claude Code uses it for the context meter only (and falls back
 * to its own character count without it). About 4 characters a token over the system prompt,
 * messages and tool definitions as JSON, which runs close to real tokenizers on code and English.
 */
export function estimateInputTokens(input: Json): number {
  const text = JSON.stringify({ system: input.system ?? null, messages: input.messages ?? [], tools: input.tools ?? [] });
  return Math.max(1, Math.ceil(text.length / 4));
}
