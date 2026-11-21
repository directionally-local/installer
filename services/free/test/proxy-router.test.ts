import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, createInvite, createService, MODEL } from "./harness.js";
import { isProxyRouter } from "../src/abuse.js";
import { parseDetectionRules } from "../src/detection-rules.js";
import { SYNTHETIC_RULES_JSON } from "./detection-fixture.js";

describe("account-pooling routers", () => {
  it("matches 9router in the session id or user agent", () => {
    assert.equal(isProxyRouter("9router-ci-poll", null), true);
    assert.equal(isProxyRouter(undefined, "9Router/1.2"), true);
    assert.equal(isProxyRouter("fix-login-bug", "autopilot/3.28.1"), false);
  });

  it("uses the DETECTION_RULES secret's patterns instead of the default", async () => {
    const { rules } = parseDetectionRules(SYNTHETIC_RULES_JSON);
    assert.equal(isProxyRouter("acme-pool-7", null, rules), true);
    assert.equal(isProxyRouter(undefined, "ACME_POOL/2", rules), true);
    assert.equal(isProxyRouter("9router-ci-poll", null, rules), false, "the secret's list replaces the default");
    const service = await createService({ DETECTION_RULES: SYNTHETIC_RULES_JSON });
    const adminToken = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const { access_token } = await service.signIn({ id: 100, login: "alice" }, { invite: await createInvite(service, adminToken) });
    const response = await service.request("POST", "/v1/chat/completions", { token: access_token, body: { model: MODEL, session_id: "acme-pool-session", messages: [{ role: "user", content: "hello" }] } });
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "proxy_not_allowed");
  });

  it("refuses a chat request from a 9router session", async () => {
    const service = await createService();
    const adminToken = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const { access_token } = await service.signIn({ id: 100, login: "alice" }, { invite: await createInvite(service, adminToken) });
    const response = await service.request("POST", "/v1/chat/completions", { token: access_token, body: { model: MODEL, session_id: "9router-test-session-123", messages: [{ role: "user", content: "hello" }] } });
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "proxy_not_allowed");
  });
});
