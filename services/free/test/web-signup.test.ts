import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, createService, errorCode, NOW, submitDetails, type GitHubUserFixture, type Service } from "./harness.js";
import { funnelTotals, webFunnelCsv } from "../src/web-signup.js";

/**
 * dl.new's web sign-up (web-signup.ts): the CLI's own browser sign-in, returned to dl.new with a
 * one-time code; a web session for the page; the personal install command's code, exchanged
 * once by the installed dl for a normal sign-in session.
 */

const PAGE = "https://dl.new/start";
const ORIGIN = "https://dl.new";
const STATE = "page-state-0123456789abcdef";
const OPEN = { OPEN_ADMISSION: "true" };
const BILLING = { STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_PRO: "price_pro123", STRIPE_PRICE_TOPUP: "price_topup123" };
const ghCode = (user: GitHubUserFixture) => encodeURIComponent(JSON.stringify(user));

/** /web/signin → GitHub → the callback (and the details step when asked): the last response. */
async function webSignIn(service: Service, user: GitHubUserFixture, options: { state?: string; ip?: string; ref?: string } = {}): Promise<Response> {
  const start = await service.request("GET", `/web/signin?return=${encodeURIComponent(PAGE)}&state=${options.state ?? STATE}${options.ref ? `&ref=${options.ref}` : ""}`, options.ip ? { ip: options.ip } : {});
  assert.equal(start.status, 302, await start.clone().text());
  const location = new URL(start.headers.get("location")!);
  assert.equal(location.origin, "https://github.com");
  const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
  const callback = await service.request("GET", `/device/callback?code=${ghCode(user)}&state=${location.searchParams.get("state")}`, { headers: { cookie }, ...(options.ip ? { ip: options.ip } : {}) });
  const page = await callback.clone().text();
  if (!page.includes('action="/device/details"')) return callback;
  const ticket = /name="ticket" value="([^"]+)"/.exec(page)![1]!;
  const prefilled = /name="email"[^>]*value="([^"]*)"/.exec(page)?.[1] || "someone@example.com";
  return service.request("POST", "/device/details", { form: { ticket, email: prefilled }, ...(options.ip ? { ip: options.ip } : {}) });
}

function handoffCode(response: Response): string {
  assert.equal(response.status, 303);
  const location = response.headers.get("location")!;
  assert.ok(location.startsWith(`${PAGE}#signin=`), location);
  return location.slice(`${PAGE}#signin=`.length);
}

const fromPage = (extra: Record<string, string> = {}) => ({ origin: ORIGIN, ...extra });

async function webToken(service: Service, user: GitHubUserFixture): Promise<string> {
  const code = handoffCode(await webSignIn(service, user));
  const response = await service.request("POST", "/web/session", { body: { code, state: STATE }, headers: fromPage() });
  assert.equal(response.status, 200);
  return ((await response.json()) as { token: string }).token;
}

async function installCode(service: Service, token: string, body: Record<string, unknown> = { option: "computer", plan: "free" }): Promise<string> {
  const response = await service.request("POST", "/web/install-code", { token, body, headers: fromPage() });
  assert.equal(response.status, 200, await response.clone().text());
  return ((await response.json()) as { code: string }).code;
}

