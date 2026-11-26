import { execFile } from "node:child_process";
import { constants, existsSync, readFileSync } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { packageRoot, scriptHomeOf } from "../install-method.js";
import { pinnedAutopilotVersion } from "../versions.js";

/** Finding the Autopilot dl runs for sessions and its provider picker: the one it bundles, else one on PATH. */

const execFileAsync = promisify(execFile);

/** How to start Autopilot: `command ...args <subcommand> …`. */
export interface AutopilotCommand {
  command: string;
  args: string[];
}

/**
 * The Autopilot dl runs (run with this Node): its own (ownAutopilot: the one dl downloaded, or
 * one Node resolves for dl), else an `autopilot` on PATH. Undefined when there's none:
 * Autopilot is optional, and `ensureAutopilot` gets it.
 */
export async function findAutopilot(env: NodeJS.ProcessEnv = process.env): Promise<AutopilotCommand | undefined> {
  const own = ownAutopilot({ env });
  if (own) return { command: process.execPath, args: [own.bin] };
  const onPath = await autopilotOnPath(env);
  return onPath ? { command: onPath, args: [] } : undefined;
}

/** Where dl downloads Autopilot when it's picked: <dl's home>/autopilot (an npm --prefix). */
export function autopilotHome(env: NodeJS.ProcessEnv = process.env, root: string = packageRoot()): string {
  return join(env.DL_HOME?.trim() || scriptHomeOf(root) || join(env.HOME || homedir(), ".directionallylocal"), "autopilot");
}

/** The downloaded Autopilot's package directory inside autopilotHome. */
export function downloadedAutopilotPackage(env: NodeJS.ProcessEnv = process.env): string {
  return join(autopilotHome(env), "lib", "node_modules", "autopilot-ai");
}

