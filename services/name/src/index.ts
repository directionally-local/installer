import type { DurableObjectNamespace } from "cloudflare:workers";
import { canonicalRequest, parseAuthorization, sha256Hex, verifyEd25519, withinClockSkew } from "../../shared/src/auth.js";
import { ConfigError, readNameServiceConfig, type NameServiceConfig } from "../../shared/src/config.js";
import { json, problem } from "../../shared/src/problem.js";
import { auditDayKey, type AuditObject } from "./audit-object.js";
import type { IndexObject } from "./index-object.js";
import { canRenew, type Lease } from "./lease.js";
import type { NameObject } from "./name-object.js";
import { fqdn, shardOf, validateName } from "./names.js";
import type { RateLimiterObject } from "./rate-limit-object.js";

/**
 * The name service's HTTP surface. Phase 1a: health, claim, status, renew, release. DNS-01
 * and the admin API come in 1b and 1c.
 */

export const VERSION = "0.1.0";

export interface Env {
  ZONE: string;
  DNS_PROVIDER?: string;
  CF_DNS_API_TOKEN?: string;
  CF_ZONE_ID?: string;
  ADMIN_TOKEN?: string;
  LEASE_DAYS?: string;
  GRACE_DAYS?: string;
  QUARANTINE_DAYS?: string;
  NAME_OBJECT: DurableObjectNamespace<NameObject>;
  INDEX_OBJECT: DurableObjectNamespace<IndexObject>;
  RATE_LIMITER: DurableObjectNamespace<RateLimiterObject>;
  AUDIT: DurableObjectNamespace<AuditObject>;
}

const CLAIM_LIMIT = { capacity: 5, perHour: 5 };
const NONCE_TTL_MS = 10 * 60 * 1000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const now = Date.now();
    let config: NameServiceConfig;
    try {
      config = readNameServiceConfig(env as unknown as Record<string, unknown>);
    } catch (error) {
      if (error instanceof ConfigError) return problem(500, "misconfigured", "Service misconfigured", error.message);
      throw error;
    }
    return route(request, new URL(request.url), env, config, now);
  },
};

async function route(request: Request, url: URL, env: Env, config: NameServiceConfig, now: number): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/health") return json({ ok: true, service: "name", version: VERSION });
  if (!path.startsWith("/v1/")) return notFound(request, url);

  const rest = path.slice("/v1/".length);
  if (rest === "names" && request.method === "POST") return claim(request, env, config, now);

  const match = /^names\/([a-z0-9-]+)(\/renew)?$/.exec(rest);
  if (match) {
    const name = match[1]!;
    if (match[2] !== undefined) {
      if (request.method === "POST") return renewName(request, env, config, name, now);
    } else if (request.method === "GET") {
      return getName(env, config, name, now);
    } else if (request.method === "DELETE") {
      return releaseName(request, env, config, name, now);
    }
  }
  return notFound(request, url);
}

function notFound(request: Request, url: URL): Response {
  return problem(404, "not-found", "Not found", `${request.method} ${url.pathname} isn't a route.`);
}

async function claim(request: Request, env: Env, config: NameServiceConfig, now: number): Promise<Response> {
  const body = await request.text();
  let input: { name?: unknown; publicKey?: unknown; dnsTarget?: unknown };
  try {
    input = JSON.parse(body) as typeof input;
  } catch {
    return problem(400, "invalid-json", "Invalid JSON", "The body must be one JSON object.");
  }
  if (typeof input.name !== "string" || typeof input.publicKey !== "string" || typeof input.dnsTarget !== "string") {
    return problem(400, "invalid-body", "Invalid body", "Expected {name, publicKey, dnsTarget} as strings.");
  }
  const checked = validateName(input.name);
  if (!checked.ok) return problem(422, "invalid-name", "Invalid name", checked.reason);

  const denied = await verifySignature(request, body, input.publicKey, env, now);
  if (denied) return denied;

  const limited = await spend(env, `claim:key:${input.publicKey}`, CLAIM_LIMIT, now)
    ?? await spend(env, `claim:ip:${clientIp(request)}`, CLAIM_LIMIT, now);
  if (limited) return limited;

  const object = env.NAME_OBJECT.getByName(checked.name);
  const result = await object.claim({ name: checked.name, ownerKey: input.publicKey, dnsTarget: input.dnsTarget, now });
  if (!result.ok) {
    const taken = result.reason === "taken";
    return problem(
      409,
      taken ? "name-taken" : "name-quarantined",
      taken ? "Name taken" : "Name quarantined",
      taken
        ? `${checked.name} is leased until ${new Date(result.lease.leaseExpiresAt).toISOString()}.`
        : `${checked.name} was released and can't be claimed until ${new Date(result.lease.quarantineUntil ?? now).toISOString()}.`,
    );
  }

  await updateIndex(env, result.lease);
  await audit(env, now, input.publicKey, "claim", checked.name, result.lease.dnsTarget ?? "");
  return json(leaseView(result.lease, config.zone), 201);
}

