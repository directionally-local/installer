import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { hotcellKeyListed, readKeyLine, serverKeysCommand, type ServerKeysDeps } from "./keys.js";
import { PATHS, parseEnvFile } from "./layout.js";
import { ScriptedPrompter } from "./prompt.js";
import { FakeSystem } from "./test-support/fake-system.js";
import { palette } from "./ui.js";
import { up } from "./up.js";

const OLD_OPENROUTER = `sk-or-v1-${"a".repeat(40)}`;
const OLD_GITHUB = `github_pat_${"b".repeat(40)}`;
const NEW_OPENROUTER = `sk-or-v1-${"n".repeat(38)}zq`;
const NEW_GITHUB = `github_pat_${"c".repeat(40)}`;

/** OpenRouter and GitHub accept everything, and GitHub says whose token it is. */
const fetchOk = (async (url: string | URL | Request) =>
  String(url).includes("api.github.com") ? Response.json({ login: "octo" }) : Response.json({ data: {} })) as typeof fetch;
const fetchRejects = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;

async function installed(): Promise<FakeSystem> {
  const system = new FakeSystem();
  await up(system, {
    prompter: new ScriptedPrompter({ "Tailscale auth key": "tskey-auth-k1-abc", "OpenRouter API key": OLD_OPENROUTER, "GitHub token": OLD_GITHUB }),
    fetchImpl: fetchOk,
    sleep: async () => {},
  });
  system.commands.length = 0;
  system.logs.length = 0;
  return system;
}

function run(system: FakeSystem, args: string[], flags: { json?: boolean; stdin?: boolean }, input: { stdin?: string; extra?: Partial<ServerKeysDeps> } = {}) {
  let out = "";
  let err = "";
  const done = serverKeysCommand(system, args, flags, {
    out: (text) => { out += text; },
    err: (text) => { err += text; },
    colors: palette(false),
    stdin: Readable.from(input.stdin === undefined ? [] : [input.stdin]),
    prompter: new ScriptedPrompter({}),
    env: {},
    fetchImpl: fetchOk,
    sleep: async () => {},
    ...input.extra,
  });
  return done.then((code) => ({ code, out, err }));
}

/** Nothing anyone could read afterwards (argv, the plan, logs) holds the value. */
function assertNowhere(system: FakeSystem, value: string, ...texts: string[]) {
  assert.ok(!system.ran.some((line) => line.includes(value)), "never in argv");
  assert.ok(!system.logs.some((line) => line.includes(value)), "never in logs");
  for (const text of texts) assert.ok(!text.includes(value), "never printed");
}

