import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { agentCapacity, detectHost, preflightProblems, type HostFacts } from "./detect.js";
import {
  AUTOPILOT_PORT, CELL_MEMORY_MB, GITHUB_PROXY_PORT, HOTCELL_EGRESS_PORT, HOTCELL_PORT, PATHS, SERVICES, USERS,
  AUTO_UPGRADES, NODE_AUTO_UPDATES, asterConfig, asterConfigDefaults, autoUpgrades, autopilotBin, autopilotEnv, autopilotUnit,
  MOTD_SCRIPT, cellDockerfile, cellImage, githubEnv, hotcellBin, hotcellEnv, hotcellUnit, metadataBlockUnit, motdScript, nodeAutoUpdates, parseEnvFile,
} from "./layout.js";
import type { Prompter } from "./prompt.js";
import { ACCESS_MODES, readState, writeState, type AccessMode, type InstallState } from "./state.js";
import type { System } from "./system.js";
import { PlainUi, type SummaryItem, type Ui } from "./ui.js";
import { ownerLink } from "./server-api.js";
import { refreshModelPrices } from "./model-prices.js";
import {
  asterConfigWithProvider, describeProvider, hotcellKeysAddArgs, isKeyless, KNOWN_PROVIDERS, OPENROUTER, openrouterAnswer, parseHotcellRoutes,
  parseProviderAnswer, providerConfig, providerFromAsterConfig, type ProviderAnswer,
} from "./provider.js";
import { installedVersion, packageSpecs, pinnedAutopilotVersion } from "./versions.js";

export interface UpOptions {
  prompter: Prompter;
  /** Where progress shows; a plain line per event when omitted. */
  ui?: Ui;
  /**
   * Answers for unattended installs: DL_TAILSCALE_AUTH_KEY, DL_PROVIDER + DL_PROVIDER_API_KEY
   * (+ DL_PROVIDER_BASE_URL for a custom one; DL_OPENROUTER_API_KEY is the OpenRouter shorthand), DL_GITHUB_TOKEN.
   * DL_ACCESS=loopback skips Tailscale (SSH tunnel access); DL_SKIP_CREDENTIAL_CHECK=1 skips online validation.
   * DL_AUTOPILOT_SPEC / DL_HOTCELL_SPEC install an npm spec or .tgz instead of the pinned versions (development).
   */
  env?: NodeJS.ProcessEnv;
  /** How the server is reached (`--access`); overrides DL_ACCESS and what an earlier `up` chose. */
  access?: AccessMode;
  /**
   * Answers sent by the laptop (`--answers-stdin`). When given, they replace the DL_* answers
   * and nothing is asked: a required answer that's missing is a failure.
   */
  answers?: ProvidedAnswers;
  /** `--autopilot-version`; the version dl ships with otherwise, so laptop and server match. */
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
  provider: ProviderAnswer | undefined;
  githubToken: string | undefined;
}

/**
 * What the laptop sends on stdin: `{"provider"?: {id, baseUrl, apiKey, apiKeyEnv, …}, "githubToken"?,
 * "tailscaleAuthKey"?}`. An older laptop's `"openrouterKey"` is taken as the OpenRouter provider.
 */
export interface ProvidedAnswers {
  provider?: ProviderAnswer;
  githubToken?: string;
  tailscaleAuthKey?: string;
}

/** An answer `up` still lacks, as `dl up --needs` names it. */
export type Need = "tailscale" | "provider" | "github";

/** A validation outcome: a problem to show, or a detail to confirm the answer with. */
export interface Checked { problem?: string; detail?: string }

const DRY_RUN_BRIDGE_IP = "172.17.0.1";
const DRY_RUN_URL = "https://<this-machine>.<tailnet>.ts.net";