/** The downloaded Autopilot's bin script, when it's there. */
export function downloadedAutopilot(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): string | undefined {
  const dir = downloadedAutopilotPackage(env);
  const manifest = join(dir, "package.json");
  if (!exists(manifest)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { bin?: unknown };
    const bin = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin as Record<string, unknown> | undefined)?.autopilot;
    const path = typeof bin === "string" ? resolvePath(dir, bin) : undefined;
    return path && exists(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

/** The version of the Autopilot dl runs from its own files (ownAutopilot); undefined when there's none. */
export function installedAutopilotVersion(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return ownAutopilot({ env })?.version;
}

/** The downloaded Autopilot's version, from its manifest; undefined when it isn't there. */
export function downloadedAutopilotVersion(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(downloadedAutopilotPackage(env), "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

export interface OwnAutopilot {
  bin: string;
  version: string | undefined;
}

/**
 * The Autopilot dl treats as its own, in this order:
 *  1. the one dl downloaded (~/.directionallylocal/autopilot), when it's at the pin;
 *  2. one Node resolves for dl, when it's at the pin (a development checkout's node_modules);
 *  3. the downloaded one at another version (`dl update` brings it to the pin);
 *  4. a resolved one at another version, only when nothing else is there.
 * A resolved one isn't necessarily dl's: for a global `npm install -g directionallylocal`, Node
 * also finds a separately installed global autopilot-ai beside it. Ranking that one first made
 * `dl update` download the pinned Autopilot and then keep running the old global one.
 */
export function ownAutopilot(options: { env?: NodeJS.ProcessEnv; pin?: string; resolve?: (specifier: string) => string } = {}): OwnAutopilot | undefined {
  const env = options.env ?? process.env;
  let pin = options.pin;
  if (pin === undefined) {
    try {
      pin = pinnedAutopilotVersion();
    } catch {
      pin = undefined;
    }
  }
  const downloadedBin = downloadedAutopilot(env);
  const downloaded = downloadedBin ? { bin: downloadedBin, version: downloadedAutopilotVersion(env) } : undefined;
  const resolvedBin = bundledAutopilot(options.resolve);
  const resolved = resolvedBin ? { bin: resolvedBin, version: bundledAutopilotVersion(options.resolve) } : undefined;
  if (downloaded && pin !== undefined && downloaded.version === pin) return downloaded;
  if (resolved && pin !== undefined && resolved.version === pin) return resolved;
  return downloaded ?? resolved;
}

/**
 * autopilot-ai's bin script, found from where Node resolves the package for dl. Its exports
 * don't include package.json, so the entry point is resolved and its package root found above it.
 */
export function bundledAutopilot(resolve: (specifier: string) => string = (specifier) => import.meta.resolve(specifier)): string | undefined {
  for (const specifier of ["autopilot-ai/package.json", "autopilot-ai"]) {
    let dir: string;
    try {
      dir = dirname(fileURLToPath(resolve(specifier)));
    } catch {
      continue;
    }
    for (;;) {
      const manifest = join(dir, "package.json");
      if (existsSync(manifest)) {
        try {
          const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown; bin?: unknown };
          if (pkg.name === "autopilot-ai") {
            const bin = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin as Record<string, unknown> | undefined)?.autopilot;
            const path = typeof bin === "string" ? resolvePath(dir, bin) : undefined;
            return path && existsSync(path) ? path : undefined;
          }
        } catch {
          // not a readable manifest; keep looking up
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

/** The bundled Autopilot's version, from its manifest; undefined when it isn't installed. */
export function bundledAutopilotVersion(resolve?: (specifier: string) => string): string | undefined {
  const bin = bundledAutopilot(resolve);
  return bin ? manifestVersionAbove(bin) : undefined;
}

/**
 * The version of the `autopilot` on PATH (an npm global's bin links to its package), from the
 * autopilot-ai manifest above where it really is; undefined when there's none or it can't be told.
 */
export async function pathAutopilotVersion(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const onPath = await autopilotOnPath(env);
  if (!onPath) return undefined;
  try {
    return manifestVersionAbove(await realpath(onPath));
  } catch {
    return undefined;
  }
}

/** The version in the nearest autopilot-ai package.json at or above `file`'s directory. */
function manifestVersionAbove(file: string): string | undefined {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown; version?: unknown };
        if (pkg.name === "autopilot-ai") return typeof pkg.version === "string" ? pkg.version : undefined;
      } catch {
        // keep looking up
      }
    }
    if (dirname(dir) === dir) return undefined;
  }
}

export async function autopilotOnPath(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, "autopilot");
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
  }
  return undefined;
}

/** What `autopilot auth status` says: the active provider, and whether a session can start. */
export interface AutopilotAuth {
  /** The active provider's id, e.g. "directionally-local" for the free tier. */
  active: string;
  /** See `parseAuthStatus`. */
  setUp: boolean;
}

/**
 * Asks `autopilot auth status` (read-only: it lists providers and where each key comes from,
 * and starts nothing). Undefined when it can't tell (no Autopilot, an error, a slow answer,
 * output it doesn't know).
 */
export async function autopilotAuth(
  autopilot: AutopilotCommand | undefined,
  exec: (command: string, args: string[]) => Promise<string> = async (command, args) =>
    (await execFileAsync(command, args, { timeout: 5_000, env: { ...process.env, NO_COLOR: "1" } })).stdout,
): Promise<AutopilotAuth | undefined> {
  if (!autopilot) return undefined;
  const stdout = await exec(autopilot.command, [...autopilot.args, "auth", "status"]).catch(() => undefined);
  if (stdout === undefined) return undefined;
  const setUp = parseAuthStatus(stdout);
  const active = parseActiveProvider(stdout);
  return setUp === undefined || active === undefined ? undefined : { active, setUp };
}

/**
 * Whether Autopilot can start a session without asking how it should think first. False when
 * the active provider has no key and none is in the environment (first run would use that
 * one): no provider chosen yet, or the free tier not signed in. Undefined when it can't tell.
 */
export async function autopilotSetUp(
  autopilot: AutopilotCommand | undefined,
  exec?: (command: string, args: string[]) => Promise<string>,
): Promise<boolean | undefined> {
  return (await autopilotAuth(autopilot, exec))?.setUp;
}

const AUTH_ROW = /^([›> ]) (\S+) +.* · (no key needed|no key|key in \S+)\s*$/;

function authRows(stdout: string): RegExpMatchArray[] {
  return stdout.split("\n").map((line) => line.match(AUTH_ROW)).filter((row) => row !== null);
}

/** `autopilot auth status`'s rows ("› openrouter  OpenRouter (active) · no key"): set up or not, as above. */
export function parseAuthStatus(stdout: string): boolean | undefined {
  const rows = authRows(stdout);
  const active = rows.find((row) => row[1] !== " ");
  if (!active) return undefined;
  if (active[3] !== "no key") return true;
  return rows.some((row) => row[3] === "key in env");
}

/** The active provider's id in `autopilot auth status`, or undefined. */
export function parseActiveProvider(stdout: string): string | undefined {
  return authRows(stdout).find((row) => row[1] !== " ")?.[2];
}

/** An Autopilot that knows `attach-remote` lists its options (an older one prints its general help). */
export async function supportsAttachRemote(autopilot: AutopilotCommand): Promise<boolean> {
  try {
    const { stdout, stderr } = await execFileAsync(autopilot.command, [...autopilot.args, "attach-remote", "--help"], {
      timeout: 30_000,
      env: { ...process.env, NO_COLOR: "1" },
    });
    return `${stdout}${stderr}`.includes("--state-file");
  } catch {
    return false;
  }
}
