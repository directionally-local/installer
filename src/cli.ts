import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { doctor, formatChecks } from "./doctor.js";
import { serverKeysCommand } from "./keys.js";
import { briefStatus, connectLaptop, laptopsCommand, logsCommand, pairLaptop, serverHome, serverRunsCommand } from "./home.js";
import { cancel, connect, describeError, laptopHome, laptopReady, pull, run, runs, servers, use, watch, type ReadyHere } from "./laptop/commands.js";
import { autopilotAuth, autopilotOnPath, bundledAutopilotVersion, findAutopilot, type AutopilotAuth } from "./laptop/autopilot.js";
import { FREE_TIER_PROVIDER, freeTierAccount, freeTierLine, type FreeTierAccount } from "./laptop/free-tier.js";
import { claudeCodeCommand } from "./laptop/claude-code-hook.js";
import { loadRemotes, resolveTarget } from "./laptop/config.js";
import { dlUpdate } from "./laptop/self-update.js";
import { PAIRED_NAME } from "./local/layout.js";
import { provider as providerCommand } from "./laptop/provider.js";
import { model } from "./laptop/settings.js";
import { openSession, startHere, type SessionInput } from "./laptop/session.js";
import { detectGitHubRepository } from "./laptop/git.js";
import { preview as laptopPreview } from "./laptop/preview.js";
import { setup, setupForTasks, type SetupOptions } from "./laptop/setup.js";
import { realSshExec } from "./laptop/ssh.js";
import { update } from "./laptop/update.js";
import { localCommand } from "./local/cli.js";
import { localStatus, setUpOnThisComputer } from "./local/setup.js";
import { pinnedAutopilotVersion, pinnedHotcellVersion } from "./versions.js";
import { TtyPrompter, type Prompter } from "./prompt.js";
import { readState as readInstallState, type InstallState } from "./state.js";
import { DryRunSystem, RealSystem, type System } from "./system.js";
import { uninstall } from "./uninstall.js";
import { laptopUninstall } from "./laptop/uninstall.js";
import { JsonUi, PlainUi, TerminalUi, palette, type Ui } from "./ui.js";
import { previewCommand, previewsCommand } from "./preview.js";
import { needs, parseAccessMode, parseProvidedAnswers, up } from "./up.js";

const execFileAsync = promisify(execFile);

