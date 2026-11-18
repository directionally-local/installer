import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { access, mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { INPUT_VAR, rowsCsv, type DataSet } from "./model-evals-data.js";
import { modelApiBase, NO_THINKING } from "./model-smoke.js";
import type { ModelDeployment } from "./state.js";
import type { System } from "./system.js";

/**
 * promptfoo (github.com/promptfoo/promptfoo, MIT) runs dl's "bring your data" evals: dl fetches a
 * pinned version once into its cache, writes a config that points promptfoo at each model's
 * endpoint and grades model-graded assertions with a judge on this machine, and reads the score
 * and the failing cases from promptfoo's JSON output. Nothing goes to a hosted provider.
 */

/** Pinned exactly; bump deliberately, after a release has been out two weeks. */
export const PROMPTFOO_VERSION = "0.125.1";
/** promptfoo 0.125.1's engines.node. */
export const PROMPTFOO_NODE = [22, 22, 0] as const;
export const PROMPTFOO_DOCS = "https://www.promptfoo.dev/docs/configuration/expected-outputs/";
/** promptfoo's exit code when tests fail (PROMPTFOO_FAILED_TEST_EXIT_CODE): a finished run. */
export const PROMPTFOO_FAILED_EXIT = 100;
export const DATA_MAX_TOKENS = 1024;
export const JUDGE_MAX_TOKENS = 2048;
export const DATA_CONCURRENCY = 4;

/** `~/.cache/directionallylocal/promptfoo-0.125.1` (or `$XDG_CACHE_HOME`). */
export function promptfooDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CACHE_HOME?.trim() || join(env.HOME || homedir(), ".cache"), "directionallylocal", `promptfoo-${PROMPTFOO_VERSION}`);
}

export function nodeTooOld(version: string): string | undefined {
  const parts = version.replace(/^v/, "").split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const have = parts[index] ?? 0;
    const want = PROMPTFOO_NODE[index]!;
    if (have > want) return undefined;
    if (have < want) return `dl evals runs promptfoo ${PROMPTFOO_VERSION}, which needs Node ${PROMPTFOO_NODE.join(".")} or newer; this is Node ${version.replace(/^v/, "")}. Update Node and run it again.`;
  }
  return undefined;
}

// ---- Running a child -----------------------------------------------------------------------

export interface SpawnResult { code: number; timedOut: boolean }

/**
 * A child in its own process group with output going to `logPath`, so a timeout (or Ctrl-C)
 * stops the whole tree. `env` is the child's whole environment, not added to dl's.
 */
export function spawnLogged(file: string, args: readonly string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number; logPath: string }): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const out = openSync(options.logPath, "a", 0o644);
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", out, out], detached: true });
    closeSync(out);
    let timedOut = false;
    let killer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      try { process.kill(-child.pid!, "SIGTERM"); } catch { /* already gone */ }
      killer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }, 10_000);
      killer.unref();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    const interrupt = () => { stop(); process.off("SIGINT", interrupt); process.kill(process.pid, "SIGINT"); };
    process.on("SIGINT", interrupt);
    const done = () => { clearTimeout(timer); process.off("SIGINT", interrupt); };
    child.on("error", (error) => { done(); reject(error); });
    child.on("close", (code, signal) => { done(); if (killer) clearTimeout(killer); resolve({ code: code ?? (signal ? 128 : 1), timedOut }); });
  });
}

// ---- Fetching promptfoo --------------------------------------------------------------------

/** What dl runs promptfoo through; production: `realPromptfoo()`, tests: a fake. */
export interface Promptfoo {
  /** promptfoo's CLI entry point, downloaded on first use (`say` tells the user). */
  ensure(say: (text: string) => void): Promise<string>;
  /** `node ENTRY ARGS...`, output to the log. */
  run(entry: string, args: readonly string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number; logPath: string }): Promise<SpawnResult>;
}

export type NpmInstall = (args: readonly string[]) => Promise<{ code: number; output: string }>;

const realNpm: NpmInstall = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", args, { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.on("error", reject);
  child.on("close", (code) => resolve({ code: code ?? 1, output }));
});

const OFFLINE = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|network|socket hang up/i;

/**
 * promptfoo from dl's cache, installed there with `npm install --ignore-scripts` the first time
 * (it needs no install scripts: its SQLite comes as prebuilt platform packages). Not bundled
 * with dl: it is large, and only teams with eval data need it.
 */
