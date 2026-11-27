#!/usr/bin/env node
/**
 * Fails when the tarball npm would publish doesn't carry npm-shrinkwrap.json, or
 * carries one that isn't package-lock.json's production subset at package.json's
 * version.
 *
 * Why: the shrinkwrap is what pins dl's transitive dependencies for
 * `npm install -g directionallylocal@<version>`. prepack writes it and postpack
 * removes it, so nothing in the repo shows it; this is the check that the
 * published tarball has it and that it matches the lockfile.
 *
 * Usage: node scripts/check-shrinkwrap.mjs
 * Exit: 0 the tarball is right, 1 it isn't.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { buildShrinkwrap } from "./generate-shrinkwrap.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shrinkwrapPath = join(root, "npm-shrinkwrap.json");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function main() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const problems = [];

  // A copy left by an interrupted pack would make the inclusion check pass
  // without prepack having run.
  rmSync(shrinkwrapPath, { force: true });

  try {
    const packed = JSON.parse(run("npm", ["pack", "--dry-run", "--json"]));
    const files = packed.flatMap((entry) => entry.files.map((file) => file.path));
    if (!files.includes("npm-shrinkwrap.json")) {
      problems.push("npm pack --dry-run doesn't include npm-shrinkwrap.json (is it in package.json's files?)");
    }

    // postpack removed it; prepack is what puts it in the tarball.
    run("npm", ["run", "--silent", "prepack"]);
    const actual = JSON.parse(readFileSync(shrinkwrapPath, "utf8"));

    if (actual.version !== pkg.version || actual.packages?.[""]?.version !== pkg.version) {
      problems.push(
        `npm-shrinkwrap.json is at ${actual.version} (root ${actual.packages?.[""]?.version}), package.json is at ${pkg.version}`,
      );
    }
    const dev = Object.entries(actual.packages ?? {})
      .filter(([path, entry]) => path !== "" && entry.dev === true && entry.devOptional !== true)
      .map(([path]) => path);
    if (dev.length > 0) {
      problems.push(`npm-shrinkwrap.json has ${dev.length} dev entries, e.g. ${dev.slice(0, 3).join(", ")}`);
    }
    if (actual.packages?.[""]?.devDependencies) {
      problems.push("npm-shrinkwrap.json's root entry still lists devDependencies");
    }
    if (!isDeepStrictEqual(actual, buildShrinkwrap(pkg, lock))) {
      problems.push("npm-shrinkwrap.json isn't package-lock.json's production subset (is the lockfile stale?)");
    }
  } finally {
    rmSync(shrinkwrapPath, { force: true });
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    return 1;
  }
  console.log(`✓ npm-shrinkwrap.json is in the tarball: package-lock.json's production subset at ${pkg.version}`);
  return 0;
}

process.exit(main());
