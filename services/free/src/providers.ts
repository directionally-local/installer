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
 * A model can have more than one upstream (models.ts `backups`: GLM 5.3 Flash on Liquid, then
 * Open Relay). `registryRoute` says which of them can serve it now, in order; the model is
 * blocked only when none can. Such a model's access and per-person cap are its own (models.ts
 * `plans`, `ownCaps`; `modelPersonWeeklyUsd.<key>`), and each upstream can hold it to a weekly
 * share of its credit (`modelWeeklyCredit.<provider>.<key>`), so the models on one provider
 * can't starve each other.
 *
 * Nothing here is secret: the keys are only named (`keyEnv`), never read.
 */

import type { FreeConfig, Prices } from "./config.js";
import { DEEPSEEK_MODEL, FREE_MODELS, servedBy, upstreamsOf, type FreeModel } from "./models.js";

export type ProviderId = "openai" | "luminal" | "liquid" | "openrelay";
export const PROVIDER_IDS: readonly ProviderId[] = ["openai", "luminal", "liquid", "openrelay"];

/** How the service talks to it: OpenAI's Responses API, or chat completions. */
export type ApiStyle = "openai-chat" | "openai-responses";

export type ProviderStatus = "on" | "paused";
export const PROVIDER_STATUSES: readonly ProviderStatus[] = ["on", "paused"];

/** Who a registry provider serves: dl Pro only (admins too, for testing), or every plan. */
export type ProviderPlans = "pro" | "all";
export const PROVIDER_PLANS: readonly ProviderPlans[] = ["pro", "all"];

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
  /**
   * Registry only: the per-person weekly cap (`providerPersonWeeklyUsd.<id>`) holds everyone,
   * whatever the plans and opt-in say. Without it the cap holds only while the provider is opt-in
   * or Pro-only (Liquid).
   */
  capsEveryone?: boolean;
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
  {
    id: "openrelay",
    name: "Open Relay",
    website: "https://openrelay.inc/",
    // OpenAI-compatible chat completions (https://docs.openrelay.inc/docs/inference/openai-sdks).
    baseUrl: "https://inference.openrelay.inc/v1",
    apiStyle: "openai-chat",
    keyEnv: "OPENRELAY_API_KEY",
    kind: "registry",
    capsEveryone: true,
  },
];

/** The registry-style providers: the ones with `provider<Setting>.<id>` settings. */
export type RegistryProviderId = "liquid" | "openrelay";

