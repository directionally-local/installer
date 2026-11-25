import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, createService, errorCode, type Service } from "./harness.js";
import { buy, DL, emailSignIn, FakeStripe, githubRoundTrip, lastCode, PAGE_STATE, PAID_VARS, PRICES, type SessionResponse } from "./paid-fixtures.js";
import { accountIdOf, formatApiKey, isPaidAccountNumber, PAID_ACCOUNT_BASE, parseAccountId, parseApiKey } from "../src/accounts.js";
import { isDisposableDomain } from "../src/email-guard.js";
import { countedTokens, planDescription, PLANS, realToCounted } from "../src/plans.js";

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
    assert.equal(planDescription(PLANS.plus), "DeepSeek V4.1 Flash ~150M/week + Kimi K3.1 ~1.5M/week (95.5% caching applied). Weekly limits reset Mon 00:00 UTC.");
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
    assert.ok(body.account.plan.refundableUntil);
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

  it("signs an existing account in without a Checkout, and refuses unknown addresses", async () => {
    const { service, stripe } = await world();
    const session = await buy(service, stripe);
    const first = await emailSignIn(service, "ben@example.com", session.id);
    service.clock.now += 60_000;
    const second = await emailSignIn(service, "Ben@Example.com");
    assert.equal(second.created, false);
    assert.equal(second.claimed, null);
    assert.equal(second.account.accountId, first.account.accountId);
    const unknown = await service.request("POST", "/web/auth/email/start", { body: { email: "nobody@example.com" } });
    assert.equal(unknown.status, 403);
    assert.equal(await errorCode(unknown), "no_account");
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

  it("keeps the admin's GitHub id an admin", async () => {
    const { service } = await world();
    await service.signIn({ id: ADMIN_ID, login: "owner" });
    const fragment = await githubRoundTrip(service, { id: ADMIN_ID, login: "owner" });
    const body = (await (await service.request("POST", "/web/auth/github/session", { body: { code: fragment.slice(7), state: PAGE_STATE } })).json()) as SessionResponse;
    assert.equal(body.account.accountId, accountIdOf(ADMIN_ID));
  });
});
