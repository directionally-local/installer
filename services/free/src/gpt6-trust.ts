/**
 * Who GPT-6 is served to, once the owner turns the trust gate on (`gpt6TrustedWeeklyUsdCap`
 * above 0): trusted people only. Everyone else gets the GPT-6 limit's refusal pointing at
 * DeepSeek (402 gpt_limit, `reason` "trust", `alternative`), which every agent turns into
 * "switch to DeepSeek"; DeepSeek is unaffected.
 *
 * Trusted is any of:
 *
 *   - an admin;
 *   - someone who earned it, all of:
 *       level "full", and not flagged by the creation-batch check;
 *       active (a request or an event) on at least TRUST_MIN_WEEKS distinct UTC weeks;
 *       real multi-turn use: a session with at least TRUST_MIN_TURNS turns by Autopilot's events
 *         (turn.end, or a session.end's turn count), or, for agents that send no events, a
 *         session (its id, or the harness key of a `dl opencode` run) with at least
 *         TRUST_MIN_TURNS requests spread over at least TRUST_MIN_SPREAD_MS (`trust_sessions`);
 *       no high-risk use label and no moderation "block" or "watch" in TRUST_CLEAN_DAYS days.
 *
 * Paying is not a trust signal: a Pro subscription or a top-up never unlocks GPT-6 (dl Pro buys
 * more open models, not GPT-6). Every signal comes from the service's own records, never from Autopilot's events alone. A
 * blocked or suspended account is never trusted. The answer is cached per person for an hour
 * (`gpt6_trust`); a high-risk label or a block/watch verdict newer than the cached answer
 * drops a cached trust at once.
 */

import { DAY_MS } from "./week.js";

export const TRUST_MIN_WEEKS = 2;
export const TRUST_MIN_TURNS = 5;
export const TRUST_MIN_SPREAD_MS = 5 * 60_000;
export const TRUST_CLEAN_DAYS = 30;
export const TRUST_CACHE_MS = 60 * 60_000;
/** How long a session's request counts are kept. */
export const TRUST_SESSION_KEEP_MS = 90 * DAY_MS;

/** The gpt_limit refusal's message and `reason` for someone not (yet) trusted. */
export const UNTRUSTED_GPT6_MESSAGE = "GPT-6 on the free tier is for established accounts for now. DeepSeek V4.1 Flash still works: switch with /model.";
export const TRUST_REASON = "trust";

/**
 * Why someone is or isn't trusted. Trusted: "admin" or "earned". Not trusted, every
 * check that fails: "inactive" (blocked or suspended), "level", "batch_flagged", "weeks",
 * "multi_turn", "high_risk_label", "moderation".
 */
export type TrustReason = "admin" | "earned" | "unknown" | "inactive" | "level" | "batch_flagged" | "weeks" | "multi_turn" | "high_risk_label" | "moderation";

export interface Trust {
  trusted: boolean;
  reasons: TrustReason[];
}

/** One person's facts, from the Directory's tables. */
export interface TrustFacts {
  known: boolean;
  status: string;
  level: string;
  batchFlagged: boolean;
  activeWeeks: number;
  multiTurn: boolean;
  highRiskLabel: boolean;
  moderation: boolean;
}

/** The rules above, on one person's facts. */
export function trustOf(facts: TrustFacts, isAdmin = false): Trust {
  if (isAdmin) return { trusted: true, reasons: ["admin"] };
  if (!facts.known) return { trusted: false, reasons: ["unknown"] };
  if (facts.status !== "active") return { trusted: false, reasons: ["inactive"] };
  const failing: TrustReason[] = [];
  if (facts.level !== "full") failing.push("level");
  if (facts.batchFlagged) failing.push("batch_flagged");
  if (facts.activeWeeks < TRUST_MIN_WEEKS) failing.push("weeks");
  if (!facts.multiTurn) failing.push("multi_turn");
  if (facts.highRiskLabel) failing.push("high_risk_label");
  if (facts.moderation) failing.push("moderation");
  return failing.length === 0 ? { trusted: true, reasons: ["earned"] } : { trusted: false, reasons: failing };
}

