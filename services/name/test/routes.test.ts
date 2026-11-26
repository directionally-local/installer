import { registerHooks } from "node:module";
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { base64urlEncode, canonicalRequest, newNonce, sha256Hex } from "../../shared/src/auth.js";
import { isClaimable, newLease, release, revoke, type Lease } from "../src/lease.js";

/**
 * The HTTP surface against in-memory stand-ins for the Durable Objects: claim validation,
 * the public status view, the admin revoke and the client IP used for rate limits.
 */

const STUB = `data:text/javascript,${encodeURIComponent(`
export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
`)}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return { url: STUB, format: "module", shortCircuit: true };
    return next(specifier, context);
  },
});
const { default: worker, clientIp } = await import("../src/index.js");

const ZONE = "directionallylocal.run";
const ADMIN_TOKEN = "s3cret-admin-token";

interface Fakes {
  leases: Map<string, Lease>;
  buckets: string[];
  audit: Array<{ actor: string; action: string; subject: string }>;
}

function fakeEnv(vars: Record<string, string> = {}): { env: Record<string, unknown>; fakes: Fakes } {
  const fakes: Fakes = { leases: new Map(), buckets: [], audit: [] };
  const nonces = new Set<string>();
  const env = {
    ZONE,
    DNS_PROVIDER: "manual",
    ADMIN_TOKEN,
    ...vars,
    NAME_OBJECT: {
      getByName: (name: string) => ({
        claim: async (input: { name: string; ownerKey: string; dnsTarget: string; now: number }) => {
          const existing = fakes.leases.get(name);
          if (!isClaimable(existing, input.now)) return { ok: false, reason: "taken", lease: existing };
          const lease = newLease({ ...input, leaseDays: 30 });
          fakes.leases.set(name, lease);
          return { ok: true, lease };
        },
        status: async () => fakes.leases.get(name),
        release: async (now: number) => {
          const lease = release(fakes.leases.get(name)!, now, 30);
          fakes.leases.set(name, lease);
          return lease;
        },
        revoke: async (now: number) => {
          const lease = revoke(fakes.leases.get(name)!, now, 90);
          fakes.leases.set(name, lease);
          return lease;
        },
      }),
    },
    INDEX_OBJECT: { getByName: () => ({ upsert: async () => {} }) },
    RATE_LIMITER: {
      getByName: () => ({
        spend: async (key: string) => {
          fakes.buckets.push(key);
          return { allowed: true, retryAfterSeconds: 0 };
        },
        rememberNonce: async (nonce: string) => !nonces.has(nonce) && Boolean(nonces.add(nonce)),
      }),
    },
    AUDIT: {
      getByName: () => ({
        append: async (entry: { actor: string; action: string; subject: string }) => {
          fakes.audit.push(entry);
        },
      }),
    },
  };
  return { env, fakes };
}

async function keyPair(): Promise<{ keyId: string; sign: (message: string) => Promise<string> }> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    keyId: base64urlEncode(raw),
    sign: async (message) => base64urlEncode(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(message)))),
  };
}

type Key = Awaited<ReturnType<typeof keyPair>>;

async function signed(key: Key, method: string, path: string, body: string, headers: Record<string, string> = {}, skewSeconds = 0): Promise<Request> {
  const timestamp = Math.floor(Date.now() / 1000) + skewSeconds;
  const nonce = newNonce();
  const canonical = canonicalRequest({ method, path, query: "", timestamp, nonce, bodySha256: await sha256Hex(body) });
  const signature = await key.sign(canonical);
  return new Request(`https://names.${ZONE}${path}`, {
    method,
    headers: { authorization: `DL-Sig keyId=${key.keyId}, ts=${timestamp}, nonce=${nonce}, sig=${signature}`, ...headers },
    ...(method === "GET" || method === "HEAD" ? {} : { body }),
  });
}

async function claim(env: Record<string, unknown>, key: Key, name: string, dnsTarget: string, headers: Record<string, string> = {}): Promise<Response> {
  const body = JSON.stringify({ name, publicKey: key.keyId, dnsTarget });
  return worker.fetch(await signed(key, "POST", "/v1/names", body, headers), env as never);
}

function revokeRequest(name: string, authorization?: string): Request {
  return new Request(`https://names.${ZONE}/v1/admin/names/${name}/revoke`, {
    method: "POST",
    headers: authorization === undefined ? {} : { authorization },
  });
}

describe("claim", () => {
  let key: Key;
  beforeEach(async () => {
    key = await keyPair();
  });

  it("stores a normalized target and returns it to the owner", async () => {
    const { env, fakes } = fakeEnv();
    const response = await claim(env, key, "alice", "Alice.Example.TS.net.");
    assert.equal(response.status, 201);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.dnsTarget, "alice.example.ts.net");
    assert.equal(fakes.leases.get("alice")!.dnsTarget, "alice.example.ts.net");
  });

  it("accepts a Tailscale address", async () => {
    const { env } = fakeEnv();
    assert.equal((await claim(env, key, "alice", "100.101.102.103")).status, 201);
  });

  it("refuses a target inside the zone, a loopback address or junk", async () => {
    for (const target of [`bob.${ZONE}`, "127.0.0.1", "::1", "localhost", "http://evil.example.com/"]) {
      const { env, fakes } = fakeEnv();
      const response = await claim(env, key, "alice", target);
      assert.equal(response.status, 422, target);
      assert.match(await response.text(), /invalid-dns-target/);
      assert.equal(fakes.leases.size, 0);
    }
  });
});

