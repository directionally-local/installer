import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, completion, createService, MODEL, usage, type Service } from "./harness.js";
import { readFreeConfig } from "../src/config.js";
import { parseSettingsUpdate } from "../src/runtime-config.js";
import { forHarness, gptLimitMessage, harnessLimitMessage, quotaMessage, trialEndedMessage } from "../src/messages.js";
import { basicLine, starterLine } from "../src/admission.js";
import { renderUserEmail, type UserEmailKind } from "../src/user-emails.js";
// app.js imports cloudflare:workers, which the harness maps once it has loaded.
const { offers } = await import("../src/app.js");

/**
 * The `proOffered` runtime setting (default on). Off: nobody new is offered dl Pro. `offers`
 * leaves Pro out (the top-up stays), free users' refusals and sign-in lines stop naming Pro, and a
 * new Pro checkout is refused with 403 pro_not_offered. Existing subscribers keep Pro, their Pro
 * wording and the billing portal.
 */

const BASE = { TOKEN_SIGNING_KEY: "x".repeat(32), OPENROUTER_API_KEY: "k", GITHUB_CLIENT_ID: "i", GITHUB_CLIENT_SECRET: "s" };
const SECRET = "whsec_test_0123456789abcdef";
const BILLING = { STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_PRICE_PRO: "price_pro123", STRIPE_PRICE_TOPUP: "price_topup123" };
const LUNA = "gpt-6-luna";
const TRIAL_EMAILS: UserEmailKind[] = ["welcome_trial", "access_granted_trial", "trial_80"];
const BAR = { minAccountAgeDays: 365, minPublicRepos: 3, minContributions: 100 };

const config = (vars: Record<string, string> = {}) => readFreeConfig({ ...BASE, ...vars });

async function errorOf(response: Response): Promise<Record<string, any>> {
  return ((await response.json()) as { error: Record<string, any> }).error;
}

async function me(service: Service, token: string): Promise<Record<string, any>> {
  return (await (await service.request("GET", "/v1/me", { token })).json()) as Record<string, any>;
}

async function setProOffered(service: Service, admin: string, value: boolean): Promise<void> {
  const response = await service.request("POST", "/admin/config", { token: admin, body: { proOffered: value } });
  assert.equal(response.status, 200, await response.clone().text());
}

async function goPro(service: Service, githubId: number): Promise<void> {
  const { signatureHeader } = await import("../src/stripe.js");
  const session = {
    id: `cs_pro_${githubId}`,
    object: "checkout.session",
    mode: "subscription",
    client_reference_id: String(githubId),
    customer: `cus_${githubId}`,
    subscription: `sub_${githubId}`,
    payment_status: "paid",
    amount_subtotal: 399,
    amount_total: 399,
    metadata: { github_id: String(githubId), product: "pro" },
  };
  const at = Math.floor(service.clock.now / 1000);
  const body = JSON.stringify({ id: `evt_pro_${githubId}`, object: "event", type: "checkout.session.completed", created: at, data: { object: session } });
  assert.equal((await service.request("POST", "/v1/billing/webhook", { body, headers: { "stripe-signature": await signatureHeader(SECRET, at, body) } })).status, 200);
}

async function world(vars: Record<string, string> = {}) {
  const service = await createService({ OPEN_ADMISSION: "true", OPENAI_API_KEY: "sk-openai-test", ...BILLING, ...vars });
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const alice = (await service.signIn({ id: 100, login: "alice" })).access_token;
  const paid = (await service.signIn({ id: 200, login: "subscriber" })).access_token;
  await goPro(service, 200);
  return { service, admin, alice, paid };
}

describe("the proOffered setting", () => {
  it("defaults to on, reads PRO_OFFERED, and takes only true or false at /admin/config", () => {
    assert.equal(config().proOffered, true);
    assert.equal(config({ PRO_OFFERED: "false" }).proOffered, false);
    assert.deepEqual(parseSettingsUpdate({ proOffered: false }), { changes: [{ key: "proOffered", value: false }] });
    assert.deepEqual(parseSettingsUpdate({ proOffered: null }), { changes: [{ key: "proOffered", value: undefined }] });
    assert.ok("error" in parseSettingsUpdate({ proOffered: "no" }));
  });

  it("leaves Pro out of the offers when off, and keeps the top-up either way", () => {
    const on = offers(config());
    assert.equal(on.pro?.price, "$3.99/month");
    const off = offers(config({ PRO_OFFERED: "false" }));
    assert.equal("pro" in off, false);
    assert.deepEqual(off.topup, on.topup);
  });
});

