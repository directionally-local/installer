/**
 * The providers the free tier buys tokens from: one typed list, so a new provider is one entry
 * here, its models in models.ts, its settings in runtime-config.ts and its key as a secret (see
 * the README, "Providers").
 *
 * Each provider has its own prepaid credit and weekly credit budget, and its spend is tracked
 * apart (directory-object.ts). OpenAI and Luminal came first and keep their own settings
 * (`openaiCreditUsd`, `luminalCreditUsd` and the weekly ones; `providerCredit.openai` and the like
 * are aliases) and their own behaviour when the credit runs out: OpenAI falls back to DeepSeek,
 * Luminal pauses with `upstream_credit_exhausted`. Every later provider is "registry" style: its
 * settings are `provider<Setting>.<id>`, and when it can't serve (paused, out of credit, its
 * weekly budget used, or a person's opt-in cap reached) its models leave /v1/models and a
 * request for one gets a 402 `provider_limit` naming DeepSeek as the alternative.
 *
 * Nothing here is secret: the keys are only named (`keyEnv`), never read.
 */

import type { FreeConfig, Prices } from "./config.js";
import { DEEPSEEK_MODEL, FREE_MODELS, type FreeModel } from "./models.js";

export type ProviderId = "openai" | "luminal" | "liquid";
export const PROVIDER_IDS: readonly ProviderId[] = ["openai", "luminal", "liquid"];

/** How the service talks to it: OpenAI's Responses API, or chat completions. */
export type ApiStyle = "openai-chat" | "openai-responses";

export type ProviderStatus = "on" | "paused";
export const PROVIDER_STATUSES: readonly ProviderStatus[] = ["on", "paused"];

export interface ProviderSpec {
  id: ProviderId;
  name: string;
  website: string;
  /** The API's base URL; chat requests go to `${baseUrl}/chat/completions` (or `/responses`). */
  baseUrl: string;
  apiStyle: ApiStyle;
  /** The secret that holds its API key (`wrangler secret put <keyEnv>`). */
  keyEnv: string;
  /** "legacy": its own setting names and credit behaviour (see above); "registry": the generic ones. */
  kind: "legacy" | "registry";
}

export const PROVIDERS: readonly ProviderSpec[] = [
  { id: "openai", name: "OpenAI", website: "https://openai.com/", baseUrl: "https://api.openai.com/v1", apiStyle: "openai-responses", keyEnv: "OPENAI_API_KEY", kind: "legacy" },
  { id: "luminal", name: "Luminal", website: "https://luminal.com/", baseUrl: "https://flash.luminal.cloud/v1", apiStyle: "openai-chat", keyEnv: "LUMINAL_API_KEY", kind: "legacy" },
  {
    id: "liquid",
    name: "Liquid Inference",
    website: "https://liquidinference.ai/",
    // OpenAI-compatible: POST /chat/completions, GET /models (https://liquidinference.ai/docs/api.md).
    baseUrl: "https://router.inference.ai.exchange/v1",
    apiStyle: "openai-chat",
    keyEnv: "LIQUID_INFERENCE_API_KEY",
    kind: "registry",
  },
];

/** The registry-style providers: the ones with `provider<Setting>.<id>` settings. */
export type RegistryProviderId = "liquid";

