/**
 * Degenerate output from an upstream: a model that streams its own special tokens
 * (`<|place_holder_mm_span_0442|>` over and over, seen live from Open Relay's DeepSeek V4.1 Flash
 * on 27 Nov 2026 for tens of thousands of tokens with no tool call) or one short piece of text
 * repeated without end. Such a turn never finishes usefully: the agent sits on "Reasoning…" while
 * the person's allowance and our credit pay for junk.
 *
 * `guardStream` reads the head of a stream before anything reaches the client, so a stream that
 * starts degenerate can be dropped and the turn retried on the next upstream; past the head it
 * keeps watching and cuts the stream with an error the moment it degenerates. Only counts and the
 * reason leave this module, never the text.
 */

import { outputText } from "./sse.js";

export type DegenerateReason = "special_tokens" | "repetition";

export interface DegenerateInfo {
  reason: DegenerateReason;
  /** Characters of output (text, reasoning, tool calls) the upstream had sent when it was caught. */
  outputChars: number;
}

/**
 * A model's control token as text: `<|…|>`, or DeepSeek's full-width `<｜…｜>`. Legitimate output
 * can mention one (a chat template, a tokenizer test), so one alone never counts: see `degenerate`.
 */
const SPECIAL_TOKEN = /<[|｜][^|｜<>\s]{1,64}[|｜]>/g;
/** How much recent output is judged at once. */
const WINDOW = 4096;
/** Special tokens in the window, and their share of it, that make it junk rather than a mention. */
const MIN_SPECIAL_TOKENS = 8;
const MIN_SPECIAL_SHARE = 0.5;
/** A run this long of one piece of text (up to MAX_PERIOD characters) repeated is junk. */
const REPEAT_RUN = 2048;
const MAX_PERIOD = 64;
/**
 * Output read before the first byte goes to the client. Junk shows from the first token in every
 * case seen (8 special tokens is about 230 characters), so 512 catches it while delaying a good
 * stream's first visible text by only a fraction of a second.
 */
export const HEAD_CHARS = 512;
/** A head with this many bytes and still too little output (only empty chunks) is let through as it is. */
const HEAD_MAX_BYTES = 256 * 1024;
/**
 * The longest the head is held back: a model that thinks quietly before its first token (or an
 * upstream that goes silent) still gets its response to the client, which can then give up and
 * cancel; that stream is watched as it passes instead (no retry, but cut on junk).
 */
export const HEAD_WAIT_MS = 3_000;

/** Why `text` (recent output) is degenerate, or undefined when it isn't. */
export function degenerate(text: string): DegenerateReason | undefined {
  const window = text.length > WINDOW ? text.slice(-WINDOW) : text;
  let count = 0;
  let chars = 0;
  for (const match of window.matchAll(SPECIAL_TOKEN)) {
    count += 1;
    chars += match[0].length;
  }
  if (count >= MIN_SPECIAL_TOKENS && chars >= window.length * MIN_SPECIAL_SHARE) return "special_tokens";
  if (window.length >= REPEAT_RUN && repeats(window.slice(-REPEAT_RUN))) return "repetition";
  return undefined;
}

/** Whether `run` is one piece of at most MAX_PERIOD characters repeated. */
function repeats(run: string): boolean {
  for (let period = 1; period <= MAX_PERIOD; period += 1) {
    let same = true;
    for (let index = period; index < run.length; index += 1) {
      if (run.charCodeAt(index) !== run.charCodeAt(index - period)) {
        same = false;
        break;
      }
    }
    if (same) return true;
  }
  return false;
}

/** Recent output of one stream, judged as it grows. */
export class DegenerateWatch {
  #tail = "";
  #chars = 0;
  #caught: DegenerateInfo | undefined;

