#!/usr/bin/env node
/**
 * The static half of the portability gate. `sobjects build --strict` only inspects Node.js
 * built-ins and native addons; this catches the Cloudflare-only APIs it doesn't look at.
 *
 *   node scripts/check-portable-apis.mjs services/name services/shared
 *
 * Exits non-zero with one line per violation.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const FORBIDDEN = [
  { pattern: /\brequire\s*\(/, why: "CommonJS require" },
  { pattern: /\bprocess\./, why: "process (read configuration from env)" },
  { pattern: /\bBuffer\b/, why: "Buffer (use Uint8Array)" },
  { pattern: /\b__dirname\b/, why: "__dirname" },
  { pattern: /\b__filename\b/, why: "__filename" },
  { pattern: /\bHTMLRewriter\b/, why: "HTMLRewriter is Cloudflare-only" },
  { pattern: /cloudflare:sockets/, why: "cloudflare:sockets is Cloudflare-only" },
  { pattern: /cloudflare:email/, why: "cloudflare:email is Cloudflare-only" },
  { pattern: /\bcaches\./, why: "the Cache API is Cloudflare-only" },
  { pattern: /\bwaitUntil\b/, why: "waitUntil (use a Durable Object alarm)" },
  { pattern: /\bD1Database\b/, why: "D1 is not covered by the conformance suite" },
  { pattern: /\bKVNamespace\b/, why: "KV is not covered by the conformance suite" },
  { pattern: /\bR2Bucket\b/, why: "R2 is not covered by the conformance suite" },
];

const ALLOWED_IMPORTS = new Set(["cloudflare:workers"]);

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error("usage: node scripts/check-portable-apis.mjs <dir> [dir...]");
  process.exit(2);
}

const violations = [];

for (const root of roots) {
  for (const file of await sourceFiles(root)) {
    const source = await readFile(file, "utf8");
    const lines = source.split("\n");
    for (const { pattern, why } of FORBIDDEN) {
      lines.forEach((line, index) => {
        if (pattern.test(line)) violations.push(`${file}:${index + 1}: ${why}`);
      });
    }
    for (const match of source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm)) {
      const specifier = match[1];
      if (specifier.startsWith("./") || specifier.startsWith("../") || ALLOWED_IMPORTS.has(specifier)) continue;
      violations.push(`${file}: imports ${specifier}; only relative modules and cloudflare:workers are portable`);
    }
  }
}

if (violations.length > 0) {
  for (const violation of violations) console.error(violation);
  console.error(`\n${violations.length} portability violation(s).`);
  process.exit(1);
}

console.log(`Portable: ${roots.join(", ")}`);

async function sourceFiles(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
    .map((entry) => relative(process.cwd(), join(entry.parentPath, entry.name)));
}
