import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { tailnetPort, UI_PORT } from "./chat-ui.js";
import { agentSupport, localModelFrom, LOCAL_PROVIDER, outputLimit, type LocalModel } from "./laptop/local-agents.js";
import { inspectContainer, removeContainer } from "./model-runtime.js";
import { localFetch, type FetchModel } from "./model-smoke.js";
import { DEFAULT_DEPLOYMENT, modelStatePath, readDeployments } from "./state.js";
import type { System } from "./system.js";
import { HTTPS_CERTS_URL, serveHttps, stopServing, tailnetUrl, tailscaleState } from "./tailscale.js";
import { palette } from "./ui.js";

/**
 * `dl model endpoint`, `dl model share` and `dl model keys`: this box's model as an
 * OpenAI-compatible API that any coding tool can use, behind dl-generated API keys.
 *
 * The engine (vLLM or SGLang) is left exactly as `dl model up` runs it: published on 127.0.0.1
 * only, without a key, for dl's own users of it (Autopilot's provider, the team chat, the
 * sandbox, the agents dl opens, smoke tests, bench and evals). In front of it dl runs a small
 * key-checking proxy in its own container (dl-model-api, Node, --network host), and that proxy
 * is what gets shared. Why a proxy and not the engine's own --api-key:
 * - vLLM's --api-key covers only some path prefixes (/v1, /v2, /inference, /cohere; vLLM's docs
 *   say /invocations stays open) and SGLang has admin endpoints outside /v1; the proxy forwards
 *   /v1 only, with GET and POST.
 * - Keys can be added and revoked without restarting the engine (minutes of reload): the proxy
 *   reads the key hashes on every request. SGLang takes one key only.
 * - Widening or narrowing access restarts only the proxy, never the model.
 * - Nothing dl already runs on the model has to learn a key, so the team chat flow is untouched.
 *
 * Files, next to dl model's state (~/.local/state/directionallylocal):
 * - api.json (0600): the keys in full (so --show-key can print them), the port and the exposure.
 * - api/ (0700), mounted read-only into the proxy: proxy.mjs, keys.json (SHA-256 hashes only,
 *   never the keys) and upstream.json (the box model's port; rewritten by dl model up, update,
 *   rollback and down, so the endpoint follows the model).
 *
 * Exposure, one at a time (dl model share): local (127.0.0.1, the default), lan (0.0.0.0),
 * tailscale (127.0.0.1 + `tailscale serve` HTTPS on the tailnet only) and public (127.0.0.1 + a
 * Cloudflare quick tunnel container, dl-model-api-tunnel). A key is required in every mode.
 */

export const API_PORT = 8800;
export const API_CONTAINER = "dl-model-api";
export const TUNNEL_CONTAINER = "dl-model-api-tunnel";
export const API_SPEC_LABEL = "dl.api.spec";
/** Node 24.22.2 on Alpine (5 Nov 2026), by tag and the digest of its multi-arch index. */
export const PROXY_IMAGE = "node:24.22.2-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8";
/** cloudflared 2026.10.7 (30 Oct 2026), by tag and the digest of its multi-arch index. */
export const CLOUDFLARED_IMAGE = "cloudflare/cloudflared:2026.10.7@sha256:4955524aeaa379e154023d5a027c250f7b35041a2e7e950cf13f144bc9b9c5ba";
/** Tailnet HTTPS ports for the API, in order; the team chat takes 443 first. */
const TAILNET_API_PORTS = [8443, 10000, 443];
const LOOPBACK = "127.0.0.1";

export type ShareMode = "local" | "lan" | "tailscale" | "public";
export type Exposure = { mode: "local" } | { mode: "lan" } | { mode: "tailscale"; httpsPort: number; url: string } | { mode: "public" };

export interface ApiKey { id: string; name: string; key: string; created: string }

export interface ApiState { version: 1; port: number; keys: ApiKey[]; exposure: Exposure }

