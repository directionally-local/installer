import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, authorize, createInvite, createService, errorCode, startBrowserFlow } from "./harness.js";

describe("device code", () => {
  it("issues an RFC 8628 code with a verification link", async () => {
    const service = await createService();
    const response = await service.request("POST", "/v1/device/code", { body: {} });
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.match(String(body.user_code), /^[A-Z]{4}-[0-9]{4}$/);
    assert.equal(typeof body.device_code, "string");
    assert.ok(String(body.device_code).length >= 40);
    assert.equal(body.verification_uri, "https://free.test/device");
    assert.equal(body.verification_uri_complete, `https://free.test/device?user_code=${body.user_code}`);
    assert.equal(body.interval, 5);
    assert.equal(body.expires_in, 900);
  });

  it("rate-limits code requests per IP", async () => {
    const service = await createService();
    for (let index = 0; index < 60; index++) assert.equal((await service.request("POST", "/v1/device/code", { body: {} })).status, 200);
    const limited = await service.request("POST", "/v1/device/code", { body: {} });
    assert.equal(limited.status, 429);
    const body = (await limited.json()) as { error: { code: string; retryAfter: number } };
    assert.equal(body.error.code, "rate_limited");
    assert.ok(body.error.retryAfter > 0);
    assert.equal((await service.request("POST", "/v1/device/code", { body: {}, ip: "198.51.100.1" })).status, 200);
  });
});

describe("polling", () => {
  it("is pending, then slow_down when too fast, then pending again after the interval", async () => {
    const service = await createService();
    const issued = (await (await service.request("POST", "/v1/device/code", { body: {} })).json()) as { device_code: string };
    const poll = () => service.request("POST", "/v1/device/token", { body: { device_code: issued.device_code } });
    assert.equal(await errorCode(await poll()), "authorization_pending");
    service.clock.now += 1000;
    const fast = await poll();
    assert.equal(fast.status, 400);
    const body = (await fast.json()) as { error: { code: string; interval: number } };
    assert.equal(body.error.code, "slow_down");
    assert.equal(body.error.interval, 10);
    service.clock.now += 10_000;
    assert.equal(await errorCode(await poll()), "authorization_pending");
  });

  it("expires after fifteen minutes", async () => {
    const service = await createService();
    const issued = (await (await service.request("POST", "/v1/device/code", { body: {} })).json()) as { device_code: string; user_code: string };
    service.clock.now += 14 * 60_000;
    assert.equal(await errorCode(await service.request("POST", "/v1/device/token", { body: { device_code: issued.device_code } })), "authorization_pending", "still good after 14 minutes");
    assert.match(await (await service.request("GET", `/device?user_code=${issued.user_code}`)).text(), new RegExp(issued.user_code));
    service.clock.now += 60_001;
    assert.equal(await errorCode(await service.request("POST", "/v1/device/token", { body: { device_code: issued.device_code } })), "expired_token");
    const page = await service.request("GET", `/device?user_code=${issued.user_code}`);
    assert.match(await page.text(), /unknown or has expired/);
  });

  it("treats an unknown device code as expired", async () => {
    const service = await createService();
    assert.equal(await errorCode(await service.request("POST", "/v1/device/token", { body: { device_code: "nope" } })), "expired_token");
  });
});

