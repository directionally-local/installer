import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { doctor, formatChecks } from "./doctor.js";
import { TtyPrompter } from "./prompt.js";
import { readState } from "./state.js";
import { DryRunSystem, RealSystem, type System } from "./system.js";
import { uninstall } from "./uninstall.js";
import { PlainUi, TerminalUi, palette, type Ui } from "./ui.js";
import { up } from "./up.js";

const HELP = `Directionally Local: run background coding agents on this server.
(dl is short for directionallylocal; both work.)

Usage (as root):
  dl up [--dry-run]       install or repair Hotcell + Autopilot as services
  dl doctor               check every part, with a fix for each failure
  dl status               what's installed and where to reach it
  dl uninstall [--purge]  remove the services and software (--purge: also config, data, accounts)

up options:
  --dry-run                     print what would change; change nothing
  --autopilot-version <x.y.z>   default: latest on npm
  --hotcell-version <x.y.z>     default: latest on npm

Unattended installs answer the questions with environment variables:
  DL_TAILSCALE_AUTH_KEY   Tailscale auth key (tskey-…), unless this machine is already on a tailnet
  DL_OPENROUTER_API_KEY   model key, stored in Hotcell only
  DL_GITHUB_TOKEN         GitHub token for cloning, pushing, and opening PRs

Advanced:
  DL_ACCESS=loopback          don't expose the server; reach it over an SSH tunnel
  DL_SKIP_CREDENTIAL_CHECK=1  don't check the keys with OpenRouter and GitHub (offline installs)
`;

export async function main(
  argv: string[],
  io: { out: (text: string) => void; err: (text: string) => void } = {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  },
  options: { terminal?: boolean } = {},
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        "dry-run": { type: "boolean" },
        purge: { type: "boolean" },
        "autopilot-version": { type: "string" },
        "hotcell-version": { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    io.err(`${(error as Error).message}\n\n${HELP}`);
    return 2;
  }
  const [command] = parsed.positionals;
  const { values } = parsed;
  if (values.version) {
    io.out(`${packageVersion()}\n`);
    return 0;
  }
  if (values.help || !command || command === "help") {
    io.out(HELP);
    return command || values.help ? 0 : 2;
  }
  const log = (line: string) => io.out(`${line}\n`);
  // The live checklist needs a terminal; a dry run prints its plan line by line instead.
  const terminal = options.terminal ?? (process.stdout.isTTY === true);
  const live = terminal && command === "up" && !values["dry-run"];
  const ui: Ui = live ? new TerminalUi(io.out) : new PlainUi(io.out);
  const system: System = values["dry-run"] ? new DryRunSystem(log) : new RealSystem(log, live ? { outputLog: UP_LOG } : {});

  try {
    switch (command) {
      case "up":
        if (system.dryRun) log("Dry run: nothing on this machine will change.\n");
        await up(system, {
          prompter: new TtyPrompter(),
          ui,
          ...(values["autopilot-version"] ? { autopilotVersion: values["autopilot-version"] } : {}),
          ...(values["hotcell-version"] ? { hotcellVersion: values["hotcell-version"] } : {}),
        });
        return 0;
      case "doctor": {
        const checks = await doctor(system);
        log(formatChecks(checks, terminal && !process.env.NO_COLOR));
        return checks.every((check) => check.ok) ? 0 : 1;
      }
      case "status": {
        const state = await readState(system);
        if (!state) {
          log("Not installed. Run: sudo dl up");
          return 1;
        }
        log(`Installed ${state.release} (updated ${state.updatedAt.slice(0, 10)})`);
        log(`Reach it at ${state.access.url} (${state.access.mode})`);
        log(`On your laptop: autopilot remote add ${state.access.url}`);
        return 0;
      }
      case "uninstall":
        await uninstall(system, { purge: Boolean(values.purge) });
        return 0;
      default:
        io.err(`Unknown command "${command}".\n\n${HELP}`);
        return 2;
    }
  } catch (error) {
    ui.finish();
    const c = palette(live && !process.env.NO_COLOR);
    io.err(`\n  ${c.red("✗")} ${(error as Error).message.replace(/\n/g, "\n    ")}\n`);
    if (live) io.err(await logTail(UP_LOG, c));
    return 1;
  }
}

/** From package.json, which sits one level above both src/ and dist/. */
function packageVersion(): string {
  return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
}

/** Where `dl up` keeps other tools' output; shown only when something fails. */
export const UP_LOG = "/var/log/directionallylocal/up.log";

async function logTail(path: string, c: ReturnType<typeof palette>): Promise<string> {
  const text = await readFile(path, "utf8").catch(() => "");
  const lines = text.trimEnd().split("\n").filter((line) => line.trim() && !line.startsWith("#")).slice(-15);
  if (lines.length === 0) return "";
  return `\n  ${c.dim(`Last lines of ${path}:`)}\n${lines.map((line) => `    ${c.dim(line.slice(0, 200))}`).join("\n")}\n\n  Fix it and run ${c.bold("dl up")} again; it picks up where it stopped.\n`;
}
