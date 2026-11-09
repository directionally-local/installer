/**
 * Chat Completions ⇄ Responses, for the requests OpenAI serves.
 *
 * OpenAI's /v1/chat/completions refuses function tools while a GPT-6 model reasons, and a
 * coding agent always sends tools, so GPT-6 goes through /v1/responses. Clients keep speaking
 * Chat Completions to the free tier: the request is translated on the way out, and the answer
 * (a JSON body or a server-sent-event stream) is translated back into the Chat Completions
 * shape, usage included, so metering and settlement read the same numbers as before.
 *
 * Nothing here keeps content: it only reshapes what passes through.
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * Sampling fields GPT-6 takes. All three GPT-6 models reason, and OpenAI's reasoning models
 * refuse `temperature` and `top_p` (checked against the API on 2026-11-09), so they're dropped.
 */
const PASSTHROUGH_FIELDS = ["parallel_tool_calls", "prompt_cache_key", "safety_identifier"] as const;

export interface ResponsesRequestOptions {
  /** The provider's id for the model. */
  model: string;
  /** The reservation's output cap. */
  maxTokens: number;
  /** The per-person identifier OpenAI sees (never the GitHub id itself). */
  user: string;
  stream: boolean;
}

/** A Chat Completions request body → a Responses request body. */
export function toResponsesRequest(body: Json, options: ResponsesRequestOptions): Json {
  const payload: Json = {
    model: options.model,
    input: toInput(body.messages),
    max_output_tokens: options.maxTokens,
    store: false,
    user: options.user,
    stream: options.stream,
  };
  const tools = toTools(body.tools);
  if (tools) payload.tools = tools;
  const toolChoice = toToolChoice(body.tool_choice);
  if (toolChoice !== undefined) payload.tool_choice = toolChoice;
  // OpenRouter's `reasoning: {effort}` is `reasoning_effort` in the Chat Completions shape.
  const effort = str(body.reasoning_effort) ?? str(isObject(body.reasoning) ? body.reasoning.effort : undefined);
  if (effort) payload.reasoning = { effort };
  for (const field of PASSTHROUGH_FIELDS) if (body[field] !== undefined) payload[field] = body[field];
  const text = toText(body.response_format, body.verbosity);
  if (text) payload.text = text;
  return payload;
}

/** Chat messages → Responses input items, in order. */
function toInput(messages: unknown): Json[] {
  if (!Array.isArray(messages)) return [];
  const items: Json[] = [];
  for (const message of messages) {
    if (!isObject(message)) continue;
    const role = str(message.role);
    if (role === "tool") {
      items.push({ type: "function_call_output", call_id: str(message.tool_call_id) ?? "", output: textOf(message.content) });
      continue;
    }
    if (role === "assistant") {
      const text = textOf(message.content);
      if (text) items.push({ type: "message", role: "assistant", content: text });
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          if (!isObject(call)) continue;
          const fn = isObject(call.function) ? call.function : {};
          items.push({ type: "function_call", call_id: str(call.id) ?? "", name: str(fn.name) ?? "", arguments: str(fn.arguments) ?? "" });
        }
      }
      continue;
    }
    // system, developer and user keep their role; Responses takes all three in `input`.
    if (role === "system" || role === "developer") {
      items.push({ type: "message", role, content: textOf(message.content) });
      continue;
    }
    items.push({ type: "message", role: "user", content: userContent(message.content) });
  }
  return items;
}

/** A content string or array of text parts, as plain text. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (isObject(part) && typeof part.text === "string" ? part.text : typeof part === "string" ? part : ""))
    .join("");
}

/** A user message's content: a string as is, parts as input_text / input_image. */
function userContent(content: unknown): string | Json[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: Json[] = [];
  for (const part of content) {
    if (typeof part === "string") parts.push({ type: "input_text", text: part });
    else if (!isObject(part)) continue;
    else if (part.type === "text" || part.type === "input_text") parts.push({ type: "input_text", text: str(part.text) ?? "" });
    else if (part.type === "image_url") {
      const image = part.image_url;
      const url = typeof image === "string" ? image : isObject(image) ? str(image.url) : undefined;
      if (!url) continue;
      const detail = isObject(image) ? str(image.detail) : undefined;
      parts.push({ type: "input_image", image_url: url, detail: detail ?? "auto" });
    }
  }
  return parts;
}

