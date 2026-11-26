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
import { randomToken } from "../../shared/src/auth.js";
import { GOOGLE_CALLBACK_PATH, googleAuthorizeUrl, googleSignInFromCode, pkcePair } from "./google.js";
import type { Limit } from "../../shared/src/rate-limit.js";
import {
  account,
  alert,
  trialAccountCheck,
  auth,
  blockedError,
  CALLBACK_PATH,
  createKey,
  directory,
  GITHUB_CHECK_TIMEOUT_MS,
  GITHUB_USER_AGENT,
  ISSUER,
  keyView,
  grantLaunchBonus,
  limited,
  PAID_KEYS_MAX,
  planAccountFor,
  planCatalogFor,
  planUsageFor,
  rateLimited,
  readCookie,
  readJson,
  runtime,
  signingKey,
  userEmail,
  userEmailVia,
  webOrigin,
  type Ctx,
} from "./app.js";
import { accountIdOf, emailHint, isPaidAccountNumber, keyHint, parseAccountId, type IdentityKind } from "./accounts.js";
import type { BillingState, ServerKeyView } from "./account-object.js";
import { emailBlocked, emailDomain, isDisposableDomain, normalizeEmail, plausibleEmail } from "./email-guard.js";
import { apiError, json } from "./errors.js";
import { activePromoCoupon, promoPrice, CLAIM_DAYS, isPlanId, promoView, welcomePromoLine, isUpgrade, PLAN_IDS, PLANS, planDescription, planOfPrice, plansView, checkoutConsentMessage, REFUND_BLOCK_TEXT, refundBlock, refundWindowText, type PlanId } from "./plan-prices.js";
import { approxTokens, planLimits, PLAN_MIX_LABEL, type PlanSettingsConfig } from "./plans.js";
import { BONUS_LINE } from "./gpt6-bonus.js";
import { emailBudgetOf } from "./email-budget.js";
import { claimable, type CheckoutPromo, type PaidCheckoutRow, type UsageRow } from "./paid-store.js";
import { CLI_LOGIN_INTERVAL_S, EMAIL_CODE_RESEND_MS, EMAIL_CODE_TTL_MS } from "./paid-auth.js";
import { normalizeUserCode } from "./codes.js";
import { DEEPSEEK_MODEL } from "./models.js";
import { capacityFull, freePlanOffer, freePlanOn, freePlanView } from "./free-plan.js";
import { endNoCardTrialForPlan, freePlanSignIn, noCardTrialSignIn, parseTrialCheck, startCardTrialOnClaim, trialFromInvoice, trialFromSubscription, trialWillEnd } from "./trial-web.js";
import { trialCountedLimit, trialsOffer, trialView } from "./trials.js";
import { CHECKOUT_SESSION_ID, checkoutPromo, createPlanCheckout, invoiceAmount, isTrialCheckout, promoEligible, subscriptionTrial, isCouponRefusal, idOf, invoicePayment, invoicePeriodEnd, invoicePrices, invoiceSubscription, isTermsConsentRefusal, periodEnd, planState, StripeError, stripeRequest, subscriptionPrice, termsAccepted, type StripeEvent } from "./stripe.js";
import { cancelSubscription } from "./stripe.js";
import { sendPlainEmail } from "./user-email-send.js";
import { newAddressCodeEmail, noAccountWelcomeEmail, type NoAccountOffer } from "./no-account-emails.js";
import { DAY_MS, weekEnd, weekStart, WEEK_MS } from "./week.js";

const HOUR_MS = 3_600_000;
import { METER_KEEP_DAYS } from "./plan-meter.js";

/** A dl.new web session lives this long (the old GitHub one: an hour). */
export const PAID_WEB_SESSION_TTL_S = 7 * 86_400;
const ACCOUNT_OAUTH_COOKIE = "__Host-dl_account_oauth";
/** The pages a dl.new GitHub sign-in may return to (paths on WEB_SIGNUP_URL's origin). */
export const GITHUB_RETURN_PATHS = ["/account", "/signin", "/cli-login", "/trial"] as const;
/** The pages "Continue with Google" may return to: GitHub's but /trial (the no-card trial stays GitHub-only: its anti-farm checks read GitHub). */
export const GOOGLE_RETURN_PATHS = ["/account", "/signin", "/cli-login"] as const;
const GOOGLE_OAUTH_COOKIE = "__Host-dl_google_oauth";
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
  // Sign-in codes without a payment (an account's, or a welcome code to an address with none):
  // the same for every address, so a limit never tells whether an account exists.
  signinAddress: { capacity: 3, perHour: 3 },
  signinAddressDay: { capacity: 10, perHour: 10 / 24 },
  signinIp: { capacity: 10, perHour: 10 },
  // The welcome after a GitHub/Google sign-in with no account: once per address a week, and few per network.
  welcomeAddress: { capacity: 1, perHour: 1 / 168 },
  welcomeIp: { capacity: 10, perHour: 10 },
  verifyIp: { capacity: 60, perHour: 60 },
  githubIp: { capacity: 30, perHour: 30 },
  googleIp: { capacity: 30, perHour: 30 },
  cliStartIp: { capacity: 20, perHour: 20 },
  cliPollIp: { capacity: 120, perHour: 3600 },
  // The connect page polls every 2 seconds (livePerson), on top of its other calls.
  accountPerson: { capacity: 300, perHour: 3600 },
  livePerson: { capacity: 60, perHour: 3600 },
} satisfies Record<string, Limit>;

const NO_ACCOUNT_MESSAGE = "There's no dl.new account for this yet. Pick a plan at dl.new first.";
/** How long a verified sign-in with no account is held (the `pending` token) while its person picks a plan and pays. */
export const PENDING_SIGNIN_TTL_S = 3600;
const PENDING_KINDS: readonly IdentityKind[] = ["github", "google", "email"];

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
  "/web/auth/google/session": { POST: googleSession },
  "/web/auth/pending/session": { POST: pendingSession },
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

/** GET /web/plans: the plan cards (part B's per-model limits, from the runtime settings). */
async function webPlans(c: Ctx): Promise<Response> {
  const [catalog, { config }] = await Promise.all([planCatalogFor(c), runtime(c)]);
  const budgets = await directory(c).trialBudgets(config, c.now());
  // The free trials (trials.ts): `trials.card.available` puts the line on every card; `fullyClaimed` shows "Free trial: fully claimed".
  return json({
    ...plansView({ catalog, available: billingOn(c) && PLAN_IDS.every((plan) => planPrice(c, plan) !== undefined), promo: promoView(config, c.now()) }),
    trials: trialsOffer(config, budgets),
    // dl.new's Free plan (free-plan.ts), only while its switch is on: the plan step's one no-card option.
    ...(freePlanOn(config) ? { freePlan: freePlanOffer(config, capacityFull((await directory(c).freePlanWeek(c.now())).usd, config)) } : {}),
    // Which optional sign-ins are on: the pages show "Continue with Google" only when `google` is true.
    signIn: { google: c.config.google !== undefined },
  });
}

/** /web/usage `freePlan`: this week's Free meter for a Free account with no paid plan, else null. */
async function freePlanUsage(c: Ctx, accountNumber: number, thisWeek: boolean) {
  if (!thisWeek) return null;
  const [{ config }, bars] = await Promise.all([runtime(c), planAccountFor(c, accountNumber)]);
  if (!bars.state.freePlan || bars.state.tier !== "none") return null;
  return freePlanView({ on: freePlanOn(config), counted: bars.state.counted[DEEPSEEK_MODEL] ?? 0, config, now: c.now() });
}

