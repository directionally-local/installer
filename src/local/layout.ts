/**
 * "On this computer": where everything lives in the user's home, and the files written
 * there. Nothing here needs root. Secrets sit in 0600 env files that `node --env-file`
 * reads, so they never appear in a launchd plist, a systemd unit, or any command line.
 */

import { join } from "node:path";
import type { ProviderConfig } from "../provider.js";

export type LocalPlatform = "darwin" | "linux";

export interface LocalPaths {
  home: string;
  root: string;
  releases: string;
  current: string;
  logs: string;
  state: string;
  config: string;
  hotcellEnv: string;
  autopilotEnv: string;
  githubEnv: string;
  asterConfig: string;
  hotcellHome: string;
  /** OpenRouter's prices, so Hotcell's spend-capped gateway forwards current models. */
  modelPrices: string;
  autopilotHome: string;
  workspace: string;
  /** ~/Library/LaunchAgents (macOS) or ~/.config/systemd/user (Linux). */
  services: string;
}

export function localPaths(home: string, platform: LocalPlatform): LocalPaths {
  const root = join(home, ".directionallylocal");
  const config = join(root, "config");
  const autopilotHome = join(root, "autopilot");
  return {
    home,
    root,
    releases: join(root, "releases"),
    current: join(root, "current"),
    logs: join(root, "logs"),
    state: join(root, "state.json"),
    config,
    hotcellEnv: join(config, "hotcell.env"),
    autopilotEnv: join(config, "autopilot.env"),
    githubEnv: join(config, "github.env"),
    asterConfig: join(config, "aster.json"),
    hotcellHome: join(root, "hotcell"),
    modelPrices: join(root, "hotcell", "model-prices.json"),
    autopilotHome,
    workspace: join(autopilotHome, "workspaces", "default"),
    services: platform === "darwin" ? join(home, "Library", "LaunchAgents") : join(home, ".config", "systemd", "user"),
  };
}

/** launchd labels and systemd user units, prefixed so they never clash with a user's own Hotcell. */
export const LOCAL_SERVICES = {
  hotcell: { label: "com.directionallylocal.hotcell", unit: "directionallylocal-hotcell.service", log: "hotcell.log" },
  autopilot: { label: "com.directionallylocal.autopilot", unit: "directionallylocal-autopilot.service", log: "autopilot.log" },
} as const;
export type LocalService = keyof typeof LOCAL_SERVICES;

export function serviceFile(paths: LocalPaths, platform: LocalPlatform, service: LocalService): string {
  const entry = LOCAL_SERVICES[service];
  return join(paths.services, platform === "darwin" ? `${entry.label}.plist` : entry.unit);
}

/** Preferred ports; each moves up to the next free one when something else has it. */
export const PREFERRED_PORTS = {
  autopilot: 4096,
  hotcell: 4750,
  hotcellProxy: 4751,
  hotcellEgress: 4752,
  githubProxy: 4760,
} as const;
export type LocalPorts = { -readonly [K in keyof typeof PREFERRED_PORTS]: number };

export const LOCAL_CELL_MEMORY_MB = 1024;
export const LOCAL_MIN_DISK_GB = 10;
export const PAIRED_NAME = "this-computer";

export function localHotcellBin(paths: LocalPaths): string {
  return join(paths.current, "node_modules", "hotcell", "dist", "index.js");
}

export function localAutopilotBin(paths: LocalPaths): string {
  return join(paths.current, "node_modules", "autopilot-ai", "bin", "autopilot.mjs");
}

/**
 * KEY=value lines for `node --env-file`. Values with spaces or `#` (a home like
 * "/Users/Jane Doe") are double-quoted, which Node's parser understands.
 */
export function localEnvFile(header: string, values: Record<string, string>): string {
  const lines = Object.entries(values).map(([key, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\n\r"]/.test(value)) throw new Error(`invalid env entry ${key}`);
    return `${key}=${/[\s#'`$\\]/.test(value) ? `"${value}"` : value}`;
  });
  return `# ${header}\n# Written by directionallylocal; re-running setup keeps your values.\n${lines.join("\n")}\n`;
}

export function parseLocalEnvFile(text: string | undefined): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of (text ?? "").split("\n")) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match) values[match[1]!] = match[2]!.replace(/^"(.*)"$/, "$1");
  }
  return values;
}

