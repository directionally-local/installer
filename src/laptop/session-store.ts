import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The conversations `dl` has started from a folder: a history per place + repository + local
 * checkout for a project (so two clones of the same repository, or the same one on two places,
 * each keep their own), and one per place + directory for a chat outside a project. Bare `dl`
 * always starts a new one; `dl -c` reopens the latest here, and the rest are only asked about
 * so dl can say when an earlier one is still live. Only IDs live here (no tokens), but it's
 * private like the rest of the laptop's config.
 */

export interface SessionKey {
  /** The place's name, as in `dl servers`. */
  place: string;
  /** A code session's owner/name on GitHub; a chat has none. */
  repository?: string;
  /** The checkout's top-level directory on this laptop, or the directory a chat was started in. */
  root: string;
  /** A chat outside a project; absent means a code session. */
  kind?: "chat";
}

export interface SessionEntry extends SessionKey {
  conversationId: string;
  branch?: string;
  updatedAt: string;
}

interface SessionsFile {
  version: 1;
  sessions: SessionEntry[];
}

/** How many conversations a folder keeps per place; older ones are only ever reopened by hand. */
const KEEP_PER_KEY = 20;

export function sessionsPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(configHome, "directionallylocal", "sessions.json");
}

export async function loadSessions(path = sessionsPath()): Promise<SessionEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SessionsFile>;
    return Array.isArray(parsed.sessions) ? parsed.sessions.filter(isEntry) : [];
  } catch {
    // A damaged file only costs a new conversation; it gets rewritten on the next save.
    return [];
  }
}

/** Every conversation started from this folder on this place, newest first. */
export async function sessionsFor(key: SessionKey, path = sessionsPath()): Promise<SessionEntry[]> {
  return (await loadSessions(path))
    .filter((entry) => sameKey(entry, key))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The conversation `dl -c` reopens: the latest one started from this folder on this place. */
export async function latestSession(key: SessionKey, path = sessionsPath()): Promise<SessionEntry | undefined> {
  return (await sessionsFor(key, path))[0];
}

/** Remembers a conversation (or moves it back to the front of the history). */
export async function rememberSession(entry: Omit<SessionEntry, "updatedAt">, path = sessionsPath()): Promise<void> {
  const kept = (await loadSessions(path)).filter((existing) => existing.conversationId !== entry.conversationId);
  // Strictly newer than anything kept, so "latest" never depends on two saves landing in the
  // same millisecond.
  const newest = kept.reduce((latest, existing) => Math.max(latest, Date.parse(existing.updatedAt) || 0), 0);
  const updatedAt = new Date(Math.max(Date.now(), newest + 1)).toISOString();
  kept.push({ ...entry, updatedAt });
  await writeSessions(trim(kept), path);
}

/** Forgets a conversation (it keeps running on the place); true when it was remembered. */
export async function forgetSession(conversationId: string, path = sessionsPath()): Promise<boolean> {
  const sessions = await loadSessions(path);
  const kept = sessions.filter((entry) => entry.conversationId !== conversationId);
  if (kept.length === sessions.length) return false;
  await writeSessions(kept, path);
  return true;
}

/** Keeps the newest KEEP_PER_KEY conversations for each folder + place. */
function trim(sessions: SessionEntry[]): SessionEntry[] {
  const counts = new Map<string, number>();
  const kept: SessionEntry[] = [];
  for (const entry of [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const key = keyId(entry);
    const count = counts.get(key) ?? 0;
    if (count >= KEEP_PER_KEY) continue;
    counts.set(key, count + 1);
    kept.push(entry);
  }
  return kept;
}

function keyId(key: SessionKey): string {
  return [key.place, key.repository ?? "", key.root, key.kind ?? "code"].join("\u0000");
}

function sameKey(a: SessionKey, b: SessionKey): boolean {
  return a.place === b.place && (a.repository ?? "") === (b.repository ?? "") && a.root === b.root && (a.kind ?? "code") === (b.kind ?? "code");
}

async function writeSessions(sessions: SessionEntry[], path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  const body: SessionsFile = { version: 1, sessions };
  await writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}

function isEntry(value: unknown): value is SessionEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return ["place", "root", "conversationId", "updatedAt"].every((key) => typeof entry[key] === "string") &&
    (entry.repository === undefined || typeof entry.repository === "string") &&
    (entry.kind === undefined || entry.kind === "chat") &&
    (entry.branch === undefined || typeof entry.branch === "string");
}
