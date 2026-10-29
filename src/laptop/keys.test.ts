import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { KeyListing, KeyName } from "../keys.js";
import { ScriptedPrompter } from "../prompt.js";
import { FakeSshServer } from "../test-support/fake-ssh.js";
import { RecordingUi } from "../ui.js";
import type { RemoteServer } from "./config.js";
import { laptopKeys, type LaptopKeysDeps } from "./keys.js";

const GH = `gho_${"a".repeat(36)}`;
const TYPED_GH = `github_pat_${"t".repeat(40)}`;
const OR = `sk-or-v1-${"f".repeat(30)}`;
const TYPED_OR = `sk-or-v1-${"y".repeat(30)}`;

const box: RemoteServer = {
  name: "box", url: "http://127.0.0.1:4096", token: "aster_x", credentialId: "c1", expiresAt: "2027-01-01T00:00:00.000Z", addedAt: "2026-10-28T09:00:00.000Z",
  ssh: { target: "box" },
};
const thisComputer: RemoteServer = { ...box, name: "this-computer", url: "http://127.0.0.1:4096", ssh: undefined };
delete (thisComputer as Partial<RemoteServer>).ssh;
const connected: RemoteServer = { ...thisComputer, name: "acme", url: "https://acme.example.com" };

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "dl-keys-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function remotes(...entries: RemoteServer[]): Promise<string> {
  const file = join(root, "remotes.json");
  await writeFile(file, JSON.stringify({ version: 1, remotes: entries }));
  return file;
}

function deps(remotesFile: string, answers: Record<string, string>, extra: Partial<LaptopKeysDeps> = {}) {
  const ui = new RecordingUi();
  const prompter = new ScriptedPrompter(answers);
  const server = new FakeSshServer();
  server.installed = true;
  server.newHost = false;
  const local: Array<{ which: KeyName; value: string }> = [];
  let text = "";
  const value: LaptopKeysDeps = {
    newUi: () => ui,
    prompter,
    write: (chunk) => { text += chunk; },
    color: false,
    ssh: server.exec,
    sources: {
      env: {},
      home: "/home/me",
      readFile: async (path) => path === "/home/me/.config/kimiflare/config.json" ? JSON.stringify({ openrouterApiKey: OR }) : undefined,
      gh: async () => GH,
      fetch: (async (url: string | URL) => String(url).includes("github") ? Response.json({ login: "sinameraji" }) : Response.json({})) as typeof fetch,
    },
    local: {
      set: async (which, key) => {
        local.push({ which, value: key });
        return { ok: true, key: which, detail: "replaced in Hotcell; Hotcell restarted" };
      },
      list: async (): Promise<KeyListing[]> => [{ key: "openrouter", set: true, detail: "sk-or…ff" }, { key: "github", set: false }],
    },
    remotesFile,
    ...extra,
  };
  return { deps: value, ui, prompter, server, local, text: () => text };
}

/** The value went only to stdin: never on a command line, and never shown. */
function assertOnlyOnStdin(t: ReturnType<typeof deps>, value: string) {
  assert.ok(!t.server.calls.some((call) => call.command.includes(value)), "never in the ssh command line");
  assert.ok(!t.ui.events.some((event) => event.includes(value)), "never shown");
  assert.ok(!t.text().includes(value));
}

