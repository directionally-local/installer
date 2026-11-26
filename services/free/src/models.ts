/**
 * The models the free tier serves, and the weekly allowance each one draws from.
 *
 * The providers (providers.ts), each on its own prepaid credit: OpenAI (the default), Luminal,
 * which serves DeepSeek, Liquid Inference, which serves Kimi, GLM 5.3 Flash (and GLM 5.3, off for
 * now), and Open Relay, GLM 5.3 Flash's backup upstream and, when on for them, the first-choice
 * upstream of DeepSeek and Kimi (`firstChoice`). A model's
 * `family` is the weekly dollar budget it spends: every GPT-6 model shares the GPT-6 budget, and
 * the open models (DeepSeek, Kimi, GLM) share the "deepseek" one, much larger (DeepSeek costs a
 * fraction as much per token). A model's `pool` is its weekly token allowance inside that: Luna, Sol and
 * Astra each have one; DeepSeek has no token cap, only its dollar budget.
 *
 * Prices are USD per million tokens, from the providers' own pages on 2026-11-06:
 *   - OpenAI: https://developers.openai.com/api/docs/models/<id> (input / cached input / output)
 *   - Luminal: https://luminal.com/pricing
 * `prices` is what the person's weekly dollar allowance is charged; `creditPrices` is what the
 * provider's credit pool is charged (they differ for DeepSeek, whose Luminal list price is
 * higher than what OpenRouter billed us for the same model).
 */

import type { Prices } from "./config.js";

/** Who serves a model (see providers.ts). OpenRouter stays for the old setting; the free tier doesn't use it. */
export type Provider = "openai" | "luminal" | "liquid" | "openrelay" | "openrouter";

/**
 * A model's line, as /v1/providers shows it: what the model is, whoever serves it. Not a
 * budget: DeepSeek, GLM and Kimi all spend the one open-models budget (`family` "deepseek").
 */
export type ModelLine = "gpt6" | "deepseek" | "glm" | "kimi";

/**
 * A marketplace provider's per-request rules (Liquid Inference): the sellers that may serve the
 * model and the most it may cost, USD per million tokens. Both are runtime settings too
 * (providers.ts `exchangeRules`); these are the defaults.
 */
export interface ExchangeDefaults {
  allow: readonly string[];
  maxPrices: Prices;
}

/** A weekly token allowance: one per model. */
export type Pool = "luna" | "sol" | "astra" | "deepseek";

export const POOLS: readonly Pool[] = ["luna", "sol", "astra", "deepseek"];

/**
 * Tokens a week in each pool, per person; null for no token cap. Luna's is the `weeklyTokens`
 * setting (this is its default). DeepSeek has none: its dollar budget is the only limit, so a
 * token count can never stop it before the dollars do.
 */
export const POOL_TOKENS: Readonly<Record<Pool, number | null>> = {
  luna: 50_000_000,
  sol: 10_000_000,
  astra: 3_000_000,
  deepseek: null,
};

/**
 * A weekly dollar budget: every GPT-6 model shares "gpt6"; the open models (DeepSeek, Kimi,
 * GLM) share "deepseek", the open-models budget. Adding a provider or an open model never adds a
 * budget: a person's open-models week is the same whichever of them they use.
 */
export type Family = "gpt6" | "deepseek";

export const FAMILIES: readonly Family[] = ["gpt6", "deepseek"];

