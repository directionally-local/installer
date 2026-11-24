import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { ADMIN_ID, createService, luminalUsage, MODEL, openRelayCompletion, openRelayStream, openRelayUsage, sse, type Service } from "./harness.js";
import { readFreeConfig } from "../src/config.js";
import { modelById } from "../src/models.js";
import { PROBE_CRON, PROBE_MAX_TOKENS, PROBE_PROMPT } from "../src/probes.js";
import { approxTokens, openRelayCharge, providerSettings, registryBlock } from "../src/providers.js";
import { signatureHeader } from "../src/stripe.js";

/**
 * Open Relay (providers.ts), the registry provider that serves GLM 5.3 Flash free for everyone:
 * paused by default, its shape on the wire, its reported cost charged to its credit, the
 * per-person weekly cap on every plan, DeepSeek past a limit (Autopilot switches itself on the
 * 402; another agent launched by dl is served DeepSeek), and what /v1/models, /v1/me,
 * /v1/providers, the probes and the admin view say about it.
 */

const GLM_FLASH = "z-ai/glm-5.3-flash";
const KEY = "or_test_secret";
const HOOK = "https://alerts.test/hook";
const ON = { OPENRELAY_API_KEY: KEY, OPENRELAY_STATUS: "on" };
const BASE_ENV = { OPENROUTER_API_KEY: "k", GITHUB_CLIENT_ID: "c", GITHUB_CLIENT_SECRET: "s", TOKEN_SIGNING_KEY: "x".repeat(32) };

let ips = 0;
const ip = () => `10.7.${Math.floor(++ips / 250) % 250}.${ips % 250}`;

async function member(vars: Record<string, string> = {}): Promise<{ service: Service; token: string; admin: string }> {
  const service = await createService({ OPEN_ADMISSION: "true", OPENAI_API_KEY: "sk-openai-test", LUMINAL_API_KEY: "lum-test", ALERT_WEBHOOK_URL: HOOK, ...vars });
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const token = (await service.signIn({ id: 100, login: "alice" })).access_token;
  return { service, token, admin };
}

