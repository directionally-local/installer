import { join } from "node:path";
import type { Prompter } from "../prompt.js";
import type { Ui } from "../ui.js";

/**
 * The two keys a server needs, found on this laptop where possible: the GitHub CLI's
 * login, and the OpenRouter key from the environment or Autopilot's config. Each one found
 * is offered with a Y/n; anything missing is asked for with hidden input. Every key is
 * checked with its service first; being offline isn't fatal (the server checks again).
 */

export type Need = "openrouter" | "github" | "tailscale";

export interface Answers {
  openrouterKey?: string;
  githubToken?: string;
}

/** Where keys may already be on this laptop. All injectable for tests. */
export interface KeySources {
  env: NodeJS.ProcessEnv;
  home: string;
  /** undefined when the file doesn't exist or can't be read */
  readFile: (path: string) => Promise<string | undefined>;
  /** `gh auth token`, or undefined when the GitHub CLI isn't installed or logged in */
  gh: () => Promise<string | undefined>;
  /** undefined skips the online checks */
  fetch?: typeof fetch;
}

/** Autopilot's config, where `autopilot` keeps the user's OpenRouter key. */
export function autopilotConfigPath(env: NodeJS.ProcessEnv, home: string): string {
  return join(env.XDG_CONFIG_HOME?.trim() || join(home, ".config"), "kimiflare", "config.json");
}

export async function validateOpenRouterKey(key: string, fetchImpl: typeof fetch | undefined): Promise<string | undefined> {
  if (!/^sk-or-[A-Za-z0-9_-]{10,}$/.test(key)) return "That doesn't look like an OpenRouter key (sk-or-…).";
  if (!fetchImpl) return undefined;
  try {
    const response = await fetchImpl("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` } });
    if (response.status === 401 || response.status === 403) return "OpenRouter rejected that key.";
  } catch {
    // Offline: the format is right, and the server checks it again.
  }
  return undefined;
}

export async function validateGitHubToken(token: string, fetchImpl: typeof fetch | undefined): Promise<{ problem?: string; login?: string }> {
  if (!/^(github_pat_|ghp_|gho_|ghu_)[A-Za-z0-9_]{20,}$/.test(token)) return { problem: "That doesn't look like a GitHub token (github_pat_… or ghp_…)." };
  if (!fetchImpl) return {};
  try {
    const response = await fetchImpl("https://api.github.com/user", { headers: { Authorization: `Bearer ${token}`, "User-Agent": "directionallylocal" } });
    if (response.status === 401) return { problem: "GitHub rejected that token." };
    if (response.ok) {
      const user = await response.json() as { login?: unknown };
      if (typeof user.login === "string") return { login: user.login };
    }
  } catch {
    // Offline isn't fatal.
  }
  return {};
}

/** Finds, confirms, or asks for exactly the keys in `needs`. */
export async function gatherKeys(needs: readonly Need[], input: { ui: Ui; prompter: Prompter; sources: KeySources }): Promise<Answers> {
  const { ui } = input;
  const answers: Answers = {};
  const wanted = needs.filter((need): need is "github" | "openrouter" => need === "github" || need === "openrouter");
  if (wanted.length === 0) return answers;
  ui.questions(`${wanted.length === 1 ? "1 key" : "2 keys"}, kept on your server only; then it sets itself up.`);
  if (wanted.includes("github")) answers.githubToken = await githubToken(input);
  if (wanted.includes("openrouter")) answers.openrouterKey = await openrouterKey(input);
  return answers;
}

export async function githubToken({ ui, prompter, sources }: { ui: Ui; prompter: Prompter; sources: KeySources }): Promise<string> {
  const fromCli = (await sources.gh().catch(() => undefined))?.trim();
  if (fromCli) {
    const checked = await validateGitHubToken(fromCli, sources.fetch);
    if (checked.problem) {
      ui.warn(`Your GitHub CLI login didn't work (${checked.problem}); asking for a token instead.`);
    } else {
      const who = checked.login ? ` (${checked.login})` : "";
      if (await confirm(ui, prompter, `Use your GitHub CLI login${who}? It stays on your server.`)) {
        ui.answered("GitHub", `${checked.login ? `signed in as ${checked.login} · ` : ""}from the GitHub CLI`);
        return fromCli;
      }
    }
  }
  return askUntilValid(ui, "GitHub", async () => {
    const token = await prompter.secret(ui.prompt("GitHub token", "fine-grained: github.com/settings/personal-access-tokens/new"));
    const checked = await validateGitHubToken(token, sources.fetch);
    return { value: token, ...(checked.problem ? { problem: checked.problem } : {}), ...(checked.login ? { detail: `signed in as ${checked.login}` } : {}) };
  });
}

export async function openrouterKey({ ui, prompter, sources }: { ui: Ui; prompter: Prompter; sources: KeySources }): Promise<string> {
  const candidates: Array<{ key: string; question: string; from: string }> = [];
  const fromEnv = sources.env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) candidates.push({ key: fromEnv, question: "Use the OpenRouter key in OPENROUTER_API_KEY?", from: "from OPENROUTER_API_KEY" });
  const config = await sources.readFile(autopilotConfigPath(sources.env, sources.home));
  const fromAutopilot = config ? readAutopilotKey(config) : undefined;
  if (fromAutopilot && fromAutopilot !== fromEnv) candidates.push({ key: fromAutopilot, question: "Use the OpenRouter key from Autopilot?", from: "from Autopilot" });
  for (const candidate of candidates) {
    const problem = await validateOpenRouterKey(candidate.key, sources.fetch);
    if (problem) {
      ui.warn(`The OpenRouter key ${candidate.from} didn't work (${problem})`);
      continue;
    }
    if (await confirm(ui, prompter, `${candidate.question} It stays on your server.`)) {
      ui.answered("OpenRouter", candidate.from);
      return candidate.key;
    }
  }
  return askUntilValid(ui, "OpenRouter", async () => {
    const key = await prompter.secret(ui.prompt("OpenRouter key", "openrouter.ai/keys"));
    const problem = await validateOpenRouterKey(key, sources.fetch);
    return { value: key, ...(problem ? { problem } : {}) };
  });
}

function readAutopilotKey(text: string): string | undefined {
  try {
    const value = (JSON.parse(text) as { openrouterApiKey?: unknown }).openrouterApiKey;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** A Y/n question; Enter means yes. */
export async function confirm(ui: Ui, prompter: Prompter, question: string): Promise<boolean> {
  const answer = (await prompter.text(ui.prompt(question, "Y/n"))).trim().toLowerCase();
  return answer === "" || answer === "y" || answer === "yes";
}

async function askUntilValid(ui: Ui, label: string, ask: () => Promise<{ value: string; problem?: string; detail?: string }>): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const { value, problem, detail } = await ask();
    if (!problem) {
      ui.answered(label, detail);
      return value.trim();
    }
    if (attempt >= 3) {
      ui.rejected(problem);
      throw new Error(problem);
    }
    ui.rejected(`${problem} Try again.`);
  }
}
