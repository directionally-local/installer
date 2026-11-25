/**
 * What a paid plan does with one request (plans.ts has the numbers): serve the requested model
 * on its own meter, fall back to DeepSeek when the model is used up (unless the person turned
 * that off), or refuse with a clear limit error. Also the 80% warning, the end of free tokens,
 * and how a notice reaches the tool: as a short note at the start of the answer, which every
 * client shows (Autopilot, Claude Code, OpenCode, Cline, Cursor), plus the `x-dl-notice` header.
 */

import { DEEPSEEK_MODEL, modelById } from "./models.js";
import { approxTokens, countedFactor, PLAN_MODEL_KEYS, displayName, planLimitFor, planName, upgradeFor, PLAN_MIX_LABEL, type PaidPlan, type PlanSettingsConfig } from "./plans.js";
import { weekEnd } from "./week.js";

/** Where the upgrade line points (shown without the scheme). */
export const UPGRADE_URL = "https://dl.new/upgrade";
const UPGRADE_SHOWN = "dl.new/upgrade";
/** The share of a model's weekly limit that warns, in the tool and by email. */
export const WARN_SHARE = 0.8;
/** How the weekly reset is written in every plan line. */
export const RESET_LABEL = "Mon 00:00 UTC";

// ─── The end of free tokens ──────────────────────────────────────────────────

/** Default `freeEndsAt`: Tue 8 Dec 2026 00:00 UTC. */
export const FREE_ENDS_AT = Date.UTC(2026, 11, 8);
export const FREE_ENDED_MESSAGE = "dl.new is paid now. Pick a plan at dl.new to keep going.";
/** The refusal's code (402). */
export const FREE_ENDED_CODE = "plan_required";

/** Whether a non-paying, non-admin account is past the end of free tokens. */
export function freeEnded(freeEndsAt: number | undefined, now: number): boolean {
  return freeEndsAt !== undefined && now >= freeEndsAt;
}

// ─── Copy ────────────────────────────────────────────────────────────────────

