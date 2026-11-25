/**
 * "Continue with Google" for dl.new accounts (docs/web-api-paid.md § Google): OpenID Connect,
 * authorization code flow with PKCE (S256), `state` and `nonce`, scopes `openid email profile`.
 *
 * The endpoints are Google's, from https://accounts.google.com/.well-known/openid-configuration
 * (issuer, authorization, token, JWKS). The ID token from the token endpoint is checked here in
 * full even though it came straight from Google over TLS: RS256 signature against Google's JWKS
 * (cached per isolate, refetched on an unknown `kid`), `iss`, `aud` = our client id, `exp`, `iat`,
 * the `nonce` this sign-in sent, and `email_verified` true. Web Crypto only, so it runs unchanged
 * on Cloudflare and on celld.
 */

import { base64urlDecode, base64urlEncode, sha256 } from "../../shared/src/auth.js";

export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"] as const;
export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_SCOPES = "openid email profile";
/** Where Google sends the browser back (on the service's own origin, PUBLIC_URL). Register it in Google Cloud. */
export const GOOGLE_CALLBACK_PATH = "/web/auth/google/callback";
/** Clock difference tolerated on `exp` and `iat`. */
const LEEWAY_S = 60;
/** The longest the JWKS is kept, whatever Google's cache-control says. */
const JWKS_MAX_AGE_MS = 6 * 3_600_000;
const FETCH_TIMEOUT_MS = 8_000;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

/** What a verified Google sign-in gives us: the stable subject and the verified address (the name, from `profile`, isn't kept). */
export interface GoogleUser {
  sub: string;
  email: string;
}

/** A PKCE verifier (43 base64url characters) and its S256 challenge. */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: base64urlEncode(await sha256(verifier)) };
}

export function googleAuthorizeUrl(input: { clientId: string; redirectUri: string; state: string; nonce: string; challenge: string }): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES);
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  // Lets a person with several Google accounts pick one instead of signing in with the last used.
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

/** Exchanges the code for tokens and verifies the ID token; undefined on any failure (never throws). */
export async function googleSignInFromCode(
  client: GoogleClient,
  input: { code: string; verifier: string; redirectUri: string; nonce: string; nowMs: number },
  fetcher: Fetch,
): Promise<GoogleUser | "unverified_email" | undefined> {
  let idToken: unknown;
  try {
    const response = await fetcher(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        redirect_uri: input.redirectUri,
        code_verifier: input.verifier,
      }).toString(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    idToken = ((await response.json()) as { id_token?: unknown }).id_token;
  } catch {
    return undefined;
  }
  if (typeof idToken !== "string") return undefined;
  const claims = await verifyGoogleIdToken(idToken, { clientId: client.clientId, nonce: input.nonce, nowMs: input.nowMs }, fetcher);
  if (!claims) return undefined;
  const email = typeof claims.email === "string" ? claims.email.trim() : "";
  // Google sends email_verified as a boolean (older tokens: the string "true").
  if (!email || (claims.email_verified !== true && claims.email_verified !== "true")) return "unverified_email";
  return { sub: claims.sub as string, email };
}

/** The claims of a Google ID token that passes every check, or undefined. */
export async function verifyGoogleIdToken(token: string, expected: { clientId: string; nonce: string; nowMs: number }, fetcher: Fetch): Promise<Record<string, unknown> | undefined> {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(base64urlDecode(headerPart))) as Record<string, unknown>;
    claims = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadPart))) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") return undefined;
  const key = await googleKey(header.kid, expected.nowMs, fetcher);
  if (!key) return undefined;
  let valid = false;
  try {
    valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64urlDecode(signaturePart), new TextEncoder().encode(`${headerPart}.${payloadPart}`));
  } catch {
    return undefined;
  }
  if (!valid) return undefined;
  const now = Math.floor(expected.nowMs / 1000);
  if (!GOOGLE_ISSUERS.includes(claims.iss as (typeof GOOGLE_ISSUERS)[number])) return undefined;
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(expected.clientId)) return undefined;
  // With several audiences, the authorized party must be us.
  if (audience.length > 1 && claims.azp !== expected.clientId) return undefined;
  if (typeof claims.exp !== "number" || claims.exp + LEEWAY_S <= now) return undefined;
  if (typeof claims.iat === "number" && claims.iat - LEEWAY_S > now) return undefined;
  if (claims.nonce !== expected.nonce) return undefined;
  if (typeof claims.sub !== "string" || !/^[A-Za-z0-9_-]{1,255}$/.test(claims.sub)) return undefined;
  return claims;
}

// ─── Google's signing keys ──────────────────────────────────────────────────

let jwks: { keys: Map<string, CryptoKey>; until: number } | undefined;

/** Forgets the cached JWKS (tests). */
export function resetGoogleKeys(): void {
  jwks = undefined;
}

async function googleKey(kid: string, nowMs: number, fetcher: Fetch): Promise<CryptoKey | undefined> {
  if (jwks && jwks.until > nowMs && jwks.keys.has(kid)) return jwks.keys.get(kid);
  // Unknown kid or stale: Google rotated its keys, read them again.
  const fresh = await fetchGoogleKeys(nowMs, fetcher);
  if (fresh) jwks = fresh;
  return jwks?.keys.get(kid);
}

async function fetchGoogleKeys(nowMs: number, fetcher: Fetch): Promise<{ keys: Map<string, CryptoKey>; until: number } | undefined> {
  try {
    const response = await fetcher(GOOGLE_JWKS_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { keys?: unknown };
    if (!Array.isArray(body.keys)) return undefined;
    const keys = new Map<string, CryptoKey>();
    for (const jwk of body.keys as Array<Record<string, unknown>>) {
      if (jwk.kty !== "RSA" || typeof jwk.kid !== "string" || typeof jwk.n !== "string" || typeof jwk.e !== "string") continue;
      if (jwk.use !== undefined && jwk.use !== "sig") continue;
      try {
        keys.set(jwk.kid, await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
      } catch {
        // A key we can't read is skipped; a token signed with it fails.
      }
    }
    const maxAge = /max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "");
    const ttl = Math.min(maxAge ? Number(maxAge[1]) * 1000 : 3_600_000, JWKS_MAX_AGE_MS);
    return { keys, until: nowMs + ttl };
  } catch {
    return undefined;
  }
}