describe("web sign-in", () => {
  it("returns to dl.new with a one-time code bound to the page's state, after the same details step", async () => {
    const service = await createService(OPEN);
    const response = await webSignIn(service, { id: 501, login: "webby" });
    const code = handoffCode(response);
    assert.ok(code.length >= 43);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    // The same admission as the CLI: the account exists, with the email from the details step.
    const person = await service.directory().getPerson(501);
    assert.equal(person.status, "active");
    assert.equal(person.email, "webby.501@example.com");
    // Another page's state can't use it, and it works once.
    assert.equal((await service.request("POST", "/web/session", { body: { code, state: "someone-elses-state-000" }, headers: fromPage() })).status, 400);
    assert.equal((await service.request("POST", "/web/session", { body: { code, state: STATE }, headers: fromPage() })).status, 400);
  });

  it("exchanges the code once for a web session", async () => {
    const service = await createService(OPEN);
    const code = handoffCode(await webSignIn(service, { id: 502, login: "once" }));
    const first = await service.request("POST", "/web/session", { body: { code, state: STATE }, headers: fromPage() });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("access-control-allow-origin"), ORIGIN);
    const body = (await first.json()) as { token: string; login: string; expires_in: number };
    assert.equal(body.login, "once");
    assert.equal(body.expires_in, 3600);
    const again = await service.request("POST", "/web/session", { body: { code, state: STATE }, headers: fromPage() });
    assert.equal(again.status, 400);
    assert.equal(await errorCode(again), "invalid_grant");
  });

  it("expires the handoff after five minutes", async () => {
    const service = await createService(OPEN);
    const code = handoffCode(await webSignIn(service, { id: 503, login: "slow" }));
    service.clock.now += 5 * 60_000 + 1;
    assert.equal((await service.request("POST", "/web/session", { body: { code, state: STATE }, headers: fromPage() })).status, 400);
  });

  it("only returns to the configured page (no open redirect) and needs the page's state", async () => {
    const service = await createService(OPEN);
    for (const target of ["https://evil.example/start", "https://dl.new.evil.example/start", "https://dl.new/start/../x", "//evil.example", "https://dl.new/start?x=1"]) {
      const response = await service.request("GET", `/web/signin?return=${encodeURIComponent(target)}&state=${STATE}`);
      assert.equal(response.status, 400, target);
      assert.equal(response.headers.get("location"), null);
    }
    assert.equal((await service.request("GET", `/web/signin?return=${encodeURIComponent(PAGE)}`)).status, 400);
    assert.equal((await service.request("GET", `/web/signin?return=${encodeURIComponent(PAGE)}&state=short`)).status, 400);
    // WEB_SIGNUP_URL moves it (a staging page), and then only there.
    const staging = await createService({ ...OPEN, WEB_SIGNUP_URL: "https://staging.dl.new/start" });
    assert.equal((await staging.request("GET", `/web/signin?return=${encodeURIComponent(PAGE)}&state=${STATE}`)).status, 400);
    assert.equal((await staging.request("GET", `/web/signin?return=${encodeURIComponent("https://staging.dl.new/start")}&state=${STATE}`)).status, 302);
  });

  it("goes through the same admission: invite-only shows the invite step instead of returning", async () => {
    const service = await createService();
    const response = await webSignIn(service, { id: 504, login: "noinvite" });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /name="invite_code"/);
    assert.equal(await service.directory().getPerson(504), undefined);
  });

  it("refuses a blocked account", async () => {
    const service = await createService(OPEN);
    await webToken(service, { id: 505, login: "blockme" });
    const admin = await service.signIn({ id: ADMIN_ID, login: "owner" });
    assert.equal((await service.request("POST", "/admin/people/505/block", { token: admin.access_token })).status, 200);
    const response = await webSignIn(service, { id: 505, login: "blockme" });
    assert.equal(response.status, 403);
  });

  it("carries a referral code like the device page does", async () => {
    const service = await createService(OPEN);
    const inviter = await webToken(service, { id: 506, login: "inviter" });
    handoffCode(await webSignIn(service, { id: 507, login: "friend" }, { ref: "inviter", ip: "198.51.100.9" }));
    assert.equal((await service.directory().getPerson(507)).status, "active");
    const me = (await (await service.request("GET", "/web/me", { token: inviter, headers: fromPage() })).json()) as { referral: { joined: number } };
    assert.equal(me.referral.joined, 1);
  });

  it("is still the CLI's sign-in for the CLI: a device code never returns to a web page", async () => {
    const service = await createService(OPEN);
    const tokens = await service.signIn({ id: 508, login: "terminal" });
    assert.ok(tokens.access_token);
  });
});

