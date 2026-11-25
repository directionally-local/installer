/**
 * The Directory's part of dl.new's paid accounts (docs/web-api-paid.md): identities, paid
 * Checkout Sessions waiting to be claimed, refund requests, and the request log read-outs for
 * the usage page. Plain functions over the Directory's SQLite, called from DirectoryObject.
 */

import type { Sql } from "./dashboard-data.js";
import { isPaidAccountNumber, randomAccountNumber, type IdentityKind } from "./accounts.js";
import { normalizeEmail } from "./email-guard.js";
import type { PlanId } from "./plan-prices.js";
import { DAY_MS } from "./week.js";

export const PAID_SCHEMA = [
  // Sign-in identities → account number (accounts.ts). `subject`: a GitHub id, or a normalized address.
  `CREATE TABLE IF NOT EXISTS identities (
     kind       TEXT NOT NULL,
     subject    TEXT NOT NULL,
     account    INTEGER NOT NULL,
     label      TEXT,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (kind, subject)
   )`,
  `CREATE INDEX IF NOT EXISTS identities_account ON identities (account)`,
  // Paid plan Checkouts. Unclaimed (claimed_by NULL) until an account takes them, for CLAIM_DAYS.
  `CREATE TABLE IF NOT EXISTS paid_checkouts (
     session_id          TEXT PRIMARY KEY,
     plan                TEXT NOT NULL,
     customer_id         TEXT,
     subscription_id     TEXT,
     email               TEXT,
     amount_cents        INTEGER NOT NULL DEFAULT 0,
     paid_at             INTEGER NOT NULL,
     claimed_by          INTEGER,
     claimed_at          INTEGER,
     claim_email_sent_at INTEGER,
     terms_accepted_at   INTEGER,
     promo_coupon        TEXT,
     discount_cents      INTEGER NOT NULL DEFAULT 0,
     promo_percent_off   INTEGER,
     trial               INTEGER NOT NULL DEFAULT 0,
     promo_eligible      TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS paid_checkouts_subscription ON paid_checkouts (subscription_id)`,
  `CREATE TABLE IF NOT EXISTS refund_requests (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     account     INTEGER NOT NULL,
     at          INTEGER NOT NULL,
     reason      TEXT,
     eligible    INTEGER NOT NULL,
     refunded_at INTEGER,
     not_eligible TEXT
   )`,
];

/** A completed Checkout's discount (stripe.ts checkoutPromo). */
export interface CheckoutPromo {
  coupon: string;
  discountCents: number;
  percentOff: number;
}

export interface PaidCheckoutRow {
  session_id: string;
  plan: string;
  customer_id: string | null;
  subscription_id: string | null;
  email: string | null;
  amount_cents: number;
  paid_at: number;
  claimed_by: number | null;
  claimed_at: number | null;
  claim_email_sent_at: number | null;
  /** When the customer accepted the terms with the withdrawal waiver at Checkout (Unix ms), or null. */
  terms_accepted_at: number | null;
  /** The launch offer's coupon when the Checkout had it (its first invoice was discounted), else null. */
  promo_coupon: string | null;
  /** What the discount took off the first payment, in cents (0 without one). */
  discount_cents: number;
  /** The discount as a percent of the first month (from Stripe's amounts), or null without one. */
  promo_percent_off: number | null;
  /** 1: a card trial Checkout (trials.ts), nothing paid yet. */
  trial: number;
  /** A trial Checkout started in the launch offer's window: the coupon its first real charge gets. */
  promo_eligible: string | null;
}

/** The identity's subject as stored: a GitHub id as digits, an address normalized. */
export function identitySubject(kind: IdentityKind, value: string | number): string {
  return kind === "email" ? normalizeEmail(String(value)) : String(value);
}

/**
 * The account an identity signs in to. A GitHub identity with no row yet but a free-tier person
 * of that GitHub id (an account from before the paid launch) is linked to it here, once.
 */
