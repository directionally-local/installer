import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { ADMIN_ID, createInvite, createService, errorCode, NOW, type Service } from "./harness.js";
import { adminCookie, tools } from "./admin-web.js";
import { cleanEvent, cleanGpuProps, cleanGpuTelemetry, earlyAccessEmail, GPU_DETECT_OUTCOMES, GPU_ERROR_TYPES, GPU_EVENTS, GPU_OPTIONS, GPU_VENDORS, type GpuCount } from "../src/events.js";

/**
 * Autopilot's GPU first run: the allowlist (events.ts), the anonymous POST /v1/telemetry/gpu, gpu.*
 * events on /v1/events, the gpu_daily counts, and the Health and home screen lines.
 */

const DAY = 86_400_000;
const BLANK = { gpuVendor: "", gpuModel: "", gpuVramGb: -1, gpuCount: -1, answer: "", option: "", path: "", outcome: "", errorType: "" } as const;
const DETECTED = { event: "detected", gpuVendor: "nvidia", gpuModel: "NVIDIA GeForce RTX 4090 (24GB)", gpuVramGb: 23.6, gpuCount: 2 };

function db(service: Service): DatabaseSync {
  service.directory();
  return (service.namespaces.DIRECTORY!.instances.get("directory") as { state: { db: DatabaseSync } }).state.db;
}

const gpuRows = (service: Service) => db(service).prepare("SELECT * FROM gpu_daily ORDER BY event, vendor, option, path, outcome, error_type").all().map((row) => ({ ...row }));

