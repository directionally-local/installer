/**
 * Makes a chat completions message history valid again where a client left it broken after an
 * interrupted tool call, before it goes to any upstream. Strict upstreams (Open Relay) refuse such
 * a history with an opaque 400 ("the request was rejected by the model"), and since the client
 * resends the same history every time, every later request in that conversation fails too.
 *
 * Seen live (26 Nov 2026): a turn stopped mid-tool-call got a "(stopped)" result from the client,
 * then the tool's own late result was recorded too, so one call had two results. The shapes fixed:
 * - a tool call with no result before the next non-tool message: a "(stopped)" result is added;
 * - a second result for a call already answered: dropped (the first one stays);
 * - a tool result that answers no call of the assistant message right before it (e.g. a late
 *   result after the next user message): dropped.
 * A valid history comes back unchanged (the same array). Only the order and presence of tool
 * results change, never their text, and never any other message.
 */

/** The result the client itself gives a call that was stopped (Autopilot's `STOPPED_TOOL_RESULT`). */
export const STOPPED_TOOL_RESULT = "(stopped)";

export interface ToolHistoryRepair {
  messages: unknown[];
  /** Results added for calls left without one. */
  added: number;
  /** Duplicate or orphaned tool results dropped. */
  dropped: number;
}

type Message = Record<string, unknown>;

const isMessage = (value: unknown): value is Message => typeof value === "object" && value !== null && !Array.isArray(value);

/** The ids and names of an assistant message's tool calls, in order; empty for anything else. */
function callsOf(message: unknown): Array<{ id: string; name: string | undefined }> {
  if (!isMessage(message) || message.role !== "assistant" || !Array.isArray(message.tool_calls)) return [];
  const calls: Array<{ id: string; name: string | undefined }> = [];
  for (const call of message.tool_calls) {
    if (!isMessage(call) || typeof call.id !== "string" || !call.id) continue;
    const fn = isMessage(call.function) ? call.function : undefined;
    calls.push({ id: call.id, name: typeof fn?.name === "string" ? fn.name : undefined });
  }
  return calls;
}

const isToolResult = (message: unknown): message is Message => isMessage(message) && message.role === "tool";

/** `messages` with every tool call answered exactly once, right after its assistant message. */
export function repairToolHistory(messages: unknown[]): ToolHistoryRepair {
  const out: unknown[] = [];
  let added = 0;
  let dropped = 0;
  let i = 0;
  while (i < messages.length) {
    const message = messages[i];
    if (isToolResult(message)) {
      // A tool result with no assistant tool calls right before it (its block ended already).
      dropped++;
      i++;
      continue;
    }
    out.push(message);
    i++;
    const calls = callsOf(message);
    if (calls.length === 0) continue;
    const pending = new Map(calls.map((call) => [call.id, call.name]));
    while (i < messages.length && isToolResult(messages[i])) {
      const result = messages[i] as Message;
      const id = typeof result.tool_call_id === "string" ? result.tool_call_id : undefined;
      if (id !== undefined && pending.has(id)) {
        out.push(result);
        pending.delete(id);
      } else {
        dropped++;
      }
      i++;
    }
    for (const [id, name] of pending) {
      out.push({ role: "tool", tool_call_id: id, content: STOPPED_TOOL_RESULT, ...(name ? { name } : {}) });
      added++;
    }
  }
  return added === 0 && dropped === 0 ? { messages, added, dropped } : { messages: out, added, dropped };
}
