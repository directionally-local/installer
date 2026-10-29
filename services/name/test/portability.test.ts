import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * The portability gate, as a test. `sobjects build --strict` catches Node.js built-ins and
 * native addons; this catches the Cloudflare-only APIs it doesn't look at, plus the config
 * rules celld enforces.
 */

const service = new URL("../", import.meta.url);
const shared = new URL("../../shared/", import.meta.url);
const read = (base: URL, name: string) => readFile(new URL(name, base), "utf8");

// Top-level keys celld accepts in wrangler.json/jsonc.
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

const FORBIDDEN = [
  /\brequire\s*\(/,
  /\bprocess\./,
  /\bBuffer\b/,
  /\b__dirname\b/,
  /\b__filename\b/,
  /\bHTMLRewriter\b/,
  /cloudflare:sockets/,
  /cloudflare:email/,
  /\bcaches\./,
  /\bwaitUntil\b/,
  /\bD1Database\b/,
  /\bKVNamespace\b/,
  /\bR2Bucket\b/,
];

const SECRETS = ["CF_DNS_API_TOKEN", "ADMIN_TOKEN", "GITHUB_APP_PRIVATE_KEY", "GITHUB_CLIENT_SECRET", "GITHUB_WEBHOOK_SECRET"];

/** Every .ts file under `dir`, as a path relative to `base`. */
async function sourceFiles(base: URL, dir = "src"): Promise<string[]> {
  const root = new URL(`${dir}/`, base);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => relative(fileURLToPath(base), join(entry.parentPath, entry.name)));
}

describe("name service portability", () => {
  it("imports only relative modules and cloudflare:workers", async () => {
    for (const base of [service, shared]) {
      for (const file of await sourceFiles(base)) {
        const source = await read(base, file);
        for (const match of source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm)) {
          const specifier = match[1]!;
          assert.ok(
            specifier.startsWith("./") || specifier.startsWith("../") || specifier === "cloudflare:workers",
            `${file} imports ${specifier}; only relative modules and cloudflare:workers are portable`,
          );
        }
      }
    }
  });

  it("uses no Node.js built-ins or Cloudflare-only APIs", async () => {
    for (const base of [service, shared]) {
      for (const file of await sourceFiles(base)) {
        const source = await read(base, file);
        for (const pattern of FORBIDDEN) {
          assert.doesNotMatch(source, pattern, `${file} matches ${pattern}`);
        }
      }
    }
  });

  it("exports only a fetch handler", async () => {
    const source = await read(service, "src/index.ts");
    assert.match(source, /export default\s*\{/);
    for (const handler of ["scheduled", "queue", "tail", "email", "webSocketMessage", "webSocketClose"]) {
      assert.doesNotMatch(source, new RegExp(`\\b${handler}\\s*[:(]`), `index.ts defines ${handler}`);
    }
  });

  it("keeps a portable wrangler.jsonc that celld can read", async () => {
    const config = JSON.parse(await read(service, "wrangler.jsonc")) as Record<string, unknown>;
    for (const key of Object.keys(config)) {
      assert.ok(PORTABLE_CONFIG_KEYS.has(key), `wrangler.jsonc has celld-rejected key ${key}`);
    }
    assert.equal(config.main, "src/index.ts");
    assert.equal(typeof config.compatibility_date, "string");
    assert.ok((config.compatibility_date as string) >= "2026-10-01");
    assert.equal(config.compatibility_flags, undefined, "the services don't need nodejs_compat");
  });

  it("keeps the Cloudflare deploy config in sync with the portable one", async () => {
    const portable = JSON.parse(await read(service, "wrangler.jsonc")) as {
      name: string;
      main: string;
      compatibility_date: string;
      durable_objects: unknown;
      migrations: unknown;
    };
    const cloudflare = JSON.parse(await read(service, "wrangler.cloudflare.jsonc")) as typeof portable & {
      routes?: unknown;
      workers_dev?: boolean;
    };
    assert.equal(cloudflare.name, portable.name);
    assert.equal(cloudflare.main, portable.main);
    assert.equal(cloudflare.compatibility_date, portable.compatibility_date);
    assert.deepEqual(cloudflare.durable_objects, portable.durable_objects);
    assert.deepEqual(cloudflare.migrations, portable.migrations);
    assert.ok(Array.isArray(cloudflare.routes), "the Cloudflare config owns the routes");
    assert.equal(cloudflare.workers_dev, false);
  });

  it("lists every Durable Object class in a SQLite migration", async () => {
    const config = JSON.parse(await read(service, "wrangler.jsonc")) as {
      durable_objects: { bindings: Array<{ class_name: string }> };
      migrations: Array<{ tag: string; new_sqlite_classes?: string[] }>;
    };
    const classes = config.durable_objects.bindings.map((binding) => binding.class_name).sort();
    const migrated = config.migrations.flatMap((migration) => migration.new_sqlite_classes ?? []).sort();
    assert.deepEqual(migrated, classes);
    for (const migration of config.migrations) {
      assert.match(migration.tag, /^v\d+$/, "celld accepts tag migrations only");
    }
  });

  it("commits no secrets", async () => {
    for (const file of ["wrangler.jsonc", "wrangler.cloudflare.jsonc", "sobjects.example.toml"]) {
      const source = await read(service, file);
      for (const secret of SECRETS) {
        assert.doesNotMatch(source, new RegExp(secret), `${file} mentions the secret ${secret}`);
      }
    }
  });

  it("keeps the Serverless Objects example free of credentials", async () => {
    const toml = await read(service, "sobjects.example.toml");
    assert.match(toml, /^\[celld\]$/m);
    assert.match(toml, /^bucket = /m);
    assert.doesNotMatch(toml, /token|secret|password/i);
  });
});
