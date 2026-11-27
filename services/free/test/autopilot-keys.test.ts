import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { completion, createService, errorCode, MODEL, usage, type OpenRouterHandler, type Service } from "./harness.js";
import { buy, DL, emailSignIn, FakeStripe, PAID_VARS } from "./paid-fixtures.js";
import { parseAccountId, parseAutopilotKey } from "../src/accounts.js";
import { SAFEGUARD_MODEL } from "../src/presend-guard.js";

// After the harness: account-object.js loads cloudflare:workers, which the harness resolves.
const { AUTOPILOT_KEY_TTL_MS } = await import("../src/account-object.js");

/**
 * Autopilot keys (`dl_ak_`): dl trades the person's dl key (`dl_sk_`) for a short-lived key that
 * only the Autopilot it launches gets. Requests with it count as Autopilot (GPT-6 and the paid
 * plans' $2/week GPT-6.1 Sol launch bonus, with the safety identifier and the pre-send guard);
 * the same dl key in any other tool still gets no GPT-6. Only the dl key refreshes it, so a copy
 * dies within AUTOPILOT_KEY_TTL_MS once dl stops refreshing.
 */

const SOL = "gpt-6.1-sol";
const MIN = 60_000;
const KEYS = { OPENAI_API_KEY: "sk-openai-test", LIQUID_INFERENCE_API_KEY: "sk-liquid", LIQUID_STATUS: "on", DL_ONLY: "false", SPEED_PROBES: "false" };

async function world() {
  const service = await createService(
    { ...PAID_VARS, ...KEYS, PAID_PLANS: "true", GPT6_BONUS: "true", GPT6_PRESEND_GUARD: "enforce", GPT6_GUARD_TIMEOUT_MS: "200", GPT6_TRUSTED_WEEKLY_USD_CAP: "5" },
    { userEmail: true },
  );
  const openRouter: OpenRouterHandler = (body) =>
    body.model === SAFEGUARD_MODEL
      ? Response.json({ id: "sg", object: "chat.completion", model: SAFEGUARD_MODEL, choices: [{ index: 0, message: { role: "assistant", content: "0" } }], usage: usage(900, 30, 0, 0.0002) })
      : completion(usage(100, 10));
  service.setOpenRouter(openRouter);
  const stripe = new FakeStripe(service);
  const session = await buy(service, stripe, "starter", "pat@example.com");
  const signedIn = await emailSignIn(service, "pat@example.com", session.id);
  await service.settle();
  const account = parseAccountId(signedIn.account.accountId)!;
  const dlKey = await apiKey(service, signedIn.token, "dl");
  return { service, account, token: signedIn.token, dlKey };
}

async function apiKey(service: Service, token: string, name: string): Promise<string> {
  const made = await service.request("POST", "/web/api-keys", { token, body: { name }, headers: DL });
  assert.equal(made.status, 201, await made.clone().text());
  return ((await made.json()) as { key: string }).key;
}

async function mint(service: Service, dlKey: string): Promise<{ id: string; key: string; expiresAt: string; ttlSeconds: number }> {
  const made = await service.request("POST", "/v1/autopilot-keys", { token: dlKey });
  assert.equal(made.status, 201, await made.clone().text());
  return (await made.json()) as { id: string; key: string; expiresAt: string; ttlSeconds: number };
}

const chat = (service: Service, token: string, model: string) =>
  service.request("POST", "/v1/chat/completions", { token, body: { model, messages: [{ role: "user", content: "hello" }] } });

const refresh = (service: Service, token: string, id: string) => service.request("POST", `/v1/autopilot-keys/${id}/refresh`, { token });

