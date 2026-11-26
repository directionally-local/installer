import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { homedir, platform as osPlatform } from "node:os";
import { delimiter, join } from "node:path";

/**
 * The coding agents dl knows, and finding which of them are on this computer: CLIs on PATH (and
 * the usual places installers put them when PATH doesn't have them yet), macOS app bundles in
 * /Applications and ~/Applications, Linux .desktop entries (including Flatpak and Snap exports),
 * and VS Code-family extensions (VS Code, Insiders, VSCodium, Cursor, Windsurf, Kiro, Trae, and
 * VS Code Server on a remote box). Reads directory listings only; runs nothing.
 *
 * What dl does with each, once picked (router.ts):
 *  - `dl`: a CLI dl starts itself on the person's dl key (dl claude, dl opencode, dl pi, dl t3).
 *  - `steps`: anything else that takes a custom OpenAI- or Anthropic-style endpoint: dl prints
 *    exactly where to put the key and base URL.
 *  - `noCustomModels`: agents that only use their own vendor's models (so far): dl can't route
 *    them; it says so, and tells the service which agent it was.
 */

export type LaunchCommand = "claude" | "opencode" | "pi" | "t3";

export interface AgentSpec {
  id: string;
  name: string;
  /** Executables looked up on PATH (and in COMMON_BIN_DIRS). */
  bins?: string[];
  /** More places, relative to the home directory, where this agent's installer puts its binary. */
  homeBins?: string[];
  /** macOS app bundle names, matched as prefixes ("Zed" matches "Zed Preview.app"). */
  macApps?: string[];
  /** Linux .desktop file names (lowercased, without .desktop). */
  desktop?: RegExp;
  /** VS Code-family extension ids (publisher.name, lowercased). */
  extensions?: string[];
  /** `dl <command>` starts it on dl. */
  dl?: LaunchCommand;
  /** It only uses its own vendor's models: no custom endpoint to give it. */
  noCustomModels?: boolean;
}

/** dl's own agent; never in the found list, always offered last (or first, when it was last used). */
export const AUTOPILOT_ID = "autopilot";

/**
 * Every agent dl looks for, in the order a list shows them when nothing else decides. A long
 * list on purpose: dl should never say "no coding agent found" to someone who has one.
 */
