import { shouldQueue, type Policy } from "./queue.js";
import { weekEnd } from "./week.js";

/**
 * GET /v1/status: whether a NEW person gets free tokens now, for clients to show before
 * sign-in. The same tests chat() and admission use, in their order; never any amount or count.
 */
export type FreeState = "open" | "waitlist" | "paused";
export type FreeReason = "credit_exhausted" | "kill_switch" | "weekly_budget" | "no_upstream";

export interface FreeStatus {
  free: FreeState;
  reason: FreeReason | null;
  message: string;
  /** When the waitlist next admits (Monday 00:00 UTC); null unless `free` is "waitlist". */
  opensAt: string | null;
  updatedAt: string;
  /** Each model the free tier serves and whether it can serve right now. No amounts or counts. */
  models: Array<{ id: string; available: boolean }>;
}

export const STATUS_PAUSED_MESSAGE = "The free tier is paused for now. Bring your own key, or check back soon.";
export const STATUS_CREDIT_MESSAGE = "The free tier is paused: high demand used up this round of free tokens. Bring your own key, or check back soon.";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "Monday 9 November", in UTC. */
export function dayText(ms: number): string {
  const date = new Date(ms);
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

export function waitlistMessage(opensAt: number): string {
  return `The free tier is at capacity this week: new sign-ups join a waitlist that opens on ${dayText(opensAt)}.`;
}

export function freeStatus(input: {
  now: number;
  /** The env kill switch (PAUSED) or the admin's. */
  paused: boolean;
  /** chooseUpstream(...) for the effective setting. */
  upstream: string | undefined;
  creditUsedUsd: number;
  luminalCreditUsd: number;
  weekUsd: number;
  weekCreditUsd: number;
  waiting: number;
  policy: Policy;
  /** Each model and whether it can serve now (its provider has a key and credit left). */
  models: Array<{ id: string; available: boolean }>;
}): FreeStatus {
  const updatedAt = new Date(input.now).toISOString();
  const models = input.models;
  const paused = (reason: FreeReason, message: string): FreeStatus => ({ free: "paused", reason, message, opensAt: null, updatedAt, models });
  if (input.paused) return paused("kill_switch", STATUS_PAUSED_MESSAGE);
  if (!input.upstream) return paused("no_upstream", STATUS_PAUSED_MESSAGE);
  // Every model's provider is out of credit: nothing can serve.
  if (models.length > 0 && models.every((model) => !model.available)) return paused("credit_exhausted", STATUS_CREDIT_MESSAGE);
  if (shouldQueue({ weekUsd: input.weekUsd, weekCreditUsd: input.weekCreditUsd, queueLength: input.waiting, policy: input.policy })) {
    const opensAt = weekEnd(input.now);
    return { free: "waitlist", reason: "weekly_budget", message: waitlistMessage(opensAt), opensAt: new Date(opensAt).toISOString(), updatedAt, models };
  }
  return { free: "open", reason: null, message: "", opensAt: null, updatedAt, models };
}