describe("GPU allowlist", () => {
  it("takes a good body for every event, with the words not sent stored as '' and numbers as -1", () => {
    assert.deepEqual(cleanGpuTelemetry(DETECTED), { ...BLANK, event: "detected", gpuVendor: "nvidia", gpuModel: "NVIDIA GeForce RTX 4090 (24GB)", gpuVramGb: 24, gpuCount: 2 });
    assert.deepEqual(cleanGpuTelemetry({ event: "detected", gpuVendor: "none" }), { ...BLANK, event: "detected", gpuVendor: "none" });
    assert.deepEqual(cleanGpuTelemetry({ event: "prompt", gpuVendor: "amd", answer: "no" }), { ...BLANK, event: "prompt", gpuVendor: "amd", answer: "no" });
    assert.deepEqual(cleanGpuTelemetry({ event: "early_access", gpuVendor: "ascend", answer: "yes" }), { ...BLANK, event: "early_access", gpuVendor: "ascend", answer: "yes" });
    for (const option of GPU_OPTIONS) assert.deepEqual(cleanGpuTelemetry({ event: "option", option }), { ...BLANK, event: "option", option });
    assert.deepEqual(cleanGpuTelemetry({ event: "result", outcome: "ok", path: "this_machine", gpuVendor: "nvidia" }), { ...BLANK, event: "result", gpuVendor: "nvidia", outcome: "ok", path: "this_machine" });
    assert.deepEqual(cleanGpuTelemetry({ event: "result", outcome: "failed", path: "endpoint", errorType: "unauthorized" }), { ...BLANK, event: "result", outcome: "failed", path: "endpoint", errorType: "unauthorized" });
    for (const errorType of GPU_ERROR_TYPES) assert.equal((cleanGpuTelemetry({ event: "result", outcome: "failed", path: "endpoint", errorType }) as GpuCount).errorType, errorType);
    // Failed without saying why (or with a reason it doesn't know): "other".
    assert.equal((cleanGpuTelemetry({ event: "result", outcome: "failed", path: "remote_server" }) as GpuCount).errorType, "other");
    assert.equal((cleanGpuTelemetry({ event: "result", outcome: "failed", path: "remote_server", errorType: "segfault at /home/alice" }) as GpuCount).errorType, "other");
    // An error type with outcome ok is dropped, not stored.
    assert.equal((cleanGpuTelemetry({ event: "result", outcome: "ok", path: "this_machine", errorType: "no_docker" }) as GpuCount).errorType, "");
    for (const vendor of GPU_VENDORS) assert.equal(typeof cleanGpuTelemetry({ event: "detected", gpuVendor: vendor }), "object");
  });

  it("takes a detection whose tool didn't answer (probe_timeout, probe_failed) only on detected", () => {
    for (const outcome of GPU_DETECT_OUTCOMES) {
      assert.deepEqual(cleanGpuTelemetry({ event: "detected", gpuVendor: "nvidia", outcome }), { ...BLANK, event: "detected", gpuVendor: "nvidia", outcome });
      assert.equal(typeof cleanGpuTelemetry({ event: "result", outcome, path: "this_machine" }), "string", "not a result's outcome");
      assert.equal((cleanGpuTelemetry({ event: "option", option: "gpus", outcome }) as GpuCount).outcome, "");
      assert.deepEqual(cleanEvent({ id: "d1", type: "gpu.detected", props: { gpuVendor: "nvidia", outcome } }, NOW)?.props, { gpuVendor: "nvidia", outcome });
      assert.deepEqual(cleanEvent({ id: "r1", type: "gpu.result", props: { path: "this_machine", outcome } }, NOW)?.props, { path: "this_machine" });
    }
    assert.equal((cleanGpuTelemetry({ event: "detected", gpuVendor: "nvidia", outcome: "slow" }) as GpuCount).outcome, "");
  });

  it("drops malformed optional fields and other keys", () => {
    const clean = cleanGpuTelemetry({
      event: "detected",
      gpuVendor: "nvidia",
      gpuModel: "x".repeat(65),
      gpuVramGb: "24",
      gpuCount: 1.5,
      answer: "maybe",
      ip: "203.0.113.7",
      hostname: "alice-laptop",
    });
    assert.deepEqual(clean, { ...BLANK, event: "detected", gpuVendor: "nvidia" });
    for (const model of ["RTX <script>", "/home/alice; rm -rf", "Tesla\nV100", "名前", ""]) assert.equal((cleanGpuTelemetry({ ...DETECTED, gpuModel: model }) as GpuCount).gpuModel, "", model);
    assert.equal((cleanGpuTelemetry({ ...DETECTED, gpuModel: "x".repeat(64) }) as GpuCount).gpuModel, "x".repeat(64));
    for (const vram of [Number.NaN, Number.POSITIVE_INFINITY, -1, 100_001, null]) assert.equal((cleanGpuTelemetry({ ...DETECTED, gpuVramGb: vram }) as GpuCount).gpuVramGb, -1, String(vram));
    assert.equal((cleanGpuTelemetry({ ...DETECTED, gpuVramGb: 0 }) as GpuCount).gpuVramGb, 0);
    for (const count of [-1, 65, 2.5, "2"]) assert.equal((cleanGpuTelemetry({ ...DETECTED, gpuCount: count }) as GpuCount).gpuCount, -1, String(count));
    assert.equal((cleanGpuTelemetry({ ...DETECTED, gpuCount: 64 }) as GpuCount).gpuCount, 64);
  });

  it("refuses an unknown event, a bad or missing required field, or a body that isn't an object", () => {
    for (const bad of [
      { event: "installed", gpuVendor: "nvidia" },
      { event: "gpu.detected", gpuVendor: "nvidia" },
      { gpuVendor: "nvidia" },
      { event: "detected", gpuVendor: "intel" },
      { event: "detected" },
      { event: "prompt", gpuVendor: "nvidia" },
      { event: "prompt", gpuVendor: "nvidia", answer: "sure" },
      { event: "early_access", gpuVendor: "nvidia", answer: "yes" },
      { event: "early_access", gpuVendor: "amd" },
      { event: "option", option: "cloud" },
      { event: "option" },
      { event: "result", outcome: "ok" },
      { event: "result", path: "this_machine" },
      { event: "result", outcome: "maybe", path: "this_machine" },
      { event: "result", outcome: "ok", path: "gpus" },
      [],
      null,
      "detected",
    ]) {
      assert.equal(typeof cleanGpuTelemetry(bad), "string", JSON.stringify(bad));
    }
    assert.equal(GPU_EVENTS.length, 5);
  });

  it("cleans gpu.* event props to the GPU fields and leaves other events' props alone", () => {
    assert.deepEqual(cleanGpuProps({ gpuVendor: "amd", gpuModel: "Radeon RX 7900 XTX", gpuVramGb: 24.4, gpuCount: 1, answer: "yes", prompt: "secret", model: "x" }), {
      gpuVendor: "amd",
      gpuModel: "Radeon RX 7900 XTX",
      gpuVramGb: 24,
      gpuCount: 1,
      answer: "yes",
    });
    const gpu = cleanEvent({ id: "g1", type: "gpu.result", props: { outcome: "failed", path: "this_machine", errorType: "no_toolkit", turns: 3, model: "m", os: "linux" } }, NOW);
    assert.deepEqual(gpu?.props, { outcome: "failed", path: "this_machine", errorType: "no_toolkit" });
    assert.deepEqual(cleanEvent({ id: "g2", type: "gpu.result", props: { outcome: "ok", path: "endpoint", errorType: "http" } }, NOW)?.props, { outcome: "ok", path: "endpoint" });
    assert.deepEqual(cleanEvent({ id: "s1", type: "session.start", props: { model: "m", os: "linux", gpuVendor: "nvidia" } }, NOW)?.props, { model: "m", os: "linux" });
  });
});

