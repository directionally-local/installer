import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, test } from "node:test";
import {
  API_CONTAINER, apiDir, apiStatePath, endpointSnippets, endpointStatus, firstRunApi, hashKey, maskKey, modelApiCommand, PROXY_SOURCE,
  refreshModelApi, TUNNEL_CONTAINER, type ModelApiOptions,
} from "./model-api.js";
import type { LocalModel } from "./laptop/local-agents.js";
import type { FetchModel } from "./model-smoke.js";
import { writeDeployment, type ModelDeployment } from "./state.js";
import type { RunResult } from "./system.js";
import { FakeUiSystem } from "./test-support/fake-open-webui.js";

const STATE = "/state/model.json";
const TUNNEL = "https://quiet-river-1234.trycloudflare.com";

function deployment(port = 8000, context = 65536): ModelDeployment {
  return { id: "qwen-new", repo: "Qwen/Qwen3-Coder-30B", container: "dl-model-1", port, context, image: "vllm/vllm-openai:v0.33.0", flags: [], minVramMiB: 1,
    lastTest: { chat: true, tools: true, json: true, tokensPerSecond: 1, at: "" } };
}

/** Docker, Tailscale and the network as the endpoint uses them; the tunnel prints its URL once started. */
class FakeApiSystem extends FakeUiSystem {
  lan = "192.168.1.42";
  override async probe(command: string, args: string[]): Promise<RunResult> {
    if (command === "ip") return { code: 0, stdout: `1.1.1.1 via 192.168.1.1 dev eth0 src ${this.lan} uid 1000\n`, stderr: "" };
    if (command === "docker" && args[0] === "logs" && args.at(-1) === TUNNEL_CONTAINER) {
      this.calls.push(["docker", ...args].join(" "));
      const running = this.uiContainers.get(TUNNEL_CONTAINER)?.running;
      return { code: running ? 0 : 1, stdout: "", stderr: running ? `INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |\nINF |  ${TUNNEL}  |\n` : "No such container" };
    }
    return super.probe(command, args);
  }
}

/** The proxy refuses a request without a key: it's up. */
const proxyUp: FetchModel = async () => new Response(JSON.stringify({ error: { code: "invalid_api_key" } }), { status: 401 });

async function fixture(model: ModelDeployment | null = deployment()) {
  const system = new FakeApiSystem({ tailscale: true, tailscaleUp: true });
  if (model) await writeDeployment(system, "default", { active: model }, STATE);
  let screen = "";
  const options = (extra: Partial<ModelApiOptions> = {}): ModelApiOptions => ({ system, out: (text) => { screen += text; }, statePath: STATE, user: "1000:1000", fetch: proxyUp, delay: async () => {},
    now: () => new Date("2026-11-21T09:00:00Z"), ...extra });
  const state = () => JSON.parse(system.files.get(apiStatePath(STATE))!.content) as { port: number; keys: Array<{ id: string; name: string; key: string }>; exposure: { mode: string } };
  const proxyArgs = () => system.uiContainers.get(API_CONTAINER)?.args ?? [];
  const runs = () => system.calls.filter((call) => call.startsWith("docker run"));
  return { system, options, state, proxyArgs, runs, screen: () => screen, clear: () => { screen = ""; } };
}

