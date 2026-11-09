import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { milestoneCrossed } from "../src/alerts.js";
import { createService, NOW } from "./harness.js";

function record(githubId: number, upstream: "openai" | "luminal", creditUsd: number, at = NOW) {
  return { githubId, isAdmin: false, at, model: "gpt-6-luna", promptTokens: 1, completionTokens: 0, cachedTokens: 0, chargedTokens: 1, costUsd: creditUsd, status: "ok", latencyMs: 1, upstream, creditUsd };
}

describe("spend milestone emails", () => {
  it("picks the highest new milestone and marks every one passed", () => {
    assert.equal(milestoneCrossed(49.99, new Set()), undefined);
    assert.deepEqual(milestoneCrossed(120, new Set()), { milestone: 100, mark: [50, 100] });
    assert.equal(milestoneCrossed(120, new Set([50, 100])), undefined);
    assert.deepEqual(milestoneCrossed(210, new Set([50, 100])), { milestone: 200, mark: [200] });
  });

  it("sends one email per milestone across OpenAI and Luminal, with this week's top spenders", async () => {
    const service = await createService({ OPENAI_API_KEY: "sk-test", LUMINAL_API_KEY: "lum-test" });
    const dir = service.directory();
    await dir.admit({ githubId: 7, login: "alice", isAdmin: false, inviteCode: undefined, clientDeviceId: null, accountTooNew: false, openAdmission: true, inviteOnly: false, maxActive: 100, now: NOW });
    const subjects = async (r: ReturnType<typeof record>) => ((await dir.recordRequest(r)) as Array<{ subject: string; text: string }>).filter((a) => /spent so far/.test(a.subject));
    assert.deepEqual(await subjects(record(7, "openai", 30)), []);
    const at50 = await subjects(record(7, "luminal", 25));
    assert.equal(at50.length, 1);
    assert.equal(at50[0]!.subject, "dl free tier: $50 spent so far");
    assert.match(at50[0]!.text, /\$55 spent in total \(OpenAI \$30, Luminal \$25\)/);
    assert.match(at50[0]!.text, /Top this week: alice \$55/);
    assert.deepEqual(await subjects(record(7, "openai", 10)), [], "no repeat for $50");
    const at100 = await subjects(record(7, "openai", 50));
    assert.equal(at100[0]!.subject, "dl free tier: $100 spent so far");
  });
});
