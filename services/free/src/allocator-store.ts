/**
 * The token allocator's storage in the Directory (allocator.ts): each decision, and per person
 * the step reached and this week's grace. Counts, codes and the model's short reason only; never
 * prompts or other content.
 */

import {
  ALLOCATOR_BURST_MS,
  ALLOCATOR_COOLDOWN_MS,
  ALLOCATOR_HISTORY_DAYS,
  ALLOCATOR_HISTORY_ROWS,
  ALLOCATOR_LOG_ROWS,
  ALLOCATOR_STAGES,
  ALLOCATOR_TIMING_ROWS,
  logSessions,
  type AllocatorFacts,
  type AllocatorOutcome,
  type AllocatorStage,
  type AllocatorState,
  type FinishInput,
} from "./allocator.js";
import { DAY_MS, isoDay, weekStart } from "./week.js";

interface Sql {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): { toArray(): T[] };
}

export const ALLOCATOR_SCHEMA = [
  // One row per decision (and per grace). `outcome`: 10m, full, stay, error, pending, grace.
  // `decision` is the model's own answer, `rule` the hard rule that overrode it, `inputs` a JSON
  // object of counts (allocator.ts inputSummary).
  `CREATE TABLE IF NOT EXISTS allocator_decisions (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     github_id   INTEGER NOT NULL,
     at          INTEGER NOT NULL,
     from_tokens INTEGER NOT NULL,
     to_tokens   INTEGER NOT NULL,
     outcome     TEXT NOT NULL,
     decision    TEXT,
     reason      TEXT NOT NULL,
     rule        TEXT,
     model       TEXT NOT NULL,
     error       TEXT,
     inputs      TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS allocator_decisions_at ON allocator_decisions (at)`,
  `CREATE INDEX IF NOT EXISTS allocator_decisions_person ON allocator_decisions (github_id, from_tokens, at)`,
  `CREATE TABLE IF NOT EXISTS allocator_state (
     github_id    INTEGER PRIMARY KEY,
     stage        TEXT NOT NULL,
     updated_at   INTEGER NOT NULL,
     grace_week   INTEGER,
     grace_tokens INTEGER NOT NULL DEFAULT 0
   )`,
];

/** Decisions are kept this long. */
export const ALLOCATOR_KEEP_DAYS = 90;

export function ensureAllocatorSchema(sql: Sql): void {
  for (const statement of ALLOCATOR_SCHEMA) sql.exec(statement);
}

function isStage(value: unknown): value is AllocatorStage {
  return typeof value === "string" && (ALLOCATOR_STAGES as readonly string[]).includes(value);
}

/** A person's allocator state, or null when nothing was decided for them yet. */
export function allocatorState(sql: Sql, githubId: number): AllocatorState | null {
  const row = sql.exec<{ stage: string; grace_week: number | null; grace_tokens: number }>("SELECT stage, grace_week, grace_tokens FROM allocator_state WHERE github_id = ?", githubId).toArray()[0];
  if (!row) return null;
  return { stage: isStage(row.stage) ? row.stage : "start", graceWeek: row.grace_week, graceTokens: row.grace_tokens };
}

/**
 * Claims a decision for (person, step): a "pending" row, or null when one was claimed for the
 * same step within ALLOCATOR_COOLDOWN_MS (graces aside).
 */
export function claimAllocation(sql: Sql, input: { githubId: number; fromTokens: number; now: number; model: string }): number | null {
  const recent = sql
    .exec("SELECT 1 FROM allocator_decisions WHERE github_id = ? AND from_tokens = ? AND outcome != 'grace' AND at > ? LIMIT 1", input.githubId, input.fromTokens, input.now - ALLOCATOR_COOLDOWN_MS)
    .toArray();
  if (recent.length > 0) return null;
  sql.exec("DELETE FROM allocator_decisions WHERE at < ?", input.now - ALLOCATOR_KEEP_DAYS * DAY_MS);
  const row = sql
    .exec<{ id: number }>(
      "INSERT INTO allocator_decisions (github_id, at, from_tokens, to_tokens, outcome, reason, model, error, inputs) VALUES (?, ?, ?, ?, 'pending', '', ?, 'unfinished', '{}') RETURNING id",
      input.githubId,
      input.now,
      input.fromTokens,
      input.fromTokens,
      input.model,
    )
    .toArray()[0];
  return row?.id ?? null;
}

