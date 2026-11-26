import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { arch, homedir, hostname, platform } from "node:os";
import { dirname, join } from "node:path";
import { palette } from "../ui.js";
import { FREE_TIER_DEFAULT_URL } from "./free-tier.js";
import { openBrowser } from "./open-browser.js";
import { oneLine } from "./printable.js";

/**
 * dl's own sign-in: a dl key (dl_sk_…) for the person's dl.new account, on whatever plan they
 * have there (free or paid), with no Autopilot involved. It's the browser sign-in dl.new already
 * runs for CLIs (`/cli-login`, services/free/src/paid-web.ts):
 *
 * (the service at https://api.dl.new):
 *   1. POST <service>/v1/cli-login/start {tool: "dl", deviceName} → {loginId, userCode, verificationUri, interval, expiresIn}
 *   2. dl opens verificationUri (dl.new/cli-login?code=…) in the browser; the person signs in or
 *      signs up there (and picks a plan), checks the code and approves.
 *   3. dl polls POST <service>/v1/cli-login/poll {loginId} every `interval` seconds: 428
 *      authorization_pending, 429 slow_down, 403 access_denied, 410 expired_token, or (once)
 *      200 {key, keyId, accountId, plan, baseUrl, anthropicBaseUrl}.
 *
 * The key is kept in ~/.config/directionallylocal/dl-key.json (0600) and given to the agent dl
 * routes (as its API key, with base URL https://api.dl.new/v1 or /anthropic). It's never logged;
 * it's printed only when the person asks for it to set up an agent by hand.
 */

type Env = Record<string, string | undefined>;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface DlKey {
  key: string;
  keyId?: string;
  accountId?: string;
  /** The account's plan when it signed in ("starter", "pro", …); null is Free. */
  plan?: string | null;
  /** The API's origin, https://api.dl.new (no /v1). */
  baseUrl: string;
  /** https://api.dl.new/anthropic */
  anthropicBaseUrl: string;
  savedAt: string;
  /**
   * "free-tier": a key dl made for itself from an Autopilot free tier sign-in kept from before
   * dl had its own (api-key.ts, dlKeyFromFreeTier). Autopilot keeps its own sign-in then.
   */
  source?: "free-tier";
}

/** The public API address the keys work against. */
export const DL_API_URL = "https://api.dl.new";
/** The model dl's plans default to (any OpenAI-style tool can pick another from GET /v1/models). */
export const DL_DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash-1017";

const REQUEST_TIMEOUT_MS = 15_000;
const REPORT_TIMEOUT_MS = 4_000;

/** Where the dl key lives: ${XDG_CONFIG_HOME:-~/.config}/directionallylocal/dl-key.json. */
export function dlKeyPath(env: Env = process.env): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(env.HOME || homedir(), ".config");
  return join(configHome, "directionallylocal", "dl-key.json");
}

function origin(raw: string): string {
  return raw.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** Where the browser sign-in starts and is polled: DL_SERVICE_URL (a test service), else https://api.dl.new. */
export function dlSignInOrigin(env: Env = process.env): string {
  return origin(env.DL_SERVICE_URL?.trim() || DL_API_URL);
}

/** Where agent requests go: DL_SERVICE_URL (a test service), AUTOPILOT_DL_FREE_URL, else free.directionallylocal.com. */
export function dlServiceOrigin(env: Env = process.env): string {
  return origin(env.DL_SERVICE_URL?.trim() || env.AUTOPILOT_DL_FREE_URL?.trim() || FREE_TIER_DEFAULT_URL);
}

/** The saved dl key, or undefined (none, unreadable, or not a dl key). */
export async function readDlKey(env: Env = process.env, path: string = dlKeyPath(env)): Promise<DlKey | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<DlKey> & { version?: unknown };
    if (value.version !== 1 || typeof value.key !== "string" || !value.key.trim()) return undefined;
    const baseUrl = typeof value.baseUrl === "string" && /^https?:\/\/[^\s/]+$/.test(value.baseUrl) ? value.baseUrl : DL_API_URL;
    return {
      key: value.key.trim(),
      ...(typeof value.keyId === "string" ? { keyId: value.keyId } : {}),
      ...(typeof value.accountId === "string" ? { accountId: value.accountId } : {}),
      plan: typeof value.plan === "string" ? value.plan : null,
      baseUrl,
      anthropicBaseUrl: typeof value.anthropicBaseUrl === "string" && value.anthropicBaseUrl.startsWith("http") ? value.anthropicBaseUrl : `${baseUrl}/anthropic`,
      savedAt: typeof value.savedAt === "string" ? value.savedAt : "",
      ...(value.source === "free-tier" ? { source: "free-tier" as const } : {}),
    };
  } catch {
    return undefined;
  }
}

