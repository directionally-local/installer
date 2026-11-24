import { dollars, type Alert } from "./alerts.js";
import { DAY_MS } from "./week.js";

/**
 * Runway alerts: an early email to the owner before money runs out, rather than when it has.
 * Three checks, run by the 10-minute cron (app.ts) over the Directory's spend counters:
 *
 *   week      this week's free spend, at its pace, passes the global weekly cap before the week
 *             ends. The pace is the faster of the week's average (over at least a day) and the
 *             last 24 hours, so a spike shows within hours, not days.
 *   credit    a provider's credit left lasts fewer than `runwayAlertDays` days at the last 24
 *             hours' burn (all its usage: free, paid, admins). Every provider with a balance:
 *             OpenAI, Luminal and each registry provider.
 *   total     the global total cap has `runwayTotalCapShare` of it, or less, left.
 *
 * Each condition (each provider apart) emails at most once a UTC day while it holds; the ones
 * that fire in the same run share one email. The 50/80/100% cap alerts are unchanged: these come
 * before them. Counts and dollars only.
 */

/** The week's average pace is taken over at least this long, so Monday's first hour isn't a forecast. */
export const RUNWAY_MIN_ELAPSED_MS = DAY_MS;

export interface RunwayProvider {
  id: string;
  name: string;
  /** The credit balance (`providerCredit.<id>`); providers with none are skipped. */
  balanceUsd: number;
  usedUsd: number;
  /** Credit used in the last 24 hours, by everyone. */
  dayUsd: number;
}

export interface RunwayInput {
  now: number;
  weekStart: number;
  weekEnd: number;
  /** Free spend on every provider (what the global caps count): this week, the last 24 hours, and since the start. */
  weekUsd: number;
  dayUsd: number;
  totalUsd: number;
  weeklyCapUsd: number | undefined;
  totalCapUsd: number | undefined;
  providers: readonly RunwayProvider[];
  /** 0 turns the credit check off. */
  alertDays: number;
  /** 0 turns the total check off. */
  totalCapShare: number;
}

/** One condition that holds: `key` is what it is de-duplicated on (with the UTC day added by the caller). */
export interface RunwayFinding {
  key: string;
  line: string;
}

function when(at: number): string {
  const date = new Date(at);
  const day = date.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  return `${day} ${date.toISOString().slice(11, 16)} UTC`;
}

function days(value: number): string {
  if (value < 1) return `${Math.max(1, Math.round(value * 24))} hours`;
  const rounded = Math.round(value * 10) / 10;
  return `${rounded} ${rounded === 1 ? "day" : "days"}`;
}

/** The conditions that hold now, in a fixed order (week, credit per provider, total). */
export function runwayFindings(input: RunwayInput): RunwayFinding[] {
  const out: RunwayFinding[] = [];
  const weekly = input.weeklyCapUsd;
  if (weekly !== undefined && weekly > 0 && input.weekUsd < weekly) {
    const elapsed = Math.max(RUNWAY_MIN_ELAPSED_MS, input.now - input.weekStart);
    const perMs = Math.max(input.weekUsd / elapsed, input.dayUsd / DAY_MS);
    const left = Math.max(0, input.weekEnd - input.now);
    const projected = input.weekUsd + perMs * left;
    if (perMs > 0 && projected > weekly) {
      const hitsAt = input.now + (weekly - input.weekUsd) / perMs;
      out.push({
        key: "week",
        line: `Weekly cap: ${dollars(input.weekUsd)} of ${dollars(weekly)} spent this week; at ${dollars(perMs * DAY_MS)} a day it is reached around ${when(hitsAt)}, before the week resets ${when(input.weekEnd)} (projected ${dollars(projected)}). Free tokens pause for everyone there.`,
      });
    }
  }
  if (input.alertDays > 0) {
    for (const provider of input.providers) {
      if (!(provider.balanceUsd > 0) || !(provider.dayUsd > 0)) continue;
      const leftUsd = Math.max(0, provider.balanceUsd - provider.usedUsd);
      const runway = leftUsd / provider.dayUsd;
      if (runway >= input.alertDays) continue;
      out.push({
        key: `credit:${provider.id}`,
        line: `${provider.name} credit: ${dollars(leftUsd)} of ${dollars(provider.balanceUsd)} left; at the last 24 hours' ${dollars(provider.dayUsd)} it runs out in about ${days(runway)} (around ${when(input.now + runway * DAY_MS)}). Top it up or raise providerCredit.${provider.id} once it is.`,
      });
    }
  }
  const total = input.totalCapUsd;
  if (total !== undefined && total > 0 && input.totalCapShare > 0) {
    const leftUsd = Math.max(0, total - input.totalUsd);
    if (leftUsd <= total * input.totalCapShare && leftUsd > 0) {
      out.push({
        key: "total",
        line: `Total cap: ${dollars(input.totalUsd)} of the ${dollars(total)} all-time cap spent, ${dollars(leftUsd)} left (${Math.round((leftUsd / total) * 100)}%). Free tokens stop for good at the cap unless it is raised.`,
      });
    }
  }
  return out;
}

/** The email for the findings that are new today. */
export function runwayAlert(findings: readonly RunwayFinding[]): Alert {
  const first = findings[0]!;
  const what = first.key === "week" ? "weekly cap on pace to be reached" : first.key === "total" ? "total cap nearly used" : "provider credit running out";
  const more = findings.length > 1 ? ` (+${findings.length - 1} more)` : "";
  return {
    subject: `dl free tier: runway: ${what}${more}`,
    text: ["dl free tier: runway warning. At the current pace:", "", ...findings.map((finding) => `- ${finding.line}`)].join("\n"),
    footer: "Sent at most once a UTC day per condition while it holds. Settings: runwayAlerts, runwayAlertDays, runwayTotalCapShare. Counts and dollars only.",
  };
}