export function realPromptfoo(options: { dir?: string; nodeVersion?: string; npm?: NpmInstall; exists?: (path: string) => Promise<boolean> } = {}): Promptfoo {
  const dir = options.dir ?? promptfooDir();
  const entry = join(dir, "node_modules", "promptfoo", "dist", "src", "entrypoint.js");
  const exists = options.exists ?? (async (path: string) => access(path).then(() => true, () => false));
  return {
    async ensure(say) {
      const old = nodeTooOld(options.nodeVersion ?? process.versions.node);
      if (old) throw new Error(old);
      if (await exists(entry)) return entry;
      say(`first use: downloading promptfoo ${PROMPTFOO_VERSION} from npm into ${dir} (once, a few hundred MB)`);
      const partial = `${dir}.partial-${process.pid}`;
      await rm(partial, { recursive: true, force: true });
      await mkdir(partial, { recursive: true });
      let result: { code: number; output: string };
      try {
        result = await (options.npm ?? realNpm)(["install", "--prefix", partial, `promptfoo@${PROMPTFOO_VERSION}`, "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"]);
      } catch (error) {
        await rm(partial, { recursive: true, force: true });
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`dl evals needs npm to download promptfoo ${PROMPTFOO_VERSION} once; install Node.js with npm and run it again.`);
        throw error;
      }
      if (result.code !== 0) {
        await rm(partial, { recursive: true, force: true });
        if (OFFLINE.test(result.output)) throw new Error(`Can't download promptfoo ${PROMPTFOO_VERSION}: npm can't reach its registry (offline?). dl evals needs it once; connect and run it again.`);
        const last = result.output.trim().split("\n").filter((line) => line.trim()).at(-1) ?? `exit ${result.code}`;
        throw new Error(`Can't download promptfoo ${PROMPTFOO_VERSION}: npm install failed: ${last}`);
      }
      await rm(dir, { recursive: true, force: true });
      await rename(partial, dir);
      if (!(await exists(entry))) throw new Error(`promptfoo ${PROMPTFOO_VERSION} installed into ${dir} without its CLI; remove that folder and run it again.`);
      return entry;
    },
    run: (file, args, runOptions) => spawnLogged(process.execPath, [file, ...args], runOptions),
  };
}

// ---- The config dl writes ------------------------------------------------------------------

/** Deployment fields a provider needs. */
export type Endpoint = Pick<ModelDeployment, "id" | "repo" | "port" | "host">;

/** Strips a `<think>` block left in the answer, as dl's smoke tests do; tool calls pass through. */
const STRIP_THINKING = "typeof output === 'string' ? output.replace(/<think>[\\s\\S]*?(<\\/think>|$)/g, '').trim() : output";

/**
 * promptfoo's OpenAI provider pointed at one deployment: its served model id, temperature 0,
 * thinking off (vLLM and SGLang read `chat_template_kwargs`), reasoning not shown as part of the
 * answer, and a placeholder key (dl's engines need none).
 */
export function providerConfig(deployment: Endpoint, maxTokens = DATA_MAX_TOKENS): Record<string, unknown> {
  return {
    id: `openai:chat:${deployment.repo}`,
    label: deployment.id,
    config: { apiBaseUrl: modelApiBase(deployment), apiKey: "dl-local", temperature: 0, max_tokens: maxTokens, showThinking: false, passthrough: { ...NO_THINKING } },
    transform: STRIP_THINKING,
  };
}

/** The grader for model-graded assertions (llm-rubric, factuality, model-graded-*): the judge's own endpoint. */
export const graderConfig = (judge: Endpoint) => providerConfig(judge, JUDGE_MAX_TOKENS);

/**
 * The child's whole environment: no provider keys or base URLs from the user's shell (so
 * nothing can reach a hosted model by default), promptfoo's telemetry, update check, sharing
 * and remote generation off, and its state in dl's cache.
 */
