import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ScriptedPrompter } from "./prompt.js";
import { FakeSystem } from "./test-support/fake-system.js";
import { up } from "./up.js";
import { withCatalog } from "./test-support/fake-catalog.js";

const fetchOk = withCatalog((async () => Response.json({ login: "octo" })) as unknown as typeof fetch);
const answers = () => new ScriptedPrompter({
  "Tailscale auth key": "tskey-auth-k1-abc",
  "OpenRouter API key": `sk-or-v1-${"a".repeat(40)}`,
  "GitHub token": `github_pat_${"b".repeat(40)}`,
});
const install = (system: FakeSystem) => up(system, { prompter: answers(), fetchImpl: fetchOk, sleep: async () => {} });

describe("Docker", () => {
  it("starts an installed but stopped Docker (e.g. Ubuntu's docker.io) instead of replacing it", async () => {
    const system = new FakeSystem();
    system.dockerInstalled = true;
    await install(system);
    assert.ok(!system.ran.some((command) => command.includes("get.docker.com")), "never reinstalls over an existing Docker");
    assert.ok(system.logs.includes("ok Setting up Docker: was installed; started it"));
    assert.ok(system.docker);
  });

  it("brings up docker.socket before docker.service, so socket activation can't fail", async () => {
    const system = new FakeSystem();
    await install(system);
    const ran = system.ran;
    const socket = ran.indexOf("systemctl enable --now docker.socket");
    const restart = ran.indexOf("systemctl restart docker.service");
    assert.ok(ran.indexOf("systemctl reset-failed docker.service docker.socket") < socket, "clears a start-limit-hit state first");
    assert.ok(socket >= 0 && socket < restart);
    assert.ok(system.docker);
  });

  it("stops with the right journal hint if Docker never answers", async () => {
    const system = new FakeSystem();
    system.dockerInstalled = true;
    system.dockerSocket = true;
    const restart = system.run.bind(system);
    system.run = async (command, args, options) => {
      const result = await restart(command, args, options);
      if (command === "systemctl" && args[0] === "restart" && args[1] === "docker.service") system.docker = false;
      return result;
    };
    await assert.rejects(() => install(system), /Docker didn't come up; check: journalctl -u docker -n 50/);
  });
});
