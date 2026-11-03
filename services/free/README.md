# Free managed tier service

A portable Worker with Durable Objects (SQLite) that gives signed-in people a weekly allowance of
`deepseek/deepseek-v4.1-flash-1017` through OpenRouter. Sign-in is GitHub by device code. The
contract is in `src/app.ts`, and the refusal sentences are in `src/messages.ts`.

## Admission

There is one account per GitHub user, keyed on the numeric GitHub id.

- **Invite-only (the default, `OPEN_ADMISSION=false`).** Everyone except admins needs an unused
  invite code.
- **Open admission (`OPEN_ADMISSION=true`, or the admin override).** GitHub accounts at least
  `MIN_GITHUB_ACCOUNT_AGE_DAYS` (30) old get in without a code. Younger accounts still need one.
- In both modes, new people stop at `MAX_ACTIVE_USERS` (admins aren't counted). A device that
  already holds another account's grant is refused, and each network gets 3 new accounts a day.

## Refusals

Every refusal is `{"error": {"code", "message", ...}}`. The browser page and `error.message`
use the same sentence, so a client that doesn't know a code can show the message as it is.

| code | where | extra |
|---|---|---|
| `account_too_new` | `POST /v1/device/token` | `reason` |
| `invite_required` | `POST /v1/device/token` | `reason` |
| `cohort_full` | `POST /v1/device/token` | `reason` |
| `too_many_signups` | `POST /v1/device/token` | `reason` |
| `access_denied` | `POST /v1/device/token` | `reason: "device_taken"` when the device holds another account's grant |
| `service_paused` | device code, device token, chat | `reason: "paused"`, `pausedForEveryone: true`, `resetsAt: null` |
| `global_weekly_budget_reached` | chat (503) | `reason: "weekly_budget"`, `pausedForEveryone: true`, `resetsAt` (ISO time), `Retry-After` header |
| `global_total_budget_reached` | chat (503) | `reason: "total_budget"`, `pausedForEveryone: true`, `resetsAt: null` |
| `quota_exceeded` | chat (402) | `reason: "tokens" \| "spend"`, `resetsAt` |
| `not_invited` | API, and older sign-ins | none |

The two global budget codes mean "free tokens are paused for everyone, and your own key still
works". The weekly one says when free tokens come back. The total one has no reset time: free
tokens come back only if the owner raises the cap.

## Runtime settings

These settings come from `env`. An admin can override them while the service runs, with no
release. Overrides live in the Directory object, and every change, pauses included, is logged
with who made it and when.

| setting | env | default |
|---|---|---|
| `weeklyTokens` | `WEEKLY_TOKENS` | 50,000,000 |
| `perPersonWeeklyUsdCap` | `PER_PERSON_WEEKLY_USD_CAP` | 5 |
| `globalWeeklyUsdCap` | `GLOBAL_WEEKLY_USD_CAP` | 250 |
| `globalTotalUsdCap` | `GLOBAL_TOTAL_USD_CAP` | 1000 |
| `maxActiveUsers` | `MAX_ACTIVE_USERS` | 50 |
| `openAdmission` | `OPEN_ADMISSION` | false |

```sh
# Read the effective values, the env values, the overrides and the change log
curl -H "authorization: Bearer $ADMIN_TOKEN" https://free.example.com/admin/config

# Set values. null goes back to the env value; USD caps also take "none" (no cap).
curl -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"weeklyTokens": 60000000, "globalWeeklyUsdCap": 300, "openAdmission": null}' \
  https://free.example.com/admin/config
```

A per-person grant (`POST /admin/people/:id/grant`) still wins over the weekly defaults. The kill
switch is `POST /admin/pause` and `/admin/unpause`; `PAUSED=true` in env pauses as well.
