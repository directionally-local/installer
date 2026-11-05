/**
 * `dl claude-code hook install|remove`: an opt-in Claude Code hook that says how to continue in
 * dl when Claude Code stops on a usage or rate limit (directionally-local/autopilot#1127).
 *
 * The signal: Claude Code's `StopFailure` hook event runs instead of `Stop` when a turn ends on
 * an API error, with the error type in `error` (and as the matcher): `rate_limit` is the limit
 * case. Claude Code ignores a StopFailure hook's output and exit code, and hooks run without a
 * controlling terminal, so the hook can't print a line in the conversation. The one output
 * Claude Code still acts on is `terminalSequence`, an allowlisted escape sequence it writes
 * itself: we use it for a terminal notification and the window title, both carrying the line.
 *
 * Nothing here edits ~/.claude/settings.json without asking: install shows the exact entry and
 * asks, backs the file up first, and merges into what's there; remove takes out only dl's entry.
 */
import { copyFile, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { LaptopIO } from "./commands.js";
import { palette } from "../ui.js";

/** The Claude Code hook event that fires when a turn ends on an API error. */
export const HOOK_EVENT = "StopFailure";
/** StopFailure's error type for usage and rate limits. */
export const HOOK_MATCHER = "rate_limit";
/** What Claude Code runs; how dl recognises its own entry. */
export const HOOK_COMMAND = "dl claude-code hook notify";
/** The line the hook shows. */
export const LIMIT_LINE = "Claude Code hit its limit. Continue in dl: dl --from-claude-code";
/** Shown when Claude Code's hook input isn't the shape this hook was written for. */
export const UNKNOWN_FORMAT_LINE = "Claude Code stopped, and dl couldn't read why (its hook format may have changed). To continue in dl: dl --from-claude-code";

interface HookCommand {
  type: "command";
  command: string;
  timeout?: number;
}

interface MatcherGroup {
  matcher?: string;
  hooks: HookCommand[];
}

/** The entry dl adds under hooks.StopFailure. */
export function hookEntry(): MatcherGroup {
  return { matcher: HOOK_MATCHER, hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 10 }] };
}

/** Claude Code's user settings: `$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`. */
export function claudeSettingsPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return join(configured ? configured : join(home, ".claude"), "settings.json");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOurs(hook: unknown): boolean {
  return isObject(hook) && typeof hook.command === "string" && hook.command.trim().startsWith(HOOK_COMMAND);
}

/** Thrown when settings.json isn't the shape Claude Code documents; nothing is changed. */
export class UnexpectedSettings extends Error {}

/**
 * Settings with dl's entry added, merged into whatever is there (other events, other StopFailure
 * hooks and every other key are kept). `added` is false when it was already there.
 */
export function withHook(settings: Record<string, unknown>): { settings: Record<string, unknown>; added: boolean } {
  const hooks = settings.hooks ?? {};
  if (!isObject(hooks)) throw new UnexpectedSettings("its \"hooks\" isn't an object");
  const groups = hooks[HOOK_EVENT] ?? [];
  if (!Array.isArray(groups)) throw new UnexpectedSettings(`its "hooks.${HOOK_EVENT}" isn't a list`);
  if (groups.some((group) => isObject(group) && Array.isArray(group.hooks) && group.hooks.some(isOurs))) return { settings, added: false };
  return { settings: { ...settings, hooks: { ...hooks, [HOOK_EVENT]: [...groups, hookEntry()] } }, added: true };
}

/** Settings without dl's entry: only dl's own hook is taken out, and groups it leaves empty. */
export function withoutHook(settings: Record<string, unknown>): { settings: Record<string, unknown>; removed: number } {
  const hooks = settings.hooks;
  if (!isObject(hooks) || !Array.isArray(hooks[HOOK_EVENT])) return { settings, removed: 0 };
  let removed = 0;
  const groups = (hooks[HOOK_EVENT] as unknown[]).flatMap((group) => {
    if (!isObject(group) || !Array.isArray(group.hooks)) return [group];
    const kept = group.hooks.filter((hook) => !isOurs(hook));
    removed += group.hooks.length - kept.length;
    if (kept.length === group.hooks.length) return [group];
    return kept.length ? [{ ...group, hooks: kept }] : [];
  });
  if (removed === 0) return { settings, removed };
  const { [HOOK_EVENT]: _dropped, ...otherEvents } = hooks;
  const nextHooks = groups.length ? { ...otherEvents, [HOOK_EVENT]: groups } : otherEvents;
  const { hooks: _hooks, ...rest } = settings;
  return { settings: Object.keys(nextHooks).length ? { ...rest, hooks: nextHooks } : rest, removed };
}

