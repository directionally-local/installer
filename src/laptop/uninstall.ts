/**
 * `dl uninstall` on a computer that isn't a dl server (a laptop, or any machine without
 * /etc/directionallylocal/state.json, root included): takes out what the install script and dl
 * put there, and nothing else.
 *
 *   - signs out of the free tier on the service (POST /v1/token/revoke, as Autopilot's /logout
 *     does; best effort, never blocks) and drops the now-dead tokens from Autopilot's config
 *   - stops agents running on this computer (`dl local`), when they were set up
 *   - dl's hook in Claude Code's settings, when `dl claude-code hook install` added it
 *   - the lines the install script added to shell startup files (each edited file keeps a backup)
 *   - links to dl in ~/.local/bin and ~/bin, only those that point into DL_HOME
 *   - ~/.config/directionallylocal (dl's own settings)
 *   - DL_HOME (~/.directionallylocal): dl, its Node.js and Autopilot. Last, as dl runs from it
 *   - --purge: Autopilot's own settings, sign-ins, sessions and history (its config, data and
 *     state directories). Projects' .autopilot folders are never touched.
 */
import { spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { copyFile, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { installMethod, packageRoot, scriptHomeOf, SCRIPT_MARKER } from "../install-method.js";
import { uninstallFromThisComputer } from "../local/setup.js";
import { palette, PlainUi } from "../ui.js";
import { removeHookQuietly } from "./claude-code-hook.js";
import { autopilotConfigFile, FREE_TIER_DEFAULT_URL, FREE_TIER_PROVIDER } from "./free-tier.js";

type Env = Record<string, string | undefined>;

/** The two lines (after a blank one) the install script appends to a shell startup file. */
export const RC_MARKER = "# Directionally Local (dl)";
const REVOKE_TIMEOUT_MS = 5_000;
const LINK_NAMES = ["dl", "directionallylocal"] as const;

export interface LaptopUninstallOptions {
  purge?: boolean;
  /** --yes: don't ask. */
  yes?: boolean;
  io: { out: (text: string) => void; err: (text: string) => void; color?: boolean };
  /** Asks the question; absent when there's no terminal to ask on. */
  confirm?: (question: string) => Promise<boolean>;
  env?: Env;
  home?: string;
  platform?: NodeJS.Platform;
  /** Where this dl's package is; decides DL_HOME when the environment doesn't. */
  packageRoot?: string;
  /** "npm" when dl came from `npm install -g`: that copy is npm's to remove. */
  installedWithNpm?: boolean;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Stops and removes agents on this computer (`dl local uninstall --purge`); the real one unless replaced. */
  stopLocalAgents?: () => Promise<void>;
  now?: () => Date;
}

/** Everything a laptop uninstall would touch, worked out before anything changes. */
export interface LaptopUninstallPlan {
  dlHome: string;
  /** False when DL_HOME doesn't look like the install script's (then it's kept). */
  dlHomeIsOurs: boolean;
  links: string[];
  /** Shell startup files that have the install script's lines. */
  rcFiles: string[];
  dlConfig: string;
  autopilotConfig: string;
  /** --purge: Autopilot's directories (and the pre-rename kimiflare ones) that exist. */
  autopilotDirs: string[];
  /** Agents on this computer were set up (`dl local`). */
  localAgents: boolean;
  claudeSettings: string;
}

export function dlHomeFor(env: Env, home: string, root: string): string {
  return env.DL_HOME?.trim() || scriptHomeOf(root) || join(home, ".directionallylocal");
}

/** The install script's startup file per shell, as in its shell_rc(), for every shell. */
export function rcCandidates(env: Env, home: string): string[] {
  const zdot = env.ZDOTDIR?.trim();
  return [...new Set([
    join(zdot || home, ".zshrc"),
    join(home, ".zshrc"),
    join(home, ".bashrc"),
    join(home, ".bash_profile"),
    join(home, ".profile"),
    join(home, ".config", "fish", "conf.d", "directionallylocal.fish"),
  ])];
}

function configHome(env: Env, home: string): string {
  return env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
}

/** Autopilot's config, data and state directories (app-dirs.ts in Autopilot), new names then old. */
export function autopilotDirs(env: Env, home: string): string[] {
  const data = env.XDG_DATA_HOME?.trim() || join(home, ".local", "share");
  const state = env.XDG_STATE_HOME?.trim() || join(home, ".local", "state");
  const dirs: string[] = [];
  for (const name of ["autopilot", "kimiflare"]) dirs.push(join(configHome(env, home), name), join(data, name), join(state, name));
  dirs.push(join(home, ".kimiflare"));
  return dirs;
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Inside `dir` (or `dir` itself), compared as absolute paths. */
function within(path: string, dir: string): boolean {
  const p = resolve(path);
  const d = resolve(dir);
  return p === d || p.startsWith(d.endsWith(sep) ? d : d + sep);
}

/**
 * DL_HOME is deleted whole, so only when it's the default folder or one the install script
 * wrote dl into, and never the home directory, / or anything above home.
 */
function dlHomeIsOurs(dlHome: string, home: string): boolean {
  const target = resolve(dlHome);
  if (target === sep || within(home, target)) return false;
  if (target === resolve(home, ".directionallylocal")) return true;
  try {
    return readFileSync(join(target, "bin", "dl"), "utf8").includes(SCRIPT_MARKER);
  } catch {
    return false;
  }
}

/** The PATH lines the install script writes for this DL_HOME. */
function pathLines(dlHome: string): string[] {
  const bin = `${dlHome}/bin`;
  return [`export PATH="${bin}:$PATH"`, `set -gx PATH "${bin}" $PATH`];
}

/**
 * The text without the install script's lines: the marker comment and the PATH line right
 * after it (for this DL_HOME), and the blank line the script put before them. Anything else,
 * even a similar line the person wrote, stays. Undefined when there was nothing to take out.
 */
export function withoutRcLines(text: string, dlHome: string): string | undefined {
  const lines = text.split("\n");
  const wanted = pathLines(dlHome);
  const kept: string[] = [];
  let removed = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === RC_MARKER && wanted.includes(lines[i + 1] ?? "")) {
      if (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
      i++;
      removed = true;
      continue;
    }
    kept.push(lines[i]!);
  }
  return removed ? kept.join("\n") : undefined;
}

export function laptopUninstallPlan(options: Pick<LaptopUninstallOptions, "env" | "home" | "platform" | "packageRoot"> = {}): LaptopUninstallPlan {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? homedir();
  const dlHome = dlHomeFor(env, home, options.packageRoot ?? packageRoot());
  const links: string[] = [];
  for (const dir of [join(home, ".local", "bin"), join(home, "bin")]) {
    for (const name of LINK_NAMES) {
      const link = join(dir, name);
      try {
        if (!lstatSync(link).isSymbolicLink()) continue;
        if (within(resolve(dir, readlinkSync(link)), dlHome)) links.push(link);
      } catch {
        // not there
      }
    }
  }
  const rcFiles = rcCandidates(env, home).filter((file) => {
    try {
      return withoutRcLines(readFileSync(file, "utf8"), dlHome) !== undefined;
    } catch {
      return false;
    }
  });
  const platform = options.platform ?? process.platform;
  const claudeDir = env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
  return {
    dlHome,
    dlHomeIsOurs: dlHomeIsOurs(dlHome, home),
    links,
    rcFiles,
    dlConfig: join(configHome(env, home), "directionallylocal"),
    autopilotConfig: autopilotConfigFile(env, existsSync),
    autopilotDirs: autopilotDirs(env, home).filter(exists),
    localAgents: (platform === "darwin" || platform === "linux") && exists(join(home, ".directionallylocal", "state.json")),
    claudeSettings: join(claudeDir, "settings.json"),
  };
}

type RevokeResult = "revoked" | "unsupported" | "unreachable" | "nothing";

/**
 * Signs out of the free tier the way Autopilot's /logout does: POST /v1/token/revoke with the
 * refresh token (and the access token as the bearer), 5 s at most. Then the tokens, dead now,
 * come out of Autopilot's config, keeping everything else there. Never throws.
 */
export async function signOutOfFreeTier(file: string, env: Env, fetchImpl: LaptopUninstallOptions["fetch"]): Promise<RevokeResult> {
  let config: { providers?: Record<string, Record<string, unknown> | undefined> };
  let text: string;
  try {
    text = await readFile(file, "utf8");
    config = JSON.parse(text) as typeof config;
  } catch {
    return "nothing";
  }
  const saved = config.providers?.[FREE_TIER_PROVIDER];
  const accessToken = typeof saved?.apiKey === "string" ? saved.apiKey : undefined;
  const refreshToken = typeof saved?.refreshToken === "string" ? saved.refreshToken : undefined;
  if (!accessToken && !refreshToken) return "nothing";
  const origin = (env.AUTOPILOT_DL_FREE_URL?.trim() || FREE_TIER_DEFAULT_URL).replace(/\/+$/, "").replace(/\/v1$/, "");
  let result: RevokeResult;
  try {
    const response = await (fetchImpl ?? fetch)(`${origin}/v1/token/revoke`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(refreshToken ? { refresh_token: refreshToken } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
    });
    result = response.status === 404 || response.status === 405 ? "unsupported"
      : response.ok || response.status === 400 || response.status === 401 ? "revoked" : "unreachable";
  } catch {
    result = "unreachable";
  }
  try {
    const next = { ...saved };
    for (const key of ["apiKey", "refreshToken", "expiresAt"]) delete next[key];
    config.providers = { ...config.providers, [FREE_TIER_PROVIDER]: next };
    // In place, so the file keeps its permissions (0600) and stays wherever a link points.
    await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
  } catch {
    // The service has ended the session anyway.
  }
  return result;
}

function tilde(path: string, home: string): string {
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Deletes DL_HOME. The running dl lives there, which POSIX allows; if that still fails, a detached rm finishes once dl exits. */
async function removeDlHome(dlHome: string): Promise<boolean> {
  try {
    await rm(dlHome, { recursive: true, force: true });
    if (!exists(dlHome)) return true;
  } catch {
    // below
  }
  try {
    const child = spawn("/bin/sh", ["-c", 'sleep 1; rm -rf -- "$1"', "sh", dlHome], { detached: true, stdio: "ignore", cwd: "/" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function laptopUninstall(options: LaptopUninstallOptions): Promise<number> {
  const { io } = options;
  const c = palette(io.color === true);
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? homedir();
  const plan = laptopUninstallPlan(options);
  const npm = options.installedWithNpm ?? installMethod() === "npm";
  const show = (path: string) => tilde(path, home);

  const targets = [
    ...(plan.dlHomeIsOurs && exists(plan.dlHome) ? [`${show(plan.dlHome)}  ${c.dim("dl, its Node.js and Autopilot")}`] : []),
    ...plan.links.map((link) => `${show(link)}  ${c.dim("link")}`),
    ...plan.rcFiles.map((file) => `the dl PATH lines in ${show(file)}  ${c.dim("backup kept")}`),
    ...(exists(plan.dlConfig) ? [`${show(plan.dlConfig)}  ${c.dim("dl's settings")}`] : []),
    ...(plan.localAgents ? [`agents set up on this computer  ${c.dim("dl local")}`] : []),
    ...(options.purge ? plan.autopilotDirs.map((dir) => `${show(dir)}  ${c.dim("Autopilot's settings, sign-ins and history")}`) : []),
  ];
  io.out(`\n  ${c.bold("dl uninstall")}  ${c.dim("this computer")}\n\n`);
  if (targets.length > 0) io.out(`${targets.map((line) => `  - ${line}`).join("\n")}\n`);
  else io.out(`  ${c.dim("Nothing of dl's left here to remove.")}\n`);
  io.out(`  ${c.dim(options.purge ? "Projects' .autopilot folders stay." : `Also signs out of the free tier. Autopilot's settings and history stay (--purge removes them).`)}\n\n`);

  if (!options.yes) {
    if (!options.confirm) {
      io.err(`  ${c.red("✗")} Nothing was removed: dl uninstall asks first, and there's no terminal to ask on. To go ahead: dl uninstall --yes${options.purge ? " --purge" : ""}\n`);
      return 1;
    }
    if (!(await options.confirm("Remove dl from this computer? [y/N] "))) {
      io.out(`  Nothing was removed.\n`);
      return 1;
    }
  }

  const done: string[] = [];
  const problems: string[] = [];

  // First, while dl's own files are all still there.
  const revoke = await signOutOfFreeTier(plan.autopilotConfig, env, options.fetch);
  if (revoke === "revoked" || revoke === "unsupported") done.push("signed out of the free tier");
  else if (revoke === "unreachable") problems.push("couldn't reach the free tier to sign out; its sign-in stops working on its own within 30 days");

  if (plan.localAgents) {
    try {
      await (options.stopLocalAgents ?? stopLocalAgents(home))();
      done.push("stopped and removed the agents on this computer");
    } catch (error) {
      problems.push(`couldn't remove the agents on this computer (${(error as Error).message}); run dl local uninstall --purge before this, or remove them by hand`);
    }
  }

  const hook = await removeHookQuietly(plan.claudeSettings, (options.now ?? (() => new Date()))()).catch(() => undefined);
  if (hook) done.push(`removed dl's hook from ${show(plan.claudeSettings)} (backup ${show(hook.backup)})`);

  for (const file of plan.rcFiles) {
    try {
      const text = await readFile(file, "utf8");
      const next = withoutRcLines(text, plan.dlHome);
      if (next === undefined) continue;
      if (file.endsWith("/directionallylocal.fish") && next.trim() === "") {
        await unlink(file);
        done.push(`removed ${show(file)}`);
        continue;
      }
      const backup = `${file}.dl-uninstall.bak`;
      await copyFile(file, backup);
      // In place: a startup file that's a link keeps being one.
      await writeFile(file, next);
      done.push(`removed the dl PATH lines from ${show(file)} (backup ${show(backup)})`);
    } catch (error) {
      problems.push(`couldn't edit ${show(file)} (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}); remove the "${RC_MARKER}" line and the PATH line after it yourself`);
    }
  }

  for (const link of plan.links) {
    try {
      await unlink(link);
      done.push(`removed ${show(link)}`);
    } catch (error) {
      problems.push(`couldn't remove ${show(link)} (${(error as NodeJS.ErrnoException).code})`);
    }
  }

  const remove = async (path: string, what: string) => {
    if (!exists(path)) return;
    try {
      await rm(path, { recursive: true, force: true });
      done.push(`removed ${show(path)}${what ? ` (${what})` : ""}`);
    } catch (error) {
      problems.push(`couldn't remove ${show(path)} (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`);
    }
  };
  await remove(plan.dlConfig, "dl's settings");
  if (options.purge) for (const dir of plan.autopilotDirs) await remove(dir, "Autopilot");

  // Last: dl itself runs from here.
  if (exists(plan.dlHome)) {
    if (!plan.dlHomeIsOurs) problems.push(`kept ${show(plan.dlHome)}: it doesn't look like the install script's folder`);
    else if (await removeDlHome(plan.dlHome)) done.push(`removed ${show(plan.dlHome)} (dl, its Node.js and Autopilot)`);
    else problems.push(`couldn't remove ${show(plan.dlHome)}`);
  }

  for (const line of done) io.out(`  ${c.green("✓")} ${line}\n`);
  for (const line of problems) io.out(`  ${c.yellow("!")} ${line}\n`);
  if (npm) io.out(`  ${c.yellow("!")} This dl came from npm; to remove it as well: npm uninstall -g directionallylocal\n`);
  io.out(`\n  ${done.length > 0 ? "dl is removed from this computer." : "Nothing needed removing."}${plan.rcFiles.length > 0 ? " Open a new terminal for the PATH change." : ""}\n\n`);
  return 0;
}

/** `dl local uninstall --purge`, when agents were set up on this computer. */
function stopLocalAgents(home: string): () => Promise<void> {
  return () => uninstallFromThisComputer({ ui: new PlainUi(() => {}), purge: true, home });
}
