import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { boxSummary } from "./box-status.js";
import { main } from "./cli.js";
import { writeDeployment, type InstallState, type ModelDeployment } from "./state.js";
import { parseTailscaleState } from "./tailscale.js";
import { FakeOpenWebUi, FakeUiSystem } from "./test-support/fake-open-webui.js";

const STATE = "/state/model.json";
const UI_STATE = "/state/ui.json";

function deployment(id: string, port: number): ModelDeployment {
  return { id, repo: `org/${id}`, container: `dl-model-${port}`, port, context: 8192, image: "vllm/vllm-openai:v0.33.0", flags: [], minVramMiB: 1,
    lastTest: { chat: true, tools: true, json: true, tokensPerSecond: 1, at: "" } };
}

/** A GPU box: models that answer on /v1/models when their container runs, and Open WebUI. */
function box(tailscale: { installed?: boolean; up?: boolean; certs?: boolean } = { installed: true, up: true }) {
  const system = new FakeUiSystem({ tailscale: tailscale.installed ?? false, tailscaleUp: tailscale.up ?? false });
  system.httpsCerts = tailscale.certs ?? true;
  const webui = new FakeOpenWebUi();
  const answering = new Set<number>();
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const { port, pathname } = new URL(url);
    if (pathname === "/v1/models") return answering.has(Number(port)) ? new Response("{}", { status: 200 }) : Promise.reject(new Error("ECONNREFUSED"));
    return webui.fetch(url, init);
  };
  const run = (name: string) => system.uiContainers.set(name, { running: true, spec: "x", args: [] });
  const summary = (serverState?: InstallState) => boxSummary({ system, statePath: STATE, fetch, ...(serverState ? { serverState } : {}) });
  return { system, webui, answering, run, summary };
}

test("not a GPU box (a laptop): nothing to say, and nothing probed", async () => {
  const { system, summary } = box();
  assert.equal(await summary(), undefined);
  assert.deepEqual(system.calls, []);
});

test("a GPU box with the model, the shared chat, sign-ups waiting and Tailscale ready", async () => {
  const { system, webui, answering, run, summary } = box();
  await writeDeployment(system, "default", { active: deployment("qwen-new", 8000) }, STATE);
  answering.add(8000);
  run("dl-model-8000");
  run("dl-ui");
  webui.add("me@acme.com", "Me", "pw", "admin");
  const key = webui.apiKey("me@acme.com");
  webui.add("p1@acme.com", "P1", "pw", "pending");
  webui.add("p2@acme.com", "P2", "pw", "pending");
  await system.writeFile(UI_STATE, JSON.stringify({ version: 2, port: 4800, adminApiKey: key, share: { mode: "tailscale", url: "https://box.tail1234.ts.net", httpsPort: 443 } }));
  assert.equal(await summary(), `
  This GPU box
  ✓ Model         qwen-new · port 8000 · healthy
  · Coding agent  Autopilot (default) · dl agent to change
  ✓ Team chat     running · https://box.tail1234.ts.net · 2 waiting for approval
  · Agent server  none · dl opens the agent in this terminal
  ✓ Tailscale     signed in as box · HTTPS on

`);
});

test("without an admin API key the waiting count is left out (dl never signs in with a password)", async () => {
  const { system, webui, answering, run, summary } = box();
  await writeDeployment(system, "default", { active: deployment("qwen-new", 8000) }, STATE);
  answering.add(8000);
  run("dl-model-8000");
  run("dl-ui");
  webui.add("p1@acme.com", "P1", "pw", "pending");
  await system.writeFile(UI_STATE, JSON.stringify({ version: 2, port: 4800 }));
  const text = (await summary())!;
  assert.match(text, /✓ Team chat {5}running · http:\/\/127\.0\.0\.1:4800 · this machine only\n/);
  assert.ok(!text.includes("waiting"));
  assert.ok(!webui.requests.some((request) => request.path.startsWith("/api/v1/auths")));
});

