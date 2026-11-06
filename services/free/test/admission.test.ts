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
  /** The level they got: "full" or "starter". */
  level?: string;
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

async function attempt(service: Service, admin: string, createdAt: string, invite: Invite, id = 100, publicRepos?: number): Promise<Outcome> {
  const flow = await startBrowserFlow(service.request, { id, login: `user${id}`, createdAt, ...(publicRepos !== undefined ? { publicRepos } : {}) });
  const poll = async () => service.request("POST", "/v1/device/token", { body: { device_code: flow.deviceCode } });
  const via = async () => {
    const people = (await (await service.request("GET", "/admin/people", { token: admin })).json()) as { people: Array<{ githubId: number; admittedVia: string; level: string }> };
    const row = people.people.find((person) => person.githubId === id);
    return { via: row?.admittedVia, level: row?.level };
  };
  const askedForInvite = flow.page.includes('name="invite_code"');
  if (!askedForInvite) {
    const response = await poll();
    if (response.status === 200) return { admitted: true, ...(await via()), askedForInvite };
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
    return { admitted: true, ...(await via()), askedForInvite };
  }
  return { admitted: false, askedForInvite, inviteError: /role="alert"><strong>([^<]+)</.exec(page)?.[1] };
}

async function level(service: Service, admin: string, githubId: number): Promise<{ level: string; reason: string | null } | undefined> {
  const body = (await (await service.request("GET", "/admin/people", { token: admin })).json()) as { people: Array<{ githubId: number; level: string; levelReason: string | null }> };
  const row = body.people.find((person) => person.githubId === githubId);
  return row ? { level: row.level, reason: row.levelReason } : undefined;
}

describe("admission matrix", () => {
  // [open admission, account age, invite] → expected
  const cases: Array<[Mode, "old" | "new", Invite, Partial<Outcome>]> = [
    // Off (the default): invite-only for everyone, whatever the account's age.
    ["off", "old", "none", { admitted: false, askedForInvite: true, code: "invite_required" }],
    ["off", "old", "valid", { admitted: true, askedForInvite: true }],
    ["off", "old", "invalid", { admitted: false, askedForInvite: true, inviteError: "That invite code isn&#39;t valid or was already used." }],
    ["off", "new", "none", { admitted: false, askedForInvite: true, code: "invite_required" }],
    ["off", "new", "valid", { admitted: true, askedForInvite: true }],
    ["off", "new", "invalid", { admitted: false, askedForInvite: true, inviteError: "That invite code isn&#39;t valid or was already used." }],
    // On (env or admin override): everyone walks in; the level decides the allowance.
    ...(["env", "override"] as const).flatMap((mode): Array<[Mode, "old" | "new", Invite, Partial<Outcome>]> => [
      [mode, "old", "none", { admitted: true, askedForInvite: false, via: "open", level: "full" }],
      [mode, "old", "valid", { admitted: true, askedForInvite: false, via: "open", level: "full" }],
      [mode, "new", "none", { admitted: true, askedForInvite: false, via: "open", level: "starter" }],
      [mode, "new", "valid", { admitted: true, askedForInvite: false, via: "open", level: "starter" }],
      [mode, "new", "invalid", { admitted: true, askedForInvite: false, via: "open", level: "starter" }],
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

  it("has no cap on people while open: MAX_ACTIVE_USERS applies only while invite-only", async () => {
    const { service: svc, admin } = await service("env");
    await svc.request("POST", "/admin/config", { token: admin, body: { maxActiveUsers: 1 } });
    assert.equal((await attempt(svc, admin, OLD, "none", 100)).admitted, true);
    assert.equal((await attempt(svc, admin, OLD, "none", 101)).admitted, true, "open: past the cap");
    // A young account with an invite isn't capped either while admission is open.
    assert.equal((await attempt(svc, admin, NEW, "valid", 102)).admitted, true);
    // Back to invite-only: the cap holds again.
    await svc.request("POST", "/admin/config", { token: admin, body: { openAdmission: false } });
    const full = await attempt(svc, admin, OLD, "valid", 103);
    assert.equal(full.admitted, false);
  });

  it("keeps one account per GitHub id: signing in again doesn't take another place", async () => {
    const { service: svc, admin } = await service("env");
    await svc.request("POST", "/admin/config", { token: admin, body: { maxActiveUsers: 1 } });
    assert.equal((await attempt(svc, admin, OLD, "none", 100)).admitted, true);
    assert.equal((await attempt(svc, admin, OLD, "none", 100)).admitted, true);
    const people = (await (await svc.request("GET", "/admin/people", { token: admin })).json()) as { people: unknown[] };
    assert.equal(people.people.length, 2, "the owner and one person");
  });

  it("gives accounts past the network's daily sign-ups Starter, not a refusal", async () => {
    const { service: svc, admin } = await service("env");
    for (let id = 100; id < 103; id++) assert.equal((await attempt(svc, admin, NEW, "none", id, 0)).admitted, true);
    const limited = await attempt(svc, admin, NEW, "none", 103, 0);
    assert.equal(limited.admitted, true, "still gets in");
    assert.equal((await level(svc, admin, 103))?.level, "starter", "but as Starter");
  });

  it("keeps a qualifying account Full even past the network's daily sign-ups", async () => {
    const { service: svc, admin } = await service("env");
    for (let id = 100; id < 105; id++) {
      assert.equal((await attempt(svc, admin, OLD, "none", id, 3)).admitted, true);
      assert.equal((await level(svc, admin, id))?.level, "full", `account ${id}`);
    }
  });

  it("flags non-qualifying accounts past the network's daily sign-ups as network_limit", async () => {
    const { service: svc, admin } = await service("env");
    for (let id = 100; id < 103; id++) {
      assert.equal((await attempt(svc, admin, NEW, "none", id, 0)).admitted, true);
      const row = await level(svc, admin, id);
      assert.equal(row?.level, "starter");
      assert.notEqual(row?.reason, "network_limit", "within the limit: its own reason");
    }
    for (let id = 103; id < 105; id++) {
      assert.equal((await attempt(svc, admin, NEW, "none", id, 0)).admitted, true);
      assert.deepEqual(await level(svc, admin, id), { level: "starter", reason: "network_limit" });
    }
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
