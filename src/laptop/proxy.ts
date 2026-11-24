import { spawn as nodeSpawn, execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { modelStatePath } from "../state.js";
import { palette } from "../ui.js";
import { freeTierAccessToken, type FreeTierToken } from "./free-tier-token.js";
import { autopilotNudge, autopilotSignIn, REFRESH_EVERY_MS, SESSION_EVENT_EVERY_MS, type Harness, type LaunchIO } from "./harness-launch.js";

/**
 * `dl proxy`: dl's free tier for desktop coding apps (Conductor, Zed, Cline in VS Code) that dl
 * doesn't start, so they can't get the short-lived key `dl claude` puts in Claude Code's
 * environment. A small HTTP server on 127.0.0.1:4789 that the app points at instead:
 *
 *   POST /v1/messages, /v1/messages/count_tokens  (Anthropic format)  → <service>/anthropic/…, as Claude Code (`claude-code` harness key)
 *   POST /v1/chat/completions, GET /v1/models      (OpenAI format)     → <service>/v1/…, as OpenCode (`opencode` harness key)
 *
 * It holds the person's free tier sign-in (Autopilot's, as `dl claude` does) and, per format, a
 * 15-minute harness key it mints when first needed, refreshes every few minutes while the app
 * uses it, and revokes after 20 idle minutes and when the proxy stops; session events go with
 * each key, as `dl claude` sends them. So requests are counted as Claude Code's or OpenCode's,
 * on their share of the allowance. Bodies go through untouched (streams too); nothing is logged
 * but method, path, status and timing.
 *
 * Security: only this computer, and only programs that know the local token.
 * - It listens on 127.0.0.1 only.
 * - Every request must carry the local token (a random 256-bit string in dl's state directory,
 *   mode 0600) as its API key (`x-api-key` or `Authorization: Bearer`), so other users and
 *   other programs on the machine can't spend the person's free tokens.
 * - Browsers can't use it: a request with an `Origin` or `Sec-Fetch-Site` header (every browser
 *   sends one) is refused, there are no CORS headers, and the `Host` must be 127.0.0.1,
 *   localhost or [::1] with the proxy's port, so a DNS-rebinding page can't reach it either.
 * - The harness key never leaves the proxy; the free tier sign-in stays where Autopilot keeps it.
 */

export const PROXY_PORT = 4789;
export const PROXY_HOST = "127.0.0.1";
/** The model OpenAI-format apps name; Anthropic-format requests are served by it whatever they name. */
export const PROXY_MODEL = "deepseek/deepseek-v4.1-flash-1017";
/** A key unused this long is revoked (the next request mints another). */
export const IDLE_MS = 20 * 60_000;
/** A key closer than this to expiring is refreshed before it's used (after a sleep, say). */
const FRESH_MARGIN_MS = 2 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const CLEANUP_DEADLINE_MS = 3_000;
/** The service takes bodies up to 8 MB; a little room for the JSON around them. */
const MAX_BODY_BYTES = 9 * 1024 * 1024;
const TOKEN_RE = /^dlp_[A-Za-z0-9_-]{43}$/;

type Env = Record<string, string | undefined>;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

// ─── Files ───────────────────────────────────────────────────────────────────

export interface ProxyPaths {
  dir: string;
  /** The local token (0600). */
  token: string;
  /** {pid, port, startedAt} while a proxy runs. */
  pid: string;
  /** The background proxy's output. */
  log: string;
}

/** ~/.local/state/directionallylocal/proxy (XDG_STATE_HOME respected). */
export function proxyPaths(env: Env = process.env): ProxyPaths {
  const dir = join(dirname(modelStatePath(env as NodeJS.ProcessEnv)), "proxy");
  return { dir, token: join(dir, "token"), pid: join(dir, "proxy.pid"), log: join(dir, "proxy.log") };
}

/** The local token: read, or made once (random, 0600 in a 0700 directory). */
export async function localToken(paths: ProxyPaths): Promise<string> {
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  const existing = (await readFile(paths.token, "utf8").catch(() => "")).trim();
  if (TOKEN_RE.test(existing)) {
    // Keep it private even if someone loosened it.
    if (((await stat(paths.token)).mode & 0o077) !== 0) await chmod(paths.token, 0o600);
    return existing;
  }
  const token = `dlp_${randomBytes(32).toString("base64url")}`;
  await writeFile(paths.token, `${token}\n`, { mode: 0o600 });
  await chmod(paths.token, 0o600);
  return token;
}

export interface PidFile {
  pid: number;
  port: number;
  startedAt: string;
}

export async function readPidFile(paths: ProxyPaths): Promise<PidFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(paths.pid, "utf8")) as PidFile;
    return Number.isInteger(parsed.pid) && Number.isInteger(parsed.port) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// ─── Harness keys ────────────────────────────────────────────────────────────

interface LiveKey {
  id: string;
  key: string;
  origin: string;
  expiresAt: number;
  lastUsed: number;
  sessionId: string;
  started: number;
  events: number;
  lastEventAt: number;
}

export type KeyResult = { ok: true; key: string; origin: string } | { ok: false; status: number; code: string; message: string };

