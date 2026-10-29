import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PATHS } from "./layout.js";
import {
  bucketFor, cloneArgs, deployPreview, fetchArgs, freePort, githubToken, isWranglerProject,
  previewCommand, previewId, previewsCommand, readPreviews, removePreview, sobjectsToml, writePreviews,
  type Preview,
} from "./preview.js";
import type { ServerRun } from "./server-api.js";
import type { RunOptions, RunResult, System, WriteOptions } from "./system.js";
import { palette } from "./ui.js";

/** Just the parts of a server `dl preview` touches. */
class FakePreviewSystem implements System {
  readonly dryRun = false;
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();
  readonly commands: string[] = [];
  /** Root entries per directory, for `ls`. */
  readonly listings = new Map<string, string[]>();
  runs: ServerRun[] = [];
  failOn: string | undefined;

  async run(command: string, args: string[], _options: RunOptions = {}): Promise<RunResult> {
    const line = [command, ...args].join(" ");
    this.commands.push(line);
    if (this.failOn && line.includes(this.failOn)) return { code: 1, stdout: "", stderr: "boom" };
    if (line.includes("aster runs")) return { code: 0, stdout: JSON.stringify(this.runs), stderr: "" };
    if (line.includes("clone")) this.dirs.add(args.at(-1)!);
    return { code: 0, stdout: "", stderr: "" };
  }

