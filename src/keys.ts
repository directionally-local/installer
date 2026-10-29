/**
 * `dl keys` on a server: replace the OpenRouter key or the GitHub token where `dl up`
 * stored them, restart the one service that reads it, and show which keys are set (never
 * their values). Keys come in on stdin (or hidden input on the server's own terminal),
 * never argv, so they stay out of `ps`, shell history, and logs.
 *
 *   OpenRouter  Hotcell's file keystore, as the hotcell user   → restart hotcell.service
 *   GitHub      /etc/autopilot/github.env (0640 root:autopilot) → restart autopilot.service
 *
 * The laptop's `dl keys` runs `dl keys set <which> --stdin --json` here over SSH.
 */
import { AUTOPILOT_PORT, HOTCELL_PORT, PATHS, SERVICES, USERS, githubEnv, hotcellBin, parseEnvFile } from "./layout.js";
import type { Prompter } from "./prompt.js";
import type { System } from "./system.js";
import type { palette } from "./ui.js";
import { asHotcell, validateGitHubToken, validateOpenRouterKey, waitUntil, type Checked } from "./up.js";

export type KeyName = "openrouter" | "github";
export const KEY_NAMES: readonly KeyName[] = ["openrouter", "github"];
export const KEY_LABELS: Record<KeyName, string> = { openrouter: "OpenRouter", github: "GitHub" };

/** What `dl keys set … --json` prints: one line. */
export interface KeyResult {
  ok: true;
  key: KeyName;
  detail: string;
}

/** One row of `dl keys`: whether it's set, and something to recognise it by (never the value). */
export interface KeyListing {
  key: KeyName;
  set: boolean;
  /** OpenRouter: Hotcell's mask (sk-or…ab). GitHub: "signed in as LOGIN" when GitHub answered. */
  detail?: string;
  /** The stored key doesn't work (e.g. GitHub rejected the token). */
  problem?: string;
}

type Colors = ReturnType<typeof palette>;

export function parseKeyName(value: string | undefined): KeyName | undefined {
  return KEY_NAMES.find((name) => name === value?.trim().toLowerCase());
}

/** Format first, then (with `fetchImpl`) the service itself; offline isn't fatal. */
export async function checkKey(which: KeyName, value: string, fetchImpl: typeof fetch | undefined): Promise<Checked> {
  if (!value) return { problem: "No key was given." };
  if (which === "openrouter") {
    const problem = await validateOpenRouterKey(value, fetchImpl);
    return problem ? { problem } : {};
  }
  return validateGitHubToken(value, fetchImpl);
}

/** The key wasn't accepted; nothing was stored or restarted. */
export class KeyRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyRejectedError";
  }
}

export interface ServerKeyOptions {
  /** Checks the key with OpenRouter / GitHub first; undefined checks only its format. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Stores the key exactly where `dl up` does, then restarts the service that reads it and waits for it. */
export async function setServerKey(system: System, which: KeyName, value: string, options: ServerKeyOptions = {}): Promise<KeyResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const key = value.trim();
  const checked = await checkKey(which, key, options.fetchImpl);
  if (checked.problem) throw new KeyRejectedError(checked.problem);

  if (which === "openrouter") {
    if (!(await system.exists(hotcellBin()))) throw new Error("Hotcell isn't installed here; run dl up first.");
    // Over stdin into Hotcell's keystore: never in argv, env files, or Autopilot's config. It replaces the old one.
    await asHotcell(system, ["keys", "add", "openrouter", "--stdin"], { input: key, describe: "hotcell keys add openrouter --stdin (as hotcell)" });
    // Hotcell reads its keystore at startup.
    await system.run("systemctl", ["restart", SERVICES.hotcell]);
    await waitUntil(system, sleep, "Hotcell", () => hotcellAnswers(system));
    return { ok: true, key: which, detail: "replaced in Hotcell; Hotcell restarted" };
  }

