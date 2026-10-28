import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PATHS, parseEnvFile } from "./layout.js";
import { ScriptedPrompter } from "./prompt.js";
import { readState } from "./state.js";
import { FakeSystem } from "./test-support/fake-system.js";
import { JsonUi } from "./ui.js";
import { needs, parseAccessMode, parseProvidedAnswers, up, validateGitHubToken, validateOpenRouterKey } from "./up.js";

const OPENROUTER_KEY = `sk-or-v1-${"a".repeat(40)}`;
const GITHUB_TOKEN = `github_pat_${"b".repeat(40)}`;
const TAILSCALE_KEY = "tskey-auth-kAbC123-XyZ";

const answers = () => new ScriptedPrompter({
  "Tailscale auth key": TAILSCALE_KEY,
  "OpenRouter API key": OPENROUTER_KEY,
  "GitHub token": GITHUB_TOKEN,
});

/** OpenRouter and GitHub accept the test credentials. */
const fetchOk = (async (url: string | URL | Request) =>
  String(url).includes("api.github.com") ? Response.json({ login: "octo" }) : Response.json({ data: {} })) as typeof fetch;

const noSleep = async () => {};

/** For the laptop's mode: any question is a bug, since there's no one to answer it. */
const neverAsk = {
  choose: async () => { throw new Error("asked a question"); },
  text: async () => { throw new Error("asked a question"); },
  secret: async () => { throw new Error("asked a question"); },
};

/** Everything a FakeSystem has, to prove a command changed nothing. */
function snapshot(system: FakeSystem) {
  return JSON.stringify({
    files: [...system.files], dirs: [...system.dirs], users: [...system.users], images: [...system.images], enabled: [...system.enabled],
    keys: [...system.hotcellKeys], ran: system.ran, logs: system.logs, docker: system.docker, tailscaleUp: system.tailscaleUp, serving: system.serving,
  });
}

/** Runs `up` the way the laptop does: ssh access, answers given, progress as JSON events. */
async function laptopUp(system: FakeSystem, answers: Parameters<typeof up>[1]["answers"], env: NodeJS.ProcessEnv = {}) {
  let out = "";
  const result = up(system, { prompter: neverAsk, ui: new JsonUi((text) => { out += text; }), access: "ssh", answers, env, fetchImpl: fetchOk, sleep: noSleep });
  const events = () => out.trimEnd().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  return { result, events, out: () => out };
}

