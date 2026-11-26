import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acpCommand, supportsAcp, zedAgentEntry, zedCommand, zedSettingsPath, ZED_AGENT_NAME, type ZedDeps } from "./zed.js";
import { parseJsonc } from "./jsonc.js";

const autopilot = { command: "/usr/bin/node", args: ["/opt/dl/node_modules/autopilot-ai/bin/autopilot.mjs"] };

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) }, out, err };
}

describe("dl acp", () => {
  it("runs the bundled Autopilot's acp with the arguments, as dl starts it, and returns its exit code", async () => {
    const calls: Array<{ command: string; args: string[]; env: Record<string, string | undefined> }> = [];
    const t = io();
    const code = await acpCommand(["--login"], t.io, {
      autopilot: async () => autopilot,
      supportsAcp: async () => true,
      run: async (command, args, env) => (calls.push({ command, args, env }), 3),
      env: { PATH: "/usr/bin", HOME: "/nonexistent-home" },
    });
    assert.equal(code, 3);
    assert.deepEqual(calls[0]!.args, [...autopilot.args, "acp", "--login"]);
    assert.equal(calls[0]!.env.AUTOPILOT_LAUNCHED_BY, "dl");
    assert.equal(calls[0]!.env.DL_UPDATE_COMMAND, "dl update");
    assert.deepEqual(t.out, [], "nothing on stdout: it belongs to the protocol");
  });

  it("refuses an Autopilot without acp (it would take \"acp\" as a task)", async () => {
    const t = io();
    let ran = false;
    assert.equal(await acpCommand([], t.io, { autopilot: async () => autopilot, supportsAcp: async () => false, run: async () => ((ran = true), 0) }), 1);
    assert.equal(ran, false);
    assert.match(t.err.join(""), /too old/);
  });

  it("tells an Autopilot with acp from an older one by its help", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dl-acp-probe-"));
    try {
      const fake = async (help: string) => {
        const script = join(dir, `${help.length}.mjs`);
        await writeFile(script, `process.stdout.write(${JSON.stringify(help)});`);
        return { command: process.execPath, args: [script] };
      };
      assert.equal(await supportsAcp(await fake("Usage: autopilot acp [options]\n  --login  sign in")), true);
      assert.equal(await supportsAcp(await fake("Usage: autopilot [options] [command] [task...]")), false);
      assert.equal(await supportsAcp({ command: join(dir, "missing"), args: [] }), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("says so (on stderr) when the bundled Autopilot is missing", async () => {
    const t = io();
    assert.equal(await acpCommand([], t.io, { autopilot: async () => undefined }), 1);
    assert.match(t.err.join(""), /dl update/);
  });
});

describe("zedSettingsPath", () => {
  it("is ~/.config/zed on macOS, XDG on Linux, %APPDATA%\\Zed on Windows", () => {
    assert.equal(zedSettingsPath({}, "darwin", "/Users/a"), "/Users/a/.config/zed/settings.json");
    assert.equal(zedSettingsPath({ XDG_CONFIG_HOME: "/x" }, "darwin", "/Users/a"), "/Users/a/.config/zed/settings.json");
    assert.equal(zedSettingsPath({}, "linux", "/home/a"), "/home/a/.config/zed/settings.json");
    assert.equal(zedSettingsPath({ XDG_CONFIG_HOME: "/x" }, "linux", "/home/a"), "/x/zed/settings.json");
    assert.equal(zedSettingsPath({ APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "win32", "C:\\Users\\a"), join("C:\\Users\\a\\AppData\\Roaming", "Zed", "settings.json"));
  });
});

describe("dl zed", () => {
  let dir: string;
  let settings: string;
  const now = () => new Date("2026-11-25T03:00:00Z");
  const base = (): ZedDeps => ({
    settingsPath: settings,
    node: "/usr/bin/node",
    dlScript: "/opt/dl/bin/directionallylocal.mjs",
    autopilot: async () => autopilot,
    supportsAcp: async () => true,
    auth: async () => ({ active: "directionally-local", setUp: true }),
    signIn: async () => {
      throw new Error("not expected");
    },
    interactive: true,
    now,
  });
  const entry = zedAgentEntry("/usr/bin/node", "/opt/dl/bin/directionallylocal.mjs");

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "dl-zed-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates the settings file when Zed has none yet", async () => {
    settings = join(dir, "fresh", "zed", "settings.json");
    const t = io();
    assert.equal(await zedCommand([], t.io, base()), 0);
    const parsed = parseJsonc(await readFile(settings, "utf8")) as Record<string, Record<string, unknown>>;
    assert.deepEqual(parsed.agent_servers![ZED_AGENT_NAME], entry);
    assert.match(t.out.join(""), /Added Autopilot by dl.new/);
    assert.equal((await readdir(join(dir, "fresh", "zed"))).length, 1, "no backup of a file that didn't exist");
  });

  it("adds the entry to existing settings after a backup, changing nothing else", async () => {
    await mkdir(join(dir, "existing"), { recursive: true });
    settings = join(dir, "existing", "settings.json");
    const original = `// my settings\n{\n  "vim_mode": true, // yes\n  "agent_servers": { "Other": { "type": "custom", "command": "other" } },\n}\n`;
    await writeFile(settings, original);
    const t = io();
    assert.equal(await zedCommand([], t.io, base()), 0);
    const text = await readFile(settings, "utf8");
    assert.ok(text.includes(`"vim_mode": true, // yes`));
    const parsed = parseJsonc(text) as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(parsed.agent_servers!).sort(), [ZED_AGENT_NAME, "Other"].sort());
    const backup = `${settings}.dl-backup-2026-11-25T03-00-00-000Z`;
    assert.equal(await readFile(backup, "utf8"), original);
    assert.match(t.out.join(""), /Backup: /);

    // Again: already there, nothing written.
    const again = io();
    assert.equal(await zedCommand([], again.io, base()), 0);
    assert.match(again.out.join(""), /already in Zed's agents/);
    assert.equal(await readFile(settings, "utf8"), text);

    // remove: back to the original settings.
    const removed = io();
    assert.equal(await zedCommand(["remove"], removed.io, { ...base(), now: () => new Date("2026-11-25T03:00:01Z") }), 0);
    assert.deepEqual(parseJsonc(await readFile(settings, "utf8")), parseJsonc(original));
  });

  it("writes through a symlinked settings.json instead of replacing the link", async () => {
    const real = join(dir, "dotfiles-settings.json");
    await writeFile(real, "{}\n");
    await mkdir(join(dir, "linked"), { recursive: true });
    settings = join(dir, "linked", "settings.json");
    await symlink(real, settings);
    assert.equal(await zedCommand([], io().io, base()), 0);
    assert.ok((await lstat(settings)).isSymbolicLink());
    assert.ok(((parseJsonc(await readFile(real, "utf8")) as Record<string, Record<string, unknown>>).agent_servers![ZED_AGENT_NAME]));
  });

  it("leaves a settings file it can't read untouched", async () => {
    settings = join(dir, "broken.json");
    await writeFile(settings, `{ "theme": `);
    const t = io();
    assert.equal(await zedCommand([], t.io, base()), 1);
    assert.equal(await readFile(settings, "utf8"), `{ "theme": `);
    assert.match(t.err.join(""), /wasn't changed/);
  });

  it("signs in to the free tier first when Autopilot has no provider", async () => {
    settings = join(dir, "signin", "settings.json");
    let signedIn = 0;
    const t = io();
    const code = await zedCommand([], t.io, { ...base(), auth: async () => ({ active: "openrouter", setUp: false }), signIn: async () => (signedIn++, 0) });
    assert.equal(code, 0);
    assert.equal(signedIn, 1);

    // A failed sign-in leaves Zed's settings alone.
    settings = join(dir, "signin-failed", "settings.json");
    const failed = io();
    assert.equal(await zedCommand([], failed.io, { ...base(), auth: async () => ({ active: "openrouter", setUp: false }), signIn: async () => 1 }), 1);
    await assert.rejects(readFile(settings, "utf8"));
  });

  it("--print shows the entry without writing anything", async () => {
    settings = join(dir, "print", "settings.json");
    const t = io();
    assert.equal(await zedCommand(["--print"], t.io, base()), 0);
    assert.deepEqual(JSON.parse(t.out.join("")), { agent_servers: { [ZED_AGENT_NAME]: entry } });
    await assert.rejects(readFile(settings, "utf8"));
  });
});

describe("dl acp / dl zed routing", () => {
  it("passes every argument through, and gives dl acp no stdout of its own", async () => {
    const { main } = await import("../cli.js");
    const seen: Array<{ name: string; args: string[]; outIsErr: boolean }> = [];
    const t = io();
    const fake = (name: string) => async (args: string[], sink: { out: (s: string) => void; err: (s: string) => void }) => {
      sink.out("x");
      seen.push({ name, args, outIsErr: t.err.includes("x") });
      return 0;
    };
    assert.equal(await main(["acp", "--login"], t.io, { acp: fake("acp") }), 0);
    assert.equal(await main(["zed", "remove"], t.io, { zed: fake("zed") }), 0);
    assert.deepEqual(seen.map((s) => [s.name, s.args]), [["acp", ["--login"]], ["zed", ["remove"]]]);
    assert.equal(seen[0]!.outIsErr, true, "dl acp's messages go to stderr");
    assert.deepEqual(t.out, ["x"], "only dl zed wrote to stdout");
  });
});
