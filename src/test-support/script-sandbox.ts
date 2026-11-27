import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * A throwaway root for running install.sh (or any shell script) with nothing outside it in reach.
 *
 * Tests run as root on dl's own servers, so a stub that writes to a path built from an empty
 * variable (`$prefix/lib/...` with no prefix is `/lib/...`, which is /usr/lib on Ubuntu) or a
 * real command that falls through PATH (`directionallylocal up`, apt-get) changes the machine.
 * Here:
 * - PATH holds only directories inside the root: `stubs` (the test's fakes) and `tools`, which
 *   links a fixed list of harmless utilities (sh, sed, tar…) and has a refusing stub for every
 *   command that could change the machine (npm, apt-get, systemctl, sudo, dl…) that a test
 *   doesn't fake itself. /usr/bin and /bin are never on PATH.
 * - HOME, XDG_*, TMPDIR, PREFIX, npm_config_prefix and npm_config_cache point inside the root.
 * - `assertConfined` runs before every script: each of those variables, DL_HOME (or the
 *   default it falls back to, $HOME/.directionallylocal), every PATH entry and the working
 *   directory must resolve inside the root, or the test throws before anything runs.
 */
export interface ScriptSandbox {
  /** The temp root (realpath, so /var and /private/var on macOS don't disagree). */
  root: string;
  /** The test's fakes, first on PATH. */
  stubs: string;
  /** Linked utilities and refusing stubs, second on PATH. */
  tools: string;
  home: string;
  /** Writes an executable `#!/bin/sh` stub (into `stubs` unless `where` says otherwise). */
  stub(name: string, body: string, where?: string): void;
  /** The environment every script here starts from; extend it, then pass it through assertConfined. */
  env: Record<string, string>;
  /** Commands the refusing stubs turned away, one a line (empty when none). */
  refused(): string;
}

/** Harmless utilities install.sh and the stubs use, linked from the real system when present. */
const TOOLS = [
  "sh", "dash", "awk", "basename", "cat", "chmod", "cp", "cut", "date", "dirname", "echo", "env", "expr", "false",
  "find", "getconf", "grep", "gzip", "head", "kill", "ln", "ls", "mkdir", "mktemp", "mv", "od", "printf", "pwd",
  "readlink", "rm", "rmdir", "sed", "sha256sum", "shasum", "sleep", "sort", "stat", "tail", "tar", "tee", "test",
  "touch", "tr", "true", "uniq", "wc", "which", "xz", "[",
];

/** Commands that could change the machine: refused unless the test fakes them in `stubs`. */
const REFUSED = [
  "npm", "npx", "node", "curl", "wget", "sudo", "su", "doas", "dl", "directionallylocal", "autopilot", "hotcell",
  "apt", "apt-get", "dpkg", "snap", "systemctl", "service", "docker", "tailscale", "bash", "reboot", "shutdown",
  "useradd", "usermod", "chown", "install", "id", "uname",
];

/** The variables a script may write under: each must point inside the sandbox's root. */
export const WRITE_VARS = [
  "HOME", "DL_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "TMPDIR", "PREFIX",
  "npm_config_prefix", "npm_config_cache", "ZDOTDIR",
] as const;

export function createScriptSandbox(prefix: string): ScriptSandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const stubs = join(root, "stubs");
  const tools = join(root, "tools");
  const home = join(root, "home");
  for (const path of [stubs, tools, home, join(root, "tmp"), join(root, "npm-global"), join(root, "prefix")]) mkdirSync(path, { recursive: true });
  const stub = (name: string, body: string, where = stubs) => {
    const file = join(where, name);
    assertInside(root, file, `stub ${name}`);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  };
  for (const name of TOOLS) {
    const real = ["/usr/bin", "/bin"].map((dir) => join(dir, name)).find((path) => existsSync(path));
    if (real) symlinkSync(real, join(tools, name));
  }
  const refusedLog = join(root, "refused.log");
  for (const name of REFUSED) {
    stub(name, `echo "${name} $*" >> "${refusedLog}"; echo "test sandbox: refusing to run the real ${name}; fake it in the test's stubs" >&2; exit 1`, tools);
  }
  const env: Record<string, string> = {
    PATH: `${stubs}${delimiter}${tools}`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    TMPDIR: join(root, "tmp"),
    PREFIX: join(root, "prefix"),
    npm_config_prefix: join(root, "npm-global"),
    npm_config_cache: join(root, "npm-cache"),
  };
  return { root, stubs, tools, home, stub, env, refused: () => (existsSync(refusedLog) ? readFileSync(refusedLog, "utf8") : "") };
}

/** Throws unless `path` is absolute and is `root` itself or below it. */
export function assertInside(root: string, path: string, what: string): void {
  if (!path) throw new Error(`test sandbox: ${what} is empty; it would resolve outside ${root}`);
  if (!isAbsolute(path)) throw new Error(`test sandbox: ${what} (${path}) isn't absolute; it would resolve against wherever the script is`);
  // Its deepest part that exists, with symlinks resolved: a link inside the root to / is outside.
  let existing = resolve(path);
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  for (const candidate of [resolve(path), realpathSync(existing)]) {
    const rel = relative(root, candidate);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`test sandbox: ${what} (${path}) is outside the test's temp root ${root}`);
  }
}

/**
 * Before a script runs: every place it may write (WRITE_VARS, DL_HOME or its default), every
 * PATH entry and its working directory resolve inside `root`. Read-only inputs (DL_TTY,
 * DL_SERVER_STATE, DL_PACKAGE) aren't checked.
 */
export function assertConfined(root: string, env: Record<string, string | undefined>, cwd?: string): void {
  if (!env.HOME) throw new Error("test sandbox: HOME isn't set; a script would fall back to a real home");
  for (const name of WRITE_VARS) {
    const value = env[name];
    if (value !== undefined) assertInside(root, value, name);
  }
  assertInside(root, env.DL_HOME || join(env.HOME, ".directionallylocal"), "DL_HOME (or its default under HOME)");
  if (!env.PATH) throw new Error("test sandbox: PATH isn't set");
  for (const entry of env.PATH.split(delimiter)) assertInside(root, entry, `PATH entry`);
  if (cwd !== undefined) assertInside(root, cwd, "the working directory");
}

/**
 * A fake npm that installs dl's entry point under its prefix (--prefix, else npm_config_prefix,
 * as npm itself does) and refuses, exit 1, when that prefix is empty or outside `root`.
 * `before` runs first (logging its arguments, extra output); `after` runs once the prefix is checked.
 */
export function fakeNpm(root: string, options: { before?: string; after?: string } = {}): string {
  return `${options.before ?? ""}
prefix="\${npm_config_prefix:-}"; while [ $# -gt 0 ]; do [ "$1" = --prefix ] && prefix=$2; shift; done
case "$prefix" in
  *..*) echo "fake npm: refusing prefix '$prefix' (has ..)" >&2; exit 1 ;;
  "${root}"/*) ;;
  *) echo "fake npm: refusing prefix '$prefix': empty or outside the test's temp root ${root}" >&2; exit 1 ;;
esac
mkdir -p "$prefix/lib/node_modules/directionallylocal/bin" && echo '// dl' > "$prefix/lib/node_modules/directionallylocal/bin/directionallylocal.mjs"
${options.after ?? ""}`;
}
