import { PATHS } from "./layout.js";
import type { System } from "./system.js";

/**
 * tailscale: private HTTPS on the tailnet. loopback: no exposure; reach it over an SSH tunnel.
 * ssh: like loopback, but set up from the laptop, which keeps its own SSH tunnel to it.
 */
export type AccessMode = "tailscale" | "loopback" | "ssh";

export const ACCESS_MODES: readonly AccessMode[] = ["tailscale", "loopback", "ssh"];

/** How people reach this server, in words (the address alone means little for a tunnel). */
export function describeAccess(access: InstallState["access"]): string {
  return access.mode === "ssh" ? "over SSH from your laptop" : access.url;
}

/** What `up` installed, so `doctor`, `status`, and `uninstall` know what's there. */
export interface InstallState {
  version: 1;
  installedAt: string;
  updatedAt: string;
  release: string;
  autopilotVersion: string;
  hotcellVersion: string;
  image: string;
  access: { mode: AccessMode; url: string };
}

export async function readState(system: System): Promise<InstallState | undefined> {
  const raw = await system.readFile(PATHS.state);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as InstallState;
    return parsed.version === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function writeState(system: System, state: InstallState): Promise<void> {
  // Readable by everyone: versions and the address aren't secret, and any login can see the
  // status. Secrets in this directory (a Tailscale key, briefly) are written 0600.
  await system.mkdir(PATHS.stateDir, { mode: 0o755 });
  await system.writeFile(PATHS.state, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o644 });
}
