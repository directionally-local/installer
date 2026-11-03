import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * How this dl was installed, so an update hint names the command that updates this copy:
 *   script  the install script, as yourself, into ~/.directionallylocal (or DL_HOME)
 *   server  a server: Linux as root, or one `dl up` set up (the install script under sudo)
 *   npm     `npm install -g directionallylocal`
 */
export type InstallMethod = "script" | "server" | "npm";

export const SCRIPT_UPDATE = "curl -fsSL https://directionallylocal.run | sh";
export const SERVER_UPDATE = "curl -fsSL https://directionallylocal.run | sudo sh";
export const NPM_UPDATE = "npm install -g directionallylocal";

/** What the install script writes into DL_HOME/bin/dl. */
const SCRIPT_MARKER = "Written by the Directionally Local install script.";
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
  const scriptHome = facts.packageRoot.match(/^(.*)\/dl\/lib\/node_modules\/directionallylocal\/?$/)?.[1];
  if (scriptHome !== undefined) {
    const homes = [facts.env.DL_HOME, facts.home ? join(facts.home, ".directionallylocal") : undefined].filter(Boolean);
    if (homes.includes(scriptHome) || facts.readFile(join(scriptHome, "bin", "dl"))?.includes(SCRIPT_MARKER)) return "script";
  }
  if (facts.platform === "linux" && (facts.uid === 0 || facts.readFile(SERVER_STATE) !== undefined)) return "server";
  return "npm";
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
    packageRoot: dirname(fileURLToPath(new URL("../package.json", import.meta.url))),
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