export interface ModelApiOptions {
  system: System;
  out: (text: string) => void;
  color?: boolean;
  /** dl model's state file; api.json and api/ sit beside it. */
  statePath?: string;
  /** --show-key: print keys in full. */
  showKey?: boolean;
  /** --off (endpoint: stop the API; share: back to this machine only). */
  off?: boolean;
  /** share --lan / --tailscale / --public (exactly one, or --off). */
  lan?: boolean;
  tailscale?: boolean;
  public?: boolean;
  /** --port: the API's port, when the endpoint is first turned on. */
  port?: string;
  /** The proxy container's user (uid:gid), so it can read the 0600 files; this process's unless replaced. */
  user?: string;
  fetch?: FetchModel;
  delay?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export const ENDPOINT_USAGE = "dl model endpoint [--show-key] [--port PORT] · dl model endpoint --off";
export const SHARE_USAGE = "dl model share --lan | --tailscale | --public | --off";
export const KEYS_USAGE = "dl model keys [add [NAME] | revoke ID|NAME] [--show-key]";

export function apiStatePath(statePath = modelStatePath()): string {
  return join(dirname(statePath), "api.json");
}

export function apiDir(statePath = modelStatePath()): string {
  return join(dirname(statePath), "api");
}

/** A new key: "dl-" and 32 random URL-safe characters (192 bits). */
export function newKey(): string {
  return `dl-${randomBytes(24).toString("base64url")}`;
}

export function maskKey(key: string): string {
  return key.length <= 12 ? "…" : `${key.slice(0, 7)}…${key.slice(-4)}`;
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function validExposure(value: unknown): Exposure | undefined {
  const raw = value as Record<string, unknown> | undefined;
  if (raw?.mode === "local" || raw?.mode === "lan" || raw?.mode === "public") return { mode: raw.mode };
  if (raw?.mode === "tailscale" && typeof raw.url === "string" && Number.isInteger(raw.httpsPort)) return { mode: "tailscale", url: raw.url, httpsPort: raw.httpsPort as number };
  return undefined;
}

export async function readApiState(system: System, path: string): Promise<ApiState | undefined> {
  const raw = await system.readFile(path);
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const keys = Array.isArray(value.keys) ? value.keys.filter((key): key is ApiKey => !!key && typeof key.id === "string" && typeof key.name === "string" && typeof key.key === "string" && typeof key.created === "string") : undefined;
    const exposure = validExposure(value.exposure);
    if (value.version !== 1 || !Number.isInteger(value.port) || !keys || !exposure) throw new Error("invalid");
    return { version: 1, port: value.port as number, keys, exposure };
  } catch {
    throw new Error(`Invalid dl model endpoint state at ${path}; fix or remove it (dl model endpoint --off, then remove the file, starts over).`);
  }
}

async function writeApiState(system: System, path: string, state: ApiState): Promise<void> {
  await system.mkdir(dirname(path), { mode: 0o700 });
  await system.writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, secret: true });
}

/**
 * The proxy, as the file the container runs. Plain Node, nothing imported but node: modules.
 * Every request: /v1 paths only, GET and POST only, a key whose SHA-256 is in keys.json
 * (Authorization: Bearer KEY, or x-api-key: KEY for Anthropic-style clients), then forwarded to
 * the model on 127.0.0.1:<upstream.json's port> without the key. Logs one line per request
 * (method, path, status, time), never bodies or keys.
 */
export const PROXY_SOURCE = `// dl model endpoint: an API-key check in front of this box's model. Written by dl; replaced when dl changes it.
import { createServer, request } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

const DIR = process.env.DL_API_DIR || "/dl";
const HOST = process.env.DL_API_HOST || "127.0.0.1";
const PORT = Number(process.env.DL_API_PORT || "${API_PORT}");
const REQUEST_ONLY = new Set(["host", "authorization", "x-api-key"]);
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);

function read(name) {
  try { return JSON.parse(readFileSync(DIR + "/" + name, "utf8")); } catch { return undefined; }
}

function hashes() {
  const value = read("keys.json");
  return Array.isArray(value && value.sha256) ? value.sha256.filter((hash) => typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)).map((hash) => Buffer.from(hash, "hex")) : [];
}

function presented(req) {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && /^bearer\\s+/i.test(auth)) return auth.replace(/^bearer\\s+/i, "").trim();
  const key = req.headers["x-api-key"];
  return typeof key === "string" ? key.trim() : "";
}

function allowed(key) {
  if (!key) return false;
  const digest = createHash("sha256").update(key).digest();
  let ok = false;
  for (const hash of hashes()) if (timingSafeEqual(hash, digest)) ok = true;
  return ok;
}

function fail(res, status, message, code) {
  const body = JSON.stringify({ error: { message, type: status === 401 ? "authentication_error" : "invalid_request_error", code } });
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const server = createServer((req, res) => {
  const started = Date.now();
  const path = (req.url || "/").split("?")[0];
  res.on("finish", () => console.log(new Date().toISOString() + " " + req.method + " " + path.slice(0, 100) + " " + res.statusCode + " " + (Date.now() - started) + "ms"));
  if (!(path === "/v1" || path.startsWith("/v1/")) || /\\.\\.|%2e|\\\\/i.test(path)) return fail(res, 404, "Not found: this endpoint serves /v1 only", "not_found");
  if (req.method !== "GET" && req.method !== "POST") return fail(res, 405, "Method not allowed", "method_not_allowed");
  if (!allowed(presented(req))) return fail(res, 401, "Invalid or missing API key (dl model keys)", "invalid_api_key");
  const upstream = read("upstream.json");
  const port = Number(upstream && upstream.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return fail(res, 503, "No model is serving on this box (dl model up)", "no_model");
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) if (!REQUEST_ONLY.has(name) && !HOP.has(name) && value !== undefined) headers[name] = value;
  const out = request({ host: "127.0.0.1", port, method: req.method, path: req.url, headers }, (answer) => {
    const back = {};
    for (const [name, value] of Object.entries(answer.headers)) if (!HOP.has(name) && value !== undefined) back[name] = value;
    res.writeHead(answer.statusCode || 502, back);
    answer.pipe(res);
  });
  out.on("error", () => {
    if (!res.headersSent) fail(res, 502, "The model didn't answer (dl model status)", "upstream_error");
    else res.destroy();
  });
  // The client went away: stop the generation too.
  res.on("close", () => { if (!res.writableFinished) out.destroy(); });
  req.pipe(out);
});
server.headersTimeout = 60000;
server.requestTimeout = 600000;
server.keepAliveTimeout = 65000;
server.listen(PORT, HOST, () => console.log("dl model endpoint listening on " + HOST + ":" + PORT));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
`;

