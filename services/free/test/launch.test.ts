import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, authorize, completion, createService, MODEL, NOW, usage, type Service, type Tokens } from "./harness.js";
import { etaAt, forecast, queueOrder, shouldQueue, waitText } from "../src/queue.js";
import { codeFor, networkOf, normalizeReferralCode } from "../src/referrals.js";
import { alertRequest, crossed, deliverAlerts, mimeMessage, resolveKind, weeklySpendAlert } from "../src/alerts.js";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
/** Monday 00:00 UTC of the harness week (NOW is Wednesday 2026-11-04). */
const MONDAY = Date.parse("2026-11-02T00:00:00Z");
const NEXT_MONDAY = MONDAY + WEEK;
const OLD = "2015-01-01T00:00:00Z";

type Request = Service["request"];
const from = (service: Service, ip: string): Request => (method, path, options = {}) => service.request(method, path, { ...options, ip });

let keys = 0;

/** A fresh admin access token (the clock may have moved past the last one's hour). */
async function adminToken(service: Service): Promise<string> {
  return (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
}

interface SignUpOptions {
  ip?: string;
  referral?: string;
  refInBrowser?: string;
  deviceId?: string;
}

/** Device sign-in from one network, optionally with a referral code (terminal or `?ref=`). */
async function signUp(
  service: Service,
  who: { id: number; login: string; createdAt?: string } & SignUpOptions,
  more: SignUpOptions = {},
): Promise<{ tokens: Tokens; page: string }> {
  const { ip, referral, refInBrowser, deviceId, ...user } = { ...who, ...more };
  const options = { ip, referral, refInBrowser, deviceId };
  const request = from(service, options.ip ?? `198.51.100.${user.id % 250}`);
  const body: Record<string, unknown> = {};
  if (options.referral) body.referral_code = options.referral;
  if (options.deviceId) body.device_id = options.deviceId;
  const issued = (await (await request("POST", "/v1/device/code", { body })).json()) as { device_code: string; user_code: string };
  let state: string;
  let cookie: string;
  if (options.refInBrowser) {
    const confirm = await (await request("GET", `/device?user_code=${issued.user_code}&ref=${encodeURIComponent(options.refInBrowser)}`)).text();
    const href = /href="([^"]*device\/authorize[^"]*)"/.exec(confirm)![1]!.replace(/&amp;/g, "&");
    assert.match(href, /ref=/);
    const response = await request("GET", href);
    state = new URL(response.headers.get("location")!).searchParams.get("state")!;
    cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  } else {
    ({ state, cookie } = await authorize(request, issued.user_code));
  }
  const callback = await request("GET", `/device/callback?code=${encodeURIComponent(JSON.stringify({ createdAt: OLD, ...user }))}&state=${encodeURIComponent(state)}`, { headers: { cookie } });
  const page = await callback.text();
  const token = await request("POST", "/v1/device/token", { body: { device_code: issued.device_code } });
  assert.equal(token.status, 200, `${user.login}: ${page}`);
  const tokens = (await token.json()) as Tokens;
  // Tests jump weeks ahead, past an access token's hour: use a server key as the bearer.
  const key = await request("POST", "/v1/keys", { token: tokens.access_token, body: { name: `test-${user.id}-${++keys}` } });
  assert.equal(key.status, 201, await key.clone().text());
  return { tokens: { ...tokens, access_token: ((await key.json()) as { key: string }).key }, page };
}

async function openService(vars: Record<string, string> = {}, options: { email?: boolean } = {}): Promise<{ service: Service; admin: string }> {
  const service = await createService({ OPEN_ADMISSION: "true", ALERT_WEBHOOK_URL: "https://alerts.test/hook", ...vars }, options);
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  return { service, admin };
}

/** Free spend by a non-admin, as the request log would record it. */
async function spend(service: Service, usd: number, at = NOW, githubId = 999): Promise<unknown> {
  return service.directory().recordRequest(
    { githubId, isAdmin: false, at, model: MODEL, promptTokens: 1, completionTokens: 1, cachedTokens: 0, chargedTokens: 2, costUsd: usd, status: "ok", latencyMs: 1 },
    { adminIds: [ADMIN_ID], weeklyTokens: 50_000_000, perPersonWeeklyUsdCap: 5, globalWeeklyUsdCap: 250, globalTotalUsdCap: 1000, queueThreshold: 0.8, queueReferralPlaces: 25, referralBonusTokens: 10_000_000, referralBonusCap: 50_000_000 },
  );
}

/** A request on each of these days (Unix ms), so weekly activity counts. */
async function activeOn(service: Service, githubId: number, days: number[]): Promise<void> {
  for (const at of days) {
    await service.directory().recordRequest({ githubId, isAdmin: false, at, model: MODEL, promptTokens: 1, completionTokens: 1, cachedTokens: 0, chargedTokens: 2, costUsd: 0, status: "ok", latencyMs: 1 });
  }
}

let caller = 0;
/** GET /v1/me from a fresh address each time, so the per-IP API limit never interferes. */
const me = async (service: Service, token: string) => {
  const response = await service.request("GET", "/v1/me", { token, ip: `10.9.${Math.floor(++caller / 250) % 250}.${caller % 250}` });
  const body = (await response.json()) as Record<string, any>;
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
};

/** Free spend through the real chat path (so alerts are delivered), by one big spender. */
const spenders = new WeakMap<Service, string>();
async function spendLive(service: Service, usd: number): Promise<void> {
  let token = spenders.get(service);
  if (!token) spenders.set(service, (token = (await signUp(service, { id: 4242, login: "spender", ip: "192.0.2.250" })).tokens.access_token));
  service.setOpenRouter(() => completion(usage(10, 10, 0, usd)));
  const response = await service.request("POST", "/v1/chat/completions", { token, ip: `10.8.0.${++caller % 250}`, body: { model: MODEL, messages: [{ role: "user", content: "hi" }] } });
  assert.equal(response.status, 200, await response.clone().text());
}
const chat = (service: Service, token: string) => service.request("POST", "/v1/chat/completions", { token, body: { model: MODEL, messages: [{ role: "user", content: "hi" }] } });

const OFFERS = { pro: { priceUsdMonthly: 10, tokensPerWeek: 100_000_000 }, topup: { priceUsd: 3, tokens: 50_000_000, validDays: 30 } };

describe("queue maths", () => {
  const policy = { globalWeeklyUsdCap: 250, globalTotalUsdCap: 1000, queueThreshold: 0.8, perPersonWeeklyUsdCap: 5 };

  it("admits the largest N with avg × (actives + N) ≤ threshold × cap", () => {
    // $150 over 30 actives: $5 each. 0.8 × 250 = 200 → 40 people in all, so 10 more.
    assert.deepEqual(forecast({ lastWeekUsd: 150, lastWeekActives: 30, policy, totalSpentUsd: 0 }), { avgUsd: 5, actives: 30, budgetUsd: 200, room: 10 });
    // $2 each: 100 in all, 70 more.
    assert.equal(forecast({ lastWeekUsd: 60, lastWeekActives: 30, policy, totalSpentUsd: 0 }).room, 70);
    // Already over the forecast: nobody.
    assert.equal(forecast({ lastWeekUsd: 300, lastWeekActives: 30, policy, totalSpentUsd: 0 }).room, 0);
    // No data: the per-person cap is the estimate.
    assert.equal(forecast({ lastWeekUsd: 0, lastWeekActives: 0, policy, totalSpentUsd: 0 }).room, 40);
    // What's left of the all-time cap bounds the budget: $50 left at $5 each, 30 actives → none.
    assert.equal(forecast({ lastWeekUsd: 150, lastWeekActives: 30, policy, totalSpentUsd: 950 }).room, 0);
    assert.equal(forecast({ lastWeekUsd: 10, lastWeekActives: 10, policy, totalSpentUsd: 900 }).room, 90);
    // No weekly cap: everyone.
    assert.equal(forecast({ lastWeekUsd: 10, lastWeekActives: 10, policy: { ...policy, globalWeeklyUsdCap: undefined }, totalSpentUsd: 0 }).budgetUsd, null);
  });

  it("queues at the threshold, or whenever anyone is already waiting", () => {
    const rules = { globalWeeklyUsdCap: 250, queueThreshold: 0.8 };
    assert.equal(shouldQueue({ weekUsd: 199.99, queueLength: 0, policy: rules }), false);
    assert.equal(shouldQueue({ weekUsd: 200, queueLength: 0, policy: rules }), true);
    assert.equal(shouldQueue({ weekUsd: 0, queueLength: 1, policy: rules }), true);
    assert.equal(shouldQueue({ weekUsd: 1e9, queueLength: 0, policy: { globalWeeklyUsdCap: undefined, queueThreshold: 0.8 } }), false);
  });

  it("orders oldest first, 25 places up per active friend", () => {
    const waiting = Array.from({ length: 60 }, (_, index) => ({ githubId: 1000 + index, queuedAt: index, activeFriends: 0 }));
    waiting[50]!.activeFriends = 1; // place 51 → 26
    waiting[40]!.activeFriends = 2; // place 41 → front
    const order = queueOrder(waiting, 25).map((person) => person.githubId);
    assert.equal(order.indexOf(1040), 0);
    // 25 places up from 51 is 26, and one more for 1040, who moved past both.
    assert.equal(order.indexOf(1050) + 1, 27);
    assert.equal(order.indexOf(1025) + 1, 28, "the person who held that place moves back one");
    assert.equal(order.indexOf(1000), 1);
  });

  it("estimates the wait in whole Mondays", () => {
    assert.equal(etaAt(1, 10, NOW), NEXT_MONDAY);
    assert.equal(etaAt(10, 10, NOW), NEXT_MONDAY);
    assert.equal(etaAt(11, 10, NOW), NEXT_MONDAY + WEEK);
    assert.equal(etaAt(5, 0, NOW), NEXT_MONDAY + 4 * WEEK, "at least one a week");
    assert.equal(waitText(NEXT_MONDAY, NOW), "about 5 days");
    assert.equal(waitText(NOW + 1000, NOW), "about 1 day");
    assert.equal(waitText(NOW + 21 * DAY, NOW), "about 3 weeks");
  });
});

describe("open sign-up and the queue", () => {
  it("lets old enough accounts in instantly while spend is under 80%", async () => {
    const { service } = await openService();
    await spend(service, 199);
    const { tokens } = await signUp(service, { id: 100, login: "Alice" });
    const body = await me(service, tokens.access_token);
    assert.equal(body.queue, null);
    assert.equal(body.allowance.tokensPerWeek, 50_000_000);
    assert.equal((await chat(service, tokens.access_token)).status, 200);
  });

  it("queues new sign-ups at 80% with a place and a wait; existing people keep their allowance; alerts once", async () => {
    const { service, admin } = await openService();
    const early = await signUp(service, { id: 100, login: "early" });
    await spend(service, 200);
    service.calls.webhooks.length = 0;

    const first = await signUp(service, { id: 200, login: "Waiting1" });
    assert.match(first.page, /in line for them/);
    const second = await signUp(service, { id: 201, login: "waiting2" });

    const body = await me(service, second.tokens.access_token);
    assert.equal(body.queue.position, 2);
    assert.equal(body.queue.etaAt, new Date(NEXT_MONDAY).toISOString());
    assert.equal(body.allowance.remaining, 0);
    assert.equal(body.plan, "free");
    assert.equal(body.topupTokensLeft, 0);
    assert.deepEqual(body.offers, OFFERS);
    assert.equal(body.referral.link, "https://dl.new/r/waiting2");

    const refused = await chat(service, first.tokens.access_token);
    assert.equal(refused.status, 402);
    const error = ((await refused.json()) as { error: Record<string, unknown> }).error;
    assert.deepEqual(error, {
      code: "free_tier_queued",
      message: "You're #1 in line for free tokens (about 5 days). Each friend who starts using dl moves you up. Your own key works now.",
      position: 1,
      etaAt: new Date(NEXT_MONDAY).toISOString(),
      offers: OFFERS,
      referralLink: "https://dl.new/r/waiting1",
    });
    assert.equal(service.calls.openRouter.length, 0);

    // Someone admitted before the queue started keeps going.
    assert.equal((await chat(service, early.tokens.access_token)).status, 200);

    // One "queue started" alert, not one per queued sign-up.
    const started = service.calls.webhooks.filter((hook) => String(hook.body.text).includes("queue started"));
    assert.equal(started.length, 1);

    const queue = (await (await service.request("GET", "/admin/queue", { token: admin })).json()) as { waiting: Array<{ githubId: number; position: number }> };
    assert.deepEqual(queue.waiting.map((person) => [person.position, person.githubId]), [[1, 200], [2, 201]]);
  });

  it("doesn't queue invited people or admins", async () => {
    const service = await createService({ OPEN_ADMISSION: "true" });
    const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    await spend(service, 240);
    const invite = ((await (await service.request("POST", "/admin/invites", { token: admin, body: { count: 1 } })).json()) as { invites: Array<{ code: string }> }).invites[0]!.code;
    const young = await service.signIn({ id: 300, login: "young", createdAt: "2026-10-30T00:00:00Z" }, { invite });
    assert.equal((await me(service, young.access_token)).queue, null);
    assert.equal((await me(service, admin)).queue, null);
  });

  it("admits from the queue on Monday as the forecast allows, front of the line first, with referral boosts", async () => {
    const { service, admin } = await openService({ GLOBAL_WEEKLY_USD_CAP: "50", PER_PERSON_WEEKLY_USD_CAP: "20" });
    await spend(service, 40); // 80% of $50: the queue starts
    const tokens: Tokens[] = [];
    for (let id = 200; id < 205; id++) tokens.push((await signUp(service, { id, login: `q${id}` })).tokens);
    // q204, last in line, referred someone who became weekly active: 25 places up, to the front.
    await service.directory().admit({ githubId: 500, login: "friend", isAdmin: false, inviteCode: undefined, clientDeviceId: null, accountTooNew: false, openAdmission: true, inviteOnly: false, maxActive: 0, referralCode: "q204", networkHash: "elsewhere", now: NOW });
    await activeOn(service, 500, [MONDAY, MONDAY + DAY, MONDAY + 2 * DAY]);
    assert.equal((await me(service, tokens[4]!.access_token)).queue.position, 1);
    assert.equal((await me(service, tokens[0]!.access_token)).queue.position, 2);

    // Monday: last week's actives were 999 ($40) and the friend ($0): avg $20, budget $40,
    // floor(40 / 20) − 2 = 0. Nobody gets in.
    service.clock.now = NEXT_MONDAY + 3_600_000;
    type QueueView = { runs: Array<Record<string, unknown>>; waiting: Array<{ githubId: number }> };
    let queue = (await (await service.request("GET", "/admin/queue", { token: await adminToken(service) })).json()) as QueueView;
    assert.deepEqual(queue.runs[0], { weekStart: "2026-11-09", ranAt: new Date(service.clock.now).toISOString(), admitted: 0, waitingBefore: 5, avgUsd: 20, actives: 2, budgetUsd: 40 });

    // The Monday after a quiet week: no data, so the per-person cap ($20) is the estimate:
    // floor(40 / 20) − 0 = 2 get in, front of the line first.
    service.clock.now = NEXT_MONDAY + WEEK + 3_600_000;
    const later = await adminToken(service);
    queue = (await (await service.request("GET", "/admin/queue", { token: later })).json()) as QueueView;
    assert.equal(queue.runs[0]!.admitted, 2);
    assert.deepEqual(queue.waiting.map((person) => person.githubId), [201, 202, 203]);
    assert.equal((await me(service, tokens[4]!.access_token)).queue, null);
    assert.equal((await me(service, tokens[0]!.access_token)).queue, null);
    const next = await me(service, tokens[1]!.access_token);
    assert.equal(next.queue.position, 1);
    // Two a week: #1 expects the next Monday.
    assert.equal(next.queue.etaAt, new Date(NEXT_MONDAY + 2 * WEEK).toISOString());
    // Admission runs once a week.
    queue = (await (await service.request("GET", "/admin/queue", { token: later })).json()) as QueueView;
    assert.equal(queue.waiting.length, 3);
  });

  it("admits N = floor(budget / avg) − actives on the Monday run", async () => {
    const { service } = await openService();
    // This week: 10 people active at $5 each ($50), then the queue starts at $200.
    for (let id = 1000; id < 1010; id++) await spend(service, 5, NOW, id);
    await spend(service, 150, NOW, 999); // the 11th active, $150: avg (50 + 150) / 11
    const queued: Tokens[] = [];
    for (let id = 200; id < 240; id++) queued.push((await signUp(service, { id, login: `q${id}`, ip: `192.0.2.${id - 190}` })).tokens);
    assert.equal((await me(service, queued[39]!.access_token)).queue.position, 40);

    service.clock.now = NEXT_MONDAY + 60_000;
    // avg = 200 / 11 ≈ 18.18; budget 200 → floor(11) − 11 = 0. Too expensive: nobody new.
    assert.notEqual((await me(service, queued[0]!.access_token)).queue, null);

    // Next week nobody spent anything: the fallback estimate ($5) applies, 200 / 5 − 0 = 40.
    service.clock.now = NEXT_MONDAY + WEEK + 60_000;
    for (const token of queued) assert.equal((await me(service, token.access_token)).queue, null);
    service.setOpenRouter(() => completion(usage(10, 10)));
    assert.equal((await chat(service, queued[0]!.access_token)).status, 200);
  });

  it("lets an admin admit by hand", async () => {
    const { service, admin } = await openService();
    await spend(service, 220);
    const waiting = await signUp(service, { id: 200, login: "w" });
    const response = await service.request("POST", "/admin/queue/admit", { token: admin, body: { count: 1 } });
    assert.deepEqual(await response.json(), { admitted: [200] });
    assert.equal((await me(service, waiting.tokens.access_token)).queue, null);
  });
});

describe("referrals", () => {
  it("normalizes codes and links, and keeps login-based codes", () => {
    assert.equal(normalizeReferralCode("SinaMeraji"), "sinameraji");
    assert.equal(normalizeReferralCode("https://dl.new/r/Foo-Bar"), "foo-bar");
    assert.equal(normalizeReferralCode("https://dl.new/r/foo?utm=x"), "foo");
    assert.equal(normalizeReferralCode("../etc"), undefined);
    assert.equal(normalizeReferralCode(""), undefined);
    assert.equal(normalizeReferralCode(5), undefined);
    assert.equal(codeFor("Alice", 42, false), "alice");
    assert.equal(codeFor("Alice", 42, true), "alice-16");
    assert.equal(networkOf("203.0.113.7"), "203.0.113.7");
    assert.equal(networkOf("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64");
    assert.equal(networkOf("2001:db8:1:2:bbbb:cccc:dddd:eeee"), "2001:db8:1:2::/64");
    assert.equal(networkOf("unknown"), undefined);
  });

  it("gives everyone a stable code mapped to the GitHub id, kept when the login changes", async () => {
    const { service } = await openService();
    const { tokens } = await signUp(service, { id: 100, login: "Alice" });
    assert.deepEqual((await me(service, tokens.access_token)).referral, {
      code: "alice",
      link: "https://dl.new/r/alice",
      joined: 0,
      activeThisWeek: 0,
      bonusTokensPerWeek: 0,
      bonusCapPerWeek: 50_000_000,
    });
    const renamed = await signUp(service, { id: 100, login: "alice-new" });
    assert.equal((await me(service, renamed.tokens.access_token)).referral.code, "alice");
    // The old login's next owner gets a distinct code.
    const next = await signUp(service, { id: 101, login: "alice" });
    assert.equal((await me(service, next.tokens.access_token)).referral.code, `alice-${(101).toString(36)}`);
  });

  it("pays +10M a week to both sides once the friend is weekly active, while both stay active", async () => {
    const { service } = await openService();
    const referrer = await signUp(service, { id: 100, login: "ref", ip: "198.51.100.1" });
    await signUp(service, { id: 101, login: "pal", ip: "198.51.100.2" }); // no code
    const friend2 = await signUp(service, { id: 102, login: "pal2", ip: "198.51.100.3", referral: "REF" });
    let body = await me(service, referrer.tokens.access_token);
    assert.equal(body.referral.joined, 1);
    assert.equal(body.referral.bonusTokensPerWeek, 0, "nobody is weekly active yet");

    // Two days each: not yet.
    await activeOn(service, 100, [MONDAY, MONDAY + DAY]);
    await activeOn(service, 102, [MONDAY, MONDAY + DAY]);
    assert.equal((await me(service, referrer.tokens.access_token)).referral.bonusTokensPerWeek, 0);
    // A third day each: both get 10M on top of 50M, and the dollar cap grows with it.
    await activeOn(service, 100, [MONDAY + 2 * DAY]);
    await activeOn(service, 102, [MONDAY + 2 * DAY]);
    body = await me(service, referrer.tokens.access_token);
    assert.equal(body.referral.bonusTokensPerWeek, 10_000_000);
    assert.equal(body.referral.activeThisWeek, 1);
    assert.equal(body.allowance.tokensPerWeek, 60_000_000);
    assert.equal(body.allowance.usdPerWeek, 6);
    const pal2 = await me(service, friend2.tokens.access_token);
    assert.equal(pal2.referral.bonusTokensPerWeek, 10_000_000);
    assert.equal(pal2.allowance.tokensPerWeek, 60_000_000);

    // Next week the bonus carries on from last week's activity…
    service.clock.now = NOW + WEEK;
    assert.equal((await me(service, referrer.tokens.access_token)).referral.bonusTokensPerWeek, 10_000_000);
    // …and stops the week after if the friend stopped.
    service.clock.now = NOW + 2 * WEEK;
    await activeOn(service, 100, [NEXT_MONDAY + WEEK, NEXT_MONDAY + WEEK + DAY, NEXT_MONDAY + WEEK + 2 * DAY]);
    assert.equal((await me(service, referrer.tokens.access_token)).referral.bonusTokensPerWeek, 0);
  });

  it("caps the referral bonus at 50M a week", async () => {
    const { service } = await openService();
    const referrer = await signUp(service, { id: 100, login: "ref", ip: "198.51.100.1" });
    const days = [MONDAY, MONDAY + DAY, MONDAY + 2 * DAY];
    await activeOn(service, 100, days);
    for (let id = 200; id < 207; id++) {
      await service.directory().admit({ githubId: id, login: `f${id}`, isAdmin: false, inviteCode: undefined, clientDeviceId: null, accountTooNew: false, openAdmission: true, inviteOnly: false, maxActive: 0, referralCode: "ref", networkHash: `net-${id}`, now: NOW });
      await activeOn(service, id, days);
    }
    const body = await me(service, referrer.tokens.access_token);
    assert.equal(body.referral.joined, 7);
    assert.equal(body.referral.activeThisWeek, 7);
    assert.equal(body.referral.bonusTokensPerWeek, 50_000_000);
    assert.equal(body.allowance.tokensPerWeek, 100_000_000);
  });

  it("carries a code from /device?ref= through GitHub sign-in", async () => {
    const { service } = await openService();
    const referrer = await signUp(service, { id: 100, login: "ref", ip: "198.51.100.1" });
    await signUp(service, { id: 101, login: "pal", ip: "198.51.100.2" }); // no code
    await signUp(service, { id: 102, login: "pal2", ip: "198.51.100.3", refInBrowser: "https://dl.new/r/Ref" });
    assert.equal((await me(service, referrer.tokens.access_token)).referral.joined, 1);
    const enter = await (await service.request("GET", "/device?ref=ref")).text();
    assert.match(enter, /name="ref" value="ref"/);
  });

  it("pays nothing for self-referral, an unknown code, or the same network", async () => {
    const { service } = await openService();
    const referrer = await signUp(service, { id: 100, login: "ref", ip: "198.51.100.1" });
    const self = await signUp(service, { id: 101, login: "me", ip: "198.51.100.2", referral: "me" });
    await signUp(service, { id: 102, login: "x", ip: "198.51.100.3", referral: "nobody" });
    const sameNet = await signUp(service, { id: 103, login: "twin", ip: "198.51.100.1", referral: "ref" });
    const days = [MONDAY, MONDAY + DAY, MONDAY + 2 * DAY];
    for (const id of [100, 101, 102, 103]) await activeOn(service, id, days);
    const body = await me(service, referrer.tokens.access_token);
    assert.equal(body.referral.joined, 0);
    assert.equal(body.referral.bonusTokensPerWeek, 0);
    assert.equal((await me(service, sameNet.tokens.access_token)).referral.bonusTokensPerWeek, 0);
    assert.equal((await me(service, self.tokens.access_token)).referral.bonusTokensPerWeek, 0);
    const rows = (service.namespaces.DIRECTORY!.instances.get("directory")!.state as { db: import("node:sqlite").DatabaseSync }).db
      .prepare("SELECT referred_id, outcome FROM referrals ORDER BY referred_id")
      .all();
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      { referred_id: 101, outcome: "self" },
      { referred_id: 102, outcome: "unknown_code" },
      { referred_id: 103, outcome: "same_network" },
    ]);
  });

  it("stops a referral when the two later sign in from the same network", async () => {
    const { service } = await openService();
    const referrer = await signUp(service, { id: 100, login: "ref", ip: "198.51.100.1" });
    await signUp(service, { id: 101, login: "pal", ip: "198.51.100.2", referral: "ref" });
    assert.equal((await me(service, referrer.tokens.access_token)).referral.joined, 1);
    await signUp(service, { id: 101, login: "pal", ip: "198.51.100.1" });
    assert.equal((await me(service, referrer.tokens.access_token)).referral.joined, 0);
  });

  it("refuses the same device for both sides", async () => {
    const { service } = await openService();
    await signUp(service, { id: 100, login: "ref", ip: "198.51.100.1", deviceId: "device-0001" });
    await assert.rejects(signUp(service, { id: 101, login: "pal", ip: "198.51.100.2", referral: "ref", deviceId: "device-0001" }));
  });
});

