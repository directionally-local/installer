/**
 * dl Pro's funnel, per UTC day: how many people saw the Pro prompt (the free week's open-models
 * limit, in a coding agent's 402 or on dl.new/account), clicked Upgrade (started a Pro checkout),
 * paid (a Pro checkout completed) and cancelled (a subscription set to end, or ended). Counts
 * only: each step counts a person once a day, told apart by a hash of their GitHub id with that
 * day's random salt, and the hashes and the salt are dropped once the day is over. The owner's
 * daily digest gets one line of it (`proDigestLine`), and GET /v1/admin/metrics the days.
 */

import { notAdmin } from "./dashboard-data.js";
import { DAY_MS } from "./week.js";

export const PRO_FUNNEL_STEPS = ["seen", "clicked", "paid", "cancelled"] as const;
export type ProFunnelStep = (typeof PRO_FUNNEL_STEPS)[number];

export function isProFunnelStep(value: unknown): value is ProFunnelStep {
  return typeof value === "string" && (PRO_FUNNEL_STEPS as readonly string[]).includes(value);
}

/** The tables, created with the Directory's own (directory-object.ts SCHEMA). */
export const PRO_FUNNEL_SCHEMA = [
  // People per UTC day and step: counts only, kept.
  `CREATE TABLE IF NOT EXISTS pro_funnel_daily (
     day  INTEGER NOT NULL,
     step TEXT NOT NULL,
     n    INTEGER NOT NULL,
     PRIMARY KEY (day, step)
   ) WITHOUT ROWID`,
  // Today's salted hashes, so a person counts once a step a day; earlier days' are dropped.
  `CREATE TABLE IF NOT EXISTS pro_funnel_people (
     day  INTEGER NOT NULL,
     step TEXT NOT NULL,
     hash TEXT NOT NULL,
     PRIMARY KEY (day, step, hash)
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS pro_funnel_salts (
     day  INTEGER PRIMARY KEY,
     salt TEXT NOT NULL
   )`,
];

/** The part of Durable Object SQL storage used here. */
interface Sql {
  exec<T extends Record<string, unknown> = Record<string, unknown>>(query: string, ...bindings: unknown[]): { toArray(): T[] };
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Counts `githubId` at `step` today, once. True when it was counted (not already today). */
export async function countProStep(sql: Sql, step: ProFunnelStep, githubId: number, now: number): Promise<boolean> {
  const day = Math.floor(now / DAY_MS);
  sql.exec("DELETE FROM pro_funnel_people WHERE day < ?", day);
  sql.exec("DELETE FROM pro_funnel_salts WHERE day < ?", day);
  let salt = sql.exec<{ salt: string }>("SELECT salt FROM pro_funnel_salts WHERE day = ?", day).toArray()[0]?.salt;
  if (!salt) {
    sql.exec("INSERT OR IGNORE INTO pro_funnel_salts (day, salt) VALUES (?, ?)", day, hex(crypto.getRandomValues(new Uint8Array(16))));
    salt = sql.exec<{ salt: string }>("SELECT salt FROM pro_funnel_salts WHERE day = ?", day).toArray()[0]!.salt;
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${githubId}`));
  const hash = hex(new Uint8Array(digest).slice(0, 12));
  // No await from here on: the check and the two writes happen together.
  const fresh = sql.exec("INSERT OR IGNORE INTO pro_funnel_people (day, step, hash) VALUES (?, ?, ?) RETURNING hash", day, step, hash).toArray().length > 0;
  if (fresh) sql.exec("INSERT INTO pro_funnel_daily (day, step, n) VALUES (?, ?, 1) ON CONFLICT (day, step) DO UPDATE SET n = n + 1", day, step);
  return fresh;
}

export interface ProFunnelDay {
  /** YYYY-MM-DD (UTC). */
  day: string;
  seen: number;
  clicked: number;
  paid: number;
  cancelled: number;
}

/** Every UTC day in [from, until) (Unix ms), oldest first, zeros included. */
export function proFunnelDays(sql: Sql, from: number, until: number): ProFunnelDay[] {
  const first = Math.floor(from / DAY_MS);
  const last = Math.ceil(until / DAY_MS);
  const days = new Map<number, ProFunnelDay>();
  for (let day = first; day < last; day++) days.set(day, { day: new Date(day * DAY_MS).toISOString().slice(0, 10), seen: 0, clicked: 0, paid: 0, cancelled: 0 });
  for (const row of sql.exec<{ day: number; step: string; n: number }>("SELECT day, step, n FROM pro_funnel_daily WHERE day >= ? AND day < ?", first, last).toArray()) {
    const entry = days.get(row.day);
    if (entry && isProFunnelStep(row.step)) entry[row.step] = row.n;
  }
  return [...days.values()];
}

/** People on Pro now (an active subscription, as the webhook mirrors it), admins left out. */
export function activePro(sql: Sql, adminIds: readonly number[]): number {
  return sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM subscriptions WHERE state = 'active' AND ${notAdmin("github_id")}`, JSON.stringify(adminIds)).toArray()[0]?.n ?? 0;
}

/** "dl Pro: 12 saw the prompt, 3 clicked Upgrade, 1 paid, 0 cancelled (total active Pro: 4)" */
export function proDigestLine(day: Omit<ProFunnelDay, "day">, active: number): string {
  return `dl Pro: ${day.seen} saw the prompt, ${day.clicked} clicked Upgrade, ${day.paid} paid, ${day.cancelled} cancelled (total active Pro: ${active})`;
}
