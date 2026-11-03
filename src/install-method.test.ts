import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { installMethod, NPM_UPDATE, SCRIPT_UPDATE, SERVER_UPDATE, updateCommand, type InstallFacts } from "./install-method.js";

const WRAPPER = "#!/bin/sh\n# Written by the Directionally Local install script.\nexec \"/usr/bin/node\" \"…\" \"$@\"\n";

function facts(overrides: Partial<InstallFacts> = {}, files: Record<string, string> = {}): InstallFacts {
  return {
    packageRoot: "/opt/homebrew/lib/node_modules/directionallylocal",
    env: {},
    home: "/Users/sina",
    platform: "darwin",
    uid: 501,
    readFile: (path) => files[path],
    ...overrides,
  };
}

describe("how dl was installed", () => {
  it("knows the install script's ~/.directionallylocal, or DL_HOME", () => {
    assert.equal(installMethod(facts({ packageRoot: "/Users/sina/.directionallylocal/dl/lib/node_modules/directionallylocal" })), "script");
    assert.equal(installMethod(facts({ packageRoot: "/home/me/.directionallylocal/dl/lib/node_modules/directionallylocal", home: "/home/me", platform: "linux", uid: 1000 })), "script");
    assert.equal(installMethod(facts({ packageRoot: "/data/dl/dl/lib/node_modules/directionallylocal", env: { DL_HOME: "/data/dl" } })), "script");
  });

  it("knows a custom DL_HOME after the fact by the wrapper the script wrote", () => {
    const root = "/data/dl/dl/lib/node_modules/directionallylocal";
    assert.equal(installMethod(facts({ packageRoot: root }, { "/data/dl/bin/dl": WRAPPER })), "script");
    assert.equal(installMethod(facts({ packageRoot: root }, { "/data/dl/bin/dl": "#!/bin/sh\nexec something-else\n" })), "npm", "not a wrapper of ours");
  });

  it("knows a server: Linux as root, or a machine dl up set up", () => {
    assert.equal(installMethod(facts({ packageRoot: "/usr/lib/node_modules/directionallylocal", platform: "linux", uid: 0, home: "/root" })), "server");
    assert.equal(installMethod(facts({ packageRoot: "/usr/lib/node_modules/directionallylocal", platform: "linux", uid: 1000 }, { "/etc/directionallylocal/state.json": "{}" })), "server");
  });

  it("otherwise, a global npm install", () => {
    assert.equal(installMethod(facts()), "npm");
    assert.equal(installMethod(facts({ platform: "linux", uid: 1000, home: "/home/me", packageRoot: "/home/me/.npm-global/lib/node_modules/directionallylocal" })), "npm");
    assert.equal(installMethod(facts({ platform: "darwin", uid: 0 })), "npm", "root on a Mac is no server");
  });

  it("names the command that updates each", () => {
    assert.equal(updateCommand("script"), SCRIPT_UPDATE);
    assert.equal(updateCommand("server"), SERVER_UPDATE);
    assert.equal(updateCommand("npm"), NPM_UPDATE);
    assert.equal(SCRIPT_UPDATE, "curl -fsSL https://directionallylocal.run | sh");
    assert.equal(SERVER_UPDATE, "curl -fsSL https://directionallylocal.run | sudo sh");
    assert.equal(NPM_UPDATE, "npm install -g directionallylocal");
  });
});
