# Directionally Local installer

Rent a server, paste one line, and send coding tasks to it from your laptop. Each task runs in its own [Hotcell](https://github.com/directionally-local/hotcell) sandbox, driven by [Autopilot](https://github.com/directionally-local/autopilot), and comes back as a pull request, even with your laptop closed.

```sh
curl -fsSL https://directionallylocal.run | sh
```

It asks three things:

1. **Tailscale auth key.** The server joins your tailnet and serves Autopilot on its private `https://<name>.<tailnet>.ts.net` address, with no public ports. Turn on MagicDNS and HTTPS certificates for the tailnet first. Own-domain and instant-address options are coming.
2. **OpenRouter API key.** This is stored in Hotcell's keystore on the server. Sandboxes get spend-capped gateway tokens instead, and your laptop never sees the key.
3. **GitHub token,** so runs can clone, push, and open PRs. A fine-grained token with Contents and Pull requests read/write on the repositories you'll use is enough. It stays on the server; sandboxes push through Autopilot's repository-scoped proxy.

It ends with:

```
✓ Ready. Fits ~6 agents at once (estimate).
  Open once to approve laptops in your browser: https://box.tail1234.ts.net/api/v1/auth/claim?token=…
  On your laptop (signed in to the same tailnet): autopilot remote add https://box.tail1234.ts.net
```

Then, on your laptop:

```sh
autopilot remote add https://box.tail1234.ts.net   # approve the code in the browser you opened the link in
autopilot --on box "fix the flaky checkout test"
```

The "fits ~N agents" figure is a conservative estimate from memory and CPUs (1 GB per sandbox). Measured numbers will replace it.

## Commands

Run these as root on the server. `dl` is short for `directionallylocal`; both work.

| Command | What it does |
| --- | --- |
| `dl up` | Install or repair everything. Safe to re-run: it keeps your keys and generated secrets and skips work that's already done. |
| `dl up --dry-run` | Print what `up` would change, without changing anything. |
| `dl doctor` | Check every part, with a fix for each failure. |
| `dl status` | Show the installed versions and where to reach the server. |
| `dl uninstall` | Remove the services and software but keep configuration and data. Add `--purge` to delete those too, plus the service accounts and the sandbox image. |

For unattended installs, set the answers as environment variables: `DL_TAILSCALE_AUTH_KEY`, `DL_OPENROUTER_API_KEY` and `DL_GITHUB_TOKEN`. `DL_ACCESS=loopback` skips Tailscale; you then reach the server over an SSH tunnel.

## What it sets up

- **Node.js 24 LTS,** if Node is missing or lacks the fix for CVE-2026-111497 (22.23.4+, 24.22.1+ and 26.12.1+ are accepted). Node security releases from NodeSource are added to Ubuntu's automatic updates, which otherwise skip them. Delete `/etc/apt/apt.conf.d/52directionallylocal-nodejs` to opt out.
- **Docker,** if it's missing, plus a rule that keeps sandboxes away from the cloud metadata endpoint. Docker isn't updated automatically, because its repo ships major upgrades and restarting the Docker daemon can stop running sandboxes.
- **Hotcell and Autopilot from npm,** under `/opt/directionallylocal/releases/<versions>`, with `current` pointing at the active release.
- **Two systemd services, each under its own unprivileged account:** `hotcell.service` (sandboxes and the credential gateway, on loopback) and `autopilot.service` (the API that laptops pair with, on `127.0.0.1:4096`). Only Tailscale Serve exposes it.
- **A sandbox image** with Node, git, Python, and the Autopilot runtime baked in.
- **Configuration** in `/etc/hotcell`, `/etc/autopilot` and `/etc/directionallylocal`, readable only by root and the matching service account. Data lives in `/var/lib/hotcell` and `/var/lib/autopilot`.

Supported: Ubuntu 24.04 and 22.04 and Debian 12, on x86_64 or arm64, with at least 4 GB of RAM and 15 GB free under `/var`.

## The install script's address

`site/` is the Cloudflare Worker for `https://directionallylocal.run`. It serves `install.sh` to `curl` at the bare domain (and `/install.sh`), sends browsers to directionallylocal.com, and serves nothing else. Subdomains of `directionallylocal.run` are users' instant addresses, and the domain is on the Public Suffix List, so the Worker never sets cookies. Deploy it with `npx wrangler deploy -c site/wrangler.toml`.

## Development

```sh
npm install
npm test          # node:test through tsx; a simulated server exercises up, doctor, and uninstall
npm run typecheck
npm run build
```
