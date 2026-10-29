/**
 * Name rules for `<name>.directionallylocal.run`. Checked before a lease is created, so a
 * bad name never reaches a Durable Object.
 */

/** Labels the service keeps for itself and for the marketing site. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "www",
  "api",
  "names",
  "approvals",
  "admin",
  "mail",
  "ns1",
  "ns2",
  "ns3",
  "smtp",
  "imap",
  "pop",
  "ftp",
  "status",
  "docs",
  "blog",
  "app",
  "dashboard",
  "support",
  "help",
  "billing",
  "account",
  "login",
  "auth",
  "cdn",
  "static",
  "assets",
  "install",
  "download",
  "preview",
  "previews",
  "test",
  "staging",
  "dev",
  "localhost",
  "directionallylocal",
  "autopilot",
  "hotcell",
  "aster",
]);

export type NameCheck = { ok: true; name: string } | { ok: false; reason: string };

/**
 * 3–63 characters, lowercase ASCII letters, digits and internal hyphens; no leading or
 * trailing hyphen; no `--` in positions 3–4 (that is punycode); not reserved.
 */
export function validateName(input: string): NameCheck {
  const name = input.trim().toLowerCase();
  if (name.length < 3) return { ok: false, reason: "A name needs at least 3 characters." };
  if (name.length > 63) return { ok: false, reason: "A name can be at most 63 characters." };
  if (!/^[a-z0-9-]+$/.test(name)) return { ok: false, reason: "A name can use lowercase letters, digits and hyphens only." };
  if (name.startsWith("-") || name.endsWith("-")) return { ok: false, reason: "A name can't start or end with a hyphen." };
  if (name.slice(2, 4) === "--") return { ok: false, reason: "A name can't have two hyphens in positions 3 and 4." };
  if (RESERVED_NAMES.has(name)) return { ok: false, reason: `${name} is reserved.` };
  return { ok: true, name };
}

/** The fully qualified name for a label. */
export function fqdn(name: string, zone: string): string {
  return `${name}.${zone}`;
}

/** The shard an index entry lives in: 16 shards by a stable hash of the name. */
export function shardOf(name: string, shards = 16): number {
  let hash = 0;
  for (let index = 0; index < name.length; index++) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  }
  return hash % shards;
}