const chat = (service: Service, token: string, model: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  service.request("POST", "/v1/chat/completions", { token, ip: ip(), headers, body: { model, messages: [{ role: "user", content: "hello" }], ...body } });

async function errorOf(response: Response): Promise<Record<string, any>> {
  return ((await response.json()) as { error: Record<string, any> }).error;
}

async function models(service: Service, token: string): Promise<Array<Record<string, any>>> {
  return ((await (await service.request("GET", "/v1/models", { token, ip: ip() })).json()) as { data: Array<Record<string, any>> }).data;
}

async function me(service: Service, token: string): Promise<Record<string, any>> {
  return (await (await service.request("GET", "/v1/me", { token, ip: ip() })).json()) as Record<string, any>;
}

function db(service: Service): DatabaseSync {
  service.directory();
  return (service.namespaces.DIRECTORY!.instances.get("directory")!.state as unknown as { db: DatabaseSync }).db;
}

async function scheduled(service: Service, cron: string, at = service.clock.now): Promise<void> {
  await (service.handler as unknown as { scheduled(controller: { cron: string; scheduledTime: number }, env: never): Promise<void> }).scheduled({ cron, scheduledTime: at }, service.env as never);
}

async function opencodeKey(service: Service, token: string): Promise<string> {
  const response = await service.request("POST", "/v1/harness-keys", { token, body: { harness: "opencode" } });
  assert.equal(response.status, 201, await response.clone().text());
  return ((await response.json()) as { key: string }).key;
}

describe("Open Relay: settings and defaults", () => {
  it("is paused, $200 of credit, $25 a week, every plan, not opt-in, $0.50 a person a week, GLM 5.3 Flash on", () => {
    const config = readFreeConfig({ ...BASE_ENV });
    assert.deepEqual(providerSettings(config, "openrelay"), { status: "paused", creditUsd: 200, weeklyCreditUsd: 25, optIn: false, personWeeklyUsd: 0.5, plans: "all", models: [GLM_FLASH] });
    const glm = modelById(GLM_FLASH)!;
    assert.deepEqual({ provider: glm.provider, upstream: glm.upstreamModel, family: glm.family, pool: glm.pool, line: glm.line, context: glm.contextWindow, fallback: glm.fallback }, { provider: "openrelay", upstream: "openrelay/glm-5.3-flash", family: "deepseek", pool: "deepseek", line: "glm", context: 262_144, fallback: MODEL });
    // About 15M tokens a week at the ration mix (mostly cache reads).
    assert.equal(approxTokens(glm, 0.5), 15_000_000);
  });

  it("reads the OPENRELAY_* env names", () => {
    const config = readFreeConfig({ ...BASE_ENV, ...ON, OPENRELAY_CREDIT_USD: "50", OPENRELAY_WEEKLY_CREDIT_USD: "none", OPENRELAY_PERSON_WEEKLY_USD: "1", OPENRELAY_PLANS: "pro", OPENRELAY_MODELS: "none" });
    assert.equal(config.openrelayApiKey, KEY);
    assert.deepEqual(providerSettings(config, "openrelay"), { status: "on", creditUsd: 50, weeklyCreditUsd: undefined, optIn: false, personWeeklyUsd: 1, plans: "pro", models: [] });
  });

  it("holds every plan to the person cap, not opt-in or Pro-only", () => {
    const config = readFreeConfig({ ...BASE_ENV, ...ON });
    const glm = modelById(GLM_FLASH)!;
    const spend = { usedUsd: {}, weekUsd: {} };
    assert.equal(registryBlock(config, glm, spend, 0.49, "free"), undefined);
    assert.equal(registryBlock(config, glm, spend, 0.5, "free"), "person_cap");
    assert.equal(registryBlock(config, glm, spend, 0.5, "pro"), "person_cap");
    assert.equal(registryBlock(config, glm, { usedUsd: {}, weekUsd: { openrelay: 25 } }, 0), "weekly_budget");
    assert.equal(registryBlock(config, glm, { usedUsd: { openrelay: 200 }, weekUsd: {} }, 0), "out_of_credit");
    assert.equal(registryBlock({ ...config, openrelayApiKey: undefined }, glm, spend), "no_key");
  });

  it("reads Open Relay's cost from the body, else the header, in nano-dollars", () => {
    assert.equal(openRelayCharge({ openrelay: { cost_nano_usd: 23_355, priced_at: "online" } }), 0.000023355);
    assert.equal(openRelayCharge({ choices: [] }, "14850"), 0.00001485);
    assert.equal(openRelayCharge({ openrelay: { cost_nano_usd: 0 } }), undefined);
    assert.equal(openRelayCharge(undefined, null), undefined);
  });
});

describe("Open Relay: routing", () => {
  it("is unknown without a key, and paused with one until the owner turns it on", async () => {
    const none = await member();
    assert.equal((await errorOf(await chat(none.service, none.token, GLM_FLASH))).code, "model_not_allowed");
    const { service, token, admin } = await member({ OPENRELAY_API_KEY: KEY });
    assert.ok(!(await models(service, token)).some((model) => model.id === GLM_FLASH));
    const paused = await errorOf(await chat(service, token, GLM_FLASH));
    assert.deepEqual({ code: paused.code, reason: paused.reason, alternative: paused.alternative }, { code: "provider_limit", reason: "paused", alternative: MODEL });
    assert.equal(service.calls.openrelay.length, 0);
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { "providerStatus.openrelay": "on" } })).status, 200);
    assert.equal((await chat(service, token, GLM_FLASH)).status, 200);
    assert.equal(service.calls.openrelay.length, 1);
  });

  it("sends GLM 5.3 Flash to Open Relay in its shape, tools included, and charges the credit the reported cost", async () => {
    const { service, token } = await member(ON);
    const tools = [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } } }];
    const response = await chat(service, token, GLM_FLASH, { stream: true, max_tokens: 2000, tools, tool_choice: "auto", reasoning: { effort: "high" }, provider: { order: ["x"] }, usage: { include: true }, metadata: { a: 1 }, user: "someone@example.com" });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /1, 2, 3/);
    const { body, headers } = service.calls.openrelay[0]!;
    assert.equal(headers.authorization, `Bearer ${KEY}`);
    assert.equal(body.model, "openrelay/glm-5.3-flash");
    assert.equal(body.max_tokens, 2000);
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
    assert.deepEqual(body.tools, tools);
    assert.equal(body.tool_choice, "auto");
    assert.equal(body.reasoning_effort, "high");
    // The person's hashed id, never theirs or the client's own `user`.
    assert.match(String(body.user), /^dl-[0-9a-f]{32}$/);
    for (const field of ["provider", "usage", "metadata", "reasoning", "max_completion_tokens", "exchange", "session_id"]) assert.equal(body[field], undefined, field);
    const row = db(service).prepare("SELECT upstream, model, credit_usd, cost_usd, status FROM requests").get() as Record<string, any>;
    assert.deepEqual({ upstream: row.upstream, model: row.model, status: row.status }, { upstream: "openrelay", model: GLM_FLASH, status: "ok" });
    assert.equal(row.credit_usd, 0.000023355);
    // The person's open-models allowance: GLM 5.3 Flash's list price.
    assert.ok(Math.abs(row.cost_usd - (100 * 0.045 + 10 * 0.18) / 1e6) < 1e-12);
    const view = (await (await service.request("GET", "/v1/admin/providers", { token: (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token })).json()) as { providers: Array<Record<string, any>> };
    assert.equal(view.providers.find((provider) => provider.id === "openrelay")!.usedUsd, 0.000023);
  });

  it("charges a non-streamed answer what its body or header says, else the usage at list price", async () => {
    const { service, token } = await member(ON);
    assert.equal((await chat(service, token, GLM_FLASH)).status, 200);
    service.setOpenRelay(() => Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "hi" } }], usage: openRelayUsage(100, 10) }, { headers: { "OpenRelay-Cost-Nano-USD": "5000" } }));
    assert.equal((await chat(service, token, GLM_FLASH)).status, 200);
    service.setOpenRelay(() => Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "hi" } }], usage: openRelayUsage(1_000_000, 0) }));
    assert.equal((await chat(service, token, GLM_FLASH)).status, 200);
    const credits = (db(service).prepare("SELECT credit_usd FROM requests ORDER BY id").all() as Array<{ credit_usd: number }>).map((row) => row.credit_usd);
    assert.deepEqual(credits.slice(0, 2), [0.000023355, 0.000005]);
    assert.ok(Math.abs(credits[2]! - 0.045) < 1e-9);
  });

  it("passes 429, 502 and 503 back as transient, retryable, with no other model", async () => {
    const { service, token } = await member(ON);
    for (const status of [429, 502, 503]) {
      service.setOpenRelay(() => Response.json({ error: { type: "rate_limit_error" } }, { status, headers: { "retry-after": "7" } }));
      const response = await chat(service, token, GLM_FLASH);
      assert.equal(response.status, status === 429 ? 429 : 503);
      const error = await errorOf(response);
      assert.equal(error.retryable, true);
      assert.equal(error.upstream, "openrelay");
      assert.equal(response.headers.get("retry-after"), "7");
    }
    assert.equal(service.calls.luminal.length, 0);
  });
});

