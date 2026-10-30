import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type { KeyListing } from "../keys.js";
import { configureThisComputer, listLocalKeys } from "../local/keys.js";
import { PAIRED_NAME } from "../local/layout.js";
import { PromptCancelled, TtyPrompter, type Prompter } from "../prompt.js";
import { describeProvider, providerAnswer, type ConnectResult } from "../provider.js";
import { palette, PlainUi, TerminalUi } from "../ui.js";
import type { LaptopIO } from "./commands.js";
import { loadRemotes, resolveRemote, type RemoteServer, type SshAccess } from "./config.js";
import { ConnectCancelled, runAutopilotConnect } from "./connect.js";
import { githubToken, type KeySources } from "./credentials.js";
import { applyOnServer, type ServerAnswers, type UiFactory } from "./remote-install.js";
import { loadSettings, saveModel } from "./settings.js";
import { checkServer, realSshExec, type SshExec } from "./ssh.js";

/**
 * `dl provider` on a laptop (`dl keys` is the same command): which provider and GitHub token
 * each place has, and replacing either. The provider comes from Autopilot's own picker
 * (`autopilot connect`), as in setup; its key goes to the place and nowhere else:
 *   - a server set up over SSH gets it through `dl up --answers-stdin` (never in argv);
 *   - "this computer" stores it directly (src/local/keys.ts).
 * The GitHub token is found or asked for here (the GitHub CLI's login with a Y/n, or hidden input).
 */

export interface ProviderCommandDeps {
  newUi: UiFactory;
  prompter: Prompter;
  write: (text: string) => void;
  color: boolean;
  ssh: SshExec;
  sources: KeySources;
  /** Autopilot's picker; the real one unless replaced. */
  connect?: (options: { modelOnly?: boolean }) => Promise<ConnectResult>;
  /** The "this computer" install. */
  local: {
    configure: (answers: ServerAnswers) => Promise<void>;
    list: () => Promise<KeyListing[]>;
  };
  remotesFile?: string;
  settingsFile?: string;
}

type Target =
  | { kind: "ssh"; remote: RemoteServer; access: SshAccess }
  | { kind: "local"; remote: RemoteServer };

export const PROVIDER_USAGE = "  Usage: dl provider                    the provider and GitHub token on each place\n"
  + "         dl provider set [--server NAME]   pick another provider, key and model in Autopilot's list\n"
  + "         dl provider github [--server NAME]   replace the GitHub token\n"
  + "         (dl keys is the same command)\n";

export async function providerCommand(args: string[], options: { server?: string }, deps: ProviderCommandDeps): Promise<number> {
  const c = palette(deps.color);
  const [first, ...rest] = args;
  const action = first === undefined || first === "ls" || first === "list" ? "list" : first === "github" ? "github" : first === "set" || first === "change" || first === "openrouter" || first === "provider" ? "set" : undefined;
  if (!action || rest.length > 0) {
    deps.write(PROVIDER_USAGE);
    return 2;
  }
  if (action === "list") return listPlaces(options.server, deps, c);

  const target = await resolveTarget(options.server, deps.remotesFile);
  const where = target.kind === "local" ? "this computer" : target.remote.name;
  // Reach the server before asking for anything, so a dead connection doesn't waste a key.
  const facts = target.kind === "ssh" ? await checkServer(target.access, deps.ssh, target.remote.name) : undefined;
  const answers: ServerAnswers = {};
  const ui = deps.newUi();
  if (action === "set") {
    let chosen: ConnectResult;
    try {
      chosen = await (deps.connect ?? ((connectOptions) => runAutopilotConnect(connectOptions)))({});
    } catch (error) {
      if (!(error instanceof ConnectCancelled)) throw error;
      deps.write(`  ${c.dim("Unchanged.")}\n\n`);
      return 130;
    }
    answers.provider = providerAnswer(chosen);
    await saveModel(chosen.model, deps.settingsFile, target.remote.name);
    ui.line("done", "Provider", `${describeProvider({ id: chosen.provider, name: chosen.name }, chosen.model)} · key stays on ${where}`);
  } else {
    ui.questions(`A new GitHub token for ${where}; it replaces the one there. Typing is hidden.`);
    try {
      answers.githubToken = await githubToken({ ui, prompter: deps.prompter, sources: deps.sources, place: target.kind === "local" ? "this computer" : "your server" });
    } catch (error) {
      if (!(error instanceof PromptCancelled)) throw error;
      deps.write(`  ${c.dim("Unchanged.")}\n\n`);
      return 130;
    }
  }
  ui.plan([{ id: "apply", label: `Storing on ${where}` }]);
  ui.start("apply");
  try {
    if (target.kind === "local") await deps.local.configure(answers);
    else await applyOnServer(target.access, facts!, deps.ssh, answers);
    ui.done("apply", answers.provider ? `${answers.provider.id} in Hotcell · services restarted` : "GitHub token replaced · Autopilot restarted");
  } catch (error) {
    ui.fail("apply", error instanceof Error ? error.message.split("\n")[0]! : String(error));
    ui.finish();
    throw error;
  }
  ui.finish();
  return 0;
}

