import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PATHS, parseEnvFile } from "./layout.js";
import { ScriptedPrompter } from "./prompt.js";
import { readState } from "./state.js";
import { FakeSystem } from "./test-support/fake-system.js";
import { up, validateGitHubToken, validateOpenRouterKey } from "./up.js";

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

describe("directionally-local up", () => {
  it("installs everything on a fresh Ubuntu server and keeps secrets out of argv and logs", async () => {
    const system = new FakeSystem();
    const prompter = answers();
    const result = await up(system, { prompter, fetchImpl: fetchOk, sleep: noSleep, now: () => new Date("2026-10-21T10:00:00Z") });

    // Only the three questions: access (Tailscale key), model key, GitHub.
    assert.equal(prompter.asked.length, 3);
    assert.equal(result.url, "https://box.tail1234.ts.net");
    assert.match(result.ownerLink ?? "", /^https:\/\/box\.tail1234\.ts\.net\/api\/v1\/auth\/claim\?token=aster_claim_/);
    assert.equal(result.capacity, 6, "8 GB minus the host's share, 1 GB per sandbox");
    assert.ok(system.logs.includes("✓ Ready. Fits ~6 agents at once (estimate)."));
    assert.ok(system.logs.some((line) => line.includes("autopilot remote add https://box.tail1234.ts.net")));

    // Docker, accounts, software, image, services, access.
    assert.ok(system.ran.some((command) => command.includes("get.docker.com")));
    assert.ok(system.users.has("hotcell") && system.users.has("autopilot"));
    assert.ok(system.ran.includes("npm install --prefix /opt/directionally-local/releases/autopilot-2.2.0_hotcell-0.1.26 --no-audit --no-fund --omit=dev autopilot-ai@2.2.0 hotcell@0.1.26"));
    assert.ok(system.images.has("directionally-local-cell:2.2.0"));
    for (const unit of ["directionally-local-metadata-block.service", "hotcell.service", "autopilot.service"]) assert.ok(system.enabled.has(unit), unit);
    assert.ok(system.ran.includes("tailscale serve --bg --https=443 http://127.0.0.1:4096"));

    // The model key reaches Hotcell over stdin only; the GitHub token only its 0640 env file.
    const keysAdd = system.commands.find(({ args }) => args.includes("keys") && args.includes("add"))!;
    assert.equal(keysAdd.input, OPENROUTER_KEY);
    for (const secret of [OPENROUTER_KEY, GITHUB_TOKEN, TAILSCALE_KEY]) {
      assert.ok(!system.ran.some((command) => command.includes(secret)), "no secret in any command line");
      assert.ok(!system.logs.some((line) => line.includes(secret)), "no secret in the output");
    }
    assert.ok(system.ran.some((command) => command.startsWith("tailscale up --auth-key=file:/etc/directionally-local/tailscale-auth-key")));
    assert.equal(system.files.has("/etc/directionally-local/tailscale-auth-key"), false, "the auth key file is removed after use");
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
    assert.ok(system.ran.includes("ufw allow in on docker0 to 172.17.0.1 port 4752 proto tcp comment directionally-local sandboxes"));
    assert.ok(system.ran.includes("ufw allow in on docker0 to 172.17.0.1 port 4760 proto tcp comment directionally-local sandboxes"));
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
    assert.match(await validateGitHubToken(GITHUB_TOKEN, rejected, system) ?? "", /rejected/);
    assert.equal(await validateGitHubToken(GITHUB_TOKEN, fetchOk, system), undefined);
    assert.ok(system.logs.includes("  GitHub: signed in as octo"));
  });
});
