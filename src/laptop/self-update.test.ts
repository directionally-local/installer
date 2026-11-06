import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NPM_UPDATE, SCRIPT_UPDATE, SERVER_UPDATE, updateCommand } from "../install-method.js";
import { dlUpdate, DL_UPDATE, installerFor, latestDlVersion, scriptHome, type DlUpdateDeps, type InstallerRun } from "./self-update.js";

const ROOT = "/home/ada/.directionallylocal/dl/lib/node_modules/directionallylocal";
const SCRIPT = "#!/bin/sh\necho fake install script\n";

function capture() {
  let out = "";
  let err = "";
  return { out: (text: string) => { out += text; }, err: (text: string) => { err += text; }, color: false, text: () => out + err, stdout: () => out, stderr: () => err };
}

/** A dl update with nothing real behind it: no npm, no network, no installer. */
function harness(overrides: Partial<DlUpdateDeps> & { lines?: string[]; code?: number; bundledAfter?: string } = {}) {
  const io = capture();
  const runs: Array<InstallerRun & { input?: string }> = [];
  const reruns: string[][] = [];
  const places: string[][] = [];
  let bundled: string | undefined = overrides.bundledAutopilot ? overrides.bundledAutopilot() : "3.10.1";
  const deps: DlUpdateDeps = {
    io,
    selfDone: false,
    current: "0.16.0",
    command: SCRIPT_UPDATE,
    uid: 501,
    packageRoot: ROOT,
    latest: async () => "0.16.0",
    fetchScript: async () => SCRIPT,
    runInstaller: async (run, line) => {
      runs.push(run);
      for (const text of overrides.lines ?? ["Directionally Local", "  ✓ Installed dl"]) line(text);
      if ((overrides.code ?? 0) === 0 && "bundledAfter" in overrides) bundled = overrides.bundledAfter;
      return overrides.code ?? 0;
    },
    rerun: async (args) => { reruns.push(args); return 0; },
    pinnedAutopilot: () => "3.10.1",
    installedPins: () => ({ version: "0.17.0", autopilot: "3.11.0" }),
    defaultPlace: async () => ({ kind: "none" }),
    updatePlace: async (args) => { places.push(args); return 0; },
    ...overrides,
    bundledAutopilot: () => bundled,
  };
  return { io, deps, runs, reruns, places };
}

