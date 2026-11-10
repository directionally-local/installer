import { DASHBOARD_COLUMNS, installBreakdown, notAdmin, upstreamStats, type InstallFunnel, type Sql, type UpstreamStats } from "./dashboard-data.js";
import { DAY_MS } from "./week.js";

/**
 * The admin dashboard's Health view (GET /admin?view=health): what Autopilot's session events and
 * the free tier's own request log say about bugs, crashes and what gets used, over the last 1, 7
 * or 30 days.
 *
 * Unlike the rest of the dashboard this reads the `events` table's type, session id and props, and
 * the request log's model and status. Props were cleaned to the allowlist on the way in
 * (events.ts); these queries read only named fields out of them (model, exitReason, errorCode,
 * autopilotVersion, os, turns, durationMs, toolCalls) and never repoHash. Every query starts with
 * HEALTH_QUERY_TAG, so a test can hold them to HEALTH_COLUMNS.
 *
 * Which event carries what (Autopilot's src/providers/dl-events.ts):
 * - session.start: model, provider, autopilotVersion, os, repoHash. The only event with version and os,
 *   so the others are joined to it by session id.
 * - turn.end: that turn's toolCalls, durationMs, exitReason (complete, aborted, error, guardrail,
 *   needs_input) and the session's running turn count.
 * - session.end: the session's totals (turns, toolCalls summed over its turns, durationMs) and
 *   exitReason ("exit" or "clear"). A crash or a kill sends none.
 * - error: errorCode and model, next to the turn.end of the failed turn.
 * - pr.opened: one per pull request URL a tool printed.
 * Tool calls are summed from turn.end only: session.end repeats the same counts, and a session
 * that crashed still sent its turns.
 *
 * Admins are left out of every number but the upstream timings and the installs, which have no
 * person attached (as on the Full view).
 */

export const HEALTH_WINDOWS = [1, 7, 30] as const;
export type HealthWindow = (typeof HEALTH_WINDOWS)[number];
export const DEFAULT_HEALTH_DAYS: HealthWindow = 7;

export function healthWindow(value: string | null): HealthWindow {
  const days = Number(value);
  return (HEALTH_WINDOWS as readonly number[]).includes(days) ? (days as HealthWindow) : DEFAULT_HEALTH_DAYS;
}

/** Every Health query starts with this comment, so a test can hold them to `HEALTH_COLUMNS`. */
export const HEALTH_QUERY_TAG = "/* health */";

/** Tables and columns the Health view may read. */
export const HEALTH_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  events: ["github_id", "type", "session_id", "at", "props"],
  requests: ["github_id", "is_admin", "at", "model", "status"],
  // notAdmin(): who was admitted as an admin.
  people: ["github_id", "admitted_via"],
  install_daily: DASHBOARD_COLUMNS.install_daily!,
  upstream_daily: DASHBOARD_COLUMNS.upstream_daily!,
  upstream_timings: DASHBOARD_COLUMNS.upstream_timings!,
};

/** Session ends that are a person closing or clearing the session. */
export const NORMAL_SESSION_ENDS: readonly string[] = ["exit", "clear"];
/** Turn ends that aren't a failure. */
export const NORMAL_TURN_ENDS: readonly string[] = ["complete", "needs_input"];
/** A session with no end event and activity this recent may still be open. */
export const OPEN_GRACE_MS = 6 * 60 * 60 * 1000;
/** What a session with no session.end is called, by whether it could still be open. */
export const STILL_OPEN = "(open)";
export const NO_END = "(no end event)";
/** A field the event didn't carry. */
export const NOT_SENT = "(not sent)";

const ROWS = { errors: 15, failures: 15, versions: 15, tools: 25, models: 10, splits: 30 } as const;

export interface CountShare {
  count: number;
  /** Of the section's whole (sessions, requests, turns). */
  share: number;
}