  async probe(command: string, args: string[]): Promise<RunResult> {
    if (command === "ls") return { code: 0, stdout: (this.listings.get(args.at(-1)!) ?? []).join("\n"), stderr: "" };
    if (command === "curl") return { code: 0, stdout: "200", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }

  async readFile(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }

  async writeFile(path: string, content: string, _options: WriteOptions = {}): Promise<void> {
    this.files.set(path, content);
  }

  async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.dirs.delete(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.dirs.has(path) || this.files.has(path);
  }

  log(): void {}
}

const RUN: ServerRun = {
  conversationId: "3f2a9c1e-0000-4000-8000-000000000000",
  status: "completed",
  active: false,
  repository: "me/app",
  branch: "aster/3f2a9c1e",
  pullRequestURL: "https://github.com/me/app/pull/42",
  startedBy: "laptop",
  createdAt: "2026-10-29T00:00:00.000Z",
};

function capture(): { out: (text: string) => void; text: () => string } {
  let text = "";
  return { out: (chunk) => { text += chunk; }, text: () => text };
}

const c = palette(false);

function deps(system: FakePreviewSystem) {
  return { system, bucket: "s3://previews", token: "github_pat_x", waitForPort: async () => true, now: () => new Date("2026-10-29T12:00:00.000Z") };
}

describe("preview helpers", () => {
  it("takes the task's short id", () => {
    assert.equal(previewId("3f2a9c1e-0000-4000-8000-000000000000"), "3f2a9c1e");
  });

  it("previews only a root Wrangler config", () => {
    assert.equal(isWranglerProject(["wrangler.json", "src"]), true);
    assert.equal(isWranglerProject(["wrangler.jsonc"]), true);
    assert.equal(isWranglerProject(["wrangler.toml"]), true);
    assert.equal(isWranglerProject(["package.json", "src"]), false);
    assert.equal(isWranglerProject(["apps/web/wrangler.json"]), false, "root only");
  });

  it("allocates the first free port in the range", () => {
    assert.equal(freePort([]), 8090);
    assert.equal(freePort([{ port: 8090 } as Preview]), 8091);
    assert.equal(freePort([{ port: 8090 } as Preview, { port: 8092 } as Preview]), 8091);
    const full = Array.from({ length: 10 }, (_, index) => ({ port: 8090 + index }) as Preview);
    assert.equal(freePort(full), undefined);
  });

  it("writes the preview's own node config", () => {
    assert.equal(sobjectsToml({ bucket: "s3://previews/3f2a9c1e", port: 8091 }), '[celld]\nbucket = "s3://previews/3f2a9c1e"\nlisten = "127.0.0.1:8091"\n');
    assert.equal(bucketFor("s3://previews/", "3f2a9c1e"), "s3://previews/3f2a9c1e");
    assert.equal(bucketFor("s3://previews", "3f2a9c1e"), "s3://previews/3f2a9c1e");
  });

  it("keeps the GitHub token out of git's argv", () => {
    const clone = cloneArgs("me/app", "aster/3f2a9c1e", "/tmp/x");
    assert.deepEqual(clone.slice(2), ["clone", "--depth", "1", "--branch", "aster/3f2a9c1e", "https://github.com/me/app.git", "/tmp/x"]);
    assert.match(clone[1]!, /password=\$GITHUB_TOKEN/, "the helper reads the token from the environment");
    assert.equal(clone.some((arg) => arg.includes("github_pat")), false);
    assert.deepEqual(fetchArgs("main").slice(2), ["fetch", "--depth", "1", "origin", "main"]);
  });

  it("reads a registry it wrote, and survives a broken one", async () => {
    const system = new FakePreviewSystem();
    assert.deepEqual(await readPreviews(system), { version: 1, previews: [] });
    const preview = { id: "3f2a9c1e", port: 8090 } as Preview;
    await writePreviews(system, { version: 1, previews: [preview] });
    assert.deepEqual((await readPreviews(system)).previews, [preview]);
    system.files.set(PATHS.previewsState, "{ not json");
    assert.deepEqual(await readPreviews(system), { version: 1, previews: [] });
  });

  it("reads the server's GitHub token", async () => {
    const system = new FakePreviewSystem();
    assert.equal(await githubToken(system), undefined);
    system.files.set(PATHS.githubEnv, "GITHUB_TOKEN=github_pat_abc\n");
    assert.equal(await githubToken(system), "github_pat_abc");
  });
});

describe("dl preview", () => {
  it("clones, deploys and records a Wrangler branch", async () => {
    const system = new FakePreviewSystem();
    system.listings.set(`${PATHS.previews}/3f2a9c1e`, ["wrangler.jsonc", "src", "package.json"]);
    const preview = await deployPreview(RUN, deps(system));

    assert.equal(preview.id, "3f2a9c1e");
    assert.equal(preview.port, 8090);
    assert.equal(preview.branch, "aster/3f2a9c1e");
    assert.equal(preview.createdAt, "2026-10-29T12:00:00.000Z");

    const clone = system.commands.find((command) => command.includes("clone"));
    assert.match(clone!, /^runuser -u autopilot -- git -c credential\.helper=.* clone --depth 1 --branch aster\/3f2a9c1e https:\/\/github\.com\/me\/app\.git /);
    assert.ok(system.commands.includes(`sobjects deploy ${PATHS.previews}/3f2a9c1e`));
    assert.ok(system.commands.includes("sobjects up --detach"));

    const toml = system.files.get(`${PATHS.previews}/3f2a9c1e/sobjects.toml`);
    assert.equal(toml, '[celld]\nbucket = "s3://previews/3f2a9c1e"\nlisten = "127.0.0.1:8090"\n');
    assert.deepEqual((await readPreviews(system)).previews.map((entry) => entry.id), ["3f2a9c1e"]);
  });

  it("refuses a branch with no Wrangler config at its root", async () => {
    const system = new FakePreviewSystem();
    system.listings.set(`${PATHS.previews}/3f2a9c1e`, ["package.json", "src"]);
    await assert.rejects(() => deployPreview(RUN, deps(system)), /has no wrangler\.json, wrangler\.jsonc or wrangler\.toml at its root/);
    assert.equal(system.commands.some((command) => command.startsWith("sobjects")), false);
  });

  it("refuses when every preview slot is taken", async () => {
    const system = new FakePreviewSystem();
    const full = Array.from({ length: 10 }, (_, index) => ({ id: `other${index}`, port: 8090 + index }) as Preview);
    await writePreviews(system, { version: 1, previews: full });
    await assert.rejects(() => deployPreview(RUN, deps(system)), /All 3 preview slots are in use/);
  });

  it("keeps the port and URL when a preview is redeployed", async () => {
    const system = new FakePreviewSystem();
    system.listings.set(`${PATHS.previews}/3f2a9c1e`, ["wrangler.json"]);
    const first = await deployPreview(RUN, deps(system));
    const second = await deployPreview(RUN, deps(system));
    assert.equal(second.port, first.port);
    assert.equal((await readPreviews(system)).previews.length, 1, "one entry, not two");
    assert.ok(system.commands.some((command) => command.includes("fetch --depth 1 origin aster/3f2a9c1e")), "fetches instead of cloning again");
  });

  it("stops a preview and deletes its checkout", async () => {
    const system = new FakePreviewSystem();
    system.listings.set(`${PATHS.previews}/3f2a9c1e`, ["wrangler.json"]);
    await deployPreview(RUN, deps(system));
    assert.equal(await removePreview("3f2a9c1e", system), true);
    assert.ok(system.commands.includes("sobjects down"));
    assert.equal(system.dirs.has(`${PATHS.previews}/3f2a9c1e`), false);
    assert.deepEqual((await readPreviews(system)).previews, []);
    assert.equal(await removePreview("3f2a9c1e", system), false);
  });

  it("prints the port as JSON for the laptop", async () => {
    const system = new FakePreviewSystem();
    system.runs = [RUN];
    system.listings.set(`${PATHS.previews}/3f2a9c1e`, ["wrangler.json"]);
    system.files.set(PATHS.githubEnv, "GITHUB_TOKEN=github_pat_abc\n");
    const io = capture();
    assert.equal(await previewCommand(system, ["3f2a9c1e"], { json: true, bucket: "s3://previews" }, io.out, c), 0);
    assert.deepEqual(JSON.parse(io.text().trim()), { id: "3f2a9c1e", port: 8090, url: "http://127.0.0.1:8090" });
  });

  it("explains what is missing before it deploys", async () => {
    const system = new FakePreviewSystem();
    system.runs = [RUN];
    const noToken = capture();
    assert.equal(await previewCommand(system, ["3f2a9c1e"], { bucket: "s3://previews" }, noToken.out, c), 1);
    assert.match(noToken.text(), /no GitHub token, so it can't clone the branch/);

    system.files.set(PATHS.githubEnv, "GITHUB_TOKEN=github_pat_abc\n");
    const noBucket = capture();
    assert.equal(await previewCommand(system, ["3f2a9c1e"], {}, noBucket.out, c), 1);
    assert.match(noBucket.text(), /Previews need a bucket for their state/);

    const unknown = capture();
    assert.equal(await previewCommand(system, ["deadbeef"], { bucket: "s3://previews" }, unknown.out, c), 1);
    assert.match(unknown.text(), /No task deadbeef/);
  });

  it("lists live previews", async () => {
    const system = new FakePreviewSystem();
    const empty = capture();
    assert.equal(await previewsCommand(system, empty.out, c), 0);
    assert.match(empty.text(), /No previews\. From a task's branch: {2}dl preview <id>/);

    await writePreviews(system, { version: 1, previews: [{ id: "3f2a9c1e", port: 8090, repository: "me/app", branch: "aster/3f2a9c1e", createdAt: "2026-10-29T00:00:00.000Z" } as Preview] });
    const listed = capture();
    assert.equal(await previewsCommand(system, listed.out, c), 0);
    assert.match(listed.text(), /● 3f2a9c1e {2}:8090 {2}me\/app +aster\/3f2a9c1e/);
  });
});
