import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { main } from "./cli.js";
import { agentCapacity, parseDfFreeGb, parseInterfaceIp, parseMemTotalMb, parseOsRelease } from "./detect.js";
import { doctor, formatChecks } from "./doctor.js";
import { PATHS, autopilotUnit, envFile, hotcellUnit, parseEnvFile } from "./layout.js";
import { ScriptedPrompter } from "./prompt.js";
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
    assert.deepEqual(failed.map((check) => check.name), ["hotcell.service", "model key"]);
    assert.match(formatChecks(broken), /✗ hotcell\.service[\s\S]*fix: journalctl -u hotcell\.service/);
  });
});

describe("uninstall", () => {
  it("removes services and software but keeps data by default", async () => {
    const system = await installed();
    system.containers.push("abc123");
    await uninstall(system);
    assert.equal(system.enabled.size, 0, "no services left enabled");
    for (const unit of ["hotcell.service", "autopilot.service", "directionally-local-metadata-block.service"]) {
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
    assert.ok(system.ran.includes("docker image rm directionally-local-cell:2.2.0"));
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

describe("cli", () => {
  it("prints help and rejects unknown commands", async () => {
    let out = "";
    let err = "";
    const io = { out: (text: string) => { out += text; }, err: (text: string) => { err += text; } };
    assert.equal(await main(["--help"], io), 0);
    assert.match(out, /dl up \[--dry-run\]/);
    assert.equal(await main(["launch"], io), 2);
    assert.match(err, /Unknown command "launch"/);
    assert.equal(await main([], io), 2);
  });
});
