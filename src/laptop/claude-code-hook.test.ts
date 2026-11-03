import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HOOK_COMMAND,
  LIMIT_LINE,
  UNKNOWN_FORMAT_LINE,
  claudeCodeCommand,
  claudeSettingsPath,
  hookEntry,
  hookOutput,
  terminalSequence,
  withHook,
  withoutHook,
} from "./claude-code-hook.js";

let root: string;
let claudeDir: string;
let file: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dl-cc-hook-"));
  claudeDir = join(root, ".claude");
  await mkdir(claudeDir);
  file = join(claudeDir, "settings.json");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function capture() {
  let out = "";
  let err = "";
  return { io: { out: (t: string) => { out += t; }, err: (t: string) => { err += t; } }, out: () => out, err: () => err };
}

/** A settings file someone already uses: other keys, other hooks, another StopFailure hook. */
const EXISTING = {
  model: "opus",
  permissions: { allow: ["Bash(npm test:*)"] },
  hooks: {
    PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "prettier --write" }] }],
    StopFailure: [{ matcher: "overloaded", hooks: [{ type: "command", command: "say overloaded" }] }],
  },
};

const NOW = () => new Date("2026-11-03T10:15:00.000Z");

describe("dl claude-code hook: merging", () => {
  it("adds one StopFailure rate_limit entry and keeps everything else; adding twice changes nothing", () => {
    const { settings, added } = withHook(structuredClone(EXISTING));
    assert.equal(added, true);
    assert.deepEqual(settings, {
      ...EXISTING,
      hooks: { ...EXISTING.hooks, StopFailure: [...EXISTING.hooks.StopFailure, { matcher: "rate_limit", hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 10 }] }] },
    });
    assert.equal(withHook(settings).added, false);
    assert.deepEqual(withHook({}).settings, { hooks: { StopFailure: [hookEntry()] } });
  });

  it("removes only dl's hook, and the empty groups and keys it leaves", () => {
    const { settings } = withHook(structuredClone(EXISTING));
    assert.deepEqual(withoutHook(settings), { settings: EXISTING, removed: 1 });
    assert.deepEqual(withoutHook(withHook({}).settings), { settings: {}, removed: 1 });
    assert.deepEqual(withoutHook(EXISTING), { settings: EXISTING, removed: 0 });
    // Someone added their own command next to dl's in the same group: theirs stays.
    const shared = { hooks: { StopFailure: [{ matcher: "rate_limit", hooks: [{ type: "command", command: HOOK_COMMAND }, { type: "command", command: "notify-send limit" }] }] } };
    assert.deepEqual(withoutHook(shared).settings, { hooks: { StopFailure: [{ matcher: "rate_limit", hooks: [{ type: "command", command: "notify-send limit" }] }] } });
  });

  it("refuses a hooks section that isn't the documented shape", () => {
    assert.throws(() => withHook({ hooks: [] }), /isn't an object/);
    assert.throws(() => withHook({ hooks: { StopFailure: {} } }), /isn't a list/);
  });

  it("finds Claude Code's settings under CLAUDE_CONFIG_DIR, else ~/.claude", () => {
    assert.equal(claudeSettingsPath({ CLAUDE_CONFIG_DIR: "/cfg" }, "/home/ana"), "/cfg/settings.json");
    assert.equal(claudeSettingsPath({}, "/home/ana"), "/home/ana/.claude/settings.json");
  });
});

