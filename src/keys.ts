/**
 * `dl keys` on a server: replace the model provider's key or the GitHub token where `dl up`
 * stored them, restart the one service that reads it, and show which keys are set (never
 * their values). Keys come in on stdin (or hidden input on the server's own terminal),
 * never argv, so they stay out of `ps`, shell history, and logs.
 *
 *   provider  Hotcell's file keystore, as the hotcell user, + aster.json  → restart hotcell.service (+ autopilot.service)
 *   GitHub    /etc/autopilot/github.env (0640 root:autopilot)              → restart autopilot.service
 *
 * `dl keys set <provider-id>` takes any provider Hotcell has a route for (deepseek, openai,
 * ollama, …); a custom one needs `--base-url`. The laptop's `dl provider` sends a whole
 * provider block through `dl up --answers-stdin` instead, since it carries what Autopilot's picker chose.
 */
import { AUTOPILOT_PORT, HOTCELL_PORT, PATHS, SERVICES, USERS, asterConfigDefaults, githubEnv, hotcellBin, parseEnvFile } from "./layout.js";
import type { Prompter } from "./prompt.js";
import {
  asterConfigWithProvider, hotcellKeysAddArgs, isKeyless, KNOWN_PROVIDERS, PROVIDER_ID_RE, parseProviderAnswer, providerConfig,
  providerFromAsterConfig, type ProviderAnswer,
} from "./provider.js";
import type { System } from "./system.js";
import type { palette } from "./ui.js";
import { asHotcell, hotcellRoutes, validateGitHubToken, validateProviderKey, waitUntil, type Checked } from "./up.js";

/** "github", or a provider id ("openrouter", "deepseek", …). */
export type KeyName = string;
export const GITHUB: KeyName = "github";
/** The row names of `dl keys`: the model provider (whichever it is) and GitHub. */
export type KeyRow = "provider" | "github";

export function keyLabel(which: KeyName): string {
  if (which === GITHUB) return "GitHub";
  return KNOWN_PROVIDERS[which]?.name ?? which;
}

/** What `dl keys set … --json` prints: one line. */
export interface KeyResult {
  ok: true;
  key: KeyName;
  detail: string;
}

/** One row of `dl keys`: whether it's set, and something to recognise it by (never the value). */
export interface KeyListing {
  key: KeyRow;
  set: boolean;
  /** provider: its id and Hotcell's mask (deepseek · sk-…ab). GitHub: "signed in as LOGIN" when GitHub answered. */
  detail?: string;
  /** The stored key doesn't work (e.g. GitHub rejected the token). */
  problem?: string;
}

type Colors = ReturnType<typeof palette>;

/** "github", or a provider id; undefined for anything else. */
export function parseKeyName(value: string | undefined): KeyName | undefined {
  const name = value?.trim().toLowerCase();
  if (!name) return undefined;
  if (name === GITHUB) return GITHUB;
  return PROVIDER_ID_RE.test(name) ? name : undefined;
}

/** Format first, then (with `fetchImpl`) the service itself; offline isn't fatal. */
export async function checkKey(which: KeyName, value: string, fetchImpl: typeof fetch | undefined): Promise<Checked> {
  if (which === GITHUB) return value ? validateGitHubToken(value, fetchImpl) : { problem: "No key was given." };
  if (!value && !isKeyless({ id: which, apiKey: null })) return { problem: "No key was given." };
  const checked = await validateProviderKey({ id: which, apiKey: value || null }, value, fetchImpl);
  return checked.problem ? { problem: checked.problem } : {};
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
  /** A custom provider's address (`--base-url`), and its auth shape when unusual. */
  baseUrl?: string;
  authHeader?: string;
  authFormat?: string;
}

/** Stores the key exactly where `dl up` does, then restarts the service that reads it and waits for it. */
export async function setServerKey(system: System, which: KeyName, value: string, options: ServerKeyOptions = {}): Promise<KeyResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const key = value.trim();
  const checked = await checkKey(which, key, options.fetchImpl);
  if (checked.problem) throw new KeyRejectedError(checked.problem);

  if (which !== GITHUB) {
    if (!KNOWN_PROVIDERS[which] && !options.baseUrl) throw new KeyRejectedError(`dl doesn't know where ${which} lives; add --base-url URL (and --auth-header / --auth-format if it isn't Bearer).`);
    const provider = parseProviderAnswer({
      id: which,
      ...(key ? { apiKey: key } : {}),
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      ...(options.authHeader ? { authHeader: options.authHeader } : {}),
      ...(options.authFormat ? { authFormat: options.authFormat } : {}),
    });
    return setServerProvider(system, provider, sleep);
  }

  await system.mkdir(PATHS.autopilotEtc, { mode: 0o750, owner: `root:${USERS.autopilot}` });
  await system.writeFile(PATHS.githubEnv, githubEnv(key), { mode: 0o640, owner: `root:${USERS.autopilot}`, secret: true });
  // Autopilot reads GITHUB_TOKEN from its env file at startup.
  await system.run("systemctl", ["restart", SERVICES.autopilot]);
  await waitUntil(system, sleep, "Autopilot", () => autopilotAnswers(system));
  return { ok: true, key: which, detail: `${checked.detail ? `${checked.detail}; ` : ""}Autopilot restarted` };
}

/**
 * The provider's key into Hotcell's keystore (over stdin), the provider into aster.json, and
 * both services restarted: Hotcell reads its keystore and Autopilot its config at startup.
 */
