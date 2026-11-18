import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadEvalData, parseDataFile } from "./model-evals-data.js";
import { dataRunSummary, dataScore, failureLines, generatedConfig, graderConfig, looseMatchHint, noAnswers, nodeTooOld, promptfooArgs, promptfooDir, promptfooEnv,
  promptfooOutcome, providerConfig, realPromptfoo, runPromptfooData, spawnLogged, type DataRunOutput, type PromptfooOutcome } from "./model-evals-promptfoo.js";
import { FakeModelSystem } from "./test-support/fake-model-system.js";
import { fakePromptfoo } from "./test-support/fake-promptfoo.js";
import { RealSystem } from "./system.js";

const FIXTURE = fileURLToPath(new URL("./test-support/fixtures/promptfoo-output.json", import.meta.url));
const qwen = { id: "qwen-new", repo: "Qwen/Qwen3-8B", port: 8001, host: "127.0.0.1" };
const judge = { id: "qwen-old", repo: "Qwen/Qwen3-4B", port: 8000, host: "127.0.0.1" };

test("the provider: promptfoo's OpenAI provider at the deployment's endpoint, temperature 0, thinking off and not part of the answer", () => {
  assert.deepEqual(providerConfig(qwen), {
    id: "openai:chat:Qwen/Qwen3-8B",
    label: "qwen-new",
    config: { apiBaseUrl: "http://127.0.0.1:8001/v1", apiKey: "dl-local", temperature: 0, max_tokens: 1024, showThinking: false, passthrough: { chat_template_kwargs: { enable_thinking: false } } },
    transform: "typeof output === 'string' ? output.replace(/<think>[\\s\\S]*?(<\\/think>|$)/g, '').trim() : output",
  });
  // The transform is a JavaScript expression promptfoo evaluates with `output` in scope.
  const strip = new Function("output", `return ${String(providerConfig(qwen).transform)}`) as (output: unknown) => unknown;
  assert.equal(strip("<think>hmm</think>\n\nParis"), "Paris");
  assert.deepEqual(strip([{ tool: 1 }]), [{ tool: 1 }]);
  // The grader is the judge's own endpoint, with room for its reasoning.
  const grader = graderConfig(judge);
  assert.equal(grader.id, "openai:chat:Qwen/Qwen3-4B");
  assert.deepEqual((grader.config as Record<string, unknown>).apiBaseUrl, "http://127.0.0.1:8000/v1");
  assert.deepEqual((grader.config as Record<string, unknown>).max_tokens, 2048);
});

test("promptfoo's environment: no provider keys or base URLs from the shell, telemetry, updates and sharing off, its state in dl's folder", () => {
  const env = promptfooEnv("/logs/run-promptfoo/promptfoo-home", {
    PATH: "/usr/bin", HOME: "/home/me", LC_ALL: "C.UTF-8", VIRTUAL_ENV: "/home/me/.venv",
    OPENAI_API_KEY: "sk-live", OPENAI_BASE_URL: "https://api.openai.com/v1", ANTHROPIC_API_KEY: "sk-ant", AZURE_OPENAI_API_KEY: "x", AWS_SECRET_ACCESS_KEY: "y",
    GOOGLE_API_KEY: "z", OPENROUTER_API_KEY: "w", PROMPTFOO_REMOTE_API_BASE_URL: "https://api.promptfoo.app", HTTPS_PROXY: "http://proxy",
  });
  assert.deepEqual(env, {
    PATH: "/usr/bin", HOME: "/home/me", LC_ALL: "C.UTF-8", VIRTUAL_ENV: "/home/me/.venv",
    PROMPTFOO_CONFIG_DIR: "/logs/run-promptfoo/promptfoo-home", PROMPTFOO_DISABLE_TELEMETRY: "1", PROMPTFOO_DISABLE_UPDATE: "1", PROMPTFOO_DISABLE_SHARING: "1",
    PROMPTFOO_DISABLE_REMOTE_GENERATION: "1", PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION: "1", PROMPTFOO_SELF_HOSTED: "1", PROMPTFOO_CACHE_ENABLED: "false", NO_COLOR: "1",
  });
});

