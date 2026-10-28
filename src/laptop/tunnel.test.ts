import { createServer, type Server } from "node:http";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fakeTunnels } from "../test-support/fake-tunnel.js";
import type { RemoteServer } from "./config.js";
import { acceptsConnections, Connections, createOpener, pickFreePort, tunnelArgs } from "./tunnel.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
});

/** A loopback HTTP server standing in for Autopilot on the server's port 4096. */
async function api(): Promise<number> {
  const server = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"status":"ok"}'); });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

const sshRemote: RemoteServer = {
  name: "box", url: "http://127.0.0.1:4096", token: "aster_t", credentialId: "c", expiresAt: "2027-01-01T00:00:00.000Z", addedAt: "2026-10-28T00:00:00.000Z",
  ssh: { target: "root@203.0.113.10", port: 2222, identityFile: "/home/me/.ssh/id_ed25519" },
};

describe("SSH tunnel", () => {
  it("forwards a free local port to the server's loopback, waits for it, and closes it", async () => {
    const upstream = await api();
    const { spawn, spawned } = fakeTunnels(upstream, { delayMs: 150 });
    const open = createOpener({ spawn, pollMs: 20 });
    const endpoint = await open(sshRemote);
    const port = Number(new URL(endpoint.url).port);
    assert.match(endpoint.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.deepEqual(spawned[0]!.args, tunnelArgs(sshRemote.ssh!, port, 4096));
    assert.deepEqual(spawned[0]!.args.slice(0, 3), ["-N", "-o", "ExitOnForwardFailure=yes"]);
    assert.ok(spawned[0]!.args.includes("BatchMode=yes"));
    assert.deepEqual(spawned[0]!.args.slice(-3), ["-L", `127.0.0.1:${port}:127.0.0.1:4096`, "root@203.0.113.10"]);
    assert.ok(["-p", "2222", "-i", "/home/me/.ssh/id_ed25519"].every((arg) => spawned[0]!.args.includes(arg)));

    const response = await fetch(`${endpoint.url}/api/v1/health`);
    assert.deepEqual(await response.json(), { status: "ok" });

    await endpoint.close();
    assert.equal(spawned[0]!.killed, true);
    assert.equal(spawned[0]!.exitCode, 0);
    assert.equal(await acceptsConnections(port), false, "the port is released");
  });

  it("leaves servers without ssh alone", async () => {
    const { spawn, spawned } = fakeTunnels();
    const endpoint = await createOpener({ spawn })({ ...sshRemote, url: "https://box.example.com", ssh: undefined } as RemoteServer);
    assert.equal(endpoint.url, "https://box.example.com");
    assert.equal(spawned.length, 0);
  });

  it("explains a tunnel that ssh gives up on, and one that never comes up", async () => {
    const failing = fakeTunnels(undefined, { failWith: "root@203.0.113.10: Permission denied (publickey)." });
    await assert.rejects(() => createOpener({ spawn: failing.spawn, pollMs: 10 })(sshRemote), /Couldn't open an SSH tunnel to box \(root@203\.0\.113\.10\): root@203\.0\.113\.10: Permission denied \(publickey\)\.[\s\S]*Check that this works: ssh -p 2222/);

    const slow = fakeTunnels(undefined, { delayMs: 10_000 });
    await assert.rejects(() => createOpener({ spawn: slow.spawn, timeoutMs: 100, pollMs: 10 })(sshRemote), /Timed out after 0s opening an SSH tunnel to box/);
    assert.equal(slow.spawned[0]!.killed, true, "a tunnel that timed out is closed");
  });

  it("opens one tunnel per server per command and closes them all", async () => {
    let opened = 0;
    let closed = 0;
    const connections = new Connections(async (remote) => {
      opened++;
      return { url: `http://127.0.0.1:1/${remote.name}`, close: async () => { closed++; } };
    });
    await connections.client(sshRemote);
    await connections.client(sshRemote);
    await connections.client({ ...sshRemote, name: "other" });
    assert.equal(opened, 2);
    await connections.close();
    assert.equal(closed, 2);
  });

  it("picks a port nothing is listening on", async () => {
    const port = await pickFreePort();
    assert.ok(port > 0);
    assert.equal(await acceptsConnections(port), false);
  });
});
