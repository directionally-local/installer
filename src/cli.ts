import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { doctor, formatChecks } from "./doctor.js";
import { serverKeysCommand } from "./keys.js";
import { briefStatus, connectLaptop, laptopsCommand, logsCommand, pairLaptop, serverHome, serverRunsCommand } from "./home.js";
import { cancel, connect, describeError, laptopHome, pull, run, runs, servers, use, watch } from "./laptop/commands.js";
import { loadRemotes } from "./laptop/config.js";
import { keys } from "./laptop/keys.js";
import { model } from "./laptop/settings.js";
import { projectSession } from "./laptop/session.js";
import { setup } from "./laptop/setup.js";
import { localCommand } from "./local/cli.js";
import { setUpOnThisComputer } from "./local/setup.js";
import { TtyPrompter } from "./prompt.js";
import { readState } from "./state.js";
import { DryRunSystem, RealSystem, type System } from "./system.js";
import { uninstall } from "./uninstall.js";
import { JsonUi, PlainUi, TerminalUi, palette, type Ui } from "./ui.js";
import { needs, parseAccessMode, parseProvidedAnswers, up } from "./up.js";

const HELP = `Directionally Local: coding agents that run on this computer or on your own server.
Send a task; it runs in its own sandbox and comes back as a pull request.
(dl is short for directionallylocal; both work.)

On your laptop:
  dl                      set up the first time; afterwards, an overview
  dl setup                set up or repair where your agents run (safe to re-run)
  dl  (in a GitHub repo)  talk to the repository's agent; it keeps running when you leave
  dl new                  in a GitHub repo: start a fresh conversation for it
  dl status               where your agents run and what they're doing (works anywhere)
  dl connect URL          connect to a server someone else set up (approve the code it shows)
  dl run "TASK"           run a task, from inside a GitHub repository
                          (your uncommitted changes go along; Ctrl-C stops watching, not the task)
  dl runs                 your tasks and their pull requests
  dl watch ID             follow a task      dl cancel ID   stop one
  dl pull ID              check out a task's branch here
  dl servers              where agents run (dl servers remove NAME · dl servers rename OLD NEW)
  dl use [NAME]           where tasks go without --server (no NAME: show it)
  dl keys [openrouter|github]   which keys are set, or replace one (--server NAME)
  dl model [ID]           the model for tasks and sessions (no ID: pick from a list)
  run options: --server NAME, -m/--model MODEL, --repo OWNER/NAME, --detach
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
  dl keys [set openrouter|github]   which keys are set, or replace one (hidden input)
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
                              (or --access tailscale|loopback|ssh; ssh is the laptop's setup)
  DL_SKIP_CREDENTIAL_CHECK=1  don't check the keys with OpenRouter and GitHub (offline installs)

Used by the laptop's setup (over SSH, as root):
  dl up --access ssh --answers-stdin --events json
                              install with the keys as one JSON object on stdin; progress as JSON lines
  dl up --needs [--access ssh]   which keys dl up would still need, as JSON; changes nothing
  dl pair --name NAME --json     a credential for that laptop, as JSON
  dl keys set openrouter|github --stdin --json   replace a key read from stdin
`;