export interface KeyDeps {
  /** A fresh free tier access token (Autopilot's sign-in). */
  token: () => Promise<FreeTierToken>;
  fetch: Fetch;
  now: () => number;
  log: (line: string) => void;
}

/**
 * One harness key at a time for one harness, minted on first use. `get` hands out a key good for
 * at least two more minutes (refreshing or re-minting as needed); `tick` (every REFRESH_EVERY_MS)
 * refreshes a key in use and revokes an idle one.
 */
export class HarnessKeys {
  private live: LiveKey | undefined;
  private pending: Promise<KeyResult> | undefined;
  /** The service's `otherHarnessShare` from the last mint. */
  share: number | undefined;
  lastError: string | undefined;
  served = 0;

  constructor(readonly harness: Harness, private readonly deps: KeyDeps) {}

  status(): { live: boolean; expiresAt?: string; served: number; lastError?: string } {
    return { live: Boolean(this.live), ...(this.live ? { expiresAt: new Date(this.live.expiresAt).toISOString() } : {}), served: this.served, ...(this.lastError ? { lastError: this.lastError } : {}) };
  }

  async get(): Promise<KeyResult> {
    const live = this.live;
    if (live) {
      live.lastUsed = this.deps.now();
      if (live.expiresAt - this.deps.now() > FRESH_MARGIN_MS) return { ok: true, key: live.key, origin: live.origin };
      if (await this.refresh(live)) return { ok: true, key: live.key, origin: live.origin };
    }
    this.pending ??= this.mint().finally(() => (this.pending = undefined));
    return this.pending;
  }

  /** The service refused `key` (401): forget it, so the next `get` mints another. */
  invalidate(key: string): void {
    if (this.live?.key === key) {
      const dropped = this.live;
      this.live = undefined;
      void this.end(dropped, "invalid");
    }
  }

  /** Refresh the key in use; revoke an idle one; repeat session.start for long sessions. */
  async tick(): Promise<void> {
    const live = this.live;
    if (!live) return;
    if (this.deps.now() - live.lastUsed > IDLE_MS) {
      this.live = undefined;
      await this.end(live, "idle");
      return;
    }
    if (await this.refresh(live)) {
      if (this.deps.now() - live.lastEventAt >= SESSION_EVENT_EVERY_MS) await this.event(live, "session.start");
    }
  }

  /** Revoke the key and end its session (the proxy is stopping). */
  async close(): Promise<void> {
    const live = this.live;
    this.live = undefined;
    if (live) await this.end(live, "stopped");
  }

