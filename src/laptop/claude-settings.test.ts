import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claudeSettingsFiles, claudeSettingsKeys, claudeSettingsRefusal } from "./claude-settings.js";

/** A fake file system: path → text; anything else is missing. */
function files(map: Record<string, string>) {
  const reads: string[] = [];
  return {
    reads,
    readFile: async (path: string) => {
      reads.push(path);
      if (!(path in map)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return map[path]!;
    },
  };
}

const env = { HOME: "/home/alice" };

describe("Claude Code settings credentials", () => {
  it("reads the user file, CLAUDE_CONFIG_DIR's when set, and the project's two files", () => {
    assert.deepEqual(claudeSettingsFiles(env, "/work/repo"), ["/home/alice/.claude/settings.json", "/work/repo/.claude/settings.json", "/work/repo/.claude/settings.local.json"]);
    assert.deepEqual(claudeSettingsFiles({ ...env, CLAUDE_CONFIG_DIR: "/cfg/claude" }, "/work/repo"), [
      "/home/alice/.claude/settings.json",
      "/cfg/claude/settings.json",
      "/work/repo/.claude/settings.json",
      "/work/repo/.claude/settings.local.json",
    ]);
    // Run from home: the project file is the user file, read once.
    assert.deepEqual(claudeSettingsFiles(env, "/home/alice"), ["/home/alice/.claude/settings.json", "/home/alice/.claude/settings.local.json"]);
  });

  it("finds env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN, env.CLAUDE_CODE_OAUTH_TOKEN and apiKeyHelper, in each file", async () => {
    const fs = files({
      "/home/alice/.claude/settings.json": JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-ant-1", OTHER: "x" }, apiKeyHelper: "~/bin/key.sh" }),
      "/cfg/settings.json": JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: "oat" } }),
      "/work/repo/.claude/settings.json": JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "t" } }),
      "/work/repo/.claude/settings.local.json": JSON.stringify({ apiKeyHelper: "helper" }),
    });
    const found = await claudeSettingsKeys({ env: { ...env, CLAUDE_CONFIG_DIR: "/cfg" }, cwd: "/work/repo", readFile: fs.readFile });
    assert.deepEqual(found, [
      { file: "~/.claude/settings.json", setting: "env.ANTHROPIC_API_KEY" },
      { file: "~/.claude/settings.json", setting: "apiKeyHelper" },
      { file: "/cfg/settings.json", setting: "env.CLAUDE_CODE_OAUTH_TOKEN" },
      { file: "/work/repo/.claude/settings.json", setting: "env.ANTHROPIC_AUTH_TOKEN" },
      { file: "/work/repo/.claude/settings.local.json", setting: "apiKeyHelper" },
    ]);
  });

  it("ignores missing, invalid or odd files and empty values", async () => {
    const fs = files({
      "/home/alice/.claude/settings.json": "{ not json",
      "/work/repo/.claude/settings.json": JSON.stringify([1, 2]),
      "/work/repo/.claude/settings.local.json": JSON.stringify({ env: { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: null }, apiKeyHelper: "  " }),
    });
    assert.deepEqual(await claudeSettingsKeys({ env, cwd: "/work/repo", readFile: fs.readFile }), []);
    assert.deepEqual(await claudeSettingsKeys({ env, cwd: "/nowhere", readFile: files({}).readFile }), []);
  });

  it("refuses with the file and setting, never the value; the override skips the check", async () => {
    const fs = files({ "/home/alice/.claude/settings.json": JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-ant-very-secret" } }) });
    const message = await claudeSettingsRefusal("dl claude", "dl's free tier", { env, cwd: "/work/repo", readFile: fs.readFile });
    assert.match(message!, /^dl claude won't start Claude Code/);
    assert.match(message!, /~\/\.claude\/settings\.json: env\.ANTHROPIC_API_KEY/);
    assert.match(message!, /dl's free tier/);
    assert.match(message!, /DL_ALLOW_CLAUDE_SETTINGS_KEY=1/);
    assert.doesNotMatch(message!, /sk-ant-very-secret/);
    assert.equal(await claudeSettingsRefusal("dl claude", "dl's free tier", { env, cwd: "/work/repo", readFile: files({}).readFile }), undefined);
    const skipped = files({ "/home/alice/.claude/settings.json": JSON.stringify({ apiKeyHelper: "x" }) });
    assert.equal(await claudeSettingsRefusal("dl claude", "dl's free tier", { env: { ...env, DL_ALLOW_CLAUDE_SETTINGS_KEY: "1" }, cwd: "/w", readFile: skipped.readFile }), undefined);
    assert.equal(skipped.reads.length, 0, "with the override nothing is read");
    assert.notEqual(await claudeSettingsRefusal("dl claude", "dl's free tier", { env: { ...env, DL_ALLOW_CLAUDE_SETTINGS_KEY: "0" }, cwd: "/w", readFile: skipped.readFile }), undefined);
  });
});
