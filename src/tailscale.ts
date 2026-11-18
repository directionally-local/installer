import type { RunResult, System } from "./system.js";

/**
 * Tailscale, as dl uses it: `tailscale serve` publishes a local port as HTTPS on this machine's
 * tailnet name, reachable only from the tailnet. dl never runs `tailscale funnel` (public).
 */

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
