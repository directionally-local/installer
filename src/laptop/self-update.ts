import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { updateCommand } from "../install-method.js";
import { palette } from "../ui.js";
import { compareSemver, dlVersion, pinnedAutopilotVersion } from "../versions.js";
import { bundledAutopilotVersion } from "./autopilot.js";
import type { UpdateIO } from "./update.js";

/**
 * `dl update` with no place named: dl itself first, then the Autopilot it pins.
 *
 * It asks npm for the newest dl. When there is one, it runs the installer for how this dl was
 * installed (updateCommand() is the same choice, as a line to copy), without asking, and then
 * hands over to the new dl, which checks its own pinned Autopilot and updates the default
 * place. When dl is current it does that check here: a missing or different bundled Autopilot
 * means dl is reinstalled at its own version, which brings the pinned one back.
 *
 * Every "update dl" hint says DL_UPDATE, so there's one command to remember.
 */

/** What every "update dl" hint says, and what Autopilot is told dl's update command is. */
export const DL_UPDATE = "dl update";

/** Set for the new dl after an update, so it goes straight to the Autopilot and the place. */
export const SELF_DONE_ENV = "DL_UPDATE_SELF_DONE";

/** The install script, when the command doesn't say (remote-install.ts has the same; not imported, as it imports this). */
const INSTALL_URL = "https://dl.new/install.sh";
const REGISTRY_LATEST = "https://registry.npmjs.org/directionallylocal/latest";
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** How many of the installer's last lines a failure shows. */
const TAIL = 15;