export function promptfooEnv(configDir: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keep = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LANGUAGE", "TZ", "TMPDIR", "TERM", "SHELL", "VIRTUAL_ENV", "PYTHONPATH", "PROMPTFOO_PYTHON", "NODE_EXTRA_CA_CERTS", "SYSTEMROOT"];
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined && (keep.includes(key) || key.startsWith("LC_"))) out[key] = value;
  return {
    ...out,
    PROMPTFOO_CONFIG_DIR: configDir,
    PROMPTFOO_DISABLE_TELEMETRY: "1",
    PROMPTFOO_DISABLE_UPDATE: "1",
    PROMPTFOO_DISABLE_SHARING: "1",
    PROMPTFOO_DISABLE_REMOTE_GENERATION: "1",
    PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION: "1",
    PROMPTFOO_SELF_HOSTED: "1",
    PROMPTFOO_CACHE_ENABLED: "false",
    NO_COLOR: "1",
  };
}

/** What `promptfoo eval` gets for one data file, besides `-c`. */
export function promptfooArgs(config: string, providerPath: string, graderPath: string, outPath: string): string[] {
  return ["eval", "-c", config, "-r", `file://${providerPath}`, "--grader", `file://${graderPath}`, "-o", outPath,
    "--no-cache", "--no-progress-bar", "--no-table", "--no-write", "--no-share", "-j", String(DATA_CONCURRENCY)];
}

/**
 * The config dl writes for a data file that isn't a promptfoo config: one prompt, the var that
 * holds the input, and the tests (the user's file as is, or the CSV dl translated it to).
 * Providers and the grader come on the command line, the same for every kind of file.
 */
export function generatedConfig(set: DataSet, testsCsv?: string): Record<string, unknown> {
  if (set.run.kind === "config") throw new Error("a promptfoo config runs as is");
  const prompt = set.run.kind === "rows" ? INPUT_VAR : set.run.prompt;
  const tests = set.run.kind === "rows" ? `file://${testsCsv}` : typeof set.run.tests === "string" ? `file://${set.run.tests}` : set.run.tests;
  return { description: `dl evals: ${set.path}`, prompts: [{ raw: `{{ ${prompt} }}`, label: prompt }], tests };
}

// ---- Reading promptfoo's output ------------------------------------------------------------

interface ComponentResult { pass?: boolean; reason?: string; assertion?: { type?: string; value?: unknown } | null }
interface PromptfooResult {
  success?: boolean;
  /** 1: an assertion failed; 2: an error (no answer, a grader that broke). */
  failureReason?: number;
  error?: string | null;
  description?: string;
  prompt?: { raw?: string; label?: string };
  response?: { output?: unknown; error?: string } | null;
  testCase?: { description?: string; vars?: Record<string, unknown> };
  testIdx?: number;
  promptIdx?: number;
  gradingResult?: { pass?: boolean; reason?: string; componentResults?: ComponentResult[] } | null;
}

export interface PromptfooOutcome { successes: number; failures: number; errors: number; results: PromptfooResult[]; prompts: number }

/** promptfoo eval -o FILE.json: `results.stats` and `results.results`; undefined when it isn't that. */
export function promptfooOutcome(value: unknown): PromptfooOutcome | undefined {
  const results = value && typeof value === "object" ? (value as { results?: { stats?: Record<string, unknown>; results?: unknown; prompts?: unknown } }).results : undefined;
  const stats = results?.stats;
  if (!stats || typeof stats.successes !== "number" || typeof stats.failures !== "number") return undefined;
  return { successes: stats.successes, failures: stats.failures, errors: typeof stats.errors === "number" ? stats.errors : 0,
    results: Array.isArray(results.results) ? results.results as PromptfooResult[] : [], prompts: Array.isArray(results.prompts) ? results.prompts.length : 1 };
}

/** One line, at most `max` characters, optionally quoted. */
export function clip(text: string, max: number, quote = false): string {
  const line = text.replace(/\s+/g, " ").trim();
  const cut = line.length > max ? `${line.slice(0, max - 1)}…` : line;
  return quote ? `"${cut}"` : cut;
}

const outputText = (result: PromptfooResult) => {
  const output = result.response?.output;
  return typeof output === "string" ? output : output === undefined || output === null ? "" : JSON.stringify(output);
};

/** The prompt as the model got it: chat JSON shows its last user message. */
function inputText(result: PromptfooResult): string {
  const raw = result.prompt?.raw ?? "";
  if (/^\s*\[/.test(raw)) {
    try {
      const messages = JSON.parse(raw) as Array<{ role?: string; content?: unknown }>;
      const last = messages.filter((message) => message.role === "user").at(-1);
      if (typeof last?.content === "string") return last.content;
    } catch { /* text */ }
  }
  return raw;
}

const valueText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value ?? ""));

