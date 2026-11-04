import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { autopilotConfigFile, FREE_TIER_PROVIDER } from "./free-tier.js";

/**
 * The referral from an invite link (`curl -fsSL https://dl.new/r/<code> | sh`), kept until the
 * free tier sign-in that credits it.
 *
 * The link's script exports DL_REFERRAL=<code> for the install script, which passes it to dl,
 * which passes it to plain Autopilot; Autopilot sends it with its free tier sign-in. Many
 * people sign in on a later run, started without the variable, so the first code dl sees is
 * also kept in dl's state (~/.config/directionallylocal/pending-referral, one line; the install
 * script writes the same file). dl exports it to Autopilot from there on every run until
 * Autopilot's config holds a free tier refresh token (the sign-in succeeded), then deletes it.
 *
 * A code is a GitHub login, lowercased. Anything else is ignored, never kept or passed on.
 * Nothing here ever fails a session: a file that can't be read or written only loses the referral.
 */

export const REFERRAL_ENV = "DL_REFERRAL";
const CODE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;

type Env = Record<string, string | undefined>;

/** The code in the form the service uses (lowercase), or undefined when it isn't a GitHub login. */
export function normalizeReferral(raw: string | undefined): string | undefined {
  const code = raw?.trim().toLowerCase();
  return code && CODE.test(code) ? code : undefined;
}

/** dl's own state file for the pending referral: next to its config.json. */
export function pendingReferralPath(env: Env = process.env): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(env.HOME || homedir(), ".config");
  return join(configHome, "directionallylocal", "pending-referral");
}

export interface ReferralOptions {
  env?: Env;
  /** The pending-referral file; pendingReferralPath(env) unless replaced. */
  path?: string;
  /** Autopilot's config.json; autopilotConfigFile(env) unless replaced. */
  autopilotConfig?: string;
}

/** Whether Autopilot's config holds a free tier refresh token: the free tier sign-in succeeded. */
export async function freeTierSignedIn(options: ReferralOptions = {}): Promise<boolean> {
  const env = options.env ?? process.env;
  try {
    const text = await readFile(options.autopilotConfig ?? autopilotConfigFile(env), "utf8");
    const saved = (JSON.parse(text) as { providers?: Record<string, { refreshToken?: unknown } | undefined> }).providers?.[FREE_TIER_PROVIDER];
    return typeof saved?.refreshToken === "string" && saved.refreshToken.trim() !== "";
  } catch {
    return false;
  }
}

export async function readPendingReferral(path: string): Promise<string | undefined> {
  return normalizeReferral(await readFile(path, "utf8").catch(() => undefined));
}

async function writePendingReferral(code: string, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${code}\n`, { mode: 0o600 });
  await rename(temp, path);
}

/**
 * The referral to give Autopilot on this run, keeping state on the way:
 * - signed in to the free tier already: the pending one is done with and deleted; a code in
 *   DL_REFERRAL is still passed on as given (Autopilot decides what it means then).
 * - DL_REFERRAL holds a code: passed on, and kept as the pending one unless one is kept already
 *   (the first link someone installed from is the one that's credited on a later run).
 * - otherwise the pending one, if any.
 */
export async function referralForAutopilot(options: ReferralOptions = {}): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const path = options.path ?? pendingReferralPath(env);
  const fromEnv = normalizeReferral(env[REFERRAL_ENV]);
  try {
    if (await freeTierSignedIn(options)) {
      await rm(path, { force: true });
      return fromEnv;
    }
    const pending = await readPendingReferral(path);
    if (fromEnv && !pending) await writePendingReferral(fromEnv, path);
    return fromEnv ?? pending;
  } catch {
    return fromEnv;
  }
}

/** After Autopilot exits: once the free tier sign-in has succeeded, the pending referral is deleted. */
export async function settleReferral(options: ReferralOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  try {
    if (await freeTierSignedIn(options)) await rm(options.path ?? pendingReferralPath(env), { force: true });
  } catch {
    // Kept for the next run, which checks again.
  }
}

/** The environment for plain Autopilot: DL_REFERRAL set to the code, or removed when there's none. */
export function withReferral(env: NodeJS.ProcessEnv, code: string | undefined): NodeJS.ProcessEnv {
  const { [REFERRAL_ENV]: _dropped, ...rest } = env;
  return code ? { ...rest, [REFERRAL_ENV]: code } : rest;
}
