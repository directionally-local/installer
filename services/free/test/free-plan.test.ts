import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, completion, createService, luminalUsage, MODEL, type Service } from "./harness.js";
import { DL, githubRoundTrip, lastCode, PAGE_STATE, PAID_VARS } from "./paid-fixtures.js";
import { readFreeConfig } from "../src/config.js";
import { parseSettingsUpdate } from "../src/runtime-config.js";
import { capacityFull, freeCapacityFullMessage, FREE_PLAN_DEFAULTS, freePlanCountedLimit, freePlanLimitMessage, freePlanLine, freePlanWarning, oldEnough, starterLine } from "../src/free-plan.js";
import { renderUserEmail } from "../src/user-emails.js";

/**
 * dl.new's Free plan (free-plan.ts): no card, GitHub only, DeepSeek V4.1 Flash only, a weekly cap
 * in real tokens (95.5% caching applied) enforced as counted, upgrade prompts at 80% and 100%, a
 * global weekly dollar cap, and one switch (`freePlan`, default "off") that leaves everything as
 * it was while off.
 */

const KIMI = "moonshotai/kimi-k3.1-pro";
const NOW = Date.UTC(2026, 10, 26, 9); // a Thursday
const WEEK = 7 * 86_400_000;
const KEYS = { OPENAI_API_KEY: "sk-openai-test", LIQUID_INFERENCE_API_KEY: "sk-liquid", LIQUID_STATUS: "on", DL_ONLY: "false", SPEED_PROBES: "false" };
// One request of luminalUsage(4000, 10, 3800) counts 200 x 1 + 3800 x 0.02 + 10 = 286. A 5,000
// real-token week (95.5% caching applied) is 321 counted: the 2nd request crosses 80%, the 3rd is refused.
const SMALL = { FREE_PLAN_WEEKLY_REAL_TOKENS: "5000" };
const STARTER = "Starter $7/mo, ~269M tokens/month (~62M/week) (95.5% caching applied)";
const config = readFreeConfig({ TOKEN_SIGNING_KEY: "x".repeat(32), OPENROUTER_API_KEY: "k", GITHUB_CLIENT_ID: "i", GITHUB_CLIENT_SECRET: "s" });

async function world(vars: Record<string, string> = {}) {
  const service = await createService({ ...PAID_VARS, ...KEYS, PAID_PLANS: "true", ...vars }, { userEmail: true, email: true });
  service.clock.now = NOW;
  service.setLuminal(() => completion(luminalUsage(4_000, 10, 3_800)));
  return service;
}

