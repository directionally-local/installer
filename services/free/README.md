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

| model id | provider | wire id | weekly dollar budget | weekly token pool | USD per Mtok (input / cached / output) |
|---|---|---|---|---|---|
| `gpt-6-luna` (default) | OpenAI | `gpt-6-luna` | GPT-6 | `luna`, 50M | 0.10 / 0.01 / 0.50 |
| `gpt-6.1-sol` | OpenAI | `gpt-6.1-sol` | GPT-6 | `sol`, 10M | 2 / 0.10 / 10 |
| `gpt-6-astra` | OpenAI | `gpt-6-astra` | GPT-6 | `astra`, 3M | 10 / 1 / 50 |
| `deepseek/deepseek-v4.1-flash-1017` | Luminal | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | DeepSeek | `deepseek`, no token cap | 0.035 / 0.006 / 0.315 |
| `moonshotai/kimi-k3.1-pro` (opt-in) | Liquid Inference | `kimi-k3.1-pro` | DeepSeek (open models) | `deepseek`, no token cap | 2.10 / 0.25 / 10.50 |
| `z-ai/glm-5.3` (defined, off) | Liquid Inference | `glm-5.3` | DeepSeek (open models) | `deepseek`, no token cap | 0.15 / 0.03 / 0.60 |

- **Two weekly dollar budgets.** Every person has a GPT-6 budget (all GPT-6 models together) and a
  DeepSeek budget. DeepSeek is much cheaper per token for us and fast, so we give far more of it:
  by default $2 of GPT-6 and $8 of DeepSeek a week on the free plan, $6 and $40 on Pro. Each
  request counts against its own model's budget only, held the same way (settled spend plus the
  estimates of that budget's requests in flight).
- **Token pools inside the budgets.** Luna, Sol and Astra keep their own weekly token pools (the
  dollar budget they share is usually what binds). DeepSeek has no token cap: its dollar budget is
  its only limit, so a token count never stops it first.
- **GPT-6 out, DeepSeek left.** A GPT-6 request past GPT-6's week gets 402 `gpt_limit` pointing at
  DeepSeek, not a dead end; with both weeks used up, the usual limit codes.
- **Fallback.** Every OpenAI model is served by OpenAI first. On a 429, a 5xx, a network error,
  no response before `OPENAI_FIRST_BYTE_TIMEOUT_SECONDS`, or OpenAI’s credit running out, the same
  request is retried once on DeepSeek/Luminal, and the response carries
  `x-dl-fallback: deepseek/deepseek-v4.1-flash-1017`. The requested model’s pool and budget pay
  for it (at DeepSeek’s prices), so someone who asks for Sol spends Sol’s allowance, not Luna’s. DeepSeek picked by hand goes
  straight to Luminal.
- **Separate credit pools.** OpenAI’s `OPENAI_CREDIT_USD` ($5,000) and Luminal’s
  `LUMINAL_CREDIT_USD` ($2,000) are tracked apart (`/admin/spend` shows both). A provider at or past
  its balance stops serving; its models then fall back to the other provider.
- **Prices.** `prices` is what the person’s weekly dollar allowance is charged; `creditPrices` is
  what the provider’s credit is charged (they differ for DeepSeek, whose Luminal list price is
  higher than what OpenRouter billed us for the same model). OpenAI reports no cost, so its
  requests are priced at list.
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
- Any other model or provider needs the person’s own key (`model_not_allowed`; its message and
  `allowed` list only the models that person can use there).

### The provider registry (`src/providers.ts`)

Every provider is one typed entry: `id`, `name`, `website`, `baseUrl`, `apiStyle`
(`openai-chat` or `openai-responses`), `keyEnv` (the secret holding its key) and `kind`. Its
models are the `FREE_MODELS` entries with that `provider` (`src/models.ts`), and those that
name it in `backups` (a model with more than one upstream; see "GLM 5.3 Flash" below).

- **Legacy providers, unchanged.** OpenAI and Luminal keep their settings (`openaiCreditUsd`,
  `luminalCreditUsd` and the weekly ones; `providerCredit.openai`, `providerWeeklyCredit.luminal`
  and so on are aliases that change the same values) and their behaviour when credit runs out
  (OpenAI falls back to DeepSeek; Luminal answers 503 `upstream_credit_exhausted`).
- **Registry providers** (Liquid Inference and Open Relay) have the generic runtime settings, per provider:

  | setting | Liquid default | Open Relay default | |
  |---|---|---|---|
  | `providerStatus.<id>` | `"paused"` | `"paused"` | `"on"` or `"paused"`; a provider serves nothing until it's turned on |
  | `providerCredit.<id>` | 100 | 200 | prepaid credit, USD; at or past it the provider is out of credit |
  | `providerWeeklyCredit.<id>` | 25 | 25 | the most everyone but admins may spend a week; `"none"` for no budget |
  | `providerOptIn.<id>` | `true` | `false` | served only to people who pick its models, never a default or fallback |
  | `providerPersonWeeklyUsd.<id>` | 0.25 | 0.5 | one person's weekly spend on its models at most: Liquid's while it's opt-in or Pro-only (then it is Pro's weekly Kimi ration), Open Relay's always (its spec has `capsEveryone`). Not GLM 5.3 Flash: its cap is its own (below) |
  | `providerPlans.<id>` | `"pro"` | `"all"` | `"pro"`: dl Pro subscribers (and admins, for testing) only; `"all"`: every plan |
  | `providerModels.<id>` | `["moonshotai/kimi-k3.1-pro", "z-ai/glm-5.3-flash"]` | `["z-ai/glm-5.3-flash"]` | the models that are on there (for GLM 5.3 Flash, each upstream separately) |

  Each also reads from env (`LIQUID_STATUS`, `LIQUID_CREDIT_USD`, `LIQUID_WEEKLY_CREDIT_USD`,
  `LIQUID_OPT_IN`, `LIQUID_PERSON_WEEKLY_USD`, `LIQUID_PLANS`, `LIQUID_MODELS`; `OPENRELAY_*`
  for Open Relay).
- **Kimi is a dl Pro perk** while `providerPlans.liquid` is `"pro"` (the default). The rule is
  per model (`modelPlans`): `providerPlans.<id>` applies to the provider's models that have no
  `plans` of their own, and GLM 5.3 Flash has `plans: "all"`, so it stays free for everyone on
  Liquid. A free account's request for Kimi gets 402 `provider_limit` reason `pro_only`, with
  `upgradeUrl` (dl.new/account; null while Pro isn't offered), `plans: "pro"` and
  `approxTokensPerWeek`:
  "Kimi K3.1 Pro is a dl Pro perk: about 140K tokens a week, then DeepSeek. Upgrade: https://dl.new/account".
  It counts in the refusals (`provider_limit:pro_only`) and as "seen" in Pro's funnel (once a
  person a day, like every other Pro prompt). Pro gets `providerPersonWeeklyUsd.liquid` a week;
  past it, reason `person_cap` with `resetsAt`: "You've used this week's Kimi K3.1 Pro with dl
  Pro (about 140K tokens a week). It resets on Monday 30 Nov, 00:00 UTC; DeepSeek keeps working:
  /model." Admins pass both. Free accounts don't get Kimi in `/v1/models`; `/v1/providers`
  marks it `access: "pro"`; `/v1/me` states them upfront in `proModels` (`available`,
  `usdPerWeek`, `approxTokensPerWeek`, for Pro `ration` `{usdPerWeek, usedUsd, remainingUsd,
  approxTokensPerWeek, approxTokensLeft, resetsAt}`, and a `text` line), and Pro's `/v1/models`
  entry carries the same `ration`. "About N tokens" is the dollars at the model's credit prices
  for a typical coding-agent mix (60% cache reads, 32% fresh input, 8% output; providers.ts
  `RATION_MIX`), to two significant digits: an estimate, the dollars are what count. `"all"`
  opens it to every plan (if more credit comes), each held to the per-person cap while opt-in.
- **One open-models budget.** DeepSeek, Kimi and GLM all spend the person's DeepSeek budget
  (`deepseekWeeklyUsdCap` and the level and Pro variants): more providers never means more free
  usage a week. GPT-6 stays separate and trusted-only. An opt-in provider's cap is on top of it.
- **Spend per provider.** A registry provider's credit is kept in `provider_credit_weeks` (all
  of it, what people but admins used, the free part, and the probes'), and per person in
  `provider_person_weeks` (ids and dollars only; a model with its own cap under `model:<id>`,
  across its upstreams, and not under its providers). Each model's part of each upstream's week
  is in `share_weeks` (`"<provider>:<model id>"`, dollars only), for `modelWeeklyCredit`.
  OpenAI's and Luminal's stay in `spend_weeks`. Every attempt is accounted to the upstream that
  made it (`requests.upstream`, its credit): a failed one is charged nothing.
- **When it can't serve** (paused, out of credit, its weekly budget used, or the person's opt-in
  cap reached) its models leave `/v1/models` and a request for one gets the `gpt_limit` shape
  with its own code: HTTP 402
  `{"error": {"code": "provider_limit", "reason": "paused"|"out_of_credit"|"weekly_budget"|"pro_only"|"person_cap", "provider": "liquid", "family": "deepseek", "resetsAt": <ISO or null>, "alternative": "deepseek/deepseek-v4.1-flash-1017"}}`.
  Without its key, or with a model off, the model is unknown (`model_not_allowed`), as if it
  weren't defined. `/v1/models` carries each model's `access`: `free`, `trusted` or `opt-in`.
  With plans `"all"`, the `person_cap` and `weekly_budget` messages say when it resets. For a
  paying dl.new plan the messages (and the fallback's `x-dl-notice`) leave out the free-token
  wording ("Kimi K3.1 on Liquid is paused right now.", not "… paused for free tokens …").
- **A plan's meter full on a retry or fallback.** When a backup upstream or a model's fallback
  can't reserve because the plan's meter for the model it would use is full, the answer is that
  plan's own refusal (402 `plan_limit`, the Free plan's `free_plan_limit`, a no-card trial's
  `trial_used_up`), not 503 `upstream_unavailable`.
