# Directionally Local installer

Coding agents that run on your own computer or on your own server. Send a task; it runs in its own [Hotcell](https://github.com/directionally-local/hotcell) sandbox, driven by [Autopilot](https://github.com/directionally-local/autopilot), and comes back as a pull request, even with your laptop closed.

## Start on your laptop

```sh
npm install -g directionallylocal
dl
```

`dl` asks where your agents should run:

- **On this computer** — start now, nothing to rent, pauses when this computer sleeps. macOS and Linux; not offered on Windows yet (connect a server, or run `dl` inside WSL 2, which takes the Linux path).
- **On my own server** — keeps going when your laptop is closed; needs SSH access.

For a server, `dl` lists the hosts in `~/.ssh/config` (or takes `user@host[:port]`), checks it over SSH, installs itself there, and pairs this laptop. Nothing is exposed on the server: `dl` reaches it through an SSH tunnel.

### The keys it asks for

Two keys, kept on the server only. `dl` looks for them on your laptop first and offers each one it finds:

- **GitHub** — your GitHub CLI login (`gh auth token`), offered as *"Use your GitHub CLI login (you)? It stays on your server."* Otherwise it asks for a fine-grained token with Contents and Pull requests read/write.
- **OpenRouter** — the key in `OPENROUTER_API_KEY`, or the one Autopilot already has, offered the same way. Otherwise it asks for one.

The OpenRouter key goes into Hotcell's keystore on the server; sandboxes get spend-capped gateway tokens instead, and your laptop never sees it. The GitHub token stays on the server too; sandboxes push through Autopilot's repository-scoped proxy.

### The model

Setup asks once which model tasks and sessions use. The default is `deepseek/deepseek-v4.1-flash-1017`; if Autopilot already has a default model, that one is preselected instead. Change it any time with `dl model`, or per run with `-m`.

### It ends with

```
✓ Ready · fits ~6 agents at once (estimate)
  1 Start a session: cd into a GitHub repository, then type
      dl
  2 Or hand off a one-off task
      dl run "fix the flaky checkout test"

  dl status shows where agents run and what they're doing.
```

Then, from inside a GitHub repository:

```sh
dl                                  # talk to the repository's agent; it keeps running when you leave
dl run "fix the flaky checkout test"  # one-off task; your uncommitted changes go along
dl runs                             # tasks and their pull requests
dl pull <id>                        # check one out here
```

`dl status` says when a server is behind npm, once a day: `! box is behind: Autopilot 2.7.0 → 2.7.2   dl update box`.

The "fits ~N agents" figure is a conservative estimate: memory left after the host's own share (at least 1.5 GB or 15%), divided by 1 GB per sandbox, capped at two per CPU. Measured numbers will replace it.

## Commands

`dl` is short for `directionallylocal`; both work.

### On your laptop

| Command | What it does |
| --- | --- |
| `dl` | Set up the first time; afterwards, an overview. Inside a GitHub repository, that repository's agent session. |
| `dl setup` | Set up or repair where your agents run. Safe to re-run. `--identity FILE` names the SSH key to use. |
| `dl new` | In a GitHub repository: start a fresh conversation for it. |
| `dl status` | Where your agents run and what they're doing. Works anywhere. |
| `dl connect URL` | Connect to a server someone else set up; approve the code it shows. |
| `dl run "TASK"` | Run a task, from inside a GitHub repository. Ctrl-C stops watching, not the task. |
| `dl runs` | Your tasks and their pull requests. `--json` for scripts. |
| `dl watch ID` / `dl cancel ID` | Follow a task, or stop one. |
| `dl pull ID` | Check out a task's branch here. |
| `dl preview ID` | Deploy a task's Workers branch on the server with Serverless Objects and open it here, over the SSH tunnel. |
| `dl servers` | Where agents run. `dl servers rename OLD NEW`, `dl servers remove NAME`. |
| `dl use [NAME]` | Where tasks go without `--server`. With no name, shows it. |
| `dl keys [openrouter\|github]` | Which keys are set, or replace one. `--server NAME` picks the server. |
| `dl model [ID]` | The model for tasks and sessions. With no ID, picks from a list. |
| `dl update [NAME]` | Update a server's Autopilot, Hotcell and sandbox image over SSH. `--wait` waits for running tasks instead of asking; with no terminal it waits anyway. |
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
| `dl doctor` | Check every part, with a fix for each failure. |
| `dl keys [set openrouter\|github]` | Which keys are set, or replace one (hidden input). |
| `dl status` | Show the installed versions and where to reach the server. |
| `dl uninstall` | Remove the services and software but keep configuration and data. Add `--purge` to delete those too, plus the service accounts and the sandbox image. |

### Unattended installs

Set the answers as environment variables: `DL_TAILSCALE_AUTH_KEY`, `DL_OPENROUTER_API_KEY` and `DL_GITHUB_TOKEN`. `DL_ACCESS` picks how the server is reached: `tailscale` (the default), `loopback` (this machine only), or `ssh` (what the laptop's setup uses). `DL_SKIP_CREDENTIAL_CHECK=1` skips the online key checks for offline installs.

The laptop's setup drives the server over SSH with `dl up --access ssh --answers-stdin --events json`, which takes the keys as one JSON object on stdin and reports progress as JSON lines. `dl up --needs` reports which keys it would still ask for, without changing anything.

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

## License

Apache-2.0. See [LICENSE](LICENSE).
