import { parseArgs } from "node:util";
import { doctor, formatChecks } from "./doctor.js";
import { TtyPrompter } from "./prompt.js";
import { readState } from "./state.js";
import { DryRunSystem, RealSystem, type System } from "./system.js";
import { uninstall } from "./uninstall.js";
import { up } from "./up.js";

const HELP = `directionally-local: run background coding agents on this server.

Usage (as root):
  directionally-local up [--dry-run]       install or repair Hotcell + Autopilot as services
  directionally-local doctor               check every part, with a fix for each failure
  directionally-local status               what's installed and where to reach it
  directionally-local uninstall [--purge]  remove the services and software (--purge: also config, data, accounts)

up options:
  --dry-run                     print what would change; change nothing
  --autopilot-version <x.y.z>   default: latest on npm
  --hotcell-version <x.y.z>     default: latest on npm

Unattended installs answer the questions with environment variables:
  DL_TAILSCALE_AUTH_KEY   Tailscale auth key (tskey-…), unless this machine is already on a tailnet
  DL_OPENROUTER_API_KEY   model key, stored in Hotcell only
  DL_GITHUB_TOKEN         GitHub token for cloning, pushing, and opening PRs

Advanced:
  DL_ACCESS=loopback      don't expose the server; reach it over an SSH tunnel
  DL_SKIP_CREDENTIAL_CHECK=1  don't check the keys with OpenRouter and GitHub (offline installs)
`;

export async function main(argv: string[], io: { out: (text: string) => void; err: (text: string) => void } = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
}): Promise<number> {
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
      },
    });
  } catch (error) {
    io.err(`${(error as Error).message}\n\n${HELP}`);
    return 2;
  }
  const [command] = parsed.positionals;
  const { values } = parsed;
  if (values.help || !command || command === "help") {
    io.out(HELP);
    return command || values.help ? 0 : 2;
  }
  const log = (line: string) => io.out(`${line}\n`);
  const system: System = values["dry-run"] ? new DryRunSystem(log) : new RealSystem(log);

  try {
    switch (command) {
      case "up":
        if (system.dryRun) log("Dry run: nothing on this machine will change.\n");
        await up(system, {
          prompter: new TtyPrompter(),
          ...(values["autopilot-version"] ? { autopilotVersion: values["autopilot-version"] } : {}),
          ...(values["hotcell-version"] ? { hotcellVersion: values["hotcell-version"] } : {}),
        });
        return 0;
      case "doctor": {
        const checks = await doctor(system);
        log(formatChecks(checks));
        return checks.every((check) => check.ok) ? 0 : 1;
      }
      case "status": {
        const state = await readState(system);
        if (!state) {
          log("Not installed. Run: sudo directionally-local up");
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
    io.err(`\n✗ ${(error as Error).message}\n`);
    return 1;
  }
}
