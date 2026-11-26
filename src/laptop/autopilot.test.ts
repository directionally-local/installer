import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { autopilotSetUp, findAutopilot, installedAutopilotVersion, ownAutopilot, parseAuthStatus } from "./autopilot.js";
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
    assert.equal(NOT_SIGNED_IN, "Autopilot has no provider yet: run dl autopilot in a project folder and choose one.");
    assert.match(shown(false), /\n {2}Autopilot {2}3\.5\.0 · installed by dl\n {2}! Autopilot has no provider yet: run dl autopilot in a project folder and choose one\.\n\n {2}Start, in a project folder:/);
    assert.doesNotMatch(shown(true), /no provider yet/);
    assert.doesNotMatch(shown(undefined), /no provider yet/);
  });
});

describe("which Autopilot dl runs as its own", () => {
  /** An autopilot-ai package at `dir` with this version; returns its bin script. */
  const pkg = (dir: string, version: string) => {
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "autopilot-ai", version, bin: { autopilot: "bin/autopilot.mjs" }, main: "bin/autopilot.mjs" }));
    writeFileSync(join(dir, "bin", "autopilot.mjs"), "");
    return join(dir, "bin", "autopilot.mjs");
  };
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "dl-own-autopilot-"));
    const env = { DL_HOME: join(root, "home"), PATH: "" };
    const downloadedDir = join(root, "home", "autopilot", "lib", "node_modules", "autopilot-ai");
    const globalDir = join(root, "usr", "lib", "node_modules", "autopilot-ai");
    // What import.meta.resolve gives a global dl when a global autopilot-ai sits beside it.
    const resolveGlobal = (specifier: string) => {
      if (specifier === "autopilot-ai") return pathToFileURL(join(globalDir, "bin", "autopilot.mjs")).href;
      throw new Error("not exported");
    };
    return { root, env, downloadedDir, globalDir, resolveGlobal, done: () => rmSync(root, { recursive: true, force: true }) };
  };
  const noResolve = () => { throw new Error("not found"); };

  it("runs dl's downloaded copy at the pin over a separately installed global autopilot-ai", () => {
    const t = setup();
    try {
      const global = pkg(t.globalDir, "3.32.0");
      const downloaded = pkg(t.downloadedDir, "3.33.0");
      assert.deepEqual(ownAutopilot({ env: t.env, pin: "3.33.0", resolve: t.resolveGlobal }), { bin: downloaded, version: "3.33.0" });
      // Before dl update downloads the pin, the old downloaded copy still outranks the global one.
      pkg(t.downloadedDir, "3.31.0");
      assert.deepEqual(ownAutopilot({ env: t.env, pin: "3.33.0", resolve: t.resolveGlobal }), { bin: downloaded, version: "3.31.0" });
      // A resolved copy at the pin (a development checkout) wins over a stale download.
      pkg(t.globalDir, "3.33.0");
      assert.deepEqual(ownAutopilot({ env: t.env, pin: "3.33.0", resolve: t.resolveGlobal }), { bin: global, version: "3.33.0" });
    } finally {
      t.done();
    }
  });

  it("falls back to a resolved autopilot-ai at another version only when dl downloaded none", () => {
    const t = setup();
    try {
      const global = pkg(t.globalDir, "3.32.0");
      assert.deepEqual(ownAutopilot({ env: t.env, pin: "3.33.0", resolve: t.resolveGlobal }), { bin: global, version: "3.32.0" });
      assert.equal(ownAutopilot({ env: t.env, pin: "3.33.0", resolve: noResolve }), undefined);
    } finally {
      t.done();
    }
  });

  it("findAutopilot and the installed version use the downloaded copy when nothing at the pin resolves", async () => {
    const t = setup();
    try {
      const downloaded = pkg(t.downloadedDir, "0.0.1");
      // Whatever this checkout's node_modules holds, a 0.0.1 download is what's reported only
      // when nothing resolves; with a resolvable copy at the pin, that one is.
      const own = ownAutopilot({ env: t.env, pin: "0.0.1", resolve: noResolve });
      assert.deepEqual(own, { bin: downloaded, version: "0.0.1" });
      const found = await findAutopilot(t.env);
      assert.ok(found && found.args.length === 1);
      assert.ok(installedAutopilotVersion(t.env));
    } finally {
      t.done();
    }
  });
});
