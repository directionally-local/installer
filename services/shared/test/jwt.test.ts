import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { base64urlEncode, timingSafeEqual } from "../src/auth.js";
import { githubAuthorizeUrl, githubContributionsLastYear, githubSignInFromCode, githubUserFromCode, GITHUB_GRAPHQL_URL } from "../src/github.js";
import { hmacKey, signJwt, verifyJwt } from "../src/jwt.js";

const SECRET = "0123456789abcdef0123456789abcdef";

describe("HS256 JWT", () => {
  it("round-trips claims and enforces expiry", async () => {
    const key = await hmacKey(SECRET);
    const token = await signJwt({ sub: "42", iat: 1000, exp: 2000, login: "octo" }, key);
    assert.deepEqual(await verifyJwt(token, key, 1500), { sub: "42", iat: 1000, exp: 2000, login: "octo" });
    assert.equal(await verifyJwt(token, key, 2030), undefined);
    assert.equal(await verifyJwt(token, key, 900), undefined, "not yet issued");
  });

  it("rejects other keys, other algorithms and tampering", async () => {
    const key = await hmacKey(SECRET);
    const token = await signJwt({ sub: "42", iat: 1000, exp: 2000 }, key);
    assert.equal(await verifyJwt(token, await hmacKey(`${SECRET}!`), 1500), undefined);
    const [, payload, signature] = token.split(".");
    const none = base64urlEncode(new TextEncoder().encode(JSON.stringify({ alg: "none" })));
    assert.equal(await verifyJwt(`${none}.${payload}.${signature}`, key, 1500), undefined);
    assert.equal(await verifyJwt(`${token}x`, key, 1500), undefined);
    assert.equal(await verifyJwt("a.b", key, 1500), undefined);
  });

  it("refuses short keys", async () => {
    await assert.rejects(hmacKey("short"));
  });
});

describe("timingSafeEqual", () => {
  it("compares strings", () => {
    assert.equal(timingSafeEqual("abc", "abc"), true);
    assert.equal(timingSafeEqual("abc", "abd"), false);
    assert.equal(timingSafeEqual("abc", "abcd"), false);
    assert.equal(timingSafeEqual("", ""), true);
  });
});

describe("GitHub OAuth", () => {
  it("builds the authorize URL with the state", () => {
    const url = new URL(githubAuthorizeUrl({ clientId: "cid" }, "https://x.test/cb", "st"));
    assert.equal(url.searchParams.get("client_id"), "cid");
    assert.equal(url.searchParams.get("state"), "st");
    assert.equal(url.searchParams.get("redirect_uri"), "https://x.test/cb");
  });

  it("reads the user and drops the GitHub token", async () => {
    const fetcher = async (url: string) =>
      url.includes("access_token")
        ? Response.json({ access_token: "gho_x" })
        : Response.json({ id: 7, login: "octo", created_at: "2020-01-01T00:00:00Z", public_repos: 3 });
    assert.deepEqual(await githubUserFromCode({ clientId: "a", clientSecret: "b" }, "code", "https://x.test/cb", fetcher), {
      id: 7,
      login: "octo",
      createdAt: Date.parse("2020-01-01T00:00:00Z"),
      publicRepos: 3,
    });
    assert.equal((await githubSignInFromCode({ clientId: "a", clientSecret: "b" }, "code", "https://x.test/cb", fetcher))?.accessToken, "gho_x");
    const refused = async () => Response.json({ error: "bad_verification_code" });
    assert.equal(await githubUserFromCode({ clientId: "a", clientSecret: "b" }, "code", "https://x.test/cb", refused), undefined);
  });

  it("reads the last year's contribution count with the user's token, and throws on errors and timeouts", async () => {
    const seen: Array<{ url: string; auth: string | null; body: string }> = [];
    const answer = (body: unknown, status = 200) => async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: new Headers(init?.headers).get("authorization"), body: String(init?.body) });
      return Response.json(body, { status });
    };
    const calendar = (n: unknown) => ({ data: { viewer: { contributionsCollection: { contributionCalendar: { totalContributions: n } } } } });
    assert.equal(await githubContributionsLastYear("gho_x", answer(calendar(12))), 12);
    assert.equal(seen[0]!.url, GITHUB_GRAPHQL_URL);
    assert.equal(seen[0]!.auth, "Bearer gho_x");
    assert.match(seen[0]!.body, /contributionsCollection/);
    assert.equal(await githubContributionsLastYear("gho_x", answer(calendar(0))), 0);
    await assert.rejects(githubContributionsLastYear("gho_x", answer({ message: "Bad credentials" }, 401)));
    await assert.rejects(githubContributionsLastYear("gho_x", answer({ errors: [{ message: "rate limited" }] })));
    await assert.rejects(githubContributionsLastYear("gho_x", answer(calendar("lots"))));
    await assert.rejects(githubContributionsLastYear("gho_x", async () => { throw new TypeError("network down"); }));
    await assert.rejects(githubContributionsLastYear("gho_x", () => new Promise<Response>(() => {}), "dl", 20), /longer than 20 ms/);
  });
});
