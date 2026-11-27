import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { doctor, formatChecks } from "./doctor.js";
import { serverKeysCommand } from "./keys.js";
import { briefStatus, connectLaptop, laptopsCommand, logsCommand, pairLaptop, serverHome, serverRunsCommand } from "./home.js";
import { cancel, connect, describeError, laptopHome, laptopReady, pull, run, runs, servers, use, watch, type ReadyHere } from "./laptop/commands.js";
import { autopilotAuth, autopilotOnPath, findAutopilot, installedAutopilotVersion, type AutopilotAuth } from "./laptop/autopilot.js";
import { FREE_TIER_PROVIDER, freeTierAccount, freeTierLine, freeTierProPrompt, type FreeTierAccount } from "./laptop/free-tier.js";
import { freeModelStatus, modelsCommand } from "./laptop/free-providers.js";
import { claudeCodeCommand } from "./laptop/claude-code-hook.js";
import { claudeCommand } from "./laptop/claude.js";
import { freeTierModels, opencodeCommand } from "./laptop/opencode.js";
import { piCommand } from "./laptop/pi.js";
import { conductorCommand, proxyCommand } from "./laptop/proxy.js";
import { t3Command } from "./laptop/t3.js";
import { acpCommand, zedCommand } from "./laptop/zed.js";
import { apiKeyCommand, dlKeyFromFreeTier } from "./laptop/api-key.js";
import { loadRemotes, resolveTarget } from "./laptop/config.js";
import { dlUpdate } from "./laptop/self-update.js";
import { PAIRED_NAME } from "./local/layout.js";
import { provider as providerCommand } from "./laptop/provider.js";
import { model } from "./laptop/settings.js";
import { modelCommand as gpuModelCommand, runLogDir } from "./model-command.js";
import { planCommand } from "./model-plan.js";
import { evalsCommand } from "./model-evals.js";
import { boxSummary } from "./box-status.js";
import { agentCommand } from "./laptop/agent-choice.js";
import { readLocalModel } from "./laptop/local-agents.js";
import { chatUiCommand } from "./chat-ui.js";
import { openSession, startHere, type SessionInput } from "./laptop/session.js";
import { AUTOPILOT_ID, detectAgents, type DetectedAgent } from "./laptop/agent-catalog.js";
import { ensureAutopilot } from "./laptop/autopilot-install.js";
import { browserSignIn, dlKeyOrSignIn, forgetDlKey, maskKey, planName, readDlKey, reportAgentRequest, type AgentRequest, type DlKey } from "./laptop/dl-key.js";
import { firstTokens } from "./laptop/onboarding.js";
import { autopilotKeyEnv, autopilotProvider, orderAgents, readAgentHistory, recordAgentUse, routerHome, type RouterDeps } from "./laptop/router.js";
import { autopilotConfigFile } from "./laptop/free-tier.js";
import { readAgentChoice } from "./laptop/agent-choice.js";
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