export function providerSpec(id: ProviderId): ProviderSpec {
  return PROVIDERS.find((provider) => provider.id === id)!;
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

export function isRegistryProvider(value: unknown): value is RegistryProviderId {
  return isProviderId(value) && providerSpec(value).kind === "registry";
}

/** A provider's models (its own and the ones it is a backup upstream of), in FREE_MODELS order. */
export function providerModels(id: ProviderId): FreeModel[] {
  return FREE_MODELS.filter((model) => servedBy(model, id));
}

/** The short key a model's own settings use: its id after the last "/" ("glm-5.3-flash"). */
export function modelKey(model: FreeModel): string {
  return model.id.slice(model.id.lastIndexOf("/") + 1);
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
  /**
   * Which plans may use its models: "pro" (dl Pro subscribers and admins only; free accounts get
   * 402 `provider_limit` reason `pro_only`) or "all". With "pro", `personWeeklyUsd` is Pro's
   * weekly ration of it, opt-in or not.
   */
  plans: ProviderPlans;
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
  "providerPlans.liquid": ProviderPlans;
  "providerModels.liquid": readonly string[];
  "exchangeAllow.kimi-k3.1-pro": readonly string[];
  "exchangeMaxPrices.kimi-k3.1-pro": readonly number[];
  "exchangeAllow.glm-5.3": readonly string[];
  "exchangeMaxPrices.glm-5.3": readonly number[];
  "exchangeAllow.glm-5.3-flash": readonly string[];
  "exchangeMaxPrices.glm-5.3-flash": readonly number[];
  /** The most of Liquid's weekly credit one model may use (everyone but admins), USD; undefined: no share of its own. */
  "modelWeeklyCredit.liquid.kimi-k3.1-pro": number | undefined;
  "modelWeeklyCredit.liquid.glm-5.3-flash": number | undefined;
  /** GLM 5.3 Flash's per-person weekly cap, USD, across its upstreams (models.ts `ownCaps`); undefined: none. */
  "modelPersonWeeklyUsd.glm-5.3-flash": number | undefined;
  "providerStatus.openrelay": ProviderStatus;
  "providerCredit.openrelay": number;
  "providerWeeklyCredit.openrelay": number | undefined;
  "providerPersonWeeklyUsd.openrelay": number | undefined;
  "providerOptIn.openrelay": boolean;
  "providerPlans.openrelay": ProviderPlans;
  "providerModels.openrelay": readonly string[];
};

/**
 * The defaults. Liquid: paused until the owner turns it on, $100 of credit, $25 a week, dl Pro
 * only, opt-in, with a $0.25 weekly ration a person (about 140K tokens of Kimi K3.1 Pro). Its $25
 * a week is split so neither model starves the other: Kimi at most $15, GLM 5.3 Flash at most $10
 * (about 300M tokens at the ration mix and munitoai's prices; it costs ~$0.0006 a coding task).
 * GLM 5.3 Flash is free for every plan (models.ts `plans`), whatever `providerPlans.liquid` says.
 * Open Relay: paused until the owner turns it on, $200 of credit, $25 a week (about 8 weeks),
 * every plan, not opt-in. GLM 5.3 Flash: $0.50 a person a week across both upstreams (about 15M
 * tokens at the ration mix; about 9M if nothing is a cache read). Past it, or past both
 * upstreams' budgets, DeepSeek serves.
 */
export const REGISTRY_DEFAULTS: RegistrySettingsConfig = {
  "providerStatus.liquid": "paused",
  "providerCredit.liquid": 100,
  "providerWeeklyCredit.liquid": 25,
  "providerPersonWeeklyUsd.liquid": 0.25,
  "providerOptIn.liquid": true,
  "providerPlans.liquid": "pro",
  "providerModels.liquid": providerModels("liquid")
    .filter((model) => model.enabledByDefault !== false)
    .map((model) => model.id),
  "exchangeAllow.kimi-k3.1-pro": exchangeDefaults("kimi-k3.1-pro").allow,
  "exchangeMaxPrices.kimi-k3.1-pro": pricesList(exchangeDefaults("kimi-k3.1-pro").maxPrices),
  "exchangeAllow.glm-5.3": exchangeDefaults("glm-5.3").allow,
  "exchangeMaxPrices.glm-5.3": pricesList(exchangeDefaults("glm-5.3").maxPrices),
  "exchangeAllow.glm-5.3-flash": exchangeDefaults("glm-5.3-flash").allow,
  "exchangeMaxPrices.glm-5.3-flash": pricesList(exchangeDefaults("glm-5.3-flash").maxPrices),
  "modelWeeklyCredit.liquid.kimi-k3.1-pro": 15,
  "modelWeeklyCredit.liquid.glm-5.3-flash": 10,
  "modelPersonWeeklyUsd.glm-5.3-flash": 0.5,
  "providerStatus.openrelay": "paused",
  "providerCredit.openrelay": 200,
  "providerWeeklyCredit.openrelay": 25,
  "providerPersonWeeklyUsd.openrelay": 0.5,
  "providerOptIn.openrelay": false,
  "providerPlans.openrelay": "all",
  "providerModels.openrelay": providerModels("openrelay")
    .filter((model) => model.enabledByDefault !== false)
    .map((model) => model.id),
};

function exchangeDefaults(upstreamModel: string): { allow: readonly string[]; maxPrices: Prices } {
  const upstream = FREE_MODELS.flatMap(upstreamsOf).find((entry) => entry.upstreamModel === upstreamModel && entry.exchange);
  if (!upstream?.exchange) throw new Error(`no exchange defaults for ${upstreamModel}`);
  return upstream.exchange;
}

function pricesList(prices: Prices): number[] {
  return [prices.input, prices.cached, prices.output];
}

/** The config fields provider settings read. */
export type ProviderConfig = Pick<FreeConfig, "openaiCreditUsd" | "openaiWeeklyCreditUsd" | "luminalCreditUsd" | "luminalWeeklyCreditUsd"> & RegistrySettingsConfig;

export function providerSettings(config: ProviderConfig, id: ProviderId): ProviderSettings {
  const all = (provider: ProviderId) => providerModels(provider).map((model) => model.id);
  if (id === "openai") return { status: "on", creditUsd: config.openaiCreditUsd, weeklyCreditUsd: config.openaiWeeklyCreditUsd, optIn: false, personWeeklyUsd: undefined, plans: "all", models: all("openai") };
  if (id === "luminal") return { status: "on", creditUsd: config.luminalCreditUsd, weeklyCreditUsd: config.luminalWeeklyCreditUsd, optIn: false, personWeeklyUsd: undefined, plans: "all", models: all("luminal") };
  return {
    status: config[`providerStatus.${id}`],
    creditUsd: config[`providerCredit.${id}`],
    weeklyCreditUsd: config[`providerWeeklyCredit.${id}`],
    optIn: config[`providerOptIn.${id}`],
    personWeeklyUsd: config[`providerPersonWeeklyUsd.${id}`],
    plans: config[`providerPlans.${id}`],
    models: config[`providerModels.${id}`],
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
export function providerKey(config: ProviderKeys, id: ProviderId): string | undefined {
  return id === "openai" ? config.openaiApiKey : id === "luminal" ? config.luminalApiKey : id === "liquid" ? config.liquidApiKey : config.openrelayApiKey;
}

/** The config fields that hold the providers' keys. */
export type ProviderKeys = Pick<FreeConfig, "openaiApiKey" | "luminalApiKey" | "liquidApiKey" | "openrelayApiKey">;

/** Credit numbers for every provider: used since the start (everyone, probes included), and this week by everyone but admins. */
export interface ProviderSpend {
  usedUsd: Partial<Record<ProviderId, number>>;
  weekUsd: Partial<Record<ProviderId, number>>;
  /** This week's spend by everyone but admins per model and upstream, keyed `modelSpendKey`. */
  modelWeekUsd?: Partial<Record<string, number>>;
}

/** The key of one model's spend on one upstream in `ProviderSpend.modelWeekUsd`: "liquid:z-ai/glm-5.3-flash". */
export function modelSpendKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}

/** The most of `provider`'s weekly credit `model` may use (`modelWeeklyCredit.<provider>.<key>`), or undefined. */
export function modelWeeklyCap(config: Partial<RegistrySettingsConfig>, model: FreeModel, provider: ProviderId): number | undefined {
  const value = (config as Record<string, unknown>)[`modelWeeklyCredit.${provider}.${modelKey(model)}`];
  return typeof value === "number" ? value : undefined;
}

/**
 * Who may use a model: its own `plans` (GLM 5.3 Flash: "all"), else its provider's
 * `providerPlans.<id>` (Kimi on Liquid: "pro"). The Pro-only rule is per model, never per provider.
 */
export function modelPlans(config: ProviderConfig, model: FreeModel): ProviderPlans {
  if (model.plans) return model.plans;
  return isRegistryProvider(model.provider) ? providerSettings(config, model.provider).plans : "all";
}

/**
 * A person's weekly cap on a model, USD, or undefined for none: a model with `ownCaps` its own
 * (`modelPersonWeeklyUsd.<key>`, every plan, across its upstreams), else its provider's while
 * that caps it (personCapped).
 */
export function personCapUsd(config: ProviderConfig, model: FreeModel): number | undefined {
  if (model.ownCaps) {
    const value = (config as Record<string, unknown>)[`modelPersonWeeklyUsd.${modelKey(model)}`];
    return typeof value === "number" ? value : undefined;
  }
  if (!isRegistryProvider(model.provider)) return undefined;
  const settings = providerSettings(config, model.provider);
  return personCapped(model.provider, settings) ? settings.personWeeklyUsd : undefined;
}

/**
 * Where a person's weekly spend on a model is counted (Directory `personProviderWeek` keys): a
 * model with `ownCaps` under "model:<id>", across its upstreams; any other under its provider.
 */
export function personSpendKey(model: FreeModel): string {
  return model.ownCaps ? `model:${model.id}` : model.provider;
}

/**
 * Why a registry provider's model can't be served right now, or undefined when it can. In order:
 * no key, the provider or the model paused, the credit used up, the weekly budget used, a free
 * account asking for a Pro-only provider (`plan` "free"), the person's weekly cap reached
 * (`personWeekUsd`; admins pass undefined for both). The cap is the opt-in cap, and with `plans`
 * "pro" Pro's weekly ration.
 */
export type ProviderBlock = "no_key" | "paused" | "out_of_credit" | "weekly_budget" | "pro_only" | "person_cap";

export function registryBlock(
  config: ProviderConfig & ProviderKeys,
  model: FreeModel,
  spend: ProviderSpend,
  personWeekUsd?: number,
  plan?: "free" | "pro",
): ProviderBlock | undefined {
  return registryRoute(config, model, spend, personWeekUsd, plan).block;
}

/**
 * Why one upstream of a registry model can't serve it now, or undefined: no key, the provider or
 * the model paused there, its credit used up, its weekly budget used, or the model's own weekly
 * share of it (`modelWeeklyCredit.<provider>.<key>`) used. Nothing about the person.
 */
export function upstreamBlock(config: ProviderConfig & ProviderKeys, model: FreeModel, provider: RegistryProviderId, spend: ProviderSpend): ProviderBlock | undefined {
  const settings = providerSettings(config, provider);
  if (providerKey(config, provider) === undefined) return "no_key";
  if (settings.status !== "on" || !settings.models.includes(model.id)) return "paused";
  if ((spend.usedUsd[provider] ?? 0) >= settings.creditUsd) return "out_of_credit";
  if (settings.weeklyCreditUsd !== undefined && (spend.weekUsd[provider] ?? 0) >= settings.weeklyCreditUsd) return "weekly_budget";
  const share = modelWeeklyCap(config, model, provider);
  if (share !== undefined && (spend.modelWeekUsd?.[modelSpendKey(provider, model.id)] ?? 0) >= share) return "weekly_budget";
  return undefined;
}

/** What `registryRoute` says about a model. */
export interface RegistryRoute {
  /** The upstreams that can serve it now, in the order to try them. */
  upstreams: RegistryProviderId[];
  /** Why it can't serve this caller, or undefined. */
  block?: ProviderBlock;
  /** The upstream the block is about (the model's own provider for a block about the person). */
  blockProvider?: RegistryProviderId;
}

/**
 * Which of a registry model's upstreams can serve it now, and why it can't when none can (or
 * the person can't use it). In order: every upstream's own block (upstreamBlock), then a free
 * account asking for a Pro-only model (`plan` "free"; modelPlans), then the person's weekly cap
 * (`personWeekUsd`, the spend personSpendKey counts; admins pass undefined for both). When no
 * upstream can serve, the block is the first upstream's that a fallback may follow
 * (FALLBACK_BLOCKS: its credit or budget), else the first one with a key, else "no_key".
 */
export function registryRoute(config: ProviderConfig & ProviderKeys, model: FreeModel, spend: ProviderSpend, personWeekUsd?: number, plan?: "free" | "pro"): RegistryRoute {
  if (!isRegistryProvider(model.provider)) return { upstreams: [] };
  const blocks = upstreamsOf(model)
    .filter((upstream): upstream is typeof upstream & { provider: RegistryProviderId } => isRegistryProvider(upstream.provider))
    .map((upstream) => ({ provider: upstream.provider, block: upstreamBlock(config, model, upstream.provider, spend) }));
  const upstreams = blocks.filter((entry) => entry.block === undefined).map((entry) => entry.provider);
  if (upstreams.length === 0) {
    const chosen = blocks.find((entry) => FALLBACK_BLOCKS.includes(entry.block!)) ?? blocks.find((entry) => entry.block !== "no_key") ?? blocks[0]!;
    return { upstreams, block: chosen.block!, blockProvider: chosen.provider };
  }
  if (plan === "free" && modelPlans(config, model) === "pro") return { upstreams, block: "pro_only", blockProvider: model.provider };
  const cap = personCapUsd(config, model);
  if (personWeekUsd !== undefined && cap !== undefined && personWeekUsd >= cap) return { upstreams, block: "person_cap", blockProvider: upstreams[0]! };
  return { upstreams };
}

/**
 * Whether a person's weekly spend on the provider is capped: always for a provider that caps
 * everyone (Open Relay), else while it is opt-in or Pro-only (Pro's ration).
 */
export function personCapped(id: RegistryProviderId, settings: ProviderSettings): boolean {
  return (providerSpec(id).capsEveryone === true || settings.optIn || settings.plans === "pro") && settings.personWeeklyUsd !== undefined;
}

/**
 * The blocks after which a model with a `fallback` (GLM 5.3 Flash) is served by that fallback
 * instead of refused: its upstreams' credit or weekly budgets, or the person's cap. Never a
 * pause or a missing key (the model isn't offered then), nor a Pro-only refusal.
 */
export const FALLBACK_BLOCKS: readonly ProviderBlock[] = ["out_of_credit", "weekly_budget", "person_cap"];

/** Whether a model is for dl Pro only: its own `plans`, else its provider's `providerPlans.<id>` (modelPlans). */
export function proOnly(config: ProviderConfig, model: FreeModel): boolean {
  return isRegistryProvider(model.provider) && modelPlans(config, model) === "pro";
}

/**
 * The token mix a ration in dollars is shown in: a coding agent's typical turn, mostly cache
 * reads. An estimate for "about N tokens", never what is charged (that is the dollars).
 */
export const RATION_MIX = { cached: 0.6, input: 0.32, output: 0.08 } as const;

/**
 * About how many tokens `usd` buys of `model` at its credit prices and RATION_MIX, to two
 * significant digits. A model with its own caps (`ownCaps`: GLM 5.3 Flash, served by upstreams
 * at different prices) at its allowance prices instead: its credit prices are the dearest
 * upstream's ceilings, a worst case, not what it usually costs.
 */
export function approxTokens(model: FreeModel, usd: number): number {
  const prices = model.ownCaps ? model.prices : (model.creditPrices ?? model.prices);
  const perMillion = RATION_MIX.cached * prices.cached + RATION_MIX.input * prices.input + RATION_MIX.output * prices.output;
  if (!(usd > 0) || !(perMillion > 0)) return 0;
  const tokens = (usd / perMillion) * 1_000_000;
  const step = 10 ** Math.max(0, Math.floor(Math.log10(tokens)) - 1);
  return Math.round(tokens / step) * step;
}

/** A person's weekly ration of a Pro-only model: its dollars, what is used, and about how many tokens. */
export interface Ration {
  usdPerWeek: number;
  usedUsd: number;
  remainingUsd: number;
  approxTokensPerWeek: number;
  approxTokensLeft: number;
}

/** The ration of `model` for someone who spent `usedUsd` of the provider this week; undefined with no per-person cap. */
export function rationOf(config: ProviderConfig, model: FreeModel, usedUsd: number): Ration | undefined {
  if (!isRegistryProvider(model.provider)) return undefined;
  const cap = personCapUsd(config, model);
  if (cap === undefined) return undefined;
  const used = Math.min(cap, Math.max(0, usedUsd));
  const remaining = Math.max(0, cap - used);
  return { usdPerWeek: cap, usedUsd: round6(used), remainingUsd: round6(remaining), approxTokensPerWeek: approxTokens(model, cap), approxTokensLeft: approxTokens(model, remaining) };
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * The models the service offers at all: every model of OpenAI and Luminal, and a registry
 * model once one of its upstreams has a key and the model is on there. Before then a registry
 * model is invisible: not in /v1/status, /v1/me or /v1/models, as if it weren't defined.
 */
export function offeredModels(config: ProviderConfig & ProviderKeys): FreeModel[] {
  return FREE_MODELS.filter((model) => !isRegistryProvider(model.provider) || listedUpstream(config, model) !== undefined);
}

/**
 * The upstreams a registry model is configured on (a key, and on in `providerModels.<id>`), in
 * order, whatever their credit: the first is where /v1/providers lists it, the rest its backups.
 */
export function configuredUpstreams(config: ProviderConfig & ProviderKeys, model: FreeModel): RegistryProviderId[] {
  return upstreamsOf(model)
    .map((upstream) => upstream.provider)
    .filter((provider): provider is RegistryProviderId => isRegistryProvider(provider) && providerKey(config, provider) !== undefined && providerSettings(config, provider).models.includes(model.id));
}

/** The upstream a registry model is listed under (the first configured one), or undefined when none is. */
export function listedUpstream(config: ProviderConfig & ProviderKeys, model: FreeModel): RegistryProviderId | undefined {
  return configuredUpstreams(config, model)[0];
}

/** What /v1/providers says about a model's access. */
export type Access = "free" | "trusted" | "opt-in" | "pro";

export function accessOf(config: ProviderConfig, model: FreeModel): Access {
  if (model.family === "gpt6") return "trusted";
  if (!isRegistryProvider(model.provider)) return "free";
  // A model's own plans (GLM 5.3 Flash) override its provider's plans and opt-in.
  if (model.plans) return model.plans === "pro" ? "pro" : "free";
  const settings = providerSettings(config, model.provider);
  return settings.plans === "pro" ? "pro" : settings.optIn ? "opt-in" : "free";
}

/** What the Pro-only lines need: the ration's size, the Upgrade link (null while Pro isn't offered) and when the week resets. */
export interface ProLimitContext {
  approxTokensPerWeek?: number;
  upgradeUrl?: string | null;
  /** The week's end, ISO. */
  resetsAt?: string | null;
  /** A paying plan's request (dl.new plans, a trial): the lines say nothing about free tokens. */
  paid?: boolean;
}

/** "Monday 30 Nov, 00:00 UTC": when a week ending at `iso` resets. */
export function resetDay(iso: string): string {
  const date = new Date(iso);
  const weekday = date.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  const day = date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  return `${weekday} ${day}, 00:00 UTC`;
}

/** "about 140K tokens a week" (the ration's size), or "" without one. */
function rationPhrase(tokens: number | undefined): string {
  return tokens && tokens > 0 ? `about ${formatRationTokens(tokens)} tokens a week` : "";
}

/** 140000 → "140K", 1200000 → "1.2M". */
export function formatRationTokens(n: number): string {
  const trim = (v: number) => v.toFixed(1).replace(/\.0$/, "");
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim(n / 1_000)}K`;
  return String(Math.round(n));
}

/**
 * The 402 a blocked registry model gets: the same shape as `gpt_limit`, with DeepSeek as the
 * alternative. `plans` "pro" changes two lines: a free account's (`pro_only`) names the Pro perk
 * and its Upgrade link, and Pro's used-up ration (`person_cap`) says when it resets. `paid` (a
 * plan's request) drops the free-token wording from the provider's own blocks.
 */
export function providerLimitMessage(model: FreeModel, block: ProviderBlock, providerName: string, plans: ProviderPlans = "all", pro: ProLimitContext = {}): string {
  const use = `Use ${DEEPSEEK_MODEL} instead: /model.`;
  // Plain "DeepSeek": the alternative's id is in the error's `alternative`.
  const deepseek = "DeepSeek";
  const free = pro.paid ? "" : "free ";
  switch (block) {
    case "no_key":
    case "paused":
      return `${model.name} on ${providerName} is paused${pro.paid ? "" : " for free tokens"} right now. ${use}`;
    case "out_of_credit":
      return `${model.name} on ${providerName} is out of ${free}credit for now. ${use}`;
    case "weekly_budget": {
      const resets = pro.resetsAt ? ` It resets on ${resetDay(pro.resetsAt)}.` : "";
      return `${model.name} on ${providerName} has used its ${free}budget for this week.${resets} ${use}`;
    }
    case "pro_only": {
      const ration = rationPhrase(pro.approxTokensPerWeek);
      if (!pro.upgradeUrl) return `${model.name} is for dl Pro subscribers only. ${use}`;
      return ration ? `${model.name} is a dl Pro perk: ${ration}, then ${deepseek}. Upgrade: ${pro.upgradeUrl}` : `${model.name} is a dl Pro perk. Upgrade: ${pro.upgradeUrl}`;
    }
    case "person_cap": {
      if (plans !== "pro") {
        const ration = rationPhrase(pro.approxTokensPerWeek);
        const resets = pro.resetsAt ? ` It resets on ${resetDay(pro.resetsAt)}.` : "";
        return `You've used this week's free ${model.name}${ration ? ` (${ration})` : ""}.${resets} ${use}`;
      }
      const ration = rationPhrase(pro.approxTokensPerWeek);
      const resets = pro.resetsAt ? ` It resets on ${resetDay(pro.resetsAt)}` : " It resets next week";
      return `You've used this week's ${model.name} with dl Pro${ration ? ` (${ration})` : ""}.${resets}; ${deepseek} keeps working: /model.`;
    }
  }
}

/**
 * The one line a request served by a model's fallback carries (header `x-dl-notice`), when the
 * requested model's provider was at a limit (FALLBACK_BLOCKS): what ran out, which model served
 * instead, and when the requested one is back. `resetsAt` (ISO) is the week's end, for the weekly
 * blocks; out of credit has no reset day.
 */
export function providerFallbackNotice(model: FreeModel, block: ProviderBlock, providerName: string, fallbackName: string, input: { resetsAt?: string | null; approxTokensPerWeek?: number; paid?: boolean } = {}): string {
  const until = input.resetsAt ? ` until it resets on ${resetDay(input.resetsAt)}` : " for now";
  const free = input.paid ? "" : "free ";
  if (block === "person_cap") {
    const ration = rationPhrase(input.approxTokensPerWeek);
    return `You've used this week's free ${model.name}${ration ? ` (${ration})` : ""}; ${fallbackName} serves${until}.`;
  }
  if (block === "weekly_budget") return `${model.name} on ${providerName} has used its ${free}budget for this week; ${fallbackName} serves${until}.`;
  return `${model.name} on ${providerName} is out of ${free}credit; ${fallbackName} serves for now.`;
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

/**
 * The `exchange` block Liquid puts on a response body and on a stream's last chunk. Seen live
 * (2026-11-23): `job_id`, `provider_slug`, `offer_id`, `status`, `created_at`, `charge`, `usage`,
 * `timing`, `addressing`, `failure`. Field names from the OpenAPI schemas ExchangeCharge,
 * ExchangeUsage and ExchangeTiming (https://router.inference.ai.exchange/v1/openapi.json).
 */
function exchangeBlock(parsed: unknown): Record<string, unknown> | undefined {
  const block = (parsed as { exchange?: unknown } | null)?.exchange;
  return block && typeof block === "object" && !Array.isArray(block) ? (block as Record<string, unknown>) : undefined;
}

function usdField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const raw = record?.[key];
  const value = typeof raw === "string" ? Number(raw) : raw;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * What the exchange charged for a job. Live, the last chunk's `charge` had no `total_usd`, and
 * `supplier_usd` and `fee_usd` were still 0 (settled later), so in order: `total_usd` when above
 * 0, else `supplier_usd + fee_usd` when above 0, else `estimated_usd` when above 0; undefined
 * otherwise (the caller then charges the price ceilings plus the fee).
 */
export function exchangeCharge(parsed: unknown): number | undefined {
  const charge = exchangeBlock(parsed)?.charge as Record<string, unknown> | undefined;
  if (!charge || typeof charge !== "object") return undefined;
  const total = usdField(charge, "total_usd");
  if (total !== undefined && total > 0) return total;
  const settled = (usdField(charge, "supplier_usd") ?? 0) + (usdField(charge, "fee_usd") ?? 0);
  if (settled > 0) return settled;
  const estimated = usdField(charge, "estimated_usd");
  return estimated !== undefined && estimated > 0 ? estimated : undefined;
}

/**
 * What the seller metered (`exchange.usage`), as the standard usage names. Live, the standard
 * `usage` chunk of a Kimi stream said `completion_tokens: 0` although text came back, so this is
 * what counts when present. `reasoning_tokens` ("hidden reasoning tokens, billed as output" in the
 * docs) is added to `completion_tokens`: whether the latter already includes it is unverified, and
 * counting it twice can only overcount a reasoning model's output, never undercount it.
 */
export function exchangeUsage(parsed: unknown): { promptTokens: number; completionTokens: number; cachedTokens: number } | undefined {
  const usage = exchangeBlock(parsed)?.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return undefined;
  const count = (key: string) => {
    const value = usage[key];
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  };
  const prompt = count("prompt_tokens");
  const completion = count("completion_tokens");
  if (prompt === undefined || completion === undefined) return undefined;
  return { promptTokens: prompt, completionTokens: completion + (count("reasoning_tokens") ?? 0), cachedTokens: Math.min(prompt, count("cached_tokens") ?? 0) };
}

/** The seller and the exchange's own timing of a job (`provider_slug`, `timing.ttft_ms`, `timing.tokens_per_second`). */
export function exchangeFacts(parsed: unknown): { seller?: string; ttftMs?: number; tokensPerSecond?: number } | undefined {
  const block = exchangeBlock(parsed);
  if (!block) return undefined;
  const timing = (block.timing && typeof block.timing === "object" ? block.timing : {}) as Record<string, unknown>;
  const seller = typeof block.provider_slug === "string" && /^[\x20-\x7e]{1,64}$/.test(block.provider_slug) ? block.provider_slug : undefined;
  const ttft = usdField(timing, "ttft_ms") ?? usdField(timing, "first_event_ms");
  const tps = usdField(timing, "tokens_per_second");
  return { ...(seller ? { seller } : {}), ...(ttft !== undefined ? { ttftMs: Math.round(ttft) } : {}), ...(tps !== undefined ? { tokensPerSecond: tps } : {}) };
}

/**
 * The usage to charge: the standard `usage`, raised to the exchange's metering where that says
 * more (each count the larger of the two). Either alone when the other is missing.
 */
export function mergedUsage<T extends { promptTokens: number; completionTokens: number; cachedTokens: number }>(standard: T | undefined, exchange: { promptTokens: number; completionTokens: number; cachedTokens: number } | undefined): T | undefined {
  if (!exchange) return standard;
  if (!standard) return { ...exchange, costUsd: undefined } as unknown as T;
  return {
    ...standard,
    promptTokens: Math.max(standard.promptTokens, exchange.promptTokens),
    completionTokens: Math.max(standard.completionTokens, exchange.completionTokens),
    cachedTokens: Math.max(standard.cachedTokens, exchange.cachedTokens),
  };
}

// ─── Open Relay requests ─────────────────────────────────────────────────────

/**
 * The fields of a client's chat request passed to Open Relay. Its gateway ignores parameters it
 * doesn't support rather than refusing them (https://docs.openrelay.inc/docs/inference/chat-completions),
 * but only the standard ones go: nothing OpenRouter-specific, and no client `user` or `metadata`.
 */
export const OPENRELAY_FIELDS = ["messages", "tools", "tool_choice", "parallel_tool_calls", "response_format", "temperature", "top_p", "stop", "seed", "frequency_penalty", "presence_penalty", "reasoning_effort"] as const;

/**
 * A chat completions body for Open Relay: the client's fields above, Open Relay's model id, the
 * reservation's output limit as `max_tokens`, usage on streams (the gateway adds it anyway), and
 * the person's hashed id as `user` (never the GitHub id). OpenRouter's `reasoning: {effort}`
 * becomes `reasoning_effort`.
 */
export function openRelayPayload(body: Record<string, unknown>, input: { model: FreeModel; maxTokens: number; stream: boolean; user?: string }): Record<string, unknown> {
  const payload: Record<string, unknown> = { model: input.model.upstreamModel };
  for (const field of OPENRELAY_FIELDS) if (body[field] !== undefined) payload[field] = body[field];
  const effort = (body.reasoning as { effort?: unknown } | null | undefined)?.effort;
  if (typeof effort === "string" && payload.reasoning_effort === undefined) payload.reasoning_effort = effort;
  payload.max_tokens = input.maxTokens;
  payload.stream = input.stream;
  if (input.stream) payload.stream_options = { include_usage: true };
  if (input.user) payload.user = input.user;
  return payload;
}

/** Nano-USD a dollar: Open Relay reports cost in billionths of a dollar. */
const NANO_PER_USD = 1_000_000_000;

/**
 * What Open Relay charged for a request, USD: `openrelay.cost_nano_usd` on a response body and on
 * a stream's last chunk (seen live 2026-11-24, with `priced_at: "online"`), or the
 * `OpenRelay-Cost-Nano-USD` header (non-streamed responses). Undefined when neither says, or
 * says 0 (the caller then charges the usage at the model's prices).
 */
export function openRelayCharge(parsed: unknown, header?: string | null): number | undefined {
  const block = (parsed as { openrelay?: unknown } | null)?.openrelay;
  const raw = block && typeof block === "object" && !Array.isArray(block) ? (block as Record<string, unknown>).cost_nano_usd : undefined;
  const fromBody = typeof raw === "string" ? Number(raw) : raw;
  const nano = typeof fromBody === "number" && Number.isFinite(fromBody) ? fromBody : header ? Number(header) : NaN;
  return Number.isFinite(nano) && nano > 0 ? nano / NANO_PER_USD : undefined;
}

/** What a provider reported it charged for a request: Liquid's `exchange.charge`, or Open Relay's cost. */
export function reportedCharge(parsed: unknown, header?: string | null): number | undefined {
  return exchangeCharge(parsed) ?? openRelayCharge(parsed, header);
}
