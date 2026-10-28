import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { doctor } from "./doctor.js";
import { AUTO_UPGRADES, NODE_AUTO_UPDATES, cellDockerfile } from "./layout.js";
import { ScriptedPrompter } from "./prompt.js";
import { FakeSystem } from "./test-support/fake-system.js";
import { uninstall } from "./uninstall.js";
import { up } from "./up.js";

const fetchOk = (async () => Response.json({ login: "octo" })) as unknown as typeof fetch;
const answers = () => new ScriptedPrompter({
  "Tailscale auth key": "tskey-auth-k1-abc",
  "OpenRouter API key": `sk-or-v1-${"a".repeat(40)}`,
  "GitHub token": `github_pat_${"b".repeat(40)}`,
});
const install = (system: FakeSystem) => up(system, { prompter: answers(), fetchImpl: fetchOk, sleep: async () => {} });

describe("automatic Node.js security updates", () => {
  it("adds NodeSource to unattended-upgrades and keeps an operator's own schedule", async () => {
    const system = new FakeSystem();
    system.files.set(AUTO_UPGRADES, { content: 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n// mine\n', mode: 0o644 });
    await install(system);
    assert.match(system.files.get(NODE_AUTO_UPDATES)?.content ?? "", /Origins-Pattern \{\s+"site=deb\.nodesource\.com";\s+\};/);
    assert.match(system.files.get(AUTO_UPGRADES)?.content ?? "", /\/\/ mine/, "an existing schedule is left alone");
    assert.ok(!system.ran.some((command) => command.startsWith("apt-get install")), "already installed");
    assert.equal((await doctor(system)).find((check) => check.name === "security updates")?.ok, true);
  });

  it("installs and enables unattended-upgrades where they're missing", async () => {
    const system = new FakeSystem();
    system.unattendedUpgrades = false;
    await install(system);
    assert.ok(system.ran.includes("apt-get install -y -qq unattended-upgrades"));
    assert.match(system.files.get(AUTO_UPGRADES)?.content ?? "", /APT::Periodic::Unattended-Upgrade "1";/);
  });

  it("says so instead of guessing when Node.js didn't come from NodeSource", async () => {
    const system = new FakeSystem();
    system.nodeFromNodeSource = false;
    await install(system);
    assert.equal(system.files.has(NODE_AUTO_UPDATES), false);
    assert.ok(system.logs.some((line) => line.includes("isn't from NodeSource here; keep it patched yourself")));
    assert.equal((await doctor(system)).find((check) => check.name === "security updates")?.detail, "Node.js isn't included");
  });

  it("uninstall removes only its own addition", async () => {
    const system = new FakeSystem();
    await install(system);
    await uninstall(system);
    assert.equal(system.files.has(NODE_AUTO_UPDATES), false);
    assert.ok(system.files.has(AUTO_UPGRADES), "Ubuntu's own automatic updates stay on");
  });

  it("builds sandboxes on Node 24", () => {
    assert.match(cellDockerfile(), /^FROM node:24-bookworm$/m);
  });
});
