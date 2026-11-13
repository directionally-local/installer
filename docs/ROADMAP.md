# Directionally Local roadmap

Coding agents on your own hardware, in six phases. Each phase ends at a gate you can test, not a date. A numbered phase starts when the one before it passes its gate. Phase 1.5 runs alongside phase 1 and never blocks phase 2. Everything else runs as a background track that never blocks the phases.

**Direction (since 10 November 2026):** dl's paid product is open models on GPUs you own. dl sets them up, tests every update and rolls back when one fails. It is for companies that self-host for privacy; the first target is US companies with their own GPUs. The free managed tier stays as the top of the funnel, and free tokens stay the default first-run option. The GPU work lives in [phase 1.5](#phase-15--your-own-gpus) and comes first in the week plan below.

Last updated 13 November 2026. Latest releases: dl 0.32.0, Autopilot 3.22.0, Hotcell 0.1.38.

Scope: the Directionally Local repositories (installer, autopilot, hotcell, serverless-objects, pr-deck), camouflage, and the Aster apps.

Issues carry a `phase-0` to `phase-5` label in `autopilot` and `installer`; `decision` marks a choice the owner has to make before building.

## The next eight weeks: 10 November 2026 to January 2027

On 10 November this plan replaced the ten-week plan from 3 November. Work is now ordered by one test: does it help a company run open models on its own GPUs, with updates it can trust? The free tier keeps bringing people in alongside. Items from the old plan that don't pass the test are under "Waits until later" below, each with its reason. Phase 0 daily use runs alongside, not before.

**Where the plan stands on 13 November**

Done:
- `dl model` v0.1 and every launch fix from week 2 (dl 0.22.0 to 0.28.0, Autopilot 3.18.0).
- GPU-aware first run and "Use your own GPUs", two weeks early (Autopilot 3.19.0, dl 0.26.0), with fixes from a real GPU run (Autopilot 3.20.1 and 3.20.2, dl 0.28.0 and 0.30.1).
- Several GPUs on one machine, SGLang as a second engine, preflight and `dl model up --plan` (dl 0.31.0), and `--image` (dl 0.32.0). Built and tested against recorded hardware output; not yet run on a real multi-GPU machine.
- Free tier: dl Pro and top-ups when free usage runs out, and `/usage` with the real limits (Autopilot 3.21.0 and 3.22.0).

In progress:
- One command for a full GPU box: the model on all GPUs, plus dl's agent in a Hotcell sandbox that sees only one workspace folder (`--workspace`), and `dl model down`.
- The first real run on a 4x RTX PRO 6000 machine (PCIe, Blackwell) with DeepSeek V4.1 Flash FP8, including checking vLLM v0.34.0rc2 there before it becomes the default image.

Left: every `dl model` screen on camouflage-tui, `dl model bench` on a real multi-GPU deployment, then everything in December and January below. The Kimi K2.6 entry and the 8-GPU GLM 5.3 Flash test now wait until a customer asks (see "Waits until later").

