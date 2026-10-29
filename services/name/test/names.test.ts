import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fqdn, RESERVED_NAMES, shardOf, validateName } from "../src/names.js";

describe("name validation", () => {
  it("accepts ordinary labels", () => {
    for (const name of ["alice", "alice-2", "a1b", "my-server-01"]) {
      assert.deepEqual(validateName(name), { ok: true, name }, name);
    }
  });

  it("lowercases and trims", () => {
    assert.deepEqual(validateName("  Alice  "), { ok: true, name: "alice" });
  });

  it("rejects names that are too short or too long", () => {
    assert.equal(validateName("ab").ok, false);
    assert.equal(validateName("a".repeat(64)).ok, false);
    assert.equal(validateName("a".repeat(63)).ok, true);
  });

  it("rejects characters DNS labels don't allow", () => {
    for (const name of ["alice_b", "alice.b", "alice b", "älice", "alice!"]) {
      assert.equal(validateName(name).ok, false, name);
    }
  });

  it("rejects leading and trailing hyphens", () => {
    assert.equal(validateName("-alice").ok, false);
    assert.equal(validateName("alice-").ok, false);
  });

  it("rejects punycode-shaped names", () => {
    assert.equal(validateName("ab--cd").ok, false);
    assert.equal(validateName("ab-cd").ok, true);
  });

  it("rejects reserved names", () => {
    for (const name of ["www", "api", "names", "approvals", "admin", "mail", "ns1", "install"]) {
      assert.equal(validateName(name).ok, false, name);
      assert.ok(RESERVED_NAMES.has(name));
    }
  });

  it("explains why a name was refused", () => {
    const result = validateName("www");
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /reserved/);
  });
});

describe("fqdn", () => {
  it("joins the label and the zone", () => {
    assert.equal(fqdn("alice", "directionallylocal.run"), "alice.directionallylocal.run");
  });
});

describe("index shards", () => {
  it("is stable for a name", () => {
    assert.equal(shardOf("alice"), shardOf("alice"));
  });

  it("stays within the shard count", () => {
    for (const name of ["alice", "bob", "carol", "dave", "erin", "frank"]) {
      const shard = shardOf(name);
      assert.ok(shard >= 0 && shard < 16, `${name} → ${shard}`);
    }
  });

  it("spreads names across shards", () => {
    const shards = new Set(Array.from({ length: 200 }, (_, index) => shardOf(`server-${index}`)));
    assert.ok(shards.size > 8, `only ${shards.size} shards used`);
  });
});