/** Chat tools → Responses tools. A function's `strict` defaults to false, as in Chat Completions. */
function toTools(tools: unknown): Json[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out: Json[] = [];
  for (const tool of tools) {
    if (!isObject(tool)) continue;
    if (tool.type === "function" && isObject(tool.function)) {
      const fn = tool.function;
      out.push({
        type: "function",
        name: str(fn.name) ?? "",
        ...(fn.description !== undefined ? { description: fn.description } : {}),
        parameters: isObject(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
        strict: fn.strict === true,
      });
    } else if (tool.type === "custom" && isObject(tool.custom)) {
      out.push({ type: "custom", ...tool.custom });
    }
  }
  return out.length > 0 ? out : undefined;
}

function toToolChoice(choice: unknown): unknown {
  if (choice === undefined || choice === null) return undefined;
  if (typeof choice === "string") return choice;
  if (!isObject(choice)) return undefined;
  if (choice.type === "function" && isObject(choice.function)) return { type: "function", name: str(choice.function.name) ?? "" };
  if (choice.type === "allowed_tools" && isObject(choice.allowed_tools)) {
    const allowed = choice.allowed_tools;
    const tools = Array.isArray(allowed.tools)
      ? allowed.tools.map((tool) => (isObject(tool) && isObject(tool.function) ? { type: "function", name: str(tool.function.name) ?? "" } : tool))
      : [];
    return { type: "allowed_tools", mode: allowed.mode ?? "auto", tools };
  }
  return choice;
}

/** `response_format` and `verbosity` → Responses `text`. */
function toText(format: unknown, verbosity: unknown): Json | undefined {
  const text: Json = {};
  if (isObject(format)) {
    if (format.type === "json_schema" && isObject(format.json_schema)) text.format = { type: "json_schema", ...format.json_schema };
    else if (format.type === "json_object" || format.type === "text") text.format = { type: format.type };
  }
  if (typeof verbosity === "string") text.verbosity = verbosity;
  return Object.keys(text).length > 0 ? text : undefined;
}

// ─── Responses → Chat Completions ─────────────────────────────────────────────

/** Responses `usage` → the Chat Completions `usage` object `parseUsage` reads; undefined if absent. */
export function toChatUsage(usage: unknown): Json | undefined {
  if (!isObject(usage)) return undefined;
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  const cached = isObject(usage.input_tokens_details) ? usage.input_tokens_details.cached_tokens : undefined;
  const reasoning = isObject(usage.output_tokens_details) ? usage.output_tokens_details.reasoning_tokens : undefined;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : input + output,
    prompt_tokens_details: { cached_tokens: typeof cached === "number" ? cached : 0 },
    completion_tokens_details: { reasoning_tokens: typeof reasoning === "number" ? reasoning : 0 },
  };
}

/** Why a response stopped, as a Chat Completions finish_reason. */
function finishReason(response: Json, hasToolCalls: boolean): string {
  if (response.status === "incomplete") {
    const reason = isObject(response.incomplete_details) ? response.incomplete_details.reason : undefined;
    return reason === "content_filter" ? "content_filter" : "length";
  }
  return hasToolCalls ? "tool_calls" : "stop";
}

/** Whether a body is a Responses `response` object. */
export function isResponse(value: unknown): value is Json {
  return isObject(value) && value.object === "response";
}

/** A finished Responses `response` → one `chat.completion`. */
export function toChatCompletion(response: Json): Json {
  let content = "";
  let refusal = "";
  const toolCalls: Json[] = [];
  for (const item of Array.isArray(response.output) ? response.output : []) {
    if (!isObject(item)) continue;
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (!isObject(part)) continue;
        if (part.type === "output_text") content += str(part.text) ?? "";
        else if (part.type === "refusal") refusal += str(part.refusal) ?? "";
      }
    } else if (item.type === "function_call") {
      toolCalls.push({ id: str(item.call_id) ?? "", type: "function", function: { name: str(item.name) ?? "", arguments: str(item.arguments) ?? "" } });
    }
  }
  const message: Json = { role: "assistant", content: content || (toolCalls.length > 0 ? null : "") };
  if (refusal) message.refusal = refusal;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const usage = toChatUsage(response.usage);
  return {
    id: str(response.id) ?? "",
    object: "chat.completion",
    created: typeof response.created_at === "number" ? response.created_at : 0,
    model: str(response.model) ?? "",
    choices: [{ index: 0, message, finish_reason: finishReason(response, toolCalls.length > 0), logprobs: null }],
    ...(usage ? { usage } : {}),
  };
}

const MAX_EVENT_BUFFER = 8 * 1024 * 1024;

