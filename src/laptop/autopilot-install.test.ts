import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { autopilotHome } from "./autopilot.js";
import { autopilotSpec, ensureAutopilot } from "./autopilot-install.js";
import { compareSemver, pinnedAutopilotVersion } from "../versions.js";

function capture() {
  let text = "";
  return { out: (t: string) => { text += t; }, err: (t: string) => { text += t; }, text: () => text };
}

describe("Autopilot, downloaded when it's picked", () => {
  it("uses an installed Autopilot as it is, downloading nothing", async () => {
    const io = capture();
    const installs: string[] = [];
    const found = await ensureAutopilot(io, { find: async () => ({ command: "node", args: ["/ap.mjs"] }), install: async (spec) => void installs.push(spec), version: "3.32.0" });
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
      version: "3.32.0",
    });
    assert.ok(found);
    assert.deepEqual(installs, [["autopilot-ai@3.32.0", "/home/me/.directionallylocal/autopilot"]]);
    assert.match(io.text(), /Downloading Autopilot 3\.32\.0[\s\S]*✓ Autopilot 3\.32\.0 is ready/);
  });

  it("downloads the one pinned version (package.json's autopilot-ai, 3.32.0 or newer) when none is given", async () => {
    const pin = pinnedAutopilotVersion();
    assert.ok(compareSemver(pin, "3.32.0") >= 0, `the pin ${pin} is 3.32.0 or newer`);
    const installs: string[] = [];
    let installed = false;
    await ensureAutopilot(capture(), {
      env: { DL_HOME: "/x" },
      find: async () => installed ? { command: "node", args: ["/x/ap.mjs"] } : undefined,
      install: async (spec) => { installs.push(spec); installed = true; return undefined; },
    });
    assert.deepEqual(installs, [`autopilot-ai@${pin}`]);
  });

  it("reads the pin from package.json's devDependencies, the same field the bump workflow updates", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
    assert.equal(pinnedAutopilotVersion(), pkg.devDependencies?.["autopilot-ai"]);
    assert.equal(pkg.dependencies?.["autopilot-ai"], undefined, "one pin, in devDependencies");
    // bump-autopilot.yml compares npm's latest with this pin. It once read `.dependencies`, found
    // nothing, and never opened a bump PR, so the lazy-download pin sat behind npm.
    const workflow = readFileSync(new URL("../../.github/workflows/bump-autopilot.yml", import.meta.url), "utf8");
    assert.match(workflow, /require\('\.\/package\.json'\)\.devDependencies\['autopilot-ai'\]/);
    assert.doesNotMatch(workflow, /require\('\.\/package\.json'\)\.dependencies\['autopilot-ai'\]/);
  });

  it("says what failed and how to retry", async () => {
    const io = capture();
    assert.equal(await ensureAutopilot(io, { env: {}, find: async () => undefined, install: async () => "npm exited with 1", version: "3.32.0" }), undefined);
    assert.match(io.text(), /✗ Couldn't download Autopilot: npm exited with 1\n {4}Try again with dl autopilot\./);
  });

  it("installs a test build when DL_AUTOPILOT_SPEC names one; lives beside dl in its home", () => {
    assert.equal(autopilotSpec({ DL_AUTOPILOT_SPEC: "/tmp/ap.tgz" }, "3.32.0"), "/tmp/ap.tgz");
    assert.equal(autopilotSpec({}, "3.32.0"), "autopilot-ai@3.32.0");
    assert.equal(autopilotHome({ DL_HOME: "/x" }), "/x/autopilot");
    assert.equal(autopilotHome({ HOME: "/home/me" }, "/home/me/.directionallylocal/dl/lib/node_modules/directionallylocal"), "/home/me/.directionallylocal/autopilot");
  });
});