export interface FreeModel {
  /** The id clients send and see. Stable: it doesn't change when the wire id does. */
  id: string;
  name: string;
  provider: Provider;
  /** The id the provider's API takes. */
  upstreamModel: string;
  pool: Pool;
  /** The weekly dollar budget its usage counts against. */
  family: Family;
  /** USD per million tokens charged to the person's weekly dollar allowance. */
  prices: Prices;
  /** USD per million tokens charged to the provider's credit pool; `prices` when unset. */
  creditPrices?: Prices;
  contextWindow: number;
  maxOutputTokens: number;
  vision: boolean;
  reasoning: boolean;
  /**
   * The model to retry on when this one's provider fails or its credit runs out. On a registry
   * provider (GLM 5.3 Flash), the model that serves once its provider's budget or the person's
   * cap is used up (providers.ts FALLBACK_BLOCKS).
   */
  fallback?: string;
  /** What the model is (see ModelLine); the budget is `family`. */
  line: ModelLine;
  /** Marketplace rules (Liquid Inference only). */
  exchange?: ExchangeDefaults;
  /** Off until the provider's `providerModels.<id>` setting lists it (default: on). */
  enabledByDefault?: boolean;
  /**
   * More upstreams for the same model, tried in order after its own provider (`provider`,
   * `upstreamModel`, `exchange`, `creditPrices`): when the one before can't serve (its limits)
   * or fails before anything reaches the client (429, 5xx, a timeout, no eligible offer). Each is
   * on while its provider's `providerModels.<id>` lists the model. See `upstreamsOf`.
   */
  backups?: readonly ModelUpstream[];
  /**
   * Upstreams tried before its own provider, in order, each only while its provider is on and
   * lists the model (`providerModels.<id>`) and is within its budgets (providers.ts
   * upstreamBlock). Off, or failing before anything reaches the client (429, 5xx, a timeout, a
   * prompt longer than it takes), the request goes on to the model's own provider as before.
   * DeepSeek and Kimi K3.1 Pro: Open Relay first, when the owner turns it on.
   */
  firstChoice?: readonly ModelUpstream[];
  /**
   * Who may use it, whatever its providers' `providerPlans.<id>` and opt-in say: "all" keeps a
   * model free for everyone on a provider whose other models are Pro-only (GLM 5.3 Flash on
   * Liquid, where Kimi is a Pro perk). Unset: its provider's plans and opt-in decide.
   */
  plans?: "all" | "pro";
  /**
   * Its per-person weekly cap is its own (`modelPersonWeeklyUsd.<key>`, providers.ts), counted
   * across all its upstreams, instead of its providers' `providerPersonWeeklyUsd.<id>`; and its
   * spend doesn't count toward those.
   */
  ownCaps?: boolean;
}

/** One upstream of a model: who serves it, under what id, with what marketplace rules and credit prices. */
export interface ModelUpstream {
  provider: Provider;
  upstreamModel: string;
  exchange?: ExchangeDefaults;
  /** What this upstream's credit is charged when it doesn't report a cost; the model's `prices` when unset. */
  creditPrices?: Prices;
}