export const AGENT_CATALOG: readonly AgentSpec[] = [
  { id: "claude-code", name: "Claude Code", bins: ["claude"], homeBins: [".claude/local/claude"], extensions: ["anthropic.claude-code"], dl: "claude" },
  { id: "opencode", name: "OpenCode", bins: ["opencode"], homeBins: [".opencode/bin/opencode"], macApps: ["OpenCode"], desktop: /^(opencode|ai\.opencode\.desktop)/, dl: "opencode" },
  { id: "pi", name: "Pi", bins: ["pi"], dl: "pi" },
  { id: "t3", name: "T3 Code", bins: ["t3", "t3code"], macApps: ["T3 Code"], desktop: /^t3[-_.]?code/, dl: "t3" },
  { id: "cursor", name: "Cursor", bins: ["cursor", "cursor-agent"], homeBins: [".local/bin/cursor-agent"], macApps: ["Cursor"], desktop: /^(cursor|co\.anysphere\.cursor)/ },
  { id: "cline", name: "Cline", bins: ["cline"], extensions: ["saoudrizwan.claude-dev"] },
  { id: "zed", name: "Zed", bins: ["zed", "zeditor", "zedit"], macApps: ["Zed"], desktop: /^(zed|dev\.zed\.zed)/ },
  { id: "codex", name: "Codex CLI", bins: ["codex"], extensions: ["openai.chatgpt"] },
  { id: "aider", name: "Aider", bins: ["aider"] },
  { id: "goose", name: "Goose", bins: ["goose"], homeBins: [".local/bin/goose"], macApps: ["Goose"], desktop: /^goose/ },
  { id: "continue", name: "Continue", bins: ["cn"], extensions: ["continue.continue"] },
  { id: "roo", name: "Roo Code", extensions: ["rooveterinaryinc.roo-cline"] },
  { id: "kilo", name: "Kilo Code", bins: ["kilocode", "kilo"], extensions: ["kilocode.kilo-code"] },
  { id: "windsurf", name: "Windsurf", bins: ["windsurf"], macApps: ["Windsurf"], desktop: /^windsurf/, noCustomModels: true },
  { id: "gemini", name: "Gemini CLI", bins: ["gemini"], noCustomModels: true },
  { id: "crush", name: "Crush", bins: ["crush"] },
  { id: "amp", name: "Amp", bins: ["amp"], extensions: ["sourcegraph.amp"], noCustomModels: true },
  { id: "qwen", name: "Qwen Code", bins: ["qwen"] },
  { id: "kiro", name: "Kiro", bins: ["kiro", "kiro-cli"], macApps: ["Kiro"], desktop: /^kiro/, noCustomModels: true },
  { id: "warp", name: "Warp", bins: ["warp-terminal", "warp"], macApps: ["Warp"], desktop: /^(dev\.warp\.warp|warp-terminal)/, noCustomModels: true },
  { id: "openhands", name: "OpenHands", bins: ["openhands"] },
  { id: "copilot", name: "GitHub Copilot CLI", bins: ["copilot"], noCustomModels: true },
  { id: "droid", name: "Factory Droid", bins: ["droid"], homeBins: [".local/bin/droid"] },
  { id: "augment", name: "Augment", bins: ["auggie"], extensions: ["augment.vscode-augment"], noCustomModels: true },
  { id: "trae", name: "Trae", bins: ["trae"], macApps: ["Trae"], desktop: /^trae/ },
  { id: "void", name: "Void", bins: ["void"], macApps: ["Void"], desktop: /^void/ },
  { id: "plandex", name: "Plandex", bins: ["plandex", "pdx"] },
  { id: "kimi", name: "Kimi CLI", bins: ["kimi"] },
  { id: "jules", name: "Jules", bins: ["jules"], noCustomModels: true },
];

/** Where installers put CLIs that aren't always on PATH yet (relative to home, or absolute). */
const COMMON_BIN_DIRS = [".local/bin", "bin", ".npm-global/bin", ".bun/bin", ".cargo/bin", ".volta/bin", ".deno/bin", ".yarn/bin", "/opt/homebrew/bin", "/usr/local/bin"];

/** VS Code-family extension folders, relative to home, and what to call each editor. */
const EXTENSION_DIRS: ReadonlyArray<[string, string]> = [
  [".vscode/extensions", "VS Code"],
  [".vscode-insiders/extensions", "VS Code Insiders"],
  [".vscode-oss/extensions", "VSCodium"],
  [".vscode-server/extensions", "VS Code Server"],
  [".cursor/extensions", "Cursor"],
  [".windsurf/extensions", "Windsurf"],
  [".kiro/extensions", "Kiro"],
  [".trae/extensions", "Trae"],
];

/** Where Linux keeps .desktop entries (home-relative or absolute). */
const DESKTOP_DIRS = [
  ".local/share/applications",
  "/usr/share/applications",
  "/usr/local/share/applications",
  "/var/lib/flatpak/exports/share/applications",
  ".local/share/flatpak/exports/share/applications",
  "/var/lib/snapd/desktop/applications",
];

export interface DetectedAgent {
  id: string;
  name: string;
  /** How it was found, shortest first: "claude", "app", "VS Code extension". */
  how: string[];
  /** The CLI's path, when one was found. */
  path?: string;
  dl?: LaunchCommand;
  noCustomModels?: boolean;
}

export interface DetectDeps {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  home?: string;
  /** Whether `path` is an executable file. */
  executable?: (path: string) => Promise<boolean>;
  /** A directory's entry names; [] when it can't be read. */
  list?: (dir: string) => Promise<string[]>;
  catalog?: readonly AgentSpec[];
}

const realExecutable = (path: string) => access(path, constants.X_OK).then(() => true, () => false);
const realList = (dir: string) => readdir(dir).catch(() => [] as string[]);

