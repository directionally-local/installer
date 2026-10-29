/**
 * The DNS-01 half of ACME: which TXT record to publish, and what to put in it. The service
 * never sees the ACME account key or the certificate private key; it only publishes the
 * key authorization the server computed.
 */

import { base64urlEncode, sha256 } from "./auth.js";

/** `_acme-challenge.<name>.<zone>`, the same record for a host and for its wildcard. */
export function challengeRecordName(name: string, zone: string): string {
  return `_acme-challenge.${name}.${zone}`;
}

/** `token.thumbprint`, exactly as RFC 8555 §8.1 defines it. */
export function keyAuthorization(token: string, accountKeyThumbprint: string): string {
  return `${token}.${accountKeyThumbprint}`;
}

/**
 * RFC 7638 JWK thumbprint: the required members only, in lexicographic order, no
 * whitespace, hashed with SHA-256 and base64url-encoded.
 */
export async function jwkThumbprint(jwk: JsonWebKey): Promise<string> {
  const members = requiredMembers(jwk);
  const canonical = `{${members.map((member) => `"${member}":${JSON.stringify((jwk as Record<string, unknown>)[member])}`).join(",")}}`;
  return base64urlEncode(await sha256(canonical));
}

function requiredMembers(jwk: JsonWebKey): string[] {
  switch (jwk.kty) {
    case "EC":
      return ["crv", "kty", "x", "y"];
    case "RSA":
      return ["e", "kty", "n"];
    case "OKP":
      return ["crv", "kty", "x"];
    default:
      throw new Error(`Unsupported JWK key type ${String(jwk.kty)}; expected EC, RSA or OKP.`);
  }
}

/** A DNS-01 token as ACME sends it: base64url, no padding. */
export function isAcmeToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{16,128}$/.test(token);
}
