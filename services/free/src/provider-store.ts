/**
 * The Directory's provider tables (directory-object.ts calls these inside its transactions):
 *
 *   provider_credit_weeks   per registry provider per week: all credit used (requests by
 *                           everyone, probes), the part everyone but admins used (what the
 *                           weekly budget counts), the free part, and the probes' part
 *   provider_person_weeks   per registry provider, person and week: their spend, for the
 *                           opt-in cap (ids and dollars only; older weeks are pruned); a model
 *                           with its own cap (models.ts `ownCaps`) is counted under
 *                           "model:<id>" instead, across its upstreams
 *   share_weeks             per budget share and week: all credit used and the part everyone but
 *                           admins used. A share is one model's part of one upstream's credit,
 *                           "<provider>:<model id>" (what `modelWeeklyCredit.<p>.<key>` counts);
 *                           dollars only, read by every request's gate
 *   provider_probes         one row per speed probe (probes.ts): the model, whether it worked,
 *                           time to first token, tokens a second and its cost, and on Liquid
 *                           the seller that served it and the exchange's own timing; 15 days kept
 *
 * OpenAI's and Luminal's credit stays in `spend_weeks`, where it always was; `providerSpend`
 * reads both into one view. Counts, times and dollars only: never a prompt or an answer.
 */

import type { Sql } from "./dashboard-data.js";
import { FREE_MODELS, modelById, upstreamsOf } from "./models.js";
import { isRegistryProvider, modelSpendKey, personSpendKey, PROVIDER_IDS, type ProviderId, type ProviderSpend } from "./providers.js";
import { DAY_MS, WEEK_MS, weekStart } from "./week.js";

