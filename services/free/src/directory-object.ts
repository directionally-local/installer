import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import { sha256Hex } from "../../shared/src/auth.js";
import { newInviteCode, normalizeInviteCode } from "./codes.js";
import type { DownloadCount, InstallCount } from "./telemetry.js";
import { dashboardData, installBreakdown, notAdmin, type DashboardData, type DashboardLimits } from "./dashboard-data.js";
import type { CleanEvent } from "./events.js";
import { creditAlert, creditPausedAlert, crossed, dailyDigestAlert, DIGEST_MAX_LOGINS, firstSignupAlert, GITHUB_CHECK_ERROR_ALERT, githubCheckErrorAlert, HOST_FAILURE_RATE, HOST_MIN_REQUESTS, HOST_WINDOW_MS, hostFailureAlert, queueStartedAlert, totalSpendAlert, upstreamErrorAlert, weeklySpendAlert, type Alert, type DigestUsage, type SignupHow } from "./alerts.js";
import type { Upstream } from "./config.js";
import { creditForecast, creditMode, etaAt, forecast, queueOrder, shouldQueue, type Forecast, type Policy, type Waiting } from "./queue.js";
import { bonuses, codeFor, countingPairs, everActiveFriends, type Pair, type ReferralOutcome } from "./referrals.js";
import { applyOverrides, readOverrides, type Overrides, type SettingChange } from "./runtime-config.js";
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
  | {
      ok: true;
      created: boolean;
      via: "existing" | "admin" | "open" | "invite";
      queued: boolean;
      queueStarted: boolean;
      referralCode: string;
      /** Set once, ever: this was the first person admitted who isn't an admin. */
      firstSignup?: Alert;
    }
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
  /** The OpenRouter host that served or failed the request, as a slug, when OpenRouter said. */
  host?: string;
  /** Set when the request failed in a way the host is blamed for. */
  hostFailure?: HostFailure;
  /** Paid usage (Pro or a top-up): logged and shown, but not counted against the free caps. */
  paid?: boolean;
  /**
   * Who served (or failed) the request; "openrouter" when unset. Only OpenRouter's `costUsd`
   * is cash: the global caps count it alone. A Luminal request's `costUsd` is its cost at
   * OpenRouter prices (what the person's dollar allowance was charged), and `creditUsd` is
   * what it took from the Luminal credit.
   */
  upstream?: Upstream;
  /** Luminal credit used, USD (0 for OpenRouter). */
  creditUsd?: number;
  /** Milliseconds to the upstream's response headers, and to the first content chunk. */
  ttfbMs?: number | null;
  ttftMs?: number | null;
  /** The upstream failed the request (429, 5xx, a timeout, a network error or a failed stream). */
  upstreamError?: boolean;
}

/**
 * A request the host is blamed for: an HTTP 5xx from it, an error body, or a stream that
 * failed before it finished. Counts only, never content.
 */
export interface HostFailure {
  kind: "http_5xx" | "error_body" | "stream";
  /** The upstream HTTP status for `http_5xx`, else null. */
  upstreamStatus: number | null;
}

/** A person's place in the queue for free tokens. */
export interface QueuePlace {
  /** 1 is next. */
  position: number;
  /** Unix ms: the Monday they can expect free tokens. */
  etaAt: number;
  waiting: number;
}

/** What `gate` adds for the caller: queue place, referral numbers and this week's bonus. */
export interface PersonState {
  queue: QueuePlace | null;
  bonusTokens: number;
  referral: { code: string; joined: number; activeThisWeek: number } | null;
}

export interface Gate {
  paused: boolean;
  /** Cash (OpenRouter) spend by everyone but admins: what the global caps count. */
  weekUsd: number;
  totalUsd: number;
  /** Luminal credit used by everyone, admins and paid usage included, since the start. */
  creditUsedUsd: number;
  /** Free Luminal credit spend this week (no admins, no paid usage): what the queue watches in credit mode. */
  weekCreditUsd: number;
  overrides: Overrides;
  person?: PersonState;
}

/** One Monday's admission from the queue. */
export interface QueueRun {
  weekStart: number;
  ranAt: number;
  admitted: number;
  waitingBefore: number;
  avgUsd: number;
  actives: number;
  budgetUsd: number | null;
}

