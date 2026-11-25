import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, completion, createService, errorCode, luminalUsage, MODEL, usage, type OpenRouterHandler, type Service } from "./harness.js";
import { buy, DL, emailSignIn, FakeStripe, PAID_VARS, webhook } from "./paid-fixtures.js";
import { parseAccountId, PAID_ACCOUNT_BASE } from "../src/accounts.js";
import { classOfKind, emailRoom, type EmailBudget } from "../src/email-budget.js";
import { planResetValues } from "../src/plan-reset.js";
import { PLAN_DEFAULTS } from "../src/plans.js";
import { SAFEGUARD_MODEL } from "../src/presend-guard.js";

// After the harness: app.js loads cloudflare:workers, which the harness resolves.
const { DIGEST_CRON } = await import("../src/app.js");

/**
 * dl.new's paid launch, parts A and B together (CONTRACT.md): the plan an account pays for is
 * the plan its requests are held to, the pages read part B's limits and meters, the GPT-6 launch
 * bonus starts right away for paying accounts, the welcome email, the daily email budget, the
 * free tier's lifecycle emails kept off dl.new accounts, and the Monday email to paying accounts.
 */

const SOL = "gpt-6.1-sol";
const KIMI = "moonshotai/kimi-k3.1-pro";
const DAY = 86_400_000;
const HOUR = 3_600_000;
const KEYS = { OPENAI_API_KEY: "sk-openai-test", LIQUID_INFERENCE_API_KEY: "sk-liquid", LIQUID_STATUS: "on", DL_ONLY: "false", SPEED_PROBES: "false" };

async function world(vars: Record<string, string> = {}) {
  const service = await createService({ ...PAID_VARS, ...KEYS, PAID_PLANS: "true", ...vars }, { userEmail: true });
  return { service, stripe: new FakeStripe(service) };
}

async function paidAccount(service: Service, stripe: FakeStripe, plan: "starter" | "plus" | "max" = "starter", email = "pat@example.com") {
  const session = await buy(service, stripe, plan, email);
  const signedIn = await emailSignIn(service, email, session.id);
  await service.settle();
  return { session, signedIn, account: parseAccountId(signedIn.account.accountId)!, token: signedIn.token };
}

async function apiKey(service: Service, token: string): Promise<string> {
  const made = await service.request("POST", "/web/api-keys", { token, body: { name: "cc" }, headers: DL });
  assert.equal(made.status, 201, await made.clone().text());
  return ((await made.json()) as { key: string }).key;
}

const chat = (service: Service, token: string, model: string, headers: Record<string, string> = {}) =>
  service.request("POST", "/v1/chat/completions", { token, headers, body: { model, messages: [{ role: "user", content: "hello" }] } });

function emailsTo(service: Service, to: string): Array<{ subject: string; text: string }> {
  return service.calls.userEmail.filter((entry) => entry.to === to).map((entry) => ({ subject: String(entry.subject), text: String(entry.text) }));
}

/** A dl.new account's Account object (named `acct:<n>`, accounts.ts accountObjectName). */
function accountObject(service: Service, account: number): any {
  return (service.namespaces.ACCOUNT as any).getByName(`acct:${account}`);
}