| Week | Dates | What ships |
| --- | --- | --- |
| 1 | 3–9 Nov | **Shipped: free managed tier.** GitHub sign-in, then an email address; free GPT-6 and DeepSeek tokens every week, how many depends on the GitHub account, `/request` for more; resets every Monday 00:00 UTC; a global spend stop, a kill switch, a per-request usage log (counts only). [installer#78](https://github.com/directionally-local/installer/issues/78), [autopilot#1102](https://github.com/directionally-local/autopilot/issues/1102) · Admin dashboard ([installer#86](https://github.com/directionally-local/installer/issues/86)) · Retire the old Kimiflare Cloud service ([installer#84](https://github.com/directionally-local/installer/pull/84) checklist) · **Shipped early, planned for weeks 4–6:** bring your Claude Code setup, core part: the first run reads `CLAUDE.md`, `AGENTS.md` and other agents' instruction files in place, brings in Claude Code commands, lists MCP servers and keeps deny rules (autopilot#1140; rest of [autopilot#1126](https://github.com/directionally-local/autopilot/issues/1126) below) · **Continue in dl:** `dl --from-claude-code` and the opt-in `dl claude-code hook install` that offers it when Claude Code hits a limit ([autopilot#1127](https://github.com/directionally-local/autopilot/issues/1127)) · **Autopilot reports its state to herdr** (autopilot#1115, for [autopilot#1103](https://github.com/directionally-local/autopilot/issues/1103)) |
| 2 | 10–16 Nov | **Shipped: dl model v0.1.** The first `dl model up`, `update`, `rollback` and `status` shipped in dl 0.22.0 (installer#179). **Verified on real hardware on 10 Nov, released in dl 0.25.0:** side-by-side update, rollback (fixed), per-run log files, smoke tests with a KV-capacity check, and `dl model bench` (built early, originally weeks 3–4). Autopilot edited a file using a local model with `--dangerously-allow-all`. **The open items from 10 Nov, all shipped:** Autopilot caps `max_tokens` at a local server's context length (Autopilot 3.18.0); headless runs follow the interactive permissions, exit 45 when a run didn't finish, and can't read or write credentials without an exact rule (Autopilot 3.18.0); a missing Nvidia container toolkit is detected and offered for install (dl 0.25.0 and 0.26.0); download progress (dl 0.28.0); GPU memory checks before a side-by-side update (dl 0.25.0), later a full preflight (dl 0.31.0); the update comparison uses a fixed-length bench, so tok/s is no longer inflated (dl 0.25.0) |
| 3–4 | 17–30 Nov | **Shipped early, in week 2: GPU-aware first run** (Autopilot 3.19.0, dl 0.26.0). Autopilot detects Nvidia, AMD or Ascend GPUs and offers a private model. "Use your own GPUs" joins the provider choice after free tokens and your own key, with three paths: this machine, another server through an SSH tunnel, or an existing OpenAI-compatible endpoint. Anonymous GPU counts and an optional early-access email (Autopilot 3.20.0, dl 0.27.0). Fixes from a real GPU run: smoke tests that work with thinking models, progress, the model picker, short GPU lines, a failure menu (Retry, See what failed, Pick another model, Continue) and vLLM reasoning (Autopilot 3.20.1, dl 0.28.0); a slow `nvidia-smi` gets 10 s and a retry before the no-GPU path (Autopilot 3.20.2); the chat test waits 120 s for a first answer, keeps the container on failure, reuses it on Retry, logs every request and prints a curl line to reproduce it (dl 0.30.1) · **Shipped: several GPUs on one machine** (dl 0.31.0). Detection reads how GPUs connect (PCIe or NVLink) and picks tensor or pipeline parallel; "models that fit" counts every GPU; SGLang as a second engine; `--gpus` and `--port` keep deployments apart, `dl model list` shows them; a preflight checks VRAM per GPU, RAM for offload, disk and KV before any download; `dl model up --plan` prints the command and memory math without running anything. `--image` runs a catalog entry in another container image and shows in `--plan` (dl 0.32.0) · **Partly shipped: catalog** (dl 0.31.0). DeepSeek V4.1 Flash 1017 FP8 and GLM 5.3 Flash are in, marked untested; the NVIDIA FP4 build of DeepSeek is listed but blocked until an engine release loads it · **In progress:** one command for a full GPU box: the model on all GPUs plus dl's agent in a Hotcell sandbox limited to one workspace folder, pointed at the local model and shown in `--plan` (`--workspace`), and `dl model down` · **In progress:** the first real run on a 4x RTX PRO 6000 machine (PCIe, Blackwell) with DeepSeek V4.1 Flash FP8, checking vLLM v0.34.0rc2 there before it becomes the default · **Not started:** every `dl model` screen on camouflage-tui (the first-run failure menu already is); `dl model bench` on a real multi-GPU deployment |
| 5–8 | December | **Not started:** Run several copies of a model behind one endpoint (assigning GPUs shipped early, as `--gpus` in dl 0.31.0) · Rolling updates for models that fill a whole machine · **`dl adopt`** brings an existing vLLM or SGLang setup under dl without replacing it · Every update runs the customer's own test prompts · The first design partners run dl in production |
| 9 on | January | **Not started:** Several machines, with `dl model status` across the fleet · A Kubernetes path through `dl adopt` · AMD (ROCm), if a design partner needs it · **Paid update plan** (details not public until confirmed) |

**Kept throughout, because they protect the first run:** free tokens as the default first-run option, laptop mode (plain Autopilot), every `dl` a new session with `dl -c` to continue, eight sessions on an 8 GB laptop, the fresh-VM test, and guardrails for destructive actions so a first run never costs anyone their data ([autopilot#1125](https://github.com/directionally-local/autopilot/issues/1125)).

**Waits until later, unless it breaks something for users:**
- **Bring your Claude Code setup, the rest** (old weeks 4–5): translating skills and subagents, OpenCode commands and agents, plugin equivalents, a reset for "Always / Don't" answers, the checklist during `dl` install, and a measured first session under two minutes ([autopilot#1126](https://github.com/directionally-local/autopilot/issues/1126)). The core already works; the rest follows the GPU work.
- **Two models per GPU box, beyond `--gpus` and `--port`** (moved here on 13 Nov). Separate GPUs and ports for each deployment shipped in dl 0.31.0; anything more waits, because the target setup is one model and one isolated agent per box.
- **More models: Kimi K2.6 in the catalog, and a GLM 5.3 Flash test on a rented 8-GPU node** (moved here on 13 Nov). Our design partner runs only DeepSeek V4.1 Flash, so new models are added when a customer asks for one. GLM 5.3 Flash stays in the catalog, untested.
- **Paid plan for free-tier users** (old week 8, [installer#88](https://github.com/directionally-local/installer/issues/88)). Built: Stripe checkout and billing portal in the free tier service (installer#121) and `/upgrade` in Autopilot (autopilot#1149). Offering it was to follow the GPU work, because the paid product is now dl model. **Shipped on 12 Nov anyway, as the free tier's paywall:** dl Pro and top-ups when free usage runs out (Autopilot 3.21.0, dl 0.29.0). See the free tier lane below.
- **Fixes from the paid plan's launch** (old week 9). They follow that launch.
- **"Your tokens are back"** (old week 7, [installer#87](https://github.com/directionally-local/installer/issues/87)). Autopilot already shows the local reset time (autopilot#1128); the notice itself follows the GPU work.
- **A pull request upstream so herdr lists dl** (old week 7). The state reporting it needs has shipped; the listing helps the multiplexer, which waits too.
- **A hardening week where nothing new starts** (old week 10). January now carries the fleet work; hardening happens in each week's fixes.
- **Reboot-required warnings and the release floors check** (waiting since 3 Nov). Neither helps the GPU work or the first run.
- **The multiplexer (phase 2), the native apps (phase 3), team servers and autonomous agents (phases 4 and 5)** (waiting since 3 Nov). The GPU work comes first; each phase keeps its gate.

Pull requests titled from commits already shipped (autopilot#1114).

## Parallel lane: the free managed tier

People sign in with GitHub, then add an email address (one free account per email), and get free GPT-6 and DeepSeek tokens every week instead of bringing an API key. How many depends on the GitHub account; `/request` in dl asks for more. The week resets every Monday at 00:00 UTC. Free tokens only work inside dl and Autopilot. Bring-your-own-key stays unlimited and free. Since 10 November the free tier is the top of the funnel for the paid GPU product, and free tokens stay the default first-run option. Tracked in [installer#78](https://github.com/directionally-local/installer/issues/78) (service) and [autopilot#1102](https://github.com/directionally-local/autopilot/issues/1102) (client).

**Shipped**
- Sign in with GitHub through a device code, from `autopilot` or `dl`, then an email address.
- GPT-6 (`gpt-6-luna` by default, also `gpt-6.1-sol` and `gpt-6-astra`) via OpenAI, and DeepSeek V4.1 Flash via Luminal, as the fallback and selectable by hand.
- A weekly allowance per person; each request reserves its tokens first, so nobody overshoots.
- Usage stored as counts per request, never prompt or code content.
- A global spend stop and a kill switch.
- An admin view of people and usage.
- "Free, sign in with GitHub" first on Autopilot's first-run question, with `/usage`, `/request` and `/invite`.
- dl Pro and top-ups as the next step when free usage runs out; `/usage` shows the real limits (Autopilot 3.21.0, dl 0.29.0).
- Separate weekly budgets for DeepSeek and GPT-6; when GPT-6's runs out, Autopilot offers DeepSeek (Autopilot 3.22.0, dl 0.30.0).
- Admin: a plain-language home screen, a Health view, and tokens and users per provider (dl 0.24.0 to 0.30.0).

**Not yet:** free tokens for background tasks and server sessions; other sign-ins.

**Built as** a portable Workers app on Durable Objects with SQLite, per the installer's portable-services rules, so it also runs on Serverless Objects.

Allowance amounts, eligibility rules and budgets are operational settings, not published here.

## Phase 2 in detail: the multiplexer MVP

**herdr** (herdrdev/herdr, Rust, Apache-2.0, about 47,000 stars) is a terminal multiplexer for coding agents: a background server owns the sessions, clients attach and detach like tmux, a sidebar shows every agent's state, and it runs any CLI in a real terminal pane. It learns each agent's state by reading the bottom of its screen against per-agent rules, which can misread an approval prompt as idle; agents can instead report their state through herdr's protocol.

**Our angle:** Autopilot already emits exact events, so our panes need no screen-reading: state, cost, model, current tool and pull request come straight from the session. Sessions already live in a server, locally or remotely, so detach and reattach come for free, and a session in a sandbox on a server is as easy to show as a local one. Running other CLIs, like Claude Code or a shell, needs a terminal emulator inside a pane; that comes after the MVP.

**In the MVP**
- **Start a session from an issue:** pick a repository and an issue (or paste its URL); the agent starts in its own sandbox from the latest main, on its own branch, and ends in a pull request. Four issues become four sessions with no clones, no panes to set up, and no "pull main" or "open a PR" instructions.
- A sidebar of places, then repositories, then sessions, each with state, age, cost and pull request.
- The focused session on the right, using today's renderer.
- New session; jump to the next session that needs you; a picker filtered by blocked, working, idle or done.
- A "done but not yet seen" mark.
- Notifications for sessions not on screen.
- Detach and reattach; several terminals attached at once.
- Opened with `dl deck`; works across this computer and servers.

**After the MVP:** terminal panes for any CLI and a shell; splits and tabs; mouse support.

**Ahead of the MVP, cheaply:** Autopilot reports its state through herdr's protocol ([autopilot#1103](https://github.com/directionally-local/autopilot/issues/1103)), so people who already use herdr see Autopilot correctly today.

**Decided with [installer#72](https://github.com/directionally-local/installer/issues/72):** dl on a laptop runs plain Autopilot, so those sessions aren't in a server and the multiplexer can't list them. Either plain Autopilot publishes its events on a local socket the multiplexer reads, or terminal panes come earlier. [decision](decisions/laptop-mode.md)

## Release plan

Each repository's release bot picks the number from commit types: a feature bumps the minor version, a fix bumps the patch. This plan names **feature releases only**; patch releases ship in between and are not planned. Numbers are targets: if an unplanned feature lands first, the contents move up a number.

### dl (`directionallylocal`)

| Version | Phase | Contents |
| --- | --- | --- |
| 0.9.4 (now) | 0 | Autopilot's provider picker, any provider, picker shown once, chats reopen, Autopilot 3.1 pinned |
| 0.10 | 0 | Every `dl` a new session, `dl -c` to continue; on a laptop bare `dl` runs plain Autopilot · installer#71, #72 |
| 0.11 | lane | Setup offers the free tier first: sign in with GitHub, no key needed; default model becomes the plain `deepseek-v4.1-flash` · installer#78 |
| 0.12 | 0 | Hotcell pinned exactly · reboot-required warning · version-skew warning · installer#73, autopilot#1041 |
| 0.13 | 1 | Fixes from the fresh-VM test · installer#47 |
| 0.14 | 1 | `dl sessions` across places; sleeping sandboxes and disk in `dl status` · installer#49 |
| **1.0** | 1 gate | Released when the fresh-VM test passes: a solo server is ready for strangers |
| 1.1 | 2 | `dl deck`: the multiplexer across every place · installer#48, #54 |
| 1.2 | 4 | Join a server with a link and approve a teammate in the browser · installer#75 |
| 1.3 | 4 | `dl team` · installer#76 |
| 1.4 | 5 | `dl agent` scripting, `dl schedule` · installer#51, autopilot#1100 |

### Autopilot (`autopilot-ai`)

| Version | Phase | Contents |
| --- | --- | --- |
| 3.1.2 (now) | 0 | `autopilot/` folders, any-provider sandboxes, `autopilot connect`. 3.1.3 (fixes) is queued. |
| 3.2 | 0 | Session titles, state and cost; `/resume` and `/clear` in remote sessions; your messages in history · #1046, #1092, #1093 |
| 3.3 | 0 · 2 | Pull requests titled from commits; Autopilot reports its state to herdr · #1049, #1103 |
| 3.4 | lane | The free managed tier: "Directionally Local, free" in the provider picker, GitHub sign-in, `/usage` · #1102 |
| 3.5 | 1 | Typed outcomes; one retry on transient failures · #1096, #1043 |
| 3.6 | 1 | Outbox for outside actions; sandbox cleanup · #1097, #1094 |
| 3.7 | 1 | Faster session start: measured, then a git mirror per repository · #1095 |
| 3.8 | 2 | The multiplexer's data feed: every conversation on a place in one stream · #1048 |
| 3.9 | 4 | People on a server; per-person limits; a slot reserved for people; PR identity · #1098, #1099 |
| 3.10 | 5 | Subagents that write · #1052–1054 |
| 3.11 | 5 | Scheduled loops, record-only first; long commands to the background · #1100, #1101 |
| 3.12 | 5 | Agent team: router, gate, stored mandates, reviewer, merge policy · #1020 |
| any | track | Harness quality ships between these: per-model profiles #999, memory #1073–1078, turn-engine refactor #951. No 4.0 is planned; CI blocks accidental major bumps. |

### Hotcell

| Version | Phase | Contents |
| --- | --- | --- |
| 0.1.38 (now) | 0 | Routes for every Autopilot provider, opt-in local model routes, price fallbacks |
| 0.2 | 1 | **Proposal:** the release config turns every feature into a patch, so 38 releases are all 0.1.x. Let features bump the minor version from here. First minor: read-only host folders in a sandbox, for the git mirror · autopilot#1095 |
| 0.3 | 1 | Cleanup support: delete idle sandboxes in bulk, report disk pressure · autopilot#1094 |
| 0.4 | 1 | Saved starting points per repository on the Docker driver · autopilot#1095 |
| 0.5 | 4 | Budgets per person in the gateway · autopilot#1099 |
| 0.6 | 4 | Firecracker as the recommended driver on shared Linux servers: each sandbox gets its own kernel |

Nothing further is planned; Hotcell's roadmap follows what Autopilot needs.

### camouflage-tui

| Version | Phase | Contents |
| --- | --- | --- |
| 2.11.0 (now) | 0 | Inline renderer; assumes 80×24 when a terminal reports no size |
| 2.12 | 2 | Several sessions in one stream, with per-session status · camouflage#146 |
| 2.13 | 2 | Notifications for sessions not on screen · camouflage#147 |
| 2.14 | 2 | Deck layout · camouflage#149 |
| 2.15 | 2 | Deck input and the goto picker · camouflage#150 |
| 2.16 | track | SDK lifecycle handles · camouflage#131 |
| 3.0 | track | Remove the old full-screen renderer, a deliberate breaking change · camouflage#134 |

### Serverless Objects

| Version | Phase | Contents |
| --- | --- | --- |
| 0.13.6 (now) | track | Pre-alpha, single host |
| 0.14 | track | Conformance on Linux; PartyServer, Containers, RPC through deploy · #115, #130, #132, #133 |
| 0.15 | track | Beta after the 14-day soak · #114 |
| later | parked | M4 (multi-node, SSO, audit logs, Helm, tenancy) waits until a team needs it. Its README still targets 30 Nov; one of the two should change. |

### Aster apps

| Version | Phase | Contents |
| --- | --- | --- |
| iOS 1.0 (7), TestFlight | 3 | Chat and an older server pairing; paused |
| iOS 1.1 | 3 | Pairs to dl places; answers a session started in the terminal |
| Mac 0.1 | 3 | One session end to end; unreleased today |
| Mac 0.2 | 3 | Parallel sessions with a sidebar |

**Naming:** "dl server" is the part of Autopilot (`autopilot serve`) that runs agent sessions in sandboxes for dl; the code still calls it Aster. "Aster" in this document means only the Mac and iPhone apps.

## Principles

- **dl installs, Autopilot is the product.** dl sets up Hotcell and Autopilot and then gets out of the way. Provider, model and sessions are Autopilot's job. Since 10 November dl also runs open models on your GPUs (`dl model`), and that is what companies pay for. Autopilot still chooses which provider and model a session uses; a `dl model` deployment is one more provider.
- **Never cripple Autopilot.** Whatever works in plain `autopilot` must work through dl, or dl should just run plain Autopilot.
- **Every `dl` is a new session,** like `autopilot` and Claude Code. Old sessions come back through Autopilot's `/resume`, not through dl.
- **The sandbox is the safety model.** Agents that run unattended run in a Hotcell sandbox, end in a pull request, and never hold your real keys.
- **Take as little human attention as possible.** Every message, notification and setting must pay for the attention it costs.
- **Test as a stranger, every release.** Wipe the laptop, start from the website, follow only what the screen says.
- **Pin what you ship.** dl pins one exact Autopilot everywhere it installs; Hotcell should be pinned the same way.

## Phases

### Phase 0 — One person, one laptop, every day

You use dl as your daily coding agent, and a stranger can install it from the website without help.

**Gate:** two weeks of daily use, and a wiped-laptop install that passes with no surprises.

| Status | Item | Issues |
| --- | --- | --- |
| Done | Any provider, chosen in Autopilot's own picker | hotcell#63, autopilot#1056, #1057, installer#55 |
| Done | Setup ends in a session, picker shows once, chats reopen; role labels on the install step | installer#62, #68 |
| Done | No `kimiflare` folders for new users; old installs moved once | autopilot#1081, installer#65 |
| Decided | On a laptop, dl runs plain Autopilot; servers keep the sandboxed remote mode | installer#72, [decision](decisions/laptop-mode.md) |
| Filed | Every `dl` starts a new session; `dl -c` continues | installer#71 |
| Filed | Remote sessions match plain Autopilot: `/resume`, `/clear` | autopilot#1092 |
| Filed | Your own messages appear when you reopen a session | autopilot#1093 |
| Filed | Session list carries title, state and cost | autopilot#1046 |
| Filed | Pull requests titled from commits, not the prompt | autopilot#1049 |
| Partly done | One Autopilot version across laptop and places (exact pin shipped; skew warning left) | autopilot#1041 |
| Filed | Release hygiene: pin Hotcell, floors check on release PRs, flaky test | installer#73, #74, autopilot#1091 |

### Phase 1 — One person, their own server

The original self-host promise: send tasks from the laptop, close it, come back to pull requests.

**Gate:** the fresh-VM acceptance test passes — three parallel tasks in three repos each open a PR while the laptop is closed.

| Status | Item | Issues |
| --- | --- | --- |
| Filed | Fresh-VM acceptance test | installer#47 |
| Filed | Clean up old sandboxes: a day after the PR closes, after 7 idle days, oldest-first on low disk; push work first; keep the transcript | autopilot#1094 |
| Filed | Typed outcomes: progress, waiting, ready, blocked, failed, dropped, with the checks actually run | autopilot#1096 |
| Filed | An outbox for PRs, comments and notifications | autopilot#1097 |
| Filed | Retry a task once after a transient failure | autopilot#1043 |
| Done | Pause idle sandboxes after 15 minutes (disk only, no RAM or CPU); resume on the next message | shipped |
| Filed | Fast session start: measure, then a git mirror per repo, then a saved starting point | autopilot#1095 |
| Filed | See sessions across all places | installer#49 |

### Phase 1.5 — your own GPUs

Run open models on hardware you control. This started in weeks 2–3 alongside the solo-server work; it does not wait for the phase 1 gate or block phase 2. Since 10 November it is the paid product and comes first in the week plan.

**First release, planned by 11 Nov, shipped in dl 0.22.0 on 9 Nov:** `dl model up` sets up vLLM in Docker on one Nvidia machine. `dl model status` shows what is running; `dl model update` deploys a new version; `dl model rollback` returns to the last working one.

**Verified on 10 Nov** on a rented RTX PRO 5000 (48 GB), from the `feat/model-command` branch: Nvidia, one GPU, vLLM in Docker. Smoke tests, a check that the KV cache fits before starting, a side-by-side update, and automatic recovery when an update fails all worked live. The evening test verified the rollback fix, per-run log files and `dl model bench` (built early, originally weeks 3–4); Autopilot edited a file using the local model with `--dangerously-allow-all`. On Qwen3-4B-Instruct-2507 with 1× RTX PRO 5000, the benchmark measured **126 tok/s single stream, 3,387 tok/s aggregate at 32 concurrent requests, TTFT 0.15 s (p50 at 32 concurrent), and prefix cache 50%**. These replace the earlier short-burst throughput reading; the update comparison still shows the old inflated tok/s number. [Test notes and raw outputs](https://github.com/directionally-local/installer/blob/feat/model-command/docs/gpu-test-2026-11-10.md).

**Gate:** on one Nvidia machine, bring up a model, update it, and recover from a failed update automatically without losing the working deployment. Met on that branch on 10 Nov; **passed** when the branch shipped in dl 0.25.0 on 11 Nov.

**Multi-GPU, 13 Nov:** dl 0.31.0 and 0.32.0 add several GPUs per machine, SGLang, preflight, `--plan` and `--image`. No multi-GPU machine was available while building them, so they are tested against recorded `nvidia-smi` output from three machines (1x RTX PRO 5000, 4x RTX PRO 6000 over PCIe, 8x H100 over NVLink), and the single-GPU output is pinned byte for byte. The first real run, on a 4x RTX PRO 6000 machine, is in progress.

| Status | Item | Issues |
| --- | --- | --- |
| Done | Model setup: choose an open model, check the Nvidia GPU and Docker, start vLLM, and connect dl to it | installer#179 |
| Done, dl 0.25.0 | Test updates before switching traffic; automatically roll back on failure, with manual `dl model rollback` as a fallback | `feat/model-command` |
| Done, dl 0.25.0 | Rollback fix, per-run log files and `dl model bench` (built early, originally weeks 3–4) | `feat/model-command` |
| Done, dl 0.25.0–0.28.0, Autopilot 3.18.0 | Launch fixes: `max_tokens` from context length, headless exit codes and write permissions, nvidia-container-toolkit detection and install, download progress, usable-VRAM thresholds, old inflated tok/s in the update comparison | autopilot#1233, #1238, #1239, #1240; installer#219, #229 |
| Done, Autopilot 3.19.0 / dl 0.26.0 | GPU-aware first run and a "Use your own GPUs" provider option: this machine, another server through an SSH tunnel, or an existing OpenAI-compatible endpoint. Early-access counts and an optional email in Autopilot 3.20.0 / dl 0.27.0 | autopilot#1244, #1245; installer#219, #224 |
| Done, Autopilot 3.20.1–3.20.2 / dl 0.28.0–0.30.1 | Fixes from a real GPU run: thinking-safe smoke tests, progress, picker, short GPU lines, a failure menu, vLLM reasoning, slow `nvidia-smi`, a 120 s first answer with the container kept for Retry | autopilot#1249, #1251; installer#229, #238 |
| Not started | Every `dl model` screen on camouflage-tui (the first-run failure menu in Autopilot already is) | new |
| Partly done, dl 0.31.0 | A catalog with each model marked tested or untested. Tested: the Qwen pair. Untested: DeepSeek V4.1 Flash 1017 FP8, GLM 5.3 Flash. Blocked until an engine release loads it: DeepSeek's NVIDIA FP4 build | installer#241 |
| Done, dl 0.31.0 (not yet on real multi-GPU hardware) | Multi-GPU deployments on one machine (was "Later"): PCIe or NVLink detection, tensor and pipeline parallel sizing, SGLang, `--gpus`/`--port` and `dl model list`, preflight, `dl model up --plan` | installer#241 |
| Done, dl 0.32.0 | `--image` runs a catalog entry in another container image, shown in `--plan` | installer#243 |
| In progress | One command for a full GPU box: the model on all GPUs, plus dl's agent in a Hotcell sandbox limited to one workspace folder, pointed at the local model and shown in `--plan` (`--workspace`); `dl model down` | `feat/model-workspace-sandbox` |
| In progress | First real run on a 4x RTX PRO 6000 machine (PCIe, Blackwell sm120) with DeepSeek V4.1 Flash FP8; vLLM v0.34.0rc2 validated there before it becomes the default image | new |
| Not started | `dl model bench` on a real multi-GPU deployment | new |
| Waits until later | Kimi K2.6 in the catalog, and a GLM 5.3 Flash test on a rented 8-GPU node: models are added when a customer asks | new |
| Waits until later | Two models per box beyond `--gpus` and `--port`: the target setup is one model and one isolated agent | new |
| Planned, December | Several model copies behind one endpoint; rolling updates for models that fill a machine; the customer's own test prompts in every update | new |
| Planned, December | `dl adopt` (was "Later", as `dl model adopt`) brings an existing vLLM or SGLang setup under dl's management without replacing it | new |
| Planned, January | Several machines and fleet-wide `dl model status`; a Kubernetes path through `dl adopt`; the paid update plan | new |
| Planned, January | AMD (ROCm) support, if a design partner needs it (was "Later", with multi-GPU) | new |

### Phase 2 — A multiplexer for many sessions

One terminal for every agent session, local and on servers, like herdr but with exact state instead of screen-reading.

**Gate:** you run ten sessions across two places for a week from one terminal, and always know which one needs you.

| Status | Item | Issues |
| --- | --- | --- |
| Filed | Autopilot reports its state to herdr | autopilot#1103 |
| No issue | Start a session from an issue: own sandbox from latest main, own branch, ends in a PR | installer, autopilot, new |
| Filed | Several sessions in one stream, with per-session status | camouflage#146, autopilot#1046 |
| Filed | Sidebar and focused session | camouflage#149 |
| Filed | Input routing, new session, goto picker, done-but-unseen | camouflage#150 |
| Filed | Notifications for sessions not on screen | camouflage#147 |
| Filed | `dl deck` across every place | installer#48, #54, autopilot#1048 |
| No issue | Terminal panes for any CLI (after the MVP) | camouflage, new |

### Phase 3 — Native apps on the same server

The Mac and iPhone apps become windows onto the same sessions: a new tab is a new session.

**Gate:** a session started in the terminal can be answered from the phone.

Both apps are paused until phase 2 passes; the multiplexer settles the session model the apps reuse.

### Phase 4 — A small team on one server

One shared box where each person is still themselves: their own name on PRs, their own limits.

**Gate:** a design-partner team of three to eight uses one server for two weeks.

| Status | Item | Issues |
| --- | --- | --- |
| Decision | Each person's name on their own PRs: a GitHub App, or each person's token on the server | autopilot#1098 |
| Filed | Join a server without SSH: `name.directionallylocal.run` and a browser approval page | installer#75 |
| Filed | Per-person spend limits, a fair share of agent slots, and a slot reserved for people | autopilot#1099 |
| Filed | A team view for the admin | installer#76 |

### Phase 5 — Agents that work on their own

Agents that write in parallel, run on schedules, and find and finish work.

**Gate:** a week in which scheduled and dispatched agents produce pull requests you merge, and nothing merges that you didn't mean to.

| Status | Item | Issues |
| --- | --- | --- |
| Filed | Subagents that write, returning reviewed patches | autopilot#1051–1055 |
| Filed | Script your agents | installer#51 |
| Filed | Scheduled loops, starting record-only | autopilot#1100 |
| Filed | Agent team: router plus one sandboxed worker per ticket, a deterministic gate, record-only rules, stored mandates, merge policy | autopilot#1020, serverless-objects#137 |

## Loops, graphs, and what DeepSeek's SuperAgent teaches

A **loop** is one agent repeating act, check, fix inside a single piece of work. A **graph** coordinates many pieces of work with explicit states and hand-offs. Loops go inside graph nodes, and a graph earns its complexity only when work runs in parallel, unattended, or needs an audit trail — phase 5.

- **The inner loop is already ours.** Autopilot is the loop; Hotcell isolates it; the server keeps state, budgets and wake timers.
- **The outer loop is phase 5:** schedules that start work without a prompt, a reviewer for another agent's PR, a merge policy and revert on a broken main.
- **The graph stays small and fixed:** one stored state machine for the agent team — request, gate, judgement, ticket, worker, report, review, merge. Not a general workflow engine.

[deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) (MIT, published 31 Oct 2026, a research prototype rather than a DeepSeek product) is a proactive agent for one GitHub repository built on DeepSeek Harness. It has the same shape as our agent-team design.

| What they do | What to take | Where it lands |
| --- | --- | --- |
| Core rule: take as little human attention as possible | Adopt as a principle; the panel lists only what waits for a person | All phases |
| One router session decides; one worker session and directory per ticket does the work | Same split, with each worker in a Hotcell sandbox | Phase 5 |
| A deterministic gate (who may ask; explicit or inferred) before any model judgement | Allowed lists and an admission table first; issue text is data, never authority | Phases 4–5 |
| Accept modes off / observe / auto; new rules start in observe | Every scout and rule starts record-only | Phase 5 |
| A stored mandate per ticket: policy version, scope, strength, matched rules | Store the authority with each unattended task | Phase 5 |
| Typed reports: progress, waiting, ready, blocked, failed, dropped | Typed outcomes for every session and task | Phase 1 |
| One concurrency slot reserved for a person's message | Reserve capacity for people on shared servers | Phase 4 |
| Shell commands over 5 s move to the background and wake the worker on completion | Copy into Autopilot's tool loop | Harness track |
| Every side effect stored first, then executed with backoff and ordering | An outbox on the server | Phase 1 |
| Never auto-merge as the agent's own account | A starting merge policy | Phase 5 |
| Setup by asking a coding agent to follow SETUP.md | A small experiment against the installer wizard | Phase 0 idea |

**Where we're ahead:** SuperAgent's workers run as the operator's own user; its docs call its directories "defaults, not a security boundary". Hotcell sandboxes and the key gateway are a real boundary.

## Background tracks

These never block a phase.

- **Harness quality:** per-model profiles (autopilot#999); memory on by default, cheaper, deduplicated, measured (autopilot#1073–1078); turn-engine refactor (autopilot#951); long commands to the background (autopilot#1101); renderer health (camouflage#131, #133, #134); finish the rename (autopilot#911).
- **Serverless Objects:** beta (serverless-objects#114, #115, #130, #132, #133), then Autopilot runs on it (autopilot#1003). M4 parked.

## Decisions owed

1. ~~**On a laptop, does dl run plain Autopilot or the sandboxed remote mode?**~~ **Decided:** plain Autopilot on laptops, the sandboxed remote mode on servers. The multiplexer still needs another way to see laptop sessions. [installer#72](https://github.com/directionally-local/installer/issues/72), [decision](decisions/laptop-mode.md)
2. **Whose identity goes on an agent's pull request on a shared server?** Blocks phase 4. [autopilot#1098](https://github.com/directionally-local/autopilot/issues/1098)
3. **How does a teammate reach a shared server?** SSH, the team's Tailscale, or a public address. Blocks phase 4.
4. **Who pays, and who gets stopped?** One company key with per-person limits, or everyone's own key. Blocks phase 4.
5. **What happens when a server is full?** Queue, per-person share, or a second server.
6. ~~**Free tier: do cached tokens count fully toward the weekly allowance, how many people get in, and what's the privacy statement at sign-in?**~~ **Decided:** cached tokens count at their real cost; a weekly allowance per person (amounts are operational settings, see the free tier lane); one account per GitHub user; accounts under 30 days need an invite. [installer#78](https://github.com/directionally-local/installer/issues/78)
7. **Should the floors check block release PRs?** [installer#74](https://github.com/directionally-local/installer/issues/74)
8. **What is the pricing unit for the paid self-hosted update plan?** Per GPU, per machine, or per company. Still open on 13 Nov.
9. **Which models get "tested" status first?** Partly answered on 13 Nov: the Qwen pair is tested on one RTX PRO 5000. DeepSeek V4.1 Flash 1017 FP8 and GLM 5.3 Flash are in the catalog, untested. DeepSeek is next, from the first real 4x RTX PRO 6000 run.
10. **Does the free tier's spend cap need lowering, given recent sign-ups?** Partly answered on 12 Nov: separate weekly budgets for DeepSeek and GPT-6, and dl Pro and top-ups when free usage runs out (Autopilot 3.21.0 and 3.22.0). Whether the global cap changes is still open.

## Every open issue, placed on the roadmap

Read on 2 November 2026 across autopilot, hotcell, installer, serverless-objects, camouflage and aster-ios. pr-deck has no open issues.

| Verdict | Issue | Title | Where it fits | Why |
| --- | --- | --- | --- | --- |
| Core now | [autopilot#1041](https://github.com/directionally-local/autopilot/issues/1041) | dl: one Autopilot on the laptop, kept current by dl update | Phase 0 | Exact pin already shipped in dl 0.9.x. The version-skew check is left, and it matters less now that laptop dl runs plain Autopilot. |
| Core now | [autopilot#1043](https://github.com/directionally-local/autopilot/issues/1043) | dl server: retry a cell turn once on a transient failure | Phase 1 | Unattended server work dies on a provider blip without it. |
| Core now | [autopilot#1046](https://github.com/directionally-local/autopilot/issues/1046) | dl server: conversation summaries carry what a sidebar needs | Phase 0, pulled forward | Written for the deck, but /resume needs the same per-session title, state and cost to list sessions. |
| Core now | [autopilot#1049](https://github.com/directionally-local/autopilot/issues/1049) | dl server: build a conversation's PR title and body from its commits and final summary | Phase 0 | Every agent PR is titled with the raw prompt. Seen in your own dogfood PRs. |
| Core now | [installer#47](https://github.com/directionally-local/installer/issues/47) | Fresh-VM acceptance test: three parallel dl run tasks each open a PR | Phase 1 gate | The acceptance test for a solo server. Never run. |
| Roadmap, later | [autopilot#1020](https://github.com/directionally-local/autopilot/issues/1020) | Agent team: scouts, dispatcher, reviewer and merge policy (design) | Phase 5, after reliability | Agent team. Its own text says reliability comes first. |
| Roadmap, later | [autopilot#1048](https://github.com/directionally-local/autopilot/issues/1048) | attach-remote --all: drive the camouflage deck from every conversation on a place | Phase 2 | The deck's data feed. |
| Roadmap, later | [autopilot#1051](https://github.com/directionally-local/autopilot/issues/1051) | Subagents that write: cell-isolated workers returning reviewed patches (design) | Phase 5 | Writing subagents: design. |
| Roadmap, later | [autopilot#1052](https://github.com/directionally-local/autopilot/issues/1052) | subagent edit mode: worker profile and patch artifact from the cell | Phase 5 | Writing subagents, part 1. |
| Roadmap, later | [autopilot#1053](https://github.com/directionally-local/autopilot/issues/1053) | subagent edit mode: coordinator apply, review and conflict handling | Phase 5 | Writing subagents, part 2. |
| Roadmap, later | [autopilot#1054](https://github.com/directionally-local/autopilot/issues/1054) | subagent edit mode: TUI, SDK and dl server surfaces | Phase 5 | Writing subagents, part 3. |
| Roadmap, later | [autopilot#1055](https://github.com/directionally-local/autopilot/issues/1055) | subagent edit mode: acceptance scenarios | Phase 5 | Writing subagents: acceptance. |
| Roadmap, later | [camouflage#146](https://github.com/sinameraji/camouflage/issues/146) | protocol: per-session status and multi-session streams | Phase 2 | Deck protocol; first deck task. |
| Roadmap, later | [camouflage#147](https://github.com/sinameraji/camouflage/issues/147) | notifications when an unfocused session needs you | Phase 2 | Deck notifications. |
| Roadmap, later | [camouflage#149](https://github.com/sinameraji/camouflage/issues/149) | deck mode: several sessions in one full-screen view with a sidebar | Phase 2 | Deck layout. |
| Roadmap, later | [camouflage#150](https://github.com/sinameraji/camouflage/issues/150) | deck input: composer, approvals and keys routed to the focused session; goto picker | Phase 2 | Deck input routing. |
| Roadmap, later | [installer#48](https://github.com/directionally-local/installer/issues/48) | The deck: one terminal for every agent (roadmap) | Phase 2 umbrella | Updated: the deck opens with `dl deck`, not bare `dl`. |
| Roadmap, later | [installer#49](https://github.com/directionally-local/installer/issues/49) | dl sessions: every conversation, with its state | Phase 1, small | Still useful to see sessions across places; Autopilot's /resume covers one place. |
| Roadmap, later | [installer#51](https://github.com/directionally-local/installer/issues/51) | dl agent list\|prompt\|read\|wait: script your agents | Phase 5 | Scripting surface for agents; the agent team builds on it. |
| Roadmap, later | [installer#54](https://github.com/directionally-local/installer/issues/54) | dl deck: open the deck across every place | Phase 2 | Retitled to `dl deck`; bare `dl` now opens a new session. |
| Roadmap, later | [serverless-objects#137](https://github.com/directionally-local/serverless-objects/issues/137) | dl supervisor as a durable app: alarms, budgets, restart-safe | Phase 5 | Supervisor as a durable app; the supervisor job works for now. |
| Roadmap, later | [aster-ios#6](https://github.com/sinameraji/aster-ios/issues/6) | Design and ship cross-chat memory for Autopilot sandboxes | Phase 3 / harness | Cross-chat memory in sandboxes; tie to the memory rollout. |
| Supporting | [autopilot#1042](https://github.com/directionally-local/autopilot/issues/1042) | Windows: verify the TUI on a real console (cmd, PowerShell, Windows Terminal) | Platform | Windows TUI check. dl itself doesn't support Windows. |
| Supporting | [autopilot#1073](https://github.com/directionally-local/autopilot/issues/1073) | [memory] Move extraction to compaction/session-end and add a memoryExtraction policy | Harness quality | Memory cost and noise. |
| Supporting | [autopilot#1074](https://github.com/directionally-local/autopilot/issues/1074) | [memory] Content-addressed dedup and lifecycle rules | Harness quality | Memory dedup. |
| Supporting | [autopilot#1075](https://github.com/directionally-local/autopilot/issues/1075) | [memory] Improve recall with query analysis, raw-message FTS, and query-time HyDE | Harness quality | Memory recall. |
| Supporting | [autopilot#1076](https://github.com/directionally-local/autopilot/issues/1076) | [memory] Add a memory eval harness and baseline metrics | Harness quality | Memory evals. |
| Supporting | [autopilot#1077](https://github.com/directionally-local/autopilot/issues/1077) | [memory] Default-on rollout, first-run disclosure, and memory management UX | Harness quality | Product call: memory is a headline feature that nobody has on. |
| Supporting | [autopilot#1078](https://github.com/directionally-local/autopilot/issues/1078) | [memory] Migrate repo_path rows orphaned by the kimiflare → autopilot rename | Rename cleanup | Small migration left from the kimiflare rename. |
| Supporting | [autopilot#911](https://github.com/directionally-local/autopilot/issues/911) | Rename the remaining kimiflare references to autopilot | Rename cleanup | Folders done in 3.1.0. Env names, types and docs remain. |
| Supporting | [autopilot#951](https://github.com/directionally-local/autopilot/issues/951) | refactor: extract a host-agnostic turn engine from loop.ts and app.tsx | Harness health | Turn-engine refactor; makes remote sessions easier to bring to parity. |
| Supporting | [autopilot#999](https://github.com/directionally-local/autopilot/issues/999) | models: per-model behavior profiles so the harness matches each model's needs | Harness quality | High value: dl lets people pick any model, so cheap models need tuning. Not a milestone. |
| Supporting | [camouflage#131](https://github.com/sinameraji/camouflage/issues/131) | SDK lifecycle API: turn/stream/tool handles that auto-settle | Renderer health | SDK API that would shrink Autopilot's renderer glue. |
| Supporting | [camouflage#133](https://github.com/sinameraji/camouflage/issues/133) | Use recorded real host sessions as the primary regression suite, plus fuzzing | Renderer health | Use recorded sessions as tests. |
| Supporting | [camouflage#134](https://github.com/sinameraji/camouflage/issues/134) | Freeze and remove the full-screen TUI; rebuild replay on the inline renderer | Renderer health | Delete the old full-screen renderer. |
| Supporting | [installer#70](https://github.com/directionally-local/installer/issues/70) | A dependency floor is below the latest release | Housekeeping | Opened by the daily bot; closes when Dependabot bumps the pin to 3.1.2. |
| Platform track | [autopilot#1003](https://github.com/directionally-local/autopilot/issues/1003) | Run the dl server's runs on Serverless Objects run objects (after SO milestone M3) | Serverless Objects track | Runs on Serverless Objects. Only after its beta. |
| Platform track | [serverless-objects#114](https://github.com/directionally-local/serverless-objects/issues/114) | Run the 14-day fault-injection soak before beta | SO beta (M3) | 14-day soak. |
| Platform track | [serverless-objects#115](https://github.com/directionally-local/serverless-objects/issues/115) | Repeat conformance on Linux before making platform claims | SO beta (M3) | Linux conformance. |
| Platform track | [serverless-objects#130](https://github.com/directionally-local/serverless-objects/issues/130) | Conformance: PartyServer | SO beta (M3) | PartyServer. |
| Platform track | [serverless-objects#132](https://github.com/directionally-local/serverless-objects/issues/132) | Conformance: Containers on Linux, S3Mount, DirectoryBackup, sleep and restart | SO beta (M3) | Containers. |
| Platform track | [serverless-objects#133](https://github.com/directionally-local/serverless-objects/issues/133) | Exercise callable RPC and the Agents SDK through sobjects deploy/up | SO beta (M3) | RPC and Agents SDK. |
| Park | [serverless-objects#116](https://github.com/directionally-local/serverless-objects/issues/116) | Native engine: support KV, D1, R2, Queues, Workflows, service bindings and assets | SO M4 | Native engine bindings. Not needed by dl phases 0 to 2. |
| Park | [serverless-objects#117](https://github.com/directionally-local/serverless-objects/issues/117) | Forward calls to another node without --peer-listen | SO M4 | Multi-node. |
| Park | [serverless-objects#118](https://github.com/directionally-local/serverless-objects/issues/118) | TLS between nodes | SO M4 | Multi-node TLS. |
| Park | [serverless-objects#119](https://github.com/directionally-local/serverless-objects/issues/119) | Combine --node-name with --threads | SO M4 | Multi-node threads. |
| Park | [serverless-objects#120](https://github.com/directionally-local/serverless-objects/issues/120) | Cross-node compaction | SO M4 | Multi-node compaction. |
| Park | [serverless-objects#121](https://github.com/directionally-local/serverless-objects/issues/121) | Multi-node soak: three nodes with node-level faults | SO M4 | Multi-node soak. |
| Park | [serverless-objects#122](https://github.com/directionally-local/serverless-objects/issues/122) | Support [admin] with [native] in sobjects.toml | SO M4 | Admin on native engine. |
| Park | [serverless-objects#123](https://github.com/directionally-local/serverless-objects/issues/123) | Dashboard and admin API: show nodes, leases and object ownership | SO M4 | Dashboard. |
| Park | [serverless-objects#124](https://github.com/directionally-local/serverless-objects/issues/124) | Multi-tenancy: multiple apps and tenants per node | SO M4 | Multi-tenancy. |
| Park | [serverless-objects#125](https://github.com/directionally-local/serverless-objects/issues/125) | SSO | SO M4 | SSO. The website's Teams tier promises it. |
| Park | [serverless-objects#126](https://github.com/directionally-local/serverless-objects/issues/126) | Audit logs | SO M4 | Audit logs. The website's Teams tier promises it. |
| Park | [serverless-objects#127](https://github.com/directionally-local/serverless-objects/issues/127) | Air-gapped install | SO M4 | Air-gapped install. |
| Park | [serverless-objects#128](https://github.com/directionally-local/serverless-objects/issues/128) | Helm chart | SO M4 | Helm chart. |
| Park | [serverless-objects#134](https://github.com/directionally-local/serverless-objects/issues/134) | Conformance: sockets across a cell move between nodes | SO M4 | Sockets across nodes. |
| Off roadmap | [autopilot#1069](https://github.com/directionally-local/autopilot/issues/1069) | Browser extension bridge: let autopilot drive the user's real browser tab | Not on the roadmap | Browser extension bridge. A nice idea with no phase that needs it. |
| Off roadmap | [autopilot#1089](https://github.com/directionally-local/autopilot/issues/1089) | Provider preset proposal: Demon Route (OpenAI-compatible, open-weight + abliterated models) | Not on the roadmap | Outside proposal for a provider of uncensored models. Decide a policy for community presets before accepting. |
| Off roadmap | [autopilot#952](https://github.com/directionally-local/autopilot/issues/952) | marketing: use session traces and eval results to show which model wins on real code | Marketing | Model comparison from traces. Useful once dl has users. |
| Off roadmap | [hotcell#65](https://github.com/directionally-local/hotcell/issues/65) | benchmarks.md: sandbox-dax comparison is out of date with the live leaderboard | Docs | Benchmark page out of date. |
| Closed today | [installer#50](https://github.com/directionally-local/installer/issues/50) | dl attach [ID]: jump into any conversation | Closed | Superseded by installer#71 and autopilot#1092. |