describe("free users' words with proOffered", () => {
  it("names dl Pro while it is offered (unchanged)", () => {
    assert.equal(trialEndedMessage(10_000_000, "$3.99"), "Your 10M free trial tokens are used up. Keep going with dl Pro for $3.99 a month, or add a top-up: /upgrade");
    assert.match(gptLimitMessage("free"), /or get dl Pro\.$/);
    assert.match(gptLimitMessage("free", true), /or get dl Pro\.$/);
    assert.match(harnessLimitMessage(0.5, undefined, "free", "claude-code", true), /Or get dl Pro: run dl and type \/upgrade\.$/);
    assert.match(starterLine(BAR, 2_000_000, 2, 8), /Want more\? Get dl Pro, type \/request/);
    assert.match(basicLine(50_000_000, 2, 8, true), /Want more\? Get dl Pro, type \/request/);
    for (const kind of TRIAL_EMAILS) assert.match(renderUserEmail(kind, { resets: "monday 10 nov", unsubscribeUrl: "u" }).body, /dl pro or a top up/);
  });

  it("never names Pro once it is off, and keeps the top-up where there was one", () => {
    const lines = [
      trialEndedMessage(10_000_000, null),
      gptLimitMessage("free", false),
      harnessLimitMessage(0.5, "2026-11-09T00:00:00.000Z", "free", "claude-code", false),
      harnessLimitMessage(0.5, undefined, "free", "opencode", false),
      starterLine(BAR, 2_000_000, 2, 8, false),
      basicLine(50_000_000, 2, 8, false),
      quotaMessage("tokens", "2026-11-09T00:00:00.000Z"),
    ];
    for (const line of [...lines, ...lines.map((line) => forHarness(line)), ...lines.map((line) => forHarness(line, "opencode"))]) {
      assert.doesNotMatch(line, /\bpro\b/i, line);
    }
    assert.equal(trialEndedMessage(10_000_000, null), "Your 10M free trial tokens are used up. Keep going with a top-up: /upgrade");
    assert.equal(forHarness(trialEndedMessage(10_000_000, null)), "Your 10M free trial tokens are used up. Keep going with a top-up: run dl and type /upgrade");
    assert.equal(gptLimitMessage("free", false), "You've used this week's GPT-6 allowance. DeepSeek V4.1 Flash still has free usage this week: switch with /model.");
    assert.equal(forHarness(gptLimitMessage("free", false), "opencode"), "You've used this week's GPT-6 allowance. DeepSeek V4.1 Flash still has free usage this week: pick it in /models.");
    assert.equal(
      harnessLimitMessage(0.5, "2026-11-09T00:00:00.000Z", "free", "claude-code", false),
      "Claude Code through dl gets half of your free allowance, and that part is used up. It resets at 2026-11-09T00:00:00.000Z. Your remaining free usage works in Autopilot: type dl.",
    );
    assert.equal(starterLine(BAR, 2_000_000, 2, 8, false), "Free: every model, up to $2 of GPT-6 and $8 of DeepSeek a week. It resets every Monday. Want more? Type /request in dl and tell us what you're building, or use your own API key with /provider.");
    for (const kind of TRIAL_EMAILS) {
      const body = renderUserEmail(kind, { resets: "monday 10 nov", unsubscribeUrl: "u", proOffered: false }).body;
      assert.doesNotMatch(body, /\bpro\b/i, kind);
      assert.match(body, /a top up/, kind);
    }
  });

  it("keeps Pro subscribers' wording the same either way", () => {
    assert.equal(gptLimitMessage("pro", false), gptLimitMessage("pro", true));
    assert.equal(harnessLimitMessage(0.5, undefined, "pro", "claude-code", false), harnessLimitMessage(0.5, undefined, "pro", "claude-code", true));
    assert.match(harnessLimitMessage(0.5, undefined, "pro", "claude-code", false), /your Pro allowance/);
    assert.match(quotaMessage("spend", "x", "pro"), /Pro/);
  });
});

