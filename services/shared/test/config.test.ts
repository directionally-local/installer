import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, readNameServiceConfig } from "../src/config.js";

describe("name service config", () => {
  it("reads the required values and defaults the rest", () => {
    const config = readNameServiceConfig({ ZONE: "directionallylocal.run", CF_DNS_API_TOKEN: "t", CF_ZONE_ID: "z" });
    assert.equal(config.zone, "directionallylocal.run");
    assert.equal(config.dnsProvider, "cloudflare");
    assert.equal(config.leaseDays, 30);
    assert.equal(config.graceDays, 7);
    assert.equal(config.quarantineDays, 30);
  });

  it("requires a zone", () => {
    assert.throws(() => readNameServiceConfig({}), ConfigError);
  });

  it("requires Cloudflare credentials only for the Cloudflare provider", () => {
    assert.throws(() => readNameServiceConfig({ ZONE: "z.example" }), /CF_DNS_API_TOKEN/);
    const manual = readNameServiceConfig({ ZONE: "z.example", DNS_PROVIDER: "manual" });
    assert.equal(manual.dnsProvider, "manual");
    assert.equal(manual.cfDnsApiToken, undefined);
  });

  it("rejects an unknown provider", () => {
    assert.throws(() => readNameServiceConfig({ ZONE: "z.example", DNS_PROVIDER: "route53" }), /cloudflare or manual/);
  });

  it("parses day counts and rejects nonsense", () => {
    const config = readNameServiceConfig({ ZONE: "z.example", DNS_PROVIDER: "manual", LEASE_DAYS: "14" });
    assert.equal(config.leaseDays, 14);
    assert.throws(() => readNameServiceConfig({ ZONE: "z.example", DNS_PROVIDER: "manual", LEASE_DAYS: "-1" }), /LEASE_DAYS/);
    assert.throws(() => readNameServiceConfig({ ZONE: "z.example", DNS_PROVIDER: "manual", GRACE_DAYS: "soon" }), /GRACE_DAYS/);
  });

  it("keeps the admin token optional", () => {
    assert.equal(readNameServiceConfig({ ZONE: "z.example", DNS_PROVIDER: "manual" }).adminToken, undefined);
    assert.equal(readNameServiceConfig({ ZONE: "z.example", DNS_PROVIDER: "manual", ADMIN_TOKEN: "a" }).adminToken, "a");
  });
});
