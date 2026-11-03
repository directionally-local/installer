import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compareSemver, installedVersion, packageSpecs, pinnedAutopilotVersion, pinnedHotcellVersion, versionAgainstPin } from "./versions.js";

describe("one Autopilot and one Hotcell version", () => {
  it("pins autopilot-ai and hotcell exactly in package.json, and those pins are what places install", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
    assert.match(manifest.dependencies["autopilot-ai"]!, /^\d+\.\d+\.\d+$/, "an exact version, no ^ or ~");
    assert.match(manifest.dependencies["hotcell"]!, /^\d+\.\d+\.\d+$/, "an exact version, no ^ or ~");
    assert.equal(pinnedAutopilotVersion(), manifest.dependencies["autopilot-ai"]);
    assert.equal(pinnedHotcellVersion(), manifest.dependencies["hotcell"]);
    const installed = JSON.parse(readFileSync(new URL("../node_modules/autopilot-ai/package.json", import.meta.url), "utf8")) as { version: string };
    assert.equal(installed.version, pinnedAutopilotVersion(), "the bundled session client is that version");
    assert.throws(() => pinnedAutopilotVersion({ "autopilot-ai": "^3.0.2" }), /exact version/);
    assert.throws(() => pinnedAutopilotVersion({}), /exact version/);
    assert.throws(() => pinnedHotcellVersion({ hotcell: "~0.1.38" }), /exact version/);
    assert.throws(() => pinnedHotcellVersion({}), /exact version/);
  });

  it("installs autopilot-ai@<pin> and hotcell@<pin> unless DL_AUTOPILOT_SPEC / DL_HOTCELL_SPEC name a build to test", () => {
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

  it("shows a place's version next to the pin", () => {
    assert.equal(versionAgainstPin("0.1.38", "0.1.38"), "0.1.38");
    assert.equal(versionAgainstPin("0.1.30", "0.1.38"), "0.1.30 → 0.1.38");
  });
});

describe("semver order", () => {
  it("orders versions as semver does", () => {
    const ordered = ["0.9.9", "0.10.0-alpha", "0.10.0-alpha.1", "0.10.0-alpha.beta", "0.10.0-beta.2", "0.10.0-beta.11", "0.10.0-rc.1", "0.10.0", "0.10.1", "0.10.10", "1.0.0"];
    for (let i = 0; i < ordered.length; i++) {
      for (let j = 0; j < ordered.length; j++) {
        assert.equal(compareSemver(ordered[i]!, ordered[j]!), Math.sign(i - j), `${ordered[i]} vs ${ordered[j]}`);
      }
    }
    assert.equal(compareSemver("v0.10.1", "0.10.1"), 0);
    assert.equal(compareSemver("0.10.1+build.7", "0.10.1"), 0, "build metadata is ignored");
    assert.throws(() => compareSemver("0.10", "0.10.0"), /Not a version/);
    assert.throws(() => compareSemver("latest", "0.10.0"), /Not a version/);
  });
});
