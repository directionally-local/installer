import { notAdmin, type Sql } from "./dashboard-data.js";
import { NORMAL_SESSION_ENDS, OPEN_GRACE_MS } from "./health-data.js";
import { modelById } from "./models.js";
import { DAY_MS, weekStart } from "./week.js";

/**
 * The admin home screen's numbers (GET /admin): a handful of small, indexed reads, so the page
 * that opens first stays fast. Nothing here scans the whole request log: spend comes from the
 * per-day upstream roll-up, people from the per-day activity roll-up, failures from this week's
 * slice of the request log and session starts, installs and GPUs from the per-day anonymous counts.
 * Admins are left out except in the per-provider spend and failure counts and the GPU counts,
 * which have no person attached. Counts, dollars and logins only: never content.
 */

/** Days of spend in the home screen's chart. */
export const SPEND_DAYS = 14;

export interface HomeSpendDay {
  /** The UTC day, as Unix ms. */
  day: number;
  openai: number;
  luminal: number;
  openrouter: number;
}

/** One person's week: what they used and what their level allows. */
export interface HomePerson {
  githubId: number;
  login: string | null;
  level: string | null;
  batchFlagged: boolean;
  /** An admin's per-person caps (the grants table); null for the level's own. */
  grantTokens: number | null;
  grantUsd: number | null;
  costUsd: number;
  tokens: number;
}

export interface HomeData {
  now: number;
  weekStart: number;
  /** Oldest first, SPEND_DAYS days ending today. Everyone's use, admins and paid included. */
  spendDays: HomeSpendDay[];
  /** People with a request or a session event today and this week, and sign-ups today. */
  people: { today: number; week: number; signupsToday: number };
  /** Everyone who used free tokens this week, most dollars first. */
  spenders: HomePerson[];
  /** This week's requests per model (admins left out), and how many failed. */
  models: Array<{ model: string; requests: number; failed: number }>;
  /** This week's finished installs per OS, chip and mode. */
  installs: Array<{ os: string; arch: string; mode: string; ok: number; failed: number }>;
  /** Sessions started this week: how many we can judge (ended, or quiet for OPEN_GRACE_MS), and how many ended abnormally. */
  sessions: { judged: number; abnormal: number };
  /** GPU first runs over the last GPU_DAYS UTC days, today included (anonymous: admins included). */
  gpus: HomeGpus;
  /** Requests and failures per provider, today and this week (admins included: no person here). */
  providers: Array<{ upstream: "openai" | "luminal" | "openrouter"; window: "today" | "week"; requests: number; errors: number }>;
}

/** Days of GPU first runs on the home screen. */
export const GPU_DAYS = 7;

export interface HomeGpus {
  /** First runs that found each vendor's GPU. */
  nvidia: number;
  amd: number;
  ascend: number;
  /** Picked "own GPUs" as their option. */
  ownGpus: number;
  /** Said yes to early access (AMD or Ascend). */
  earlyAccess: number;
}

/** Every home query starts with this comment, so a test can hold them to `HOME_COLUMNS`. */
export const HOME_QUERY_TAG = "/* home */";

/** Tables and columns the home screen may read. */
export const HOME_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  upstream_daily: ["day", "upstream", "requests", "errors", "cash_usd", "credit_usd"],
  daily_activity: ["day", "github_id", "requests", "events", "charged_tokens", "cost_usd"],
  people: ["github_id", "login", "admitted_at", "admitted_via", "level", "batch_flag"],
  grants: ["github_id", "weekly_tokens", "weekly_usd"],
  requests: ["github_id", "is_admin", "at", "model", "status"],
  install_daily: ["day", "os", "arch", "mode", "result", "installs"],
  events: ["github_id", "type", "session_id", "at", "props"],
  gpu_daily: ["day", "event", "vendor", "answer", "option", "n"],
};

