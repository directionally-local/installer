import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { hasControl, oneLine } from "./printable.js";
import { telemetryOff } from "./telemetry.js";

/**
 * The free tier account `dl status` shows when Autopilot's active provider is the free tier:
 * who is signed in and what is left this week. Autopilot owns the sign-in; dl only reads it.
 *
 * `autopilot auth status` doesn't print the login or the allowance, so this reads the access
 * token Autopilot saved (providers.directionally-local.apiKey in its config.json) and asks the
 * service's GET /v1/me with it: read-only, 3 s at most, never refreshed (an expired token is
 * left alone, so Autopilot's refresh token is never used or rotated from here). The login also
 * comes from the token's own claims, so `@login` can be shown without the network. Tokens are
 * never printed or logged.
 */

export const FREE_TIER_PROVIDER = "directionally-local";
/** Autopilot's default, as in its dl-endpoint.ts; AUTOPILOT_DL_FREE_URL overrides it there too. */
export const FREE_TIER_DEFAULT_URL = "https://free.directionallylocal.com";
const ME_TIMEOUT_MS = 3_000;
const WEEK_MS = 7 * 86_400_000;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** What one model family has left this week: tokens when it has a token cap, else dollars. */
export type FreeTierBudget = { remaining: number; tokensPerWeek: number } | { usdLeft: number; usdPerWeek: number };

export interface FreeTierAccount {
  login: string;
  /**
   * Tokens left this week and the weekly grant, from an older service's /v1/me (its top-level
   * `allowance`); only used when the service sends no per-model `pools` or `budgets`.
   */
  remaining?: number;
  tokensPerWeek?: number;
  /** DeepSeek's weekly allowance, from /v1/me's `pools` and `budgets`. */
  deepseek?: FreeTierBudget;
  /** GPT-6's weekly dollar budget, only for someone who has one. */
  gpt6?: FreeTierBudget;
  /** When the week's allowance comes back (ISO time). */
  resetsAt?: string;
  /** The contact email given at sign-in (from /v1/me, when the service sends it). */
  email?: string;
  /**
   * dl Pro's prompt, when the service sends one (this free week's open models are used up and
   * Pro is offered): its exact text and where Upgrade goes (dl.new/account).
   */
  proPrompt?: { text: string; upgradeUrl: string };
}

type Env = Record<string, string | undefined>;

export interface FreeTierOptions {
  env?: Env;
  now?: number;
  /** Reads Autopilot's config file; the real file unless replaced. */
  readFile?: (path: string) => Promise<string>;
  exists?: (path: string) => boolean;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  /** The caller shows dl Pro's prompt when there is one (`dl status`): the service then counts it as seen. */
  showsProPrompt?: boolean;
}

/** Autopilot's config.json: ${XDG_CONFIG_HOME:-~/.config}/autopilot, or the pre-rename kimiflare one. */
export function autopilotConfigFile(env: Env = process.env, exists: (path: string) => boolean = existsSync): string {
  const base = env.XDG_CONFIG_HOME?.trim() || join(env.HOME || homedir(), ".config");
  const current = join(base, "autopilot", "config.json");
  const legacy = join(base, "kimiflare", "config.json");
  return !exists(current) && exists(legacy) ? legacy : current;
}

/** The `login` claim of a free tier access token (a JWT), without verifying it; for display only. */
export function loginFromToken(token: string): string | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(new TextDecoder().decode(base64Url(payload))) as { login?: unknown };
    return typeof claims.login === "string" && GITHUB_LOGIN.test(claims.login) ? claims.login : undefined;
  } catch {
    return undefined;
  }
}

function base64Url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "="));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** The service origin Autopilot uses: AUTOPILOT_DL_FREE_URL, else the provider's saved base URL, else the default. */
export function serviceOrigin(env: Env, savedBaseUrl: unknown): string | undefined {
  const raw = env.AUTOPILOT_DL_FREE_URL?.trim() || (typeof savedBaseUrl === "string" ? savedBaseUrl.trim() : "") || FREE_TIER_DEFAULT_URL;
  const origin = raw.replace(/\/+$/, "").replace(/\/v1$/, "");
  return /^https?:\/\/[^\s/]+$/i.test(origin) ? origin : undefined;
}