export const FREE_MODELS: readonly FreeModel[] = [
  {
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    provider: "openai",
    upstreamModel: "gpt-6-luna",
    pool: "luna",
    family: "gpt6",
    prices: { input: 0.1, cached: 0.01, output: 0.5 },
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    vision: true,
    reasoning: true,
    fallback: "deepseek/deepseek-v4.1-flash-1017",
    line: "gpt6",
  },
  {
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    provider: "openai",
    upstreamModel: "gpt-6.1-sol",
    pool: "sol",
    family: "gpt6",
    prices: { input: 2, cached: 0.1, output: 10 },
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    vision: true,
    reasoning: true,
    fallback: "deepseek/deepseek-v4.1-flash-1017",
    line: "gpt6",
  },
  {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    provider: "openai",
    upstreamModel: "gpt-6-astra",
    pool: "astra",
    family: "gpt6",
    prices: { input: 10, cached: 1, output: 50 },
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    vision: true,
    reasoning: true,
    fallback: "deepseek/deepseek-v4.1-flash-1017",
    line: "gpt6",
  },
  {
    id: "deepseek/deepseek-v4.1-flash-1017",
    name: "DeepSeek V4.1 Flash 1017",
    provider: "luminal",
    upstreamModel: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
    pool: "deepseek",
    family: "deepseek",
    // What OpenRouter billed us for the same model: the person's allowance means the same
    // whichever provider served.
    prices: { input: 0.035, cached: 0.006, output: 0.315 },
    // Luminal's own list price: what its credit is charged.
    creditPrices: { input: 0.1425, cached: 0.0029, output: 0.57 },
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    vision: false,
    reasoning: true,
    line: "deepseek",
    firstChoice: [
      // Open Relay, before Luminal while `providerModels.openrelay` lists it. Its prices
      // (https://openrelay.inc/models/deepseek-v4.1-flash, matched against `cost_nano_usd` on
      // live requests 2026-11-26); it reports its cost, these count only when it doesn't. Its
      // context is 384K: a longer prompt goes on to Luminal (a 400 context_length_exceeded).
      { provider: "openrelay", upstreamModel: "openrelay/deepseek-v4.1-flash", creditPrices: { input: 0.035, cached: 0.01, output: 0.33 } },
    ],
  },
  // Liquid Inference (an exchange: each request goes to the cheapest seller that passes the
  // request's rules). Ids, limits and prices from https://liquidinference.ai/models/<id> and the
  // public offers (https://router.inference.ai.exchange/v1/exchange/offers) on 2026-11-23.
  // Kimi and GLM 5.3 draw the open-models budget, and both are dl Pro only by default
  // (`providerPlans.liquid`), with a small weekly ration a person (providers.ts), because the
  // Liquid credit is small. GLM 5.3 Flash (below) is on Liquid too, free for everyone.
  {
    id: "moonshotai/kimi-k3.1-pro",
    name: "Kimi K3.1 Pro",
    provider: "liquid",
    upstreamModel: "kimi-k3.1-pro",
    pool: "deepseek",
    family: "deepseek",
    // Charged at the request's price ceilings (below), so a person's open-models week can't
    // stretch further on Kimi than it costs. Moonshot's list price is $2 / $0.20 / $10.
    prices: { input: 2.1, cached: 0.25, output: 10.5 },
    // The credit is charged what the exchange reports (`exchange.charge.total_usd`) when it
    // says; these, the ceilings plus the 5% exchange fee, only when it doesn't.
    creditPrices: { input: 2.205, cached: 0.2625, output: 11.025 },
    // 1,048,576 on every offer seen; 131,072 out on the zero-retention ones.
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    vision: true,
    // Always reasons; reasoning is billed as output.
    reasoning: true,
    line: "kimi",
    firstChoice: [
      // Open Relay, before Liquid while `providerModels.openrelay` lists it. Its prices
      // (https://openrelay.inc/models/kimi-k3.1-pro, matched against `cost_nano_usd` on live
      // requests 2026-11-26). Its context is 256K: a longer prompt goes on to Liquid.
      { provider: "openrelay", upstreamModel: "openrelay/kimi-k3.1-pro", creditPrices: { input: 0.24, cached: 0.2, output: 7 } },
    ],
    exchange: {
      // Sellers that declare zero retention. Unverified: the handle is as the research saw it
      // on the providers page; the public offers carry no seller names. `privacy.retention:
      // "none"` is sent too, so a seller that can't keep it is never eligible either way.
      allow: ["deeprelay"],
      maxPrices: { input: 2.1, cached: 0.25, output: 10.5 },
    },
  },
  {
    id: "z-ai/glm-5.3",
    name: "GLM 5.3",
    provider: "liquid",
    upstreamModel: "glm-5.3",
    pool: "deepseek",
    family: "deepseek",
    prices: { input: 0.15, cached: 0.03, output: 0.6 },
    creditPrices: { input: 0.1575, cached: 0.0315, output: 0.63 },
    // 1,048,576 in and 65,536 out on the cheapest zero-retention offer (blackfuel); unverified
    // for the others.
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    // Text only.
    vision: false,
    reasoning: true,
    line: "glm",
    exchange: {
      // Checked by a live request on 2026-11-23 (served by blackfuel).
      allow: ["blackfuel", "Asari AI"],
      maxPrices: { input: 0.15, cached: 0.03, output: 0.6 },
    },
    // Defined, off: Kimi is the Liquid model the free tier starts with.
    enabledByDefault: false,
  },
  // GLM 5.3 Flash, free for everyone: two upstreams, tried in order (`upstreamsOf`). Liquid
  // Inference first (fastest and cheapest in the 24 Nov bake-off: about 275 tokens a second,
  // 0.45 s to the first token, ~$0.0006 a coding task), then Open Relay (OpenRelay Inc.,
  // https://openrelay.inc/) when Liquid is at a limit or fails before anything reaches the client.
  // Past both, DeepSeek (its `fallback`). Its access and per-person cap are its own (`plans`,
  // `ownCaps`), not Liquid's Pro-only settings or Open Relay's cap.
  {
    id: "z-ai/glm-5.3-flash",
    name: "GLM 5.3 Flash",
    provider: "liquid",
    upstreamModel: "glm-5.3-flash",
    pool: "deepseek",
    family: "deepseek",
    // Open Relay's list price, for the person's allowance whichever upstream serves (Liquid's
    // cheapest seller is below it).
    prices: { input: 0.045, cached: 0.009, output: 0.18 },
    // Liquid's credit is charged what the exchange reports; these, the ceilings plus about
    // $0.01 a million tokens of exchange fee (seen live), only when it doesn't.
    creditPrices: { input: 0.21, cached: 0.06, output: 0.51 },
    // 256K: Open Relay's (its models page). Liquid's offers take 1M in and up to 131K out, but a
    // conversation has to fit the backup too.
    contextWindow: 262_144,
    maxOutputTokens: 32_768,
    // Both list image input; not tried with an image yet.
    vision: false,
    // Reasons before it answers; billed as output.
    reasoning: true,
    fallback: "deepseek/deepseek-v4.1-flash-1017",
    line: "glm",
    exchange: {
      // The sellers that served it in the 24 Nov bake-off with `privacy.retention: "none"`, both
      // checked again by a live request on 2026-11-24: munitoai (the cheapest, $0.02765 /
      // $0.005743 / $0.09571, region "global") and tensorx ($0.20 / $0.05 / $0.50, region "eu").
      allow: ["munitoai", "tensorx"],
      // Admits both; the exchange picks the cheapest (munitoai) and keeps a session there.
      maxPrices: { input: 0.2, cached: 0.05, output: 0.5 },
    },
    backups: [
      // Open Relay: the list price is its credit price; it reports its cost (`openrelay.cost_nano_usd`).
      { provider: "openrelay", upstreamModel: "openrelay/glm-5.3-flash" },
    ],
    plans: "all",
    ownCaps: true,
  },
];

