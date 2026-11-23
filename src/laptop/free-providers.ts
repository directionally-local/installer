import { readFile } from "node:fs/promises";
import { palette } from "../ui.js";
import { autopilotConfigFile, FREE_TIER_PROVIDER, serviceOrigin } from "./free-tier.js";

/**
 * The free tier's providers and their models, with the speeds the service measures every
 * 10 minutes (GET /v1/providers, public, no sign-in). `dl models` prints them as a table and
 * `dl status` shows the chosen free model with its provider and speed. Until the endpoint is
 * live (or when it's slow or down) a built-in list stands in: DeepSeek V4.1 Flash on Luminal,
 * with no speeds.
 */

export type ModelAccess = "free" | "trusted" | "opt-in" | "pro";
export type ModelStatus = "on" | "paused" | "out_of_credit";

export interface FreeModel {
  id: string;
  name: string;
  family?: string;
  contextWindow?: number;
  access: ModelAccess;
  status: ModelStatus;
  tokensPerSecond: number | null;
  ttftMs: number | null;
  successRate24h: number | null;
  measuredAt: string | null;
}

export interface FreeProvider {
  id: string;
  name: string;
  website?: string;
  url?: string;
  models: FreeModel[];
}

export interface FreeProviders {
  updatedAt?: string;
  providers: FreeProvider[];
  /** False when this is the built-in list (the endpoint 404s, is unreachable or answered nonsense). */
  live: boolean;
}

/** The model the free tier starts people on. */
export const FREE_DEFAULT_MODEL_ID = "deepseek/deepseek-v4.1-flash-1017";

/** What's shown until /v1/providers answers: the default model on Luminal, no measurements. */
export const BUILT_IN_PROVIDERS: readonly FreeProvider[] = [
  {
    id: "luminal",
    name: "Luminal",
    models: [{ id: FREE_DEFAULT_MODEL_ID, name: "DeepSeek V4.1 Flash", family: "deepseek", contextWindow: 1_048_576, access: "free", status: "on", tokensPerSecond: null, ttftMs: null, successRate24h: null, measuredAt: null }],
  },
];

const PROVIDERS_TIMEOUT_MS = 2_000;

type Env = Record<string, string | undefined>;

export interface FreeProvidersOptions {
  env?: Env;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  /** Reads Autopilot's config file; the real file unless replaced. */
  readFile?: (path: string) => Promise<string>;
  exists?: (path: string) => boolean;
}

const builtIn = (): FreeProviders => ({ providers: structuredClone(BUILT_IN_PROVIDERS) as FreeProvider[], live: false });

/** GET {origin}/v1/providers in 2 s at most; the built-in list on any failure. Never throws. */
export async function freeProviders(options: FreeProvidersOptions = {}): Promise<FreeProviders> {
  const env = options.env ?? process.env;
  const origin = serviceOrigin(env, undefined);
  if (!origin) return builtIn();
  try {
    const call = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
    const response = await call(`${origin}/v1/providers`, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? PROVIDERS_TIMEOUT_MS),
    });
    if (!response.ok) return builtIn();
    const parsed = parseProviders(await response.json());
    return parsed ?? builtIn();
  } catch {
    return builtIn();
  }
}

type Rec = Record<string, unknown>;
const record = (value: unknown): Rec => (value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {});
const text = (value: unknown, max = 200) => (typeof value === "string" && value.trim() && value.length <= max ? value.trim() : undefined);
const measure = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
const ACCESS: readonly string[] = ["free", "trusted", "opt-in", "pro"];
const STATUS: readonly string[] = ["on", "paused", "out_of_credit"];

/** The response body, checked field by field; undefined when it has no usable provider. */
export function parseProviders(body: unknown): FreeProviders | undefined {
  const root = record(body);
  if (!Array.isArray(root.providers)) return undefined;
  const providers: FreeProvider[] = [];
  for (const raw of root.providers) {
    const item = record(raw);
    const id = text(item.id, 64);
    const name = text(item.name, 80);
    if (!id || !name || !Array.isArray(item.models)) continue;
    const models: FreeModel[] = [];
    for (const rawModel of item.models) {
      const model = record(rawModel);
      const modelId = text(model.id);
      const modelName = text(model.name, 80);
      if (!modelId || !modelName) continue;
      const contextWindow = measure(model.contextWindow);
      const measuredAt = text(model.measuredAt, 40);
      models.push({
        id: modelId,
        name: modelName,
        ...(text(model.family, 40) ? { family: text(model.family, 40)! } : {}),
        ...(contextWindow ? { contextWindow } : {}),
        access: (ACCESS.includes(model.access as string) ? model.access : "free") as ModelAccess,
        status: (STATUS.includes(model.status as string) ? model.status : "paused") as ModelStatus,
        tokensPerSecond: measure(model.tokensPerSecond),
        ttftMs: measure(model.ttftMs),
        successRate24h: measure(model.successRate24h),
        measuredAt: measuredAt && Number.isFinite(Date.parse(measuredAt)) ? measuredAt : null,
      });
    }
    if (models.length === 0) continue;
    const website = text(item.website, 300);
    const url = text(item.url, 500);
    providers.push({ id, name, ...(website ? { website } : {}), ...(url ? { url } : {}), models });
  }
  if (providers.length === 0) return undefined;
  const updatedAt = text(root.updatedAt, 40);
  return { ...(updatedAt && Number.isFinite(Date.parse(updatedAt)) ? { updatedAt } : {}), providers, live: true };
}

/**
 * The free model Autopilot here uses: what /model saved for the free tier provider
 * (providers.directionally-local.model in its config.json, else the top-level `model` when
 * the file was written for the free tier). Undefined when nothing was chosen.
 */