async function admin(service: Service): Promise<string> {
  return (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
}

async function setConfig(service: Service, body: Record<string, unknown>): Promise<void> {
  const response = await service.request("POST", "/admin/config", { token: await admin(service), body });
  assert.equal(response.status, 200, await response.clone().text());
}

async function plans(service: Service): Promise<Record<string, any>> {
  const response = await service.request("GET", "/web/plans", { headers: DL });
  assert.equal(response.status, 200);
  return (await response.json()) as Record<string, any>;
}

type GithubUser = { id: number; login: string; email?: string; createdAt?: string; publicRepos?: number };

async function github(service: Service, user: GithubUser, page = "/signin", extra: Record<string, unknown> = {}) {
  const fragment = await githubRoundTrip(service, user, `https://dl.new${page}`);
  assert.match(fragment, /^signin=/);
  return service.request("POST", "/web/auth/github/session", { body: { code: fragment.slice("signin=".length), state: PAGE_STATE, ...extra }, headers: DL });
}

async function freeAccount(service: Service, user: GithubUser) {
  const response = await github(service, user);
  assert.equal(response.status, 200, await response.clone().text());
  const body = (await response.json()) as any;
  const made = await service.request("POST", "/web/api-keys", { token: body.token, body: { name: "cc" }, headers: DL });
  assert.equal(made.status, 201, await made.clone().text());
  return { body, token: body.token as string, key: ((await made.json()) as { key: string }).key };
}

const chat = (service: Service, key: string, model = MODEL) => service.request("POST", "/v1/chat/completions", { token: key, body: { model, messages: [{ role: "user", content: "hello" }] } });

async function content(response: Response): Promise<string> {
  return ((await response.json()) as any).choices[0].message.content as string;
}

function emailsTo(service: Service, to: string): Array<{ subject: string; text: string }> {
  return service.calls.userEmail.filter((entry) => entry.to === to).map((entry) => ({ subject: String(entry.subject), text: String(entry.text) }));
}

describe("the Free plan: settings, math and copy", () => {
  it("is off by default, with a 10M real-token week, a $150 global cap and a 90-day GitHub age minimum", () => {
    assert.deepEqual(FREE_PLAN_DEFAULTS, { freePlan: "off", freePlanWeeklyRealTokens: 10_000_000, freePlanWeeklyUsdCap: 150, freePlanMinAccountAgeDays: 90 });
    assert.equal(config.freePlan, "off");
    assert.equal(readFreeConfig({ TOKEN_SIGNING_KEY: "x".repeat(32), OPENROUTER_API_KEY: "k", GITHUB_CLIENT_ID: "i", GITHUB_CLIENT_SECRET: "s", FREE_PLAN: "on" }).freePlan, "on");
    assert.throws(() => readFreeConfig({ TOKEN_SIGNING_KEY: "x".repeat(32), OPENROUTER_API_KEY: "k", GITHUB_CLIENT_ID: "i", GITHUB_CLIENT_SECRET: "s", FREE_PLAN: "yes" }));
    assert.deepEqual(parseSettingsUpdate({ freePlan: "on", freePlanWeeklyRealTokens: 12_000_000, freePlanWeeklyUsdCap: 150, freePlanMinAccountAgeDays: 90 }), {
      changes: [
        { key: "freePlan", value: "on" },
        { key: "freePlanWeeklyRealTokens", value: 12_000_000 },
        { key: "freePlanWeeklyUsdCap", value: 150 },
        { key: "freePlanMinAccountAgeDays", value: 90 },
      ],
    });
    assert.ok("error" in parseSettingsUpdate({ freePlan: true }));
  });

  it("enforces the real-token week as counted tokens: cached x 0.02 + fresh + output at the plan mix", () => {
    // 10M real at 95.5% cached, 3.8% fresh, 0.7% output: 10M x (0.955 x 0.02 + 0.038 + 0.007) = 641,000.
    assert.equal(freePlanCountedLimit(config), 641_000);
    assert.equal(freePlanCountedLimit({ freePlanWeeklyRealTokens: 20_000_000, cachedTokenWeight: 0.02 }), 1_282_000);
    assert.equal(freePlanCountedLimit({ freePlanWeeklyRealTokens: 10_000_000, cachedTokenWeight: 1 }), 10_000_000);
  });

  it("says exactly what the owner wrote, with dl.new and the cheapest plan on every upgrade prompt", () => {
    assert.equal(starterLine(config), STARTER);
    assert.equal(freePlanLine(config), "Start free (no card) — 10M tokens/week (95.5% caching applied). Sign in with GitHub.");
    assert.equal(freePlanLimitMessage(10_000_000, config), `Your Free plan's 10M tokens this week (95.5% caching applied) are used. They reset Mon 00:00 UTC. Upgrade at https://dl.new: ${STARTER}.`);
    assert.equal(freePlanWarning({ counted: 520_000, limit: 641_000, realLimit: 10_000_000, config }), `Free plan: 81% of this week used (~8.1M of 10M at 95.5% caching), ~1.9M left until Mon 00:00 UTC. Upgrade at https://dl.new: ${STARTER}.`);
    assert.equal(freeCapacityFullMessage(config), `Free capacity is full this week. It opens again Mon 00:00 UTC. Starter is $7/mo: Upgrade at https://dl.new: ${STARTER}.`);
    for (const kind of ["free_80", "free_100", "welcome_free"] as const) {
      const email = renderUserEmail(kind, { resets: "monday 30 nov", unsubscribeUrl: "https://x/stop", trial: { share: "81", used: "~8.1M", tokens: "10M", left: "~1.9M", upgrade: STARTER } });
      assert.ok(email.body.includes("https://dl.new\n" + STARTER), `${kind}: ${email.body}`);
    }
  });

  it("checks the GitHub account's age and the global cap", () => {
    assert.equal(oldEnough(90, config), true);
    assert.equal(oldEnough(89, config), false);
    assert.equal(oldEnough(undefined, config), false);
    assert.equal(oldEnough(10, { freePlanMinAccountAgeDays: 7 }), true);
    assert.equal(capacityFull(149.99, config), false);
    assert.equal(capacityFull(150, config), true);
  });
});

describe("the Free plan: switched off (the default)", () => {
  it("changes nothing: no offer on /web/plans, GitHub with no account still goes to pick a plan, dl.new/trial is the no-card trial", async () => {
    const service = await world();
    const body = await plans(service);
    assert.equal(body.freePlan, undefined);
    assert.equal(body.trials.noCard.available, true);
    const signin = await github(service, { id: 8001, login: "nofree", email: "nofree@example.com" });
    assert.equal(signin.status, 403);
    const error = ((await signin.json()) as any).error;
    assert.equal(error.code, "no_account");
    assert.ok(error.pending.token);
    const trial = await github(service, { id: 8002, login: "trial", email: "trial@example.com" }, "/trial", { trial: true });
    assert.equal(trial.status, 200);
    const started = (await trial.json()) as any;
    assert.equal(started.trialStarted, true);
    assert.equal(started.account.trial.kind, "no_card");
    assert.equal(started.account.freePlan, null);
  });

  it("refuses an existing Free account like any account without a plan once it is turned off again", async () => {
    const service = await world();
    await setConfig(service, { freePlan: "on" });
    const { key } = await freeAccount(service, { id: 8003, login: "later", email: "later@example.com" });
    assert.equal((await chat(service, key)).status, 200);
    await setConfig(service, { freePlan: "off" });
    const refused = await chat(service, key);
    assert.equal(refused.status, 402);
    assert.equal(((await refused.json()) as any).error.code, "plan_required");
  });
});

describe("the Free plan: switched on", () => {
  it("is offered on /web/plans as the one no-card option, with the upgrade line", async () => {
    const service = await world();
    await setConfig(service, { freePlan: "on" });
    const body = await plans(service);
    assert.equal(body.freePlan.available, true);
    assert.equal(body.freePlan.capacityFull, false);
    assert.equal(body.freePlan.tokensPerWeek, 10_000_000);
    assert.equal(body.freePlan.countedTokensPerWeek, 641_000);
    assert.equal(body.freePlan.line, "Start free (no card) — 10M tokens/week (95.5% caching applied). Sign in with GitHub.");
    assert.deepEqual(body.freePlan.upgrade, { url: "https://dl.new", line: STARTER });
    // The paid plans stay as they were.
    assert.deepEqual(
      body.plans.map((plan: any) => [plan.id, plan.priceUsd]),
      [["starter", 7], ["plus", 20], ["max", 60]],
    );
  });

  it("makes a Free account at a GitHub sign-in with no account: its welcome, a key, DeepSeek only, the week's meter", async () => {
    const service = await world();
    await setConfig(service, { freePlan: "on" });
    const { body, token, key } = await freeAccount(service, { id: 8010, login: "freebie", email: "freebie@example.com" });
    assert.equal(body.created, true);
    assert.equal(body.freePlanStarted, true);
    assert.equal(body.account.plan, null);
    assert.equal(body.account.trial, null);
    assert.equal(body.account.freePlan.plan, "free");
    assert.equal(body.account.freePlan.tokensPerWeek, 10_000_000);
    assert.equal(body.account.freePlan.state, "ok");
    await service.settle();
    const welcome = emailsTo(service, "freebie@example.com").find((m) => m.subject === "you're all set on dl.new");
    assert.ok(welcome, JSON.stringify(emailsTo(service, "freebie@example.com")));
    assert.match(welcome!.text, /10M tokens of deepseek v4\.1 flash every week \(95\.5% caching applied\), no card needed/);
    assert.ok(welcome!.text.includes(STARTER));

    const kimi = await chat(service, key, KIMI);
    assert.equal(kimi.status, 200, await kimi.clone().text());
    assert.match(kimi.headers.get("x-dl-notice") ?? "", /Kimi K3\.1 isn't on the Free plan\. Now using DeepSeek V4\.1 Flash\./);
    // No GPT-6 on Free: never served (a tool key gets GPT-6's Autopilot-only refusal pointing at DeepSeek).
    const gpt = await chat(service, key, "gpt-6-luna");
    assert.equal(gpt.status, 402, await gpt.clone().text());
    assert.equal(((await gpt.json()) as any).error.alternative, "deepseek/deepseek-v4.1-flash-1017");
    await service.settle();
    const usage = (await (await service.request("GET", "/web/usage", { token, headers: DL })).json()) as any;
    assert.equal(usage.freePlan.countedUsed, 286);
    assert.equal(usage.freePlan.label, "(95.5% caching applied)");
    assert.deepEqual(usage.freePlan.upgrade, { url: "https://dl.new", line: STARTER });
    // Only DeepSeek served: Kimi's and GPT-6's meters stay at 0.
    assert.deepEqual(usage.models.map((m: any) => m.model), ["deepseek/deepseek-v4.1-flash-1017"]);
  });

  it("signs up from the terminal: dl's cli-login, a GitHub sign-in that makes a Free account, approve, and dl gets its key", async () => {
    const service = await world();
    await setConfig(service, { freePlan: "on" });
    const started = (await (await service.request("POST", "/v1/cli-login/start", { body: { tool: "dl", deviceName: "laptop" } })).json()) as any;
    assert.equal(started.verificationUri, `https://dl.new/cli-login?code=${started.userCode}`);
    // dl.new/cli-login → /signin?next=/cli-login… → GitHub, no account yet: a Free account.
    const response = await github(service, { id: 8020, login: "fromcli", email: "fromcli@example.com" });
    assert.equal(response.status, 200, await response.clone().text());
    const body = (await response.json()) as any;
    assert.equal(body.created, true);
    const approved = await service.request("POST", `/web/cli-login/${started.userCode}/approve`, { token: body.token, headers: DL });
    assert.equal(approved.status, 200, await approved.clone().text());
    const poll = await service.request("POST", "/v1/cli-login/poll", { body: { loginId: started.loginId } });
    assert.equal(poll.status, 200, await poll.clone().text());
    const got = (await poll.json()) as any;
    assert.match(got.key, /^dl_sk_/);
    assert.equal(got.plan, null);
    // Who signed in, for dl's welcome line.
    assert.equal(got.login, "fromcli");
    assert.equal(got.email, "fromcli@example.com");
    assert.equal((await chat(service, got.key)).status, 200);
    await service.settle();
    // dl's first-tokens line: the Free plan's week in real tokens, only when asked for.
    const plain = (await (await service.request("GET", "/v1/me", { token: got.key })).json()) as any;
    assert.equal("week" in plain, false);
    const me = (await (await service.request("GET", "/v1/me?week=1", { token: got.key })).json()) as any;
    assert.deepEqual(me.week, { tokensPerWeek: 10_000_000, usedAtMix: 4462, leftAtMix: 9_995_538, label: "95.5% caching applied", resetsAt: "2026-11-30T00:00:00.000Z" });
  });

  it("signs an existing account in as usual, and keeps Google and email sign-ins on pick a plan", async () => {
    const service = await world();
    await setConfig(service, { freePlan: "on" });
    const first = await freeAccount(service, { id: 8011, login: "again", email: "again@example.com" });
    const again = (await (await github(service, { id: 8011, login: "again", email: "again@example.com" })).json()) as any;
    assert.equal(again.created, false);
    assert.equal(again.account.accountId, first.body.account.accountId);
    // An email sign-in with no account: the pending sign-in, as before.
    const start = await service.request("POST", "/web/auth/email/start", { body: { email: "mail@example.com" }, headers: DL });
    assert.equal(start.status, 200);
    const verify = await service.request("POST", "/web/auth/email/verify", { body: { email: "mail@example.com", code: lastCode(service, "mail@example.com") }, headers: DL });
    assert.equal(verify.status, 403);
    assert.equal(((await verify.json()) as any).error.code, "no_account");
  });

  it("keeps the free tier's account checks and the GitHub age minimum (configurable)", async () => {
    const service = await world();
    // The minimum at a year: a 209-day-old account (past the free tier's own checks) is too young.
    await setConfig(service, { freePlan: "on", freePlanMinAccountAgeDays: 365 });
    // On dl.new/trial: refused with the reason.
    const young = await github(service, { id: 8020, login: "young", email: "young@example.com", createdAt: "2026-05-01T00:00:00Z" }, "/trial", { trial: true });
    assert.equal(young.status, 403);
    const error = ((await young.json()) as any).error;
    assert.equal(error.code, "free_plan_unavailable");
    assert.equal(error.reason, "not_eligible");
    assert.equal(error.plansUrl, "https://dl.new");
    // The same on dl.new/signin: the sign-in is held for a plan instead.
    const held = await github(service, { id: 8020, login: "young", email: "young@example.com", createdAt: "2026-05-01T00:00:00Z" });
    assert.equal(held.status, 403);
    assert.equal(((await held.json()) as any).error.code, "no_account");
    // A disposable email.
    const disposable = await github(service, { id: 8021, login: "temp", email: "temp@mailinator.com" }, "/trial", { trial: true });
    assert.equal(disposable.status, 403);
    // One account per verified email.
    await freeAccount(service, { id: 8022, login: "one", email: "one@example.com" });
    const other = await github(service, { id: 8023, login: "two", email: "one@example.com" }, "/trial", { trial: true });
    assert.equal(other.status, 403);
    assert.equal(((await other.json()) as any).error.reason, "used");
    // The default 90 days lets it in.
    await setConfig(service, { freePlanMinAccountAgeDays: 90 });
    const ok = await github(service, { id: 8020, login: "young", email: "young@example.com", createdAt: "2026-05-01T00:00:00Z" });
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.equal(((await ok.json()) as any).freePlanStarted, true);
  });

  it("warns at 80% (in the tool and by email, once a week), refuses at 100% with the upgrade line (email once), and resets on Monday", async () => {
    const service = await world(SMALL);
    await setConfig(service, { freePlan: "on" });
    const { token, key } = await freeAccount(service, { id: 8030, login: "small", email: "small@example.com" });
    assert.equal((await chat(service, key)).status, 200);
    await service.settle();
    const second = await chat(service, key);
    assert.equal(second.status, 200);
    assert.equal(await content(second).then((text) => text.split("\n")[0]), `[dl.new] Free plan: 89% of this week used (~4.5K of 5K at 95.5% caching), ~545 left until Mon 00:00 UTC. Upgrade at https://dl.new: ${STARTER}.`);
    await service.settle();
    const third = await chat(service, key);
    assert.equal(third.status, 402);
    const error = ((await third.json()) as any).error;
    assert.equal(error.code, "free_plan_limit");
    assert.equal(error.message, `Your Free plan's 5K tokens this week (95.5% caching applied) are used. They reset Mon 00:00 UTC. Upgrade at https://dl.new: ${STARTER}.`);
    assert.deepEqual(error.upgrade, { url: "https://dl.new", line: STARTER });
    assert.equal((await chat(service, key)).status, 402);
    await service.settle();
    const emails = emailsTo(service, "small@example.com");
    const at80 = emails.filter((m) => m.subject === "your free plan is 89% used this week");
    const at100 = emails.filter((m) => m.subject === "your free plan tokens are used for this week");
    assert.equal(at80.length, 1, JSON.stringify(emails.map((m) => m.subject)));
    assert.equal(at100.length, 1);
    for (const mail of [...at80, ...at100]) assert.ok(mail.text.includes(`https://dl.new\n${STARTER}`), mail.text);
    const usage = (await (await service.request("GET", "/web/usage", { token, headers: DL })).json()) as any;
    assert.equal(usage.freePlan.state, "used_up");
    assert.match(usage.freePlan.line, /are used\. They reset Mon 00:00 UTC\. Upgrade at https:\/\/dl\.new/);
    // Next week: a fresh cap.
    service.clock.now = NOW + WEEK;
    assert.equal((await chat(service, key)).status, 200);
  });

  it("refuses new Free requests once Free accounts together reach the weekly dollar cap, and /web/plans says so", async () => {
    const service = await world({ FREE_PLAN_WEEKLY_USD_CAP: "0.0000001" });
    await setConfig(service, { freePlan: "on" });
    const { key } = await freeAccount(service, { id: 8040, login: "cap", email: "cap@example.com" });
    assert.equal((await chat(service, key)).status, 200);
    await service.settle();
    const refused = await chat(service, key);
    assert.equal(refused.status, 402);
    const error = ((await refused.json()) as any).error;
    assert.equal(error.code, "free_capacity_full");
    assert.match(error.message, /^Free capacity is full this week\. .*Starter is \$7\/mo/);
    assert.equal((await plans(service)).freePlan.capacityFull, true);
    // A new week opens it again.
    service.clock.now = NOW + WEEK;
    assert.equal((await chat(service, key)).status, 200);
  });
});

describe("the Free plan: the old free tier's accounts at freeEndsAt", () => {
  const ENDS = Date.UTC(2026, 11, 4);
  const legacy = { FREE_ENDS_AT: new Date(ENDS).toISOString() };

  async function legacyWorld(vars: Record<string, string> = {}) {
    const service = await world({ ...legacy, ...vars });
    const users = { full: { id: 9001, login: "fulllevel" }, starter: { id: 9002, login: "starterlevel", createdAt: "2026-06-01T00:00:00Z", publicRepos: 0, contributions: 10, social: 0 } as any, paying: { id: 9004, login: "paying" } };
    for (const user of Object.values(users)) await service.signIn(user);
    const blocked = (await service.signIn({ id: 9003, login: "blocked" })).access_token;
    await service.account(9004).applySubscription({ subscriptionId: "sub_9004", state: "active", periodEnd: ENDS + 60 * 86_400_000, eventAt: 1 });
    assert.equal(await service.account(9004).setPlanTier("starter"), true);
    assert.equal((await service.request("POST", "/admin/people/9003/block", { token: await admin(service) })).status, 200);
    // Past freeEndsAt: fresh access tokens (they expire).
    const at = async (now: number) => {
      service.clock.now = now;
      return { full: (await service.signIn(users.full)).access_token, starter: (await service.signIn(users.starter)).access_token, paying: (await service.signIn(users.paying)).access_token };
    };
    return { service, blocked, at };
  }

  it("with the switch on, become Free accounts instead of being cut off: any level, the week's cap, DeepSeek only, 80%/100% prompts", async () => {
    const { service, blocked, at } = await legacyWorld(SMALL);
    await setConfig(service, { freePlan: "on" });
    // Before freeEndsAt they keep the old free tier as it was.
    assert.equal((await service.account(9001).planState(service.clock.now, [MODEL])).freePlan, false);
    const { full, starter, paying } = await at(ENDS + 60_000);

    const kimi = await chat(service, full, KIMI);
    assert.equal(kimi.status, 200, await kimi.clone().text());
    assert.match(kimi.headers.get("x-dl-notice") ?? "", /isn't on the Free plan\. Now using DeepSeek V4\.1 Flash\./);
    const second = await chat(service, full);
    assert.equal(second.status, 200);
    assert.match(second.headers.get("x-dl-notice") ?? "", /Free plan: \d+% of this week used .* Upgrade at https:\/\/dl\.new/);
    const third = await chat(service, full);
    assert.equal(third.status, 402);
    const error = ((await third.json()) as any).error;
    assert.equal(error.code, "free_plan_limit");
    assert.equal(error.upgrade.line, STARTER);
    assert.equal((await service.account(9001).planState(service.clock.now, [MODEL])).freePlan, true);

    // A Starter-level account with no free tokens gets the Free plan too, not below_bar.
    assert.equal((await chat(service, starter)).status, 200);
    // Blocked stays blocked; paying and admins as before.
    const refused = await chat(service, blocked);
    assert.notEqual(refused.status, 200);
    assert.notEqual(((await refused.json()) as any).error?.code, "free_plan_limit");
    assert.equal(await service.account(9003).freePlan(), false);
    assert.equal((await chat(service, paying)).status, 200);
    assert.equal(await service.account(9004).freePlan(), false);
    const owner = await admin(service);
    for (let i = 0; i < 3; i++) assert.equal((await chat(service, owner)).status, 200, "admins have no Free cap");
    assert.equal(await service.account(ADMIN_ID).freePlan(), false);
  });

  it("with the switch off, are cut off at freeEndsAt as before", async () => {
    const { service, at } = await legacyWorld();
    const { full } = await at(ENDS + 60_000);
    const refused = await chat(service, full);
    assert.equal(refused.status, 402);
    assert.equal(((await refused.json()) as any).error.code, "plan_required");
    assert.equal(await service.account(9001).freePlan(), false);
  });
});
