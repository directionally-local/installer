import { copyFile, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { autopilotAuth, type AutopilotAuth, type AutopilotCommand } from "./autopilot.js";
import { ensureAutopilot } from "./autopilot-install.js";
import { referralForAutopilot, withReferral } from "./referral.js";
import { DL_UPDATE } from "./self-update.js";
import { dlVersion } from "../versions.js";
import { JsoncError, readMember, removeMember, setMember } from "./jsonc.js";
import type { LaptopIO } from "./commands.js";

/**
 * `dl acp` and `dl zed`: dl's Autopilot as an ACP (Agent Client Protocol) agent in editors.
 *
 * `dl acp [ARGS]` is `autopilot acp [ARGS]` with the Autopilot dl bundles, started the way plain
 * `dl` starts it (AUTOPILOT_LAUNCHED_BY=dl, so its hints name dl's commands). It's the command an
 * editor runs: Zed (`dl zed` writes it into Zed's settings), T3 Code ("Local ACP command"), the
 * ACP registry's npx entry. stdout belongs to the protocol, so dl itself prints only to stderr.
 * It is Autopilot itself, with the person's own Autopilot config and provider: on the free tier
 * its requests are Autopilot's own (the full allowance), not another agent's.
 *
 * `dl zed` adds dl to Zed as an external agent: one entry under `agent_servers` in Zed's
 * settings.json, after a backup, leaving every other setting, comment and the formatting as they
 * were. Before that it makes sure Autopilot can start: if no provider is set up, it runs the free
 * tier sign-in (`autopilot auth directionally-local`) here. `dl zed remove` takes the entry out.
 */

/** The entry's name in Zed (what its agent menu shows), and the ACP registry's display name. */
export const ZED_AGENT_NAME = "Autopilot by dl.new";
/** The setting that holds external agents in Zed's settings.json. */
export const ZED_KEY = "agent_servers";

type Env = Record<string, string | undefined>;

export interface AcpDeps {
  autopilot?: () => Promise<AutopilotCommand | undefined>;
  /** Whether this Autopilot has `acp`; checked (version, else its help) unless replaced. */
  supportsAcp?: (autopilot: AutopilotCommand) => Promise<boolean>;
  /** Starts Autopilot with the terminal's stdio; the real spawn unless replaced (tests). */
  run?: (command: string, args: string[], env: Env) => Promise<number>;
  env?: Env;
}

const realRun = (command: string, args: string[], env: Env): Promise<number> =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", env: env as NodeJS.ProcessEnv });
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
    const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((s) => [s, forward(s)] as const);
    for (const [s, h] of handlers) process.on(s, h);
    const done = (code: number) => {
      for (const [s, h] of handlers) process.off(s, h);
      resolve(code);
    };
    child.on("error", () => done(127));
    child.on("exit", (code, signal) => done(code ?? (signal === "SIGTERM" ? 143 : signal === "SIGINT" ? 130 : 1)));
  });

/** The environment dl starts Autopilot with (as plain dl does on this computer). */
async function autopilotEnv(env: Env): Promise<Env> {
  const referral = await referralForAutopilot({ env: env as NodeJS.ProcessEnv }).catch(() => undefined);
  return withReferral({ ...(env as NodeJS.ProcessEnv), AUTOPILOT_LAUNCHED_BY: "dl", DL_VERSION: dlVersion(), DL_UPDATE_COMMAND: DL_UPDATE }, referral);
}

/** `dl acp [ARGS]`: `autopilot acp [ARGS]` on stdio. */
export async function acpCommand(args: string[], io: LaptopIO, deps: AcpDeps = {}): Promise<number> {
  // Autopilot is optional: downloaded the first time it's needed (autopilot-install.ts).
  const autopilot = await (deps.autopilot ?? (() => ensureAutopilot(io)))();
  if (!autopilot) {
    if (deps.autopilot) io.err("Autopilot isn't installed: dl autopilot downloads it.\n");
    return 1;
  }
  // An older Autopilot would take "acp" as a task to run: refuse instead.
  if (!(await (deps.supportsAcp ?? supportsAcp)(autopilot))) {
    io.err(`This Autopilot is too old for editors (no autopilot acp yet). Update: ${DL_UPDATE}\n`);
    return 1;
  }
  const env = await autopilotEnv(deps.env ?? process.env);
  return (deps.run ?? realRun)(autopilot.command, [...autopilot.args, "acp", ...args], env);
}

