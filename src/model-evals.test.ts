import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { modelCommand, type ModelCommandOptions } from "./model-command.js";
import { evalGate, evalsCommand, evalTable, parseResultFile, parseTimeout, realSpawn, runEval, zipEntry, type EvalConfig, type EvalRun, type ResultsFs, type SpawnEval } from "./model-evals.js";
import type { Prompter } from "./prompt.js";
import { writeDeployment, type ModelDeployment } from "./state.js";
import { FakeModelSystem } from "./test-support/fake-model-system.js";
import { PlainUi } from "./ui.js";

const PROJECT = "/home/me/project";

/** A project folder whose files the fake eval command writes; mtimes tick on each write. */
class FakeProject implements ResultsFs {
  readonly files = new Map<string, { data: Buffer; mtime: number }>();
  private clock = 1000;
  write(name: string, data: string | Buffer): void {
    this.files.set(join(PROJECT, name), { data: Buffer.isBuffer(data) ? data : Buffer.from(data), mtime: this.clock++ });
  }
  async find(dir: string, pattern: string): Promise<string[]> {
    const regex = new RegExp(`^${join(dir, pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
    return [...this.files.keys()].filter((path) => regex.test(path));
  }
  async mtimeMs(path: string) { return this.files.get(path)?.mtime; }
  async read(path: string) { return this.files.get(path)?.data; }
}

interface SpawnCall { command: string; cwd: string; env: Record<string, string>; timeoutMs: number; logPath: string }

/** A fake child process: records each call; `behave` decides the exit code and writes results. */
function fakeSpawn(behave: (env: Record<string, string>) => number | "timeout" = () => 0) {
  const calls: SpawnCall[] = [];
  const spawn: SpawnEval = async (command, options) => {
    calls.push({ command, ...options });
    const outcome = behave(options.env);
    return outcome === "timeout" ? { code: 143, timedOut: true } : { code: outcome, timedOut: false };
  };
  return { calls, spawn };
}

const junit = (passed: number, failed: number) => `<?xml version="1.0"?><testsuites><testsuite name="pytest" tests="${passed + failed}">${
  Array.from({ length: passed }, (_, i) => `<testcase classname="t" name="ok${i}" time="0.1"/>`).join("")}${
  Array.from({ length: failed }, (_, i) => `<testcase classname="t" name="bad${i}"><failure message="no">trace</failure></testcase>`).join("")}<testcase name="s"><skipped/></testcase></testsuite></testsuites>`;

function deployment(id: string, repo: string, port: number): ModelDeployment {
  return { id, repo, container: `dl-model-${port}`, port, context: 8192, image: "vllm/vllm-openai:v0.33.0", flags: [], minVramMiB: 1,
    lastTest: { chat: true, tools: true, json: true, tokensPerSecond: 1, at: "" } };
}

const config = (extra: Partial<EvalConfig> = {}): EvalConfig => ({ version: 1, command: "pytest -q --junitxml=junit.xml", dir: PROJECT, setAt: "", ...extra });

function run(extra: Partial<EvalRun>): EvalRun {
  return { deployment: "default", model: "m", passed: true, code: 0, timedOut: false, results: [], durationMs: 1000, logPath: "/l", ...extra };
}

test("set, show and clear store one eval command per machine, next to the model state", async () => {
  const system = new FakeModelSystem();
  const lines: string[] = [];
  const options = { system, ui: new PlainUi((line) => lines.push(line)), statePath: "/state/model.json", cwd: PROJECT, logDir: "/logs" };
  assert.equal(await evalsCommand(["show"], options), 0);
  assert.match(lines.join(""), /Evals: none · dl evals set "COMMAND"/);
  assert.equal(await evalsCommand(["set", "promptfoo eval -o out.json"], { ...options, threshold: "0.05", results: "out.json", timeout: "45m" }), 0);
  const saved = JSON.parse(system.files.get("/state/evals.json")!.content);
  assert.deepEqual({ ...saved, setAt: "" }, { version: 1, command: "promptfoo eval -o out.json", dir: PROJECT, threshold: 0.05, results: "out.json", timeoutSeconds: 2700, setAt: "" });
  assert.equal(system.files.get("/state/evals.json")!.mode, 0o600);
  // Changing one setting keeps the command and its directory.
  assert.equal(await evalsCommand(["set"], { ...options, cwd: "/elsewhere", threshold: "0.1" }), 0);
  assert.equal(JSON.parse(system.files.get("/state/evals.json")!.content).dir, PROJECT);
  assert.equal(JSON.parse(system.files.get("/state/evals.json")!.content).threshold, 0.1);
  lines.length = 0;
  assert.equal(await evalsCommand(["show"], options), 0);
  assert.match(lines.join(""), /Command: promptfoo eval -o out\.json\n-- Runs in: \/home\/me\/project\n-- Results: out\.json\n-- Threshold: 0\.1 .*\n-- Timeout: 45m 00s/);
  await assert.rejects(evalsCommand(["set", "x"], { ...options, threshold: "2" }), /--threshold takes a score difference from 0 to 1/);
  await assert.rejects(evalsCommand(["show"], { ...options, threshold: "0.1" }), /--threshold and --results go with dl evals set/);
  assert.equal(await evalsCommand(["clear"], options), 0);
  assert.ok(!system.files.has("/state/evals.json"));
  assert.equal(await evalsCommand(["frobnicate"], options), 2);
});

test("run gives each deployment its own endpoint, model and key in the environment, in the project folder", async () => {
  const system = new FakeModelSystem();
  system.dirs.add(PROJECT);
  await writeDeployment(system, "default", { active: deployment("qwen-old", "Qwen/Qwen3-8B", 8000) }, "/state/model.json");
  await writeDeployment(system, "big", { active: { ...deployment("glm", "zai/GLM-5.3-Flash", 8002), host: "10.0.0.5" } }, "/state/model.json");
  system.running.add("dl-model-8000");
  const project = new FakeProject();
  const { calls, spawn } = fakeSpawn((env) => { project.write("junit.xml", env.OPENAI_MODEL === "Qwen/Qwen3-8B" ? junit(3, 1) : junit(4, 0)); return env.OPENAI_MODEL === "Qwen/Qwen3-8B" ? 1 : 0; });
  const lines: string[] = [];
  const options = { system, ui: new PlainUi((line) => lines.push(line)), statePath: "/state/model.json", cwd: PROJECT, logDir: "/logs", spawn, fs: project };
  await evalsCommand(["set", "pytest -q --junitxml=junit.xml"], options);
  await assert.rejects(evalsCommand(["run"], options), /Model container dl-model-8002 is stopped; evals need a running model/);
  system.running.add("dl-model-8002");
  assert.equal(await evalsCommand(["run"], options), 1, "one model failed");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.cwd), [PROJECT, PROJECT]);
  assert.equal(calls[0]!.command, "pytest -q --junitxml=junit.xml");
  assert.deepEqual(calls[0]!.env, { OPENAI_BASE_URL: "http://127.0.0.1:8000/v1", OPENAI_API_BASE: "http://127.0.0.1:8000/v1", OPENAI_API_KEY: "dl-local",
    OPENAI_MODEL: "Qwen/Qwen3-8B", DL_EVAL_MODEL: "Qwen/Qwen3-8B", DL_EVAL_ENDPOINT: "http://127.0.0.1:8000", DL_EVAL_DEPLOYMENT: "default" });
  assert.equal(calls[1]!.env.OPENAI_BASE_URL, "http://10.0.0.5:8002/v1");
  assert.equal(calls[1]!.env.DL_EVAL_DEPLOYMENT, "big");
  assert.equal(calls[0]!.timeoutMs, 30 * 60_000);
  assert.match(calls[0]!.logPath, /^\/logs\/.*-evals-default\.log$/);
  assert.match(system.files.get(calls[0]!.logPath)!.content, /^\$ pytest -q --junitxml=junit\.xml\n# in \/home\/me\/project\n# OPENAI_BASE_URL=http:\/\/127\.0\.0\.1:8000\/v1/);
  const out = lines.join("");
  assert.match(out, /qwen-old +fail \(1\) +0\.75 +1s|qwen-old +fail \(1\) +0\.75 +0s/);
  assert.match(out, /glm \(big\) +pass +1\.00/);
  assert.match(out, /Results \(default\): junit\.xml: JUnit XML: 3 of 4 passed/);
  // One deployment by name (or -m), with a timeout for this run.
  calls.length = 0;
  assert.equal(await evalsCommand(["run"], { ...options, model: "big", timeout: "90s" }), 0);
  assert.deepEqual(calls.map((call) => [call.env.DL_EVAL_DEPLOYMENT, call.timeoutMs]), [["big", 90_000]]);
  await assert.rejects(evalsCommand(["run", "nope"], options), /No deployment named nope/);
  system.running.delete("dl-model-8002");
  await assert.rejects(evalsCommand(["run"], options), /Model container dl-model-8002 is stopped/);
});

test("run without a command, or with no model, says what to do", async () => {
  const system = new FakeModelSystem();
  const options = { system, ui: new PlainUi(() => {}), statePath: "/state/model.json", cwd: PROJECT, logDir: "/logs", spawn: fakeSpawn().spawn, fs: new FakeProject() };
  await assert.rejects(evalsCommand(["run"], options), /No eval command set\. Run dl evals set "COMMAND"/);
  await evalsCommand(["set", "make evals"], options);
  await assert.rejects(evalsCommand(["run"], options), /No model is running here/);
});

test("exit code decides pass or fail; a timeout fails; results files a run didn't write are ignored", async () => {
  const system = new FakeModelSystem();
  system.dirs.add(PROJECT);
  const project = new FakeProject();
  project.write("junit.xml", junit(1, 9)); // left by an earlier run
  let exit: number | "timeout" = 0;
  const { spawn } = fakeSpawn(() => exit);
  const settings = { system, config: config(), logDir: "/logs", spawn, fs: project };
  const passed = await runEval(settings, "default", deployment("a", "org/a", 8000));
  assert.equal(passed.passed, true);
  assert.equal(passed.score, undefined, "the stale junit.xml is not this run's");
  assert.deepEqual(passed.results, []);
  exit = 2;
  assert.deepEqual([(await runEval(settings, "default", deployment("a", "org/a", 8000))).passed, exit], [false, 2]);
  exit = "timeout";
  const timedOut = await runEval(settings, "default", deployment("a", "org/a", 8000), "candidate");
  assert.equal(timedOut.passed, false);
  assert.equal(timedOut.timedOut, true);
  // --results names a file the run never wrote: said so.
  const named = await runEval({ ...settings, config: config({ results: "out/*.json" }) }, "default", deployment("a", "org/a", 8000));
  assert.deepEqual(named.results, ["out/*.json: not read, no file matches"]);
  // Several fresh results files: their mean.
  const both = fakeSpawn(() => { project.write("junit.xml", junit(1, 1)); project.write("results.json", '{"score": 1}'); return 0; });
  const mean = await runEval({ ...settings, spawn: both.spawn }, "default", deployment("a", "org/a", 8000));
  assert.equal(mean.score, 0.75);
  assert.deepEqual(mean.results.sort(), ["junit.xml: JUnit XML: 1 of 2 passed", "results.json: score 1"]);
  system.dirs.delete(PROJECT);
  await assert.rejects(runEval(settings, "default", deployment("a", "org/a", 8000)), /The evals directory \/home\/me\/project is gone/);
});

test("results parsers: JUnit, promptfoo, Inspect (JSON and .eval), DeepEval, {score}", () => {
  const parse = (name: string, text: string | Buffer) => parseResultFile(name, Buffer.isBuffer(text) ? text : Buffer.from(text));
  assert.deepEqual(parse("junit.xml", junit(41, 3)), { score: 41 / 44, detail: "JUnit XML: 41 of 44 passed" });
  assert.deepEqual(parse("junit.xml", '<testsuite><testcase name="a"><error message="boom"/></testcase></testsuite>'), { score: 0, detail: "JUnit XML: 0 of 1 passed" });
  assert.match(parse("x.xml", "<html></html>").detail, /not read: XML, but not JUnit/);
  const promptfoo = { evalId: "e", results: { version: 3, results: [], stats: { successes: 18, failures: 1, errors: 1, tokenUsage: {} } }, config: {} };
  assert.deepEqual(parse("out.json", JSON.stringify(promptfoo)), { score: 0.9, detail: "promptfoo: 18 of 20 passed" });
  const inspect = { version: 2, status: "success", eval: { task: "gsm8k", model: "openai/Qwen/Qwen3-8B" },
    results: { total_samples: 100, completed_samples: 100, scores: [{ name: "match", scorer: "match", metrics: { accuracy: { name: "accuracy", value: 0.82 }, stderr: { name: "stderr", value: 0.03 } } }] } };
  assert.deepEqual(parse("logs/2026-11-18_gsm8k.json", JSON.stringify(inspect)), { score: 0.82, detail: "Inspect match accuracy 0.82" });
  assert.match(parse("logs/a.json", JSON.stringify({ ...inspect, status: "error" })).detail, /not read: Inspect log status error/);
  assert.deepEqual(parse("logs/a.eval", zip({ "_journal/start.json": "{}", "header.json": JSON.stringify(inspect) })), { score: 0.82, detail: "Inspect match accuracy 0.82" });
  assert.deepEqual(parse("logs/a.eval", zip({ "header.json": JSON.stringify(inspect) }, 0)), { score: 0.82, detail: "Inspect match accuracy 0.82" }, "stored, not deflated");
  assert.match(parse("logs/a.eval", zip({ "_journal/start.json": "{}" })).detail, /not read: Inspect \.eval log without header\.json/);
  const deepeval = { testFile: "test_app.py", testCases: [{ name: "a", success: true, metricsData: [] }, { name: "b", success: false, metricsData: [] }], conversationalTestCases: [{ name: "c", success: true }] };
  assert.deepEqual(parse(".deepeval/.latest_test_run.json", JSON.stringify(deepeval)), { score: 2 / 3, detail: "DeepEval: 2 of 3 passed" });
  assert.deepEqual(parse("results.json", '{"score": 0.7, "n": 10}'), { score: 0.7, detail: "score 0.7" });
  assert.deepEqual(parse("results.json", '{"score": 85}'), { score: 0.85, detail: "score 85 (read as a percentage)" });
  assert.match(parse("results.json", '{"score": 400}').detail, /not read: score 400/);
  assert.match(parse("results.json", '{"accuracy": 0.7}').detail, /not read: JSON in a format dl doesn't know/);
  assert.match(parse("results.json", "PASS 3/4").detail, /not read: not JSON or JUnit XML/);
  assert.equal(zipEntry(Buffer.from("not a zip"), "header.json"), undefined);
});

test("the gate: pass, fail by threshold, pass/fail without scores, and a command broken on both", () => {
  const inc = (extra: Partial<EvalRun> = {}) => run({ model: "old", role: "incumbent", ...extra });
  const cand = (extra: Partial<EvalRun> = {}) => run({ model: "new", role: "candidate", ...extra });
  assert.deepEqual(evalGate(inc({ score: 0.86 }), cand({ score: 0.85 })), { ok: true, reason: "candidate 0.85 ≥ incumbent 0.86 − 0.02" });
  assert.deepEqual(evalGate(inc({ score: 0.86 }), cand({ score: 0.84 })), { ok: true, reason: "candidate 0.84 ≥ incumbent 0.86 − 0.02" }, "exactly at the threshold passes");
  assert.deepEqual(evalGate(inc({ score: 0.86 }), cand({ score: 0.81 })), { ok: false, reason: "candidate scored 0.81, below incumbent 0.86 − 0.02" });
  assert.equal(evalGate(inc({ score: 0.86 }), cand({ score: 0.81 }), 0.1).ok, true, "a looser threshold");
  assert.deepEqual(evalGate(inc({ score: 0.5 }), cand({ score: 0.99, passed: false, code: 1 })), { ok: false, reason: "candidate's evals failed (exit 1); the incumbent's passed" });
  // Both exit nonzero (pytest with a few known failures): the scores decide.
  assert.equal(evalGate(inc({ score: 0.9, passed: false, code: 1 }), cand({ score: 0.91, passed: false, code: 1 })).ok, true);
  // No scores: pass/fail only.
  assert.deepEqual(evalGate(inc(), cand()), { ok: true, reason: "both passed (no score to compare)" });
  assert.deepEqual(evalGate(inc(), cand({ passed: false, timedOut: true, code: 143 })), { ok: false, reason: "candidate's evals timed out; the incumbent's passed" });
  assert.deepEqual(evalGate(inc({ passed: false, code: 1 }), cand()), { ok: true, reason: "candidate passed; the incumbent failed" });
  assert.deepEqual(evalGate(inc({ passed: false, code: 127 }), cand({ passed: false, code: 127 })), { ok: false, reason: "the eval command failed (exit 127) on both models; fix it or pass --skip-evals" });
  // One score only: pass/fail.
  assert.equal(evalGate(inc({ score: 0.9 }), cand()).ok, true);
  // The incumbent was stopped for the candidate (not enough VRAM for both): the candidate must pass.
  assert.equal(evalGate(undefined, cand()).ok, true);
  assert.equal(evalGate(undefined, cand({ passed: false, code: 1 })).ok, false);
});

test("the table lines up model, result, score and time", () => {
  assert.deepEqual(evalTable([
    run({ model: "qwen-old", role: "incumbent", score: 0.8612, durationMs: 252_000 }),
    run({ model: "qwen-new", role: "candidate", passed: false, code: 1, durationMs: 9_400 }),
    run({ model: "glm", deployment: "big", timedOut: true, passed: false, code: 143, durationMs: 2 * 3600_000 }),
  ]), [
    "Model                 Result    Score  Time",
    "qwen-old (incumbent)  pass      0.86   4m 12s",
    "qwen-new (candidate)  fail (1)  –      9s",
    "glm (big)             timeout   –      2h 00m",
  ]);
  assert.equal(parseTimeout("2h"), 7200);
  assert.throws(() => parseTimeout("soon"), /--timeout takes a duration/);
});

function updateFixture() {
  const system = new FakeModelSystem();
  system.dirs.add(PROJECT);
  const lines: string[] = [];
  const prompter: Prompter = { choose: async () => "qwen-old", select: async (_q, choices) => ({ value: choices[0]!.value }), secret: async () => "", text: async () => "" };
  const project = new FakeProject();
  const scores: Record<string, number> = {};
  const exits: Record<string, number> = {};
  const { calls, spawn } = fakeSpawn((env) => {
    const score = scores[env.DL_EVAL_ROLE!];
    if (score !== undefined) project.write("results.json", JSON.stringify({ score }));
    return exits[env.DL_EVAL_ROLE!] ?? 0;
  });
  const options: ModelCommandOptions = { system, ui: new PlainUi((line) => lines.push(line)), prompter, interactive: false,
    configPath: "/tmp/autopilot/config.json", statePath: "/tmp/model.json", logDir: "/tmp/logs", evalSpawn: spawn, evalFs: project,
    smoke: async () => ({ chat: true, tools: true, json: true, tokensPerSecond: 10, at: "now" }),
    bench: async () => ({ levels: [{ concurrency: 1, requests: 1, ttftP50: 0.1, ttftP95: 0.1, decodeTokPerSec: 100 }] }) };
  const setEvals = (extra: Partial<EvalConfig> = {}) => system.writeFile("/tmp/evals.json", JSON.stringify(config({ command: "python evals.py", ...extra })));
  const active = () => JSON.parse(system.files.get("/tmp/model.json")!.content).active.id as string;
  return { system, lines, options, calls, scores, exits, setEvals, active };
}

test("update runs the evals on both models after the smoke tests and switches when the candidate holds up", async () => {
  const { system, lines, options, calls, scores, setEvals, active } = updateFixture();
  assert.equal(await modelCommand("up", ["qwen-old"], options), 0);
  assert.equal(calls.length, 0, "up doesn't run evals");
  await setEvals();
  scores.incumbent = 0.8; scores.candidate = 0.79;
  assert.equal(await modelCommand("update", ["qwen-new"], options), 0);
  assert.deepEqual(calls.map((call) => [call.env.DL_EVAL_ROLE, call.env.OPENAI_BASE_URL]), [["incumbent", "http://127.0.0.1:8000/v1"], ["candidate", "http://127.0.0.1:8001/v1"]]);
  const out = lines.join("");
  assert.match(out, /Speed \(512 tokens\)[\s\S]*Evals: running on qwen-old \(incumbent\)[\s\S]*-- Model +Result +Score +Time\n-- qwen-old \(incumbent\) +pass +0\.80[\s\S]*-- qwen-new \(candidate\) +pass +0\.79[\s\S]*ok Evals: candidate 0\.79 ≥ incumbent 0\.80 − 0\.02[\s\S]*ok Model serving/);
  assert.equal(active(), "qwen-new");
  assert.ok(!system.running.has("dl-model-1"));
});

test("update keeps the incumbent when the candidate scores below the threshold, and says why in one line", async () => {
  const { system, lines, options, scores, setEvals, active } = updateFixture();
  await modelCommand("up", ["qwen-old"], options);
  await setEvals({ threshold: 0.05 });
  scores.incumbent = 0.9; scores.candidate = 0.8;
  const error = await modelCommand("update", ["qwen-new"], options).catch((caught: Error) => caught);
  assert.match(String(error), /^Error: Evals: candidate scored 0\.80, below incumbent 0\.90 − 0\.05; qwen-old keeps serving\.\n/);
  assert.match(lines.join(""), /FAILED Evals: candidate scored 0\.80, below incumbent 0\.90 − 0\.05/);
  assert.equal(active(), "qwen-old");
  assert.ok(system.running.has("dl-model-1"), "the incumbent kept serving");
  assert.equal(JSON.parse(system.files.get("/tmp/autopilot/config.json")!.content).providers.vllm.baseUrl, "http://127.0.0.1:8000/v1");
});

test("update without scores: a candidate that fails where the incumbent passed is kept out", async () => {
  const { options, exits, setEvals, active } = updateFixture();
  await modelCommand("up", ["qwen-old"], options);
  await setEvals();
  exits.candidate = 1;
  await assert.rejects(modelCommand("update", ["qwen-new"], options), /Evals: candidate's evals failed \(exit 1\); the incumbent's passed; qwen-old keeps serving/);
  assert.equal(active(), "qwen-old");
});

test("--skip-evals switches without running them; with no command set, update only hints", async () => {
  const { lines, options, calls, scores, setEvals, active } = updateFixture();
  await modelCommand("up", ["qwen-old"], options);
  assert.equal(await modelCommand("update", ["qwen-new"], options), 0);
  assert.match(lines.join(""), /Evals: none · dl evals set "COMMAND"/);
  await setEvals();
  scores.incumbent = 0.9; scores.candidate = 0.1;
  assert.equal(await modelCommand("update", ["qwen-old"], { ...options, skipEvals: true }), 0);
  assert.equal(calls.length, 0);
  assert.match(lines.join(""), /Evals: skipped \(--skip-evals\)/);
  assert.equal(active(), "qwen-old");
  await assert.rejects(modelCommand("rollback", [], { ...options, skipEvals: true }), /--skip-evals goes with dl model update/);
});

test("the real child process: the user's shell in the project folder, its env, output in the log, and a timeout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dl-evals-"));
  try {
    const log = join(dir, "run.log");
    const result = await realSpawn('echo "$OPENAI_BASE_URL $PWD"; exit 3', { cwd: dir, env: { OPENAI_BASE_URL: "http://127.0.0.1:9/v1" }, timeoutMs: 10_000, logPath: log });
    assert.deepEqual(result, { code: 3, timedOut: false });
    assert.match(await readFile(log, "utf8"), new RegExp(`http://127\\.0\\.0\\.1:9/v1 .*${dir.split("/").pop()}`));
    const started = Date.now();
    const slow = await realSpawn("sleep 20 & wait", { cwd: dir, env: {}, timeoutMs: 200, logPath: log });
    assert.equal(slow.timedOut, true);
    assert.ok(Date.now() - started < 5000, "the whole process group stopped");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A minimal zip (Inspect's .eval) with these files, deflated (8) or stored (0). */
function zip(files: Record<string, string>, method = 8): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text);
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(raw), 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
