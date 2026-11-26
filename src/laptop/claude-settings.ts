import { readFile as fsReadFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Credentials in Claude Code's own settings files, checked (read only) before dl starts Claude
 * Code. dl leaves the person's ANTHROPIC_API_KEY and similar variables out of Claude Code's
 * environment, but a settings file's `env` block or `apiKeyHelper` wins over the environment
 * dl gives it. With dl's base URL in place, that key would go to dl's free tier (or this box's
 * model) instead of to Anthropic. So dl refuses to start and says which file and setting; it
 * never prints the value. DL_ALLOW_CLAUDE_SETTINGS_KEY=1 starts anyway.
 */

/** The settings that carry a credential Claude Code would send. */
export const SETTINGS_ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const;
export const ALLOW_SETTINGS_KEY_ENV = "DL_ALLOW_CLAUDE_SETTINGS_KEY";

type Env = Record<string, string | undefined>;

export interface SettingsKey {
  /** The file, with the home folder shown as ~. */
  file: string;
  /** `env.ANTHROPIC_API_KEY` or `apiKeyHelper`. */
  setting: string;
}

export interface SettingsCheckInput {
  env: Env;
  /** The folder Claude Code starts in, for its project settings. */
  cwd: string;
  readFile?: (path: string) => Promise<string>;
}

/** The settings files Claude Code reads that dl checks: user (~/.claude or CLAUDE_CONFIG_DIR) and this folder's project ones. */
export function claudeSettingsFiles(env: Env, cwd: string): string[] {
  const home = env.HOME || homedir();
  const files = [join(home, ".claude", "settings.json")];
  if (env.CLAUDE_CONFIG_DIR) files.push(join(resolve(cwd, env.CLAUDE_CONFIG_DIR), "settings.json"));
  files.push(join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json"));
  return [...new Set(files.map((file) => resolve(file)))];
}

function present(value: unknown): boolean {
  if (typeof value === "string") return value.trim() !== "";
  return value !== undefined && value !== null && value !== false;
}

/** Every credential setting in those files. A missing, unreadable or invalid file has none. */
export async function claudeSettingsKeys(input: SettingsCheckInput): Promise<SettingsKey[]> {
  const read = input.readFile ?? ((path: string) => fsReadFile(path, "utf8"));
  const home = input.env.HOME || homedir();
  const found: SettingsKey[] = [];
  for (const path of claudeSettingsFiles(input.env, input.cwd)) {
    let settings: unknown;
    try {
      settings = JSON.parse(await read(path));
    } catch {
      continue;
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) continue;
    const file = path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
    const { env, apiKeyHelper } = settings as { env?: unknown; apiKeyHelper?: unknown };
    if (env && typeof env === "object" && !Array.isArray(env)) {
      for (const name of SETTINGS_ENV_KEYS) {
        if (present((env as Record<string, unknown>)[name])) found.push({ file, setting: `env.${name}` });
      }
    }
    if (present(apiKeyHelper)) found.push({ file, setting: "apiKeyHelper" });
  }
  return found;
}

function allowed(env: Env): boolean {
  const value = env[ALLOW_SETTINGS_KEY_ENV];
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

/**
 * Why `command` won't start Claude Code, or undefined when no settings file holds a credential
 * (or DL_ALLOW_CLAUDE_SETTINGS_KEY is set). `destination` says where the key would go.
 */
export async function claudeSettingsRefusal(command: string, destination: string, input: SettingsCheckInput): Promise<string | undefined> {
  if (allowed(input.env)) return undefined;
  const found = await claudeSettingsKeys(input);
  if (found.length === 0) return undefined;
  const lines = found.map((one) => `    ${one.file}: ${one.setting}`).join("\n");
  return (
    `${command} won't start Claude Code: its settings set a credential that would win over dl's and be sent to ${destination}:\n` +
    `${lines}\n` +
    `  Remove ${found.length === 1 ? "it" : "them"} from ${new Set(found.map((one) => one.file)).size === 1 ? "that file" : "those files"} to use ${command}. ` +
    `To start anyway, set ${ALLOW_SETTINGS_KEY_ENV}=1.`
  );
}
