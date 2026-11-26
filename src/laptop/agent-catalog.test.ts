import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AGENT_CATALOG, detectAgents, findSpec, GOOSE_CONFIRM } from "./agent-catalog.js";

/** A fake filesystem: directory → entries; executables are the listed files under bin dirs. */
function fs(tree: Record<string, string[]>, executables: string[] = []) {
  const listed: string[] = [];
  return {
    listed,
    list: async (dir: string) => (listed.push(dir), tree[dir] ?? []),
    executable: async (path: string) => executables.includes(path) || Object.entries(tree).some(([dir, names]) => names.some((name) => `${dir}/${name}` === path)),
  };
}

describe("finding coding agents", () => {
  it("knows a long list of agents, each with a way to find it", () => {
    const ids = AGENT_CATALOG.map((spec) => spec.id);
    for (const id of ["claude-code", "opencode", "pi", "t3", "cline", "cursor", "zed", "codex", "aider", "goose", "continue", "roo", "kilo", "windsurf", "gemini", "crush", "amp", "qwen", "kiro", "warp", "openhands"]) {
      assert.ok(ids.includes(id), `${id} is in the catalog`);
    }
    assert.equal(new Set(ids).size, ids.length, "ids are unique");
    for (const spec of AGENT_CATALOG) assert.ok(spec.bins || spec.macApps || spec.desktop || spec.extensions, `${spec.id} can be found`);
  });

  it("finds CLIs on PATH and in the usual install folders, apps on macOS, and VS Code-family extensions", async () => {
    const f = fs({
      "/usr/bin": ["claude", "ls"],
      "/home/me/.local/bin": ["aider"],
      "/Applications": ["Cursor.app", "Zed Preview.app", "Safari.app"],
      "/home/me/.vscode/extensions": ["saoudrizwan.claude-dev-3.20.1", "ms-python.python-2025.1.0"],
      "/home/me/.cursor/extensions": ["RooVeterinaryInc.roo-cline-3.1.0"],
      "/home/me/.nvm/versions/node": ["v22.23.4"],
      "/home/me/.nvm/versions/node/v22.23.4/bin": ["opencode"],
    });
    const found = await detectAgents({ env: { PATH: "/usr/bin" }, platform: "darwin", home: "/home/me", list: f.list, executable: f.executable });
    assert.deepEqual(found.map((agent) => [agent.id, agent.how.join(" · ")]), [
      ["claude-code", "claude"],
      ["opencode", "opencode"],
      ["cursor", "app"],
      ["cline", "VS Code extension"],
      ["zed", "app"],
      ["aider", "aider"],
      ["roo", "Cursor extension"],
    ]);
    assert.equal(found[0]!.dl, "claude", "a CLI dl starts itself");
    assert.equal(found[0]!.path, "/usr/bin/claude");
    assert.equal(found.find((agent) => agent.id === "cursor")!.dl, undefined, "set up by hand");
  });

  it("finds Linux apps from .desktop entries (Flatpak and Snap too), not macOS bundles", async () => {
    const f = fs({
      "/usr/share/applications": ["cursor.desktop", "firefox.desktop"],
      "/var/lib/flatpak/exports/share/applications": ["dev.zed.Zed.desktop"],
      "/var/lib/snapd/desktop/applications": ["windsurf_windsurf.desktop"],
      "/Applications": ["Kiro.app"],
    });
    const found = await detectAgents({ env: { PATH: "" }, platform: "linux", home: "/home/me", list: f.list, executable: f.executable });
    assert.deepEqual(found.map((agent) => agent.id), ["cursor", "zed", "windsurf"]);
    assert.equal(found.find((agent) => agent.id === "windsurf")!.noCustomModels, true);
  });

  it("finds nothing on an empty computer, and a file that isn't executable isn't a CLI", async () => {
    const f = fs({ "/usr/bin": ["claude"] });
    assert.deepEqual(await detectAgents({ env: { PATH: "/usr/bin" }, platform: "linux", home: "/h", list: f.list, executable: async () => false }), []);
    assert.deepEqual(await detectAgents({ env: { PATH: "" }, platform: "linux", home: "/h", list: async () => [], executable: async () => false }), []);
  });

  it("tells Block's Goose from the goose database migration tool", async () => {
    const f = fs({ "/usr/bin": ["goose"] });
    const detect = (deps: { isDir?: (path: string) => Promise<boolean>; version?: (path: string) => Promise<string | undefined> }) =>
      detectAgents({ env: { PATH: "/usr/bin" }, platform: "linux", home: "/home/me", list: f.list, executable: f.executable, isDir: async () => false, ...deps }).then((found) => found.map((agent) => agent.id));
    const ran: string[] = [];
    // pressly/goose (go install, Homebrew): not a coding agent.
    assert.deepEqual(await detect({ version: async (path) => (ran.push(path), "goose version: v3.26.0\n") }), []);
    assert.deepEqual(ran, ["/usr/bin/goose"], "asked the CLI itself, once");
    assert.deepEqual(await detect({ version: async () => "goose version:v3.30.2\n" }), []);
    assert.deepEqual(await detect({ version: async () => "Usage: goose DRIVER DBSTRING [OPTIONS] COMMAND\n" }), []);
    assert.deepEqual(await detect({ version: async () => undefined }), [], "a CLI that doesn't answer isn't counted");
    // Block's Goose: its bare version, with or without a name in front.
    assert.deepEqual(await detect({ version: async () => " 1.15.0\n" }), ["goose"]);
    assert.deepEqual(await detect({ version: async () => "goose 1.9.3\n" }), ["goose"]);
    // Its config folder says so without running anything.
    const runs: string[] = [];
    assert.deepEqual(await detect({ isDir: async (path) => path === "/home/me/.config/goose", version: async (path) => (runs.push(path), "goose version: v3.26.0") }), ["goose"]);
    assert.deepEqual(runs, [], "nothing ran");
    // The desktop app counts on its own; a migration tool's goose next to it doesn't add a CLI.
    const app = fs({ "/usr/bin": ["goose"], "/usr/share/applications": ["goose.desktop"] });
    const found = await detectAgents({ env: { PATH: "/usr/bin" }, platform: "linux", home: "/home/me", list: app.list, executable: app.executable, isDir: async () => false, version: async () => "goose version: v3.26.0" });
    assert.deepEqual(found.map((agent) => [agent.id, agent.how.join(" · "), agent.path]), [["goose", "app", undefined]]);
    assert.equal(GOOSE_CONFIRM.version(""), false);
  });

  it("runs nothing for agents whose CLI name is their own", async () => {
    const f = fs({ "/usr/bin": ["claude", "aider", "opencode"] });
    const found = await detectAgents({ env: { PATH: "/usr/bin" }, platform: "linux", home: "/h", list: f.list, executable: f.executable, version: async () => assert.fail("ran a CLI") });
    assert.deepEqual(found.map((agent) => agent.id), ["claude-code", "opencode", "aider"]);
  });

  it("knows agents by id, name or CLI name", () => {
    assert.equal(findSpec("claude")?.id, "claude-code");
    assert.equal(findSpec("Claude Code")?.id, "claude-code");
    assert.equal(findSpec("cursor-agent")?.id, "cursor");
    assert.equal(findSpec("Roo Code")?.id, "roo");
    assert.equal(findSpec("my own agent"), undefined);
    assert.equal(findSpec("  "), undefined);
  });
});
