import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { platform } from "node:os";
import { delimiter, join } from "node:path";

/**
 * The URL in canonical form when it's an absolute http(s) URL, else undefined. Anything
 * handed to the browser opener goes through this first: some URLs come from a server.
 */
export function webUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The program and arguments that open a URL on this OS. No shell is involved anywhere:
 * on Windows url.dll's FileProtocolHandler opens it, not cmd.exe's start builtin, which
 * would interpret metacharacters in the URL.
 */
export function browserCommand(url: string, os: NodeJS.Platform = platform()): [string, string[]] {
  if (os === "darwin") return ["open", [url]];
  if (os === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
}

/**
 * No browser to open here: an SSH session (SSH_CONNECTION, SSH_CLIENT or SSH_TTY), or Linux
 * (and the BSDs) with no display (neither DISPLAY nor WAYLAND_DISPLAY).
 */
export function isHeadless(env: Record<string, string | undefined> = process.env, os: NodeJS.Platform = platform()): boolean {
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return true;
  if (os === "darwin" || os === "win32") return false;
  return !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

/** Whether `name` is an executable on PATH. */
function onPath(name: string, env: Record<string, string | undefined> = process.env): boolean {
  return (env.PATH ?? "").split(delimiter).some((dir) => {
    if (!dir) return false;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Opens a URL in the laptop's browser. Returns false when that's turned off
 * (DL_NO_BROWSER=1 or BROWSER=none), there's no browser here (isHeadless), there's
 * nothing to open it with, or the URL isn't an http(s) URL, so the caller shows the
 * link instead.
 */
export function openBrowser(url: string): boolean {
  if (process.env.DL_NO_BROWSER === "1" || process.env.BROWSER === "none") return false;
  if (isHeadless()) return false;
  const safe = webUrl(url);
  if (!safe) return false;
  try {
    const [cmd, args] = browserCommand(safe);
    if (platform() !== "darwin" && platform() !== "win32" && !onPath(cmd)) return false;
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