export interface SpendSummary {
  /** Paid usage (Pro and top-ups) this week, apart from the free caps. */
  paidUsd: number;
  paidTokens: number;
  paidRequests: number;
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
  /** Luminal credit: used by everyone since the start, everyone this week, and free usage this week. */
  creditUsedUsd: number;
  creditWeekUsd: number;
  freeCreditWeekUsd: number;
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
  // Per OpenRouter host per UTC day: requests it served or failed and how many failed, so the
  // dashboard can show error rates by host. Plus one row per host failure. Counts only.
  `CREATE TABLE IF NOT EXISTS host_daily (
     day      INTEGER NOT NULL,
     host     TEXT NOT NULL,
     requests INTEGER NOT NULL,
     failures INTEGER NOT NULL,
     PRIMARY KEY (day, host)
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS host_failures (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     at              INTEGER NOT NULL,
     host            TEXT NOT NULL,
     kind            TEXT NOT NULL,
     upstream_status INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS host_failures_at ON host_failures (at)`,
  `CREATE TABLE IF NOT EXISTS grants (
     github_id     INTEGER PRIMARY KEY,
     weekly_tokens INTEGER,
     weekly_usd    REAL
   )`,
  `CREATE INDEX IF NOT EXISTS daily_activity_person ON daily_activity (github_id, day)`,
  // The queue for free tokens (queue.ts): one row per person who waited; admitted_at is set
  // when they got in ("weekly" on a Monday, "admin" by hand).
  `CREATE TABLE IF NOT EXISTS queue (
     github_id    INTEGER PRIMARY KEY,
     queued_at    INTEGER NOT NULL,
     admitted_at  INTEGER,
     admitted_how TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS queue_waiting ON queue (admitted_at, queued_at)`,
  `CREATE TABLE IF NOT EXISTS queue_runs (
     week_start     INTEGER PRIMARY KEY,
     ran_at         INTEGER NOT NULL,
     admitted       INTEGER NOT NULL,
     waiting_before INTEGER NOT NULL,
     avg_usd        REAL NOT NULL,
     actives        INTEGER NOT NULL,
     budget_usd     REAL
   )`,
  // Referrals (referrals.ts): each person's stable code, and who signed up with whose code.
  `CREATE TABLE IF NOT EXISTS referral_codes (
     code       TEXT PRIMARY KEY,
     github_id  INTEGER NOT NULL UNIQUE,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS referrals (
     referred_id INTEGER PRIMARY KEY,
     referrer_id INTEGER,
     code        TEXT NOT NULL,
     at          INTEGER NOT NULL,
     outcome     TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS referrals_referrer ON referrals (referrer_id)`,
  // Keyed hashes of the networks each person signed in from, for referral anti-abuse only.
  `CREATE TABLE IF NOT EXISTS person_networks (
     github_id INTEGER NOT NULL,
     net_hash  TEXT NOT NULL,
     first_at  INTEGER NOT NULL,
     PRIMARY KEY (github_id, net_hash)
   ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS person_networks_net ON person_networks (net_hash)`,
  // Per OpenRouter host per minute, for the failure-rate alert; rows older than two hours go.
  `CREATE TABLE IF NOT EXISTS host_minutes (
     minute   INTEGER NOT NULL,
     host     TEXT NOT NULL,
     requests INTEGER NOT NULL,
     failures INTEGER NOT NULL,
     PRIMARY KEY (minute, host)
   ) WITHOUT ROWID`,
  // Alerts already sent, so each fires once (alerts.ts).
  `CREATE TABLE IF NOT EXISTS alerts_sent (
     key TEXT PRIMARY KEY,
     at  INTEGER NOT NULL
   )`,
  // Billing (stripe.ts): webhook events already handled (idempotency), which Stripe customer is
  // whose, payments for the revenue numbers (amounts before tax, in cents), and a copy of each
  // Pro subscription's state for the dashboard (the AccountObject holds the one that counts).
  `CREATE TABLE IF NOT EXISTS billing_events (
     id   TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     at   INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS customers (
     customer_id TEXT PRIMARY KEY,
     github_id   INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS payments (
     id           TEXT PRIMARY KEY,
     github_id    INTEGER NOT NULL,
     kind         TEXT NOT NULL,
     amount_cents INTEGER NOT NULL,
     at           INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS payments_at ON payments (at)`,
  // Per upstream per UTC day, for the dashboard: requests (admins included: it is the upstream's
  // load), upstream errors, prompt and cached tokens, cash (OpenRouter) and credit (Luminal) cost.
  `CREATE TABLE IF NOT EXISTS upstream_daily (
     day           INTEGER NOT NULL,
     upstream      TEXT NOT NULL,
     requests      INTEGER NOT NULL,
     errors        INTEGER NOT NULL,
     prompt_tokens INTEGER NOT NULL,
     cached_tokens INTEGER NOT NULL,
     cash_usd      REAL NOT NULL,
     credit_usd    REAL NOT NULL,
     PRIMARY KEY (day, upstream)
   ) WITHOUT ROWID`,
  // Per request with a response: time to the first byte (headers) and to the first content
  // chunk, by upstream, for the median and p90. No person, no content; rows older than 15 days go.
  `CREATE TABLE IF NOT EXISTS upstream_timings (
     id       INTEGER PRIMARY KEY AUTOINCREMENT,
     at       INTEGER NOT NULL,
     upstream TEXT NOT NULL,
     ttfb_ms  INTEGER,
     ttft_ms  INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS upstream_timings_at ON upstream_timings (at)`,
  // Per upstream per minute, for the Luminal error-rate alert; rows older than two hours go.
  `CREATE TABLE IF NOT EXISTS upstream_minutes (
     minute   INTEGER NOT NULL,
     upstream TEXT NOT NULL,
     requests INTEGER NOT NULL,
     errors   INTEGER NOT NULL,
     PRIMARY KEY (minute, upstream)
   ) WITHOUT ROWID`,
  // The install funnel's anonymous counts (telemetry.ts): per UTC day and allowlisted values,
  // how many install scripts were served and how many installs finished. Nothing per person.
  `CREATE TABLE IF NOT EXISTS download_daily (
     day       INTEGER NOT NULL,
     route     TEXT NOT NULL,
     client    TEXT NOT NULL,
     downloads INTEGER NOT NULL,
     PRIMARY KEY (day, route, client)
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS install_daily (
     day         INTEGER NOT NULL,
     os          TEXT NOT NULL,
     arch        TEXT NOT NULL,
     mode        TEXT NOT NULL,
     dl_version  TEXT NOT NULL,
     result      TEXT NOT NULL,
     failed_step TEXT NOT NULL,
     via         TEXT NOT NULL,
     installs    INTEGER NOT NULL,
     PRIMARY KEY (day, os, arch, mode, dl_version, result, failed_step, via)
   ) WITHOUT ROWID`,
  // Per UTC day, outcomes of the sign-up GitHub activity check's contribution lookup (app.ts):
  // "contributions" passed, "none" sent to the invite step, "error" let through. Counts only.
  `CREATE TABLE IF NOT EXISTS github_checks_daily (
     day     INTEGER NOT NULL,
     outcome TEXT NOT NULL,
     n       INTEGER NOT NULL,
     PRIMARY KEY (day, outcome)
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS subscriptions (
     github_id  INTEGER PRIMARY KEY,
     state      TEXT NOT NULL,
     period_end INTEGER,
     state_at   INTEGER NOT NULL
   )`,
];

