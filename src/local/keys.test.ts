import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ScriptedPrompter } from "../prompt.js";
import { RecordingUi } from "../ui.js";
import { listLocalKeys, setLocalKey, type LocalKeyOptions } from "./keys.js";
import { parseLocalEnvFile } from "./layout.js";
import { setUpOnThisComputer } from "./setup.js";
import { FakeComputer } from "./test-support/fake-computer.js";

const OLD_OPENROUTER = `sk-or-v1-${"a".repeat(40)}`;
const OLD_GITHUB = `github_pat_${"b".repeat(40)}`;
const NEW_OPENROUTER = `sk-or-v1-${"n".repeat(38)}zq`;
const NEW_GITHUB = `github_pat_${"c".repeat(40)}`;
const fetchOk = (async (url: string | URL | Request) =>
  String(url).includes("api.github.com") ? Response.json({ login: "ada" }) : Response.json({ data: {} })) as typeof fetch;

function options(system: FakeComputer, extra: Partial<LocalKeyOptions> = {}): LocalKeyOptions {
  return {
    system,
    home: system.home,
    platform: "darwin",
    arch: "arm64",
    env: {},
    execPath: "/opt/homebrew/Cellar/node/24.22.1/bin/node",
    nodeVersion: "24.22.1",
    hostname: "Adas-MacBook-Air.local",
    sleep: async () => {},
    now: () => new Date("2026-10-28T10:00:00Z"),
    ...extra,
  };
}

async function installed(system = new FakeComputer(), extra: Partial<LocalKeyOptions> = {}): Promise<FakeComputer> {
  await setUpOnThisComputer({ ui: new RecordingUi(), prompter: new ScriptedPrompter({}), answers: { openrouterKey: OLD_OPENROUTER, githubToken: OLD_GITHUB }, ...options(system, extra) });
  system.commands.length = 0;
  system.restarted.length = 0;
  return system;
}

function assertNotInArgv(system: FakeComputer, value: string) {
  assert.ok(![...system.commands, ...system.probes].some((entry) => [entry.command, ...entry.args].some((arg) => arg.includes(value))), "never in argv");
  assert.ok(!system.logs.some((line) => line.includes(value)), "never in logs");
}

describe("dl keys on this computer", () => {
  it("replaces the OpenRouter key in Hotcell's file keystore and restarts its LaunchAgent", async () => {
    const system = await installed();
    const result = await setLocalKey("openrouter", NEW_OPENROUTER, options(system, { fetchImpl: fetchOk }));

    assert.deepEqual(result, { ok: true, key: "openrouter", detail: "replaced in Hotcell; Hotcell restarted" });
    assert.equal(system.hotcellKeys.get("openrouter"), NEW_OPENROUTER);
    const add = system.commands.find((entry) => entry.args.includes("add"));
    assert.equal(add?.input, NEW_OPENROUTER);
    assert.equal(add?.env?.HOTCELL_KEYSTORE, "file", "the 0600 file, never the login Keychain");
    assert.equal(add?.env?.HOTCELL_HOME, "/Users/ada/.directionallylocal/hotcell");
    assert.ok(system.ran.includes("launchctl kickstart -k gui/501/com.directionallylocal.hotcell"));
    assert.deepEqual(system.restarted, ["com.directionallylocal.hotcell"], "only Hotcell restarts");
    assertNotInArgv(system, NEW_OPENROUTER);
  });

  it("replaces the GitHub token in the 0600 github.env and restarts Autopilot", async () => {
    const system = await installed();
    const result = await setLocalKey("github", NEW_GITHUB, options(system, { fetchImpl: fetchOk }));

    assert.deepEqual(result, { ok: true, key: "github", detail: "signed in as ada; Autopilot restarted" });
    const file = system.files.get("/Users/ada/.directionallylocal/config/github.env");
    assert.equal(parseLocalEnvFile(file?.content).GITHUB_TOKEN, NEW_GITHUB);
    assert.equal(file?.mode, 0o600);
    assert.deepEqual(system.restarted, ["com.directionallylocal.autopilot"]);
    assert.equal(system.hotcellKeys.get("openrouter"), OLD_OPENROUTER);
    assertNotInArgv(system, NEW_GITHUB);
  });

  it("loads a stopped LaunchAgent again instead of failing", async () => {
    const system = await installed();
    system.running.delete("com.directionallylocal.autopilot");
    await setLocalKey("github", NEW_GITHUB, options(system));
    assert.ok(system.ran.includes("launchctl bootstrap gui/501 /Users/ada/Library/LaunchAgents/com.directionallylocal.autopilot.plist"));
    assert.ok(system.running.has("com.directionallylocal.autopilot"));
  });

  it("restarts the systemd user unit on Linux", async () => {
    const system = new FakeComputer("/home/ada");
    system.files.set("/var/run/docker.sock", { content: "", mode: 0o660 });
    system.bridgeIp = "172.17.0.1";
    const linux = { platform: "linux" as const, execPath: "/usr/bin/node", hostname: "ada-desktop" };
    await installed(system, linux);
    await setLocalKey("openrouter", NEW_OPENROUTER, options(system, linux));
    assert.ok(system.ran.includes("systemctl --user restart directionallylocal-hotcell.service"));
    assert.equal(system.hotcellKeys.get("openrouter"), NEW_OPENROUTER);
  });

  it("rejects a bad key, or a computer without an install, before changing anything", async () => {
    const system = await installed();
    await assert.rejects(() => setLocalKey("github", "hunter2", options(system)), /doesn't look like a GitHub token/);
    await assert.rejects(() => setLocalKey("openrouter", NEW_OPENROUTER, options(system, { fetchImpl: (async () => new Response("", { status: 401 })) as unknown as typeof fetch })), /OpenRouter rejected that key/);
    assert.deepEqual(system.commands, []);
    await assert.rejects(() => setLocalKey("github", NEW_GITHUB, options(new FakeComputer())), /isn't set up on this computer; run dl setup/);
  });

  it("lists which keys are set without their values", async () => {
    const system = await installed();
    const listing = await listLocalKeys(options(system, { fetchImpl: fetchOk }));
    assert.deepEqual(listing, [
      { key: "openrouter", set: true, detail: "sk-or…aa" },
      { key: "github", set: true, detail: "signed in as ada" },
    ]);
    assert.ok(!JSON.stringify(listing).includes(OLD_OPENROUTER) && !JSON.stringify(listing).includes(OLD_GITHUB));
    assertNotInArgv(system, OLD_GITHUB);
  });
});