export async function chosenFreeModel(options: FreeProvidersOptions = {}): Promise<string | undefined> {
  const env = options.env ?? process.env;
  try {
    const raw = await (options.readFile ?? ((path) => readFile(path, "utf8")))(autopilotConfigFile(env, options.exists));
    const config = record(JSON.parse(raw));
    const saved = text(record(record(config.providers)[FREE_TIER_PROVIDER]).model);
    if (saved) return saved;
    return config.provider === FREE_TIER_PROVIDER ? text(config.model) : undefined;
  } catch {
    return undefined;
  }
}

/** The provider and model for an id, when the list has it. */
export function findModel(list: FreeProviders, id: string): { provider: FreeProvider; model: FreeModel } | undefined {
  for (const provider of list.providers) {
    const model = provider.models.find((entry) => entry.id === id);
    if (model) return { provider, model };
  }
  return undefined;
}

/** "~85 tok/s", or "" when not measured. */
export const formatSpeed = (model: FreeModel) => (model.tokensPerSecond === null ? "" : `~${Math.round(model.tokensPerSecond)} tok/s`);

/** "~0.6 s", or "" when not measured. */
export const formatTtft = (model: FreeModel) => (model.ttftMs === null ? "" : `~${(model.ttftMs / 1000).toFixed(model.ttftMs < 10_000 ? 1 : 0)} s`);

const formatContext = (tokens?: number) => (!tokens ? "" : tokens >= 1_000_000 ? `${(Math.round(tokens / 100_000) / 10).toString()}M` : `${Math.round(tokens / 1000)}k`);

const STATUS_TEXT: Record<ModelStatus, string> = { on: "on", paused: "paused", out_of_credit: "out of credit" };

/** The Access column: "Pro" for a dl Pro only model (Kimi K3.1 Pro), which free accounts can't use. */
const ACCESS_TEXT: Record<ModelAccess, string> = { free: "free", trusted: "trusted", "opt-in": "opt-in", pro: "Pro" };

/** Where dl Pro is bought (dl.new's account page). */
export const PRO_UPGRADE_URL = "https://dl.new/account";

/**
 * `dl status`'s free model line: "DeepSeek V4.1 Flash · Luminal · ~85 tok/s" (the speed left
 * out when unmeasured), or the bare id when the list doesn't have it.
 */
export function freeModelLine(id: string | undefined, list: FreeProviders): string {
  const chosen = id ?? FREE_DEFAULT_MODEL_ID;
  const found = findModel(list, chosen);
  const suffix = id ? "" : " (default)";
  if (!found) return `${chosen}${suffix}`;
  const parts = [`${found.model.name}${suffix}`, found.provider.name];
  const speed = formatSpeed(found.model);
  if (speed) parts.push(speed);
  if (found.model.access === "pro") parts.push("Pro");
  if (found.model.status !== "on") parts.push(STATUS_TEXT[found.model.status]);
  return parts.join(" · ");
}

/** The chosen free model and the providers list, fetched together; for `dl status`. Never throws. */
export async function freeModelStatus(options: FreeProvidersOptions = {}): Promise<string> {
  const [id, list] = await Promise.all([chosenFreeModel(options), freeProviders(options)]);
  return freeModelLine(id, list);
}

/** `dl models`: the free tier's providers and models, with measured speed and first-token time. */
export function formatProvidersTable(list: FreeProviders, options: { color?: boolean; chosen?: string } = {}): string {
  const c = palette(options.color === true);
  const header = ["", "Provider", "Model", "Context", "Access", "Status", "Speed", "First token"];
  const rows: string[][] = [];
  for (const provider of list.providers) {
    for (const model of provider.models) {
      rows.push([model.id === options.chosen ? "✓" : "", provider.name, model.name, formatContext(model.contextWindow), ACCESS_TEXT[model.access], STATUS_TEXT[model.status], formatSpeed(model), formatTtft(model)]);
    }
  }
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => row[index]!.length)));
  const line = (cells: string[]) => `  ${cells.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd()}\n`;
  let out = `\n  ${c.bold("Free models")}  ${c.dim("speeds measured every 10 minutes")}\n\n`;
  out += c.dim(line(header));
  for (const row of rows) out += line(row);
  out += "\n";
  if (!list.live) out += `  ${c.dim("Live measurements aren't available right now: this is the built-in list.")}\n`;
  else if (list.updatedAt) out += `  ${c.dim(`Updated ${list.updatedAt}`)}\n`;
  const links = list.providers.filter((provider) => provider.url || provider.website);
  for (const provider of links) out += `  ${c.dim(`${provider.name}: ${provider.url ?? provider.website}`)}\n`;
  // Pro-only models are listed so people know they exist, but free accounts can't use them.
  if (rows.length > 0 && list.providers.some((provider) => provider.models.some((model) => model.access === "pro"))) {
    out += `  ${c.dim(`Pro: dl Pro only, a small weekly allowance, then DeepSeek. Upgrade: ${PRO_UPGRADE_URL}`)}\n`;
  }
  out += `  ${c.dim("Choose one in Autopilot with /model.")}\n\n`;
  return out;
}

/** `dl models [--json]`. */
export async function modelsCommand(io: { out: (text: string) => void; color?: boolean }, options: FreeProvidersOptions & { json?: boolean } = {}): Promise<number> {
  const [list, chosen] = await Promise.all([freeProviders(options), chosenFreeModel(options)]);
  if (options.json) {
    io.out(`${JSON.stringify({ ...(list.updatedAt ? { updatedAt: list.updatedAt } : {}), live: list.live, ...(chosen ? { chosen } : {}), providers: list.providers }, null, 2)}\n`);
    return 0;
  }
  io.out(formatProvidersTable(list, { color: io.color === true, ...(chosen ? { chosen } : {}) }));
  return 0;
}