describe("the web session", () => {
  it("reads what the page shows: login, email, plan, trial, offers and the invite link", async () => {
    const service = await createService({ ...OPEN, TRIAL_CUTOFF: "2026-11-01T00:00:00Z", REFERRAL_BONUS_TOKENS: "10000000" });
    const token = await webToken(service, { id: 510, login: "reader" });
    const response = await service.request("GET", "/web/me", { token, headers: fromPage() });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), ORIGIN);
    const me = (await response.json()) as Record<string, any>;
    assert.equal(me.login, "reader");
    assert.equal(me.email, "reader.510@example.com");
    assert.equal(me.plan, "free");
    assert.equal(me.trial.tokens, 10_000_000);
    assert.equal(me.offers.pro.price, "$3.99/month");
    assert.match(me.referral.link, /\/r\/reader$/);
    assert.equal(me.referral.joined, 0);
  });

  it("describes the referral reward: once on the trial, weekly otherwise", async () => {
    const service = await createService({ ...OPEN, TRIAL_CUTOFF: "2026-11-01T00:00:00Z" });
    const token = await webToken(service, { id: 512, login: "trialist" });
    const read = async (as: string) => ((await (await service.request("GET", "/web/me", { token: as, headers: fromPage() })).json()) as Record<string, any>);
    let me = await read(token);
    assert.deepEqual(me.referral, { link: "https://dl.new/r/trialist", joined: 0, kind: "trial", bonusTokens: 10_000_000, capTokens: 50_000_000, trialBonusTokens: 0 });
    // A friend joins with the code and is weekly active: +10M on the trial.
    await service.directory().admit({ githubId: 513, login: "pal", isAdmin: false, inviteCode: undefined, clientDeviceId: null, accountTooNew: false, openAdmission: true, inviteOnly: false, maxActive: 0, referralCode: "trialist", networkHash: "net-513", now: NOW });
    for (const day of [0, 1, 2]) {
      await service.directory().recordRequest({ githubId: 513, isAdmin: false, at: Date.parse("2026-11-02T12:00:00Z") + day * 86_400_000, model: "m", promptTokens: 1, completionTokens: 1, cachedTokens: 0, chargedTokens: 2, costUsd: 0, status: "ok", latencyMs: 1 });
    }
    me = await read(token);
    assert.equal(me.referral.kind, "trial");
    assert.equal(me.referral.joined, 1);
    assert.equal(me.referral.trialBonusTokens, 10_000_000);
    assert.equal(me.trial.tokens, 20_000_000);

    const weekly = await createService(OPEN);
    const oldtimer = await webToken(weekly, { id: 514, login: "oldtimer" });
    me = (await (await weekly.request("GET", "/web/me", { token: oldtimer, headers: fromPage() })).json()) as Record<string, any>;
    assert.equal(me.trial, null);
    assert.deepEqual(me.referral, { link: "https://dl.new/r/oldtimer", joined: 0, kind: "weekly", bonusTokens: 10_000_000, capTokens: 50_000_000, trialBonusTokens: 0 });
  });

  it("is not an access token, and an access token is not a web session", async () => {
    const service = await createService(OPEN);
    const token = await webToken(service, { id: 511, login: "scoped" });
    assert.equal((await service.request("GET", "/v1/me", { token })).status, 401);
    assert.equal((await service.request("POST", "/v1/chat/completions", { token, body: { model: "deepseek/deepseek-v4.1-flash-1017", messages: [] } })).status, 401);
    const access = await service.signIn({ id: 512, login: "cli" });
    assert.equal((await service.request("GET", "/web/me", { token: access.access_token, headers: fromPage() })).status, 401);
  });

  it("expires after an hour", async () => {
    const service = await createService(OPEN);
    const token = await webToken(service, { id: 513, login: "hour" });
    service.clock.now += 3600_000 + 120_000;
    assert.equal((await service.request("GET", "/web/me", { token, headers: fromPage() })).status, 401);
  });

  it("answers CORS for dl.new only, and refuses calls from other sites", async () => {
    const service = await createService(OPEN);
    const token = await webToken(service, { id: 514, login: "cors" });
    const preflight = await service.request("OPTIONS", "/web/me", { headers: { origin: ORIGIN, "access-control-request-method": "GET" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), ORIGIN);
    assert.match(preflight.headers.get("access-control-allow-headers")!, /authorization/);
    const evilPreflight = await service.request("OPTIONS", "/web/me", { headers: { origin: "https://evil.example" } });
    assert.equal(evilPreflight.headers.get("access-control-allow-origin"), null);
    const evil = await service.request("POST", "/web/install-code", { token, body: { option: "gpu" }, headers: { origin: "https://evil.example" } });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
  });

  it("changes the email with the details step's checks", async () => {
    const service = await createService({ ...OPEN, BLOCKED_EMAILS: "@spam.example" });
    const token = await webToken(service, { id: 515, login: "mailer" });
    await webToken(service, { id: 516, login: "other" });
    const post = (email: string) => service.request("POST", "/web/email", { token, body: { email }, headers: fromPage() });
    assert.equal(await errorCode(await post("nope")), "invalid_email");
    assert.equal(await errorCode(await post("x@spam.example")), "email_blocked");
    assert.equal(await errorCode(await post("other.516@example.com")), "email_in_use");
    assert.equal((await post("new@example.org")).status, 200);
    assert.equal((await service.directory().getPerson(515)).email, "new@example.org");
  });

  it("starts Pro checkout coming back to the web page", async () => {
    const service = await createService({ ...OPEN, ...BILLING });
    const token = await webToken(service, { id: 517, login: "payer" });
    const response = await service.request("POST", "/web/checkout", { token, headers: fromPage() });
    assert.equal(response.status, 200, await response.clone().text());
    assert.match(((await response.json()) as { url: string }).url, /^https:\/\//);
    const form = service.calls.stripe.at(-1)!.form;
    assert.equal(form.get("success_url"), `${PAGE}?checkout=done`);
    assert.equal(form.get("cancel_url"), `${PAGE}?checkout=cancel`);
    assert.equal(form.get("line_items[0][price]"), "price_pro123");
  });
});