describe("dl model endpoint", () => {
  it("first run: a key (0600), the proxy on 127.0.0.1:8800 in front of the model, and the endpoint screen with the key masked", async () => {
    const { system, options, state, proxyArgs, screen } = await fixture();
    assert.equal(await modelApiCommand("endpoint", [], options()), 0);
    const saved = state();
    assert.equal(saved.port, 8800);
    assert.equal(saved.exposure.mode, "local");
    assert.equal(saved.keys.length, 1);
    assert.match(saved.keys[0]!.key, /^dl-[A-Za-z0-9_-]{32}$/);
    assert.equal(system.files.get(apiStatePath(STATE))!.mode, 0o600);
    // The proxy sees only hashes, never the key.
    const keysFile = system.files.get(join(apiDir(STATE), "keys.json"))!;
    assert.deepEqual(JSON.parse(keysFile.content), { sha256: [hashKey(saved.keys[0]!.key)] });
    assert.ok(!keysFile.content.includes(saved.keys[0]!.key));
    assert.equal(keysFile.mode, 0o600);
    assert.deepEqual(JSON.parse(system.files.get(join(apiDir(STATE), "upstream.json"))!.content), { port: 8000, model: "Qwen/Qwen3-Coder-30B" });
    assert.equal(system.files.get(join(apiDir(STATE), "proxy.mjs"))!.content, PROXY_SOURCE);
    const args = proxyArgs();
    assert.ok(args.includes("DL_API_HOST=127.0.0.1") && args.includes("DL_API_PORT=8800"));
    assert.ok(args.includes(`${apiDir(STATE)}:/dl:ro`), "mounted read-only");
    assert.deepEqual(args.slice(args.indexOf("--user"), args.indexOf("--user") + 2), ["--user", "1000:1000"]);
    assert.ok(args.includes("--read-only") && args.includes("ALL") && args.includes("no-new-privileges"));
    const text = screen();
    assert.match(text, /Your GPU is now an OpenAI-compatible API/);
    assert.match(text, /Base URL {3}http:\/\/127\.0\.0\.1:8800\/v1/);
    assert.match(text, /Model {6}Qwen\/Qwen3-Coder-30B/);
    assert.ok(!text.includes(saved.keys[0]!.key), "masked");
    assert.ok(text.includes(maskKey(saved.keys[0]!.key)));
    assert.match(text, /Reach {6}this machine only/);
    for (const tool of ["Any OpenAI-compatible tool", "export OPENAI_BASE_URL=http://127.0.0.1:8800/v1", "Autopilot", "OpenCode", "Cursor", "Claude Code"]) assert.ok(text.includes(tool), tool);
  });

  it("--show-key prints it in full; a second run keeps the key and the running proxy", async () => {
    const { options, state, runs, screen } = await fixture();
    await modelApiCommand("endpoint", [], options());
    await modelApiCommand("endpoint", [], options({ showKey: true }));
    assert.equal(runs().length, 1, "same settings: the proxy is kept");
    assert.equal(state().keys.length, 1);
    assert.ok(screen().includes(`export DL_MODEL_KEY=${state().keys[0]!.key}`));
  });

  it("no model on the box: says to run dl model up first, and starts nothing", async () => {
    const { options, runs } = await fixture(null);
    await assert.rejects(modelApiCommand("endpoint", [], options()), /No model on this box yet: dl model up/);
    assert.equal(runs().length, 0);
  });

  it("--port: refused when another dl service holds it", async () => {
    const { options } = await fixture();
    await assert.rejects(modelApiCommand("endpoint", [], options({ port: "8001" })), /Port 8001 belongs to model deployment default/);
    await assert.rejects(modelApiCommand("endpoint", [], options({ port: "4800" })), /team chat/);
    assert.equal(await modelApiCommand("endpoint", [], options({ port: "9100" })), 0);
  });

  it("--off stops the proxy and the tunnel and keeps the keys", async () => {
    const { system, options, state } = await fixture();
    await modelApiCommand("endpoint", [], options());
    await modelApiCommand("share", [], options({ public: true }));
    const key = state().keys[0]!.key;
    assert.equal(await modelApiCommand("endpoint", [], options({ off: true })), 0);
    assert.ok(!system.uiContainers.has(API_CONTAINER) && !system.uiContainers.has(TUNNEL_CONTAINER));
    assert.equal(state().keys[0]!.key, key);
    assert.equal(state().exposure.mode, "local");
  });
});

