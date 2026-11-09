import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, createService, errorCode, startBrowserFlow } from "./harness.js";

const BAR = { OPENAI_API_KEY: "sk-test", OPEN_ADMISSION: "true", STARTER_WEEKLY_TOKENS: "0", FULL_MIN_ACCOUNT_AGE_DAYS: "365", FULL_MIN_CONTRIBUTIONS: "100", FULL_MIN_PUBLIC_REPOS: "100000" };
const body = { model: "gpt-6-luna", messages: [{ role: "user", content: "hi" }] };

describe("below the bar, with no Starter allowance", () => {
  it("refuses free tokens with who they're for and how to ask for credits", async () => {
    const service = await createService(BAR);
    await service.signIn({ id: ADMIN_ID, login: "owner" });
    const tokens = await service.signIn({ id: 200, login: "newbie", createdAt: "2026-10-01T00:00:00Z", publicRepos: 0, contributions: 3 });
    const res = await service.request("POST", "/v1/chat/completions", { token: tokens.access_token, body });
    assert.equal(res.status, 403);
    const err = ((await res.clone().json()) as { error: { code: string; message: string } }).error;
    assert.equal(err.code, "below_bar");
    assert.match(err.message, /established GitHub accounts: at least 1 year old with 100\+ contributions in the last year\./);
    assert.match(err.message, /Email contact@directionallylocal\.com and tell us what you want to build with dl/);
    assert.doesNotMatch(err.message, /repositories/, "the switched-off repos path isn't mentioned");
    assert.equal(service.calls.openai.length + service.calls.luminal.length, 0, "nothing reaches a provider");
  });

  it("shows the same line on the sign-in page, and serves accounts above the bar", async () => {
    const service = await createService(BAR);
    await service.signIn({ id: ADMIN_ID, login: "owner" });
    const flow = await startBrowserFlow(service.request, { id: 201, login: "newbie2", createdAt: "2026-10-01T00:00:00Z", publicRepos: 0, contributions: 3 }, undefined, { stopAtDetails: true });
    assert.match(flow.page, /Email contact@directionallylocal\.com and tell us what you want to build/);
    const dev = await service.signIn({ id: 202, login: "dev", createdAt: "2019-01-01T00:00:00Z", publicRepos: 0, contributions: 250, activeWeeks: 30 });
    assert.equal((await service.request("POST", "/v1/chat/completions", { token: dev.access_token, body })).status, 200);
  });
});