describe("the install code", () => {
  it("is exchanged once for a normal sign-in session, with the choice", async () => {
    const service = await createService(OPEN);
    const token = await webToken(service, { id: 520, login: "installer" });
    const code = await installCode(service, token, { option: "computer", plan: "free" });
    assert.match(code, /^[A-Za-z0-9_-]{27}$/);
    const exchanged = await service.request("POST", "/v1/install-code/exchange", { body: { code } });
    assert.equal(exchanged.status, 200);
    const body = (await exchanged.json()) as Record<string, any>;
    assert.equal(body.option, "computer");
    assert.equal(body.plan, "free");
    assert.equal(body.login, "installer");
    // The tokens are a normal sign-in: /v1/me works, and the refresh token rotates.
    assert.equal((await service.request("GET", "/v1/me", { token: body.access_token })).status, 200);
    assert.equal((await service.request("POST", "/v1/token/refresh", { body: { refresh_token: body.refresh_token } })).status, 200);
    const again = await service.request("POST", "/v1/install-code/exchange", { body: { code } });
    assert.equal(again.status, 400);
    const error = (await again.json()) as { error: { code: string; reason: string } };
    assert.deepEqual([error.error.code, error.error.reason], ["invalid_install_code", "used"]);
  });

  it("keeps the GPU choice, with no plan", async () => {
    const service = await createService(OPEN);
    const token = await webToken(service, { id: 521, login: "gpu" });
    const code = await installCode(service, token, { option: "gpu", plan: "pro" });
    const body = (await (await service.request("POST", "/v1/install-code/exchange", { body: { code } })).json()) as Record<string, any>;
    assert.equal(body.option, "gpu");
    assert.equal(body.plan, null);
  });

  it("needs a plan on this computer", async () => {
    const service = await createService(OPEN);
    const token = await webToken(service, { id: 522, login: "noplan" });
    assert.equal((await service.request("POST", "/web/install-code", { token, body: { option: "computer" }, headers: fromPage() })).status, 400);
    assert.equal((await service.request("POST", "/web/install-code", { token, body: { option: "cloud" }, headers: fromPage() })).status, 400);
  });

  it("expires after an hour", async () => {
    const service = await createService(OPEN);
    const token = await webToken(service, { id: 523, login: "late" });
    const code = await installCode(service, token);
    service.clock.now += 60 * 60_000;
    const response = await service.request("POST", "/v1/install-code/exchange", { body: { code } });
    assert.equal(((await response.json()) as { error: { reason: string } }).error.reason, "expired");
  });

  it("works only as the latest one issued", async () => {
    const service = await createService(OPEN);
    const token = await webToken(service, { id: 524, login: "twice" });
    const first = await installCode(service, token);
    const second = await installCode(service, token);
    assert.equal(((await (await service.request("POST", "/v1/install-code/exchange", { body: { code: first } })).json()) as { error: { reason: string } }).error.reason, "unknown");
    assert.equal((await service.request("POST", "/v1/install-code/exchange", { body: { code: second } })).status, 200);
  });

  it("refuses unknown codes and is rate limited per network", async () => {
    const service = await createService(OPEN);
    let last: Response | undefined;
    for (let attempt = 0; attempt < 21; attempt++) {
      last = await service.request("POST", "/v1/install-code/exchange", { body: { code: `guess${String(attempt).padStart(22, "0")}` }, ip: "192.0.2.50" });
      if (attempt < 20) assert.equal(await errorCode(last.clone()), "invalid_install_code");
    }
    assert.equal(last!.status, 429);
    // Another network isn't held up.
    assert.equal((await service.request("POST", "/v1/install-code/exchange", { body: { code: "x".repeat(27) }, ip: "192.0.2.51" })).status, 400);
  });

  it("refuses a blocked account and binds the device id like device sign-in", async () => {
    const service = await createService(OPEN);
    const a = await webToken(service, { id: 525, login: "first" });
    const b = await webToken(service, { id: 526, login: "second" });
    assert.equal((await service.request("POST", "/v1/install-code/exchange", { body: { code: await installCode(service, a), device_id: "device-123456" } })).status, 200);
    const taken = await service.request("POST", "/v1/install-code/exchange", { body: { code: await installCode(service, b), device_id: "device-123456" } });
    assert.equal(taken.status, 403);
    assert.equal(await errorCode(taken), "device_taken");
    const code = await installCode(service, a);
    const admin = await service.signIn({ id: ADMIN_ID, login: "owner" });
    await service.request("POST", "/admin/people/525/block", { token: admin.access_token });
    const blocked = await service.request("POST", "/v1/install-code/exchange", { body: { code } });
    assert.equal(blocked.status, 403);
    assert.equal(await errorCode(blocked), "blocked");
  });

  it("is never stored in the clear", async () => {
    const service = await createService(OPEN);
    const token = await webToken(service, { id: 527, login: "hashed" });
    const code = await installCode(service, token);
    const state = (service.namespaces.AUTH as any).instances.get("auth").state;
    const rows = state.db.prepare("SELECT * FROM install_codes").all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.ok(!JSON.stringify(rows).includes(code));
    assert.equal(rows[0]!.option, "computer");
  });
});