/** "3d 4h", "5h 12m", "12m": the time until `at`. */
export function timeLeft(now: number, at: number): string {
  const minutes = Math.max(0, Math.ceil((at - now) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/** "Kimi K3.1 used up until Mon 00:00 UTC, now using DeepSeek V4.1 Flash." */
export function fallbackNotice(fromName: string, toName: string): string {
  return `${fromName} used up until ${RESET_LABEL}, now using ${toName}.`;
}

/** "DeepSeek V4.1 Flash: 80% used (~50M of ~62M at 95.5% caching). ~12M left until Mon 00:00 UTC." */
export function warningNotice(name: string, usedReal: number, limitReal: number): string {
  const share = Math.min(99, Math.max(80, Math.floor((usedReal / Math.max(1, limitReal)) * 100)));
  return `${name}: ${share}% used (${approxTokens(usedReal)} of ${approxTokens(limitReal)} at 95.5% caching). ${approxTokens(Math.max(0, limitReal - usedReal))} left until ${RESET_LABEL}.`;
}

/**
 * The 100% error: "DeepSeek V4.1 Flash weekly limit reached, resumes Mon 00:00 UTC (in 4d 12h).
 * Upgrade to Plus for ~150M/week: dl.new/upgrade". No upgrade line on the top plan.
 */
export function limitMessage(name: string, now: number, upgrade: { plan: PaidPlan; realTokens: number } | undefined): string {
  const base = `${name} weekly limit reached, resumes ${RESET_LABEL} (in ${timeLeft(now, weekEnd(now))}).`;
  return upgrade ? `${base} Upgrade to ${planName(upgrade.plan)} for ${approxTokens(upgrade.realTokens)}/week: ${UPGRADE_SHOWN}` : base;
}

/** A model the plan doesn't include. */
export function notInPlanMessage(name: string, plan: PaidPlan, included: readonly string[], upgrade: PaidPlan | undefined): string {
  const list = included.join(" and ");
  const base = `${name} isn't in your ${planName(plan)} plan, which includes ${list}.`;
  return upgrade ? `${base} Upgrade to ${planName(upgrade)} to use it: ${UPGRADE_SHOWN}` : base;
}

// ─── The decision ────────────────────────────────────────────────────────────

/** A model's meter right now. */
export interface ModelMeter {
  model: string;
  name: string;
  /** Counted tokens this week. */
  counted: number;
  /** The plan's counted limit. */
  limit: number;
  /** The same in real tokens at the plan mix, for copy. */
  realLimit: number;
}

export type PlanDecision =
  | {
      kind: "serve";
      /** The model that serves (the requested one, or DeepSeek as the fallback). */
      model: string;
      /** Its meter: what the reservation is held to. */
      meter: ModelMeter;
      /** The fallback's notice, when DeepSeek serves in place of the requested model. */
      fallbackNotice?: string;
      /** The model fell back (failover in the request log). */
      fellBack: boolean;
    }
  | { kind: "refuse"; status: 402; code: "plan_limit" | "provider_limit"; message: string; details: Record<string, unknown> };

export type PlanDecisionConfig = PlanSettingsConfig & { cachedTokenWeight: number };

/** A model's meter on a plan, from this week's counted tokens; undefined when the plan doesn't include it. */
export function meterFor(plan: PaidPlan, modelId: string, counted: number, config: PlanDecisionConfig): ModelMeter | undefined {
  const limit = planLimitFor(plan, modelId, config);
  if (!limit) return undefined;
  return { model: modelId, name: limit.name, counted, limit: limit.countedTokens, realLimit: limit.realTokens };
}

/**
 * The plan's answer for a request for `requested` (a model the service serves; GPT-6 is handled
 * by gpt6-bonus.ts before this). `counted` is this week's counted tokens per model.
 */
export function decide(input: {
  plan: PaidPlan;
  requested: string;
  counted: Readonly<Record<string, number>>;
  fallback: boolean;
  /** Whether DeepSeek can serve right now (its provider has credit). */
  deepseekAvailable: boolean;
  config: PlanDecisionConfig;
  now: number;
}): PlanDecision {
  const { plan, requested, config, now } = input;
  const model = modelById(requested);
  const name = model ? displayName(model) : requested;
  const resetsAt = new Date(weekEnd(now)).toISOString();
  const meter = meterFor(plan, requested, input.counted[requested] ?? 0, config);
  if (!meter) {
    const included = includedNames(plan, config);
    const upgrade = upgradeFor(plan, requested, config)?.plan;
    return {
      kind: "refuse",
      status: 402,
      code: "provider_limit",
      message: notInPlanMessage(name, plan, included, upgrade),
      details: { reason: "not_in_plan", plan, model: requested, alternative: DEEPSEEK_MODEL, resetsAt: null, ...(upgrade ? { upgradeUrl: UPGRADE_URL, upgradePlan: upgrade } : {}) },
    };
  }
  if (meter.counted < meter.limit) return { kind: "serve", model: requested, meter, fellBack: false };
  // Used up: DeepSeek in its place when the person allows it and DeepSeek has room.
  if (input.fallback && requested !== DEEPSEEK_MODEL && input.deepseekAvailable) {
    const deepseek = meterFor(plan, DEEPSEEK_MODEL, input.counted[DEEPSEEK_MODEL] ?? 0, config);
    if (deepseek && deepseek.counted < deepseek.limit) {
      return { kind: "serve", model: DEEPSEEK_MODEL, meter: deepseek, fallbackNotice: fallbackNotice(name, deepseek.name), fellBack: true };
    }
  }
  return limitRefusal(plan, meter, now, config, input.fallback);
}

/** The 100% refusal for a meter, with the upgrade line when a bigger plan has more of the model. */
export function limitRefusal(plan: PaidPlan, meter: ModelMeter, now: number, config: PlanDecisionConfig, fallback = true): Extract<PlanDecision, { kind: "refuse" }> {
  const upgrade = upgradeFor(plan, meter.model, config);
  const resetsAt = new Date(weekEnd(now)).toISOString();
  return {
    kind: "refuse",
    status: 402,
    code: "plan_limit",
    message: limitMessage(meter.name, now, upgrade ? { plan: upgrade.plan, realTokens: upgrade.limit.realTokens } : undefined),
    details: {
      plan,
      model: meter.model,
      resetsAt,
      retryAfterSeconds: Math.max(1, Math.ceil((weekEnd(now) - now) / 1000)),
      countedUsed: meter.counted,
      countedLimit: meter.limit,
      fallback,
      ...(upgrade ? { upgradeUrl: UPGRADE_URL, upgradePlan: upgrade.plan } : {}),
    },
  };
}

function includedNames(plan: PaidPlan, config: PlanDecisionConfig): string[] {
  return Object.values(PLAN_MODEL_KEYS).map((id) => planLimitFor(plan, id, config)?.name).filter((name): name is string => name !== undefined);
}

/** Real tokens a counted amount stands for at the plan mix. */
export function realFromCounted(counted: number, cachedTokenWeight: number): number {
  return counted / countedFactor(cachedTokenWeight);
}

/**
 * The 80% warning for a meter, when it is at or past WARN_SHARE (and not used up): its text, in
 * real tokens at the plan mix. Undefined below it. Whether it was shown already this week is the
 * caller's (AccountObject.claimPlanNotice).
 */
export function warningFor(meter: ModelMeter): string | undefined {
  if (meter.limit <= 0 || meter.counted < meter.limit * WARN_SHARE || meter.counted >= meter.limit) return undefined;
  const usedReal = (meter.counted / meter.limit) * meter.realLimit;
  return warningNotice(meter.name, usedReal, meter.realLimit);
}

/** The values the plan_80 email fills in (user-emails.ts). */
export function warningEmailValues(meter: ModelMeter): { model: string; share: string; used: string; limit: string; left: string } {
  const usedReal = (meter.counted / Math.max(1, meter.limit)) * meter.realLimit;
  return {
    model: meter.name,
    share: String(Math.min(99, Math.max(80, Math.floor((meter.counted / Math.max(1, meter.limit)) * 100)))),
    used: approxTokens(usedReal),
    limit: approxTokens(meter.realLimit),
    left: approxTokens(Math.max(0, meter.realLimit - usedReal)),
  };
}

export { PLAN_MIX_LABEL };

// ─── Showing a notice in the tool ────────────────────────────────────────────

/** How a notice starts in the answer, so it reads as the service's and not the model's. */
export const NOTICE_PREFIX = "[dl.new] ";

/** The notice text as the answer carries it: prefixed, one line each, then a blank line. */
export function noticeText(notices: readonly string[]): string {
  return `${notices.map((notice) => `${NOTICE_PREFIX}${notice}`).join("\n")}\n\n`;
}

/**
 * The response with `notices` shown: `x-dl-notice` (printable ASCII, the notices joined) for
 * clients that read headers, and the notices as the first content of the answer, which every
 * client shows. A stream gets one leading chat.completion.chunk with the text; a JSON answer has
 * it put before its first choice's content. Error answers are passed through untouched.
 */
export async function withNotices(response: Response, notices: readonly string[], model: string): Promise<Response> {
  if (notices.length === 0 || response.status !== 200) return response;
  const headers = new Headers(response.headers);
  headers.set("x-dl-notice", notices.join(" ").replace(/[^\x20-\x7e]/g, ""));
  headers.delete("content-length");
  const text = noticeText(notices);
  const type = headers.get("content-type") ?? "";
  if (type.includes("text/event-stream") && response.body) {
    const chunk = { id: "dl-notice", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] };
    const lead = new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`);
    const body = response.body;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(lead);
        const reader = body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
      cancel(reason) {
        return body.cancel(reason);
      },
    });
    return new Response(stream, { status: response.status, headers });
  }
  if (type.includes("application/json")) {
    const raw = await response.text();
    try {
      const body = JSON.parse(raw) as { choices?: Array<{ message?: { content?: unknown } }> };
      const message = body.choices?.[0]?.message;
      if (!message) return new Response(raw, { status: response.status, headers });
      message.content = typeof message.content === "string" ? `${text}${message.content}` : text.trimEnd();
      return new Response(JSON.stringify(body), { status: response.status, headers });
    } catch {
      return new Response(raw, { status: response.status, headers });
    }
  }
  return new Response(response.body, { status: response.status, headers });
}
