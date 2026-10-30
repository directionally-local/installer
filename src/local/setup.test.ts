import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ScriptedPrompter } from "../prompt.js";
import { RecordingUi, palette } from "../ui.js";
import { computerProblems, checkComputer, stableNodePath, type ComputerFacts } from "./check.js";
import { formatLocalStatus } from "./cli.js";
import { launchAgentPlist, localEnvFile, localPaths, parseLocalEnvFile, serviceSpecs, systemdUserUnit, PREFERRED_PORTS } from "./layout.js";
import { localStatus, setUpOnThisComputer, uninstallFromThisComputer, type LocalOptions } from "./setup.js";
import { FakeComputer } from "./test-support/fake-computer.js";
import { withCatalog } from "../test-support/fake-catalog.js";
import { openrouterAnswer, type ProviderAnswer } from "../provider.js";
import { pinnedAutopilotVersion } from "../versions.js";

const OPENROUTER_KEY = `sk-or-v1-${"a".repeat(40)}`;
const OPENROUTER = openrouterAnswer(OPENROUTER_KEY);
const DEEPSEEK: ProviderAnswer = { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKey: "sk-deepseek-0000000000", apiKeyEnv: "DEEPSEEK_API_KEY" };
const GITHUB_TOKEN = `github_pat_${"b".repeat(40)}`;
const AUTOPILOT = pinnedAutopilotVersion();
const HOME = "/Users/ada";
const ROOT = `${HOME}/.directionallylocal`;
const CELLAR_NODE = "/opt/homebrew/Cellar/node/24.22.1/bin/node";
const NODE = "/opt/homebrew/opt/node/bin/node";

function options(system: FakeComputer, extra: Partial<LocalOptions> = {}): LocalOptions {
  return {
    system,
    home: system.home,
    platform: "darwin",
    arch: "arm64",
    env: {},
    execPath: CELLAR_NODE,
    nodeVersion: "24.22.1",
    hostname: "Adas-MacBook-Air.local",
    sleep: async () => {},
    now: () => new Date("2026-10-28T10:00:00Z"),
    fetchImpl: withCatalog(fetchNothing),
    ...extra,
  };
}

/** `answers: null` installs without any keys, as the wizard does before Autopilot's picker. */
async function setUp(system: FakeComputer, extra: Partial<LocalOptions> = {}, ui = new RecordingUi(), answers: { provider?: ProviderAnswer; githubToken?: string } | null = { provider: OPENROUTER, githubToken: GITHUB_TOKEN }) {
  const { remote, capacity, needs } = await setUpOnThisComputer({
    ui,
    prompter: new ScriptedPrompter({}),
    ...(answers ? { answers } : {}),
    ...options(system, extra),
  });
  return { remote, capacity, needs, ui };
}

/** Only OpenRouter's model list is fetched during setup. */
const fetchNothing = (async (url: string | URL | Request) => { throw new Error(`unexpected fetch ${String(url)}`); }) as typeof fetch;

const env = (system: FakeComputer, name: string) => parseLocalEnvFile(system.files.get(`${ROOT}/config/${name}`)?.content);

