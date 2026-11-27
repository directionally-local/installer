/**
 * Open Relay's own request rules, learned by probing it (27 Nov 2026): it answers anything its
 * model server refuses with an opaque 400 ("the request was rejected by the model") and never
 * says why, so a request is shaped here to fit before it goes there. Only Open Relay requests
 * pass through this; every other upstream gets the client's request as before.
 *
 * - DeepSeek refuses tool names outside `^[A-Za-z0-9_-]+$` (MCP-style `fs.read`, `fs:read`,
 *   `fs/read`). Such names are renamed (`fs.read` → `fs__read`, with `_2`, `_3`... on a
 *   collision) everywhere the request names a tool (tools, tool_choice, the history's tool calls
 *   and tool results), and renamed back in the answer (a completion's tool calls, a stream's
 *   tool call deltas), so the client only ever sees its own names.
 * - DeepSeek refuses `strict: true` on a schema that isn't strict-complete (every property
 *   required and `additionalProperties: false`, all the way down): `strict` is dropped there.
 * - `max_tokens` fits the model's window: prompt and output share it (DeepSeek 393,216 tokens,
 *   Kimi 262,144), and a `max_tokens` far past it gets DeepSeek's opaque 400 rather than
 *   `context_length_exceeded`. Never 0 (Kimi refuses it). Kimi also refuses `top_logprobs`,
 *   which, like `logprobs`, isn't among the fields forwarded to Open Relay at all.
 *
 * - DeepSeek with tools, at no `reasoning_effort` or "medium", streams `<|place_holder_mm_span_…|>`
 *   over and over from the first token instead of answering (27 Nov 2026: 15/15 unset, 4/4
 *   medium; 0/4 low, 0/7 high, 0/5 without tools; Luminal and OpenRouter clean). Until Open
 *   Relay fixes it, those requests go with "high"; "low" and "high" go as sent.
 *
 * Tool-history repair (orphan, duplicate and missing tool results) is in tool-history.ts and
 * applies to every upstream.
 */

/** What Open Relay requires of a request to one of its models. */
export interface OpenRelayRules {
  /** Prompt and output tokens together. */
  contextWindow: number;
  /** Tool names must match SAFE_TOOL_NAME. */
  safeToolNames: boolean;
  /** `strict: true` only on a strict-complete schema. */
  strictNeedsCompleteSchema: boolean;
  /** With tools, an unset or "medium" `reasoning_effort` goes as "high" (see TOOLS_EFFORT). */
  toolsNeedEffort?: boolean;
}

/** Open Relay's windows, from its model pages: shared by the prompt and the output. */
export const OPENRELAY_RULES: Readonly<Record<string, OpenRelayRules>> = {
  "openrelay/deepseek-v4.1-flash": { contextWindow: 393_216, safeToolNames: true, strictNeedsCompleteSchema: true, toolsNeedEffort: true },
  "openrelay/kimi-k3.1-pro": { contextWindow: 262_144, safeToolNames: false, strictNeedsCompleteSchema: false },
};

/** The rules for an Open Relay model id; one without its own gets the model's window and no tool rules. */
export function openRelayRules(upstreamModel: string, contextWindow: number): OpenRelayRules {
  return OPENRELAY_RULES[upstreamModel] ?? { contextWindow, safeToolNames: false, strictNeedsCompleteSchema: false };
}

/** The most output asked of Open Relay in one request, whatever is left of the window. */
export const OPENRELAY_MAX_OUTPUT_TOKENS = 131_072;
/** Bytes per prompt token for the window clamp: about what code and English JSON-encode to. */
const CLAMP_BYTES_PER_TOKEN = 4;
/**
 * The output kept when the prompt estimate leaves less than this: an estimate is only that, and
 * a prompt really past the window gets `context_length_exceeded`, which goes on to the next upstream.
 */
const MIN_CLAMPED_OUTPUT_TOKENS = 4_096;

/** Prompt tokens a request's messages and tools come to, about. */
export function estimatedPromptTokens(payload: Record<string, unknown>): number {
  const bytes = JSON.stringify(payload.messages ?? []).length + (payload.tools === undefined ? 0 : JSON.stringify(payload.tools).length);
  return Math.ceil(bytes / CLAMP_BYTES_PER_TOKEN);
}

