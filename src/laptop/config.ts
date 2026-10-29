import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** A paired Autopilot server. The token is an Aster client credential, never a provider key. */
export interface RemoteServer {
  name: string;
  url: string;
  token: string;
  credentialId: string;
  expiresAt: string;
  addedAt: string;
  /**
   * Set when the server is reached over SSH (set up by `dl setup`): `url` is then the
   * server-side address (http://127.0.0.1:4096) and every command tunnels to it. Optional,
   * so entries written by `dl connect` or Autopilot's `remote add` stay exactly as they were.
   */
  ssh?: SshAccess;
}

/** How to reach a server over SSH: a destination ssh understands (an alias or user@host). */
export interface SshAccess {
  target: string;
  port?: number;
  identityFile?: string;
}

/**
 * The remotes file, shared with Autopilot's `--on` (whose loader reads only `version` and
 * `remotes`, so the optional top-level fields below are invisible to it).
 */
interface RemotesFile {
  version: 1;
  remotes: RemoteServer[];
  /** The place commands use when none is named: `dl use NAME`. */
  default?: string;
  /** The place the last task was sent to; the fallback when there's no default. */
  lastUsed?: string;
}

/** The remotes plus where commands go when no name is given. */
export interface Remotes {
  remotes: RemoteServer[];
  default?: string;
  lastUsed?: string;
}

/** Why a command went where it did, for its first line. */
export type TargetReason = "named" | "default" | "only" | "last used";

export const REMOTE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function remotesPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AUTOPILOT_REMOTES_FILE) return env.AUTOPILOT_REMOTES_FILE;
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(configHome, "autopilot", "remotes.json");
}

export async function loadRemotes(path = remotesPath()): Promise<RemoteServer[]> {
  return (await loadRemotesFile(path)).remotes;
}

/**
 * The remotes with the default and last-used names. A name that no longer matches a
 * remote (it was removed, or renamed by something that didn't know) is dropped.
 */
export async function loadRemotesFile(path = remotesPath()): Promise<Remotes> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { remotes: [] };
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<RemotesFile>;
  const remotes = Array.isArray(parsed.remotes) ? parsed.remotes.filter(isRemote) : [];
  const known = (name: unknown): name is string => typeof name === "string" && remotes.some((entry) => entry.name === name);
  return {
    remotes,
    ...(known(parsed.default) ? { default: parsed.default } : {}),
    ...(known(parsed.lastUsed) ? { lastUsed: parsed.lastUsed } : {}),
  };
}

/**
 * Adds or replaces a remote by name. The file holds bearer tokens, so it is 0600 in a 0700
 * directory. When no default is set yet, the first place saved becomes it (an older file's
 * first entry, if it had any), so the first setup needs no `dl use`.
 */
export async function saveRemote(remote: RemoteServer, path = remotesPath()): Promise<void> {
  const file = await loadRemotesFile(path);
  const remotes = file.remotes.filter((entry) => entry.name !== remote.name);
  remotes.push(remote);
  await writeRemotes({ ...file, remotes, default: file.default ?? file.remotes[0]?.name ?? remote.name }, path);
}

export async function removeRemote(name: string, path = remotesPath()): Promise<boolean> {
  const file = await loadRemotesFile(path);
  const kept = file.remotes.filter((entry) => entry.name !== name);
  if (kept.length === file.remotes.length) return false;
  // Forgetting the default leaves none; with one place left, that one is used anyway.
  await writeRemotes({
    remotes: kept,
    ...(file.default && file.default !== name ? { default: file.default } : {}),
    ...(file.lastUsed && file.lastUsed !== name ? { lastUsed: file.lastUsed } : {}),
  }, path);
  return true;
}

/** `dl use NAME`: where commands go when none is named. */
export async function setDefaultRemote(name: string, path = remotesPath()): Promise<RemoteServer> {
  const file = await loadRemotesFile(path);
  const remote = file.remotes.find((entry) => entry.name === name);
  if (!remote) throw new Error(unknownName(name, file.remotes));
  await writeRemotes({ ...file, default: name }, path);
  return remote;
}