describe("the service with proOffered", () => {
  it("offers Pro and sells it while on (the default)", async () => {
    const { service, admin, alice } = await world();
    assert.equal((await me(service, alice)).offers.pro.price, "$3.99/month");
    assert.equal((await service.request("POST", "/v1/billing/checkout", { token: alice, body: { product: "pro" } })).status, 200);
    const settings = (await (await service.request("GET", "/admin/config", { token: admin })).json()) as { effective: Record<string, unknown> };
    assert.equal(settings.effective.proOffered, true);
    const home = await (await service.request("GET", "/admin", { token: admin })).text();
    assert.match(home, /Pro Offered/);
    assert.doesNotMatch(home, /Pro is hidden from new people/);
  });

  it("off: no Pro in /v1/me, a 403 for a new Pro checkout, the top-up still sold", async () => {
    const { service, admin, alice } = await world();
    await setProOffered(service, admin, false);
    const body = await me(service, alice);
    assert.equal(body.plan, "free");
    assert.equal("pro" in body.offers, false);
    assert.equal(body.offers.topup.fromPrice, "$2");
    const refused = await service.request("POST", "/v1/billing/checkout", { token: alice, body: { product: "pro" } });
    assert.equal(refused.status, 403);
    const error = await errorOf(refused);
    assert.equal(error.code, "pro_not_offered");
    assert.match(error.message, /top-up/);
    const before = service.calls.stripe.length;
    assert.equal((await service.request("POST", "/v1/billing/checkout", { token: alice, body: { product: "topup" } })).status, 200);
    assert.equal(service.calls.stripe.length, before + 1);
    assert.equal(service.calls.stripe.at(-1)!.form.get("line_items[0][price]"), "price_topup123");
    const settings = (await (await service.request("GET", "/admin/config", { token: admin })).json()) as { effective: Record<string, unknown> };
    assert.equal(settings.effective.proOffered, false);
    assert.match(await (await service.request("GET", "/admin", { token: admin })).text(), /Pro is hidden from new people/);
  });

  it("off: an existing subscriber stays on Pro and still reaches the billing portal", async () => {
    const { service, admin, paid } = await world();
    await setProOffered(service, admin, false);
    const body = await me(service, paid);
    assert.equal(body.plan, "pro");
    assert.equal(body.allowance.usdPerWeek, 6, "Pro's budget, unchanged");
    const portal = await service.request("POST", "/v1/billing/portal", { token: paid });
    assert.equal(portal.status, 200, await portal.clone().text());
    assert.match(((await portal.json()) as { url: string }).url, /^https:\/\//);
    assert.equal(await errorOf(await service.request("POST", "/v1/billing/checkout", { token: paid, body: { product: "pro" } })).then((e) => e.code), "already_pro");
  });

  it("off: a free user's gpt_limit names no Pro and carries no Pro offer; a subscriber's still says Pro", async () => {
    const { service, admin, alice, paid } = await world();
    await setProOffered(service, admin, false);
    await service.request("POST", "/admin/people/100/grant", { token: admin, body: { spentUsdThisWeek: 2 } });
    const chat = (token: string, model: string) => service.request("POST", "/v1/chat/completions", { token, body: { model, messages: [{ role: "user", content: "hello" }] } });
    const error = await errorOf(await chat(alice, LUNA));
    assert.equal(error.code, "gpt_limit");
    assert.doesNotMatch(error.message, /\bpro\b/i);
    assert.equal("pro" in error.offers, false);
    assert.ok(error.offers.topup);
    await service.request("POST", "/admin/people/200/grant", { token: admin, body: { spentUsdThisWeek: 6 } });
    const proError = await errorOf(await chat(paid, LUNA));
    assert.equal(proError.code, "gpt_limit");
    assert.match(proError.message, /this week's Pro GPT-6 allowance/);
  });

  it("off: a used-up trial points at the top-up only", async () => {
    const { service, admin } = await world({ TRIAL_CUTOFF: "2026-11-01T00:00:00Z", TRIAL_TOKENS: "1000000" });
    await setProOffered(service, admin, false);
    const bob = (await service.signIn({ id: 300, login: "bob" })).access_token;
    service.setOpenRouter(() => completion(usage(2_000_000, 0, 0, 0.001)));
    const chat = () => service.request("POST", "/v1/chat/completions", { token: bob, body: { model: MODEL, messages: [{ role: "user", content: "hello" }] } });
    assert.equal((await chat()).status, 200);
    const refused = await chat();
    assert.equal(refused.status, 402);
    const error = await errorOf(refused);
    assert.equal(error.code, "trial_ended");
    assert.equal(error.message, "Your 1M free trial tokens are used up. Keep going with a top-up: /upgrade");
    assert.equal("pro" in error.offers, false);
  });

  it("can be switched back on, and Pro is offered again", async () => {
    const { service, admin, alice } = await world();
    await setProOffered(service, admin, false);
    assert.equal("pro" in (await me(service, alice)).offers, false);
    await setProOffered(service, admin, true);
    assert.equal((await me(service, alice)).offers.pro.price, "$3.99/month");
    assert.equal((await service.request("POST", "/v1/billing/checkout", { token: alice, body: { product: "pro" } })).status, 200);
  });
});