describe("dl model share", () => {
  it("--lan: the proxy restarts on 0.0.0.0 (the model doesn't), the LAN address and a warning", async () => {
    const { options, proxyArgs, screen, state, system } = await fixture();
    await modelApiCommand("endpoint", [], options());
    assert.equal(await modelApiCommand("share", [], options({ lan: true })), 0);
    assert.ok(proxyArgs().includes("DL_API_HOST=0.0.0.0"));
    assert.equal(state().exposure.mode, "lan");
    assert.match(screen(), /Base URL {3}http:\/\/192\.168\.1\.42:8800\/v1/);
    assert.match(screen(), /every network interface/);
    assert.ok(!system.calls.some((call) => call.includes("dl-model-1") && call.startsWith("docker rm")), "the model is never touched");
  });

  it("--tailscale: tailscale serve on the tailnet (HTTPS 8443, clear of the chat's 443), proxy on loopback", async () => {
    const { system, options, proxyArgs, screen, state } = await fixture();
    system.dnsName = "gpu-box.tail1234.ts.net.";
    assert.equal(await modelApiCommand("share", [], options({ tailscale: true })), 0, "turns the endpoint on first when needed");
    assert.equal(system.served.get(8443), "http://127.0.0.1:8800");
    assert.ok(proxyArgs().includes("DL_API_HOST=127.0.0.1"));
    assert.deepEqual(state().exposure, { mode: "tailscale", httpsPort: 8443, url: "https://gpu-box.tail1234.ts.net:8443" });
    assert.match(screen(), /Base URL {3}https:\/\/gpu-box\.tail1234\.ts\.net:8443\/v1/);
    assert.ok(!system.calls.some((call) => call.includes("funnel")));
  });

  it("--tailscale without Tailscale signed in: says what to do and changes nothing", async () => {
    const { system, options, state } = await fixture();
    system.tailscaleUp = false;
    assert.equal(await modelApiCommand("share", [], options({ tailscale: true })), 1);
    assert.equal(state().exposure.mode, "local");
    assert.equal(system.served.size, 0);
  });

  it("--public: a Cloudflare quick tunnel, its URL, and a clear warning; --off takes it down", async () => {
    const { system, options, screen, state, clear, proxyArgs } = await fixture();
    assert.equal(await modelApiCommand("share", [], options({ public: true })), 0);
    const tunnel = system.uiContainers.get(TUNNEL_CONTAINER)!;
    assert.ok(tunnel.args.includes("http://127.0.0.1:8800") && tunnel.args.some((arg) => arg.startsWith("cloudflare/cloudflared:2026.10.7@sha256:")));
    assert.ok(proxyArgs().includes("DL_API_HOST=127.0.0.1"), "only the tunnel reaches it from outside");
    assert.match(screen(), new RegExp(`Base URL {3}${TUNNEL}/v1`));
    assert.match(screen(), /PUBLIC: anyone on the internet with this URL/);
    assert.match(screen(), /no Server-Sent Events/);
    clear();
    assert.equal(await modelApiCommand("share", [], options({ off: true })), 0);
    assert.ok(!system.uiContainers.has(TUNNEL_CONTAINER));
    assert.equal(state().exposure.mode, "local");
    assert.match(screen(), /back to this machine only/);
  });

  it("from the tailnet to the LAN: tailscale serve is turned off", async () => {
    const { system, options } = await fixture();
    await modelApiCommand("share", [], options({ tailscale: true }));
    await modelApiCommand("share", [], options({ lan: true }));
    assert.equal(system.served.size, 0);
  });

  it("exactly one of --lan, --tailscale, --public, --off", async () => {
    const { options } = await fixture();
    assert.equal(await modelApiCommand("share", [], options()), 2);
    assert.equal(await modelApiCommand("share", [], options({ lan: true, public: true })), 2);
    assert.equal(await modelApiCommand("endpoint", [], options({ lan: true })), 2);
  });
});

