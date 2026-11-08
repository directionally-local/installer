import { readFile } from "node:fs/promises";
import { defaultApiKeyEnv, KEYLESS_PROVIDERS, KNOWN_PROVIDERS, PROVIDER_ID_RE } from "../provider.js";
import { autopilotConfigFile, FREE_TIER_DEFAULT_URL, FREE_TIER_PROVIDER, loginFromToken } from "./free-tier.js";

/**
 * What Autopilot already has chosen, so `dl run`/`dl setup` can reuse it instead of asking the
 * same provider question a second time. Read from Autopilot's own config.json (the file its
 * `connect` picker writes), never from the environment: the place should get what the user
 * picked in Autopilot, not a shell override.
 *
 * The free tier is special: its saved key is a one-hour access token, so it is never copied to
 * a place. Instead a server key is created for the place (POST /v1/keys) and that is stored.
 */

/** A provider Autopilot has chosen, ready to store on a place. */
export interface ReusedProvider {
  provider: string;
  name: string;
  baseUrl: string;
  /** null for a keyless provider (ollama, lmstudio). */
  apiKey: string | null;
  apiKeyEnv: string | null;
  keyRequired: boolean;
  model?: string;
  authHeader?: string;
  authFormat?: string;
}

/** The free tier signed in to Autopilot: a server key must be made for the place. */
export interface FreeTierReuse {
  kind: "free-tier";
  /** The service origin, e.g. https://free.directionallylocal.com (no /v1). */
  origin: string;
  /** The one-hour access token Autopilot saved; used only to create the server key. */
  accessToken: string;
  model?: string;
  login?: string;
}

export type AutopilotProvider = { kind: "provider"; result: ReusedProvider } | FreeTierReuse;

export interface ReadProviderOptions {
  env?: NodeJS.ProcessEnv;
  /** Reads Autopilot's config.json; the real file unless replaced. */
  readFile?: (path: string) => Promise<string | undefined>;
  exists?: (path: string) => boolean;
}

/**
 * The provider Autopilot has chosen, or undefined when it has none it can hand over (nothing
 * picked yet, no key for a provider that needs one, an unreadable config). Never throws.
 */
export async function readAutopilotProvider(options: ReadProviderOptions = {}): Promise<AutopilotProvider | undefined> {
  const env = options.env ?? process.env;
  const read = options.readFile ?? ((path) => readFile(path, "utf8").catch(() => undefined));
  const contents = await read(autopilotConfigFile(env, options.exists)).catch(() => undefined);
  if (!contents) return undefined;
  let config: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(contents);
    if (!isRecord(parsed)) return undefined;
    config = parsed;
  } catch {
    return undefined;
  }
  const providers = isRecord(config.providers) ? config.providers : {};
  const id = activeProviderId(config);
  const saved = isRecord(providers[id]) ? providers[id] : {};
  // Autopilot's own resolution: the provider's model, else the global one when this provider owns it.
  const model = text(saved.model) ?? (savedFor(config) === id ? text(config.model) : undefined);

  if (id === FREE_TIER_PROVIDER) {
    const accessToken = text(saved.apiKey);
    if (!accessToken) return undefined;
    const origin = serviceOrigin(text(saved.baseUrl) ?? env.AUTOPILOT_DL_FREE_URL);
    if (!origin) return undefined;
    const login = loginFromToken(accessToken);
    return { kind: "free-tier", origin, accessToken, ...(model ? { model } : {}), ...(login ? { login } : {}) };
  }

  const apiKey = providerKey(id, config, saved);
  const keyRequired = !KEYLESS_PROVIDERS.includes(id);
  if (keyRequired && !apiKey) return undefined;
  const baseUrl = id === "custom" ? text(config.baseUrl) : text(saved.baseUrl) ?? KNOWN_PROVIDERS[id]?.baseUrl;
  if (!baseUrl) return undefined;
  return {
    kind: "provider",
    result: {
      provider: id,
      name: text(saved.name) ?? KNOWN_PROVIDERS[id]?.name ?? id,
      baseUrl,
      apiKey: apiKey ?? null,
      apiKeyEnv: text(saved.apiKeyEnv) ?? KNOWN_PROVIDERS[id]?.apiKeyEnv ?? defaultApiKeyEnv(id),
      keyRequired,
      ...(model ? { model } : {}),
      ...(text(saved.authHeader) ? { authHeader: text(saved.authHeader)! } : {}),
      ...(text(saved.authFormat) ? { authFormat: text(saved.authFormat)! } : {}),
    },
  };
}

/** The active provider's id, as Autopilot resolves it from the saved config (no environment). */
function activeProviderId(config: Record<string, unknown>): string {
  const provider = text(config.provider)?.toLowerCase();
  if (provider && PROVIDER_ID_RE.test(provider)) return provider;
  return savedFor(config);
}

/** The provider the saved config most likely belongs to, when `provider` isn't set (older configs). */
function savedFor(config: Record<string, unknown>): string {
  if (text(config.baseUrl)) return "custom";
  if (text(config.openrouterApiKey)) return "openrouter";
  if (text(config.requestyApiKey)) return "requesty";
  return "openrouter";
}

/** The key Autopilot would use for this provider, from where it keeps each kind. */
function providerKey(id: string, config: Record<string, unknown>, saved: Record<string, unknown>): string | undefined {
  if (id === "openrouter") return text(config.openrouterApiKey) ?? text(saved.apiKey);
  if (id === "requesty") return text(config.requestyApiKey) ?? text(saved.apiKey);
  if (id === "custom") return text(config.apiKey) ?? text(saved.apiKey);
  return text(saved.apiKey);
}

/** The free tier's service origin: the saved base URL, AUTOPILOT_DL_FREE_URL, or the default. */
function serviceOrigin(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return FREE_TIER_DEFAULT_URL;
  const origin = value.replace(/\/+$/, "").replace(/\/v1$/, "");
  return /^https?:\/\/[^\s/]+$/i.test(origin) ? origin : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface CreateServerKeyOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export type ServerKeyResult = { key: string } | { problem: string };

/**
 * Creates a server key for a place with the free tier's POST /v1/keys, using the access token
 * Autopilot saved. The token is never stored on the place; only the key it returns is. A
 * failure (the key limit, an expired token, the network) comes back as one line to show.
 */
export async function createFreeTierServerKey(origin: string, accessToken: string, name: string, options: CreateServerKeyOptions = {}): Promise<ServerKeyResult> {
  const call = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  try {
    const response = await call(`${origin}/v1/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ name }),
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as { error?: { code?: unknown; message?: unknown } } | undefined;
      const message = typeof body?.error?.message === "string" ? body.error.message : undefined;
      const code = typeof body?.error?.code === "string" ? body.error.code : undefined;
      return { problem: message ?? (code === "key_limit_reached" ? "the free tier's server-key limit is reached" : `the free tier answered HTTP ${response.status}`) };
    }
    const body = (await response.json()) as { key?: unknown };
    if (typeof body.key !== "string" || !body.key) return { problem: "the free tier returned no key" };
    return { key: body.key };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
}
