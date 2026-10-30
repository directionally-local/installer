import { PAIRED_NAME } from "../local/layout.js";
import { describeProvider, providerAnswer, type ConnectResult, type ProviderAnswer } from "../provider.js";
import { palette } from "../ui.js";
import { ConnectCancelled } from "./connect.js";
import type { RemoteClient } from "./client.js";
import type { RemoteServer } from "./config.js";
import { saveModel } from "./settings.js";

/**
 * A place with no provider can't serve a turn: its /models is the default catalog
 * (OpenRouter's), and every turn fails on a key it doesn't have. Before a session opens on
 * a place, dl checks that it has one, and if not runs Autopilot's picker and pushes the key
 * the way setup does — so a place set up by an older dl, or one whose first run was
 * interrupted before the picker, still works instead of opening a session that can't run.
 */

export interface PlaceProviderDeps {
  /** Autopilot's provider picker (`autopilot connect`); the real one unless replaced. */
  connect: (options: { modelOnly?: boolean }) => Promise<ConnectResult>;
  /** "This computer": whether its provider's Hotcell route is active, and how to store a new one. */
  local: {
    ready: () => Promise<boolean | undefined>;
    configure: (answers: { provider: ProviderAnswer }) => Promise<void>;
  };
  settingsFile?: string;
  write: (text: string) => void;
  color: boolean;
}

/**
 * Whether the place has a provider it can serve from. undefined when it can't be told: an
 * older server's /models names no provider. Only this computer can be checked from here
 * (Hotcell's routes say whether the key is there); a server's /models naming a provider is
 * taken as its word.
 */
export async function placeHasProvider(remote: RemoteServer, client: RemoteClient, deps: PlaceProviderDeps): Promise<boolean | undefined> {
  const catalog = await client.catalog();
  if (!catalog.provider) return undefined;
  if (remote.name !== PAIRED_NAME) return true;
  return await deps.local.ready();
}

/**
 * Makes sure the place has a provider before a session opens on it. Returns false when the
 * user backed out of the picker, so the caller stops quietly as setup does.
 */
export async function ensurePlaceProvider(remote: RemoteServer, client: RemoteClient, deps: PlaceProviderDeps): Promise<boolean> {
  const has = await placeHasProvider(remote, client, deps).catch(() => undefined);
  if (has !== false) return true;
  const c = palette(deps.color);
  deps.write(`  ${c.yellow("!")} this computer has no model provider yet\n`);
  let chosen: ConnectResult;
  try {
    chosen = await deps.connect({});
  } catch (error) {
    if (error instanceof ConnectCancelled) return false;
    throw error;
  }
  await saveModel(chosen.model, deps.settingsFile, remote.name);
  await deps.local.configure({ provider: providerAnswer(chosen) });
  deps.write(`  ${c.green("✓")} ${describeProvider({ id: chosen.provider, name: chosen.name }, chosen.model)} · key stays on this computer\n`);
  return true;
}