describe("POST /v1/telemetry/gpu", () => {
  it("counts per day with no sign-in, and keeps no IP", async () => {
    const service = await createService();
    const post = (body: unknown, ip = "203.0.113.7") => service.request("POST", "/v1/telemetry/gpu", { body, ip });
    assert.equal((await post(DETECTED)).status, 204);
    assert.equal((await post(DETECTED, "198.51.100.9")).status, 204);
    assert.equal((await post({ event: "option", option: "gpus" })).status, 204);
    assert.equal((await post({ event: "result", outcome: "failed", path: "this_machine" })).status, 204);
    service.clock.now = NOW + DAY;
    assert.equal((await post(DETECTED)).status, 204);

    const today = Math.floor(NOW / DAY);
    const row = { model: "", vram_gb: -1, gpu_count: -1, vendor: "", answer: "", option: "", path: "", outcome: "", error_type: "" };
    const detected = { ...row, event: "detected", vendor: "nvidia", model: "NVIDIA GeForce RTX 4090 (24GB)", vram_gb: 24, gpu_count: 2 };
    assert.deepEqual(
      gpuRows(service).sort((a, b) => Number(a.day) - Number(b.day) || String(a.event).localeCompare(String(b.event))),
      [
        { ...detected, day: today, n: 2 },
        { ...row, day: today, event: "option", option: "gpus", n: 1 },
        { ...row, day: today, event: "result", path: "this_machine", outcome: "failed", error_type: "other", n: 1 },
        { ...detected, day: today + 1, n: 1 },
      ],
    );
    for (const [name, namespace] of Object.entries(service.namespaces)) {
      for (const [key, instance] of (namespace as unknown as { instances: Map<string, { state: { db: DatabaseSync } }> }).instances) {
        assert.doesNotMatch(key, /203\.0\.113\.7|198\.51\.100\.9/, `${name} object name`);
        for (const { name: table } of instance.state.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>) {
          assert.doesNotMatch(JSON.stringify(instance.state.db.prepare(`SELECT * FROM "${table}"`).all()), /203\.0\.113\.7|198\.51\.100\.9/, `${name}.${table}`);
        }
      }
    }
  });

  it("refuses bad values (400), big bodies (413) and other methods, and counts nothing", async () => {
    const service = await createService();
    const bad = await service.request("POST", "/v1/telemetry/gpu", { body: { event: "detected", gpuVendor: "intel" } });
    assert.equal(bad.status, 400);
    assert.equal(await errorCode(bad), "invalid_request");
    assert.equal((await service.request("POST", "/v1/telemetry/gpu", { body: { event: "uninstalled" } })).status, 400);
    assert.equal((await service.request("POST", "/v1/telemetry/gpu", { body: "{not json" })).status, 400);
    assert.equal((await service.request("POST", "/v1/telemetry/gpu", { body: { ...DETECTED, pad: "x".repeat(2000) } })).status, 413);
    assert.equal((await service.request("GET", "/v1/telemetry/gpu")).status, 404);
    assert.deepEqual(gpuRows(service), []);
  });

  it("is rate-limited per IP", async () => {
    const service = await createService();
    const statuses: number[] = [];
    for (let i = 0; i < 62; i++) statuses.push((await service.request("POST", "/v1/telemetry/gpu", { body: DETECTED, ip: "192.0.2.1" })).status);
    assert.deepEqual(statuses.slice(0, 60), Array(60).fill(204));
    assert.equal(statuses[61], 429);
    assert.equal((await service.request("POST", "/v1/telemetry/gpu", { body: DETECTED, ip: "192.0.2.2" })).status, 204, "another address isn't affected");
    assert.equal(gpuRows(service)[0]!.n, 61);
  });

  it("countGpu adds to the same row", async () => {
    const service = await createService();
    const directory = service.directory();
    const count = cleanGpuTelemetry({ event: "early_access", gpuVendor: "amd", answer: "yes" }) as GpuCount;
    for (let i = 0; i < 3; i++) await directory.countGpu(count, 100);
    await directory.countGpu(count, 101);
    assert.deepEqual(
      gpuRows(service).map((row) => [row.day, row.event, row.vendor, row.answer, row.n]),
      [
        [100, "early_access", "amd", "yes", 3],
        [101, "early_access", "amd", "yes", 1],
      ],
    );
  });
});

