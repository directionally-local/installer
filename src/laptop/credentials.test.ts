import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ScriptedPrompter } from "../prompt.js";
import { RecordingUi } from "../ui.js";
import { autopilotConfigPath, githubToken, type KeySources } from "./credentials.js";

const GH = `gho_${"a".repeat(36)}`;
const PAT = `github_pat_${"b".repeat(40)}`;

/** GitHub knows the gh token as sinameraji and refuses anything in `rejected`. */
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
      return Response.json({ login: auth === GH ? "sinameraji" : "octo" });
    }) as typeof fetch,
    fetched,
    ...overrides,
  };
}

describe("the GitHub token from this laptop", () => {
  it("offers the GitHub CLI login with a Y/n, checked with GitHub first", async () => {
    const ui = new RecordingUi();
    const prompter = new ScriptedPrompter({ "Use your GitHub CLI login (sinameraji)? It stays on your server.": "" });
    const src = sources({ gh: async () => `${GH}\n` });
    assert.equal(await githubToken({ ui, prompter, sources: src }), GH);
    assert.equal(prompter.asked.length, 1);
    assert.deepEqual(ui.events, ["answered GitHub | signed in as sinameraji · from the GitHub CLI"]);
    assert.deepEqual(src.fetched, ["https://api.github.com/user"]);
    assert.equal(autopilotConfigPath({}, "/home/me"), "/home/me/.config/kimiflare/config.json");
  });

  it("asks (hidden) when the offer is declined, and says why in one line when gh isn't signed in", async () => {
    const declined = new RecordingUi();
    const prompter = new ScriptedPrompter({ "Use your GitHub CLI login": "n", "GitHub token": PAT });
    assert.equal(await githubToken({ ui: declined, prompter, sources: sources({ gh: async () => GH }) }), PAT);
    assert.ok(declined.events.includes("answered GitHub | signed in as octo"));
    assert.ok(!declined.events.some((event) => event.startsWith("line info GitHub")), "no explanation needed when gh was offered");

    const ui = new RecordingUi();
    assert.equal(await githubToken({ ui, prompter: new ScriptedPrompter({ "GitHub token": PAT }), sources: sources(), place: "this computer" }), PAT);
    assert.deepEqual(ui.events, [
      "line info GitHub | agents push branches and open pull requests through GitHub; a token stays on this computer",
      "answered GitHub | signed in as octo",
    ]);
  });

  it("retries a token GitHub refuses or that isn't one, three times at most", async () => {
    const ui = new RecordingUi();
    const replies = ["not-a-token", PAT];
    const prompter = new ScriptedPrompter({});
    prompter.secret = async (question) => {
      prompter.asked.push(question);
      return replies.shift()!;
    };
    assert.equal(await githubToken({ ui, prompter, sources: sources() }), PAT);
    assert.ok(ui.events.includes("rejected That doesn't look like a GitHub token (github_pat_… or ghp_…). Try again."));
    assert.deepEqual(prompter.asked, ["GitHub token", "GitHub token"]);
    const always = new ScriptedPrompter({ "GitHub token": "nope" });
    await assert.rejects(() => githubToken({ ui: new RecordingUi(), prompter: always, sources: sources() }), /doesn't look like a GitHub token/);
    assert.equal(always.asked.length, 3);
  });

  it("isn't stopped by being offline", async () => {
    const offline = sources({ gh: async () => GH, fetch: (async () => { throw new Error("offline"); }) as typeof fetch });
    const prompter = new ScriptedPrompter({ "Use your GitHub CLI login? It stays": "" });
    assert.equal(await githubToken({ ui: new RecordingUi(), prompter, sources: offline }), GH);
  });
});