export function resolveIdentity(sql: Sql, kind: IdentityKind, subject: string, now: number): number | undefined {
  const found = sql.exec<{ account: number }>("SELECT account FROM identities WHERE kind = ? AND subject = ?", kind, subject).toArray()[0];
  if (found) return found.account;
  if (kind !== "github" || !/^[1-9][0-9]{0,15}$/.test(subject)) return undefined;
  const githubId = Number(subject);
  if (isPaidAccountNumber(githubId)) return undefined;
  const legacy = sql.exec<{ github_id: number }>("SELECT github_id FROM people WHERE github_id = ?", githubId).toArray()[0];
  if (!legacy) return undefined;
  sql.exec("INSERT INTO identities (kind, subject, account, created_at) VALUES ('github', ?, ?, ?) ON CONFLICT DO NOTHING", subject, githubId, now);
  return githubId;
}

/**
 * A new dl.new account: a random free account number, its people row (admitted as "paid", Full,
 * with the verified contact email) and its first identity. Run inside a transaction.
 */
export function createPaidAccount(sql: Sql, input: { kind: IdentityKind; subject: string; label: string | null; login: (account: number) => string; email: string; now: number }): number {
  let account = randomAccountNumber();
  for (let attempt = 0; sql.exec("SELECT 1 FROM people WHERE github_id = ?", account).toArray().length > 0; attempt++) {
    if (attempt > 10) throw new Error("Couldn't find a free account number.");
    account = randomAccountNumber();
  }
  sql.exec(
    `INSERT INTO people (github_id, login, status, admitted_at, admitted_via, level, level_reason, email, email_norm, email_updates, email_at, signup_tokens)
     VALUES (?, ?, 'active', ?, 'paid', 'full', NULL, ?, ?, 0, ?, 1)`,
    account,
    input.login(account),
    input.now,
    input.email.trim(),
    normalizeEmail(input.email),
    input.now,
  );
  sql.exec("INSERT INTO identities (kind, subject, account, label, created_at) VALUES (?, ?, ?, ?, ?)", input.kind, input.subject, account, input.label, input.now);
  return account;
}

export function linkIdentity(sql: Sql, input: { kind: IdentityKind; subject: string; account: number; label: string | null; now: number }): "linked" | "taken" {
  const holder = sql.exec<{ account: number }>("SELECT account FROM identities WHERE kind = ? AND subject = ?", input.kind, input.subject).toArray()[0];
  if (holder) return holder.account === input.account ? "linked" : "taken";
  sql.exec("INSERT INTO identities (kind, subject, account, label, created_at) VALUES (?, ?, ?, ?, ?)", input.kind, input.subject, input.account, input.label, input.now);
  return "linked";
}

export function identitiesOf(sql: Sql, account: number): Array<{ kind: IdentityKind; subject: string; label: string | null }> {
  const rows = sql.exec<{ kind: IdentityKind; subject: string; label: string | null }>("SELECT kind, subject, label FROM identities WHERE account = ? ORDER BY created_at", account).toArray();
  // An account from before the paid launch whose GitHub sign-in hasn't been used on dl.new yet.
  if (!isPaidAccountNumber(account) && !rows.some((row) => row.kind === "github")) rows.unshift({ kind: "github", subject: String(account), label: null });
  return rows;
}

/**
 * Moves the account's email sign-in to a new verified address (the contact-email change).
 * "taken": another account signs in with it.
 */
export function replaceEmailIdentity(sql: Sql, input: { account: number; email: string; now: number }): "ok" | "taken" {
  const subject = normalizeEmail(input.email);
  const holder = sql.exec<{ account: number }>("SELECT account FROM identities WHERE kind = 'email' AND subject = ?", subject).toArray()[0];
  if (holder && holder.account !== input.account) return "taken";
  sql.exec("DELETE FROM identities WHERE kind = 'email' AND account = ?", input.account);
  sql.exec("INSERT INTO identities (kind, subject, account, label, created_at) VALUES ('email', ?, ?, ?, ?)", subject, input.account, input.email.trim(), input.now);
  return "ok";
}

/**
 * "Continue with Google" (paid-web.ts googleSession): the account a Google sign-in belongs to.
 * Its own identity first; else an account that already signs in with the same address by email
 * code gets the Google identity linked (Google verified the address, as the code would), so the
 * same person doesn't end up with two accounts. Undefined: no account yet (sign-up rules apply).
 * Run inside a transaction.
 */
