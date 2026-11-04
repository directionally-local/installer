import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import { freshBucket, take, type Bucket, type Limit } from "../../shared/src/rate-limit.js";

/**
 * Token buckets, one object per bucket key, so a limit holds at a single point on every target.
 *
 * The object named `HOSTS_OBJECT` (routing.ts) also keeps the OpenRouter hosts that failed a request
 * recently: one row per host with when it last failed. It is global and tiny (a host is
 * listed again only by failing again, and rows older than a day are dropped), and whether a
 * host still counts as failing is decided at read time from the current cooldown, so changing
 * or turning off the cooldown applies to the next request.
 */

const HOST_ROW_MAX_AGE_MS = 86_400_000;
/** OpenRouter's `ignore` list is kept as short as the other slug lists. */
const MAX_FAILING_HOSTS = 10;

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
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS failing_hosts (
           host      TEXT PRIMARY KEY,
           failed_at INTEGER NOT NULL
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

  /** Records that `host` failed a request at `now`. */
  async markHostFailing(host: string, now: number): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM failing_hosts WHERE failed_at <= ?", now - HOST_ROW_MAX_AGE_MS);
    this.ctx.storage.sql.exec(
      `INSERT INTO failing_hosts (host, failed_at) VALUES (?, ?)
       ON CONFLICT(host) DO UPDATE SET failed_at = MAX(failed_at, excluded.failed_at)`,
      host,
      now,
    );
  }

  /** Hosts that failed after `since`, most recent first. */
  async failingHosts(since: number): Promise<string[]> {
    return this.ctx.storage.sql
      .exec<{ host: string }>("SELECT host FROM failing_hosts WHERE failed_at > ? ORDER BY failed_at DESC, host LIMIT ?", since, MAX_FAILING_HOSTS)
      .toArray()
      .map((row) => row.host);
  }
}