- **A model with a `fallback`** (GLM 5.3 Flash → DeepSeek V4.1 Flash) past its provider's credit
  or weekly budget, or the person's cap: Autopilot still gets the 402 above (it switches to the
  `alternative` and resends the turn itself, with its own line); another coding agent launched by
  dl (`dl opencode`, `dl pi`, `dl proxy`), which can't, is served the fallback instead, with
  `x-dl-fallback: <fallback id>` and `x-dl-notice: <one line>` ("You've used this week's free GLM
  5.3 Flash (about 15M tokens a week); DeepSeek V4.1 Flash 1017 serves until it resets on Monday
  30 Nov, 00:00 UTC."). Never for a pause or a missing key.
- **Alerts.** At 80% of a registry provider's credit, one alert (email and webhook), once per
  balance; the daily digest has a line with its credit left and this week's spend.

### Liquid Inference

[Liquid Inference](https://liquidinference.ai/) is an exchange: each request is auctioned to the
cheapest seller offer that passes the request's rules. Requests go to
`https://router.inference.ai.exchange/v1/chat/completions` with only the fields it accepts
(`messages`, `tools`, `tool_choice`, `response_format`, sampling fields, `reasoning`,
`reasoning_effort`; it refuses rather than ignores what it doesn't support), the person's hashed
id as `user`, the session id at the top level (`session_id`), and the service's rules in
`exchange`:

```json
{"candidates": {"providers": {"allow": ["deeprelay"]}}, "privacy": {"retention": "none"},
 "limits": {"price": {"input_usd_per_mtok": 2.1, "cache_read_usd_per_mtok": 0.25, "output_usd_per_mtok": 10.5}},
 "session": {"sticky": true}}
```

Zero retention only; the price ceilings stop a repriced or vanished offer from moving a session
onto a dear one; `sticky` keeps a session on the seller that holds its prompt cache. The sellers
and ceilings are runtime settings per model: `exchangeAllow.kimi-k3.1-pro` (a list of seller
handles, `[]` for any seller that passes the other rules) and `exchangeMaxPrices.kimi-k3.1-pro`
(`[input, cache read, output]`), and the same for `glm-5.3`. The response, or the stream's last
chunk, carries an `exchange` block (`job_id`, `provider_slug`, `charge`, `usage`, `timing`, ...).
The credit is charged what it says: `charge.total_usd` when above 0, else `supplier_usd +
fee_usd` when above 0 (live, both were still 0 at the end of a stream: they settle later), else
`estimated_usd`, else the ceilings plus the 5% fee. Tokens are the larger of the standard `usage`
and the exchange's `usage` (its `reasoning_tokens` added to `completion_tokens`): live, a Kimi
stream's standard usage said 0 output tokens although text came back. Probes also keep the seller
(`provider_slug`) and the exchange's own `timing.ttft_ms` and `timing.tokens_per_second`. Failures go back as transient errors with `Retry-After`, like
Luminal's, for Kimi; GLM 5.3 Flash goes on to Open Relay (below). "No offer met the
requirements" comes back as HTTP 400 with `error.code` `no_eligible_offer` (seen live on
2026-11-24) and counts as such a failure (status `upstream_no_offer`).

### GLM 5.3 Flash: Liquid first, Open Relay as the backup

GLM 5.3 Flash (`z-ai/glm-5.3-flash`) has two upstreams, tried in order (`src/models.ts`
`backups`, `upstreamsOf`): Liquid Inference (`glm-5.3-flash`), then Open Relay
(`openrelay/glm-5.3-flash`). It was the fastest and cheapest model of the 24 Nov 2026 bake-off on
Liquid (about 275 tokens a second, 0.45 s to the first token, ~$0.0006 a coding task), while Open
Relay rate-limited our key hard.

- **Which upstream.** The first one that can serve (`registryRoute`: a key, on there in
  `providerModels.<id>`, its credit, its weekly budget, and GLM's own share of it). On a failure
  before any bytes reach the client (429, 5xx, a first-byte timeout or network error, Liquid's
  `no_eligible_offer`, or the provider refusing our key) the next one is tried with a fresh
  reservation, then DeepSeek (its `fallback`, with `x-dl-fallback`). A 400 about the request
  itself goes back as a 400 `upstream_error` in dl's own words (see "Upstreams: Luminal and OpenRouter"). A stream that has started stays where it is.
- **Liquid's rules.** Sellers `exchangeAllow.glm-5.3-flash` (`["munitoai", "tensorx"]`: the two
  that served it in the bake-off with `privacy.retention: "none"`, checked again live;
  `LIQUID_ALLOW_GLM_5_3_FLASH`) and ceilings `exchangeMaxPrices.glm-5.3-flash` (`[0.2, 0.05,
  0.5]`, admitting both: munitoai lists $0.02765 / $0.005743 / $0.09571 and wins on price,
  tensorx $0.20 / $0.05 / $0.50; `LIQUID_MAX_PRICES_GLM_5_3_FLASH`). The exchange also adds about
  $0.01 a million tokens of fee (seen live); its reported charge is what Liquid's credit pays.
- **Free for everyone.** `plans: "all"` on the model: `providerPlans.liquid` "pro" and Liquid's
  opt-in don't apply to it (`access: "free"`).
- **Caps.** One person: `modelPersonWeeklyUsd.glm-5.3-flash` ($0.50 a week, about 15M tokens at
  the ration mix and Open Relay's list price; `GLM_5_3_FLASH_PERSON_WEEKLY_USD`), Liquid and Open
  Relay together. Everyone: Liquid's `providerWeeklyCredit.liquid` ($25) is shared with Kimi and
  split by `modelWeeklyCredit.liquid.glm-5.3-flash` ($10; `LIQUID_WEEKLY_CREDIT_GLM_5_3_FLASH`)
  and `modelWeeklyCredit.liquid.kimi-k3.1-pro` ($15; `LIQUID_WEEKLY_CREDIT_KIMI_K3_1_PRO`), so
  neither starves the other; past GLM's share Open Relay serves it (its own $25 a week). Past the
  person cap or both upstreams' budgets, DeepSeek (Autopilot: 402 `provider_limit`; other agents:
  served DeepSeek with `x-dl-notice`).
- **What it shows.** `/v1/providers` lists it once, under the first upstream it's configured on
  (Liquid), with `backups: [{provider, name, website, status, tokensPerSecond, ttftMs,
  successRate24h, measuredAt}]` (Open Relay); each upstream is probed and measured on its own.
  `/v1/models` `owned_by` and `/v1/me` `cappedModels[].provider` name that first upstream. `GET
  /v1/admin/providers` lists, per registry provider, `models` with `role` (`primary` or
  `backup`), whether it's on there, this week's spend and `weeklyShareUsd`.

To turn it on after a deploy: check `providerModels.liquid` includes `z-ai/glm-5.3-flash` (it does
by default; an override from before this change may not), and `providerStatus.liquid` is `"on"`.

### Open Relay

[Open Relay](https://openrelay.inc/) (OpenRelay Inc.) is GLM 5.3 Flash's backup upstream
(`openrelay/glm-5.3-flash`, 256K context; above), free for everyone: `providerPlans.openrelay`
`"all"`, not opt-in, and in the one open-models budget (so Pro's 4x covers it like DeepSeek).
Everyone together gets `providerWeeklyCredit.openrelay` ($25 a week, so the $200 credit lasts
about 8 weeks); a person is held to GLM 5.3 Flash's own cap across both upstreams. `/v1/me`
states the cap in `cappedModels` (`usdPerWeek`, `approxTokensPerWeek`, `ration` for this week,
`fallback`, a `text` line), and `/v1/models` entries carry the same `ration`.

Requests go to `https://inference.openrelay.inc/v1/chat/completions` with `Authorization: Bearer
or_…` (`OPENRELAY_API_KEY`) and only the standard fields (`messages`, `tools`, `tool_choice`,
`parallel_tool_calls`, `response_format`, sampling fields, `reasoning_effort`; OpenRouter's
`reasoning.effort` becomes `reasoning_effort`), `max_tokens` from the reservation, the person's
hashed id as `user`, and usage on streams. Checked live on 2026-11-24: streams end with an
empty-choices chunk carrying `usage` (reasoning tokens inside `completion_tokens`) and
`openrelay: {cost_nano_usd, priced_at}`; non-streamed answers carry the same block and the
`OpenRelay-Cost-Nano-USD` header; tool calls stream as standard `tool_calls` deltas. The credit
is charged the reported cost when above 0, else the usage at the list price ($0.045 input,
$0.009 cached, $0.18 output per million). 429, 502 and 503 go on to DeepSeek (GLM 5.3 Flash's
fallback) when it can serve, else back as transient errors with `Retry-After`; a 402 or 403 from
Open Relay (its balance or the key's spend cap) goes on to DeepSeek too.

To turn it on after a deploy: `wrangler secret put OPENRELAY_API_KEY`, check
`GET /v1/admin/providers`, then `POST /admin/config {"providerStatus.openrelay": "on"}`.

#### Open Relay first for DeepSeek and Kimi

Open Relay can also be the first-choice upstream of DeepSeek V4.1 Flash
(`openrelay/deepseek-v4.1-flash`, 384K context; $0.035 input, $0.01 cached, $0.33 output per
million) and Kimi K3.1 Pro (`openrelay/kimi-k3.1-pro`, 256K context; $0.24, $0.20, $7.00), in
models.ts `firstChoice`. It is off until `providerModels.openrelay` lists them (the default list
leaves them out) and `providerStatus.openrelay` is `"on"`:

```
POST /admin/config {"providerStatus.openrelay": "on", "providerModels.openrelay": ["deepseek/deepseek-v4.1-flash-1017", "moonshotai/kimi-k3.1-pro"]}
```

(GLM 5.3 Flash stays off on Open Relay unless it is in the list too.) Then Open Relay serves them
first; the model's usual upstream (DeepSeek: Luminal, or OpenRouter when that is the primary;
Kimi: Liquid) serves on a failure before anything reaches the client (429, 5xx, a timeout, a 401,
402 or 403, or a 400 `context_length_exceeded` for a prompt longer than Open Relay takes), and
whenever Open Relay is past its credit, `providerWeeklyCredit.openrelay` or the model's own share
of that week (`modelWeeklyCredit.openrelay.deepseek-v4.1-flash-1017`,
`modelWeeklyCredit.openrelay.kimi-k3.1-pro`; none by default). Access, per-person caps and the
person's allowance stay the model's own (Kimi stays a dl Pro perk with Liquid's ration), and the
public `/v1/providers` keeps listing each under its own provider. Open Relay's credit is charged
its reported cost, else the usage at the prices above (cached tokens at the cached price).

`GET /v1/admin/providers?days=7` has `usage`: per upstream and model over the last `days` UTC days
(1 to 60), the requests, upstream errors, `freshTokens`, `cachedTokens`, `outputTokens`,
`cacheHitRate` (cached ÷ all prompt tokens), `creditUsd`, and `atPrices` (the same split into
fresh, cached and output dollars at that upstream's prices, and `cacheSavedUsd`). Compare the
`openrelay` and `luminal` rows of DeepSeek, or `openrelay` and `liquid` of Kimi.

### Adding a provider

1. Add its entry to `PROVIDERS` in `src/providers.ts` (`kind: "registry"`) and its id to
   `ProviderId`, and its key to `providerKey` and `FreeConfig` (`config.ts`).
2. Add its models to `FREE_MODELS` (`src/models.ts`), with `family: "deepseek"` for an open model
   (one budget) and `line` for what /v1/providers calls it. Mark anything not checked against the
   provider's docs in a comment.
3. Add its `provider<Setting>.<id>` settings to `RegistrySettingsConfig` and `REGISTRY_DEFAULTS`
   (`providers.ts`), `RUNTIME_SETTINGS` (`runtime-config.ts`) and `registrySettings` (`config.ts`).
4. Its request shape: an `openai-chat` provider like Luminal, Liquid or Open Relay goes through
   `compatibleChat` in `app.ts`, and its reported cost (if any) into `reportedCharge`.
5. Upload its key: `wrangler secret put LIQUID_INFERENCE_API_KEY` (for Liquid; its `keyEnv` for
   another). Then deploy, check `GET /v1/admin/providers`, and turn it on with
   `POST /admin/config {"providerStatus.<id>": "on"}`.

### Speed probes

A cron trigger every 10 minutes (`*/10 * * * *`, in `triggers.crons` beside the digest's) sends
one tiny streaming request per model that can serve, on the service's key: "Count from 1 to 40."
with at most 120 output tokens. Each records whether it worked, the time to the first token
(reasoning counts) and tokens a second after it, in `provider_probes` (15 days kept). A provider
that can't serve (no key, paused, out of credit, weekly budget used) is skipped; a model whose
output costs $20 a million tokens or more (Astra) is probed once an hour. Probes run one at a time.
Their cost is the service's own spend on the provider's credit, never anyone's allowance or the
free caps. `speedProbes` (`SPEED_PROBES`) turns them off; so does the kill switch.

### `GET /v1/admin/providers` (admins)

Each provider's credit: `balanceUsd`, `usedUsd`, `leftUsd`, `weeklyBudgetUsd`, this week's
`weekUsd` (everyone), `userWeekUsd` (everyone but admins: what the weekly budget counts),
`freeWeekUsd` and `probeWeekUsd`; and the probes over `?hours=` (1 to 360, default 24), newest first.

## The new-user trial

Off until the owner sets `trialCutoff` (a runtime setting, below). Then:

- **Grandfathered**: everyone admitted before the cutoff. Nothing changes: the weekly free
  allowance by level, personal caps, batch-flagged accounts at 0.
- **Trial**: accounts admitted at or after the cutoff (`people.admitted_at`), admins never. On
  the free plan they get a one-time trial of `trialTokens` (10M) for the account's lifetime,
  counted like `budgets.*.tokensThisWeek` (prompt tokens with cached ones, plus completion
  tokens), every free model together. It holds on top of the weekly rules: a reservation gets at
  most what both leave (in-flight free requests are held against the trial too), so a
  batch-flagged account still gets nothing. Once it's used up, free requests get 402
  `trial_ended` (see Refusals); the weekly reset doesn't bring it back.
- Referrals add to the trial: each referred friend who becomes weekly active adds
  `referralBonusTokens` (10M) once to **both** people's trial, up to `referralBonusCap` (50M) per
  person (see [Referrals](#referrals)). `trial.tokens` includes it.
- Pro and top-ups work past the trial as they always do, and don't count against it. Pro for a
  trial account is the same weekly allowance current free users get when
  `proOpenModelsMultiplier` is 1.
- The count (`account.trial_used`) is every free (unpaid weekly) token since this shipped, kept
  for everyone but only applied to trial accounts.

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
  by anyone; an established account created on a busy day is never flagged. "Many" scales with
  sign-up volume: a window needs `batchDensityFactor` (3) times the peers an average window holds
  across every young account signed up, and never fewer than `batchSize` (`src/admission.ts`
  `batchThreshold`; `batchDensityFactor` 0 keeps the fixed `batchSize`). So a launch day with
  thousands of young sign-ups raises the bar instead of flagging most of them, while a farm
  (many accounts made on the same days) still stands far above it. Their thresholds are
  runtime settings (`humanSignalsNeeded`, `minActiveWeeks`, `minRepoAgeDays`, `minSocial`,
  `minFollowers`, `batchWindowDays`, `batchSize`, `batchDensityFactor`; see `src/admission.ts` `levelChecks`) whose
  real values are private: they start from the [`DETECTION_RULES`](#detection-rules-detection_rules-private)
  secret's `thresholds` (the defaults in the code are generic) and the admin settings override them. Nothing a person is shown names them: an account
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
  Beyond that the account still gets in, as Starter (reason `network_limit`).
- **Email domain cap**: at most `domainSignupsPerDay` new accounts a day from one company or
  custom email domain (public providers like Gmail are exempt). Beyond that a new account below
  Full still gets in, as Starter (reason `domain_limit`); one that clears the bar on its own
  stays Full. `domainLimitRefuse` (off) refuses instead, as before. Both limits count as farm
  signals for the token allocator, and both accounts are re-checked an hour after sign-in.
  `blockedEmails` still refuses.
- **Event codes** (`src/event-codes.ts`): an admin makes a multi-use code (`EV-XXXX-XXXX`) for a
  class, workshop or hackathon, with a maximum number of uses (1 to 1000) and an expiry (1 to 60
  days), on the Tools tab or with `POST /admin/event-codes {maxUses, days?, note?, full?}`
  (answers the code once; only its hash is kept). People type it in the sign-up's code field
  (the same field as invite codes). A new sign-up with an open code skips the per-network limit
  (and isn't counted against it), the per-domain limit and the creation-batch check, now and at
  later re-checks; every other rule still applies. It gets the level its own GitHub signals
  give, like any new account (the allocator starts it as usual), or Full when the code was made
  with `full: true`. `GET /admin/event-codes` lists every code with its uses, status (`open`,
  `used_up`, `expired`, `ended`) and who used it; `POST /admin/event-codes/:id/end` ends one now.
  Only wrong codes count against a network's code attempts, so a whole room can use one code.
- **Existing users** are re-checked lazily on their next request; nobody is cut off mid-session.
- **Admin**: `GET /admin/people` shows each person's level, signals and network count, and
  takes `?level=starter` and `?shared=1`. It pages with `?limit=` (1 to 500) and `?cursor=` (the
  previous page's `nextCursor`); without `limit` it lists everyone, as before. The answer is
  `{people, nextCursor, total}`. Network counts come from one Directory query and each person
  costs one account call, at most 16 in flight at once. `POST /admin/people/:id/level {level}` sets it
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
- **Rate-limit buckets don't hold addresses.** `rateKey` (app.ts) replaces the network at the
  end of a bucket key with an HMAC of it under the signing key (`device:ip:h<32 hex>`), before
  it names the Durable Object or its row, so every per-network limit goes through it. A bucket's
  row is deleted once it has refilled, by the next spend or the object's alarm; a missing row is
  a full bucket, so the limits behave the same.
- **The address comes from `cf-connecting-ip`.** `x-forwarded-for` is read only with
  `TRUST_X_FORWARDED_FOR=true` (env only, default false), for a self-hosted service behind a
  proxy that appends the client's address to it, and then only its last entry (the one the proxy
  saw; earlier entries are whatever the client sent). Without either header every caller is
  `unknown` and shares one network's limits. Behind a proxy that isn't Cloudflare, make sure the
  proxy also drops any `cf-connecting-ip` a client sends.
- **Per-network limits are generous for shared networks** (an office, a classroom, a meetup):
  the API 600 requests a minute, refresh 600 an hour, device codes 60 an hour and their polling
  720 a minute, since each signed-in person is limited too (60 requests a minute). Sign-ups (3 a
  day) and invite attempts (10 an hour) stay tight.
- **The browser steps on a user code** (`GET /device?user_code=`, `GET /device/authorize`,
  `POST /device/deny`) share one bucket of 120 an hour per network (a 429 page with
  `retry-after`), so codes can't be guessed or cancelled in bulk. `POST /device/deny` ("This
  isn't my code") is refused (403) unless it comes from this site's own page (`Origin`, or
  `Sec-Fetch-Site: same-origin` when the Origin is hidden). The confirm page says how long ago
  the code was requested.

## API contract for the open launch

Autopilot and dl.new build against these shapes. Fields may be added; none are removed.

### `GET /v1/me`

```jsonc
{
  "login": "alice", "githubId": 123, "email": "alice@example.com", "status": "active",  // email: given at sign-in, or null
  // The Luna pool and the GPT-6 budget, as older clients read them; `budgets` has both.
  "allowance": { "tokensPerWeek": 50000000, "usedThisWeek": 0, "remaining": 50000000,
                 "resetsAt": "2026-11-09T00:00:00.000Z", "usdPerWeek": 2, "spentUsdThisWeek": 0,
                 "budgets": { "…": "as below" } },
  // Both weekly dollar budgets. tokensThisWeek: every token processed (prompt with cached, plus
  // completion), not the weighted count the token pools are charged.
  "budgets": { "gpt6":     { "usdPerWeek": 2, "spentUsd": 0.4, "tokensThisWeek": 6000000 },
               "deepseek": { "usdPerWeek": 8, "spentUsd": 1.2, "tokensThisWeek": 58000000 } },
  "pools": {                            // one weekly token pool per model; null: no token cap
    "luna":  { "tokensPerWeek": 50000000, "usedThisWeek": 0, "remaining": 50000000,
                 "resetsAt": "2026-11-09T00:00:00.000Z", "family": "gpt6", "models": ["gpt-6-luna"] },
    "sol":   { "tokensPerWeek": 10000000, "usedThisWeek": 0, "remaining": 10000000, "resetsAt": "…", "family": "gpt6", "models": ["gpt-6.1-sol"] },
    "astra": { "tokensPerWeek": 3000000,  "usedThisWeek": 0, "remaining": 3000000,  "resetsAt": "…", "family": "gpt6", "models": ["gpt-6-astra"] },
    "deepseek": { "tokensPerWeek": null, "usedThisWeek": 0, "remaining": null, "resetsAt": "…", "family": "deepseek",
                  "models": ["deepseek/deepseek-v4.1-flash-1017"] }
    // Every pool also has realTokensPerWeek and realUsedThisWeek: its counted tokens as real
    // tokens at the plan mix (`mix`), the numbers to show a person (null realTokensPerWeek: no cap).
    // A smaller level's DeepSeek pool has a token cap besides its dollar budget, and it usually binds first.
  },
  // How counted tokens become real ones: counted = cached x cachedTokenWeight + fresh + output.
  "mix": { "cached": 0.955, "fresh": 0.038, "output": 0.007, "label": "95.5% caching applied",
           "cachedTokenWeight": 0.02, "countedFactor": 0.0641 },
  "models": ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra", "deepseek/deepseek-v4.1-flash-1017"],
  "otherHarnessShare": 1,               // dl claude / dl opencode's part of the allowance (1: all of it, as Autopilot)
  "plan": "free",                       // "free" | "pro"
  "topupTokensLeft": 0,                 // unexpired tokens from old token top-ups not yet used
  "topupUsdLeft": 0,                    // unexpired dollar top-up usage not yet spent or held
  "topupUsdExpiresAt": null,            // when the soonest-expiring dollar top-up with usage left ends
  "pro": null,                          // or { "periodEnd": ISO string | null, "cancelAtPeriodEnd": false }
  "queue": null,                        // or { "position": 214, "etaAt": "2026-11-16T00:00:00.000Z", "waiting": 300 }
  "referral": { "code": "alice", "link": "https://dl.new/r/alice", "joined": 2, "activeThisWeek": 1,
                "bonusTokensPerWeek": 10000000, "bonusCapPerWeek": 50000000,
                "bonusApplies": true },        // false: the bonus isn't added to this allowance (Pro, or a smaller level); hide it
  "offers": { "pro": { "priceUsdMonthly": 7, "price": "$7/month", "tokensPerWeek": 300000000, "usdPerWeek": 2,
                       "deepseekUsdPerWeek": 32, "openModelsMultiplier": 4, "valueLine": "Higher limits and early access to new models." },
              "topup": { "unitPriceUsd": 1, "minQuantity": 2, "maxQuantity": 20, "usageMultiplier": 1.25, "validDays": 90, "fromPrice": "$2" } },
  "trial": null,                        // or, for a trial account: { "tokens": 10000000, "used": 3800000, "remaining": 6200000, "ended": false }
  "proPrompt": null                     // or dl Pro's prompt (below): { "text": "…", "price": "$7/month", "upgradeUrl": "https://dl.new/account" }
}
```

- `trial` is null for grandfathered accounts (and everyone while the trial is off); for a trial
  account it is there whatever the plan. `used` is capped at `tokens`; `ended` once less than a
  minimal answer is left. On the free plan, `allowance.remaining` is also capped by the trial.

- No level appears here: publicly there is only Free and Pro (`plan`).
- `allowance.tokensPerWeek` includes this week's referral bonus; the GPT-6 dollar budget grows in
  the same proportion. While queued, `allowance.remaining` is 0.
- A personal cap (an admin's grant) replaces the GPT-6 budget; DeepSeek's is then the larger of
  the personal cap and the plan's DeepSeek budget.
- With Pro, `allowance` is Pro's: 300M tokens a week (`PRO_TOKENS_PER_WEEK`), no referral bonus,
  `proOpenModelsMultiplier` (4) times the free DeepSeek budget ($32 a week by default), and the
  free plan's GPT-6 budget (Pro adds no GPT-6), held like the free caps (settled spend plus the
  estimates of requests in flight). `queue` is null for Pro (a place in
  line is kept in case Pro ends).
- `referral.joined`: sign-ups with this person's code that count. `activeThisWeek`: those friends
  whose pair counts toward this week's bonus (see [Referrals](#referrals)).
- `offers` come from config (`PRO_PRICE_USD_MONTHLY` in dollars and cents, `PRO_TOKENS_PER_WEEK`,
  `PRO_OPEN_MODELS_MULTIPLIER`, `PRO_VALUE_LINE`, `TOPUP_UNIT_PRICE_USD`, `TOPUP_MIN_QUANTITY`,
  `TOPUP_MAX_QUANTITY`, `TOPUP_USAGE_MULTIPLIER`, `TOPUP_VALID_DAYS`). `pro.price` is the exact
  text to show ("$7/month"): clients never round it.
- `proPrompt` (dl Pro, phase 1): for a free account (not on the trial, not queued, not an admin)
  whose week of open models (DeepSeek) is used up, while `proOffered` is on: the exact text, the
  price and where Upgrade goes (`https://dl.new/account`). `GET /v1/me?prompt=shown` (what
  `dl status` sends) also counts it as seen; a plain read doesn't.
- `week`, only with `GET /v1/me?week=1` (dl's one-time "First tokens served" line): this week of
  DeepSeek on the account's plan (a paid plan's limit, or dl.new's Free plan) in real tokens at the
  plan mix, `{tokensPerWeek, usedAtMix, leftAtMix, label: "95.5% caching applied", resetsAt}`, or
  null for an account on neither.

### Refusals for free tokens (`POST /v1/chat/completions`, HTTP 402)

Out of tokens (a free user):

```json
{ "error": { "code": "quota_exceeded", "message": "This week's free token allowance is used up. It resets at 2026-11-09T00:00:00.000Z.",
             "reason": "tokens", "resetsAt": "2026-11-09T00:00:00.000Z",
             "offers": { "pro": { "priceUsdMonthly": 7, "price": "$7/month", "...": "…" }, "topup": { "unitPriceUsd": 1, "minQuantity": 2, "...": "…" } },
             "referralLink": "https://dl.new/r/alice" } }
```

Open models (DeepSeek) used up on the free plan while Pro is offered (`proOffered`): dl Pro's
prompt (phase 1), as the message with its Upgrade link and as `proPrompt` for clients that show
their own [Upgrade] (Autopilot opens Checkout from `/upgrade`). Counted as seen (pro-funnel.ts).
A basic or Starter account gets it in `basic_limit`/`starter_limit` too, with ", or type
/request in dl and tell us what you're building." added. While Pro isn't offered, the messages
below. The refusal's prompt names the limit that ran out: "free token limit on DeepSeek V4.1
Flash (~18.7M tokens, 95.5% caching applied)" (the pool's tokens as real tokens at the plan
mix) or "free $8 spending limit on DeepSeek V4.1 Flash"; `family` says which budget. /v1/me's
`proPrompt` keeps the generic "free limit".

```json
{ "error": { "code": "quota_exceeded",
             "message": "You've hit this week's free $8 spending limit on DeepSeek V4.1 Flash. dl Pro: $7/month for higher limits and early access to new models. Upgrade: https://dl.new/account",
             "proPrompt": { "text": "You've hit this week's free $8 spending limit on DeepSeek V4.1 Flash. dl Pro: $7/month for higher limits and early access to new models.",
                            "price": "$7/month", "upgradeUrl": "https://dl.new/account" },
             "reason": "spend", "family": "deepseek", "resetsAt": "2026-11-09T00:00:00.000Z", "offers": { "...": "as above" }, "referralLink": "https://dl.new/r/alice" } }
```

GPT-6's week used up while DeepSeek's isn't (free or Pro; Pro's message leaves the offer out):

```json
{ "error": { "code": "gpt_limit",
             "message": "You've used this week's GPT-6 allowance. DeepSeek V4.1 Flash still has free usage this week: switch with /model, or get dl Pro.",
             "family": "gpt6", "reason": "spend", "resetsAt": "2026-11-09T00:00:00.000Z",
             "alternative": "deepseek/deepseek-v4.1-flash-1017",
             "offers": { "...": "as above" } } }
```

Queued:

```json
{ "error": { "code": "free_tier_queued",
             "message": "You're #214 in line for free tokens (about 3 days). Each friend who starts using dl moves you up. Your own key works now.",
             "position": 214, "etaAt": "2026-11-09T00:00:00.000Z",
             "offers": { "pro": { "priceUsdMonthly": 7, "price": "$7/month", "...": "…" }, "topup": { "unitPriceUsd": 1, "minQuantity": 2, "...": "…" } },
             "referralLink": "https://dl.new/r/alice" } }
```

The wait reads "about N days" under two weeks, else "about N weeks".

A basic or Starter account's week used up (both budgets; a free user): `basic_limit` or
`starter_limit`, with the limit that ran out (never the level's name), that it resets Monday,
and the ways on. `request` is the access-request endpoint.

```json
{ "error": { "code": "basic_limit",
             "message": "You've hit this week's free token limit on DeepSeek V4.1 Flash (~18.7M tokens, 95.5% caching applied). It resets on Monday. Need more? Type /request in dl and tell us what you're building, or use your own API key with /provider.",
             "reason": "tokens", "family": "deepseek", "resetsAt": "2026-11-09T00:00:00.000Z", "request": "/v1/access-request",
             "offers": { "...": "as above" }, "referralLink": "https://dl.new/r/alice" } }
```

No free tokens at all (HTTP 403 `below_bar`): `contact` (the email fallback) and `request`.

A trial account's trial used up (free plan, no top-up left), whatever the model:

```json
{ "error": { "code": "trial_ended",
             "message": "Your 10M free trial tokens are used up. Keep going with dl Pro for $7 a month, or add a top-up: /upgrade",
             "trial": { "tokens": 10000000, "used": 10000000, "remaining": 0, "ended": true },
             "offers": { "...": "as above" } } }
```

### Access requests (`/request` in dl; `Authorization: Bearer <access token or server key>`)

`POST /v1/access-request {building, link?}`: `building` is required, 10 to 600 characters after
trimming; `link` is optional, an `http://` or `https://` URL of at most 300 characters. Any
signed-in person who isn't blocked.

| answer | when |
|---|---|
| 201 `{"status": "pending"}` | stored; the owner gets an alert with the login and the pending count only |
| 409 `already_pending` | a request is already waiting |
| 409 `already_full` | Admins, and Full accounts that may already have server keys |
| 429 `rate_limited` | more than 3 submissions in 24 hours |
| 400 `invalid_request` | a clear message about what to fix |
| 403 `blocked` | a blocked account |

`GET /v1/access-request` → `{"status": "none" | "pending" | "granted" | "declined", "at"?: ISO}`
(the newest request; `at` is when it was sent, or answered).

What a person writes is user content: stored as plain text, shown only on the admin Tools tab
(escaped), never logged, never in an alert, a metric or an export. Admins:
`GET /admin/access-requests` (pending, newest first) and
`POST /admin/access-requests/:id/grant` (`{note?, usdPerWeek?}`) or `/decline` (`{note?}`).

A grant (this one, `POST /admin/grant {logins, usdPerWeek?}`, and the Tools tab's
forms) sets Full with reason "admin" and a personal weekly dollar cap: `usdPerWeek`, or the
`grantWeeklyUsdCap` setting (default 20) when it's left out. It never lowers a higher personal
cap already set; 0 sets no personal cap (only the level). Someone not signed up yet gets the cap
at their first sign-in.

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

### `GET /v1/providers` (public)

The providers that serve free tokens, their models that are on, and measured speed, for dl.new and
the clients. No auth, `access-control-allow-origin: *` (OPTIONS answers 204),
`cache-control: public, max-age=60`; computed at most once a minute per isolate; rate-limited per
network like `/v1/status`. Never credit amounts, keys, spend, sellers or terms. Logos are the
website's: `logo` is only the path.

```json
{"updatedAt": "2026-11-23T10:00:00.000Z", "providers": [
  {"id": "liquid", "name": "Liquid Inference", "website": "https://liquidinference.ai/",
   "url": "https://liquidinference.ai/?utm_source=dl.new&utm_medium=referral&utm_campaign=providers",
   "logo": "/logos/liquid.svg",
   "models": [{"id": "moonshotai/kimi-k3.1-pro", "name": "Kimi K3.1 Pro", "family": "kimi", "contextWindow": 1048576,
               "access": "opt-in", "status": "on", "tokensPerSecond": 142.5, "ttftMs": 950,
               "successRate24h": 1, "measuredAt": "2026-11-23T09:50:01.000Z"}]}]}
```

- A provider is listed once it has its key; only its models that are on.
- `family`: what the model is (`gpt6`, `deepseek`, `kimi`, `glm`), not the budget.
- `access`: `trusted` (GPT-6), `free`, `opt-in`; `pro` is kept for when Pro gets a provider first.
- `clients`: the coding agents the model can be used in, of `autopilot`, `claude-code`, `opencode`
  and `pi`. GPT-6 is `["autopilot"]` while `gpt6Clients` is `autopilot`; DeepSeek is every agent;
  Claude Code through dl is always served by DeepSeek, so only DeepSeek lists it.
- `status`: `on`, `out_of_credit`, or `paused` (the kill switch, the provider paused, its weekly
  budget used, no credit-backed way to serve).
- Speed over the last 24 hours: the median tokens a second (after the first token) and time to
  first token, and the share of requests that didn't fail upstream, from real traffic once a
  model had 20 requests in that time, else from the probes. `null` when nothing was measured.

### Billing (`Authorization: Bearer <access token>`; a server key is refused)

| request | response |
|---|---|
| `POST /v1/billing/checkout {"product": "pro"}` | `{"url": "https://checkout.stripe.com/…"}`: a subscription Checkout |
| `POST /v1/billing/checkout {"product": "topup"}` | `{"url": …}`: a one-time payment Checkout |
| `POST /v1/billing/portal` | `{"url": "https://billing.stripe.com/…"}`: the Customer Portal (cancel Pro, change card) |

Refusals: 400 `invalid_request` (unknown product), 403 `not_invited` / `suspended`, 403
`pro_not_offered` (a Pro checkout, here or at `POST /web/checkout`, while `proOffered` is off), 409
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

- **Pro** (dl Pro), $7 a month (`PRO_PRICE_USD_MONTHLY`), USD, monthly, no trial, no coupons,
  no annual plan: `proOpenModelsMultiplier` (default 4, `PRO_OPEN_MODELS_MULTIPLIER`, also a
  runtime setting) times the free DeepSeek budget ($32 of DeepSeek a week against the free $8),
  in place of the free allowance. DeepSeek stays free for everyone; Pro is more of it (and, in a
  later phase, new models first). Pro adds **no GPT-6**: its GPT-6 budget is the free plan's, and
  paying is not a trust signal for the GPT-6 trust gate (`gpt6-trust.ts`). Pro starts when its Checkout completes and stays on while the subscription is active and
  its paid period (plus 3 days' grace for a late renewal webhook) hasn't ended.
- **Top-up**, $2 to $20 once (2 to 20 units of a $1 price, adjustable on Checkout): each $1
  adds $1.25 of usage dollars (`TOPUP_USAGE_MULTIPLIER`), valid 90 days, spent only after the
  week's allowance (free or Pro) runs out, earliest expiry first, at the same cost as the dollar
  caps (requests in flight hold their estimate). `POST /v1/billing/checkout {"product": "topup",
  "quantity": 5}` starts at that quantity (default 2). Token top-ups bought before (50M tokens,
  30 days) are used as bought, before dollar ones; a checkout started under the old product
  still grants its tokens (its session has no `topup_kind` metadata). A free person who is queued, or meets
  a global free cap, can still use top-ups.
- **Paid usage** (anything under Pro, and top-up tokens) is logged like any request, with
  `requests.paid = 1`, and counted apart: `spend_weeks.paid_usd/paid_tokens/paid_requests` and
  `daily_activity.paid_cost_usd`. It never counts toward the weekly or all-time free caps, the
  spend alerts or the queue forecast. The kill switch still stops everything.
- **Checkout** is created server-side with Stripe Tax (`automatic_tax[enabled]=true`) and the
  billing address collected (`billing_address_collection=required`; an existing customer gets
  `customer_update[address]=auto`). Pro is priced inline (`line_items[0][price_data]`: USD,
  `PRO_PRICE_USD_MONTHLY` in cents, `recurring[interval]=month`, tax-exclusive, product "dl Pro"),
  so no Pro Product or Price has to exist before the first checkout; the top-up is a Stripe
  Price id from config (`STRIPE_PRICE_TOPUP`). The GitHub id rides along as `client_reference_id` and metadata on the session, the
  subscription and the payment.
- **Webhook** `POST /v1/billing/webhook`: the `Stripe-Signature` header is verified
  (HMAC-SHA256 of `<t>.<raw body>` with `STRIPE_WEBHOOK_SECRET`, 5-minute tolerance), and each
  event id is handled once (`billing_events`); every step is idempotent too (top-ups by Checkout
  Session id, payments by session or invoice id), so a retried delivery is harmless. An event
  older than the last one applied to a person's subscription is ignored, so out-of-order
  deliveries can't undo a newer state.

  | event | effect |
  |---|---|
  | `checkout.session.completed` | saves the customer; Pro: active; top-up (only when `payment_status` is `paid`): `amount_subtotal` × 1.25 in usage dollars for 90 days, or an old token checkout's 50M for 30 days |
  | `invoice.paid` | Pro active until the invoice's period end; revenue recorded |
  | `invoice.payment_failed` | back to free (the free allowance, never no access) |
  | `customer.subscription.updated` | `active`/`trialing` → Pro; `past_due`, `unpaid`, `incomplete` → free; period end and cancel-at-period-end kept |
  | `customer.subscription.deleted` | free |

- **dl Pro's funnel** (`pro-funnel.ts`), per UTC day, each person once a step a day (a hash of
  the GitHub id with that day's random salt, both dropped once the day is over; counts are all
  that's kept): **seen** (a coding agent got the prompt's 402, `dl status` showed it with
  `?prompt=shown`, or dl.new/account showed it), **clicked** (a Pro checkout started: Autopilot's
  `/upgrade` or the limit screen, `POST /web/checkout`), **paid** (`checkout.session.completed` for
  Pro) and **cancelled** (a subscription first set to end at its period's end, or ended without
  that). Admins aren't counted. `GET /v1/admin/metrics` has `proFunnel: {days: [{day, seen,
  clicked, paid, cancelled}], activePro}`, and the daily digest one line under `Paid:`:
  `dl Pro: 12 saw the prompt, 3 clicked Upgrade, 1 paid, 0 cancelled (total active Pro: 4)`.
- **Revenue** on the dashboard is before tax (`amount_subtotal` of a top-up session,
  `total_excluding_tax` of a Pro invoice), in USD.

### dl.new's paid plans (from 1 Dec 2026)

Starter ($7), Plus ($20) and Max ($60) a month, bought on dl.new **before** any account exists.
The HTTP contract the site calls is [docs/web-api-paid.md](docs/web-api-paid.md); the code is
`paid-web.ts` (routes), `paid-store.ts` (Directory: identities, paid Checkouts, refund requests),
`paid-auth.ts` (AuthObject: email codes, dl.new's GitHub round trip, cli-login), `accounts.ts`
(account numbers, `dl_sk_` keys) and `plan-prices.ts` (the plans as sold; the limits are part B's `plans.ts`).

- **Accounts.** The number the service keys everything on (`githubId` in the code) is now the
  account number: the GitHub id for accounts from before (unchanged, linked as a GitHub identity
  on first use), a random number from 2^50 up for accounts made on dl.new (their Account object is
  `acct:<n>`). Identities: `github:<id>` (verified primary email, scope `user:email`) and
  `email:<normalized address>` (6-digit codes: 10 minutes, 5 tries, resend after 30 s, 5 an hour
  per address and 20 per network, disposable domains refused from `disposable-domains.ts`).
- **Checkout first.** `POST /web/checkout/plan` makes a subscription Checkout for the plan's Price
  (`STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PLUS`, `STRIPE_PRICE_MAX`), with `metadata[product]=plan`.
  `checkout.session.completed` keeps the paid session unclaimed and emails "Finish setting up
  dl.new" (`dl.new/account?session_id=…`, 7 days). The account step claims it: the customer and
  subscription are linked, the plan starts, Stripe's customer gets the verified email.
- **Plan state** lives in the Account object's `billing` row (`tier`, `payment_failed`, the first
  invoice for the refund). A plan stays on while past due (Stripe's retries decide);
  `unpaid`, `canceled` and `customer.subscription.deleted` end it. Upgrades are prorated and
  invoiced at once; refunds are an admin action (`POST /admin/paid/refund`).
- **Refunds.** No page or email promises one; the owner refunds by hand with
  `POST /admin/paid/refund`, which refunds the first invoice's payment in full (what was actually
  charged, so a discounted first month refunds the discounted amount). Without `{"force": true}`
  it keeps to the runtime setting `refundWindowHours` (REFUND_WINDOW_HOURS, default 24) and
  refuses once a plan model is at 100% of its weekly limit this week.
- **Launch offer** (Black Friday 2026; runtime settings `promoCouponId` "dlnew-bf-2026",
  `promoStartsAt` 2026-11-27T00:00:00Z, `promoEndsAt` 2026-12-01T00:00:00Z exclusive,
  `promoPercentOff` 50, `promoLabel` "first month, ends Mon 30 Nov"): plan Checkouts started
  inside the window get the Stripe coupon automatically (no code; duration "once", so renewals
  are full price); `/web/plans` and `/v1/plans` show `promo` and each plan's `promoPriceUsd`. A
  coupon Stripe refuses never fails Checkout: it goes on at full price and `promoCouponId` turns
  itself off with an alert. The discount is kept on the paid checkout (admin list `promo`) and
  the welcome email says "Your first month was 50% off. It renews at $X/mo."
- **freeForever** (runtime setting, FREE_FOREVER, GitHub ids, default none): accounts that keep
  their free allowance and level past `freeEndsAt` (no `plan_required`). Moderation, caps,
  suspensions and blocks still apply. `/admin/people` shows `freeForever: true` for them.
- **Terms consent at Checkout** (`checkoutTermsConsent`, CHECKOUT_TERMS_CONSENT, default on): the
  plan Checkout requires Stripe's terms-of-service checkbox with the EU/UK withdrawal waiver ("I
  want my dl.new plan to start right away and understand I lose my 14-day right to withdraw once
  it starts. [Terms](https://dl.new/terms)."); the acceptance time is kept on the paid checkout. Stripe needs a terms URL in
  the account's public details; if it refuses, Checkout goes on without the consent and the
  setting turns itself off (logged, alerted) until the owner sets the URL and turns it back on.
- **Free trials** (`trials.ts`, `trial-web.ts`; docs/web-api-paid.md §10). A card trial on
  every plan's Checkout (20M tokens at 95.5% caching, 1,282,000 counted; $0 now; the plan
  starts with `trial_end=now` when they're used, or by Stripe after 30 days; the launch coupon
  goes on that first real charge) and a no-card trial after GitHub on dl.new/trial (10M, 641,000
  counted; one per GitHub account and per verified email; the free tier's account checks).
  DeepSeek only. Global budgets `trialBudgetUsd` (300) and `noCardTrialBudgetUsd` (200): spent
  plus the projected rest of active trials; full shows "Free trial: fully claimed". Admin:
  `GET /admin/paid/trials`. Needs the webhook event `customer.subscription.trial_will_end`.
- **Keys.** `dl_sk_<account>_<id>_<secret>` tool keys, shown once; old `dlk_` keys unchanged.
- **cli-login.** `POST /v1/cli-login/start` and `/poll` (the CLI), approved on dl.new/cli-login.

### Stripe setup (the owner, once)

1. **Products and prices.** In test mode first:
   `STRIPE_SECRET_KEY=sk_test_… node services/free/scripts/stripe-setup.mjs --webhook https://free.directionallylocal.com/v1/billing/webhook`
   creates "dl top-up" ($1.00 once, bought 2 to 20 at a time), tax-exclusive
   with tax code `txcd_10000000`, and the webhook endpoint, and prints
   `STRIPE_PRICE_TOPUP` and `STRIPE_WEBHOOK_SECRET`. dl Pro needs no Product or Price: Checkout
   prices it inline. For live mode, create the same in the
   Dashboard (the script refuses live keys).
2. **Stripe Tax.** Dashboard → Tax: add the business address and turn on collection where
   registered.
3. **Terms URL.** Dashboard → Settings → Public details: set the terms of service URL
   (`https://dl.new/terms`); the plan Checkout's terms consent needs it.
4. **Customer Portal.** Dashboard → Settings → Billing → Customer portal: allow cancelling
   subscriptions (at period end) and updating payment methods, then save.
5. **Webhook endpoint** (if not made by the script): `https://free.directionallylocal.com/v1/billing/webhook`
   with the events `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`,
   `customer.subscription.updated`, `customer.subscription.deleted` and (for dl.new's card
   trials) `customer.subscription.trial_will_end`.
6. **Secrets and vars:** `wrangler secret put STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`;
   vars `STRIPE_PRICE_TOPUP` and dl.new's plans `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PLUS`,
   `STRIPE_PRICE_MAX` (`STRIPE_PRICE_PRO` is no longer read). Without the secret key, the billing endpoints
   answer `billing_unavailable` and everything else works as before.

### Google sign-in setup (the owner, once)

"Continue with Google" on dl.new (`src/google.ts`; contract in `docs/web-api-paid.md` § Google)
is off until both values are set; while off, `/web/auth/google*` answer 404 and `/web/plans`
says `signIn.google: false`, so the pages hide the button.

1. **OAuth consent screen** (Google Cloud → Google Auth Platform): External, app name `dl.new`,
   home page `https://dl.new`, privacy policy `https://dl.new/privacy`, terms `https://dl.new/terms`,
   authorized domains `dl.new` and `directionallylocal.com`. Scopes: `openid`, `.../auth/userinfo.email`,
   `.../auth/userinfo.profile` (all non-sensitive: no verification review). Publish it ("In production").
2. **OAuth client**: type *Web application*. Authorized redirect URI (exact):
   `https://free.directionallylocal.com/web/auth/google/callback` (`<PUBLIC_URL>/web/auth/google/callback`).
   Authorized JavaScript origins: none needed (the browser never calls Google from a page; the
   service does the code exchange).
3. **Secrets and vars:** var `GOOGLE_CLIENT_ID`, `wrangler secret put GOOGLE_CLIENT_SECRET`.

## The queue for free tokens

From the open launch, sign-up is never a hard block for new people. While **this week's free
spend is at or above `QUEUE_THRESHOLD` (0.8) of the weekly cap**, or anyone is already waiting, a
new open sign-up still gets an account (identity, referral link, own-key use, paid plans) but is
queued for free tokens, in order. People already in keep their allowance for the week. Invited
people and admins are never queued: an invite is the owner's own choice.

**With Luminal serving** (`primaryUpstream` is `luminal` and `LUMINAL_API_KEY` is set), the queue
also watches Luminal credit: a new open sign-up waits once
**this week's free Luminal credit spend reaches `QUEUE_THRESHOLD` (0.8) of
`LUMINAL_WEEKLY_CREDIT_USD` ($250)**. The weekly cap test above (free spend on every provider)
still applies as well. Monday's
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
  tokens are free tokens: their cost counts within the weekly budget. This is the bonus for
  grandfathered accounts.
- **Trial bonus:** for an account on [the new-user trial](#the-new-user-trial), referrals add to
  the one-time trial instead. Each `ok` referral whose referred friend has been weekly active in
  any week adds `REFERRAL_BONUS_TOKENS` (10M) once to **both** people's trial: the referrer gets
  it per such friend, the referred person once their own referral qualifies (once they have
  been weekly active). Up to `REFERRAL_BONUS_CAP` (50M) per person in all, not per week. It stays
  once earned (being weekly active once is for good), unless the referral stops counting (the
  same network, below). Only a trial account's trial uses it; the weekly bonus is unchanged.
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
(once per balance), and Luminal slowing people down (below). The global caps count free spend on
every provider: OpenRouter cash and OpenAI, Luminal and registry credit (admins and paid usage
left out). Messages:

```
dl free tier: $200 of the $250 weekly cap used (80%). Resets Mon 00:00 UTC.
dl free tier: $500 of the $1,000 all-time cap used (50%). It doesn't reset; free tokens stop at 100% unless the cap is raised.
dl free tier: free tokens paused for everyone by <login> (kill switch).
dl free tier: the queue started ($200 of the $250 weekly cap used). New sign-ups wait in line for free tokens until Monday's admission.
dl free tier: OpenRouter host <slug> failed 9 of 40 requests in the last hour (23%). New requests avoid it while it keeps failing.
dl free tier: $1,600 of the $2,000 Luminal credit used (80%).
dl free tier: requests are refused with upstream_credit_exhausted: $2,000.12 of the $2,000 Luminal credit is used. Top up and raise luminalCreditUsd (POST /admin/config), or switch primaryUpstream to "openrouter".
dl free tier: a session by @<login> (GitHub id <id>) was labelled high risk. (with the description, category and a link to block; once per person per UTC day; only with moderation off or over its daily cap)
dl free tier: auto-blocked @<login> (0.92)   (subject; automated moderation blocked them: verdict, reason, the label, how to unblock)
dl free tier: review @<login>: watch (0.60)   (subject; a review that didn't block; once per person per UTC day)
```

### Plan payment emails

Every dl.new plan event below emails the owner (`ALERT_EMAIL` to `ALERT_EMAIL_TO` only, from
"dl.new"; `src/owner-payment-alerts.ts`), once per Stripe event id (the Directory's
`owner_payment_alerts` table), whether or not the payment was claimed yet:

| Stripe event | Subject |
|---|---|
| `checkout.session.completed`, card trial | `dl.new: card trial started (Starter)` |
| `checkout.session.completed`, paid | `dl.new: new Plus subscription ($10 first month)` |
| `invoice.paid`, money taken, not the Checkout's own first invoice | `dl.new: payment ($20, Plus renewal)` |
| `customer.subscription.updated`, price changed | `dl.new: upgraded (Plus to Max)` / `downgraded` |
| `customer.subscription.updated`, set to end (`cancel_at_period_end` or `cancel_at`) | `dl.new: cancelled (Max)` / `cancellation undone` |
| `customer.subscription.deleted` | `dl.new: subscription ended (Max)` / `card trial ended unpaid` |

The body is plain text: plan, amount and currency (subtotal, discount, tax), the coupon, the
customer's email, the account (`acct_…`, or "not set up yet") and the Stripe ids. No card details
or secrets. A failed send logs only the error's name and never fails the webhook.

### Runway alerts

The threshold alerts above say when money has gone; the runway alerts (`src/runway.ts`) say
before it does. The 10-minute cron (the speed probes' trigger) checks three things and emails the
owner through the same channels as every alert:

- **Weekly pace:** this week's free spend (what the global caps count), at the faster of the
  week's average (over at least a day) and the last 24 hours, passes `globalWeeklyUsdCap` before
  Monday 00:00 UTC.
- **Provider credit:** a provider's credit left (OpenAI, Luminal and each registry provider with a
  balance) lasts fewer than `runwayAlertDays` days (default 7) at the last 24 hours' burn: all its
  usage, admins, paid usage and probes included, since all of it uses the credit.
- **Total cap:** `globalTotalUsdCap` has `runwayTotalCapShare` (default 0.1, so 10%) or less left.

Each condition, each provider apart, is emailed at most once a UTC day while it holds; conditions
that start in the same run share one email. `runwayAlerts` false turns them all off;
`runwayAlertDays` 0 or `runwayTotalCapShare` 0 turns that one check off.

```
dl free tier: runway: weekly cap on pace to be reached (+1 more)   (subject)
- Weekly cap: $210 of $500 spent this week; at $90 a day it is reached around Fri 13:20 UTC, before the week resets Mon 00:00 UTC (projected $615). Free tokens pause for everyone there.
- Liquid Inference credit: $12 of $100 left; at the last 24 hours' $6 it runs out in about 2 days (around Sat 09:00 UTC). Top it up or raise providerCredit.liquid once it is.
```

### Alert email and user email budgets

Owner alerts (and feedback) go through the `ALERT_EMAIL` binding to `ALERT_EMAIL_TO`, a verified
Email Routing destination address. Cloudflare doesn't count sends to verified destination
addresses toward the account's Email Service daily sending limit or monthly quota, on any plan
(https://developers.cloudflare.com/email-service/platform/limits/), so emails to users
(`USER_EMAIL` binding, which does count, failing with `E_DAILY_LIMIT_EXCEEDED` past it; or Resend)
can't use up the owner's alerts. Keep `ALERT_EMAIL_TO` a verified destination address for that to
hold. What could still bury a budget alert is volume in the owner's inbox: access-request emails
stop at `accessRequestEmailsPerDay` (default 20) a UTC day and "Don't have GitHub?" emails at 50,
the rest counted in the next daily digest.

## What people use the service for (use descriptions)

Usage records are counts, and counts can't show abuse: a provider can flag one person (through
the per-person `safety_identifier`) and we couldn't see what they did. So for each session the
service writes **a short automated description of what it is about, and a safety label**
(`src/use-description.ts`). Prompts and code are still never stored.

- **When:** per (person, session id: `x-session-id` or `session_id`), once after the first
  request with a user message, and again at the session's 10th and 30th requests (sessions
  drift).
  A request without a session id is described at most once per person per UTC day. Admins are
  never described.
- **Input:** the latest user message's text (whole up to 1,500 characters; longer, its first 750
  and last 750 joined by `[…]`, so harmless padding in front can't hide the request), the last
  300 characters of the user message before it (labelled), and the names (never the arguments)
  of up to 10 tool calls in the request. Never the system prompt, older messages, files or tool
  outputs.
- **Keyword matches:** when the security pre-check (below) matches a request, on any model, a
  description is stored without a model call: `use` "Keyword match: <rule>", model `keyword`,
  with the matching rule's own category and risk (`low` or `high`; see
  [detection rules](#detection-rules-detection_rules-private)). At most once per (person, session, rule) per UTC day; a
  high one alerts the owner like any high label. Off with `useDescriptions`; never for admins.
- **Model:** DeepSeek V4.1 Flash on the company key: Luminal, or OpenRouter where Luminal has no
  key or credit. Temperature 0, a ~60-token answer (on Luminal, where DeepSeek's reasoning
  counts as output, asked for low reasoning effort with 240 tokens of room for it). It answers
  `{"use": "<40–60 characters>", "risk": "none|low|high", "category": "<coding, data, writing,
  research, security-defensive, security-offensive, malware, credential-theft, spam, fraud or
  other>"}`, judged by the labeller policy (`labellerPolicy` in
  [detection rules](#detection-rules-detection_rules-private)). `use` is cut to 60 characters on one line; an unknown category is `other`; an answer
  that doesn't parse stores nothing.
- **Never the person's words:** quoted spans are cut out of `use` (as for reviewer reasons), and
  so is every run of 4 or more words in a row it shares with the text the labeller was shown
  (ignoring case and punctuation), each replaced by `[…]`. If under two words are left, `use` is
  "Description withheld: it quoted the request"; the risk and category are kept.
- **Off the request path:** it runs beside the request and the request never waits for it, so
  it can't slow or fail anyone's request. The portable runtime has no `waitUntil` (see
  `docs/plans/portable-services.md`), so the work starts with the upstream call and runs while
  the answer streams; a failure, a timeout (20 s) or a cut-short run just means no description.
- **Caps:** at most 20 calls per person per UTC day and `useDescriptionDailyCap` (2000) across
  everyone; `useDescriptions` false turns it off (both runtime settings).
- **Cost:** never a person's allowance and never the free caps. It goes in `spend_weeks`'
  internal bucket (`internal_usd` for OpenRouter cash, `internal_credit_usd`, `internal_tokens`,
  `internal_requests`), and Luminal's share also in `credit_usd`, so the credit balance stays
  true. `GET /admin/spend` shows it as `internal`.
- **Storage:** `use_descriptions` in the Directory: GitHub id, session id, client (`autopilot`,
  `opencode` or `claude-code`; null on older rows), day, the description, risk, category, model
  and time. Claude Code's session is its `x-claude-code-session-id`, else the session in its
  `metadata.user_id`, the same key the token allocator counts. Kept 90 days. Per-session request counts (`use_sessions`) and
  per-day call counts (`use_calls_daily`) are kept a week.
- **Admin:** `GET /admin/people` has `use` (the latest description), `useAt` and
  `worstRiskThisWeek` per person. `GET /admin/uses?days=7&risk=high` lists descriptions newest
  first (`githubId`, `login`, `sessionId`, `client`, `use`, `risk`, `category`, `model`, `at`); `risk` is
  that risk or worse (`none`, the default, is all), and it also takes `githubId` and `limit`
  (1–1000, default 200). The admin home has a **Flagged use** card: low and high risk in the last
  7 days, high first.
- **Alert:** a `high` label starts an automated moderation review (below). With `moderation`
  off, or past its daily cap, it emails the owner (the usual alert channels) once per person per
  UTC day with the login, the description, the category and a link to block on the Tools page.
- **Limits:** the label is a cheap model's guess from one message; a person can word a message to
  avoid it. It is a signal, not a verdict: by itself it only keeps security work off GPT-6
  (below); a block comes only from the moderation review, which weighs the whole case.

## Automated moderation review

A `high` label (a model description or a keyword match) used to email the owner and nothing more,
so every block was by hand. Now it starts a **moderation review** (`src/moderation.ts`), beside
the request and never awaited by it:

- **The case:** the flagged request's text as the labeller or the pre-check saw it (cut to 12,000
  characters, its start and end; in flight only, never stored); the person's labels over the last
  30 days (use, risk, category, model, day; at most 100 shown), their keyword hits by category and
  number of sessions; their account signals (GitHub account age, public repos, followers,
  contributions, level, networks, when they joined) and earlier moderation verdicts.
- **The reviewer:** DeepSeek V4.1 Flash on the company key, the same call path and internal
  accounting as use descriptions (never a person's allowance). Its policy (what to block, pass
  and watch, and how to weigh the history) is `moderationPolicy` in
  [detection rules](#detection-rules-detection_rules-private): private in production, generic by
  default. It answers `{"verdict": "block|watch|pass", "confidence": 0..1, "reason"}`, the reason
  in its own words: it is told never to quote the person and to use no quotation marks.
  Anything that doesn't parse, an error or a timeout (30 s) is `watch` with confidence 0 and reason
  "review failed": never a block. Why is stored on the decision as `error` and logged as one line
  (`moderation review failed: <code>`, never content): `no_provider`, `timeout`, `http_<status>`,
  `network`, `empty_answer`, `unparsable`, or `unfinished` for a review claimed but never finished.
- **Runs past the response:** the review (like the use description) is handed to the request's
  execution context (`waitUntil` on Workers), so it finishes after a short response has been sent;
  without that, Workers cancels it when the response ends.
- **The action:** `block` with confidence at least `moderationBlockConfidence` (0.85), with
  `moderation` "enforce", for someone not an admin and not in `moderationAllowlist`, blocks the
  person and revokes their sign-ins and server keys (the admin block and revoke-tokens code path;
  the config log shows `moderation` as who did it). A blocked person gets the usual `blocked`
  refusal, which says how to get in touch. "shadow" decides and emails but never blocks.
- **The email:** an auto-block is always emailed (`auto-blocked @login (0.92)`), with how to
  unblock (Tools, Block or unblock, or `POST /admin/people/<id>/unblock`). Any other block or
  watch verdict is emailed at most once per person per UTC day (`review @login: watch (0.60)`),
  with how to block. A `pass` sends nothing; the daily digest counts reviews by verdict.
- **Limits:** one review per person per `moderationCooldownMinutes` (60) unless the new label's
  category is different (a label inside the cooldown is covered by the last review, and sends
  nothing); `moderationDailyCap` (300) reviews a UTC day, past which a high label gets the plain
  alert above.
- **Storage:** `moderation_decisions` in the Directory: GitHub id, the label's id and session id,
  category, verdict, confidence, the reviewer's reason (at most 200 characters), the action,
  model, the failure code (if any) and time. Never the request's text nor any of the person's
  words: no evidence bullets are asked for or kept, and anything inside quotation marks or code
  marks is cut out of the reason before it is stored or emailed. Kept 90 days. (The `signals`
  column once held evidence bullets; it is emptied once on startup and always `[]` now, and
  quoted spans are cut from reasons stored before, allocator reasons included.)
- **Admin:** `GET /admin/moderation?days=7&verdict=block` lists decisions newest first
  (`login`, `githubId`, `verdict`, `confidence`, `reason`, `action`, `category`,
  `sessionId`, `labelId`, `model`, `error`, `at`); `verdict` is optional, `limit` 1–1000 (default 200).
  `action` is `blocked`, `shadow`, `allowlisted`, `admin`, `already_blocked` or `none`.

**Security work kept off GPT-6** (`src/security-route.ts`). OpenAI counts security requests on
GPT-6 against our organisation, so security work, defensive or offensive, is served by DeepSeek
only. A (person, session) is held off GPT-6, and the person with it for the rest of the UTC day,
when:

- its use description has category `security-defensive`, `security-offensive`, `malware` or
  `credential-theft`, or risk `high` (any category); the description comes after the session's
  first request, so this covers the requests after it; or
- before a GPT-6 request is forwarded, the request's text matches one of the keyword rules
  ([detection rules](#detection-rules-detection_rules-private): private in production, a few
  generic ones by default): local regular expressions, no network call. It reads every user message (string content and
  text parts) and every tool result (`tool` messages, `tool_result` parts), up to 64 KB of text
  per request; a part longer than its share of that is read from both its start and its end, so
  padding can't push a request out of view. Each part is matched on its own: a rule matches
  when all of its patterns match the same part, and a `high` rule wins over an earlier `low` one.

A held GPT-6 request (any GPT-6 model, also through OpenCode; Claude Code through dl only ever
gets DeepSeek) is refused like the weekly GPT-6 limit: 402 `gpt_limit` with `family: "gpt6"`,
`reason: "security"`, `resetsAt` the next UTC midnight and `alternative` DeepSeek, without
`offers` (Pro doesn't lift it), and the message "GPT-6 isn't available for security work on the
free tier. DeepSeek V4.1 Flash still works: switch with /model." DeepSeek requests and admins are
never affected; `securityOffGpt6` (`SECURITY_OFF_GPT6`, default true) turns it off. Holds are in
`gpt6_holds` (a week); each refused request is counted in `security_refusals_daily` (day,
person, session, count; 90 days), shown on the admin home ("Security sessions kept off GPT-6: N
today") and per day in `GET /admin/metrics` (`securitySessionsOffGpt6`,
`securityRefusalsOffGpt6`).

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
only this cron and the speed probes' (`*/10 * * * *`, see "Speed probes"); the weekly queue needs none (it runs on the first request of the week). The
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

## Token allocator

`src/allocator.ts`, stored by `src/allocator-store.ts`. With `allocator` on, every account that
isn't blocked gets at least `allocatorStartTokens` (1M) a week, including accounts that had no
free tokens (Starter with 0, or batch-flagged). Allowances above that stay as they are: the
allocator only raises.

When a free request leaves a Starter or basic account at `allocatorTriggerShare` (80%) of its
weekly tokens, a decision runs beside the request (at most once per person per allowance step
per 24 hours): `openai/gpt-oss-safeguard-20b` on OpenRouter (the company key, provider
`data_collection: "deny"`, low reasoning, temperature 0, `allocatorTimeoutMs`), under the `allocatorPolicy` of `DETECTION_RULES` (a
generic default otherwise). It sees counts and stored labels only, never prompts: use
descriptions (30 days, up to 100), sessions and requests per session from the request log (every
agent's session id, else idle-split runs) and Autopilot's session events, active days and weeks,
request pacing, which agents were used, the allowance and its use, GitHub numbers, networks, the
batch flag and moderation verdicts. It answers `stay`, `10m` or `full` and a short reason in its
own words; quoted spans are cut out of the reason before it is kept (90 days).

Hard rules win: a high-risk label or a moderation block or watch in 30 days can't be raised; farm
signals (batch flag, a device shared with another account, `network_limit`) stop at 10M; one step
at a time (start → 10M → the Full level) unless the GitHub account is a year old and used the
service in two or more weeks; blocked accounts get nothing.

Autopilot, OpenCode (`dl opencode`) and Claude Code (`dl claude`, Anthropic Messages) all go
through the same chat path, so all of this applies to each.

Never stuck on our system: a request refused for tokens waits up to 3 s for a pending decision.
If the allocator is down, slow or failed, the person gets `allocatorGraceShare` (20%) of the
allowance once for the rest of the week.

Decisions and graces are stored in the Directory's `allocator_decisions` (no content) and listed
by `GET /v1/admin/allocator?days=1..90&limit=1..1000` (newest first, with counts per UTC day). The
daily digest has one line: "Allocator: X raised to 10M, Y to full, Z stayed, G graces".

## GPT-6: pre-send checks and the trust gate

Two more checks stand between a non-admin and GPT-6, after the keyword pre-check (security work
kept off GPT-6, above). Both sit in the one chat path every agent's request goes through, so
they apply alike to Autopilot, OpenCode through `dl opencode`, and Claude Code through
`dl claude` (DeepSeek only today; its Anthropic requests are translated into the same path, so
the checks can't be skipped if that changes). DeepSeek requests and admins are never affected.
Both refuse with the GPT-6 limit's refusal (402 `gpt_limit` with `alternative` DeepSeek), which
every client already turns into "switch to DeepSeek".

**Pre-send checks** (`src/presend-guard.ts`). Before a GPT-6 request is forwarded, its new
content is checked by two classifiers at once, each with `gpt6GuardTimeoutMs` to answer:

- OpenAI's Moderation API (`omni-moderation-latest`, the OpenAI key): flagged stops it.
- `openai/gpt-oss-safeguard-20b` on OpenRouter (the OpenRouter key, provider
  `data_collection: "deny"` always, whatever `OPENROUTER_DATA_COLLECTION` says), given the policy in
  `DETECTION_RULES`'s `guardPolicy` (private; a generic default is in the code). It answers 1
  (violates) or 0. Its cost goes to internal spend, never a person's allowance.

New content is the latest user message plus every tool result after the last assistant turn,
read the same way from chat completions messages, Anthropic content blocks (`tool_result`) and
Responses input items (`function_call_output`); never system, developer or assistant text. It
is cut to 12,000 characters, long parts read from both ends.

The checks fail closed: a flag, an error, an answer that isn't 1 or 0, or no answer in time, and
the request is not sent to OpenAI (`reason` `security`). A flag also holds the session and the
person's UTC day off GPT-6 (the same hold as security work) and is recorded as a high-risk use
label (model `presend:openai` or `presend:safeguard`), so the moderation reviewer looks at it.
A failure refuses that request only. The log gets the outcome and a reason code
(`openai:timeout`, `safeguard:http_502`, ...), never content. `/admin/metrics` has `gpt6Guard`:
per UTC day, `passed`, `flagged_openai`, `flagged_safeguard` and `error`.

**Trust gate** (`src/gpt6-trust.ts`). Off while `gpt6TrustedWeeklyUsdCap` is 0 (the default).
Above 0, GPT-6 is served only to trusted people (others get `gpt_limit` with `reason` `trust`,
and `/v1/models` leaves GPT-6 out for them); a trusted person on the free plan gets that weekly
GPT-6 budget (a personal cap an admin set still wins; Pro keeps its own). Trusted is any of:

- an admin;
- someone who has paid: a Pro payment or a top-up, or an active Pro subscription;
- someone who earned it, all of: level Full and not flagged by the creation-batch check; active
  (a request or an event) in at least 2 distinct weeks; a real multi-turn session, either at
  least 5 turns by Autopilot's events or, for agents that send no events, one session id (or one
  `dl opencode` run's harness key) with at least 5 requests spread over at least 5 minutes; and
  no high-risk use label and no moderation block or watch in the last 30 days.

A blocked or suspended account is never trusted. The answer is cached per person for an hour;
a new high-risk label or block/watch verdict ends a cached trust at once. `/admin/people` shows
`gpt6Trusted` and `gpt6TrustReasons` per person (`admin`, `paid` or `earned`; or each failing
check: `level`, `batch_flagged`, `weeks`, `multi_turn`, `high_risk_label`, `moderation`,
`inactive`), and `/admin/metrics` has `gpt6Trusted`, how many non-admins are trusted now.

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
| `gpt_limit` | chat (402) | `family: "gpt6"`, `reason`, `resetsAt`, `alternative` (the DeepSeek model id), `offers`: GPT-6's week used up, DeepSeek's not; also `reason` `security` (security work, or the pre-send checks) and `trust` (the trust gate), without `offers` |
| `trial_ended` | chat (402) | `trial` (`{tokens, used, remaining, ended}`), `offers`: a trial account used its one-time trial |
| `quota_exceeded` | chat (402) | `reason: "tokens" \| "spend"`, `family: "gpt6" \| "deepseek"`, `resetsAt`, `offers`, `referralLink` |
| `basic_limit`, `starter_limit` | chat (402) | `reason: "tokens" \| "spend"`, `family: "gpt6" \| "deepseek"`, `resetsAt`, `request`, `offers`, `referralLink` |
| `below_bar` | chat (403) | `contact`, `request` |
| `free_tier_queued` | chat (402) | `position`, `etaAt`, `offers`, `referralLink` |
| `upstream_credit_exhausted` | chat (503) | `reason: "credit_exhausted"`, `pausedForEveryone: true`, `resetsAt: null` |
| `upstream_busy` | chat (429, `Retry-After`) | `retryAfter`, `retryable: true`, `upstream: "luminal"` |
| `upstream_unavailable` | chat (503, `Retry-After`) | `retryAfter`, `retryable: true`, `upstream: "luminal"` |
| `upstream_timeout` | chat (503, `Retry-After`) | `retryAfter`, `retryable: true`, `upstream: "luminal"` |
| `dl_only` | chat (403) | none |
| `harness_not_allowed` | `POST /v1/harness-keys`, `/anthropic/v1/messages`, `/v1/chat/completions` with an OpenCode key (403) | none: `allowOtherHarnesses` is off |
| `harness_limit` | `/anthropic/v1/messages`, `/v1/chat/completions` with an OpenCode key (402) | `harness`, `share`, `resetsAt` (not for the trial), `offers`: that tool's share of the week or trial is used, the account's isn't |
| `invalid_harness_key` | `/anthropic/v1/messages`, `/v1/chat/completions`, `/v1/models`, `/v1/events`, harness key refresh (401) | none: expired, revoked, or its sign-in ended |
| `harness_key_limit` | `POST /v1/harness-keys` (409) | `max` |
| `provider_limit` | chat (402) | `reason`, `provider`, `family`, `resetsAt`, `alternative`; reason `autopilot_only` (GPT-6 from another agent's harness key) also has `clients: ["autopilot"]` |
| `server_keys_unavailable` | `POST /v1/keys`, and any request with a server key (403) | none |
| `tool_keys_unavailable` | `POST /v1/keys {kind: "tool"}` (403) | none: the account has no free tokens (below the bar), or isn't active |
| `tool_keys_off` | `POST /v1/keys {kind: "tool"}`, and any request with a tool key (403) | none: `toolKeys` is off |
| `tool_key_not_allowed` | a tool key on a route other than chat, models, `/v1/me` and the Anthropic endpoint (403) | none |
| `not_invited` | API, and older sign-ins | none |

The two global budget codes mean "free tokens are paused for everyone, and your own key still
works". The weekly one says when free tokens come back. The total one has no reset time: free
tokens come back only if the owner raises the cap.

### Refusal counts (`refusals_daily`)

Every sign-in refusal and request gate is counted per UTC day, reason and client
(`src/refusals.ts`), so the cost of each gate is visible. Counts only: the Directory's
`refusals_daily` table holds `(day, reason, client, n, people)` and nothing about who. `people`
is how many distinct accounts met that reason on that client that day, kept with a salted hash
set (`refusal_people`, with a random salt per day in `refusal_salts`); the hashes and the salt
are deleted once the day is over, so only the number stays. Rows older than 120 days are pruned.

- **Clients**: `autopilot` (a sign-in token or server key: plain dl, GPT-6 requests served
  through OpenAI's Responses API included), `opencode` (`dl opencode`'s harness key on
  `/v1/chat/completions`), `claude-code` (`dl claude`'s harness key on `/anthropic/v1/messages`),
  `tool:<name>` (a tool key, named from the tool's User-Agent: `tool:cursor`, `tool:cline`…; see
  [Use dl's free tokens in other tools](#use-dls-free-tokens-in-other-tools-tool-keys)),
  `other` (`dl_only` and `proxy_not_allowed`: the request isn't from dl), and `signin` for the
  browser sign-in.
- **Sign-in reasons**: `invite_page_shown`, `invite_accepted`, `invite_code_invalid`,
  `invite_rate_limited`, `invite_required`, `account_too_new`, `no_github_activity`,
  `few_repos_and_contributions`, `network_limit` and `domain_limit` (a new account placed below Full, and why),
  `event_code_used`, `event_code_invalid`,
  `network_signup_limit`, `cohort_full`, `queued` (placed on the waitlist), `device_taken`,
  `blocked`, `email_blocked`, `email_domain_blocked`, `email_in_use`, `email_domain_daily_cap`,
  `signin_paused`. They are counted on the browser side only, so a terminal polling the same
  refusal doesn't count it twice.
- **Request reasons** (from the refusal's code, on every chat path): `dl_only`,
  `harness_not_allowed` (also when minting a harness key), `harness_limit`,
  `proxy_not_allowed`, `gpt_limit:cap`, `gpt_limit:security_hold`, `gpt_limit:trust` (the GPT-6
  trust gate), `provider_limit:pro_only`, `provider_limit:person_cap`, `provider_limit:provider`,
  `provider_limit:autopilot_only` (GPT-6 from another coding agent),
  `allowance_exhausted:full` (Full or Pro), `allowance_exhausted:basic`,
  `allowance_exhausted:starter`, `trial_ended`, `below_bar`, `api_queued`,
  `global_cap:weekly`, `global_cap:total`, `paused`, `credit_exhausted`, `rate_limited`,
  `model_not_allowed`, `api_not_invited`, `api_blocked`, `api_suspended`.

`GET /v1/admin/metrics` returns `refusals: [{day, reason, client, count, people}]` for its
`from`/`to` window, `/admin/dashboard/refusals.csv` has every kept row, and the admin home has a
"Refusals" card (today, last 7 and last 30 days per reason and client).

## Runtime settings

These settings come from `env`. An admin can override them while the service runs, with no
release. Overrides live in the Directory object, and every change, pauses included, is logged
with who made it and when.

| setting | env | default |
|---|---|---|
| `weeklyTokens` | `WEEKLY_TOKENS` | 50,000,000 |
| `trialCutoff` | `TRIAL_CUTOFF` | unset (trial off): an ISO time with its zone or Unix ms; accounts admitted at or after it are on the trial; `"none"` turns it off |
| `trialTokens` | `TRIAL_TOKENS` | 10,000,000: the one-time trial (prompt with cached, plus completion) |
| `perPersonWeeklyUsdCap` | `PER_PERSON_WEEKLY_USD_CAP` | 2: a Full person's weekly GPT-6 budget (every GPT-6 model) |
| `deepseekWeeklyUsdCap` | `DEEPSEEK_WEEKLY_USD_CAP` | 8: a Full person's weekly DeepSeek budget |
| `proOpenModelsMultiplier` | `PRO_OPEN_MODELS_MULTIPLIER` | 4: Pro's weekly DeepSeek budget as a multiple of `deepseekWeeklyUsdCap` (1 to 100); Pro's GPT-6 budget is the free plan's |
| `grantWeeklyUsdCap` | `GRANT_WEEKLY_USD_CAP` | 20: the personal weekly dollar cap an admin's grant gives (never lowers a higher one); 0 or `none`: a grant sets only the level |
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
| `weeklyResetEmail` | `WEEKLY_RESET_EMAIL` | true: the Monday "tokens reset" emails (`weekly_reset` for free tokens, `plan_reset` for paying accounts once `freeEndsAt` has passed); false stops them alone (`userEmails` off stops them too) |
| `userEmailsDailyMax` | `USER_EMAILS_DAILY_MAX` | 300: emails to users a UTC day, every kind but codes (`src/email-budget.ts`; conservative, the provider's quota isn't known) |
| `userEmailsTransactionalReserve` | `USER_EMAILS_TRANSACTIONAL_RESERVE` | 100: of `userEmailsDailyMax`, kept for transactional mail (dl.new's claim and welcome emails, `plan_80`, access answers); bulk and lifecycle mail and broadcasts stop short of it |
| `emailCodesDailyMax` | `EMAIL_CODES_DAILY_MAX` | 300: dl.new sign-in and email-change codes a UTC day; outside `userEmailsDailyMax`, never stopped by it |
| `broadcastEmailProvider` | `BROADCAST_EMAIL_PROVIDER` | `resend`: with `RESEND_API_KEY` set beside the `USER_EMAIL` binding, bulk mail (broadcasts and lifecycle emails) goes through Resend and codes and transactional mail stay on the binding; `cloudflare` keeps everything on the binding |
| `resendBulkDailyMax` | `RESEND_BULK_DAILY_MAX` | 2000: bulk mail through Resend a UTC day (with `broadcastEmailProvider` `resend`); its own ceiling, outside `userEmailsDailyMax` |
| `dlOnly` | `DL_ONLY` | false: free tokens work in any coding agent. True: a dl sign-in token works only with dl's session events (tool keys are never refused by it; see below) |
| `toolKeys` | `TOOL_KEYS` | true: accounts in good standing may make API keys for other tools; false refuses new and existing ones (`tool_keys_off`, the keys are kept) |
| `toolKeysMax` | `TOOL_KEYS_MAX` | 3: tool keys per account (server keys are counted apart) |
| `toolKeyRequestsPerMinute` | `TOOL_KEY_REQUESTS_PER_MINUTE` | 30: chat requests a minute per tool key, under the person's 60 |
| `allowOtherHarnesses` | `ALLOW_OTHER_HARNESSES` | true: Claude Code through `dl claude` and OpenCode through `dl opencode` may use free tokens; false refuses both (`harness_not_allowed`) |
| `otherHarnessShare` | `OTHER_HARNESS_SHARE` | 1: the share (0 to 1) of the free weekly allowance and of the trial other agents (Claude Code, OpenCode, Pi, tool keys) may use; 1 is the full allowance, the same as Autopilot; Pro is exempt (see below) |
| `proOffered` | `PRO_OFFERED` | true: dl Pro is offered. false hides it from everyone new: `offers` has no `pro` (the `topup` stays), free users' refusals, sign-in lines and trial emails stop naming Pro, and a new Pro checkout gets 403 `pro_not_offered`. Existing subscribers keep Pro, their Pro wording and the billing portal |
| `accessRequestAlerts` | `ACCESS_REQUEST_ALERTS` | `each` (an email per access request, at most `accessRequestEmailsPerDay` a UTC day, the rest in the daily digest); `daily` (one line in the daily digest); `off` |
| `accessRequestEmailsPerDay` | `ACCESS_REQUEST_EMAILS_PER_DAY` | 20: with `each`, access-request emails a UTC day at most |
| `runwayAlerts` | `RUNWAY_ALERTS` | true: the [runway alerts](#runway-alerts) |
| `runwayAlertDays` | `RUNWAY_ALERT_DAYS` | 7: a provider is reported when its credit lasts fewer days than this at the last 24 hours' burn (0 off) |
| `runwayTotalCapShare` | `RUNWAY_TOTAL_CAP_SHARE` | 0.1: the global total cap is reported with this share of it or less left (0 to 1; 0 off) |
| `noGithubAlerts` | `NO_GITHUB_ALERTS` | `each` (an email per "Don't have GitHub?" click and answer, at most 50 a UTC day, the rest in the daily digest); `daily` (one line in the daily digest); `off` |
| `useDescriptions` | `USE_DESCRIPTIONS` | true: a short automated description and safety label per session (see [use descriptions](#what-people-use-the-service-for-use-descriptions)) |
| `useDescriptionDailyCap` | `USE_DESCRIPTION_DAILY_CAP` | 2000: description calls a UTC day across everyone (0 stops them) |
| `rawLogKeepDays` | `RAW_LOG_KEEP_DAYS` | 35: whole UTC days of the raw request log and session events kept (see [raw log retention](#raw-log-retention)); 31 to 400. There is no "keep everything": 0, or a value over 400 set before the cap, keeps 400 |
| `securityOffGpt6` | `SECURITY_OFF_GPT6` | true: security work is served by DeepSeek only, never GPT-6 (see [security work kept off GPT-6](#what-people-use-the-service-for-use-descriptions)) |
| `gpt6PresendGuard` | `GPT6_PRESEND_GUARD` | `enforce`: GPT-6 requests are checked before they are sent (see [GPT-6: pre-send checks and the trust gate](#gpt-6-pre-send-checks-and-the-trust-gate)); `off` |
| `gpt6GuardTimeoutMs` | `GPT6_GUARD_TIMEOUT_MS` | 4000: ms each pre-send check may take; past it the request isn't sent |
| `gpt6TrustedWeeklyUsdCap` | `GPT6_TRUSTED_WEEKLY_USD_CAP` | 0: the trust gate is off; above 0, GPT-6 only for trusted people, with this weekly budget on the free plan |
| `gpt6Clients` | `GPT6_CLIENTS` | `autopilot`: GPT-6 only in Autopilot, pending the model provider's approval (see [GPT-6 in Autopilot only](#gpt-6-in-autopilot-only)); `all`: every coding agent dl launches |
| `moderation` | `MODERATION` | `enforce`: high-risk labels get an automated review that can block (see [automated moderation review](#automated-moderation-review)); `shadow` decides and emails, never blocks; `off` is the plain high-risk email |
| `moderationBlockConfidence` | `MODERATION_BLOCK_CONFIDENCE` | 0.85: the lowest confidence (0 to 1) a block verdict needs to block |
| `moderationAllowlist` | `MODERATION_ALLOWLIST` | []: GitHub logins or ids moderation never blocks (comma-separated in env) |
| `moderationCooldownMinutes` | `MODERATION_COOLDOWN_MINUTES` | 60: minutes before the same person is reviewed again for the same category |
| `moderationDailyCap` | `MODERATION_DAILY_CAP` | 300: reviews a UTC day across everyone; past it, the plain high-risk email (0 stops reviews) |
| `allocator` | `ALLOCATOR` | `on`: the [token allocator](#token-allocator) (start grant, raises with real use); `off` |
| `allocatorStartTokens` | `ALLOCATOR_START_TOKENS` | 1,000,000: every account's weekly start grant (never lowers a higher allowance; blocked accounts get nothing) |
| `allocatorTriggerShare` | `ALLOCATOR_TRIGGER_SHARE` | 0.8: the share of the week's allowance that starts a decision |
| `allocatorTimeoutMs` | `ALLOCATOR_TIMEOUT_MS` | 5000: how long the allocator's answer is waited for |
| `allocatorGraceShare` | `ALLOCATOR_GRACE_SHARE` | 0.2: the one-time weekly grace when the allocator is down, slow or failed |
| `starterWeeklyTokens` | `STARTER_WEEKLY_TOKENS` | 50,000,000, as Full (0: no free tokens below Basic) |
| `starterWeeklyUsdCap` | `STARTER_WEEKLY_USD_CAP` | 2 (GPT-6), as Full |
| `starterDeepseekWeeklyUsdCap` | `STARTER_DEEPSEEK_WEEKLY_USD_CAP` | 8, as Full |
| `basicMinAccountAgeDays` | `BASIC_MIN_ACCOUNT_AGE_DAYS` | see `src/config.ts` (a generic default; production's comes from `DETECTION_RULES`) |
| `basicWeeklyTokens` | `BASIC_WEEKLY_TOKENS` | 50,000,000, as Full (0 turns Basic off) |
| `basicWeeklyUsdCap` | `BASIC_WEEKLY_USD_CAP` | 2 (GPT-6), as Full |
| `basicDeepseekWeeklyUsdCap` | `BASIC_DEEPSEEK_WEEKLY_USD_CAP` | 8, as Full |

Publicly there is only Free and Pro: by default every free level gets the same budgets, and
nothing a person is shown names a level. The levels stay internal so the settings can differ
later. A batch-flagged account gets 0 of both budgets.

Env only: `REFERRAL_LINK_BASE` (`https://dl.new/r/`), the offers above, `ALERT_EMAIL_TO`,
`ALERT_EMAIL_FROM` (`alerts@dl.new`), `ALERT_WEBHOOK_URL`, `ALERT_WEBHOOK_KIND`,
`ALERT_TELEGRAM_CHAT_ID`, the prices `LUMINAL_PRICE_INPUT`, `LUMINAL_PRICE_CACHED`,
`LUMINAL_PRICE_OUTPUT`, `OPENROUTER_PRICE_INPUT`, `OPENROUTER_PRICE_CACHED`,
`OPENROUTER_PRICE_OUTPUT`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `USER_EMAILS_TO_ADMINS`, `TRUST_X_FORWARDED_FOR`, and the
secrets `OPENAI_API_KEY`, `LUMINAL_API_KEY`, `RESEND_API_KEY` and `DETECTION_RULES` (below).

The farm-detection settings (`humanSignalsNeeded`, `minActiveWeeks`, `minRepoAgeDays`,
`minSocial`, `minFollowers`, `batchWindowDays`, `batchSize`, `batchDensityFactor`,
`basicMinAccountAgeDays`, `domainSignupsPerDay`) start from the `DETECTION_RULES` secret's `thresholds` when it sets them:
their env var still wins over it, and an admin override over both. The defaults in
`src/config.ts` are generic starting values, not production's.

## Detection rules (`DETECTION_RULES`, private)

The anti-abuse machinery is public; the rules it runs are not, because published rules can be
read by the farms they are meant to catch, which then tune themselves to stay just under them.
So the rules come from one private secret, `DETECTION_RULES` (`src/detection-rules.ts`), read
with the rest of the config, and the code carries only a small generic default set: enough for
tests, local development and self-hosting, never the production values.

```json
{
  "keywords": [
    { "id": "rule-id", "pattern": "regex", "flags": "i", "category": "security-offensive", "risk": "low" },
    { "id": "other-rule", "pattern": ["regex", "regex"], "category": "malware", "risk": "high" }
  ],
  "proxyRouters": ["regex"],
  "labellerPolicy": "What the use-description labeller should call high, low and no risk.",
  "moderationPolicy": "What the moderation reviewer should block, pass and watch, and how to weigh the case.",
  "allocatorPolicy": "What the token allocator should count as real use worth a raise.",
  "guardPolicy": "What the GPT-6 pre-send safeguard should answer 1 (violates) and 0 for.",
  "thresholds": { "batchSize": 10, "minFollowers": 1 }
}
```

- **`keywords`**: the security pre-check's rules. A rule matches when every pattern in
  `pattern` (one string or a list) matches the same text. `flags` defaults to `i` (only `i`, `m`,
  `s` and `u`). `category` is a use-description category and `risk` is `low` or `high`; a match
  is recorded as "Keyword match: <id>" with them, and a `high` one starts a moderation review.
  Keep ids stable: they show in the admin pages.
- **`proxyRouters`**: case-insensitive patterns for account-pooling routers, matched against the
  session id and the user agent (`proxy_not_allowed`).
- **`labellerPolicy`**, **`moderationPolicy`**, **`allocatorPolicy`**: the policy part of the
  three model prompts (the last is the [token allocator](#token-allocator)'s). Deploy a version
  that knows `allocatorPolicy` before putting it in the secret: older versions refuse unknown
  fields and would ignore the whole secret. The rest of each prompt (what the model is given and the JSON it must answer) stays in the code.
- **`guardPolicy`**: the whole system prompt of the GPT-6 pre-send safeguard. It must end by
  asking for exactly one character, 1 or 0: any other answer fails closed. Like
  `allocatorPolicy`, deploy a version that knows it before putting it in the secret.
- **`thresholds`**: starting values for the farm-detection settings listed above.

Every field is optional, and a field that is present **replaces** its default whole (a secret's
keyword list is the whole list). A secret that isn't valid JSON or fails validation (an invalid
regex, an unknown field, an empty keyword list…) is ignored as a whole: the service logs the
reason once (never the content), runs on the defaults, and never crashes or turns detection off.

`GET /admin/config` has `detectionRules`: `source` (`secret`, `defaults` when unset, `invalid`
when ignored, with `error`), counts of `keywords`, `highRiskKeywords`, `proxyRouters` and
`thresholds`, and whether each policy (`labellerPolicy`, `moderationPolicy`, `allocatorPolicy`, `guardPolicy`)
came from the secret. Never the rules themselves.

```sh
# Set or replace the rules (from a file kept outside any repository)
wrangler secret put DETECTION_RULES < private-detection-rules.json
# Then check they loaded
curl -H "authorization: Bearer $ADMIN_TOKEN" https://free.example.com/admin/config | jq .detectionRules
```

Upload the secret before deploying code that depends on it, so production never runs on the
generic defaults. Refresh the production rules from time to time rather than keeping one list
forever: earlier versions of this repository published older rules.

```sh
# Read the effective values, the env values, the overrides and the change log
curl -H "authorization: Bearer $ADMIN_TOKEN" https://free.example.com/admin/config

# Set values. null goes back to the env value; USD caps also take "none" (no cap).
curl -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"weeklyTokens": 60000000, "globalWeeklyUsdCap": 300, "openAdmission": null}' \
  https://free.example.com/admin/config
```

## GPT-6 in Autopilot only

OpenAI's usage policies ask for its review before a service lets third parties access its models
directly; an app that uses them to power its own features doesn't need it. Until that review, free
GPT-6 (`gpt-6-luna`, `gpt-6.1-sol`, `gpt-6-astra`) is served only inside Autopilot, our own app
(`src/gpt6-clients.ts`), and every other agent gets DeepSeek:

- **Autopilot** is a sign-in token or a server key (the dl-only check keeps those to dl). It
  gets every model as before.
- **Other agents** are what dl launches with a harness key: `dl opencode`, `dl pi`, `dl claude`,
  `dl t3`, and `dl proxy` for Conductor and other desktop apps. Their GPT-6 request gets HTTP 402
  `{"error": {"code": "provider_limit", "reason": "autopilot_only", "family": "gpt6", "provider": "openai", "resetsAt": null, "alternative": "deepseek/deepseek-v4.1-flash-1017", "clients": ["autopilot"], "message": "GPT-6.1 Sol is available in Autopilot for now; other agents use DeepSeek V4.1 Flash."}}` (the message names the model asked for)
  before anything is reserved or sent, counted as `provider_limit:autopilot_only` under the
  agent. Their `/v1/models` and the unknown-model refusal's `allowed` leave GPT-6 out. Claude Code
  through dl is DeepSeek only either way.
- **Admins** pass, so GPT-6 can still be tested in other agents.
- **`/v1/me`** answers only sign-in tokens and server keys, so it is unchanged. `/v1/providers`
  keeps GPT-6 listed (`access: "trusted"`) with `clients: ["autopilot"]`.
- **`gpt6Clients`** (`GPT6_CLIENTS`, runtime setting): `autopilot` (the default) or `all`, which
  serves GPT-6 to every agent as before, once OpenAI has approved it.

## Claude Code and OpenCode through dl claude and dl opencode

`dl claude` runs the person's own Claude Code against this service, and `dl opencode` their own
OpenCode. Three pieces:

**Harness keys** (`src/account-object.ts`, `src/app.ts` `harnessKeys`). Short-lived keys for one
`dl claude` or `dl opencode` run, `dlh_<githubId>_<id>_<secret>` (only the secret's SHA-256 is
stored), each for one harness (`claude-code` or `opencode`):

| request | response |
|---|---|
| `POST /v1/harness-keys {"harness": "claude-code" \| "opencode"}` (a signed-in access token only) | 201 `{id, key, harness, expiresAt, ttlSeconds: 900, otherHarnessShare}` (that tool's part of the allowance, 0 to 1; 1 by default, the same as Autopilot) |
| `POST /v1/harness-keys/:id/refresh` (the access token, or that key) | `{id, expiresAt}`: another 15 minutes |
| `DELETE /v1/harness-keys/:id` (the access token, or that key) | `{id, revoked: true}` |

A key expires 15 minutes after it was made or last refreshed; dl refreshes it every 4 minutes
while the tool runs and deletes it when the tool exits. Signing out of the sign-in it was
minted from ends it, as does an admin's revoke-tokens. At most 10 live per account
(`harness_key_limit`). A Claude Code key works only on `/anthropic/v1/messages`, `count_tokens`
and `/v1/events`; an OpenCode key only on `/v1/chat/completions`, `/v1/models` and `/v1/events`.
Neither works on `/v1/me` or `/v1/keys`.

**OpenCode** speaks chat completions, so its requests take Autopilot's path unchanged: DeepSeek
(GPT-6 too only while `gpt6Clients` is `all`, see below), streaming, and every refusal, with the share, the kill switch and the dl-only check below applied as for Claude
Code. Refusal messages are reworded for OpenCode (`forHarness`: "run dl and type /upgrade",
"pick it in /models"). `/v1/models` also says whether each model reads images (`vision`); dl
configures OpenCode from it.

**The Anthropic Messages endpoint** (`src/anthropic.ts`). dl sets
`ANTHROPIC_BASE_URL=<service>/anthropic`, so Claude Code posts to `/anthropic/v1/messages?beta=true`
with the key as `Authorization: Bearer` (`x-api-key` works too). The request is translated into
a chat completions body for `deepseek/deepseek-v4.1-flash-1017` (whatever model it names: GPT-6
is never served to Claude Code) and goes through `chat` like any other request: the same
reservation and settlement, dollar budgets, trial, Pro and top-ups, queue, global caps, dl-only
check and refusals. The answer comes back as an Anthropic `message`, or streamed as
`message_start`, `ping`, `content_block_start` / `content_block_delta` (`text_delta`,
`input_json_delta`, `thinking_delta`) / `content_block_stop`, `message_delta` (stop reason and
usage, cache reads as `cache_read_input_tokens`) and `message_stop`. Stop reasons: `end_turn`,
`tool_use`, `max_tokens`, `stop_sequence` (when the upstream says which stop string matched),
`refusal`. The answer's `model` (the message's, and `message_start`'s when streamed) is the model
that answered (`deepseek/deepseek-v4.1-flash-1017`), not the `claude-*` name the request asked
for, and the response carries it in `x-dl-served-model` too, so logs, evals and cost
attribution downstream name the model that produced the output.

- **Supported:** `system` (string or text blocks), text, `tool_use`, `tool_result` (string or
  nested blocks, `is_error`), `tools` with `input_schema`, `tool_choice` (`auto`, `any`, `tool`,
  `none`, `disable_parallel_tool_use`), `max_tokens`, `temperature`, `top_p`, `stop_sequences`,
  `stream`. The model's reasoning comes back as thinking blocks when the request asked for
  thinking, and thinking blocks sent back become `reasoning_content`.
- **Dropped:** images and documents (replaced by a note saying they were left out: DeepSeek reads
  neither), server tools such as web search, `metadata`, `top_k`, `cache_control`, `thinking`
  budgets, `container`, `mcp_servers`.
- **`count_tokens`** (`POST /anthropic/v1/messages/count_tokens`): an estimate, about 4 characters
  a token over the system prompt, messages and tools as JSON. Never charged, never sent upstream.
  Claude Code uses it only for its context meter and works without it.
- **Errors** are Anthropic's shape, `{"type": "error", "error": {"type", "message", "code"}}`, with
  our message (dl's slash commands reworded as "run dl and type /upgrade"). Transient upstream
  errors keep 429/503 and `Retry-After`, which Claude Code retries; refusals a retry can't change
  (a pause for everyone, a global budget) go out as 403 so it doesn't retry them.
- **The share** (`otherHarnessShare`, default 1: the full allowance, the same as Autopilot): below 1,
  Claude Code's and OpenCode's requests see the allowance scaled by it: every token pool, both
  dollar budgets and the trial, while what the week (and the trial) used is counted in full. So
  at 0.5 Claude Code would stop once the account has used half its week, from any client
  (`harness_limit` says so). Past the whole allowance,
  the usual codes. Top-ups and Pro aren't scaled: a Pro subscriber gets the whole Pro allowance in
  Claude Code.
- **Session events:** dl sends `session.start` (before the tool starts, and every 6 hours) and
  `session.end` with the harness key; the service stamps `props.harness` with the key's harness
  (`claude-code` or `opencode`). They cover the dl-only check exactly as Autopilot's events do.
- **Usage:** `requests.harness` is `claude-code` or `opencode` for these requests (counts only), and
  `daily_activity` keeps `harness_requests` and `harness_tokens`. `GET /admin/people` shows
  `otherHarnessThisWeek: {requests, tokens}` per person.

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

With both the binding and `RESEND_API_KEY`, the runtime setting `broadcastEmailProvider`
(default `resend`) splits them by class (`src/email-budget.ts`): sign-in codes and transactional
mail (the claim email, the paid welcome, `plan_80`, access answers, trial emails) stay on the
binding; bulk mail (lifecycle emails, `weekly_reset`, `plan_reset` and `POST
/admin/emails/broadcast`) goes through Resend, with the same sender, Reply-To, stop link and
`List-Unsubscribe` headers, paced at the same 2 requests a second. Bulk mail through Resend is
counted in its own class, `resend_bulk`, against `resendBulkDailyMax` (default 2000 a UTC day),
never against the binding's `userEmailsDailyMax`. A refused Resend send (non-2xx) counts as
failed in the result and is logged with its status only; it never falls back to the binding,
and a 429 stops the broadcast call. `broadcastEmailProvider: "cloudflare"` (POST /admin/config)
puts bulk mail back on the binding and its budget.

| email | when |
|---|---|
| welcome | right after a new sign-up gives their email on the details step; by level: `welcome` (Full), `welcome_basic`, `welcome_starter_small` (a Starter allowance), `welcome_starter` (no free tokens); on the trial, `welcome_trial` (one-time tokens, /upgrade) unless no free tokens |
| access granted | an admin grants the person's access request (`access_granted`, or `access_granted_trial` on the trial; not held back by the one-a-day rule) |
| didn't start | daily run: admitted 24 to 72 hours ago, no request yet |
| most of the week used | the request whose settlement takes the week past 80% of a pool's tokens or of the weekly dollar cap; once a week (not on the trial) |
| most of the trial used | `trial_80`: a trial account's settlement past 80% of its trial tokens; once |
| gone quiet | daily run: requests on 2 or more days, none in the last 7 |
| tokens reset | `weekly_reset`, "{tokens} tokens, reset.": every Monday from 30 Nov 2026, see below |

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
`TOKEN_SIGNING_KEY`'s `unsubscribe` subkey; see [signing keys](#signing-keys)), and carries `List-Unsubscribe` and `List-Unsubscribe-Post` headers for the
same URL. GET shows a page with one button; POST (the button, or a mail app's one-click) sets
`people.email_stop`.

| env | default |
|---|---|
| `USER_EMAIL` (binding) | absent: Resend, if `RESEND_API_KEY` is set |
| `RESEND_API_KEY` (secret) | unset (and no binding): nothing is sent and nothing fails; beside the binding, bulk mail goes through it (`broadcastEmailProvider`) |
| `BROADCAST_EMAIL_PROVIDER` (also the runtime setting `broadcastEmailProvider`) | `resend` |
| `RESEND_BULK_DAILY_MAX` (also the runtime setting `resendBulkDailyMax`) | 2000 |
| `EMAIL_FROM` | `sina <sina@directionallylocal.com>` |
| `EMAIL_REPLY_TO` | `contact@directionallylocal.com` |
| `USER_EMAILS` (also the runtime setting `userEmails`) | true |
| `USER_EMAILS_TO_ADMINS` | false |
| `WEEKLY_RESET_EMAIL` (also the runtime setting `weeklyResetEmail`) | true |

With Resend, `directionallylocal.com` must be verified in Resend (its SPF and DKIM DNS
records). To stop every email without a deploy: `POST /admin/config {"userEmails": false}`.

### Tokens reset (Mondays)

`weekly_reset` goes once a week, after the allowance resets (weeks start Monday 00:00 UTC), to
people who are active (not blocked or suspended), not admins, have an email and haven't pressed
stop, aren't waiting in the queue, made a request in the last 28 days, and have weekly free
tokens: not on the one-time trial, not on Pro, and a weekly allowance above 0. `{tokens}` is the
person's own weekly allowance as `dl status` shows it, said short and rounded down (`1M`,
`1.2M`, `10M`, `50M`); below the Full allowance (`WEEKLY_TOKENS`) it adds "it grows as you use
dl, up to {full} a week." The invite link is the person's own (`https://dl.new/r/<code>`).

It starts at the daily run on Monday (01:00 UTC, after its other emails) and carries on in the
10-minute ticks from 01:30, through Tuesday: each run sends at most 100, and only while the
day's email budget has bulk room (`userEmailsDailyMax` less `userEmailsTransactionalReserve`,
200 by default; see `src/email-budget.ts`). The one-a-day cap
applies, so someone who got another email on Monday gets this one on Tuesday. Never on other
days, never twice a week (the `user_emails` row, period the week's Monday); a failed one is
retried once by the next daily run, within the week. `GET /v1/admin/metrics` has
`weeklyResetEmails: [{week, sent, failed}]` for its range.

`GET /admin/emails/weekly-reset` (admins) is a dry run for this week: it sends and records
nothing, and answers `{week, firstWeek, on, emailsOn, provider, fullTokens, count, belowFull,
skipped: {trial, pro, no_allowance, not_active}, alreadyThisWeek: {sent, failed}, samples}`,
where `count` is who would still get it this week and `samples` are 3 rendered emails (login,
tokens, subject and body, with the calling admin's own stop link).

Paying dl.new accounts get `plan_reset` instead ("Your ~62M tokens reset.": last week per plan
model, the caching rate, the counted math, sessions, failovers, dl.new/usage and dl.new/billing),
in the same window, under the same switches, and only once free tokens have ended (`freeEndsAt`).
The free tier's lifecycle emails (welcome, didn't start, week_80, gone quiet, weekly_reset) and
broadcasts never go to accounts made on dl.new.

### Test email (admins)

`POST /admin/emails/test {"kind": "welcome" | "didnt_start" | "week_80" | "gone_quiet" | "weekly_reset", "to": "<address>"}`
sends one email of that kind to `to`, exactly as a person would get it (copy, sender, Reply-To,
headers, provider), with the calling admin's own stop link (`weekly_reset` as a Full person
sees it, with the admin's own invite link). It records nothing for anyone and
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
is set. The global USD caps count free spend on every provider (see [what the caps count](#upstreams-luminal-and-openrouter)). The per-person
dollar allowance counts every request: OpenRouter's reported cost, or a Luminal request's tokens
at the OpenRouter prices we were billed (see below).

### Failed and cut-off requests

A request reserves its prompt estimate (about 2 bytes a token, on purpose an overestimate) plus
its output cap before it is forwarded. When the provider reports usage, that usage replaces the
reservation. When it reports none, the reservation is **never** charged. Instead:

| What happened | Charged to the person | Recorded against the provider's credit |
| --- | --- | --- |
| Failed before any response (429, 5xx, timeout, network error, refused key); the next upstream tries | nothing | nothing |
| Stream failed or sent an error before any output | nothing | nothing |
| Client cancelled before any output arrived | nothing | the realistic prompt below, no output (OpenAI bills input on a cancelled stream; Luminal and Liquid don't say; Open Relay: nothing) |
| Non-streamed answer that is an error body without usage | nothing | nothing |
| Stream that sent output, then was cut off (client abort, reset, no last chunk) | a realistic prompt at the person's cached share, plus the output streamed, at the model's prices | the same estimate at the provider's prices (Open Relay: nothing; Liquid: its reported charge when it sent one) |
| Reservation the request never settled (the alarm sweeps it after 30 minutes) | nothing | the realistic prompt, no output |

- **Realistic prompt**: the request body at 4 bytes a token (`REALISTIC_BYTES_PER_TOKEN`), half
  the reservation's estimate.
- **Cached share**: the person's own share of cached prompt tokens over everything providers
  reported for them (`account.prompt_seen`, `cached_seen`), once at least 50,000 prompt tokens
  were; until then, the plan mix's share (`PLAN_CACHED_SHARE`, 95.5 / (95.5 + 3.8), about 96%),
  the same default the plan meters use for requests in flight. Assuming an uncached prompt would
  count a new account's cut-off agent turn at 20-50x what it really used. The tokens charged use
  `cachedTokenWeight` as usual. The prompt recorded against a provider's credit alone (cancelled
  before output, abandoned) stays uncached until the person's share is known: our own books
  are better over than under.
- **Output streamed**: counted as the stream passes through, never kept: the content chunks
  (text, reasoning, tool calls) or the characters at 3 a token, whichever says more. So a client
  can't avoid the charge by aborting after a long answer. The stream reads from the upstream
  only as the client reads, so only output handed on is counted.
- **Prices**: always the model's own list prices. The $1 per million tokens fallback
  (`FALLBACK_USD_PER_MILLION_TOKENS`) is only for a model with no known prices.
- A failed attempt followed by a backup (an upstream's `backups`, or a model's fallback) is
  charged nothing; the backup is charged its own usage, once.

Example, a typical DeepSeek agent turn (~400 KB request, ~100k prompt tokens, 96% cached) cut
off after 400 output tokens: before, the whole reservation (~265k tokens, ~$0.27 at $1/M); now
about 6,300 tokens and $0.0008, what the same turn costs with usage. Cancelled before output: before
the same ~$0.27, now nothing.

`GET /admin/metrics` has, per day in `daily`, `noUsageRequests`, `noUsagePeople`,
`noUsageChargedTokens` and `noUsageCostUsd`: requests settled without usage (status `no_usage`
or `abandoned`, admins aside) and what they were charged. They come from the raw request log,
so only its last `rawLogKeepDays` days have them; days from before this change show what the
old rule charged.

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
| 400 | 400 `upstream_error` with dl's own message (never Luminal's; see below) |
| 401, 402, 403 | 502 `upstream_error` (the service's key or account) |

None of these is charged. Autopilot's dl client retries only `rate_limited` today, so it needs to
treat these three codes (or `retryable: true`) as retryable before Luminal goes live.

**A provider's refusal is never passed on verbatim** (`src/upstream-errors.ts`, every upstream,
and `/anthropic`'s error bodies): providers' messages often quote the request or internal
account and policy text. Known failures get dl's own message (context window exceeded,
`max_tokens`, content policy, an image or file the model can't read, tools or tool calls);
anything else "The model provider couldn't take this request. Send your message again; if it
keeps happening, run `dl update`." (never advice to discard the conversation). When the history
was repaired (`src/tool-history.ts`, an interrupted step) and every upstream still refuses it, the
message says so and keeps the conversation: "The model couldn't take this request (it was rejected
after we cleaned up an interrupted step). Send your message again; if it keeps happening, run
`dl update`." Each such unknown refusal is logged as one JSON line, `event:
"free.upstream_unknown_refusal"` (status, upstream status and reason, model, provider, message
count, results added/dropped; never content). Beside the message, `upstreamStatus` and, only
when the provider's `error.code` or `error.type` is a plain identifier (letters, digits, `_.-`,
at most 64), `upstreamReason` (e.g. `invalid_request_error`). A 402 from the provider is 503
`service_paused`, "The model provider paused the service's account. Try again later."

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

- **Global caps (every provider).** `globalWeeklyUsdCap` and `globalTotalUsdCap` count free
  usage (everyone but admins; paid usage and the service's own calls, such as speed probes and
  use descriptions, left out) on every provider: OpenRouter's billed cash plus the credit used on
  OpenAI, Luminal and each registry provider (Liquid Inference, Open Relay). `/admin/spend` shows
  the two numbers they compare against as `capWeekUsd` and `capTotalUsd`; `spentUsd` and
  `totalSpentUsd` stay OpenRouter cash. In credit mode the queue also watches the weekly credit
  budget (see the queue).
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
`upstream_daily` (requests, upstream errors, prompt, cached and completion tokens, cash and
credit). `upstream_people` keeps, per upstream, who it served and their first and last day (ids
and days only, admins left out), for the people per upstream. The dashboard's upstream tables
(today, this week, all time, each with a total row) show users and tokens in, cached and out
next to the requests, timings and dollars; `upstreams.csv` has the same columns. Completion
tokens per upstream, the days before `upstream_daily` existed, and `upstream_people` are built
once from the request log (the upstream each row recorded) the first time this version starts.

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

## Signing keys

`TOKEN_SIGNING_KEY` is never used directly. Each purpose gets its own 32-byte subkey,
HKDF-SHA256 (RFC 5869) of the key with salt `directionally-local subkey v1` and the purpose as
`info` (`services/shared/src/keys.ts`, `serviceKeys` in app.ts):

| info | signs or keys |
|---|---|
| `jwt` | access tokens, admin dashboard sessions, web sessions, dl.new paid sessions and handoffs |
| `unsubscribe` | the `t` of `/email/stop` links |
| `ip-hash` | network hashes: feedback and telemetry rate limits, "Don't have GitHub?" leads |
| `csrf` | the admin dashboard's form token |
| `broadcast` | the Tools tab's "yes, send" confirmation |

**Transition (the deploy that introduced subkeys).** Everything new is signed with the subkey.
What was signed with the raw key before that deploy still verifies, so nobody is signed out and
no link breaks:

- JWTs are verified with the `jwt` subkey, then the raw key (`jwtVerifyKeys`). The longest-lived
  one is a dl.new paid session (7 days), so the raw-key fallback for JWTs can be removed 7 days
  after the deploy.
- Unsubscribe links are verified with the `unsubscribe` subkey, then the raw key
  (`unsubscribeVerifyKeys`). Links sit in emails already sent, so keep this fallback for as long
  as the key itself is kept.
- An admin form's CSRF token from before the deploy is still taken (`adminCsrfOk`); sessions
  last an hour, so this can go with the JWT fallback.
- Network hashes, the broadcast confirmation and rate-limit buckets keyed on them just start
  over: a confirm page open across the deploy asks to confirm again.
- The referral anti-abuse network hash (`person_networks`) stays on the old derivation
  (`sha256("net:" + key + network)`) for now: those hashes are kept and matched for good, and the
  networks behind them aren't stored, so switching would stop new sign-ins matching existing
  referrers. Moving it means storing both hashes side by side for a while.

Rotating `TOKEN_SIGNING_KEY` still changes every subkey at once: it signs everyone out, breaks
every unsubscribe link already sent and resets every network hash. The subkeys keep one purpose's
values from being used for another, and leave room to give one purpose a key of its own later.

## Sign-out and server keys

- **Sign out:** `POST /v1/token/revoke`. Send the access token as the bearer, `{"refresh_token"}`
  in the body, or both. This ends that sign-in session: its refresh tokens are deleted, so
  refresh fails, and its access tokens stop working at once. The person's other sessions keep
  working. An unknown refresh token still gets a 200.
- **Admin, revoke everything for one person:** `POST /admin/people/:id/revoke-tokens`. This ends
  every session and deletes every key, server and tool. The person can sign in again.
- **Server keys:** long-lived, named and revocable keys for a server that runs agents
  unattended. All three endpoints need a signed-in access token; a server key can't call them.

  | request | response |
  |---|---|
  | `POST /v1/keys {"name": "build-box"}` | 201 `{id, name, kind: "server", key, createdAt, lastUsedAt}`. `key` is shown only here. |
  | `GET /v1/keys` | `{keys: [{id, name, kind, createdAt, lastUsedAt}], max: 5, maxToolKeys, toolKeys}`: server and tool keys |
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
    it works again. The one exception is `/v1/access-request` (GET and POST), which takes any
    key, so `/request` can be typed on the server itself. A Full account without keys may send a
    request (no 409 `already_full`); granting it gives the account keys. A blocked or suspended account's key gets `blocked` or `suspended` as before.
  - **Errors:** a wrong or revoked key gets 401 `invalid_key`. Signing out leaves keys working.
  - **Admin view:** `/admin/people` shows how many keys each person has (`serverKeys`,
    `toolKeys`), never the keys.

## Use dl's free tokens in other tools (tool keys)

An account the sign-up checks gave free tokens to may use them in any OpenAI- or
Anthropic-compatible tool (Cursor, Cline, Roo Code, Kilo Code, Continue, Zed, Aider, OpenCode…),
with no dl running, from the same weekly allowance. The person makes an API key with
`dl api-key` (or `POST /v1/keys {"name": "cursor", "kind": "tool"}` with a signed-in access
token) and pastes it into the tool:

| tool speaks | base URL | API key | model |
|---|---|---|---|
| OpenAI's API | `https://free.directionallylocal.com/v1` | the `dlk_…` key | `deepseek/deepseek-v4.1-flash-1017` (`GET /v1/models` lists the others) |
| Anthropic's API | `https://free.directionallylocal.com/anthropic` | the key, as `x-api-key` or Bearer | any: DeepSeek answers |

- **The key:** a `dlk_` key like a server key, stored the same way (only the secret's SHA-256),
  with `kind: "tool"`. Revoke with `DELETE /v1/keys/:id` (`dl api-key revoke ID`); it stops
  working at once. At most `toolKeysMax` (3) per account, apart from server keys. A tool key
  can't make, list or revoke keys.
- **Who may make one:** admins, Pro, and any active account that isn't below the bar with no
  free tokens (what `below_bar` refuses in chat); no grant needed. Otherwise 403
  `tool_keys_unavailable`. A blocked or suspended account's keys get `blocked` or `suspended`.
- **Where it works:** `/v1/chat/completions`, `/v1/models`, `/v1/me` and
  `/anthropic/v1/messages` (+ `count_tokens`). Elsewhere (`/v1/events`, `/v1/access-request`,
  billing, feedback) 403 `tool_key_not_allowed`: a tool key can't send dl's session events.
- **How it is served:** like another coding agent dl launches (`dl opencode`): the same
  reservation, caps, trial, queue, allocator, moderation and use descriptions, on the share of
  the week other agents get (`otherHarnessShare`; past it 402 `harness_limit` in words for a
  tool); GPT-6 is refused (402 `provider_limit`, reason `autopilot_only`) and not listed while
  `gpt6Clients` is `autopilot`; a model past its provider's budget falls back to DeepSeek rather
  than being refused. Account-pooling routers are refused (`proxy_not_allowed`). Never refused as
  `dl_only`, and its requests don't count toward the person's `dl_only` grace.
- **Rate limit:** `toolKeyRequestsPerMinute` (30) chat requests a minute per key, under the
  person's 60 a minute across everything.
- **Which tools:** each request row keeps `tool:<name>` as its client, the name read from the
  User-Agent, `X-Title` and `HTTP-Referer` headers (cursor, cline, roo, kilo, continue, zed,
  aider, opencode, the SDKs…, else `other`); refusals are counted under the same name.
  `GET /admin/tool-usage?days=7` (1 to 30) gives requests, people and charged tokens per tool
  from the request log. Names and counts only.
- **Kill switch:** `POST /admin/config {"toolKeys": false}`: no new tool keys, and every request
  with one gets 403 `tool_keys_off`; the keys are kept, so turning it back on restores them.

A per-person grant (`POST /admin/people/:id/grant`) still wins over the weekly defaults: `usdPerWeek`
and `spentUsdThisWeek` are GPT-6's; `deepseekSpentUsdThisWeek` sets DeepSeek's spend.

`POST /admin/people/:id/credit-tokens {countedTokens, reason, model?}` gives back tokens an
upstream fault charged (a runaway stream, say): this week's usage on one model (DeepSeek by
default) goes down by up to `countedTokens` on every meter it was charged to, never below 0: the
plan's per-model meter (paid plans and the Free plan), the free tier's pool and family tokens, and
its dollars at the model's output price. Each credit is in the config log as
`credit_tokens:<id>:<login>` with the reason and what came off.

`POST /admin/reset-week {dryRun?}` starts this week over for everyone who isn't blocked: both
budgets' dollars and tokens and every token pool back to 0 (requests in flight still settle).
Top-ups, plans and personal caps stay. `{dryRun: true}` only counts. It answers
`{dryRun, people, reset, skippedBlocked}`. The kill
switch is `POST /admin/pause` and `/admin/unpause`; `PAUSED=true` in env pauses as well.

## Web sign-up (dl.new/start)

dl.new's sign-up page signs people in with GitHub, lets them choose where dl runs (this computer, or their Nvidia GPU) and, on this computer, a plan (the one-time trial, or Pro through Stripe), then shows a personal one-time install command, `curl -fsSL https://dl.new/i/<code> | sh`, that installs dl already signed in. `src/web-signup.ts` has the contract; in short:

| Endpoint | Who calls it | What it does |
| --- | --- | --- |
| `GET /web/signin?return=<WEB_SIGNUP_URL>&state=<page state>[&ref=<referral>][&utm_source=…&utm_medium=…&utm_campaign=…&utm_ref=<host>]` | the page's Sign in button (a navigation) | Starts the CLI's own browser sign-in: a device code (no device id), GitHub, the details step (contact email) and the invite step when one is needed, and the same `admit` (open admission, account age, levels, batch flag, blocked emails, network sign-up limit, cohort). On success it 303s to `<return>#signin=<one-time code>` instead of "return to your terminal". `return` must be exactly `WEB_SIGNUP_URL` (the default when left out) or `WEB_API_URL` (api.dl.new's key page, which finishes the sign-in itself). |
| `POST /web/session {code, state}` | the page (CORS) | The one-time code (5 minutes, once, bound to the page's state) → `{token, expires_in, login}`, a web session: a JWT of type `web`, one hour, accepted only by `/web/*`. |
| `GET /web/me` | the page | `{login, email, emailUpdates, plan, trial, weeklyTokens, toolAllowance, offers, pro, proPrompt, referral: {link, joined, kind, bonusTokens, capTokens, trialBonusTokens}}`. `referral.kind` is `"trial"` on the trial (each friend who becomes weekly active adds `bonusTokens` once to both people's trial, up to `capTokens` in all; `trialBonusTokens` is what this person has earned so far, already in `trial.tokens`) or `"weekly"` otherwise (`bonusTokens` a week to both while both stay weekly active, up to `capTokens` a week; `trialBonusTokens` 0). `toolAllowance: {share, tokensPerWeek, usedThisWeek, resetsAt}` is the week as API keys for other tools see it: `share` is `otherHarnessShare` (1 on Pro), `tokensPerWeek` is DeepSeek's weekly tokens (the model tools get) with it applied (null: no token cap), `usedThisWeek` is all of the week's DeepSeek use (Autopilot too), since a tool key is refused once that reaches its share. |
| `POST /web/email {email, updates?}` | the page | Changes the contact email with the details step's checks (plausible, blocked, one account per inbox). |
| `POST /web/choice {option}` | the page | `computer` or `gpu`; counted only. |
| `POST /web/checkout` | the page | Stripe Checkout for Pro, returning to `WEB_SIGNUP_URL?checkout=done` (or `cancel`); with `{"return": "account"}` (dl.new/account), to `https://dl.new/account?checkout=done` (or `cancel`). `proPrompt` in `/web/me` is counted as seen. |
| `POST /web/portal` | dl.new/account | `{url}`: Stripe's Customer Portal (manage or cancel Pro), returning to dl.new/account; 404 `no_billing_account` before anything was bought. |
| `GET /web/keys` | api.dl.new | `{keys: [{id, name, kind: "tool", createdAt, lastUsedAt, lastTool}], max, toolKeys}`: the account's API keys for other tools (server keys aren't listed). `lastTool` is the tool the key was last used from (`cursor`, `opencode`…, the names in `tool-keys.ts`), null before first use. |
| `POST /web/keys {name}` | api.dl.new | A tool key, always kind `tool`, with the same checks and limits as `POST /v1/keys {name, kind: "tool"}` (`tool_keys_off`, `tool_keys_unavailable`, `key_limit_reached`, `key_name_taken`, …): 201 `{id, name, kind, createdAt, lastUsedAt: null, lastTool: null, key}`, the key shown only here. |
| `DELETE /web/keys/:id` | api.dl.new | Revokes one of the account's own tool keys; 404 `key_not_found` for another account's key or a server key. |
| `POST /web/install-code {option, plan}` | the page | `{code, expires_in}`: 160 random bits, stored as SHA-256, one use, 60 minutes, for this account; a new one replaces an unused older one. `plan` (`free` or `pro`) only with `option: "computer"`. |
| `POST /v1/install-code/exchange {code, device_id?}` | the installed dl (Autopilot) | Once: the device-code poll's token response plus `{login, option, plan}`. A device id is bound as in device sign-in (`device_taken` when it holds another account). Used, expired or unknown: 400 `invalid_install_code` with `reason` (`used`, `expired`, `unknown`); Autopilot then falls back to the device code. 20 tries an hour per network. |
| `POST /v1/telemetry/web {step: "visited", campaign?}` | the dl.new Worker, when it serves the home page | Counted only. |
| `POST /v1/telemetry/web {step: "install_click" \| "signup_started", campaign}` | the page (a beacon) | Counted only, under the campaign. |

The `/web/*` JSON endpoints answer CORS only for `WEB_SIGNUP_URL`'s and `WEB_API_URL`'s origins (dl.new and api.dl.new; methods GET, POST, DELETE) and refuse (403 `forbidden_origin`) a request whose `Origin` is another site. The web session travels as a bearer header, never a cookie, so there is no CSRF surface; the sign-in's own round trip uses the device flow's `__Host-` cookie on this host as before. Codes are never logged and appear in a URL only in the install command (and, for the handoff, in the page's fragment, which the page removes at once).

The funnel (counts only, per UTC day): `visited`, `signed_in`, `chose_computer`, `chose_gpu`, `plan_free`, `plan_pro` (checkout started), `command_shown`, `code_exchanged`. The admin home has a "Web sign-up funnel" card (last 7 days, all time), and `/admin/dashboard/web-signup.csv` has one row per day.

**Link campaigns.** Links to dl.new can carry `utm_source`, `utm_medium` and `utm_campaign` (blog posts: `blog`, `post`, the post's slug). `campaign` is `{source, medium, campaign, ref}`: plain lowercase tags (letters, digits, `.`, `_`, `-`, at most 64 characters; `campaign` required) and the referring host, or `""`. Per UTC day and tags (`web_campaign_daily`), the steps are `visited` (a tagged home page served, from the Worker), `install_click` and `signup_started` (the page, under the visit's first-touch tags, which it keeps 30 days), `signed_in` (a web sign-in started with the tags) and `signed_up` (one that created the account). A day keeps at most 500 tag combinations; more are counted under `_other`. Tags and counts only: no person, address or code. `GET /v1/admin/metrics` has `campaigns: {days: [{date, source, medium, campaign, ref, step, n}], totals: [{source, medium, campaign, ref, visited, install_click, signup_started, signed_in, signed_up}]}` for its range.

Settings: `WEB_SIGNUP_URL` (default `https://dl.new/start`), `WEB_API_URL` (default `https://api.dl.new/`).

**api.dl.new.** The API is also served at `https://api.dl.new/v1` and `https://api.dl.new/anthropic`: Cloudflare routes `api.dl.new/v1/*` and `api.dl.new/anthropic/*` to this Worker (`wrangler.cloudflare.jsonc`), and every other path on that host to the dl.new Worker (its route `api.dl.new/*`; the most specific route wins), which serves the key page. Links the service makes (sign-in, device and callback URLs, admin links) never use `WEB_API_URL`'s origin: without `PUBLIC_URL`, a request there makes them with `https://free.directionallylocal.com`. The routes need a proxied DNS record for `api.dl.new` (an originless `AAAA api 100::`, proxied). The GitHub OAuth app needs nothing new (the callback is still `/device/callback`).

## Don't have GitHub?

A small "Don't have GitHub?" link sits under every "Sign in with GitHub" button: the device sign-in page here (`from=device`) and dl.new's sign-up form (`from=dlnew`; `from=web` is also accepted). It goes to `GET /no-github?from=<source>`, which counts the click (per UTC day and source, in `no_github_clicks`) and shows a short form: an optional email and an optional one-line "What do you use instead?". `POST /no-github` keeps the answer in `no_github_leads` (one row per email address; an answer without an email is dropped when the same network sent the same answer that day). The email must look like an address and the answer is at most 100 characters; at least one of them is needed. No IP is stored: a lead keeps a keyed hash of the network (IPv4 address or IPv6 /64) for that de-duplication only. Clicks are counted at most 20 an hour per network and answers 5 an hour; past that the page still shows but nothing is counted, and a POST gets 429.

Each click and each answer emails the owner (the alert channel: `ALERT_EMAIL` to `ALERT_EMAIL_TO`, and the webhook), subject `dl free tier: someone clicked Don't have GitHub? (from dl.new)`, with the source, the time and the running counts; an answer's email adds the address and the "uses instead" answer. The runtime setting `noGithubAlerts` makes it `daily` (a line in the daily digest) or `off`; at most 50 such emails go out a UTC day and the rest are counted in the next digest.

`GET /v1/admin/no-github?days=30` (admins; 1 to 366 days) returns `{days: [{date, clicks: {device, web, dlnew, other}, total, leads}], totals: {clicks, leads, emails}, leads: [{at, source, email, uses}]}` (newest 1000 leads). `/v1/admin/metrics` has the same per-day counts as `noGithub`. The admin Tools tab has a "Don't have GitHub?" card, and `/admin/dashboard/no-github.csv` (answers) and `/admin/dashboard/no-github-clicks.csv` (clicks per day and source) download them.

## Provider inquiries

Inference companies that want dl to route traffic to them fill the form on dl.new/providers, which posts `POST /web/provider-inquiry` with JSON `{company, name, email, website?, models?, regions?, credits?, notes?}`. No sign-in; CORS and the origin check are the other `/web/*` routes' (dl.new and api.dl.new only; 403 `forbidden_origin` for another site's `Origin`).

- Strings are trimmed and control characters removed (line breaks become spaces, except in `notes`). Longest, in characters: `company` 120, `name` 120, `email` 200 (an address with a dot in its domain), `website` 300, `models` 500, `regions` 300, `credits` 200 (free form, e.g. `$5,000`), `notes` 2000. `company`, `name` and `email` are required; an empty optional field counts as not given.
- `200 {ok: true}` when kept. `400 invalid_request` with the field in the message (missing, too long, not a string, a bad email, an unknown field, a body over 32 KB); `429 rate_limited` past 5 an hour per network or 200 a UTC day in all; `405` for other methods.
- Kept in the Directory's `provider_inquiries` table (the fields and the time; no IP). The owner gets a plain-text email (`ALERT_EMAIL` to `ALERT_EMAIL_TO`, from "dl providers", Reply-To the sender), subject `Provider inquiry: <company>`, listing every field, for the first 50 a UTC day; past that they are only kept.
- `GET /v1/admin/provider-inquiries` (admins) returns `{total, inquiries: [{id, at, company, name, email, website, models, regions, credits, notes}]}`, newest 500 first; the admin Tools tab has a "Provider inquiries" card (escaped).

## Agent requests

When dl's first run finds no coding agent it supports, the person can name theirs, and dl posts `POST /v1/agent-request` with JSON `{name, os?, arch?, dlVersion?, found?}` (`found`: the agents dl did find). Sign-in is optional: a valid `Authorization: Bearer` (access token, `dlk_`/`dl_` key, harness key) attaches the GitHub login and account id; a missing or invalid one is ignored, never refused.

- Strings are trimmed and control characters removed (line breaks become spaces). Longest, in characters: `name` 80 (required), `os` 40, `arch` 20, `dlVersion` 40; `found` at most 40 strings of at most 40 characters (blanks and repeats dropped). Unknown fields are ignored.
- `200 {ok: true}` when kept. `400 invalid_request` with the field in the message (or a body over 16 KB); `429 rate_limited` past 10 an hour per network or 500 a UTC day in all.
- Kept in the Directory's `agent_requests` table (the fields, the time and the account if any; no IP). The owner gets a plain-text email (`ALERT_EMAIL` to `ALERT_EMAIL_TO`, from "dl agents"), subject `dl: unsupported coding agent "<name>"` (CR/LF removed), with the agent, os/arch, dl version, the agents dl found and the account, for the first 50 a UTC day. A failed email never fails the request.
- `GET /admin/agent-requests` (or `/v1/admin/agent-requests`; admins) returns `{total, requests: [{id, at, name, os, arch, dlVersion, found, githubId, login}]}`, newest 500 first.

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
  installs an hour. The limiter's key is an HMAC of the IP under `TOKEN_SIGNING_KEY`'s `ip-hash` subkey and
  the day, so the address isn't stored there either.
- Stored in the Directory's `download_daily` and `install_daily`. The counts are best effort:
  anyone can post one, so read them as trends, not exact numbers.

**GPU first run.** Before sign-in, Autopilot's GPU-aware first run counts its steps the same way:
`POST /v1/telemetry/gpu {"event", "gpuVendor"?, "gpuModel"?, "gpuVramGb"?, "gpuCount"?, "answer"?,
"option"?, "path"?, "outcome"?, "errorType"?}`, where `event` is `detected` (needs `gpuVendor`
`nvidia|amd|ascend|none`), `prompt` (`gpuVendor`, `answer` `yes|no`), `early_access` (`gpuVendor`
`amd|ascend`, `answer`), `option` (`option` `free|own_key|gpus|this_machine|remote_server|endpoint`)
or `result` (`outcome` `ok|failed`, `path` `this_machine|remote_server|endpoint`, and with `failed`
an `errorType` from a fixed list, `other` by default). Kept per UTC day in `gpu_daily`: those
words, the GPU's name (64 characters of letters, digits, space and `._()+/-`), its VRAM in whole
GB and the GPU count; a malformed optional field is dropped. Same responses as above; 60 an hour
per IP. Like installs it has no person attached, so admin machines can't be left out. Signed in,
the same steps go to `/v1/events` as `gpu.*` events with only those fields kept. The
`health-gpus` CSV reads the counts.

**GPU early-access emails.** After a yes to early access, Autopilot asks for an optional email
("Only used to tell you when <vendor> support is ready"), and sends it as `"email"` on that
`early_access` body (never when telemetry is off). It is read only there, with `answer` `yes`: a
plausible address of at most 254 characters, not on the `blockedEmails` list (checked on its
normalized inbox). A malformed or blocked one is dropped silently; the count is made either way,
and `gpu_daily` stays anonymous. A kept one goes to the Directory's `early_access_leads` (time,
vendor, GPU model, VRAM, the address and its normalized inbox), one row per inbox and vendor, the
latest kept. The address is never logged. Admins see the leads in the Tools tab's "GPU early
access" card (email, vendor, GPU, VRAM, date, newest first, escaped; a box with every address to
copy), download them at `GET /admin/dashboard/early-access.csv`, and delete one person's leads on
request from the same card. The dl.new privacy policy says this.

## Raw log retention

The Directory keeps every request (`requests`: counts, cost, timings) and every session event
(`events`) in its one SQLite database, which has a 10 GB cap. Only the last `rawLogKeepDays` whole
UTC days (35 by default, at most 400: there is no "keep everything", and a 0 or a larger value
from before the cap, in the env or a stored override, keeps 400) are kept. Every 10 minutes (the speed probes' cron) older rows are deleted
in steps of at most 2000 rows of each table, up to 10 steps, each its own short call.

Nothing that reads further back reads the raw log. Rollups kept with every request and event
(and built once from the existing log the first time this code runs) hold what outlives it:

- `person_daily`: per UTC day and person, admins included, requests, tokens, cost and errors.
  `GET /admin/metrics` reads its daily series, totals, top people and weekly active from here, and
  `GET /admin/people/:id` its weekly usage.
- `daily_activity`: also each day's error events.
- `person_events` and `person_event_types`: per person, all time, sessions, sessions started,
  turns, duration, the latest event, event counts by type (the funnel's first session end and
  first PR), GPT-6 trust's multi-turn use, and the dl-only check's inputs: when the latest session
  event arrived, and how many pruned free requests no session event covered.
- `latency_daily`: a day's p50 and p95 latency, worked out from the whole day just before its first
  row is pruned.

So every all-time number on the admin pages, the dl-only check and GPT-6 trust stay the same after
pruning. What reads the raw log directly only looks back 30 days at most (the Health view, the
token allocator, the digest, model speeds); `rawLogKeepDays` can't be set lower than 31. The one
thing that shrinks is the list of a person's 20 latest events in `GET /admin/people/:id`.

`GET /admin/metrics` has `storage`: `databaseBytes` (the database's size, where the runtime
reports it), `rows` (row counts of the biggest tables), `oldestRequestAt`, `oldestEventAt`,
`rawLogKeepDays` and `pruned` (`{requests, events, lastAt}`, rows deleted so far).

## Admin dashboard

**Home.** `GET /admin` (any `?view=` but `tools`) shows the data the old Kimiflare Cloud admin
dashboard showed, in dl's model, on one page (`src/admin-home-page.ts`, numbers from
`src/admin-home-data.ts`). Admins are left out of every total and shown, marked Admin, in the
users table.

- **Stat cards:** Total Users (every account, with how many are blocked), Active Grants (personal
  weekly caps an admin set, on accounts that aren't blocked), Global Budget (free use this week,
  OpenAI and Luminal credit plus OpenRouter cash, against the configured weekly credit budgets
  added up, else `globalWeeklyUsdCap`), Est. Cost (all-time cost at the allowance's list prices,
  free and paid), Feedback (messages sent; a count per day in `feedback_daily`, kept from this
  version on, nothing of the message), 7-Day Prompts (input tokens over the last 7 UTC days).
- **Flagged use:** automated session descriptions labelled low or high risk in the last 7
  days, high first (see [use descriptions](#what-people-use-the-service-for-use-descriptions)).
  Read apart from the home's other numbers, from `use_descriptions` only.
- **Platform Health:** Total Users, Active Grants, Total Cost, Total Tokens (input + output, all time).
- **Paid:** paying users (active + past due), active, past due and canceled Pro subscriptions,
  MRR (paying users × the Pro price), top-ups and top-up revenue (before tax).
- **New-User Trial:** off, or the cutoff, trial users, grandfathered users, and trial users who
  converted (a Pro subscription in any state, or a payment), split into To Pro and Top-up.
  Trial accounts carry a "Trial" badge in the Users table. `GET /admin/people` and
  `GET /admin/people/:id` have `access` (`"trial"` or `"grandfathered"`) and `trial` (as in `/v1/me`).
- **Usage Analytics:** input and output tokens and requests per day (30), week (12) or month (12),
  a Day / Week / Month switch made of radio buttons (no script), an SVG bar chart with each
  period's exact numbers in its tooltip.
- **Users:** every account, sortable by every column and searchable by login (a small script with
  the page's nonce; the CSP allows only that script). User, Plan (Pro, Past due, Canceled, Free,
  or Blocked), Grant Limit (this week's GPT-6 dollar cap: the personal cap if an admin set one,
  marked "own", else the level's; Pro's for Pro; the DeepSeek cap under it), Input Used, Remaining
  (the caps less this week's free spend from the daily roll-up; an admin's weekly reset isn't seen
  there; none for Pro, blocked or uncapped), Output, Cost, Requests, Last Active (all time, from
  `person_totals`), Networks (how many distinct networks the person signed in from: dl keeps only
  keyed hashes, never an address, so there is no IP column) and Joined.
- **Active Grants / Expired / Revoked:** each personal cap with its weekly dollar and token caps
  and when it was set (`grant_history`; caps from before it was kept are dated by the admin log
  entry that gave Full, or blank), and the ended ones: replaced by another cap, removed, or still
  set on a blocked account.

It reads `people`, `person_totals` (all-time tokens, cost, requests and last request per person,
admins included, kept with each request and built once from the log), `daily_activity` (with
prompt and completion tokens per person per day), `grants`, `grant_history`, `subscriptions`,
`payments`, a count of `person_networks` and `feedback_daily`: one row per person or per day,
never the request log, and no email or content. A test holds its queries to `ADMIN_HOME_COLUMNS`.

**Tools.** `GET /admin?view=tools`: the actions. Access requests (Grant / Decline), give free
tokens by GitHub username, block or unblock by username, the routing setting (`primaryUpstream`),
re-check below-bar accounts, write an email, the GPU early-access leads, and "Don't have GitHub?" clicks and answers.

**CSVs.** Every table the stats questions use is a CSV at `/admin/dashboard/<table>.csv`
(`spend`, `weekly-active`, `retention`, `retention-daily`, `weekly-cost`, `top-cost?week=YYYY-MM-DD`,
`limits`, `queue`, `referrals`, `funnel`, `install-funnel`, `installs`, `paid`, `upstreams`,
`early-access`, `no-github`, `no-github-clicks`, and `health-errors`, `health-request-failures`, `health-ends`, `health-turns`,
`health-versions`, `health-sessions`, `health-tools`, `health-models`, `health-upstreams`,
`health-installs`, `health-gpus`, which take `?days=1|7|30`). Weekly active developers are 3+
request days and any day, last 8 weeks; cohort retention is weeks 1, 2 and 4 after sign-up; cost
per person per week has the total, median, mean and the top 10 of any week; limits lists who
reached their token or dollar allowance this week and last, and on which day.

**Daily retention:** people grouped by the UTC day they were admitted (the last 21 days with
sign-ups; admins and blocked accounts left out), and the share who made at least one request on
day 0–7 and 14 after it. A day stays blank until it has ended (UTC), so today's partial
numbers never show. `retention-daily.csv` has `cohort, size, d0…d7, d14` (shares), and `GET /admin/metrics`
returns it as `cohorts: [{day, size, d: {0: share, …, 14: share}}]` (null for days that haven't ended).
It counts only people who could use dl: they had free tokens at sign-up (`people.signup_tokens`:
Full, Basic, an admin's grant, or a Starter allowance without the batch flag; for sign-ups from
before it was stored, the current level stands in). Per sign-up day, a small funnel
of everyone: signed up, got tokens, refused, and refused but opened dl that day (a dl session or
a refused chat request, from `refused_days`); `GET /admin/metrics` has it as
`signupFunnel: [{day, signedUp, gotTokens, refused, refusedOpened}]`.

**Upstreams** (`upstreams.csv`): per upstream for today, this week and all time: requests,
errors, median and p90 time to first token, median time to first byte, cache-hit share, tokens,
credit and cash. These count admin requests too, since they measure the upstream. The routing
switch is on the Tools page (`#upstream`): a form posting to `/admin/dashboard/upstream` with the
session's CSRF token and a same-origin check; it sets the `primaryUpstream` override, logged in
the admin log; an upstream without its key can't be chosen.

- **Block:** `POST /admin/people/:id/block` and `/unblock` (admin bearer token), or the Tools
  page's "Block or unblock" form (by GitHub username; admins can't be blocked there), which posts
  to `/admin/dashboard/tools`; `/admin/dashboard/people/:id/block|unblock` still takes a form post
  too. Both need the session cookie, a same-origin request and a CSRF token bound to the session. It sets the
  person's status to `blocked` (unblock: `active`) and logs it (`person_status:<id>:<login>`).
  Blocked: chat requests, token refresh and server-key creation answer 403 `blocked` ("This
  account is blocked from the free tier. Contact contact@directionallylocal.com."), and sign-in
  is refused on the page and at `POST /v1/device/token` (403 `blocked`). Unblocking restores all
  of it; refresh tokens aren't used up while blocked. `suspend` stays as it was.
- **Free tokens only with dl's session events (`dlOnly`, off by default):** free tokens work in
  any coding agent. When it is switched on: Autopilot always sends session
  events (`POST /v1/events`) while the free tier is its provider, so a sign-in token used from
  another tool sends requests and no events. A chat request from a free-plan account is
  refused with 403 `dl_only` ("Your dl sign-in works inside dl only. To use free tokens in another
  tool, make an API key for it: run dl api-key. Or use your own API key in that tool.") when no session event (one with a session id) arrived in
  the last 24 hours and the account has made at least 20 free chat requests with a sign-in token
  that no session event covers: a session event covers the 24 hours after it, so these are the
  requests made more than 24 hours after the latest one (all of them, for an account that never
  sent one). Autopilot batches events for a few seconds, so a new session's first requests come
  before its first event: the threshold leaves room for that, once, not every day. Not counted and never refused: admins, requests with a
  `dlk_` key (a server key, dl's server mode, or a [tool key](#use-dls-free-tokens-in-other-tools-tool-keys), which is how free tokens are used in other tools) and paid usage (Pro and top-ups; a refused free account
  with a top-up is served from it). The check reads the caller's events and request log in the
  Directory read every chat request already makes; the only new write is a `via_key` flag on the
  request row it already inserts. Switch it on with `POST /admin/config {"dlOnly": true}`.
  `GET /admin/people` (`dlSessionsThisWeek`) shows dl sessions this week,
  the distinct session ids in each person's events, counted in `daily_activity.sessions`.
- **Admins are left out of every number:** anyone in `ADMIN_GITHUB_IDS` and anyone admitted as
  an admin.
- **What the CSVs read:** only `daily_activity`, a per-person per-day roll-up of request and event
  counts, charged tokens and cost, plus GitHub logins, sign-up times, per-person grants and the
  spend totals, and for the launch sections the queue (ids and times), the Monday runs (counts
  and the forecast) and referrals (ids, time and outcome), and for the upstreams `upstream_daily`
  and `upstream_timings` (counts, tokens, dollars and milliseconds per upstream, no person) and
  `upstream_people` (ids and first and last days per upstream), and
  for the install funnel `download_daily` and `install_daily` (anonymous counts). No model, event type or properties,
  session ids, prompts or code. A test runs
  the CSVs under an SQLite authorizer that allows only those columns. The health CSVs read named
  event fields, held to `HEALTH_COLUMNS`; the home page is held to `ADMIN_HOME_COLUMNS`.
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
