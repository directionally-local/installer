import assert from "node:assert/strict";
import { test } from "node:test";
import { firstRunChat, type FirstRunChatOptions } from "./chat-first-run.js";
import { UI_PORT } from "./chat-ui.js";
import { writeDeployment, type ModelDeployment } from "./state.js";
import { FakeOpenWebUi, FakeUiSystem } from "./test-support/fake-open-webui.js";
import { PlainUi } from "./ui.js";
import type { Prompter } from "./prompt.js";

const STATE = "/state/model.json";
const LINK = "https://gpu-box.tail1234.ts.net";

function deployment(): ModelDeployment {
  return { id: "qwen-new", repo: "Qwen/Qwen3-Coder-30B", container: "dl-model-8000", port: 8000, context: 8192, image: "vllm/vllm-openai:v0.33.0", flags: [], minVramMiB: 1,
    lastTest: { chat: true, tools: true, json: true, tokensPerSecond: 1, at: "" } };
}

async function fixture(tailscale: { installed: boolean; up: boolean; certs?: boolean }) {
  const system = new FakeUiSystem({ tailscale: tailscale.installed, tailscaleUp: tailscale.up });
  system.dnsName = "gpu-box.tail1234.ts.net.";
  system.httpsCerts = tailscale.certs ?? true;
  await writeDeployment(system, "default", { active: deployment() }, STATE);
  const webui = new FakeOpenWebUi();
  let screen = "";
  const lines: string[] = [];
  const prompter: Prompter = { choose: async () => "", select: async (_q, choices) => ({ value: choices[0]!.value }), secret: async () => "", text: async () => "" };
  /** Called on every wait; a test makes things happen there (the admin signs up, certificates come on). */
  let onWait: (count: number) => void = () => {};
  let waits = 0;
  const options = (extra: Partial<FirstRunChatOptions> = {}): FirstRunChatOptions => ({
    system, ui: new PlainUi((line) => lines.push(line)), prompter, io: { out: (text) => { screen += text; } }, root: true, hostname: "gpu-box",
    model: "Qwen/Qwen3-Coder-30B", statePath: STATE, fetch: webui.fetch, delay: async () => { onWait(++waits); }, ...extra,
  });
  return { system, webui, lines, options, screen: () => screen, progress: () => lines.join(""), setOnWait: (fn: (count: number) => void) => { onWait = fn; } };
}

const FINAL_SCREEN = `
  ✓ Qwen3-Coder-30B is running and passed its tests
  ✓ Team chat is running, HTTPS on your private network

  Set up the admin account here:
  ${LINK}
  Whoever opens this link first becomes the admin. Open it now, yourself.

  Then invite your team from the chat (Admin Panel > Users), or share the link
  and approve people as they sign up. Each person needs the Tailscale app.
  Everyone sets up an authenticator app (2FA) the first time they sign in.
  See what's running any time: dl status

  Waiting for the admin account… Ctrl-C stops waiting; everything keeps running.
  ✓ Admin account created. Sign-ups are open; each one waits for your approval.

`;

test("Tailscale missing: installs it, signs in with a link and QR code, serves HTTPS, prints the admin link and waits for the admin", async () => {
  const { system, webui, options, screen, setOnWait } = await fixture({ installed: false, up: false });
  // The admin signs up in the browser while dl waits.
  setOnWait((count) => { if (count === 2) webui.add("me@acme.com", "Me", "pw", "admin"); });
  const result = await firstRunChat(options());
  assert.deepEqual(result, { ok: true, url: LINK, hasAdmin: true });
  assert.ok(system.ran.some((command) => command.startsWith("curl -fsSL --proto =https --tlsv1.2 https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg")), "Tailscale's signed apt repository");
  assert.ok(system.ran.includes("apt-get install -y -qq tailscale"), "installed from it");
  assert.ok(!system.ran.some((command) => command.includes("tailscale.com/install.sh")), "no piped vendor script");
  assert.ok(system.calls.includes("tailscale up --qr --hostname=gpu-box --timeout=15m"), "the sign-in link and a QR code, on the terminal");
  assert.ok(system.calls.includes(`tailscale serve --bg --https=443 http://127.0.0.1:${UI_PORT}`));
  assert.equal(system.uiContainers.get("dl-ui")!.args.includes("HOST=127.0.0.1"), true);
  assert.ok(system.uiContainers.get("dl-ui")!.args.includes(`WEBUI_URL=${LINK}`));
  assert.ok(system.uiContainers.get("dl-ui")!.args.includes("ENABLE_MFA=true"));
  assert.match(screen(), /Open the link below on your laptop or phone \(or scan the QR code\)/);
  assert.ok(screen().endsWith(FINAL_SCREEN), screen());
  // Making the first account turned sign-ups off in Open WebUI; one restart opens them.
  assert.equal(system.calls.filter((call) => call === "docker restart dl-ui").length, 1);
  assert.equal(webui.users.length, 1, "dl made no account itself");
  assert.ok(!system.calls.some((call) => call.includes("funnel")));
});

test("the admin line is red and the rest dim on a color terminal", async () => {
  const { webui, options, setOnWait } = await fixture({ installed: true, up: true });
  setOnWait(() => { if (!webui.users.length) webui.add("me@acme.com", "Me", "pw", "admin"); });
  let captured = "";
  await firstRunChat(options({ io: { out: (text) => { captured += text; }, color: true } }));
  assert.ok(captured.includes(`\x1b[31mSet up the admin account here:\x1b[39m`));
  assert.ok(captured.includes(`\x1b[31m${LINK}\x1b[39m`));
  assert.ok(captured.includes(`\x1b[31mWhoever opens this link first becomes the admin. Open it now, yourself.\x1b[39m`));
  assert.ok(captured.includes(`\x1b[2mSee what's running any time: dl status\x1b[22m`));
});