/**
 * Whether this Autopilot has `autopilot acp`: its help for `acp` lists --login. An older one
 * prints its general help instead (and would take "acp" as a task to run).
 */
export async function supportsAcp(autopilot: AutopilotCommand): Promise<boolean> {
  try {
    const { stdout, stderr } = await promisify(execFile)(autopilot.command, [...autopilot.args, "acp", "--help"], { timeout: 30_000, env: { ...process.env, NO_COLOR: "1" } });
    return `${stdout}${stderr}`.includes("--login");
  } catch {
    return false;
  }
}

/** Where Zed keeps its user settings: ~/.config/zed (macOS, Linux with XDG_CONFIG_HOME), %APPDATA%\Zed (Windows). */
export function zedSettingsPath(env: Env = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Zed", "settings.json");
  if (platform === "linux" || platform === "freebsd") {
    const base = env.FLATPAK_XDG_CONFIG_HOME || env.XDG_CONFIG_HOME || join(home, ".config");
    return join(base, "zed", "settings.json");
  }
  return join(home, ".config", "zed", "settings.json");
}

/** What dl adds under agent_servers: this Node running dl's own script with `acp`, so it works whatever PATH Zed sees. */
export function zedAgentEntry(node: string, dlScript: string): Record<string, unknown> {
  return { type: "custom", command: node, args: [dlScript, "acp"] };
}

/** dl's own bin script (bin/directionallylocal.mjs), from this module's place in dist/laptop/. */
export async function dlScriptPath(): Promise<string> {
  const script = fileURLToPath(new URL("../../bin/directionallylocal.mjs", import.meta.url));
  return realpath(script).catch(() => script);
}

export interface ZedDeps {
  settingsPath?: string;
  node?: string;
  dlScript?: string;
  autopilot?: () => Promise<AutopilotCommand | undefined>;
  supportsAcp?: (autopilot: AutopilotCommand) => Promise<boolean>;
  /** `autopilot auth status`, read-only; the real one unless replaced. */
  auth?: (autopilot: AutopilotCommand | undefined) => Promise<AutopilotAuth | undefined>;
  /** Runs the free tier sign-in in this terminal; the real one unless replaced. */
  signIn?: (autopilot: AutopilotCommand) => Promise<number>;
  interactive?: boolean;
  now?: () => Date;
  env?: Env;
}

