/**
 * The model provider a place uses, as Autopilot's own `connect` flow chooses it. dl never
 * picks providers or models itself: `autopilot connect --state-file PATH` runs Autopilot's
 * provider picker, key entry and model picker, then writes what was chosen to PATH. dl reads
 * it, pushes the key into Hotcell's keystore on the place (`hotcell keys add <id> --stdin`),
 * writes the provider into the Aster server config (aster.json), and keeps the model.
 * Shared by the laptop, "on this computer", and the server's `dl up`.
 */

/** What `autopilot connect --state-file` writes (mode 0600), once the user has chosen. */
export interface ConnectResult {
  provider: string;
  name: string;
  baseUrl: string;
  apiKey: string | null;
  apiKeyEnv: string | null;
  keyRequired: boolean;
  model: string;
  authHeader?: string;
  authFormat?: string;
}

/** The provider as it travels to a place: `dl up --answers-stdin`, or "on this computer". */
export interface ProviderAnswer {
  id: string;
  baseUrl: string;
  /** null for a keyless provider (ollama, lmstudio). */
  apiKey: string | null;
  apiKeyEnv: string | null;
  authHeader?: string;
  authFormat?: string;
  /** For the one-line summary; not stored. */
  name?: string;
}

/** The `provider` block of aster.json. Absent means OpenRouter. */
export interface ProviderConfig {
  id: string;
  baseUrl: string;
  apiKeyEnv: string;
}