describe("browser sign-in", () => {
  it("signs an admin in without an invite and pays out tokens once", async () => {
    const service = await createService();
    const flow = await startBrowserFlow(service.request, { id: ADMIN_ID, login: "owner" });
    assert.match(flow.page, /signed in/);
    const first = await service.request("POST", "/v1/device/token", { body: { device_code: flow.deviceCode } });
    assert.equal(first.status, 200);
    const tokens = (await first.json()) as Record<string, unknown>;
    assert.equal(tokens.token_type, "Bearer");
    assert.equal(tokens.expires_in, 3600);
    assert.equal(typeof tokens.access_token, "string");
    assert.equal(typeof tokens.refresh_token, "string");
    assert.equal(await errorCode(await service.request("POST", "/v1/device/token", { body: { device_code: flow.deviceCode } })), "expired_token");
  });

  it("shows the person's invite link and what it earns once signed in, as selectable text", async () => {
    const service = await createService();
    const flow = await startBrowserFlow(service.request, { id: ADMIN_ID, login: "Owner" });
    assert.match(flow.page, /Signed in as Owner\. Return to your terminal; you can close this tab\./);
    assert.match(flow.page, /<strong>Invite friends and you both get \+10M tokens a week\.<\/strong>/);
    assert.match(flow.page, /Your invite link: <code class="link-text" style="user-select: all;[^"]*">https:\/\/dl\.new\/r\/owner<\/code>/);
    assert.match(flow.page, /up to \+50M a week/);
    assert.doesNotMatch(flow.page, /<script|<button/, "the CSP allows no scripts, so no Copy button");
    // The same link /v1/me gives.
    const tokens = (await (await service.request("POST", "/v1/device/token", { body: { device_code: flow.deviceCode } })).json()) as { access_token: string };
    const me = (await (await service.request("GET", "/v1/me", { token: tokens.access_token })).json()) as { referral: { link: string } };
    assert.equal(me.referral.link, "https://dl.new/r/owner");
  });

  it("leaves the invite out when invites earn nothing", async () => {
    const service = await createService({ REFERRAL_BONUS_TOKENS: "0" });
    const flow = await startBrowserFlow(service.request, { id: ADMIN_ID, login: "owner" });
    assert.match(flow.page, /Signed in as owner\./);
    assert.doesNotMatch(flow.page, /Invite friends/);
  });

  it("shows the code, the product name and what is collected before GitHub", async () => {
    const service = await createService();
    const issued = (await (await service.request("POST", "/v1/device/code", { body: {} })).json()) as { user_code: string };
    const page = await service.request("GET", `/device?user_code=${issued.user_code.toLowerCase().replace("-", "")}`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, new RegExp(issued.user_code));
    assert.match(html, /<h1>Sign in to dl<\/h1>/);
    assert.match(html, /<title>Confirm sign-in · dl<\/title>/);
    assert.match(html, /Continue with GitHub/);
    assert.match(html, /This isn't my code/);
    assert.match(html, /never store your prompts, completions, code, file paths\s+or file contents/);
    assert.match(html, /href="https:\/\/directionallylocal\.com\/privacy\/"/);
    assert.doesNotMatch(html, /<script/);
    const csp = page.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /font-src https:\/\/dl\.new;/);
    assert.doesNotMatch(csp, /script-src/);
  });

  it("links the privacy policy and terms on the sign-in pages", async () => {
    const service = await createService();
    const entry = await (await service.request("GET", "/device")).text();
    assert.match(entry, /<a href="https:\/\/directionallylocal\.com\/privacy\/">Privacy<\/a> · <a href="https:\/\/directionallylocal\.com\/terms\/">Terms<\/a>/);
    const done = await (await service.request("GET", "/device/callback?error=access_denied&state=x")).text();
    assert.match(done, /directionallylocal\.com\/privacy\//);
  });

  it("binds the OAuth state to the device code and the browser that started it", async () => {
    const service = await createService();
    const issued = (await (await service.request("POST", "/v1/device/code", { body: {} })).json()) as { user_code: string; device_code: string };
    const { state, cookie, location } = await authorize(service.request, issued.user_code);
    assert.match(location, /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
    assert.match(location, /redirect_uri=https%3A%2F%2Ffree\.test%2Fdevice%2Fcallback/);
    assert.match(cookie, /^__Host-dl_oauth=/);
    const code = encodeURIComponent(JSON.stringify({ id: 42, login: "mallory" }));

    // Without the browser cookie, or with a made-up state, the callback is refused.
    assert.equal((await service.request("GET", `/device/callback?code=${code}&state=${state}`)).status, 400);
    assert.equal((await service.request("GET", `/device/callback?code=${code}&state=madeup`, { headers: { cookie } })).status, 400);
    // Another browser's cookie doesn't fit this state.
    const other = await authorize(service.request, issued.user_code);
    assert.equal((await service.request("GET", `/device/callback?code=${code}&state=${state}`, { headers: { cookie: other.cookie } })).status, 400);
    assert.equal(await errorCode(await service.request("POST", "/v1/device/token", { body: { device_code: issued.device_code } })), "authorization_pending");

    // The right pair works once; a replay is refused.
    const ok = await service.request("GET", `/device/callback?code=${code}&state=${other.state}`, { headers: { cookie: other.cookie } });
    assert.equal(ok.status, 200);
    assert.equal((await service.request("GET", `/device/callback?code=${code}&state=${other.state}`, { headers: { cookie: other.cookie } })).status, 400);
  });

  it("reports access_denied when the person cancels", async () => {
    const service = await createService();
    const issued = (await (await service.request("POST", "/v1/device/code", { body: {} })).json()) as { user_code: string; device_code: string };
    const page = await service.request("POST", "/device/deny", { form: { user_code: issued.user_code } });
    assert.match(await page.text(), /cancelled/);
    assert.equal(await errorCode(await service.request("POST", "/v1/device/token", { body: { device_code: issued.device_code } })), "access_denied");
  });

  it("reports access_denied when GitHub sign-in is refused", async () => {
    const service = await createService();
    const issued = (await (await service.request("POST", "/v1/device/code", { body: {} })).json()) as { user_code: string; device_code: string };
    const { state, cookie } = await authorize(service.request, issued.user_code);
    await service.request("GET", `/device/callback?error=access_denied&state=${state}`, { headers: { cookie } });
    assert.equal(await errorCode(await service.request("POST", "/v1/device/token", { body: { device_code: issued.device_code } })), "access_denied");
  });

  it("asks for an invite, rejects a bad one, admits with a good one", async () => {
    const service = await createService();
    const invite = await createInvite(service);
    const flow = await startBrowserFlow(service.request, { id: 100, login: "alice" });
    assert.match(flow.page, /invite-only/);
    assert.equal(await errorCode(await service.request("POST", "/v1/device/token", { body: { device_code: flow.deviceCode } })), "authorization_pending");
    const ticket = /name="ticket" value="([^"]+)"/.exec(flow.page)![1]!;

    const bad = await service.request("POST", "/device/invite", { form: { ticket, invite_code: "DL-ZZZZ-ZZZZ" } });
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /isn&#39;t valid/);

    const good = await service.request("POST", "/device/invite", { form: { ticket, invite_code: invite.toLowerCase() } });
    assert.match(await good.text(), /signed in/);
    service.clock.now += 5000;
    assert.equal((await service.request("POST", "/v1/device/token", { body: { device_code: flow.deviceCode } })).status, 200);

    // An invite works once.
    const other = await startBrowserFlow(service.request, { id: 101, login: "bob" });
    const otherTicket = /name="ticket" value="([^"]+)"/.exec(other.page)![1]!;
    const reused = await service.request("POST", "/device/invite", { form: { ticket: otherTicket, invite_code: invite } });
    assert.match(await reused.text(), /already used/);
  });

  it("reports invite_required when the person has no code, saying what the page said", async () => {
    const service = await createService();
    const flow = await startBrowserFlow(service.request, { id: 100, login: "alice" });
    const ticket = /name="ticket" value="([^"]+)"/.exec(flow.page)![1]!;
    const page = await (await service.request("POST", "/device/no-invite", { form: { ticket } })).text();
    const body = (await (await service.request("POST", "/v1/device/token", { body: { device_code: flow.deviceCode } })).json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "invite_required");
    assert.match(body.error.message, /invite-only/);
    assert.ok(page.includes(body.error.message), "the page and the terminal say the same thing");
  });

  it("enforces MAX_ACTIVE_USERS, not counting admins", async () => {
    const service = await createService({ MAX_ACTIVE_USERS: "1" });
    const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    await service.signIn({ id: 100, login: "alice" }, { invite: await createInvite(service, admin) });
    await createInvite(service, admin);
    const flow = await startBrowserFlow(service.request, { id: 101, login: "bob" });
    assert.equal(flow.status, 403);
    assert.match(flow.page, /full/);
    const body = (await (await service.request("POST", "/v1/device/token", { body: { device_code: flow.deviceCode } })).json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "cohort_full");
    assert.ok(flow.page.includes(body.error.message));
    // People already in can still sign in on another machine.
    await service.signIn({ id: 100, login: "alice" });
  });

  it("admits a GitHub account younger than MIN_GITHUB_ACCOUNT_AGE_DAYS as Starter, without asking for an invite", async () => {
    const service = await createService({ OPEN_ADMISSION: "true" });
    const flow = await startBrowserFlow(service.request, { id: 100, login: "fresh", createdAt: "2026-10-20T00:00:00Z" });
    assert.equal(flow.status, 200);
    assert.match(flow.page, /signed in/i);
    const response = await service.request("POST", "/v1/device/token", { body: { device_code: flow.deviceCode } });
    assert.equal(response.status, 200);
  });

  it("gives one grant per device", async () => {
    const service = await createService();
    const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    await service.signIn({ id: 100, login: "alice" }, { invite: await createInvite(service, admin), deviceId: "device-0001" });
    const flow = await startBrowserFlow(service.request, { id: 101, login: "alias" }, "device-0001");
    assert.equal(flow.status, 403);
    const body = (await (await service.request("POST", "/v1/device/token", { body: { device_code: flow.deviceCode } })).json()) as { error: { code: string; reason: string } };
    assert.equal(body.error.code, "access_denied");
    assert.equal(body.error.reason, "device_taken");
  });

  it("stops new sign-ins while paused", async () => {
    const service = await createService({ PAUSED: "true" });
    assert.equal(await errorCode(await service.request("POST", "/v1/device/code", { body: {} })), "service_paused");
  });

  it("tells a waiting terminal when the free tier was paused before the browser step", async () => {
    const service = await createService();
    const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const issued = (await (await service.request("POST", "/v1/device/code", { body: {} })).json()) as { device_code: string; user_code: string };
    await service.request("POST", "/admin/pause", { token: admin });
    const page = await service.request("GET", `/device/authorize?user_code=${issued.user_code}`);
    assert.equal(page.status, 503);
    const html = await page.text();
    const body = (await (await service.request("POST", "/v1/device/token", { body: { device_code: issued.device_code } })).json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "service_paused");
    assert.ok(html.includes(body.error.message.replace(/'/g, "&#39;")));
  });
});