export async function zedCommand(args: string[], io: LaptopIO, deps: ZedDeps = {}): Promise<number> {
  const sub = args[0];
  if (sub === "--help" || sub === "-h" || sub === "help") {
    io.out(ZED_HELP);
    return 0;
  }
  if (sub !== undefined && sub !== "remove" && sub !== "--print") {
    io.err(`Unknown argument "${sub}".\n\n${ZED_HELP}`);
    return 2;
  }
  const path = deps.settingsPath ?? zedSettingsPath(deps.env ?? process.env);
  const entry = zedAgentEntry(deps.node ?? process.execPath, deps.dlScript ?? (await dlScriptPath()));

  if (sub === "--print") {
    io.out(`${JSON.stringify({ [ZED_KEY]: { [ZED_AGENT_NAME]: entry } }, null, 2)}\n`);
    return 0;
  }

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      io.err(`Couldn't read ${path}: ${(error as Error).message}\n`);
      return 1;
    }
    text = "";
  }

  if (sub === "remove") {
    let next: string;
    try {
      next = removeMember(text, ZED_KEY, ZED_AGENT_NAME);
    } catch (error) {
      io.err(unreadable(path, error));
      return 1;
    }
    if (next === text) {
      io.out(`${ZED_AGENT_NAME} isn't in ${path}; nothing to remove.\n`);
      return 0;
    }
    const backup = await writeWithBackup(path, text, next, deps.now?.() ?? new Date());
    io.out(`Removed ${ZED_AGENT_NAME} from Zed's agents (${path}).${backup ? ` Backup: ${backup}` : ""}\n`);
    return 0;
  }

  // Check the file can be edited before asking anyone to sign in.
  let next: string;
  let current: unknown;
  try {
    current = readMember(text, ZED_KEY, ZED_AGENT_NAME);
    next = setMember(text, ZED_KEY, ZED_AGENT_NAME, entry);
  } catch (error) {
    io.err(unreadable(path, error));
    return 1;
  }

  // Autopilot must be able to start a session, or Zed's first thread asks to sign in.
  // Autopilot is optional: downloaded the first time it's needed (autopilot-install.ts).
  const autopilot = await (deps.autopilot ?? (() => ensureAutopilot(io)))();
  if (!autopilot) {
    if (deps.autopilot) io.err("Autopilot isn't installed: dl autopilot downloads it.\n");
    return 1;
  }
  if (!(await (deps.supportsAcp ?? supportsAcp)(autopilot))) {
    io.err(`dl's Autopilot is too old for Zed (no autopilot acp yet). Run ${DL_UPDATE}, then dl zed again.\n`);
    return 1;
  }
  const auth = await (deps.auth ?? ((a) => autopilotAuth(a)))(autopilot);
  if (auth && !auth.setUp) {
    if (deps.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true)) {
      io.out("Signing in to dl's free tier first (Autopilot has no provider yet).\n");
      const code = await (deps.signIn ?? realSignIn(deps.env ?? process.env))(autopilot);
      if (code !== 0) {
        io.err("Not signed in, so Zed isn't set up yet. Run dl zed again to retry, or run dl to pick another provider first.\n");
        return code;
      }
    } else {
      io.err("Autopilot has no provider yet: Zed's first thread will offer \"Sign in to dl\" (or run dl first).\n");
    }
  } else if (auth) {
    io.out(`Autopilot's provider: ${auth.active === "directionally-local" ? "dl free tier" : auth.active} (Zed uses the same).\n`);
  }

  if (JSON.stringify(current) === JSON.stringify(entry)) {
    io.out(`${ZED_AGENT_NAME} is already in Zed's agents (${path}).\n${NEXT_STEPS}`);
    return 0;
  }
  const backup = await writeWithBackup(path, text, next, deps.now?.() ?? new Date());
  io.out(`Added ${ZED_AGENT_NAME} to Zed's agents (${path}).${backup ? ` Backup: ${backup}` : ""}\n${NEXT_STEPS}`);
  return 0;
}

const NEXT_STEPS =
  "In Zed: open the Agent Panel, start a new thread and pick Autopilot by dl.new (no restart needed). dl zed remove takes it out.\n";

const ZED_HELP = `dl zed          add dl (Autopilot) to Zed as an external agent: signs in if needed, backs up
                and edits Zed's settings.json (agent_servers), leaving everything else as it is
dl zed remove   take it out again
dl zed --print  print the settings entry instead of writing it
dl acp          the agent itself, on stdio: the command any ACP editor runs (T3 Code: "Local ACP command")
`;

function unreadable(path: string, error: unknown): string {
  const why = error instanceof JsoncError ? error.message : (error as Error).message;
  return `Couldn't read ${path} as settings (${why}), so it wasn't changed. Fix it in Zed, or add this under "${ZED_KEY}" yourself (dl zed --print shows it).\n`;
}

/** Write `next` over `path` through a temporary file; first copy the old file next to it. Returns the backup's path. */
async function writeWithBackup(file: string, before: string, next: string, now: Date): Promise<string | undefined> {
  // A settings.json symlinked from a dotfiles repo: write through the link, never replace it.
  const path = await realpath(file).catch(() => file);
  await mkdir(dirname(path), { recursive: true });
  let backup: string | undefined;
  if (before !== "") {
    backup = `${path}.dl-backup-${now.toISOString().replace(/[:.]/g, "-")}`;
    await copyFile(path, backup);
  }
  const tmp = `${path}.dl-tmp-${process.pid}`;
  await writeFile(tmp, next, "utf8");
  await rename(tmp, path);
  return backup;
}

function realSignIn(env: Env): (autopilot: AutopilotCommand) => Promise<number> {
  return async (autopilot) => realRun(autopilot.command, [...autopilot.args, "auth", "directionally-local"], await autopilotEnv(env));
}
