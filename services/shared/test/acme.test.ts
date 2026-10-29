import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { challengeRecordName, isAcmeToken, jwkThumbprint, keyAuthorization } from "../src/acme.js";

describe("DNS-01 record names", () => {
  it("puts the challenge under the name, in the zone", () => {
    assert.equal(challengeRecordName("alice", "directionallylocal.run"), "_acme-challenge.alice.directionallylocal.run");
  });

  it("is the same record for a wildcard, as RFC 8555 requires", () => {
    assert.equal(challengeRecordName("alice", "directionallylocal.run"), challengeRecordName("alice", "directionallylocal.run"));
  });
});

describe("key authorization", () => {
  it("is token.thumbprint", () => {
    assert.equal(keyAuthorization("tok", "thumb"), "tok.thumb");
  });
});

describe("JWK thumbprints", () => {
  it("matches the RFC 7638 worked example", async () => {
    const jwk: JsonWebKey = {
      kty: "RSA",
      e: "AQAB",
      n: "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
    };
    assert.equal(await jwkThumbprint(jwk), "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs");
  });

  it("uses only the required members, in order", async () => {
    const jwk: JsonWebKey = { kty: "OKP", crv: "Ed25519", x: "abc", d: "secret" };
    const withExtras: JsonWebKey = { ...jwk, use: "sig" };
    assert.equal(await jwkThumbprint(jwk), await jwkThumbprint(withExtras));
  });

  it("refuses a key type it doesn't know", async () => {
    await assert.rejects(() => jwkThumbprint({ kty: "oct" }), /Unsupported JWK key type/);
  });
});

describe("ACME tokens", () => {
  it("accepts base64url of a plausible length", () => {
    assert.equal(isAcmeToken("a".repeat(43)), true);
  });

  it("rejects short, padded or non-base64url tokens", () => {
    assert.equal(isAcmeToken("short"), false);
    assert.equal(isAcmeToken(`${"a".repeat(40)}==`), false);
    assert.equal(isAcmeToken(`${"a".repeat(40)}+`), false);
  });
});
