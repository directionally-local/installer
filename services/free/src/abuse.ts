import type { Sql } from "./dashboard-data.js";
import { DEFAULT_DETECTION_RULES, type DetectionRules } from "./detection-rules.js";
import { DAY_MS } from "./week.js";

/** The dl-only check (`outsideDl`): free tokens are for use inside dl. */

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

/** The same test on one request row: whether the dl-only checks count it. */
export function countedRequest(row: { is_admin: number; paid: number; via_key: number }): boolean {
  return row.is_admin === 0 && row.paid === 0 && row.via_key === 0;
}

/**
 * True when `githubId` is using free tokens outside dl (see above). Indexed reads that stop
 * early: when the latest session event arrived (`person_events`, kept past the raw log's
 * pruning), then at most DL_ONLY_MIN_REQUESTS request rows that it doesn't cover, plus the
 * uncovered requests already pruned from the log (`dl_only_carry`).
 */
export function outsideDl(store: Sql, githubId: number, now: number): boolean {
  const facts = store
    .exec<{ session_received_at: number | null; dl_only_carry: number }>("SELECT session_received_at, dl_only_carry FROM person_events WHERE github_id = ?", githubId)
    .toArray()[0];
  const last = facts?.session_received_at ?? null;
  const coveredUntil = last === null ? -1 : last + DL_ONLY_WINDOW_MS;
  if (coveredUntil >= now) return false;
  const carried = facts?.dl_only_carry ?? 0;
  if (carried >= DL_ONLY_MIN_REQUESTS) return true;
  const uncovered =
    store
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM requests WHERE github_id = ? AND at > ? AND ${counted()} LIMIT ?)`, githubId, coveredUntil, DL_ONLY_MIN_REQUESTS - carried)
      .toArray()[0]?.n ?? 0;
  return carried + uncovered >= DL_ONLY_MIN_REQUESTS;
}

export const PROXY_ROUTER_MESSAGE = "The free tier can't be used behind account-pooling routers such as 9router. Use it directly from dl, or bring your own key.";
/** Whether the session id or user agent names an account-pooling router (detection-rules.ts `proxyRouters`). */
export function isProxyRouter(sessionId: string | undefined, userAgent: string | null, rules: DetectionRules = DEFAULT_DETECTION_RULES): boolean {
  return rules.proxyRouters.some((pattern) => pattern.test(sessionId ?? "") || pattern.test(userAgent ?? ""));
}