test("several models, one not answering and one stopped; chat stopped; server install; Tailscale states", async () => {
  const { system, run, answering, summary } = box({ installed: true, up: true, certs: false });
  await writeDeployment(system, "default", { active: deployment("qwen-new", 8000) }, STATE);
  await writeDeployment(system, "big", { active: deployment("glm", 8002) }, STATE);
  await system.writeFile("/state/agent.json", JSON.stringify({ version: 1, agent: "pi", at: "" }));
  run("dl-model-8000");
  answering.add(8002);
  await system.writeFile(UI_STATE, JSON.stringify({ version: 2, port: 4800 }));
  const server: InstallState = { version: 1, installedAt: "", updatedAt: "", release: "", autopilotVersion: "", hotcellVersion: "", image: "", access: { mode: "tailscale", url: "https://box.tail1234.ts.net" } };
  assert.equal(await summary(server), `
  This GPU box
  ✗ Model big      glm · port 8002 · stopped · dl model status
  ✗ Model default  qwen-new · port 8000 · not answering · dl model status
  · Coding agent   Pi on the model · dl agent to change
  ✗ Team chat      stopped · dl ui up
  ✓ Agent server   installed (dl up) · https://box.tail1234.ts.net
  ✗ Tailscale      signed in · HTTPS certificates off (https://login.tailscale.com/admin/dns)

`);
  const missing = box({ installed: false });
  await writeDeployment(missing.system, "default", { active: deployment("qwen-new", 8000) }, STATE);
  assert.match((await missing.summary())!, /· Team chat {5}not set up · dl ui up\n.*· Tailscale {5}not installed\n/s);
  const out = box({ installed: true, up: false });
  await writeDeployment(out.system, "default", { active: deployment("qwen-new", 8000) }, STATE);
  assert.match((await out.summary())!, /· Tailscale {5}not signed in\n/);
});

test("dl status and plain dl print the summary first; dl --brief and a laptop don't", async () => {
  // A laptop with nothing set up: its own config, in a temporary directory.
  const root = await mkdtemp(join(tmpdir(), "dl-box-status-"));
  const previous = { remotes: process.env.AUTOPILOT_REMOTES_FILE, xdg: process.env.XDG_CONFIG_HOME };
  process.env.AUTOPILOT_REMOTES_FILE = join(root, "remotes.json");
  process.env.XDG_CONFIG_HOME = join(root, "config");
  try { await printsSummaryFirst(); } finally {
    for (const [key, value] of [["AUTOPILOT_REMOTES_FILE", previous.remotes], ["XDG_CONFIG_HOME", previous.xdg]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

async function printsSummaryFirst(): Promise<void> {
  const summary = async () => "\n  This GPU box\n  ✓ Model  qwen-new\n\n";
  const laptopIo = () => { let text = ""; return { io: { out: (chunk: string) => { text += chunk; }, err: (chunk: string) => { text += chunk; } }, text: () => text }; };
  const status = laptopIo();
  await main(["status"], status.io, { terminal: false, serverState: async () => undefined, boxSummary: summary, autopilotAuth: async () => undefined, freeTierAccount: async () => undefined });
  assert.ok(status.text().startsWith("\n  This GPU box\n"), status.text());
  const bare = laptopIo();
  await main([], bare.io, { terminal: false, serverState: async () => undefined, boxSummary: summary, autopilotAuth: async () => undefined, freeTierAccount: async () => undefined });
  assert.ok(bare.text().startsWith("\n  This GPU box\n"));
  const brief = laptopIo();
  await main(["--brief"], brief.io, { terminal: false, serverState: async () => undefined, boxSummary: summary });
  assert.ok(!brief.text().includes("This GPU box"));
  const laptop = laptopIo();
  await main(["status"], laptop.io, { terminal: false, serverState: async () => undefined, boxSummary: async () => undefined, autopilotAuth: async () => undefined, freeTierAccount: async () => undefined });
  assert.ok(!laptop.text().includes("This GPU box"));
}

test("Tailscale's state from its status: logged out, HTTPS certificates off, ready", () => {
  assert.deepEqual(parseTailscaleState('{"BackendState":"NeedsLogin"}'), { state: "logged-out" });
  assert.deepEqual(parseTailscaleState("not json"), { state: "logged-out" });
  assert.deepEqual(parseTailscaleState('{"BackendState":"Running","Self":{"DNSName":"box.tail1.ts.net."},"CertDomains":null}'), { state: "no-https", name: "box.tail1.ts.net" });
  assert.deepEqual(parseTailscaleState('{"BackendState":"Running","Self":{"DNSName":"box.tail1.ts.net."},"CertDomains":["other.tail1.ts.net"]}'), { state: "no-https", name: "box.tail1.ts.net" });
  assert.deepEqual(parseTailscaleState('{"BackendState":"Running","Self":{"DNSName":"box.tail1.ts.net."},"CertDomains":["box.tail1.ts.net"]}'), { state: "ready", name: "box.tail1.ts.net" });
  assert.deepEqual(parseTailscaleState('{"BackendState":"Running","Self":{"DNSName":""}}'), { state: "no-https" }, "no MagicDNS name");
});
