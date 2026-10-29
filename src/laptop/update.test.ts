import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Prompter } from "../prompt.js";
import { PlainUi } from "../ui.js";
import { saveRemote, type RemoteServer } from "./config.js";
import type { SshExec } from "./ssh.js";
import {
  behindNotice,
  compareVersions,
  latestVersions,
  outdatedServers,
  serverVersions,
  update,
  type UpdateIO,
} from "./update.js";

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

function fakeSsh(options: { state?: string; upCode?: number; upLines?: string[] } = {}) {
  const commands: string[] = [];
  const exec: SshExec = async (_access, command, opts) => {
    commands.push(command);
    if (command.includes("id -u")) return { code: 0, stdout: "0\nroot\nubuntu 24.04\nx86_64\nroot\nbox\n", stderr: "" };
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

  it("looks up npm at most once a day, and keeps the last answer when offline", async () => {
    const cacheFile = join(roots[0]!, "versions.json");
    let calls = 0;
    const npm = async (pkg: string) => { calls++; return pkg === "autopilot-ai" ? "2.7.2" : "1.4.1"; };
    const day = 24 * 60 * 60 * 1000;

    const first = await latestVersions({ cacheFile, npm, now: () => 1_000 });
    assert.deepEqual(first, { autopilot: "2.7.2", hotcell: "1.4.1", checkedAt: 1_000 });
    assert.equal(calls, 2);
    assert.match(await readFile(cacheFile, "utf8"), /2\.7\.2/);

    const cached = await latestVersions({ cacheFile, npm, now: () => 1_000 + day - 1 });
    assert.equal(cached?.autopilot, "2.7.2");
    assert.equal(calls, 2, "no second lookup within a day");

    await latestVersions({ cacheFile, npm, now: () => 1_000 + day });
    assert.equal(calls, 4, "a new lookup after a day");

    const offline = await latestVersions({ cacheFile, npm: async () => undefined, now: () => 1_000 + 3 * day });
    assert.equal(offline?.autopilot, "2.7.2", "offline keeps the last answer");
  });

  it("lists the servers that are behind", async () => {
    const { exec } = fakeSsh();
    const outdated = await outdatedServers([server("box"), server("laptop", false)], {
      ssh: exec,
      latest: async () => ({ autopilot: "2.7.2", hotcell: "1.4.0", checkedAt: 0 }),
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

  it("refuses a server this laptop didn't set up over SSH", async () => {
    await saveRemote(server("box", false));
    const { io, deps: base } = deps();
    assert.equal(await update([], base), 1);
    assert.match(io.text(), /box wasn't set up over SSH, so this laptop can't update it\.\n {2}On the server: sudo dl up/);
  });

  it("reports a failed update with the server's last lines", async () => {
    await saveRemote(server("box"));
    const ssh = fakeSsh({ upCode: 1, upLines: [JSON.stringify({ event: "error", message: "npm install failed" })] });
    const { io, deps: base } = deps({ ssh: ssh.exec, running: async () => 0 });
    assert.equal(await update([], base), 1);
    assert.match(io.text(), /✗ Updating box failed: npm install failed/);
  });
});
