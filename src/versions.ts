import { readFileSync } from "node:fs";

/**
 * One Autopilot version and one Hotcell version everywhere. The laptop's session client is
 * the autopilot-ai dl bundles (package.json pins it exactly), and every place dl sets up
 * (this computer, a server, the sandbox image) installs that same version, so the client and
 * server never drift. Hotcell is pinned the same way: two people installing the same dl get
 * the same sandboxes, and a broken Hotcell release can't reach anyone without a dl release.
 * `dl update` brings a place back to both pins.
 *
 * For testing unpublished builds, DL_AUTOPILOT_SPEC and DL_HOTCELL_SPEC name an npm spec
 * or a path to a .tgz (several, separated by spaces, when a package needs sibling tarballs)
 * to install instead of `autopilot-ai@<version>` / `hotcell@<version>`.
 */

interface Manifest {
  version: string;
  dependencies?: Record<string, string>;
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
export function pinnedHotcellVersion(deps: Record<string, string> | undefined = readManifest().dependencies): string {
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