const HELP = () => `Directionally Local: coding agents that run on this computer or on your own server.
Send a task; it runs in its own sandbox and comes back as a pull request.
(dl is short for directionallylocal; both work.)

On your laptop:
  dl                      talk to an agent: a new session each time. With nothing set up,
                          plain autopilot here (its first run picks a provider); nothing to install
  dl  (on this computer)  plain autopilot in this folder, any folder: every Autopilot feature,
                          your own Autopilot config; the agent edits this folder and stops
                          when the terminal closes (dl -- ARGS passes ARGS to autopilot)
  dl  (on a server)       talk to an agent on the server; it keeps running when you leave.
                          In a GitHub repo, the repository's agent (--no-local-changes: start
                          from the pushed commit, send no patch); anywhere else, a chat
  dl -c, --continue       this computer: autopilot -c; a server: reopen the latest session
                          started from this folder there
  dl --from-claude-code   continue this folder's latest Claude Code conversation here, in a new
                          Autopilot session (read on this computer; asks first)
  dl claude-code hook install   when Claude Code hits its usage or rate limit, show how to continue
                          in dl (adds a hook to ~/.claude/settings.json after asking; backs it up)
  dl claude-code hook remove    take that hook out again
  dl setup                set up or repair where background tasks run (safe to re-run)
  dl new                  the same as bare dl (a new session)
  dl status               where your agents run, their provider, model and versions, and what they're doing
  dl connect URL          connect to a server someone else set up (approve the code it shows)
  dl run "TASK"           run a task in a sandbox, in the background, from inside a GitHub
                          repository; it ends in a pull request
                          (your uncommitted changes go along; Ctrl-C stops watching, not the task).
                          The first time, it asks where tasks run: your own server, or this
                          computer (needs Docker Desktop or OrbStack), and sets that up
  dl runs                 your tasks and their pull requests
  dl watch ID             follow a task      dl cancel ID   stop one
  dl pull ID              check out a task's branch here
  dl preview ID           deploy a task's Workers branch on the server and open it here
  dl servers              where agents run (dl servers remove NAME · dl servers rename OLD NEW)
  dl use [NAME]           where tasks and bare dl go without --server (no NAME: show it)
  dl provider             the provider and GitHub token on each place (dl keys is the same)
  dl provider set         pick another provider, key and model in Autopilot's list (--server NAME)
  dl provider github      replace the GitHub token
  dl model [ID]           the model for tasks and sessions on a place (no ID: Autopilot's list)
  dl update               update dl (when npm has a newer one) and the Autopilot it pins, then
                          the default place (--check: only say whether there's a newer dl)
  dl update NAME          update a place's Autopilot, Hotcell and sandbox image to the versions dl pins
                          (--wait: wait for running tasks instead of asking)
  run options: --server NAME, -m/--model MODEL, --repo OWNER/NAME, --detach
  dl local status         agents running on this computer: running?, where, how many fit
  dl local uninstall [--purge]   stop and remove them (--purge also deletes keys and data)
  dl uninstall [--purge] [--yes]   remove dl from this computer: signs out of the free tier, takes
                          dl's lines out of your shell startup files (backups kept), deletes
                          ~/.directionallylocal and dl's settings (--purge also Autopilot's
                          settings, sign-ins and history; projects' .autopilot folders stay)

On the server:
  dl                      what this is, whether it's healthy, laptops, and runs
  dl up [--dry-run]       install, or repair, everything (safe to re-run)
  dl connect-laptop       how to connect a laptop, and a link to approve it in a browser
  dl connect-laptop CODE  approve the code a laptop shows
  dl laptops              connected laptops (dl laptops remove NAME to disconnect one)
  dl runs                 tasks running or done, with their pull requests
  dl preview ID [--remove]   deploy a task's branch with Serverless Objects, or stop it
  dl previews             live previews: task, port, branch
  dl logs [hotcell|autopilot] [-f]   the services' logs
  dl doctor               check every part, with a fix for each problem
  dl keys [set <provider>|github]   which keys are set, or replace one (hidden input)
                          <provider>: openrouter, deepseek, openai, ollama, … (--base-url URL for a custom one)
  dl uninstall [--purge]  remove everything (--purge also removes config and data)

up options:
  --autopilot-version <x.y.z>   default: the version this dl ships with (${pinnedAutopilotVersion()})
  --hotcell-version <x.y.z>     default: the version this dl ships with (${pinnedHotcellVersion()})

Unattended installs answer the questions with environment variables:
  DL_TAILSCALE_AUTH_KEY   Tailscale auth key (tskey-…), unless this machine is already on a tailnet
  DL_PROVIDER             model provider id (deepseek, openai, ollama, …; default openrouter)
  DL_PROVIDER_API_KEY     its key, stored in Hotcell only (DL_OPENROUTER_API_KEY: the OpenRouter shorthand)
  DL_PROVIDER_BASE_URL    its address, for a provider Hotcell has no built-in route for
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
  dl keys set <provider>|github --stdin --json   replace a key read from stdin
`;

/** What main() runs against; tests replace the parts that touch this machine. */
export interface MainOptions {
  terminal?: boolean;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  /** The server's install state (a server has one); read from this machine unless replaced. */
  serverState?: () => Promise<InstallState | undefined>;
  /** Running as root; process.getuid() unless replaced. */
  root?: boolean;
  /** Merged into every session dl opens (how Autopilot is found and started). */
  session?: Partial<SessionInput>;
  /** `dl setup` and `dl run`'s first-time setup; the real ones unless replaced. */
  setup?: (options: SetupOptions) => Promise<number>;
  /** `dl run`'s question; the terminal's own unless replaced. */
  prompter?: Prompter;
  /** Sends the task; the real `run` unless replaced. */
  run?: typeof run;
  /** Autopilot's active provider and whether it can start (`dl status`); asks the real one (`autopilot auth status`) unless replaced. */
  autopilotAuth?: () => Promise<AutopilotAuth | undefined>;
  /** The free tier account (`dl status`, when Autopilot uses the free tier); reads Autopilot's sign-in and GET /v1/me unless replaced. */
  freeTierAccount?: () => Promise<FreeTierAccount | undefined>;
  /** `dl uninstall` on a server and on a laptop; the real ones unless replaced. */
  uninstall?: { server?: typeof uninstall; laptop?: typeof laptopUninstall };
}

