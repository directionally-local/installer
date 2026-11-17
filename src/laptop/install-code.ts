import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The one-time code from a personal install command on dl.new (`curl -fsSL https://dl.new/i/<code> | sh`).
 *
 * The command's script exports DL_INSTALL_CODE=<code> for the install script, which passes it to
 * dl (and keeps it in ~/.config/directionallylocal/pending-install-code when dl isn't started
 * there), and dl passes it to plain Autopilot, which trades it once with the free tier for a
 * sign-in (Autopilot's src/providers/dl-install-code.ts). The code works once, so dl hands it on
 * once: the kept file is deleted as soon as it's read. A used or expired code makes Autopilot fall
 * back to its normal GitHub sign-in.
 *
 * Nothing here fails a session, and the code is never printed.
 */

export const INSTALL_CODE_ENV = "DL_INSTALL_CODE";
const CODE = /^[A-Za-z0-9_-]{22,64}$/;

type Env = Record<string, string | undefined>;

/** The code as dl.new issues it, or undefined for anything else. */
export function normalizeInstallCode(raw: string | undefined): string | undefined {
  const code = raw?.trim();
  return code && CODE.test(code) ? code : undefined;
}

/** Where the install script keeps the code for dl's next start: next to dl's config. */
export function pendingInstallCodePath(env: Env = process.env): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(env.HOME || homedir(), ".config");
  return join(configHome, "directionallylocal", "pending-install-code");
}

/**
 * The code to give Autopilot on this start: DL_INSTALL_CODE, else the one the install script
 * kept. Either way the kept one is deleted, so it is handed on once.
 */
export async function installCodeForAutopilot(options: { env?: Env; path?: string } = {}): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const path = options.path ?? pendingInstallCodePath(env);
  const fromEnv = normalizeInstallCode(env[INSTALL_CODE_ENV]);
  const kept = normalizeInstallCode(await readFile(path, "utf8").catch(() => undefined));
  await rm(path, { force: true }).catch(() => {});
  return fromEnv ?? kept;
}

/** The environment for plain Autopilot: DL_INSTALL_CODE set to the code, or removed when there's none. */
export function withInstallCode(env: NodeJS.ProcessEnv, code: string | undefined): NodeJS.ProcessEnv {
  const { [INSTALL_CODE_ENV]: _dropped, ...rest } = env;
  return code ? { ...rest, [INSTALL_CODE_ENV]: code } : rest;
}