describe("gpu.* events on /v1/events", () => {
  it("are accepted with their props cleaned", async () => {
    const service = await createService();
    const adminToken = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const token = (await service.signIn({ id: 100, login: "alice" }, { invite: await createInvite(service, adminToken) })).access_token;
    const sent = await service.request("POST", "/v1/events", {
      token,
      body: {
        events: [
          { id: "g1", type: "gpu.detected", props: { gpuVendor: "nvidia", gpuModel: "H100 80GB HBM3", gpuVramGb: 79.6, gpuCount: 8, hostname: "box", path: "/home/alice" } },
          { id: "g2", type: "gpu.prompt", props: { gpuVendor: "nvidia", answer: "yes" } },
          { id: "g3", type: "gpu.option", props: { option: "this_machine" } },
          { id: "g4", type: "gpu.early_access", props: { gpuVendor: "ascend", answer: "no" } },
          { id: "g5", type: "gpu.result", props: { outcome: "failed", path: "this_machine", errorType: "no_fit" } },
          { id: "g6", type: "gpu.unknown", props: {} },
        ],
      },
    });
    assert.equal(sent.status, 202);
    assert.deepEqual(await sent.json(), { accepted: 5 });
    const stored = Object.fromEntries(
      (db(service).prepare("SELECT id, type, props FROM events WHERE github_id = 100 ORDER BY id").all() as Array<{ id: string; type: string; props: string }>).map((row) => [row.id, [row.type, JSON.parse(row.props)]]),
    );
    assert.deepEqual(stored, {
      g1: ["gpu.detected", { gpuVendor: "nvidia", gpuModel: "H100 80GB HBM3", gpuVramGb: 80, gpuCount: 8 }],
      g2: ["gpu.prompt", { gpuVendor: "nvidia", answer: "yes" }],
      g3: ["gpu.option", { option: "this_machine" }],
      g4: ["gpu.early_access", { gpuVendor: "ascend", answer: "no" }],
      g5: ["gpu.result", { outcome: "failed", path: "this_machine", errorType: "no_fit" }],
    });
  });
});

