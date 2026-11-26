import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateDnsTarget } from "../src/targets.js";

const ZONE = "directionallylocal.run";
const ok = (input: string) => validateDnsTarget(input, ZONE);

describe("dnsTarget validation", () => {
  it("accepts tailnet and public hostnames, normalized", () => {
    assert.deepEqual(ok("alice.example.ts.net"), { ok: true, target: "alice.example.ts.net" });
    assert.deepEqual(ok(" Alice.Example.TS.net. "), { ok: true, target: "alice.example.ts.net" });
    assert.deepEqual(ok("server-1.example.com"), { ok: true, target: "server-1.example.com" });
  });

  it("accepts Tailscale, private and public addresses", () => {
    for (const address of ["100.101.102.103", "10.0.0.5", "192.168.1.20", "172.16.0.1", "203.0.113.7", "8.8.8.8"]) {
      assert.deepEqual(ok(address), { ok: true, target: address }, address);
    }
    assert.deepEqual(ok("FD7A:115C:A1E0:0:0:0:0:1"), { ok: true, target: "fd7a:115c:a1e0::1" });
    assert.deepEqual(ok("[2001:db8::1]"), { ok: true, target: "2001:db8::1" });
  });

  it("refuses loopback, unspecified, link-local, multicast and reserved addresses", () => {
    for (const address of ["127.0.0.1", "127.8.9.10", "0.0.0.0", "169.254.169.254", "224.0.0.1", "255.255.255.255", "240.0.0.1", "::1", "::", "fe80::1", "ff02::1", "::ffff:127.0.0.1"]) {
      assert.equal(ok(address).ok, false, address);
    }
  });

  it("refuses targets inside the service's own zone", () => {
    for (const target of ["directionallylocal.run", "bob.directionallylocal.run", "x.bob.DirectionallyLocal.run.", "names.directionallylocal.run"]) {
      assert.equal(ok(target).ok, false, target);
    }
    assert.equal(ok("notdirectionallylocal.run").ok, true);
  });

  it("refuses things that aren't a hostname or address", () => {
    for (const target of ["", "   ", "localhost", "app.localhost", "server", "a..b.com", "-a.example.com", "a-.example.com", "a_b.example.com", "http://evil.example.com", "evil.example.com/path", "evil.example.com:443", "1.2.3", "1.2.3.256", "01.2.3.4", "1.2.3.4.5", "example.123", "a b.example.com", "x".repeat(64) + ".example.com", "gggg::1", `${"a.".repeat(127)}com`]) {
      assert.equal(ok(target).ok, false, JSON.stringify(target));
    }
  });
});