test("logged out, not root: sudo first, then the sign-in with this login as Tailscale's operator", async () => {
  const { system, webui, options, setOnWait } = await fixture({ installed: true, up: false });
  setOnWait(() => { if (!webui.users.length) webui.add("me@acme.com", "Me", "pw", "admin"); });
  const result = await firstRunChat(options({ root: false, user: "sina" }));
  assert.equal(result.ok, true);
  assert.ok(system.calls.indexOf("sudo -v") < system.calls.indexOf("sudo tailscale up --qr --hostname=gpu-box --timeout=15m --operator=sina"));
  assert.equal(system.operator, "sina", "dl ui share and refreshes then work without sudo");
  assert.ok(!system.calls.some((call) => call.startsWith("sudo sh")), "already installed");
});

test("already signed in, not root: makes this login the operator, no sign-in", async () => {
  const { system, webui, options, setOnWait } = await fixture({ installed: true, up: true });
  setOnWait(() => { if (!webui.users.length) webui.add("me@acme.com", "Me", "pw", "admin"); });
  await firstRunChat(options({ root: false, user: "sina" }));
  assert.ok(!system.calls.some((call) => call.includes("tailscale up")));
  assert.ok(system.calls.indexOf("sudo -v") < system.calls.indexOf("sudo tailscale set --operator=sina"), "the password is asked on the terminal first");
  assert.equal(system.operator, "sina");
});

test("HTTPS certificates off: shows the admin console link and waits until they're on", async () => {
  const { system, webui, options, screen, setOnWait } = await fixture({ installed: true, up: true, certs: false });
  setOnWait((count) => {
    if (count === 2) system.httpsCerts = true;
    if (count > 2 && !webui.users.length) webui.add("me@acme.com", "Me", "pw", "admin");
  });
  const result = await firstRunChat(options());
  assert.equal(result.ok, true);
  assert.match(screen(), /HTTPS certificates are off for your tailnet\. Turn them on \(one click\):\n {2}https:\/\/login\.tailscale\.com\/admin\/dns {2}> {2}HTTPS Certificates {2}> {2}Enable/);
  assert.ok(system.served.has(443));
});

test("HTTPS certificates stay off: stops with the next step, starts nothing, no plain-HTTP link", async () => {
  const { system, options, screen } = await fixture({ installed: true, up: true, certs: false });
  const result = await firstRunChat(options({ waits: { certs: 10_000 } }));
  assert.equal(result.ok, false);
  assert.match(screen(), /✗ HTTPS certificates are still off for your tailnet\.\n {2}Next: turn on MagicDNS and HTTPS certificates at https:\/\/login\.tailscale\.com\/admin\/dns, then dl ui share/);
  assert.match(screen(), /just you: ssh -N -L 4800:127\.0\.0\.1:4800/);
  assert.equal(system.uiContainers.size, 0);
  assert.ok(!/http:\/\/(?!127\.0\.0\.1)/.test(screen()));
});

test("the Tailscale sign-in doesn't finish: stops with the next step, starts nothing", async () => {
  const { system, options, screen } = await fixture({ installed: true, up: false });
  system.loginFails = true;
  const result = await firstRunChat(options());
  assert.deepEqual(result, { ok: false, message: "Tailscale sign-in didn't finish." });
  assert.match(screen(), /Next: sudo tailscale up \(it prints a sign-in link\), then dl ui share/);
  assert.equal(system.uiContainers.size, 0);
});

test("Ctrl-C while waiting for the admin: stops waiting, everything keeps running", async () => {
  const { system, options, screen } = await fixture({ installed: true, up: true });
  const stop = new AbortController();
  let waits = 0;
  const result = await firstRunChat(options({ signal: stop.signal, delay: async () => { if (++waits === 3) stop.abort(); } }));
  assert.deepEqual(result, { ok: true, url: LINK, hasAdmin: false });
  assert.match(screen(), /Stopped waiting\. Once the admin account exists, run dl ui up once so your team can sign up\./);
  assert.ok(system.uiContainers.get("dl-ui")!.running);
  assert.ok(system.served.has(443));
});

test("a chat that already has its admin: the link, no red admin line, no wait", async () => {
  const { webui, options, screen } = await fixture({ installed: true, up: true });
  webui.add("me@acme.com", "Me", "pw", "admin");
  const result = await firstRunChat(options({ model: undefined }));
  assert.deepEqual(result, { ok: true, url: LINK, hasAdmin: true });
  assert.match(screen(), new RegExp(`Team chat: ${LINK.replace(/\./g, "\\.")}\n {2}Its admin account is already set up\\.`));
  assert.ok(!screen().includes("Whoever opens"));
  assert.ok(!screen().includes("Waiting for the admin"));
});

test("Docker missing: says so with the next step", async () => {
  const { system, options, screen } = await fixture({ installed: true, up: true });
  system.docker = false;
  const result = await firstRunChat(options());
  assert.equal(result.ok, false);
  assert.match(screen(), /✗ Docker is missing or its daemon is stopped/);
  assert.match(screen(), /Next: fix that, then dl ui up and dl ui share/);
});
