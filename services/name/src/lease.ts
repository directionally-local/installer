/**
 * The lease state machine, as pure functions over a plain record. `NameObject` stores the
 * result; the transitions themselves are testable without a Durable Object.
 *
 *   claim ──► active ──(lease expires)──► grace ──(7 days)──► released ──(30 days)──► deleted
 *                │                          │
 *                └──(renew)────────────────┘
 *                └──(release / revoke)────────────────────► released / revoked
 */

export type LeaseStatus = "active" | "grace" | "released" | "revoked";

export interface Lease {
  name: string;
  /** base64url Ed25519 public key of the server that owns the name. */
  ownerKey: string;
  status: LeaseStatus;
  /** Where the name points: the owner's server. Null once released or revoked. */
  dnsTarget: string | null;
  createdAt: number;
  updatedAt: number;
  leaseExpiresAt: number;
  graceExpiresAt: number | null;
  quarantineUntil: number | null;
}

export const DAY_MS = 86_400_000;

export function newLease(input: {
  name: string;
  ownerKey: string;
  dnsTarget: string;
  now: number;
  leaseDays: number;
}): Lease {
  return {
    name: input.name,
    ownerKey: input.ownerKey,
    status: "active",
    dnsTarget: input.dnsTarget,
    createdAt: input.now,
    updatedAt: input.now,
    leaseExpiresAt: input.now + input.leaseDays * DAY_MS,
    graceExpiresAt: null,
    quarantineUntil: null,
  };
}

/** A lease that can still be renewed: active, or in its grace period. */
export function canRenew(lease: Lease): boolean {
  return lease.status === "active" || lease.status === "grace";
}

/** Extends the lease and returns it to active. Throws for a released or revoked name. */
export function renew(lease: Lease, now: number, leaseDays: number): Lease {
  if (!canRenew(lease)) throw new Error(`${lease.name} is ${lease.status} and can't be renewed.`);
  return {
    ...lease,
    status: "active",
    updatedAt: now,
    leaseExpiresAt: now + leaseDays * DAY_MS,
    graceExpiresAt: null,
  };
}

/** The owner gives the name up: DNS goes away and the name is quarantined. */
export function release(lease: Lease, now: number, quarantineDays: number): Lease {
  return {
    ...lease,
    status: "released",
    dnsTarget: null,
    updatedAt: now,
    graceExpiresAt: null,
    quarantineUntil: now + quarantineDays * DAY_MS,
  };
}

/** An admin takes the name away. Same shape as a release, with a longer quarantine. */
export function revoke(lease: Lease, now: number, quarantineDays: number): Lease {
  return {
    ...lease,
    status: "revoked",
    dnsTarget: null,
    updatedAt: now,
    graceExpiresAt: null,
    quarantineUntil: now + quarantineDays * DAY_MS,
  };
}

/**
 * Applies whatever the clock has done: active → grace at `leaseExpiresAt`, grace → released
 * at `graceExpiresAt`. Returns the same object when nothing changed, so callers can skip a
 * write.
 */
export function expire(lease: Lease, now: number, graceDays: number, quarantineDays: number): Lease {
  if (lease.status === "active" && now >= lease.leaseExpiresAt) {
    const graceExpiresAt = lease.leaseExpiresAt + graceDays * DAY_MS;
    if (now >= graceExpiresAt) {
      return { ...lease, status: "released", dnsTarget: null, updatedAt: now, graceExpiresAt: null, quarantineUntil: graceExpiresAt + quarantineDays * DAY_MS };
    }
    return { ...lease, status: "grace", updatedAt: now, graceExpiresAt };
  }
  if (lease.status === "grace" && lease.graceExpiresAt !== null && now >= lease.graceExpiresAt) {
    return {
      ...lease,
      status: "released",
      dnsTarget: null,
      updatedAt: now,
      graceExpiresAt: null,
      quarantineUntil: lease.graceExpiresAt + quarantineDays * DAY_MS,
    };
  }
  return lease;
}

/** When this lease next needs attention, or null when nothing is scheduled. */
export function nextAlarm(lease: Lease): number | null {
  switch (lease.status) {
    case "active":
      return lease.leaseExpiresAt;
    case "grace":
      return lease.graceExpiresAt;
    case "released":
    case "revoked":
      return lease.quarantineUntil;
  }
}

/** A quarantined name whose time is up: the object can delete itself. */
export function shouldDelete(lease: Lease, now: number): boolean {
  return (lease.status === "released" || lease.status === "revoked")
    && lease.quarantineUntil !== null
    && now >= lease.quarantineUntil;
}

/** Whether a name may be claimed now: never claimed, or quarantined and past its time. */
export function isClaimable(lease: Lease | undefined, now: number): boolean {
  if (!lease) return true;
  return shouldDelete(lease, now);
}
