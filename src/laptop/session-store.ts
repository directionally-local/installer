import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Which conversation `dl` reopens here: one per place + repository + local checkout for a
 * project (so two clones of the same repository, or the same one on two places, each keep
 * their own), and one per place + directory for a chat outside a project. Only IDs live
 * here (no tokens), but it's private like the rest of the laptop's config.
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

export async function findSession(key: SessionKey, path = sessionsPath()): Promise<SessionEntry | undefined> {
  return (await loadSessions(path)).find((entry) => sameKey(entry, key));
}

/** Remembers (or replaces) the conversation for this place + repository + checkout. */
export async function rememberSession(entry: Omit<SessionEntry, "updatedAt">, path = sessionsPath()): Promise<void> {
  const kept = (await loadSessions(path)).filter((existing) => !sameKey(existing, entry));
  kept.push({ ...entry, updatedAt: new Date().toISOString() });
  await writeSessions(kept, path);
}

/** Forgets this key's conversation (it keeps running on the place); true when there was one. */
export async function forgetSession(key: SessionKey, path = sessionsPath()): Promise<boolean> {
  const sessions = await loadSessions(path);
  const kept = sessions.filter((entry) => !sameKey(entry, key));
  if (kept.length === sessions.length) return false;
  await writeSessions(kept, path);
  return true;
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
