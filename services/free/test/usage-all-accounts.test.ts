import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, completion, createService, MODEL, usage, type Service } from "./harness.js";
import { DL, githubRoundTrip, PAGE_STATE, PAID_VARS } from "./paid-fixtures.js";

/**
 * dl.new's usage page for accounts without a paid plan (free tier, admins, legacy dl Pro): every
 * settled request goes on the per-model meters, so /web/usage and the live box show it, with no
 * limit bars. The meters only record; the free allowance is charged once, as before.
 */

async function world() {
  return createService({ ...PAID_VARS, PAID_PLANS: "true", SPEED_PROBES: "false", DL_ONLY: "false" }, { userEmail: true });
}

/** A dl.new web session for an existing GitHub account. */
async function webToken(service: Service, user: { id: number; login: string; email: string }): Promise<string> {
  const fragment = await githubRoundTrip(service, user);
  const response = await service.request("POST", "/web/auth/github/session", { body: { code: fragment.slice("signin=".length), state: PAGE_STATE }, headers: DL });
  assert.equal(response.status, 200, await response.clone().text());
  return ((await response.json()) as { token: string }).token;
}

describe("/web/usage for accounts without a paid plan", () => {
  for (const [label, id] of [
    ["a free-tier account", 4242],
    ["an admin", ADMIN_ID],
  ] as const) {
    it(`shows ${label}'s requests, without limit bars, and charges its allowance once`, async () => {
      const service = await world();
      const user = { id, login: `user${id}`, email: `user${id}@example.com` };
      const api = (await service.signIn(user)).access_token;
      service.setOpenRouter(() => completion(usage(1_000, 20, 500)));
      service.setLuminal(() => completion(usage(1_000, 20, 500)));
      for (let i = 0; i < 2; i++) {
        const chat = await service.request("POST", "/v1/chat/completions", { token: api, body: { model: MODEL, messages: [{ role: "user", content: "hello" }] } });
        assert.equal(chat.status, 200, await chat.clone().text());
      }
      await service.settle();
      const token = await webToken(service, user);

      const week = (await (await service.request("GET", "/web/usage", { token, headers: DL })).json()) as any;
      assert.equal(week.plan, "none");
      assert.equal(week.totals.requests, 2);
      assert.equal(week.totals.realTokens, 2 * 1_020);
      assert.equal(week.totals.cachedInput, 2 * 500);
      assert.equal(week.totals.output, 2 * 20);
      assert.deepEqual(week.models.map((model: any) => [model.model, model.requests, model.limit]), [[MODEL, 2, null]], "usage without a limit");
      assert.deepEqual(week.tools.map((tool: any) => [tool.tool, tool.requests]), [["autopilot", 2]]);

      const me = (await (await service.request("GET", "/web/account", { token, headers: DL })).json()) as any;
      assert.equal(me.limits, null, "no plan, no bars");

      // The allowance is charged once per request, exactly what the meter counted.
      const allowance = (await (await service.request("GET", "/v1/me", { token: api })).json()) as any;
      assert.equal(allowance.budgets.deepseek.tokensThisWeek, week.totals.realTokens);
      assert.equal(allowance.pools.deepseek.usedThisWeek, week.totals.countedTokens);

      const live = (await (await service.request("GET", "/web/usage/live", { token, headers: DL })).json()) as any;
      assert.equal(live.connected, true);
      assert.equal(live.requests.length, 2);
    });
  }
});
