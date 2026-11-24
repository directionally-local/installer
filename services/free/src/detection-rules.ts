/**
 * The anti-abuse rules: what the security pre-check matches (security-route.ts), which clients
 * count as account-pooling routers (abuse.ts), the policy the use-description labeller and the
 * moderation reviewer are given (use-description.ts, moderation.ts), and the farm-detection
 * thresholds' starting values (admission.ts), and the GPT-6 pre-send safeguard's policy
 * (presend-guard.ts).
 *
 * The machinery is public; the production rules are not. Published rules can be read by the
 * people they are meant to catch, who then stay just under them. So the production rules live in
 * one private secret, DETECTION_RULES (JSON, `wrangler secret put DETECTION_RULES`), read when
 * the config is, and this file holds only a small generic default set: enough for tests, local
 * development and self-hosters, and never the production values.
 *
 * Shape (every field optional; a field that is present replaces its default whole):
 *
 *   {
 *     "keywords": [{ "id": "rule-id", "pattern": "regex" | ["regex", ...], "flags": "i",
 *                    "category": "<use category>", "risk": "low" | "high" }, ...],
 *     "proxyRouters": ["regex", ...],
 *     "labellerPolicy": "text",
 *     "moderationPolicy": "text",
 *     "allocatorPolicy": "text",
 *     "guardPolicy": "text",
 *     "thresholds": { "batchSize": 10, ... }
 *   }
 *
 * A keyword rule matches when every one of its patterns matches the same text. `flags` defaults
 * to "i" and may use i, m, s and u. Thresholds are the starting values of runtime settings
 * (THRESHOLD_KEYS): an env var of the same setting still wins over them, and an admin override
 * (/admin/config) over both.
 *
 * A secret that doesn't parse or validate is ignored as a whole: the error is logged once (never
 * the content), the defaults are used, and /admin/config says so. It never crashes the service
 * and never turns detection off (an empty keyword list is refused). /admin/config shows only
 * whether the secret is loaded and how many rules each part has, never the rules.
 */

import { USE_CATEGORIES, type UseCategory } from "./use-description.js";

export type KeywordRisk = "low" | "high";

export interface KeywordRule {
  /** Stable name: recorded as the use description "Keyword match: <id>". */
  id: string;
  /** Every pattern must match the same text. */
  all: readonly RegExp[];
  category: UseCategory;
  /** "high" rules win over earlier "low" ones and start a moderation review. */
  risk: KeywordRisk;
}

/** Runtime settings whose starting value (below any env var or admin override) the secret may set. */
export const THRESHOLD_KEYS = [
  "humanSignalsNeeded",
  "minActiveWeeks",
  "minRepoAgeDays",
  "minSocial",
  "minFollowers",
  "batchWindowDays",
  "batchSize",
  "batchDensityFactor",
  "basicMinAccountAgeDays",
  "domainSignupsPerDay",
] as const;
export type ThresholdKey = (typeof THRESHOLD_KEYS)[number];

export interface DetectionRules {
  keywords: readonly KeywordRule[];
  proxyRouters: readonly RegExp[];
  /** What the use-description labeller is told counts as "high", "low" and "none" risk. */
  labellerPolicy: string;
  /** What the moderation reviewer is told to block, pass and watch, and how to weigh the case. */
  moderationPolicy: string;
  /** What the token allocator (allocator.ts) is told counts as real use worth a raise. */
  allocatorPolicy: string;
  /** The GPT-6 pre-send safeguard classifier's system prompt (presend-guard.ts): it answers "1" (violates) or "0". */
  guardPolicy: string;
  thresholds: Readonly<Partial<Record<ThresholdKey, number>>>;
}

/** What /admin/config shows: where the rules came from and counts, never their content. */
export interface DetectionRulesStatus {
  /** "secret": DETECTION_RULES is set and in use; "defaults": not set; "invalid": set but ignored. */
  source: "secret" | "defaults" | "invalid";
  /** Why the secret was ignored (a field and a reason, never its content). */
  error?: string;
  keywords: number;
  highRiskKeywords: number;
  proxyRouters: number;
  labellerPolicy: "secret" | "default";
  moderationPolicy: "secret" | "default";
  allocatorPolicy: "secret" | "default";
  guardPolicy: "secret" | "default";
  /** How many thresholds the secret sets. */
  thresholds: number;
}

/**
 * The public default rules: a few unmistakable terms and generic policy text. Production sets
 * its own in DETECTION_RULES.
 */
