import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { DUMMY_API_KEY } from "./model-evals.js";
import { inspectContainer, removeContainer } from "./model-runtime.js";
import { localFetch, modelApiBase, type FetchModel } from "./model-smoke.js";
import type { Prompter } from "./prompt.js";
import { modelStatePath, readDeployments } from "./state.js";
import type { System } from "./system.js";
import { HTTPS_CERTS_URL, serveHttps, serveStatus, stopServing, tailnetUrl, tailscaleState } from "./tailscale.js";
import type { Ui } from "./ui.js";

/**
 * `dl ui`: Open WebUI as the team's chat, next to the model, in one Docker container.
 *
 * - It listens on this machine's loopback only. The team reaches it over HTTPS: `dl ui share`
 *   serves it on the tailnet name with `tailscale serve` (a real certificate, reachable only
 *   from the tailnet; never `tailscale funnel`). There is no plain-HTTP network mode; without
 *   Tailscale, an SSH tunnel reaches the loopback port (ssh -N -L 4800:127.0.0.1:4800 box).
 * - The admin is whoever creates Open WebUI's first account, in the browser: dl prints the link
 *   and says to open it at once. dl never keeps the admin's password. For `dl ui invite` and
 *   `dl ui approve` it asks once for an admin's Open WebUI API key (Settings > Account), kept
 *   0600 and usable only on the user-management endpoints (API_KEYS_ALLOWED_ENDPOINTS).
 * - Two-factor sign-in is on for everyone (ENABLE_MFA): each person enrolls an authenticator
 *   app on their first sign-in. Its secrets are encrypted with a key derived from
 *   WEBUI_SECRET_KEY, which Open WebUI generates once into the data volume, so it persists.
 * - Who gets in: sign-ups wait for an admin's approval, or the admin adds people.
 *
 * dl owns Open WebUI's settings: they come from the container's environment on every start
 * (ENABLE_PERSISTENT_CONFIG=false), so web search, image generation, the model endpoints, 2FA
 * and pending approval are what dl set, whatever was saved before. Accounts and chats persist in
 * the dl-ui-data volume. The container restarts with Docker (--restart unless-stopped) and
 * `tailscale serve --bg` is kept by tailscaled, so both survive logout and reboot.
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
/** The only endpoints an Open WebUI API key may call: listing, approving and adding people. */
export const API_KEY_ENDPOINTS = ["/api/v1/users", "/api/v1/auths/add"];
/** Where an admin makes the API key dl asks for. */
export const API_KEY_WHERE = "your name (bottom left) > Settings > Account > API Key > Create";

export interface UiShare { mode: "tailscale"; url: string; httpsPort: number }

/** ~/.local/state/directionallylocal/ui.json, 0600: it may hold an admin's API key. */
export interface UiState {
  version: 2;
  port: number;
  /** An admin's Open WebUI API key (sk-…), asked for once by invite/approve. Never a password. */
  adminApiKey?: string;
  /**
   * Open WebUI has its admin and has restarted since: making the first account turns sign-ups
   * off in Open WebUI's memory, and a restart brings back dl's ENABLE_SIGNUP=true.
   */
  signupsOpen?: boolean;
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
  /** DL_UI_ADMIN_KEY: the admin API key without asking (scripts); process.env unless replaced. */
  env?: NodeJS.ProcessEnv;
  port?: string;
  /** --listen was given: refused, the chat is HTTPS-only. */
  listen?: string;
  /** --admin-email: dl creates the admin itself and shows its password once (it never keeps it). */
  adminEmail?: string;
  /** share --off */
  off?: boolean;
  /** down --purge: also delete the accounts and chats. */
  purge?: boolean;
  follow?: boolean;
}

export const UI_USAGE = "dl ui [up|status|share|invite EMAIL...|approve [EMAIL...|all]|logs|down]";

/** How to reach the loopback-only chat from a laptop without Tailscale. */
export function tunnelHint(port = UI_PORT): string {
  return `ssh -N -L ${port}:127.0.0.1:${port} you@this-machine, then open http://127.0.0.1:${port} on your laptop`;
}

