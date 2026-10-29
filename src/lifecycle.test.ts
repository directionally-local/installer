import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { main, readAnswers } from "./cli.js";
import { agentCapacity, parseDfFreeGb, parseInterfaceIp, parseMemTotalMb, parseOsRelease } from "./detect.js";
import { doctor, formatChecks } from "./doctor.js";
import { PATHS, autopilotUnit, envFile, hotcellUnit, parseEnvFile } from "./layout.js";
import { saveRemote } from "./laptop/config.js";
import { ScriptedPrompter } from "./prompt.js";
import { readState, writeState } from "./state.js";
import { FakeSystem } from "./test-support/fake-system.js";
import { uninstall } from "./uninstall.js";
import { up } from "./up.js";

const fetchOk = (async () => Response.json({ login: "octo" })) as unknown as typeof fetch;

async function installed(): Promise<FakeSystem> {
  const system = new FakeSystem();
  await up(system, {
    prompter: new ScriptedPrompter({
      "Tailscale auth key": "tskey-auth-k1-abc",
      "OpenRouter API key": `sk-or-v1-${"a".repeat(40)}`,
      "GitHub token": `github_pat_${"b".repeat(40)}`,
    }),
    fetchImpl: fetchOk,
    sleep: async () => {},
  });
  return system;
}

describe("doctor", () => {
  it("passes on a healthy install and names a fix for each failure", async () => {
    const system = await installed();
    const healthy = await doctor(system);
    assert.deepEqual(healthy.filter((check) => !check.ok).map((check) => check.name), [], formatChecks(healthy));

    system.enabled.delete("hotcell.service");
    system.hotcellKeys.clear();
    const broken = await doctor(system);
    const failed = broken.filter((check) => !check.ok);
    assert.deepEqual(failed.map((check) => check.name), ["sandboxes", "model key"]);
    // Fixes are dl commands, never Tailscale, systemd, or journalctl.
    assert.match(formatChecks(broken), /✗ sandboxes[\s\S]*fix: dl logs hotcell · then dl up/);
    assert.doesNotMatch(formatChecks(broken), /journalctl|systemctl|tailscale serve/);
  });
});

describe("doctor over SSH access", () => {
  it("skips the Tailscale checks and says how it's reached", async () => {
    const system = await installed();
    const state = (await readState(system))!;
    await writeState(system, { ...state, access: { mode: "ssh", url: "http://127.0.0.1:4096" } });
    const commands = system.commands.length;
    const checks = await doctor(system);
    assert.deepEqual(checks.filter((check) => !check.ok).map((check) => check.name), []);
    assert.ok(!checks.some((check) => check.name === "private access" || check.name === "reachable"));
    assert.match(checks.find((check) => check.name === "installed")!.detail, /, over SSH from your laptop$/);
    assert.equal(system.commands.length, commands, "doctor only probes");
  });
});

describe("uninstall", () => {
  it("removes services and software but keeps data by default", async () => {
    const system = await installed();
    system.containers.push("abc123");
    await uninstall(system);
    assert.deepEqual([...system.enabled], ["docker.service"], "none of ours left enabled; Docker stays");
    for (const unit of ["hotcell.service", "autopilot.service", "directionallylocal-metadata-block.service"]) {
      assert.equal(system.files.has(`${PATHS.units}/${unit}`), false, unit);
    }
    assert.equal(await system.exists(PATHS.root), false);
    assert.ok(system.ran.includes("docker rm -f abc123"));
    assert.ok(system.ran.includes("tailscale serve --https=443 http://127.0.0.1:4096 off"));
    assert.ok(system.files.has(PATHS.githubEnv), "config is kept without --purge");
    assert.ok(system.users.has("autopilot"));
  });

  it("--purge also removes config, data, accounts, and the sandbox image", async () => {
    const system = await installed();
    await uninstall(system, { purge: true });
    for (const path of [PATHS.state, PATHS.githubEnv, PATHS.hotcellEnv, PATHS.asterConfig]) assert.equal(system.files.has(path), false, path);
    assert.ok(system.ran.includes("userdel autopilot") && system.ran.includes("userdel hotcell"));
    assert.ok(system.ran.includes("docker image rm directionallylocal-cell:2.2.0"));
  });
});

