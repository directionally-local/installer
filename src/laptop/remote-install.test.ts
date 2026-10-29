import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeSshServer } from "../test-support/fake-ssh.js";
import { PlainUi, RecordingUi } from "../ui.js";
import { bootstrap, bootstrapCommand, BootstrapRenderer, EventReplayer, installOnServer, pairLaptop, serverNeeds } from "./remote-install.js";
import type { ServerFacts } from "./ssh.js";

const root: ServerFacts = { user: "root", root: true, sudo: false, os: "Ubuntu 24.04", arch: "arm64", newHostKey: false };
const sudoer: ServerFacts = { ...root, user: "me", root: false, sudo: true };
const box = { target: "box" };

describe("installing over SSH", () => {
  it("bootstraps with install.sh, under sudo -n when not root", () => {
    assert.equal(bootstrapCommand(root), "curl -fsSL 'https://directionallylocal.run' -o /tmp/dl-install.sh && DL_INSTALL_ONLY=1 sh /tmp/dl-install.sh");
    assert.equal(bootstrapCommand(sudoer), "curl -fsSL 'https://directionallylocal.run' -o /tmp/dl-install.sh && sudo -n env DL_INSTALL_ONLY=1 sh /tmp/dl-install.sh");
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
    assert.deepEqual(await serverNeeds(box, sudoer, server.exec), ["openrouter"]);
    assert.equal(server.calls[0]!.command, "sudo -n dl up --needs --access ssh");

    const uis: RecordingUi[] = [];
    const key = "sk-or-v1-secretsecretsecret";
    const result = await installOnServer(box, root, server.exec, { openrouterKey: key }, () => { const ui = new RecordingUi(); uis.push(ui); return ui; });
    assert.deepEqual(result, { capacity: 6 }, "4 CPU and 7.5 GB fit ~6, as dl up estimates");
    const call = server.calls.at(-1)!;
    assert.equal(call.command, "dl up --access ssh --answers-stdin --events json");
    assert.equal(call.input, `${JSON.stringify({ openrouterKey: key })}\n`);
    for (const entry of server.calls) assert.ok(!entry.command.includes(key), "keys never go in the command line");
    assert.deepEqual(uis.flatMap((ui) => ui.events), [
      "line done Checked this machine | Ubuntu 24.04 · 4 CPU · 7.5 GB · 70 GB free",
      "line done OpenRouter key | stored in Hotcell",
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
