/**
 * DNS providers. The Worker never speaks DNS itself: RFC 2136 needs raw TCP, which means
 * the sockets API on Cloudflare and nothing at all on celld/native. A provider is an
 * HTTP API (or a human), reached with plain `fetch`.
 */

export interface DnsRecord {
  /** Fully qualified, no trailing dot. */
  name: string;
  type: "A" | "AAAA" | "CNAME" | "TXT";
  value: string;
  ttl: number;
}

export interface DnsProvider {
  readonly id: string;
  present(record: DnsRecord): Promise<void>;
  cleanup(record: DnsRecord): Promise<void>;
  list(zone: string): Promise<DnsRecord[]>;
}

export interface CloudflareDnsOptions {
  /** A zone-scoped token with Zone:DNS:Edit. */
  token: string;
  zoneId: string;
  fetch?: typeof fetch;
}

interface CloudflareRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
}

interface CloudflareEnvelope<T> {
  success: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: T;
}

/** The hosted provider: Cloudflare's DNS API, records DNS-only so TLS terminates at the server. */
export class CloudflareDnsProvider implements DnsProvider {
  readonly id = "cloudflare";
  readonly #token: string;
  readonly #zoneId: string;
  readonly #fetch: typeof fetch;

  constructor(options: CloudflareDnsOptions) {
    this.#token = options.token;
    this.#zoneId = options.zoneId;
    this.#fetch = options.fetch ?? fetch;
  }

  async present(record: DnsRecord): Promise<void> {
    const existing = await this.#find(record);
    if (existing) {
      if (existing.content === record.value && existing.ttl === record.ttl) return;
      await this.#call(`/dns_records/${existing.id}`, "PATCH", {
        type: record.type,
        name: record.name,
        content: record.value,
        ttl: record.ttl,
        proxied: false,
      });
      return;
    }
    await this.#call("/dns_records", "POST", {
      type: record.type,
      name: record.name,
      content: record.value,
      ttl: record.ttl,
      proxied: false,
    });
  }

  async cleanup(record: DnsRecord): Promise<void> {
    const existing = await this.#find(record);
    if (!existing) return;
    await this.#call(`/dns_records/${existing.id}`, "DELETE");
  }

  async list(zone: string): Promise<DnsRecord[]> {
    const result = await this.#call<CloudflareRecord[]>(`/dns_records?per_page=100&name=${encodeURIComponent(zone)}`, "GET");
    return (result ?? []).map((entry) => ({
      name: entry.name,
      type: entry.type as DnsRecord["type"],
      value: entry.content,
      ttl: entry.ttl,
    }));
  }

  async #find(record: DnsRecord): Promise<CloudflareRecord | undefined> {
    const query = `?type=${record.type}&name=${encodeURIComponent(record.name)}&per_page=1`;
    const result = await this.#call<CloudflareRecord[]>(`/dns_records${query}`, "GET");
    return result?.[0];
  }

  async #call<T>(path: string, method: string, body?: unknown): Promise<T | undefined> {
    const response = await this.#fetch(`https://api.cloudflare.com/client/v4/zones/${this.#zoneId}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const envelope = (await response.json()) as CloudflareEnvelope<T>;
    if (!response.ok || !envelope.success) {
      const detail = envelope.errors?.map((error) => error.message ?? String(error.code)).join("; ") || `HTTP ${response.status}`;
      throw new Error(`Cloudflare DNS ${method} ${path} failed: ${detail}`);
    }
    return envelope.result;
  }
}

/**
 * The escape hatch for a self-hosted node with no DNS API: it records what should exist and
 * hands it to the operator. The challenge stays pending until the record shows up.
 */
export class ManualDnsProvider implements DnsProvider {
  readonly id = "manual";
  readonly #records = new Map<string, DnsRecord>();

  async present(record: DnsRecord): Promise<void> {
    this.#records.set(`${record.type} ${record.name}`, record);
  }

  async cleanup(record: DnsRecord): Promise<void> {
    this.#records.delete(`${record.type} ${record.name}`);
  }

  async list(): Promise<DnsRecord[]> {
    return [...this.#records.values()];
  }

  /** What the operator has to publish by hand. */
  pending(): DnsRecord[] {
    return [...this.#records.values()];
  }
}
