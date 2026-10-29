/**
 * Token-bucket arithmetic, shared by the Durable Objects that enforce limits. Pure
 * functions over a plain record, so the maths is testable without a Durable Object.
 */

export interface Bucket {
  tokens: number;
  /** Unix milliseconds of the last refill. */
  updatedAt: number;
}

export interface Limit {
  /** The most tokens a bucket holds. */
  capacity: number;
  /** Tokens added per hour. */
  perHour: number;
}

export function freshBucket(limit: Limit, now: number): Bucket {
  return { tokens: limit.capacity, updatedAt: now };
}

/** A bucket brought up to `now`, never above capacity. */
export function refill(bucket: Bucket, now: number, limit: Limit): Bucket {
  const elapsedHours = Math.max(0, now - bucket.updatedAt) / 3_600_000;
  return { tokens: Math.min(limit.capacity, bucket.tokens + elapsedHours * limit.perHour), updatedAt: now };
}

export interface TakeResult {
  allowed: boolean;
  bucket: Bucket;
  /** Seconds until the request would succeed; 0 when it did. */
  retryAfterSeconds: number;
}

/** Spends `cost` tokens if the bucket has them. A refusal leaves the bucket refilled, not spent. */
export function take(bucket: Bucket, now: number, limit: Limit, cost = 1): TakeResult {
  const refilled = refill(bucket, now, limit);
  if (refilled.tokens >= cost) {
    return { allowed: true, bucket: { tokens: refilled.tokens - cost, updatedAt: now }, retryAfterSeconds: 0 };
  }
  const missing = cost - refilled.tokens;
  const retryAfterSeconds = limit.perHour > 0 ? Math.max(1, Math.ceil((missing / limit.perHour) * 3600)) : 3600;
  return { allowed: false, bucket: refilled, retryAfterSeconds };
}