async function getName(env: Env, config: NameServiceConfig, name: string, now: number): Promise<Response> {
  const lease = await env.NAME_OBJECT.getByName(name).status(now);
  if (!lease) return problem(404, "name-not-found", "Name not found", `${name} has never been claimed.`);
  return json(leaseView(lease, config.zone));
}

async function renewName(request: Request, env: Env, config: NameServiceConfig, name: string, now: number): Promise<Response> {
  const object = env.NAME_OBJECT.getByName(name);
  const lease = await object.status(now);
  if (!lease) return problem(404, "name-not-found", "Name not found", `${name} has never been claimed.`);

  const denied = await verifySignature(request, await request.text(), lease.ownerKey, env, now);
  if (denied) return denied;
  if (!canRenew(lease)) return problem(409, "not-renewable", "Not renewable", `${name} is ${lease.status}.`);

  const renewed = await object.renew(now);
  await updateIndex(env, renewed);
  await audit(env, now, lease.ownerKey, "renew", name, renewed.status);
  return json(leaseView(renewed, config.zone));
}

async function releaseName(request: Request, env: Env, config: NameServiceConfig, name: string, now: number): Promise<Response> {
  const object = env.NAME_OBJECT.getByName(name);
  const lease = await object.status(now);
  if (!lease) return problem(404, "name-not-found", "Name not found", `${name} has never been claimed.`);

  const denied = await verifySignature(request, await request.text(), lease.ownerKey, env, now);
  if (denied) return denied;

  const released = await object.release(now);
  await updateIndex(env, released);
  await audit(env, now, lease.ownerKey, "release", name, released.status);
  return json(leaseView(released, config.zone));
}

/**
 * Checks the `DL-Sig` header against `publicKey` and the request as sent. Returns a problem
 * response when it doesn't hold, or undefined when it does.
 */
async function verifySignature(request: Request, body: string, publicKey: string, env: Env, now: number): Promise<Response | undefined> {
  const signed = parseAuthorization(request.headers.get("authorization"));
  if (!signed) {
    return problem(401, "signature-required", "Signature required", "Send Authorization: DL-Sig keyId=…, ts=…, nonce=…, sig=…");
  }
  if (signed.keyId !== publicKey) {
    return problem(403, "wrong-key", "Wrong key", "This name belongs to a different server key.");
  }
  if (!withinClockSkew(signed.timestamp, now)) {
    return problem(401, "clock-skew", "Timestamp out of range", "The request's ts is more than five minutes from this server's clock.");
  }
  const url = new URL(request.url);
  const canonical = canonicalRequest({
    method: request.method,
    path: url.pathname,
    query: url.search.slice(1),
    timestamp: signed.timestamp,
    nonce: signed.nonce,
    bodySha256: await sha256Hex(body),
  });
  if (!(await verifyEd25519(publicKey, signed.signature, canonical))) {
    return problem(401, "bad-signature", "Bad signature", "The signature doesn't match this request.");
  }
  const fresh = await env.RATE_LIMITER.getByName(`nonce:${publicKey}`).rememberNonce(signed.nonce, now + NONCE_TTL_MS);
  if (!fresh) return problem(409, "replay", "Replayed request", "That nonce was already used.");
  return undefined;
}

async function spend(env: Env, key: string, limit: { capacity: number; perHour: number }, now: number): Promise<Response | undefined> {
  const outcome = await env.RATE_LIMITER.getByName(key).spend(key, limit, 1, now);
  if (outcome.allowed) return undefined;
  return problem(429, "rate-limited", "Too many requests", `Try again in ${outcome.retryAfterSeconds} seconds.`, {
    "retry-after": String(outcome.retryAfterSeconds),
  });
}

async function updateIndex(env: Env, lease: Lease): Promise<void> {
  await env.INDEX_OBJECT.getByName(`index-${shardOf(lease.name)}`).upsert({
    name: lease.name,
    status: lease.status,
    ownerKey: lease.ownerKey,
    updatedAt: lease.updatedAt,
  });
}

async function audit(env: Env, now: number, actor: string, action: string, subject: string, detail: string): Promise<void> {
  await env.AUDIT.getByName(auditDayKey(now)).append({ at: now, actor, action, subject, detail });
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "unknown";
}

/** The wire shape of a lease: ISO timestamps, and the zone filled in. */
export function leaseView(lease: Lease, zone: string): Record<string, unknown> {
  return {
    name: lease.name,
    fqdn: fqdn(lease.name, zone),
    status: lease.status,
    dnsTarget: lease.dnsTarget,
    leaseExpiresAt: new Date(lease.leaseExpiresAt).toISOString(),
    ...(lease.graceExpiresAt === null ? {} : { graceExpiresAt: new Date(lease.graceExpiresAt).toISOString() }),
    ...(lease.quarantineUntil === null ? {} : { quarantineUntil: new Date(lease.quarantineUntil).toISOString() }),
  };
}