  private async mint(): Promise<KeyResult> {
    const token = await this.deps.token();
    if (!token.ok) {
      const message = token.reason === "signed_out" ? "dl proxy: not signed in to the free tier. Run dl once to sign in, then try again." : `dl proxy: ${token.message}`;
      this.lastError = message;
      return { ok: false, status: token.reason === "signed_out" ? 401 : 502, code: token.reason, message };
    }
    let response: Response;
    try {
      response = await this.deps.fetch(`${token.origin}/v1/harness-keys`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${token.accessToken}` },
        body: JSON.stringify({ harness: this.harness }),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const message = `dl proxy: couldn't reach the free tier (${error instanceof Error ? error.message : String(error)}).`;
      this.lastError = message;
      return { ok: false, status: 502, code: "unavailable", message };
    }
    const body = (await response.json().catch(() => undefined)) as Record<string, any> | undefined;
    if (response.status !== 201 || typeof body?.key !== "string" || typeof body.id !== "string") {
      const message = typeof body?.error?.message === "string" ? body.error.message : `The free tier refused dl proxy (HTTP ${response.status}).`;
      this.lastError = message;
      return { ok: false, status: response.status >= 400 && response.status < 600 ? response.status : 502, code: typeof body?.error?.code === "string" ? body.error.code : "refused", message };
    }
    const now = this.deps.now();
    const expires = Date.parse(String(body.expiresAt));
    const ttl = typeof body.ttlSeconds === "number" ? body.ttlSeconds * 1000 : 15 * 60_000;
    const live: LiveKey = {
      id: body.id,
      key: body.key,
      origin: token.origin,
      expiresAt: Number.isFinite(expires) ? expires : now + ttl,
      lastUsed: now,
      sessionId: `dl-proxy-${this.harness}-${randomUUID()}`,
      started: now,
      events: 0,
      lastEventAt: now,
    };
    if (typeof body.otherHarnessShare === "number") this.share = body.otherHarnessShare;
    this.lastError = undefined;
    // Before the key's first request, so the dl-only check counts it as dl's.
    await this.event(live, "session.start");
    this.live = live;
    this.deps.log(`${this.harness} key ready`);
    return { ok: true, key: live.key, origin: live.origin };
  }

  /** Extends the key; false (and the key dropped) when the service no longer has it. */
  private async refresh(live: LiveKey): Promise<boolean> {
    try {
      const response = await this.deps.fetch(`${live.origin}/v1/harness-keys/${live.id}/refresh`, {
        method: "POST",
        headers: { accept: "application/json", authorization: `Bearer ${live.key}` },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = (await response.json().catch(() => undefined)) as Record<string, any> | undefined;
      if (response.ok) {
        const expires = Date.parse(String(body?.expiresAt));
        live.expiresAt = Number.isFinite(expires) ? expires : this.deps.now() + 15 * 60_000;
        return true;
      }
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        if (this.live === live) this.live = undefined;
        void this.end(live, "expired", false);
        return false;
      }
    } catch {
      // Unreachable for now: keep the key while it lasts.
    }
    return live.expiresAt > this.deps.now();
  }

  private async end(live: LiveKey, reason: string, revoke = true): Promise<void> {
    await Promise.allSettled([
      this.event(live, "session.end", { durationMs: Math.max(0, this.deps.now() - live.started), exitReason: reason }),
      revoke
        ? this.deps.fetch(`${live.origin}/v1/harness-keys/${live.id}`, { method: "DELETE", headers: { accept: "application/json", authorization: `Bearer ${live.key}` }, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
        : Promise.resolve(),
    ]);
  }

  private async event(live: LiveKey, type: "session.start" | "session.end", props: Record<string, unknown> = {}): Promise<void> {
    live.lastEventAt = this.deps.now();
    try {
      await this.deps.fetch(`${live.origin}/v1/events`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${live.key}` },
        body: JSON.stringify({ events: [{ id: `${live.sessionId}-${++live.events}`, type, sessionId: live.sessionId, at: new Date(this.deps.now()).toISOString(), props: { harness: this.harness, os: platform(), ...props } }] }),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // Best effort.
    }
  }
}

// ─── The server ──────────────────────────────────────────────────────────────

type Format = "anthropic" | "openai";

/** The harness keys the proxy mints: Claude Code's for the Anthropic routes, OpenCode's for the OpenAI ones. */
type ProxyHarness = Extract<Harness, "claude-code" | "opencode">;

interface Route {
  harness: ProxyHarness;
  format: Format;
  /** The path on the service. */
  upstream: string;
}

/** The routes, by method and path (the query string goes along as it is). */
export function route(method: string, path: string): Route | undefined {
  // Apps may be given the base URL with or without /anthropic or /v1; accept the obvious spellings.
  const anthropicPath = path.replace(/^\/anthropic(?=\/)/, "");
  if (method === "POST" && (anthropicPath === "/v1/messages" || anthropicPath === "/v1/messages/count_tokens")) {
    return { harness: "claude-code", format: "anthropic", upstream: `/anthropic${anthropicPath}` };
  }
  if (method === "POST" && path === "/v1/chat/completions") return { harness: "opencode", format: "openai", upstream: path };
  if (method === "GET" && path === "/v1/models") return { harness: "opencode", format: "openai", upstream: path };
  return undefined;
}

/** Request headers passed to the service (everything else, the local token included, stays here). */
const FORWARD_REQUEST = new Set(["content-type", "accept", "anthropic-version", "anthropic-beta", "user-agent"]);
/** Response headers not passed back: hop-by-hop, and ones fetch already undid (compression). */
const DROP_RESPONSE = new Set(["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length", "upgrade", "proxy-connection", "set-cookie", "alt-svc"]);

function sha(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

/** The API key a request presents (`x-api-key`, or `Authorization: Bearer`). */
function presented(req: IncomingMessage): string | undefined {
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey.trim()) return apiKey.trim();
  const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? "");
  return match?.[1];
}

function errorBody(format: Format, status: number, message: string, code: string): string {
  if (format === "anthropic") {
    const type = status === 401 ? "authentication_error" : status === 403 ? "permission_error" : status === 404 ? "not_found_error" : status === 429 ? "rate_limit_error" : status === 413 ? "request_too_large" : status >= 500 ? "api_error" : "invalid_request_error";
    return JSON.stringify({ type: "error", error: { type, message } });
  }
  return JSON.stringify({ error: { message, type: code, code } });
}

function send(res: ServerResponse, status: number, body: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(body);
}

class TooLarge extends Error {}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new TooLarge();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export interface ProxyServerOptions extends KeyDeps {
  localToken: string;
  /** The port it listens on (the Host header must name it). */
  port: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (timer: unknown) => void;
  /** What GET /dl/status adds about the process. */
  info?: () => Record<string, unknown>;
}

export interface ProxyServer {
  server: Server;
  keys: Record<ProxyHarness, HarnessKeys>;
  /** Runs the refresh tick now (tests; the timer calls it every REFRESH_EVERY_MS). */
  tick: () => Promise<void>;
  /** Stops listening, ends open requests, revokes the keys and ends their sessions (bounded). */
  close: () => Promise<void>;
}

export function createProxyServer(options: ProxyServerOptions): ProxyServer {
  const keys: Record<ProxyHarness, HarnessKeys> = {
    "claude-code": new HarnessKeys("claude-code", options),
    opencode: new HarnessKeys("opencode", options),
  };
  const expected = sha(options.localToken);
  const hosts = new Set([`127.0.0.1:${options.port}`, `localhost:${options.port}`, `[::1]:${options.port}`]);
  const open = new Set<AbortController>();

  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      options.log(`error: ${error instanceof Error ? error.message : String(error)}`);
      send(res, 500, errorBody("openai", 500, "dl proxy failed on this request.", "proxy_error"));
    });
  });
  // Long generations stream for minutes; Node's default request timeout would cut them.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = options.now();
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    const matched = route(method, url.pathname);
    const format: Format = matched?.format ?? (url.pathname.includes("/messages") ? "anthropic" : "openai");
    const done = (status: number, harness = "-") => options.log(`${method} ${url.pathname} ${status} ${harness} ${options.now() - started}ms`);

    // Browsers (and DNS-rebinding pages) never get in.
    const host = (req.headers.host ?? "").toLowerCase();
    if (!hosts.has(host)) {
      send(res, 403, errorBody(format, 403, `dl proxy answers only on 127.0.0.1:${options.port}.`, "forbidden_host"));
      return done(403);
    }
    if (req.headers.origin !== undefined || req.headers["sec-fetch-site"] !== undefined || method === "OPTIONS") {
      send(res, 403, errorBody(format, 403, "dl proxy doesn't serve browsers.", "forbidden_origin"));
      return done(403);
    }
    const key = presented(req);
    if (!key || !timingSafeEqual(sha(key), expected)) {
      send(res, 401, errorBody(format, 401, key ? "That isn't dl proxy's local token. dl conductor prints it." : "dl proxy needs its local token as the API key. dl conductor prints it.", "invalid_local_token"));
      return done(401);
    }

    if (method === "GET" && url.pathname === "/dl/status") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({
        ...(options.info?.() ?? {}),
        port: options.port,
        otherHarnessShare: keys["claude-code"].share ?? keys.opencode.share ?? null,
        keys: { "claude-code": keys["claude-code"].status(), opencode: keys.opencode.status() },
      }));
      return; // Not logged: dl proxy start polls it.
    }
    if (!matched) {
      send(res, 404, errorBody(format, 404, `dl proxy serves POST /v1/messages, POST /v1/messages/count_tokens, POST /v1/chat/completions and GET /v1/models (not ${method} ${url.pathname}).`, "not_found"));
      return done(404);
    }

    let body: Buffer | undefined;
    if (method !== "GET") {
      try {
        body = await readBody(req);
      } catch (error) {
        if (!(error instanceof TooLarge)) throw error;
        send(res, 413, errorBody(format, 413, "The request body is larger than 8 MB.", "request_too_large"));
        return done(413);
      }
    }

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (FORWARD_REQUEST.has(name) && typeof value === "string") headers[name] = value;
    }
    const abort = new AbortController();
    open.add(abort);
    // The app hung up: stop the upstream request too (the service settles what was used).
    res.on("close", () => abort.abort());
    try {
      const harnessKeys = keys[matched.harness];
      for (let attempt = 0; ; attempt++) {
        const got = await harnessKeys.get();
        if (!got.ok) {
          send(res, got.status, errorBody(format, got.status, got.message, got.code));
          return done(got.status, matched.harness);
        }
        let upstream: Response;
        try {
          upstream = await options.fetch(`${got.origin}${matched.upstream}${url.search}`, {
            method,
            headers: { ...headers, authorization: `Bearer ${got.key}` },
            ...(body ? { body: new Uint8Array(body) as Uint8Array<ArrayBuffer> } : {}),
            redirect: "error",
            signal: abort.signal,
          });
        } catch (error) {
          if (abort.signal.aborted) return done(499, matched.harness);
          send(res, 502, errorBody(format, 502, `dl proxy couldn't reach the free tier (${error instanceof Error ? error.message : String(error)}).`, "unavailable"));
          return done(502, matched.harness);
        }
        // The service no longer takes this key (it expired while the computer slept): another, once.
        if (upstream.status === 401 && attempt === 0) {
          await upstream.body?.cancel().catch(() => undefined);
          harnessKeys.invalidate(got.key);
          continue;
        }
        harnessKeys.served++;
        const out: Record<string, string> = {};
        upstream.headers.forEach((value, name) => {
          if (!DROP_RESPONSE.has(name)) out[name] = value;
        });
        res.writeHead(upstream.status, out);
        res.flushHeaders();
        if (upstream.body) {
          try {
            for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
              if (!res.write(chunk)) await new Promise<void>((resolve) => { res.once("drain", resolve); res.once("close", resolve); });
              if (res.destroyed) break;
            }
          } catch {
            // The service or the app hung up mid-stream: nothing more to send.
            res.destroy();
            return done(upstream.status, matched.harness);
          }
        }
        res.end();
        return done(upstream.status, matched.harness);
      }
    } finally {
      open.delete(abort);
    }
  }

  const tick = async () => {
    await Promise.allSettled([keys["claude-code"].tick(), keys.opencode.tick()]);
  };
  const every = options.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms).unref());
  const stop = options.clearInterval ?? ((timer: unknown) => clearInterval(timer as NodeJS.Timeout));
  const timer = every(() => void tick(), REFRESH_EVERY_MS);

