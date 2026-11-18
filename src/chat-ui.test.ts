import assert from "node:assert/strict";
import { test } from "node:test";
import { chatUiCommand, lanAddress, OPEN_WEBUI_IMAGE, uiDockerArgs, UI_PORT, validEmail, generatePassword, type ChatUiOptions } from "./chat-ui.js";
import { bareListen, main } from "./cli.js";
import { writeDeployment, type ModelDeployment } from "./state.js";
import { FakeOpenWebUi, FakeUiSystem } from "./test-support/fake-open-webui.js";
import { PlainUi } from "./ui.js";
import type { Prompter } from "./prompt.js";

const STATE = "/state/model.json";
const UI_STATE = "/state/ui.json";

function deployment(id: string, port: number): ModelDeployment {
  return { id, repo: `org/${id}`, container: `dl-model-${port}`, port, context: 8192, image: "vllm/vllm-openai:v0.33.0", flags: [], minVramMiB: 1,
    lastTest: { chat: true, tools: true, json: true, tokensPerSecond: 1, at: "" } };
}

function fixture(tailscale: { installed?: boolean; up?: boolean } = {}) {
  const system = new FakeUiSystem({ tailscale: tailscale.installed ?? false, tailscaleUp: tailscale.up ?? false });
  const webui = new FakeOpenWebUi();
  const lines: string[] = [];
  const answers: string[] = [];
  const prompter: Prompter = { choose: async () => "", select: async (_q, choices) => ({ value: choices[0]!.value }), secret: async () => "", text: async () => answers.shift() ?? "" };
  const options = (extra: Partial<ChatUiOptions> = {}): ChatUiOptions => ({ system, ui: new PlainUi((line) => lines.push(line)), prompter, interactive: false,
    statePath: STATE, fetch: webui.fetch, delay: async () => {}, interfaces: () => ({ lo: [{ address: "127.0.0.1", family: "IPv4", internal: true, netmask: "", mac: "", cidr: null }],
      docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false, netmask: "", mac: "", cidr: null }],
      eth0: [{ address: "192.168.1.20", family: "IPv4", internal: false, netmask: "", mac: "", cidr: null }] }), ...extra });
  const output = () => lines.join("");
  const uiState = () => JSON.parse(system.files.get(UI_STATE)!.content);
  const env = () => {
    const args = system.uiContainers.get("dl-ui")!.args;
    return Object.fromEntries(args.flatMap((arg, i) => args[i - 1] === "-e" ? [[arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]] : []));
  };
  return { system, webui, lines, answers, options, output, uiState, env };
}

