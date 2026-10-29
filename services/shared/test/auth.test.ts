import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  base64urlDecode,
  base64urlEncode,
  canonicalRequest,
  newNonce,
  parseAuthorization,
  sha256Hex,
  verifyEd25519,
  withinClockSkew,
} from "../src/auth.js";

async function keyPair(): Promise<{ keyId: string; sign: (message: string) => Promise<string> }> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    keyId: base64urlEncode(raw),
    sign: async (message) => base64urlEncode(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(message)))),
  };
}

describe("base64url", () => {
  it("round-trips bytes without padding", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const encoded = base64urlEncode(bytes);
    assert.doesNotMatch(encoded, /[+/=]/);
    assert.deepEqual(base64urlDecode(encoded), bytes);
  });
});

describe("canonical requests", () => {
  it("joins the six parts with newlines, uppercasing the method", () => {
    const canonical = canonicalRequest({
      method: "post",
      path: "/v1/names",
      query: "",
      timestamp: 1_700_000_000,
      nonce: "abc",
      bodySha256: "deadbeef",
    });
    assert.equal(canonical, "POST\n/v1/names\n\n1700000000\nabc\ndeadbeef");
  });

  it("hashes the body with SHA-256", async () => {
    assert.equal(await sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("Authorization: DL-Sig", () => {
  it("parses the four fields", () => {
    const parsed = parseAuthorization("DL-Sig keyId=abc, ts=1700000000, nonce=xyz, sig=sig==");
    assert.deepEqual(parsed, { keyId: "abc", timestamp: 1_700_000_000, nonce: "xyz", signature: "sig==" });
  });

  it("rejects anything else", () => {
    assert.equal(parseAuthorization(null), undefined);
    assert.equal(parseAuthorization("Bearer token"), undefined);
    assert.equal(parseAuthorization("DL-Sig keyId=abc, nonce=xyz, sig=s"), undefined);
    assert.equal(parseAuthorization("DL-Sig keyId=abc, ts=soon, nonce=xyz, sig=s"), undefined);
  });
});

describe("Ed25519 verification", () => {
  it("accepts a signature over the canonical request", async () => {
    const { keyId, sign } = await keyPair();
    const canonical = canonicalRequest({ method: "POST", path: "/v1/names", query: "", timestamp: 1, nonce: "n", bodySha256: "h" });
    assert.equal(await verifyEd25519(keyId, await sign(canonical), canonical), true);
  });

  it("rejects a signature over something else", async () => {
    const { keyId, sign } = await keyPair();
    const signature = await sign("POST\n/v1/names\n\n1\nn\nh");
    assert.equal(await verifyEd25519(keyId, signature, "POST\n/v1/names\n\n1\nn\nother"), false);
  });

  it("rejects a malformed key or signature instead of throwing", async () => {
    assert.equal(await verifyEd25519("not-a-key", "not-a-signature", "message"), false);
  });
});

describe("clock skew", () => {
  it("allows five minutes either way", () => {
    assert.equal(withinClockSkew(1_000, 1_300), true);
    assert.equal(withinClockSkew(1_000, 700), true);
    assert.equal(withinClockSkew(1_000, 1_301), false);
    assert.equal(withinClockSkew(1_000, 699), false);
  });
});

describe("nonces", () => {
  it("are base64url and unique", () => {
    const first = newNonce();
    assert.doesNotMatch(first, /[+/=]/);
    assert.notEqual(first, newNonce());
  });
});
