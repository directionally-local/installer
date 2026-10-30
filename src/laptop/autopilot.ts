import { execFile } from "node:child_process";
import { constants, existsSync, readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** Finding the Autopilot dl runs for sessions and its provider picker: the one it bundles, else one on PATH. */

const execFileAsync = promisify(execFile);

/** How to start Autopilot: `command ...args <subcommand> …`. */
export interface AutopilotCommand {
  command: string;
  args: string[];
}

/** The Autopilot installed with dl (run with this Node), else an `autopilot` on PATH. */
export async function findAutopilot(): Promise<AutopilotCommand | undefined> {
  const bundled = bundledAutopilot();
  if (bundled) return { command: process.execPath, args: [bundled] };
  const onPath = await autopilotOnPath();
  return onPath ? { command: onPath, args: [] } : undefined;
}

/**
 * autopilot-ai's bin script, found from where Node resolves the package for dl. Its exports
 * don't include package.json, so the entry point is resolved and its package root found above it.
 */
export function bundledAutopilot(resolve: (specifier: string) => string = (specifier) => import.meta.resolve(specifier)): string | undefined {
  for (const specifier of ["autopilot-ai/package.json", "autopilot-ai"]) {
    let dir: string;
    try {
      dir = dirname(fileURLToPath(resolve(specifier)));
    } catch {
      continue;
    }
    for (;;) {
      const manifest = join(dir, "package.json");
      if (existsSync(manifest)) {
        try {
          const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown; bin?: unknown };
          if (pkg.name === "autopilot-ai") {
            const bin = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin as Record<string, unknown> | undefined)?.autopilot;
            const path = typeof bin === "string" ? resolvePath(dir, bin) : undefined;
            return path && existsSync(path) ? path : undefined;
          }
        } catch {
          // not a readable manifest; keep looking up
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

/** The bundled Autopilot's version, from its manifest; undefined when it isn't installed. */
export function bundledAutopilotVersion(resolve?: (specifier: string) => string): string | undefined {
  const bin = bundledAutopilot(resolve);
  if (!bin) return undefined;
  for (let dir = dirname(bin); ; dir = dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown; version?: unknown };
        if (pkg.name === "autopilot-ai") return typeof pkg.version === "string" ? pkg.version : undefined;
      } catch {
        // keep looking up
      }
    }
    if (dirname(dir) === dir) return undefined;
  }
}

export async function autopilotOnPath(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, "autopilot");
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
  }
  return undefined;
}

/** An Autopilot that knows `attach-remote` lists its options (an older one prints its general help). */
export async function supportsAttachRemote(autopilot: AutopilotCommand): Promise<boolean> {
  try {
    const { stdout, stderr } = await execFileAsync(autopilot.command, [...autopilot.args, "attach-remote", "--help"], {
      timeout: 30_000,
      env: { ...process.env, NO_COLOR: "1" },
    });
    return `${stdout}${stderr}`.includes("--state-file");
  } catch {
    return false;
  }
}
