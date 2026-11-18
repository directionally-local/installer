import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { dirname, join } from "node:path";
import { DUMMY_API_KEY } from "./model-evals.js";
import { inspectContainer, removeContainer } from "./model-runtime.js";
import { localFetch, modelApiBase, type FetchModel } from "./model-smoke.js";
import type { Prompter } from "./prompt.js";
import { modelStatePath, readDeployments } from "./state.js";
import type { System } from "./system.js";
import { serveHttps, serveStatus, stopServing, tailnetName, tailnetUrl, tailscaleIsUp } from "./tailscale.js";
import type { Ui } from "./ui.js";

/**
 * `dl ui`: Open WebUI as the team's chat, next to the model, in one Docker container.
 *
 * - Localhost by default; `--listen` binds the LAN too (with a warning).
 * - `dl ui share`: one private link. Tailscale (`tailscale serve`, HTTPS on the tailnet name,
 *   never `tailscale funnel`), or without it the LAN address when listening there.
 * - Who gets in: sign-ups wait for an admin's approval (`dl ui approve`), or the admin invites
 *   emails (`dl ui invite`), which creates their accounts with a one-time password.
 *
 * dl owns Open WebUI's settings: they come from the container's environment on every start
 * (ENABLE_PERSISTENT_CONFIG=false), so web search, image generation, the model endpoints and
 * pending approval are what dl set, whatever was saved before. Accounts and chats persist in the
 * dl-ui-data volume.
 */

/** Open WebUI v0.12.5 (29 Oct 2026), by tag and the digest of its multi-arch index (amd64, arm64). */
export const OPEN_WEBUI_VERSION = "0.12.5";
export const OPEN_WEBUI_IMAGE = `ghcr.io/open-webui/open-webui:v${OPEN_WEBUI_VERSION}@sha256:03443b8de6b617da9d900edd09b4bf1cb0ddbfdcba6afb42c548336a0b821ded`;
export const UI_CONTAINER = "dl-ui";
export const UI_VOLUME = "dl-ui-data";
/** Clear of dl model's ports (8000 up), previews (8090–8099) and the server's own (4096, 4750–4760). */
export const UI_PORT = 4800;
export const UI_SPEC_LABEL = "dl.ui.spec";
const DATA_DIR = "/app/backend/data";
/** HTTPS ports tried on the tailnet name, in order; 443 is the server's agent API under `dl up`. */
const TAILNET_PORTS = [443, 8443, 10000];
const LOOPBACK = "127.0.0.1";

export type UiShare = { mode: "tailscale"; url: string; httpsPort: number } | { mode: "lan"; url: string };

/** ~/.local/state/directionallylocal/ui.json, 0600: it holds the admin's password. */
export interface UiState {
  version: 1;
  port: number;
  /** The address Open WebUI binds: 127.0.0.1, 0.0.0.0 or one of this machine's. */
  listen: string;
  adminEmail: string;
  adminPassword: string;
  /** The admin account exists in Open WebUI (made by dl on the first start). */
  adminCreated: boolean;
  share?: UiShare;
}

export interface ChatUiOptions {
  system: System;
  ui: Ui;
  prompter: Prompter;
  interactive: boolean;
  /** dl model's state file; ui.json sits beside it. */
  statePath?: string;
  fetch?: FetchModel;
  delay?: (ms: number) => Promise<void>;
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  port?: string;
  /** --listen [ADDRESS]: "0.0.0.0" when given bare. */
  listen?: string;
  adminEmail?: string;
  /** share --off */
  off?: boolean;
  /** down --purge: also delete the accounts and chats. */
  purge?: boolean;
  follow?: boolean;
}

export const UI_USAGE = "dl ui [up|status|share|invite EMAIL...|approve [EMAIL...|all]|logs|down]";

export function uiStatePath(statePath = modelStatePath()): string {
  return join(dirname(statePath), "ui.json");
}

