import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, createService, errorCode, type Service } from "./harness.js";
import { buy, DL, emailSignIn, FakeStripe, githubRoundTrip, lastCode, PAGE_STATE, PAID_VARS, PRICES, webhook, type SessionResponse } from "./paid-fixtures.js";
import { accountIdOf, formatApiKey, isPaidAccountNumber, PAID_ACCOUNT_BASE, parseAccountId, parseApiKey } from "../src/accounts.js";
import { isDisposableDomain } from "../src/email-guard.js";
import { countedTokens, planDescription, realToCounted } from "../src/plan-prices.js";
import { PLAN_DEFAULTS, planLimits } from "../src/plans.js";

/**
 * dl.new's paid launch, accounts (docs/web-api-paid.md): plans and Checkout before any account,
 * then the account step by email code or GitHub (verified email), which claims the payment.
 */

async function world(vars: Record<string, string> = {}): Promise<{ service: Service; stripe: FakeStripe }> {
  const service = await createService({ ...PAID_VARS, ...vars }, { userEmail: true });
  return { service, stripe: new FakeStripe(service) };
}

describe("accounts: ids and keys", () => {
  it("keeps GitHub ids as account numbers and gives dl.new accounts numbers from 2^50", () => {
    assert.equal(isPaidAccountNumber(123), false);
    assert.equal(isPaidAccountNumber(PAID_ACCOUNT_BASE + 5), true);
    assert.equal(parseAccountId(accountIdOf(PAID_ACCOUNT_BASE + 5)), PAID_ACCOUNT_BASE + 5);
    assert.equal(parseAccountId(accountIdOf(4242)), 4242);
    assert.equal(parseAccountId("acct_"), undefined);
    const key = formatApiKey(PAID_ACCOUNT_BASE + 7, "abcdef012345", "s".repeat(43));
    assert.match(key, /^dl_sk_[0-9a-z]+_abcdef012345_s{43}$/);
    assert.deepEqual(parseApiKey(key), { account: PAID_ACCOUNT_BASE + 7, id: "abcdef012345", secret: "s".repeat(43) });
    assert.equal(parseApiKey(`dlk_1_abcdef012345_${"s".repeat(43)}`), undefined);
  });

  it("blocks disposable domains and their subdomains", () => {
    assert.equal(isDisposableDomain("mailinator.com"), true);
    assert.equal(isDisposableDomain("x.mailinator.com"), true);
    assert.equal(isDisposableDomain("gmail.com"), false);
  });

  it("converts real tokens to counted at the cached weight (0.0641 at 0.02)", () => {
    assert.equal(Math.round(realToCounted(0.02) * 10_000) / 10_000, 0.0641);
    assert.equal(countedTokens(62_000_000, 0.02), 3_974_200);
    assert.equal(planDescription(planLimits("plus", { ...PLAN_DEFAULTS, cachedTokenWeight: 0.02 })), "DeepSeek V4.1 Flash ~150M/week + Kimi K3.1 ~1.5M/week (95.5% caching applied). Weekly limits reset Mon 00:00 UTC.");
  });
});

