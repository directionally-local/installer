import type { RunOptions, System } from "./system.js";

/** A vendor's apt repository, as dl adds it: signed, with the key's fingerprint pinned here. */
export interface AptRepo {
  /** For messages: "Docker". */
  name: string;
  /** The key's URL. */
  keyUrl: string;
  /** Where the key goes, e.g. /etc/apt/keyrings/docker.asc. */
  keyring: string;
  /** The key's primary fingerprint, hex without spaces: checked before apt trusts it. */
  fingerprint: string;
  /** The deb line without "deb ", e.g. "[arch=amd64 signed-by=…] https://… noble stable". */
  line: string;
  /** The .list file under /etc/apt/sources.list.d. */
  list: string;
}

/** Docker's signing key: Docker Release (CE deb) <docker@docker.com>. */
export const DOCKER_FINGERPRINT = "9DC858229FC7DD38854AE2D88D81803C0EBFCD88";
/** Tailscale's signing key: Tailscale Inc. (Package repository signing key) <info@tailscale.com>. */
export const TAILSCALE_FINGERPRINT = "2596A99EAAB33821893C0A79458CA832957F5868";

/** The codenames each vendor publishes packages for, by /etc/os-release ID. */
const SUPPORTED_CODENAMES: Record<string, string[]> = {
  ubuntu: ["bionic", "focal", "jammy", "noble", "plucky", "questing"],
  debian: ["bullseye", "bookworm", "trixie"],
};

/** Whether the vendor publishes packages for this distro and codename. */
export function supportedCodename(id: string, codename: string): boolean {
  return SUPPORTED_CODENAMES[id]?.includes(codename) ?? false;
}

/** The codename, or a clear failure when the vendor has no packages for this distro. */
export function requireCodename(os: { id: string; codename: string; prettyName: string }, vendor: string): string {
  if (!supportedCodename(os.id, os.codename)) {
    throw new Error(`${vendor} doesn't publish packages for ${os.prettyName || os.id}${os.codename ? ` (${os.codename})` : ""}; use Ubuntu 24.04 or 22.04, or Debian 12.`);
  }
  return os.codename;
}

/** Docker's apt repository for this distro and CPU. */
export function dockerRepo(os: { id: string; codename: string; prettyName: string }, arch: string): AptRepo {
  const codename = requireCodename(os, "Docker");
  const dpkgArch = arch === "aarch64" ? "arm64" : arch === "x86_64" ? "amd64" : undefined;
  if (!dpkgArch) throw new Error(`Docker has no packages for ${arch}.`);
  return {
    name: "Docker",
    keyUrl: `https://download.docker.com/linux/${os.id}/gpg`,
    keyring: "/etc/apt/keyrings/docker.asc",
    fingerprint: DOCKER_FINGERPRINT,
    line: `[arch=${dpkgArch} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${os.id} ${codename} stable`,
    list: "/etc/apt/sources.list.d/docker.list",
  };
}

/** Tailscale's apt repository for this distro. */
export function tailscaleRepo(os: { id: string; codename: string; prettyName: string }): AptRepo {
  const codename = requireCodename(os, "Tailscale");
  return {
    name: "Tailscale",
    keyUrl: `https://pkgs.tailscale.com/stable/${os.id}/${codename}.noarmor.gpg`,
    keyring: "/etc/apt/keyrings/tailscale.gpg",
    fingerprint: TAILSCALE_FINGERPRINT,
    line: `[signed-by=/etc/apt/keyrings/tailscale.gpg] https://pkgs.tailscale.com/stable/${os.id} ${codename} main`,
    list: "/etc/apt/sources.list.d/tailscale.list",
  };
}

/**
 * The primary key's fingerprint from `gpg --show-keys --with-colons --with-fingerprint`, but only
 * when the file holds exactly one primary key: a file with a second `pub` record could get apt to
 * trust an attacker's key too, so it is refused. Subkeys' `fpr` lines are ignored.
 */
export function parseFingerprint(colonOutput: string): string | undefined {
  let pubs = 0;
  let wantFpr = false;
  let fingerprint: string | undefined;
  for (const line of colonOutput.split("\n")) {
    const fields = line.split(":");
    if (fields[0] === "pub") {
      pubs += 1;
      wantFpr = true;
      continue;
    }
    if (fields[0] === "fpr" && wantFpr) {
      if (pubs === 1 && fields[9]) fingerprint = fields[9].toUpperCase();
      wantFpr = false;
    }
  }
  return pubs === 1 ? fingerprint : undefined;
}

/**
 * Adds a vendor's signed apt repository: its key is downloaded, its fingerprint checked against
 * the pinned one before apt trusts it, and the deb line names it with signed-by. Nothing is
 * written when the key isn't the pinned one. Every step runs with the vendor steps' scrubbed
 * environment (vendor-script.ts), so dl's answers and secrets never reach it.
 */
export async function addSignedAptRepo(system: System, repo: AptRepo, options: { sudo?: boolean } = {}): Promise<void> {
  const run = (command: string, args: string[], runOptions: RunOptions = {}) =>
    options.sudo
      ? system.run("sudo", [command, ...args], { scrubbed: true, ...runOptions })
      : system.run(command, args, { scrubbed: true, ...runOptions });
  if ((await system.probe("gpg", ["--version"])).code !== 0) {
    await run("apt-get", ["update", "-qq"], { env: { DEBIAN_FRONTEND: "noninteractive" } });
    await run("apt-get", ["install", "-y", "-qq", "gnupg"], { env: { DEBIAN_FRONTEND: "noninteractive" } });
  }
  await run("mkdir", ["-p", "/etc/apt/keyrings"]);
  await run("chmod", ["755", "/etc/apt/keyrings"]);
  const download = `${repo.keyring}.download`;
  try {
    await run("curl", ["-fsSL", "--proto", "=https", "--tlsv1.2", repo.keyUrl, "-o", download], { describe: `download ${repo.name}'s signing key` });
    const shown = await run("gpg", ["--show-keys", "--with-colons", "--with-fingerprint", download]);
    const fingerprint = parseFingerprint(shown.stdout);
    if (fingerprint !== repo.fingerprint) {
      throw new Error(`${repo.name}'s signing key isn't the pinned one (fingerprint ${fingerprint ?? "unknown"}, expected ${repo.fingerprint}); nothing was added.`);
    }
    await run("mv", [download, repo.keyring]);
    await run("chmod", ["644", repo.keyring]);
    await run("tee", [repo.list], { input: `deb ${repo.line}\n` });
    await run("apt-get", ["update", "-qq"], { env: { DEBIAN_FRONTEND: "noninteractive" } });
  } finally {
    await run("rm", ["-f", download], { allowFailure: true });
  }
}
