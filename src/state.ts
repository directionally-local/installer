import { PATHS } from "./layout.js";
import type { System } from "./system.js";

/** tailscale: private HTTPS on the tailnet. loopback: no exposure; reach it over an SSH tunnel. */
export type AccessMode = "tailscale" | "loopback";

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
  await system.mkdir(PATHS.stateDir, { mode: 0o700 });
  await system.writeFile(PATHS.state, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}