describe("plans and Checkout", () => {
  it("lists the plans, available once every price is set", async () => {
    const { service } = await world();
    const body = (await (await service.request("GET", "/web/plans", { headers: DL })).json()) as any;
    assert.equal(body.available, true);
    assert.deepEqual(body.plans.map((plan: any) => [plan.id, plan.priceUsd]), [["starter", 7], ["plus", 20], ["max", 60]]);
    assert.equal(body.plans[0].models[0].tokensPerWeek, 62_000_000);
    assert.equal(body.caching.label, "(95.5% caching applied)");
    const partial = await createService({ ...PAID_VARS, STRIPE_PRICE_MAX: "" });
    assert.equal(((await (await partial.request("GET", "/web/plans")).json()) as any).available, false);
  });

  it("starts a subscription Checkout with no account: the plan's price, no promotion codes, back to dl.new", async () => {
    const { service, stripe } = await world();
    const response = await service.request("POST", "/web/checkout/plan", { body: { plan: "plus" }, headers: DL });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://dl.new");
    const { url, sessionId } = (await response.json()) as { url: string; sessionId: string };
    assert.match(url, /^https:\/\/checkout\.stripe\.com\//);
    const form = stripe.sessions.get(sessionId)!.form;
    assert.equal(form.get("mode"), "subscription");
    assert.equal(form.get("line_items[0][price]"), PRICES.plus);
    assert.equal(form.get("allow_promotion_codes"), "false");
    assert.equal(form.get("success_url"), "https://dl.new/account?session_id={CHECKOUT_SESSION_ID}");
    assert.equal(form.get("cancel_url"), "https://dl.new/?plan=plus");
    assert.equal(form.get("metadata[product]"), "plan");
    assert.equal(form.get("subscription_data[metadata][plan]"), "plus");
    assert.equal(form.get("client_reference_id"), null);
    // The EU/UK withdrawal waiver, as Stripe's required terms consent (no refund promise).
    assert.equal(form.get("consent_collection[terms_of_service]"), "required");
    assert.equal(
      form.get("custom_text[terms_of_service_acceptance][message]"),
      "I want my dl.new plan to start right away and understand I lose my 14-day right to withdraw once it starts. [Terms](https://dl.new/terms).",
    );
    assert.equal(await errorCode(await service.request("POST", "/web/checkout/plan", { body: { plan: "pro" } })), "invalid_plan");
    const off = await createService({ ...PAID_VARS, STRIPE_PRICE_PLUS: "" });
    assert.equal(await errorCode(await off.request("POST", "/web/checkout/plan", { body: { plan: "plus" } })), "billing_unavailable");
  });

  it("tells the account page whether a Checkout is paid, unpaid or claimed", async () => {
    const { service, stripe } = await world();
    const response = await service.request("POST", "/web/checkout/plan", { body: { plan: "starter" }, headers: DL });
    const { sessionId } = (await response.json()) as { sessionId: string };
    const status = async () => (await (await service.request("GET", `/web/checkout/${sessionId}`, { headers: DL })).json()) as any;
    assert.equal((await status()).status, "unpaid");
    stripe.pay(sessionId, "ana@example.com");
    const paid = await status();
    assert.equal(paid.status, "paid");
    assert.equal(paid.plan, "starter");
    assert.equal(paid.emailHint, "a•••@example.com");
    await emailSignIn(service, "ana@example.com", sessionId);
    assert.equal((await status()).status, "claimed");
    assert.equal((await service.request("GET", "/web/checkout/cs_test_doesnotexist000", { headers: DL })).status, 404);
  });
});

describe("the terms consent at Checkout", () => {
  it("records when the terms were accepted, from the webhook and from the claim", async () => {
    const { service, stripe } = await world();
    const session = await buy(service, stripe, "plus", "late@example.com");
    const paidAt = service.clock.now;
    assert.equal((await webhook(service, "checkout.session.completed", stripe.sessionObject(session, false))).body.outcome, "plan_unclaimed");
    const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const listed = (await (await service.request("GET", "/admin/paid/checkouts", { token: admin })).json()) as any;
    assert.equal(listed.checkouts[0].termsAcceptedAt, new Date(Math.floor(paidAt / 1000) * 1000).toISOString());
    // Claimed straight from the page, before any webhook: the claim's read of the session records it.
    const direct = await buy(service, stripe, "starter", "ana@example.com");
    await emailSignIn(service, "ana@example.com", direct.id);
    const all = (await (await service.request("GET", "/admin/paid/checkouts?status=all", { token: admin })).json()) as any;
    assert.ok(all.checkouts.find((row: any) => row.sessionId === direct.id).termsAcceptedAt);
  });

  it("leaves the consent off with checkoutTermsConsent false, and records no consent", async () => {
    const { service, stripe } = await world({ CHECKOUT_TERMS_CONSENT: "false" });
    const session = await buy(service, stripe, "plus", "late@example.com");
    assert.equal(session.form.get("consent_collection[terms_of_service]"), null);
    assert.equal(session.form.get("custom_text[terms_of_service_acceptance][message]"), null);
    await webhook(service, "checkout.session.completed", stripe.sessionObject(session, false));
    const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    assert.equal(((await (await service.request("GET", "/admin/paid/checkouts", { token: admin })).json()) as any).checkouts[0].termsAcceptedAt, null);
  });

  it("never fails Checkout when Stripe refuses the consent: turns checkoutTermsConsent off, logs it and tells the owner", async () => {
    const service = await createService({ ...PAID_VARS, ALERT_EMAIL_TO: "owner@example.com" }, { userEmail: true, email: true });
    const stripe = new FakeStripe(service);
    stripe.refuseTermsConsent = true;
    const warned: unknown[][] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warned.push(args);
    let response: Response;
    try {
      response = await service.request("POST", "/web/checkout/plan", { body: { plan: "plus" }, headers: DL });
    } finally {
      console.warn = warn;
    }
    assert.equal(response.status, 200, await response.clone().text());
    const { sessionId } = (await response.json()) as { sessionId: string };
    assert.equal(stripe.sessions.get(sessionId)!.form.get("consent_collection[terms_of_service]"), null, "retried without the consent");
    assert.match(String(warned[0]?.[0]), /terms consent/);
    assert.ok(service.calls.emails.some((message) => message.raw.includes("Checkout terms consent turned off")));
    const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const config = (await (await service.request("GET", "/admin/config", { token: admin })).json()) as any;
    assert.equal(config.effective.checkoutTermsConsent, false);
    // The next Checkout goes straight through without asking Stripe for the consent again.
    const before = service.calls.stripe.filter((call) => call.path === "/v1/checkout/sessions").length;
    assert.equal((await service.request("POST", "/web/checkout/plan", { body: { plan: "starter" }, headers: DL })).status, 200);
    assert.equal(service.calls.stripe.filter((call) => call.path === "/v1/checkout/sessions").length, before + 1);
    // Back on once the owner has set the terms URL.
    stripe.refuseTermsConsent = false;
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { checkoutTermsConsent: true } })).status, 200);
    const again = (await (await service.request("POST", "/web/checkout/plan", { body: { plan: "max" }, headers: DL })).json()) as { sessionId: string };
    assert.equal(stripe.sessions.get(again.sessionId)!.form.get("consent_collection[terms_of_service]"), "required");
  });
});