export interface Networking {
  /** Where the gateway and GitHub proxy listen: loopback on macOS (Docker Desktop forwards
   * host.docker.internal there), the docker0 bridge address on Linux. */
  listenHost: string;
}

export function localHotcellEnv(input: { paths: LocalPaths; apiKey: string; ports: LocalPorts; net: Networking }): string {
  const { paths, ports } = input;
  return localEnvFile("Hotcell daemon (sandboxes + credential gateway), on this computer", {
    HOTCELL_HOME: paths.hotcellHome,
    // A 0600 file, not the login keychain: see setup.ts for why.
    HOTCELL_KEYSTORE: "file",
    HOTCELL_DB: join(paths.hotcellHome, "state.db"),
    HOTCELL_BACKUP_DIR: join(paths.hotcellHome, "backups"),
    HOTCELL_HOST: "127.0.0.1",
    HOTCELL_PORT: String(ports.hotcell),
    HOTCELL_PROXY_PORT: String(ports.hotcellProxy),
    HOTCELL_API_KEY: input.apiKey,
    HOTCELL_DRIVER: "container",
    HOTCELL_EGRESS_HOST: input.net.listenHost,
    HOTCELL_EGRESS_PORT: String(ports.hotcellEgress),
    HOTCELL_EGRESS_ADVERTISE_HOST: "host.docker.internal",
    // Under a spend cap the gateway refuses models it can't price; setup refreshes this list.
    HOTCELL_MODEL_PRICES: paths.modelPrices,
  });
}

export function localAutopilotEnv(input: { paths: LocalPaths; hotcellApiKey: string; image: string; ports: LocalPorts; net: Networking }): string {
  const { paths, ports } = input;
  return localEnvFile("Autopilot server (Aster API), on this computer", {
    AUTOPILOT_ASTER_CONFIG: paths.asterConfig,
    AUTOPILOT_ASTER_DB: join(paths.autopilotHome, "aster.db"),
    AUTOPILOT_RUNS_DB: join(paths.autopilotHome, "runs.db"),
    AUTOPILOT_PUBLIC_URL: `http://127.0.0.1:${ports.autopilot}`,
    // The model key lives only in Hotcell; no model calls from this computer itself.
    AUTOPILOT_ASTER_MEMORY: "off",
    AUTOPILOT_HOTCELL_ENDPOINT: `http://127.0.0.1:${ports.hotcell}`,
    AUTOPILOT_HOTCELL_API_KEY: input.hotcellApiKey,
    AUTOPILOT_HOTCELL_DRIVER: "container",
    AUTOPILOT_HOTCELL_IMAGE: input.image,
    AUTOPILOT_HOTCELL_NETWORKED: "true",
    AUTOPILOT_HOTCELL_ANY_MODEL: "true",
    AUTOPILOT_HOTCELL_SLEEP_AFTER_MS: "900000",
    AUTOPILOT_HOTCELL_MEMORY_MB: String(LOCAL_CELL_MEMORY_MB),
    AUTOPILOT_HOTCELL_CPUS: "1",
    AUTOPILOT_HOTCELL_PIDS: "512",
    AUTOPILOT_HOTCELL_SPEND_CAP_USD: "10",
    AUTOPILOT_HOTCELL_TOKEN_TTL_MS: String(30 * 24 * 60 * 60 * 1000),
    // Cells clone and push through Autopilot's repository-scoped proxy; the token stays here.
    AUTOPILOT_ASTER_GITHUB_PROXY_LISTEN: `${input.net.listenHost}:${ports.githubProxy}`,
    AUTOPILOT_ASTER_GITHUB_PROXY_URL: `http://host.docker.internal:${ports.githubProxy}`,
  });
}

/** With no token yet, the file exists (Autopilot starts with --env-file) but sets nothing. */
export function localGithubEnv(token: string): string {
  return localEnvFile("GitHub credential for cloning, pushing, and opening PRs (never sent to sandboxes)", token ? { GITHUB_TOKEN: token } : {});
}

