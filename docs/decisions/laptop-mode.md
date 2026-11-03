# Decision: what `dl` runs on a laptop

**Status:** decided, 2 November 2026. Resolves [installer#72](https://github.com/directionally-local/installer/issues/72).

## The decision

**On a laptop, `dl` runs plain Autopilot. On a server, `dl` keeps the sandboxed remote mode.**

- **Bare `dl` and `dl -c` on a laptop** start `autopilot` in the terminal, in the folder you ran it from. Every Autopilot feature works: `/resume`, `/clear`, `!` shell commands, MCP servers, and your own messages in a reopened session. The agent edits the folder directly, and the run ends when the terminal closes. `dl -c` is `autopilot -c`.
- **`dl run "task"` stays the background, sandboxed path.** It sends the task to a place — this computer's own Autopilot server, or a server — where it runs in a Hotcell sandbox and ends in a pull request. That is the mode that keeps going after the terminal closes.
- **On a server, `dl` keeps `autopilot attach-remote`.** Running after the laptop closes is the whole point there, and the sandbox is the boundary that makes unattended work safe.

This is option 1 for laptops and option 2 for servers from the issue, not option 3: nothing is chosen at setup, because the machine already answers the question.

## Why

**Memory.** Testers run eight agents on 8 GB laptops. A Docker sandbox per session does not fit: `dl` caps each sandbox at 1 GB and estimates "fits ~N agents" by dividing what's left after the host's share. Eight interactive sessions on a laptop have to be eight plain Autopilot processes, not eight containers.

**Never cripple Autopilot.** The remote screen is a remote control, not Autopilot: only `/help`, `/model`, `/status`, `/pr` and `/exit` work. `/resume`, `/clear`, `!`, MCP and your own messages in history do not. On the machine where the person is sitting, that is a worse product than the `autopilot` they already have.

**The sandbox is for unattended work.** A Hotcell sandbox earns its cost when nobody is watching: it holds no real keys, it can be thrown away, and it ends in a pull request. An interactive session on your own laptop is attended, and the agent is meant to edit the folder you are looking at.

**Servers are the opposite case.** There, the session outliving the terminal is the feature, and the sandbox is what makes it safe to leave running. The parity work in Autopilot's remote screen (`/resume`, `/clear`, your own messages) is still needed — for servers.

## What this changes

**On a laptop, opening a session no longer needs a place.** No SSH tunnel, no credential, no session store, no `attach-remote` probe. `dl` finds the Autopilot it bundles, hands it the local install's provider and model, and gets out of the way. The "1 earlier session here is still working" line and `dl -c`'s conversation lookup become Autopilot's own `/resume` and `-c`.

**`dl run` is unchanged.** It still resolves a place, opens the tunnel, sends the working tree, and reports the pull request. `dl runs`, `dl watch`, `dl cancel`, `dl pull` and `dl preview` are unchanged with it.

**`dl setup` on a laptop still installs Hotcell, Autopilot and the local server,** because `dl run` uses them. What it stops doing is standing between you and an interactive session.

**`dl status` on a laptop still shows the place,** because that is where `dl run` sends work.

**The multiplexer (phase 2) loses its view of laptop sessions.** Plain Autopilot sessions are not conversations on a place, so the deck cannot list them. Either plain Autopilot publishes its events on a local socket the deck reads, or terminal panes come earlier than planned. That is a phase-2 question, recorded in the roadmap, not a reason to keep laptops in remote mode.

## Follow-ups this decision creates

1. **Bare `dl` and `dl -c` spawn plain Autopilot on a laptop** — the code change, in its own pull request. It replaces the `attach-remote` path in `src/laptop/session.ts` for the local case and leaves the remote path for servers.
2. **Does a laptop still need Docker at setup?** No. Bare `dl` with nothing set up runs plain Autopilot, with no setup at all; the sandbox stack (Docker, Hotcell, the image, the GitHub token) is set up the first time `dl run` is used, which asks whether tasks run on your own server or on this computer, or with `dl setup`.
3. **Autopilot's remote screen still needs parity** (`/resume`, `/clear`, your own messages) — for servers. [autopilot#1092](https://github.com/directionally-local/autopilot/issues/1092), [autopilot#1093](https://github.com/directionally-local/autopilot/issues/1093) stay on the roadmap, no longer on the phase-0 critical path for laptops.
4. **Help text and README** describe the old behaviour until follow-up 1 lands; they change with it, not before.