export interface HookCommandDeps {
  io: LaptopIO;
  /** Claude Code's settings file; claudeSettingsPath() unless replaced. */
  file?: string;
  /** Asks a yes/no question; resolves true for yes. Absent: there's no terminal to ask on. */
  confirm?: (question: string) => Promise<boolean>;
  /** For the backup's name. */
  now?: () => Date;
}

async function readSettings(file: string): Promise<{ settings: Record<string, unknown>; exists: boolean }> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { settings: {}, exists: false };
    throw error;
  }
  if (!text.trim()) return { settings: {}, exists: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UnexpectedSettings("it isn't valid JSON");
  }
  if (!isObject(parsed)) throw new UnexpectedSettings("it isn't a JSON object");
  return { settings: parsed, exists: true };
}

/** A copy next to the file, named for when it was taken. */
async function backUp(file: string, now: Date): Promise<string> {
  const backup = `${file}.dl-backup-${now.toISOString().replace(/[:.]/g, "-")}`;
  await copyFile(file, backup);
  return backup;
}

/** Written whole, then renamed over the original, keeping its permissions. */
async function writeSettings(file: string, settings: Record<string, unknown>): Promise<void> {
  const mode = await stat(file).then((info) => info.mode & 0o777).catch(() => 0o600);
  const temporary = `${file}.dl-${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode });
  await rename(temporary, file);
}

function display(file: string, home: string = homedir()): string {
  return home && file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file;
}

function snippet(): string {
  return JSON.stringify({ hooks: { [HOOK_EVENT]: [hookEntry()] } }, null, 2);
}

function indent(text: string): string {
  return text.split("\n").map((line) => `    ${line}`).join("\n");
}

/** `dl claude-code hook install`. */
export async function installHook(deps: HookCommandDeps): Promise<number> {
  const { io } = deps;
  const c = palette(io.color === true);
  const file = deps.file ?? claudeSettingsPath();
  const shown = display(file);
  if (!(await stat(dirname(file)).then((info) => info.isDirectory()).catch(() => false))) {
    io.err(`  ${c.red("✗")} ${display(dirname(file))} doesn't exist, so Claude Code doesn't seem to be set up for this user. Nothing was changed.\n`);
    return 1;
  }
  let current;
  try {
    current = await readSettings(file);
  } catch (error) {
    io.err(`  ${c.red("✗")} Couldn't use ${shown}: ${(error as Error).message}. Nothing was changed.\n`);
    return 1;
  }
  let next;
  try {
    next = withHook(current.settings);
  } catch (error) {
    io.err(`  ${c.red("✗")} ${shown} isn't the shape Claude Code documents: ${(error as Error).message}. Nothing was changed.\n`);
    return 1;
  }
  if (!next.added) {
    io.out(`  ${c.green("✓")} The hook is already in ${shown}. Remove it with ${c.bold("dl claude-code hook remove")}\n`);
    return 0;
  }
  io.out(
    `  When Claude Code stops on a usage or rate limit, this hook shows:\n    ${LIMIT_LINE}\n` +
      `  ${c.dim("(as a terminal notification and the window title: Claude Code doesn't let hooks print in the conversation)")}\n\n` +
      `  It adds this to ${shown}${current.exists ? ", after backing it up" : ""}:\n\n${indent(snippet())}\n\n`,
  );
  if (!deps.confirm) {
    io.err(`  ${c.red("✗")} dl asks before changing Claude Code's settings; run this in a terminal. Nothing was changed.\n`);
    return 1;
  }
  if (!(await deps.confirm(`  Add it? [Y/n] `))) {
    io.out("  Not added; nothing was changed.\n");
    return 0;
  }
  const backup = current.exists ? await backUp(file, (deps.now ?? (() => new Date()))()) : undefined;
  await writeSettings(file, next.settings);
  io.out(
    `  ${c.green("✓")} Added to ${shown}: under hooks.${HOOK_EVENT}, ${JSON.stringify(hookEntry())}\n` +
      (backup ? `    ${c.dim(`Backup: ${display(backup)}`)}\n` : "") +
      `    Remove it with ${c.bold("dl claude-code hook remove")}\n`,
  );
  return 0;
}

/**
 * dl's hook taken out of `file` without a word (`dl uninstall`): backed up first, as with
 * `dl claude-code hook remove`. Undefined when it wasn't there or the file can't be used.
 */
export async function removeHookQuietly(file: string = claudeSettingsPath(), now: Date = new Date()): Promise<{ backup: string } | undefined> {
  const current = await readSettings(file).catch(() => undefined);
  if (!current) return undefined;
  const next = withoutHook(current.settings);
  if (next.removed === 0) return undefined;
  const backup = await backUp(file, now);
  await writeSettings(file, next.settings);
  return { backup };
}

