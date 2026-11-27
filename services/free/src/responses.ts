/**
 * OpenAI Responses ⇄ Chat Completions, for Codex CLI (`dl codex`) and any other client of
 * `POST /v1/responses`.
 *
 * Codex speaks only the Responses API (`wire_api = "responses"`). The request is translated into
 * the chat completions body the rest of the service already serves (auth, plan limits, model
 * routing and fallbacks, moderation, history repair, metering and settlement all stay in app.ts
 * `chat`), and the answer (a JSON body or a server-sent-event stream) is translated back into a
 * Responses `response` object or its event sequence. (openai-responses.ts is the other way round:
 * chat completions from our clients sent on to OpenAI's Responses API for GPT-6.)
 *
 * Request, supported: `instructions`; `input` as a string or items: `message` (roles system,
 * developer, user, assistant; parts input_text, output_text, refusal, input_image, input_file),
 * `function_call`, `function_call_output`, `custom_tool_call`, `custom_tool_call_output`,
 * `reasoning` (ours come back as `reasoning_content`, see REASONING_PREFIX) and
 * `additional_tools`; `tools`: function tools, `namespace` groups of them (Codex's sub-agent
 * tools) and `custom` (freeform) tools, as functions; `tool_choice`; `parallel_tool_calls`;
 * `max_output_tokens`; `temperature`; `top_p`; `reasoning.effort`; `text.format`; `stream`.
 * Accepted and ignored: `store` (nothing is ever stored: answers say `store: false`), `include`,
 * `prompt_cache_key` (a session hint), `metadata`, `client_metadata`, `user`, `safety_identifier`,
 * `service_tier`, `truncation`, `stream_options`, `text.verbosity`, `reasoning.summary`; hosted
 * tools (web search, file search, image generation and the like) are dropped, as are items no
 * chat model can take (web search calls, server-side compaction). Refused (400):
 * `previous_response_id` and `conversation` (no response is kept to continue from: send the whole
 * conversation in `input`), `background`, and `item_reference` items.
 *
 * Nothing here keeps content: it only reshapes what passes through.
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** What replaces an image the serving model can't read. */
export const IMAGE_OMITTED = "[An image was attached here, but this model can't read images, so it was left out.]";
/** What replaces a file part (PDFs and the like). */
export const FILE_OMITTED = "[A file was attached here, but this model can't read files, so it was left out.]";
/**
 * Reasoning items the service makes carry the model's reasoning in `encrypted_content` as this
 * prefix and the text in base64: Codex sends reasoning items back as they came (it drops their
 * `content` text when it replays them), so this is how the reasoning reaches the model again.
 * Not encrypted (nothing is secret in it); anyone else's encrypted reasoning is dropped.
 */
export const REASONING_PREFIX = "dl.reasoning.v1:";

/** Chat tool names: what OpenAI-compatible servers accept. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** One tool as the client named it, behind the chat function name the model sees. */
export interface ToolName {
  name: string;
  namespace?: string;
  /** A freeform (`custom`) tool: its chat function takes one string, `input`. */
  custom?: boolean;
}

/** Chat function name → the client's tool. */
export type ToolNames = ReadonlyMap<string, ToolName>;

export interface ResponsesRequestOptions {
  /** Whether the requested model reads images. */
  vision: boolean;
}

export type TranslatedResponses =
  | {
      ok: true;
      /** The chat completions body for `chat`. */
      body: Json;
      stream: boolean;
      tools: ToolNames;
      /** The request's own settings, echoed in the response object as the Responses API does. */
      echo: Json;
      /** Codex's conversation id (`prompt_cache_key`), for the session label when no header names one. */
      sessionHint?: string;
    }
  | { ok: false; message: string; param?: string };

