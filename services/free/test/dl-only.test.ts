import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, createInvite, createService, MODEL, type Service } from "./harness.js";

const DL_ONLY = "Free tokens work inside dl only. Run dl to keep using them, or use your own API key in any tool.";
const HOUR = 3600_000;

async function member(vars: Record<string, string> = {}): Promise<{ service: Service; token: string; refreshToken: string; adminToken: string }> {
  const service = await createService(vars);
  const adminToken = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const tokens = await service.signIn({ id: 100, login: "alice" }, { invite: await createInvite(service, adminToken) });
  return { service, token: tokens.access_token, refreshToken: tokens.refresh_token, adminToken };
}

/** A day later, as Autopilot would: a fresh access token (they last an hour). */
async function nextDay(service: Service, refreshToken: string, hours: number): Promise<string> {
  service.clock.now += hours * HOUR;
  const response = await service.request("POST", "/v1/token/refresh", { body: { refresh_token: refreshToken } });
  assert.equal(response.status, 200);
  return ((await response.json()) as { access_token: string }).access_token;
}

const chat = (service: Service, token: string) => service.request("POST", "/v1/chat/completions", { token, body: { model: MODEL, messages: [{ role: "user", content: "hello" }] } });

/** `n` chat requests, a second apart (under the per-minute limit); the statuses. */
async function chats(service: Service, token: string, n: number): Promise<number[]> {
  const statuses: number[] = [];
  for (let index = 0; index < n; index++) {
    statuses.push((await chat(service, token)).status);
    service.clock.now += 1000;
  }
  return statuses;
}

let eventId = 0;
/** What Autopilot sends while the free tier is its provider. */
const sendEvent = (service: Service, token: string, sessionId = "s-1", type = "session.start") =>
  service.request("POST", "/v1/events", { token, body: { events: [{ id: `e${++eventId}`, type, sessionId, at: new Date(service.clock.now).toISOString() }] } });

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  return ((await response.json()) as { error: { code: string; message: string } }).error;
}

async function adminCookie(service: Service): Promise<string> {
  const start = await service.request("GET", "/admin/signin");
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const oauth = start.headers.get("set-cookie")!.split(";")[0]!;
  const done = await service.request("GET", `/device/callback?code=${encodeURIComponent(JSON.stringify({ id: ADMIN_ID, login: "owner" }))}&state=${encodeURIComponent(state)}`, { headers: { cookie: oauth } });
  return done.headers.getSetCookie().find((value) => value.startsWith("__Host-dl_admin="))!.split(";")[0]!;
}

const simpleView = async (service: Service, cookie: string) => (await service.request("GET", "/admin?view=simple", { headers: { cookie } })).text();