/** The newest decision for (person, step) within the cooldown, graces left out. */
export function allocatorStatus(sql: Sql, input: { githubId: number; fromTokens: number; now: number }): { id: number; outcome: AllocatorOutcome; at: number } | null {
  const row = sql
    .exec<{ id: number; outcome: string; at: number }>(
      "SELECT id, outcome, at FROM allocator_decisions WHERE github_id = ? AND from_tokens = ? AND outcome != 'grace' AND at > ? ORDER BY at DESC, id DESC LIMIT 1",
      input.githubId,
      input.fromTokens,
      input.now - ALLOCATOR_COOLDOWN_MS,
    )
    .toArray()[0];
  return row ? { id: row.id, outcome: row.outcome as AllocatorOutcome, at: row.at } : null;
}

/** A decision's end: the row filled in, and a raise stored as the person's step (never lowered). */
export function finishAllocation(sql: Sql, input: FinishInput): AllocatorState | null {
  sql.exec(
    "UPDATE allocator_decisions SET to_tokens = ?, outcome = ?, decision = ?, reason = ?, rule = ?, model = ?, error = ?, inputs = ? WHERE id = ?",
    input.toTokens,
    input.outcome,
    input.decision,
    input.reason,
    input.rule,
    input.model,
    input.error,
    JSON.stringify(input.inputs),
    input.decisionId,
  );
  if (input.outcome === "10m" || input.outcome === "full") {
    const before = allocatorState(sql, input.githubId);
    if (!before || ALLOCATOR_STAGES.indexOf(input.stage) > ALLOCATOR_STAGES.indexOf(before.stage)) {
      sql.exec(
        `INSERT INTO allocator_state (github_id, stage, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (github_id) DO UPDATE SET stage = excluded.stage, updated_at = excluded.updated_at`,
        input.githubId,
        input.stage,
        input.now,
      );
    }
  }
  return allocatorState(sql, input.githubId);
}

/**
 * The one-time grace for this week: `graceTokens` on top of the allowance until Monday, recorded
 * as a "grace" row. Null when this week's grace was already given.
 */
export function allocatorGrace(sql: Sql, input: { githubId: number; fromTokens: number; graceTokens: number; reason: string; model: string; now: number }): AllocatorState | null {
  const week = weekStart(input.now);
  const before = allocatorState(sql, input.githubId);
  if (before?.graceWeek === week) return null;
  sql.exec(
    `INSERT INTO allocator_state (github_id, stage, updated_at, grace_week, grace_tokens) VALUES (?, 'start', ?, ?, ?)
     ON CONFLICT (github_id) DO UPDATE SET grace_week = excluded.grace_week, grace_tokens = excluded.grace_tokens, updated_at = excluded.updated_at`,
    input.githubId,
    input.now,
    week,
    input.graceTokens,
  );
  sql.exec(
    "INSERT INTO allocator_decisions (github_id, at, from_tokens, to_tokens, outcome, reason, model, inputs) VALUES (?, ?, ?, ?, 'grace', ?, ?, '{}')",
    input.githubId,
    input.now,
    input.fromTokens,
    input.fromTokens + input.graceTokens,
    input.reason,
    input.model,
  );
  return allocatorState(sql, input.githubId);
}

