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
  /**
   * Whether to take the client IP from `x-forwarded-for` when `cf-connecting-ip` is absent.
   * Off unless `TRUST_FORWARDED_FOR` is `true`: set it only when a proxy you run sits in
   * front of the service and overwrites the header, or every client can choose its own IP.
   */
  trustForwardedFor: boolean;
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
    trustForwardedFor: flag(env.TRUST_FORWARDED_FOR, "TRUST_FORWARDED_FOR"),
  };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function flag(value: unknown, name: string): boolean {
  const raw = text(value)?.toLowerCase();
  if (raw === undefined || raw === "false" || raw === "0") return false;
  if (raw === "true" || raw === "1") return true;
  throw new ConfigError(`${name} must be true or false (got "${raw}").`);
}

function days(value: unknown, fallback: number, name: string): number {
  const raw = text(value);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new ConfigError(`${name} must be a whole number of days (got "${raw}").`);
  return parsed;
}
