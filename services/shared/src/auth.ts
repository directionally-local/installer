/**
 * Signed requests from a server key: Ed25519 over a canonical string, with a timestamp and
 * a nonce so a captured request can't be replayed. Web Crypto only, so this runs unchanged
 * on Cloudflare, celld and the native engine.
 */

export interface SignedRequest {
  /** base64url Ed25519 public key. */
  keyId: string;
  /** Unix seconds. */
  timestamp: number;
  /** base64url, unique per request. */
  nonce: string;
  /** base64url Ed25519 signature over the canonical request. */
  signature: string;
}

const AUTH_PREFIX = "DL-Sig";

/** `Authorization: DL-Sig keyId=…, ts=…, nonce=…, sig=…`, or undefined when it isn't one. */
export function parseAuthorization(header: string | null): SignedRequest | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed.startsWith(`${AUTH_PREFIX} `)) return undefined;
  const fields = new Map<string, string>();
  for (const part of trimmed.slice(AUTH_PREFIX.length + 1).split(",")) {
    const index = part.indexOf("=");
    if (index <= 0) return undefined;
    fields.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  const keyId = fields.get("keyId");
  const nonce = fields.get("nonce");
  const signature = fields.get("sig");
  const timestamp = Number(fields.get("ts"));
  if (!keyId || !nonce || !signature || !Number.isFinite(timestamp)) return undefined;
  return { keyId, timestamp, nonce, signature };
}

/**
 * What the signature covers. The query is the raw string after `?` (empty when there is
 * none), so a client and the service agree without re-encoding it.
 */
export function canonicalRequest(input: {
  method: string;
  path: string;
  query: string;
  timestamp: number;
  nonce: string;
  bodySha256: string;
}): string {
  return [
    input.method.toUpperCase(),
    input.path,
    input.query,
    String(input.timestamp),
    input.nonce,
    input.bodySha256,
  ].join("\n");
}

export function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecode(text: string): Uint8Array<ArrayBuffer> {
  const normalized = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function sha256(input: string | Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

export async function sha256Hex(input: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await sha256(input);
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Verifies an Ed25519 signature. A malformed key or signature is a `false`, not a throw. */
export async function verifyEd25519(publicKey: string, signature: string, message: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", base64urlDecode(publicKey), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, base64urlDecode(signature), new TextEncoder().encode(message));
  } catch {
    return false;
  }
}

/** A timestamp within `skewSeconds` of now. Five minutes by default, in both directions. */
export function withinClockSkew(timestamp: number, now: number, skewSeconds = 300): boolean {
  return Math.abs(now - timestamp) <= skewSeconds;
}

/** A random base64url nonce, for clients and tests. */
export function newNonce(bytes = 16): string {
  return base64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}