/** `dl up`: install or repair Hotcell + Autopilot as services. Safe to re-run. */
export async function up(system: System, options: UpOptions): Promise<UpResult> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const ui = options.ui ?? new PlainUi((text) => { for (const line of text.replace(/\n$/, "").split("\n")) system.log(line); });

  // install.sh already showed the title on this screen.
  if (env.DL_TITLE_SHOWN !== "1") ui.title("Directionally Local");
  let facts = await detectHost(system);
  const problems = preflightProblems(facts);
  if (problems.length > 0) {
    ui.line("failed", "This machine can't run it yet");
    throw new Error(`Can't install here:\n  - ${problems.join("\n  - ")}`);
  }
  ui.line("done", "Checked this machine", `${facts.os.prettyName.replace(/ LTS$/, "")} · ${facts.cpus} CPU · ${(facts.memoryMb / 1024).toFixed(1)} GB · ${facts.diskFreeGb} GB free`);

  // Every question comes first, so the long part runs unattended.
  const previous = await readState(system);
  const access = accessMode(options.access, env, previous);
  const check = env.DL_SKIP_CREDENTIAL_CHECK === "1" ? undefined : fetchImpl;
  const answers = await collectAnswers(system, ui, options.prompter, given(env, options.answers), check, facts, access);

  ui.plan([
    ...(access === "tailscale" ? [{ id: "tailnet", label: "Joining your tailnet" }] : []),
    { id: "docker", label: "Setting up Docker" },
    { id: "software", label: "Installing Hotcell + Autopilot" },
    { id: "image", label: "Building the sandbox image" },
    { id: "services", label: "Starting services" },
    { id: "access", label: access === "tailscale" ? "Opening private access" : "Starting the server" },
  ]);
  const step = async <T>(id: string, work: () => Promise<{ value: T; detail?: string }>): Promise<T> => {
    ui.start(id);
    try {
      const { value, detail } = await work();
      ui.done(id, detail);
      return value;
    } catch (error) {
      ui.fail(id, (error as Error).message);
      throw error;
    }
  };

  if (access === "tailscale") {
    await step("tailnet", async () => ({ value: undefined, detail: await joinTailnet(system, answers.tailscaleAuthKey) }));
  }

  const bridgeIp = await step("docker", async () => {
    let detail = "already running";
    if (!facts.docker) {
      // An installed Docker (Ubuntu's docker.io or Docker's docker-ce) is started, never
      // replaced: get.docker.com swapping packages under a running install is how the socket
      // and service fall out of step.
      if (facts.dockerInstalled) {
        detail = "was installed; started it";
      } else {
        await system.run("sh", ["-c", "curl -fsSL https://get.docker.com | sh"], { inherit: true, describe: "install Docker (get.docker.com)" });
        detail = "installed";
      }
      await startDocker(system, sleep);
      facts = await detectHost(system);
    }
    const ip = facts.dockerBridgeIp ?? (system.dryRun ? DRY_RUN_BRIDGE_IP : undefined);
    if (!ip) throw new Error("Docker is running but its docker0 bridge has no IPv4 address; sandboxes couldn't reach the gateway.");
    return { value: ip, detail };
  });

  const { autopilotVersion, hotcellVersion, release, specs } = await step("software", async () => {
    await ensureAutomaticUpdates(system, ui);
    await ensureUser(system, USERS.hotcell, PATHS.hotcellHome, ["docker"]);
    await ensureUser(system, USERS.autopilot, PATHS.autopilotHome, []);
    // The same Autopilot the laptop's dl bundles; Hotcell's newest.
    const specs = packageSpecs({ autopilot: options.autopilotVersion ?? pinnedAutopilotVersion(), hotcell: options.hotcellVersion ?? await latestVersion(system, "hotcell") }, env);
    const name = `autopilot-${specs.autopilotLabel}_hotcell-${specs.hotcellLabel}`;
    const releaseDir = `${PATHS.releases}/${name}`;
    if (specs.dev || !(await system.exists(`${releaseDir}/node_modules/autopilot-ai/package.json`) && await system.exists(`${releaseDir}/node_modules/hotcell/package.json`))) {
      await system.mkdir(releaseDir, { mode: 0o755 });
      await system.run("npm", ["install", "--prefix", releaseDir, "--no-audit", "--no-fund", "--omit=dev", specs.autopilot, specs.hotcell], { inherit: true });
    }
    await system.run("ln", ["-sfn", releaseDir, PATHS.current]);
    const autopilot = specs.dev ? installedVersion(await system.readFile(`${releaseDir}/node_modules/autopilot-ai/package.json`), specs.autopilotLabel) : specs.autopilotLabel;
    const hotcell = specs.dev ? installedVersion(await system.readFile(`${releaseDir}/node_modules/hotcell/package.json`), specs.hotcellLabel) : specs.hotcellLabel;
    // Store the keys as soon as their homes exist, so a later failure never asks again.
    if (answers.provider) {
      // Into Hotcell's keystore over stdin: never in argv, env files, or Autopilot's config.
      const args = hotcellKeysAddArgs(answers.provider);
      await asHotcell(system, args, { ...(answers.provider.apiKey ? { input: answers.provider.apiKey } : {}), describe: `hotcell ${args.join(" ")} (as hotcell)` });
    }
    await system.mkdir(PATHS.autopilotEtc, { mode: 0o750, owner: `root:${USERS.autopilot}` });
    if (answers.githubToken) {
      await system.writeFile(PATHS.githubEnv, githubEnv(answers.githubToken), { mode: 0o640, owner: `root:${USERS.autopilot}`, secret: true });
    }
    return { value: { autopilotVersion: autopilot, hotcellVersion: hotcell, release: name, specs }, detail: `Autopilot ${autopilot} · Hotcell ${hotcell}` };
  });

  const image = cellImage(specs.autopilotLabel);
  await step("image", async () => ({ value: undefined, detail: await ensureCellImage(system, image, specs) ? "already built" : `Node 24 · Autopilot ${autopilotVersion}` }));

  const hotcellApiKey = await step("services", async () => {
    const hotcellValues = parseEnvFile(await system.readFile(PATHS.hotcellEnv));
    const apiKey = hotcellValues.HOTCELL_API_KEY || randomBytes(24).toString("hex");
    await system.mkdir(PATHS.hotcellEtc, { mode: 0o750, owner: `root:${USERS.hotcell}` });
    // Read once at Hotcell's start, so it's in place before the restart below.
    const prices = await refreshModelPrices(system, {
      path: PATHS.modelPrices,
      write: { mode: 0o644, owner: `${USERS.hotcell}:${USERS.hotcell}` },
      fetchImpl,
      warn: (text) => ui.warn(text),
      retry: "dl up",
    });
    await system.writeFile(PATHS.hotcellEnv, hotcellEnv({ apiKey, bridgeIp }), { mode: 0o640, owner: `root:${USERS.hotcell}`, secret: true });
    // The provider goes into aster.json next to the key; an install without one keeps the default (OpenRouter).
    const existingAster = await system.readFile(PATHS.asterConfig);
    if (answers.provider) {
      await system.writeFile(PATHS.asterConfig, asterConfigWithProvider(existingAster, providerConfig(answers.provider), asterConfigDefaults()), { mode: 0o640, owner: `root:${USERS.autopilot}` });
    } else if (!existingAster) {
      await system.writeFile(PATHS.asterConfig, asterConfig(), { mode: 0o640, owner: `root:${USERS.autopilot}` });
    }
    await ensureWorkspace(system);
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
    return { value: apiKey, detail: `sandboxes and keys ready${prices ? ` · ${prices}` : ""}` };
  });

  const url = await step("access", async () => {
    // Moving off Tailscale: stop publishing on the tailnet, so the only way in is the new one.
    if (access !== "tailscale" && previous?.access.mode === "tailscale") {
      await system.run("tailscale", ["serve", "--https=443", `http://127.0.0.1:${AUTOPILOT_PORT}`, "off"], { allowFailure: true });
    }
    const address = access === "tailscale" ? await serveOverTailscale(system) : `http://127.0.0.1:${AUTOPILOT_PORT}`;
    await system.writeFile(PATHS.autopilotEnv, autopilotEnv({ hotcellApiKey, image, bridgeIp, publicUrl: address }), { mode: 0o640, owner: `root:${USERS.autopilot}`, secret: true });
    await system.run("systemctl", ["enable", SERVICES.autopilot]);
    await system.run("systemctl", ["restart", SERVICES.autopilot]);
    // Without a token the Aster API answers 401: the server is up and refusing strangers.
    await waitUntil(system, sleep, "Autopilot", async () =>
      (await system.probe("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", `http://127.0.0.1:${AUTOPILOT_PORT}/api/v1/health`])).stdout.trim() === "401");
    // The API only listens on this machine: say who can reach it rather than a loopback address.
    const reach = access === "tailscale" ? address.replace(/^https?:\/\//, "") : access === "ssh" ? "private · reached over SSH" : "private · this machine only";
    return { value: address, detail: reach };
  });

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

  const capacity = agentCapacity(facts, CELL_MEMORY_MB);
  if (access === "ssh") {
    // The laptop set this up, pairs itself (`dl pair`), and prints its own summary, so there's
    // no browser link to make: a one-time owner link would only be a secret in its output.
    await installLoginStatus(system);
    ui.ready("Ready", [{ label: "On your laptop, from inside a GitHub repository", value: 'dl run "fix the flaky checkout test"' }]);
    return { url, ownerLink: undefined, capacity, state };
  }
  const link = await ownerLink(system, url);
  await installLoginStatus(system);
  ui.ready("Ready", nextSteps({ url, ownerLink: link, access }), {
    about: [
      "This server now runs coding agents for you. Send it a task from your laptop:",
      "it works in its own sandbox, opens a pull request, and keeps going while",
      `your laptop is closed. It fits ~${capacity} at once (estimate).`,
    ],
    footer: "Forgot any of this? Type  dl  on this server.",
  });
  return { url, ownerLink: link, capacity, state };
}

