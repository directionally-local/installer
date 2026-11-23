/**
 * Speed probes: every 10 minutes (PROBE_CRON, a cron trigger), one tiny streaming request per
 * model that can serve, on the service's own key: "Count from 1 to 40." with at most
 * PROBE_MAX_TOKENS of output. Each probe records whether it worked, the time to the first token
 * (reasoning counts) and tokens a second after it (provider-store.ts), which /v1/providers shows
 * when a model has too little real traffic to measure it by. A probe's cost is the service's own
 * spend on that provider's credit, never a person's allowance or the free caps.
 *
 * Kept cheap: a provider that can't serve (no key, paused, out of credit, its weekly budget used)
 * is skipped, a model that's off isn't probed, and a model whose output costs PRICEY_OUTPUT_USD
 * or more a million tokens is probed once an hour instead of every 10 minutes. The
 * `speedProbes` setting turns them all off; so does the kill switch.
 */

import type { Fetch } from "../../shared/src/github.js";
import type { FreeConfig } from "./config.js";
import { creditPrices, type FreeModel } from "./models.js";
import { toChatStream, toResponsesRequest } from "./openai-responses.js";
import type { ProbeRecord } from "./provider-store.js";
import { exchangeRules, liquidPayload, providerKey, providerModels, providerSettings, PROVIDERS, registryBlock, type ProviderSpec, type ProviderSpend } from "./providers.js";
import { costAtPrices } from "./quota.js";
import { meterStream, type StreamOutcome } from "./sse.js";

/** Every 10 minutes. Must be in `triggers.crons` in both wrangler configs. */
export const PROBE_CRON = "*/10 * * * *";
export const PROBE_INTERVAL_MS = 10 * 60_000;
export const PROBE_PROMPT = "Count from 1 to 40.";
export const PROBE_MAX_TOKENS = 120;
/** Output this dear (USD per million tokens) or dearer: probed once an hour. */
export const PRICEY_OUTPUT_USD = 20;
/** How long a probe waits for response headers, and for the whole stream. */
export const PROBE_TIMEOUT_MS = 30_000;
/** The `user` / safety identifier probes send: not a person. */
export const PROBE_USER = "dl-speed-probe";

export interface ProbeTarget {
  provider: ProviderSpec;
  model: FreeModel;
}

/**
 * The models to probe in the run due at `at`: those of providers that can serve now, that are
 * on, and (for pricey ones) only in the run at the top of the hour.
 */
export function probeTargets(config: FreeConfig, spend: ProviderSpend, at: number): ProbeTarget[] {
  const run = Math.floor(at / PROBE_INTERVAL_MS);
  const out: ProbeTarget[] = [];
  for (const provider of PROVIDERS) {
    if (providerKey(config, provider.id) === undefined) continue;
    const settings = providerSettings(config, provider.id);
    if (settings.status !== "on" || (spend.usedUsd[provider.id] ?? 0) >= settings.creditUsd) continue;
    for (const model of providerModels(provider.id)) {
      if (!settings.models.includes(model.id)) continue;
      if (provider.kind === "registry" && registryBlock(config, model, spend) !== undefined) continue;
      if (model.prices.output >= PRICEY_OUTPUT_USD && run % 6 !== 0) continue;
      out.push({ provider, model });
    }
  }
  return out;
}

/** The request a probe sends: the URL and the body, in the provider's own shape. */
export function probeRequest(config: FreeConfig, target: ProbeTarget): { url: string; body: Record<string, unknown> } {
  const messages = [{ role: "user", content: PROBE_PROMPT }];
  const { provider, model } = target;
  if (provider.apiStyle === "openai-responses") {
    return {
      url: `${provider.baseUrl}/responses`,
      body: toResponsesRequest({ messages, reasoning: { effort: "low" } }, { model: model.upstreamModel, maxTokens: PROBE_MAX_TOKENS, user: PROBE_USER, stream: true }),
    };
  }
  const rules = exchangeRules(config, model);
  if (rules) return { url: `${provider.baseUrl}/chat/completions`, body: liquidPayload({ messages }, { model, maxTokens: PROBE_MAX_TOKENS, stream: true, user: PROBE_USER, rules }) };
  return {
    url: `${provider.baseUrl}/chat/completions`,
    body: { model: model.upstreamModel, messages, max_completion_tokens: PROBE_MAX_TOKENS, stream: true, stream_options: { include_usage: true }, user: PROBE_USER },
  };
}

/** One probe, measured. Never throws: a failure is a record with `ok: false` and a short code. */
export async function probeOnce(fetcher: Fetch, config: FreeConfig, target: ProbeTarget, now: () => number): Promise<ProbeRecord> {
  const { provider, model } = target;
  const started = now();
  const failed = (error: string, costUsd = 0): ProbeRecord => ({ at: started, provider: provider.id, model: model.id, ok: false, ttftMs: null, tokensPerSecond: null, completionTokens: null, costUsd, error });
  const { url, body } = probeRequest(config, target);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "POST",
        headers: { authorization: `Bearer ${providerKey(config, provider.id)}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      return failed(controller.signal.aborted ? "timeout" : "unreachable");
    }
    if (!response.ok || !response.body) {
      await response.text().catch(() => "");
      return failed(`http_${response.status}`);
    }
    const stream = provider.apiStyle === "openai-responses" ? toChatStream(response.body) : response.body;
    let outcome: StreamOutcome | undefined;
    const metered = meterStream(
      stream,
      async (result) => {
        outcome = result;
      },
      now,
    );
    const reader = metered.getReader();
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // the outcome says the stream failed
    }
    if (!outcome) return failed(controller.signal.aborted ? "timeout" : "stream_error");
    const usage = outcome.usage;
    const costUsd = outcome.chargeUsd ?? (usage ? costAtPrices(usage, creditPrices(model)) : 0);
    if (outcome.upstreamFailed || outcome.errored) return failed(controller.signal.aborted ? "timeout" : "stream_error", costUsd);
    if (!usage) return failed("no_usage", costUsd);
    if (outcome.firstContentAt === undefined) return failed("no_content", costUsd);
    const ttftMs = Math.max(0, outcome.firstContentAt - started);
    const generationMs = (outcome.endedAt ?? now()) - outcome.firstContentAt;
    const tokensPerSecond = generationMs > 0 && usage.completionTokens > 1 ? Math.round(((usage.completionTokens * 1000) / generationMs) * 10) / 10 : null;
    return { at: started, provider: provider.id, model: model.id, ok: true, ttftMs, tokensPerSecond, completionTokens: usage.completionTokens, costUsd, error: null };
  } finally {
    clearTimeout(timer);
  }
}