  /** Adds output; the verdict once it is degenerate (and from then on). */
  push(text: string): DegenerateInfo | undefined {
    if (this.#caught || text.length === 0) return this.#caught;
    this.#chars += text.length;
    this.#tail = (this.#tail + text).slice(-WINDOW);
    const reason = degenerate(this.#tail);
    if (reason) this.#caught = { reason, outputChars: this.#chars };
    return this.#caught;
  }

  get chars(): number {
    return this.#chars;
  }
}

/** Reads SSE `data:` lines out of byte chunks and hands each chunk's output text to `onText`. */
class SseText {
  #decoder = new TextDecoder();
  #buffer = "";
  /** The stream said it is finished: a finish reason, usage, or `[DONE]`. */
  finished = false;

  constructor(private readonly onText: (text: string) => void) {}

  push(bytes: Uint8Array | undefined): void {
    this.#buffer += bytes ? this.#decoder.decode(bytes, { stream: true }) : this.#decoder.decode();
    const lines = this.#buffer.split("\n");
    this.#buffer = bytes ? (lines.pop() ?? "") : "";
    // A line this long without a newline isn't SSE worth reading; drop it rather than grow.
    if (this.#buffer.length > HEAD_MAX_BYTES * 4) this.#buffer = "";
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        this.finished = true;
        continue;
      }
      if (!data) continue;
      let parsed: { choices?: Array<{ finish_reason?: unknown }>; usage?: unknown } | undefined;
      try {
        parsed = JSON.parse(data) as typeof parsed;
      } catch {
        continue;
      }
      const text = outputText(parsed);
      if (text) this.onText(text);
      if (parsed?.usage || parsed?.choices?.some((choice) => typeof choice?.finish_reason === "string")) this.finished = true;
    }
  }
}

/** The SSE event a cut stream ends with: an OpenAI-style error, then `[DONE]`. */
export const DEGENERATE_ERROR_MESSAGE = "The model started repeating junk instead of answering, so the response was stopped and not charged. Try again.";
const cutEvent = (): Uint8Array =>
  new TextEncoder().encode(`data: ${JSON.stringify({ error: { message: DEGENERATE_ERROR_MESSAGE, type: "upstream_error", code: "degenerate_stream" } })}\n\ndata: [DONE]\n\n`);

export type GuardResult = { degenerate: DegenerateInfo } | { stream: ReadableStream<Uint8Array> };

/**
 * Reads the head of `body` (HEAD_CHARS of output, or the stream's end or finish, whichever is
 * first). A degenerate head is cancelled and returned as `{ degenerate }`, with nothing sent on;
 * otherwise `{ stream }` replays the head and passes the rest through, and if it degenerates
 * later it calls `onDegenerate`, cancels the upstream and ends with an error event and `[DONE]`.
 */
export async function guardStream(body: ReadableStream<Uint8Array>, options: { onDegenerate: (info: DegenerateInfo) => void; headChars?: number; headWaitMs?: number }): Promise<GuardResult> {
  const headChars = options.headChars ?? HEAD_CHARS;
  const headWaitMs = options.headWaitMs ?? HEAD_WAIT_MS;
  const reader = body.getReader();
  const watch = new DegenerateWatch();
  let caught: DegenerateInfo | undefined;
  const sse = new SseText((text) => {
    caught = watch.push(text);
  });

  const head: Uint8Array[] = [];
  let headBytes = 0;
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"wait">((resolve) => {
    timer = setTimeout(() => resolve("wait"), headWaitMs);
  });
  const guard = { sse, onCaught: () => caught, onDegenerate: options.onDegenerate };
  try {
    while (!caught && !sse.finished && watch.chars < headChars && headBytes < HEAD_MAX_BYTES) {
      const pending = reader.read();
      let result: ReadableStreamReadResult<Uint8Array> | "wait";
      try {
        result = await Promise.race([pending, deadline]);
      } catch (error) {
        // A failed read in the head: replay what came and let the failure surface as before.
        return { stream: replay(head, reader, undefined, { failure: error }) };
      }
      // Too slow to judge before answering: the read still under way is the stream's next chunk.
      if (result === "wait") return { stream: replay(head, reader, guard, { pending }) };
      if (result.done) {
        sse.push(undefined);
        ended = true;
        break;
      }
      head.push(result.value);
      headBytes += result.value.byteLength;
      sse.push(result.value);
    }
  } finally {
    clearTimeout(timer);
  }
  if (caught) {
    await reader.cancel("degenerate").catch(() => undefined);
    return { degenerate: caught };
  }
  if (ended) return { stream: replay(head, reader, undefined) };
  return { stream: replay(head, reader, guard) };
}

/** `head` again, then the rest of `reader`, watched by `guard` when given. */
function replay(
  head: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
  guard: { sse: SseText; onCaught: () => DegenerateInfo | undefined; onDegenerate: (info: DegenerateInfo) => void } | undefined,
  options: { failure?: unknown; pending?: Promise<ReadableStreamReadResult<Uint8Array>> } = {},
): ReadableStream<Uint8Array> {
  let index = 0;
  let cut = false;
  const { failure } = options;
  let pending = options.pending;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (index < head.length) {
          controller.enqueue(head[index]!);
          index += 1;
          return;
        }
        if (failure !== undefined) {
          controller.error(failure);
          return;
        }
        if (cut) {
          controller.close();
          return;
        }
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          const next = pending ?? reader.read();
          pending = undefined;
          result = await next;
        } catch (error) {
          controller.error(error);
          return;
        }
        if (result.done) {
          controller.close();
          return;
        }
        if (guard) {
          guard.sse.push(result.value);
          const caught = guard.onCaught();
          if (caught) {
            // The junk chunk itself isn't passed on: the client gets the error instead.
            cut = true;
            guard.onDegenerate(caught);
            await reader.cancel("degenerate").catch(() => undefined);
            controller.enqueue(cutEvent());
            return;
          }
        }
        controller.enqueue(result.value);
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => undefined);
      },
    },
    { highWaterMark: 0 },
  );
}

/** One structured count of a degenerate stream, by upstream, for Workers logs (`free.degenerate_stream`). */
export function logDegenerate(input: { upstream: string; model: string; stage: "head" | "stream" | "response"; info: DegenerateInfo; retried: boolean }): void {
  console.error(
    JSON.stringify({
      event: "free.degenerate_stream",
      upstream: input.upstream,
      model: input.model,
      stage: input.stage,
      reason: input.info.reason,
      outputChars: input.info.outputChars,
      retried: input.retried,
    }),
  );
}
