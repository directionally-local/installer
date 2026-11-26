import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createService, errorCode, type Service } from "./harness.js";
import { buy, DL, emailSignIn, FakeStripe, PAGE_STATE, PAID_VARS, type SessionResponse } from "./paid-fixtures.js";
import { FakeGoogle, GOOGLE_VARS, googleRoundTrip } from "./google-fixtures.js";

/**
 * "Continue with Google" on dl.new (google.ts, docs/web-api-paid.md § Google): OIDC with PKCE,
 * the ID token checked against a fake Google's JWKS, identities keyed by `sub`, linking to an
 * email-code account with the same verified address, and sign-up only with a paid Checkout.
 */

async function world(vars: Record<string, string> = GOOGLE_VARS): Promise<{ service: Service; stripe: FakeStripe; google: FakeGoogle }> {
  const service = await createService({ ...PAID_VARS, ...vars }, { userEmail: true });
  return { service, stripe: new FakeStripe(service), google: await FakeGoogle.create(service) };
}

async function session(service: Service, fragment: string, extra: Record<string, unknown> = {}): Promise<Response> {
  assert.match(fragment, /^signin=/);
  return service.request("POST", "/web/auth/google/session", { body: { code: fragment.slice("signin=".length), state: PAGE_STATE, ...extra }, headers: DL });
}

const ANA = { sub: "110169484474386276334", email: "ana@gmail.com", name: "Ana Example" };

describe("Continue with Google: off without the client", () => {
  it("404s every Google endpoint and tells the pages it's off", async () => {
    const { service } = await world({});
    const plans = (await (await service.request("GET", "/web/plans", { headers: DL })).json()) as any;
    assert.deepEqual(plans.signIn, { google: false });
    assert.equal((await service.request("GET", `/web/auth/google?return=${encodeURIComponent("https://dl.new/signin")}&state=${PAGE_STATE}`)).status, 404);
    assert.equal((await service.request("GET", "/web/auth/google/callback?code=x&state=y")).status, 404);
    assert.equal((await service.request("POST", "/web/auth/google/session", { body: { code: "x".repeat(43), state: PAGE_STATE }, headers: DL })).status, 404);
    // Half-configured (no secret) is off too.
    const half = await createService({ ...PAID_VARS, GOOGLE_CLIENT_ID: GOOGLE_VARS.GOOGLE_CLIENT_ID });
    assert.equal(((await (await half.request("GET", "/web/plans")).json()) as any).signIn.google, false);
  });
});

