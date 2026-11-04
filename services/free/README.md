# Free managed tier service

A portable Worker with Durable Objects (SQLite) that gives signed-in people a weekly allowance of
`deepseek/deepseek-v4.1-flash-1017`, served by Luminal on prepaid credit (or by OpenRouter, by an
admin switch; see [Upstreams](#upstreams-luminal-and-openrouter)). Sign-in is GitHub by device code. The
contract is in `src/app.ts`, and the refusal sentences are in `src/messages.ts`.

A sign-in code lasts 15 minutes (`expires_in: 900`), long enough to open the link on a phone
and sign in to GitHub there. The terminal polls every 5 seconds.

## Admission

There is one account per GitHub user, keyed on the numeric GitHub id.

- **Invite-only (the default, `OPEN_ADMISSION=false`).** Everyone except admins needs an unused
  invite code.
- **Open admission (`OPEN_ADMISSION=true`, or the admin override).** GitHub accounts at least
  `MIN_GITHUB_ACCOUNT_AGE_DAYS` (30) old get in without a code. Younger accounts still need one.
- **`MAX_ACTIVE_USERS` applies only while invite-only** (admins aren't counted). With open
  admission there is no cap on people: everyone old enough gets an account at once, and the
  [queue](#the-queue-for-free-tokens) keeps free spend inside the weekly budget instead. So
  turning `openAdmission` on is the one switch for open sign-up; the smoke-test cap (20) needs no
  change.
- In both modes, a device that already holds another account's grant is refused, and each
  network gets 3 new accounts a day.

## API contract for the open launch

Autopilot and dl.new build against these shapes. Fields may be added; none are removed.

### `GET /v1/me`

```jsonc
{
  "login": "alice", "githubId": 123, "status": "active",
  "allowance": { "tokensPerWeek": 60000000, "usedThisWeek": 0, "remaining": 60000000,
                 "resetsAt": "2026-11-09T00:00:00.000Z", "usdPerWeek": 6, "spentUsdThisWeek": 0 },
  "models": ["deepseek/deepseek-v4.1-flash-1017"],
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
(once per balance), and Luminal failing more than 20% of at least 20 requests over the last hour
(429, 5xx, timeouts, unreachable, failed streams; once, until it recovers). Messages:

```
dl free tier: $200 of the $250 weekly cap used (80%). Resets Mon 00:00 UTC.
dl free tier: $500 of the $1,000 all-time cap used (50%). It doesn't reset; free tokens stop at 100% unless the cap is raised.
dl free tier: free tokens paused for everyone by <login> (kill switch).
dl free tier: the queue started ($200 of the $250 weekly cap used). New sign-ups wait in line for free tokens until Monday's admission.
dl free tier: OpenRouter host <slug> failed 9 of 40 requests in the last hour (23%). New requests avoid it while it keeps failing.
dl free tier: $1,600 of the $2,000 Luminal credit used (80%).
dl free tier: requests are refused with upstream_credit_exhausted: $2,000.12 of the $2,000 Luminal credit is used. Top up and raise luminalCreditUsd (POST /admin/config), or switch primaryUpstream to "openrouter".
dl free tier: Luminal failed 5 of 20 requests in the last hour (25%). Clients retry on their own; nothing switches upstream automatically.
```

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
| `invite_required` | `POST /v1/device/token` | `reason` |
| `cohort_full` | `POST /v1/device/token` | `reason` |
| `too_many_signups` | `POST /v1/device/token` | `reason` |
| `access_denied` | `POST /v1/device/token` | `reason: "device_taken"` when the device holds another account's grant |
| `service_paused` | device code, device token, chat | `reason: "paused"`, `pausedForEveryone: true`, `resetsAt: null` |
| `global_weekly_budget_reached` | chat (503) | `reason: "weekly_budget"`, `pausedForEveryone: true`, `resetsAt` (ISO time), `Retry-After` header |
| `global_total_budget_reached` | chat (503) | `reason: "total_budget"`, `pausedForEveryone: true`, `resetsAt: null` |
| `quota_exceeded` | chat (402) | `reason: "tokens" \| "spend"`, `resetsAt`, `offers`, `referralLink` |
| `free_tier_queued` | chat (402) | `position`, `etaAt`, `offers`, `referralLink` |
| `upstream_credit_exhausted` | chat (503) | `reason: "credit_exhausted"`, `pausedForEveryone: true`, `resetsAt: null` |
| `upstream_busy` | chat (429, `Retry-After`) | `retryAfter`, `retryable: true`, `upstream: "luminal"` |
| `upstream_unavailable` | chat (503, `Retry-After`) | `retryAfter`, `retryable: true`, `upstream: "luminal"` |
| `upstream_timeout` | chat (503, `Retry-After`) | `retryAfter`, `retryable: true`, `upstream: "luminal"` |
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
| `maxActiveUsers` | `MAX_ACTIVE_USERS` (invite-only only) | 50 |
| `openAdmission` | `OPEN_ADMISSION` | false |
| `cachedTokenWeight` | `CACHED_TOKEN_WEIGHT` | 0.02 |
| `queueThreshold` | `QUEUE_THRESHOLD` | 0.8 |
| `queueReferralPlaces` | `QUEUE_REFERRAL_PLACES` | 25 |
| `referralBonusTokens` | `REFERRAL_BONUS_TOKENS` | 10,000,000 |
| `referralBonusCap` | `REFERRAL_BONUS_CAP` | 50,000,000 |
| `primaryUpstream` | `PRIMARY_UPSTREAM` | `luminal` (`openrouter` is the manual switch) |
| `luminalCreditUsd` | `LUMINAL_CREDIT_USD` | 2000 |
| `luminalWeeklyCreditUsd` | `LUMINAL_WEEKLY_CREDIT_USD` | 250; `none` for no weekly credit budget |
| `luminalFirstByteTimeoutSeconds` | `LUMINAL_FIRST_BYTE_TIMEOUT_SECONDS` | 30 |

Env only: `REFERRAL_LINK_BASE` (`https://dl.new/r/`), the offers above, `ALERT_EMAIL_TO`,
`ALERT_EMAIL_FROM` (`alerts@dl.new`), `ALERT_WEBHOOK_URL`, `ALERT_WEBHOOK_KIND`,
`ALERT_TELEGRAM_CHAT_ID`, the prices `LUMINAL_PRICE_INPUT`, `LUMINAL_PRICE_CACHED`,
`LUMINAL_PRICE_OUTPUT`, `OPENROUTER_PRICE_INPUT`, `OPENROUTER_PRICE_CACHED`,
`OPENROUTER_PRICE_OUTPUT`, and the secret `LUMINAL_API_KEY`.

```sh
# Read the effective values, the env values, the overrides and the change log
curl -H "authorization: Bearer $ADMIN_TOKEN" https://free.example.com/admin/config

# Set values. null goes back to the env value; USD caps also take "none" (no cap).
curl -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"weeklyTokens": 60000000, "globalWeeklyUsdCap": 300, "openAdmission": null}' \
  https://free.example.com/admin/config
```

## What counts against the weekly allowance

```
charged = uncached prompt tokens + completion tokens + ceil(cached prompt tokens × cachedTokenWeight)
```

The default weight of 0.02 is OpenRouter's cache-read price divided by its input price for
`deepseek/deepseek-v4.1-flash-1017`: $0.006/M over $0.30/M, as listed on 2026-11-03.
`COUNT_CACHED_TOKENS=false` still works and means a weight of 0, unless `CACHED_TOKEN_WEIGHT`
is set. The global USD caps count only real cash: the cost OpenRouter reports. The per-person
dollar allowance counts every request: OpenRouter's reported cost, or a Luminal request's tokens
at OpenRouter's list prices (see below).

## Upstreams: Luminal and OpenRouter

Chat requests go to one upstream, the runtime setting `primaryUpstream`:

- **`luminal`** (the default): `https://flash.luminal.cloud/v1/chat/completions` with
  `LUMINAL_API_KEY`, model `deepseek-ai/DeepSeek-V4.1-Flash-1017`. The request is the client's,
  with `max_completion_tokens` set to the reserved output cap, `stream_options.include_usage` on
  streams, OpenRouter's `reasoning: {effort}` sent as `reasoning_effort`, and OpenRouter-only
  fields (`provider`, `usage`, `models`, `route`, `transforms`, `plugins`, `session_id`,
  `max_tokens`) removed. Free, Pro and admin requests all go there.
- **`openrouter`**: the OpenRouter request below, unchanged, with its filters and host avoidance.
  This is a manual switch (`POST /admin/config {"primaryUpstream": "openrouter"}`).

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
  upstreams. The $5 a week is charged a Luminal request's cost **at OpenRouter's list prices**
  (`OPENROUTER_PRICE_INPUT` 0.30, `OPENROUTER_PRICE_CACHED` 0.006, `OPENROUTER_PRICE_OUTPUT`
  1.20), not at Luminal's. So a person's week ends at the same point whichever upstream served
  them, and switching upstreams (or Luminal changing prices) doesn't change what the free tier
  gives. The output price is an estimate (Luminal's output price scaled by the same ~2.1× as its
  input and cache prices); check it against OpenRouter's model list and set
  `OPENROUTER_PRICE_OUTPUT` if it differs.
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
  - **Errors:** a wrong or revoked key gets 401 `invalid_key`. Signing out leaves keys working.
  - **Admin view:** `/admin/people` shows how many keys each person has, never the keys.

A per-person grant (`POST /admin/people/:id/grant`) still wins over the weekly defaults. The kill
switch is `POST /admin/pause` and `/admin/unpause`; `PAUSED=true` in env pauses as well.

## Admin dashboard

`GET /admin` is a server-rendered page for admins: weekly active developers (3+ days and any
day, last 8 weeks), cohort retention (weeks 1, 2 and 4 after sign-up), cost per person per week
(total, median, mean, and the top 10 of any week), who reached their token or dollar allowance
this week and last (and on which day), and global spend against the effective caps with the
pause and admission state. Each table has a CSV at `/admin/dashboard/<table>.csv`
(`spend`, `weekly-active`, `retention`, `weekly-cost`, `top-cost?week=YYYY-MM-DD`, `limits`,
`queue`, `referrals`, `funnel`, `paid`, `upstreams`).

At the top: a red banner when free spend is at 80% or more of either cap, and the all-time spend
against the all-time cap ($1,000). Then the queue (waiting now, the longest wait, how many this
Monday let in and the forecast behind it), referrals (links used, sign-ups via referral, how many
became weekly active, bonus tokens a week granted this week), paid plans (active Pro
subscribers, top-ups this week and month, revenue before tax this week and month, and what paid
usage cost upstream), and the funnel per sign-up week
and in all (sign-ups → first request → weekly active). Counts only, no content.

**Upstreams** (after global spend): the Luminal credit gauge (used against `luminalCreditUsd`),
this week's free credit against the weekly credit budget, which upstream is serving, and per
upstream for today and this week: requests, errors, median and p90 time to first token, median
time to first byte, cache-hit share (cached over prompt tokens), credit and cash. These count
admin requests too, since they measure the upstream. The red banner also shows at 80% of the
credit. CSV: `upstreams`.

- **Admins are left out of every number:** anyone in `ADMIN_GITHUB_IDS` and anyone admitted as
  an admin.
- **What it reads:** only `daily_activity`, a per-person per-day roll-up of request and event
  counts, charged tokens and cost, plus GitHub logins, sign-up times, per-person grants and the
  spend totals, and for the launch sections the queue (ids and times), the Monday runs (counts
  and the forecast) and referrals (ids, time and outcome), and for the upstreams `upstream_daily`
  and `upstream_timings` (counts, tokens, dollars and milliseconds per upstream, no person). No model, event type or properties,
  session ids, prompts or code. A test runs
  the dashboard under an SQLite authorizer that allows only those columns.
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
