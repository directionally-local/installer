import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AGENT_CATALOG, detectAgents, findSpec } from "./agent-catalog.js";

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

  it("knows agents by id, name or CLI name", () => {
    assert.equal(findSpec("claude")?.id, "claude-code");
    assert.equal(findSpec("Claude Code")?.id, "claude-code");
    assert.equal(findSpec("cursor-agent")?.id, "cursor");
    assert.equal(findSpec("Roo Code")?.id, "roo");
    assert.equal(findSpec("my own agent"), undefined);
    assert.equal(findSpec("  "), undefined);
  });
});