test("promptfoo eval's arguments: the config, dl's provider in place of the config's, dl's grader, JSON out, no cache, nothing written or shared", () => {
  assert.deepEqual(promptfooArgs("/p/promptfooconfig.yaml", "/w/provider.json", "/w/grader.json", "/logs/x.json"), ["eval", "-c", "/p/promptfooconfig.yaml",
    "-r", "file:///w/provider.json", "--grader", "file:///w/grader.json", "-o", "/logs/x.json", "--no-cache", "--no-progress-bar", "--no-table", "--no-write", "--no-share", "-j", "4"]);
});

test("the config dl writes: one prompt from the input var, the tests as is or as dl's CSV; a promptfoo config gets none", async () => {
  const rows = (await loadEvalData(fileURLToPath(new URL("./test-support/fixtures/evals/qa.jsonl", import.meta.url)))).sets[0]!;
  assert.deepEqual(generatedConfig(rows, "/w/tests.csv"), { description: `dl evals: ${rows.path}`, prompts: [{ raw: "{{ input }}", label: "input" }], tests: "file:///w/tests.csv" });
  const native = await parseDataFile("/p/tests.csv", "question,__expected\nCapital of France?,Paris\n");
  assert.deepEqual(generatedConfig(native), { description: "dl evals: /p/tests.csv", prompts: [{ raw: "{{ question }}", label: "question" }], tests: "file:///p/tests.csv" });
  const config = await parseDataFile("/p/promptfooconfig.yaml", "prompts: ['{{q}}']\ntests: [{ vars: { q: x } }]\n");
  assert.throws(() => generatedConfig(config), /runs as is/);
});

/** promptfoo 0.125.1's real `-o` output (see the fixture's notes in the PR): 9 translated rows against a fake endpoint. */
async function captured(): Promise<PromptfooOutcome> {
  return promptfooOutcome(JSON.parse(await readFile(FIXTURE, "utf8")))!;
}

test("promptfoo's JSON output: counts, the score, the first failing cases one line each, and errors", async () => {
  const outcome = await captured();
  assert.deepEqual({ successes: outcome.successes, failures: outcome.failures, errors: outcome.errors, results: outcome.results.length, prompts: outcome.prompts },
    { successes: 5, failures: 3, errors: 1, results: 9, prompts: 1 });
  const run: DataRunOutput = { outcomes: [outcome], results: ["/logs/x.json"], logPath: "/logs/x-promptfoo/promptfoo.log", timedOut: false, errors: [] };
  assert.equal(dataScore(run), 5 / 9);
  assert.equal(dataRunSummary(run), "5 of 9 passed · 1 error");
  assert.equal(noAnswers(run), undefined);
  assert.deepEqual(failureLines([outcome], 3), [
    'qa.jsonl#1: "What is the capital of France?" · equals "Paris" · got "The capital of France is Paris."',
    'qa.jsonl#4 (math-1): "2 + 2 = ?" · equals "4" · got "5"',
    'qa.jsonl#7: "crash please" · error: API error: 500 Internal Server Error {"error":{"message":"engine crashed"}}',
    "and 1 more in the results file",
  ]);
  // Passed in that run: contains:, factuality: and llm-rubric: (graded by the judge), chat, an answer after a <think> block, any of several answers.
  assert.deepEqual(outcome.results.filter((result) => result.success).map((result) => result.testCase?.description).sort(), ["qa.jsonl#2", "qa.jsonl#3", "qa.jsonl#5", "qa.jsonl#6", "qa.jsonl#8"]);
  // The same file is what the command path reads as promptfoo JSON.
  const { parseResultFile } = await import("./model-evals.js");
  assert.deepEqual(parseResultFile("out.json", await readFile(FIXTURE)), { score: 5 / 9, detail: "promptfoo: 5 of 9 passed" });
});

test("the hint: most failures are exact-match misses whose answer has the expected text in it; never with fewer", async () => {
  const outcome = await captured();
  assert.equal(looseMatchHint([outcome]), "2 of 3 failures are exact-match misses whose answer contains the expected text; to accept those, write contains:Paris or factuality:... in your data "
    + "(https://www.promptfoo.dev/docs/configuration/expected-outputs/)");
  const withoutOne = { ...outcome, results: outcome.results.filter((result) => result.testCase?.description !== "qa.jsonl#9") };
  assert.equal(looseMatchHint([withoutOne]), undefined, "1 of 2 is not most");
});

