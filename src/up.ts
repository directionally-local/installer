import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { agentCapacity, detectHost, preflightProblems, type HostFacts } from "./detect.js";
import {
  AUTOPILOT_PORT, CELL_MEMORY_MB, GITHUB_PROXY_PORT, HOTCELL_EGRESS_PORT, HOTCELL_PORT, PATHS, SERVICES, USERS,
  AUTO_UPGRADES, NODE_AUTO_UPDATES, asterConfig, autoUpgrades, autopilotBin, autopilotEnv, autopilotUnit,
  cellDockerfile, cellImage, githubEnv, hotcellBin, hotcellEnv, hotcellUnit, metadataBlockUnit, nodeAutoUpdates, parseEnvFile,
} from "./layout.js";
import type { Prompter } from "./prompt.js";
import { readState, writeState, type AccessMode, type InstallState } from "./state.js";
import type { System } from "./system.js";

export interface UpOptions {
  prompter: Prompter;
  /**
   * Answers for unattended installs: DL_TAILSCALE_AUTH_KEY, DL_OPENROUTER_API_KEY, DL_GITHUB_TOKEN.
   * DL_ACCESS=loopback skips Tailscale (SSH tunnel access); DL_SKIP_CREDENTIAL_CHECK=1 skips online validation.
   */
  env?: NodeJS.ProcessEnv;
  autopilotVersion?: string;
  hotcellVersion?: string;
  /** Validates the model key and GitHub token before anything is stored. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface UpResult {
  url: string;
  ownerLink: string | undefined;
  capacity: number;
  state: InstallState;
}

interface Answers {
  tailscaleAuthKey: string | undefined;
  openRouterKey: string | undefined;
  githubToken: string | undefined;
}

const DRY_RUN_BRIDGE_IP = "172.17.0.1";
const DRY_RUN_URL = "https://<this-machine>.<tailnet>.ts.net";

/** `directionally-local up`: install or repair Hotcell + Autopilot as services. Safe to re-run. */
export async function up(system: System, options: UpOptions): Promise<UpResult> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const say = (line: string) => system.log(line);

  say("== Checking this machine");
  let facts = await detectHost(system);
  const problems = preflightProblems(facts);
  if (problems.length > 0) throw new Error(`Can't install here:\n  - ${problems.join("\n  - ")}`);
  say(`  ${facts.os.prettyName}, ${facts.cpus} CPUs, ${(facts.memoryMb / 1024).toFixed(1)} GB RAM, ${facts.diskFreeGb} GB free${facts.kvm ? ", KVM available" : ""}`);

  // Every question comes first, so the long part runs unattended.
  const previous = await readState(system);
  const access = accessMode(env, previous);
  const check = env.DL_SKIP_CREDENTIAL_CHECK === "1" ? undefined : fetchImpl;
  const answers = await collectAnswers(system, options.prompter, env, check, facts, access);

  say("== Docker");
  if (facts.docker) {
    say("  already running");
  } else {
    // An installed Docker (Ubuntu's docker.io or Docker's docker-ce) is started, never
    // replaced: get.docker.com swapping packages under a running install is how the socket
    // and service fall out of step.
    if (facts.dockerInstalled) {
      say("  installed but not running; starting it");
    } else {
      await system.run("sh", ["-c", "curl -fsSL https://get.docker.com | sh"], { inherit: true, describe: "install Docker (get.docker.com)" });
    }
    await startDocker(system, sleep);
    facts = await detectHost(system);
  }
  const bridgeIp = facts.dockerBridgeIp ?? (system.dryRun ? DRY_RUN_BRIDGE_IP : undefined);
  if (!bridgeIp) throw new Error("Docker is running but its docker0 bridge has no IPv4 address; sandboxes couldn't reach the gateway.");

  say("== Automatic security updates");
  await ensureAutomaticUpdates(system);

  say("== Service accounts");
  await ensureUser(system, USERS.hotcell, PATHS.hotcellHome, ["docker"]);
  await ensureUser(system, USERS.autopilot, PATHS.autopilotHome, []);

