import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { glob, readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { caseSource, dataRunSummary, dataSummary, failureLines, loadEvalData, runDataCases, type DataRunOptions } from "./model-evals-data.js";
import { containerRunning } from "./model-runtime.js";
import { modelApiBase, type FetchModel } from "./model-smoke.js";
import { DEFAULT_DEPLOYMENT, modelStatePath, readDeployments, type ModelDeployment } from "./state.js";
import type { System } from "./system.js";
import type { Ui } from "./ui.js";

/**
 * `dl evals`, bring your command: the team's own eval command (pytest/DeepEval, promptfoo,
 * Inspect, anything) runs once per model with OPENAI_BASE_URL pointed at it. Pass or fail is its
 * exit code; a score comes from the results files it writes, when dl can read them.
 * Bring your data (model-evals-data.ts): eval files dl runs itself. Either or both.
 */
export interface EvalConfig {
  version: 1;
  /** Run with the user's shell (`$SHELL -c`), in `dir`. */
  command?: string;
  /** An eval data file, folder or glob, absolute (dl evals set --data). */
  data?: string;
  /** The directory `dl evals set` ran in. */
  dir: string;
  /** How far below the incumbent's score a candidate may land (0–1); DEFAULT_THRESHOLD when unset. */
  threshold?: number;
  /** A glob (relative to `dir`) for the results files; unset: DEFAULT_RESULTS. */
  results?: string;
  timeoutSeconds?: number;
  setAt: string;
}

export const DEFAULT_THRESHOLD = 0.02;
export const DEFAULT_TIMEOUT_SECONDS = 30 * 60;
/** Where the common tools write results when told to; read only when this run wrote them. */
export const DEFAULT_RESULTS = ["junit.xml", "report.xml", "test-results.xml", "results.json", "output.json", "promptfoo-output.json",
  "logs/*.eval", "logs/*.json", ".deepeval/.latest_test_run.json"];
/** What OPENAI_API_KEY is when the endpoint asks for none (dl's vLLM and SGLang don't). */
export const DUMMY_API_KEY = "dl-local";

/** Next to model.json: per machine, like the deployments. */
export function evalsConfigPath(statePath = modelStatePath()): string {
  return join(dirname(statePath), "evals.json");
}

export async function readEvalConfig(system: System, path: string): Promise<EvalConfig | undefined> {
  const raw = await system.readFile(path);
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<EvalConfig>;
    const command = typeof value.command === "string" && value.command.trim() !== "";
    const data = typeof value.data === "string" && value.data.trim() !== "";
    if (value.version !== 1 || !(command || data) || (value.command !== undefined && !command) || (value.data !== undefined && !data) || typeof value.dir !== "string"
      || (value.threshold !== undefined && !validThreshold(value.threshold)) || (value.results !== undefined && typeof value.results !== "string")
      || (value.timeoutSeconds !== undefined && !(Number.isInteger(value.timeoutSeconds) && value.timeoutSeconds > 0))) throw new Error("invalid");
    return value as EvalConfig;
  } catch { throw new Error(`Invalid evals config at ${path}; fix it or run dl evals clear.`); }
}