describe("GPUs in the admin CSVs", () => {
  /** NOW is 2026-11-04 12:00 UTC. Counts today and 3 days ago (in 7 days), and 10 days ago (only in 30). */
  async function scenario(): Promise<{ service: Service; cookie: string }> {
    const service = await createService();
    const post = async (body: Record<string, unknown>, times: number, daysAgo = 0) => {
      service.clock.now = NOW - daysAgo * DAY;
      for (let i = 0; i < times; i++) assert.equal((await service.request("POST", "/v1/telemetry/gpu", { body, ip: `192.0.2.${i}` })).status, 204);
    };
    await post({ event: "detected", gpuVendor: "nvidia", gpuVramGb: 24 }, 8);
    await post({ event: "detected", gpuVendor: "nvidia", gpuVramGb: 80 }, 3, 3);
    await post({ event: "detected", gpuVendor: "nvidia", outcome: "probe_timeout" }, 1, 3);
    await post({ event: "detected", gpuVendor: "amd" }, 3);
    await post({ event: "detected", gpuVendor: "ascend" }, 1);
    await post({ event: "detected", gpuVendor: "none" }, 6);
    await post({ event: "detected", gpuVendor: "amd" }, 9, 10);
    await post({ event: "prompt", gpuVendor: "nvidia", answer: "yes" }, 7);
    await post({ event: "prompt", gpuVendor: "nvidia", answer: "no" }, 5);
    await post({ event: "option", option: "gpus" }, 5);
    await post({ event: "option", option: "free" }, 9);
    await post({ event: "option", option: "this_machine" }, 3);
    await post({ event: "option", option: "endpoint" }, 2);
    await post({ event: "early_access", gpuVendor: "amd", answer: "yes" }, 2);
    await post({ event: "early_access", gpuVendor: "ascend", answer: "no" }, 1);
    await post({ event: "result", outcome: "ok", path: "this_machine" }, 2);
    await post({ event: "result", outcome: "failed", path: "this_machine", errorType: "no_toolkit" }, 1);
    await post({ event: "result", outcome: "failed", path: "endpoint", errorType: "unauthorized" }, 2);
    await post({ event: "result", outcome: "failed", path: "endpoint", errorType: "http" }, 1);
    service.clock.now = NOW;
    return { service, cookie: await adminCookie(service) };
  }

  it("counts GPU first runs in the health-gpus CSV over the window", async () => {
    const { service, cookie } = await scenario();
    const csv = (await (await service.request("GET", "/admin/dashboard/health-gpus.csv", { headers: { cookie } })).text()).trim().split("\r\n");
    assert.equal(csv[0], "event,vendor,answer,option,path,outcome,error_type,count");
    assert.ok(csv.includes("detected,nvidia,,,,,,11"), csv.join("\n"));
    assert.ok(csv.includes("detected,nvidia,,,,probe_timeout,,1"), csv.join("\n"));
    assert.ok(csv.includes("result,,,,endpoint,failed,unauthorized,2"));
    // 30 days: the older AMD machines too; 1 day: not the ones 3 days ago.
    const month = (await (await service.request("GET", "/admin/dashboard/health-gpus.csv?days=30", { headers: { cookie } })).text()).trim().split("\r\n");
    assert.ok(month.includes("detected,amd,,,,,,12"), month.join("\n"));
    const today = (await (await service.request("GET", "/admin/dashboard/health-gpus.csv?days=1", { headers: { cookie } })).text()).trim().split("\r\n");
    assert.ok(today.includes("detected,nvidia,,,,,,8"), today.join("\n"));
  });

  it("is just the header when there are none", async () => {
    const service = await createService();
    const cookie = await adminCookie(service);
    assert.equal((await (await service.request("GET", "/admin/dashboard/health-gpus.csv", { headers: { cookie } })).text()).trim(), "event,vendor,answer,option,path,outcome,error_type,count");
  });
});

