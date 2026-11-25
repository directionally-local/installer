/**
 * dl.new's paid launch, the service side (docs/web-api-paid.md is the contract): plan Checkout
 * before any account, sign-up and sign-in with email codes or GitHub (verified email), claiming a
 * paid Checkout onto an account, dl_sk_ API keys, billing (portal, prorated upgrade, refunds),
 * cli-login for `dl claude`, the usage read-outs and the plan webhooks.
 *
 * Routed from app.ts (`paidWebRoute`, `paidV1`, `paidAdmin`, `applyPlanEvent`); the helpers it
 * uses (Durable Object stubs, rate limits, the signing key) are app.ts's own.
 */

import { githubAuthorizeUrl, githubPrimaryEmail, githubSignInFromCode } from "../../shared/src/github.js";
import { signJwt, verifyJwt } from "../../shared/src/jwt.js";
import type { Limit } from "../../shared/src/rate-limit.js";
import {
  account,
  alert,
  auth,
  blockedError,
  CALLBACK_PATH,
  createKey,
  directory,
  GITHUB_CHECK_TIMEOUT_MS,
  GITHUB_USER_AGENT,
  ISSUER,
  keyView,
  limited,
  PAID_KEYS_MAX,
  rateLimited,
  readCookie,
  readJson,
  runtime,
  signingKey,
  userEmailVia,
  webOrigin,
  type Ctx,
} from "./app.js";
import { accountIdOf, emailHint, isPaidAccountNumber, keyHint, parseAccountId, type IdentityKind } from "./accounts.js";
import type { BillingState, ServerKeyView } from "./account-object.js";
import type { Alert } from "./alerts.js";
import { emailBlocked, emailDomain, isDisposableDomain, normalizeEmail, plausibleEmail } from "./email-guard.js";
import { apiError, json } from "./errors.js";
import { CLAIM_DAYS, isPlanId, isUpgrade, PLAN_IDS, PLANS, planDescription, planOfPrice, plansView, REFUND_DAYS, type PlanId } from "./plan-prices.js";
import { claimable, type PaidCheckoutRow, type UsageRow } from "./paid-store.js";
import { CLI_LOGIN_INTERVAL_S, EMAIL_CODE_RESEND_MS, EMAIL_CODE_TTL_MS } from "./paid-auth.js";
import { normalizeUserCode } from "./codes.js";
import { CHECKOUT_SESSION_ID, createPlanCheckout, idOf, invoicePayment, invoicePeriodEnd, invoicePrices, invoiceSubscription, periodEnd, planState, StripeError, stripeRequest, subscriptionPrice, type StripeEvent } from "./stripe.js";
import { sendPlainEmail } from "./user-email-send.js";
import { DAY_MS, isoDay, weekEnd, weekStart, WEEK_MS } from "./week.js";

/** A dl.new web session lives this long (the old GitHub one: an hour). */
export const PAID_WEB_SESSION_TTL_S = 7 * 86_400;
const ACCOUNT_OAUTH_COOKIE = "__Host-dl_account_oauth";
/** The pages a dl.new GitHub sign-in may return to (paths on WEB_SIGNUP_URL's origin). */
export const GITHUB_RETURN_PATHS = ["/account", "/signin", "/cli-login"] as const;
const PAGE_STATE = /^[A-Za-z0-9_-]{16,128}$/;
const HANDOFF_CODE = /^[A-Za-z0-9_-]{22,64}$/;
const LOGIN_ID = /^[A-Za-z0-9_-]{22,64}$/;
const DEVICE_NAME = /^[\x20-\x7e]{1,64}$/;
const TOOL = /^[a-z0-9][a-z0-9-]{0,31}$/;
const LIVE_ROWS = 5;

const PAID_LIMITS = {
  checkoutIp: { capacity: 20, perHour: 20 },
  checkoutLookupIp: { capacity: 120, perHour: 600 },
  emailAddress: { capacity: 5, perHour: 5 },
  emailIp: { capacity: 20, perHour: 20 },
  verifyIp: { capacity: 60, perHour: 60 },
  githubIp: { capacity: 30, perHour: 30 },
  cliStartIp: { capacity: 20, perHour: 20 },
  cliPollIp: { capacity: 120, perHour: 3600 },
  // The connect page polls every 2 seconds (livePerson), on top of its other calls.
  accountPerson: { capacity: 300, perHour: 3600 },
  livePerson: { capacity: 60, perHour: 3600 },
} satisfies Record<string, Limit>;

const NO_ACCOUNT_MESSAGE = "There's no dl.new account for this yet. Pick a plan at dl.new first.";

// ─── Web sessions ───────────────────────────────────────────────────────────

/** A dl.new web session for an account: a "web" JWT with its own session id (sign-out ends it). */
async function issueWebSession(c: Ctx, accountNumber: number, login: string): Promise<{ token: string; expiresIn: number }> {
  const iat = Math.floor(c.now() / 1000);
  const token = await signJwt(
    { iss: ISSUER, typ: "web", sub: String(accountNumber), login, sid: crypto.randomUUID(), iat, exp: iat + PAID_WEB_SESSION_TTL_S, jti: crypto.randomUUID() },
    await signingKey(c.config),
  );
  return { token, expiresIn: PAID_WEB_SESSION_TTL_S };
}

interface PaidCaller {
  account: number;
  login: string;
  sid: string | undefined;
  exp: number;
  email: string | null;
}

/** The account behind a web session (any: a dl.new one or an older GitHub one), or the 401/403. */
async function paidCaller(c: Ctx): Promise<PaidCaller | Response> {
  const match = /^Bearer\s+(\S+)$/i.exec(c.request.headers.get("authorization") ?? "");
  const invalid = () => apiError(401, "invalid_token", "Your dl.new sign-in expired. Sign in again.");
  if (!match) return invalid();
  const claims = await verifyJwt(match[1]!, await signingKey(c.config), Math.floor(c.now() / 1000));
  if (!claims || claims.typ !== "web" || claims.iss !== ISSUER || typeof claims.login !== "string") return invalid();
  const accountNumber = Number(claims.sub);
  if (!Number.isSafeInteger(accountNumber) || accountNumber <= 0) return invalid();
  const sid = typeof claims.sid === "string" ? claims.sid : undefined;
  if (sid && !(await account(c, accountNumber).sessionAllowed(sid, Number(claims.iat)))) return invalid();
  const person = await directory(c).getPerson(accountNumber);
  if (!person) return invalid();
  if (person.status === "blocked") return blockedError();
  const retry = await limited(c, `paid:acct:${accountNumber}`, PAID_LIMITS.accountPerson);
  if (retry !== undefined) return rateLimited(retry);
  return { account: accountNumber, login: claims.login, sid, exp: Number(claims.exp), email: person.email ?? null };
}

// ─── Routing ────────────────────────────────────────────────────────────────

type Handler = (c: Ctx) => Promise<Response>;
export type PaidRoute = Partial<Record<"GET" | "POST" | "PUT" | "DELETE", Handler>>;

const ROUTES: Record<string, PaidRoute> = {
  "/web/plans": { GET: webPlans },
  "/web/checkout/plan": { POST: webCheckoutPlan },
  "/web/checkout/claim": { POST: webClaim },
  "/web/auth/email/start": { POST: (c) => emailStart(c) },
  "/web/auth/email/verify": { POST: emailVerify },
  "/web/auth/github/session": { POST: githubSession },
  "/web/signout": { POST: signOut },
  "/web/account": { GET: webAccount },
  "/web/account/email": { POST: contactEmailStart },
  "/web/account/email/verify": { POST: contactEmailVerify },
  "/web/settings": { GET: getSettings, PUT: putSettings },
  "/web/api-keys": { GET: listApiKeys, POST: createApiKey },
  "/web/billing/portal": { POST: billingPortal },
  "/web/billing/upgrade": { POST: billingUpgrade },
  "/web/billing/refund-request": { POST: refundRequest },
  "/web/usage": { GET: usage },
  "/web/usage/live": { GET: usageLive },
};