test("up runs pinned Open WebUI on localhost with a volume, restart policy and every dl model endpoint", async () => {
  const { system, options, env, output } = fixture();
  await writeDeployment(system, "default", { active: deployment("qwen", 8000) }, STATE);
  await writeDeployment(system, "big", { active: deployment("glm", 8002) }, STATE);
  assert.equal(await chatUiCommand("up", [], options({ adminEmail: "Admin@Example.com" })), 0);
  const args = system.uiContainers.get("dl-ui")!.args;
  assert.equal(args.at(-1), OPEN_WEBUI_IMAGE);
  assert.match(OPEN_WEBUI_IMAGE, /^ghcr\.io\/open-webui\/open-webui:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
  assert.ok(system.calls.includes(`docker pull ${OPEN_WEBUI_IMAGE}`));
  assert.deepEqual(args.slice(args.indexOf("--restart"), args.indexOf("--restart") + 2), ["--restart", "unless-stopped"]);
  assert.ok(args.includes("dl-ui-data:/app/backend/data"));
  assert.ok(args.includes("--network") && args.includes("host"), "reaches the models on the host's 127.0.0.1");
  assert.ok(!args.includes("-p"), "no published port: Open WebUI binds HOST itself");
  const e = env();
  assert.equal(e.HOST, "127.0.0.1");
  assert.equal(e.PORT, String(UI_PORT));
  assert.equal(e.OPENAI_API_BASE_URLS, "http://127.0.0.1:8002/v1;http://127.0.0.1:8000/v1");
  assert.equal(e.OPENAI_API_KEYS, "dl-local;dl-local");
  assert.equal(e.ENABLE_OLLAMA_API, "false");
  assert.equal(e.ENABLE_SIGNUP, "true");
  assert.equal(e.DEFAULT_USER_ROLE, "pending");
  assert.equal(e.ENABLE_WEB_SEARCH, "false");
  assert.equal(e.ENABLE_IMAGE_GENERATION, "false");
  assert.equal(e.OFFLINE_MODE, "true");
  assert.equal(e.ENABLE_VERSION_UPDATE_CHECK, "false");
  assert.equal(e.ENABLE_PERSISTENT_CONFIG, "false");
  assert.equal(e.WEBUI_URL, `http://127.0.0.1:${UI_PORT}`);
  assert.equal(e.WEBUI_SECRET_KEY_FILE, "/app/backend/data/.webui_secret_key");
  assert.ok(!Object.keys(e).some((name) => /PASSWORD|ADMIN_EMAIL/.test(name)), "no credentials in the container's environment");
  assert.match(output(), /this machine only/);
});

test("the first up creates the admin through Open WebUI's API, shows the password once and keeps it 0600", async () => {
  const { system, webui, options, output, uiState } = fixture();
  await chatUiCommand("up", [], options({ adminEmail: "admin@example.com" }));
  assert.equal(webui.users.length, 1);
  assert.equal(webui.users[0]!.role, "admin");
  assert.equal(webui.users[0]!.email, "admin@example.com");
  const state = uiState();
  assert.equal(state.adminPassword, webui.users[0]!.password);
  assert.equal(state.adminCreated, true);
  assert.equal(system.files.get(UI_STATE)!.mode, 0o600);
  assert.ok(output().includes(`password ${state.adminPassword}`));
  // Open WebUI turns sign-ups off after its first account; the restart brings dl's settings back.
  assert.ok(system.calls.includes("docker restart dl-ui"));
});

test("up again keeps the running container and doesn't show the password", async () => {
  const { system, webui, options, lines, uiState } = fixture();
  await chatUiCommand("up", [], options({ adminEmail: "admin@example.com" }));
  const runs = () => system.calls.filter((call) => call.startsWith("docker run")).length;
  lines.length = 0;
  assert.equal(await chatUiCommand("up", [], options()), 0);
  assert.equal(runs(), 1);
  assert.equal(webui.users.length, 1);
  assert.ok(!lines.join("").includes(uiState().adminPassword));
  assert.match(lines.join(""), /Team chat is running/);
  // A new model replaces the container so Open WebUI sees it; the volume keeps accounts.
  await writeDeployment(system, "default", { active: deployment("qwen", 8000) }, STATE);
  await chatUiCommand("up", [], options());
  assert.equal(runs(), 2);
  assert.ok(system.calls.includes("docker rm -f dl-ui"));
});

test("up asks for the admin's email on a terminal and refuses a bad one or none", async () => {
  const { options, answers, webui } = fixture();
  await assert.rejects(chatUiCommand("up", [], options()), /--admin-email/);
  await assert.rejects(chatUiCommand("up", [], options({ adminEmail: "not-an-email" })), /isn't an email address/);
  answers.push("me@example.com");
  assert.equal(await chatUiCommand("up", [], options({ interactive: true })), 0);
  assert.equal(webui.users[0]!.email, "me@example.com");
});

test("up refuses data with accounts dl has no admin for (never signs up as a pending user)", async () => {
  const { options, webui } = fixture();
  webui.add("old@example.com", "Old", "secret", "admin");
  await assert.rejects(chatUiCommand("up", [], options({ adminEmail: "admin@example.com" })), /already has accounts.*dl ui down --purge/s);
  assert.equal(webui.users.length, 1);
});

test("--listen binds every address with a warning; a port that a model holds is refused", async () => {
  const { system, options, env, output } = fixture();
  await writeDeployment(system, "default", { active: deployment("qwen", 8000) }, STATE);
  await assert.rejects(chatUiCommand("up", [], options({ adminEmail: "a@example.com", port: "8001" })), /belongs to model deployment default/);
  await chatUiCommand("up", [], options({ adminEmail: "a@example.com", listen: "0.0.0.0", port: "4900" }));
  assert.equal(env().HOST, "0.0.0.0");
  assert.equal(env().PORT, "4900");
  assert.match(output(), /reachable on the network: 0\.0\.0\.0:4900/);
  await assert.rejects(chatUiCommand("up", [], options({ listen: "my-laptop" })), /--listen takes an IP address/);
});

test("bare --listen means 0.0.0.0; an address after it is kept", () => {
  assert.deepEqual(bareListen(["ui", "up", "--listen"]), ["ui", "up", "--listen=0.0.0.0"]);
  assert.deepEqual(bareListen(["ui", "--listen", "up"]), ["ui", "--listen=0.0.0.0", "up"]);
  assert.deepEqual(bareListen(["ui", "up", "--listen", "--port", "5000"]), ["ui", "up", "--listen=0.0.0.0", "--port", "5000"]);
  assert.deepEqual(bareListen(["ui", "up", "--listen", "192.168.1.20"]), ["ui", "up", "--listen", "192.168.1.20"]);
});

test("share with Tailscale serves HTTPS on the tailnet name, prints one link and points WEBUI_URL at it", async () => {
  const { system, options, lines, env, uiState } = fixture({ installed: true, up: true });
  await chatUiCommand("up", [], options({ adminEmail: "a@example.com" }));
  lines.length = 0;
  assert.equal(await chatUiCommand("share", [], options()), 0);
  assert.ok(system.calls.includes(`tailscale serve --bg --https=443 http://127.0.0.1:${UI_PORT}`));
  assert.equal(system.served.get(443), `http://127.0.0.1:${UI_PORT}`);
  const links = lines.join("").match(/https?:\/\/[^\s;]+/g) ?? [];
  assert.deepEqual([...new Set(links)], ["https://box.tail1234.ts.net"]);
  assert.equal(env().WEBUI_URL, "https://box.tail1234.ts.net");
  assert.deepEqual(uiState().share, { mode: "tailscale", url: "https://box.tail1234.ts.net", httpsPort: 443 });
  // Again: the same port, the same link, nothing restarted.
  const runs = system.calls.filter((call) => call.startsWith("docker run")).length;
  assert.equal(await chatUiCommand("share", [], options()), 0);
  assert.equal(system.calls.filter((call) => call.startsWith("docker run")).length, runs);
  assert.deepEqual([...system.served.keys()], [443]);
  assert.ok(!system.calls.some((call) => call.includes("funnel")), "never tailscale funnel");
});

test("share leaves the server's agent API on 443 alone and uses 8443", async () => {
  const { system, options, output } = fixture({ installed: true, up: true });
  system.served.set(443, "http://127.0.0.1:4096");
  await chatUiCommand("up", [], options({ adminEmail: "a@example.com" }));
  await chatUiCommand("share", [], options());
  assert.equal(system.served.get(443), "http://127.0.0.1:4096");
  assert.equal(system.served.get(8443), `http://127.0.0.1:${UI_PORT}`);
  assert.match(output(), /https:\/\/box\.tail1234\.ts\.net:8443/);
});

test("share refuses a port Funnel makes public, and never runs funnel itself", async () => {
  const { system, options } = fixture({ installed: true, up: true });
  // Someone ran tailscale funnel on Open WebUI's port by hand.
  system.served.set(443, `http://127.0.0.1:${UI_PORT}`);
  system.funnel.add(443);
  await chatUiCommand("up", [], options({ adminEmail: "a@example.com" }));
  await assert.rejects(chatUiCommand("share", [], options()), /Funnel is on for HTTPS port 443/);
  assert.ok(!system.calls.some((call) => /^tailscale (serve --bg|funnel)/.test(call)));
});

test("share falls back to Tailscale's older serve syntax", async () => {
  const { system, options } = fixture({ installed: true, up: true });
  system.oldTailscale = true;
  await chatUiCommand("up", [], options({ adminEmail: "a@example.com" }));
  await chatUiCommand("share", [], options());
  assert.ok(system.calls.includes(`tailscale serve https:443 / http://127.0.0.1:${UI_PORT}`));
  assert.equal(system.served.get(443), `http://127.0.0.1:${UI_PORT}`);
});

test("share explains a Tailscale HTTPS failure", async () => {
  const { system, options } = fixture({ installed: true, up: true });
  system.serveFails = true;
  await chatUiCommand("up", [], options({ adminEmail: "a@example.com" }));
  await assert.rejects(chatUiCommand("share", [], options()), /HTTPS certificates at https:\/\/login\.tailscale\.com\/admin\/dns/);
});

test("share without Tailscale and without --listen says what to do and prints no link", async () => {
  const { system, options, lines } = fixture();
  await chatUiCommand("up", [], options({ adminEmail: "a@example.com" }));
  lines.length = 0;
  assert.equal(await chatUiCommand("share", [], options()), 1);
  assert.match(lines.join(""), /not installed/);
  assert.match(lines.join(""), /dl ui up --listen/);
  assert.ok(!/https?:\/\//.test(lines.join("")));
  assert.ok(!system.calls.some((call) => call.startsWith("tailscale serve")));
});

test("share without Tailscale but with --listen prints the LAN link", async () => {
  const { options, lines, env } = fixture({ installed: true, up: false });
  await chatUiCommand("up", [], options({ adminEmail: "a@example.com", listen: "0.0.0.0" }));
  lines.length = 0;
  assert.equal(await chatUiCommand("share", [], options()), 0);
  assert.match(lines.join(""), /not logged in/);
  const links = lines.join("").match(/https?:\/\/[^\s;]+/g) ?? [];
  assert.deepEqual([...new Set(links)], [`http://192.168.1.20:${UI_PORT}`]);
  assert.equal(env().WEBUI_URL, `http://192.168.1.20:${UI_PORT}`);
});

test("share --off stops serving and points WEBUI_URL back at this machine", async () => {
  const { system, options, env, uiState } = fixture({ installed: true, up: true });
  await chatUiCommand("up", [], options({ adminEmail: "a@example.com" }));
  await chatUiCommand("share", [], options());
  assert.equal(await chatUiCommand("share", [], options({ off: true })), 0);
  assert.equal(system.served.size, 0);
  assert.ok(system.calls.includes(`tailscale serve --https=443 http://127.0.0.1:${UI_PORT} off`));
  assert.equal(uiState().share, undefined);
  assert.equal(env().WEBUI_URL, `http://127.0.0.1:${UI_PORT}`);
  assert.ok(!system.calls.some((call) => call.includes("funnel")));
});

test("invite creates active accounts and prints the link and password to send each person", async () => {
  const { system, webui, options, lines } = fixture({ installed: true, up: true });
  await chatUiCommand("up", [], options({ adminEmail: "admin@example.com" }));
  await chatUiCommand("share", [], options());
  lines.length = 0;
  assert.equal(await chatUiCommand("invite", ["A@x.com", "b@x.com", "a@x.com"], options()), 0);
  const a = webui.users.find((user) => user.email === "a@x.com")!;
  const b = webui.users.find((user) => user.email === "b@x.com")!;
  assert.equal(a.role, "user");
  assert.equal(b.role, "user");
  assert.equal(webui.users.length, 3);
  assert.notEqual(a.password, b.password);
  const text = lines.join("");
  assert.ok(text.includes(`a@x.com: https://box.tail1234.ts.net · sign in as a@x.com · password ${a.password}`));
  assert.ok(text.includes(`password ${b.password}`));
  assert.ok(!text.includes(JSON.parse(system.files.get(UI_STATE)!.content).adminPassword), "never the admin's password");
  const add = webui.requests.filter((request) => request.path === "/api/v1/auths/add");
  assert.equal(add.length, 2);
  assert.ok(add.every((request) => request.token && request.body!.role === "user"));
  // Again: nobody is created twice and no new passwords are made.
  lines.length = 0;
  assert.equal(await chatUiCommand("invite", ["a@x.com", "b@x.com"], options()), 0);
  assert.equal(webui.users.length, 3);
  assert.match(lines.join(""), /a@x\.com: already has an account \(user\)/);
  assert.ok(!lines.join("").includes("password"));
});

test("invite approves someone who already signed up and is pending", async () => {
  const { webui, options, output } = fixture();
  await chatUiCommand("up", [], options({ adminEmail: "admin@example.com" }));
  webui.add("c@x.com", "C", "theirs", "pending");
  await chatUiCommand("invite", ["c@x.com"], options());
  assert.equal(webui.users.find((user) => user.email === "c@x.com")!.role, "user");
  assert.match(output(), /approved \(they had already signed up\)/);
  assert.match(output(), /dl ui share/, "not shared yet: says so");
});

test("invite refuses bad emails before creating anyone", async () => {
  const { webui, options } = fixture();
  await chatUiCommand("up", [], options({ adminEmail: "admin@example.com" }));
  await assert.rejects(chatUiCommand("invite", ["good@x.com", "bad", "also@bad", "x@y.com;z@w.com"], options()), /Not email addresses: bad, also@bad, x@y\.com;z@w\.com\. Nobody was invited/);
  assert.equal(webui.users.length, 1);
  assert.equal(await chatUiCommand("invite", [], options()), 2);
});

test("approve lists pending sign-ups and approves named ones or all", async () => {
  const { webui, options, lines } = fixture();
  await chatUiCommand("up", [], options({ adminEmail: "admin@example.com" }));
  webui.add("p1@x.com", "P1", "pw", "pending");
  webui.add("p2@x.com", "P2", "pw", "pending");
  lines.length = 0;
  assert.equal(await chatUiCommand("approve", [], options()), 0);
  assert.match(lines.join(""), /p1@x\.com: P1.*p2@x\.com: P2/s);
  await assert.rejects(chatUiCommand("approve", ["nobody@x.com"], options()), /Not waiting for approval: nobody@x\.com/);
  assert.equal(await chatUiCommand("approve", ["P1@x.com"], options()), 0);
  assert.equal(webui.users.find((user) => user.email === "p1@x.com")!.role, "user");
  assert.equal(webui.users.find((user) => user.email === "p2@x.com")!.role, "pending");
  assert.equal(await chatUiCommand("approve", ["all"], options()), 0);
  assert.ok(webui.users.every((user) => user.role !== "pending"));
});

test("status shows the link, the listening address and who is waiting", async () => {
  const { webui, options, lines } = fixture();
  await chatUiCommand("up", [], options({ adminEmail: "admin@example.com" }));
  webui.add("p@x.com", "P", "pw", "pending");
  lines.length = 0;
  assert.equal(await chatUiCommand("status", [], options()), 0);
  const text = lines.join("");
  assert.match(text, /Team chat: running · Open WebUI 0\.12\.5/);
  assert.match(text, /Shared: no · dl ui share/);
  assert.match(text, /Waiting for approval: p@x\.com/);
});

test("down keeps the data and stops sharing; --purge deletes the volume and dl's state", async () => {
  const { system, options } = fixture({ installed: true, up: true });
  await chatUiCommand("up", [], options({ adminEmail: "admin@example.com" }));
  await chatUiCommand("share", [], options());
  assert.equal(await chatUiCommand("down", [], options()), 0);
  assert.equal(system.uiContainers.size, 0);
  assert.equal(system.served.size, 0);
  assert.ok(system.volumes.has("dl-ui-data"));
  assert.ok(system.files.has(UI_STATE));
  assert.equal(await chatUiCommand("down", [], options({ purge: true })), 0);
  assert.ok(!system.volumes.has("dl-ui-data"));
  assert.ok(!system.files.has(UI_STATE));
  assert.ok(!system.calls.some((call) => call.includes("funnel")));
});

test("commands before dl ui up say how to start", async () => {
  const { options } = fixture();
  await assert.rejects(chatUiCommand("share", [], options()), /dl ui up/);
  await assert.rejects(chatUiCommand("invite", ["a@x.com"], options()), /dl ui up/);
  await assert.rejects(chatUiCommand("share", [], options({ purge: true })), /--purge goes with dl ui down/);
});

test("emails, passwords and the LAN address", () => {
  for (const good of ["a@x.com", "first.last+tag@sub.example.co"]) assert.ok(validEmail(good), good);
  for (const bad of ["", "a", "a@x", "a b@x.com", "a@x.com,", "<a@x.com>", "a@@x.com"]) assert.ok(!validEmail(bad), bad);
  const password = generatePassword();
  assert.match(password, /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^\w\s]).{20,72}$/);
  assert.notEqual(password, generatePassword());
  assert.equal(lanAddress("10.0.0.7", {}), "10.0.0.7");
  assert.equal(lanAddress("0.0.0.0", { docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false, netmask: "", mac: "", cidr: null }] }), undefined);
});

test("the container args are stable for the same settings and change with the shared link", () => {
  const base = { listen: "127.0.0.1", port: UI_PORT };
  assert.deepEqual(uiDockerArgs(base, []), uiDockerArgs(base, []));
  assert.notDeepEqual(uiDockerArgs(base, []), uiDockerArgs({ ...base, share: { mode: "lan", url: "http://10.0.0.7:4800" } }, []));
  // No model: Open WebUI's OpenAI default (api.openai.com) stays off.
  assert.ok(uiDockerArgs(base, []).includes("ENABLE_OPENAI_API=false"));
  assert.ok(!uiDockerArgs(base, []).some((arg) => arg.startsWith("OPENAI_API_BASE_URLS")));
});

test("dl ui is wired into the CLI and its help", async () => {
  let out = "";
  assert.equal(await main(["--help"], { out: (text) => { out += text; }, err: () => {} }), 0);
  assert.match(out, /dl ui share/);
  assert.match(out, /dl ui invite EMAIL/);
  let err = "";
  assert.equal(await main(["ui", "--server", "x"], { out: () => {}, err: (text) => { err += text; } }, { terminal: false }), 2);
  assert.match(err, /omit --server/);
});
