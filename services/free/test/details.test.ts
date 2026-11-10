import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, authorize, createInvite, createService, startBrowserFlow, submitDetails, type Service } from "./harness.js";

/**
 * The sign-in step after GitHub: a contact email (prefilled from the primary verified address,
 * asked once), an opt-in for product updates, and an optional invite code for a Starter account.
 */

const NEW = "2026-10-20T00:00:00Z"; // 15 days before the harness clock: a Starter account

async function open(): Promise<{ service: Service; admin: string }> {
  const service = await createService({ OPEN_ADMISSION: "true" });
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  return { service, admin };
}

async function person(service: Service, admin: string, id: number): Promise<{ level: string; levelReason: string; contact: { address: string | null; updates: boolean | null } }> {
  const body = (await (await service.request("GET", "/admin/people", { token: admin })).json()) as {
    people: Array<{ githubId: number; level: string; levelReason: string; contact: { address: string | null; updates: boolean | null } }>;
  };
  const row = body.people.find((p) => p.githubId === id);
  assert.ok(row, `person ${id} listed`);
  return row;
}

async function token(service: Service, deviceCode: string): Promise<number> {
  return (await service.request("POST", "/v1/device/token", { body: { device_code: deviceCode } })).status;
}

describe("the sign-in details step", () => {
  it("asks GitHub for read-only email access, and only on device sign-in", async () => {
    const { service } = await open();
    const issued = (await (await service.request("POST", "/v1/device/code", { body: {} })).json()) as { user_code: string };
    const { location } = await authorize(service.request, issued.user_code);
    assert.equal(new URL(location).searchParams.get("scope"), "user:email");
    const admin = await service.request("GET", "/admin/signin");
    assert.equal(new URL(admin.headers.get("location")!).searchParams.get("scope"), null);
  });

  it("prefills the primary verified email, waits for the form, then stores it and the updates choice", async () => {
    const { service, admin } = await open();
    const flow = await startBrowserFlow(service.request, { id: 100, login: "alice", email: "alice@work.example" }, undefined, { stopAtDetails: true });
    assert.match(flow.page, /name="email"[^>]*value="alice@work\.example"/);
    assert.doesNotMatch(flow.page, /name="invite_code"/, "a Full account isn't offered an invite field");
    assert.match(flow.page, /type="checkbox" name="updates" value="1">/, "updates start unticked");
    const waiting = await service.request("POST", "/v1/device/token", { body: { device_code: flow.deviceCode } });
    assert.equal(((await waiting.json()) as { error?: { code?: string } }).error?.code, "authorization_pending", "the terminal keeps waiting during the step");

    const done = await submitDetails(service.request, flow.page, { email: "alice@home.example", updates: true });
    assert.match(done.page, /signed in/);
    assert.equal(await token(service, flow.deviceCode), 200);
    assert.deepEqual((await person(service, admin, 100)).contact, { address: "alice@home.example", updates: true });
  });

  it("leaves the field empty when GitHub has only a noreply or no verified address", async () => {
    const { service } = await open();
    const flow = await startBrowserFlow(service.request, { id: 101, login: "bob", email: null }, undefined, { stopAtDetails: true });
    assert.match(flow.page, /name="email"[^>]*value=""/);
  });

  it("refuses an address that can't be one, and keeps the step open", async () => {
    const { service } = await open();
    const flow = await startBrowserFlow(service.request, { id: 102, login: "carol" }, undefined, { stopAtDetails: true });
    const bad = await submitDetails(service.request, flow.page, { email: "not an email" });
    assert.equal(bad.status, 400);
    assert.match(bad.page, /Enter an email address/);
    const good = await submitDetails(service.request, bad.page, { email: "carol@example.com" });
    assert.match(good.page, /signed in/);
    assert.equal(await token(service, flow.deviceCode), 200);
  });

  it("doesn't ask a returning Full account that already gave an email", async () => {
    const { service } = await open();
    await service.signIn({ id: 103, login: "dave" });
    const again = await startBrowserFlow(service.request, { id: 103, login: "dave" }, undefined, { stopAtDetails: true });
    assert.doesNotMatch(again.page, /action="\/device\/details"/);
    assert.match(again.page, /signed in/);
  });

  it("offers a Starter account the invite field; a valid code makes it Full, a bad one asks again", async () => {
    const { service, admin } = await open();
    const code = await createInvite(service, admin);
    const flow = await startBrowserFlow(service.request, { id: 104, login: "erin", createdAt: NEW, publicRepos: 0 }, undefined, { stopAtDetails: true });
    assert.match(flow.page, /name="invite_code"/);
    assert.match(flow.page, /Starter access: a small free allowance to try dl, 5M tokens a week of every model, GPT-6 included, up to \$0.50/);

    const wrong = await submitDetails(service.request, flow.page, { invite: "DL-NOPE-NOPE" });
    assert.equal(wrong.status, 400);
    assert.match(wrong.page, /invite code isn&#39;t valid|invite code isn't valid/);
    const right = await submitDetails(service.request, wrong.page, { invite: code });
    assert.match(right.page, /signed in/);
    assert.equal(await token(service, flow.deviceCode), 200);
    const row = await person(service, admin, 104);
    assert.equal(row.level, "full");
    assert.equal(row.levelReason, "invite");
  });

  it("lets a Starter account continue without a code", async () => {
    const { service, admin } = await open();
    const flow = await startBrowserFlow(service.request, { id: 105, login: "frank", createdAt: NEW, publicRepos: 0 });
    assert.match(flow.page, /signed in/);
    assert.equal((await person(service, admin, 105)).level, "starter");
  });

  it("lets a Starter account redeem a code on a later sign-in, and keeps Full after that", async () => {
    const { service, admin } = await open();
    const starter = { id: 106, login: "gina", createdAt: NEW, publicRepos: 0 };
    await service.signIn(starter);
    assert.equal((await person(service, admin, 106)).level, "starter");
    const code = await createInvite(service, admin);
    await service.signIn(starter, { invite: code });
    const row = await person(service, admin, 106);
    assert.equal(row.level, "full");
    assert.equal(row.levelReason, "invite");
    // Signing in again with the same thin profile doesn't undo the invite.
    await service.signIn(starter);
    assert.equal((await person(service, admin, 106)).level, "full");
  });
});