/**
 * The signed-in free tier account, or undefined when there's none to show. Never throws:
 * a missing or unreadable config, an expired token, a slow or failing service all fall back
 * to the login from the token, or to nothing.
 */
export async function freeTierAccount(options: FreeTierOptions = {}): Promise<FreeTierAccount | undefined> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  let saved: { apiKey?: unknown; expiresAt?: unknown; baseUrl?: unknown } | undefined;
  try {
    const text = await (options.readFile ?? ((path) => readFile(path, "utf8")))(autopilotConfigFile(env, options.exists));
    saved = (JSON.parse(text) as { providers?: Record<string, typeof saved> }).providers?.[FREE_TIER_PROVIDER];
  } catch {
    return undefined;
  }
  const token = typeof saved?.apiKey === "string" ? saved.apiKey.trim() : "";
  if (!token) return undefined;
  const login = loginFromToken(token);
  const expired = typeof saved?.expiresAt === "number" && saved.expiresAt <= now;
  const origin = serviceOrigin(env, saved?.baseUrl);
  if (expired || !origin) return login ? { login } : undefined;
  const me = await readMe(`${origin}/v1/me${options.showsProPrompt && !telemetryOff(env) ? "?prompt=shown" : ""}`, token, options).catch(() => undefined);
  if (!me) return login ? { login } : undefined;
  return me.login || login ? { ...me, login: me.login ?? login! } : undefined;
}