/** A Responses request body → a chat completions body. */
export function toChatRequest(input: Json, options: ResponsesRequestOptions): TranslatedResponses {
  const model = str(input.model);
  if (!model) return { ok: false, message: "model: name the model (GET /v1/models lists yours).", param: "model" };
  if (input.previous_response_id !== undefined && input.previous_response_id !== null && input.previous_response_id !== "") {
    return { ok: false, message: "previous_response_id isn't supported: dl keeps no responses. Send the whole conversation in input (with store: false).", param: "previous_response_id" };
  }
  if (input.conversation !== undefined && input.conversation !== null) {
    return { ok: false, message: "conversation isn't supported: dl keeps no conversations. Send the whole conversation in input.", param: "conversation" };
  }
  if (input.background === true) return { ok: false, message: "background responses aren't supported: send the request without background.", param: "background" };

  const tools = new Map<string, ToolName>();
  const chatTools: Json[] = [];
  const addTools = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const tool of list) for (const one of chatToolsOf(tool, tools)) chatTools.push(one);
  };
  addTools(input.tools);

  const messages: Json[] = [];
  const instructions = str(input.instructions);
  if (instructions) messages.push({ role: "system", content: instructions });
  const converted = toMessages(input.input, options, tools, addTools);
  if (!converted.ok) return converted;
  messages.push(...converted.messages);
  if (!messages.some((message) => message.role !== "system")) return { ok: false, message: "input: send at least one message.", param: "input" };

  const stream = input.stream === true;
  const body: Json = { model, messages, stream };
  const max = input.max_output_tokens;
  if (typeof max === "number" && Number.isFinite(max) && max > 0) body.max_tokens = Math.floor(max);
  if (typeof input.temperature === "number" && Number.isFinite(input.temperature)) body.temperature = input.temperature;
  if (typeof input.top_p === "number" && Number.isFinite(input.top_p)) body.top_p = input.top_p;
  if (chatTools.length > 0) {
    body.tools = chatTools;
    const choice = toolChoice(input.tool_choice, tools);
    if (choice !== undefined) body.tool_choice = choice;
    if (typeof input.parallel_tool_calls === "boolean") body.parallel_tool_calls = input.parallel_tool_calls;
  }
  const effort = reasoningEffort(isObject(input.reasoning) ? input.reasoning.effort : undefined);
  if (effort) body.reasoning = { effort };
  const format = responseFormat(isObject(input.text) ? input.text.format : undefined);
  if (format) body.response_format = format;

  const echo: Json = {
    instructions: instructions ?? null,
    max_output_tokens: typeof max === "number" ? max : null,
    parallel_tool_calls: typeof input.parallel_tool_calls === "boolean" ? input.parallel_tool_calls : true,
    temperature: typeof input.temperature === "number" ? input.temperature : null,
    top_p: typeof input.top_p === "number" ? input.top_p : null,
    tool_choice: input.tool_choice ?? "auto",
    tools: Array.isArray(input.tools) ? input.tools : [],
    reasoning: { effort: effort ?? null, summary: null },
    text: { format: isObject(input.text) && isObject(input.text.format) ? input.text.format : { type: "text" } },
    metadata: isObject(input.metadata) ? input.metadata : {},
  };
  const hint = str(input.prompt_cache_key)?.trim();
  return { ok: true, body, stream, tools, echo, ...(hint ? { sessionHint: hint } : {}) };
}

/** `reasoning.effort` as the chat models take it: none means not asked. */
function reasoningEffort(value: unknown): "low" | "medium" | "high" | undefined {
  if (value === "minimal" || value === "low") return "low";
  if (value === "medium") return "medium";
  if (value === "high" || value === "xhigh") return "high";
  return undefined;
}

/** `text.format` → chat `response_format`. */
function responseFormat(format: unknown): Json | undefined {
  if (!isObject(format)) return undefined;
  if (format.type === "json_object") return { type: "json_object" };
  if (format.type === "json_schema" && isObject(format.schema)) {
    return { type: "json_schema", json_schema: { name: str(format.name) ?? "response", schema: format.schema, ...(typeof format.strict === "boolean" ? { strict: format.strict } : {}) } };
  }
  return undefined;
}

/** A chat function name for a client tool: as it is when it fits, else a safe, unique one. */
function chatName(tool: ToolName, taken: ReadonlyMap<string, ToolName>): string {
  const plain = tool.namespace ? `${tool.namespace}__${tool.name}` : tool.name;
  const base = TOOL_NAME.test(plain) ? plain : plain.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "tool";
  let name = base;
  for (let n = 2; taken.has(name) && !sameTool(taken.get(name)!, tool); n++) name = `${base.slice(0, 60)}_${n}`;
  return name;
}

function sameTool(a: ToolName, b: ToolName): boolean {
  return a.name === b.name && a.namespace === b.namespace && Boolean(a.custom) === Boolean(b.custom);
}

/** The chat name the request's tools gave a client tool (a call in the history), or a new one. */
function nameFor(tool: ToolName, tools: Map<string, ToolName>): string {
  for (const [name, known] of tools) if (known.name === tool.name && known.namespace === tool.namespace) return name;
  const name = chatName(tool, tools);
  tools.set(name, tool);
  return name;
}