/** What to do next, shown at the end of `dl up` and by `dl connect-laptop`. */
export function nextSteps(input: { url: string; ownerLink: string | undefined; access: AccessMode }): SummaryItem[] {
  const reach = input.access === "tailscale"
    ? "On your laptop (signed in to the same tailnet)"
    : `On your laptop, after: ssh -N -L ${AUTOPILOT_PORT}:127.0.0.1:${AUTOPILOT_PORT} root@<this-server>`;
  return [
    ...(input.ownerLink ? [{ label: "Open this once in your laptop's browser, so it can approve laptops", value: input.ownerLink }] : []),
    { label: `${reach}, connect it`, value: `npm install -g directionallylocal\ndl connect ${input.url}` },
    { label: "Send it a task, from inside a GitHub repository", value: `dl run "fix the flaky checkout test"\ndl runs                 see progress and pull requests` },
  ];
}

/** A short status line when someone logs in, so a server visited weeks later explains itself. */
async function installLoginStatus(system: System): Promise<void> {
  if (!(await system.exists("/etc/update-motd.d"))) return;
  await system.writeFile(MOTD_SCRIPT, motdScript(), { mode: 0o755 });
}

/** Checks an access mode named by `--access` or DL_ACCESS. */
export function parseAccessMode(value: string, source = "--access"): AccessMode {
  const mode = ACCESS_MODES.find((entry) => entry === value);
  if (mode) return mode;
  throw new Error(`${source} must be ${ACCESS_MODES.join(", ").replace(/, ([^,]+)$/, " or $1")} (got "${value}"); an own domain and the instant address are coming.`);
}