describe("dl model keys", () => {
  it("add, list (masked), revoke: the proxy's hashes change at once, without restarting anything", async () => {
    const { system, options, state, runs, screen, clear } = await fixture();
    await modelApiCommand("endpoint", [], options());
    clear();
    assert.equal(await modelApiCommand("keys", ["add", "laptop"], options()), 0);
    const added = state().keys.find((key) => key.name === "laptop")!;
    assert.ok(screen().includes(added.key), "a new key is shown in full once");
    const hashes = () => (JSON.parse(system.files.get(join(apiDir(STATE), "keys.json"))!.content) as { sha256: string[] }).sha256;
    assert.equal(hashes().length, 2);
    clear();
    await modelApiCommand("keys", [], options());
    assert.ok(!screen().includes(added.key) && screen().includes(maskKey(added.key)) && screen().includes("laptop"));
    assert.equal(await modelApiCommand("keys", ["revoke", added.id], options()), 0);
    assert.deepEqual(hashes(), [hashKey(state().keys[0]!.key)]);
    assert.equal(runs().length, 1, "only the first start ran a container");
    assert.equal(await modelApiCommand("keys", ["revoke", "nope"], options()), 1);
    assert.equal(await modelApiCommand("keys", ["add", "default"], options()), 1, "names are unique");
    assert.equal(await modelApiCommand("keys", ["add", "bad name;"], options()), 2);
  });
});

test("the endpoint follows the model: up/update/down rewrite upstream.json; status says where it's reachable", async () => {
  const { system, options } = await fixture();
  await refreshModelApi(system, STATE);
  assert.ok(!system.files.has(join(apiDir(STATE), "upstream.json")), "nothing without an endpoint");
  assert.deepEqual(await endpointStatus(system, STATE), { ok: true, text: "off · dl model endpoint" });
  await modelApiCommand("endpoint", [], options());
  await writeDeployment(system, "default", { active: deployment(8001) }, STATE);
  await refreshModelApi(system, STATE);
  assert.equal(JSON.parse(system.files.get(join(apiDir(STATE), "upstream.json"))!.content).port, 8001);
  assert.deepEqual(await endpointStatus(system, STATE), { ok: true, text: "http://127.0.0.1:8800/v1 · this machine only · 1 key" });
  await writeDeployment(system, "default", undefined, STATE);
  await refreshModelApi(system, STATE);
  assert.ok(!system.files.has(join(apiDir(STATE), "upstream.json")), "no model: the proxy answers 503");
});

test("snippets: Claude Code only where dl already runs it on this model (Messages API, 32k context)", () => {
  const model: LocalModel = { name: "default", model: "Qwen/Qwen3-Coder-30B", baseUrl: "http://127.0.0.1:8000/v1", context: 65536, output: 16384, engine: "vllm", image: "vllm/vllm-openai:v0.33.0" };
  const titles = (m: LocalModel) => endpointSnippets("https://x.example/v1", m).map((snippet) => snippet.title);
  assert.deepEqual(titles(model), ["Any OpenAI-compatible tool", "Autopilot", "OpenCode (opencode.json)", "Cursor", "Claude Code"]);
  assert.ok(!titles({ ...model, context: 16384 }).includes("Claude Code"));
  assert.ok(!titles({ ...model, image: "vllm/vllm-openai:v0.10.0" }).includes("Claude Code"));
  const claude = endpointSnippets("https://x.example/v1", model).at(-1)!.lines.join("\n");
  assert.match(claude, /ANTHROPIC_BASE_URL=https:\/\/x\.example ANTHROPIC_AUTH_TOKEN=\$DL_MODEL_KEY/);
  const opencode = JSON.parse(endpointSnippets("https://x.example/v1", model)[2]!.lines.join("\n"));
  assert.deepEqual(opencode.provider["dl-local"].options, { baseURL: "https://x.example/v1", apiKey: "{env:DL_MODEL_KEY}" });
});

