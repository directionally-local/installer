import { escapeHtml } from "../../shared/src/html.js";
import { notAdmin, type Sql } from "./dashboard-data.js";
import { toolName } from "./tool-keys.js";
import { DAY_MS, isoDay, weekStart } from "./week.js";

/**
 * Router tracking: which coding agent people pick in dl's router (bare `dl`, "Back to X?",
 * `dl <agent>`), and whether they stay with it and pay. Counts and agent ids only, never content.
 *
 *   POST /v1/agent-pick {agent, firstRun, found?, dlVersion?} → 202 {ok: true}
 *     with the dl key (dl_sk_), a server or tool key, or an access token. 400 invalid_request.
 *   GET  /admin/agents?days=30 (or /v1/admin/agents) → agentsReport (admins)
 *
 * Kept per account: the first pick (and whether dl said it was the first run), the latest pick,
 * the agents dl found on that computer at the latest pick that listed them, and per agent the
 * first and last pick and how many. Usage is attributed to an agent per request (requestAgent)
 * in a daily per-person rollup, agent_daily, written with every served request.
 */

/** An agent id: dl's catalog ids (agent-catalog.ts) and "autopilot". */
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,20})?$/;
export const AGENT_PICK_PATH = "/v1/agent-pick";
export const AGENT_PICK_MAX_BYTES = 4 * 1024;
export const PICK_FOUND_MAX = 40;

export interface AgentPick {
  agent: string;
  firstRun: boolean;
  /** The agents dl found on the computer; null when dl didn't look (`dl claude`). */
  found: string[] | null;
  dlVersion: string | null;
}

/** Checks a POST /v1/agent-pick body. Unknown fields are ignored; a malformed found entry is dropped. */
export function parseAgentPick(body: unknown): { ok: true; value: AgentPick } | { ok: false; message: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, message: "Send {agent, firstRun, found?, dlVersion?}." };
  const raw = body as Record<string, unknown>;
  if (typeof raw.agent !== "string" || !AGENT_ID.test(raw.agent)) return { ok: false, message: "agent is an agent id like claude-code." };
  if (raw.firstRun !== undefined && typeof raw.firstRun !== "boolean") return { ok: false, message: "firstRun is true or false." };
  let found: string[] | null = null;
  if (raw.found !== undefined && raw.found !== null) {
    if (!Array.isArray(raw.found)) return { ok: false, message: "found is a list of agent ids." };
    found = [...new Set(raw.found.filter((item): item is string => typeof item === "string" && AGENT_ID.test(item)))].slice(0, PICK_FOUND_MAX);
  }
  const dlVersion = typeof raw.dlVersion === "string" && VERSION.test(raw.dlVersion) ? raw.dlVersion : null;
  return { ok: true, value: { agent: raw.agent, firstRun: raw.firstRun === true, found, dlVersion } };
}

// ─── Which agent sent a request ─────────────────────────────────────────────

/** dl's own agents, which can say who they are with `x-dl-harness` (dl pi on a dl key does). */
const HINTED = new Set(["autopilot", "claude-code", "opencode", "pi", "t3", "crush"]);
/** tool-keys.ts names that are libraries or nothing, not a coding agent. */
const NOT_AN_AGENT = new Set(["litellm", "langchain", "openai-sdk", "anthropic-sdk", "curl", "python", "node", "other"]);

/**
 * The coding agent a chat request counts under: a harness key's agent (claude-code, opencode,
 * pi); else dl's `x-dl-harness` hint; else Autopilot for a sign-in's access token or a server key
 * (dl's server mode runs Autopilot); else, for an API key, the agent its User-Agent and
 * OpenRouter-style headers name (autopilot, t3, claude-code, opencode, crush, cursor…), "other"
 * for a library or an unknown client.
 */
