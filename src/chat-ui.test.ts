import assert from "node:assert/strict";
import { test } from "node:test";
import { API_KEY_ENDPOINTS, chatUiCommand, OPEN_WEBUI_IMAGE, readUiState, refreshChatUi, uiDockerArgs, UI_PORT, validEmail, generatePassword, type ChatUiOptions } from "./chat-ui.js";
import { main } from "./cli.js";
import { writeDeployment, type ModelDeployment } from "./state.js";
import { FakeOpenWebUi, FakeUiSystem } from "./test-support/fake-open-webui.js";
import { PlainUi } from "./ui.js";
import type { Prompter } from "./prompt.js";

const STATE = "/state/model.json";
const UI_STATE = "/state/ui.json";
const LOCAL = `http://127.0.0.1:${UI_PORT}`;

function deployment(id: string, port: number): ModelDeployment {
  return { id, repo: `org/${id}`, container: `dl-model-${port}`, port, context: 8192, image: "vllm/vllm-openai:v0.33.0", flags: [], minVramMiB: 1,
    lastTest: { chat: true, tools: true, json: true, tokensPerSecond: 1, at: "" } };
}

function fixture(tailscale: { installed?: boolean; up?: boolean } = {}) {
  const system = new FakeUiSystem({ tailscale: tailscale.installed ?? false, tailscaleUp: tailscale.up ?? false });
  const webui = new FakeOpenWebUi();
  const lines: string[] = [];
  const secrets: string[] = [];
  const asked: string[] = [];
  const prompter: Prompter = { choose: async () => "", select: async (_q, choices) => ({ value: choices[0]!.value }),
    secret: async (question) => { asked.push(question); return secrets.shift() ?? ""; }, text: async () => "" };
  const options = (extra: Partial<ChatUiOptions> = {}): ChatUiOptions => ({ system, ui: new PlainUi((line) => lines.push(line)), prompter, interactive: false,
    statePath: STATE, fetch: webui.fetch, delay: async () => {}, env: {}, ...extra });
  const output = () => lines.join("");
  const uiState = () => JSON.parse(system.files.get(UI_STATE)!.content);
  const env = () => {
    const args = system.uiContainers.get("dl-ui")!.args;
    return Object.fromEntries(args.flatMap((arg, i) => args[i - 1] === "-e" ? [[arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]] : []));
  };
  const restarts = () => system.calls.filter((call) => call === "docker restart dl-ui").length;
  const runs = () => system.calls.filter((call) => call.startsWith("docker run")).length;
  /** The admin signs up in the browser and makes an API key there. */
  const adminInBrowser = (email = "admin@example.com") => { webui.add(email, "Admin", "theirs", "admin"); return webui.apiKey(email); };
  return { system, webui, lines, secrets, asked, options, output, uiState, env, restarts, runs, adminInBrowser };
}

