import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, completion, createService, MODEL, NOW, usage, type Service } from "./harness.js";
import { readFreeConfig } from "../src/config.js";
import { parseSettingsUpdate } from "../src/runtime-config.js";
import { renderUserEmail } from "../src/user-emails.js";
import { trialMostlyUsed } from "../src/user-email-send.js";
import type { AdminHomeData } from "../src/admin-home-data.js";
import type { Limits } from "../src/account-object.js";

// After the harness: app.js loads cloudflare:workers, which the harness resolves.
const { onTrial } = await import("../src/app.js");

/**
 * The new-user trial: accounts admitted at or after `trialCutoff` get a one-time trial
 * (`trialTokens`, counted as prompt with cached plus completion, every free model together)
 * instead of the weekly free allowance forever. Everyone admitted before is grandfathered, admins
 * are never on trial, and with no cutoff nothing changes. Pro and top-ups keep working past it.
 */

const HOUR = 3_600_000;
const MINUTE = 60_000;
/** Minutes apart, so access tokens signed in before it stay valid. */
const CUTOFF = NOW + MINUTE;
const TRIAL_MESSAGE = "Your 10M free trial tokens are used up. Keep going with dl Pro for $3.99 a month, or add a top-up: /upgrade";

const chat = (service: Service, token: string, model = MODEL) =>
  service.request("POST", "/v1/chat/completions", { token, body: { model, messages: [{ role: "user", content: "hello" }] } });

async function me(service: Service, token: string): Promise<Record<string, any>> {
  return (await (await service.request("GET", "/v1/me", { token })).json()) as Record<string, any>;
}

async function errorOf(response: Response): Promise<Record<string, any>> {
  return ((await response.json()) as { error: Record<string, any> }).error;
}

/**
 * The owner and alice sign in before the cutoff, the owner sets it, and bob signs in after it.
 * Each request is answered with `perRequest` prompt tokens (half of them cached) and no output.
 */
async function world(options: { cutoff?: boolean; perRequest?: number; vars?: Record<string, string> } = {}) {
  const service = await createService({ OPEN_ADMISSION: "true", OPENAI_API_KEY: "sk-openai-test", ...options.vars });
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const alice = (await service.signIn({ id: 100, login: "alice" })).access_token;
  if (options.cutoff !== false) {
    const set = await service.request("POST", "/admin/config", { token: admin, body: { trialCutoff: new Date(CUTOFF).toISOString() } });
    assert.equal(set.status, 200, await set.clone().text());
  }
  service.clock.now = CUTOFF + MINUTE;
  const bob = (await service.signIn({ id: 200, login: "bob" })).access_token;
  const tokens = options.perRequest ?? 6_000_000;
  service.setOpenRouter(() => completion(usage(tokens, 0, tokens / 2, 0.001)));
  return { service, admin, alice, bob };
}

