# Free managed tier service

A portable Worker with Durable Objects (SQLite) that gives signed-in people a weekly allowance of
GPT-6 Luna, GPT-6.1 Sol and GPT-6 Astra (OpenAI) and DeepSeek V4.1 Flash 1017 (Luminal). OpenAI is
the default provider; DeepSeek is the automatic fallback for Luna and stays selectable by hand. Each
provider has its own prepaid credit pool, and each model tier its own weekly token pool (see
[Providers, models and pools](#providers-models-and-pools)). Sign-in is GitHub by device code. The
contract is in `src/app.ts`, and the refusal sentences are in `src/messages.ts`.

A sign-in code lasts 15 minutes (`expires_in: 900`), long enough to open the link on a phone
and sign in to GitHub there. The terminal polls every 5 seconds.

## Providers, models and pools

| model id | provider | wire id | weekly pool | USD per Mtok (input / cached / output) |
|---|---|---|---|---|
| `gpt-6-luna` (default) | OpenAI | `gpt-6-luna` | `luna`, 50M | 0.10 / 0.01 / 0.50 |
| `gpt-6.1-sol` | OpenAI | `gpt-6.1-sol` | `sol`, 10M | 2 / 0.10 / 10 |
| `gpt-6-astra` | OpenAI | `gpt-6-astra` | `astra`, 3M | 10 / 1 / 50 |
| `deepseek/deepseek-v4.1-flash-1017` | Luminal | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | `luna`, 50M | 0.035 / 0.006 / 0.315 |

- **One pool per tier.** GPT-6 Luna and DeepSeek share the `luna` pool, so switching between them
  (by hand or by the fallback) doesn’t hand anyone a second allowance. Sol and Astra have their own.
- **Fallback.** Every OpenAI model is served by OpenAI first. On a 429, a 5xx, a network error,
  no response before `OPENAI_FIRST_BYTE_TIMEOUT_SECONDS`, or OpenAI’s credit running out, the same
  request is retried once on DeepSeek/Luminal, and the response carries
  `x-dl-fallback: deepseek/deepseek-v4.1-flash-1017`. The requested model’s pool pays for it, so
  someone who asks for Sol spends Sol’s allowance, not Luna’s. DeepSeek picked by hand goes
  straight to Luminal.
- **Separate credit pools.** OpenAI’s `OPENAI_CREDIT_USD` ($5,000) and Luminal’s
  `LUMINAL_CREDIT_USD` ($2,000) are tracked apart (`/admin/spend` shows both). A provider at or past
  its balance stops serving; its models then fall back to the other provider.
- **Prices.** `prices` is what the person’s weekly dollar allowance is charged; `creditPrices` is
  what the provider’s credit is charged (they differ for DeepSeek, whose Luminal list price is
  higher than what OpenRouter billed us for the same model). OpenAI reports no cost, so its
  requests are priced at list. At the mix the free tier actually sees (95% of input tokens
  cached, output under 1% of all tokens) a person who uses every pool costs about $9.35 a week,
  so the $20 per-person cap leaves room for a much less cache-friendly week.
- **Responses API.** OpenAI’s chat completions API refuses function tools while a GPT-6 model
  reasons, so OpenAI requests go to `https://api.openai.com/v1/responses`. Clients still speak
  Chat Completions: `src/openai-responses.ts` turns `messages` into `input` items (assistant
  `tool_calls` into `function_call`, `tool` messages into `function_call_output`, image parts into
  `input_image`), `tools` and `tool_choice` into their Responses form (`strict` false unless the
  client set it), `reasoning_effort` (or OpenRouter’s `reasoning.effort`) into
  `reasoning.effort`, and the reserved output cap into `max_output_tokens`, with `store: false`.
  `temperature` and `top_p` are dropped: GPT-6 refuses them. The answer comes back as a
  `chat.completion` (tool calls with `finish_reason: "tool_calls"`, an output-capped response
  with `"length"`) or, streamed, as chat chunks ending in a usage chunk and `data: [DONE]`.
  Usage maps `input_tokens`, `output_tokens` (reasoning included), cached and reasoning tokens
  to the chat names, so charging is unchanged. Luminal and OpenRouter stay on Chat Completions.
- Any other model or provider needs the person’s own key (`model_not_allowed`).

## Account levels

Every account is `full`, `basic` or `starter`. The point is to make account farming
unprofitable without turning away real developers.

- **Full**: the account is at least `FULL_MIN_ACCOUNT_AGE_DAYS` (90) days old **and** has
  `FULL_MIN_PUBLIC_REPOS` (3) public repositories **or** `FULL_MIN_CONTRIBUTIONS` (50)
  contributions in the last year (private ones count when the person shows them).
- **Additional account signals**: on top of that public bar, Full also needs a few more
  account signals from the same public GitHub data, read at sign-in with the same token, and
  an account must not come from a batch of accounts created together. These signals can only
  keep an account out of Full: without the public bar no number of them gives Full, because a
  sign-up farm can fake them together (accounts following and contributing to each other). The
  creation-batch check flags an account younger than the public bar's age when many accounts
  already signed up were created around the same day, whether or not it follows or is followed
  by anyone; an established account created on a busy day is never flagged. Their thresholds are
  runtime settings (`humanSignalsNeeded`, `minActiveWeeks`, `minRepoAgeDays`, `minSocial`,
  `minFollowers`, `batchWindowDays`, `batchSize`; see `src/admission.ts` `levelChecks`) whose
  real values live in the admin settings. Nothing a person is shown names them: an account
  that misses them gets the same message as one below the public bar. `GET /admin/people` and
  the dashboard's Starter table show the stored signals and which checks pass.
- **Basic**: below the public bar, but an account at least `basicMinAccountAgeDays` old that the
  creation-batch check didn't flag. Every model (GPT-6 included) on its own allowance:
  `basicWeeklyTokens` tokens and `basicWeeklyUsdCap` dollars a week (Sol and Astra at most their
  own pool sizes). `basicWeeklyTokens` 0 turns the level off: those accounts are then served as
  Starter. Nothing a person is shown says who gets Basic, only what it gets.
- **Starter**: everyone else. Every model on `STARTER_WEEKLY_TOKENS` tokens and
  `starterWeeklyUsdCap` dollars a week, or no free tokens at all when the setting is 0. An
  account the creation-batch check flagged (`people.batch_flag`) gets no free tokens whatever
  the setting, and is told the same as everyone with none (`below_bar`). Starter accounts are
  admitted, never refused at sign-in.
- **Access requests**: anyone below Full can ask for more from inside dl with `/request`
  (`POST /v1/access-request`, below). The admin answers on the Tools tab: Grant sets Full with
  reason `admin` and emails the person; Decline sends nothing.
- **Signals** are read at sign-in with the token sign-in already has (no new scopes): account
  age and public repositories from `/user`, then one GraphQL call for followers, contributions,
  `restrictedContributionsCount` and the additional signals. Only the numbers and when they were read are stored:
  never repository names or contents. If GitHub can't answer, the account gets Full (fail open)
  and the failure is counted.
- **Promotion**: at sign-in, weekly from the public profile (promote only, once per person per
  week: Starter to Basic or Full, Basic to Full), with an invite code, by an access request, or
  by an admin. An admin can also demote or block; their choice stands until they change it.
- **Re-levelling**: each sign-in sets the level from the rules again, so an account that no
  longer qualifies moves down then; the weekly re-check moves a Basic account the creation-batch
  check now flags to Starter (no free tokens). Neither ever touches a level an admin or an
  invite set. Nothing re-levels accounts in bulk: the owner blocks by hand.
- **Re-check below-bar accounts** (Tools tab, or `POST /admin/recheck-below-bar`): looks at
  every active non-admin Starter account from its stored signals (age counted to today), raises
  the ones that qualify to Basic, and stores the batch flag again. Never lowers anyone, never
  touches blocked accounts, admin-set levels or redeemed invites. Answers
  `{checked, raised, flagged, starter}`.
- **Network cap**: at most `NETWORK_SIGNUPS_PER_DAY` (3) new sign-ins per network per day.
  Beyond that the account still gets in, as Starter.
- **Existing users** are re-checked lazily on their next request; nobody is cut off mid-session.
- **Admin**: `GET /admin/people` shows each person's level, signals and network count, and
  takes `?level=starter` and `?shared=1`. `POST /admin/people/:id/level {level}` sets it
  (`full`, `basic` or `starter`).

## Admission

There is one account per GitHub user, keyed on the numeric GitHub id.

- **Invite-only (the default, `OPEN_ADMISSION=false`).** Everyone except admins needs an unused
  invite code.
- **Open admission (`OPEN_ADMISSION=true`, or the admin override).** GitHub accounts at least
  `MIN_GITHUB_ACCOUNT_AGE_DAYS` (30) old get in without a code. Younger accounts still need one.
- **Some real GitHub activity (`requireGithubActivity`, on by default).** A new account also
  needs at least one public repository, or at least one contribution in the last year, to get in
  without a code; one with neither is treated like a too-new account (invite step, refusal code
  `no_github_activity`). The repository count comes from the `/user` response sign-in already
  reads; only when it is 0 does the service make one GraphQL call
  (`viewer.contributionsCollection.contributionCalendar.totalContributions`) with the person's
  own sign-in token, which needs no OAuth scope. Admins and people already admitted are never
  checked. If GitHub errors or takes more than 5 seconds, the person gets in (fail open); each
  lookup's outcome is counted per day (`githubChecks` in `GET /admin/metrics`), and 5 errors in
  a UTC day send one alert.
- **`MAX_ACTIVE_USERS` applies only while invite-only** (admins aren't counted). With open
  admission there is no cap on people: everyone old enough gets an account at once, and the
  [queue](#the-queue-for-free-tokens) keeps free spend inside the weekly budget instead. So
  turning `openAdmission` on is the one switch for open sign-up; the smoke-test cap (20) needs no
  change.
- In both modes, a device that already holds another account's grant is refused, and each
  network gets 3 new accounts a day.
- **Per-IP limits are per network.** Every per-IP rate limit (sign-ups, device codes, polling,
  refresh, invite attempts, the API, referral lookups, telemetry, admin sign-in) keys an IPv6
  address by its /64, since one host can rotate through its whole /64; an IPv4 address (and an
  IPv4-mapped IPv6 address, `::ffff:1.2.3.4`) is its own network. `src/network.ts`.
- **Per-network limits are generous for shared networks** (an office, a classroom, a meetup):
  the API 600 requests a minute, refresh 600 an hour, device codes 60 an hour and their polling
  720 a minute, since each signed-in person is limited too (60 requests a minute). Sign-ups (3 a
  day) and invite attempts (10 an hour) stay tight.

## API contract for the open launch

Autopilot and dl.new build against these shapes. Fields may be added; none are removed.

### `GET /v1/me`

```jsonc
{
  "login": "alice", "githubId": 123, "status": "active",
  "allowance": { "tokensPerWeek": 50000000, "usedThisWeek": 0, "remaining": 50000000,
                 "resetsAt": "2026-11-09T00:00:00.000Z", "usdPerWeek": 60, "spentUsdThisWeek": 0 },
  "pools": {                            // one weekly token pool per model tier
    "luna":  { "tokensPerWeek": 50000000, "usedThisWeek": 0, "remaining": 50000000,
                 "resetsAt": "2026-11-09T00:00:00.000Z",
                 "models": ["gpt-6-luna", "deepseek/deepseek-v4.1-flash-1017"] },
    "sol":   { "tokensPerWeek": 10000000, "usedThisWeek": 0, "remaining": 10000000, "resetsAt": "…", "models": ["gpt-6.1-sol"] },
    "astra": { "tokensPerWeek": 3000000,  "usedThisWeek": 0, "remaining": 3000000,  "resetsAt": "…", "models": ["gpt-6-astra"] }
  },
  "models": ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra", "deepseek/deepseek-v4.1-flash-1017"],
  "plan": "free",                       // "free" | "pro"
  "topupTokensLeft": 0,                 // unexpired top-up tokens not yet used
  "pro": null,                          // or { "periodEnd": ISO string | null, "cancelAtPeriodEnd": false }
  "queue": null,                        // or { "position": 214, "etaAt": "2026-11-16T00:00:00.000Z", "waiting": 300 }
  "referral": { "code": "alice", "link": "https://dl.new/r/alice", "joined": 2, "activeThisWeek": 1,
                "bonusTokensPerWeek": 10000000, "bonusCapPerWeek": 50000000 },
  "offers": { "pro": { "priceUsdMonthly": 10, "tokensPerWeek": 100000000 },
              "topup": { "priceUsd": 3, "tokens": 50000000, "validDays": 30 } }
}
```

- `allowance.tokensPerWeek` includes this week's referral bonus; the dollar allowance grows in the
  same proportion. While queued, `allowance.remaining` is 0.
- With Pro, `allowance` is Pro's: 100M tokens a week (`PRO_TOKENS_PER_WEEK`), no referral bonus,
  and no dollar ceiling unless `PRO_WEEKLY_USD_CAP` is set. `queue` is null for Pro (a place in
  line is kept in case Pro ends).
- `referral.joined`: sign-ups with this person's code that count. `activeThisWeek`: those friends
  whose pair counts toward this week's bonus (see [Referrals](#referrals)).
- `offers` come from config (`PRO_PRICE_USD_MONTHLY`, `PRO_TOKENS_PER_WEEK`, `TOPUP_PRICE_USD`,
  `TOPUP_TOKENS`, `TOPUP_VALID_DAYS`).

### Refusals for free tokens (`POST /v1/chat/completions`, HTTP 402)

Out of tokens (a free user):

```json
{ "error": { "code": "quota_exceeded", "message": "This week's free token allowance is used up. It resets at 2026-11-09T00:00:00.000Z.",
             "reason": "tokens", "resetsAt": "2026-11-09T00:00:00.000Z",
             "offers": { "pro": { "priceUsdMonthly": 10, "tokensPerWeek": 100000000 }, "topup": { "priceUsd": 3, "tokens": 50000000, "validDays": 30 } },
             "referralLink": "https://dl.new/r/alice" } }
```

Queued:

```json
{ "error": { "code": "free_tier_queued",
             "message": "You're #214 in line for free tokens (about 3 days). Each friend who starts using dl moves you up. Your own key works now.",
             "position": 214, "etaAt": "2026-11-09T00:00:00.000Z",
             "offers": { "pro": { "priceUsdMonthly": 10, "tokensPerWeek": 100000000 }, "topup": { "priceUsd": 3, "tokens": 50000000, "validDays": 30 } },
             "referralLink": "https://dl.new/r/alice" } }
```

The wait reads "about N days" under two weeks, else "about N weeks".

A Basic or Starter week used up (a free user): `basic_limit` or `starter_limit`, with what the
level gets, that it resets Monday, and the two ways on. `request` is the access-request endpoint.

```json
{ "error": { "code": "basic_limit",
             "message": "You've used this week's free Basic allowance (10M tokens a week of every model, GPT-6 included, up to $3). It resets on Monday. Need more? Type /request in dl and tell us what you're building, or use your own API key with /provider.",
             "reason": "tokens", "resetsAt": "2026-11-09T00:00:00.000Z", "request": "/v1/access-request",
             "offers": { "...": "as above" }, "referralLink": "https://dl.new/r/alice" } }
```

No free tokens at all (HTTP 403 `below_bar`): `contact` (the email fallback) and `request`.

### Access requests (`/request` in dl; `Authorization: Bearer <access token or server key>`)

`POST /v1/access-request {building, link?}`: `building` is required, 10 to 600 characters after
trimming; `link` is optional, an `http://` or `https://` URL of at most 300 characters. Any
signed-in person who isn't blocked.

| answer | when |
|---|---|
| 201 `{"status": "pending"}` | stored; the owner gets an alert with the login and the pending count only |
| 409 `already_pending` | a request is already waiting |
| 409 `already_full` | Full accounts and admins |
| 429 `rate_limited` | more than 3 submissions in 24 hours |
| 400 `invalid_request` | a clear message about what to fix |
| 403 `blocked` | a blocked account |

`GET /v1/access-request` → `{"status": "none" | "pending" | "granted" | "declined", "at"?: ISO}`
(the newest request; `at` is when it was sent, or answered).

What a person writes is user content: stored as plain text, shown only on the admin Tools tab
(escaped), never logged, never in an alert, a metric or an export. Admins:
`GET /admin/access-requests` (pending, newest first) and
`POST /admin/access-requests/:id/grant` or `/decline` (`{note?}`).

### Sign-up with a referral code

- `POST /v1/device/code {"referral_code": "alice"}`: optional. A code, any case, or the whole link
  (`https://dl.new/r/alice`). Anything that isn't a code is ignored, never an error.
- `GET /device?ref=alice` (also with `user_code`): the browser carries the code through GitHub
  sign-in. A code from the terminal wins over one from the browser.

### `GET /v1/referrals/<code>` (public)

For the dl.new invite page. Rate-limited per IP (60 a minute), `cache-control: public, max-age=300`.

- `200 {"valid": true, "login": "Alice", "bonusTokensPerWeek": 10000000}` when the code belongs to
  an admitted, unsuspended account. `login` is the current GitHub login.
- `404 {"valid": false}` otherwise. Nothing else is returned: no id, usage or dates.

### `GET /v1/status` (public)

Whether a new person gets free tokens right now, so a client can say so before sign-in. No auth,
`access-control-allow-origin: *`, `cache-control: public, max-age=30`; computed at most once per
30 s per isolate; rate-limited per network (120 a minute). It never carries amounts or counts.

```json
{"free": "open", "reason": null, "message": "", "opensAt": null, "updatedAt": "2026-11-04T12:00:00.000Z"}
{"free": "waitlist", "reason": "weekly_budget", "message": "The free tier is at capacity this week: new sign-ups join a waitlist that opens on Monday 9 November.", "opensAt": "2026-11-09T00:00:00.000Z", "updatedAt": "2026-11-04T12:00:00.000Z"}
{"free": "paused", "reason": "credit_exhausted", "message": "The free tier is paused: high demand used up this round of free tokens. Bring your own key, or check back soon.", "opensAt": null, "updatedAt": "2026-11-04T12:00:00.000Z"}
```

The same tests as chat and sign-up, in this order:

- `paused`, `kill_switch`: the env `PAUSED` or the admin's pause.
- `paused`, `no_upstream`: no upstream may serve (`chooseUpstream` finds none).
- `paused`, `credit_exhausted`: Luminal serves and its credit is used up.
- `waitlist`, `weekly_budget`: a new open sign-up would be queued now (`shouldQueue`: free spend at
  `QUEUE_THRESHOLD` of the weekly cap or weekly Luminal credit budget, or anyone already waiting).
  `opensAt` is the next weekly admission, Monday 00:00 UTC.
- `open` otherwise.

`message` is one sentence for display; the two other pauses read "The free tier is paused for now.
Bring your own key, or check back soon." Invite-only admission (`OPEN_ADMISSION` off) isn't
reflected: it says whether free tokens flow, not whether sign-up needs a code.

### Billing (`Authorization: Bearer <access token>`; a server key is refused)

| request | response |
|---|---|
| `POST /v1/billing/checkout {"product": "pro"}` | `{"url": "https://checkout.stripe.com/…"}`: a subscription Checkout |
| `POST /v1/billing/checkout {"product": "topup"}` | `{"url": …}`: a one-time payment Checkout |
| `POST /v1/billing/portal` | `{"url": "https://billing.stripe.com/…"}`: the Customer Portal (cancel Pro, change card) |

Refusals: 400 `invalid_request` (unknown product), 403 `not_invited` / `suspended`, 409
`already_pro`, 404 `no_billing_account` (portal before any purchase), 502 `billing_error`
(Stripe refused), 503 `billing_unavailable` (Stripe isn't configured). Checkout returns to
`https://dl.new/billing/success` or `/billing/cancel` (`BILLING_SUCCESS_URL`,
`BILLING_CANCEL_URL`); the portal returns to `https://dl.new/billing` (`BILLING_PORTAL_RETURN_URL`).

### Feedback (`POST /v1/feedback`; sign-in optional)

Sends one email to the owner (the `ALERT_EMAIL` binding, from `ALERT_EMAIL_FROM` to
`ALERT_EMAIL_TO`). **Feedback isn't stored**: the message and the reply address go into that
email and nowhere else (no rows, no logs). The only state it leaves is the rate-limit buckets:
the person's GitHub id, and a salted hash of the network, with a token count.

```
POST /v1/feedback
{"message": "…",                       // required, 1–5,000 characters, sent verbatim
 "email": "me@example.com",            // optional reply address
 "client": {"dl": "0.11.0", "autopilot": "3.5.0", "os": "macos", "arch": "arm64", "provider": "free"}}
→ 200 {"ok": true, "replyTo": "me@example.com"}     // or "replyTo": null: no reply possible by email
```

- **Sign-in.** Without `Authorization` it's anonymous ("not signed in"). With a free tier
  access token (or a server key) the email names the GitHub login, id and profile link. A bearer
  that is sent but invalid or expired is `401 invalid_token`, not sent anonymously: refresh and
  retry.
- **Reply address.** The `email` given wins. Otherwise, signed in, the public email on the
  person's GitHub profile (`GET https://api.github.com/users/<login>`, unauthenticated, 3 s
  timeout, cached 10 minutes per isolate). A `*@users.noreply.github.com` address is never used.
  The address becomes the email's `Reply-To`, so replying reaches the person. With none, the
  email says so and, signed in, to answer through GitHub instead.
- **Checks.** `email`: one `@`, printable ASCII with no spaces, CR, LF or `<>()[],;:"\`, at most
  254 characters (`400 invalid_email`). `client`: only `dl`, `autopilot`, `os`, `arch` and
  `provider` (`"free"` or `"own-key"`) are kept, each at most 40 of `[A-Za-z0-9_.+- ]`; other
  keys are ignored, a bad value is `400 invalid_request`. A body over 32 KB is `413 too_large`.
- **Limits.** 10 an hour per network; signed in, also 5 an hour and 20 a day per person
  (`429 rate_limited` with `retryAfter`).
- `503 feedback_unavailable` when the service has no email binding or `ALERT_EMAIL_TO`; `502
  feedback_failed` when sending failed.

`GET /v1/feedback/reply-address` (signed in only) → `{"email": "me@example.com"}` or
`{"email": null}`: the same public GitHub email lookup, so the client can show where replies will
go before sending.

The email (subject `dl feedback from @alice`, or `dl feedback (not signed in)`):

```
dl deck froze when I resized the window.

──────────
From: @alice (https://github.com/alice), GitHub id 501
Reply to: alice@example.org (their public GitHub email). Replying to this email reaches them.
Client: dl 0.11.0, Autopilot 3.5.0, OS macos, Arch arm64, Provider free
Time: 2026-11-04 12:00:00 UTC

Sent by the free tier service. The message and the reply address aren't stored anywhere.
```

## Paid plans (Stripe)

- **Pro**, $10 a month: 100M tokens a week of DeepSeek V4.1 Flash 1017, in place of the free
  50M. Pro starts when its Checkout completes and stays on while the subscription is active and
  its paid period (plus 3 days' grace for a late renewal webhook) hasn't ended.
- **Top-up**, $3 once: 50M tokens, valid 30 days from purchase, used only after the week's
  allowance (free or Pro) runs out, earliest expiry first. A free person who is queued, or meets
  a global free cap, can still use top-ups.
- **Paid usage** (anything under Pro, and top-up tokens) is logged like any request, with
  `requests.paid = 1`, and counted apart: `spend_weeks.paid_usd/paid_tokens/paid_requests` and
  `daily_activity.paid_cost_usd`. It never counts toward the weekly or all-time free caps, the
  spend alerts or the queue forecast. The kill switch still stops everything.
- **Checkout** is created server-side with Stripe Tax (`automatic_tax[enabled]=true`) and the
  billing address collected (`billing_address_collection=required`; an existing customer gets
  `customer_update[address]=auto`). Prices are Stripe Price ids from config, never amounts in
  code. The GitHub id rides along as `client_reference_id` and metadata on the session, the
  subscription and the payment.
- **Webhook** `POST /v1/billing/webhook`: the `Stripe-Signature` header is verified
  (HMAC-SHA256 of `<t>.<raw body>` with `STRIPE_WEBHOOK_SECRET`, 5-minute tolerance), and each
  event id is handled once (`billing_events`); every step is idempotent too (top-ups by Checkout
  Session id, payments by session or invoice id), so a retried delivery is harmless. An event
  older than the last one applied to a person's subscription is ignored, so out-of-order
  deliveries can't undo a newer state.

  | event | effect |
  |---|---|
  | `checkout.session.completed` | saves the customer; Pro: active; top-up: +50M for 30 days (only when `payment_status` is `paid`) |
  | `invoice.paid` | Pro active until the invoice's period end; revenue recorded |
  | `invoice.payment_failed` | back to free (the free allowance, never no access) |
  | `customer.subscription.updated` | `active`/`trialing` → Pro; `past_due`, `unpaid`, `incomplete` → free; period end and cancel-at-period-end kept |
  | `customer.subscription.deleted` | free |

- **Revenue** on the dashboard is before tax (`amount_subtotal` of a top-up session,
  `total_excluding_tax` of a Pro invoice), in USD.

### Stripe setup (the owner, once)

1. **Products and prices.** In test mode first:
   `STRIPE_SECRET_KEY=sk_test_… node services/free/scripts/stripe-setup.mjs --webhook https://free.directionallylocal.com/v1/billing/webhook`
   creates "dl Pro" ($10.00/month) and "dl top-up, 50M tokens" ($3.00 once), both tax-exclusive
   with tax code `txcd_10000000`, and the webhook endpoint, and prints `STRIPE_PRICE_PRO`,
   `STRIPE_PRICE_TOPUP` and `STRIPE_WEBHOOK_SECRET`. For live mode, create the same in the
   Dashboard (the script refuses live keys).
2. **Stripe Tax.** Dashboard → Tax: add the business address and turn on collection where
   registered.
3. **Customer Portal.** Dashboard → Settings → Billing → Customer portal: allow cancelling
   subscriptions (at period end) and updating payment methods, then save.
4. **Webhook endpoint** (if not made by the script): `https://free.directionallylocal.com/v1/billing/webhook`
   with the events `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`,
   `customer.subscription.updated`, `customer.subscription.deleted`.
5. **Secrets and vars:** `wrangler secret put STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`;
   vars `STRIPE_PRICE_PRO`, `STRIPE_PRICE_TOPUP`. Without the secret key, the billing endpoints
   answer `billing_unavailable` and everything else works as before.

## The queue for free tokens

From the open launch, sign-up is never a hard block for new people. While **this week's free
spend is at or above `QUEUE_THRESHOLD` (0.8) of the weekly cap**, or anyone is already waiting, a
new open sign-up still gets an account (identity, referral link, own-key use, paid plans) but is
queued for free tokens, in order. People already in keep their allowance for the week. Invited
people and admins are never queued: an invite is the owner's own choice.

**With Luminal serving** (`primaryUpstream` is `luminal` and `LUMINAL_API_KEY` is set), the cash
caps stay near zero, so the queue watches Luminal credit instead: a new open sign-up waits once
**this week's free Luminal credit spend reaches `QUEUE_THRESHOLD` (0.8) of
`LUMINAL_WEEKLY_CREDIT_USD` ($250)**. The cash test above still applies as well. Monday's
admission uses the same arithmetic over credit: the average is last week's free credit spend per
active, and the budget is `QUEUE_THRESHOLD × LUMINAL_WEEKLY_CREDIT_USD`, at most the credit left
(`LUMINAL_CREDIT_USD` minus credit used). Free means non-admin and not Pro or a top-up.

**Each Monday** (on the first request after Monday 00:00 UTC), the queue is admitted front first,
as many as the forecast allows:

```
avg      = last week's free cost ÷ last week's actives    (non-admins with a free request)
           no data: the per-person weekly USD cap ($5)
budget   = QUEUE_THRESHOLD × weekly cap, and at most what is left of the all-time cap
admitted = the largest N with avg × (actives + N) ≤ budget
         = floor(budget ÷ avg) − actives, at least 0, at most the queue's length
```

For example, 30 actives at $5 last week and a $250 cap: floor(200 ÷ 5) − 30 = 10 people get in.
No weekly cap means everyone gets in.

**Order:** oldest first; each referred friend who has become weekly active moves a person up
`QUEUE_REFERRAL_PLACES` (25) places, ahead of whoever held that place.

**Estimated wait:** a person at position P expects free tokens on the Monday after
ceil(P ÷ per-week) weekly admissions, where per-week is the last Monday that let anyone in, or
today's forecast when none has yet (at least 1).

**Admin:** `GET /admin/queue` lists the line (position, id, login, queued at, active friends),
the last 12 Monday runs with their forecast inputs, and today's forecast.
`POST /admin/queue/admit {"count": 10}` lets the next 10 in now.

## Referrals

- **Codes:** everyone admitted gets a code: their GitHub login, lowercased, mapped to the numeric
  GitHub id. The link is `REFERRAL_LINK_BASE` + code, `https://dl.new/r/<code>`. The code never
  changes, even when the login does; if a login's code already belongs to someone else (a login
  that changed hands), the code is `<login>-<id in base 36>`.
- **Weekly active:** requests on 3 or more distinct UTC days of one Monday–Sunday week.
- **Bonus:** a referral counts for the current week when both people are weekly active last week
  or so far this week: it starts the day both reach 3 days and lasts while both stay weekly
  active, recomputed each week. Each counting referral gives **both** sides
  `REFERRAL_BONUS_TOKENS` (10M) a week, up to `REFERRAL_BONUS_CAP` (50M) a week per person. Bonus
  tokens are free tokens: their cost counts within the weekly budget.
- **Anti-abuse:** only new accounts can be referred, once. No payout for a person's own code
  (`self`), an unknown code, or two accounts seen on the same network (the same IPv4 address or
  IPv6 /64), at sign-up or at any later sign-in of either; a referral that turns out to share a
  network stops counting. One device can't hold both accounts (a device keeps one grant), and
  the per-network limit of 3 new accounts a day applies to referred sign-ups too. Networks are
  stored as keyed hashes, only for this check.

## Alerts

Free spend crossing **50%, 80% and 100%** of the weekly cap (once per threshold per week) and of
the all-time cap (once per threshold, ever) sends an alert; a jump past several thresholds sends
one. So do the kill switch (pause and resume), the queue starting (its first queued sign-up), and
an OpenRouter host failing more than 20% of at least 20 requests over the last hour (once, until
it recovers). With Luminal: credit used crossing **50%, 80% and 100%** of `luminalCreditUsd`
(once each per balance, so raising the balance re-arms them), the pause when the credit is used up
(once per balance), and Luminal slowing people down (below). Messages:

```
dl free tier: $200 of the $250 weekly cap used (80%). Resets Mon 00:00 UTC.
dl free tier: $500 of the $1,000 all-time cap used (50%). It doesn't reset; free tokens stop at 100% unless the cap is raised.
dl free tier: free tokens paused for everyone by <login> (kill switch).
dl free tier: the queue started ($200 of the $250 weekly cap used). New sign-ups wait in line for free tokens until Monday's admission.
dl free tier: OpenRouter host <slug> failed 9 of 40 requests in the last hour (23%). New requests avoid it while it keeps failing.
dl free tier: $1,600 of the $2,000 Luminal credit used (80%).
dl free tier: requests are refused with upstream_credit_exhausted: $2,000.12 of the $2,000 Luminal credit is used. Top up and raise luminalCreditUsd (POST /admin/config), or switch primaryUpstream to "openrouter".
```

**Luminal slowing people down.** Each Luminal request's outcome is logged (`luminal_outcomes`,
an hour kept, and `requests.upstream_outcome`): `ok`, `rate_limited` (Luminal's 429), `error`
(5xx, unreachable, the service's key refused, an error body, a stream failing part way) or
`timeout` (no response headers before `luminalFirstByteTimeoutSeconds`). Over a rolling 10
minutes, with at least 3 failures, when at least 10 requests had 10% or more rate limited or failed, or 3 different people
got a rate limit or a failure, the owner gets an email at once, and at most one more every 30
minutes while it lasts. It ends with one email, when the 10 minutes fall under 2% (with at least
10 requests) or nothing failed for 30 minutes after the last email. Admin requests count: they
are real traffic. Every request checks, whoever serves it, so after a switch to OpenRouter the
OpenRouter traffic is what ends it; with no Luminal requests in those 30 minutes the last email
says the alert is cleared, not that Luminal is fine. Dedupe is in `alerts_sent`:
`luminal-slow:open` while it lasts, `luminal-slow:alert:<30-minute bucket>` per email,
`luminal-slow:recovered:<opened at>` once per slow-down. This replaced the hourly "Luminal failed
more than 20% of 20 requests" alert, so one incident sends one set of emails.

```
Subject: dl free tier: Luminal is slowing people down (20% of requests in 10 min)

dl free tier: Luminal is slowing people down. 8 of 40 Luminal requests in the last 10 minutes were rate limited or failed (20%).

Rate limited (Luminal 429): 5
Errors (5xx, unreachable, refused key, failed streams): 2
Timeouts (no first byte in time): 1
People affected: 4
Serving now: Luminal

To switch to OpenRouter: open https://free.directionallylocal.com/admin#upstream → Upstream → OpenRouter (it spends OpenRouter credit until you switch back)

Admin requests count here: they're real traffic.
```

```
Subject: dl free tier: Luminal back to normal

dl free tier: Luminal is back to normal, 47 minutes after the first slow-down email. 0 of 52 Luminal requests failed or were rate limited in the last 10 minutes (0%).

Serving now: Luminal.
```

With OpenRouter serving and nothing sent to Luminal for 30 minutes, the subject is instead
`dl free tier: Luminal alert cleared (no Luminal requests in 30 min)`, with the link to switch
back. Without `OPENROUTER_API_KEY` the slow-down email says the switch isn't possible until it
is set.

**First user.** The first person admitted who isn't an admin (open admission or an invite; an
admin signing in doesn't count) sends one message, ever: the `first-signup` key in
`alerts_sent` is set on that admission, so it can't send twice. Where people were admitted before
this alert existed, the key is set on the next admission without sending.

```
Subject: dl free tier: your first user, @alice

dl free tier: your first user, @alice.

Login: @alice (https://github.com/alice)
How they got in: open admission          (or: invite code; referral link, open admission; …)
Time: 2026-11-04 12:00 UTC (20:00 Singapore)
Free tokens: available now               (or: waiting in the queue until Monday's admission)
```

**Daily digest.** A cron trigger, `0 1 * * *` (01:00 UTC, 09:00 Singapore; `triggers.crons` in
both wrangler configs), runs the Worker's `scheduled()` handler, which sends a digest of the
previous UTC day. It goes out on a quiet day too, with zeros: no digest by 09:30 Singapore means
the Worker or its alerts are broken. Each date's digest is marked in `alerts_sent`
(`digest:<date>`), so a retried or doubled cron run never sends it twice. `scheduled()` handles
only this cron; the weekly queue needs none (it runs on the first request of the week). The
numbers come from the dashboard's queries as of the end of that day (sign-ups, active people,
installs, the queue), the install counts by OS, chip and mode, the request log and the payments.
Admins are left out; "active" is a request that day (that week, for the week). The launch
budget is the Luminal credit alone, so the money lines are Luminal credit: free credit spent is
free usage only (not paid, not admins), credit left is the balance less everyone's use so far,
and the week's free credit is shown against `luminalWeeklyCreditUsd`. The free tier should never
spend on OpenRouter; if anyone did (admins and paid usage included), the day and the week each
get a warning line, `OpenRouter spend: $0.50 (should be $0)`. The dashboard
link is `<PUBLIC_URL>/admin`, or `https://free.directionallylocal.com/admin` without `PUBLIC_URL`
(a cron run has no request URL). Serverless Objects' config accepts `triggers`, but its docs
don't cover cron runs yet, so don't count on the digest off Cloudflare. A sample:

```
Subject: dl free tier: daily, 2026-11-03: 2 new, 2 active

dl free tier: daily digest for Tue 2026-11-03 (UTC). Admins left out.

New sign-ups: 2
  @alice (open admission), @bob (referral link, invite code)
Active people: 2
Requests: 3
Tokens: 3,300 in (1,400 cached), 330 out
Free credit spent: $0.75 (Luminal credit)
Luminal credit left: $1,980.25 of $2,000
Paid: $3 from 1 payment
Installs: 3 finished, 1 failed
  linux arm64 server: 2 ok, 1 failed
  darwin arm64 laptop: 1 ok, 0 failed
  Failed at: dl_up 1

This week so far (Mon 2026-11-02 to 2026-11-03):
  Sign-ups: 3
  Active people: 3
  Requests: 4
  Tokens: 3,800 in (1,400 cached), 380 out
  Free credit spent: $1.75 of the $250 weekly credit budget (1%)
  Paid: $13 from 2 payments

Queue: 0 waiting
Free tokens: PAUSED (kill switch)

Admin dashboard: https://free.directionallylocal.com/admin
```

At most 20 logins are listed; the rest are counted (`and 3 more`).

**Email (primary).** The Cloudflare config binds `send_email` as `ALERT_EMAIL`. Each alert is a
small plain-text RFC 5322 message from `ALERT_EMAIL_FROM` (`alerts@dl.new`) to `ALERT_EMAIL_TO`.
The subject is the short line (`dl free tier: 80% of the $250 weekly cap used`); the body is the
message above plus a link to the dashboard (`<PUBLIC_URL>/admin`). The binding is optional:
without it (Serverless Objects, or not set up yet) alerts go to the webhook, and with neither they
are written to the log. With both, both get every alert. The one line that loads
`cloudflare:email` runs only when the binding exists and carries a `portable-exception` note for
the portability check.

One-time setup (the owner, in Cloudflare; dl.new has no mail today, and directionallylocal.com's
Google Workspace mail and DNS are not touched):

1. Cloudflare → dl.new → Email → Email Routing → Enable (adds MX/TXT records on dl.new only).
2. Add and verify the destination address (Email Routing → Destination addresses).
3. Set `ALERT_EMAIL_TO` to that address (a var or secret). Optionally pin the binding to it with
   `"destination_address"` in `wrangler.cloudflare.jsonc`.

**Webhook.** `ALERT_WEBHOOK_URL` (a secret: it holds a token). The format comes from the host, or
`ALERT_WEBHOOK_KIND` (`discord`, `slack`, `telegram`):

| kind | URL | body |
|---|---|---|
| Discord | `https://discord.com/api/webhooks/…` | `{"content": text}` |
| Slack | `https://hooks.slack.com/services/…` | `{"text": text}` |
| Telegram | `https://api.telegram.org/bot<token>/sendMessage` | `{"chat_id", "text"}`; chat id from `ALERT_TELEGRAM_CHAT_ID` or `?chat_id=` on the URL |
| other | any https URL | `{"text": text, "content": text}` |

A failed alert is logged and not retried; it never fails the request that triggered it.

## Refusals

Every refusal is `{"error": {"code", "message", ...}}`. The browser page and `error.message`
use the same sentence, so a client that doesn't know a code can show the message as it is.

| code | where | extra |
|---|---|---|
| `account_too_new` | `POST /v1/device/token` | `reason` |
| `no_github_activity` | `POST /v1/device/token` | `reason` |
| `invite_required` | `POST /v1/device/token` | `reason` |
| `cohort_full` | `POST /v1/device/token` | `reason` |
| `too_many_signups` | `POST /v1/device/token` | `reason` |
| `access_denied` | `POST /v1/device/token` | `reason: "device_taken"` when the device holds another account's grant |
| `service_paused` | device code, device token, chat | `reason: "paused"`, `pausedForEveryone: true`, `resetsAt: null` |
| `global_weekly_budget_reached` | chat (503) | `reason: "weekly_budget"`, `pausedForEveryone: true`, `resetsAt` (ISO time), `Retry-After` header |
| `global_total_budget_reached` | chat (503) | `reason: "total_budget"`, `pausedForEveryone: true`, `resetsAt: null` |
| `quota_exceeded` | chat (402) | `reason: "tokens" \| "spend"`, `resetsAt`, `offers`, `referralLink` |
| `basic_limit`, `starter_limit` | chat (402) | `reason: "tokens" \| "spend"`, `resetsAt`, `request`, `offers`, `referralLink` |
| `below_bar` | chat (403) | `contact`, `request` |
| `free_tier_queued` | chat (402) | `position`, `etaAt`, `offers`, `referralLink` |
| `upstream_credit_exhausted` | chat (503) | `reason: "credit_exhausted"`, `pausedForEveryone: true`, `resetsAt: null` |
| `upstream_busy` | chat (429, `Retry-After`) | `retryAfter`, `retryable: true`, `upstream: "luminal"` |
| `upstream_unavailable` | chat (503, `Retry-After`) | `retryAfter`, `retryable: true`, `upstream: "luminal"` |
| `upstream_timeout` | chat (503, `Retry-After`) | `retryAfter`, `retryable: true`, `upstream: "luminal"` |
| `dl_only` | chat (403) | none |
| `server_keys_unavailable` | `POST /v1/keys`, and any request with a server key (403) | none |
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
| `perPersonWeeklyUsdCap` | `PER_PERSON_WEEKLY_USD_CAP` | 20 |
| `globalWeeklyUsdCap` | `GLOBAL_WEEKLY_USD_CAP` | 2000 |
| `globalTotalUsdCap` | `GLOBAL_TOTAL_USD_CAP` | 7000 |
| `maxActiveUsers` | `MAX_ACTIVE_USERS` (invite-only only) | 50 |
| `openAdmission` | `OPEN_ADMISSION` | false |
| `requireGithubActivity` | `REQUIRE_GITHUB_ACTIVITY` | true |
| `cachedTokenWeight` | `CACHED_TOKEN_WEIGHT` | 0.02 |
| `queueThreshold` | `QUEUE_THRESHOLD` | 0.8 |
| `queueReferralPlaces` | `QUEUE_REFERRAL_PLACES` | 25 |
| `referralBonusTokens` | `REFERRAL_BONUS_TOKENS` | 10,000,000 |
| `referralBonusCap` | `REFERRAL_BONUS_CAP` | 50,000,000 |
| `primaryUpstream` | `PRIMARY_UPSTREAM` | `openai` (`luminal` and `openrouter` are manual switches) |
| `openaiCreditUsd` | `OPENAI_CREDIT_USD` | 5000 |
| `openaiWeeklyCreditUsd` | `OPENAI_WEEKLY_CREDIT_USD` | 2000; `none` for no weekly credit budget |
| `openaiFirstByteTimeoutSeconds` | `OPENAI_FIRST_BYTE_TIMEOUT_SECONDS` | 30 |
| `luminalCreditUsd` | `LUMINAL_CREDIT_USD` | 2000 |
| `luminalWeeklyCreditUsd` | `LUMINAL_WEEKLY_CREDIT_USD` | 250; `none` for no weekly credit budget |
| `luminalFirstByteTimeoutSeconds` | `LUMINAL_FIRST_BYTE_TIMEOUT_SECONDS` | 30 |
| `userEmails` | `USER_EMAILS` | true (sends only with the `USER_EMAIL` binding or `RESEND_API_KEY`) |
| `dlOnly` | `DL_ONLY` | true (free tokens inside dl only; see below) |
| `accessRequestAlerts` | `ACCESS_REQUEST_ALERTS` | `each` (an email per access request); `daily` (one line in the daily digest); `off` |
| `starterWeeklyTokens` | `STARTER_WEEKLY_TOKENS` | 5,000,000 (0: no free tokens below Basic) |
| `starterWeeklyUsdCap` | `STARTER_WEEKLY_USD_CAP` | 0.5 |
| `basicMinAccountAgeDays` | `BASIC_MIN_ACCOUNT_AGE_DAYS` | see `src/config.ts` |
| `basicWeeklyTokens` | `BASIC_WEEKLY_TOKENS` | 10,000,000 (0 turns Basic off) |
| `basicWeeklyUsdCap` | `BASIC_WEEKLY_USD_CAP` | 3 |

Env only: `REFERRAL_LINK_BASE` (`https://dl.new/r/`), the offers above, `ALERT_EMAIL_TO`,
`ALERT_EMAIL_FROM` (`alerts@dl.new`), `ALERT_WEBHOOK_URL`, `ALERT_WEBHOOK_KIND`,
`ALERT_TELEGRAM_CHAT_ID`, the prices `LUMINAL_PRICE_INPUT`, `LUMINAL_PRICE_CACHED`,
`LUMINAL_PRICE_OUTPUT`, `OPENROUTER_PRICE_INPUT`, `OPENROUTER_PRICE_CACHED`,
`OPENROUTER_PRICE_OUTPUT`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `USER_EMAILS_TO_ADMINS`, and the
secrets `OPENAI_API_KEY`, `LUMINAL_API_KEY` and `RESEND_API_KEY`.

```sh
# Read the effective values, the env values, the overrides and the change log
curl -H "authorization: Bearer $ADMIN_TOKEN" https://free.example.com/admin/config

# Set values. null goes back to the env value; USD caps also take "none" (no cap).
curl -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"weeklyTokens": 60000000, "globalWeeklyUsdCap": 300, "openAdmission": null}' \
  https://free.example.com/admin/config
```

## Emails to users

Plain-text emails to the people on the free tier. The copy is in `src/user-emails.ts`;
when each goes out is in `src/user-email-send.ts`. The provider:

1. **Cloudflare Email Service**, when the `send_email` binding `USER_EMAIL` exists (the
   Cloudflare config declares it: `"send_email": [..., { "name": "USER_EMAIL" }]`). It sends
   with the binding's `send({from, to, replyTo, subject, text, headers})`
   ([Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)),
   from `directionallylocal.com`, which must be onboarded in Email Service. Needs the Workers
   Paid plan. Off Cloudflare the binding is simply absent.
2. Otherwise **Resend** (`POST https://api.resend.com/emails`) when `RESEND_API_KEY` is set.
3. Otherwise nothing is sent and nothing fails.

| email | when |
|---|---|
| welcome | right after a new sign-up gives their email on the details step; by level: `welcome` (Full), `welcome_basic`, `welcome_starter_small` (a Starter allowance), `welcome_starter` (no free tokens) |
| access granted | an admin grants the person's access request (`access_granted`; not held back by the one-a-day rule) |
| didn't start | daily run: admitted 24 to 72 hours ago, no request yet |
| most of the week used | the request whose settlement takes the week past 80% of a pool's tokens or of the weekly dollar cap; once a week |
| gone quiet | daily run: requests on 2 or more days, none in the last 7 |

Only to people with an email who haven't pressed stop; never to admins (unless
`USER_EMAILS_TO_ADMINS=true`, for testing); at most one email per person per UTC day (an
access grant excepted); each
kind once per person, the weekly one once per week. Nobody still waiting in the queue gets the
welcome or the didn't-start email. Every send is recorded in the Directory's `user_emails`
table before the provider is called and marked sent or failed after it, so nothing goes twice
across retries or deploys (Resend also gets an `Idempotency-Key`; Email Service has none, so a
crash between the send and the mark could, rarely, repeat one email on the retry). A failed send is retried once, by the next daily run (01:00 UTC);
failures are logged as counts only.

Each email ends with a stop link, `/email/stop?u=<github id>&t=<hmac>` (an HMAC of the id with
`TOKEN_SIGNING_KEY`), and carries `List-Unsubscribe` and `List-Unsubscribe-Post` headers for the
same URL. GET shows a page with one button; POST (the button, or a mail app's one-click) sets
`people.email_stop`.

| env | default |
|---|---|
| `USER_EMAIL` (binding) | absent: Resend, if `RESEND_API_KEY` is set |
| `RESEND_API_KEY` (secret) | unset (and no binding): nothing is sent and nothing fails |
| `EMAIL_FROM` | `sina <sina@directionallylocal.com>` |
| `EMAIL_REPLY_TO` | `contact@directionallylocal.com` |
| `USER_EMAILS` (also the runtime setting `userEmails`) | true |
| `USER_EMAILS_TO_ADMINS` | false |

With Resend, `directionallylocal.com` must be verified in Resend (its SPF and DKIM DNS
records). To stop every email without a deploy: `POST /admin/config {"userEmails": false}`.

### Test email (admins)

`POST /admin/emails/test {"kind": "welcome" | "didnt_start" | "week_80" | "gone_quiet", "to": "<address>"}`
sends one email of that kind to `to`, exactly as a person would get it (copy, sender, Reply-To,
headers, provider), with the calling admin's own stop link. It records nothing for anyone and
works while `userEmails` is off. Answers `{sent, provider, messageId}`, or 502 with the
provider's error code (for example `E_SENDER_NOT_VERIFIED`).

### Broadcasts (admins)

```sh
curl -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"subject": "a quick check-in", "text": "hey,\n\nhow is dl going?\n\nsina",
       "audience": "all", "signedUpFrom": "2026-11-01", "signedUpTo": "2026-11-07", "dryRun": true}' \
  https://free.example.com/admin/emails/broadcast
```

A one-off email to active people of a level (`full`, `starter` or `all`) who signed up in the
range (`people.admitted_at`; a plain date includes that whole day). Never to blocked or
suspended accounts, people who pressed stop, people with no email, or admins (unless
`USER_EMAILS_TO_ADMINS`). The text gets the same stop footer as every user email, and the
`List-Unsubscribe` headers. The copy must be lowercase outside URLs and addresses, with no em or
en dashes, or the call is refused. `dryRun` is required: `true` answers `{count,
waitingForTomorrow, sample}` (3 recipients) and sends nothing.

The broadcast's id is a hash of the subject and text, recorded per person in `user_emails`
(kind `broadcast`), so calling again never sends the same message to anyone twice, whatever the
filters. The one-a-day cap applies: people who had another email today wait for a call
tomorrow. A call sends at most 100, one every 600 ms, and stops at the provider's rate or
daily limit (`stoppedBy`); call again for the `remaining` ones, failed ones included (3
attempts each). Refused while `userEmails` is off.

## What counts against the weekly allowance

```
charged = uncached prompt tokens + completion tokens + ceil(cached prompt tokens × cachedTokenWeight)
```

The default weight of 0.02 is OpenRouter's cache-read price divided by its input price for
`deepseek/deepseek-v4.1-flash-1017`: $0.006/M over $0.30/M, as listed on 2026-11-03.
`COUNT_CACHED_TOKENS=false` still works and means a weight of 0, unless `CACHED_TOKEN_WEIGHT`
is set. The global USD caps count only real cash: the cost OpenRouter reports. The per-person
dollar allowance counts every request: OpenRouter's reported cost, or a Luminal request's tokens
at the OpenRouter prices we were billed (see below).

## Upstreams: Luminal and OpenRouter

Chat requests go to one upstream, the runtime setting `primaryUpstream`:

- **`luminal`** (the default): `https://flash.luminal.cloud/v1/chat/completions` with
  `LUMINAL_API_KEY`, model `deepseek-ai/DeepSeek-V4.1-Flash-1017`. The request is the client's,
  with `max_completion_tokens` set to the reserved output cap, `stream_options.include_usage` on
  streams, OpenRouter's `reasoning: {effort}` sent as `reasoning_effort`, and OpenRouter-only
  fields (`provider`, `usage`, `models`, `route`, `transforms`, `plugins`, `session_id`,
  `max_tokens`) removed. Free, Pro and admin requests all go there.
- **`openrouter`**: the OpenRouter request below, unchanged, with its filters and host avoidance.
  This is a manual switch: **Serve from: Luminal / OpenRouter** in the dashboard's Upstreams
  section (`/admin#upstream`), or `POST /admin/config {"primaryUpstream": "openrouter"}`.

Without `LUMINAL_API_KEY`, OpenRouter serves whatever the setting says. Set the key with
`wrangler secret put LUMINAL_API_KEY`; it is never logged or shown by the admin API.

**No automatic fallback.** A request is never switched from one upstream to the other. When
Luminal fails, the client gets a transient error and retries on its own:

| Luminal | client gets |
|---|---|
| 429 | 429 `upstream_busy`, "The free tier is busy right now; retrying…", Luminal's `Retry-After` (default 5 s) |
| 5xx, or unreachable | 503 `upstream_unavailable`, `Retry-After` |
| no response headers within `luminalFirstByteTimeoutSeconds` (30) | 503 `upstream_timeout`, `Retry-After: 5`; the Luminal request is aborted |
| a stream failing part way | passed through as it is (the stream ends with an error) |
| 400 | 400 `upstream_error` with Luminal's message |
| 401, 402, 403 | 502 `upstream_error` (the service's key or account) |

None of these is charged. Autopilot's dl client retries only `rate_limited` today, so it needs to
treat these three codes (or `retryable: true`) as retryable before Luminal goes live.

**Credit.** Luminal reports `usage.prompt_tokens_details.cached_tokens` but no cost, so each
request's credit is computed from its usage at Luminal's list prices (USD per million tokens,
from luminal.com/pricing):

| | env | default |
|---|---|---|
| input | `LUMINAL_PRICE_INPUT` | 0.1425 |
| cached input | `LUMINAL_PRICE_CACHED` | 0.0029 |
| output (reasoning included) | `LUMINAL_PRICE_OUTPUT` | 0.57 |

```
credit = (uncached prompt × input + cached prompt × cached + completion × output) ÷ 1,000,000
```

A stream that ends without usage is charged its reservation at the fallback price, like
OpenRouter's. Credit used is the sum over every Luminal request (free, Pro and admin). When it
reaches `luminalCreditUsd` ($2,000; raise it after a top-up with `POST /admin/config`), every
chat request is refused with 503 `upstream_credit_exhausted` ("Free tokens are paused while we
top up. Your own key still works.") and Luminal isn't called. Nothing switches to OpenRouter;
the owner can do that by hand.

**What the caps count.**

- **Global caps (cash only).** The weekly ($250) and all-time ($1,000) caps count only what
  OpenRouter billed. Luminal credit is prepaid, so it isn't counted there; with Luminal serving
  they stay near zero. The queue watches the weekly credit budget instead (see the queue).
- **Per-person allowance (every request).** The 50M tokens are charged the same on both
  upstreams. The $5 a week is charged a Luminal request's cost **at the OpenRouter prices we
  were actually billed** (`OPENROUTER_PRICE_INPUT` 0.035, `OPENROUTER_PRICE_CACHED` 0.006,
  `OPENROUTER_PRICE_OUTPUT` 0.315 per million tokens), not at Luminal's. These are the prices of
  Morph, the cheapest full-precision host that served the free tier, as listed by OpenRouter's
  endpoints API on 2026-11-04, and a real billed request matched them. So a person's week ends
  where it did before the switch to Luminal, and Luminal's prices don't change what the free
  tier gives.
- **The request log** has `upstream`, `credit_usd`, `ttfb_ms`, `ttft_ms` and `upstream_error`
  on every row. `cost_usd` stays what the person's allowance was charged: OpenRouter's reported
  cost, or OpenRouter prices for a Luminal request.

`GET /admin/spend` adds `upstream: {primary, serving, luminalConfigured}` and
`luminalCredit: {balanceUsd, usedUsd, leftUsd, weekUsd, freeWeekUsd, weeklyBudgetUsd}`.

**Telemetry.** Each request records the time to the response headers (TTFB) and to the first
chunk with content (TTFT: text, reasoning or a tool call), per upstream, in `upstream_timings`
(time, upstream and the two numbers; no person, kept 15 days), and per-day counts in
`upstream_daily` (requests, upstream errors, prompt and cached tokens, cash and credit).

## Which OpenRouter host serves requests

Every chat request asks OpenRouter for the cheapest host that passes two filters, with fallbacks
on among the hosts that pass:

```json
"provider": { "sort": "price", "allow_fallbacks": true,
              "quantizations": ["fp8", "mxfp8", "fp16", "bf16", "fp32"], "data_collection": "deny" }
```

- **Full precision.** DeepSeek V4.1 Flash 1017 ships FP8 weights, so FP8 and anything wider
  is allowed. FP6, FP4, integer quantizations and hosts that don't state a precision
  (`unknown`) are excluded.
- **No prompt collection.** `data_collection: "deny"` keeps only hosts OpenRouter lists as
  neither training on nor storing prompts. DeepSeek's own host is excluded by this filter.

Each setting has an env var and an admin override (`POST /admin/config`):

| setting | env | default |
|---|---|---|
| `openRouterProviderOrder` | `OPENROUTER_PROVIDER_ORDER` (comma-separated slugs) | empty: no pinned host, cheapest first |
| `openRouterQuantizations` | `OPENROUTER_QUANTIZATIONS` (comma-separated levels) | `fp8,mxfp8,fp16,bf16,fp32`; empty means no filter |
| `openRouterDataCollection` | `OPENROUTER_DATA_COLLECTION` | `deny` (`allow` is permitted) |
| `openRouterHostCooldownMinutes` | `OPENROUTER_HOST_COOLDOWN_MINUTES` | `10`; `0` turns host avoidance off |

Setting an order sends `order` instead of `sort`. The filters still apply, so a pinned host
that fails them is skipped. Hosts bill different prices for the same model, so check
`requests.cost_usd` after any change.

As a backstop on the company key, also turn off "Allow providers that may train on inputs" in
OpenRouter's account privacy settings.

### Steering around a failing host

OpenRouter says which host served each response: the `provider` field of a completion or of
each stream chunk, and `error.metadata.provider_name` on an error. When a request fails in a
way the host is to blame for (an HTTP 5xx naming the host, an error body, or a stream that
carries an error or ends without `[DONE]`), that host is listed as failing for
`openRouterHostCooldownMinutes` (10 by default). A client closing its stream, a 4xx, a 429
and an error that names no host don't count.

While a host is listed, new requests add it to `ignore`, and the filters and the sort pick
the next host:

```json
"provider": { "sort": "price", "allow_fallbacks": true,
              "quantizations": ["fp8", "mxfp8", "fp16", "bf16", "fp32"], "data_collection": "deny",
              "ignore": ["morph"] }
```

If OpenRouter then answers that no host is available, the request is sent once more without
`ignore`. The list is one small table in the rate-limiter object `openrouter-hosts`, shared
by every request. Each row is a host and when it last failed; whether it still counts is
decided from the current cooldown, so a change, or `0`, applies to the next request.

Each request with a known host adds to `host_daily` (requests and failures per host per day),
and each failure adds a row to `host_failures` (time, host, `http_5xx` | `error_body` |
`stream`, upstream status). Counts only, never content. `GET /admin/metrics` returns
`hosts: [{host, requests, failures, failureRate}]` for its date range.

## Sign-out and server keys

- **Sign out:** `POST /v1/token/revoke`. Send the access token as the bearer, `{"refresh_token"}`
  in the body, or both. This ends that sign-in session: its refresh tokens are deleted, so
  refresh fails, and its access tokens stop working at once. The person's other sessions keep
  working. An unknown refresh token still gets a 200.
- **Admin, revoke everything for one person:** `POST /admin/people/:id/revoke-tokens`. This ends
  every session and deletes every server key. The person can sign in again.
- **Server keys:** long-lived, named and revocable keys for a server that runs agents
  unattended. All three endpoints need a signed-in access token; a server key can't call them.

  | request | response |
  |---|---|
  | `POST /v1/keys {"name": "build-box"}` | 201 `{id, name, key, createdAt, lastUsedAt}`. `key` is shown only here. |
  | `GET /v1/keys` | `{keys: [{id, name, createdAt, lastUsedAt}], max: 5}` |
  | `DELETE /v1/keys/:id` | `{id, revoked: true}`, or 404 `key_not_found` |

  - **Where a key works:** `Authorization: Bearer dlk_…` on `/v1/chat/completions`,
    `/v1/models`, `/v1/me` and `/v1/events`. Usage is charged to the same account.
  - **Storage:** only the SHA-256 of the secret is kept.
  - **Limits:** at most 5 keys per account (409 `key_limit_reached`), and names must be unique
    within an account (409 `key_name_taken`).
  - **Who may have keys:** admins, people whose level an admin set (`level_reason = 'admin'`:
    a grant from the Tools tab or an answered `/request`) and Pro subscribers. Anyone else gets
    403 `server_keys_unavailable` on `POST /v1/keys` ("Server keys on the free tier are by
    request. Type /request in dl and say what server you want to run it on, or use your own API
    key on the server."). Listing and revoking work for everyone. A key made before this rule
    isn't deleted: requests with it get the same 403 until an admin grants the account, and then
    it works again. A blocked or suspended account's key gets `blocked` or `suspended` as before.
  - **Errors:** a wrong or revoked key gets 401 `invalid_key`. Signing out leaves keys working.
  - **Admin view:** `/admin/people` shows how many keys each person has, never the keys.

A per-person grant (`POST /admin/people/:id/grant`) still wins over the weekly defaults. The kill
switch is `POST /admin/pause` and `/admin/unpause`; `PAUSED=true` in env pauses as well.

## Install counts

Two public endpoints count the top of the funnel, anonymously. No sign-in; each adds one to a
per-UTC-day total for its values, and nothing else is stored: no IP address, user agent, invite
code, account or device. `204` when counted, `400 invalid_request` for any value outside the
lists, `413` over 1 KB, `429` when rate-limited.

| request | sent by |
|---|---|
| `POST /v1/telemetry/download {"route", "client"}` | the dl.new and directionallylocal.run Workers, after serving an install script (`ctx.waitUntil`, never delaying it) |
| `POST /v1/telemetry/install {"os", "arch", "mode", "dlVersion", "result", "failedStep"?, "via"}` | `install.sh`, once at the end, in the background with `curl -m 3` |

- `route`: `home` (dl.new), `invite` (dl.new/r/…), `private_invite` (dl.new/i/…), `continue`
  (dl.new/continue), `run` (directionallylocal.run; laptops and servers fetch the same URL, so
  the split is the install's `mode`). dl.new's scripts fetch directionallylocal.run with
  `?via=`, which isn't counted again. `client`: `curl`, `wget` or `other`.
- `os` `darwin|linux`, `arch` `arm64|x64`, `mode` `laptop|server`, `dlVersion` `x.y.z` (or empty
  when it failed before dl was installed), `result` `ok|failed`, `failedStep` (with `failed`
  only) `preflight|node|install_dl|path|dl_up`, `via` `home|invite|continue|run` (from
  `DL_INSTALL_VIA`, which the dl.new scripts set).
- install.sh skips it with `DL_NO_TELEMETRY=1`, `DO_NOT_TRACK=1` or `CI` set.
- Rate limits per IP (per /64 for IPv6): 600 downloads a minute (they come from a few Cloudflare addresses) and 20
  installs an hour. The limiter's key is a SHA-256 of the IP salted with `TOKEN_SIGNING_KEY` and
  the day, so the address isn't stored there either.
- Stored in the Directory's `download_daily` and `install_daily`. The counts are best effort:
  anyone can post one, so read them as trends, not exact numbers.

## Admin dashboard

**Home screen.** `GET /admin` opens on four questions, each answered in one plain sentence, made to
be read on a phone in half a minute (`src/home-page.ts`, numbers from `src/home-data.ts`):

1. **Are we OK?** "Fine", "Watch it" or "Act now", this week's free spend against the weekly budget
   (the configured providers' weekly credit budgets added up), where it lands by Monday at this
   pace, the credit left per provider and how many weeks it lasts. Act now: past 80% of the budget
   by Monday, under 4 weeks of credit, a provider's credit used up, or no provider key. Watch it:
   past 50%, under 8 weeks, or paused. A small chart of spend per day for 14 days, by provider.
2. **Who's using it?** People with a request or session today and this week, sign-ups today, and
   the five who spent most this week: tier in plain words (full, middle, small, no tokens), dollars
   of their real cap (their level's, or an admin's grant; a creation-batch account has none), and
   "at cap" when they reached it.
3. **Is anything broken?** At most three problems, worst first, each linking to the Health or Full
   view: a provider failing 10%+ of requests today and at least twice its week's share (20+
   requests), a model failing more than 10% this week (20+ requests), installs on one platform
   failing more than 15% (5+ installs), more than 25% of this week's sessions ending without a
   normal exit (20+ sessions), spend or credit past the thresholds above, and people at their cap.
4. **What needs me?** Pending `/request` asks with Grant and Decline (the Tools tab's form,
   answered back on the home screen). This block comes first when anything is pending.

Simple, Full (`?view=full`), Health and Tools are links in a "Details" row at the bottom.

**Full view.** `GET /admin?view=full` is the full page: weekly active developers (3+ days and any
day, last 8 weeks), cohort retention (weeks 1, 2 and 4 after sign-up), cost per person per week
(total, median, mean, and the top 10 of any week), who reached their token or dollar allowance
this week and last (and on which day), and the budget with the pause and admission state. The
page wears the dl.new brand: its fonts and logo load from `https://dl.new` (the page's CSP allows
`font-src` and `img-src` from there and nothing else; still no scripts). Each table has a CSV at `/admin/dashboard/<table>.csv`
(`spend`, `weekly-active`, `retention`, `retention-daily`, `weekly-cost`, `top-cost?week=YYYY-MM-DD`, `limits`,
`queue`, `referrals`, `funnel`, `install-funnel`, `installs`, `paid`, `upstreams`).

**Daily retention:** people grouped by the UTC day they were admitted (the last 21 days with
sign-ups; admins and blocked accounts left out), and the share who made at least one request on
day 0–7 and 14 after it. A day stays blank until it has ended (UTC), so today's partial
numbers never show or count in the averages. The simple view (`/admin?view=simple`) draws it as a cohort triangle (the phone drawing
drops D14) with the average D1 and D7 under it, weighted by cohort size; the full view has the
table, `retention-daily.csv` has `cohort, size, d0…d7, d14` (shares), and `GET /admin/metrics`
returns it as `cohorts: [{day, size, d: {0: share, …, 14: share}}]` (null for days that haven't ended).
It counts only people who could use dl: they had free tokens at sign-up (`people.signup_tokens`:
Full, Basic, an admin's grant, or a Starter allowance without the batch flag; for sign-ups from
before it was stored, the current level stands in). Next to it, per sign-up day, a small funnel
of everyone: signed up, got tokens, refused, and refused but opened dl that day (a dl session or
a refused chat request, from `refused_days`); `GET /admin/metrics` has it as
`signupFunnel: [{day, signedUp, gotTokens, refused, refusedOpened}]`.

At the top: the **budget, which is the Luminal credit**: credit used and left of
`luminalCreditUsd` ($2,000), this week's free credit against `luminalWeeklyCreditUsd` ($250), and
where the queue starts (`queueThreshold` of the weekly credit budget) with when this week's pace
would reach it. A red banner shows at 80% of either. The OpenRouter cash caps
(`globalWeeklyUsdCap`, `globalTotalUsdCap`) aren't shown as a budget; they still apply to
OpenRouter spend, and the state line says so if one stops free tokens. Then the **abuse
section** (below), the queue (waiting now, the longest wait, how many this
Monday let in and the forecast behind it), referrals (links used, sign-ups via referral, how many
became weekly active, bonus tokens a week granted this week), paid plans (active Pro
subscribers, top-ups this week and month, revenue before tax this week and month, and what paid
usage cost upstream), and the funnel: per day (last 14) and per week (last 8), install scripts
served by route → installs finished, ok and failed → sign-ups → first request → active (that
day; for a week, 3+ request days), then installs by OS, chip and mode and the top failed steps,
then the funnel per sign-up week and in all (sign-ups → first request → weekly active). The
first two steps are [anonymous counts](#install-counts) and can't be joined to people. Counts
only, no content.

**Serving from** (under the heading): the upstream serving now, with a link to the switch.

**Upstreams** (after the abuse section, `#upstream`): which upstream is serving, the **Serve
from: Luminal / OpenRouter** buttons (a form posting to `/admin/dashboard/upstream` with the
session's CSRF token and a same-origin check, like Block; it sets the `primaryUpstream` override,
logged in the admin log; an upstream without its key can't be chosen), and per
upstream for today and this week: requests, errors, median and p90 time to first token, median
time to first byte, cache-hit share (cached over prompt tokens), credit and cash. These count
admin requests too, since they measure the upstream. The red banner also shows at 80% of the
credit. CSV: `upstreams`.

**Abuse:** accounts sharing a network hash with other accounts (grouped, with login, sign-up
time, when each was first seen on the network, and this week's requests, tokens and credit),
sign-ins refused with `device_taken` in the last 7 days (who tried, the shortened device id, who
holds its grant, how many times; recorded in the Directory's `device_refusals`), referral pairs
stopped as `same_network`, the top 25 users this week (with how many accounts share a network
with each), blocked accounts, and the GitHub activity check's daily outcomes. Each person has a
**Block** button (Unblock once blocked). Then an **admin log**: the config log, newest first,
which records settings, pause, block and unblock.

- **Block:** `POST /admin/people/:id/block` and `/unblock` (admin bearer token), or the
  dashboard's form, which posts to `/admin/dashboard/people/:id/block|unblock` and needs the
  session cookie, a same-origin request and a CSRF token bound to the session. It sets the
  person's status to `blocked` (unblock: `active`) and logs it (`person_status:<id>:<login>`).
  Blocked: chat requests, token refresh and server-key creation answer 403 `blocked` ("This
  account is blocked from the free tier. Contact contact@directionallylocal.com."), and sign-in
  is refused on the page and at `POST /v1/device/token` (403 `blocked`). Unblocking restores all
  of it; refresh tokens aren't used up while blocked. `suspend` stays as it was.
- **Free tokens inside dl only (`dlOnly`, on by default):** Autopilot always sends session
  events (`POST /v1/events`) while the free tier is its provider, so a sign-in token used from
  another tool sends requests and no events. A chat request from a free-plan account is
  refused with 403 `dl_only` ("Free tokens work inside dl only. Run dl to keep using them, or
  use your own API key in any tool.") when no session event (one with a session id) arrived in
  the last 24 hours and the account has made at least 20 free chat requests with a sign-in token
  that no session event covers: a session event covers the 24 hours after it, so these are the
  requests made more than 24 hours after the latest one (all of them, for an account that never
  sent one). Autopilot batches events for a few seconds, so a new session's first requests come
  before its first event: the threshold leaves room for that, once, not every day. Not counted and never refused: admins, requests with a
  server key (`dlk_`, dl's server mode) and paid usage (Pro and top-ups; a refused free account
  with a top-up is served from it). The check reads the caller's events and request log in the
  Directory read every chat request already makes; the only new write is a `via_key` flag on the
  request row it already inserts. Switch it off with `POST /admin/config {"dlOnly": false}`.
  The simple view's red flags show **Used outside dl** for an account with at least 10 such
  requests and no session event in the last 7 days (events counted by UTC day); the full view's
  top users table and `GET /admin/people` (`dlSessionsThisWeek`) show dl sessions this week,
  the distinct session ids in each person's events, counted in `daily_activity.sessions`.
- **Admins are left out of every number:** anyone in `ADMIN_GITHUB_IDS` and anyone admitted as
  an admin.
- **What it reads:** only `daily_activity`, a per-person per-day roll-up of request and event
  counts, charged tokens and cost, plus GitHub logins, sign-up times, per-person grants and the
  spend totals, and for the launch sections the queue (ids and times), the Monday runs (counts
  and the forecast) and referrals (ids, time and outcome), and for the upstreams `upstream_daily`
  and `upstream_timings` (counts, tokens, dollars and milliseconds per upstream, no person), and
  for the install funnel `download_daily` and `install_daily` (anonymous counts). No model, event type or properties,
  session ids, prompts or code. A test runs
  the dashboard under an SQLite authorizer that allows only those columns. The abuse section
  and the admin log also read network hashes, device ids, `people.status`, `device_refusals`,
  `github_checks_daily` and `config_log`, held to their own list (`ABUSE_COLUMNS` in abuse.ts).
- **The roll-up** is kept up to date with each request and event, and built once from the
  existing log the first time this version starts.
- **Reached the allowance** means charged tokens at 99% of the token allowance (the last
  request's reservation can't fit in the final 1%) or cost at the dollar allowance, using
  today's allowances, including grants set with `POST /admin/people/:id/grant` from this version
  on.
- **Sign-in:** "Sign in with GitHub" on the page runs the OAuth web flow with exactly the
  OAuth app's registered callback, `redirect_uri=<PUBLIC_URL>/device/callback`, so the app
  needs no change (it matches redirect URIs exactly). Device sign-in comes back to the same
  callback; the sign-in `state` is stored with its purpose (`admin` or `device`), which picks
  the flow, and each flow refuses the other's state. The old `/device/callback/admin` path still
  works for now as an alias. Only ids in `ADMIN_GITHUB_IDS` get a session: an
  HttpOnly, Secure, SameSite=Strict `__Host-` cookie holding a signed one-hour token that can't
  be used as an API bearer token. Sign-out ends it at once. Scripts can send an admin access
  token as the bearer instead.