/** A /web/* route of the paid launch, or undefined (app.ts then tries its own). */
export function paidWebRoute(path: string): PaidRoute | undefined {
  const checkout = /^\/web\/checkout\/(cs_[A-Za-z0-9_]{10,220})$/.exec(path);
  if (checkout) return { GET: (c) => checkoutStatus(c, checkout[1]!) };
  const key = /^\/web\/api-keys\/([a-z0-9]{12})$/.exec(path);
  if (key) return { DELETE: (c) => revokeApiKey(c, key[1]!) };
  const cli = /^\/web\/cli-login\/([A-Za-z0-9-]{8,9})(?:\/(approve|deny))?$/.exec(path);
  if (cli) return cli[2] ? { POST: (c) => cliDecide(c, cli[1]!, cli[2] === "approve") } : { GET: (c) => cliView(c, cli[1]!) };
  return ROUTES[path];
}

/** POST /v1/cli-login/start and /v1/cli-login/poll (the CLI; no CORS, no session). */
export function paidV1(c: Ctx, path: string, method: string): Promise<Response> | undefined {
  if (method === "POST" && path === "/v1/cli-login/start") return cliStart(c);
  if (method === "POST" && path === "/v1/cli-login/poll") return cliPoll(c);
  return undefined;
}

// ─── Plans and Checkout ─────────────────────────────────────────────────────

function planPrice(c: Ctx, plan: PlanId): string | undefined {
  return c.config.stripe.prices?.[plan];
}

function billingOn(c: Ctx): boolean {
  return c.config.stripe.secretKey !== undefined;
}

function billingUnavailable(): Response {
  return apiError(503, "billing_unavailable", "Paying isn't open yet. Try again soon.");
}

/** GET /web/plans: the plan cards. */
async function webPlans(c: Ctx): Promise<Response> {
  const { config } = await runtime(c);
  return json(plansView({ cachedTokenWeight: config.cachedTokenWeight, available: billingOn(c) && PLAN_IDS.every((plan) => planPrice(c, plan) !== undefined) }));
}

/** POST /web/checkout/plan {plan, campaign?} → {url, sessionId}: Stripe Checkout, no account yet. */
async function webCheckoutPlan(c: Ctx): Promise<Response> {
  const retry = await limited(c, `paid:checkout:ip:${c.ipNet}`, PAID_LIMITS.checkoutIp);
  if (retry !== undefined) return rateLimited(retry);
  const body = (await readJson(c)) ?? {};
  if (!isPlanId(body.plan)) return apiError(400, "invalid_plan", 'Send {plan: "starter" | "plus" | "max"}.');
  const price = planPrice(c, body.plan);
  if (!billingOn(c) || !price) return billingUnavailable();
  const site = webOrigin(c);
  const campaign = typeof body.campaign === "string" && /^[\x20-\x7e]{1,200}$/.test(body.campaign) ? body.campaign : undefined;
  try {
    const session = await createPlanCheckout(c.fetch, {
      secretKey: c.config.stripe.secretKey!,
      plan: body.plan,
      price,
      successUrl: `${site}/account?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${site}/?plan=${body.plan}`,
      ...(campaign ? { campaign } : {}),
      idempotencyKey: crypto.randomUUID(),
    });
    return json({ url: session.url, sessionId: session.id });
  } catch (error) {
    if (error instanceof StripeError) return apiError(502, "billing_error", "Stripe couldn't start the checkout. Try again in a minute.");
    throw error;
  }
}

/** A paid plan Checkout as Stripe reports it (read again on every claim: the webhook may not have come yet). */
interface VerifiedCheckout {
  sessionId: string;
  plan: PlanId;
  customerId: string | null;
  subscriptionId: string | null;
  subscription: Record<string, any> | null;
  email: string | null;
  amountCents: number;
  paidAt: number;
  claimedBy: number | null;
}

/** Reads a Checkout Session from Stripe and checks it is a paid dl.new plan; else the error response. */
async function verifyCheckout(c: Ctx, sessionId: unknown): Promise<VerifiedCheckout | Response> {
  if (typeof sessionId !== "string" || !CHECKOUT_SESSION_ID.test(sessionId)) return apiError(404, "checkout_not_found", "We couldn't find that payment. Start again at dl.new.");
  if (!billingOn(c)) return billingUnavailable();
  let session: Record<string, any>;
  try {
    session = await stripeRequest(c.fetch, c.config.stripe.secretKey!, "GET", `/v1/checkout/sessions/${sessionId}`, { expand: ["subscription"] });
  } catch (error) {
    if (error instanceof StripeError && error.status === 404) return apiError(404, "checkout_not_found", "We couldn't find that payment. Start again at dl.new.");
    if (error instanceof StripeError) return apiError(502, "billing_error", "Stripe didn't answer. Try again in a minute.");
    throw error;
  }
  if (session.metadata?.product !== "plan" || session.mode !== "subscription") return apiError(404, "checkout_not_found", "We couldn't find that payment. Start again at dl.new.");
  if (session.status !== "complete" || session.payment_status !== "paid") return apiError(402, "checkout_unpaid", "This checkout wasn't paid. Pick a plan at dl.new to try again.");
  const subscription = session.subscription && typeof session.subscription === "object" ? (session.subscription as Record<string, any>) : null;
  const plan = planOfPrice(c.config.stripe.prices ?? {}, subscription ? subscriptionPrice(subscription) : undefined) ?? (isPlanId(session.metadata?.plan) ? session.metadata.plan : undefined);
  if (!plan) return apiError(404, "checkout_not_found", "We couldn't find that payment. Start again at dl.new.");
  const row = await directory(c).paidCheckout(sessionId);
  const paidAt = typeof session.created === "number" ? session.created * 1000 : c.now();
  if ((row?.claimed_by ?? null) === null && !claimable({ paid_at: paidAt }, c.now(), CLAIM_DAYS)) {
    return apiError(410, "checkout_expired", `This payment is more than ${CLAIM_DAYS} days old and wasn't set up. Write to contact@directionallylocal.com and we'll sort it out.`);
  }
  return {
    sessionId,
    plan,
    customerId: idOf(session.customer) ?? null,
    subscriptionId: idOf(session.subscription) ?? null,
    subscription,
    email: typeof session.customer_details?.email === "string" ? session.customer_details.email : null,
    amountCents: typeof session.amount_total === "number" ? session.amount_total : 0,
    paidAt,
    claimedBy: row?.claimed_by ?? null,
  };
}

/** GET /web/checkout/:sessionId: what dl.new/account shows before the account step. */
async function checkoutStatus(c: Ctx, sessionId: string): Promise<Response> {
  const retry = await limited(c, `paid:lookup:ip:${c.ipNet}`, PAID_LIMITS.checkoutLookupIp);
  if (retry !== undefined) return rateLimited(retry);
  const verified = await verifyCheckout(c, sessionId);
  if (verified instanceof Response) {
    const code = ((await verified.clone().json()) as { error?: { code?: string } }).error?.code;
    if (code === "checkout_unpaid") return json({ sessionId, status: "unpaid", plan: null, emailHint: null, claimable: false, claimBy: null });
    if (code === "checkout_expired") return json({ sessionId, status: "expired", plan: null, emailHint: null, claimable: false, claimBy: null });
    return verified;
  }
  const claimed = verified.claimedBy !== null;
  return json({
    sessionId,
    status: claimed ? "claimed" : "paid",
    plan: verified.plan,
    emailHint: emailHint(verified.email),
    claimable: !claimed,
    claimBy: claimed ? null : new Date(verified.paidAt + CLAIM_DAYS * DAY_MS).toISOString(),
  });
}

/**
 * Links a verified Checkout to an account: the customer and subscription, the plan, the Stripe
 * customer's email. Idempotent for the same account; refused when another account has it or the
 * account already has a plan on another subscription.
 */