/** `maxTokens` held to the window left after the prompt, to OPENRELAY_MAX_OUTPUT_TOKENS, and to at least 1. */
export function clampedMaxTokens(maxTokens: number, promptTokens: number, contextWindow: number): number {
  const wanted = Number.isFinite(maxTokens) ? Math.floor(maxTokens) : OPENRELAY_MAX_OUTPUT_TOKENS;
  const left = contextWindow - Math.max(0, promptTokens);
  const room = Math.max(left, Math.min(wanted, MIN_CLAMPED_OUTPUT_TOKENS));
  return Math.max(1, Math.min(wanted, room, OPENRELAY_MAX_OUTPUT_TOKENS, contextWindow - 1));
}

/** The effort Open Relay DeepSeek gets with tools when the client asked for none or "medium": a workaround until Open Relay's fix. */
export const TOOLS_EFFORT = "high";

export const SAFE_TOOL_NAME = /^[A-Za-z0-9_-]+$/;
/** OpenAI's tool name limit, which DeepSeek's template keeps too. */
const MAX_TOOL_NAME = 64;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** Every tool name a request mentions, in order of first mention. */
function toolNamesOf(payload: Json): string[] {
  const names: string[] = [];
  const add = (name: unknown) => {
    if (typeof name === "string" && name && !names.includes(name)) names.push(name);
  };
  if (Array.isArray(payload.tools)) for (const tool of payload.tools) if (isObject(tool) && isObject(tool.function)) add(tool.function.name);
  if (isObject(payload.tool_choice) && isObject(payload.tool_choice.function)) add(payload.tool_choice.function.name);
  if (Array.isArray(payload.messages)) {
    for (const message of payload.messages) {
      if (!isObject(message)) continue;
      if (Array.isArray(message.tool_calls)) for (const call of message.tool_calls) if (isObject(call) && isObject(call.function)) add(call.function.name);
      if (isObject(message.function_call)) add(message.function_call.name);
      if (message.role === "tool" || message.role === "function") add(message.name);
    }
  }
  return names;
}

/**
 * Upstream names for the request's unsafe tool names: each invalid character becomes `__`, cut
 * to 64 characters, with `_2`, `_3`... while the name is taken (by a safe name in the request or
 * an earlier rename). Undefined when every name is safe already.
 */
export function safeToolNames(names: readonly string[]): Map<string, string> | undefined {
  const unsafe = names.filter((name) => !SAFE_TOOL_NAME.test(name));
  if (unsafe.length === 0) return undefined;
  const taken = new Set(names.filter((name) => SAFE_TOOL_NAME.test(name)));
  const renamed = new Map<string, string>();
  for (const name of unsafe) {
    const base = name.replace(/[^A-Za-z0-9_-]/g, "__").slice(0, MAX_TOOL_NAME) || "tool";
    let candidate = base;
    for (let n = 2; taken.has(candidate); n++) {
      const suffix = `_${n}`;
      candidate = base.slice(0, MAX_TOOL_NAME - suffix.length) + suffix;
    }
    taken.add(candidate);
    renamed.set(name, candidate);
  }
  return renamed;
}

/** `payload` with the tool names in `renamed` replaced, copying only what changes. */
function renameTools(payload: Json, renamed: ReadonlyMap<string, string>): Json {
  const to = (name: unknown) => (typeof name === "string" ? (renamed.get(name) ?? name) : name);
  const withFunctionName = <T extends Json>(holder: T, key: string): T => {
    const fn = holder[key];
    if (!isObject(fn) || typeof fn.name !== "string" || !renamed.has(fn.name)) return holder;
    return { ...holder, [key]: { ...fn, name: to(fn.name) } };
  };
  const out: Json = { ...payload };
  if (Array.isArray(payload.tools)) out.tools = payload.tools.map((tool) => (isObject(tool) ? withFunctionName(tool, "function") : tool));
  if (isObject(payload.tool_choice)) out.tool_choice = withFunctionName(payload.tool_choice, "function");
  if (Array.isArray(payload.messages)) {
    out.messages = payload.messages.map((message) => {
      if (!isObject(message)) return message;
      let next = message;
      if (Array.isArray(message.tool_calls)) next = { ...next, tool_calls: message.tool_calls.map((call) => (isObject(call) ? withFunctionName(call, "function") : call)) };
      if (isObject(message.function_call)) next = withFunctionName(next, "function_call");
      if ((message.role === "tool" || message.role === "function") && typeof message.name === "string" && renamed.has(message.name)) next = { ...next, name: to(message.name) };
      return next;
    });
  }
  return out;
}

