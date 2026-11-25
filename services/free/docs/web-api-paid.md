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
      "description": "DeepSeek V4.1 Flash ~62M/week (95.5% caching applied). Weekly limits reset Mon 00:00 UTC.",
      "models": [
        {"id": "deepseek/deepseek-v4.1-flash-1017", "name": "DeepSeek V4.1 Flash",
         "tokensPerWeek": 62000000, "approx": "~62M", "countedTokensPerWeek": 3974200,
         "text": "DeepSeek V4.1 Flash ~62M/week (95.5% caching applied)"}
      ]
    },
    {"id": "plus", "name": "dl.new Plus", "priceUsd": 20, "interval": "month", "models": [ ... ]},
    {"id": "max",  "name": "dl.new Max",  "priceUsd": 60, "interval": "month", "models": [ ... ]}
  ],
  "caching": {"assumedCachedShare": 0.955, "label": "(95.5% caching applied)",
              "cachedTokenWeight": 0.02, "realToCounted": 0.0641},
  "resets": "Mon 00:00 UTC",
  "promo": {"active": true, "percentOff": 50, "label": "first month, ends Mon 30 Nov",
            "endsAt": "2026-12-01T00:00:00.000Z"},
  "gpt6Bonus": {"enabled": false, "label": "launch bonus, through 31 Jan 2027",
                "line": "$2/week of GPT-6.1 Sol usage in dl", "weeklyUsd": 2, "fullyClaimed": false,
                "fullyClaimedText": "GPT-6 launch bonus: fully claimed", "endsAt": "2027-02-01T00:00:00.000Z"},
  "available": true
}
```

- `tokensPerWeek` is **real** tokens at the assumed caching mix (what the page shows, always with
  `caching.label`); `countedTokensPerWeek` is what is enforced. Both come from part B's
  `planCatalog()` (`plans.ts` `planLimits()`), so they follow the runtime settings
  `planTokens.<plan>.<model>` and the live `cachedTokenWeight`; prices and names are
  `plan-prices.ts`'s.
- `gpt6Bonus`: the launch bonus offer (`plan-usage.ts` `bonusOffer`); `fullyClaimed: true` → the
  card shows `fullyClaimedText`.
- `promo`: the launch offer (Black Friday 2026). `active: true` only while plan Checkouts get the
  coupon (runtime settings `promoCouponId`, `promoStartsAt` 2026-11-27T00:00:00Z inclusive,
  `promoEndsAt` 2026-12-01T00:00:00Z exclusive, `promoPercentOff` 50, `promoLabel`); otherwise
  `{"active": false, "percentOff": null, "label": null, "endsAt": null}`. Each plan then has
  `promoPriceUsd` (3.5 / 10 / 30 at 50%; null when inactive): the first month's price. A page
  shows a discount only when `promo.active` is true. `GET /v1/plans` carries the same `promo`
  and, per plan, `priceUsd` and `promoPriceUsd`.
- No refund line: no page or email promises a refund (refunds are the owner's call, below).
- `available: false` while STRIPE_SECRET_KEY or a plan's price id is missing: show the cards but
  disable the button.

### POST /web/checkout/plan {plan, campaign?}

No auth. Starts Stripe Checkout for a plan. → `200 {"url": "https://checkout.stripe.com/...", "sessionId": "cs_..."}`; the page sets `location = url`.

- Subscription mode, the plan's Stripe Price (STRIPE_PRICE_STARTER / _PLUS / _MAX), quantity 1,
  promotion codes off, Radar on (Stripe default), Stripe Tax as dl Pro has it.
- **Launch offer**: inside the `promo` window the session gets `discounts[0][coupon]=<promoCouponId>`
  (a Stripe coupon, duration "once": the first invoice only, renewals at full price) and
  `metadata[promo]`; `allow_promotion_codes` is left out then (Stripe takes one or the other),
  so no code can be typed either way. If Stripe refuses the coupon (not created, expired, used
  up), Checkout never fails: the session is created again without it, `promoCouponId` turns
  itself off (config change log, a warning, an alert to the owner, and `/web/plans` stops showing
  the offer), and the owner turns it back on with `POST /admin/config {"promoCouponId": "dlnew-bf-2026"}`.
  The completed session's discount (`total_details.amount_discount`, the coupon) is kept on the
  paid checkout (`promo` in the admin list) and drives the welcome email's offer line.
- `success_url = https://dl.new/account?session_id={CHECKOUT_SESSION_ID}`,
  `cancel_url = https://dl.new/?plan=<plan>` (back to the plan step with the card selected).