describe("GET /v1/referrals/<code>", () => {
  it("says whose code it is, and nothing else", async () => {
    const { service, admin } = await openService();
    await signUp(service, { id: 100, login: "Alice" });
    const found = await service.request("GET", "/v1/referrals/ALICE");
    assert.equal(found.status, 200);
    assert.equal(found.headers.get("cache-control"), "public, max-age=300");
    assert.deepEqual(await found.json(), { valid: true, login: "Alice", bonusTokensPerWeek: 10_000_000 });

    const missing = await service.request("GET", "/v1/referrals/nobody");
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("cache-control"), "public, max-age=300");
    assert.deepEqual(await missing.json(), { valid: false });
    assert.equal((await service.request("GET", "/v1/referrals/%E0%A4%A")).status, 404);

    await service.request("POST", "/admin/people/100/suspend", { token: admin });
    assert.deepEqual(await (await service.request("GET", "/v1/referrals/alice")).json(), { valid: false });
  });

  it("is rate-limited per IP", async () => {
    const { service } = await openService();
    let last: Response | undefined;
    for (let index = 0; index < 61; index++) last = await service.request("GET", "/v1/referrals/x", { ip: "192.0.2.99" });
    assert.equal(last!.status, 429);
    assert.equal((await service.request("GET", "/v1/referrals/x", { ip: "192.0.2.100" })).status, 404);
  });
});