/**
 * Whether a JSON schema passes as strict: every object lists all its properties as required and
 * sets `additionalProperties: false`, in nested properties, items and combinators too.
 */
export function strictComplete(schema: unknown): boolean {
  if (!isObject(schema)) return schema === undefined || typeof schema === "boolean";
  const children: unknown[] = [];
  const isObjectType = schema.type === "object" || (Array.isArray(schema.type) && schema.type.includes("object")) || isObject(schema.properties);
  if (isObjectType) {
    if (schema.additionalProperties !== false) return false;
    const properties = isObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (!Object.keys(properties).every((key) => required.includes(key))) return false;
    children.push(...Object.values(properties));
  }
  if (schema.items !== undefined) children.push(...(Array.isArray(schema.items) ? schema.items : [schema.items]));
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) if (Array.isArray(schema[key])) children.push(...(schema[key] as unknown[]));
  for (const key of ["$defs", "definitions"]) if (isObject(schema[key])) children.push(...Object.values(schema[key] as Json));
  return children.every(strictComplete);
}

/** `payload` without `strict: true` on tools whose schema isn't strict-complete. */
function looseStrictDropped(payload: Json): Json {
  if (!Array.isArray(payload.tools)) return payload;
  let changed = false;
  const tools = payload.tools.map((tool) => {
    if (!isObject(tool) || !isObject(tool.function) || tool.function.strict !== true || strictComplete(tool.function.parameters)) return tool;
    changed = true;
    const { strict: _strict, ...fn } = tool.function;
    return { ...tool, function: fn };
  });
  return changed ? { ...payload, tools } : payload;
}

/** An Open Relay request shaped to its rules, and the tool names to give back to the client (upstream → client). */
export interface ShapedRequest {
  payload: Json;
  toolNames?: ReadonlyMap<string, string>;
}

/**
 * `payload` (already in Open Relay's fields, with the reservation's `max_tokens`) shaped to the
 * model's rules. The client's body is never changed: a retry on another upstream sends it as it was.
 */
export function shapeOpenRelayRequest(payload: Json, rules: OpenRelayRules): ShapedRequest {
  let shaped = payload;
  let toolNames: Map<string, string> | undefined;
  if (rules.safeToolNames) {
    const renamed = safeToolNames(toolNamesOf(shaped));
    if (renamed) {
      shaped = renameTools(shaped, renamed);
      toolNames = new Map([...renamed].map(([client, upstream]) => [upstream, client]));
    }
  }
  if (rules.strictNeedsCompleteSchema) shaped = looseStrictDropped(shaped);
  if (rules.toolsNeedEffort && Array.isArray(shaped.tools) && shaped.tools.length > 0) {
    const effort = shaped.reasoning_effort;
    if (effort === undefined || effort === null || effort === "medium") shaped = { ...shaped, reasoning_effort: TOOLS_EFFORT };
  }
  if (typeof shaped.max_tokens === "number") {
    const max = clampedMaxTokens(shaped.max_tokens, estimatedPromptTokens(shaped), rules.contextWindow);
    if (max !== shaped.max_tokens) shaped = { ...shaped, max_tokens: max };
  }
  for (const field of ["top_logprobs", "logprobs", "max_completion_tokens"]) {
    if (field in shaped) {
      const { [field]: _dropped, ...rest } = shaped;
      shaped = rest;
    }
  }
  return toolNames ? { payload: shaped, toolNames } : { payload: shaped };
}

/** A completion (or one stream chunk) with its tool call names given back; the same object when none change. */
function restoredNames(parsed: unknown, names: ReadonlyMap<string, string>, key: "message" | "delta"): unknown {
  if (!isObject(parsed) || !Array.isArray(parsed.choices)) return parsed;
  let changed = false;
  const choices = parsed.choices.map((choice) => {
    if (!isObject(choice) || !isObject(choice[key])) return choice;
    const message = choice[key] as Json;
    let next = message;
    if (Array.isArray(message.tool_calls)) {
      const calls = message.tool_calls.map((call) => {
        if (!isObject(call) || !isObject(call.function) || typeof call.function.name !== "string") return call;
        const name = names.get(call.function.name);
        if (name === undefined) return call;
        changed = true;
        return { ...call, function: { ...call.function, name } };
      });
      next = { ...next, tool_calls: calls };
    }
    if (isObject(message.function_call) && typeof message.function_call.name === "string" && names.has(message.function_call.name)) {
      changed = true;
      next = { ...next, function_call: { ...message.function_call, name: names.get(message.function_call.name) } };
    }
    return next === message ? choice : { ...choice, [key]: next };
  });
  return changed ? { ...parsed, choices } : parsed;
}