/** The facts one decision reads (allocator.ts AllocatorFacts); undefined when the person is gone. */
export function allocatorFacts(sql: Sql, input: { githubId: number; now: number }): AllocatorFacts | undefined {
  const id = input.githubId;
  const person = sql
    .exec<{
      status: string;
      level: string;
      level_reason: string | null;
      batch_flag: number;
      account_age_days: number | null;
      public_repos: number | null;
      contributions: number | null;
      followers: number | null;
      active_weeks: number | null;
    }>("SELECT status, level, level_reason, batch_flag, account_age_days, public_repos, contributions, followers, active_weeks FROM people WHERE github_id = ?", id)
    .toArray()[0];
  if (!person) return undefined;
  const since = input.now - ALLOCATOR_HISTORY_DAYS * DAY_MS;
  const descriptions = sql
    .exec<{ day: number; use: string; category: string; risk: string }>(
      "SELECT day, use, category, risk FROM use_descriptions WHERE github_id = ? AND created_at >= ? ORDER BY created_at DESC, id DESC LIMIT ?",
      id,
      since,
      ALLOCATOR_HISTORY_ROWS,
    )
    .toArray()
    .map((row) => ({ day: isoDay(row.day * DAY_MS), use: row.use, category: row.category, risk: row.risk }));
  const labels = sql.exec<{ n: number; high: number | null }>("SELECT COUNT(*) AS n, SUM(risk = 'high') AS high FROM use_descriptions WHERE github_id = ? AND created_at >= ?", id, since).toArray()[0];
  const perSession = sql
    .exec<{ turns: number }>(
      "SELECT SUM(type = 'turn.end') AS turns FROM events WHERE github_id = ? AND at >= ? AND session_id IS NOT NULL GROUP BY session_id",
      id,
      since,
    )
    .toArray();
  const log = sql
    .exec<{ at: number; session_key: string | null; harness: string | null }>("SELECT at, session_key, harness FROM requests WHERE github_id = ? AND at >= ? ORDER BY at DESC LIMIT ?", id, since, ALLOCATOR_LOG_ROWS)
    .toArray()
    .reverse()
    .map((row) => ({ at: row.at, sessionKey: row.session_key, harness: row.harness }));
  const activeDays = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM daily_activity WHERE github_id = ? AND day >= ? AND requests > 0", id, Math.floor(since / DAY_MS)).toArray()[0]?.n ?? 0;
  const activeWeeks = sql.exec<{ n: number }>("SELECT COUNT(DISTINCT (day - ((day + 3) % 7))) AS n FROM daily_activity WHERE github_id = ? AND requests > 0", id).toArray()[0]?.n ?? 0;
  const times = sql
    .exec<{ at: number }>("SELECT at FROM requests WHERE github_id = ? AND at >= ? ORDER BY at DESC LIMIT ?", id, input.now - 7 * DAY_MS, ALLOCATOR_TIMING_ROWS)
    .toArray()
    .map((row) => row.at)
    .reverse();
  let bursts = 0;
  for (let i = 1; i < times.length; i++) if (times[i]! - times[i - 1]! < ALLOCATOR_BURST_MS) bursts++;
  const hours = new Set(times.map((at) => Math.floor((at % DAY_MS) / 3_600_000)));
  const networks = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM person_networks WHERE github_id = ?", id).toArray()[0]?.n ?? 0;
  const shared = sql.exec("SELECT 1 FROM device_refusals WHERE github_id = ? OR holder_id = ? LIMIT 1", id, id).toArray().length > 0;
  const moderation = { block: 0, watch: 0, pass: 0 };
  for (const row of sql
    .exec<{ verdict: string; n: number }>("SELECT verdict, COUNT(*) AS n FROM moderation_decisions WHERE github_id = ? AND created_at >= ? AND error IS NULL AND reason != 'review failed' GROUP BY verdict", id, since)
    .toArray()) {
    if (row.verdict === "block" || row.verdict === "watch" || row.verdict === "pass") moderation[row.verdict] = row.n;
  }
  return {
    githubId: id,
    status: person.status,
    level: person.level,
    levelReason: person.level_reason,
    batchFlagged: person.batch_flag === 1,
    sharedDevice: shared,
    networks,
    github: { accountAgeDays: person.account_age_days, publicRepos: person.public_repos, contributions: person.contributions, followers: person.followers, activeWeeks: person.active_weeks },
    descriptions,
    descriptionCount: labels?.n ?? 0,
    highRisk: labels?.high ?? 0,
    sessions: perSession.length,
    turns: perSession.reduce((sum, row) => sum + (row.turns ?? 0), 0),
    oneTurnSessions: perSession.filter((row) => (row.turns ?? 0) <= 1).length,
    requestLog: logSessions(log),
    activeDays,
    activeWeeks,
    timing: { requests: times.length, burstShare: times.length > 1 ? bursts / (times.length - 1) : 0, hoursOfDay: hours.size },
    moderation,
  };
}

