import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import { freshBucket, take, type Bucket, type Limit } from "../../shared/src/rate-limit.js";

/** Token buckets, one object per bucket key, so a limit holds at a single point on every target. */

interface BucketRow {
  tokens: number;
  updated_at: number;
}

export interface TakeOutcome {
  allowed: boolean;
  retryAfterSeconds: number;
}

export class RateLimiterObject extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS buckets (
           key        TEXT PRIMARY KEY,
           tokens     REAL NOT NULL,
           updated_at INTEGER NOT NULL
         )`,
      );
    });
  }

  /** Spends `cost` from `key`'s bucket, creating it full on first use. */
  async spend(key: string, limit: Limit, cost: number, now: number): Promise<TakeOutcome> {
    const row = this.ctx.storage.sql.exec<BucketRow>("SELECT tokens, updated_at FROM buckets WHERE key = ?", key).toArray()[0];
    const bucket: Bucket = row ? { tokens: row.tokens, updatedAt: row.updated_at } : freshBucket(limit, now);
    const result = take(bucket, now, limit, cost);
    this.ctx.storage.sql.exec(
      `INSERT INTO buckets (key, tokens, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at`,
      key,
      result.bucket.tokens,
      result.bucket.updatedAt,
    );
    return { allowed: result.allowed, retryAfterSeconds: result.retryAfterSeconds };
  }

  /** Whether `cost` could be spent now, without spending it. */
  async check(key: string, limit: Limit, cost: number, now: number): Promise<TakeOutcome> {
    const row = this.ctx.storage.sql.exec<BucketRow>("SELECT tokens, updated_at FROM buckets WHERE key = ?", key).toArray()[0];
    const bucket: Bucket = row ? { tokens: row.tokens, updatedAt: row.updated_at } : freshBucket(limit, now);
    const result = take(bucket, now, limit, cost);
    return { allowed: result.allowed, retryAfterSeconds: result.retryAfterSeconds };
  }
}
