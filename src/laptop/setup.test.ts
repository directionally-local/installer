import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeSshServer } from "../test-support/fake-ssh.js";
import { fakeTunnels } from "../test-support/fake-tunnel.js";
import { ScriptedPrompter } from "../prompt.js";
import { RecordingUi } from "../ui.js";
import { loadRemotes, saveRemote, type RemoteServer } from "./config.js";
import { serverLabel, setupWizard, type LocalSetup, type SetupDeps } from "./setup.js";
import { createOpener } from "./tunnel.js";

const GH = `gho_${"a".repeat(36)}`;
const OR = "sk-or-v1-fromautopilot0000";
const TOKEN = `aster_laptop_token_${"0".repeat(34)}`;

let root: string;
let api: Server;
let apiPort: number;
let healthChecks: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dl-setup-"));
  healthChecks = [];
  // Autopilot on the server's loopback, reached only through the (fake) tunnel.
  api = createServer((req, res) => {
    healthChecks.push(String(req.headers.authorization));
    const ok = req.url === "/api/v1/health" && req.headers.authorization === `Bearer ${TOKEN}`;
    res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
    res.end(ok ? '{"status":"ok","capabilities":[]}' : '{"error":{"code":"invalid_credential","message":"no"}}');
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  apiPort = typeof address === "object" && address ? address.port : 0;
});