describe("GPU early-access emails", () => {
  const AMD_YES = { event: "early_access", gpuVendor: "amd", answer: "yes", gpuModel: "AMD Instinct MI300X", gpuVramGb: 192 };
  const leads = (service: Service) =>
    db(service)
      .prepare("SELECT vendor, gpu_model, vram_gb, email, email_norm, at FROM early_access_leads ORDER BY id")
      .all()
      .map((row) => ({ ...row }));
  const post = (service: Service, body: unknown, ip = "203.0.113.7") => service.request("POST", "/v1/telemetry/gpu", { body, ip });

  it("keeps an email only with early_access yes, apart from the counts, which are unchanged", async () => {
    const service = await createService();
    assert.equal((await post(service, { ...AMD_YES, email: " Alice@Example.com " })).status, 204);
    assert.equal((await post(service, { ...AMD_YES, gpuVendor: "ascend", gpuModel: "Ascend 910B3", gpuVramGb: 64 })).status, 204, "a yes with no email");
    for (const body of [
      { ...AMD_YES, answer: "no", email: "no@example.com" },
      { event: "detected", gpuVendor: "amd", email: "detected@example.com" },
      { event: "prompt", gpuVendor: "nvidia", answer: "yes", email: "prompt@example.com" },
      { event: "option", option: "gpus", email: "option@example.com" },
    ]) {
      assert.equal((await post(service, body)).status, 204, JSON.stringify(body));
    }
    assert.deepEqual(leads(service), [{ vendor: "amd", gpu_model: "AMD Instinct MI300X", vram_gb: 192, email: "Alice@Example.com", email_norm: "alice@example.com", at: NOW }]);
    // The anonymous counts are exactly what they were without emails, and hold no address.
    const counts = gpuRows(service).map((row) => [row.event, row.vendor, row.answer, row.n]);
    assert.deepEqual(counts, [
      ["detected", "amd", "", 1],
      ["early_access", "amd", "no", 1],
      ["early_access", "amd", "yes", 1],
      ["early_access", "ascend", "yes", 1],
      ["option", "", "", 1],
      ["prompt", "nvidia", "yes", 1],
    ]);
    assert.doesNotMatch(JSON.stringify(gpuRows(service)), /@/);
    assert.equal(earlyAccessEmail({ ...AMD_YES, email: "a@b.co" }, cleanGpuTelemetry(AMD_YES) as GpuCount), "a@b.co");
  });

  it("drops a malformed or blocked email without failing the count", async () => {
    const service = await createService({ BLOCKED_EMAILS: "@catchall.example" });
    for (const email of ["not-an-email", "a@b", "two words@example.com", `${"x".repeat(250)}@example.com`, 42, "", null, ["a@example.com"], "farm1@catchall.example", "x@sub.catchall.example"]) {
      assert.equal((await post(service, { ...AMD_YES, email })).status, 204, JSON.stringify(email));
    }
    assert.deepEqual(leads(service), []);
    assert.equal(gpuRows(service)[0]!.n, 10, "every one counted");
    // The runtime setting blocks too.
    const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { blockedEmails: ["@another.example"] } })).status, 200);
    assert.equal((await post(service, { ...AMD_YES, email: "x@another.example" })).status, 204);
    assert.equal((await post(service, { ...AMD_YES, email: "fine@example.org" })).status, 204);
    assert.deepEqual(leads(service).map((row) => row.email), ["fine@example.org"]);
  });

  it("keeps one row per inbox and vendor, the latest", async () => {
    const service = await createService();
    await post(service, { ...AMD_YES, email: "bob+gpu@gmail.com", gpuModel: "Radeon RX 7900 XTX", gpuVramGb: 24 });
    service.clock.now = NOW + DAY;
    await post(service, { ...AMD_YES, email: "B.o.b@gmail.com" });
    await post(service, { ...AMD_YES, gpuVendor: "ascend", gpuModel: "Ascend 910B3", gpuVramGb: 64, email: "bob@gmail.com" });
    assert.deepEqual(
      leads(service).map((row) => [row.vendor, row.email, row.email_norm, row.gpu_model, row.vram_gb, row.at]),
      [
        ["amd", "B.o.b@gmail.com", "bob@gmail.com", "AMD Instinct MI300X", 192, NOW + DAY],
        ["ascend", "bob@gmail.com", "bob@gmail.com", "Ascend 910B3", 64, NOW + DAY],
      ],
    );
    assert.equal(gpuRows(service).reduce((sum, row) => sum + Number(row.n), 0), 3, "each still counted");
  });

  it("stays under the per-IP rate limit", async () => {
    const service = await createService();
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await post(service, { ...AMD_YES, email: `p${i}@example.com` }, "192.0.2.50")).status);
    assert.equal(statuses[60], 429);
    assert.equal(leads(service).length, 60);
  });

  it("never logs the email", async () => {
    const service = await createService({ BLOCKED_EMAILS: "@blocked.example" });
    const lines: string[] = [];
    const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    for (const name of Object.keys(original) as Array<keyof typeof original>) {
      console[name] = (...args: unknown[]) => void lines.push(args.map((arg) => (typeof arg === "string" ? arg : (JSON.stringify(arg) ?? String(arg)))).join(" "));
    }
    try {
      await post(service, { ...AMD_YES, email: "zebra-lead@example.com" });
      await post(service, { ...AMD_YES, email: "zebra@blocked.example" });
      await post(service, { ...AMD_YES, email: "zebra not valid" });
      const cookie = await adminCookie(service);
      await service.request("GET", "/admin?view=tools", { headers: { cookie } });
      await service.request("GET", "/admin/dashboard/early-access.csv", { headers: { cookie } });
    } finally {
      Object.assign(console, original);
    }
    assert.doesNotMatch(lines.join("\n"), /zebra/i);
  });

  it("lists leads in the Tools tab, escaped, with a CSV and a copy box, for admins only", async () => {
    const service = await createService();
    await post(service, { ...AMD_YES, email: "carol@example.com" });
    service.clock.now = NOW + DAY;
    await post(service, { ...AMD_YES, gpuVendor: "ascend", gpuModel: "Ascend 910B3", gpuVramGb: 64, email: "<script>x</script>@evil.example" });
    await post(service, { event: "early_access", gpuVendor: "amd", answer: "yes", email: "=cmd@quote.example" });
    const cookie = await adminCookie(service);
    const html = await (await service.request("GET", "/admin?view=tools", { headers: { cookie } })).text();
    const card = /<section class="card" id="leads"[^]*?<\/section>/.exec(html)![0];
    assert.match(card, /<h2>GPU early access<\/h2>/);
    assert.doesNotMatch(card, /<script>/);
    assert.match(card, /<code>&lt;script&gt;x&lt;\/script&gt;@evil\.example<\/code><\/td><td>Ascend<\/td><td>Ascend 910B3<\/td><td class="num">64 GB<\/td><td>2026-11-05<\/td>/);
    assert.match(card, /<code>carol@example\.com<\/code><\/td><td>AMD<\/td><td>AMD Instinct MI300X<\/td><td class="num">192 GB<\/td><td>2026-11-04<\/td>/);
    assert.match(card, /<td>AMD<\/td><td>–<\/td><td class="num">–<\/td>/, "no model or VRAM sent");
    assert.match(card, /href="\/admin\/dashboard\/early-access\.csv" download/);
    assert.match(card, /<textarea class="emails" readonly[^>]*>[^<]*carol@example\.com[^<]*<\/textarea>/);
    assert.ok(card.indexOf("evil.example") < card.indexOf("carol@example.com"), "newest first");

    const csv = await service.request("GET", "/admin/dashboard/early-access.csv", { headers: { cookie } });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
    const lines = (await csv.text()).trim().split("\r\n");
    assert.equal(lines[0], "email,vendor,gpu_model,vram_gb,date");
    assert.ok(lines.includes("carol@example.com,amd,AMD Instinct MI300X,192,2026-11-04"), lines.join("\n"));
    assert.ok(lines.includes("'=cmd@quote.example,amd,,,2026-11-05"), "a spreadsheet doesn't read it as a formula");

    // Admins only.
    assert.equal((await service.request("GET", "/admin/dashboard/early-access.csv")).status, 401);
    const adminToken = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const person = (await service.signIn({ id: 100, login: "alice" }, { invite: await createInvite(service, adminToken) })).access_token;
    assert.equal((await service.request("GET", "/admin/dashboard/early-access.csv", { token: person })).status, 403);
    assert.equal((await service.request("GET", "/admin?view=tools", { token: person })).status, 403);
    const signedOut = await (await service.request("GET", "/admin?view=tools")).text();
    assert.doesNotMatch(signedOut, /carol@example\.com/);
  });

  it("deletes one person's leads on request from the Tools tab", async () => {
    const service = await createService();
    await post(service, { ...AMD_YES, email: "dave+x@gmail.com" });
    await post(service, { ...AMD_YES, gpuVendor: "ascend", email: "dave@gmail.com" });
    await post(service, { ...AMD_YES, email: "erin@example.com" });
    const cookie = await adminCookie(service);
    const done = await tools(service, cookie, { tool: "early-access-delete", email: "D.ave@gmail.com" });
    assert.equal(done.status, 200);
    assert.match(done.html, /Deleted 2 leads\./);
    assert.deepEqual(leads(service).map((row) => row.email), ["erin@example.com"]);
    assert.match((await tools(service, cookie, { tool: "early-access-delete", email: "nobody@example.com" })).html, /No early-access lead has that email\./);
    assert.match((await tools(service, cookie, { tool: "early-access-delete", email: "nope" })).html, /Enter the email to delete\./);
  });
});
