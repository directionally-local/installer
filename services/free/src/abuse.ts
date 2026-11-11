import { notAdmin, type Sql } from "./dashboard-data.js";
import { DAY_MS, weekStart } from "./week.js";

/**
 * The admin dashboard's abuse section: signals that one person runs several free accounts, or
 * that one account uses far more than the rest. Read from the Directory's own tables:
 *
 *   person_networks   keyed hashes of the networks (IPv4 address, IPv6 /64) each person signed in
 *                     from; two accounts sharing one is a cluster
 *   device_refusals   sign-ins refused with device_taken (the device holds another account's grant)
 *   referrals         referral pairs stopped as same_network
 *   daily_activity    per person per day: requests, charged tokens, cost, credit, events and dl sessions
 *   github_checks_daily  the sign-up GitHub activity check's daily outcomes
 *   people            login, status (blocked) and sign-up time
 *   config_log        the admin log, where blocks and unblocks are written
 *   requests          chat requests, for failures and free use outside dl
 *
 * Network hashes are keyed with the signing key and shown shortened: they group accounts, they
 * don't reveal an address. Admins are left out of every list. Counts, times and who only;
 * never content. `ABUSE_COLUMNS` lists every column read (a test holds the queries to it).
 */

export const ABUSE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  person_networks: ["github_id", "net_hash", "first_at"],
  device_refusals: ["id", "at", "github_id", "login", "device_id", "holder_id"],
  referrals: ["referred_id", "referrer_id", "outcome", "at"],
  daily_activity: ["day", "github_id", "requests", "charged_tokens", "cost_usd", "credit_usd", "events", "sessions"],
  github_checks_daily: ["day", "outcome", "n"],
  people: ["github_id", "login", "status", "admitted_at", "admitted_via", "level"],
  requests: ["github_id", "at", "is_admin", "status", "paid", "via_key"],
  config_log: ["id", "key", "old_value", "new_value", "changed_by", "changed_by_login", "changed_at"],
};

/** Clusters and lists are cut to this many rows. */
export const ABUSE_ROWS = 25;
/** Device refusals and GitHub checks cover this many days. */
export const ABUSE_DAYS = 7;

/** One account's footprint, as the abuse tables show it. */
export interface AbusePerson {
  githubId: number;
  login: string | null;
  status: string | null;
  admittedAt: number | null;
  /** This week (Monday 00:00 UTC on): requests, charged tokens, cost (OpenRouter prices) and Luminal credit. */
  weekRequests: number;
  weekTokens: number;
  weekCostUsd: number;
  weekCreditUsd: number;
  /** dl sessions this week: new session ids in the session events Autopilot sent. */
  weekSessions: number;
}

export interface NetworkCluster {
  /** The first 10 hex characters of the keyed network hash. */
  net: string;
  /** When the first and last of these accounts were first seen on the network. */
  firstAt: number;
  lastAt: number;
  members: Array<AbusePerson & { seenAt: number }>;
}

export interface DeviceRefusal {
  at: number;
  /** The account that tried to sign in. */
  person: AbusePerson;
  /** The account the device's grant belongs to. */
  holder: AbusePerson;
  /** Shortened client device id. */
  device: string;
  /** Refusals for this device in the window. */
  attempts: number;
}

export interface SameNetworkReferral {
  at: number;
  referrer: AbusePerson;
  referred: AbusePerson;
}

export interface TopUser extends AbusePerson {
  activeDays: number;
  /** Other accounts sharing a network with this one. */
  sharedWith: number;
}

export interface AdminLogEntry {
  at: number;
  key: string;
  oldValue: unknown;
  newValue: unknown;
  byLogin: string;
}

export interface AbuseData {
  clusters: NetworkCluster[];
  /** All clusters and the accounts in them, before the row cut. */
  clusterCount: number;
  clusteredAccounts: number;
  deviceRefusals: DeviceRefusal[];
  deviceRefusalCount: number;
  sameNetworkReferrals: SameNetworkReferral[];
  sameNetworkReferralCount: number;
  topUsers: TopUser[];
  blocked: AbusePerson[];
  /** Per UTC day (newest first): the sign-up GitHub activity check's contribution lookups. */
  githubChecks: Array<{ day: number; contributions: number; none: number; error: number }>;
  adminLog: AdminLogEntry[];
}