/** `dl claude-code hook remove`. */
export async function removeHook(deps: HookCommandDeps): Promise<number> {
  const { io } = deps;
  const c = palette(io.color === true);
  const file = deps.file ?? claudeSettingsPath();
  const shown = display(file);
  let current;
  try {
    current = await readSettings(file);
  } catch (error) {
    io.err(`  ${c.red("✗")} Couldn't use ${shown}: ${(error as Error).message}. Nothing was changed.\n`);
    return 1;
  }
  const next = withoutHook(current.settings);
  if (next.removed === 0) {
    io.out(`  ${c.green("✓")} dl's hook isn't in ${shown}; nothing to remove.\n`);
    return 0;
  }
  const backup = await backUp(file, (deps.now ?? (() => new Date()))());
  await writeSettings(file, next.settings);
  io.out(`  ${c.green("✓")} Removed dl's hook (hooks.${HOOK_EVENT}, ${HOOK_COMMAND}) from ${shown}\n    ${c.dim(`Backup: ${display(backup)}`)}\n`);
  return 0;
}

/**
 * Claude Code's allowlisted way for a hook to reach the terminal: a notification in the escape
 * sequence this terminal understands (OSC 99 kitty, OSC 777 Ghostty, Warp and urxvt, OSC 9
 * iTerm2, WezTerm, Windows Terminal and the rest), and the window title (OSC 2), which every
 * terminal shows.
 */
export function terminalSequence(line: string, env: NodeJS.ProcessEnv = process.env): string {
  const text = line.replace(/[\x00-\x1f\x7f;]/g, " ");
  const term = env.TERM ?? "";
  const program = (env.TERM_PROGRAM ?? "").toLowerCase();
  const notification =
    env.KITTY_WINDOW_ID || term === "xterm-kitty"
      ? `\x1b]99;;${text}\x1b\\`
      : program === "ghostty" || program === "warpterminal" || term.startsWith("rxvt")
        ? `\x1b]777;notify;Claude Code;${text}\x07`
        : `\x1b]9;${text}\x07`;
  return `${notification}\x1b]2;${text}\x07`;
}

/**
 * What the hook prints for Claude Code, given its input: the line on a rate limit, a plain
 * note when the input isn't the documented shape, and nothing for any other stop.
 */
export function hookOutput(input: string, env: NodeJS.ProcessEnv = process.env): string {
  let payload: unknown;
  try {
    payload = JSON.parse(input);
  } catch {
    payload = undefined;
  }
  if (!isObject(payload) || typeof payload.hook_event_name !== "string" || typeof payload.error !== "string") {
    return `${JSON.stringify({ terminalSequence: terminalSequence(UNKNOWN_FORMAT_LINE, env) })}\n`;
  }
  if (payload.hook_event_name !== HOOK_EVENT || payload.error !== HOOK_MATCHER) return "";
  return `${JSON.stringify({ terminalSequence: terminalSequence(LIMIT_LINE, env) })}\n`;
}

/** Claude Code's hook input on stdin: one small JSON object. */
export async function readHookInput(stdin: NodeJS.ReadableStream & { isTTY?: boolean }, timeoutMs = 3_000): Promise<string> {
  if (stdin.isTTY) return "";
  let text = "";
  const reading = (async () => {
    for await (const chunk of stdin) {
      text += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
      if (text.length > 256 * 1024) break;
    }
  })();
  await Promise.race([reading, new Promise((resolve) => setTimeout(resolve, timeoutMs).unref())]);
  return text;
}

/** `dl claude-code hook notify`: what Claude Code runs. Always exits 0; Claude Code ignores the code anyway. */
export async function notifyHook(io: LaptopIO, stdin: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin): Promise<number> {
  io.out(hookOutput(await readHookInput(stdin)));
  return 0;
}

const USAGE = `  Usage: dl claude-code hook install   add the hook that says how to continue in dl when Claude Code hits its limit
         dl claude-code hook remove    take it out again
`;

/** `dl claude-code …`. */
export async function claudeCodeCommand(args: string[], deps: HookCommandDeps & { stdin?: NodeJS.ReadableStream & { isTTY?: boolean } }): Promise<number> {
  const [group, action] = args;
  if (group !== "hook" || !action) {
    deps.io.err(USAGE);
    return 2;
  }
  if (action === "install") return installHook(deps);
  if (action === "remove") return removeHook(deps);
  if (action === "notify") return notifyHook(deps.io, deps.stdin);
  deps.io.err(USAGE);
  return 2;
}
