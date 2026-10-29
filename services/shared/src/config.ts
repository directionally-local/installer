/**
 * Configuration comes from `env` only: the process environment doesn't exist on
 * Cloudflare, and celld has no secret bindings. Parsed once per request, with a clear error
 * for a missing value.
 */

export type DnsProviderId = "cloudflare" | "manual";

export interface NameServiceConfig {
  /** The zone the service owns, e.g. `directionallylocal.run`. */
  zone: string;
  dnsProvider: DnsProviderId;
  /** Cloudflare DNS API token; required when `dnsProvider` is `cloudflare`. */
  cfDnsApiToken?: string;
  cfZoneId?: string;
  /** Bearer token for the admin endpoints. */
  adminToken?: string;
  leaseDays: number;
  graceDays: number;
  quarantineDays: number;
}

export class ConfigError extends Error {}

const DEFAULTS = { leaseDays: 30, graceDays: 7, quarantineDays: 30 } as const;

/** Reads and validates the name service's `env`. Throws `ConfigError` with what's missing. */
export function readNameServiceConfig(env: Record<string, unknown>): NameServiceConfig {
  const zone = text(env.ZONE);
  if (!zone) throw new ConfigError("ZONE is required (the zone this service owns, e.g. directionallylocal.run).");

  const provider = text(env.DNS_PROVIDER) ?? "cloudflare";
  if (provider !== "cloudflare" && provider !== "manual") {
    throw new ConfigError(`DNS_PROVIDER must be cloudflare or manual (got "${provider}").`);
  }

  const cfDnsApiToken = text(env.CF_DNS_API_TOKEN);
  const cfZoneId = text(env.CF_ZONE_ID);
  if (provider === "cloudflare" && (!cfDnsApiToken || !cfZoneId)) {
    throw new ConfigError("CF_DNS_API_TOKEN and CF_ZONE_ID are required when DNS_PROVIDER is cloudflare.");
  }

  return {
    zone,
    dnsProvider: provider,
    ...(cfDnsApiToken ? { cfDnsApiToken } : {}),
    ...(cfZoneId ? { cfZoneId } : {}),
    ...(text(env.ADMIN_TOKEN) ? { adminToken: text(env.ADMIN_TOKEN) } : {}),
    leaseDays: days(env.LEASE_DAYS, DEFAULTS.leaseDays, "LEASE_DAYS"),
    graceDays: days(env.GRACE_DAYS, DEFAULTS.graceDays, "GRACE_DAYS"),
    quarantineDays: days(env.QUARANTINE_DAYS, DEFAULTS.quarantineDays, "QUARANTINE_DAYS"),
  };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function days(value: unknown, fallback: number, name: string): number {
  const raw = text(value);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new ConfigError(`${name} must be a whole number of days (got "${raw}").`);
  return parsed;
}