describe("402 quota_exceeded", () => {
  it("carries the offers, the referral link and the reset time", async () => {
    const { service } = await openService({ WEEKLY_TOKENS: "300" });
    const { tokens } = await signUp(service, { id: 100, login: "Alice" });
    const response = await chat(service, tokens.access_token);
    assert.equal(response.status, 402);
    const error = ((await response.json()) as { error: Record<string, unknown> }).error;
    assert.equal(error.code, "quota_exceeded");
    assert.deepEqual(error.offers, OFFERS);
    assert.equal(error.referralLink, "https://dl.new/r/alice");
    assert.equal(error.resetsAt, new Date(NEXT_MONDAY).toISOString());
    assert.equal(error.reason, "tokens");
  });
});

describe("spend alerts", () => {
  it("fires once per threshold per week for the weekly cap, and once ever for the all-time cap", async () => {
    const { service } = await openService({ PER_PERSON_WEEKLY_USD_CAP: "none" });
    const texts = () => service.calls.webhooks.map((hook) => String(hook.body.text));
    await spendLive(service, 100);
    await spendLive(service, 20); // 48%: nothing yet
    assert.deepEqual(texts(), []);
    await spendLive(service, 5); // 50%
    assert.deepEqual(texts(), ["dl free tier: $125 of the $250 weekly cap used (50%). Resets Mon 00:00 UTC."]);
    await spendLive(service, 1);
    assert.equal(texts().length, 1, "50% fires once");
    await spendLive(service, 74); // 80%
    assert.equal(texts()[1], "dl free tier: $200 of the $250 weekly cap used (80%). Resets Mon 00:00 UTC.");
    await spendLive(service, 300); // 200% of the week, 50% of all time
    assert.deepEqual(texts().slice(2), [
      "dl free tier: $500 of the $250 weekly cap used (100%). Resets Mon 00:00 UTC.",
      "dl free tier: $500 of the $1,000 all-time cap used (50%). It doesn't reset; free tokens stop at 100% unless the cap is raised.",
    ]);
    // Next week: the weekly thresholds re-arm; the all-time 50% doesn't fire again.
    service.calls.webhooks.length = 0;
    service.clock.now = NOW + WEEK;
    await spendLive(service, 130);
    assert.deepEqual(texts(), ["dl free tier: $130 of the $250 weekly cap used (50%). Resets Mon 00:00 UTC."]);
  });

  it("sends one message for a jump past several thresholds", () => {
    assert.deepEqual(crossed(1.2, new Set()), { threshold: 1, mark: [0.5, 0.8, 1] });
    assert.deepEqual(crossed(0.85, new Set([0.5])), { threshold: 0.8, mark: [0.8] });
    assert.equal(crossed(0.85, new Set([0.5, 0.8])), undefined);
    assert.equal(crossed(0.49, new Set()), undefined);
  });

  it("formats for Discord, Slack and Telegram", () => {
    assert.equal(resolveKind("https://discord.com/api/webhooks/1/x", "auto"), "discord");
    assert.equal(resolveKind("https://hooks.slack.com/services/T/B/x", "auto"), "slack");
    assert.equal(resolveKind("https://api.telegram.org/bot123:abc/sendMessage", "auto"), "telegram");
    assert.equal(resolveKind("https://example.com/hook", "auto"), "generic");
    assert.equal(resolveKind("https://example.com/hook", "slack"), "slack");
    const text = "dl free tier: test";
    assert.deepEqual(JSON.parse(String(alertRequest("https://discord.com/api/webhooks/1/x", "auto", undefined, text).init.body)), { content: text, allowed_mentions: { parse: [] } });
    assert.deepEqual(JSON.parse(String(alertRequest("https://hooks.slack.com/services/T/B/x", "auto", undefined, text).init.body)), { text });
    const telegram = alertRequest("https://api.telegram.org/bot123:abc/sendMessage?chat_id=-1001", "auto", undefined, text);
    assert.equal(telegram.url, "https://api.telegram.org/bot123:abc/sendMessage");
    assert.deepEqual(JSON.parse(String(telegram.init.body)), { chat_id: "-1001", text, disable_web_page_preview: true });
    const configured = alertRequest("https://api.telegram.org/bot123:abc/sendMessage", "auto", "42", text);
    assert.equal(JSON.parse(String(configured.init.body)).chat_id, "42");
  });

  it("posts to a Telegram bot URL end to end", async () => {
    const { service } = await openService({ ALERT_WEBHOOK_URL: "https://api.telegram.org/bot123:abc/sendMessage", ALERT_TELEGRAM_CHAT_ID: "-100" });
    await spendLive(service, 130);
    assert.deepEqual(service.calls.webhooks, [
      { url: "https://api.telegram.org/bot123:abc/sendMessage", body: { chat_id: "-100", text: "dl free tier: $130 of the $250 weekly cap used (50%). Resets Mon 00:00 UTC.", disable_web_page_preview: true } },
    ]);
  });

  it("alerts on the kill switch", async () => {
    const { service, admin } = await openService();
    await service.request("POST", "/admin/pause", { token: admin });
    await service.request("POST", "/admin/pause", { token: admin }); // no change, no alert
    await service.request("POST", "/admin/unpause", { token: admin });
    assert.deepEqual(service.calls.webhooks.map((hook) => hook.body.text), [
      "dl free tier: free tokens paused for everyone by owner (kill switch).",
      "dl free tier: free tokens resumed by owner (kill switch off).",
    ]);
  });

  it("alerts once when a host fails more than 20% of its requests over an hour, and re-arms when it recovers", async () => {
    const { service } = await openService();
    const record = (failed: boolean, at: number) =>
      service.directory().recordRequest(
        { githubId: ADMIN_ID, isAdmin: true, at, model: MODEL, promptTokens: 0, completionTokens: 0, cachedTokens: 0, chargedTokens: 0, costUsd: 0, status: failed ? "upstream_error" : "ok", latencyMs: 1, host: "morph", ...(failed ? { hostFailure: { kind: "http_5xx", upstreamStatus: 502 } } : {}) },
        { adminIds: [ADMIN_ID], weeklyTokens: 1, perPersonWeeklyUsdCap: 5, globalWeeklyUsdCap: 250, globalTotalUsdCap: 1000, queueThreshold: 0.8, queueReferralPlaces: 25, referralBonusTokens: 1, referralBonusCap: 1 },
      );
    const sent: string[] = [];
    for (let index = 0; index < 16; index++) sent.push(...((await record(false, NOW + index * 1000)) as Array<{ text: string }>).map((a) => a.text));
    for (let index = 0; index < 4; index++) sent.push(...((await record(true, NOW + 20_000 + index * 1000)) as Array<{ text: string }>).map((a) => a.text));
    assert.equal(sent.length, 0, "4 of 20 is 20%: not more than 20%");
    sent.push(...((await record(true, NOW + 30_000)) as Array<{ text: string }>).map((a) => a.text));
    assert.deepEqual(sent, ["dl free tier: OpenRouter host morph failed 5 of 21 requests in the last hour (24%). New requests avoid it while it keeps failing."]);
    sent.push(...((await record(true, NOW + 31_000)) as Array<{ text: string }>).map((a) => a.text));
    assert.equal(sent.length, 1, "once while it keeps failing");
    // Two hours later, healthy again: re-armed.
    for (let index = 0; index < 20; index++) await record(false, NOW + 2 * 3_600_000 + index * 1000);
    const later: string[] = [];
    for (let index = 0; index < 8; index++) later.push(...((await record(true, NOW + 2 * 3_600_000 + 30_000 + index)) as Array<{ text: string }>).map((a) => a.text));
    assert.equal(later.length, 1);
  });

  it("sends email through the send_email binding, with the short line as the subject", async () => {
    const { service } = await openService({ ALERT_EMAIL_TO: "owner@example.com", ALERT_WEBHOOK_URL: "" }, { email: true });
    await spendLive(service, 200);
    assert.equal(service.calls.emails.length, 1);
    const [email] = service.calls.emails;
    assert.equal(email!.from, "alerts@dl.new");
    assert.equal(email!.to, "owner@example.com");
    const [head, body] = email!.raw.split("\r\n\r\n") as [string, string];
    assert.match(head, /^From: dl free tier <alerts@dl\.new>\r\n/);
    assert.match(head, /\r\nTo: <owner@example\.com>\r\n/);
    assert.match(head, /\r\nSubject: dl free tier: 80% of the \$250 weekly cap used\r\n/);
    assert.match(head, /\r\nMessage-ID: <[0-9a-f-]+@dl\.new>\r\n/);
    assert.match(head, /\r\nContent-Transfer-Encoding: base64$/);
    const text = new TextDecoder().decode(Uint8Array.from(atob(body.replace(/\r\n/g, "")), (char) => char.charCodeAt(0)));
    assert.match(text, /^dl free tier: \$200 of the \$250 weekly cap used \(80%\)\. Resets Mon 00:00 UTC\./);
    assert.match(text, /Admin dashboard: https:\/\/free\.test\/admin/);
    assert.equal(service.calls.webhooks.length, 0);
  });

  it("falls back to the webhook without the binding, and to the log with neither", async () => {
    const alert = weeklySpendAlert(200, 250, 0.8);
    const posted: string[] = [];
    const fetcher = async (url: string) => {
      posted.push(url);
      return new Response("ok");
    };
    const base = { alertEmailTo: "owner@example.com", alertEmailFrom: "alerts@dl.new", alertWebhookKind: "auto" as const, alertTelegramChatId: undefined };
    assert.deepEqual(await deliverAlerts({ alerts: [alert], config: { ...base, alertWebhookUrl: "https://hooks.slack.com/services/x" }, emailBinding: undefined, fetch: fetcher, adminUrl: "https://free.test/admin", now: NOW }), [["webhook"]]);
    assert.deepEqual(posted, ["https://hooks.slack.com/services/x"]);
    assert.deepEqual(await deliverAlerts({ alerts: [alert], config: { ...base, alertWebhookUrl: undefined }, emailBinding: undefined, fetch: fetcher, adminUrl: "x", now: NOW }), [["log"]]);
    const failing = { send: async () => Promise.reject(new Error("unverified destination")) };
    assert.deepEqual(await deliverAlerts({ alerts: [alert], config: { ...base, alertWebhookUrl: "https://hooks.slack.com/services/x" }, emailBinding: failing, fetch: fetcher, adminUrl: "x", now: NOW }), [["webhook"]]);
  });

  it("encodes a non-ASCII subject", () => {
    const raw = mimeMessage({ from: "alerts@dl.new", to: "a@example.com", subject: "dl free tier: café", body: "x", now: NOW, messageId: "m" });
    assert.match(raw, /\r\nSubject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\n/);
  });
});

