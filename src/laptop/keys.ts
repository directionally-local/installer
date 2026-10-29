import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { KEY_LABELS, formatKeyListing, parseKeyName, type KeyListing, type KeyName, type KeyResult } from "../keys.js";
import { listLocalKeys, setLocalKey } from "../local/keys.js";
import { PAIRED_NAME } from "../local/layout.js";
import { TtyPrompter, type Prompter } from "../prompt.js";
import { palette, PlainUi, TerminalUi } from "../ui.js";
import type { LaptopIO } from "./commands.js";
import { resolveRemote, type RemoteServer, type SshAccess } from "./config.js";
import { githubToken, openrouterKey, type KeySources } from "./credentials.js";
import type { UiFactory } from "./remote-install.js";
import { checkServer, realSshExec, type SshExec } from "./ssh.js";

/**
 * `dl keys [openrouter|github]` on a laptop: replace a key where the agents run, or list
 * which are set. The new key is found or asked for here (hidden input, or the GitHub CLI's
 * login / Autopilot's OpenRouter key with a Y/n, as in setup) and checked, then:
 *   - a server set up over SSH gets it on stdin of `dl keys set <which> --stdin --json`
 *     (with sudo -n when the SSH user isn't root): never in argv, here or there;
 *   - "this computer" stores it directly (src/local/keys.ts).
 * The server or this computer stores it where setup did and restarts the service that reads it.
 */

export interface LaptopKeysDeps {
  newUi: UiFactory;
  prompter: Prompter;
  write: (text: string) => void;
  color: boolean;
  ssh: SshExec;
  sources: KeySources;
  /** The "this computer" install. */
  local: {
    set: (which: KeyName, value: string) => Promise<KeyResult>;
    list: () => Promise<KeyListing[]>;
  };
  remotesFile?: string;
}

type Target =
  | { kind: "ssh"; remote: RemoteServer; access: SshAccess }
  | { kind: "local"; remote: RemoteServer };

export const LAPTOP_KEYS_USAGE = "  Usage: dl keys [openrouter|github] [--server NAME]\n"
  + "         dl keys              which keys are set where your agents run\n"
  + "         dl keys openrouter   replace the OpenRouter key     dl keys github   replace the GitHub token\n";

export async function laptopKeys(args: string[], options: { server?: string }, deps: LaptopKeysDeps): Promise<number> {
  const [first, ...rest] = args;
  const which = first === undefined || first === "ls" || first === "list" ? undefined : parseKeyName(first);
  if ((first !== undefined && first !== "ls" && first !== "list" && !which) || rest.length > 0) {
    deps.write(LAPTOP_KEYS_USAGE);
    return 2;
  }
  const target = await resolveTarget(options.server, deps.remotesFile);
  const again = (key: KeyName) => `dl keys ${key}${options.server ? ` --server ${target.remote.name}` : ""}`;
  if (!which) {
    const listing = target.kind === "local" ? await deps.local.list() : await listOverSsh(target, deps.ssh);
    deps.write(formatKeyListing(listing, palette(deps.color), `on ${target.kind === "local" ? "this computer" : target.remote.name}`, again));
    return 0;
  }

  // Reach the server before asking for anything, so a dead connection doesn't waste a key.
  const root = target.kind === "ssh" ? (await checkServer(target.access, deps.ssh, target.remote.name)).root : true;
  const where = target.kind === "local" ? "this computer" : target.remote.name;
  const label = `${KEY_LABELS[which]} ${which === "github" ? "token" : "key"}`;
  const askUi = deps.newUi();
  askUi.questions(`A new ${label} for ${where}; it replaces the one there. Typing is hidden.`);
  const value = which === "github"
    ? await githubToken({ ui: askUi, prompter: deps.prompter, sources: deps.sources })
    : await openrouterKey({ ui: askUi, prompter: deps.prompter, sources: deps.sources });
  askUi.finish();

  const ui = deps.newUi();
  ui.plan([{ id: "apply", label: `Replacing the ${label} on ${where}` }]);
  ui.start("apply");
  try {
    const result = target.kind === "local" ? await deps.local.set(which, value) : await setOverSsh(target, root, which, value, deps.ssh);
    ui.done("apply", result.detail);
  } catch (error) {
    ui.fail("apply", error instanceof Error ? error.message.split("\n")[0]! : String(error));
    ui.finish();
    throw error;
  }
  ui.finish();
  return 0;
}

