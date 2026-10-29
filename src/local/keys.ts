/**
 * `dl keys` for "on this computer": the same as on a server, in the user's home. The
 * OpenRouter key goes to Hotcell's 0600 file keystore over stdin (HOTCELL_KEYSTORE=file,
 * see setup.ts for why not the Keychain), the GitHub token to the 0600 github.env, and
 * the service that reads it (a LaunchAgent or a systemd user unit) restarts.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { checkKey, githubListing, hotcellKeyListed, KeyRejectedError, type KeyListing, type KeyName, type KeyResult } from "../keys.js";
import { RealSystem, type System } from "../system.js";
import { supportedPlatform } from "./check.js";
import { LOCAL_SERVICES, localGithubEnv, localHotcellBin, localPaths, parseLocalEnvFile, serviceFile, type LocalPaths, type LocalPlatform, type LocalService } from "./layout.js";
import { httpStatus } from "./probes.js";
import { userId } from "./services.js";
import { hotcellCliEnv, type LocalOptions } from "./setup.js";
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
  const platform = supportedPlatform(options.platform ?? process.platform);
  if (!platform) throw new Error("Agents run on this computer only on macOS and Linux.");
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
  const ctx = await installed(options);
  const { system, paths, state, node } = ctx;
  const uid = await userId(system);

  if (which === "openrouter") {
    await system.run(node, [localHotcellBin(paths), "keys", "add", "openrouter", "--stdin"], {
      input: key,
      env: hotcellCliEnv(paths),
      describe: "hotcell keys add openrouter --stdin",
    });
    await restartService(ctx, uid, "hotcell");
    await waitUntil(ctx, "Hotcell", async () => await httpStatus(system, node, `http://127.0.0.1:${state.ports.hotcell}/`) > 0);
    return { ok: true, key: which, detail: "replaced in Hotcell; Hotcell restarted" };
  }

  await system.writeFile(paths.githubEnv, localGithubEnv(key), { mode: 0o600, secret: true });
  await restartService(ctx, uid, "autopilot");
  // Without a token the Aster API answers 401: up, and refusing strangers.
  await waitUntil(ctx, "Autopilot", async () => await httpStatus(system, node, `${state.url}/api/v1/health`) === 401);
  return { ok: true, key: which, detail: `${checked.detail ? `${checked.detail}; ` : ""}Autopilot restarted` };
}

/** Which keys this computer's install has; never their values. */
export async function listLocalKeys(options: LocalKeyOptions = {}): Promise<KeyListing[]> {
  const { system, paths, node } = await installed(options);
  let openrouter: KeyListing = { key: "openrouter", set: false };
  if (await system.exists(localHotcellBin(paths))) {
    const listed = await system.probe(node, [localHotcellBin(paths), "keys", "ls"], { env: { ...hotcellCliEnv(paths), NO_COLOR: "1" } });
    if (listed.code === 0) openrouter = { key: "openrouter", ...hotcellKeyListed(listed.stdout, "openrouter") };
  }
  const token = parseLocalEnvFile(await system.readFile(paths.githubEnv)).GITHUB_TOKEN;
  return [openrouter, await githubListing(token, options.fetchImpl)];
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
