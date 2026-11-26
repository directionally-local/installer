import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { palette } from "../ui.js";
import { pinnedAutopilotVersion } from "../versions.js";
import { autopilotHome, downloadedAutopilotPackage, findAutopilot, type AutopilotCommand } from "./autopilot.js";

/**
 * Autopilot is optional: dl doesn't install it with itself. It's downloaded the first time it's
 * picked (the router's "Autopilot — dl's own agent" row, "Install Autopilot", `dl autopilot`, or
 * anything else that runs it: dl -c on Autopilot, dl zed/acp, a server session), with npm, into
 * <dl's home>/autopilot (an `npm install -g --prefix` there, the same layout the install script
 * gives dl itself), at exactly the version this dl pins. `dl update` keeps it on that pin.
 *
 * Like the install script, npm runs with --ignore-scripts (no dependency's install script
 * runs), and then only isolated-vm's own build when its prebuilt binary doesn't load here; when
 * that fails Autopilot still works (it calls tools directly instead of through Code Mode).
 */

type Env = NodeJS.ProcessEnv;

export interface InstallIO {
  out: (text: string) => void;
  err: (text: string) => void;
  color?: boolean;
}

export interface EnsureAutopilotDeps {
  env?: Env;
  /** Finds an installed Autopilot; findAutopilot unless replaced. */
  find?: () => Promise<AutopilotCommand | undefined>;
  /** Installs `spec` into `prefix`; npm unless replaced. Resolves to an error message, or undefined when it worked. */
  install?: (spec: string, prefix: string, env: Env) => Promise<string | undefined>;
  /** The version to install; the pinned one unless replaced. */
  version?: string;
}

/** What npm installs: DL_AUTOPILOT_SPEC (a test build) or autopilot-ai@<pin>. */
export function autopilotSpec(env: Env, version: string): string {
  return env.DL_AUTOPILOT_SPEC?.trim() || `autopilot-ai@${version}`;
}

/** The Autopilot to run: the installed one, or (downloaded now, once) the pinned one. Undefined when that failed (already said). */
export async function ensureAutopilot(io: InstallIO, deps: EnsureAutopilotDeps = {}): Promise<AutopilotCommand | undefined> {
  const env = deps.env ?? process.env;
  const find = deps.find ?? (() => findAutopilot(env));
  const found = await find();
  if (found) return found;
  const c = palette(io.color === true);
  const version = deps.version ?? pinnedAutopilotVersion();
  const prefix = autopilotHome(env);
  io.err(`  ${c.dim("·")} Downloading Autopilot ${version} ${c.dim("(one time; it's dl's own agent)")}\n`);
  const started = Date.now();
  const failure = await (deps.install ?? npmInstall)(autopilotSpec(env, version), prefix, env);
  if (failure) {
    io.err(`  ${c.red("✗")} Couldn't download Autopilot: ${failure}\n    Try again with ${c.bold("dl autopilot")}.\n`);
    return undefined;
  }
  const installed = await find();
  if (!installed) {
    io.err(`  ${c.red("✗")} Autopilot downloaded, but dl can't find it in ${prefix}. Try again with ${c.bold("dl autopilot")}.\n`);
    return undefined;
  }
  io.err(`  ${c.green("✓")} Autopilot ${version} is ready ${c.dim(`· ${Math.max(1, Math.round((Date.now() - started) / 1000))}s`)}\n`);
  return installed;
}

/** npm next to this Node (the install script's own Node ships one), else npm on PATH. */
function npmCommand(): string {
  const beside = join(dirname(process.execPath), "npm");
  return existsSync(beside) ? beside : "npm";
}

function run(command: string, args: string[], options: { env: Env; cwd?: string; log: string }): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: options.env, ...(options.cwd ? { cwd: options.cwd } : {}), stdio: ["ignore", "pipe", "pipe"] });
    const write = (chunk: Buffer) => void appendFile(options.log, chunk).catch(() => undefined);
    child.stdout?.on("data", write);
    child.stderr?.on("data", write);
    child.on("error", (error) => {
      void appendFile(options.log, `${error.message}\n`).catch(() => undefined);
      resolve(127);
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/** `npm install -g --prefix PREFIX SPEC`, with its output in PREFIX/install.log; then isolated-vm's build when needed. */
export async function npmInstall(spec: string, prefix: string, parent: Env): Promise<string | undefined> {
  await mkdir(prefix, { recursive: true, mode: 0o700 });
  const log = join(prefix, "install.log");
  await rm(log, { force: true });
  const cache = join(prefix, "npm-cache");
  // This Node first on PATH, so npm (and node-gyp) run on the Node that runs dl.
  const env = { ...parent, PATH: `${dirname(process.execPath)}${delimiter}${parent.PATH ?? ""}`, npm_config_devdir: join(cache, "node-gyp") };
  const npm = npmCommand();
  const code = await run(npm, ["install", "-g", "--prefix", prefix, "--cache", cache, "--no-audit", "--no-fund", "--no-update-notifier", "--ignore-scripts", spec], { env, log });
  if (code !== 0) {
    await rm(cache, { recursive: true, force: true });
    const tail = (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).slice(-1)[0];
    return `npm exited with ${code}${tail ? ` (${tail.slice(0, 200)})` : ""}. Its log: ${log}`;
  }
  // isolated-vm (Code Mode's sandbox) loads a prebuilt binary on most computers; elsewhere it's built here.
  const ivm = join(downloadedAutopilotPackage(env), "node_modules", "isolated-vm");
  if (existsSync(ivm)) {
    const loads = (await run(process.execPath, ["-e", "require(process.argv[1])", ivm], { env, log })) === 0;
    if (!loads) await run(npm, ["run", "install", "--cache", cache, "--no-update-notifier", "--foreground-scripts"], { env, cwd: ivm, log });
  }
  await rm(cache, { recursive: true, force: true });
  return undefined;
}
