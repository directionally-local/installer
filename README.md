# Directionally Local installer

Coding agents that run on your own computer or on your own server. Send a task; it runs in its own [Hotcell](https://github.com/directionally-local/hotcell) sandbox, driven by [Autopilot](https://github.com/directionally-local/autopilot), and comes back as a pull request, even with your laptop closed. Start one at [dl.new](https://dl.new).

Where this is going: [the roadmap](docs/ROADMAP.md).

## Start on your laptop

```sh
npm install -g directionallylocal
dl
```

`dl` starts Autopilot in the folder you're in. There's nothing to set up first: no Docker, no sandbox, no GitHub token. Autopilot's own first run picks your provider and signs you in. Every `dl` is a new session; `dl -c` continues the last one.

Background tasks are the part that needs setting up, and `dl` sets them up the first time you ask for one. `dl run "task"` with nowhere to send it asks one question:

```
  Background tasks keep going when this laptop sleeps.

  Where should they run?
  › Use my own server
    Run them on this computer   needs Docker Desktop or OrbStack
```

- **Use my own server** — keeps going when your laptop is closed; needs SSH access. `dl` lists the hosts in `~/.ssh/config` (or takes `user@host[:port]`), checks it over SSH, installs itself there, and pairs this laptop. Nothing is exposed on the server: `dl` reaches it through an SSH tunnel.
- **Run them on this computer** — nothing to rent; tasks pause while it sleeps. macOS and Linux, with Docker; not offered on Windows yet (use a server, or WSL 2, which takes the Linux path).

Then it installs Hotcell and Autopilot on the place, builds the sandbox image, starts the services, asks for the provider (Autopilot's picker) and the GitHub token, and sends the task. `dl setup` does the same without a task, for when you'd rather set things up first. What it shows, for this computer:

```
  ✓ Checking this computer   macOS 15.1 · Docker Desktop 29.5.2 · Node 24.22.1 · 120 GB free
  ✓ Installing Hotcell (sandbox SDK) + Autopilot (harness)   Autopilot 3.2.0 · Hotcell 0.1.38
  ✓ Building the sandbox image   Node 24 · Autopilot 3.1.2
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

### The GitHub token

Background tasks push branches and open pull requests through GitHub, so each place needs a token; a plain `dl` session never asks for one. `dl` offers your GitHub CLI login (`gh auth token`) as *"Use your GitHub CLI login (you)? It stays on this computer."*; without one it says so in one line and asks for a fine-grained token with Contents and Pull requests read/write. The token stays on the place too; sandboxes push through Autopilot's repository-scoped proxy.

### Then a session

`dl setup` ends with one line, `✓ Ready · fits ~6 agents at once`, and opens a session at once. What bare `dl` opens depends on where your agents run (the default place, `dl use`; `--server NAME` picks another). With nothing set up, it's plain Autopilot, as for this computer:

**On this computer, `dl` is plain Autopilot.** It starts `autopilot` in the terminal, in the folder you ran it from, exactly as if you had typed `autopilot`: every Autopilot feature works (`/resume`, `/clear`, `!` shell commands, MCP servers), with your own Autopilot config and the provider `autopilot connect` set up. Any folder works, git or not, and nothing is sent anywhere: the agent edits the folder directly and stops when the terminal closes. Every `dl` is a new session; `dl -c` is `autopilot -c`, and anything after `--` goes to Autopilot as is (`dl -- --session ID`).

**On a server, `dl` is a session that keeps running.** Autopilot's screen attaches to a conversation on the server (`autopilot attach-remote`) that carries on after you close the terminal. Inside a GitHub repository it's that repository's code session (your uncommitted changes go along; `--no-local-changes` sends none); anywhere else, a chat. Every `dl` starts a new conversation; `dl -c` reopens the latest one started from this folder on that server. When an earlier one from this folder is still working or waiting for you, `dl` says so in one line before connecting (`1 earlier session here is still working · dl -c to rejoin`). In a git repository whose origin isn't on GitHub, it says so in one line and opens a chat instead.

**Either way, `dl run "task"` is the background, sandboxed path.** It sends the task to the place, where it runs in a Hotcell sandbox, keeps going after the terminal closes, and ends in a pull request.

```sh
dl                                  # this computer: autopilot here. A server: its session (repository or chat)
dl -c                               # this computer: autopilot -c. A server: the latest session from this folder
dl -- --session <id>                # this computer: pass flags through to autopilot
dl --server box                     # a session on the server named box, whatever the default
dl new                              # the same as bare dl (kept as an alias for a release)
dl run "fix the flaky checkout test"  # background task in a sandbox; your uncommitted changes go along
dl runs                             # tasks and their pull requests
dl pull <id>                        # check one out here
dl status                           # where agents run, their provider, model and versions, what they're doing
```

`dl status` says when a place runs another Autopilot or Hotcell than this laptop's `dl` pins: `! box runs Hotcell 0.1.30, this dl pins 0.1.38   dl update box`.

The "fits ~N agents" figure is a conservative estimate: memory left after the host's own share (at least 1.5 GB or 15%), divided by 1 GB per sandbox, capped at two per CPU. Measured numbers will replace it.

### One Autopilot and one Hotcell version

`dl` bundles `autopilot-ai` at an exact version (its session client) and pins `hotcell` exactly too, and installs those same versions on every place it sets up, including the sandbox image, so the client and the server never drift and two people installing the same `dl` get the same sandboxes. `dl update NAME` brings a place back to both pins: a server gets its `dl` refreshed first (the install script, at this laptop's own `dl` version, so both ends match) and then `dl up`; this computer re-runs its setup. Setting up a server installs this laptop's `dl` version there too, never npm's latest. When the laptop's own `dl` is behind npm, `dl update` says so with the one command that fixes it.

## Commands

`dl` is short for `directionallylocal`; both work.

### On your laptop

| Command | What it does |
| --- | --- |
| `dl` | Talk to an agent: a new session each time. With nothing set up, plain `autopilot` in this folder (its first run picks the provider); nothing is installed. On this computer: plain `autopilot` in this folder, any folder, with your own Autopilot config (`dl -- ARGS` passes ARGS to it). On a server: inside a GitHub repository, that repository's agent session; anywhere else, a chat; it keeps running when you leave. |
| `dl -c`, `dl --continue` | On this computer, `autopilot -c`. On a server, reopen the latest conversation started from this folder there. |
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
| `dl model [ID]` | The model for tasks and sessions on a place. With no ID, Autopilot's own model picker. |
| `dl update [NAME]` | Update a place's Autopilot, Hotcell and sandbox image to the versions `dl` pins. A server over SSH (its `dl` first), this computer in place. `--wait` waits for running tasks instead of asking; with no terminal it waits anyway. |
| `dl local status` | Agents running on this computer: running?, where, how many fit. |
| `dl local uninstall [--purge]` | Stop and remove them. `--purge` also deletes keys and data. |

Run options: `--server NAME`, `-m/--model MODEL`, `--repo OWNER/NAME`, `--detach`.

### On the server

Run these as root. `dl` on its own shows what this is, whether it's healthy, the connected laptops, and the runs.

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

Set the answers as environment variables: `DL_TAILSCALE_AUTH_KEY`, `DL_PROVIDER` (a provider id; `openrouter` when unset) with `DL_PROVIDER_API_KEY` (and `DL_PROVIDER_BASE_URL` for a provider Hotcell has no built-in route for; `DL_OPENROUTER_API_KEY` is the OpenRouter shorthand), and `DL_GITHUB_TOKEN`. `DL_ACCESS` picks how the server is reached: `tailscale` (the default), `loopback` (this machine only), or `ssh` (what the laptop's setup uses). `DL_SKIP_CREDENTIAL_CHECK=1` skips the online key checks for offline installs.

The laptop's setup drives the server over SSH with `dl up --access ssh --answers-stdin --events json`, which takes the answers as one JSON object on stdin (`{"provider": {"id", "baseUrl", "apiKey", "apiKeyEnv", "authHeader"?, "authFormat"?}, "githubToken"}`; an older laptop's `"openrouterKey"` still works) and reports progress as JSON lines. It runs twice: once to install, with `{}`, and once with the keys, after Autopilot's picker. `dl up --needs` reports which answers it still lacks, without changing anything. The server writes the provider into Aster's `aster.json` as `"provider": {"id", "baseUrl", "apiKeyEnv"}` with `"models": "catalog"`.

## The one-line install

For a laptop or a server:

```sh
curl -fsSL https://directionallylocal.run | sh
```

**On a laptop** (macOS or Linux, as yourself), it installs `dl` into `~/.directionallylocal` with no sudo: it uses your Node.js when it's new enough (22.23.4+, 24.22.1+ or 26.12.1+), and otherwise downloads Node.js 24 from nodejs.org into the same folder, checked against its published SHA-256, for `dl` alone (your shell's `node` stays as it is). It adds `~/.directionallylocal/bin` to your PATH in your shell's startup file (`.zshrc`, `.bashrc` or `.bash_profile`, fish's `conf.d`, else `.profile`) and starts `dl` in the folder you ran it from. A piped script can't change the PATH of the shell you ran it from, so when `~/.local/bin` or `~/bin` is already on that PATH it also links `dl` there, and `dl` works in the same terminal; otherwise it says the one line to run (for example `source ~/.bashrc`), again when you leave that first `dl`. New terminals always have it. `DL_NO_START=1` skips starting `dl`, `DL_NO_MODIFY_PATH=1` leaves your startup file alone, and `DL_HOME=DIR` installs somewhere else. `dl local uninstall --purge` keeps `dl` itself.

**On a server** (Ubuntu or Debian, as root: `curl -fsSL https://directionallylocal.run | sudo sh`), it installs Node.js if needed, installs `directionallylocal` globally, and runs `dl up`. The laptop's setup uses the same script to bootstrap a server over SSH, with `DL_INSTALL_ONLY=1` and the laptop's own `dl` version in `DL_VERSION`.

Which one it is: a server when it runs as root on Linux, when the laptop's setup runs it (`DL_INSTALL_ONLY=1`), or on a Linux machine `dl up` has already set up; anything else is a laptop. That's the line `dl` itself draws: on a machine with no server install, root gets the server's instructions and everyone else the laptop's. `DL_MODE=server` or `DL_MODE=laptop` overrides it.

## What it sets up on a server

- **Node.js 24 LTS,** if Node is missing or lacks the fix for CVE-2026-111497 (22.23.4+, 24.22.1+ and 26.12.1+ are accepted). Node security releases from NodeSource are added to Ubuntu's automatic updates, which otherwise skip them. Delete `/etc/apt/apt.conf.d/52directionallylocal-nodejs` to opt out.
- **Docker,** if it's missing, plus a rule that keeps sandboxes away from the cloud metadata endpoint. Docker isn't updated automatically, because its repo ships major upgrades and restarting the Docker daemon can stop running sandboxes.
- **Hotcell and Autopilot from npm,** under `/opt/directionallylocal/releases/<versions>`, with `current` pointing at the active release.
- **Three systemd units:** `hotcell.service` (sandboxes and the credential gateway, on loopback) and `autopilot.service` (the API that laptops pair with, on `127.0.0.1:4096`), each under its own unprivileged account, plus `directionallylocal-metadata-block.service`, the firewall rule for sandboxes. Only Tailscale Serve exposes the API, and only when you use Tailscale access.
- **A sandbox image** with Node, git, Python, and the Autopilot runtime baked in.
- **Configuration** in `/etc/hotcell`, `/etc/autopilot` and `/etc/directionallylocal`, readable only by root and the matching service account. Data lives in `/var/lib/hotcell` and `/var/lib/autopilot`.

Supported: Ubuntu 24.04 and 22.04 and Debian 12, on x86_64 or arm64, with at least 4 GB of RAM and 15 GB free under `/var`.

## The install script's address

`site/` is the Cloudflare Worker for `https://directionallylocal.run`. It serves `install.sh` to `curl` at the bare domain (and `/install.sh`), sends browsers to directionallylocal.com, and serves nothing else. Subdomains of `directionallylocal.run` are users' instant addresses, and the domain is on the Public Suffix List, so the Worker never sets cookies. Deploy it with `npx wrangler deploy -c site/wrangler.toml`.

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

## License

Apache-2.0. See [LICENSE](LICENSE).
