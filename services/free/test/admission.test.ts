import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, createInvite, createService, startBrowserFlow, type Service } from "./harness.js";

const OLD = "2015-01-01T00:00:00Z";
const NEW = "2026-10-20T00:00:00Z"; // 15 days before the harness clock

type Invite = "none" | "valid" | "invalid";
type Mode = "off" | "env" | "override";

interface Outcome {
  admitted: boolean;
  /** The code the terminal gets when not admitted. */
  code?: string;
  /** How the person got in, from the admin listing. */
  via?: string;
  /** The invite page asked for a code. */
  askedForInvite: boolean;
  /** The invite page's error after an invalid code. */
  inviteError?: string;
}

async function service(mode: Mode): Promise<{ service: Service; admin: string }> {
  const service = await createService(mode === "env" ? { OPEN_ADMISSION: "true" } : {});
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  if (mode === "override") {
    const set = await service.request("POST", "/admin/config", { token: admin, body: { openAdmission: true } });
    assert.equal(set.status, 200);
  }
  return { service, admin };
}

async function attempt(service: Service, admin: string, createdAt: string, invite: Invite, id = 100): Promise<Outcome> {
  const flow = await startBrowserFlow(service.request, { id, login: `user${id}`, createdAt });
  const poll = async () => service.request("POST", "/v1/device/token", { body: { device_code: flow.deviceCode } });
  const via = async () => {
    const people = (await (await service.request("GET", "/admin/people", { token: admin })).json()) as { people: Array<{ githubId: number; admittedVia: string }> };
    return people.people.find((person) => person.githubId === id)?.admittedVia;
  };
  const askedForInvite = flow.page.includes('name="invite_code"');
  if (!askedForInvite) {
    const response = await poll();
    if (response.status === 200) return { admitted: true, via: await via(), askedForInvite };
    return { admitted: false, code: ((await response.json()) as { error: { code: string } }).error.code, askedForInvite };
  }
  const ticket = /name="ticket" value="([^"]+)"/.exec(flow.page)![1]!;
  if (invite === "none") {
    await service.request("POST", "/device/no-invite", { form: { ticket } });
    const response = await poll();
    return { admitted: false, code: ((await response.json()) as { error: { code: string } }).error.code, askedForInvite };
  }
  const code = invite === "valid" ? await createInvite(service, admin) : "DL-ZZZZ-ZZZZ";
  const page = await (await service.request("POST", "/device/invite", { form: { ticket, invite_code: code } })).text();
  if (page.includes("signed in")) {
    assert.equal((await poll()).status, 200);
    return { admitted: true, via: await via(), askedForInvite };
  }
  return { admitted: false, askedForInvite, inviteError: /role="alert"><strong>([^<]+)</.exec(page)?.[1] };
}

describe("admission matrix", () => {
  // [open admission, account age, invite] → expected
  const cases: Array<[Mode, "old" | "new", Invite, Partial<Outcome>]> = [
    // Off (the default): invite-only for everyone, whatever the account's age.
    ["off", "old", "none", { admitted: false, askedForInvite: true, code: "invite_required" }],
    ["off", "old", "valid", { admitted: true, askedForInvite: true }],
    ["off", "old", "invalid", { admitted: false, askedForInvite: true, inviteError: "That invite code isn&#39;t valid or was already used." }],
    ["off", "new", "none", { admitted: false, askedForInvite: true, code: "account_too_new" }],
    ["off", "new", "valid", { admitted: true, askedForInvite: true }],
    ["off", "new", "invalid", { admitted: false, askedForInvite: true, inviteError: "That invite code isn&#39;t valid or was already used." }],
    // On (env or admin override): old enough accounts walk in; new ones still need an invite.
    ...(["env", "override"] as const).flatMap((mode): Array<[Mode, "old" | "new", Invite, Partial<Outcome>]> => [
      [mode, "old", "none", { admitted: true, askedForInvite: false, via: "open" }],
      [mode, "old", "valid", { admitted: true, askedForInvite: false, via: "open" }],
      [mode, "new", "none", { admitted: false, askedForInvite: true, code: "account_too_new" }],
      [mode, "new", "valid", { admitted: true, askedForInvite: true }],
      [mode, "new", "invalid", { admitted: false, askedForInvite: true, inviteError: "That invite code isn&#39;t valid or was already used." }],
    ]),
  ];

  for (const [mode, age, invite, expected] of cases) {
    it(`open admission ${mode}, ${age} account, ${invite} invite`, async () => {
      const { service: svc, admin } = await service(mode);
      const outcome = await attempt(svc, admin, age === "old" ? OLD : NEW, invite);
      for (const [key, value] of Object.entries(expected)) assert.equal(outcome[key as keyof Outcome], value, `${key}: ${JSON.stringify(outcome)}`);
      if (outcome.admitted && expected.via === undefined) assert.match(outcome.via ?? "", /^invite:/);
    });
  }
});

describe("open admission", () => {
  it("is off by default", async () => {
    const svc = await createService();
    const flow = await startBrowserFlow(svc.request, { id: 100, login: "alice", createdAt: OLD });
    assert.match(flow.page, /invite-only for now/);
  });

  it("still stops at MAX_ACTIVE_USERS, which the admin can raise at runtime", async () => {
    const { service: svc, admin } = await service("env");
    await svc.request("POST", "/admin/config", { token: admin, body: { maxActiveUsers: 1 } });
    assert.equal((await attempt(svc, admin, OLD, "none", 100)).admitted, true);
    const full = await attempt(svc, admin, OLD, "none", 101);
    assert.deepEqual([full.admitted, full.code], [false, "cohort_full"]);
    await svc.request("POST", "/admin/config", { token: admin, body: { maxActiveUsers: 2 } });
    assert.equal((await attempt(svc, admin, OLD, "none", 102)).admitted, true);
  });

  it("keeps one account per GitHub id: signing in again doesn't take another place", async () => {
    const { service: svc, admin } = await service("env");
    await svc.request("POST", "/admin/config", { token: admin, body: { maxActiveUsers: 1 } });
    assert.equal((await attempt(svc, admin, OLD, "none", 100)).admitted, true);
    assert.equal((await attempt(svc, admin, OLD, "none", 100)).admitted, true);
    const people = (await (await svc.request("GET", "/admin/people", { token: admin })).json()) as { people: unknown[] };
    assert.equal(people.people.length, 2, "the owner and one person");
  });

  it("limits new accounts per network, then says so", async () => {
    const { service: svc, admin } = await service("env");
    for (let id = 100; id < 103; id++) assert.equal((await attempt(svc, admin, OLD, "none", id)).admitted, true);
    const limited = await attempt(svc, admin, OLD, "none", 103);
    assert.deepEqual([limited.admitted, limited.code], [false, "too_many_signups"]);
  });

  it("goes back to the env value when the override is cleared", async () => {
    const { service: svc, admin } = await service("override");
    await svc.request("POST", "/admin/config", { token: admin, body: { openAdmission: null } });
    const outcome = await attempt(svc, admin, OLD, "none");
    assert.deepEqual([outcome.admitted, outcome.code], [false, "invite_required"]);
  });

  it("can be switched off by override even when env turns it on", async () => {
    const { service: svc, admin } = await service("env");
    await svc.request("POST", "/admin/config", { token: admin, body: { openAdmission: false } });
    assert.equal((await attempt(svc, admin, OLD, "none")).code, "invite_required");
  });
});