/** Aster's server config. Without a provider block Autopilot assumes OpenRouter. */
export function localAsterConfig(paths: LocalPaths, provider?: ProviderConfig): string {
  return `${JSON.stringify({
    ...(provider ? { provider, models: "catalog" } : { models: "openrouter" }),
    workspaces: [{ id: "default", displayName: "Default workspace", rootPath: paths.workspace }],
  }, null, 2)}\n`;
}

/** The fields aster.json starts from when the provider is set into a missing or damaged file. */
export function localAsterDefaults(paths: LocalPaths): Record<string, unknown> {
  return JSON.parse(localAsterConfig(paths)) as Record<string, unknown>;
}

/** Non-secret environment set by the service manager itself: `--env-file` never overrides it. */
export interface ServiceSpec {
  service: LocalService;
  description: string;
  node: string;
  envFiles: string[];
  args: string[];
  env: Record<string, string>;
  workingDirectory: string;
  log: string;
}

export function serviceSpecs(input: {
  paths: LocalPaths;
  node: string;
  path: string;
  dockerHost: string | undefined;
  ports: LocalPorts;
}): Record<LocalService, ServiceSpec> {
  const { paths } = input;
  const docker: Record<string, string> = input.dockerHost ? { DOCKER_HOST: input.dockerHost } : {};
  return {
    hotcell: {
      service: "hotcell",
      description: "Hotcell sandbox daemon (Directionally Local)",
      node: input.node,
      envFiles: [paths.hotcellEnv],
      args: [localHotcellBin(paths), "start", "--foreground", "--defaults"],
      // Its own HOME, so nothing falls back to a user's own ~/.hotcell.
      env: { HOME: paths.hotcellHome, PATH: input.path, ...docker },
      workingDirectory: paths.hotcellHome,
      log: join(paths.logs, LOCAL_SERVICES.hotcell.log),
    },
    autopilot: {
      service: "autopilot",
      description: "Autopilot server (Directionally Local)",
      node: input.node,
      envFiles: [paths.autopilotEnv, paths.githubEnv],
      args: [localAutopilotBin(paths), "serve", "--hostname", "127.0.0.1", "--port", String(input.ports.autopilot)],
      // Its own HOME and XDG dirs: a user's own Autopilot config and keys are never picked up.
      env: { HOME: paths.autopilotHome, PATH: input.path, ...autopilotXdg(paths), ...docker },
      workingDirectory: paths.autopilotHome,
      log: join(paths.logs, LOCAL_SERVICES.autopilot.log),
    },
  };
}

export function autopilotXdg(paths: LocalPaths): Record<string, string> {
  return {
    XDG_CONFIG_HOME: join(paths.autopilotHome, ".config"),
    XDG_STATE_HOME: join(paths.autopilotHome, ".local", "state"),
    XDG_DATA_HOME: join(paths.autopilotHome, ".local", "share"),
    XDG_CACHE_HOME: join(paths.autopilotHome, ".cache"),
  };
}

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A LaunchAgent: starts at login, restarted if it exits, logs under ~/.directionallylocal/logs. */
export function launchAgentPlist(spec: ServiceSpec): string {
  const program = [spec.node, ...spec.envFiles.map((file) => `--env-file=${file}`), ...spec.args];
  const env = Object.entries(spec.env).map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${xml(spec.description)}. Written by directionallylocal; remove with: dl local uninstall -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LOCAL_SERVICES[spec.service].label}</string>
  <key>ProgramArguments</key>
  <array>
${program.map((arg) => `    <string>${xml(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(spec.workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Standard</string>
  <key>StandardOutPath</key>
  <string>${xml(spec.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(spec.log)}</string>
</dict>
</plist>
`;
}

function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

/** A systemd user unit: starts with the user's session (default.target), restarted on exit. */
export function systemdUserUnit(spec: ServiceSpec, after?: string): string {
  const program = [spec.node, ...spec.envFiles.map((file) => `--env-file=${file}`), ...spec.args];
  return `[Unit]
Description=${spec.description}
${after ? `After=${after}\nWants=${after}\n` : ""}
[Service]
Type=simple
${Object.entries(spec.env).map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`).join("\n")}
WorkingDirectory=${spec.workingDirectory}
ExecStart=${program.map(systemdQuote).join(" ")}
Restart=always
RestartSec=5
StandardOutput=append:${spec.log}
StandardError=append:${spec.log}

[Install]
WantedBy=default.target
`;
}