/** The assertions that failed (an any-of set lists all its answers). */
const failedChecks = (result: PromptfooResult) => (result.gradingResult?.componentResults ?? []).filter((component) => component.pass === false && component.assertion);

/** "qa.jsonl#2 (math-1)", or the user's description, or "test 3"; with several prompts, which one. */
function where(result: PromptfooResult, prompts: number): string {
  const name = result.testCase?.description ?? result.description ?? `test ${(result.testIdx ?? 0) + 1}`;
  return prompts > 1 ? `${name} [prompt ${(result.promptIdx ?? 0) + 1}]` : name;
}

/** One line per failing case: where, input, the assertion and its value, and what the model said. */
export function failureLine(result: PromptfooResult, prompts = 1): string {
  const head = `${where(result, prompts)}: ${clip(inputText(result), 40, true)}`;
  if (result.failureReason === 2 || (!result.gradingResult && result.error)) return clip(`${head} · error: ${clip(result.error ?? result.response?.error ?? "no answer", 80)}`, 200);
  const failed = failedChecks(result);
  const first = failed[0]?.assertion;
  const check = first ? `${first.type ?? "assertion"}${first.value !== undefined ? ` ${clip(valueText(first.value), 40, true)}` : ""}${failed.length > 1 ? ` (or ${failed.length - 1} more)` : ""}`
    : clip(result.gradingResult?.reason ?? result.error ?? "failed", 60);
  return clip(`${head} · ${check} · got ${clip(outputText(result), 50, true)}`, 200);
}

/** The first `max` failing cases, then how many more. */
export function failureLines(outcomes: readonly PromptfooOutcome[], max = 5): string[] {
  // promptfoo lists results as they finish; in file order, they read like the data.
  const order = (result: PromptfooResult) => (result.testIdx ?? 0) * 1000 + (result.promptIdx ?? 0);
  const failed = outcomes.flatMap((outcome) => outcome.results.filter((result) => result.success === false).sort((a, b) => order(a) - order(b))
    .map((result) => ({ result, prompts: outcome.prompts })));
  const lines = failed.slice(0, max).map(({ result, prompts }) => failureLine(result, prompts));
  if (failed.length > max) lines.push(`and ${failed.length - max} more in the results file`);
  return lines;
}

/**
 * When most failures are `equals` misses whose expected text is in the answer ("The capital is
 * Paris." for Paris), one line on promptfoo's looser checks. It never changes the score.
 */
export function looseMatchHint(outcomes: readonly PromptfooOutcome[]): string | undefined {
  const failed = outcomes.flatMap((outcome) => outcome.results.filter((result) => result.success === false && result.failureReason !== 2));
  const inside = failed.filter((result) => {
    const output = outputText(result).toLowerCase();
    return failedChecks(result).some((component) => component.assertion?.type === "equals" && typeof component.assertion.value === "string"
      && component.assertion.value.trim() !== "" && output.includes(component.assertion.value.trim().toLowerCase()));
  });
  if (!inside.length || inside.length * 2 <= failed.length) return undefined;
  return `${inside.length} of ${failed.length} failures are exact-match misses whose answer contains the expected text; to accept those, write contains:Paris or factuality:... in your data (${PROMPTFOO_DOCS})`;
}

// ---- One model, every data file ------------------------------------------------------------

export interface DataRunInput {
  system: System;
  promptfoo: Promptfoo;
  sets: readonly DataSet[];
  deployment: Endpoint;
  judge: Endpoint;
  /** Where the generated config, the log and promptfoo's state go. */
  workDir: string;
  /** promptfoo's JSON output: `${outPrefix}.json`, or `-2.json`... with several files. */
  outPrefix: string;
  deadline: number;
  now: () => number;
  say: (text: string) => void;
  env?: NodeJS.ProcessEnv;
}

export interface DataRunOutput {
  outcomes: PromptfooOutcome[];
  /** promptfoo's JSON files. */
  results: string[];
  /** The first file's promptfoo log (one per file, next to it). */
  logPath: string;
  timedOut: boolean;
  /** Why a file gave no results: "qa.jsonl: promptfoo exited 1 without results (see the log)". */
  errors: string[];
}

