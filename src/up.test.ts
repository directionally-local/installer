import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PATHS, parseEnvFile } from "./layout.js";
import { ScriptedPrompter } from "./prompt.js";
import { readState } from "./state.js";
import { FakeSystem } from "./test-support/fake-system.js";
import { JsonUi } from "./ui.js";
import { hotcellRoutes, needs, parseAccessMode, parseProvidedAnswers, providerFromEnv, up, validateGitHubToken, validateOpenRouterKey } from "./up.js";
import { withCatalog } from "./test-support/fake-catalog.js";
import { openrouterAnswer, type ProviderAnswer } from "./provider.js";
import { pinnedAutopilotVersion } from "./versions.js";

const OPENROUTER_KEY = `sk-or-v1-${"a".repeat(40)}`;
const OPENROUTER: ProviderAnswer = openrouterAnswer(OPENROUTER_KEY);
const DEEPSEEK: ProviderAnswer = { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKey: "sk-deepseek-0000000000", apiKeyEnv: "DEEPSEEK_API_KEY" };
const AUTOPILOT = pinnedAutopilotVersion();
const GITHUB_TOKEN = `github_pat_${"b".repeat(40)}`;
const TAILSCALE_KEY = "tskey-auth-kAbC123-XyZ";

const answers = () => new ScriptedPrompter({
  "Tailscale auth key": TAILSCALE_KEY,
  "OpenRouter API key": OPENROUTER_KEY,
  "GitHub token": GITHUB_TOKEN,
});

/** OpenRouter and GitHub accept the test credentials. */
const fetchOk = withCatalog((async (url: string | URL | Request) =>
  String(url).includes("api.github.com") ? Response.json({ login: "octo" }) : Response.json({ data: {} })) as typeof fetch);

const noSleep = async () => {};