/** The box's model, the one the endpoint serves: the default deployment, else the only one, else the first by name. */
export async function endpointModel(system: System, statePath: string): Promise<{ model: LocalModel; port: number } | undefined> {
  const deployments = await readDeployments(system, statePath).catch(() => ({} as Awaited<ReturnType<typeof readDeployments>>));
  const names = Object.keys(deployments).sort();
  const name = names.includes(DEFAULT_DEPLOYMENT) ? DEFAULT_DEPLOYMENT : names[0];
  if (!name) return undefined;
  const active = deployments[name]!.active;
  return { model: localModelFrom(name, active), port: active.port };
}

/** Writes what the proxy reads: its source, the key hashes and the model's port (none: it answers 503). */
async function writeProxyFiles(system: System, statePath: string, state: ApiState): Promise<void> {
  const dir = apiDir(statePath);
  await system.mkdir(dir, { mode: 0o700 });
  await system.writeFile(join(dir, "proxy.mjs"), PROXY_SOURCE, { mode: 0o600 });
  await system.writeFile(join(dir, "keys.json"), `${JSON.stringify({ sha256: state.keys.map((key) => hashKey(key.key)) })}\n`, { mode: 0o600 });
  await writeUpstream(system, statePath);
}

async function writeUpstream(system: System, statePath: string): Promise<void> {
  const target = await endpointModel(system, statePath);
  const path = join(apiDir(statePath), "upstream.json");
  if (target) await system.writeFile(path, `${JSON.stringify({ port: target.port, model: target.model.model })}\n`, { mode: 0o600 });
  else await system.remove(path);
}

/**
 * After dl model up, update, rollback or down: the endpoint follows the box's model (the proxy
 * reads upstream.json on every request, so nothing restarts). Nothing happens without an endpoint.
 */
export async function refreshModelApi(system: System, statePath = modelStatePath()): Promise<void> {
  if (!(await system.exists(apiStatePath(statePath)))) return;
  await system.mkdir(apiDir(statePath), { mode: 0o700 });
  await writeUpstream(system, statePath);
}

function processUser(): string {
  return typeof process.getuid === "function" && typeof process.getgid === "function" ? `${process.getuid()}:${process.getgid()}` : "0:0";
}

/** `docker run` for the proxy, labeled with a hash of everything (its source too), so a re-run knows whether it can keep the container. */
export function proxyDockerArgs(state: Pick<ApiState, "port" | "exposure">, dir: string, user: string): string[] {
  const host = state.exposure.mode === "lan" ? "0.0.0.0" : LOOPBACK;
  const container = ["--name", API_CONTAINER, "--restart", "unless-stopped", "--network", "host", "--user", user,
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "256m",
    "-v", `${dir}:/dl:ro`, "-e", "DL_API_DIR=/dl", "-e", `DL_API_HOST=${host}`, "-e", `DL_API_PORT=${state.port}`];
  const spec = createHash("sha256").update(JSON.stringify([...container, PROXY_IMAGE, PROXY_SOURCE])).digest("hex").slice(0, 16);
  return ["run", "-d", ...container, "--label", `${API_SPEC_LABEL}=${spec}`, PROXY_IMAGE, "node", "/dl/proxy.mjs"];
}