- `campaign` (optional): the first-touch link tags, as `/v1/telemetry/web` takes them.
- **Terms consent with the EU/UK withdrawal waiver** (runtime setting `checkoutTermsConsent`,
  default on): `consent_collection[terms_of_service]=required` and the checkbox text
  (`custom_text[terms_of_service_acceptance][message]`): "I want my dl.new plan to start right
  away and understand I lose my 14-day right to withdraw once it starts. [Terms](https://dl.new/terms)."
  Stripe requires a terms of service URL in the account's public details (Dashboard → Settings →
  Public details); without it Stripe refuses the session. Checkout never fails for that: the
  service starts it again without the consent and turns `checkoutTermsConsent` off (in the config
  change log, a warning in the logs, an alert to the owner); the owner turns it back on with
  `POST /admin/config {"checkoutTermsConsent": true}` once the URL is set. The time of the
  consent is kept on the paid checkout (`termsAcceptedAt` in the admin list).
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
    "paymentFailed": false
  },
  "legacy": null,
  "settings": {"fallback": true},
  "limits": [{"model": "deepseek/deepseek-v4.1-flash-1017", "name": "DeepSeek V4.1 Flash",
              "tokensPerWeek": 62000000, "countedTokensPerWeek": 3974200, "countedUsed": 1254000,
              "realUsed": 19600000, "usedAtPlanMix": 19564000, "cachingShare": 0.957, "percent": 31,
              "resetsAt": "2026-12-07T00:00:00.000Z", "state": "ok"}],
  "gpt6Bonus": null,
  "upgrade": [{"plan": "plus", "priceUsd": 20}, {"plan": "max", "priceUsd": 60}]
}
```

- `plan` is null without a subscription. `status`: `"active"`, `"past_due"` (a renewal failed;
  Stripe retries per its dunning settings and the plan keeps working meanwhile), `"canceled"`.
- `legacy`: for accounts from before the paid launch: `{"plan": "free" | "pro"}` (dl Pro's
  subscribers). Part B decides what they get after 8 Dec.
- `limits`: one entry per model of the plan, the bar data (part B's `planLimitsView`), or null
  without a plan: `[{"model", "name", "tokensPerWeek", "countedTokensPerWeek", "countedUsed",
  "realUsed", "usedAtPlanMix", "cachingShare", "percent", "resetsAt", "state": "ok" | "warning" |
  "used_up"}]`. `usedAtPlanMix` is the bar in real tokens at the plan mix ("19.6M of ~62M").
- `gpt6Bonus`: `{"usdPerWeek": 2, "usedUsd": 0.8, "leftUsd": 1.2, "resetsAt",
  "until": "2027-01-31", "label": "launch bonus, through 31 Jan 2027", "line"}` (part B's
  `bonusAccountView`) or null: the bonus is off, or the account doesn't hold it.
- The plan the account's requests are held to is this one: part B's `AccountObject.planState()`
  reads `paidPlan()` (billing's tier, from the webhooks and the claim). A dl Pro subscription
  from before the launch (no tier) is held to Starter's limits (open question 4).
- No refund fields: the page offers no refund. Cancelling is Stripe's Customer Portal (`POST
  /web/billing/portal`, cancel at period end).

### POST /web/account/email {email} (web token) → `200 {"sent": true, "resendAfter": 30, "expiresIn": 600}`

Starts a contact-email change: a code goes to the **new** address. Same checks and errors as
`/web/auth/email/start`, plus 409 `email_in_use` (another account signs in with it).

### POST /web/account/email/verify {email, code} (web token) → `200 {"email": "new@example.com"}`

Sets the contact email, moves the account's email sign-in to it, and updates the Stripe
customer's email. Errors as `/web/auth/email/verify`.

### GET /web/settings, PUT /web/settings {fallback} (web token)

`{"fallback": true}`: at a model's weekly limit, requests move to DeepSeek V4.1 Flash while it
has allowance (default on). `false`: a clear limit error instead. One store: meta
`plan_fallback` on the account, which `settings()`, part B's `planState()` and
`POST /v1/plan/fallback` all read and write.

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
- **POST /web/billing/refund-request {reason?}** (web token) → `200 {"requested": true, "eligible": true, "notEligible": null, "deadline"}`.
  No page links to it any more (no public refund promise); kept so a request from an old page
  still reaches the owner. Records the request and alerts the owner. Eligible: within 24 hours of the first payment
  (`refundWindowHours`) **and** no plan model at 100% of its weekly limit this week; the owner
  then refunds it (admin endpoint below). Otherwise `eligible: false` (still recorded) and
  `notEligible` says why: `"refund_not_eligible: weekly limit reached"` (with `limitsReached`,
  the models' names), `"refund_not_eligible: refund window passed"` or
  `"refund_not_eligible: already refunded"`. 404 `no_subscription`.
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
  "days": [{"day": "2026-11-30", "countedTokens": 210000, "realTokens": 3300000}],
  "tools": [{"tool": "claude-code", "requests": 300, "countedTokens": 900000, "realTokens": 14000000}],
  "plan": "starter", "plansEnforced": true,
  "gpt6Bonus": null,
  "cachedTokenWeight": 0.02
}
```

