import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseOsRelease } from "./detect.js";

const SCRIPT = new URL("../install.sh", import.meta.url).pathname;

/** install.sh only runs on Ubuntu or Debian: it reads the real /etc/os-release. */
function supportedHost(): boolean {
  if (process.platform !== "linux" || !existsSync("/etc/os-release")) return false;
  return ["ubuntu", "debian"].includes(parseOsRelease(readFileSync("/etc/os-release", "utf8")).id);
}

/**
 * Runs install.sh with every command it calls stubbed on PATH: root, a patched Node, curl
 * present, npm recording its arguments, and `directionallylocal` noting that `up` ran.
 */
function install(env: Record<string, string>, options: { npmFails?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dl-install-"));
  const stub = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  stub("id", 'echo 0');
  stub("uname", 'echo Linux');
  stub("node", 'exit 0');
  stub("curl", 'exit 0');
  stub("npm", options.npmFails ? 'echo "npm ERR! 404 Not Found"; exit 1' : `echo "$*" >> "${dir}/npm.log"`);
  stub("dl", 'echo 0.1.2');
  stub("directionallylocal", `echo "$*" >> "${dir}/up.log"`);
  try {
    const result = spawnSync("sh", [SCRIPT], { env: { PATH: `${dir}:/usr/bin:/bin`, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const read = (name: string) => existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : undefined;
    return { ...result, npm: read("npm.log"), up: read("up.log") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("install.sh", () => {
  it("is valid sh", () => {
    const result = spawnSync("sh", ["-n", SCRIPT], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  });

  it("with DL_INSTALL_ONLY=1 installs the CLI and stops before dl up", { skip: !supportedHost() && "needs Ubuntu or Debian" }, () => {
    const only = install({ DL_INSTALL_ONLY: "1" });
    assert.equal(only.status, 0, only.stderr);
    assert.equal(only.stdout, "Directionally Local\n.. Getting the installer\nok Getting the installer: dl 0.1.2\n", "plain lines without a terminal");
    assert.match(only.npm ?? "", /^install -g --no-audit --no-fund --loglevel=error directionallylocal@latest$/m);
    assert.equal(only.up, undefined, "dl up didn't run");

    // Without it, the same install goes on to dl up (so the stubs above are what it calls).
    const full = install({});
    assert.equal(full.status, 0, full.stderr);
    assert.equal(full.up, "up\n");
  });

  it("reports a failed step on stderr and exits 1", { skip: !supportedHost() && "needs Ubuntu or Debian" }, () => {
    const failed = install({ DL_INSTALL_ONLY: "1" }, { npmFails: true });
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, "Directionally Local\n.. Getting the installer\n");
    assert.match(failed.stderr, /npm ERR! 404 Not Found[\s\S]*directionallylocal: installing directionallylocal@latest failed/);
    assert.equal(failed.up, undefined);
  });
});
