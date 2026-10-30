import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { installedVersion, packageSpecs, pinnedAutopilotVersion } from "./versions.js";

describe("one Autopilot version", () => {
  it("pins autopilot-ai exactly in package.json, and that pin is what places install", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
    assert.match(manifest.dependencies["autopilot-ai"]!, /^\d+\.\d+\.\d+$/, "an exact version, no ^ or ~");
    assert.equal(pinnedAutopilotVersion(), manifest.dependencies["autopilot-ai"]);
    const installed = JSON.parse(readFileSync(new URL("../node_modules/autopilot-ai/package.json", import.meta.url), "utf8")) as { version: string };
    assert.equal(installed.version, pinnedAutopilotVersion(), "the bundled session client is that version");
    assert.throws(() => pinnedAutopilotVersion({ "autopilot-ai": "^3.0.2" }), /exact version/);
    assert.throws(() => pinnedAutopilotVersion({}), /exact version/);
  });

  it("installs autopilot-ai@<pin> and hotcell@<version> unless DL_AUTOPILOT_SPEC / DL_HOTCELL_SPEC name a build to test", () => {
    assert.deepEqual(packageSpecs({ autopilot: "3.0.2", hotcell: "0.1.30" }, {}), {
      autopilot: "autopilot-ai@3.0.2", hotcell: "hotcell@0.1.30", autopilotLabel: "3.0.2", hotcellLabel: "0.1.30", dev: false,
    });
    assert.deepEqual(packageSpecs({ autopilot: "3.0.2", hotcell: "0.1.30" }, { DL_AUTOPILOT_SPEC: "/tmp/autopilot-ai-3.1.0.tgz" }), {
      autopilot: "/tmp/autopilot-ai-3.1.0.tgz", hotcell: "hotcell@0.1.30", autopilotLabel: "dev", hotcellLabel: "0.1.30", dev: true,
    });
    assert.deepEqual(packageSpecs({ autopilot: "3.0.2", hotcell: "0.1.30" }, { DL_HOTCELL_SPEC: "hotcell@next", DL_AUTOPILOT_SPEC: " " }).hotcell, "hotcell@next");
    assert.equal(packageSpecs({ autopilot: "3.0.2", hotcell: "0.1.30" }, { DL_AUTOPILOT_SPEC: " " }).dev, false, "blank means unset");
    assert.equal(installedVersion('{"name":"autopilot-ai","version":"3.1.0-dev.4"}', "dev"), "3.1.0-dev.4");
    assert.equal(installedVersion("{}", "dev"), "dev");
    assert.equal(installedVersion(undefined, "dev"), "dev");
  });
});