  const close = async () => {
    stop(timer);
    if (server.listening) server.close();
    for (const abort of open) abort.abort();
    server.closeAllConnections?.();
    await Promise.race([
      Promise.allSettled([keys["claude-code"].close(), keys.opencode.close()]),
      new Promise((resolve) => setTimeout(resolve, CLEANUP_DEADLINE_MS).unref()),
    ]);
  };
  return { server, keys, tick, close };
}

// ─── Commands ────────────────────────────────────────────────────────────────

export interface ProxyCommandDeps {
  env?: Env;
  paths?: ProxyPaths;
  token?: () => Promise<FreeTierToken>;
  signIn?: () => Promise<boolean>;
  fetch?: Fetch;
  /** Starts `dl proxy run` in the background; returns its pid. */
  startBackground?: (port: number, paths: ProxyPaths) => Promise<number | undefined>;
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  sleep?: (ms: number) => Promise<void>;
  terminal?: boolean;
  /** Runs a command (systemctl, launchctl) for install/uninstall. */
  exec?: (file: string, args: string[]) => Promise<{ code: number; output: string }>;
  /** Called by `dl proxy run` once it listens (tests stop it through the returned server). */
  onListening?: (proxy: ProxyServer) => void;
  platform?: NodeJS.Platform;
  home?: string;
}

