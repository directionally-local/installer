import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { installCodeForAutopilot, normalizeInstallCode, pendingInstallCodePath, withInstallCode } from "./install-code.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "dl-install-code-test-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const env = (extra: Record<string, string> = {}) => ({ HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), ...extra });
const pending = () => join(root, "config", "directionallylocal", "pending-install-code");
const CODE = "AbCdEfGhIjKlMnOpQrStUvWxYz0";

async function keep(code: string): Promise<void> {
  await mkdir(join(root, "config", "directionallylocal"), { recursive: true });
  await writeFile(pending(), `${code}\n`);
}

describe("install codes", () => {
  it("are dl.new's base64url codes; anything else is ignored", () => {
    assert.equal(normalizeInstallCode(` ${CODE}\n`), CODE);
    assert.equal(normalizeInstallCode("a-b_c".padEnd(22, "x")), "a-b_cxxxxxxxxxxxxxxxxx");
    for (const bad of [undefined, "", "short", "a".repeat(65), "has space in it 0123456789", "$(id)aaaaaaaaaaaaaaaaaaaa", "../../etc/passwd/aaaaaaaaa"]) {
      assert.equal(normalizeInstallCode(bad), undefined, String(bad));
    }
  });

  it("are kept next to dl's config", () => {
    assert.equal(pendingInstallCodePath({ XDG_CONFIG_HOME: "/x" }), "/x/directionallylocal/pending-install-code");
    assert.equal(pendingInstallCodePath({ HOME: "/home/octo" }), "/home/octo/.config/directionallylocal/pending-install-code");
  });
});

describe("the install code dl gives plain Autopilot", () => {
  it("passes DL_INSTALL_CODE on, once: the kept copy is deleted", async () => {
    await keep(CODE);
    assert.equal(await installCodeForAutopilot({ env: env({ DL_INSTALL_CODE: CODE }) }), CODE);
    await assert.rejects(stat(pending()));
    assert.equal(await installCodeForAutopilot({ env: env() }), undefined);
  });

  it("uses the kept one when dl starts later without the variable, then forgets it", async () => {
    await keep(CODE);
    assert.equal(await installCodeForAutopilot({ env: env() }), CODE);
    assert.equal(await installCodeForAutopilot({ env: env() }), undefined);
  });

  it("ignores anything that isn't a code", async () => {
    await keep("not a code");
    assert.equal(await installCodeForAutopilot({ env: env({ DL_INSTALL_CODE: "nope" }) }), undefined);
    await assert.rejects(stat(pending()));
  });

  it("sets or removes the variable for Autopilot", () => {
    assert.deepEqual(withInstallCode({ A: "1", DL_INSTALL_CODE: "old" }, undefined), { A: "1" });
    assert.deepEqual(withInstallCode({ A: "1" }, CODE), { A: "1", DL_INSTALL_CODE: CODE });
  });
});
