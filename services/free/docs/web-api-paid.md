# dl.new paid launch: the web API (contract)

Status: draft for the 1 Dec 2026 launch. Part A (accounts, Stripe, keys, cli-login, usage
read-out) implements this file; part B (plan limits, metering, fallback, warnings, GPT-6 bonus,
free cutoff) fills the fields marked **[B]**. Open questions are at the end; add yours there.

## Basics

- **Base URL**: the free service, `SERVICE = https://free.directionallylocal.com` (the dl.new
  pages already call it directly). Every path below is relative to it.
- **CORS**: `/web/*` answers only `https://dl.new` and `https://api.dl.new` (WEB_SIGNUP_URL's and
  WEB_API_URL's origins). Methods `GET, POST, PUT, DELETE, OPTIONS`; headers `authorization,
  content-type`. A request with another `Origin` is 403 `forbidden_origin`.
- **JSON** in and out. Every response is `cache-control: no-store`.
- **Errors**: `{"error": {"code": "<code>", "message": "<one sentence for the person>", ...extra}}`
  with the HTTP status. The page shows `message` as is. `429 rate_limited` always carries
  `retryAfter` (seconds) and a `retry-after` header.
- **Web session** (the "web token"): a bearer JWT (`Authorization: Bearer <token>`), returned by
  every sign-in endpoint below. It lives **7 days** (`expiresIn` seconds in the response); the page
  keeps it in `localStorage` and sends it on every `/web/*` call that needs an account. 401
  `invalid_token` means "sign in again" (expired, signed out, or the account was blocked).
  Old GitHub web sessions (1 hour, from `/web/session`) keep working on the old endpoints.
- **Ids**: `accountId` is `acct_<base36>`, opaque to the page. Accounts made before the paid
  launch keep working; their GitHub sign-in is now one *identity* of the account.
- **Times** are ISO 8601 UTC strings. **Money** is USD with cents (`7`, `20`, `60`).
- **Plans**: `"starter" | "plus" | "max"`. A plan id never changes meaning; prices live in Stripe.

## 1. Plans and checkout (no account yet)

### GET /web/plans

No auth. What the plan cards show.

```json
{
  "plans": [
    {
      "id": "starter", "name": "dl.new Starter", "priceUsd": 7, "interval": "month",
      "models": [
        {"id": "deepseek/deepseek-v4.1-flash-1017", "name": "DeepSeek V4.1 Flash",
         "tokensPerWeek": 62000000, "countedTokensPerWeek": 3974200}
      ]
    },
    {"id": "plus", "name": "dl.new Plus", "priceUsd": 20, "interval": "month", "models": [ ... ]},
    {"id": "max",  "name": "dl.new Max",  "priceUsd": 60, "interval": "month", "models": [ ... ]}
  ],
  "caching": {"assumedCachedShare": 0.955, "label": "(95.5% caching applied)",
              "cachedTokenWeight": 0.02, "realToCounted": 0.0641},
  "refundDays": 7,
  "available": true
}
```

- `tokensPerWeek` is **real** tokens at the assumed caching mix (what the page shows, always with
  `caching.label`); `countedTokensPerWeek` is what is enforced **[B]**. Both come from
  `src/plans.ts` (one table, part B owns the numbers).
- `available: false` while STRIPE_SECRET_KEY or a plan's price id is missing: show the cards but
  disable the button.

### POST /web/checkout/plan {plan, campaign?}

No auth. Starts Stripe Checkout for a plan. → `200 {"url": "https://checkout.stripe.com/...", "sessionId": "cs_..."}`; the page sets `location = url`.

- Subscription mode, the plan's Stripe Price (STRIPE_PRICE_STARTER / _PLUS / _MAX), quantity 1,
  promotion codes off, Radar on (Stripe default), Stripe Tax as dl Pro has it.
- `success_url = https://dl.new/account?session_id={CHECKOUT_SESSION_ID}`,
  `cancel_url = https://dl.new/?plan=<plan>` (back to the plan step with the card selected).
- `campaign` (optional): the first-touch link tags, as `/v1/telemetry/web` takes them.
- Errors: 400 `invalid_plan`; 503 `billing_unavailable`; 502 `billing_error`; 429 `rate_limited`
  (20 an hour per network).

### GET /web/checkout/:sessionId

No auth: the Checkout Session id is the secret (it is in the success URL and the claim email).
What dl.new/account shows before the account step.

```json
{"sessionId": "cs_...", "status": "paid", "plan": "starter", "emailHint": "a•••@gmail.com",
 "claimable": true, "claimBy": "2026-12-08T10:00:00.000Z"}
```

- `status`: `"paid"` (waiting for an account), `"claimed"` (already linked: sign in instead),
  `"unpaid"` (Checkout not finished: back to the plan step), `"expired"` (older than 7 days
  unclaimed: contact support; the admin list has it).
- Errors: 404 `checkout_not_found` (unknown, or not a dl.new plan checkout).

## 2. Sign-up and sign-in

An account is created **only** with a paid, unclaimed checkout (`sessionId`), except that a
GitHub account that already used the free tier is an account already. With `sessionId`, the
sign-in also **claims** the checkout: the Stripe customer and subscription are linked to the
account, the Stripe customer's email is set to the verified email, and the plan starts.

Every sign-in endpoint answers the same **session response**:

```json
{
  "token": "<web token>", "expiresIn": 604800,
  "account": { ...GET /web/account's body... },
  "created": true,
  "claimed": {"plan": "starter", "sessionId": "cs_..."}
}
```

`claimed` is null when nothing was claimed. Errors common to all of them:

| status | code | when |
|---|---|---|
| 403 | `no_account` | no account for this email/GitHub and no `sessionId`: "Pick a plan at dl.new first." |
| 404 | `checkout_not_found` | `sessionId` unknown or not a plan checkout |
| 409 | `checkout_claimed` | `sessionId` already linked to another account |
| 410 | `checkout_expired` | unclaimed for more than 7 days |
| 402 | `checkout_unpaid` | Checkout not paid |
| 409 | `already_subscribed` | the account already has an active plan; the new checkout stays unclaimed (support refunds it) |
| 403 | `blocked` | the account is blocked |

### Email (6-digit code)

**POST /web/auth/email/start {email, sessionId?}** → `200 {"sent": true, "resendAfter": 30, "expiresIn": 600}`

- Sends a 6-digit code to `email` (from the user-email sender, no unsubscribe header). One live
  code per address; a new send replaces it.
- Without `sessionId`, the address must belong to an account (sign-in): else 403 `no_account`.
- Errors: 400 `invalid_email`; 400 `email_disposable` (the vendored disposable-domain list or the
  admin blocklist); 429 `resend_too_soon` (`retryAfter`, under 30 s since the last code to this
  address); 429 `rate_limited` (per address: 5 an hour; per network: 20 an hour); 503
  `email_unavailable` (no email transport configured).

**POST /web/auth/email/verify {email, code, sessionId?}** → the session response.

- Codes expire after 10 minutes and allow 5 wrong tries, then the code is dead.
- Errors: 400 `invalid_code` (`attemptsLeft`); 400 `code_expired` (also after 5 wrong tries:
  ask for a new code); plus the common ones.

### GitHub (verified primary email)

**GET /web/auth/github?return=<page>&state=<random>** (a browser navigation, not fetch)

- `return`: `https://dl.new/account`, `https://dl.new/signin` or `https://dl.new/cli-login`
  (exact match; anything else is a 400 page). `state`: the page's own random value, 16–128 of
  `[A-Za-z0-9_-]`, kept in `sessionStorage`.
- Redirects to GitHub with scope `user:email`. On return the service reads the **primary,
  verified** email (`/user/emails`); without one the page gets `#error=github_no_verified_email`.
- Ends with `303 <return>#signin=<one-time code>` (or `#error=<code>`; codes: `github_cancelled`,
  `github_failed`, `github_no_verified_email`, `expired`).

**POST /web/auth/github/session {code, state, sessionId?}** → the session response.

- `code` from the fragment, `state` the page's. The one-time code lives 5 minutes.
- An existing free-tier GitHub account signs straight in (its identity is linked on first use).
- Errors: 400 `invalid_grant`; plus the common ones.

### POST /web/checkout/claim {sessionId} (web token)

For someone already signed in who paid again (e.g. after cancelling): claims onto the signed-in
account. → `200 {"claimed": {"plan": "plus", "sessionId": "cs_..."}, "account": {...}}`.
Errors: the common ones.

### POST /web/signout (web token) → `200 {"signedOut": true}`

Ends this web session at once (the token stops working).

## 3. The account

### GET /web/account (web token)

```json
{
  "accountId": "acct_2fq0x9",
  "email": "ana@example.com",
  "identities": [{"kind": "github", "login": "ana"}, {"kind": "email", "email": "ana@example.com"}],
  "plan": {
    "id": "starter", "name": "dl.new Starter", "priceUsd": 7,
    "status": "active",
    "periodEnd": "2026-12-31T10:00:00.000Z", "cancelAtPeriodEnd": false,
    "paymentFailed": false,
    "refundableUntil": "2026-12-08T10:00:00.000Z"
  },
  "legacy": null,
  "settings": {"fallback": true},
  "limits": null,
  "gpt6Bonus": null,
  "upgrade": [{"plan": "plus", "priceUsd": 20}, {"plan": "max", "priceUsd": 60}]
}
```

- `plan` is null without a subscription. `status`: `"active"`, `"past_due"` (a renewal failed;
  Stripe retries per its dunning settings and the plan keeps working meanwhile), `"canceled"`.
- `legacy`: for accounts from before the paid launch: `{"plan": "free" | "pro"}` (dl Pro's
  subscribers). Part B decides what they get after 8 Dec.
- `limits` **[B]**: one entry per model of the plan, the bar data:
  `[{"model", "name", "tokensPerWeek", "countedTokensPerWeek", "countedUsed", "realUsed",
  "cachingShare", "percent", "resetsAt", "state": "ok" | "warning" | "used_up"}]`.
- `gpt6Bonus` **[B]**: `{"usdPerWeek": 2, "usedUsd": 0.8, "leftUsd": 1.2, "resetsAt",
  "until": "2027-01-31", "label": "launch bonus, through 31 Jan 2027"}` or null.
- `refundableUntil`: 7 days after the first payment; null once past or refunded.

### POST /web/account/email {email} (web token) → `200 {"sent": true, "resendAfter": 30, "expiresIn": 600}`

Starts a contact-email change: a code goes to the **new** address. Same checks and errors as
`/web/auth/email/start`, plus 409 `email_in_use` (another account signs in with it).

### POST /web/account/email/verify {email, code} (web token) → `200 {"email": "new@example.com"}`

Sets the contact email, moves the account's email sign-in to it, and updates the Stripe
customer's email. Errors as `/web/auth/email/verify`.

### GET /web/settings, PUT /web/settings {fallback} (web token)

`{"fallback": true}`: at a model's weekly limit, requests move to DeepSeek V4.1 Flash while it
has allowance (default on). `false`: a clear limit error instead. Stored on the account
(`AccountObject.settings()`); part B reads it **[B]**.

## 4. API keys (`dl_sk_`)

Keys belong to the account (not to a GitHub id): `dl_sk_<account>_<id>_<secret>`. Only the
secret's SHA-256 is stored, so **the secret exists once, in the create response** ("reveal once");
the page keeps it in memory/`sessionStorage` for Reveal/Copy and shows `dl_sk_…<last4>` after.
Old `dlk_` keys keep working unchanged.

- **GET /web/api-keys** → `{"keys": [{"id", "name", "kind": "tool", "format": "dl_sk", "hint": "dl_sk_…a1b2", "createdAt", "lastUsedAt", "lastTool"}], "max": 10}`
  (`max`: 10 with a plan, the free tier's tool key limit otherwise; older `dlk_` tool keys are listed too, `format: "dlk"`, `hint: "dlk_…"`).
  (`lastTool`: a short tool name from the User-Agent, e.g. `"claude-code"`, `"opencode"`, `"cline"`; null when unused).
- **POST /web/api-keys {name?}** → `201 {"id", "name", "kind", "format", "key": "dl_sk_...", "hint", "createdAt", "lastUsedAt": null, "lastTool": null}`.
  `name` defaults to `"key N"`. Errors: 409 `key_limit_reached` (`max`), 409 `key_name_taken`,
  400 `invalid_name`, 403 `suspended` / `blocked`.
- **DELETE /web/api-keys/:id** → `{"id", "revoked": true}`; 404 `key_not_found`. Revoked keys
  stop at once.

A `dl_sk_` key is the bearer (or `x-api-key`) on `https://api.dl.new/v1/chat/completions`,
`/v1/models`, `/v1/me` and `/anthropic/v1/messages`, served like a tool key (not `/v1/events`).
While the account has a plan it works even with the free tier's `toolKeys` switch off. What it
may use is the account's plan **[B]**. A bad or revoked key is 401 `invalid_key`.

## 5. Billing

- **POST /web/billing/portal** (web token) → `{"url"}`: Stripe's Customer Portal, returning to
  `https://dl.new/billing`. 404 `no_billing_account`.
- **POST /web/billing/upgrade {plan}** (web token) → `200 {"plan": "plus", "status": "upgraded", "amountDueUsd": 13.0}`.
  Moves the subscription to the higher plan now, prorated, invoiced at once
  (`proration_behavior=always_invoice`, `payment_behavior=error_if_incomplete`). The page reloads
  `/web/account` (the webhook confirms within seconds). Errors: 404 `no_subscription`; 400
  `not_an_upgrade` (same or lower plan: use the portal); 402 `payment_failed` (card declined;
  nothing changed); 503/502 as above.
- **POST /web/billing/refund-request {reason?}** (web token) → `200 {"requested": true, "eligible": true, "deadline"}`.
  Records the request and alerts the owner; within 7 days of the first payment the owner refunds
  it (admin endpoint below). `eligible: false` past the deadline (still recorded). 404
  `no_subscription`.
- `dl.new/upgrade` (the link in limit errors) is a page: signed in, it calls `/web/billing/upgrade`
  with the next plan after a confirm; signed out, it goes to sign-in first.

## 6. cli-login (`dl claude` signs in with the browser)

Device-code style; the CLI never sees a password or pastes a key.

1. **POST /v1/cli-login/start {tool?, deviceName?}** (no auth, from the CLI) →
   `{"loginId": "<secret>", "userCode": "WXYZ-2345", "verificationUri": "https://dl.new/cli-login?code=WXYZ-2345", "interval": 2, "expiresIn": 600}`.
   `tool`: `"claude-code"` (default), `"opencode"`, `"cursor"`…; `deviceName`: the host name,
   ≤ 64 chars. The CLI opens `verificationUri` and polls.
2. **GET /web/cli-login/:userCode** (web token) → `{"userCode", "tool", "deviceName", "createdAt", "expiresAt", "status": "pending" | "approved" | "denied" | "expired"}`.
   The page shows "Sign in dl claude on <deviceName>?" with Approve / Deny. Signed out, the page
   signs in first (GitHub `return=https://dl.new/cli-login` keeps `?code=` in `sessionStorage`).
3. **POST /web/cli-login/:userCode/approve** or **/deny** (web token) → `{"status": "approved"}`.
   An account made on dl.new needs an active plan to approve (403 `no_plan`, with the plan page's
   URL). Accounts from before the launch may approve; what their key may use is part B's cutoff.
4. **POST /v1/cli-login/poll {loginId}** (CLI), every `interval` seconds →
   - `428 {"error": {"code": "authorization_pending"}}` while waiting,
   - `429 slow_down` when polled faster than the interval,
   - `403 access_denied` after Deny, `410 expired_token` after 10 minutes,
   - `200 {"key": "dl_sk_...", "keyId", "accountId", "plan": "starter", "baseUrl": "https://api.dl.new", "anthropicBaseUrl": "https://api.dl.new/anthropic"}` once.
   The key is a normal `dl_sk_` key named `"dl claude on <deviceName>"`, listed and revocable
   on dl.new/keys. The poll that returns it consumes the login (a second poll is `410`).

## 7. Usage

### GET /web/usage?week=<YYYY-MM-DD Monday> (web token; default this week)

```json
{
  "week": {"start": "2026-11-30T00:00:00.000Z", "resetsAt": "2026-12-07T00:00:00.000Z"},
  "totals": {"requests": 412, "realTokens": 19600000, "countedTokens": 1254000,
             "cachedInput": 18700000, "cachedCountedAs": 374000,
             "freshInput": 760000, "output": 140000, "cachingShare": 0.957,
             "realToCounted": 0.064, "failovers": 3},
  "models": [{"model": "deepseek/deepseek-v4.1-flash-1017", "name": "DeepSeek V4.1 Flash",
              "requests": 400, "cachedInput": 0, "freshInput": 0, "output": 0,
              "realTokens": 0, "countedTokens": 0, "cachingShare": 0.957,
              "limit": null}],
  "days": [{"day": "2026-11-30", "countedTokens": 210000, "realTokens": 3300000, "requests": 70}],
  "tools": [{"tool": "claude-code", "requests": 300, "countedTokens": 900000, "realTokens": 14000000}],
  "cachedTokenWeight": 0.02
}
```

- Counted = cached × `cachedTokenWeight` + fresh input + output (the live config's weight;
  0.02 today). `realToCounted` = counted / real.
- `failovers`: attempts an upstream failed (rate limit, error, timeout) that were retried on
  another provider this week.
- `models[].limit` **[B]**: the same object as `/web/account` `limits[]`, or null.
- `tools[].tool`: `"autopilot"`, `"claude-code"`, `"opencode"`, `"pi"`, or the tool key's tool
  (`"cursor"`, `"cline"`…), `"other"` when unknown.
- Read from the request log, which keeps `rawLogKeepDays` (35 days by default): older weeks answer
  400 `week_unavailable`; `?week=` must be a Monday (400 `invalid_week`).
- `models[].limit` and the bars' numbers come from part B; until then `limit` is null.

### GET /web/usage/live?after=<id> (web token): the connect page's live box

Polling, every 2 seconds (no SSE: one cheap Directory read; works through every proxy).

```json
{"connected": true, "firstRequestAt": "2026-12-01T10:02:11.000Z", "cursor": 1842,
 "requests": [{"id": 1842, "at": "...", "model": "deepseek/deepseek-v4.1-flash-1017",
               "tool": "claude-code", "cachedInput": 18204, "freshInput": 312, "output": 96,
               "countedTokens": 772, "latencyMs": 1830, "status": "ok", "fallback": null}],
 "line": "The 2nd request reused cached context, so 18,204 tokens counted as 364."}
```

- `requests`: newest first, at most 5, only ids greater than `after` (omit it on the first call).
  Pass the returned `cursor` as `after` next time. `connected` is false until the first request.
- `line`: the caching sentence for the box, from the first request with cached input, else null.
- Stop polling once connected and the page shows enough (or after 10 minutes).

## 8. Admin (admin bearer, as the other /admin endpoints)

- **GET /admin/paid/checkouts?status=unclaimed|claimed|all** → `{"checkouts": [{"sessionId", "plan", "email", "customerId", "subscriptionId", "amountCents", "paidAt", "claimedBy": "acct_…" | null, "claimedAt", "claimEmailSentAt", "expired"}]}`.
- **POST /admin/paid/refund {accountId | sessionId}** → refunds the first payment in full and
  cancels the subscription now. `{"refunded": true, "amountCents", "refundId", "subscriptionCanceled": true}`.
  409 `refund_window_passed` after 7 days (send `{"force": true}` to refund anyway); 404
  `no_subscription`; 409 `already_refunded`.
- **GET /admin/paid/refund-requests** → `{"requests": [{"accountId", "email", "reason", "at", "eligible", "refundedAt"}]}`.

## 9. Stripe webhooks (POST /v1/billing/webhook, existing endpoint)

| event | what happens |
|---|---|
| `checkout.session.completed` (metadata `product=plan`) | stores the paid session (unclaimed unless an account already claimed it), sends the "Finish setting up dl.new" email to the Checkout email with `https://dl.new/account?session_id=…` (works 7 days) |
| `invoice.paid` | plan active until the invoice period's end; records the payment (first one starts the 7-day refund window) |
| `invoice.payment_failed` | `paymentFailed: true`, status `past_due`; the plan keeps working while Stripe retries (Stripe's dunning) |
| `customer.subscription.updated` | plan id from the subscription item's price; status; cancel at period end |
| `customer.subscription.deleted` | plan ends (status `canceled`): the keys stay but requests get part B's "no plan" error |

Unclaimed sessions get plan changes recorded on the session row and applied when claimed.

## For part B (how to read the account)

- **An account made on dl.new (number ≥ 2^50) with no active plan must get nothing.** Today such
  an account falls back to the free tier's rules (and, admitted after `trialCutoff`, the trial):
  the free cutoff should refuse it with "dl.new is paid now. Pick a plan at dl.new to keep going."
- People rows of dl.new accounts: `admitted_via = 'paid'`, `level = 'full'`, `level_reason` NULL,
  `login = acct_…`, the verified email with `email_updates = 0`. The free tier's lifecycle emails
  (welcome, "didn't start", weekly reset, win-back) should skip `admitted_via = 'paid'`.

- The account number is what `githubId` holds everywhere in the service today (`Caller.githubId`,
  `requests.github_id`, `people.github_id`, the Account object). For accounts from before the
  launch it **is** the GitHub id; new accounts get numbers from 2^50 up (`accounts.ts`
  `isPaidAccountNumber`). No meter needs to change its key.
- `AccountObject.billing()` adds `tier: "starter" | "plus" | "max" | null` (null: legacy dl Pro or
  none) and `paymentFailed`. `AccountObject.paidPlan(now)` → the tier while the subscription
  is active or past due (within its period plus grace), else null.
- `AccountObject.settings()` → `{fallback: boolean}`.
- `plan` (`"free" | "pro"`) keeps its meaning for the old code: any active subscription, tier or
  legacy, is `"pro"` there until part B switches limits to tiers.
- Plan catalog: `src/plans.ts` (`PLANS`, per-model `tokensPerWeek`), edited by part B.

## Open questions

1. **Tax**: dl Pro used Stripe Tax with exclusive prices (tax added on top where it applies).
   Keep that for $7/$20/$60, or make the prices tax-inclusive? (Code follows the Price's
   `tax_behavior`; the PR body lists `exclusive`.)
2. **Sign-in leak**: `/web/auth/email/start` without `sessionId` says `no_account` for unknown
   addresses (better UX, but tells whether an address has an account). Fine?
3. **Legacy free accounts on cli-login** before 8 Dec **[B]**.
4. **Existing dl Pro subscribers** (`tier: null`): map to Starter limits? **[B]/owner**. Today a dl
   Pro subscriber who buys a plan gets 409 `already_subscribed` (two subscriptions would both
   bill); they'd cancel Pro first, or we move them over by hand.
5. **Email identity for legacy GitHub accounts**: a free GitHub user who later picks "Use email"
   with the same address gets a new, separate account (emails were never verified before). OK?
6. **Max plan cost** (spec note): 450M DeepSeek alone may exceed $30/month at list. Owner. **[B]**