  await system.mkdir(PATHS.autopilotEtc, { mode: 0o750, owner: `root:${USERS.autopilot}` });
  await system.writeFile(PATHS.githubEnv, githubEnv(key), { mode: 0o640, owner: `root:${USERS.autopilot}`, secret: true });
  // Autopilot reads GITHUB_TOKEN from its env file at startup.
  await system.run("systemctl", ["restart", SERVICES.autopilot]);
  await waitUntil(system, sleep, "Autopilot", () => autopilotAnswers(system));
  return { ok: true, key: which, detail: `${checked.detail ? `${checked.detail}; ` : ""}Autopilot restarted` };
}

/** Which keys this server has. Reads and probes only; the GitHub login is a quick, optional API call. */
export async function listServerKeys(system: System, options: { fetchImpl?: typeof fetch } = {}): Promise<KeyListing[]> {
  let openrouter: KeyListing = { key: "openrouter", set: false };
  if (await system.exists(hotcellBin())) {
    const listed = await system.probe("runuser", [
      "-u", USERS.hotcell, "--", "env", `HOTCELL_HOME=${PATHS.hotcellHome}`, "HOTCELL_KEYSTORE=file", "NO_COLOR=1", "/usr/bin/node", hotcellBin(), "keys", "ls",
    ]);
    if (listed.code === 0) openrouter = { key: "openrouter", ...hotcellKeyListed(listed.stdout, "openrouter") };
  }
  const token = parseEnvFile(await system.readFile(PATHS.githubEnv)).GITHUB_TOKEN;
  return [openrouter, await githubListing(token, options.fetchImpl)];
}

/**
 * A provider's row in `hotcell keys ls` (`openrouter  sk-or…ab  file`), with Hotcell's
 * mask. A column that's long enough to be a key isn't shown, in case the format changes.
 */