const HELP = () => `Directionally Local: dl gives your coding agent open models (DeepSeek, Kimi) on one
flat plan. It finds the coding agents on this computer and opens the one you pick on your plan.
(dl is short for directionallylocal; both work.)

On your laptop:
  dl                      the first time: sign in or sign up at dl.new (in your browser), then the
                          coding agents found on this computer to pick from. After that, the same
                          list with the last one you used on top: Enter opens it. A CLI dl knows
                          (Claude Code, OpenCode, Pi, T3 Code) opens on your plan; for an app
                          (Cursor, Zed, Cline…) dl shows where to put your key and base URLs.
                          Autopilot, dl's own agent, is optional: downloaded when you pick it
  dl -c, --continue       this computer: the last agent's latest session in this folder; a server:
                          reopen the latest session started from this folder there
  dl  (on a server)       talk to an agent on the server; it keeps running when you leave.
                          In a GitHub repo, the repository's agent (--no-local-changes: start
                          from the pushed commit, send no patch); anywhere else, a chat
  dl autopilot [ARGS]     Autopilot here, downloaded the first time (dl -- ARGS also passes ARGS
                          to it); on your plan unless you've given it a provider of your own
  dl login                sign in to dl.new again (dl logout forgets the key on this computer)
  dl agent                the coding agent plain dl opens on a GPU box, on its own model, and a
                          menu to change it: Autopilot (default), Claude Code, OpenCode or Pi.
                          The others are your own CLIs (install them yourself), started for one
                          run on the local model; their own config files aren't touched
  dl agent set NAME       change it: autopilot, claude-code, opencode or pi
  dl --from-claude-code   continue this folder's latest Claude Code conversation here, in a new
                          Autopilot session (read on this computer; asks first)
  dl claude [ARGS]        your own Claude Code on your dl plan (DeepSeek), with your dl sign-in;
                          ARGS go to claude as they are. Needs claude installed. Your ~/.claude settings aren't touched;
                          it won't start if they set an Anthropic key or apiKeyHelper
                          (DL_ALLOW_CLAUDE_SETTINGS_KEY=1 starts anyway)
  dl opencode [ARGS]      your own OpenCode on your dl plan, with your dl sign-in; ARGS go to
                          opencode as they are. Needs opencode installed. Your OpenCode config
                          files aren't touched
  dl pi [ARGS]            your own Pi on your dl plan, with your dl sign-in; ARGS go to pi as they
                          are. Needs pi installed (npm i -g @earendil-works/pi-coding-agent).
                          Nothing under ~/.pi is touched
  dl conductor            Conductor (and Zed, Cline and other desktop apps) on free tokens: starts
                          dl proxy and prints the settings to paste into the app
  dl proxy start|stop|status   a local proxy on 127.0.0.1:4789 that desktop apps use for the free
                          tier, with a local token as their API key (dl proxy install: at login)
  dl api-key              your dl key and base URLs for any other tool (Cursor, Cline, Roo, Kilo,
                          Continue, Zed, Aider, OpenCode…): OpenAI-style https://api.dl.new/v1,
                          Anthropic-style https://api.dl.new/anthropic. More keys: dl.new/keys
  dl t3 [ARGS]            your own T3 Code server (t3; dl t3 serve for no browser) with its Claude
                          Code and OpenCode on your dl plan while dl t3 runs; ARGS go to t3. Needs
                          t3 installed; the T3 Code desktop app doesn't get free tokens yet.
                          Asks before turning on OpenCode in T3 Code's settings
                          (~/.t3/userdata/settings.json; backs it up); --dl-enable-opencode
                          turns it on without asking
  dl zed                  add dl to Zed as an agent (Autopilot over ACP, your own provider or the free
                          tier, signs in first if needed); edits Zed's settings.json after a backup,
                          nothing else in it changes. dl zed remove takes it out
  dl acp                  the same agent on stdio, for any ACP editor (T3 Code: "Local ACP command")
  dl claude-code hook install   when Claude Code hits its usage or rate limit, show how to continue
                          in dl (adds a hook to ~/.claude/settings.json after asking; backs it up)
  dl claude-code hook remove    take that hook out again
  dl setup                set up or repair where background tasks run (safe to re-run)
  dl new                  the same as bare dl
  dl status               where your agents run, their provider, model and versions, and what they're doing
                          (on a GPU box, first: models, coding agent, team chat, agent server and Tailscale)
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
  dl models               the free tier's models, their providers and measured speeds (--json)
  dl model up [MODEL]     serve a curated model (vLLM or SGLang) on this machine's Nvidia GPUs (--dry-run: plan only)
  dl model up MODEL --plan  the exact docker command, GPUs, layout and memory math; runs nothing
                          (--hardware DIR: plan for another machine's nvidia-smi output)
  dl model update [MODEL] smoke-test a replacement before switching (--dry-run: plan only)
  dl model rollback       restore the previous deployment and provider
  dl model status         running model, GPU memory, and last smoke tests
  dl model bench          TTFT p50/p95 and decode tok/s at concurrency 1/8/32, plus prefix cache
  dl model list           every deployment here: name, model, engine, image, GPUs, port, status, sandbox
  dl model up MODEL --workspace DIR  also Autopilot in a Hotcell sandbox that sees only DIR and
                          reaches only the model (--allow-internet: the internet too; server install)
  dl model attach         open Autopilot in that sandbox (dl model attach -- -c continues)
  dl model down           stop and remove the model (and its sandbox; DIR is kept)
  dl model endpoint       your GPU as an OpenAI-compatible API: base URL, model, API key (masked;
                          --show-key) and setup for OpenAI-compatible tools, Autopilot, OpenCode,
                          Cursor and Claude Code. First run: turns it on, this machine only
                          (127.0.0.1:8800, --port PORT), a key required. --off stops it
  dl model share --lan|--tailscale|--public   who can reach it: your network, your tailnet (HTTPS),
                          or the internet (Cloudflare quick tunnel; testing only). Always a key.
                          --off: this machine only again
  dl model keys [add NAME|revoke ID]   the endpoint's API keys (--show-key: in full)
  model options: --name NAME (a separate deployment; update/rollback/status/bench target it),
                 --gpus 0,1 (only these GPUs), --port PORT, --context TOKENS,
                 --image IMAGE (up/update/--plan: this container image instead of the catalog's,
                 e.g. vllm/vllm-openai:v0.34.0rc2; same flags; update keeps it unless given again),
                 --skip-evals (update: switch without running dl evals)
  dl evals set "COMMAND"  your own eval command; dl model update runs it on the old and new model
                          and switches only if the new one passes and scores at least the old
                          score minus --threshold (0.02). --results GLOB: where it writes scores
                          (JUnit XML, promptfoo, Inspect, DeepEval, {"score": n}); --timeout 30m
  dl evals set --data PATH  your eval data (a file, folder or glob), run with promptfoo: its
                          configs and tests as is; JSONL, CSV, OpenAI Evals, Braintrust or LangSmith
                          exports translated (expected = equals, or contains:/factuality:...); model-
                          graded checks judged by your own model (with a command: both run)
  dl evals run [NAME...]  run it once per deployment here, with OPENAI_BASE_URL, OPENAI_API_KEY and
                          OPENAI_MODEL set for each
  dl evals show           the saved evals        dl evals clear   remove them
  dl ui [up]              team chat: Open WebUI next to your dl model deployments, in Docker, on
                          127.0.0.1:4800 only (from a laptop without Tailscale: an SSH tunnel,
                          ssh -N -L 4800:127.0.0.1:4800 you@box). The first account made in the
                          browser is the admin; everyone signs in with 2FA. It follows dl model
                          up/update/down by itself. --port PORT; --admin-email EMAIL: dl makes
                          the admin and shows its password once (it never keeps it)
  dl ui share             print one link for your team: private HTTPS on your tailnet with Tailscale
                          (tailscale serve, never Funnel; no plain-HTTP fallback). --off stops sharing
  dl ui invite EMAIL...   make their accounts and print what to send each person (dl sends no email;
                          asks once for an admin's Open WebUI API key, kept 0600)
  dl ui approve [EMAIL...|all]   who signed up and waits for approval; approve them
  dl ui status · dl ui logs [-f] · dl ui down [--purge]   (--purge deletes accounts and chats)
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

Usage counts:
  DL_NO_TELEMETRY=1, DO_NOT_TRACK=1 or CI   no install count, no session end (duration, exit),
                          OS or Pro-offer counts from dl. A bare session start (id and time) still
                          goes with dl claude/opencode/pi/t3/proxy: the free tier needs it to keep
                          free tokens inside dl

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
  freeTierAccount?: (options?: { showsProPrompt?: boolean }) => Promise<FreeTierAccount | undefined>;
  /** The chosen free model with its provider and speed (`dl status`, when Autopilot uses the free tier); reads Autopilot's config and GET /v1/providers unless replaced. */
  freeModel?: () => Promise<string | undefined>;
  /** `dl models`; the real one unless replaced. */
  modelsCommand?: typeof modelsCommand;
  /** `dl claude`; the real one unless replaced. */
  claude?: (args: string[], io: { out: (text: string) => void; err: (text: string) => void }) => Promise<number>;
  /** `dl opencode`; the real one unless replaced. */
  opencode?: (args: string[], io: { out: (text: string) => void; err: (text: string) => void }) => Promise<number>;
  /** `dl pi`; the real one unless replaced. */
  pi?: (args: string[], io: { out: (text: string) => void; err: (text: string) => void }) => Promise<number>;
  /** `dl api-key`; the real one unless replaced. */
  apiKey?: (args: string[], io: { out: (text: string) => void; err: (text: string) => void }) => Promise<number>;
  /** `dl t3`; the real one unless replaced. */
  t3?: (args: string[], io: { out: (text: string) => void; err: (text: string) => void }) => Promise<number>;
  /** `dl acp`; the real one unless replaced. */
  acp?: (args: string[], io: { out: (text: string) => void; err: (text: string) => void }) => Promise<number>;
  /** `dl zed`; the real one unless replaced. */
  zed?: (args: string[], io: { out: (text: string) => void; err: (text: string) => void }) => Promise<number>;
  /** What a GPU box runs, printed first by `dl status` and plain `dl` (box-status.ts); the real one unless replaced. */
  boxSummary?: () => Promise<string | undefined>;
  /** `dl uninstall` on a server and on a laptop; the real ones unless replaced. */
  uninstall?: { server?: typeof uninstall; laptop?: typeof laptopUninstall };
  /** `dl agent`; the real one unless replaced. */
  agentCommand?: typeof agentCommand;
  /** Bare `dl` on a laptop (router.ts); the real one unless replaced. */
  router?: typeof routerHome;
  /** The model ids a dl key may use (GET /v1/models), for the router's by-hand steps; the service is asked unless replaced. */
  agentModels?: RouterDeps["models"];
  /**
   * Whether this is a GPU box whose plain dl opens its own agent on its own model ("first-run":
   * GPUs, and nothing set up on them yet); looked up unless replaced.
   */
  gpuBox?: () => Promise<boolean | "first-run">;
  /** Marks an agent as the one last opened through dl; agents.json unless replaced. */
  recordAgentUse?: (id: string) => Promise<void>;
  /** `dl login`; the browser sign-in unless replaced. */
  signIn?: (io: { out: (text: string) => void; err: (text: string) => void; color?: boolean }) => Promise<DlKey | undefined>;
  /** The dl key (`dl status`); dl's config unless replaced. */
  dlKey?: () => Promise<DlKey | undefined>;
  /** The agents found here (`dl status`, the router); detected unless replaced. */
  detectAgents?: () => Promise<DetectedAgent[]>;
  /** Tells the service about an agent dl doesn't know (the router); POST /v1/agent-request unless replaced. */
  reportAgent?: (request: AgentRequest, key: DlKey) => Promise<unknown>;
  /** The one-time first-tokens line after the first agent run (onboarding.ts firstTokens) unless replaced. */
  firstTokens?: (key: DlKey) => Promise<{ text?: string; done: boolean }>;
}

export async function main(
  argv: string[],
  io: { out: (text: string) => void; err: (text: string) => void } = {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  },
  options: MainOptions = {},
): Promise<number> {
  // `dl claude ARGS`: every argument after `claude` is Claude Code's, flags included. Each of these
  // becomes the agent bare dl offers first ("last used").
  const used = (id: string) => (options.recordAgentUse ?? recordAgentUse)(id).catch(() => undefined);
  if (argv[0] === "claude") return (await used("claude-code"), await (options.claude ?? claudeCommand)(argv.slice(1), io));
  // `dl opencode ARGS`: the same for OpenCode.
  if (argv[0] === "opencode") return (await used("opencode"), await (options.opencode ?? opencodeCommand)(argv.slice(1), io));
  // `dl pi ARGS`: the same for Pi.
  if (argv[0] === "pi") return (await used("pi"), await (options.pi ?? piCommand)(argv.slice(1), io));
  // `dl autopilot ARGS`: dl's own agent, downloaded the first time; ARGS go to autopilot.
  if (argv[0] === "autopilot") {
    await used(AUTOPILOT_ID);
    const color = (options.terminal ?? process.stdout.isTTY === true) && !process.env.NO_COLOR && process.env.TERM !== "dumb";
    return await autopilotOnKey({ cwd: process.cwd(), ...(argv.length > 1 ? { args: argv.slice(1) } : {}), forceAutopilot: true, ...options.session }, { out: io.out, err: io.err, color });
  }
  // `dl login`: sign in to dl.new again (another account, or a new key); `dl logout` forgets the key here.
  if (argv[0] === "login" && argv.length === 1) {
    const color = (options.terminal ?? process.stdout.isTTY === true) && !process.env.NO_COLOR && process.env.TERM !== "dumb";
    return (await (options.signIn ?? ((signInIO) => browserSignIn(signInIO, { intro: false })))({ out: io.out, err: io.err, color })) ? 0 : 1;
  }
  if (argv[0] === "logout" && argv.length === 1) {
    await forgetDlKey();
    io.out("  Signed out on this computer: dl's key is gone from here. It still works where you've pasted it; revoke it at dl.new/keys.\n");
    return 0;
  }
  // `dl proxy start|stop|status|run|install|uninstall` and `dl conductor`: desktop apps on the free tier.
  if (argv[0] === "proxy") return await proxyCommand(argv.slice(1), io);
  if (argv[0] === "conductor") return await conductorCommand(argv.slice(1), io);
  // `dl api-key [NAME|list|revoke ID]`: an API key for the free tier in any other tool.
  if (argv[0] === "api-key") return await (options.apiKey ?? apiKeyCommand)(argv.slice(1), io);
  // `dl t3 ARGS`: like `dl opencode`, for T3 Code's server, whose Claude Code and OpenCode get free tokens.
  if (argv[0] === "t3") return (await used("t3"), await (options.t3 ?? t3Command)(argv.slice(1), io));
  // `dl acp ARGS`: Autopilot as an ACP agent on stdio (editors run it); stdout is the protocol's.
  if (argv[0] === "acp") return await (options.acp ?? acpCommand)(argv.slice(1), { out: io.err, err: io.err });
  // `dl zed [remove|--print]`: add dl to Zed's external agents.
  if (argv[0] === "zed") return await (options.zed ?? zedCommand)(argv.slice(1), io);
  // Everything after `--` belongs to Autopilot (bare dl on this computer): `dl -- --session ID`.
  const split = splitPassthrough(argv);
  const passthrough = split.passthrough;
  argv = bareListen(split.argv);
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
        gpus: { type: "string" },
        plan: { type: "boolean" },
        hardware: { type: "string" },
        port: { type: "string" },
        context: { type: "string" },
        image: { type: "string" },
        workspace: { type: "string" },
        "allow-internet": { type: "boolean" },
        "skip-evals": { type: "boolean" },
        engine: { type: "string" },
        threshold: { type: "string" },
        results: { type: "string" },
        timeout: { type: "string" },
        data: { type: "string" },
        listen: { type: "string" },
        "admin-email": { type: "string" },
        off: { type: "boolean" },
        lan: { type: "boolean" },
        tailscale: { type: "boolean" },
        public: { type: "boolean" },
        "show-key": { type: "boolean" },
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
      return await autopilotOnKey({ ...sessionInput(values, ["--from-claude-code", ...passthrough], { continue: false }), forceAutopilot: true }, laptopIO);
    }
    switch (command) {
      case "agent": {
        return await (options.agentCommand ?? agentCommand)(parsed.positionals.slice(1), {
          io: laptopIO,
          interactive: terminal,
          ...(terminal ? { prompter: options.prompter ?? new TtyPrompter() } : {}),
          model: () => readLocalModel(new RealSystem()),
        });
      }
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
        // Bare dl with something for Autopilot (`dl -- -p "…"`, `dl -c`, `dl -m MODEL`) runs it, at a
        // terminal or not (scripts, CI); only a bare non-interactive `dl` shows the overview.
        const forAutopilot = passthrough.length > 0 || values.continue === true || values.model !== undefined;
        const runsAutopilot = !command && (terminal || forAutopilot);
        // A GPU box (dl model deployments or a team chat) says what runs here first; elsewhere nothing is
        // printed. Not before a script's Autopilot run, whose stdout is Autopilot's.
        if (!values.brief && (terminal || !runsAutopilot)) {
          const summary = await (options.boxSummary ?? (() => boxSummary({ system, color: colorOn, ...(state ? { serverState: state } : {}) })))();
          if (summary) io.out(summary);
        }
        if (!state) {
          if (values.brief) return 0;
          // Bare dl with a place set up: a new session here. On this computer that's plain
          // `autopilot` in this folder (`dl -c` is `autopilot -c`); on a server, the repository's
          // conversation or a chat (`dl -c` reopens the latest). `dl status` is the overview.
          if (runsAutopilot) {
            const input = sessionInput(values, passthrough, { continue: values.continue === true });
            if (values.server || (await loadRemotes()).length > 0) {
              const code = await openSession(input, laptopIO);
              if (code !== undefined) return code;
            } else {
              // A laptop with nothing set up (or root on a Linux machine with no server install,
              // which is the same plain install): dl routes the person's own coding agent
              // (router.ts): sign in, pick an agent found here, open it. `dl -- ARGS` and -m are
              // Autopilot's, and a GPU box keeps its own agent on its own model (dl agent).
              const toAutopilot = passthrough.length > 0 || values.model !== undefined;
              const gpu = terminal && !toAutopilot ? await (options.gpuBox ?? gpuBox)() : false;
              if (terminal && !toAutopilot && !gpu) {
                return await (options.router ?? routerHome)(routerDeps(options, laptopIO), { continue: values.continue === true });
              }
              // The GPU first run, as before; one line on where the agent picker is once it's done.
              if (gpu === "first-run") io.err(`  ${colors.dim(GPU_FIRST_RUN_HINT)}\n`);
              return await autopilotOnKey(input, laptopIO);
            }
          }
          // A laptop connected to places gets its own overview (`dl status` shows it from anywhere);
          // otherwise, what this is and how to start.
          // What Autopilot here uses, asked once and only when it's shown.
          const local = !command || command === "status" ? localAutopilot(options) : undefined;
          if ((!command || command === "status") && await laptopHome(laptopIO, undefined, undefined, { ssh: realSshExec, local: localVersions }, local?.then((state) => state.freeTier), local?.then((state) => state.freeModel))) return 0;
          // A laptop with no places is still set up: plain dl runs Autopilot here. Say what's
          // installed and how to start. Root without a server install is the same: the install
          // script gives it the plain install too, and a server only with DL_MODE=server.
          if (local) {
            const { setUp, freeTier, freeModel } = await local;
            laptopReady({ ...(await readyHere(options)), ...(setUp === undefined ? {} : { setUp }), ...(freeTier ? { freeTier } : {}), ...(freeModel ? { freeModel } : {}) }, laptopIO);
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
          if (terminal && passthrough.length === 0 && values.model === undefined && !values.server && !(await (options.gpuBox ?? gpuBox)())) {
            return await (options.router ?? routerHome)(routerDeps(options, laptopIO), {});
          }
          if ((terminal || passthrough.length > 0) && !values.server) return await autopilotOnKey(sessionInput(values, passthrough, { continue: false }), laptopIO);
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
      case "models":
        // The free tier's providers and models, with measured speeds (GET /v1/providers).
        return await (options.modelsCommand ?? modelsCommand)({ out: io.out, color: colorOn }, { json: Boolean(values.json) });
      case "model": {
        const [action, ...args] = parsed.positionals.slice(1);
        if (action === "endpoint" || action === "share" || action === "keys") {
          if (values.server) { io.err("dl model endpoint, share and keys run on this machine; omit --server.\n"); return 2; }
          const { modelApiCommand } = await import("./model-api.js");
          return await modelApiCommand(action, args, { system, out: io.out, color: colorOn,
            ...(values["show-key"] ? { showKey: true } : {}), ...(values.off ? { off: true } : {}), ...(values.port !== undefined ? { port: values.port } : {}),
            ...(values.lan ? { lan: true } : {}), ...(values.tailscale ? { tailscale: true } : {}), ...(values.public ? { public: true } : {}) });
        }
        if (action === "up" || action === "update" || action === "rollback" || action === "status" || action === "bench" || action === "list" || action === "down" || action === "attach") {
          if (values.server) { io.err("dl model deployment commands run on this machine; omit --server.\n"); return 2; }
          if (values.plan || values.hardware !== undefined) {
            if (action !== "up" || !values.plan) { io.err("--plan goes with dl model up MODEL (and --hardware DIR with --plan).\n"); return 2; }
            if (args.length !== 1) { io.err("Usage: dl model up MODEL --plan [--gpus 0,1] [--name NAME] [--port PORT] [--context TOKENS] [--image IMAGE] [--hardware DIR] [--workspace DIR [--allow-internet]]\n"); return 2; }
            // Runs nothing, downloads nothing, writes nothing (not even a run log).
            return await planCommand({ system, model: args[0], name: values.name, gpus: values.gpus, port: values.port, context: values.context, image: values.image, hardware: values.hardware,
              workspace: values.workspace, allowInternet: values["allow-internet"], out: io.out });
          }
          return await gpuModelCommand(action, action === "attach" ? [] : args, { system, ui: terminal && !values["dry-run"] ? new TerminalUi(io.out, undefined, colorOn) : new PlainUi(io.out), prompter: options.prompter ?? new TtyPrompter(), interactive: terminal,
            ...(values.name !== undefined ? { name: values.name } : {}), ...(values.gpus !== undefined ? { gpus: values.gpus } : {}),
            ...(values.port !== undefined ? { port: values.port } : {}), ...(values.context !== undefined ? { context: values.context } : {}),
            ...(values.image !== undefined ? { image: values.image } : {}),
            ...(values.workspace !== undefined ? { workspace: values.workspace } : {}), ...(values["allow-internet"] ? { allowInternet: true } : {}),
            ...(values["skip-evals"] ? { skipEvals: true } : {}),
            ...(values.engine !== undefined ? { engine: values.engine } : {}),
            // dl model attach -- -c: the rest goes to Autopilot.
            ...(action === "attach" ? { attachArgs: args } : {}) });
        }
        return await model(parsed.positionals.slice(1), { io: laptopIO, terminal, ...(values.server ? { server: values.server } : {}) });
      }
      case "evals":
        if (values.server) { io.err("dl evals runs on this machine, against its dl model deployments; omit --server.\n"); return 2; }
        return await evalsCommand(parsed.positionals.slice(1), { system, ui: terminal ? new TerminalUi(io.out, undefined, colorOn) : new PlainUi(io.out), cwd: process.cwd(), logDir: runLogDir(),
          ...(values.threshold !== undefined ? { threshold: values.threshold } : {}), ...(values.results !== undefined ? { results: values.results } : {}),
          ...(values.timeout !== undefined ? { timeout: values.timeout } : {}), ...(values.model !== undefined ? { model: values.model } : {}),
          ...(values.data !== undefined ? { data: values.data } : {}) });
      case "ui": {
        if (values.server) { io.err("dl ui runs on this machine, next to its dl model deployments; omit --server.\n"); return 2; }
        const [action, ...args] = parsed.positionals.slice(1);
        return await chatUiCommand(action, args, { system, ui: terminal ? new TerminalUi(io.out, undefined, colorOn) : new PlainUi(io.out), prompter: options.prompter ?? new TtyPrompter(), interactive: terminal,
          ...(values.port !== undefined ? { port: values.port } : {}), ...(values.listen !== undefined ? { listen: values.listen } : {}),
          ...(values["admin-email"] !== undefined ? { adminEmail: values["admin-email"] } : {}),
          ...(values.off ? { off: true } : {}), ...(values.purge ? { purge: true } : {}), ...(values.follow ? { follow: true } : {}) });
      }
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

  ${c.dim("Open your coding agent in this folder, on your dl plan (signs in the first time):")}
     dl

  ${c.dim("Background tasks that end in a pull request (asks where they run):")}
     dl run "fix the flaky checkout test"      ${c.dim("or")}  dl setup

  ${c.dim("Or set up a server for background tasks (Ubuntu or Debian):")}
     curl -fsSL https://dl.new/install.sh | sudo DL_MODE=server sh

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
async function localAutopilot(options: MainOptions): Promise<{ setUp?: boolean; freeTier?: string; freeModel?: string }> {
  try {
    const auth = await (options.autopilotAuth ?? (async () => autopilotAuth(await findAutopilot())))();
    if (!auth) return {};
    if (auth.active !== FREE_TIER_PROVIDER || !auth.setUp) return { setUp: auth.setUp };
    const [account, freeModel] = await Promise.all([
      (options.freeTierAccount ?? ((o) => freeTierAccount(o)))({ showsProPrompt: true }).catch(() => undefined),
      (options.freeModel ?? (() => freeModelStatus()))().catch(() => undefined),
    ]);
    if (!account) return { setUp: true, ...(freeModel ? { freeModel } : {}) };
    // dl Pro's prompt, when the service sent one, on the next line under the account (aligned with it).
    const prompt = freeTierProPrompt(account);
    return { setUp: true, freeTier: prompt ? `${freeTierLine(account)}\n${" ".repeat(13)}${prompt}` : freeTierLine(account), ...(freeModel ? { freeModel } : {}) };
  } catch {
    return {};
  }
}

/**
 * What `dl status` reports on a laptop with no places: dl's version and where it's installed
 * (the install script's ~/.directionallylocal, else the package's own directory), and the
 * Autopilot plain dl runs.
 */
async function readyHere(options: MainOptions): Promise<ReadyHere> {
  const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
  const home = homedir();
  const installed = root.match(/^(.*)\/dl\/lib\/node_modules\/directionallylocal$/)?.[1] ?? root;
  const installedIn = home && (installed === home || installed.startsWith(`${home}/`)) ? `~${installed.slice(home.length)}` : installed;
  const [key, found, history] = await Promise.all([
    (options.dlKey ?? (() => readDlKey()))().catch(() => undefined),
    (options.detectAgents ?? (() => detectAgents()))().catch(() => [] as DetectedAgent[]),
    readAgentHistory(),
  ]);
  const ordered = orderAgents(found, history);
  const signedIn = {
    ...(key ? { account: `${planName(key.plan)} plan · key ${maskKey(key.key)}` } : {}),
    agents: ordered.map((agent) => agent.id === history.lastUsed ? `${agent.name} (last used)` : agent.name).join(", "),
  };
  const ours = installedAutopilotVersion();
  if (ours) return { dl: packageVersion(), autopilot: ours, bundled: true, installedIn, ...signedIn };
  const onPath = await autopilotOnPath();
  const version = onPath
    ? await execFileAsync(onPath, ["--version"], { timeout: 5_000 }).then(({ stdout }) => stdout.match(/\d+\.\d+\.\d+\S*/)?.[0]).catch(() => undefined)
    : undefined;
  return { dl: packageVersion(), ...(onPath ? { autopilot: version ?? "installed", bundled: false } : {}), installedIn, ...signedIn };
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
/** `--listen` with no address (last, or before another flag or a word that isn't one) means every address. */
export function bareListen(argv: string[]): string[] {
  return argv.map((arg, index) => {
    if (arg !== "--listen") return arg;
    const next = argv[index + 1];
    return next === undefined || next.startsWith("-") || !isIP(next.replace(/^\[|\]$/g, "")) && next !== "localhost" ? "--listen=0.0.0.0" : arg;
  });
}

export function splitPassthrough(argv: string[]): { argv: string[]; passthrough: string[] } {
  const dashes = argv.indexOf("--");
  return dashes === -1 ? { argv, passthrough: [] } : { argv: argv.slice(0, dashes), passthrough: argv.slice(dashes + 1) };
}

/**
 * A GPU box: Nvidia GPUs here, dl model up has a model here, or `dl agent` chose its agent. Plain
 * dl keeps its GPU first run there (Autopilot offers to serve a model on the GPUs) and then opens
 * the box's agent on the box's model; the router is for everyone else.
 */
async function gpuBox(): Promise<boolean | "first-run"> {
  const [choice, model] = await Promise.all([readAgentChoice().catch(() => undefined), readLocalModel(new RealSystem()).catch(() => undefined)]);
  if (choice || model) return true;
  return existsSync("/dev/nvidia0") || existsSync("/proc/driver/nvidia/version") ? "first-run" : false;
}

/** Shown before a GPU box's first run: the picker for the agent plain dl opens is `dl agent`. */
export const GPU_FIRST_RUN_HINT = "· GPU box: dl sets up a model on your GPUs first. Afterwards, dl agent picks the coding agent plain dl opens (Claude Code, OpenCode, Pi or Autopilot).";

/** The router's real parts (router.ts), with MainOptions' replacements. */
function routerDeps(options: MainOptions, io: { out: (text: string) => void; err: (text: string) => void; color?: boolean }): RouterDeps {
  const launchIO = { out: io.out, err: io.err };
  const commands = {
    claude: options.claude ?? claudeCommand,
    opencode: options.opencode ?? opencodeCommand,
    pi: options.pi ?? piCommand,
    t3: options.t3 ?? t3Command,
  };
  return {
    io,
    prompter: options.prompter ?? new TtyPrompter({ color: io.color === true }),
    signIn: () => options.dlKey
      ? options.dlKey().then(async (key) => key ?? (options.signIn ? options.signIn(io) : undefined))
      : dlKeyOrSignIn(io, { migrate: () => dlKeyFromFreeTier(io) }),
    detect: options.detectAgents ?? (() => detectAgents()),
    autopilotInstalled: async () => Boolean(await (options.session?.autopilot ?? findAutopilot)()),
    launch: (command, args) => commands[command](args, launchIO),
    autopilot: (_key, run) => autopilotOnKey({ cwd: process.cwd(), forceAutopilot: true, ...(run.continue ? { continue: true } : {}), ...options.session }, io),
    report: options.reportAgent ?? ((request, key) => reportAgentRequest(request, { key: key.key })),
    dlVersion: packageVersion(),
    // The scan's beat only at a terminal with colour; tests and pipes get it all at once.
    ...(io.color === true ? { sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) } : {}),
    firstTokens: options.firstTokens ?? ((key) => firstTokens(key)),
    models: options.agentModels ?? (async (key) => (await freeTierModels((url, init) => fetch(url, init), key.baseUrl, key.key)).map((model) => model.id)),
  };
}

/**
 * Plain Autopilot here (startHere), downloaded first when it isn't installed, and on the dl key
 * when there is one: AUTOPILOT_DL_FREE_TOKEN always, and dl's plan as its provider only when
 * Autopilot has no provider of its own yet.
 */
async function autopilotOnKey(input: SessionInput, io: { out: (text: string) => void; err: (text: string) => void; color?: boolean }): Promise<number> {
  const key = await readDlKey().catch(() => undefined);
  // A key made from Autopilot's own free tier sign-in (an update from dl 0.47): Autopilot keeps that sign-in.
  if (key && key.source !== "free-tier") Object.assign(process.env, autopilotKeyEnv(key, await autopilotProvider(autopilotConfigFile())));
  return await startHere({ ...(input.autopilot ? {} : { autopilot: () => ensureAutopilot(io) }), ...input }, io);
}