describe("host detection", () => {
  it("parses the facts preflight needs", () => {
    assert.deepEqual(parseOsRelease('ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n'), { id: "ubuntu", versionId: "24.04", prettyName: "Ubuntu 24.04.1 LTS" });
    assert.equal(parseMemTotalMb("MemTotal:       16303972 kB\nMemFree: 1 kB\n"), 15922);
    assert.equal(parseDfFreeGb("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 83886080 4194304 73400320 6% /\n"), 70);
    assert.equal(parseInterfaceIp("4: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0"), "172.17.0.1");
    assert.equal(parseInterfaceIp(""), undefined);
  });

  it("estimates capacity from memory and CPUs", () => {
    assert.equal(agentCapacity({ memoryMb: 4096, cpus: 2 }, 1024), 2);
    assert.equal(agentCapacity({ memoryMb: 65536, cpus: 16 }, 1024), 32);
    assert.equal(agentCapacity({ memoryMb: 65536, cpus: 4 }, 1024), 8, "CPU-bound");
    assert.equal(agentCapacity({ memoryMb: 2048, cpus: 1 }, 1024), 1, "always at least one");
  });
});

describe("rendered files", () => {
  it("round-trips env files and refuses values that could inject lines", () => {
    const text = envFile("test", { A: "1", B_C: "x=y" });
    assert.deepEqual(parseEnvFile(text), { A: "1", B_C: "x=y" });
    assert.throws(() => envFile("test", { A: "1\nEVIL=1" }), /invalid env entry/);
    assert.throws(() => envFile("test", { "a-b": "1" }), /invalid env entry/);
  });

  it("runs both services as unprivileged users with a read-only system", () => {
    for (const unit of [hotcellUnit(), autopilotUnit()]) {
      assert.match(unit, /^User=(hotcell|autopilot)$/m);
      assert.match(unit, /^ProtectSystem=strict$/m);
      assert.match(unit, /^NoNewPrivileges=true$/m);
    }
    assert.match(autopilotUnit(), /serve --hostname 127\.0\.0\.1 --port 4096/);
  });
});

describe("package", () => {
  it("names its repository, which npm checks against the release's provenance", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { repository?: { url?: string } };
    // A missing or different URL fails `npm publish --provenance` with E422.
    assert.equal(pkg.repository?.url, "git+https://github.com/directionally-local/installer.git");
  });
});

