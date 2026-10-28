import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { doctor } from "./doctor.js";
import { nodeAdvisory } from "./node-advisory.js";
import { ScriptedPrompter } from "./prompt.js";
import { FakeSystem } from "./test-support/fake-system.js";
import { up } from "./up.js";

describe("Node.js advisory (CVE-2026-111497)", () => {
  it("matches Hotcell's engines: ^22.23.4 || ^24.22.1 || >=26.12.1", () => {
    const today = new Date("2026-10-28T00:00:00Z");
    for (const version of ["20.19.5", "22.22.0", "22.23.3", "23.11.1", "24.22.0", "25.9.0", "26.12.0", ""]) {
      assert.equal(nodeAdvisory(version, today).ok, false, version);
    }
    for (const version of ["22.23.4", "v24.22.1", "24.23.0", "26.12.1", "27.0.0"]) {
      assert.equal(nodeAdvisory(version, today).ok, true, version);
    }
    assert.match(nodeAdvisory("22.23.3", today).message ?? "", /22\.23\.3 is vulnerable for CVE-2026-111497/);
    assert.match(nodeAdvisory("25.9.0", today).message ?? "", /Node\.js 25 is unsupported/);
  });

  it("warns as a line nears end of life", () => {
    assert.equal(nodeAdvisory("22.23.4", new Date("2026-10-28")).message, undefined);
    assert.match(nodeAdvisory("22.23.4", new Date("2027-03-01")).message ?? "", /stops getting security fixes on 2027-04-30/);
  });

  it("refuses to install onto a vulnerable Node and doctor flags it", async () => {
    const system = new FakeSystem();
    system.nodeVersion = "22.23.3";
    await assert.rejects(() => up(system, { prompter: new ScriptedPrompter({}), sleep: async () => {} }), /22\.23\.3 is vulnerable for CVE-2026-111497[\s\S]*Re-run install\.sh/);
    assert.deepEqual(system.commands, [], "preflight changes nothing");
    const node = (await doctor(system)).find((check) => check.name === "node")!;
    assert.equal(node.ok, false);

    system.nodeVersion = "24.22.1";
    assert.equal((await doctor(system)).find((check) => check.name === "node")?.ok, true);
  });
});
