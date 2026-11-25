import assert from "node:assert/strict";
import { base64urlEncode, sha256 } from "../../shared/src/auth.js";
import { resetGoogleKeys } from "../src/google.js";
import type { Service } from "./harness.js";
import { PAGE_STATE } from "./paid-fixtures.js";

/**
 * A fake Google for "Continue with Google" (google.ts): its JWKS and token endpoint behind the
 * harness's fetch, RS256 ID tokens signed with a key made per test. The browser's visit to
 * accounts.google.com is `authorize()`: it records what the service asked for and hands back a code.
 */

export const GOOGLE_CLIENT_ID = "1234-test.apps.googleusercontent.com";
export const GOOGLE_VARS = { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: "google-secret-test" };

export interface GoogleAccount {
  sub: string;
  email: string;
  emailVerified?: boolean | string;
  name?: string;
}

/** Changes to the ID token Google returns, for the refusal tests. */
export interface TokenTweak {
  claims?: Record<string, unknown>;
  /** Sign with a key Google doesn't publish (same kid). */
  wrongKey?: boolean;
  alg?: string;
}

interface Grant {
  account: GoogleAccount;
  challenge: string;
  nonce: string;
  redirectUri: string;
  tweak: TokenTweak;
}

export class FakeGoogle {
  kid = "test-kid-1";
  #keys!: CryptoKeyPair;
  #other!: CryptoKeyPair;
  #grants = new Map<string, Grant>();
  #n = 0;
  /** Every token request's form, in order. */
  tokenRequests: URLSearchParams[] = [];
  jwksFetches = 0;
  /** Set to make the token endpoint answer 400 invalid_grant. */
  refuseToken = false;

  static async create(service: Service): Promise<FakeGoogle> {
    const google = new FakeGoogle();
    google.#keys = await newKeys();
    google.#other = await newKeys();
    resetGoogleKeys();
    service.setGoogle((url, init) => google.handle(url, init));
    return google;
  }

  /** Google rotates: a new key under a new kid (the old one is no longer published). */
  async rotate(): Promise<void> {
    this.#keys = await newKeys();
    this.kid = `test-kid-${++this.#n + 1}`;
  }

  /** The browser at Google's consent screen: checks the authorization URL and returns the callback's code. */
  authorize(location: URL, account: GoogleAccount, tweak: TokenTweak = {}): string {
    assert.equal(`${location.origin}${location.pathname}`, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(location.searchParams.get("client_id"), GOOGLE_CLIENT_ID);
    assert.equal(location.searchParams.get("response_type"), "code");
    assert.equal(location.searchParams.get("scope"), "openid email profile");
    assert.equal(location.searchParams.get("code_challenge_method"), "S256");
    const challenge = location.searchParams.get("code_challenge")!;
    assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
    const nonce = location.searchParams.get("nonce")!;
    assert.ok(nonce.length >= 16);
    const code = `4/google-code-${++this.#n}`;
    this.#grants.set(code, { account, challenge, nonce, redirectUri: location.searchParams.get("redirect_uri")!, tweak });
    return code;
  }

  async handle(url: string, init: RequestInit): Promise<Response> {
    if (url === "https://www.googleapis.com/oauth2/v3/certs") {
      this.jwksFetches++;
      const jwk = await crypto.subtle.exportKey("jwk", this.#keys.publicKey);
      return Response.json({ keys: [{ kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", use: "sig", kid: this.kid }] }, { headers: { "cache-control": "public, max-age=19342, must-revalidate, no-transform" } });
    }
    if (url === "https://oauth2.googleapis.com/token") {
      assert.equal(init.method, "POST");
      const form = new URLSearchParams(String(init.body));
      this.tokenRequests.push(form);
      const grant = this.#grants.get(form.get("code") ?? "");
      if (this.refuseToken || !grant) return Response.json({ error: "invalid_grant" }, { status: 400 });
      this.#grants.delete(form.get("code")!);
      if (form.get("grant_type") !== "authorization_code" || form.get("client_id") !== GOOGLE_CLIENT_ID || form.get("client_secret") !== GOOGLE_VARS.GOOGLE_CLIENT_SECRET) return Response.json({ error: "invalid_client" }, { status: 401 });
      if (form.get("redirect_uri") !== grant.redirectUri) return Response.json({ error: "redirect_uri_mismatch" }, { status: 400 });
      // PKCE: the verifier must hash to the challenge the authorization carried.
      if (base64urlEncode(await sha256(form.get("code_verifier") ?? "")) !== grant.challenge) return Response.json({ error: "invalid_grant", error_description: "Invalid code verifier." }, { status: 400 });
      return Response.json({ access_token: "ya29.test", token_type: "Bearer", expires_in: 3599, scope: "openid email profile", id_token: await this.idToken(grant) });
    }
    throw new Error(`unexpected Google fetch ${url}`);
  }

  async idToken(grant: Grant): Promise<string> {
    const header = { alg: grant.tweak.alg ?? "RS256", kid: this.kid, typ: "JWT" };
    const claims = {
      iss: "https://accounts.google.com",
      azp: GOOGLE_CLIENT_ID,
      aud: GOOGLE_CLIENT_ID,
      sub: grant.account.sub,
      email: grant.account.email,
      email_verified: grant.account.emailVerified ?? true,
      ...(grant.account.name ? { name: grant.account.name } : {}),
      nonce: grant.nonce,
      iat: this.nowSeconds,
      exp: this.nowSeconds + 3600,
      ...grant.tweak.claims,
    };
    const input = `${encode(header)}.${encode(claims)}`;
    const key = grant.tweak.wrongKey ? this.#other.privateKey : this.#keys.privateKey;
    const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input)));
    return `${input}.${base64urlEncode(signature)}`;
  }

  /** The service's clock, in seconds (tokens are issued "now" as the service sees it). */
  nowSeconds = 0;
}

function encode(value: unknown): string {
  return base64urlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

function newKeys(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
}

/** "Continue with Google" up to the page's one-time code (or the error fragment). */
export async function googleRoundTrip(service: Service, google: FakeGoogle, account: GoogleAccount, options: { returnTo?: string; tweak?: TokenTweak; cancel?: boolean } = {}): Promise<string> {
  const returnTo = options.returnTo ?? "https://dl.new/account";
  google.nowSeconds = Math.floor(service.clock.now / 1000);
  const start = await service.request("GET", `/web/auth/google?return=${encodeURIComponent(returnTo)}&state=${PAGE_STATE}`);
  assert.equal(start.status, 302, await start.clone().text());
  const location = new URL(start.headers.get("location")!);
  assert.equal(location.searchParams.get("redirect_uri"), "https://free.test/web/auth/google/callback");
  const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
  assert.match(cookie, /^__Host-dl_google_oauth=/);
  const query = options.cancel ? "error=access_denied" : `code=${encodeURIComponent(google.authorize(location, account, options.tweak))}`;
  const callback = await service.request("GET", `/web/auth/google/callback?${query}&state=${location.searchParams.get("state")}&scope=openid`, { headers: { cookie } });
  assert.equal(callback.status, 303);
  const back = callback.headers.get("location")!;
  assert.ok(back.startsWith(`${returnTo}#`), back);
  return back.slice(returnTo.length + 1);
}