async function claimCheckout(c: Ctx, accountNumber: number, checkout: VerifiedCheckout, email: string | null): Promise<{ plan: PlanId; sessionId: string } | Response> {
  if (checkout.claimedBy !== null && checkout.claimedBy !== accountNumber) return apiError(409, "checkout_claimed", "This payment is already linked to another dl.new account. Sign in with that one.");
  const person = account(c, accountNumber);
  const billing = await person.billing();
  const hasOther = billing.subscriptionId !== null && billing.subscriptionId !== checkout.subscriptionId && (await person.plan(c.now())) === "pro";
  if (hasOther) {
    return apiError(409, "already_subscribed", "This account already has a plan. Manage it at dl.new/billing; write to contact@directionallylocal.com about the second payment and we'll refund it.");
  }
  const dir = directory(c);
  await dir.recordPaidCheckout({ sessionId: checkout.sessionId, plan: checkout.plan, customerId: checkout.customerId, subscriptionId: checkout.subscriptionId, email: checkout.email, amountCents: checkout.amountCents, paidAt: checkout.paidAt });
  const claimed = await dir.claimPaidCheckout(checkout.sessionId, accountNumber, c.now());
  if (claimed !== "claimed") return apiError(409, "checkout_claimed", "This payment is already linked to another dl.new account. Sign in with that one.");
  if (checkout.customerId) {
    await dir.mapCustomer(checkout.customerId, accountNumber);
    await person.setCustomer(checkout.customerId);
  }
  const subscription = checkout.subscription;
  if (checkout.subscriptionId) {
    const state = subscription ? planState(subscription.status) : "active";
    const end = subscription ? periodEnd(subscription) : null;
    await person.applySubscription({
      subscriptionId: checkout.subscriptionId,
      state,
      periodEnd: end,
      cancelAtPeriodEnd: subscription?.cancel_at_period_end === true,
      ...(checkout.customerId ? { customerId: checkout.customerId } : {}),
      eventAt: Math.floor(c.now() / 1000),
      tier: checkout.plan,
      paymentFailed: false,
    });
    await dir.mirrorSubscription({ githubId: accountNumber, state, periodEnd: end, eventAt: Math.floor(c.now() / 1000) });
    const invoiceId = idOf(subscription?.latest_invoice);
    if (invoiceId) {
      await person.noteFirstPayment({ invoiceId, at: checkout.paidAt });
      const paymentAlert = await dir.recordPayment({ id: invoiceId, githubId: accountNumber, kind: "pro", amountCents: checkout.amountCents, at: checkout.paidAt, product: PLANS[checkout.plan].name });
      if (paymentAlert) await alert(c, [paymentAlert]);
    }
  }
  // Stripe's customer gets the verified email; the subscription and customer carry the account id.
  // Best effort: the plan works without it, and the next claim or change tries again.
  if (c.config.stripe.secretKey) {
    const key = c.config.stripe.secretKey;
    const metadata = { account_id: accountIdOf(accountNumber) };
    try {
      if (checkout.customerId) await stripeRequest(c.fetch, key, "POST", `/v1/customers/${checkout.customerId}`, { ...(email ? { email } : {}), metadata });
      if (checkout.subscriptionId) await stripeRequest(c.fetch, key, "POST", `/v1/subscriptions/${checkout.subscriptionId}`, { metadata: { ...metadata, product: "plan", plan: checkout.plan } });
    } catch (error) {
      console.error("paid: claim's Stripe update failed", error instanceof StripeError ? error.status : "error");
    }
  }
  return { plan: checkout.plan, sessionId: checkout.sessionId };
}

/** POST /web/checkout/claim {sessionId}: a signed-in person claims a new payment onto their account. */
async function webClaim(c: Ctx): Promise<Response> {
  const caller = await paidCaller(c);
  if (caller instanceof Response) return caller;
  const body = (await readJson(c)) ?? {};
  const checkout = await verifyCheckout(c, body.sessionId);
  if (checkout instanceof Response) return checkout;
  const claimed = await claimCheckout(c, caller.account, checkout, caller.email);
  if (claimed instanceof Response) return claimed;
  return json({ claimed, account: await accountView(c, caller.account) });
}

// ─── Sign-up and sign-in ────────────────────────────────────────────────────

interface SignInIdentity {
  kind: IdentityKind;
  subject: string;
  /** The address as typed, or the GitHub login. */
  label: string;
  /** The verified email. */
  email: string;
}

/**
 * Signs an identity in: its account, or (with a paid, unclaimed Checkout) a new account, and the
 * Checkout claimed onto it. Answers the session response.
 */
async function signIn(c: Ctx, identity: SignInIdentity, sessionId: unknown): Promise<Response> {
  const dir = directory(c);
  let accountNumber = await dir.resolveIdentity(identity.kind, identity.subject, c.now());
  let checkout: VerifiedCheckout | undefined;
  if (sessionId !== undefined && sessionId !== null && sessionId !== "") {
    const verified = await verifyCheckout(c, sessionId);
    if (verified instanceof Response) return verified;
    checkout = verified;
    if (accountNumber === undefined && checkout.claimedBy !== null) return apiError(409, "checkout_claimed", "This payment is already linked to another dl.new account. Sign in with that one.");
  }
  let created = false;
  if (accountNumber === undefined) {
    if (!checkout) return apiError(403, "no_account", NO_ACCOUNT_MESSAGE);
    const made = await dir.signUpPaid({ kind: identity.kind, subject: identity.subject, label: identity.label, email: identity.email, now: c.now() });
    accountNumber = made.account;
    created = made.created;
    if (created) {
      const person = await dir.getPerson(accountNumber);
      await account(c, accountNumber).activate({ githubId: accountNumber, login: person?.login ?? accountIdOf(accountNumber), isAdmin: false, now: c.now() });
    }
  }
  const person = await dir.getPerson(accountNumber);
  if (!person) return apiError(403, "no_account", NO_ACCOUNT_MESSAGE);
  if (person.status === "blocked") return blockedError();
  // A free-tier account that never gave a contact email gets the verified one.
  if (!person.email) await dir.setEmail(accountNumber, identity.email, false, c.now());
  let claimed: { plan: PlanId; sessionId: string } | null = null;
  if (checkout) {
    const result = await claimCheckout(c, accountNumber, checkout, person.email ?? identity.email);
    if (result instanceof Response) return result;
    claimed = result;
  }
  const session = await issueWebSession(c, accountNumber, person.login);
  return json({ ...session, account: await accountView(c, accountNumber), created, claimed });
}

/** The address from a body, checked: plausible, not disposable, not blocked. */
async function checkedEmail(c: Ctx, raw: unknown): Promise<{ email: string; norm: string } | Response> {
  const email = typeof raw === "string" ? raw.trim() : "";
  if (!plausibleEmail(email)) return apiError(400, "invalid_email", "Enter an email address we can reach you at.");
  const norm = normalizeEmail(email);
  const { config } = await runtime(c);
  if (isDisposableDomain(emailDomain(norm)) || emailBlocked(norm, config.blockedEmails)) {
    return apiError(400, "email_disposable", "Use a permanent email address: we send your key and usage alerts there.");
  }
  return { email, norm };
}

/** Sends a 6-digit code to an address for a purpose, with the rate limits and the 30-second resend. */
async function sendCode(c: Ctx, email: string, norm: string, purpose: string, subject: string, intro: string): Promise<Response> {
  const ipRetry = await limited(c, `paid:email:ip:${c.ipNet}`, PAID_LIMITS.emailIp);
  if (ipRetry !== undefined) return rateLimited(ipRetry);
  const transport = userEmailVia(c);
  if (!transport) return apiError(503, "email_unavailable", "We can't send email right now. Try GitHub, or again in a few minutes.");
  const issued = await auth(c).issueEmailCode({ emailNorm: norm, purpose, now: c.now() });
  if (!issued.ok) return apiError(429, "resend_too_soon", `Wait ${issued.retryAfter} seconds before asking for another code.`, { retryAfter: issued.retryAfter }, { "retry-after": String(issued.retryAfter) });
  const addressRetry = await limited(c, `paid:email:addr:${norm}`, PAID_LIMITS.emailAddress);
  if (addressRetry !== undefined) {
    await auth(c).dropEmailCode(norm, purpose);
    return rateLimited(addressRetry);
  }
  const sent = await sendPlainEmail(transport, c.config, {
    to: email,
    subject,
    text: `${intro}\n\n    ${issued.code}\n\nIt works for ${EMAIL_CODE_TTL_MS / 60_000} minutes. If you didn't ask for it, ignore this email.\n\ndl.new`,
    idempotencyKey: `code-${purpose}-${norm}-${c.now()}`,
  });
  if (!sent.ok) {
    await auth(c).dropEmailCode(norm, purpose);
    return apiError(502, "email_failed", "The email didn't go out. Try again in a minute, or use GitHub.");
  }
  return json({ sent: true, resendAfter: EMAIL_CODE_RESEND_MS / 1000, expiresIn: EMAIL_CODE_TTL_MS / 1000 });
}

