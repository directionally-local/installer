import { escapeHtml } from "../../shared/src/html.js";
import { DAY_MS, isoDay } from "./week.js";

/**
 * Every free-tier refusal and gate, counted per UTC day, reason and client, so the owner can
 * see what each gate costs and which coding agent's users meet it. Counts only: the Directory's
 * `refusals_daily` holds (day, reason, client, count, people). `people` is how many distinct accounts met the reason that day, kept with a salted
 * hash set (`refusal_people`, `refusal_salts`) that is dropped once the day is over: no login,
 * email, IP or GitHub id is stored. Rows older than REFUSALS_KEEP_DAYS are pruned.
 *
 * A few rows are not refusals but the gates around them (invite_page_shown, invite_accepted,
 * placements below Full, queued), so a gate's cost reads beside its way through.
 */

/** Days of counts kept. */
export const REFUSALS_KEEP_DAYS = 120;

export const REFUSAL_REASONS = {
  // ── Sign-in and admission (the browser side) ──
  invite_page_shown: "Sign-in: invite page shown",
  invite_accepted: "Sign-in: invite code accepted",
  invite_code_invalid: "Sign-in: invite code invalid or used",
  invite_rate_limited: "Sign-in: too many invite attempts",
  invite_required: "Sign-in: invite required (invite-only)",
  account_too_new:
    "Sign-in: account too new (invite asked, or placed below Full)",
  no_github_activity: "Sign-in: no GitHub activity (invite asked)",
  few_repos_and_contributions:
    "Sign-in: few repos and contributions (placed below Full)",
  network_limit: "Sign-in: network daily limit (placed at Starter)",
  network_signup_limit: "Sign-in: network daily limit (invite step refused)",
  cohort_full: "Sign-in: cohort full (maxActiveUsers)",
  queued: "Sign-in: placed on the waitlist",
  device_taken: "Sign-in: device holds another account",
  blocked: "Sign-in: account blocked",
  email_blocked: "Sign-in: email address blocked",
  email_domain_blocked: "Sign-in: email domain blocked",
  email_in_use: "Sign-in: email used by another account (one per inbox)",
  email_domain_daily_cap: "Sign-in: email domain daily cap",
  signin_paused: "Sign-in: free tier paused",
  // ── Requests (chat, Anthropic Messages, Responses) ──
  dl_only: "Request: free tokens outside dl",
  harness_not_allowed: "Request: other coding agents off",
  harness_limit: "Request: other agent's share used up",
  proxy_not_allowed: "Request: account-pooling proxy",
  "gpt_limit:cap": "Request: GPT-6 weekly limit",
  "gpt_limit:security_hold": "Request: GPT-6 security hold",
  "allowance_exhausted:full": "Request: weekly allowance used up (Full or Pro)",
  "allowance_exhausted:basic": "Request: weekly allowance used up (basic)",
  "allowance_exhausted:starter": "Request: weekly allowance used up (Starter)",
  trial_ended: "Request: trial used up",
  below_bar: "Request: below the bar, no free tokens",
  api_queued: "Request: waiting in the queue",
  "global_cap:weekly": "Request: global weekly cap",
  "global_cap:total": "Request: global total cap",
  paused: "Request: free tier paused",
  credit_exhausted: "Request: upstream credit used up",
  rate_limited: "Request: rate limited",
  model_not_allowed: "Request: model not allowed",
  api_not_invited: "Request: not on the free tier",
  api_blocked: "Request: account blocked",
  api_suspended: "Request: account suspended",
} as const;

export type RefusalReason = keyof typeof REFUSAL_REASONS;

/**
 * Who met the refusal. Requests: `claude-code` and `opencode` from the harness key (`dl claude`
 * on /anthropic/v1/messages, `dl opencode` on /v1/chat/completions); `autopilot` for a sign-in
 * token or server key (only dl issues them), GPT-6 requests served through OpenAI's Responses
 * API included; `other` when the request shape says it isn't dl (dl_only: the token is used
 * from another tool; proxy_not_allowed: an account-pooling router). Sign-in rows are `signin`.
 */
export const REFUSAL_CLIENTS = [
  "autopilot",
  "opencode",
  "claude-code",
  "other",
  "signin",
] as const;
export type RefusalClient = (typeof REFUSAL_CLIENTS)[number];

/** The client a request refusal counts under (see REFUSAL_CLIENTS). */
export function requestClient(
  harness: string | undefined,
  reason: RefusalReason,
): RefusalClient {
  if (harness === "claude-code" || harness === "opencode") return harness;
  if (
    harness !== undefined ||
    reason === "dl_only" ||
    reason === "proxy_not_allowed"
  )
    return "other";
  return "autopilot";
}

export function isRefusalReason(value: unknown): value is RefusalReason {
  return typeof value === "string" && Object.hasOwn(REFUSAL_REASONS, value);
}

