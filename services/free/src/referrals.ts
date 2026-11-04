import type { Sql } from "./dashboard-data.js";
import { DAY_MS, weekStart } from "./week.js";

/**
 * Referrals. Everyone admitted gets a code, their GitHub login lowercased, mapped to the
 * numeric GitHub id; the link is `REFERRAL_LINK_BASE + code` (https://dl.new/r/<code>). The
 * code never changes, even when the login does. If a login's code is already someone else's
 * (a login that changed hands), the code is `<login>-<id in base 36>`.
 *
 * A sign-up can carry a code (`POST /v1/device/code {referral_code}`, or `/device?ref=`). It
 * is recorded once, for new accounts only, with an outcome:
 *
 *   ok            counts
 *   self          the code is the person's own login
 *   unknown_code  no such code
 *   same_network  the two accounts were seen on the same network (IPv4 address or IPv6 /64),
 *                 at sign-up or at any later sign-in of either; a pair can turn into this later
 *
 * The same device can't hold both accounts at all (a device keeps one grant), and the
 * per-network limit of 3 new accounts a day applies to referred sign-ups like any other.
 *
 * A person is weekly active in a Monday–Sunday UTC week when they made requests on
 * `ACTIVE_DAYS` (3) or more distinct days of it. For the current week W, an `ok` pair counts
 * when both people are weekly active in W − 1 or (so far) in W: it starts the day both reach
 * 3 days, and lasts while both stay weekly active. Each counting pair gives both sides
 * `referralBonusTokens` (10M) a week, up to `referralBonusCap` (50M) a week per person. The
 * bonus is free tokens, so its cost counts against the free budget like any other free use.
 *
 * In the queue, each referred friend who has been weekly active in any week moves the
 * referrer up `queueReferralPlaces` places.
 */

export const ACTIVE_DAYS = 3;
export type ReferralOutcome = "ok" | "self" | "unknown_code" | "same_network";

const CODE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?(?:-[a-z0-9]{1,12})?$/;

/** A code from a client or a link: `Foo`, `foo`, `https://dl.new/r/foo`. Undefined when it isn't one. */
export function normalizeReferralCode(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let value = raw.trim();
  if (value.length === 0 || value.length > 200) return undefined;
  const fromLink = /\/r\/([^/?#\s]+)\/?(?:[?#].*)?$/.exec(value);
  if (fromLink) value = fromLink[1]!;
  value = value.toLowerCase();
  return CODE.test(value) ? value : undefined;
}

export function referralLink(base: string, code: string): string {
  return `${base}${code}`;
}

/** The code for a login, given whether its plain form is taken by someone else. */
export function codeFor(login: string, githubId: number, plainTaken: boolean): string {
  const plain = login.toLowerCase();
  return plainTaken || !CODE.test(plain) ? `${plain.replace(/[^a-z0-9-]/g, "").slice(0, 39) || "dl"}-${githubId.toString(36)}` : plain;
}

/** Monday's day number for a day number (1970-01-01 was a Thursday). */
export const WEEK_OF_DAY = "(day - ((day + 3) % 7))";

/** Per person, the weeks (Monday day numbers) from `fromWeekDay` on in which they were weekly active. */
export function activeWeeks(sql: Sql, ids: readonly number[], fromWeekDay: number): Map<number, Set<number>> {
  const out = new Map<number, Set<number>>();
  if (ids.length === 0) return out;
  const rows = sql
    .exec<{ github_id: number; week: number }>(
      `SELECT github_id, ${WEEK_OF_DAY} AS week FROM daily_activity
       WHERE github_id IN (SELECT value FROM json_each(?)) AND day >= ? AND requests > 0
       GROUP BY github_id, week HAVING COUNT(*) >= ${ACTIVE_DAYS}`,
      JSON.stringify([...new Set(ids)]),
      fromWeekDay,
    )
    .toArray();
  for (const row of rows) {
    let weeks = out.get(row.github_id);
    if (!weeks) out.set(row.github_id, (weeks = new Set()));
    weeks.add(row.week);
  }
  return out;
}

export interface Pair {
  referrer: number;
  referred: number;
}

/** The pairs that count this week: both weekly active last week or this week so far. */
export function countingPairs(sql: Sql, pairs: readonly Pair[], now: number): Pair[] {
  const thisWeek = weekStart(now) / DAY_MS;
  const ids = pairs.flatMap((pair) => [pair.referrer, pair.referred]);
  const weeks = activeWeeks(sql, ids, thisWeek - 7);
  const active = (id: number) => {
    const set = weeks.get(id);
    return set !== undefined && (set.has(thisWeek) || set.has(thisWeek - 7));
  };
  return pairs.filter((pair) => active(pair.referrer) && active(pair.referred));
}

export interface BonusRules {
  referralBonusTokens: number;
  referralBonusCap: number;
}

/** Each person's bonus tokens this week from counting pairs. */
export function bonuses(counting: readonly Pair[], rules: BonusRules): Map<number, number> {
  const pairsPer = new Map<number, number>();
  for (const pair of counting) {
    pairsPer.set(pair.referrer, (pairsPer.get(pair.referrer) ?? 0) + 1);
    pairsPer.set(pair.referred, (pairsPer.get(pair.referred) ?? 0) + 1);
  }
  const out = new Map<number, number>();
  for (const [id, count] of pairsPer) out.set(id, Math.min(rules.referralBonusCap, count * rules.referralBonusTokens));
  return out;
}

/** Referred friends (ok pairs) who have been weekly active in any week, per referrer. */
export function everActiveFriends(sql: Sql, referrers: readonly number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (referrers.length === 0) return out;
  const rows = sql
    .exec<{ referrer_id: number; n: number }>(
      `SELECT r.referrer_id AS referrer_id, COUNT(*) AS n FROM referrals r
       WHERE r.outcome = 'ok' AND r.referrer_id IN (SELECT value FROM json_each(?))
         AND EXISTS (SELECT 1 FROM daily_activity d WHERE d.github_id = r.referred_id AND d.requests > 0
                     GROUP BY ${WEEK_OF_DAY.replace(/day/g, "d.day")} HAVING COUNT(*) >= ${ACTIVE_DAYS})
       GROUP BY r.referrer_id`,
      JSON.stringify([...new Set(referrers)]),
    )
    .toArray();
  for (const row of rows) out.set(row.referrer_id, row.n);
  return out;
}
