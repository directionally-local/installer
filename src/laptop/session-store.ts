import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Which conversations `dl` can reopen in a project: several per place + repository + local
 * checkout, most recent first, so `dl new` leaves the old one reachable (`dl attach`). Two
 * clones of the same repository (or the same one on two places) each keep their own list.
 * Only IDs live here (no tokens), but it's private like the rest of the laptop's config.
 */

export interface SessionKey {
  /** The place's name, as in `dl servers`. */
  place: string;
  /** owner/name on GitHub. */
  repository: string;
  /** The checkout's top-level directory on this laptop. */
  root: string;
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

/** The conversation `dl` reopens here: the most recently used one. */
export async function findSession(key: SessionKey, path = sessionsPath()): Promise<SessionEntry | undefined> {
  return (await findSessions(key, path))[0];
}

/** Every remembered conversation for this place + repository + checkout, most recent first. */
export async function findSessions(key: SessionKey, path = sessionsPath()): Promise<SessionEntry[]> {
  return (await loadSessions(path))
    .filter((entry) => sameKey(entry, key))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.conversationId.localeCompare(b.conversationId));
}

/**
 * Remembers a conversation, or bumps it to most recent when it's already there. Other
 * conversations for the same key stay, so `dl new` never loses the old one.
 */
export async function rememberSession(entry: Omit<SessionEntry, "updatedAt">, path = sessionsPath()): Promise<void> {
  const sessions = await loadSessions(path);
  const kept = sessions.filter((existing) => !(sameKey(existing, entry) && existing.conversationId === entry.conversationId));
  const latest = Math.max(0, ...kept.filter((existing) => sameKey(existing, entry)).map((existing) => Date.parse(existing.updatedAt) || 0));
  // Strictly newer than the rest, so "most recent" is never a tie.
  const updatedAt = new Date(Math.max(Date.now(), latest + 1)).toISOString();
  kept.push({ ...entry, updatedAt });
  await writeSessions(kept, path);
}

/** Makes a remembered conversation the most recent for its key; true when it was remembered. */
export async function touchSession(place: string, conversationId: string, path = sessionsPath()): Promise<boolean> {
  const sessions = await loadSessions(path);
  const entry = sessions.find((existing) => existing.place === place && existing.conversationId === conversationId);
  if (!entry) return false;
  const latest = Math.max(0, ...sessions
    .filter((existing) => sameKey(existing, entry))
    .map((existing) => Date.parse(existing.updatedAt) || 0));
  entry.updatedAt = new Date(Math.max(Date.now(), latest + 1)).toISOString();
  await writeSessions(sessions, path);
  return true;
}

/** Forgets one conversation for this key (it keeps running on the place); true when it was there. */
export async function forgetConversation(key: SessionKey, conversationId: string, path = sessionsPath()): Promise<boolean> {
  const sessions = await loadSessions(path);
  const kept = sessions.filter((entry) => !(sameKey(entry, key) && entry.conversationId === conversationId));
  if (kept.length === sessions.length) return false;
  await writeSessions(kept, path);
  return true;
}

/** Forgets every conversation for this key (it keeps running on the place); true when there was one. */
export async function forgetSession(key: SessionKey, path = sessionsPath()): Promise<boolean> {
  const sessions = await loadSessions(path);
  const kept = sessions.filter((entry) => !sameKey(entry, key));
  if (kept.length === sessions.length) return false;
  await writeSessions(kept, path);
  return true;
}

function sameKey(a: SessionKey, b: SessionKey): boolean {
  return a.place === b.place && a.repository === b.repository && a.root === b.root;
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
  return ["place", "repository", "root", "conversationId", "updatedAt"].every((key) => typeof entry[key] === "string") &&
    (entry.branch === undefined || typeof entry.branch === "string");
}
