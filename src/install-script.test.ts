import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseOsRelease } from "./detect.js";

const SCRIPT = new URL("../install.sh", import.meta.url).pathname;

/** install.sh only runs on Ubuntu or Debian: it reads the real /etc/os-release. */
function supportedHost(): boolean {
  if (process.platform !== "linux" || !existsSync("/etc/os-release")) return false;
  return ["ubuntu", "debian"].includes(parseOsRelease(readFileSync("/etc/os-release", "utf8")).id);
}

/**
 * Runs install.sh with every command it calls stubbed on PATH: root, a patched Node, curl
 * present, npm recording its arguments, and `directionallylocal` noting that `up` ran.
 */
function install(env: Record<string, string>, options: { npmFails?: boolean; dlUpFails?: boolean; counts?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dl-install-"));
  const stub = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  stub("id", 'echo 0');
  stub("uname", 'case "$1" in -m) echo x86_64 ;; *) echo Linux ;; esac');
  stub("node", 'exit 0');
  stub("curl", `echo "$*" >> "${dir}/curl.log"`);
  stub("npm", options.npmFails ? 'echo "npm ERR! 404 Not Found"; exit 1' : `echo "$*" >> "${dir}/npm.log"`);
  stub("dl", 'echo 0.1.2');
  stub("directionallylocal", `echo "$*" >> "${dir}/up.log"${options.dlUpFails ? "; exit 3" : ""}`);
  try {
    // The anonymous count is off unless a test turns it on (DL_NO_TELEMETRY: "").
    const result = spawnSync("sh", [SCRIPT], { env: { PATH: `${dir}:/usr/bin:/bin`, DL_NO_TELEMETRY: "1", ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const read = (name: string) => existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : undefined;
    return { ...result, npm: read("npm.log"), up: read("up.log"), counts: options.counts ? installCounts(join(dir, "curl.log")) : [] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const COUNT_URL = "https://free.directionallylocal.com/v1/telemetry/install";

/**
 * The install counts the script sent through the curl stub (its arguments, one call a line).
 * The count runs in the background after the script exits, so this waits briefly for it.
 */
function installCounts(log: string, waitMs = 1500): Array<{ args: string; body: Record<string, unknown> }> {
  const read = () =>
    (existsSync(log) ? readFileSync(log, "utf8") : "")
      .replace(/[^\n]*$/, "")
      .split("\n")
      .filter((line) => line.includes(COUNT_URL));
  const deadline = Date.now() + waitMs;
  // Only wait when a count may be on its way: the opt-out tests expect none and pay the full wait.
  while (read().length === 0 && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  return read().map((args) => ({ args, body: JSON.parse(/-d (\{.*\}) https:/.exec(args)![1]!) as Record<string, unknown> }));
}

describe("install.sh", () => {
  it("is valid sh", () => {
    const result = spawnSync("sh", ["-n", SCRIPT], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  });

  it("with DL_INSTALL_ONLY=1 installs the CLI and stops before dl up", { skip: !supportedHost() && "needs Ubuntu or Debian" }, () => {
    const only = install({ DL_INSTALL_ONLY: "1" });
    assert.equal(only.status, 0, only.stderr);
    assert.equal(only.stdout, "Directionally Local\n.. Getting the installer\nok Getting the installer: dl 0.1.2\n", "plain lines without a terminal");
    assert.match(only.npm ?? "", /^install -g --no-audit --no-fund --loglevel=error directionallylocal@latest$/m);
    assert.equal(only.up, undefined, "dl up didn't run");

    // Without it, the same install goes on to dl up (so the stubs above are what it calls).
    const full = install({});
    assert.equal(full.status, 0, full.stderr);
    assert.equal(full.up, "up\n");
  });

  it("reports a failed step on stderr and exits 1", { skip: !supportedHost() && "needs Ubuntu or Debian" }, () => {
    const failed = install({ DL_INSTALL_ONLY: "1" }, { npmFails: true });
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, "Directionally Local\n.. Getting the installer\n");
    assert.match(failed.stderr, /npm ERR! 404 Not Found[\s\S]*directionallylocal: installing directionallylocal@latest failed/);
    assert.equal(failed.up, undefined);
  });
});

/**
 * Runs install.sh as a laptop user would, with every command it calls stubbed on PATH: a
 * Node that is patched or not, npm installing a fake dl into --prefix, and curl serving a
 * Node.js download from `dist`. DL_TTY names a missing file, so there's no terminal to start dl in.
 */
function laptopInstall(options: { os?: "Darwin" | "Linux"; uid?: number; nodePatched?: boolean; shell?: string; env?: Record<string, string>; dist?: (dir: string) => void; npmFails?: boolean; npmOutput?: string; terminal?: boolean; extraPath?: string | ((home: string) => string); home?: (home: string) => void; dlExit?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dl-install-laptop-"));
  const bin = join(dir, "stubs");
  const home = join(dir, "home");
  const dist = join(dir, "dist");
  for (const path of [bin, home, dist]) mkdirSync(path);
  const stub = (name: string, body: string, where = bin) => {
    writeFileSync(join(where, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(where, name), 0o755);
  };
  stub("id", `echo ${options.uid ?? 501}`);
  stub("uname", `case "$1" in -m) echo arm64 ;; *) echo ${options.os ?? "Darwin"} ;; esac`);
  // A Node: -e is the CVE check; anything else runs dl's entry, which answers --version.
  const node = (patched: boolean) => `case "$1" in -e) exit ${patched ? 0 : 1} ;; -v) echo v24.22.1 ;; *) [ "$2" = --version ] && echo 0.10.0 || { echo "dl $* in $(pwd)" >> "${dir}/started.log"; echo "\${DL_REFERRAL-unset}" >> "${dir}/referral.log"; exit ${options.dlExit ?? 0}; } ;; esac`;
  stub("node", node(options.nodePatched ?? true));
  // npm: records its arguments and installs a dl entry point under --prefix.
  const npm = options.npmFails ? 'echo "npm http fetch GET 404 https://registry.npmjs.org/directionallylocal 80ms"; echo "npm ERR! 404"; exit 1' : `echo "$*" >> "${dir}/npm.log"
${options.npmOutput ?? ""}
prefix=""; while [ $# -gt 0 ]; do [ "$1" = --prefix ] && prefix=$2; shift; done
mkdir -p "$prefix/lib/node_modules/directionallylocal/bin" && echo '// dl' > "$prefix/lib/node_modules/directionallylocal/bin/directionallylocal.mjs"`;
  stub("npm", npm);
  stub("curl", `echo "$*" >> "${dir}/curl.log"
out=""; url=""; head=""; while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift ;; -*I*) head=1 ;; -*) ;; *) url=$1 ;; esac; shift; done
file="${dist}/$(basename "$url")"; [ -f "$file" ] || exit 22
if [ -n "$head" ]; then printf 'HTTP/2 200\\r\\ncontent-length: %s\\r\\n\\r\\n' "$(wc -c < "$file" | tr -d ' ')"; elif [ -n "$out" ]; then cp "$file" "$out"; else cat "$file"; fi`);
  stub("sudo", `echo "sudo $*" >> "${dir}/sudo.log"; exit 1`);
  options.dist?.(dist);
  options.home?.(home);
  const extraPath = typeof options.extraPath === "function" ? options.extraPath(home) : options.extraPath;
  // An empty file stands in for the terminal: opening it works, as /dev/tty does at one.
  const tty = join(dir, "terminal");
  if (options.terminal) writeFileSync(tty, "");
  {
    const result = spawnSync("sh", [SCRIPT], {
      cwd: home,
      env: { PATH: `${bin}:/usr/bin:/bin`, DL_NO_TELEMETRY: "1", HOME: home, SHELL: options.shell ?? "/bin/zsh", DL_NODE_DIST: "https://nodejs.example/dist", DL_TTY: options.terminal ? tty : join(dir, "no-terminal"), DL_SERVER_STATE: join(dir, "no-server-state"), ...options.env, ...(extraPath ? { PATH: `${extraPath}:${bin}:/usr/bin:/bin` } : {}) },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const read = (path: string) => existsSync(path) ? readFileSync(path, "utf8") : undefined;
    // The caller removes `dir` once it has read what it needs.
    const counts = () => installCounts(join(dir, "curl.log"));
    return { ...result, dir, home, read, counts, npm: read(join(dir, "npm.log")), curl: read(join(dir, "curl.log")), sudo: read(join(dir, "sudo.log")) };
  }
}

/** A Node.js 24 download and its SHASUMS256.txt, as nodejs.org lays them out. */
function nodeDist(dist: string, options: { corrupt?: boolean } = {}): void {
  const name = "node-v24.22.1-darwin-arm64";
  const build = join(dist, "build");
  mkdirSync(join(build, name, "bin"), { recursive: true });
  const write = (file: string, body: string) => {
    writeFileSync(join(build, name, "bin", file), `#!/bin/sh\n${body}\n`);
    chmodSync(join(build, name, "bin", file), 0o755);
  };
  write("node", 'case "$1" in -e) exit 0 ;; -v) echo v24.22.1 ;; *) echo 0.10.0 ;; esac');
  // What dl never uses, which the install drops: C headers and docs.
  mkdirSync(join(build, name, "include", "node"), { recursive: true });
  writeFileSync(join(build, name, "include", "node", "node.h"), "");
  writeFileSync(join(build, name, "CHANGELOG.md"), "");
  writeFileSync(join(build, name, "LICENSE"), "");
  write("npm", `echo "own $*" >> "${dirname(dist)}/npm.log"
prefix=""; while [ $# -gt 0 ]; do [ "$1" = --prefix ] && prefix=$2; shift; done
mkdir -p "$prefix/lib/node_modules/directionallylocal/bin" && echo '// dl' > "$prefix/lib/node_modules/directionallylocal/bin/directionallylocal.mjs"`);
  // Both archives nodejs.org has; the install takes the .tar.xz (half the size) when tar can unpack it.
  const sums = [`${"0".repeat(64)}  node-v24.22.1-linux-x64.tar.gz`];
  for (const [ext, flag] of [["tar.gz", "-czf"], ["tar.xz", "-cJf"]] as const) {
    const tarball = join(dist, `${name}.${ext}`);
    execFileSync("tar", [flag, tarball, "-C", build, name]);
    const sum = createHash("sha256").update(readFileSync(tarball)).digest("hex");
    sums.push(`${options.corrupt ? "f".repeat(64) : sum}  ${name}.${ext}`);
  }
  writeFileSync(join(dist, "SHASUMS256.txt"), `${sums.join("\n")}\n`);
}

/**
 * dl's prebuilt bundles as the release publishes them: dl-bundles.txt and one .tar.gz per
 * platform, holding lib/node_modules/directionallylocal as npm lays it out under --prefix.
 */
function bundleDist(dist: string, options: { platform?: string; node?: number; corrupt?: boolean; missing?: boolean } = {}): void {
  const platform = options.platform ?? "darwin-arm64";
  const file = `dl-0.14.0-${platform}.tar.gz`;
  const build = join(dist, "bundle-build");
  mkdirSync(join(build, "lib", "node_modules", "directionallylocal", "bin"), { recursive: true });
  writeFileSync(join(build, "lib", "node_modules", "directionallylocal", "bin", "directionallylocal.mjs"), "// dl from the bundle\n");
  const tarball = join(dist, file);
  execFileSync("tar", ["-czf", tarball, "-C", build, "lib"]);
  const sum = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  const bytes = statSync(tarball).size;
  if (options.missing) rmSync(tarball);
  writeFileSync(join(dist, "dl-bundles.txt"), `# dl 0.14.0\nlinux-x64 dl-0.14.0-linux-x64.tar.gz ${"0".repeat(64)} 123 24\n${platform} ${file} ${options.corrupt ? "f".repeat(64) : sum} ${bytes} ${options.node ?? 24}\n`);
}

describe("install.sh on a laptop", () => {
  const cleanup: string[] = [];
  const run = (options: Parameters<typeof laptopInstall>[0] = {}) => {
    const result = laptopInstall(options);
    cleanup.push(result.dir);
    return result;
  };
  after(() => { for (const dir of cleanup) rmSync(dir, { recursive: true, force: true }); });

  it("on macOS, with a patched Node, installs dl into ~/.directionallylocal with no sudo and puts it on PATH", () => {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const root = join(result.home, ".directionallylocal");
    assert.match(result.npm ?? "", new RegExp(`^install -g --prefix ${root}/dl --cache ${root}/npm-cache --no-audit --no-fund --no-update-notifier --loglevel=info --foreground-scripts directionallylocal@latest$`, "m"));
    assert.ok(!existsSync(join(root, "npm-cache")), "npm's cache for the install is removed afterwards");
    assert.equal(result.sudo, undefined, "no sudo");
    assert.doesNotMatch(result.curl ?? "", /nodejs/, "no Node download");
    assert.match(result.curl ?? "", /^-fsSL https:\/\/directionallylocal\.run\/dl\/latest\/dl-bundles\.txt$/m, "it looked for a prebuilt bundle; there's none, so npm");
    const wrapper = result.read(join(root, "bin", "dl"))!;
    assert.match(wrapper, new RegExp(`exec "[^"]*/stubs/node" "${root}/dl/lib/node_modules/directionallylocal/bin/directionallylocal\\.mjs" "\\$@"`));
    assert.doesNotMatch(wrapper, /export PATH/, "the user's own Node: nothing added to PATH");
    assert.ok(existsSync(join(root, "bin", "directionallylocal")));
    assert.equal(result.read(join(result.home, ".zshrc")), `\n# Directionally Local (dl)\nexport PATH="${root}/bin:$PATH"\n`);
    assert.match(result.stdout, /ok Installing dl: dl 0\.10\.0 · in .*\.directionallylocal · 0:0\d\n\.\. Adding dl to your PATH\nok Adding dl to your PATH: in .*\/\.zshrc\n/);
    assert.match(result.stdout, /\n\n {2}Then run: source ~\/\.zshrc && dl\n$/, "no terminal: dl isn't started; this shell's PATH can't change: the one line that fixes it");
    assert.doesNotMatch(result.stdout, /Next time/, "not also the same advice a second way");
    assert.doesNotMatch(result.stdout, /sudo sh/, "the server hint is for Linux");
  });

  it("is safe to run again: one PATH line, DL_VERSION pins the version", () => {
    const first = laptopInstall({ env: { DL_VERSION: "0.10.0" } });
    cleanup.push(first.dir);
    assert.equal(first.status, 0, first.stderr);
    const again = spawnSync("sh", [SCRIPT], { cwd: first.home, env: { PATH: `${first.dir}/stubs:/usr/bin:/bin`, HOME: first.home, SHELL: "/bin/zsh", DL_VERSION: "0.10.0", DL_TTY: "/nonexistent" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(again.status, 0, again.stderr);
    const rc = first.read(join(first.home, ".zshrc"))!;
    assert.equal(rc.match(/Directionally Local/g)?.length, 1);
    assert.match(first.read(join(first.dir, "npm.log"))!, /directionallylocal@0\.10\.0\n.*directionallylocal@0\.10\.0\n$/);
  });

  it("without a patched Node, installs Node.js 24 from nodejs.org into ~/.directionallylocal, checked against SHASUMS256.txt", () => {
    const result = run({ nodePatched: false, shell: "/bin/bash", dist: (dist) => nodeDist(dist) });
    assert.equal(result.status, 0, result.stderr);
    const root = join(result.home, ".directionallylocal");
    assert.match(result.curl ?? "", /nodejs\.example\/dist\/SHASUMS256\.txt[\s\S]*-o \S*\.directionallylocal\/node-v24\.22\.1-darwin-arm64\.tar\.xz\.download nodejs\.example\/dist\/node-v24\.22\.1-darwin-arm64\.tar\.xz|nodejs\.example\/dist\/node-v24\.22\.1-darwin-arm64\.tar\.xz -o/, "the .tar.xz, half the download");
    assert.doesNotMatch(result.curl ?? "", /\.tar\.gz/);
    assert.match(result.stdout, /\.\. Downloading Node\.js 24 \(1 MB\)\n/, "its size, from the download's Content-Length");
    assert.match(result.stdout, /ok Installing Node\.js 24: v24\.22\.1 · in .*\.directionallylocal\/node/);
    assert.match(result.npm ?? "", /^own install -g --prefix .*\.directionallylocal\/dl /m, "dl installed with its own Node's npm");
    const wrapper = result.read(join(root, "bin", "dl"))!;
    assert.match(wrapper, new RegExp(`export PATH="${root}/node/bin:\\$PATH"\nexec "${root}/node/bin/node" `), "its own Node, on PATH for dl only");
    assert.ok(existsSync(join(root, "node", "bin", "node")));
    assert.ok(!lstatSync(join(root, "node")).isSymbolicLink(), "one copy of Node, in node itself");
    assert.deepEqual(readdirSync(root).sort(), ["bin", "dl", "node"], "no versioned Node directory, download or npm cache beside it");
    assert.deepEqual(readdirSync(join(root, "node")).sort(), ["LICENSE", "bin"], "no C headers or docs");
    assert.match(result.read(join(result.home, ".bash_profile")) ?? "", /export PATH=".*\.directionallylocal\/bin:\$PATH"/, "bash on macOS reads .bash_profile");
  });

  it("refuses a Node.js download whose checksum doesn't match", () => {
    const result = run({ nodePatched: false, dist: (dist) => nodeDist(dist, { corrupt: true }) });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /the Node\.js download didn't match its checksum/);
    assert.ok(!existsSync(join(result.home, ".directionallylocal", "node")));
    assert.equal(result.npm, undefined);
  });

  it("on Linux as a user is a laptop too, and says how to install a server instead", () => {
    const result = run({ os: "Linux", shell: "/usr/bin/fish" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.sudo, undefined);
    assert.match(result.stdout, /For a server instead, run it as root: curl -fsSL https:\/\/directionallylocal\.run \| sudo sh/);
    assert.match(result.read(join(result.home, ".config", "fish", "conf.d", "directionallylocal.fish")) ?? "", /set -gx PATH ".*\.directionallylocal\/bin" \$PATH/);
  });

  it("with dl already on PATH and DL_NO_MODIFY_PATH=1, touches no startup file and prints no fallback", () => {
    const home = mkdtempSync(join(tmpdir(), "dl-home-"));
    cleanup.push(home);
    const result = run({ env: { DL_NO_MODIFY_PATH: "1", DL_HOME: join(home, "dl-here") } });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!existsSync(join(result.home, ".zshrc")));
    assert.ok(existsSync(join(home, "dl-here", "bin", "dl")));
    assert.match(result.stdout, new RegExp(`dl isn't on your PATH\\. To use it, run: export PATH="${home}/dl-here/bin:\\$PATH"\n`), "not on PATH yet, and no startup file says so");
    const onPath = run({ env: { DL_NO_MODIFY_PATH: "1", DL_HOME: join(home, "dl-there") }, extraPath: join(home, "dl-there", "bin") });
    assert.equal(onPath.status, 0, onPath.stderr);
    assert.doesNotMatch(onPath.stdout, /new terminal|PATH|source/);
    assert.match(onPath.stdout, /Then type: dl\n$/);
  });

  it("at a terminal, ends by starting dl in the folder it ran from", () => {
    const result = laptopInstall({ terminal: true });
    cleanup.push(result.dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.read(join(result.dir, "started.log")) ?? "", new RegExp(`^dl .*directionallylocal\\.mjs in ${result.home}\n$`));
    assert.doesNotMatch(result.stdout, /Then type: dl/);
    // Back at the shell it was piped from, whose PATH it couldn't change: the line that fixes it, last.
    assert.match(result.stdout, /To use dl in this terminal, run: source ~\/\.zshrc\n$/);
    assert.match(result.stdout, /\n {2}Next time, open a new terminal or run: source ~\/\.zshrc\n/, "for later terminals, before dl starts");
    assert.doesNotMatch(result.stdout, /Then run:/);
    const skipped = laptopInstall({ terminal: true, env: { DL_NO_START: "1" } });
    cleanup.push(skipped.dir);
    assert.equal(skipped.read(join(skipped.dir, "started.log")), undefined);
    // DL_NO_START=1 (as dl.new/continue does before starting dl itself): one line, not two saying the same.
    assert.match(skipped.stdout, /\n\n {2}Then run: source ~\/\.zshrc && dl\n$/);
    assert.doesNotMatch(skipped.stdout, /Next time/);
  });

  it("from an invite link, starts dl with DL_REFERRAL and keeps the code for a later sign-in", () => {
    const result = run({ terminal: true, env: { DL_REFERRAL: "Octo-Cat" } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.read(join(result.dir, "referral.log")), "octo-cat\n", "dl gets the code, lowercased");
    const kept = join(result.home, ".config", "directionallylocal", "pending-referral");
    assert.equal(result.read(kept), "octo-cat\n");
    assert.equal(statSync(kept).mode & 0o777, 0o600);

    // Without a terminal dl isn't started; the kept code is what credits the sign-in later.
    const later = run({ env: { DL_REFERRAL: "octo" } });
    assert.equal(later.status, 0, later.stderr);
    assert.equal(later.read(join(later.dir, "referral.log")), undefined);
    assert.equal(later.read(join(later.home, ".config", "directionallylocal", "pending-referral")), "octo\n");

    // A code kept already stays: the first link is the one credited.
    const second = run({ terminal: true, env: { DL_REFERRAL: "other" }, home: (home) => { mkdirSync(join(home, ".config", "directionallylocal"), { recursive: true }); writeFileSync(join(home, ".config", "directionallylocal", "pending-referral"), "octo\n"); } });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.read(join(second.home, ".config", "directionallylocal", "pending-referral")), "octo\n");
    assert.equal(second.read(join(second.dir, "referral.log")), "other\n", "this run still passes its own code on");
  });

  it("ignores a DL_REFERRAL that isn't a GitHub username, and passes nothing on without one", () => {
    for (const bad of ["-octo", "octo cat", "a".repeat(40), "$(id)"]) {
      const result = run({ terminal: true, env: { DL_REFERRAL: bad } });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Ignoring DL_REFERRAL: an invite code is a GitHub username\./);
      assert.equal(result.read(join(result.dir, "referral.log")), "unset\n", bad);
      assert.ok(!existsSync(join(result.home, ".config", "directionallylocal")));
    }
    const plain = run({ terminal: true });
    assert.equal(plain.read(join(plain.dir, "referral.log")), "unset\n");
    assert.doesNotMatch(plain.stdout, /DL_REFERRAL/);
    assert.ok(!existsSync(join(plain.home, ".config", "directionallylocal")));
  });

  it("links dl into ~/.local/bin when this shell has it on PATH, so dl works in the same terminal", () => {
    const localBin = (home: string) => join(home, ".local", "bin");
    const result = run({ os: "Linux", shell: "/bin/bash", terminal: true, home: (home) => mkdirSync(localBin(home), { recursive: true }), extraPath: localBin });
    assert.equal(result.status, 0, result.stderr);
    const root = join(result.home, ".directionallylocal");
    assert.equal(readlinkSync(join(localBin(result.home), "dl")), join(root, "bin", "dl"));
    assert.equal(readlinkSync(join(localBin(result.home), "directionallylocal")), join(root, "bin", "directionallylocal"));
    assert.match(result.stdout, /ok Linking dl into ~\/\.local\/bin: works in this terminal too\n/);
    assert.doesNotMatch(result.stdout, /source|new terminal/, "nothing to do");
    assert.match(result.read(join(result.home, ".bashrc")) ?? "", /export PATH=".*\.directionallylocal\/bin:\$PATH"/, "new shells get it from .bashrc as before");

    // Not on PATH (Ubuntu adds ~/.local/bin only when it exists at login): no link, the reminder instead.
    const notOnPath = run({ os: "Linux", shell: "/bin/bash", terminal: true, home: (home) => mkdirSync(localBin(home), { recursive: true }) });
    assert.equal(notOnPath.status, 0, notOnPath.stderr);
    assert.ok(!existsSync(join(localBin(notOnPath.home), "dl")));
    assert.match(notOnPath.stdout, /Next time, open a new terminal or run: source ~\/\.bashrc\n/);
    assert.match(notOnPath.stdout, /To use dl in this terminal, run: source ~\/\.bashrc\n$/);

    // Someone else's dl there stays; the reminder instead.
    const taken = run({ os: "Linux", shell: "/bin/bash", home: (home) => { mkdirSync(localBin(home), { recursive: true }); writeFileSync(join(localBin(home), "dl"), "#!/bin/sh\n"); }, extraPath: localBin });
    assert.equal(taken.status, 0, taken.stderr);
    assert.equal(readFileSync(join(localBin(taken.home), "dl"), "utf8"), "#!/bin/sh\n");
    assert.match(taken.stdout, /Then run: source ~\/\.bashrc && dl\n$/);
  });

  it("for sh, says . ~/.profile (sh has no source)", () => {
    const result = run({ os: "Linux", shell: "/bin/sh" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Then run: \. ~\/\.profile && dl\n$/);
  });

  it("passes on dl's exit code, after the reminder", () => {
    const result = run({ terminal: true, dlExit: 3 });
    assert.equal(result.status, 3);
    assert.match(result.stdout, /To use dl in this terminal, run: source ~\/\.zshrc\n$/);
  });

  it("replaces an earlier install's Node link and versioned directory with one node directory", () => {
    const result = run({
      nodePatched: false,
      dist: (dist) => nodeDist(dist),
      home: (home) => {
        // As earlier versions of this script left it, with a Node that's now too old.
        const root = join(home, ".directionallylocal");
        mkdirSync(join(root, "node-v24.10.0-darwin-arm64", "bin"), { recursive: true });
        writeFileSync(join(root, "node-v24.10.0-darwin-arm64", "bin", "node"), "#!/bin/sh\nexit 1\n");
        chmodSync(join(root, "node-v24.10.0-darwin-arm64", "bin", "node"), 0o755);
        symlinkSync(join(root, "node-v24.10.0-darwin-arm64"), join(root, "node"));
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const root = join(result.home, ".directionallylocal");
    assert.ok(!lstatSync(join(root, "node")).isSymbolicLink());
    assert.deepEqual(readdirSync(root).sort(), ["bin", "dl", "node"]);
  });

  it("shows what the install is doing: downloading, setting up Autopilot, building native parts, and a hint on a slow network", () => {
    // npm's --loglevel=info lines, as the install reads them; a phase lasts long enough to be seen.
    const npmOutput = [
      'echo "npm http fetch GET 200 https://registry.npmjs.org/autopilot-ai 80ms (cache miss)" >&2',
      'echo "npm http fetch GET 200 https://registry.npmjs.org/autopilot-ai/-/autopilot-ai-3.7.0.tgz 90ms (cache miss)" >&2',
      'echo "npm http fetch GET 200 https://registry.npmjs.org/ink/-/ink-7.1.1.tgz 90ms (cache miss)" >&2',
      "sleep 2",
      'echo "npm info run isolated-vm@6.2.0 install node_modules/isolated-vm node-gyp-build || node-gyp rebuild" >&2',
      "sleep 1.5",
      'echo "gyp info it worked if it ends with ok" >&2',
      "sleep 1.5",
    ].join("\n");
    const result = run({ npmOutput, env: { DL_SLOW_AFTER: "1" } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\.\. Installing dl\n {3}Downloading dl(: \S.*)? \(0:00\)\n {3}Slow network\? This downloads about 40 MB\. It keeps going; press Ctrl\+C to stop\.\n {3}Setting up Autopilot \(0:0\d\)\n {3}Building native parts \(one time, ~1 min\) \(0:0\d\)\nok Installing dl: /);
    assert.equal(result.stdout.match(/Slow network/g)?.length, 1, "the hint once");

    // A quick install: no hint, and no build step when nothing is compiled.
    const quick = run({ npmOutput: npmOutput.replace(/^echo "gyp.*$/m, "").replace(/sleep \S+/g, "sleep 1.1") });
    assert.equal(quick.status, 0, quick.stderr);
    assert.doesNotMatch(quick.stdout, /Slow network|Building native parts/);
    assert.match(quick.stdout, /Setting up Autopilot/);
  });

  it("installs dl from the prebuilt bundle for this computer: one download, its size shown, checked against its SHA-256", () => {
    const result = run({ dist: (dist) => bundleDist(dist) });
    assert.equal(result.status, 0, result.stderr);
    const root = join(result.home, ".directionallylocal");
    assert.equal(result.npm, undefined, "no npm");
    assert.match(result.curl ?? "", /^-fsSL https:\/\/directionallylocal\.run\/dl\/latest\/dl-bundles\.txt\n-fsSL https:\/\/directionallylocal\.run\/dl\/0\.14\.0\/dl-0\.14\.0-darwin-arm64\.tar\.gz -o /m, "the list, then this computer's bundle (its size is in the list)");
    assert.equal(result.read(join(root, "dl", "lib", "node_modules", "directionallylocal", "bin", "directionallylocal.mjs")), "// dl from the bundle\n");
    assert.match(result.read(join(root, "bin", "dl")) ?? "", /directionallylocal\.mjs" "\$@"/);
    assert.deepEqual(readdirSync(root).sort(), ["bin", "dl"], "no download or unpacking directory left");
    assert.match(result.stdout, /\.\. Installing dl\n\.\. Downloading dl \(1 MB\)\n(.*\n)*\.\. Setting up Autopilot\nok Installing dl: dl 0\.10\.0 · in .*\.directionallylocal · 0:0\d\n/);

    // DL_VERSION picks that version's list.
    const pinned = run({ dist: (dist) => bundleDist(dist), env: { DL_VERSION: "0.14.0" } });
    assert.equal(pinned.status, 0, pinned.stderr);
    assert.match(pinned.curl ?? "", /^-fsSL https:\/\/directionallylocal\.run\/dl\/0\.14\.0\/dl-bundles\.txt$/m);
    assert.equal(pinned.npm, undefined);
  });

  it("falls back to npm when the bundle doesn't check out, isn't there, or isn't for this computer", () => {
    const corrupt = run({ dist: (dist) => bundleDist(dist, { corrupt: true }) });
    assert.equal(corrupt.status, 0, corrupt.stderr);
    assert.match(corrupt.stdout, /The prebuilt download didn't work \(it didn't match its checksum\); installing with npm instead\.\n/);
    assert.match(corrupt.npm ?? "", /^install -g --prefix /m);
    assert.deepEqual(readdirSync(join(corrupt.home, ".directionallylocal")).sort(), ["bin", "dl"], "the bad download is removed");

    const missing = run({ dist: (dist) => bundleDist(dist, { missing: true }) });
    assert.equal(missing.status, 0, missing.stderr);
    assert.match(missing.stdout, /The prebuilt download didn't work \(the download didn't finish\); installing with npm instead\./);
    assert.match(missing.npm ?? "", /^install -g /m);

    // Quietly npm: no bundle for this platform, or one built for another Node.js major version.
    for (const bundle of [{ platform: "darwin-x64" }, { node: 22 }]) {
      const other = run({ dist: (dist) => bundleDist(dist, bundle) });
      assert.equal(other.status, 0, other.stderr);
      assert.match(other.npm ?? "", /^install -g /m, JSON.stringify(bundle));
      assert.doesNotMatch(other.stdout, /prebuilt/);
      assert.doesNotMatch(other.curl ?? "", /\.tar\.gz/);
    }

    // DL_PACKAGE (a local build) and DL_NO_BUNDLE=1 don't look for one.
    for (const env of [{ DL_PACKAGE: "/tmp/directionallylocal-0.14.0.tgz" }, { DL_NO_BUNDLE: "1" }] as Record<string, string>[]) {
      const skipped = run({ dist: (dist) => bundleDist(dist), env });
      assert.equal(skipped.status, 0, skipped.stderr);
      assert.equal(skipped.curl, undefined, JSON.stringify(env));
      assert.match(skipped.npm ?? "", /^install -g /m);
    }
  });

  it("refuses root on macOS, and fails clearly when npm does", () => {
    const root = run({ uid: 0 });
    assert.equal(root.status, 1);
    assert.match(root.stderr, /run it as yourself, without sudo/);
    const failed = run({ npmFails: true });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /npm ERR! 404[\s\S]*directionallylocal: installing directionallylocal@latest failed/);
    assert.doesNotMatch(failed.stderr, /npm http fetch/, "the error, without npm's progress lines");
  });

  it("DL_MODE must be server or laptop", () => {
    const result = run({ env: { DL_MODE: "desktop" } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /DL_MODE is server or laptop \(got desktop\)/);
  });
});

describe("install.sh: the anonymous install count", () => {
  const cleanup: string[] = [];
  const run = (options: Parameters<typeof laptopInstall>[0] = {}) => {
    const result = laptopInstall({ ...options, env: { DL_NO_TELEMETRY: "", ...options.env } });
    cleanup.push(result.dir);
    return result;
  };
  after(() => { for (const dir of cleanup) rmSync(dir, { recursive: true, force: true }); });

  it("sends one count when a laptop install finishes: only allowlisted values, in the background, printing nothing", () => {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const counts = result.counts();
    assert.equal(counts.length, 1);
    assert.deepEqual(counts[0]!.body, { os: "darwin", arch: "arm64", mode: "laptop", dlVersion: "0.10.0", result: "ok", via: "run" });
    assert.match(counts[0]!.args, /^-fsS -m 3 -X POST -H Content-Type: application\/json -d \{/);
    assert.doesNotMatch(result.stdout + result.stderr, /telemetry|free\.directionallylocal|anonymous|count/i);
  });

  it("says which page it came from (DL_INSTALL_VIA from dl.new), and run for anything else", () => {
    assert.equal(run({ env: { DL_INSTALL_VIA: "invite" } }).counts()[0]!.body.via, "invite");
    assert.equal(run({ env: { DL_INSTALL_VIA: "continue" } }).counts()[0]!.body.via, "continue");
    assert.equal(run({ env: { DL_INSTALL_VIA: "evil\",\"x\":\"1" } }).counts()[0]!.body.via, "run");
  });

  it("counts a failed install with the step it failed at, and still fails the same way", () => {
    const npm = run({ npmFails: true });
    assert.equal(npm.status, 1);
    assert.deepEqual(npm.counts().map((count) => count.body), [{ os: "darwin", arch: "arm64", mode: "laptop", dlVersion: "", result: "failed", failedStep: "install_dl", via: "run" }]);
    const node = run({ nodePatched: false, dist: (dist) => nodeDist(dist, { corrupt: true }) });
    assert.equal(node.status, 1);
    assert.equal(node.counts()[0]!.body.failedStep, "node");
    const root = run({ uid: 0 });
    assert.equal(root.status, 1);
    assert.equal(root.counts()[0]!.body.failedStep, "preflight");
  });

  it("maps the progress phases onto the same steps: the Node.js download is node, npm's phases are install_dl", () => {
    // The Node.js download itself fails (shown as "Downloading Node.js 24"): node.
    const download = run({ nodePatched: false, dist: (dist) => { nodeDist(dist); rmSync(join(dist, "node-v24.22.1-darwin-arm64.tar.xz")); } });
    assert.equal(download.status, 1);
    assert.match(download.stderr, /downloading https:\/\/nodejs\.example\/dist\/node-v24\.22\.1-darwin-arm64\.tar\.xz failed/);
    assert.deepEqual(download.counts().map((count) => [count.body.result, count.body.failedStep]), [["failed", "node"]]);
    // npm failing after it got to "Setting up Autopilot" and "Building native parts": still install_dl.
    const npmOutput = 'echo "npm info run isolated-vm@6.2.0 install node_modules/isolated-vm node-gyp-build" >&2; echo "gyp info it worked if it ends with ok" >&2; sleep 1.2; exit 1';
    const build = run({ npmOutput });
    assert.equal(build.status, 1);
    assert.match(build.stdout, /Building native parts/);
    assert.deepEqual(build.counts().map((count) => [count.body.result, count.body.failedStep]), [["failed", "install_dl"]]);
    // A slow install that finishes is one ok count; the hint doesn't change it.
    const slow = run({ npmOutput: 'echo "npm http fetch GET 200 https://registry.npmjs.org/x 5ms" >&2; sleep 1.5', env: { DL_SLOW_AFTER: "1" } });
    assert.equal(slow.status, 0, slow.stderr);
    assert.match(slow.stdout, /Slow network\?/);
    assert.deepEqual(slow.counts().map((count) => count.body.result), ["ok"]);
  });

  it("is sent the same way when dl comes from the prebuilt bundle, or npm after a bundle that didn't work", () => {
    const bundled = run({ dist: (dist) => bundleDist(dist) });
    assert.equal(bundled.status, 0, bundled.stderr);
    assert.equal(bundled.npm, undefined, "from the bundle");
    assert.deepEqual(bundled.counts().map((count) => count.body), [{ os: "darwin", arch: "arm64", mode: "laptop", dlVersion: "0.10.0", result: "ok", via: "run" }]);
    const fellBack = run({ dist: (dist) => bundleDist(dist, { corrupt: true }) });
    assert.equal(fellBack.status, 0, fellBack.stderr);
    assert.match(fellBack.stdout, /installing with npm instead/);
    assert.deepEqual(fellBack.counts().map((count) => count.body.result), ["ok"], "a bundle that didn't work isn't a failed install");
    const failed = run({ dist: (dist) => bundleDist(dist, { corrupt: true }), npmFails: true });
    assert.equal(failed.status, 1);
    assert.deepEqual(failed.counts().map((count) => [count.body.result, count.body.failedStep]), [["failed", "install_dl"]]);
  });

  it("is sent before dl starts, once, whatever dl does after", () => {
    const result = run({ terminal: true, dlExit: 4 });
    assert.equal(result.status, 4);
    assert.deepEqual(result.counts().map((count) => count.body.result), ["ok"]);
  });

  it("is skipped with DL_NO_TELEMETRY=1, DO_NOT_TRACK=1 or in CI", () => {
    for (const env of [{ DL_NO_TELEMETRY: "1" }, { DO_NOT_TRACK: "1" }, { CI: "true" }] as Array<Record<string, string>>) {
      const result = run({ env });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.counts(), [], JSON.stringify(env));
    }
  });

  it("on a server, counts the install after dl up, or the step that failed", { skip: !supportedHost() && "needs Ubuntu or Debian" }, () => {
    const only = install({ DL_NO_TELEMETRY: "", DL_INSTALL_ONLY: "1" }, { counts: true });
    assert.equal(only.status, 0, only.stderr);
    assert.deepEqual(only.counts.map((count) => count.body), [{ os: "linux", arch: "x64", mode: "server", dlVersion: "0.1.2", result: "ok", via: "run" }]);
    const full = install({ DL_NO_TELEMETRY: "", DL_INSTALL_VIA: "home" }, { counts: true });
    assert.equal(full.up, "up\n");
    assert.deepEqual(full.counts.map((count) => [count.body.result, count.body.via]), [["ok", "home"]]);
    const up = install({ DL_NO_TELEMETRY: "" }, { dlUpFails: true, counts: true });
    assert.equal(up.status, 3);
    assert.deepEqual(up.counts.map((count) => [count.body.result, count.body.failedStep]), [["failed", "dl_up"]]);
    const npm = install({ DL_NO_TELEMETRY: "" }, { npmFails: true, counts: true });
    assert.deepEqual(npm.counts.map((count) => [count.body.result, count.body.failedStep, count.body.dlVersion]), [["failed", "install_dl", ""]]);
    assert.deepEqual(install({ DO_NOT_TRACK: "1" }, { counts: true }).counts, []);
  });
});

describe("install.sh: server or laptop", () => {
  it("root on Linux, the laptop's setup over SSH, or a machine dl up set up is a server; DL_MODE decides when set", { skip: !supportedHost() && "needs Ubuntu or Debian" }, () => {
    // As root: the server path, as before (install() stubs id as 0).
    const rooted = install({ DL_INSTALL_ONLY: "1" });
    assert.equal(rooted.status, 0, rooted.stderr);
    assert.match(rooted.npm ?? "", /^install -g --no-audit/m, "a global install, not into a home directory");
    // DL_MODE=server as a user: the server path, through sudo, as before this rule.
    const user = laptopInstall({ os: "Linux", env: { DL_MODE: "server" } });
    try {
      assert.equal(user.status, 1, "the stub sudo fails");
      assert.match(user.sudo ?? "", /^sudo -E npm install -g/m, "the server path, through sudo");
    } finally {
      rmSync(user.dir, { recursive: true, force: true });
    }
    const viaSetup = laptopInstall({ os: "Linux", env: { DL_INSTALL_ONLY: "1" } });
    try {
      assert.match(viaSetup.sudo ?? "", /^sudo -E npm install -g/m, "DL_INSTALL_ONLY=1 (the laptop's setup, over SSH) is always a server");
    } finally {
      rmSync(viaSetup.dir, { recursive: true, force: true });
    }
    // A user on a Linux machine dl up already set up as a server: the server path too.
    const state = mkdtempSync(join(tmpdir(), "dl-state-"));
    writeFileSync(join(state, "state.json"), "{}");
    const serverUser = laptopInstall({ os: "Linux", env: { DL_SERVER_STATE: join(state, "state.json") } });
    try {
      assert.match(serverUser.sudo ?? "", /^sudo -E npm install -g/m);
    } finally {
      rmSync(serverUser.dir, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
    }
  });
});