export function tunnelDockerArgs(port: number): string[] {
  return ["run", "-d", "--name", TUNNEL_CONTAINER, "--restart", "unless-stopped", "--network", "host", "--label", `${API_SPEC_LABEL}=tunnel-${port}`,
    CLOUDFLARED_IMAGE, "tunnel", "--no-autoupdate", "--url", `http://${LOOPBACK}:${port}`];
}

function specOf(args: readonly string[]): string {
  return args[args.indexOf("--label") + 1]!.slice(API_SPEC_LABEL.length + 1);
}

function sleeper(options: Pick<ModelApiOptions, "delay">): (ms: number) => Promise<void> {
  return options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

/** Starts (or keeps, when it runs these exact settings) the proxy, and waits until it checks keys. */
async function ensureProxy(options: ModelApiOptions, statePath: string, state: ApiState): Promise<"started" | "kept"> {
  const { system } = options;
  await writeProxyFiles(system, statePath, state);
  const args = proxyDockerArgs(state, apiDir(statePath), options.user ?? processUser());
  const existing = await inspectContainer(system, API_CONTAINER, API_SPEC_LABEL);
  if (existing?.running && existing.spec === specOf(args)) return "kept";
  if (existing) await removeContainer(system, API_CONTAINER);
  await system.run("docker", args);
  if (system.dryRun) return "started";
  // Up when a request without a key is refused by the proxy itself (401), not by something else on the port.
  const call = options.fetch ?? localFetch;
  const delay = sleeper(options);
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await call(`http://${LOOPBACK}:${state.port}/v1/models`, { signal: AbortSignal.timeout(2_000) });
      const body = await response.text().catch(() => "");
      if (response.status === 401 && body.includes("invalid_api_key")) return "started";
    } catch { /* not listening yet */ }
    if (attempt > 4 && !(await inspectContainer(system, API_CONTAINER, API_SPEC_LABEL))?.running) break;
    await delay(500);
  }
  throw new Error(`The API endpoint didn't come up on port ${state.port}; see docker logs ${API_CONTAINER} (is the port taken? dl model endpoint --off, then dl model endpoint --port PORT).`);
}

/** This machine's address on its network: the source address of its default route. */
export async function lanAddress(system: System): Promise<string | undefined> {
  const route = await system.probe("ip", ["-4", "route", "get", "1.1.1.1"]);
  const match = /\bsrc\s+(\d+\.\d+\.\d+\.\d+)/.exec(route.stdout);
  if (route.code === 0 && match) return match[1];
  const names = await system.probe("hostname", ["-I"]);
  return names.code === 0 ? names.stdout.trim().split(/\s+/).find((address) => /^\d+\.\d+\.\d+\.\d+$/.test(address)) : undefined;
}

/** The quick tunnel's https://….trycloudflare.com URL, from its log (it changes whenever the tunnel restarts). */
export async function tunnelUrl(system: System): Promise<string | undefined> {
  const logs = await system.probe("docker", ["logs", TUNNEL_CONTAINER]);
  const urls = `${logs.stdout}\n${logs.stderr}`.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
  return urls?.at(-1);
}

/** Where tools reach the API now: the base URL for this exposure (undefined: not known yet). */
export async function endpointBaseUrl(system: System, state: ApiState): Promise<string | undefined> {
  switch (state.exposure.mode) {
    case "local": return `http://${LOOPBACK}:${state.port}/v1`;
    case "lan": { const address = await lanAddress(system); return address ? `http://${address}:${state.port}/v1` : undefined; }
    case "tailscale": return `${state.exposure.url}/v1`;
    case "public": { const url = await tunnelUrl(system); return url ? `${url}/v1` : undefined; }
  }
}

export function exposureText(exposure: Exposure): string {
  switch (exposure.mode) {
    case "local": return "this machine only";
    case "lan": return "your network (every interface, 0.0.0.0)";
    case "tailscale": return "your tailnet only (HTTPS, tailscale serve)";
    case "public": return "the internet (Cloudflare quick tunnel)";
  }
}

function localUrl(state: Pick<ApiState, "port">): string {
  return `http://${LOOPBACK}:${state.port}`;
}

/** Undoes the current exposure's extra piece (tailscale serve, the tunnel); the proxy itself is restarted by ensureProxy. */
async function teardown(system: System, state: ApiState): Promise<void> {
  if (state.exposure.mode === "tailscale") await stopServing(system, state.exposure.httpsPort, localUrl(state));
  await removeContainer(system, TUNNEL_CONTAINER);
}