describe("Open Relay: what the endpoints say", () => {
  it("/v1/models, /v1/me and /v1/providers list GLM 5.3 Flash for a free account, free, with its weekly cap", async () => {
    const { service, token } = await member(ON);
    const glm = (await models(service, token)).find((model) => model.id === GLM_FLASH)!;
    assert.deepEqual(
      { name: glm.name, owner: glm.owned_by, context: glm.context_window, access: glm.access, perWeek: glm.ration.approxTokensPerWeek, left: glm.ration.remainingUsd },
      { name: "GLM 5.3 Flash", owner: "openrelay", context: 262_144, access: "free", perWeek: 15_000_000, left: 0.5 },
    );
    const body = await me(service, token);
    assert.ok(body.models.includes(GLM_FLASH));
    assert.deepEqual(body.proModels, []);
    assert.equal(body.cappedModels.length, 1);
    const capped = body.cappedModels[0];
    assert.deepEqual({ id: capped.id, provider: capped.provider, access: capped.access, usd: capped.usdPerWeek, fallback: capped.fallback }, { id: GLM_FLASH, provider: "openrelay", access: "free", usd: 0.5, fallback: MODEL });
    assert.match(capped.text, /^GLM 5\.3 Flash: about 15M of 15M free tokens left this week \(resets Monday \d+ \w+, 00:00 UTC\), then DeepSeek V4\.1 Flash 1017\.$/);
    const pub = (await (await service.request("GET", "/v1/providers", { ip: ip() })).json()) as { providers: Array<Record<string, any>> };
    const openrelay = pub.providers.find((provider) => provider.id === "openrelay")!;
    assert.deepEqual(
      { name: openrelay.name, website: openrelay.website, logo: openrelay.logo, models: openrelay.models.map((model: Record<string, any>) => [model.id, model.name, model.family, model.access, model.status, model.clients]) },
      { name: "Open Relay", website: "https://openrelay.inc/", logo: "/logos/openrelay.svg", models: [[GLM_FLASH, "GLM 5.3 Flash", "glm", "free", "on", ["autopilot", "opencode", "pi"]]] },
    );
  });

  it("is in OpenCode's and Pi's model lists (not GPT-6's Autopilot-only rule)", async () => {
    const { service, token } = await member(ON);
    const key = await opencodeKey(service, token);
    const ids = (await models(service, key)).map((model) => model.id);
    assert.ok(ids.includes(GLM_FLASH));
    assert.ok(!ids.some((id) => id.startsWith("gpt-6")));
  });
});