describe("signatures", () => {
  it("accept a current timestamp and refuse one ten minutes off", async () => {
    const key = await keyPair();
    const body = JSON.stringify({ name: "alice", publicKey: key.keyId, dnsTarget: "alice.example.ts.net" });
    for (const skew of [-600, 600]) {
      const { env } = fakeEnv();
      const response = await worker.fetch(await signed(key, "POST", "/v1/names", body, {}, skew), env as never);
      assert.equal(response.status, 401, String(skew));
      assert.match(await response.text(), /clock-skew/);
    }
    const { env } = fakeEnv();
    assert.equal((await worker.fetch(await signed(key, "POST", "/v1/names", body, {}, 60), env as never)).status, 201);
  });

  it("let the owner release and see the cleared target", async () => {
    const key = await keyPair();
    const { env } = fakeEnv();
    await claim(env, key, "alice", "alice.example.ts.net");
    const response = await worker.fetch(await signed(key, "DELETE", "/v1/names/alice", ""), env as never);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.status, "released");
    assert.equal(body.dnsTarget, null);
  });
});

describe("public status", () => {
  it("leaves dnsTarget out", async () => {
    const { env } = fakeEnv();
    await claim(env, await keyPair(), "alice", "alice.example.ts.net");
    const response = await worker.fetch(new Request(`https://names.${ZONE}/v1/names/alice`), env as never);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.status, "active");
    assert.equal(body.fqdn, `alice.${ZONE}`);
    assert.equal("dnsTarget" in body, false);
  });
});

describe("admin revoke", () => {
  it("revokes with the admin token and audits it", async () => {
    const { env, fakes } = fakeEnv();
    await claim(env, await keyPair(), "alice", "alice.example.ts.net");
    const response = await worker.fetch(revokeRequest("alice", `Bearer ${ADMIN_TOKEN}`), env as never);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.status, "revoked");
    assert.equal(body.dnsTarget, null);
    assert.equal(fakes.leases.get("alice")!.status, "revoked");
    assert.ok(fakes.audit.some((entry) => entry.actor === "admin" && entry.action === "revoke" && entry.subject === "alice"));

    const again = await worker.fetch(revokeRequest("alice", `Bearer ${ADMIN_TOKEN}`), env as never);
    assert.equal(again.status, 409);
  });

  it("refuses a missing or wrong token", async () => {
    const { env, fakes } = fakeEnv();
    await claim(env, await keyPair(), "alice", "alice.example.ts.net");
    for (const authorization of [undefined, "", "Bearer", "Bearer wrong", `Bearer ${ADMIN_TOKEN}x`, `Basic ${ADMIN_TOKEN}`, ADMIN_TOKEN]) {
      const response = await worker.fetch(revokeRequest("alice", authorization), env as never);
      assert.equal(response.status, 401, String(authorization));
    }
    assert.equal(fakes.leases.get("alice")!.status, "active");
  });

  it("is a 404 for a name never claimed", async () => {
    const { env } = fakeEnv();
    const response = await worker.fetch(revokeRequest("nobody", `Bearer ${ADMIN_TOKEN}`), env as never);
    assert.equal(response.status, 404);
    assert.match(await response.text(), /name-not-found/);
  });

  it("doesn't exist without an ADMIN_TOKEN", async () => {
    const { env } = fakeEnv({ ADMIN_TOKEN: "" });
    await claim(env, await keyPair(), "alice", "alice.example.ts.net");
    const response = await worker.fetch(revokeRequest("alice", "Bearer "), env as never);
    assert.equal(response.status, 404);
    assert.match(await response.text(), /"not-found"|problems\/not-found/);
  });

  it("only answers POST", async () => {
    const { env } = fakeEnv();
    const response = await worker.fetch(new Request(`https://names.${ZONE}/v1/admin/names/alice/revoke`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }), env as never);
    assert.equal(response.status, 404);
  });
});

describe("client IP", () => {
  const request = (headers: Record<string, string>) => new Request("https://names.example/", { headers });

  it("prefers cf-connecting-ip", () => {
    assert.equal(clientIp(request({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1" }), { trustForwardedFor: true }), "203.0.113.7");
  });

  it("ignores x-forwarded-for unless TRUST_FORWARDED_FOR is set", () => {
    assert.equal(clientIp(request({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" }), { trustForwardedFor: false }), "unknown");
    assert.equal(clientIp(request({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" }), { trustForwardedFor: true }), "198.51.100.1");
  });

  it("feeds the claim rate limit", async () => {
    const forged = { "x-forwarded-for": "198.51.100.99" };
    const untrusted = fakeEnv();
    await claim(untrusted.env, await keyPair(), "alice", "alice.example.ts.net", forged);
    assert.ok(untrusted.fakes.buckets.includes("claim:ip:unknown"));
    assert.ok(!untrusted.fakes.buckets.some((bucket) => bucket.includes("198.51.100.99")));

    const trusted = fakeEnv({ TRUST_FORWARDED_FOR: "true" });
    await claim(trusted.env, await keyPair(), "alice", "alice.example.ts.net", forged);
    assert.ok(trusted.fakes.buckets.includes("claim:ip:198.51.100.99"));
  });
});
