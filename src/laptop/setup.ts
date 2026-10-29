import { execFile } from "node:child_process";
import { access as fileAccess, readdir, readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { PromptCancelled, TtyPrompter, type Prompter, type SelectOption } from "../prompt.js";
import { palette, PlainUi, TerminalUi, type Ui } from "../ui.js";
import type { LaptopIO } from "./commands.js";
import { loadRemotes, loadRemotesFile, normalizeServerUrl, REMOTE_NAME_RE, remotesPath, saveRemote, setDefaultRemote, type RemoteServer, type SshAccess } from "./config.js";
import { confirm, gatherKeys, type KeySources } from "./credentials.js";
import { bootstrap, INSTALL_URL, installOnServer, pairLaptop, serverNeeds, type UiFactory } from "./remote-install.js";
import { checkServer, describeHost, discoverKeys, hostOf, parseSshConfig, parseTarget, realSshExec, SshAuthError, type ServerFacts, type SshExec, type SshHost } from "./ssh.js";
import { openRemote, withConnections, type RemoteOpener } from "./tunnel.js";

/**
 * `dl` / `dl setup` on a laptop: the whole product starts here. It asks where agents
 * should run, then either hands off to "on this computer" (built separately and injected
 * as `localSetup`) or sets up the user's own server over SSH: checks it, installs there,
 * reuses the keys this laptop already has, pairs this laptop, and saves the server so
 * `dl run` and friends reach it through an SSH tunnel. Nothing is exposed on the server.
 */

/** "On this computer": sets everything up locally and returns the server to save, and how many agents fit. */
export type LocalSetup = (input: { ui: Ui; prompter: Prompter; answers: { openrouterKey: string; githubToken: string } }) => Promise<{ remote: RemoteServer; capacity?: number }>;

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
  installUrl?: string;
  localSetup?: LocalSetup;
  /** `dl setup --identity FILE`: the private key to use, instead of trying the ones in ~/.ssh. */
  identityFile?: string;
  now?: () => Date;
}

const RUN_EXAMPLE = 'dl run "fix the flaky checkout test"';

const PLACES: SelectOption[] = [
  { value: "local", label: "On this computer", detail: "start now · nothing to rent · pauses when this computer sleeps" },
  { value: "server", label: "On my own server", detail: "keeps going when your laptop is closed · needs SSH access" },
];

export async function setupWizard(deps: SetupDeps): Promise<RemoteServer | undefined> {
  const c = palette(deps.color);
  deps.write(`\n  ${c.bold("Directionally Local")}\n  Background coding agents. Where should they run?\n\n`);
  const ui = deps.newUi();
  let where = (await deps.prompter.select(ui.prompt("Where"), PLACES, 0)).value as "local" | "server";

  ui.answered("Where", where === "local" ? "On this computer" : "On my own server");
  if (where === "local" && !deps.localSetup) {
    ui.line("info", "On this computer", "coming soon");
    if (!(await confirm(ui, deps.prompter, "Set up on your own server instead?"))) {
      deps.write(`\n  ${c.dim("Nothing changed. Run")} dl setup ${c.dim("when you're ready.")}\n\n`);
      return undefined;
    }
    ui.answered("Where", "On my own server");
    where = "server";
  }

  if (where === "local") {
    const keysUi = deps.newUi();
    const answers = await gatherKeys(["github", "openrouter"], { ui: keysUi, prompter: deps.prompter, sources: deps.sources, place: "this computer" });
    keysUi.finish();
    const { remote, capacity } = await deps.localSetup!({ ui: deps.newUi(), prompter: deps.prompter, answers: { openrouterKey: answers.openrouterKey!, githubToken: answers.githubToken! } });
    const remotesFile = deps.remotesFile ?? remotesPath();
    const isNew = !(await loadRemotes(remotesFile)).some((entry) => entry.name === remote.name);
    await saveRemote(remote, remotesFile);
    if (isNew) await chooseDefault(deps, remote, remotesFile);
    finishScreen(deps.newUi(), capacity);
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

  // 2. Install dl there, then ask only for the keys it still lacks.
  await bootstrap(access, facts, deps.ssh, deps.newUi(), deps.installUrl);
  const needs = await serverNeeds(access, facts, deps.ssh);
  if (needs.includes("tailscale")) throw new Error("The server asked for Tailscale, but this setup reaches it over SSH; update dl on the server and run dl setup again.");
  const keysUi = deps.newUi();
  const answers = await gatherKeys(needs, { ui: keysUi, prompter: deps.prompter, sources: deps.sources });
  if (needs.length === 0) keysUi.line("done", "Keys", "already on the server");
  keysUi.finish();

  // 3. The install itself, its checklist replayed here.
  const { capacity } = await installOnServer(access, facts, deps.ssh, answers, deps.newUi);

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
  connectedUi.line("done", "This laptop", `connected as ${remote.name}`);
  connectedUi.finish();
  if (!known.some((entry) => entry.name === paired.name)) await chooseDefault(deps, remote, remotesFile);
  finishScreen(deps.newUi(), capacity);
  return remote;
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
 * only when setup adds a place, with the new one preselected; the first place becomes the
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

function finishScreen(ui: Ui, capacity: number | undefined): void {
  ui.ready(capacity ? `Ready · fits ~${capacity} agents at once (estimate)` : "Ready", [
    { label: "Start a session: cd into a GitHub repository, then type", value: "dl" },
    { label: "Or hand off a one-off task", value: RUN_EXAMPLE },
  ], { footer: "dl status shows where agents run and what they're doing." });
}

function laptopName(name: string): string {
  return name.replace(/\.local$/, "").replace(/[^\p{L}\p{N} ._'()@-]/gu, "-").slice(0, 40) || "laptop";
}

/** `dl setup` with the real terminal, ssh, gh, and filesystem. */
export async function setup(options: { io: LaptopIO; terminal: boolean; localSetup?: LocalSetup; identityFile?: string }): Promise<number> {
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
      ...(options.localSetup ? { localSetup: options.localSetup } : {}),
      ...(identityFile ? { identityFile } : {}),
    });
  } catch (error) {
    if (!(error instanceof PromptCancelled)) throw error;
    // Esc / Ctrl-C at a question: the terminal is restored; say so quietly and stop.
    io.out(`  ${palette(color).dim("Cancelled. Run")} dl setup ${palette(color).dim("when you're ready.")}\n\n`);
    return 130;
  }
  return 0;
}
