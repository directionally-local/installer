import { chmod, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DlKey } from "./dl-key.js";

/**
 * The Autopilot key: what dl hands the Autopilot it launches instead of the person's dl key.
 *
 * The service serves GPT-6 (and the paid plans' GPT-6.1 Sol launch bonus) in Autopilot only. A dl
 * key (`dl_sk_`) works in any tool, so the service treats it as a tool key: no GPT-6. When dl
 * launches Autopilot it trades the dl key for an Autopilot key (`dl_ak_`, POST /v1/autopilot-keys)
 * that only that Autopilot gets, and the service counts its requests as Autopilot's.
 *
 * - It lasts 15 minutes from when it was made or last refreshed. dl refreshes it with the dl key
 *   while Autopilot runs (the key can't refresh itself), and revokes it when Autopilot exits, so a
 *   copy taken out of Autopilot's environment dies within 15 minutes of dl stopping.
 * - A refresh never revives an expired key (after the computer slept, say): dl mints a new one
 *   and writes it to the key file (AUTOPILOT_DL_FREE_TOKEN_FILE, mode 0600 in a private
 *   directory). Autopilot reads its key from that file, and after a 401 it reads it again, so it
 *   picks the new key up without a restart.
 * - When the key can't be made (an older service, no network, an Autopilot too old to read it),
 *   Autopilot gets the dl key as before: everything works, without GPT-6.
 */

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type Env = Record<string, string>;

/** The env var naming the file that holds Autopilot's current key (Autopilot re-reads it after a 401). */
export const AUTOPILOT_KEY_FILE_ENV = "AUTOPILOT_DL_FREE_TOKEN_FILE";
/** The first Autopilot that reads an Autopilot key (`dl_ak_`) and its key file. */
export const AUTOPILOT_KEY_MIN_VERSION = "3.35.0";
/** dl checks this often whether a refresh is due (so a refresh follows soon after the computer wakes). */
export const CHECK_EVERY_MS = 30_000;
/** A refresh is due this long after the last one that worked (the key lasts 15 minutes). */
export const REFRESH_AFTER_MS = 4 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const REVOKE_DEADLINE_MS = 3_000;

export interface AutopilotKeyDeps {
  fetch?: Fetch;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
  clearInterval?: (timer: unknown) => void;
  /** The private directory the key file goes in; a new one under the system temp dir unless replaced. */
  makeDir?: () => Promise<string>;
}

export interface AutopilotKeySession {
  /** For Autopilot's environment: AUTOPILOT_DL_FREE_TOKEN (the key) and AUTOPILOT_DL_FREE_TOKEN_FILE. */
  env: Env;
  /** The key Autopilot has now (changes when dl had to mint a new one). */
  current: () => string;
  /** One refresh check now (what the timer runs); resolves when it is done. */
  tick: () => Promise<void>;
  /** Stops refreshing, revokes the key (bounded) and removes the key file. */
  stop: () => Promise<void>;
}

/** `a` is at least `b` (x.y.z; a pre-release suffix is ignored). */
export function versionAtLeast(a: string, b: string): boolean {
  const parse = (version: string) => version.replace(/^v/, "").split(/[.+-]/).slice(0, 3).map((part) => Number(part) || 0);
  const [left, right] = [parse(a), parse(b)];
  for (let index = 0; index < 3; index++) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) > (right[index] ?? 0);
  }
  return true;
}

/** Whether the Autopilot dl is about to run reads an Autopilot key; false when its version is unknown. */
export function autopilotReadsKey(version: string | undefined): boolean {
  return version !== undefined && versionAtLeast(version, AUTOPILOT_KEY_MIN_VERSION);
}

interface Minted {
  id: string;
  key: string;
}