  say("== Hotcell and Autopilot");
  const autopilotVersion = options.autopilotVersion ?? await latestVersion(system, "autopilot-ai");
  const hotcellVersion = options.hotcellVersion ?? await latestVersion(system, "hotcell");
  const release = `autopilot-${autopilotVersion}_hotcell-${hotcellVersion}`;
  const releaseDir = `${PATHS.releases}/${release}`;
  if (await system.exists(`${releaseDir}/node_modules/autopilot-ai/package.json`) && await system.exists(`${releaseDir}/node_modules/hotcell/package.json`)) {
    say(`  ${release} already installed`);
  } else {
    await system.mkdir(releaseDir, { mode: 0o755 });
    await system.run("npm", ["install", "--prefix", releaseDir, "--no-audit", "--no-fund", "--omit=dev", `autopilot-ai@${autopilotVersion}`, `hotcell@${hotcellVersion}`], { inherit: true });
  }
  await system.run("ln", ["-sfn", releaseDir, PATHS.current]);

  say("== Hotcell configuration and model key");
  const hotcellValues = parseEnvFile(await system.readFile(PATHS.hotcellEnv));
  const hotcellApiKey = hotcellValues.HOTCELL_API_KEY || randomBytes(24).toString("hex");
  await system.mkdir(PATHS.hotcellEtc, { mode: 0o750, owner: `root:${USERS.hotcell}` });
  await system.writeFile(PATHS.hotcellEnv, hotcellEnv({ apiKey: hotcellApiKey, bridgeIp }), { mode: 0o640, owner: `root:${USERS.hotcell}`, secret: true });
  if (answers.openRouterKey) {
    // Into Hotcell's keystore over stdin: never in argv, env files, or Autopilot's config.
    await asHotcell(system, ["keys", "add", "openrouter", "--stdin"], { input: answers.openRouterKey, describe: "hotcell keys add openrouter --stdin (as hotcell)" });
  }

  say("== Autopilot configuration");
  await system.mkdir(PATHS.autopilotEtc, { mode: 0o750, owner: `root:${USERS.autopilot}` });
  if (answers.githubToken) {
    await system.writeFile(PATHS.githubEnv, githubEnv(answers.githubToken), { mode: 0o640, owner: `root:${USERS.autopilot}`, secret: true });
  }
  if (!(await system.readFile(PATHS.asterConfig))) {
    await system.writeFile(PATHS.asterConfig, asterConfig(), { mode: 0o640, owner: `root:${USERS.autopilot}` });
  }
  await ensureWorkspace(system);

  const image = cellImage(autopilotVersion);
  say(`== Sandbox image ${image}`);
  await ensureCellImage(system, image, autopilotVersion);

  say("== Services");
  await allowBridgePorts(system, bridgeIp);
  await system.writeFile(`${PATHS.units}/${SERVICES.metadataBlock}`, metadataBlockUnit());
  await system.writeFile(`${PATHS.units}/${SERVICES.hotcell}`, hotcellUnit());
  await system.writeFile(`${PATHS.units}/${SERVICES.autopilot}`, autopilotUnit());
  await system.run("systemctl", ["daemon-reload"]);
  await system.run("systemctl", ["enable", "--now", SERVICES.metadataBlock]);
  await system.run("systemctl", ["enable", SERVICES.hotcell]);
  await system.run("systemctl", ["restart", SERVICES.hotcell]);
  await waitUntil(system, sleep, "Hotcell", async () => (await system.probe("curl", ["-fsS", "-o", "/dev/null", `http://127.0.0.1:${HOTCELL_PORT}/`])).code === 0
    || (await system.probe("sh", ["-c", `ss -ltn | grep -q '127.0.0.1:${HOTCELL_PORT}'`])).code === 0);

  const url = access === "tailscale"
    ? (say("== Access: private, over Tailscale"), await setUpTailscale(system, answers.tailscaleAuthKey))
    : (say("== Access: this machine only (use an SSH tunnel)"), `http://127.0.0.1:${AUTOPILOT_PORT}`);