/** Every catalog agent found on this computer, in catalog order. */
export async function detectAgents(deps: DetectDeps = {}): Promise<DetectedAgent[]> {
  const env = deps.env ?? process.env;
  const os = deps.platform ?? osPlatform();
  const home = deps.home ?? (env.HOME || homedir());
  const executable = deps.executable ?? realExecutable;
  const cache = new Map<string, Promise<string[]>>();
  const list = (dir: string) => {
    let entries = cache.get(dir);
    if (!entries) cache.set(dir, entries = (deps.list ?? realList)(dir));
    return entries;
  };
  const abs = (path: string) => path.startsWith("/") ? path : join(home, path);

  // nvm keeps each Node's global CLIs in its own bin; every one counts.
  const nvm = (await list(join(env.NVM_DIR || join(home, ".nvm"), "versions", "node"))).map((version) => join(env.NVM_DIR || join(home, ".nvm"), "versions", "node", version, "bin"));
  const binDirs = [...new Set([...(env.PATH ?? "").split(delimiter).filter(Boolean), ...COMMON_BIN_DIRS.map(abs), ...nvm])];
  const findBin = async (names: string[]): Promise<{ name: string; path: string } | undefined> => {
    for (const name of names) {
      for (const dir of binDirs) {
        // Only what's there: a listing per directory, then one access check for a match.
        if (!(await list(dir)).includes(name)) continue;
        const path = join(dir, name);
        if (await executable(path)) return { name, path };
      }
    }
    return undefined;
  };

  const appDirs = os === "darwin" ? ["/Applications", join(home, "Applications"), "/Applications/Setapp"] : [];
  const apps = (await Promise.all(appDirs.map(list))).flat().filter((name) => name.endsWith(".app"));
  const desktops = os === "linux" ? (await Promise.all(DESKTOP_DIRS.map((dir) => list(abs(dir))))).flat().filter((name) => name.endsWith(".desktop")).map((name) => name.slice(0, -".desktop".length).toLowerCase()) : [];
  const extensions = await Promise.all(EXTENSION_DIRS.map(async ([dir, editor]) => ({ editor, names: (await list(join(home, dir))).map((name) => name.toLowerCase()) })));

  const found: DetectedAgent[] = [];
  for (const spec of deps.catalog ?? AGENT_CATALOG) {
    const how: string[] = [];
    let path: string | undefined;
    const bin = spec.bins ? await findBin(spec.bins) : undefined;
    if (bin) {
      how.push(bin.name);
      path = bin.path;
    } else {
      for (const relative of spec.homeBins ?? []) {
        if (await executable(join(home, relative))) {
          how.push(relative.split("/").pop()!);
          path = join(home, relative);
          break;
        }
      }
    }
    if (spec.macApps?.some((prefix) => apps.some((app) => app === `${prefix}.app` || app.startsWith(`${prefix} `)))) how.push("app");
    else if (spec.desktop && desktops.some((name) => spec.desktop!.test(name))) how.push("app");
    for (const { editor, names } of extensions) {
      if (spec.extensions?.some((id) => names.some((name) => name === id || name.startsWith(`${id}-`)))) {
        const label = `${editor} extension`;
        if (!how.includes(label)) how.push(label);
      }
    }
    if (how.length === 0) continue;
    found.push({
      id: spec.id, name: spec.name, how,
      ...(path ? { path } : {}),
      ...(spec.dl && path ? { dl: spec.dl } : {}),
      ...(spec.noCustomModels ? { noCustomModels: true } : {}),
    });
  }
  return found;
}

/** A catalog agent by id, name or a CLI name ("claude", "Claude Code", "cursor-agent"…). */
export function findSpec(text: string, catalog: readonly AgentSpec[] = AGENT_CATALOG): AgentSpec | undefined {
  const key = text.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (!key) return undefined;
  return catalog.find((spec) => spec.id === key || spec.name.toLowerCase().replace(/\s+/g, "-") === key || spec.bins?.includes(key));
}
