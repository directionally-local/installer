import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, authorize, createService, errorCode, MODEL, type Service, type Tokens, submitDetails } from "./harness.js";

const OLD = "2015-01-01T00:00:00Z";
const BLOCKED = "This account is blocked from the free tier. Contact contact@directionallylocal.com.";

/** Device sign-in from one address (and optionally one device id); returns the poll's response. */
async function signUp(service: Service, user: { id: number; login: string }, options: { ip: string; deviceId?: string }): Promise<{ page: string; status: number; poll: Response }> {
  const request: Service["request"] = (method, path, more = {}) => service.request(method, path, { ...more, ip: options.ip });
  const issued = (await (await request("POST", "/v1/device/code", { body: options.deviceId ? { device_id: options.deviceId } : {} })).json()) as { device_code: string; user_code: string };
  const { state, cookie } = await authorize(request, issued.user_code);
  const callback = await request("GET", `/device/callback?code=${encodeURIComponent(JSON.stringify({ createdAt: OLD, ...user }))}&state=${encodeURIComponent(state)}`, { headers: { cookie } });
  let page = await callback.text();
  let status = callback.status;
  if (page.includes('action="/device/details"')) ({ page, status } = await submitDetails(request, page));
  return { page, status, poll: await request("POST", "/v1/device/token", { body: { device_code: issued.device_code } }) };
}

async function tokensFor(service: Service, user: { id: number; login: string }, options: { ip: string; deviceId?: string }): Promise<Tokens> {
  const { poll, page } = await signUp(service, user, options);
  assert.equal(poll.status, 200, page);
  return (await poll.json()) as Tokens;
}

async function adminCookie(service: Service): Promise<string> {
  const start = await service.request("GET", "/admin/signin");
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const oauth = start.headers.get("set-cookie")!.split(";")[0]!;
  const done = await service.request("GET", `/device/callback?code=${encodeURIComponent(JSON.stringify({ id: ADMIN_ID, login: "owner" }))}&state=${encodeURIComponent(state)}`, { headers: { cookie: oauth } });
  return done.headers.getSetCookie().find((value) => value.startsWith("__Host-dl_admin="))!.split(";")[0]!;
}

/** The Tools page, where the forms (and their CSRF token) are. */
async function dashboard(service: Service, cookie: string, path = "/admin?view=tools"): Promise<string> {
  const response = await service.request("GET", path, { headers: { cookie } });
  assert.equal(response.status, 200);
  return response.text();
}

const csrfOf = (html: string) => /name="csrf" value="([0-9a-f]{64})"/.exec(html)![1]!;

/** The dashboard's Block/Unblock form, posted the way a browser on the page posts it. */
function post(service: Service, cookie: string, path: string, form: Record<string, string>, origin = "https://free.test"): Promise<Response> {
  return service.request("POST", path, { headers: { cookie, origin }, form });
}

let caller = 0;
const chat = (service: Service, token: string) =>
  service.request("POST", "/v1/chat/completions", { token, ip: `10.7.0.${++caller % 250}`, body: { model: MODEL, messages: [{ role: "user", content: "hi" }] } });
const refresh = (service: Service, token: string) => service.request("POST", "/v1/token/refresh", { ip: `10.6.0.${++caller % 250}`, body: { refresh_token: token } });

async function setup() {
  const service = await createService({ OPEN_ADMISSION: "true" });
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  return { service, admin };
}