- Counted = cached × `cachedTokenWeight` + fresh input + output (the live config's weight;
  0.02 today). `realToCounted` = counted / real.
- `failovers`: requests a backup provider or a fallback model served (part B's meters: plan
  fallback Kimi → DeepSeek, bonus used up → DeepSeek, provider failover).
- `models[]`: the plan's models (always listed, with their bar) and any other model used that
  week. `models[].limit`: the same object as `/web/account` `limits[]` (this week only), or null.
- `gpt6Bonus`: this week's bonus `{usdPerWeek, usedUsd, leftUsd, label, line}` while the account
  holds it, else null.
- `tools[].tool`: `"autopilot"`, `"claude-code"`, `"opencode"`, `"pi"`, or the tool key's tool
  (`"cursor"`, `"cline"`…), `"other"` when unknown.
- Read from the account's per-model meters (part B's `planUsageFor`, `plan-meter.ts`), which keep
  this week and the four before it: older weeks answer 400 `week_unavailable`; `?week=` must be
  a Monday (400 `invalid_week`). The request log feeds only `/web/usage/live`. `days[]` has no
  request count (the meters count requests per model and per tool, not per day).

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

- **GET /admin/paid/checkouts?status=unclaimed|claimed|all** → `{"checkouts": [{"sessionId", "plan", "email", "customerId", "subscriptionId", "amountCents", "paidAt", "claimedBy": "acct_…" | null, "claimedAt", "claimEmailSentAt", "termsAcceptedAt", "expired"}]}`. `termsAcceptedAt`: when the customer accepted the terms with the withdrawal waiver at Checkout; null without that consent.
- **POST /admin/paid/refund {accountId | sessionId}** → refunds the first payment in full and
  cancels the subscription now. `{"refunded": true, "amountCents", "refundId", "subscriptionCanceled": true}`.
  409 `refund_window_passed` more than `refundWindowHours` (24) after the first payment; 409
  `refund_not_eligible` (`reason: "weekly limit reached"`, `limitsReached`) once a plan model's
  weekly limit is reached this week. `{"force": true}` refunds anyway in both cases. 404
  `no_subscription`; 409 `already_refunded`.
- **GET /admin/paid/refund-requests** → `{"requests": [{"accountId", "email", "reason", "at", "eligible", "notEligible", "refundedAt"}]}`; `notEligible` as the refund request answered it.

## 9. Stripe webhooks (POST /v1/billing/webhook, existing endpoint)

| event | what happens |
|---|---|
| `checkout.session.completed` (metadata `product=plan`) | stores the paid session (unclaimed unless an account already claimed it), sends the "Finish setting up dl.new" email to the Checkout email with `https://dl.new/account?session_id=…` (works 7 days) |
| `invoice.paid` | plan active until the invoice period's end; records the payment (first one starts the 24-hour refund window) |
| `invoice.payment_failed` | `paymentFailed: true`, status `past_due`; the plan keeps working while Stripe retries (Stripe's dunning) |
| `customer.subscription.updated` | plan id from the subscription item's price; status; cancel at period end |
| `customer.subscription.deleted` | plan ends (status `canceled`): the keys stay but requests get part B's "no plan" error |
| `customer.subscription.trial_will_end` | **new (trials)**: a trialing subscription eligible for the launch offer gets the coupon before its first real charge |

Unclaimed sessions get plan changes recorded on the session row and applied when claimed.

## 10. Free trials (trials.ts, trial-web.ts)

Sizes are **real tokens with 95.5% caching applied** (as the plan cards), enforced in counted
tokens with the plans' factor: 20M real = **1,282,000 counted**, 10M = **641,000** (at
`cachedTokenWeight` 0.02). Both trials serve **DeepSeek V4.1 Flash only**; any other model
falls back to it with a notice (`[dl.new] Kimi K3.1 starts when your plan starts. Now using
DeepSeek V4.1 Flash.` on a card trial whose plan has the model; `… isn't in the free trial.`
otherwise). Trial usage is shown in the week's usage but never counts against the plan's weekly
limits (`model_usage.trial_counted`).

**`GET /web/plans` and `/v1/plans`** add:

