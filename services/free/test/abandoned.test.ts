import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, createService } from "./harness.js";

/**
 * A request whose caller hangs up before the upstream answers: on Workers the handler stops
 * there, so the reservation is never settled and the alarm sweeps it 30 minutes later. The
 * hang-up is modelled by an upstream that never answers (the handler never gets past it).
 */
describe("a reservation the request never settled", () => {
  it("is recorded on the provider that served it, not as OpenRouter cash, and charges no more than the prompt", async () => {
    const service = await createService({ OPEN_ADMISSION: "true", PRIMARY_UPSTREAM: "luminal", LUMINAL_API_KEY: "lum-test" });
    const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const person = await service.signIn({ id: 100, login: "alice" });
    service.setLuminal(() => new Promise<Response>(() => {})); // never answers: the caller hung up
    void service.request("POST", "/v1/chat/completions", {
      token: person.access_token,
      body: { model: "deepseek/deepseek-v4.1-flash-1017", stream: true, messages: [{ role: "user", content: "hello there" }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    service.clock.now += 31 * 60_000;
    assert.equal(await service.account(100).sweep(service.clock.now), 1, "one reservation was left");

    const spend = (await (await service.request("GET", "/v1/admin/spend", { token: admin })).json()) as Record<string, unknown>;
    const people = (await (await service.request("GET", "/v1/admin/people", { token: admin })).json()) as {
      people: Array<{ githubId: number; allowance: { usedThisWeek: number; spentUsdThisWeek: number } }>;
    };
    const alice = people.people.find((p) => p.githubId === 100)!;
    // Before the fix: $0.033 of "OpenRouter cash" and 32,824 tokens charged for a two-word prompt.
    assert.equal(spend.spentUsd, 0, "nothing went to OpenRouter, so no cash");
    assert.ok((spend.creditUsedUsd as number) > 0, "the prompt counts against Luminal's credit, the provider that was serving it");
    assert.ok(alice.allowance.usedThisWeek > 0 && alice.allowance.usedThisWeek < 1000, `charged ${alice.allowance.usedThisWeek} tokens for a two-word prompt`);
  });
});