export async function readUiState(system: System, path: string): Promise<UiState | undefined> {
  const raw = await system.readFile(path);
  if (!raw) return undefined;
  try {
    const state = JSON.parse(raw) as Partial<UiState>;
    if (state.version !== 1 || !Number.isInteger(state.port) || typeof state.listen !== "string" || typeof state.adminEmail !== "string"
      || typeof state.adminPassword !== "string" || typeof state.adminCreated !== "boolean") throw new Error("invalid");
    return state as UiState;
  } catch {
    throw new Error(`Invalid dl ui state at ${path}; fix or remove it (dl ui down --purge starts over).`);
  }
}

async function writeUiState(system: System, path: string, state: UiState): Promise<void> {
  await system.mkdir(dirname(path), { mode: 0o700 });
  await system.writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, secret: true });
}

/** A plain address check: something@domain.tld, no spaces or list separators. */
export function validEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\].]+$/.test(email);
}

/**
 * A random password Open WebUI accepts even with its optional password rule on (a lowercase and
 * an uppercase letter, a digit and a symbol, 8+ characters; at most 72 bytes for bcrypt).
 */
export function generatePassword(): string {
  return `${randomBytes(18).toString("base64url")}-aA1`;
}

function hostFor(address: string): string {
  return isIP(address) === 6 ? `[${address}]` : address;
}

/** Bound on every address or only on this machine's loopback. */
const wildcard = (listen: string) => listen === "0.0.0.0" || listen === "::";
const loopback = (listen: string) => listen === LOOPBACK || listen === "::1" || listen.startsWith("127.");

/** Where dl itself reaches Open WebUI (and where `tailscale serve` points). */
export function localUrl(state: Pick<UiState, "listen" | "port">): string {
  return `http://${wildcard(state.listen) ? LOOPBACK : hostFor(state.listen)}:${state.port}`;
}

/** The link Open WebUI calls itself (WEBUI_URL): the shared one, else the local one. */
export function publicUrl(state: Pick<UiState, "listen" | "port" | "share">): string {
  return state.share?.url ?? localUrl(state);
}

/** This machine's LAN address: the one --listen named, else the first non-virtual IPv4. */
export function lanAddress(listen: string, interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string | undefined {
  if (!wildcard(listen) && !loopback(listen)) return listen;
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (/^(lo|docker|br-|veth|tailscale|ts\d|virbr|cni|flannel|cali|zt|wg|utun)/.test(name)) continue;
    const ipv4 = addresses?.find((address) => address.family === "IPv4" && !address.internal && !address.address.startsWith("169.254."));
    if (ipv4) return ipv4.address;
  }
  return undefined;
}

/** The model endpoints Open WebUI talks to: each dl model deployment's API, by name. */
export async function modelEndpoints(system: System, statePath: string): Promise<string[]> {
  const deployments = await readDeployments(system, statePath);
  return Object.keys(deployments).sort().map((name) => modelApiBase(deployments[name]!.active));
}

/**
 * Open WebUI's environment. Everything that reaches outside this machine is off where Open WebUI
 * has a switch for it; the only outbound connections left are the ones a user starts (a URL
 * pasted into a chat is fetched).
 */