function parseApiPort(text: string): number {
  const port = Number(text);
  if (!/^\d+$/.test(text) || port < 1 || port > 65535) throw new Error("Port must be an integer between 1 and 65535.");
  return port;
}

/** A port dl's other services hold. */
async function portClash(system: System, statePath: string, port: number): Promise<string | undefined> {
  if (port === UI_PORT) return "the team chat (dl ui)";
  const deployments = await readDeployments(system, statePath).catch(() => ({} as Awaited<ReturnType<typeof readDeployments>>));
  const owner = Object.entries(deployments).find(([, entry]) => entry.active.port === port || entry.previous?.port === port || entry.active.port + 1 === port);
  return owner ? `model deployment ${owner[0]}` : undefined;
}

/** Turns the endpoint on (this machine only) when it's off; otherwise makes sure the proxy runs. */
export async function enableEndpoint(options: ModelApiOptions): Promise<{ state: ApiState; created: boolean; target: { model: LocalModel; port: number } }> {
  const { system } = options;
  const statePath = options.statePath ?? modelStatePath();
  const target = await endpointModel(system, statePath);
  if (!target) throw new Error("No model on this box yet: dl model up, then dl model endpoint.");
  const path = apiStatePath(statePath);
  let state = await readApiState(system, path);
  const created = !state;
  if (state && options.port !== undefined && parseApiPort(options.port) !== state.port) throw new Error(`The endpoint is on port ${state.port}; to move it: dl model endpoint --off, then dl model endpoint --port ${options.port}.`);
  if (!state) {
    const port = options.port !== undefined ? parseApiPort(options.port) : API_PORT;
    const clash = await portClash(system, statePath, port);
    if (clash) throw new Error(`Port ${port} belongs to ${clash}; pick another: dl model endpoint --port PORT.`);
    state = { version: 1, port, keys: [{ id: keyId(), name: "default", key: newKey(), created: (options.now ?? (() => new Date()))().toISOString() }], exposure: { mode: "local" } };
    await writeApiState(system, path, state);
  }
  await ensureProxy(options, statePath, state);
  if (state.exposure.mode === "public" && !(await inspectContainer(system, TUNNEL_CONTAINER, API_SPEC_LABEL))?.running) {
    await removeContainer(system, TUNNEL_CONTAINER);
    await system.run("docker", tunnelDockerArgs(state.port));
  }
  return { state, created, target };
}

function keyId(): string {
  return randomBytes(3).toString("hex");
}

/** dl model endpoint / share / keys. */
export async function modelApiCommand(action: string, args: string[], options: ModelApiOptions): Promise<number> {
  const c = palette(options.color === true);
  const say = (text = "") => options.out(text ? `  ${text}\n` : "\n");
  if (options.showKey && action === "share") { say(`${c.red("✗")} --show-key goes with dl model endpoint and dl model keys.`); return 2; }
  if (options.port !== undefined && action !== "endpoint") { say(`${c.red("✗")} --port goes with dl model endpoint (when it's first turned on).`); return 2; }
  if ((options.lan || options.tailscale || options.public) && action !== "share") { say(`${c.red("✗")} --lan, --tailscale and --public go with dl model share.`); return 2; }
  if (action === "endpoint") {
    if (args.length) { say(`Usage: ${ENDPOINT_USAGE}`); return 2; }
    return options.off ? endpointOff(options) : endpoint(options);
  }
  if (action === "share") {
    if (args.length) { say(`Usage: ${SHARE_USAGE}`); return 2; }
    return share(options);
  }
  if (action === "keys") {
    if (options.off) { say(`Usage: ${KEYS_USAGE}`); return 2; }
    return keys(args, options);
  }
  say(`Usage: ${ENDPOINT_USAGE}`);
  return 2;
}

async function endpoint(options: ModelApiOptions): Promise<number> {
  const { state, created, target } = await enableEndpoint(options);
  printEndpoint(options, state, target.model, await endpointBaseUrl(options.system, state), created ? "Your GPU is now an OpenAI-compatible API" : "Your GPU's OpenAI-compatible API");
  return 0;
}

async function endpointOff(options: ModelApiOptions): Promise<number> {
  const { system } = options;
  const statePath = options.statePath ?? modelStatePath();
  const path = apiStatePath(statePath);
  const state = await readApiState(system, path);
  const c = palette(options.color === true);
  if (state) await teardown(system, state);
  await removeContainer(system, API_CONTAINER);
  if (state && state.exposure.mode !== "local") await writeApiState(system, path, { ...state, exposure: { mode: "local" } });
  options.out(`  ${c.green("✓")} API endpoint off${state ? `; its keys are kept (dl model endpoint turns it on again, ${state.keys.length === 1 ? "same key" : "same keys"})` : " (it wasn't on)"}\n`);
  return 0;
}