export async function main(
  argv: string[],
  io: { out: (text: string) => void; err: (text: string) => void } = {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  },
  options: MainOptions = {},
): Promise<number> {
  // Everything after `--` belongs to Autopilot (bare dl on this computer): `dl -- --session ID`.
  const split = splitPassthrough(argv);
  const passthrough = split.passthrough;
  argv = split.argv;
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
        wait: { type: "boolean" },
        check: { type: "boolean" },
        "base-url": { type: "string" },
        "auth-header": { type: "string" },
        "auth-format": { type: "string" },
        "no-local-changes": { type: "boolean" },
        continue: { type: "boolean", short: "c" },
        "from-claude-code": { type: "boolean" },
        yes: { type: "boolean", short: "y" },
      },
    });
  } catch (error) {
    io.err(`${(error as Error).message}\n\n${HELP()}`);
    return 2;
  }
  const [command] = parsed.positionals;
  const { values } = parsed;
  if (values.version) {
    io.out(`${packageVersion()}\n`);
    return 0;
  }
  if (values.help || command === "help") {
    io.out(HELP());
    return 0;
  }
  if (values.events !== undefined && values.events !== "json") {
    io.err(`--events takes json (got "${values.events}").\n\n${HELP()}`);
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

  const readState = (from: System) => options.serverState ? options.serverState() : readInstallState(from);
  const isRoot = () => options.root ?? runningAsRoot();
  const sessionInput = (...args: Parameters<typeof sessionInputFrom>) => ({ ...sessionInputFrom(...args), ...options.session });
  const setUp = options.setup ?? setup;

  try {
    if (values["from-claude-code"]) {
      // The transcript is on this computer, so the session runs here, whatever places are set up.
      if (command || values.continue || values.server) {
        io.err("  dl --from-claude-code starts a new session on this computer; use it on its own: dl --from-claude-code\n");
        return 2;
      }
      if (!terminal) {
        io.err("  dl --from-claude-code needs a terminal.\n");
        return 2;
      }
      return await startHere(sessionInput(values, ["--from-claude-code", ...passthrough], { continue: false }), laptopIO);
    }
    switch (command) {
      case "claude-code": {
        const prompter = options.prompter ?? new TtyPrompter();
        return await claudeCodeCommand(parsed.positionals.slice(1), {
          io: laptopIO,
          stdin: options.stdin ?? process.stdin,
          ...(terminal ? { confirm: async (question: string) => !/^n/i.test((await prompter.text(question)).trim()) } : {}),
        });
      }
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
          // Bare dl with a place set up: a new session here. On this computer that's plain
          // `autopilot` in this folder (`dl -c` is `autopilot -c`); on a server, the repository's
          // conversation or a chat (`dl -c` reopens the latest). `dl status` is the overview.
          if (!command && terminal) {
            const input = sessionInput(values, passthrough, { continue: values.continue === true });
            if (values.server || (await loadRemotes()).length > 0) {
              const code = await openSession(input, laptopIO);
              if (code !== undefined) return code;
            } else {
              // A laptop with nothing set up (or root on a Linux machine with no server install,
              // which is the same plain install): plain Autopilot, with nothing to install or
              // answer first. The sandbox stack waits until background tasks are asked for (dl run).
              return await startHere(input, laptopIO);
            }
          }
          // A laptop connected to places gets its own overview (`dl status` shows it from anywhere);
          // otherwise, what this is and how to start.
          // What Autopilot here uses, asked once and only when it's shown.
          const local = !command || command === "status" ? localAutopilot(options) : undefined;
          if ((!command || command === "status") && await laptopHome(laptopIO, undefined, undefined, { ssh: realSshExec, local: localVersions }, local?.then((state) => state.freeTier))) return 0;
          // A laptop with no places is still set up: plain dl runs Autopilot here. Say what's
          // installed and how to start. Root without a server install is the same: the install
          // script gives it the plain install too, and a server only with DL_MODE=server.
          if (local) {
            const { setUp, freeTier } = await local;
            laptopReady({ ...(await readyHere()), ...(setUp === undefined ? {} : { setUp }), ...(freeTier ? { freeTier } : {}) }, laptopIO);
            return 0;
          }
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
        return await setUp({ io: laptopIO, terminal, ...(values.identity ? { identityFile: values.identity } : {}) });
      case "update": {
        const updatePlace = (args: string[]) => update(args, {
          ssh: realSshExec,
          prompter: new TtyPrompter(),
          newUi: () => terminal ? new TerminalUi(io.out, undefined, colorOn) : new PlainUi(io.out),
          io: laptopIO,
          interactive: terminal,
          wait: Boolean(values.wait) || args.includes("--wait"),
          local: async (updateUi) => {
            const { remote: _remote, ...rest } = await setUpOnThisComputer({ ui: updateUi, prompter: new TtyPrompter() });
            void rest;
            const status = await localStatus();
            return status.state ? { autopilot: status.state.autopilotVersion, hotcell: status.state.hotcellVersion } : undefined;
          },
        });
        // A place named: that place, as always. Otherwise dl itself first, then its pinned
        // Autopilot, then the default place.
        if (parsed.positionals[1]) return await updatePlace(parsed.positionals.slice(1));
        return await dlUpdate({
          io: laptopIO,
          check: Boolean(values.check),
          wait: Boolean(values.wait),
          defaultPlace: async () => {
            const remotes = await loadRemotes();
            if (remotes.length === 0) return { kind: "none" };
            try {
              const { remote } = await resolveTarget(undefined);
              return { kind: "place", name: remote.name, updatable: Boolean(remote.ssh) || remote.name === PAIRED_NAME };
            } catch (error) {
              return { kind: "unclear", message: error instanceof Error ? error.message : String(error) };
            }
          },
          updatePlace,
        });
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
        const task = [...parsed.positionals.slice(1), ...passthrough].join(" ").trim();
        if (!task) {
          io.err(`  Usage: dl run "fix the flaky checkout test"   ${colors.dim("(from inside a GitHub repository)")}\n`);
          return 2;
        }
        // A laptop with nowhere to send tasks: ask where they should run, set that up, then go on.
        if (!values.server && (await loadRemotes()).length === 0 && terminal) {
          // Not from a GitHub repository: say so before asking anything or installing.
          if (!values.repo) await detectGitHubRepository(process.cwd());
          const code = await setupForTasks({ io: laptopIO, terminal, setUp, ...(options.prompter ? { prompter: options.prompter } : {}) });
          if (code !== 0) return code;
          if ((await loadRemotes()).length === 0) return 1;
        }
        return await interruptible((signal) => (options.run ?? run)({
          task,
          cwd: process.cwd(),
          signal,
          detach: Boolean(values.detach),
          ...(values["no-local-changes"] ? { noLocalChanges: true } : {}),
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
        // An alias of bare dl for a release: a new conversation, the old one keeps running.
        if ((await loadRemotes()).length === 0) {
          if (terminal && !values.server) return await startHere(sessionInput(values, passthrough, { continue: false }), laptopIO);
          io.err(`  dl new starts a new session in a terminal: dl\n`);
          return 1;
        }
        const code = await openSession(sessionInput(values, passthrough, { continue: false }), laptopIO);
        if (code !== undefined) return code;
        io.err(`  dl new starts a new session on a place; pick one with --server NAME.\n`);
        return 1;
      }
      case "preview": {
        const id = parsed.positionals[1];
        if (!id) {
          io.err(`  Usage: dl preview ID   ${colors.dim("(from dl runs)")}\n`);
          return 2;
        }
        // On a server, deploy it; on a laptop, ask the server to and tunnel to the result.
        if (await readState(system)) {
          if (!isRoot()) {
            io.err(`  Run it as root: sudo dl preview ${id}\n`);
            return 1;
          }
          return await previewCommand(system, parsed.positionals.slice(1), { json: Boolean(values.json) }, io.out, colors);
        }
        return await laptopPreview({ id, ...(values.server ? { server: values.server } : {}) }, {}, laptopIO);
      }
      case "previews": {
        const state = await readState(system);
        if (!state) {
          io.out(NOT_A_SERVER(colors));
          return 1;
        }
        if (!isRoot()) {
          io.err("  Run it as root: sudo dl previews\n");
          return 1;
        }
        return await previewsCommand(system, io.out, colors);
      }
      case "servers":
        return await servers(parsed.positionals.slice(1), laptopIO);
      case "use":
        return await use(parsed.positionals.slice(1), laptopIO);
      case "model":
        return await model(parsed.positionals.slice(1), { io: laptopIO, terminal, ...(values.server ? { server: values.server } : {}) });
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
      case "provider":
      case "keys": {
        // On a server, its own keys (as root); on a laptop, the provider and keys where its agents run.
        if (!(await readState(system))) return await providerCommand(parsed.positionals.slice(1), { ...(values.server ? { server: values.server } : {}), io: laptopIO, terminal });
        if (!isRoot()) {
          io.err(`  Run it as root: sudo dl ${parsed.positionals.join(" ")}\n`);
          return 1;
        }
        return await serverKeysCommand(system, parsed.positionals.slice(1), {
          json: Boolean(values.json),
          stdin: Boolean(values.stdin),
          ...(values["base-url"] ? { baseUrl: values["base-url"] } : {}),
          ...(values["auth-header"] ? { authHeader: values["auth-header"] } : {}),
          ...(values["auth-format"] ? { authFormat: values["auth-format"] } : {}),
        }, {
          out: io.out, err: io.err, colors, stdin: options.stdin ?? process.stdin, prompter: new TtyPrompter(),
        });
      }
      case "local":
        return await localCommand(parsed.positionals.slice(1), { purge: Boolean(values.purge) }, io, colors, ui);
      case "uninstall": {
        // A machine dl up set up uninstalls the server; anything else (root included) is a laptop.
        if (await readState(system)) {
          await (options.uninstall?.server ?? uninstall)(system, { purge: Boolean(values.purge) });
          return 0;
        }
        const stdin = options.stdin ?? process.stdin;
        const prompter = options.prompter ?? new TtyPrompter();
        return await (options.uninstall?.laptop ?? laptopUninstall)({
          io: laptopIO,
          purge: Boolean(values.purge),
          yes: Boolean(values.yes),
          ...(terminal && stdin.isTTY === true ? { confirm: async (question: string) => /^y(es)?$/i.test((await prompter.text(question)).trim()) } : {}),
        });
      }
      default:
        io.err(`Unknown command "${command}".\n\n${HELP()}`);
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

  Coding agents that run on this computer or on your own server.

  ${c.dim("Talk to an agent in this folder (plain Autopilot, nothing to set up):")}
     dl

  ${c.dim("Background tasks that end in a pull request (asks where they run):")}
     dl run "fix the flaky checkout test"      ${c.dim("or")}  dl setup

  ${c.dim("Or set up a server for background tasks (Ubuntu or Debian):")}
     curl -fsSL https://directionallylocal.run | sudo DL_MODE=server sh

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

function runningAsRoot(): boolean {
  return process.getuid?.() === 0;
}

/** The Autopilot and Hotcell versions "this computer" runs, for `dl status`; undefined when it isn't set up here. */
async function localVersions(): Promise<{ autopilot: string; hotcell: string } | undefined> {
  try {
    const state = (await localStatus()).state;
    return state ? { autopilot: state.autopilotVersion, hotcell: state.hotcellVersion } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * For `dl status`: whether Autopilot here can start a session, and, when its active provider
 * is the free tier, the account line. Read-only; never throws, and anything it can't tell is
 * left out.
 */
async function localAutopilot(options: MainOptions): Promise<{ setUp?: boolean; freeTier?: string }> {
  try {
    const auth = await (options.autopilotAuth ?? (async () => autopilotAuth(await findAutopilot())))();
    if (!auth) return {};
    if (auth.active !== FREE_TIER_PROVIDER || !auth.setUp) return { setUp: auth.setUp };
    const account = await (options.freeTierAccount ?? (() => freeTierAccount()))().catch(() => undefined);
    return { setUp: true, ...(account ? { freeTier: freeTierLine(account) } : {}) };
  } catch {
    return {};
  }
}

/**
 * What `dl status` reports on a laptop with no places: dl's version and where it's installed
 * (the install script's ~/.directionallylocal, else the package's own directory), and the
 * Autopilot plain dl runs.
 */
async function readyHere(): Promise<ReadyHere> {
  const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
  const home = homedir();
  const installed = root.match(/^(.*)\/dl\/lib\/node_modules\/directionallylocal$/)?.[1] ?? root;
  const installedIn = home && (installed === home || installed.startsWith(`${home}/`)) ? `~${installed.slice(home.length)}` : installed;
  const bundled = bundledAutopilotVersion();
  if (bundled) return { dl: packageVersion(), autopilot: bundled, bundled: true, installedIn };
  const onPath = await autopilotOnPath();
  const version = onPath
    ? await execFileAsync(onPath, ["--version"], { timeout: 5_000 }).then(({ stdout }) => stdout.match(/\d+\.\d+\.\d+\S*/)?.[0]).catch(() => undefined)
    : undefined;
  return { dl: packageVersion(), ...(onPath ? { autopilot: version ?? "installed", bundled: false } : {}), installedIn };
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

/** What bare dl (and dl new) hand to openSession: the flags it understands, and what came after `--`. */
function sessionInputFrom(
  values: { server?: string | undefined; model?: string | undefined; "no-local-changes"?: boolean | undefined },
  passthrough: string[],
  options: { continue: boolean },
): SessionInput {
  return {
    cwd: process.cwd(),
    ...(options.continue ? { continue: true } : {}),
    ...(values.server ? { server: values.server } : {}),
    ...(values.model ? { model: values.model } : {}),
    ...(values["no-local-changes"] ? { noLocalChanges: true } : {}),
    ...(passthrough.length ? { args: passthrough } : {}),
  };
}

/** dl's own arguments, and everything after the first `--` (for Autopilot). */
export function splitPassthrough(argv: string[]): { argv: string[]; passthrough: string[] } {
  const dashes = argv.indexOf("--");
  return dashes === -1 ? { argv, passthrough: [] } : { argv: argv.slice(0, dashes), passthrough: argv.slice(dashes + 1) };
}