/** POST /web/auth/email/start {email, sessionId?}: a sign-up or sign-in code. */
async function emailStart(c: Ctx): Promise<Response> {
  const body = (await readJson(c)) ?? {};
  const checked = await checkedEmail(c, body.email);
  if (checked instanceof Response) return checked;
  const sessionId = body.sessionId;
  if (sessionId !== undefined && sessionId !== null && sessionId !== "") {
    // A code for a sign-up goes out only for a real payment (no codes to strangers on a made-up id).
    const recorded = typeof sessionId === "string" ? await directory(c).paidCheckout(sessionId) : undefined;
    if (!recorded) {
      const verified = await verifyCheckout(c, sessionId);
      if (verified instanceof Response) return verified;
    }
  } else if ((await directory(c).resolveIdentity("email", checked.norm, c.now())) === undefined) {
    return apiError(403, "no_account", NO_ACCOUNT_MESSAGE);
  }
  return sendCode(c, checked.email, checked.norm, "signin", "Your dl.new code", "Your dl.new sign-in code:");
}

function codeRefusal(check: { reason: "invalid"; attemptsLeft: number } | { reason: "expired" }): Response {
  return check.reason === "invalid"
    ? apiError(400, "invalid_code", `That code isn't right. ${check.attemptsLeft} ${check.attemptsLeft === 1 ? "try" : "tries"} left.`, { attemptsLeft: check.attemptsLeft })
    : apiError(400, "code_expired", "That code expired. Ask for a new one.");
}

/** POST /web/auth/email/verify {email, code, sessionId?} → the session response. */
async function emailVerify(c: Ctx): Promise<Response> {
  const retry = await limited(c, `paid:verify:ip:${c.ipNet}`, PAID_LIMITS.verifyIp);
  if (retry !== undefined) return rateLimited(retry);
  const body = (await readJson(c)) ?? {};
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!plausibleEmail(email)) return apiError(400, "invalid_email", "Enter an email address we can reach you at.");
  const norm = normalizeEmail(email);
  const code = typeof body.code === "string" ? body.code.replace(/\s+/g, "") : "";
  const check = await auth(c).verifyEmailCode({ emailNorm: norm, purpose: "signin", code, now: c.now() });
  if (!check.ok) return codeRefusal(check);
  return signIn(c, { kind: "email", subject: norm, label: email, email }, body.sessionId);
}

