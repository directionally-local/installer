import { DurableObject, type DurableObjectState } from "cloudflare:workers";

/**
 * A sharded cache of names for admin listing. Never the source of truth: `NameObject`
 * updates its shard with an RPC call, and a failed update only means a stale listing.
 */

export interface IndexEntry {
  name: string;
  status: string;
  ownerKey: string;
  updatedAt: number;
}

interface EntryRow {
  name: string;
  status: string;
  owner_key: string;
  updated_at: number;
}

export class IndexObject extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS entries (
           name       TEXT PRIMARY KEY,
           status     TEXT NOT NULL,
           owner_key  TEXT NOT NULL,
           updated_at INTEGER NOT NULL
         )`,
      );
    });
  }

  async upsert(entry: IndexEntry): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO entries (name, status, owner_key, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         status = excluded.status,
         owner_key = excluded.owner_key,
         updated_at = excluded.updated_at`,
      entry.name,
      entry.status,
      entry.ownerKey,
      entry.updatedAt,
    );
  }

  async remove(name: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM entries WHERE name = ?", name);
  }

  /** Names after `cursor`, in name order. The cursor is the last name of the previous page. */
  async list(cursor: string | undefined, limit: number): Promise<{ entries: IndexEntry[]; cursor?: string }> {
    const size = Math.min(Math.max(1, limit), 200);
    const rows = cursor
      ? this.ctx.storage.sql.exec<EntryRow>("SELECT * FROM entries WHERE name > ? ORDER BY name LIMIT ?", cursor, size + 1).toArray()
      : this.ctx.storage.sql.exec<EntryRow>("SELECT * FROM entries ORDER BY name LIMIT ?", size + 1).toArray();
    const page = rows.slice(0, size);
    const last = page[page.length - 1];
    return {
      entries: page.map((row) => ({ name: row.name, status: row.status, ownerKey: row.owner_key, updatedAt: row.updated_at })),
      ...(rows.length > size && last ? { cursor: last.name } : {}),
    };
  }
}