/** npm's `latest` dl. Throws with what went wrong: the registry error is part of the message. */
export async function latestDlVersion(fetcher: typeof fetch = fetch, timeoutMs = 5_000): Promise<string> {
  let response: Response;
  try {
    response = await fetcher(REGISTRY_LATEST, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    throw new Error(name === "TimeoutError" || name === "AbortError" ? `npm didn't answer in ${Math.round(timeoutMs / 1000)} s` : `couldn't reach npm (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!response.ok) throw new Error(`npm answered ${response.status}`);
  let version: unknown;
  try {
    version = ((await response.json()) as { version?: unknown }).version;
  } catch {
    throw new Error("npm's answer wasn't JSON");
  }
  if (typeof version !== "string" || !EXACT_VERSION.test(version)) throw new Error("npm's answer had no version");
  return version;
}

/** One installer run: a command, its arguments and environment, and the script for its stdin. */
export interface InstallerRun {
  command: string;
  args: string[];
  /** Added to dl's own environment. */
  env: Record<string, string>;
  /** Fetch the install script and pipe it to the command's stdin. */
  script: boolean;
  /** Where the install script is. */
  url?: string;
  /** What the person would type, for the failure message. */
  display: string;
}

/** The install script's home from dl's package directory: DL_HOME/dl/lib/node_modules/directionallylocal. */
export function scriptHome(packageRoot: string): string | undefined {
  return packageRoot.match(/^(.*)\/dl\/lib\/node_modules\/directionallylocal\/?$/)?.[1];
}

/**
 * The installer that puts `version` in place, from updateCommand() (the line every hint used
 * to print, chosen by install method), so `dl update` runs what the person would have typed:
 *   `npm install -g directionallylocal`  npm, at that exact version
 *   `curl … | sh`        the install script as this user (root too), into this dl's own DL_HOME, without
 *                        starting dl afterwards or touching the shell's startup file
 *   `curl … | sudo sh`   the install script as root (through sudo unless already root, with
 *                        the environment on sudo's command line, as sudo drops it). On a server
 *                        it runs `dl up`, which installs the server's pinned Autopilot and Hotcell.
 * DL_VERSION pins the script to `version` either way.
 */
export function installerFor(command: string, version: string, facts: { uid: number | undefined; packageRoot: string }): InstallerRun {
  if (/^npm (install|i) -g directionallylocal(@\S*)?$/.test(command.trim())) {
    const spec = `directionallylocal@${version}`;
    return { command: "npm", args: ["install", "-g", "--no-audit", "--no-fund", spec], env: {}, script: false, display: `npm install -g ${spec}` };
  }
  const piped = command.trim().match(/^curl -fsSL (\S+) \| (sudo )?sh$/);
  if (!piped) throw new Error(`don't know how to run "${command}"`);
  const url = piped[1]!;
  if (piped[2]) {
    const env = { DL_VERSION: version };
    if (facts.uid === 0) return { command: "sh", args: ["-s"], env, script: true, url, display: `curl -fsSL ${url} | DL_VERSION=${version} sh` };
    return {
      command: "sudo",
      args: ["env", ...Object.entries(env).map(([key, value]) => `${key}=${value}`), "sh", "-s"],
      env: {},
      script: true,
      url,
      display: `curl -fsSL ${url} | sudo DL_VERSION=${version} sh`,
    };
  }
  const home = scriptHome(facts.packageRoot);
  // DL_MODE=laptop: it's this copy in DL_HOME that's updated, even on a machine dl up also set up.
  const env: Record<string, string> = {
    DL_MODE: "laptop",
    DL_VERSION: version,
    DL_NO_START: "1",
    DL_NO_MODIFY_PATH: "1",
    ...(home ? { DL_HOME: home } : {}),
  };
  return { command: "sh", args: ["-s"], env, script: true, url, display: `curl -fsSL ${url} | DL_VERSION=${version} sh` };
}

async function fetchInstallScript(url = INSTALL_URL): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const text = await response.text();
  if (!text.startsWith("#!")) throw new Error(`${url} didn't send the install script`);
  return text;
}

/** Runs an installer, each line of its output to `line`; resolves with its exit code. */
export type InstallerRunner = (run: InstallerRun & { input?: string }, line: (text: string) => void) => Promise<number>;

const realRunner: InstallerRunner = (run, line) =>
  new Promise((resolve) => {
    const child = spawn(run.command, run.args, {
      env: { ...process.env, ...run.env },
      // The script comes on stdin; a prompt (sudo's password, dl up on a server) uses the terminal.
      stdio: [run.input === undefined ? "inherit" : "pipe", "pipe", "pipe"],
    });
    for (const stream of [child.stdout!, child.stderr!]) {
      let rest = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        const lines = (rest + chunk).split(/\r?\n/);
        rest = lines.pop() ?? "";
        for (const text of lines) line(text);
      });
      stream.on("end", () => { if (rest) line(rest); });
    }
    if (run.input !== undefined) {
      child.stdin!.on("error", () => {});
      child.stdin!.end(run.input);
    }
    child.on("error", (error) => {
      line(`${run.command}: ${error.message}`);
      resolve(127);
    });
    child.on("close", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });

/** Runs the new dl (`dl update` again, told dl is done), with the terminal; resolves with its exit code. */
const realRerun = (args: string[], packageRoot: string): Promise<number> => {
  const home = scriptHome(packageRoot);
  const wrapper = home ? join(home, "bin", "dl") : undefined;
  const [command, prefix] = wrapper && existsSync(wrapper) ? [wrapper, []] : [process.execPath, [process.argv[1] ?? join(packageRoot, "bin", "directionallylocal.mjs")]];
  return new Promise((resolve) => {
    const child = spawn(command, [...prefix, "update", ...args], { stdio: "inherit", env: { ...process.env, [SELF_DONE_ENV]: "1" } });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
};

/** Where `dl update` with no NAME goes after dl: the default place, nothing, or why not. */
export type DefaultPlace =
  | { kind: "none" }
  | { kind: "place"; name: string; updatable: boolean }
  | { kind: "unclear"; message: string };

export interface DlUpdateDeps {
  io: UpdateIO;
  /** `--check`: only say whether there's a newer dl. */
  check?: boolean;
  /** `--wait`, passed on to the place's update. */
  wait?: boolean;
  /** This run is the new dl, after an update: dl is done. Defaults to DL_UPDATE_SELF_DONE. */
  selfDone?: boolean;
  /** The command that updates this dl, as a hint would print it; updateCommand() by default. */
  command?: string;
  current?: string;
  uid?: number | undefined;
  packageRoot?: string;
  latest?: () => Promise<string>;
  fetchScript?: (url: string) => Promise<string>;
  runInstaller?: InstallerRunner;
  /** Runs the new dl's `dl update` (with these arguments) once dl is updated. */
  rerun?: (args: string[]) => Promise<number>;
  /** The installed dl's version and pinned Autopilot, read from disk after an update. */
  installedPins?: () => { version: string; autopilot: string | undefined } | undefined;
  /** The Autopilot this dl bundles, and the one it pins. */
  bundledAutopilot?: () => string | undefined;
  pinnedAutopilot?: () => string;
  /** The place `dl update` with no NAME updates, and updating it (today's `dl update [NAME]`). */
  defaultPlace?: () => Promise<DefaultPlace>;
  updatePlace?: (args: string[]) => Promise<number>;
}

/** `dl update [--check] [--wait]` with no NAME: dl, then its pinned Autopilot, then the default place. */
export async function dlUpdate(deps: DlUpdateDeps): Promise<number> {
  const c = palette(deps.io.color === true);
  const current = deps.current ?? dlVersion();
  const selfDone = deps.selfDone ?? process.env[SELF_DONE_ENV] === "1";
  let checkFailed = false;

  if (!selfDone) {
    let latest: string | undefined;
    try {
      latest = await (deps.latest ?? (() => latestDlVersion()))();
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      if (deps.check) {
        deps.io.err(`  ${c.red("✗")} Couldn't check for a newer dl: ${why}.\n`);
        return 1;
      }
      deps.io.err(`  ${c.yellow("!")} Couldn't check for a newer dl: ${why}. Checking this one's Autopilot.\n`);
      checkFailed = true;
    }
    if (latest !== undefined) {
      const newer = compareSemver(current, latest) < 0;
      if (deps.check) {
        deps.io.out(newer ? `  dl ${latest} is out (this is ${current}). Update: ${c.bold(DL_UPDATE)}\n` : `  dl ${current} is up to date.\n`);
        return 0;
      }
      if (!newer) {
        deps.io.out(`  dl ${current} is up to date.\n`);
      } else {
        deps.io.out(`  ${c.bold(`Updating dl ${current} → ${latest}`)}\n`);
        const code = await install(latest, deps, c);
        if (code !== 0) return code;
        deps.io.out(`  ${c.green("✓")} dl ${latest} is installed.\n`);
        // A place to update: the new dl does that, with its own code and pins. Otherwise the
        // new dl's pinned Autopilot is checked here, from its package.json on disk, so this
        // doesn't depend on what the new dl's own `dl update` does.
        const place = await (deps.defaultPlace ?? noPlace)();
        if (place.kind === "place" && place.updatable) {
          const packageRoot = deps.packageRoot ?? defaultPackageRoot();
          return (deps.rerun ?? ((args) => realRerun(args, packageRoot)))(deps.wait ? ["--wait"] : []);
        }
        const installed = (deps.installedPins ?? (() => installedPins(deps.packageRoot ?? defaultPackageRoot())))();
        return afterDl(installed?.version ?? latest, installed?.autopilot, false, place, deps, c);
      }
    }
  }

  const place = await (deps.defaultPlace ?? noPlace)();
  const code = await afterDl(current, (deps.pinnedAutopilot ?? pinnedAutopilotVersion)(), !selfDone, place, deps, c);
  return code !== 0 ? code : checkFailed ? 1 : 0;
}

const noPlace = async (): Promise<DefaultPlace> => ({ kind: "none" });

/** dl's version and pinned Autopilot, read from its package.json now (after an update, the new one's). */
function installedPins(packageRoot: string): { version: string; autopilot: string | undefined } | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version?: unknown; dependencies?: Record<string, unknown> };
    if (typeof pkg.version !== "string") return undefined;
    const pin = pkg.dependencies?.["autopilot-ai"];
    return { version: pkg.version, autopilot: typeof pin === "string" ? pin : undefined };
  } catch {
    return undefined;
  }
}

