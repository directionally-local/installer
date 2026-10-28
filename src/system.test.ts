import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RealSystem } from "./system.js";

describe("RealSystem", () => {
  it("gives every directory mkdir creates the requested mode, and leaves existing ones alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "dl-system-"));
    try {
      const system = new RealSystem(() => {});
      await system.mkdir(join(root, "a", "b", "c"), { mode: 0o750 });
      for (const dir of ["a", "a/b", "a/b/c"]) assert.equal((await stat(join(root, dir))).mode & 0o777, 0o750, dir);
      assert.notEqual((await stat(root)).mode & 0o777, 0o750, "an existing parent keeps its mode");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes secrets with their final mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "dl-system-"));
    try {
      const system = new RealSystem(() => {});
      await system.writeFile(join(root, "etc", "secret.env"), "KEY=1\n", { mode: 0o640 });
      assert.equal((await stat(join(root, "etc", "secret.env"))).mode & 0o777, 0o640);
      assert.equal(await system.readFile(join(root, "missing")), undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