/** One Responses tool → chat function tools (a namespace gives one per function in it). */
function chatToolsOf(tool: unknown, tools: Map<string, ToolName>, namespace?: string): Json[] {
  if (!isObject(tool)) return [];
  if (tool.type === "namespace" && !namespace) {
    const ns = str(tool.name);
    if (!ns || !Array.isArray(tool.tools)) return [];
    return tool.tools.flatMap((inner) => chatToolsOf(inner, tools, ns));
  }
  const name = str(tool.name);
  if (!name) return [];
  if (tool.type === "function") {
    const spec: ToolName = { name, ...(namespace ? { namespace } : {}) };
    const chat = chatName(spec, tools);
    tools.set(chat, spec);
    const description = str(tool.description);
    return [{ type: "function", function: { name: chat, ...(description ? { description } : {}), parameters: isObject(tool.parameters) ? tool.parameters : { type: "object", properties: {} } } }];
  }
  if (tool.type === "custom") {
    const spec: ToolName = { name, ...(namespace ? { namespace } : {}), custom: true };
    const chat = chatName(spec, tools);
    tools.set(chat, spec);
    return [{ type: "function", function: { name: chat, description: customDescription(tool), parameters: { type: "object", properties: { input: { type: "string", description: "The tool's whole input, as plain text in the format described." } }, required: ["input"], additionalProperties: false } } }];
  }
  // Hosted tools (web_search, file_search, image_generation, code_interpreter, mcp, local_shell,
  // computer use, tool_search…) have no chat form: the model doesn't see them.
  return [];
}

/** A freeform tool's description, with its grammar (Lark or regex) spelled out for the model. */
function customDescription(tool: Json): string {
  const parts = [str(tool.description) ?? ""];
  const format = isObject(tool.format) ? tool.format : undefined;
  if (format?.type === "grammar" && typeof format.definition === "string") {
    parts.push(`Put the raw input in the \`input\` string. It must follow this ${str(format.syntax) ?? "grammar"} grammar:\n${format.definition}`);
  } else {
    parts.push("Put the raw input in the `input` string.");
  }
  return parts.filter(Boolean).join("\n\n");
}

function toolChoice(choice: unknown, tools: ToolNames): unknown {
  if (choice === "auto" || choice === "none" || choice === "required") return choice;
  if (!isObject(choice)) return undefined;
  if ((choice.type === "function" || choice.type === "custom") && typeof choice.name === "string") {
    for (const [name, tool] of tools) if (tool.name === choice.name) return { type: "function", function: { name } };
    return undefined;
  }
  if (choice.type === "allowed_tools") return choice.mode === "required" ? "required" : "auto";
  return undefined;
}

/** The text of message content parts, images and files as notes (or image parts, for a model that reads them). */
function contentParts(content: unknown, options: ResponsesRequestOptions): { text: string; parts: Json[] } {
  if (typeof content === "string") return { text: content, parts: content ? [{ type: "text", text: content }] : [] };
  const parts: Json[] = [];
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === "string") {
        if (part) parts.push({ type: "text", text: part });
        continue;
      }
      if (!isObject(part)) continue;
      const type = str(part.type);
      if (type === "input_text" || type === "output_text" || type === "text" || type === "summary_text" || type === "reasoning_text") {
        const text = str(part.text) ?? "";
        if (text) parts.push({ type: "text", text });
      } else if (type === "refusal") {
        const text = str(part.refusal) ?? "";
        if (text) parts.push({ type: "text", text });
      } else if (type === "input_image") {
        const url = str(part.image_url) ?? (isObject(part.image_url) ? str(part.image_url.url) : undefined);
        if (options.vision && url) parts.push({ type: "image_url", image_url: { url, ...(typeof part.detail === "string" && part.detail !== "original" ? { detail: part.detail } : {}) } });
        else parts.push({ type: "text", text: IMAGE_OMITTED });
      } else if (type === "input_file" || type === "input_audio") {
        parts.push({ type: "text", text: FILE_OMITTED });
      }
    }
  }
  return { text: parts.filter((part) => part.type === "text").map((part) => part.text as string).join("\n\n"), parts };
}

/** A tool's output (a string or content parts) as the text of a chat `tool` message. */
function outputText(output: unknown, options: ResponsesRequestOptions): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return contentParts(output, { ...options, vision: false }).text;
  if (isObject(output)) {
    // Older shapes: {content: "...", success}.
    if (typeof output.content === "string") return output.content;
    if (Array.isArray(output.content)) return contentParts(output.content, { ...options, vision: false }).text;
  }
  return output === undefined || output === null ? "" : JSON.stringify(output);
}

