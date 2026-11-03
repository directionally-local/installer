import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import { sha256Hex } from "../../shared/src/auth.js";
import { newInviteCode, normalizeInviteCode } from "./codes.js";
import { dashboardData, type DashboardData, type DashboardLimits } from "./dashboard-data.js";
import type { CleanEvent } from "./events.js";
import { readOverrides, type Overrides, type SettingChange } from "./runtime-config.js";
import { DAY_MS, isoDay, WEEK_MS, weekEnd, weekStart } from "./week.js";

/**
 * Who is in, and what they used. One object (`getByName("directory")`): admissions, invite
 * codes, the one-grant-per-device map, the admin kill switch, the per-request records and
 * session events, the weekly spend, and the metrics computed from them.
 *
 * Per-request records hold counts only: tokens in, cached and out, cost, model, status,
 * latency and time. Never prompt or completion content.
 *
 * A single object is enough for the first cohorts (tens to a few hundred people); the
 * per-person allowance lives in AccountObject, so the hot reserve/settle path doesn't queue
 * here except for one gate read and one record write per request.
 */

export type AdmitResult =
  | { ok: true; created: boolean; via: "existing" | "admin" | "open" | "invite" }
  | { ok: false; reason: "needs_invite" | "invalid_invite" | "cohort_full" | "device_taken" };

/** One logged change to a runtime setting or the kill switch. */
export interface ConfigChange {
  id: number;
  key: string;
  oldValue: unknown;
  newValue: unknown;
  changedBy: number;
  changedByLogin: string;
  changedAt: string;
}

export interface PersonRow {
  github_id: number;
  login: string;
  status: "active" | "suspended";
  admitted_at: number;
  admitted_via: string;
}

export interface RequestRecord {
  githubId: number;
  /** Admin usage is kept apart from the global caps. */
  isAdmin: boolean;
  at: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  chargedTokens: number;
  costUsd: number;
  /** ok | upstream_error | stream_error | abandoned */
  status: string;
  latencyMs: number | null;
}

export interface SpendSummary {
  weekStart: number;
  resetsAt: number;
  /** Everyone but admins: what the global caps count. */
  spentUsd: number;
  tokens: number;
  requests: number;
  /** Admins and the owner, tracked apart. */
  adminSpentUsd: number;
  adminTokens: number;
  adminRequests: number;
  /** Everyone but admins, since the service started. */
  totalSpentUsd: number;
  adminTotalSpentUsd: number;
}

