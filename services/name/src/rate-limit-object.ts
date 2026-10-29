import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import { freshBucket, take, type Bucket, type Limit } from "../../shared/src/rate-limit.js";

/**
 * Token buckets and the nonce replay cache. One object per bucket key, so the limit is
 * enforced at a single point on every target.
 */

interface BucketRow {
  key: string;
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
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS nonces (
           nonce      TEXT PRIMARY KEY,
           expires_at INTEGER NOT NULL
         )`,
      );
    });
  }

  /** Spends `cost` tokens from `key`'s bucket, creating it full on first use. */
  async spend(key: string, limit: Limit, cost: number, now: number): Promise<TakeOutcome> {
    const row = this.ctx.storage.sql.exec<BucketRow>("SELECT * FROM buckets WHERE key = ?", key).toArray()[0];
    const bucket: Bucket = row ? { tokens: row.tokens, updatedAt: row.updated_at } : freshBucket(limit, now);
    const result = take(bucket, now, limit, cost);
    this.ctx.storage.sql.exec(
      `INSERT INTO buckets (key, tokens, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at`,
      key,
      result.bucket.tokens,
      result.bucket.updatedAt,
    );
    if (!result.allowed) await this.ctx.storage.setAlarm(now + result.retryAfterSeconds * 1000);
    return { allowed: result.allowed, retryAfterSeconds: result.retryAfterSeconds };
  }

  /** Records a nonce. False when it was already seen: a replay. */
  async rememberNonce(nonce: string, expiresAt: number): Promise<boolean> {
    const seen = this.ctx.storage.sql.exec<{ nonce: string }>("SELECT nonce FROM nonces WHERE nonce = ?", nonce).toArray()[0];
    if (seen) return false;
    this.ctx.storage.sql.exec("INSERT INTO nonces (nonce, expires_at) VALUES (?, ?)", nonce, expiresAt);
    await this.ctx.storage.setAlarm(expiresAt);
    return true;
  }

  /** Drops expired nonces; the alarm is only housekeeping. */
  async alarm(): Promise<void> {
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM nonces WHERE expires_at <= ?", now);
    const next = this.ctx.storage.sql.exec<{ next: number | null }>("SELECT MIN(expires_at) AS next FROM nonces").toArray()[0]?.next;
    if (next === null || next === undefined) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }
}