export interface ProxyStatus {
  running: boolean;
  pid?: number;
  port: number;
  url: string;
  /** From the running proxy's /dl/status. */
  detail?: { otherHarnessShare?: number | null; keys?: Record<string, { live: boolean; expiresAt?: string; served: number; lastError?: string }>; startedAt?: string; service?: string };
  /** A pid file whose process is gone (removed). */
  stale?: boolean;
}

function portFrom(args: string[], env: Env): number | { error: string } {
  const index = args.findIndex((arg) => arg === "--port" || arg.startsWith("--port="));
  const raw = index === -1 ? env.DL_PROXY_PORT : args[index]!.includes("=") ? args[index]!.split("=")[1] : args[index + 1];
  if (raw === undefined || raw === "") return PROXY_PORT;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : { error: `--port must be a port number (got ${JSON.stringify(raw)}).` };
}

function alive(kill: (pid: number, signal: NodeJS.Signals | 0) => void, pid: number): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether a proxy runs, from its pid file and its own /dl/status (so a reused pid isn't taken for it). */
export async function proxyStatus(deps: ProxyCommandDeps = {}, fallbackPort = PROXY_PORT): Promise<ProxyStatus> {
  const paths = deps.paths ?? proxyPaths(deps.env);
  const kill = deps.kill ?? ((pid, signal) => void process.kill(pid, signal));
  const pidFile = await readPidFile(paths);
  const port = pidFile?.port ?? fallbackPort;
  const url = `http://${PROXY_HOST}:${port}`;
  const token = await localToken(paths);
  let detail: ProxyStatus["detail"] & { pid?: number } | undefined;
  try {
    const response = await (deps.fetch ?? fetch)(`${url}/dl/status`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2_000) });
    if (response.ok) detail = (await response.json()) as typeof detail;
  } catch {
    detail = undefined;
  }
  if (detail) return { running: true, port, url, ...(typeof detail.pid === "number" ? { pid: detail.pid } : {}), detail };
  if (pidFile && !alive(kill, pidFile.pid)) {
    await rm(paths.pid, { force: true });
    return { running: false, port, url, stale: true };
  }
  return { running: false, port, url, ...(pidFile ? { pid: pidFile.pid } : {}) };
}

/** `dl proxy run`: the proxy in this process, until a signal. */
export async function runProxy(args: string[], io: LaunchIO, deps: ProxyCommandDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const paths = deps.paths ?? proxyPaths(env);
  const port = portFrom(args, env);
  if (typeof port !== "number") {
    io.err(`  ${port.error}\n`);
    return 2;
  }
  const token = await localToken(paths);
  const startedAt = new Date().toISOString();
  const stamp = () => new Date().toISOString();
  const proxy = createProxyServer({
    localToken: token,
    port,
    token: deps.token ?? (() => freeTierAccessToken({ env })),
    fetch: deps.fetch ?? ((url, init) => fetch(url, init)),
    now: Date.now,
    log: (line) => io.out(`${stamp()} ${line}\n`),
    info: () => ({ pid: process.pid, startedAt, ...(env.DL_PROXY_SERVICE ? { service: env.DL_PROXY_SERVICE } : {}) }),
  });
  const listening = await new Promise<true | Error>((resolve) => {
    proxy.server.once("error", resolve);
    proxy.server.listen(port, PROXY_HOST, () => resolve(true));
  });
  if (listening !== true) {
    const inUse = (listening as NodeJS.ErrnoException).code === "EADDRINUSE";
    io.err(`  dl proxy: ${inUse ? `port ${port} is in use (another dl proxy? dl proxy status)` : listening.message}\n`);
    return 1;
  }
  await writeFile(paths.pid, JSON.stringify({ pid: process.pid, port, startedAt } satisfies PidFile), { mode: 0o600 });
  io.out(`${stamp()} dl proxy listening on http://${PROXY_HOST}:${port}\n`);
  // Check the sign-in now (and learn the share), so `dl proxy start` can say what's wrong.
  void proxy.keys["claude-code"].get().then((got) => io.out(`${stamp()} ${got.ok ? "free tier sign-in ok" : got.message}\n`));
  deps.onListening?.(proxy);

  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  let stopOn: (signal: NodeJS.Signals) => void = () => undefined;
  await new Promise<void>((resolve) => {
    stopOn = (signal: NodeJS.Signals) => {
      io.out(`${stamp()} ${signal}: stopping\n`);
      resolve();
    };
    for (const signal of signals) process.on(signal, stopOn);
    proxy.server.once("close", () => resolve());
  });
  for (const signal of signals) process.off(signal, stopOn);
  await proxy.close();
  const current = await readPidFile(paths);
  if (current?.pid === process.pid) await rm(paths.pid, { force: true });
  io.out(`${stamp()} dl proxy stopped\n`);
  return 0;
}

