/**
 * Model prices for Hotcell's gateway. Autopilot gives each sandbox a spend-capped egress
 * token, and under a cap Hotcell only forwards models it has a price for. Its built-in table
 * only knows older models, so `dl up` (and setup on this computer) writes OpenRouter's public
 * catalog to a JSON file Hotcell overlays at startup (HOTCELL_MODEL_PRICES):
 *   { "<model id, lower-cased>": { "inputPerMTok": number, "outputPerMTok": number }, … }
 */
import type { System, WriteOptions } from "./system.js";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const FETCH_TIMEOUT_MS = 15_000;
/** Older than this, `dl doctor` suggests refreshing it. */
export const MODEL_PRICES_MAX_AGE_DAYS = 7;

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}
export type ModelPriceTable = Record<string, ModelPrice>;

/** USD per token as OpenRouter gives it ("0.0000001"), or undefined when it isn't a usable price. */
function perToken(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  // OpenRouter marks variable pricing with "-1"; genuine 0 is a free model and is kept.
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Per million tokens, without float noise (0.0000001 × 1e6 is 0.09999999999999999). */
function perMillion(price: number): number {
  return Math.round(price * 1e12) / 1e6;
}

/** OpenRouter's catalog response to a price table; entries without usable prices are skipped. */
export function pricesFromCatalog(catalog: unknown): ModelPriceTable {
  const data = (catalog as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error("OpenRouter's model list had no models");
  const table: ModelPriceTable = {};
  for (const entry of data as Array<{ id?: unknown; pricing?: { prompt?: unknown; completion?: unknown } } | null>) {
    const id = typeof entry?.id === "string" ? entry.id.trim().toLowerCase() : "";
    if (!id) continue;
    const input = perToken(entry?.pricing?.prompt);
    const output = perToken(entry?.pricing?.completion);
    if (input === undefined || output === undefined) continue;
    table[id] = { inputPerMTok: perMillion(input), outputPerMTok: perMillion(output) };
  }
  return table;
}

/** Downloads OpenRouter's public model list (no key needed) as a price table. */
export async function fetchModelPrices(fetchImpl: typeof fetch = fetch): Promise<{ table: ModelPriceTable; count: number }> {
  let response: Response;
  try {
    response = await fetchImpl(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { "User-Agent": "directionallylocal" } });
  } catch (error) {
    throw new Error(`couldn't reach openrouter.ai: ${(error as Error).message}`);
  }
  if (!response.ok) throw new Error(`openrouter.ai answered HTTP ${response.status}`);
  const table = pricesFromCatalog(await response.json().catch(() => undefined));
  const count = Object.keys(table).length;
  if (count === 0) throw new Error("OpenRouter's model list had no prices");
  return { table, count };
}

export function renderModelPrices(table: ModelPriceTable): string {
  const sorted = Object.fromEntries(Object.keys(table).sort().map((id) => [id, table[id]!]));
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/** How many models a written price file holds, or undefined when it isn't one. */
export function countModelPrices(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return Object.values(parsed).filter((price) => typeof (price as ModelPrice | null)?.inputPerMTok === "number" && typeof (price as ModelPrice | null)?.outputPerMTok === "number").length;
  } catch {
    return undefined;
  }
}

/**
 * Refreshes the price file. When OpenRouter can't be reached, an existing file is kept;
 * either way it warns rather than failing the install. Returns a step detail, if any.
 */
export async function refreshModelPrices(system: System, input: {
  path: string;
  write: WriteOptions;
  fetchImpl: typeof fetch;
  warn: (text: string) => void;
  /** What to run once openrouter.ai is reachable again. */
  retry: string;
}): Promise<string | undefined> {
  if (system.dryRun) {
    system.log(`  would fetch: ${OPENROUTER_MODELS_URL} -> ${input.path}`);
    return undefined;
  }
  try {
    const { table, count } = await fetchModelPrices(input.fetchImpl);
    await system.writeFile(input.path, renderModelPrices(table), input.write);
    return `prices for ${count} models`;
  } catch (error) {
    const reason = (error as Error).message;
    const kept = countModelPrices(await system.readFile(input.path));
    if (kept !== undefined && kept > 0) {
      input.warn(`Couldn't refresh model prices (${reason}); kept the last list (${kept} models).`);
    } else {
      input.warn(`Couldn't download model prices (${reason}). Tasks will fail with "model not priced" until ${input.retry} can reach openrouter.ai.`);
    }
    return undefined;
  }
}

export interface ModelPricesHealth {
  ok: boolean;
  /** Present but stale: worth refreshing, not broken. */
  warn: boolean;
  detail: string;
}

/** For `dl doctor` and `dl local status`: the file's contents and its age (mtime, seconds). */
export function modelPricesHealth(text: string | undefined, mtimeSeconds: number | undefined, now: Date, refresh: string): ModelPricesHealth {
  if (text === undefined) return { ok: false, warn: false, detail: `missing; tasks fail with "model not priced"` };
  const count = countModelPrices(text);
  if (count === undefined || count === 0) return { ok: false, warn: false, detail: "unreadable; tasks may fail with \"model not priced\"" };
  const models = `${count} model${count === 1 ? "" : "s"}`;
  if (mtimeSeconds === undefined) return { ok: true, warn: false, detail: models };
  const days = Math.max(0, Math.floor((now.getTime() / 1000 - mtimeSeconds) / 86_400));
  const age = days === 0 ? "updated today" : `${days} day${days === 1 ? "" : "s"} old`;
  if (days > MODEL_PRICES_MAX_AGE_DAYS) return { ok: true, warn: true, detail: `${models} · ${age}; ${refresh} refreshes it` };
  return { ok: true, warn: false, detail: `${models} · ${age}` };
}

/** A file's mtime in seconds via stat (GNU on Linux, BSD on macOS); undefined when unknown. */
export async function fileMtime(system: System, path: string, platform: "linux" | "darwin" = "linux"): Promise<number | undefined> {
  const result = await system.probe("stat", platform === "darwin" ? ["-f", "%m", path] : ["-c", "%Y", path]);
  const seconds = Number(result.stdout.trim());
  return result.code === 0 && result.stdout.trim() !== "" && Number.isFinite(seconds) ? seconds : undefined;
}

/** A failed run's reason when Hotcell refused the model for lack of a price. */
export function isModelNotPriced(text: string): boolean {
  return /model not priced/i.test(text);
}