export interface HealthData {
  now: number;
  days: HealthWindow;
  /** Events and requests from `since` (rolling, `days` × 24 hours) to `now`. */
  since: number;
  /** Day-counted tables (installs, upstream counts) from this UTC day on, today included. */
  fromDay: number;
  errors: {
    total: number;
    people: number;
    codes: Array<{ code: string; count: number; people: number; versions: Array<{ version: string; count: number }> }>;
  };
  requests: {
    total: number;
    failed: number;
    /** Failed requests by status and model, most first; share is of that model's requests. */
    failures: Array<{ status: string; model: string } & CountShare>;
  };
  ends: {
    sessions: number;
    /** How sessions started in the window ended; normal: exit, clear or still open. */
    overall: Array<{ end: string; normal: boolean } & CountShare>;
    /** The same per Autopilot version and OS: sessions, abnormal ends, and the most common abnormal end. */
    split: Array<{ version: string; os: string; sessions: number; abnormal: number; share: number; top: string | null }>;
    /** Every (version, os, end), for the CSV. */
    detail: Array<{ version: string; os: string; end: string; normal: boolean } & CountShare>;
    /** turn.end outcomes in the window. */
    turns: Array<{ end: string; normal: boolean } & CountShare>;
    turnTotal: number;
  };
  versions: {
    sessions: number;
    versions: Array<{ version: string; people: number } & CountShare>;
    os: Array<{ os: string; people: number } & CountShare>;
    /** The highest version seen, by number. */
    latest: string | null;
  };
  sessions: {
    sessions: number;
    people: number;
    ended: number;
    turnsMedian: number | null;
    turnsP90: number | null;
    /** Ended sessions only: an open or crashed one has no duration. */
    durationMedianMs: number | null;
    durationP90Ms: number | null;
    zeroTurns: number;
    prs: number;
    prsPer100: number | null;
  };
  tools: {
    /** Sessions with at least one turn.end in the window: the share's whole. */
    sessions: number;
    calls: number;
    tools: Array<{ tool: string; calls: number; sessions: number; share: number }>;
  };
  models: {
    sessions: Array<{ model: string } & CountShare>;
    requests: Array<{ model: string; requests: number; failed: number; share: number }>;
    upstreams: UpstreamStats[];
  };
  installs: {
    ok: number;
    failed: number;
    platforms: Array<{ os: string; arch: string; mode: string; ok: number; failed: number; failShare: number; topStep: string | null }>;
    failedSteps: InstallFunnel["failedSteps"];
  };
}

/** Nearest-rank percentile of an ascending list; null when empty. */
export function nearestRank(sorted: readonly number[], share: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(1, Math.ceil(share * sorted.length)) - 1]!;
}

/** Compares "3.10.2" and "3.9.0" by number; anything unparsable sorts first. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => (/^\d+(\.\d+)*/.exec(v)?.[0] ?? "").split(".").filter(Boolean).map(Number);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d !== 0) return d;
  }
  return a.localeCompare(b);
}

const text = (value: unknown): string => (typeof value === "string" && value.length > 0 ? value : NOT_SENT);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

function tally<K>(map: Map<K, number>, key: K, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function ranked<K>(map: Map<K, number>, whole: number): Array<{ key: K } & CountShare> {
  return [...map.entries()]
    .map(([key, count]) => ({ key, count, share: whole > 0 ? count / whole : 0 }))
    .sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)));
}

