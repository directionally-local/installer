import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { base64urlEncode } from "../../shared/src/auth.js";
import { ADMIN_ID, createService, errorCode } from "./harness.js";

describe("tokens", () => {
  it("rotates refresh tokens: the new one works, the old one doesn't", async () => {
    const service = await createService();
    const first = await service.signIn({ id: ADMIN_ID, login: "owner" });
    const refreshed = await service.request("POST", "/v1/token/refresh", { body: { refresh_token: first.refresh_token } });
    assert.equal(refreshed.status, 200);
    const second = (await refreshed.json()) as typeof first;
    assert.notEqual(second.refresh_token, first.refresh_token);
    assert.equal(second.token_type, "Bearer");
    assert.equal((await service.request("GET", "/v1/me", { token: second.access_token })).status, 200);

    const reused = await service.request("POST", "/v1/token/refresh", { body: { refresh_token: first.refresh_token } });
    assert.equal(reused.status, 401);
    assert.equal(await errorCode(reused), "invalid_grant");
    assert.equal((await service.request("POST", "/v1/token/refresh", { body: { refresh_token: second.refresh_token } })).status, 200);
  });

  it("revokes the whole family when a rotated token is replayed later", async () => {
    const service = await createService();
    const first = await service.signIn({ id: ADMIN_ID, login: "owner" });
    const second = (await (await service.request("POST", "/v1/token/refresh", { body: { refresh_token: first.refresh_token } })).json()) as typeof first;
    service.clock.now += 60_000;
    assert.equal((await service.request("POST", "/v1/token/refresh", { body: { refresh_token: first.refresh_token } })).status, 401);
    assert.equal((await service.request("POST", "/v1/token/refresh", { body: { refresh_token: second.refresh_token } })).status, 401, "theft detected: the family is gone");
  });

  it("expires refresh tokens after 30 days and access tokens after an hour", async () => {
    const service = await createService();
    const tokens = await service.signIn({ id: ADMIN_ID, login: "owner" });
    service.clock.now += 3600_000 + 31_000;
    const expired = await service.request("GET", "/v1/me", { token: tokens.access_token });
    assert.equal(expired.status, 401);
    assert.equal(await errorCode(expired), "invalid_token");
    service.clock.now += 30 * 86_400_000;
    assert.equal(await errorCode(await service.request("POST", "/v1/token/refresh", { body: { refresh_token: tokens.refresh_token } })), "invalid_grant");
  });

  it("rejects tampered, unsigned and foreign tokens", async () => {
    const service = await createService();
    const { access_token } = await service.signIn({ id: ADMIN_ID, login: "owner" });
    const [header, payload] = access_token.split(".") as [string, string, string];
    const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
    const forged = base64urlEncode(new TextEncoder().encode(JSON.stringify({ ...claims, sub: "999" })));
    const none = base64urlEncode(new TextEncoder().encode(JSON.stringify({ alg: "none", typ: "JWT" })));
    for (const token of [`${header}.${forged}.${access_token.split(".")[2]}`, `${none}.${payload}.`, "garbage"]) {
      const response = await service.request("GET", "/v1/me", { token });
      assert.equal(response.status, 401);
      assert.equal(await errorCode(response), "invalid_token");
    }
    const other = await createService({ TOKEN_SIGNING_KEY: "another-key-another-key-another-key-0000" });
    assert.equal((await other.request("GET", "/v1/me", { token: access_token })).status, 401);
  });
});

describe("account", () => {
  it("returns the allowance and every free model", async () => {
    const service = await createService();
    const { access_token } = await service.signIn({ id: ADMIN_ID, login: "owner" });
    const response = await service.request("GET", "/v1/me", { token: access_token });
    const body = (await response.json()) as { login: string; githubId: number; allowance: Record<string, unknown>; models: string[] };
    assert.equal(body.login, "owner");
    assert.equal(body.githubId, ADMIN_ID);
    assert.equal(body.allowance.tokensPerWeek, 50_000_000);
    assert.equal(body.allowance.usedThisWeek, 0);
    assert.equal(body.allowance.remaining, 50_000_000);
    assert.equal(body.allowance.resetsAt, "2026-11-09T00:00:00.000Z");
    assert.deepEqual(body.models, ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra", "deepseek/deepseek-v4.1-flash-1017"]);

    const models = (await (await service.request("GET", "/v1/models", { token: access_token })).json()) as { object: string; data: Array<{ id: string; object: string }> };
    assert.equal(models.object, "list");
    assert.deepEqual(models.data.map((model) => [model.id, model.object]), [
      ["gpt-6-luna", "model"],
      ["gpt-6.1-sol", "model"],
      ["gpt-6-astra", "model"],
      ["deepseek/deepseek-v4.1-flash-1017", "model"],
    ]);
  });
});
