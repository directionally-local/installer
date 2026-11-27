import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ScriptedPrompter, type Prompter, type SelectOption } from "../prompt.js";
import { AGENT_CATALOG, type DetectedAgent } from "./agent-catalog.js";
import type { AgentRequest, DlKey } from "./dl-key.js";
import {
  AGAIN_QUESTION, ALSO_FOUND, AUTOPILOT_PITCH, AUTOPILOT_ROW, autopilotKeyEnv, FIRST_QUESTION, markFirstTokensShown, OUR_AGENT, ANOTHER_AGENT, keyCard, setupText, NOTHING_FOUND, orderAgents, pickerOptions, readAgentHistory, recordAgentUse, routerHome, setupSteps, THANKS,
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

async function world(found: DetectedAgent[], answers: Record<string, string>, options: { signedIn?: boolean; firstTokens?: RouterDeps["firstTokens"]; launchCode?: number } = {}) {
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
    launch: async (command, args) => (launched.push([command, args]), options.launchCode ?? 0),
    autopilot: async (_key, run) => (autopilot.push(run), 0),
    report: async (request) => void reports.push(request),
    dlVersion: "0.48.0",
    historyPath: join(dir, "agents.json"),
    now: () => new Date(clock += 1000),
    ...(options.firstTokens ? { firstTokens: options.firstTokens } : {}),
  };
  return { deps, prompter, launched, autopilot, reports, text: () => out, path: deps.historyPath! };
}

