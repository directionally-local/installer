# Directionally Local installer

Coding agents that run on your own computer or on your own server. Send a task; it runs in its own [Hotcell](https://github.com/directionally-local/hotcell) sandbox, driven by [Autopilot](https://github.com/directionally-local/autopilot), and comes back as a pull request, even with your laptop closed.

## Start on your laptop

```sh
npm install -g directionallylocal
dl
```

`dl` is the installer of the stack and nothing more. The first time it asks one question, where your agents should run:

- **On this computer** — start now, nothing to rent, pauses when this computer sleeps. macOS and Linux; not offered on Windows yet (connect a server, or run `dl` inside WSL 2, which takes the Linux path).
- **On my own server** — keeps going when your laptop is closed; needs SSH access.

For a server, `dl` lists the hosts in `~/.ssh/config` (or takes `user@host[:port]`), checks it over SSH, installs itself there, and pairs this laptop. Nothing is exposed on the server: `dl` reaches it through an SSH tunnel.

Then it installs Hotcell and Autopilot on the place, builds the sandbox image and starts the services, as a few progress lines. What a new user sees, start to finish:

```
  Directionally Local
  Background coding agents. Where should they run?

  ✓ Where                 On this computer
  ✓ Checking this computer   macOS 15.1 · Docker Desktop 29.5.2 · Node 24.22.1 · 120 GB free
  ✓ Installing Hotcell + Autopilot   Autopilot 3.0.3 · Hotcell 0.1.30
  ✓ Building the sandbox image   Node 24 · Autopilot 3.0.3
  ✓ Starting services     start at login · logs in ~/.directionallylocal/logs
  ✓ Connecting            this computer · tasks pause while it sleeps

  [Autopilot's own provider picker, key entry and model picker]

  ✓ Provider              DeepSeek · deepseek-v4-pro · key stays on this computer
  Use your GitHub CLI login (you)? It stays on this computer. [Y/n]
  ✓ GitHub                signed in as you · from the GitHub CLI
  ✓ Storing keys on this computer   DeepSeek · GitHub

  ✓ Ready · fits ~6 agents at once

  · Connecting to this-computer · chat …  (new chat, deepseek-v4-pro)
  [Autopilot's session]
```

### The provider and model

The provider and model are Autopilot's choice to make, so `dl` hands over to Autopilot's own picker (`autopilot connect`): any of its providers (OpenRouter, DeepSeek, OpenAI, Anthropic, Moonshot, Z.ai, Ollama, LM Studio, a custom OpenAI-compatible endpoint, …), its key, and its model. The same choice configures your own `autopilot` command. `dl` keeps the model as that place's model (`dl run` and sessions use it unless `-m` names another) and pushes the key to the place:

- **On this computer,** into Hotcell's keystore (a 0600 file under `~/.directionallylocal/hotcell`, not the login Keychain).
- **On a server,** over the same SSH channel the install used, into Hotcell's keystore there.

Keys stay on the place. Sandboxes get spend-capped gateway tokens from Hotcell instead; your laptop never holds a provider key for a place. Keyless providers (Ollama, LM Studio) store no key. Change the provider later with `dl provider set`, the model with `dl model`.

### The GitHub token

Agents push branches and open pull requests through GitHub, so each place needs a token. `dl` offers your GitHub CLI login (`gh auth token`) as *"Use your GitHub CLI login (you)? It stays on this computer."*; without one it says so in one line and asks for a fine-grained token with Contents and Pull requests read/write. The token stays on the place too; sandboxes push through Autopilot's repository-scoped proxy.

### Then a session

Setup ends with one line, `✓ Ready · fits ~6 agents at once`, and opens a session on the new place at once: inside a GitHub repository, that repository's code session; anywhere else, a chat. From then on bare `dl` does the same anywhere:

```sh
dl                                  # in a GitHub repository: its agent, reopened each time; elsewhere: a chat, resumed per directory
dl new                              # a fresh conversation here (the old one keeps running)
dl run "fix the flaky checkout test"  # one-off task; your uncommitted changes go along
dl runs                             # tasks and their pull requests
dl pull <id>                        # check one out here
dl status                           # where agents run, their provider, model and Autopilot version, what they're doing
```

In a git repository whose origin isn't on GitHub, `dl` says so in one line and opens a chat instead.

`dl status` says when a place runs another Autopilot than this laptop's `dl` bundles, and once a day when a server is behind npm: `! box is behind: Hotcell 1.4.0 → 1.4.1   dl update box`.

The "fits ~N agents" figure is a conservative estimate: memory left after the host's own share (at least 1.5 GB or 15%), divided by 1 GB per sandbox, capped at two per CPU. Measured numbers will replace it.

### One Autopilot version

`dl` bundles `autopilot-ai` at an exact version (its session client) and installs that same version on every place it sets up, including the sandbox image, so the client and the server never drift. `dl update NAME` brings a place back to it: a server gets its `dl` refreshed first (the install script) and then `dl up`; this computer re-runs its setup. When the laptop's own `dl` is behind npm, `dl update` says so with the one command that fixes it.

## Commands

`dl` is short for `directionallylocal`; both work.

### On your laptop

| Command | What it does |
| --- | --- |
| `dl` | The first time: set up where agents run, pick a provider and model in Autopilot's list, then talk to an agent. Afterwards: inside a GitHub repository, that repository's agent session; anywhere else, a chat on your default place, resumed per directory. |
| `dl setup` | Set up or repair where your agents run. Safe to re-run. `--identity FILE` names the SSH key to use. |
| `dl new` | Start a fresh conversation here; the old one keeps running. |
| `dl status` | Where your agents run, their provider, model and Autopilot version (next to this laptop's), and what they're doing. Works anywhere. |
| `dl connect URL` | Connect to a server someone else set up; approve the code it shows. |
| `dl run "TASK"` | Run a task, from inside a GitHub repository. Ctrl-C stops watching, not the task. |
| `dl runs` | Your tasks and their pull requests. `--json` for scripts. |
| `dl watch ID` / `dl cancel ID` | Follow a task, or stop one. |
| `dl pull ID` | Check out a task's branch here. |
| `dl preview ID` | Deploy a task's Workers branch on the server with Serverless Objects and open it here, over the SSH tunnel. |
| `dl servers` | Where agents run. `dl servers rename OLD NEW`, `dl servers remove NAME`. |
| `dl use [NAME]` | Where tasks go without `--server`. With no name, shows it. |
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

## The one-line server install

The curl path is still there for a server you set up by hand, as root on Ubuntu or Debian:

```sh
curl -fsSL https://directionallylocal.run | sh
```

It installs Node.js if needed, installs `directionallylocal`, and runs `dl up`. The laptop's setup uses the same script to bootstrap a server over SSH.

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

To test the whole flow with unpublished builds of Autopilot or Hotcell, set `DL_AUTOPILOT_SPEC` and/or `DL_HOTCELL_SPEC` to an npm spec or a path to a `.tgz` (`npm pack` in their checkouts). Local setup, `dl up` on a server and the sandbox image build then install those instead of `autopilot-ai@<pinned version>` / `hotcell@<latest>`; the release is named `dev` and is reinstalled and rebuilt on every run, since a dev build may have changed. The versions the builds report end up in the state file.

```sh
DL_AUTOPILOT_SPEC=~/autopilot/autopilot-ai-3.1.0.tgz DL_HOTCELL_SPEC=~/hotcell/hotcell-1.5.0.tgz dl
```

## License

Apache-2.0. See [LICENSE](LICENSE).
