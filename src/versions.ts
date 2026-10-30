import { readFileSync } from "node:fs";

/**
 * One Autopilot version everywhere. The laptop's session client is the autopilot-ai dl
 * bundles (package.json pins it exactly), and every place dl sets up (this computer, a
 * server, the sandbox image) installs that same version, so the client and server never
 * drift. `dl update` brings a place back to it.
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

/** The exact autopilot-ai version dl ships with and installs on places. */
export function pinnedAutopilotVersion(deps: Record<string, string> | undefined = readManifest().dependencies): string {
  const pinned = deps?.["autopilot-ai"]?.trim();
  if (!pinned || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pinned)) {
    throw new Error(`package.json must pin autopilot-ai to an exact version (got ${JSON.stringify(pinned)})`);
  }
  return pinned;
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