/**
 * The Autopilot dl pins (which plain `dl` runs) is the one installed, reinstalling dl at its
 * own version when it isn't and that's allowed; then the default place, as `dl update` always did.
 */
async function afterDl(
  current: string,
  pinned: string | undefined,
  reinstall: boolean,
  place: DefaultPlace,
  deps: DlUpdateDeps,
  c: ReturnType<typeof palette>,
): Promise<number> {
  const bundledNow = deps.bundledAutopilot ?? (() => bundledAutopilotVersion());
  const bundled = bundledNow();
  if (pinned === undefined) {
    if (bundled) deps.io.out(`  ${c.green("✓")} Autopilot ${bundled} is installed.\n`);
  } else if (bundled === pinned) {
    deps.io.out(`  ${c.green("✓")} Autopilot ${pinned} is installed ${c.dim(`(the one dl ${current} pins)`)}.\n`);
  } else if (!reinstall) {
    deps.io.err(`  ${c.red("✗")} dl ${current} pins Autopilot ${pinned}, but ${bundled ? `${bundled} is installed` : "it isn't installed"}.\n`);
    return 1;
  } else {
    deps.io.out(`  ${c.yellow("!")} dl ${current} pins Autopilot ${pinned}, but ${bundled ? `${bundled} is installed` : "it isn't installed"}. Reinstalling dl ${current}.\n`);
    const code = await install(current, deps, c);
    if (code !== 0) return code;
    const after = bundledNow();
    if (after !== pinned) {
      deps.io.err(`  ${c.red("✗")} Reinstalled dl ${current}, and Autopilot ${pinned} still isn't there${after ? ` (found ${after})` : ""}.\n`);
      return 1;
    }
    deps.io.out(`  ${c.green("✓")} Autopilot ${pinned} is installed.\n`);
  }

  if (place.kind === "unclear") {
    deps.io.out(`  ${c.dim(`${place.message.replace(/\.?$/, ".")} To update one: dl update NAME`)}\n`);
  } else if (place.kind === "place" && !place.updatable) {
    deps.io.out(`  ${c.dim(`${place.name} wasn't set up by this laptop; on that server: sudo dl up`)}\n`);
  } else if (place.kind === "place" && deps.updatePlace) {
    return deps.updatePlace(deps.wait ? [place.name, "--wait"] : [place.name]);
  }
  return 0;
}

/** Runs the installer for `version`, streaming its lines; on failure, says so with its last lines. */
async function install(version: string, deps: DlUpdateDeps, c: ReturnType<typeof palette>): Promise<number> {
  const command = deps.command ?? updateCommand();
  let run: InstallerRun;
  try {
    run = installerFor(command, version, { uid: "uid" in deps ? deps.uid : process.getuid?.(), packageRoot: deps.packageRoot ?? defaultPackageRoot() });
  } catch (error) {
    deps.io.err(`  ${c.red("✗")} Can't update dl here: ${error instanceof Error ? error.message : String(error)}.\n`);
    return 1;
  }
  let input: string | undefined;
  if (run.script) {
    try {
      input = await (deps.fetchScript ?? fetchInstallScript)(run.url ?? INSTALL_URL);
    } catch (error) {
      deps.io.err(`  ${c.red("✗")} Couldn't get the install script: ${error instanceof Error ? error.message : String(error)}.\n    By hand: ${run.display}\n`);
      return 1;
    }
  }
  const tail: string[] = [];
  const code = await (deps.runInstaller ?? realRunner)({ ...run, ...(input === undefined ? {} : { input }) }, (text) => {
    if (!text.trim()) return;
    tail.push(text);
    if (tail.length > TAIL) tail.shift();
    deps.io.out(`    ${c.dim(text)}\n`);
  });
  if (code !== 0) {
    deps.io.err(`\n  ${c.red("✗")} Updating dl to ${version} failed (${run.command} exited with ${code}). Its last lines:\n`);
    for (const text of tail) deps.io.err(`    ${text}\n`);
    deps.io.err(`  By hand: ${run.display}\n\n`);
    return code;
  }
  return 0;
}

function defaultPackageRoot(): string {
  return dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
}
