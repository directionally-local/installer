#!/usr/bin/env node
/**
 * Writes npm-shrinkwrap.json for the published tarball: package-lock.json's
 * production subset, at package.json's version.
 *
 * Why: without a shrinkwrap in the tarball, `npm install -g directionallylocal@<version>`
 * resolves dl's transitive dependencies from the ranges in package.json, so a
 * hijacked release of any package in the tree would reach users. npm prefers
 * npm-shrinkwrap.json over package-lock.json, so a production-only copy
 * committed at the repo root would break `npm ci` (devDependencies missing)
 * and Dependabot. Instead prepack writes it and postpack removes it (it's
 * gitignored), so only the tarball carries one.
 *
 * The subset is package-lock.json minus `dev` entries. `devOptional` entries
 * stay even when they're also marked `dev`: npm installs them with --omit=dev.
 * The root entry keeps its production dependencies but drops devDependencies,
 * whose entries were just removed, so the file is genuinely production-only.
 * The version fields come from package.json, so they match after release-please
 * bumps package.json.
 *
 * Usage: node scripts/generate-shrinkwrap.mjs [--root <dir>] [--stdout] [--remove]
 *   --root <dir>  read package.json and package-lock.json from <dir> (default: this repo)
 *   --stdout      print the shrinkwrap instead of writing it
 *   --remove      delete npm-shrinkwrap.json (postpack)
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The shrinkwrap npm should publish: every package-lock.json entry npm installs
 * with --omit=dev, with the version fields taken from package.json.
 */
export function buildShrinkwrap(pkg, lock) {
  const packages = {};
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path !== "" && entry.dev === true && entry.devOptional !== true) continue;
    if (path === "") {
      // The root entry describes dl itself: keep its production dependencies, but
      // not devDependencies, whose entries were just dropped.
      const root = { ...entry, version: pkg.version };
      delete root.devDependencies;
      packages[path] = root;
    } else {
      packages[path] = entry;
    }
  }
  const shrinkwrap = { name: pkg.name, version: pkg.version, lockfileVersion: lock.lockfileVersion };
  if (lock.requires !== undefined) shrinkwrap.requires = lock.requires;
  shrinkwrap.packages = packages;
  return shrinkwrap;
}

function parseArgs(argv) {
  const options = { root: repoRoot, stdout: false, remove: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--stdout") options.stdout = true;
    else if (arg === "--remove") options.remove = true;
    else if (arg === "--root") {
      const dir = argv[++i];
      if (!dir) throw new Error("--root needs a directory");
      options.root = resolve(dir);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const target = join(options.root, "npm-shrinkwrap.json");
  if (options.remove) {
    rmSync(target, { force: true });
    return 0;
  }
  const pkg = JSON.parse(readFileSync(join(options.root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(options.root, "package-lock.json"), "utf8"));
  const text = `${JSON.stringify(buildShrinkwrap(pkg, lock), null, 2)}\n`;
  if (options.stdout) process.stdout.write(text);
  else writeFileSync(target, text);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
