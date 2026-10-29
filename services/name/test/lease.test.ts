import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canRenew,
  DAY_MS,
  expire,
  isClaimable,
  newLease,
  nextAlarm,
  release,
  renew,
  revoke,
  shouldDelete,
  type Lease,
} from "../src/lease.js";

const NOW = 1_700_000_000_000;

function lease(overrides: Partial<Lease> = {}): Lease {
  return { ...newLease({ name: "alice", ownerKey: "key", dnsTarget: "alice.example.ts.net", now: NOW, leaseDays: 30 }), ...overrides };
}

describe("claiming", () => {
  it("starts active for the lease period", () => {
    const claimed = lease();
    assert.equal(claimed.status, "active");
    assert.equal(claimed.leaseExpiresAt, NOW + 30 * DAY_MS);
    assert.equal(claimed.graceExpiresAt, null);
    assert.equal(claimed.quarantineUntil, null);
  });

  it("is claimable when never claimed", () => {
    assert.equal(isClaimable(undefined, NOW), true);
  });

  it("is not claimable while active or in grace", () => {
    assert.equal(isClaimable(lease(), NOW), false);
    assert.equal(isClaimable(lease({ status: "grace" }), NOW), false);
  });

  it("is claimable again only after quarantine", () => {
    const released = release(lease(), NOW, 30);
    assert.equal(isClaimable(released, NOW + DAY_MS), false);
    assert.equal(isClaimable(released, NOW + 30 * DAY_MS), true);
  });
});

describe("expiry", () => {
  it("moves active to grace at the lease expiry", () => {
    const expired = expire(lease(), NOW + 30 * DAY_MS, 7, 30);
    assert.equal(expired.status, "grace");
    assert.equal(expired.graceExpiresAt, NOW + 37 * DAY_MS);
    assert.equal(expired.dnsTarget, "alice.example.ts.net");
  });

  it("moves grace to released at the grace expiry, dropping DNS", () => {
    const inGrace = expire(lease(), NOW + 30 * DAY_MS, 7, 30);
    const released = expire(inGrace, NOW + 37 * DAY_MS, 7, 30);
    assert.equal(released.status, "released");
    assert.equal(released.dnsTarget, null);
    assert.equal(released.quarantineUntil, NOW + 67 * DAY_MS);
  });

  it("skips straight to released when the grace period has already passed", () => {
    const released = expire(lease(), NOW + 40 * DAY_MS, 7, 30);
    assert.equal(released.status, "released");
    assert.equal(released.quarantineUntil, NOW + 67 * DAY_MS);
  });

  it("returns the same object when nothing changed", () => {
    const active = lease();
    assert.equal(expire(active, NOW + DAY_MS, 7, 30), active);
  });

  it("leaves released and revoked leases alone", () => {
    const released = release(lease(), NOW, 30);
    assert.equal(expire(released, NOW + 100 * DAY_MS, 7, 30), released);
  });
});

describe("renewal", () => {
  it("extends an active lease", () => {
    const renewed = renew(lease(), NOW + 10 * DAY_MS, 30);
    assert.equal(renewed.status, "active");
    assert.equal(renewed.leaseExpiresAt, NOW + 40 * DAY_MS);
  });

  it("brings a lease in grace back to active", () => {
    const inGrace = expire(lease(), NOW + 30 * DAY_MS, 7, 30);
    const renewed = renew(inGrace, NOW + 31 * DAY_MS, 30);
    assert.equal(renewed.status, "active");
    assert.equal(renewed.graceExpiresAt, null);
  });

  it("refuses a released or revoked name", () => {
    assert.equal(canRenew(release(lease(), NOW, 30)), false);
    assert.throws(() => renew(release(lease(), NOW, 30), NOW, 30), /can't be renewed/);
    assert.throws(() => renew(revoke(lease(), NOW, 90), NOW, 30), /can't be renewed/);
  });
});

describe("release and revoke", () => {
  it("release drops DNS and quarantines for the given period", () => {
    const released = release(lease(), NOW, 30);
    assert.equal(released.status, "released");
    assert.equal(released.dnsTarget, null);
    assert.equal(released.quarantineUntil, NOW + 30 * DAY_MS);
  });

  it("revoke quarantines for 90 days", () => {
    const revoked = revoke(lease(), NOW, 90);
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.quarantineUntil, NOW + 90 * DAY_MS);
  });
});

describe("alarms", () => {
  it("schedules the next transition", () => {
    assert.equal(nextAlarm(lease()), NOW + 30 * DAY_MS);
    assert.equal(nextAlarm(expire(lease(), NOW + 30 * DAY_MS, 7, 30)), NOW + 37 * DAY_MS);
    assert.equal(nextAlarm(release(lease(), NOW, 30)), NOW + 30 * DAY_MS);
  });

  it("deletes a quarantined name once its time is up", () => {
    const released = release(lease(), NOW, 30);
    assert.equal(shouldDelete(released, NOW + 29 * DAY_MS), false);
    assert.equal(shouldDelete(released, NOW + 30 * DAY_MS), true);
    assert.equal(shouldDelete(lease(), NOW + 365 * DAY_MS), false);
  });
});