describe("free tokens inside dl only", () => {
  it("refuses an account with 20 requests and no session event in the last day, with dl_only", async () => {
    const { service, token, refreshToken } = await member();
    assert.deepEqual(await chats(service, token, 20), Array(20).fill(200));
    const refused = await chat(service, token);
    assert.equal(refused.status, 403);
    assert.deepEqual(await errorOf(refused), { code: "dl_only", message: DL_ONLY });
    assert.ok(refused.headers.get("x-dl-tokens-remaining"), "quota headers as on other refusals");
    const calls = service.calls.openai.length + service.calls.luminal.length + service.calls.openRouter.length;
    assert.equal((await chat(service, token)).status, 403);
    assert.equal(service.calls.openai.length + service.calls.luminal.length + service.calls.openRouter.length, calls, "nothing goes upstream");

    // Once the requests are older than a day, the count starts again.
    assert.equal((await chat(service, await nextDay(service, refreshToken, 24))).status, 200);
  });

  it("never refuses an account that sends session events, even when the first requests come before them", async () => {
    const { service, token: first, refreshToken } = await member();
    assert.deepEqual(await chats(service, first, 5), Array(5).fill(200));
    assert.equal((await sendEvent(service, first)).status, 202);
    assert.deepEqual(await chats(service, first, 40), Array(40).fill(200));
    // An event from more than a day ago doesn't count for today.
    const token = await nextDay(service, refreshToken, 25);
    assert.deepEqual(await chats(service, token, 20), Array(20).fill(200));
    assert.equal(await errorOf(await chat(service, token)).then((error) => error.code), "dl_only");
    await sendEvent(service, token, "s-2");
    assert.equal((await chat(service, token)).status, 200);
  });

  it("leaves admins out", async () => {
    const { service, adminToken } = await member();
    assert.deepEqual(await chats(service, adminToken, 25), Array(25).fill(200));
  });

  it("leaves server keys (dl's server mode) out, and doesn't count their requests", async () => {
    const { service, token } = await member();
    const { key } = (await (await service.request("POST", "/v1/keys", { token, body: { name: "box" } })).json()) as { key: string };
    assert.deepEqual(await chats(service, key, 25), Array(25).fill(200));
    // The same person on a laptop: the server's requests don't push the sign-in token over.
    assert.deepEqual(await chats(service, token, 19), Array(19).fill(200));
    assert.equal((await chat(service, key)).status, 200);
  });

  it("leaves paid usage out: Pro, and top-ups once the free tokens are refused", async () => {
    const pro = await member();
    await pro.service.account(100).applySubscription({ subscriptionId: "sub_1", state: "active", periodEnd: pro.service.clock.now + 30 * 24 * HOUR, eventAt: 1 });
    assert.deepEqual(await chats(pro.service, pro.token, 25), Array(25).fill(200));

    const { service, token } = await member();
    await chats(service, token, 20);
    assert.equal((await errorOf(await chat(service, token))).code, "dl_only");
    await service.account(100).grantTopup({ id: "t1", tokens: 1_000_000, createdAt: service.clock.now, expiresAt: service.clock.now + 30 * 24 * HOUR });
    assert.equal((await chat(service, token)).status, 200, "a top-up is paid usage");
  });

  it("is off when the runtime setting dlOnly is false, and on again without a deploy", async () => {
    const { service, token, adminToken } = await member();
    await chats(service, token, 20);
    assert.equal((await chat(service, token)).status, 403);
    const off = await service.request("POST", "/admin/config", { token: adminToken, body: { dlOnly: false } });
    assert.equal(off.status, 200);
    assert.equal((await chat(service, token)).status, 200);
    await service.request("POST", "/admin/config", { token: adminToken, body: { dlOnly: null } });
    assert.equal((await errorOf(await chat(service, token))).code, "dl_only");
  });

  it("is off with DL_ONLY=false in the env", async () => {
    const { service, token } = await member({ DL_ONLY: "false" });
    assert.deepEqual(await chats(service, token, 25), Array(25).fill(200));
  });
});

describe("free tokens used outside dl, on the dashboard", () => {
  it("flags an account with 10 requests and no session event in 7 days, until it sends one", async () => {
    const { service, token } = await member({ DL_ONLY: "false" });
    const cookie = await adminCookie(service);
    await chats(service, token, 9);
    assert.doesNotMatch(await simpleView(service, cookie), /Used outside dl/);
    await chats(service, token, 1);
    assert.match(await simpleView(service, cookie), /<a href="\/admin\?view=full#abuse">Used outside dl: alice \(10 requests, 0 dl sessions\)<\/a>/);
    await sendEvent(service, token);
    assert.doesNotMatch(await simpleView(service, cookie), /Used outside dl/);
  });

  it("leaves admins and server keys out of the flag", async () => {
    const { service, token, adminToken } = await member();
    const cookie = await adminCookie(service);
    const { key } = (await (await service.request("POST", "/v1/keys", { token, body: { name: "box" } })).json()) as { key: string };
    await chats(service, adminToken, 12);
    await chats(service, key, 12);
    assert.doesNotMatch(await simpleView(service, cookie), /Used outside dl/);
  });

  it("shows dl sessions this week per person in the people API and the full view", async () => {
    const { service, token, adminToken } = await member();
    await chats(service, token, 3);
    await sendEvent(service, token, "s-1");
    await sendEvent(service, token, "s-1", "turn.end");
    await sendEvent(service, token, "s-2");
    const { people } = (await (await service.request("GET", "/v1/admin/people", { token: adminToken })).json()) as { people: Array<{ login: string; dlSessionsThisWeek: number }> };
    assert.equal(people.find((person) => person.login === "alice")?.dlSessionsThisWeek, 2);
    assert.equal(people.find((person) => person.login === "owner")?.dlSessionsThisWeek, 0);

    const full = await (await service.request("GET", "/admin?view=full", { headers: { cookie: await adminCookie(service) } })).text();
    assert.match(full, /<th>dl sessions this week<\/th>/);
    assert.match(full, /alice[\s\S]*?<td>2<\/td><td>0<\/td><td class="l">/, "alice's row: 2 sessions, shares no network");
  });
});