/** Our own reasoning text from a reasoning item; undefined for anyone else's. */
export function reasoningOf(item: Json): string | undefined {
  const sealed = str(item.encrypted_content);
  if (sealed?.startsWith(REASONING_PREFIX)) {
    try {
      return new TextDecoder().decode(Uint8Array.from(atob(sealed.slice(REASONING_PREFIX.length)), (char) => char.charCodeAt(0)));
    } catch {
      return undefined;
    }
  }
  if (sealed) return undefined;
  // Unsealed reasoning (a client that keeps the content parts): the reasoning text as written.
  if (Array.isArray(item.content)) {
    const text = item.content.filter(isObject).filter((part) => part.type === "reasoning_text").map((part) => str(part.text) ?? "").join("");
    if (text) return text;
  }
  return undefined;
}

/** `text` as REASONING_PREFIX + base64 of its UTF-8. */
export function sealReasoning(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return `${REASONING_PREFIX}${btoa(binary)}`;
}

/**
 * Input items → chat messages, in order. An assistant turn (its text, reasoning and tool calls,
 * which Responses lists as separate items) becomes one assistant message, followed by one `tool`
 * message per call output.
 */
function toMessages(
  input: unknown,
  options: ResponsesRequestOptions,
  tools: Map<string, ToolName>,
  addTools: (list: unknown) => void,
): { ok: true; messages: Json[] } | { ok: false; message: string; param?: string } {
  if (typeof input === "string") return { ok: true, messages: input ? [{ role: "user", content: input }] : [] };
  if (!Array.isArray(input)) return { ok: false, message: "input: send a string or a list of items.", param: "input" };
  const messages: Json[] = [];
  /** The assistant message being built from consecutive assistant items. */
  let assistant: { texts: string[]; calls: Json[]; reasoning: string[] } | undefined;
  let pendingReasoning: string[] = [];
  const flush = () => {
    if (!assistant) return;
    const reasoning = [...assistant.reasoning];
    if (assistant.texts.length > 0 || assistant.calls.length > 0) {
      messages.push({
        role: "assistant",
        content: assistant.texts.length > 0 ? assistant.texts.join("\n\n") : null,
        ...(assistant.calls.length > 0 ? { tool_calls: assistant.calls } : {}),
        ...(reasoning.length > 0 ? { reasoning_content: reasoning.join("\n\n") } : {}),
      });
    }
    assistant = undefined;
  };
  const open = () => {
    if (!assistant) {
      assistant = { texts: [], calls: [], reasoning: pendingReasoning };
      pendingReasoning = [];
    }
    return assistant;
  };
  for (const [index, raw] of input.entries()) {
    if (!isObject(raw)) continue;
    const item = raw;
    // An "easy" input message has a role and no type.
    const type = str(item.type) ?? (item.role !== undefined ? "message" : undefined);
    switch (type) {
      case "message": {
        const role = str(item.role);
        if (role === "assistant") {
          const { text } = contentParts(item.content, options);
          if (text) {
            // Text after tool calls starts a new assistant turn (their outputs come between).
            if (assistant && assistant.calls.length > 0) flush();
            open().texts.push(text);
          }
          break;
        }
        flush();
        if (role === "system" || role === "developer") {
          const { text } = contentParts(item.content, options);
          if (text) messages.push({ role: "system", content: text });
        } else if (role === "user") {
          const { text, parts } = contentParts(item.content, options);
          if (parts.length === 0) break;
          messages.push({ role: "user", content: parts.every((part) => part.type === "text") ? text : parts });
        } else {
          return { ok: false, message: `input[${index}].role must be "user", "assistant", "system" or "developer" (got ${JSON.stringify(role ?? null)}).`, param: `input[${index}].role` };
        }
        break;
      }
      case "reasoning": {
        const text = reasoningOf(item);
        if (!text) break;
        // Reasoning comes before the text and calls it led to.
        if (assistant && (assistant.texts.length > 0 || assistant.calls.length > 0)) flush();
        if (assistant) assistant.reasoning.push(text);
        else pendingReasoning.push(text);
        break;
      }
      case "function_call":
      case "custom_tool_call": {
        const name = str(item.name) ?? "";
        const namespace = str(item.namespace);
        const custom = type === "custom_tool_call";
        const chat = nameFor({ name, ...(namespace ? { namespace } : {}), ...(custom ? { custom: true } : {}) }, tools);
        const args = custom ? JSON.stringify({ input: str(item.input) ?? "" }) : (str(item.arguments) ?? "{}");
        open().calls.push({ id: str(item.call_id) ?? str(item.id) ?? "", type: "function", function: { name: chat, arguments: args } });
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        flush();
        messages.push({ role: "tool", tool_call_id: str(item.call_id) ?? "", content: outputText(item.output, options) });
        break;
      }
      case "additional_tools":
        addTools(item.tools);
        break;
      case "item_reference":
        return { ok: false, message: `input[${index}]: item_reference isn't supported: dl keeps no items. Send the item itself.`, param: `input[${index}]` };
      default:
        // Items no chat model can take (web search and image generation calls, server-side
        // compaction, tool search) and kinds this doesn't know yet are left out.
        break;
    }
  }
  flush();
  return { ok: true, messages };
}