export const PROVIDER_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS provider_credit_weeks (
     week_start   INTEGER NOT NULL,
     provider     TEXT NOT NULL,
     credit_usd   REAL NOT NULL DEFAULT 0,
     user_usd     REAL NOT NULL DEFAULT 0,
     free_usd     REAL NOT NULL DEFAULT 0,
     internal_usd REAL NOT NULL DEFAULT 0,
     PRIMARY KEY (week_start, provider)
   )`,
  `CREATE TABLE IF NOT EXISTS provider_person_weeks (
     week_start INTEGER NOT NULL,
     provider   TEXT NOT NULL,
     github_id  INTEGER NOT NULL,
     usd        REAL NOT NULL DEFAULT 0,
     PRIMARY KEY (week_start, provider, github_id)
   )`,
  `CREATE TABLE IF NOT EXISTS share_weeks (
     week_start INTEGER NOT NULL,
     share      TEXT NOT NULL,
     credit_usd REAL NOT NULL DEFAULT 0,
     user_usd   REAL NOT NULL DEFAULT 0,
     PRIMARY KEY (week_start, share)
   )`,
  `CREATE TABLE IF NOT EXISTS provider_probes (
     id                INTEGER PRIMARY KEY AUTOINCREMENT,
     at                INTEGER NOT NULL,
     provider          TEXT NOT NULL,
     model             TEXT NOT NULL,
     ok                INTEGER NOT NULL,
     ttft_ms           INTEGER,
     tokens_per_second REAL,
     completion_tokens INTEGER,
     cost_usd          REAL NOT NULL DEFAULT 0,
     error             TEXT,
     seller            TEXT,
     reported_ttft_ms  INTEGER,
     reported_tps      REAL
   )`,
  `CREATE INDEX IF NOT EXISTS provider_probes_model_at ON provider_probes (model, at)`,
];

/** Probes older than this go. */
export const PROBES_KEEP_MS = 15 * DAY_MS;

/** One spend on a registry provider's credit. */
export interface ProviderCharge {
  provider: ProviderId;
  at: number;
  usd: number;
  /** Who spent it: a person's request, or the service's own call (a probe, a use description). */
  githubId?: number;
  isAdmin?: boolean;
  paid?: boolean;
  internal?: boolean;
  /** The model it was for (a request's or a probe's): its spend on this upstream, and with `ownCaps` the person's under "model:<id>". */
  model?: string;
}

/** Adds a charge to a registry provider's week (and the person's, for a request); a no-op for OpenAI and Luminal. */
export function addProviderCharge(sql: Sql, charge: ProviderCharge): void {
  if (!isRegistryProvider(charge.provider) || !(charge.usd > 0)) return;
  const week = weekStart(charge.at);
  const person = charge.internal !== true && charge.githubId !== undefined;
  const user = person && charge.isAdmin !== true;
  const free = user && charge.paid !== true;
  sql.exec(
    `INSERT INTO provider_credit_weeks (week_start, provider, credit_usd, user_usd, free_usd, internal_usd) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (week_start, provider) DO UPDATE SET credit_usd = credit_usd + excluded.credit_usd, user_usd = user_usd + excluded.user_usd,
       free_usd = free_usd + excluded.free_usd, internal_usd = internal_usd + excluded.internal_usd`,
    week,
    charge.provider,
    charge.usd,
    user ? charge.usd : 0,
    free ? charge.usd : 0,
    charge.internal ? charge.usd : 0,
  );
  const model = charge.model !== undefined ? modelById(charge.model) : undefined;
  if (model) {
    sql.exec(
      `INSERT INTO share_weeks (week_start, share, credit_usd, user_usd) VALUES (?, ?, ?, ?)
       ON CONFLICT (week_start, share) DO UPDATE SET credit_usd = credit_usd + excluded.credit_usd, user_usd = user_usd + excluded.user_usd`,
      week,
      modelSpendKey(charge.provider, model.id),
      charge.usd,
      user ? charge.usd : 0,
    );
  }
  if (user) {
    sql.exec(
      `INSERT INTO provider_person_weeks (week_start, provider, github_id, usd) VALUES (?, ?, ?, ?)
       ON CONFLICT (week_start, provider, github_id) DO UPDATE SET usd = usd + excluded.usd`,
      week,
      model ? personSpendKey(model) : charge.provider,
      charge.githubId!,
      charge.usd,
    );
    sql.exec("DELETE FROM provider_person_weeks WHERE week_start < ?", week - WEEK_MS);
  }
}

/** OpenAI's and Luminal's numbers, as the Directory's spend summary has them. */
export interface LegacySpend {
  openaiCreditUsedUsd: number;
  openaiFreeCreditWeekUsd: number;
  creditUsedUsd: number;
  freeCreditWeekUsd: number;
}

/** Every provider's credit used since the start, and this week by everyone but admins. */
export function providerSpend(sql: Sql, now: number, legacy: LegacySpend): ProviderSpend {
  const usedUsd: ProviderSpend["usedUsd"] = { openai: legacy.openaiCreditUsedUsd, luminal: legacy.creditUsedUsd };
  // OpenAI's and Luminal's weekly budgets have always counted free usage only.
  const weekUsd: ProviderSpend["weekUsd"] = { openai: legacy.openaiFreeCreditWeekUsd, luminal: legacy.freeCreditWeekUsd };
  const week = weekStart(now);
  for (const row of sql
    .exec<{ provider: string; used: number | null; week: number | null }>(
      "SELECT provider, SUM(credit_usd) AS used, SUM(CASE WHEN week_start = ? THEN user_usd ELSE 0 END) AS week FROM provider_credit_weeks GROUP BY provider",
      week,
    )
    .toArray()) {
    if (!isRegistryProvider(row.provider)) continue;
    usedUsd[row.provider] = round(row.used ?? 0);
    weekUsd[row.provider] = round(row.week ?? 0);
  }
  return { usedUsd, weekUsd };
}

/** This week's spend by everyone but admins per model and upstream (`ProviderSpend.modelWeekUsd`), for the per-model weekly shares. */
export function modelWeekSpend(sql: Sql, now: number): Partial<Record<string, number>> {
  const out: Partial<Record<string, number>> = {};
  for (const row of sql.exec<{ share: string; usd: number }>("SELECT share, user_usd AS usd FROM share_weeks WHERE week_start = ?", weekStart(now)).toArray()) {
    out[row.share] = round(row.usd);
  }
  return out;
}

/**
 * One person's spend this week on each registry provider, and under "model:<id>" on each model
 * with its own cap (models.ts `ownCaps`), whichever upstream served it (providers.ts personSpendKey).
 */
export function personProviderWeek(sql: Sql, githubId: number, now: number): Partial<Record<string, number>> {
  const out: Partial<Record<string, number>> = {};
  for (const row of sql.exec<{ provider: string; usd: number }>("SELECT provider, usd FROM provider_person_weeks WHERE week_start = ? AND github_id = ?", weekStart(now), githubId).toArray()) {
    if (isRegistryProvider(row.provider) || row.provider.startsWith("model:")) out[row.provider] = round(row.usd);
  }
  return out;
}

/** This week's spend on each model a registry provider serves: all of it, and everyone's but admins'. */
export function modelWeeks(sql: Sql, provider: ProviderId, now: number): Map<string, { weekUsd: number; userWeekUsd: number }> {
  const out = new Map<string, { weekUsd: number; userWeekUsd: number }>();
  const prefix = modelSpendKey(provider, "");
  for (const row of sql.exec<{ share: string; credit: number; user: number }>("SELECT share, credit_usd AS credit, user_usd AS user FROM share_weeks WHERE week_start = ?", weekStart(now)).toArray()) {
    if (row.share.startsWith(prefix)) out.set(row.share.slice(prefix.length), { weekUsd: round(row.credit), userWeekUsd: round(row.user) });
  }
  return out;
}

/** A registry provider's week, for the admin view: all credit, users' share, free share and probes. */
export function providerWeeks(sql: Sql, provider: ProviderId, now: number): { weekUsd: number; userWeekUsd: number; freeWeekUsd: number; probeWeekUsd: number; probeTotalUsd: number } {
  const row = sql
    .exec<{ credit: number | null; user: number | null; free: number | null; internal: number | null }>(
      "SELECT credit_usd AS credit, user_usd AS user, free_usd AS free, internal_usd AS internal FROM provider_credit_weeks WHERE provider = ? AND week_start = ?",
      provider,
      weekStart(now),
    )
    .toArray()[0];
  const total = sql.exec<{ internal: number | null }>("SELECT SUM(internal_usd) AS internal FROM provider_credit_weeks WHERE provider = ?", provider).toArray()[0];
  return { weekUsd: round(row?.credit ?? 0), userWeekUsd: round(row?.user ?? 0), freeWeekUsd: round(row?.free ?? 0), probeWeekUsd: round(row?.internal ?? 0), probeTotalUsd: round(total?.internal ?? 0) };
}

// ─── Speed probes ────────────────────────────────────────────────────────────

export interface ProbeRecord {
  at: number;
  provider: ProviderId;
  model: string;
  ok: boolean;
  ttftMs: number | null;
  tokensPerSecond: number | null;
  completionTokens: number | null;
  costUsd: number;
  /** What went wrong, as a short code ("http_503", "timeout", "no_usage"); never a response body. */
  error: string | null;
  /** Liquid: the seller that served it (`exchange.provider_slug`), and the exchange's own `timing.ttft_ms` and `timing.tokens_per_second`. */
  seller?: string | null;
  reportedTtftMs?: number | null;
  reportedTokensPerSecond?: number | null;
}

export function insertProbe(sql: Sql, probe: ProbeRecord): void {
  sql.exec(
    "INSERT INTO provider_probes (at, provider, model, ok, ttft_ms, tokens_per_second, completion_tokens, cost_usd, error, seller, reported_ttft_ms, reported_tps) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    probe.at,
    probe.provider,
    probe.model,
    probe.ok ? 1 : 0,
    probe.ttftMs,
    probe.tokensPerSecond,
    probe.completionTokens,
    probe.costUsd,
    probe.error,
    probe.seller ?? null,
    probe.reportedTtftMs ?? null,
    probe.reportedTokensPerSecond ?? null,
  );
  sql.exec("DELETE FROM provider_probes WHERE at < ?", probe.at - PROBES_KEEP_MS);
}

export function probeHistory(sql: Sql, since: number, limit = 500): ProbeRecord[] {
  return sql
    .exec<{ at: number; provider: string; model: string; ok: number; ttft_ms: number | null; tokens_per_second: number | null; completion_tokens: number | null; cost_usd: number; error: string | null; seller: string | null; reported_ttft_ms: number | null; reported_tps: number | null }>(
      "SELECT at, provider, model, ok, ttft_ms, tokens_per_second, completion_tokens, cost_usd, error, seller, reported_ttft_ms, reported_tps FROM provider_probes WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?",
      since,
      limit,
    )
    .toArray()
    .map((row) => ({
      at: row.at,
      provider: row.provider as ProviderId,
      model: row.model,
      ok: row.ok === 1,
      ttftMs: row.ttft_ms,
      tokensPerSecond: row.tokens_per_second,
      completionTokens: row.completion_tokens,
      costUsd: row.cost_usd,
      error: row.error,
      seller: row.seller,
      reportedTtftMs: row.reported_ttft_ms,
      reportedTokensPerSecond: row.reported_tps,
    }));
}

/** What /v1/providers shows for one model: measured speed and reliability, or nulls when nothing was measured. */
export interface ModelMeasure {
  tokensPerSecond: number | null;
  ttftMs: number | null;
  successRate24h: number | null;
  measuredAt: number | null;
}

/** Real requests a model needs in 24 hours before its own numbers replace the probes'. */
export const TRAFFIC_MIN_REQUESTS = 20;
/** Streams shorter than this many output tokens say little about speed and are left out of it. */
const SPEED_MIN_TOKENS = 20;
/** The most recent real requests read per model. */
const TRAFFIC_SAMPLE = 500;

/**
 * Per model over the last 24 hours: the median tokens a second and time to first token, and
 * the share of requests that didn't fail upstream. From real traffic when the model had at
 * least TRAFFIC_MIN_REQUESTS (admins included: it's the provider's speed), else from the probes.
 * `measuredAt` is the last probe or request used.
 */
export function modelMeasures(sql: Sql, now: number): Map<string, ModelMeasure> {
  const since = now - DAY_MS;
  const out = new Map<string, ModelMeasure>();
  for (const model of FREE_MODELS) {
    for (const { provider } of upstreamsOf(model)) {
      if (!(PROVIDER_IDS as readonly string[]).includes(provider)) continue;
      const measure = upstreamMeasure(sql, model.id, provider, since);
      if (measure) out.set(measureKey(model.id, provider, model.provider), measure);
    }
  }
  return out;
}

/**
 * The key of one upstream's measure in `modelMeasures`: the model id for its own provider, and
 * "<id>@<provider>" for a backup upstream (GLM 5.3 Flash on Open Relay: "z-ai/glm-5.3-flash@openrelay").
 */
export function measureKey(modelId: string, provider: string, ownProvider: string): string {
  return provider === ownProvider ? modelId : `${modelId}@${provider}`;
}

/** One upstream's measure of one model: its real traffic when there is enough, else its probes; undefined with neither. */
function upstreamMeasure(sql: Sql, modelId: string, provider: string, since: number): ModelMeasure | undefined {
  const traffic = sql
    .exec<{ at: number; ttft_ms: number | null; latency_ms: number | null; completion_tokens: number; upstream_error: number }>(
      `SELECT at, ttft_ms, latency_ms, completion_tokens, upstream_error FROM requests
       WHERE model = ? AND at >= ? AND upstream = ? AND status != 'abandoned' ORDER BY at DESC LIMIT ${TRAFFIC_SAMPLE}`,
      modelId,
      since,
      provider,
    )
    .toArray();
  if (traffic.length >= TRAFFIC_MIN_REQUESTS) {
    const speeds = traffic
      .filter((row) => row.upstream_error === 0 && row.ttft_ms !== null && row.latency_ms !== null && row.latency_ms > row.ttft_ms && row.completion_tokens >= SPEED_MIN_TOKENS)
      .map((row) => (row.completion_tokens * 1000) / (row.latency_ms! - row.ttft_ms!));
    const ttfts = traffic.filter((row) => row.upstream_error === 0 && row.ttft_ms !== null).map((row) => row.ttft_ms!);
    return {
      tokensPerSecond: roundTo(median(speeds), 1),
      ttftMs: roundTo(median(ttfts), 0),
      successRate24h: roundTo(traffic.filter((row) => row.upstream_error === 0).length / traffic.length, 4),
      measuredAt: traffic[0]!.at,
    };
  }
  const probes = sql
    .exec<{ at: number; ok: number; ttft_ms: number | null; tokens_per_second: number | null }>(
      "SELECT at, ok, ttft_ms, tokens_per_second FROM provider_probes WHERE model = ? AND provider = ? AND at >= ? ORDER BY at DESC",
      modelId,
      provider,
      since,
    )
    .toArray();
  if (probes.length === 0) return undefined;
  const good = probes.filter((row) => row.ok === 1);
  return {
    tokensPerSecond: roundTo(median(good.map((row) => row.tokens_per_second).filter((value): value is number => value !== null)), 1),
    ttftMs: roundTo(median(good.map((row) => row.ttft_ms).filter((value): value is number => value !== null)), 0),
    successRate24h: roundTo(good.length / probes.length, 4),
    measuredAt: probes[0]!.at,
  };
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function roundTo(value: number | null, digits: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