export async function setServerProvider(system: System, provider: ProviderAnswer, sleep: (ms: number) => Promise<void>): Promise<KeyResult> {
  if (!(await system.exists(hotcellBin()))) throw new Error("Hotcell isn't installed here; run dl up first.");
  const args = hotcellKeysAddArgs(provider);
  await asHotcell(system, args, { ...(provider.apiKey ? { input: provider.apiKey } : {}), describe: `hotcell ${args.join(" ")} (as hotcell)` });
  await system.mkdir(PATHS.autopilotEtc, { mode: 0o750, owner: `root:${USERS.autopilot}` });
  await system.writeFile(PATHS.asterConfig, asterConfigWithProvider(await system.readFile(PATHS.asterConfig), providerConfig(provider), asterConfigDefaults()), { mode: 0o640, owner: `root:${USERS.autopilot}` });
  await system.run("systemctl", ["restart", SERVICES.hotcell]);
  await waitUntil(system, sleep, "Hotcell", () => hotcellAnswers(system));
  await system.run("systemctl", ["restart", SERVICES.autopilot]);
  await waitUntil(system, sleep, "Autopilot", () => autopilotAnswers(system));
  return { ok: true, key: provider.id, detail: `${provider.id} in Hotcell; Hotcell and Autopilot restarted` };
}

/** Which keys this server has. Reads and probes only; the GitHub login is a quick, optional API call. */
export async function listServerKeys(system: System, options: { fetchImpl?: typeof fetch } = {}): Promise<KeyListing[]> {
  const provider = providerFromAsterConfig(await system.readFile(PATHS.asterConfig));
  const route = (await hotcellRoutes(system)).find((entry) => entry.provider === provider.id);
  const listing: KeyListing = route?.active
    ? { key: "provider", set: true, detail: route.mask ? `${provider.id} · ${route.mask}` : provider.id }
    : { key: "provider", set: false, ...(route ? { detail: provider.id, problem: `${provider.id}'s route is off in Hotcell` } : {}) };
  const token = parseEnvFile(await system.readFile(PATHS.githubEnv)).GITHUB_TOKEN;
  return [listing, await githubListing(token, options.fetchImpl)];
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
export function formatKeyListing(listing: KeyListing[], c: Colors, where: string, replaceWith: (key: KeyRow) => string): string {
  const rows = listing.map((entry) => {
    const label = (entry.key === "github" ? "GitHub" : "Provider").padEnd(12);
    if (!entry.set) return `  ${c.red("✗")} ${label}${entry.problem ?? c.dim("not set")}   ${replaceWith(entry.key)}\n`;
    if (entry.problem) return `  ${c.red("✗")} ${label}${entry.problem}   ${c.dim("replace it:")} ${replaceWith(entry.key)}\n`;
    return `  ${c.green("✓")} ${label}${c.dim(entry.detail ?? "set")}\n`;
  });
  const hint = listing.every((entry) => entry.set && !entry.problem)
    ? `\n  ${c.dim("Replace one:")} ${replaceWith("provider")}   ${c.dim("or")}   ${replaceWith("github")}\n`
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

const SERVER_USAGE = "  Usage: dl keys                                which keys are set\n"
  + "         dl keys set <provider>|github          replace one (hidden input; --stdin reads it from a pipe)\n"
  + "                 <provider>: openrouter, deepseek, openai, ollama, … (any Autopilot provider id)\n"
  + "                 a custom one: dl keys set NAME --base-url URL [--auth-header H --auth-format F]\n";

/**
 * `dl keys [ls]`, `dl keys set <provider|github> [--stdin] [--json]`, and `dl keys
 * <provider|github>` (the same as `set`), as root on a server.
 */
export async function serverKeysCommand(
  system: System,
  args: string[],
  flags: { json?: boolean; stdin?: boolean; baseUrl?: string; authHeader?: string; authFormat?: string },
  deps: ServerKeysDeps,
): Promise<number> {
  const c = deps.colors;
  const env = deps.env ?? process.env;
  const fetchImpl = env.DL_SKIP_CREDENTIAL_CHECK === "1" ? undefined : deps.fetchImpl ?? fetch;
  const [first, second] = args;
  if (first === undefined || first === "ls" || first === "list") {
    const listing = await listServerKeys(system, { fetchImpl });
    if (flags.json) deps.out(`${JSON.stringify({ keys: listing })}\n`);
    else {
      const providerId = providerFromAsterConfig(await system.readFile(PATHS.asterConfig)).id;
      deps.out(formatKeyListing(listing, c, "on this server", (key) => `sudo dl keys set ${key === "provider" ? providerId : key}`));
    }
    return 0;
  }
  const which = parseKeyName(first === "set" ? second : first);
  if (!which || (first !== "set" && second !== undefined)) {
    deps.err(SERVER_USAGE);
    return 2;
  }
  const noun = which === GITHUB ? "token" : "key";
  try {
    let value: string;
    const keyless = which !== GITHUB && isKeyless({ id: which, apiKey: null });
    if (keyless) value = "";
    else if (flags.stdin) value = await readKeyLine(deps.stdin);
    else if (!flags.json) value = await deps.prompter.secret(`  ${keyLabel(which)} ${noun} (hidden): `);
    else throw new Error("--json needs the key on stdin: dl keys set KEY --stdin --json");
    const result = await setServerKey(system, which, value, {
      fetchImpl,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(flags.baseUrl ? { baseUrl: flags.baseUrl } : {}),
      ...(flags.authHeader ? { authHeader: flags.authHeader } : {}),
      ...(flags.authFormat ? { authFormat: flags.authFormat } : {}),
    });
    if (flags.json) deps.out(`${JSON.stringify(result)}\n`);
    else deps.out(`  ${c.green("✓")} ${keyLabel(which)} ${noun} replaced  ${c.dim(result.detail)}\n`);
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