test("the first run's API endpoint never throws: a failure says what to run", async () => {
  const { options, screen } = await fixture(null);
  const result = await firstRunApi(options());
  assert.equal(result.ok, false);
  assert.match(screen(), /No model on this box yet[\s\S]*dl model endpoint tries again/);
  const ok = await (await fixture()).options;
  assert.deepEqual(await firstRunApi(ok()), { ok: true, baseUrl: "http://127.0.0.1:8800/v1" });
});

// ── The proxy itself, run with Node against a fake engine ──────────────────

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function freePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("the proxy: /v1 only, a key from keys.json (Bearer or x-api-key) checked on every request, forwarded without it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dl-api-proxy-"));
  const seen: Array<{ method?: string; url?: string; headers: IncomingHttpHeaders; body: string }> = [];
  const engine = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: {\"a\":1}\n\n");
        setTimeout(() => res.end("data: [DONE]\n\n"), 20);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "Qwen/Qwen3-Coder-30B" }] }));
    });
  });
  const enginePort = await listen(engine);
  const port = await freePort();
  await writeFile(join(dir, "proxy.mjs"), PROXY_SOURCE);
  await writeFile(join(dir, "keys.json"), JSON.stringify({ sha256: [hashKey("dl-good"), hashKey("dl-other")] }));
  await writeFile(join(dir, "upstream.json"), JSON.stringify({ port: enginePort }));
  const child = spawn(process.execPath, [join(dir, "proxy.mjs")], { env: { ...process.env, DL_API_DIR: dir, DL_API_HOST: "127.0.0.1", DL_API_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  try {
    for (let i = 0; i < 100 && !logs.includes("listening"); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    const base = `http://127.0.0.1:${port}`;
    const call = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, init);
    assert.equal((await call("/v1/models")).status, 401);
    assert.equal((await call("/v1/models", { headers: { authorization: "Bearer dl-wrong" } })).status, 401);
    const ok = await call("/v1/models", { headers: { authorization: "Bearer dl-good" } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { data: [{ id: "Qwen/Qwen3-Coder-30B" }] });
    assert.equal(seen.at(-1)!.headers.authorization, undefined, "the key never reaches the engine");
    assert.equal((await call("/v1/messages", { method: "POST", headers: { "x-api-key": "dl-other", "content-type": "application/json" }, body: "{}" })).status, 200, "Anthropic-style clients");
    assert.equal(seen.at(-1)!.headers["x-api-key"], undefined);
    // Streaming passes through as it comes.
    const stream = await call("/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer dl-good", "content-type": "application/json" }, body: JSON.stringify({ stream: true }) });
    assert.equal(stream.headers.get("content-type"), "text/event-stream");
    assert.equal(await stream.text(), "data: {\"a\":1}\n\ndata: [DONE]\n\n");
    assert.equal(seen.at(-1)!.body, JSON.stringify({ stream: true }));
    // Nothing outside /v1, even with a key: engine admin and metrics endpoints stay private.
    const before = seen.length;
    for (const path of ["/metrics", "/invocations", "/update_weights_from_disk", "/v1/../metrics", "/v1/%2e%2e/metrics", "/v1x"]) {
      assert.equal((await call(path, { method: "POST", headers: { authorization: "Bearer dl-good" } })).status, 404, path);
    }
    assert.equal((await call("/v1/models", { method: "DELETE", headers: { authorization: "Bearer dl-good" } })).status, 405);
    assert.equal(seen.length, before);
    // Revoked: refused on the very next request, without a restart.
    await writeFile(join(dir, "keys.json"), JSON.stringify({ sha256: [hashKey("dl-other")] }));
    assert.equal((await call("/v1/models", { headers: { authorization: "Bearer dl-good" } })).status, 401);
    // No model: 503 with what to do.
    await rm(join(dir, "upstream.json"));
    const none = await call("/v1/models", { headers: { authorization: "Bearer dl-other" } });
    assert.equal(none.status, 503);
    assert.match(await none.text(), /dl model up/);
    assert.ok(!logs.includes("dl-good") && !logs.includes("dl-other"), "the log has no keys");
  } finally {
    child.kill();
    engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});