test("up runs pinned Open WebUI on loopback only, with a volume, restart policy, 2FA, scoped API keys and every dl model endpoint", async () => {
  const { system, options, env, output, webui } = fixture();
  await writeDeployment(system, "default", { active: deployment("qwen", 8000) }, STATE);
  await writeDeployment(system, "big", { active: deployment("glm", 8002) }, STATE);
  assert.equal(await chatUiCommand("up", [], options()), 0);
  const args = system.uiContainers.get("dl-ui")!.args;
  assert.equal(args.at(-1), OPEN_WEBUI_IMAGE);
  assert.match(OPEN_WEBUI_IMAGE, /^ghcr\.io\/open-webui\/open-webui:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
  assert.ok(system.calls.includes(`docker pull ${OPEN_WEBUI_IMAGE}`));
  assert.deepEqual(args.slice(args.indexOf("--restart"), args.indexOf("--restart") + 2), ["--restart", "unless-stopped"], "comes back after a reboot");
  assert.ok(args.includes("dl-ui-data:/app/backend/data"));
  assert.ok(args.includes("--network") && args.includes("host"), "reaches the models on the host's 127.0.0.1");
  assert.ok(!args.includes("-p"), "no published port: Open WebUI binds HOST itself");
  const e = env();
  assert.equal(e.HOST, "127.0.0.1", "never the network: HTTPS only, through tailscale serve");
  assert.equal(e.PORT, String(UI_PORT));
  assert.equal(e.OPENAI_API_BASE_URLS, "http://127.0.0.1:8002/v1;http://127.0.0.1:8000/v1");
  assert.equal(e.OPENAI_API_KEYS, "dl-local;dl-local");
  assert.equal(e.ENABLE_OLLAMA_API, "false");
  assert.equal(e.ENABLE_SIGNUP, "true");
  assert.equal(e.DEFAULT_USER_ROLE, "pending");
  assert.equal(e.ENABLE_MFA, "true", "2FA for everyone");
  assert.equal(e.MFA_ALLOW_OAUTH_BYPASS, undefined);
  assert.equal(e.ENABLE_API_KEYS, "true");
  assert.equal(e.ENABLE_API_KEYS_ENDPOINT_RESTRICTIONS, "true");
  assert.equal(e.API_KEYS_ALLOWED_ENDPOINTS, "/api/v1/users,/api/v1/auths/add");
  assert.deepEqual(API_KEY_ENDPOINTS, ["/api/v1/users", "/api/v1/auths/add"]);
  assert.equal(e.ENABLE_WEB_SEARCH, "false");
  assert.equal(e.ENABLE_IMAGE_GENERATION, "false");
  assert.equal(e.OFFLINE_MODE, "true");
  assert.equal(e.ENABLE_VERSION_UPDATE_CHECK, "false");
  assert.equal(e.ENABLE_PERSISTENT_CONFIG, "false");
  assert.equal(e.WEBUI_URL, LOCAL);
  // 2FA's secrets are encrypted with a key derived from this one, kept in the volume.
  assert.equal(e.WEBUI_SECRET_KEY_FILE, "/app/backend/data/.webui_secret_key");
  assert.equal(e.MFA_ENCRYPTION_KEY, undefined);
  assert.ok(!Object.keys(e).some((name) => /PASSWORD|ADMIN_EMAIL/.test(name)), "no credentials in the container's environment");
  assert.equal(webui.users.length, 0, "dl doesn't create the admin: it's made in the browser");
  assert.match(output(), /this machine only/);
  assert.match(output(), /whoever opens it first becomes the admin/);
  assert.match(output(), /ssh -N -L 4800:127\.0\.0\.1:4800/, "localhost-only is for an SSH tunnel");
  assert.match(output(), /authenticator app \(2FA\)/);
});

test("ui.json never holds a password", async () => {
  const { system, options, uiState } = fixture();
  await chatUiCommand("up", [], options());
  assert.deepEqual(uiState(), { version: 2, port: UI_PORT });
  assert.equal(system.files.get(UI_STATE)!.mode, 0o600);
});

test("--admin-email: dl makes the admin, shows its password once and doesn't keep it", async () => {
  const { system, webui, options, output, uiState, restarts } = fixture();
  await chatUiCommand("up", [], options({ adminEmail: "Admin@Example.com" }));
  assert.equal(webui.users.length, 1);
  assert.equal(webui.users[0]!.role, "admin");
  assert.equal(webui.users[0]!.email, "admin@example.com");
  assert.ok(output().includes(`password ${webui.users[0]!.password}`));
  assert.ok(!system.files.get(UI_STATE)!.content.includes(webui.users[0]!.password));
  assert.equal(uiState().adminPassword, undefined);
  // Open WebUI turns sign-ups off after its first account; the restart brings dl's settings back.
  assert.equal(restarts(), 1);
  assert.equal(uiState().signupsOpen, true);
  await assert.rejects(chatUiCommand("up", [], options({ adminEmail: "other@example.com" })), /already has its admin/);
  await assert.rejects(chatUiCommand("up", [], options({ adminEmail: "not-an-email" })), /isn't an email address/);
});

test("once the admin signs up in the browser, the next up restarts Open WebUI once so sign-ups open", async () => {
  const { options, restarts, uiState, adminInBrowser } = fixture();
  await chatUiCommand("up", [], options());
  assert.equal(restarts(), 0);
  adminInBrowser();
  await chatUiCommand("up", [], options());
  assert.equal(restarts(), 1);
  assert.equal(uiState().signupsOpen, true);
  await chatUiCommand("up", [], options());
  assert.equal(restarts(), 1, "only once");
});

test("up again keeps the running container; a new model replaces it, keeping accounts", async () => {
  const { system, options, lines, runs } = fixture();
  await chatUiCommand("up", [], options());
  lines.length = 0;
  assert.equal(await chatUiCommand("up", [], options()), 0);
  assert.equal(runs(), 1);
  assert.match(lines.join(""), /Team chat is running/);
  await writeDeployment(system, "default", { active: deployment("qwen", 8000) }, STATE);
  await chatUiCommand("up", [], options());
  assert.equal(runs(), 2);
  assert.ok(system.calls.includes("docker rm -f dl-ui"));
});

test("--listen is refused: the chat is HTTPS-only, with an SSH tunnel for one person", async () => {
  const { options, system } = fixture();
  await assert.rejects(chatUiCommand("up", [], options({ listen: "0.0.0.0" })), /HTTPS only.*dl ui share.*ssh -N -L 4800:127\.0\.0\.1:4800/s);
  assert.equal(system.uiContainers.size, 0);
  let err = "";
  assert.equal(await main(["ui", "up", "--listen"], { out: () => {}, err: (text) => { err += text; } }, { terminal: false }), 1);
  assert.match(err, /no longer listens on the network/);
});

test("a port that a model holds is refused", async () => {
  const { system, options } = fixture();
  await writeDeployment(system, "default", { active: deployment("qwen", 8000) }, STATE);
  await assert.rejects(chatUiCommand("up", [], options({ port: "8001" })), /belongs to model deployment default/);
  await chatUiCommand("up", [], options({ port: "4900" }));
});

test("share with Tailscale serves HTTPS on the tailnet name, prints one link and points WEBUI_URL at it", async () => {
  const { system, options, lines, env, uiState, runs } = fixture({ installed: true, up: true });
  await chatUiCommand("up", [], options());
  lines.length = 0;
  assert.equal(await chatUiCommand("share", [], options()), 0);
  assert.ok(system.calls.includes(`tailscale serve --bg --https=443 ${LOCAL}`), "--bg: tailscaled keeps it across reboots");
  assert.equal(system.served.get(443), LOCAL);
  const links = lines.join("").match(/https?:\/\/[^\s;]+/g) ?? [];
  assert.deepEqual([...new Set(links)], ["https://box.tail1234.ts.net"]);
  assert.match(lines.join(""), /No admin yet: open https:\/\/box\.tail1234\.ts\.net now/);
  assert.equal(env().WEBUI_URL, "https://box.tail1234.ts.net");
  assert.deepEqual(uiState().share, { mode: "tailscale", url: "https://box.tail1234.ts.net", httpsPort: 443 });
  // Again: the same port, the same link, nothing restarted.
  const before = runs();
  assert.equal(await chatUiCommand("share", [], options()), 0);
  assert.equal(runs(), before);
  assert.deepEqual([...system.served.keys()], [443]);
  assert.ok(!system.calls.some((call) => call.includes("funnel")), "never tailscale funnel");
});

test("share leaves the server's agent API on 443 alone and uses 8443", async () => {
  const { system, options, output } = fixture({ installed: true, up: true });
  system.served.set(443, "http://127.0.0.1:4096");
  await chatUiCommand("up", [], options());
  await chatUiCommand("share", [], options());
  assert.equal(system.served.get(443), "http://127.0.0.1:4096");
  assert.equal(system.served.get(8443), LOCAL);
  assert.match(output(), /https:\/\/box\.tail1234\.ts\.net:8443/);
});

test("share refuses a port Funnel makes public, and never runs funnel itself", async () => {
  const { system, options } = fixture({ installed: true, up: true });
  // Someone ran tailscale funnel on Open WebUI's port by hand.
  system.served.set(443, LOCAL);
  system.funnel.add(443);
  await chatUiCommand("up", [], options());
  await assert.rejects(chatUiCommand("share", [], options()), /Funnel is on for HTTPS port 443/);
  assert.ok(!system.calls.some((call) => /^tailscale (serve --bg|funnel)/.test(call)));
});

test("share falls back to Tailscale's older serve syntax", async () => {
  const { system, options } = fixture({ installed: true, up: true });
  system.oldTailscale = true;
  await chatUiCommand("up", [], options());
  await chatUiCommand("share", [], options());
  assert.ok(system.calls.includes(`tailscale serve https:443 / ${LOCAL}`));
  assert.equal(system.served.get(443), LOCAL);
});

test("share explains a Tailscale HTTPS failure", async () => {
  const { system, options } = fixture({ installed: true, up: true });
  system.serveFails = true;
  await chatUiCommand("up", [], options());
  await assert.rejects(chatUiCommand("share", [], options()), /HTTPS certificates at https:\/\/login\.tailscale\.com\/admin\/dns/);
});

for (const [name, tailscale, said, next] of [
  ["missing", { installed: false }, /isn't installed here/, /tailscale\.com\/install\.sh.*sudo tailscale up.*dl ui share/],
  ["logged out", { installed: true, up: false }, /isn't signed in here/, /sudo tailscale up \(it prints a sign-in link\)/],
  ["HTTPS certificates off", { installed: true, up: true }, /HTTPS certificates are off/, /login\.tailscale\.com\/admin\/dns/],
] as const) {
  test(`share with Tailscale ${name}: no plain-HTTP fallback, says why and what's next`, async () => {
    const { system, options, lines, env } = fixture(tailscale);
    system.httpsCerts = name !== "HTTPS certificates off";
    await chatUiCommand("up", [], options());
    lines.length = 0;
    assert.equal(await chatUiCommand("share", [], options()), 1);
    const text = lines.join("");
    assert.match(text, said);
    assert.match(text, next);
    assert.match(text, /ssh -N -L 4800:127\.0\.0\.1:4800/);
    assert.ok(!/http:\/\/(?!127\.0\.0\.1)/.test(text), "no http:// link but the loopback one");
    assert.ok(!system.calls.some((call) => call.startsWith("tailscale serve --")));
    assert.equal(env().HOST, "127.0.0.1");
  });
}

test("share --off stops serving and points WEBUI_URL back at this machine", async () => {
  const { system, options, env, uiState } = fixture({ installed: true, up: true });
  await chatUiCommand("up", [], options());
  await chatUiCommand("share", [], options());
  assert.equal(await chatUiCommand("share", [], options({ off: true })), 0);
  assert.equal(system.served.size, 0);
  assert.ok(system.calls.includes(`tailscale serve --https=443 ${LOCAL} off`));
  assert.equal(uiState().share, undefined);
  assert.equal(env().WEBUI_URL, LOCAL);
  assert.ok(!system.calls.some((call) => call.includes("funnel")));
});

test("invite asks once for an admin's API key on a terminal, keeps it 0600, and makes accounts with it", async () => {
  const { system, webui, options, lines, secrets, asked, uiState, adminInBrowser } = fixture({ installed: true, up: true });
  await chatUiCommand("up", [], options());
  await chatUiCommand("share", [], options());
  const key = adminInBrowser();
  secrets.push(key);
  lines.length = 0;
  assert.equal(await chatUiCommand("invite", ["A@x.com", "b@x.com", "a@x.com"], options({ interactive: true })), 0);
  assert.equal(asked.length, 1);
  assert.match(lines.join(""), /Settings > Account > API Key/);
  assert.equal(uiState().adminApiKey, key);
  assert.equal(system.files.get(UI_STATE)!.mode, 0o600);
  const a = webui.users.find((user) => user.email === "a@x.com")!;
  const b = webui.users.find((user) => user.email === "b@x.com")!;
  assert.equal(a.role, "user");
  assert.equal(b.role, "user");
  assert.notEqual(a.password, b.password);
  const text = lines.join("");
  assert.ok(text.includes(`a@x.com: https://box.tail1234.ts.net · sign in as a@x.com · password ${a.password}`));
  assert.ok(!text.includes(key), "the key is never printed");
  assert.match(text, /authenticator app \(2FA\)/);
  const add = webui.requests.filter((request) => request.path === "/api/v1/auths/add");
  assert.equal(add.length, 2);
  assert.ok(add.every((request) => request.token === key && request.body!.role === "user"));
  assert.ok(!webui.requests.some((request) => request.path === "/api/v1/auths/signin"), "never signs in with a password");
  // Again: the kept key, not asked; nobody is created twice.
  lines.length = 0;
  assert.equal(await chatUiCommand("invite", ["a@x.com", "b@x.com"], options()), 0);
  assert.equal(asked.length, 1);
  assert.equal(webui.users.length, 3);
  assert.match(lines.join(""), /a@x\.com: already has an account \(user\)/);
});

test("invite without a terminal says how to make the key, and takes DL_UI_ADMIN_KEY", async () => {
  const { webui, options, uiState, adminInBrowser } = fixture();
  await chatUiCommand("up", [], options());
  const key = adminInBrowser();
  await assert.rejects(chatUiCommand("invite", ["c@x.com"], options()), /API key of an admin.*never keeps the admin's password.*DL_UI_ADMIN_KEY/s);
  assert.equal(await chatUiCommand("invite", ["c@x.com"], options({ env: { DL_UI_ADMIN_KEY: key } })), 0);
  assert.equal(webui.users.find((user) => user.email === "c@x.com")!.role, "user");
  assert.equal(uiState().adminApiKey, key);
});

test("a key that isn't an admin's is refused; a kept key Open WebUI no longer takes is dropped", async () => {
  const { webui, options, uiState, adminInBrowser } = fixture();
  await chatUiCommand("up", [], options());
  const key = adminInBrowser();
  webui.add("u@x.com", "U", "pw", "user");
  await assert.rejects(chatUiCommand("approve", [], options({ env: { DL_UI_ADMIN_KEY: webui.apiKey("u@x.com") } })), /must be an admin's/);
  await assert.rejects(chatUiCommand("approve", [], options({ env: { DL_UI_ADMIN_KEY: "not-a-key" } })), /start with sk-/);
  assert.equal(uiState().adminApiKey, undefined);
  await chatUiCommand("approve", [], options({ env: { DL_UI_ADMIN_KEY: key } }));
  webui.apiKeys.delete(key);
  await assert.rejects(chatUiCommand("approve", [], options()), /refused the admin API key dl kept/);
  assert.equal(uiState().adminApiKey, undefined);
});

test("invite approves someone who already signed up and is pending", async () => {
  const { webui, options, output, adminInBrowser } = fixture();
  await chatUiCommand("up", [], options());
  const key = adminInBrowser();
  webui.add("c@x.com", "C", "theirs", "pending");
  await chatUiCommand("invite", ["c@x.com"], options({ env: { DL_UI_ADMIN_KEY: key } }));
  assert.equal(webui.users.find((user) => user.email === "c@x.com")!.role, "user");
  assert.match(output(), /approved \(they had already signed up\)/);
  assert.match(output(), /dl ui share/, "not shared yet: says so");
});

test("invite refuses bad emails before creating anyone", async () => {
  const { webui, options } = fixture();
  await chatUiCommand("up", [], options());
  await assert.rejects(chatUiCommand("invite", ["good@x.com", "bad", "also@bad", "x@y.com;z@w.com"], options()), /Not email addresses: bad, also@bad, x@y\.com;z@w\.com\. Nobody was invited/);
  assert.equal(webui.users.length, 0);
  assert.equal(await chatUiCommand("invite", [], options()), 2);
});

test("approve lists pending sign-ups and approves named ones or all", async () => {
  const { webui, options, lines, adminInBrowser } = fixture();
  await chatUiCommand("up", [], options({ env: {} }));
  const key = adminInBrowser();
  const withKey = (extra: Partial<ChatUiOptions> = {}) => options({ env: { DL_UI_ADMIN_KEY: key }, ...extra });
  webui.add("p1@x.com", "P1", "pw", "pending");
  webui.add("p2@x.com", "P2", "pw", "pending");
  lines.length = 0;
  assert.equal(await chatUiCommand("approve", [], withKey()), 0);
  assert.match(lines.join(""), /p1@x\.com: P1.*p2@x\.com: P2/s);
  await assert.rejects(chatUiCommand("approve", ["nobody@x.com"], withKey()), /Not waiting for approval: nobody@x\.com/);
  assert.equal(await chatUiCommand("approve", ["P1@x.com"], withKey()), 0);
  assert.equal(webui.users.find((user) => user.email === "p1@x.com")!.role, "user");
  assert.equal(webui.users.find((user) => user.email === "p2@x.com")!.role, "pending");
  assert.equal(await chatUiCommand("approve", ["all"], withKey()), 0);
  assert.ok(webui.users.every((user) => user.role !== "pending"));
});

test("status: link, 2FA, the missing admin, and who is waiting only when dl has a key", async () => {
  const { webui, options, lines, adminInBrowser } = fixture();
  await chatUiCommand("up", [], options());
  lines.length = 0;
  assert.equal(await chatUiCommand("status", [], options()), 0);
  assert.match(lines.join(""), /Admin: not set up yet · open http:\/\/127\.0\.0\.1:4800/);
  const key = adminInBrowser();
  webui.add("p@x.com", "P", "pw", "pending");
  lines.length = 0;
  assert.equal(await chatUiCommand("status", [], options()), 0);
  let text = lines.join("");
  assert.match(text, /Team chat: running · Open WebUI 0\.12\.5/);
  assert.match(text, /Shared: no · dl ui share/);
  assert.match(text, /2FA: required for everyone/);
  assert.ok(!/Waiting for approval/.test(text), "no key: not asked for, not shown");
  await chatUiCommand("approve", [], options({ env: { DL_UI_ADMIN_KEY: key } }));
  lines.length = 0;
  await chatUiCommand("status", [], options());
  text = lines.join("");
  assert.match(text, /Waiting for approval: p@x\.com/);
});

test("down keeps the data and stops sharing; --purge deletes the volume and dl's state", async () => {
  const { system, options } = fixture({ installed: true, up: true });
  await chatUiCommand("up", [], options());
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

test("a ui.json from before HTTPS-only loses its password and LAN link", async () => {
  const { system } = fixture();
  await system.writeFile(UI_STATE, JSON.stringify({ version: 1, port: 4800, listen: "0.0.0.0", adminEmail: "a@x.com", adminPassword: "secret", adminCreated: true, share: { mode: "lan", url: "http://192.168.1.20:4800" } }));
  assert.deepEqual(await readUiState(system, UI_STATE), { version: 2, port: 4800, signupsOpen: true });
  await system.writeFile(UI_STATE, JSON.stringify({ version: 1, port: 4800, listen: "127.0.0.1", adminEmail: "a@x.com", adminPassword: "secret", adminCreated: false, share: { mode: "tailscale", url: "https://box.ts.net", httpsPort: 443 } }));
  assert.deepEqual(await readUiState(system, UI_STATE), { version: 2, port: 4800, share: { mode: "tailscale", url: "https://box.ts.net", httpsPort: 443 } });
});

test("after a model change, a running chat follows by itself: same link, same accounts", async () => {
  const { system, options, lines, runs, env, adminInBrowser, uiState } = fixture({ installed: true, up: true });
  await writeDeployment(system, "default", { active: deployment("qwen", 8000) }, STATE);
  await chatUiCommand("up", [], options());
  await chatUiCommand("share", [], options());
  adminInBrowser();
  const before = runs();
  lines.length = 0;
  // dl model update: a new deployment port.
  await writeDeployment(system, "default", { active: deployment("glm", 8001) }, STATE);
  await refreshChatUi(options());
  assert.equal(runs(), before + 1);
  assert.equal(env().OPENAI_API_BASE_URLS, "http://127.0.0.1:8001/v1");
  assert.equal(env().WEBUI_URL, "https://box.tail1234.ts.net");
  assert.match(lines.join(""), /Team chat: updated for the models here · same link: https:\/\/box\.tail1234\.ts\.net/);
  assert.equal(uiState().signupsOpen, true, "a fresh container has sign-ups open");
  // Nothing changed: nothing restarted, nothing said.
  lines.length = 0;
  await refreshChatUi(options());
  assert.equal(runs(), before + 1);
  assert.equal(lines.join(""), "");
  // Stopped by dl ui down: stays down.
  await chatUiCommand("down", [], options());
  await writeDeployment(system, "default", { active: deployment("qwen", 8000) }, STATE);
  await refreshChatUi(options());
  assert.equal(system.uiContainers.size, 0);
});

test("no team chat here: a model change touches nothing", async () => {
  const { system, options } = fixture();
  await refreshChatUi(options());
  assert.deepEqual(system.calls, []);
});

test("emails and passwords", () => {
  for (const good of ["a@x.com", "first.last+tag@sub.example.co"]) assert.ok(validEmail(good), good);
  for (const bad of ["", "a", "a@x", "a b@x.com", "a@x.com,", "<a@x.com>", "a@@x.com"]) assert.ok(!validEmail(bad), bad);
  const password = generatePassword();
  assert.match(password, /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^\w\s]).{20,72}$/);
  assert.notEqual(password, generatePassword());
});

test("the container args are stable for the same settings and change with the shared link", () => {
  const base = { port: UI_PORT };
  assert.deepEqual(uiDockerArgs(base, []), uiDockerArgs(base, []));
  assert.notDeepEqual(uiDockerArgs(base, []), uiDockerArgs({ ...base, share: { mode: "tailscale", url: "https://box.ts.net", httpsPort: 443 } }, []));
  // No model: Open WebUI's OpenAI default (api.openai.com) stays off.
  assert.ok(uiDockerArgs(base, []).includes("ENABLE_OPENAI_API=false"));
  assert.ok(!uiDockerArgs(base, []).some((arg) => arg.startsWith("OPENAI_API_BASE_URLS")));
});

test("dl ui is wired into the CLI and its help, without a network mode", async () => {
  let out = "";
  assert.equal(await main(["--help"], { out: (text) => { out += text; }, err: () => {} }), 0);
  assert.match(out, /dl ui share/);
  assert.match(out, /dl ui invite EMAIL/);
  assert.match(out, /no plain-HTTP fallback/);
  assert.ok(!/--listen/.test(out));
  let err = "";
  assert.equal(await main(["ui", "--server", "x"], { out: () => {}, err: (text) => { err += text; } }, { terminal: false }), 2);
  assert.match(err, /omit --server/);
});