/** GET /web/auth/github?return=&state=: dl.new's own GitHub sign-in (scope user:email). */
export async function githubStart(c: Ctx): Promise<Response> {
  const site = webOrigin(c);
  const returnUrl = c.url.searchParams.get("return") ?? "";
  const allowed = GITHUB_RETURN_PATHS.map((path) => `${site}${path}`);
  const state = c.url.searchParams.get("state") ?? "";
  if (!allowed.includes(returnUrl) || !PAGE_STATE.test(state)) return new Response("This sign-in link isn't valid. Start again at dl.new.", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
  const retry = await limited(c, `paid:github:ip:${c.ipNet}`, PAID_LIMITS.githubIp);
  if (retry !== undefined) return new Response(null, { status: 303, headers: { location: `${returnUrl}#error=rate_limited`, "cache-control": "no-store" } });
  const begun = await auth(c).beginAccountOAuth({ returnUrl, pageState: state, now: c.now() });
  return new Response(null, {
    status: 302,
    headers: {
      location: githubAuthorizeUrl({ clientId: c.config.githubClientId }, `${c.base}${CALLBACK_PATH}`, begun.state, "user:email"),
      "set-cookie": `${ACCOUNT_OAUTH_COOKIE}=${begun.browser}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

/** The shared GitHub callback, for a state of purpose "account": back to the page with a one-time code. */
export async function githubCallback(c: Ctx): Promise<Response> {
  const state = c.url.searchParams.get("state") ?? "";
  const browser = readCookie(c.request, ACCOUNT_OAUTH_COOKIE);
  const claimed = browser ? await auth(c).claimAccountOAuth({ state, browser, now: c.now() }) : undefined;
  if (!claimed) return new Response(null, { status: 303, headers: { location: `${webOrigin(c)}/signin#error=expired`, "cache-control": "no-store" } });
  const back = (fragment: string) =>
    new Response(null, { status: 303, headers: { location: `${claimed.returnUrl}#${fragment}`, "cache-control": "no-store", "referrer-policy": "no-referrer", "set-cookie": `${ACCOUNT_OAUTH_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` } });
  if (c.url.searchParams.get("error")) return back("error=github_cancelled");
  const code = c.url.searchParams.get("code");
  const signedIn = code
    ? await githubSignInFromCode({ clientId: c.config.githubClientId, clientSecret: c.config.githubClientSecret }, code, `${c.base}${CALLBACK_PATH}`, c.fetch, GITHUB_USER_AGENT)
    : undefined;
  if (!signedIn) return back("error=github_failed");
  const email = await githubPrimaryEmail(signedIn.accessToken, c.fetch, GITHUB_USER_AGENT, GITHUB_CHECK_TIMEOUT_MS);
  if (!email) return back("error=github_no_verified_email");
  const handoff = await auth(c).issueAccountHandoff({ pageStateHash: claimed.pageStateHash, githubId: signedIn.user.id, login: signedIn.user.login, email, now: c.now() });
  return back(`signin=${handoff}`);
}

/** POST /web/auth/github/session {code, state, sessionId?} → the session response. */
async function githubSession(c: Ctx): Promise<Response> {
  const retry = await limited(c, `paid:verify:ip:${c.ipNet}`, PAID_LIMITS.verifyIp);
  if (retry !== undefined) return rateLimited(retry);
  const body = (await readJson(c)) ?? {};
  const invalid = () => apiError(400, "invalid_grant", "This sign-in is invalid, used or expired. Sign in with GitHub again.");
  if (typeof body.code !== "string" || !HANDOFF_CODE.test(body.code) || typeof body.state !== "string" || !PAGE_STATE.test(body.state)) return invalid();
  const handoff = await auth(c).claimAccountHandoff({ code: body.code, state: body.state, now: c.now() });
  if (!handoff) return invalid();
  return signIn(c, { kind: "github", subject: String(handoff.githubId), label: handoff.login, email: handoff.email }, body.sessionId);
}

/** POST /web/signout: this web session stops working at once. */
async function signOut(c: Ctx): Promise<Response> {
  const caller = await paidCaller(c);
  if (caller instanceof Response) return caller;
  if (caller.sid) await account(c, caller.account).revokeSessions({ sids: [caller.sid], until: caller.exp * 1000, now: c.now() });
  return json({ signedOut: true });
}

// ─── The account ────────────────────────────────────────────────────────────

function planView(billing: BillingState, now: number) {
  if (billing.tier === null || billing.subscriptionId === null || billing.proState === "none") return null;
  const plan = PLANS[billing.tier];
  const refundEnds = billing.firstPaidAt === null ? null : billing.firstPaidAt + REFUND_DAYS * DAY_MS;
  return {
    id: plan.id,
    name: plan.name,
    priceUsd: plan.priceUsd,
    description: planDescription(plan),
    status: billing.proState,
    periodEnd: billing.periodEnd === null ? null : new Date(billing.periodEnd).toISOString(),
    cancelAtPeriodEnd: billing.cancelAtPeriodEnd,
    paymentFailed: billing.paymentFailed,
    refundableUntil: refundEnds !== null && billing.refundedAt === null && now < refundEnds && billing.proState !== "canceled" ? new Date(refundEnds).toISOString() : null,
  };
}

/** GET /web/account's body (also in every session response). */
async function accountView(c: Ctx, accountNumber: number) {
  const person = account(c, accountNumber);
  const [stored, identities, billing, settings, plan] = await Promise.all([
    directory(c).getPerson(accountNumber),
    directory(c).identities(accountNumber),
    person.billing(),
    person.settings(),
    person.plan(c.now()),
  ]);
  const current = planView(billing, c.now());
  const tier = current && current.status !== "canceled" ? billing.tier : null;
  return {
    accountId: accountIdOf(accountNumber),
    email: stored?.email ?? null,
    identities: identities.map((identity) => (identity.kind === "github" ? { kind: "github", login: identity.label ?? (identity.subject === String(accountNumber) ? (stored?.login ?? null) : null) } : { kind: "email", email: identity.label ?? identity.subject })),
    plan: current,
    legacy: isPaidAccountNumber(accountNumber) || billing.tier !== null ? null : { plan },
    settings,
    // Part B: per-model limits and the GPT-6 launch bonus (docs/web-api-paid.md).
    limits: null,
    gpt6Bonus: null,
    upgrade: PLAN_IDS.filter((id) => tier === null || isUpgrade(tier, id)).map((id) => ({ plan: id, name: PLANS[id].name, priceUsd: PLANS[id].priceUsd })),
  };
}

async function webAccount(c: Ctx): Promise<Response> {
  const caller = await paidCaller(c);
  if (caller instanceof Response) return caller;
  return json(await accountView(c, caller.account));
}

/** POST /web/account/email {email}: a code to the new contact address. */
async function contactEmailStart(c: Ctx): Promise<Response> {
  const caller = await paidCaller(c);
  if (caller instanceof Response) return caller;
  const body = (await readJson(c)) ?? {};
  const checked = await checkedEmail(c, body.email);
  if (checked instanceof Response) return checked;
  if (await directory(c).emailIdentityTaken(checked.email, caller.account)) return apiError(409, "email_in_use", "Another dl.new account signs in with this email.");
  return sendCode(c, checked.email, checked.norm, `change:${caller.account}`, "Confirm your new dl.new email", "Confirm this address for your dl.new account with this code:");
}

/** POST /web/account/email/verify {email, code}: the contact email moves (and Stripe's customer email). */
async function contactEmailVerify(c: Ctx): Promise<Response> {
  const caller = await paidCaller(c);
  if (caller instanceof Response) return caller;
  const body = (await readJson(c)) ?? {};
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!plausibleEmail(email)) return apiError(400, "invalid_email", "Enter an email address we can reach you at.");
  const code = typeof body.code === "string" ? body.code.replace(/\s+/g, "") : "";
  const check = await auth(c).verifyEmailCode({ emailNorm: normalizeEmail(email), purpose: `change:${caller.account}`, code, now: c.now() });
  if (!check.ok) return codeRefusal(check);
  if ((await directory(c).changeContactEmail({ account: caller.account, email, now: c.now() })) === "taken") return apiError(409, "email_in_use", "Another dl.new account signs in with this email.");
  const billing = await account(c, caller.account).billing();
  let stripeUpdated = false;
  if (billing.customerId && c.config.stripe.secretKey) {
    try {
      await stripeRequest(c.fetch, c.config.stripe.secretKey, "POST", `/v1/customers/${billing.customerId}`, { email });
      stripeUpdated = true;
    } catch (error) {
      console.error("paid: Stripe customer email update failed", error instanceof StripeError ? error.status : "error");
    }
  }
  return json({ email, stripeUpdated });
}

async function getSettings(c: Ctx): Promise<Response> {
  const caller = await paidCaller(c);
  if (caller instanceof Response) return caller;
  return json(await account(c, caller.account).settings());
}

/** PUT /web/settings {fallback}. */
async function putSettings(c: Ctx): Promise<Response> {
  const caller = await paidCaller(c);
  if (caller instanceof Response) return caller;
  const body = (await readJson(c)) ?? {};
  if (typeof body.fallback !== "boolean") return apiError(400, "invalid_request", "Send {fallback: true | false}.");
  return json(await account(c, caller.account).setSettings({ fallback: body.fallback }));
}

// ─── API keys ───────────────────────────────────────────────────────────────

function apiKeyView(key: ServerKeyView) {
  return { ...keyView(key), format: key.format, hint: key.format === "dl_sk" ? keyHint(key.hint) : "dlk_…" };
}

async function listApiKeys(c: Ctx): Promise<Response> {
  const caller = await paidCaller(c);
  if (caller instanceof Response) return caller;
  const { config } = await runtime(c);
  const person = account(c, caller.account);
  const keys = (await person.listKeys()).filter((key) => key.kind === "tool");
  const paid = (await person.paidPlan(c.now())) !== null;
  return json({ keys: keys.map(apiKeyView), max: paid ? Math.max(config.toolKeysMax, PAID_KEYS_MAX) : config.toolKeysMax });
}

/** Makes a dl_sk_ key with app.ts's checks; a missing name becomes "key N". */
async function makeApiKey(c: Ctx, accountNumber: number, rawName: unknown, revokeHint: string): Promise<Response> {
  let name = rawName;
  if (name === undefined || name === null || name === "") {
    const count = (await account(c, accountNumber).keyCount("tool")) + 1;
    name = `key ${count}`;
  }
  c.callerId = accountNumber;
  const response = await createKey(c, accountNumber, name, "tool", revokeHint, "dl_sk");
  if (response.status !== 201) return response;
  const made = (await response.json()) as Record<string, unknown> & { key: string };
  return json({ ...made, format: "dl_sk", hint: keyHint(made.key.slice(-4)) }, 201);
}

async function createApiKey(c: Ctx): Promise<Response> {
  const caller = await paidCaller(c);
  if (caller instanceof Response) return caller;
  const body = (await readJson(c)) ?? {};
  return makeApiKey(c, caller.account, body.name, "on dl.new/keys");
}

async function revokeApiKey(c: Ctx, id: string): Promise<Response> {
  const caller = await paidCaller(c);
  if (caller instanceof Response) return caller;
  if (!(await account(c, caller.account).revokeKey(id, "tool"))) return apiError(404, "key_not_found", "No API key with that id on this account.");
  return json({ id, revoked: true });
}

// ─── Billing ────────────────────────────────────────────────────────────────

async function billingPortal(c: Ctx): Promise<Response> {
  const caller = await paidCaller(c);
  if (caller instanceof Response) return caller;
  if (!billingOn(c)) return billingUnavailable();
  const billing = await account(c, caller.account).billing();
  if (!billing.customerId) return apiError(404, "no_billing_account", "There is nothing to manage yet: this account hasn't paid for a plan.");
  try {
    const session = await stripeRequest(c.fetch, c.config.stripe.secretKey!, "POST", "/v1/billing_portal/sessions", { customer: billing.customerId, return_url: `${webOrigin(c)}/billing` });
    if (typeof session.url !== "string") return apiError(502, "billing_error", "Stripe couldn't open the billing portal. Try again in a minute.");
    return json({ url: session.url });
  } catch (error) {
    if (error instanceof StripeError) return apiError(502, "billing_error", "Stripe couldn't open the billing portal. Try again in a minute.");
    throw error;
  }
}

/** POST /web/billing/upgrade {plan}: the subscription moves up now, prorated and invoiced at once. */
async function billingUpgrade(c: Ctx): Promise<Response> {
  const caller = await paidCaller(c);
  if (caller instanceof Response) return caller;
  const body = (await readJson(c)) ?? {};
  if (!isPlanId(body.plan)) return apiError(400, "invalid_plan", 'Send {plan: "plus" | "max"}.');
  const price = planPrice(c, body.plan);
  if (!billingOn(c) || !price) return billingUnavailable();
  const person = account(c, caller.account);
  const billing = await person.billing();
  const current = await person.paidPlan(c.now());
  if (!current || !billing.subscriptionId) return apiError(404, "no_subscription", "This account has no plan to upgrade. Pick one at dl.new.");
  if (!isUpgrade(current, body.plan)) return apiError(400, "not_an_upgrade", `You're on ${PLANS[current].name}. To move to a smaller plan, use Manage billing.`);
  const key = c.config.stripe.secretKey!;
  try {
    const subscription = await stripeRequest(c.fetch, key, "GET", `/v1/subscriptions/${billing.subscriptionId}`);
    const itemId = idOf(subscription.items?.data?.[0]);
    if (!itemId) return apiError(502, "billing_error", "Stripe didn't return the subscription. Try again in a minute.");
    const updated = await stripeRequest(
      c.fetch,
      key,
      "POST",
      `/v1/subscriptions/${billing.subscriptionId}`,
      { items: [{ id: itemId, price }], proration_behavior: "always_invoice", payment_behavior: "error_if_incomplete", metadata: { plan: body.plan } },
      `upgrade-${billing.subscriptionId}-${body.plan}-${Math.floor(c.now() / 60_000)}`,
    );
    await person.setTier(body.plan);
    const due = typeof updated.latest_invoice === "object" && updated.latest_invoice !== null && typeof updated.latest_invoice.amount_paid === "number" ? updated.latest_invoice.amount_paid / 100 : null;
    return json({ plan: body.plan, status: "upgraded", amountDueUsd: due });
  } catch (error) {
    if (error instanceof StripeError && (error.status === 402 || error.code === "card_declined")) return apiError(402, "payment_failed", "Your card was declined, so nothing changed. Update it in Manage billing and try again.");
    if (error instanceof StripeError) return apiError(502, "billing_error", "Stripe couldn't change the plan. Try again in a minute.");
    throw error;
  }
}

/** POST /web/billing/refund-request {reason?}: recorded, and the owner is told. */
async function refundRequest(c: Ctx): Promise<Response> {
  const caller = await paidCaller(c);
  if (caller instanceof Response) return caller;
  const body = (await readJson(c)) ?? {};
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 1000) || null : null;
  const billing = await account(c, caller.account).billing();
  if (!billing.subscriptionId || billing.tier === null) return apiError(404, "no_subscription", "This account has no plan to refund.");
  const deadline = billing.firstPaidAt === null ? null : billing.firstPaidAt + REFUND_DAYS * DAY_MS;
  const eligible = deadline !== null && c.now() <= deadline && billing.refundedAt === null;
  await directory(c).recordRefundRequest({ account: caller.account, reason, eligible, now: c.now() });
  const id = accountIdOf(caller.account);
  await alert(c, [
    {
      subject: `dl.new: refund request from ${caller.email ?? id}${eligible ? "" : " (past 7 days)"}`,
      text: `dl.new: ${caller.email ?? id} (${id}, ${PLANS[billing.tier].name}) asked for a refund.${reason ? `\nReason: ${reason}` : ""}\n${eligible ? "Within the 7 days: refund with POST /admin/paid/refund {\"accountId\": \"" + id + "\"}." : "Past the 7 days: refund only with {\"force\": true}."}`,
    },
  ]);
  return json({ requested: true, eligible, deadline: deadline === null ? null : new Date(deadline).toISOString() });
}

// ─── cli-login ──────────────────────────────────────────────────────────────

/** POST /v1/cli-login/start {tool?, deviceName?}: the CLI's half of a browser sign-in. */
async function cliStart(c: Ctx): Promise<Response> {
  const retry = await limited(c, `paid:cli:ip:${c.ipNet}`, PAID_LIMITS.cliStartIp);
  if (retry !== undefined) return rateLimited(retry);
  const body = (await readJson(c)) ?? {};
  const tool = body.tool === undefined ? "claude-code" : body.tool;
  if (typeof tool !== "string" || !TOOL.test(tool)) return apiError(400, "invalid_request", 'Send {tool?: "claude-code", deviceName?: "<host name>"}.');
  const deviceName = typeof body.deviceName === "string" && DEVICE_NAME.test(body.deviceName.trim()) ? body.deviceName.trim() : null;
  const started = await auth(c).startCliLogin({ tool, deviceName, now: c.now() });
  return json({
    loginId: started.loginId,
    userCode: started.userCode,
    verificationUri: `${webOrigin(c)}/cli-login?code=${started.userCode}`,
    interval: CLI_LOGIN_INTERVAL_S,
    expiresIn: Math.round((started.expiresAt - c.now()) / 1000),
  });
}

/** POST /v1/cli-login/poll {loginId}: pending, or (once) the key. */
async function cliPoll(c: Ctx): Promise<Response> {
  const retry = await limited(c, `paid:clipoll:ip:${c.ipNet}`, PAID_LIMITS.cliPollIp);
  if (retry !== undefined) return rateLimited(retry);
  const body = (await readJson(c)) ?? {};
  if (typeof body.loginId !== "string" || !LOGIN_ID.test(body.loginId)) return apiError(400, "invalid_request", "Send {loginId}.");
  const polled = await auth(c).pollCliLogin({ loginId: body.loginId, now: c.now() });
  switch (polled.status) {
    case "pending":
      return apiError(428, "authorization_pending", "Waiting for you to approve the sign-in in your browser.", { interval: CLI_LOGIN_INTERVAL_S });
    case "slow_down":
      return apiError(429, "slow_down", `Poll every ${CLI_LOGIN_INTERVAL_S} seconds.`, { interval: CLI_LOGIN_INTERVAL_S });
    case "denied":
      return apiError(403, "access_denied", "The sign-in was denied in the browser.");
    case "expired":
      return apiError(410, "expired_token", "This sign-in expired. Run the command again.");
  }
  const toolName = polled.tool === "claude-code" ? "dl claude" : `dl ${polled.tool}`;
  const base = `${toolName}${polled.deviceName ? ` on ${polled.deviceName}` : ""}`.slice(0, 56);
  let made: Response | undefined;
  for (let attempt = 1; attempt <= 5; attempt++) {
    made = await makeApiKey(c, polled.account, attempt === 1 ? base : `${base} (${attempt})`, "on dl.new/keys");
    if (made.status !== 409 || ((await made.clone().json()) as { error?: { code?: string } }).error?.code !== "key_name_taken") break;
  }
  if (!made || made.status !== 201) return made ?? apiError(500, "key_failed", "The key couldn't be made. Run the command again.");
  const key = (await made.json()) as { id: string; key: string };
  const plan = await account(c, polled.account).paidPlan(c.now());
  const apiBase = new URL(c.config.webApiUrl).origin;
  return json({ key: key.key, keyId: key.id, accountId: accountIdOf(polled.account), plan, baseUrl: apiBase, anthropicBaseUrl: `${apiBase}/anthropic` });
}

async function cliView(c: Ctx, raw: string): Promise<Response> {
  const caller = await paidCaller(c);
  if (caller instanceof Response) return caller;
  const userCode = normalizeUserCode(raw);
  const found = userCode ? await auth(c).cliLogin(userCode, c.now()) : undefined;
  if (!found) return apiError(404, "cli_login_not_found", "That code is unknown or expired. Run the command again.");
  return json({ ...found, createdAt: new Date(found.createdAt).toISOString(), expiresAt: new Date(found.expiresAt).toISOString() });
}

/** POST /web/cli-login/:userCode/approve | deny. Approving needs a plan (or an account from before the launch). */
async function cliDecide(c: Ctx, raw: string, approve: boolean): Promise<Response> {
  const caller = await paidCaller(c);
  if (caller instanceof Response) return caller;
  const userCode = normalizeUserCode(raw);
  if (!userCode) return apiError(404, "cli_login_not_found", "That code is unknown or expired. Run the command again.");
  if (approve && isPaidAccountNumber(caller.account) && (await account(c, caller.account).paidPlan(c.now())) === null) {
    return apiError(403, "no_plan", "This account has no active plan. Pick one at dl.new.", { url: `${webOrigin(c)}/` });
  }
  const decided = await auth(c).decideCliLogin({ userCode, account: caller.account, approve, now: c.now() });
  if (decided === "missing" || decided === "expired") return apiError(404, "cli_login_not_found", "That code is unknown or expired. Run the command again.");
  if (decided === "decided") return apiError(409, "cli_login_decided", "This sign-in was already answered.");
  return json({ status: decided });
}

// ─── Usage ──────────────────────────────────────────────────────────────────

/** A request row's client as the usage page names it. */
function toolOf(row: UsageRow & { via_key?: number }): string {
  if (row.harness?.startsWith("tool:")) return row.harness.slice(5) || "other";
  if (row.harness) return row.harness;
  return "autopilot";
}

function tokensOf(row: UsageRow, weight: number) {
  const cached = Math.max(0, row.cached_tokens);
  const fresh = Math.max(0, row.prompt_tokens - cached);
  const output = Math.max(0, row.completion_tokens);
  return { cached, fresh, output, real: cached + fresh + output, counted: Math.round(cached * weight + fresh + output) };
}

interface Sum {
  requests: number;
  cachedInput: number;
  freshInput: number;
  output: number;
  realTokens: number;
  countedTokens: number;
}

function emptySum(): Sum {
  return { requests: 0, cachedInput: 0, freshInput: 0, output: 0, realTokens: 0, countedTokens: 0 };
}

function add(sum: Sum, tokens: ReturnType<typeof tokensOf>): void {
  sum.requests += 1;
  sum.cachedInput += tokens.cached;
  sum.freshInput += tokens.fresh;
  sum.output += tokens.output;
  sum.realTokens += tokens.real;
  sum.countedTokens += Math.round(tokens.counted);
}

function share(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 1000) / 1000 : 0;
}

/** GET /web/usage?week=YYYY-MM-DD: the week's usage from the request log. */
async function usage(c: Ctx): Promise<Response> {
  const caller = await paidCaller(c);
  if (caller instanceof Response) return caller;
  const { config } = await runtime(c);
  const raw = c.url.searchParams.get("week");
  let start = weekStart(c.now());
  if (raw !== null) {
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? Date.parse(`${raw}T00:00:00.000Z`) : Number.NaN;
    if (!Number.isFinite(parsed) || weekStart(parsed) !== parsed || parsed > c.now()) return apiError(400, "invalid_week", "Send ?week= as a Monday (YYYY-MM-DD).");
    start = parsed;
  }
  if (start + WEEK_MS < c.now() - config.rawLogKeepDays * DAY_MS) return apiError(400, "week_unavailable", `Usage is kept ${config.rawLogKeepDays} days.`);
  const end = weekEnd(start);
  const weight = config.cachedTokenWeight;
  const rows = await directory(c).usageRows(caller.account, start, end);
  const totals = emptySum();
  let failovers = 0;
  const models = new Map<string, Sum>();
  const days = new Map<string, Sum>();
  const tools = new Map<string, Sum>();
  for (const row of rows) {
    if (row.upstream_error === 1) {
      failovers += 1;
      continue;
    }
    const tokens = tokensOf(row, weight);
    add(totals, tokens);
    for (const [map, key] of [[models, row.model], [days, isoDay(row.at)], [tools, toolOf(row)]] as const) {
      let sum = map.get(key);
      if (!sum) map.set(key, (sum = emptySum()));
      add(sum, tokens);
    }
  }
  const dayList: Array<{ day: string } & Sum> = [];
  for (let at = start; at < end && at <= c.now(); at += DAY_MS) dayList.push({ day: isoDay(at), ...(days.get(isoDay(at)) ?? emptySum()) });
  const prompt = totals.cachedInput + totals.freshInput;
  return json({
    week: { start: new Date(start).toISOString(), resetsAt: new Date(end).toISOString() },
    totals: {
      ...totals,
      cachedCountedAs: Math.round(totals.cachedInput * weight),
      cachingShare: share(totals.cachedInput, prompt),
      realToCounted: totals.realTokens > 0 ? Math.round((totals.countedTokens / totals.realTokens) * 10_000) / 10_000 : null,
      failovers,
    },
    models: [...models.entries()].map(([model, sum]) => ({ model, ...sum, cachingShare: share(sum.cachedInput, sum.cachedInput + sum.freshInput), limit: null })),
    days: dayList.map(({ day, requests, realTokens, countedTokens }) => ({ day, requests, realTokens, countedTokens })),
    tools: [...tools.entries()].map(([tool, sum]) => ({ tool, requests: sum.requests, realTokens: sum.realTokens, countedTokens: sum.countedTokens })).sort((a, b) => b.countedTokens - a.countedTokens),
    cachedTokenWeight: weight,
  });
}

function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}