describe("the account step: email", () => {
  it("creates the account from a paid Checkout with a 6-digit code, claims it and sets Stripe's email", async () => {
    const { service, stripe } = await world();
    const session = await buy(service, stripe, "starter", "stripe-typed@example.com");
    const start = await service.request("POST", "/web/auth/email/start", { body: { email: "ana@example.com", sessionId: session.id }, headers: DL });
    assert.equal(start.status, 200);
    assert.deepEqual(await start.json(), { sent: true, resendAfter: 30, expiresIn: 600 });
    const message = service.calls.userEmail.at(-1)!;
    assert.equal(message.to, "ana@example.com");
    assert.equal(message.headers, undefined, "a sign-in code has no unsubscribe header");
    const code = lastCode(service, "ana@example.com");
    const wrong = await service.request("POST", "/web/auth/email/verify", { body: { email: "ana@example.com", code: code === "000000" ? "111111" : "000000", sessionId: session.id } });
    assert.equal(wrong.status, 400);
    assert.equal(((await wrong.json()) as any).error.attemptsLeft, 4);
    const verify = await service.request("POST", "/web/auth/email/verify", { body: { email: "ana@example.com", code, sessionId: session.id }, headers: DL });
    assert.equal(verify.status, 200, await verify.clone().text());
    const body = (await verify.json()) as SessionResponse;
    assert.equal(body.created, true);
    assert.deepEqual(body.claimed, { plan: "starter", sessionId: session.id });
    assert.equal(body.expiresIn, 7 * 86_400);
    const accountNumber = parseAccountId(body.account.accountId)!;
    assert.ok(isPaidAccountNumber(accountNumber));
    assert.equal(body.account.email, "ana@example.com");
    assert.deepEqual(body.account.identities, [{ kind: "email", email: "ana@example.com" }]);
    assert.equal(body.account.plan.id, "starter");
    assert.equal(body.account.plan.status, "active");
    // No refund promise on the account page (the owner refunds by hand).
    assert.equal(body.account.plan.refundableUntil, undefined);
    assert.equal(body.account.plan.refundPolicy, undefined);
    assert.deepEqual(body.account.upgrade.map((option: any) => option.plan), ["plus", "max"]);
    // The account object is the account's own, named after its number.
    assert.equal(await (service.namespaces.ACCOUNT as any).getByName(`acct:${accountNumber}`).paidPlan(service.clock.now), "starter");
    assert.equal(stripe.customers.get(session.customer!)!.email, "ana@example.com");
    assert.equal(stripe.customers.get(session.customer!)!["metadata[account_id]"], body.account.accountId);
    assert.equal(stripe.subscriptions.get(session.subscription!)!.metadata.account_id, body.account.accountId);
    // The code works once.
    const again = await service.request("POST", "/web/auth/email/verify", { body: { email: "ana@example.com", code, sessionId: session.id } });
    assert.equal(await errorCode(again), "code_expired");
    // GET /web/account with the token.
    const me = await service.request("GET", "/web/account", { token: body.token, headers: DL });
    assert.equal(((await me.json()) as any).accountId, body.account.accountId);
  });

  it("signs an existing account in without a Checkout, with the plain code email", async () => {
    const { service, stripe } = await world();
    const session = await buy(service, stripe);
    const first = await emailSignIn(service, "ben@example.com", session.id);
    service.clock.now += 60_000;
    const second = await emailSignIn(service, "Ben@Example.com");
    assert.equal(second.created, false);
    assert.equal(second.claimed, null);
    assert.equal(second.account.accountId, first.account.accountId);
    const sent = service.calls.userEmail.at(-1)!;
    assert.equal(sent.subject, "Your dl.new code");
    assert.doesNotMatch(String(sent.text), /pick a plan/i);
  });

  it("sends an address with no account its code in a welcome, and holds the sign-in like GitHub (pending) until the payment", async () => {
    const { service, stripe } = await world();
    const known = await service.request("POST", "/web/auth/email/start", { body: { email: "nobody@example.com" }, headers: DL });
    assert.equal(known.status, 200, await known.clone().text());
    assert.deepEqual(await known.json(), { sent: true, resendAfter: 30, expiresIn: 600 });
    const sent = service.calls.userEmail.at(-1)!;
    assert.equal(sent.to, "nobody@example.com");
    assert.equal(sent.subject, "Your dl.new sign-in code");
    const code = lastCode(service, "nobody@example.com");
    assert.equal(
      sent.text,
      `Welcome to dl.new. Your sign-in code:\n\n    ${code}\n\nIt works for 10 minutes. If you didn't ask for it, ignore this email.\n\nTo finish setting up, pick a plan: https://dl.new\nStarter is $7/mo, and your first 20M tokens (95.5% caching applied) are free with a card.\n\ndl.new`,
    );
    assert.doesNotMatch(String(sent.text), /refund|cancel anytime/i);
    // The code proves the inbox: 403 no_account with the pending token (identity: the verified address).
    const verify = await service.request("POST", "/web/auth/email/verify", { body: { email: "Nobody@Example.com", code }, headers: DL });
    assert.equal(verify.status, 403);
    const error = ((await verify.json()) as any).error;
    assert.equal(error.code, "no_account");
    assert.equal(error.pending.email, "Nobody@Example.com");
    assert.equal(error.pending.expiresIn, 3600);
    // After Checkout the account is made with the email identity and the payment claimed.
    const paid = await buy(service, stripe);
    const done = await service.request("POST", "/web/auth/pending/session", { body: { token: error.pending.token, sessionId: paid.id }, headers: DL });
    assert.equal(done.status, 200, await done.clone().text());
    const body = (await done.json()) as SessionResponse;
    assert.equal(body.created, true);
    assert.deepEqual(body.claimed, { plan: "starter", sessionId: paid.id });
    assert.deepEqual(body.account.identities, [{ kind: "email", email: "Nobody@Example.com" }]);
    // The next email sign-in finds the account and gets the plain code.
    service.clock.now += 60_000;
    const again = await emailSignIn(service, "nobody@example.com");
    assert.equal(again.account.accountId, body.account.accountId);
    assert.equal(service.calls.userEmail.at(-1)!.subject, "Your dl.new code");
  });

  it("leaves the card trial out of the welcome code email when card trials are off", async () => {
    const { service } = await world({ CARD_TRIAL: "false" });
    assert.equal((await service.request("POST", "/web/auth/email/start", { body: { email: "notrial@example.com" }, headers: DL })).status, 200);
    const text = String(service.calls.userEmail.at(-1)!.text);
    assert.match(text, /\nStarter is \$7\/mo\.\n/);
    assert.doesNotMatch(text, /free with a card/);
  });

  it("limits sign-in codes the same way for addresses with and without an account", async () => {
    const { service, stripe } = await world();
    await emailSignIn(service, "has@example.com", (await buy(service, stripe)).id);
    service.clock.now += 3_600_000;
    for (const email of ["has@example.com", "hasnt@example.com"]) {
      for (let i = 0; i < 3; i++) {
        const ok = await service.request("POST", "/web/auth/email/start", { body: { email }, headers: DL, ip: `198.51.100.${i + 1}` });
        assert.equal(ok.status, 200, `${email} ${i}: ${await ok.clone().text()}`);
        service.clock.now += 31_000;
      }
      const fourth = await service.request("POST", "/web/auth/email/start", { body: { email }, headers: DL, ip: "198.51.100.9" });
      assert.equal(fourth.status, 429, email);
      assert.equal(await errorCode(fourth), "rate_limited");
    }
    // Per network: 10 sign-in codes an hour, whichever addresses.
    service.clock.now += 3_600_000;
    const ip = { headers: DL, ip: "203.0.113.70" };
    for (let i = 0; i < 10; i++) assert.equal((await service.request("POST", "/web/auth/email/start", { body: { email: `n${i}@example.com` }, ...ip })).status, 200);
    assert.equal(await errorCode(await service.request("POST", "/web/auth/email/start", { body: { email: "n10@example.com" }, ...ip })), "rate_limited");
  });

  it("counts welcome codes against the daily code ceiling", async () => {
    const { service } = await world({ EMAIL_CODES_DAILY_MAX: "1" });
    assert.equal((await service.request("POST", "/web/auth/email/start", { body: { email: "one@example.com" }, headers: DL })).status, 200);
    const over = await service.request("POST", "/web/auth/email/start", { body: { email: "two@example.com" }, headers: DL });
    assert.equal(over.status, 503);
    assert.equal(await errorCode(over), "email_unavailable");
  });

  it("refuses a payment claimed by someone else, disposable addresses, and fast resends", async () => {
    const { service, stripe } = await world();
    const session = await buy(service, stripe);
    await emailSignIn(service, "cara@example.com", session.id);
    const other = await service.request("POST", "/web/auth/email/start", { body: { email: "dan@example.com", sessionId: session.id } });
    assert.equal(other.status, 200);
    const claimed = await service.request("POST", "/web/auth/email/verify", { body: { email: "dan@example.com", code: lastCode(service, "dan@example.com"), sessionId: session.id } });
    assert.equal(claimed.status, 409);
    assert.equal(await errorCode(claimed), "checkout_claimed");
    const throwaway = await service.request("POST", "/web/auth/email/start", { body: { email: "x@mailinator.com", sessionId: session.id } });
    assert.equal(await errorCode(throwaway), "email_disposable");
    const extra = await buy(service, stripe);
    assert.equal((await service.request("POST", "/web/auth/email/start", { body: { email: "dan@example.com", sessionId: extra.id } })).status, 200);
    const soon = await service.request("POST", "/web/auth/email/start", { body: { email: "dan@example.com", sessionId: extra.id } });
    assert.equal(soon.status, 429);
    assert.equal(await errorCode(soon), "resend_too_soon");
    service.clock.now += 31_000;
    assert.equal((await service.request("POST", "/web/auth/email/start", { body: { email: "dan@example.com", sessionId: extra.id } })).status, 200);
    // A made-up Checkout id sends nothing.
    const fake = await service.request("POST", "/web/auth/email/start", { body: { email: "eve@example.com", sessionId: "cs_test_madeup0000000" } });
    assert.equal(await errorCode(fake), "checkout_not_found");
  });

  it("expires codes after 10 minutes and after 5 wrong tries", async () => {
    const { service, stripe } = await world();
    const session = await buy(service, stripe);
    await service.request("POST", "/web/auth/email/start", { body: { email: "fay@example.com", sessionId: session.id } });
    const code = lastCode(service, "fay@example.com");
    service.clock.now += 10 * 60_000 + 1;
    assert.equal(await errorCode(await service.request("POST", "/web/auth/email/verify", { body: { email: "fay@example.com", code, sessionId: session.id } })), "code_expired");
    await service.request("POST", "/web/auth/email/start", { body: { email: "fay@example.com", sessionId: session.id } });
    const fresh = lastCode(service, "fay@example.com");
    const bad = fresh === "123456" ? "654321" : "123456";
    for (let i = 0; i < 4; i++) assert.equal(await errorCode(await service.request("POST", "/web/auth/email/verify", { body: { email: "fay@example.com", code: bad, sessionId: session.id } })), "invalid_code");
    assert.equal(await errorCode(await service.request("POST", "/web/auth/email/verify", { body: { email: "fay@example.com", code: bad, sessionId: session.id } })), "code_expired");
    assert.equal(await errorCode(await service.request("POST", "/web/auth/email/verify", { body: { email: "fay@example.com", code: fresh, sessionId: session.id } })), "code_expired");
  });

  it("rate-limits code emails per address", async () => {
    const { service, stripe } = await world();
    const session = await buy(service, stripe);
    for (let i = 0; i < 5; i++) {
      assert.equal((await service.request("POST", "/web/auth/email/start", { body: { email: "gus@example.com", sessionId: session.id } })).status, 200);
      service.clock.now += 31_000;
    }
    const limited = await service.request("POST", "/web/auth/email/start", { body: { email: "gus@example.com", sessionId: session.id } });
    assert.equal(limited.status, 429);
    assert.equal(await errorCode(limited), "rate_limited");
  });

  it("refuses a payment more than 7 days old that nobody claimed", async () => {
    const { service, stripe } = await world();
    const session = await buy(service, stripe);
    service.clock.now += 8 * 86_400_000;
    const late = await service.request("POST", "/web/auth/email/start", { body: { email: "hal@example.com", sessionId: session.id } });
    assert.equal(late.status, 410);
    assert.equal(await errorCode(late), "checkout_expired");
    assert.equal(((await (await service.request("GET", `/web/checkout/${session.id}`)).json()) as any).status, "expired");
  });

  it("ends a session on sign-out", async () => {
    const { service, stripe } = await world();
    const session = await buy(service, stripe);
    const signedIn = await emailSignIn(service, "ivy@example.com", session.id);
    assert.equal((await service.request("POST", "/web/signout", { token: signedIn.token })).status, 200);
    assert.equal(await errorCode(await service.request("GET", "/web/account", { token: signedIn.token })), "invalid_token");
    // The old endpoints refuse it too.
    assert.equal(await errorCode(await service.request("GET", "/web/me", { token: signedIn.token })), "invalid_token");
  });
});

