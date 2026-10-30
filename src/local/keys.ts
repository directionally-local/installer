/**
 * `dl provider` / `dl keys` for "on this computer": the same as on a server, in the user's
 * home. The provider's key goes to Hotcell's 0600 file keystore over stdin
 * (HOTCELL_KEYSTORE=file, see setup.ts for why not the Keychain) and the provider into
 * aster.json; the GitHub token goes to the 0600 github.env; and the service that reads each
 * (a LaunchAgent or a systemd user unit) restarts.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { checkKey, GITHUB, githubListing, KeyRejectedError, type KeyListing, type KeyName, type KeyResult } from "../keys.js";
import { asterConfigWithProvider, KNOWN_PROVIDERS, parseProviderAnswer, providerConfig, providerFromAsterConfig, type ProviderAnswer } from "../provider.js";
import { RealSystem, type System } from "../system.js";
import { localUnsupported, supportedPlatform } from "./check.js";
import { LOCAL_SERVICES, localAsterDefaults, localGithubEnv, localPaths, parseLocalEnvFile, serviceFile, type LocalPaths, type LocalPlatform, type LocalService } from "./layout.js";
import { httpStatus } from "./probes.js";
import { userId } from "./services.js";
import { localHotcellRoutes, storeProviderKey, type LocalOptions } from "./setup.js";
import { readLocalState, type LocalState } from "./state.js";

export interface LocalKeyOptions extends LocalOptions {
  /** Checks the key with OpenRouter / GitHub first; undefined checks only its format. */
  fetchImpl?: typeof fetch;
}

interface Installed {
  system: System;
  home: string;
  platform: LocalPlatform;
  paths: LocalPaths;
  state: LocalState;
  node: string;
  sleep: (ms: number) => Promise<void>;
}

async function installed(options: LocalOptions): Promise<Installed> {
  const home = options.home ?? homedir();
  const raw = options.platform ?? process.platform;
  const platform = supportedPlatform(raw);
  if (!platform) throw new Error(localUnsupported(raw));
  const system = options.system ?? new RealSystem(() => {});
  const paths = localPaths(home, platform);
  const state = await readLocalState(system, paths);
  if (!state) throw new Error("Directionally Local isn't set up on this computer; run dl setup.");
  return {
    system,
    home,
    platform,
    paths,
    state,
    node: options.execPath ?? process.execPath,
    sleep: options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

/** Stores the key where setup does, restarts the service that reads it, and waits for it to answer. */
export async function setLocalKey(which: KeyName, value: string, options: LocalKeyOptions = {}): Promise<KeyResult> {
  const key = value.trim();
  const checked = await checkKey(which, key, options.fetchImpl);
  if (checked.problem) throw new KeyRejectedError(checked.problem);
  if (which !== GITHUB) {
    if (!KNOWN_PROVIDERS[which]) throw new KeyRejectedError(`dl doesn't know where ${which} lives; pick it in Autopilot's list instead: dl provider set`);
    await configureThisComputer({ provider: parseProviderAnswer({ id: which, ...(key ? { apiKey: key } : {}) }) }, options);
    return { ok: true, key: which, detail: `${which} in Hotcell; Hotcell and Autopilot restarted` };
  }
  await configureThisComputer({ githubToken: key }, options);
  return { ok: true, key: which, detail: `${checked.detail ? `${checked.detail}; ` : ""}Autopilot restarted` };
}

/**
 * Stores what the wizard gathered after the services started: the provider's key into
 * Hotcell and the provider into aster.json, the GitHub token into github.env; then restarts
 * what reads each (Hotcell for the key, Autopilot for both files) and waits for them.
 */
export async function configureThisComputer(answers: { provider?: ProviderAnswer; githubToken?: string }, options: LocalOptions = {}): Promise<void> {
  const ctx = await installed(options);
  const { system, paths, state, node } = ctx;
  const uid = await userId(system);
  if (answers.provider) {
    await storeProviderKey(system, node, paths, answers.provider);
    await system.writeFile(paths.asterConfig, asterConfigWithProvider(await system.readFile(paths.asterConfig), providerConfig(answers.provider), localAsterDefaults(paths)), { mode: 0o600 });
    await restartService(ctx, uid, "hotcell");
    await waitUntil(ctx, "Hotcell", async () => await httpStatus(system, node, `http://127.0.0.1:${state.ports.hotcell}/`) > 0);
  }
  if (answers.githubToken !== undefined) await system.writeFile(paths.githubEnv, localGithubEnv(answers.githubToken.trim()), { mode: 0o600, secret: true });
  if (answers.provider || answers.githubToken !== undefined) {
    await restartService(ctx, uid, "autopilot");
    // Without a token the Aster API answers 401: up, and refusing strangers.
    await waitUntil(ctx, "Autopilot", async () => await httpStatus(system, node, `${state.url}/api/v1/health`) === 401);
  }
}

/** Which keys this computer's install has; never their values. */
export async function listLocalKeys(options: LocalKeyOptions = {}): Promise<KeyListing[]> {
  const { system, paths, node } = await installed(options);
  const provider = providerFromAsterConfig(await system.readFile(paths.asterConfig));
  const route = (await localHotcellRoutes(system, node, paths)).find((entry) => entry.provider === provider.id);
  const listing: KeyListing = route?.active
    ? { key: "provider", set: true, detail: route.mask ? `${provider.id} · ${route.mask}` : provider.id }
    : { key: "provider", set: false, ...(route ? { detail: provider.id, problem: `${provider.id}'s route is off in Hotcell` } : {}) };
  const token = parseLocalEnvFile(await system.readFile(paths.githubEnv)).GITHUB_TOKEN;
  return [listing, await githubListing(token, options.fetchImpl)];
}

/** The provider this computer uses, as aster.json names it (OpenRouter when it names none). */
export async function localProvider(options: LocalOptions = {}): Promise<{ id: string; model?: string }> {
  const { system, paths } = await installed(options);
  return { id: providerFromAsterConfig(await system.readFile(paths.asterConfig)).id };
}

/**
 * Restarts one service so it reads its keys again: `launchctl kickstart -k` on macOS (or
 * bootstrap, when it isn't loaded), `systemctl --user restart` on Linux.
 */
async function restartService(ctx: Installed, uid: string, service: LocalService): Promise<void> {
  const { system, platform, paths } = ctx;
  if (platform === "darwin") {
    const restarted = await system.run("launchctl", ["kickstart", "-k", `gui/${uid}/${LOCAL_SERVICES[service].label}`], { allowFailure: true });
    if (restarted.code === 0) return;
    const file = serviceFile(paths, platform, service);
    if (!(await system.exists(file))) throw new Error(`The ${service} service isn't installed on this computer; run dl setup to repair it.`);
    await system.run("launchctl", ["bootstrap", `gui/${uid}`, file]);
    return;
  }
  await system.run("systemctl", ["--user", "restart", LOCAL_SERVICES[service].unit]);
}

async function waitUntil(ctx: Installed, what: string, ready: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await ready()) return;
    await ctx.sleep(1_000);
  }
  const log = join(ctx.paths.logs, LOCAL_SERVICES[what === "Hotcell" ? "hotcell" : "autopilot"].log);
  throw new Error(`${what} didn't come back up; see ${log.startsWith(`${ctx.home}/`) ? `~${log.slice(ctx.home.length)}` : log}`);
}
