import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import { freshBucket, take, type Bucket, type Limit } from "../../shared/src/rate-limit.js";

/**
 * Token buckets, one object per bucket key, so a limit holds at a single point on every target.
 * A bucket's row is deleted once it has refilled (`full_at`), by the next spend or by an alarm:
 * a missing row is a full bucket, so nothing changes for the limit, and a key (which can name a
 * network hash or an address) isn't kept after it stops mattering.
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

/** When a bucket left with `bucket.tokens` is full again, or null if it never refills. */
export function fullAt(bucket: Bucket, limit: Limit): number | null {
  if (limit.perHour <= 0) return null;
  const missing = Math.max(0, limit.capacity - bucket.tokens);
  return bucket.updatedAt + Math.ceil((missing / limit.perHour) * 3_600_000);
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
      const columns = this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('buckets')").toArray().map((column) => column.name);
      // A row written before this column existed gets one the next time its key is spent.
      if (!columns.includes("full_at")) this.ctx.storage.sql.exec("ALTER TABLE buckets ADD COLUMN full_at INTEGER");
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
    const full = fullAt(result.bucket, limit);
    this.ctx.storage.sql.exec("DELETE FROM buckets WHERE key <> ? AND full_at IS NOT NULL AND full_at <= ?", key, now);
    if (full !== null && full <= now) {
      this.ctx.storage.sql.exec("DELETE FROM buckets WHERE key = ?", key);
    } else {
      this.ctx.storage.sql.exec(
        `INSERT INTO buckets (key, tokens, updated_at, full_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at, full_at = excluded.full_at`,
        key,
        result.bucket.tokens,
        result.bucket.updatedAt,
        full,
      );
      if (full !== null) await this.#wakeBy(full);
    }
    return { allowed: result.allowed, retryAfterSeconds: result.retryAfterSeconds };
  }

  /** Deletes the buckets that are full again, and wakes for the next one. */
  async alarm(): Promise<void> {
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM buckets WHERE full_at IS NOT NULL AND full_at <= ?", now);
    const next = this.ctx.storage.sql.exec<{ at: number | null }>("SELECT MIN(full_at) AS at FROM buckets").toArray()[0]?.at ?? null;
    if (next !== null) await this.ctx.storage.setAlarm(Math.max(next, now + 1000));
  }

  /** Sets the alarm to `at` unless one is already due sooner. */
  async #wakeBy(at: number): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > at) await this.ctx.storage.setAlarm(at);
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