/** One day's count for one reason and client. `day` is the UTC day number (ms / DAY_MS). */
export interface RefusalRow {
  day: number;
  reason: string;
  client: string;
  count: number;
  people: number;
}

/**
 * The reason a request refusal (our `{error: {code, reason, ...}}` body) counts as, or undefined
 * for a response that isn't one of the gates (success, upstream errors, bad bodies).
 */
export function requestRefusalReason(
  status: number,
  error: { code?: unknown; reason?: unknown } | undefined,
): RefusalReason | undefined {
  if (status < 400 || !error || typeof error.code !== "string")
    return undefined;
  switch (error.code) {
    case "gpt_limit":
      return error.reason === "security"
        ? "gpt_limit:security_hold"
        : "gpt_limit:cap";
    case "quota_exceeded":
      return "allowance_exhausted:full";
    case "basic_limit":
      return "allowance_exhausted:basic";
    case "starter_limit":
      return "allowance_exhausted:starter";
    case "free_tier_queued":
      return "api_queued";
    case "global_weekly_budget_reached":
      return "global_cap:weekly";
    case "global_total_budget_reached":
      return "global_cap:total";
    case "service_paused":
      return "paused";
    case "upstream_credit_exhausted":
      return "credit_exhausted";
    case "not_invited":
      return "api_not_invited";
    case "blocked":
      return "api_blocked";
    case "suspended":
      return "api_suspended";
    case "dl_only":
    case "harness_not_allowed":
    case "harness_limit":
    case "proxy_not_allowed":
    case "trial_ended":
    case "below_bar":
    case "rate_limited":
    case "model_not_allowed":
      return error.code;
    default:
      return undefined;
  }
}

/** Rows as the admin API shows them: ISO day, reason, client, count, distinct people. */
export function refusalsView(
  rows: readonly RefusalRow[],
): Array<{
  day: string;
  reason: string;
  client: string;
  count: number;
  people: number;
}> {
  return rows.map((row) => ({
    day: isoDay(row.day * DAY_MS),
    reason: row.reason,
    client: row.client,
    count: row.count,
    people: row.people,
  }));
}

/** GET /admin/dashboard/refusals.csv: one row per day, reason and client. */
export function refusalsCsv(rows: readonly RefusalRow[]): string {
  const lines = [
    "day,reason,client,count,people",
    ...rows.map(
      (row) =>
        `${isoDay(row.day * DAY_MS)},${row.reason},${row.client},${row.count},${row.people}`,
    ),
  ];
  return `${lines.join("\r\n")}\r\n`;
}

/** The admin home's "Refusals" card: per reason and client, today, the last 7 and the last 30 days. */
export function refusalsCard(rows: readonly RefusalRow[], now: number): string {
  const today = Math.floor(now / DAY_MS);
  const sum = (reason: string, client: string, since: number) =>
    rows
      .filter(
        (row) =>
          row.reason === reason && row.client === client && row.day >= since,
      )
      .reduce((total, row) => total + row.count, 0);
  const known: string[] = Object.keys(REFUSAL_REASONS);
  const order = (reason: string) =>
    known.includes(reason) ? known.indexOf(reason) : known.length;
  const pairs = [
    ...new Map(
      rows.map((row) => [
        `${row.reason}\u0000${row.client}`,
        { reason: row.reason, client: row.client },
      ]),
    ).values(),
  ].sort(
    (a, b) =>
      order(a.reason) - order(b.reason) ||
      a.reason.localeCompare(b.reason) ||
      a.client.localeCompare(b.client),
  );
  const cell = (n: number) => n.toLocaleString("en-US");
  const body = pairs
    .map(({ reason, client }) => ({
      reason,
      client,
      today: sum(reason, client, today),
      week: sum(reason, client, today - 6),
      month: sum(reason, client, today - 29),
    }))
    .filter((row) => row.month > 0)
    .map((row) => {
      const label = isRefusalReason(row.reason)
        ? REFUSAL_REASONS[row.reason]
        : row.reason;
      return `<tr><td>${escapeHtml(label)} <code>${escapeHtml(row.reason)}</code></td><td>${escapeHtml(row.client)}</td><td class="num">${cell(row.today)}</td><td class="num">${cell(row.week)}</td><td class="num">${cell(row.month)}</td></tr>`;
    })
    .join("");
  const table = body
    ? `<table><thead><tr><th>Reason</th><th>Client</th><th class="num">Today</th><th class="num">Last 7 days</th><th class="num">Last 30 days</th></tr></thead><tbody>${body}</tbody></table>`
    : `<p class="empty">No refusals in the last 30 days.</p>`;
  return `<section class="card" id="refusals"><h2>Refusals</h2>
<p class="empty">Every sign-in refusal and request gate, per UTC day and client (autopilot, opencode, claude-code, other; signin for the browser sign-in). Counts only, no personal data. <a href="/admin/dashboard/refusals.csv">CSV</a></p>
${table}
</section>`;
}
