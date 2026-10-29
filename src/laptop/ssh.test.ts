import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkServer, describeHost, discoverKeys, parseSshConfig, parseTarget, SshAuthError, sshOptions, type SshExec, type SshResult } from "./ssh.js";

const CONFIG = `
# defaults first, as many people write them
User fallback

Host box
  HostName 203.0.113.10
  User root

Host work work-alias
  HostName=work.example.com
  Port 2222
  IdentityFile ~/.ssh/work_ed25519

Host *.internal !bastion
  User nobody

Match host something
  User matched

Host "quoted"
  HostName quoted.example.com

Host *
  Port 2200
  IdentityFile %d/.ssh/default
`;

function fakeSsh(result: Partial<SshResult>, calls: Array<{ target: string; command: string; identityFile?: string }> = []): SshExec {
  return async (access, command) => {
    calls.push({ target: access.target, command, ...(access.identityFile ? { identityFile: access.identityFile } : {}) });
    return { code: 0, stdout: "", stderr: "", ...result };
  };
}

describe("ssh config", () => {
  it("lists concrete Host entries with their HostName, User, Port, and IdentityFile", () => {
    const hosts = parseSshConfig(CONFIG, "/home/me");
    assert.deepEqual(hosts.map((host) => host.alias), ["box", "work", "work-alias", "quoted"], "wildcards, negations, and Match are skipped");
    assert.deepEqual(hosts[0], { alias: "box", hostName: "203.0.113.10", user: "root", port: 2200, identityFile: "/home/me/.ssh/default" });
    assert.deepEqual(hosts[1], { alias: "work", hostName: "work.example.com", port: 2222, identityFile: "/home/me/.ssh/work_ed25519", user: "fallback" });
    assert.equal(hosts[3]!.hostName, "quoted.example.com");
    assert.equal(describeHost(hosts[0]!), "root@203.0.113.10:2200");
    assert.equal(describeHost({ alias: "plain" }), "plain");
    assert.deepEqual(parseSshConfig("", "/h"), []);
  });

  it("finds private keys that have a .pub next to them, the usual ones first", () => {
    const keys = discoverKeys("/home/me/.ssh", ["config", "known_hosts", "zeta", "zeta.pub", "id_rsa", "id_rsa.pub", "id_ed25519", "id_ed25519.pub", "lonely", "orphan.pub"]);
    assert.deepEqual(keys, ["/home/me/.ssh/id_ed25519", "/home/me/.ssh/id_rsa", "/home/me/.ssh/zeta"]);
  });

  it("parses typed servers and refuses anything that could be an ssh option", () => {
    assert.deepEqual(parseTarget("root@203.0.113.10"), { target: "root@203.0.113.10" });
    assert.deepEqual(parseTarget(" ssh me@box.example.com:2222 "), { target: "me@box.example.com", port: 2222 });
    assert.deepEqual(parseTarget("root@[2001:db8::1]:22"), { target: "root@2001:db8::1" });
    assert.throws(() => parseTarget("-oProxyCommand=evil"), /isn't a server address/);
    assert.throws(() => parseTarget("root@host; rm -rf /"), /isn't a server address/);
    assert.deepEqual(sshOptions({ target: "box", port: 2222, identityFile: "/k" }), [
      "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new", "-p", "2222", "-i", "/k", "-o", "IdentitiesOnly=yes",
    ]);
  });
});

describe("checking the server", () => {
  it("accepts root on Ubuntu 24.04 and notices a new host key", async () => {
    const calls: Array<{ target: string; command: string }> = [];
    const facts = await checkServer({ target: "box" }, fakeSsh({ stdout: "0\nroot\nubuntu 24.04\naarch64\nroot\n", stderr: "Warning: Permanently added '203.0.113.10' (ED25519) to the list of known hosts.\n" }, calls), "box");
    assert.deepEqual(facts, { user: "root", root: true, sudo: false, os: "Ubuntu 24.04", arch: "arm64", newHostKey: true });
    assert.match(calls[0]!.command, /id -u; .*\/etc\/os-release.*uname -m.*hostname -s/);
    const named = await checkServer({ target: "root@203.0.113.10" }, fakeSsh({ stdout: "0\nroot\nubuntu 24.04\nx86_64\nroot\nubuntu-4gb-nbg1-1\n" }), "root@203.0.113.10");
    assert.equal(named.hostname, "ubuntu-4gb-nbg1-1");
  });

  it("accepts passwordless sudo and refuses a user without it", async () => {
    const sudo = await checkServer({ target: "me@h" }, fakeSsh({ stdout: "1000\nme\ndebian 12\nx86_64\nsudo\n" }), "me@h");
    assert.equal(sudo.root, false);
    assert.equal(sudo.sudo, true);
    assert.equal(sudo.os, "Debian 12");
    await assert.rejects(
      () => checkServer({ target: "me@h" }, fakeSsh({ stdout: "1000\nme\nubuntu 24.04\nx86_64\nnosudo\n" }), "me@h"),
      /me on me@h isn't root and can't use sudo without a password[\s\S]*root@h[\s\S]*NOPASSWD/,
    );
  });

  it("stops on an unsupported OS", async () => {
    await assert.rejects(
      () => checkServer({ target: "root@h" }, fakeSsh({ stdout: "0\nroot\nubuntu 20.04\nx86_64\nroot\n" }), "root@h"),
      /runs Ubuntu 20\.04; Directionally Local needs Ubuntu 22\.04, Ubuntu 24\.04, or Debian 12/,
    );
    await assert.rejects(
      () => checkServer({ target: "root@h" }, fakeSsh({ stdout: "0\nroot\nfedora 40\nx86_64\nroot\n" }), "root@h"),
      /runs fedora 40/,
    );
  });

  it("remembers a host key saved on a refused connection", async () => {
    await assert.rejects(
      () => checkServer({ target: "root@h" }, fakeSsh({ code: 255, stderr: "Warning: Permanently added 'h' (ED25519) to the list of known hosts.\nroot@h: Permission denied (publickey).\n" }), "root@h"),
      (error: unknown) => error instanceof SshAuthError && error.newHostKey && /Permission denied \(publickey\)/.test(error.message),
    );
  });

  it("tells an auth failure apart from an unreachable server", async () => {
    await assert.rejects(
      () => checkServer({ target: "root@h" }, fakeSsh({ code: 255, stderr: "root@h: Permission denied (publickey).\n" }), "root@h"),
      (error: unknown) => error instanceof SshAuthError && /didn't accept this computer's SSH key/.test(error.message),
    );
    await assert.rejects(
      () => checkServer({ target: "root@h", port: 2222 }, fakeSsh({ code: 255, stderr: "ssh: connect to host h port 2222: Connection refused\n" }), "root@h"),
      /Couldn't reach root@h over SSH: ssh: connect to host h port 2222: Connection refused[\s\S]*ssh -p 2222 root@h/,
    );
    await assert.rejects(
      () => checkServer({ target: "root@h" }, fakeSsh({ code: 255, stderr: "Host key verification failed.\n" }), "root@h"),
      /host key changed[\s\S]*ssh-keygen -R h/,
    );
  });
});