/** The flag wins, then DL_ACCESS, then what the last `up` chose; Tailscale on a fresh machine. */
function accessMode(flag: AccessMode | undefined, env: NodeJS.ProcessEnv, previous: InstallState | undefined): AccessMode {
  if (flag) return flag;
  const requested = env.DL_ACCESS?.trim();
  if (requested === undefined || requested === "") return previous?.access.mode ?? "tailscale";
  return parseAccessMode(requested, "DL_ACCESS");
}

/**
 * `dl up --needs`: the answers a real `up` would require on this machine, without asking for
 * or changing anything (it only reads files and runs read-only probes). The laptop asks for
 * exactly these before it starts the install. Answers in DL_* variables don't count: the
 * laptop's `up` takes its answers from stdin.
 */
export async function needs(system: System, options: { access?: AccessMode; env?: NodeJS.ProcessEnv } = {}): Promise<Need[]> {
  const access = accessMode(options.access, options.env ?? process.env, await readState(system));
  const missing = await missingAnswers(system, await detectHost(system), access);
  return (["tailscale", "provider", "github"] as const).filter((need) => missing[need]);
}

/**
 * Which answers this machine still lacks: a model provider unless Hotcell has an active route
 * for the one aster.json names, a GitHub token unless its env file has one, a Tailscale key
 * only for Tailscale access off a tailnet.
 */
