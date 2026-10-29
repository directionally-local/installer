import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  defaultRemoteName, loadRemotes, loadRemotesFile, normalizeServerUrl, recordLastUsed, removeRemote, renameRemote, resolveRemote, resolveTarget, saveRemote,
  setDefaultRemote, type RemoteServer,
} from "./config.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function remote(name: string): RemoteServer {
  return { name, url: `https://${name}.example.com`, token: `aster_${name}`, credentialId: `cred-${name}`, expiresAt: "2027-01-01T00:00:00.000Z", addedAt: "2026-10-01T00:00:00.000Z" };
}

describe("remote server config", () => {
  it("requires https except on loopback and strips trailing slashes", () => {
    assert.equal(normalizeServerUrl("https://acme.example.com/"), "https://acme.example.com");
    assert.equal(normalizeServerUrl("acme.example.com"), "https://acme.example.com");
    assert.equal(normalizeServerUrl("http://127.0.0.1:4096"), "http://127.0.0.1:4096");
    assert.throws(() => normalizeServerUrl("http://acme.example.com"), /https/);
    assert.throws(() => normalizeServerUrl("https://user:pw@acme.example.com"), /credentials/);
  });

  it("derives a short default name from the host", () => {
    assert.equal(defaultRemoteName("https://acme.example.com"), "acme");
    assert.equal(defaultRemoteName("https://box.tail1234.ts.net"), "box");
    assert.equal(defaultRemoteName("http://127.0.0.1:4096"), "127-0-0-1");
  });

  it("stores tokens in a private file and resolves by name or the only entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "autopilot-remotes-"));
    roots.push(root);
    const path = join(root, "autopilot", "remotes.json");
    await assert.rejects(() => resolveRemote(undefined, path), /Nothing is set up yet\. Run: dl setup/);

    await saveRemote(remote("acme"), path);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, "autopilot"))).mode & 0o777, 0o700);
    assert.equal((await resolveRemote(undefined, path)).name, "acme");

    await saveRemote(remote("home"), path);
    await saveRemote({ ...remote("acme"), token: "aster_replaced" }, path);
    assert.deepEqual((await loadRemotes(path)).map((entry) => entry.name), ["home", "acme"]);
    assert.equal((await resolveRemote("acme", path)).token, "aster_replaced");
    // The first one saved became the default, so a second doesn't make commands ambiguous.
    assert.deepEqual(await resolveTarget(undefined, path).then((target) => [target.remote.name, target.reason]), ["acme", "default"]);
    await assert.rejects(() => resolveRemote("nope", path), /Nothing named "nope" is set up\. Set up: home, acme/);

    assert.equal(await removeRemote("home", path), true);
    assert.equal(await removeRemote("home", path), false);
    assert.deepEqual((await loadRemotes(path)).map((entry) => entry.name), ["acme"]);
  });

  it("keeps a default: the first place saved, dl use, cleared on remove, then last used", async () => {
    const root = await mkdtemp(join(tmpdir(), "autopilot-remotes-"));
    roots.push(root);
    const path = join(root, "remotes.json");
    await saveRemote(remote("box"), path);
    await saveRemote(remote("this-computer"), path);
    assert.equal((await loadRemotesFile(path)).default, "box", "the first place stays the default");
    assert.deepEqual(await resolveTarget(undefined, path).then((target) => [target.remote.name, target.reason]), ["box", "default"]);
    assert.deepEqual(await resolveTarget("this-computer", path).then((target) => [target.remote.name, target.reason]), ["this-computer", "named"]);

    assert.equal((await setDefaultRemote("this-computer", path)).name, "this-computer");
    assert.equal((await resolveRemote(undefined, path)).name, "this-computer");
    await assert.rejects(() => setDefaultRemote("nope", path), /Nothing named "nope" is set up\. Set up: box, this-computer/);

    await recordLastUsed("box", path);
    assert.equal((await loadRemotesFile(path)).lastUsed, "box");
    assert.equal((await resolveRemote(undefined, path)).name, "this-computer", "the default beats the last used");

    await saveRemote(remote("spare"), path);
    assert.equal(await removeRemote("this-computer", path), true);
    const file = await loadRemotesFile(path);
    assert.equal(file.default, undefined, "removing the default leaves none");
    assert.deepEqual(await resolveTarget(undefined, path).then((target) => [target.remote.name, target.reason]), ["box", "last used"]);

    assert.equal(await removeRemote("box", path), true);
    assert.deepEqual(await resolveTarget(undefined, path).then((target) => [target.remote.name, target.reason]), ["spare", "only"]);
    await saveRemote(remote("again"), path);
    assert.equal((await loadRemotesFile(path)).default, "spare", "with no default, the existing first entry becomes it");
  });

  it("asks for --server or dl use when several are set up and none is the default", async () => {
    const root = await mkdtemp(join(tmpdir(), "autopilot-remotes-"));
    roots.push(root);
    const path = join(root, "remotes.json");
    // As Autopilot's `remote add` writes it: no default, no last used.
    await writeFile(path, JSON.stringify({ version: 1, remotes: [remote("acme"), remote("home")] }));
    await assert.rejects(() => resolveRemote(undefined, path), /Several places are set up \(acme, home\)\. Pick one with --server NAME, or set a default: dl use NAME/);
  });

  it("writes the default as optional top-level fields Autopilot's loader ignores, and drops stale names", async () => {
    const root = await mkdtemp(join(tmpdir(), "autopilot-remotes-"));
    roots.push(root);
    const path = join(root, "autopilot", "remotes.json");
    await saveRemote(remote("acme"), path);
    await recordLastUsed("acme", path);
    const written = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(written), ["version", "remotes", "default", "lastUsed"]);
    assert.equal(written.version, 1);
    assert.deepEqual(written.remotes, [remote("acme")], "the entries are unchanged");

    // A default naming nothing (renamed or removed elsewhere) is ignored, not an error.
    await mkdir(join(root, "other"), { recursive: true });
    const stale = join(root, "other", "remotes.json");
    await writeFile(stale, JSON.stringify({ version: 1, remotes: [remote("acme"), remote("home")], default: "gone", lastUsed: "home" }));
    assert.deepEqual(await loadRemotesFile(stale), { remotes: [remote("acme"), remote("home")], lastUsed: "home" });
    assert.equal((await resolveRemote(undefined, stale)).name, "home");
  });
});

