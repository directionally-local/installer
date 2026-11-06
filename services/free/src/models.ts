/**
 * The models the free tier serves, and the weekly allowance each one draws from.
 *
 * Two providers, each on its own prepaid credit: OpenAI (the default) and Luminal, which
 * serves DeepSeek. A model's `pool` is the weekly token allowance it spends: GPT-6 Luna and
 * DeepSeek share one pool, so switching between them (by hand, or by the automatic fallback)
 * doesn't hand anyone a second allowance.
 *
 * Prices are USD per million tokens, from the providers' own pages on 2026-11-06:
 *   - OpenAI: https://developers.openai.com/api/docs/models/<id> (input / cached input / output)
 *   - Luminal: https://luminal.com/pricing
 * `prices` is what the person's weekly dollar allowance is charged; `creditPrices` is what the
 * provider's credit pool is charged (they differ for DeepSeek, whose Luminal list price is
 * higher than what OpenRouter billed us for the same model).
 */

import type { Prices } from "./config.js";

/** Who serves a model. OpenRouter stays for the old setting; the free tier doesn't use it. */
export type Provider = "openai" | "luminal" | "openrouter";

/** A weekly token allowance. Luna and DeepSeek share one. */
export type Pool = "luna" | "sol" | "astra";

export const POOLS: readonly Pool[] = ["luna", "sol", "astra"];

/** Tokens a week in each pool, per person. */
export const POOL_TOKENS: Readonly<Record<Pool, number>> = {
  luna: 50_000_000,
  sol: 10_000_000,
  astra: 3_000_000,
};

export interface FreeModel {
  /** The id clients send and see. Stable: it doesn't change when the wire id does. */
  id: string;
  name: string;
  provider: Provider;
  /** The id the provider's API takes. */
  upstreamModel: string;
  pool: Pool;
  /** USD per million tokens charged to the person's weekly dollar allowance. */
  prices: Prices;
  /** USD per million tokens charged to the provider's credit pool; `prices` when unset. */
  creditPrices?: Prices;
  contextWindow: number;
  maxOutputTokens: number;
  vision: boolean;
  reasoning: boolean;
  /** The model to retry on when this one's provider fails or its credit runs out. */
  fallback?: string;
}

export const FREE_MODELS: readonly FreeModel[] = [
  {
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    provider: "openai",
    upstreamModel: "gpt-6-luna",
    pool: "luna",
    prices: { input: 0.1, cached: 0.01, output: 0.5 },
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    vision: true,
    reasoning: true,
    fallback: "deepseek/deepseek-v4.1-flash-1017",
  },
  {
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    provider: "openai",
    upstreamModel: "gpt-6.1-sol",
    pool: "sol",
    prices: { input: 2, cached: 0.1, output: 10 },
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    vision: true,
    reasoning: true,
    fallback: "deepseek/deepseek-v4.1-flash-1017",
  },
  {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    provider: "openai",
    upstreamModel: "gpt-6-astra",
    pool: "astra",
    prices: { input: 10, cached: 1, output: 50 },
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    vision: true,
    reasoning: true,
    fallback: "deepseek/deepseek-v4.1-flash-1017",
  },
  {
    id: "deepseek/deepseek-v4.1-flash-1017",
    name: "DeepSeek V4.1 Flash 1017",
    provider: "luminal",
    upstreamModel: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
    pool: "luna",
    // What OpenRouter billed us for the same model: the person's allowance means the same
    // whichever provider served.
    prices: { input: 0.035, cached: 0.006, output: 0.315 },
    // Luminal's own list price: what its credit is charged.
    creditPrices: { input: 0.1425, cached: 0.0029, output: 0.57 },
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    vision: false,
    reasoning: true,
  },
];

/** The model a request gets when it doesn't name one, and the one the pickers lead with. */
export const DEFAULT_MODEL = "gpt-6-luna";

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