/** GET /web/usage/live?after=<id>: the connect page's box, polled every 2 seconds. */
async function usageLive(c: Ctx): Promise<Response> {
  const caller = await paidCaller(c);
  if (caller instanceof Response) return caller;
  const retry = await limited(c, `paid:live:${caller.account}`, PAID_LIMITS.livePerson);
  if (retry !== undefined) return rateLimited(retry);
  const rawAfter = c.url.searchParams.get("after");
  const after = rawAfter === null ? 0 : Number(rawAfter);
  if (!Number.isSafeInteger(after) || after < 0) return apiError(400, "invalid_request", "Send ?after= as the cursor from the last answer.");
  const { config } = await runtime(c);
  const weight = config.cachedTokenWeight;
  const { rows, first } = await directory(c).liveRows(caller.account, after, LIVE_ROWS);
  const requests = rows.map((row) => {
    const tokens = tokensOf(row, weight);
    return {
      id: row.id,
      at: new Date(row.at).toISOString(),
      model: row.model,
      tool: toolOf(row),
      cachedInput: tokens.cached,
      freshInput: tokens.fresh,
      output: tokens.output,
      countedTokens: tokens.counted,
      latencyMs: row.latency_ms,
      status: row.status,
    };
  });
  // "The 2nd request reused cached context, so 18,204 tokens counted as 364.": the first cached one shown.
  let line: string | null = null;
  const ascending = [...rows].reverse();
  const cachedRow = ascending.find((row) => row.cached_tokens > 0);
  if (cachedRow && first) {
    const position = ascending.findIndex((row) => row.id === first.id);
    const index = position >= 0 ? ascending.indexOf(cachedRow) - position + 1 : undefined;
    const cached = cachedRow.cached_tokens;
    line = `${index !== undefined && index > 0 ? `The ${ordinal(index)} request` : "A request"} reused cached context, so ${cached.toLocaleString("en-US")} tokens counted as ${Math.round(cached * weight).toLocaleString("en-US")}.`;
  }
  return json({ connected: first !== undefined, firstRequestAt: first ? new Date(first.at).toISOString() : null, cursor: rows[0]?.id ?? after, requests, line });
}