export function resolveGoogleIdentity(sql: Sql, input: { subject: string; email: string; now: number }): number | undefined {
  const own = resolveIdentity(sql, "google", input.subject, input.now);
  if (own !== undefined) return own;
  const byEmail = sql.exec<{ account: number }>("SELECT account FROM identities WHERE kind = 'email' AND subject = ?", normalizeEmail(input.email)).toArray()[0];
  if (!byEmail) return undefined;
  sql.exec("INSERT INTO identities (kind, subject, account, label, created_at) VALUES ('google', ?, ?, ?, ?) ON CONFLICT DO NOTHING", input.subject, byEmail.account, input.email.trim(), input.now);
  return byEmail.account;
}

/** Whether another account signs in with this address. */
export function emailIdentityTaken(sql: Sql, email: string, account: number): boolean {
  return sql.exec("SELECT 1 FROM identities WHERE kind = 'email' AND subject = ? AND account != ?", normalizeEmail(email), account).toArray().length > 0;
}

// ─── Paid Checkouts ─────────────────────────────────────────────────────────

/** Stores (or refreshes) a paid plan Checkout from its webhook or a claim's read of it. Never unclaims. */
export function recordPaidCheckout(
  sql: Sql,
  input: { sessionId: string; plan: PlanId; customerId: string | null; subscriptionId: string | null; email: string | null; amountCents: number; paidAt: number; termsAcceptedAt?: number | null; promo?: CheckoutPromo | null; trial?: boolean; promoEligible?: string | null },
): PaidCheckoutRow {
  sql.exec(
    `INSERT INTO paid_checkouts (session_id, plan, customer_id, subscription_id, email, amount_cents, paid_at, terms_accepted_at, promo_coupon, discount_cents, promo_percent_off, trial, promo_eligible) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET customer_id = COALESCE(excluded.customer_id, customer_id), subscription_id = COALESCE(excluded.subscription_id, subscription_id),
       email = COALESCE(excluded.email, email), amount_cents = excluded.amount_cents, terms_accepted_at = COALESCE(terms_accepted_at, excluded.terms_accepted_at),
       promo_coupon = COALESCE(excluded.promo_coupon, promo_coupon), discount_cents = MAX(excluded.discount_cents, discount_cents), promo_percent_off = COALESCE(excluded.promo_percent_off, promo_percent_off),
       trial = MAX(excluded.trial, trial), promo_eligible = COALESCE(excluded.promo_eligible, promo_eligible)`,
    input.sessionId,
    input.plan,
    input.customerId,
    input.subscriptionId,
    input.email,
    input.amountCents,
    input.paidAt,
    input.termsAcceptedAt ?? null,
    input.promo?.coupon ?? null,
    input.promo?.discountCents ?? 0,
    input.promo?.percentOff ?? null,
    input.trial ? 1 : 0,
    input.promoEligible ?? null,
  );
  return paidCheckout(sql, input.sessionId)!;
}

export function paidCheckout(sql: Sql, sessionId: string): PaidCheckoutRow | undefined {
  return sql.exec<PaidCheckoutRow>("SELECT * FROM paid_checkouts WHERE session_id = ?", sessionId).toArray()[0];
}

export function paidCheckoutBySubscription(sql: Sql, subscriptionId: string): PaidCheckoutRow | undefined {
  return sql.exec<PaidCheckoutRow>("SELECT * FROM paid_checkouts WHERE subscription_id = ? ORDER BY paid_at DESC LIMIT 1", subscriptionId).toArray()[0];
}

/** Claims a recorded Checkout for an account: "claimed" (now or already by it), or "taken" by another. */
export function claimPaidCheckout(sql: Sql, sessionId: string, account: number, now: number): "claimed" | "taken" | "missing" {
  const row = paidCheckout(sql, sessionId);
  if (!row) return "missing";
  if (row.claimed_by !== null) return row.claimed_by === account ? "claimed" : "taken";
  sql.exec("UPDATE paid_checkouts SET claimed_by = ?, claimed_at = ? WHERE session_id = ? AND claimed_by IS NULL", account, now, sessionId);
  return paidCheckout(sql, sessionId)?.claimed_by === account ? "claimed" : "taken";
}

/** Marks the claim email sent; false when it was already (so a retried webhook doesn't send twice). */
export function markClaimEmail(sql: Sql, sessionId: string, now: number): boolean {
  return sql.exec("UPDATE paid_checkouts SET claim_email_sent_at = ? WHERE session_id = ? AND claim_email_sent_at IS NULL RETURNING session_id", now, sessionId).toArray().length > 0;
}

