import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Prompter } from "../prompt.js";
import { PlainUi } from "../ui.js";
import { updateCommand } from "../install-method.js";
import { saveRemote, type RemoteServer } from "./config.js";
import type { SshExec } from "./ssh.js";
import {
  behindNotice,
  compareVersions,
  outdatedServers,
  pinnedVersions,
  placeVersions,
  serverVersions,
  update,
  type UpdateIO,
} from "./update.js";
import { dlVersion, pinnedAutopilotVersion, pinnedHotcellVersion } from "../versions.js";

/** The update hint for how this dl is installed. */
const UPDATE = updateCommand().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const roots: string[] = [];
const previous = process.env.AUTOPILOT_REMOTES_FILE;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "dl-update-"));
  roots.push(root);
  process.env.AUTOPILOT_REMOTES_FILE = join(root, "remotes.json");
});

afterEach(async () => {
  if (previous === undefined) delete process.env.AUTOPILOT_REMOTES_FILE;
  else process.env.AUTOPILOT_REMOTES_FILE = previous;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const STATE = JSON.stringify({ version: 1, autopilotVersion: "2.7.0", hotcellVersion: "1.4.0" });

function fakeSsh(options: { state?: string; upCode?: number; upLines?: string[]; dl?: string } = {}) {
  const commands: string[] = [];
  const exec: SshExec = async (_access, command, opts) => {
    commands.push(command);
    if (command.includes("dl --version")) return options.dl ? { code: 0, stdout: `${options.dl}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
    if (command.includes("id -u")) return { code: 0, stdout: "0\nroot\nubuntu 24.04\nx86_64\nroot\nbox\n", stderr: "" };
    if (command.includes("dl-install.sh")) {
      for (const line of [".. Installing dl", "ok Installing dl: 0.9.0"]) opts?.onStdoutLine?.(line);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command.startsWith("cat /etc/directionallylocal/state.json")) {
      return { code: 0, stdout: options.state ?? STATE, stderr: "" };
    }
    if (command.includes("dl up")) {
      for (const line of options.upLines ?? []) opts?.onStdoutLine?.(line);
      return { code: options.upCode ?? 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected: ${command}` };
  };
  return { exec, commands };
}

function capture(): UpdateIO & { text: () => string } {
  let text = "";
  return { out: (chunk) => { text += chunk; }, err: (chunk) => { text += chunk; }, color: false, text: () => text };
}

function prompter(answer: string): Prompter {
  return {
    choose: async () => answer,
    select: async () => ({ value: answer }),
    secret: async () => answer,
    text: async () => answer,
  } as unknown as Prompter;
}

function server(name: string, ssh = true): RemoteServer {
  return {
    name,
    url: "http://127.0.0.1:4096",
    token: "t",
    credentialId: "c",
    expiresAt: "2027-01-01T00:00:00.000Z",
    addedAt: "2026-10-28T00:00:00.000Z",
    ...(ssh ? { ssh: { target: "root@203.0.113.10" } } : {}),
  };
}

function deps(overrides: Partial<Parameters<typeof update>[1]> = {}) {
  const io = capture();
  return {
    io,
    deps: {
      ssh: fakeSsh().exec,
      prompter: prompter("n"),
      newUi: () => new PlainUi(io.out),
      io,
      interactive: false,
      sleep: async () => {},
      latestDl: async () => undefined,
      registry: { has: async () => true, latest: async () => undefined },
      ...overrides,
    } as Parameters<typeof update>[1],
  };
}

describe("versions", () => {
  it("compares dotted versions numerically", () => {
    assert.equal(compareVersions("2.7.0", "2.7.2"), -1);
    assert.equal(compareVersions("2.7.2", "2.7.0"), 1);
    assert.equal(compareVersions("2.7.0", "2.7.0"), 0);
    assert.equal(compareVersions("2.10.0", "2.9.9"), 1, "not lexicographic");
    assert.equal(compareVersions("v2.7.0", "2.7.0"), 0);
    assert.equal(compareVersions("2.7.0-beta.1", "2.7.0"), 0, "a pre-release suffix is ignored");
  });

  it("says what is behind, and nothing when nothing is", () => {
    assert.equal(behindNotice({ autopilot: "2.7.0", hotcell: "1.4.0" }, { autopilot: "2.7.2", hotcell: "1.4.0" }), "Autopilot 2.7.0 → 2.7.2");
    assert.equal(behindNotice({ autopilot: "2.7.0", hotcell: "1.4.0" }, { autopilot: "2.7.2", hotcell: "1.4.1" }), "Autopilot 2.7.0 → 2.7.2 · Hotcell 1.4.0 → 1.4.1");
    assert.equal(behindNotice({ autopilot: "2.7.2", hotcell: "1.4.1" }, { autopilot: "2.7.2", hotcell: "1.4.1" }), undefined);
    assert.equal(behindNotice({ autopilot: "2.8.0", hotcell: "1.4.1" }, { autopilot: "2.7.2", hotcell: "1.4.1" }), undefined, "a newer server is not behind");
  });

  it("reads the server's versions from its state file", async () => {
    const { exec } = fakeSsh();
    assert.deepEqual(await serverVersions({ target: "root@box" }, exec), { autopilot: "2.7.0", hotcell: "1.4.0" });
    const missing = fakeSsh({ state: "not json" });
    assert.equal(await serverVersions({ target: "root@box" }, missing.exec), undefined);
  });

  it("compares a place against the pins, not npm's latest", () => {
    assert.deepEqual(pinnedVersions(), { autopilot: pinnedAutopilotVersion(), hotcell: pinnedHotcellVersion() });
    assert.equal(behindNotice({ autopilot: pinnedAutopilotVersion(), hotcell: "0.1.30" }, pinnedVersions()), `Hotcell 0.1.30 → ${pinnedHotcellVersion()}`);
  });

  it("lists the servers that are behind", async () => {
    const { exec } = fakeSsh();
    const outdated = await outdatedServers([server("box"), server("laptop", false)], {
      ssh: exec,
      latest: async () => ({ autopilot: "2.7.2", hotcell: "1.4.0" }),
    });
    assert.deepEqual(outdated, [{ name: "box", notice: "Autopilot 2.7.0 → 2.7.2" }]);
  });
});

describe("dl update", () => {
  it("updates a server over SSH without asking, and keeps its access mode", async () => {
    await saveRemote(server("box"));
    const ssh = fakeSsh({ upLines: [JSON.stringify({ event: "plan", steps: [{ id: "software", label: "Installing Hotcell + Autopilot" }] }), JSON.stringify({ event: "done", id: "software", detail: "Autopilot 2.7.2 · Hotcell 1.4.0" })] });
    const { io, deps: base } = deps({ ssh: ssh.exec, running: async () => 0 });
    assert.equal(await update([], base), 0);
    assert.match(io.text(), /Updating box {2}\(Autopilot 2\.7\.0 · Hotcell 1\.4\.0\)/);
    assert.match(io.text(), /✓ box is up to date/);
    const up = ssh.commands.find((command) => command.includes("dl up"));
    assert.equal(up, "dl up --answers-stdin --events json", "no --access: the server keeps the way it is reached");
    const bootstrap = ssh.commands.findIndex((command) => command.includes("dl-install.sh"));
    assert.ok(bootstrap >= 0 && bootstrap < ssh.commands.indexOf(up!), "the server's dl first: it pins the Autopilot it installs");
    assert.match(ssh.commands[bootstrap]!, new RegExp(`DL_VERSION=${dlVersion().replace(/\./g, "\\.")} sh`), "the laptop's own dl version, so both ends match");
    assert.match(io.text(), /ok Installing dl: 0\.9\.0/);
  });

  it("never downgrades a server's dl: newer is left alone, the same isn't reinstalled, older is upgraded", async () => {
    await saveRemote(server("box"));
    const here = dlVersion();
    const [major, minor, patch] = here.split(/[.-]/).map(Number) as [number, number, number];

    // Newer than this laptop: nothing installed, nothing run, and the command that updates this laptop.
    const newer = fakeSsh({ dl: `${major}.${minor}.${patch + 1}` });
    const ahead = deps({ ssh: newer.exec, running: async () => 0 });
    assert.equal(await update([], ahead.deps), 0);
    assert.ok(!newer.commands.some((command) => command.includes("dl-install.sh")), "no older dl installed over a newer one");
    assert.ok(!newer.commands.some((command) => command.includes("dl up")), "the server is left as it is");
    assert.match(ahead.io.text(), new RegExp(`! box runs dl ${major}\\.${minor}\\.${patch + 1}, newer than this laptop's ${here.replace(/\./g, "\\.")}\\. Update this laptop: ${UPDATE}\n`));
    assert.match(ahead.io.text(), /Left box as it is\./);

    // A pre-release of the next version is newer too (semver, not just the numbers).
    const rc = fakeSsh({ dl: `${major}.${minor + 1}.0-rc.1` });
    assert.equal(await update([], deps({ ssh: rc.exec, running: async () => 0 }).deps), 0);
    assert.ok(!rc.commands.some((command) => command.includes("dl-install.sh")));

    // The same: dl isn't reinstalled, but dl up still brings Autopilot and Hotcell to its pins.
    const same = fakeSsh({ dl: here });
    const level = deps({ ssh: same.exec, running: async () => 0 });
    assert.equal(await update([], level.deps), 0);
    assert.ok(!same.commands.some((command) => command.includes("dl-install.sh")));
    assert.ok(same.commands.includes("dl up --answers-stdin --events json"));
    assert.doesNotMatch(level.io.text(), /newer than this laptop/);

    // Older: upgraded to this laptop's version, as before.
    const older = fakeSsh({ dl: "0.0.1" });
    assert.equal(await update([], deps({ ssh: older.exec, running: async () => 0 }).deps), 0);
    assert.ok(older.commands.some((command) => command.includes(`DL_VERSION=${here} sh`)));
    assert.ok(older.commands.some((command) => command.includes("dl up")));
  });

  it("with an unpublished dl here, keeps the server's own dl and still updates the rest", async () => {
    await saveRemote(server("box"));
    const ssh = fakeSsh({ dl: "0.0.1" });
    const { io, deps: base } = deps({ ssh: ssh.exec, running: async () => 0, registry: { has: async () => false, latest: async () => "0.0.2" } });
    assert.equal(await update([], base), 0);
    assert.ok(!ssh.commands.some((command) => command.includes("dl-install.sh")));
    assert.match(io.text(), new RegExp(`! This laptop's dl ${dlVersion().replace(/\./g, "\\.")} isn't on npm \\(a development build\\?\\), so box keeps its dl 0\\.0\\.1\\.`));
    assert.ok(ssh.commands.includes("dl up --answers-stdin --events json"));
  });

  it("updates this computer by running its setup again, and says when the laptop's own dl is behind", async () => {
    await saveRemote(server("this-computer", false));
    let ran = 0;
    const { io, deps: base } = deps({
      running: async () => 0,
      local: async () => { ran++; return { autopilot: pinnedAutopilotVersion(), hotcell: "0.1.30" }; },
      latestDl: async () => "99.0.0",
    });
    assert.equal(await update(["this-computer"], base), 0);
    assert.equal(ran, 1);
    assert.match(io.text(), /Updating this-computer[\s\S]*✓ this-computer is up to date {2}Autopilot \d+\.\d+\.\d+ · Hotcell 0\.1\.30/);
    assert.match(io.text(), new RegExp(`dl 99\\.0\\.0 is out \\(this is \\d+\\.\\d+\\.\\d+\\): ${UPDATE}`));

    // A place left on another Autopilot than the one this dl bundles: say so, with the one command that fixes it.
    const drift = deps({ running: async () => 0, local: async () => ({ autopilot: "2.7.0", hotcell: "0.1.30" }) });
    assert.equal(await update(["this-computer"], drift.deps), 0);
    assert.match(drift.io.text(), new RegExp(`! this-computer runs Autopilot 2\\.7\\.0; this laptop's dl bundles \\d+\\.\\d+\\.\\d+\\. Match them: ${UPDATE}`));
  });

  it("knows each place's Autopilot and Hotcell versions, for dl status", async () => {
    const remotes = [server("box"), server("this-computer", false), { ...server("acme", false), url: "https://acme.example.com" }];
    const versions = await placeVersions(remotes, { ssh: fakeSsh().exec, local: async () => ({ autopilot: "3.0.1", hotcell: "0.1.30" }) });
    assert.deepEqual([...versions], [["box", { autopilot: "2.7.0", hotcell: "1.4.0" }], ["this-computer", { autopilot: "3.0.1", hotcell: "0.1.30" }]], "a server connected with dl connect can't be asked");
  });

  it("waits for running tasks when nobody can answer", async () => {
    await saveRemote(server("box"));
    const ssh = fakeSsh();
    let calls = 0;
    const { io, deps: base } = deps({ ssh: ssh.exec, interactive: false, running: async () => (++calls === 1 ? 2 : 0) });
    assert.equal(await update([], base), 0);
    assert.match(io.text(), /2 tasks running on box; waiting for them to finish/);
    assert.ok(ssh.commands.some((command) => command.includes("dl up")));
  });

  it("waits with --wait even on a terminal", async () => {
    await saveRemote(server("box"));
    const ssh = fakeSsh();
    let calls = 0;
    const { io, deps: base } = deps({ ssh: ssh.exec, interactive: true, wait: true, running: async () => (++calls === 1 ? 1 : 0) });
    assert.equal(await update([], base), 0);
    assert.match(io.text(), /1 task running on box; waiting for it to finish/);
  });

  it("asks before interrupting, and stops when the answer is no", async () => {
    await saveRemote(server("box"));
    const ssh = fakeSsh();
    const asked: string[] = [];
    const asking = prompter("n");
    asking.text = async (question: string) => { asked.push(question); return "n"; };
    const { io, deps: base } = deps({ ssh: ssh.exec, interactive: true, prompter: asking, running: async () => 3 });
    assert.equal(await update([], base), 1);
    assert.match(asked[0]!, /3 tasks running on box\. Update now and interrupt them\? \[y\/N\]/);
    assert.match(io.text(), /Not updating\. Wait for them, then run dl update box/);
    assert.equal(ssh.commands.some((command) => command.includes("dl up")), false);
  });

  it("goes ahead when the answer is yes", async () => {
    await saveRemote(server("box"));
    const ssh = fakeSsh();
    const { deps: base } = deps({ ssh: ssh.exec, interactive: true, prompter: prompter("y"), running: async () => 1 });
    assert.equal(await update([], base), 0);
    assert.ok(ssh.commands.some((command) => command.includes("dl up")));
  });

  it("refuses a server this laptop didn't set up", async () => {
    await saveRemote(server("box", false));
    const { io, deps: base } = deps();
    assert.equal(await update([], base), 1);
    assert.match(io.text(), /box wasn't set up by this laptop, so it can't update it\.\n {2}On the server: sudo dl up/);
  });

  it("reports a failed update with the server's last lines", async () => {
    await saveRemote(server("box"));
    const ssh = fakeSsh({ upCode: 1, upLines: [JSON.stringify({ event: "error", message: "npm install failed" })] });
    const { io, deps: base } = deps({ ssh: ssh.exec, running: async () => 0 });
    assert.equal(await update([], base), 1);
    assert.match(io.text(), /✗ Updating box failed: npm install failed/);
  });
});