async function share(options: ModelApiOptions): Promise<number> {
  const { system } = options;
  const c = palette(options.color === true);
  const say = (text = "") => options.out(text ? `  ${text}\n` : "\n");
  const wanted = [options.lan && "lan", options.tailscale && "tailscale", options.public && "public", options.off && "local"].filter(Boolean) as ShareMode[];
  if (wanted.length !== 1) { say(`Usage: ${SHARE_USAGE}`); return 2; }
  const mode = wanted[0]!;
  const statePath = options.statePath ?? modelStatePath();
  const path = apiStatePath(statePath);
  if (mode === "local" && !(await readApiState(system, path))) { say(`${c.green("✓")} The API endpoint isn't on, so nothing is shared.`); return 0; }
  const { state, target } = await enableEndpoint(options);
  let next: Exposure;
  if (mode === "tailscale") {
    const tailscale = await tailscaleState(system);
    if (tailscale.state !== "ready") {
      say(`${c.red("✗")} ${tailscale.state === "missing" ? "Tailscale isn't installed here." : tailscale.state === "logged-out" ? "Tailscale isn't signed in here." : "HTTPS certificates are off for your tailnet."}`);
      say(`${c.dim("Next:")} ${tailscale.state === "missing" ? "install Tailscale (https://tailscale.com/download/linux) and sudo tailscale up" : tailscale.state === "logged-out" ? "sudo tailscale up (it prints a sign-in link)" : `turn on MagicDNS and HTTPS certificates at ${HTTPS_CERTS_URL}`}, then dl model share --tailscale`);
      return 1;
    }
    const local = localUrl(state);
    const httpsPort = await tailnetPort(system, local, state.exposure.mode === "tailscale" ? state.exposure.httpsPort : undefined, TAILNET_API_PORTS, "the API", "dl model share --tailscale");
    if (state.exposure.mode !== "tailscale" || state.exposure.httpsPort !== httpsPort) await teardown(system, state);
    const served = await serveHttps(system, httpsPort, local);
    if (served.code !== 0) {
      say(`${c.red("✗")} Tailscale couldn't serve HTTPS: ${served.stderr.trim() || served.stdout.trim()}`);
      say(`${c.dim("Next:")} turn on MagicDNS and HTTPS certificates at ${HTTPS_CERTS_URL}, then dl model share --tailscale`);
      return 1;
    }
    next = { mode: "tailscale", httpsPort, url: tailnetUrl(tailscale.name, httpsPort) };
  } else {
    if (state.exposure.mode !== mode) await teardown(system, state);
    next = mode === "lan" ? { mode: "lan" } : mode === "public" ? { mode: "public" } : { mode: "local" };
  }
  const updated: ApiState = { ...state, exposure: next };
  await writeApiState(system, path, updated);
  // lan binds 0.0.0.0; every other mode 127.0.0.1 (a changed bind restarts only the proxy).
  await ensureProxy(options, statePath, updated);
  let url = await endpointBaseUrl(system, updated);
  if (mode === "public") {
    // Already public: enableEndpoint kept the tunnel (and its URL) running.
    if (state.exposure.mode !== "public") await system.run("docker", tunnelDockerArgs(updated.port));
    const delay = sleeper(options);
    for (let attempt = 0; !url && attempt < 30 && !system.dryRun; attempt++) {
      await delay(1_000);
      url = await endpointBaseUrl(system, updated);
    }
    if (!url && !system.dryRun) {
      say(`${c.red("✗")} The Cloudflare quick tunnel didn't give a URL in 30 seconds; see docker logs ${TUNNEL_CONTAINER}.`);
      say(c.dim("dl model share --off takes it down; dl model endpoint shows the URL once it's there."));
      return 1;
    }
  }
  printEndpoint(options, updated, target.model, url, mode === "local" ? "The API is back to this machine only" : "The API is shared");
  return 0;
}

