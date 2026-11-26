import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createService, SIGNING_KEY } from "./harness.js";
import { adminCookie, csrfOf } from "./admin-web.js";
import { hmacKey, signJwt, type JwtClaims } from "../../shared/src/jwt.js";
import { subkey } from "../../shared/src/keys.js";
import { sha256Hex } from "../../shared/src/auth.js";
import { stopToken } from "../src/user-email-send.js";

/**
 * TOKEN_SIGNING_KEY's per-purpose subkeys (#398): new JWTs and unsubscribe links are signed with
 * their own subkey, and what was signed with the raw key before the split still verifies, so a
 * deploy signs nobody out and breaks no link in an email already sent.
 */

const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as JwtClaims;

describe("signing subkeys", () => {
  it("signs new access tokens with the jwt subkey, and still takes one signed with the raw key", async () => {
    const service = await createService({ OPEN_ADMISSION: "true" });
    const { access_token: token } = await service.signIn({ id: 100, login: "alice" });
    const claims = claimsOf(token);
    // Signed with the jwt subkey, not the raw key.
    assert.equal(token, await signJwt(claims, await subkey(SIGNING_KEY, "jwt")));
    assert.notEqual(token, await signJwt(claims, await hmacKey(SIGNING_KEY)));
    // A token from before the deploy (the same session, signed with the raw key) still works.
    const legacy = await signJwt(claims, await hmacKey(SIGNING_KEY));
    assert.equal((await service.request("GET", "/v1/me", { token: legacy })).status, 200);
    // One signed with another purpose's subkey doesn't.
    const wrong = await signJwt(claims, await subkey(SIGNING_KEY, "unsubscribe"));
    assert.equal((await service.request("GET", "/v1/me", { token: wrong })).status, 401);
  });

  it("keeps an admin dashboard session and its CSRF token from before the split working", async () => {
    const service = await createService({ OPEN_ADMISSION: "true" });
    const cookie = await adminCookie(service);
    const [name, jwt] = cookie.split("=") as [string, string];
    const claims = claimsOf(jwt);
    const legacyCookie = `${name}=${await signJwt(claims, await hmacKey(SIGNING_KEY))}`;
    const page = await service.request("GET", "/admin?view=tools", { headers: { cookie: legacyCookie } });
    assert.equal(page.status, 200);
    assert.notEqual(csrfOf(await page.text()), await sha256Hex(`admin-csrf:${SIGNING_KEY}:${claims.sid}`), "new pages carry the csrf-subkey token");
    const post = (csrf: string) => service.request("POST", "/admin/dashboard/tools", { headers: { cookie: legacyCookie, origin: "https://free.test" }, form: { csrf, tool: "grant", logins: "" } });
    assert.equal((await post(await sha256Hex(`admin-csrf:${SIGNING_KEY}:${claims.sid}`))).status, 200, "a form rendered before the deploy");
    assert.equal((await post("0".repeat(64))).status, 403);
  });

  it("takes unsubscribe links signed with the raw key (emails already sent) and with the unsubscribe subkey", async () => {
    const service = await createService({ OPEN_ADMISSION: "true" });
    await service.signIn({ id: 100, login: "alice" });
    const stop = async (key: CryptoKey) => (await service.request("GET", `/email/stop?u=100&t=${await stopToken(key, 100)}`)).status;
    assert.equal(await stop(await hmacKey(SIGNING_KEY)), 200);
    assert.equal(await stop(await subkey(SIGNING_KEY, "unsubscribe")), 200);
    assert.equal(await stop(await subkey(SIGNING_KEY, "jwt")), 400);
  });
});
