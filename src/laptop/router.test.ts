import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ScriptedPrompter, type Prompter, type SelectOption } from "../prompt.js";
import type { DetectedAgent } from "./agent-catalog.js";
import type { AgentRequest, DlKey } from "./dl-key.js";
import {
  AGAIN_QUESTION, AUTOPILOT_ROW, autopilotKeyEnv, FIRST_QUESTION, INSTALL_AUTOPILOT, NOTHING_FOUND, orderAgents, pickerOptions, readAgentHistory, recordAgentUse, routerHome, THANKS,
  type RouterDeps,
} from "./router.js";

const KEY: DlKey = { key: "dl_sk_0123456789abcdef", plan: "starter", baseUrl: "https://api.dl.new", anthropicBaseUrl: "https://api.dl.new/anthropic", savedAt: "" };
const CLAUDE: DetectedAgent = { id: "claude-code", name: "Claude Code", how: ["claude"], path: "/bin/claude", dl: "claude" };
const OPENCODE: DetectedAgent = { id: "opencode", name: "OpenCode", how: ["opencode"], path: "/bin/opencode", dl: "opencode" };
const CURSOR: DetectedAgent = { id: "cursor", name: "Cursor", how: ["app"] };
const WINDSURF: DetectedAgent = { id: "windsurf", name: "Windsurf", how: ["app"], noCustomModels: true };

/** Records the options each question showed, and answers from a script. */
class Recording implements Prompter {
  readonly shown: Array<{ question: string; options: SelectOption[]; initial: number }> = [];
  private readonly inner: ScriptedPrompter;
  constructor(answers: Record<string, string>) { this.inner = new ScriptedPrompter(answers); }
  choose(q: string) { return this.inner.choose(q); }
  secret(q: string) { return this.inner.secret(q); }
  text(q: string) { return this.inner.text(q); }
  select(question: string, options: SelectOption[], initial = 0) {
    this.shown.push({ question, options, initial });
    return this.inner.select(question, options, initial);
  }
}

async function world(found: DetectedAgent[], answers: Record<string, string>, options: { signedIn?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "dl-router-"));
  let out = "";
  const launched: Array<[string, string[]]> = [];
  const autopilot: Array<{ continue?: boolean }> = [];
  const reports: AgentRequest[] = [];
  const prompter = new Recording(answers);
  let clock = Date.parse("2026-11-26T00:00:00Z");
  const deps: RouterDeps = {
    io: { out: (text) => { out += text; }, err: (text) => { out += text; } },
    prompter,
    signIn: async () => options.signedIn === false ? undefined : KEY,
    detect: async () => found,
    autopilotInstalled: async () => false,
    launch: async (command, args) => (launched.push([command, args]), 0),
    autopilot: async (_key, run) => (autopilot.push(run), 0),
    report: async (request) => void reports.push(request),
    dlVersion: "0.48.0",
    historyPath: join(dir, "agents.json"),
    now: () => new Date(clock += 1000),
  };
  return { deps, prompter, launched, autopilot, reports, text: () => out, path: deps.historyPath! };
}