/** Remembers where the last task went (the fallback when there's no default). */
export async function recordLastUsed(name: string, path = remotesPath()): Promise<void> {
  const file = await loadRemotesFile(path);
  if (file.lastUsed === name || !file.remotes.some((entry) => entry.name === name)) return;
  await writeRemotes({ ...file, lastUsed: name }, path);
}

/** The named remote, else the default, else the only one, else the last one used. */
export async function resolveRemote(name: string | undefined, path = remotesPath()): Promise<RemoteServer> {
  return (await resolveTarget(name, path)).remote;
}

/** resolveRemote, and why that one (for the command's first line). */
export async function resolveTarget(name: string | undefined, path = remotesPath()): Promise<{ remote: RemoteServer; reason: TargetReason }> {
  const file = await loadRemotesFile(path);
  const { remotes } = file;
  if (remotes.length === 0) throw new Error("Nothing is set up yet. Run: dl setup");
  const named = (wanted: string) => remotes.find((entry) => entry.name === wanted);
  if (name !== undefined) {
    const remote = named(name);
    if (!remote) throw new Error(unknownName(name, remotes));
    return { remote, reason: "named" };
  }
  if (remotes.length === 1) return { remote: remotes[0]!, reason: "only" };
  const chosen = file.default ? named(file.default) : undefined;
  if (chosen) return { remote: chosen, reason: "default" };
  const last = file.lastUsed ? named(file.lastUsed) : undefined;
  if (last) return { remote: last, reason: "last used" };
  throw new Error(`Several places are set up (${remotes.map((entry) => entry.name).join(", ")}). Pick one with --server NAME, or set a default: dl use NAME`);
}

function unknownName(name: string, remotes: RemoteServer[]): string {
  return remotes.length
    ? `Nothing named "${name}" is set up. Set up: ${remotes.map((entry) => entry.name).join(", ")}`
    : `Nothing named "${name}" is set up; nothing is yet. Run: dl setup`;
}

/** A short default name from the URL's host: https://acme.example.com -> acme. */
export function defaultRemoteName(url: string): string {
  const host = new URL(url).hostname.toLowerCase();
  const label = /^\d+(\.\d+){3}$/.test(host) ? host.replace(/\./g, "-") : host.split(".")[0] ?? "server";
  const name = label.replace(/[^a-z0-9-]/g, "-").replace(/^-+/, "").slice(0, 40);
  return REMOTE_NAME_RE.test(name) ? name : "server";
}

/** Server URLs must be HTTPS, except loopback (an SSH tunnel or local testing). */
export function normalizeServerUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new Error(`Not a URL: ${input}`);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname.startsWith("127.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Use an https:// server URL (http:// is only allowed for localhost)");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("The server URL must not include credentials, a query, or a fragment");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

async function writeRemotes(file: Remotes, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  const body: RemotesFile = {
    version: 1,
    remotes: file.remotes,
    ...(file.default ? { default: file.default } : {}),
    ...(file.lastUsed ? { lastUsed: file.lastUsed } : {}),
  };
  await writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}

function isRemote(value: unknown): value is RemoteServer {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (!["name", "url", "token", "credentialId", "expiresAt", "addedAt"].every((key) => typeof entry[key] === "string")) return false;
  return entry.ssh === undefined || isSshAccess(entry.ssh);
}

function isSshAccess(value: unknown): value is SshAccess {
  if (!value || typeof value !== "object") return false;
  const ssh = value as Record<string, unknown>;
  return typeof ssh.target === "string" && ssh.target.length > 0 && !ssh.target.startsWith("-") &&
    (ssh.port === undefined || (typeof ssh.port === "number" && Number.isInteger(ssh.port) && ssh.port > 0 && ssh.port < 65536)) &&
    (ssh.identityFile === undefined || typeof ssh.identityFile === "string");
}