async function keys(args: string[], options: ModelApiOptions): Promise<number> {
  const { system } = options;
  const c = palette(options.color === true);
  const say = (text = "") => options.out(text ? `  ${text}\n` : "\n");
  const statePath = options.statePath ?? modelStatePath();
  const path = apiStatePath(statePath);
  const [sub, value, ...extra] = args;
  if (sub === undefined || sub === "list" || sub === "ls") {
    if (value !== undefined) { say(`Usage: ${KEYS_USAGE}`); return 2; }
    const state = await readApiState(system, path);
    if (!state) { say("No API endpoint yet: dl model endpoint turns it on and makes the first key."); return 0; }
    if (!state.keys.length) say("No keys: nobody can use the endpoint. dl model keys add NAME makes one.");
    for (const key of state.keys) say(`${key.id}  ${key.name.padEnd(16)} ${options.showKey ? key.key : maskKey(key.key)}  ${c.dim(`made ${key.created.slice(0, 10)}`)}`);
    if (state.keys.length && !options.showKey) say(c.dim("Full keys: dl model keys --show-key · revoke one: dl model keys revoke ID"));
    return 0;
  }
  if (sub === "add") {
    if (extra.length) { say(`Usage: ${KEYS_USAGE}`); return 2; }
    const name = (value ?? "").trim() || "key";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(name)) { say(`${c.red("✗")} A key's name is letters, digits, dots, dashes and underscores (at most 32).`); return 2; }
    const { state } = await enableEndpoint(options);
    if (state.keys.some((key) => key.name === name)) { say(`${c.red("✗")} There's already a key named ${name} (dl model keys).`); return 1; }
    const key: ApiKey = { id: keyId(), name, key: newKey(), created: (options.now ?? (() => new Date()))().toISOString() };
    const updated = { ...state, keys: [...state.keys, key] };
    await writeApiState(system, path, updated);
    await writeProxyFiles(system, statePath, updated);
    say(`${c.green("✓")} New key ${c.bold(name)} (${key.id}), working now:`);
    say(key.key);
    say(c.dim("Shown in full only here and with --show-key. Revoke it: dl model keys revoke " + key.id));
    return 0;
  }
  if (sub === "revoke" || sub === "rm") {
    if (!value || extra.length) { say(`Usage: ${KEYS_USAGE}`); return 2; }
    const state = await readApiState(system, path);
    const found = state?.keys.find((key) => key.id === value || key.name === value);
    if (!state || !found) { say(`${c.red("✗")} No key ${value} (dl model keys).`); return 1; }
    const updated = { ...state, keys: state.keys.filter((key) => key !== found) };
    await writeApiState(system, path, updated);
    // The proxy reads the hashes on every request: the key stops working now.
    await writeProxyFiles(system, statePath, updated);
    say(`${c.green("✓")} Revoked ${found.name} (${found.id}); requests with it are refused from now on.`);
    if (!updated.keys.length) say(c.yellow("No keys left: nobody can use the endpoint. dl model keys add NAME makes one."));
    return 0;
  }
  say(`Usage: ${KEYS_USAGE}`);
  return 2;
}

/** The env var the snippets read the key from. */
export const KEY_ENV = "DL_MODEL_KEY";

/**
 * Copy-paste setup for the tools, against `baseUrl` (…/v1). The key is read from $DL_MODEL_KEY
 * (exported first), so the snippets are the same whether the key is shown or masked.
 */
export function endpointSnippets(baseUrl: string, model: LocalModel): Array<{ title: string; lines: string[] }> {
  const root = baseUrl.replace(/\/v1\/?$/, "");
  const opencode = {
    $schema: "https://opencode.ai/config.json",
    model: `${LOCAL_PROVIDER}/${model.model}`,
    provider: { [LOCAL_PROVIDER]: { npm: "@ai-sdk/openai-compatible", name: "My GPU (dl)", options: { baseURL: baseUrl, apiKey: `{env:${KEY_ENV}}` },
      models: { [model.model]: { name: model.model, tool_call: true, limit: { context: model.context, output: outputLimit(model.context) } } } } },
  };
  const snippets = [
    { title: "Any OpenAI-compatible tool", lines: [`export OPENAI_BASE_URL=${baseUrl}`, `export OPENAI_API_KEY=$${KEY_ENV}`] },
    { title: "Autopilot", lines: [`AUTOPILOT_BASE_URL=${baseUrl} AUTOPILOT_API_KEY=$${KEY_ENV} autopilot -m ${model.model}`] },
    { title: "OpenCode (opencode.json)", lines: JSON.stringify(opencode, null, 2).split("\n") },
    { title: "Cursor", lines: [`Settings > Models: OpenAI API Key = your key, Override OpenAI Base URL = ${baseUrl}, add model ${model.model}`,
      ...(baseUrl.includes(".trycloudflare.com") ? [] : ["(Cursor calls the URL from its own servers: it needs a public URL, dl model share --public.)"])] },
  ];
  // Claude Code only where dl already runs it on this model: the engine's own Messages API (/v1/messages).
  if (agentSupport("claude-code", model).ok) {
    snippets.push({ title: "Claude Code", lines: [`ANTHROPIC_BASE_URL=${root} ANTHROPIC_AUTH_TOKEN=$${KEY_ENV} \\`, `  ANTHROPIC_MODEL=${model.model} ANTHROPIC_DEFAULT_HAIKU_MODEL=${model.model} \\`,
      `  CLAUDE_CODE_MAX_CONTEXT_TOKENS=${model.context} claude`] });
  }
  return snippets;
}

