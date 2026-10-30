import { join } from "node:path";
import type { Prompter } from "../prompt.js";
import type { Ui } from "../ui.js";

/**
 * The GitHub token a place needs, found on this laptop where possible: the GitHub CLI's
 * login is offered with a Y/n; otherwise one line says why it's needed and asks for a token
 * with hidden input. It's checked with GitHub first; being offline isn't fatal (the place
 * checks again). The model provider and its key are Autopilot's own business (connect.ts).
 */

/** What a place may still lack, as `dl up --needs` names it ("openrouter" is an older server's word for provider). */
export type Need = "provider" | "github" | "tailscale";

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

/**
 * Where `autopilot` keeps its config (and default model), newest first: `autopilot/`, then the
 * `kimiflare/` folder older Autopilot versions used.
 */
export function autopilotConfigPaths(env: NodeJS.ProcessEnv, home: string): string[] {
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  return [join(configHome, "autopilot", "config.json"), join(configHome, "kimiflare", "config.json")];
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

/** Where the keys end up, for the copy: "your server" (the default) or "this computer". */
export type KeyPlace = "your server" | "this computer";

export async function githubToken({ ui, prompter, sources, place = "your server" }: { ui: Ui; prompter: Prompter; sources: KeySources; place?: KeyPlace }): Promise<string> {
  const fromCli = (await sources.gh().catch(() => undefined))?.trim();
  if (fromCli) {
    const checked = await validateGitHubToken(fromCli, sources.fetch);
    if (checked.problem) {
      ui.warn(`Your GitHub CLI login didn't work (${checked.problem}); asking for a token instead.`);
    } else {
      const who = checked.login ? ` (${checked.login})` : "";
      if (await confirm(ui, prompter, `Use your GitHub CLI login${who}? It stays on ${place}.`)) {
        ui.answered("GitHub", `${checked.login ? `signed in as ${checked.login} · ` : ""}from the GitHub CLI`);
        return fromCli;
      }
    }
  } else {
    ui.line("info", "GitHub", `agents push branches and open pull requests through GitHub; a token stays on ${place}`);
  }
  return askUntilValid(ui, "GitHub", async () => {
    const token = await prompter.secret(ui.prompt("GitHub token", "fine-grained: github.com/settings/personal-access-tokens/new"));
    const checked = await validateGitHubToken(token, sources.fetch);
    return { value: token, ...(checked.problem ? { problem: checked.problem } : {}), ...(checked.login ? { detail: `signed in as ${checked.login}` } : {}) };
  });
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
