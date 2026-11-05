import type { Upstream } from "./config.js";

/**
 * Which upstream serves a request: Luminal when it has a key and is the setting; OpenRouter only
 * when the service has an OpenRouter key at all (production has none: the free tier must never
 * spend the owner's OpenRouter credit); otherwise none.
 */
export function chooseUpstream(primary: string, config: { luminalApiKey: string | undefined; openRouterApiKey: string | undefined }): Upstream | undefined {
  if (config.luminalApiKey && (primary === "luminal" || !config.openRouterApiKey)) return "luminal";
  return config.openRouterApiKey ? "openrouter" : undefined;
}