/** One stored decision, as GET /admin/allocator lists it. No content. */
export interface AllocatorRow {
  githubId: number;
  login: string | null;
  at: number;
  fromTokens: number;
  toTokens: number;
  outcome: string;
  decision: string | null;
  reason: string;
  rule: string | null;
  model: string;
  error: string | null;
  inputs: Record<string, number>;
}

export function allocatorDecisions(sql: Sql, input: { since: number; limit: number }): AllocatorRow[] {
  return sql
    .exec<{ github_id: number; login: string | null; at: number; from_tokens: number; to_tokens: number; outcome: string; decision: string | null; reason: string; rule: string | null; model: string; error: string | null; inputs: string }>(
      `SELECT a.github_id, p.login, a.at, a.from_tokens, a.to_tokens, a.outcome, a.decision, a.reason, a.rule, a.model, a.error, a.inputs
       FROM allocator_decisions a LEFT JOIN people p ON p.github_id = a.github_id
       WHERE a.at >= ? ORDER BY a.at DESC, a.id DESC LIMIT ?`,
      input.since,
      input.limit,
    )
    .toArray()
    .map((row) => {
      let inputs: Record<string, number> = {};
      try {
        const parsed: unknown = JSON.parse(row.inputs);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) inputs = parsed as Record<string, number>;
      } catch {
        // Always written as a JSON object.
      }
      return { githubId: row.github_id, login: row.login, at: row.at, fromTokens: row.from_tokens, toTokens: row.to_tokens, outcome: row.outcome, decision: row.decision, reason: row.reason, rule: row.rule, model: row.model, error: row.error, inputs };
    });
}

/** Decisions per outcome for one span (the daily digest and the admin metrics). */
export interface AllocatorCounts {
  raised10m: number;
  raisedFull: number;
  stayed: number;
  errors: number;
  graces: number;
  pending: number;
}

export function allocatorCounts(sql: Sql, from: number, until: number): AllocatorCounts {
  const counts: AllocatorCounts = { raised10m: 0, raisedFull: 0, stayed: 0, errors: 0, graces: 0, pending: 0 };
  for (const row of sql.exec<{ outcome: string; n: number }>("SELECT outcome, COUNT(*) AS n FROM allocator_decisions WHERE at >= ? AND at < ? GROUP BY outcome", from, until).toArray()) {
    if (row.outcome === "10m") counts.raised10m = row.n;
    else if (row.outcome === "full") counts.raisedFull = row.n;
    else if (row.outcome === "stay") counts.stayed = row.n;
    else if (row.outcome === "error") counts.errors = row.n;
    else if (row.outcome === "grace") counts.graces = row.n;
    else if (row.outcome === "pending") counts.pending = row.n;
  }
  return counts;
}

/** Counts per UTC day for the last `days` days, newest first. */
export function allocatorDaily(sql: Sql, now: number, days: number): Array<{ date: string } & AllocatorCounts> {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const out: Array<{ date: string } & AllocatorCounts> = [];
  for (let i = 0; i < days; i++) {
    const from = today - i * DAY_MS;
    out.push({ date: isoDay(from), ...allocatorCounts(sql, from, from + DAY_MS) });
  }
  return out;
}
