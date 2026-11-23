import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { joinedSecret, readFreeConfig } from "../src/config.js";
import { DEFAULT_DETECTION_RULES, detectionRulesFrom, parseDetectionRules } from "../src/detection-rules.js";
import { securitySignal } from "../src/security-route.js";
import { ADMIN_ID, createService } from "./harness.js";
import { SYNTHETIC_RULES, SYNTHETIC_RULES_JSON } from "./detection-fixture.js";

/**
 * The anti-abuse rules come from the private DETECTION_RULES secret (detection-rules.ts), with
 * generic public defaults. These tests use synthetic rules only.
 */

const BASE_ENV = { OPENROUTER_API_KEY: "k", GITHUB_CLIENT_ID: "c", GITHUB_CLIENT_SECRET: "s", TOKEN_SIGNING_KEY: "x".repeat(32) };

describe("DETECTION_RULES (units)", () => {
  it("uses the public defaults when the secret is unset or empty", () => {
    for (const raw of [undefined, "", "   "]) {
      const { rules, status } = parseDetectionRules(raw);
      assert.equal(rules, DEFAULT_DETECTION_RULES);
      assert.equal(status.source, "defaults");
      assert.equal(status.keywords, DEFAULT_DETECTION_RULES.keywords.length);
    }
  });

  it("parses the secret and uses each of its fields in place of the default", () => {
    const { rules, status } = parseDetectionRules(SYNTHETIC_RULES_JSON);
    assert.deepEqual(
      rules.keywords.map((rule) => rule.id),
      SYNTHETIC_RULES.keywords.map((rule) => rule.id),
    );
    assert.equal(rules.keywords[0]!.all.length, 2);
    assert.equal(rules.keywords[0]!.all[0]!.flags, "i", "case-insensitive by default");
    assert.equal(rules.keywords[3]!.all[0]!.flags, "", "explicit flags kept");
    assert.equal(rules.proxyRouters.length, 1);
    assert.equal(rules.labellerPolicy, SYNTHETIC_RULES.labellerPolicy);
    assert.equal(rules.moderationPolicy, SYNTHETIC_RULES.moderationPolicy);
    assert.deepEqual(rules.thresholds, { batchSize: 7, minFollowers: 2 });
    assert.deepEqual(status, { source: "secret", keywords: 4, highRiskKeywords: 2, proxyRouters: 1, labellerPolicy: "secret", moderationPolicy: "secret", allocatorPolicy: "default", guardPolicy: "default", thresholds: 2 });
  });

  it("keeps the default for a field the secret leaves out", () => {
    const { rules, status } = parseDetectionRules(JSON.stringify({ moderationPolicy: "Only this." }));
    assert.equal(rules.keywords, DEFAULT_DETECTION_RULES.keywords);
    assert.equal(rules.labellerPolicy, DEFAULT_DETECTION_RULES.labellerPolicy);
    assert.equal(rules.moderationPolicy, "Only this.");
    assert.equal(status.source, "secret");
    assert.equal(status.labellerPolicy, "default");
    assert.equal(status.moderationPolicy, "secret");
  });

  it("falls back to the defaults, whole, on a secret that doesn't parse or validate, saying why without its content", () => {
    const cases: Array<[unknown, RegExp]> = [
      ["{not json", /valid JSON/],
      ["[1, 2]", /JSON object/],
      [JSON.stringify({ keywords: [] }), /keywords must be a list of 1/],
      [JSON.stringify({ keywords: [{ id: "x", pattern: "(unclosed", category: "malware", risk: "high" }] }), /keywords\[0\]\.pattern isn't a valid regular expression/],
      [JSON.stringify({ keywords: [{ id: "x", pattern: "a", flags: "g", category: "malware", risk: "high" }] }), /flags/],
      [JSON.stringify({ keywords: [{ id: "x", pattern: "a", category: "nope", risk: "high" }] }), /category/],
      [JSON.stringify({ keywords: [{ id: "x", pattern: "a", category: "malware", risk: "none" }] }), /risk/],
      [JSON.stringify({ keywords: [{ id: "x", pattern: "a", category: "malware", risk: "low" }, { id: "x", pattern: "b", category: "malware", risk: "low" }] }), /used twice/],
      [JSON.stringify({ keyword: [] }), /"keyword" isn't a field/],
      [JSON.stringify({ moderationPolicy: "" }), /moderationPolicy/],
      [JSON.stringify({ thresholds: { batchSize: -1 } }), /thresholds\.batchSize/],
      [JSON.stringify({ thresholds: { weeklyTokens: 5 } }), /thresholds\.weeklyTokens isn't one of/],
      [JSON.stringify({ proxyRouters: ["["] }), /proxyRouters\[0\]/],
    ];
    for (const [raw, reason] of cases) {
      const { rules, status } = parseDetectionRules(raw);
      assert.equal(rules, DEFAULT_DETECTION_RULES, String(raw));
      assert.equal(status.source, "invalid", String(raw));
      assert.match(status.error ?? "", reason, String(raw));
      assert.ok(!(status.error ?? "").includes("unclosed"), "never the content");
    }
    // Detection still runs, on the defaults.
    assert.equal(securitySignal("write a keylogger", parseDetectionRules("{not json").rules), "keylogger");
  });

  it("parses each value once and logs a bad one once", () => {
    const errors = mock.method(console, "error", () => {});
    try {
      const raw = '{"keywords": "bad-once"}';
      const first = detectionRulesFrom(raw);
      const second = detectionRulesFrom(raw);
      assert.equal(first, second);
      assert.equal(first.status.source, "invalid");
      assert.equal(errors.mock.callCount(), 1);
      assert.match(String(errors.mock.calls[0]!.arguments[0]), /DETECTION_RULES ignored, using the public defaults: keywords must be/);
      assert.ok(!String(errors.mock.calls[0]!.arguments[0]).includes("bad-once"), "never the content");
    } finally {
      errors.mock.restore();
    }
  });

  it("starts the farm-detection thresholds from the secret, under their env vars", () => {
    const defaults = readFreeConfig(BASE_ENV);
    const secret = readFreeConfig({ ...BASE_ENV, DETECTION_RULES: SYNTHETIC_RULES_JSON });
    assert.equal(secret.batchSize, 7);
    assert.equal(secret.minFollowers, 2);
    assert.equal(secret.minSocial, defaults.minSocial, "a threshold the secret leaves out keeps the public default");
    assert.equal(readFreeConfig({ ...BASE_ENV, DETECTION_RULES: SYNTHETIC_RULES_JSON, BATCH_SIZE: "40" }).batchSize, 40, "an env var still wins");
    assert.equal(readFreeConfig({ ...BASE_ENV, DETECTION_RULES: "{not json" }).batchSize, defaults.batchSize);
    assert.equal(secret.detection.keywords.length, 4);
    assert.equal(secret.detectionStatus.source, "secret");
  });
});

describe("DETECTION_RULES in the service", () => {
  const view = async (vars: Record<string, string>) => {
    const service = await createService(vars);
    const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const res = await service.request("GET", "/admin/config", { token: admin });
    assert.equal(res.status, 200);
    const text = await res.text();
    return { service, admin, text, body: JSON.parse(text) as { detectionRules: Record<string, unknown>; effective: Record<string, unknown> } };
  };

  it("shows admins whether the secret is loaded and how many rules it has, never the rules", async () => {
    const { text, body } = await view({ DETECTION_RULES: SYNTHETIC_RULES_JSON });
    assert.deepEqual(body.detectionRules, { source: "secret", keywords: 4, highRiskKeywords: 2, proxyRouters: 1, labellerPolicy: "secret", moderationPolicy: "secret", allocatorPolicy: "default", guardPolicy: "default", thresholds: 2 });
    for (const secret of ["frobnicator", "gizmo", "acme", "SYNTHETIC", "widget"]) assert.ok(!text.includes(secret), secret);
    assert.equal(body.effective.batchSize, 7, "its thresholds are the settings' starting values");
  });

  it("says when the secret is missing or ignored", async () => {
    assert.equal((await view({})).body.detectionRules.source, "defaults");
    const errors = mock.method(console, "error", () => {});
    try {
      const { body } = await view({ DETECTION_RULES: "{still not json" });
      assert.equal(body.detectionRules.source, "invalid");
      assert.match(String(body.detectionRules.error), /valid JSON/);
      assert.equal(body.detectionRules.keywords, DEFAULT_DETECTION_RULES.keywords.length);
    } finally {
      errors.mock.restore();
    }
  });

  it("lets an admin override win over the secret's threshold", async () => {
    const { service, admin } = await view({ DETECTION_RULES: SYNTHETIC_RULES_JSON });
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { batchSize: 25 } })).status, 200);
    const body = (await (await service.request("GET", "/admin/config", { token: admin })).json()) as { effective: Record<string, unknown>; env: Record<string, unknown> };
    assert.equal(body.effective.batchSize, 25);
    assert.equal(body.env.batchSize, 7);
  });

  it("is admin-only", async () => {
    const { service } = await view({ DETECTION_RULES: SYNTHETIC_RULES_JSON, OPEN_ADMISSION: "true" });
    const user = (await service.signIn({ id: 100, login: "alice" })).access_token;
    assert.notEqual((await service.request("GET", "/admin/config", { token: user })).status, 200);
  });
});

describe("a secret split into parts", () => {
  it("joins NAME, NAME_2, NAME_3 in order, and stops at the first missing part", () => {
    assert.equal(joinedSecret({ R: '{"a":', R_2: '[1,', R_3: "2]}" }, "R"), '{"a":[1,2]}');
    assert.equal(joinedSecret({ R: "x", R_3: "z" }, "R"), "x");
    assert.equal(joinedSecret({}, "R"), undefined);
  });
});