export const DEFAULT_DETECTION_RULES: DetectionRules = {
  keywords: [
    { id: "ctf", all: [/\b(ctfs?|capture[ -]the[ -]flag)\b/i], category: "security-offensive", risk: "low" },
    { id: "reverse-shell", all: [/\b(reverse|bind)[ -]?shells?\b/i], category: "security-offensive", risk: "low" },
    { id: "malware", all: [/\b(malware|ransomware|botnets?)\b/i], category: "malware", risk: "high" },
    { id: "keylogger", all: [/\bkey ?logg(er|ers|ing)\b/i], category: "malware", risk: "high" },
    { id: "phishing", all: [/\bphishing\b/i], category: "credential-theft", risk: "high" },
  ],
  proxyRouters: [/9[-_ ]?router/i],
  labellerPolicy:
    'risk: "high" for clear intent to cause harm (attacking systems, malware, stealing credentials, spam or fraud); "low" for security work or anything unclear that could be harmful; "none" otherwise.',
  moderationPolicy: `Policy.
BLOCK clear malicious use of the service, or abuse of the free tier itself.
PASS legitimate work, including defensive security and keyword coincidences in ordinary coding.
WATCH when it is unclear.

Weigh the whole history, not a single request.`,
  allocatorPolicy: `Policy.
Raise ("10m", or "full" for a long, clearly real record) only with clear evidence of a real developer doing real software work: several multi-turn sessions, varied coding descriptions, human pacing across several days.
Answer "stay" for one-shot or tiny sessions, greetings only, scripted bursts, non-coding bulk use, signs of reselling or sharing the account, or anything unclear.
When unsure, "stay".`,
  guardPolicy: `You classify requests sent to a coding agent service. Answer 1 when the request asks the agent to build, run, improve or hide malware, steal credentials, attack systems the person isn't authorised to test, or commit fraud or abuse at scale. Answer 0 for ordinary programming, defensive security and anything else.
Answer with exactly one character: 1 or 0.`,
  thresholds: {},
};

const MAX_RULES = 500;
const MAX_PATTERN_CHARS = 4_000;
const MAX_PATTERNS_PER_RULE = 8;
const MAX_POLICY_CHARS = 16_000;
const MAX_THRESHOLD = 1_000_000;
const RULE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const TOP_LEVEL = new Set(["keywords", "proxyRouters", "labellerPolicy", "moderationPolicy", "allocatorPolicy", "guardPolicy", "thresholds"]);

class RulesError extends Error {}

function regex(source: unknown, flags: string, where: string): RegExp {
  if (typeof source !== "string" || source === "" || source.length > MAX_PATTERN_CHARS) throw new RulesError(`${where} must be a non-empty string of at most ${MAX_PATTERN_CHARS} characters`);
  try {
    return new RegExp(source, flags);
  } catch {
    throw new RulesError(`${where} isn't a valid regular expression`);
  }
}

function flagsOf(value: unknown, where: string): string {
  if (value === undefined) return "i";
  if (typeof value !== "string" || !/^[imsu]*$/.test(value) || new Set(value).size !== value.length) throw new RulesError(`${where} may use only the flags i, m, s and u`);
  return value;
}

function policy(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_POLICY_CHARS) throw new RulesError(`${where} must be non-empty text of at most ${MAX_POLICY_CHARS} characters`);
  return value.trim();
}

function keywords(value: unknown): KeywordRule[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RULES) throw new RulesError(`keywords must be a list of 1 to ${MAX_RULES} rules`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const where = `keywords[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new RulesError(`${where} must be an object`);
    const { id, pattern, flags, category, risk, ...rest } = entry as Record<string, unknown>;
    if (Object.keys(rest).length > 0) throw new RulesError(`${where} has unknown fields`);
    if (typeof id !== "string" || !RULE_ID.test(id)) throw new RulesError(`${where}.id must be lowercase letters, digits and dashes (at most 48)`);
    if (seen.has(id)) throw new RulesError(`${where}.id is used twice`);
    seen.add(id);
    const f = flagsOf(flags, `${where}.flags`);
    const sources = Array.isArray(pattern) ? pattern : [pattern];
    if (sources.length === 0 || sources.length > MAX_PATTERNS_PER_RULE) throw new RulesError(`${where}.pattern must have 1 to ${MAX_PATTERNS_PER_RULE} patterns`);
    const all = sources.map((source, n) => regex(source, f, `${where}.pattern${Array.isArray(pattern) ? `[${n}]` : ""}`));
    if (typeof category !== "string" || !(USE_CATEGORIES as readonly string[]).includes(category)) throw new RulesError(`${where}.category must be one of ${USE_CATEGORIES.join(", ")}`);
    if (risk !== "low" && risk !== "high") throw new RulesError(`${where}.risk must be "low" or "high"`);
    return { id, all, category: category as UseCategory, risk };
  });
}

function proxyRouters(value: unknown): RegExp[] {
  if (!Array.isArray(value) || value.length > MAX_RULES) throw new RulesError(`proxyRouters must be a list of at most ${MAX_RULES} patterns`);
  return value.map((source, index) => regex(source, "i", `proxyRouters[${index}]`));
}

function thresholds(value: unknown): Partial<Record<ThresholdKey, number>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RulesError("thresholds must be an object");
  const out: Partial<Record<ThresholdKey, number>> = {};
  for (const [key, n] of Object.entries(value)) {
    if (!(THRESHOLD_KEYS as readonly string[]).includes(key)) throw new RulesError(`thresholds.${key} isn't one of ${THRESHOLD_KEYS.join(", ")}`);
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > MAX_THRESHOLD) throw new RulesError(`thresholds.${key} must be a whole number, 0 to ${MAX_THRESHOLD}`);
    out[key as ThresholdKey] = n;
  }
  return out;
}