// ─── Answers ────────────────────────────────────────────────────────────────

const hex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
export const responseId = () => `resp_${hex(16)}`;
const itemId = (prefix: string) => `${prefix}_${hex(12)}`;

export interface ResponsesUsage {
  input_tokens: number;
  input_tokens_details: { cached_tokens: number };
  output_tokens: number;
  output_tokens_details: { reasoning_tokens: number };
  total_tokens: number;
}

/** Chat usage → Responses usage: input_tokens includes the cached part, as OpenAI counts it. */
export function responsesUsage(usage: unknown): ResponsesUsage {
  const u = isObject(usage) ? usage : {};
  const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
  const input = n(u.prompt_tokens);
  const output = n(u.completion_tokens);
  const cached = Math.min(input, n(isObject(u.prompt_tokens_details) ? u.prompt_tokens_details.cached_tokens : undefined));
  const reasoning = Math.min(output, n(isObject(u.completion_tokens_details) ? u.completion_tokens_details.reasoning_tokens : undefined));
  return { input_tokens: input, input_tokens_details: { cached_tokens: cached }, output_tokens: output, output_tokens_details: { reasoning_tokens: reasoning }, total_tokens: n(u.total_tokens) || input + output };
}

export interface AnswerOptions {
  /** The model that answered (the plan's fallback when one served). */
  model: string;
  tools: ToolNames;
  echo: Json;
  /** When the request arrived, in seconds. */
  createdAt: number;
  /** The response's id; a new one unless given. */
  id?: string;
}

/** A finish reason → the response's status and why it is incomplete. */
function statusOf(finish: unknown): { status: "completed" | "incomplete"; incomplete_details: Json | null } {
  if (finish === "length") return { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
  if (finish === "content_filter") return { status: "incomplete", incomplete_details: { reason: "content_filter" } };
  return { status: "completed", incomplete_details: null };
}

/** The response object around `output`. */
export function responseObject(options: AnswerOptions & { id: string }, fields: { status: string; output: Json[]; usage: ResponsesUsage | null; error?: Json | null; incomplete_details?: Json | null }): Json {
  return {
    id: options.id,
    object: "response",
    created_at: options.createdAt,
    status: fields.status,
    background: false,
    error: fields.error ?? null,
    incomplete_details: fields.incomplete_details ?? null,
    model: options.model,
    output: fields.output,
    store: false,
    usage: fields.usage,
    ...options.echo,
  };
}

/** A tool call the model made → its output item (a function call, or a freeform tool's call). */
function callItem(call: { id: string; callId: string; name: string; arguments: string }, tools: ToolNames, status: "in_progress" | "completed"): Json {
  const tool = tools.get(call.name);
  if (tool?.custom) {
    return { type: "custom_tool_call", id: call.id, status, call_id: call.callId, name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}), input: status === "completed" ? customInput(call.arguments) : "" };
  }
  return { type: "function_call", id: call.id, status, call_id: call.callId, name: tool?.name ?? call.name, ...(tool?.namespace ? { namespace: tool.namespace } : {}), arguments: call.arguments };
}

/** A freeform tool's input from its chat arguments ({"input": "..."}); the raw text when the model didn't wrap it. */
function customInput(args: string): string {
  try {
    const parsed = JSON.parse(args) as unknown;
    if (isObject(parsed) && typeof parsed.input === "string") return parsed.input;
    if (typeof parsed === "string") return parsed;
  } catch {
    // not JSON: the model wrote the input itself
  }
  return args;
}

function reasoningItem(id: string, text: string): Json {
  return { type: "reasoning", id, summary: [], content: [{ type: "reasoning_text", text }], encrypted_content: sealReasoning(text) };
}

function messageItem(id: string, text: string, status: "in_progress" | "completed"): Json {
  return { type: "message", id, status, role: "assistant", content: status === "completed" ? [{ type: "output_text", text, annotations: [] }] : [] };
}

