import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { INSTALL_SCRIPT } from "./install-script.js";

const site = new URL("./", import.meta.url);
const read = (name: string) => readFile(new URL(name, site), "utf8");

const CODE_FILES = ["index.ts", "handler.ts"];
const SOURCE_FILES = [...CODE_FILES, "install-script.ts"];

// Top-level keys celld accepts in wrangler.json/jsonc. Anything else, including
// routes and workers_dev, stops a Serverless Objects deployment.
const PORTABLE_CONFIG_KEYS = new Set([
  "$schema",
  "name",
  "main",
  "no_bundle",
  "compatibility_date",
  "compatibility_flags",
  "durable_objects",
  "migrations",
  "assets",
  "services",
  "triggers",
  "vars",
  "d1_databases",
  "kv_namespaces",
  "queues",
  "workflows",
  "r2_buckets",
  "worker_loaders",
  "containers",
  "define",
  "rules",
]);

describe("site/ portability", () => {
  it("imports only relative modules, so the bundle has no Node.js built-ins", async () => {
    for (const file of SOURCE_FILES) {
      const source = await read(file);
      for (const match of source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm)) {
        const specifier = match[1]!;
        assert.ok(
          specifier.startsWith("./") || specifier.startsWith("../"),
          `${file} imports ${specifier}; only relative modules are portable`,
        );
      }
    }
  });

  it("uses no Node.js built-ins or Cloudflare-only APIs", async () => {
    const forbidden = [
      /\brequire\s*\(/,
      /\bprocess\./,
      /\bBuffer\b/,
      /\b__dirname\b/,
      /\b__filename\b/,
      /\bHTMLRewriter\b/,
      /cloudflare:sockets/,
      /\bcaches\./,
    ];
    for (const file of CODE_FILES) {
      const source = await read(file);
      for (const pattern of forbidden) {
        assert.doesNotMatch(source, pattern, `${file} matches ${pattern}`);
      }
    }
  });

  it("exports only a fetch handler", async () => {
    const source = await read("index.ts");
    assert.match(source, /export default\s*\{/);
    for (const handler of ["scheduled", "queue", "alarm", "tail", "email", "webSocketMessage", "webSocketClose"]) {
      assert.doesNotMatch(source, new RegExp(`\\b${handler}\\s*[:(]`), `index.ts defines ${handler}`);
    }
  });

  it("keeps a portable wrangler.jsonc that celld can read", async () => {
    const config = JSON.parse(await read("wrangler.jsonc")) as Record<string, unknown>;
    for (const key of Object.keys(config)) {
      assert.ok(PORTABLE_CONFIG_KEYS.has(key), `wrangler.jsonc has celld-rejected key ${key}`);
    }
    assert.equal(config.main, "index.ts");
    assert.equal(typeof config.compatibility_date, "string");
    assert.ok((config.compatibility_date as string) >= "2026-02-24");
    assert.equal(config.durable_objects, undefined);
    assert.equal(config.migrations, undefined);
  });

  it("keeps the Cloudflare deploy config in sync with the portable one", async () => {
    const config = JSON.parse(await read("wrangler.jsonc")) as {
      name: string;
      main: string;
      compatibility_date: string;
    };
    const toml = await read("wrangler.toml");
    assert.match(toml, new RegExp(`^name = "${config.name}"$`, "m"));
    assert.match(toml, new RegExp(`^main = "${config.main}"$`, "m"));
    assert.match(toml, new RegExp(`^compatibility_date = "${config.compatibility_date}"$`, "m"));
  });

  it("serves the checked-in install script, not a stale copy", async () => {
    const script = await readFile(new URL("../install.sh", import.meta.url), "utf8");
    assert.equal(INSTALL_SCRIPT, script);
  });
});
