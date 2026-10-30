import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readKeyLine, serverKeysCommand, type ServerKeysDeps } from "./keys.js";
import { parseHotcellRoutes } from "./provider.js";
import { PATHS, parseEnvFile } from "./layout.js";
import { ScriptedPrompter } from "./prompt.js";
import { FakeSystem } from "./test-support/fake-system.js";
import { palette } from "./ui.js";
import { up } from "./up.js";
import { withCatalog } from "./test-support/fake-catalog.js";

const OLD_OPENROUTER = `sk-or-v1-${"a".repeat(40)}`;
const OLD_GITHUB = `github_pat_${"b".repeat(40)}`;
const NEW_OPENROUTER = `sk-or-v1-${"n".repeat(38)}zq`;
const NEW_GITHUB = `github_pat_${"c".repeat(40)}`;

/** OpenRouter and GitHub accept everything, and GitHub says whose token it is. */
const fetchOk = withCatalog((async (url: string | URL | Request) =>
  String(url).includes("api.github.com") ? Response.json({ login: "octo" }) : Response.json({ data: {} })) as typeof fetch);
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

function run(system: FakeSystem, args: string[], flags: { json?: boolean; stdin?: boolean; baseUrl?: string; authHeader?: string; authFormat?: string }, input: { stdin?: string; extra?: Partial<ServerKeysDeps> } = {}) {
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
  it("replaces the provider's key in Hotcell's keystore over stdin, restarts Hotcell and Autopilot, and prints one JSON line", async () => {
    const system = await installed();
    const { code, out, err } = await run(system, ["set", "openrouter"], { json: true, stdin: true }, { stdin: `${NEW_OPENROUTER}\n` });

    assert.equal(code, 0, err);
    assert.equal(out, `${JSON.stringify({ ok: true, key: "openrouter", detail: "openrouter in Hotcell; Hotcell and Autopilot restarted" })}\n`);
    assert.equal(system.hotcellKeyValues.get("openrouter"), NEW_OPENROUTER);
    const add = system.commands.find((entry) => entry.command === "runuser" && entry.args.includes("add"));
    assert.deepEqual(add?.args, ["-u", "hotcell", "--", "env", "HOTCELL_HOME=/var/lib/hotcell", "HOTCELL_KEYSTORE=file", "/usr/bin/node", "/opt/directionallylocal/current/node_modules/hotcell/dist/index.js", "keys", "add", "openrouter", "--stdin"]);
    assert.equal(add?.input, NEW_OPENROUTER, "the key goes on stdin, as dl up does");
    assert.ok(system.ran.indexOf("systemctl restart hotcell.service") > system.ran.findIndex((line) => line.includes("keys add")), "restarted after storing");
    assert.ok(system.ran.includes("systemctl restart autopilot.service"), "Autopilot reads aster.json at startup");
    assert.equal(parseEnvFile(system.files.get(PATHS.githubEnv)?.content).GITHUB_TOKEN, OLD_GITHUB, "the GitHub token is untouched");
    assertNowhere(system, NEW_OPENROUTER, out, err);
  });

  it("takes any provider id Hotcell has a route for, a keyless one without a key, and a custom one with --base-url", async () => {
    const system = await installed();
    const deepseek = await run(system, ["set", "deepseek"], { json: true, stdin: true }, { stdin: "sk-deepseek-1234567890\n" });
    assert.equal(deepseek.code, 0, deepseek.err);
    assert.deepEqual(JSON.parse(deepseek.out), { ok: true, key: "deepseek", detail: "deepseek in Hotcell; Hotcell and Autopilot restarted" });
    assert.equal(system.hotcellKeyValues.get("deepseek"), "sk-deepseek-1234567890");
    const aster = () => JSON.parse(system.files.get(PATHS.asterConfig)!.content) as { provider: { id: string; baseUrl: string; apiKeyEnv: string }; models: string };
    assert.deepEqual(aster(), { ...aster(), provider: { id: "deepseek", baseUrl: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY" }, models: "catalog" });
    assertNowhere(system, "sk-deepseek-1234567890", deepseek.out, deepseek.err);

    const ollama = await run(system, ["set", "ollama"], { json: true });
    assert.equal(ollama.code, 0, ollama.err);
    const add = system.commands.filter((entry) => entry.command === "runuser" && entry.args.includes("add")).at(-1)!;
    assert.deepEqual(add.args.slice(-3), ["keys", "add", "ollama"], "no --stdin: nothing to read");
    assert.equal(add.input, undefined);
    assert.equal(aster().provider.id, "ollama");

    const unknown = await run(system, ["set", "myproxy"], { json: true, stdin: true }, { stdin: "k-1234567890\n" });
    assert.equal(unknown.code, 1);
    assert.match(JSON.parse(unknown.out).error, /add --base-url URL/);
    const custom = await run(system, ["set", "myproxy"], { json: true, stdin: true, baseUrl: "https://llm.example.com/v1", authHeader: "x-api-key", authFormat: "{key}" }, { stdin: "k-1234567890\n" });
    assert.equal(custom.code, 0, custom.err);
    const route = system.commands.filter((entry) => entry.command === "runuser" && entry.args.includes("add")).at(-1)!;
    assert.deepEqual(route.args.slice(route.args.indexOf("keys")), ["keys", "add", "myproxy", "--stdin", "--base-url", "https://llm.example.com/v1", "--auth-header", "x-api-key", "--auth-format", "{key}"]);
    assert.deepEqual(aster().provider, { id: "myproxy", baseUrl: "https://llm.example.com/v1", apiKeyEnv: "MYPROXY_API_KEY" });
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
    assert.equal(out, "  ✓ OpenRouter key replaced  openrouter in Hotcell; Hotcell and Autopilot restarted\n");
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
      { key: "provider", set: true, detail: "openrouter · sk-or…aa" },
      { key: "github", set: true, detail: "signed in as octo" },
    ] });
    const human = await run(system, ["ls"], {});
    assert.match(human.out, /✓ Provider {4}openrouter · sk-or…aa/);
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
      { key: "provider", set: false },
      { key: "github", set: true, problem: "GitHub rejected that token." },
    ]);
    // A route Hotcell has turned off doesn't count either.
    system.hotcellKeys.add("openrouter");
    system.hotcellInactive.add("openrouter");
    assert.deepEqual(JSON.parse((await run(system, [], { json: true })).out).keys[0], { key: "provider", set: false, detail: "openrouter", problem: "openrouter's route is off in Hotcell" });
  });

  it("explains its usage for anything else", async () => {
    const system = await installed();
    const { code, err } = await run(system, ["set", "Not A Provider"], {});
    assert.equal(code, 2);
    assert.match(err, /dl keys set <provider>\|github/);
  });
});

