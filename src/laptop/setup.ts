import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { TtyPrompter, type Prompter } from "../prompt.js";
import { palette, PlainUi, TerminalUi, type Ui } from "../ui.js";
import type { LaptopIO } from "./commands.js";
import { loadRemotes, normalizeServerUrl, REMOTE_NAME_RE, remotesPath, saveRemote, type RemoteServer, type SshAccess } from "./config.js";
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

/** "On this computer": sets everything up locally and returns the server to save. */
export type LocalSetup = (input: { ui: Ui; prompter: Prompter; answers: { openrouterKey: string; githubToken: string } }) => Promise<RemoteServer>;

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
  now?: () => Date;
}

const RUN_EXAMPLE = 'dl run "fix the flaky checkout test"';

export async function setupWizard(deps: SetupDeps): Promise<RemoteServer | undefined> {
  const c = palette(deps.color);
  deps.write(`\n  ${c.bold("Directionally Local")}\n  Background coding agents. Where should they run?\n\n`);
  deps.write(`  ${c.cyan("1")}  ${"On this computer".padEnd(22)} ${c.dim("start now · nothing to rent · pauses when this computer sleeps")}\n`);
  deps.write(`  ${c.cyan("2")}  ${"On my own server".padEnd(22)} ${c.dim("keeps going when your laptop is closed · needs SSH access")}\n\n`);
  const ui = deps.newUi();
  let where = await pick(ui, deps.prompter, "Where", "1 or 2 · Enter for 1", { "1": "local", "2": "server" } as const);

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
    const answers = await gatherKeys(["github", "openrouter"], { ui: keysUi, prompter: deps.prompter, sources: deps.sources });
    keysUi.finish();
    const remote = await deps.localSetup!({ ui: deps.newUi(), prompter: deps.prompter, answers: { openrouterKey: answers.openrouterKey!, githubToken: answers.githubToken! } });
    await saveRemote(remote, deps.remotesFile ?? remotesPath());
    finishScreen(deps.newUi(), undefined);
    return remote;
  }
  return setUpServer(deps);
}

