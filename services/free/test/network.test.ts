import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { networkOf, rateLimitNetwork } from "../src/network.js";
import { createService, FakeState, startBrowserFlow, type Service } from "./harness.js";

describe("networkOf (units)", () => {
  it("keeps an IPv4 address as it is", () => {
    for (const ip of ["203.0.113.7", "0.0.0.0", "255.255.255.255", "10.1.2.3"]) assert.equal(networkOf(ip), ip);
    assert.equal(networkOf(" 203.0.113.7 "), "203.0.113.7");
  });

  it("maps IPv6 addresses to their /64", () => {
    assert.equal(networkOf("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64");
    assert.equal(networkOf("2001:db8:1:2:bbbb:cccc:dddd:eeee"), "2001:db8:1:2::/64");
    assert.equal(networkOf("2001:0db8:0001:0002:0000:0000:0000:0001"), "2001:db8:1:2::/64");
    assert.equal(networkOf("2001:DB8:1:2::FFFF"), "2001:db8:1:2::/64");
    assert.equal(networkOf("[2001:db8:1:2::1]"), "2001:db8:1:2::/64");
  });

  it("expands compressed forms before taking the prefix", () => {
    assert.equal(networkOf("2001:db8::1"), "2001:db8:0:0::/64");
    assert.equal(networkOf("2001:db8::"), "2001:db8:0:0::/64");
    assert.equal(networkOf("2001:db8::1:2:3:4"), "2001:db8:0:0::/64");
    assert.equal(networkOf("2001:db8:1::2:3:4"), "2001:db8:1:0::/64");
    assert.equal(networkOf("2001:db8:1:2:3::"), "2001:db8:1:2::/64");
    assert.equal(networkOf("::1"), "0:0:0:0::/64");
    assert.equal(networkOf("::"), "0:0:0:0::/64");
    assert.equal(networkOf("fe80::1"), "fe80:0:0:0::/64");
  });

  it("gives every address of one /64 the same network, and a neighbouring /64 another", () => {
    const one = ["2a01:4f8:c0c:1234::1", "2a01:4f8:c0c:1234:ffff:ffff:ffff:ffff", "2a01:04f8:0c0c:1234:0:0:0:abcd", "2a01:4f8:c0c:1234:1::"];
    assert.equal(new Set(one.map(networkOf)).size, 1);
    assert.notEqual(networkOf("2a01:4f8:c0c:1235::1"), networkOf("2a01:4f8:c0c:1234::1"));
  });

  it("maps IPv4-mapped IPv6 addresses to the IPv4 address", () => {
    assert.equal(networkOf("::ffff:1.2.3.4"), "1.2.3.4");
    assert.equal(networkOf("::FFFF:203.0.113.7"), "203.0.113.7");
    assert.equal(networkOf("0:0:0:0:0:ffff:1.2.3.4"), "1.2.3.4");
    assert.equal(networkOf("::ffff:102:304"), "1.2.3.4");
    assert.equal(networkOf("::ffff:cb00:7107"), "203.0.113.7");
    // Other IPv6 addresses with a dotted tail are IPv6.
    assert.equal(networkOf("64:ff9b::1.2.3.4"), "64:ff9b:0:0::/64");
  });

  it("refuses what isn't an address", () => {
    for (const bad of ["unknown", "", "   ", "1.2.3", "1.2.3.4.5", "256.1.1.1", "1.2.3.999", "2001:db8::1::2", "2001:db8:1:2:3:4:5:6:7", "2001:db8:1:2:3:4:5", ":2001:db8::1", "2001:db8:::1", "2001:db8::12345", "2001:db8::g", "::ffff:1.2.3.256", "fe80::1%eth0", "localhost"]) {
      assert.equal(networkOf(bad), undefined, bad);
    }
  });

  it("keys rate limits on the network, or on the raw value when it isn't an address", () => {
    assert.equal(rateLimitNetwork("203.0.113.7"), "203.0.113.7");
    assert.equal(rateLimitNetwork("2001:db8:1:2::99"), "2001:db8:1:2::/64");
    assert.equal(rateLimitNetwork("::ffff:203.0.113.7"), "203.0.113.7");
    assert.equal(rateLimitNetwork("unknown"), "unknown");
  });
});

describe("per-network limits", () => {
  const from = (service: Service, ip: string): Service["request"] => (method, path, options = {}) => service.request(method, path, { ...options, ip });

  async function signUp(service: Service, id: number, ip: string): Promise<{ status: number; page: string }> {
    return startBrowserFlow(from(service, ip), { id, login: `user${id}` });
  }

  it("counts sign-ups per IPv6 /64, so rotating addresses inside it doesn't help", async () => {
    const service = await createService({ OPEN_ADMISSION: "true" });
    for (const [i, ip] of ["2001:db8:1:2::1", "2001:db8:1:2::2", "2001:db8:1:2:ffff::3"].entries()) {
      assert.match((await signUp(service, 100 + i, ip)).page, /signed in/i);
    }
    // The fourth from the same /64 still gets in, as Starter.
    const fourth = await signUp(service, 103, "2001:db8:1:2:abcd:ef01:2345:6789");
    assert.equal(fourth.status, 200);
    assert.match(fourth.page, /signed in/i);
    // Another /64 is another network.
    assert.match((await signUp(service, 104, "2001:db8:1:3::1")).page, /signed in/i);
  });

  it("still counts each IPv4 address on its own, and an IPv4-mapped address as that IPv4 address", async () => {
    const service = await createService({ OPEN_ADMISSION: "true" });
    for (const [i, ip] of ["198.51.100.1", "::ffff:198.51.100.1", "198.51.100.1"].entries()) {
      assert.match((await signUp(service, 200 + i, ip)).page, /signed in/i);
    }
    assert.equal((await signUp(service, 203, "::ffff:c633:6401")).status, 200, "still gets in, as Starter");
    assert.match((await signUp(service, 204, "198.51.100.2")).page, /signed in/i);
  });

  it("rate-limits device codes per IPv6 /64", async () => {
    const service = await createService();
    const codes = async (ip: string) => (await service.request("POST", "/v1/device/code", { body: {}, ip })).status;
    for (let i = 0; i < 60; i++) assert.equal(await codes(`2001:db8:9:9::${(i + 1).toString(16)}`), 200);
    assert.equal(await codes("2001:db8:9:9:1234::1"), 429);
    assert.equal(await codes("2001:db8:9:a::1"), 200);
  });
});

describe("rate-limit keys", () => {
  it("never name or store the network, only a keyed hash of it", async () => {
    const service = await createService();
    assert.equal((await service.request("POST", "/v1/device/code", { body: {}, ip: "198.51.100.77" })).status, 200);
    assert.equal((await service.request("POST", "/v1/device/code", { body: {}, ip: "2001:db8:5:6::1" })).status, 200);
    const limiter = service.namespaces.RATE_LIMITER!;
    const names = [...limiter.instances.keys()];
    const rows = [...limiter.instances.values()].flatMap((entry) => entry.state.db.prepare("SELECT key FROM buckets").all() as Array<{ key: string }>).map((row) => row.key);
    assert.ok(names.some((name) => /^device:ip:h[0-9a-f]{32}$/.test(name)), names.join(", "));
    for (const value of [...names, ...rows]) assert.doesNotMatch(value, /198\.51\.100\.77|2001:db8:5:6/);
    // Another address in the same /64 is the same bucket.
    const deviceBuckets = () => [...limiter.instances.keys()].filter((name) => name.startsWith("device:ip:")).length;
    const before = deviceBuckets();
    assert.equal((await service.request("POST", "/v1/device/code", { body: {}, ip: "2001:db8:5:6::2" })).status, 200);
    assert.equal(deviceBuckets(), before);
  });
});

describe("RateLimiterObject pruning", () => {
  async function limiterWithState() {
    const { RateLimiterObject } = await import("../src/rate-limit-object.js");
    const state = new FakeState("test");
    const limiter = new RateLimiterObject(state as never, {} as never);
    const keys = () => (state.db.prepare("SELECT key FROM buckets ORDER BY key").all() as Array<{ key: string }>).map((row) => row.key);
    return { state, limiter, keys };
  }

  it("deletes a bucket's row once it has refilled, by the next spend or the alarm", async () => {
    const { state, limiter, keys } = await limiterWithState();
    const limit = { capacity: 2, perHour: 1 };
    const start = Date.now() - 10 * 3_600_000;
    await limiter.spend("a", limit, 1, start);
    assert.deepEqual(keys(), ["a"]);
    assert.equal(state.alarm, start + 3_600_000, "wakes when the bucket is full again");
    // Spending another key after "a" refilled drops "a".
    await limiter.spend("b", limit, 1, start + 2 * 3_600_000);
    assert.deepEqual(keys(), ["b"]);
    // The alarm drops what is full by now and stops once nothing is left.
    state.alarm = null;
    await limiter.alarm();
    assert.deepEqual(keys(), []);
    assert.equal(state.alarm, null);
    // A pruned bucket starts full again, as it would have been.
    assert.equal((await limiter.spend("a", limit, 2, start + 3 * 3_600_000)).allowed, true);
  });

  it("keeps an emptied bucket until it refills", async () => {
    const { state, limiter, keys } = await limiterWithState();
    const now = Date.now();
    await limiter.spend("a", { capacity: 1, perHour: 1 }, 1, now);
    await limiter.alarm();
    assert.deepEqual(keys(), ["a"]);
    assert.equal((await limiter.spend("a", { capacity: 1, perHour: 1 }, 1, now + 1000)).allowed, false);
    assert.ok(state.alarm !== null && state.alarm > now);
  });
});