```json
"trials": {
  "card":   {"enabled": true, "available": true, "fullyClaimed": false, "tokens": 20000000, "countedTokens": 1282000, "days": 30,
             "line": "First 20M tokens free (95.5% caching applied). Card required; your plan starts when you've used them or after 30 days.",
             "fullyClaimedText": "Free trial: fully claimed"},
  "noCard": {"enabled": true, "available": true, "fullyClaimed": false, "tokens": 10000000, "countedTokens": 641000,
             "line": "No card? Get 10M tokens free (95.5% caching applied). Sign in with GitHub.",
             "fullyClaimedText": "Free trial: fully claimed"},
  "label": "(95.5% caching applied)"
}
```

`enabled`: the setting; `available`: enabled and the budget has room for one more full trial;
`fullyClaimed`: enabled but no room (show `fullyClaimedText`).

**Card trial.** `POST /web/checkout/plan` answers `trial: true` while `trials.card.available`:
the Checkout has `subscription_data[trial_period_days]=30`,
`subscription_data[trial_settings][end_behavior][missing_payment_method]=cancel`,
`payment_method_collection=always`, metadata `trial=card` and, inside the launch offer's window,
`promo_eligible=<coupon>` (session and subscription). **No coupon on the Checkout**: it would be
spent on the $0 trial invoice. Instead, inside the window, the line above the button
(`custom_text[submit][message]`) names the offer with the plan's prices: "Launch offer: your
first paid month is 50% off ($3.50 instead of $7). It's applied when your free 20M tokens are
used or after 30 days." (the terms consent text stays as it is). The completed session has `payment_status: no_payment_required`;
`GET /web/checkout/:id` says `status: "paid", trial: true`. The claim starts the trial meter
(`/web/account` `plan.trialing: true`, `plan.trialEndsAt`, and `trial`). The plan starts:

- when the trial's counted tokens are used: the service calls `POST /v1/subscriptions/:id`
  `trial_end=now`, `proration_behavior=none`, `payment_behavior=error_if_incomplete` and, when
  eligible, `discounts[0][coupon]` (the first real charge gets the 50%); a declined card is
  `402 trial_payment_failed` ("…Update your card at dl.new/billing…") and Stripe isn't asked
  again for 10 minutes; while Stripe is answering, `503 trial_converting` (retry-after 30);
- or by Stripe after 30 days; `customer.subscription.trial_will_end` (3 days before) puts the
  eligible coupon on the subscription first.