/** A plan's line ("DeepSeek V4.1 Flash ~62M/week (95.5% caching applied). ...") at the live settings. */
function planLine(plan: PlanId, config: PlanSettingsConfig & { cachedTokenWeight: number }): string {
  return planDescription(planLimits(plan, config));
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
  const plan = body.plan;
  const { config } = await runtime(c);
  // The launch offer: inside its window the coupon goes on the Checkout, no code to type.
  let coupon = activePromoCoupon(config, c.now());
  // A card trial (trials.ts) while its budget has room: $0 now, and the offer's coupon goes on the
  // Checkout too (shown there, kept for the first paid invoice) and is recorded as promo_eligible
  // so trial end re-applies it if it's gone.
  const trialOn = (await directory(c).trialBudgets(config, c.now())).card.available;
  const trial = trialOn
    ? { days: config.cardTrialDays, ...(coupon ? { promoEligible: coupon, offerText: trialOfferText(PLANS[plan].priceUsd, config.promoPercentOff, config.cardTrialTokens, config.cardTrialDays) } : {}) }
    : undefined;
  const create = (termsConsent: string | undefined, withCoupon: string | undefined) =>
    createPlanCheckout(c.fetch, {
      secretKey: c.config.stripe.secretKey!,
      plan,
      price,
      successUrl: `${site}/account?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${site}/?plan=${plan}`,
      ...(campaign ? { campaign } : {}),
      ...(termsConsent ? { termsConsent } : {}),
      ...(withCoupon ? { coupon: withCoupon } : {}),
      ...(trial ? { trial } : {}),
      idempotencyKey: crypto.randomUUID(),
    });
  const start = async (termsConsent: string | undefined) => {
    if (!coupon) return create(termsConsent, undefined);
    try {
      return await create(termsConsent, coupon);
    } catch (error) {
      if (!isCouponRefusal(error) || isTermsConsentRefusal(error)) throw error;
      // Stripe doesn't know the coupon (not created yet, expired, used up): never fail the checkout
      // for it. The offer turns off (so no page shows a discount Checkout won't apply), logged, and
      // the owner is told how to turn it back on.
      const refused = coupon;
      coupon = undefined;
      await promoRefused(c, refused, error);
      return create(termsConsent, undefined);
    }
  };
  try {
    let session: { id: string; url: string };
    if (!config.checkoutTermsConsent) session = await start(undefined);
    else {
      try {
        session = await start(checkoutConsentMessage(`${site}/terms`));
      } catch (error) {
        if (!isTermsConsentRefusal(error)) throw error;
        // No terms URL in the Stripe account's public details: never fail the checkout for it.
        // Consent collection turns off (the setting, logged) until the owner sets the URL and turns it back on.
        console.warn("paid: Stripe refused the terms consent at Checkout; checkoutTermsConsent turned off", error instanceof Error ? error.message : "");
        await directory(c).updateOverrides([{ key: "checkoutTermsConsent", value: false }], { githubId: 0, login: "auto: Stripe refused terms consent (set a terms URL in Stripe's public details)", now: c.now() });
        await alert(c, [{ subject: "dl.new: Checkout terms consent turned off", text: `Stripe refused the terms-of-service consent on the plan Checkout: ${error instanceof Error ? error.message : "error"}\nSet a terms URL in the Stripe Dashboard (Settings > Public details), then POST /admin/config {"checkoutTermsConsent": true}.` }]);
        session = await start(undefined);
      }
    }
    return json({ url: session.url, sessionId: session.id, trial: trial !== undefined });
  } catch (error) {
    if (error instanceof StripeError) return apiError(502, "billing_error", "Stripe couldn't start the checkout. Try again in a minute.");
    throw error;
  }
}

/**
 * The launch offer's line on a card trial's Checkout (above the button): Stripe shows the discounted
 * month after the trial; this says when that is. Well under Stripe's 1,200.
 */
export function trialOfferText(priceUsd: number, percentOff: number, trialTokens: number, trialDays: number): string {
  const tokens = trialTokens >= 1_000_000 ? `${Math.round(trialTokens / 100_000) / 10}M` : trialTokens.toLocaleString("en-US");
  return `Launch offer: your first paid month is ${percentOff}% off (${usd(promoPrice(priceUsd, percentOff))} instead of ${usd(priceUsd)}). It's applied when your free ${tokens} tokens are used or after ${trialDays} days.`;
}

function usd(amount: number): string {
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}

/** Stripe refused the launch offer's coupon: promoCouponId turns off ("none", logged) and the owner gets an alert. */
async function promoRefused(c: Ctx, coupon: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : "error";
  console.warn("paid: Stripe refused the launch offer's coupon; promoCouponId turned off", message);
  await directory(c).updateOverrides([{ key: "promoCouponId", value: null }], { githubId: 0, login: `auto: Stripe refused coupon ${coupon}`, now: c.now() });
  await alert(c, [
    {
      subject: "dl.new: launch offer turned off (Stripe refused the coupon)",
      text: `Stripe refused the coupon "${coupon}" on a plan Checkout: ${message}\nThat checkout went ahead at full price, and the offer is off now (the plan page no longer shows it).\nCreate the coupon in Stripe (Product catalog > Coupons, ID ${coupon}, 50% off, duration once), then POST /admin/config {"promoCouponId": "${coupon}"}.`,
    },
  ]);
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
  /** When the terms with the withdrawal waiver were accepted (the payment's time), or null without that consent. */
  termsAcceptedAt: number | null;
  /** The launch offer's discount on the first payment, or null. */
  promo: CheckoutPromo | null;
  /** A card trial (trials.ts): nothing paid yet; the coupon the first real charge gets, if any. */
  trial: { promoEligible: string | undefined } | null;
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
  // A card trial completes with nothing to pay (payment_status no_payment_required, the card saved).
  const trialCheckout = isTrialCheckout(session);
  if (session.status !== "complete" || (session.payment_status !== "paid" && !trialCheckout)) return apiError(402, "checkout_unpaid", "This checkout wasn't paid. Pick a plan at dl.new to try again.");
  const subscription = session.subscription && typeof session.subscription === "object" ? (session.subscription as Record<string, any>) : null;
  const plan = planOfPrice(c.config.stripe.prices ?? {}, subscription ? subscriptionPrice(subscription) : undefined) ?? (isPlanId(session.metadata?.plan) ? session.metadata.plan : undefined);
  if (!plan) return apiError(404, "checkout_not_found", "We couldn't find that payment. Start again at dl.new.");
  const row = await directory(c).paidCheckout(sessionId);
  const paidAt = typeof session.created === "number" ? session.created * 1000 : c.now();
  if ((row?.claimed_by ?? null) === null && !claimable({ paid_at: paidAt }, c.now(), CLAIM_DAYS)) {
    // Nobody can claim it any more: its subscription must not renew (the owner decides on a refund).
    const subscriptionId = idOf(session.subscription);
    if (subscriptionId) await cancelOrphan(c, { subscriptionId, sessionId, reason: "unclaimed", email: session.customer_details?.email ?? null, refundInvoice: null });
    return apiError(410, "checkout_expired", `This payment is more than ${CLAIM_DAYS} days old and wasn't set up, so its subscription is cancelled and won't renew. Write to contact@directionallylocal.com and we'll sort it out.`);
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
    termsAcceptedAt: termsAccepted(session) ? paidAt : null,
    promo: checkoutPromo(session),
    trial: trialCheckout ? { promoEligible: promoEligible(session) } : null,
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
    trial: verified.trial !== null,
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
    // A second plan on an account that has one: its subscription is cancelled now and its payment refunded.
    const done = checkout.subscriptionId
      ? await cancelOrphan(c, { subscriptionId: checkout.subscriptionId, sessionId: checkout.sessionId, reason: "duplicate", email: checkout.email, account: accountNumber, refundInvoice: checkout.amountCents > 0 ? (idOf(checkout.subscription?.latest_invoice) ?? null) : null })
      : undefined;
    if (done?.ended) {
      const refunded = done.refundedCents !== null ? " and refunded its payment (it shows on your card in 5 to 10 days)" : "";
      return apiError(409, "already_subscribed", `This account already has a plan, so we cancelled the second subscription${refunded}. Manage your plan at dl.new/billing.`);
    }
    return apiError(409, "already_subscribed", "This account already has a plan. Manage it at dl.new/billing; write to contact@directionallylocal.com about the second payment and we'll refund it.");
  }
  const dir = directory(c);
  await dir.recordPaidCheckout({ sessionId: checkout.sessionId, plan: checkout.plan, customerId: checkout.customerId, subscriptionId: checkout.subscriptionId, email: checkout.email, amountCents: checkout.amountCents, paidAt: checkout.paidAt, termsAcceptedAt: checkout.termsAcceptedAt, promo: checkout.promo, ...(checkout.trial ? { trial: true, promoEligible: checkout.trial.promoEligible ?? null } : {}) });
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
      ...(subscription ? { trial: subscriptionTrial(subscription) } : checkout.trial ? { trial: { trialing: true, trialEnd: null } } : {}),
    });
    await dir.mirrorSubscription({ githubId: accountNumber, state, periodEnd: end, eventAt: Math.floor(c.now() / 1000) });
    const invoiceId = idOf(subscription?.latest_invoice);
    // A card trial: nothing was paid (the $0 trial invoice is no payment); the trial's meter starts.
    const trialing = checkout.trial !== null && (subscription === null || subscription.status === "trialing");
    if (trialing) {
      await startCardTrialOnClaim(c, accountNumber, { plan: checkout.plan, subscriptionId: checkout.subscriptionId, subscription, startedAt: checkout.paidAt, ...(checkout.trial?.promoEligible ? { promoEligible: checkout.trial.promoEligible } : {}) });
    } else await endNoCardTrialForPlan(c, accountNumber);
    if (invoiceId && !trialing && checkout.amountCents > 0) {
      await person.noteFirstPayment({ invoiceId, at: checkout.paidAt });
      // Recorded for the revenue numbers; the owner was emailed at Checkout (owner-payment-alerts.ts).
      await dir.recordPayment({ id: invoiceId, githubId: accountNumber, kind: "pro", amountCents: checkout.amountCents, at: checkout.paidAt, product: PLANS[checkout.plan].name });
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
  // A trial's welcome went out with it (trial-web.ts); a plan's (once per payment): where the key is, the plan's limits, the bonus.
  if (checkout.trial !== null) return { plan: checkout.plan, sessionId: checkout.sessionId };
  const welcome = sendPlanWelcome(c, accountNumber, checkout.plan, checkout.sessionId, checkout.promo).catch((error) => console.error("paid: welcome failed", error instanceof Error ? error.message : "error"));
  if (c.background) c.background(welcome);
  else await welcome;
  return { plan: checkout.plan, sessionId: checkout.sessionId };
}