/** The tables this needs, created with the Directory's own (directory-object.ts SCHEMA). */
export const GPT6_GUARD_SCHEMA = [
  // Per person per session (its id, or "harness:<key id>"): requests and when the first and
  // latest were. What shows multi-turn use for agents that send no session events. Counts only.
  `CREATE TABLE IF NOT EXISTS trust_sessions (
     github_id   INTEGER NOT NULL,
     session_key TEXT NOT NULL,
     requests    INTEGER NOT NULL,
     first_at    INTEGER NOT NULL,
     last_at     INTEGER NOT NULL,
     PRIMARY KEY (github_id, session_key)
   ) WITHOUT ROWID`,
  // The trust answer per person, cached for TRUST_CACHE_MS.
  `CREATE TABLE IF NOT EXISTS gpt6_trust (
     github_id   INTEGER PRIMARY KEY,
     trusted     INTEGER NOT NULL,
     reasons     TEXT NOT NULL,
     computed_at INTEGER NOT NULL
   )`,
  // Pre-send check outcomes per UTC day (presend-guard.ts GUARD_OUTCOMES): counts only.
  `CREATE TABLE IF NOT EXISTS gpt6_guard_daily (
     day     INTEGER NOT NULL,
     outcome TEXT NOT NULL,
     n       INTEGER NOT NULL,
     PRIMARY KEY (day, outcome)
   ) WITHOUT ROWID`,
];

/** The part of Durable Object SQL storage used here. */
interface Sql {
  exec<T extends Record<string, unknown> = Record<string, unknown>>(query: string, ...bindings: unknown[]): { toArray(): T[]; one(): T };
}

/** Counts one request of a session; once a UTC day, drops sessions idle for TRUST_SESSION_KEEP_MS. */
export function noteTrustSession(sql: Sql, githubId: number, sessionKey: string, now: number): void {
  sql.exec(
    `INSERT INTO trust_sessions (github_id, session_key, requests, first_at, last_at) VALUES (?, ?, 1, ?, ?)
     ON CONFLICT (github_id, session_key) DO UPDATE SET requests = requests + 1, last_at = MAX(last_at, excluded.last_at)`,
    githubId,
    sessionKey.slice(0, 300),
    now,
    now,
  );
  const day = String(Math.floor(now / DAY_MS));
  if (sql.exec<{ value: string }>("SELECT value FROM settings WHERE key = 'trust:pruned_day'").toArray()[0]?.value === day) return;
  sql.exec("DELETE FROM trust_sessions WHERE last_at < ?", now - TRUST_SESSION_KEEP_MS);
  sql.exec("INSERT INTO settings (key, value) VALUES ('trust:pruned_day', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", day);
}

const WEEK_INDEX = (dayColumn: string) => `((${dayColumn}) + 3) / 7`;

/**
 * Facts for `githubIds` (everyone when undefined), in a few whole-table reads. High-risk labels
 * and block/watch verdicts from the last TRUST_CLEAN_DAYS days count against trust.
 */
export function trustFacts(sql: Sql, now: number, githubIds?: readonly number[]): Map<number, TrustFacts> {
  const only = githubIds ? JSON.stringify(githubIds) : null;
  const filter = (column: string) => (only ? ` AND ${column} IN (SELECT value FROM json_each('${only}'))` : "");
  const since = now - TRUST_CLEAN_DAYS * DAY_MS;
  const out = new Map<number, TrustFacts>();
  for (const row of sql
    .exec<{ github_id: number; status: string; level: string; batch_flag: number }>(`SELECT github_id, status, level, batch_flag FROM people WHERE 1 = 1${filter("github_id")}`)
    .toArray()) {
    out.set(row.github_id, { known: true, status: row.status, level: row.level, batchFlagged: row.batch_flag === 1, activeWeeks: 0, multiTurn: false, highRiskLabel: false, moderation: false });
  }
  const each = (ids: Iterable<{ github_id: number }>, set: (facts: TrustFacts, row: never) => void) => {
    for (const row of ids) {
      const facts = out.get(row.github_id);
      if (facts) set(facts, row as never);
    }
  };
  each(
    sql.exec<{ github_id: number; weeks: number }>(`SELECT github_id, COUNT(DISTINCT ${WEEK_INDEX("day")}) AS weeks FROM daily_activity WHERE (requests > 0 OR events > 0)${filter("github_id")} GROUP BY github_id`).toArray(),
    (facts, row: { weeks: number }) => (facts.activeWeeks = row.weeks),
  );
  // Autopilot's events: TRUST_MIN_TURNS turn.end in one session, or a session.end's turn count, ever
  // (kept in `person_events` by the Directory's recordEvents, so it outlives the raw events).
  each(sql.exec<{ github_id: number }>(`SELECT github_id FROM person_events WHERE multi_turn = 1${filter("github_id")}`).toArray(), (facts) => (facts.multiTurn = true));
  // Any agent: a session with enough requests spread over enough time.
  each(
    sql.exec<{ github_id: number }>(`SELECT DISTINCT github_id FROM trust_sessions WHERE requests >= ${TRUST_MIN_TURNS} AND last_at - first_at >= ${TRUST_MIN_SPREAD_MS}${filter("github_id")}`).toArray(),
    (facts) => (facts.multiTurn = true),
  );
  each(sql.exec<{ github_id: number }>(`SELECT DISTINCT github_id FROM use_descriptions WHERE risk = 'high' AND created_at >= ?${filter("github_id")}`, since).toArray(), (facts) => (facts.highRiskLabel = true));
  each(sql.exec<{ github_id: number }>(`SELECT DISTINCT github_id FROM moderation_decisions WHERE verdict IN ('block', 'watch') AND created_at >= ?${filter("github_id")}`, since).toArray(), (facts) => (facts.moderation = true));
  return out;
}