function response(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

describe("npm's latest dl", () => {
  it("reads the version from the registry", async () => {
    let asked = "";
    const version = await latestDlVersion((async (url: string) => { asked = url; return response(200, { version: "0.17.0" }); }) as typeof fetch);
    assert.equal(version, "0.17.0");
    assert.equal(asked, "https://registry.npmjs.org/directionallylocal/latest");
  });

  it("says what went wrong with the registry", async () => {
    await assert.rejects(() => latestDlVersion((async () => response(503, "down")) as typeof fetch), /npm answered 503/);
    await assert.rejects(() => latestDlVersion((async () => response(200, "<html>")) as typeof fetch), /wasn't JSON/);
    await assert.rejects(() => latestDlVersion((async () => response(200, { version: "latest" })) as typeof fetch), /no version/);
    await assert.rejects(() => latestDlVersion((async () => { throw new TypeError("fetch failed"); }) as typeof fetch), /couldn't reach npm \(fetch failed\)/);
  });

  it("gives up after the timeout", async () => {
    const hang = ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as typeof fetch;
    // AbortSignal.timeout's timer doesn't keep the process alive on its own; this one does.
    const alive = setTimeout(() => {}, 5_000);
    try {
      await assert.rejects(() => latestDlVersion(hang, 20), /npm didn't answer in 0 s/);
    } finally {
      clearTimeout(alive);
    }
  });
});

describe("the installer dl update runs", () => {
  it("is the install script as yourself, into this dl's own home, without starting dl", () => {
    const run = installerFor(SCRIPT_UPDATE, "0.17.0", { uid: 501, packageRoot: ROOT });
    assert.equal(run.command, "sh");
    assert.deepEqual(run.args, ["-s"]);
    assert.equal(run.script, true);
    assert.equal(run.url, "https://dl.new/install.sh");
    assert.deepEqual(run.env, { DL_MODE: "laptop", DL_VERSION: "0.17.0", DL_NO_START: "1", DL_NO_MODIFY_PATH: "1", DL_HOME: "/home/ada/.directionallylocal" });
  });

  it("is the install script as root on a server, through sudo when needed", () => {
    const viaSudo = installerFor(SERVER_UPDATE, "0.17.0", { uid: 1000, packageRoot: "/usr/lib/node_modules/directionallylocal" });
    assert.equal(viaSudo.command, "sudo");
    assert.deepEqual(viaSudo.args, ["env", "DL_VERSION=0.17.0", "sh", "-s"], "sudo drops the environment, so it's on the command line");
    assert.equal(viaSudo.script, true);
    const asRoot = installerFor(SERVER_UPDATE, "0.17.0", { uid: 0, packageRoot: "/usr/lib/node_modules/directionallylocal" });
    assert.equal(asRoot.command, "sh");
    assert.deepEqual(asRoot.env, { DL_VERSION: "0.17.0" });
    assert.equal((asRoot.env as Record<string, string>).DL_NO_START, undefined, "a server's script runs dl up, which installs its pinned Autopilot");
  });

  it("is npm at that exact version for an npm install", () => {
    const run = installerFor(NPM_UPDATE, "0.17.0", { uid: 501, packageRoot: "/usr/local/lib/node_modules/directionallylocal" });
    assert.equal(run.command, "npm");
    assert.deepEqual(run.args, ["install", "-g", "--no-audit", "--no-fund", "directionallylocal@0.17.0"]);
    assert.equal(run.script, false);
  });

  it("follows updateCommand(), whatever it says for this install", () => {
    for (const method of ["script", "server", "npm"] as const) {
      assert.doesNotThrow(() => installerFor(updateCommand(method), "0.17.0", { uid: 501, packageRoot: ROOT }));
    }
    assert.throws(() => installerFor("brew upgrade dl", "0.17.0", { uid: 501, packageRoot: ROOT }), /don't know how to run/);
  });

  it("finds the install script's home from dl's package directory", () => {
    assert.equal(scriptHome(ROOT), "/home/ada/.directionallylocal");
    assert.equal(scriptHome("/opt/dl/dl/lib/node_modules/directionallylocal/"), "/opt/dl");
    assert.equal(scriptHome("/usr/lib/node_modules/directionallylocal"), undefined);
  });
});

describe("dl update", () => {
  it("says dl is up to date, checks the pinned Autopilot, and installs nothing", async () => {
    const { io, deps, runs, reruns } = harness();
    assert.equal(await dlUpdate(deps), 0);
    assert.equal(io.text(), "  dl 0.16.0 is up to date.\n  ✓ Autopilot 3.10.1 is installed (the one dl 0.16.0 pins).\n");
    assert.deepEqual(runs, []);
    assert.deepEqual(reruns, []);
  });

  it("updates dl with the install script, streaming it, then checks the new dl's pinned Autopilot", async () => {
    const { io, deps, runs, reruns } = harness({ latest: async () => "0.17.0", bundledAfter: "3.11.0" });
    assert.equal(await dlUpdate(deps), 0);
    assert.equal(io.text(), "  Updating dl 0.16.0 → 0.17.0\n    Directionally Local\n      ✓ Installed dl\n  ✓ dl 0.17.0 is installed.\n  ✓ Autopilot 3.11.0 is installed (the one dl 0.17.0 pins).\n");
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.input, SCRIPT, "the script goes to sh's stdin");
    assert.equal(runs[0]!.env.DL_VERSION, "0.17.0");
    assert.equal(runs[0]!.env.DL_NO_START, "1");
    assert.deepEqual(reruns, [], "nothing else to update: no need for the new dl");

    const missing = harness({ latest: async () => "0.17.0" });
    assert.equal(await dlUpdate(missing.deps), 1, "the new dl came without its Autopilot");
    assert.match(missing.io.stderr(), /✗ dl 0\.17\.0 pins Autopilot 3\.11\.0, but 3\.10\.1 is installed/);
    assert.equal(missing.runs.length, 1, "not reinstalled in a loop");
  });

  it("with a place to update, hands over to the new dl", async () => {
    const { deps, reruns, places } = harness({ latest: async () => "0.17.0", wait: true, defaultPlace: async () => ({ kind: "place", name: "box", updatable: true }) });
    assert.equal(await dlUpdate(deps), 0);
    assert.deepEqual(reruns, [["--wait"]], "the new dl updates the place with its own pins");
    assert.deepEqual(places, [], "not with this dl's");
  });

  it("updates an npm install with npm", async () => {
    const { deps, runs } = harness({ latest: async () => "0.17.0", bundledAfter: "3.11.0", command: NPM_UPDATE, fetchScript: async () => { throw new Error("no script for npm"); } });
    assert.equal(await dlUpdate(deps), 0);
    assert.deepEqual(runs.map((run) => [run.command, ...run.args]), [["npm", "install", "-g", "--no-audit", "--no-fund", "directionallylocal@0.17.0"]]);
    assert.equal(runs[0]!.input, undefined);
  });

  it("fails with the installer's last lines", async () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    const { io, deps, reruns } = harness({ latest: async () => "0.17.0", lines, code: 1 });
    assert.equal(await dlUpdate(deps), 1);
    assert.match(io.stderr(), /✗ Updating dl to 0\.17\.0 failed \(sh exited with 1\)\. Its last lines:\n {4}line 6\n[\s\S]* {4}line 20\n {2}By hand: curl -fsSL https:\/\/dl\.new\/install\.sh \| DL_VERSION=0\.17\.0 sh\n/);
    assert.doesNotMatch(io.stderr(), /line 5\n/, "only the last lines");
    assert.deepEqual(reruns, []);
  });

  it("fails when the install script can't be fetched", async () => {
    const { io, deps, runs } = harness({ latest: async () => "0.17.0", fetchScript: async () => { throw new Error("https://dl.new/install.sh answered 502"); } });
    assert.equal(await dlUpdate(deps), 1);
    assert.match(io.stderr(), /Couldn't get the install script: https:\/\/dl\.new\/install\.sh answered 502/);
    assert.deepEqual(runs, []);
  });

  it("never downgrades: a dl newer than npm's latest is up to date", async () => {
    const { io, deps, runs } = harness({ current: "0.18.0-rc.1", latest: async () => "0.17.0" });
    assert.equal(await dlUpdate(deps), 0);
    assert.match(io.text(), /dl 0\.18\.0-rc\.1 is up to date/);
    assert.deepEqual(runs, []);
  });

  it("with a registry error, says so, still checks the Autopilot, and exits non-zero", async () => {
    const { io, deps, runs } = harness({ latest: async () => { throw new Error("npm answered 503"); } });
    assert.equal(await dlUpdate(deps), 1);
    assert.match(io.stderr(), /! Couldn't check for a newer dl: npm answered 503\. Checking this one's Autopilot\./);
    assert.match(io.stdout(), /✓ Autopilot 3\.10\.1 is installed/);
    assert.deepEqual(runs, []);
  });

  it("reinstalls this dl when its pinned Autopilot is missing", async () => {
    const { io, deps, runs } = harness({ bundledAutopilot: () => undefined, bundledAfter: "3.10.1" });
    assert.equal(await dlUpdate(deps), 0);
    assert.match(io.text(), /! dl 0\.16\.0 pins Autopilot 3\.10\.1, but it isn't installed\. Reinstalling dl 0\.16\.0\.[\s\S]*✓ Autopilot 3\.10\.1 is installed\./);
    assert.equal(runs[0]!.env.DL_VERSION, "0.16.0", "the same dl again");
  });

  it("goes on to the default place, as dl update always did", async () => {
    const { deps, places } = harness({ defaultPlace: async () => ({ kind: "place", name: "box", updatable: true }) });
    assert.equal(await dlUpdate(deps), 0);
    assert.deepEqual(places, [["box"]]);

    const connected = harness({ defaultPlace: async () => ({ kind: "place", name: "acme", updatable: false }) });
    assert.equal(await dlUpdate(connected.deps), 0, "a server set up by someone else isn't a failure");
    assert.match(connected.io.text(), /acme wasn't set up by this laptop; on that server: sudo dl up/);
    assert.deepEqual(connected.places, []);

    const several = harness({ defaultPlace: async () => ({ kind: "unclear", message: "Several places are set up (a, b). Pick one with --server NAME, or set a default: dl use NAME" }) });
    assert.equal(await dlUpdate(several.deps), 0);
    assert.match(several.io.text(), /set a default: dl use NAME\. To update one: dl update NAME/);
  });

  it("after the update, the new dl checks only the Autopilot and the place", async () => {
    const { io, deps, runs, places } = harness({ selfDone: true, latest: async () => { throw new Error("not asked"); }, defaultPlace: async () => ({ kind: "place", name: "box", updatable: true }) });
    assert.equal(await dlUpdate(deps), 0);
    assert.doesNotMatch(io.text(), /up to date|Couldn't check/);
    assert.deepEqual(runs, []);
    assert.deepEqual(places, [["box"]]);
  });

  describe("--check", () => {
    it("says whether there's a newer dl, and changes nothing", async () => {
      const behind = harness({ check: true, latest: async () => "0.17.0" });
      assert.equal(await dlUpdate(behind.deps), 0);
      assert.equal(behind.io.text(), `  dl 0.17.0 is out (this is 0.16.0). Update: ${DL_UPDATE}\n`);
      assert.deepEqual(behind.runs, []);
      assert.deepEqual(behind.places, []);

      const current = harness({ check: true });
      assert.equal(await dlUpdate(current.deps), 0);
      assert.equal(current.io.text(), "  dl 0.16.0 is up to date.\n");
    });

    it("fails on a registry error", async () => {
      const { io, deps } = harness({ check: true, latest: async () => { throw new Error("npm didn't answer in 5 s"); } });
      assert.equal(await dlUpdate(deps), 1);
      assert.match(io.stderr(), /✗ Couldn't check for a newer dl: npm didn't answer in 5 s\./);
    });
  });

  it("is what every update hint says", () => {
    assert.equal(DL_UPDATE, "dl update");
  });
});