export function listPaidCheckouts(sql: Sql, status: "unclaimed" | "claimed" | "all"): PaidCheckoutRow[] {
  const where = status === "unclaimed" ? "WHERE claimed_by IS NULL" : status === "claimed" ? "WHERE claimed_by IS NOT NULL" : "";
  return sql.exec<PaidCheckoutRow>(`SELECT * FROM paid_checkouts ${where} ORDER BY paid_at DESC LIMIT 500`).toArray();
}

/** The account's earliest claimed Checkout (the first payment), for refunds. */
export function firstCheckoutOf(sql: Sql, account: number): PaidCheckoutRow | undefined {
  return sql.exec<PaidCheckoutRow>("SELECT * FROM paid_checkouts WHERE claimed_by = ? ORDER BY paid_at ASC LIMIT 1", account).toArray()[0];
}

// ─── Refund requests ────────────────────────────────────────────────────────

/** `notEligible`: why not ("weekly limit reached", "refund window passed", "already refunded"), null when eligible. */
export function recordRefundRequest(sql: Sql, input: { account: number; reason: string | null; eligible: boolean; notEligible?: string | null; now: number }): void {
  sql.exec("INSERT INTO refund_requests (account, at, reason, eligible, not_eligible) VALUES (?, ?, ?, ?, ?)", input.account, input.now, input.reason, input.eligible ? 1 : 0, input.notEligible ?? null);
}

export function markRefunded(sql: Sql, account: number, now: number): void {
  sql.exec("UPDATE refund_requests SET refunded_at = ? WHERE account = ? AND refunded_at IS NULL", now, account);
}

export function listRefundRequests(sql: Sql): Array<{ account: number; email: string | null; reason: string | null; at: number; eligible: number; not_eligible: string | null; refunded_at: number | null }> {
  return sql
    .exec<{ account: number; email: string | null; reason: string | null; at: number; eligible: number; not_eligible: string | null; refunded_at: number | null }>(
      "SELECT r.account, p.email, r.reason, r.at, r.eligible, r.not_eligible, r.refunded_at FROM refund_requests r LEFT JOIN people p ON p.github_id = r.account ORDER BY r.at DESC LIMIT 500",
    )
    .toArray();
}

// ─── Usage read-outs (the request log) ──────────────────────────────────────

export interface UsageRow {
  id: number;
  at: number;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  charged_tokens: number;
  status: string;
  latency_ms: number | null;
  harness: string | null;
  upstream_outcome: string | null;
  upstream_error: number;
}

/** One account's request rows in [from, to), oldest first. */
export function usageRows(sql: Sql, account: number, from: number, to: number): UsageRow[] {
  return sql
    .exec<UsageRow>(
      `SELECT id, at, model, prompt_tokens, completion_tokens, cached_tokens, charged_tokens, status, latency_ms, harness, upstream_outcome, upstream_error
       FROM requests WHERE github_id = ? AND at >= ? AND at < ? ORDER BY id`,
      account,
      from,
      to,
    )
    .toArray();
}

/** The live box: the newest few rows after `after`, and the account's first request in the log. */
export function liveRows(sql: Sql, account: number, after: number, limit: number): { rows: UsageRow[]; first: UsageRow | undefined } {
  const rows = sql
    .exec<UsageRow>(
      `SELECT id, at, model, prompt_tokens, completion_tokens, cached_tokens, charged_tokens, status, latency_ms, harness, upstream_outcome, upstream_error
       FROM requests WHERE github_id = ? AND id > ? ORDER BY id DESC LIMIT ?`,
      account,
      after,
      limit,
    )
    .toArray();
  const first = sql
    .exec<UsageRow>(
      `SELECT id, at, model, prompt_tokens, completion_tokens, cached_tokens, charged_tokens, status, latency_ms, harness, upstream_outcome, upstream_error
       FROM requests WHERE github_id = ? ORDER BY id ASC LIMIT 1`,
      account,
    )
    .toArray()[0];
  return { rows, first };
}

/** Whether a Checkout is still claimable at `now`. */
export function claimable(row: Pick<PaidCheckoutRow, "paid_at">, now: number, claimDays: number): boolean {
  return now - row.paid_at <= claimDays * DAY_MS;
}

