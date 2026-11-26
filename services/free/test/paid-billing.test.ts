import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, completion, createService, errorCode, luminalUsage, MODEL, type Service } from "./harness.js";
import { buy, DL, emailSignIn, FakeStripe, lastCode, PAID_VARS, PRICES, webhook, type SessionResponse } from "./paid-fixtures.js";
import { parseAccountId } from "../src/accounts.js";

/**
 * dl.new's paid launch after the account step (docs/web-api-paid.md): dl_sk_ keys, the plan
 * webhooks, upgrades, refunds, the contact email, settings, cli-login and the usage read-outs.
 */

async function world(vars: Record<string, string> = {}) {
  const service = await createService({ ...PAID_VARS, ...vars }, { userEmail: true, email: true });
  const stripe = new FakeStripe(service);
  return { service, stripe };
}

async function paidAccount(service: Service, stripe: FakeStripe, plan: "starter" | "plus" | "max" = "starter", email = "pat@example.com") {
  const session = await buy(service, stripe, plan, email);
  const signedIn = await emailSignIn(service, email, session.id);
  return { session, signedIn, account: parseAccountId(signedIn.account.accountId)!, token: signedIn.token };
}

async function adminToken(service: Service): Promise<string> {
  return (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
}

function accountObject(service: Service, account: number): any {
  return (service.namespaces.ACCOUNT as any).getByName(`acct:${account}`);
}

describe("dl_sk_ keys", () => {
  it("makes a key shown once, lists it by its hint, serves chat with it and revokes it", async () => {
    const { service, stripe } = await world({ TOOL_KEYS: "false" });
    const { token } = await paidAccount(service, stripe);
    const made = await service.request("POST", "/web/api-keys", { token, body: {}, headers: DL });
    assert.equal(made.status, 201, await made.clone().text());
    const key = (await made.json()) as { id: string; key: string; name: string; hint: string; format: string };
    assert.match(key.key, /^dl_sk_[0-9a-z]+_[a-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
    assert.equal(key.name, "key 1");
    assert.equal(key.hint, `dl_sk_…${key.key.slice(-4)}`);
    const listed = (await (await service.request("GET", "/web/api-keys", { token })).json()) as { keys: Array<Record<string, unknown>>; max: number };
    assert.equal(listed.max, 10);
    assert.equal(listed.keys.length, 1);
    assert.equal(listed.keys[0]!.key, undefined);
    assert.equal(listed.keys[0]!.hint, key.hint);
    // Paid keys work with the free tier's tool keys switch off.
    const chat = await service.request("POST", "/v1/chat/completions", { token: key.key, headers: { "user-agent": "opencode/1.2" }, body: { model: MODEL, messages: [{ role: "user", content: "hi" }] } });
    assert.equal(chat.status, 200, await chat.clone().text());
    const anthropic = await service.request("POST", "/anthropic/v1/messages", { headers: { "x-api-key": key.key, "user-agent": "claude-cli/2.1 (external, cli)", "anthropic-version": "2023-06-01" }, body: { model: "claude-sonnet-4-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }] } });
    assert.equal(anthropic.status, 200, await anthropic.clone().text());
    const after = (await (await service.request("GET", "/web/api-keys", { token })).json()) as { keys: Array<Record<string, unknown>> };
    assert.ok(after.keys[0]!.lastUsedAt);
    assert.ok(after.keys[0]!.lastTool);
    // Not on the events endpoint (tool keys never are).
    assert.equal((await service.request("POST", "/v1/events", { token: key.key, body: { events: [] } })).status, 403);
    assert.equal((await service.request("DELETE", `/web/api-keys/${key.id}`, { token })).status, 200);
    const revoked = await service.request("POST", "/v1/chat/completions", { token: key.key, body: { model: MODEL, messages: [{ role: "user", content: "hi" }] } });
    assert.equal(revoked.status, 401);
    assert.equal(await errorCode(revoked), "invalid_key");
    assert.equal(await errorCode(await service.request("DELETE", `/web/api-keys/${key.id}`, { token })), "key_not_found");
  });

  it("says 'Missing or invalid API key' to API callers on /v1 and /anthropic, and 'Sign in again' to a bad access token", async () => {
    const { service } = await world();
    const API_KEY = "Missing or invalid API key. Create one at dl.new/keys.";
    const message = async (response: Response) => {
      assert.equal(response.status, 401);
      return ((await response.json()) as { error: { message: string } }).error.message;
    };
    const body = { model: MODEL, messages: [{ role: "user", content: "hi" }] };
    const anthropicBody = { model: "claude-sonnet-4-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }] };
    assert.equal(await message(await service.request("POST", "/v1/chat/completions", { body })), API_KEY, "no auth");
    assert.equal(await message(await service.request("GET", "/v1/models")), API_KEY, "no auth");
    assert.equal(await message(await service.request("POST", "/anthropic/v1/messages", { body: anthropicBody })), API_KEY, "no auth");
    assert.equal(await message(await service.request("POST", "/v1/chat/completions", { token: "dl_sk_zz_abcdef012345_" + "a".repeat(43), body })), API_KEY);
    assert.equal(await message(await service.request("POST", "/anthropic/v1/messages", { headers: { "x-api-key": "dl_sk_nope" }, body: anthropicBody })), API_KEY);
    assert.equal(await message(await service.request("GET", "/v1/me", { token: "dlk_nope" })), API_KEY);
    // A dl or Autopilot access token (a JWT) keeps the sign-in wording.
    assert.equal(await message(await service.request("GET", "/v1/me", { token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln" })), "Sign in again: the access token is missing, invalid or expired.");
    assert.equal(await message(await service.request("POST", "/v1/chat/completions", { token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln", body })), "Sign in again: the access token is missing, invalid or expired.");
  });

  it("refuses a malformed or unknown dl_sk_ key", async () => {
    const { service } = await world();
    assert.equal(await errorCode(await service.request("GET", "/v1/models", { token: "dl_sk_zz_abcdef012345_" + "a".repeat(43) })), "invalid_key");
    assert.equal(await errorCode(await service.request("GET", "/v1/models", { token: "dl_sk_nope" })), "invalid_key");
  });
});

describe("plan webhooks", () => {
  it("keeps an unclaimed payment, emails the claim link once, lists it for the admin, then links it on claim", async () => {
    const { service, stripe } = await world();
    const session = await buy(service, stripe, "plus", "late@example.com");
    const object = stripe.sessionObject(session, false);
    const first = await webhook(service, "checkout.session.completed", object, "evt_cs_1");
    assert.equal(first.body.outcome, "plan_unclaimed");
    const claimEmails = service.calls.userEmail.filter((message) => message.subject === "Finish setting up dl.new");
    assert.equal(claimEmails.length, 1);
    assert.equal(claimEmails[0]!.to, "late@example.com");
    assert.match(String(claimEmails[0]!.text), new RegExp(`https://dl\\.new/account\\?session_id=${session.id}`));
    assert.match(String(claimEmails[0]!.text), /Kimi K3\.1 ~1\.5M\/week \(95\.5% caching applied\)/);
    // No refund promise in any customer email; refunds are the owner's call.
    assert.doesNotMatch(String(claimEmails[0]!.text), /refund/i);
    assert.ok(String(claimEmails[0]!.text).includes("Questions? Reply to this email."));
    // Claiming an unclaimed payment still has its own 7 days.
    assert.match(String(claimEmails[0]!.text), /The link works for 7 days\./);
    // A retried delivery under another event id doesn't email again.
    await webhook(service, "checkout.session.completed", object, "evt_cs_2");
    assert.equal(service.calls.userEmail.filter((message) => message.subject === "Finish setting up dl.new").length, 1);
    // Plan events before the claim are acknowledged and left for the claim.
    assert.equal((await webhook(service, "customer.subscription.updated", stripe.subscriptionObject(stripe.subscriptions.get(session.subscription!)!))).body.outcome, "plan_unclaimed");
    const admin = await adminToken(service);
    const unclaimed = (await (await service.request("GET", "/admin/paid/checkouts", { token: admin })).json()) as { checkouts: Array<Record<string, unknown>> };
    assert.equal(unclaimed.checkouts.length, 1);
    assert.equal(unclaimed.checkouts[0]!.sessionId, session.id);
    assert.equal(unclaimed.checkouts[0]!.claimedBy, null);
    assert.ok(unclaimed.checkouts[0]!.claimEmailSentAt);
    const signedIn = await emailSignIn(service, "late@example.com", session.id);
    assert.equal(signedIn.account.plan.id, "plus");
    assert.equal(((await (await service.request("GET", "/admin/paid/checkouts", { token: admin })).json()) as any).checkouts.length, 0);
    const claimed = (await (await service.request("GET", "/admin/paid/checkouts?status=claimed", { token: admin })).json()) as any;
    assert.equal(claimed.checkouts[0].claimedBy, signedIn.account.accountId);
    // Non-admins can't list them.
    assert.equal((await service.request("GET", "/admin/paid/checkouts", { token: (await service.signIn({ id: 77, login: "someone" })).access_token })).status, 403);
  });

  it("follows the subscription: plan changes, a failed renewal keeps the plan, cancellation ends it", async () => {
    const { service, stripe } = await world();
    const { session, account, token } = await paidAccount(service, stripe);
    const subscription = stripe.subscriptions.get(session.subscription!)!;
    const person = accountObject(service, account);
    service.clock.now += 60_000;
    subscription.price = PRICES.max;
    assert.equal((await webhook(service, "customer.subscription.updated", stripe.subscriptionObject(subscription))).body.outcome, "plan_active");
    assert.equal(await person.paidPlan(service.clock.now), "max");
    service.clock.now += 60_000;
    const invoice = { id: "in_renew", customer: session.customer, billing_reason: "subscription_cycle", total_excluding_tax: 6000, parent: { subscription_details: { subscription: subscription.id, metadata: subscription.metadata } }, lines: { data: [{ price: { id: PRICES.max }, period: { end: subscription.current_period_end + 30 * 86_400 } }] } };
    assert.equal((await webhook(service, "invoice.payment_failed", invoice)).body.outcome, "plan_past_due");
    assert.equal(await person.paidPlan(service.clock.now), "max", "a failed renewal keeps the plan while Stripe retries");
    const view = (await (await service.request("GET", "/web/account", { token })).json()) as any;
    assert.equal(view.plan.status, "past_due");
    assert.equal(view.plan.paymentFailed, true);
    service.clock.now += 60_000;
    assert.equal((await webhook(service, "invoice.paid", invoice)).body.outcome, "plan_active");
    assert.equal((await person.billing()).paymentFailed, false);
    service.clock.now += 60_000;
    subscription.status = "unpaid";
    assert.equal((await webhook(service, "customer.subscription.updated", stripe.subscriptionObject(subscription))).body.outcome, "plan_canceled");
    assert.equal(await person.paidPlan(service.clock.now), null);
    service.clock.now += 60_000;
    subscription.status = "active";
    await webhook(service, "customer.subscription.updated", stripe.subscriptionObject(subscription));
    assert.equal(await person.paidPlan(service.clock.now), "max");
    service.clock.now += 60_000;
    assert.equal((await webhook(service, "customer.subscription.deleted", { ...stripe.subscriptionObject(subscription), status: "canceled" })).body.outcome, "plan_canceled");
    assert.equal(await person.paidPlan(service.clock.now), null);
    assert.equal(((await (await service.request("GET", "/web/account", { token })).json()) as any).plan.status, "canceled");
  });

  it("leaves dl Pro's events to the old handling", async () => {
    const { service } = await world();
    await service.signIn({ id: 300, login: "pro" });
    const outcome = await webhook(service, "checkout.session.completed", { id: "cs_pro", mode: "subscription", client_reference_id: "300", customer: "cus_pro", subscription: "sub_pro", payment_status: "paid", metadata: { github_id: "300", product: "pro" } });
    assert.equal(outcome.body.outcome, "pro_active");
  });
});

describe("billing", () => {
  it("upgrades with proration now, and refuses a downgrade or a declined card", async () => {
    const { service, stripe } = await world();
    const { session, account, token } = await paidAccount(service, stripe);
    const response = await service.request("POST", "/web/billing/upgrade", { token, body: { plan: "plus" }, headers: DL });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { plan: "plus", status: "upgraded", amountDueUsd: 13 });
    const call = [...service.calls.stripe].reverse().find((entry) => entry.method === "POST" && entry.path === `/v1/subscriptions/${session.subscription}`)!;
    assert.equal(call.form.get("items[0][price]"), PRICES.plus);
    assert.equal(call.form.get("items[0][id]"), stripe.subscriptions.get(session.subscription!)!.item);
    assert.equal(call.form.get("proration_behavior"), "always_invoice");
    assert.equal(call.form.get("payment_behavior"), "error_if_incomplete");
    assert.equal(await accountObject(service, account).paidPlan(service.clock.now), "plus");
    assert.equal(await errorCode(await service.request("POST", "/web/billing/upgrade", { token, body: { plan: "starter" } })), "not_an_upgrade");
    stripe.declineNext = true;
    const declined = await service.request("POST", "/web/billing/upgrade", { token, body: { plan: "max" } });
    assert.equal(declined.status, 402);
    assert.equal(await errorCode(declined), "payment_failed");
    assert.equal(await accountObject(service, account).paidPlan(service.clock.now), "plus");
  });

  it("opens the portal back to dl.new/billing", async () => {
    const { service, stripe } = await world();
    const { session, token } = await paidAccount(service, stripe);
    const response = await service.request("POST", "/web/billing/portal", { token, headers: DL });
    assert.equal(response.status, 200);
    const call = [...service.calls.stripe].reverse().find((entry) => entry.path === "/v1/billing_portal/sessions")!;
    assert.equal(call.form.get("customer"), session.customer);
    assert.equal(call.form.get("return_url"), "https://dl.new/billing");
  });

  it("records a refund request, and the admin refunds the first payment and cancels within 24 hours", async () => {
    const { service, stripe } = await world({ ALERT_EMAIL_TO: "owner@example.com" });
    const { session, account, token, signedIn } = await paidAccount(service, stripe);
    const request = await service.request("POST", "/web/billing/refund-request", { token, body: { reason: "not for me" } });
    assert.equal(request.status, 200);
    const answer = (await request.json()) as any;
    assert.equal(answer.eligible, true);
    assert.equal(answer.notEligible, null);
    assert.equal(answer.policy, undefined, "no public refund policy");
    assert.ok(service.calls.emails.some((message) => message.raw.includes("refund request")));
    const admin = await adminToken(service);
    const listed = (await (await service.request("GET", "/admin/paid/refund-requests", { token: admin })).json()) as any;
    assert.equal(listed.requests[0].reason, "not for me");
    const refund = await service.request("POST", "/admin/paid/refund", { token: admin, body: { accountId: signedIn.account.accountId } });
    assert.equal(refund.status, 200, await refund.clone().text());
    assert.deepEqual(await refund.json(), { refunded: true, amountCents: 700, refundId: "re_1", subscriptionCanceled: true });
    assert.equal(stripe.refunds[0]!.get("payment_intent"), `pi_for_${stripe.subscriptions.get(session.subscription!)!.latest_invoice}`);
    assert.equal(stripe.subscriptions.get(session.subscription!)!.status, "canceled");
    assert.equal(await accountObject(service, account).paidPlan(service.clock.now), null);
    assert.equal(await errorCode(await service.request("POST", "/admin/paid/refund", { token: admin, body: { accountId: signedIn.account.accountId } })), "already_refunded");
    assert.equal(((await (await service.request("GET", "/admin/paid/refund-requests", { token: admin })).json()) as any).requests[0].refundedAt !== null, true);
  });

  it("refuses a refund after 24 hours unless forced", async () => {
    const { service, stripe } = await world();
    const { signedIn, token } = await paidAccount(service, stripe);
    service.clock.now += 23 * 3_600_000;
    assert.equal(((await (await service.request("POST", "/web/billing/refund-request", { token, body: {} })).json()) as any).eligible, true, "still inside 24 hours");
    service.clock.now += 2 * 3_600_000;
    const late = (await (await service.request("POST", "/web/billing/refund-request", { token, body: {} })).json()) as any;
    assert.equal(late.eligible, false);
    assert.equal(late.notEligible, "refund_not_eligible: refund window passed");
    const admin = await adminToken(service);
    const refused = await service.request("POST", "/admin/paid/refund", { token: admin, body: { accountId: signedIn.account.accountId } });
    assert.equal(refused.status, 409);
    assert.match(((await refused.clone().json()) as any).error.message, /more than 24 hours old/);
    assert.equal(await errorCode(refused), "refund_window_passed");
    assert.equal((await service.request("POST", "/admin/paid/refund", { token: admin, body: { accountId: signedIn.account.accountId, force: true } })).status, 200);
  });

  it("takes the refund window from the runtime setting refundWindowHours", async () => {
    const { service, stripe } = await world();
    const { signedIn } = await paidAccount(service, stripe);
    assert.equal((await service.request("POST", "/admin/config", { token: await adminToken(service), body: { refundWindowHours: 72 } })).status, 200);
    service.clock.now += 48 * 3_600_000;
    const admin = await adminToken(service);
    assert.equal((await service.request("POST", "/admin/paid/refund", { token: admin, body: { accountId: signedIn.account.accountId } })).status, 200);
  });

  it("refuses a refund once a plan model's weekly limit is reached, inside the 24 hours, unless forced", async () => {
    // Starter's DeepSeek at 1,000 real tokens a week (64 counted): one request uses it up.
    const { service, stripe } = await world({ PLAN_TOKENS_STARTER_DEEPSEEK: "1000" });
    const { signedIn, token } = await paidAccount(service, stripe);
    const key = ((await (await service.request("POST", "/web/api-keys", { token, body: { name: "cc" } })).json()) as any).key as string;
    service.setLuminal(() => completion(luminalUsage(1000, 50, 0)));
    assert.equal((await service.request("POST", "/v1/chat/completions", { token: key, headers: { "user-agent": "opencode/1.2" }, body: { model: MODEL, messages: [{ role: "user", content: "hi" }] } })).status, 200);
    await service.settle();
    const account = (await (await service.request("GET", "/web/account", { token })).json()) as any;
    assert.equal(account.plan.refundableUntil, undefined, "no refund fields on the account page");
    const request = (await (await service.request("POST", "/web/billing/refund-request", { token, body: { reason: "used it all" } })).json()) as any;
    assert.equal(request.eligible, false);
    assert.equal(request.notEligible, "refund_not_eligible: weekly limit reached");
    assert.deepEqual(request.limitsReached, ["DeepSeek V4.1 Flash"]);
    const admin = await adminToken(service);
    const listed = (await (await service.request("GET", "/admin/paid/refund-requests", { token: admin })).json()) as any;
    assert.equal(listed.requests[0].eligible, false);
    assert.equal(listed.requests[0].notEligible, "refund_not_eligible: weekly limit reached");
    const refused = await service.request("POST", "/admin/paid/refund", { token: admin, body: { accountId: signedIn.account.accountId } });
    assert.equal(refused.status, 409);
    const error = ((await refused.json()) as any).error;
    assert.equal(error.code, "refund_not_eligible");
    assert.equal(error.reason, "weekly limit reached");
    assert.equal(stripe.refunds.length, 0);
    assert.equal((await service.request("POST", "/admin/paid/refund", { token: admin, body: { accountId: signedIn.account.accountId, force: true } })).status, 200);
    assert.equal(stripe.refunds.length, 1);
  });

  it("keeps the 14-day withdrawal right for a Checkout without the terms consent, past the window and the weekly limit", async () => {
    const { service, stripe } = await world({ CHECKOUT_TERMS_CONSENT: "false", PLAN_TOKENS_STARTER_DEEPSEEK: "1000", ALERT_EMAIL_TO: "owner@example.com" });
    const { session, signedIn, token } = await paidAccount(service, stripe);
    const admin = await adminToken(service);
    const listed = (await (await service.request("GET", "/admin/paid/checkouts?status=all", { token: admin })).json()) as any;
    assert.equal(listed.checkouts[0].termsAcceptedAt, null);
    const key = ((await (await service.request("POST", "/web/api-keys", { token, body: { name: "cc" } })).json()) as any).key as string;
    service.setLuminal(() => completion(luminalUsage(1000, 50, 0)));
    assert.equal((await service.request("POST", "/v1/chat/completions", { token: key, headers: { "user-agent": "opencode/1.2" }, body: { model: MODEL, messages: [{ role: "user", content: "hi" }] } })).status, 200);
    await service.settle();
    // Day 10: past the 24 hours and the weekly limit reached, still inside the withdrawal period.
    service.clock.now += 10 * 86_400_000;
    // The 7-day web session has expired by now: sign in again.
    const again = (await emailSignIn(service, "pat@example.com")).token;
    const request = (await (await service.request("POST", "/web/billing/refund-request", { token: again, body: {} })).json()) as any;
    assert.equal(request.eligible, true);
    assert.equal(request.notEligible, null);
    assert.equal(request.deadline, new Date(session.created * 1000 + 14 * 86_400_000).toISOString());
    assert.ok(service.calls.emails.some((message) => message.raw.includes("refund request") && Buffer.from(message.raw.split(/\r?\n\r?\n/).slice(1).join("").replace(/\s+/g, ""), "base64").toString("utf8").includes("inside the 14-day withdrawal period")));
    const refund = await service.request("POST", "/admin/paid/refund", { token: await adminToken(service), body: { accountId: signedIn.account.accountId } });
    assert.equal(refund.status, 200, await refund.clone().text());
  });

  it("closes the withdrawal right after 14 days", async () => {
    const { service, stripe } = await world({ CHECKOUT_TERMS_CONSENT: "false" });
    const { signedIn } = await paidAccount(service, stripe);
    service.clock.now += 15 * 86_400_000;
    const token = (await emailSignIn(service, "pat@example.com")).token;
    const request = (await (await service.request("POST", "/web/billing/refund-request", { token, body: {} })).json()) as any;
    assert.equal(request.eligible, false);
    assert.equal(request.notEligible, "refund_not_eligible: refund window passed");
    assert.equal(await errorCode(await service.request("POST", "/admin/paid/refund", { token: await adminToken(service), body: { accountId: signedIn.account.accountId } })), "refund_window_passed");
  });

  it("changes the contact email with a code to the new address, and Stripe's customer email with it", async () => {
    const { service, stripe } = await world();
    const { session, token } = await paidAccount(service, stripe, "starter", "old@example.com");
    const start = await service.request("POST", "/web/account/email", { token, body: { email: "new@example.com" } });
    assert.equal(start.status, 200, await start.clone().text());
    const code = lastCode(service, "new@example.com");
    // A sign-in code can't be used for it, nor the other way round.
    assert.equal(await errorCode(await service.request("POST", "/web/auth/email/verify", { body: { email: "new@example.com", code } })), "code_expired");
    const verify = await service.request("POST", "/web/account/email/verify", { token, body: { email: "new@example.com", code } });
    assert.equal(verify.status, 200, await verify.clone().text());
    assert.deepEqual(await verify.json(), { email: "new@example.com", stripeUpdated: true });
    assert.equal(stripe.customers.get(session.customer!)!.email, "new@example.com");
    const view = (await (await service.request("GET", "/web/account", { token })).json()) as any;
    assert.equal(view.email, "new@example.com");
    assert.deepEqual(view.identities, [{ kind: "email", email: "new@example.com" }]);
    // The email sign-in moved with it.
    assert.equal((await service.request("POST", "/web/auth/email/start", { body: { email: "old@example.com" } })).status, 200);
    assert.equal(service.calls.userEmail.at(-1)!.subject, "Your dl.new sign-in code", "the welcome code: no account signs in with it now");
    service.clock.now += 31_000;
    assert.equal((await emailSignIn(service, "new@example.com")).account.accountId, view.accountId);
    // Another account's address is refused.
    const other = await paidAccount(service, stripe, "starter", "other@example.com");
    assert.equal(await errorCode(await service.request("POST", "/web/account/email", { token: other.token, body: { email: "new@example.com" } })), "email_in_use");
  });

  it("stores the fallback setting", async () => {
    const { service, stripe } = await world();
    const { token, account } = await paidAccount(service, stripe);
    assert.deepEqual(await (await service.request("GET", "/web/settings", { token })).json(), { fallback: true });
    const put = await service.request("PUT", "/web/settings", { token, body: { fallback: false }, headers: DL });
    assert.deepEqual(await put.json(), { fallback: false });
    assert.match(put.headers.get("access-control-allow-methods")!, /PUT/);
    assert.deepEqual({ ...(await accountObject(service, account).settings()) }, { fallback: false });
    assert.equal(await errorCode(await service.request("PUT", "/web/settings", { token, body: { fallback: "no" } })), "invalid_request");
  });
});

describe("cli-login", () => {
  it("lets the signed-in browser approve dl claude, which gets a dl_sk_ key once", async () => {
    const { service, stripe } = await world();
    const { token } = await paidAccount(service, stripe);
    const start = await service.request("POST", "/v1/cli-login/start", { body: { tool: "claude-code", deviceName: "box" } });
    assert.equal(start.status, 200);
    const started = (await start.json()) as { loginId: string; userCode: string; verificationUri: string; interval: number };
    assert.equal(started.verificationUri, `https://dl.new/cli-login?code=${started.userCode}`);
    assert.equal(started.interval, 2);
    assert.equal(await errorCode(await service.request("POST", "/v1/cli-login/poll", { body: { loginId: started.loginId } })), "authorization_pending");
    assert.equal(await errorCode(await service.request("POST", "/v1/cli-login/poll", { body: { loginId: started.loginId } })), "slow_down");
    const view = (await (await service.request("GET", `/web/cli-login/${started.userCode}`, { token, headers: DL })).json()) as any;
    assert.equal(view.deviceName, "box");
    assert.equal(view.status, "pending");
    assert.equal((await service.request("POST", `/web/cli-login/${started.userCode}/approve`, { token, headers: DL })).status, 200);
    assert.equal(await errorCode(await service.request("POST", `/web/cli-login/${started.userCode}/deny`, { token })), "cli_login_decided");
    service.clock.now += 2000;
    const poll = await service.request("POST", "/v1/cli-login/poll", { body: { loginId: started.loginId } });
    assert.equal(poll.status, 200, await poll.clone().text());
    const got = (await poll.json()) as any;
    assert.match(got.key, /^dl_sk_/);
    assert.equal(got.plan, "starter");
    assert.equal(got.baseUrl, "https://api.dl.new");
    assert.equal(got.anthropicBaseUrl, "https://api.dl.new/anthropic");
    assert.equal(await errorCode(await service.request("POST", "/v1/cli-login/poll", { body: { loginId: started.loginId } })), "expired_token");
    const keys = (await (await service.request("GET", "/web/api-keys", { token })).json()) as any;
    assert.deepEqual(keys.keys.map((key: any) => key.name), ["dl claude on box"]);
    // A second machine with the same name gets its own key.
    const second = (await (await service.request("POST", "/v1/cli-login/start", { body: { deviceName: "box" } })).json()) as any;
    await service.request("POST", `/web/cli-login/${second.userCode}/approve`, { token });
    assert.equal((await service.request("POST", "/v1/cli-login/poll", { body: { loginId: second.loginId } })).status, 200);
    assert.deepEqual(((await (await service.request("GET", "/web/api-keys", { token })).json()) as any).keys.map((key: any) => key.name).sort(), ["dl claude on box", "dl claude on box (2)"]);
  });

  it("tells the CLI about a denial, an expiry, and an account with no plan", async () => {
    const { service, stripe } = await world();
    const { token, session } = await paidAccount(service, stripe);
    const denied = (await (await service.request("POST", "/v1/cli-login/start", { body: {} })).json()) as any;
    await service.request("POST", `/web/cli-login/${denied.userCode}/deny`, { token });
    assert.equal(await errorCode(await service.request("POST", "/v1/cli-login/poll", { body: { loginId: denied.loginId } })), "access_denied");
    const late = (await (await service.request("POST", "/v1/cli-login/start", { body: {} })).json()) as any;
    service.clock.now += 11 * 60_000;
    assert.equal(await errorCode(await service.request("POST", `/web/cli-login/${late.userCode}/approve`, { token })), "cli_login_not_found");
    assert.equal(await errorCode(await service.request("POST", "/v1/cli-login/poll", { body: { loginId: late.loginId } })), "expired_token");
    await webhook(service, "customer.subscription.deleted", { ...stripe.subscriptionObject(stripe.subscriptions.get(session.subscription!)!), status: "canceled" });
    const noPlan = (await (await service.request("POST", "/v1/cli-login/start", { body: {} })).json()) as any;
    const refused = await service.request("POST", `/web/cli-login/${noPlan.userCode}/approve`, { token });
    assert.equal(refused.status, 403);
    assert.equal(await errorCode(refused), "no_plan");
  });
});

describe("usage", () => {
  it("adds up the week per model, day and tool, and feeds the live box", async () => {
    const { service, stripe } = await world();
    const { token } = await paidAccount(service, stripe);
    const key = ((await (await service.request("POST", "/web/api-keys", { token, body: { name: "cc" } })).json()) as any).key as string;
    const before = (await (await service.request("GET", "/web/usage/live", { token })).json()) as any;
    assert.equal(before.connected, false);
    assert.deepEqual(before.requests, []);
    service.setLuminal(() => completion(luminalUsage(1000, 50, 0)));
    const ask = () => service.request("POST", "/v1/chat/completions", { token: key, headers: { "user-agent": "opencode/1.2" }, body: { model: MODEL, messages: [{ role: "user", content: "hi" }] } });
    assert.equal((await ask()).status, 200);
    service.setLuminal(() => completion(luminalUsage(18_516, 96, 18_204)));
    service.clock.now += 1000;
    assert.equal((await ask()).status, 200);
    const live = (await (await service.request("GET", "/web/usage/live", { token, headers: DL })).json()) as any;
    assert.equal(live.connected, true);
    assert.equal(live.requests.length, 2);
    assert.equal(live.requests[0].cachedInput, 18_204);
    assert.equal(live.requests[0].freshInput, 312);
    assert.equal(live.requests[0].output, 96);
    assert.equal(live.requests[0].countedTokens, Math.round(18_204 * 0.02 + 312 + 96));
    assert.equal(live.requests[0].tool, "opencode");
    assert.equal(live.line, "The 2nd request reused cached context, so 18,204 tokens counted as 364.");
    const next = (await (await service.request("GET", `/web/usage/live?after=${live.cursor}`, { token })).json()) as any;
    assert.deepEqual(next.requests, []);
    assert.equal(next.cursor, live.cursor);
    const week = (await (await service.request("GET", "/web/usage", { token, headers: DL })).json()) as any;
    assert.equal(week.totals.requests, 2);
    assert.equal(week.totals.cachedInput, 18_204);
    assert.equal(week.totals.freshInput, 1000 + 312);
    assert.equal(week.totals.output, 146);
    assert.equal(week.totals.cachedCountedAs, 364);
    assert.equal(week.models[0].model, MODEL);
    assert.deepEqual(week.tools.map((tool: any) => tool.tool), ["opencode"]);
    assert.equal(week.days.length, 3, "Monday to today (a Wednesday)");
    assert.equal(week.days.at(-1).realTokens, 1050 + 18_612);
    assert.equal(week.days.at(-1).countedTokens, week.totals.countedTokens);
    // The plan's bar, the same as /web/account's limits[] (part B's planLimitsView).
    assert.equal(week.models[0].limit.tokensPerWeek, 62_000_000);
    assert.equal(week.models[0].limit.countedUsed, week.totals.countedTokens);
    assert.equal(week.models[0].limit.state, "ok");
    assert.equal(week.totals.realToCounted, Math.round((week.totals.countedTokens / week.totals.realTokens) * 10_000) / 10_000);
    assert.equal(week.week.resetsAt, "2026-11-09T00:00:00.000Z");
    assert.equal(await errorCode(await service.request("GET", "/web/usage?week=2026-11-04", { token })), "invalid_week");
    assert.equal(await errorCode(await service.request("GET", "/web/usage?week=2026-08-03", { token })), "week_unavailable");
    assert.equal((await service.request("GET", "/web/usage?week=2026-11-02", { token })).status, 200);
    // A week back reads that week's meters, without bars; nothing was used then.
    const last = (await (await service.request("GET", "/web/usage?week=2026-10-26", { token })).json()) as any;
    assert.equal(last.totals.requests, 0);
    assert.equal(last.days.length, 7);
    assert.equal(last.models.find((model: any) => model.model === MODEL)?.limit ?? null, null);
  });
});
