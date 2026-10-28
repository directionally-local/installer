import { spawn } from "node:child_process";
import { join } from "node:path";
import type { SshAccess } from "./config.js";

/**
 * SSH from the laptop to the user's own server: which hosts they already have, which keys,
 * running a command there, and checking the server can take an install. Everything goes
 * through the system `ssh`, so the user's config, agent, and known_hosts all apply.
 */

/** A `Host` entry from ~/.ssh/config, with what we show next to it. */
export interface SshHost {
  alias: string;
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

type HostSettings = Omit<SshHost, "alias">;

/**
 * The concrete hosts in an ssh config. Wildcard and negated patterns are defaults, not
 * places to connect to, so they're skipped; `Match` blocks are ignored. ssh takes the first
 * value it finds for each option, so a host's own block wins, then global or `Host *` lines.
 */
export function parseSshConfig(text: string, home: string): SshHost[] {
  const blocks: Array<{ patterns: string[]; settings: HostSettings }> = [];
  const global: HostSettings = {};
  let current: HostSettings | undefined = global;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(\S+?)(?:\s*=\s*|\s+)(.+)$/.exec(line);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (key === "host") {
      const block = { patterns: value.split(/\s+/).map(unquote), settings: {} };
      blocks.push(block);
      current = block.settings;
      continue;
    }
    if (key === "match") {
      current = undefined;
      continue;
    }
    if (!current) continue;
    const setting = unquote(value);
    if (key === "hostname") current.hostName ??= setting;
    else if (key === "user") current.user ??= setting;
    else if (key === "identityfile") current.identityFile ??= expandHome(setting, home);
    else if (key === "port" && /^\d+$/.test(setting)) current.port ??= Number(setting);
  }
  const defaults: HostSettings = { ...global };
  for (const block of blocks) {
    if (!block.patterns.includes("*")) continue;
    for (const [key, value] of Object.entries(block.settings) as Array<[keyof HostSettings, never]>) defaults[key] ??= value;
  }
  const hosts = new Map<string, SshHost>();
  for (const block of blocks) {
    for (const pattern of block.patterns) {
      if (/[*?!]/.test(pattern) || hosts.has(pattern)) continue;
      const host: SshHost = { alias: pattern };
      for (const source of [block.settings, defaults]) {
        for (const [key, value] of Object.entries(source) as Array<[keyof HostSettings, never]>) host[key] ??= value;
      }
      hosts.set(pattern, host);
    }
  }
  return [...hosts.values()];
}

/** How a config host reads in a list: root@203.0.113.10, or with a port when it isn't 22. */
export function describeHost(host: SshHost): string {
  const port = host.port && host.port !== 22 ? `:${host.port}` : "";
  return `${host.user ? `${host.user}@` : ""}${host.hostName ?? host.alias}${port}`;
}

/** Private keys in ~/.ssh: the files that have a matching .pub next to them. */
export function discoverKeys(sshDir: string, names: string[]): string[] {
  const present = new Set(names);
  const preferred = ["id_ed25519", "id_ecdsa", "id_rsa"];
  return names
    .filter((name) => !name.endsWith(".pub") && present.has(`${name}.pub`))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((name) => join(sshDir, name));

  function rank(name: string): number {
    const index = preferred.indexOf(name);
    return index === -1 ? preferred.length : index;
  }
}

/** `user@host`, `host`, `user@host:2222`, or `user@[2001:db8::1]:2222` as typed by the user. */
export function parseTarget(input: string): SshAccess {
  const text = input.trim().replace(/^ssh\s+/, "");
  const match = /^(?:([A-Za-z0-9._-]+)@)?(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)(?::(\d{1,5}))?$/.exec(text);
  if (!match || match[2]!.startsWith("-")) throw new Error(`"${input.trim()}" isn't a server address; type it like root@203.0.113.10 or root@box.example.com:2222`);
  const host = match[2]!.replace(/^\[(.*)\]$/, "$1");
  const port = match[3] ? Number(match[3]) : undefined;
  if (port !== undefined && (port < 1 || port > 65535)) throw new Error(`${port} isn't a port`);
  return { target: `${match[1] ? `${match[1]}@` : ""}${host}`, ...(port && port !== 22 ? { port } : {}) };
}

/** Options for every non-interactive ssh: no password prompts, a bounded wait, and trust on first use. */
export function sshOptions(access: SshAccess): string[] {
  if (access.target.startsWith("-")) throw new Error(`Not a server: ${access.target}`);
  return [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=accept-new",
    ...(access.port ? ["-p", String(access.port)] : []),
    // With a chosen key, offer only it: an agent full of keys can hit the server's MaxAuthTries first.
    ...(access.identityFile ? ["-i", access.identityFile, "-o", "IdentitiesOnly=yes"] : []),
  ];
}

/** The command line people would type for this server, for messages. */
export function sshCommandLine(access: SshAccess): string {
  return ["ssh", ...(access.port ? ["-p", String(access.port)] : []), ...(access.identityFile ? ["-i", access.identityFile] : []), access.target].join(" ");
}

export interface SshResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SshExecOptions {
  /** Written to the remote command's stdin, then closed. Keys travel this way, never in argv. */
  input?: string;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  signal?: AbortSignal;
}

