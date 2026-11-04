import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { autopilotSetUp, parseAuthStatus } from "./autopilot.js";
import { laptopReady, NOT_SIGNED_IN, type LaptopIO } from "./commands.js";

/** `autopilot auth status` as Autopilot 3.5 prints it (a few of its rows). */
const status = (rows: Array<[id: string, name: string, key: string, active?: boolean]>) =>
  rows.map(([id, name, key, active]) => `${active ? "›" : " "} ${id.padEnd(11)} ${name}${active ? " (active)" : ""} · ${key}`).join("\n") + "\n";

describe("whether Autopilot is set up (dl status)", () => {
  it("reads autopilot auth status: the active provider's key, or one in the environment", () => {
    const fresh = status([["directionally-local", "Directionally Local", "no key"], ["openrouter", "OpenRouter", "no key", true], ["anthropic", "Anthropic", "no key"], ["ollama", "Ollama", "no key needed"]]);
    assert.equal(parseAuthStatus(fresh), false, "nothing chosen yet: first run would ask");
    assert.equal(parseAuthStatus(status([["directionally-local", "Directionally Local", "key in config", true], ["openrouter", "OpenRouter", "no key"]])), true, "signed in to the free tier");
    assert.equal(parseAuthStatus(status([["openrouter", "OpenRouter", "key in env", true]])), true);
    assert.equal(parseAuthStatus(status([["openrouter", "OpenRouter", "no key", true], ["anthropic", "Anthropic", "key in env"]])), true, "first run uses a key in the environment without asking");
    assert.equal(parseAuthStatus(status([["ollama", "Ollama", "no key needed", true]])), true);
    assert.equal(parseAuthStatus("Usage: autopilot [options]\n"), undefined, "an answer it doesn't know: say nothing");
    assert.equal(parseAuthStatus(""), undefined);
  });

  it("asks Autopilot's read-only auth status, and says nothing when it can't tell", async () => {
    const calls: string[][] = [];
    const notSetUp = status([["openrouter", "OpenRouter", "no key", true]]);
    assert.equal(await autopilotSetUp({ command: "/node", args: ["/autopilot.mjs"] }, async (command, args) => (calls.push([command, ...args]), notSetUp)), false);
    assert.deepEqual(calls, [["/node", "/autopilot.mjs", "auth", "status"]]);
    assert.equal(await autopilotSetUp(undefined, async () => notSetUp), undefined, "no Autopilot");
    assert.equal(await autopilotSetUp({ command: "autopilot", args: [] }, async () => { throw new Error("timed out"); }), undefined);
  });

  it("dl status adds one line when Autopilot isn't signed in yet, and only then", () => {
    const shown = (setUp: boolean | undefined) => {
      let out = "";
      const io: LaptopIO = { out: (text) => { out += text; }, err: () => {} };
      laptopReady({ dl: "0.11.0", autopilot: "3.5.0", bundled: true, installedIn: "~/.directionallylocal", ...(setUp === undefined ? {} : { setUp }) }, io);
      return out;
    };
    assert.equal(NOT_SIGNED_IN, "Not signed in yet: run dl in a project folder and choose Free, or use your own API key.");
    assert.match(shown(false), /\n {2}Autopilot {2}3\.5\.0 · comes with dl\n {2}! Not signed in yet: run dl in a project folder and choose Free, or use your own API key\.\n\n {2}Start, in a project folder:/);
    assert.doesNotMatch(shown(true), /Not signed in/);
    assert.doesNotMatch(shown(undefined), /Not signed in/);
  });
});