describe("reading the key", () => {
  it("takes the first line from a pipe and refuses a terminal", async () => {
    assert.equal(await readKeyLine(Readable.from([`  ${NEW_OPENROUTER}  \r\nmore\n`])), NEW_OPENROUTER);
    assert.equal(await readKeyLine(Readable.from(["sk-or-", "v1-split\n"])), "sk-or-v1-split");
    const tty = Object.assign(Readable.from([]), { isTTY: true });
    await assert.rejects(() => readKeyLine(tty), /from a pipe, not a terminal/);
  });

  it("reads Hotcell's routes from --json, or from the plain listing of an older Hotcell, never a column that could be a key", () => {
    assert.deepEqual(parseHotcellRoutes('{"routes":[{"provider":"deepseek","active":true,"mask":"sk-de…00"},{"provider":"openrouter","active":false}]}\n'), [
      { provider: "deepseek", active: true, mask: "sk-de…00" },
      { provider: "openrouter", active: false },
    ]);
    assert.deepEqual(parseHotcellRoutes('[{"provider":"ollama"}]'), [{ provider: "ollama", active: true }]);
    assert.deepEqual(parseHotcellRoutes("\x1b[2mPROVIDER\x1b[0m  KEY  SOURCE\nopenrouter  sk-or…aa  \x1b[2mfile\x1b[0m\n"), [{ provider: "openrouter", active: true, mask: "sk-or…aa" }]);
    assert.deepEqual(parseHotcellRoutes("openrouter  ••••  file\n"), [{ provider: "openrouter", active: true, mask: "••••" }]);
    assert.deepEqual(parseHotcellRoutes(`openrouter  ${OLD_OPENROUTER}  file\n`), [{ provider: "openrouter", active: true }]);
    assert.deepEqual(parseHotcellRoutes("no provider keys yet — add one:  hotcell keys add openrouter\n"), []);
  });
});