describe("the account step: GitHub", () => {
  it("signs up with GitHub's verified primary email and claims the payment", async () => {
    const { service, stripe } = await world();
    const session = await buy(service, stripe, "max");
    const fragment = await githubRoundTrip(service, { id: 5005, login: "octo", email: "octo@example.com" });
    assert.match(fragment, /^signin=/);
    const response = await service.request("POST", "/web/auth/github/session", { body: { code: fragment.slice("signin=".length), state: PAGE_STATE, sessionId: session.id }, headers: DL });
    assert.equal(response.status, 200, await response.clone().text());
    const body = (await response.json()) as SessionResponse;
    assert.equal(body.created, true);
    assert.ok(isPaidAccountNumber(parseAccountId(body.account.accountId)!), "a new account is independent of the GitHub id");
    assert.equal(body.account.email, "octo@example.com");
    assert.deepEqual(body.account.identities, [{ kind: "github", login: "octo" }]);
    assert.equal(body.account.plan.id, "max");
    assert.deepEqual(body.account.upgrade, []);
    // Signing in again finds the same account, with no payment.
    const again = await githubRoundTrip(service, { id: 5005, login: "octo", email: "octo@example.com" });
    const second = (await (await service.request("POST", "/web/auth/github/session", { body: { code: again.slice(7), state: PAGE_STATE } })).json()) as SessionResponse;
    assert.equal(second.account.accountId, body.account.accountId);
    assert.equal(second.created, false);
  });

  it("asks GitHub for user:email and refuses an account with no verified email", async () => {
    const { service } = await world();
    assert.equal(await githubRoundTrip(service, { id: 6006, login: "noemail", email: null }), "error=github_no_verified_email");
    for (const target of ["https://dl.new/evil", "https://evil.example/account", "https://dl.new/start"]) {
      assert.equal((await service.request("GET", `/web/auth/github?return=${encodeURIComponent(target)}&state=${PAGE_STATE}`)).status, 400, target);
    }
    assert.equal((await service.request("GET", "/web/auth/github?return=https%3A%2F%2Fdl.new%2Faccount&state=short")).status, 400);
    // The one-time code needs the page's own state.
    const fragment = await githubRoundTrip(service, { id: 6007, login: "x" });
    assert.equal(await errorCode(await service.request("POST", "/web/auth/github/session", { body: { code: fragment.slice(7), state: "another-state-0123456789" } })), "invalid_grant");
  });

  it("signs a free-tier GitHub account straight in: same number, linked identity, old keys untouched", async () => {
    const { service, stripe } = await world();
    const tokens = await service.signIn({ id: 4242, login: "olduser" });
    const old = await service.request("POST", "/v1/keys", { token: tokens.access_token, body: { name: "cursor", kind: "tool" } });
    assert.equal(old.status, 201, await old.clone().text());
    const oldKey = ((await old.json()) as { key: string }).key;
    const fragment = await githubRoundTrip(service, { id: 4242, login: "olduser" });
    const body = (await (await service.request("POST", "/web/auth/github/session", { body: { code: fragment.slice(7), state: PAGE_STATE } })).json()) as SessionResponse;
    assert.equal(body.account.accountId, accountIdOf(4242));
    assert.equal(body.created, false);
    assert.deepEqual(body.account.legacy, { plan: "free" });
    assert.equal(body.account.plan, null);
    assert.deepEqual((await service.directory().identities(4242)).map((row: object) => ({ ...row })), [{ kind: "github", subject: "4242", label: null }]);
    // The old key still works, and the account can buy a plan while signed in.
    assert.equal((await service.request("GET", "/v1/models", { token: oldKey })).status, 200);
    const session = await buy(service, stripe, "plus");
    const claim = await service.request("POST", "/web/checkout/claim", { token: body.token, body: { sessionId: session.id }, headers: DL });
    assert.equal(claim.status, 200, await claim.clone().text());
    const claimed = (await claim.json()) as any;
    assert.equal(claimed.account.plan.id, "plus");
    assert.equal(claimed.account.legacy, null);
    assert.equal(await service.account(4242).paidPlan(service.clock.now), "plus");
    // A second payment onto the same account is refused (the owner refunds it).
    const extra = await buy(service, stripe, "starter");
    const twice = await service.request("POST", "/web/checkout/claim", { token: body.token, body: { sessionId: extra.id } });
    assert.equal(await errorCode(twice), "already_subscribed");
  });

  it("refuses sign-in for an unknown GitHub account with no payment", async () => {
    const { service } = await world();
    const fragment = await githubRoundTrip(service, { id: 7007, login: "stranger" });
    const response = await service.request("POST", "/web/auth/github/session", { body: { code: fragment.slice(7), state: PAGE_STATE } });
    assert.equal(response.status, 403);
    assert.equal(await errorCode(response), "no_account");
  });

  it("holds an unknown GitHub sign-in (pending, an hour) and finishes it after the payment, without signing in again", async () => {
    const { service, stripe } = await world();
    const fragment = await githubRoundTrip(service, { id: 7100, login: "newbie", email: "newbie@example.com" }, "https://dl.new/signin");
    const refused = await service.request("POST", "/web/auth/github/session", { body: { code: fragment.slice(7), state: PAGE_STATE }, headers: DL });
    assert.equal(refused.status, 403);
    const error = ((await refused.json()) as any).error;
    assert.equal(error.code, "no_account");
    assert.equal(error.pending.email, "newbie@example.com");
    assert.equal(error.pending.expiresIn, 3600);
    const pending = error.pending.token as string;
    // It is no web session, and alone (no payment) it signs no one in.
    assert.equal((await service.request("GET", "/web/account", { token: pending, headers: DL })).status, 401);
    assert.equal(await errorCode(await service.request("POST", "/web/auth/pending/session", { body: { token: pending }, headers: DL })), "checkout_required");
    // A tampered or unpaid one is refused.
    const [h, p, sig] = pending.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, "base64url").toString()), email: "boss@example.com" })).toString("base64url")}.${sig}`;
    const paid = await buy(service, stripe, "plus");
    assert.equal(await errorCode(await service.request("POST", "/web/auth/pending/session", { body: { token: forged, sessionId: paid.id }, headers: DL })), "invalid_grant");
    // After Checkout: the account is made with the verified GitHub identity and the payment claimed.
    const done = await service.request("POST", "/web/auth/pending/session", { body: { token: pending, sessionId: paid.id }, headers: DL });
    assert.equal(done.status, 200, await done.clone().text());
    const body = (await done.json()) as SessionResponse;
    assert.equal(body.created, true);
    assert.deepEqual(body.claimed, { plan: "plus", sessionId: paid.id });
    assert.equal(body.account.email, "newbie@example.com");
    assert.equal((await service.request("GET", "/web/account", { token: body.token, headers: DL })).status, 200);
    // GitHub sign-in now finds that account.
    const again = await service.request("POST", "/web/auth/github/session", { body: { code: (await githubRoundTrip(service, { id: 7100, login: "newbie", email: "newbie@example.com" })).slice(7), state: PAGE_STATE }, headers: DL });
    assert.equal(((await again.json()) as SessionResponse).account.accountId, body.account.accountId);
  });

  it("welcomes an unknown GitHub sign-in by email, at most once per address a week", async () => {
    const { service } = await world();
    const tryOnce = async () => {
      const fragment = await githubRoundTrip(service, { id: 7300, login: "fresh", email: "fresh@example.com" }, "https://dl.new/signin");
      const refused = await service.request("POST", "/web/auth/github/session", { body: { code: fragment.slice(7), state: PAGE_STATE }, headers: DL });
      assert.equal(await errorCode(refused), "no_account");
      await service.settle();
    };
    const welcomes = () => service.calls.userEmail.filter((message) => message.to === "fresh@example.com");
    await tryOnce();
    assert.equal(welcomes().length, 1);
    assert.equal(welcomes()[0]!.subject, "Welcome to dl.new");
    assert.equal(
      welcomes()[0]!.text,
      "Welcome to dl.new. You signed in with GitHub; there's no plan on this address yet.\n\nTo finish setting up, pick a plan: https://dl.new\nStarter is $7/mo, and your first 20M tokens (95.5% caching applied) are free with a card.\n\nIf you didn't sign in to dl.new, ignore this email.\n\ndl.new",
    );
    service.clock.now += 6 * 86_400_000;
    await tryOnce();
    assert.equal(welcomes().length, 1, "not again within 7 days");
    service.clock.now += 86_400_000 + 60_000;
    await tryOnce();
    assert.equal(welcomes().length, 2, "again after 7 days");
  });

  it("refuses a pending sign-in after an hour", async () => {
    const { service, stripe } = await world();
    const fragment = await githubRoundTrip(service, { id: 7200, login: "slow", email: "slow@example.com" }, "https://dl.new/signin");
    const pending = ((await (await service.request("POST", "/web/auth/github/session", { body: { code: fragment.slice(7), state: PAGE_STATE }, headers: DL })).json()) as any).error.pending.token;
    const paid = await buy(service, stripe);
    service.clock.now += 3600_000;
    assert.equal(await errorCode(await service.request("POST", "/web/auth/pending/session", { body: { token: pending, sessionId: paid.id }, headers: DL })), "invalid_grant");
  });

  it("keeps the admin's GitHub id an admin", async () => {
    const { service } = await world();
    await service.signIn({ id: ADMIN_ID, login: "owner" });
    const fragment = await githubRoundTrip(service, { id: ADMIN_ID, login: "owner" });
    const body = (await (await service.request("POST", "/web/auth/github/session", { body: { code: fragment.slice(7), state: PAGE_STATE } })).json()) as SessionResponse;
    assert.equal(body.account.accountId, accountIdOf(ADMIN_ID));
  });
});
