import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { freshBucket, refill, take, type Limit } from "../src/rate-limit.js";

const LIMIT: Limit = { capacity: 5, perHour: 5 };
const HOUR = 3_600_000;

describe("token buckets", () => {
  it("starts full", () => {
    assert.deepEqual(freshBucket(LIMIT, 1_000), { tokens: 5, updatedAt: 1_000 });
  });

  it("refills at the hourly rate and never above capacity", () => {
    assert.equal(refill({ tokens: 0, updatedAt: 0 }, HOUR, LIMIT).tokens, 5);
    assert.equal(refill({ tokens: 0, updatedAt: 0 }, HOUR * 10, LIMIT).tokens, 5);
    assert.equal(refill({ tokens: 0, updatedAt: 0 }, HOUR / 2, LIMIT).tokens, 2.5);
  });

  it("does not refill backwards in time", () => {
    assert.equal(refill({ tokens: 1, updatedAt: 10_000 }, 5_000, LIMIT).tokens, 1);
  });

  it("spends a token when one is available", () => {
    const result = take(freshBucket(LIMIT, 0), 0, LIMIT);
    assert.equal(result.allowed, true);
    assert.equal(result.bucket.tokens, 4);
    assert.equal(result.retryAfterSeconds, 0);
  });

  it("refuses when empty and says how long to wait", () => {
    const result = take({ tokens: 0, updatedAt: 0 }, 0, LIMIT);
    assert.equal(result.allowed, false);
    assert.equal(result.retryAfterSeconds, 720);
  });

  it("waits proportionally for a partial token", () => {
    const result = take({ tokens: 0.5, updatedAt: 0 }, 0, LIMIT);
    assert.equal(result.allowed, false);
    assert.equal(result.retryAfterSeconds, 360);
  });

  it("allows again once enough time has passed", () => {
    const spent = take(freshBucket(LIMIT, 0), 0, LIMIT);
    const later = take(spent.bucket, HOUR, LIMIT);
    assert.equal(later.allowed, true);
  });

  it("supports a cost above one", () => {
    assert.equal(take(freshBucket(LIMIT, 0), 0, LIMIT, 5).allowed, true);
    assert.equal(take(freshBucket(LIMIT, 0), 0, LIMIT, 6).allowed, false);
  });
});
