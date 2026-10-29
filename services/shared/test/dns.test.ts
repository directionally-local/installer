import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CloudflareDnsProvider, ManualDnsProvider, type DnsRecord } from "../src/dns.js";

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

function fakeFetch(existing: Array<{ id: string; name: string; type: string; content: string; ttl: number }> = []) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (method === "GET") return new Response(JSON.stringify({ success: true, result: existing }), { status: 200 });
    if (method === "DELETE") return new Response(JSON.stringify({ success: true, result: { id: "1" } }), { status: 200 });
    return new Response(JSON.stringify({ success: true, result: { id: "new" } }), { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

const TXT: DnsRecord = { name: "_acme-challenge.alice.directionallylocal.run", type: "TXT", value: "token.thumb", ttl: 600 };

describe("CloudflareDnsProvider", () => {
  it("creates a record that doesn't exist, DNS-only", async () => {
    const { impl, calls } = fakeFetch();
    await new CloudflareDnsProvider({ token: "t", zoneId: "z", fetch: impl }).present(TXT);
    const post = calls.find((call) => call.method === "POST");
    assert.ok(post, "expected a POST");
    assert.match(post.url, /\/zones\/z\/dns_records$/);
    assert.deepEqual(post.body, { type: "TXT", name: TXT.name, content: TXT.value, ttl: 600, proxied: false });
  });

  it("patches a record whose value changed", async () => {
    const { impl, calls } = fakeFetch([{ id: "1", name: TXT.name, type: "TXT", content: "old", ttl: 600 }]);
    await new CloudflareDnsProvider({ token: "t", zoneId: "z", fetch: impl }).present(TXT);
    const patch = calls.find((call) => call.method === "PATCH");
    assert.ok(patch, "expected a PATCH");
    assert.match(patch.url, /\/dns_records\/1$/);
  });

  it("does nothing when the record already matches", async () => {
    const { impl, calls } = fakeFetch([{ id: "1", name: TXT.name, type: "TXT", content: TXT.value, ttl: 600 }]);
    await new CloudflareDnsProvider({ token: "t", zoneId: "z", fetch: impl }).present(TXT);
    assert.equal(calls.filter((call) => call.method !== "GET").length, 0);
  });

  it("deletes the record on cleanup, and tolerates a missing one", async () => {
    const { impl, calls } = fakeFetch([{ id: "1", name: TXT.name, type: "TXT", content: TXT.value, ttl: 600 }]);
    const provider = new CloudflareDnsProvider({ token: "t", zoneId: "z", fetch: impl });
    await provider.cleanup(TXT);
    assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);

    const empty = fakeFetch();
    await new CloudflareDnsProvider({ token: "t", zoneId: "z", fetch: empty.impl }).cleanup(TXT);
    assert.equal(empty.calls.filter((call) => call.method === "DELETE").length, 0);
  });

  it("surfaces Cloudflare's error message", async () => {
    const failing = (async () => new Response(JSON.stringify({ success: false, errors: [{ message: "bad token" }] }), { status: 403 })) as typeof fetch;
    await assert.rejects(
      () => new CloudflareDnsProvider({ token: "t", zoneId: "z", fetch: failing }).present(TXT),
      /bad token/,
    );
  });
});

describe("ManualDnsProvider", () => {
  it("records what the operator has to publish", async () => {
    const provider = new ManualDnsProvider();
    await provider.present(TXT);
    assert.deepEqual(provider.pending(), [TXT]);
    await provider.cleanup(TXT);
    assert.deepEqual(provider.pending(), []);
  });
});
