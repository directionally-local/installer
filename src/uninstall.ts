import { AUTOPILOT_PORT, NODE_AUTO_UPDATES, PATHS, SERVICES, USERS } from "./layout.js";
import { readState } from "./state.js";
import type { System } from "./system.js";

export interface UninstallOptions {
  /** Also delete configuration, secrets, data, the service accounts, and the sandbox image. */
  purge?: boolean;
}

/**
 * `directionally-local uninstall`: stops and removes every service and the installed
 * software. Data and secrets stay unless --purge, so a later `up` picks up where it was.
 * Docker and Tailscale stay installed; Tailscale only stops serving Autopilot.
 */
export async function uninstall(system: System, options: UninstallOptions = {}): Promise<void> {
  const say = (line: string) => system.log(line);
  const state = await readState(system);

  say("== Services");
  for (const service of [SERVICES.autopilot, SERVICES.hotcell, SERVICES.metadataBlock]) {
    await system.run("systemctl", ["disable", "--now", service], { allowFailure: true });
    await system.remove(`${PATHS.units}/${service}`);
  }
  await system.run("systemctl", ["daemon-reload"]);
  await system.run("systemctl", ["reset-failed"], { allowFailure: true });

  if (state?.access.mode === "tailscale" || (await system.probe("tailscale", ["version"])).code === 0) {
    say("== Tailscale");
    await system.run("tailscale", ["serve", "--https=443", `http://127.0.0.1:${AUTOPILOT_PORT}`, "off"], { allowFailure: true });
  }

  say("== Sandboxes and software");
  // Hotcell's sandboxes are labeled; remove any left running so nothing keeps the box busy.
  const containers = (await system.probe("docker", ["ps", "-aq", "--filter", "label=sbx.managed=true"])).stdout.split("\n").filter(Boolean);
  if (containers.length > 0) await system.run("docker", ["rm", "-f", ...containers], { allowFailure: true });
  await system.remove(PATHS.root);
  // Node.js stays installed, and so do Ubuntu's own automatic updates; only our addition goes.
  await system.remove(NODE_AUTO_UPDATES);

  if (!options.purge) {
    say(`Removed the services and software. Kept configuration and data (${PATHS.stateDir}, ${PATHS.autopilotEtc}, ${PATHS.hotcellEtc}, /var/lib/{autopilot,hotcell}); --purge deletes them.`);
    return;
  }
  say("== Configuration, data, and accounts (--purge)");
  if (state?.image) await system.run("docker", ["image", "rm", state.image], { allowFailure: true });
  const volumes = (await system.probe("docker", ["volume", "ls", "-q", "--filter", "label=sbx.managed=true"])).stdout.split("\n").filter(Boolean);
  if (volumes.length > 0) await system.run("docker", ["volume", "rm", ...volumes], { allowFailure: true });
  for (const path of [PATHS.stateDir, PATHS.autopilotEtc, PATHS.hotcellEtc, PATHS.autopilotHome, PATHS.hotcellHome]) await system.remove(path);
  for (const user of [USERS.autopilot, USERS.hotcell]) {
    if ((await system.probe("id", ["-u", user])).code === 0) await system.run("userdel", [user], { allowFailure: true });
  }
  say("Removed everything directionally-local installed. Docker and Tailscale are still installed.");
}
