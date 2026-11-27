/**
 * What a client is told when a model provider refuses a request (a 4xx other than 429, or a 5xx
 * that ran out of retries). Providers' own messages often quote the request (a tool schema, a
 * prompt excerpt) or internal account and policy text, so they are never passed on: known
 * failures get dl's own message, anything else a generic one, and at most a short, sanitised
 * reason (the provider's error code or type when it is a plain identifier) beside it.
 */

export interface UpstreamRefusal {
  message: string;
  /** The provider's error code or type, when it is a plain identifier (letters, digits, `_.-`, at most 64). */
  reason?: string;
}

/**
 * Anything unknown. The commonest unknown refusal is a conversation a client broke after an
 * interrupted step (a tool call answered twice, or not at all): the client resends it with every
 * message, so every message fails until the person starts over or updates (tool-history.ts
 * repairs the shapes known so far before any upstream sees them).
 */
export const GENERIC =
  "The model provider refused the request. If every message in this conversation now fails, it may have got into a bad state after an interrupted step: start a new conversation (/clear in Autopilot), or update with `dl update`.";

/** Known failures, by what the provider's message, code or type says: the first that matches wins. */
const KNOWN: ReadonlyArray<{ test: RegExp; message: string }> = [
  {
    test: /context[_ ]length|context[_ ]window|maximum context|too many tokens|prompt is too long|input is too long|reduce the length/i,
    message: "The model provider refused the request: the conversation is longer than the model's context window. Compact it or start a new one.",
  },
  {
    test: /max[_ ](output[_ ])?tokens|max_completion_tokens/i,
    message: "The model provider refused the request's output limit (max_tokens). Try a smaller one.",
  },
  {
    test: /content[_ ]policy|content[_ ]filter|safety(?!_identifier)|moderation|flagged|prohibited/i,
    message: "The model provider's content policy refused the request.",
  },
  {
    test: /\bimages?\b|image_url|vision|multimodal|unsupported (file|media)/i,
    message: "The model provider refused an image or file in the request: this model can't read it.",
  },
  {
    test: /\btools?\b|tool_calls?|tool_choice|function[_ ]call|function[_ ]name|schema for function|json schema|input_schema/i,
    message: "The model provider refused the request's tools or tool calls (a schema or a call it couldn't read).",
  },
];

/** The provider's code or type, when it is a plain identifier; never free text. */
function identifier(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  return /^[A-Za-z0-9_.-]{1,64}$/.test(text) ? text : undefined;
}

/** dl's own message for a provider's refusal body (JSON or not), and a sanitised reason. */
export function upstreamRefusal(text: string): UpstreamRefusal {
  let error: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (parsed && typeof parsed.error === "object" && parsed.error !== null) error = parsed.error as Record<string, unknown>;
    else if (typeof parsed.error === "string") error = { message: parsed.error };
  } catch {
    // not JSON: nothing from it is passed on
  }
  const reason = identifier(error?.code) ?? identifier(error?.type);
  // Matched on the provider's text, but only dl's own message goes out.
  const said = [typeof error?.message === "string" ? error.message : "", reason ?? ""].join(" ");
  const known = said.trim() ? KNOWN.find((entry) => entry.test.test(said)) : undefined;
  return { message: known?.message ?? GENERIC, ...(reason ? { reason } : {}) };
}
