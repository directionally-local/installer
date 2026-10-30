import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConnectState, type ConnectResult } from "../provider.js";
import { findAutopilot, type AutopilotCommand } from "./autopilot.js";

/**
 * Autopilot's own provider and model choice, run in this terminal: `autopilot connect
 * --state-file PATH [--model-only]` shows its provider picker, key entry and model picker,
 * configures the user's own `autopilot` (their normal HOME), and writes what was chosen to
 * PATH (0600). dl reads the file from a private temporary directory and deletes it at once;
 * the key then travels only to the place (Hotcell's keystore), never into dl's own config.
 *
 * Exit codes: 0 chosen, 1 cancelled (Esc / Ctrl-C), 2 usage (an Autopilot without `connect`).
 */

/** Runs the command with the terminal attached and resolves with its exit code. */
export type ConnectSpawner = (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<number>;

export interface ConnectDeps {
  /** Finds Autopilot; the one installed with dl, else one on PATH. */
  autopilot?: () => Promise<AutopilotCommand | undefined>;
  spawn?: ConnectSpawner;
  env?: NodeJS.ProcessEnv;
  /** Where the private directory for the state file is made; the OS temp dir otherwise. */
  tmp?: string;
}

/** Autopilot cancelled (exit 1): nothing was chosen, nothing changed. */
export class ConnectCancelled extends Error {
  constructor() {
    super("cancelled in Autopilot");
    this.name = "ConnectCancelled";
  }
}

const UPDATE = "npm install -g directionallylocal";

const realSpawn: ConnectSpawner = (command, args, env) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: "inherit", env });
  child.on("error", reject);
  child.on("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 1 : 1)));
});

/**
 * Provider, key and model from Autopilot's picker. `modelOnly` keeps the configured provider
 * and asks only for the model (`dl model`). Throws ConnectCancelled when the user backs out.
 */
export async function runAutopilotConnect(options: { modelOnly?: boolean } = {}, deps: ConnectDeps = {}): Promise<ConnectResult> {
  const autopilot = await (deps.autopilot ?? findAutopilot)();
  if (!autopilot) throw new Error(`The Autopilot that comes with dl isn't installed. Update: ${UPDATE}`);
  // mkdtemp makes the directory 0700: the file inside is private even before Autopilot sets its mode.
  const dir = await mkdtemp(join(deps.tmp ?? tmpdir(), "dl-connect-"));
  try {
    const stateFile = join(dir, "provider.json");
    const args = [...autopilot.args, "connect", "--state-file", stateFile, ...(options.modelOnly ? ["--model-only"] : [])];
    let code: number;
    try {
      code = await (deps.spawn ?? realSpawn)(autopilot.command, args, { ...(deps.env ?? process.env) });
    } catch (error) {
      throw new Error(`Couldn't start Autopilot: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (code === 1) throw new ConnectCancelled();
    if (code === 2) throw new Error(`The Autopilot that comes with dl is too old to pick a provider (no "connect" command). Update: ${UPDATE}`);
    if (code !== 0) throw new Error(`Autopilot's provider setup exited with ${code}.`);
    const text = await readFile(stateFile, "utf8").catch(() => undefined);
    if (!text) throw new Error("Autopilot finished but wrote no provider; run dl setup again.");
    return parseConnectState(text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