async function setUpServer(deps: SetupDeps): Promise<RemoteServer> {
  const c = palette(deps.color);
  const home = deps.sources.home;
  const sshDir = join(home, ".ssh");
  const hosts = parseSshConfig(await deps.sources.readFile(join(sshDir, "config")) ?? "", home);

  // 1. Which server, and can we get in?
  let { access, display } = await chooseServer(deps, hosts);
  let facts: ServerFacts | undefined;
  for (let attempt = 0; !facts; attempt++) {
    const ui = deps.newUi();
    ui.plan([{ id: "ssh", label: "Server" }]);
    ui.start("ssh", display);
    try {
      facts = await checkServer(access, deps.ssh, display);
    } catch (error) {
      ui.fail("ssh", error instanceof SshAuthError ? "SSH key not accepted" : "can't set up here");
      ui.finish();
      if (!(error instanceof SshAuthError) || attempt >= 2) throw explainAuth(error, access);
      access = { ...access, identityFile: await chooseKey(deps, sshDir, access) };
      continue;
    }
    display = `${facts.user}@${display.replace(/^[^@]*@/, "")}`;
    ui.done("ssh", `${display}  ${facts.os} · ${facts.arch}`);
    ui.finish();
    if (facts.newHostKey) deps.newUi().line("info", "New server", "first connection: trusted its host key (accept-new)");
  }

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
  const saved = (await loadRemotes(remotesFile)).find((entry) => sameServer(entry, access));
  let remote: RemoteServer | undefined;
  if (saved && await stillWorks({ ...saved, ssh: access }, deps.open)) remote = { ...saved, ssh: access };
  if (!remote) {
    const pairing = await pairLaptop(access, facts, deps.ssh, `${laptopName(deps.hostname)} (dl)`);
    remote = {
      name: saved?.name ?? await remoteName(access, remotesFile),
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
  finishScreen(deps.newUi(), capacity);
  return remote;
}

async function chooseServer(deps: SetupDeps, hosts: SshHost[]): Promise<{ access: SshAccess; display: string }> {
  const c = palette(deps.color);
  const ui = deps.newUi();
  if (hosts.length > 0) {
    deps.write(`\n  ${c.dim("Your servers in ~/.ssh/config:")}\n`);
    hosts.forEach((host, index) => deps.write(`  ${c.cyan(String(index + 1))}  ${host.alias.padEnd(22)} ${c.dim(describeHost(host))}\n`));
    deps.write(`  ${c.cyan(String(hosts.length + 1))}  Another server\n\n`);
  } else {
    deps.write("\n");
  }
  const hint = hosts.length > 0 ? `1-${hosts.length + 1}, or user@host[:port]` : "user@host[:port], e.g. root@203.0.113.10";
  for (let attempt = 1; ; attempt++) {
    let answer = (await deps.prompter.text(ui.prompt("Server", hint))).trim();
    const index = /^\d+$/.test(answer) ? Number(answer) - 1 : -1;
    const host = hosts[index];
    if (host) {
      ui.answered("SSH", host.alias);
      return {
        access: { target: host.alias },
        display: `${host.user ? `${host.user}@` : ""}${host.hostName ?? host.alias}${host.port && host.port !== 22 ? `:${host.port}` : ""}`,
      };
    }
    if (index === hosts.length && hosts.length > 0) {
      ui.answered("SSH", "another server");
      answer = (await deps.prompter.text(ui.prompt("Server address", "user@host[:port], e.g. root@203.0.113.10"))).trim();
    }
    try {
      const access = parseTarget(answer);
      ui.answered("SSH", access.target);
      return { access, display: `${access.target}${access.port ? `:${access.port}` : ""}` };
    } catch (error) {
      if (attempt >= 3) throw error;
      ui.rejected(`${(error as Error).message}. Try again.`);
    }
  }
}

/** The server refused the default keys: offer the ones in ~/.ssh and retry with -i. */
async function chooseKey(deps: SetupDeps, sshDir: string, access: SshAccess): Promise<string> {
  const c = palette(deps.color);
  const keys = discoverKeys(sshDir, await deps.sources.listDir(sshDir)).filter((key) => key !== access.identityFile);
  if (keys.length === 0) throw explainAuth(new SshAuthError(access, "no other keys in ~/.ssh"), access);
  deps.write(`\n  ${c.dim("Which key does this server accept?")}\n`);
  keys.forEach((key, index) => deps.write(`  ${c.cyan(String(index + 1))}  ${key.replace(deps.sources.home, "~")}\n`));
  deps.write("\n");
  const ui = deps.newUi();
  const answer = (await deps.prompter.text(ui.prompt("SSH key", `1-${keys.length}`))).trim();
  const key = keys[(Number(answer) || 1) - 1] ?? keys[0]!;
  ui.answered("SSH key", key.replace(deps.sources.home, "~"));
  return key;
}

function explainAuth(error: unknown, access: SshAccess): Error {
  if (!(error instanceof SshAuthError)) return error instanceof Error ? error : new Error(String(error));
  return new Error([
    error.message,
    "  Add this computer's public key to the server (it asks for the password once):",
    `     ssh-copy-id ${access.port ? `-p ${access.port} ` : ""}${access.target}`,
    "  If your key has a passphrase, load it first with: ssh-add",
  ].join("\n"));
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

/** box (from an ssh alias) or 203-0-113-10, unique unless it's this same server again. */
async function remoteName(access: SshAccess, remotesFile: string): Promise<string> {
  const host = hostOf(access.target).toLowerCase();
  const label = /^\d+(\.\d+){3}$/.test(host) || host.includes(":") ? host.replace(/[.:]/g, "-") : host.split(".")[0] ?? "server";
  const base = label.replace(/[^a-z0-9-]/g, "-").replace(/^-+/, "").slice(0, 36) || "server";
  const name = REMOTE_NAME_RE.test(base) ? base : "server";
  const remotes = await loadRemotes(remotesFile);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${name}-${n}`;
    const existing = remotes.find((remote) => remote.name === candidate);
    if (!existing || sameServer(existing, access)) return candidate;
  }
}

function finishScreen(ui: Ui, capacity: number | undefined): void {
  ui.ready(capacity ? `Ready · fits ~${capacity} agents at once (estimate)` : "Ready", [
    { label: "From any GitHub repository", value: RUN_EXAMPLE },
    { label: "See progress, then check out the result", value: "dl runs\ndl pull ID" },
  ]);
}

function laptopName(name: string): string {
  return name.replace(/\.local$/, "").replace(/[^\p{L}\p{N} ._'()@-]/gu, "-").slice(0, 40) || "laptop";
}

async function pick<T extends string>(ui: Ui, prompter: Prompter, label: string, hint: string, choices: Record<string, T>): Promise<T> {
  const values = Object.values(choices);
  for (let attempt = 1; ; attempt++) {
    const answer = (await prompter.text(ui.prompt(label, hint))).trim();
    const choice = answer === "" ? values[0] : choices[answer];
    if (choice) return choice;
    if (attempt >= 3) throw new Error(`Pick one of ${Object.keys(choices).join(", ")}`);
    ui.rejected(`Type ${Object.keys(choices).join(" or ")}.`);
  }
}

/** `dl setup` with the real terminal, ssh, gh, and filesystem. */
export async function setup(options: { io: LaptopIO; terminal: boolean; localSetup?: LocalSetup }): Promise<number> {
  const { io, terminal } = options;
  const color = io.color === true;
  const execFileAsync = promisify(execFile);
  const home = homedir();
  await setupWizard({
    newUi: () => terminal ? new TerminalUi(io.out, undefined, color) : new PlainUi(io.out),
    prompter: new TtyPrompter(),
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
  });
  return 0;
}