/**
 * Ends a plan subscription nobody can use: a second payment onto an account that has a plan
 * ("duplicate"), a Checkout whose claim window lapsed ("unclaimed"), or money taken on one later
 * ("renewal"). Cancels it now and, with
 * `refundInvoice`, refunds that invoice's payment in full; then tells the owner. Safe to repeat:
 * an ended subscription is left alone (no second refund or alert). A refund Stripe refuses
 * doesn't stop the cancel (the owner's alert says so).
 * Never throws; undefined when Stripe failed (the owner is told, the caller answers as before).
 */
async function cancelOrphan(
  c: Ctx,
  input: { subscriptionId: string; sessionId: string | null; reason: "duplicate" | "unclaimed" | "renewal"; email: string | null; account?: number; refundInvoice: string | null },
): Promise<{ ended: boolean; refundedCents: number | null } | undefined> {
  const key = c.config.stripe.secretKey;
  if (!key) return undefined;
  const what =
    input.reason === "duplicate"
      ? `a second plan payment onto ${input.account !== undefined ? accountIdOf(input.account) : "an account"}, which already has a plan`
      : input.reason === "unclaimed"
        ? `a plan Checkout nobody set up within ${CLAIM_DAYS} days`
        : `a renewal of a plan Checkout nobody set up within ${CLAIM_DAYS} days`;
  const ids = `Customer: ${input.email ?? "unknown"}\nStripe: subscription ${input.subscriptionId}${input.sessionId ? `, checkout ${input.sessionId}` : ""}${input.refundInvoice ? `, invoice ${input.refundInvoice}` : ""}`;
  let refundedCents: number | null = null;
  let refundError: string | null = null;
  try {
    const path = `/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`;
    const current = await stripeRequest(c.fetch, key, "GET", path);
    // Ended already (this ran before, or it was cancelled in Stripe): nothing more to do.
    if (current.status === "canceled" || current.status === "incomplete_expired") return { ended: true, refundedCents: null };
    if (input.refundInvoice) {
      try {
        const payment = await invoicePayment(c.fetch, key, input.refundInvoice);
        if (payment) {
          const refund = await stripeRequest(c.fetch, key, "POST", "/v1/refunds", { ...payment, ...(input.reason === "duplicate" ? { reason: "duplicate" } : {}), metadata: { subscription: input.subscriptionId, dl_reason: input.reason } }, `orphan-refund-${input.refundInvoice}`);
          refundedCents = typeof refund.amount === "number" ? refund.amount : 0;
        } else refundError = "Stripe has no payment for the invoice";
      } catch (error) {
        // Already refunded (a repeat), or Stripe refused: the cancel still goes ahead.
        refundError = error instanceof Error ? error.message : "error";
      }
    }
    await stripeRequest(c.fetch, key, "DELETE", path);
    await alert(c, [
      {
        subject: `dl.new: orphaned plan subscription cancelled (${input.reason})`,
        text: [
          `Cancelled ${input.subscriptionId}: ${what}.`,
          refundedCents !== null ? `Refunded ${usd(refundedCents / 100)} (invoice ${input.refundInvoice}).` : input.refundInvoice ? `Not refunded: ${refundError ?? "no payment"}. Refund it in the Stripe Dashboard.` : `Not refunded. To refund the first payment: POST /admin/paid/refund {${input.sessionId ? `"sessionId": "${input.sessionId}", ` : ""}"force": true}.`,
          ids,
        ].join("\n"),
      },
    ]);
    return { ended: true, refundedCents };
  } catch (error) {
    const message = error instanceof Error ? error.message : "error";
    console.error("paid: cancelling an orphaned subscription failed", error instanceof StripeError ? error.status : "error");
    await alert(c, [{ subject: `dl.new: couldn't cancel an orphaned plan subscription (${input.reason})`, text: `Stripe refused to cancel ${input.subscriptionId} (${what}): ${message}\nCancel it in the Stripe Dashboard${input.refundInvoice && refundedCents === null ? " and refund its payment" : ""}; it is on its own Stripe customer, so the billing portal can't reach it.\n${ids}` }]);
    return undefined;
  }
}

/**
 * welcome_paid (user-emails.ts) after a claim: the plan's per-model weekly limits, each "(95.5%
 * caching applied)", and the GPT-6 launch bonus line when the account holds it (granted here,
 * right away, when it is on and there is room). Once per payment (the period is the session id).
 */
