import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkAssertion, dataRunSummary, expectedAssertion, failureLines, loadEvalData, matchesExpected, parseCsv, parseDataFile, renderTemplate, runDataCases, scoreCase,
  type EvalCase } from "./model-evals-data.js";
import { evalsCommand } from "./model-evals.js";
import { writeDeployment, type ModelDeployment } from "./state.js";
import { FakeModelSystem } from "./test-support/fake-model-system.js";
import { PlainUi } from "./ui.js";

const FIXTURES = fileURLToPath(new URL("./test-support/fixtures/evals", import.meta.url));
const fixture = (name: string) => join(FIXTURES, name);
const load = async (name: string) => (await loadEvalData(fixture(name))).sets[0]!;
const inputs = (cases: EvalCase[]) => cases.map((item) => item.input);

test("JSONL with common keys: question/prompt/input, answer/expected/target; rows with no input are skipped", async () => {
  const set = await load("qa.jsonl");
  assert.equal(set.format, "JSONL");
  assert.deepEqual(set.notes, ["1 row without an input skipped"]);
  assert.deepEqual(set.cases.map(({ input, expected }) => ({ input, expected })), [
    { input: "What is the capital of France?", expected: ["Paris"] },
    { input: "2 + 2 = ?", expected: ["4"] },
    { input: "Name a primary colour.", expected: ["red", "blue", "yellow"] },
    { input: "Say anything.", expected: undefined },
  ]);
  assert.equal(set.cases[1]!.metadata.id, "math-1");
  assert.equal(set.cases[0]!.metadata.row, 1);
});

test("OpenAI Evals JSONL and chat transcripts keep their messages", async () => {
  const openai = await load("openai-evals.jsonl");
  assert.equal(openai.format, "OpenAI Evals JSONL");
  assert.deepEqual(openai.cases[0]!.input, [{ role: "system", content: "Answer with one word." }, { role: "user", content: "Capital of Japan?" }]);
  assert.deepEqual(openai.cases[1]!.expected, ["Jupiter", "jupiter"]);
  const chat = await load("chat.jsonl");
  assert.equal(chat.format, "chat JSONL");
  // The last assistant message is the expected answer to the ones before it.
  assert.deepEqual(chat.cases[0], { input: [{ role: "system", content: "Be brief." }, { role: "user", content: "Opposite of hot?" }], expected: ["cold"], metadata: { row: 1 } });
  assert.deepEqual(chat.cases[1]!.input, [{ role: "user", content: "Say hi." }], "text parts are joined");
});

test("CSV and TSV with a header, quoted cells, and promptfoo's __expected columns", async () => {
  const csv = await load("qa.csv");
  assert.equal(csv.format, "CSV");
  assert.deepEqual(inputs(csv.cases), ["What is 3 x 3?", 'Quote: "to be"; who wrote it?', "Multi\nline?"]);
  assert.deepEqual(csv.cases[1]!.expected, ["Shakespeare"]);
  const tsv = await load("rows.tsv");
  assert.equal(tsv.format, "TSV");
  assert.deepEqual(tsv.cases.map((item) => item.assertions), [[{ type: "icontains", value: "rome" }], [{ type: "is-json" }]]);
  assert.deepEqual(parseCsv('a,b\r\n"x,y",""\r\n\r\n1,2'), [["a", "b"], ["x,y", ""], ["1", "2"]]);
});

test("Braintrust and LangSmith exports: the obvious field of input/inputs and expected/outputs", async () => {
  const braintrust = await load("braintrust.json");
  assert.equal(braintrust.format, "Braintrust JSON");
  assert.deepEqual(braintrust.cases.map(({ input, expected, metadata }) => ({ input, expected, id: metadata.id, split: metadata.split })), [
    { input: "Who painted the Mona Lisa?", expected: ["Leonardo da Vinci"], id: "bt-1", split: "test" },
    { input: "Boiling point of water in Celsius?", expected: ["100"], id: "bt-2", split: undefined },
  ]);
  const langsmith = await load("langsmith.jsonl");
  assert.equal(langsmith.format, "LangSmith JSONL");
  assert.deepEqual(langsmith.cases.map(({ input, expected }) => ({ input, expected })), [
    { input: "Speed of light in km/s, roughly?", expected: ["300000"] },
    { input: [{ role: "user", content: "What colour is the sky?" }], expected: ["blue"] },
  ]);
  const csv = await load("langsmith.csv");
  assert.equal(csv.format, "LangSmith CSV");
  assert.deepEqual(csv.cases.map(({ input, expected }) => ({ input, expected })), [{ input: "How many legs does a spider have?", expected: ["8"] }]);
});

