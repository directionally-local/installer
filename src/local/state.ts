import type { System } from "../system.js";
import type { LocalPaths, LocalPlatform, LocalPorts } from "./layout.js";

/** What setup installed on this computer, so status and uninstall know what's there. No secrets. */
export interface LocalState {
  version: 1;
  kind: "this-computer";
  platform: LocalPlatform;
  installedAt: string;
  updatedAt: string;
  release: string;
  autopilotVersion: string;
  hotcellVersion: string;
  image: string;
  url: string;
  ports: LocalPorts;
  dockerHost: string;
  dockerRuntime: string;
}

export async function readLocalState(system: System, paths: LocalPaths): Promise<LocalState | undefined> {
  const raw = await system.readFile(paths.state);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as LocalState;
    return parsed.version === 1 && parsed.kind === "this-computer" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function writeLocalState(system: System, paths: LocalPaths, state: LocalState): Promise<void> {
  await system.writeFile(paths.state, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}