/** For the laptop's mode: any question is a bug, since there's no one to answer it. */
const neverAsk = {
  choose: async () => { throw new Error("asked a question"); },
  select: async () => { throw new Error("asked a question"); },
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
    // Autopilot is the version this dl pins (never npm's latest), Hotcell npm's latest.
    assert.ok(system.ran.includes(`npm install --prefix /opt/directionallylocal/releases/autopilot-${AUTOPILOT}_hotcell-0.1.26 --no-audit --no-fund --omit=dev autopilot-ai@${AUTOPILOT} hotcell@0.1.26`), system.ran.join("\n"));
    assert.ok(!system.ran.includes("npm view autopilot-ai version"));
    assert.ok(system.images.has(`directionallylocal-cell:${AUTOPILOT}`));
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
    assert.equal(state?.release, `autopilot-${AUTOPILOT}_hotcell-0.1.26`);
    assert.equal(state?.autopilotVersion, AUTOPILOT);
    assert.deepEqual(state?.access, { mode: "tailscale", url: "https://box.tail1234.ts.net" });
    // The OpenRouter key typed at the server's own terminal is the OpenRouter provider, named in aster.json.
    assert.deepEqual(JSON.parse(system.files.get(PATHS.asterConfig)!.content).provider, { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" });
  });

  it("installs unpublished builds named by DL_AUTOPILOT_SPEC and DL_HOTCELL_SPEC, and always rebuilds for them", async () => {
    const system = new FakeSystem();
    const env = { DL_AUTOPILOT_SPEC: "/tmp/autopilot-ai-dev.tgz", DL_HOTCELL_SPEC: "hotcell@next" };
    await up(system, { prompter: answers(), env, fetchImpl: fetchOk, sleep: noSleep });
    assert.ok(system.ran.includes("npm install --prefix /opt/directionallylocal/releases/autopilot-dev_hotcell-dev --no-audit --no-fund --omit=dev /tmp/autopilot-ai-dev.tgz hotcell@next"), system.ran.join("\n"));
    assert.ok(system.ran.some((command) => command.startsWith("npm pack /tmp/autopilot-ai-dev.tgz ")), "the image is built from the same build");
    assert.ok(system.images.has("directionallylocal-cell:dev"));
    const state = await readState(system);
    assert.equal(state?.autopilotVersion, "9.9.9-dev.autopilot-ai", "the installed build's own version is recorded");
    assert.equal(state?.hotcellVersion, "next", "whatever the spec installed");
    const installs = () => system.ran.filter((command) => command.startsWith("npm install") || command.startsWith("docker build")).length;
    const before = installs();
    await up(system, { prompter: new ScriptedPrompter({}), env, fetchImpl: fetchOk, sleep: noSleep });
    assert.equal(installs(), before + 2, "a dev build may have changed: installed and built again");
  });

  it("writes OpenRouter's prices for Hotcell's spend-capped gateway before Hotcell starts", async () => {
    const system = new FakeSystem();
    const run = system.run.bind(system);
    let pricesAtRestart: string | undefined;
    system.run = async (command, args, options) => {
      if (command === "systemctl" && args.join(" ") === "restart hotcell.service") pricesAtRestart = system.files.get(PATHS.modelPrices)?.content;
      return run(command, args, options);
    };
    await up(system, { prompter: answers(), fetchImpl: fetchOk, sleep: noSleep });
    const prices = system.files.get(PATHS.modelPrices)!;
    assert.equal(PATHS.modelPrices, "/var/lib/hotcell/model-prices.json");
    assert.deepEqual({ mode: prices.mode, owner: prices.owner }, { mode: 0o644, owner: "hotcell:hotcell" });
    assert.deepEqual(JSON.parse(prices.content), {
      "meta-llama/llama-5-8b:free": { inputPerMTok: 0, outputPerMTok: 0 },
      "moonshotai/kimi-k2.6": { inputPerMTok: 0.6, outputPerMTok: 2.5 },
      "openai/gpt-6-luna": { inputPerMTok: 2.5, outputPerMTok: 10 },
    });
    assert.equal(pricesAtRestart, prices.content, "in place when Hotcell (re)starts, which is when it reads them");
    assert.equal(parseEnvFile(system.files.get(PATHS.hotcellEnv)?.content).HOTCELL_MODEL_PRICES, PATHS.modelPrices);
    assert.ok(system.logs.includes("ok Starting services: sandboxes and keys ready · prices for 3 models"), system.logs.join("\n"));
  });

  it("finishes the install when openrouter.ai can't be reached for prices, keeping the last list", async () => {
    const offline = ((url: string | URL | Request, init?: RequestInit) =>
      String(url).endsWith("/api/v1/models") ? Promise.reject(new Error("getaddrinfo ENOTFOUND openrouter.ai")) : fetchOk(url, init)) as typeof fetch;
    const fresh = new FakeSystem();
    await up(fresh, { prompter: answers(), fetchImpl: offline, sleep: noSleep });
    assert.equal(fresh.files.has(PATHS.modelPrices), false);
    assert.ok(fresh.logs.some((line) => /^!! Couldn't download model prices .*Tasks will fail with "model not priced" until dl up can reach openrouter\.ai\./.test(line)), fresh.logs.join("\n"));
    assert.equal(parseEnvFile(fresh.files.get(PATHS.hotcellEnv)?.content).HOTCELL_MODEL_PRICES, PATHS.modelPrices);

    const system = new FakeSystem();
    await up(system, { prompter: answers(), fetchImpl: fetchOk, sleep: noSleep });
    const before = system.files.get(PATHS.modelPrices)!.content;
    await up(system, { prompter: new ScriptedPrompter({}), fetchImpl: offline, sleep: noSleep });
    assert.equal(system.files.get(PATHS.modelPrices)!.content, before);
    assert.ok(system.logs.some((line) => line.startsWith("!! Couldn't refresh model prices") && line.includes("kept the last list (3 models)")));
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
    assert.equal(system.hotcellKeyValues.get("openrouter"), OPENROUTER_KEY, "DL_OPENROUTER_API_KEY is the OpenRouter shorthand");
  });

  it("takes any provider from DL_PROVIDER, DL_PROVIDER_API_KEY and DL_PROVIDER_BASE_URL", async () => {
    const system = new FakeSystem({ docker: true, tailscale: true, tailscaleUp: true });
    await up(system, {
      prompter: neverAsk,
      env: { DL_PROVIDER: "deepseek", DL_PROVIDER_API_KEY: DEEPSEEK.apiKey!, DL_GITHUB_TOKEN: GITHUB_TOKEN },
      fetchImpl: fetchOk,
      sleep: noSleep,
    });
    assert.equal(system.hotcellKeyValues.get("deepseek"), DEEPSEEK.apiKey);
    const aster = JSON.parse(system.files.get(PATHS.asterConfig)!.content) as { provider: unknown; models: unknown };
    assert.deepEqual(aster.provider, { id: "deepseek", baseUrl: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY" });
    assert.equal(aster.models, "catalog");
    assert.ok(system.logs.includes("ok DeepSeek API key: kept in Hotcell · from the environment"), system.logs.join("\n"));

    // A custom provider needs its address; a keyless one no key.
    assert.deepEqual(providerFromEnv({ DL_PROVIDER: "myproxy", DL_PROVIDER_API_KEY: "k", DL_PROVIDER_BASE_URL: "https://llm.example.com/v1" }).provider, { id: "myproxy", baseUrl: "https://llm.example.com/v1", apiKey: "k", apiKeyEnv: "MYPROXY_API_KEY" });
    assert.deepEqual(providerFromEnv({ DL_PROVIDER: "myproxy", DL_PROVIDER_API_KEY: "k" }), { provider: undefined, providerId: "myproxy" }, "no address: asked for a key only, nothing to store");
    assert.deepEqual(providerFromEnv({ DL_PROVIDER: "ollama" }).provider, { id: "ollama", baseUrl: "http://127.0.0.1:11434/v1", apiKey: null, apiKeyEnv: "OLLAMA_API_KEY" });
    assert.deepEqual(providerFromEnv({}), { provider: undefined, providerId: undefined });
  });

  it("re-asks a rejected key and refuses an unsupported machine before changing anything", async () => {
    const system = new FakeSystem({ tailscale: true, tailscaleUp: true });
    const replies = ["not-a-key", OPENROUTER_KEY];
    const prompter = {
      choose: async () => "tailscale",
      select: async () => { throw new Error("asked a question"); },
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
    const run = await laptopUp(system, { provider: OPENROUTER, githubToken: GITHUB_TOKEN }, { DL_OPENROUTER_API_KEY: "sk-or-ignored", DL_TAILSCALE_AUTH_KEY: TAILSCALE_KEY });
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

  it("installs without keys for the laptop, which sends them in a second pass after Autopilot's picker", async () => {
    const system = new FakeSystem();
    const first = await laptopUp(system, {});
    await first.result;
    assert.ok(first.events().some((event) => event.event === "line" && event.status === "info" && event.label === "OpenRouter API key" && event.detail === "not set yet"));
    assert.ok(first.events().some((event) => event.event === "line" && event.status === "info" && event.label === "GitHub token" && event.detail === "not set yet"));
    assert.equal(first.events().at(-1)?.event, "ready");
    assert.deepEqual(await needs(system, { access: "ssh" }), ["provider", "github"], "what the laptop asks for next");
    assert.equal(system.hotcellKeys.size, 0);

    const second = await laptopUp(system, { provider: DEEPSEEK, githubToken: GITHUB_TOKEN });
    await second.result;
    const add = system.commands.find(({ args }) => args.includes("keys") && args.includes("add"))!;
    assert.deepEqual(add.args.slice(add.args.indexOf("keys")), ["keys", "add", "deepseek", "--stdin"], "a built-in route needs only its id");
    assert.equal(add.input, DEEPSEEK.apiKey);
    assert.equal(parseEnvFile(system.files.get(PATHS.githubEnv)?.content).GITHUB_TOKEN, GITHUB_TOKEN);
    const aster = JSON.parse(system.files.get(PATHS.asterConfig)!.content) as { provider: unknown; models: unknown; workspaces: unknown[] };
    assert.deepEqual(aster.provider, { id: "deepseek", baseUrl: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY" });
    assert.equal(aster.models, "catalog");
    assert.equal(aster.workspaces.length, 1, "the rest of aster.json is kept");
    assert.ok(second.events().some((event) => event.event === "line" && event.label === "DeepSeek API key" && event.detail === "kept in Hotcell · from your laptop"));
    assert.deepEqual(await needs(system, { access: "ssh" }), []);
    assert.ok(!second.out().includes(DEEPSEEK.apiKey!));
    assert.deepEqual(await hotcellRoutes(system), [{ provider: "deepseek", active: true, mask: "sk-de…00" }]);

    // The provider can be replaced later the same way; a keyless one stores no key; a custom one its address.
    await (await laptopUp(system, { provider: { id: "ollama", baseUrl: "http://127.0.0.1:11434/v1", apiKey: null, apiKeyEnv: "OLLAMA_API_KEY" } })).result;
    const ollama = system.commands.filter(({ args }) => args.includes("keys") && args.includes("add")).at(-1)!;
    assert.deepEqual(ollama.args.slice(ollama.args.indexOf("keys")), ["keys", "add", "ollama"]);
    assert.equal(ollama.input, undefined);
    assert.equal((JSON.parse(system.files.get(PATHS.asterConfig)!.content) as { provider: { id: string } }).provider.id, "ollama");
    await (await laptopUp(system, { provider: { id: "myproxy", baseUrl: "https://llm.example.com/v1", apiKey: "k-1234567890", apiKeyEnv: "MYPROXY_API_KEY", authHeader: "x-api-key", authFormat: "{key}" } })).result;
    const custom = system.commands.filter(({ args }) => args.includes("keys") && args.includes("add")).at(-1)!;
    assert.deepEqual(custom.args.slice(custom.args.indexOf("keys")), ["keys", "add", "myproxy", "--stdin", "--base-url", "https://llm.example.com/v1", "--auth-header", "x-api-key", "--auth-format", "{key}"]);
    assert.equal(system.hotcellRouteUrls.get("myproxy"), "https://llm.example.com/v1");
  });

  it("fails before changing anything when an answer is invalid", async () => {
    const system = new FakeSystem();
    const invalid = await laptopUp(system, { provider: openrouterAnswer("sk-proj-nope"), githubToken: GITHUB_TOKEN });
    await assert.rejects(invalid.result, /doesn't look like an OpenRouter key/);
    assert.deepEqual(system.commands, [], "only probes ran");
    assert.equal(system.files.has(PATHS.state), false);
    assert.throws(() => parseProvidedAnswers(JSON.stringify({ provider: { id: "deepseek" } })), /needs an apiKey/);
    assert.throws(() => parseProvidedAnswers(JSON.stringify({ provider: { id: "myproxy", apiKey: "k" } })), /needs a baseUrl/);
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
    assert.deepEqual(await needs(new FakeSystem(), { access: "ssh", env: { DL_ACCESS: "tailscale" } }), ["provider", "github"]);
  });

  it("parses the stdin answers without ever quoting them, taking an older laptop's openrouterKey as the OpenRouter provider", () => {
    assert.deepEqual(parseProvidedAnswers(`{"openrouterKey":"${OPENROUTER_KEY}","githubToken":"${GITHUB_TOKEN}","extra":1}\n`), { provider: OPENROUTER, githubToken: GITHUB_TOKEN });
    assert.deepEqual(parseProvidedAnswers(JSON.stringify({ provider: DEEPSEEK, openrouterKey: OPENROUTER_KEY })), { provider: { id: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: DEEPSEEK.apiKey, apiKeyEnv: "DEEPSEEK_API_KEY", name: "DeepSeek" } }, "a provider block wins over the shorthand sent for older servers");
    assert.deepEqual(parseProvidedAnswers("{}"), {});
    for (const bad of [`{"openrouterKey":"${OPENROUTER_KEY}"`, `["${OPENROUTER_KEY}"]`, "", `{"githubToken":42}`, `{"provider":"${OPENROUTER_KEY}"}`]) {
      assert.throws(() => parseProvidedAnswers(bad), (error: Error) => !error.message.includes(OPENROUTER_KEY) && /stdin|provider/.test(error.message));
    }
  });

  it("--needs lists what a fresh machine lacks, and nothing once installed, changing nothing", async () => {
    const fresh = new FakeSystem();
    const before = snapshot(fresh);
    assert.deepEqual(await needs(fresh, { access: "ssh" }), ["provider", "github"]);
    assert.deepEqual(await needs(fresh, { env: {} }), ["tailscale", "provider", "github"], "tailscale is the default access on a fresh machine");
    assert.deepEqual(await needs(new FakeSystem({ tailscale: true, tailscaleUp: true }), { access: "tailscale" }), ["provider", "github"], "already on a tailnet");
    assert.equal(snapshot(fresh), before, "nothing changed");

    const installed = new FakeSystem();
    await (await laptopUp(installed, { provider: OPENROUTER, githubToken: GITHUB_TOKEN })).result;
    const after = snapshot(installed);
    assert.deepEqual(await needs(installed, { env: {} }), [], "ssh is remembered from the state");
    assert.deepEqual(await needs(installed, { access: "tailscale" }), ["tailscale"]);
    installed.hotcellKeys.clear();
    assert.deepEqual(await needs(installed, { access: "ssh" }), ["provider"]);
    installed.hotcellKeys.add("openrouter");
    installed.hotcellInactive.add("openrouter");
    assert.deepEqual(await needs(installed, { access: "ssh" }), ["provider"], "a route that's off doesn't count");
    installed.hotcellInactive.clear();
    assert.equal(snapshot(installed), after, "nothing changed");
  });
});