describe("dl keys on a laptop", () => {
  it("replaces the GitHub token on an SSH server with the GitHub CLI login, on stdin", async () => {
    const t = deps(await remotes(box), { "Use your GitHub CLI login (sinameraji)?": "" });
    assert.equal(await laptopKeys(["github"], {}, t.deps), 0);

    const set = t.server.calls.find((call) => call.command.includes("dl keys set"));
    assert.equal(set?.command, "dl keys set github --stdin --json", "root needs no sudo");
    assert.equal(set?.input, `${GH}\n`);
    assert.equal(set?.access.target, "box");
    assert.deepEqual(t.server.replaced, [{ key: "github", value: GH }]);
    assert.ok(t.ui.events.includes("done apply | signed in as sinameraji; Autopilot restarted"), t.ui.events.join("\n"));
    assertOnlyOnStdin(t, GH);
  });

  it("asks with hidden input when the found key is declined, and uses sudo -n when the SSH user isn't root", async () => {
    const t = deps(await remotes(box), { "Use the OpenRouter key from Autopilot?": "n", "OpenRouter key": TYPED_OR });
    t.server.probe = "1000\nada\nubuntu 24.04\nx86_64\nsudo\n";
    assert.equal(await laptopKeys(["openrouter"], { server: "box" }, t.deps), 0);
    const set = t.server.calls.find((call) => call.command.includes("dl keys set"));
    assert.equal(set?.command, "sudo -n dl keys set openrouter --stdin --json");
    assert.equal(set?.input, `${TYPED_OR}\n`);
    assert.ok(t.prompter.asked.some((question) => question.includes("OpenRouter key")), "asked for it (hidden)");
    assertOnlyOnStdin(t, TYPED_OR);
  });

  it("checks a typed token before sending it, and gives up after three bad ones", async () => {
    const t = deps(await remotes(box), { "Use your GitHub CLI login": "n", "GitHub token": "not-a-token" });
    await assert.rejects(() => laptopKeys(["github"], {}, t.deps), /doesn't look like a GitHub token/);
    assert.equal(t.ui.events.filter((event) => event.startsWith("rejected")).length, 3);
    assert.ok(!t.server.calls.some((call) => call.command.includes("dl keys set")), "nothing sent");
  });

  it("sets the key on this computer directly, without SSH", async () => {
    const t = deps(await remotes(thisComputer), { "Use your GitHub CLI login": "n", "GitHub token": TYPED_GH });
    assert.equal(await laptopKeys(["github"], {}, t.deps), 0);
    assert.deepEqual(t.local, [{ which: "github", value: TYPED_GH }]);
    assert.deepEqual(t.server.calls, []);
    assertOnlyOnStdin(t, TYPED_GH);
  });

  it("picks the server with --server, and needs one when several are paired", async () => {
    const file = await remotes(box, thisComputer);
    const several = deps(file, {});
    await assert.rejects(() => laptopKeys(["github"], {}, several.deps), /Several places are set up \(box, this-computer\)\. Pick one with --server NAME, or set a default: dl use NAME/);
    const t = deps(file, { "Use the OpenRouter key from Autopilot?": "" });
    assert.equal(await laptopKeys(["openrouter"], { server: "this-computer" }, t.deps), 0);
    assert.deepEqual(t.local, [{ which: "openrouter", value: OR }]);
    assert.deepEqual(t.server.calls, []);
  });

  it("shows what the server reports when it refuses the key", async () => {
    const t = deps(await remotes(box), { "Use your GitHub CLI login": "" });
    t.server.rejectKey = "GitHub rejected that token.";
    await assert.rejects(() => laptopKeys(["github"], {}, t.deps), /^Error: box: GitHub rejected that token\.$/);
    assert.ok(t.ui.events.includes("fail apply | box: GitHub rejected that token."));
  });

  it("explains a server whose dl predates dl keys, and one connected with dl connect", async () => {
    const t = deps(await remotes(box), { "Use your GitHub CLI login": "" });
    t.server.oldDl = true;
    await assert.rejects(() => laptopKeys(["github"], {}, t.deps), /too old for dl keys; update it with dl setup/);
    await assert.rejects(() => laptopKeys([], {}, t.deps), /too old for dl keys/);
    const c = deps(await remotes(connected), {});
    await assert.rejects(() => laptopKeys(["github"], {}, c.deps), /connected with dl connect.*sudo dl keys/);
  });

  it("lists the keys on an SSH server or this computer, never their values", async () => {
    const t = deps(await remotes(box), {});
    assert.equal(await laptopKeys([], {}, t.deps), 0);
    assert.equal(t.server.calls.at(-1)?.command, "dl keys --json");
    assert.match(t.text(), /Keys on box/);
    assert.match(t.text(), /✓ OpenRouter  sk-or…aa/);
    assert.match(t.text(), /✓ GitHub {6}signed in as sinameraji/);
    assert.match(t.text(), /Replace one: dl keys openrouter/);
    assert.deepEqual(t.prompter.asked, [], "listing asks nothing");

    const local = deps(await remotes(box, thisComputer), {});
    assert.equal(await laptopKeys(["ls"], { server: "this-computer" }, local.deps), 0);
    assert.match(local.text(), /Keys on this computer/);
    assert.match(local.text(), /✗ GitHub {6}not set {3}dl keys github --server this-computer/);
    assert.deepEqual(local.server.calls, []);
  });

  it("explains its usage for anything else", async () => {
    const t = deps(await remotes(box), {});
    assert.equal(await laptopKeys(["tailscale"], {}, t.deps), 2);
    assert.match(t.text(), /Usage: dl keys \[openrouter\|github\]/);
    assert.deepEqual(t.server.calls, []);
  });
});
