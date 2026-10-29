import { join } from "node:path";
import { parseEnvFile, PATHS, USERS } from "./layout.js";
import { listServerRuns, type ServerRun } from "./server-api.js";
import type { System } from "./system.js";
import { palette } from "./ui.js";

/**
 * `dl preview`: deploy an agent's Workers branch on this server with Serverless Objects and
 * reach it over the laptop's SSH tunnel. Design: docs/plans/preview-deploys.md.
 *
 * Serverless Objects is pre-alpha, so a preview failing is expected rather than exceptional:
 * it never fails the task or its pull request, and it is reported in `dl previews`.
 */

export const MAX_PREVIEWS = 3;
export const PREVIEW_PORT_FIRST = 8090;
export const PREVIEW_PORT_LAST = 8099;

/** Root only: a monorepo with several Wrangler projects is out of scope for Phase 1. */
const WRANGLER_CONFIGS = /^wrangler\.(json|jsonc|toml)$/;

export interface Preview {
  /** The task's short id, as `dl runs` shows it. */
  id: string;
  conversationId: string;
  repository: string;
  branch: string;
  /** The port the preview listens on, on the server's loopback. */
  port: number;
  directory: string;
  createdAt: string;
}

export interface PreviewState {
  version: 1;
  previews: Preview[];
}

export function previewId(conversationId: string): string {
  return conversationId.slice(0, 8);
}

/** A branch is previewable when its root has a Wrangler config (design §3). */
export function isWranglerProject(files: string[]): boolean {
  return files.some((name) => WRANGLER_CONFIGS.test(name));
}

/** The first free port in the range, or undefined when every slot is taken. */
export function freePort(previews: Preview[]): number | undefined {
  const used = new Set(previews.map((preview) => preview.port));
  for (let port = PREVIEW_PORT_FIRST; port <= PREVIEW_PORT_LAST; port++) if (!used.has(port)) return port;
  return undefined;
}

/** The preview's own node config (design §2.3): its own port and its own bucket prefix. */
export function sobjectsToml(input: { bucket: string; port: number }): string {
  return `[celld]\nbucket = ${JSON.stringify(input.bucket)}\nlisten = "127.0.0.1:${input.port}"\n`;
}

export function bucketFor(prefix: string, id: string): string {
  return `${prefix.replace(/\/+$/, "")}/${id}`;
}

/**
 * The token reaches git through the environment, never argv: `ps` would show it there.
 * The helper string itself holds no secret.
 */
const CREDENTIAL_HELPER = 'credential.helper=!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f';

export function cloneArgs(repository: string, branch: string, directory: string): string[] {
  return ["-c", CREDENTIAL_HELPER, "clone", "--depth", "1", "--branch", branch, `https://github.com/${repository}.git`, directory];
}

export function fetchArgs(branch: string): string[] {
  return ["-c", CREDENTIAL_HELPER, "fetch", "--depth", "1", "origin", branch];
}

export async function readPreviews(system: System): Promise<PreviewState> {
  const raw = await system.readFile(PATHS.previewsState);
  if (!raw) return { version: 1, previews: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<PreviewState>;
    return parsed.version === 1 && Array.isArray(parsed.previews) ? { version: 1, previews: parsed.previews } : { version: 1, previews: [] };
  } catch {
    return { version: 1, previews: [] };
  }
}

export async function writePreviews(system: System, state: PreviewState): Promise<void> {
  await system.writeFile(PATHS.previewsState, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o644 });
}

/** The server's GitHub token, for a read-only clone as the autopilot user (design §2.5). */
export async function githubToken(system: System): Promise<string | undefined> {
  const token = parseEnvFile(await system.readFile(PATHS.githubEnv)).GITHUB_TOKEN;
  return token || undefined;
}

export interface PreviewDeps {
  system: System;
  /** The bucket previews share, e.g. s3://directionally-local-previews. */
  bucket: string;
  token: string;
  now?: () => Date;
  /** Waits for the preview's port to answer; tests replace it. */
  waitForPort?: (port: number) => Promise<boolean>;
}