/** The server in use: `--server NAME`, or the only (or default) one. */
async function resolveTarget(server: string | undefined, remotesFile: string | undefined): Promise<Target> {
  const remote = remotesFile ? await resolveRemote(server, remotesFile) : await resolveRemote(server);
  if (remote.ssh) return { kind: "ssh", remote, access: remote.ssh };
  if (remote.name === PAIRED_NAME) return { kind: "local", remote };
  throw new Error(`${remote.name} was connected with dl connect, so this laptop can't reach its keys. On that server, run: sudo dl keys`);
}

function sudo(root: boolean): string {
  return root ? "" : "sudo -n ";
}

async function setOverSsh(target: Extract<Target, { kind: "ssh" }>, root: boolean, which: KeyName, value: string, ssh: SshExec): Promise<KeyResult> {
  // The key travels on stdin only; the command line names which key, never its value.
  const result = await ssh(target.access, `${sudo(root)}dl keys set ${which} --stdin --json`, { input: `${value}\n` });
  const parsed = lastJson(result.stdout) as { ok?: unknown; detail?: unknown; error?: unknown } | undefined;
  if (parsed?.ok === true) return { ok: true, key: which, detail: typeof parsed.detail === "string" ? parsed.detail : "replaced" };
  if (typeof parsed?.error === "string") throw new Error(`${target.remote.name}: ${parsed.error}`);
  throw serverFailure(target.remote.name, result);
}

async function listOverSsh(target: Extract<Target, { kind: "ssh" }>, ssh: SshExec): Promise<KeyListing[]> {
  const { root } = await checkServer(target.access, ssh, target.remote.name);
  const result = await ssh(target.access, `${sudo(root)}dl keys --json`);
  const parsed = lastJson(result.stdout) as { keys?: unknown } | undefined;
  if (result.code !== 0 || !parsed || !Array.isArray(parsed.keys)) throw serverFailure(target.remote.name, result);
  return parsed.keys.filter(isListing);
}

function serverFailure(name: string, result: { code: number; stdout: string; stderr: string }): Error {
  if (/Unknown command "keys"|Unknown option '--(stdin|json)'/.test(result.stderr)) {
    return new Error(`The dl on ${name} is too old for dl keys; update it with dl setup (it keeps your keys), then try again.`);
  }
  return new Error(`Couldn't change the keys on ${name}: ${lastLine(result.stderr) || lastLine(result.stdout) || `exit ${result.code}`}`);
}

function isListing(value: unknown): value is KeyListing {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (entry.key === "openrouter" || entry.key === "github") && typeof entry.set === "boolean"
    && (entry.detail === undefined || typeof entry.detail === "string") && (entry.problem === undefined || typeof entry.problem === "string");
}

function lastJson(stdout: string): unknown {
  for (const line of stdout.trim().split("\n").reverse()) {
    try {
      return JSON.parse(line);
    } catch {
      // not JSON; keep looking
    }
  }
  return undefined;
}

function lastLine(text: string): string {
  return text.trim().split("\n").filter((line) => line.trim() && !/Permanently added/i.test(line)).at(-1)?.trim() ?? "";
}

/** `dl keys` on a laptop with the real terminal, ssh, gh, and filesystem. */
export async function keys(args: string[], options: { server?: string; io: LaptopIO; terminal: boolean }): Promise<number> {
  const { io, terminal } = options;
  const color = io.color === true;
  const execFileAsync = promisify(execFile);
  return laptopKeys(args, options.server ? { server: options.server } : {}, {
    newUi: () => terminal ? new TerminalUi(io.out, undefined, color) : new PlainUi(io.out),
    prompter: new TtyPrompter(),
    write: io.out,
    color,
    ssh: realSshExec,
    sources: {
      env: process.env,
      home: homedir(),
      readFile: (path) => readFile(path, "utf8").catch(() => undefined),
      gh: () => execFileAsync("gh", ["auth", "token"], { timeout: 5000 }).then(({ stdout }) => stdout.trim() || undefined, () => undefined),
      fetch: globalThis.fetch,
    },
    // Checked online here already; this computer re-checks only the format.
    local: { set: (which, value) => setLocalKey(which, value), list: () => listLocalKeys({ fetchImpl: globalThis.fetch }) },
  });
}
