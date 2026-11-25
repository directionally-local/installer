/**
 * The daily budget for emails to users, so bulk mail can never crowd out the mail people are
 * waiting for. The provider's real daily quota (Cloudflare Email Service's send_email binding, or
 * Resend) isn't known, so the defaults are conservative and every number is a runtime setting:
 *
 *   userEmailsDailyMax              (default 300) every email to users a UTC day, codes aside
 *   userEmailsTransactionalReserve  (default 100) of those, kept for transactional mail: bulk
 *                                   mail stops at max − reserve (200 by default)
 *   emailCodesDailyMax              (default 300) sign-in and email-change codes a UTC day; they
 *                                   never count against the daily max and are never stopped by
 *                                   it, only by this separate hard ceiling
 *
 * So a day sends at most userEmailsDailyMax + emailCodesDailyMax (600 by default). Raise them once
 * the provider's quota is known.
 *
 * Classes:
 *   code           a 6-digit sign-in or email-change code (paid-web.ts)
 *   transactional  what someone is waiting for or must know: the "finish setting up" claim email,
 *                  the paid welcome (key, commands, limits, refund), plan_80, an answer to an
 *                  access request
 *   bulk           everything else: lifecycle (welcome_*, didnt_start, week_80, trial_80,
 *                  gone_quiet, weekly_reset, plan_reset) and the owner's broadcasts
 *
 * Every send is counted when it is claimed (sent or not), per UTC day, in the Directory's
 * `email_budget_daily` table; a refused claim sends nothing (bulk mail waits for a later run).
 */

import type { UserEmailKind } from "./user-emails.js";

export type EmailClass = "code" | "transactional" | "bulk";

export interface EmailBudget {
  /** Every email to users a UTC day, codes aside. */
  dailyMax: number;
  /** Of dailyMax, kept for transactional mail. */
  transactionalReserve: number;
  /** Codes a UTC day: their own ceiling, outside dailyMax. */
  codesMax: number;
}

export type EmailBudgetSettingsConfig = {
  userEmailsDailyMax: number;
  userEmailsTransactionalReserve: number;
  emailCodesDailyMax: number;
};

export const EMAIL_BUDGET_DEFAULTS: EmailBudgetSettingsConfig = {
  userEmailsDailyMax: 300,
  userEmailsTransactionalReserve: 100,
  emailCodesDailyMax: 300,
};

export function emailBudgetOf(config: EmailBudgetSettingsConfig): EmailBudget {
  return { dailyMax: config.userEmailsDailyMax, transactionalReserve: config.userEmailsTransactionalReserve, codesMax: config.emailCodesDailyMax };
}

/** The user-email kinds people are waiting for; every other kind is bulk. */
export const TRANSACTIONAL_KINDS: readonly (UserEmailKind | "claim")[] = ["welcome_paid", "plan_80", "access_granted", "access_granted_trial", "claim", "welcome_trial_card", "welcome_trial_nocard", "trial_card_80", "trial_converted"];

export function classOfKind(kind: UserEmailKind | "broadcast" | "claim"): EmailClass {
  return (TRANSACTIONAL_KINDS as readonly string[]).includes(kind) ? "transactional" : "bulk";
}

/** Today's counts per class. */
export type EmailCounts = Record<EmailClass, number>;

/** How many of `emailClass` may still go today (0: none). */
export function emailRoom(emailClass: EmailClass, counts: EmailCounts, budget: EmailBudget): number {
  if (emailClass === "code") return Math.max(0, budget.codesMax - counts.code);
  const max = Math.max(0, budget.dailyMax);
  const total = counts.transactional + counts.bulk;
  if (emailClass === "transactional") return Math.max(0, max - total);
  const bulkMax = Math.max(0, max - Math.min(max, Math.max(0, budget.transactionalReserve)));
  return Math.max(0, Math.min(bulkMax - counts.bulk, max - total));
}

/** The part of Durable Object SQL storage used here. */
interface Sql {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): { toArray(): T[] };
}

export const EMAIL_BUDGET_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS email_budget_daily (
     day   INTEGER NOT NULL,
     class TEXT NOT NULL,
     n     INTEGER NOT NULL,
     PRIMARY KEY (day, class)
   ) WITHOUT ROWID`,
];

/** Days of counts kept. */
const KEEP_DAYS = 14;

export function emailCounts(sql: Sql, day: number): EmailCounts {
  const counts: EmailCounts = { code: 0, transactional: 0, bulk: 0 };
  for (const row of sql.exec<{ class: string; n: number }>("SELECT class, n FROM email_budget_daily WHERE day = ?", day).toArray()) {
    if (row.class === "code" || row.class === "transactional" || row.class === "bulk") counts[row.class] = row.n;
  }
  return counts;
}

/**
 * Takes one send of `emailClass` from UTC day `day`'s budget: true and counted, or false when
 * the class has no room left. Call inside the Directory's transaction with the claim it guards.
 */
export function takeEmailBudget(sql: Sql, emailClass: EmailClass, day: number, budget: EmailBudget): boolean {
  if (emailRoom(emailClass, emailCounts(sql, day), budget) <= 0) return false;
  sql.exec("INSERT INTO email_budget_daily (day, class, n) VALUES (?, ?, 1) ON CONFLICT (day, class) DO UPDATE SET n = n + 1", day, emailClass);
  sql.exec("DELETE FROM email_budget_daily WHERE day < ?", day - KEEP_DAYS);
  return true;
}
