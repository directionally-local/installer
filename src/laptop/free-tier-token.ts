import { readFile, writeFile } from "node:fs/promises";
import { autopilotConfigFile, FREE_TIER_PROVIDER, serviceOrigin } from "./free-tier.js";

/**
 * A fresh free tier access token from Autopilot's sign-in, for `dl claude`: the token Autopilot
 * saved (providers.directionally-local in its config.json), refreshed the way Autopilot refreshes
 * it when it expires within a minute. The new pair is written back in place, keeping every other
 * field, so Autopilot carries on with it. Refresh tokens rotate, so when another process (an
 * Autopilot session) rotated the same token first, the refresh answers invalid_grant and the pair
 * that process saved is read back instead, as Autopilot itself does. Tokens are never printed.
 */

type Env = Record<string, string | undefined>;

export interface FreeTierTokenOptions {
  env?: Env;
  now?: () => number;
  /** Autopilot's config.json; autopilotConfigFile(env) unless replaced. */
  file?: string;
  readFile?: (path: string) => Promise<string>;
  writeFile?: (path: string, text: string) => Promise<void>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
}

export type FreeTierToken =
  | { ok: true; origin: string; accessToken: string }
  /** Not signed in, or the sign-in ended (the refresh token was refused): sign in again. */
  | { ok: false; reason: "signed_out" }
  /** The service couldn't be reached or answered oddly; `message` says what happened. */
  | { ok: false; reason: "unavailable"; message: string };

interface Saved {
  apiKey?: unknown;
  refreshToken?: unknown;
  expiresAt?: unknown;
  baseUrl?: unknown;
}

const REFRESH_TIMEOUT_MS = 10_000;
/** How long to wait before reading config.json again after losing a refresh race (as Autopilot). */
const ROTATED_RECHECK_MS = 750;

export async function freeTierAccessToken(options: FreeTierTokenOptions = {}): Promise<FreeTierToken> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const file = options.file ?? autopilotConfigFile(env);
  const read = options.readFile ?? ((path: string) => readFile(path, "utf8"));
  const load = async (): Promise<{ config: Record<string, unknown>; saved: Saved } | undefined> => {
    try {
      const config = JSON.parse(await read(file)) as Record<string, unknown>;
      const providers = (config.providers ?? {}) as Record<string, Saved | undefined>;
      return { config, saved: providers[FREE_TIER_PROVIDER] ?? {} };
    } catch {
      return undefined;
    }
  };
  const loaded = await load();
  const saved = loaded?.saved;
  const accessToken = typeof saved?.apiKey === "string" ? saved.apiKey.trim() : "";
  const refreshToken = typeof saved?.refreshToken === "string" ? saved.refreshToken.trim() : "";
  if (!loaded || (!accessToken && !refreshToken)) return { ok: false, reason: "signed_out" };
  const origin = serviceOrigin(env, saved?.baseUrl);
  if (!origin) return { ok: false, reason: "unavailable", message: "Autopilot's free tier address isn't a valid URL." };
  const fresh = typeof saved?.expiresAt !== "number" || saved.expiresAt - now() > 60_000;
  if (accessToken && fresh) return { ok: true, origin, accessToken };
  if (!refreshToken) return { ok: false, reason: "signed_out" };

  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${origin}/v1/token/refresh`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
      redirect: "error",
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, reason: "unavailable", message: `Couldn't reach the free tier to refresh your sign-in (${error instanceof Error ? error.message : String(error)}).` };
  }
  const body = (await response.json().catch(() => undefined)) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; error?: { code?: unknown } | string } | undefined;
  if (!response.ok) {
    const code = typeof body?.error === "string" ? body.error : body?.error?.code;
    if (code === "invalid_grant") {
      // Another process may have rotated it first: take the pair it saved.
      const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) await sleep(ROTATED_RECHECK_MS);
        const again = (await load())?.saved;
        if (typeof again?.apiKey === "string" && typeof again.refreshToken === "string" && again.refreshToken !== refreshToken) return { ok: true, origin, accessToken: again.apiKey };
      }
      return { ok: false, reason: "signed_out" };
    }
    if (response.status === 401 || response.status === 403) return { ok: false, reason: "signed_out" };
    return { ok: false, reason: "unavailable", message: `The free tier couldn't refresh your sign-in (HTTP ${response.status}).` };
  }
  if (typeof body?.access_token !== "string" || !body.access_token) return { ok: false, reason: "unavailable", message: "The free tier sent no access token." };
  const next = {
    apiKey: body.access_token,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : refreshToken,
    expiresAt: now() + (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000,
  };
  try {
    // Read again just before writing, so a field another process changed meanwhile is kept.
    const latest = (await load()) ?? loaded;
    const providers = (latest.config.providers ?? {}) as Record<string, Saved | undefined>;
    latest.config.providers = { ...providers, [FREE_TIER_PROVIDER]: { ...providers[FREE_TIER_PROVIDER], ...next } };
    // In place, so the file keeps its permissions (0600) and stays wherever a link points.
    await (options.writeFile ?? ((path: string, text: string) => writeFile(path, text)))(file, `${JSON.stringify(latest.config, null, 2)}\n`);
  } catch {
    // The token works for this run anyway; Autopilot refreshes on its own next time.
  }
  return { ok: true, origin, accessToken: next.apiKey };
}
