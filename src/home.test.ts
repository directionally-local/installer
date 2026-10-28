import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { briefStatus, connectLaptop, laptopsCommand, pairLaptop, serverHome, serverRunsCommand } from "./home.js";
import { ScriptedPrompter } from "./prompt.js";
import { readState, writeState } from "./state.js";
import { FakeSystem } from "./test-support/fake-system.js";
import { palette } from "./ui.js";
import { up } from "./up.js";

const c = palette(false);
const fetchOk = (async () => Response.json({ login: "octo" })) as unknown as typeof fetch;

async function server(): Promise<{ system: FakeSystem; out: () => string; write: (text: string) => void; reset: () => void }> {
  const system = new FakeSystem();
  await up(system, {
    prompter: new ScriptedPrompter({ "Tailscale auth key": "tskey-auth-k1-abc", "OpenRouter API key": `sk-or-v1-${"a".repeat(40)}`, "GitHub token": `github_pat_${"b".repeat(40)}` }),
    fetchImpl: fetchOk,
    sleep: async () => {},
  });
  let text = "";
  return { system, out: () => text, write: (chunk) => { text += chunk; }, reset: () => { text = ""; } };
}

describe("dl on the server", () => {
  it("home says what this is, whether it's healthy, who's connected, and what's running", async () => {
    const { system, out, write } = await server();
    const now = new Date().toISOString();
    system.laptops = [
      { id: "11111111-aaaa", name: "MacBook (autopilot)", status: "active", scopes: ["conversations:write"], createdAt: now, lastUsedAt: now },
      { id: "22222222-bbbb", name: "Owner (browser)", status: "active", scopes: ["pairing:approve"], createdAt: now, lastUsedAt: null },
      { id: "33333333-cccc", name: "Old phone", status: "revoked", scopes: ["conversations:write"], createdAt: now, lastUsedAt: null },
    ];
    system.serverRuns = [
      { conversationId: "aaaaaaaa-1", status: "running", active: true, repository: "me/app", branch: "aster/aaaaaaaa", pullRequestURL: null, startedBy: "MacBook", createdAt: now },
      { conversationId: "bbbbbbbb-2", status: "completed", active: false, repository: "me/app", branch: "aster/bbbbbbbb", pullRequestURL: "https://github.com/me/app/pull/7", startedBy: "MacBook", createdAt: now },
    ];
    system.pendingCodes = [{ code: "BCDF-GHJK", name: "Work laptop (autopilot)" }];
    await serverHome(system, (await readState(system))!, write, c);
    const text = out();
    assert.match(text, /Directionally Local {2}● healthy {2}https:\/\/box\.tail1234\.ts\.net/);
    assert.match(text, /Background coding agents on your own server/);
    assert.match(text, /Laptops +1 connected · MacBook \(autopilot\)/, "owner browsers and revoked credentials aren't laptops");
    assert.match(text, /Runs +1 running · 1 this week/);
    assert.match(text, /Waiting for approval: BCDF-GHJK \(Work laptop \(autopilot\)\)/);
    assert.match(text, /Connect a laptop +dl connect-laptop/);
    assert.doesNotMatch(text, /tailscale|autopilot aster|systemctl|journalctl/);
  });

  it("the login line is one status line and a pointer to dl", async () => {
    const { system, out, write } = await server();
    system.enabled.delete("autopilot.service");
    await briefStatus(system, (await readState(system))!, write, c);
    assert.match(out(), /● agent server stopped/);
    assert.match(out(), /Type dl for what this is/);
  });

  it("connect-laptop explains the steps, approves a code, and laptops can disconnect one", async () => {
    const { system, out, write, reset } = await server();
    const state = (await readState(system))!;
    system.pendingCodes = [{ code: "BCDF-GHJK", name: "MacBook (autopilot)" }];
    assert.equal(await connectLaptop(system, state, undefined, write, c), 0);
    assert.match(out(), /BCDF-GHJK {2}MacBook \(autopilot\) {3}dl connect-laptop BCDF-GHJK/);
    assert.match(out(), /claim\?token=aster_claim_/);
    assert.match(out(), /npm install -g directionallylocal\n +dl connect https:\/\/box\.tail1234\.ts\.net/);

    reset();
    assert.equal(await connectLaptop(system, state, "BCDF-GHJK", write, c), 0);
    assert.deepEqual(system.approved, ["BCDF-GHJK"]);
    assert.equal(await connectLaptop(system, state, "ZZZZ-ZZZZ", write, c), 1);

    const now = new Date().toISOString();
    system.laptops = [{ id: "11111111-aaaa", name: "MacBook", status: "active", scopes: [], createdAt: now, lastUsedAt: null }];
    reset();
    assert.equal(await laptopsCommand(system, [], write, c), 0);
    assert.match(out(), /● MacBook +not used yet · 11111111/);
    assert.equal(await laptopsCommand(system, ["remove", "macbook"], write, c), 0);
    assert.deepEqual(system.revoked, ["11111111-aaaa"]);
    assert.equal(await laptopsCommand(system, ["remove", "nope"], write, c), 1);
  });

  it("runs lists the server's runs with their pull requests", async () => {
    const { system, out, write } = await server();
    assert.equal(await serverRunsCommand(system, write, c), 0);
    assert.match(out(), /No runs yet\. From a laptop: {2}dl run "fix the flaky checkout test"/);
    system.serverRuns = [{ conversationId: "bbbbbbbb-2", status: "completed", active: false, repository: "me/app", branch: "aster/bbbbbbbb", pullRequestURL: "https://github.com/me/app/pull/7", startedBy: "MacBook", createdAt: new Date().toISOString() }];
    await serverRunsCommand(system, write, c);
    assert.match(out(), /✓ bbbbbbbb {2}completed +me\/app +https:\/\/github\.com\/me\/app\/pull\/7 {2}· MacBook/);
  });
});