export const OPENROUTER: ProviderConfig & { name: string } = { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" };

/** Providers Hotcell has a built-in route for; any other id needs --base-url (a custom provider). */
export const BUILT_IN_PROVIDERS: readonly string[] = [
  "openai", "deepseek", "moonshot", "anthropic", "gemini", "minimax", "xai", "mistral", "groq", "cerebras", "together", "fireworks",
  "deepinfra", "vercel", "kimi-code", "zai", "zai-coding", "ollama", "lmstudio", "requesty", "openrouter",
];

/** Providers that take no key at all. */
export const KEYLESS_PROVIDERS: readonly string[] = ["ollama", "lmstudio"];

/**
 * Where the built-in providers live, for `dl keys set <id>` on a server (which has no
 * Autopilot picker to ask). The laptop's setup always carries the address `connect` reported.
 */
export const KNOWN_PROVIDERS: Record<string, { name: string; baseUrl: string; apiKeyEnv: string }> = {
  openrouter: { name: "OpenRouter", baseUrl: OPENROUTER.baseUrl, apiKeyEnv: OPENROUTER.apiKeyEnv },
  openai: { name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" },
  deepseek: { name: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY" },
  moonshot: { name: "Moonshot", baseUrl: "https://api.moonshot.ai/v1", apiKeyEnv: "MOONSHOT_API_KEY" },
  anthropic: { name: "Anthropic", baseUrl: "https://api.anthropic.com/v1", apiKeyEnv: "ANTHROPIC_API_KEY" },
  gemini: { name: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKeyEnv: "GEMINI_API_KEY" },
  minimax: { name: "MiniMax", baseUrl: "https://api.minimax.io/v1", apiKeyEnv: "MINIMAX_API_KEY" },
  xai: { name: "xAI", baseUrl: "https://api.x.ai/v1", apiKeyEnv: "XAI_API_KEY" },
  mistral: { name: "Mistral", baseUrl: "https://api.mistral.ai/v1", apiKeyEnv: "MISTRAL_API_KEY" },
  groq: { name: "Groq", baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY" },
  cerebras: { name: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", apiKeyEnv: "CEREBRAS_API_KEY" },
  together: { name: "Together", baseUrl: "https://api.together.xyz/v1", apiKeyEnv: "TOGETHER_API_KEY" },
  fireworks: { name: "Fireworks", baseUrl: "https://api.fireworks.ai/inference/v1", apiKeyEnv: "FIREWORKS_API_KEY" },
  deepinfra: { name: "DeepInfra", baseUrl: "https://api.deepinfra.com/v1/openai", apiKeyEnv: "DEEPINFRA_API_KEY" },
  vercel: { name: "Vercel AI Gateway", baseUrl: "https://ai-gateway.vercel.sh/v1", apiKeyEnv: "AI_GATEWAY_API_KEY" },
  requesty: { name: "Requesty", baseUrl: "https://router.requesty.ai/v1", apiKeyEnv: "REQUESTY_API_KEY" },
  zai: { name: "Z.ai", baseUrl: "https://api.z.ai/api/paas/v4", apiKeyEnv: "ZAI_API_KEY" },
  ollama: { name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", apiKeyEnv: "OLLAMA_API_KEY" },
  lmstudio: { name: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", apiKeyEnv: "LMSTUDIO_API_KEY" },
};

export const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** DEEPSEEK_API_KEY for deepseek, MY_PROXY_API_KEY for my-proxy: the name Autopilot uses for a provider's key. */
export function defaultApiKeyEnv(id: string): string {
  return `${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

export function isKeyless(provider: Pick<ProviderAnswer, "id" | "apiKey">): boolean {
  return provider.apiKey === null && KEYLESS_PROVIDERS.includes(provider.id);
}

/** Reads what `autopilot connect --state-file` wrote; a parse error never quotes the text (it holds a key). */
export function parseConnectState(text: string): ConnectResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Autopilot's connect state isn't valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Autopilot's connect state must be one JSON object.");
  const record = parsed as Record<string, unknown>;
  const str = (key: string, required = true): string => {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (!required) return "";
    throw new Error(`Autopilot's connect state lacks "${key}".`);
  };
  const nullable = (key: string): string | null => {
    const value = record[key];
    if (value === null || value === undefined) return null;
    if (typeof value !== "string") throw new Error(`Autopilot's connect state has a non-string "${key}".`);
    return value.trim() || null;
  };
  const provider = str("provider").toLowerCase();
  if (!PROVIDER_ID_RE.test(provider)) throw new Error("Autopilot's connect state names a provider dl can't use.");
  const apiKey = nullable("apiKey");
  const keyRequired = record.keyRequired === undefined ? !KEYLESS_PROVIDERS.includes(provider) : record.keyRequired === true;
  if (keyRequired && !apiKey) throw new Error(`Autopilot's connect state has no key for ${provider}.`);
  return {
    provider,
    name: str("name", false) || KNOWN_PROVIDERS[provider]?.name || provider,
    baseUrl: str("baseUrl", false) || KNOWN_PROVIDERS[provider]?.baseUrl || "",
    apiKey,
    // What Autopilot wrote, null included; only an absent field is filled in from what dl knows.
    apiKeyEnv: "apiKeyEnv" in record ? nullable("apiKeyEnv") : KNOWN_PROVIDERS[provider]?.apiKeyEnv ?? null,
    keyRequired,
    model: str("model"),
    ...(str("authHeader", false) ? { authHeader: str("authHeader", false) } : {}),
    ...(str("authFormat", false) ? { authFormat: str("authFormat", false) } : {}),
  };
}

/** What setup sends to a place, from what Autopilot chose. */
export function providerAnswer(result: ConnectResult): ProviderAnswer {
  return {
    id: result.provider,
    name: result.name,
    baseUrl: result.baseUrl,
    apiKey: result.apiKey,
    apiKeyEnv: result.apiKeyEnv,
    ...(result.authHeader ? { authHeader: result.authHeader } : {}),
    ...(result.authFormat ? { authFormat: result.authFormat } : {}),
  };
}

/** The `openrouterKey` an older laptop or `DL_OPENROUTER_API_KEY` gives, as a provider answer. */
export function openrouterAnswer(apiKey: string): ProviderAnswer {
  return { id: OPENROUTER.id, name: OPENROUTER.name, baseUrl: OPENROUTER.baseUrl, apiKey, apiKeyEnv: OPENROUTER.apiKeyEnv };
}

/**
 * The `provider` field of `--answers-stdin`, or an unattended install's DL_PROVIDER /
 * DL_PROVIDER_API_KEY / DL_PROVIDER_BASE_URL. Errors never quote values.
 */
export function parseProviderAnswer(value: unknown): ProviderAnswer {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error('The answer "provider" must be an object like {"id": "deepseek", "apiKey": "…"}.');
  const record = value as Record<string, unknown>;
  const text = (key: string): string | undefined => {
    const field = record[key];
    if (field === undefined || field === null) return undefined;
    if (typeof field !== "string") throw new Error(`The provider's "${key}" must be a string.`);
    return field.trim() || undefined;
  };
  const id = text("id")?.toLowerCase();
  if (!id || !PROVIDER_ID_RE.test(id)) throw new Error("The provider needs an id (lowercase letters, digits, dashes).");
  const known = KNOWN_PROVIDERS[id];
  const baseUrl = text("baseUrl") ?? known?.baseUrl;
  if (!baseUrl) throw new Error(`The provider ${id} needs a baseUrl.`);
  if (!/^https?:\/\//.test(baseUrl)) throw new Error(`The provider's baseUrl must start with http:// or https://.`);
  const apiKey = text("apiKey") ?? null;
  if (!apiKey && !KEYLESS_PROVIDERS.includes(id)) throw new Error(`The provider ${id} needs an apiKey.`);
  return {
    id,
    baseUrl,
    apiKey,
    apiKeyEnv: text("apiKeyEnv") ?? known?.apiKeyEnv ?? defaultApiKeyEnv(id),
    ...(text("name") ? { name: text("name") } : {}),
    ...(text("authHeader") ? { authHeader: text("authHeader") } : {}),
    ...(text("authFormat") ? { authFormat: text("authFormat") } : {}),
  };
}

/** A built-in provider's route needs only its id; a custom one needs its address (and auth shape, if unusual). */
export function hotcellKeysAddArgs(provider: ProviderAnswer): string[] {
  const args = ["keys", "add", provider.id];
  if (provider.apiKey) args.push("--stdin");
  if (!BUILT_IN_PROVIDERS.includes(provider.id)) {
    args.push("--base-url", provider.baseUrl);
    if (provider.authHeader) args.push("--auth-header", provider.authHeader);
    if (provider.authFormat) args.push("--auth-format", provider.authFormat);
  }
  return args;
}

/** The provider block aster.json carries. */
export function providerConfig(provider: Pick<ProviderAnswer, "id" | "baseUrl" | "apiKeyEnv">): ProviderConfig {
  return {
    id: provider.id,
    baseUrl: provider.baseUrl,
    apiKeyEnv: provider.apiKeyEnv ?? defaultApiKeyEnv(provider.id),
  };
}

/**
 * aster.json with the provider block set (and the catalog as its model list), keeping
 * everything else in the file (workspaces, an operator's own settings). A missing or
 * damaged file starts from `fallback`.
 */
export function asterConfigWithProvider(existing: string | undefined, provider: ProviderConfig, fallback: Record<string, unknown>): string {
  let config: Record<string, unknown> = fallback;
  if (existing) {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) config = parsed as Record<string, unknown>;
    } catch {
      // Rewritten from the fallback.
    }
  }
  return `${JSON.stringify({ ...config, provider, models: "catalog" }, null, 2)}\n`;
}

/** The provider aster.json names; OpenRouter when it names none (older installs). */
export function providerFromAsterConfig(text: string | undefined): ProviderConfig {
  if (!text) return { id: OPENROUTER.id, baseUrl: OPENROUTER.baseUrl, apiKeyEnv: OPENROUTER.apiKeyEnv };
  try {
    const parsed = JSON.parse(text) as { provider?: { id?: unknown; baseUrl?: unknown; apiKeyEnv?: unknown } };
    const block = parsed.provider;
    if (block && typeof block.id === "string" && block.id.trim()) {
      return {
        id: block.id.trim(),
        baseUrl: typeof block.baseUrl === "string" ? block.baseUrl : KNOWN_PROVIDERS[block.id.trim()]?.baseUrl ?? "",
        apiKeyEnv: typeof block.apiKeyEnv === "string" ? block.apiKeyEnv : providerConfig({ id: block.id.trim(), baseUrl: "", apiKeyEnv: null }).apiKeyEnv,
      };
    }
  } catch {
    // An unreadable config means the default.
  }
  return { id: OPENROUTER.id, baseUrl: OPENROUTER.baseUrl, apiKeyEnv: OPENROUTER.apiKeyEnv };
}

/** One route of `hotcell keys ls --json`. */
export interface HotcellRoute {
  provider: string;
  active: boolean;
  /** Hotcell's mask of the key (sk-or…ab), when it reports one. */
  mask?: string;
}

/**
 * Routes from `hotcell keys ls --json`. Hotcell 0.1.38+ prints {"routes":[{name, active, hasKey, …}]}
 * (the route's id is `name`); `provider`/`id` and a bare array are accepted too. Falls back to
 * the plain listing (`provider  mask  source` rows) of an older Hotcell.
 */
export function parseHotcellRoutes(stdout: string): HotcellRoute[] {
  const plain = stdout.replace(/\x1b\[[0-9;]*m/g, "").trim();
  const asRoutes = (value: unknown): HotcellRoute[] | undefined => {
    const list = Array.isArray(value) ? value : typeof value === "object" && value !== null && Array.isArray((value as { routes?: unknown }).routes) ? (value as { routes: unknown[] }).routes : undefined;
    if (!list) return undefined;
    return list.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const record = entry as Record<string, unknown>;
      const provider = ["name", "provider", "id"].map((key) => record[key]).find((value): value is string => typeof value === "string" && value.length > 0);
      if (!provider) return [];
      const mask = ["mask", "key", "masked"].map((key) => record[key]).find((value) => typeof value === "string" && value.length <= 12) as string | undefined;
      return [{ provider, active: record.active !== false, ...(mask ? { mask } : {}) }];
    });
  };
  for (const line of [plain, ...plain.split("\n").reverse()]) {
    try {
      const routes = asRoutes(JSON.parse(line));
      if (routes) return routes;
    } catch {
      // not JSON
    }
  }
  const routes: HotcellRoute[] = [];
  for (const row of plain.split("\n").map((line) => line.trim().split(/\s+/))) {
    const [provider, mask] = row;
    if (!provider || /^(PROVIDER|no)$/i.test(provider) || !PROVIDER_ID_RE.test(provider)) continue;
    routes.push({ provider, active: true, ...(mask && mask.length <= 12 && (mask.includes("…") || /^•+$/.test(mask)) ? { mask } : {}) });
  }
  return routes;
}

/** "DeepSeek · deepseek-v4-pro", for the one line setup shows after Autopilot's picker. */
export function describeProvider(provider: { name?: string; id: string }, model?: string): string {
  const name = provider.name ?? KNOWN_PROVIDERS[provider.id]?.name ?? provider.id;
  return model ? `${name} · ${model}` : name;
}