test("promptfoo YAML: prompts (a file of several, inline) × tests (inline and a CSV), defaultTest and vars in assertions", async () => {
  const set = await load("promptfoo/promptfooconfig.yaml");
  assert.equal(set.format, "promptfoo YAML");
  assert.deepEqual(set.notes, ["3 prompts × 4 tests"]);
  assert.equal(set.cases.length, 12);
  assert.deepEqual(inputs(set.cases.slice(0, 3)), ["You are a geography quiz. What is the capital of France?", "Answer briefly: What is the capital of France?",
    "Reply in one word: What is the capital of France?"]);
  assert.deepEqual(set.cases[0]!.assertions, [{ type: "not-icontains", value: "as an ai" }, { type: "icontains", value: "paris" },
    { type: "llm-rubric", value: "mentions the Eiffel Tower" }, { type: "javascript", value: "output.length < 100" }]);
  assert.equal(set.cases[0]!.metadata.id, "france");
  assert.deepEqual(set.cases[9]!.assertions, [{ type: "not-icontains", value: "as an ai" }, { type: "equals", value: "Lima" }, { type: "llm-rubric", value: "is correct" }]);
  assert.deepEqual(set.refs.map((path) => path.slice(FIXTURES.length + 1)), ["promptfoo/prompts.txt", "promptfoo/tests.csv"]);
  // A JSON chat prompt is filled message by message, so quotes in vars don't break it.
  const dir = await mkdtemp(join(tmpdir(), "dl-pf-"));
  try {
    await writeFile(join(dir, "chat.json"), JSON.stringify([{ role: "system", content: "Be terse." }, { role: "user", content: "{{ q }}" }]));
    const json = await parseDataFile(join(dir, "promptfooconfig.yaml"), 'prompts: ["file://chat.json"]\ntests:\n  - vars: { q: \'Say "hi"\' }\n    assert: [{ type: equals, value: hi }]\n');
    assert.deepEqual(json.cases[0]!.input, [{ role: "system", content: "Be terse." }, { role: "user", content: 'Say "hi"' }]);
    await assert.rejects(parseDataFile(join(dir, "promptfooconfig.yaml"), "prompts: [file://missing.txt]\ntests: [{vars: {a: 1}}]\n"), /promptfooconfig\.yaml: can't read missing\.txt/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a folder: every data file in it, the promptfoo config's own files once, anything else skipped and named", async () => {
  const data = await loadEvalData(FIXTURES);
  assert.deepEqual(data.sets.map((set) => set.path.slice(FIXTURES.length + 1)), ["braintrust.json", "chat.jsonl", "langsmith.csv", "langsmith.jsonl", "openai-evals.jsonl",
    "promptfoo/promptfooconfig.yaml", "qa.csv", "qa.jsonl", "rows.tsv"]);
  assert.equal(data.skipped.length, 1);
  assert.match(data.skipped[0]!, /^notes\.csv: not an eval dataset dl recognizes/);
  // A glob too.
  assert.deepEqual((await loadEvalData(join(FIXTURES, "*.jsonl"))).sets.map((set) => set.format), ["chat JSONL", "LangSmith JSONL", "OpenAI Evals JSONL", "JSONL"]);
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
    await writeFile(join(dir, "package.json"), '{"name": "x", "version": "1.0.0"}');
    await assert.rejects(loadEvalData(join(dir, "package.json")), /package\.json: not an eval dataset/);
    await writeFile(join(dir, "config.yaml"), "a: [unclosed\n");
    await assert.rejects(loadEvalData(join(dir, "config.yaml")), /config\.yaml: not an eval dataset/);
    await assert.rejects(loadEvalData(dir), /No eval data dl recognizes in /);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("assertions: supported types and their not- variants; others are skipped, never passed", () => {
  const check = (type: string, value: unknown, output: string) => checkAssertion({ type, value }, output)?.ok;
  assert.equal(check("equals", "Paris", " Paris\n"), true);
  assert.equal(check("equals", "Paris", "paris"), false);
  assert.equal(check("equals", { a: 1 }, '```json\n{"a": 1}\n```'), true);
  assert.equal(check("contains", "Paris", "It is Paris."), true);
  assert.equal(check("not-contains", "Lyon", "It is Paris."), true);
  assert.equal(check("icontains", "PARIS", "it is paris"), true);
  assert.equal(check("not-icontains", "as an ai", "As an AI, I"), false);
  assert.equal(check("contains-any", ["Rome", "Paris"], "Paris"), true);
  assert.equal(check("contains-all", "a,b", "a only"), false);
  assert.equal(check("icontains-all", ["A", "B"], "a and b"), true);
  assert.equal(check("icontains-any", ["X"], "y"), false);
  assert.equal(check("regex", "^\\d+$", "42"), true);
  assert.equal(check("not-regex", "\\d", "none"), true);
  assert.deepEqual(checkAssertion({ type: "regex", value: "(" }, "x"), { ok: false, reason: "regex ( is not a valid regular expression" });
  assert.equal(check("starts-with", "Yes", "Yes, it is."), true);
  assert.equal(check("is-json", undefined, '{"ok": true}'), true);
  assert.equal(check("is-json", undefined, 'Sure: {"ok": true}'), false);
  assert.equal(check("contains-json", undefined, 'Sure: {"ok": true} done'), true);
  assert.equal(check("not-contains-json", undefined, "no json"), true);
  for (const type of ["llm-rubric", "javascript", "python", "similar", "not-llm-rubric"]) assert.equal(checkAssertion({ type, value: "x" }, "y"), undefined, type);
  // promptfoo's __expected syntax.
  assert.deepEqual(expectedAssertion("contains: Berlin"), { type: "contains", value: "Berlin" });
  assert.deepEqual(expectedAssertion("not-icontains:x"), { type: "not-icontains", value: "x" });
  assert.deepEqual(expectedAssertion("grade: is polite"), { type: "llm-rubric", value: "is polite" });
  assert.deepEqual(expectedAssertion("fn: output.length > 3"), { type: "javascript", value: "output.length > 3" });
  assert.deepEqual(expectedAssertion("similar(0.8): hi"), { type: "similar", value: "hi" });
  assert.deepEqual(expectedAssertion("is-json"), { type: "is-json" });
  assert.deepEqual(expectedAssertion("answer: 42"), { type: "equals", value: "answer: 42" }, "an unknown prefix is part of the answer");
  assert.equal(renderTemplate("{{q}} / {{ a.b }} / {{ obj | dump }} / {{ missing }}", { q: "x", a: { b: 2 }, obj: { k: 1 } }), 'x / 2 / {"k":1} / ');
});

test("scoring: assertions first, else expected answers (normalized match or contained as a whole word), else no check", () => {
  assert.equal(matchesExpected("Paris.", "paris"), true);
  assert.equal(matchesExpected("The capital is Paris, of course.", "Paris"), true);
  assert.equal(matchesExpected("42", "4"), false, "never a digit inside a number");
  assert.equal(matchesExpected("It's 4.", "4"), true);
  assert.equal(matchesExpected("Leonardo   da\nVinci painted it", "Leonardo da Vinci"), true);
  assert.equal(matchesExpected('{"a":1,"b":[2]}', '{"b": [2], "a": 1}'), true);
  assert.equal(matchesExpected("", ""), true);
  assert.deepEqual(scoreCase({ expected: ["Tokyo"] }, "Kyoto"), { status: "fail", reason: 'expected "Tokyo", got "Kyoto"', skipped: [] });
  assert.equal(scoreCase({ expected: ["Jupiter", "Saturn"] }, "Saturn").status, "pass");
  const mixed = scoreCase({ assertions: [{ type: "icontains", value: "paris" }, { type: "llm-rubric", value: "x" }] }, "Paris");
  assert.deepEqual(mixed, { status: "pass", skipped: ["llm-rubric"] });
  assert.deepEqual(scoreCase({ assertions: [{ type: "llm-rubric", value: "x" }] }, "Paris"), { status: "no-check", skipped: ["llm-rubric"] }, "only unsupported: nothing checked");
  assert.equal(scoreCase({ assertions: [{ type: "llm-rubric" }], expected: ["Paris"] }, "Paris").status, "pass", "then the expected answer");
  assert.match(scoreCase({ assertions: [{ type: "contains", value: "Rome" }] }, "Paris").reason!, /^contains "Rome" failed; got "Paris"$/);
  assert.deepEqual(scoreCase({}, "anything"), { status: "no-check", skipped: [] });
});

/** A fake OpenAI-compatible server: `answer` replies to each request's last user message. */
async function fakeModel(answer: (prompt: string, body: Record<string, unknown>) => { status?: number; message?: Record<string, unknown>; hang?: boolean; raw?: string }) {
  const bodies: Array<Record<string, unknown>> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let text = "";
    req.on("data", (chunk) => { text += chunk; });
    req.on("end", () => {
      const body = JSON.parse(text) as Record<string, unknown>;
      bodies.push(body);
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      const messages = body.messages as Array<{ role: string; content: string }>;
      const reply = answer(messages.filter((message) => message.role === "user").at(-1)!.content, body);
      if (reply.hang) { res.on("close", () => { inFlight--; }); return; }
      setTimeout(() => {
        inFlight--;
        res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
        res.end(reply.raw ?? JSON.stringify({ choices: [{ message: { role: "assistant", ...reply.message }, finish_reason: "stop" }] }));
      }, 5);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { port, bodies, maxInFlight: () => maxInFlight, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

const target = (port: number) => ({ repo: "Qwen/Qwen3-8B", port, host: "127.0.0.1" });
const cases = (items: EvalCase[]) => items.map((item, index) => ({ source: `t.jsonl#${index + 1}`, item }));

test("the runner: chat completions at temperature 0 with the served model id, a few at a time, thinking stripped", async () => {
  const model = await fakeModel((prompt) => {
    if (prompt.startsWith("think")) return { message: { content: "<think>Hmm, France... Lyon? No.</think>\n\nParis" } };
    if (prompt.startsWith("reason")) return { message: { content: "Paris", reasoning_content: "long thoughts" } };
    if (prompt.startsWith("only")) return { message: { content: "", reasoning_content: "thinking forever" } };
    if (prompt.startsWith("broken")) return { status: 500, raw: "engine crashed" };
    if (prompt.startsWith("hang")) return { hang: true };
    return { message: { content: prompt.includes("wrong") ? "Lyon" : "Paris" } };
  });
  try {
    const items: EvalCase[] = [
      { input: "think: capital of France?", expected: ["Paris"], metadata: {} },
      { input: "reason: capital?", expected: ["Paris"], metadata: {} },
      { input: [{ role: "system", content: "terse" }, { role: "user", content: "plain" }], assertions: [{ type: "equals", value: "Paris" }], metadata: { id: "chat" } },
      { input: "wrong one", expected: ["Paris"], metadata: { id: "w" } },
      { input: "only thinking", expected: ["Paris"], metadata: {} },
      { input: "broken", expected: ["Paris"], metadata: {} },
      { input: "hang", expected: ["Paris"], metadata: {} },
      { input: "no check", metadata: {} },
      { input: "rubric", assertions: [{ type: "llm-rubric", value: "good" }], metadata: {} },
    ];
    const run = await runDataCases(cases(items), target(model.port), { concurrency: 3, caseTimeoutMs: 300 });
    assert.deepEqual(run.cases.map((result) => result.status), ["pass", "pass", "pass", "fail", "fail", "fail", "fail", "no-check", "no-check"]);
    assert.equal(run.cases[0]!.output, "Paris", "the <think> block is not the answer");
    assert.equal(run.cases[4]!.reason, 'the model returned only thinking, no answer; expected "Paris", got ""');
    assert.match(run.cases[5]!.reason!, /^HTTP 500: engine crashed$/);
    assert.equal(run.cases[6]!.reason, "no answer in 0 s");
    assert.deepEqual({ checked: run.checked, passed: run.passed, noCheck: run.noCheck, errors: run.errors, skipped: run.skipped, score: run.score },
      { checked: 7, passed: 3, noCheck: 2, errors: 2, skipped: { "llm-rubric": 1 }, score: 3 / 7 });
    assert.equal(dataRunSummary(run), "3 of 7 passed · 2 with no check · 2 errors · llm-rubric ×1 skipped (not supported)");
    assert.deepEqual(failureLines(run, 2), ['t.jsonl#4 (w): expected "Paris", got "Lyon"', 't.jsonl#5: the model returned only thinking, no answer; expected "Paris", got ""', "and 2 more in the results file"]);
    const body = model.bodies.find((item) => (item.messages as Array<{ content: string }>).some((message) => message.content === "terse"))!;
    assert.deepEqual(body, { model: "Qwen/Qwen3-8B", messages: [{ role: "system", content: "terse" }, { role: "user", content: "plain" }], temperature: 0, max_tokens: 1024,
      chat_template_kwargs: { enable_thinking: false } });
    assert.ok(model.maxInFlight() <= 3, `at most 3 at once, saw ${model.maxInFlight()}`);
    assert.ok(model.maxInFlight() > 1, "more than one at once");
    // Past the run's time limit, no case starts.
    const late = await runDataCases(cases(items.slice(0, 2)), target(model.port), { deadline: 0 });
    assert.equal(late.timedOut, true);
    assert.deepEqual(late.cases.map((result) => result.reason), ["not run: the time limit was reached", "not run: the time limit was reached"]);
  } finally { await model.close(); }
});

test("dl evals set --data and run: the files are read when set, each model's answers are checked, results land in a file", async () => {
  const model = await fakeModel((prompt) => ({ message: { content: /France/.test(prompt) ? "Paris" : /2 \+ 2/.test(prompt) ? "5" : "red" } }));
  const system = new FakeModelSystem();
  const lines: string[] = [];
  const options = { system, ui: new PlainUi((line) => lines.push(line)), statePath: "/state/model.json", cwd: FIXTURES, logDir: "/logs" };
  try {
    await assert.rejects(evalsCommand(["set"], { ...options, data: "notes.csv" }), /notes\.csv: not an eval dataset dl recognizes/);
    assert.ok(!system.files.has("/state/evals.json"), "nothing saved");
    assert.equal(await evalsCommand(["set"], { ...options, data: "qa.jsonl" }), 0);
    assert.deepEqual({ ...JSON.parse(system.files.get("/state/evals.json")!.content), setAt: "" }, { version: 1, data: fixture("qa.jsonl"), dir: FIXTURES, setAt: "" });
    let out = lines.join("");
    assert.match(out, /Data: .*qa\.jsonl \(run by dl/);
    assert.match(out, /Data: 4 cases from 1 file\n-- Data: qa\.jsonl: JSONL, 4 cases \(1 row without an input skipped\)/);
    assert.doesNotMatch(out, /Command:/);
    await writeDeployment(system, "default", { active: deployment("qwen", model.port) }, "/state/model.json");
    system.running.add(`dl-model-${model.port}`);
    lines.length = 0;
    assert.equal(await evalsCommand(["run"], options), 0, "a data run passes when the model answered; the score says how well");
    out = lines.join("");
    assert.match(out, /qwen +pass +0\.67/);
    assert.match(out, /Results \(default\): data: 2 of 3 passed · 1 with no check/);
    assert.match(out, /Failed \(default\): qa\.jsonl#2 \(math-1\): expected "4", got "5"/);
    const resultsPath = /Data results \(default\): (\S+)/.exec(out)![1]!;
    assert.match(resultsPath, /^\/logs\/.*-evals-default-data\.json$/);
    const saved = JSON.parse(system.files.get(resultsPath)!.content);
    assert.equal(saved.score, 2 / 3);
    assert.equal(saved.cases[1].output, "5");
    assert.equal(saved.served, "Qwen/Qwen3-8B");
    // A command and data together; --data "" takes the data off again.
    assert.equal(await evalsCommand(["set", "make evals"], options), 0);
    assert.deepEqual(Object.keys(JSON.parse(system.files.get("/state/evals.json")!.content)).sort(), ["command", "data", "dir", "setAt", "version"]);
    lines.length = 0;
    await evalsCommand(["show"], options);
    assert.match(lines.join(""), /Command: make evals[\s\S]*Data: [\s\S]*Both: both must pass; the score is the mean of the two/);
    assert.equal(await evalsCommand(["set"], { ...options, data: "" }), 0);
    assert.equal(JSON.parse(system.files.get("/state/evals.json")!.content).data, undefined);
    await assert.rejects(evalsCommand(["run"], { ...options, data: "x" }), /--threshold, --results and --data go with dl evals set/);
  } finally { await model.close(); }
});

test("a data run where no case got an answer fails, and says why", async () => {
  const system = new FakeModelSystem();
  const lines: string[] = [];
  const options = { system, ui: new PlainUi((line) => lines.push(line)), statePath: "/state/model.json", cwd: FIXTURES, logDir: "/logs",
    fetch: async () => { throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8000"), { code: "ECONNREFUSED" }); } };
  await evalsCommand(["set"], { ...options, data: "openai-evals.jsonl" });
  await writeDeployment(system, "default", { active: deployment("qwen", 8000) }, "/state/model.json");
  system.running.add("dl-model-8000");
  assert.equal(await evalsCommand(["run"], options), 1);
  assert.match(lines.join(""), /qwen +fail \(no answers\) +–/);
  assert.match(lines.join(""), /data: no answers: ECONNREFUSED connect ECONNREFUSED 127\.0\.0\.1:8000/);
});

function deployment(id: string, port: number): ModelDeployment {
  return { id, repo: "Qwen/Qwen3-8B", container: `dl-model-${port}`, port, context: 8192, image: "vllm/vllm-openai:v0.33.0", flags: [], minVramMiB: 1,
    lastTest: { chat: true, tools: true, json: true, tokensPerSecond: 1, at: "" } };
}