describe("dl keys on a server", () => {
  it("replaces the OpenRouter key in Hotcell's keystore over stdin, restarts Hotcell, and prints one JSON line", async () => {
    const system = await installed();
    const { code, out, err } = await run(system, ["set", "openrouter"], { json: true, stdin: true }, { stdin: `${NEW_OPENROUTER}\n` });

    assert.equal(code, 0, err);
    assert.equal(out, `${JSON.stringify({ ok: true, key: "openrouter", detail: "replaced in Hotcell; Hotcell restarted" })}\n`);
    assert.equal(system.hotcellKeyValues.get("openrouter"), NEW_OPENROUTER);
    const add = system.commands.find((entry) => entry.command === "runuser" && entry.args.includes("add"));
    assert.deepEqual(add?.args, ["-u", "hotcell", "--", "env", "HOTCELL_HOME=/var/lib/hotcell", "HOTCELL_KEYSTORE=file", "/usr/bin/node", "/opt/directionallylocal/current/node_modules/hotcell/dist/index.js", "keys", "add", "openrouter", "--stdin"]);
    assert.equal(add?.input, NEW_OPENROUTER, "the key goes on stdin, as dl up does");
    assert.ok(system.ran.indexOf("systemctl restart hotcell.service") > system.ran.findIndex((line) => line.includes("keys add")), "restarted after storing");
    assert.ok(!system.ran.includes("systemctl restart autopilot.service"), "Autopilot keeps running");
    assert.equal(parseEnvFile(system.files.get(PATHS.githubEnv)?.content).GITHUB_TOKEN, OLD_GITHUB, "the GitHub token is untouched");
    assertNowhere(system, NEW_OPENROUTER, out, err);
  });

  it("replaces the GitHub token in github.env (0640 root:autopilot) and restarts Autopilot", async () => {
    const system = await installed();
    const { code, out, err } = await run(system, ["set", "github"], { json: true, stdin: true }, { stdin: `${NEW_GITHUB}\nignored second line\n` });

    assert.equal(code, 0, err);
    assert.deepEqual(JSON.parse(out), { ok: true, key: "github", detail: "signed in as octo; Autopilot restarted" });
    const file = system.files.get(PATHS.githubEnv);
    assert.equal(parseEnvFile(file?.content).GITHUB_TOKEN, NEW_GITHUB);
    assert.equal(file?.mode, 0o640);
    assert.equal(file?.owner, "root:autopilot");
    assert.ok(system.ran.includes("systemctl restart autopilot.service"));
    assert.ok(!system.ran.includes("systemctl restart hotcell.service"));
    assert.equal(system.hotcellKeyValues.get("openrouter"), OLD_OPENROUTER);
    assertNowhere(system, NEW_GITHUB, out, err);
  });

  it("asks with hidden input on the server's own terminal and prints a ✓ line", async () => {
    const system = await installed();
    const prompter = new ScriptedPrompter({ "OpenRouter key (hidden)": NEW_OPENROUTER });
    const { code, out } = await run(system, ["openrouter"], {}, { extra: { prompter } });
    assert.equal(code, 0);
    assert.equal(out, "  ✓ OpenRouter key replaced  replaced in Hotcell; Hotcell restarted\n");
    assert.equal(system.hotcellKeyValues.get("openrouter"), NEW_OPENROUTER);
  });

  it("rejects a malformed or refused key before storing or restarting anything", async () => {
    const system = await installed();
    const malformed = await run(system, ["set", "openrouter"], { json: true, stdin: true }, { stdin: "sk-proj-nope\n" });
    assert.equal(malformed.code, 1);
    assert.deepEqual(JSON.parse(malformed.out), { ok: false, key: "openrouter", error: "That doesn't look like an OpenRouter key (sk-or-…)." });
    assert.ok(!malformed.out.includes("sk-proj-nope"), "the error never quotes the input");

    const refused = await run(system, ["set", "github"], { json: true, stdin: true }, { stdin: `${NEW_GITHUB}\n`, extra: { fetchImpl: fetchRejects } });
    assert.equal(refused.code, 1);
    assert.equal(JSON.parse(refused.out).error, "GitHub rejected that token.");

    const human = await run(system, ["set", "openrouter"], { stdin: true }, { stdin: `${NEW_OPENROUTER}\n`, extra: { fetchImpl: fetchRejects } });
    assert.equal(human.code, 1);
    assert.equal(human.err, "  ✗ OpenRouter rejected that key.\n");

    const empty = await run(system, ["set", "github"], { json: true, stdin: true }, { stdin: "" });
    assert.equal(JSON.parse(empty.out).error, "No key was given.");

    assert.deepEqual(system.ran, [], "nothing stored, nothing restarted");
    assert.equal(system.hotcellKeyValues.get("openrouter"), OLD_OPENROUTER);
    assert.equal(parseEnvFile(system.files.get(PATHS.githubEnv)?.content).GITHUB_TOKEN, OLD_GITHUB);
  });

  it("checks only the format with DL_SKIP_CREDENTIAL_CHECK=1", async () => {
    const system = await installed();
    const { code } = await run(system, ["set", "github"], { json: true, stdin: true }, { stdin: `${NEW_GITHUB}\n`, extra: { env: { DL_SKIP_CREDENTIAL_CHECK: "1" }, fetchImpl: fetchRejects } });
    assert.equal(code, 0);
    assert.equal(parseEnvFile(system.files.get(PATHS.githubEnv)?.content).GITHUB_TOKEN, NEW_GITHUB);
  });

  it("lists which keys are set without their values", async () => {
    const system = await installed();
    const json = await run(system, [], { json: true });
    assert.deepEqual(JSON.parse(json.out), { keys: [
      { key: "openrouter", set: true, detail: "sk-or…aa" },
      { key: "github", set: true, detail: "signed in as octo" },
    ] });
    const human = await run(system, ["ls"], {});
    assert.match(human.out, /✓ OpenRouter  sk-or…aa/);
    assert.match(human.out, /✓ GitHub {6}signed in as octo/);
    assert.match(human.out, /Replace one: sudo dl keys set openrouter/);
    for (const text of [json.out, human.out]) {
      assert.ok(!text.includes(OLD_OPENROUTER) && !text.includes(OLD_GITHUB), "never the values");
    }
    assertNowhere(system, OLD_GITHUB);

    // A missing key, and a token GitHub refuses.
    system.hotcellKeys.clear();
    const missing = await run(system, [], { json: true }, { extra: { fetchImpl: fetchRejects } });
    assert.deepEqual(JSON.parse(missing.out).keys, [
      { key: "openrouter", set: false },
      { key: "github", set: true, problem: "GitHub rejected that token." },
    ]);
  });

  it("explains its usage for anything else", async () => {
    const system = await installed();
    const { code, err } = await run(system, ["set", "tailscale"], {});
    assert.equal(code, 2);
    assert.match(err, /dl keys set openrouter\|github/);
  });
});

describe("reading the key", () => {
  it("takes the first line from a pipe and refuses a terminal", async () => {
    assert.equal(await readKeyLine(Readable.from([`  ${NEW_OPENROUTER}  \r\nmore\n`])), NEW_OPENROUTER);
    assert.equal(await readKeyLine(Readable.from(["sk-or-", "v1-split\n"])), "sk-or-v1-split");
    const tty = Object.assign(Readable.from([]), { isTTY: true });
    await assert.rejects(() => readKeyLine(tty), /from a pipe, not a terminal/);
  });

  it("finds a provider's mask in Hotcell's listing, and never shows a column that could be a key", () => {
    assert.deepEqual(hotcellKeyListed("\x1b[2mPROVIDER\x1b[0m  KEY  SOURCE\nopenrouter  sk-or…aa  \x1b[2mfile\x1b[0m\n", "openrouter"), { set: true, detail: "sk-or…aa" });
    assert.deepEqual(hotcellKeyListed("openrouter  ••••  file\n", "openrouter"), { set: true, detail: "••••" });
    assert.deepEqual(hotcellKeyListed(`openrouter  ${OLD_OPENROUTER}  file\n`, "openrouter"), { set: true });
    assert.deepEqual(hotcellKeyListed("no provider keys yet — add one:  hotcell keys add openrouter\n", "openrouter"), { set: false });
  });
});