async function mint(call: Fetch, dlKey: DlKey): Promise<Minted | undefined> {
  try {
    const response = await call(`${dlKey.baseUrl}/v1/autopilot-keys`, {
      method: "POST",
      headers: { accept: "application/json", authorization: `Bearer ${dlKey.key}` },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status !== 201) return undefined;
    const body = (await response.json().catch(() => undefined)) as { id?: unknown; key?: unknown } | undefined;
    return typeof body?.id === "string" && typeof body.key === "string" && body.key.startsWith("dl_ak_") ? { id: body.id, key: body.key } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Mints the Autopilot key from `dlKey` and starts refreshing it; undefined when it can't be made
 * (Autopilot then gets the dl key). The caller runs Autopilot with `env` and calls `stop` after.
 */
export async function startAutopilotKey(dlKey: DlKey, deps: AutopilotKeyDeps = {}): Promise<AutopilotKeySession | undefined> {
  const call: Fetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? Date.now;
  let minted = await mint(call, dlKey);
  if (!minted) return undefined;
  let dir: string;
  try {
    dir = await (deps.makeDir ?? (() => mkdtemp(join(tmpdir(), "dl-autopilot-"))))();
    await chmod(dir, 0o700);
  } catch {
    await revoke(call, dlKey, minted.id);
    return undefined;
  }
  const file = join(dir, "key");
  const write = async (key: string) => {
    // Written beside and renamed, so Autopilot never reads half a key.
    const next = join(dir, `key.${process.pid}.tmp`);
    await writeFile(next, key, { mode: 0o600 });
    await rename(next, file);
  };
  try {
    await write(minted.key);
  } catch {
    await revoke(call, dlKey, minted.id);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return undefined;
  }

  let lastOk = now();
  let running: Promise<void> | undefined;
  let stopped = false;
  const check = async () => {
    if (stopped || now() - lastOk < REFRESH_AFTER_MS) return;
    const current = minted!;
    let status: number | undefined;
    try {
      const response = await call(`${dlKey.baseUrl}/v1/autopilot-keys/${current.id}/refresh`, {
        method: "POST",
        headers: { accept: "application/json", authorization: `Bearer ${dlKey.key}` },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = response.status;
      await response.body?.cancel().catch(() => undefined);
    } catch {
      return; // offline: try again on the next check
    }
    if (stopped) return;
    if (status === 200) {
      lastOk = now();
      return;
    }
    if (status !== 404) return; // a passing refusal (rate limit, the service busy): next check
    // Expired (the computer slept past it) or revoked: a new key, in the file for Autopilot.
    const fresh = await mint(call, dlKey);
    if (!fresh || stopped) {
      if (fresh) await revoke(call, dlKey, fresh.id);
      return;
    }
    minted = fresh;
    lastOk = now();
    await write(fresh.key).catch(() => undefined);
  };
  const tick = () => (running ??= check().finally(() => (running = undefined)));
  const every = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clear = deps.clearInterval ?? ((timer: unknown) => clearInterval(timer as NodeJS.Timeout));
  const timer = every(() => void tick(), CHECK_EVERY_MS);
  timer.unref?.();

  return {
    env: { AUTOPILOT_DL_FREE_TOKEN: minted.key, [AUTOPILOT_KEY_FILE_ENV]: file },
    current: () => minted!.key,
    tick,
    stop: async () => {
      stopped = true;
      clear(timer);
      await running?.catch(() => undefined);
      await Promise.race([revoke(call, dlKey, minted!.id), new Promise((resolve) => setTimeout(resolve, REVOKE_DEADLINE_MS).unref?.())]);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

async function revoke(call: Fetch, dlKey: DlKey, id: string): Promise<void> {
  try {
    const response = await call(`${dlKey.baseUrl}/v1/autopilot-keys/${id}`, {
      method: "DELETE",
      headers: { accept: "application/json", authorization: `Bearer ${dlKey.key}` },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
  } catch {
    // Best effort: it expires by itself within 15 minutes.
  }
}

/**
 * Runs Autopilot (`run`) on the dl key: with an Autopilot key when the Autopilot dl runs reads one
 * (`autopilotVersion`) and the service makes one, else on the dl key itself. `env` is the
 * environment Autopilot inherits (process.env): AUTOPILOT_DL_FREE_TOKEN is set to the key it
 * gets, and AUTOPILOT_DL_FREE_TOKEN_FILE set or removed to match. The key is revoked afterwards.
 */
export async function withAutopilotKey<T>(
  dlKey: DlKey,
  autopilotVersion: string | undefined,
  env: Record<string, string | undefined>,
  run: () => Promise<T>,
  deps: AutopilotKeyDeps & { start?: typeof startAutopilotKey } = {},
): Promise<T> {
  const session = autopilotReadsKey(autopilotVersion) ? await (deps.start ?? startAutopilotKey)(dlKey, deps) : undefined;
  if (session) {
    Object.assign(env, session.env);
  } else {
    env.AUTOPILOT_DL_FREE_TOKEN = dlKey.key;
    delete env[AUTOPILOT_KEY_FILE_ENV];
  }
  try {
    return await run();
  } finally {
    await session?.stop();
  }
}