describe("dashboard additions", () => {
  it("shows the all-time spend, the red banner at 80%, the queue, referrals and the funnel", async () => {
    const { service } = await openService();
    const cookie = await adminCookie(service);
    let html = await (await service.request("GET", "/admin", { headers: { cookie } })).text();
    assert.doesNotMatch(html, /class="banner"/);
    assert.match(html, /All-time free spend<b>\$0 <span class="muted">of \$1000<\/span>/);

    const referrer = await signUp(service, { id: 100, login: "ref", ip: "198.51.100.1" });
    await signUp(service, { id: 101, login: "pal", ip: "198.51.100.2", referral: "ref" });
    await activeOn(service, 100, [MONDAY, MONDAY + DAY, MONDAY + 2 * DAY]);
    await activeOn(service, 101, [MONDAY, MONDAY + DAY, MONDAY + 2 * DAY]);
    await spend(service, 205);
    await signUp(service, { id: 200, login: "waiting", ip: "198.51.100.3" });
    void referrer;

    html = await (await service.request("GET", "/admin", { headers: { cookie } })).text();
    assert.match(html, /<p class="banner" role="alert">82% of the \$250 weekly cap used \(\$205\)\.<\/p>/);
    assert.match(html, /Waiting now<b>1<\/b>/);
    assert.match(html, /Links used<b>1<\/b>/);
    assert.match(html, /Sign-ups via referral<b>1<\/b><span class="note">1 became weekly active/);
    assert.match(html, /Bonus tokens granted this week<b>20\.0M<\/b><span class="note">A week, across 2 people/);
    assert.match(html, /<h2>Funnel<\/h2>/);

    const funnel = (await (await service.request("GET", "/admin/dashboard/funnel.csv", { headers: { cookie } })).text()).trim().split("\r\n");
    assert.equal(funnel[0], "signup_week,signed_up,first_request,weekly_active");
    assert.equal(funnel[1], "all,3,2,2");
    const queue = (await (await service.request("GET", "/admin/dashboard/queue.csv", { headers: { cookie } })).text()).trim().split("\r\n");
    assert.match(queue[1]!, /^1,2026-11-04T12:00:00.000Z,/);
  });
});

async function adminCookie(service: Service): Promise<string> {
  const start = await service.request("GET", "/admin/signin");
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const oauthCookie = start.headers.get("set-cookie")!.split(";")[0]!;
  const response = await service.request("GET", `/device/callback?code=${encodeURIComponent(JSON.stringify({ id: ADMIN_ID, login: "owner" }))}&state=${encodeURIComponent(state)}`, { headers: { cookie: oauthCookie } });
  return response.headers.getSetCookie().find((cookie) => cookie.startsWith("__Host-dl_admin="))!.split(";")[0]!;
}