describe("a server set up from the laptop", () => {
  async function sshServer() {
    const { system, out, write, reset } = await server();
    const state = (await readState(system))!;
    await writeState(system, { ...state, access: { mode: "ssh", url: "http://127.0.0.1:4096" } });
    return { system, out, write, reset, state: (await readState(system))! };
  }

  it("home and the login line say it's reached over SSH from the laptop", async () => {
    const { system, out, write, reset, state } = await sshServer();
    await serverHome(system, state, write, c);
    assert.match(out(), /Directionally Local {2}● healthy {2}over SSH from your laptop/);
    reset();
    await briefStatus(system, state, write, c);
    assert.match(out(), /● healthy {2}over SSH from your laptop/);
  });

  it("dl pair makes a 90-day credential for the laptop and prints it only in its JSON line", async () => {
    const { system, out, write, state } = await sshServer();
    const logged = system.logs.length;
    await pairLaptop(system, state, "  Sina's MacBook ", write);
    const printed = out();
    assert.ok(printed.endsWith("\n") && printed.trimEnd().split("\n").length === 1, "exactly one line");
    const paired = JSON.parse(printed) as Record<string, unknown>;
    const created = system.created.at(-1)!;
    assert.deepEqual(paired, { token: created.token, credentialId: "cred-1", name: "Sina's MacBook", expiresAt: "2027-01-26T08:00:00.000Z", url: "http://127.0.0.1:4096" });
    assert.deepEqual([created.workspace, created.days], ["default", 90]);
    const command = system.commands.find(({ args }) => args.includes("token") && args.includes("create"))!;
    assert.deepEqual(command.args.slice(0, 7), ["-u", "autopilot", "--", "env", "HOME=/var/lib/autopilot", "AUTOPILOT_ASTER_CONFIG=/etc/autopilot/aster.json", "AUTOPILOT_ASTER_DB=/var/lib/autopilot/aster.db"]);
    assert.deepEqual(command.args.slice(-10), ["aster", "token", "create", "--name", "Sina's MacBook", "--workspace", "default", "--expires-in-days", "90", "--json"]);
    assert.equal(command.secretOutput, true, "the output, which holds the token, stays out of the install log");
    assert.ok(!system.ran.some((line) => line.includes(created.token)));
    assert.ok(!system.logs.slice(logged).some((line) => line.includes(created.token)));
  });

  it("dl pair refuses a bad name and reports Autopilot failing without echoing its output", async () => {
    const { system, write, state } = await sshServer();
    await assert.rejects(pairLaptop(system, state, "   ", write), /--name must be/);
    await assert.rejects(pairLaptop(system, state, "a\nb", write), /--name must be/);
    const run = system.run.bind(system);
    system.run = async (command, args, options) => args.includes("create")
      ? { code: 0, stdout: "aster_secret_token not json\n", stderr: "" }
      : run(command, args, options);
    await assert.rejects(pairLaptop(system, state, "MacBook", write), (error: Error) => !error.message.includes("aster_secret_token") && /wasn't what dl expects/.test(error.message));
    system.run = async (command, args, options) => args.includes("create")
      ? { code: 1, stdout: "", stderr: "unknown option --workspace" }
      : run(command, args, options);
    await assert.rejects(pairLaptop(system, state, "MacBook", write), /Couldn't create a credential for the laptop: unknown option --workspace; run dl up/);
  });
});
