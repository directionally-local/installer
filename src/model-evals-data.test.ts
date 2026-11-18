import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dataSummary, loadEvalData, parseCsv, parseDataFile, providerOverrides, rowsCsv, type DataSet, type Row } from "./model-evals-data.js";
import { evalsCommand } from "./model-evals.js";
import { writeDeployment, type ModelDeployment } from "./state.js";
import { FakeModelSystem } from "./test-support/fake-model-system.js";
import { fakePromptfoo } from "./test-support/fake-promptfoo.js";
import { PlainUi } from "./ui.js";

const FIXTURES = fileURLToPath(new URL("./test-support/fixtures/evals", import.meta.url));
const fixture = (name: string) => join(FIXTURES, name);
const load = async (name: string) => (await loadEvalData(fixture(name))).sets[0]!;
const rows = (set: DataSet): Row[] => { assert.equal(set.run.kind, "rows"); return set.run.kind === "rows" ? set.run.rows : []; };
const shape = (set: DataSet) => rows(set).map(({ input, expected, checks }) => ({ input, expected, ...(checks ? { checks } : {}) }));

test("JSONL rows with common keys are translated: question/prompt/input in, answer/expected/target as the expected answers", async () => {
  const set = await load("qa.jsonl");
  assert.equal(set.format, "JSONL");
  assert.equal(set.native, false);
  assert.deepEqual(set.notes, ["1 row without an input skipped", "1 row without an expected answer skipped"]);
  assert.deepEqual(shape(set), [
    { input: "What is the capital of France?", expected: ["Paris"] },
    { input: "2 + 2 = ?", expected: ["4"] },
    { input: "Name a primary colour.", expected: ["red", "blue", "yellow"] },
  ]);
  assert.deepEqual(rows(set).map((row) => row.source), ["qa.jsonl#1", "qa.jsonl#2 (math-1)", "qa.jsonl#3"]);
});

test("OpenAI Evals JSONL and chat transcripts keep their messages; the last assistant turn is the expected answer", async () => {
  const openai = await load("openai-evals.jsonl");
  assert.equal(openai.format, "OpenAI Evals JSONL");
  assert.deepEqual(shape(openai), [
    { input: [{ role: "system", content: "Answer with one word." }, { role: "user", content: "Capital of Japan?" }], expected: ["Tokyo"] },
    { input: [{ role: "user", content: "Largest planet?" }], expected: ["Jupiter", "jupiter"] },
  ]);
  const chat = await load("chat.jsonl");
  assert.equal(chat.format, "chat JSONL");
  assert.deepEqual(shape(chat), [{ input: [{ role: "system", content: "Be brief." }, { role: "user", content: "Opposite of hot?" }], expected: ["cold"] }]);
  assert.deepEqual(chat.notes, ["1 row without an expected answer skipped"], "a transcript with no assistant turn has nothing to check");
});

test("CSV and TSV rows are translated; their __expected cells are kept as written for promptfoo to read", async () => {
  const csv = await load("qa.csv");
  assert.equal(csv.format, "CSV");
  assert.deepEqual(shape(csv), [
    { input: "What is 3 x 3?", expected: ["9"] },
    { input: 'Quote: "to be"; who wrote it?', expected: ["Shakespeare"] },
    { input: "Multi\nline?", expected: ["yes"] },
  ]);
  const tsv = await load("rows.tsv");
  assert.equal(tsv.format, "TSV");
  assert.deepEqual(shape(tsv), [{ input: "Capital of Italy?", expected: undefined, checks: ["icontains: rome"] }, { input: "Give JSON", expected: undefined, checks: ["is-json"] }]);
  assert.deepEqual(parseCsv('a,b\r\n"x,y",""\r\n\r\n1,2'), [["a", "b"], ["x,y", ""], ["1", "2"]]);
});

test("Braintrust and LangSmith exports: the obvious field of input/inputs and expected/outputs", async () => {
  const braintrust = await load("braintrust.json");
  assert.equal(braintrust.format, "Braintrust JSON");
  assert.deepEqual(shape(braintrust), [{ input: "Who painted the Mona Lisa?", expected: ["Leonardo da Vinci"] }, { input: "Boiling point of water in Celsius?", expected: ["100"] }]);
  assert.deepEqual(rows(braintrust).map((row) => row.source), ["braintrust.json#1 (bt-1)", "braintrust.json#2 (bt-2)"]);
  const langsmith = await load("langsmith.jsonl");
  assert.equal(langsmith.format, "LangSmith JSONL");
  assert.deepEqual(shape(langsmith), [
    { input: "Speed of light in km/s, roughly?", expected: ["300000"] },
    { input: [{ role: "user", content: "What colour is the sky?" }], expected: ["blue"] },
  ]);
  const csv = await load("langsmith.csv");
  assert.equal(csv.format, "LangSmith CSV");
  assert.deepEqual(shape(csv), [{ input: "How many legs does a spider have?", expected: ["8"] }]);
});

