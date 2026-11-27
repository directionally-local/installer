import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SELF = fileURLToPath(import.meta.url);

/** Directories that hold dependencies, build output or history, not our text. */
const SKIP = new Set([".git", "node_modules", "dist", "coverage", ".wrangler"]);

/** Files whose text we read: docs, code, scripts, config and templates. */
const TEXT = /\.(md|ts|mts|cts|js|mjs|cjs|sh|json|jsonc|yml|yaml|txt|html|toml)$/;

/**
 * An install command that pipes a dl.new URL into a shell. curl reads a scheme-less URL as
 * plain HTTP on port 80 first, so anyone on the network path can swap the script before sh
 * runs it; http:// is no better. Only https:// immediately before the host is acceptable.
 */
const INSTALL = /dl\.new[^\s"'`)]*\s*\|\s*(sudo\s+)?(sh|bash)/g;

/** The install commands on one line that aren't preceded by https://. */
function schemeLessCommands(line: string): string[] {
  const found: string[] = [];
  for (const match of line.matchAll(INSTALL)) {
    // Check this match, not the whole line: a line can hold one good command and one bad one.
    if (line.slice(0, match.index ?? 0).endsWith("https://")) continue;
    found.push(match[0]);
  }
  return found;
}

function textFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) textFiles(path, found);
    else if (entry.isFile() && TEXT.test(entry.name)) found.push(path);
  }
  return found;
}

describe("the advertised install command", () => {
  it("accepts https:// and rejects scheme-less and http:// commands", () => {
    assert.deepEqual(schemeLessCommands("curl -fsSL https://dl.new | sh"), [], "https is fine");
    assert.deepEqual(schemeLessCommands("curl -fsSL https://dl.new/i/CODE | sh"), [], "https with a path is fine");
    assert.deepEqual(schemeLessCommands("curl -fsSL dl.new | sh"), ["dl.new | sh"], "no scheme");
    assert.deepEqual(schemeLessCommands("curl -fsSL http://dl.new | sh"), ["dl.new | sh"], "http is no better");
    assert.deepEqual(schemeLessCommands("curl -fsSL dl.new/install.sh | sudo sh"), ["dl.new/install.sh | sudo sh"], "no scheme, sudo");
    assert.deepEqual(
      schemeLessCommands("curl -fsSL https://dl.new | sh && curl -fsSL dl.new | sh"),
      ["dl.new | sh"],
      "one good command doesn't excuse a bad one on the same line",
    );
  });

  it("always names https://, never a scheme-less dl.new URL piped into a shell", () => {
    const offenders: string[] = [];
    for (const path of textFiles(ROOT)) {
      // This file's fixtures are deliberately bad commands.
      if (path === SELF) continue;
      const lines = readFileSync(path, "utf8").split("\n");
      lines.forEach((line, index) => {
        for (const command of schemeLessCommands(line)) {
          offenders.push(`${relative(ROOT, path)}:${index + 1}: ${command}`);
        }
      });
    }
    assert.deepEqual(offenders, [], `scheme-less install commands (use https://dl.new):\n${offenders.join("\n")}`);
  });

  it("shows the canonical command in the README", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    assert.ok(readme.includes("curl -fsSL https://dl.new | sh"), "README advertises curl -fsSL https://dl.new | sh");
  });
});