/** Runs one shell command on the server. Never throws for a non-zero exit; the caller decides. */
export type SshExec = (access: SshAccess, command: string, options?: SshExecOptions) => Promise<SshResult>;

export const realSshExec: SshExec = (access, command, options = {}) => new Promise((resolve, reject) => {
  const child = spawn("ssh", [...sshOptions(access), access.target, command], {
    stdio: ["pipe", "pipe", "pipe"],
    ...(options.signal ? { signal: options.signal } : {}),
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", lines((chunk) => { stdout += chunk; }, options.onStdoutLine));
  child.stderr.on("data", lines((chunk) => { stderr += chunk; }, options.onStderrLine));
  child.on("error", (error) => reject((error as NodeJS.ErrnoException).code === "ENOENT" ? new Error("ssh isn't installed on this computer") : error));
  child.on("close", (code) => resolve({ code: code ?? 255, stdout, stderr }));
  // Always close stdin: a remote command reading it would otherwise wait forever.
  child.stdin.on("error", () => { /* the command exited without reading it */ });
  child.stdin.end(options.input ?? "");
});

/** Collects a stream's text and calls back once per complete line. */
export function lines(collect: (chunk: string) => void, onLine?: (line: string) => void): (chunk: Buffer | string) => void {
  let pending = "";
  return (chunk) => {
    const text = chunk.toString();
    collect(text);
    if (!onLine) return;
    pending += text;
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    for (const part of parts) onLine(part.replace(/\r$/, ""));
  };
}

export interface ServerFacts {
  user: string;
  root: boolean;
  sudo: boolean;
  /** e.g. Ubuntu 24.04 */
  os: string;
  arch: string;
  /** ssh had never seen this host and saved its key (accept-new). */
  newHostKey: boolean;
}

/** The server refused our keys; the wizard offers others from ~/.ssh. */
export class SshAuthError extends Error {
  constructor(readonly access: SshAccess, detail: string) {
    super(`The server didn't accept this computer's SSH key (${detail}).`);
    this.name = "SshAuthError";
  }
}

const SUPPORTED_OS = new Set(["ubuntu 22.04", "ubuntu 24.04", "debian 12"]);

// One round trip: who we are, the OS, the CPU, and whether we can become root without a password.
const PROBE = 'id -u; id -un; . /etc/os-release; echo "$ID $VERSION_ID"; uname -m; ' +
  'if [ "$(id -u)" = 0 ]; then echo root; elif sudo -n true 2>/dev/null; then echo sudo; else echo nosudo; fi';

/** Connects once and checks the server can take an install: a supported OS, and root or passwordless sudo. */
export async function checkServer(access: SshAccess, ssh: SshExec, display: string): Promise<ServerFacts> {
  const result = await ssh(access, PROBE);
  const newHostKey = /Permanently added/i.test(result.stderr);
  if (result.code === 255 || result.stdout.trim() === "") {
    const detail = lastLine(result.stderr) || `ssh exited with ${result.code}`;
    if (/Permission denied|Too many authentication failures|no mutual signature|Authentication failed/i.test(result.stderr)) {
      throw new SshAuthError(access, detail);
    }
    if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(result.stderr)) {
      throw new Error(`${display}'s SSH host key changed since this computer last connected, so it stopped (that can mean someone is in the middle). If you rebuilt the server, remove the old key with: ssh-keygen -R ${hostOf(access.target)}`);
    }
    throw new Error(`Couldn't reach ${display} over SSH: ${detail}\n  Check that this works: ${sshCommandLine(access)}`);
  }
  const [uid, user, osLine, arch, privilege] = result.stdout.trim().split("\n").map((line) => line.trim());
  const os = formatOs(osLine ?? "");
  const facts: ServerFacts = {
    user: user || "?",
    root: uid === "0",
    sudo: privilege === "sudo",
    os,
    arch: arch === "aarch64" ? "arm64" : arch || "?",
    newHostKey,
  };
  if (!facts.root && !facts.sudo) {
    throw new Error([
      `${facts.user} on ${display} isn't root and can't use sudo without a password, and setup needs one of them.`,
      `  Either connect as root (root@${hostOf(access.target)}), or let ${facts.user} use sudo without a password:`,
      `     echo '${facts.user} ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/${facts.user}`,
    ].join("\n"));
  }
  if (!SUPPORTED_OS.has((osLine ?? "").toLowerCase().replace(/"/g, ""))) {
    throw new Error(`${display} runs ${os || "an unknown system"}; Directionally Local needs Ubuntu 22.04, Ubuntu 24.04, or Debian 12.`);
  }
  return facts;
}

function formatOs(line: string): string {
  const [id = "", version = ""] = line.replace(/"/g, "").split(/\s+/);
  const names: Record<string, string> = { ubuntu: "Ubuntu", debian: "Debian" };
  return `${names[id] ?? id} ${version}`.trim();
}

export function hostOf(target: string): string {
  return target.slice(target.lastIndexOf("@") + 1);
}

function lastLine(text: string): string {
  return text.trim().split("\n").filter((line) => !/Permanently added/i.test(line)).at(-1)?.trim() ?? "";
}

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function expandHome(path: string, home: string): string {
  return path.replace(/^~(?=$|\/)/, home).replace(/%d/g, home);
}

/** Single-quotes a value for the remote shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