async function sendPlanWelcome(c: Ctx, accountNumber: number, plan: PlanId, sessionId: string, promo: CheckoutPromo | null): Promise<void> {
  const { config } = await runtime(c);
  const granted = await grantLaunchBonus(c, accountNumber);
  // The launch offer: the percent Stripe actually took off the first month (the setting's when Stripe gave no subtotal).
  const percentOff = promo ? promo.percentOff || config.promoPercentOff : null;
  await userEmail(c, config, "welcome_paid", accountNumber, sessionId, { planWelcome: welcomeValues(plan, config, granted, percentOff) });
}

/** welcome_paid's {plan}, {promo}, {limits} and {bonus} (no refund line: refunds are the owner's call, never promised). */
export function welcomeValues(plan: PlanId, config: PlanSettingsConfig & { cachedTokenWeight: number }, bonus: boolean, promoPercentOff: number | null = null) {
  return {
    /** " Your first month was 50% off. It renews at $7/mo." when the first payment had the launch offer, else "". */
    promo: welcomePromoLine(plan, promoPercentOff),
    plan: PLANS[plan].name,
    limits: planLimits(plan, config)
      .map((limit) => `- ${limit.name} ${approxTokens(limit.realTokens)}/week (${PLAN_MIX_LABEL})`)
      .join("\n"),
    bonus: bonus ? `\nplus ${BONUS_LINE}, launch bonus through 31 Jan 2027.\n` : "",
  };
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
  /** The address as typed, the GitHub login, or the Google account's email. */
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
    if (!checkout) return noAccount(c, identity);
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

/**
 * 403 no_account for a verified identity with no account and no payment. It carries `pending`: a
 * signed "pending" token (an hour) holding that identity, so the page can send its person to pick
 * a plan and, after Checkout, finish the account step with POST /web/auth/pending/session instead
 * of signing in again. The token is no web session (paidCaller wants typ "web") and works only
 * with a paid Checkout.
 */
async function noAccount(c: Ctx, identity: SignInIdentity): Promise<Response> {
  if (identity.kind === "github" || identity.kind === "google") {
    const welcome = sendNoAccountWelcome(c, identity.kind, identity.email).catch(() => undefined);
    if (c.background) c.background(welcome);
    else await welcome;
  }
  const iat = Math.floor(c.now() / 1000);
  const token = await signJwt(
    { iss: ISSUER, typ: "pending", sub: `${identity.kind}:${identity.subject}`, kind: identity.kind, subject: identity.subject, label: identity.label, email: identity.email, iat, exp: iat + PENDING_SIGNIN_TTL_S, jti: crypto.randomUUID() },
    await signingKey(c.config),
  );
  return apiError(403, "no_account", NO_ACCOUNT_MESSAGE, { pending: { token, email: identity.email, expiresIn: PENDING_SIGNIN_TTL_S } });
}

/** What the no-account emails offer: the site, Starter's price, and the card trial while it's open. */
async function noAccountOffer(c: Ctx): Promise<NoAccountOffer> {
  const { config } = await runtime(c);
  const card = (await directory(c).trialBudgets(config, c.now())).card;
  return { site: webOrigin(c), trialTokens: card.available ? config.cardTrialTokens : null };
}

/**
 * The welcome after a GitHub or Google sign-in found no account (no-account-emails.ts): at most
 * once per address per 7 days and a few per network an hour, from the transactional budget,
 * through the same transport as codes. Never throws; the HTTP answer never says whether it went.
 */
async function sendNoAccountWelcome(c: Ctx, via: "github" | "google", email: string): Promise<void> {
  if (!plausibleEmail(email)) return;
  const norm = normalizeEmail(email);
  const { config } = await runtime(c);
  if (isDisposableDomain(emailDomain(norm)) || emailBlocked(norm, config.blockedEmails)) return;
  const transport = userEmailVia(c);
  if (!transport) return;
  if ((await limited(c, `paid:welcome:ip:${c.ipNet}`, PAID_LIMITS.welcomeIp)) !== undefined) return;
  if ((await limited(c, `paid:welcome:addr:${norm}`, PAID_LIMITS.welcomeAddress)) !== undefined) return;
  if (!(await directory(c).takeEmailBudget({ emailClass: "transactional", now: c.now(), budget: emailBudgetOf(config) }))) return;
  const message = noAccountWelcomeEmail({ ...(await noAccountOffer(c)), via });
  await sendPlainEmail(transport, c.config, { to: email, ...message, idempotencyKey: `welcome-no-account-${norm}-${Math.floor(c.now() / (7 * DAY_MS))}` });
}

/**
 * POST /web/auth/pending/session {token, sessionId} → the session response: the sign-in a
 * no_account answer held (`pending.token`), finished with a paid Checkout (makes the account and
 * claims it, as signIn does with a sessionId). Without a sessionId it is refused: the token never
 * signs anyone in by itself.
 */
async function pendingSession(c: Ctx): Promise<Response> {
  const retry = await limited(c, `paid:verify:ip:${c.ipNet}`, PAID_LIMITS.verifyIp);
  if (retry !== undefined) return rateLimited(retry);
  const body = (await readJson(c)) ?? {};
  const invalid = () => apiError(400, "invalid_grant", "This sign-in expired. Sign in again.");
  if (typeof body.token !== "string" || body.token.length > 4096) return invalid();
  const claims = await verifyJwt(body.token, await signingKey(c.config), Math.floor(c.now() / 1000), 0);
  if (!claims || claims.typ !== "pending" || claims.iss !== ISSUER) return invalid();
  const { kind, subject, label, email } = claims;
  if (!PENDING_KINDS.includes(kind as IdentityKind) || typeof subject !== "string" || !subject || typeof label !== "string" || typeof email !== "string" || claims.sub !== `${kind}:${subject}`) return invalid();
  if (typeof body.sessionId !== "string" || !body.sessionId) return apiError(400, "checkout_required", "Pick a plan at dl.new first.");
  if (kind === "google") {
    if (!c.config.google) return invalid();
    await directory(c).resolveGoogleIdentity({ subject, email, now: c.now() });
  }
  return signIn(c, { kind: kind as IdentityKind, subject, label, email }, body.sessionId);
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

type CodeEmail = (code: string) => { subject: string; text: string } | Promise<{ subject: string; text: string }>;

/** The plain code email: `intro`, the code, how long it works. */
function plainCodeEmail(subject: string, intro: string): CodeEmail {
  return (code) => ({ subject, text: `${intro}\n\n    ${code}\n\nIt works for ${EMAIL_CODE_TTL_MS / 60_000} minutes. If you didn't ask for it, ignore this email.\n\ndl.new` });
}

/**
 * Sends a 6-digit code to an address for a purpose, with the rate limits and the 30-second
 * resend. `extra` adds limits: `ip` ones before the code is made, `address` ones after (a
 * refusal drops the code), like the built-in ones.
 */
async function sendCode(c: Ctx, email: string, norm: string, purpose: string, compose: CodeEmail, extra: { ip?: Array<[string, Limit]>; address?: Array<[string, Limit]> } = {}): Promise<Response> {
  const ipRetry = await limited(c, `paid:email:ip:${c.ipNet}`, PAID_LIMITS.emailIp);
  if (ipRetry !== undefined) return rateLimited(ipRetry);
  for (const [key, limit] of extra.ip ?? []) {
    const retry = await limited(c, key, limit);
    if (retry !== undefined) return rateLimited(retry);
  }
  const transport = userEmailVia(c);
  if (!transport) return apiError(503, "email_unavailable", "We can't send email right now. Try GitHub, or again in a few minutes.");
  const issued = await auth(c).issueEmailCode({ emailNorm: norm, purpose, now: c.now() });
  if (!issued.ok) return apiError(429, "resend_too_soon", `Wait ${issued.retryAfter} seconds before asking for another code.`, { retryAfter: issued.retryAfter }, { "retry-after": String(issued.retryAfter) });
  for (const [key, limit] of [[`paid:email:addr:${norm}`, PAID_LIMITS.emailAddress] as [string, Limit], ...(extra.address ?? [])]) {
    const addressRetry = await limited(c, key, limit);
    if (addressRetry !== undefined) {
      await auth(c).dropEmailCode(norm, purpose);
      return rateLimited(addressRetry);
    }
  }
  // Codes never wait for the daily email cap, only for their own hard ceiling (email-budget.ts).
  const { config } = await runtime(c);
  if (!(await directory(c).takeEmailBudget({ emailClass: "code", now: c.now(), budget: emailBudgetOf(config) }))) {
    await auth(c).dropEmailCode(norm, purpose);
    return apiError(503, "email_unavailable", "We can't send more codes today. Try GitHub, or again tomorrow.");
  }
  const sent = await sendPlainEmail(transport, c.config, {
    to: email,
    ...(await compose(issued.code)),
    idempotencyKey: `code-${purpose}-${norm}-${c.now()}`,
  });
  if (!sent.ok) {
    await auth(c).dropEmailCode(norm, purpose);
    return apiError(502, "email_failed", "The email didn't go out. Try again in a minute, or use GitHub.");
  }
  return json({ sent: true, resendAfter: EMAIL_CODE_RESEND_MS / 1000, expiresIn: EMAIL_CODE_TTL_MS / 1000 });
}

/**
 * POST /web/auth/email/start {email, sessionId?}: a sign-up or sign-in code. Without a payment,
 * an address with no account gets the code too, in a short welcome (no-account-emails.ts):
 * entering it answers 403 no_account with a `pending` token, as GitHub and Google do. The answer
 * and the limits are the same whether the address has an account or not.
 */
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
  } else {
    const known = (await directory(c).resolveIdentity("email", checked.norm, c.now())) !== undefined;
    const compose: CodeEmail = known
      ? plainCodeEmail("Your dl.new code", "Your dl.new sign-in code:")
      : async (code) => newAddressCodeEmail({ ...(await noAccountOffer(c)), code, minutes: EMAIL_CODE_TTL_MS / 60_000 });
    return sendCode(c, checked.email, checked.norm, "signin", compose, {
      ip: [[`paid:signin:ip:${c.ipNet}`, PAID_LIMITS.signinIp]],
      address: [
        [`paid:signin:addr:${checked.norm}`, PAID_LIMITS.signinAddress],
        [`paid:signin:addr-day:${checked.norm}`, PAID_LIMITS.signinAddressDay],
      ],
    });
  }
  return sendCode(c, checked.email, checked.norm, "signin", plainCodeEmail("Your dl.new code", "Your dl.new sign-in code:"));
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
  // dl.new/trial, and any GitHub sign-in with no account while the Free plan is on (free-plan.ts):
  // the free tier's account check, read now while the GitHub token is at hand.
  const forTrial = new URL(claimed.returnUrl).pathname === "/trial";
  const forFree = !forTrial && freePlanOn((await runtime(c)).config) && (await directory(c).resolveIdentity("github", String(signedIn.user.id), c.now())) === undefined;
  const details = forTrial || forFree ? JSON.stringify({ trial: true, ...(await trialAccountCheck(c, signedIn.user, signedIn.accessToken)) }) : null;
  const handoff = await auth(c).issueAccountHandoff({ pageStateHash: claimed.pageStateHash, githubId: signedIn.user.id, login: signedIn.user.login, email, details, now: c.now() });
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
  // The Free plan (free-plan.ts), while it is on: a GitHub sign-in with no account and no payment
  // makes a Free account instead of the pending "pick a plan" sign-in (and instead of the no-card
  // trial on dl.new/trial: one no-card option). Refused there, dl.new/trial says why; the other
  // pages hold the sign-in for a plan as before.
  if (!body.sessionId && freePlanOn((await runtime(c)).config) && (await directory(c).resolveIdentity("github", String(handoff.githubId), c.now())) === undefined) {
    const identity = { githubId: handoff.githubId, login: handoff.login, email: handoff.email, check: parseTrialCheck(handoff.details) };
    const started = await freePlanSignIn(c, identity);
    if (started instanceof Response) {
      if (body.trial === true) return started;
      return signIn(c, { kind: "github", subject: String(handoff.githubId), label: handoff.login, email: handoff.email }, body.sessionId);
    }
    const person = await directory(c).getPerson(started.account);
    if (!person) return apiError(403, "no_account", NO_ACCOUNT_MESSAGE);
    if (person.status === "blocked") return blockedError();
    const session = await issueWebSession(c, started.account, person.login);
    return json({ ...session, account: await accountView(c, started.account), created: started.created, claimed: null, freePlanStarted: started.created });
  }
  // dl.new/trial: the no-card trial (trial-web.ts). A GitHub account with an account already signs in as usual.
  if (body.trial === true && !body.sessionId) {
    const started = await noCardTrialSignIn(c, { githubId: handoff.githubId, login: handoff.login, email: handoff.email, check: parseTrialCheck(handoff.details) });
    if (started instanceof Response) return started;
    const person = await directory(c).getPerson(started.account);
    if (!person) return apiError(403, "no_account", NO_ACCOUNT_MESSAGE);
    if (person.status === "blocked") return blockedError();
    const session = await issueWebSession(c, started.account, person.login);
    return json({ ...session, account: await accountView(c, started.account), created: started.created, claimed: null, trialStarted: started.created });
  }
  return signIn(c, { kind: "github", subject: String(handoff.githubId), label: handoff.login, email: handoff.email }, body.sessionId);
}

