import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { briefStatus, connectLaptop, laptopsCommand, serverHome, serverRunsCommand } from "./home.js";
import { ScriptedPrompter } from "./prompt.js";
import { readState } from "./state.js";
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
