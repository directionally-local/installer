import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addSignedAptRepo, DOCKER_FINGERPRINT, dockerRepo, parseFingerprint, requireCodename, supportedCodename, tailscaleRepo, TAILSCALE_FINGERPRINT,
} from "./apt-repo.js";
import { FakeSystem } from "./test-support/fake-system.js";

const UBUNTU = { id: "ubuntu", codename: "noble", prettyName: "Ubuntu 24.04.1 LTS" };

describe("apt repositories", () => {
  it("pins the vendors' real signing key fingerprints", () => {
    assert.equal(DOCKER_FINGERPRINT, "9DC858229FC7DD38854AE2D88D81803C0EBFCD88");
    assert.equal(TAILSCALE_FINGERPRINT, "2596A99EAAB33821893C0A79458CA832957F5868");
  });

  it("reads the primary key's fingerprint from gpg's colon output", () => {
    const output = "pub:-:4096:1:0000000000000000:0:::-:::scESC::::::23::0:\nfpr:::::::::9DC858229FC7DD38854AE2D88D81803C0EBFCD88:\nsub:-:4096:1:1111111111111111:0::::::e::::::23:\nfpr:::::::::D3306A018370199E527AE7997EA0A9C3F273FCD8:\n";
    assert.equal(parseFingerprint(output), DOCKER_FINGERPRINT);
    assert.equal(parseFingerprint(""), undefined);
  });

  it("refuses a key file with more than one primary key", () => {
    const twoKeys = "pub:-:4096:1:0000000000000000:0:::-:::scESC::::::23::0:\nfpr:::::::::9DC858229FC7DD38854AE2D88D81803C0EBFCD88:\npub:-:4096:1:1111111111111111:0:::-:::scESC::::::23::0:\nfpr:::::::::AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:\n";
    assert.equal(parseFingerprint(twoKeys), undefined);
  });

  it("names each keyring for the key's format", () => {
    assert.match(dockerRepo(UBUNTU, "x86_64").keyring, /\.asc$/, "Docker's key is armored");
    assert.match(tailscaleRepo(UBUNTU).keyring, /\.gpg$/, "Tailscale's key is binary");
  });

  it("builds Docker's and Tailscale's deb lines from the distro's codename", () => {
    assert.deepEqual(dockerRepo(UBUNTU, "x86_64"), {
      name: "Docker",
      keyUrl: "https://download.docker.com/linux/ubuntu/gpg",
      keyring: "/etc/apt/keyrings/docker.asc",
      fingerprint: DOCKER_FINGERPRINT,
      line: "[arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable",
      list: "/etc/apt/sources.list.d/docker.list",
    });
    assert.equal(dockerRepo(UBUNTU, "aarch64").line, "[arch=arm64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable");
    assert.deepEqual(tailscaleRepo({ id: "debian", codename: "bookworm", prettyName: "Debian 12" }), {
      name: "Tailscale",
      keyUrl: "https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg",
      keyring: "/etc/apt/keyrings/tailscale.gpg",
      fingerprint: TAILSCALE_FINGERPRINT,
      line: "[signed-by=/etc/apt/keyrings/tailscale.gpg] https://pkgs.tailscale.com/stable/debian bookworm main",
      list: "/etc/apt/sources.list.d/tailscale.list",
    });
  });

  it("refuses a distro or codename the vendor doesn't publish for", () => {
    assert.equal(supportedCodename("ubuntu", "noble"), true);
    assert.equal(supportedCodename("ubuntu", "trusty"), false);
    assert.equal(supportedCodename("fedora", "noble"), false);
    assert.throws(() => requireCodename({ id: "ubuntu", codename: "trusty", prettyName: "Ubuntu 14.04" }, "Docker"), /Docker doesn't publish packages for Ubuntu 14\.04 \(trusty\); use Ubuntu 24\.04 or 22\.04, or Debian 12\./);
    assert.throws(() => dockerRepo({ id: "ubuntu", codename: "trusty", prettyName: "Ubuntu 14.04" }, "x86_64"), /Docker doesn't publish packages/);
    assert.throws(() => tailscaleRepo({ id: "fedora", codename: "", prettyName: "Fedora 41" }), /Tailscale doesn't publish packages for Fedora 41/);
  });

  it("adds the key and the deb line only after the fingerprint matches, with a scrubbed environment", async () => {
    const system = new FakeSystem();
    await addSignedAptRepo(system, dockerRepo(UBUNTU, "x86_64"));
    assert.equal(system.files.get("/etc/apt/keyrings/docker.asc")?.mode, 0o644);
    assert.equal(system.files.get("/etc/apt/sources.list.d/docker.list")?.content, "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable\n");
    assert.ok(system.ran.includes("apt-get update -qq"));
    assert.ok(system.commands.every((command) => command.scrubbed), "no answer or secret reaches a vendor step");
  });

  it("writes nothing when the key isn't the pinned one", async () => {
    const system = new FakeSystem();
    system.keyFingerprints.set("/etc/apt/keyrings/docker.asc.download", "f".repeat(40));
    await assert.rejects(() => addSignedAptRepo(system, dockerRepo(UBUNTU, "x86_64")), /Docker's signing key isn't the pinned one \(fingerprint F{40}, expected 9DC8/);
    assert.equal(system.files.has("/etc/apt/keyrings/docker.asc"), false);
    assert.equal(system.files.has("/etc/apt/sources.list.d/docker.list"), false);
  });

  it("writes nothing when the key file holds a second primary key", async () => {
    const system = new FakeSystem();
    system.keyOutputs.set("/etc/apt/keyrings/docker.asc.download", "pub:-:4096:1:0000000000000000:0:::-:::scESC::::::23::0:\nfpr:::::::::9DC858229FC7DD38854AE2D88D81803C0EBFCD88:\npub:-:4096:1:1111111111111111:0:::-:::scESC::::::23::0:\nfpr:::::::::AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:\n");
    await assert.rejects(() => addSignedAptRepo(system, dockerRepo(UBUNTU, "x86_64")), /Docker's signing key isn't the pinned one \(fingerprint unknown/);
    assert.equal(system.files.has("/etc/apt/keyrings/docker.asc"), false);
    assert.equal(system.files.has("/etc/apt/sources.list.d/docker.list"), false);
  });
});