test("no answers: every case errored, so the run fails and says why", () => {
  const error = { success: false, failureReason: 2, error: "API call error: connect ECONNREFUSED 127.0.0.1:8001", testCase: { description: "q#1" }, prompt: { raw: "x" } };
  const run: DataRunOutput = { outcomes: [{ successes: 0, failures: 0, errors: 2, results: [error, error], prompts: 1 }], results: [], logPath: "", timedOut: false, errors: [] };
  assert.equal(noAnswers(run), "API call error: connect ECONNREFUSED 127.0.0.1:8001");
  assert.equal(noAnswers({ ...run, outcomes: [], errors: ["/p/qa.jsonl: promptfoo exited 1 without results (see /l)"] }), "/p/qa.jsonl: promptfoo exited 1 without results (see /l)");
});

test("one model's run: dl's provider and the judge's grader written once, each file its config, promptfoo's output read back; the time limit stops later files", async () => {
  const system = new FakeModelSystem();
  const dir = await mkdtemp(join(tmpdir(), "dl-pf-run-"));
  try {
    await writeFile(join(dir, "qa.jsonl"), '{"question": "Capital of France?", "answer": "Paris"}\n{"question": "Capital of Peru?", "answer": "Lima"}\n');
    await writeFile(join(dir, "promptfooconfig.yaml"), "prompts: ['{{q}}']\ntests: [{ vars: { q: x } }]\n");
    const { sets } = await loadEvalData(join(dir, "qa.jsonl"));
    const fake = fakePromptfoo(system, (_port, input) => (input.includes("France") ? "Paris" : "Cusco"));
    const said: string[] = [];
    let clock = 1000;
    const input = { system, promptfoo: fake.promptfoo, sets, deployment: qwen, judge, workDir: "/logs/r-promptfoo", outPrefix: "/logs/r", deadline: 61_000, now: () => clock, say: (text: string) => said.push(text),
      env: { PATH: "/bin", OPENAI_API_KEY: "sk-live" } };
    const run = await runPromptfooData(input);
    assert.deepEqual({ results: run.results, logPath: run.logPath, errors: run.errors, timedOut: run.timedOut }, { results: ["/logs/r.json"], logPath: "/logs/r-promptfoo/promptfoo.log", errors: [], timedOut: false });
    assert.equal(dataRunSummary(run), "1 of 2 passed");
    const [call] = fake.calls;
    assert.equal(call!.provider.config.apiBaseUrl, "http://127.0.0.1:8001/v1");
    assert.equal(call!.grader.config.apiBaseUrl, "http://127.0.0.1:8000/v1");
    assert.equal(call!.env.OPENAI_API_KEY, undefined, "no key from the shell");
    assert.equal(call!.cwd, "/logs/r-promptfoo", "not the project folder: promptfoo would load its .env");
    assert.equal(call!.timeoutMs, 60_000);
    assert.deepEqual(JSON.parse(system.files.get("/logs/r-promptfoo/promptfooconfig.json")!.content).tests, "file:///logs/r-promptfoo/tests.csv");
    assert.match(system.files.get("/logs/r-promptfoo/promptfoo.log")!.content, /^\$ promptfoo eval -c \/logs\/r-promptfoo\/promptfooconfig\.json -r file:\/\/\/logs\/r-promptfoo\/provider\.json/);
    // Two files: one output each; a config runs from where it is. Past the deadline, nothing more starts.
    const both = (await loadEvalData(dir)).sets;
    assert.deepEqual(both.map((set) => set.run.kind), ["config", "rows"]);
    const runs: string[][] = [];
    const recording = { ...fake.promptfoo, run: async (entry: string, args: readonly string[], options: Parameters<typeof fake.promptfoo.run>[2]) => { runs.push([...args]); clock += 70_000; return fake.promptfoo.run(entry, args, options).catch(() => ({ code: 1, timedOut: false })); } };
    const late = await runPromptfooData({ ...input, promptfoo: recording, sets: both, outPrefix: "/logs/s", workDir: "/logs/s-promptfoo" });
    assert.equal(runs.length, 1);
    assert.equal(runs[0]![2], join(dir, "promptfooconfig.yaml"));
    assert.equal(late.timedOut, true);
    assert.deepEqual(late.errors.map((line) => line.replace(dir, "DIR")), ["DIR/promptfooconfig.yaml: promptfoo exited 1 without results (see /logs/s-promptfoo/promptfoo-1.log)",
      "DIR/qa.jsonl: not run, the time limit was reached"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("promptfoo is fetched once into dl's cache with npm --ignore-scripts; Node too old, offline and no npm each say so in one line", async () => {
  assert.equal(promptfooDir({ HOME: "/home/me" }), "/home/me/.cache/directionallylocal/promptfoo-0.125.1");
  assert.equal(promptfooDir({ HOME: "/home/me", XDG_CACHE_HOME: "/var/cache/me" }), "/var/cache/me/directionallylocal/promptfoo-0.125.1");
  assert.equal(nodeTooOld("v22.22.0"), undefined);
  assert.equal(nodeTooOld("24.1.0"), undefined);
  assert.equal(nodeTooOld("v22.21.1"), "dl evals runs promptfoo 0.125.1, which needs Node 22.22.0 or newer; this is Node 22.21.1. Update Node and run it again.");
  const dir = await mkdtemp(join(tmpdir(), "dl-pf-cache-"));
  try {
    const target = join(dir, "promptfoo-0.125.1");
    const said: string[] = [];
    const npmCalls: string[][] = [];
    const installing = async (args: readonly string[]) => {
      npmCalls.push([...args]);
      const entry = join(args[2]!, "node_modules", "promptfoo", "dist", "src", "entrypoint.js");
      await mkdir(dirname(entry), { recursive: true });
      await writeFile(entry, "");
      return { code: 0, output: "" };
    };
    const promptfoo = realPromptfoo({ dir: target, nodeVersion: "24.22.3", npm: installing });
    const entry = await promptfoo.ensure((text) => said.push(text));
    assert.equal(entry, join(target, "node_modules", "promptfoo", "dist", "src", "entrypoint.js"));
    assert.deepEqual(npmCalls, [["install", "--prefix", `${target}.partial-${process.pid}`, "promptfoo@0.125.1", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"]]);
    assert.deepEqual(said, [`first use: downloading promptfoo 0.125.1 from npm into ${target} (once, a few hundred MB)`]);
    await promptfoo.ensure((text) => said.push(text));
    assert.equal(npmCalls.length, 1, "cached after the first time");
    const fresh = join(dir, "fresh");
    await assert.rejects(realPromptfoo({ dir: fresh, nodeVersion: "20.18.0", npm: installing }).ensure(() => {}), /needs Node 22\.22\.0 or newer; this is Node 20\.18\.0/);
    await assert.rejects(realPromptfoo({ dir: fresh, nodeVersion: "24.22.3", npm: async () => ({ code: 1, output: "npm error code EAI_AGAIN\nnpm error request to https://registry.npmjs.org/promptfoo failed" }) }).ensure(() => {}),
      /^Error: Can't download promptfoo 0\.125\.1: npm can't reach its registry \(offline\?\)\. dl evals needs it once; connect and run it again\.$/);
    await assert.rejects(realPromptfoo({ dir: fresh, nodeVersion: "24.22.3", npm: async () => ({ code: 1, output: "npm error code E404\nnpm error 404 Not Found - promptfoo@0.125.1" }) }).ensure(() => {}),
      /npm install failed: npm error 404 Not Found - promptfoo@0\.125\.1/);
    await assert.rejects(realPromptfoo({ dir: fresh, nodeVersion: "24.22.3", npm: async () => { throw Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" }); } }).ensure(() => {}),
      /dl evals needs npm to download promptfoo 0\.125\.1 once/);
    await assert.rejects(readFile(join(fresh, "node_modules", "promptfoo", "package.json")), "a failed download leaves nothing behind");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the child gets only the environment dl gives it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dl-pf-env-"));
  try {
    const log = join(dir, "out.log");
    process.env.DL_TEST_SECRET = "leak";
    const result = await spawnLogged("/bin/sh", ["-c", 'echo "[$DL_TEST_SECRET][$PROMPTFOO_DISABLE_TELEMETRY]"'], { cwd: dir, env: { PATH: process.env.PATH!, PROMPTFOO_DISABLE_TELEMETRY: "1" }, timeoutMs: 10_000, logPath: log });
    assert.deepEqual(result, { code: 0, timedOut: false });
    assert.equal((await readFile(log, "utf8")).trim(), "[][1]");
  } finally { delete process.env.DL_TEST_SECRET; await rm(dir, { recursive: true, force: true }); }
});

/**
 * The real promptfoo against a fake OpenAI-compatible server. Needs promptfoo 0.125.1 installed
 * (DL_TEST_PROMPTFOO_DIR: a folder with node_modules/promptfoo, as dl's cache has it), so it
 * stays out of CI, which doesn't download it.
 */
test("integration: the pinned promptfoo against a local fake model, graded by a local judge", { skip: !process.env.DL_TEST_PROMPTFOO_DIR && "set DL_TEST_PROMPTFOO_DIR to run" }, async () => {
  const requests: Array<{ auth?: string; body: { model: string; messages: Array<{ role: string; content: string }>; [key: string]: unknown } }> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let text = "";
    req.on("data", (chunk) => { text += chunk; });
    req.on("end", () => {
      const body = JSON.parse(text) as (typeof requests)[number]["body"];
      requests.push({ ...(req.headers.authorization ? { auth: req.headers.authorization } : {}), body });
      const all = body.messages.map((message) => message.content).join("\n");
      const last = body.messages.at(-1)!.content;
      const message: Record<string, string> = {};
      if (body.model === "Judge/Model") message.content = /factual/i.test(all) ? "(A) The submitted answer is a subset of the expert answer and is fully consistent with it." : JSON.stringify({ reason: "ok", pass: true, score: 1 });
      else if (/capital of France/i.test(last)) message.content = "The capital of France is Paris.";
      else if (/Opposite of hot/.test(last)) message.content = "<think>hot... cold</think>\n\ncold";
      else if (/Largest planet/.test(last)) { message.content = "Jupiter"; message.reasoning_content = "planets"; }
      else message.content = "red";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: "stop" }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const dir = await mkdtemp(join(tmpdir(), "dl-pf-real-"));
  try {
    await writeFile(join(dir, "qa.jsonl"), [
      { question: "What is the capital of France?", answer: "Paris" },
      { question: "What is the capital of France?", answer: "contains:Paris" },
      { question: "What is the capital of France?", answer: "factuality:Paris is the capital of France" },
      { question: "Name a primary colour.", answer: "llm-rubric:names a primary colour" },
      { messages: [{ role: "user", content: "Opposite of hot?" }, { role: "assistant", content: "cold" }] },
      { input: [{ role: "user", content: "Largest planet?" }], ideal: ["Jupiter", "jupiter"] },
    ].map((row) => JSON.stringify(row)).join("\n"));
    const { sets } = await loadEvalData(join(dir, "qa.jsonl"));
    const run = await runPromptfooData({ system: new RealSystem(() => {}), promptfoo: realPromptfoo({ dir: process.env.DL_TEST_PROMPTFOO_DIR! }), sets,
      deployment: { id: "qwen", repo: "Qwen/Qwen3-8B", port, host: "127.0.0.1" }, judge: { id: "judge", repo: "Judge/Model", port, host: "127.0.0.1" },
      workDir: join(dir, "run-promptfoo"), outPrefix: join(dir, "run"), deadline: Date.now() + 120_000, now: Date.now, say: () => {},
      env: { ...process.env, OPENAI_API_KEY: "sk-must-not-be-used" } });
    assert.deepEqual(run.errors, []);
    assert.equal(dataRunSummary(run), "5 of 6 passed");
    assert.deepEqual(failureLines(run.outcomes), ['qa.jsonl#1: "What is the capital of France?" · equals "Paris" · got "The capital of France is Paris."']);
    assert.ok(requests.every((request) => request.auth === "Bearer dl-local"), "the placeholder key, never the shell's");
    assert.deepEqual([...new Set(requests.map((request) => request.body.model))].sort(), ["Judge/Model", "Qwen/Qwen3-8B"], "graded by the judge, nothing else");
    assert.deepEqual(requests.find((request) => request.body.model === "Qwen/Qwen3-8B")!.body.chat_template_kwargs, { enable_thinking: false });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