/** A chat completion → a Responses `response`. */
export function toResponse(completion: Json, options: AnswerOptions): Json {
  const choice = Array.isArray(completion.choices) && isObject(completion.choices[0]) ? completion.choices[0] : undefined;
  const message = isObject(choice?.message) ? choice.message : {};
  const output: Json[] = [];
  const reasoning = str(message.reasoning_content) ?? str(message.reasoning);
  if (reasoning) output.push(reasoningItem(itemId("rs"), reasoning));
  const text = str(message.content);
  if (text) output.push(messageItem(itemId("msg"), text, "completed"));
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls.filter(isObject) : [];
  for (const call of calls) {
    const fn = isObject(call.function) ? call.function : {};
    output.push(callItem({ id: itemId("fc"), callId: str(call.id) || itemId("call"), name: str(fn.name) ?? "", arguments: str(fn.arguments) ?? (isObject(fn.arguments) ? JSON.stringify(fn.arguments) : "{}") }, options.tools, "completed"));
  }
  const { status, incomplete_details } = statusOf(choice?.finish_reason);
  return responseObject({ ...options, id: options.id ?? responseId() }, { status, output, usage: responsesUsage(completion.usage), incomplete_details });
}

/** One server-sent event: the event name is the data's `type`, as OpenAI sends them. */
function sse(data: Json): string {
  return `event: ${data.type as string}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The error a failed response carries. */
export interface ResponsesFailure {
  code: string;
  message: string;
  /** Seconds to wait before retrying, when known. */
  retryAfter?: number;
  /** Our own refusal code, beside the one clients act on. */
  dlCode?: string;
  extra?: Json;
}

function failureError(failure: ResponsesFailure): Json {
  return {
    code: failure.code,
    message: failure.message,
    ...(failure.dlCode && failure.dlCode !== failure.code ? { dl_code: failure.dlCode } : {}),
    // Codex reads a server's retry delay from here (or from "try again in Ns" in the message).
    ...(failure.retryAfter !== undefined ? { headers: { "retry-after": String(failure.retryAfter) } } : {}),
    ...failure.extra,
  };
}

/** A refusal as a whole stream: response.created, then response.failed. */
export function failedStream(failure: ResponsesFailure, options: AnswerOptions): string {
  const id = options.id ?? responseId();
  const base = { ...options, id };
  return (
    sse({ type: "response.created", sequence_number: 0, response: responseObject(base, { status: "in_progress", output: [], usage: null }) }) +
    sse({ type: "response.failed", sequence_number: 1, response: responseObject(base, { status: "failed", output: [], usage: null, error: failureError(failure) }) })
  );
}

/** A whole response (an upstream that didn't stream) as its event sequence. */
export function responseAsStream(response: Json): string {
  const lines: string[] = [];
  let seq = 0;
  const send = (data: Json) => lines.push(sse({ ...data, sequence_number: seq++ }));
  const output = Array.isArray(response.output) ? (response.output as Json[]) : [];
  send({ type: "response.created", response: { ...response, status: "in_progress", output: [], usage: null } });
  send({ type: "response.in_progress", response: { ...response, status: "in_progress", output: [], usage: null } });
  output.forEach((item, index) => {
    const id = item.id as string;
    if (item.type === "message") {
      const text = ((item.content as Json[])[0]?.text as string) ?? "";
      send({ type: "response.output_item.added", output_index: index, item: { ...item, status: "in_progress", content: [] } });
      send({ type: "response.content_part.added", item_id: id, output_index: index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      send({ type: "response.output_text.delta", item_id: id, output_index: index, content_index: 0, delta: text, logprobs: [] });
      send({ type: "response.output_text.done", item_id: id, output_index: index, content_index: 0, text, logprobs: [] });
      send({ type: "response.content_part.done", item_id: id, output_index: index, content_index: 0, part: { type: "output_text", text, annotations: [] } });
    } else if (item.type === "reasoning") {
      const text = ((item.content as Json[])[0]?.text as string) ?? "";
      send({ type: "response.output_item.added", output_index: index, item: { type: "reasoning", id, summary: [] } });
      send({ type: "response.reasoning_text.delta", item_id: id, output_index: index, content_index: 0, delta: text });
      send({ type: "response.reasoning_text.done", item_id: id, output_index: index, content_index: 0, text });
    } else if (item.type === "function_call") {
      send({ type: "response.output_item.added", output_index: index, item: { ...item, status: "in_progress", arguments: "" } });
      send({ type: "response.function_call_arguments.delta", item_id: id, output_index: index, delta: item.arguments });
      send({ type: "response.function_call_arguments.done", item_id: id, output_index: index, name: item.name, arguments: item.arguments });
    } else {
      send({ type: "response.output_item.added", output_index: index, item: { ...item, status: "in_progress", input: "" } });
      send({ type: "response.custom_tool_call_input.delta", item_id: id, output_index: index, delta: item.input });
      send({ type: "response.custom_tool_call_input.done", item_id: id, output_index: index, input: item.input });
    }
    send({ type: "response.output_item.done", output_index: index, item });
  });
  send({ type: response.status === "incomplete" ? "response.incomplete" : "response.completed", response });
  return lines.join("");
}

/**
 * A chat completions event stream → the Responses event sequence Codex reads:
 * `response.created`, `response.in_progress`, then per output item `response.output_item.added`,
 * its deltas (`response.reasoning_text.delta`; `response.content_part.added`,
 * `response.output_text.delta`, `.done`, `response.content_part.done`;
 * `response.function_call_arguments.delta` and `.done`; a freeform tool's
 * `response.custom_tool_call_input.delta` and `.done`) and `response.output_item.done`, then
 * `response.completed` with usage (cached tokens included), or `response.incomplete` at the
 * output limit. A stream that fails part way ends with `response.failed`.
 */
export function toResponsesStream(upstream: ReadableStream<Uint8Array>, options: AnswerOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const id = options.id ?? responseId();
  const base = { ...options, id };
  let buffer = "";
  let seq = 0;
  let started = false;
  let finished = false;
  let finish: unknown;
  let usage: ResponsesUsage | undefined;
  let failure: string | undefined;
  const output: Json[] = [];
  type Open =
    | { kind: "reasoning"; id: string; index: number; text: string }
    | { kind: "text"; id: string; index: number; text: string }
    | { kind: "call"; id: string; index: number; position: number; callId: string; name: string; arguments: string };
  let open: Open | undefined;
  const seen = new Set<number>();

  const send = (out: string[], data: Json) => out.push(sse({ ...data, sequence_number: seq++ }));
  const start = (out: string[]) => {
    if (started) return;
    started = true;
    const response = responseObject(base, { status: "in_progress", output: [], usage: null });
    send(out, { type: "response.created", response });
    send(out, { type: "response.in_progress", response });
  };
  const close = (out: string[]) => {
    if (!open) return;
    const current = open;
    open = undefined;
    let item: Json;
    if (current.kind === "reasoning") {
      send(out, { type: "response.reasoning_text.done", item_id: current.id, output_index: current.index, content_index: 0, text: current.text });
      item = reasoningItem(current.id, current.text);
    } else if (current.kind === "text") {
      send(out, { type: "response.output_text.done", item_id: current.id, output_index: current.index, content_index: 0, text: current.text, logprobs: [] });
      send(out, { type: "response.content_part.done", item_id: current.id, output_index: current.index, content_index: 0, part: { type: "output_text", text: current.text, annotations: [] } });
      item = messageItem(current.id, current.text, "completed");
    } else {
      item = callItem({ id: current.id, callId: current.callId, name: current.name, arguments: current.arguments || "{}" }, options.tools, "completed");
      if (item.type === "custom_tool_call") {
        send(out, { type: "response.custom_tool_call_input.delta", item_id: current.id, output_index: current.index, delta: item.input });
        send(out, { type: "response.custom_tool_call_input.done", item_id: current.id, output_index: current.index, input: item.input });
      } else {
        send(out, { type: "response.function_call_arguments.done", item_id: current.id, output_index: current.index, name: item.name, arguments: item.arguments });
      }
    }
    output.push(item);
    send(out, { type: "response.output_item.done", output_index: current.index, item });
  };

  const handle = (chunk: Json, out: string[]) => {
    if (isObject(chunk.error)) {
      failure = str(chunk.error.message) ?? "The model provider failed the request.";
      return;
    }
    if (chunk.usage) usage = responsesUsage(chunk.usage);
    const choice = Array.isArray(chunk.choices) && isObject(chunk.choices[0]) ? chunk.choices[0] : undefined;
    if (!choice) return;
    start(out);
    const d = isObject(choice.delta) ? choice.delta : {};
    const reasoning = str(d.reasoning_content) ?? str(d.reasoning);
    if (reasoning) {
      if (open?.kind !== "reasoning") {
        close(out);
        open = { kind: "reasoning", id: itemId("rs"), index: output.length, text: "" };
        send(out, { type: "response.output_item.added", output_index: open.index, item: { type: "reasoning", id: open.id, summary: [] } });
      }
      open.text += reasoning;
      send(out, { type: "response.reasoning_text.delta", item_id: open.id, output_index: open.index, content_index: 0, delta: reasoning });
    }
    const text = str(d.content);
    if (text) {
      if (open?.kind !== "text") {
        close(out);
        open = { kind: "text", id: itemId("msg"), index: output.length, text: "" };
        send(out, { type: "response.output_item.added", output_index: open.index, item: messageItem(open.id, "", "in_progress") });
        send(out, { type: "response.content_part.added", item_id: open.id, output_index: open.index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      }
      open.text += text;
      send(out, { type: "response.output_text.delta", item_id: open.id, output_index: open.index, content_index: 0, delta: text, logprobs: [] });
    }
    if (Array.isArray(d.tool_calls)) {
      for (const call of d.tool_calls) {
        if (!isObject(call)) continue;
        const position = typeof call.index === "number" ? call.index : 0;
        const fn = isObject(call.function) ? call.function : {};
        if (!seen.has(position)) {
          seen.add(position);
          close(out);
          open = { kind: "call", id: itemId("fc"), index: output.length, position, callId: str(call.id) || itemId("call"), name: str(fn.name) ?? "", arguments: "" };
          send(out, { type: "response.output_item.added", output_index: open.index, item: callItem(open, options.tools, "in_progress") });
        } else if (open?.kind !== "call" || open.position !== position) {
          // Out of order: an earlier call's item is closed. Never seen from real servers.
          continue;
        }
        const args = str(fn.arguments);
        if (args) {
          open.arguments += args;
          if (!options.tools.get(open.name)?.custom) send(out, { type: "response.function_call_arguments.delta", item_id: open.id, output_index: open.index, delta: args });
        }
      }
    }
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) finish = choice.finish_reason;
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
    start(out);
    if (failure !== undefined || (!finished && finish === undefined)) {
      // A cut-off answer: what was sent is dropped and the client retries the request.
      open = undefined;
      const error = failureError({ code: "server_error", message: failure ?? "The model provider's answer ended early. Try again." });
      send(out, { type: "response.failed", response: responseObject(base, { status: "failed", output, usage: usage ?? null, error }) });
      return out;
    }
    close(out);
    const { status, incomplete_details } = statusOf(finish);
    const response = responseObject(base, { status, output, usage: usage ?? responsesUsage(undefined), incomplete_details });
    send(out, { type: status === "incomplete" ? "response.incomplete" : "response.completed", response });
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
          controller.enqueue(encoder.encode([...scan(true), ...end()].join("")));
          controller.close();
          return;
        }
        if (result.done) {
          buffer += decoder.decode();
          controller.enqueue(encoder.encode([...scan(true), ...end()].join("")));
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

// ─── Errors ─────────────────────────────────────────────────────────────────

/** OpenAI's error type for an HTTP status. */
export function errorType(status: number): string {
  if (status === 400 || status === 404 || status === 413) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 402) return "insufficient_quota";
  if (status === 403) return "permission_error";
  if (status === 429) return "rate_limit_error";
  return "server_error";
}

/** `{error: {message, type, code, param}}`, OpenAI's error body, with our details beside them. */
export function responsesError(status: number, message: string, code?: string, extra: Json = {}, param: string | null = null): Json {
  return { error: { message, type: errorType(status), code: code ?? null, param, ...extra } };
}

/**
 * A refusal from `chat` as a failed response in a stream, for clients that stream (Codex always
 * does). The `code` picks what Codex does with it, from its Responses client: transient refusals
 * (`retryable`, a 429, a 5xx) are retried, with the server's delay; a conversation too long for
 * the model is `context_length_exceeded` (Codex compacts or says so); a content policy refusal is
 * `content_policy_violation`; any other refusal (a used-up allowance, a model the plan doesn't
 * have, a blocked account) is `invalid_prompt`, the one code Codex shows the message of and doesn't
 * retry (with any other it retries five times and the message only shows at the end). Our own
 * code goes along as `dl_code`.
 */
export function streamFailure(status: number, error: { code?: string; message: string; retryable?: boolean }, retryAfter?: number): ResponsesFailure {
  const dlCode = error.code;
  const transient = error.retryable === true || status === 429 || status >= 500;
  let code: string;
  if (/context window/i.test(error.message)) code = "context_length_exceeded";
  else if (/content policy/i.test(error.message)) code = "content_policy_violation";
  else if (transient) code = status === 429 ? "rate_limit_exceeded" : "server_error";
  else code = "invalid_prompt";
  return { code, message: error.message, ...(dlCode ? { dlCode } : {}), ...(transient && retryAfter !== undefined ? { retryAfter } : {}) };
}
