/**
 * Which OpenRouter host serves a free-tier request: OpenRouter's provider routing
 * (https://openrouter.ai/docs/features/provider-routing). By default the cheapest host first,
 * limited to full-precision hosts that don't collect prompts, with fallbacks on among them.
 *
 * - `quantizations` keeps hosts at the model's native precision or higher. DeepSeek V4.1 Flash
 *   1017 ships FP8 weights (its config.json has `quant_method: "fp8"`, with the MoE experts
 *   stored in FP4), so FP8 and anything wider is allowed. FP6, FP4 and integer
 *   re-quantizations are not. `unknown` is left out because there are FP8 hosts to choose from.
 * - `data_collection: "deny"` keeps only hosts OpenRouter lists as neither training on nor
 *   storing prompts. OpenRouter documents it, like `quantizations`, as a filter on the
 *   candidate hosts, and `allow_fallbacks` only moves between hosts in that pool. When no
 *   host passes, the request fails instead of the filter being relaxed. The account-wide
 *   privacy setting on the company key is the hard backstop.
 * - `order`, when set, names hosts to try first. It replaces the price sort; the filters still
 *   apply, so an ordered host that fails them is skipped.
 * - `ignore` lists hosts that failed recently (see `HostCooldowns` in rate-limit-object.ts).
 *   The filters and the sort then pick the next host. If that leaves no host at all, the
 *   request is sent once more without `ignore` (see `isNoHostError`).
 */

/** The rate-limiter object that keeps the hosts that failed recently. */
export const HOSTS_OBJECT = "openrouter-hosts";

/** OpenRouter's quantization levels. An empty list means no precision filter. */
export const QUANTIZATIONS = ["int4", "int8", "fp4", "mxfp4", "nvfp4", "fp6", "fp8", "mxfp8", "fp16", "bf16", "fp32", "unknown"] as const;
export type Quantization = (typeof QUANTIZATIONS)[number];

/** Native FP8 and wider. */
export const FULL_PRECISION: readonly Quantization[] = ["fp8", "mxfp8", "fp16", "bf16", "fp32"];

export type DataCollection = "allow" | "deny";

const SLUG = /^[a-z0-9][a-z0-9._/-]{0,63}$/i;
const MAX_SLUGS = 10;

export function isProviderSlugList(value: readonly unknown[]): value is string[] {
  return value.length <= MAX_SLUGS && value.every((slug) => typeof slug === "string" && SLUG.test(slug));
}

export function isQuantizationList(value: readonly unknown[]): value is Quantization[] {
  return value.every((level) => typeof level === "string" && (QUANTIZATIONS as readonly string[]).includes(level));
}

/** A comma-separated env list: unset → undefined; "" or "none" → []. */
export function splitList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = String(value).trim();
  if (raw === "" || raw.toLowerCase() === "none") return [];
  return raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

export interface RoutingConfig {
  openRouterProviderOrder: readonly string[];
  openRouterQuantizations: readonly Quantization[];
  openRouterDataCollection: DataCollection;
}

/** The `provider` object sent to OpenRouter. `ignore` names hosts to skip on this request. */
export function providerPreferences(config: RoutingConfig, ignore: readonly string[] = []): Record<string, unknown> {
  const filters = {
    allow_fallbacks: true,
    ...(config.openRouterQuantizations.length > 0 ? { quantizations: [...config.openRouterQuantizations] } : {}),
    data_collection: config.openRouterDataCollection,
    ...(ignore.length > 0 ? { ignore: [...ignore].slice(0, MAX_SLUGS) } : {}),
  };
  return config.openRouterProviderOrder.length > 0 ? { order: [...config.openRouterProviderOrder], ...filters } : { sort: "price", ...filters };
}

/**
 * A host name as OpenRouter reports it ("Morph", "DeepInfra", "Google Vertex") as the slug its
 * routing fields take ("morph", "deepinfra", "google-vertex"). Undefined when there is none.
 */
export function hostSlug(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9./-]/g, "");
  return SLUG.test(slug) ? slug : undefined;
}

/**
 * The host behind an OpenRouter response body or stream chunk: the top-level `provider` field
 * on a completion, or `error.metadata.provider_name` on an error.
 */
export function hostOf(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const body = parsed as { provider?: unknown; error?: { metadata?: { provider_name?: unknown } } };
  return hostSlug(body.provider) ?? hostSlug(body.error?.metadata?.provider_name);
}

/**
 * Whether OpenRouter refused a request because no host passed the routing preferences
 * ("No endpoints found ...", "No allowed providers are available ..."), rather than a host
 * failing.
 */
export function isNoHostError(status: number, text: string): boolean {
  if (status < 400 || status === 429 || status === 401 || status === 402) return false;
  let message = text;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string") message = parsed.error.message;
  } catch {
    // not JSON: match the raw text
  }
  return /no (allowed )?(providers?|endpoints?)\b.*\b(available|found)|no (providers?|endpoints?) (are )?available/i.test(message);
}