export function providerSpec(id: ProviderId): ProviderSpec {
  return PROVIDERS.find((provider) => provider.id === id)!;
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

export function isRegistryProvider(value: unknown): value is RegistryProviderId {
  return isProviderId(value) && providerSpec(value).kind === "registry";
}

/** A provider's models, in FREE_MODELS order. */
export function providerModels(id: ProviderId): FreeModel[] {
  return FREE_MODELS.filter((model) => model.provider === id);
}

/** What the generic settings say about one provider, whatever their names. */
export interface ProviderSettings {
  status: ProviderStatus;
  /** Prepaid credit, USD: at or past it the provider is out of credit. */
  creditUsd: number;
  /** The most its credit may spend a week on everyone but admins; undefined: no weekly budget. */
  weeklyCreditUsd: number | undefined;
  /**
   * Opt-in: never a default or a fallback, only served to people who pick one of its models, and
   * held to `personWeeklyUsd` a person a week (besides the open-models budget).
   */
  optIn: boolean;
  personWeeklyUsd: number | undefined;
  /** For later: Pro gets it first. Nothing gates on it yet, so access stays what `optIn` says. */
  proFirst: boolean;
  /** The model ids that are on. */
  models: readonly string[];
}

/** The settings registry providers keep in the config, by their setting names. */
export type RegistrySettingsConfig = {
  "providerStatus.liquid": ProviderStatus;
  "providerCredit.liquid": number;
  "providerWeeklyCredit.liquid": number | undefined;
  "providerPersonWeeklyUsd.liquid": number | undefined;
  "providerOptIn.liquid": boolean;
  "providerProFirst.liquid": boolean;
  "providerModels.liquid": readonly string[];
  "exchangeAllow.kimi-k3.1-pro": readonly string[];
  "exchangeMaxPrices.kimi-k3.1-pro": readonly number[];
  "exchangeAllow.glm-5.3": readonly string[];
  "exchangeMaxPrices.glm-5.3": readonly number[];
};

/** The defaults: Liquid paused until the owner turns it on, $100 of credit, $25 a week, opt-in at $0.50 a person a week. */
export const REGISTRY_DEFAULTS: RegistrySettingsConfig = {
  "providerStatus.liquid": "paused",
  "providerCredit.liquid": 100,
  "providerWeeklyCredit.liquid": 25,
  "providerPersonWeeklyUsd.liquid": 0.5,
  "providerOptIn.liquid": true,
  "providerProFirst.liquid": true,
  "providerModels.liquid": providerModels("liquid")
    .filter((model) => model.enabledByDefault !== false)
    .map((model) => model.id),
  "exchangeAllow.kimi-k3.1-pro": exchangeDefaults("kimi-k3.1-pro").allow,
  "exchangeMaxPrices.kimi-k3.1-pro": pricesList(exchangeDefaults("kimi-k3.1-pro").maxPrices),
  "exchangeAllow.glm-5.3": exchangeDefaults("glm-5.3").allow,
  "exchangeMaxPrices.glm-5.3": pricesList(exchangeDefaults("glm-5.3").maxPrices),
};

function exchangeDefaults(upstreamModel: string): { allow: readonly string[]; maxPrices: Prices } {
  const model = FREE_MODELS.find((entry) => entry.upstreamModel === upstreamModel && entry.exchange);
  if (!model?.exchange) throw new Error(`no exchange defaults for ${upstreamModel}`);
  return model.exchange;
}

function pricesList(prices: Prices): number[] {
  return [prices.input, prices.cached, prices.output];
}

/** The config fields provider settings read. */
export type ProviderConfig = Pick<FreeConfig, "openaiCreditUsd" | "openaiWeeklyCreditUsd" | "luminalCreditUsd" | "luminalWeeklyCreditUsd"> & RegistrySettingsConfig;

export function providerSettings(config: ProviderConfig, id: ProviderId): ProviderSettings {
  const all = (provider: ProviderId) => providerModels(provider).map((model) => model.id);
  if (id === "openai") return { status: "on", creditUsd: config.openaiCreditUsd, weeklyCreditUsd: config.openaiWeeklyCreditUsd, optIn: false, personWeeklyUsd: undefined, proFirst: false, models: all("openai") };
  if (id === "luminal") return { status: "on", creditUsd: config.luminalCreditUsd, weeklyCreditUsd: config.luminalWeeklyCreditUsd, optIn: false, personWeeklyUsd: undefined, proFirst: false, models: all("luminal") };
  return {
    status: config["providerStatus.liquid"],
    creditUsd: config["providerCredit.liquid"],
    weeklyCreditUsd: config["providerWeeklyCredit.liquid"],
    optIn: config["providerOptIn.liquid"],
    personWeeklyUsd: config["providerPersonWeeklyUsd.liquid"],
    proFirst: config["providerProFirst.liquid"],
    models: config["providerModels.liquid"],
  };
}

/** The exchange rules sent with a Liquid request for `model`: its sellers and price ceilings. */
export function exchangeRules(config: RegistrySettingsConfig, model: FreeModel): { allow: readonly string[]; maxPrices: Prices } | undefined {
  if (!model.exchange) return undefined;
  const allowKey = `exchangeAllow.${model.upstreamModel}` as keyof RegistrySettingsConfig;
  const pricesKey = `exchangeMaxPrices.${model.upstreamModel}` as keyof RegistrySettingsConfig;
  const allow = (config[allowKey] as readonly string[] | undefined) ?? model.exchange.allow;
  const list = config[pricesKey] as readonly number[] | undefined;
  const maxPrices = list && list.length === 3 ? { input: list[0]!, cached: list[1]!, output: list[2]! } : model.exchange.maxPrices;
  return { allow, maxPrices };
}

/** Whether a provider has its API key. */
export function providerKey(config: Pick<FreeConfig, "openaiApiKey" | "luminalApiKey" | "liquidApiKey">, id: ProviderId): string | undefined {
  return id === "openai" ? config.openaiApiKey : id === "luminal" ? config.luminalApiKey : config.liquidApiKey;
}

/** Credit numbers for every provider: used since the start (everyone, probes included), and this week by everyone but admins. */
export interface ProviderSpend {
  usedUsd: Partial<Record<ProviderId, number>>;
  weekUsd: Partial<Record<ProviderId, number>>;
}

/**
 * Why a registry provider's model can't be served right now, or undefined when it can. In order:
 * no key, the provider or the model paused, the credit used up, the weekly budget used, the
 * person's opt-in cap reached (`personWeekUsd`; admins pass undefined).
 */
export type ProviderBlock = "no_key" | "paused" | "out_of_credit" | "weekly_budget" | "person_cap";

export function registryBlock(
  config: ProviderConfig & Pick<FreeConfig, "openaiApiKey" | "luminalApiKey" | "liquidApiKey">,
  model: FreeModel,
  spend: ProviderSpend,
  personWeekUsd?: number,
): ProviderBlock | undefined {
  if (!isRegistryProvider(model.provider)) return undefined;
  const id = model.provider;
  const settings = providerSettings(config, id);
  if (providerKey(config, id) === undefined) return "no_key";
  if (settings.status !== "on" || !settings.models.includes(model.id)) return "paused";
  if ((spend.usedUsd[id] ?? 0) >= settings.creditUsd) return "out_of_credit";
  if (settings.weeklyCreditUsd !== undefined && (spend.weekUsd[id] ?? 0) >= settings.weeklyCreditUsd) return "weekly_budget";
  if (personWeekUsd !== undefined && settings.optIn && settings.personWeeklyUsd !== undefined && personWeekUsd >= settings.personWeeklyUsd) return "person_cap";
  return undefined;
}

/**
 * The models the service offers at all: every model of OpenAI and Luminal, and a registry
 * provider's models once it has a key and the model is on. Before then a registry model is
 * invisible: not in /v1/status, /v1/me or /v1/models, as if it weren't defined.
 */
export function offeredModels(config: ProviderConfig & Pick<FreeConfig, "openaiApiKey" | "luminalApiKey" | "liquidApiKey">): FreeModel[] {
  return FREE_MODELS.filter((model) => !isRegistryProvider(model.provider) || (providerKey(config, model.provider) !== undefined && providerSettings(config, model.provider).models.includes(model.id)));
}

/** What /v1/providers says about a model's access. */
export type Access = "free" | "trusted" | "opt-in" | "pro";

export function accessOf(config: ProviderConfig, model: FreeModel): Access {
  if (model.family === "gpt6") return "trusted";
  if (!isRegistryProvider(model.provider)) return "free";
  // `proFirst` doesn't change access yet: nothing gates on Pro, so "pro" waits for that.
  return providerSettings(config, model.provider).optIn ? "opt-in" : "free";
}

/** The 402 a blocked registry model gets: the same shape as `gpt_limit`, with DeepSeek as the alternative. */
export function providerLimitMessage(model: FreeModel, block: ProviderBlock, providerName: string): string {
  const use = `Use ${DEEPSEEK_MODEL} instead: /model.`;
  switch (block) {
    case "no_key":
    case "paused":
      return `${model.name} on ${providerName} is paused for free tokens right now. ${use}`;
    case "out_of_credit":
      return `${model.name} on ${providerName} is out of free credit for now. ${use}`;
    case "weekly_budget":
      return `${model.name} on ${providerName} has used its free budget for this week. ${use}`;
    case "person_cap":
      return `You've used this week's free ${model.name}. ${use}`;
  }
}

/** The 80% credit warning for a registry provider: sent once per balance. */
export const REGISTRY_CREDIT_ALERT_SHARE = 0.8;

/** A seller handle on the exchange: letters, digits, spaces and `.-_*`, as `providers.allow` takes them. */
const SELLER = /^[A-Za-z0-9*][A-Za-z0-9 ._*-]{0,63}$/;

/** Up to 10 seller handles; `[]` lets every seller that passes the other rules compete. */
export function isSellerList(value: readonly unknown[]): value is string[] {
  return value.length <= 10 && value.every((entry) => typeof entry === "string" && SELLER.test(entry.trim()));
}

/** Model ids of registry providers (any of them). */
export function isRegistryModelList(value: readonly unknown[]): value is string[] {
  const ids = new Set(FREE_MODELS.filter((model) => isRegistryProvider(model.provider)).map((model) => model.id));
  return value.length <= 50 && value.every((entry) => typeof entry === "string" && ids.has(entry));
}

/** Three price ceilings, USD per million tokens: input, cache read, output. */
export function isPriceList(value: readonly unknown[]): value is number[] {
  return value.length === 3 && value.every((entry) => typeof entry === "number" && Number.isFinite(entry) && entry >= 0 && entry <= 1000);
}

// ─── Liquid Inference requests ───────────────────────────────────────────────

/**
 * The fields of a client's chat request passed to Liquid. The exchange refuses a parameter no
 * offer supports rather than ignoring it (400 unsupported_parameter), so everything else is
 * dropped: OpenRouter's `provider`, `usage`, `models`, `route`, and any client `exchange` (the
 * rules are the service's). From https://liquidinference.ai/docs/move-from-openrouter.md;
 * `parallel_tool_calls` is left out because the docs don't list it (unverified).
 */
export const LIQUID_FIELDS = ["messages", "tools", "tool_choice", "response_format", "temperature", "top_p", "stop", "seed", "frequency_penalty", "presence_penalty", "reasoning", "reasoning_effort"] as const;

/** A session id the exchange takes (printable ASCII, at most 256). */
const SESSION_ID = /^[\x21-\x7e]{1,256}$/;

/**
 * A chat completions body for Liquid: the client's fields above, the exchange's model id, the
 * reservation's output limit, the person's hashed id as `user` (the exchange's end-user
 * guardrails read it), the session id at the top level (verified live: `exchange.session` takes
 * only `sticky`, `pin` and `margin`), and the rules: the allowed sellers, zero retention, the
 * price ceilings, and a sticky session so a conversation stays on the seller that holds its
 * prompt cache (caches are per seller).
 */
export function liquidPayload(
  body: Record<string, unknown>,
  input: { model: FreeModel; maxTokens: number; stream: boolean; user?: string; sessionId?: string | undefined; rules: { allow: readonly string[]; maxPrices: Prices } },
): Record<string, unknown> {
  const payload: Record<string, unknown> = { model: input.model.upstreamModel };
  for (const field of LIQUID_FIELDS) if (body[field] !== undefined) payload[field] = body[field];
  payload.max_tokens = input.maxTokens;
  payload.stream = input.stream;
  if (input.stream) payload.stream_options = { include_usage: true };
  if (input.user) payload.user = input.user;
  if (input.sessionId && SESSION_ID.test(input.sessionId)) payload.session_id = input.sessionId;
  payload.exchange = {
    ...(input.rules.allow.length > 0 ? { candidates: { providers: { allow: [...input.rules.allow] } } } : {}),
    privacy: { retention: "none" },
    limits: {
      price: {
        input_usd_per_mtok: input.rules.maxPrices.input,
        cache_read_usd_per_mtok: input.rules.maxPrices.cached,
        output_usd_per_mtok: input.rules.maxPrices.output,
      },
    },
    session: { sticky: true },
  };
  return payload;
}

/** What the exchange charged for a job, from a response body or the last stream chunk (`exchange.charge.total_usd`). */
export function exchangeCharge(parsed: unknown): number | undefined {
  const total = (parsed as { exchange?: { charge?: { total_usd?: unknown } } } | null)?.exchange?.charge?.total_usd;
  const value = typeof total === "string" ? Number(total) : total;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