export function homeData(store: Sql, input: { now: number; adminIds: readonly number[] }): HomeData {
  const sql: Sql = { exec: (query, ...bindings) => store.exec(`${HOME_QUERY_TAG} ${query}`, ...bindings) };
  const admins = JSON.stringify([...input.adminIds]);
  const { now } = input;
  const today = Math.floor(now / DAY_MS);
  const week = weekStart(now);
  const weekDay = week / DAY_MS;

  const byDay = new Map<number, HomeSpendDay>();
  for (let day = today - SPEND_DAYS + 1; day <= today; day++) byDay.set(day, { day: day * DAY_MS, openai: 0, luminal: 0, openrouter: 0 });
  const providers: HomeData["providers"] = [];
  const counts = new Map<string, { requests: number; errors: number }>();
  for (const row of sql
    .exec<{ day: number; upstream: string; requests: number; errors: number; cash: number; credit: number }>(
      "SELECT day, upstream, requests, errors, cash_usd AS cash, credit_usd AS credit FROM upstream_daily WHERE day >= ?",
      Math.min(today - SPEND_DAYS + 1, weekDay),
    )
    .toArray()) {
    const target = byDay.get(row.day);
    if (target && (row.upstream === "openai" || row.upstream === "luminal" || row.upstream === "openrouter")) target[row.upstream] += row.cash + row.credit;
    for (const window of [row.day === today ? "today" : null, row.day >= weekDay ? "week" : null]) {
      if (!window) continue;
      const key = `${row.upstream}:${window}`;
      const sum = counts.get(key) ?? { requests: 0, errors: 0 };
      sum.requests += row.requests;
      sum.errors += row.errors;
      counts.set(key, sum);
    }
  }
  for (const upstream of ["openai", "luminal", "openrouter"] as const) {
    for (const window of ["today", "week"] as const) providers.push({ upstream, window, ...(counts.get(`${upstream}:${window}`) ?? { requests: 0, errors: 0 }) });
  }

  const peopleRow = sql
    .exec<{ today: number | null; week: number | null }>(
      `SELECT COUNT(DISTINCT CASE WHEN day = ? THEN github_id END) AS today, COUNT(DISTINCT github_id) AS week
       FROM daily_activity WHERE day >= ? AND (requests > 0 OR events > 0) AND ${notAdmin("github_id")}`,
      today,
      weekDay,
      admins,
    )
    .toArray()[0];
  const signupsToday =
    sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM people WHERE admitted_at >= ? AND ${notAdmin("github_id")}`, today * DAY_MS, admins).toArray()[0]?.n ?? 0;

  const spenders = sql
    .exec<{ github_id: number; login: string | null; level: string | null; batch_flag: number | null; grant_tokens: number | null; grant_usd: number | null; cost: number; tokens: number }>(
      `SELECT d.github_id AS github_id, p.login AS login, p.level AS level, p.batch_flag AS batch_flag, g.weekly_tokens AS grant_tokens, g.weekly_usd AS grant_usd,
              SUM(d.cost_usd) AS cost, SUM(d.charged_tokens) AS tokens
       FROM daily_activity d LEFT JOIN people p ON p.github_id = d.github_id LEFT JOIN grants g ON g.github_id = d.github_id
       WHERE d.day >= ? AND d.requests > 0 AND ${notAdmin("d.github_id")}
       GROUP BY d.github_id ORDER BY cost DESC, tokens DESC, d.github_id`,
      weekDay,
      admins,
    )
    .toArray()
    .map(
      (row): HomePerson => ({
        githubId: row.github_id,
        login: row.login,
        level: row.level,
        batchFlagged: row.batch_flag === 1,
        grantTokens: row.grant_tokens,
        grantUsd: row.grant_usd,
        costUsd: row.cost,
        tokens: row.tokens,
      }),
    );

  const models = new Map<string, { model: string; requests: number; failed: number }>();
  for (const row of sql
    .exec<{ model: string; ok: number; n: number }>(
      `SELECT model, status = 'ok' AS ok, COUNT(*) AS n FROM requests WHERE at >= ? AND at <= ? AND is_admin = 0 AND ${notAdmin("github_id")} GROUP BY 1, 2`,
      week,
      now,
      admins,
    )
    .toArray()) {
    const entry = models.get(row.model) ?? { model: row.model, requests: 0, failed: 0 };
    entry.requests += row.n;
    if (!row.ok) entry.failed += row.n;
    models.set(row.model, entry);
  }

  const installs = sql
    .exec<{ os: string; arch: string; mode: string; ok: number; failed: number }>(
      `SELECT os, arch, mode, SUM(CASE WHEN result = 'ok' THEN installs ELSE 0 END) AS ok, SUM(CASE WHEN result = 'ok' THEN 0 ELSE installs END) AS failed
       FROM install_daily WHERE day >= ? GROUP BY os, arch, mode`,
      weekDay,
    )
    .toArray();

  const gpus: HomeGpus = { nvidia: 0, amd: 0, ascend: 0, ownGpus: 0, earlyAccess: 0 };
  for (const row of sql
    .exec<{ event: string; vendor: string; answer: string; option: string; n: number }>(
      `SELECT event, vendor, answer, option, SUM(n) AS n FROM gpu_daily
       WHERE day >= ? AND (event = 'detected' OR (event = 'option' AND option = 'gpus') OR (event = 'early_access' AND answer = 'yes'))
       GROUP BY event, vendor, answer, option`,
      today - GPU_DAYS + 1,
    )
    .toArray()) {
    if (row.event === "detected" && (row.vendor === "nvidia" || row.vendor === "amd" || row.vendor === "ascend")) gpus[row.vendor] += row.n;
    else if (row.event === "option") gpus.ownGpus += row.n;
    else if (row.event === "early_access") gpus.earlyAccess += row.n;
  }

  // Sessions started this week, as the Health view counts their ends: normal is exit or clear;
  // no end event is abnormal once the session has been quiet for OPEN_GRACE_MS (else it may be open).
  let judged = 0;
  let abnormal = 0;
  for (const row of sql
    .exec<{ last_at: number; ended: number; reason: string | null }>(
      `WITH s AS (SELECT github_id, session_id FROM events WHERE type = 'session.start' AND at >= ? AND at <= ? AND session_id IS NOT NULL AND ${notAdmin("github_id")})
       SELECT MAX(e.at) AS last_at, SUM(e.type = 'session.end') AS ended, MAX(CASE WHEN e.type = 'session.end' THEN json_extract(e.props, '$.exitReason') END) AS reason
       FROM s JOIN events e ON e.github_id = s.github_id AND e.session_id = s.session_id GROUP BY s.github_id, s.session_id`,
      week,
      now,
      admins,
    )
    .toArray()) {
    if (row.ended > 0) {
      judged++;
      if (!NORMAL_SESSION_ENDS.includes(row.reason ?? "")) abnormal++;
    } else if (now - row.last_at >= OPEN_GRACE_MS) {
      judged++;
      abnormal++;
    }
  }

  return {
    now,
    weekStart: week,
    spendDays: [...byDay.values()],
    people: { today: peopleRow?.today ?? 0, week: peopleRow?.week ?? 0, signupsToday },
    spenders,
    models: [...models.values()].sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model)),
    installs,
    sessions: { judged, abnormal },
    gpus,
    providers,
  };
}

// ─── Allowance per level ──────────────────────────────────────────────────

/** The settings a person's weekly allowance comes from (effective values). */
export interface LevelSettings {
  weeklyTokens: number;
  perPersonWeeklyUsd: number | null;
  basicWeeklyTokens: number;
  basicWeeklyUsd: number | null;
  starterWeeklyTokens: number;
  starterWeeklyUsd: number | null;
}

/** The tier in plain words: full, middle (basic), small (Starter) or no tokens. */
export type Tier = "full" | "middle" | "small" | "no tokens";

/**
 * A person's real weekly allowance, as app.ts `limitsFor` and the AccountObject compute it: basic
 * with its tokens at 0 is served as Starter; a batch-flagged Starter account gets 0 tokens; an
 * admin's grant sets Full's tokens and any level's dollar cap. Referral bonuses aren't counted.
 */
export function realAllowance(
  person: { level: string | null; batchFlagged: boolean; grantTokens: number | null; grantUsd: number | null },
  settings: LevelSettings,
): { tier: Tier; tokens: number; usd: number | null } {
  const level = person.level === "basic" && settings.basicWeeklyTokens <= 0 ? "starter" : person.level;
  const grantUsd = person.grantUsd;
  if (level === "basic") return { tier: "middle", tokens: settings.basicWeeklyTokens, usd: grantUsd ?? settings.basicWeeklyUsd };
  if (level === "starter") {
    const tokens = person.batchFlagged ? 0 : settings.starterWeeklyTokens;
    return { tier: tokens > 0 ? "small" : "no tokens", tokens, usd: tokens > 0 ? (grantUsd ?? settings.starterWeeklyUsd) : 0 };
  }
  return { tier: "full", tokens: person.grantTokens ?? settings.weeklyTokens, usd: grantUsd ?? settings.perPersonWeeklyUsd };
}

/** Within this share of the token allowance counts as reached (see dashboard-data.ts TOKEN_LIMIT_SHARE). */
const AT_CAP_TOKEN_SHARE = 0.99;

/** Whether this week's use reached the dollar cap, or (nearly) the tokens. Nobody with no tokens counts. */
export function atCap(person: Pick<HomePerson, "costUsd" | "tokens">, allowance: { tokens: number; usd: number | null }): boolean {
  if (allowance.tokens <= 0) return false;
  return (allowance.usd !== null && allowance.usd > 0 && person.costUsd >= allowance.usd - 1e-9) || person.tokens >= allowance.tokens * AT_CAP_TOKEN_SHARE;
}

/** A model id in plain words: its name ("GPT-6 Astra") when the free tier knows it. */
export function modelName(id: string): string {
  return modelById(id)?.name ?? id;
}