describe("bare dl: the router", () => {
  it("first run: asks which of the found agents to use, Autopilot a quiet last row, and opens the pick", async () => {
    const w = await world([CLAUDE, CURSOR], { [FIRST_QUESTION]: "Claude Code" });
    assert.equal(await routerHome(w.deps), 0);
    const { question, options, initial } = w.prompter.shown[0]!;
    assert.match(question, /I found these on your computer\. Which one do you want to use\?/);
    assert.deepEqual(options.map((o) => o.label), ["Claude Code", "Cursor", AUTOPILOT_ROW]);
    assert.equal(options[2]!.quiet, true);
    assert.equal(options[2]!.detail, "downloads when picked");
    assert.equal(options[1]!.detail, "app · set up by hand");
    assert.equal(initial, 0);
    assert.deepEqual(w.launched, [["claude", []]]);
    assert.equal((await readAgentHistory(w.path)).lastUsed, "claude-code");
  });

  it("remembers: the last one used is on top, marked, and Enter opens it", async () => {
    const w = await world([CLAUDE, OPENCODE, CURSOR], { [FIRST_QUESTION]: "OpenCode", [AGAIN_QUESTION]: "" });
    await routerHome(w.deps);
    await routerHome(w.deps);
    const again = w.prompter.shown[1]!;
    assert.match(again.question, /Which coding agent\?/);
    assert.deepEqual(again.options.map((o) => [o.label, o.accent ?? ""]), [["OpenCode", "last used"], ["Claude Code", ""], ["Cursor", ""], [AUTOPILOT_ROW, ""]]);
    assert.deepEqual(w.launched, [["opencode", []], ["opencode", []]]);
  });

  it("orders by most recent use, then catalog order; Autopilot moves to the top when it was last used", async () => {
    const history = { lastUsed: "autopilot", used: { cursor: "2026-11-20T00:00:00Z", autopilot: "2026-11-25T00:00:00Z" } };
    assert.deepEqual(orderAgents([CLAUDE, OPENCODE, CURSOR], history).map((a) => a.id), ["cursor", "claude-code", "opencode"]);
    const options = pickerOptions([CLAUDE, CURSOR], history, true);
    assert.deepEqual(options.map((o) => [o.value, o.accent ?? ""]), [["autopilot", "last used"], ["cursor", ""], ["claude-code", ""]]);
    assert.equal(options[0]!.detail, undefined, "installed: nothing to download");
  });

  it("an app dl can't start: the exact steps, the key and both base URLs", async () => {
    const w = await world([CURSOR], { [FIRST_QUESTION]: "Cursor" });
    assert.equal(await routerHome(w.deps), 0);
    assert.match(w.text(), /Set up Cursor with dl/);
    assert.match(w.text(), /Override OpenAI Base URL and enter https:\/\/api\.dl\.new\/v1/);
    assert.match(w.text(), /dl_sk_0123456789abcdef/);
    assert.match(w.text(), /https:\/\/api\.dl\.new\/anthropic/);
    assert.deepEqual(w.launched, []);
    assert.equal((await readAgentHistory(w.path)).lastUsed, "cursor");
  });

  it("an agent with no custom models: says so and tells the service", async () => {
    const w = await world([WINDSURF], { [FIRST_QUESTION]: "Windsurf" });
    assert.equal(await routerHome(w.deps), 0);
    assert.match(w.text(), /Windsurf only runs its own models for now/);
    assert.deepEqual(w.reports.map((r) => [r.name, r.found]), [["Windsurf", ["windsurf"]]]);
  });

  it("picking Autopilot downloads and opens it", async () => {
    const w = await world([CLAUDE], { [FIRST_QUESTION]: AUTOPILOT_ROW });
    await routerHome(w.deps);
    assert.deepEqual(w.autopilot, [{}]);
    assert.equal((await readAgentHistory(w.path)).lastUsed, "autopilot");
  });

  it("dl -c continues the last agent's own latest session", async () => {
    const w = await world([CLAUDE, OPENCODE], { [FIRST_QUESTION]: "Claude Code" });
    await routerHome(w.deps);
    await routerHome(w.deps, { continue: true });
    assert.deepEqual(w.launched, [["claude", []], ["claude", ["--continue"]]]);
    assert.equal(w.prompter.shown.length, 1, "no question to continue");
  });

  it("stops when the sign-in didn't finish", async () => {
    const w = await world([CLAUDE], {}, { signedIn: false });
    assert.equal(await routerHome(w.deps), 1);
    assert.equal(w.prompter.shown.length, 0);
  });
});

describe("bare dl with no agent found", () => {
  const question = "Which agent do you use?";

  it("asks for the agent's name; an unknown one is reported, with thanks and the key to set it up", async () => {
    const w = await world([], { [question]: "Supercoder 9000" });
    assert.equal(await routerHome(w.deps), 0);
    assert.match(w.text(), new RegExp(NOTHING_FOUND.replace(".", "\\.")));
    assert.deepEqual(w.prompter.shown[0]!.options.map((o) => o.label), ["Type the name of the agent you use", INSTALL_AUTOPILOT]);
    assert.equal(w.prompter.shown[0]!.options[0]!.input?.inline, true);
    assert.deepEqual(w.reports.map((r) => [r.name, r.dlVersion, r.found]), [["Supercoder 9000", "0.48.0", []]]);
    assert.ok(w.text().includes(THANKS));
    assert.match(w.text(), /dl_sk_0123456789abcdef[\s\S]*https:\/\/api\.dl\.new\/v1/);
  });

  it("a known agent's name gets its steps; Enter alone skips; Install Autopilot opens Autopilot", async () => {
    const known = await world([], { [question]: "aider" });
    await routerHome(known.deps);
    assert.match(known.text(), /aider --openai-api-base https:\/\/api\.dl\.new\/v1/);
    assert.deepEqual(known.reports, []);

    const skipped = await world([], { [question]: "" });
    assert.equal(await routerHome(skipped.deps), 0);
    assert.deepEqual(skipped.reports, []);
    assert.match(skipped.text(), /Your key and base URLs/);

    const install = await world([], { [question]: INSTALL_AUTOPILOT });
    await routerHome(install.deps);
    assert.deepEqual(install.autopilot, [{}]);
  });
});

describe("agent history and Autopilot's key", () => {
  it("records the last agent used, with times", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "dl-router-")), "agents.json");
    assert.deepEqual(await readAgentHistory(path), { used: {} });
    await recordAgentUse("pi", path, () => new Date("2026-11-01T00:00:00Z"));
    await recordAgentUse("cursor", path, () => new Date("2026-11-02T00:00:00Z"));
    assert.deepEqual(await readAgentHistory(path), { lastUsed: "cursor", used: { pi: "2026-11-01T00:00:00.000Z", cursor: "2026-11-02T00:00:00.000Z" } });
  });

  it("gives Autopilot the key, and dl's plan as its provider only when it has none", () => {
    assert.deepEqual(autopilotKeyEnv(KEY, undefined), { AUTOPILOT_DL_FREE_TOKEN: KEY.key, AUTOPILOT_PROVIDER: "directionally-local" });
    assert.deepEqual(autopilotKeyEnv(KEY, "openrouter"), { AUTOPILOT_DL_FREE_TOKEN: KEY.key });
  });
});