/** A non-streamed completion's text with the client's tool names back; unchanged when it names none of ours. */
export function restoreToolNamesInCompletion(text: string, names: ReadonlyMap<string, string>): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const restored = restoredNames(parsed, names, "message");
  return restored === parsed ? text : JSON.stringify(restored);
}

/**
 * A chat completions stream with the client's tool names back in its tool call deltas. A name
 * normally arrives whole in a call's first delta; one split across deltas is held back while it
 * could still become a renamed one, and given back whole (or, if it doesn't, as it came) with the
 * call's next delta. Every other line passes through as it came.
 */
export function restoreToolNamesInStream(body: ReadableStream<Uint8Array>, names: ReadonlyMap<string, string>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const upstreamNames = [...names.keys()];
  /** Per choice and call index: the name as received so far, and as given to the client so far. */
  const calls = new Map<string, { received: string; sent: string }>();
  let buffer = "";

  const nameDelta = (id: string, fragment: string | undefined): string | undefined => {
    const state = calls.get(id) ?? { received: "", sent: "" };
    calls.set(id, state);
    if (fragment !== undefined) state.received += fragment;
    const exact = names.get(state.received);
    let target: string;
    if (exact !== undefined) target = exact;
    else if (fragment !== undefined && upstreamNames.some((name) => name.startsWith(state.received))) return undefined;
    else target = state.received;
    if (!target.startsWith(state.sent)) return undefined;
    const out = target.slice(state.sent.length);
    state.sent = target;
    return out || undefined;
  };

  const rewrite = (data: string): string => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return data;
    }
    if (!isObject(parsed) || !Array.isArray(parsed.choices)) return data;
    let changed = false;
    const choices = parsed.choices.map((choice, position) => {
      if (!isObject(choice) || !isObject(choice.delta) || !Array.isArray(choice.delta.tool_calls)) return choice;
      const choiceIndex = typeof choice.index === "number" ? choice.index : position;
      const toolCalls = choice.delta.tool_calls.map((call, callPosition) => {
        if (!isObject(call)) return call;
        const id = `${choiceIndex}:${typeof call.index === "number" ? call.index : callPosition}`;
        const fn = isObject(call.function) ? call.function : undefined;
        const fragment = typeof fn?.name === "string" ? fn.name : undefined;
        if (fragment === undefined && !calls.has(id)) return call;
        const out = nameDelta(id, fragment);
        if (out === fragment) return call;
        changed = true;
        const { name: _name, ...rest } = fn ?? {};
        return { ...call, function: out === undefined ? rest : { ...rest, name: out } };
      });
      return { ...choice, delta: { ...choice.delta, tool_calls: toolCalls } };
    });
    return changed ? JSON.stringify({ ...parsed, choices }) : data;
  };

  const lineOut = (line: string): string => {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!trimmed.startsWith("data:")) return line;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return line;
    const next = rewrite(data);
    return next === data ? line : `data: ${next}${trimmed === line ? "" : "\r"}`;
  };

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        if (lines.length > 0) controller.enqueue(encoder.encode(lines.map(lineOut).join("\n") + "\n"));
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer) controller.enqueue(encoder.encode(lineOut(buffer)));
      },
    }),
  );
}

/**
 * The wait Open Relay names in a 429's message ("tokens rate limit exceeded; retry after 74s"),
 * in seconds, or its Retry-After header; undefined when neither says.
 */
export function openRelayRetryAfterSeconds(text: string, header?: string | null): number | undefined {
  let message = text;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } } | null;
    if (typeof parsed?.error?.message === "string") message = parsed.error.message;
  } catch {
    // Not JSON: read the text as it is.
  }
  const match = /retry after\s+(\d+(?:\.\d+)?)\s*s/i.exec(message);
  const seconds = match ? Number(match[1]) : header ? Number(header) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined;
}

/** The longest Open Relay is skipped after a 429, whatever it says. */
export const MAX_OPENRELAY_COOLDOWN_S = 600;