export function uiEnv(state: Pick<UiState, "listen" | "port" | "share">, endpoints: readonly string[]): Record<string, string> {
  return {
    // --network host: Open WebUI binds this address and port itself, and reaches the models on 127.0.0.1.
    HOST: state.listen,
    PORT: String(state.port),
    WEBUI_URL: publicUrl(state),
    // The session-signing key is generated once into the volume, never passed in the environment.
    WEBUI_SECRET_KEY_FILE: `${DATA_DIR}/.webui_secret_key`,
    // dl's settings win on every start (see the header).
    ENABLE_PERSISTENT_CONFIG: "false",
    // Who gets in: anyone may ask, an admin approves each person.
    ENABLE_SIGNUP: "true",
    DEFAULT_USER_ROLE: "pending",
    // The models: dl's deployments only. No Ollama, no OpenAI default, no endpoints users add in the browser.
    ENABLE_OLLAMA_API: "false",
    ENABLE_OPENAI_API: endpoints.length ? "true" : "false",
    ...(endpoints.length ? { OPENAI_API_BASE_URLS: endpoints.join(";"), OPENAI_API_KEYS: endpoints.map(() => DUMMY_API_KEY).join(";") } : {}),
    ENABLE_DIRECT_CONNECTIONS: "false",
    // Nothing phones home: no Hugging Face downloads (the image ships its embedding models), no version check, no analytics.
    OFFLINE_MODE: "true",
    HF_HUB_OFFLINE: "1",
    ENABLE_VERSION_UPDATE_CHECK: "false",
    SCARF_NO_ANALYTICS: "true",
    DO_NOT_TRACK: "true",
    ANONYMIZED_TELEMETRY: "false",
    ENABLE_COMMUNITY_SHARING: "false",
    // Off by default: web search and image generation (both send prompts to outside services).
    ENABLE_WEB_SEARCH: "false",
    ENABLE_IMAGE_GENERATION: "false",
    ENABLE_IMAGE_EDIT: "false",
    USER_PERMISSIONS_FEATURES_WEB_SEARCH: "false",
    USER_PERMISSIONS_FEATURES_IMAGE_GENERATION: "false",
  };
}

