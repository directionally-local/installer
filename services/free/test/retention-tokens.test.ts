import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, createService, MODEL } from "./harness.js";

/**
 * Retention counts only people who could use dl (they had free tokens at sign-up), and the
 * sign-up funnel next to it shows the rest: refused, and refused but opened dl that day.
 */

const BAR = {
  OPENAI_API_KEY: "sk-test",
  OPEN_ADMISSION: "true",
  STARTER_WEEKLY_TOKENS: "0",
  FULL_MIN_ACCOUNT_AGE_DAYS: "365",
  FULL_MIN_CONTRIBUTIONS: "100",
  FULL_MIN_PUBLIC_REPOS: "100000",
  NETWORK_SIGNUPS_PER_DAY: "1000",
  DOMAIN_SIGNUPS_PER_DAY: "1000",
};
const OLD = "2019-01-01T00:00:00Z";
const YOUNG = "2026-06-01T00:00:00Z";

describe("retention on people who could use dl", () => {
  it("leaves people refused free tokens out of the cohorts, and counts them in the sign-up funnel", async () => {
    const s = await createService(BAR);
    const admin = (await s.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    await s.signIn({ id: 100, login: "dev", createdAt: OLD, publicRepos: 0, contributions: 250, activeWeeks: 30 }); // Full
    await s.signIn({ id: 101, login: "mid", createdAt: OLD, publicRepos: 0, contributions: 10 }); // basic
    const refused = (await s.signIn({ id: 102, login: "new1", createdAt: YOUNG, publicRepos: 0, contributions: 3 })).access_token; // Starter, no tokens
    await s.signIn({ id: 103, login: "new2", createdAt: YOUNG, publicRepos: 0, contributions: 3 }); // Starter, never opened dl
    // An admin's grant counts as having tokens.
    await s.signIn({ id: 104, login: "granted", createdAt: YOUNG, publicRepos: 0, contributions: 3 });
    assert.equal((await s.request("POST", "/v1/admin/grant", { token: admin, body: { logins: ["granted"] } })).status, 200);
    // The refused one opens dl and is refused.
    const response = await s.request("POST", "/v1/chat/completions", { token: refused, body: { model: MODEL, messages: [{ role: "user", content: "hi" }] } });
    assert.equal(response.status, 403);

    const metrics = (await (await s.request("GET", "/v1/admin/metrics", { token: admin })).json()) as { cohorts: Array<Record<string, any>>; signupFunnel: Array<Record<string, any>> };
    // 100 and 101 had tokens at sign-up; 104 got them later from an admin, but signed up without: refused at sign-up.
    assert.equal(metrics.cohorts.length, 1);
    assert.equal(metrics.cohorts[0]!.size, 2);
    assert.deepEqual(metrics.signupFunnel, [{ day: "2026-11-04", signedUp: 5, gotTokens: 2, refused: 3, refusedOpened: 1 }]);
  });

  it("counts an admin's pre-grant as tokens at sign-up", async () => {
    const s = await createService(BAR);
    s.setGithubProfile((login) => Response.json({ login, id: 105, type: "User", email: null }));
    const admin = (await s.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    assert.equal((await s.request("POST", "/v1/admin/grant", { token: admin, body: { logins: ["pre"] } })).status, 200);
    await s.signIn({ id: 105, login: "pre", createdAt: YOUNG, publicRepos: 0, contributions: 3 });
    const metrics = (await (await s.request("GET", "/v1/admin/metrics", { token: admin })).json()) as { signupFunnel: Array<Record<string, any>> };
    assert.equal(metrics.signupFunnel[0]!.gotTokens, 1);
  });
});
