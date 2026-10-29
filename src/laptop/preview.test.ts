import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { saveRemote, type RemoteServer } from "./config.js";
import { preview, type PreviewIO } from "./preview.js";
import type { SshExec } from "./ssh.js";
import type { Endpoint } from "./tunnel.js";

const roots: string[] = [];
const previous = process.env.AUTOPILOT_REMOTES_FILE;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "dl-preview-"));
  roots.push(root);
  process.env.AUTOPILOT_REMOTES_FILE = join(root, "remotes.json");
});

afterEach(async () => {
  if (previous === undefined) delete process.env.AUTOPILOT_REMOTES_FILE;
  else process.env.AUTOPILOT_REMOTES_FILE = previous;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function capture(): PreviewIO & { text: () => string } {
  let text = "";
  return { out: (chunk) => { text += chunk; }, err: (chunk) => { text += chunk; }, color: false, text: () => text };
}

function server(name: string, ssh = true): RemoteServer {
  return {
    name,
    url: "http://127.0.0.1:4096",
    token: "t",
    credentialId: "c",
    expiresAt: "2027-01-01T00:00:00.000Z",
    addedAt: "2026-10-28T00:00:00.000Z",
    ...(ssh ? { ssh: { target: "root@203.0.113.10" } } : {}),
  };
}

function fakeSsh(answer: string, code = 0) {
  const commands: string[] = [];
  const exec: SshExec = async (_access, command) => {
    commands.push(command);
    if (command.includes("id -u")) return { code: 0, stdout: "0\nroot\nubuntu 24.04\nx86_64\nroot\nbox\n", stderr: "" };
    return { code, stdout: answer, stderr: code === 0 ? "" : "no preview for that task" };
  };
  return { exec, commands };
}

describe("dl preview on a laptop", () => {
  it("asks the server to deploy, tunnels to the port, and opens it", async () => {
    await saveRemote(server("box"));
    const ssh = fakeSsh(`${JSON.stringify({ id: "3f2a9c1e", port: 8090, url: "http://127.0.0.1:8090" })}\n`);
    const forwarded: Array<{ port: number; display: string | undefined }> = [];
    let closed = false;
    const endpoint: Endpoint = { url: "http://127.0.0.1:54321", close: async () => { closed = true; } };
    const opened: string[] = [];
    const io = capture();

    const code = await preview({ id: "3f2a9c1e" }, {
      ssh: ssh.exec,
      forward: async (_access, port, display) => { forwarded.push({ port, display }); return endpoint; },
      openBrowser: (url) => { opened.push(url); return true; },
      hold: async () => {},
    }, io);

    assert.equal(code, 0);
    assert.ok(ssh.commands.includes("dl preview '3f2a9c1e' --json"), "the server does the work");
    assert.deepEqual(forwarded, [{ port: 8090, display: "box" }]);
    assert.deepEqual(opened, ["http://127.0.0.1:54321"]);
    assert.equal(closed, true, "the tunnel is closed when the command ends");
    assert.match(io.text(), /✓ 3f2a9c1e is live at http:\/\/127\.0\.0\.1:54321/);
    assert.match(io.text(), /Ctrl-C closes the tunnel; the preview keeps running \(dl preview 3f2a9c1e --remove stops it\)/);
  });

  it("reports the server's reason when it can't deploy", async () => {
    await saveRemote(server("box"));
    const ssh = fakeSsh("", 1);
    const io = capture();
    const code = await preview({ id: "3f2a9c1e" }, {
      ssh: ssh.exec,
      forward: async () => { throw new Error("should not tunnel"); },
      openBrowser: () => false,
      hold: async () => {},
    }, io);
    assert.equal(code, 1);
    assert.match(io.text(), /✗ no preview for that task/);
  });

  it("refuses a server this laptop didn't set up over SSH", async () => {
    await saveRemote(server("box", false));
    const io = capture();
    const code = await preview({ id: "3f2a9c1e" }, { ssh: fakeSsh("").exec, hold: async () => {} }, io);
    assert.equal(code, 1);
    assert.match(io.text(), /box wasn't set up over SSH, so this laptop can't reach a preview on it\.\n {2}On the server: dl preview 3f2a9c1e/);
  });
});
