import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { main } from "../cli.js";
import type { InstallState } from "../state.js";
import { hookEntry } from "./claude-code-hook.js";
import { laptopUninstall, laptopUninstallPlan, RC_MARKER, withoutRcLines, type LaptopUninstallOptions } from "./uninstall.js";

let home: string;
let dlHome: string;

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** A home directory as the install script, dl and Autopilot leave it, plus things that aren't dl's. */
function installed() {
  dlHome = join(home, ".directionallylocal");
  write(join(dlHome, "bin", "dl"), "#!/bin/sh\n# Written by the Directionally Local install script.\nexec node dl.mjs \"$@\"\n");
  write(join(dlHome, "bin", "directionallylocal"), "#!/bin/sh\n# Written by the Directionally Local install script.\n");
  write(join(dlHome, "dl", "lib", "node_modules", "directionallylocal", "package.json"), "{}");
  write(join(dlHome, "node", "bin", "node"), "");
  // Links: ours in ~/.local/bin; someone else's directionallylocal; a real file in ~/bin.
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  symlinkSync(join(dlHome, "bin", "dl"), join(home, ".local", "bin", "dl"));
  symlinkSync("/usr/local/bin/something-else", join(home, ".local", "bin", "directionallylocal"));
  write(join(home, "bin", "dl"), "#!/bin/sh\necho my own dl\n");
  symlinkSync(join(dlHome, "bin", "directionallylocal"), join(home, "bin", "directionallylocal"));
  // Startup files: the script's block in .zshrc; a look-alike the person wrote in .bashrc; the fish file.
  write(join(home, ".zshrc"), `alias ll='ls -l'\n\n${RC_MARKER}\nexport PATH="${dlHome}/bin:$PATH"\nexport EDITOR=vim\n`);
  write(join(home, ".bashrc"), `# my path\nexport PATH="${dlHome}/bin:$PATH"\n`);
  write(join(home, ".config", "fish", "conf.d", "directionallylocal.fish"), `\n${RC_MARKER}\nset -gx PATH "${dlHome}/bin" $PATH\n`);
  write(join(home, ".config", "directionallylocal", "config.json"), "{}");
  write(join(home, ".config", "autopilot", "config.json"), JSON.stringify({
    provider: "directionally-local",
    providers: { "directionally-local": { apiKey: "access-1", refreshToken: "refresh-1", expiresAt: 1, model: "m" }, openrouter: { apiKey: "or-key" } },
  }));
  write(join(home, ".local", "share", "autopilot", "sessions", "a.json"), "{}");
  write(join(home, ".local", "state", "autopilot", "runs.db"), "");
  write(join(home, "project", ".autopilot", "memory.db"), "keep");
  write(join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark", hooks: { StopFailure: [hookEntry()] } }));
}

function capture() {
  let out = "";
  let err = "";
  return { io: { out: (t: string) => { out += t; }, err: (t: string) => { err += t; } }, out: () => out, err: () => err };
}

function fakeFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ revoked: true, sessions: 1 }), { status: 200 });
  };
  return { calls, fetch };
}

function options(extra: Partial<LaptopUninstallOptions> & { io: LaptopUninstallOptions["io"] }): LaptopUninstallOptions {
  return {
    env: { HOME: home },
    home,
    platform: "linux",
    packageRoot: join(dlHome, "dl", "lib", "node_modules", "directionallylocal"),
    installedWithNpm: false,
    now: () => new Date("2026-11-05T00:00:00Z"),
    ...extra,
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "dl-uninstall-"));
  installed();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("withoutRcLines", () => {
  it("takes out the marker, the PATH line after it and the blank line before, nothing else", () => {
    const bin = "/h/.directionallylocal";
    assert.equal(withoutRcLines(`a\n\n${RC_MARKER}\nexport PATH="${bin}/bin:$PATH"\nb\n`, bin), "a\nb\n");
    assert.equal(withoutRcLines(`${RC_MARKER}\nset -gx PATH "${bin}/bin" $PATH\n`, bin), "");
    assert.equal(withoutRcLines(`export PATH="${bin}/bin:$PATH"\n`, bin), undefined, "a line the person wrote stays");
    assert.equal(withoutRcLines(`${RC_MARKER}\nexport PATH="/elsewhere/bin:$PATH"\n`, bin), undefined, "another DL_HOME's lines stay");
  });
});