/** Deploys (or redeploys) one run's branch, keeping its port and URL stable. */
export async function deployPreview(run: ServerRun, deps: PreviewDeps): Promise<Preview> {
  const { system } = deps;
  const { repository, branch } = run;
  if (!repository || !branch) throw new Error("That task has no branch to preview yet; it pushes one when it finishes a step.");

  const id = previewId(run.conversationId);
  const directory = join(PATHS.previews, id);
  const state = await readPreviews(system);
  const existing = state.previews.find((preview) => preview.id === id);
  const port = existing?.port ?? freePort(state.previews);
  if (port === undefined) throw new Error(`All ${MAX_PREVIEWS} preview slots are in use. Remove one: dl preview <id> --remove`);

  await syncCheckout(system, { repository, branch, directory }, deps.token);
  if (!(await isWranglerCheckout(system, directory))) {
    throw new Error(`${repository} at ${branch} has no wrangler.json, wrangler.jsonc or wrangler.toml at its root, so there's nothing to preview.`);
  }

  await system.writeFile(join(directory, "sobjects.toml"), sobjectsToml({ bucket: bucketFor(deps.bucket, id), port }), {
    mode: 0o644,
    owner: `${USERS.autopilot}:${USERS.autopilot}`,
  });

  const env = { SOBJECTS_STATE_DIR: join(directory, "state") };
  await system.run("sobjects", ["deploy", directory], { env, describe: `sobjects deploy ${id}` });
  await system.run("sobjects", ["up", "--detach"], { env, cwd: directory, describe: `sobjects up ${id}` });

  const wait = deps.waitForPort ?? ((target: number) => waitForPort(system, target));
  if (!(await wait(port))) throw new Error(`The preview started but nothing answered on 127.0.0.1:${port}. Check its log: dl logs`);

  const preview: Preview = {
    id,
    conversationId: run.conversationId,
    repository,
    branch,
    port,
    directory,
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
  };
  await writePreviews(system, { version: 1, previews: [...state.previews.filter((entry) => entry.id !== id), preview] });
  return preview;
}

/** Stops a preview's node and deletes its checkout and state. */
export async function removePreview(id: string, system: System): Promise<boolean> {
  const state = await readPreviews(system);
  const preview = state.previews.find((entry) => entry.id === id);
  if (!preview) return false;
  await system.run("sobjects", ["down"], {
    cwd: preview.directory,
    env: { SOBJECTS_STATE_DIR: join(preview.directory, "state") },
    allowFailure: true,
    describe: `sobjects down ${id}`,
  });
  await system.remove(preview.directory);
  await writePreviews(system, { version: 1, previews: state.previews.filter((entry) => entry.id !== id) });
  return true;
}

async function syncCheckout(system: System, input: { repository: string; branch: string; directory: string }, token: string): Promise<void> {
  const owner = `${USERS.autopilot}:${USERS.autopilot}`;
  const env = { GITHUB_TOKEN: token };
  if (!(await system.exists(input.directory))) {
    await system.mkdir(PATHS.previews, { owner });
    await system.run("runuser", ["-u", USERS.autopilot, "--", "git", ...cloneArgs(input.repository, input.branch, input.directory)], {
      env,
      describe: `clone ${input.repository}`,
    });
    return;
  }
  await system.run("runuser", ["-u", USERS.autopilot, "--", "git", "-C", input.directory, ...fetchArgs(input.branch)], {
    env,
    describe: `fetch ${input.branch}`,
  });
  await system.run("runuser", ["-u", USERS.autopilot, "--", "git", "-C", input.directory, "reset", "--hard", "FETCH_HEAD"], {
    describe: `reset ${input.branch}`,
  });
}

async function isWranglerCheckout(system: System, directory: string): Promise<boolean> {
  const listing = await system.probe("ls", ["-1", directory]);
  return listing.code === 0 && isWranglerProject(listing.stdout.split("\n").map((line) => line.trim()).filter(Boolean));
}

