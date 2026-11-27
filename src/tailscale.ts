import { hostname } from "node:os";
import { addSignedAptRepo, tailscaleRepo } from "./apt-repo.js";
import { parseOsRelease } from "./detect.js";
import type { RunResult, System } from "./system.js";

/**
 * Tailscale, as dl uses it: `tailscale serve` publishes a local port as HTTPS on this machine's
 * tailnet name, reachable only from the tailnet. dl never runs `tailscale funnel` (public).
 */

/** Where to turn on MagicDNS and HTTPS certificates (dl up, dl doctor and dl ui say the same). */
export const HTTPS_CERTS_URL = "https://login.tailscale.com/admin/dns";

/**
 * Installs Tailscale unless it's there; returns whether it installed it. `sudo` when not root.
 * Tailscale comes from its signed apt repository, with its key's fingerprint checked before apt
 * trusts it: never tailscale.com/install.sh piped to a shell. The apt steps run with a scrubbed
 * environment (vendor-script.ts): dl up's auth key and the other answers never reach them.
 */
export async function installTailscale(system: System, options: { sudo?: boolean } = {}): Promise<boolean> {
  if ((await system.probe("tailscale", ["version"])).code === 0) return false;
  const os = parseOsRelease(await system.readFile("/etc/os-release") ?? "");
  await addSignedAptRepo(system, tailscaleRepo(os), { sudo: options.sudo });
  const args = ["install", "-y", "-qq", "tailscale"];
  const runOptions = { env: { DEBIAN_FRONTEND: "noninteractive" }, inherit: true, scrubbed: true, describe: "install Tailscale (Tailscale's apt repository)" };
  if (options.sudo) await system.run("sudo", ["apt-get", ...args], runOptions);
  else await system.run("apt-get", args, runOptions);
  return true;
}

/**
 * What stands between this machine and a private HTTPS link:
 * - missing: Tailscale isn't installed;
 * - logged-out: installed, not logged in (or not connected);
 * - no-https: logged in, but the tailnet has HTTPS certificates (or MagicDNS) off, so
 *   `tailscale serve` can't give a real certificate;
 * - ready: `name` is this machine's MagicDNS name.
 */
export type TailscaleState =
  | { state: "missing" }
  | { state: "logged-out" }
  | { state: "no-https"; name?: string }
  | { state: "ready"; name: string };

/**
 * Reads `tailscale status --json`: BackendState "Running" is logged in; CertDomains lists the
 * names Tailscale can get a certificate for, and is empty while HTTPS certificates are off.
 */
export function parseTailscaleState(statusJson: string): TailscaleState {
  let status: { BackendState?: string; Self?: { DNSName?: string }; CertDomains?: string[] | null };
  try { status = JSON.parse(statusJson || "{}"); } catch { return { state: "logged-out" }; }
  if (status.BackendState !== "Running") return { state: "logged-out" };
  const name = status.Self?.DNSName?.replace(/\.$/, "") || undefined;
  if (!name || !(status.CertDomains ?? []).some((domain) => domain.replace(/\.$/, "") === name)) return { state: "no-https", ...(name ? { name } : {}) };
  return { state: "ready", name };
}

export async function tailscaleState(system: System): Promise<TailscaleState> {
  if ((await system.probe("tailscale", ["version"])).code !== 0) return { state: "missing" };
  const status = await system.probe("tailscale", ["status", "--json"]);
  // Logged out, `tailscale status --json` still prints JSON (BackendState "NeedsLogin"), but may exit 1.
  return parseTailscaleState(status.stdout);
}

/** This machine's name on the tailnet: its host name, as a DNS label. */
export function machineName(host = hostname()): string {
  return host.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "directionallylocal";
}

/** Logged in and connected. */
export async function tailscaleIsUp(system: System): Promise<boolean> {
  const status = await system.probe("tailscale", ["status", "--json"]);
  if (status.code !== 0) return false;
  try {
    return (JSON.parse(status.stdout) as { BackendState?: string }).BackendState === "Running";
  } catch {
    return false;
  }
}

/** This machine's MagicDNS name, "box.tail1234.ts.net" (no trailing dot); undefined when unreadable. */
export async function tailnetName(system: System): Promise<string | undefined> {
  const status = await system.probe("tailscale", ["status", "--json"]);
  if (status.code !== 0) return undefined;
  return parseTailnetName(status.stdout);
}

export function parseTailnetName(statusJson: string): string | undefined {
  try {
    const name = (JSON.parse(statusJson || "{}") as { Self?: { DNSName?: string } }).Self?.DNSName?.replace(/\.$/, "");
    return name || undefined;
  } catch {
    return undefined;
  }
}

/** The HTTPS link `tailscale serve --https=PORT` gives on `name`. */
export function tailnetUrl(name: string, httpsPort: number): string {
  return httpsPort === 443 ? `https://${name}` : `https://${name}:${httpsPort}`;
}

/** What `tailscale serve status --json` says about each HTTPS port: where "/" goes and whether Funnel is on. */
export interface ServedPort { proxy?: string; funnel: boolean }

export function parseServeStatus(json: string): Map<number, ServedPort> {
  const ports = new Map<number, ServedPort>();
  let value: { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>; AllowFunnel?: Record<string, boolean>; TCP?: Record<string, unknown> };
  try { value = JSON.parse(json || "{}"); } catch { return ports; }
  const portOf = (hostPort: string) => Number(hostPort.split(":").at(-1));
  for (const port of Object.keys(value.TCP ?? {})) if (Number.isInteger(Number(port))) ports.set(Number(port), { funnel: false });
  for (const [hostPort, web] of Object.entries(value.Web ?? {})) {
    const port = portOf(hostPort);
    if (!Number.isInteger(port)) continue;
    const proxy = web.Handlers?.["/"]?.Proxy;
    ports.set(port, { ...ports.get(port), funnel: false, ...(proxy ? { proxy } : {}) });
  }
  for (const [hostPort, on] of Object.entries(value.AllowFunnel ?? {})) {
    const port = portOf(hostPort);
    if (on && Number.isInteger(port)) ports.set(port, { ...(ports.get(port) ?? {}), funnel: true });
  }
  return ports;
}

export async function serveStatus(system: System): Promise<Map<number, ServedPort>> {
  const result = await system.probe("tailscale", ["serve", "status", "--json"]);
  return result.code === 0 ? parseServeStatus(result.stdout) : new Map();
}

/**
 * Serves `target` (http://127.0.0.1:PORT) as HTTPS on `httpsPort` of the tailnet name, in the
 * background. Tailscale before 1.52 has no --bg; its syntax was `serve https:PORT / TARGET`.
 */
export async function serveHttps(system: System, httpsPort: number, target: string): Promise<RunResult> {
  const served = await system.run("tailscale", ["serve", "--bg", `--https=${httpsPort}`, target], { allowFailure: true });
  if (served.code !== 0 && /flag provided but not defined: -bg|unknown flag.*bg/i.test(served.stderr)) {
    return system.run("tailscale", ["serve", `https:${httpsPort}`, "/", target], { allowFailure: true });
  }
  return served;
}

/** Stops serving `target` on `httpsPort`; leaves every other port's config alone. */
export async function stopServing(system: System, httpsPort: number, target: string): Promise<void> {
  const off = await system.run("tailscale", ["serve", `--https=${httpsPort}`, target, "off"], { allowFailure: true });
  if (off.code !== 0 && /flag provided but not defined: -https/i.test(off.stderr)) {
    await system.run("tailscale", ["serve", `https:${httpsPort}`, "/", target, "off"], { allowFailure: true });
  }
}
