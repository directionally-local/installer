# Design note: a sessionpipe receiver in dl

**Status:** proposal, 19 November 2026. No code. Recommendation: **no-go for now**, with the triggers for "go" below.

[sessionpipe](https://github.com/spacesheep-dev/sessionpipe) (Apache-2.0, spec CC BY 4.0) turns coding-agent hooks into a uniform event stream, filters it to a privacy tier per destination, and delivers it to receivers over HTTP, to a file, or to stdout. It has adapters for Claude Code, Codex, Gemini CLI, Antigravity, Devin and, since 18 November, Autopilot (spacesheep-dev/sessionpipe#281, using the hook events from autopilot#1272 in Autopilot 3.27.0). We have two spec issues open: #279 (allow `_` in `session.id`) and #280 (a "pull request opened" event).

This note was written against sessionpipe at commit `03597e9` (18 Nov): `spec/`, `packages/receiver`, `packages/conformance` and `conformance/`.

## 1. Goal

1. Show sessions from any agent that speaks sessionpipe (Claude Code, Codex, Autopilot and the rest) on a dl server and in `dl deck`, next to the dl server's own Autopilot sessions.
2. Later, maybe, feed the planned opt-in traffic capture that is replayed against the candidate during `dl model update`.

Non-goals: the control lane (answering prompts, starting sessions from the receiver) and the native lane.

## 2. What exists upstream today

- **The spec is Draft.** It becomes Stable when two independent receivers pass the conformance suite. Today the count is zero; the maintainer's own service is the first candidate.
- **The reference receiver is a stub.** `sessionpipe-receiver` 0.17.0 prints "this command lands in a later milestone". It is milestone M3, not started.
- **The conformance runner cannot test a live receiver yet.** Pointed at a URL it prints "receiver scenarios land in M3". The scenarios exist as fixtures (`conformance/delivery/`, 33 files), so a receiver can be tested against them with its own harness.
- **The spec moves fast.** 74 commits touched `spec/` in the last 30 days, most of them in the control lane.
- **Local readers are supported.** The sender's outbox (`spec/OUTBOX.md`) is a documented interface: per-session JSONL files, already filtered and redacted, that a process on the same machine may read.

## 3. Options

| Option | For | Against |
| --- | --- | --- |
| **(a) Inside the dl server process** | One process; the deck already reads it. | The dl server is Autopilot's session server and also runs on laptops. A public HTTP ingest for other agents' data does not belong there, and it would track a draft spec inside Autopilot's release cycle. |
| **(b) A small separate service dl installs** | Own process, own port, own storage, own failure domain. Can be off by default. Easy to remove. Fits "dl is only the installer". | One more thing to install, update and secure on a server. |
| **(c) Reuse sessionpipe's reference receiver** | Least code; upstream keeps it conformant. | It does not exist yet. |
| **(d) Don't build: use the sinks they have** | Zero cost now. On a laptop, the file sink or the outbox already gives the deck a local feed, which answers the open laptop-mode question (plain Autopilot sessions the deck cannot see). | Nothing on a server; no tier cap or retention enforced by us. |

**Recommendation:** do **(d) now** (the deck's laptop source reads the local outbox when phase 2 starts). When the triggers in §7 fire, build **(b)**, and make it a thin wrapper around **(c)** if the reference receiver has shipped and passes conformance by then. Never (a).

## 4. What conformance requires, and what is hard

For events only (no `control`, no `native` capability), a receiver must:

- Serve `GET /.well-known/sessionpipe` with `protocol`, `max_tier`, `capabilities` (`events`, plus `forget` and `backfill`), `auth: ["bearer"]`, endpoints and batch limits.
- Accept `POST` batches and answer 202 with `accepted + duplicates + rejected` equal to the batch size; 400 for a bad protocol, 401 for a bad token, 403 for an event above `max_tier`, 413 for an oversized batch, 429 with `retry-after`.
- Pass the event scenarios: accept, dedup, oversize, tier, protocol, auth, unknown type, forget, seq gap.

What is hard:

- **Auth.** Bearer only. HTTPS is required off localhost. dl would mint one token per sending machine, show it once, and serve the receiver only on localhost, an SSH tunnel or Tailscale HTTPS (as `dl ui share` does), never on a public interface.
- **Ordering.** Arrival order is not guaranteed; `seq` per (harness, session) is the order, and gaps are normal (tiers and thinned tool events). The session block merges with COALESCE rules and title-source precedence. Four harnesses never send a session end, and a turn may have no `turn.ended`, so "done" is the receiver's own reading from silence.
- **Retries.** Senders retry forever with backoff. Dedup on (`harness.name`, `session.id`, `session.seq`) must survive restarts, so it has to be on disk.
- **Tiers.** `max_tier` is a hard cap: 403 above it, never keep it quietly.
- **The secrets filter must not be bypassed.** `secrets@1` runs at the sender, above tier 0. The receiver should also reject any event above tier 0 whose `privacy.rulesets` lacks `secrets@1`, re-run `secrets@1` itself (the spec says any copy must import the reference code or pass its vectors), never enable the native lane (it is unredacted), and never log event bodies.
- **Storage.** Unknown event types and extra `data` keys must be stored and kept. Store one append-only JSONL file per session (the protocol's own storage unit) with arrival time beside sender time, plus a small index for the deck.
- **Retention.** `session.forgotten` must delete everything for that session, including derived data, before the 202. Retention must be documented: 30 days for tier 0 by default (the sender's own outbox window), 7 days for any content tier.

## 5. Privacy

- **Default tier 0** (`max_tier: 0`). It carries states and timing: started, turn running, needs you (kind only), turn ended, ended. No prompts, no assistant text, no tool names, no file paths.
- **Tier 0 is not empty.** It still carries `cwd`, `repo`, `branch`, `model` and `title`, and a title may be the first prompt cut to 80 characters. Autopilot's session id holds a slug of the first prompt. That is why storage stays local.
- **Tier 1 per workspace, opt-in.** Only if the deck's "current tool" column is wanted. Tool counts from a thinned sink must never be shown as the number of tool calls.
- **Content tiers (2 and 3) only for eval replay**, only by explicit opt-in per workspace, with a visible on/off, a shorter retention, and a single command that deletes it.
- **Local only.** Events stay on the machine that runs the receiver. They are never sent to the free tier service, never mixed with its usage counts, never used for telemetry, and never copied off the server by dl.

## 6. How it feeds later work

- **`dl deck` (phase 2).** Tier 0 gives the sidebar what it needs for non-Autopilot sessions: state (working, needs you, done), age, model, repository, branch, title and a link to open the session. It does not give cost (sessionpipe has no cost event) or the pull request (#280). Autopilot sessions on the dl server keep using the dl server's own exact events; sessionpipe fills in the other agents and plain Autopilot on a laptop. A session reported both ways must be shown once.
- **Eval replay.** Tier 2 gives each turn's prompt and the assistant's final text, redacted and capped at 20,000 characters a side. Tier 3 adds tool input and output. Neither is the model request itself (system prompt, tool definitions, the full message history), which is what a faithful replay against a candidate model needs. So sessionpipe is at best a source of coarse, turn-level test cases. The direct source is capture at the model endpoint dl already runs. Either way it is content from a team's real work, and it must be opt-in per workspace: one repository's prompts can name clients, colleagues and code that another repository's owner never agreed to share.

## 7. Effort, risks, recommendation

**Effort** (events only, built on `sessionpipe-core` for the filter and secrets ruleset): about 4 to 5 days for the service, its install and update in dl, a conformance harness over the delivery fixtures, forget and retention. About 2 to 3 more days to show it in the deck once the deck exists. Eval replay from sessionpipe is a separate, larger piece and is not estimated here. Control is out of scope; it is far larger (passkey enrollment, signed commands).

**Risks**

- The spec is Draft and changes weekly. Most churn is in the control lane, but event fields still move.
- No live-receiver runner yet, so "conformance-passing" means passing our own run of their fixtures until M3 lands.
- The reference receiver may land with a different storage model, and a home-grown one would then be duplicate work.
- A receiver is a new network listener holding personal data on the server.
- Our own open items (#279, #280) touch what the deck would show.

**Recommendation: no-go now.** Phase 2 has not started, nothing in dl consumes the data yet, and building against a stub receiver and a moving draft would cost more than waiting. Do (d): when the deck work starts, read the local outbox for laptop sessions.

**Go when all of these hold:**

1. Phase 2 (`dl deck`) work has started and needs non-Autopilot or laptop sessions on a server.
2. Upstream M3 has landed (reference receiver and live conformance runner), or the HTTP and event parts of the spec have gone four weeks without a breaking change.
3. #279 is settled, so Autopilot session ids map back to the dl server's without a rewrite.

Being the second independent receiver to pass conformance would also help move the spec to Stable, which is good for every adapter, ours included.
