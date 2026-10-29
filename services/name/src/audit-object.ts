import { DurableObject, type DurableObjectState } from "cloudflare:workers";

/**
 * An append-only audit log, one object per day (`audit-<YYYY-MM-DD>`). Claims, renewals,
 * releases, revocations and challenge publications all land here.
 */

export interface AuditEntry {
  at: number;
  actor: string;
  action: string;
  subject: string;
  detail: string;
}

interface AuditRow {
  at: number;
  actor: string;
  action: string;
  subject: string;
  detail: string;
}

export class AuditObject extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS audit (
           id      INTEGER PRIMARY KEY AUTOINCREMENT,
           at      INTEGER NOT NULL,
           actor   TEXT NOT NULL,
           action  TEXT NOT NULL,
           subject TEXT NOT NULL,
           detail  TEXT NOT NULL
         )`,
      );
    });
  }

  async append(entry: AuditEntry): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT INTO audit (at, actor, action, subject, detail) VALUES (?, ?, ?, ?, ?)",
      entry.at,
      entry.actor,
      entry.action,
      entry.subject,
      entry.detail,
    );
  }

  async read(limit = 500): Promise<AuditEntry[]> {
    const size = Math.min(Math.max(1, limit), 5_000);
    return this.ctx.storage.sql
      .exec<AuditRow>("SELECT at, actor, action, subject, detail FROM audit ORDER BY id DESC LIMIT ?", size)
      .toArray()
      .map((row) => ({ at: row.at, actor: row.actor, action: row.action, subject: row.subject, detail: row.detail }));
  }
}

/** The object name for a day: `audit-2026-10-29`. */
export function auditDayKey(now: number): string {
  return `audit-${new Date(now).toISOString().slice(0, 10)}`;
}