describe("bare dl: the router", () => {
  it("first run: Autopilot first under \"Use our coding agent\", selected, then the agents found, and opens the pick", async () => {
    const w = await world([CLAUDE, OPENCODE, CURSOR], { [FIRST_QUESTION]: "Claude Code" });
    assert.equal(await routerHome(w.deps), 0);
    const { question, options, initial } = w.prompter.shown[0]!;
    assert.match(question, /Which one do you want to use\?/);
    assert.deepEqual(options.map((o) => [o.heading ?? "", o.label, o.accent ?? "", o.detail ?? ""]), [
      [OUR_AGENT, AUTOPILOT_ROW, AUTOPILOT_PITCH, "(downloads when picked)"],
      [ALSO_FOUND, "Claude Code", "", "claude"],
      ["", "OpenCode", "", "opencode"],
      ["", "Cursor", "", "app · set up by hand"],
    ]);
    assert.equal(OUR_AGENT, "Use our coding agent");
    assert.equal(ALSO_FOUND, "I also found these on your computer");
    assert.equal(AUTOPILOT_PITCH, "— recommended · included in your plan");
    assert.equal(initial, 0, "Autopilot is selected");
    assert.ok(!options[0]!.quiet);
    assert.deepEqual(w.launched, [["claude", []]]);
    assert.equal((await readAgentHistory(w.path)).lastUsed, "claude-code");
  });

  it("first run, Enter: Autopilot", async () => {
    const w = await world([CLAUDE], { [FIRST_QUESTION]: "" });
    await routerHome(w.deps);
    assert.deepEqual(w.autopilot, [{}]);
    assert.deepEqual(w.launched, []);
  });

  it("remembers: \"Back to <Agent>?\" stays first and selected, then Autopilot, then the rest; Enter opens it", async () => {
    const w = await world([CLAUDE, OPENCODE, CURSOR], { [FIRST_QUESTION]: "OpenCode", [AGAIN_QUESTION]: "" });
    await routerHome(w.deps);
    await routerHome(w.deps);
    const again = w.prompter.shown[1]!;
    assert.match(again.question, /Which coding agent\?/);
    assert.deepEqual(again.options.map((o) => [o.heading ?? "", o.label]), [["", "Back to OpenCode?"], [OUR_AGENT, AUTOPILOT_ROW], [ALSO_FOUND, "Claude Code"], ["", "Cursor"]]);
    assert.equal(again.initial, 0);
    assert.deepEqual(w.launched, [["opencode", []], ["opencode", []]]);
  });

  it("the last one used isn't here any more: Autopilot is first and selected again", () => {
    const options = pickerOptions([CLAUDE], { lastUsed: "pi", used: { pi: "2026-11-25T00:00:00Z" } }, false);
    assert.deepEqual(options.map((o) => o.label), [AUTOPILOT_ROW, "Claude Code"]);
  });

  it("orders by most recent use, then catalog order; \"Back to Autopilot?\" when it was last used, not listed twice", async () => {
    const history = { lastUsed: "autopilot", used: { cursor: "2026-11-20T00:00:00Z", autopilot: "2026-11-25T00:00:00Z" } };
    assert.deepEqual(orderAgents([CLAUDE, OPENCODE, CURSOR], history).map((a) => a.id), ["cursor", "claude-code", "opencode"]);
    const options = pickerOptions([CLAUDE, CURSOR], history, true);
    assert.deepEqual(options.map((o) => [o.value, o.label, o.heading ?? ""]), [["autopilot", "Back to Autopilot?", ""], ["cursor", "Cursor", ALSO_FOUND], ["claude-code", "Claude Code", ""]]);
    assert.equal(options[0]!.detail, undefined, "installed: nothing to download");
    assert.equal(pickerOptions([CLAUDE], history, false)[0]!.detail, "downloads when picked");
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

  it("by hand on Plus or Max: both models in the steps and the key card, and which to switch to", async () => {
    const w = await world([CURSOR], { [FIRST_QUESTION]: "Cursor" });
    w.deps.models = async () => ["moonshotai/kimi-k3.1-pro", "deepseek/deepseek-v4.1-flash-1017"];
    await routerHome(w.deps);
    const text = w.text();
    assert.match(text, /Add custom models named deepseek\/deepseek-v4\.1-flash-1017 and moonshotai\/kimi-k3\.1-pro and pick one in the chat/);
    assert.match(text, /Models {11}deepseek\/deepseek-v4\.1-flash-1017 {3}\(DeepSeek V4\.1 Flash, the default\)\n {21}moonshotai\/kimi-k3\.1-pro {12}\(Kimi K3\.1\)\n/);
    assert.match(text, /\n {2}Models on your plan: DeepSeek V4\.1 Flash, Kimi K3\.1 — switch in Cursor's model picker\n/);

    const free = await world([CURSOR], { [FIRST_QUESTION]: "Cursor" });
    free.deps.models = async () => { throw new Error("offline"); };
    await routerHome(free.deps);
    assert.match(free.text(), /Add a custom model named deepseek\/deepseek-v4\.1-flash-1017 and pick it in the chat/);
    assert.match(free.text(), /\n {2}Model on your plan: DeepSeek V4\.1 Flash\n/);
    assert.doesNotMatch(free.text(), /kimi/);
  });

  it("every by-hand agent's steps name Kimi K3.1's id when the plan has it, or point at the key card's (Codex can't run on the plan yet)", () => {
    const both = ["deepseek/deepseek-v4.1-flash-1017", "moonshotai/kimi-k3.1-pro"];
    for (const spec of AGENT_CATALOG) {
      if (spec.noCustomModels || spec.id === "autopilot" || spec.id === "opencode" || spec.id === "pi" || spec.id === "t3") continue;
      const steps = setupSteps(spec, KEY, both).join("\n");
      if (spec.id === "codex") assert.doesNotMatch(steps, /kimi/, spec.id);
      else if (/key and models below/.test(steps)) continue; // the generic steps: the key card lists both
      else assert.match(steps, /moonshotai\/kimi-k3\.1-pro/, `${spec.id}: ${steps}`);
      assert.doesNotMatch(setupSteps(spec, KEY).join("\n"), /kimi/, `${spec.id} on Free/Starter`);
    }
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

describe("the first run's touches", () => {
  const many: DetectedAgent[] = [CLAUDE, OPENCODE, CURSOR, WINDSURF, { id: "aider", name: "Aider", how: ["aider"] }];

  it("names each agent on one line as it's found, then the picker; five or more is a collection", async () => {
    const w = await world(many, { [FIRST_QUESTION]: "Claude Code" });
    const pauses: number[] = [];
    w.deps.sleep = async (ms) => void pauses.push(ms);
    await routerHome(w.deps);
    const text = w.text();
    assert.match(text, /\n {2}Looking on your computer… ✓ Claude Code {2}✓ OpenCode {2}✓ Cursor {2}✓ Windsurf {2}✓ Aider {2}You've got a collection\.\n/);
    assert.deepEqual(pauses, [80, 80, 80, 80], "≤ 80 ms apart, ≤ 400 ms in all");

    const two = await world([CLAUDE, CURSOR], { [FIRST_QUESTION]: "Cursor" });
    await routerHome(two.deps);
    assert.match(two.text(), /Looking on your computer… ✓ Claude Code {2}✓ Cursor\n/);
    assert.doesNotMatch(two.text(), /collection/);
  });

  it("keeps the scan within 400 ms however many are found, and skips it once an agent was used", async () => {
    const { scanStep } = await import("./onboarding.js");
    assert.equal(scanStep(1), 0);
    assert.equal(scanStep(5), 80);
    assert.equal(scanStep(12), 36);
    assert.ok(scanStep(30) * 29 <= 400);
    const w = await world([CLAUDE, CURSOR], { [FIRST_QUESTION]: "Claude Code", [AGAIN_QUESTION]: "" });
    await routerHome(w.deps);
    const before = w.text().length;
    await routerHome(w.deps);
    assert.doesNotMatch(w.text().slice(before), /Looking on your computer/, "no scan the second time");
  });

  it("after the first agent run that served tokens: the first-tokens line, once per install", async () => {
    let asked = 0;
    const w = await world([CLAUDE], { [FIRST_QUESTION]: "Claude Code", [AGAIN_QUESTION]: "" }, {
      firstTokens: async (key) => (asked++, assert.equal(key.key, KEY.key), { text: "First tokens served. ~9.9M left this week (95.5% caching applied).", done: true }),
    });
    await routerHome(w.deps);
    assert.match(w.text(), /\n {2}✓ First tokens served\. ~9\.9M left this week \(95\.5% caching applied\)\.\n/);
    assert.ok((await readAgentHistory(w.path)).firstTokensShown, "marked in dl's config");
    const before = w.text().length;
    await routerHome(w.deps);
    assert.equal(asked, 1, "never asked again");
    assert.doesNotMatch(w.text().slice(before), /First tokens/);
    // recordAgentUse keeps the mark.
    assert.equal((await readAgentHistory(w.path)).lastUsed, "claude-code");
    assert.ok((await readAgentHistory(w.path)).firstTokensShown);
  });

  it("skips the first-tokens line silently on an error, nothing served yet, or a failed run, and tries again later", async () => {
    const results: Array<{ text?: string; done: boolean } | Error> = [new Error("offline"), { done: false }, { text: "First tokens served. ~1M left this week (95.5% caching applied).", done: true }];
    const w = await world([CLAUDE], { [FIRST_QUESTION]: "Claude Code", [AGAIN_QUESTION]: "" }, {
      firstTokens: async () => { const next = results.shift()!; if (next instanceof Error) throw next; return next; },
    });
    await routerHome(w.deps);
    await routerHome(w.deps);
    assert.doesNotMatch(w.text(), /First tokens|offline|Error/);
    assert.equal((await readAgentHistory(w.path)).firstTokensShown, undefined);
    await routerHome(w.deps);
    assert.match(w.text(), /First tokens served\. ~1M left/);

    // `done` without a line (e.g. the service said no for good) isn't "shown": asked again next run.
    let asked = 0;
    const silent = await world([CLAUDE], { [FIRST_QUESTION]: "Claude Code", [AGAIN_QUESTION]: "" }, { firstTokens: async () => (asked++, { done: true }) });
    await routerHome(silent.deps);
    await routerHome(silent.deps);
    assert.equal(asked, 2);
    assert.equal((await readAgentHistory(silent.path)).firstTokensShown, undefined, "not marked without the line");
    assert.doesNotMatch(silent.text(), /First tokens/);

    const failed = await world([CLAUDE], { [FIRST_QUESTION]: "Claude Code" }, { launchCode: 1, firstTokens: async () => assert.fail("asked after a failed run") });
    assert.equal(await routerHome(failed.deps), 1);
  });

  it("an already-marked install never asks", async () => {
    const w = await world([CLAUDE], { [AGAIN_QUESTION]: "" }, { firstTokens: async () => assert.fail("asked") });
    await recordAgentUse("claude-code", w.path);
    await markFirstTokensShown(w.path);
    await routerHome(w.deps);
    assert.deepEqual(w.launched, [["claude", []]]);
  });
});

describe("bare dl with no agent found", () => {
  const question = FIRST_QUESTION;

  it("Autopilot first (selected), then a field for the agent's name; an unknown one is reported, with thanks and the key", async () => {
    const w = await world([], { [question]: "Supercoder 9000" });
    assert.equal(await routerHome(w.deps), 0);
    assert.equal(NOTHING_FOUND, "No agents here yet. Everyone starts somewhere.");
    assert.ok(w.text().includes(NOTHING_FOUND));
    const shown = w.prompter.shown[0]!;
    assert.deepEqual(shown.options.map((o) => [o.heading ?? "", o.label]), [[OUR_AGENT, AUTOPILOT_ROW], [ANOTHER_AGENT, "Type the name of the agent you use"]]);
    assert.equal(shown.initial, 0);
    assert.equal(shown.options[1]!.input?.inline, true);
    assert.deepEqual(w.reports.map((r) => [r.name, r.dlVersion, r.found]), [["Supercoder 9000", "0.48.0", []]]);
    assert.equal(THANKS, "Never heard of it — telling Sina.");
    assert.match(w.text(), /\n {2}Never heard of it — telling Sina\.\n[\s\S]*Key/, "then the key and base URLs");
    assert.match(w.text(), /dl_sk_0123456789abcdef[\s\S]*https:\/\/api\.dl\.new\/v1/);
  });

  it("a known agent's name gets its steps; Enter on the field skips; Enter on Autopilot opens it", async () => {
    const known = await world([], { [question]: "aider" });
    await routerHome(known.deps);
    assert.match(known.text(), /aider --openai-api-base https:\/\/api\.dl\.new\/v1/);
    assert.deepEqual(known.reports, []);

    const skipped = await world([], { [question]: "2" });
    assert.equal(await routerHome(skipped.deps), 0);
    assert.deepEqual(skipped.reports, []);
    assert.match(skipped.text(), /Your key and base URLs/);

    const install = await world([], { [question]: "" });
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
    await markFirstTokensShown(path, () => new Date("2026-11-03T00:00:00Z"));
    await recordAgentUse("pi", path, () => new Date("2026-11-04T00:00:00Z"));
    assert.deepEqual(await readAgentHistory(path), { lastUsed: "pi", used: { pi: "2026-11-04T00:00:00.000Z", cursor: "2026-11-02T00:00:00.000Z" }, firstTokensShown: "2026-11-03T00:00:00.000Z" });
  });

  it("gives Autopilot the key, and dl's plan as its provider only when it has none", () => {
    assert.deepEqual(autopilotKeyEnv(KEY, undefined), { AUTOPILOT_DL_FREE_TOKEN: KEY.key, AUTOPILOT_PROVIDER: "directionally-local" });
    assert.deepEqual(autopilotKeyEnv(KEY, "openrouter"), { AUTOPILOT_DL_FREE_TOKEN: KEY.key });
  });
  it("per-agent steps match each tool's current setup", () => {
    const steps = (id: string) => setupSteps(AGENT_CATALOG.find((spec) => spec.id === id)!, KEY).join("\n");
    // Codex CLI dropped wire_api = "chat"; dl serves Chat Completions only, so no config to paste.
    assert.match(steps("codex"), /Responses API/);
    assert.doesNotMatch(steps("codex"), /wire_api = "chat"\n|\[model_providers/);
    // Crush's config is crushrc now, with the completions provider type.
    assert.match(steps("crush"), /provider add dl --type completions --base-url https:\/\/api\.dl\.new\/v1/);
    // Continue's config.yaml needs name, version and schema.
    assert.match(steps("continue"), /schema: v1/);
    assert.match(steps("goose"), /Add A Custom Provider → OpenAI Compatible/);
    assert.match(steps("kilo"), /Custom provider/);
    // Amp and Warp take a custom OpenAI-style endpoint now.
    for (const id of ["amp", "warp"]) {
      assert.notEqual(AGENT_CATALOG.find((spec) => spec.id === id)!.noCustomModels, true, id);
      assert.match(steps(id), /https:\/\/api\.dl\.new\/v1/, id);
    }
  });
});