function statusOf(rules: DetectionRules, source: DetectionRulesStatus["source"], given: Record<string, unknown>, error?: string): DetectionRulesStatus {
  return {
    source,
    ...(error ? { error } : {}),
    keywords: rules.keywords.length,
    highRiskKeywords: rules.keywords.filter((rule) => rule.risk === "high").length,
    proxyRouters: rules.proxyRouters.length,
    labellerPolicy: "labellerPolicy" in given ? "secret" : "default",
    moderationPolicy: "moderationPolicy" in given ? "secret" : "default",
    allocatorPolicy: "allocatorPolicy" in given ? "secret" : "default",
    guardPolicy: "guardPolicy" in given ? "secret" : "default",
    thresholds: Object.keys(rules.thresholds).length,
  };
}

/**
 * The rules from DETECTION_RULES's value: the secret's fields over the defaults, or the defaults
 * alone when it is unset, empty, or doesn't parse or validate (then `status.error` says why).
 */
export function parseDetectionRules(raw: unknown): { rules: DetectionRules; status: DetectionRulesStatus } {
  if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) {
    return { rules: DEFAULT_DETECTION_RULES, status: statusOf(DEFAULT_DETECTION_RULES, "defaults", {}) };
  }
  try {
    let parsed: unknown = raw;
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new RulesError("it isn't valid JSON");
      }
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new RulesError("it must be a JSON object");
    const given = parsed as Record<string, unknown>;
    for (const key of Object.keys(given)) if (!TOP_LEVEL.has(key)) throw new RulesError(`"${key}" isn't a field (use ${[...TOP_LEVEL].join(", ")})`);
    const rules: DetectionRules = {
      keywords: "keywords" in given ? keywords(given.keywords) : DEFAULT_DETECTION_RULES.keywords,
      proxyRouters: "proxyRouters" in given ? proxyRouters(given.proxyRouters) : DEFAULT_DETECTION_RULES.proxyRouters,
      labellerPolicy: "labellerPolicy" in given ? policy(given.labellerPolicy, "labellerPolicy") : DEFAULT_DETECTION_RULES.labellerPolicy,
      moderationPolicy: "moderationPolicy" in given ? policy(given.moderationPolicy, "moderationPolicy") : DEFAULT_DETECTION_RULES.moderationPolicy,
      allocatorPolicy: "allocatorPolicy" in given ? policy(given.allocatorPolicy, "allocatorPolicy") : DEFAULT_DETECTION_RULES.allocatorPolicy,
      guardPolicy: "guardPolicy" in given ? policy(given.guardPolicy, "guardPolicy") : DEFAULT_DETECTION_RULES.guardPolicy,
      thresholds: "thresholds" in given ? thresholds(given.thresholds) : DEFAULT_DETECTION_RULES.thresholds,
    };
    return { rules, status: statusOf(rules, "secret", given) };
  } catch (error) {
    if (!(error instanceof RulesError)) throw error;
    return { rules: DEFAULT_DETECTION_RULES, status: statusOf(DEFAULT_DETECTION_RULES, "invalid", {}, error.message) };
  }
}

let cached: { raw: unknown; result: { rules: DetectionRules; status: DetectionRulesStatus } } | undefined;

/**
 * parseDetectionRules for the env's DETECTION_RULES, parsed once per value (the config is read on
 * every request). An invalid secret is logged once per value, with the reason only.
 */
export function detectionRulesFrom(raw: unknown): { rules: DetectionRules; status: DetectionRulesStatus } {
  if (cached && cached.raw === raw) return cached.result;
  const result = parseDetectionRules(raw);
  if (result.status.source === "invalid") console.error(`DETECTION_RULES ignored, using the public defaults: ${result.status.error}`);
  cached = { raw, result };
  return result;
}
