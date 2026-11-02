import { base64urlDecode, base64urlEncode } from "./auth.js";

/**
 * HS256 JSON Web Tokens (RFC 7519) over Web Crypto. Signing and verification use
 * `crypto.subtle`, so the signature check is constant-time and the code runs unchanged on
 * Cloudflare, celld and the native engine. Only HS256 is accepted: a token whose header
 * names any other algorithm, including `none`, is rejected.
 */

export interface JwtClaims {
  sub: string;
  iat: number;
  exp: number;
  [claim: string]: unknown;
}

const HEADER = base64urlEncode(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));

/** The HMAC key for `secret`. Secrets shorter than 32 bytes are refused. */
export async function hmacKey(secret: string): Promise<CryptoKey> {
  const bytes = new TextEncoder().encode(secret);
  if (bytes.length < 32) throw new Error("The signing key must be at least 32 bytes.");
  return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signJwt(claims: JwtClaims, key: CryptoKey): Promise<string> {
  const payload = base64urlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${HEADER}.${payload}`;
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput)));
  return `${signingInput}.${base64urlEncode(signature)}`;
}

/**
 * The claims of a valid, unexpired token, or undefined. `nowSeconds` is Unix seconds;
 * `leewaySeconds` tolerates small clock differences on `exp` and `iat`.
 */
export async function verifyJwt(token: string, key: CryptoKey, nowSeconds: number, leewaySeconds = 30): Promise<JwtClaims | undefined> {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const [header, payload, signature] = parts as [string, string, string];
  try {
    const decodedHeader = JSON.parse(new TextDecoder().decode(base64urlDecode(header))) as { alg?: unknown };
    if (decodedHeader.alg !== "HS256") return undefined;
    const valid = await crypto.subtle.verify("HMAC", key, base64urlDecode(signature), new TextEncoder().encode(`${header}.${payload}`));
    if (!valid) return undefined;
    const claims = JSON.parse(new TextDecoder().decode(base64urlDecode(payload))) as Partial<JwtClaims>;
    if (typeof claims.sub !== "string" || typeof claims.exp !== "number" || typeof claims.iat !== "number") return undefined;
    if (claims.exp + leewaySeconds <= nowSeconds) return undefined;
    if (claims.iat - leewaySeconds > nowSeconds) return undefined;
    return claims as JwtClaims;
  } catch {
    return undefined;
  }
}