describe("Open Relay: past a limit, DeepSeek", () => {
  it("person cap: Autopilot gets 402 with the reset day and DeepSeek as the alternative; the cap leaves /v1/models", async () => {
    const { service, token, admin } = await member({ ...ON, OPENRELAY_PERSON_WEEKLY_USD: "0.00002" });
    assert.equal((await chat(service, token, GLM_FLASH)).status, 200);
    const capped = await chat(service, token, GLM_FLASH);
    assert.equal(capped.status, 402);
    const error = await errorOf(capped);
    assert.deepEqual(
      { code: error.code, reason: error.reason, provider: error.provider, alternative: error.alternative, resetsAt: error.resetsAt },
      { code: "provider_limit", reason: "person_cap", provider: "openrelay", alternative: MODEL, resetsAt: "2026-11-09T00:00:00.000Z" },
    );
    assert.match(error.message, /^You've used this week's free GLM 5\.3 Flash \(about [\d.]+K? tokens a week\)\. It resets on Monday 9 Nov, 00:00 UTC\. Use deepseek\/deepseek-v4\.1-flash-1017 instead: \/model\.$/);
    assert.ok(!(await models(service, token)).some((model) => model.id === GLM_FLASH));
    const view = (await me(service, token)).cappedModels[0];
    assert.equal(view.ration.remainingUsd, 0);
    assert.match(view.text, /this week's free tokens are used up; DeepSeek V4\.1 Flash 1017 serves until it resets on Monday 9 Nov, 00:00 UTC\.$/);
    // DeepSeek keeps working, and alice's cap doesn't hold anyone else.
    assert.equal((await chat(service, token, MODEL)).status, 200);
    assert.equal((await chat(service, admin, GLM_FLASH)).status, 200);
    // The refusal is counted with the provider limits.
    const metrics = (await (await service.request("GET", "/admin/metrics", { token: admin })).json()) as { refusals: Array<{ reason: string; client: string; count: number }> };
    assert.ok(metrics.refusals.some((row) => row.reason === "provider_limit:person_cap" && row.client === "autopilot" && row.count === 1), JSON.stringify(metrics.refusals));
  });

  it("person cap: another agent launched by dl is served DeepSeek, with x-dl-fallback and a line saying when GLM is back", async () => {
    const { service, token } = await member({ ...ON, OPENRELAY_PERSON_WEEKLY_USD: "0.00002" });
    const key = await opencodeKey(service, token);
    assert.equal((await chat(service, key, GLM_FLASH)).status, 200);
    const served = await chat(service, key, GLM_FLASH);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("x-dl-fallback"), MODEL);
    assert.match(served.headers.get("x-dl-notice") ?? "", /^You've used this week's free GLM 5\.3 Flash \(about .+ tokens a week\); DeepSeek V4\.1 Flash 1017 serves until it resets on Monday 9 Nov, 00:00 UTC\.$/);
    assert.equal(service.calls.openrelay.length, 1);
    assert.equal(service.calls.luminal.length, 1);
    const rows = db(service).prepare("SELECT model, upstream, harness FROM requests ORDER BY id").all() as Array<Record<string, any>>;
    assert.deepEqual(rows.map((row) => [row.model, row.upstream, row.harness]), [[GLM_FLASH, "openrelay", "opencode"], [MODEL, "luminal", "opencode"]]);
  });

  it("weekly budget: everyone falls back until Monday; admins' spend is left out of it", async () => {
    const { service, token, admin } = await member({ ...ON, OPENRELAY_WEEKLY_CREDIT_USD: "0.00004", OPENRELAY_PERSON_WEEKLY_USD: "none" });
    assert.equal((await chat(service, admin, GLM_FLASH)).status, 200);
    assert.equal((await chat(service, token, GLM_FLASH)).status, 200);
    assert.equal((await chat(service, token, GLM_FLASH)).status, 200);
    const stopped = await errorOf(await chat(service, token, GLM_FLASH));
    assert.equal(stopped.reason, "weekly_budget");
    assert.match(stopped.message, /has used its free budget for this week\. It resets on Monday 9 Nov, 00:00 UTC\. Use /);
    const key = await opencodeKey(service, token);
    const served = await chat(service, key, GLM_FLASH);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("x-dl-fallback"), MODEL);
    assert.match(served.headers.get("x-dl-notice") ?? "", /^GLM 5\.3 Flash on Open Relay has used its free budget for this week; DeepSeek V4\.1 Flash 1017 serves until it resets on Monday 9 Nov, 00:00 UTC\.$/);
    const pub = (await (await service.request("GET", "/v1/providers", { ip: ip() })).json()) as { providers: Array<Record<string, any>> };
    assert.equal(pub.providers.find((provider) => provider.id === "openrelay")!.models[0].status, "paused");
  });

  it("out of credit: the 80% alert says DeepSeek takes over, and at 100% it does", async () => {
    const { service, token } = await member({ ...ON, OPENRELAY_CREDIT_USD: "0.00004", OPENRELAY_PERSON_WEEKLY_USD: "none" });
    assert.equal((await chat(service, token, GLM_FLASH)).status, 200);
    assert.equal((await chat(service, token, GLM_FLASH)).status, 200);
    const texts = service.calls.webhooks.map((hook) => String(hook.body.text));
    assert.ok(texts.some((text) => text.includes("Open Relay credit used") && text.includes("At 100% DeepSeek serves requests for its models instead.") && text.includes("providerCredit.openrelay")), texts.join("\n"));
    const refused = await errorOf(await chat(service, token, GLM_FLASH));
    assert.deepEqual({ reason: refused.reason, resetsAt: refused.resetsAt, alternative: refused.alternative }, { reason: "out_of_credit", resetsAt: null, alternative: MODEL });
    const key = await opencodeKey(service, token);
    const served = await chat(service, key, GLM_FLASH);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("x-dl-notice"), "GLM 5.3 Flash on Open Relay is out of free credit; DeepSeek V4.1 Flash 1017 serves for now.");
  });

  it("a pause is not a fallback: another agent gets the 402 too", async () => {
    const { service, token, admin } = await member(ON);
    const key = await opencodeKey(service, token);
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { "providerStatus.openrelay": "paused" } })).status, 200);
    const refused = await chat(service, key, GLM_FLASH);
    assert.equal(refused.status, 402);
    assert.equal((await errorOf(refused)).reason, "paused");
    assert.equal(service.calls.luminal.length, 0);
  });
});