describe("the web sign-up funnel", () => {
  it("counts each step, shows them on the admin home and in a CSV", async () => {
    const service = await createService({ ...OPEN, ...BILLING });
    assert.equal((await service.request("POST", "/v1/telemetry/web", { body: { step: "visited" } })).status, 204);
    assert.equal((await service.request("POST", "/v1/telemetry/web", { body: { step: "code_exchanged" } })).status, 400);
    const token = await webToken(service, { id: 530, login: "funnel" });
    await service.request("POST", "/web/choice", { token, body: { option: "computer" }, headers: fromPage() });
    await service.request("POST", "/web/checkout", { token, headers: fromPage() });
    const code = await installCode(service, token, { option: "computer", plan: "pro" });
    await service.request("POST", "/v1/install-code/exchange", { body: { code } });
    const rows = await service.directory().webFunnel();
    const totals = Object.fromEntries(funnelTotals(rows).map((row) => [row.step, row.n]));
    assert.deepEqual(totals, { visited: 1, signed_in: 1, chose_computer: 1, chose_gpu: 0, plan_free: 0, plan_pro: 1, command_shown: 1, code_exchanged: 1 });
    const csv = webFunnelCsv(rows);
    assert.equal(csv.split("\n")[0], "day,visited,signed_in,chose_computer,chose_gpu,plan_free,plan_pro,command_shown,code_exchanged");
    assert.equal(csv.split("\n")[1], "2026-11-04,1,1,1,0,0,1,1,1");
    const admin = await service.signIn({ id: ADMIN_ID, login: "owner" });
    const home = await (await service.request("GET", "/admin", { token: admin.access_token })).text();
    assert.match(home, /Web sign-up funnel/);
    const download = await service.request("GET", "/admin/dashboard/web-signup.csv", { token: admin.access_token });
    assert.equal(download.status, 200);
    assert.equal((await download.text()).split("\n")[1], "2026-11-04,1,1,1,0,0,1,1,1");
    assert.equal(NOW, service.clock.now);
  });

  it("keeps the CLI device flow's pages unchanged for terminals", async () => {
    const service = await createService(OPEN);
    const issued = (await (await service.request("POST", "/v1/device/code", { body: {} })).json()) as { user_code: string };
    const authorize = await service.request("GET", `/device/authorize?user_code=${issued.user_code}`);
    const location = new URL(authorize.headers.get("location")!);
    const cookie = authorize.headers.get("set-cookie")!.split(";")[0]!;
    const page = await (await service.request("GET", `/device/callback?code=${ghCode({ id: 531, login: "cli" })}&state=${location.searchParams.get("state")}`, { headers: { cookie } })).text();
    const done = await submitDetails(service.request, page);
    assert.match(done.page, /Return to your terminal/);
  });
});