/** The endpoint screen: base URL, model, key, who can reach it, then the snippets. */
export function printEndpoint(options: Pick<ModelApiOptions, "out" | "color" | "showKey">, state: ApiState, model: LocalModel, baseUrl: string | undefined, headline: string): void {
  const c = palette(options.color === true);
  const say = (text = "") => options.out(text ? `  ${text}\n` : "\n");
  const key = state.keys[0];
  say();
  say(`${c.green("✓")} ${c.bold(headline)}`);
  say();
  say(`Base URL   ${baseUrl ?? c.yellow("not known yet · dl model endpoint again in a moment")}`);
  say(`Model      ${model.model}`);
  say(`API key    ${key ? `${options.showKey ? key.key : `${maskKey(key.key)}  ${c.dim("(full key: dl model endpoint --show-key)")}`}${state.keys.length > 1 ? c.dim(`  · ${state.keys.length} keys: dl model keys`) : ""}` : c.yellow("none · dl model keys add NAME")}`);
  say(`Reach      ${exposureText(state.exposure)}${state.exposure.mode === "local" ? c.dim(" · wider: dl model share --lan | --tailscale | --public") : c.dim(" · back to this machine: dl model share --off")}`);
  for (const line of exposureWarning(state.exposure, state.port)) say(c.yellow(line));
  if (!baseUrl) return;
  say();
  say(`First: export ${KEY_ENV}=${key && options.showKey ? key.key : "<your key>"}`);
  for (const snippet of endpointSnippets(baseUrl, model)) {
    say();
    say(c.bold(snippet.title));
    for (const line of snippet.lines) say(`  ${line}`);
  }
  say();
  say(c.dim("On this box, dl itself already opens Autopilot (or dl agent's choice) on the model: dl"));
}

export function exposureWarning(exposure: Exposure, port: number): string[] {
  if (exposure.mode === "lan") return [
    `! Listens on every network interface of this machine, port ${port}; a key is required.`,
    "  If this machine has a public IP, that includes the internet: firewall the port (e.g. ufw).",
  ];
  if (exposure.mode === "public") return [
    "! PUBLIC: anyone on the internet with this URL can reach your GPU; only the key protects it.",
    "  A leaked key: dl model keys revoke ID. Cloudflare quick tunnels are for testing: no uptime",
    "  guarantee, a new URL whenever the tunnel restarts, and no Server-Sent Events, so streamed",
    "  answers may not work (Cloudflare's docs). For daily use: dl model share --tailscale.",
  ];
  return [];
}

/**
 * The GPU first run's API endpoint (Autopilot's "How will your team use it?" > API endpoint):
 * turns it on for this machine only and prints the endpoint screen. Never throws.
 */
export async function firstRunApi(options: ModelApiOptions): Promise<{ ok: true; baseUrl: string } | { ok: false; message: string }> {
  const c = palette(options.color === true);
  try {
    const { state, target } = await enableEndpoint(options);
    const baseUrl = (await endpointBaseUrl(options.system, state))!;
    printEndpoint(options, state, target.model, baseUrl, "Your GPU is now an OpenAI-compatible API");
    return { ok: true, baseUrl };
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0]! : String(error);
    options.out(`\n  ${c.red("✗")} ${message}\n  ${c.dim("Next:")} dl model endpoint tries again; the model keeps running (dl model status).\n`);
    return { ok: false, message };
  }
}

/** dl model status's line: off, or the base URL, who can reach it and how many keys. */
export async function endpointStatus(system: System, statePath: string): Promise<{ ok: boolean; text: string }> {
  const state = await readApiState(system, apiStatePath(statePath)).catch(() => undefined);
  if (!state) return { ok: true, text: "off · dl model endpoint" };
  const running = (await inspectContainer(system, API_CONTAINER, API_SPEC_LABEL))?.running === true;
  if (!running) return { ok: false, text: `stopped · dl model endpoint starts it (${exposureText(state.exposure)})` };
  const url = await endpointBaseUrl(system, state);
  return { ok: true, text: `${url ?? "URL not known yet"} · ${exposureText(state.exposure)} · ${state.keys.length} key${state.keys.length === 1 ? "" : "s"}` };
}
