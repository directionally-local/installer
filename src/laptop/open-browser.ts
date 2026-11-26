import { spawn } from "node:child_process";
import { platform } from "node:os";

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
 * Opens a URL in the laptop's browser. Returns false when that's turned off
 * (DL_NO_BROWSER=1 or BROWSER=none), impossible, or the URL isn't an http(s) URL,
 * so the caller shows the link instead.
 */
export function openBrowser(url: string): boolean {
  if (process.env.DL_NO_BROWSER === "1" || process.env.BROWSER === "none") return false;
  const safe = webUrl(url);
  if (!safe) return false;
  try {
    const [cmd, args] = browserCommand(safe);
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