export function healthData(store: Sql, input: { now: number; adminIds: readonly number[]; days: HealthWindow }): HealthData {
  const sql: Sql = { exec: (query, ...bindings) => store.exec(`${HEALTH_QUERY_TAG} ${query}`, ...bindings) };
  const admins = JSON.stringify([...input.adminIds]);
  const { now, days } = input;
  const since = now - days * DAY_MS;
  const today = Math.floor(now / DAY_MS);
  const fromDay = today - days + 1;

  // ── Sessions started in the window, one row each, with what their other events say.
  const sessionRows = sql
    .exec<{
      github_id: number;
      version: string | null;
      os: string | null;
      model: string | null;
      last_at: number;
      turn_events: number;
      prs: number;
      ended: number;
      end_reason: string | null;
      end_turns: number | null;
      end_ms: number | null;
    }>(
      `WITH s AS (
         SELECT github_id, session_id, json_extract(props, '$.autopilotVersion') AS version, json_extract(props, '$.os') AS os, json_extract(props, '$.model') AS model
         FROM events WHERE type = 'session.start' AND at >= ? AND at < ? AND session_id IS NOT NULL AND ${notAdmin("github_id")})
       SELECT s.github_id AS github_id, s.version AS version, s.os AS os, s.model AS model,
              MAX(e.at) AS last_at, SUM(e.type = 'turn.end') AS turn_events, SUM(e.type = 'pr.opened') AS prs, SUM(e.type = 'session.end') AS ended,
              MAX(CASE WHEN e.type = 'session.end' THEN json_extract(e.props, '$.exitReason') END) AS end_reason,
              MAX(CASE WHEN e.type = 'session.end' THEN json_extract(e.props, '$.turns') END) AS end_turns,
              MAX(CASE WHEN e.type = 'session.end' THEN json_extract(e.props, '$.durationMs') END) AS end_ms
       FROM s JOIN events e ON e.github_id = s.github_id AND e.session_id = s.session_id
       GROUP BY s.github_id, s.session_id`,
      since,
      now,
      admins,
    )
    .toArray();

  const sessionCount = sessionRows.length;
  const people = new Set<number>();
  const endCounts = new Map<string, number>();
  const splitCounts = new Map<string, { version: string; os: string; sessions: number; ends: Map<string, number> }>();
  const versionCounts = new Map<string, number>();
  const versionPeople = new Map<string, Set<number>>();
  const osCounts = new Map<string, number>();
  const osPeople = new Map<string, Set<number>>();
  const modelSessions = new Map<string, number>();
  const turns: number[] = [];
  const durations: number[] = [];
  let zeroTurns = 0;
  let prs = 0;
  let ended = 0;
  for (const row of sessionRows) {
    people.add(row.github_id);
    const version = text(row.version);
    const os = text(row.os);
    const end = row.ended > 0 ? text(row.end_reason) : now - row.last_at < OPEN_GRACE_MS ? STILL_OPEN : NO_END;
    tally(endCounts, end);
    const key = `${version}\u0000${os}`;
    let split = splitCounts.get(key);
    if (!split) splitCounts.set(key, (split = { version, os, sessions: 0, ends: new Map() }));
    split.sessions++;
    tally(split.ends, end);
    tally(versionCounts, version);
    tally(osCounts, os);
    for (const [map, name] of [[versionPeople, version], [osPeople, os]] as const) {
      let set = map.get(name);
      if (!set) map.set(name, (set = new Set()));
      set.add(row.github_id);
    }
    tally(modelSessions, text(row.model));
    const turnCount = num(row.end_turns) ?? row.turn_events;
    turns.push(turnCount);
    if (turnCount === 0) zeroTurns++;
    if (row.ended > 0) {
      ended++;
      const ms = num(row.end_ms);
      if (ms !== null) durations.push(ms);
    }
    prs += row.prs;
  }
  turns.sort((a, b) => a - b);
  durations.sort((a, b) => a - b);
  const isNormalEnd = (end: string) => NORMAL_SESSION_ENDS.includes(end) || end === STILL_OPEN;

  const overall = ranked(endCounts, sessionCount).map(({ key, ...rest }) => ({ end: key, normal: isNormalEnd(key), ...rest }));
  const splits = [...splitCounts.values()];
  const split = splits
    .map((row) => {
      const abnormalEnds = [...row.ends.entries()].filter(([end]) => !isNormalEnd(end)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const abnormal = abnormalEnds.reduce((sum, [, n]) => sum + n, 0);
      return { version: row.version, os: row.os, sessions: row.sessions, abnormal, share: abnormal / row.sessions, top: abnormalEnds[0]?.[0] ?? null };
    })
    .sort((a, b) => b.sessions - a.sessions || compareVersions(b.version, a.version) || a.os.localeCompare(b.os))
    .slice(0, ROWS.splits);
  const detail = splits
    .flatMap((row) => [...row.ends.entries()].map(([end, n]) => ({ version: row.version, os: row.os, end, normal: isNormalEnd(end), count: n, share: n / row.sessions })))
    .sort((a, b) => compareVersions(b.version, a.version) || a.os.localeCompare(b.os) || b.count - a.count);

  // ── Turn outcomes.
  const turnRows = sql
    .exec<{ reason: string | null; n: number }>(
      `SELECT json_extract(props, '$.exitReason') AS reason, COUNT(*) AS n FROM events
       WHERE type = 'turn.end' AND at >= ? AND at < ? AND ${notAdmin("github_id")} GROUP BY 1`,
      since,
      now,
      admins,
    )
    .toArray();
  const turnTotal = turnRows.reduce((sum, row) => sum + row.n, 0);
  const turnCounts = new Map<string, number>();
  for (const row of turnRows) tally(turnCounts, text(row.reason), row.n);
  const turnEnds = ranked(turnCounts, turnTotal).map(({ key, ...rest }) => ({ end: key, normal: NORMAL_TURN_ENDS.includes(key), ...rest }));

  // ── Errors Autopilot reported, with the version of the session they came from.
  const errorTotals = sql
    .exec<{ n: number; people: number }>(
      `SELECT COUNT(*) AS n, COUNT(DISTINCT github_id) AS people FROM events
       WHERE type = 'error' AND at >= ? AND at < ? AND ${notAdmin("github_id")}`,
      since,
      now,
      admins,
    )
    .toArray()[0];
  const codeRows = sql
    .exec<{ code: string | null; n: number; people: number }>(
      `SELECT json_extract(props, '$.errorCode') AS code, COUNT(*) AS n, COUNT(DISTINCT github_id) AS people FROM events
       WHERE type = 'error' AND at >= ? AND at < ? AND ${notAdmin("github_id")} GROUP BY 1 ORDER BY n DESC, code LIMIT ${ROWS.errors}`,
      since,
      now,
      admins,
    )
    .toArray();
  const codeVersions = new Map<string, Map<string, number>>();
  if (codeRows.length > 0) {
    for (const row of sql
      .exec<{ code: string | null; version: string | null; n: number }>(
        `SELECT json_extract(e.props, '$.errorCode') AS code, json_extract(s.props, '$.autopilotVersion') AS version, COUNT(*) AS n
         FROM events e LEFT JOIN events s ON s.github_id = e.github_id AND s.session_id = e.session_id AND s.type = 'session.start'
         WHERE e.type = 'error' AND e.at >= ? AND e.at < ? AND ${notAdmin("e.github_id")} GROUP BY 1, 2`,
        since,
        now,
        admins,
      )
      .toArray()) {
      const code = text(row.code);
      let map = codeVersions.get(code);
      if (!map) codeVersions.set(code, (map = new Map()));
      tally(map, text(row.version), row.n);
    }
  }
  const errors: HealthData["errors"] = {
    total: errorTotals?.n ?? 0,
    people: errorTotals?.people ?? 0,
    codes: codeRows.map((row) => {
      const code = text(row.code);
      const versions = [...(codeVersions.get(code) ?? new Map<string, number>()).entries()]
        .map(([version, count]) => ({ version, count }))
        .sort((a, b) => b.count - a.count || compareVersions(b.version, a.version));
      return { code, count: row.n, people: row.people, versions };
    }),
  };

  // ── The free tier's own request log: requests and failures per model.
  const requestRows = sql
    .exec<{ model: string; status: string; n: number }>(
      `SELECT model, status, COUNT(*) AS n FROM requests WHERE at >= ? AND at < ? AND is_admin = 0 AND ${notAdmin("github_id")} GROUP BY model, status`,
      since,
      now,
      admins,
    )
    .toArray();
  const modelRequests = new Map<string, { requests: number; failed: number }>();
  const failures: HealthData["requests"]["failures"] = [];
  for (const row of requestRows) {
    let model = modelRequests.get(row.model);
    if (!model) modelRequests.set(row.model, (model = { requests: 0, failed: 0 }));
    model.requests += row.n;
    if (row.status !== "ok") model.failed += row.n;
  }
  for (const row of requestRows) {
    if (row.status === "ok") continue;
    failures.push({ status: row.status, model: row.model, count: row.n, share: row.n / modelRequests.get(row.model)!.requests });
  }
  failures.sort((a, b) => b.count - a.count || a.status.localeCompare(b.status) || a.model.localeCompare(b.model));
  const requestTotal = [...modelRequests.values()].reduce((sum, row) => sum + row.requests, 0);
  const requestFailed = [...modelRequests.values()].reduce((sum, row) => sum + row.failed, 0);

  // ── Tools: per-turn counts from turn.end (session.end repeats them). Every name, for the total.
  const toolRows = sql
    .exec<{ tool: string; calls: number; sessions: number }>(
      `SELECT t.key AS tool, SUM(t.value) AS calls, COUNT(DISTINCT e.github_id || ':' || COALESCE(e.session_id, '')) AS sessions
       FROM events e, json_each(e.props, '$.toolCalls') t
       WHERE e.type = 'turn.end' AND e.at >= ? AND e.at < ? AND ${notAdmin("e.github_id")}
       GROUP BY t.key ORDER BY calls DESC, tool`,
      since,
      now,
      admins,
    )
    .toArray();
  const toolSessions =
    sql
      .exec<{ n: number }>(
        `SELECT COUNT(DISTINCT github_id || ':' || COALESCE(session_id, '')) AS n FROM events
         WHERE type = 'turn.end' AND at >= ? AND at < ? AND ${notAdmin("github_id")}`,
        since,
        now,
        admins,
      )
      .toArray()[0]?.n ?? 0;
  const toolCalls = toolRows.reduce((sum, row) => sum + row.calls, 0);

  // ── Installs, by UTC day (anonymous: admins can't be told apart).
  const breakdown = installBreakdown(sql, fromDay, today + 1);
  const stepRows = sql
    .exec<{ os: string; arch: string; mode: string; step: string; n: number }>(
      `SELECT os, arch, mode, failed_step AS step, SUM(installs) AS n FROM install_daily WHERE day >= ? AND day < ? AND result = 'failed'
       GROUP BY os, arch, mode, failed_step`,
      fromDay,
      today + 1,
    )
    .toArray();
  const topStep = new Map<string, { step: string; n: number }>();
  for (const row of stepRows) {
    const key = `${row.os}\u0000${row.arch}\u0000${row.mode}`;
    const best = topStep.get(key);
    if (!best || row.n > best.n || (row.n === best.n && row.step < best.step)) topStep.set(key, { step: row.step, n: row.n });
  }
  const platforms = breakdown.platforms.map((row) => ({
    ...row,
    failShare: row.ok + row.failed > 0 ? row.failed / (row.ok + row.failed) : 0,
    topStep: topStep.get(`${row.os}\u0000${row.arch}\u0000${row.mode}`)?.step ?? null,
  }));

  // Equal counts: newest first, so an upgrade reads top-down.
  const versions = ranked(versionCounts, sessionCount)
    .sort((a, b) => b.count - a.count || compareVersions(b.key, a.key))
    .map(({ key, ...rest }) => ({ version: key, people: versionPeople.get(key)!.size, ...rest }));
  const known = [...versionCounts.keys()].filter((version) => version !== NOT_SENT).sort(compareVersions);

  return {
    now,
    days,
    since,
    fromDay: fromDay * DAY_MS,
    errors,
    requests: { total: requestTotal, failed: requestFailed, failures: failures.slice(0, ROWS.failures) },
    ends: { sessions: sessionCount, overall, split, detail, turns: turnEnds, turnTotal },
    versions: {
      sessions: sessionCount,
      versions: versions.slice(0, ROWS.versions),
      os: ranked(osCounts, sessionCount).map(({ key, ...rest }) => ({ os: key, people: osPeople.get(key)!.size, ...rest })),
      latest: known[known.length - 1] ?? null,
    },
    sessions: {
      sessions: sessionCount,
      people: people.size,
      ended,
      turnsMedian: nearestRank(turns, 0.5),
      turnsP90: nearestRank(turns, 0.9),
      durationMedianMs: nearestRank(durations, 0.5),
      durationP90Ms: nearestRank(durations, 0.9),
      zeroTurns,
      prs,
      prsPer100: sessionCount > 0 ? (prs / sessionCount) * 100 : null,
    },
    tools: {
      sessions: toolSessions,
      calls: toolCalls,
      tools: toolRows.slice(0, ROWS.tools).map((row) => ({ tool: row.tool, calls: row.calls, sessions: row.sessions, share: toolSessions > 0 ? row.sessions / toolSessions : 0 })),
    },
    models: {
      sessions: ranked(modelSessions, sessionCount)
        .slice(0, ROWS.models)
        .map(({ key, ...rest }) => ({ model: key, ...rest })),
      requests: [...modelRequests.entries()]
        .map(([model, row]) => ({ model, requests: row.requests, failed: row.failed, share: requestTotal > 0 ? row.requests / requestTotal : 0 }))
        .sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model))
        .slice(0, ROWS.models),
      upstreams: upstreamStats(sql, now, [{ window: `${days}d`, fromDay: Math.floor(since / DAY_MS), since }]),
    },
    installs: {
      ok: platforms.reduce((sum, row) => sum + row.ok, 0),
      failed: platforms.reduce((sum, row) => sum + row.failed, 0),
      platforms,
      failedSteps: breakdown.failedSteps,
    },
  };
}

