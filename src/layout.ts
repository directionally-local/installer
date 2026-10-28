/** Where everything lives on the server, and the files the installer writes there. */

export const PATHS = {
  root: "/opt/directionally-local",
  releases: "/opt/directionally-local/releases",
  current: "/opt/directionally-local/current",
  state: "/etc/directionally-local/state.json",
  stateDir: "/etc/directionally-local",
  hotcellEnv: "/etc/hotcell/hotcell.env",
  hotcellEtc: "/etc/hotcell",
  hotcellHome: "/var/lib/hotcell",
  autopilotEtc: "/etc/autopilot",
  autopilotEnv: "/etc/autopilot/autopilot.env",
  githubEnv: "/etc/autopilot/github.env",
  asterConfig: "/etc/autopilot/aster.json",
  autopilotHome: "/var/lib/autopilot",
  workspace: "/var/lib/autopilot/workspaces/default",
  units: "/etc/systemd/system",
} as const;

/** Lets Ubuntu's unattended-upgrades install Node.js fixes from NodeSource, like its own packages. */
export const NODE_AUTO_UPDATES = "/etc/apt/apt.conf.d/52directionally-local-nodejs";
export const AUTO_UPGRADES = "/etc/apt/apt.conf.d/20auto-upgrades";

export const SERVICES = {
  hotcell: "hotcell.service",
  autopilot: "autopilot.service",
  metadataBlock: "directionally-local-metadata-block.service",
} as const;

export const USERS = { hotcell: "hotcell", autopilot: "autopilot" } as const;
export const AUTOPILOT_PORT = 4096;
export const HOTCELL_PORT = 4750;
export const HOTCELL_EGRESS_PORT = 4752;
export const GITHUB_PROXY_PORT = 4760;
/** Per-sandbox memory cap; the "fits ~N agents" estimate divides by it. */
export const CELL_MEMORY_MB = 1024;

export function hotcellBin(): string {
  return `${PATHS.current}/node_modules/hotcell/dist/index.js`;
}

export function autopilotBin(): string {
  return `${PATHS.current}/node_modules/autopilot-ai/bin/autopilot.mjs`;
}

export function cellImage(autopilotVersion: string): string {
  return `directionally-local-cell:${autopilotVersion}`;
}

/** Renders KEY=value lines; values never contain newlines, so they need no quoting for systemd. */
export function envFile(header: string, values: Record<string, string>): string {
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\n\r]/.test(value)) throw new Error(`invalid env entry ${key}`);
  }
  return `# ${header}\n# Written by directionally-local; edit with care, \`directionally-local up\` keeps your values.\n${
    Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")
  }\n`;
}

/** Parses an env file back, so re-running `up` keeps generated secrets. */
export function parseEnvFile(text: string | undefined): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of (text ?? "").split("\n")) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match) values[match[1]!] = match[2]!;
  }
  return values;
}

export function hotcellEnv(input: { apiKey: string; bridgeIp: string }): string {
  return envFile("Hotcell daemon (sandboxes + credential gateway)", {
    HOTCELL_HOME: PATHS.hotcellHome,
    HOTCELL_KEYSTORE: "file",
    HOTCELL_HOST: "127.0.0.1",
    HOTCELL_PORT: String(HOTCELL_PORT),
    HOTCELL_API_KEY: input.apiKey,
    HOTCELL_DRIVER: "container",
    // Sandboxes reach the gateway over the Docker bridge; loopback isn't reachable from them.
    HOTCELL_EGRESS_HOST: input.bridgeIp,
    HOTCELL_EGRESS_PORT: String(HOTCELL_EGRESS_PORT),
    HOTCELL_EGRESS_ADVERTISE_HOST: "host.docker.internal",
  });
}

