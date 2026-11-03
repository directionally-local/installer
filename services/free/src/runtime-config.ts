import type { FreeConfig } from "./config.js";

/**
 * Settings the owner can change while the service runs, without a release. Each one starts
 * from its `env` value; an admin override stored in the Directory object wins until it is
 * cleared again. Overrides are kept as JSON in the Directory's `settings` table under
 * `override:<name>`, and every change is logged with who made it and when.
 *
 *   GET  /admin/config   effective values, the env values, the overrides and the change log
 *   POST /admin/config   {name: value, ...}; `null` clears an override (back to env).
 *                        USD caps also take "none" (no cap at all).
 */

export const RUNTIME_SETTINGS = {
  /** Tokens per person per week. */
  weeklyTokens: { kind: "tokens", env: "WEEKLY_TOKENS" },
  /** USD per person per week (real reported cost). */
  perPersonWeeklyUsdCap: { kind: "usd", env: "PER_PERSON_WEEKLY_USD_CAP" },
  /** USD across everyone but admins, per week. */
  globalWeeklyUsdCap: { kind: "usd", env: "GLOBAL_WEEKLY_USD_CAP" },
  /** USD across everyone but admins, in total. */
  globalTotalUsdCap: { kind: "usd", env: "GLOBAL_TOTAL_USD_CAP" },
  /** Active non-admin people at most. */
  maxActiveUsers: { kind: "count", env: "MAX_ACTIVE_USERS" },
  /** Accounts old enough get in without an invite. */
  openAdmission: { kind: "flag", env: "OPEN_ADMISSION" },
} as const;

export type RuntimeKey = keyof typeof RUNTIME_SETTINGS;
type Kind = (typeof RUNTIME_SETTINGS)[RuntimeKey]["kind"];

/** A stored override: a number, a boolean, or null for "no cap" (USD caps only). */
export type OverrideValue = number | boolean | null;
export type Overrides = Partial<Record<RuntimeKey, OverrideValue>>;

/** One change: `value` undefined clears the override. */
export interface SettingChange {
  key: RuntimeKey;
  value: OverrideValue | undefined;
}

const MAX_TOKENS = 10_000_000_000;
const MAX_COUNT = 1_000_000;
const MAX_USD = 1_000_000;

export function isRuntimeKey(key: string): key is RuntimeKey {
  return Object.prototype.hasOwnProperty.call(RUNTIME_SETTINGS, key);
}

/** The value for `kind`, or "invalid". Accepts what the admin API takes. */
export function validateValue(kind: Kind, value: unknown): OverrideValue | "invalid" {
  switch (kind) {
    case "tokens":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOKENS ? value : "invalid";
    case "count":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT ? value : "invalid";
    case "usd":
      if (value === null || (typeof value === "string" && ["none", "off"].includes(value.toLowerCase()))) return null;
      return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_USD ? value : "invalid";
    case "flag":
      return typeof value === "boolean" ? value : "invalid";
  }
}

const RULES: Record<Kind, string> = {
  tokens: `a whole number of tokens, 0 to ${MAX_TOKENS}`,
  count: `a whole number, 0 to ${MAX_COUNT}`,
  usd: `a number of dollars, 0 to ${MAX_USD}, or "none" for no cap`,
  flag: "true or false",
};

/**
 * Parses an admin update body. `null` clears an override; anything else must be valid for its
 * setting. Unknown names are refused so a typo can't silently do nothing.
 */
export function parseSettingsUpdate(body: Record<string, unknown>): { changes: SettingChange[] } | { error: string } {
  const entries = Object.entries(body);
  if (entries.length === 0) return { error: `Send one or more of ${Object.keys(RUNTIME_SETTINGS).join(", ")}.` };
  const changes: SettingChange[] = [];
  for (const [key, raw] of entries) {
    if (!isRuntimeKey(key)) return { error: `"${key}" isn't a runtime setting. Use ${Object.keys(RUNTIME_SETTINGS).join(", ")}.` };
    if (raw === null) {
      changes.push({ key, value: undefined });
      continue;
    }
    const kind = RUNTIME_SETTINGS[key].kind;
    const value = validateValue(kind, raw);
    if (value === "invalid") return { error: `${key} must be ${RULES[kind]} (or null to go back to the env value).` };
    changes.push({ key, value });
  }
  return { changes };
}

/** Overrides read back from storage; anything that no longer validates is ignored. */
export function readOverrides(stored: Array<{ key: string; value: string }>): Overrides {
  const out: Overrides = {};
  for (const row of stored) {
    if (!row.key.startsWith("override:")) continue;
    const key = row.key.slice("override:".length);
    if (!isRuntimeKey(key)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      continue;
    }
    const value = validateValue(RUNTIME_SETTINGS[key].kind, parsed);
    if (value !== "invalid") out[key] = value;
  }
  return out;
}

/** The config with overrides applied. */
export function applyOverrides(config: FreeConfig, overrides: Overrides): FreeConfig {
  const next: FreeConfig = { ...config };
  for (const [key, value] of Object.entries(overrides) as Array<[RuntimeKey, OverrideValue]>) {
    switch (RUNTIME_SETTINGS[key].kind) {
      case "usd":
        (next as unknown as Record<string, unknown>)[key] = value === null ? undefined : value;
        break;
      default:
        (next as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return next;
}

/** The runtime settings of a config, as the admin API shows them (no secrets). */
export function settingsView(config: FreeConfig): Record<RuntimeKey, number | boolean | null> {
  const out = {} as Record<RuntimeKey, number | boolean | null>;
  for (const key of Object.keys(RUNTIME_SETTINGS) as RuntimeKey[]) {
    const value = (config as unknown as Record<string, unknown>)[key];
    out[key] = value === undefined ? null : (value as number | boolean);
  }
  return out;
}