afterEach(async () => {
  api.closeAllConnections();
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

function deps(server: FakeSshServer, answers: Record<string, string>, extra: Partial<SetupDeps> = {}) {
  const ui = new RecordingUi();
  const prompter = new ScriptedPrompter(answers);
  let text = "";
  const tunnels = fakeTunnels(apiPort, { delayMs: 5 });
  const value: SetupDeps = {
    newUi: () => ui,
    prompter,
    write: (chunk) => { text += chunk; },
    color: false,
    ssh: server.exec,
    open: createOpener({ spawn: tunnels.spawn, pollMs: 5 }),
    sources: {
      env: {},
      home: "/home/me",
      readFile: async (path) => {
        if (path === "/home/me/.ssh/config") return "Host box\n  HostName 203.0.113.10\n  User root\n\nHost *\n  ServerAliveInterval 30\n";
        if (path === "/home/me/.config/kimiflare/config.json") return JSON.stringify({ openrouterApiKey: OR });
        return undefined;
      },
      listDir: async () => ["config", "id_ed25519", "id_ed25519.pub", "work", "work.pub"],
      gh: async () => GH,
      fetch: (async (url: string | URL) => String(url).includes("github") ? Response.json({ login: "sinameraji" }) : Response.json({})) as typeof fetch,
    },
    hostname: "sinas-mbp.local",
    remotesFile: join(root, "remotes.json"),
    now: () => new Date("2026-10-28T09:00:00.000Z"),
    ...extra,
  };
  return { deps: value, ui, prompter, text: () => text, tunnels };
}

describe("dl setup on a laptop", () => {
  it("sets up a server from ~/.ssh/config with the laptop's keys, then asks nothing the second time", async () => {
    const server = new FakeSshServer();
    const first = deps(server, { Where: "2", Server: "1", "Use your GitHub CLI login (sinameraji)? It stays on your server.": "", "Use the OpenRouter key from Autopilot?": "" });
    const remote = await setupWizard(first.deps);

    assert.match(first.text(), /Directionally Local\n  Background coding agents\. Where should they run\?/);
    assert.match(first.text(), /1 {2}On this computer {7}start now · nothing to rent · pauses when this computer sleeps/);
    assert.match(first.text(), /2 {2}On my own server {7}keeps going when your laptop is closed · needs SSH access/);
    assert.match(first.text(), /1 {2}box {20}root@203\.0\.113\.10\n {2}2 {2}Another server/);
    const events = first.ui.events;
    assert.ok(events.includes("answered Where | On my own server"));
    assert.ok(events.includes("done ssh | root@203.0.113.10  Ubuntu 24.04 · arm64"), events.join("\n"));
    assert.ok(events.some((event) => /^line info New server \| first connection: trusted its host key/.test(event)));
    assert.ok(events.includes("done Installing dl | 0.2.0"));
    assert.ok(events.includes("done image | built"));
    assert.ok(events.includes("done access | private · reached over SSH"));
    assert.ok(events.includes("line done This laptop | connected as box"));
    assert.ok(events.includes("ready Ready · fits ~6 agents at once (estimate)"));
    assert.ok(events.includes('item From any GitHub repository | dl run "fix the flaky checkout test"'));
    assert.ok(events.includes("item See progress, then check out the result | dl runs\ndl pull ID"));

    // The keys went to the server on stdin, never in a command line.
    const install = server.calls.find((call) => call.command.includes("--answers-stdin"))!;
    assert.deepEqual(JSON.parse(install.input!), { githubToken: GH, openrouterKey: OR });
    for (const call of server.calls) assert.ok(!call.command.includes(GH) && !call.command.includes(OR));
    assert.deepEqual(server.paired, ["sinas-mbp (dl)"]);

    const expected: RemoteServer = {
      name: "box", url: "http://127.0.0.1:4096", token: TOKEN, credentialId: "cred-1", expiresAt: "2027-01-01T00:00:00.000Z", addedAt: "2026-10-28T09:00:00.000Z", ssh: { target: "box" },
    };
    assert.deepEqual(remote, expected);
    assert.deepEqual(await loadRemotes(join(root, "remotes.json")), [expected]);
    assert.ok(first.tunnels.spawned.length > 0 && first.tunnels.spawned.every((tunnel) => tunnel.killed), "every tunnel was closed");

    const again = deps(server, { Where: "2", Server: "1" });
    await setupWizard(again.deps);
    assert.deepEqual(again.prompter.asked, ["Where", "Server"], "no key questions for a configured server");
    assert.ok(again.ui.events.includes("line done Keys | already on the server"));
    assert.deepEqual(server.paired, ["sinas-mbp (dl)"], "the saved credential still works, so no second pairing");
    assert.equal((await loadRemotes(join(root, "remotes.json"))).length, 1);
  });

  it("tries the keys in ~/.ssh without asking when the server refuses the default ones", async () => {
    const server = new FakeSshServer();
    server.acceptedKeys = ["/home/me/.ssh/work"];
    const run = deps(server, { Where: "2", "Server address": "admin@198.51.100.7:2222", Server: "2", "Use your GitHub CLI": "y", "Use the OpenRouter key": "y" });
    server.probe = "1000\nadmin\ndebian 12\nx86_64\nsudo\n";
    const remote = await setupWizard(run.deps);
    const events = run.ui.events;
    assert.ok(!events.some((event) => event.startsWith("fail")), "a refused default key isn't a failure");
    assert.ok(!run.prompter.asked.includes("SSH key"), "nothing to pick");
    const ssh = events.slice(events.indexOf("plan ssh"), events.findIndex((event) => event.startsWith("done ssh")) + 1);
    assert.deepEqual(ssh, ["plan ssh", "start ssh", "plan keys", "start keys", "start keys", "plan ssh", "done ssh | admin@198.51.100.7:2222 with ~/.ssh/work · Debian 12 · x86_64"]);
    assert.ok(events.some((event) => event.startsWith("line info New server")), "the host key saved on the refused try is still reported");
    const probes = server.calls.filter((call) => call.command.startsWith("id -u")).map((call) => call.access.identityFile);
    assert.deepEqual(probes, [undefined, "/home/me/.ssh/id_ed25519", "/home/me/.ssh/work"], "ssh's defaults, then id_* first, then the rest");
    assert.deepEqual(remote?.ssh, { target: "admin@198.51.100.7", port: 2222, identityFile: "/home/me/.ssh/work" });
    assert.equal(remote?.name, "198-51-100-7", "no hostname from the server: its address");
    assert.ok(server.calls.slice(probes.length).every((call) => call.access.identityFile === "/home/me/.ssh/work"), "the working key is used from then on");
    const commands = server.calls.map((call) => call.command);
    assert.ok(commands.some((command) => command.includes("sudo -n env DL_INSTALL_ONLY=1 sh /tmp/dl-install.sh")));
    assert.ok(commands.includes("sudo -n dl up --needs --access ssh"));
    assert.ok(commands.includes("sudo -n dl up --access ssh --answers-stdin --events json"));
    assert.ok(events.includes("done access | private · reached over SSH"));
  });

  it("names a typed server after its own hostname, and keeps names unique", async () => {
    const remotesFile = join(root, "remotes.json");
    const other: RemoteServer = { name: "ubuntu-4gb-nbg1-1", url: "http://127.0.0.1:4096", token: "aster_other", credentialId: "c", expiresAt: "2027-01-01T00:00:00.000Z", addedAt: "2026-10-01T00:00:00.000Z", ssh: { target: "root@192.0.2.1" } };
    await saveRemote(other, remotesFile);
    const server = new FakeSshServer();
    server.probe = "0\nroot\nubuntu 24.04\naarch64\nroot\nUbuntu-4GB-nbg1-1\n";
    const run = deps(server, { Where: "2", "Server address": "root@91.107.187.162", Server: "2", "GitHub CLI": "y", "OpenRouter key": "y" });
    const remote = await setupWizard(run.deps);
    assert.equal(remote?.name, "ubuntu-4gb-nbg1-1-2");
    assert.ok(run.ui.events.includes("line done This laptop | connected as ubuntu-4gb-nbg1-1-2"));

    assert.equal(serverLabel("Web_01.prod"), "web-01-prod");
    assert.equal(serverLabel("localhost"), undefined);
    assert.equal(serverLabel("---"), undefined);
    assert.equal(serverLabel("a".repeat(60))?.length, 36, "room for -2");
  });

  it("uses only the key named with --identity", async () => {
    const server = new FakeSshServer();
    server.acceptedKeys = ["/home/me/keys/hetzner"];
    const run = deps(server, { Where: "2", Server: "root@203.0.113.10", "GitHub CLI": "y", "OpenRouter key": "y" }, { identityFile: "/home/me/keys/hetzner" });
    const remote = await setupWizard(run.deps);
    assert.equal(server.calls.filter((call) => call.command.startsWith("id -u")).length, 1);
    assert.ok(run.ui.events.includes("done ssh | root@203.0.113.10 with ~/keys/hetzner · Ubuntu 24.04 · arm64"));
    assert.deepEqual(remote?.ssh, { target: "root@203.0.113.10", identityFile: "/home/me/keys/hetzner" });
    assert.equal(remote?.name, "ubuntu-4gb-nbg1-1");

    const refused = new FakeSshServer();
    refused.acceptedKeys = [];
    const again = deps(refused, { Where: "2", Server: "root@203.0.113.10" }, { identityFile: "/home/me/.ssh/work" });
    await assert.rejects(() => setupWizard(again.deps), /root@203\.0\.113\.10 didn't accept ~\/\.ssh\/work\.[\s\S]*ssh-copy-id -i ~\/\.ssh\/id_ed25519\.pub root@203\.0\.113\.10/);
    assert.equal(refused.calls.length, 1, "no search when a key was named");
    assert.ok(again.ui.events.includes("fail ssh | ~/.ssh/work not accepted"));
  });

  it("explains what to do when no key works", async () => {
    const server = new FakeSshServer();
    server.acceptedKeys = [];
    const run = deps(server, { Where: "2", Server: "root@203.0.113.10" });
    await assert.rejects(() => setupWizard(run.deps), (error: Error) => {
      assert.equal(error.message, [
        "root@203.0.113.10 didn't accept this computer's SSH keys (the default ones, ~/.ssh/id_ed25519, ~/.ssh/work).",
        "  Add your public key to the server (it asks for the password once):",
        "     ssh-copy-id -i ~/.ssh/id_ed25519.pub root@203.0.113.10",
        "  If your key has a passphrase, load it first with: ssh-add",
        "  Or name the key this server takes: dl setup --identity ~/.ssh/KEY",
      ].join("\n"));
      return true;
    });
    assert.equal(server.calls.filter((call) => call.command.startsWith("id -u")).length, 3);
    assert.deepEqual(run.ui.events.filter((event) => event.startsWith("fail")), ["fail ssh | none of your SSH keys was accepted"], "one failure, at the end");
  });

  it("suggests making a key when ~/.ssh has none", async () => {
    const server = new FakeSshServer();
    server.acceptedKeys = [];
    const run = deps(server, { Where: "2", Server: "me@203.0.113.10:2222" });
    run.deps.sources.listDir = async () => ["config", "known_hosts"];
    await assert.rejects(() => setupWizard(run.deps), /\(the default ones\)[\s\S]*ssh-keygen -t ed25519\n {5}ssh-copy-id -i ~\/\.ssh\/id_ed25519\.pub -p 2222 me@203\.0\.113\.10/);
    assert.ok(run.ui.events.includes("fail ssh | SSH key not accepted"));
  });

  it("stops before installing anything on an unsupported OS", async () => {
    const server = new FakeSshServer();
    server.probe = "0\nroot\nubuntu 20.04\nx86_64\nroot\n";
    const run = deps(server, { Where: "2", Server: "root@203.0.113.10" });
    await assert.rejects(() => setupWizard(run.deps), /runs Ubuntu 20\.04; Directionally Local needs/);
    assert.equal(server.calls.length, 1);
  });

  it("says on-this-computer is coming soon when it isn't built in", async () => {
    const server = new FakeSshServer();
    const run = deps(server, { Where: "", "Set up on your own server instead?": "n" });
    assert.equal(await setupWizard(run.deps), undefined);
    assert.ok(run.ui.events.includes("line info On this computer | coming soon"));
    assert.equal(server.calls.length, 0);
  });

  it("hands on-this-computer to localSetup with the keys, and saves what it returns", async () => {
    const local: RemoteServer = { name: "this-computer", url: "http://127.0.0.1:4096", token: "aster_x", credentialId: "c", expiresAt: "2027-01-01T00:00:00.000Z", addedAt: "2026-10-28T09:00:00.000Z" };
    let received: Parameters<LocalSetup>[0]["answers"] | undefined;
    const run = deps(new FakeSshServer(), { Where: "1", "GitHub CLI": "", "Autopilot": "" }, {
      localSetup: async ({ answers }) => { received = answers; return local; },
    });
    assert.deepEqual(await setupWizard(run.deps), local);
    assert.deepEqual(received, { githubToken: GH, openrouterKey: OR });
    assert.deepEqual(await loadRemotes(join(root, "remotes.json")), [local]);
    assert.ok(run.ui.events.includes("ready Ready"));
  });
});
