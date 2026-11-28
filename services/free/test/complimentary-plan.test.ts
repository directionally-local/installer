import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, createService, type Service } from "./harness.js";

/**
 * POST /admin/people/:id/plan {plan, until} (ENG-26): a complimentary paid plan without Stripe,
 * so a test account can be non-admin and still reach paid models. {plan: null} clears it.
 */

const call = (service: Service, token: string, id: number, body: unknown) =>
  service.request("POST", `/admin/people/${id}/plan`, { token, body });

const errorOf = async (response: Response) => ((await response.json()) as { error: Record<string, string> }).error;

async function world() {
  const service = await createService({ OPEN_ADMISSION: "true", DL_ONLY: "false", PAID_PLANS: "true" });
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const token = (await service.signIn({ id: 100, login: "alice" })).access_token;
  return { service, admin, token };
}

describe("complimentary plans", () => {
  it("puts a person on a paid plan until a date, and logs who did it", async () => {
    const { service, admin } = await world();
    const until = new Date(service.clock.now + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const response = await call(service, admin, 100, { plan: "plus", until });
    assert.equal(response.status, 200, await response.clone().text());
    const body = (await response.json()) as { plan: string; until: string };
    assert.equal(body.plan, "plus");

    const state = await service.account(100).planState(service.clock.now);
    assert.equal(state.tier, "plus");

    const config = (await (await service.request("GET", "/admin/config", { token: admin })).json()) as {
      log: { key: string; changedByLogin: string; newValue: { plan: string } }[];
    };
    const entry = config.log.find((row) => row.key === "person_plan:100:alice");
    assert.ok(entry, JSON.stringify(config.log.map((row) => row.key)));
    assert.equal(entry.changedByLogin, "owner");
    assert.equal(entry.newValue.plan, "plus");
  });

  it("clears the plan again", async () => {
    const { service, admin } = await world();
    const until = new Date(service.clock.now + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    assert.equal((await call(service, admin, 100, { plan: "max", until })).status, 200);
    assert.equal((await call(service, admin, 100, { plan: null })).status, 200);
    const state = await service.account(100).planState(service.clock.now);
    assert.equal(state.tier, "none");
  });

  it("refuses a non-admin, a bad plan, a past date and an unknown person", async () => {
    const { service, admin, token } = await world();
    assert.equal((await call(service, token, 100, { plan: "plus" })).status, 403);
    assert.equal((await errorOf(await call(service, admin, 100, { plan: "enterprise", until: "2027-12-31" }))).code, "invalid_request");
    assert.equal((await errorOf(await call(service, admin, 100, { plan: "plus", until: "2020-01-01" }))).code, "invalid_request");
    assert.equal((await call(service, admin, 999, { plan: "plus", until: "2027-12-31" })).status, 404);
  });
});