/** A model's upstreams in the order they're tried: its `firstChoice`, its own provider, then its `backups`. */
export function upstreamsOf(model: FreeModel): ModelUpstream[] {
  const own: ModelUpstream = { provider: model.provider, upstreamModel: model.upstreamModel, ...(model.exchange ? { exchange: model.exchange } : {}), ...(model.creditPrices ? { creditPrices: model.creditPrices } : {}) };
  return [...(model.firstChoice ?? []), own, ...(model.backups ?? [])];
}

/** The upstreams other than the model's own provider: its `firstChoice` and `backups`. */
function otherUpstreams(model: FreeModel): ModelUpstream[] {
  return [...(model.firstChoice ?? []), ...(model.backups ?? [])];
}

/**
 * The model as one of its upstreams serves it: that provider, wire id, marketplace rules and
 * credit prices; the id, name, prices and budget stay the model's. The model itself for its own provider.
 */
export function onUpstream(model: FreeModel, provider: Provider): FreeModel {
  if (provider === model.provider) return model;
  const upstream = otherUpstreams(model).find((entry) => entry.provider === provider);
  if (!upstream) return model;
  const { exchange: _exchange, creditPrices: _credit, ...rest } = model;
  return { ...rest, provider: upstream.provider, upstreamModel: upstream.upstreamModel, ...(upstream.exchange ? { exchange: upstream.exchange } : {}), ...(upstream.creditPrices ? { creditPrices: upstream.creditPrices } : {}) };
}

/** Whether `provider` is a `firstChoice` upstream of the model: tried before its own provider. */
export function isFirstChoice(model: FreeModel, provider: string): boolean {
  return (model.firstChoice ?? []).some((entry) => entry.provider === provider);
}

/** Whether `provider` is one of the model's upstreams. */
export function servedBy(model: FreeModel, provider: string): boolean {
  return model.provider === provider || otherUpstreams(model).some((entry) => entry.provider === provider);
}

/** The model a request gets when it doesn't name one, and the one the pickers lead with. */
export const DEFAULT_MODEL = "gpt-6-luna";

/** The DeepSeek model: every GPT-6 model's fallback. */
export const DEEPSEEK_MODEL = "deepseek/deepseek-v4.1-flash-1017";

export const ALLOWED_MODELS: readonly string[] = FREE_MODELS.map((model) => model.id);

export function modelById(id: unknown): FreeModel | undefined {
  return typeof id === "string" ? FREE_MODELS.find((model) => model.id === id) : undefined;
}

export function isFreeModelId(id: unknown): id is string {
  return modelById(id) !== undefined;
}

/** The pool a model's tokens come from; undefined for a model the free tier doesn't serve. */
export function poolOf(id: unknown): Pool | undefined {
  return modelById(id)?.pool;
}

/** The dollar budget a model's usage counts against; undefined for a model the free tier doesn't serve. */
export function familyOf(id: unknown): Family | undefined {
  return modelById(id)?.family;
}

/** The dollar budget a pool's usage counts against. */
export function familyOfPool(pool: Pool): Family {
  return pool === "deepseek" ? "deepseek" : "gpt6";
}

/** The models that draw from one pool. */
export function modelsInPool(pool: Pool): FreeModel[] {
  return FREE_MODELS.filter((model) => model.pool === pool);
}

/** The model to retry on when `id`'s provider fails, if it has one. */
export function fallbackOf(id: unknown): FreeModel | undefined {
  const model = modelById(id);
  return model?.fallback ? modelById(model.fallback) : undefined;
}

/** What a model's usage costs at its allowance prices. */
export function allowancePrices(model: FreeModel): Prices {
  return model.prices;
}

/** What a model's usage costs its provider's credit pool. */
export function creditPrices(model: FreeModel): Prices {
  return model.creditPrices ?? model.prices;
}
