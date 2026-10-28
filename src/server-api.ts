import { PATHS, USERS, autopilotBin } from "./layout.js";
import type { RunResult, System } from "./system.js";

/**
 * Autopilot's server-side commands, run as the autopilot account against the same
 * config and database as the service. `dl` reads laptops and runs through these, never
 * through Autopilot's database directly.
 */
export function autopilotServer(system: System, args: string[], options: { secretOutput?: boolean; describe?: string } = {}): Promise<RunResult> {
  return system.run("runuser", [
    "-u", USERS.autopilot, "--", "env", `HOME=${PATHS.autopilotHome}`, `AUTOPILOT_ASTER_CONFIG=${PATHS.asterConfig}`,
    `AUTOPILOT_ASTER_DB=${PATHS.autopilotHome}/aster.db`, "/usr/bin/node", autopilotBin(), ...args,
  ], { allowFailure: true, describe: options.describe ?? `autopilot ${args.join(" ")} (as autopilot)`, ...(options.secretOutput ? { secretOutput: true } : {}) });
}

export interface Laptop {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ServerRun {
  conversationId: string;
  status: string;
  active: boolean;
  repository: string | null;
  branch: string | null;
  pullRequestURL: string | null;
  startedBy: string | null;
  createdAt: string;
}

/** Paired laptops and apps: active credentials that aren't owner browsers. Undefined if Autopilot can't say. */
export async function listLaptops(system: System): Promise<Laptop[] | undefined> {
  const result = await autopilotServer(system, ["aster", "token", "list", "--json"]);
  const parsed = parseJson<Array<Laptop & { status: string; scopes: string[] }>>(result);
  return parsed?.filter((entry) => entry.status === "active" && !entry.scopes.includes("pairing:approve"));
}

export async function listServerRuns(system: System, limit = 200): Promise<ServerRun[] | undefined> {
  return parseJson<ServerRun[]>(await autopilotServer(system, ["aster", "runs", "--json", "--limit", String(limit)]));
}

/** Pairing codes waiting for approval, e.g. "BCDF-GHJK  MacBook (autopilot)". */
export async function pendingPairings(system: System): Promise<Array<{ code: string; name: string }>> {
  const result = await autopilotServer(system, ["aster", "pair", "list"]);
  if (result.code !== 0) return [];
  return result.stdout.split("\n").flatMap((line) => {
    const match = line.match(/^([A-Z]{4}-[A-Z]{4})\s+(.+?)\s+expires\s/);
    return match ? [{ code: match[1]!, name: match[2]! }] : [];
  });
}

export async function approvePairing(system: System, code: string): Promise<{ ok: boolean; message: string }> {
  const result = await autopilotServer(system, ["aster", "pair", "approve", code]);
  return { ok: result.code === 0, message: (result.code === 0 ? result.stdout : result.stderr || result.stdout).trim() };
}

export async function revokeLaptop(system: System, id: string): Promise<boolean> {
  return (await autopilotServer(system, ["aster", "token", "revoke", id])).code === 0;
}

/** A fresh one-time link that makes the browser opening it able to approve laptops. */
export async function ownerLink(system: System, url: string): Promise<string | undefined> {
  const result = await autopilotServer(system, ["aster", "owner", "link", "--url", url], { secretOutput: true, describe: "autopilot aster owner link (as autopilot)" });
  const link = result.stdout.trim().split("\n").at(-1);
  return result.code === 0 && link?.startsWith("http") ? link : undefined;
}

/** A client credential for one laptop, as `dl pair --json` prints it. */
export interface PairedLaptop {
  token: string;
  credentialId: string;
  name: string;
  /** ISO 8601. */
  expiresAt: string;
  /** The server's address from the install state, which the laptop reaches through its tunnel. */
  url: string;
}

/** How long a laptop's credential lasts; re-running the laptop's setup pairs it again. */
export const LAPTOP_CREDENTIAL_DAYS = 90;

/**
 * Creates a credential for a laptop that set this server up over SSH, so it never has to
 * show a code and wait for approval: being root here already proves it's the owner's.
 * The token comes back in the command's output, so that output stays out of the log.
 */
export async function createLaptopCredential(system: System, name: string, url: string): Promise<PairedLaptop> {
  const result = await autopilotServer(system, [
    "aster", "token", "create", "--name", name, "--workspace", "default", "--expires-in-days", String(LAPTOP_CREDENTIAL_DAYS), "--json",
  ], { secretOutput: true });
  if (result.code !== 0) {
    throw new Error(`Couldn't create a credential for the laptop${result.stderr.trim() ? `: ${result.stderr.trim().split("\n").slice(-3).join(" ")}` : ""}; run dl up to update this server.`);
  }
  const created = parseJson<{ credentialId?: unknown; expiresAt?: unknown; token?: unknown }>(result);
  const { credentialId, expiresAt, token } = created ?? {};
  // Never echo the output when it doesn't parse: it may hold the token.
  if (typeof token !== "string" || !token || typeof credentialId !== "string" || typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    throw new Error("Autopilot created a credential but its answer wasn't what dl expects; run dl up to update this server.");
  }
  return { token, credentialId, name, expiresAt: new Date(expiresAt).toISOString(), url };
}

function parseJson<T>(result: RunResult): T | undefined {
  if (result.code !== 0) return undefined;
  try {
    return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "") as T;
  } catch {
    return undefined;
  }
}
