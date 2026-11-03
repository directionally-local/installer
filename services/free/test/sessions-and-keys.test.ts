import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, completion, createInvite, createService, errorCode, MODEL, usage, type Service, type Tokens } from "./harness.js";

async function setup(): Promise<{ service: Service; admin: string; alice: Tokens; invite: () => Promise<string> }> {
  const service = await createService();
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const alice = await service.signIn({ id: 100, login: "alice" }, { invite: await createInvite(service, admin) });
  return { service, admin, alice, invite: () => createInvite(service, admin) };
}

const me = (service: Service, token: string) => service.request("GET", "/v1/me", { token });
const refresh = (service: Service, refreshToken: string) => service.request("POST", "/v1/token/refresh", { body: { refresh_token: refreshToken } });
const chat = (service: Service, token: string) => service.request("POST", "/v1/chat/completions", { token, body: { model: MODEL, messages: [] } });

describe("sign-out (POST /v1/token/revoke)", () => {
  it("ends the session: refresh fails and the access token stops working at once", async () => {
    const { service, alice } = await setup();
    const response = await service.request("POST", "/v1/token/revoke", { token: alice.access_token, body: { refresh_token: alice.refresh_token } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { revoked: true, sessions: 1 });
    assert.equal(await errorCode(await refresh(service, alice.refresh_token)), "invalid_grant");
    assert.equal(await errorCode(await me(service, alice.access_token)), "invalid_token");
  });

  it("with only the access token, also ends that session's refresh tokens", async () => {
    const { service, alice } = await setup();
    assert.equal((await service.request("POST", "/v1/token/revoke", { token: alice.access_token })).status, 200);
    assert.equal(await errorCode(await refresh(service, alice.refresh_token)), "invalid_grant");
  });

  it("with only the refresh token (the access token expired), also stops that session's access tokens", async () => {
    const { service, alice } = await setup();
    const rotated = (await (await refresh(service, alice.refresh_token)).json()) as Tokens;
    assert.equal((await service.request("POST", "/v1/token/revoke", { body: { refresh_token: rotated.refresh_token } })).status, 200);
    assert.equal(await errorCode(await refresh(service, rotated.refresh_token)), "invalid_grant");
    for (const token of [alice.access_token, rotated.access_token]) assert.equal(await errorCode(await me(service, token)), "invalid_token", "every access token from the session");
  });

  it("leaves the person's other sessions signed in", async () => {
    const { service, alice } = await setup();
    const laptop = await service.signIn({ id: 100, login: "alice" });
    await service.request("POST", "/v1/token/revoke", { token: alice.access_token, body: { refresh_token: alice.refresh_token } });
    assert.equal((await me(service, laptop.access_token)).status, 200);
    assert.equal((await refresh(service, laptop.refresh_token)).status, 200);
  });

  it("won't end someone else's session through a refresh token in the body", async () => {
    const { service, admin, alice } = await setup();
    const bob = await service.signIn({ id: 101, login: "bob" }, { invite: await createInvite(service, admin) });
    const response = await service.request("POST", "/v1/token/revoke", { token: alice.access_token, body: { refresh_token: bob.refresh_token } });
    assert.deepEqual(await response.json(), { revoked: true, sessions: 1 });
    assert.equal((await refresh(service, bob.refresh_token)).status, 200, "bob is still signed in");
  });

  it("succeeds for unknown refresh tokens, and needs some credential", async () => {
    const { service } = await setup();
    assert.deepEqual(await (await service.request("POST", "/v1/token/revoke", { body: { refresh_token: "unknown" } })).json(), { revoked: true, sessions: 0 });
    assert.equal((await service.request("POST", "/v1/token/revoke", { body: {} })).status, 400);
    assert.equal(await errorCode(await service.request("POST", "/v1/token/revoke", { token: "garbage" })), "invalid_token");
  });
});

describe("admin: revoke all of one person's tokens", () => {
  it("ends every session and deletes every server key; the person can sign in again", async () => {
    const { service, admin, alice } = await setup();
    const laptop = await service.signIn({ id: 100, login: "alice" });
    const created = (await (await service.request("POST", "/v1/keys", { token: alice.access_token, body: { name: "build-box" } })).json()) as { key: string };

    assert.equal((await service.request("POST", "/admin/people/100/revoke-tokens", { token: alice.access_token })).status, 403);
    const response = await service.request("POST", "/admin/people/100/revoke-tokens", { token: admin });
    assert.deepEqual(await response.json(), { githubId: 100, sessions: 2, serverKeys: 1 });

    for (const tokens of [alice, laptop]) {
      assert.equal(await errorCode(await me(service, tokens.access_token)), "invalid_token");
      assert.equal(await errorCode(await refresh(service, tokens.refresh_token)), "invalid_grant");
    }
    assert.equal(await errorCode(await chat(service, created.key)), "invalid_key");

    const again = await service.signIn({ id: 100, login: "alice" });
    assert.equal((await me(service, again.access_token)).status, 200);
    assert.equal((await service.request("POST", "/admin/people/999/revoke-tokens", { token: admin })).status, 404);
  });
});

describe("server keys", () => {
  it("creates a key shown once, lists it without the secret, and charges the same account", async () => {
    const { service, admin, alice } = await setup();
    const created = await service.request("POST", "/v1/keys", { token: alice.access_token, body: { name: "  hetzner-1  " } });
    assert.equal(created.status, 201);
    const body = (await created.json()) as { id: string; name: string; key: string; createdAt: string; lastUsedAt: null };
    assert.match(body.key, /^dlk_100_[a-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
    assert.equal(body.name, "hetzner-1");
    assert.equal(body.createdAt, "2026-11-04T12:00:00.000Z");
    assert.equal(body.lastUsedAt, null);

    service.setOpenRouter(() => completion(usage(100, 10)));
    service.clock.now += 5000;
    const used = await chat(service, body.key);
    assert.equal(used.status, 200);
    const allowance = ((await (await me(service, alice.access_token)).json()) as { allowance: { usedThisWeek: number } }).allowance;
    assert.equal(allowance.usedThisWeek, 110, "the key's usage is the account's usage");

    const listed = await service.request("GET", "/v1/keys", { token: alice.access_token });
    const text = await listed.text();
    assert.ok(!text.includes(body.key.split("_").at(-1)!), "the secret is never listed");
    assert.deepEqual(JSON.parse(text), { keys: [{ id: body.id, name: "hetzner-1", createdAt: "2026-11-04T12:00:00.000Z", lastUsedAt: "2026-11-04T12:00:05.000Z" }], max: 5 });

    const people = await (await service.request("GET", "/admin/people", { token: admin })).text();
    assert.ok(!people.includes("dlk_"));
    assert.equal((JSON.parse(people) as { people: Array<{ githubId: number; serverKeys: number }> }).people.find((person) => person.githubId === 100)!.serverKeys, 1);
    assert.equal(((await (await service.request("GET", "/admin/people/100", { token: admin })).json()) as { serverKeys: number }).serverKeys, 1);
  });

  it("stores only a hash of the secret", async () => {
    const { service, alice } = await setup();
    const { key } = (await (await service.request("POST", "/v1/keys", { token: alice.access_token, body: { name: "box" } })).json()) as { key: string };
    const state = (service.namespaces.ACCOUNT!.instances.get("gh:100") as { state: { db: { prepare(sql: string): { all(): unknown[] } } } }).state;
    const dump = JSON.stringify(state.db.prepare("SELECT * FROM server_keys").all());
    assert.ok(!dump.includes(key.split("_").at(-1)!));
  });

  it("keeps working after the access token has expired", async () => {
    const { service, alice } = await setup();
    const { key } = (await (await service.request("POST", "/v1/keys", { token: alice.access_token, body: { name: "box" } })).json()) as { key: string };
    service.clock.now += 3 * 3600_000;
    assert.equal(await errorCode(await me(service, alice.access_token)), "invalid_token");
    assert.equal((await chat(service, key)).status, 200);
    assert.equal((await service.request("GET", "/v1/models", { token: key })).status, 200);
    assert.equal((await me(service, key)).status, 200);
  });

  it("can't manage keys or reach admin routes", async () => {
    const service = await createService();
    const owner = await service.signIn({ id: ADMIN_ID, login: "owner" });
    const { key } = (await (await service.request("POST", "/v1/keys", { token: owner.access_token, body: { name: "box" } })).json()) as { key: string };
    assert.equal(await errorCode(await service.request("GET", "/v1/keys", { token: key })), "invalid_token");
    assert.equal(await errorCode(await service.request("POST", "/v1/keys", { token: key, body: { name: "another" } })), "invalid_token");
    assert.equal(await errorCode(await service.request("GET", "/admin/people", { token: key })), "invalid_token");
  });

  it("revokes a key", async () => {
    const { service, alice } = await setup();
    const { id, key } = (await (await service.request("POST", "/v1/keys", { token: alice.access_token, body: { name: "box" } })).json()) as { id: string; key: string };
    const deleted = await service.request("DELETE", `/v1/keys/${id}`, { token: alice.access_token });
    assert.deepEqual(await deleted.json(), { id, revoked: true });
    const refused = await chat(service, key);
    assert.equal(refused.status, 401);
    assert.equal(await errorCode(refused), "invalid_key");
    assert.equal(await errorCode(await service.request("DELETE", `/v1/keys/${id}`, { token: alice.access_token })), "key_not_found");
  });

  it("only its owner can revoke a key", async () => {
    const { service, admin, alice } = await setup();
    const bob = await service.signIn({ id: 101, login: "bob" }, { invite: await createInvite(service, admin) });
    const { id, key } = (await (await service.request("POST", "/v1/keys", { token: alice.access_token, body: { name: "box" } })).json()) as { id: string; key: string };
    assert.equal((await service.request("DELETE", `/v1/keys/${id}`, { token: bob.access_token })).status, 404);
    assert.equal((await chat(service, key)).status, 200);
  });

  it("caps keys per account and refuses duplicate or bad names", async () => {
    const { service, alice } = await setup();
    const create = (name: unknown) => service.request("POST", "/v1/keys", { token: alice.access_token, body: { name } });
    const ids: string[] = [];
    for (let index = 0; index < 5; index++) ids.push(((await (await create(`box-${index}`)).json()) as { id: string }).id);
    const sixth = await create("box-5");
    assert.equal(sixth.status, 409);
    assert.equal(await errorCode(sixth), "key_limit_reached");
    await service.request("DELETE", `/v1/keys/${ids[0]}`, { token: alice.access_token });
    assert.equal((await create("box-5")).status, 201);

    await service.request("DELETE", `/v1/keys/${ids[1]}`, { token: alice.access_token });
    assert.equal(await errorCode(await create("box-2")), "key_name_taken");
    for (const bad of ["", "   ", "x".repeat(65), "tab\there", 42, undefined]) assert.equal((await create(bad)).status, 400, JSON.stringify(bad));
  });

  it("refuses tampered keys and keys pointed at another account", async () => {
    const { service, admin, alice } = await setup();
    await service.signIn({ id: 101, login: "bob" }, { invite: await createInvite(service, admin) });
    const { key } = (await (await service.request("POST", "/v1/keys", { token: alice.access_token, body: { name: "box" } })).json()) as { key: string };
    const secret = key.split("_").slice(3).join("_");
    const flipped = key.slice(0, -1) + (key.endsWith("A") ? "B" : "A");
    for (const bad of [flipped, key.replace("dlk_100_", "dlk_101_"), "dlk_100_short", `dlk_0_abcdefabcdef_${secret}`]) {
      const response = await chat(service, bad);
      assert.equal(response.status, 401, bad);
      assert.equal(await errorCode(response), "invalid_key");
    }
  });

  it("is refused while its account is suspended", async () => {
    const { service, admin, alice } = await setup();
    const { key } = (await (await service.request("POST", "/v1/keys", { token: alice.access_token, body: { name: "box" } })).json()) as { key: string };
    await service.request("POST", "/admin/people/100/suspend", { token: admin });
    assert.equal(await errorCode(await chat(service, key)), "suspended");
    assert.equal(await errorCode(await service.request("POST", "/v1/keys", { token: alice.access_token, body: { name: "other" } })), "suspended");
  });

  it("isn't affected by signing out", async () => {
    const { service, alice } = await setup();
    const { key } = (await (await service.request("POST", "/v1/keys", { token: alice.access_token, body: { name: "box" } })).json()) as { key: string };
    await service.request("POST", "/v1/token/revoke", { token: alice.access_token, body: { refresh_token: alice.refresh_token } });
    assert.equal((await chat(service, key)).status, 200);
  });
});