/** `docker run` for Open WebUI, labeled with a hash of everything else so a re-run knows whether it can keep the container. */
export function uiDockerArgs(state: Pick<UiState, "listen" | "port" | "share">, endpoints: readonly string[]): string[] {
  const env = uiEnv(state, endpoints);
  const container = ["--name", UI_CONTAINER, "--restart", "unless-stopped", "--network", "host", "-v", `${UI_VOLUME}:${DATA_DIR}`,
    ...Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`])];
  const spec = createHash("sha256").update(JSON.stringify([...container, OPEN_WEBUI_IMAGE])).digest("hex").slice(0, 16);
  return ["run", "-d", ...container, "--label", `${UI_SPEC_LABEL}=${spec}`, OPEN_WEBUI_IMAGE];
}

function specOf(args: readonly string[]): string {
  return args[args.indexOf("--label") + 1]!.slice(UI_SPEC_LABEL.length + 1);
}

function parsePort(text: string): number {
  const port = Number(text);
  if (!/^\d+$/.test(text) || port < 1 || port > 65535) throw new Error("Port must be an integer between 1 and 65535.");
  return port;
}

function parseListen(text: string): string {
  const address = text.trim().replace(/^\[|\]$/g, "");
  if (address === "localhost") return LOOPBACK;
  if (!isIP(address)) throw new Error(`--listen takes an IP address of this machine (0.0.0.0 for every one; got "${text}").`);
  return address;
}

/** Open WebUI's HTTP API, as its admin. */
class OpenWebUi {
  constructor(private readonly base: string, private readonly call: FetchModel) {}

  async request<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
    let response: Response;
    try {
      response = await this.call(`${this.base}${path}`, {
        method,
        headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new Error(`Open WebUI isn't answering at ${this.base} (${error instanceof Error ? error.message : String(error)}); dl ui status, dl ui logs.`);
    }
    const text = await response.text();
    if (!response.ok) {
      let detail = text.trim().slice(0, 200);
      try { detail = String((JSON.parse(text) as { detail?: unknown }).detail ?? detail); } catch { /* not JSON */ }
      throw new OpenWebUiError(path, response.status, detail);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async healthy(): Promise<boolean> {
    try {
      const response = await this.call(`${this.base}/health`, { signal: AbortSignal.timeout(5_000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** The admin's session token. */
  async signIn(state: UiState): Promise<string> {
    const result = await this.request<{ token?: string; role?: string }>("POST", "/api/v1/auths/signin", { email: state.adminEmail, password: state.adminPassword });
    if (!result?.token) throw new Error(`Open WebUI didn't give ${state.adminEmail} a session (two-factor sign-in on? dl can't use it). Use the Admin Panel instead.`);
    if (result.role !== "admin") throw new Error(`${state.adminEmail} isn't an admin in Open WebUI any more.`);
    return result.token;
  }

  async users(token: string): Promise<OpenWebUiUser[]> {
    const result = await this.request<{ users?: OpenWebUiUser[] } | OpenWebUiUser[]>("GET", "/api/v1/users/all", undefined, token);
    return Array.isArray(result) ? result : result?.users ?? [];
  }
}

interface OpenWebUiUser { id: string; email: string; name: string; role: string; created_at?: number }

export class OpenWebUiError extends Error {
  constructor(readonly path: string, readonly status: number, readonly detail: string) {
    super(`Open WebUI refused ${path}: HTTP ${status}${detail ? ` (${detail})` : ""}`);
    this.name = "OpenWebUiError";
  }
}

export async function chatUiCommand(action: string | undefined, args: string[], options: ChatUiOptions): Promise<number> {
  const { ui } = options;
  const path = uiStatePath(options.statePath);
  const verb = action ?? "up";
  if (verb !== "invite" && verb !== "approve" && args.length) { ui.line("failed", "Usage", UI_USAGE); return 2; }
  if (options.off && verb !== "share") throw new Error("--off goes with dl ui share.");
  if (options.purge && verb !== "down") throw new Error("--purge goes with dl ui down.");
  if (options.adminEmail !== undefined && verb !== "up") throw new Error("--admin-email goes with dl ui up.");
  if ((options.listen !== undefined || options.port !== undefined) && verb !== "up") throw new Error("--listen and --port go with dl ui up.");
  switch (verb) {
    case "up": return up(options, path);
    case "status": return status(options, path);
    case "share": return share(options, path);
    case "invite": return invite(options, path, args);
    case "approve": return approve(options, path, args);
    case "logs": return logs(options, path);
    case "down": return down(options, path);
    default: ui.line("failed", "Usage", UI_USAGE); return 2;
  }
}

async function requireState(options: ChatUiOptions, path: string): Promise<UiState> {
  const state = await readUiState(options.system, path);
  if (!state) throw new Error("Team chat isn't set up here yet: dl ui up");
  return state;
}

function api(options: ChatUiOptions, state: UiState): OpenWebUi {
  return new OpenWebUi(localUrl(state), options.fetch ?? localFetch);
}

async function waitHealthy(options: ChatUiOptions, state: UiState): Promise<void> {
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const client = api(options, state);
  // The first start migrates its database; give it five minutes.
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await client.healthy()) return;
    if (attempt > 2 && !(await inspectContainer(options.system, UI_CONTAINER, UI_SPEC_LABEL))?.running) break;
    await delay(2_000);
  }
  throw new Error(`Open WebUI didn't come up on ${localUrl(state)}; see docker logs ${UI_CONTAINER}`);
}

/**
 * Starts (or keeps) the container for `state`; returns whether it changed. The same settings
 * keep the running container; anything else replaces it (the volume keeps accounts and chats).
 */
async function ensureContainer(options: ChatUiOptions, state: UiState, statePath: string): Promise<"kept" | "started" | "replaced"> {
  const { system, ui } = options;
  const endpoints = await modelEndpoints(system, statePath);
  const runArgs = uiDockerArgs(state, endpoints);
  const existing = await inspectContainer(system, UI_CONTAINER, UI_SPEC_LABEL);
  if (existing?.running && existing.spec === specOf(runArgs)) return "kept";
  if ((await system.probe("docker", ["image", "inspect", OPEN_WEBUI_IMAGE])).code !== 0) {
    ui.line("info", "Downloading", `Open WebUI ${OPEN_WEBUI_VERSION}, about 4 GB the first time`);
    await system.run("docker", ["pull", OPEN_WEBUI_IMAGE]);
  }
  if (existing) await removeContainer(system, UI_CONTAINER);
  ui.line("info", existing ? "Restarting" : "Starting", `Open WebUI on ${hostFor(state.listen)}:${state.port} (the first start takes a minute)`);
  await system.run("docker", runArgs);
  if (!system.dryRun) await waitHealthy(options, state);
  ui.line("done", "Open WebUI", endpoints.length ? `up · ${endpoints.length === 1 ? "1 model endpoint" : `${endpoints.length} model endpoints`}` : "up · no model yet");
  return existing ? "replaced" : "started";
}

async function askAdminEmail(options: ChatUiOptions): Promise<string> {
  let email = options.adminEmail?.trim().toLowerCase();
  if (!email) {
    if (!options.interactive) throw new Error("Name the admin's email: dl ui up --admin-email you@company.com");
    email = (await options.prompter.text(options.ui.prompt("Admin email", "your sign-in to the team chat"))).trim().toLowerCase();
  }
  if (!validEmail(email)) throw new Error(`"${email}" isn't an email address.`);
  return email;
}

async function up(options: ChatUiOptions, path: string): Promise<number> {
  const { system, ui } = options;
  const statePath = options.statePath ?? modelStatePath();
  const previous = await readUiState(system, path);
  const listen = options.listen !== undefined ? parseListen(options.listen) : previous?.listen ?? LOOPBACK;
  const port = options.port !== undefined ? parsePort(options.port) : previous?.port ?? UI_PORT;
  const deployments = await readDeployments(system, statePath);
  const clash = Object.entries(deployments).find(([, entry]) => entry.active.port === port || entry.previous?.port === port || entry.active.port + 1 === port);
  if (clash) throw new Error(`Port ${port} belongs to model deployment ${clash[0]}; pick another with --port.`);
  if ((await system.probe("docker", ["info", "--format", "{{.ServerVersion}}"])).code !== 0) throw new Error("Docker is missing or its daemon is stopped; dl ui runs Open WebUI in Docker.");
  if (previous?.adminCreated && options.adminEmail !== undefined && options.adminEmail.trim().toLowerCase() !== previous.adminEmail) {
    throw new Error(`The admin is already ${previous.adminEmail}; add more admins in Open WebUI's Admin Panel.`);
  }
  const adminEmail = previous?.adminCreated ? previous.adminEmail : await askAdminEmail(options);
  // A share link is for one address and port: a change drops it (dl ui share makes a new one).
  const moved = previous && (previous.port !== port || previous.listen !== listen);
  const state: UiState = {
    version: 1, port, listen, adminEmail,
    // Saved before Open WebUI starts, so a failed first start retries with the same password.
    adminPassword: previous?.adminPassword ?? generatePassword(),
    adminCreated: previous?.adminCreated ?? false,
    ...(previous?.share && !(moved && previous.share.mode === "lan") ? { share: previous.share } : {}),
  };
  if (moved && previous?.share?.mode === "tailscale") {
    await stopServing(system, previous.share.httpsPort, localUrl(previous));
    delete state.share;
  }
  await writeUiState(system, path, state);
  const result = await ensureContainer(options, state, statePath);
  if (system.dryRun) { ui.line("info", "Dry run", "nothing started"); return 0; }
  let created = false;
  if (!state.adminCreated) {
    await createAdmin(options, state);
    state.adminCreated = true;
    await writeUiState(system, path, state);
    // Open WebUI turns sign-ups off after its first account; a restart brings back dl's settings.
    await system.run("docker", ["restart", UI_CONTAINER]);
    await waitHealthy(options, state);
    ui.line("done", "Admin", adminEmail);
    created = true;
  }
  if (!wildcard(listen) && loopback(listen)) {
    ui.line("info", "Listening", `this machine only (${hostFor(listen)}:${port})`);
  } else {
    ui.warn(`Open WebUI is reachable on the network: ${hostFor(listen)}:${port}. Anyone who reaches it sees the sign-in page; sign-ups wait for your approval.`);
  }
  if (!(await modelEndpoints(system, statePath)).length) ui.warn("No dl model is running here, so the chat has no models yet: dl model up, then dl ui up again.");
  const items = [{ label: "Open", value: publicUrl(state) }];
  if (created) items.push({ label: "Admin", value: `${adminEmail} · password ${state.adminPassword}` });
  ui.ready(result === "kept" && !created ? "Team chat is running" : "Team chat is ready", items, {
    about: [
      ...(created ? [`The password is shown once and kept in ${path} (readable by this user only). Change it after you sign in: Settings > Account; then dl ui invite and dl ui approve need the new one in that file.`] : []),
      "New sign-ups wait for approval: dl ui approve. Or add people: dl ui invite a@x.com b@x.com",
    ],
    footer: state.share ? `Shared: ${state.share.url}` : "Only this machine can open it. dl ui share prints one private link for your team.",
  });
  return 0;
}

/** The first account becomes Open WebUI's admin; dl makes it at once, before anyone else can reach the sign-up page. */
async function createAdmin(options: ChatUiOptions, state: UiState): Promise<void> {
  const client = api(options, state);
  const config = await client.request<{ onboarding?: boolean }>("GET", "/api/config");
  if (config?.onboarding !== true) {
    throw new Error(`Open WebUI's data (Docker volume ${UI_VOLUME}) already has accounts, and dl doesn't know its admin's password.\n`
      + `Sign in with that admin, or start over: dl ui down --purge (deletes its accounts and chats), then dl ui up.`);
  }
  const created = await client.request<{ token?: string; role?: string }>("POST", "/api/v1/auths/signup", { name: "Admin", email: state.adminEmail, password: state.adminPassword });
  if (created?.role !== "admin") throw new Error(`Open WebUI made ${state.adminEmail} a ${created?.role ?? "pending"} user, not the admin; dl ui down --purge and try again.`);
}

async function status(options: ChatUiOptions, path: string): Promise<number> {
  const { system, ui } = options;
  const state = await readUiState(system, path);
  if (!state) { ui.line("info", "Team chat", "not set up · dl ui up"); return 0; }
  const statePath = options.statePath ?? modelStatePath();
  const container = await inspectContainer(system, UI_CONTAINER, UI_SPEC_LABEL);
  const endpoints = await modelEndpoints(system, statePath);
  const current = container?.spec === specOf(uiDockerArgs(state, endpoints));
  ui.line(container?.running ? "done" : "failed", "Team chat", container?.running ? `running · Open WebUI ${OPEN_WEBUI_VERSION}` : container ? "stopped · dl ui up" : "not running · dl ui up");
  if (container && !current) ui.line("info", "Settings", "changed since it started (models, share or address) · dl ui up applies them");
  ui.line("info", "Local", localUrl(state));
  ui.line("info", "Shared", state.share ? `${state.share.url} (${state.share.mode === "tailscale" ? "tailnet only" : "LAN"})` : "no · dl ui share");
  ui.line("info", "Listening", loopback(state.listen) ? "this machine only" : `${hostFor(state.listen)} (reachable on the network)`);
  ui.line("info", "Admin", state.adminEmail);
  ui.line("info", "Models", endpoints.length ? endpoints.join(", ") : "none · dl model up");
  if (container?.running) {
    try {
      const client = api(options, state);
      const pending = (await client.users(await client.signIn(state))).filter((user) => user.role === "pending");
      ui.line("info", "Waiting for approval", pending.length ? `${pending.map((user) => user.email).join(", ")} · dl ui approve` : "nobody");
    } catch (error) {
      ui.line("info", "Waiting for approval", `couldn't check (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
    }
  }
  return 0;
}

async function requireRunning(options: ChatUiOptions, state: UiState): Promise<void> {
  const container = await inspectContainer(options.system, UI_CONTAINER, UI_SPEC_LABEL);
  if (!container?.running) throw new Error("The team chat isn't running: dl ui up");
}

/** Picks the tailnet HTTPS port: the one already serving Open WebUI, else the first free one; never one Funnel makes public. */
async function tailnetPort(options: ChatUiOptions, target: string, previous: number | undefined): Promise<number> {
  const served = await serveStatus(options.system);
  const candidates = previous ? [previous, ...TAILNET_PORTS.filter((port) => port !== previous)] : TAILNET_PORTS;
  const port = candidates.find((candidate) => { const entry = served.get(candidate); return !entry || entry.proxy === target; });
  if (port === undefined) throw new Error(`Tailscale already serves other things on HTTPS ports ${TAILNET_PORTS.join(", ")}; free one (tailscale serve status) and run dl ui share again.`);
  if (served.get(port)?.funnel) {
    throw new Error(`Tailscale Funnel is on for HTTPS port ${port}, which would make the chat public. dl only shares on the tailnet; turn Funnel off for that port first.`);
  }
  return port;
}

async function share(options: ChatUiOptions, path: string): Promise<number> {
  const { system, ui } = options;
  const statePath = options.statePath ?? modelStatePath();
  const state = await requireState(options, path);
  const target = localUrl(state);
  if (options.off) {
    if (state.share?.mode === "tailscale") await stopServing(system, state.share.httpsPort, target);
    const was = state.share;
    delete state.share;
    await writeUiState(system, path, state);
    if (await inspectContainer(system, UI_CONTAINER, UI_SPEC_LABEL)) await ensureContainer(options, state, statePath);
    ui.line("done", "Shared", was ? `no longer (${was.url})` : "it wasn't");
    if (!loopback(state.listen)) ui.line("info", "Listening", `still on ${hostFor(state.listen)}:${state.port}; dl ui up --listen 127.0.0.1 makes it this machine only`);
    return 0;
  }
  await requireRunning(options, state);
  let next: UiShare | undefined;
  if (await tailscaleIsUp(system)) {
    const httpsPort = await tailnetPort(options, target, state.share?.mode === "tailscale" ? state.share.httpsPort : undefined);
    const served = await serveHttps(system, httpsPort, target);
    if (served.code !== 0) {
      throw new Error(`Tailscale couldn't serve HTTPS: ${served.stderr.trim() || served.stdout.trim()}\n`
        + "  Turn on MagicDNS and HTTPS certificates at https://login.tailscale.com/admin/dns, then run dl ui share again.");
    }
    const name = await tailnetName(system);
    if (!name) throw new Error("Tailscale is up but reported no DNS name for this machine; is MagicDNS on?");
    next = { mode: "tailscale", url: tailnetUrl(name, httpsPort), httpsPort };
  } else {
    const installed = (await system.probe("tailscale", ["version"])).code === 0;
    ui.line("info", "Tailscale", installed ? "not logged in here, so no private HTTPS link" : "not installed here, so no private HTTPS link");
    const address = loopback(state.listen) ? undefined : lanAddress(state.listen, options.interfaces?.());
    if (!address) {
      ui.line("info", "Next", "dl ui up --listen (reachable on your network), then dl ui share; or install Tailscale and run tailscale up");
      return 1;
    }
    next = { mode: "lan", url: `http://${hostFor(address)}:${state.port}` };
  }
  state.share = next;
  await writeUiState(system, path, state);
  // Open WebUI's own links (WEBUI_URL) follow the shared address.
  await ensureContainer(options, state, statePath);
  ui.ready("Share this link with your team", [{ label: "Team chat", value: next.url }], {
    about: [next.mode === "tailscale"
      ? "Private to your tailnet (tailscale serve, HTTPS); it isn't on the internet."
      : "Plain HTTP on your network: anyone on it can reach the sign-in page."],
    footer: "Sign-ups wait for your approval (dl ui approve), or add people: dl ui invite a@x.com",
  });
  return 0;
}

async function invite(options: ChatUiOptions, path: string, emails: string[]): Promise<number> {
  const { ui } = options;
  if (!emails.length) { ui.line("failed", "Usage", "dl ui invite a@x.com b@x.com"); return 2; }
  const wanted = [...new Set(emails.map((email) => email.trim().replace(/,$/, "").toLowerCase()).filter(Boolean))];
  const bad = wanted.filter((email) => !validEmail(email));
  if (bad.length) throw new Error(`Not email addresses: ${bad.join(", ")}. Nobody was invited.`);
  const state = await requireState(options, path);
  await requireRunning(options, state);
  const client = api(options, state);
  const token = await client.signIn(state);
  const existing = new Map((await client.users(token)).map((user) => [user.email.toLowerCase(), user]));
  const link = publicUrl(state);
  const items: Array<{ label: string; value: string }> = [];
  for (const email of wanted) {
    const user = existing.get(email);
    if (user?.role === "pending") {
      await client.request("POST", `/api/v1/users/${encodeURIComponent(user.id)}/update`, { role: "user" }, token);
      ui.line("done", email, "approved (they had already signed up)");
      items.push({ label: email, value: `${link} · sign in with the password they chose` });
    } else if (user) {
      ui.line("info", email, `already has an account (${user.role})`);
    } else {
      const password = generatePassword();
      await client.request("POST", "/api/v1/auths/add", { name: email.split("@")[0], email, password, role: "user" }, token);
      ui.line("done", email, "account created");
      items.push({ label: email, value: `${link} · sign in as ${email} · password ${password} · then change it: Settings > Account` });
    }
  }
  if (!items.length) return 0;
  ui.ready("Send each person their line (dl sends no email)", items, {
    about: ["The passwords are shown only now; dl doesn't keep them. A lost one: Admin Panel > Users > edit."],
    ...(state.share ? {} : { footer: "This link works only on this machine until you run dl ui share." }),
  });
  return 0;
}

async function approve(options: ChatUiOptions, path: string, args: string[]): Promise<number> {
  const { ui } = options;
  const state = await requireState(options, path);
  await requireRunning(options, state);
  const client = api(options, state);
  const token = await client.signIn(state);
  const pending = (await client.users(token)).filter((user) => user.role === "pending");
  if (!args.length) {
    if (!pending.length) { ui.line("info", "Waiting for approval", "nobody"); return 0; }
    for (const user of pending) ui.line("info", user.email, `${user.name}${user.created_at ? ` · signed up ${new Date(user.created_at * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}`);
    ui.line("info", "Approve", "dl ui approve EMAIL... (or all)");
    return 0;
  }
  const all = args.length === 1 && args[0] === "all";
  const wanted = all ? pending.map((user) => user.email.toLowerCase()) : [...new Set(args.map((email) => email.trim().toLowerCase()))];
  const unknown = wanted.filter((email) => !pending.some((user) => user.email.toLowerCase() === email));
  if (unknown.length) throw new Error(`Not waiting for approval: ${unknown.join(", ")}. dl ui approve lists who is.`);
  for (const email of wanted) {
    const user = pending.find((entry) => entry.email.toLowerCase() === email)!;
    await client.request("POST", `/api/v1/users/${encodeURIComponent(user.id)}/update`, { role: "user" }, token);
    ui.line("done", email, "approved");
  }
  if (!wanted.length) ui.line("info", "Waiting for approval", "nobody");
  return 0;
}

async function logs(options: ChatUiOptions, path: string): Promise<number> {
  await requireState(options, path);
  await options.system.run("docker", ["logs", "--tail", "200", ...(options.follow ? ["-f"] : []), UI_CONTAINER], { inherit: true });
  return 0;
}

async function down(options: ChatUiOptions, path: string): Promise<number> {
  const { system, ui } = options;
  const state = await readUiState(system, path);
  if (state?.share?.mode === "tailscale") await stopServing(system, state.share.httpsPort, localUrl(state));
  await removeContainer(system, UI_CONTAINER);
  if (options.purge) {
    await system.run("docker", ["volume", "rm", "-f", UI_VOLUME], { allowFailure: true });
    await system.remove(path);
    ui.line("done", "Team chat", "removed with its accounts and chats");
    return 0;
  }
  if (state?.share) {
    delete state.share;
    await writeUiState(system, path, state);
  }
  ui.line("done", "Team chat", `stopped; accounts and chats kept (volume ${UI_VOLUME}) · dl ui up starts it again`);
  return 0;
}