export async function writeEvalConfig(system: System, config: EvalConfig, path: string): Promise<void> {
  await system.mkdir(dirname(path), { mode: 0o700 });
  await system.writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

const validThreshold = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

export function parseThreshold(text: string): number {
  const value = Number(text);
  if (!text.trim() || !validThreshold(value)) throw new Error(`--threshold takes a score difference from 0 to 1, like 0.02 (got "${text}").`);
  return value;
}

/** "90s", "30m", "2h", or seconds. */
export function parseTimeout(text: string): number {
  const match = /^(\d+)(s|m|h)?$/.exec(text.trim());
  const seconds = match ? Number(match[1]) * (match[2] === "h" ? 3600 : match[2] === "m" ? 60 : 1) : 0;
  if (!seconds) throw new Error(`--timeout takes a duration like 90s, 30m or 2h (got "${text}").`);
  return seconds;
}

export function durationText(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The environment the eval command sees for one model. */
export function evalEnv(deployment: Pick<ModelDeployment, "repo" | "port" | "host">, name: string, role?: EvalRole): Record<string, string> {
  const base = modelApiBase(deployment);
  return {
    OPENAI_BASE_URL: base,
    // Older clients (LangChain, LiteLLM) read this name.
    OPENAI_API_BASE: base,
    OPENAI_API_KEY: DUMMY_API_KEY,
    OPENAI_MODEL: deployment.repo,
    DL_EVAL_MODEL: deployment.repo,
    DL_EVAL_ENDPOINT: base.replace(/\/v1$/, ""),
    DL_EVAL_DEPLOYMENT: name,
    ...(role ? { DL_EVAL_ROLE: role } : {}),
  };
}

// ---- Running the command -------------------------------------------------------------------

export interface SpawnResult { code: number; timedOut: boolean }
/** Runs the command with output going to `logPath`; production: `realSpawn`. */
export type SpawnEval = (command: string, options: { cwd: string; env: Record<string, string>; timeoutMs: number; logPath: string }) => Promise<SpawnResult>;

/**
 * `$SHELL -c COMMAND` in its own process group, so a timeout (or Ctrl-C) stops the whole tree
 * (pytest's workers, promptfoo's), not just the shell.
 */
export const realSpawn: SpawnEval = (command, options) => new Promise((resolve, reject) => {
  const out = openSync(options.logPath, "a", 0o644);
  const child = spawn(process.env.SHELL || "/bin/sh", ["-c", command], {
    cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ["ignore", out, out], detached: true,
  });
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

/** What dl reads results files through; production: the real filesystem. */
export interface ResultsFs {
  /** Matches of a glob relative to `dir` (or absolute), as absolute paths. */
  find(dir: string, pattern: string): Promise<string[]>;
  mtimeMs(path: string): Promise<number | undefined>;
  read(path: string): Promise<Buffer | undefined>;
}

export const realResultsFs: ResultsFs = {
  async find(dir, pattern) {
    const found: string[] = [];
    for await (const path of glob(pattern, { cwd: dir, exclude: (name: string) => /(^|\/)(node_modules|\.git)(\/|$)/.test(name) })) found.push(isAbsolute(path) ? path : join(dir, path));
    return found;
  },
  mtimeMs: async (path) => (await stat(path).catch(() => undefined))?.mtimeMs,
  read: async (path) => readFile(path).catch(() => undefined),
};

// ---- Reading results files -----------------------------------------------------------------

export interface ParsedResult {
  /** 0–1, or undefined when the file isn't a format dl reads. */
  score?: number;
  /** "JUnit XML: 41 of 44 passed". */
  detail: string;
}

/** One results file, by its content (not its name). */
export function parseResultFile(path: string, data: Buffer): ParsedResult {
  if (extname(path) === ".eval" || data.subarray(0, 4).equals(Buffer.from("PK\x03\x04", "latin1"))) return parseInspectEval(data);
  const text = data.toString("utf8").replace(/^﻿/, "").trim();
  if (text.startsWith("<")) return parseJunit(text);
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { detail: "not read: not JSON or JUnit XML" }; }
  return parseJson(value);
}

const ratio = (passed: number, total: number, what: string): ParsedResult =>
  total > 0 ? { score: passed / total, detail: `${what}: ${passed} of ${total} passed` } : { detail: `not read: ${what} with no results` };

/** pytest --junitxml (and any JUnit XML): passed test cases over those that ran (skipped don't count). */
export function parseJunit(text: string): ParsedResult {
  if (!/<testsuites?\b/.test(text)) return { detail: "not read: XML, but not JUnit" };
  let total = 0;
  let passed = 0;
  for (const match of text.matchAll(/<testcase\b[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const body = match[1] ?? "";
    if (/<skipped\b/.test(body)) continue;
    total++;
    if (!/<(failure|error)\b/.test(body)) passed++;
  }
  return ratio(passed, total, "JUnit XML");
}

function parseJson(value: unknown): ParsedResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { detail: "not read: JSON in a format dl doesn't know" };
  const object = value as Record<string, unknown>;
  const results = object.results as Record<string, unknown> | undefined;
  // promptfoo eval -o FILE.json: results.stats has successes, failures and errors.
  const stats = results && typeof results === "object" ? results.stats as Record<string, unknown> | undefined : undefined;
  if (stats && typeof stats.successes === "number" && typeof stats.failures === "number") {
    return ratio(stats.successes, stats.successes + stats.failures + (typeof stats.errors === "number" ? stats.errors : 0), "promptfoo");
  }
  // Inspect's JSON log (--log-format json): results.scores[].metrics.
  if (object.eval && results && Array.isArray(results.scores)) return inspectScore(object);
  // DeepEval's saved test run: testCases[].success.
  const cases = [object.testCases, object.conversationalTestCases].filter(Array.isArray).flat() as Array<Record<string, unknown>>;
  if (cases.length && cases.every((item) => item && typeof item.success === "boolean")) return ratio(cases.filter((item) => item.success).length, cases.length, "DeepEval");
  // Anything else that writes {"score": n}: 0–1 as is, up to 100 as a percentage.
  if (typeof object.score === "number" && Number.isFinite(object.score)) {
    const score = object.score;
    if (score >= 0 && score <= 1) return { score, detail: `score ${score}` };
    if (score > 1 && score <= 100) return { score: score / 100, detail: `score ${score} (read as a percentage)` };
    return { detail: `not read: score ${score} is not 0–1 or a percentage` };
  }
  return { detail: "not read: JSON in a format dl doesn't know" };
}

/** Inspect's first scorer: accuracy, else mean, when it is 0–1. */
function inspectScore(log: Record<string, unknown>): ParsedResult {
  const status = log.status;
  if (status !== undefined && status !== "success") return { detail: `not read: Inspect log status ${String(status)}` };
  const scores = (log.results as { scores?: Array<{ name?: string; metrics?: Record<string, { value?: unknown }> }> }).scores ?? [];
  const first = scores[0];
  const metric = first?.metrics?.accuracy ?? first?.metrics?.mean;
  const value = metric?.value;
  if (typeof value !== "number" || value < 0 || value > 1) return { detail: "not read: Inspect log has no 0–1 accuracy or mean" };
  return { score: value, detail: `Inspect ${first?.name ?? "score"} ${first?.metrics?.accuracy ? "accuracy" : "mean"} ${value}` };
}

/** Inspect's default .eval log is a zip; its header.json carries the results. */
function parseInspectEval(data: Buffer): ParsedResult {
  const header = zipEntry(data, "header.json");
  if (!header) return { detail: "not read: Inspect .eval log without header.json (still running?)" };
  try { return inspectScore(JSON.parse(header.toString("utf8")) as Record<string, unknown>); } catch { return { detail: "not read: Inspect header.json is not JSON" }; }
}

/** One file from a zip archive (stored or deflated; no zip64), or undefined. */
export function zipEntry(data: Buffer, name: string): Buffer | undefined {
  try {
    let end = -1;
    for (let at = data.length - 22; at >= Math.max(0, data.length - 22 - 65_535); at--) if (data.readUInt32LE(at) === 0x06054b50) { end = at; break; }
    if (end < 0) return undefined;
    const count = data.readUInt16LE(end + 10);
    let at = data.readUInt32LE(end + 16);
    for (let index = 0; index < count; index++) {
      if (data.readUInt32LE(at) !== 0x02014b50) return undefined;
      const method = data.readUInt16LE(at + 10);
      const size = data.readUInt32LE(at + 20);
      const nameLength = data.readUInt16LE(at + 28);
      const skip = nameLength + data.readUInt16LE(at + 30) + data.readUInt16LE(at + 32);
      const local = data.readUInt32LE(at + 42);
      if (data.toString("utf8", at + 46, at + 46 + nameLength) === name) {
        const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
        const body = data.subarray(start, start + size);
        return method === 0 ? body : method === 8 ? inflateRawSync(body) : undefined;
      }
      at += 46 + skip;
    }
  } catch { /* not a zip dl can read */ }
  return undefined;
}

// ---- One run per model ---------------------------------------------------------------------

export type EvalRole = "incumbent" | "candidate";

export interface EvalRun {
  /** The deployment's name, and the model it serves. */
  deployment: string;
  model: string;
  role?: EvalRole;
  passed: boolean;
  code: number;
  timedOut: boolean;
  /** 0–1: the mean of the results files dl could read. */
  score?: number;
  /** "junit.xml: JUnit XML: 41 of 44 passed", and files it couldn't read. */
  results: string[];
  durationMs: number;
  /** The command's log; with data only, the data results file. */
  logPath: string;
  /** No command ran: only data (dl evals set --data). */
  dataOnly?: true;
  /** Why it failed when not by an exit code: "no answers". */
  error?: string;
  /** The data part: "41 of 44 passed · ...", the first failing cases, and the full results file. */
  data?: { summary: string; failures: string[]; resultsPath: string };
}

export interface EvalRunOptions {
  system: System;
  config: EvalConfig;
  logDir: string;
  /** Overrides the config's timeout. */
  timeoutSeconds?: number;
  spawn?: SpawnEval;
  fs?: ResultsFs;
  now?: () => number;
  /** The data runner's transport (tests), and its limits. */
  fetch?: FetchModel;
  dataRun?: Omit<DataRunOptions, "fetch" | "deadline" | "now">;
}

async function snapshot(fs: ResultsFs, dir: string, patterns: readonly string[]): Promise<Map<string, number | undefined>> {
  const seen = new Map<string, number | undefined>();
  for (const pattern of patterns) for (const path of await fs.find(dir, pattern).catch(() => [])) if (!seen.has(path)) seen.set(path, await fs.mtimeMs(path));
  return seen;
}

/**
 * The evals against one deployment: the command, the data, or both. With both, both must pass,
 * and the score is the mean of the scores there are (the command's, when it wrote one, and the
 * data's).
 */
export async function runEval(options: EvalRunOptions, name: string, deployment: ModelDeployment, role?: EvalRole): Promise<EvalRun> {
  const command = options.config.command ? await runCommand(options, name, deployment, role) : undefined;
  const data = options.config.data ? await runData(options, name, deployment, role) : undefined;
  if (!command) return data!;
  if (!data) return command;
  const scores = [command.score, data.score].filter((score): score is number => score !== undefined);
  const { score: _score, error: _error, ...rest } = command;
  return { ...rest, passed: command.passed && data.passed, timedOut: command.timedOut || data.timedOut, durationMs: command.durationMs + data.durationMs,
    ...(scores.length ? { score: scores.reduce((sum, value) => sum + value, 0) / scores.length } : {}),
    ...(command.passed && data.error ? { error: data.error } : {}), data: data.data! };
}

/** The directory the data files share, so they show as paths under it. */
function commonDir(paths: readonly string[]): string {
  let dir = dirname(paths[0] ?? "/");
  while (dir !== "/" && !paths.every((path) => path.startsWith(`${dir}/`))) dir = dirname(dir);
  return dir;
}

/** dl's own runner over the data files, against one deployment; the full results go to a JSON file. */
async function runData(options: EvalRunOptions, name: string, deployment: ModelDeployment, role?: EvalRole): Promise<EvalRun> {
  const { config, system } = options;
  const now = options.now ?? Date.now;
  const loaded = await loadEvalData(config.data!);
  const root = commonDir(loaded.sets.map((set) => set.path));
  const cases = loaded.sets.flatMap((set) => set.cases.map((item) => ({ source: caseSource(set, item, root), item })));
  await system.mkdir(options.logDir, { mode: 0o700 });
  const started = now();
  const timeoutSeconds = options.timeoutSeconds ?? config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const result = await runDataCases(cases, deployment, { ...options.dataRun, ...(options.fetch ? { fetch: options.fetch } : {}), deadline: started + timeoutSeconds * 1000, now });
  const durationMs = now() - started;
  const stamp = new Date(started).toISOString().replace(/[:.]/g, "-");
  const resultsPath = join(options.logDir, `${stamp}-evals-${name}${role ? `-${role}` : ""}-data.json`);
  await system.writeFile(resultsPath, `${JSON.stringify({ deployment: name, model: deployment.id, served: deployment.repo, endpoint: modelApiBase(deployment), ...(role ? { role } : {}),
    at: new Date(started).toISOString(), durationMs, data: config.data, files: loaded.sets.map((set) => ({ path: set.path, format: set.format, cases: set.cases.length, notes: set.notes })),
    skippedFiles: loaded.skipped, score: result.score ?? null, checked: result.checked, passed: result.passed, noCheck: result.noCheck, errors: result.errors,
    skippedAssertions: result.skipped, timedOut: result.timedOut, cases: result.cases }, null, 2)}\n`, { mode: 0o644 });
  const noAnswers = result.cases.length > 0 && result.errors === result.cases.length;
  const passed = !result.timedOut && !noAnswers;
  const summary = noAnswers ? `no answers: ${result.cases[0]!.error}` : dataRunSummary(result);
  return { deployment: name, model: deployment.id, ...(role ? { role } : {}), passed, code: passed ? 0 : 1, timedOut: result.timedOut,
    ...(result.score !== undefined && !noAnswers ? { score: result.score } : {}), results: [], durationMs, logPath: resultsPath, dataOnly: true,
    ...(noAnswers ? { error: "no answers" } : {}), data: { summary, failures: failureLines(result), resultsPath } };
}

/** Runs the eval command against one deployment and reads what it wrote. */
async function runCommand(options: EvalRunOptions, name: string, deployment: ModelDeployment, role?: EvalRole): Promise<EvalRun> {
  const { config } = options;
  const fs = options.fs ?? realResultsFs;
  const now = options.now ?? Date.now;
  const patterns = config.results ? [config.results] : DEFAULT_RESULTS;
  if (!(await options.system.exists(config.dir))) throw new Error(`The evals directory ${config.dir} is gone; run dl evals set again from your project.`);
  await options.system.mkdir(options.logDir, { mode: 0o700 });
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
  const logPath = join(options.logDir, `${stamp}-evals-${name}${role ? `-${role}` : ""}.log`);
  const env = evalEnv(deployment, name, role);
  await options.system.writeFile(logPath, `$ ${config.command}\n# in ${config.dir}\n${Object.entries(env).map(([key, value]) => `# ${key}=${value}`).join("\n")}\n\n`, { mode: 0o644 });
  // Results files count only when this run wrote them: never a previous model's.
  const before = await snapshot(fs, config.dir, patterns);
  const started = now();
  const timeoutSeconds = options.timeoutSeconds ?? config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const result = await (options.spawn ?? realSpawn)(config.command!, { cwd: config.dir, env, timeoutMs: timeoutSeconds * 1000, logPath });
  const durationMs = now() - started;
  const after = await snapshot(fs, config.dir, patterns);
  const results: string[] = [];
  const scores: number[] = [];
  for (const [path, mtime] of after) {
    if (mtime === undefined || (before.has(path) && before.get(path) === mtime)) continue;
    const data = await fs.read(path);
    if (!data) continue;
    const parsed = parseResultFile(path, data);
    const shown = path.startsWith(`${config.dir}/`) ? path.slice(config.dir.length + 1) : path;
    results.push(`${shown}: ${parsed.detail}`);
    if (parsed.score !== undefined) scores.push(parsed.score);
  }
  if (config.results && results.length === 0) results.push(`${config.results}: not read, ${after.size ? "this run didn't write it" : "no file matches"}`);
  const score = scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : undefined;
  return { deployment: name, model: deployment.id, ...(role ? { role } : {}), passed: result.code === 0 && !result.timedOut, code: result.code, timedOut: result.timedOut,
    ...(score !== undefined ? { score } : {}), results, durationMs, logPath };
}

// ---- Showing and gating --------------------------------------------------------------------

const scoreText = (score: number | undefined) => (score === undefined ? "–" : score.toFixed(2));
const resultText = (run: EvalRun) => (run.timedOut ? "timeout" : run.passed ? "pass" : `fail (${run.error ?? run.code})`);

/** Model, result, score and time, one row per run, padded into columns. */
export function evalTable(runs: readonly EvalRun[]): string[] {
  const rows = [["Model", "Result", "Score", "Time"], ...runs.map((run) => [`${run.model}${run.role ? ` (${run.role})` : run.deployment !== DEFAULT_DEPLOYMENT ? ` (${run.deployment})` : ""}`,
    resultText(run), scoreText(run.score), durationText(run.durationMs)])];
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows.map((row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]! + 2))).join(""));
}

export function showRuns(ui: Ui, runs: readonly EvalRun[]): void {
  for (const row of evalTable(runs)) ui.line("info", row);
  for (const run of runs) {
    const label = `Results (${run.role ?? run.deployment})`;
    for (const line of run.results) ui.line("info", label, line);
    if (!run.results.length && !run.dataOnly) ui.line("info", label, "no results file; pass or fail from the exit code");
    if (run.data) {
      ui.line("info", label, `data: ${run.data.summary}`);
      for (const line of run.data.failures) ui.line("info", `Failed (${run.role ?? run.deployment})`, line);
      ui.line("info", `Data results (${run.role ?? run.deployment})`, run.data.resultsPath);
    }
  }
}

export interface GateDecision { ok: boolean; reason: string }

/**
 * Whether the candidate may take traffic. With both scores: candidate >= incumbent - threshold,
 * and it may not fail where the incumbent passed. Without: it must pass where the incumbent
 * passed. A command that fails on both, with no score, blocks: it is broken, not the model.
 */
export function evalGate(incumbent: EvalRun | undefined, candidate: EvalRun, threshold = DEFAULT_THRESHOLD): GateDecision {
  const failed = (run: EvalRun) => (run.timedOut ? "timed out" : run.error ? `failed (${run.error})` : `failed (exit ${run.code})`);
  if (!incumbent) return candidate.passed ? { ok: true, reason: "candidate passed (incumbent not run)" } : { ok: false, reason: `candidate's evals ${failed(candidate)}` };
  if (!candidate.passed && incumbent.passed) return { ok: false, reason: `candidate's evals ${failed(candidate)}; the incumbent's passed` };
  if (candidate.score !== undefined && incumbent.score !== undefined) {
    const floor = incumbent.score - threshold;
    // Scores are compared at the precision they're shown with.
    if (Math.round(candidate.score * 1e6) < Math.round(floor * 1e6)) {
      return { ok: false, reason: `candidate scored ${scoreText(candidate.score)}, below incumbent ${scoreText(incumbent.score)} − ${threshold}` };
    }
    return { ok: true, reason: `candidate ${scoreText(candidate.score)} ≥ incumbent ${scoreText(incumbent.score)} − ${threshold}` };
  }
  if (candidate.passed) return { ok: true, reason: incumbent.passed ? "both passed (no score to compare)" : "candidate passed; the incumbent failed" };
  return { ok: false, reason: `the ${candidate.dataOnly ? "evals" : "eval command"} ${failed(candidate)} on both models; fix ${candidate.dataOnly ? "them" : "it"} or pass --skip-evals` };
}

// ---- dl evals -------------------------------------------------------------------------------

export interface EvalsCommandOptions {
  system: System;
  ui: Ui;
  statePath?: string;
  /** The directory `set` stores; process.cwd() in production. */
  cwd: string;
  logDir: string;
  threshold?: string;
  results?: string;
  timeout?: string;
  /** --data PATH: an eval data file, folder or glob ("" removes it). */
  data?: string;
  /** -m/--model NAME: one more deployment to run on. */
  model?: string;
  spawn?: SpawnEval;
  fs?: ResultsFs;
  fetch?: FetchModel;
}

const USAGE = 'dl evals set ["COMMAND"] [--data PATH] [--threshold 0.02] [--results GLOB] [--timeout 30m] · dl evals run [NAME...] · dl evals show · dl evals clear';

export async function evalsCommand(args: string[], options: EvalsCommandOptions): Promise<number> {
  const { system, ui } = options;
  const [action, ...rest] = args;
  const statePath = options.statePath ?? modelStatePath();
  const path = evalsConfigPath(statePath);
  const usage = () => { ui.line("failed", "Usage", USAGE); return 2; };
  const settingFlags = options.threshold !== undefined || options.results !== undefined || options.data !== undefined;
  if (action !== "set" && settingFlags) throw new Error("--threshold, --results and --data go with dl evals set.");
  if (action !== "set" && action !== "run" && options.timeout !== undefined) throw new Error("--timeout goes with dl evals set or dl evals run.");
  if (action !== "run" && options.model !== undefined) throw new Error("--model goes with dl evals run.");
  const config = await readEvalConfig(system, path);
  if (action === "set") {
    if (rest.length > 1) return usage();
    const command = rest[0]?.trim() || config?.command;
    // A path as given, made absolute: a glob stays a glob.
    const data = options.data !== undefined ? (options.data.trim() ? resolve(options.cwd, options.data.trim()) : undefined) : config?.data;
    if (!command && !data) return usage();
    // Read the data now: a file dl can't use is an error here, not at the next update.
    const loaded = options.data?.trim() ? await loadEvalData(data!) : undefined;
    const next: EvalConfig = { version: 1, ...(command ? { command } : {}), ...(data ? { data } : {}), dir: rest[0]?.trim() || !config ? options.cwd : config.dir,
      ...(options.threshold !== undefined ? { threshold: parseThreshold(options.threshold) } : config?.threshold !== undefined ? { threshold: config.threshold } : {}),
      ...(options.results !== undefined ? (options.results.trim() ? { results: options.results.trim() } : {}) : config?.results !== undefined ? { results: config.results } : {}),
      ...(options.timeout !== undefined ? { timeoutSeconds: parseTimeout(options.timeout) } : config?.timeoutSeconds !== undefined ? { timeoutSeconds: config.timeoutSeconds } : {}),
      setAt: new Date().toISOString() };
    await writeEvalConfig(system, next, path);
    ui.line("done", "Evals", "saved; dl model update runs them on both models before switching");
    show(ui, next);
    if (loaded) for (const line of dataSummary(loaded, commonDir(loaded.sets.map((set) => set.path)))) ui.line("info", "Data", line);
    return 0;
  }
  if (action === "show") {
    if (rest.length) return usage();
    if (!config) { ui.line("info", "Evals", 'none · dl evals set "COMMAND" or dl evals set --data PATH'); return 0; }
    show(ui, config);
    return 0;
  }
  if (action === "clear") {
    if (rest.length) return usage();
    if (config) await system.remove(path);
    ui.line("done", "Evals", config ? "cleared; dl model update switches on smoke tests alone" : "none set");
    return 0;
  }
  if (action !== "run") return usage();
  if (!config) throw new Error('No evals set. Run dl evals set "COMMAND" or dl evals set --data PATH in your project first.');
  const deployments = await readDeployments(system, statePath);
  const names = [...rest, ...(options.model !== undefined ? [options.model] : [])];
  const chosen = names.length ? [...new Set(names)] : Object.keys(deployments).sort((a, b) => (a === DEFAULT_DEPLOYMENT ? -1 : b === DEFAULT_DEPLOYMENT ? 1 : a.localeCompare(b)));
  if (chosen.length === 0) throw new Error("No model is running here. Run dl model up first.");
  const missing = chosen.filter((name) => !deployments[name]);
  if (missing.length) throw new Error(`No deployment named ${missing.join(", ")}; see dl model list.`);
  const stopped = [];
  for (const name of chosen) if (!(await containerRunning(system, deployments[name]!.active.container))) stopped.push(deployments[name]!.active.container);
  if (stopped.length) throw new Error(`Model container ${stopped.join(", ")} is stopped; evals need a running model.`);
  const runs: EvalRun[] = [];
  for (const name of chosen) {
    const deployment = deployments[name]!.active;
    ui.line("info", "Evals", `running on ${deployment.id}${name !== DEFAULT_DEPLOYMENT ? ` (${name})` : ""} · ${modelApiBase(deployment)}`);
    runs.push(await runEval({ system, config, logDir: options.logDir, ...(options.timeout !== undefined ? { timeoutSeconds: parseTimeout(options.timeout) } : {}),
      ...(options.spawn ? { spawn: options.spawn } : {}), ...(options.fs ? { fs: options.fs } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) }, name, deployment));
  }
  showRuns(ui, runs);
  for (const run of runs) if (!run.dataOnly) ui.line("info", `Log (${run.deployment})`, run.logPath);
  return runs.every((run) => run.passed) ? 0 : 1;
}

function show(ui: Ui, config: EvalConfig): void {
  if (config.command) {
    ui.line("info", "Command", config.command);
    ui.line("info", "Runs in", config.dir);
    ui.line("info", "Results", config.results ?? "found automatically: JUnit XML, promptfoo JSON, Inspect logs, DeepEval, {\"score\": n}");
  }
  if (config.data) ui.line("info", "Data", `${config.data} (run by dl: JSONL, CSV, promptfoo, OpenAI Evals, Braintrust, LangSmith)`);
  if (config.command && config.data) ui.line("info", "Both", "both must pass; the score is the mean of the two");
  ui.line("info", "Threshold", `${config.threshold ?? DEFAULT_THRESHOLD} (the new model may score this much lower)`);
  ui.line("info", "Timeout", durationText((config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000));
}