export function hotcellKeyListed(stdout: string, provider: string): { set: boolean; detail?: string } {
  const plain = stdout.replace(/\x1b\[[0-9;]*m/g, "");
  const row = plain.split("\n").map((line) => line.trim().split(/\s+/)).find((cells) => cells[0] === provider);
  if (!row) return { set: false };
  const mask = row[1];
  return mask && mask.length <= 12 && (mask.includes("…") || /^•+$/.test(mask)) ? { set: true, detail: mask } : { set: true };
}

/** The GitHub row: set or not, and whose token it is when GitHub answers within a few seconds. */
export async function githubListing(token: string | undefined, fetchImpl: typeof fetch | undefined): Promise<KeyListing> {
  if (!token) return { key: "github", set: false };
  if (!fetchImpl) return { key: "github", set: true };
  const quick: typeof fetch = (input, init) => fetchImpl(input, { ...init, signal: AbortSignal.timeout(5_000) });
  const checked = await validateGitHubToken(token, quick);
  // A stored token in an unexpected format still counts as set; only GitHub's own refusal is a problem.
  if (checked.problem && /rejected/.test(checked.problem)) return { key: "github", set: true, problem: checked.problem };
  return { key: "github", set: true, ...(checked.detail ? { detail: checked.detail } : {}) };
}

/** `dl keys` as text: one line per key, values never shown. */
export function formatKeyListing(listing: KeyListing[], c: Colors, where: string, replaceWith: (key: KeyName) => string): string {
  const rows = listing.map((entry) => {
    const label = KEY_LABELS[entry.key].padEnd(12);
    if (!entry.set) return `  ${c.red("✗")} ${label}${c.dim("not set")}   ${replaceWith(entry.key)}\n`;
    if (entry.problem) return `  ${c.red("✗")} ${label}${entry.problem}   ${c.dim("replace it:")} ${replaceWith(entry.key)}\n`;
    return `  ${c.green("✓")} ${label}${c.dim(entry.detail ?? "set")}\n`;
  });
  const hint = listing.every((entry) => entry.set && !entry.problem)
    ? `\n  ${c.dim("Replace one:")} ${replaceWith("openrouter")}   ${c.dim("or")}   ${replaceWith("github")}\n`
    : "";
  return `\n  ${c.bold("Keys")} ${c.dim(where)}\n\n${rows.join("")}${hint}\n`;
}

/**
 * One line from stdin: the key, up to the first newline or the end. Never echoed, and a
 * parse error never quotes it.
 */
export async function readKeyLine(stdin: NodeJS.ReadableStream & { isTTY?: boolean }): Promise<string> {
  if (stdin.isTTY) throw new Error("--stdin reads the key from a pipe, not a terminal; leave it off to type the key (hidden).");
  let text = "";
  for await (const chunk of stdin) {
    text += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
    if (text.includes("\n")) break;
    if (text.length > 4096) throw new Error("The key on stdin is too long; expected one line.");
  }
  const line = text.split("\n")[0]!.trim();
  if (line.length > 4096) throw new Error("The key on stdin is too long; expected one line.");
  return line;
}

export interface ServerKeysDeps {
  out: (text: string) => void;
  err: (text: string) => void;
  colors: Colors;
  /** Where `--stdin` reads the key. */
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  /** Hidden input on the server's own terminal, when `--stdin` isn't given. */
  prompter: Prompter;
  /** DL_SKIP_CREDENTIAL_CHECK=1 skips the online checks. */
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const SERVER_USAGE = "  Usage: dl keys                          which keys are set\n"
  + "         dl keys set openrouter|github    replace one (hidden input; --stdin reads it from a pipe)\n";

/**
 * `dl keys [ls]`, `dl keys set <openrouter|github> [--stdin] [--json]`, and `dl keys
 * <openrouter|github>` (the same as `set`), as root on a server.
 */
export async function serverKeysCommand(system: System, args: string[], flags: { json?: boolean; stdin?: boolean }, deps: ServerKeysDeps): Promise<number> {
  const c = deps.colors;
  const env = deps.env ?? process.env;
  const fetchImpl = env.DL_SKIP_CREDENTIAL_CHECK === "1" ? undefined : deps.fetchImpl ?? fetch;
  const [first, second] = args;
  if (first === undefined || first === "ls" || first === "list") {
    const listing = await listServerKeys(system, { fetchImpl });
    if (flags.json) deps.out(`${JSON.stringify({ keys: listing })}\n`);
    else deps.out(formatKeyListing(listing, c, "on this server", (key) => `sudo dl keys set ${key}`));
    return 0;
  }
  const which = parseKeyName(first === "set" ? second : first);
  if (!which || (first !== "set" && second !== undefined)) {
    deps.err(SERVER_USAGE);
    return 2;
  }
  try {
    let value: string;
    if (flags.stdin) value = await readKeyLine(deps.stdin);
    else if (!flags.json) value = await deps.prompter.secret(`  ${KEY_LABELS[which]} ${which === "github" ? "token" : "key"} (hidden): `);
    else throw new Error("--json needs the key on stdin: dl keys set KEY --stdin --json");
    const result = await setServerKey(system, which, value, { fetchImpl, ...(deps.sleep ? { sleep: deps.sleep } : {}) });
    if (flags.json) deps.out(`${JSON.stringify(result)}\n`);
    else deps.out(`  ${c.green("✓")} ${KEY_LABELS[which]} ${which === "github" ? "token" : "key"} replaced  ${c.dim(result.detail)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (flags.json) deps.out(`${JSON.stringify({ ok: false, key: which, error: message })}\n`);
    else deps.err(`  ${c.red("✗")} ${message}\n`);
    return 1;
  }
}

async function hotcellAnswers(system: System): Promise<boolean> {
  return (await system.probe("curl", ["-fsS", "-o", "/dev/null", `http://127.0.0.1:${HOTCELL_PORT}/`])).code === 0
    || (await system.probe("sh", ["-c", `ss -ltn | grep -q '127.0.0.1:${HOTCELL_PORT}'`])).code === 0;
}

/** Without a token the Aster API answers 401: up, and refusing strangers. */
async function autopilotAnswers(system: System): Promise<boolean> {
  return (await system.probe("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", `http://127.0.0.1:${AUTOPILOT_PORT}/api/v1/health`])).stdout.trim() === "401";
}