async function readMe(url: string, token: string, options: FreeTierOptions): Promise<Omit<FreeTierAccount, "login"> & { login?: string }> {
  const call = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const response = await call(url, {
    headers: { accept: "application/json", authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(options.timeoutMs ?? ME_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as MeBody;
  const allowance = record(body.allowance);
  const remaining = count(allowance.remaining);
  const tokensPerWeek = count(allowance.tokensPerWeek);
  const resetsAt = typeof allowance.resetsAt === "string" && Number.isFinite(Date.parse(allowance.resetsAt)) ? allowance.resetsAt : undefined;
  // The top-level allowance describes GPT-6 Luna's pool; the per-model figures say what DeepSeek
  // (the default) and GPT-6 have left. An older service sends only the top-level one.
  const queued = body.queue !== null && body.queue !== undefined;
  const budgets = record(body.budgets ?? allowance.budgets);
  const deepseek = familyBudget(record(record(body.pools).deepseek), record(budgets.deepseek), queued);
  const gpt6Budget = record(budgets.gpt6);
  const gpt6 = (count(gpt6Budget.usdPerWeek) ?? 0) > 0 ? familyBudget({}, gpt6Budget, queued) : undefined;
  // A service that sends per-model figures never falls back to the top-level (Luna) allowance.
  const perModel = body.pools !== undefined || body.budgets !== undefined || allowance.budgets !== undefined;
  const prompt = record(body.proPrompt);
  const proPrompt =
    typeof prompt.text === "string" && oneLine(prompt.text) && prompt.text.length <= 300 && typeof prompt.upgradeUrl === "string" && /^https:\/\/[^\s]+$/.test(prompt.upgradeUrl) && !hasControl(prompt.upgradeUrl) && prompt.upgradeUrl.length <= 200
      ? { text: oneLine(prompt.text), upgradeUrl: prompt.upgradeUrl }
      : undefined;
  return {
    ...(typeof body.login === "string" && GITHUB_LOGIN.test(body.login) ? { login: body.login } : {}),
    ...(perModel ? { ...(deepseek ? { deepseek } : {}), ...(gpt6 ? { gpt6 } : {}) } : remaining !== undefined && tokensPerWeek !== undefined ? { remaining, tokensPerWeek } : {}),
    ...(resetsAt ? { resetsAt } : {}),
    ...(typeof body.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) && !hasControl(body.email) && body.email.length <= 254 ? { email: body.email } : {}),
    ...(proPrompt ? { proPrompt } : {}),
  };
}

type Rec = Record<string, unknown>;
interface MeBody {
  login?: unknown;
  email?: unknown;
  allowance?: unknown;
  budgets?: unknown;
  pools?: unknown;
  queue?: unknown;
  proPrompt?: unknown;
}

const record = (value: unknown): Rec => (value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {});
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

/**
 * A family's week: its token pool when that has a token cap (`tokensPerWeek` a number), else its
 * dollar budget (`usdPerWeek` and `spentUsd`); undefined when neither is capped or sent. Nothing
 * is left while queued.
 */
function familyBudget(pool: Rec, budget: Rec, queued: boolean): FreeTierBudget | undefined {
  const tokensPerWeek = count(pool.tokensPerWeek);
  const remaining = count(pool.remaining);
  if (tokensPerWeek !== undefined && remaining !== undefined) return { remaining: queued ? 0 : remaining, tokensPerWeek };
  const usdPerWeek = count(budget.usdPerWeek);
  const spentUsd = count(budget.spentUsd);
  if (usdPerWeek === undefined || spentUsd === undefined) return undefined;
  return { usdLeft: queued ? 0 : Math.max(0, usdPerWeek - spentUsd), usdPerWeek };
}

/** "$5", "$7.93": cents, rounded down so what's left is never overstated. */
export function formatUsd(usd: number): string {
  const cents = Math.floor(Math.max(0, usd) * 100 + 1e-6);
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

/** "49.9M of 50M DeepSeek tokens left this week", "$7.93 of $10 DeepSeek left this week". */
function budgetPart(name: string, budget: FreeTierBudget): string {
  if ("tokensPerWeek" in budget) return `${formatTokens(Math.min(budget.remaining, budget.tokensPerWeek))} of ${formatTokens(budget.tokensPerWeek)} ${name} tokens left this week`;
  return `${formatUsd(Math.min(budget.usdLeft, budget.usdPerWeek))} of ${formatUsd(budget.usdPerWeek)} ${name} left this week`;
}

/** "50M", "49.9M", "800k", "950", rounded down so what's left is never overstated. */
export function formatTokens(n: number): string {
  const short = (tenths: number) => (tenths / 10).toFixed(1).replace(/\.0$/, "");
  if (n >= 1_000_000) return `${short(Math.floor(n / 100_000))}M`;
  if (n >= 1_000) return `${short(Math.floor(n / 100))}k`;
  return String(Math.max(0, Math.floor(n)));
}

/** "Mon 09:00" in local time within the coming week, "Mon, Nov 16, 09:00" further out. */
export function formatLocalTime(at: number, options: { now?: number; timeZone?: string } = {}): string {
  const date = new Date(at);
  const tz = options.timeZone ? { timeZone: options.timeZone } : {};
  const weekday = date.toLocaleDateString("en-US", { weekday: "short", ...tz });
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...tz });
  if (at - (options.now ?? Date.now()) < WEEK_MS) return `${weekday} ${time}`;
  return `${weekday}, ${date.toLocaleDateString("en-US", { month: "short", day: "numeric", ...tz })}, ${time}`;
}

/**
 * `@login · $7.93 of $10 DeepSeek left this week · resets Mon 09:00` (GPT-6's budget beside it
 * for someone who has one), or an older service's `49.9M of 50M tokens left this week`, or as
 * much of it as is known.
 */
export function freeTierLine(account: FreeTierAccount, options: { now?: number; timeZone?: string } = {}): string {
  const parts = [`@${account.login}`];
  if (account.deepseek) parts.push(budgetPart("DeepSeek", account.deepseek));
  if (account.gpt6) parts.push(budgetPart("GPT-6", account.gpt6));
  if (!account.deepseek && !account.gpt6 && account.remaining !== undefined && account.tokensPerWeek !== undefined) {
    parts.push(`${formatTokens(Math.min(account.remaining, account.tokensPerWeek))} of ${formatTokens(account.tokensPerWeek)} tokens left this week`);
  }
  if (parts.length > 1 && account.resetsAt) parts.push(`resets ${formatLocalTime(Date.parse(account.resetsAt), options)}`);
  return parts.join(" · ");
}

/**
 * dl Pro's prompt as `dl status` shows it under the free tier line, or undefined: "You've hit
 * this week's free limit. dl Pro: $7/month for higher limits and early access to new models.
 * Upgrade: https://dl.new/account"
 */
export function freeTierProPrompt(account: FreeTierAccount): string | undefined {
  return account.proPrompt ? `${account.proPrompt.text} Upgrade: ${account.proPrompt.upgradeUrl}` : undefined;
}