  await system.writeFile(PATHS.autopilotEnv, autopilotEnv({ hotcellApiKey, image, bridgeIp, publicUrl: url }), { mode: 0o640, owner: `root:${USERS.autopilot}`, secret: true });
  await system.run("systemctl", ["enable", SERVICES.autopilot]);
  await system.run("systemctl", ["restart", SERVICES.autopilot]);
  // Without a token the Aster API answers 401: the server is up and refusing strangers.
  await waitUntil(system, sleep, "Autopilot", async () =>
    (await system.probe("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", `http://127.0.0.1:${AUTOPILOT_PORT}/api/v1/health`])).stdout.trim() === "401");

  const now = (options.now ?? (() => new Date()))().toISOString();
  const state: InstallState = {
    version: 1,
    installedAt: previous?.installedAt ?? now,
    updatedAt: now,
    release,
    autopilotVersion,
    hotcellVersion,
    image,
    access: { mode: access, url },
  };
  await writeState(system, state);

  const ownerLink = await createOwnerLink(system, url);
  const capacity = agentCapacity(facts, CELL_MEMORY_MB);
  say("");
  say(`✓ Ready. Fits ~${capacity} agent${capacity === 1 ? "" : "s"} at once (estimate).`);
  if (ownerLink) say(`  Open once to approve laptops in your browser: ${ownerLink}`);
  if (access === "tailscale") {
    say(`  On your laptop (signed in to the same tailnet): autopilot remote add ${url}`);
  } else {
    say(`  On your laptop: ssh -N -L ${AUTOPILOT_PORT}:127.0.0.1:${AUTOPILOT_PORT} root@<this-server>, then: autopilot remote add ${url}`);
  }
  return { url, ownerLink, capacity, state };
}

function accessMode(env: NodeJS.ProcessEnv, previous: InstallState | undefined): AccessMode {
  const requested = env.DL_ACCESS?.trim();
  if (requested === undefined || requested === "") return previous?.access.mode ?? "tailscale";
  if (requested === "tailscale" || requested === "loopback") return requested;
  throw new Error(`DL_ACCESS must be tailscale or loopback (got "${requested}"); an own domain and the instant address are coming.`);
}

async function collectAnswers(
  system: System,
  prompter: Prompter,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch | undefined,
  facts: HostFacts,
  access: AccessMode,
): Promise<Answers> {
  const tailscaleRunning = access !== "tailscale" || (facts.tailscale && await tailscaleIsUp(system));
  const hasModelKey = await hotcellHasKey(system, "openrouter");
  const hasGitHub = Boolean(parseEnvFile(await system.readFile(PATHS.githubEnv)).GITHUB_TOKEN);
  if (system.dryRun) {
    return {
      tailscaleAuthKey: tailscaleRunning ? undefined : "<asked>",
      openRouterKey: hasModelKey ? undefined : "<asked>",
      githubToken: hasGitHub ? undefined : "<asked>",
    };
  }

  system.log("== A few questions (the rest runs on its own)");
  const tailscaleAuthKey = tailscaleRunning ? undefined : await askValidated(
    env.DL_TAILSCALE_AUTH_KEY,
    () => prompter.secret("Tailscale auth key (create one at https://login.tailscale.com/admin/settings/keys): "),
    async (value) => /^tskey-[A-Za-z0-9-]+$/.test(value) ? undefined : "That doesn't look like a Tailscale auth key (tskey-…).",
    system,
  );
  const openRouterKey = hasModelKey ? undefined : await askValidated(
    env.DL_OPENROUTER_API_KEY,
    () => prompter.secret("OpenRouter API key (kept in Hotcell on this server; sandboxes and laptops never see it): "),
    (value) => validateOpenRouterKey(value, fetchImpl),
    system,
  );
  const githubToken = hasGitHub ? undefined : await askValidated(
    env.DL_GITHUB_TOKEN,
    () => prompter.secret("GitHub token for cloning, pushing, and opening PRs (fine-grained: Contents + Pull requests read/write; https://github.com/settings/personal-access-tokens/new): "),
    (value) => validateGitHubToken(value, fetchImpl, system),
    system,
  );
  return { tailscaleAuthKey, openRouterKey, githubToken };
}