// ─── Continue with Google (google.ts) ────────────────────────────────────────

/** GET /web/auth/google?return=&state=: dl.new's Google sign-in (OIDC, PKCE). app.ts 404s it while Google is off. */
export async function googleStart(c: Ctx): Promise<Response> {
  const google = c.config.google!;
  const site = webOrigin(c);
  const returnUrl = c.url.searchParams.get("return") ?? "";
  const allowed = GOOGLE_RETURN_PATHS.map((path) => `${site}${path}`);
  const state = c.url.searchParams.get("state") ?? "";
  if (!allowed.includes(returnUrl) || !PAGE_STATE.test(state)) return new Response("This sign-in link isn't valid. Start again at dl.new.", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
  const retry = await limited(c, `paid:google:ip:${c.ipNet}`, PAID_LIMITS.googleIp);
  if (retry !== undefined) return new Response(null, { status: 303, headers: { location: `${returnUrl}#error=rate_limited`, "cache-control": "no-store" } });
  const pkce = await pkcePair();
  const nonce = randomToken(16);
  const begun = await auth(c).beginGoogleOAuth({ returnUrl, pageState: state, verifier: pkce.verifier, nonce, now: c.now() });
  return new Response(null, {
    status: 302,
    headers: {
      location: googleAuthorizeUrl({ clientId: google.clientId, redirectUri: `${c.base}${GOOGLE_CALLBACK_PATH}`, state: begun.state, nonce, challenge: pkce.challenge }),
      "set-cookie": `${GOOGLE_OAUTH_COOKIE}=${begun.browser}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

/** GET /web/auth/google/callback: Google's redirect. Back to the page with a one-time code (or #error=). */
export async function googleCallback(c: Ctx): Promise<Response> {
  const google = c.config.google!;
  const state = c.url.searchParams.get("state") ?? "";
  const browser = readCookie(c.request, GOOGLE_OAUTH_COOKIE);
  const claimed = browser ? await auth(c).claimGoogleOAuth({ state, browser, now: c.now() }) : undefined;
  if (!claimed) return new Response(null, { status: 303, headers: { location: `${webOrigin(c)}/signin#error=expired`, "cache-control": "no-store" } });
  const back = (fragment: string) =>
    new Response(null, { status: 303, headers: { location: `${claimed.returnUrl}#${fragment}`, "cache-control": "no-store", "referrer-policy": "no-referrer", "set-cookie": `${GOOGLE_OAUTH_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` } });
  if (c.url.searchParams.get("error")) return back("error=google_cancelled");
  const code = c.url.searchParams.get("code");
  if (!code) return back("error=google_failed");
  const signedIn = await googleSignInFromCode(google, { code, verifier: claimed.verifier, redirectUri: `${c.base}${GOOGLE_CALLBACK_PATH}`, nonce: claimed.nonce, nowMs: c.now() }, c.fetch);
  if (signedIn === "unverified_email") return back("error=google_no_verified_email");
  if (!signedIn) return back("error=google_failed");
  const handoff = await auth(c).issueGoogleHandoff({ pageStateHash: claimed.pageStateHash, subject: signedIn.sub, email: signedIn.email, now: c.now() });
  return back(`signin=${handoff}`);
}

/**
 * POST /web/auth/google/session {code, state, sessionId?} → the session response. The account:
 * this Google account's, else the one that signs in with the same address by email code (linked
 * now), else a new one only with a paid Checkout (`sessionId`), as for email and GitHub. No
 * no-card trial: that stays GitHub-only.
 */
async function googleSession(c: Ctx): Promise<Response> {
  if (!c.config.google) return apiError(404, "not_found", "Google sign-in isn't on.");
  const retry = await limited(c, `paid:verify:ip:${c.ipNet}`, PAID_LIMITS.verifyIp);
  if (retry !== undefined) return rateLimited(retry);
  const body = (await readJson(c)) ?? {};
  const invalid = () => apiError(400, "invalid_grant", "This sign-in is invalid, used or expired. Continue with Google again.");
  if (typeof body.code !== "string" || !HANDOFF_CODE.test(body.code) || typeof body.state !== "string" || !PAGE_STATE.test(body.state)) return invalid();
  const handoff = await auth(c).claimGoogleHandoff({ code: body.code, state: body.state, now: c.now() });
  if (!handoff) return invalid();
  await directory(c).resolveGoogleIdentity({ subject: handoff.subject, email: handoff.email, now: c.now() });
  return signIn(c, { kind: "google", subject: handoff.subject, label: handoff.email, email: handoff.email }, body.sessionId);
}

/** POST /web/signout: this web session stops working at once. */
async function signOut(c: Ctx): Promise<Response> {
  const caller = await paidCaller(c);
  if (caller instanceof Response) return caller;
  if (caller.sid) await account(c, caller.account).revokeSessions({ sids: [caller.sid], until: caller.exp * 1000, now: c.now() });
  return json({ signedOut: true });
}

// ─── The account ────────────────────────────────────────────────────────────

/** The account's plan (no refund fields: refunds aren't offered on the page; the owner refunds by hand). */
function planView(billing: BillingState, config: PlanSettingsConfig & { cachedTokenWeight: number }) {
  if (billing.tier === null || billing.subscriptionId === null || billing.proState === "none") return null;
  const plan = PLANS[billing.tier];
  return {
    id: plan.id,
    name: plan.name,
    priceUsd: plan.priceUsd,
    description: planLine(plan.id, config),
    status: billing.proState,
    periodEnd: billing.periodEnd === null ? null : new Date(billing.periodEnd).toISOString(),
    cancelAtPeriodEnd: billing.cancelAtPeriodEnd,
    paymentFailed: billing.paymentFailed,
    /** In its free trial (trials.ts): the plan starts at the trial's end at the latest. */
    trialing: billing.trialing,
    trialEndsAt: billing.trialEnd === null ? null : new Date(billing.trialEnd).toISOString(),
  };
}

/** GET /web/account's body (also in every session response). */
async function accountView(c: Ctx, accountNumber: number) {
  const person = account(c, accountNumber);
  const [stored, identities, billing, settings, plan, gate, bars] = await Promise.all([
    directory(c).getPerson(accountNumber),
    directory(c).identities(accountNumber),
    person.billing(),
    person.settings(),
    person.plan(c.now()),
    runtime(c),
    planAccountFor(c, accountNumber),
  ]);
  const trial = trialView(bars.state.trial, gate.config, c.now());
  const current = planView(billing, gate.config);
  const tier = current && current.status !== "canceled" ? billing.tier : null;
  return {
    accountId: accountIdOf(accountNumber),
    email: stored?.email ?? null,
    identities: identities.map((identity) =>
      identity.kind === "github"
        ? { kind: "github", login: identity.label ?? (identity.subject === String(accountNumber) ? (stored?.login ?? null) : null) }
        : identity.kind === "google"
          ? { kind: "google", email: identity.label }
          : { kind: "email", email: identity.label ?? identity.subject },
    ),
    plan: current,
    legacy: isPaidAccountNumber(accountNumber) || billing.tier !== null ? null : { plan },
    settings,
    // Part B: one bar per plan model and the GPT-6 launch bonus (plan-usage.ts), null without them.
    limits: bars.limits,
    gpt6Bonus: bars.gpt6Bonus,
    // The free trial's meter (trials.ts), or null: counted used of its limit, and as real tokens at 95.5% caching.
    trial,
    // The Free plan's week (free-plan.ts), or null for an account not on it (or with a paid plan).
    freePlan: tier === null && bars.state.freePlan ? freePlanView({ on: freePlanOn(gate.config), counted: bars.state.counted[DEEPSEEK_MODEL] ?? 0, config: gate.config, now: c.now() }) : null,
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
  return sendCode(c, checked.email, checked.norm, `change:${caller.account}`, plainCodeEmail("Confirm your new dl.new email", "Confirm this address for your dl.new account with this code:"));
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
  const paid = (await person.paidPlan(c.now())) !== null || (await person.trialAccess(c.now()));
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

/**
 * POST /web/billing/refund-request {reason?}: recorded, and the owner is told. No page links to it
 * any more (no public refund promise); kept so a request from an old page still reaches the owner.
 */
async function refundRequest(c: Ctx): Promise<Response> {
  const caller = await paidCaller(c);
  if (caller instanceof Response) return caller;
  const body = (await readJson(c)) ?? {};
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 1000) || null : null;
  const billing = await account(c, caller.account).billing();
  if (!billing.subscriptionId || billing.tier === null) return apiError(404, "no_subscription", "This account has no plan to refund.");
  const { config } = await runtime(c);
  const hours = config.refundWindowHours;
  const deadline = billing.firstPaidAt === null ? null : billing.firstPaidAt + hours * HOUR_MS;
  const reached = await limitsReached(c, caller.account, billing.tier, config);
  const block = billing.refundedAt !== null ? "already_refunded" : refundBlock({ firstPaidAt: billing.firstPaidAt, now: c.now(), hours, limitsReached: reached });
  const eligible = block === undefined;
  const notEligible = block === undefined ? null : block === "already_refunded" ? "already refunded" : REFUND_BLOCK_TEXT[block];
  await directory(c).recordRefundRequest({ account: caller.account, reason, eligible, notEligible, now: c.now() });
  const id = accountIdOf(caller.account);
  const why = block === "limit_reached" ? `weekly limit reached (${reached.join(", ")})` : notEligible;
  await alert(c, [
    {
      subject: `dl.new: refund request from ${caller.email ?? id}${eligible ? "" : ` (not eligible: ${notEligible})`}`,
      text: `dl.new: ${caller.email ?? id} (${id}, ${PLANS[billing.tier].name}) asked for a refund.${reason ? `\nReason: ${reason}` : ""}\n${eligible ? `Eligible (within ${refundWindowText(hours)}, no weekly limit reached): refund with POST /admin/paid/refund {"accountId": "${id}"}.` : `Not eligible: ${why}. Refund only with {"force": true}.`}`,
    },
  ]);
  return json({
    requested: true,
    eligible,
    /** Null when eligible; else "refund_not_eligible: weekly limit reached" and the like. */
    notEligible: notEligible === null ? null : `refund_not_eligible: ${notEligible}`,
    ...(block === "limit_reached" ? { limitsReached: reached } : {}),
    deadline: deadline === null ? null : new Date(deadline).toISOString(),
  });
}

/**
 * The names of the plan's models whose weekly meter is at 100% this week (counted tokens at or
 * over the limit, as plan-limits.ts refuses them): any one makes the first payment non-refundable.
 */
async function limitsReached(c: Ctx, accountNumber: number, plan: PlanId, config: PlanSettingsConfig & { cachedTokenWeight: number }): Promise<string[]> {
  const meters = await account(c, accountNumber).meters(c.now());
  return planLimits(plan, config)
    .filter((limit) => limit.countedTokens > 0 && (meters.models.find((row) => row.model === limit.model)?.counted ?? 0) >= limit.countedTokens)
    .map((limit) => limit.name);
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
  if (approve && isPaidAccountNumber(caller.account) && (await account(c, caller.account).paidPlan(c.now())) === null && !(await account(c, caller.account).trialAccess(c.now()))) {
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

/** A meter's client ("tool:cursor") as the usage page names it ("cursor"). */
function meterTool(tool: string): string {
  return tool.startsWith("tool:") ? tool.slice(5) || "other" : tool || "other";
}

function tokensOf(row: UsageRow, weight: number) {
  const cached = Math.max(0, row.cached_tokens);
  const fresh = Math.max(0, row.prompt_tokens - cached);
  const output = Math.max(0, row.completion_tokens);
  return { cached, fresh, output, real: cached + fresh + output, counted: Math.round(cached * weight + fresh + output) };
}

function share(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 1000) / 1000 : 0;
}

/**
 * GET /web/usage?week=YYYY-MM-DD: the week's usage from the account's per-model meters (part B's
 * `planUsageFor`, plan-meter.ts: this week and the four before it), with each plan model's bar
 * (`limit`, as `/web/account` `limits[]`). The request log feeds only the live box. Every
 * account's settled requests are metered (AccountObject.settle), plan or not: free tier, admins
 * and legacy dl Pro see their usage without bars. Meters start with the paid-plans release.
 */
async function usage(c: Ctx): Promise<Response> {
  const caller = await paidCaller(c);
  if (caller instanceof Response) return caller;
  const { config } = await runtime(c);
  const raw = c.url.searchParams.get("week");
  const now = c.now();
  let start = weekStart(now);
  if (raw !== null) {
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? Date.parse(`${raw}T00:00:00.000Z`) : Number.NaN;
    if (!Number.isFinite(parsed) || weekStart(parsed) !== parsed || parsed > now) return apiError(400, "invalid_week", "Send ?week= as a Monday (YYYY-MM-DD).");
    start = parsed;
  }
  if (start < weekStart(now - METER_KEEP_DAYS * DAY_MS) + WEEK_MS) return apiError(400, "week_unavailable", `Usage is kept for this week and the ${Math.floor(METER_KEEP_DAYS / 7)} before it.`);
  const end = weekEnd(start);
  const at = Math.min(now, end - 1);
  const weight = config.cachedTokenWeight;
  const view = await planUsageFor(c, caller.account, at);
  // The bars are this week's only: a past week's usage isn't held to today's limits.
  const thisWeek = start === weekStart(now);
  const bars = thisWeek ? (await planAccountFor(c, caller.account)).limits : null;
  const t = view.totals;
  const prompt = t.cachedInput + t.freshInput;
  return json({
    week: { start: new Date(start).toISOString(), resetsAt: new Date(end).toISOString() },
    plan: view.plan,
    plansEnforced: view.plansEnforced,
    totals: {
      requests: t.requests,
      realTokens: t.realTokens,
      countedTokens: t.countedTokens,
      cachedInput: t.cachedInput,
      cachedCountedAs: Math.round(t.cachedInput * weight),
      freshInput: t.freshInput,
      output: t.output,
      cachingShare: share(t.cachedInput, prompt),
      realToCounted: t.realTokens > 0 ? Math.round((t.countedTokens / t.realTokens) * 10_000) / 10_000 : null,
      failovers: t.failovers,
    },
    models: view.models
      .filter((model) => model.requests > 0 || model.realLimit !== null)
      .map((model) => ({
        model: model.model,
        name: model.name,
        requests: model.requests,
        cachedInput: model.cachedInput,
        freshInput: model.freshInput,
        output: model.output,
        realTokens: model.realTokens,
        countedTokens: model.countedUsed,
        cachingShare: share(model.cachedInput, model.cachedInput + model.freshInput),
        failovers: model.failovers,
        limit: bars?.find((bar) => bar.model === model.model) ?? null,
      })),
    days: view.days.map((day) => ({ day: day.date, countedTokens: day.counted, realTokens: day.real })),
    tools: view.tools.map((tool) => ({ tool: meterTool(tool.tool), requests: tool.requests, realTokens: tool.real, countedTokens: tool.counted })).sort((a, b) => b.countedTokens - a.countedTokens),
    trial: trialView((await planAccountFor(c, caller.account)).state.trial, config, now),
    // The Free plan's week (free-plan.ts): used of the weekly cap, the upgrade line; null when not on Free.
    freePlan: await freePlanUsage(c, caller.account, thisWeek),
    gpt6Bonus: thisWeek && view.bonus.enabled && view.bonus.granted ? { usdPerWeek: view.bonus.weeklyUsd, usedUsd: view.bonus.spentUsd, leftUsd: view.bonus.leftUsd, label: view.bonus.label, line: view.bonus.line } : null,
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
    termsAcceptedAt: row.terms_accepted_at === null ? null : new Date(row.terms_accepted_at).toISOString(),
    // The launch offer: the coupon on this Checkout (null: full price), what it took off, and its percent.
    trial: row.trial === 1 ? { promoEligible: row.promo_eligible } : null,
    promo: row.promo_coupon === null ? null : { coupon: row.promo_coupon, discountCents: row.discount_cents, percentOff: row.promo_percent_off },
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
        notEligible: row.not_eligible === null ? null : `refund_not_eligible: ${row.not_eligible}`,
        refundedAt: row.refunded_at === null ? null : new Date(row.refunded_at).toISOString(),
      })),
    });
  }
  if (method === "POST" && rest === "refund") return adminRefund(c);
  // The free trials (trials.ts): both budgets (spent, projected, fully claimed) and the latest trials.
  if (method === "GET" && rest === "trials") {
    const { config } = await runtime(c);
    return json(await directory(c).trialsAdmin(config, c.now()));
  }
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
  if (!force) {
    const { config } = await runtime(c);
    const hours = config.refundWindowHours;
    const tier = billing?.tier ?? (row && isPlanId(row.plan) ? row.plan : null);
    const reached = accountNumber !== undefined && tier !== null ? await limitsReached(c, accountNumber, tier, config) : [];
    const block = refundBlock({ firstPaidAt: paidAt, now: c.now(), hours, limitsReached: reached });
    if (block === "window_passed") {
      return apiError(409, "refund_window_passed", `The first payment is more than ${refundWindowText(hours)} old. Send {"force": true} to refund anyway.`, { reason: REFUND_BLOCK_TEXT.window_passed });
    }
    if (block === "limit_reached") {
      return apiError(409, "refund_not_eligible", `Not eligible: weekly limit reached (${reached.join(", ")}). Send {"force": true} to refund anyway.`, { reason: REFUND_BLOCK_TEXT.limit_reached, limitsReached: reached });
    }
  }
  try {
    let invoiceId = billing?.firstInvoiceId ?? null;
    if (!invoiceId) invoiceId = idOf((await stripeRequest(c.fetch, key, "GET", `/v1/subscriptions/${subscriptionId}`)).latest_invoice) ?? null;
    if (!invoiceId) return apiError(404, "no_payment", "Stripe has no invoice for this subscription.");
    const payment = await invoicePayment(c.fetch, key, invoiceId);
    if (!payment) return apiError(404, "no_payment", "Stripe has no payment for the first invoice.");
    const refund = await stripeRequest(c.fetch, key, "POST", "/v1/refunds", { ...payment, reason: "requested_by_customer", metadata: { subscription: subscriptionId, ...(accountNumber !== undefined ? { account_id: accountIdOf(accountNumber) } : {}) } }, `refund-${invoiceId}`);
    await cancelSubscription(c.fetch, key, subscriptionId);
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
  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted" || event.type === "customer.subscription.trial_will_end") {
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
  const { config } = await runtime(c);
  // Transactional: it may use the reserve bulk mail can't (email-budget.ts).
  if (!(await directory(c).takeEmailBudget({ emailClass: "transactional", now: c.now(), budget: emailBudgetOf(config) }))) {
    console.error("paid: claim email over the daily email budget");
    return;
  }
  const trialText = row.trial === 1;
  const text = trialText
    ? [
        `Your free trial of ${plan.name} has started: the first ${config.cardTrialTokens / 1_000_000}M tokens are free (95.5% caching applied). Your plan ($${plan.priceUsd}/month${row.promo_eligible ? `, first month ${config.promoPercentOff}% off` : ""}) starts when you've used them or after ${config.cardTrialDays} days.`,
        "",
        "Finish setting up dl.new to get your key:",
        link,
        "",
        `The link works for ${CLAIM_DAYS} days. Nothing was charged today.`,
        "Questions? Reply to this email.",
        "",
        "dl.new, by Directionally Local",
      ].join("\n")
    : [
    `Thanks for subscribing to ${plan.name} (${row.promo_coupon === null ? `$${plan.priceUsd}/month` : `first month ${row.promo_percent_off ?? config.promoPercentOff}% off, then $${plan.priceUsd}/month`}): ${planLine(row.plan, config)}`,
    "",
    "Finish setting up dl.new to get your key:",
    link,
    "",
    `The link works for ${CLAIM_DAYS} days. Stripe sends your receipt separately.`,
    "Questions? Reply to this email.",
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
      const trialCheckout = isTrialCheckout(object);
      if (object.payment_status !== "paid" && !trialCheckout) return "plan_unpaid";
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
        termsAcceptedAt: termsAccepted(object) ? event.created * 1000 : null,
        promo: checkoutPromo(object),
        ...(trialCheckout ? { trial: true, promoEligible: promoEligible(object) ?? null } : {}),
      });
      // A card trial (trials.ts) is on the trial budget from now, whoever claims it.
      const { config: trialConfig } = await runtime(c);
      const subscriptionId = idOf(object.subscription);
      if (trialCheckout && subscriptionId) {
        await dir.recordCardTrial({ subscriptionId, plan, limit: trialCountedLimit("card", trialConfig), startedAt: event.created * 1000, endsAt: event.created * 1000 + trialConfig.cardTrialDays * DAY_MS, ...(row.claimed_by !== null ? { account: row.claimed_by } : {}) });
      }
      if (row.claimed_by !== null) return "plan_claimed";
      await sendClaimEmail(c, row);
      // The owner's email about it is owner-payment-alerts.ts's (one per event, claimed or not).
      return "plan_unclaimed";
    }
    case "invoice.paid":
    case "invoice.payment_failed": {
      const { subscriptionId } = invoiceSubscription(object);
      if (!subscriptionId) return "ignored";
      if (owner === undefined) {
        // Money taken on a subscription whose Checkout can't be claimed any more (a renewal, or a
        // card trial's first charge): refunded, and the subscription cancelled.
        const row = await dir.paidCheckoutBySubscription(subscriptionId);
        if (event.type === "invoice.paid" && row && row.claimed_by === null && !claimable(row, c.now(), CLAIM_DAYS) && invoiceAmount(object) > 0 && typeof object.id === "string") {
          const done = await cancelOrphan(c, { subscriptionId, sessionId: row.session_id, reason: "renewal", email: row.email, refundInvoice: object.id });
          return done ? "plan_orphan_canceled" : "plan_unclaimed";
        }
        return "plan_unclaimed";
      }
      const person = account(c, owner);
      const tier = invoicePrices(object).map((price) => planOfPrice(prices, price)).find((plan): plan is PlanId => plan !== undefined);
      if (event.type === "invoice.payment_failed") {
        await person.applySubscription({ subscriptionId, state: "past_due", periodEnd: undefined, eventAt: event.created, paymentFailed: true });
        return "plan_past_due";
      }
      const end = invoicePeriodEnd(object);
      const amount = invoiceAmount(object);
      const applied = await person.applySubscription({ subscriptionId, state: "active", periodEnd: end, eventAt: event.created, paymentFailed: false, ...(tier ? { tier } : {}) });
      // The first money taken (a trial's $0 invoice isn't a payment): it starts the refund window.
      if (amount > 0 && typeof object.id === "string") await person.noteFirstPayment({ invoiceId: object.id, at: event.created * 1000 });
      // Money taken while a card trial is open: the trial is over and the plan started (trials.ts).
      if (amount > 0) await trialFromInvoice(c, owner, object, subscriptionId);
      if (amount === 0 && object.billing_reason === "subscription_create") return applied ? "plan_trial_invoice" : "stale";
      const billed = tier ?? (await person.billing()).tier;
      // Recorded for the revenue numbers; the owner's email is owner-payment-alerts.ts's.
      await dir.recordPayment({
        id: String(object.id),
        githubId: owner,
        kind: "pro",
        amountCents: Math.round(Number(object.total_excluding_tax ?? object.subtotal ?? object.amount_paid ?? 0)),
        at: event.created * 1000,
        renewal: object.billing_reason === "subscription_cycle",
        ...(billed ? { product: PLANS[billed].name } : {}),
      });
      if (applied) await dir.mirrorSubscription({ githubId: owner, state: "active", periodEnd: end, eventAt: event.created });
      return applied ? "plan_active" : "stale";
    }
    case "customer.subscription.trial_will_end":
      // The launch offer's coupon onto a trialing subscription before its first real charge.
      return `plan_${await trialWillEnd(c, object)}`;
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      if (typeof object.id !== "string") return "ignored";
      if (owner === undefined) return "plan_unclaimed";
      const state = event.type === "customer.subscription.deleted" ? "canceled" : planState(object.status);
      const tier = planOfPrice(prices, subscriptionPrice(object));
      const end = periodEnd(object);
      const applied = await account(c, owner).applySubscription({ subscriptionId: object.id, state, periodEnd: end, cancelAtPeriodEnd: object.cancel_at_period_end === true, eventAt: event.created, ...(tier ? { tier } : {}), trial: event.type === "customer.subscription.deleted" ? { trialing: false, trialEnd: null } : subscriptionTrial(object) });
      if (applied) await dir.mirrorSubscription({ githubId: owner, state, periodEnd: end, eventAt: event.created });
      // A card trial over in Stripe (its plan started, or it was canceled) closes here (trials.ts).
      if (applied) await trialFromSubscription(c, owner, object, event.type === "customer.subscription.deleted");
      return applied ? `plan_${state}` : "stale";
    }
  }
  return "ignored";
}