describe("directionallylocal up", () => {
  it("installs everything on a fresh Ubuntu server and keeps secrets out of argv and logs", async () => {
    const system = new FakeSystem();
    const prompter = answers();
    const result = await up(system, { prompter, fetchImpl: fetchOk, sleep: noSleep, now: () => new Date("2026-10-21T10:00:00Z") });

    // Only the three questions: access (Tailscale key), model key, GitHub.
    assert.equal(prompter.asked.length, 3);
    assert.equal(result.url, "https://box.tail1234.ts.net");
    assert.match(result.ownerLink ?? "", /^https:\/\/box\.tail1234\.ts\.net\/api\/v1\/auth\/claim\?token=aster_claim_/);
    assert.equal(result.capacity, 6, "8 GB minus the host's share, 1 GB per sandbox");
    assert.ok(system.logs.includes("Ready"));
    // It says what this is, then the next steps use dl, not Autopilot or Tailscale commands.
    assert.ok(system.logs.some((line) => line.startsWith("This server now runs coding agents for you.") && line.includes("fits ~6 at once (estimate)")));
    assert.ok(system.logs.includes("  On your laptop (signed in to the same tailnet), connect it: npm install -g directionallylocal ; dl connect https://box.tail1234.ts.net"));
    assert.ok(system.logs.some((line) => line.includes('dl run "fix the flaky checkout test"')));
    assert.ok(system.logs.includes("Forgot any of this? Type  dl  on this server."));
    assert.ok(!system.logs.some((line) => /autopilot remote add|tailscale up/.test(line)));
    assert.match(system.files.get("/etc/update-motd.d/60-directionallylocal")?.content ?? "", /dl status --brief/);
    assert.ok(system.logs.includes("ok Joining your tailnet: joined as box"));

    // Docker, accounts, software, image, services, access.
    assert.ok(system.ran.some((command) => command.includes("get.docker.com")));
    assert.ok(system.users.has("hotcell") && system.users.has("autopilot"));
    assert.ok(system.ran.includes("npm install --prefix /opt/directionallylocal/releases/autopilot-2.2.0_hotcell-0.1.26 --no-audit --no-fund --omit=dev autopilot-ai@2.2.0 hotcell@0.1.26"));
    assert.ok(system.images.has("directionallylocal-cell:2.2.0"));
    assert.ok(system.ran.some((command) => command.startsWith("docker build --pull ")), "fresh base layers, never a stale cached Node");
    for (const unit of ["directionallylocal-metadata-block.service", "hotcell.service", "autopilot.service"]) assert.ok(system.enabled.has(unit), unit);
    assert.ok(system.ran.includes("tailscale serve --bg --https=443 http://127.0.0.1:4096"));
    // The auth key is used before the long steps, so a later failure never re-asks for it.
    const joined = system.ran.findIndex((command) => command.startsWith("tailscale up"));
    assert.ok(joined >= 0 && joined < system.ran.findIndex((command) => command.startsWith("npm install")));

    // The model key reaches Hotcell over stdin only; the GitHub token only its 0640 env file.
    const keysAdd = system.commands.find(({ args }) => args.includes("keys") && args.includes("add"))!;
    assert.equal(keysAdd.input, OPENROUTER_KEY);
    for (const secret of [OPENROUTER_KEY, GITHUB_TOKEN, TAILSCALE_KEY]) {
      assert.ok(!system.ran.some((command) => command.includes(secret)), "no secret in any command line");
      assert.ok(!system.logs.some((line) => line.includes(secret)), "no secret in the output");
    }
    assert.ok(system.ran.some((command) => command.startsWith("tailscale up --auth-key=file:/etc/directionallylocal/tailscale-auth-key")));
    assert.equal(system.files.has("/etc/directionallylocal/tailscale-auth-key"), false, "the auth key file is removed after use");
    assert.deepEqual(system.files.get(PATHS.githubEnv)?.mode, 0o640);
    assert.equal(parseEnvFile(system.files.get(PATHS.githubEnv)?.content).GITHUB_TOKEN, GITHUB_TOKEN);
    const autopilotEnv = parseEnvFile(system.files.get(PATHS.autopilotEnv)?.content);
    assert.equal(autopilotEnv.AUTOPILOT_PUBLIC_URL, "https://box.tail1234.ts.net");
    assert.equal(autopilotEnv.OPENROUTER_API_KEY, undefined, "Autopilot never holds the model key");
    assert.equal(autopilotEnv.AUTOPILOT_HOTCELL_API_KEY, parseEnvFile(system.files.get(PATHS.hotcellEnv)?.content).HOTCELL_API_KEY);
    assert.equal(autopilotEnv.AUTOPILOT_ASTER_GITHUB_PROXY_LISTEN, "172.17.0.1:4760");

    // The key is stored before Hotcell (re)starts, so the daemon loads it.
    const keyIndex = system.commands.indexOf(keysAdd);
    const hotcellRestart = system.ran.indexOf("systemctl restart hotcell.service");
    assert.ok(keyIndex < hotcellRestart);

    const state = await readState(system);
    assert.equal(state?.release, "autopilot-2.2.0_hotcell-0.1.26");
    assert.deepEqual(state?.access, { mode: "tailscale", url: "https://box.tail1234.ts.net" });
  });

  it("asks nothing again after a failure past the questions", async () => {
    const system = new FakeSystem();
    system.dockerInstalled = true;
    system.dockerSocket = true;
    const run = system.run.bind(system);
    let failBuild = true;
    system.run = async (command, args, options) => {
      if (failBuild && command === "docker" && args[0] === "build") throw new Error("Cannot connect to the Docker daemon");
      return run(command, args, options);
    };
    await assert.rejects(() => up(system, { prompter: answers(), fetchImpl: fetchOk, sleep: noSleep }), /Cannot connect/);
    failBuild = false;
    const again = new ScriptedPrompter({});
    await up(system, { prompter: again, fetchImpl: fetchOk, sleep: noSleep });
    assert.deepEqual(again.asked, [], "Tailscale, model key, and GitHub are all remembered");
  });

  it("re-runs as a repair: no questions, same secrets, nothing reinstalled", async () => {
    const system = new FakeSystem();
    await up(system, { prompter: answers(), fetchImpl: fetchOk, sleep: noSleep });
    const apiKey = parseEnvFile(system.files.get(PATHS.hotcellEnv)?.content).HOTCELL_API_KEY;
    const firstRunCommands = system.commands.length;

    const again = new ScriptedPrompter({});
    await up(system, { prompter: again, fetchImpl: fetchOk, sleep: noSleep });
    assert.deepEqual(again.asked, []);
    const rerun = system.ran.slice(firstRunCommands);
    assert.ok(!rerun.some((command) => command.includes("get.docker.com") || command.startsWith("npm install") || command.startsWith("docker build") || command.startsWith("tailscale up")));
    assert.equal(parseEnvFile(system.files.get(PATHS.hotcellEnv)?.content).HOTCELL_API_KEY, apiKey);
  });

  it("takes unattended answers from the environment and opens UFW for the sandboxes", async () => {
    const system = new FakeSystem({ docker: true });
    system.ufwActive = true;
    await up(system, {
      prompter: new ScriptedPrompter({}),
      env: { DL_TAILSCALE_AUTH_KEY: TAILSCALE_KEY, DL_OPENROUTER_API_KEY: OPENROUTER_KEY, DL_GITHUB_TOKEN: GITHUB_TOKEN },
      fetchImpl: fetchOk,
      sleep: noSleep,
    });
    assert.ok(!system.ran.some((command) => command.includes("get.docker.com")));
    assert.ok(system.ran.includes("ufw allow in on docker0 to 172.17.0.1 port 4752 proto tcp comment directionallylocal sandboxes"));
    assert.ok(system.ran.includes("ufw allow in on docker0 to 172.17.0.1 port 4760 proto tcp comment directionallylocal sandboxes"));
  });

  it("re-asks a rejected key and refuses an unsupported machine before changing anything", async () => {
    const system = new FakeSystem({ tailscale: true, tailscaleUp: true });
    const replies = ["not-a-key", OPENROUTER_KEY];
    const prompter = {
      choose: async () => "tailscale",
      text: async () => "",
      secret: async (question: string) => question.includes("OpenRouter") ? replies.shift()! : GITHUB_TOKEN,
    };
    await up(system, { prompter, fetchImpl: fetchOk, sleep: noSleep });
    assert.ok(system.logs.some((line) => line.includes("doesn't look like an OpenRouter key")));
    assert.ok(!system.ran.some((command) => command.startsWith("tailscale up")), "an already-joined machine isn't re-joined");

    const small = new FakeSystem();
    small.memoryKb = 2 * 1024 * 1024;
    small.files.set("/etc/os-release", { content: 'ID=fedora\nVERSION_ID="41"\nPRETTY_NAME="Fedora Linux 41"\n', mode: 0o644 });
    await assert.rejects(() => up(small, { prompter: answers(), fetchImpl: fetchOk, sleep: noSleep }), /Fedora Linux 41 isn't supported[\s\S]*4 GB of RAM/);
    assert.deepEqual(small.commands, [], "preflight failures change nothing");
  });

  it("validates credentials against their services", async () => {
    const rejected = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    const offline = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    assert.match(await validateOpenRouterKey(OPENROUTER_KEY, rejected) ?? "", /rejected/);
    assert.equal(await validateOpenRouterKey(OPENROUTER_KEY, offline), undefined, "offline isn't fatal");
    assert.match(await validateOpenRouterKey("sk-proj-123", fetchOk) ?? "", /doesn't look like/);
    const system = new FakeSystem();
    assert.match((await validateGitHubToken(GITHUB_TOKEN, rejected)).problem ?? "", /rejected/);
    assert.deepEqual(await validateGitHubToken(GITHUB_TOKEN, fetchOk), { detail: "signed in as octo" });
    assert.ok(system.commands.length === 0);
  });
});

describe("the laptop's setup over SSH", () => {
  it("installs with ssh access from answers on stdin: no questions, no Tailscale, progress as JSON", async () => {
    const system = new FakeSystem();
    // The environment's answers are ignored when the laptop sends its own.
    const run = await laptopUp(system, { openrouterKey: OPENROUTER_KEY, githubToken: GITHUB_TOKEN }, { DL_OPENROUTER_API_KEY: "sk-or-ignored", DL_TAILSCALE_AUTH_KEY: TAILSCALE_KEY });
    const result = await run.result;

    assert.equal(result.url, "http://127.0.0.1:4096");
    assert.equal(result.ownerLink, undefined, "the laptop pairs itself; no owner link is made");
    assert.ok(!system.ran.some((command) => command.startsWith("tailscale") || command.includes("tailscale.com")), "no Tailscale at all");
    assert.ok(!system.ran.some((command) => command.includes("owner link")));
    assert.deepEqual((await readState(system))?.access, { mode: "ssh", url: "http://127.0.0.1:4096" });
    assert.equal(parseEnvFile(system.files.get(PATHS.autopilotEnv)?.content).AUTOPILOT_PUBLIC_URL, "http://127.0.0.1:4096");
    assert.equal(system.commands.find(({ args }) => args.includes("keys") && args.includes("add"))?.input, OPENROUTER_KEY);
    assert.equal(parseEnvFile(system.files.get(PATHS.githubEnv)?.content).GITHUB_TOKEN, GITHUB_TOKEN);

    const events = run.events();
    assert.deepEqual(events[0], { event: "title", text: "Directionally Local" });
    assert.ok(events.some((event) => event.event === "line" && event.label === "OpenRouter API key" && event.detail === "kept in Hotcell · from your laptop"));
    assert.ok(events.some((event) => event.event === "line" && event.label === "GitHub token" && event.detail === "signed in as octo · from your laptop"));
    assert.ok(!events.some((event) => event.event === "questions"));
    const plan = events.find((event) => event.event === "plan") as { steps: Array<{ id: string }> };
    assert.deepEqual(plan.steps.map((step) => step.id), ["docker", "software", "image", "services", "access"]);
    assert.deepEqual(events.at(-1), { event: "ready", headline: "Ready", items: [{ label: "On your laptop, from inside a GitHub repository", value: 'dl run "fix the flaky checkout test"' }] });
    for (const secret of [OPENROUTER_KEY, GITHUB_TOKEN]) {
      assert.ok(!run.out().includes(secret), "no secret in the events");
      assert.ok(!system.ran.some((command) => command.includes(secret)), "no secret in any command line");
      assert.ok(!system.logs.some((line) => line.includes(secret)), "no secret in the log");
    }
    assert.deepEqual(system.logs, [], "with a UI given, nothing else is printed");

    // A repair needs nothing: what the server has is kept.
    const again = await laptopUp(system, {});
    await again.result;
    assert.equal(again.events().at(-1)?.event, "ready");
  });

  it("fails before changing anything when a required answer is missing or invalid", async () => {
    const system = new FakeSystem();
    const missing = await laptopUp(system, { openrouterKey: OPENROUTER_KEY });
    await assert.rejects(missing.result, /This server needs a GitHub token and none was given by your laptop\./);
    assert.ok(missing.events().some((event) => event.event === "line" && event.status === "failed" && event.label === "GitHub token"));

    const invalid = await laptopUp(system, { openrouterKey: "sk-proj-nope", githubToken: GITHUB_TOKEN });
    await assert.rejects(invalid.result, /doesn't look like an OpenRouter key/);
    assert.deepEqual(system.commands, [], "only probes ran");
    assert.equal(system.files.has(PATHS.state), false);
  });

  it("switching an install from Tailscale to ssh stops publishing it on the tailnet", async () => {
    const system = new FakeSystem();
    await up(system, { prompter: answers(), fetchImpl: fetchOk, sleep: noSleep });
    assert.equal(system.serving, true);
    await (await laptopUp(system, {})).result;
    assert.equal(system.serving, false);
    assert.deepEqual((await readState(system))?.access, { mode: "ssh", url: "http://127.0.0.1:4096" });
  });

  it("keeps loopback access as before", async () => {
    const system = new FakeSystem();
    const result = await up(system, { prompter: answers(), env: { DL_ACCESS: "loopback" }, fetchImpl: fetchOk, sleep: noSleep });
    assert.equal(result.url, "http://127.0.0.1:4096");
    assert.deepEqual((await readState(system))?.access, { mode: "loopback", url: "http://127.0.0.1:4096" });
    assert.ok(!system.ran.some((command) => command.startsWith("tailscale")));
    assert.ok(system.logs.some((line) => line.includes("ssh -N -L 4096:127.0.0.1:4096 root@<this-server>")));
    assert.ok(result.ownerLink, "the owner link is still made for loopback");
  });

  it("names the access mode from --access or DL_ACCESS, and refuses others", async () => {
    assert.equal(parseAccessMode("ssh"), "ssh");
    assert.throws(() => parseAccessMode("public"), /--access must be tailscale, loopback or ssh \(got "public"\)/);
    const system = new FakeSystem();
    await assert.rejects(up(system, { prompter: neverAsk, env: { DL_ACCESS: "public" }, fetchImpl: fetchOk, sleep: noSleep }), /DL_ACCESS must be tailscale, loopback or ssh/);
    // The flag wins over the environment.
    assert.deepEqual(await needs(new FakeSystem(), { access: "ssh", env: { DL_ACCESS: "tailscale" } }), ["openrouter", "github"]);
  });

  it("parses the stdin answers without ever quoting them", () => {
    assert.deepEqual(parseProvidedAnswers(`{"openrouterKey":"${OPENROUTER_KEY}","githubToken":"${GITHUB_TOKEN}","extra":1}\n`), { openrouterKey: OPENROUTER_KEY, githubToken: GITHUB_TOKEN });
    assert.deepEqual(parseProvidedAnswers("{}"), {});
    for (const bad of [`{"openrouterKey":"${OPENROUTER_KEY}"`, `["${OPENROUTER_KEY}"]`, "", `{"githubToken":42}`]) {
      assert.throws(() => parseProvidedAnswers(bad), (error: Error) => !error.message.includes(OPENROUTER_KEY) && /stdin/.test(error.message));
    }
  });

  it("--needs lists what a fresh machine lacks, and nothing once installed, changing nothing", async () => {
    const fresh = new FakeSystem();
    const before = snapshot(fresh);
    assert.deepEqual(await needs(fresh, { access: "ssh" }), ["openrouter", "github"]);
    assert.deepEqual(await needs(fresh, { env: {} }), ["tailscale", "openrouter", "github"], "tailscale is the default access on a fresh machine");
    assert.deepEqual(await needs(new FakeSystem({ tailscale: true, tailscaleUp: true }), { access: "tailscale" }), ["openrouter", "github"], "already on a tailnet");
    assert.equal(snapshot(fresh), before, "nothing changed");

    const installed = new FakeSystem();
    await (await laptopUp(installed, { openrouterKey: OPENROUTER_KEY, githubToken: GITHUB_TOKEN })).result;
    const after = snapshot(installed);
    assert.deepEqual(await needs(installed, { env: {} }), [], "ssh is remembered from the state");
    assert.deepEqual(await needs(installed, { access: "tailscale" }), ["tailscale"]);
    installed.hotcellKeys.clear();
    assert.deepEqual(await needs(installed, { access: "ssh" }), ["openrouter"]);
    installed.hotcellKeys.add("openrouter");
    assert.equal(snapshot(installed), after, "nothing changed");
  });
});
