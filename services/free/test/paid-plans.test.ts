import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, completion, createService, liquidCompletion, luminalUsage, MODEL, NOW, openaiResponse, responsesUsage, sse, usage, type OpenRouterHandler, type Service } from "./harness.js";
import { readFreeConfig } from "../src/config.js";
import { approxTokens, countedFactor, countedLimit, planCost, planLimits, PLAN_DEFAULTS, usdPerMillionReal } from "../src/plans.js";
import { creditPrices, modelById } from "../src/models.js";
import { decide, fallbackNotice, limitMessage, timeLeft, warningFor, withNotices } from "../src/plan-limits.js";
import { bonusBlock, canGrantOneMore, measuredRunRate, projectedSpend, weeksLeft, BONUS_ENDS_AT } from "../src/gpt6-bonus.js";
import { SAFEGUARD_MODEL } from "../src/presend-guard.js";
import { toAnthropicStream } from "../src/anthropic.js";
import { bonusAccountView, planLimitsView } from "../src/plan-usage.js";

/**
 * dl.new's paid plans (plans.ts, plan-limits.ts, plan-route.ts): fixed weekly limits per model in
 * counted tokens, the fallback to DeepSeek with its notice, the 80% warning, the clear limit
 * error, the end of free tokens, the per-model meters the dashboard reads, and the GPT-6 launch
 * bonus behind its setting.
 */

const KIMI = "moonshotai/kimi-k3.1-pro";
const SOL = "gpt-6.1-sol";
const BASE = { TOKEN_SIGNING_KEY: "x".repeat(32), OPENROUTER_API_KEY: "k", GITHUB_CLIENT_ID: "i", GITHUB_CLIENT_SECRET: "s" };
const KEYS = { OPENAI_API_KEY: "sk-openai-test", LUMINAL_API_KEY: "lum-test", LIQUID_INFERENCE_API_KEY: "sk-liquid", LIQUID_STATUS: "on" };
const DAY = 86_400_000;
const config = (vars: Record<string, string> = {}) => readFreeConfig({ ...BASE, ...vars });

let ips = 0;
const ip = () => `10.7.${Math.floor(++ips / 250) % 250}.${ips % 250}`;

async function world(vars: Record<string, string> = {}, options: { userEmail?: boolean } = {}) {
  const service = await createService({ OPEN_ADMISSION: "true", DL_ONLY: "false", PAID_PLANS: "true", ...KEYS, ...vars }, options);
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const token = (await service.signIn({ id: 100, login: "alice" })).access_token;
  return { service, admin, token };
}

/** Makes account 100 a paying subscriber on `tier`. */
async function subscribe(service: Service, tier: "starter" | "plus" | "max", githubId = 100): Promise<void> {
  await service.account(githubId).applySubscription({ subscriptionId: `sub_${githubId}`, state: "active", periodEnd: service.clock.now + 60 * DAY, eventAt: 1 });
  assert.equal(await service.account(githubId).setPlanTier(tier), true);
}