/** Starts `dl proxy run` detached, its output in the log file. */
async function startDetached(port: number, paths: ProxyPaths): Promise<number | undefined> {
  const script = process.argv[1];
  if (!script) return undefined;
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  const log = openSync(paths.log, "a", 0o600);
  try {
    const child = nodeSpawn(process.execPath, [...process.execArgv, script, "proxy", "run", "--port", String(port)], {
      detached: true,
      stdio: ["ignore", log, log],
      env: process.env,
    });
    child.unref();
    return child.pid;
  } finally {
    closeSync(log);
  }
}

/** Makes sure the person is signed in to the free tier (signing in when they aren't, in a terminal). */
async function ensureSignedIn(io: LaunchIO, deps: ProxyCommandDeps, env: Env, command: string): Promise<boolean> {
  const getToken = deps.token ?? (() => freeTierAccessToken({ env }));
  let token = await getToken();
  if (!token.ok && token.reason === "signed_out") {
    if (!(deps.terminal ?? process.stdin.isTTY === true)) {
      io.err(`  ${command} uses your free tier sign-in, and you aren't signed in. Run dl once to sign in, then ${command} again.\n`);
      return false;
    }
    io.out(`  ${command} uses your free tier sign-in. Signing in first.\n`);
    if (!(await (deps.signIn ?? (() => autopilotSignIn(io, command)))())) {
      io.err(`  Not signed in to the free tier, so ${command} can't start.\n`);
      return false;
    }
    token = await getToken();
  }
  if (!token.ok) {
    io.err(`  ${token.reason === "signed_out" ? `Not signed in to the free tier. Run dl once to sign in.` : token.message}\n`);
    return false;
  }
  return true;
}

/** `dl proxy start`: in the background, unless one runs already. */
export async function startProxy(args: string[], io: LaunchIO, deps: ProxyCommandDeps = {}, command = "dl proxy start"): Promise<ProxyStatus | undefined> {
  const env = deps.env ?? process.env;
  const paths = deps.paths ?? proxyPaths(env);
  const port = portFrom(args, env);
  if (typeof port !== "number") {
    io.err(`  ${port.error}\n`);
    return undefined;
  }
  const before = await proxyStatus(deps, port);
  if (before.running) return before;
  if (!(await ensureSignedIn(io, deps, env, command))) return undefined;
  const pid = await (deps.startBackground ?? startDetached)(port, paths);
  if (pid === undefined) {
    io.err(`  Couldn't start dl proxy in the background. Run it in a terminal instead: dl proxy run\n`);
    return undefined;
  }
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let waited = 0; waited < 10_000; waited += 250) {
    await sleep(250);
    const now = await proxyStatus(deps, port);
    // Wait for the sign-in check too, so a refusal shows here.
    const key = now.detail?.keys?.["claude-code"];
    if (now.running && (key?.live || key?.lastError || waited >= 5_000)) return now;
    if (!now.running && !alive(deps.kill ?? ((p, s) => void process.kill(p, s)), pid)) break;
  }
  io.err(`  dl proxy didn't start. Its log: ${paths.log}\n`);
  return undefined;
}

/** `dl proxy stop`. */
export async function stopProxy(io: LaunchIO, deps: ProxyCommandDeps = {}): Promise<number> {
  const status = await proxyStatus(deps);
  if (!status.running) {
    io.out(`  dl proxy isn't running.\n`);
    return 0;
  }
  if (status.pid === undefined) {
    io.err(`  dl proxy answers on ${status.url}, but didn't say its process id. Stop it where it was started.\n`);
    return 1;
  }
  const kill = deps.kill ?? ((pid, signal) => void process.kill(pid, signal));
  kill(status.pid, "SIGTERM");
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let waited = 0; waited < 6_000; waited += 200) {
    // Gone once it has revoked its keys and removed its pid file (bounded by CLEANUP_DEADLINE_MS).
    if (!alive(kill, status.pid)) {
      io.out(`  dl proxy stopped.${status.detail?.service ? ` It's installed as a service and starts again at login; dl proxy uninstall removes it.` : ""}\n`);
      return 0;
    }
    await sleep(200);
  }
  io.err(`  dl proxy (pid ${status.pid}) didn't stop.\n`);
  return 1;
}

