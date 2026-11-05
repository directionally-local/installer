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
 *   daily_activity    this week's requests, charged tokens, cost and credit per person
 *   github_checks_daily  the sign-up GitHub activity check's daily outcomes
 *   people            login, status (blocked) and sign-up time
 *   config_log        the admin log, where blocks and unblocks are written
 *
 * Network hashes are keyed with the signing key and shown shortened: they group accounts, they
 * don't reveal an address. Admins are left out of every list. Counts, times and who only;
 * never content. `ABUSE_COLUMNS` lists every column read (a test holds the queries to it).
 */

export const ABUSE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  person_networks: ["github_id", "net_hash", "first_at"],
  device_refusals: ["id", "at", "github_id", "login", "device_id", "holder_id"],
  referrals: ["referred_id", "referrer_id", "outcome", "at"],
  daily_activity: ["day", "github_id", "requests", "charged_tokens", "cost_usd", "credit_usd"],
  github_checks_daily: ["day", "outcome", "n"],
  people: ["github_id", "login", "status", "admitted_at", "admitted_via"],
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
    for (const id of wanted) people.set(id, { githubId: id, login: null, status: null, admittedAt: null, weekRequests: 0, weekTokens: 0, weekCostUsd: 0, weekCreditUsd: 0 });
    for (const row of sql
      .exec<{ github_id: number; login: string; status: string; admitted_at: number }>(
        "SELECT github_id, login, status, admitted_at FROM people WHERE github_id IN (SELECT value FROM json_each(?))",
        list,
      )
      .toArray()) {
      Object.assign(people.get(row.github_id)!, { login: row.login, status: row.status, admittedAt: row.admitted_at });
    }
    for (const row of sql
      .exec<{ github_id: number; requests: number; tokens: number; cost: number; credit: number }>(
        `SELECT github_id, SUM(requests) AS requests, SUM(charged_tokens) AS tokens, SUM(cost_usd) AS cost, SUM(credit_usd) AS credit
         FROM daily_activity WHERE day >= ? AND github_id IN (SELECT value FROM json_each(?)) GROUP BY github_id`,
        weekDay,
        list,
      )
      .toArray()) {
      Object.assign(people.get(row.github_id)!, { weekRequests: row.requests, weekTokens: row.tokens, weekCostUsd: row.cost, weekCreditUsd: row.credit });
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