describe("renaming a server", () => {
  it("renames in place, moves the default and last-used pointers, and refuses bad or taken names", async () => {
    const root = await mkdtemp(join(tmpdir(), "autopilot-remotes-"));
    roots.push(root);
    const path = join(root, "remotes.json");
    await saveRemote(remote("91-107-187-162"), path);
    await saveRemote(remote("home"), path);
    // Fields this version doesn't write itself are kept as they are.
    const file = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...file, default: "91-107-187-162", lastUsed: "91-107-187-162", extra: 1 }));

    await renameRemote("91-107-187-162", "hetzner", path);
    const after = JSON.parse(await readFile(path, "utf8")) as { remotes: RemoteServer[]; default: string; lastUsed: string; extra: number; version: number };
    assert.deepEqual(after.remotes.map((entry) => entry.name), ["hetzner", "home"], "same place in the list");
    assert.equal(after.remotes[0]!.token, "aster_91-107-187-162", "only the name changes");
    // Like every other write to this file, rename keeps the known fields (unknown ones aren't carried).
    assert.deepEqual([after.version, after.default, after.lastUsed], [1, "hetzner", "hetzner"]);
    assert.equal((await stat(path)).mode & 0o777, 0o600);

    await renameRemote("home", "office", path);
    assert.equal((JSON.parse(await readFile(path, "utf8")) as { default: string }).default, "hetzner", "pointers to other servers stay");
    await assert.rejects(() => renameRemote("office", "hetzner", path), /already a server named "hetzner"/);
    await assert.rejects(() => renameRemote("office", "Bad Name", path), /"Bad Name" can't be a server name/);
    await assert.rejects(() => renameRemote("nope", "x", path), /No server named "nope"\. Connected: hetzner, office/);
    await renameRemote("office", "office", path);
  });
});