// ─── Admin ──────────────────────────────────────────────────────────────────

function checkoutAdminView(row: PaidCheckoutRow, now: number) {
  return {
    sessionId: row.session_id,
    plan: row.plan,
    email: row.email,
    customerId: row.customer_id,
    subscriptionId: row.subscription_id,
    amountCents: row.amount_cents,
    paidAt: new Date(row.paid_at).toISOString(),
    claimedBy: row.claimed_by === null ? null : accountIdOf(row.claimed_by),
    claimedAt: row.claimed_at === null ? null : new Date(row.claimed_at).toISOString(),
    claimEmailSentAt: row.claim_email_sent_at === null ? null : new Date(row.claim_email_sent_at).toISOString(),
    expired: row.claimed_by === null && !claimable(row, now, CLAIM_DAYS),
  };
}

/** /admin/paid/*: unclaimed payments, refunds and refund requests. The caller is an admin already. */
export async function paidAdmin(c: Ctx, rest: string, method: string): Promise<Response> {
  if (method === "GET" && rest === "checkouts") {
    const status = c.url.searchParams.get("status") ?? "unclaimed";
    if (status !== "unclaimed" && status !== "claimed" && status !== "all") return apiError(400, "invalid_request", "Use ?status=unclaimed|claimed|all.");
    return json({ checkouts: (await directory(c).paidCheckouts(status)).map((row) => checkoutAdminView(row, c.now())) });
  }
  if (method === "GET" && rest === "refund-requests") {
    return json({
      requests: (await directory(c).refundRequests()).map((row) => ({
        accountId: accountIdOf(row.account),
        email: row.email,
        reason: row.reason,
        at: new Date(row.at).toISOString(),
        eligible: row.eligible === 1,
        refundedAt: row.refunded_at === null ? null : new Date(row.refunded_at).toISOString(),
      })),
    });
  }
  if (method === "POST" && rest === "refund") return adminRefund(c);
  return apiError(404, "not_found", `${method} /admin/paid/${rest} isn't a route.`);
}

