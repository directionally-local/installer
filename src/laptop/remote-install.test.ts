import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeSshServer } from "../test-support/fake-ssh.js";
import { PlainUi, RecordingUi } from "../ui.js";
import { applyOnServer, bootstrap, bootstrapCommand, BootstrapRenderer, ensureServerDl, EventReplayer, installOnServer, pairLaptop, planServerDl, serverDlVersion, serverNeeds, wireAnswers, type DlRegistry } from "./remote-install.js";
import { openrouterAnswer } from "../provider.js";
import type { ServerFacts } from "./ssh.js";
import { dlVersion } from "../versions.js";

const root: ServerFacts = { user: "root", root: true, sudo: false, os: "Ubuntu 24.04", arch: "arm64", newHostKey: false };
const sudoer: ServerFacts = { ...root, user: "me", root: false, sudo: true };
const box = { target: "box" };

describe("installing over SSH", () => {
  it("bootstraps with install.sh, under sudo -n when not root", () => {
    assert.equal(bootstrapCommand(root, undefined, "0.10.1"), "curl -fsSL 'https://directionallylocal.run' -o /tmp/dl-install.sh && DL_INSTALL_ONLY=1 DL_VERSION=0.10.1 sh /tmp/dl-install.sh");
    assert.equal(bootstrapCommand(sudoer, undefined, "0.10.1"), "curl -fsSL 'https://directionallylocal.run' -o /tmp/dl-install.sh && sudo -n env DL_INSTALL_ONLY=1 DL_VERSION=0.10.1 sh /tmp/dl-install.sh");
  });

  it("installs this laptop's own dl version on the server, never npm's latest", async () => {
    assert.match(bootstrapCommand(root), new RegExp(`DL_INSTALL_ONLY=1 DL_VERSION=${dlVersion().replace(/\./g, "\\.")} sh /tmp/dl-install\\.sh$`));
    assert.doesNotMatch(bootstrapCommand(sudoer), /latest/);
    assert.match(bootstrapCommand(root, undefined, "1.0.0-rc.1"), /DL_VERSION=1\.0\.0-rc\.1 /);
    for (const bad of ["latest", "1.0", "1.0.0; rm -rf /", "$(id)"]) assert.throws(() => bootstrapCommand(root, undefined, bad), /Not a dl version/);
    const server = new FakeSshServer();
    await bootstrap(box, root, server.exec, new RecordingUi(), undefined, "0.10.1");
    assert.match(server.calls[0]!.command, /DL_VERSION=0\.10\.1 sh/);
  });

  it("installs npm's latest only when told to, with no DL_VERSION", () => {
    assert.equal(bootstrapCommand(root, undefined, null), "curl -fsSL 'https://directionallylocal.run' -o /tmp/dl-install.sh && DL_INSTALL_ONLY=1 sh /tmp/dl-install.sh");
  });

  it("reads the server's dl version, and nothing when it has no dl", async () => {
    const server = new FakeSshServer();
    assert.equal(await serverDlVersion(box, server.exec), undefined);
    server.installed = true;
    server.dlVersion = "0.10.1";
    assert.equal(await serverDlVersion(box, server.exec), "0.10.1");
    assert.equal(server.calls.at(-1)!.command, "command -v dl >/dev/null 2>&1 && dl --version");
    server.dlVersion = "not a version";
    assert.equal(await serverDlVersion(box, server.exec), undefined);
  });

  describe("never downgrading a server's dl", () => {
    const published: DlRegistry = { has: async () => true, latest: async () => "0.10.1" };
    const unpublished: DlRegistry = { has: async () => false, latest: async () => "0.10.1" };
    const offline: DlRegistry = { has: async () => undefined, latest: async () => undefined };
    const plan = (server: string | undefined, laptop: string, registry = published) => planServerDl({ name: "box", server, laptop, registry, update: "curl -fsSL https://directionallylocal.run | sh" });

    it("leaves a newer server as it is and says how to update this laptop", async () => {
      assert.deepEqual(await plan("0.11.0", "0.10.1"), { action: "keep", reason: "newer", message: "box runs dl 0.11.0, newer than this laptop's 0.10.1. Update this laptop: curl -fsSL https://directionallylocal.run | sh" });
      assert.equal((await plan("0.10.10", "0.10.9")).action, "keep", "numeric, not lexicographic");
      assert.equal((await plan("1.0.0", "1.0.0-rc.2")).action, "keep", "a release is newer than its pre-release");
      assert.equal((await plan("1.0.0-rc.10", "1.0.0-rc.2")).action, "keep", "pre-release numbers compare as numbers");
    });

    it("does nothing when the versions are the same", async () => {
      assert.deepEqual(await plan("0.10.1", "0.10.1"), { action: "keep", reason: "same" });
      assert.deepEqual(await plan("0.10.1+build.5", "0.10.1"), { action: "keep", reason: "same" }, "build metadata doesn't count");
    });

    it("upgrades an older server, or one without dl, to this laptop's version", async () => {
      assert.deepEqual(await plan("0.9.3", "0.10.1"), { action: "install", version: "0.10.1" });
      assert.deepEqual(await plan("1.0.0-rc.1", "1.0.0"), { action: "install", version: "1.0.0" });
      assert.deepEqual(await plan(undefined, "0.10.1"), { action: "install", version: "0.10.1" });
      assert.deepEqual(await plan("0.9.3", "0.10.1", offline), { action: "install", version: "0.10.1" }, "npm unreachable: try this laptop's version, as before");
    });

    it("with a development build here, keeps the server's dl, or installs npm's latest on a server without one", async () => {
      assert.deepEqual(await plan("0.10.1", "0.10.2-dev.0", unpublished), {
        action: "keep",
        reason: "unpublished",
        message: "This laptop's dl 0.10.2-dev.0 isn't on npm (a development build?), so box keeps its dl 0.10.1.",
      });
      assert.deepEqual(await plan(undefined, "0.10.2-dev.0", unpublished), {
        action: "install",
        version: "0.10.1",
        message: "This laptop's dl 0.10.2-dev.0 isn't on npm (a development build?), so box gets npm's latest dl (0.10.1) instead.",
      });
      assert.deepEqual(await plan(undefined, "0.10.2-dev.0", { has: async () => false, latest: async () => undefined }), {
        action: "install",
        version: null,
        message: "This laptop's dl 0.10.2-dev.0 isn't on npm (a development build?), so box gets npm's latest dl instead.",
      });
      assert.deepEqual(await plan("0.11.0", "0.10.2-dev.0", unpublished), { action: "keep", reason: "newer", message: "box runs dl 0.11.0, newer than this laptop's 0.10.2-dev.0. Update this laptop: curl -fsSL https://directionallylocal.run | sh" }, "a newer server is left alone either way");
    });

    it("runs the install script only when the plan says so", async () => {
      for (const [installed, expected] of [["0.11.0", false], ["0.10.1", false], ["0.9.0", true]] as const) {
        const server = new FakeSshServer();
        server.installed = true;
        server.dlVersion = installed;
        const said: string[] = [];
        await ensureServerDl(box, root, server.exec, { name: "box", ui: () => new RecordingUi(), say: (line) => said.push(line), registry: published, laptop: "0.10.1" });
        assert.equal(server.calls.some((call) => call.command.includes("dl-install.sh")), expected, installed);
        assert.equal(server.dlVersion, expected ? "0.10.1" : installed);
        assert.equal(said.length, installed === "0.11.0" ? 1 : 0);
      }
    });
  });

  it("turns install.sh's plain lines into checklist steps", async () => {
    const server = new FakeSshServer();
    const ui = new RecordingUi();
    await bootstrap(box, root, server.exec, ui);
    assert.deepEqual(ui.events, ["plan Installing Node.js", "start Installing Node.js", "done Installing Node.js | 24.11.0", "plan Installing Node.js,Installing dl", "start Installing dl", "done Installing dl | 0.2.0"]);

    let out = "";
    const plain = new BootstrapRenderer(new PlainUi((text) => { out += text; }));
    for (const line of [".. Installing Node.js", "ok Installing Node.js: 24.11.0", "ok Checking: fine"]) plain.stdout(line);
    plain.finish(0);
    assert.equal(out, ".. Installing Node.js\nok Installing Node.js: 24.11.0\n.. Checking\nok Checking: fine\n", "one line per event, no repeats");
  });

  it("fails the running step and shows its output when install.sh fails", async () => {
    const server = new FakeSshServer();
    server.bootstrapFails = true;
    const ui = new RecordingUi();
    await assert.rejects(() => bootstrap(box, root, server.exec, ui), /Installing dl on the server failed: Installing Node\.js failed\n {4}E: Unable to locate package nodejs/);
    assert.deepEqual(ui.events.slice(-1), ["fail Installing Node.js | Installing Node.js failed"]);
  });

  it("asks the server what it needs, sends keys on stdin only, and replays its checklist", async () => {
    const server = new FakeSshServer();
    server.installed = true;
    server.keys.add("github");
    assert.deepEqual(await serverNeeds(box, sudoer, server.exec), ["provider"]);
    assert.equal(server.calls[0]!.command, "sudo -n dl up --needs --access ssh");
    server.oldProviderDl = true;
    assert.deepEqual(await serverNeeds(box, sudoer, server.exec), ["provider"], "an older server's \"openrouter\" is the same need");
    server.oldProviderDl = false;

    const uis: RecordingUi[] = [];
    const key = "sk-or-v1-secretsecretsecret";
    const result = await installOnServer(box, root, server.exec, { provider: openrouterAnswer(key) }, () => { const ui = new RecordingUi(); uis.push(ui); return ui; });
    assert.deepEqual(result, { capacity: 6 }, "4 CPU and 7.5 GB fit ~6, as dl up estimates");
    const call = server.calls.at(-1)!;
    assert.equal(call.command, "dl up --access ssh --answers-stdin --events json");
    // The provider block, plus the shorthand an older server understands (it ignores the block).
    assert.deepEqual(JSON.parse(call.input!), { provider: { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: key, apiKeyEnv: "OPENROUTER_API_KEY" }, openrouterKey: key });
    assert.deepEqual(wireAnswers({ provider: { id: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "k", apiKeyEnv: "DEEPSEEK_API_KEY" } }), { provider: { id: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "k", apiKeyEnv: "DEEPSEEK_API_KEY" } }, "no shorthand for other providers");
    assert.deepEqual(wireAnswers({}), {});
    for (const entry of server.calls) assert.ok(!entry.command.includes(key), "keys never go in the command line");
    assert.deepEqual(uis.flatMap((ui) => ui.events), [
      "line done Checked this machine | Ubuntu 24.04 · 4 CPU · 7.5 GB · 70 GB free",
      "line done Provider key | kept in Hotcell · from your laptop",
      "plan docker,image,access",
      "start docker",
      "done docker | 27.3.1",
      "start image",
      "done image | built",
      "start access",
      "done access | private · reached over SSH",
      "warn Swap is off",
    ], "the server's title and ready screen are left out");
  });

  it("stores keys on an installed server quietly, surfacing only a failure", async () => {
    const server = new FakeSshServer();
    server.installed = true;
    await applyOnServer(box, root, server.exec, { githubToken: "ghp_x" });
    assert.deepEqual(server.answers.at(-1), { githubToken: "ghp_x" });
    assert.ok(server.keys.has("github"));
    server.installFails = true;
    await assert.rejects(() => applyOnServer(box, root, server.exec, { githubToken: "ghp_x" }), /Storing the keys on the server failed: Building the sandbox image failed/);
  });

  it("replays the server's last step as Starting the server, private over SSH", async () => {
    const server = new FakeSshServer();
    server.installed = true;
    let out = "";
    await installOnServer(box, root, server.exec, {}, () => new PlainUi((text) => { out += text; }));
    assert.match(out, /\.\. Starting the server\nok Starting the server: private · reached over SSH\n/);
    assert.ok(!out.includes("127.0.0.1"), "no loopback address on the laptop");
  });

  it("shows the failed step and the server's error", async () => {
    const server = new FakeSshServer();
    server.installed = true;
    server.installFails = true;
    const ui = new RecordingUi();
    await assert.rejects(() => installOnServer(box, root, server.exec, {}, () => ui), /Setting up the server failed: Building the sandbox image failed[\s\S]*up\.log[\s\S]*run dl setup again/);
    assert.ok(ui.events.includes("fail image | Cannot connect to the Docker daemon"));
  });

  it("starts a fresh checklist for lines after a plan, and ignores unknown steps and noise", () => {
    let made = 0;
    const replay = new EventReplayer(() => { made++; return new RecordingUi(); });
    replay.line(JSON.stringify({ event: "plan", steps: [{ id: "a", label: "A" }] }));
    replay.line(JSON.stringify({ event: "start", id: "nope" }));
    replay.line("not json at all");
    replay.line(JSON.stringify({ event: "line", status: "info", label: "later" }));
    replay.line(JSON.stringify({ event: "something-new" }));
    assert.equal(made, 2);
    assert.deepEqual(replay.tail(), ["not json at all"]);
  });

  it("pairs this laptop with a quoted name", async () => {
    const server = new FakeSshServer();
    server.installed = true;
    const pairing = await pairLaptop(box, sudoer, server.exec, "Sina's MacBook (dl)");
    assert.equal(server.calls[0]!.command, `sudo -n dl pair --name 'Sina'\\''s MacBook (dl)' --json`);
    assert.equal(pairing.url, "http://127.0.0.1:4096");
    assert.match(pairing.token, /^aster_/);
  });
});
