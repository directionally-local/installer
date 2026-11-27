/**
 * What an upstream says about itself never reaches a client: its cost, price, credit or charge
 * (OpenRouter's `usage.cost` and `cost_details`, Open Relay's `openrelay.cost_nano_usd`, Liquid's
 * `exchange` block, any `cost` block), the host that served the request (OpenRouter's `provider`,
 * an error's `metadata`), and headers about any of it. The service reads all of that before this
 * runs (sse.ts meterStream, the non-streamed settle) and keeps it in its own records; the client
 * gets the answer, the `model` and the standard `usage` token counts, which agents rely on.
 */

/** Top-level fields of a completion or chunk that are the upstream's own, removed whole. */
const UPSTREAM_FIELDS = new Set(["cost", "openrelay", "exchange", "provider"]);

/** A field name about money: removed at the top level and anywhere in `usage`. */
const MONEY_KEY = /cost|price|credit|charge|billing|usd|byok/i;

/** A response header about money or the upstream; dl's own `x-dl-*` headers stay. */
const UPSTREAM_HEADER = /cost|price|credit|charge|billing|openrelay|openrouter|exchange|upstream|provider/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** `value` without money fields at any depth; whether any were removed. */
function withoutMoney(value: Record<string, unknown>): boolean {
  let changed = false;
  for (const key of Object.keys(value)) {
    if (MONEY_KEY.test(key)) {
      delete value[key];
      changed = true;
    } else if (isObject(value[key]) && withoutMoney(value[key] as Record<string, unknown>)) {
      changed = true;
    }
  }
  return changed;
}

/**
 * Removes the upstream's own fields from a parsed completion, chunk or error body, in place.
 * True when anything was removed.
 */
export function scrubUpstream(parsed: unknown): boolean {
  if (!isObject(parsed)) return false;
  let changed = false;
  for (const key of Object.keys(parsed)) {
    if (UPSTREAM_FIELDS.has(key) || MONEY_KEY.test(key)) {
      delete parsed[key];
      changed = true;
    }
  }
  if (isObject(parsed.usage) && withoutMoney(parsed.usage)) changed = true;
  // An upstream's error in a stream or a 200 body: OpenRouter's `metadata` names the host and
  // carries its raw answer. dl's own refusals keep their fields: a plan's price is dl's, and
  // `provider` there is the limit's name (provider_limit), which Autopilot reads.
  if (isObject(parsed.error)) {
    for (const key of ["metadata", "cost", "openrelay", "exchange"]) {
      if (key in parsed.error) {
        delete parsed.error[key];
        changed = true;
      }
    }
  }
  return changed;
}

/** One SSE line with the upstream's fields removed from its `data:` JSON; other lines as they are. */
function scrubLine(line: string): string {
  if (!line.startsWith("data:")) return line;
  const data = line.slice(5).trim();
  if (!data || data === "[DONE]" || data[0] !== "{") return line;
  try {
    const parsed = JSON.parse(data) as unknown;
    return scrubUpstream(parsed) ? `data: ${JSON.stringify(parsed)}${line.endsWith("\r") ? "\r" : ""}` : line;
  } catch {
    return line;
  }
}

/**
 * A server-sent-event stream with every event's upstream fields removed. Whole lines pass on as
 * they complete; it reads from upstream only as the client reads (highWaterMark 0).
 */
export function scrubStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        for (;;) {
          const result = await reader.read();
          if (result.done) {
            buffer += decoder.decode();
            if (buffer) controller.enqueue(encoder.encode(scrubLine(buffer)));
            buffer = "";
            controller.close();
            return;
          }
          buffer += decoder.decode(result.value, { stream: true });
          const end = buffer.lastIndexOf("\n");
          if (end === -1) continue;
          const lines = buffer.slice(0, end).split("\n");
          buffer = buffer.slice(end + 1);
          controller.enqueue(encoder.encode(`${lines.map(scrubLine).join("\n")}\n`));
          return;
        }
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => undefined);
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * A chat answer as a client may see it: streamed or not, success or error, without the upstream's
 * cost, price, credit or host, and without headers about them. Anything else passes unchanged.
 */
export async function clientReply(response: Response): Promise<Response> {
  const headers = new Headers();
  for (const [name, value] of response.headers) if (name.startsWith("x-dl-") || !UPSTREAM_HEADER.test(name)) headers.set(name, value);
  const type = response.headers.get("content-type") ?? "";
  if (response.body && type.includes("text/event-stream")) {
    headers.delete("content-length");
    return new Response(scrubStream(response.body), { status: response.status, statusText: response.statusText, headers });
  }
  if (response.body && type.includes("json")) {
    const text = await response.text();
    let out = text;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (scrubUpstream(parsed)) out = JSON.stringify(parsed);
    } catch {
      // Not JSON after all: passed as it is.
    }
    headers.delete("content-length");
    return new Response(out, { status: response.status, statusText: response.statusText, headers });
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