/**
 * A Responses event stream → a Chat Completions chunk stream: a role chunk, text deltas,
 * tool calls (id and name first, then argument deltas), a finish_reason chunk, a usage chunk
 * (as `stream_options.include_usage` gives) and `data: [DONE]`. A failed response or an
 * `error` event becomes a `data: {"error": …}` chunk with no `[DONE]`, and an upstream that
 * ends without finishing ends without `[DONE]`, so the meter sees an upstream failure as it
 * did before.
 */
export function toChatStream(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let finished = false;
  let id = "";
  let model = "";
  let created = 0;
  /** Tool-call index and argument characters sent, by output_index. */
  const calls = new Map<number, { index: number; sent: number }>();
  let roleSent = false;

  const chunk = (choices: Json[], extra: Json = {}): string =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices, ...extra })}\n\n`;
  const delta = (d: Json): string => chunk([{ index: 0, delta: d, finish_reason: null }]);

  const handle = (event: Json): string => {
    const type = str(event.type) ?? "";
    let out = "";
    if (isObject(event.response)) {
      id = str(event.response.id) ?? id;
      model = str(event.response.model) ?? model;
      if (typeof event.response.created_at === "number") created = event.response.created_at;
    }
    if (!roleSent && (type === "response.created" || type === "response.output_item.added" || type === "response.output_text.delta")) {
      roleSent = true;
      out += delta({ role: "assistant", content: "" });
    }
    switch (type) {
      case "response.output_text.delta": {
        const text = str(event.delta);
        if (text) out += delta({ content: text });
        break;
      }
      case "response.refusal.delta": {
        const text = str(event.delta);
        if (text) out += delta({ refusal: text });
        break;
      }
      case "response.output_item.added": {
        const item = isObject(event.item) ? event.item : undefined;
        if (item?.type !== "function_call" || typeof event.output_index !== "number") break;
        const call = { index: calls.size, sent: 0 };
        calls.set(event.output_index, call);
        const args = str(item.arguments) ?? "";
        call.sent = args.length;
        out += delta({ tool_calls: [{ index: call.index, id: str(item.call_id) ?? "", type: "function", function: { name: str(item.name) ?? "", arguments: args } }] });
        break;
      }
      case "response.function_call_arguments.delta": {
        const call = typeof event.output_index === "number" ? calls.get(event.output_index) : undefined;
        const text = str(event.delta);
        if (!call || !text) break;
        call.sent += text.length;
        out += delta({ tool_calls: [{ index: call.index, function: { arguments: text } }] });
        break;
      }
      case "response.output_item.done": {
        // Arguments that never came as deltas: send what's left.
        const item = isObject(event.item) ? event.item : undefined;
        const call = typeof event.output_index === "number" ? calls.get(event.output_index) : undefined;
        const args = str(item?.arguments);
        if (call && args && args.length > call.sent) {
          out += delta({ tool_calls: [{ index: call.index, function: { arguments: args.slice(call.sent) } }] });
          call.sent = args.length;
        }
        break;
      }
      case "response.completed":
      case "response.incomplete": {
        const response = isObject(event.response) ? event.response : {};
        out += chunk([{ index: 0, delta: {}, finish_reason: finishReason(response, calls.size > 0) }]);
        const usage = toChatUsage(response.usage);
        if (usage) out += chunk([], { usage });
        out += "data: [DONE]\n\n";
        finished = true;
        break;
      }
      case "response.failed":
      case "error": {
        const response = isObject(event.response) ? event.response : undefined;
        const usage = toChatUsage(response?.usage);
        if (usage) out += chunk([], { usage });
        const error = response && isObject(response.error) ? response.error : event;
        out += `data: ${JSON.stringify({ error: { message: str(error.message) ?? "The model provider failed.", code: error.code ?? null } })}\n\n`;
        finished = true;
        break;
      }
    }
    return out;
  };

  const scan = (final: boolean): string => {
    const lines = buffer.split("\n");
    buffer = final ? "" : (lines.pop() ?? "");
    if (buffer.length > MAX_EVENT_BUFFER) buffer = "";
    let out = "";
    for (const raw of lines) {
      if (finished) break;
      const line = raw.trimEnd();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const event = JSON.parse(data) as unknown;
        if (isObject(event)) out += handle(event);
      } catch {
        // A non-JSON data line carries nothing to translate.
      }
    }
    return out;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (finished) {
          controller.close();
          await reader.cancel().catch(() => undefined);
          return;
        }
        const result = await reader.read();
        if (result.done) {
          buffer += decoder.decode();
          const out = scan(true);
          if (out) controller.enqueue(encoder.encode(out));
          controller.close();
          return;
        }
        buffer += decoder.decode(result.value, { stream: true });
        const out = scan(false);
        if (out) {
          controller.enqueue(encoder.encode(out));
          return;
        }
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}