describe("Autopilot keys: the GPT-6 launch bonus in the Autopilot dl launches", () => {
  it("serves GPT-6.1 Sol on the bonus with the Autopilot key, never with the same dl key in another tool", async () => {
    const { service, account, dlKey } = await world();
    // The dl key in any other tool: GPT-6 held back (Autopilot only), not listed either.
    const asTool = await chat(service, dlKey, SOL);
    assert.equal(asTool.status, 402, await asTool.clone().text());
    assert.equal(((await asTool.json()) as any).error.reason, "autopilot_only");
    const toolModels = (await (await service.request("GET", "/v1/models", { token: dlKey })).json()) as any;
    assert.ok(!toolModels.data.some((model: any) => model.id === SOL), "a dl key isn't offered GPT-6");
    assert.equal(service.calls.openai.length, 0);

    const made = await mint(service, dlKey);
    assert.equal(made.ttlSeconds, AUTOPILOT_KEY_TTL_MS / 1000);
    assert.equal(parseAutopilotKey(made.key)?.account, account, "the key names the dl.new account (acct:<n>), not a GitHub id");
    assert.ok(made.key.startsWith(`dl_ak_${account.toString(36)}_`));

    assert.equal((await service.request("GET", "/v1/models", { token: made.key })).status, 200);
    const served = await chat(service, made.key, SOL);
    assert.equal(served.status, 200, await served.clone().text());
    const call = service.calls.openai.at(-1)!;
    assert.equal(call.body.model, SOL);
    assert.match(String(call.body.safety_identifier), /^dl-[0-9a-f]{32}$/, "the per-person safety identifier");
    assert.ok(service.calls.openRouter.some((one) => one.body.model === SAFEGUARD_MODEL), "the pre-send guard ran");
    await service.settle();
    const state = await (service.namespaces.ACCOUNT as any).getByName(`acct:${account}`).planState(service.clock.now, []);
    assert.ok(state.bonusUsd > 0, "metered on the $2/week bonus");

    // Still a tool key afterwards: minting one changes nothing for the dl key.
    assert.equal((await chat(service, dlKey, SOL)).status, 402);
    // DeepSeek works with both.
    assert.equal((await chat(service, made.key, MODEL)).status, 200);
    assert.equal((await chat(service, dlKey, MODEL)).status, 200);
  });

  it("takes Autopilot's session events, and only the Autopilot routes", async () => {
    const { service, dlKey } = await world();
    const { key } = await mint(service, dlKey);
    const events = await service.request("POST", "/v1/events", {
      token: key,
      body: { events: [{ id: "s1-1", type: "session.start", sessionId: "s1", at: new Date(service.clock.now).toISOString(), props: {} }] },
    });
    assert.equal(events.status, 202, await events.clone().text());
    assert.equal((await service.request("GET", "/v1/me", { token: key })).status, 200);
    assert.equal((await service.request("GET", "/v1/usage", { token: key })).status, 200);
    // Not a key for anything else: the Anthropic endpoint, other agents' keys, more Autopilot keys.
    const anthropic = await service.request("POST", "/anthropic/v1/messages", { token: key, body: { model: MODEL, max_tokens: 10, messages: [{ role: "user", content: "hi" }] } });
    assert.equal(anthropic.status, 401);
    assert.equal((await service.request("POST", "/v1/harness-keys", { token: key, body: { harness: "opencode" } })).status, 401);
    assert.equal((await service.request("POST", "/v1/autopilot-keys", { token: key })).status, 401);
  });

  it("lives 15 minutes from its last refresh by the dl key, and a copy dies once refreshes stop", async () => {
    const { service, dlKey } = await world();
    const made = await mint(service, dlKey);
    // dl refreshes every few minutes while Autopilot runs: well past one TTL, it still works.
    for (let i = 0; i < 6; i++) {
      service.clock.now += 4 * MIN;
      const refreshed = await refresh(service, dlKey, made.id);
      assert.equal(refreshed.status, 200, await refreshed.clone().text());
    }
    assert.equal((await chat(service, made.key, MODEL)).status, 200);
    // The key can't keep itself alive.
    const self = await refresh(service, made.key, made.id);
    assert.equal(self.status, 403);
    // dl stops (or the key was copied out): dead within the TTL.
    service.clock.now += AUTOPILOT_KEY_TTL_MS - MIN;
    assert.equal((await chat(service, made.key, MODEL)).status, 200);
    service.clock.now += MIN;
    const expired = await chat(service, made.key, MODEL);
    assert.equal(expired.status, 401);
    assert.equal(await errorCode(expired), "invalid_token", "Autopilot asks dl for the current key on invalid_token");
    // An expired key isn't revived by a refresh: dl mints a new one.
    const late = await refresh(service, dlKey, made.id);
    assert.equal(late.status, 404);
    assert.equal(await errorCode(late), "autopilot_key_not_found");
    const again = await mint(service, dlKey);
    assert.equal((await chat(service, again.key, SOL)).status, 200);
  });

  it("is refreshed only by the dl key that made it, and ends with that key or by itself", async () => {
    const { service, token, dlKey } = await world();
    const other = await apiKey(service, token, "cursor");
    const made = await mint(service, dlKey);
    // Another dl key of the same account can't refresh or revoke it.
    assert.equal((await refresh(service, other, made.id)).status, 404);
    assert.equal((await service.request("DELETE", `/v1/autopilot-keys/${made.id}`, { token: other })).status, 404);
    // Revoking the dl key ends the Autopilot keys it made at once.
    const list = (await (await service.request("GET", "/web/api-keys", { token, headers: DL })).json()) as any;
    const parent = (list.keys ?? list).find((key: any) => key.name === "dl");
    assert.ok(parent, JSON.stringify(list));
    const revoked = await service.request("DELETE", `/web/api-keys/${parent.id}`, { token, headers: DL });
    assert.ok(revoked.status < 300, await revoked.clone().text());
    assert.equal((await chat(service, made.key, MODEL)).status, 401);

    // A key may revoke itself (Autopilot or dl on exit).
    const fresh = await mint(service, other);
    const bye = await service.request("DELETE", `/v1/autopilot-keys/${fresh.id}`, { token: fresh.key });
    assert.equal(bye.status, 200, await bye.clone().text());
    assert.equal((await chat(service, fresh.key, MODEL)).status, 401);
  });

  it("refuses no auth, a wrong dl key and a forged Autopilot key", async () => {
    const { service, dlKey } = await world();
    // Garbage or no auth: the API-key wording.
    const none = await service.request("POST", "/v1/autopilot-keys", {});
    assert.equal(none.status, 401);
    const wrong = await service.request("POST", "/v1/autopilot-keys", { token: `${dlKey.slice(0, -4)}AAAA` });
    assert.equal(wrong.status, 401);
    // An unknown Autopilot key on chat: invalid_token.
    const made = await mint(service, dlKey);
    const forged = `${made.key.slice(0, -4)}AAAA`;
    assert.equal(await errorCode(await chat(service, forged, MODEL)), "invalid_token");
  });
});