/** One line per place: its provider (and Hotcell's mask of the key), the model dl uses there, and the GitHub token. */
async function listPlaces(server: string | undefined, deps: ProviderCommandDeps, c: ReturnType<typeof palette>): Promise<number> {
  const remotes = server ? [await resolveRemote(server, deps.remotesFile)] : await loadRemotes(deps.remotesFile);
  if (remotes.length === 0) {
    deps.write(`\n  Nothing set up yet.  ${c.bold("dl")}\n\n`);
    return 0;
  }
  const settings = await loadSettings(deps.settingsFile);
  deps.write(`\n  ${c.bold("Provider")} ${c.dim("on each place; keys stay there")}\n\n`);
  for (const remote of remotes) {
    const model = settings.placeModels?.[remote.name] ?? settings.model;
    let listing: KeyListing[];
    try {
      listing = remote.ssh
        ? await listOverSsh({ kind: "ssh", remote, access: remote.ssh }, deps.ssh)
        : remote.name === PAIRED_NAME ? await deps.local.list() : [];
    } catch (error) {
      deps.write(`  ${c.red("✗")} ${remote.name.padEnd(16)}${error instanceof Error ? error.message : String(error)}\n`);
      continue;
    }
    if (listing.length === 0) {
      deps.write(`  ${c.dim("·")} ${remote.name.padEnd(16)}${c.dim("connected with dl connect; its keys are managed on the server (sudo dl keys)")}\n`);
      continue;
    }
    const provider = listing.find((entry) => entry.key === "provider");
    const github = listing.find((entry) => entry.key === "github");
    const cell = (entry: KeyListing | undefined, name: string) => !entry || !entry.set ? c.red(`${name} not set`) : entry.problem ? c.red(`${name}: ${entry.problem}`) : `${name} ${c.dim(entry.detail ?? "set")}`;
    deps.write(`  ${provider?.set && github?.set && !provider.problem && !github.problem ? c.green("✓") : c.red("✗")} ${remote.name.padEnd(16)}${cell(provider, "provider")}${model ? ` · model ${model}` : ""}   ${cell(github, "GitHub")}\n`);
  }
  deps.write(`\n  ${c.dim("Change the provider (and model):")} dl provider set   ${c.dim("Replace the GitHub token:")} dl provider github   ${c.dim("(--server NAME picks the place)")}\n\n`);
  return 0;
}

/** The place in use: `--server NAME`, or the only (or default) one. */
async function resolveTarget(server: string | undefined, remotesFile: string | undefined): Promise<Target> {
  const remote = remotesFile ? await resolveRemote(server, remotesFile) : await resolveRemote(server);
  if (remote.ssh) return { kind: "ssh", remote, access: remote.ssh };
  if (remote.name === PAIRED_NAME) return { kind: "local", remote };
  throw new Error(`${remote.name} was connected with dl connect, so this laptop can't reach its keys. On that server, run: sudo dl keys`);
}

function sudo(root: boolean): string {
  return root ? "" : "sudo -n ";
}

async function listOverSsh(target: Extract<Target, { kind: "ssh" }>, ssh: SshExec): Promise<KeyListing[]> {
  const { root } = await checkServer(target.access, ssh, target.remote.name);
  const result = await ssh(target.access, `${sudo(root)}dl keys --json`);
  const parsed = lastJson(result.stdout) as { keys?: unknown } | undefined;
  if (result.code !== 0 || !parsed || !Array.isArray(parsed.keys)) throw serverFailure(target.remote.name, result);
  return parsed.keys.flatMap(asListing);
}

function serverFailure(name: string, result: { code: number; stdout: string; stderr: string }): Error {
  if (/Unknown command "keys"|Unknown option '--(stdin|json)'/.test(result.stderr)) {
    return new Error(`The dl on ${name} is too old for dl provider; update it with dl update ${name}, then try again.`);
  }
  return new Error(`Couldn't read the keys on ${name}: ${lastLine(result.stderr) || lastLine(result.stdout) || `exit ${result.code}`}`);
}

/** A server's row; an older server's "openrouter" row is the provider row. */
function asListing(value: unknown): KeyListing[] {
  if (!value || typeof value !== "object") return [];
  const entry = value as Record<string, unknown>;
  const key = entry.key === "openrouter" ? "provider" : entry.key;
  if ((key !== "provider" && key !== "github") || typeof entry.set !== "boolean") return [];
  if (entry.detail !== undefined && typeof entry.detail !== "string") return [];
  if (entry.problem !== undefined && typeof entry.problem !== "string") return [];
  const detail = entry.key === "openrouter" && typeof entry.detail === "string" ? `openrouter · ${entry.detail}` : entry.detail as string | undefined;
  return [{ key, set: entry.set, ...(detail !== undefined ? { detail } : {}), ...(typeof entry.problem === "string" ? { problem: entry.problem } : {}) }];
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

/** `dl provider` / `dl keys` on a laptop with the real terminal, ssh, gh, Autopilot, and filesystem. */
export async function provider(args: string[], options: { server?: string; io: LaptopIO; terminal: boolean }): Promise<number> {
  const { io, terminal } = options;
  const color = io.color === true;
  const execFileAsync = promisify(execFile);
  return providerCommand(args, options.server ? { server: options.server } : {}, {
    newUi: () => terminal ? new TerminalUi(io.out, undefined, color) : new PlainUi(io.out),
    prompter: new TtyPrompter({ color }),
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
    local: { configure: (answers) => configureThisComputer(answers), list: () => listLocalKeys({ fetchImpl: globalThis.fetch }) },
  });
}
