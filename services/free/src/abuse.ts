import type { Sql } from "./dashboard-data.js";
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
