import type { Upstream } from "./config.js";

/**
 * Which provider serves a request. A model's own provider always serves it (see models.ts);
 * this decides what happens when that provider has no key, and what /v1/status and the admin
 * pages call "serving".
 */

export interface ProviderKeys {
  openaiApiKey?: string | undefined;
  luminalApiKey?: string | undefined;
  openRouterApiKey?: string | undefined;
}

/** Whether a provider has a key, so it can serve at all. */
export function providerConfigured(provider: Upstream, keys: ProviderKeys): boolean {
  if (provider === "openai") return keys.openaiApiKey !== undefined;
  if (provider === "luminal") return keys.luminalApiKey !== undefined;
  return keys.openRouterApiKey !== undefined;
}

/**
 * Which provider serves by default: the setting when it has a key, else the first provider
 * that does (OpenAI, then Luminal, then OpenRouter). Undefined when none can serve.
 */
export function chooseUpstream(primary: string, keys: ProviderKeys): Upstream | undefined {
  if ((primary === "openai" || primary === "luminal" || primary === "openrouter") && providerConfigured(primary, keys)) return primary;
  for (const provider of ["openai", "luminal", "openrouter"] as const) if (providerConfigured(provider, keys)) return provider;
  return undefined;
}
