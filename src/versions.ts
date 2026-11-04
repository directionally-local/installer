import { readFileSync } from "node:fs";

/**
 * One Autopilot version and one Hotcell version everywhere. The laptop's session client is
 * the autopilot-ai dl bundles (package.json pins it exactly), and every place dl sets up
 * (this computer, a server, the sandbox image) installs that same version, so the client and
 * server never drift. Hotcell is pinned the same way: two people installing the same dl get
 * the same sandboxes, and a broken Hotcell release can't reach anyone without a dl release.
 * `dl update` brings a place back to both pins.
 *
 * Hotcell's pin is a devDependency: dl itself never loads Hotcell, it installs `hotcell@<pin>`
 * into a place's own release directory when a sandbox or server is set up (dl up, dl setup,
 * dl run). As a devDependency it stays exact and Dependabot still bumps it, but installing
 * dl (the one-line install on a laptop, or `npm install -g`) no longer downloads Hotcell's
 * daemon and its Docker client, which plain Autopilot on a laptop never uses.
 *
 * For testing unpublished builds, DL_AUTOPILOT_SPEC and DL_HOTCELL_SPEC name an npm spec
 * or a path to a .tgz (several, separated by spaces, when a package needs sibling tarballs)
 * to install instead of `autopilot-ai@<version>` / `hotcell@<version>`.
 */

interface Manifest {
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

let manifest: Manifest | undefined;

function readManifest(): Manifest {
  manifest ??= JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Manifest;
  return manifest;
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** The exact version package.json pins `name` to; a range would let places drift. */
function pinnedVersion(name: string, deps: Record<string, string> | undefined): string {
  const pinned = deps?.[name]?.trim();
  if (!pinned || !EXACT_VERSION.test(pinned)) {
    throw new Error(`package.json must pin ${name} to an exact version (got ${JSON.stringify(pinned)})`);
  }
  return pinned;
}

/** The exact autopilot-ai version dl ships with and installs on places. */
export function pinnedAutopilotVersion(deps: Record<string, string> | undefined = readManifest().dependencies): string {
  return pinnedVersion("autopilot-ai", deps);
}

/** The exact hotcell version dl ships with and installs on places. */
export function pinnedHotcellVersion(deps: Record<string, string> | undefined = readManifest().devDependencies): string {
  return pinnedVersion("hotcell", deps);
}

/** dl's own version, for `dl --version` and the update hint. */
export function dlVersion(): string {
  return readManifest().version;
}

export interface PackageSpecs {
  /** What `npm install` / `npm pack` get for Autopilot: `autopilot-ai@3.0.2`, or DL_AUTOPILOT_SPEC. */
  autopilot: string;
  hotcell: string;
  /** Labels for the release directory and image tag: the version, or "dev" for an override. */
  autopilotLabel: string;
  hotcellLabel: string;
  /** An override is in play, so nothing can be assumed already installed or built. */
  dev: boolean;
}

export function packageSpecs(versions: { autopilot: string; hotcell: string }, env: NodeJS.ProcessEnv = process.env): PackageSpecs {
  const autopilotOverride = env.DL_AUTOPILOT_SPEC?.trim();
  const hotcellOverride = env.DL_HOTCELL_SPEC?.trim();
  return {
    autopilot: autopilotOverride || `autopilot-ai@${versions.autopilot}`,
    hotcell: hotcellOverride || `hotcell@${versions.hotcell}`,
    autopilotLabel: autopilotOverride ? "dev" : versions.autopilot,
    hotcellLabel: hotcellOverride ? "dev" : versions.hotcell,
    dev: Boolean(autopilotOverride || hotcellOverride),
  };
}

/** A place's version next to the pin: `0.1.38`, or `0.1.30 → 0.1.38` when it's behind. */
export function versionAgainstPin(installed: string, pinned: string): string {
  return installed === pinned ? installed : `${installed} → ${pinned}`;
}

/** The version an installed package reports, for the state file when a dev spec was installed. */
export function installedVersion(manifestText: string | undefined, fallback: string): string {
  if (!manifestText) return fallback;
  try {
    const version = (JSON.parse(manifestText) as { version?: unknown }).version;
    return typeof version === "string" && version.trim() ? version.trim() : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Semver precedence (semver.org §11): -1, 0 or 1. `1.0.0-rc.1` comes before `1.0.0`, numeric
 * pre-release parts compare as numbers and before alphanumeric ones, and build metadata
 * (`+…`) is ignored. A leading "v" is allowed. Throws on anything that isn't a version.
 */
export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (let index = 0; index < 3; index++) {
    if (left.core[index]! !== right.core[index]!) return left.core[index]! < right.core[index]! ? -1 : 1;
  }
  // A version without a pre-release is newer than the same version with one.
  if (left.pre.length === 0 && right.pre.length === 0) return 0;
  if (left.pre.length === 0) return 1;
  if (right.pre.length === 0) return -1;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index++) {
    const x = left.pre[index];
    const y = right.pre[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseSemver(version: string): { core: [bigint, bigint, bigint]; pre: string[] } {
  const match = SEMVER.exec(version.trim());
  if (!match) throw new Error(`Not a version: ${JSON.stringify(version)}`);
  return { core: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)], pre: match[4] ? match[4].split(".") : [] };
}