// ─── Takeaways ───────────────────────────────────────────────────────────

/** install.sh's steps in plain words, for the takeaways and the page. */
export const INSTALL_STEPS: Readonly<Record<string, string>> = {
  "": "(not said)",
  preflight: "the checks",
  node: "the Node.js step",
  install_dl: "installing dl",
  path: "the PATH step",
  dl_up: "server setup (dl up)",
};

const pct = (share: number) => `${Math.round(share * 100)}%`;
const osName = (os: string) => (os === "darwin" ? "macOS" : os === "linux" ? "Linux" : os === "win32" ? "Windows" : os);
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const seconds = (ms: number) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(ms >= 600_000 ? 0 : 1)} min` : `${(ms / 1000).toFixed(1)} s`);

/** Rows below this many sessions or installs are too small to call out. */
const MIN_GROUP = 5;

/** One plain-English line per section, computed from the numbers. */
export function healthTakeaways(data: HealthData): Record<"errors" | "ends" | "versions" | "sessions" | "tools" | "models" | "installs", string> {
  const { errors, requests, ends, versions, sessions, tools, models, installs } = data;

  let errorsLine: string;
  if (errors.total === 0) errorsLine = "Autopilot reported no errors.";
  else {
    const top = errors.codes[0]!;
    const version = top.versions[0];
    errorsLine = `Top error ${top.code}: ${plural(top.count, "time")}, ${plural(top.people, "person", "people")}${version && version.version !== NOT_SENT ? `, mostly from ${version.version}` : ""}.`;
  }
  if (requests.total > 0) {
    const fail = requests.failures[0];
    errorsLine += ` ${pct(requests.failed / requests.total)} of ${plural(requests.total, "request")} failed${fail ? `, most as ${fail.status} on ${fail.model}` : ""}.`;
  }

  let endsLine: string;
  if (ends.sessions === 0) endsLine = "No sessions started.";
  else {
    const abnormal = ends.overall.filter((row) => !row.normal).reduce((sum, row) => sum + row.count, 0);
    const worst = ends.split.filter((row) => row.sessions >= MIN_GROUP && row.abnormal > 0).sort((a, b) => b.share - a.share)[0];
    const badTurns = ends.turns.filter((row) => !row.normal).reduce((sum, row) => sum + row.count, 0);
    endsLine =
      abnormal === 0
        ? "Every session ended normally or is still open."
        : `${pct(abnormal / ends.sessions)} of sessions ended without a normal exit${worst ? `; worst ${worst.version} on ${osName(worst.os)} at ${pct(worst.share)}, mostly ${worst.top}` : ""}.`;
    if (ends.turnTotal > 0) endsLine += ` ${pct(badTurns / ends.turnTotal)} of turns ended in an error, guardrail or abort.`;
  }

  let versionsLine: string;
  if (versions.sessions === 0) versionsLine = "No sessions started.";
  else {
    const latest = versions.latest ? versions.versions.find((row) => row.version === versions.latest) : undefined;
    const os = versions.os[0]!;
    versionsLine = `${latest ? `${pct(latest.share)} of sessions on the newest version, ${latest.version}` : "No session sent its version"}; ${pct(os.share)} on ${osName(os.os)}.`;
  }

  const sessionsLine =
    sessions.sessions === 0
      ? "No sessions started."
      : `Median session: ${plural(sessions.turnsMedian ?? 0, "turn")}${sessions.durationMedianMs !== null ? `, ${seconds(sessions.durationMedianMs)}` : ""}. ${pct(sessions.zeroTurns / sessions.sessions)} were opened and left with no turn. ${(sessions.prsPer100 ?? 0).toFixed(1)} PRs per 100 sessions.`;

  let toolsLine: string;
  if (tools.tools.length === 0) toolsLine = "No tool calls reported.";
  else {
    const top = tools.tools[0]!;
    const widest = [...tools.tools].sort((a, b) => b.sessions - a.sessions)[0]!;
    toolsLine = `${top.tool} is called most (${pct(tools.calls > 0 ? top.calls / tools.calls : 0)} of calls)${widest.tool === top.tool ? `, in ${pct(widest.share)} of sessions` : `; ${widest.tool} is in the most sessions (${pct(widest.share)})`}.`;
  }

  let modelsLine: string;
  const topModel = models.sessions[0];
  const slow = models.upstreams.filter((row) => row.p90TtftMs !== null).sort((a, b) => b.p90TtftMs! - a.p90TtftMs!)[0];
  if (!topModel && !slow) modelsLine = "No sessions or upstream timings.";
  else {
    modelsLine = topModel ? `${pct(topModel.share)} of sessions on ${topModel.model}.` : "";
    if (slow) modelsLine += `${modelsLine ? " " : ""}Slowest first token: ${slow.upstream}, p90 ${seconds(slow.p90TtftMs!)}.`;
  }

  let installsLine: string;
  if (installs.ok + installs.failed === 0) installsLine = "No installs counted.";
  else {
    const worst = installs.platforms.filter((row) => row.ok + row.failed >= MIN_GROUP && row.failed > 0).sort((a, b) => b.failShare - a.failShare)[0];
    installsLine = `${pct(installs.failed / (installs.ok + installs.failed))} of ${plural(installs.ok + installs.failed, "install")} failed.`;
    if (worst) {
      installsLine += ` ${osName(worst.os)} ${worst.arch} ${worst.mode} installs fail ${pct(worst.failShare)}${worst.topStep !== null ? `, mostly at ${INSTALL_STEPS[worst.topStep] ?? worst.topStep}` : ""}.`;
    }
  }

  return { errors: errorsLine, ends: endsLine, versions: versionsLine, sessions: sessionsLine, tools: toolsLine, models: modelsLine, installs: installsLine };
}
