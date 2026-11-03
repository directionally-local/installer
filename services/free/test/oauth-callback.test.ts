import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, authorize, createService, FakeState, type Service } from "./harness.js";

/**
 * Device sign-in and admin dashboard sign-in share the OAuth app's one registered callback,
 * /device/callback. The state's stored purpose picks the flow; neither flow can use the
 * other's state, and no state works twice.
 */

const code = (user: { id: number; login: string }) => encodeURIComponent(JSON.stringify(user));

async function adminState(service: Service): Promise<{ state: string; cookie: string; browser: string }> {
  const start = await service.request("GET", "/admin/signin");
  const location = new URL(start.headers.get("location")!);
  assert.equal(location.searchParams.get("redirect_uri"), "https://free.test/device/callback");
  const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
  return { state: location.searchParams.get("state")!, cookie, browser: cookie.slice(cookie.indexOf("=") + 1) };
}

async function deviceState(service: Service): Promise<{ state: string; cookie: string; browser: string; userCode: string }> {
  const issued = (await (await service.request("POST", "/v1/device/code", { body: {} })).json()) as { user_code: string };
  const { state, cookie, location } = await authorize(service.request, issued.user_code);
  assert.equal(new URL(location).searchParams.get("redirect_uri"), "https://free.test/device/callback");
  return { state, cookie, browser: cookie.slice(cookie.indexOf("=") + 1), userCode: issued.user_code };
}

const hasAdminSession = (response: Response) => response.headers.getSetCookie().some((value) => value.startsWith("__Host-dl_admin="));

describe("the shared OAuth callback", () => {
  it("finishes an admin sign-in when the state is an admin one", async () => {
    const service = await createService();
    const { state, cookie } = await adminState(service);
    const response = await service.request("GET", `/device/callback?code=${code({ id: ADMIN_ID, login: "owner" })}&state=${state}`, { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.ok(hasAdminSession(response));
    assert.match(await response.text(), /url=\/admin/);
  });

  it("still runs the device flow for a device state", async () => {
    const service = await createService();
    const { state, cookie } = await deviceState(service);
    const response = await service.request("GET", `/device/callback?code=${code({ id: ADMIN_ID, login: "owner" })}&state=${state}`, { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.ok(!hasAdminSession(response));
    assert.match(await response.text(), /signed in/);
  });

  it("won't finish a device sign-in with a device state presented as an admin one", async () => {
    const service = await createService();
    const device = await deviceState(service);
    // The device browser value in the admin cookie, at the old admin-only path.
    const asAdmin = await service.request("GET", `/device/callback/admin?code=${code({ id: ADMIN_ID, login: "owner" })}&state=${device.state}`, {
      headers: { cookie: `__Host-dl_admin_oauth=${device.browser}` },
    });
    assert.equal(asAdmin.status, 400);
    assert.ok(!hasAdminSession(asAdmin));
    // The device state wasn't spent by the attempt: its own flow still finishes.
    const own = await service.request("GET", `/device/callback?code=${code({ id: 100, login: "alice" })}&state=${device.state}`, { headers: { cookie: device.cookie } });
    assert.equal(own.status, 200);
  });

  it("won't let the device flow claim an admin state", async () => {
    const service = await createService();
    const admin = await adminState(service);
    const auth = service.namespaces.AUTH!.getByName("auth") as { claimOAuthState(state: string, browser: string, now: number): Promise<unknown> };
    assert.equal(await auth.claimOAuthState(admin.state, admin.browser, service.clock.now), undefined);
    // With only the device cookie, the callback still routes to the admin finish, which refuses it.
    const withDeviceCookie = await service.request("GET", `/device/callback?code=${code({ id: ADMIN_ID, login: "owner" })}&state=${admin.state}`, {
      headers: { cookie: `__Host-dl_oauth=${admin.browser}` },
    });
    assert.equal(withDeviceCookie.status, 400);
    assert.ok(!hasAdminSession(withDeviceCookie));
    // Neither attempt spent the admin state.
    const own = await service.request("GET", `/device/callback?code=${code({ id: ADMIN_ID, login: "owner" })}&state=${admin.state}`, { headers: { cookie: admin.cookie } });
    assert.equal(own.status, 200);
    assert.ok(hasAdminSession(own));
  });

  it("refuses replays of either kind", async () => {
    const service = await createService();
    const admin = await adminState(service);
    const adminPath = `/device/callback?code=${code({ id: ADMIN_ID, login: "owner" })}&state=${admin.state}`;
    assert.equal((await service.request("GET", adminPath, { headers: { cookie: admin.cookie } })).status, 200);
    const adminReplay = await service.request("GET", adminPath, { headers: { cookie: admin.cookie } });
    assert.equal(adminReplay.status, 400);
    assert.ok(!hasAdminSession(adminReplay));

    const device = await deviceState(service);
    const devicePath = `/device/callback?code=${code({ id: 100, login: "alice" })}&state=${device.state}`;
    assert.equal((await service.request("GET", devicePath, { headers: { cookie: device.cookie } })).status, 200);
    assert.equal((await service.request("GET", devicePath, { headers: { cookie: device.cookie } })).status, 400);
  });

  it("treats an unknown or expired state as the device flow's, which refuses it", async () => {
    const service = await createService();
    assert.equal((await service.request("GET", `/device/callback?code=x&state=nope`)).status, 400);
    const admin = await adminState(service);
    service.clock.now += 11 * 60_000;
    const late = await service.request("GET", `/device/callback?code=${code({ id: ADMIN_ID, login: "owner" })}&state=${admin.state}`, { headers: { cookie: admin.cookie } });
    assert.equal(late.status, 400);
    assert.ok(!hasAdminSession(late));
  });
});

describe("oauth_states migration", () => {
  it("adds the purpose column and keeps earlier admin states as admin", async () => {
    const { AuthObject } = await import("../src/auth-object.js");
    const state = new FakeState("auth");
    state.db.exec(`CREATE TABLE oauth_states (state_hash TEXT PRIMARY KEY, device_hash TEXT NOT NULL, browser_hash TEXT NOT NULL, expires_at INTEGER NOT NULL)`);
    const { sha256Hex } = await import("../../shared/src/auth.js");
    const insert = state.db.prepare("INSERT INTO oauth_states VALUES (?, ?, 'b', ?)");
    insert.run(await sha256Hex("old-admin"), "admin-dashboard", Date.now() + 60_000);
    insert.run(await sha256Hex("old-device"), "f".repeat(64), Date.now() + 60_000);
    const auth = new AuthObject(state as never, {} as never);
    assert.equal(await auth.oauthPurpose("old-admin", Date.now()), "admin");
    assert.equal(await auth.oauthPurpose("old-device", Date.now()), "device");
    // Running again on the migrated table changes nothing.
    new AuthObject(state as never, {} as never);
    assert.equal(await auth.oauthPurpose("old-admin", Date.now()), "admin");
  });
});