const chat = (service: Service, token: string, model: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  service.request("POST", "/v1/chat/completions", { token, ip: ip(), headers, body: { model, messages: [{ role: "user", content: "hello" }], ...body } });

async function errorOf(response: Response): Promise<Record<string, any>> {
  return ((await response.json()) as { error: Record<string, any> }).error;
}

async function contentOf(response: Response): Promise<string> {
  const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
  return body.choices[0]!.message.content;
}

async function usageOf(service: Service, token: string): Promise<Record<string, any>> {
  const response = await service.request("GET", "/v1/usage", { token, ip: ip() });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as Record<string, any>;
}

describe("paid plans: the numbers", () => {
  it("converts real tokens to counted at the 95.5% mix: x0.0641 at cachedTokenWeight 0.02", () => {
    assert.equal(Math.round(countedFactor(0.02) * 1e6) / 1e6, 0.0641);
    assert.equal(countedLimit(62_000_000, 0.02), 3_974_200);
    const limits = Object.fromEntries((["starter", "plus", "max"] as const).map((plan) => [plan, planLimits(plan, config()).map((limit) => [limit.model, limit.realTokens, limit.countedTokens])]));
    assert.deepEqual(limits, {
      starter: [[MODEL, 62_000_000, 3_974_200]],
      plus: [
        [MODEL, 150_000_000, 9_615_000],
        [KIMI, 1_500_000, 96_150],
      ],
      max: [
        [MODEL, 450_000_000, 28_845_000],
        [KIMI, 4_000_000, 256_400],
      ],
    });
    // Max is DeepSeek and Kimi only for launch: no GLM on any plan.
    assert.ok(!Object.keys(PLAN_DEFAULTS).some((key) => key.includes("glm")));
  });

  it("follows the live cachedTokenWeight and the runtime settings", () => {
    assert.equal(countedLimit(62_000_000, 0.1), Math.round(62_000_000 * (0.955 * 0.1 + 0.045)));
    const changed = config({ PLAN_TOKENS_STARTER_DEEPSEEK: "70000000" });
    assert.equal(planLimits("starter", changed)[0]!.realTokens, 70_000_000);
    // 0 takes a model out of a plan.
    assert.deepEqual(planLimits("plus", config({ PLAN_TOKENS_PLUS_KIMI: "0" })).map((limit) => limit.model), [MODEL]);
  });

  it("costs a fully used Max more than $30 a month: DeepSeek alone at the measured cost", () => {
    const measured = (model: string) => (model === MODEL ? 0.019 : usdPerMillionReal(creditPrices(modelById(model)!)));
    const max = planCost("max", config(), measured);
    // 450M x $0.019 = $8.55 a week, $37.05 a month; Kimi 4M x $0.4117 = $1.65 a week, $7.14 a month.
    assert.equal(Math.round(max.lines[0]!.usdPerMonth * 100) / 100, 37.05);
    assert.equal(Math.round(max.lines[1]!.usdPerMonth * 100) / 100, 7.14);
    assert.ok(max.usdPerMonth > 30);
    const atList = planCost("max", config(), (model) => usdPerMillionReal(creditPrices(modelById(model)!)));
    assert.equal(Math.round(atList.lines[0]!.usdPerMonth * 100) / 100, 23.74);
  });

  it("writes the copy as specified", () => {
    assert.equal(approxTokens(62_000_000), "~62M");
    assert.equal(approxTokens(1_500_000), "~1.5M");
    assert.equal(approxTokens(450_000_000), "~450M");
    assert.equal(fallbackNotice("Kimi K3.1", "DeepSeek V4.1 Flash"), "Kimi K3.1 used up until Mon 00:00 UTC, now using DeepSeek V4.1 Flash.");
    // NOW is a Wednesday at 12:00 UTC: Monday 00:00 is 4 days and 12 hours away.
    assert.equal(timeLeft(NOW, Date.UTC(2026, 10, 9)), "4d 12h");
    assert.equal(
      limitMessage("DeepSeek V4.1 Flash", NOW, { plan: "plus", realTokens: 150_000_000 }),
      "DeepSeek V4.1 Flash weekly limit reached, resumes Mon 00:00 UTC (in 4d 12h). Upgrade to Plus for ~150M/week: dl.new/upgrade",
    );
    const warning = warningFor({ model: MODEL, name: "DeepSeek V4.1 Flash", counted: 3_200_000, limit: 3_974_200, realLimit: 62_000_000 });
    assert.equal(warning, "DeepSeek V4.1 Flash: 80% used (~49.9M of ~62M at 95.5% caching). ~12.1M left until Mon 00:00 UTC.");
    assert.equal(warningFor({ model: MODEL, name: "x", counted: 3_000_000, limit: 3_974_200, realLimit: 62_000_000 }), undefined);
  });

  it("decides: serve, fall back to DeepSeek, or refuse", () => {
    const cfg = config();
    const base = { plan: "plus" as const, fallback: true, deepseekAvailable: true, config: cfg, now: NOW };
    assert.equal(decide({ ...base, requested: KIMI, counted: {} }).kind, "serve");
    const fell = decide({ ...base, requested: KIMI, counted: { [KIMI]: 96_150 } });
    assert.deepEqual(fell.kind === "serve" && [fell.model, fell.fellBack, fell.fallbackNotice], [MODEL, true, "Kimi K3.1 used up until Mon 00:00 UTC, now using DeepSeek V4.1 Flash."]);
    const off = decide({ ...base, fallback: false, requested: KIMI, counted: { [KIMI]: 96_150 } });
    assert.equal(off.kind === "refuse" && off.message, "Kimi K3.1 weekly limit reached, resumes Mon 00:00 UTC (in 4d 12h). Upgrade to Max for ~4M/week: dl.new/upgrade");
    const both = decide({ ...base, requested: KIMI, counted: { [KIMI]: 96_150, [MODEL]: 9_615_000 } });
    assert.equal(both.kind === "refuse" && both.code, "plan_limit");
    const top = decide({ ...base, plan: "max", requested: MODEL, counted: { [MODEL]: 28_845_000 } });
    assert.equal(top.kind === "refuse" && top.message, "DeepSeek V4.1 Flash weekly limit reached, resumes Mon 00:00 UTC (in 4d 12h).");
    const starter = decide({ ...base, plan: "starter", requested: KIMI, counted: {} });
    assert.equal(starter.kind === "refuse" && starter.message, "Kimi K3.1 isn't in your Starter plan, which includes DeepSeek V4.1 Flash. Upgrade to Plus to use it: dl.new/upgrade");
  });
});

describe("paid plans: through the API", () => {
  it("meters a Starter account per model in counted tokens, and stops it at the limit with the upgrade line", async () => {
    const { service, token } = await world();
    await subscribe(service, "starter");
    // 4,000,000 prompt tokens, 3,800,000 of them cached: 200,000 fresh + 76,000 for the cache + 10 out.
    service.setLuminal(() => completion(luminalUsage(4_000_000, 10, 3_800_000)));
    assert.equal((await chat(service, token, MODEL)).status, 200);
    let view = await usageOf(service, token);
    assert.equal(view.plan, "starter");
    const deepseek = view.models.find((model: Record<string, unknown>) => model.model === MODEL);
    assert.equal(deepseek.countedUsed, 276_010);
    assert.equal(deepseek.countedLimit, 3_974_200);
    assert.equal(deepseek.realLimit, 62_000_000);
    assert.equal(deepseek.cachingPct, 95);
    assert.equal(view.totals.cachedCountedAs, 76_000);
    assert.equal(view.tools[0].tool, "autopilot");
    // Past the limit: the clear error, with the time left and Plus.
    service.setLuminal(() => completion(luminalUsage(4_000_000, 10)));
    assert.equal((await chat(service, token, MODEL)).status, 200);
    const refused = await chat(service, token, MODEL);
    assert.equal(refused.status, 402);
    const error = await errorOf(refused);
    assert.equal(error.code, "plan_limit");
    assert.equal(error.message, "DeepSeek V4.1 Flash weekly limit reached, resumes Mon 00:00 UTC (in 4d 12h). Upgrade to Plus for ~150M/week: dl.new/upgrade");
    assert.equal(error.upgradeUrl, "https://dl.new/upgrade");
    // Monday 00:00 UTC: a new week.
    service.clock.now = Date.UTC(2026, 10, 9);
    const again = (await service.signIn({ id: 100, login: "alice" })).access_token;
    assert.equal((await chat(service, again, MODEL)).status, 200);
    view = await usageOf(service, again);
    assert.equal(view.models[0].countedUsed, 4_000_010);
  });

  it("keeps Kimi out of Starter, with the provider_limit shape pointing at DeepSeek", async () => {
    const { service, token } = await world();
    await subscribe(service, "starter");
    const refused = await chat(service, token, KIMI);
    assert.equal(refused.status, 402);
    const error = await errorOf(refused);
    assert.equal(error.code, "provider_limit");
    assert.equal(error.reason, "not_in_plan");
    assert.equal(error.alternative, MODEL);
    assert.equal(service.calls.liquid.length, 0);
  });

  it("serves Plus its Kimi past the old Pro ration, then falls back to DeepSeek with the notice in the answer", async () => {
    const { service, token } = await world();
    await subscribe(service, "plus");
    // 120,000 fresh tokens: more than Plus's 96,150 counted Kimi tokens in one request.
    service.setLiquid(() => liquidCompletion(luminalUsage(120_000, 10), 0.3));
    const first = await chat(service, token, KIMI);
    assert.equal(first.status, 200);
    assert.equal(service.calls.liquid.length, 1);
    const second = await chat(service, token, KIMI);
    assert.equal(second.status, 200);
    assert.equal(service.calls.liquid.length, 1, "DeepSeek served");
    assert.equal(service.calls.luminal.length, 1);
    assert.equal(second.headers.get("x-dl-notice"), "Kimi K3.1 used up until Mon 00:00 UTC, now using DeepSeek V4.1 Flash.");
    assert.equal(second.headers.get("x-dl-fallback"), null, "not Autopilot's provider-failure line");
    assert.equal(await contentOf(second), "[dl.new] Kimi K3.1 used up until Mon 00:00 UTC, now using DeepSeek V4.1 Flash.\n\nhi");
    const view = await usageOf(service, token);
    assert.equal(view.models.find((model: Record<string, unknown>) => model.model === MODEL).failovers, 1);
    assert.equal(view.totals.failovers, 1);
    service.directory();
    const row = (service.namespaces.DIRECTORY!.instances.get("directory")!.state as any).db.prepare("SELECT model, failover FROM requests WHERE github_id = 100 ORDER BY id").all();
    assert.deepEqual(row.map((r: any) => [r.model, r.failover]), [[KIMI, 0], [MODEL, 1]]);
  });

  it("refuses at Kimi's limit when the person turned the fallback off", async () => {
    const { service, token } = await world();
    await subscribe(service, "plus");
    const set = await service.request("POST", "/v1/plan/fallback", { token, ip: ip(), body: { on: false } });
    assert.equal(set.status, 200);
    service.setLiquid(() => liquidCompletion(luminalUsage(120_000, 10), 0.3));
    assert.equal((await chat(service, token, KIMI)).status, 200);
    const refused = await chat(service, token, KIMI);
    assert.equal(refused.status, 402);
    const error = await errorOf(refused);
    assert.equal(error.code, "plan_limit");
    assert.equal(error.message, "Kimi K3.1 weekly limit reached, resumes Mon 00:00 UTC (in 4d 12h). Upgrade to Max for ~4M/week: dl.new/upgrade");
    assert.equal(error.fallback, false);
    assert.equal(service.calls.luminal.length, 0);
  });

  it("puts the notice first in a stream, as its own chunk, which Claude Code's translation shows as text", async () => {
    const { service, token } = await world();
    await subscribe(service, "plus");
    service.setLiquid(() => liquidCompletion(luminalUsage(120_000, 10), 0.3));
    await chat(service, token, KIMI);
    service.setLuminal(() => sse([JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" } }] }), JSON.stringify({ choices: [], usage: luminalUsage(100, 1) })]));
    const response = await chat(service, token, KIMI, { stream: true });
    assert.equal(response.status, 200);
    const text = await response.text();
    const first = JSON.parse(text.split("\n\n")[0]!.slice("data: ".length));
    assert.equal(first.choices[0].delta.content, "[dl.new] Kimi K3.1 used up until Mon 00:00 UTC, now using DeepSeek V4.1 Flash.\n\n");
    assert.match(text, /"content":"ok"/);
    // The same stream through the Anthropic translation: a text block that starts with the notice.
    const translated = await new Response(toAnthropicStream(new Response(text).body!, { model: "claude-sonnet-4", thinking: false, stopSequences: [] })).text();
    assert.match(translated, /"text_delta","text":"\[dl\.new\] Kimi K3\.1 used up/);
  });

  it("warns once per model per week at 80%, in the answer and by email", async () => {
    const { service, token } = await world({ RESEND_API_KEY: "re_test" });
    await service.directory().setEmail(100, "alice@example.com", false, NOW);
    await subscribe(service, "starter");
    service.setLuminal(() => completion(luminalUsage(3_300_000, 10)));
    const first = await chat(service, token, MODEL);
    assert.equal(first.headers.get("x-dl-notice"), null, "0% when it was reserved");
    service.setLuminal(() => completion(luminalUsage(100, 10)));
    const second = await chat(service, token, MODEL);
    assert.equal(await contentOf(second), "[dl.new] DeepSeek V4.1 Flash: 83% used (~51.5M of ~62M at 95.5% caching). ~10.5M left until Mon 00:00 UTC.\n\nhi");
    await service.settle();
    const third = await chat(service, token, MODEL);
    assert.equal(await contentOf(third), "hi", "once a week");
    const rows = (service.namespaces.DIRECTORY!.instances.get("directory")!.state as any).db.prepare("SELECT kind, period, status FROM user_emails").all();
    assert.deepEqual(rows.map((r: any) => r.kind).sort(), ["plan_80", "welcome"], JSON.stringify(rows));
    const sent = service.calls.resend.filter((call) => String(call.body.subject).includes("of this week used"));
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.body.subject, "DeepSeek V4.1 Flash: 83% of this week used");
    assert.match(String(sent[0]!.body.text), /DeepSeek V4\.1 Flash: 83% used \(~51\.5M of ~62M at 95\.5% caching\)\. ~10\.5M left until mon 00:00 utc\./);
  });

  it("keeps dl Pro's old rules while paidPlans is off", async () => {
    const { service, token } = await world({ PAID_PLANS: "false" });
    await subscribe(service, "starter");
    service.setLiquid(() => liquidCompletion(luminalUsage(100, 10), 0.0001));
    // Kimi is a Pro perk under the old rules; Starter wouldn't include it.
    assert.equal((await chat(service, token, KIMI)).status, 200);
  });

  it("maps Claude Code's model names to the plan's default model, and serves an open-model id the plan has", async () => {
    const { service, token } = await world({ TOOL_KEYS: "true" });
    await subscribe(service, "plus");
    const made = await service.request("POST", "/v1/keys", { token, ip: ip(), body: { name: "cc", kind: "tool" } });
    const key = ((await made.json()) as { key: string }).key;
    const message = (model: string) =>
      service.request("POST", "/anthropic/v1/messages", { ip: ip(), headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }, body: { model, max_tokens: 100, metadata: { user_id: "user_1_account_2_session_abcdef12-3456" }, messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }] } });
    assert.equal((await message("claude-sonnet-4-5")).status, 200);
    assert.equal(service.calls.luminal.at(-1)!.body.model, "deepseek-ai/DeepSeek-V4.1-Flash-1017");
    service.setLiquid(() => liquidCompletion(luminalUsage(100, 10), 0.0001));
    assert.equal((await message(KIMI)).status, 200);
    assert.equal(service.calls.liquid.length, 1);
    // Kimi's prompt cache lives on one seller: Claude Code's session keeps the conversation there.
    assert.equal(service.calls.liquid[0]!.body.session_id, "abcdef12-3456");
    const view = await usageOf(service, token);
    assert.ok(view.tools.some((row: Record<string, unknown>) => String(row.tool).startsWith("tool:")));
  });

  it("ends free tokens at freeEndsAt for non-paying accounts only", async () => {
    const { service } = await world();
    await service.signIn({ id: 200, login: "bob" });
    await subscribe(service, "starter", 200);
    service.clock.now = Date.UTC(2026, 11, 8);
    const token = (await service.signIn({ id: 100, login: "alice" })).access_token;
    const bob = (await service.signIn({ id: 200, login: "bob" })).access_token;
    const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const refused = await chat(service, token, MODEL);
    assert.equal(refused.status, 402);
    const error = await errorOf(refused);
    assert.equal(error.code, "plan_required");
    assert.equal(error.message, "dl.new is paid now. Pick a plan at dl.new to keep going.");
    assert.equal((await chat(service, bob, MODEL)).status, 200, "paying");
    assert.equal((await chat(service, admin, MODEL)).status, 200, "admins");
    // A minute before, free tokens still work.
    const { service: before } = await world();
    before.clock.now = Date.UTC(2026, 11, 8) - 60_000;
    const early = (await before.signIn({ id: 100, login: "alice" })).access_token;
    assert.equal((await chat(before, early, MODEL)).status, 200);
  });

  it("lists the plans publicly, with per-model limits and the bonus state", async () => {
    const { service } = await world();
    const response = await service.request("GET", "/v1/plans", { ip: ip() });
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, any>;
    assert.deepEqual(
      body.plans.map((plan: Record<string, any>) => [plan.id, plan.models.map((model: Record<string, unknown>) => model.text)]),
      [
        ["starter", ["DeepSeek V4.1 Flash ~62M/week (95.5% caching applied)"]],
        ["plus", ["DeepSeek V4.1 Flash ~150M/week (95.5% caching applied)", "Kimi K3.1 ~1.5M/week (95.5% caching applied)"]],
        ["max", ["DeepSeek V4.1 Flash ~450M/week (95.5% caching applied)", "Kimi K3.1 ~4M/week (95.5% caching applied)"]],
      ],
    );
    assert.equal(body.mix.countedFactor, 0.0641);
    assert.equal(body.bonus.enabled, false);
  });
});

describe("the GPT-6 launch bonus: the projection", () => {
  const now = Date.UTC(2026, 11, 1);
  it("projects holders at $2/week to 31 Jan plus the GPT-6 run rate, against the remaining credit", () => {
    const weeks = weeksLeft(now, BONUS_ENDS_AT);
    assert.equal(Math.round(weeks * 100) / 100, 8.86);
    assert.equal(Math.round(projectedSpend({ holders: 100, weeklyUsd: 2, runRateUsdPerWeek: 300, now, endsAt: BONUS_ENDS_AT })), Math.round((200 + 300) * weeks));
    const input = { weeklyUsd: 2, runRateUsdPerWeek: 300, remainingCreditUsd: 4000, now, endsAt: BONUS_ENDS_AT };
    // (300 + 2n) x 8.857 < 4000  ⇔  n < 75.8: the 75th holder fits, the 76th doesn't.
    assert.equal(canGrantOneMore({ ...input, holders: 74 }), true);
    assert.equal(canGrantOneMore({ ...input, holders: 75 }), false);
    assert.equal(canGrantOneMore({ ...input, holders: 0, remainingCreditUsd: 0 }), false, "never on cash");
    assert.equal(canGrantOneMore({ ...input, holders: 0, now: BONUS_ENDS_AT }), false, "ends 31 Jan");
  });

  it("measures the run rate from this week's spend, at least a day in", () => {
    const monday = Date.UTC(2026, 10, 30);
    assert.equal(measuredRunRate(100, monday + 2 * DAY), 350);
    assert.equal(measuredRunRate(10, monday + 60_000), 70, "counted as a whole day");
  });

  it("is off by default, Autopilot only, paying only, after the wait, and never with no credit left", () => {
    const on = { ...config({ GPT6_BONUS: "true", GPT6_PRESEND_GUARD: "enforce" }) };
    const ok = { config: on, paying: true, paidSince: now - DAY, agent: undefined, remainingCreditUsd: 100, now };
    assert.equal(bonusBlock({ ...ok, config: config({ GPT6_PRESEND_GUARD: "enforce" }) }), "off");
    assert.equal(bonusBlock({ ...ok, config: { ...on, gpt6PresendGuard: "off" } }), "off", "the pre-send guard stays on");
    assert.equal(bonusBlock(ok), undefined);
    assert.equal(bonusBlock({ ...ok, paying: false }), "not_paying");
    assert.equal(bonusBlock({ ...ok, agent: "tool" }), "client");
    assert.equal(bonusBlock({ ...ok, agent: "claude-code" }), "client");
    assert.equal(bonusBlock({ ...ok, remainingCreditUsd: 0 }), "no_credit");
    assert.equal(bonusBlock({ ...ok, config: { ...on, gpt6BonusDelayHours: 48 } }), "waiting");
    assert.equal(bonusBlock({ ...ok, config: { ...on, gpt6BonusDelayHours: 24 } }), undefined);
    assert.equal(bonusBlock({ ...ok, now: BONUS_ENDS_AT }), "off");
    assert.equal(bonusBlock({ ...ok, config: { ...on, gpt6BonusEndsAt: undefined }, now: BONUS_ENDS_AT }), "off", "ends 31 Jan regardless");
  });
});

describe("the GPT-6 launch bonus: through the API", () => {
  async function bonusWorld(vars: Record<string, string> = {}) {
    const made = await world({ GPT6_BONUS: "true", GPT6_PRESEND_GUARD: "enforce", GPT6_GUARD_TIMEOUT_MS: "200", TOOL_KEYS: "true", ...vars });
    const openRouter: OpenRouterHandler = (body) =>
      body.model === SAFEGUARD_MODEL
        ? Response.json({ id: "sg", object: "chat.completion", model: SAFEGUARD_MODEL, choices: [{ index: 0, message: { role: "assistant", content: "0" } }], usage: usage(900, 30, 0, 0.0002) })
        : completion(usage(100, 10));
    made.service.setOpenRouter(openRouter);
    return made;
  }

  it("serves Sol on its own $2 meter to a paying Autopilot account, with output capped and the safety identifier sent", async () => {
    const { service, token } = await bonusWorld();
    await subscribe(service, "starter");
    const served = await chat(service, token, SOL, { max_tokens: 100_000 });
    assert.equal(served.status, 200, await served.clone().text());
    const call = service.calls.openai.at(-1)!;
    assert.equal(call.body.model, "gpt-6.1-sol");
    assert.ok(Number(call.body.max_output_tokens) <= 16_384);
    assert.ok(call.body.safety_identifier ?? call.body.user, "the per-user safety identifier");
    const view = await usageOf(service, token);
    assert.equal(view.bonus.granted, true);
    assert.ok(view.bonus.spentUsd >= 0 && view.bonus.leftUsd <= 2);
    assert.equal(view.models.some((model: Record<string, unknown>) => model.model === SOL), false, "not a plan bar");
    // A request that spends the $2 (1M fresh input at $2/M), then DeepSeek with the notice.
    service.setOpenAI(() => openaiResponse(responsesUsage(1_000_000, 10)));
    assert.equal((await chat(service, token, SOL)).status, 200);
    assert.equal((await usageOf(service, token)).bonus.leftUsd, 0);
    const fell = await chat(service, token, SOL);
    assert.equal(fell.status, 200);
    assert.equal(fell.headers.get("x-dl-notice"), "GPT-6 launch bonus used up until Mon 00:00 UTC, now using DeepSeek V4.1 Flash.");
    assert.equal(service.calls.luminal.length, 1);
  });

  it("refuses Sol to tool keys and to non-paying accounts, and Astra to everyone", async () => {
    const { service, token } = await bonusWorld();
    await subscribe(service, "plus");
    const made = await service.request("POST", "/v1/keys", { token, ip: ip(), body: { name: "cursor", kind: "tool" } });
    const key = ((await made.json()) as { key: string }).key;
    const viaTool = await chat(service, key, SOL, {}, { "user-agent": "Cursor/1.9" });
    assert.equal(viaTool.status, 402);
    const astra = await errorOf(await chat(service, token, "gpt-6-astra"));
    assert.equal(astra.code, "gpt_limit");
    assert.equal(astra.reason, "not_in_plan");
  });

  it("doesn't grant a new subscriber the bonus when the projection passes the remaining credit, and says it is fully claimed", async () => {
    // $10 of OpenAI credit left: 8+ weeks at $2 is more than that.
    const { service, token } = await bonusWorld({ OPENAI_CREDIT_USD: "10" });
    await subscribe(service, "starter");
    const refused = await chat(service, token, SOL);
    assert.equal(refused.status, 402);
    const error = await errorOf(refused);
    assert.equal(error.reason, "bonus_fully_claimed");
    assert.equal(service.calls.openai.length, 0);
    const plans = (await (await service.request("GET", "/v1/plans", { ip: ip() })).json()) as Record<string, any>;
    assert.equal(plans.bonus.enabled, true);
    assert.equal(plans.bonus.fullyClaimed, true);
    assert.equal(plans.bonus.fullyClaimedText, "GPT-6 launch bonus: fully claimed");
  });

  it("is refused while the setting is off (the default)", async () => {
    const { service, token } = await bonusWorld({ GPT6_BONUS: "false" });
    await subscribe(service, "starter");
    const error = await errorOf(await chat(service, token, SOL));
    assert.equal(error.code, "gpt_limit");
    assert.equal(error.reason, "bonus_off");
  });
});

describe("notices in a JSON answer", () => {
  it("leaves error answers alone", async () => {
    const error = Response.json({ error: { message: "x" } }, { status: 402 });
    assert.equal(await withNotices(error, ["n"], MODEL), error);
  });
});

describe("the dashboard's plan data (CONTRACT.md part B)", () => {
  const meters = { weekStart: Date.UTC(2026, 10, 2), models: [{ model: MODEL, counted: 3_200_000, prompt: 50_000_000, cached: 47_800_000, output: 300_000, requests: 40, failovers: 1, costUsd: 0.5 }], days: [], tools: [], bonusUsd: 0.8 };
  const state = { tier: "starter" as const, paidSince: NOW, fallback: true, counted: {}, bonusUsd: 0.8 };
  it("gives one bar per plan model with its state", () => {
    const [bar] = planLimitsView({ state, meters, config: config(), now: NOW })!;
    assert.deepEqual(
      { ...bar, cachingShare: bar!.cachingShare },
      {
        model: MODEL,
        name: "DeepSeek V4.1 Flash",
        tokensPerWeek: 62_000_000,
        countedTokensPerWeek: 3_974_200,
        countedUsed: 3_200_000,
        realUsed: 50_300_000,
        usedAtPlanMix: 49_921_997,
        cachingShare: 0.956,
        percent: 80,
        resetsAt: "2026-11-09T00:00:00.000Z",
        state: "warning",
      },
    );
    assert.equal(planLimitsView({ state: { ...state, tier: "none" }, meters, config: config(), now: NOW }), null);
  });
  it("shows the bonus only while it is on and granted", () => {
    assert.equal(bonusAccountView({ state, meters, config: config(), granted: true, now: NOW }), null);
    const view = bonusAccountView({ state, meters, config: config({ GPT6_BONUS: "true" }), granted: true, now: NOW })!;
    assert.deepEqual([view.usdPerWeek, view.usedUsd, view.leftUsd, view.until, view.label], [2, 0.8, 1.2, "2027-01-31", "launch bonus, through 31 Jan 2027"]);
  });
});
