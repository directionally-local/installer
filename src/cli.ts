import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { doctor, formatChecks } from "./doctor.js";
import { briefStatus, connectLaptop, laptopsCommand, logsCommand, serverHome, serverRunsCommand } from "./home.js";
import { cancel, connect, describeError, laptopHome, pull, run, runs, servers, watch } from "./laptop/commands.js";
import { localCommand } from "./local/cli.js";
import { TtyPrompter } from "./prompt.js";
import { readState } from "./state.js";
import { DryRunSystem, RealSystem, type System } from "./system.js";
import { uninstall } from "./uninstall.js";
import { PlainUi, TerminalUi, palette, type Ui } from "./ui.js";
import { up } from "./up.js";

const HELP = `Directionally Local: background coding agents on your own server.
Send a task from your laptop; it runs in its own sandbox and comes back as a pull request.
(dl is short for directionallylocal; both work.)

On your laptop:
  dl connect URL          connect to your server (approve the code it shows)
  dl run "TASK"           run a task on the server, from inside a GitHub repository
                          (your uncommitted changes go along; Ctrl-C stops watching, not the task)
  dl runs                 your tasks and their pull requests
  dl watch ID             follow a task      dl cancel ID   stop one
  dl pull ID              check out a task's branch here
  dl servers              connected servers (dl servers remove NAME)
  run options: --server NAME, -m MODEL, --repo OWNER/NAME, --detach
  dl local status         agents running on this computer: running?, where, how many fit
  dl local uninstall [--purge]   stop and remove them (--purge also deletes keys and data)

On the server:
  dl                      what this is, whether it's healthy, laptops, and runs
  dl up [--dry-run]       install, or repair, everything (safe to re-run)
  dl connect-laptop       how to connect a laptop, and a link to approve it in a browser
  dl connect-laptop CODE  approve the code a laptop shows
  dl laptops              connected laptops (dl laptops remove NAME to disconnect one)
  dl runs                 tasks running or done, with their pull requests
  dl logs [hotcell|autopilot] [-f]   the services' logs
  dl doctor               check every part, with a fix for each problem
  dl uninstall [--purge]  remove everything (--purge also removes config and data)

up options:
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
        brief: { type: "boolean" },
        follow: { type: "boolean", short: "f" },
        name: { type: "string" },
        "no-open": { type: "boolean" },
        server: { type: "string" },
        model: { type: "string", short: "m" },
        repo: { type: "string" },
        detach: { type: "boolean" },
        json: { type: "boolean" },
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
  if (values.help || command === "help") {
    io.out(HELP);
    return 0;
  }
  const log = (line: string) => io.out(`${line}\n`);
  // The live checklist needs a terminal; a dry run prints its plan line by line instead.
  const terminal = options.terminal ?? (process.stdout.isTTY === true);
  const live = terminal && command === "up" && !values["dry-run"];
  const ui: Ui = live ? new TerminalUi(io.out) : new PlainUi(io.out);
  const colorOn = terminal && !process.env.NO_COLOR && process.env.TERM !== "dumb";
  const colors = palette(colorOn);
  const laptopIO = { out: io.out, err: io.err, color: colorOn };
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
      case undefined:
      case "status": {
        const state = await readState(system);
        if (!state) {
          if (values.brief) return 0;
          // A laptop connected to servers gets its own home; otherwise, what this is and how to start.
          if (!command && await laptopHome(laptopIO)) return 0;
          io.out(NOT_A_SERVER(colors));
          return command ? 1 : 0;
        }
        if (values.brief) {
          await briefStatus(system, state, io.out, colors);
          return 0;
        }
        if (!isRoot()) {
          await briefStatus(system, state, io.out, colors);
          io.out(`  ${colors.dim("For laptops and runs:")} sudo dl\n\n`);
          return 0;
        }
        await serverHome(system, state, io.out, colors);
        return 0;
      }
      case "connect": {
        const url = parsed.positionals[1];
        if (!url) {
          io.err(`  Usage: dl connect https://your-server   ${colors.dim("(the address dl up printed on the server)")}\n`);
          return 2;
        }
        await interruptible((signal) => connect({ url, signal, open: !values["no-open"], ...(values.name ? { name: values.name } : {}) }, laptopIO));
        return 0;
      }
      case "run": {
        const task = parsed.positionals.slice(1).join(" ").trim();
        if (!task) {
          io.err(`  Usage: dl run "fix the flaky checkout test"   ${colors.dim("(from inside a GitHub repository)")}\n`);
          return 2;
        }
        return await interruptible((signal) => run({
          task,
          cwd: process.cwd(),
          signal,
          detach: Boolean(values.detach),
          ...(values.server ? { server: values.server } : {}),
          ...(values.model ? { model: values.model } : {}),
          ...(values.repo ? { repository: values.repo } : {}),
        }, laptopIO));
      }
      case "watch":
      case "cancel":
      case "pull": {
        const id = parsed.positionals[1];
        if (!id) {
          io.err(`  Usage: dl ${command} ID   ${colors.dim("(from dl runs)")}\n`);
          return 2;
        }
        const server = values.server ? { server: values.server } : {};
        if (command === "watch") return await interruptible((signal) => watch({ id, signal, ...server }, laptopIO));
        if (command === "cancel") await cancel({ id, ...server }, laptopIO);
        else await pull({ id, cwd: process.cwd(), ...server }, laptopIO);
        return 0;
      }
      case "servers":
        return await servers(parsed.positionals.slice(1), laptopIO);
      case "runs":
        // On a server, its runs; on a laptop, the tasks it sent.
        if (!(await readState(system))) {
          await runs({ json: Boolean(values.json), ...(values.server ? { server: values.server } : {}) }, laptopIO);
          return 0;
        }
      // falls through
      case "connect-laptop":
      case "laptops":
      case "logs": {
        const state = await readState(system);
        if (!state) {
          io.out(NOT_A_SERVER(colors));
          return 1;
        }
        if (!isRoot()) {
          io.err(`  Run it as root: sudo dl ${parsed.positionals.join(" ")}\n`);
          return 1;
        }
        const rest = parsed.positionals.slice(1);
        if (command === "connect-laptop") return await connectLaptop(system, state, rest[0], io.out, colors);
        if (command === "laptops") return await laptopsCommand(system, rest, io.out, colors);
        if (command === "runs") return await serverRunsCommand(system, io.out, colors);
        return await logsCommand(system, [...rest, ...(values.follow ? ["-f"] : [])]);
      }
      case "local":
        return await localCommand(parsed.positionals.slice(1), { purge: Boolean(values.purge) }, io, colors, ui);
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
    io.err(`\n  ${c.red("✗")} ${describeError(error).replace(/\n/g, "\n    ")}\n`);
    if (live) io.err(await logTail(UP_LOG, c));
    return 1;
  }
}

const NOT_A_SERVER = (c: ReturnType<typeof palette>) => `
  ${c.bold("Directionally Local")}  ${c.dim("isn't set up on this machine.")}

  Background coding agents on your own server: send a task from your laptop,
  get a pull request back.

  ${c.dim("Set up a server (as root, on Ubuntu or Debian):")}
     curl -fsSL https://directionallylocal.run | sh

  ${c.dim("Already have one? Connect this laptop to it:")}
     dl connect https://your-server

`;

/** Ctrl-C aborts the command (a running task keeps going on the server). */
async function interruptible<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);
  try {
    return await work(controller.signal);
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}

function isRoot(): boolean {
  return process.getuid?.() === 0;
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