async function missingAnswers(system: System, facts: HostFacts, access: AccessMode): Promise<Record<Need, boolean>> {
  const tailscaleRunning = access !== "tailscale" || (facts.tailscale && await tailscaleIsUp(system));
  return {
    tailscale: !tailscaleRunning,
    provider: !(await hotcellHasKey(system, providerFromAsterConfig(await system.readFile(PATHS.asterConfig)).id)),
    github: !parseEnvFile(await system.readFile(PATHS.githubEnv)).GITHUB_TOKEN,
  };
}

/** Answers given up front, and where they came from (shown next to each, never the value). */
interface Given {
  tailscaleAuthKey: string | undefined;
  provider: ProviderAnswer | undefined;
  /** DL_PROVIDER without a key: the provider to ask a key for. */
  providerId: string | undefined;
  githubToken: string | undefined;
  /** Said next to an accepted answer, e.g. "from the environment". */
  source: string;
  /** Nothing may be asked: the answers came from the laptop, and there's no terminal. */
  final: boolean;
}

function given(env: NodeJS.ProcessEnv, provided: ProvidedAnswers | undefined): Given {
  if (provided) {
    return { tailscaleAuthKey: provided.tailscaleAuthKey, provider: provided.provider, providerId: undefined, githubToken: provided.githubToken, source: "from your laptop", final: true };
  }
  return { tailscaleAuthKey: env.DL_TAILSCALE_AUTH_KEY, ...providerFromEnv(env), githubToken: env.DL_GITHUB_TOKEN, source: "from the environment", final: false };
}

/**
 * DL_PROVIDER + DL_PROVIDER_API_KEY (+ DL_PROVIDER_BASE_URL for one Hotcell has no route for),
 * or the OpenRouter shorthand DL_OPENROUTER_API_KEY.
 */
export function providerFromEnv(env: NodeJS.ProcessEnv): { provider: ProviderAnswer | undefined; providerId: string | undefined } {
  const id = env.DL_PROVIDER?.trim().toLowerCase();
  const key = env.DL_PROVIDER_API_KEY?.trim();
  const baseUrl = env.DL_PROVIDER_BASE_URL?.trim();
  if (id) {
    // Without an address for a provider Hotcell has no route for, or a key for one that needs it, there's nothing to store yet.
    if (!KNOWN_PROVIDERS[id] && !baseUrl) return { provider: undefined, providerId: id };
    if (!key && !isKeyless({ id, apiKey: null })) return { provider: undefined, providerId: id };
    return { provider: parseProviderAnswer({ id, ...(key ? { apiKey: key } : {}), ...(baseUrl ? { baseUrl } : {}) }), providerId: id };
  }
  const openrouter = env.DL_OPENROUTER_API_KEY?.trim();
  return { provider: openrouter ? openrouterAnswer(openrouter) : undefined, providerId: undefined };
}

/**
 * The answers from `--answers-stdin`. Parse errors never quote the input: it holds keys.
 * Unknown fields are ignored, so a newer laptop can send more than this server knows; an
 * older laptop's `openrouterKey` becomes the OpenRouter provider.
 */
export function parseProvidedAnswers(text: string): ProvidedAnswers {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("The answers on stdin aren't valid JSON; expected one object like {\"provider\": {\"id\": \"deepseek\", \"apiKey\": \"…\"}}.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("The answers on stdin must be one JSON object.");
  const record = parsed as Record<string, unknown>;
  const answers: ProvidedAnswers = {};
  const strings: Partial<Record<"openrouterKey" | "githubToken" | "tailscaleAuthKey", string>> = {};
  for (const key of ["openrouterKey", "githubToken", "tailscaleAuthKey"] as const) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") throw new Error(`The answer "${key}" on stdin must be a string.`);
    strings[key] = value;
  }
  if (strings.githubToken !== undefined) answers.githubToken = strings.githubToken;
  if (strings.tailscaleAuthKey !== undefined) answers.tailscaleAuthKey = strings.tailscaleAuthKey;
  if (record.provider !== undefined && record.provider !== null) answers.provider = parseProviderAnswer(record.provider);
  else if (strings.openrouterKey) answers.provider = openrouterAnswer(strings.openrouterKey);
  return answers;
}