Either way `trial_converted` is emailed once ("your plan started: dl.new Plus, $20/mo. first month
50% off."), the GPT-6 launch bonus is granted, and Kimi/plan limits apply from then. One card
trial per account: a second trial Checkout on the same account gets 0 trial tokens (its plan
starts at once). A trial whose first real charge never succeeded never gets the plan while past
due.

**No-card trial.** The page sends the browser to `GET /web/auth/github?return=https://dl.new/trial&state=…`
(the callback reads the free tier's checks with the GitHub token), then
`POST /web/auth/github/session {code, state, trial: true}` → the session response plus
`trialStarted: true` for a new account. Refusals: `403 trial_unavailable` with `reason`:
`not_eligible` (below the free tier's bar, creation batch, network or domain sign-up limit,
disposable or blocked email), `used` (this GitHub account or verified email had one, or the
email belongs to another account), `fully_claimed`, `off`. A GitHub account that already has an
account (including a free-tier account from before the launch) just signs in: no trial, legacy
accounts keep their grace until `freeEndsAt`. Used up: `402 trial_used_up` "Your 10M free tokens
are used up. Pick a plan at dl.new to keep going." Buying a plan ends it.

**`trial` on `/web/account` and `/web/usage`** (null without one to show):

```json
{"kind": "card" | "no_card", "status": "active" | "used_up" | "ended", "plan": "plus" | null,
 "tokens": 20000000, "usedAtMix": 4100000, "leftAtMix": 15900000,
 "countedLimit": 1282000, "countedUsed": 262000, "countedLeft": 1020000, "percent": 20, "state": "ok" | "warning" | "used_up",
 "realUsed": 4250000, "cachedInput": 4050000, "freshInput": 170000, "output": 30000, "cachingShare": 0.96,
 "startedAt": "…", "endsAt": "…" | null, "daysLeft": 27 | null, "line": "Free trial: ~4.1M of 20M tokens used (95.5% caching applied). …"}
```

The bar is `usedAtMix` of `tokens` (counted used converted at the plan mix); `realUsed` is what
was actually sent and received.

**Notices and emails.** 80%: once per trial in the tool (`[dl.new] Free trial: 81% used (~16.2M of
20M at 95.5% caching). Your Starter plan starts at 20M, ~3.8M left.`) and, card trials only,
`trial_card_80`. Welcome: `welcome_trial_card` (when charging starts) or `welcome_trial_nocard`.
All four are transactional (the email budget's reserve) and exempt from one-a-day.

**Budgets** (runtime settings): `trialBudgetUsd` (300) for card trials, `noCardTrialBudgetUsd`
(200) for no-card trials: what trials actually cost (OpenRouter cash, else the provider's
credit) plus the rest of every active trial (card: not ended and before day 30; no-card: used or
started in the last 30 days) at `trialUsdPerMillionCounted` (0.30 until trials have used 20M
counted, then their measured rate). Full: new sign-ups don't get that trial. `GET /admin/paid/trials`
shows both budgets and the latest trials; `GET /admin/paid/checkouts` shows `trial`.

Settings: `cardTrial` (true), `cardTrialTokens` (20000000), `cardTrialDays` (30, 1 to 90),
`trialBudgetUsd` (300), `noCardTrial` (true), `noCardTrialTokens` (10000000),
`noCardTrialBudgetUsd` (200), `trialUsdPerMillionCounted` (0.3). Env: `CARD_TRIAL`,
`CARD_TRIAL_TOKENS`, `CARD_TRIAL_DAYS`, `TRIAL_BUDGET_USD`, `NO_CARD_TRIAL`,
`NO_CARD_TRIAL_TOKENS`, `NO_CARD_TRIAL_BUDGET_USD`, `TRIAL_USD_PER_MILLION_COUNTED`.

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
- Prices, names and Price ids: `plan-prices.ts` (part A). Limits: part B's `plans.ts`; `/web/plans`,
  Checkout's descriptions and the claim email switch to `planLimits()` once both are merged.
- Fallback: `AccountObject.settings()` / `setSettings({fallback})` use meta `plan_fallback`, the
  key part B's `setPlanFallback` writes.

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

## After both parts (the wiring PR)

- **Plan identity**: `AccountObject.planState()` takes the tier from `paidPlan()` (billing's
  tier), else part B's meta `plan_tier`, else Starter for a paying account without one (legacy
  dl Pro). A dl.new account (number from 2^50) with no active plan gets 402 `plan_required` on
  every request, before and after `freeEndsAt`.
- **GPT-6 launch bonus**: no wait after the first payment (`gpt6BonusDelayHours` 0). It is
  granted at the claim when it is on and a new subscriber fits the projection, so the welcome
  email can name it. A request the plan serves from the bonus skips the GPT-6 trust gate (paid =
  trusted for the bonus only); every other bonus condition stays (Autopilot only, the pre-send
  guard on `enforce`, safety identifiers, $2/week, the output cap, the credit-based projection,
  the end on 31 Jan 2027, never on cash). GPT-6 outside the bonus still needs trust.
- **Welcome email** (`welcome_paid`, user-emails.ts): on claim, once per payment: where the key
  is (dl.new/connect), `curl -fsSL dl.new | sh` then `dl claude`, other tools' base URL and
  dl.new/keys, dl.new/signin, each plan model's weekly limit with "(95.5% caching applied)", and
  the bonus line when the account holds it. No refund line. When the payment had the launch
  offer, the first line adds "Your first month was 50% off. It renews at $20/mo." (the percent
  Stripe took off, the plan's full price). The claim email ("Finish setting up dl.new") says
  "first month 50% off, then $20/month" for such a payment; its link works 7 days.
- **Email budget** (email-budget.ts): settings `userEmailsDailyMax` (300), of it
  `userEmailsTransactionalReserve` (100) kept for transactional mail (claim, paid welcome,
  plan_80, access answers); bulk and lifecycle mail (welcome_*, didnt_start, week_80, gone_quiet,
  weekly_reset, plan_reset, broadcasts) stop at 200. Codes never count against the daily max and
  have their own ceiling `emailCodesDailyMax` (300); past it `/web/auth/email/start` answers 503
  `email_unavailable`. Conservative: the provider's real daily quota isn't known.
- **Lifecycle emails**: the free tier's kinds and broadcasts never go to dl.new accounts; paying
  accounts get `plan_80` per model, never `week_80`.
- **Monday email to paying accounts** (`plan_reset`): "Your ~62M tokens reset." (the plan's
  first model's limit), last week per plan model (real tokens, caching, the counted math against
  the counted limit), sessions, failovers, dl.new/usage and dl.new/billing. Same window and
  switches as `weekly_reset` (`weeklyResetEmail`, `userEmails`), and only once `freeEndsAt` has
  passed (the first one is Mon 14 Dec 2026).
