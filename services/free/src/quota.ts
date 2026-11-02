/**
 * Reserve-then-settle arithmetic. Before forwarding, a request reserves its prompt estimate
 * plus its output cap; the forwarded `max_tokens` is clamped so the reservation covers the
 * worst case. After the response, the reservation is replaced by what the provider reported,
 * or kept whole when it reported nothing.
 */

export const ALLOWED_MODELS = ["deepseek/deepseek-v4.1-flash-1017"] as const;

/** The most output tokens one request may ask for. */
export const MAX_OUTPUT_TOKENS = 32_768;
/** A request that can't fit this many output tokens is refused rather than truncated to nothing. */
export const MIN_OUTPUT_TOKENS = 256;
/**
 * Bytes of request body per estimated prompt token. Real tokenizers average 3–4 bytes per
 * token on code and English; 2 overestimates on purpose, so a reservation covers the prompt.
 */
export const BYTES_PER_TOKEN_ESTIMATE = 2;
/** Charged when the provider reports no cost (USD per million tokens, deliberately high). */
export const FALLBACK_USD_PER_MILLION_TOKENS = 1;

export function isAllowedModel(model: unknown): model is (typeof ALLOWED_MODELS)[number] {
  return typeof model === "string" && (ALLOWED_MODELS as readonly string[]).includes(model);
}

export function estimatePromptTokens(bodyBytes: number): number {
  return Math.ceil(bodyBytes / BYTES_PER_TOKEN_ESTIMATE);
}

export interface ReservationPlan {
  /** Tokens to hold: prompt estimate plus `maxTokens`. */
  amount: number;
  /** The `max_tokens` to forward. */
  maxTokens: number;
}

/**
 * How much to reserve, given what's left. Undefined when even a minimal answer wouldn't fit:
 * the caller answers `quota_exceeded`.
 */
export function planReservation(promptEstimate: number, requestedMaxTokens: number | undefined, remaining: number): ReservationPlan | undefined {
  const wanted = Math.min(MAX_OUTPUT_TOKENS, requestedMaxTokens && requestedMaxTokens > 0 ? Math.floor(requestedMaxTokens) : MAX_OUTPUT_TOKENS);
  const room = remaining - promptEstimate;
  const minimum = Math.min(MIN_OUTPUT_TOKENS, wanted);
  if (room < minimum) return undefined;
  const maxTokens = Math.min(wanted, room);
  return { amount: promptEstimate + maxTokens, maxTokens };
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /** USD as reported by OpenRouter; undefined when it didn't say. */
  costUsd: number | undefined;
}

/** OpenRouter's (OpenAI-shaped) `usage` object, or undefined when it isn't one. */
export function parseUsage(value: unknown): Usage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    cost?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown } | null;
  };
  const promptTokens = count(usage.prompt_tokens);
  const completionTokens = count(usage.completion_tokens);
  if (promptTokens === undefined || completionTokens === undefined) return undefined;
  return {
    promptTokens,
    completionTokens,
    cachedTokens: Math.min(promptTokens, count(usage.prompt_tokens_details?.cached_tokens) ?? 0),
    costUsd: typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : undefined,
  };
}

/** Tokens charged against the allowance. Cached prompt tokens count unless configured off. */
export function chargedTokens(usage: Usage, countCachedTokens: boolean): number {
  const prompt = countCachedTokens ? usage.promptTokens : usage.promptTokens - usage.cachedTokens;
  return prompt + usage.completionTokens;
}

export function costOf(usage: Usage | undefined, fallbackTokens: number): number {
  if (usage?.costUsd !== undefined) return usage.costUsd;
  const tokens = usage ? usage.promptTokens + usage.completionTokens : fallbackTokens;
  return (tokens * FALLBACK_USD_PER_MILLION_TOKENS) / 1_000_000;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}