async function admin(service: Service): Promise<string> {
  return (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
}

describe("parts A and B: one plan", () => {
  it("holds a dl.new account to the plan it paid for, and shows the plan's bars on the account and usage pages", async () => {
    const { service, stripe } = await world();
    const { account, token } = await paidAccount(service, stripe, "plus");
    const state = await accountObject(service, account).planState(service.clock.now, []);
    assert.equal(state.tier, "plus", "billing's tier (part A), not part B's meta");
    const key = await apiKey(service, token);
    service.setLuminal(() => completion(luminalUsage(4_000, 10, 3_800)));
    assert.equal((await chat(service, key, MODEL)).status, 200);
    const me = (await (await service.request("GET", "/web/account", { token, headers: DL })).json()) as any;
    assert.deepEqual(me.limits.map((bar: any) => [bar.model, bar.tokensPerWeek, bar.countedTokensPerWeek]), [
      [MODEL, 150_000_000, 9_615_000],
      [KIMI, 1_500_000, 96_150],
    ]);
    assert.equal(me.limits[0].countedUsed, 200 + 76 + 10);
    assert.equal(me.limits[0].state, "ok");
    assert.equal(me.gpt6Bonus, null, "the bonus is off by default");
    assert.match(me.plan.description, /^DeepSeek V4\.1 Flash ~150M\/week \+ Kimi K3\.1 ~1\.5M\/week \(95\.5% caching applied\)/);
    const week = (await (await service.request("GET", "/web/usage", { token, headers: DL })).json()) as any;
    assert.equal(week.plan, "plus");
    assert.deepEqual(week.models.map((model: any) => [model.model, model.limit?.tokensPerWeek]), [
      [MODEL, 150_000_000],
      [KIMI, 1_500_000],
    ]);
    assert.equal(week.models[0].countedTokens, 286);
    assert.deepEqual(week.tools.map((tool: any) => tool.tool), ["other"]);
  });

  it("keeps the fallback setting in one store: /web/settings is what the plan reads", async () => {
    const { service, stripe } = await world();
    const { account, token } = await paidAccount(service, stripe, "plus");
    const put = await service.request("PUT", "/web/settings", { token, body: { fallback: false }, headers: DL });
    assert.deepEqual(await put.json(), { fallback: false });
    assert.equal((await accountObject(service, account).planState(service.clock.now, [])).fallback, false);
    await accountObject(service, account).setPlanFallback(true);
    assert.deepEqual(await (await service.request("GET", "/web/settings", { token, headers: DL })).json(), { fallback: true });
  });

  it("builds /web/plans from the live plan settings, with A's prices and the bonus offer", async () => {
    const { service } = await world();
    const owner = await admin(service);
    assert.equal((await service.request("POST", "/admin/config", { token: owner, body: { "planTokens.starter.deepseek": 70_000_000 } })).status, 200);
    const body = (await (await service.request("GET", "/web/plans", { headers: DL })).json()) as any;
    assert.deepEqual(body.plans.map((plan: any) => [plan.id, plan.priceUsd]), [["starter", 7], ["plus", 20], ["max", 60]]);
    assert.equal(body.plans[0].models[0].tokensPerWeek, 70_000_000);
    assert.equal(body.plans[0].models[0].text, "DeepSeek V4.1 Flash ~70M/week (95.5% caching applied)");
    assert.equal(body.plans[0].description, "DeepSeek V4.1 Flash ~70M/week (95.5% caching applied). Weekly limits reset Mon 00:00 UTC.");
    assert.equal(body.plans[2].models.length, 2);
    assert.equal(body.caching.realToCounted, 0.0641);
    assert.equal(body.gpt6Bonus.enabled, false);
    // No public refund promise: the window is the admin refund's alone.
    assert.equal(body.refundWindowHours, undefined);
    assert.equal(body.refundPolicy, undefined);
    assert.doesNotMatch(JSON.stringify(body), /refund/i);
  });

  it("gives a dl.new account with no active plan no free tokens (plan_required)", async () => {
    const { service, stripe } = await world({ FREE_ENDS_AT: "none" });
    const { session, token } = await paidAccount(service, stripe);
    const key = await apiKey(service, token);
    service.setLuminal(() => completion(luminalUsage(100, 10)));
    assert.equal((await chat(service, key, MODEL)).status, 200);
    const subscription = stripe.subscriptions.get(session.subscription!)!;
    subscription.status = "canceled";
    service.clock.now += 60_000;
    assert.equal((await webhook(service, "customer.subscription.deleted", stripe.subscriptionObject(subscription))).status, 200);
    const refused = await chat(service, key, MODEL);
    assert.equal(refused.status, 402);
    const error = ((await refused.json()) as any).error;
    assert.equal(error.code, "plan_required");
    assert.equal(error.message, "dl.new is paid now. Pick a plan at dl.new to keep going.");
    // Free tokens haven't ended (FREE_ENDS_AT none): a free-tier GitHub account still works.
    const free = (await service.signIn({ id: 300, login: "carol" })).access_token;
    assert.equal((await chat(service, free, MODEL)).status, 200);
  });
});

describe("the GPT-6 launch bonus for paying accounts", () => {
  async function bonusWorld(vars: Record<string, string> = {}) {
    const made = await world({ GPT6_BONUS: "true", GPT6_PRESEND_GUARD: "enforce", GPT6_GUARD_TIMEOUT_MS: "200", GPT6_TRUSTED_WEEKLY_USD_CAP: "5", ...vars });
    const openRouter: OpenRouterHandler = (body) =>
      body.model === SAFEGUARD_MODEL
        ? Response.json({ id: "sg", object: "chat.completion", model: SAFEGUARD_MODEL, choices: [{ index: 0, message: { role: "assistant", content: "0" } }], usage: usage(900, 30, 0, 0.0002) })
        : completion(usage(100, 10));
    made.service.setOpenRouter(openRouter);
    return made;
  }

  it("starts right away (no wait) and skips the trust gate for the bonus only", async () => {
    const { service } = await bonusWorld();
    // A brand-new paying Autopilot account: not trusted (no weeks of use), paying since just now.
    const payer = (await service.signIn({ id: 100, login: "alice" })).access_token;
    await service.account(100).applySubscription({ subscriptionId: "sub_100", state: "active", periodEnd: service.clock.now + 60 * DAY, eventAt: 1, tier: "starter" });
    const served = await chat(service, payer, SOL);
    assert.equal(served.status, 200, await served.clone().text());
    assert.equal(service.calls.openai.at(-1)!.body.model, SOL);
    // GPT-6 outside the bonus still needs trust: a free account is refused by the trust gate.
    const free = (await service.signIn({ id: 200, login: "bob" })).access_token;
    const refused = await chat(service, free, SOL);
    assert.equal(refused.status, 402);
    assert.equal(((await refused.json()) as any).error.reason, "trust");
    // The pre-send guard still runs on bonus requests.
    assert.ok(service.calls.openRouter.some((call) => call.body.model === SAFEGUARD_MODEL));
  });

  it("is granted on claim and named in the welcome email, and shown on the account", async () => {
    const { service, stripe } = await bonusWorld();
    const { token } = await paidAccount(service, stripe, "starter", "bea@example.com");
    const [welcome] = emailsTo(service, "bea@example.com").filter((email) => email.subject === "your dl.new key is ready");
    assert.ok(welcome);
    assert.match(welcome.text, /\nplus \$2\/week of GPT-6\.1 Sol usage in dl, launch bonus through 31 Jan 2027\.\n/);
    const me = (await (await service.request("GET", "/web/account", { token, headers: DL })).json()) as any;
    assert.equal(me.gpt6Bonus.usdPerWeek, 2);
    assert.equal(me.gpt6Bonus.label, "launch bonus, through 31 Jan 2027");
  });
});

describe("the welcome email", () => {
  it("goes once on claim: the key, the commands, sign-in, each limit with its caching label, no refund promise", async () => {
    const { service, stripe } = await world();
    const { session } = await paidAccount(service, stripe, "plus", "ann@example.com");
    const welcomes = emailsTo(service, "ann@example.com").filter((email) => email.subject === "your dl.new key is ready");
    assert.equal(welcomes.length, 1);
    const text = welcomes[0]!.text;
    for (const part of [
      "thanks for subscribing to dl.new Plus.",
      "https://dl.new/connect",
      "    curl -fsSL dl.new | sh\n",
      "    dl claude\n",
      "https://api.dl.new/v1",
      "https://dl.new/keys",
      "https://dl.new/signin",
      "- DeepSeek V4.1 Flash ~150M/week (95.5% caching applied)\n- Kimi K3.1 ~1.5M/week (95.5% caching applied)\n",
      "\nsina\n",
    ]) {
      assert.ok(text.includes(part), `missing ${JSON.stringify(part)}`);
    }
    assert.doesNotMatch(text, /GPT-6/, "no bonus line while the bonus is off");
    assert.doesNotMatch(text, /refund/i, "no refund promise");
    assert.doesNotMatch(text, /first month was/, "no offer line on a full-price payment");
    // Signing in again with the same payment doesn't send it again.
    service.clock.now += 60_000;
    await emailSignIn(service, "ann@example.com", session.id);
    await service.settle();
    assert.equal(emailsTo(service, "ann@example.com").filter((email) => email.subject === "your dl.new key is ready").length, 1);
  });

  it("goes even when the day's bulk share is used up (transactional reserve)", async () => {
    const { service, stripe } = await world({ USER_EMAILS_DAILY_MAX: "1", USER_EMAILS_TRANSACTIONAL_RESERVE: "1" });
    await paidAccount(service, stripe, "starter", "tia@example.com");
    assert.equal(emailsTo(service, "tia@example.com").filter((email) => email.subject === "your dl.new key is ready").length, 1);
  });
});

describe("the daily email budget", () => {
  const budget: EmailBudget = { dailyMax: 300, transactionalReserve: 100, codesMax: 300 };

  it("keeps the reserve for transactional mail and gives codes their own ceiling", () => {
    assert.equal(emailRoom("bulk", { code: 0, transactional: 0, bulk: 0 }, budget), 200);
    assert.equal(emailRoom("bulk", { code: 0, transactional: 0, bulk: 200 }, budget), 0);
    assert.equal(emailRoom("transactional", { code: 0, transactional: 0, bulk: 200 }, budget), 100);
    // Transactional mail may also use what bulk left: bulk never takes the reserve, but not the other way round.
    assert.equal(emailRoom("transactional", { code: 0, transactional: 250, bulk: 0 }, budget), 50);
    assert.equal(emailRoom("bulk", { code: 0, transactional: 250, bulk: 0 }, budget), 50);
    assert.equal(emailRoom("transactional", { code: 0, transactional: 100, bulk: 200 }, budget), 0);
    // Codes don't count against the daily max, and the daily max doesn't stop them.
    assert.equal(emailRoom("code", { code: 0, transactional: 100, bulk: 200 }, budget), 300);
    assert.equal(emailRoom("code", { code: 300, transactional: 0, bulk: 0 }, budget), 0);
    assert.equal(emailRoom("bulk", { code: 0, transactional: 0, bulk: 0 }, { ...budget, transactionalReserve: 500 }), 0);
    assert.equal(classOfKind("welcome_paid"), "transactional");
    assert.equal(classOfKind("plan_80"), "transactional");
    assert.equal(classOfKind("claim"), "transactional");
    for (const kind of ["welcome", "didnt_start", "week_80", "gone_quiet", "weekly_reset", "plan_reset", "broadcast"] as const) assert.equal(classOfKind(kind), "bulk", kind);
  });

  it("sends sign-in codes past the daily max, up to their own ceiling", async () => {
    const { service, stripe } = await world({ USER_EMAILS_DAILY_MAX: "0", EMAIL_CODES_DAILY_MAX: "2" });
    const one = await buy(service, stripe, "starter", "c1@example.com");
    const start = (email: string, sessionId: string) => service.request("POST", "/web/auth/email/start", { body: { email, sessionId }, headers: DL });
    assert.equal((await start("c1@example.com", one.id)).status, 200);
    assert.equal((await start("c2@example.com", one.id)).status, 200);
    const third = await start("c3@example.com", one.id);
    assert.equal(third.status, 503);
    assert.equal(await errorCode(third), "email_unavailable");
  });
});

describe("the free tier's lifecycle emails and dl.new accounts", () => {
  it("skips dl.new accounts for the free tier's kinds, but sends them the plan's", async () => {
    const { service, stripe } = await world();
    const { account } = await paidAccount(service, stripe);
    assert.ok(account >= PAID_ACCOUNT_BASE);
    const claim = (kind: string, period = "") =>
      service.directory().claimUserEmail({ githubId: account, kind, period, now: service.clock.now + 2 * DAY, adminIds: [], includeAdmins: false });
    for (const kind of ["welcome", "welcome_trial", "didnt_start", "week_80", "trial_80", "gone_quiet", "weekly_reset"]) assert.equal(await claim(kind, "w"), undefined, kind);
    assert.ok(await claim("plan_80", "w:deepseek"));
    // Nor are they candidates of the free tier's Monday email or of broadcasts.
    const page = await service.directory().weeklyResetCandidates({ now: service.clock.now, after: 0, limit: 100, policy: undefined, adminIds: [], includeAdmins: false });
    assert.equal(page.people.some((person: { githubId: number }) => person.githubId === account), false);
    const audience = await service.directory().broadcastAudience({ id: "b1", audience: "all", from: null, to: null, now: service.clock.now + 3 * DAY, adminIds: [], includeAdmins: false });
    assert.equal(audience.some((person: { githubId: number }) => person.githubId === account), false);
  });
});

describe("the Monday email to paying accounts (plan_reset)", () => {
  /** Wed 9 Dec 2026, after free tokens ended; its week's Monday is 7 Dec, the next 14 Dec. */
  const PAID_AT = Date.parse("2026-12-09T12:00:00Z");
  const NEXT_MONDAY = Date.parse("2026-12-14T00:00:00Z");

  async function scheduled(service: Service, at: number): Promise<void> {
    service.clock.now = at;
    await (service.handler as unknown as { scheduled(controller: { cron: string; scheduledTime: number }, env: never): Promise<void> }).scheduled({ cron: DIGEST_CRON, scheduledTime: at }, service.env as never);
  }

  async function paidWeek(vars: Record<string, string> = {}) {
    const made = await world(vars);
    made.service.clock.now = PAID_AT;
    const paid = await paidAccount(made.service, made.stripe, "starter", "mo@example.com");
    const key = await apiKey(made.service, paid.token);
    made.service.setLuminal(() => completion(luminalUsage(1_000_000, 7_000, 955_000)));
    assert.equal((await chat(made.service, key, MODEL, { "x-session-id": "sess-a" })).status, 200);
    made.service.clock.now += HOUR;
    assert.equal((await chat(made.service, key, MODEL, { "x-session-id": "sess-b" })).status, 200);
    return { ...made, ...paid };
  }

  const resets = (service: Service) => service.calls.userEmail.filter((entry) => String(entry.subject).endsWith("tokens reset.")).map((entry) => ({ to: String(entry.to), subject: String(entry.subject), text: String(entry.text) }));

  it("sends last week's tokens per model, the caching, the counted math, sessions, and the links", async () => {
    const { service } = await paidWeek();
    await scheduled(service, NEXT_MONDAY + HOUR);
    const sent = resets(service);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, "mo@example.com");
    assert.equal(sent[0]!.subject, "Your ~62M tokens reset.");
    const text = sent[0]!.text;
    for (const part of [
      "your dl.new Starter limits are back to full.",
      "- DeepSeek V4.1 Flash, weekly limit ~62M (95.5% caching applied): 2M tokens, 95.5% cached",
      "  counted: 1,910,000 cached x 2% = 38,200, + 90,000 fresh + 14,000 output = 142,200 of 3,974,200",
      "counted tokens: cached input x 2%, fresh input x 100%, output x 100%.",
      "sessions: 2",
      "failovers: 0",
      "https://dl.new/usage",
      "https://dl.new/billing",
    ]) {
      assert.ok(text.includes(part), `missing ${JSON.stringify(part)} in\n${text}`);
    }
    // Once a week.
    await scheduled(service, NEXT_MONDAY + 2 * HOUR);
    assert.equal(resets(service).length, 1);
  });

  it("waits for the end of free tokens, and follows the weeklyResetEmail switch", async () => {
    const before = await paidWeek({ FREE_ENDS_AT: "2026-12-21T00:00:00Z" });
    await scheduled(before.service, NEXT_MONDAY + HOUR);
    assert.deepEqual(resets(before.service), []);
    const off = await paidWeek({ WEEKLY_RESET_EMAIL: "false" });
    await scheduled(off.service, NEXT_MONDAY + HOUR);
    assert.deepEqual(resets(off.service), []);
  });

  it("renders a model with no use last week", () => {
    const values = planResetValues({
      plan: "plus",
      lastWeek: { weekStart: 0, models: [], days: [], tools: [], bonusUsd: 0 },
      config: { ...PLAN_DEFAULTS, cachedTokenWeight: 0.02 },
      sessions: 0,
    });
    assert.equal(values.tokens, "~150M");
    assert.equal(values.models, "- DeepSeek V4.1 Flash, weekly limit ~150M (95.5% caching applied): not used last week\n- Kimi K3.1, weekly limit ~1.5M (95.5% caching applied): not used last week");
  });
});