test("promptfoo's own files go to promptfoo as is: a config, and test files with vars and __expected or assert", async () => {
  const config = await load("promptfoo/promptfooconfig.yaml");
  assert.deepEqual({ format: config.format, native: config.native, run: config.run, cases: config.cases }, { format: "promptfoo config (YAML)", native: true, run: { kind: "config", config: fixture("promptfoo/promptfooconfig.yaml") }, cases: undefined });
  assert.deepEqual(config.refs.map((path) => path.slice(FIXTURES.length + 1)), ["promptfoo/prompts.txt", "promptfoo/tests.csv"]);
  const csv = await load("promptfoo/tests.csv");
  assert.deepEqual({ format: csv.format, native: csv.native, run: csv.run, cases: csv.cases }, { format: "promptfoo tests CSV", native: true, run: { kind: "tests", prompt: "question", tests: fixture("promptfoo/tests.csv") }, cases: 2 });
  const dir = await mkdtemp(join(tmpdir(), "dl-pf-"));
  try {
    const parse = (name: string, text: string) => parseDataFile(join(dir, name), text);
    const tests = '[{"vars": {"q": "Capital of France?"}, "assert": [{"type": "icontains", "value": "paris"}]}]';
    assert.deepEqual((await parse("tests.json", tests)).run, { kind: "tests", prompt: "q", tests: join(dir, "tests.json") }, "the only var is the prompt");
    assert.deepEqual((await parse("tests.yaml", "- vars: { question: Hi?, tone: polite }\n  assert: [{ type: contains, value: Hi }]\n")).run,
      { kind: "tests", prompt: "question", tests: join(dir, "tests.yaml") }, "an input-like var is the prompt");
    assert.equal((await parse("tests.jsonl", '{"vars": {"prompt": "a"}}\n{"vars": {"prompt": "b"}}\n')).format, "promptfoo tests JSONL");
    // A JSON wrapper promptfoo wouldn't read as a tests file: dl puts the tests in its config.
    const wrapped = await parse("suite.json", `{"tests": ${tests}}`);
    assert.equal(wrapped.run.kind === "tests" && Array.isArray(wrapped.run.tests), true);
    await assert.rejects(parse("t.json", '[{"vars": {"a": "x", "b": "y"}}]'), /t\.json: promptfoo tests with vars a, b; dl can't tell which one is the prompt/);
    await assert.rejects(parse("t.json", '[{"vars": {"messages": [{"role": "user", "content": "x"}]}}]'), /the messages var holds a list or object/);
    await assert.rejects(parse("p.csv", "a,b,__expected\nx,y,z\n"), /p\.csv: promptfoo tests with vars a, b/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a promptfoo config may not pick its own provider for a test or an assertion: that could reach a hosted model", async () => {
  assert.deepEqual(providerOverrides({ providers: ["openai:gpt-4.1"], defaultTest: { options: { provider: "openai:gpt-4.1" } }, tests: [{ vars: { q: "x" } }] }), [],
    "providers and the default grader are dl's to set");
  assert.deepEqual(providerOverrides({ tests: [{ vars: {}, provider: "anthropic:claude" }, { assert: [{ type: "llm-rubric", value: "x", provider: "openai:gpt-4.1" }] }],
    defaultTest: { assert: [{ type: "factuality", provider: { id: "openai:gpt-4.1" } }] } }), ["tests[0].provider", "tests[1].assert[0].provider", "defaultTest.assert[0].provider"]);
  const dir = await mkdtemp(join(tmpdir(), "dl-pf-"));
  try {
    await writeFile(join(dir, "tests.yaml"), "- vars: { q: x }\n  assert: [{ type: llm-rubric, value: ok, provider: openai:gpt-4.1 }]\n");
    await assert.rejects(parseDataFile(join(dir, "promptfooconfig.yaml"), "prompts: ['{{q}}']\ntests: file://tests.yaml\n"),
      /promptfooconfig\.yaml: sets its own provider at tests\.yaml\[0\]\.assert\[0\]\.provider; dl runs and grades with your own models only/);
    await assert.rejects(parseDataFile(join(dir, "promptfooconfig.yaml"), "prompts: ['{{q}}']\ntests: [{ vars: { q: x }, options: { provider: openai:gpt-4.1 } }]\n"),
      /sets its own provider at tests\[0\]\.options\.provider/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a folder: every data file in it, a promptfoo config's own files once, anything else skipped and named", async () => {
  const data = await loadEvalData(FIXTURES);
  assert.deepEqual(data.sets.map((set) => set.path.slice(FIXTURES.length + 1)), ["braintrust.json", "chat.jsonl", "langsmith.csv", "langsmith.jsonl", "openai-evals.jsonl",
    "promptfoo/promptfooconfig.yaml", "qa.csv", "qa.jsonl", "rows.tsv"]);
  assert.equal(data.skipped.length, 1);
  assert.match(data.skipped[0]!, /^notes\.csv: not an eval dataset dl recognizes/);
  assert.deepEqual((await loadEvalData(join(FIXTURES, "*.jsonl"))).sets.map((set) => set.format), ["chat JSONL", "LangSmith JSONL", "OpenAI Evals JSONL", "JSONL"]);
  const summary = dataSummary(await loadEvalData(join(FIXTURES, "{qa.jsonl,promptfoo/*.yaml}")), FIXTURES);
  assert.deepEqual(summary, ["3 tests and 1 promptfoo config from 2 files, run with promptfoo",
    "promptfoo/promptfooconfig.yaml: promptfoo config (YAML), as is",
    "qa.jsonl: JSONL, 3 tests, translated (equals unless a value says contains:, factuality:...) (1 row without an input skipped; 1 row without an expected answer skipped)"]);
});

test("malformed or unknown files: one clear line", async () => {
  await assert.rejects(loadEvalData(fixture("notes.csv")), /^Error: notes\.csv: not an eval dataset dl recognizes; expected JSONL or JSON rows with input\/prompt\/question/);
  await assert.rejects(loadEvalData(fixture("nope.jsonl")), /No eval data at .*nope\.jsonl/);
  const dir = await mkdtemp(join(tmpdir(), "dl-bad-"));
  try {
    await writeFile(join(dir, "broken.jsonl"), '{"question": "a", "answer": "b"}\n{"question": "c",\n');
    await assert.rejects(loadEvalData(join(dir, "broken.jsonl")), /broken\.jsonl: line 2 is not JSON/);
    await writeFile(join(dir, "empty.jsonl"), "\n");
    await assert.rejects(loadEvalData(join(dir, "empty.jsonl")), /empty\.jsonl: empty; /);
    await writeFile(join(dir, "unchecked.jsonl"), '{"question": "a"}\n');
    await assert.rejects(loadEvalData(join(dir, "unchecked.jsonl")), /unchecked\.jsonl: no row has an expected answer to check/);
    await writeFile(join(dir, "package.json"), '{"name": "x", "version": "1.0.0"}');
    await assert.rejects(loadEvalData(join(dir, "package.json")), /package\.json: not an eval dataset/);
    await writeFile(join(dir, "config.yaml"), "a: [unclosed\n");
    await assert.rejects(loadEvalData(join(dir, "config.yaml")), /config\.yaml: not an eval dataset/);
    await assert.rejects(loadEvalData(dir), /No eval data dl recognizes in /);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("translated rows as promptfoo's test CSV: input, __expected cells promptfoo reads (equals unless they say otherwise), any of several answers", () => {
  const csv = rowsCsv([
    { input: "Capital of France?", expected: ["Paris"], source: "qa.jsonl#1" },
    { input: "Where is the Eiffel Tower?", expected: ["contains:Paris"], source: "qa.jsonl#2" },
    { input: [{ role: "system", content: "terse" }, { role: "user", content: 'Say "hi"' }], expected: ["Jupiter", "jupiter", "JUPITER"], source: "o.jsonl#1" },
    { input: '{"looks": "like JSON"}', checks: ["icontains: rome", "not-contains: Milan"], source: "r.tsv#1" },
  ]);
  const [header, ...cells] = parseCsv(csv);
  assert.deepEqual(header, ["input", "__expected1", "__expected2", "__expected3", "__threshold", "__description"]);
  assert.deepEqual(cells, [
    ["Capital of France?", "Paris", "", "", "", "qa.jsonl#1"],
    ["Where is the Eiffel Tower?", "contains:Paris", "", "", "", "qa.jsonl#2"],
    // Chat goes as JSON, which promptfoo's OpenAI provider sends as the messages; any one of three answers passes.
    ['[{"role":"system","content":"terse"},{"role":"user","content":"Say \\"hi\\""}]', "Jupiter", "jupiter", "JUPITER", "0.333333", "o.jsonl#1"],
    // Text that is JSON would be read as chat: it goes as one user message. __expected columns all must pass.
    ['[{"role":"user","content":"{\\"looks\\": \\"like JSON\\"}"}]', "icontains: rome", "not-contains: Milan", "", "", "r.tsv#1"],
  ]);
  assert.ok(0.333333 <= 1 / 3, "one right answer of three reaches the threshold");
});

test("dl evals set --data and run: the files are read when set, promptfoo runs per model, the first model judges, results stay in the logs", async () => {
  const system = new FakeModelSystem();
  const lines: string[] = [];
  const fake = fakePromptfoo(system, (_port, input) => (/France/.test(input) ? "Paris" : /2 \+ 2/.test(input) ? "5" : "red"));
  const options = { system, ui: new PlainUi((line) => lines.push(line)), statePath: "/state/model.json", cwd: FIXTURES, logDir: "/logs", promptfoo: fake.promptfoo };
  await assert.rejects(evalsCommand(["set"], { ...options, data: "notes.csv" }), /notes\.csv: not an eval dataset dl recognizes/);
  assert.ok(!system.files.has("/state/evals.json"), "nothing saved");
  assert.equal(await evalsCommand(["set"], { ...options, data: "qa.jsonl" }), 0);
  assert.deepEqual({ ...JSON.parse(system.files.get("/state/evals.json")!.content), setAt: "" }, { version: 1, data: fixture("qa.jsonl"), dir: FIXTURES, setAt: "" });
  let out = lines.join("");
  assert.match(out, /Data: .*qa\.jsonl \(run with promptfoo 0\.125\.1/);
  assert.match(out, /Data: 3 tests from 1 file, run with promptfoo\n-- Data: qa\.jsonl: JSONL, 3 tests, translated/);
  assert.equal(fake.ensured(), 0, "set doesn't download promptfoo");
  await writeDeployment(system, "default", { active: deployment("qwen", 8000) }, "/state/model.json");
  await writeDeployment(system, "small", { active: deployment("small", 8002) }, "/state/model.json");
  system.running.add("dl-model-8000").add("dl-model-8002");
  lines.length = 0;
  assert.equal(await evalsCommand(["run"], options), 0, "a data run passes when the model answered; the score says how well");
  out = lines.join("");
  assert.match(out, /Judge: qwen grades model-graded checks \(llm-rubric, factuality\.\.\.\) for every model/);
  assert.match(out, /qwen +pass +0\.67[\s\S]*small \(small\) +pass +0\.67/);
  assert.match(out, /Results \(default\): data: 2 of 3 passed/);
  assert.match(out, /Failed \(default\): qa\.jsonl#2 \(math-1\): "2 \+ 2 = \?" · equals "4" · got "5"/);
  assert.deepEqual(fake.calls.map((call) => [call.provider.config.apiBaseUrl, call.grader.config.apiBaseUrl]),
    [["http://127.0.0.1:8000/v1", "http://127.0.0.1:8000/v1"], ["http://127.0.0.1:8002/v1", "http://127.0.0.1:8000/v1"]]);
  const resultsPath = /promptfoo results \(default\): (\S+)/.exec(out)![1]!;
  assert.match(resultsPath, /^\/logs\/.*-evals-default\.json$/);
  assert.match(out, /Log \(default\): \/logs\/.*-evals-default-promptfoo\/promptfoo\.log/);
  assert.equal(JSON.parse(system.files.get(resultsPath)!.content).results.stats.successes, 2);
  // A command and data together; --data "" takes the data off again.
  assert.equal(await evalsCommand(["set", "make evals"], options), 0);
  lines.length = 0;
  await evalsCommand(["show"], options);
  assert.match(lines.join(""), /Command: make evals[\s\S]*Data: [\s\S]*Both: both must pass; the score is the mean of the two/);
  assert.equal(await evalsCommand(["set"], { ...options, data: "" }), 0);
  assert.equal(JSON.parse(system.files.get("/state/evals.json")!.content).data, undefined);
  await assert.rejects(evalsCommand(["run"], { ...options, data: "x" }), /--threshold, --results and --data go with dl evals set/);
});

test("a data run where no case got an answer fails, and says why", async () => {
  const system = new FakeModelSystem();
  const lines: string[] = [];
  const fake = fakePromptfoo(system, () => new Error("API call error: connect ECONNREFUSED 127.0.0.1:8000"));
  const options = { system, ui: new PlainUi((line) => lines.push(line)), statePath: "/state/model.json", cwd: FIXTURES, logDir: "/logs", promptfoo: fake.promptfoo };
  await evalsCommand(["set"], { ...options, data: "openai-evals.jsonl" });
  await writeDeployment(system, "default", { active: deployment("qwen", 8000) }, "/state/model.json");
  system.running.add("dl-model-8000");
  assert.equal(await evalsCommand(["run"], options), 1);
  assert.match(lines.join(""), /qwen +fail \(no answers\) +–/);
  assert.match(lines.join(""), /data: no answers: API call error: connect ECONNREFUSED 127\.0\.0\.1:8000/);
});

function deployment(id: string, port: number): ModelDeployment {
  return { id, repo: "Qwen/Qwen3-8B", container: `dl-model-${port}`, port, context: 8192, image: "vllm/vllm-openai:v0.33.0", flags: [], minVramMiB: 1,
    lastTest: { chat: true, tools: true, json: true, tokensPerSecond: 1, at: "" } };
}
