/**
 * Anonymous install counts: one count per install script served (from the dl.new and
 * directionallylocal.run Workers) and one per install that finished (from install.sh itself).
 * Each body is a handful of allowlisted words; anything else is refused before storage. Only
 * per-day totals are kept: no IP address, user agent, invite code, account or device id, so
 * these counts can't be joined to people or to each other.
 */

/**
 * Where a script was served. `run` is directionallylocal.run itself: a laptop and a server get
 * the same script from the same URL (`| sh`, or `| sudo DL_MODE=server sh`), so the split between them comes
 * from the install count's `mode`. `private_invite` is dl.new/i/<code>, once it serves a script.
 */
export const DOWNLOAD_ROUTES = ["home", "invite", "private_invite", "continue", "run"] as const;
export type DownloadRoute = (typeof DOWNLOAD_ROUTES)[number];
export const DOWNLOAD_CLIENTS = ["curl", "wget", "other"] as const;
export type DownloadClient = (typeof DOWNLOAD_CLIENTS)[number];

export const INSTALL_OS = ["darwin", "linux"] as const;
export const INSTALL_ARCH = ["arm64", "x64"] as const;
export const INSTALL_MODES = ["laptop", "server"] as const;
export const INSTALL_RESULTS = ["ok", "failed"] as const;
/** Which page the install started from: DL_INSTALL_VIA, set by the dl.new scripts; `run` otherwise. */
export const INSTALL_VIA = ["home", "invite", "continue", "run"] as const;
/** The step install.sh was on when it failed (see `stage` in install.sh). */
export const INSTALL_STEPS = ["preflight", "node", "install_dl", "path", "dl_up"] as const;

/** A body bigger than this is refused unread: a real one is under 200 bytes. */
export const MAX_TELEMETRY_BYTES = 1024;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

export interface DownloadCount {
  route: DownloadRoute;
  client: DownloadClient;
}

export interface InstallCount {
  os: (typeof INSTALL_OS)[number];
  arch: (typeof INSTALL_ARCH)[number];
  mode: (typeof INSTALL_MODES)[number];
  /** x.y.z, or "unknown" when the install failed before dl was there to ask. */
  dlVersion: string;
  result: (typeof INSTALL_RESULTS)[number];
  /** "" for an install that finished, or failed without saying where. */
  failedStep: (typeof INSTALL_STEPS)[number] | "";
  via: (typeof INSTALL_VIA)[number];
}

function oneOf<T extends string>(list: readonly T[], value: unknown): T | undefined {
  return typeof value === "string" && (list as readonly string[]).includes(value) ? (value as T) : undefined;
}

function object(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
}

/** `{route, client}`, both allowlisted, or a reason it was refused. Other keys are ignored. */
export function cleanDownload(input: unknown): DownloadCount | string {
  const raw = object(input);
  if (!raw) return "Send {route, client}.";
  const route = oneOf(DOWNLOAD_ROUTES, raw.route);
  if (!route) return `route is one of ${DOWNLOAD_ROUTES.join(", ")}.`;
  const client = oneOf(DOWNLOAD_CLIENTS, raw.client);
  if (!client) return `client is one of ${DOWNLOAD_CLIENTS.join(", ")}.`;
  return { route, client };
}

/** One finished install, every field allowlisted, or a reason it was refused. Other keys are ignored. */
export function cleanInstall(input: unknown): InstallCount | string {
  const raw = object(input);
  if (!raw) return "Send {os, arch, mode, dlVersion, result, failedStep?, via}.";
  const os = oneOf(INSTALL_OS, raw.os);
  if (!os) return `os is one of ${INSTALL_OS.join(", ")}.`;
  const arch = oneOf(INSTALL_ARCH, raw.arch);
  if (!arch) return `arch is one of ${INSTALL_ARCH.join(", ")}.`;
  const mode = oneOf(INSTALL_MODES, raw.mode);
  if (!mode) return `mode is one of ${INSTALL_MODES.join(", ")}.`;
  const result = oneOf(INSTALL_RESULTS, raw.result);
  if (!result) return `result is one of ${INSTALL_RESULTS.join(", ")}.`;
  const via = oneOf(INSTALL_VIA, raw.via);
  if (!via) return `via is one of ${INSTALL_VIA.join(", ")}.`;
  let dlVersion = "unknown";
  if (raw.dlVersion !== undefined && raw.dlVersion !== "") {
    if (typeof raw.dlVersion !== "string" || !VERSION.test(raw.dlVersion)) return "dlVersion is a version like 0.13.0.";
    dlVersion = raw.dlVersion;
  }
  let failedStep: InstallCount["failedStep"] = "";
  if (raw.failedStep !== undefined && raw.failedStep !== "") {
    const step = oneOf(INSTALL_STEPS, raw.failedStep);
    if (!step) return `failedStep is one of ${INSTALL_STEPS.join(", ")}.`;
    if (result === "ok") return "failedStep goes only with result failed.";
    failedStep = step;
  }
  return { os, arch, mode, dlVersion, result, failedStep, via };
}
