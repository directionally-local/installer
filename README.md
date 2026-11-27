# Directionally Local installer

dl gives your coding agent open models (DeepSeek, Kimi) on one flat plan. It's a router: run `dl`, sign in through the browser, and it opens the coding agent you already use (Claude Code, OpenCode, Pi, T3 Code, Cursor, Cline, Zed, Codex CLI, Aider, Goose…) on your [dl.new](https://dl.new) plan. [Autopilot](https://github.com/directionally-local/autopilot), dl's own open-source agent, is optional.

On your own server, dl also runs background tasks: each runs in its own [Hotcell](https://github.com/directionally-local/hotcell) sandbox, driven by Autopilot, and comes back as a pull request, even with your laptop closed. On an Nvidia GPU you own, `dl model` sets up an open model, tests it, and connects dl to it; see [On your own GPUs](#on-your-own-gpus).

Where this is going: [the roadmap](docs/ROADMAP.md). Come talk to us on [Discord](https://discord.gg/zeBnJTgcRK).

## Start on your laptop

```sh
curl -fsSL https://dl.new | sh     # or: npm install -g directionallylocal
dl
```

`dl` is the router for your own coding agent. There's nothing to set up first: no Docker, no sandbox, no GitHub token.

1. **Sign in.** The first `dl` signs you in (or up) at dl.new in your browser and keeps your `dl_sk_` key on this computer.
2. **Pick your agent.** dl looks for the coding agents installed on this computer (it only reads directory listings and runs nothing) and asks which one to use: Autopilot, our own agent, first as the recommendation (included in your plan), then *"I also found these on your computer"* with what it found.
3. **It opens on your plan.** Claude Code, OpenCode, Pi, Codex CLI and T3 Code open straight on your key, with your plan's models: DeepSeek V4.1 Flash on Free and Starter, plus Kimi K3.1 on Plus and Max (in Claude Code, Opus is Kimi and Sonnet is DeepSeek, so `/model` switches; in OpenCode, Pi and Codex both are under the `dl` provider). For any other agent (Cursor, Cline, Zed, Roo Code, Kilo Code, Continue, Aider…), dl prints the exact setup: your key and the base URLs `https://api.dl.new/v1` (OpenAI-style) and `https://api.dl.new/anthropic` (Anthropic-style).
4. **It remembers.** The last agent you used is on top next time ("Back to Claude Code?"), so Enter opens it. `dl -c` continues that agent's latest session.

Open one directly with `dl claude`, `dl opencode`, `dl pi`, `dl codex` or `dl t3`. `dl api-key` prints your key and both base URLs again. No agent installed? dl offers Autopilot first, or asks which one you use.

**Autopilot is optional.** It's dl's own open-source agent, listed first as the recommendation. dl downloads it the first time you pick it (or run `dl autopilot`) into `~/.directionallylocal/autopilot`, and `dl update` keeps it on the version dl pins. Background tasks, servers and GPU boxes still use Autopilot, as below.

Update: `dl update`. It updates `dl` when npm has a newer one, with the same installer you used (the install script or npm, so rerunning `curl -fsSL https://dl.new | sh` still works too; for the install script it runs the copy that shipped in the installed `dl` package, never one downloaded at update time), and makes sure the Autopilot it pins is installed. `dl update --check` only says whether there's a newer `dl`. Every "update dl" hint, Autopilot's included, says `dl update`.

Background tasks are the part that needs setting up, and `dl` sets them up the first time you ask for one. `dl run "task"` with nowhere to send it asks one question:

```
  Where should background tasks run?
  › My own server   keeps going when this laptop sleeps · needs SSH access
    This computer   needs Docker Desktop or OrbStack
```

- **My own server** — keeps going when your laptop is closed; needs SSH access. `dl` lists the hosts in `~/.ssh/config` (or takes `user@host[:port]`), checks it over SSH, installs itself there, and pairs this laptop. Nothing is exposed on the server: `dl` reaches it through an SSH tunnel.
- **This computer** — nothing to rent; tasks pause while it sleeps. macOS and Linux, with Docker; not offered on Windows yet (use a server, or WSL 2, which takes the Linux path).

Then it installs Hotcell and Autopilot on the place, builds the sandbox image, starts the services, takes the provider (reusing the one you already picked in Autopilot, or opening Autopilot's picker if there isn't one) and the GitHub token, and sends the task. `dl setup` does the same without a task, for when you'd rather set things up first. What it shows, for this computer:

```
  ✓ Checking this computer   macOS 15.1 · Docker Desktop 29.5.2 · Node 24.22.1 · 120 GB free
  ✓ Installing Hotcell (sandbox SDK) + Autopilot (harness)   Autopilot 3.22.0 · Hotcell 0.1.40
  ✓ Building the sandbox image   Node 24 · Autopilot 3.22.0
  ✓ Starting services     start at login · logs in ~/.directionallylocal/logs
  ✓ Connecting            this computer · tasks pause while it sleeps

  [Autopilot's own provider picker, key entry and model picker]

  ✓ Provider              DeepSeek · deepseek-v4-pro · key stays on this computer
  Use your GitHub CLI login (you)? It stays on this computer. [Y/n]
  ✓ GitHub                signed in as you · from the GitHub CLI
  ✓ Storing keys on this computer   DeepSeek · GitHub

  ✓ Ready · fits ~6 agents at once

  · Sending to this-computer: you/app at 1a2b3c4  deepseek-v4-pro
```

### The provider and model

For background tasks, the provider and model are Autopilot's choice to make too, so `dl` hands over to Autopilot's own picker (`autopilot connect`): any of its providers (OpenRouter, DeepSeek, OpenAI, Anthropic, Moonshot, Z.ai, Ollama, LM Studio, a custom OpenAI-compatible endpoint, …), its key, and its model. The same choice configures your own `autopilot` command. `dl` keeps the model as that place's model (`dl run` and sessions on a server use it unless `-m` names another; on this computer bare `dl` is that same `autopilot`, so it uses what you picked there) and pushes the key to the place:

- **On this computer,** into Hotcell's keystore (a 0600 file under `~/.directionallylocal/hotcell`, not the login Keychain).
- **On a server,** over the same SSH channel the install used, into Hotcell's keystore there.

Keys stay on the place. Sandboxes get spend-capped gateway tokens from Hotcell instead; your laptop never holds a provider key for a place. Keyless providers (Ollama, LM Studio) store no key. Change the provider later with `dl provider set`, the model with `dl model`.

Signed in to the free tier in Autopilot? Background tasks reuse it: setup makes a server key for the place (named after it) and stores that, so the place keeps working after the one-hour access token expires. Change it later with `dl provider set`.

### The GitHub token

Background tasks push branches and open pull requests through GitHub, so each place needs a token; a plain `dl` session never asks for one. `dl` offers your GitHub CLI login (`gh auth token`) as *"Use your GitHub CLI login (you)? It stays on this computer."*; without one it says so in one line and asks for a fine-grained token with Contents and Pull requests read/write. The token stays on the place too; sandboxes push through Autopilot's repository-scoped proxy.

### Then a session

`dl setup` ends with one line, `✓ Ready · fits ~6 agents at once`, and opens a session at once. What bare `dl` opens depends on where your agents run (the default place, `dl use`; `--server NAME` picks another). With nothing set up, it's the router, as for this computer:

**On this computer, `dl` is the router.** It opens the coding agent you pick (the last used is on top) in the terminal, in the folder you ran it from, on your dl plan, with that agent's own config. Any folder works, git or not, and the agent edits the folder directly. Every `dl` is a new session; `dl -c` continues the last used agent's latest session. If you pick Autopilot, `dl` is plain `autopilot`: every Autopilot feature works (`/resume`, `/clear`, `!` shell commands, MCP servers), and anything after `--` goes to it as is (`dl -- --session ID`).

**On a server, `dl` is a session that keeps running.** Autopilot's screen attaches to a conversation on the server (`autopilot attach-remote`) that carries on after you close the terminal. Inside a GitHub repository it's that repository's code session (your uncommitted changes go along; `--no-local-changes` sends none); anywhere else, a chat. Every `dl` starts a new conversation; `dl -c` reopens the latest one started from this folder on that server. When an earlier one from this folder is still working or waiting for you, `dl` says so in one line before connecting (`1 earlier session here is still working · dl -c to rejoin`). In a git repository whose origin isn't on GitHub, it says so in one line and opens a chat instead.

**Either way, `dl run "task"` is the background, sandboxed path.** It sends the task to the place, where it runs in a Hotcell sandbox, keeps going after the terminal closes, and ends in a pull request.

```sh
dl                                  # this computer: the agent you pick. A server: its session (repository or chat)
dl -c                               # this computer: continue that agent. A server: the latest session from this folder
dl -- --session <id>                # this computer: pass flags through to Autopilot
dl --server box                     # a session on the server named box, whatever the default
dl new                              # the same as bare dl (kept as an alias for a release)
dl run "fix the flaky checkout test"  # background task in a sandbox; your uncommitted changes go along
dl runs                             # tasks and their pull requests
dl pull <id>                        # check one out here
dl status                           # where agents run, their provider, model and versions, what they're doing
```

`dl status` says when a place runs another Autopilot or Hotcell than this laptop's `dl` pins: `! box runs Hotcell 0.1.30, this dl pins 0.1.40   dl update box`.

When Autopilot here uses the free tier, `dl status` also shows the account: who is signed in (`@octo`), the tokens left this week, and when the week resets (local time). When free usage runs out, Autopilot's `/upgrade` offers dl Pro or a one-time top-up. dl reads Autopilot's sign-in and asks the free tier service once (`GET /v1/me`, 3 seconds at most, never refreshing the sign-in); if that fails it shows only `@octo`, or nothing. It also shows the free model Autopilot uses, with its provider and measured speed (`Free model DeepSeek V4.1 Flash · Luminal · ~85 tok/s`), from the public `GET /v1/providers` (2 seconds at most).

The "fits ~N agents" figure is a conservative estimate: memory left after the host's own share (at least 1.5 GB or 15%), divided by 1 GB per sandbox, capped at two per CPU. Measured numbers will replace it.

### One Autopilot and one Hotcell version

`dl` bundles `autopilot-ai` at an exact version (its session client) and pins `hotcell` exactly too, and installs those same versions on every place it sets up, including the sandbox image, so the client and the server never drift and two people installing the same `dl` get the same sandboxes. `dl update NAME` brings a place back to both pins: a server gets its `dl` refreshed first (the install script, at this laptop's own `dl` version, so both ends match) and then `dl up`; this computer re-runs its setup. Setting up a server installs this laptop's `dl` version there too, never npm's latest. When the laptop's own `dl` is behind npm, `dl update NAME` says so: `dl update` with no name updates it.

## Commands

`dl` is short for `directionallylocal`; both work.

### On your laptop

| Command | What it does |
| --- | --- |
| `dl` | On this computer: the router. Signs in through the browser the first time, finds the coding agents installed here and opens the one you pick on your dl plan (the last one used is on top). On a server: inside a GitHub repository, that repository's Autopilot session; anywhere else, a chat; it keeps running when you leave. |
| `dl -c`, `dl --continue` | On this computer, continue the last used agent's latest session. On a server, reopen the latest conversation started from this folder there. |
| `dl autopilot [ARGS]` | Autopilot, dl's own open-source agent (optional): downloaded the first time, then kept on the version dl pins. `dl -- ARGS` and `-m` also go to Autopilot. |
| `dl login` / `dl logout` | Sign in to dl.new in the browser (the key is kept in `~/.config/directionallylocal/dl-key.json`), or sign out. |
| `dl --from-claude-code` | Continue this folder's latest Claude Code conversation in a new Autopilot session on this computer (`autopilot --from-claude-code`): it asks first, then sends your last request, the files changed, commands run and Claude's last message as the first message. The transcript is read here and goes only to your model. |
| `dl claude [ARGS]` | Your own Claude Code on your dl plan. See [Claude Code with free tokens: dl claude](#claude-code-with-free-tokens-dl-claude). |
| `dl opencode [ARGS]` | Your own OpenCode on your dl plan. See [OpenCode with free tokens: dl opencode](#opencode-with-free-tokens-dl-opencode). |
| `dl pi [ARGS]` | Your own Pi on your dl plan. See [Pi with free tokens: dl pi](#pi-with-free-tokens-dl-pi). |
| `dl codex [ARGS]` | Your own Codex CLI on your dl plan. See [Codex CLI on your plan: dl codex](#codex-cli-on-your-plan-dl-codex). |
| `dl api-key [NAME]` | Your dl key for any other tool (Cursor, Cline, Roo, Kilo, Continue, Zed, Aider, OpenCode…), with the base URLs `https://api.dl.new/v1` and `https://api.dl.new/anthropic`. More keys at [dl.new/keys](https://dl.new/keys). `dl api-key list`, `dl api-key revoke ID`. See [Use dl's free tokens in other tools](#use-dls-free-tokens-in-other-tools-dl-api-key). |
| `dl conductor` | [Conductor](https://conductor.build) (and Zed, Cline and other desktop apps) on dl's free tokens: starts `dl proxy` if it isn't running and prints the settings to paste into the app. See [Desktop apps with free tokens: dl proxy and dl conductor](#desktop-apps-with-free-tokens-dl-proxy-and-dl-conductor). |
| `dl proxy start` / `stop` / `status` | A local proxy on `127.0.0.1:4789` that desktop apps use for the free tier, with a local token as their API key. `dl proxy run` runs it in the terminal; `dl proxy install` / `uninstall` start it at login (macOS LaunchAgent, Linux systemd user service). |
| `dl zed` | Add dl (Autopilot) to [Zed](https://zed.dev) as an external agent: signs in to the free tier first if Autopilot has no provider, backs up Zed's `settings.json` and adds one `agent_servers` entry, changing nothing else. `dl zed remove` takes it out; `dl zed --print` shows the entry. See [Editors: dl zed and dl acp](#editors-dl-zed-and-dl-acp). |
| `dl acp [ARGS]` | Autopilot as an ACP (Agent Client Protocol) agent on stdio: the command an editor runs (Zed, T3 Code's "Local ACP command", JetBrains). |
| `dl t3 [ARGS]` | Your own [T3 Code](https://github.com/pingdotgg/t3code) server (web and phone clients) with its Claude Code and OpenCode agents on dl's free tokens while `dl t3` runs. See [T3 Code with free tokens: dl t3](#t3-code-with-free-tokens-dl-t3). |
| `dl claude-code hook install` / `remove` | Opt in to a Claude Code hook that, when Claude Code stops on a usage or rate limit, shows `Claude Code hit its limit. Continue in dl: dl --from-claude-code` as a terminal notification and window title. Shows the entry and asks before adding it to `~/.claude/settings.json`, backs the file up first, and merges into it; `remove` takes out only dl's entry. |
| `dl setup` | Set up or repair where background tasks run. Safe to re-run. `--identity FILE` names the SSH key to use. |
| `dl new` | The same as bare `dl`: a new session here. Kept as an alias for a release. |
| `dl status` | Where your agents run, their provider, model and Autopilot and Hotcell versions (next to this laptop's pins), and what they're doing. Works anywhere. |
| `dl connect URL` | Connect to a server someone else set up; approve the code it shows. |
| `dl run "TASK"` | Run a task in a sandbox on the place, in the background, from inside a GitHub repository; it ends in a pull request. Ctrl-C stops watching, not the task. The first time, it asks where tasks run and sets that up. |
| `dl runs` | Your tasks and their pull requests. `--json` for scripts. |
| `dl watch ID` / `dl cancel ID` | Follow a task, or stop one. |
| `dl pull ID` | Check out a task's branch here. |
| `dl preview ID` | Deploy a task's Workers branch on the server with Serverless Objects and open it here, over the SSH tunnel. |
| `dl servers` | Where agents run. `dl servers rename OLD NEW`, `dl servers remove NAME`. |
| `dl use [NAME]` | Where tasks and bare `dl` go without `--server`. With no name, shows it. |
| `dl provider` | The provider and GitHub token on each place. `dl provider set` picks another provider, key and model in Autopilot's list; `dl provider github` replaces the GitHub token. `--server NAME` picks the place. `dl keys` is the same command. |
| `dl model [ID]` | The model for tasks and sessions on a place. With no ID, Autopilot's own model picker. For a model served on this machine's GPU, see `dl model up` below. |
| `dl models` | The free tier's models: provider, context, access ("Pro" marks a dl Pro only model, e.g. Kimi K3.1 Pro), status, and the speed and first-token time measured every 10 minutes (`GET /v1/providers`). `--json` for scripts. |
| `dl model up` / `update` / `rollback` / `status` / `bench` / `list` | Serve a curated open model on this machine's Nvidia GPUs with vLLM or SGLang, test it, and point Autopilot at it. See [On your own GPUs](#on-your-own-gpus). |
| `dl evals set "COMMAND"` / `--data PATH` / `run` / `show` / `clear` | Your own eval command, run once per model with `OPENAI_BASE_URL` pointed at it, or your eval data (promptfoo configs and tests, JSONL, CSV, OpenAI Evals, Braintrust, LangSmith), run with promptfoo; `dl model update` switches only if the new model holds up. See [Your own evals](#your-own-evals). |
| `dl ui` / `share` / `invite` / `approve` / `status` / `logs` / `down` | Open WebUI as your team's chat, next to the models on this machine. See [Team chat: dl ui](#team-chat-dl-ui). |
| `dl update` | Update `dl` itself when npm has a newer one (the install script or npm, however it was installed; `--check` only reports), make sure the Autopilot it pins is installed, then update the default place as `dl update NAME` does. |
| `dl update NAME` | Update a place's Autopilot, Hotcell and sandbox image to the versions `dl` pins. A server over SSH (its `dl` first), this computer in place. `--wait` waits for running tasks instead of asking; with no terminal it waits anyway. |
| `dl local status` | Agents running on this computer: running?, where, how many fit. |
| `dl local uninstall [--purge]` | Stop and remove them. `--purge` also deletes keys and data. |
| `dl uninstall [--purge] [--yes]` | Remove dl from this computer. Lists what it will remove and asks first (`--yes` doesn't ask; with no terminal it needs `--yes`). Signs out of the free tier, stops agents set up with `dl setup` on this computer, takes dl's hook out of Claude Code's settings, removes the two lines the install script added to your shell startup file (keeping a `.dl-uninstall.bak` copy), the `dl` links in `~/.local/bin` and `~/bin` that point into `~/.directionallylocal`, `~/.config/directionallylocal`, and `~/.directionallylocal` itself (or `DL_HOME`). `--purge` also removes Autopilot's settings, sign-ins and history (`~/.config/autopilot`, `~/.local/share/autopilot`, `~/.local/state/autopilot`); projects' `.autopilot` folders stay. |

Run options: `--server NAME`, `-m/--model MODEL`, `--repo OWNER/NAME`, `--detach`.

### Claude Code with free tokens: dl claude

`dl claude` starts the Claude Code you already have, on the free tier instead of your Anthropic
account. Every argument after `claude` goes to it unchanged (`dl claude -p "fix the test"`,
`dl claude --resume`), and its exit code is dl's.

- **Sign-in:** the same free tier sign-in as `dl` and Autopilot. If you aren't signed in, it runs
  that sign-in first (which also makes the free tier Autopilot's provider; `/provider` changes it).
- **Claude Code itself:** dl never installs it. Without `claude` on your PATH it prints the
  official install command (`curl -fsSL https://claude.ai/install.sh | bash`) and stops.
- **The model:** DeepSeek V4.1 Flash for every request, whatever model Claude Code names.
- **Only while dl claude runs:** dl gets a key that lasts 15 minutes, refreshes it while Claude
  Code runs and ends it when Claude Code exits. It's in Claude Code's environment only, never on a
  command line. Free tokens don't work in Claude Code started any other way, except through
  `dl proxy` (below).
- **The full free allowance:** Claude Code gets your whole weekly free allowance (and the
  new-user trial), the same as Autopilot, counting everything you used that week. With dl Pro,
  Claude Code gets your whole Pro allowance; top-ups work as in any other agent.
- **Your settings stay yours:** nothing under `~/.claude` is read or changed. For this run only,
  Claude Code gets `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`,
  `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`,
  `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`,
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`.
  Your own `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` and similar variables are left out of
  Claude Code's environment for that run, and dl says which. A settings file's `env` block or
  `apiKeyHelper` would win over them, so before it starts, dl reads (never writes)
  `~/.claude/settings.json`, `$CLAUDE_CONFIG_DIR/settings.json` and this folder's
  `.claude/settings.json` and `.claude/settings.local.json`. If one sets `env.ANTHROPIC_API_KEY`,
  `env.ANTHROPIC_AUTH_TOKEN`, `env.CLAUDE_CODE_OAUTH_TOKEN` or `apiKeyHelper`, `dl claude` doesn't
  start and names the file and setting (never the value), so your Anthropic key isn't sent to the
  free tier. Remove it to use `dl claude`, or set `DL_ALLOW_CLAUDE_SETTINGS_KEY=1` to start anyway.
  `dl t3`, and Claude Code opened on a box's own model, check the same.
- **What dl sends:** a session start and end (counts only, as Autopilot does), and a refresh every
  few minutes. With `DL_NO_TELEMETRY=1`, `DO_NOT_TRACK=1` or a `CI` variable, only a bare session
  start (its id and time, again every 6 hours), which the free tier needs to tell dl's use of free
  tokens from another tool's; no session end, OS or duration. Prompts and code go to the model, never into dl's logs. To prevent abuse, the free
  tier keeps a short automated description of each session and a safety label, made from your
  latest message and kept for 90 days.
- **Not supported:** images and PDFs (DeepSeek can't read them; Claude Code is told they were left
  out), Anthropic's server tools such as web search, and prompt caching controls (the provider
  caches on its own).

### Desktop apps with free tokens: dl proxy and dl conductor

Desktop apps that dl doesn't start, such as [Conductor](https://conductor.build) (which runs Claude
Code in git worktrees), can't get the short-lived key `dl claude` gives Claude Code. `dl proxy`
covers them: a small server on this computer that holds your free tier sign-in and forwards the
app's requests to the free tier.

```sh
dl conductor        # starts dl proxy if needed and prints the settings below, with your token
```

In Conductor, Settings → Environment:

```
ANTHROPIC_BASE_URL=http://127.0.0.1:4789
ANTHROPIC_AUTH_TOKEN=<the local token dl conductor prints>
```

Take out `ANTHROPIC_API_KEY` if it's set there, and leave the model alone: whatever Claude Code
asks for, the free tier answers with DeepSeek V4.1 Flash.

- **Other apps:** Zed, Cline in VS Code and other OpenAI-compatible apps on this computer use base
  URL `http://127.0.0.1:4789/v1`, the local token as API key, and model
  `deepseek/deepseek-v4.1-flash-1017`. Anthropic-format apps use `http://127.0.0.1:4789`.
  **Cursor doesn't work through the proxy:** it sends requests for a custom OpenAI base URL from
  its own servers, which can't reach your computer. Use [`dl api-key`](#use-dls-free-tokens-in-other-tools-dl-api-key)
  for Cursor (or any app): an API key that needs nothing running on your computer.
- **What it serves:** `POST /v1/messages` and `/v1/messages/count_tokens` (Anthropic format,
  counted as Claude Code) and `POST /v1/chat/completions` and `GET /v1/models` (OpenAI format,
  counted as OpenCode). Streams pass through as they come. Like `dl claude` and `dl opencode`,
  these get the full weekly free allowance, the same as any other agent.
- **Keys:** for each format, a 15-minute key from the free tier made on first use, refreshed every
  few minutes while the app uses it, ended after 20 idle minutes and when the proxy stops, with
  session start and end events as `dl claude` sends. The key never leaves the proxy.
- **Who can use it:** only this computer, and only programs that know the local token. It listens
  on 127.0.0.1 only; every request must send the token (a random 256-bit string in
  `~/.local/state/directionallylocal/proxy/token`, mode 0600) as its API key; requests from
  browsers (any `Origin` or `Sec-Fetch-Site` header, CORS preflights) are refused, and the `Host`
  must be `127.0.0.1`, `localhost` or `[::1]` with the proxy's port, so web pages can't reach it,
  DNS rebinding included. The token isn't your free tier sign-in; delete the file and restart the
  proxy to get a new one.
- **Running it:** `dl proxy start` runs it in the background (log in
  `~/.local/state/directionallylocal/proxy/proxy.log`: method, path, status and time only, never
  content), `dl proxy stop` stops it, `dl proxy status` says what it has served. `dl proxy run`
  keeps it in the terminal. `dl proxy install` starts it at login (a LaunchAgent on macOS, a
  systemd user service on Linux; on a Linux box without a desktop login, also
  `loginctl enable-linger`); `dl proxy uninstall` removes that. `--port N` (or `DL_PROXY_PORT`)
  picks another port.

### Use dl's free tokens in other tools: dl api-key

If dl's sign-up gave you free tokens, you can use them in any tool that speaks OpenAI's or
Anthropic's API (Cursor, Cline, Roo Code, Kilo Code, Continue, Zed, Aider, OpenCode…), with no dl
running and from the same weekly allowance.

```sh
dl api-key cursor   # makes an API key named "cursor" and prints it once, with the settings below
```

| your tool speaks | base URL | API key | model |
|---|---|---|---|
| OpenAI's API | `https://api.dl.new/v1` | the `dlk_…` key | `deepseek/deepseek-v4.1-flash-1017` |
| Anthropic's API | `https://api.dl.new/anthropic` | the `dlk_…` key | any: DeepSeek answers |

Try it in one line:

```sh
curl https://api.dl.new/v1/chat/completions -H "Authorization: Bearer $DL_API_KEY" \
  -H "content-type: application/json" -d '{"model":"deepseek/deepseek-v4.1-flash-1017","messages":[{"role":"user","content":"hi"}]}'
```

- **Models:** DeepSeek V4.1 Flash, and the free tier's other models except GPT-6
  (`GET /v1/models` lists them). GPT-6.1 Sol is available in Autopilot for now.
- **Allowance:** the same full weekly free allowance as every other agent.
- **Managing keys:** `dl api-key list` shows your keys (never their secrets), `dl api-key revoke
  ID` deletes one and it stops working at once. At most 3. Unlike `dl proxy`, nothing has to run
  on your computer, so Cursor works too.
- **Who can make one:** anyone whose account has free tokens; not for blocked accounts. The usual
  rules hold: no account-pooling routers, and the same automated abuse checks as in dl.
- **Your dl sign-in stays dl's:** the sign-in token Autopilot keeps is for Autopilot; other
  tools get their own API key instead, so each can be revoked on its own.

### OpenCode with free tokens: dl opencode

`dl opencode` starts the [OpenCode](https://opencode.ai) you already have, on the free tier.
Every argument after `opencode` goes to it unchanged (`dl opencode run "fix the test"`,
`dl opencode --continue`), and its exit code is dl's.

- **Sign-in:** the same free tier sign-in as `dl` and Autopilot, run first if you aren't signed in.
- **OpenCode itself:** dl never installs it. Without `opencode` on your PATH it prints the
  official install command (`curl -fsSL https://opencode.ai/v2/install | bash`, or
  `npm install -g @opencode/cli`) and stops.
- **The models:** the free tier serves DeepSeek V4.1 Flash, as provider "dl" in OpenCode's
  `/models` (the default, with its context and output limits); session titles use it too.
  Free GPT-6 (Luna, Sol, Astra) is available in Autopilot for now. In OpenCode, you can use
  GPT-6 with your own OpenAI or OpenRouter key, as one of your own providers. Your
  own providers stay in `/models`, on your own keys.
  Only listed models can be picked: `dl opencode -m dl/<a model the free tier doesn't serve>` fails
  inside OpenCode ("Model unavailable", or "UnknownError … Unexpected server error" in older
  versions) before any request is sent. OpenCode has no option to pass unlisted models through to a
  provider, so use one of the `dl/…` models in `/models`, or your own provider for anything else.
- **Only while dl opencode runs:** the same 15-minute key as `dl claude`, refreshed while OpenCode
  runs and ended when it exits; free tokens don't work in OpenCode started any other way.
- **The full free allowance:** OpenCode, like Claude Code and Autopilot, gets your whole weekly
  free allowance (see `dl claude` above).
- **Your settings stay yours:** no OpenCode file is read or changed. For this run only, OpenCode
  gets `OPENCODE_CONFIG_CONTENT` (inline config that adds the "dl" provider and makes
  `dl/deepseek/deepseek-v4.1-flash-1017` the model, merged above your global and project config) and the key in
  `DL_FREE_TIER_KEY`, which that config reads; a `OPENCODE_CONFIG_CONTENT` of your own is left out
  for that run, and dl says so.
- **A private OpenCode server:** OpenCode 2 normally runs sessions in a shared background server,
  which wouldn't see that config, so dl starts it with `--standalone` (OpenCode 1 needs nothing).
  `--server URL` can't be used with `dl opencode`.
- **What dl sends:** a session start and end (counts only), and a refresh every few minutes.
  Prompts and code go to the model, never into dl's logs. To prevent abuse, the free tier keeps a
  short automated description of each session and a safety label, made from your latest message
  and kept for 90 days.

### Pi with free tokens: dl pi

`dl pi` starts the [Pi](https://github.com/earendil-works/pi) you already have, on the free tier.
Every argument after `pi` goes to it unchanged (`dl pi -p "fix the test"`, `dl pi -c`), and its
exit code is dl's.

- **Pi itself:** dl never installs it. Without `pi` on your PATH it prints
  `npm install -g @earendil-works/pi-coding-agent` and stops.
- **The models:** provider "dl" in Pi's `/model`, DeepSeek V4.1 Flash (GPT-6.1 Sol is available in
  Autopilot for now). Pass your own `--model`, `--models` or `--provider` and
  dl leaves the choice to you; your own providers stay in `/model`, on your own keys.
- **Only while dl pi runs, on the full free allowance:** the same 15-minute key, allowance and rules
  as `dl opencode`.
- **Your settings stay yours:** nothing under `~/.pi` is read or changed. For this run only, Pi
  loads a small extension (`pi -e`, a temporary file removed when Pi exits) that adds the "dl"
  provider; the key is in `DL_FREE_TIER_KEY`, never in a file or on the command line.
- **What dl sends:** the same as `dl opencode`; each Pi session's id goes with its requests.

### Codex CLI on your plan: dl codex

`dl codex` starts the [Codex CLI](https://github.com/openai/codex) you already have, on your dl
plan. Every argument after `codex` goes to it unchanged (`dl codex exec "fix the test"`,
`dl codex resume --last`), and its exit code is dl's.

- **Codex itself:** dl never installs it. Without `codex` on your PATH it prints
  `npm install -g @openai/codex` and stops.
- **How it talks to dl:** Codex speaks only the OpenAI Responses API, which dl serves at
  `https://api.dl.new/v1/responses` on the same plan, limits and models as every other agent.
- **The models:** provider "dl", DeepSeek V4.1 Flash by default, the plan's others (Kimi K3.1 on
  Plus and Max) by id in `/model` or `-m`. Pass your own `-m`/`--model`, `--oss`, `-p`/`--profile`
  or `-c model_provider=…` and dl leaves that choice to you. Codex warns once that it has no
  metadata for the model; that's expected for any model it doesn't ship with.
- **Your settings stay yours:** `~/.codex/config.toml` isn't read or changed. For this run only,
  dl passes Codex `-c` overrides that add the "dl" provider (`wire_api = "responses"`) and turn
  off hosted web search (dl has none); your sessions, `codex resume`, MCP servers and AGENTS.md
  work as before. The key is in `DL_API_KEY`, never in a file or on the command line.
- **By hand:** the same provider in `~/.codex/config.toml`, with your key from `dl api-key` in
  `DL_API_KEY`:

  ```toml
  model = "deepseek/deepseek-v4.1-flash-1017"
  model_provider = "dl"
  web_search = "disabled"

  [model_providers.dl]
  name = "dl"
  base_url = "https://api.dl.new/v1"
  env_key = "DL_API_KEY"
  wire_api = "responses"
  ```

- **Not supported:** `previous_response_id` (dl keeps no responses; Codex always sends the whole
  conversation, so it isn't needed), hosted tools (web search, image generation) and remote
  compaction (Codex compacts locally with a custom provider).

### T3 Code with free tokens: dl t3

`dl t3` starts the [T3 Code](https://github.com/pingdotgg/t3code) server you already have (the
`t3` command) with its Claude Code and OpenCode agents on the free tier, the same way `dl claude`
and `dl opencode` set them up. Every argument after `t3` goes to it unchanged (except dl's own
`--dl-enable-opencode`, below), and its exit code is
dl's: `dl t3` opens the web app in your browser, `dl t3 serve` runs it without a browser (for a
server or tmux), `dl t3 ./my-project` starts in that folder.

- **T3 Code itself:** dl never installs it. Without `t3` on your PATH it prints the official
  install command (`curl -fsSL https://t3.codes/install.sh | sh`, or `npm install -g t3`) and
  stops. Claude Code and OpenCode must be installed too, as T3 Code needs them.
- **Both agents, each counted as itself:** dl gets two short-lived keys, one for Claude Code and
  one for OpenCode, refreshed while `dl t3` runs and ended when it stops, so each agent's requests
  count as that agent's, on the same full weekly allowance as `dl claude` and
  `dl opencode`. Free tokens stop working in T3 Code when `dl t3` stops.
- **Picking the model:** for OpenCode, pick a `dl/…` model in T3 Code's model picker
  (`dl/deepseek/deepseek-v4.1-flash-1017`). For Claude Code, T3 Code still shows Claude models;
  whichever you pick, the free tier serves it with DeepSeek.
- **OpenCode is off in new T3 Code installs:** at a terminal, `dl t3` asks before turning it on in
  `~/.t3/userdata/settings.json` (only `providerInstances.opencode` changes, and the first change
  keeps a `.dl-backup`). Without a terminal it leaves the file alone unless you pass
  `--dl-enable-opencode` (dl takes that flag out; `t3` never sees it). Or turn it on yourself in
  **Settings → Providers**. Leave its **Server URL** empty, so T3 Code starts OpenCode itself with
  dl's settings.
- **Your settings stay yours:** apart from that one setting, no T3 Code, Claude Code or OpenCode
  file is changed. T3 Code gets the environment variables `dl claude` and `dl opencode` give those
  agents, for this run only. Environment variables you set on a provider instance in T3 Code's settings win over
  dl's for that instance.
- **The web app and phone, not the desktop app (yet):** only the server `dl t3` starts has free
  tokens. The T3 Code desktop app opened from the Dock or Start menu, and the background service
  (`t3 service`, `t3 up`), run without dl, so dl refuses those commands. `dl proxy` (above) is how
  desktop apps reach the free tier; `dl t3` doesn't set the desktop app up for it yet. If T3 Code says a server is already running (often the
  desktop app or the service), quit it first, or start `dl t3 --base-dir DIR` for a separate one.
  Commands that talk to a running server (`t3 thread`, `t3 pair`, `t3 project`) work as usual: run
  them as `t3 …`.

### Editors: dl zed and dl acp

`dl acp` is `autopilot acp` with the Autopilot dl comes with: Autopilot as an
[Agent Client Protocol](https://agentclientprotocol.com) agent, which editors start and talk to
over stdio. It is Autopilot itself, not another agent on dl's free tokens: your own Autopilot
config, provider and model, hooks, MCP servers and sessions, and on the free tier its requests are
Autopilot's own, with Autopilot's whole allowance. Threads are Autopilot sessions
(`dl -- resume ID` reopens one in the terminal).

- **Zed:** `dl zed` adds it under `agent_servers` in Zed's `settings.json` (`~/.config/zed`, or
  `%APPDATA%\Zed` on Windows) as this Node running dl's script with `acp`, so it starts whatever
  PATH Zed sees. It backs the file up first (`settings.json.dl-backup-…`), keeps your comments and
  other settings, and writes through a symlinked file. Run it again after moving Node (a new nvm
  version). If Autopilot has no provider yet it runs the free tier sign-in first; otherwise Zed
  uses the provider Autopilot already has. Then pick **Autopilot by dl.new** in Zed's Agent Panel.
- **T3 Code and other ACP clients:** use `dl acp` as the agent command (T3 Code: add a provider,
  **Local ACP command**). The README of [Autopilot](https://github.com/directionally-local/autopilot#use-dl-in-zed-acp)
  lists what works over ACP.
- With no provider set up, the editor offers **Sign in to dl**: `dl acp --login` in a terminal
  (the free tier's GitHub sign-in), or in the browser.

### On your own GPUs

`dl model` runs an open model on an Nvidia GPU you own and keeps it updated safely. `dl model up` checks the GPU, Docker and the Nvidia container toolkit, lets you pick a model that fits, starts it with vLLM in Docker, tests that it answers correctly, and points Autopilot at it. `dl model update` tests a new model next to the old one and switches only if it passes; `dl model rollback` undoes it. Your code, prompts and weights stay on your hardware.

It needs an Nvidia driver, Docker, and the Nvidia container toolkit; `dl model up` checks all three and says what's missing. Most catalog models run on one GPU, so what fits them is decided per GPU; the multi-GPU entries count every GPU (or the `--gpus` ones) and say how they'll be split.

| Command | What it does |
| --- | --- |
| `dl model up [MODEL] [--dry-run]` | Show the GPU and driver, list the catalog models that fit, ask for the context length and port (8000), and start `vllm/vllm-openai` as `dl-model-1` with the catalog's flags and a shared Hugging Face cache. Progress shows the download and vLLM starting, then four tests: chat, speed, a tool call and JSON. The first answer from a freshly started vLLM may take up to 120 seconds. When they pass, it saves the deployment and sets Autopilot's `vllm` provider to `http://127.0.0.1:<port>/v1`. |
| `dl model update [MODEL] [--dry-run]` | Start the replacement as the other container on port+1 when the GPU has room for both; otherwise warn about downtime and ask. Test the new one, re-test the old one, compare their speed over 512 tokens, run [your evals](#your-own-evals) on both when they're set (`--skip-evals` skips them), then switch the provider and stop the old container, keeping its config for rollback. If the new one fails, the old one keeps serving. |
| `dl model rollback` | Restart the previous deployment and switch the provider back. |
| `dl model status` | The running model, its address, the GPU and its free memory, and the last test results. |
| `dl model bench` | Time to first token (p50 and p95) and decode speed with 1, 8 and 32 requests at once, plus the prefix cache hit rate from vLLM's logs. |
| `dl model list` | Every deployment on this machine: name, model, engine, GPUs, port, status, and its sandbox if it has one. |
| `dl model up MODEL --workspace DIR [--allow-internet]` | Also run Autopilot in a Hotcell sandbox that sees only `DIR` and reaches only the model. See [One box: the model and a sandboxed agent](#one-box-the-model-and-a-sandboxed-agent). |
| `dl model attach [-- ARGS]` | Open Autopilot in that sandbox (`dl model attach -- -c` continues the last session). |
| `dl model down` | Stop and remove the deployment's containers, and its sandbox and networks; `DIR` is kept. |
| `dl model up MODEL --plan [--hardware DIR]` | Print the exact `docker run` command, the GPUs it would use, the parallel layout and the memory math (weights per GPU, KV cache, buffers, host RAM for offloaded weights, disk), and whether it fits, without running, downloading or writing anything. It reads `nvidia-smi`, `/proc/meminfo`, `df` and the weights' size from the Hugging Face API (never Docker). `--hardware DIR` plans for another machine from its command output (the format of `src/test-support/fixtures/gpu`), with no probes and the catalog's recorded weight size. Exits 1 when it doesn't fit. |

Options: `--name NAME` makes or picks a separate deployment (update, rollback, status and bench then target it); `--gpus 0,1` pins it to those GPUs; `--port PORT` and `--context TOKENS` answer the questions up and update ask.

Before anything downloads, `up` and `update` check that a model with known sizes fits (VRAM per GPU, host RAM, disk, driver) and say exactly what's short and the nearest option that fits. `--dry-run` prints every Docker command without running it. The catalog lives in `src/model-catalog.ts`: each entry pins the Hugging Face repo, minimum GPU memory, the engine's image tag, and flags (tool-call parser, reasoning parser, max model length, quantization). Today it has two Qwen 3 4B versions (an older and a newer one, handy for trying `update`), both tested end to end on a real GPU, and GLM-4.7-Flash for a 48 GB card, not yet tested. For several GPUs it has DeepSeek V4.1 Flash (1017) in FP8 (vLLM, Engram tables in host RAM) and FP4 (SGLang; planned only until an engine release loads it), and GLM-5.3-Flash; these are untested on real hardware, and each flag cites its source in the catalog.

```sh
dl model up                 # pick from what fits; defaults to port 8000
dl model update qwen-old    # test another model, then switch
dl model rollback           # back to the previous one
dl model status
dl model bench
```

**When something fails.** The first line says which step failed and why. A container that started is kept running so you can look at it (`docker logs dl-model-1`), with the command to remove it, and running the same command again reuses it while it still answers. A failed test also prints a `curl` line that sends the same request, so you can reproduce it by hand. Autopilot's provider and the saved state are put back as they were. Every `dl model` run writes a log to `~/.directionallylocal/logs` (a failed one includes the end of vLLM's own log), and the error names the file.

**From Autopilot's first run.** When `dl` starts Autopilot for the first time on a machine with an Nvidia card of 24 GB or more, Autopilot offers to run a private model on it. A yes runs this same setup: it checks Docker, offers to install the Nvidia container toolkit when it's missing (Ubuntu and Debian, with sudo), shows every catalog model with whether it fits this GPU and whether it was tested, and then runs `dl model up` with the default context and port. A failure opens a menu to retry, see what failed, pick another model, or carry on without a local model. Autopilot's **Use your own GPUs** answer also covers GPUs elsewhere: run `dl model up` on another server of yours and reach it through an SSH tunnel, or enter the address of a vLLM or other OpenAI-compatible server you already run.

#### One box: the model and a sandboxed agent

On a GPU server set up with `sudo dl up`, one command runs the model and Autopilot next to it, isolated to one project directory:

```sh
sudo dl model up deepseek-v4.1-flash-fp8 --workspace /srv/project --plan   # both halves, nothing run
sudo dl model up deepseek-v4.1-flash-fp8 --workspace /srv/project
sudo dl model attach                                                      # Autopilot, in /srv/project
```

It first checks the sandbox's needs: dl's server install, Hotcell 0.1.40 or newer, root, and a workspace outside home and system directories. Then it starts the model exactly as `dl model up` does, with the same preflight, layout, `docker run` and tests. Once the tests pass, it adds the sandbox:

- **Two host directories.** A Hotcell cell (container driver, the image `dl up` builds for agent sessions) gets `DIR` bind-mounted read-write at `/workspace`, and the agent's home, `/var/lib/directionallylocal/workspaces/NAME/home`, read-write at `/home/agent`; nothing else from the host: no host home directory, no Docker socket, no GPU. dl adds `DIR` to Hotcell's `HOTCELL_WORKSPACE_ROOTS` and `/var/lib/directionallylocal/workspaces` to `HOTCELL_HOME_ROOTS` (Hotcell refuses any other directory) and restarts `hotcell.service`.
- **The folder's owner.** The agent runs as the uid:gid that owns `DIR` (Hotcell's `--user`), so the files it writes are theirs; as root only when root owns `DIR`. `dl model attach` runs Autopilot as that user too. HOME is `/home/agent` and USER is `dl`, so nothing needs a passwd entry for the uid.
- **Only the model.** The cell's only network is `dl-model-net`, a Docker `--internal` network with no host address on it: no route off the box and no host services. The model's container joins it as `model`, so Autopilot's provider is `http://model:8000/v1`, with no key. The model still publishes only on `127.0.0.1`. Hotcell's key gateway isn't wired, so the cell holds no tokens. `--allow-internet` adds a second network, `dl-model-net-egress`, with only the cell on it, for git and npm. Like any container on a bridge, it can then reach host ports bound to all addresses.
- **Nothing dl writes is in `DIR`.** HOME and every XDG directory (Autopilot's config, sessions and caches) are in the agent's home, made by dl before the cell starts, owned by the user, mode 0700: `/var/lib/directionallylocal/workspaces/NAME/home/.config/autopilot/config.json` names the model and `http://model:8000/v1`. A `DIR/.dl` left by dl 0.33.0 is no longer used; dl leaves it alone and says so once.
- **Limits.** 8 GiB of memory, 4 CPUs and 1024 processes. The plan adds the model's `--memory` to show what is left.
- **Checked after start.** `docker inspect` must show the two bind mounts, the planned user, only the planned networks, no GPU and no privileges. The model container must not mount `DIR`. From inside the cell, the agent must be the folder's owner, the model must answer, `/workspace` and its home must be writable, a file it writes in `/workspace` must belong to the owner on the host (dl then removes it), `DIR`'s listing and `git status` must be the same as before, there must be no Docker socket and no `/dev/nvidia*`, and without `--allow-internet` the internet must not answer and there must be no default route. If any check fails, dl removes the sandbox, says what leaked, and leaves the model serving. Running the same command again retries only the sandbox.

`dl model update` and `dl model rollback` move the `model` name to the new container and rewrite the cell's config before the old one stops, so the agent's address never changes. `dl model down` removes the model, the cell, its networks, the agent's home and `DIR`'s entry in `HOTCELL_WORKSPACE_ROOTS`, and never touches `DIR`. Update and rollback read `DIR`'s owner again; if it changed, the cell is made again as the new owner, and dl says so.

#### Several GPUs, and two models on one machine

With more than one GPU, dl reads how they're linked (`nvidia-smi topo -m`: NVLink `NV#`, or PCIe `PIX`/`PXB`/`PHB`/`NODE`/`SYS`) and counts all of them (or the `--gpus` ones) for "models that fit". Over NVLink a model runs tensor parallel across its GPUs; over PCIe only, pipeline parallel as vLLM's docs advise for GPUs without NVLink, unless the model's own recipe documents tensor parallel (the DeepSeek V4.1 and GLM-5.3 entries do). A catalog entry picks its engine: vLLM, or SGLang (`lmsysorg/sglang`), behind the same checks.

Two models can share a machine, each on its own GPUs:

```sh
dl model up deepseek-v4.1-flash-fp8 --name big --gpus 0,1,2,3 --port 8000
dl model up qwen-new --name small --gpus 4 --port 8010
dl model list
dl model update glm-5.3-flash --name big
```

Each deployment has its own containers (`dl-model-NAME-1` and `-2` for updates), port and state entry; the unnamed one keeps `dl-model-1`/`-2`. Docker's `--gpus "device=…"` limits a container to its GPUs (renumbered from 0 inside; dl doesn't set `CUDA_VISIBLE_DEVICES`, whose host numbers would be wrong there), and dl refuses a GPU or port another deployment already has.

Models that keep weights in host RAM (DeepSeek V4.1's Engram tables) get a memory limit, so one can't starve the other: `--memory` = the offloaded bytes (one copy per deployment: vLLM keeps "one host copy per replica", sharded over its tensor-parallel ranks) + 8 GiB per GPU worker (dl's allowance for each engine process, not an engine figure), with the same `--memory-swap` so it can't spill to swap. For DeepSeek V4.1 Flash on 4 GPUs that's 189.1 GiB + 32 GiB = 222 GiB, so on a 256 GB machine only one such deployment fits; `dl model up --plan` shows the math.

All deployments share one Hugging Face cache volume (`dl-model-hf-cache`), read-write. That is safe: the cache is content-addressed, and Hugging Face's client takes a lock per file (`.locks/` at the cache root) so two containers never download the same blob at once; dl never deletes from it. A read-only mount would be safer still but breaks the first download, and the engines' images aren't verified to load from a read-only cache, so it isn't used. Two separate Docker setups (separate daemons) each have their own volume anyway.

#### Your own evals

`dl evals` runs the eval command your team already has (pytest or DeepEval, promptfoo, Inspect, a script) against each model, so an update has to pass your tests, not just dl's smoke tests. Nothing to convert.

```sh
cd ~/project
dl evals set "pytest evals/ -q --junitxml=junit.xml"   # saved with this folder; --threshold 0.02 --results GLOB --timeout 30m
dl evals run                  # once per deployment here: pass/fail, score, time
dl model update qwen-new      # smoke tests, bench, then your evals on the old and new model side by side
dl model update qwen-new --skip-evals
```

The command runs in your shell, in the folder `dl evals set` ran in, once per model, with `OPENAI_BASE_URL` (and `OPENAI_API_BASE`) set to that model's `/v1` address, `OPENAI_API_KEY` set to a placeholder (dl's vLLM and SGLang need no key), `OPENAI_MODEL` and `DL_EVAL_MODEL` set to the served model id, `DL_EVAL_ENDPOINT` to the server address without `/v1`, `DL_EVAL_DEPLOYMENT` to the deployment's name, and during an update `DL_EVAL_ROLE` to `incumbent` or `candidate`. Its output goes to a log in `~/.directionallylocal/logs`. Exit code 0 is a pass. A timeout (30 minutes by default) is a fail.

A score, from 0 to 1, comes from the results files the run wrote (files it didn't write this time are ignored): JUnit XML (pytest `--junitxml`: passed over run), promptfoo's `-o FILE.json` (successes over all), Inspect logs in `logs/` (`.eval` or `.json`: the first scorer's accuracy, else mean), DeepEval's `.deepeval/.latest_test_run.json` (test cases passed), or any JSON `{"score": n}` (0–1, or up to 100 as a percentage). Without `--results`, dl looks only at `junit.xml`, `report.xml`, `test-results.xml`, `results.json`, `output.json`, `promptfoo-output.json`, `logs/*.eval`, `logs/*.json` and `.deepeval/.latest_test_run.json`. Several files: their mean. A file dl can't read is listed as "not read".

`dl model update` runs the evals after the smoke tests and bench, on both models, and switches only if the new one passes where the old one passed and scores at least the old score minus the threshold (0.02 by default). Without scores, pass or fail decides. A command that fails on both models with no score blocks the update: the command is broken, not the model. When the old model had to stop to make room, only the new one runs and must pass. On a block, the old model keeps serving and dl says why in one line. The command is saved in `~/.local/state/directionallylocal/evals.json`, one per machine.

##### Bring your data

No eval command? Point dl at the eval files you already have. dl doesn't score them itself: it runs them with [promptfoo](https://github.com/promptfoo/promptfoo) (MIT), the open-source eval tool, so the checks behave exactly as promptfoo documents them. A file, a folder (every `.jsonl`, `.json`, `.csv`, `.tsv`, `.yaml` in it) or a glob; the format is recognized by content, so nothing needs converting.

```sh
dl evals set --data evals/qa.jsonl          # or a folder: --data evals/, or a glob: --data 'evals/*.csv'
dl evals set "pytest evals/ -q --junitxml=junit.xml" --data evals/   # both: both must pass
dl evals run
dl evals set --data ""                     # take the data off again
```

What dl hands promptfoo as is:

- **promptfoo configs** (`promptfooconfig.yaml`): prompts, tests, `defaultTest`, assertions and all, with dl's provider in place of the config's `providers`. A config that names its own provider for a test or an assertion is refused, since that could reach a hosted model.
- **promptfoo test files**: CSV with `__expected` columns, or JSON, JSONL or YAML tests with `vars` and `assert`. The var named `input`, `prompt` or `question` (or the only var) is the prompt.

What dl translates into promptfoo tests (the input as a var, the expected answer as an `__expected` value):

- **JSONL or JSON rows** with an input (`input`, `prompt`, `question`, `query`, `instruction`) and an expected answer (`expected`, `ideal`, `answer`, `output`, `target`): `{"question": "Capital of France?", "answer": "Paris"}`
- **OpenAI Evals**: `{"input": [{"role": "user", "content": "Largest planet?"}], "ideal": ["Jupiter"]}`, and chat transcripts, where the last assistant turn is the answer: `{"messages": [{"role": "user", "content": "Opposite of hot?"}, {"role": "assistant", "content": "cold"}]}`. Chat goes to the model as chat.
- **Braintrust dataset exports** (JSON or JSONL): `{"id": "bt-1", "input": {"question": "Who painted the Mona Lisa?"}, "expected": "Leonardo da Vinci", "metadata": {}}`; an object input or expected uses its obvious field
- **LangSmith dataset exports**: `{"inputs": {"question": "Legs on a spider?"}, "outputs": {"answer": "8"}}`, or a CSV with `inputs.question,outputs.answer` columns
- **CSV or TSV** with a header using the same names (`question,answer`)

Rows without an expected answer are skipped and counted; anything else is an error that says what dl expected (in a folder or a glob, such files are listed as skipped).

An expected answer follows promptfoo's [`__expected` syntax](https://www.promptfoo.dev/docs/configuration/expected-outputs/): a plain value means `equals`, the exact answer; a prefix picks another check. Several right answers (OpenAI Evals' `ideal` list): any one passes.

```csv
question,__expected
What is the capital of France?,Paris
What is the capital of France?,contains:Paris
What is the capital of France?,factuality:Paris is the capital of France
Is this reply polite?,llm-rubric:is polite
```

The same values work in an `answer` or `expected` field of a JSONL row. `equals` is strict: "The capital of France is Paris." doesn't equal `Paris`. When most failures are like that, dl says so in one line and suggests `contains:` or `factuality:`; it never loosens the score itself.

Model-graded checks (`llm-rubric`, `factuality`, `model-graded-closedqa` and the like) are judged by your own model, never a hosted one: during `dl model update` the old model judges both, so the two are graded by the same judge; `dl evals run` uses the first deployment (the default one) as judge for every model and says so. `similar` needs an embeddings endpoint, which dl's chat deployments don't serve, so it reports an error.

Each model gets promptfoo's OpenAI provider pointed at its `/v1` with its served model id, temperature 0, at most 1024 tokens, thinking turned off (as in dl's smoke tests: `chat_template_kwargs.enable_thinking: false`, reasoning not shown as part of the answer, a `<think>` block left in the answer stripped), four requests at a time, within `--timeout` for the whole run. promptfoo runs with no API keys or provider URLs from your shell, with telemetry, update checks and sharing off, and writes nothing outside dl's logs.

promptfoo itself is pinned (0.125.1) and downloaded from npm the first time it's needed, into `~/.cache/directionallylocal/promptfoo-0.125.1` (`npm install --ignore-scripts`, a few hundred MB, once); it isn't part of dl's package. It needs Node 22.22 or newer and npm; offline, the first run says so.

The score is promptfoo's: tests passed over tests run (an error, like no answer, counts as a fail). The table shows it per model, then a summary ("41 of 44 passed · 1 error"), the first five failing cases in one line each (input, expected, the check, and what the model said), and promptfoo's JSON output in `~/.directionallylocal/logs`, next to the config dl wrote, so you can rerun or inspect it with promptfoo yourself. A data run fails only when no case got an answer (the endpoint is down) or the time ran out; otherwise the score decides at the gate, exactly as for a command. With both a command and data, both must pass and the score is the mean of the command's score (when it wrote one) and the data's.

The model's state is kept separately from a server install, in `~/.local/state/directionallylocal/model.json` (or `$XDG_STATE_HOME`), so `dl model` works on a laptop or a server without touching `/etc/directionallylocal/state.json`.

Today: tested end to end with small models on one Nvidia GPU. Models that need several GPUs, SGLang, and several models on one machine are in, planned and checked with `--plan`, but not yet run on real multi-GPU hardware. AMD and Huawei Ascend GPUs are on the roadmap.

#### Your coding agent on the model: dl agent

On a GPU box, the terminal agent can be Autopilot or a coding CLI you already use, on the box's own model. On the GPU first run, after **Terminal agent** or **Both**, Autopilot asks **"Which coding agent?"**:

- **Autopilot (recommended)**, the default: comes with dl, made for local models.
- **Claude Code**: Anthropic's CLI, on your model through its Messages API.
- **OpenCode**: open-source agent, on your model as an OpenAI-compatible provider.
- **Pi**: minimal open-source agent, on your model as an OpenAI-compatible provider.

An agent whose CLI isn't on your PATH is marked **(install first)**; picking it saves the choice and prints the official install command, and dl stops there (run `dl` again once it's installed). dl never installs these CLIs. An agent that can't work on the model isn't offered (Claude Code needs a 32k context).

The choice is kept for the box (`~/.local/state/directionallylocal/agent.json`, beside the model's state): plain `dl` opens that agent from then on, `dl -c` continues its latest session (each CLI's `-c`), and `dl -- ARGS` passes ARGS to it. `dl agent` shows it and offers the same menu; `dl agent set autopilot|claude-code|opencode|pi` changes it; `dl status` shows it. With no model on the box, dl opens Autopilot and says why.

Each agent runs on the local model for that one run, and none of their own config files are read or written:

| Agent | How dl points it at the model |
|---|---|
| Autopilot | its `vllm` provider, set by `dl model up` (as before) |
| Claude Code | the engine's own Anthropic Messages API (vLLM 0.11.1+ and SGLang 0.5.9+ serve `/v1/messages`; every catalog image is newer): `ANTHROPIC_BASE_URL=http://127.0.0.1:PORT`, a dummy `ANTHROPIC_AUTH_TOKEN`, every model role (`ANTHROPIC_MODEL`, the opus/sonnet/haiku defaults, `CLAUDE_CODE_SUBAGENT_MODEL`) on the served model, `CLAUDE_CODE_MAX_CONTEXT_TOKENS` and `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Your own `ANTHROPIC_*` variables are left out for that run (dl says which) |
| OpenCode | `OPENCODE_CONFIG_CONTENT`: an `@ai-sdk/openai-compatible` provider at `http://127.0.0.1:PORT/v1` with the served model, its context and output limits, chosen as the model. It ranks above your own config files for that run. With OpenCode 2, dl adds `--standalone`, so a private server reads it instead of the shared background one |
| Pi | a one-run extension (`pi -e FILE`, in a private temporary folder removed afterwards) that registers the endpoint as an OpenAI-compatible provider with the served model and its limits, then `--provider dl-local --model MODEL`. Your `~/.pi` settings, sign-ins and extensions stay as they are |

The output limit each agent is told is a quarter of the context, at most 32,000 tokens. No free tier sign-in is needed and no free tier key is used: the model is the box's own, on 127.0.0.1. (`dl claude` is the other way round: Claude Code on the free tier.) Codex isn't offered yet.

#### Your GPU as an API: dl model endpoint

`dl model endpoint` makes the box's model an OpenAI-compatible API any coding tool can use, behind API keys dl generates. It prints the base URL, the model id, the key (masked; `--show-key` for the full key) and copy-paste setup for OpenAI-compatible tools (`OPENAI_BASE_URL` / `OPENAI_API_KEY`), Autopilot (`AUTOPILOT_BASE_URL`), OpenCode (`opencode.json`), Cursor, and Claude Code when dl can already run it on that model (the engine's Messages API, a 32k context).

```sh
dl model endpoint             # on: http://127.0.0.1:8800/v1, this machine only, a key required (--port PORT)
dl model share --lan          # your network: 0.0.0.0:8800 (firewall it if the box has a public IP)
dl model share --tailscale    # your tailnet only: https://box.tail1234.ts.net:8443/v1 (tailscale serve, never Funnel)
dl model share --public       # the internet, through a Cloudflare quick tunnel (testing only, see below)
dl model share --off          # this machine only again
dl model keys                 # the keys, masked; add NAME, revoke ID; --show-key
dl model endpoint --off       # stop it (the keys are kept)
```

- **How:** the engine stays as `dl model up` runs it (127.0.0.1, no key, for Autopilot, the team chat and the agents dl opens). In front of it a small key-checking proxy runs in its own container (`dl-model-api`, Node, read-only, no capabilities, as your user). It forwards `/v1` paths only, GET and POST only, so the engines' admin and metrics endpoints stay private, and it takes `Authorization: Bearer KEY` or `x-api-key: KEY`. A key is required in every mode.
- **Keys:** kept in full in `~/.local/state/directionallylocal/api.json` (0600); the proxy sees only their SHA-256 hashes. `dl model keys add NAME` and `revoke` take effect on the next request, without restarting the model or the proxy. Changing who can reach it restarts only the proxy.
- **It follows the model:** after `dl model up`, `update`, `rollback` or `down` the endpoint serves the box's current model (the default deployment). `dl model status` shows where it's reachable.
- **`--public`** runs `cloudflared tunnel --url` in a container (`dl-model-api-tunnel`). The URL is public and only the key protects it. Cloudflare's quick tunnels are for testing: no uptime guarantee, a new URL whenever the tunnel restarts, and no Server-Sent Events, so streamed answers may not work. For daily use from outside, `--tailscale`. Cursor calls custom URLs from its own servers, so it needs a public URL.

#### Team chat: dl ui

`dl ui` runs [Open WebUI](https://github.com/open-webui/open-webui) (v0.12.5, pinned by digest) in Docker as your team's chat, talking to every `dl model` deployment on this machine. It listens on `127.0.0.1:4800` only. Your team reaches it over HTTPS only: a private link on your Tailscale network. There is no plain-HTTP network mode.

**On the GPU first run** (`curl -fsSL https://dl.new/i/… | sh` with "My Nvidia GPU", or `dl` on a GPU box): once the model passes its tests, Autopilot asks "How will your team use it?": **Browser chat (you and your team)**, **Terminal agent**, **Both** or **API endpoint (any coding tool)**. Terminal opens the agent on the model, as before. API endpoint runs `dl model endpoint` (below) and prints the base URL, key and setup for other tools. Browser chat and Both set up the chat for you:

1. **Tailscale.** Installed if it's missing (the same install as `dl up`). If this machine isn't signed in, dl runs `tailscale up --qr`, which prints a sign-in link and a QR code: open it on your laptop or phone and sign in with Google, Microsoft or GitHub (or your org's existing Tailscale account). If your tailnet has HTTPS certificates off, dl shows the admin-console link ([login.tailscale.com/admin/dns](https://login.tailscale.com/admin/dns), HTTPS Certificates, Enable) and waits until they're on. Not running as root, these use `sudo` once, and your login becomes Tailscale's operator so later `dl ui` commands don't need sudo.
2. **`dl ui up` and `dl ui share`.**
3. **The admin link, in red.** Open WebUI makes its first account the admin, so whoever opens the link first becomes the admin: open it at once, yourself. dl waits until the account exists (Ctrl-C stops waiting; everything keeps running), then restarts Open WebUI once so your team can sign up. Both then opens the agent.

If Tailscale can't be used, dl says why and what to do next, and stops; it never falls back to plain HTTP.

```sh
dl ui up                      # Open WebUI on 127.0.0.1:4800
dl ui share                   # one link for your team: https://box.tail1234.ts.net
dl ui invite ana@company.com raj@company.com   # makes their accounts; prints what to send each person
dl ui approve                 # who signed up and waits; dl ui approve EMAIL... (or all)
dl ui status · dl ui logs -f · dl ui down [--purge]
```

- **Sharing:** with Tailscale signed in and HTTPS certificates on, `dl ui share` runs `tailscale serve --bg` (HTTPS with a real certificate on this machine's tailnet name, reachable only from your tailnet; never Funnel). On a server where `dl up` already serves the agent on port 443, the chat gets `:8443`. Each person needs the Tailscale app. `dl ui share --off` stops sharing. Without Tailscale, the chat is for you alone, through an SSH tunnel from your laptop: `ssh -N -L 4800:127.0.0.1:4800 you@box`, then open `http://127.0.0.1:4800`.
- **The admin:** the first account made in the browser. dl never creates it by default and never keeps an admin password. `dl ui up --admin-email you@company.com` makes it from the terminal instead and shows its password once (dl doesn't keep it).
- **Two-factor sign-in, for everyone** (`ENABLE_MFA=true`): each person sets up an authenticator app the first time they sign in. Open WebUI encrypts the 2FA secrets with a key derived from its `WEBUI_SECRET_KEY`, which it generates once into the `dl-ui-data` volume, so it survives restarts and updates.
- **Who gets in:** anyone who opens the link can ask for an account; it waits until an admin approves it (Admin Panel > Users, or `dl ui approve`). `dl ui invite` creates active accounts with a one-time password for you to pass on; dl sends no email and doesn't keep those passwords.
- **`invite` and `approve` use an admin's API key**, never a password: the first time, dl asks for one (make it in the chat: your name > Settings > Account > API Key > Create; or pass `DL_UI_ADMIN_KEY`), checks that it's an admin's and keeps it in `~/.local/state/directionallylocal/ui.json` (mode 0600). Open WebUI accepts API keys only on its user-management endpoints (`API_KEYS_ALLOWED_ENDPOINTS=/api/v1/users,/api/v1/auths/add`), so a leaked key can't read chats. A key Open WebUI no longer accepts is dropped and dl asks again. Without a key, `dl status` just doesn't show how many people are waiting.
- **It follows the models:** after `dl model up`, `update`, `rollback` or `down`, a running chat picks up the change by itself, with the same link and accounts.
- **After logout and reboot:** everything keeps running. Open WebUI runs with `--restart unless-stopped`, a model gets the same policy once it passes its tests (one that failed is kept stopped for inspection), tailscaled keeps `tailscale serve --bg`'s config, and Docker and tailscaled start at boot.
- **Settings:** dl sets them on every start (`ENABLE_PERSISTENT_CONFIG=false`), so changes made in the Admin Panel's settings last until the next restart; accounts, chats and model access stay in the `dl-ui-data` volume. Off: Ollama, web search, image generation, community sharing, browser-added connections, Hugging Face downloads and the version check (`OFFLINE_MODE`), analytics (`SCARF_NO_ANALYTICS`, `DO_NOT_TRACK`, `ANONYMIZED_TELEMETRY=false`).
- **`dl status` on a GPU box** starts with what runs there: each model (port, healthy or not), the coding agent plain `dl` opens, the team chat (its link, and how many wait for approval when dl has an admin key), the agent server, and Tailscale (signed in, HTTPS on). Plain `dl` prints the same lines before it opens the agent.
- **Next:** a guided invite step after the admin's first sign-in; a public link and your own domain; sign-in with Google or Microsoft through Open WebUI's OIDC support.

### On the server

On a machine set up with `DL_MODE=server` (or `dl up`), run these as root. `dl` on its own shows what this is, whether it's healthy, the connected laptops, and the runs.

| Command | What it does |
| --- | --- |
| `dl up` | Install or repair everything. Safe to re-run: it keeps your keys and generated secrets and skips work that's already done. |
| `dl up --dry-run` | Print what `up` would change, without changing anything. |
| `dl connect-laptop` | How to connect a laptop, and a link to approve it in a browser. `dl connect-laptop CODE` approves the code a laptop shows. |
| `dl laptops` | Connected laptops. `dl laptops remove NAME` disconnects one. |
| `dl runs` | Tasks running or done, with their pull requests. |
| `dl logs [hotcell\|autopilot] [-f]` | The services' logs. |
| `dl preview ID [--remove]` | Deploy a task's branch as a preview, or stop it. Needs `DL_PREVIEWS_BUCKET`. |
| `dl previews` | Live previews: task, port, branch. |
| `dl doctor` | Check every part, with a fix for each failure; the provider's route must be active in Hotcell. |
| `dl keys [set <provider>\|github]` | Which keys are set, or replace one (hidden input). Any Autopilot provider id works (`openrouter`, `deepseek`, `openai`, `ollama`, …); a custom one takes `--base-url URL` (and `--auth-header H --auth-format F` when it isn't Bearer). |
| `dl status` | Show the installed versions and where to reach the server. |
| `dl uninstall` | Remove the services and software but keep configuration and data. Add `--purge` to delete those too, plus the service accounts and the sandbox image. |

### Unattended installs

Set the answers as environment variables: `DL_TAILSCALE_AUTH_KEY`, `DL_PROVIDER` (a provider id; `openrouter` when unset) with `DL_PROVIDER_API_KEY` (and `DL_PROVIDER_BASE_URL` for a provider Hotcell has no built-in route for; `DL_OPENROUTER_API_KEY` is the OpenRouter shorthand), and `DL_GITHUB_TOKEN`. `DL_ACCESS` picks how the server is reached: `tailscale` (the default), `loopback` (this machine only), or `ssh` (what the laptop's setup uses). `DL_SKIP_CREDENTIAL_CHECK=1` skips the online key checks for offline installs. The install script holds the four secrets (and `DL_INSTALL_CODE`) back from everything it runs but `dl up`: NodeSource's setup script, apt and `npm install -g` never see them, and through `sudo` root's commands get an explicit list of the non-secret variables instead of `sudo -E`. `dl up` runs Docker's and Tailscale's install scripts with a scrubbed environment.

The laptop's setup drives the server over SSH with `dl up --access ssh --answers-stdin --events json`, which takes the answers as one JSON object on stdin (`{"provider": {"id", "baseUrl", "apiKey", "apiKeyEnv", "authHeader"?, "authFormat"?}, "githubToken"}`; an older laptop's `"openrouterKey"` still works) and reports progress as JSON lines. It runs twice: once to install, with `{}`, and once with the keys, after Autopilot's picker. `dl up --needs` reports which answers it still lacks, without changing anything. The server writes the provider into Aster's `aster.json` as `"provider": {"id", "baseUrl", "apiKeyEnv"}` with `"models": "catalog"`.

## The one-line install

For the coding agent, on a laptop or any Linux machine, as yourself or as root:

```sh
curl -fsSL https://dl.new | sh
```

For a server that runs background tasks in sandboxes (Ubuntu or Debian), ask for it:

```sh
curl -fsSL https://dl.new/install.sh | sudo DL_MODE=server sh
```

(As root, `curl -fsSL https://dl.new/install.sh | DL_MODE=server sh` is the same. Put `DL_MODE=server` after `sudo`: sudo drops variables set before it.)

Any glibc Linux works for the coding agent (Ubuntu, Debian, Fedora, Arch, Amazon Linux; minimal images need `tar` and `gzip`). Alpine and other musl Linux can't run Autopilot's terminal renderer, so the script stops there with a one-line message.

**On a laptop** (macOS as yourself; Linux as anyone, root included: root's install goes into `/root/.directionallylocal`, and `dl` is the router as it is for everyone), it installs `dl` into `~/.directionallylocal` with no sudo: it uses your Node.js when it's new enough (22.23.4+, 24.22.1+ or 26.12.1+), and otherwise downloads Node.js 24 from nodejs.org into the same folder, checked against its published SHA-256, for `dl` alone (your shell's `node` stays as it is). It adds `~/.directionallylocal/bin` to your PATH in your shell's startup file (`.zshrc`, `.bashrc` or `.bash_profile`, fish's `conf.d`, else `.profile`) and starts `dl` in the folder you ran it from. A piped script can't change the PATH of the shell you ran it from, so when `~/.local/bin` or `~/bin` is already on that PATH it also links `dl` there, and `dl` works in the same terminal; otherwise it says the one line to run (for example `source ~/.bashrc`), again when you leave that first `dl`. New terminals always have it. `dl` itself comes as one prebuilt bundle for your platform (macOS or Linux, Apple Silicon/arm64 or x64; dl, its exact dependencies and that platform's binaries, built by the release workflow from the npm package) from `https://dl.new/dl/`, checked against its SHA-256; when there's none for your computer, or it fails, the script installs with npm instead. While it runs, the script shows what it's downloading, how big it is and how far along. `DL_NO_START=1` skips starting `dl`, `DL_NO_MODIFY_PATH=1` leaves your startup file alone, `DL_NO_BUNDLE=1` uses npm, and `DL_HOME=DIR` installs somewhere else. `DL_REFERRAL=CODE` (set by invite links, `curl -fsSL https://dl.new/r/CODE | sh`) is a GitHub username: it's passed to `dl`, which passes it to Autopilot for the free tier sign-in, and it's kept in `~/.config/directionallylocal/pending-referral` until that sign-in succeeds, so signing in on a later run still credits the invite. `dl local uninstall --purge` keeps `dl` itself. When the startup file can't be written (read-only, or managed by Nix or home-manager), the install still succeeds and prints the line to add yourself.

Uninstall: `dl uninstall` (add `--purge` to also remove your settings and sign-in).

**On a server** (Ubuntu or Debian: `curl -fsSL https://dl.new/install.sh | sudo DL_MODE=server sh`), it installs Node.js if needed, installs `directionallylocal` globally, and runs `dl up`. The laptop's setup uses the same script to bootstrap a server over SSH, with `DL_INSTALL_ONLY=1` and the laptop's own `dl` version in `DL_VERSION`.

Which one it is: a server only with `DL_MODE=server`, when the laptop's setup runs it (`DL_INSTALL_ONLY=1`), or on a Linux machine `dl up` has already set up (so re-running the plain line there updates that server, as before); anything else, root included, gets the coding agent. The one exception to never asking: root through `sudo` on Linux with no `DL_MODE` (`curl … | sudo sh`, often the server line without its `DL_MODE=server`) says it is installing the coding agent for root, not a server, and at a terminal asks whether to set up a server instead (no by default; with no terminal it only says so and goes on). That's the line `dl` itself draws: with no server install, bare `dl` is plain Autopilot for root too. `DL_MODE=laptop` gives the plain install even on a server.

When it ends, either way, it sends one anonymous count to the free tier service, in the background: OS (`darwin` or `linux`), chip (`arm64` or `x64`), laptop or server, the `dl` version, ok or the step that failed, and which page it came from (`DL_INSTALL_VIA`, set by dl.new's scripts). No IP address or identity is kept. `DL_NO_TELEMETRY=1`, `DO_NOT_TRACK=1` or a `CI` variable turns it off.
The same variables, set when you run `dl`, also turn off what `dl` itself would count: the
session end (duration, how it ended) and OS that `dl claude`, `dl opencode`, `dl pi`, `dl codex`, `dl t3` and
`dl proxy` send, and `dl status` marking dl Pro's offer as seen. A bare session start (an id and a
time, sent with the session's own short-lived key when it starts and every 6 hours) still goes:
the free tier can be set to refuse free tokens from a sign-in that sends none (`dlOnly`, off by
default), so it stays to keep those commands working if that is ever switched on. `dl proxy install` writes the opt-out into the
login service when it's set. The install pages count scripts served the same way (see `services/free/README.md`, "Install counts").

## What it sets up on a server

- **Node.js 24 LTS,** if Node is missing or lacks the fix for CVE-2026-111497 (22.23.4+, 24.22.1+ and 26.12.1+ are accepted). Node security releases from NodeSource are added to Ubuntu's automatic updates, which otherwise skip them. Delete `/etc/apt/apt.conf.d/52directionallylocal-nodejs` to opt out.
- **Docker,** if it's missing, plus a rule that keeps sandboxes away from the cloud metadata endpoint. Docker isn't updated automatically, because its repo ships major upgrades and restarting the Docker daemon can stop running sandboxes.
- **Hotcell and Autopilot from npm,** under `/opt/directionallylocal/releases/<versions>`, with `current` pointing at the active release.
- **Three systemd units:** `hotcell.service` (sandboxes and the credential gateway, on loopback) and `autopilot.service` (the API that laptops pair with, on `127.0.0.1:4096`), each under its own unprivileged account, plus `directionallylocal-metadata-block.service`, the firewall rule for sandboxes. Only Tailscale Serve exposes the API, and only when you use Tailscale access.
- **A sandbox image** with Node, git, Python, and the Autopilot runtime baked in.
- **Configuration** in `/etc/hotcell`, `/etc/autopilot` and `/etc/directionallylocal`, readable only by root and the matching service account. Data lives in `/var/lib/hotcell` and `/var/lib/autopilot`.

Supported: Ubuntu 24.04 and 22.04 and Debian 12, on x86_64 or arm64, with at least 4 GB of RAM and 15 GB free under `/var`.

## The install script's address

`site/` is the Cloudflare Worker for `https://directionallylocal.run`. It serves `install.sh` to `curl` at the bare domain (and `/install.sh`), sends browsers at the bare domain to directionallylocal.com, shows them the script as plain text at `/install.sh` (so it can be read before it is piped to `sh`; those views aren't counted as downloads), and serves nothing else. Subdomains of `directionallylocal.run` are users' instant addresses, and the domain is on the Public Suffix List, so the Worker never sets cookies. Deploy it with `npx wrangler deploy -c site/wrangler.toml`.

`site/wrangler.jsonc` is the portable config that celld and Serverless Objects read; `site/wrangler.toml` keeps the Cloudflare-only `routes` and `workers_dev`. The install script is checked in as `site/install-script.ts` so the Worker has no non-JavaScript imports; regenerate it with `npm run sync:site-script` after editing `install.sh`. `sobjects build --strict site` checks that the Worker stays portable. The design for the name service and approvals page is in [`docs/plans/portable-services.md`](docs/plans/portable-services.md).

## Development

```sh
npm install
npm test          # node:test through tsx; a simulated server exercises up, doctor, and uninstall
npm run typecheck
npm run build
npm run sync:site-script   # after editing install.sh
```

To test the whole flow with unpublished builds of Autopilot or Hotcell, set `DL_AUTOPILOT_SPEC` and/or `DL_HOTCELL_SPEC` to an npm spec or a path to a `.tgz` (`npm pack` in their checkouts). Local setup, `dl up` on a server and the sandbox image build then install those instead of `autopilot-ai@<pinned version>` / `hotcell@<pinned version>`; the release is named `dev` and is reinstalled and rebuilt on every run, since a dev build may have changed. The versions the builds report end up in the state file.

```sh
DL_AUTOPILOT_SPEC=~/autopilot/autopilot-ai-3.1.0.tgz DL_HOTCELL_SPEC=~/hotcell/hotcell-1.5.0.tgz dl
```

## Community

Questions, ideas, or something you built with it: [join the Directionally Local Discord](https://discord.gg/zeBnJTgcRK).

## License

Apache-2.0. See [LICENSE](LICENSE).
