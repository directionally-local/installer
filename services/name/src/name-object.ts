import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import {
  expire,
  isClaimable,
  newLease,
  nextAlarm,
  release,
  renew,
  revoke,
  shouldDelete,
  type Lease,
} from "./lease.js";

/**
 * One name, one object: `idFromName(name)` is the single serialization point that makes
 * uniqueness true on Cloudflare and on celld/native alike. The lease is the source of
 * truth; the index is only a cache for admin listing.
 */

export interface NameObjectEnv {
  LEASE_DAYS?: string;
  GRACE_DAYS?: string;
  QUARANTINE_DAYS?: string;
}

export interface ClaimInput {
  name: string;
  ownerKey: string;
  dnsTarget: string;
  now: number;
}

export type ClaimResult =
  | { ok: true; lease: Lease }
  | { ok: false; reason: "taken" | "quarantined"; lease: Lease };

interface LeaseRow {
  name: string;
  owner_key: string;
  status: string;
  dns_target: string | null;
  created_at: number;
  updated_at: number;
  lease_expires_at: number;
  grace_expires_at: number | null;
  quarantine_until: number | null;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS lease (
     name             TEXT PRIMARY KEY,
     owner_key        TEXT NOT NULL,
     status           TEXT NOT NULL,
     dns_target       TEXT,
     created_at       INTEGER NOT NULL,
     updated_at       INTEGER NOT NULL,
     lease_expires_at INTEGER NOT NULL,
     grace_expires_at INTEGER,
     quarantine_until INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS events (
     id     INTEGER PRIMARY KEY AUTOINCREMENT,
     at     INTEGER NOT NULL,
     kind   TEXT NOT NULL,
     detail TEXT NOT NULL
   )`,
];

export class NameObject extends DurableObject<NameObjectEnv> {
  constructor(ctx: DurableObjectState, env: NameObjectEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      for (const statement of SCHEMA) this.ctx.storage.sql.exec(statement);
    });
  }

  /** Claims the name, or says why it can't be claimed. */
  async claim(input: ClaimInput): Promise<ClaimResult> {
    const existing = this.#read();
    if (!isClaimable(existing, input.now)) {
      const lease = existing!;
      return { ok: false, reason: lease.status === "active" || lease.status === "grace" ? "taken" : "quarantined", lease };
    }
    const lease = newLease({
      name: input.name,
      ownerKey: input.ownerKey,
      dnsTarget: input.dnsTarget,
      now: input.now,
      leaseDays: this.#days("LEASE_DAYS", 30),
    });
    this.#write(lease, "claim");
    await this.#schedule(lease);
    return { ok: true, lease };
  }

  /** The lease as of `now`, with any expiry applied. Undefined when the name was never claimed. */
  async status(now: number): Promise<Lease | undefined> {
    const lease = this.#read();
    if (!lease) return undefined;
    const current = expire(lease, now, this.#days("GRACE_DAYS", 7), this.#days("QUARANTINE_DAYS", 30));
    if (current !== lease) {
      this.#write(current, current.status);
      await this.#schedule(current);
    }
    return current;
  }

  async renew(now: number): Promise<Lease> {
    const lease = this.#currentLease(now);
    const renewed = renew(lease, now, this.#days("LEASE_DAYS", 30));
    this.#write(renewed, "renew");
    await this.#schedule(renewed);
    return renewed;
  }

  async release(now: number): Promise<Lease> {
    const lease = this.#currentLease(now);
    const released = release(lease, now, this.#days("QUARANTINE_DAYS", 30));
    this.#write(released, "release");
    await this.#schedule(released);
    return released;
  }

  async revoke(now: number): Promise<Lease> {
    const lease = this.#currentLease(now);
    const revoked = revoke(lease, now, 90);
    this.#write(revoked, "revoke");
    await this.#schedule(revoked);
    return revoked;
  }

  /** The alarm the lease asked for: expiry, grace expiry, or the end of quarantine. */
  async alarm(): Promise<void> {
    const lease = this.#read();
    if (!lease) return;
    const now = Date.now();
    if (shouldDelete(lease, now)) {
      this.ctx.storage.sql.exec("DELETE FROM lease");
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const current = expire(lease, now, this.#days("GRACE_DAYS", 7), this.#days("QUARANTINE_DAYS", 30));
    if (current !== lease) this.#write(current, current.status);
    await this.#schedule(current);
  }

  #currentLease(now: number): Lease {
    const lease = this.#read();
    if (!lease) throw new Error("This name has never been claimed.");
    return expire(lease, now, this.#days("GRACE_DAYS", 7), this.#days("QUARANTINE_DAYS", 30));
  }

  #read(): Lease | undefined {
    const row = this.ctx.storage.sql.exec<LeaseRow>("SELECT * FROM lease LIMIT 1").toArray()[0];
    return row ? fromRow(row) : undefined;
  }

  #write(lease: Lease, kind: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO lease (name, owner_key, status, dns_target, created_at, updated_at, lease_expires_at, grace_expires_at, quarantine_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         owner_key = excluded.owner_key,
         status = excluded.status,
         dns_target = excluded.dns_target,
         updated_at = excluded.updated_at,
         lease_expires_at = excluded.lease_expires_at,
         grace_expires_at = excluded.grace_expires_at,
         quarantine_until = excluded.quarantine_until`,
      lease.name,
      lease.ownerKey,
      lease.status,
      lease.dnsTarget,
      lease.createdAt,
      lease.updatedAt,
      lease.leaseExpiresAt,
      lease.graceExpiresAt,
      lease.quarantineUntil,
    );
    this.ctx.storage.sql.exec("INSERT INTO events (at, kind, detail) VALUES (?, ?, ?)", lease.updatedAt, kind, lease.status);
  }

  async #schedule(lease: Lease): Promise<void> {
    const at = nextAlarm(lease);
    if (at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(at);
  }

  #days(name: keyof NameObjectEnv, fallback: number): number {
    const raw = this.env[name];
    const parsed = raw === undefined ? Number.NaN : Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
  }
}

function fromRow(row: LeaseRow): Lease {
  return {
    name: row.name,
    ownerKey: row.owner_key,
    status: row.status as Lease["status"],
    dnsTarget: row.dns_target,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    leaseExpiresAt: row.lease_expires_at,
    graceExpiresAt: row.grace_expires_at,
    quarantineUntil: row.quarantine_until,
  };
}
