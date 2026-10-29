# Preview deploys: run an agent's Workers PR on your own server

Status: Phase 1's `dl preview` and `dl previews` are built (`src/preview.ts`, `src/laptop/preview.ts`).
Still to come: the optional Serverless Objects component in `dl setup`, and the Autopilot run step.

Part of [directionally-local/installer#28](https://github.com/directionally-local/installer/issues/28).

## 1. Summary

When an agent's pull request changes a Cloudflare Workers project, deploy that branch on
the user's own server with [Serverless Objects](https://github.com/directionally-local/serverless-objects)
and post a link to the running preview on the pull request. "You get a PR back" becomes
"you get a PR back that you can open and try".

Serverless Objects is pre-alpha. It stays off the critical path: if a preview fails, the
task and its PR still succeed, and the failure is reported where the user looks for it
(`dl previews`, `dl status`), not as a failed run.

## 2. Decisions

The issue left four questions open. These are the answers this design commits to.

### 2.1 The post-run hook lives in Autopilot, not `dl`

`dl` is a short-lived CLI: it sends a task and detaches. Only Autopilot knows when a run
finishes, which branch it pushed, and which PR it opened. So the automatic half is an
Autopilot run step, enabled by a server setting that `dl setup` and `dl up` write into
`/etc/autopilot/autopilot.env`:

```sh
DL_PREVIEWS=1
DL_PREVIEWS_BUCKET=s3://directionally-local-previews
```

`dl` owns everything else: installing Serverless Objects, the preview registry, the
`dl preview` command, and the tunnel that reaches a preview.

Because the hook depends on an Autopilot release that doesn't exist yet, **Phase 1 ships
the manual command first**. `dl preview <id>` does exactly what the hook will do, so the
hook is a thin caller rather than a second implementation.

### 2.2 The engine is celld

celld is the supported engine and what users deploy. The native engine is the portability
checker (`sobjects build --strict`), not a deployment target, so a preview running on it
would not tell the user anything true about their app.

### 2.3 Each preview is its own node, with its own bucket prefix

One `sobjects` node per preview, on its own loopback port, with its own `sobjects.toml`:

```toml
[celld]
bucket = "s3://directionally-local-previews/pr-12"
listen = "127.0.0.1:8091"
```

Separate nodes mean a preview that crashes, leaks memory, or is redeployed cannot affect
another preview or the main install. The bucket prefix keeps their Durable Object state
apart while sharing one bucket, so `sobjects down` for one preview never touches another.

### 2.4 Budget: 256 MB and 0.25 CPU per preview, at most 3

A preview is a celld process plus a small bundle. The budget is 256 MB and 0.25 CPU each,
capped at 3 concurrent previews. When previews are enabled, the "fits ~N agents" estimate
reserves `3 × 256 MB` before dividing by the 1 GB per sandbox, so the number the user sees
is still true.

### 2.5 Git access reuses the server's existing GitHub token

The preview checkout is a read-only clone as the `autopilot` user, using the token already
in `/etc/autopilot/github.env`. No new credential, no new proxy, and nothing is pushed from
a preview.

### 2.6 `dl preview` takes a task id

`dl preview <id>` matches `dl watch`, `dl cancel` and `dl pull`. The PR number is shown
next to it, not used as the key, because several tasks can share a PR and a task can exist
before its PR does.

## 3. What counts as a Workers project

A branch is previewable when its root has `wrangler.json`, `wrangler.jsonc` or
`wrangler.toml`. Root only: a monorepo with several Wrangler projects is out of scope for
Phase 1, and the run is reported as "not previewable" rather than guessed at.

The check runs on the checkout, not on the PR's file list, so it is one `exists` call and
works the same for the hook and for `dl preview`.

## 4. The command

### 4.1 On the server

```sh
dl preview <id>            # deploy the run's branch and print the local URL
dl preview <id> --remove   # stop it and delete its state
dl previews                # live previews: task, PR, port, age
```

`dl preview <id>`:

1. Reads the run from `autopilot aster runs --json` (repository, branch, PR URL).
2. Clones or fetches the branch into `/var/lib/directionallylocal/previews/<id>` as the
   `autopilot` user.
3. Refuses with a clear message when the root has no Wrangler config.
4. Writes `sobjects.toml` with the preview's bucket prefix and a free loopback port.
5. Runs `sobjects deploy .` then `sobjects up --detach` with
   `SOBJECTS_STATE_DIR=/var/lib/directionallylocal/previews/<id>/state`.
6. Waits for the port to answer, then records the preview in
   `/var/lib/directionallylocal/previews.json` (task id, PR, port, branch, created at).
7. Prints `http://127.0.0.1:<port>` and how to open it from a laptop.

Re-running `dl preview <id>` fetches, redeploys and restarts the same node, so the URL and
port stay stable.

### 4.2 On the laptop

```sh
dl preview <id>            # tunnel to the preview and open it in the browser
```

The laptop asks the server for the preview's port (a small addition to the existing
`/api/v1` surface, or `dl preview --json` over SSH), opens a tunnel with the existing
`tunnelArgs` helper, and opens the browser. `dl status` gains a `Previews` row when any are
live.