export function requestAgent(input: { harness?: string | undefined; tool: boolean; headers: Headers }): string {
  if (input.harness) return input.harness;
  const hint = input.headers.get("x-dl-harness")?.trim().toLowerCase();
  if (hint && HINTED.has(hint)) return hint;
  if (!input.tool) return "autopilot";
  const seen = [input.headers.get("x-title"), input.headers.get("user-agent")].filter((value): value is string => Boolean(value)).map((value) => value.slice(0, 300));
  if (seen.some((value) => /autopilot/i.test(value))) return "autopilot";
  if (seen.some((value) => /t3[ -]?code|^t3\//i.test(value))) return "t3";
  const name = toolName(input.headers);
  return NOT_AN_AGENT.has(name) ? "other" : name;
}

// ─── Storage (the Directory's SQL) ──────────────────────────────────────────

export const AGENT_PICK_SCHEMA = [
  // Per account: the first and the latest pick in dl's router, and the agents dl found there.
  `CREATE TABLE IF NOT EXISTS agent_pick_people (
     github_id   INTEGER PRIMARY KEY,
     first_agent TEXT NOT NULL,
     first_at    INTEGER NOT NULL,
     first_run   INTEGER NOT NULL,
     last_agent  TEXT NOT NULL,
     last_at     INTEGER NOT NULL,
     found       TEXT,
     dl_version  TEXT
   )`,
  // Per account and agent: when first and last picked, and how many times.
  `CREATE TABLE IF NOT EXISTS agent_picks (
     github_id INTEGER NOT NULL,
     agent     TEXT NOT NULL,
     first_at  INTEGER NOT NULL,
     last_at   INTEGER NOT NULL,
     n         INTEGER NOT NULL,
     PRIMARY KEY (github_id, agent)
   ) WITHOUT ROWID`,
  // Per UTC day, person and agent (requestAgent), admins left out: requests and charged tokens.
  `CREATE TABLE IF NOT EXISTS agent_daily (
     day       INTEGER NOT NULL,
     github_id INTEGER NOT NULL,
     agent     TEXT NOT NULL,
     requests  INTEGER NOT NULL,
     tokens    INTEGER NOT NULL,
     PRIMARY KEY (day, github_id, agent)
   ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS agent_daily_person ON agent_daily (github_id, day)`,
];

/** Keeps one pick. The first pick stays as it was; `found` is replaced only when dl looked. */
export function saveAgentPick(sql: Sql, input: { githubId: number; pick: AgentPick; now: number }): void {
  const { githubId, pick, now } = input;
  const found = pick.found ? JSON.stringify(pick.found) : null;
  sql.exec(
    `INSERT INTO agent_pick_people (github_id, first_agent, first_at, first_run, last_agent, last_at, found, dl_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (github_id) DO UPDATE SET last_agent = excluded.last_agent, last_at = excluded.last_at,
       found = COALESCE(excluded.found, found), dl_version = COALESCE(excluded.dl_version, dl_version)`,
    githubId,
    pick.agent,
    now,
    pick.firstRun ? 1 : 0,
    pick.agent,
    now,
    found,
    pick.dlVersion,
  );
  sql.exec(
    `INSERT INTO agent_picks (github_id, agent, first_at, last_at, n) VALUES (?, ?, ?, ?, 1)
     ON CONFLICT (github_id, agent) DO UPDATE SET last_at = excluded.last_at, n = n + 1`,
    githubId,
    pick.agent,
    now,
    now,
  );
}

/** Adds one served request to the day's per-person, per-agent rollup. */
export function addAgentUsage(sql: Sql, input: { githubId: number; agent: string; at: number; tokens: number }): void {
  sql.exec(
    `INSERT INTO agent_daily (day, github_id, agent, requests, tokens) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT (day, github_id, agent) DO UPDATE SET requests = requests + 1, tokens = tokens + excluded.tokens`,
    Math.floor(input.at / DAY_MS),
    input.githubId,
    input.agent,
    Math.max(0, Math.floor(input.tokens)),
  );
}

// ─── The admin report ───────────────────────────────────────────────────────

export interface AgentRow {
  agent: string;
  /** People whose first pick, on dl's first run, was this agent (first picked in the window). */
  firstRunPicks: number;
  /** People whose first pick was this agent (first picked in the window), first run or not. */
  firstPicks: number;
  /** People who picked it in the window, and their picks (all time). */
  pickers: number;
  picks: number;
  /** People whose latest pick (in the window) is this agent. */
  current: number;
  /** People with a request from this agent this week (UTC, from Monday), and in the window. */
  activeThisWeek: number;
  activeInWindow: number;
  requests: number;
  tokens: number;
  /** Paying people whose primary agent (most tokens, last 14 days) is this one. */
  payingPrimary: number;
  /** Week-2 retention of people who first picked it and signed up in the window. */
  retention: { signups: number; eligible: number; retained: number; rate: number | null };
}

export interface AgentCohort {
  /** The Monday of the signup week (YYYY-MM-DD). */
  week: string;
  agent: string;
  signups: number;
  /** Signed up at least 14 days ago, so week 2 is over. */
  eligible: number;
  /** Of those, made a request on days 7 to 13 after signing up. */
  retained: number;
}

export interface AgentsReport {
  days: number;
  from: string;
  agents: AgentRow[];
  cohorts: AgentCohort[];
  /** Paying people (active or past due), and those with no request in the last 14 days. */
  paying: { total: number; noUsage: number };
  /** What dl found on people's computers, at their latest pick in the window that looked. */
  found: { reported: number; agents: Array<{ agent: string; people: number }> };
}

/** The 14 days the primary agent is read from. */
export const PRIMARY_DAYS = 14;

export function agentsReport(sql: Sql, input: { now: number; days: number; adminIds: readonly number[] }): AgentsReport {
  const admins = JSON.stringify([...input.adminIds]);
  const today = Math.floor(input.now / DAY_MS);
  const fromDay = today - input.days + 1;
  const from = fromDay * DAY_MS;
  const weekDay = Math.floor(weekStart(input.now) / DAY_MS);
  const rows = new Map<string, AgentRow>();
  const row = (agent: string): AgentRow => {
    let found = rows.get(agent);
    if (!found) {
      found = { agent, firstRunPicks: 0, firstPicks: 0, pickers: 0, picks: 0, current: 0, activeThisWeek: 0, activeInWindow: 0, requests: 0, tokens: 0, payingPrimary: 0, retention: { signups: 0, eligible: 0, retained: 0, rate: null } };
      rows.set(agent, found);
    }
    return found;
  };

  for (const r of sql
    .exec<{ agent: string; first_picks: number; first_run: number }>(
      `SELECT first_agent AS agent, COUNT(*) AS first_picks, SUM(first_run) AS first_run FROM agent_pick_people WHERE first_at >= ? AND ${notAdmin("github_id")} GROUP BY first_agent`,
      from,
      admins,
    )
    .toArray()) {
    row(r.agent).firstPicks = r.first_picks;
    row(r.agent).firstRunPicks = r.first_run ?? 0;
  }
  for (const r of sql
    .exec<{ agent: string; people: number; picks: number }>(
      `SELECT agent, COUNT(*) AS people, SUM(n) AS picks FROM agent_picks WHERE last_at >= ? AND ${notAdmin("github_id")} GROUP BY agent`,
      from,
      admins,
    )
    .toArray()) {
    row(r.agent).pickers = r.people;
    row(r.agent).picks = r.picks ?? 0;
  }
  for (const r of sql
    .exec<{ agent: string; people: number }>(`SELECT last_agent AS agent, COUNT(*) AS people FROM agent_pick_people WHERE last_at >= ? AND ${notAdmin("github_id")} GROUP BY last_agent`, from, admins)
    .toArray()) {
    row(r.agent).current = r.people;
  }
  for (const r of sql
    .exec<{ agent: string; people: number; week_people: number; requests: number; tokens: number }>(
      `SELECT agent, COUNT(DISTINCT github_id) AS people, COUNT(DISTINCT CASE WHEN day >= ? THEN github_id END) AS week_people,
              SUM(requests) AS requests, SUM(tokens) AS tokens
         FROM agent_daily WHERE day >= ? AND requests > 0 AND ${notAdmin("github_id")} GROUP BY agent`,
      weekDay,
      Math.min(fromDay, weekDay),
      admins,
    )
    .toArray()) {
    // The week may start before the window: the window's own totals come from its days alone.
    const inWindow = sql
      .exec<{ people: number; requests: number; tokens: number }>(
        `SELECT COUNT(DISTINCT github_id) AS people, COALESCE(SUM(requests), 0) AS requests, COALESCE(SUM(tokens), 0) AS tokens
           FROM agent_daily WHERE agent = ? AND day >= ? AND requests > 0 AND ${notAdmin("github_id")}`,
        r.agent,
        fromDay,
        admins,
      )
      .toArray()[0];
    const target = row(r.agent);
    target.activeThisWeek = r.week_people;
    target.activeInWindow = inWindow?.people ?? 0;
    target.requests = inWindow?.requests ?? 0;
    target.tokens = inWindow?.tokens ?? 0;
  }

  // Paying people by primary agent: the most tokens in the last 14 days (then requests, then name).
  const payingIds = sql
    .exec<{ github_id: number }>(`SELECT github_id FROM subscriptions WHERE state IN ('active', 'past_due') AND ${notAdmin("github_id")}`, admins)
    .toArray()
    .map((r) => r.github_id);
  const primary = new Map<number, { agent: string; tokens: number; requests: number }>();
  for (const r of sql
    .exec<{ github_id: number; agent: string; tokens: number; requests: number }>(
      `SELECT a.github_id, a.agent, SUM(a.tokens) AS tokens, SUM(a.requests) AS requests FROM agent_daily a
         JOIN subscriptions s ON s.github_id = a.github_id AND s.state IN ('active', 'past_due')
        WHERE a.day > ? GROUP BY a.github_id, a.agent`,
      today - PRIMARY_DAYS,
    )
    .toArray()) {
    const best = primary.get(r.github_id);
    if (!best || r.tokens > best.tokens || (r.tokens === best.tokens && (r.requests > best.requests || (r.requests === best.requests && r.agent < best.agent)))) {
      primary.set(r.github_id, { agent: r.agent, tokens: r.tokens, requests: r.requests });
    }
  }
  let noUsage = 0;
  for (const id of payingIds) {
    const best = primary.get(id);
    if (best) row(best.agent).payingPrimary++;
    else noUsage++;
  }

  // Week-2 retention by first-picked agent, cohorts by signup week (people.admitted_at).
  const cohorts = new Map<string, AgentCohort>();
  for (const r of sql
    .exec<{ agent: string; admitted_at: number; retained: number }>(
      `SELECT p.first_agent AS agent, pe.admitted_at,
              EXISTS (SELECT 1 FROM person_daily d WHERE d.github_id = p.github_id AND d.is_admin = 0 AND d.requests > 0
                        AND d.day >= (pe.admitted_at + 7 * ${DAY_MS}) / ${DAY_MS} AND d.day < (pe.admitted_at + 14 * ${DAY_MS}) / ${DAY_MS}) AS retained
         FROM agent_pick_people p JOIN people pe ON pe.github_id = p.github_id
        WHERE pe.admitted_at >= ? AND ${notAdmin("p.github_id")}`,
      from,
      admins,
    )
    .toArray()) {
    const week = isoDay(weekStart(r.admitted_at));
    const key = `${week}\u0000${r.agent}`;
    const cohort = cohorts.get(key) ?? { week, agent: r.agent, signups: 0, eligible: 0, retained: 0 };
    cohort.signups++;
    const eligible = r.admitted_at + 14 * DAY_MS <= input.now;
    if (eligible) {
      cohort.eligible++;
      if (r.retained) cohort.retained++;
    }
    cohorts.set(key, cohort);
    const retention = row(r.agent).retention;
    retention.signups++;
    if (eligible) {
      retention.eligible++;
      if (r.retained) retention.retained++;
    }
  }
  for (const target of rows.values()) {
    const { eligible, retained } = target.retention;
    target.retention.rate = eligible > 0 ? Math.round((retained / eligible) * 1000) / 1000 : null;
  }

  // What dl found on people's computers.
  const foundCounts = new Map<string, number>();
  let reported = 0;
  for (const r of sql.exec<{ found: string }>(`SELECT found FROM agent_pick_people WHERE found IS NOT NULL AND last_at >= ? AND ${notAdmin("github_id")}`, from, admins).toArray()) {
    reported++;
    for (const agent of parseList(r.found)) foundCounts.set(agent, (foundCounts.get(agent) ?? 0) + 1);
  }

  const agents = [...rows.values()].sort((a, b) => b.pickers - a.pickers || b.activeInWindow - a.activeInWindow || b.tokens - a.tokens || a.agent.localeCompare(b.agent));
  return {
    days: input.days,
    from: isoDay(from),
    agents,
    cohorts: [...cohorts.values()].sort((a, b) => b.week.localeCompare(a.week) || b.signups - a.signups || a.agent.localeCompare(b.agent)),
    paying: { total: payingIds.length, noUsage },
    found: { reported, agents: [...foundCounts].map(([agent, people]) => ({ agent, people })).sort((a, b) => b.people - a.people || a.agent.localeCompare(b.agent)) },
  };
}

function parseList(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

// ─── The admin home's card ──────────────────────────────────────────────────

const n = (value: number) => value.toLocaleString("en-US");
const tokens = (value: number) => (value >= 1e9 ? `${(value / 1e9).toFixed(1)}B` : value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}k` : String(value));
const percent = (rate: number | null) => (rate === null ? "—" : `${Math.round(rate * 100)}%`);

/** The "Coding agents" card on the admin home. */
export function agentsCard(report: AgentsReport): string {
  const table = report.agents.length
    ? `<div class="scroll"><table><thead><tr><th class="l">Agent</th><th>First-run picks</th><th>Picked</th><th>Current</th><th>Active this week</th><th>Week-2 retention</th><th>Paying (primary)</th><th>Tokens</th></tr></thead><tbody>${report.agents
        .map(
          (r) =>
            `<tr><td class="l">${escapeHtml(r.agent)}</td><td>${n(r.firstRunPicks)}</td><td>${n(r.pickers)}</td><td>${n(r.current)}</td><td>${n(r.activeThisWeek)}</td><td>${percent(r.retention.rate)} <span class="count">(${n(r.retention.retained)}/${n(r.retention.eligible)})</span></td><td>${n(r.payingPrimary)}</td><td>${tokens(r.tokens)}</td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : `<p class="empty">No picks or agent usage in the last ${report.days} days.</p>`;
  const cohorts = report.cohorts.length
    ? `<h2 class="gap">Week-2 retention by signup week and first pick</h2><div class="scroll"><table><thead><tr><th class="l">Week of</th><th class="l">First pick</th><th>Signups</th><th>Week 2 over</th><th>Retained</th></tr></thead><tbody>${report.cohorts
        .map((c) => `<tr><td class="l">${escapeHtml(c.week)}</td><td class="l">${escapeHtml(c.agent)}</td><td>${n(c.signups)}</td><td>${n(c.eligible)}</td><td>${c.eligible ? `${n(c.retained)} (${percent(c.retained / c.eligible)})` : "—"}</td></tr>`)
        .join("")}</tbody></table></div>`
    : "";
  const found = report.found.reported
    ? `<h2 class="gap">Found on their computers <span class="n">(${n(report.found.reported)} people)</span></h2><div class="scroll"><table><thead><tr><th class="l">Agent</th><th>People</th><th>Share</th></tr></thead><tbody>${report.found.agents
        .map((f) => `<tr><td class="l">${escapeHtml(f.agent)}</td><td>${n(f.people)}</td><td>${percent(f.people / report.found.reported)}</td></tr>`)
        .join("")}</tbody></table></div>`
    : "";
  return `<section class="card" id="agents"><h2>Coding agents <span class="n">(last ${report.days} days)</span></h2>
<p class="empty">Picks in dl's router and usage by agent (from the key or the client's User-Agent). Paying: ${n(report.paying.total)} people, ${n(report.paying.noUsage)} with no request in ${PRIMARY_DAYS} days; primary agent is the one with the most tokens in the last ${PRIMARY_DAYS} days. Counts only. <code>GET /admin/agents?days=30</code></p>
${table}
${cohorts}
${found}
</section>`;
}
