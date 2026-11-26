import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { autopilotHome } from "./autopilot.js";
import { autopilotSpec, ensureAutopilot } from "./autopilot-install.js";

function capture() {
  let text = "";
  return { out: (t: string) => { text += t; }, err: (t: string) => { text += t; }, text: () => text };
}

describe("Autopilot, downloaded when it's picked", () => {
  it("uses an installed Autopilot as it is, downloading nothing", async () => {
    const io = capture();
    const installs: string[] = [];
    const found = await ensureAutopilot(io, { find: async () => ({ command: "node", args: ["/ap.mjs"] }), install: async (spec) => void installs.push(spec), version: "3.31.0" });
    assert.deepEqual(found, { command: "node", args: ["/ap.mjs"] });
    assert.deepEqual(installs, []);
    assert.equal(io.text(), "");
  });

  it("downloads the pinned version into dl's home the first time, then runs it", async () => {
    const io = capture();
    let installed = false;
    const installs: Array<[string, string]> = [];
    const found = await ensureAutopilot(io, {
      env: { DL_HOME: "/home/me/.directionallylocal" },
      find: async () => installed ? { command: "node", args: ["/home/me/.directionallylocal/autopilot/lib/node_modules/autopilot-ai/bin/autopilot.mjs"] } : undefined,
      install: async (spec, prefix) => { installs.push([spec, prefix]); installed = true; return undefined; },
      version: "3.31.0",
    });
    assert.ok(found);
    assert.deepEqual(installs, [["autopilot-ai@3.31.0", "/home/me/.directionallylocal/autopilot"]]);
    assert.match(io.text(), /Downloading Autopilot 3\.31\.0[\s\S]*✓ Autopilot 3\.31\.0 is ready/);
  });

  it("says what failed and how to retry", async () => {
    const io = capture();
    assert.equal(await ensureAutopilot(io, { env: {}, find: async () => undefined, install: async () => "npm exited with 1", version: "3.31.0" }), undefined);
    assert.match(io.text(), /✗ Couldn't download Autopilot: npm exited with 1\n {4}Try again with dl autopilot\./);
  });

  it("installs a test build when DL_AUTOPILOT_SPEC names one; lives beside dl in its home", () => {
    assert.equal(autopilotSpec({ DL_AUTOPILOT_SPEC: "/tmp/ap.tgz" }, "3.31.0"), "/tmp/ap.tgz");
    assert.equal(autopilotSpec({}, "3.31.0"), "autopilot-ai@3.31.0");
    assert.equal(autopilotHome({ DL_HOME: "/x" }), "/x/autopilot");
    assert.equal(autopilotHome({ HOME: "/home/me" }, "/home/me/.directionallylocal/dl/lib/node_modules/directionallylocal"), "/home/me/.directionallylocal/autopilot");
  });
});