export async function saveDlKey(key: DlKey, env: Env = process.env, path: string = dlKeyPath(env)): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify({ version: 1, ...key }, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

export async function forgetDlKey(env: Env = process.env, path: string = dlKeyPath(env)): Promise<void> {
  await rm(path, { force: true });
}

/** The OpenAI-style and Anthropic-style base URLs for a key. */
export function keyUrls(key: Pick<DlKey, "baseUrl" | "anthropicBaseUrl">): { openai: string; anthropic: string } {
  return { openai: `${key.baseUrl.replace(/\/+$/, "")}/v1`, anthropic: key.anthropicBaseUrl };
}

/** "dl_sk_…a1b2": enough to tell keys apart, never the key. */
export function maskKey(key: string): string {
  return key.length > 14 ? `${key.slice(0, 6)}…${key.slice(-4)}` : "dl_sk_…";
}

/** "Starter" for "starter"; "Free" when there's no paid plan. */
export function planName(plan: string | null | undefined): string {
  if (!plan) return "Free";
  return plan.slice(0, 1).toUpperCase() + plan.slice(1);
}

export interface SignInIO {
  out: (text: string) => void;
  err: (text: string) => void;
  color?: boolean;
}

export interface SignInDeps {
  env?: Env;
  fetch?: Fetch;
  /** Opens the URL in the browser; false when it couldn't (the link is shown either way). */
  open?: (url: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** This computer's name, shown on the approval page. */
  deviceName?: string;
  /** Where the key is saved; dlKeyPath(env) unless replaced. */
  path?: string;
  /** The one line about what dl is, printed first (the first run); omitted on a re-sign-in. */
  intro?: boolean;
}

/** The first run's line: what dl is, in the product's words. */
export const DL_PITCH = "dl gives your coding agent open models (DeepSeek, Kimi) on one flat plan.";

function deviceName(): string {
  return hostname().replace(/\.local$/, "").replace(/[^\x20-\x7e]/g, "").slice(0, 64).trim() || "computer";
}

async function post(call: Fetch, url: string, body: unknown, timeoutMs = REQUEST_TIMEOUT_MS, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, any> | undefined }> {
  const response = await call(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: response.status, body: (await response.json().catch(() => undefined)) as Record<string, any> | undefined };
}

/**
 * The browser sign-in, start to finish, in this terminal. Saves and returns the key, or undefined
 * after saying why not (denied, expired, the service unreachable).
 */
export async function browserSignIn(io: SignInIO, deps: SignInDeps = {}): Promise<DlKey | undefined> {
  const env = deps.env ?? process.env;
  const call = deps.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const c = palette(io.color === true);
  const service = dlSignInOrigin(env);

  if (deps.intro !== false) io.out(`\n  ${c.bold(DL_PITCH)}\n`);
  let started: { status: number; body: Record<string, any> | undefined };
  try {
    started = await post(call, `${service}/v1/cli-login/start`, { tool: "dl", deviceName: deps.deviceName ?? deviceName() });
  } catch (error) {
    io.err(`\n  ${c.red("✗")} Couldn't reach dl.new to sign in (${error instanceof Error ? error.message : String(error)}). Check your connection and run dl again.\n`);
    return undefined;
  }
  const login = started.body;
  if (started.status !== 200 || typeof login?.loginId !== "string" || typeof login.userCode !== "string" || typeof login.verificationUri !== "string") {
    const message = typeof login?.error?.message === "string" ? oneLine(login.error.message, 300) : `dl.new answered HTTP ${started.status}.`;
    io.err(`\n  ${c.red("✗")} Couldn't start the sign-in: ${message}\n`);
    return undefined;
  }
  const url: string = login.verificationUri;
  const opened = (deps.open ?? openBrowser)(url);
  io.out(`\n  ${opened ? "Opening dl.new in your browser to sign in or sign up." : "Open this link to sign in or sign up:"}\n`);
  io.out(`    ${c.dim("Code")}   ${c.bold(login.userCode)}   ${c.dim("(check it matches the page)")}\n`);
  io.out(`    ${c.dim("Link")}   ${c.cyan(url)}${opened ? c.dim("   (if it didn't open)") : ""}\n\n`);
  io.out(`  ${c.dim("Waiting for you to approve in the browser… (Ctrl-C to stop)")}\n`);

  let interval = Math.max(1, typeof login.interval === "number" ? login.interval : 2) * 1000;
  const deadline = now() + Math.max(60, typeof login.expiresIn === "number" ? login.expiresIn : 600) * 1000;
  let failures = 0;
  while (now() < deadline) {
    await sleep(interval);
    let polled: { status: number; body: Record<string, any> | undefined };
    try {
      polled = await post(call, `${service}/v1/cli-login/poll`, { loginId: login.loginId });
      failures = 0;
    } catch {
      // A blip while waiting: keep waiting, unless the service stays away.
      if (++failures >= 5) {
        io.err(`  ${c.red("✗")} Lost the connection to dl.new while waiting. Run dl again to sign in.\n`);
        return undefined;
      }
      continue;
    }
    if (polled.status === 200 && typeof polled.body?.key === "string") {
      const body = polled.body;
      const baseUrl = typeof body.baseUrl === "string" && /^https?:\/\/[^\s/]+\/?$/.test(body.baseUrl) ? body.baseUrl.replace(/\/+$/, "") : DL_API_URL;
      const key: DlKey = {
        key: body.key,
        ...(typeof body.keyId === "string" ? { keyId: body.keyId } : {}),
        ...(typeof body.accountId === "string" ? { accountId: body.accountId } : {}),
        plan: typeof body.plan === "string" ? body.plan : null,
        baseUrl,
        anthropicBaseUrl: typeof body.anthropicBaseUrl === "string" && body.anthropicBaseUrl.startsWith("http") ? body.anthropicBaseUrl : `${baseUrl}/anthropic`,
        savedAt: new Date(now()).toISOString(),
      };
      await saveDlKey(key, env, deps.path);
      // The waiting line becomes the result.
      io.out(`${io.color === true ? "\x1b[1F\x1b[2K" : ""}  ${c.green("✓")} Signed in ${c.dim(`· ${planName(key.plan)} plan`)}\n`);
      return key;
    }
    const code = polled.body?.error?.code;
    if (code === "authorization_pending") continue;
    if (code === "slow_down") {
      interval += 1000;
      continue;
    }
    if (code === "access_denied") {
      io.err(`  ${c.red("✗")} The sign-in was denied in the browser. Run dl to try again.\n`);
      return undefined;
    }
    if (code === "expired_token") break;
    const message = typeof polled.body?.error?.message === "string" ? oneLine(polled.body.error.message, 300) : `dl.new answered HTTP ${polled.status}.`;
    io.err(`  ${c.red("✗")} The sign-in didn't finish: ${message}\n`);
    return undefined;
  }
  io.err(`  ${c.red("✗")} The sign-in expired before it was approved. Run dl to try again.\n`);
  return undefined;
}

/**
 * The saved key; else one made from an older Autopilot free tier sign-in (`migrate`, so an update
 * doesn't sign anyone out); else (in a terminal) a browser sign-in now.
 */
export async function dlKeyOrSignIn(io: SignInIO, deps: SignInDeps & { interactive?: boolean; read?: () => Promise<DlKey | undefined>; migrate?: () => Promise<DlKey | undefined> } = {}): Promise<DlKey | undefined> {
  const saved = await (deps.read ?? (() => readDlKey(deps.env ?? process.env, deps.path)))();
  if (saved) return saved;
  const migrated = await deps.migrate?.().catch(() => undefined);
  if (migrated) return migrated;
  if (deps.interactive === false) return undefined;
  return browserSignIn(io, deps);
}

export interface AgentRequest {
  name: string;
  os: string;
  arch: string;
  dlVersion: string;
  found: string[];
}

/** The request body for an agent dl doesn't know: the name cut to 80 characters, one line. */
export function agentRequest(name: string, found: readonly string[], dlVersion: string): AgentRequest {
  return { name: oneLine(name, 80).slice(0, 80), os: platform(), arch: arch(), dlVersion, found: [...found] };
}

/**
 * Tells the service which agent someone uses that dl doesn't know (POST /v1/agent-request), so
 * the owner hears about it. Best effort and quick: it never throws, and nothing waits on it
 * longer than a few seconds. With a dl key, it's sent as the Bearer token (who asked).
 */
export async function reportAgentRequest(request: AgentRequest, deps: { env?: Env; fetch?: Fetch; key?: string } = {}): Promise<boolean> {
  const call = deps.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  try {
    const result = await post(call, `${dlServiceOrigin(deps.env ?? process.env)}/v1/agent-request`, request, REPORT_TIMEOUT_MS, deps.key ? { authorization: `Bearer ${deps.key}` } : {});
    return result.status === 200 && result.body?.ok === true;
  } catch {
    return false;
  }
}