async function waitForPort(system: System, port: number, attempts = 30): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const answer = await system.probe("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "2", `http://127.0.0.1:${port}/`]);
    const code = answer.stdout.trim();
    if (answer.code === 0 && code !== "" && code !== "000") return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

type Colors = ReturnType<typeof palette>;

/** `dl preview <id> [--remove] [--json]`: deploy a run's branch, or stop its preview. */
export async function previewCommand(
  system: System,
  args: string[],
  options: { json?: boolean; bucket?: string },
  write: (text: string) => void,
  c: Colors,
): Promise<number> {
  const id = args.find((arg) => !arg.startsWith("-"));
  if (!id) {
    write(`  Usage: dl preview <id>   ${c.dim("(from dl runs)")}   ${c.dim("--remove stops it")}\n`);
    return 2;
  }

  if (args.includes("--remove")) {
    const removed = await removePreview(id, system);
    if (options.json) write(`${JSON.stringify({ id, removed })}\n`);
    else write(`\n  ${removed ? c.green("✓") : c.red("✗")} ${removed ? `Removed the preview for ${id}` : `No preview for ${id}`}\n\n`);
    return removed ? 0 : 1;
  }

  const runs = await listServerRuns(system, 200);
  if (runs === undefined) {
    write(`\n  ${c.red("✗")} Couldn't list runs; run ${c.bold("dl up")} to update this server.\n\n`);
    return 1;
  }
  const matches = runs.filter((run) => run.conversationId.startsWith(id));
  if (matches.length === 0) {
    write(`\n  ${c.red("✗")} No task ${id}. ${c.dim("dl runs")} lists them.\n\n`);
    return 1;
  }
  if (matches.length > 1) {
    write(`\n  ${c.red("✗")} ${id} matches several tasks; use more characters.\n\n`);
    return 1;
  }

  const token = await githubToken(system);
  if (!token) {
    write(`\n  ${c.red("✗")} This server has no GitHub token, so it can't clone the branch. Set one: ${c.bold("dl keys set github")}\n\n`);
    return 1;
  }
  const bucket = options.bucket ?? process.env.DL_PREVIEWS_BUCKET;
  if (!bucket) {
    write(`\n  ${c.red("✗")} Previews need a bucket for their state. Set ${c.bold("DL_PREVIEWS_BUCKET")} in ${c.dim(PATHS.autopilotEnv)} (e.g. s3://my-previews).\n\n`);
    return 1;
  }

  const preview = await deployPreview(matches[0]!, { system, bucket, token });
  if (options.json) {
    write(`${JSON.stringify({ id: preview.id, port: preview.port, url: `http://127.0.0.1:${preview.port}` })}\n`);
    return 0;
  }
  write(`\n  ${c.green("✓")} ${preview.id} is live at ${c.bold(`http://127.0.0.1:${preview.port}`)}\n`);
  write(`  ${c.dim("From your laptop:")} dl preview ${preview.id}   ${c.dim("Stop it:")} dl preview ${preview.id} --remove\n\n`);
  return 0;
}

/** `dl previews`: the live previews, newest first. */
export async function previewsCommand(system: System, write: (text: string) => void, c: Colors): Promise<number> {
  const { previews } = await readPreviews(system);
  if (previews.length === 0) {
    write(`\n  No previews. From a task's branch:  ${c.bold("dl preview <id>")}\n\n`);
    return 0;
  }
  write("\n");
  for (const preview of [...previews].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    write(`  ${c.green("●")} ${preview.id}  ${c.dim(`:${preview.port}`)}  ${(preview.repository ?? "").padEnd(28)} ${c.dim(preview.branch)}\n`);
  }
  write(`\n  ${c.dim("Open one from your laptop:")} dl preview <id>   ${c.dim("Stop one:")} dl preview <id> --remove\n\n`);
  return 0;
}