describe("Open Relay: dl Pro", () => {
  const SECRET = "whsec_test_0123456789abcdef";
  const BILLING = { STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_PRICE_TOPUP: "price_topup123" };

  async function makePro(service: Service, githubId: number): Promise<void> {
    const at = Math.floor(service.clock.now / 1000);
    const object = { id: `cs_pro_${githubId}`, object: "checkout.session", mode: "subscription", client_reference_id: String(githubId), customer: `cus_${githubId}`, subscription: `sub_${githubId}`, payment_status: "paid", amount_subtotal: 700, amount_total: 700, metadata: { github_id: String(githubId), product: "pro" } };
    const body = JSON.stringify({ id: `evt_pro_${githubId}`, object: "event", type: "checkout.session.completed", created: at, data: { object } });
    const response = await service.request("POST", "/v1/billing/webhook", { body, headers: { "stripe-signature": await signatureHeader(SECRET, at, body) } });
    assert.equal(response.status, 200, await response.clone().text());
  }

  it("spends the one open-models budget, so Pro's 4x covers GLM 5.3 Flash like DeepSeek", async () => {
    // A $0.50 free open-models week, so Pro's is $2; each GLM request here costs $0.60 of it.
    const { service, token } = await member({ ...BILLING, ...ON, DEEPSEEK_WEEKLY_USD_CAP: "0.5", OPENRELAY_PERSON_WEEKLY_USD: "none" });
    await makePro(service, 100);
    service.setOpenRelay(() => openRelayCompletion(openRelayUsage(0, 3_333_334), 1000));
    const budget = async () => (await me(service, token)).budgets.deepseek as { spentUsd: number; usdPerWeek: number };
    assert.equal((await budget()).usdPerWeek, 2);
    assert.equal((await chat(service, token, GLM_FLASH)).status, 200);
    assert.equal((await chat(service, token, GLM_FLASH)).status, 200);
    assert.equal((await chat(service, token, MODEL)).status, 200);
    assert.ok((await budget()).spentUsd > 0.5);
  });
});

