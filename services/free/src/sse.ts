import { parseUsage, type Usage } from "./quota.js";
import { hostOf } from "./routing.js";

/**
 * Passes an OpenRouter server-sent-event stream through unchanged while reading the `usage`
 * object it sends in its last chunk. `onEnd` runs exactly once, before the stream closes, when
 * the upstream ends, fails, or the client goes away, so the reservation is always settled
 * while the request is still alive, with no work deferred past the response. The content is never kept: only the
 * usage counts, the host's name and whether the stream failed leave this function.
 */

export interface StreamOutcome {
  usage: Usage | undefined;
  /** The stream carried an `error` object, failed, or was cancelled before it finished. */
  errored: boolean;
  /**
   * The upstream's fault: an `error` object, a failed read, or an end without `[DONE]`. A
   * client going away is not.
   */
  upstreamFailed: boolean;
  /** The host that served the stream (its chunks' `provider` field), as a slug. */
  host: string | undefined;
  /** When the first chunk with content (text, reasoning or a tool call) passed, by `now`; undefined if none did. */
  firstContentAt: number | undefined;
  /** Whether any content reached the client. */
  contentSent: boolean;
}

/** Whether a stream chunk carries content: text, reasoning or a tool call in any choice's delta. */
export function hasContent(parsed: unknown): boolean {
  const choices = (parsed as { choices?: unknown } | null)?.choices;
  if (!Array.isArray(choices)) return false;
  return choices.some((choice) => {
    const delta = (choice as { delta?: Record<string, unknown> } | null)?.delta;
    if (!delta || typeof delta !== "object") return false;
    const text = (key: string) => typeof delta[key] === "string" && (delta[key] as string).length > 0;
    return text("content") || text("reasoning") || text("reasoning_content") || (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0);
  });
}

const MAX_LINE_BUFFER = 4 * 1024 * 1024;

export function meterStream(body: ReadableStream<Uint8Array>, onEnd: (outcome: StreamOutcome) => Promise<void>, now: () => number = () => Date.now()): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: Usage | undefined;
  let errored = false;
  let upstreamFailed = false;
  let done = false;
  let host: string | undefined;
  let firstContentAt: number | undefined;
  let ended = false;

  const scan = (final: boolean) => {
    const lines = buffer.split("\n");
    buffer = final ? "" : (lines.pop() ?? "");
    if (buffer.length > MAX_LINE_BUFFER) buffer = "";
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") done = true;
      if (!data || data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data) as { usage?: unknown; error?: unknown };
        const found = parseUsage(parsed.usage);
        if (found) usage = found;
        host ??= hostOf(parsed);
        if (firstContentAt === undefined && hasContent(parsed)) firstContentAt = now();
        if (parsed.error) {
          errored = true;
          upstreamFailed = true;
        }
      } catch {
        // A partial or non-JSON data line carries no usage.
      }
    }
  };

  const finish = async () => {
    if (ended) return;
    ended = true;
    await onEnd({ usage, errored, upstreamFailed, host, firstContentAt, contentSent: firstContentAt !== undefined });
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        errored = true;
        upstreamFailed = true;
        await finish();
        controller.error(error);
        return;
      }
      if (result.done) {
        buffer += decoder.decode();
        scan(true);
        if (!done) upstreamFailed = true;
        await finish();
        controller.close();
        return;
      }
      controller.enqueue(result.value);
      buffer += decoder.decode(result.value, { stream: true });
      scan(false);
    },
    async cancel(reason) {
      errored = true;
      await finish();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}