async function collectAnswers(
  system: System,
  ui: Ui,
  prompter: Prompter,
  provided: Given,
  fetchImpl: typeof fetch | undefined,
  facts: HostFacts,
  access: AccessMode,
): Promise<Answers> {
  const missing = await missingAnswers(system, facts, access);
  if (system.dryRun) {
    return {
      tailscaleAuthKey: missing.tailscale ? "<asked>" : undefined,
      provider: missing.provider ? openrouterAnswer("<asked>") : undefined,
      githubToken: missing.github ? "<asked>" : undefined,
    };
  }
  const typed = provided.final ? 0 : [
    missing.tailscale && !provided.tailscaleAuthKey,
    missing.provider && !provided.provider,
    missing.github && !provided.githubToken,
  ].filter(Boolean).length;
  if (typed > 0) ui.questions(`${typed === 1 ? "One key" : `${typed} keys`}, then it runs on its own. Typing is hidden.`);
  // With final answers there's no one to ask. The laptop installs first and sends the keys in a
  // second pass (after Autopilot's own provider picker), so a missing key isn't a failure there.
  const asking = (ask: () => Promise<string>) => provided.final ? undefined : ask;
  const optional = provided.final;

  const tailscaleAuthKey = !missing.tailscale ? undefined : await askValidated(ui,
    provided.tailscaleAuthKey,
    provided.source,
    "Tailscale auth key",
    asking(() => prompter.secret(ui.prompt("Tailscale auth key", "login.tailscale.com/admin/settings/keys"))),
    async (value) => /^tskey-[A-Za-z0-9-]+$/.test(value) ? {} : { problem: "That doesn't look like a Tailscale auth key (tskey-…)." },
  );
  // A given provider always replaces the stored one (the laptop's `dl provider`); otherwise only a missing one is asked for.
  let provider: ProviderAnswer | undefined;
  if (provided.provider || missing.provider) {
    // On the server's own terminal only a key is typed: OpenRouter's, or DL_PROVIDER's.
    const asked = provided.providerId && KNOWN_PROVIDERS[provided.providerId] ? { id: provided.providerId, ...KNOWN_PROVIDERS[provided.providerId]! } : { id: OPENROUTER.id, ...KNOWN_PROVIDERS[OPENROUTER.id]! };
    const label = `${provided.provider ? describeProvider({ id: provided.provider.id, ...(provided.provider.name ? { name: provided.provider.name } : {}) }) : asked.name} API key`;
    const key = await askValidated(ui,
      provided.provider ? provided.provider.apiKey ?? "(none)" : undefined,
      provided.source,
      label,
      asking(() => prompter.secret(ui.prompt(label, "stays in Hotcell; sandboxes and laptops never see it"))),
      async (value) => validateProviderKey(provided.provider ?? { ...asked, apiKey: value }, value, fetchImpl),
      optional,
    );
    if (key !== undefined) provider = provided.provider ?? parseProviderAnswer({ id: asked.id, apiKey: key });
  }
  const githubToken = !missing.github ? undefined : await askValidated(ui,
    provided.githubToken,
    provided.source,
    "GitHub token",
    asking(() => prompter.secret(ui.prompt("GitHub token", "fine-grained · Contents + Pull requests read/write"))),
    (value) => validateGitHubToken(value, fetchImpl),
    optional,
  );
  return { tailscaleAuthKey, provider, githubToken };
}

/** OpenRouter keys have a shape and an endpoint to check; other providers' keys are taken as given, keyless ones need none. */
export async function validateProviderKey(provider: Pick<ProviderAnswer, "id" | "apiKey">, key: string, fetchImpl: typeof fetch | undefined): Promise<Checked> {
  if (provider.id === OPENROUTER.id) {
    const problem = await validateOpenRouterKey(key, fetchImpl);
    return problem ? { problem } : { detail: "kept in Hotcell" };
  }
  if (isKeyless(provider)) return { detail: "no key needed" };
  if (!key.trim() || key === "(none)") return { problem: `A key for ${provider.id} is required.` };
  return { detail: "kept in Hotcell" };
}