function parse(value: string | null): unknown {
  if (value === null) return "(env)";
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** The simple view's token chart: this many people at most. */
export const TOP_TOKEN_USERS = 15;

/** The simple view's per-person numbers: who used the most tokens, who fails a lot, sign-up bursts. */
export interface SimpleData {
  /** This week's charged tokens per person, most first, cut to TOP_TOKEN_USERS. */
  topTokens: Array<{ githubId: number; login: string | null; level: string | null; tokens: number }>;
  /** This week: people with at least FAILING_MIN failed or abandoned requests, a FAILING_SHARE of theirs or more. */
  failing: Array<{ githubId: number; login: string | null; requests: number; failed: number }>;
  /** In the last BURST_DAYS days: a network that BURST_MIN or more new accounts were first seen on in one UTC day. */
  bursts: Array<{ net: string; day: number; accounts: number }>;
  /**
   * In the last OUTSIDE_DL_DAYS days: OUTSIDE_DL_MIN_REQUESTS or more free chat requests with a
   * sign-in token, and not one session event (counted by UTC day, from the first day the window touches).
   */
  outsideDl: Array<{ githubId: number; login: string | null; requests: number }>;
}

export const FAILING_MIN = 10;
export const FAILING_SHARE = 0.3;
export const BURST_MIN = 3;
export const BURST_DAYS = 7;
/** The red flag "Used outside dl": this many free chat requests in OUTSIDE_DL_DAYS days, and no session event. */
export const OUTSIDE_DL_MIN_REQUESTS = 10;
export const OUTSIDE_DL_DAYS = 7;

/**
 * Free tokens work inside dl only (the runtime setting `dlOnly`): Autopilot always sends session
 * events while the free tier is its provider. A session event (one with a session id) covers the
 * DL_ONLY_WINDOW_MS after it; an account with no session event in the last DL_ONLY_WINDOW_MS is
 * refused once it has made DL_ONLY_MIN_REQUESTS free chat requests that no session event covers
 * (every one of them, for an account that never sent one). Autopilot batches events for a few
 * seconds, so a new session's first requests come before its first event; the threshold is that
 * grace. It is used up, not renewed every day: an account that never sends a session event gets
 * that many requests in all, not that many a day. Requests with a server key (dl's server mode),
 * admins' and paid ones aren't counted.
 */
export const DL_ONLY_MIN_REQUESTS = 20;
export const DL_ONLY_WINDOW_MS = DAY_MS;

/** Free sign-in-token chat requests: the ones the dl-only checks count. */
const counted = (prefix = "") => `${prefix}is_admin = 0 AND ${prefix}paid = 0 AND ${prefix}via_key = 0`;

/**
 * True when `githubId` is using free tokens outside dl (see above). Indexed reads that stop
 * early: the latest session event (newest first, stops at the first), then at most
 * DL_ONLY_MIN_REQUESTS request rows that it doesn't cover.
 */
export function outsideDl(store: Sql, githubId: number, now: number): boolean {
  const last =
    store
      .exec<{ received_at: number }>("SELECT received_at FROM events WHERE github_id = ? AND session_id IS NOT NULL ORDER BY received_at DESC LIMIT 1", githubId)
      .toArray()[0]?.received_at ?? null;
  const coveredUntil = last === null ? -1 : last + DL_ONLY_WINDOW_MS;
  if (coveredUntil >= now) return false;
  const uncovered =
    store
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM requests WHERE github_id = ? AND at > ? AND ${counted()} LIMIT ?)`, githubId, coveredUntil, DL_ONLY_MIN_REQUESTS)
      .toArray()[0]?.n ?? 0;
  return uncovered >= DL_ONLY_MIN_REQUESTS;
}

/** Every query here starts with this comment, so a test can hold them to `ABUSE_COLUMNS`. */
export const ABUSE_QUERY_TAG = "/* abuse */";

export function abuseData(store: Sql, input: { now: number; adminIds: readonly number[] }): AbuseData {
  const sql: Sql = { exec: (query, ...bindings) => store.exec(`${ABUSE_QUERY_TAG} ${query}`, ...bindings) };
  const admins = JSON.stringify([...input.adminIds]);
  const weekDay = weekStart(input.now) / DAY_MS;
  const since = input.now - ABUSE_DAYS * DAY_MS;

  // Who, and this week's usage, for any set of ids the lists below name.
  const people = new Map<number, AbusePerson>();
  const lookup = (ids: Iterable<number>) => {
    const wanted = [...new Set(ids)].filter((id) => !people.has(id));
    if (wanted.length === 0) return;
    const list = JSON.stringify(wanted);
    for (const id of wanted) people.set(id, { githubId: id, login: null, status: null, admittedAt: null, weekRequests: 0, weekTokens: 0, weekCostUsd: 0, weekCreditUsd: 0, weekSessions: 0 });
    for (const row of sql
      .exec<{ github_id: number; login: string; status: string; admitted_at: number }>(
        "SELECT github_id, login, status, admitted_at FROM people WHERE github_id IN (SELECT value FROM json_each(?))",
        list,
      )
      .toArray()) {
      Object.assign(people.get(row.github_id)!, { login: row.login, status: row.status, admittedAt: row.admitted_at });
    }
    for (const row of sql
      .exec<{ github_id: number; requests: number; tokens: number; cost: number; credit: number; sessions: number }>(
        `SELECT github_id, SUM(requests) AS requests, SUM(charged_tokens) AS tokens, SUM(cost_usd) AS cost, SUM(credit_usd) AS credit, SUM(sessions) AS sessions
         FROM daily_activity WHERE day >= ? AND github_id IN (SELECT value FROM json_each(?)) GROUP BY github_id`,
        weekDay,
        list,
      )
      .toArray()) {
      Object.assign(people.get(row.github_id)!, { weekRequests: row.requests, weekTokens: row.tokens, weekCostUsd: row.cost, weekCreditUsd: row.credit, weekSessions: row.sessions });
    }
  };
  const person = (id: number) => people.get(id)!;

  // Networks shared by two or more accounts, biggest and most recent first.
  const shared = sql
    .exec<{ net_hash: string; n: number; first_at: number; last_at: number }>(
      `SELECT net_hash, COUNT(*) AS n, MIN(first_at) AS first_at, MAX(first_at) AS last_at FROM person_networks
       WHERE ${notAdmin("github_id")} GROUP BY net_hash HAVING COUNT(*) >= 2 ORDER BY n DESC, last_at DESC`,
      admins,
    )
    .toArray();
  const shown = shared.slice(0, ABUSE_ROWS);
  const members = sql
    .exec<{ net_hash: string; github_id: number; first_at: number }>(
      `SELECT net_hash, github_id, first_at FROM person_networks
       WHERE net_hash IN (SELECT value FROM json_each(?)) AND ${notAdmin("github_id")} ORDER BY first_at`,
      JSON.stringify(shown.map((row) => row.net_hash)),
      admins,
    )
    .toArray();
  lookup(members.map((row) => row.github_id));
  const clusters: NetworkCluster[] = shown.map((row) => ({
    net: row.net_hash.slice(0, 10),
    firstAt: row.first_at,
    lastAt: row.last_at,
    members: members.filter((member) => member.net_hash === row.net_hash).map((member) => ({ ...person(member.github_id), seenAt: member.first_at })),
  }));
  const clusteredAccounts =
    sql
      .exec<{ n: number }>(
        `SELECT COUNT(DISTINCT github_id) AS n FROM person_networks WHERE ${notAdmin("github_id")}
           AND net_hash IN (SELECT net_hash FROM person_networks WHERE ${notAdmin("github_id")} GROUP BY net_hash HAVING COUNT(*) >= 2)`,
        admins,
        admins,
      )
      .toArray()[0]?.n ?? 0;

  // device_taken refusals in the window, newest first, with how often each device was refused.
  const refusals = sql
    .exec<{ at: number; github_id: number; login: string; device_id: string; holder_id: number }>(
      "SELECT at, github_id, login, device_id, holder_id FROM device_refusals WHERE at >= ? ORDER BY at DESC, id DESC",
      since,
    )
    .toArray();
  const attempts = new Map<string, number>();
  for (const row of refusals) attempts.set(row.device_id, (attempts.get(row.device_id) ?? 0) + 1);
  const recentRefusals = refusals.slice(0, ABUSE_ROWS);
  lookup(recentRefusals.flatMap((row) => [row.github_id, row.holder_id]));

  const sameNetwork = sql
    .exec<{ referrer_id: number | null; referred_id: number; at: number }>("SELECT referrer_id, referred_id, at FROM referrals WHERE outcome = 'same_network' ORDER BY at DESC")
    .toArray();
  const pairs = sameNetwork.filter((row) => row.referrer_id !== null).slice(0, ABUSE_ROWS) as Array<{ referrer_id: number; referred_id: number; at: number }>;
  lookup(pairs.flatMap((row) => [row.referrer_id, row.referred_id]));

  const top = sql
    .exec<{ github_id: number; days: number; tokens: number }>(
      `SELECT github_id, COUNT(*) AS days, SUM(charged_tokens) AS tokens FROM daily_activity
       WHERE day >= ? AND requests > 0 AND ${notAdmin("github_id")} GROUP BY github_id ORDER BY tokens DESC, github_id LIMIT ?`,
      weekDay,
      admins,
      ABUSE_ROWS,
    )
    .toArray();
  lookup(top.map((row) => row.github_id));
  const sharedCounts = new Map(
    sql
      .exec<{ github_id: number; n: number }>(
        `SELECT a.github_id AS github_id, COUNT(DISTINCT b.github_id) AS n FROM person_networks a JOIN person_networks b ON a.net_hash = b.net_hash AND b.github_id != a.github_id
         WHERE a.github_id IN (SELECT value FROM json_each(?)) AND ${notAdmin("b.github_id")} GROUP BY a.github_id`,
        JSON.stringify(top.map((row) => row.github_id)),
        admins,
      )
      .toArray()
      .map((row) => [row.github_id, row.n]),
  );

  const blockedIds = sql.exec<{ github_id: number }>("SELECT github_id FROM people WHERE status = 'blocked' ORDER BY github_id").toArray().map((row) => row.github_id);
  lookup(blockedIds);

  const checks = new Map<number, { day: number; contributions: number; none: number; error: number }>();
  for (const row of sql
    .exec<{ day: number; outcome: string; n: number }>("SELECT day, outcome, n FROM github_checks_daily WHERE day >= ? ORDER BY day DESC", Math.floor(since / DAY_MS) + 1)
    .toArray()) {
    const entry = checks.get(row.day) ?? { day: row.day * DAY_MS, contributions: 0, none: 0, error: 0 };
    if (row.outcome === "contributions" || row.outcome === "none" || row.outcome === "error") entry[row.outcome] += row.n;
    checks.set(row.day, entry);
  }

  const adminLog = sql
    .exec<{ key: string; old_value: string | null; new_value: string | null; changed_by_login: string; changed_at: number }>(
      "SELECT key, old_value, new_value, changed_by_login, changed_at FROM config_log ORDER BY id DESC LIMIT ?",
      ABUSE_ROWS,
    )
    .toArray()
    .map((row) => ({ at: row.changed_at, key: row.key, oldValue: parse(row.old_value), newValue: parse(row.new_value), byLogin: row.changed_by_login }));

  return {
    clusters,
    clusterCount: shared.length,
    clusteredAccounts,
    deviceRefusals: recentRefusals.map((row) => ({
      at: row.at,
      // Someone refused at their first sign-in has no people row: the login they signed in with.
      person: { ...person(row.github_id), login: person(row.github_id).login ?? row.login },
      holder: person(row.holder_id),
      device: row.device_id.length > 12 ? `${row.device_id.slice(0, 12)}…` : row.device_id,
      attempts: attempts.get(row.device_id) ?? 1,
    })),
    deviceRefusalCount: refusals.length,
    sameNetworkReferrals: pairs.map((row) => ({ at: row.at, referrer: person(row.referrer_id), referred: person(row.referred_id) })),
    sameNetworkReferralCount: sameNetwork.length,
    topUsers: top.map((row) => ({ ...person(row.github_id), activeDays: row.days, sharedWith: sharedCounts.get(row.github_id) ?? 0 })),
    blocked: blockedIds.map(person),
    githubChecks: [...checks.values()],
    adminLog,
  };
}

/**
 * The simple view's numbers. Read with the abuse tag (requests.status, network hashes), held to
 * ABUSE_COLUMNS; admins left out. Counts and who only.
 */
export function simpleData(store: Sql, input: { now: number; adminIds: readonly number[] }): SimpleData {
  const sql: Sql = { exec: (query, ...bindings) => store.exec(`${ABUSE_QUERY_TAG} ${query}`, ...bindings) };
  const admins = JSON.stringify([...input.adminIds]);
  const week = weekStart(input.now);
  const topTokens = sql
    .exec<{ github_id: number; login: string | null; level: string | null; tokens: number }>(
      `SELECT d.github_id AS github_id, p.login AS login, p.level AS level, SUM(d.charged_tokens) AS tokens
       FROM daily_activity d LEFT JOIN people p ON p.github_id = d.github_id
       WHERE d.day >= ? AND ${notAdmin("d.github_id")} GROUP BY d.github_id HAVING SUM(d.charged_tokens) > 0
       ORDER BY tokens DESC, d.github_id LIMIT ?`,
      week / DAY_MS,
      admins,
      TOP_TOKEN_USERS,
    )
    .toArray()
    .map((row) => ({ githubId: row.github_id, login: row.login, level: row.level, tokens: row.tokens }));
  const failing = sql
    .exec<{ github_id: number; login: string | null; n: number; failed: number }>(
      `SELECT r.github_id AS github_id, p.login AS login, COUNT(*) AS n, SUM(r.status != 'ok') AS failed
       FROM requests r LEFT JOIN people p ON p.github_id = r.github_id
       WHERE r.at >= ? AND r.is_admin = 0 AND ${notAdmin("r.github_id")} GROUP BY r.github_id
       HAVING SUM(r.status != 'ok') >= ? AND SUM(r.status != 'ok') >= ? * COUNT(*) ORDER BY failed DESC, r.github_id LIMIT 5`,
      week,
      admins,
      FAILING_MIN,
      FAILING_SHARE,
    )
    .toArray()
    .map((row) => ({ githubId: row.github_id, login: row.login, requests: row.n, failed: row.failed }));
  const bursts = sql
    .exec<{ net_hash: string; day: number; n: number }>(
      `SELECT net_hash, first_at / ${DAY_MS} AS day, COUNT(*) AS n FROM person_networks
       WHERE first_at >= ? AND ${notAdmin("github_id")} GROUP BY net_hash, first_at / ${DAY_MS} HAVING COUNT(*) >= ? ORDER BY n DESC, day DESC LIMIT 5`,
      input.now - BURST_DAYS * DAY_MS,
      admins,
      BURST_MIN,
    )
    .toArray()
    .map((row) => ({ net: row.net_hash.slice(0, 10), day: row.day * DAY_MS, accounts: row.n }));
  const outsideDl = sql
    .exec<{ github_id: number; login: string | null; n: number }>(
      `SELECT r.github_id AS github_id, p.login AS login, COUNT(*) AS n
       FROM requests r LEFT JOIN people p ON p.github_id = r.github_id
       WHERE r.at >= ? AND ${counted("r.")} AND ${notAdmin("r.github_id")}
         AND NOT EXISTS (SELECT 1 FROM daily_activity d WHERE d.github_id = r.github_id AND d.day >= ? AND d.events > 0)
       GROUP BY r.github_id HAVING COUNT(*) >= ? ORDER BY n DESC, r.github_id LIMIT 5`,
      input.now - OUTSIDE_DL_DAYS * DAY_MS,
      admins,
      Math.floor((input.now - OUTSIDE_DL_DAYS * DAY_MS) / DAY_MS),
      OUTSIDE_DL_MIN_REQUESTS,
    )
    .toArray()
    .map((row) => ({ githubId: row.github_id, login: row.login, requests: row.n }));
  return { topTokens, failing, bursts, outsideDl };
}
