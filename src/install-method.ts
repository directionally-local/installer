import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * How this dl was installed, so an update hint names the command that updates this copy:
 *   script  the install script into ~/.directionallylocal (or DL_HOME): as yourself, or as
 *           root on Linux, which gets the same plain install (into /root/.directionallylocal)
 *   server  a Linux machine `dl up` set up (the install script with DL_MODE=server). On it the
 *           plain `| sudo sh` updates the server, as the script sees dl up's state file
 *   npm     `npm install -g directionallylocal`
 */
export type InstallMethod = "script" | "server" | "npm";

export const SCRIPT_UPDATE = "curl -fsSL https://dl.new/install.sh | sh";
export const SERVER_UPDATE = "curl -fsSL https://dl.new/install.sh | sudo sh";
export const NPM_UPDATE = "npm install -g directionallylocal";

/** What the install script writes into DL_HOME/bin/dl. */
export const SCRIPT_MARKER = "Written by the Directionally Local install script.";
const SERVER_STATE = "/etc/directionallylocal/state.json";

export interface InstallFacts {
  /** dl's package directory (the one with package.json). */
  packageRoot: string;
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  uid: number | undefined;
  /** A file's text, or undefined when it can't be read. */
  readFile: (path: string) => string | undefined;
}

export function installMethod(facts: InstallFacts = realFacts()): InstallMethod {
  // The install script puts the package at DL_HOME/dl/lib/node_modules/directionallylocal and
  // writes its own wrapper at DL_HOME/bin/dl. DL_HOME isn't set when dl runs, so a custom one
  // is recognised by that wrapper.
  const scriptHome = scriptHomeOf(facts.packageRoot);
  if (scriptHome !== undefined) {
    const homes = [facts.env.DL_HOME, facts.home ? join(facts.home, ".directionallylocal") : undefined].filter(Boolean);
    if (homes.includes(scriptHome) || facts.readFile(join(scriptHome, "bin", "dl"))?.includes(SCRIPT_MARKER)) return "script";
  }
  // Root alone isn't a server: only a machine dl up set up is.
  if (facts.platform === "linux" && facts.readFile(SERVER_STATE) !== undefined) return "server";
  return "npm";
}

/** The DL_HOME a package root sits in when the install script put it there (DL_HOME/dl/lib/node_modules/directionallylocal). */
export function scriptHomeOf(packageRoot: string): string | undefined {
  return packageRoot.match(/^(.*)\/dl\/lib\/node_modules\/directionallylocal\/?$/)?.[1];
}

/** dl's own package directory (the one with package.json). */
export function packageRoot(): string {
  return dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
}

/** The one command that updates this dl, for every "update dl" hint. */
export function updateCommand(method: InstallMethod = cachedMethod()): string {
  return method === "script" ? SCRIPT_UPDATE : method === "server" ? SERVER_UPDATE : NPM_UPDATE;
}

let cached: InstallMethod | undefined;

function cachedMethod(): InstallMethod {
  cached ??= installMethod();
  return cached;
}

function realFacts(): InstallFacts {
  return {
    packageRoot: packageRoot(),
    env: process.env,
    home: homedir(),
    platform: process.platform,
    uid: process.getuid?.(),
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
  };
}