export async function main(
  argv: string[],
  io: { out: (text: string) => void; err: (text: string) => void } = {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  },
  options: { terminal?: boolean; stdin?: NodeJS.ReadableStream & { isTTY?: boolean } } = {},
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
        access: { type: "string" },
        "answers-stdin": { type: "boolean" },
        events: { type: "string" },
        needs: { type: "boolean" },
        identity: { type: "string" },
        stdin: { type: "boolean" },
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
  if (values.events !== undefined && values.events !== "json") {
    io.err(`--events takes json (got "${values.events}").\n\n${HELP}`);
    return 2;
  }
  let access;
  try {
    access = values.access === undefined ? undefined : parseAccessMode(values.access);
  } catch (error) {
    io.err(`${(error as Error).message}\n`);
    return 2;
  }
  // `--events json`: stdout carries only the laptop's JSON events; everything else goes to
  // stderr, and other tools' output to the install log, as with the live checklist.
  const json = command === "up" && values.events === "json" && !values.needs;
  const log = (line: string) => (json ? io.err : io.out)(`${line}\n`);
  // The live checklist needs a terminal; a dry run prints its plan line by line instead.
  const terminal = options.terminal ?? (process.stdout.isTTY === true);
  // --needs only looks: it mustn't even start a new install log.
  const live = terminal && command === "up" && !values["dry-run"] && !values.needs && !json;
  const jsonUi = json ? new JsonUi(io.out) : undefined;
  const ui: Ui = jsonUi ?? (live ? new TerminalUi(io.out) : new PlainUi(io.out));
  const colorOn = terminal && !json && !process.env.NO_COLOR && process.env.TERM !== "dumb";
  const colors = palette(colorOn);
  const laptopIO = { out: io.out, err: io.err, color: colorOn };
  const logged = (live || json) && !values["dry-run"];
  let system: System;
  try {
    system = values["dry-run"] ? new DryRunSystem(log) : new RealSystem(log, logged ? { outputLog: UP_LOG } : {});
  } catch (error) {
    // Opening the install log is the first write, so this is where a non-root `up` stops.
    const message = `Couldn't open ${UP_LOG}: ${describeError(error)}. Run it as root: sudo dl up`;
    if (jsonUi) jsonUi.error(message);
    else io.err(`\n  ${palette(live && !process.env.NO_COLOR).red("✗")} ${message}\n`);
    return 1;
  }

  try {
    switch (command) {
      case "up": {
        if (values.needs) {
          io.out(`${JSON.stringify({ needs: await needs(system, access ? { access } : {}) })}\n`);
          return 0;
        }
        // Read before anything else happens, so a bad answer fails before any change.
        const answers = values["answers-stdin"] ? parseProvidedAnswers(await readAnswers(options.stdin ?? process.stdin)) : undefined;
        if (system.dryRun) log("Dry run: nothing on this machine will change.\n");
        await up(system, {
          prompter: new TtyPrompter(),
          ui,
          ...(access ? { access } : {}),
          ...(answers ? { answers } : {}),
          ...(values["autopilot-version"] ? { autopilotVersion: values["autopilot-version"] } : {}),
          ...(values["hotcell-version"] ? { hotcellVersion: values["hotcell-version"] } : {}),
        });
        return 0;
      }
      case "pair": {
        // Only the laptop's setup runs this, and it reads the JSON; there's no human form.
        if (!values.json || !values.name?.trim()) {
          io.err(`  Usage: dl pair --name NAME --json   ${colors.dim("(run by the laptop's setup, over SSH)")}\n`);
          return 2;
        }
        const state = await readState(system);
        if (!state) {
          io.err("  Directionally Local isn't installed on this server yet; run dl up first.\n");
          return 1;
        }
        if (!isRoot()) {
          io.err("  Run it as root: sudo dl pair --name NAME --json\n");
          return 1;
        }
        await pairLaptop(system, state, values.name, io.out);
        return 0;
      }
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
          // Inside a GitHub repository, that repository's conversation; elsewhere, the laptop's home.
          if (!command && terminal && (await loadRemotes()).length > 0) {
            const code = await projectSession({ cwd: process.cwd(), ...(values.server ? { server: values.server } : {}), ...(values.model ? { model: values.model } : {}) }, laptopIO);
            if (code !== undefined) return code;
          }
          // A laptop connected to servers gets its own home (`dl status` shows it from anywhere);
          // otherwise, what this is and how to start.
          if ((!command || command === "status") && await laptopHome(laptopIO)) return 0;
          // A laptop with nothing set up yet: the wizard (it needs someone to answer it).
          if (!command && terminal && !isRoot() && (await loadRemotes()).length === 0) return await setup({ io: laptopIO, terminal, localSetup: (input) => setUpOnThisComputer(input) });
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
      case "setup":
        return await setup({ io: laptopIO, terminal, localSetup: (input) => setUpOnThisComputer(input), ...(values.identity ? { identityFile: values.identity } : {}) });
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
      case "new": {
        const code = await projectSession({ cwd: process.cwd(), fresh: true, ...(values.server ? { server: values.server } : {}), ...(values.model ? { model: values.model } : {}) }, laptopIO);
        if (code !== undefined) return code;
        io.err(`  dl new starts a fresh conversation from inside a GitHub repository (with something set up: dl setup).\n`);
        return 1;
      }
      case "servers":
        return await servers(parsed.positionals.slice(1), laptopIO);
      case "use":
        return await use(parsed.positionals.slice(1), laptopIO);
      case "model":
        return await model(parsed.positionals.slice(1), { io: laptopIO, terminal });
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
      case "keys": {
        // On a server, its own keys (as root); on a laptop, the keys where its agents run.
        if (!(await readState(system))) return await keys(parsed.positionals.slice(1), { ...(values.server ? { server: values.server } : {}), io: laptopIO, terminal });
        if (!isRoot()) {
          io.err(`  Run it as root: sudo dl ${parsed.positionals.join(" ")}\n`);
          return 1;
        }
        return await serverKeysCommand(system, parsed.positionals.slice(1), { json: Boolean(values.json), stdin: Boolean(values.stdin) }, {
          out: io.out, err: io.err, colors, stdin: options.stdin ?? process.stdin, prompter: new TtyPrompter(),
        });
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
    if (jsonUi) {
      // The event is what the laptop shows; the log's tail on stderr is for whoever looks.
      jsonUi.error(describeError(error));
      io.err(await logTail(UP_LOG, palette(false)));
      return 1;
    }
    const c = palette(live && !process.env.NO_COLOR);
    io.err(`\n  ${c.red("✗")} ${describeError(error).replace(/\n/g, "\n    ")}\n`);
    if (live) io.err(await logTail(UP_LOG, c));
    return 1;
  }
}

const NOT_A_SERVER = (c: ReturnType<typeof palette>) => `
  ${c.bold("Directionally Local")}  ${c.dim("isn't set up on this machine.")}

  Coding agents that run on this computer or on your own server: send a task,
  get a pull request back.

  ${c.dim("Set it up here, or on a server over SSH (asks a few questions):")}
     dl setup

  ${c.dim("Or on a server (as root, on Ubuntu or Debian):")}
     curl -fsSL https://directionallylocal.run | sh

  ${c.dim("Already have one? Connect this laptop to it:")}
     dl connect https://your-server

`;

/**
 * The `--answers-stdin` JSON: everything up to the end of stdin, or sooner once what came
 * so far parses (a laptop that keeps the SSH channel open still gets going). Keys arrive
 * this way so they're never in argv, the environment, or a file.
 */
export async function readAnswers(stdin: NodeJS.ReadableStream & { isTTY?: boolean }): Promise<string> {
  if (stdin.isTTY) throw new Error("--answers-stdin reads one JSON object from a pipe, not a terminal.");
  let text = "";
  for await (const chunk of stdin) {
    text += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
    if (text.length > 64 * 1024) throw new Error("The answers on stdin are too long; expected one small JSON object.");
    if (text.includes("\n") && parses(text)) return text;
  }
  return text;
}

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

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