describe("dl uninstall on a laptop", () => {
  it("removes exactly what dl put there, signs out of the free tier, and keeps the rest", async () => {
    const { calls, fetch } = fakeFetch();
    const io = capture();
    assert.equal(await laptopUninstall(options({ io: io.io, yes: true, fetch })), 0, io.err());

    assert.ok(!existsSync(dlHome), "DL_HOME is gone");
    assert.ok(!existsSync(join(home, ".config", "directionallylocal")));
    // Links: only the ones into DL_HOME.
    assert.ok(!existsSync(join(home, ".local", "bin", "dl")) && !lstatExists(join(home, ".local", "bin", "dl")));
    assert.equal(readlinkSync(join(home, ".local", "bin", "directionallylocal")), "/usr/local/bin/something-else");
    assert.equal(readFileSync(join(home, "bin", "dl"), "utf8"), "#!/bin/sh\necho my own dl\n");
    assert.ok(!lstatExists(join(home, "bin", "directionallylocal")));
    // Startup files.
    assert.equal(readFileSync(join(home, ".zshrc"), "utf8"), "alias ll='ls -l'\nexport EDITOR=vim\n");
    assert.match(readFileSync(join(home, ".zshrc.dl-uninstall.bak"), "utf8"), /Directionally Local \(dl\)/);
    assert.equal(readFileSync(join(home, ".bashrc"), "utf8"), `# my path\nexport PATH="${dlHome}/bin:$PATH"\n`);
    assert.ok(!existsSync(join(home, ".bashrc.dl-uninstall.bak")));
    assert.ok(!existsSync(join(home, ".config", "fish", "conf.d", "directionallylocal.fish")), "the fish file was only ours");
    // Claude Code's hook out, its other settings kept.
    assert.deepEqual(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")), { theme: "dark" });
    // Free tier: revoked like Autopilot's /logout, and the dead tokens dropped; the rest of Autopilot stays.
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://free.directionallylocal.com/v1/token/revoke");
    assert.equal(calls[0]!.init.method, "POST");
    assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer access-1");
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { refresh_token: "refresh-1" });
    const config = JSON.parse(readFileSync(join(home, ".config", "autopilot", "config.json"), "utf8"));
    assert.deepEqual(config.providers, { "directionally-local": { model: "m" }, openrouter: { apiKey: "or-key" } });
    assert.ok(existsSync(join(home, ".local", "share", "autopilot", "sessions", "a.json")));
    assert.ok(existsSync(join(home, ".local", "state", "autopilot")));
    assert.ok(existsSync(join(home, "project", ".autopilot", "memory.db")));

    assert.match(io.out(), /✓ signed out of the free tier/);
    assert.match(io.out(), /✓ removed the dl PATH lines from ~\/\.zshrc \(backup ~\/\.zshrc\.dl-uninstall\.bak\)/);
    assert.match(io.out(), /✓ removed ~\/\.local\/bin\/dl\n/);
    assert.match(io.out(), /✓ removed ~\/\.directionallylocal \(dl, its Node\.js and Autopilot\)/);
    assert.doesNotMatch(io.out(), /\.local\/bin\/directionallylocal|~\/bin\/dl\n/);
  });

  it("--purge also removes Autopilot's settings, sign-ins and history, never a project's .autopilot", async () => {
    const io = capture();
    assert.equal(await laptopUninstall(options({ io: io.io, yes: true, purge: true, fetch: fakeFetch().fetch })), 0, io.err());
    for (const dir of [join(home, ".config", "autopilot"), join(home, ".local", "share", "autopilot"), join(home, ".local", "state", "autopilot")]) {
      assert.ok(!existsSync(dir), dir);
    }
    assert.ok(existsSync(join(home, "project", ".autopilot", "memory.db")));
    assert.ok(existsSync(join(home, ".local", "share")), "only Autopilot's folder in it");
  });

  it("asks first, and without a terminal or --yes removes nothing", async () => {
    const refused = capture();
    assert.equal(await laptopUninstall(options({ io: refused.io, fetch: async () => { throw new Error("no network call before yes"); } })), 1);
    assert.match(refused.err(), /Nothing was removed: dl uninstall asks first, and there's no terminal to ask on\. To go ahead: dl uninstall --yes/);
    assert.ok(existsSync(dlHome) && existsSync(join(home, ".config", "directionallylocal")));
    assert.match(readFileSync(join(home, ".zshrc"), "utf8"), /Directionally Local/);

    const questions: string[] = [];
    const declined = capture();
    assert.equal(await laptopUninstall(options({ io: declined.io, confirm: async (q) => { questions.push(q); return false; } })), 1);
    assert.deepEqual(questions, ["Remove dl from this computer? [y/N] "]);
    assert.ok(existsSync(dlHome));
    // What it would remove is listed before the question.
    assert.match(declined.out(), /- ~\/\.directionallylocal[\s\S]*- ~\/\.local\/bin\/dl[\s\S]*the dl PATH lines in ~\/\.zshrc/);

    const accepted = capture();
    assert.equal(await laptopUninstall(options({ io: accepted.io, confirm: async () => true, fetch: fakeFetch().fetch })), 0);
    assert.ok(!existsSync(dlHome));
  });

  it("keeps a DL_HOME that isn't the install script's, and never deletes the home directory", async () => {
    const elsewhere = join(home, "work");
    write(join(elsewhere, "notes.txt"), "mine");
    const io = capture();
    await laptopUninstall(options({ io: io.io, yes: true, env: { HOME: home, DL_HOME: elsewhere }, fetch: fakeFetch().fetch }));
    assert.ok(existsSync(join(elsewhere, "notes.txt")));
    assert.match(io.out(), /kept ~\/work: it doesn't look like the install script's folder/);

    assert.equal(laptopUninstallPlan({ env: { HOME: home, DL_HOME: home }, home, packageRoot: "/x" }).dlHomeIsOurs, false);
    assert.equal(laptopUninstallPlan({ env: { HOME: home, DL_HOME: "/" }, home, packageRoot: "/x" }).dlHomeIsOurs, false);
  });

  it("finds a custom DL_HOME from where dl runs, and its startup lines", async () => {
    const custom = join(home, "tools", "dl");
    write(join(custom, "bin", "dl"), "#!/bin/sh\n# Written by the Directionally Local install script.\n");
    write(join(home, ".profile"), `x\n\n${RC_MARKER}\nexport PATH="${custom}/bin:$PATH"\n`);
    const plan = laptopUninstallPlan({ env: { HOME: home }, home, packageRoot: join(custom, "dl", "lib", "node_modules", "directionallylocal") });
    assert.equal(plan.dlHome, custom);
    assert.ok(plan.dlHomeIsOurs);
    assert.deepEqual(plan.rcFiles, [join(home, ".profile")]);
  });

  it("stops agents set up on this computer first; a sign-out that can't reach the service doesn't block", async () => {
    write(join(home, ".directionallylocal", "state.json"), "{}");
    let stopped = false;
    const io = capture();
    const code = await laptopUninstall(options({ io: io.io, yes: true, stopLocalAgents: async () => { stopped = existsSync(dlHome); }, fetch: async () => { throw new Error("offline"); } }));
    assert.equal(code, 0);
    assert.ok(stopped, "before DL_HOME went");
    assert.ok(!existsSync(dlHome));
    assert.match(io.out(), /couldn't reach the free tier to sign out/);
  });

  it("an rc file it can't write is reported, and the rest still goes", async () => {
    // A directory where the backup would go makes the edit fail, for root as well.
    mkdirSync(join(home, ".zshrc.dl-uninstall.bak"));
    const io = capture();
    assert.equal(await laptopUninstall(options({ io: io.io, yes: true, fetch: fakeFetch().fetch })), 0);
    assert.match(io.out(), /couldn't edit ~\/\.zshrc .*remove the "# Directionally Local \(dl\)" line and the PATH line after it yourself/);
    assert.ok(!existsSync(dlHome));
  });

  it("from npm, says how to remove that copy", async () => {
    const io = capture();
    await laptopUninstall(options({ io: io.io, yes: true, installedWithNpm: true, fetch: fakeFetch().fetch }));
    assert.match(io.out(), /npm uninstall -g directionallylocal/);
  });
});

describe("dl uninstall picks server or laptop", () => {
  it("a machine with server state uninstalls the server, as before", async () => {
    const calls: string[] = [];
    const io = capture();
    const code = await main(["uninstall", "--purge"], io.io, {
      terminal: false,
      root: true,
      serverState: async () => ({ access: { mode: "loopback" } }) as unknown as InstallState,
      uninstall: {
        server: async (_system, opts) => { calls.push(`server purge=${opts?.purge}`); },
        laptop: async () => { calls.push("laptop"); return 0; },
      },
    });
    assert.equal(code, 0);
    assert.deepEqual(calls, ["server purge=true"]);
  });

  it("anything else, root included, is a laptop; without a terminal it can't ask", async () => {
    const seen: LaptopUninstallOptions[] = [];
    const laptop = async (opts: LaptopUninstallOptions) => { seen.push(opts); return 0; };
    const io = capture();
    const server = async () => { throw new Error("not a server"); };
    assert.equal(await main(["uninstall"], io.io, { terminal: false, root: true, serverState: async () => undefined, uninstall: { server, laptop } }), 0);
    assert.equal(await main(["uninstall", "--yes", "--purge"], io.io, { terminal: false, root: false, serverState: async () => undefined, uninstall: { server, laptop } }), 0);
    assert.equal(seen[0]!.confirm, undefined);
    assert.equal(seen[0]!.yes, false);
    assert.equal(seen[1]!.yes, true);
    assert.equal(seen[1]!.purge, true);
  });
});

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