describe("blocking a person", () => {
  it("stops chat and token refresh with a 403, refuses sign-in, and unblock restores all three", async () => {
    const { service, admin } = await setup();
    const alice = await tokensFor(service, { id: 100, login: "alice" }, { ip: "198.51.100.10" });
    assert.equal((await chat(service, alice.access_token)).status, 200);

    const blocked = await service.request("POST", "/admin/people/100/block", { token: admin });
    assert.deepEqual(await blocked.json(), { githubId: 100, status: "blocked" });

    const refused = await chat(service, alice.access_token);
    assert.equal(refused.status, 403);
    const body = (await refused.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "blocked");
    assert.equal(body.error.message, BLOCKED);
    const refreshRefused = await refresh(service, alice.refresh_token);
    assert.equal(refreshRefused.status, 403);
    assert.equal(await errorCode(refreshRefused), "blocked");
    assert.equal((await service.request("POST", "/v1/keys", { token: alice.access_token, body: { name: "box" } })).status, 403);

    const again = await signUp(service, { id: 100, login: "alice" }, { ip: "198.51.100.11" });
    assert.equal(again.status, 403);
    assert.match(again.page, /Account blocked/);
    assert.match(again.page, /contact@directionallylocal\.com/);
    assert.equal(again.poll.status, 403);
    assert.equal(await errorCode(again.poll), "blocked");

    assert.equal((await (await service.request("POST", "/admin/people/100/unblock", { token: admin })).json() as { status: string }).status, "active");
    assert.equal((await chat(service, alice.access_token)).status, 200);
    // The refresh token wasn't used while blocked, so it still works.
    assert.equal((await refresh(service, alice.refresh_token)).status, 200);
    assert.equal((await signUp(service, { id: 100, login: "alice" }, { ip: "198.51.100.12" })).poll.status, 200);
  });

  it("accepts a form post whose Origin the browser hid as null, and still refuses a cross-site one", async () => {
    const { service } = await setup();
    const bob = await tokensFor(service, { id: 101, login: "bob" }, { ip: "198.51.100.20" });
    assert.equal((await chat(service, bob.access_token)).status, 200);
    const cookie = await adminCookie(service);
    const csrf = csrfOf(await dashboard(service, cookie));
    const form = (headers: Record<string, string>) =>
      service.request("POST", "/admin/dashboard/people/101/block", { headers: { cookie, ...headers }, form: { csrf } });

    // The dashboard sends `referrer-policy: no-referrer`, so the browser sends `Origin: null`;
    // Fetch Metadata still says same-origin, so the block goes through.
    const accepted = await form({ origin: "null", "sec-fetch-site": "same-origin" });
    assert.equal(accepted.status, 303);
    assert.equal((await service.directory().getPerson(101)).status, "blocked");

    // A cross-site page that also hides its Origin is still refused.
    const refused = await form({ origin: "null", "sec-fetch-site": "cross-site" });
    assert.equal(refused.status, 403);
    assert.match(await refused.text(), /only from the dashboard itself/);
  });

  it("is admin-only over the API, and 404s for nobody", async () => {
    const { service, admin } = await setup();
    const alice = await tokensFor(service, { id: 100, login: "alice" }, { ip: "198.51.100.10" });
    await tokensFor(service, { id: 101, login: "bob" }, { ip: "198.51.100.20" });
    const member = await service.request("POST", "/admin/people/101/block", { token: alice.access_token });
    assert.equal(member.status, 403);
    assert.equal(await errorCode(member), "forbidden");
    assert.equal((await service.request("POST", "/admin/people/101/block")).status, 401);
    assert.equal((await service.request("POST", "/admin/people/999/block", { token: admin })).status, 404);
    assert.equal((await service.directory().getPerson(101)).status, "active");
  });

  it("blocks from the dashboard only with the session, the CSRF token and a same-origin post, and logs it", async () => {
    const { service, admin } = await setup();
    const bob = await tokensFor(service, { id: 101, login: "bob" }, { ip: "198.51.100.20" });
    assert.equal((await chat(service, bob.access_token)).status, 200);
    const cookie = await adminCookie(service);
    const html = await dashboard(service, cookie);
    const csrf = csrfOf(html);
    assert.match(html, /<input type="hidden" name="tool" value="block">/);

    // No CSRF token, a wrong one, another origin, or no session: nothing changes.
    assert.equal((await post(service, cookie, "/admin/dashboard/people/101/block", {})).status, 403);
    assert.equal((await post(service, cookie, "/admin/dashboard/people/101/block", { csrf: "0".repeat(64) })).status, 403);
    assert.equal((await post(service, cookie, "/admin/dashboard/people/101/block", { csrf }, "https://evil.test")).status, 403);
    assert.equal((await service.request("POST", "/admin/dashboard/people/101/block", { headers: { origin: "https://free.test" }, form: { csrf } })).status, 401);
    // An admin's bearer token doesn't stand in for the session on the form route.
    assert.equal((await service.request("POST", "/admin/dashboard/people/101/block", { token: admin, headers: { origin: "https://free.test" }, form: { csrf } })).status, 401);
    // Another admin session's token doesn't fit this one.
    const otherCsrf = csrfOf(await dashboard(service, await adminCookie(service)));
    assert.notEqual(otherCsrf, csrf);
    assert.equal((await post(service, cookie, "/admin/dashboard/people/101/block", { csrf: otherCsrf })).status, 403);
    assert.equal((await service.directory().getPerson(101)).status, "active");
    assert.equal((await chat(service, bob.access_token)).status, 200);

    const done = await post(service, cookie, "/admin/dashboard/people/101/block", { csrf });
    assert.equal(done.status, 303);
    assert.equal(done.headers.get("location"), "/admin?view=tools#block");
    assert.equal(await errorCode(await chat(service, bob.access_token)), "blocked");

    // Home shows the account as Blocked.
    assert.match(await dashboard(service, cookie, "/admin"), /<tr data-q="bob">\n<td data-v="bob">bob<\/td>\n<td class="l"><span class="badge blocked">Blocked<\/span><\/td>/);
    const log = (await (await service.request("GET", "/admin/config", { token: admin })).json()) as { log: Array<{ key: string; oldValue: unknown; newValue: unknown; changedByLogin: string }> };
    assert.deepEqual(log.log[0], { ...log.log[0], key: "person_status:101:bob", oldValue: "active", newValue: "blocked", changedByLogin: "owner" });

    assert.equal((await post(service, cookie, "/admin/dashboard/people/101/unblock", { csrf })).status, 303);
    assert.equal((await chat(service, bob.access_token)).status, 200);
    assert.match(await dashboard(service, cookie, "/admin"), /<td class="l"><span class="badge free">Free<\/span><\/td>/);
  });

  it("blocks and unblocks by username from the Tools page, never an admin", async () => {
    const { service } = await setup();
    const bob = await tokensFor(service, { id: 101, login: "bob" }, { ip: "198.51.100.20" });
    const cookie = await adminCookie(service);
    const csrf = csrfOf(await dashboard(service, cookie));
    const tool = async (form: Record<string, string>, origin = "https://free.test") => {
      const response = await post(service, cookie, "/admin/dashboard/tools", { csrf, tool: "block", ...form }, origin);
      return { status: response.status, html: await response.text() };
    };
    assert.equal((await tool({ login: "bob", action: "block" }, "https://evil.test")).status, 403);
    assert.equal((await service.directory().getPerson(101)).status, "active");

    const blocked = await tool({ login: "@BOB", action: "block" });
    assert.equal(blocked.status, 200);
    assert.match(blocked.html, /<p class="msg" role="status">bob is blocked\.<\/p>/);
    assert.equal((await service.directory().getPerson(101)).status, "blocked");
    assert.equal(await errorCode(await chat(service, bob.access_token)), "blocked");

    assert.match((await tool({ login: "bob", action: "unblock" })).html, /bob is unblocked\./);
    assert.equal((await chat(service, bob.access_token)).status, 200);

    assert.match((await tool({ login: "nobody", action: "block" })).html, /<p class="msg err" role="status">No free tier account has the username nobody\.<\/p>/);
    assert.match((await tool({ login: "owner", action: "block" })).html, /owner is an admin; admins can&#39;t be blocked here\./);
    assert.match((await tool({ login: "<b>x</b>", action: "block" })).html, /No free tier account has the username &lt;b&gt;x&lt;\/b&gt;\./);
  });
});

describe("device refusals", () => {
  it("records sign-ins refused because the device holds another account", async () => {
    const { service } = await setup();
    await tokensFor(service, { id: 100, login: "alice" }, { ip: "198.51.100.10", deviceId: "device-0001-abcdefgh" });
    const second = await signUp(service, { id: 101, login: "mallory" }, { ip: "198.51.100.30", deviceId: "device-0001-abcdefgh" });
    assert.equal(second.status, 403);
    assert.equal(((await second.poll.json()) as { error: { reason: string } }).error.reason, "device_taken");
    await signUp(service, { id: 102, login: "mallory2" }, { ip: "198.51.100.31", deviceId: "device-0001-abcdefgh" });

    const { db } = (service.namespaces.DIRECTORY!.instances.get("directory") as { state: { db: import("node:sqlite").DatabaseSync } }).state;
    const rows = db.prepare("SELECT github_id, login, device_id, holder_id FROM device_refusals ORDER BY id").all();
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      { github_id: 101, login: "mallory", device_id: "device-0001-abcdefgh", holder_id: 100 },
      { github_id: 102, login: "mallory2", device_id: "device-0001-abcdefgh", holder_id: 100 },
    ]);
  });
});
