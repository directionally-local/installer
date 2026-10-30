import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { KeyListing } from "../keys.js";
import { ScriptedPrompter } from "../prompt.js";
import type { ConnectResult } from "../provider.js";
import { FakeSshServer } from "../test-support/fake-ssh.js";
import { RecordingUi } from "../ui.js";
import type { RemoteServer } from "./config.js";
import { ConnectCancelled } from "./connect.js";
import { providerCommand, type ProviderCommandDeps } from "./provider.js";
import type { ServerAnswers } from "./remote-install.js";
import { loadSettings } from "./settings.js";

const GH = `gho_${"a".repeat(36)}`;
const TYPED_GH = `github_pat_${"t".repeat(40)}`;
const DEEPSEEK: ConnectResult = { provider: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKey: "sk-deepseek-secretsecret", apiKeyEnv: "DEEPSEEK_API_KEY", keyRequired: true, model: "deepseek-v4-pro" };

const box: RemoteServer = {
  name: "box", url: "http://127.0.0.1:4096", token: "aster_x", credentialId: "c1", expiresAt: "2027-01-01T00:00:00.000Z", addedAt: "2026-10-28T09:00:00.000Z",
  ssh: { target: "box" },
};
const thisComputer: RemoteServer = { ...box, name: "this-computer", url: "http://127.0.0.1:4096", ssh: undefined };
delete (thisComputer as Partial<RemoteServer>).ssh;
const connected: RemoteServer = { ...thisComputer, name: "acme", url: "https://acme.example.com" };

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "dl-provider-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function remotes(...entries: RemoteServer[]): Promise<string> {
  const file = join(root, "remotes.json");
  await writeFile(file, JSON.stringify({ version: 1, remotes: entries }));
  return file;
}

function deps(remotesFile: string, answers: Record<string, string>, extra: Partial<ProviderCommandDeps> = {}) {
  const ui = new RecordingUi();
  const prompter = new ScriptedPrompter(answers);
  const server = new FakeSshServer();
  server.installed = true;
  server.newHost = false;
  const local: ServerAnswers[] = [];
  const connects: Array<{ modelOnly?: boolean }> = [];
  let text = "";
  const value: ProviderCommandDeps = {
    newUi: () => ui,
    prompter,
    write: (chunk) => { text += chunk; },
    color: false,
    ssh: server.exec,
    sources: {
      env: {},
      home: "/home/me",
      readFile: async () => undefined,
      gh: async () => GH,
      fetch: (async (url: string | URL) => String(url).includes("github") ? Response.json({ login: "sinameraji" }) : Response.json({})) as typeof fetch,
    },
    connect: async (options) => { connects.push(options); return DEEPSEEK; },
    local: {
      configure: async (answers) => { local.push(answers); },
      list: async (): Promise<KeyListing[]> => [{ key: "provider", set: true, detail: "openrouter · sk-or…ff" }, { key: "github", set: false }],
    },
    remotesFile,
    settingsFile: join(root, "config.json"),
    ...extra,
  };
  return { deps: value, ui, prompter, server, local, connects, text: () => text };
}

/** The value went only to stdin: never on a command line, and never shown. */
function assertOnlyOnStdin(t: ReturnType<typeof deps>, value: string) {
  assert.ok(!t.server.calls.some((call) => call.command.includes(value)), "never in the ssh command line");
  assert.ok(!t.ui.events.some((event) => event.includes(value)), "never shown");
  assert.ok(!t.text().includes(value));
}