/** Columns added after their table first shipped: added in place on start. */
const ADDED_COLUMNS: Array<[table: string, column: string, definition: string]> = [
  ["requests", "paid", "INTEGER NOT NULL DEFAULT 0"],
  ["spend_weeks", "paid_usd", "REAL NOT NULL DEFAULT 0"],
  ["spend_weeks", "paid_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ["spend_weeks", "paid_requests", "INTEGER NOT NULL DEFAULT 0"],
  ["daily_activity", "paid_cost_usd", "REAL NOT NULL DEFAULT 0"],
  // Upstreams (Luminal and OpenRouter): who served each request, the credit it used, and timing.
  ["requests", "upstream", "TEXT NOT NULL DEFAULT 'openrouter'"],
  ["requests", "credit_usd", "REAL NOT NULL DEFAULT 0"],
  ["requests", "ttfb_ms", "INTEGER"],
  ["requests", "ttft_ms", "INTEGER"],
  ["requests", "upstream_error", "INTEGER NOT NULL DEFAULT 0"],
  ["spend_weeks", "credit_usd", "REAL NOT NULL DEFAULT 0"],
  ["spend_weeks", "free_credit_usd", "REAL NOT NULL DEFAULT 0"],
  ["daily_activity", "credit_usd", "REAL NOT NULL DEFAULT 0"],
];

/** Timings older than this are dropped: the dashboard shows today and this week. */
const TIMINGS_MAX_AGE_MS = 15 * DAY_MS;

/** Set in `settings` once `daily_activity` has been built from the existing log. */
const ROLLUP_READY = "rollup:daily_activity";

/** What the sign-up GitHub activity check's contribution lookup found (app.ts). */
export type GithubCheckOutcome = "contributions" | "none" | "error";

export class DirectoryObject extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      for (const statement of SCHEMA) this.ctx.storage.sql.exec(statement);
      for (const [table, column, definition] of ADDED_COLUMNS) {
        const columns = this.ctx.storage.sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).toArray();
        if (!columns.some((existing) => existing.name === column)) this.ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
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
         SELECT at / ${DAY_MS}, github_id, COUNT(*), 0, SUM(CASE WHEN paid = 0 THEN charged_tokens ELSE 0 END),
                SUM(CASE WHEN paid = 0 THEN cost_usd ELSE 0 END) FROM requests WHERE is_admin = 0 GROUP BY 1, 2`,
      );
      sql.exec(
        `UPDATE daily_activity SET paid_cost_usd = (SELECT COALESCE(SUM(r.cost_usd), 0) FROM requests r
           WHERE r.is_admin = 0 AND r.paid = 1 AND r.github_id = daily_activity.github_id AND r.at / ${DAY_MS} = daily_activity.day)
         WHERE EXISTS (SELECT 1 FROM requests r WHERE r.paid = 1 LIMIT 1)`,
      );
      sql.exec(
        `INSERT INTO daily_activity (day, github_id, requests, events, charged_tokens, cost_usd)
         SELECT at / ${DAY_MS}, github_id, 0, COUNT(*), 0, 0 FROM events WHERE true GROUP BY 1, 2
         ON CONFLICT (day, github_id) DO UPDATE SET events = events + excluded.events`,
      );
      sql.exec("INSERT INTO settings (key, value) VALUES (?, '1')", ROLLUP_READY);
    });
  }

  /** Free tokens and cost go in `charged_tokens` and `cost_usd`; paid cost in `paid_cost_usd`. */
  #addActivity(githubId: number, at: number, change: { requests: number; events: number; chargedTokens: number; costUsd: number; paidCostUsd?: number; creditUsd?: number }): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO daily_activity (day, github_id, requests, events, charged_tokens, cost_usd, paid_cost_usd, credit_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (day, github_id) DO UPDATE SET
         requests = requests + excluded.requests, events = events + excluded.events,
         charged_tokens = charged_tokens + excluded.charged_tokens, cost_usd = cost_usd + excluded.cost_usd,
         paid_cost_usd = paid_cost_usd + excluded.paid_cost_usd, credit_usd = credit_usd + excluded.credit_usd`,
      Math.floor(at / DAY_MS),
      githubId,
      change.requests,
      change.events,
      change.chargedTokens,
      change.costUsd,
      change.paidCostUsd ?? 0,
      change.creditUsd ?? 0,
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
    /**
     * The account needs an invite even with open admission: its GitHub account is younger than
     * the minimum age, or has no public activity (see app.ts).
     */
    accountTooNew: boolean;
    /** Admit accounts that aren't too new without an invite. */
    openAdmission?: boolean;
    /**
     * Admission is invite-only, so `maxActive` applies. With open admission (false here) there
     * is no cap on people; the queue holds free spend inside the budget instead.
     */
    inviteOnly?: boolean;
    maxActive: number;
    /** A referral code the sign-up carried (normalized). */
    referralCode?: string | undefined;
    /** A keyed hash of the network the sign-in came from (referral anti-abuse). */
    networkHash?: string | undefined;
    /** The effective settings; without them nobody is queued. */
    policy?: Policy;
    now: number;
  }): Promise<AdmitResult> {
    const inviteHash = input.inviteCode ? await sha256Hex(normalizeInviteCode(input.inviteCode)) : undefined;
    const sql = this.ctx.storage.sql;
    if (input.policy) this.#runWeeklyQueue(input.now, input.policy);
    return this.ctx.storage.transactionSync((): AdmitResult => {
      if (input.clientDeviceId) {
        const holder = sql.exec<{ github_id: number }>("SELECT github_id FROM devices WHERE device_id = ?", input.clientDeviceId).toArray()[0];
        if (holder && holder.github_id !== input.githubId) return { ok: false, reason: "device_taken" };
      }
      const admitted = (via: "existing" | "admin" | "open" | "invite", created: boolean): AdmitResult => {
        if (input.clientDeviceId) sql.exec("INSERT OR IGNORE INTO devices (device_id, github_id) VALUES (?, ?)", input.clientDeviceId, input.githubId);
        const referralCode = this.#ensureCode(input.githubId, input.login, input.now);
        if (created && via !== "admin" && input.referralCode) this.#recordReferral(input.githubId, input.login, input.referralCode, input.now);
        if (input.networkHash) this.#recordNetwork(input.githubId, input.networkHash, input.now);
        let queued = false;
        let queueStarted = false;
        // Open sign-ups wait for free tokens while spend is near the cap or others are waiting.
        // Invited people and admins don't: an invite is the owner's own choice.
        if (created && via === "open" && input.policy) {
          const waiting = this.#waitingCount();
          const spend = this.#spendSync(input.now);
          if (shouldQueue({ weekUsd: spend.spentUsd, weekCreditUsd: spend.freeCreditWeekUsd, queueLength: waiting, policy: input.policy })) {
            sql.exec("INSERT OR IGNORE INTO queue (github_id, queued_at) VALUES (?, ?)", input.githubId, input.now);
            queued = true;
            queueStarted = waiting === 0;
          }
        }
        const firstSignup = created && (via === "open" || via === "invite") ? this.#firstSignupAlert(input.githubId, input.login, via, queued, input.policy?.adminIds ?? [], input.now) : undefined;
        return { ok: true, created, via, queued, queueStarted, referralCode, ...(firstSignup ? { firstSignup } : {}) };
      };
      const existing = sql.exec<PersonRow>("SELECT * FROM people WHERE github_id = ?", input.githubId).toArray()[0];
      if (existing) {
        sql.exec("UPDATE people SET login = ? WHERE github_id = ?", input.login, input.githubId);
        return admitted("existing", false);
      }
      if (input.isAdmin) {
        sql.exec("INSERT INTO people (github_id, login, status, admitted_at, admitted_via) VALUES (?, ?, 'active', ?, 'admin')", input.githubId, input.login, input.now);
        return admitted("admin", true);
      }
      if (input.inviteOnly !== false) {
        const active = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM people WHERE status = 'active' AND admitted_via != 'admin'").toArray()[0]?.n ?? 0;
        if (active >= input.maxActive) return { ok: false, reason: "cohort_full" };
      }
      if (input.openAdmission && !input.accountTooNew) {
        sql.exec("INSERT INTO people (github_id, login, status, admitted_at, admitted_via) VALUES (?, ?, 'active', ?, 'open')", input.githubId, input.login, input.now);
        return admitted("open", true);
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
      return admitted("invite", true);
    });
  }

  /**
   * The first-user alert, for a person just admitted by open admission or an invite. The key is
   * marked on the first such admission and never again, so it can't send twice; when people
   * were admitted before this alert existed, it is marked without sending.
   */
  #firstSignupAlert(githubId: number, login: string, via: "open" | "invite", queued: boolean, adminIds: readonly number[], now: number): Alert | undefined {
    if (!this.#markAlert("first-signup", now)) return undefined;
    const sql = this.ctx.storage.sql;
    const others =
      sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM people WHERE github_id != ? AND ${notAdmin("github_id")}`, githubId, JSON.stringify([...adminIds])).toArray()[0]?.n ?? 0;
    if (others > 0) return undefined;
    const referral = sql.exec("SELECT 1 FROM referrals WHERE referred_id = ? AND outcome = 'ok'", githubId).toArray().length > 0;
    return firstSignupAlert({ login, how: { via, referral }, at: now, queued });
  }

  // ─── Referrals ────────────────────────────────────────────────────────────

  /** Gives a person their stable referral code, once. */
  #ensureCode(githubId: number, login: string, now: number): string {
    const sql = this.ctx.storage.sql;
    const existing = sql.exec<{ code: string }>("SELECT code FROM referral_codes WHERE github_id = ?", githubId).toArray()[0];
    if (existing) return existing.code;
    const plainTaken = sql.exec("SELECT 1 FROM referral_codes WHERE code = ?", login.toLowerCase()).toArray().length > 0;
    const code = codeFor(login, githubId, plainTaken);
    sql.exec("INSERT INTO referral_codes (code, github_id, created_at) VALUES (?, ?, ?)", code, githubId, now);
    return code;
  }

  #recordReferral(githubId: number, login: string, code: string, now: number): void {
    const sql = this.ctx.storage.sql;
    const owner = sql.exec<{ github_id: number }>("SELECT github_id FROM referral_codes WHERE code = ?", code).toArray()[0]?.github_id;
    let outcome: ReferralOutcome = "ok";
    if (owner === githubId || code === login.toLowerCase()) outcome = "self";
    else if (owner === undefined) outcome = "unknown_code";
    sql.exec(
      "INSERT OR IGNORE INTO referrals (referred_id, referrer_id, code, at, outcome) VALUES (?, ?, ?, ?, ?)",
      githubId,
      outcome === "ok" ? owner! : null,
      code,
      now,
      outcome,
    );
  }

  /**
   * Remembers a network a person signed in from, and stops any referral between two people
   * seen on the same network (at sign-up or later).
   */
  #recordNetwork(githubId: number, netHash: string, now: number): void {
    const sql = this.ctx.storage.sql;
    sql.exec("INSERT OR IGNORE INTO person_networks (github_id, net_hash, first_at) VALUES (?, ?, ?)", githubId, netHash, now);
    sql.exec(
      `UPDATE referrals SET outcome = 'same_network'
       WHERE outcome = 'ok' AND (referred_id = ? OR referrer_id = ?)
         AND EXISTS (SELECT 1 FROM person_networks a JOIN person_networks b ON a.net_hash = b.net_hash
                     WHERE a.github_id = referrals.referred_id AND b.github_id = referrals.referrer_id)`,
      githubId,
      githubId,
    );
  }

  /** Counting referral pairs for one person or everyone (`githubId` undefined). */
  #pairs(githubId?: number): Pair[] {
    const sql = this.ctx.storage.sql;
    const rows =
      githubId === undefined
        ? sql.exec<{ referrer_id: number; referred_id: number }>("SELECT referrer_id, referred_id FROM referrals WHERE outcome = 'ok'").toArray()
        : sql
            .exec<{ referrer_id: number; referred_id: number }>(
              "SELECT referrer_id, referred_id FROM referrals WHERE outcome = 'ok' AND (referrer_id = ? OR referred_id = ?)",
              githubId,
              githubId,
            )
            .toArray();
    return rows.map((row) => ({ referrer: row.referrer_id, referred: row.referred_id }));
  }

  /** The public lookup behind `GET /v1/referrals/<code>`: the current login of an admitted, unsuspended account. */
  async referralCodeOwner(code: string): Promise<{ login: string } | undefined> {
    const row = this.ctx.storage.sql
      .exec<{ login: string }>(
        "SELECT p.login AS login FROM referral_codes c JOIN people p ON p.github_id = c.github_id WHERE c.code = ? AND p.status = 'active'",
        code,
      )
      .toArray()[0];
    return row ? { login: row.login } : undefined;
  }

  // ─── The queue ────────────────────────────────────────────────────────────

  #waitingCount(): number {
    return this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM queue WHERE admitted_at IS NULL").toArray()[0]?.n ?? 0;
  }

  /** Everyone waiting, front of the line first. */
  #line(policy: Pick<Policy, "queueReferralPlaces">): Waiting[] {
    const rows = this.ctx.storage.sql.exec<{ github_id: number; queued_at: number }>("SELECT github_id, queued_at FROM queue WHERE admitted_at IS NULL").toArray();
    const friends = everActiveFriends(this.ctx.storage.sql, rows.map((row) => row.github_id));
    return queueOrder(
      rows.map((row) => ({ githubId: row.github_id, queuedAt: row.queued_at, activeFriends: friends.get(row.github_id) ?? 0 })),
      policy.queueReferralPlaces,
    );
  }

  /** Last week's free cost and actives (non-admins with a request), and the forecast from them. */
  #forecast(now: number, policy: Policy): Forecast {
    const thisWeek = weekStart(now) / DAY_MS;
    const admins = JSON.stringify(policy.adminIds);
    const last = this.ctx.storage.sql
      .exec<{ actives: number; usd: number | null; credit: number | null }>(
        `SELECT COUNT(DISTINCT github_id) AS actives, SUM(cost_usd) AS usd, SUM(credit_usd) AS credit FROM daily_activity
         WHERE day >= ? AND day < ? AND requests > 0
           AND github_id NOT IN (SELECT github_id FROM people WHERE admitted_via = 'admin') AND github_id NOT IN (SELECT value FROM json_each(?))`,
        thisWeek - 7,
        thisWeek,
        admins,
      )
      .toArray()[0];
    const spend = this.#spendSync(now);
    // With Luminal serving, the queue protects the credit (see queue.ts).
    if (creditMode(policy)) return creditForecast({ lastWeekCreditUsd: last?.credit ?? 0, lastWeekActives: last?.actives ?? 0, policy, creditUsedUsd: spend.creditUsedUsd });
    return forecast({ lastWeekUsd: last?.usd ?? 0, lastWeekActives: last?.actives ?? 0, policy, totalSpentUsd: spend.totalSpentUsd });
  }

  /** Monday's admission, once per week, on the first call of the week (see queue.ts). */
  #runWeeklyQueue(now: number, policy: Policy): void {
    const sql = this.ctx.storage.sql;
    const week = weekStart(now);
    if (sql.exec("SELECT 1 FROM queue_runs WHERE week_start = ?", week).toArray().length > 0) return;
    this.ctx.storage.transactionSync(() => {
      const line = this.#line(policy);
      const plan = this.#forecast(now, policy);
      const admit = line.slice(0, Math.min(line.length, plan.room));
      for (const person of admit) sql.exec("UPDATE queue SET admitted_at = ?, admitted_how = 'weekly' WHERE github_id = ?", now, person.githubId);
      sql.exec(
        "INSERT INTO queue_runs (week_start, ran_at, admitted, waiting_before, avg_usd, actives, budget_usd) VALUES (?, ?, ?, ?, ?, ?, ?)",
        week,
        now,
        admit.length,
        line.length,
        plan.avgUsd,
        plan.actives,
        plan.budgetUsd,
      );
    });
  }

  #place(githubId: number, now: number, policy: Policy): QueuePlace | null {
    const sql = this.ctx.storage.sql;
    if (sql.exec("SELECT 1 FROM queue WHERE github_id = ? AND admitted_at IS NULL", githubId).toArray().length === 0) return null;
    const line = this.#line(policy);
    const position = line.findIndex((person) => person.githubId === githubId) + 1;
    const lastRun = sql.exec<{ admitted: number }>("SELECT admitted FROM queue_runs WHERE admitted > 0 ORDER BY week_start DESC LIMIT 1").toArray()[0];
    const perWeek = lastRun?.admitted ?? Math.min(this.#forecast(now, policy).room, line.length);
    return { position, etaAt: etaAt(position, perWeek, now), waiting: line.length };
  }

  /** Admin: the line, front first. */
  async queueView(now: number, envPolicy: Policy): Promise<{ waiting: Array<{ position: number; githubId: number; login: string | null; queuedAt: number; activeFriends: number }>; runs: QueueRun[]; forecast: Forecast }> {
    const policy = this.#policy(envPolicy);
    this.#runWeeklyQueue(now, policy);
    const logins = new Map(this.ctx.storage.sql.exec<{ github_id: number; login: string }>("SELECT p.github_id, p.login FROM people p JOIN queue q ON q.github_id = p.github_id WHERE q.admitted_at IS NULL").toArray().map((row) => [row.github_id, row.login]));
    return {
      waiting: this.#line(policy).map((person, index) => ({ position: index + 1, githubId: person.githubId, login: logins.get(person.githubId) ?? null, queuedAt: person.queuedAt, activeFriends: person.activeFriends })),
      runs: this.ctx.storage.sql
        .exec<{ week_start: number; ran_at: number; admitted: number; waiting_before: number; avg_usd: number; actives: number; budget_usd: number | null }>("SELECT * FROM queue_runs ORDER BY week_start DESC LIMIT 12")
        .toArray()
        .map((row) => ({ weekStart: row.week_start, ranAt: row.ran_at, admitted: row.admitted, waitingBefore: row.waiting_before, avgUsd: row.avg_usd, actives: row.actives, budgetUsd: row.budget_usd })),
      forecast: this.#forecast(now, policy),
    };
  }

  /** Admin: lets the next `count` people in now (front of the line first). Returns their ids. */
  async admitFromQueue(count: number, now: number, envPolicy: Policy): Promise<number[]> {
    const policy = this.#policy(envPolicy);
    return this.ctx.storage.transactionSync(() => {
      const admit = this.#line(policy).slice(0, count);
      for (const person of admit) this.ctx.storage.sql.exec("UPDATE queue SET admitted_at = ?, admitted_how = 'admin' WHERE github_id = ?", now, person.githubId);
      return admit.map((person) => person.githubId);
    });
  }

  #policy(envPolicy: Policy): Policy {
    return applyOverrides(envPolicy, this.#overrides());
  }

  #personState(githubId: number, now: number, policy: Policy): PersonState {
    const sql = this.ctx.storage.sql;
    const person = sql.exec<{ login: string }>("SELECT login FROM people WHERE github_id = ?", githubId).toArray()[0];
    if (!person) return { queue: null, bonusTokens: 0, referral: null };
    const code = this.#ensureCode(githubId, person.login, now);
    const counting = countingPairs(sql, this.#pairs(githubId), now);
    const joined = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM referrals WHERE referrer_id = ? AND outcome = 'ok'", githubId).toArray()[0]?.n ?? 0;
    return {
      queue: this.#place(githubId, now, policy),
      bonusTokens: bonuses(counting, policy).get(githubId) ?? 0,
      referral: { code, joined, activeThisWeek: counting.filter((pair) => pair.referrer === githubId).length },
    };
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

  /** Sets the admin kill switch; true when it changed. */
  async setPaused(paused: boolean, actor?: { githubId: number; login: string; now: number }): Promise<boolean> {
    return this.ctx.storage.transactionSync(() => {
      const before = this.#paused();
      this.ctx.storage.sql.exec("INSERT INTO settings (key, value) VALUES ('paused', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", paused ? "1" : "0");
      if (actor && before !== paused) this.#log("paused", before, paused, actor);
      return before !== paused;
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

  /**
   * What a request checks before forwarding: the admin kill switch, the overrides and non-admin
   * spend. With the env settings (`envPolicy`), Monday's queue admission runs first if it hasn't
   * this week; with `githubId` too, the caller's queue place, referral numbers and bonus.
   */
  async gate(now: number, envPolicy?: Policy, githubId?: number): Promise<Gate> {
    const overrides = this.#overrides();
    const policy = envPolicy ? applyOverrides(envPolicy, overrides) : undefined;
    if (policy) this.#runWeeklyQueue(now, policy);
    const spend = this.#spendSync(now);
    return {
      paused: this.#paused(),
      weekUsd: spend.spentUsd,
      totalUsd: spend.totalSpentUsd,
      creditUsedUsd: spend.creditUsedUsd,
      weekCreditUsd: spend.freeCreditWeekUsd,
      overrides,
      ...(policy && githubId !== undefined ? { person: this.#personState(githubId, now, policy) } : {}),
    };
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
    return this.#spendSync(now);
  }

  #spendSync(now: number): SpendSummary {
    const start = weekStart(now);
    type Row = {
      usd: number;
      tokens: number;
      requests: number;
      admin_usd: number;
      admin_tokens: number;
      admin_requests: number;
      paid_usd: number;
      paid_tokens: number;
      paid_requests: number;
      credit_usd: number;
      free_credit_usd: number;
    };
    const row = this.ctx.storage.sql.exec<Row>("SELECT * FROM spend_weeks WHERE week_start = ?", start).toArray()[0];
    const total = this.ctx.storage.sql
      .exec<{ usd: number | null; admin_usd: number | null; credit_usd: number | null }>("SELECT SUM(usd) AS usd, SUM(admin_usd) AS admin_usd, SUM(credit_usd) AS credit_usd FROM spend_weeks")
      .toArray()[0];
    return {
      weekStart: start,
      resetsAt: weekEnd(now),
      spentUsd: round(row?.usd ?? 0),
      tokens: row?.tokens ?? 0,
      requests: row?.requests ?? 0,
      adminSpentUsd: round(row?.admin_usd ?? 0),
      adminTokens: row?.admin_tokens ?? 0,
      adminRequests: row?.admin_requests ?? 0,
      paidUsd: round(row?.paid_usd ?? 0),
      paidTokens: row?.paid_tokens ?? 0,
      paidRequests: row?.paid_requests ?? 0,
      totalSpentUsd: round(total?.usd ?? 0),
      adminTotalSpentUsd: round(total?.admin_usd ?? 0),
      creditUsedUsd: round(total?.credit_usd ?? 0),
      creditWeekUsd: round(row?.credit_usd ?? 0),
      freeCreditWeekUsd: round(row?.free_credit_usd ?? 0),
    };
  }

  // ─── Billing ─────────────────────────────────────────────────────────────

  /** Whether a Stripe event id was handled already (webhooks are delivered at least once). */
  async billingEventSeen(id: string): Promise<boolean> {
    return this.ctx.storage.sql.exec("SELECT 1 FROM billing_events WHERE id = ?", id).toArray().length > 0;
  }

  /** Marks an event handled; false when another delivery got there first. */
  async markBillingEvent(id: string, kind: string, now: number): Promise<boolean> {
    return this.ctx.storage.sql.exec("INSERT INTO billing_events (id, kind, at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING RETURNING id", id, kind, now).toArray().length > 0;
  }

  async mapCustomer(customerId: string, githubId: number): Promise<void> {
    this.ctx.storage.sql.exec("INSERT INTO customers (customer_id, github_id) VALUES (?, ?) ON CONFLICT(customer_id) DO NOTHING", customerId, githubId);
  }

  async customerOwner(customerId: string): Promise<number | undefined> {
    return this.ctx.storage.sql.exec<{ github_id: number }>("SELECT github_id FROM customers WHERE customer_id = ?", customerId).toArray()[0]?.github_id;
  }

  /** A payment for the revenue numbers, once per id (a Checkout Session or an invoice). */
  async recordPayment(input: { id: string; githubId: number; kind: "pro" | "topup"; amountCents: number; at: number }): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT INTO payments (id, github_id, kind, amount_cents, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
      input.id,
      input.githubId,
      input.kind,
      input.amountCents,
      input.at,
    );
  }

  /** The dashboard's copy of a Pro subscription's state; older events don't overwrite newer ones. */
  async mirrorSubscription(input: { githubId: number; state: string; periodEnd: number | null | undefined; eventAt: number }): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO subscriptions (github_id, state, period_end, state_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(github_id) DO UPDATE SET state = excluded.state, period_end = COALESCE(excluded.period_end, period_end), state_at = excluded.state_at
       WHERE excluded.state_at >= subscriptions.state_at`,
      input.githubId,
      input.state,
      input.periodEnd ?? null,
      input.eventAt,
    );
  }

  // ─── Records ─────────────────────────────────────────────────────────────

  /**
   * Logs one request. With the effective settings (`policy`), also returns the alerts it
   * triggered: free spend crossing a threshold of either cap, or the host's failure rate over
   * the last hour passing 20%. Each one is marked sent here, so it fires once.
   */
  async recordRequest(record: RequestRecord, policy?: Policy): Promise<Alert[]> {
    const alerts: Alert[] = [];
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO requests (github_id, is_admin, at, model, prompt_tokens, completion_tokens, cached_tokens, charged_tokens, cost_usd, status, latency_ms, paid,
                               upstream, credit_usd, ttfb_ms, ttft_ms, upstream_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        record.paid ? 1 : 0,
        record.upstream ?? "openrouter",
        record.creditUsd ?? 0,
        record.ttfbMs ?? null,
        record.ttftMs ?? null,
        record.upstreamError ? 1 : 0,
      );
      const admin = record.isAdmin ? 1 : 0;
      // Three buckets: admins; paid usage (Pro, top-ups); and free usage, the only one the caps count.
      const paid = !admin && record.paid === true;
      const free = !admin && !paid;
      // The dollar columns of spend_weeks are cash: OpenRouter's cost only. Luminal credit is
      // kept apart, all of it in credit_usd and the free share in free_credit_usd.
      const upstream: Upstream = record.upstream ?? "openrouter";
      const cash = upstream === "openrouter" ? record.costUsd : 0;
      const credit = upstream === "luminal" ? (record.creditUsd ?? 0) : 0;
      this.ctx.storage.sql.exec(
        `INSERT INTO spend_weeks (week_start, usd, tokens, requests, admin_usd, admin_tokens, admin_requests, paid_usd, paid_tokens, paid_requests, credit_usd, free_credit_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(week_start) DO UPDATE SET
           usd = usd + excluded.usd, tokens = tokens + excluded.tokens, requests = requests + excluded.requests,
           admin_usd = admin_usd + excluded.admin_usd, admin_tokens = admin_tokens + excluded.admin_tokens,
           admin_requests = admin_requests + excluded.admin_requests,
           paid_usd = paid_usd + excluded.paid_usd, paid_tokens = paid_tokens + excluded.paid_tokens, paid_requests = paid_requests + excluded.paid_requests,
           credit_usd = credit_usd + excluded.credit_usd, free_credit_usd = free_credit_usd + excluded.free_credit_usd`,
        weekStart(record.at),
        free ? cash : 0,
        free ? record.chargedTokens : 0,
        free ? 1 : 0,
        admin ? cash : 0,
        admin ? record.chargedTokens : 0,
        admin,
        paid ? cash : 0,
        paid ? record.chargedTokens : 0,
        paid ? 1 : 0,
        credit,
        free ? credit : 0,
      );
      if (!admin) {
        // cost_usd here is what the allowance was charged (OpenRouter prices), for cost per person.
        this.#addActivity(record.githubId, record.at, {
          requests: 1,
          events: 0,
          chargedTokens: free ? record.chargedTokens : 0,
          costUsd: free ? record.costUsd : 0,
          paidCostUsd: paid ? cash : 0,
          creditUsd: free ? credit : 0,
        });
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO upstream_daily (day, upstream, requests, errors, prompt_tokens, cached_tokens, cash_usd, credit_usd) VALUES (?, ?, 1, ?, ?, ?, ?, ?)
         ON CONFLICT (day, upstream) DO UPDATE SET requests = requests + 1, errors = errors + excluded.errors,
           prompt_tokens = prompt_tokens + excluded.prompt_tokens, cached_tokens = cached_tokens + excluded.cached_tokens,
           cash_usd = cash_usd + excluded.cash_usd, credit_usd = credit_usd + excluded.credit_usd`,
        Math.floor(record.at / DAY_MS),
        upstream,
        record.upstreamError ? 1 : 0,
        record.promptTokens,
        record.cachedTokens,
        cash,
        credit,
      );
      if (record.ttfbMs != null || record.ttftMs != null) {
        this.ctx.storage.sql.exec("INSERT INTO upstream_timings (at, upstream, ttfb_ms, ttft_ms) VALUES (?, ?, ?, ?)", record.at, upstream, record.ttfbMs ?? null, record.ttftMs ?? null);
        this.ctx.storage.sql.exec("DELETE FROM upstream_timings WHERE at < ?", record.at - TIMINGS_MAX_AGE_MS);
      }
      const minute = Math.floor(record.at / 60_000);
      this.ctx.storage.sql.exec(
        `INSERT INTO upstream_minutes (minute, upstream, requests, errors) VALUES (?, ?, 1, ?)
         ON CONFLICT (minute, upstream) DO UPDATE SET requests = requests + 1, errors = errors + excluded.errors`,
        minute,
        upstream,
        record.upstreamError ? 1 : 0,
      );
      this.ctx.storage.sql.exec("DELETE FROM upstream_minutes WHERE minute < ?", minute - 120);
      if (policy && upstream === "luminal") {
        const errorAlert = this.#upstreamAlert(upstream, record.at);
        if (errorAlert) alerts.push(errorAlert);
        if (credit > 0) alerts.push(...this.#creditAlerts(record.at, policy));
      }
      if (record.host) {
        const failed = record.hostFailure ? 1 : 0;
        this.ctx.storage.sql.exec(
          `INSERT INTO host_daily (day, host, requests, failures) VALUES (?, ?, 1, ?)
           ON CONFLICT (day, host) DO UPDATE SET requests = requests + 1, failures = failures + excluded.failures`,
          Math.floor(record.at / DAY_MS),
          record.host,
          failed,
        );
        if (record.hostFailure) {
          this.ctx.storage.sql.exec(
            "INSERT INTO host_failures (at, host, kind, upstream_status) VALUES (?, ?, ?, ?)",
            record.at,
            record.host,
            record.hostFailure.kind,
            record.hostFailure.upstreamStatus,
          );
        }
        const minute = Math.floor(record.at / 60_000);
        this.ctx.storage.sql.exec(
          `INSERT INTO host_minutes (minute, host, requests, failures) VALUES (?, ?, 1, ?)
           ON CONFLICT (minute, host) DO UPDATE SET requests = requests + 1, failures = failures + excluded.failures`,
          minute,
          record.host,
          failed,
        );
        this.ctx.storage.sql.exec("DELETE FROM host_minutes WHERE minute < ?", minute - 120);
        if (policy) {
          const alert = this.#hostAlert(record.host, record.at);
          if (alert) alerts.push(alert);
        }
      }
      if (policy && free) alerts.push(...this.#spendAlerts(record.at, policy));
    });
    return alerts;
  }

  /** Marks an alert key sent; false when it already was. */
  #markAlert(key: string, now: number): boolean {
    return this.ctx.storage.sql.exec("INSERT INTO alerts_sent (key, at) VALUES (?, ?) ON CONFLICT(key) DO NOTHING RETURNING key", key, now).toArray().length > 0;
  }

  #sentThresholds(prefix: string): Set<number> {
    return new Set(
      this.ctx.storage.sql
        .exec<{ key: string }>("SELECT key FROM alerts_sent WHERE key LIKE ?", `${prefix}%`)
        .toArray()
        .map((row) => Number(row.key.slice(prefix.length))),
    );
  }

  #spendAlerts(now: number, policy: Policy): Alert[] {
    const spend = this.#spendSync(now);
    const out: Alert[] = [];
    const check = (prefix: string, spent: number, cap: number | undefined, message: (spent: number, cap: number, threshold: number) => Alert) => {
      if (cap === undefined || cap <= 0) return;
      const hit = crossed(spent / cap, this.#sentThresholds(prefix));
      if (!hit) return;
      for (const threshold of hit.mark) this.#markAlert(`${prefix}${threshold}`, now);
      out.push(message(spent, cap, hit.threshold));
    };
    check(`spend:week:${spend.weekStart}:`, spend.spentUsd, policy.globalWeeklyUsdCap, weeklySpendAlert);
    check("spend:total:", spend.totalSpentUsd, policy.globalTotalUsdCap, totalSpendAlert);
    return out;
  }

  /** A host failing more than 20% of at least 20 requests in the last hour: alert once until it recovers. */
  #hostAlert(host: string, now: number): Alert | undefined {
    const since = Math.floor((now - HOST_WINDOW_MS) / 60_000);
    const row = this.ctx.storage.sql
      .exec<{ requests: number | null; failures: number | null }>("SELECT SUM(requests) AS requests, SUM(failures) AS failures FROM host_minutes WHERE host = ? AND minute > ?", host, since)
      .toArray()[0];
    const requests = row?.requests ?? 0;
    const failures = row?.failures ?? 0;
    const key = `host:${host}`;
    if (requests >= HOST_MIN_REQUESTS && failures / requests > HOST_FAILURE_RATE) {
      return this.#markAlert(key, now) ? hostFailureAlert(host, failures, requests) : undefined;
    }
    // Re-armed once the host is healthy again.
    if (requests >= HOST_MIN_REQUESTS) this.ctx.storage.sql.exec("DELETE FROM alerts_sent WHERE key = ?", key);
    return undefined;
  }

  /** Luminal credit used crossing 50%, 80% and 100% of the balance: once each per balance (a new balance re-arms them). */
  #creditAlerts(now: number, policy: Policy): Alert[] {
    const balance = policy.luminalCreditUsd;
    if (balance <= 0) return [];
    const prefix = `credit:${balance}:`;
    const used = this.#spendSync(now).creditUsedUsd;
    const hit = crossed(used / balance, this.#sentThresholds(prefix));
    if (!hit) return [];
    for (const threshold of hit.mark) this.#markAlert(`${prefix}${threshold}`, now);
    return [creditAlert(used, balance, hit.threshold)];
  }

  /**
   * The alert for Luminal-served usage pausing because the credit ran out: once per balance.
   * Undefined when it was already sent.
   */
  async creditPausedAlert(balance: number, now: number): Promise<Alert | undefined> {
    if (!this.#markAlert(`credit-paused:${balance}`, now)) return undefined;
    return creditPausedAlert(this.#spendSync(now).creditUsedUsd, balance);
  }

  /** An upstream failing more than 20% of at least 20 requests in the last hour: alert once until it recovers. */
  #upstreamAlert(upstream: Upstream, now: number): Alert | undefined {
    const since = Math.floor((now - HOST_WINDOW_MS) / 60_000);
    const row = this.ctx.storage.sql
      .exec<{ requests: number | null; errors: number | null }>("SELECT SUM(requests) AS requests, SUM(errors) AS errors FROM upstream_minutes WHERE upstream = ? AND minute > ?", upstream, since)
      .toArray()[0];
    const requests = row?.requests ?? 0;
    const errors = row?.errors ?? 0;
    const key = `upstream:${upstream}`;
    if (requests >= HOST_MIN_REQUESTS && errors / requests > HOST_FAILURE_RATE) {
      return this.#markAlert(key, now) ? upstreamErrorAlert(upstream, errors, requests) : undefined;
    }
    if (requests >= HOST_MIN_REQUESTS) this.ctx.storage.sql.exec("DELETE FROM alerts_sent WHERE key = ?", key);
    return undefined;
  }

  /** The queue-started alert for an admission that queued the first person. */
  async queueStartedAlert(now: number, envPolicy: Policy): Promise<Alert> {
    const policy = this.#policy(envPolicy);
    const spend = this.#spendSync(now);
    if (creditMode(policy) && policy.luminalWeeklyCreditUsd !== undefined && spend.freeCreditWeekUsd >= policy.queueThreshold * policy.luminalWeeklyCreditUsd) {
      return queueStartedAlert(spend.freeCreditWeekUsd, policy.luminalWeeklyCreditUsd, "credit");
    }
    return queueStartedAlert(spend.spentUsd, policy.globalWeeklyUsdCap);
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

  /**
   * Counts one outcome of the sign-up GitHub activity check's contribution lookup. Returns the
   * alert when GitHub errors reach GITHUB_CHECK_ERROR_ALERT today (once a day).
   */
  async countGithubCheck(outcome: GithubCheckOutcome, now: number): Promise<Alert | undefined> {
    const day = Math.floor(now / DAY_MS);
    const n =
      this.ctx.storage.sql
        .exec<{ n: number }>(
          `INSERT INTO github_checks_daily (day, outcome, n) VALUES (?, ?, 1)
           ON CONFLICT (day, outcome) DO UPDATE SET n = n + 1 RETURNING n`,
          day,
          outcome,
        )
        .toArray()[0]?.n ?? 0;
    if (outcome !== "error" || n < GITHUB_CHECK_ERROR_ALERT) return undefined;
    return this.#markAlert(`github-check-errors:${day}`, now) ? githubCheckErrorAlert(n) : undefined;
  }

  /** Adds one to the day's count of install scripts served (telemetry.ts). */
  async countDownload(count: DownloadCount, day: number): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO download_daily (day, route, client, downloads) VALUES (?, ?, ?, 1)
       ON CONFLICT (day, route, client) DO UPDATE SET downloads = downloads + 1`,
      day,
      count.route,
      count.client,
    );
  }

  /** Adds one to the day's count of finished installs with these values (telemetry.ts). */
  async countInstall(count: InstallCount, day: number): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO install_daily (day, os, arch, mode, dl_version, result, failed_step, via, installs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT (day, os, arch, mode, dl_version, result, failed_step, via) DO UPDATE SET installs = installs + 1`,
      day,
      count.os,
      count.arch,
      count.mode,
      count.dlVersion,
      count.result,
      count.failedStep,
      count.via,
    );
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
  async dashboard(input: { now: number; adminIds: number[]; limits: DashboardLimits; topWeek?: number; policy?: Policy }): Promise<DashboardData> {
    const policy = input.policy ? this.#policy(input.policy) : undefined;
    if (policy) this.#runWeeklyQueue(input.now, policy);
    const data = dashboardData(this.ctx.storage.sql, input);
    if (policy) {
      // This week's referral bonuses, from the pairs that count (counts only).
      const granted = bonuses(countingPairs(this.ctx.storage.sql, this.#pairs(), input.now), policy);
      data.referrals.bonusTokensThisWeek = [...granted.values()].reduce((sum, value) => sum + value, 0);
      data.referrals.peopleWithBonus = granted.size;
    }
    return data;
  }

  /**
   * The daily digest for the UTC day before `now` (the cron runs at 01:00 UTC), or undefined
   * when that day's digest was already sent: a retried or doubled cron run never sends twice.
   * The numbers come from the dashboard's queries (as of the end of that day), the weekly spend
   * and the request log; admins are left out. `envPaused` is the PAUSED var.
   */
  async dailyDigest(now: number, envPolicy: Policy, envPaused: boolean): Promise<Alert | undefined> {
    const policy = this.#policy(envPolicy);
    const until = Math.floor(now / DAY_MS) * DAY_MS;
    const from = until - DAY_MS;
    const date = isoDay(from);
    if (!this.#markAlert(`digest:${date}`, now)) return undefined;
    const sql = this.ctx.storage.sql;
    const end = until - 1;
    const admins = JSON.stringify([...policy.adminIds]);
    const data = dashboardData(sql, { now: end, adminIds: policy.adminIds, limits: { weeklyTokens: policy.weeklyTokens, weeklyUsd: policy.perPersonWeeklyUsdCap ?? null } });
    const day = data.installFunnel.days[0]!;
    const week = weekStart(end);
    // The live totals, less anything after the day reported (the first hour of today).
    const live = this.#spendSync(now);
    const after = this.#usage(until, Number.MAX_SAFE_INTEGER);
    const weekUsage = this.#usage(week, until);
    const weekPeople = sql
      .exec<{ signups: number; active: number }>(
        `SELECT (SELECT COUNT(*) FROM people WHERE admitted_at >= ? AND admitted_at < ? AND ${notAdmin("github_id")}) AS signups,
                (SELECT COUNT(DISTINCT github_id) FROM daily_activity WHERE day >= ? AND day < ? AND requests > 0 AND ${notAdmin("github_id")}) AS active`,
        week,
        until,
        admins,
        week / DAY_MS,
        until / DAY_MS,
        admins,
      )
      .toArray()[0];
    const people = sql
      .exec<{ login: string; admitted_via: string; referral: number }>(
        `SELECT p.login AS login, p.admitted_via AS admitted_via, EXISTS (SELECT 1 FROM referrals r WHERE r.referred_id = p.github_id AND r.outcome = 'ok') AS referral
         FROM people p WHERE p.admitted_at >= ? AND p.admitted_at < ? AND ${notAdmin("p.github_id")} ORDER BY p.admitted_at, p.github_id LIMIT ?`,
        from,
        until,
        admins,
        DIGEST_MAX_LOGINS,
      )
      .toArray()
      .map((row) => ({ login: row.login, how: { via: row.admitted_via === "open" ? "open" : "invite", referral: row.referral === 1 } satisfies SignupHow }));
    const { platforms, failedSteps } = installBreakdown(sql, from / DAY_MS, until / DAY_MS);
    return dailyDigestAlert({
      date,
      signups: { count: day.signedUp, people },
      active: day.active,
      usage: this.#usage(from, until),
      payments: this.#payments(from, until),
      installs: { ok: day.installsOk, failed: day.installsFailed, platforms, failedSteps },
      week: {
        start: isoDay(week),
        signups: weekPeople?.signups ?? 0,
        active: weekPeople?.active ?? 0,
        usage: weekUsage,
        payments: this.#payments(week, until),
        cashUsd: weekUsage.freeCashUsd,
        weeklyCapUsd: policy.globalWeeklyUsdCap,
        totalUsd: Math.max(0, round(live.totalSpentUsd - after.freeCashUsd)),
        totalCapUsd: policy.globalTotalUsdCap,
      },
      credit: { balanceUsd: policy.luminalCreditUsd, leftUsd: Math.max(0, round(policy.luminalCreditUsd - live.creditUsedUsd)) },
      queueWaiting: data.queue.waiting,
      paused: envPaused || this.#paused(),
    });
  }

  /** Requests and tokens of everyone but admins in [from, until); dollars of free usage only (as spend_weeks counts them). */
  #usage(from: number, until: number): DigestUsage {
    const row = this.ctx.storage.sql
      .exec<{ requests: number; tokens_in: number | null; cached: number | null; tokens_out: number | null; cash: number | null; credit: number | null }>(
        `SELECT COUNT(*) AS requests, SUM(prompt_tokens) AS tokens_in, SUM(cached_tokens) AS cached, SUM(completion_tokens) AS tokens_out,
                SUM(CASE WHEN paid = 0 AND upstream = 'openrouter' THEN cost_usd ELSE 0 END) AS cash,
                SUM(CASE WHEN paid = 0 AND upstream = 'luminal' THEN credit_usd ELSE 0 END) AS credit
         FROM requests WHERE is_admin = 0 AND at >= ? AND at < ?`,
        from,
        until,
      )
      .toArray()[0];
    return {
      requests: row?.requests ?? 0,
      tokensIn: row?.tokens_in ?? 0,
      tokensCached: row?.cached ?? 0,
      tokensOut: row?.tokens_out ?? 0,
      freeCashUsd: round(row?.cash ?? 0),
      freeCreditUsd: round(row?.credit ?? 0),
    };
  }

  /** Payments in [from, until): how many, and revenue before tax in USD. */
  #payments(from: number, until: number): { count: number; usd: number } {
    const row = this.ctx.storage.sql
      .exec<{ n: number; cents: number | null }>("SELECT COUNT(*) AS n, SUM(amount_cents) AS cents FROM payments WHERE at >= ? AND at < ?", from, until)
      .toArray()[0];
    return { count: row?.n ?? 0, usd: (row?.cents ?? 0) / 100 };
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

    const hosts = sql
      .exec<{ host: string; requests: number; failures: number }>(
        `SELECT host, SUM(requests) AS requests, SUM(failures) AS failures FROM host_daily
         WHERE day >= ? AND day < ? GROUP BY host ORDER BY requests DESC, host`,
        from / DAY_MS,
        until / DAY_MS,
      )
      .toArray()
      .map((row) => ({ host: row.host, requests: row.requests, failures: row.failures, failureRate: share(row.failures, row.requests) }));

    const githubChecks: Record<GithubCheckOutcome, number> = { contributions: 0, none: 0, error: 0 };
    for (const row of sql
      .exec<{ outcome: string; n: number }>("SELECT outcome, SUM(n) AS n FROM github_checks_daily WHERE day >= ? AND day < ? GROUP BY outcome", from / DAY_MS, until / DAY_MS)
      .toArray()) {
      if (row.outcome in githubChecks) githubChecks[row.outcome as GithubCheckOutcome] = row.n;
    }

    return {
      from: isoDay(from),
      to: isoDay(until - DAY_MS),
      daily,
      hosts,
      githubChecks,
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
