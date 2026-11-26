/**
 * Per-purpose subkeys of one service secret, so a value made for one purpose (a JWT, an
 * unsubscribe link, a network hash, a CSRF token, a broadcast confirmation) can't be replayed
 * as another, and so each purpose can later move to a key of its own.
 *
 * HKDF-SHA256 (RFC 5869) with a fixed salt and the purpose as `info`, 32 bytes out. It is built
 * from two HMAC calls rather than Web Crypto's HKDF algorithm so it needs nothing beyond what
 * the JWT code already uses, on every runtime.
 */

export type KeyPurpose = "jwt" | "ip-hash" | "csrf" | "unsubscribe" | "broadcast";

const SALT = new TextEncoder().encode("directionally-local subkey v1");

async function hmac(key: Uint8Array<ArrayBuffer>, message: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, message));
}

/** HKDF-SHA256 with one block of output (32 bytes): extract, then the first expand step. */
export async function hkdfSha256(ikm: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const prk = await hmac(salt, ikm);
  const block = new Uint8Array(info.length + 1);
  block.set(info);
  block[info.length] = 1;
  return hmac(prk, block);
}

/** The 32-byte subkey of `secret` for `purpose`. */
export function subkeyBytes(secret: string, purpose: KeyPurpose): Promise<Uint8Array<ArrayBuffer>> {
  return hkdfSha256(new TextEncoder().encode(secret), SALT, new TextEncoder().encode(purpose));
}

/** The subkey of `secret` for `purpose`, as an HMAC-SHA256 key that signs and verifies. */
export async function subkey(secret: string, purpose: KeyPurpose): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", await subkeyBytes(secret, purpose), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** HMAC-SHA256 of `message` under `key`, as lowercase hex. */
export async function hmacHex(key: CryptoKey, message: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  return [...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
