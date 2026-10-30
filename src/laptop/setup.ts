import { execFile } from "node:child_process";
import { access as fileAccess, readdir, readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { configureThisComputer } from "../local/keys.js";
import { setUpOnThisComputer, type LocalAnswers, type LocalNeed } from "../local/setup.js";
import { localUnsupported } from "../local/check.js";
import { PromptCancelled, TtyPrompter, type Prompter, type SelectOption } from "../prompt.js";
import { describeProvider, providerAnswer, type ConnectResult, type ProviderAnswer } from "../provider.js";
import { palette, PlainUi, TerminalUi, type Ui } from "../ui.js";
import type { LaptopIO } from "./commands.js";
import { loadRemotes, loadRemotesFile, normalizeServerUrl, REMOTE_NAME_RE, remotesPath, resolveTarget, saveRemote, setDefaultRemote, type RemoteServer, type SshAccess } from "./config.js";
import { ConnectCancelled, runAutopilotConnect } from "./connect.js";
import { confirm, githubToken, type KeyPlace, type KeySources, type Need } from "./credentials.js";
import { applyOnServer, bootstrap, INSTALL_URL, installOnServer, pairLaptop, serverNeeds, type ServerAnswers, type UiFactory } from "./remote-install.js";
import { openSession } from "./session.js";
import { loadSettings, saveModel, saveSettings } from "./settings.js";
import { checkServer, describeHost, discoverKeys, hostOf, parseSshConfig, parseTarget, realSshExec, SshAuthError, type ServerFacts, type SshExec, type SshHost } from "./ssh.js";
import { openRemote, withConnections, type RemoteOpener } from "./tunnel.js";

/**
 * `dl` the first time (and `dl setup`): the installer of the stack, and nothing more. It asks
 * where agents should run, installs Hotcell + Autopilot there (this computer, or the user's
 * own server over SSH), hands the provider and model choice to Autopilot's own picker, pushes
 * the key to the place, takes the GitHub token, and opens a session right away. Nothing is
 * exposed on a server: `dl` reaches it through an SSH tunnel.
 */

/** "On this computer": installs everything locally; returns the server to save, how many agents fit, and what's still missing. */
export type LocalSetup = (input: { ui: Ui; prompter: Prompter; answers?: LocalAnswers }) => Promise<{ remote: RemoteServer; capacity?: number; needs: LocalNeed[] }>;

/** "On this computer": stores the provider's key (and aster.json) and the GitHub token, restarting what reads them. */
export type LocalConfigure = (answers: { provider?: ProviderAnswer; githubToken?: string }) => Promise<void>;

export interface SetupDeps {
  /** A fresh Ui per section (TerminalUi on a terminal, PlainUi otherwise). */
  newUi: UiFactory;
  prompter: Prompter;
  write: (text: string) => void;
  color: boolean;
  ssh: SshExec;
  /** Opens the API endpoint for a saved server (an SSH tunnel), for the final check. */
  open: RemoteOpener;
  sources: KeySources & { listDir: (path: string) => Promise<string[]> };
  /** This laptop's name, for the credential the server issues it. */
  hostname: string;
  remotesFile?: string;
  /** dl's own settings (each place's model); ~/.config/directionallylocal/config.json unless replaced. */
  settingsFile?: string;
  installUrl?: string;
  localSetup?: LocalSetup;
  localConfigure?: LocalConfigure;
  /** Autopilot's provider + model picker (`autopilot connect`); the real one unless replaced. */
  connect?: (options: { modelOnly?: boolean }) => Promise<ConnectResult>;
  /** Opens the session the user lands in once a place is ready; nothing after the Ready line otherwise. */
  openSession?: (remote: RemoteServer) => Promise<number | undefined>;
  /** `dl setup --identity FILE`: the private key to use, instead of trying the ones in ~/.ssh. */
  identityFile?: string;
  /** Someone is at a terminal to answer a question setup could skip; true unless told otherwise. */
  interactive?: boolean;
  /** This laptop's platform (process.platform): "On this computer" isn't offered where it can't run. */
  platform?: NodeJS.Platform;
  now?: () => Date;
}

const PLACES: SelectOption[] = [
  { value: "local", label: "On this computer", detail: "start now · nothing to rent · pauses when this computer sleeps" },
  { value: "server", label: "On my own server", detail: "keeps going when your laptop is closed · needs SSH access" },
];

export async function setupWizard(deps: SetupDeps): Promise<RemoteServer | undefined> {
  const c = palette(deps.color);
  deps.write(`\n  ${c.bold("Directionally Local")}\n  Background coding agents. Where should they run?\n\n`);
  const ui = deps.newUi();
  // Where this computer can't run agents (Windows), the list would hold one real choice: say why, and go on.
  const unsupported = localUnsupported(deps.platform ?? process.platform);
  if (unsupported) {
    ui.line("info", "On this computer", unsupported);
    ui.answered("Where", "On my own server");
    return setUpServer(deps);
  }
  let where = (await deps.prompter.select(ui.prompt("Where"), PLACES, 0)).value as "local" | "server";

  ui.answered("Where", where === "local" ? "On this computer" : "On my own server");
  if (where === "local" && !deps.localSetup) {
    ui.line("info", "On this computer", "coming soon");
    if (!(await confirm(ui, deps.prompter, "Set up on your own server instead?"))) {
      deps.write(`\n  ${c.dim("Nothing changed. Run")} dl ${c.dim("when you're ready.")}\n\n`);
      return undefined;
    }
    ui.answered("Where", "On my own server");
    where = "server";
  }

  if (where === "local") {
    // Install first; the keys come after, from Autopilot's own picker and the GitHub CLI.
    const { remote, capacity, needs } = await deps.localSetup!({ ui: deps.newUi(), prompter: deps.prompter });
    const remotesFile = deps.remotesFile ?? remotesPath();
    const isNew = !(await loadRemotes(remotesFile)).some((entry) => entry.name === remote.name);
    await gatherAndStore(deps, needs, remote.name, "this computer", async (answers) => {
      if (!deps.localConfigure) throw new Error("This build can't store keys on this computer.");
      await deps.localConfigure(answers);
    });
    // Saved only once the keys are stored, as the server path does: a run killed at the
    // picker leaves no place behind, so `dl` again resumes at the picker instead of
    // opening a session on a place that has no provider and can't serve a turn.
    await saveRemote(remote, remotesFile);
    await offerThisComputer(deps, remote, remotesFile, isNew);
    await ready(deps, remote, capacity);
    return remote;
  }
  return setUpServer(deps);
}

async function setUpServer(deps: SetupDeps): Promise<RemoteServer> {
  const home = deps.sources.home;
  const sshDir = join(home, ".ssh");
  const hosts = parseSshConfig(await deps.sources.readFile(join(sshDir, "config")) ?? "", home);

  // 1. Which server, and can we get in?
  const chosen = await chooseServer(deps, hosts);
  const { access, facts } = await reachServer(deps, sshDir, deps.identityFile ? { ...chosen.access, identityFile: deps.identityFile } : chosen.access, chosen.display);

  // 2. Install dl there, then everything else; its checklist replayed here.
  await bootstrap(access, facts, deps.ssh, deps.newUi(), deps.installUrl);
  const { capacity } = await installOnServer(access, facts, deps.ssh, {}, deps.newUi);

  // 3. The keys it still lacks: the provider from Autopilot's picker, the GitHub token; stored in one quiet pass.
  const needs = await serverNeeds(access, facts, deps.ssh);
  if (needs.includes("tailscale")) throw new Error("The server asked for Tailscale, but this setup reaches it over SSH; update dl on the server and run dl setup again.");
  // The model is kept under the name the server will most likely get (adoptModel moves it if that differs).
  const provisional = chosen.alias ?? facts.hostname ?? access.target;
  await gatherAndStore(deps, needs, provisional, "your server", (answers) => applyOnServer(access, facts, deps.ssh, answers));

  // 4. A credential for this laptop, checked through the tunnel every command will use. Each
  // `dl pair` makes a new credential on the server, so a re-run keeps the saved one if it works.
  const remotesFile = deps.remotesFile ?? remotesPath();
  const known = await loadRemotes(remotesFile);
  const saved = known.find((entry) => sameServer(entry, access));
  let remote: RemoteServer | undefined;
  if (saved && await stillWorks({ ...saved, ssh: access }, deps.open)) remote = { ...saved, ssh: access };
  if (!remote) {
    const pairing = await pairLaptop(access, facts, deps.ssh, `${laptopName(deps.hostname)} (dl)`);
    remote = {
      name: saved?.name ?? await remoteName(access, remotesFile, chosen.alias ?? facts.hostname),
      url: normalizeServerUrl(pairing.url),
      token: pairing.token,
      credentialId: pairing.credentialId,
      expiresAt: pairing.expiresAt,
      addedAt: (deps.now?.() ?? new Date()).toISOString(),
      ssh: access,
    };
  }
  const connectedUi = deps.newUi();
  const paired = remote;
  await withConnections(deps.open, async (connections) => {
    try {
      await (await connections.client(paired)).health();
    } catch (error) {
      connectedUi.line("failed", "This laptop", "couldn't reach the server's API through SSH");
      throw new Error(`The server is set up, but this laptop couldn't reach it through an SSH tunnel: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  await saveRemote(remote, remotesFile);
  // The model was kept under the server's name before it was known for sure; move it along.
  await adoptModel(deps, provisional, remote.name);
  connectedUi.line("done", "This laptop", `connected as ${remote.name}`);
  connectedUi.finish();
  if (!known.some((entry) => entry.name === paired.name)) await chooseDefault(deps, remote, remotesFile);
  await ready(deps, remote, capacity);
  return remote;
}

/**
 * What the place still lacks, gathered and stored in one pass: the provider, key and model
 * from Autopilot's own picker (it runs in this terminal and configures the user's `autopilot`
 * too), then the GitHub token. The model stays here, as the place's; the key goes to the place.
 */
async function gatherAndStore(deps: SetupDeps, needs: readonly Need[], placeName: string, place: KeyPlace, store: (answers: ServerAnswers) => Promise<void>): Promise<void> {
  const ui = deps.newUi();
  const wanted = needs.filter((need) => need === "provider" || need === "github");
  if (wanted.length === 0) {
    ui.line("done", "Keys", `already on ${place}`);
    ui.finish();
    return;
  }
  const answers: ServerAnswers = {};
  if (wanted.includes("provider")) {
    deps.write("\n");
    let chosen: ConnectResult;
    try {
      chosen = await (deps.connect ?? ((options) => runAutopilotConnect(options)))({});
    } catch (error) {
      if (error instanceof ConnectCancelled) throw new PromptCancelled();
      throw error;
    }
    answers.provider = providerAnswer(chosen);
    await saveModel(chosen.model, deps.settingsFile, placeName);
    ui.line("done", "Provider", `${describeProvider({ id: chosen.provider, name: chosen.name }, chosen.model)} · key stays on ${place}`);
  }
  if (wanted.includes("github")) {
    answers.githubToken = await githubToken({ ui, prompter: deps.prompter, sources: deps.sources, place });
  }
  ui.plan([{ id: "keys", label: `Storing keys on ${place}` }]);
  ui.start("keys");
  try {
    await store(answers);
  } catch (error) {
    ui.fail("keys", error instanceof Error ? error.message.split("\n")[0]! : String(error));
    ui.finish();
    throw error;
  }
  ui.done("keys", [answers.provider ? describeProvider({ id: answers.provider.id, ...(answers.provider.name ? { name: answers.provider.name } : {}) }) : undefined, answers.githubToken ? "GitHub" : undefined].filter(Boolean).join(" · "));
  ui.finish();
}

/** A model saved under a provisional place name follows the place to its final name. */
async function adoptModel(deps: SetupDeps, provisional: string | undefined, name: string): Promise<void> {
  if (!provisional || provisional === name) return;
  const settings = await loadSettings(deps.settingsFile);
  const model = settings.placeModels?.[provisional];
  if (!model) return;
  const { [provisional]: _moved, ...rest } = settings.placeModels ?? {};
  await saveSettings({ placeModels: { ...rest, [name]: model } }, deps.settingsFile);
}

async function chooseServer(deps: SetupDeps, hosts: SshHost[]): Promise<{ access: SshAccess; display: string; alias?: string }> {
  const ui = deps.newUi();
  deps.write("\n");
  const example = "user@host[:port], e.g. root@203.0.113.10";
  const options: SelectOption[] = [
    ...hosts.map((host, index) => ({ value: String(index), label: host.alias, detail: describeHost(host) })),
    { value: "another", label: "Another server", input: { prompt: ui.prompt("Server address", example), placeholder: example } },
  ];
  for (let attempt = 1; ; attempt++) {
    // Without saved hosts, a one-item list would only be in the way: just ask for the address.
    const picked = hosts.length > 0
      ? await deps.prompter.select(ui.prompt("Server"), options, 0)
      : { value: "another", text: (await deps.prompter.text(ui.prompt("Server", example))).trim() };
    const host = picked.value === "another" ? undefined : hosts[Number(picked.value)];
    if (host) {
      ui.answered("SSH", host.alias);
      return {
        alias: host.alias,
        access: { target: host.alias },
        display: `${host.user ? `${host.user}@` : ""}${host.hostName ?? host.alias}${host.port && host.port !== 22 ? `:${host.port}` : ""}`,
      };
    }
    try {
      const access = parseTarget(picked.text ?? "");
      ui.answered("SSH", access.target);
      return { access, display: `${access.target}${access.port ? `:${access.port}` : ""}` };
    } catch (error) {
      if (attempt >= 3) throw error;
      ui.rejected(`${(error as Error).message}. Try again.`);
    }
  }
}

/**
 * With two or more places set up, where `dl run` sends tasks unless told otherwise. Asked
 * only when setup adds a server, with the new one preselected (this computer: offerThisComputer); the first place becomes the
 * default by itself (saveRemote).
 */
async function chooseDefault(deps: SetupDeps, added: RemoteServer, remotesFile: string): Promise<void> {
  const { remotes } = await loadRemotesFile(remotesFile);
  if (remotes.length < 2) return;
  const ui = deps.newUi();
  deps.write("\n");
  const options = remotes.map((remote) => ({ value: remote.name, label: remote.name, detail: describePlace(remote) }));
  const initial = Math.max(0, remotes.findIndex((remote) => remote.name === added.name));
  const { value } = await deps.prompter.select(ui.prompt("Where should tasks go by default?"), options, initial);
  await setDefaultRemote(value, remotesFile);
  ui.answered("Default", value);
  ui.finish();
}

/**
 * After "on this computer", when commands would still go somewhere else (a server set up
 * first stays the default, saveRemote): asks once, at a terminal, whether this computer
 * should be the default instead. Asked again only when this computer is newly added.
 * Otherwise (no terminal, already asked, or "no") it says where things go and how to change it.
 */
async function offerThisComputer(deps: SetupDeps, local: RemoteServer, remotesFile: string, isNew: boolean): Promise<void> {
  const { remotes } = await loadRemotesFile(remotesFile);
  if (remotes.length < 2) return;
  const current = await resolveTarget(undefined, remotesFile).then((target) => target.remote.name, () => undefined);
  if (current === local.name) return;
  const hint = `dl use ${local.name}`;
  const ui = deps.newUi();
  deps.write("\n");
  if (deps.interactive !== false && (isNew || !(await loadSettings(deps.settingsFile)).askedLocalDefault)) {
    const question = current ? `Make this computer the default? Tasks and sessions go to ${current} now` : "Make this computer the default for tasks and sessions?";
    const yes = await confirm(ui, deps.prompter, question);
    await saveSettings({ askedLocalDefault: true }, deps.settingsFile);
    if (yes) {
      await setDefaultRemote(local.name, remotesFile);
      ui.answered("Default", "this computer");
      ui.finish();
      return;
    }
  }
  ui.line("info", "Default", current ? `still ${current} · ${hint} to run here instead` : `none yet · ${hint} to run here`);
  ui.finish();
}

function describePlace(remote: RemoteServer): string {
  if (remote.ssh) return `server · ${remote.ssh.target}${remote.ssh.port ? `:${remote.ssh.port}` : ""}`;
  try {
    const host = new URL(remote.url).hostname;
    return host === "127.0.0.1" || host === "localhost" ? "this computer" : `server · ${host}`;
  } catch {
    return remote.url;
  }
}

/**
 * Connects and checks the server. If it refuses the default keys (ssh's own: the agent and
 * ~/.ssh/id_*), each key pair in ~/.ssh is tried in turn with -i, without asking: auth
 * refusals come back fast, so this takes seconds. Only when none works does it stop, with
 * what to do. A key named with --identity is the only one tried.
 */
async function reachServer(deps: SetupDeps, sshDir: string, first: SshAccess, target: string): Promise<{ access: SshAccess; facts: ServerFacts }> {
  const home = deps.sources.home;
  const ui = deps.newUi();
  ui.plan([{ id: "ssh", label: "Server" }]);
  ui.start("ssh", target);
  const tried: string[] = [];
  let searching = false;
  let newHostKey = false;
  const attempt = async (access: SshAccess): Promise<ServerFacts | undefined> => {
    try {
      return await checkServer(access, deps.ssh, target);
    } catch (error) {
      if (error instanceof SshAuthError) {
        newHostKey ||= error.newHostKey;
        if (access.identityFile) tried.push(access.identityFile);
        return undefined;
      }
      if (searching) ui.plan([{ id: "ssh", label: "Server" }]);
      ui.fail("ssh", "can't set up here");
      ui.finish();
      throw error;
    }
  };

  let access = first;
  let facts = await attempt(access);
  if (!facts && !first.identityFile) {
    const keys = discoverKeys(sshDir, await deps.sources.listDir(sshDir));
    searching = keys.length > 0;
    if (searching) ui.plan([{ id: "keys", label: "Trying your SSH keys…" }]);
    for (const key of keys) {
      access = { ...first, identityFile: key };
      ui.start("keys", tilde(key, home));
      facts = await attempt(access);
      if (facts) break;
    }
  }
  if (searching) ui.plan([{ id: "ssh", label: "Server" }]);
  if (!facts) {
    ui.fail("ssh", first.identityFile ? `${tilde(first.identityFile, home)} not accepted` : tried.length > 0 ? "none of your SSH keys was accepted" : "SSH key not accepted");
    ui.finish();
    throw noKeyWorks(first, tried, discoverKeys(sshDir, await deps.sources.listDir(sshDir)), home);
  }
  const display = `${facts.user}@${target.replace(/^[^@]*@/, "")}`;
  ui.done("ssh", access.identityFile ? `${display} with ${tilde(access.identityFile, home)} · ${facts.os} · ${facts.arch}` : `${display}  ${facts.os} · ${facts.arch}`);
  ui.finish();
  if (facts.newHostKey || newHostKey) deps.newUi().line("info", "New server", "first connection: trusted its host key (accept-new)");
  return { access, facts };
}

/** Every key was refused: what to do next, with this server and this laptop's own key filled in. */
function noKeyWorks(access: SshAccess, tried: string[], keys: string[], home: string): Error {
  const port = access.port ? `-p ${access.port} ` : "";
  const key = keys[0] ? tilde(keys[0], home) : undefined;
  const lines = [
    access.identityFile
      ? `${access.target} didn't accept ${tilde(access.identityFile, home)}.`
      : `${access.target} didn't accept this computer's SSH keys (${["the default ones", ...tried.map((file) => tilde(file, home))].join(", ")}).`,
    "  Add your public key to the server (it asks for the password once):",
    ...(key ? [] : ["     ssh-keygen -t ed25519"]),
    `     ssh-copy-id -i ${key ?? "~/.ssh/id_ed25519"}.pub ${port}${access.target}`,
    "  If your key has a passphrase, load it first with: ssh-add",
    "  Or name the key this server takes: dl setup --identity ~/.ssh/KEY",
  ];
  return new Error(lines.join("\n"));
}

function tilde(path: string, home: string): string {
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function sameServer(remote: RemoteServer, access: SshAccess): boolean {
  return remote.ssh?.target === access.target && remote.ssh.port === access.port;
}

async function stillWorks(remote: RemoteServer, open: RemoteOpener): Promise<boolean> {
  return withConnections(open, async (connections) => {
    await (await connections.client(remote)).health();
    return true;
  }).catch(() => false);
}

/**
 * What this laptop calls the server: the ~/.ssh/config alias the user picked, else the
 * server's own hostname, else its address (203-0-113-10). Unique unless it's this same server.
 */
async function remoteName(access: SshAccess, remotesFile: string, preferred: string | undefined): Promise<string> {
  const host = hostOf(access.target).toLowerCase();
  const fromAddress = /^\d+(\.\d+){3}$/.test(host) || host.includes(":") ? host.replace(/[.:]/g, "-") : host.split(".")[0] ?? "";
  const name = [preferred, fromAddress].map((label) => serverLabel(label ?? "")).find((label) => label !== undefined) ?? "server";
  const remotes = await loadRemotes(remotesFile);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${name}-${n}`;
    const existing = remotes.find((remote) => remote.name === candidate);
    if (!existing || sameServer(existing, access)) return candidate;
  }
}

/** A hostname as a server name (lowercase, dashes, room for a -2), or undefined if nothing usable is left. */
export function serverLabel(text: string): string | undefined {
  const label = text.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36).replace(/-+$/, "");
  return REMOTE_NAME_RE.test(label) && label !== "localhost" ? label : undefined;
}

/** One line, then the session: the place explains itself from here on (dl status has the rest). */
async function ready(deps: SetupDeps, remote: RemoteServer, capacity: number | undefined): Promise<void> {
  const c = palette(deps.color);
  deps.write(`\n  ${c.green("✓")} ${c.bold("Ready")}${capacity ? ` · fits ~${capacity} agents at once` : ""}\n`);
  if (deps.openSession) await deps.openSession(remote);
  else deps.write(`  ${c.dim("Type")} dl ${c.dim("to talk to an agent; dl status shows where they run.")}\n\n`);
}

function laptopName(name: string): string {
  return name.replace(/\.local$/, "").replace(/[^\p{L}\p{N} ._'()@-]/gu, "-").slice(0, 40) || "laptop";
}

/** `dl setup` with the real terminal, ssh, gh, Autopilot, and filesystem. */
export async function setup(options: { io: LaptopIO; terminal: boolean; localSetup?: LocalSetup; localConfigure?: LocalConfigure; identityFile?: string; cwd?: string }): Promise<number> {
  const { io, terminal } = options;
  const color = io.color === true;
  const execFileAsync = promisify(execFile);
  const home = homedir();
  let identityFile: string | undefined;
  if (options.identityFile !== undefined) {
    // The private key, even when the .pub next to it was named.
    identityFile = resolve(options.identityFile.replace(/^~(?=$|\/)/, home).replace(/\.pub$/, ""));
    await fileAccess(identityFile).catch(() => { throw new Error(`No SSH key at ${options.identityFile} (--identity takes the private key, e.g. ~/.ssh/id_ed25519)`); });
  }
  let sessionCode: number | undefined;
  try {
    await setupWizard({
      newUi: () => terminal ? new TerminalUi(io.out, undefined, color) : new PlainUi(io.out),
      prompter: new TtyPrompter({ color }),
      write: io.out,
      color,
      ssh: realSshExec,
      open: openRemote,
      sources: {
        env: process.env,
        home,
        readFile: (path) => readFile(path, "utf8").catch(() => undefined),
        listDir: (path) => readdir(path).catch(() => []),
        gh: () => execFileAsync("gh", ["auth", "token"], { timeout: 5000 }).then(({ stdout }) => stdout.trim() || undefined, () => undefined),
        fetch: globalThis.fetch,
      },
      hostname: hostname(),
      installUrl: process.env.DL_INSTALL_URL || INSTALL_URL,
      localSetup: options.localSetup ?? ((input) => setUpOnThisComputer(input)),
      localConfigure: options.localConfigure ?? ((answers) => configureThisComputer(answers)),
      ...(identityFile ? { identityFile } : {}),
      interactive: terminal && process.stdin.isTTY === true,
      // The session needs the terminal; without one the Ready line says what to type.
      ...(terminal ? { openSession: async () => { sessionCode = await openSession({ cwd: options.cwd ?? process.cwd() }, io); return sessionCode; } } : {}),
    });
  } catch (error) {
    if (!(error instanceof PromptCancelled)) throw error;
    // Esc / Ctrl-C at a question: the terminal is restored; say so quietly and stop.
    io.out(`  ${palette(color).dim("Cancelled. Run")} dl ${palette(color).dim("when you're ready; it picks up where it stopped.")}\n\n`);
    return 130;
  }
  return sessionCode ?? 0;
}