describe("the new-user trial", () => {
  it("is off by default: nobody is on trial and /me has trial null", async () => {
    const { service, alice, bob } = await world({ cutoff: false });
    for (const token of [alice, bob]) {
      for (let i = 0; i < 3; i++) assert.equal((await chat(service, token)).status, 200);
      const body = await me(service, token);
      assert.equal(body.trial, null);
    }
    assert.equal(readFreeConfig({ OPENROUTER_API_KEY: "k", GITHUB_CLIENT_ID: "c", GITHUB_CLIENT_SECRET: "s", TOKEN_SIGNING_KEY: "x".repeat(32) }).trialCutoff, undefined);
  });

  it("gives a new account 10M tokens once, then refuses with 402 trial_ended and the paywall", async () => {
    const { service, bob } = await world();
    const fresh = await me(service, bob);
    assert.deepEqual(fresh.trial, { tokens: 10_000_000, used: 0, remaining: 10_000_000, ended: false });
    assert.equal((await chat(service, bob)).status, 200);
    // Prompt tokens with cached ones counted in full, plus completion: the display count.
    assert.deepEqual((await me(service, bob)).trial, { tokens: 10_000_000, used: 6_000_000, remaining: 4_000_000, ended: false });
    assert.equal((await chat(service, bob)).status, 200);
    const after = await me(service, bob);
    assert.deepEqual(after.trial, { tokens: 10_000_000, used: 10_000_000, remaining: 0, ended: true });
    assert.equal(after.allowance.remaining, 0, "the trial caps what /me says is left");

    for (const model of [MODEL, "gpt-6-luna"]) {
      const refused = await chat(service, bob, model);
      assert.equal(refused.status, 402);
      const error = await errorOf(refused);
      assert.equal(error.code, "trial_ended");
      assert.equal(error.message, TRIAL_MESSAGE);
      assert.deepEqual(error.trial, { tokens: 10_000_000, used: 10_000_000, remaining: 0, ended: true });
      assert.equal(error.offers.pro.price, "$3.99/month");
      assert.ok(error.offers.topup);
    }
    // A new week doesn't bring it back: the trial is for the account's lifetime.
    service.clock.now += 7 * 24 * HOUR;
    const again = (await service.signIn({ id: 200, login: "bob" })).access_token;
    assert.equal((await errorOf(await chat(service, again))).code, "trial_ended");
  });

  it("leaves accounts admitted before the cutoff on the weekly allowance", async () => {
    const { service, alice } = await world();
    for (let i = 0; i < 3; i++) assert.equal((await chat(service, alice)).status, 200);
    const body = await me(service, alice);
    assert.equal(body.trial, null);
    assert.equal(body.budgets.deepseek.usdPerWeek, 8);
    assert.equal(body.budgets.gpt6.usdPerWeek, 2);
    assert.equal(body.budgets.deepseek.tokensThisWeek, 18_000_000);
  });

  it("never puts admins on trial, even when they sign in after the cutoff", async () => {
    const { service, admin } = await world();
    assert.equal((await me(service, admin)).trial, null);
    for (let i = 0; i < 3; i++) assert.equal((await chat(service, admin)).status, 200);
    assert.equal(onTrial({ trialCutoff: CUTOFF, adminGithubIds: new Set([ADMIN_ID]) }, ADMIN_ID, CUTOFF + 1), false);
    assert.equal(onTrial({ trialCutoff: CUTOFF, adminGithubIds: new Set([ADMIN_ID]) }, 5, CUTOFF), true, "at the cutoff is on trial");
    assert.equal(onTrial({ trialCutoff: CUTOFF, adminGithubIds: new Set() }, 5, CUTOFF - 1), false);
    assert.equal(onTrial({ trialCutoff: undefined, adminGithubIds: new Set() }, 5, CUTOFF), false);
  });

  it("lets Pro continue past the trial, without Pro usage counting against it", async () => {
    const { service, bob } = await world();
    await chat(service, bob);
    await chat(service, bob);
    assert.equal((await chat(service, bob)).status, 402);
    await service.account(200).applySubscription({ subscriptionId: "sub_1", state: "active", periodEnd: service.clock.now + 30 * 24 * HOUR, eventAt: 1 });
    assert.equal((await chat(service, bob)).status, 200);
    assert.equal((await chat(service, bob)).status, 200);
    const body = await me(service, bob);
    assert.equal(body.plan, "pro");
    assert.equal(body.trial.used, 10_000_000, "Pro usage isn't trial usage");
    assert.equal(body.trial.ended, true, "still shown, so the client can tell a trial account");
  });

  it("lets a top-up continue past the trial", async () => {
    const { service, bob } = await world();
    await chat(service, bob);
    await chat(service, bob);
    assert.equal((await chat(service, bob)).status, 402);
    await service.account(200).grantCredit({ id: "cs_1", usd: 2.5, createdAt: service.clock.now, expiresAt: service.clock.now + 90 * 24 * HOUR });
    assert.equal((await chat(service, bob)).status, 200);
    const body = await me(service, bob);
    assert.ok(body.topupUsdLeft < 2.5, "the top-up paid for it");
    assert.equal(body.trial.used, 10_000_000);
  });

  it("holds the trial to what is left while requests are in flight, never past it", async () => {
    const { service, bob } = await world({ perRequest: 1000, vars: { TRIAL_TOKENS: "100000" } });
    const account = service.account(200);
    const limits: Limits = { weeklyTokens: 50_000_000, weeklyUsd: 2, deepseekWeeklyUsd: 8, trialTokens: 100_000 };
    const first = await account.reserve({ pool: "deepseek", promptEstimate: 100, requestedMaxTokens: undefined, limits, now: service.clock.now, model: MODEL });
    assert.equal(first.ok, true);
    assert.equal(first.amount, 100 + 65_536); // DeepSeek reserves up to its 65,536-token output cap
    const second = await account.reserve({ pool: "deepseek", promptEstimate: 100, requestedMaxTokens: undefined, limits, now: service.clock.now, model: MODEL });
    assert.equal(second.ok, true);
    assert.ok(second.amount <= 100_000 - first.amount, "the second gets only what the first left");
    assert.equal(second.allowance.trial.reserved, first.amount + second.amount);
    void bob;
  });

  it("still gives a batch-flagged new account nothing", async () => {
    const { service, bob } = await world({ vars: { STARTER_WEEKLY_TOKENS: "0" } });
    const db = service.namespaces.DIRECTORY!.instances.get("directory")!.state.db;
    db.prepare("UPDATE people SET level = 'starter', batch_flag = 1 WHERE github_id = 200").run();
    const refused = await chat(service, bob);
    assert.equal(refused.status, 403);
    assert.equal((await errorOf(refused)).code, "below_bar");
    // And at the account: a batch-flagged Starter's limits with a trial still reserve nothing.
    const limits: Limits = { weeklyTokens: 50_000_000, weeklyUsd: 0, deepseekWeeklyUsd: 0, level: "starter", levelTokens: 0, trialTokens: 10_000_000 };
    const held = await service.account(200).reserve({ pool: "deepseek", promptEstimate: 100, requestedMaxTokens: undefined, limits, now: service.clock.now, model: MODEL });
    assert.equal(held.ok, false);
    assert.equal(held.code, "quota_exceeded", "the level stops it, not the trial");
  });

  it("takes the cutoff at runtime as an ISO time or Unix ms, and \"none\" turns it off", async () => {
    assert.deepEqual(parseSettingsUpdate({ trialCutoff: "2026-11-20T00:00:00Z" }), { changes: [{ key: "trialCutoff", value: Date.parse("2026-11-20T00:00:00Z") }] });
    assert.deepEqual(parseSettingsUpdate({ trialCutoff: 1_790_000_000_000 }), { changes: [{ key: "trialCutoff", value: 1_790_000_000_000 }] });
    assert.deepEqual(parseSettingsUpdate({ trialCutoff: "none" }), { changes: [{ key: "trialCutoff", value: null }] });
    assert.deepEqual(parseSettingsUpdate({ trialCutoff: null }), { changes: [{ key: "trialCutoff", value: undefined }] });
    for (const bad of ["tomorrow", "2026-11-20 00:00", -5, 1.5, true]) assert.ok("error" in parseSettingsUpdate({ trialCutoff: bad }), String(bad));
    assert.deepEqual(parseSettingsUpdate({ trialTokens: 20_000_000 }), { changes: [{ key: "trialTokens", value: 20_000_000 }] });
    const config = (vars: Record<string, string>) => readFreeConfig({ OPENROUTER_API_KEY: "k", GITHUB_CLIENT_ID: "c", GITHUB_CLIENT_SECRET: "s", TOKEN_SIGNING_KEY: "x".repeat(32), ...vars });
    assert.equal(config({ TRIAL_CUTOFF: "2026-11-20T00:00:00Z" }).trialCutoff, Date.parse("2026-11-20T00:00:00Z"));
    assert.equal(config({ TRIAL_CUTOFF: "1790000000000" }).trialCutoff, 1_790_000_000_000);
    assert.equal(config({}).trialTokens, 10_000_000);
    assert.throws(() => config({ TRIAL_CUTOFF: "next week" }));

    const { service, admin, bob } = await world();
    const view = (await (await service.request("GET", "/admin/config", { token: admin })).json()) as Record<string, any>;
    assert.equal(view.effective.trialCutoff, CUTOFF);
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { trialCutoff: "soon" } })).status, 400);
    // Turned off: bob is back on the weekly allowance, and the count he built up is kept.
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { trialCutoff: "none" } })).status, 200);
    assert.equal((await me(service, bob)).trial, null);
  });

  it("shows trial or grandfathered in the admin people list and person view", async () => {
    const { service, admin } = await world();
    const people = ((await (await service.request("GET", "/admin/people", { token: admin })).json()) as { people: Array<Record<string, any>> }).people;
    const by = new Map(people.map((person) => [person.login, person]));
    assert.equal(by.get("alice")!.access, "grandfathered");
    assert.equal(by.get("alice")!.trial, null);
    assert.equal(by.get("owner")!.access, "grandfathered");
    assert.equal(by.get("bob")!.access, "trial");
    assert.deepEqual(by.get("bob")!.trial, { tokens: 10_000_000, used: 0, remaining: 10_000_000, ended: false });
    const detail = (await (await service.request("GET", "/admin/people/200", { token: admin })).json()) as Record<string, any>;
    assert.equal(detail.access, "trial");
  });

  it("counts trial users and who of them paid on the admin home", async () => {
    const { service, admin } = await world();
    service.clock.now += MINUTE;
    await service.signIn({ id: 201, login: "carol" });
    await service.signIn({ id: 202, login: "dave" });
    const directory = service.directory();
    await directory.recordPayment({ id: "cs_a", githubId: 200, kind: "topup", amountCents: 200, at: service.clock.now });
    await directory.mirrorSubscription({ githubId: 201, state: "active", periodEnd: service.clock.now + 30 * 24 * HOUR, eventAt: 1 });
    await directory.recordPayment({ id: "in_b", githubId: 201, kind: "pro", amountCents: 399, at: service.clock.now });
    // alice is grandfathered: her payment isn't a trial conversion.
    await directory.recordPayment({ id: "cs_c", githubId: 100, kind: "topup", amountCents: 500, at: service.clock.now });
    const data = (await directory.adminHome({ now: service.clock.now, adminIds: [ADMIN_ID], trialCutoff: CUTOFF })) as AdminHomeData;
    assert.deepEqual(data.trial, { cutoff: CUTOFF, users: 3, converted: 2, pro: 1, topup: 1 });
    assert.deepEqual(
      data.users.filter((user) => user.trial).map((user) => user.login).sort(),
      ["bob", "carol", "dave"],
    );
    const off = (await directory.adminHome({ now: service.clock.now, adminIds: [ADMIN_ID] })) as AdminHomeData;
    assert.deepEqual(off.trial, { cutoff: null, users: 0, converted: 0, pro: 0, topup: 0 });

    const page = await (await service.request("GET", "/admin", { token: admin })).text();
    assert.match(page, /New-User Trial/);
    assert.match(page, /<span class="badge trial">Trial<\/span>/);
  });

  it("words the welcome and limit emails for the trial: one-time, no weekly reset", () => {
    const values = { resets: "monday 10 nov", unsubscribeUrl: "https://example.com/stop" };
    for (const kind of ["welcome_trial", "access_granted_trial", "trial_80"] as const) {
      const { body } = renderUserEmail(kind, values);
      assert.doesNotMatch(body, /every week|each week|resets every|reset on/, kind);
      assert.match(body, /\/upgrade/, kind);
    }
    assert.equal(trialMostlyUsed({ plan: "free", trial: { tokens: 10_000_000, used: 8_000_000 } }), true);
    assert.equal(trialMostlyUsed({ plan: "free", trial: { tokens: 10_000_000, used: 7_999_999 } }), false);
    assert.equal(trialMostlyUsed({ plan: "pro", trial: { tokens: 10_000_000, used: 9_000_000 } }), false);
    assert.equal(trialMostlyUsed({ plan: "free", trial: null }), false);
  });
});
