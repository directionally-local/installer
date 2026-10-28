/**
 * Background services for the current user: launchd LaunchAgents on macOS, systemd user
 * units on Linux. Both start at login and restart the process if it exits.
 */
import type { System } from "../system.js";
import {
  LOCAL_SERVICES, launchAgentPlist, serviceFile, systemdUserUnit,
  type LocalPaths, type LocalPlatform, type LocalService, type ServiceSpec,
} from "./layout.js";

export interface ServiceManager {
  platform: LocalPlatform;
  paths: LocalPaths;
  /** The user's uid (launchd's gui/<uid> domain). */
  uid: string;
  sleep: (ms: number) => Promise<void>;
}

const ORDER: LocalService[] = ["hotcell", "autopilot"];

export async function userId(system: System): Promise<string> {
  const uid = (await system.probe("id", ["-u"])).stdout.trim();
  if (!/^\d+$/.test(uid)) throw new Error("Couldn't tell which user this is (id -u).");
  if (uid === "0") throw new Error("Run this as yourself, not as root or with sudo: the agents run as your user.");
  return uid;
}

/** Writes the service definition, then starts (or restarts) it. */
export async function installService(system: System, manager: ServiceManager, spec: ServiceSpec): Promise<void> {
  const { platform, paths } = manager;
  const file = serviceFile(paths, platform, spec.service);
  await system.mkdir(paths.services, { mode: platform === "darwin" ? 0o755 : 0o700 });
  if (platform === "darwin") {
    await system.writeFile(file, launchAgentPlist(spec), { mode: 0o644 });
    await stopService(system, manager, spec.service);
    const target = `gui/${manager.uid}/${LOCAL_SERVICES[spec.service].label}`;
    // A service the user disabled stays disabled across bootstrap; setup means "on".
    await system.run("launchctl", ["enable", target], { allowFailure: true });
    // bootout returns before launchd has let go of the label; bootstrap can briefly fail with EIO.
    for (let attempt = 1; ; attempt++) {
      const result = await system.run("launchctl", ["bootstrap", `gui/${manager.uid}`, file], { allowFailure: true });
      if (result.code === 0) break;
      if (attempt >= 5) throw new Error(`launchd wouldn't start ${spec.service}: ${(result.stderr || result.stdout).trim()}`);
      await manager.sleep(1_000);
    }
    return;
  }
  const unit = LOCAL_SERVICES[spec.service].unit;
  await system.writeFile(file, systemdUserUnit(spec, spec.service === "autopilot" ? LOCAL_SERVICES.hotcell.unit : undefined), { mode: 0o644 });
  await system.run("systemctl", ["--user", "daemon-reload"]);
  await system.run("systemctl", ["--user", "enable", unit]);
  await system.run("systemctl", ["--user", "restart", unit]);
}

export async function stopService(system: System, manager: ServiceManager, service: LocalService): Promise<void> {
  if (manager.platform === "darwin") {
    await system.run("launchctl", ["bootout", `gui/${manager.uid}/${LOCAL_SERVICES[service].label}`], { allowFailure: true });
  } else {
    await system.run("systemctl", ["--user", "disable", "--now", LOCAL_SERVICES[service].unit], { allowFailure: true });
  }
}

/** Stops and deletes both service definitions. */
export async function removeServices(system: System, manager: ServiceManager): Promise<void> {
  for (const service of [...ORDER].reverse()) {
    await stopService(system, manager, service);
    await system.remove(serviceFile(manager.paths, manager.platform, service));
  }
  if (manager.platform === "linux") {
    await system.run("systemctl", ["--user", "daemon-reload"], { allowFailure: true });
    await system.run("systemctl", ["--user", "reset-failed"], { allowFailure: true });
  }
}

export interface ServiceState {
  installed: boolean;
  running: boolean;
  pid?: number;
}

export async function serviceState(system: System, manager: ServiceManager, service: LocalService): Promise<ServiceState> {
  const installed = await system.exists(serviceFile(manager.paths, manager.platform, service));
  if (manager.platform === "darwin") {
    const printed = await system.probe("launchctl", ["print", `gui/${manager.uid}/${LOCAL_SERVICES[service].label}`]);
    const running = printed.code === 0 && /^\s*state = running\s*$/m.test(printed.stdout);
    const pid = Number(printed.stdout.match(/^\s*pid = (\d+)\s*$/m)?.[1]);
    return { installed, running, ...(pid ? { pid } : {}) };
  }
  const active = await system.probe("systemctl", ["--user", "is-active", LOCAL_SERVICES[service].unit]);
  return { installed, running: active.stdout.trim() === "active" };
}