/** Takes an env answer as-is (failing fast if invalid) or asks up to three times. */
async function askValidated(
  fromEnv: string | undefined,
  ask: () => Promise<string>,
  validate: (value: string) => Promise<string | undefined>,
  system: System,
): Promise<string> {
  if (fromEnv) {
    const problem = await validate(fromEnv.trim());
    if (problem) throw new Error(problem);
    return fromEnv.trim();
  }
  for (let attempt = 1; ; attempt++) {
    const value = (await ask()).trim();
    const problem = value ? await validate(value) : "An answer is required.";
    if (!problem) return value;
    if (attempt >= 3) throw new Error(problem);
    system.log(`  ${problem} Try again.`);
  }
}

export async function validateOpenRouterKey(key: string, fetchImpl: typeof fetch | undefined): Promise<string | undefined> {
  if (!/^sk-or-[A-Za-z0-9_-]{10,}$/.test(key)) return "That doesn't look like an OpenRouter key (sk-or-…).";
  if (!fetchImpl) return undefined;
  try {
    const response = await fetchImpl("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` } });
    if (response.status === 401 || response.status === 403) return "OpenRouter rejected that key.";
    return undefined;
  } catch {
    // Offline validation isn't fatal: the format is right, and doctor checks it later.
    return undefined;
  }
}

export async function validateGitHubToken(token: string, fetchImpl: typeof fetch | undefined, system: System): Promise<string | undefined> {
  if (!/^(github_pat_|ghp_|gho_)[A-Za-z0-9_]{20,}$/.test(token)) return "That doesn't look like a GitHub token (github_pat_… or ghp_…).";
  if (!fetchImpl) return undefined;
  try {
    const response = await fetchImpl("https://api.github.com/user", { headers: { Authorization: `Bearer ${token}`, "User-Agent": "directionally-local" } });
    if (response.status === 401) return "GitHub rejected that token.";
    if (response.ok) {
      const user = await response.json() as { login?: string };
      if (user.login) system.log(`  GitHub: signed in as ${user.login}`);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ubuntu's unattended-upgrades only patches Ubuntu's own packages, so Node.js from
 * NodeSource would never pick up a security release by itself. Docker's repo is left out
 * on purpose: it ships major upgrades, and restarting dockerd can stop running sandboxes.
 */
async function ensureAutomaticUpdates(system: System): Promise<void> {
  const installed = await system.probe("dpkg-query", ["-W", "-f=${Status}", "unattended-upgrades"]);
  if (!installed.stdout.includes("install ok installed")) {
    await system.run("apt-get", ["install", "-y", "-qq", "unattended-upgrades"], { env: { DEBIAN_FRONTEND: "noninteractive" } });
  }
  // Keep an operator's own schedule; only turn the daily run on where it's missing.
  if (!(await system.readFile(AUTO_UPGRADES))) await system.writeFile(AUTO_UPGRADES, autoUpgrades());
  if ((await system.probe("apt-cache", ["policy", "nodejs"])).stdout.includes("deb.nodesource.com")) {
    await system.writeFile(NODE_AUTO_UPDATES, nodeAutoUpdates());
  } else {
    system.log("  Node.js isn't from NodeSource here; keep it patched yourself (22.23.4+, 24.22.1+ or 26.12.1+).");
  }
}

/**
 * Starts Docker so it actually answers. docker.service is socket-activated on Ubuntu: if it
 * starts while docker.socket is down, dockerd exits ("no sockets found via socket
 * activation") and systemd soon stops retrying. So: clear that failed state, bring up the
 * socket first, then the service, and wait for the daemon to respond.
 */
async function startDocker(system: System, sleep: (ms: number) => Promise<void>): Promise<void> {
  await system.run("systemctl", ["reset-failed", "docker.service", "docker.socket"], { allowFailure: true });
  await system.run("systemctl", ["enable", "--now", "docker.socket"], { allowFailure: true });
  await system.run("systemctl", ["enable", "docker.service"]);
  await system.run("systemctl", ["restart", "docker.service"]);
  await waitUntil(system, sleep, "Docker", async () =>
    (await system.probe("docker", ["version", "--format", "{{.Server.Version}}"])).stdout.trim() !== "", "docker");
}

async function ensureUser(system: System, name: string, home: string, groups: string[]): Promise<void> {
  if ((await system.probe("id", ["-u", name])).code !== 0) {
    await system.run("useradd", ["--system", "--user-group", "--home-dir", home, "--shell", "/usr/sbin/nologin", name]);
  }
  for (const group of groups) await system.run("usermod", ["-aG", group, name]);
  await system.mkdir(home, { mode: 0o750, owner: `${name}:${name}` });
}

async function latestVersion(system: System, pkg: string): Promise<string> {
  const result = await system.probe("npm", ["view", pkg, "version"]);
  const version = result.stdout.trim();
  if (result.code !== 0 || !/^\d+\.\d+\.\d+/.test(version)) throw new Error(`Couldn't look up the latest ${pkg} on npm${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  return version;
}

function asHotcell(system: System, args: string[], options: { input?: string; describe?: string } = {}) {
  return system.run("runuser", [
    "-u", USERS.hotcell, "--", "env", `HOTCELL_HOME=${PATHS.hotcellHome}`, "HOTCELL_KEYSTORE=file",
    "/usr/bin/node", hotcellBin(), ...args,
  ], options);
}

async function hotcellHasKey(system: System, provider: string): Promise<boolean> {
  if (!(await system.exists(hotcellBin()))) return false;
  const result = await system.probe("runuser", [
    "-u", USERS.hotcell, "--", "env", `HOTCELL_HOME=${PATHS.hotcellHome}`, "HOTCELL_KEYSTORE=file", "/usr/bin/node", hotcellBin(), "keys", "ls",
  ]);
  return result.code === 0 && new RegExp(`^\\s*${provider}\\b`, "m").test(result.stdout);
}

/** The default workspace: an empty Git repository Aster requires as a root. */
async function ensureWorkspace(system: System): Promise<void> {
  if (await system.exists(`${PATHS.workspace}/.git`)) return;
  await system.mkdir(PATHS.workspace, { mode: 0o700, owner: `${USERS.autopilot}:${USERS.autopilot}` });
  const git = (args: string[]) => system.run("runuser", ["-u", USERS.autopilot, "--", "git", "-C", PATHS.workspace, ...args]);
  await git(["init", "--quiet", "--initial-branch=main"]);
  await system.run("runuser", ["-u", USERS.autopilot, "--", "sh", "-c", `printf '# Default workspace\\n' > ${PATHS.workspace}/README.md`]);
  await git(["add", "README.md"]);
  await git(["-c", "user.name=Autopilot", "-c", "user.email=autopilot@localhost", "commit", "--quiet", "-m", "Initialize workspace"]);
}

async function ensureCellImage(system: System, image: string, autopilotVersion: string): Promise<void> {
  if ((await system.probe("docker", ["image", "inspect", image])).code === 0) {
    system.log("  already built");
    return;
  }
  const dir = system.dryRun ? "/tmp/directionally-local-image" : (await system.run("mktemp", ["-d"])).stdout.trim();
  try {
    await system.run("npm", ["pack", `autopilot-ai@${autopilotVersion}`, "--pack-destination", dir, "--silent"]);
    await system.run("sh", ["-c", `mv ${dir}/autopilot-ai-*.tgz ${dir}/autopilot.tgz`]);
    await system.writeFile(`${dir}/Dockerfile`, cellDockerfile());
    await system.run("docker", ["build", "--pull", "-q", "-t", image, dir], { inherit: true });
  } finally {
    await system.remove(dir);
  }
}

/** With UFW on, sandboxes still need the gateway and GitHub proxy on the bridge address. */
async function allowBridgePorts(system: System, bridgeIp: string): Promise<void> {
  const status = await system.probe("ufw", ["status"]);
  if (status.code !== 0 || !/Status: active/.test(status.stdout)) return;
  for (const port of [HOTCELL_EGRESS_PORT, GITHUB_PROXY_PORT]) {
    await system.run("ufw", ["allow", "in", "on", "docker0", "to", bridgeIp, "port", String(port), "proto", "tcp", "comment", "directionally-local sandboxes"]);
  }
}

async function tailscaleIsUp(system: System): Promise<boolean> {
  const status = await system.probe("tailscale", ["status", "--json"]);
  if (status.code !== 0) return false;
  try {
    return (JSON.parse(status.stdout) as { BackendState?: string }).BackendState === "Running";
  } catch {
    return false;
  }
}

/** Joins the tailnet if needed and serves Autopilot on the machine's HTTPS ts.net name. */
async function setUpTailscale(system: System, authKey: string | undefined): Promise<string> {
  if ((await system.probe("tailscale", ["version"])).code !== 0) {
    await system.run("sh", ["-c", "curl -fsSL https://tailscale.com/install.sh | sh"], { inherit: true, describe: "install Tailscale (tailscale.com/install.sh)" });
  }
  if (authKey) {
    // The key goes through a 0600 file, never argv.
    const keyFile = `${PATHS.stateDir}/tailscale-auth-key`;
    await system.mkdir(PATHS.stateDir, { mode: 0o700 });
    await system.writeFile(keyFile, authKey, { mode: 0o600, secret: true });
    try {
      await system.run("tailscale", ["up", `--auth-key=file:${keyFile}`, `--hostname=${machineName()}`]);
    } finally {
      await system.remove(keyFile);
    }
  }
  const served = await system.run("tailscale", ["serve", "--bg", "--https=443", `http://127.0.0.1:${AUTOPILOT_PORT}`], { allowFailure: true });
  if (served.code !== 0) {
    throw new Error(`Tailscale couldn't serve HTTPS: ${served.stderr.trim() || served.stdout.trim()}\n`
      + "  Turn on MagicDNS and HTTPS certificates at https://login.tailscale.com/admin/dns, then run `dl up` again.");
  }
  if (system.dryRun) return DRY_RUN_URL;
  const status = await system.probe("tailscale", ["status", "--json"]);
  const dnsName = (JSON.parse(status.stdout || "{}") as { Self?: { DNSName?: string } }).Self?.DNSName?.replace(/\.$/, "");
  if (!dnsName) throw new Error("Tailscale is up but reported no DNS name for this machine; is MagicDNS on?");
  return `https://${dnsName}`;
}

async function createOwnerLink(system: System, url: string): Promise<string | undefined> {
  const result = await system.run("runuser", [
    "-u", USERS.autopilot, "--", "env", `HOME=${PATHS.autopilotHome}`, `AUTOPILOT_ASTER_CONFIG=${PATHS.asterConfig}`,
    `AUTOPILOT_ASTER_DB=${PATHS.autopilotHome}/aster.db`, "/usr/bin/node", autopilotBin(), "aster", "owner", "link", "--url", url,
  ], { allowFailure: true, describe: "autopilot aster owner link (as autopilot)" });
  const link = result.stdout.trim().split("\n").at(-1);
  return result.code === 0 && link?.startsWith("http") ? link : undefined;
}

async function waitUntil(system: System, sleep: (ms: number) => Promise<void>, what: string, ready: () => Promise<boolean>, unit = what.toLowerCase()): Promise<void> {
  if (system.dryRun) return;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await ready()) return;
    await sleep(1_000);
  }
  throw new Error(`${what} didn't come up; check: journalctl -u ${unit} -n 50`);
}

function machineName(): string {
  return hostname().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "directionally-local";
}