/** promptfoo once per data file against one deployment, graded by the judge. */
export async function runPromptfooData(input: DataRunInput): Promise<DataRunOutput> {
  const { system, workDir } = input;
  const entry = await input.promptfoo.ensure(input.say);
  await system.mkdir(workDir, { mode: 0o700 });
  const providerPath = join(workDir, "provider.json");
  const graderPath = join(workDir, "grader.json");
  await system.writeFile(providerPath, `${JSON.stringify(providerConfig(input.deployment), null, 2)}\n`, { mode: 0o600 });
  await system.writeFile(graderPath, `${JSON.stringify(graderConfig(input.judge), null, 2)}\n`, { mode: 0o600 });
  const env = promptfooEnv(join(workDir, "promptfoo-home"), input.env);
  const output: DataRunOutput = { outcomes: [], results: [], logPath: join(workDir, `promptfoo${input.sets.length > 1 ? "-1" : ""}.log`), timedOut: false, errors: [] };
  for (const [index, set] of input.sets.entries()) {
    const remaining = input.deadline - input.now();
    if (remaining <= 0) { output.timedOut = true; output.errors.push(`${set.path}: not run, the time limit was reached`); continue; }
    const suffix = input.sets.length > 1 ? `-${index + 1}` : "";
    const config = set.run.kind === "config" ? set.run.config : join(workDir, `promptfooconfig${suffix}.json`);
    if (set.run.kind !== "config") {
      const csv = set.run.kind === "rows" ? join(workDir, `tests${suffix}.csv`) : undefined;
      if (csv && set.run.kind === "rows") await system.writeFile(csv, rowsCsv(set.run.rows), { mode: 0o600 });
      await system.writeFile(config, `${JSON.stringify(generatedConfig(set, csv), null, 2)}\n`, { mode: 0o600 });
    }
    const outPath = `${input.outPrefix}${suffix}.json`;
    const args = promptfooArgs(config, providerPath, graderPath, outPath);
    const logPath = join(workDir, `promptfoo${suffix}.log`);
    await system.writeFile(logPath, `$ promptfoo ${args.join(" ")}\n# in ${workDir}\n\n`, { mode: 0o644 });
    const result = await input.promptfoo.run(entry, args, { cwd: workDir, env, timeoutMs: remaining, logPath });
    if (result.timedOut) output.timedOut = true;
    const raw = await system.readFile(outPath);
    let outcome: PromptfooOutcome | undefined;
    try { outcome = raw ? promptfooOutcome(JSON.parse(raw)) : undefined; } catch { outcome = undefined; }
    if (!outcome) {
      output.errors.push(`${set.path}: ${result.timedOut ? "stopped at the time limit" : `promptfoo exited ${result.code}`} without results (see ${logPath})`);
      continue;
    }
    output.outcomes.push(outcome);
    output.results.push(outPath);
  }
  return output;
}

/** "41 of 44 passed · 2 errors", plus files that gave nothing and a time limit. */
export function dataRunSummary(run: DataRunOutput): string {
  const totals = run.outcomes.reduce((sum, outcome) => ({ passed: sum.passed + outcome.successes, all: sum.all + outcome.successes + outcome.failures + outcome.errors, errors: sum.errors + outcome.errors }),
    { passed: 0, all: 0, errors: 0 });
  const parts = [totals.all ? `${totals.passed} of ${totals.all} passed` : "no results"];
  if (totals.errors) parts.push(`${totals.errors} ${totals.errors === 1 ? "error" : "errors"}`);
  if (run.errors.length) parts.push(...run.errors);
  if (run.timedOut && !run.errors.some((line) => /time limit/.test(line))) parts.push("stopped at the time limit");
  return parts.join(" · ");
}

/** passed over all, errors counted as failures (as the command path reads promptfoo JSON); undefined with no results. */
export function dataScore(run: DataRunOutput): number | undefined {
  const all = run.outcomes.reduce((sum, outcome) => sum + outcome.successes + outcome.failures + outcome.errors, 0);
  return all ? run.outcomes.reduce((sum, outcome) => sum + outcome.successes, 0) / all : undefined;
}

/** Every case errored (the endpoint is down): no answers at all. */
export function noAnswers(run: DataRunOutput): string | undefined {
  const results = run.outcomes.flatMap((outcome) => outcome.results);
  if (!results.length) return run.errors.length ? run.errors[0] : undefined;
  if (!results.every((result) => result.failureReason === 2)) return undefined;
  return clip(results[0]!.error ?? results[0]!.response?.error ?? "no answer", 120);
}