describe("Continue with Google", () => {
  it("is on with both values; starts OIDC with PKCE, state and nonce; returns only to dl.new's sign-in pages", async () => {
    const { service } = await world();
    assert.deepEqual(((await (await service.request("GET", "/web/plans", { headers: DL })).json()) as any).signIn, { google: true });
    const start = await service.request("GET", `/web/auth/google?return=${encodeURIComponent("https://dl.new/signin")}&state=${PAGE_STATE}`);
    assert.equal(start.status, 302);
    const location = new URL(start.headers.get("location")!);
    assert.equal(location.searchParams.get("redirect_uri"), "https://free.test/web/auth/google/callback");
    assert.equal(location.searchParams.get("scope"), "openid email profile");
    assert.equal(location.searchParams.get("code_challenge_method"), "S256");
    assert.notEqual(location.searchParams.get("state"), PAGE_STATE, "Google never sees the page's own state");
    assert.match(start.headers.get("set-cookie")!, /^__Host-dl_google_oauth=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Lax/);
    // The no-card trial stays GitHub-only; anywhere else is refused (no open redirect).
    for (const target of ["https://dl.new/trial", "https://evil.example/account", "https://dl.new/account?x=1"]) {
      assert.equal((await service.request("GET", `/web/auth/google?return=${encodeURIComponent(target)}&state=${PAGE_STATE}`)).status, 400, target);
    }
    assert.equal((await service.request("GET", "/web/auth/google?return=https%3A%2F%2Fdl.new%2Faccount&state=short")).status, 400);
  });

  it("signs up with a paid Checkout: the verified Google email is the contact email; then signs in by sub", async () => {
    const { service, stripe, google } = await world();
    const paid = await buy(service, stripe, "plus");
    const fragment = await googleRoundTrip(service, google, ANA);
    const response = await session(service, fragment, { sessionId: paid.id });
    assert.equal(response.status, 200, await response.clone().text());
    const body = (await response.json()) as SessionResponse;
    assert.equal(body.created, true);
    assert.deepEqual(body.claimed, { plan: "plus", sessionId: paid.id });
    assert.equal(body.account.email, "ana@gmail.com");
    assert.deepEqual(body.account.identities, [{ kind: "google", email: "ana@gmail.com" }]);
    // The token request carried the client secret and the PKCE verifier (FakeGoogle checks it hashes to the challenge).
    const form = google.tokenRequests[0]!;
    assert.equal(form.get("redirect_uri"), "https://free.test/web/auth/google/callback");
    assert.match(form.get("code_verifier")!, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual((await service.directory().identities(Number.parseInt(body.account.accountId.slice(5), 36))).map((row: any) => [row.kind, row.subject]), [["google", ANA.sub]]);
    // Later: the same Google account (even with a new address on it) signs straight in.
    const again = (await (await session(service, await googleRoundTrip(service, google, { ...ANA, email: "ana.new@gmail.com" }))).json()) as SessionResponse;
    assert.equal(again.account.accountId, body.account.accountId);
    assert.equal(again.created, false);
    assert.equal(again.claimed, null);
    assert.equal(google.jwksFetches, 1, "the JWKS is cached");
  });

  it("makes no account without a payment", async () => {
    const { service, google } = await world();
    const response = await session(service, await googleRoundTrip(service, google, { sub: "200", email: "nobody@gmail.com" }));
    assert.equal(response.status, 403);
    assert.equal(await errorCode(response), "no_account");
  });

  it("holds the verified Google sign-in with no account (pending) and finishes it after the payment", async () => {
    const { service, stripe, google } = await world();
    const refused = await session(service, await googleRoundTrip(service, google, { sub: "201", email: "new@gmail.com" }));
    const pending = ((await refused.json()) as any).error.pending;
    assert.equal(pending.email, "new@gmail.com");
    await service.settle();
    const welcome = service.calls.userEmail.filter((message) => message.to === "new@gmail.com");
    assert.equal(welcome.length, 1);
    assert.equal(welcome[0]!.subject, "Welcome to dl.new");
    assert.match(String(welcome[0]!.text), /^Welcome to dl\.new\. You signed in with Google; /);
    const paid = await buy(service, stripe, "starter");
    const done = await service.request("POST", "/web/auth/pending/session", { body: { token: pending.token, sessionId: paid.id }, headers: DL });
    assert.equal(done.status, 200, await done.clone().text());
    const body = (await done.json()) as SessionResponse;
    assert.equal(body.created, true);
    assert.deepEqual(body.account.identities, [{ kind: "google", email: "new@gmail.com" }]);
    assert.equal(((await (await session(service, await googleRoundTrip(service, google, { sub: "201", email: "new@gmail.com" }))).json()) as SessionResponse).account.accountId, body.account.accountId);
  });

  it("signs into the account that already signs in with that email by code, and links Google to it", async () => {
    const { service, stripe, google } = await world();
    const paid = await buy(service, stripe, "starter");
    const byEmail = await emailSignIn(service, "Bo@Example.com", paid.id);
    const viaGoogle = (await (await session(service, await googleRoundTrip(service, google, { sub: "300", email: "bo@example.com" }))).json()) as SessionResponse;
    assert.equal(viaGoogle.account.accountId, byEmail.account.accountId);
    assert.equal(viaGoogle.created, false);
    assert.deepEqual(viaGoogle.account.identities, [
      { kind: "email", email: "Bo@Example.com" },
      { kind: "google", email: "bo@example.com" },
    ]);
    // The contact email is left as it was.
    assert.equal(viaGoogle.account.email, "Bo@Example.com");
  });

  it("refuses ID tokens that fail any check", async () => {
    const { service, google } = await world();
    const now = Math.floor(service.clock.now / 1000);
    const cases = [
      { name: "audience", tweak: { claims: { aud: "someone-else.apps.googleusercontent.com" } } },
      { name: "issuer", tweak: { claims: { iss: "https://evil.example" } } },
      { name: "expired", tweak: { claims: { exp: now - 3600, iat: now - 7200 } } },
      { name: "nonce", tweak: { claims: { nonce: "another-nonce-0123456789" } } },
      { name: "signature", tweak: { wrongKey: true } },
      { name: "alg", tweak: { alg: "HS256" } },
    ];
    for (const { name, tweak } of cases) {
      assert.equal(await googleRoundTrip(service, google, ANA, { tweak }), "error=google_failed", name);
    }
    assert.equal(await googleRoundTrip(service, google, { ...ANA, emailVerified: false }), "error=google_no_verified_email");
    assert.equal(await googleRoundTrip(service, google, ANA, { cancel: true }), "error=google_cancelled");
    google.refuseToken = true;
    assert.equal(await googleRoundTrip(service, google, ANA), "error=google_failed");
  });

  it("reads Google's keys again when it rotates them", async () => {
    const { service, stripe, google } = await world();
    const paid = await buy(service, stripe);
    assert.equal((await session(service, await googleRoundTrip(service, google, ANA), { sessionId: paid.id })).status, 200);
    await google.rotate();
    assert.equal((await session(service, await googleRoundTrip(service, google, ANA))).status, 200);
    assert.equal(google.jwksFetches, 2);
  });

  it("binds the round trip to the browser and the handoff to the page's state, once", async () => {
    const { service, stripe, google } = await world();
    // No cookie: back to /signin.
    const start = await service.request("GET", `/web/auth/google?return=${encodeURIComponent("https://dl.new/account")}&state=${PAGE_STATE}`);
    const location = new URL(start.headers.get("location")!);
    const code = google.authorize(location, ANA);
    const noCookie = await service.request("GET", `/web/auth/google/callback?code=${encodeURIComponent(code)}&state=${location.searchParams.get("state")}`);
    assert.equal(noCookie.headers.get("location"), "https://dl.new/signin#error=expired");
    // The handoff only works with the page's own state.
    const paid = await buy(service, stripe);
    const fragment = await googleRoundTrip(service, google, ANA);
    const wrongState = await service.request("POST", "/web/auth/google/session", { body: { code: fragment.slice(7), state: "another-state-0123456789", sessionId: paid.id }, headers: DL });
    assert.equal(await errorCode(wrongState), "invalid_grant");
    // The code died with that try.
    assert.equal(await errorCode(await session(service, fragment, { sessionId: paid.id })), "invalid_grant");
    // A good handoff works once.
    const good = await googleRoundTrip(service, google, ANA);
    assert.equal((await session(service, good, { sessionId: paid.id })).status, 200);
    assert.equal(await errorCode(await session(service, good, { sessionId: paid.id })), "invalid_grant");
  });

});