describe("dl provider on a laptop", () => {
  it("replaces the provider on an SSH server from Autopilot's picker: the key on stdin, the model kept here", async () => {
    const t = deps(await remotes(box), {});
    assert.equal(await providerCommand(["set"], {}, t.deps), 0);
    assert.deepEqual(t.connects, [{}], "the whole picker: provider, key and model");
    const up = t.server.calls.find((call) => call.command.includes("--answers-stdin"));
    assert.equal(up?.command, "dl up --access ssh --answers-stdin --events json", "root needs no sudo");
    assert.deepEqual(JSON.parse(up!.input!), { provider: { id: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: DEEPSEEK.apiKey, apiKeyEnv: "DEEPSEEK_API_KEY" } });
    assert.deepEqual(t.server.provider, { id: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: DEEPSEEK.apiKey, apiKeyEnv: "DEEPSEEK_API_KEY" });
    assert.deepEqual((await loadSettings(join(root, "config.json"))).placeModels, { box: "deepseek-v4-pro" });
    assert.ok(t.ui.events.includes("line done Provider | DeepSeek · deepseek-v4-pro · key stays on box"), t.ui.events.join("\n"));
    assert.ok(t.ui.events.includes("done apply | deepseek in Hotcell · services restarted"));
    assert.deepEqual(t.prompter.asked, [], "nothing asked by dl itself");
    assertOnlyOnStdin(t, DEEPSEEK.apiKey!);
  });

  it("uses sudo -n when the SSH user isn't root, and leaves everything alone when the picker is cancelled", async () => {
    const t = deps(await remotes(box), {});
    t.server.probe = "1000\nada\nubuntu 24.04\nx86_64\nsudo\n";
    assert.equal(await providerCommand(["set"], { server: "box" }, t.deps), 0);
    assert.equal(t.server.calls.find((call) => call.command.includes("--answers-stdin"))?.command, "sudo -n dl up --access ssh --answers-stdin --events json");

    const cancelled = deps(await remotes(box), {}, { connect: async () => { throw new ConnectCancelled(); } });
    assert.equal(await providerCommand(["set"], {}, cancelled.deps), 130);
    assert.ok(!cancelled.server.calls.some((call) => call.command.includes("--answers-stdin")), "nothing sent");
    assert.match(cancelled.text(), /Unchanged\./);
  });

  it("replaces the GitHub token on an SSH server with the GitHub CLI login, on stdin", async () => {
    const t = deps(await remotes(box), { "Use your GitHub CLI login (sinameraji)?": "" });
    assert.equal(await providerCommand(["github"], {}, t.deps), 0);
    const up = t.server.calls.find((call) => call.command.includes("--answers-stdin"));
    assert.deepEqual(JSON.parse(up!.input!), { githubToken: GH });
    assert.ok(t.server.keys.has("github"));
    assert.ok(t.ui.events.includes("done apply | GitHub token replaced · Autopilot restarted"), t.ui.events.join("\n"));
    assert.deepEqual(t.connects, [], "the provider isn't touched");
    assertOnlyOnStdin(t, GH);
  });

  it("checks a typed token before sending it, and gives up after three bad ones", async () => {
    const t = deps(await remotes(box), { "Use your GitHub CLI login": "n", "GitHub token": "not-a-token" });
    await assert.rejects(() => providerCommand(["github"], {}, t.deps), /doesn't look like a GitHub token/);
    assert.equal(t.ui.events.filter((event) => event.startsWith("rejected")).length, 3);
    assert.ok(!t.server.calls.some((call) => call.command.includes("--answers-stdin")), "nothing sent");
  });

  it("stores on this computer directly, without SSH", async () => {
    const t = deps(await remotes(thisComputer), { "Use your GitHub CLI login": "n", "GitHub token": TYPED_GH });
    assert.equal(await providerCommand(["github"], {}, t.deps), 0);
    assert.deepEqual(t.local, [{ githubToken: TYPED_GH }]);
    assert.equal(await providerCommand(["set"], {}, t.deps), 0);
    assert.deepEqual(t.local[1], { provider: { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKey: DEEPSEEK.apiKey, apiKeyEnv: "DEEPSEEK_API_KEY" } });
    assert.deepEqual((await loadSettings(join(root, "config.json"))).placeModels, { "this-computer": "deepseek-v4-pro" });
    assert.deepEqual(t.server.calls, []);
    assertOnlyOnStdin(t, TYPED_GH);
  });

  it("picks the place with --server, and needs one when several are set up", async () => {
    const file = await remotes(box, thisComputer);
    const several = deps(file, {});
    await assert.rejects(() => providerCommand(["github"], {}, several.deps), /Several places are set up \(box, this-computer\)\. Pick one with --server NAME, or set a default: dl use NAME/);
    const t = deps(file, {});
    assert.equal(await providerCommand(["set"], { server: "this-computer" }, t.deps), 0);
    assert.equal(t.local.length, 1);
    assert.deepEqual(t.server.calls, []);
  });

  it("shows what the server reports when storing fails", async () => {
    const t = deps(await remotes(box), { "Use your GitHub CLI login": "" });
    t.server.installFails = true;
    await assert.rejects(() => providerCommand(["github"], {}, t.deps), /Storing the keys on the server failed: Building the sandbox image failed/);
    assert.ok(t.ui.events.some((event) => event.startsWith("fail apply | Storing the keys on the server failed")));
  });

  it("explains a server connected with dl connect", async () => {
    const c = deps(await remotes(connected), {});
    await assert.rejects(() => providerCommand(["github"], {}, c.deps), /connected with dl connect.*sudo dl keys/);
  });

  it("lists each place's provider, model and GitHub token, never the values; an older server's openrouter row is the provider", async () => {
    const t = deps(await remotes(box, thisComputer), {});
    await writeFile(join(root, "config.json"), JSON.stringify({ version: 1, placeModels: { box: "deepseek-v4-pro" } }));
    assert.equal(await providerCommand([], {}, t.deps), 0);
    assert.equal(t.server.calls.at(-1)?.command, "dl keys --json");
    assert.match(t.text(), /Provider on each place; keys stay there/);
    assert.match(t.text(), /✓ box {13}provider openrouter · sk-or…aa · model deepseek-v4-pro {3}GitHub signed in as sinameraji/);
    assert.match(t.text(), /✗ this-computer {3}provider openrouter · sk-or…ff {3}GitHub not set/);
    assert.match(t.text(), /Change the provider \(and model\): dl provider set/);
    assert.deepEqual(t.prompter.asked, [], "listing asks nothing");
    assert.deepEqual(t.connects, []);

    const old = deps(await remotes(box), {});
    old.server.listing = [{ key: "openrouter", set: true, detail: "sk-or…aa" }, { key: "github", set: true }];
    assert.equal(await providerCommand(["ls"], {}, old.deps), 0);
    assert.match(old.text(), /provider openrouter · sk-or…aa/);
    const tooOld = deps(await remotes(box), {});
    tooOld.server.oldDl = true;
    assert.equal(await providerCommand([], {}, tooOld.deps), 0);
    assert.match(tooOld.text(), /✗ box {13}The dl on box is too old for dl provider; update it with dl update box/);
  });

  it("explains its usage for anything else", async () => {
    const t = deps(await remotes(box), {});
    assert.equal(await providerCommand(["tailscale"], {}, t.deps), 2);
    assert.match(t.text(), /Usage: dl provider/);
    assert.deepEqual(t.server.calls, []);
  });
});
