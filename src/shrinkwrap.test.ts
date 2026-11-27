import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const generator = join(root, "scripts", "generate-shrinkwrap.mjs");

type LockEntry = { dev?: boolean; devOptional?: boolean; version?: string; devDependencies?: Record<string, string> };
type Lock = {
  name?: string;
  version?: string;
  lockfileVersion?: number;
  requires?: boolean;
  packages?: Record<string, LockEntry>;
};
type Package = { name: string; version: string; devDependencies?: Record<string, string> };

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function generate(args: string[]): string {
  const result = spawnSync(process.execPath, [generator, ...args], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/** package-lock.json's production subset: what npm installs with --omit=dev. */
function productionSubset(pkg: Package, lock: Lock): Lock {
  const packages = Object.fromEntries(
    Object.entries(lock.packages ?? {}).filter(
      ([path, entry]) => path === "" || entry.dev !== true || entry.devOptional === true,
    ),
  );
  const rootEntry = packages[""];
  if (rootEntry) {
    const { devDependencies: _devDependencies, ...production } = rootEntry;
    packages[""] = { ...production, version: pkg.version };
  }
  const subset: Lock = { name: pkg.name, version: pkg.version, lockfileVersion: lock.lockfileVersion, packages };
  if (lock.requires !== undefined) subset.requires = lock.requires;
  return subset;
}

describe("npm-shrinkwrap.json for the published tarball", () => {
  const pkg = readJson<Package>(join(root, "package.json"));
  const lock = readJson<Lock>(join(root, "package-lock.json"));
  const shrinkwrap = JSON.parse(generate(["--stdout"])) as Lock;

  it("is package-lock.json's production subset at package.json's version", () => {
    assert.deepEqual(shrinkwrap, productionSubset(pkg, lock));
    assert.equal(shrinkwrap.version, pkg.version);
    assert.equal(shrinkwrap.packages?.[""]?.version, pkg.version);
    assert.ok(pkg.devDependencies && Object.keys(pkg.devDependencies).length > 0, "package.json has devDependencies to strip");
    assert.equal(shrinkwrap.packages?.[""]?.devDependencies, undefined, "the root entry is production-only");
  });

  it("drops dev entries and keeps the runtime dependency", () => {
    const dev = Object.entries(lock.packages ?? {})
      .filter(([path, entry]) => path !== "" && entry.dev === true && entry.devOptional !== true)
      .map(([path]) => path);
    assert.ok(dev.length > 0, "the lockfile has dev entries to drop");
    for (const path of dev) assert.equal(shrinkwrap.packages?.[path], undefined, path);
    assert.ok(shrinkwrap.packages?.["node_modules/yaml"], "yaml, dl's one runtime dependency, is kept");
  });

  it("keeps devOptional entries, which npm installs with --omit=dev", () => {
    const dir = mkdtempSync(join(tmpdir(), "dl-shrinkwrap-"));
    try {
      const synthetic: Lock = {
        name: "x",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": { version: "1.0.0", devDependencies: { dev: "1.0.0" } },
          "node_modules/prod": { version: "1.0.0" },
          "node_modules/dev": { version: "1.0.0", dev: true },
          "node_modules/dev-optional": { version: "1.0.0", dev: true, devOptional: true },
        },
      };
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
      writeFileSync(join(dir, "package-lock.json"), JSON.stringify(synthetic));
      const generated = JSON.parse(generate(["--root", dir, "--stdout"])) as Lock;
      assert.deepEqual(Object.keys(generated.packages ?? {}).sort(), ["", "node_modules/dev-optional", "node_modules/prod"]);
      assert.equal(generated.packages?.[""]?.devDependencies, undefined, "the root entry drops devDependencies");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("takes the version from package.json, so a release-please bump can't leave it behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "dl-shrinkwrap-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ ...pkg, version: "9.9.9" }));
      writeFileSync(join(dir, "package-lock.json"), JSON.stringify(lock));
      const bumped = JSON.parse(generate(["--root", dir, "--stdout"])) as Lock;
      assert.equal(bumped.version, "9.9.9");
      assert.equal(bumped.packages?.[""]?.version, "9.9.9");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is in the tarball npm pack would publish", () => {
    // prepack writes it and postpack removes it; --ignore-scripts keeps it for the check.
    generate([]);
    try {
      const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      const packed = JSON.parse(result.stdout) as { files: { path: string }[] }[];
      const files = packed.flatMap((entry) => entry.files.map((file) => file.path));
      assert.ok(files.includes("npm-shrinkwrap.json"), `packed: ${files.join(", ")}`);
    } finally {
      rmSync(join(root, "npm-shrinkwrap.json"), { force: true });
    }
  });
});