function describeStatus(status: ProxyStatus, color: ReturnType<typeof palette>): string {
  if (!status.running) return `  dl proxy isn't running. ${color.dim("Start it: dl proxy start")}\n`;
  const lines = [`  dl proxy is running at ${status.url}${status.pid ? ` (pid ${status.pid})` : ""}${status.detail?.service ? `, as a ${status.detail.service} service` : ""}.`];
  for (const [harness, label] of [["claude-code", "Anthropic format (as Claude Code)"], ["opencode", "OpenAI format (as OpenCode)"]] as const) {
    const key = status.detail?.keys?.[harness];
    if (!key) continue;
    const state = key.live ? `key good until ${key.expiresAt}` : "no key now (one is made on the next request)";
    lines.push(`    ${label}: ${key.served} request${key.served === 1 ? "" : "s"} served, ${state}${key.lastError ? `. Last error: ${key.lastError}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

// ─── Run at login ────────────────────────────────────────────────────────────

export const SYSTEMD_UNIT = "dl-proxy.service";
export const LAUNCH_AGENT = "com.directionallylocal.proxy";

export function serviceFiles(input: { platform: NodeJS.Platform; home: string; node: string; script: string; port: number; log: string; env: Env }): { path: string; text: string } | undefined {
  const args = [input.node, input.script, "proxy", "run", "--port", String(input.port)];
  if (input.platform === "linux") {
    const configHome = input.env.XDG_CONFIG_HOME?.trim() || join(input.home, ".config");
    const quote = (arg: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\$`])/g, "\\$1")}"`);
    return {
      path: join(configHome, "systemd", "user", SYSTEMD_UNIT),
      text: [
        "# Written by dl proxy install: desktop coding apps on dl's free tier (127.0.0.1 only).",
        "[Unit]",
        "Description=dl proxy (Directionally Local free tier for desktop apps)",
        "",
        "[Service]",
        `ExecStart=${args.map(quote).join(" ")}`,
        "Environment=DL_PROXY_SERVICE=systemd",
        "Restart=on-failure",
        "RestartSec=5",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n"),
    };
  }
  if (input.platform === "darwin") {
    const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return {
      path: join(input.home, "Library", "LaunchAgents", `${LAUNCH_AGENT}.plist`),
      text: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by dl proxy install: desktop coding apps on dl's free tier (127.0.0.1 only). -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_AGENT}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${xml(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>DL_PROXY_SERVICE</key><string>launchd</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${xml(input.log)}</string>
  <key>StandardErrorPath</key><string>${xml(input.log)}</string>
</dict>
</plist>
`,
    };
  }
  return undefined;
}

const execFileAsync = promisify(execFile);
async function realExec(file: string, args: string[]): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { timeout: 20_000 });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const failed = error as { code?: number | string; stdout?: string; stderr?: string; message: string };
    return { code: typeof failed.code === "number" ? failed.code : 1, output: `${failed.stdout ?? ""}${failed.stderr ?? failed.message}` };
  }
}

async function installService(args: string[], io: LaunchIO, deps: ProxyCommandDeps): Promise<number> {
  const env = deps.env ?? process.env;
  const paths = deps.paths ?? proxyPaths(env);
  const os = deps.platform ?? platform();
  const port = portFrom(args, env);
  if (typeof port !== "number") {
    io.err(`  ${port.error}\n`);
    return 2;
  }
  const script = process.argv[1];
  const files = script ? serviceFiles({ platform: os, home: deps.home ?? homedir(), node: process.execPath, script, port, log: paths.log, env }) : undefined;
  if (!files) {
    io.err(`  dl proxy install works on macOS (a LaunchAgent) and Linux (a systemd user service). Here, run it in a terminal: dl proxy run\n`);
    return 1;
  }
  if (!(await ensureSignedIn(io, deps, env, "dl proxy install"))) return 1;
  // A background proxy from dl proxy start would hold the port.
  if ((await proxyStatus(deps, port)).running) await stopProxy({ out: () => undefined, err: io.err }, deps);
  await mkdir(dirname(files.path), { recursive: true });
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  await writeFile(files.path, files.text);
  const exec = deps.exec ?? realExec;
  const steps: Array<[string, string[]]> = os === "linux"
    ? [["systemctl", ["--user", "daemon-reload"]], ["systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]]]
    : [["launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${LAUNCH_AGENT}`]], ["launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 501}`, files.path]]];
  for (const [index, [file, stepArgs]] of steps.entries()) {
    const result = await exec(file, stepArgs);
    // bootout fails when it wasn't loaded; that's fine.
    if (result.code !== 0 && !(os === "darwin" && index === 0)) {
      io.err(`  ${file} ${stepArgs.join(" ")} failed: ${result.output.trim()}\n  The service file is at ${files.path}. Or run the proxy in a terminal: dl proxy run\n`);
      return 1;
    }
  }
  io.out(`  dl proxy installed: it starts at login and runs at http://${PROXY_HOST}:${port}.\n  ${os === "linux" ? `systemd user service: ${files.path}` : `LaunchAgent: ${files.path}`}\n  Remove it: dl proxy uninstall\n`);
  if (os === "linux") io.out(`  ${palette(!env.NO_COLOR && env.TERM !== "dumb" && (deps.terminal ?? process.stdout.isTTY === true)).dim("On a server without a desktop login, also run: loginctl enable-linger")}\n`);
  return 0;
}

async function uninstallService(io: LaunchIO, deps: ProxyCommandDeps): Promise<number> {
  const env = deps.env ?? process.env;
  const paths = deps.paths ?? proxyPaths(env);
  const os = deps.platform ?? platform();
  const files = serviceFiles({ platform: os, home: deps.home ?? homedir(), node: process.execPath, script: "dl", port: PROXY_PORT, log: paths.log, env });
  if (!files) {
    io.out(`  Nothing to uninstall here.\n`);
    return 0;
  }
  const exists = await stat(files.path).then(() => true, () => false);
  if (!exists) {
    io.out(`  dl proxy isn't installed as a service.\n`);
    return 0;
  }
  const exec = deps.exec ?? realExec;
  if (os === "linux") await exec("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
  else await exec("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${LAUNCH_AGENT}`]);
  await rm(files.path, { force: true });
  if (os === "linux") await exec("systemctl", ["--user", "daemon-reload"]);
  io.out(`  dl proxy service removed (${files.path}).\n`);
  return 0;
}

// ─── dl proxy ────────────────────────────────────────────────────────────────

export const PROXY_USAGE = `  Usage: dl proxy start|stop|status|run|install|uninstall [--port N]

  dl proxy start       run the proxy in the background (http://127.0.0.1:${PROXY_PORT})
  dl proxy stop        stop it
  dl proxy status      whether it runs, and what it has served
  dl proxy run         run it in this terminal (Ctrl-C stops it)
  dl proxy install     start it at login (macOS LaunchAgent, Linux systemd user service)
  dl proxy uninstall   remove that
  dl conductor         the settings for Conductor and other desktop apps
`;

export async function proxyCommand(args: string[], io: LaunchIO, deps: ProxyCommandDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const color = palette(!env.NO_COLOR && env.TERM !== "dumb" && (deps.terminal ?? process.stdout.isTTY === true));
  const [sub, ...rest] = args;
  switch (sub) {
    case "start": {
      const status = await startProxy(rest, io, deps);
      if (!status) return 1;
      io.out(describeStatus(status, color));
      const nudge = autopilotNudge(status.detail?.otherHarnessShare);
      if (nudge) io.out(`  ${color.dim(nudge)}\n`);
      io.out(`  ${color.dim("Settings for Conductor and other apps: dl conductor")}\n`);
      return 0;
    }
    case "stop":
      return stopProxy(io, deps);
    case "status":
    case undefined: {
      const status = await proxyStatus(deps);
      io.out(describeStatus(status, color));
      return 0;
    }
    case "run":
      return runProxy(rest, io, deps);
    case "install":
      return installService(rest, io, deps);
    case "uninstall":
      return uninstallService(io, deps);
    case "token": {
      io.out(`${await localToken(deps.paths ?? proxyPaths(env))}\n`);
      return 0;
    }
    default:
      io.err(PROXY_USAGE);
      return 2;
  }
}

// ─── dl conductor ────────────────────────────────────────────────────────────

/** What `dl conductor` prints once the proxy runs. */
export function conductorText(input: { url: string; token: string; share?: number | null | undefined; color: ReturnType<typeof palette> }): string {
  const { url, token, color } = input;
  const nudge = autopilotNudge(input.share);
  return `
  ${color.bold("Conductor on dl's free tier")}
  Claude Code in Conductor, answered by DeepSeek V4.1 Flash through dl proxy at ${url}.

  In Conductor: Settings → Environment (env vars every workspace gets), add:

    ANTHROPIC_BASE_URL=${url}
    ANTHROPIC_AUTH_TOKEN=${token}

  and take out ANTHROPIC_API_KEY if it's set there. Leave the model as it is: whatever
  Claude Code asks for, the free tier answers with DeepSeek. Restart running workspaces.

  Free tokens work in Conductor while dl proxy runs on this computer (after a restart:
  dl proxy start, or dl proxy install to start it at login). The token above is only for
  this computer's proxy; it isn't your free tier sign-in.
${nudge ? `  ${color.dim(nudge)}\n` : ""}
  ${color.bold("Other desktop apps, same proxy")}
    Zed, Cline (VS Code), other OpenAI-compatible apps on this computer:
      base URL  ${url}/v1
      API key   the token above
      model     ${PROXY_MODEL}
    Apps that speak Anthropic's API: base URL ${url}, API key the token above.
    Cursor won't work: it sends requests for a custom OpenAI base URL from its own
    servers, which can't reach 127.0.0.1 on your computer. Use dl api-key for Cursor:
    an API key for any tool, with nothing running here.
    Browsers and web pages can't use the proxy, by design.

`;
}

/** `dl conductor`: starts the proxy if it isn't running and prints Conductor's settings. */
export async function conductorCommand(args: string[], io: LaunchIO, deps: ProxyCommandDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const color = palette(!env.NO_COLOR && env.TERM !== "dumb" && (deps.terminal ?? process.stdout.isTTY === true));
  if (args.includes("--help") || args.includes("-h")) {
    io.out(`  Usage: dl conductor [--port N]\n  Starts dl proxy (if it isn't running) and prints the settings for Conductor and other desktop apps.\n`);
    return 0;
  }
  const status = await startProxy(args, io, deps, "dl conductor");
  if (!status) return 1;
  const keyError = status.detail?.keys?.["claude-code"]?.lastError;
  if (keyError) io.err(`  ${keyError}\n`);
  const token = await localToken(deps.paths ?? proxyPaths(env));
  io.out(conductorText({ url: status.url, token, share: status.detail?.otherHarnessShare, color }));
  return keyError ? 1 : 0;
}