describe("Open Relay: speed probes", () => {
  it("probes GLM 5.3 Flash with a tiny capped stream, its cost on Open Relay's credit", async () => {
    const { service } = await member(ON);
    service.setLuminal(() => sse([JSON.stringify({ choices: [{ index: 0, delta: { content: "1" } }] }), JSON.stringify({ choices: [], usage: luminalUsage(20, 5) })]));
    service.setOpenRelay(() => openRelayStream(openRelayUsage(20, 60, 40), 11_700));
    const at = Date.parse("2026-11-04T13:10:00.000Z");
    service.clock.now = at;
    await scheduled(service, PROBE_CRON, at);
    assert.equal(service.calls.openrelay.length, 1);
    const probe = service.calls.openrelay[0]!.body;
    assert.deepEqual(
      { model: probe.model, max: probe.max_tokens, stream: probe.stream, messages: probe.messages, user: probe.user },
      { model: "openrelay/glm-5.3-flash", max: PROBE_MAX_TOKENS, stream: true, messages: [{ role: "user", content: PROBE_PROMPT }], user: "dl-speed-probe" },
    );
    const row = db(service).prepare("SELECT provider, ok, cost_usd FROM provider_probes WHERE model = ?").get(GLM_FLASH) as Record<string, any>;
    assert.deepEqual({ ...row }, { provider: "openrelay", ok: 1, cost_usd: 0.0000117 });
    assert.equal((db(service).prepare("SELECT COUNT(*) AS n FROM requests").get() as { n: number }).n, 0);
    // Signed in again: the clock moved past the first token.
    const owner = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const view = (await (await service.request("GET", "/v1/admin/providers", { token: owner })).json()) as { providers: Array<Record<string, any>> };
    const openrelay = view.providers.find((provider) => provider.id === "openrelay")!;
    assert.deepEqual({ balance: openrelay.balanceUsd, used: openrelay.usedUsd, status: openrelay.status, weekly: openrelay.weeklyBudgetUsd }, { balance: 200, used: 0.000012, status: "on", weekly: 25 });
  });

  it("skips Open Relay while it is paused", async () => {
    const { service } = await member({ OPENRELAY_API_KEY: KEY });
    await scheduled(service, PROBE_CRON, Date.parse("2026-11-04T13:10:00.000Z"));
    assert.equal(service.calls.openrelay.length, 0);
  });
});