describe("dl claude-code hook install / remove", () => {
  it("shows the entry, asks, backs up, merges, and says exactly what it added; remove takes it out", async () => {
    const original = `${JSON.stringify(EXISTING, null, 4)}\n`;
    await writeFile(file, original, { mode: 0o644 });
    const asked: string[] = [];
    const install = capture();
    const code = await claudeCodeCommand(["hook", "install"], { io: install.io, file, now: NOW, confirm: async (q) => { asked.push(q); return true; } });
    assert.equal(code, 0, install.err());
    assert.deepEqual(asked, ["  Add it? [Y/n] "]);
    assert.match(install.out(), new RegExp(`this hook shows:\\n    ${LIMIT_LINE.replace(/[.]/g, "\\.")}`));
    assert.match(install.out(), /"StopFailure": \[\n\s+\{\n\s+"matcher": "rate_limit"/);
    assert.match(install.out(), /✓ Added to .*settings\.json: under hooks\.StopFailure, \{"matcher":"rate_limit","hooks":\[\{"type":"command","command":"dl claude-code hook notify","timeout":10\}\]\}/);
    assert.match(install.out(), /Backup: .*settings\.json\.dl-backup-2026-11-03T10-15-00-000Z/);
    const written = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(written, withHook(structuredClone(EXISTING)).settings);
    assert.equal(await readFile(`${file}.dl-backup-2026-11-03T10-15-00-000Z`, "utf8"), original, "the backup is the file as it was");
    assert.equal((await stat(file)).mode & 0o777, 0o644, "permissions kept");

    // Again: already there, nothing asked or written.
    const again = capture();
    assert.equal(await claudeCodeCommand(["hook", "install"], { io: again.io, file, now: NOW, confirm: async () => assert.fail("not asked") }), 0);
    assert.match(again.out(), /already in/);

    const remove = capture();
    assert.equal(await claudeCodeCommand(["hook", "remove"], { io: remove.io, file, now: () => new Date("2026-11-03T11:00:00.000Z") }), 0);
    assert.match(remove.out(), /Removed dl's hook \(hooks\.StopFailure, dl claude-code hook notify\)/);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), EXISTING);
    const removeAgain = capture();
    assert.equal(await claudeCodeCommand(["hook", "remove"], { io: removeAgain.io, file }), 0);
    assert.match(removeAgain.out(), /isn't in .*nothing to remove/);
  });

  it("changes nothing when the answer is no, without a terminal to ask on, or when the file isn't JSON", async () => {
    const original = JSON.stringify(EXISTING);
    await writeFile(file, original);
    const declined = capture();
    assert.equal(await claudeCodeCommand(["hook", "install"], { io: declined.io, file, confirm: async () => false }), 0);
    assert.match(declined.out(), /Not added; nothing was changed/);
    const unattended = capture();
    assert.equal(await claudeCodeCommand(["hook", "install"], { io: unattended.io, file }), 1);
    assert.match(unattended.err(), /asks before changing Claude Code's settings/);
    assert.equal(await readFile(file, "utf8"), original);

    await writeFile(file, "{ \"model\": \"opus\", // a comment\n}");
    const broken = capture();
    assert.equal(await claudeCodeCommand(["hook", "install"], { io: broken.io, file, confirm: async () => true }), 1);
    assert.match(broken.err(), /isn't valid JSON\. Nothing was changed/);
    assert.deepEqual((await readdir(claudeDir)).sort(), ["settings.json"], "no backup, no temporary file");
  });

  it("creates settings.json when Claude Code has none yet, and refuses when Claude Code isn't set up", async () => {
    const io = capture();
    assert.equal(await claudeCodeCommand(["hook", "install"], { io: io.io, file, confirm: async () => true }), 0);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { hooks: { StopFailure: [hookEntry()] } });
    assert.doesNotMatch(io.out(), /Backup/);
    const missing = capture();
    assert.equal(await claudeCodeCommand(["hook", "install"], { io: missing.io, file: join(root, "nowhere", "settings.json"), confirm: async () => true }), 1);
    assert.match(missing.err(), /doesn't seem to be set up/);
  });

  it("explains its usage", async () => {
    const io = capture();
    assert.equal(await claudeCodeCommand(["hook"], { io: io.io, file }), 2);
    assert.match(io.err(), /dl claude-code hook install/);
  });
});

describe("dl claude-code hook notify (what Claude Code runs)", () => {
  const payload = (fields: Record<string, unknown>) => JSON.stringify({
    session_id: "abc123", transcript_path: "/Users/ana/.claude/projects/-Users-ana-shop/abc123.jsonl", cwd: "/Users/ana/shop",
    hook_event_name: "StopFailure", error: "rate_limit", error_details: "429 Too Many Requests", last_assistant_message: "API Error: Rate limit reached",
    ...fields,
  });

  it("on a rate limit, returns the line as a notification and window title", () => {
    const out = hookOutput(payload({}), { TERM_PROGRAM: "iTerm.app" });
    assert.deepEqual(JSON.parse(out), { terminalSequence: `\x1b]9;${LIMIT_LINE}\x07\x1b]2;${LIMIT_LINE}\x07` });
  });

  it("does nothing on other stops", () => {
    assert.equal(hookOutput(payload({ error: "overloaded" })), "");
    assert.equal(hookOutput(payload({ error: "authentication_failed" })), "");
    assert.equal(hookOutput(payload({ hook_event_name: "Stop" })), "");
  });

  it("says so plainly when Claude Code's input isn't the shape it expects", () => {
    for (const input of ["", "not json", JSON.stringify({ hook_event_name: "StopFailure" }), JSON.stringify({ event: "StopFailure", type: "rate_limit" })]) {
      assert.deepEqual(JSON.parse(hookOutput(input, {})), { terminalSequence: terminalSequence(UNKNOWN_FORMAT_LINE, {}) }, input);
    }
  });

  it("speaks each terminal's notification sequence, with only allowlisted escapes", () => {
    assert.match(terminalSequence("hi", { KITTY_WINDOW_ID: "1" }), /^\x1b\]99;;hi\x1b\\/);
    assert.match(terminalSequence("hi", { TERM_PROGRAM: "ghostty" }), /^\x1b\]777;notify;Claude Code;hi\x07/);
    assert.match(terminalSequence("hi", { TERM_PROGRAM: "WezTerm" }), /^\x1b\]9;hi\x07/);
    // Control characters and separators in the text can't open another sequence.
    assert.equal(terminalSequence("a\x1b[31m;b\x07", {}), "\x1b]9;a [31m b \x07\x1b]2;a [31m b \x07");
  });

  it("reads Claude Code's input from stdin and prints the JSON", async () => {
    const io = capture();
    assert.equal(await claudeCodeCommand(["hook", "notify"], { io: io.io, stdin: Readable.from([payload({})]) }), 0);
    assert.match(JSON.parse(io.out()).terminalSequence, /Continue in dl: dl --from-claude-code/);
  });
});