/** POST /admin/paid/refund {accountId | sessionId, force?}: the first payment back in full, and the subscription cancelled now. */
async function adminRefund(c: Ctx): Promise<Response> {
  if (!billingOn(c)) return billingUnavailable();
  const body = (await readJson(c)) ?? {};
  const force = body.force === true;
  const dir = directory(c);
  let accountNumber = parseAccountId(body.accountId);
  let row: PaidCheckoutRow | undefined;
  if (accountNumber === undefined) {
    row = typeof body.sessionId === "string" ? await dir.paidCheckout(body.sessionId) : undefined;
    if (!row) return apiError(404, "no_subscription", "Send {accountId} or the {sessionId} of a recorded payment.");
    accountNumber = row.claimed_by ?? undefined;
  }
  const key = c.config.stripe.secretKey!;
  const person = accountNumber === undefined ? undefined : account(c, accountNumber);
  const billing = person ? await person.billing() : undefined;
  if (billing?.refundedAt) return apiError(409, "already_refunded", "This account's first payment was already refunded.");
  const subscriptionId = billing?.subscriptionId ?? row?.subscription_id ?? null;
  if (!subscriptionId) return apiError(404, "no_subscription", "No subscription to refund.");
  const paidAt = billing?.firstPaidAt ?? row?.paid_at ?? (accountNumber !== undefined ? (await dir.firstCheckoutOf(accountNumber))?.paid_at : undefined) ?? null;
  if (!force && (paidAt === null || c.now() > paidAt + REFUND_DAYS * DAY_MS)) {
    return apiError(409, "refund_window_passed", `The first payment is more than ${REFUND_DAYS} days old. Send {"force": true} to refund anyway.`);
  }
  try {
    let invoiceId = billing?.firstInvoiceId ?? null;
    if (!invoiceId) invoiceId = idOf((await stripeRequest(c.fetch, key, "GET", `/v1/subscriptions/${subscriptionId}`)).latest_invoice) ?? null;
    if (!invoiceId) return apiError(404, "no_payment", "Stripe has no invoice for this subscription.");
    const payment = await invoicePayment(c.fetch, key, invoiceId);
    if (!payment) return apiError(404, "no_payment", "Stripe has no payment for the first invoice.");
    const refund = await stripeRequest(c.fetch, key, "POST", "/v1/refunds", { ...payment, reason: "requested_by_customer", metadata: { subscription: subscriptionId, ...(accountNumber !== undefined ? { account_id: accountIdOf(accountNumber) } : {}) } }, `refund-${invoiceId}`);
    await stripeRequest(c.fetch, key, "DELETE", `/v1/subscriptions/${subscriptionId}`);
    if (person && accountNumber !== undefined) {
      await person.markRefunded(c.now());
      await person.applySubscription({ subscriptionId, state: "canceled", periodEnd: null, eventAt: Math.floor(c.now() / 1000) });
      await dir.markRefunded(accountNumber, c.now());
      await dir.mirrorSubscription({ githubId: accountNumber, state: "canceled", periodEnd: null, eventAt: Math.floor(c.now() / 1000) });
    }
    return json({ refunded: true, amountCents: typeof refund.amount === "number" ? refund.amount : null, refundId: refund.id ?? null, subscriptionCanceled: true });
  } catch (error) {
    if (error instanceof StripeError) return apiError(502, "billing_error", `Stripe refused: ${error.message}`);
    throw error;
  }
}

// ─── Webhooks ───────────────────────────────────────────────────────────────

/** Whether an event is about a dl.new plan (its metadata, or one of the plans' prices). */
function isPlanEvent(c: Ctx, event: StripeEvent): boolean {
  const object = event.data.object;
  const prices = Object.values(c.config.stripe.prices ?? {});
  if (event.type === "checkout.session.completed") return object.metadata?.product === "plan";
  if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
    return invoiceSubscription(object).metadata.product === "plan" || invoicePrices(object).some((price) => prices.includes(price));
  }
  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const price = subscriptionPrice(object);
    return object.metadata?.product === "plan" || (price !== undefined && prices.includes(price));
  }
  return false;
}

/** "Finish setting up dl.new": the link back to the account step, for a paid Checkout nobody claimed yet. */
async function sendClaimEmail(c: Ctx, row: PaidCheckoutRow): Promise<void> {
  if (!row.email || !isPlanId(row.plan)) return;
  const transport = userEmailVia(c);
  if (!transport) return;
  if (!(await directory(c).markClaimEmail(row.session_id, c.now()))) return;
  const plan = PLANS[row.plan];
  const link = `${webOrigin(c)}/account?session_id=${row.session_id}`;
  const text = [
    `Thanks for subscribing to ${plan.name} ($${plan.priceUsd}/month): ${planDescription(plan)}`,
    "",
    "Finish setting up dl.new to get your key:",
    link,
    "",
    `The link works for ${CLAIM_DAYS} days. Stripe sends your receipt separately.`,
    `Not for you? Reply within ${REFUND_DAYS} days of your first payment for a full refund.`,
    "",
    "dl.new, by Directionally Local",
  ].join("\n");
  const sent = await sendPlainEmail(transport, c.config, { to: row.email, subject: "Finish setting up dl.new", text, idempotencyKey: `claim-${row.session_id}` });
  if (!sent.ok) console.error("paid: claim email failed", sent.code ?? "error");
}

/**
 * A plan event's handling, or undefined for any other event (app.ts handles those as before).
 * The account is found from the customer, which a claim maps; before the claim there is none, and
 * the claim reads the subscription from Stripe itself.
 */
export async function applyPlanEvent(c: Ctx, event: StripeEvent): Promise<string | undefined> {
  if (!isPlanEvent(c, event)) return undefined;
  const object = event.data.object;
  const dir = directory(c);
  const customerId = idOf(object.customer);
  const owner = customerId ? await dir.customerOwner(customerId) : undefined;
  const prices = c.config.stripe.prices ?? {};
  switch (event.type) {
    case "checkout.session.completed": {
      if (object.payment_status !== "paid") return "plan_unpaid";
      const plan: PlanId | undefined = isPlanId(object.metadata?.plan) ? object.metadata.plan : undefined;
      if (!plan || typeof object.id !== "string") return "ignored";
      const row = await dir.recordPaidCheckout({
        sessionId: object.id,
        plan,
        customerId: customerId ?? null,
        subscriptionId: idOf(object.subscription) ?? null,
        email: typeof object.customer_details?.email === "string" ? object.customer_details.email : null,
        amountCents: typeof object.amount_total === "number" ? object.amount_total : 0,
        paidAt: event.created * 1000,
      });
      if (row.claimed_by !== null) return "plan_claimed";
      await sendClaimEmail(c, row);
      const alerts: Alert[] = [{ subject: `dl.new: someone paid for ${PLANS[plan].name}`, text: `dl.new: ${row.email ?? "someone"} paid $${(row.amount_cents / 100).toFixed(2)} for ${PLANS[plan].name}. Not set up yet (unclaimed payments: GET /admin/paid/checkouts).` }];
      await alert(c, alerts);
      return "plan_unclaimed";
    }
    case "invoice.paid":
    case "invoice.payment_failed": {
      const { subscriptionId } = invoiceSubscription(object);
      if (!subscriptionId) return "ignored";
      if (owner === undefined) return "plan_unclaimed";
      const person = account(c, owner);
      const tier = invoicePrices(object).map((price) => planOfPrice(prices, price)).find((plan): plan is PlanId => plan !== undefined);
      if (event.type === "invoice.payment_failed") {
        await person.applySubscription({ subscriptionId, state: "past_due", periodEnd: undefined, eventAt: event.created, paymentFailed: true });
        return "plan_past_due";
      }
      const end = invoicePeriodEnd(object);
      const applied = await person.applySubscription({ subscriptionId, state: "active", periodEnd: end, eventAt: event.created, paymentFailed: false, ...(tier ? { tier } : {}) });
      if (object.billing_reason === "subscription_create" && typeof object.id === "string") await person.noteFirstPayment({ invoiceId: object.id, at: event.created * 1000 });
      const billed = tier ?? (await person.billing()).tier;
      const paymentAlert = await dir.recordPayment({
        id: String(object.id),
        githubId: owner,
        kind: "pro",
        amountCents: Math.round(Number(object.total_excluding_tax ?? object.subtotal ?? object.amount_paid ?? 0)),
        at: event.created * 1000,
        renewal: object.billing_reason === "subscription_cycle",
        ...(billed ? { product: PLANS[billed].name } : {}),
      });
      if (paymentAlert) await alert(c, [paymentAlert]);
      if (applied) await dir.mirrorSubscription({ githubId: owner, state: "active", periodEnd: end, eventAt: event.created });
      return applied ? "plan_active" : "stale";
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      if (typeof object.id !== "string") return "ignored";
      if (owner === undefined) return "plan_unclaimed";
      const state = event.type === "customer.subscription.deleted" ? "canceled" : planState(object.status);
      const tier = planOfPrice(prices, subscriptionPrice(object));
      const end = periodEnd(object);
      const applied = await account(c, owner).applySubscription({ subscriptionId: object.id, state, periodEnd: end, cancelAtPeriodEnd: object.cancel_at_period_end === true, eventAt: event.created, ...(tier ? { tier } : {}) });
      if (applied) await dir.mirrorSubscription({ githubId: owner, state, periodEnd: end, eventAt: event.created });
      return applied ? `plan_${state}` : "stale";
    }
  }
  return "ignored";
}

