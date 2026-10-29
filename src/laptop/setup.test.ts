import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeSshServer } from "../test-support/fake-ssh.js";
import { fakeTunnels } from "../test-support/fake-tunnel.js";
import { ScriptedPrompter, type SelectOption, type SelectResult } from "../prompt.js";
import { RecordingUi } from "../ui.js";
import { loadRemotes, loadRemotesFile, saveRemote, type RemoteServer } from "./config.js";
import { loadSettings } from "./settings.js";
import { serverLabel, setupWizard, type LocalSetup, type SetupDeps } from "./setup.js";
import { withCatalog } from "../test-support/fake-catalog.js";
import { createOpener } from "./tunnel.js";

const GH = `gho_${"a".repeat(36)}`;
const OR = "sk-or-v1-fromautopilot0000";
const TOKEN = `aster_laptop_token_${"0".repeat(34)}`;

/** A ScriptedPrompter that also keeps each list it was shown. */
class RecordingSelect extends ScriptedPrompter {
  readonly selects: Array<{ question: string; options: SelectOption[]; initial: number }> = [];
  override async select(question: string, options: SelectOption[], initial = 0): Promise<SelectResult> {
    this.selects.push({ question, options, initial });
    return super.select(question, options, initial);
  }
}

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
  const prompter = new ScriptedPrompter({ Model: "", ...answers });
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
    settingsFile: join(root, "config.json"),
    // The same on every machine the tests run on (Windows has its own test).
    platform: "linux",
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
    assert.ok(!/\d {2}On this computer/.test(first.text()), "the places are a list to pick from, not printed numbers");
    const events = first.ui.events;
    assert.ok(events.includes("answered Where | On my own server"));
    assert.ok(events.includes("done ssh | root@203.0.113.10  Ubuntu 24.04 · arm64"), events.join("\n"));
    assert.ok(events.some((event) => /^line info New server \| first connection: trusted its host key/.test(event)));
    assert.ok(events.includes("done Installing dl | 0.2.0"));
    assert.ok(events.includes("done image | built"));
    assert.ok(events.includes("done access | private · reached over SSH"));
    assert.ok(events.includes("line done This laptop | connected as box"));
    assert.ok(events.includes("questions 2 keys, kept on your server only; then it sets itself up."));
    assert.deepEqual(events.slice(events.indexOf("ready Ready · fits ~6 agents at once (estimate)")), [
      "ready Ready · fits ~6 agents at once (estimate)",
      "item Start a session: cd into a GitHub repository, then type | dl",
      'item Or hand off a one-off task | dl run "fix the flaky checkout test"',
      "footer dl status shows where agents run and what they're doing.",
    ]);
    assert.ok(!first.prompter.asked.some((question) => question.includes("by default")), "the first place becomes the default without asking");

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
    assert.deepEqual(again.prompter.asked, ["Where", "Server"], "no key or model questions the second time");
    assert.ok(again.ui.events.includes("line done Keys | already on the server"));
    assert.deepEqual(server.paired, ["sinas-mbp (dl)"], "the saved credential still works, so no second pairing");
    assert.equal((await loadRemotes(join(root, "remotes.json"))).length, 1);
  });

  it("asks for the model once, with Autopilot's preselected and OpenRouter's prices shown", async () => {
    const server = new FakeSshServer();
    const run = deps(server, { Where: "2", Server: "1", "Use your GitHub CLI": "", "Use the OpenRouter key": "" });
    const prompter = new RecordingSelect({ Model: "", Where: "2", Server: "1", "Use your GitHub CLI": "", "Use the OpenRouter key": "" });
    run.deps.prompter = prompter;
    const { readFile } = run.deps.sources;
    run.deps.sources = {
      ...run.deps.sources,
      readFile: async (path) => path === "/home/me/.config/kimiflare/config.json" ? JSON.stringify({ openrouterApiKey: OR, model: "moonshotai/kimi-k2.6" }) : readFile(path),
      fetch: withCatalog(run.deps.sources.fetch!),
    };
    await setupWizard(run.deps);
    const shown = prompter.selects.find((entry) => entry.question === "Model")!;
    assert.equal(shown.options[shown.initial]!.value, "moonshotai/kimi-k2.6");
    assert.match(shown.options[shown.initial]!.detail ?? "", /\$0\.6 in \/ \$2\.5 out per M tokens/);
    assert.ok(run.ui.events.includes("answered Model | moonshotai/kimi-k2.6  (change it any time: dl model)"));
    assert.equal((await loadSettings(join(root, "config.json"))).model, "moonshotai/kimi-k2.6");
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
      localSetup: async ({ answers }) => { received = answers; return { remote: local, capacity: 4 }; },
    });
    assert.deepEqual(await setupWizard(run.deps), local);
    assert.deepEqual(received, { githubToken: GH, openrouterKey: OR });
    assert.deepEqual(await loadRemotes(join(root, "remotes.json")), [local]);
    const events = run.ui.events;
    assert.ok(events.includes("questions 2 keys, kept on this computer only; then it sets itself up."), events.join("\n"));
    assert.ok(run.prompter.asked.includes("Use your GitHub CLI login (sinameraji)? It stays on this computer."), run.prompter.asked.join("\n"));
    assert.ok(run.prompter.asked.includes("Use the OpenRouter key from Autopilot? It stays on this computer."));
    assert.ok(!events.some((event) => event.includes("your server")), "nothing says 'server' for this computer");
    assert.ok(events.includes("ready Ready · fits ~4 agents at once (estimate)"));
    assert.ok(!run.prompter.asked.some((question) => question.includes("by default")), "one place: no default question");
  });

  describe("this computer after a server", () => {
    const local: RemoteServer = { name: "this-computer", url: "http://127.0.0.1:4096", token: "aster_x", credentialId: "c", expiresAt: "2027-01-01T00:00:00.000Z", addedAt: "2026-10-28T09:00:00.000Z" };
    const QUESTION = "Make this computer the default? Tasks and sessions go to box now";
    const KEYS = { Where: "1", "GitHub CLI": "", "Autopilot": "" };
    const localRun = (server: FakeSshServer, answers: Record<string, string>, extra: Partial<SetupDeps> = {}) =>
      deps(server, { ...KEYS, ...answers }, { localSetup: async () => ({ remote: local, capacity: 4 }), ...extra });

    /** A server set up first: it becomes the default by itself. */
    async function serverFirst(): Promise<FakeSshServer> {
      const server = new FakeSshServer();
      await setupWizard(deps(server, { Where: "2", Server: "1", "GitHub CLI": "", "Autopilot": "" }).deps);
      assert.equal((await loadRemotesFile(join(root, "remotes.json"))).default, "box");
      return server;
    }

    it("asks once whether this computer should be the default, and Enter makes it so", async () => {
      const server = await serverFirst();
      const run = localRun(server, { [QUESTION]: "" });
      await setupWizard(run.deps);
      assert.ok(run.prompter.asked.includes(QUESTION), run.prompter.asked.join("\n"));
      assert.equal((await loadRemotesFile(join(root, "remotes.json"))).default, "this-computer");
      assert.ok(run.ui.events.includes("answered Default | this computer"));
      assert.equal((await loadSettings(join(root, "config.json"))).askedLocalDefault, true);

      // Already the default: a re-run asks nothing and says nothing about it.
      const again = localRun(server, {});
      await setupWizard(again.deps);
      assert.ok(!again.prompter.asked.some((question) => question.includes("default")));
      assert.ok(!again.ui.events.some((event) => event.includes("Default")));
    });

    it("keeps the server on no, says how to change it, and doesn't ask again on a re-run", async () => {
      const server = await serverFirst();
      const run = localRun(server, { [QUESTION]: "n" });
      await setupWizard(run.deps);
      assert.equal((await loadRemotesFile(join(root, "remotes.json"))).default, "box");
      assert.ok(run.ui.events.includes("line info Default | still box · dl use this-computer to run here instead"), run.ui.events.join("\n"));

      const again = localRun(server, {});
      await setupWizard(again.deps);
      assert.ok(!again.prompter.asked.some((question) => question.includes("default")), "asked once");
      assert.ok(again.ui.events.includes("line info Default | still box · dl use this-computer to run here instead"));
      assert.equal((await loadRemotesFile(join(root, "remotes.json"))).default, "box");
    });

    it("asks on a re-run when this computer was set up before dl asked", async () => {
      const server = await serverFirst();
      await saveRemote(local, join(root, "remotes.json"));
      assert.equal((await loadRemotesFile(join(root, "remotes.json"))).default, "box");
      const run = localRun(server, { [QUESTION]: "y" });
      await setupWizard(run.deps);
      assert.equal((await loadRemotesFile(join(root, "remotes.json"))).default, "this-computer");
    });

    it("without a terminal keeps the default and prints dl use this-computer", async () => {
      const server = await serverFirst();
      const run = localRun(server, {}, { interactive: false });
      await setupWizard(run.deps);
      assert.ok(!run.prompter.asked.some((question) => question.includes("default")));
      assert.equal((await loadRemotesFile(join(root, "remotes.json"))).default, "box");
      assert.ok(run.ui.events.includes("line info Default | still box · dl use this-computer to run here instead"));
      assert.equal((await loadSettings(join(root, "config.json"))).askedLocalDefault, undefined, "a later run at a terminal still asks");
    });
  });

  it("on Windows doesn't offer this computer: says why, then sets up a server", async () => {
    const server = new FakeSshServer();
    let called = false;
    const run = deps(server, { Server: "1", "GitHub CLI": "", "Autopilot": "" }, {
      platform: "win32",
      localSetup: async () => { called = true; throw new Error("not on Windows"); },
    });
    const remote = await setupWizard(run.deps);
    assert.equal(remote?.name, "box");
    assert.equal(called, false);
    assert.ok(!run.prompter.asked.some((question) => question.includes("Where")), "no choice with one real option");
    const info = run.ui.events.find((event) => event.startsWith("line info On this computer"));
    assert.match(info ?? "", /isn't supported on Windows yet; connect a server instead[\s\S]*WSL 2/);
    assert.ok(run.ui.events.includes("answered Where | On my own server"));
  });
});