/**
 * Takes a given answer as-is (failing fast if invalid) or asks up to three times. Without a
 * way to ask (answers from the laptop), a missing answer is noted and left for the laptop's
 * second pass when `optional`, and a failure otherwise.
 */
async function askValidated(ui: Ui, fromEnv: string | undefined, source: string, label: string, ask: (() => Promise<string>) | undefined, validate: (value: string) => Promise<Checked>): Promise<string>;
async function askValidated(ui: Ui, fromEnv: string | undefined, source: string, label: string, ask: (() => Promise<string>) | undefined, validate: (value: string) => Promise<Checked>, optional: boolean): Promise<string | undefined>;
async function askValidated(
  ui: Ui,
  fromEnv: string | undefined,
  source: string,
  label: string,
  ask: (() => Promise<string>) | undefined,
  validate: (value: string) => Promise<Checked>,
  optional = false,
): Promise<string | undefined> {
  if (fromEnv) {
    const { problem, detail } = await validate(fromEnv.trim());
    if (problem) throw new Error(problem);
    ui.line("done", label, detail ? `${detail} · ${source}` : source);
    return fromEnv.trim();
  }
  if (!ask) {
    if (optional) {
      ui.line("info", label, "not set yet");
      return undefined;
    }
    ui.line("failed", label, "not given");
    throw new Error(`This server needs ${/^[AEIOU]/.test(label) ? "an" : "a"} ${label} and none was given ${source.replace(/^from/, "by")}.`);
  }
  for (let attempt = 1; ; attempt++) {
    const value = (await ask()).trim();
    const { problem, detail } = value ? await validate(value) : { problem: "An answer is required.", detail: undefined };
    if (!problem) {
      ui.answered(label, detail);
      return value;
    }
    if (attempt >= 3) {
      ui.rejected(problem);
      throw new Error(problem);
    }
    ui.rejected(`${problem} Try again.`);
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

export async function validateGitHubToken(token: string, fetchImpl: typeof fetch | undefined): Promise<Checked> {
  if (!/^(github_pat_|ghp_|gho_)[A-Za-z0-9_]{20,}$/.test(token)) return { problem: "That doesn't look like a GitHub token (github_pat_… or ghp_…)." };
  if (!fetchImpl) return {};
  try {
    const response = await fetchImpl("https://api.github.com/user", { headers: { Authorization: `Bearer ${token}`, "User-Agent": "directionallylocal" } });
    if (response.status === 401) return { problem: "GitHub rejected that token." };
    if (response.ok) {
      const user = await response.json() as { login?: string };
      if (user.login) return { detail: `signed in as ${user.login}` };
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Ubuntu's unattended-upgrades only patches Ubuntu's own packages, so Node.js from
 * NodeSource would never pick up a security release by itself. Docker's repo is left out
 * on purpose: it ships major upgrades, and restarting dockerd can stop running sandboxes.
 */
async function ensureAutomaticUpdates(system: System, ui: Ui): Promise<void> {
  const installed = await system.probe("dpkg-query", ["-W", "-f=${Status}", "unattended-upgrades"]);
  if (!installed.stdout.includes("install ok installed")) {
    await system.run("apt-get", ["install", "-y", "-qq", "unattended-upgrades"], { env: { DEBIAN_FRONTEND: "noninteractive" } });
  }
  // Keep an operator's own schedule; only turn the daily run on where it's missing.
  if (!(await system.readFile(AUTO_UPGRADES))) await system.writeFile(AUTO_UPGRADES, autoUpgrades());
  if ((await system.probe("apt-cache", ["policy", "nodejs"])).stdout.includes("deb.nodesource.com")) {
    await system.writeFile(NODE_AUTO_UPDATES, nodeAutoUpdates());
  } else {
    ui.warn("Node.js isn't from NodeSource here, so it won't update itself; keep it at 22.23.4+, 24.22.1+ or 26.12.1+.");
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

export function asHotcell(system: System, args: string[], options: { input?: string; describe?: string } = {}) {
  return system.run("runuser", [
    "-u", USERS.hotcell, "--", "env", `HOTCELL_HOME=${PATHS.hotcellHome}`, "HOTCELL_KEYSTORE=file",
    "/usr/bin/node", hotcellBin(), ...args,
  ], options);
}

/** Hotcell's routes, from `hotcell keys ls --json` (as the hotcell user); empty when Hotcell isn't installed. */
export async function hotcellRoutes(system: System): Promise<import("./provider.js").HotcellRoute[]> {
  if (!(await system.exists(hotcellBin()))) return [];
  const result = await system.probe("runuser", [
    "-u", USERS.hotcell, "--", "env", `HOTCELL_HOME=${PATHS.hotcellHome}`, "HOTCELL_KEYSTORE=file", "NO_COLOR=1", "/usr/bin/node", hotcellBin(), "keys", "ls", "--json",
  ]);
  return result.code === 0 ? parseHotcellRoutes(result.stdout) : [];
}

/** Whether Hotcell has an active route for the provider. */
export async function hotcellHasKey(system: System, provider: string): Promise<boolean> {
  return (await hotcellRoutes(system)).some((route) => route.provider === provider && route.active);
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

/** Builds the sandbox image unless it exists (a dev spec is always rebuilt); returns whether it already did. */
async function ensureCellImage(system: System, image: string, specs: { autopilot: string; dev: boolean }): Promise<boolean> {
  if (!specs.dev && (await system.probe("docker", ["image", "inspect", image])).code === 0) return true;
  const dir = system.dryRun ? "/tmp/directionallylocal-image" : (await system.run("mktemp", ["-d"])).stdout.trim();
  try {
    await system.run("npm", ["pack", specs.autopilot, "--pack-destination", dir, "--silent"]);
    await system.run("sh", ["-c", `mv ${dir}/autopilot-ai-*.tgz ${dir}/autopilot.tgz`]);
    await system.writeFile(`${dir}/Dockerfile`, cellDockerfile());
    await system.run("docker", ["build", "--pull", "-q", "-t", image, dir], { inherit: true });
  } finally {
    await system.remove(dir);
  }
  return false;
}

/** With UFW on, sandboxes still need the gateway and GitHub proxy on the bridge address. */
async function allowBridgePorts(system: System, bridgeIp: string): Promise<void> {
  const status = await system.probe("ufw", ["status"]);
  if (status.code !== 0 || !/Status: active/.test(status.stdout)) return;
  for (const port of [HOTCELL_EGRESS_PORT, GITHUB_PROXY_PORT]) {
    await system.run("ufw", ["allow", "in", "on", "docker0", "to", bridgeIp, "port", String(port), "proto", "tcp", "comment", "directionallylocal sandboxes"]);
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

/**
 * Joins the tailnet right after the questions, before the long steps: the auth key is
 * used at once, so a later failure never has to ask for it again (it's never kept on disk).
 */
async function joinTailnet(system: System, authKey: string | undefined): Promise<string> {
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
  if (system.dryRun) return "on your tailnet";
  const status = await system.probe("tailscale", ["status", "--json"]);
  const name = (JSON.parse(status.stdout || "{}") as { Self?: { DNSName?: string } }).Self?.DNSName?.replace(/\.$/, "");
  return name ? `${authKey ? "joined as" : "already on it as"} ${name.split(".")[0]}` : "joined";
}

/** Serves Autopilot on the machine's HTTPS ts.net name; returns that URL. */
async function serveOverTailscale(system: System): Promise<string> {
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

export async function waitUntil(system: System, sleep: (ms: number) => Promise<void>, what: string, ready: () => Promise<boolean>, unit = what.toLowerCase()): Promise<void> {
  if (system.dryRun) return;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await ready()) return;
    await sleep(1_000);
  }
  throw new Error(`${what} didn't come up; check: journalctl -u ${unit} -n 50`);
}

function machineName(): string {
  return hostname().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "directionallylocal";
}