export function autopilotEnv(input: { hotcellApiKey: string; image: string; bridgeIp: string; publicUrl: string }): string {
  return envFile("Autopilot server (Aster API)", {
    HOME: PATHS.autopilotHome,
    AUTOPILOT_ASTER_CONFIG: PATHS.asterConfig,
    AUTOPILOT_ASTER_DB: `${PATHS.autopilotHome}/aster.db`,
    AUTOPILOT_RUNS_DB: `${PATHS.autopilotHome}/runs.db`,
    AUTOPILOT_PUBLIC_URL: input.publicUrl,
    // The model key lives only in Hotcell; no server-side model calls.
    AUTOPILOT_ASTER_MEMORY: "off",
    AUTOPILOT_HOTCELL_ENDPOINT: `http://127.0.0.1:${HOTCELL_PORT}`,
    AUTOPILOT_HOTCELL_API_KEY: input.hotcellApiKey,
    AUTOPILOT_HOTCELL_DRIVER: "container",
    AUTOPILOT_HOTCELL_IMAGE: input.image,
    AUTOPILOT_HOTCELL_NETWORKED: "true",
    AUTOPILOT_HOTCELL_ANY_MODEL: "true",
    AUTOPILOT_HOTCELL_SLEEP_AFTER_MS: "900000",
    AUTOPILOT_HOTCELL_MEMORY_MB: String(CELL_MEMORY_MB),
    AUTOPILOT_HOTCELL_CPUS: "1",
    AUTOPILOT_HOTCELL_PIDS: "512",
    AUTOPILOT_HOTCELL_SPEND_CAP_USD: "10",
    AUTOPILOT_HOTCELL_TOKEN_TTL_MS: String(30 * 24 * 60 * 60 * 1000),
    // Code cells clone and push through Autopilot's repository-scoped proxy on the bridge.
    AUTOPILOT_ASTER_GITHUB_PROXY_LISTEN: `${input.bridgeIp}:${GITHUB_PROXY_PORT}`,
    AUTOPILOT_ASTER_GITHUB_PROXY_URL: `http://host.docker.internal:${GITHUB_PROXY_PORT}`,
  });
}

export function githubEnv(token: string): string {
  return envFile("GitHub credential for cloning, pushing, and opening PRs (never sent to sandboxes)", { GITHUB_TOKEN: token });
}

export function asterConfig(): string {
  return `${JSON.stringify({
    models: "openrouter",
    workspaces: [{ id: "default", displayName: "Default workspace", rootPath: PATHS.workspace }],
  }, null, 2)}\n`;
}

export function hotcellUnit(): string {
  return `[Unit]
Description=Hotcell sandbox daemon (Directionally Local)
After=docker.service network-online.target ${SERVICES.metadataBlock}
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
User=${USERS.hotcell}
Group=${USERS.hotcell}
SupplementaryGroups=docker
EnvironmentFile=${PATHS.hotcellEnv}
WorkingDirectory=${PATHS.hotcellHome}
ExecStart=/usr/bin/node ${hotcellBin()} start --foreground --defaults
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${PATHS.hotcellHome}
PrivateTmp=true

[Install]
WantedBy=multi-user.target
`;
}

export function autopilotUnit(): string {
  return `[Unit]
Description=Autopilot server (Directionally Local)
After=${SERVICES.hotcell} network-online.target
Wants=${SERVICES.hotcell} network-online.target

[Service]
Type=simple
User=${USERS.autopilot}
Group=${USERS.autopilot}
EnvironmentFile=${PATHS.autopilotEnv}
EnvironmentFile=${PATHS.githubEnv}
WorkingDirectory=${PATHS.autopilotHome}
ExecStart=/usr/bin/node ${autopilotBin()} serve --hostname 127.0.0.1 --port ${AUTOPILOT_PORT}
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${PATHS.autopilotHome}
PrivateTmp=true

[Install]
WantedBy=multi-user.target
`;
}

export function nodeAutoUpdates(): string {
  return `// Written by directionally-local: install Node.js security fixes from NodeSource
// automatically, the way Ubuntu's own packages are. Delete this file to opt out.
// Matched by site: NodeSource's Release file has no meaningful Origin or Label.
Unattended-Upgrade::Origins-Pattern {
        "site=deb.nodesource.com";
};
`;
}

/** Ubuntu's default: refresh package lists and run unattended-upgrades daily. */
export function autoUpgrades(): string {
  return `APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
`;
}

/** Keeps sandboxes away from the cloud metadata endpoint (instance credentials). */
export function metadataBlockUnit(): string {
  const rule = "DOCKER-USER -d 169.254.169.254/32 -j DROP";
  return `[Unit]
Description=Block cloud metadata from Docker sandboxes (Directionally Local)
After=docker.service
Requires=docker.service
Before=${SERVICES.hotcell}

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'iptables -C ${rule} 2>/dev/null || iptables -I ${rule}'
ExecStop=/bin/sh -c 'iptables -D ${rule} 2>/dev/null || true'

[Install]
WantedBy=multi-user.target
`;
}

/** The sandbox image: Node, git, common build tools, and the Autopilot runtime baked in. */
export function cellDockerfile(): string {
  return `FROM node:24-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 python3-pip \\
    && rm -rf /var/lib/apt/lists/*
COPY autopilot.tgz /tmp/autopilot.tgz
RUN mkdir -p /opt/autopilot \\
    && npm install --prefix /opt/autopilot --no-audit --no-fund /tmp/autopilot.tgz \\
    && rm /tmp/autopilot.tgz
WORKDIR /workspace
`;
}