const ACTIVITY = `(SELECT github_id, at FROM requests UNION ALL SELECT github_id, at FROM events)`;
/** Monday 00:00 UTC of `at`, in SQL: 1970-01-01 was a Thursday. */
const WEEK_OF = (column: string) => `(((${column}) / ${DAY_MS}) - ((((${column}) / ${DAY_MS}) + 3) % 7)) * ${DAY_MS}`;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS people (
     github_id    INTEGER PRIMARY KEY,
     login        TEXT NOT NULL,
     status       TEXT NOT NULL,
     admitted_at  INTEGER NOT NULL,
     admitted_via TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS invites (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     code_hash  TEXT NOT NULL UNIQUE,
     note       TEXT,
     created_by INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     used_by    INTEGER,
     used_at    INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS devices (
     device_id TEXT PRIMARY KEY,
     github_id INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS settings (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS config_log (
     id               INTEGER PRIMARY KEY AUTOINCREMENT,
     key              TEXT NOT NULL,
     old_value        TEXT,
     new_value        TEXT,
     changed_by       INTEGER NOT NULL,
     changed_by_login TEXT NOT NULL,
     changed_at       INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS requests (
     id                INTEGER PRIMARY KEY AUTOINCREMENT,
     github_id         INTEGER NOT NULL,
     is_admin          INTEGER NOT NULL,
     at                INTEGER NOT NULL,
     model             TEXT NOT NULL,
     prompt_tokens     INTEGER NOT NULL,
     completion_tokens INTEGER NOT NULL,
     cached_tokens     INTEGER NOT NULL,
     charged_tokens    INTEGER NOT NULL,
     cost_usd          REAL NOT NULL,
     status            TEXT NOT NULL,
     latency_ms        INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS requests_at ON requests (at)`,
  `CREATE INDEX IF NOT EXISTS requests_person ON requests (github_id, at)`,
  `CREATE TABLE IF NOT EXISTS events (
     github_id   INTEGER NOT NULL,
     id          TEXT NOT NULL,
     type        TEXT NOT NULL,
     session_id  TEXT,
     at          INTEGER NOT NULL,
     props       TEXT NOT NULL,
     received_at INTEGER NOT NULL,
     PRIMARY KEY (github_id, id)
   )`,
  `CREATE INDEX IF NOT EXISTS events_at ON events (at)`,
  `CREATE INDEX IF NOT EXISTS events_type ON events (type, github_id)`,
  `CREATE TABLE IF NOT EXISTS spend_weeks (
     week_start     INTEGER PRIMARY KEY,
     usd            REAL NOT NULL,
     tokens         INTEGER NOT NULL,
     requests       INTEGER NOT NULL,
     admin_usd      REAL NOT NULL,
     admin_tokens   INTEGER NOT NULL,
     admin_requests INTEGER NOT NULL
   )`,
  // Per person per UTC day, for the admin dashboard: requests (admins' left out), new session
  // events, charged tokens and cost. Counts only, kept up to date with each record below.
  `CREATE TABLE IF NOT EXISTS daily_activity (
     day            INTEGER NOT NULL,
     github_id      INTEGER NOT NULL,
     requests       INTEGER NOT NULL,
     events         INTEGER NOT NULL,
     charged_tokens INTEGER NOT NULL,
     cost_usd       REAL NOT NULL,
     PRIMARY KEY (day, github_id)
   ) WITHOUT ROWID`,
  // A copy of the per-person weekly caps an admin set (the AccountObject enforces them), so the
  // dashboard can tell who reached their own allowance. NULL means the default.
  `CREATE TABLE IF NOT EXISTS grants (
     github_id     INTEGER PRIMARY KEY,
     weekly_tokens INTEGER,
     weekly_usd    REAL
   )`,
];

/** Set in `settings` once `daily_activity` has been built from the existing log. */
const ROLLUP_READY = "rollup:daily_activity";

export class DirectoryObject extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      for (const statement of SCHEMA) this.ctx.storage.sql.exec(statement);
      this.#backfillDailyActivity();
    });
  }

  /** Builds `daily_activity` from the request log and events once, the first time this code runs. */
  #backfillDailyActivity(): void {
    const sql = this.ctx.storage.sql;
    if (sql.exec("SELECT 1 FROM settings WHERE key = ?", ROLLUP_READY).toArray().length > 0) return;
    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM daily_activity");
      sql.exec(
        `INSERT INTO daily_activity (day, github_id, requests, events, charged_tokens, cost_usd)
         SELECT at / ${DAY_MS}, github_id, COUNT(*), 0, SUM(charged_tokens), SUM(cost_usd) FROM requests WHERE is_admin = 0 GROUP BY 1, 2`,
      );
      sql.exec(
        `INSERT INTO daily_activity (day, github_id, requests, events, charged_tokens, cost_usd)
         SELECT at / ${DAY_MS}, github_id, 0, COUNT(*), 0, 0 FROM events WHERE true GROUP BY 1, 2
         ON CONFLICT (day, github_id) DO UPDATE SET events = events + excluded.events`,
      );
      sql.exec("INSERT INTO settings (key, value) VALUES (?, '1')", ROLLUP_READY);
    });
  }

  #addActivity(githubId: number, at: number, change: { requests: number; events: number; chargedTokens: number; costUsd: number }): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO daily_activity (day, github_id, requests, events, charged_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (day, github_id) DO UPDATE SET
         requests = requests + excluded.requests, events = events + excluded.events,
         charged_tokens = charged_tokens + excluded.charged_tokens, cost_usd = cost_usd + excluded.cost_usd`,
      Math.floor(at / DAY_MS),
      githubId,
      change.requests,
      change.events,
      change.chargedTokens,
      change.costUsd,
    );
  }

  // ─── Admission ────────────────────────────────────────────────────────────

  /**
   * Admits a GitHub account (one person per numeric GitHub id), atomically: existing people
   * pass; admins pass; everyone else needs room under `maxActive`, and then either open
   * admission with an account old enough, or an unused invite code. A device id already
   * holding a grant for another account is refused (one grant per account and device).
   */
  async admit(input: {
    githubId: number;
    login: string;
    isAdmin: boolean;
    inviteCode: string | undefined;
    clientDeviceId: string | null;
    /** The GitHub account is younger than the minimum age: it needs an invite even with open admission. */
    accountTooNew: boolean;
    /** Admit accounts that aren't too new without an invite. */
    openAdmission?: boolean;
    maxActive: number;
    now: number;
  }): Promise<AdmitResult> {
    const inviteHash = input.inviteCode ? await sha256Hex(normalizeInviteCode(input.inviteCode)) : undefined;
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync((): AdmitResult => {
      if (input.clientDeviceId) {
        const holder = sql.exec<{ github_id: number }>("SELECT github_id FROM devices WHERE device_id = ?", input.clientDeviceId).toArray()[0];
        if (holder && holder.github_id !== input.githubId) return { ok: false, reason: "device_taken" };
      }
      const bindDevice = () => {
        if (input.clientDeviceId) sql.exec("INSERT OR IGNORE INTO devices (device_id, github_id) VALUES (?, ?)", input.clientDeviceId, input.githubId);
      };
      const existing = sql.exec<PersonRow>("SELECT * FROM people WHERE github_id = ?", input.githubId).toArray()[0];
      if (existing) {
        sql.exec("UPDATE people SET login = ? WHERE github_id = ?", input.login, input.githubId);
        bindDevice();
        return { ok: true, created: false, via: "existing" };
      }
      if (input.isAdmin) {
        sql.exec("INSERT INTO people (github_id, login, status, admitted_at, admitted_via) VALUES (?, ?, 'active', ?, 'admin')", input.githubId, input.login, input.now);
        bindDevice();
        return { ok: true, created: true, via: "admin" };
      }
      const active = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM people WHERE status = 'active' AND admitted_via != 'admin'").toArray()[0]?.n ?? 0;
      if (active >= input.maxActive) return { ok: false, reason: "cohort_full" };
      if (input.openAdmission && !input.accountTooNew) {
        sql.exec("INSERT INTO people (github_id, login, status, admitted_at, admitted_via) VALUES (?, ?, 'active', ?, 'open')", input.githubId, input.login, input.now);
        bindDevice();
        return { ok: true, created: true, via: "open" };
      }
      if (!inviteHash) return { ok: false, reason: "needs_invite" };
      const invite = sql.exec<{ id: number; used_by: number | null }>("SELECT id, used_by FROM invites WHERE code_hash = ?", inviteHash).toArray()[0];
      if (!invite || invite.used_by !== null) return { ok: false, reason: "invalid_invite" };
      sql.exec("UPDATE invites SET used_by = ?, used_at = ? WHERE id = ?", input.githubId, input.now, invite.id);
      sql.exec(
        "INSERT INTO people (github_id, login, status, admitted_at, admitted_via) VALUES (?, ?, 'active', ?, ?)",
        input.githubId,
        input.login,
        input.now,
        `invite:${invite.id}`,
      );
      bindDevice();
      return { ok: true, created: true, via: "invite" };
    });
  }

  async createInvites(input: { count: number; note: string | null; createdBy: number; now: number }): Promise<Array<{ id: number; code: string }>> {
    const out: Array<{ id: number; code: string }> = [];
    for (let index = 0; index < input.count; index++) {
      const code = newInviteCode();
      const row = this.ctx.storage.sql
        .exec<{ id: number }>(
          "INSERT INTO invites (code_hash, note, created_by, created_at) VALUES (?, ?, ?, ?) RETURNING id",
          await sha256Hex(code),
          input.note,
          input.createdBy,
          input.now,
        )
        .toArray()[0]!;
      out.push({ id: row.id, code });
    }
    return out;
  }

  /** Invites without their codes (only hashes are stored). */
  async listInvites(): Promise<Array<{ id: number; note: string | null; createdAt: number; usedBy: number | null; usedAt: number | null }>> {
    return this.ctx.storage.sql
      .exec<{ id: number; note: string | null; created_at: number; used_by: number | null; used_at: number | null }>("SELECT * FROM invites ORDER BY id")
      .toArray()
      .map((row) => ({ id: row.id, note: row.note, createdAt: row.created_at, usedBy: row.used_by, usedAt: row.used_at }));
  }

  async listPeople(): Promise<PersonRow[]> {
    return this.ctx.storage.sql.exec<PersonRow>("SELECT * FROM people ORDER BY admitted_at").toArray().map((row) => ({ ...row }));
  }

  async getPerson(githubId: number): Promise<PersonRow | undefined> {
    const row = this.ctx.storage.sql.exec<PersonRow>("SELECT * FROM people WHERE github_id = ?", githubId).toArray()[0];
    return row ? { ...row } : undefined;
  }

  async setPersonStatus(githubId: number, status: "active" | "suspended"): Promise<boolean> {
    const found = this.ctx.storage.sql.exec("SELECT 1 FROM people WHERE github_id = ?", githubId).toArray().length > 0;
    if (found) this.ctx.storage.sql.exec("UPDATE people SET status = ? WHERE github_id = ?", status, githubId);
    return found;
  }

  // ─── Kill switch, runtime settings and spend ─────────────────────────────

  async setPaused(paused: boolean, actor?: { githubId: number; login: string; now: number }): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      const before = this.#paused();
      this.ctx.storage.sql.exec("INSERT INTO settings (key, value) VALUES ('paused', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", paused ? "1" : "0");
      if (actor && before !== paused) this.#log("paused", before, paused, actor);
    });
  }

  /** The admin overrides of runtime settings (see runtime-config.ts). */
  async overrides(): Promise<Overrides> {
    return this.#overrides();
  }

  /**
   * Applies validated changes to the overrides atomically and logs each one that changed
   * something. Returns the overrides after the change.
   */
  async updateOverrides(changes: SettingChange[], actor: { githubId: number; login: string; now: number }): Promise<Overrides> {
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      for (const change of changes) {
        const before = this.#overrides()[change.key];
        if (change.value === undefined) {
          if (before === undefined) continue;
          sql.exec("DELETE FROM settings WHERE key = ?", `override:${change.key}`);
        } else {
          if (JSON.stringify(before) === JSON.stringify(change.value)) continue;
          sql.exec(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            `override:${change.key}`,
            JSON.stringify(change.value),
          );
        }
        this.#log(change.key, before, change.value, actor);
      }
    });
    return this.#overrides();
  }

  /** The most recent changes to runtime settings and the kill switch, newest first. */
  async configLog(limit = 50): Promise<ConfigChange[]> {
    type Row = { id: number; key: string; old_value: string | null; new_value: string | null; changed_by: number; changed_by_login: string; changed_at: number };
    return this.ctx.storage.sql
      .exec<Row>("SELECT * FROM config_log ORDER BY id DESC LIMIT ?", limit)
      .toArray()
      .map((row) => ({
        id: row.id,
        key: row.key,
        oldValue: row.old_value === null ? "(env)" : (JSON.parse(row.old_value) as unknown),
        newValue: row.new_value === null ? "(env)" : (JSON.parse(row.new_value) as unknown),
        changedBy: row.changed_by,
        changedByLogin: row.changed_by_login,
        changedAt: new Date(row.changed_at).toISOString(),
      }));
  }

  /** What a request checks before forwarding: the admin kill switch, the overrides and non-admin spend. */
  async gate(now: number): Promise<{ paused: boolean; weekUsd: number; totalUsd: number; overrides: Overrides }> {
    const spend = await this.spend(now);
    return { paused: this.#paused(), weekUsd: spend.spentUsd, totalUsd: spend.totalSpentUsd, overrides: this.#overrides() };
  }

  #paused(): boolean {
    return this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key = 'paused'").toArray()[0]?.value === "1";
  }

  #overrides(): Overrides {
    return readOverrides(this.ctx.storage.sql.exec<{ key: string; value: string }>("SELECT key, value FROM settings WHERE key LIKE 'override:%'").toArray());
  }

  /** `undefined` (no override, so env) is stored as NULL. */
  #log(key: string, before: unknown, after: unknown, actor: { githubId: number; login: string; now: number }): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO config_log (key, old_value, new_value, changed_by, changed_by_login, changed_at) VALUES (?, ?, ?, ?, ?, ?)",
      key,
      before === undefined ? null : JSON.stringify(before),
      after === undefined ? null : JSON.stringify(after),
      actor.githubId,
      actor.login,
      actor.now,
    );
  }

  async spend(now: number): Promise<SpendSummary> {
    const start = weekStart(now);
    type Row = { usd: number; tokens: number; requests: number; admin_usd: number; admin_tokens: number; admin_requests: number };
    const row = this.ctx.storage.sql.exec<Row>("SELECT * FROM spend_weeks WHERE week_start = ?", start).toArray()[0];
    const total = this.ctx.storage.sql.exec<{ usd: number | null; admin_usd: number | null }>("SELECT SUM(usd) AS usd, SUM(admin_usd) AS admin_usd FROM spend_weeks").toArray()[0];
    return {
      weekStart: start,
      resetsAt: weekEnd(now),
      spentUsd: round(row?.usd ?? 0),
      tokens: row?.tokens ?? 0,
      requests: row?.requests ?? 0,
      adminSpentUsd: round(row?.admin_usd ?? 0),
      adminTokens: row?.admin_tokens ?? 0,
      adminRequests: row?.admin_requests ?? 0,
      totalSpentUsd: round(total?.usd ?? 0),
      adminTotalSpentUsd: round(total?.admin_usd ?? 0),
    };
  }

  // ─── Records ─────────────────────────────────────────────────────────────

  async recordRequest(record: RequestRecord): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO requests (github_id, is_admin, at, model, prompt_tokens, completion_tokens, cached_tokens, charged_tokens, cost_usd, status, latency_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        record.githubId,
        record.isAdmin ? 1 : 0,
        record.at,
        record.model,
        record.promptTokens,
        record.completionTokens,
        record.cachedTokens,
        record.chargedTokens,
        record.costUsd,
        record.status,
        record.latencyMs,
      );
      const admin = record.isAdmin ? 1 : 0;
      this.ctx.storage.sql.exec(
        `INSERT INTO spend_weeks (week_start, usd, tokens, requests, admin_usd, admin_tokens, admin_requests) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(week_start) DO UPDATE SET
           usd = usd + excluded.usd, tokens = tokens + excluded.tokens, requests = requests + excluded.requests,
           admin_usd = admin_usd + excluded.admin_usd, admin_tokens = admin_tokens + excluded.admin_tokens,
           admin_requests = admin_requests + excluded.admin_requests`,
        weekStart(record.at),
        admin ? 0 : record.costUsd,
        admin ? 0 : record.chargedTokens,
        admin ? 0 : 1,
        admin ? record.costUsd : 0,
        admin ? record.chargedTokens : 0,
        admin,
      );
      if (!admin) this.#addActivity(record.githubId, record.at, { requests: 1, events: 0, chargedTokens: record.chargedTokens, costUsd: record.costUsd });
    });
  }

  /** Stores cleaned events; ids already stored for this person are ignored. Returns how many were new. */
  async recordEvents(githubId: number, events: CleanEvent[], now: number): Promise<number> {
    let accepted = 0;
    this.ctx.storage.transactionSync(() => {
      for (const event of events) {
        const inserted = this.ctx.storage.sql
          .exec(
            `INSERT INTO events (github_id, id, type, session_id, at, props, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(github_id, id) DO NOTHING RETURNING id`,
            githubId,
            event.id,
            event.type,
            event.sessionId,
            event.at,
            JSON.stringify(event.props),
            now,
          )
          .toArray();
        accepted += inserted.length;
        if (inserted.length > 0) this.#addActivity(githubId, event.at, { requests: 0, events: 1, chargedTokens: 0, costUsd: 0 });
      }
    });
    return accepted;
  }

  // ─── Metrics ─────────────────────────────────────────────────────────────

  /** Mirrors an admin's per-person caps (undefined: unchanged; null: back to the default). */
  async recordGrant(input: { githubId: number; tokensPerWeek: number | null | undefined; usdPerWeek: number | null | undefined }): Promise<void> {
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec("INSERT OR IGNORE INTO grants (github_id, weekly_tokens, weekly_usd) VALUES (?, NULL, NULL)", input.githubId);
      if (input.tokensPerWeek !== undefined) sql.exec("UPDATE grants SET weekly_tokens = ? WHERE github_id = ?", input.tokensPerWeek, input.githubId);
      if (input.usdPerWeek !== undefined) sql.exec("UPDATE grants SET weekly_usd = ? WHERE github_id = ?", input.usdPerWeek, input.githubId);
      sql.exec("DELETE FROM grants WHERE github_id = ? AND weekly_tokens IS NULL AND weekly_usd IS NULL", input.githubId);
    });
  }

  /** The admin dashboard's tables (see dashboard-data.ts). Admins are left out. */
  async dashboard(input: { now: number; adminIds: number[]; limits: DashboardLimits; topWeek?: number }): Promise<DashboardData> {
    return dashboardData(this.ctx.storage.sql, input);
  }

  /** Admin analytics over whole UTC days `from`..`to` (inclusive), computed from the stored records. */
  async metrics(input: { from: number; to: number; now: number; top?: number }): Promise<Record<string, unknown>> {
    const sql = this.ctx.storage.sql;
    const from = Math.floor(input.from / DAY_MS) * DAY_MS;
    const until = Math.floor(input.to / DAY_MS) * DAY_MS + DAY_MS;
    const top = input.top ?? 10;

    type DayRow = { day: number; requests: number; tokens_in: number; cached: number; tokens_out: number; cost: number; errors: number };
    const perDay = new Map<number, DayRow>();
    for (const row of sql
      .exec<DayRow>(
        `SELECT at / ${DAY_MS} AS day, COUNT(*) AS requests, SUM(prompt_tokens) AS tokens_in, SUM(cached_tokens) AS cached,
                SUM(completion_tokens) AS tokens_out, SUM(cost_usd) AS cost, SUM(status != 'ok') AS errors
         FROM requests WHERE at >= ? AND at < ? GROUP BY day`,
        from,
        until,
      )
      .toArray()) perDay.set(row.day, row);

    const activeByDay = countMap(sql.exec<{ k: number; n: number }>(
      `SELECT at / ${DAY_MS} AS k, COUNT(DISTINCT github_id) AS n FROM ${ACTIVITY} WHERE at >= ? AND at < ? GROUP BY k`,
      from,
      until,
    ).toArray());
    const signupsByDay = countMap(sql.exec<{ k: number; n: number }>(
      `SELECT admitted_at / ${DAY_MS} AS k, COUNT(*) AS n FROM people WHERE admitted_at >= ? AND admitted_at < ? GROUP BY k`,
      from,
      until,
    ).toArray());
    const errorEventsByDay = countMap(sql.exec<{ k: number; n: number }>(
      `SELECT at / ${DAY_MS} AS k, COUNT(*) AS n FROM events WHERE type = 'error' AND at >= ? AND at < ? GROUP BY k`,
      from,
      until,
    ).toArray());
    const latencies = new Map<number, number[]>();
    for (const row of sql
      .exec<{ day: number; latency_ms: number }>(
        `SELECT at / ${DAY_MS} AS day, latency_ms FROM requests WHERE at >= ? AND at < ? AND latency_ms IS NOT NULL ORDER BY day, latency_ms`,
        from,
        until,
      )
      .toArray()) {
      const list = latencies.get(row.day) ?? [];
      list.push(row.latency_ms);
      latencies.set(row.day, list);
    }

    const daily = [];
    for (let day = from; day < until; day += DAY_MS) {
      const key = day / DAY_MS;
      const row = perDay.get(key);
      const sorted = latencies.get(key) ?? [];
      daily.push({
        date: isoDay(day),
        activePeople: activeByDay.get(key) ?? 0,
        newSignups: signupsByDay.get(key) ?? 0,
        requests: row?.requests ?? 0,
        tokensIn: row?.tokens_in ?? 0,
        tokensCached: row?.cached ?? 0,
        tokensOut: row?.tokens_out ?? 0,
        cachedShare: share(row?.cached ?? 0, row?.tokens_in ?? 0),
        costUsd: round(row?.cost ?? 0),
        errors: row?.errors ?? 0,
        errorEvents: errorEventsByDay.get(key) ?? 0,
        latencyP50Ms: percentile(sorted, 50),
        latencyP95Ms: percentile(sorted, 95),
      });
    }

    const weeklyActiveMap = countMap(sql.exec<{ k: number; n: number }>(
      `SELECT ${WEEK_OF("at")} AS k, COUNT(DISTINCT github_id) AS n FROM ${ACTIVITY} WHERE at >= ? AND at < ? GROUP BY k`,
      weekStart(from),
      until,
    ).toArray());
    const weeklyActive = [];
    for (let week = weekStart(from); week < until; week += WEEK_MS) {
      weeklyActive.push({ weekStart: isoDay(week), activePeople: weeklyActiveMap.get(week) ?? 0 });
    }

    // Activity weeks per person, all time: retention and the funnel both need it.
    const weeksByPerson = new Map<number, Set<number>>();
    for (const row of sql.exec<{ github_id: number; week: number }>(`SELECT DISTINCT github_id, ${WEEK_OF("at")} AS week FROM ${ACTIVITY}`).toArray()) {
      const set = weeksByPerson.get(row.github_id) ?? new Set<number>();
      set.add(row.week);
      weeksByPerson.set(row.github_id, set);
    }
    const cohort = sql.exec<{ github_id: number; admitted_at: number }>(
      "SELECT github_id, admitted_at FROM people WHERE admitted_at >= ? AND admitted_at < ?",
      from,
      until,
    ).toArray();

    const currentWeek = weekStart(input.now);
    const cohorts = new Map<number, number[]>();
    for (const person of cohort) {
      const week = weekStart(person.admitted_at);
      const list = cohorts.get(week) ?? [];
      list.push(person.github_id);
      cohorts.set(week, list);
    }
    const retention = [...cohorts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([week, members]) => {
        const weeks = [];
        for (let offset = 0; week + offset * WEEK_MS <= currentWeek; offset++) {
          const target = week + offset * WEEK_MS;
          const active = members.filter((id) => weeksByPerson.get(id)?.has(target)).length;
          weeks.push({ offset, active, rate: round(active / members.length, 4) });
        }
        return { signupWeek: isoDay(week), size: members.length, weeks };
      });

    const has = (query: string) => new Set(sql.exec<{ github_id: number }>(query).toArray().map((row) => row.github_id));
    const requested = has("SELECT DISTINCT github_id FROM requests");
    const ended = has("SELECT DISTINCT github_id FROM events WHERE type = 'session.end'");
    const opened = has("SELECT DISTINCT github_id FROM events WHERE type = 'pr.opened'");
    const ids = cohort.map((person) => person.github_id);
    const funnel = {
      signedIn: ids.length,
      firstRequest: ids.filter((id) => requested.has(id)).length,
      firstSessionEnd: ids.filter((id) => ended.has(id)).length,
      activeSecondWeek: ids.filter((id) => (weeksByPerson.get(id)?.size ?? 0) >= 2).length,
      firstPrOpened: ids.filter((id) => opened.has(id)).length,
    };

    type TopRow = { github_id: number; login: string | null; is_admin: number; tokens: number; tokens_in: number; cached: number; cost: number; requests: number };
    const byPerson = (order: "tokens" | "cost", limit: number) =>
      sql
        .exec<TopRow>(
          `SELECT r.github_id, p.login, MAX(r.is_admin) AS is_admin, SUM(r.prompt_tokens + r.completion_tokens) AS tokens,
                  SUM(r.prompt_tokens) AS tokens_in, SUM(r.cached_tokens) AS cached, SUM(r.cost_usd) AS cost, COUNT(*) AS requests
           FROM requests r LEFT JOIN people p ON p.github_id = r.github_id
           WHERE r.at >= ? AND r.at < ? GROUP BY r.github_id ORDER BY ${order} DESC, r.github_id LIMIT ?`,
          from,
          until,
          limit,
        )
        .toArray()
        .map((row) => ({
          githubId: row.github_id,
          login: row.login,
          isAdmin: row.is_admin === 1,
          tokens: row.tokens,
          tokensIn: row.tokens_in,
          tokensCached: row.cached,
          cachedShare: share(row.cached, row.tokens_in),
          costUsd: round(row.cost),
          requests: row.requests,
        }));
    const totals = sql
      .exec<{ requests: number; tokens_in: number | null; cached: number | null; tokens_out: number | null; cost: number | null; admin_cost: number | null }>(
        `SELECT COUNT(*) AS requests, SUM(prompt_tokens) AS tokens_in, SUM(cached_tokens) AS cached, SUM(completion_tokens) AS tokens_out,
                SUM(CASE WHEN is_admin = 0 THEN cost_usd ELSE 0 END) AS cost, SUM(CASE WHEN is_admin = 1 THEN cost_usd ELSE 0 END) AS admin_cost
         FROM requests WHERE at >= ? AND at < ?`,
        from,
        until,
      )
      .toArray()[0];

    return {
      from: isoDay(from),
      to: isoDay(until - DAY_MS),
      daily,
      weeklyActive,
      retention,
      totals: {
        requests: totals?.requests ?? 0,
        tokensIn: totals?.tokens_in ?? 0,
        tokensCached: totals?.cached ?? 0,
        tokensOut: totals?.tokens_out ?? 0,
        cachedShare: share(totals?.cached ?? 0, totals?.tokens_in ?? 0),
        costUsd: round(totals?.cost ?? 0),
        adminCostUsd: round(totals?.admin_cost ?? 0),
      },
      funnel,
      top: { byTokens: byPerson("tokens", top), byCost: byPerson("cost", top) },
      cacheByPerson: byPerson("tokens", 1000).map(({ githubId, login, tokensIn, tokensCached, cachedShare, costUsd }) => ({
        githubId,
        login,
        tokensIn,
        tokensCached,
        cachedShare,
        costUsd,
      })),
    };
  }

  /** One person's weekly usage (last `weeks` weeks), sessions and events. */
  async personDetail(githubId: number, now: number, weeks = 12): Promise<Record<string, unknown> | undefined> {
    const person = await this.getPerson(githubId);
    if (!person) return undefined;
    const sql = this.ctx.storage.sql;
    const since = weekStart(now) - (weeks - 1) * WEEK_MS;
    type WeekRow = { week: number; requests: number; tokens_in: number; cached: number; tokens_out: number; charged: number; cost: number; errors: number };
    const byWeek = new Map<number, WeekRow>();
    for (const row of sql
      .exec<WeekRow>(
        `SELECT ${WEEK_OF("at")} AS week, COUNT(*) AS requests, SUM(prompt_tokens) AS tokens_in, SUM(cached_tokens) AS cached,
                SUM(completion_tokens) AS tokens_out, SUM(charged_tokens) AS charged, SUM(cost_usd) AS cost, SUM(status != 'ok') AS errors
         FROM requests WHERE github_id = ? AND at >= ? GROUP BY week`,
        githubId,
        since,
      )
      .toArray()) byWeek.set(row.week, row);
    const weekly = [];
    for (let week = since; week <= weekStart(now); week += WEEK_MS) {
      const row = byWeek.get(week);
      weekly.push({
        weekStart: isoDay(week),
        requests: row?.requests ?? 0,
        tokensIn: row?.tokens_in ?? 0,
        tokensCached: row?.cached ?? 0,
        tokensOut: row?.tokens_out ?? 0,
        cachedShare: share(row?.cached ?? 0, row?.tokens_in ?? 0),
        tokensCharged: row?.charged ?? 0,
        costUsd: round(row?.cost ?? 0),
        errors: row?.errors ?? 0,
      });
    }

    const byType = Object.fromEntries(
      sql.exec<{ type: string; n: number }>("SELECT type, COUNT(*) AS n FROM events WHERE github_id = ? GROUP BY type", githubId).toArray().map((row) => [row.type, row.n]),
    );
    const sessions = sql
      .exec<{ started: number; total: number; last_at: number | null }>(
        `SELECT COUNT(DISTINCT CASE WHEN type = 'session.start' THEN session_id END) AS started,
                COUNT(DISTINCT session_id) AS total, MAX(at) AS last_at
         FROM events WHERE github_id = ?`,
        githubId,
      )
      .toArray()[0];
    let durationMs = 0;
    let turns = 0;
    for (const row of sql.exec<{ props: string }>("SELECT props FROM events WHERE github_id = ? AND type = 'session.end'", githubId).toArray()) {
      const props = JSON.parse(row.props) as { durationMs?: number; turns?: number };
      durationMs += props.durationMs ?? 0;
      turns += props.turns ?? 0;
    }
    const recent = sql
      .exec<{ id: string; type: string; session_id: string | null; at: number; props: string }>(
        "SELECT id, type, session_id, at, props FROM events WHERE github_id = ? ORDER BY at DESC LIMIT 20",
        githubId,
      )
      .toArray()
      .map((row) => ({ id: row.id, type: row.type, sessionId: row.session_id, at: new Date(row.at).toISOString(), props: JSON.parse(row.props) as unknown }));

    return {
      githubId: person.github_id,
      login: person.login,
      status: person.status,
      admittedAt: new Date(person.admitted_at).toISOString(),
      admittedVia: person.admitted_via,
      weekly,
      sessions: {
        count: sessions?.total ?? 0,
        started: sessions?.started ?? 0,
        ended: byType["session.end"] ?? 0,
        totalDurationMs: durationMs,
        totalTurns: turns,
        lastEventAt: sessions?.last_at ? new Date(sessions.last_at).toISOString() : null,
      },
      events: { byType, recent },
    };
  }
}

function countMap(rows: Array<{ k: number; n: number }>): Map<number, number> {
  return new Map(rows.map((row) => [row.k, row.n]));
}

/** Nearest-rank percentile of an ascending list; null when empty. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

/** Cached prompt tokens as a share of prompt tokens, 0..1; null when there were none. */
export function share(cached: number, promptTokens: number): number | null {
  return promptTokens > 0 ? round(cached / promptTokens, 4) : null;
}

function round(value: number, places = 6): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