export const NO_LISTEN = "dl ui serves the chat over HTTPS only, so it no longer listens on the network (--listen).\n"
  + "  For your team: dl ui share (a private HTTPS link with Tailscale).\n"
  + `  Just you, without Tailscale: ${tunnelHint()}.`;

export function uiStatePath(statePath = modelStatePath()): string {
  return join(dirname(statePath), "ui.json");
}

export async function readUiState(system: System, path: string): Promise<UiState | undefined> {
  const raw = await system.readFile(path);
  if (!raw) return undefined;
  try {
    const state = JSON.parse(raw) as Record<string, unknown>;
    if (!Number.isInteger(state.port)) throw new Error("invalid");
    const share = state.share as Partial<UiShare> | undefined;
    const tailnet = share?.mode === "tailscale" && typeof share.url === "string" && Number.isInteger(share.httpsPort) ? share as UiShare : undefined;
    if (state.version === 1) {
      // dl ui before HTTPS-only (never released): no LAN share, no password kept.
      return { version: 2, port: state.port as number, ...(state.adminCreated === true ? { signupsOpen: true } : {}), ...(tailnet ? { share: tailnet } : {}) };
    }
    if (state.version !== 2 || (state.adminApiKey !== undefined && typeof state.adminApiKey !== "string")) throw new Error("invalid");
    return { version: 2, port: state.port as number, ...(typeof state.adminApiKey === "string" ? { adminApiKey: state.adminApiKey } : {}),
      ...(state.signupsOpen === true ? { signupsOpen: true } : {}), ...(tailnet ? { share: tailnet } : {}) };
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

/** Where dl itself reaches Open WebUI (and where `tailscale serve` points). */
export function localUrl(state: Pick<UiState, "port">): string {
  return `http://${LOOPBACK}:${state.port}`;
}

/** The link Open WebUI calls itself (WEBUI_URL): the shared one, else the local one. */
export function publicUrl(state: Pick<UiState, "port" | "share">): string {
  return state.share?.url ?? localUrl(state);
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
export function uiEnv(state: Pick<UiState, "port" | "share">, endpoints: readonly string[]): Record<string, string> {
  return {
    // --network host: Open WebUI binds loopback itself, and reaches the models on 127.0.0.1.
    HOST: LOOPBACK,
    PORT: String(state.port),
    WEBUI_URL: publicUrl(state),
    // The session-signing key is generated once into the volume, never passed in the environment.
    // 2FA's secrets are encrypted with a key derived from it, so it must persist (it does, in the volume).
    WEBUI_SECRET_KEY_FILE: `${DATA_DIR}/.webui_secret_key`,
    // dl's settings win on every start (see the header).
    ENABLE_PERSISTENT_CONFIG: "false",
    // Who gets in: anyone may ask, an admin approves each person; everyone signs in with 2FA.
    ENABLE_SIGNUP: "true",
    DEFAULT_USER_ROLE: "pending",
    ENABLE_MFA: "true",
    // API keys, for dl ui invite/approve with an admin's key; only on the user-management endpoints.
    ENABLE_API_KEYS: "true",
    ENABLE_API_KEYS_ENDPOINT_RESTRICTIONS: "true",
    API_KEYS_ALLOWED_ENDPOINTS: API_KEY_ENDPOINTS.join(","),
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
export function uiDockerArgs(state: Pick<UiState, "port" | "share">, endpoints: readonly string[]): string[] {
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

/** Open WebUI's HTTP API. */
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

  /** Whether the first account (the admin) exists: until then /api/config says onboarding. */
  async hasAdmin(): Promise<boolean> {
    const config = await this.request<{ onboarding?: boolean }>("GET", "/api/config");
    return config?.onboarding !== true;
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

const refused = (error: unknown) => error instanceof OpenWebUiError && (error.status === 401 || error.status === 403);

export async function chatUiCommand(action: string | undefined, args: string[], options: ChatUiOptions): Promise<number> {
  const { ui } = options;
  const path = uiStatePath(options.statePath);
  const verb = action ?? "up";
  if (verb !== "invite" && verb !== "approve" && args.length) { ui.line("failed", "Usage", UI_USAGE); return 2; }
  if (options.listen !== undefined) throw new Error(NO_LISTEN);
  if (options.off && verb !== "share") throw new Error("--off goes with dl ui share.");
  if (options.purge && verb !== "down") throw new Error("--purge goes with dl ui down.");
  if (options.adminEmail !== undefined && verb !== "up") throw new Error("--admin-email goes with dl ui up.");
  if (options.port !== undefined && verb !== "up") throw new Error("--port goes with dl ui up.");
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

async function requireState(options: Pick<ChatUiOptions, "system">, path: string): Promise<UiState> {
  const state = await readUiState(options.system, path);
  if (!state) throw new Error("Team chat isn't set up here yet: dl ui up");
  return state;
}

function api(options: Pick<ChatUiOptions, "fetch">, state: UiState): OpenWebUi {
  return new OpenWebUi(localUrl(state), options.fetch ?? localFetch);
}

type Waiting = Pick<ChatUiOptions, "system" | "fetch" | "delay">;

function sleeper(options: Pick<ChatUiOptions, "delay">): (ms: number) => Promise<void> {
  return options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

async function waitHealthy(options: Waiting, state: UiState): Promise<void> {
  const delay = sleeper(options);
  const client = api(options, state);
  // The first start migrates its database; give it five minutes.
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await client.healthy()) return;
    if (attempt > 2 && !(await inspectContainer(options.system, UI_CONTAINER, UI_SPEC_LABEL))?.running) break;
    await delay(2_000);
  }
  throw new Error(`Open WebUI didn't come up on ${localUrl(state)}; see docker logs ${UI_CONTAINER}`);
}

type Starting = Pick<ChatUiOptions, "system" | "ui" | "fetch" | "delay">;

/**
 * Starts (or keeps) the container for `state`; returns whether it changed. The same settings
 * keep the running container; anything else replaces it (the volume keeps accounts and chats).
 */
async function ensureContainer(options: Starting, state: UiState, statePath: string, path: string): Promise<"kept" | "started" | "replaced"> {
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
  ui.line("info", existing ? "Restarting" : "Starting", `Open WebUI on ${LOOPBACK}:${state.port} (the first start takes a minute)`);
  await system.run("docker", runArgs);
  if (!system.dryRun) {
    await waitHealthy(options, state);
    // A fresh start has dl's sign-up setting, whatever Open WebUI did at its first account.
    const open = await api(options, state).hasAdmin();
    if (open !== Boolean(state.signupsOpen)) {
      if (open) state.signupsOpen = true; else delete state.signupsOpen;
      await writeUiState(system, path, state);
    }
  }
  ui.line("done", "Open WebUI", endpoints.length ? `up · ${endpoints.length === 1 ? "1 model endpoint" : `${endpoints.length} model endpoints`}` : "up · no model yet");
  return existing ? "replaced" : "started";
}

/**
 * Open WebUI turns sign-ups off when its first account (the admin) is made. With dl's
 * ENABLE_PERSISTENT_CONFIG=false that lasts only until a restart, which brings back dl's
 * ENABLE_SIGNUP=true: once the admin exists, dl restarts the container once. True when it did.
 */
export async function reopenSignups(options: Waiting, path: string, state: UiState): Promise<boolean> {
  if (state.signupsOpen || options.system.dryRun) return false;
  if (!(await api(options, state).hasAdmin())) return false;
  await options.system.run("docker", ["restart", UI_CONTAINER]);
  await waitHealthy(options, state);
  state.signupsOpen = true;
  await writeUiState(options.system, path, state);
  return true;
}

export interface ChatStart {
  state: UiState;
  result: "kept" | "started" | "replaced";
  /** Open WebUI has its admin account. */
  hasAdmin: boolean;
  /** --admin-email: the admin dl created, with the password shown once. */
  created?: { email: string; password: string };
}

/** `dl ui up` without its summary: what the first run's chat setup calls too. */
export async function startChat(options: ChatUiOptions, path = uiStatePath(options.statePath)): Promise<ChatStart> {
  const { system } = options;
  const statePath = options.statePath ?? modelStatePath();
  const previous = await readUiState(system, path);
  const port = options.port !== undefined ? parsePort(options.port) : previous?.port ?? UI_PORT;
  const deployments = await readDeployments(system, statePath);
  const clash = Object.entries(deployments).find(([, entry]) => entry.active.port === port || entry.previous?.port === port || entry.active.port + 1 === port);
  if (clash) throw new Error(`Port ${port} belongs to model deployment ${clash[0]}; pick another with --port.`);
  if ((await system.probe("docker", ["info", "--format", "{{.ServerVersion}}"])).code !== 0) throw new Error("Docker is missing or its daemon is stopped; dl ui runs Open WebUI in Docker.");
  const email = options.adminEmail?.trim().toLowerCase();
  if (email !== undefined && !validEmail(email)) throw new Error(`"${email}" isn't an email address.`);
  const state: UiState = { ...(previous ?? { version: 2, port }), port };
  // A share link is for one port: a change drops it (dl ui share makes a new one).
  if (previous?.share && previous.port !== port) {
    await stopServing(system, previous.share.httpsPort, localUrl(previous));
    delete state.share;
  }
  await writeUiState(system, path, state);
  const result = await ensureContainer(options, state, statePath, path);
  if (system.dryRun) return { state, result, hasAdmin: false };
  let created: ChatStart["created"];
  const client = api(options, state);
  let hasAdmin = await client.hasAdmin();
  if (email !== undefined) {
    if (hasAdmin) throw new Error("Open WebUI already has its admin; add more admins in its Admin Panel (Users).");
    created = { email, password: generatePassword() };
    const made = await client.request<{ role?: string }>("POST", "/api/v1/auths/signup", { name: "Admin", email, password: created.password });
    if (made?.role !== "admin") throw new Error(`Open WebUI made ${email} a ${made?.role ?? "pending"} user, not the admin; dl ui down --purge and try again.`);
    hasAdmin = true;
  }
  if (hasAdmin) await reopenSignups(options, path, state);
  return { state, result, hasAdmin, ...(created ? { created } : {}) };
}

async function up(options: ChatUiOptions, path: string): Promise<number> {
  const { system, ui } = options;
  const { state, result, hasAdmin, created } = await startChat(options, path);
  if (system.dryRun) { ui.line("info", "Dry run", "nothing started"); return 0; }
  ui.line("info", "Listening", `this machine only (${LOOPBACK}:${state.port})`);
  if (!(await modelEndpoints(system, options.statePath ?? modelStatePath())).length) ui.warn("No dl model is running here, so the chat has no models yet: dl model up (the chat picks it up by itself).");
  const items = [{ label: "Open", value: publicUrl(state) }];
  if (created) items.push({ label: "Admin", value: `${created.email} · password ${created.password}` });
  const about = [
    ...(created ? ["The password is shown only now; dl doesn't keep it. Change it after you sign in: Settings > Account."] : []),
    ...(!hasAdmin ? [state.share
      ? `Set up the admin account at ${state.share.url} now: whoever opens it first becomes the admin.`
      : `No admin yet: whoever opens it first becomes the admin. From your laptop: ${tunnelHint(state.port)}, and create it.`] : []),
    "Everyone sets up an authenticator app (2FA) the first time they sign in. New sign-ups wait for approval.",
  ];
  ui.ready(result === "kept" && !created ? "Team chat is running" : "Team chat is ready", items, {
    about,
    footer: state.share ? `Shared: ${state.share.url}` : "Only this machine can open it (or an SSH tunnel). dl ui share gives your team a private HTTPS link with Tailscale.",
  });
  return 0;
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
  if (container && !current) ui.line("info", "Settings", "changed since it started (models or share) · dl ui up applies them");
  ui.line("info", "Local", `${localUrl(state)} (this machine only)`);
  ui.line("info", "Shared", state.share ? `${state.share.url} (HTTPS, tailnet only)` : "no · dl ui share");
  ui.line("info", "Models", endpoints.length ? endpoints.join(", ") : "none · dl model up");
  ui.line("info", "2FA", "required for everyone");
  if (container?.running) {
    const client = api(options, state);
    const admin = await client.hasAdmin().catch(() => undefined);
    if (admin === false) ui.line("info", "Admin", `not set up yet · open ${publicUrl(state)} and create it (the first account is the admin)`);
    const pending = await pendingSignUps(options, state);
    if (pending) ui.line("info", "Waiting for approval", pending.length ? `${pending.map((user) => user.email).join(", ")} · dl ui approve` : "nobody");
  }
  return 0;
}

/** Who waits for approval, when dl has an admin API key (never otherwise); undefined when unknown. */
export async function pendingSignUps(options: Pick<ChatUiOptions, "fetch">, state: UiState): Promise<OpenWebUiUser[] | undefined> {
  if (!state.adminApiKey) return undefined;
  try {
    return (await api(options, state).users(state.adminApiKey)).filter((user) => user.role === "pending");
  } catch {
    return undefined;
  }
}

async function requireRunning(options: ChatUiOptions): Promise<void> {
  const container = await inspectContainer(options.system, UI_CONTAINER, UI_SPEC_LABEL);
  if (!container?.running) throw new Error("The team chat isn't running: dl ui up");
}

/**
 * Picks the tailnet HTTPS port: the one already serving `target`, else the first free one of
 * `ports`; never one Funnel makes public. `what` and `again` name the thing and the command in errors.
 */
export async function tailnetPort(system: System, target: string, previous: number | undefined, ports: readonly number[] = TAILNET_PORTS, what = "the chat", again = "dl ui share"): Promise<number> {
  const served = await serveStatus(system);
  const candidates = previous ? [previous, ...ports.filter((port) => port !== previous)] : ports;
  const port = candidates.find((candidate) => { const entry = served.get(candidate); return !entry || entry.proxy === target; });
  if (port === undefined) throw new Error(`Tailscale already serves other things on HTTPS ports ${ports.join(", ")}; free one (tailscale serve status) and run ${again} again.`);
  if (served.get(port)?.funnel) {
    throw new Error(`Tailscale Funnel is on for HTTPS port ${port}, which would make ${what} public. dl only shares on the tailnet; turn Funnel off for that port first.`);
  }
  return port;
}

/**
 * Serves the chat on `name` (this machine's tailnet name, HTTPS certificates on) with
 * `tailscale serve --bg`, which tailscaled keeps across restarts, and points Open WebUI's own
 * links at it.
 */
export async function shareOnTailnet(options: Starting & Pick<ChatUiOptions, "statePath">, path: string, state: UiState, name: string): Promise<UiShare> {
  const { system } = options;
  const target = localUrl(state);
  const httpsPort = await tailnetPort(system, target, state.share?.httpsPort);
  const served = await serveHttps(system, httpsPort, target);
  if (served.code !== 0) {
    throw new Error(`Tailscale couldn't serve HTTPS: ${served.stderr.trim() || served.stdout.trim()}\n`
      + `  Turn on MagicDNS and HTTPS certificates at ${HTTPS_CERTS_URL}, then run dl ui share again.`);
  }
  const next: UiShare = { mode: "tailscale", url: tailnetUrl(name, httpsPort), httpsPort };
  state.share = next;
  await writeUiState(system, path, state);
  // Open WebUI's own links (WEBUI_URL) follow the shared address.
  await ensureContainer(options, state, options.statePath ?? modelStatePath(), path);
  return next;
}

/** Why there's no private HTTPS link yet, and what to do: one line each. */
export function tailscaleBlocker(state: "missing" | "logged-out" | "no-https"): { problem: string; next: string } {
  if (state === "missing") return { problem: "Tailscale isn't installed here, and dl shares the chat only over HTTPS on your tailnet.", next: "install Tailscale (https://pkgs.tailscale.com/stable/), sign in (sudo tailscale up), then dl ui share" };
  if (state === "logged-out") return { problem: "Tailscale isn't signed in here, and dl shares the chat only over HTTPS on your tailnet.", next: "sudo tailscale up (it prints a sign-in link), then dl ui share" };
  return { problem: "HTTPS certificates are off for your tailnet, so there's no private HTTPS link yet.", next: `turn on MagicDNS and HTTPS certificates at ${HTTPS_CERTS_URL}, then dl ui share` };
}

async function share(options: ChatUiOptions, path: string): Promise<number> {
  const { system, ui } = options;
  const statePath = options.statePath ?? modelStatePath();
  const state = await requireState(options, path);
  if (options.off) {
    if (state.share) await stopServing(system, state.share.httpsPort, localUrl(state));
    const was = state.share;
    delete state.share;
    await writeUiState(system, path, state);
    if (await inspectContainer(system, UI_CONTAINER, UI_SPEC_LABEL)) await ensureContainer(options, state, statePath, path);
    ui.line("done", "Shared", was ? `no longer (${was.url})` : "it wasn't");
    return 0;
  }
  await requireRunning(options);
  const tailscale = await tailscaleState(system);
  if (tailscale.state !== "ready") {
    // HTTPS only: no plain-HTTP fallback on the network.
    const { problem, next } = tailscaleBlocker(tailscale.state);
    ui.line("failed", "Tailscale", problem);
    ui.line("info", "Next", next);
    ui.line("info", "Or, just you", tunnelHint(state.port));
    return 1;
  }
  const next = await shareOnTailnet(options, path, state, tailscale.name);
  const admin = await api(options, state).hasAdmin().catch(() => true);
  ui.ready("Share this link with your team", [{ label: "Team chat", value: next.url }], {
    about: [
      "Private to your tailnet (tailscale serve, HTTPS); it isn't on the internet. Each person needs the Tailscale app.",
      ...(!admin ? [`No admin yet: open ${next.url} now and create the admin account; whoever opens it first becomes the admin.`] : []),
    ],
    footer: "Sign-ups wait for your approval (Admin Panel > Users, or dl ui approve), or add people: dl ui invite a@x.com",
  });
  return 0;
}

/**
 * An admin's API key, for invite and approve: the one kept in ui.json, else DL_UI_ADMIN_KEY,
 * else asked once on a terminal. Checked (only an admin may list users) and kept 0600.
 */
async function adminKey(options: ChatUiOptions, path: string, state: UiState): Promise<string> {
  if (state.adminApiKey) return state.adminApiKey;
  const { ui } = options;
  const where = `open ${publicUrl(state)}, then ${API_KEY_WHERE}`;
  let key = (options.env ?? process.env).DL_UI_ADMIN_KEY?.trim();
  if (!key) {
    if (!options.interactive) throw new Error(`dl needs an Open WebUI API key of an admin, once (it never keeps the admin's password). Make one: ${where}. Then run this in a terminal, or with DL_UI_ADMIN_KEY=sk-…`);
    ui.line("info", "Admin API key", "dl needs one, once, to add and approve people; it never keeps the admin's password");
    ui.line("info", "Make one", where);
    key = (await options.prompter.secret(ui.prompt("Admin API key", "sk-…"))).trim();
  }
  if (!/^sk-[A-Za-z0-9_-]{8,}$/.test(key)) throw new Error("That isn't an Open WebUI API key (they start with sk-).");
  try {
    await api(options, state).users(key);
  } catch (error) {
    if (refused(error)) throw new Error(`Open WebUI refused that key: it must be an admin's (${API_KEY_WHERE}).`);
    throw error;
  }
  state.adminApiKey = key;
  await writeUiState(options.system, path, state);
  ui.line("done", "Admin API key", `kept in ${path} (readable by you only)`);
  return key;
}

/** Runs `work` with the admin's key; a kept key Open WebUI refuses is dropped, so the next run asks again. */
async function asAdmin<T>(options: ChatUiOptions, path: string, state: UiState, work: (client: OpenWebUi, key: string) => Promise<T>): Promise<T> {
  const kept = Boolean(state.adminApiKey);
  const key = await adminKey(options, path, state);
  try {
    return await work(api(options, state), key);
  } catch (error) {
    if (kept && refused(error)) {
      delete state.adminApiKey;
      await writeUiState(options.system, path, state);
      throw new Error("Open WebUI refused the admin API key dl kept (deleted, or not an admin's any more); run the command again to give a new one.");
    }
    throw error;
  }
}

async function invite(options: ChatUiOptions, path: string, emails: string[]): Promise<number> {
  const { ui } = options;
  if (!emails.length) { ui.line("failed", "Usage", "dl ui invite a@x.com b@x.com"); return 2; }
  const wanted = [...new Set(emails.map((email) => email.trim().replace(/,$/, "").toLowerCase()).filter(Boolean))];
  const bad = wanted.filter((email) => !validEmail(email));
  if (bad.length) throw new Error(`Not email addresses: ${bad.join(", ")}. Nobody was invited.`);
  const state = await requireState(options, path);
  await requireRunning(options);
  const link = publicUrl(state);
  const items = await asAdmin(options, path, state, async (client, key) => {
    const existing = new Map((await client.users(key)).map((user) => [user.email.toLowerCase(), user]));
    const lines: Array<{ label: string; value: string }> = [];
    for (const email of wanted) {
      const user = existing.get(email);
      if (user?.role === "pending") {
        await client.request("POST", `/api/v1/users/${encodeURIComponent(user.id)}/update`, { role: "user" }, key);
        ui.line("done", email, "approved (they had already signed up)");
        lines.push({ label: email, value: `${link} · sign in with the password they chose` });
      } else if (user) {
        ui.line("info", email, `already has an account (${user.role})`);
      } else {
        const password = generatePassword();
        await client.request("POST", "/api/v1/auths/add", { name: email.split("@")[0], email, password, role: "user" }, key);
        ui.line("done", email, "account created");
        lines.push({ label: email, value: `${link} · sign in as ${email} · password ${password} · then change it: Settings > Account` });
      }
    }
    return lines;
  });
  if (!items.length) return 0;
  ui.ready("Send each person their line (dl sends no email)", items, {
    about: ["The passwords are shown only now; dl doesn't keep them. A lost one: Admin Panel > Users > edit.",
      "Each person sets up an authenticator app (2FA) the first time they sign in, and needs the Tailscale app."],
    ...(state.share ? {} : { footer: "This link works only on this machine until you run dl ui share." }),
  });
  return 0;
}

async function approve(options: ChatUiOptions, path: string, args: string[]): Promise<number> {
  const { ui } = options;
  const state = await requireState(options, path);
  await requireRunning(options);
  return asAdmin(options, path, state, async (client, key) => {
    const pending = (await client.users(key)).filter((user) => user.role === "pending");
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
      await client.request("POST", `/api/v1/users/${encodeURIComponent(user.id)}/update`, { role: "user" }, key);
      ui.line("done", email, "approved");
    }
    if (!wanted.length) ui.line("info", "Waiting for approval", "nobody");
    return 0;
  });
}

async function logs(options: ChatUiOptions, path: string): Promise<number> {
  await requireState(options, path);
  await options.system.run("docker", ["logs", "--tail", "200", ...(options.follow ? ["-f"] : []), UI_CONTAINER], { inherit: true });
  return 0;
}

async function down(options: ChatUiOptions, path: string): Promise<number> {
  const { system, ui } = options;
  const state = await readUiState(system, path);
  if (state?.share) await stopServing(system, state.share.httpsPort, localUrl(state));
  await removeContainer(system, UI_CONTAINER);
  if (options.purge) {
    await system.run("docker", ["volume", "rm", "-f", UI_VOLUME], { allowFailure: true });
    await system.remove(path);
    ui.line("done", "Team chat", "removed with its accounts and chats");
    return 0;
  }
  if (state) {
    delete state.share;
    // The next start is a fresh process: sign-ups follow dl's setting again.
    delete state.signupsOpen;
    await writeUiState(system, path, state);
  }
  ui.line("done", "Team chat", `stopped; accounts and chats kept (volume ${UI_VOLUME}) · dl ui up starts it again`);
  return 0;
}

/**
 * After `dl model up`, `update`, `rollback` or `down`: a running team chat picks up the change by
 * itself, with the same link and accounts (its container is replaced only when its model
 * endpoints changed). A chat that isn't set up or was stopped is left alone; a failure only warns.
 */
export async function refreshChatUi(options: Starting & Pick<ChatUiOptions, "statePath">): Promise<void> {
  const { system, ui } = options;
  if (system.dryRun) return;
  const path = uiStatePath(options.statePath);
  try {
    const state = await readUiState(system, path);
    if (!state || !(await inspectContainer(system, UI_CONTAINER, UI_SPEC_LABEL))?.running) return;
    const result = await ensureContainer(options, state, options.statePath ?? modelStatePath(), path);
    if (result !== "kept") ui.line("done", "Team chat", `updated for the models here · same link: ${publicUrl(state)}`);
  } catch (error) {
    ui.warn(`The team chat didn't pick up the change: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}. dl ui up applies it.`);
  }
}
