import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ScriptedPrompter } from "../prompt.js";
import { RecordingUi } from "../ui.js";
import { autopilotConfigPath, gatherKeys, type KeySources } from "./credentials.js";

const GH = `gho_${"a".repeat(36)}`;
const PAT = `github_pat_${"b".repeat(40)}`;
const OR_ENV = "sk-or-v1-fromenvironment000";
const OR_AUTOPILOT = "sk-or-v1-fromautopilot0000";
const OR_TYPED = "sk-or-v1-typedbythehuman00";

/** GitHub knows the gh token as sinameraji; OpenRouter accepts everything but `rejected`. */
function sources(overrides: Partial<KeySources> & { rejected?: string[] } = {}): KeySources & { fetched: string[] } {
  const fetched: string[] = [];
  const rejected = overrides.rejected ?? [];
  return {
    env: {},
    home: "/home/me",
    readFile: async () => undefined,
    gh: async () => undefined,
    fetch: (async (url: string | URL, init?: RequestInit) => {
      fetched.push(String(url));
      const auth = String((init?.headers as Record<string, string>).Authorization).replace("Bearer ", "");
      if (rejected.includes(auth)) return new Response("{}", { status: 401 });
      return String(url).includes("api.github.com") ? Response.json({ login: auth === GH ? "sinameraji" : "octo" }) : Response.json({ data: {} });
    }) as typeof fetch,
    fetched,
    ...overrides,
  };
}

describe("keys from this laptop", () => {
  it("offers the GitHub CLI login and Autopilot's OpenRouter key, each with a Y/n", async () => {
    const ui = new RecordingUi();
    const prompter = new ScriptedPrompter({ "Use your GitHub CLI login (sinameraji)? It stays on your server.": "", "Use the OpenRouter key from Autopilot?": "y" });
    const src = sources({
      gh: async () => `${GH}\n`,
      env: { XDG_CONFIG_HOME: "/xdg" },
      readFile: async (path) => path === "/xdg/kimiflare/config.json" ? JSON.stringify({ openrouterApiKey: OR_AUTOPILOT }) : undefined,
    });
    const answers = await gatherKeys(["openrouter", "github"], { ui, prompter, sources: src });
    assert.deepEqual(answers, { githubToken: GH, openrouterKey: OR_AUTOPILOT });
    assert.equal(prompter.asked.length, 2);
    assert.deepEqual(ui.events.filter((event) => event.startsWith("answered")), ["answered GitHub | signed in as sinameraji · from the GitHub CLI", "answered OpenRouter | from Autopilot"]);
    assert.deepEqual(src.fetched, ["https://api.github.com/user", "https://openrouter.ai/api/v1/key"], "both keys are checked first");
    assert.equal(autopilotConfigPath({}, "/home/me"), "/home/me/.config/kimiflare/config.json");
  });

  it("prefers OPENROUTER_API_KEY, and asks (hidden) when an offer is declined", async () => {
    const ui = new RecordingUi();
    const prompter = new ScriptedPrompter({ "Use your GitHub CLI login": "n", "GitHub token": PAT, "OPENROUTER_API_KEY": "" });
    const answers = await gatherKeys(["github", "openrouter"], { ui, prompter, sources: sources({ gh: async () => GH, env: { OPENROUTER_API_KEY: OR_ENV } }) });
    assert.deepEqual(answers, { githubToken: PAT, openrouterKey: OR_ENV });
    assert.ok(ui.events.includes("answered GitHub | signed in as octo"));
  });

  it("skips keys that don't work and retries what's typed", async () => {
    const ui = new RecordingUi();
    let attempts = 0;
    const prompter = new ScriptedPrompter({});
    prompter.secret = async (question) => {
      prompter.asked.push(question);
      return attempts++ === 0 ? "not-a-key" : OR_TYPED;
    };
    const answers = await gatherKeys(["openrouter"], { ui, prompter, sources: sources({ env: { OPENROUTER_API_KEY: OR_ENV }, rejected: [OR_ENV] }) });
    assert.deepEqual(answers, { openrouterKey: OR_TYPED });
    assert.ok(ui.events.some((event) => /^warn The OpenRouter key from OPENROUTER_API_KEY didn't work \(OpenRouter rejected that key\.\)/.test(event)));
    assert.ok(ui.events.includes("rejected That doesn't look like an OpenRouter key (sk-or-…). Try again."));
    assert.deepEqual(prompter.asked, ["OpenRouter key", "OpenRouter key"]);
  });

  it("asks only for what the server needs, and nothing when it has both", async () => {
    const prompter = new ScriptedPrompter({ "GitHub token": PAT });
    assert.deepEqual(await gatherKeys(["github"], { ui: new RecordingUi(), prompter, sources: sources() }), { githubToken: PAT });
    assert.deepEqual(prompter.asked, ["GitHub token"]);
    const ui = new RecordingUi();
    assert.deepEqual(await gatherKeys([], { ui, prompter: new ScriptedPrompter({}), sources: sources({ gh: async () => GH }) }), {});
    assert.deepEqual(ui.events, []);
  });

  it("isn't stopped by being offline", async () => {
    const offline = sources({ gh: async () => GH, fetch: (async () => { throw new Error("offline"); }) as typeof fetch });
    const prompter = new ScriptedPrompter({ "Use your GitHub CLI login? It stays": "" });
    assert.deepEqual(await gatherKeys(["github"], { ui: new RecordingUi(), prompter, sources: offline }), { githubToken: GH });
  });
});
