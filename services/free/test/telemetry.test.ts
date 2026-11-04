import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createService, errorCode, NOW } from "./harness.js";
import { cleanDownload, cleanInstall, DOWNLOAD_ROUTES, INSTALL_STEPS } from "../src/telemetry.js";

const DAY = 86_400_000;
const INSTALL = { os: "darwin", arch: "arm64", mode: "laptop", dlVersion: "0.13.0", result: "ok", via: "home" };

function rows(service: Awaited<ReturnType<typeof createService>>, table: "download_daily" | "install_daily"): Array<Record<string, unknown>> {
  service.directory();
  const entry = service.namespaces.DIRECTORY!.instances.get("directory") as unknown as { state: { db: { prepare(sql: string): { all(): Array<Record<string, unknown>> } } } };
  return entry.state.db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2, 3`).all().map((row) => ({ ...row }));
}

describe("telemetry allowlists", () => {
  it("takes only known routes and clients", () => {
    for (const route of DOWNLOAD_ROUTES) assert.deepEqual(cleanDownload({ route, client: "curl" }), { route, client: "curl" });
    assert.deepEqual(cleanDownload({ route: "run", client: "wget", ip: "203.0.113.7", code: "alice" }), { route: "run", client: "wget" }, "other keys are dropped");
    for (const bad of [{ route: "r/alice", client: "curl" }, { route: "run_laptop", client: "curl" }, { route: "home", client: "Mozilla/5.0" }, { route: "home" }, [], null, "home"]) {
      assert.equal(typeof cleanDownload(bad), "string", JSON.stringify(bad));
    }
  });

  it("takes only known install values, a plain version, and a failed step only on failure", () => {
    assert.deepEqual(cleanInstall(INSTALL), { ...INSTALL, failedStep: "" });
    assert.deepEqual(cleanInstall({ ...INSTALL, dlVersion: "", result: "failed", failedStep: "node" }), { ...INSTALL, dlVersion: "unknown", result: "failed", failedStep: "node" });
    for (const step of INSTALL_STEPS) assert.equal(typeof cleanInstall({ ...INSTALL, result: "failed", failedStep: step }), "object");
    for (const bad of [
      { ...INSTALL, os: "windows" },
      { ...INSTALL, arch: "riscv64" },
      { ...INSTALL, mode: "cloud" },
      { ...INSTALL, result: "maybe" },
      { ...INSTALL, via: "twitter" },
      { ...INSTALL, via: undefined },
      { ...INSTALL, dlVersion: "0.13.0; rm -rf /" },
      { ...INSTALL, dlVersion: "/home/alice" },
      { ...INSTALL, dlVersion: 13 },
      { ...INSTALL, result: "failed", failedStep: "npm ERR! 404 at /Users/alice" },
      { ...INSTALL, failedStep: "node" },
    ]) {
      assert.equal(typeof cleanInstall(bad), "string", JSON.stringify(bad));
    }
  });
});

describe("POST /v1/telemetry/download and /v1/telemetry/install", () => {
  it("aggregate per day and keep nothing else, with no sign-in", async () => {
    const service = await createService();
    const post = (path: string, body: unknown, ip = "203.0.113.7") => service.request("POST", `/v1/telemetry/${path}`, { body, ip });
    for (const body of [{ route: "home", client: "curl" }, { route: "home", client: "curl" }, { route: "invite", client: "wget" }]) {
      assert.equal((await post("download", body)).status, 204);
    }
    assert.equal((await post("install", INSTALL)).status, 204);
    assert.equal((await post("install", INSTALL, "198.51.100.9")).status, 204);
    assert.equal((await post("install", { ...INSTALL, result: "failed", failedStep: "install_dl", dlVersion: "" })).status, 204);
    service.clock.now = NOW + DAY;
    assert.equal((await post("download", { route: "home", client: "curl" })).status, 204);

    const today = Math.floor(NOW / DAY);
    assert.deepEqual(rows(service, "download_daily"), [
      { day: today, route: "home", client: "curl", downloads: 2 },
      { day: today, route: "invite", client: "wget", downloads: 1 },
      { day: today + 1, route: "home", client: "curl", downloads: 1 },
    ]);
    const installs = rows(service, "install_daily");
    assert.deepEqual(
      installs.map((row) => [row.result, row.failed_step, row.dl_version, row.installs]).sort(),
      [["failed", "install_dl", "unknown", 1], ["ok", "", "0.13.0", 2]],
    );
    assert.deepEqual(Object.keys(installs[0]!).sort(), ["arch", "day", "dl_version", "failed_step", "installs", "mode", "os", "result", "via"]);

    // No IP, in the counts or in the rate limiter's keys.
    for (const [name, namespace] of Object.entries(service.namespaces)) {
      for (const [key, instance] of (namespace as unknown as { instances: Map<string, { state: { db: { prepare(sql: string): { all(): unknown[] } } } }> }).instances) {
        assert.doesNotMatch(key, /203\.0\.113\.7|198\.51\.100\.9/, `${name} object name`);
        const tables = instance.state.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
        for (const { name: table } of tables) {
          const dump = JSON.stringify(instance.state.db.prepare(`SELECT * FROM "${table}"`).all());
          assert.doesNotMatch(dump, /203\.0\.113\.7|198\.51\.100\.9/, `${name}.${table}`);
        }
      }
    }
  });

  it("refuse unknown values, bad JSON and big bodies, and count nothing", async () => {
    const service = await createService();
    const bad = await service.request("POST", "/v1/telemetry/download", { body: { route: "r/alice", client: "curl" } });
    assert.equal(bad.status, 400);
    assert.equal(await errorCode(bad), "invalid_request");
    assert.equal((await service.request("POST", "/v1/telemetry/install", { body: { ...INSTALL, os: "plan9" } })).status, 400);
    assert.equal((await service.request("POST", "/v1/telemetry/install", { body: "{not json" })).status, 400);
    assert.equal((await service.request("POST", "/v1/telemetry/install", { body: { ...INSTALL, pad: "x".repeat(2000) } })).status, 413);
    assert.equal((await service.request("GET", "/v1/telemetry/install")).status, 404);
    assert.deepEqual(rows(service, "download_daily"), []);
    assert.deepEqual(rows(service, "install_daily"), []);
  });

  it("are rate-limited per IP", async () => {
    const service = await createService();
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) statuses.push((await service.request("POST", "/v1/telemetry/install", { body: INSTALL, ip: "192.0.2.1" })).status);
    assert.deepEqual(statuses.slice(0, 20), Array(20).fill(204));
    assert.equal(statuses[21], 429);
    assert.equal((await service.request("POST", "/v1/telemetry/install", { body: INSTALL, ip: "192.0.2.2" })).status, 204, "another address isn't affected");
    assert.equal(rows(service, "install_daily")[0]!.installs, 21);
  });
});