describe("cli", () => {
  // Bare `dl` reads the laptop's remotes; keep this machine's own out of it.
  const previousRemotes = process.env.AUTOPILOT_REMOTES_FILE;
  let remotesRoot = "";
  before(async () => {
    remotesRoot = await mkdtemp(join(tmpdir(), "dl-cli-"));
    process.env.AUTOPILOT_REMOTES_FILE = join(remotesRoot, "remotes.json");
  });
  after(async () => {
    if (previousRemotes === undefined) delete process.env.AUTOPILOT_REMOTES_FILE;
    else process.env.AUTOPILOT_REMOTES_FILE = previousRemotes;
    await rm(remotesRoot, { recursive: true, force: true });
  });

  it("prints help and rejects unknown commands", async () => {
    let out = "";
    let err = "";
    const io = { out: (text: string) => { out += text; }, err: (text: string) => { err += text; } };
    assert.equal(await main(["--help"], io), 0);
    assert.match(out, /dl up \[--dry-run\]/);
    assert.match(out, /^Directionally Local: coding agents that run on this computer or on your own server\./);
    assert.match(out, /dl +set up the first time; afterwards, an overview\n +dl setup +set up or repair where your agents run/);
    assert.match(out, /dl use \[NAME\] +where tasks go without --server/);
    assert.match(out, /-m\/--model MODEL/);
    assert.match(out, /dl local status[\s\S]*dl local uninstall[\s\S]*On the server:/);
    assert.doesNotMatch(out, /background coding agents on your own server/i);
    assert.equal(await main(["launch"], io), 2);
    assert.match(err, /Unknown command "launch"/);
    out = "";
    assert.equal(await main([], io), 0, "bare dl explains itself, even off a server");
    assert.match(out, /isn't set up on this machine[\s\S]*run on this computer or on your own server[\s\S]*curl -fsSL https:\/\/directionallylocal\.run \| sh/);
    out = "";
    assert.equal(await main(["use"], io), 0);
    assert.match(out, /Nothing set up yet\. {2}dl setup/);
    out = "";
    assert.equal(await main(["--version"], io), 0);
    assert.match(out, /^\d+\.\d+\.\d+\n$/);
  });

  it("lists the laptop's setup commands in help and checks their flags", async () => {
    let out = "";
    let err = "";
    const io = { out: (text: string) => { out += text; }, err: (text: string) => { err += text; } };
    assert.equal(await main(["help"], io), 0);
    assert.match(out, /Used by the laptop's setup[\s\S]*dl up --access ssh --answers-stdin --events json[\s\S]*dl up --needs \[--access ssh\][\s\S]*dl pair --name NAME --json/);
    assert.equal(await main(["up", "--events", "xml"], io), 2);
    assert.match(err, /--events takes json/);
    assert.equal(await main(["up", "--access", "public", "--needs"], io), 2);
    assert.match(err, /--access must be tailscale, loopback or ssh/);
    err = "";
    assert.equal(await main(["pair", "--name", "MacBook"], io), 2, "the JSON is the only form");
    assert.match(err, /Usage: dl pair --name NAME --json/);
    assert.equal(await main(["pair", "--json"], io), 2);
  });

  it("dl status shows the laptop's overview", { skip: existsSync(PATHS.state) && "this machine is a server" }, async () => {
    let out = "";
    const io = { out: (text: string) => { out += text; }, err: () => {} };
    assert.equal(await main(["status"], io), 1, "nothing set up: says how to start");
    assert.match(out, /isn't set up on this machine/);
    await saveRemote({ name: "box", url: "http://127.0.0.1:9", token: "aster_x", credentialId: "c", expiresAt: "2027-01-01T00:00:00.000Z", addedAt: "2026-10-28T09:00:00.000Z" });
    out = "";
    assert.equal(await main(["status"], io), 0);
    assert.match(out, /Directionally Local {2}on this laptop[\s\S]*Runs on +● box/);
    assert.match(await (async () => { out = ""; await main(["--help"], io); return out; })(), /dl status +where your agents run and what they're doing/);
  });

  it("dl pair off a server says it isn't installed", { skip: existsSync(PATHS.state) && "this machine is a server" }, async () => {
    let err = "";
    const io = { out: () => {}, err: (text: string) => { err += text; } };
    assert.equal(await main(["pair", "--name", "MacBook", "--json"], io), 1);
    assert.match(err, /isn't installed on this server yet; run dl up first/);
  });

  it("reads the stdin answers to the end, or to the first line that parses", async () => {
    assert.equal(await readAnswers(Readable.from(['{"openrouterKey":', '"sk-or-x"}'])), '{"openrouterKey":"sk-or-x"}');
    // A laptop that leaves the channel open: the object ends a line, so reading stops there.
    const open = new Readable({ read() {} });
    open.push('{"githubToken":\n"ghp_x"}\n');
    assert.equal(await readAnswers(open), '{"githubToken":\n"ghp_x"}\n');
    await assert.rejects(readAnswers(Object.assign(Readable.from([]), { isTTY: true })), /from a pipe, not a terminal/);
  });
});
