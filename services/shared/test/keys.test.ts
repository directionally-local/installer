import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hkdfSha256, hmacHex, subkey, subkeyBytes } from "../src/keys.js";
import { hmacKey, signJwt, verifyJwt } from "../src/jwt.js";

const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const fromHex = (text: string) => Uint8Array.from(text.match(/../g)!.map((pair) => parseInt(pair, 16)));
const SECRET = "test-signing-key-test-signing-key-0123456789";

describe("per-purpose subkeys (HKDF-SHA256)", () => {
  it("matches RFC 5869 test case 1 (its first 32 bytes)", async () => {
    const okm = await hkdfSha256(new Uint8Array(22).fill(0x0b), fromHex("000102030405060708090a0b0c"), fromHex("f0f1f2f3f4f5f6f7f8f9"));
    assert.equal(hex(okm), "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf");
  });

  it("matches Web Crypto's own HKDF", async () => {
    const master = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), "HKDF", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("directionally-local subkey v1"), info: new TextEncoder().encode("jwt") }, master, 256);
    assert.equal(hex(await subkeyBytes(SECRET, "jwt")), hex(new Uint8Array(bits)));
  });

  it("gives each purpose its own key, none of them the secret itself", async () => {
    const purposes = ["jwt", "ip-hash", "csrf", "unsubscribe", "broadcast"] as const;
    const keys = await Promise.all(purposes.map((purpose) => subkeyBytes(SECRET, purpose).then(hex)));
    assert.equal(new Set(keys).size, purposes.length);
    assert.ok(!keys.includes(hex(new TextEncoder().encode(SECRET))));
    // The same message under two purposes hashes differently.
    assert.notEqual(await hmacHex(await subkey(SECRET, "ip-hash"), "x"), await hmacHex(await subkey(SECRET, "csrf"), "x"));
  });

  it("verifyJwt takes a list of keys: a token from either verifies, from neither doesn't", async () => {
    const current = await subkey(SECRET, "jwt");
    const legacy = await hmacKey(SECRET);
    const claims = { sub: "1", iat: 1000, exp: 2000 };
    assert.ok(await verifyJwt(await signJwt(claims, legacy), [current, legacy], 1500));
    assert.ok(await verifyJwt(await signJwt(claims, current), [current, legacy], 1500));
    assert.equal(await verifyJwt(await signJwt(claims, current), legacy, 1500), undefined);
    assert.equal(await verifyJwt(await signJwt(claims, await subkey(SECRET, "csrf")), [current, legacy], 1500), undefined);
  });
});