describe("on this computer: checks", () => {
  const healthy = (): ComputerFacts => ({
    platform: "darwin",
    osName: "macOS 15.1",
    arch: "arm64",
    node: { path: NODE, version: "24.22.1" },
    git: "2.50.1",
    diskFreeGb: 100,
    dockerCli: "/usr/local/bin/docker",
    docker: { host: "unix:///x.sock", runtime: "Docker Desktop", version: "29.5.2", memoryMb: 8192, cpus: 8 },
    dockerApp: undefined,
    bridgeIp: undefined,
    systemdUser: false,
    dockerDenied: false,
  });

  it("passes a ready Mac and names a fix for each problem", () => {
    assert.deepEqual(computerProblems(healthy()), []);
    const broken = computerProblems({ ...healthy(), node: { path: NODE, version: "24.10.0" }, git: undefined, docker: undefined, dockerCli: undefined, diskFreeGb: 4 });
    assert.equal(broken.length, 4);
    assert.match(broken[0]!, /CVE-2026-111497[\s\S]*brew upgrade node/);
    assert.match(broken[1]!, /xcode-select --install/);
    assert.match(broken[2]!, /Docker Desktop[\s\S]*OrbStack[\s\S]*colima/);
    assert.match(broken[3]!, /10 GB of free disk/);
    assert.match(computerProblems({ ...healthy(), docker: undefined, dockerApp: "OrbStack" })[0]!, /OrbStack is installed but didn't start/);
  });

  it("refuses other platforms, and Linux without a user session or Docker access", () => {
    assert.match(computerProblems({ ...healthy(), platform: "win32" })[0]!, /isn't supported on Windows yet; connect a server instead[\s\S]*WSL 2/);
    assert.match(computerProblems({ ...healthy(), platform: "freebsd" })[0]!, /macOS and Linux, not freebsd[\s\S]*Connect a server/);
    const linux = computerProblems({ ...healthy(), platform: "linux", systemdUser: false, docker: undefined, dockerDenied: true });
    assert.match(linux[0]!, /systemd user session/);
    assert.match(linux[1]!, /usermod -aG docker/);
  });

  it("finds Docker Desktop's socket for the services, and respects DOCKER_HOST", async () => {
    const system = new FakeComputer();
    const facts = await checkComputer(system, { home: HOME, platform: "darwin", env: {}, execPath: CELLAR_NODE, nodeVersion: "24.22.1" });
    assert.equal(facts.docker?.host, `unix://${HOME}/.docker/run/docker.sock`);
    assert.equal(facts.docker?.runtime, "Docker Desktop");
    assert.equal(facts.docker?.memoryMb, 8192);
    assert.equal(facts.node.path, NODE, "Homebrew's opt link, not the Cellar path the next upgrade deletes");
    const custom = await checkComputer(system, { home: HOME, platform: "darwin", env: { DOCKER_HOST: `unix://${HOME}/.colima/default/docker.sock` }, execPath: NODE, nodeVersion: "24.22.1" });
    assert.equal(custom.docker?.host, `unix://${HOME}/.colima/default/docker.sock`);
    assert.equal(custom.docker?.runtime, "colima");
    assert.equal(await stableNodePath(system, "/usr/local/bin/node"), "/usr/local/bin/node");
  });

  it("refuses Windows before running anything at all: no checklist, no probes, no sh", async () => {
    const system = new FakeComputer();
    const ui = new RecordingUi();
    await assert.rejects(() => setUp(system, { platform: "win32" }, ui), /Running on this computer isn't supported on Windows yet; connect a server instead/);
    assert.deepEqual(system.commands, []);
    assert.deepEqual(system.probes, []);
    assert.deepEqual(ui.events, []);
    await assert.rejects(() => localStatus(options(system, { platform: "win32" })), /isn't supported on Windows yet/);
    await assert.rejects(() => uninstallFromThisComputer({ ...options(system, { platform: "win32" }), ui }), /isn't supported on Windows yet/);
    assert.deepEqual(system.probes, [], "status and uninstall don't probe either");
  });

  it("refuses before changing anything: a vulnerable Node, root", async () => {
    for (const extra of [{ nodeVersion: "24.1.0" }]) {
      const system = new FakeComputer();
      const ui = new RecordingUi();
      await assert.rejects(() => setUp(system, extra, ui));
      assert.deepEqual(system.commands, [], "only read-only probes ran");
      assert.ok(ui.events.some((event) => event.startsWith("fail check")));
    }
    const root = new FakeComputer();
    root.uid = "0";
    await assert.rejects(() => setUp(root), /not as root or with sudo/);
  });

  it("opens Docker Desktop when it's installed but stopped", async () => {
    const system = new FakeComputer();
    system.docker = false;
    await setUp(system);
    assert.ok(system.ran.includes("open -g -a Docker"));
  });
});

describe("on this computer: setup", () => {
  it("installs into the home directory, keeps secrets out of argv and logs, and pairs", async () => {
    const system = new FakeComputer();
    const { remote, capacity, needs, ui } = await setUp(system);
    assert.equal(capacity, 6, "how many fit goes to the wizard's Ready line");
    assert.deepEqual(needs, [], "given both keys, nothing is left to ask");

    // Progress: the five steps, then the sleep note once.
    assert.deepEqual(ui.events.filter((event) => event.startsWith("done")).map((event) => event.split(" ")[1]), ["check", "software", "image", "services", "connect"]);
    const connected = ui.events.find((event) => event.startsWith("done connect"))!;
    assert.equal(connected, "done connect | this computer · tasks pause while it sleeps", "no loopback address on screen");
    assert.match(ui.events.find((event) => event.startsWith("done check"))!, /macOS 15\.1 · Docker Desktop 29\.5\.2 · Node 24\.22\.1 · 120 GB free/);

    // Release layout: a versioned release and a current link, all under ~/.directionallylocal.
    // Autopilot is the version this dl pins (the laptop's session client), Hotcell npm's latest.
    const release = `${ROOT}/releases/autopilot-${AUTOPILOT}_hotcell-0.1.30`;
    assert.ok(system.ran.includes(`npm install --prefix ${release} --no-audit --no-fund --omit=dev autopilot-ai@${AUTOPILOT} hotcell@0.1.30`), system.ran.join("\n"));
    assert.ok(!system.probes.some(({ command, args }) => command === "npm" && args.join(" ") === "view autopilot-ai version"), "never npm's latest Autopilot");
    assert.ok(system.ran.includes(`ln -sfn ${release} ${ROOT}/current`));
    for (const dir of [ROOT, `${ROOT}/config`, `${ROOT}/logs`, `${ROOT}/hotcell`, `${ROOT}/autopilot`]) assert.equal(system.dirs.get(dir), 0o700, dir);
    assert.ok(!system.ran.some((command) => /^(sudo|runuser) /.test(command)), "nothing runs as root");

    // The image: Node 24 + Autopilot, fresh base layers, through Docker Desktop's socket.
    assert.ok(system.images.has(`directionallylocal-cell:${AUTOPILOT}`));
    const build = system.commands.find(({ args }) => args[0] === "build")!;
    assert.ok(build.args.includes("--pull"));
    assert.equal(build.env?.DOCKER_HOST, `unix://${HOME}/.docker/run/docker.sock`);

    // The model key reaches Hotcell's file keystore over stdin only.
    const keysAdd = system.commands.find(({ args }) => args.includes("keys") && args.includes("add"))!;
    assert.equal(keysAdd.input, OPENROUTER_KEY);
    assert.equal(keysAdd.env?.HOTCELL_KEYSTORE, "file");
    assert.equal(keysAdd.env?.HOTCELL_HOME, `${ROOT}/hotcell`);
    assert.equal(system.hotcellKeys.get("openrouter"), OPENROUTER_KEY);
    const everything = [...system.commands, ...system.probes];
    for (const secret of [OPENROUTER_KEY, GITHUB_TOKEN, remote.token, env(system, "hotcell.env").HOTCELL_API_KEY!]) {
      assert.ok(!everything.some(({ command, args }) => [command, ...args].join(" ").includes(secret)), "no secret in any command line");
      assert.ok(!system.logs.some((line) => line.includes(secret)), "no secret in the output");
      assert.ok(!ui.events.some((line) => line.includes(secret)), "no secret on screen");
    }
    // ...and the key is stored before Hotcell starts, so the daemon loads it.
    assert.ok(system.commands.indexOf(keysAdd) < system.ran.findIndex((command) => command.startsWith("launchctl bootstrap")));

    // Env files: 0600; the GitHub token only in github.env; no model key in Autopilot's.
    for (const name of ["hotcell.env", "autopilot.env", "github.env", "aster.json"]) assert.equal(system.files.get(`${ROOT}/config/${name}`)?.mode, 0o600, name);
    assert.equal(env(system, "github.env").GITHUB_TOKEN, GITHUB_TOKEN);
    const hotcell = env(system, "hotcell.env");
    const autopilot = env(system, "autopilot.env");
    assert.equal(hotcell.HOTCELL_KEYSTORE, "file");
    assert.equal(hotcell.HOTCELL_HOST, "127.0.0.1");
    assert.equal(hotcell.HOTCELL_DRIVER, "container");
    assert.equal(hotcell.HOTCELL_EGRESS_HOST, "127.0.0.1", "Docker Desktop forwards host.docker.internal to loopback");
    assert.equal(hotcell.HOTCELL_EGRESS_ADVERTISE_HOST, "host.docker.internal");
    assert.match(hotcell.HOTCELL_API_KEY ?? "", /^[0-9a-f]{48}$/);
    assert.equal(autopilot.AUTOPILOT_HOTCELL_API_KEY, hotcell.HOTCELL_API_KEY);
    assert.equal(autopilot.AUTOPILOT_HOTCELL_ENDPOINT, "http://127.0.0.1:4750");
    assert.equal(autopilot.AUTOPILOT_PUBLIC_URL, "http://127.0.0.1:4096");
    assert.equal(autopilot.AUTOPILOT_ASTER_MEMORY, "off");
    assert.equal(autopilot.AUTOPILOT_HOTCELL_IMAGE, `directionallylocal-cell:${AUTOPILOT}`);
    assert.equal(autopilot.AUTOPILOT_ASTER_GITHUB_PROXY_LISTEN, "127.0.0.1:4760");
    assert.equal(autopilot.AUTOPILOT_ASTER_GITHUB_PROXY_URL, "http://host.docker.internal:4760");
    assert.equal(autopilot.GITHUB_TOKEN, undefined);
    assert.equal(autopilot.OPENROUTER_API_KEY, undefined);
    const aster = JSON.parse(system.files.get(`${ROOT}/config/aster.json`)!.content) as { models: string; provider: unknown; workspaces: Array<{ id: string; rootPath: string }> };
    assert.equal(aster.models, "catalog");
    assert.deepEqual(aster.provider, { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" });
    assert.deepEqual(aster.workspaces.map((workspace) => [workspace.id, workspace.rootPath]), [["default", `${ROOT}/autopilot/workspaces/default`]]);
    assert.ok(system.dirs.has(`${ROOT}/autopilot/workspaces/default/.git`), "the default workspace is a git repository");

    // LaunchAgents, started for this user, and a sandbox proved it reaches the gateway.
    for (const label of ["com.directionallylocal.hotcell", "com.directionallylocal.autopilot"]) {
      assert.ok(system.ran.includes(`launchctl bootstrap gui/501 ${HOME}/Library/LaunchAgents/${label}.plist`), label);
      assert.ok(system.running.has(label), label);
    }
    assert.ok(system.commands.some(({ args }) => args[0] === "run" && args.includes("host.docker.internal:host-gateway")));

    // Pairing: a 365-day credential from Autopilot's own CLI, against the service's database.
    const create = system.commands.find(({ args }) => args.includes("create") && args.includes("token"))!;
    assert.deepEqual(create.args.slice(1), ["aster", "token", "create", "--name", "Adas-MacBook-Air (this computer)", "--workspace", "default", "--expires-in-days", "365", "--json"]);
    assert.equal(create.command, NODE);
    assert.equal(create.env?.AUTOPILOT_ASTER_CONFIG, `${ROOT}/config/aster.json`);
    assert.equal(create.env?.AUTOPILOT_ASTER_DB, `${ROOT}/autopilot/aster.db`);
    assert.deepEqual(remote, {
      name: "this-computer",
      url: "http://127.0.0.1:4096",
      token: system.credentials[0]!.token,
      credentialId: "cred_1",
      expiresAt: "2027-10-28T10:00:00.000Z",
      addedAt: "2026-10-28T10:00:00.000Z",
    });
    const state = JSON.parse(system.files.get(`${ROOT}/state.json`)!.content) as Record<string, unknown>;
    assert.equal(state.kind, "this-computer");
    assert.equal(state.url, "http://127.0.0.1:4096");
    assert.equal(system.files.get(`${ROOT}/state.json`)!.mode, 0o600);
  });

  it("installs without keys and reports what the wizard still has to gather", async () => {
    const system = new FakeComputer();
    const { needs, ui } = await setUp(system, {}, new RecordingUi(), null);
    assert.deepEqual(needs, ["provider", "github"]);
    assert.ok(ui.events.includes("done connect | this computer · tasks pause while it sleeps"), "set up all the same");
    assert.equal(system.hotcellKeys.size, 0);
    const github = system.files.get(`${ROOT}/config/github.env`)!;
    assert.equal(github.mode, 0o600);
    assert.equal(parseLocalEnvFile(github.content).GITHUB_TOKEN, undefined, "exists (Autopilot starts with --env-file) but holds no token yet");
    const aster = JSON.parse(system.files.get(`${ROOT}/config/aster.json`)!.content) as { models: string; provider: unknown };
    assert.equal(aster.models, "openrouter");
    assert.equal(aster.provider, undefined, "the default until Autopilot's picker names one");
    assert.ok(system.running.has("com.directionallylocal.autopilot"));

    // A later run with the keys stores them and reports nothing missing; a keyless provider stores no key, a custom one its address.
    const again = await setUp(system, {}, new RecordingUi(), { provider: DEEPSEEK, githubToken: GITHUB_TOKEN });
    assert.deepEqual(again.needs, []);
    const add = system.commands.find(({ args }) => args.includes("keys") && args.includes("add"))!;
    assert.deepEqual(add.args.slice(1), ["keys", "add", "deepseek", "--stdin"]);
    assert.equal(add.input, DEEPSEEK.apiKey);
    assert.deepEqual((JSON.parse(system.files.get(`${ROOT}/config/aster.json`)!.content) as { provider: unknown }).provider, { id: "deepseek", baseUrl: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY" });
    const ollama = await setUp(system, {}, new RecordingUi(), { provider: { id: "ollama", baseUrl: "http://127.0.0.1:11434/v1", apiKey: null, apiKeyEnv: "OLLAMA_API_KEY" } });
    assert.deepEqual(ollama.needs, []);
    const keyless = system.commands.filter(({ args }) => args.includes("keys") && args.includes("add")).at(-1)!;
    assert.deepEqual(keyless.args.slice(1), ["keys", "add", "ollama"]);
    assert.equal(keyless.input, undefined);
    await setUp(system, {}, new RecordingUi(), { provider: { id: "myproxy", baseUrl: "https://llm.example.com/v1", apiKey: "k-1234567890", apiKeyEnv: "MYPROXY_API_KEY" } });
    const custom = system.commands.filter(({ args }) => args.includes("keys") && args.includes("add")).at(-1)!;
    assert.deepEqual(custom.args.slice(1), ["keys", "add", "myproxy", "--stdin", "--base-url", "https://llm.example.com/v1"]);
    assert.equal(system.hotcellRouteUrls.get("myproxy"), "https://llm.example.com/v1");
  });

  it("installs unpublished builds named by DL_AUTOPILOT_SPEC and DL_HOTCELL_SPEC", async () => {
    const system = new FakeComputer();
    const env = { DL_AUTOPILOT_SPEC: "/Users/ada/autopilot-ai-dev.tgz", DL_HOTCELL_SPEC: "/Users/ada/hotcell-dev.tgz" };
    const { ui } = await setUp(system, { env });
    assert.ok(system.ran.includes(`npm install --prefix ${ROOT}/releases/autopilot-dev_hotcell-dev --no-audit --no-fund --omit=dev /Users/ada/autopilot-ai-dev.tgz /Users/ada/hotcell-dev.tgz`), system.ran.join("\n"));
    assert.ok(system.ran.some((command) => command.startsWith("npm pack /Users/ada/autopilot-ai-dev.tgz ")), "the sandbox image is built from the same build");
    assert.ok(system.images.has("directionallylocal-cell:dev"));
    assert.ok(ui.events.includes("done software | Autopilot 9.9.9-dev.autopilot-ai · Hotcell 9.9.9-dev.hotcell"), ui.events.join("\n"));
    const state = JSON.parse(system.files.get(`${ROOT}/state.json`)!.content) as { autopilotVersion: string };
    assert.equal(state.autopilotVersion, "9.9.9-dev.autopilot-ai");
    const before = system.ran.filter((command) => command.startsWith("npm install")).length;
    await setUp(system, { env });
    assert.equal(system.ran.filter((command) => command.startsWith("npm install")).length, before + 1, "a dev build may have changed: installed again");
  });

  it("re-runs as a repair: nothing reinstalled, same secrets and ports, one credential", async () => {
    const system = new FakeComputer();
    const { remote: first } = await setUp(system);
    const apiKey = env(system, "hotcell.env").HOTCELL_API_KEY;
    const before = system.commands.length;
    const { remote: second } = await setUp(system);
    const rerun = system.ran.slice(before);
    assert.ok(!rerun.some((command) => command.startsWith("npm install") || command.includes(" build ")), rerun.join("\n"));
    assert.equal(env(system, "hotcell.env").HOTCELL_API_KEY, apiKey);
    assert.equal(env(system, "autopilot.env").AUTOPILOT_PUBLIC_URL, "http://127.0.0.1:4096", "its own port is reused, not seen as taken");
    assert.equal(second.url, first.url);
    assert.notEqual(second.token, first.token);
    assert.deepEqual(system.credentials.map((entry) => entry.status), ["revoked", "active"], "the earlier credential is revoked");
    assert.ok(rerun.includes("launchctl bootout gui/501/com.directionallylocal.hotcell"));
  });

  it("writes OpenRouter's prices under Hotcell's home before it starts, and keeps them when offline", async () => {
    const system = new FakeComputer();
    const install = system.run.bind(system);
    let pricesAtStart: string | undefined;
    system.run = async (command, args, runOptions) => {
      if (command === "launchctl" && args[0] === "bootstrap" && args[2]?.includes("hotcell")) pricesAtStart = system.files.get(`${ROOT}/hotcell/model-prices.json`)?.content;
      return install(command, args, runOptions);
    };
    const { ui } = await setUp(system);
    const prices = system.files.get(`${ROOT}/hotcell/model-prices.json`)!;
    assert.deepEqual(Object.keys(JSON.parse(prices.content) as object), ["meta-llama/llama-5-8b:free", "moonshotai/kimi-k2.6", "openai/gpt-6-luna"]);
    assert.equal(pricesAtStart, prices.content, "in place when Hotcell starts, which is when it reads them");
    assert.equal(env(system, "hotcell.env").HOTCELL_MODEL_PRICES, `${ROOT}/hotcell/model-prices.json`);
    assert.ok(ui.events.some((event) => event.startsWith("done services") && event.endsWith("· prices for 3 models")), ui.events.join("\n"));

    const offline = (async () => { throw new Error("getaddrinfo ENOTFOUND openrouter.ai"); }) as unknown as typeof fetch;
    const again = await setUp(system, { fetchImpl: offline });
    assert.equal(system.files.get(`${ROOT}/hotcell/model-prices.json`)!.content, prices.content);
    assert.ok(again.ui.events.some((event) => event.startsWith("warn Couldn't refresh model prices") && event.includes("kept the last list (3 models)")));

    const fresh = new FakeComputer();
    const first = await setUp(fresh, { fetchImpl: offline });
    assert.equal(fresh.files.has(`${ROOT}/hotcell/model-prices.json`), false);
    assert.ok(first.ui.events.some((event) => event.includes('Tasks will fail with "model not priced" until dl setup can reach openrouter.ai.')));
  });

  it("moves to free ports when the usual ones are taken", async () => {
    const system = new FakeComputer();
    system.busy.add(PREFERRED_PORTS.autopilot);
    system.busy.add(PREFERRED_PORTS.hotcell);
    const { remote } = await setUp(system);
    assert.equal(remote.url, "http://127.0.0.1:4097");
    const hotcell = env(system, "hotcell.env");
    assert.deepEqual([hotcell.HOTCELL_PORT, hotcell.HOTCELL_PROXY_PORT, hotcell.HOTCELL_EGRESS_PORT], ["4751", "4752", "4753"], "each the next free one, never the same twice");
    assert.equal(env(system, "autopilot.env").AUTOPILOT_HOTCELL_ENDPOINT, "http://127.0.0.1:4751");
    assert.match(system.files.get(`${HOME}/Library/LaunchAgents/com.directionallylocal.autopilot.plist`)!.content, /<string>--port<\/string>\s*<string>4097<\/string>/);
  });

  it("fails clearly when sandboxes can't reach the gateway", async () => {
    const system = new FakeComputer();
    system.reachHost = false;
    await assert.rejects(() => setUp(system), /Sandboxes can't reach Hotcell's gateway at host\.docker\.internal:4752/);
  });

  it("runs as systemd user units on a Linux desktop, with the gateway on docker0", async () => {
    const system = new FakeComputer("/home/ada");
    system.files.set("/var/run/docker.sock", { content: "", mode: 0o660 });
    system.bridgeIp = "172.17.0.1";
    await setUp(system, { platform: "linux", execPath: "/usr/bin/node", hostname: "ada-desktop" });
    const root = "/home/ada/.directionallylocal";
    assert.equal(parseLocalEnvFile(system.files.get(`${root}/config/hotcell.env`)?.content).HOTCELL_EGRESS_HOST, "172.17.0.1");
    assert.equal(parseLocalEnvFile(system.files.get(`${root}/config/autopilot.env`)?.content).AUTOPILOT_ASTER_GITHUB_PROXY_LISTEN, "172.17.0.1:4760");
    assert.ok(system.files.has("/home/ada/.config/systemd/user/directionallylocal-hotcell.service"));
    assert.ok(system.ran.includes("systemctl --user enable directionallylocal-autopilot.service"));
    assert.ok(system.running.has("directionallylocal-autopilot.service"));
    assert.ok(!system.ran.some((command) => command.startsWith("launchctl")));
  });
});

describe("on this computer: service definitions", () => {
  const paths = localPaths("/Users/Jane Doe", "darwin");
  const ports = { ...PREFERRED_PORTS };
  const specs = serviceSpecs({ paths, node: NODE, path: "/opt/homebrew/opt/node/bin:/usr/bin:/bin", dockerHost: "unix:///Users/Jane Doe/.docker/run/docker.sock", ports });

  it("renders a LaunchAgent that starts at login, stays up, logs to a file, and holds no secret", () => {
    const plist = launchAgentPlist(specs.autopilot);
    assert.match(plist, /<key>Label<\/key>\s*<string>com\.directionallylocal\.autopilot<\/string>/);
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
    assert.match(plist, /<string>\/opt\/homebrew\/opt\/node\/bin\/node<\/string>\s*<string>--env-file=\/Users\/Jane Doe\/\.directionallylocal\/config\/autopilot\.env<\/string>\s*<string>--env-file=\/Users\/Jane Doe\/\.directionallylocal\/config\/github\.env<\/string>/);
    assert.match(plist, /<string>serve<\/string>\s*<string>--hostname<\/string>\s*<string>127\.0\.0\.1<\/string>/);
    assert.match(plist, /<key>StandardErrorPath<\/key>\s*<string>\/Users\/Jane Doe\/\.directionallylocal\/logs\/autopilot\.log<\/string>/);
    assert.match(plist, /<key>HOME<\/key>\s*<string>\/Users\/Jane Doe\/\.directionallylocal\/autopilot<\/string>/, "its own HOME: a user's own Autopilot config isn't picked up");
    assert.match(plist, /<key>DOCKER_HOST<\/key>/);
    assert.doesNotMatch(plist, /API_KEY|GITHUB_TOKEN|sk-or-/);
    assert.match(launchAgentPlist(specs.hotcell), /<string>start<\/string>\s*<string>--foreground<\/string>\s*<string>--defaults<\/string>/);
  });

  it("renders a systemd user unit with quoted paths, restart, and default.target", () => {
    const unit = systemdUserUnit(specs.autopilot, "directionallylocal-hotcell.service");
    assert.match(unit, /^After=directionallylocal-hotcell\.service$/m);
    assert.match(unit, /^ExecStart="\/opt\/homebrew\/opt\/node\/bin\/node" "--env-file=\/Users\/Jane Doe\/\.directionallylocal\/config\/autopilot\.env" /m);
    assert.match(unit, /^Environment="HOME=\/Users\/Jane Doe\/\.directionallylocal\/autopilot"$/m);
    assert.match(unit, /^Restart=always$/m);
    assert.match(unit, /^WantedBy=default\.target$/m);
    assert.doesNotMatch(unit, /API_KEY|GITHUB_TOKEN/);
  });

  it("quotes env values Node's --env-file would split, and reads them back", () => {
    const text = localEnvFile("test", { A: "/Users/Jane Doe/x", B: "plain" });
    assert.match(text, /^A="\/Users\/Jane Doe\/x"$/m);
    assert.match(text, /^B=plain$/m);
    assert.deepEqual(parseLocalEnvFile(text), { A: "/Users/Jane Doe/x", B: "plain" });
    assert.throws(() => localEnvFile("test", { A: "two\nlines" }));
  });
});

describe("on this computer: status and uninstall", () => {
  it("reports where it runs and how much fits", async () => {
    const system = new FakeComputer();
    const none = await localStatus(options(system));
    assert.equal(none.installed, false);
    assert.match(formatLocalStatus(none, palette(false), HOME), /isn't set up on this computer/);

    await setUp(system);
    const status = await localStatus(options(system));
    assert.equal(status.services.autopilot.running, true);
    assert.equal(status.answering, true);
    assert.equal(status.capacity, 6);
    const text = formatLocalStatus(status, palette(false), HOME);
    assert.match(text, /on this computer {2}running/);
    assert.match(text, new RegExp(`Autopilot +running \\(pid 4242\\) · http://127\\.0\\.0\\.1:4096 · ${AUTOPILOT.replace(/\./g, "\\.")}`));
    assert.match(text, /~6 agents at once/);
    assert.match(text, /~\/\.directionallylocal\/logs/);
    assert.match(text, /tasks pause while this computer sleeps/);
    const pricesFile = `${ROOT}/hotcell/model-prices.json`;
    system.mtimes.set(pricesFile, Date.parse("2026-10-28T09:00:00Z") / 1000);
    assert.match(formatLocalStatus(await localStatus(options(system)), palette(false), HOME), /✓ Prices +3 models · updated today\n/);
    system.mtimes.set(pricesFile, Date.parse("2026-10-10T09:00:00Z") / 1000);
    const stale = formatLocalStatus(await localStatus(options(system)), palette(false), HOME);
    assert.match(stale, /on this computer {2}running/);
    assert.match(stale, /! Prices +3 models · 18 days old; dl setup refreshes it\n/);
    system.files.delete(pricesFile);
    assert.match(formatLocalStatus(await localStatus(options(system)), palette(false), HOME), /needs attention[\s\S]*✗ Prices +missing/);
    await setUp(system);

    system.running.delete("com.directionallylocal.autopilot");
    assert.match(formatLocalStatus(await localStatus(options(system)), palette(false), HOME), /needs attention[\s\S]*Autopilot +stopped, not answering/);
  });

  it("removes services and software but keeps keys and data, and only Autopilot's sandboxes", async () => {
    const system = new FakeComputer();
    await setUp(system);
    system.containers.push({ id: "ours1", labels: ["sbx.managed=true", "autopilot.conversation_id"] }, { id: "theirs", labels: ["sbx.managed=true"] });
    const forgotten: string[] = [];
    await uninstallFromThisComputer({ ui: new RecordingUi(), ...options(system), forgetRemote: async (name) => { forgotten.push(name); return true; } });
    assert.equal(system.running.size, 0);
    assert.equal(system.files.has(`${HOME}/Library/LaunchAgents/com.directionallylocal.hotcell.plist`), false);
    assert.equal(await system.exists(`${ROOT}/releases`), false);
    assert.equal(await system.exists(`${ROOT}/current`), false);
    assert.deepEqual(system.containers.map((entry) => entry.id), ["theirs"], "a user's own Hotcell sandboxes stay");
    assert.ok(system.files.has(`${ROOT}/config/github.env`), "keys and config are kept without --purge");
    assert.ok(system.images.has(`directionallylocal-cell:${AUTOPILOT}`));
    assert.deepEqual(forgotten, ["this-computer"]);
    assert.equal((await localStatus(options(system))).installed, false);

    // Setting up again needs nothing it already has, and installs the software again.
    const again = await setUpOnThisComputer({ ui: new RecordingUi(), prompter: new ScriptedPrompter({}), ...options(system) });
    assert.deepEqual(again.needs, []);
    assert.ok(system.running.has("com.directionallylocal.autopilot"));
  });

  it("--purge also deletes keys, data, and the sandbox image", async () => {
    const system = new FakeComputer();
    await setUp(system);
    await uninstallFromThisComputer({ ui: new RecordingUi(), purge: true, ...options(system), forgetRemote: async () => true });
    assert.equal(await system.exists(ROOT), false);
    assert.equal(system.images.size, 0);
    const fresh = await setUpOnThisComputer({ ui: new RecordingUi(), prompter: new ScriptedPrompter({}), ...options(system) });
    assert.deepEqual(fresh.needs, ["provider", "github"], "the keys went with --purge");
  });
});