const UNKNOWN: TrustFacts = { known: false, status: "", level: "", batchFlagged: false, activeWeeks: 0, multiTurn: false, highRiskLabel: false, moderation: false };

/** Whether anything that drops trust happened to `githubId` at or after `at`. */
function droppedSince(sql: Sql, githubId: number, at: number): boolean {
  return (
    sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM use_descriptions WHERE github_id = ? AND risk = 'high' AND created_at >= ?", githubId, at).one().n > 0 ||
    sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM moderation_decisions WHERE github_id = ? AND verdict IN ('block', 'watch') AND created_at >= ?", githubId, at).one().n > 0 ||
    sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM people WHERE github_id = ? AND status != 'active'", githubId).one().n > 0
  );
}

/** One person's trust (not an admin: the caller checks that), from the hour's cache or worked out and cached. */
export function personTrust(sql: Sql, githubId: number, now: number): Trust {
  const cached = sql.exec<{ trusted: number; reasons: string; computed_at: number }>("SELECT trusted, reasons, computed_at FROM gpt6_trust WHERE github_id = ?", githubId).toArray()[0];
  // A cached "paid" (from before paying stopped counting) is worked out again.
  const stale = cached !== undefined && cached.reasons.includes('"paid"');
  if (cached && !stale && now - cached.computed_at < TRUST_CACHE_MS && now >= cached.computed_at && !(cached.trusted === 1 && droppedSince(sql, githubId, cached.computed_at))) {
    return { trusted: cached.trusted === 1, reasons: JSON.parse(cached.reasons) as TrustReason[] };
  }
  const trust = trustOf(trustFacts(sql, now, [githubId]).get(githubId) ?? UNKNOWN);
  sql.exec(
    `INSERT INTO gpt6_trust (github_id, trusted, reasons, computed_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (github_id) DO UPDATE SET trusted = excluded.trusted, reasons = excluded.reasons, computed_at = excluded.computed_at`,
    githubId,
    trust.trusted ? 1 : 0,
    JSON.stringify(trust.reasons),
    now,
  );
  return trust;
}

/** Everyone's trust, worked out fresh (the admin people list and metrics). */
export function everyonesTrust(sql: Sql, now: number, adminIds: ReadonlySet<number>): Map<number, Trust> {
  const out = new Map<number, Trust>();
  for (const [githubId, facts] of trustFacts(sql, now)) out.set(githubId, trustOf(facts, adminIds.has(githubId)));
  return out;
}

/** Adds to today's pre-send counters. */
export function countGuard(sql: Sql, outcomes: readonly string[], now: number): void {
  const day = Math.floor(now / DAY_MS);
  for (const outcome of outcomes) {
    sql.exec(`INSERT INTO gpt6_guard_daily (day, outcome, n) VALUES (?, ?, 1) ON CONFLICT (day, outcome) DO UPDATE SET n = n + 1`, day, outcome);
  }
}

/** The pre-send counters per UTC day in [from, to), oldest first, every outcome present (0 for none). */
export function guardDays(sql: Sql, from: number, to: number, outcomes: readonly string[]): Array<Record<string, number | string>> {
  const days = new Map<number, Record<string, number | string>>();
  for (const row of sql.exec<{ day: number; outcome: string; n: number }>("SELECT day, outcome, n FROM gpt6_guard_daily WHERE day >= ? AND day < ? ORDER BY day", Math.floor(from / DAY_MS), Math.ceil(to / DAY_MS)).toArray()) {
    let entry = days.get(row.day);
    if (!entry) {
      entry = { day: new Date(row.day * DAY_MS).toISOString().slice(0, 10), ...Object.fromEntries(outcomes.map((outcome) => [outcome, 0])) };
      days.set(row.day, entry);
    }
    entry[row.outcome] = row.n;
  }
  return [...days.values()];
}