### 4.3 The hook

When a run finishes and its PR touches a Wrangler project, Autopilot calls the same code
path as `dl preview <id>`, then comments the URL on the PR. On a later push to the same
branch it redeploys; when the PR closes it removes the preview. A failure is a comment on
the PR and a line in `dl previews`, never a failed run.

## 5. Reaching a preview

| Phase | How |
| --- | --- |
| 1 | `dl preview <id>` over the existing SSH tunnel, opening `http://127.0.0.1:<port>` |
| 1b | `pr-<n>.<name>.directionallylocal.run`, using the name service's Phase 1 TLS certificates |

Phase 1 needs no DNS, no certificate and no public port, which is why it comes first.

## 6. State

Previews have no state that matters. The bucket prefix holds whatever the app's Durable
Objects wrote, and deleting the prefix on `--remove` is enough. A self-hosted node with no
S3 bucket can use the SeaweedFS from `deploy/compose`, or the native engine with no bucket
at all, at the cost of previews not surviving a restart.

## 7. Phasing

| Phase | Work |
| --- | --- |
| 1 | `dl setup` offers Serverless Objects as an optional component (release, loopback-only node, `0600` deploy wrapper); `dl preview <id>` on the server; `dl preview <id>` on the laptop over the tunnel; `dl previews`; a `Previews` row in `dl status` |
| 1b | The Autopilot run step: deploy on finish, comment the URL, redeploy on push, remove on close |
| 2 | `pr-<n>.<name>.directionallylocal.run` through the name service, with TLS |

## 8. Out of scope

- Monorepos with several Wrangler projects.
- Previews for non-Workers repositories.
- Per-preview CPU and memory limits beyond the fixed budget in §2.4.
- A public preview URL before the name service can issue certificates.
- Keeping a preview alive after its PR closes.

## 9. Risks

- **Serverless Objects is pre-alpha.** Its CLI and `sobjects.toml` keys can change. Pin the
  release in `dl up` the way the portability job pins `serverless-objects@0.13.4`, and
  treat a preview failure as expected rather than exceptional.
- **celld platform support.** macOS arm64 and Linux arm64/x64 only. On an unsupported
  server, `dl setup` should not offer the component at all.
- **Bucket requirements.** celld needs conditional writes; R2 and SeaweedFS are tested.
  `dl setup` should verify the bucket before enabling previews.
- **Disk.** Each preview is a full checkout. Cap the number of previews and remove the
  checkout on `--remove`.
- **Port exhaustion.** Allocate from a fixed range (8090–8099) and refuse beyond the
  concurrency cap rather than drifting into other services' ports.

## 10. Acceptance

- [ ] `dl setup` installs Serverless Objects only when asked, and only on a supported host.
- [ ] `dl preview <id>` deploys a Wrangler branch and prints a URL that answers.
- [ ] `dl preview <id>` on a laptop opens that URL through the tunnel.
- [ ] A branch without a Wrangler config is refused with a clear message.
- [ ] `dl previews` and `dl status` list live previews.
- [ ] A failed preview never fails the task or its PR.
- [ ] The capacity estimate accounts for the preview budget.
