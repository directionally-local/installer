import assert from "node:assert/strict";
import { test } from "node:test";
import { MODEL_CATALOG, OPTIMIZED_ENGINE_FAMILIES, recipe } from "./model-catalog.js";
import { engineFlag, engineStep, modelCommand } from "./model-command.js";
import { chooseEngine, ENGINE_COPY, gpuSummaryText, looksLikeEmail, offersOptimizedEngine, PILOT_URL, type PilotFetch } from "./model-engine-choice.js";
import { firstRunModelUp } from "./model-first-run.js";
import { PromptCancelled, type Prompter, type SelectOption } from "./prompt.js";
import { FakeModelSystem } from "./test-support/fake-model-system.js";
import { PlainUi, type Ui } from "./ui.js";

const B300 = Array.from({ length: 8 }, () => ({ name: "NVIDIA B300 SXM6 AC" }));

/**
 * A prompter answering from a queue, in order: a select answer is an option value ("" for the
 * preselected one, "esc" to cancel); an edit answer is text ("" keeps the prefill, "<esc>" goes back).
 */
function scripted(answers: string[]) {
  const queue = [...answers];
  const asked: Array<{ kind: "select"; question: string; options: SelectOption[]; initial: number | undefined } | { kind: "edit"; question: string; initial: string | undefined }> = [];
  const next = (question: string) => {
    if (queue.length === 0) throw new Error(`unexpected question: ${question}`);
    return queue.shift()!;
  };
  const prompter: Prompter = {
    choose: async () => "",
    select: async (question, options, initial) => {
      asked.push({ kind: "select", question, options, initial });
      const answer = next(question);
      if (answer === "esc") throw new PromptCancelled();
      return { value: answer === "" ? options[initial ?? 0]!.value : answer };
    },
    secret: async () => "",
    text: async (question) => next(question),
    edit: async (question, initial) => {
      asked.push({ kind: "edit", question, initial });
      const answer = next(question);
      if (answer === "<esc>") return null;
      return answer === "" ? (initial ?? "") : answer;
    },
  };
  return { prompter, asked, left: queue };
}

function capture(): { ui: Ui; lines: string[] } {
  const lines: string[] = [];
  return { ui: new PlainUi((line) => lines.push(line)), lines };
}

/** A pilot inbox that records what it got; `fail` makes the network fail. */
function inbox(fail = false) {
  const posts: Array<{ url: string; body: unknown; method: string | undefined }> = [];
  const fetch: PilotFetch = async (url, init) => {
    if (fail) throw new TypeError("fetch failed");
    posts.push({ url, method: init.method, body: JSON.parse(String(init.body)) });
    return { ok: true, status: 200 };
  };
  return { fetch, posts };
}

const deepseek = recipe("deepseek-v4.1-flash-fp8");

test("catalog: DeepSeek and GLM entries are marked for the optimized engine from one list; Qwen isn't", () => {
  assert.deepEqual(OPTIMIZED_ENGINE_FAMILIES, ["deepseek", "glm", "gpt-oss"]);
  const marked = MODEL_CATALOG.filter(offersOptimizedEngine).map((model) => model.id);
  assert.deepEqual(marked, ["glm-flash", "deepseek-v4.1-flash-fp8", "deepseek-v4.1-flash-fp4", "glm-5.3-flash"]);
  assert.equal(offersOptimizedEngine(recipe("qwen-new")), false);
  assert.equal(offersOptimizedEngine(recipe("qwen-old")), false);
});

test("the GPUs prefill and the email check", () => {
  assert.equal(gpuSummaryText(B300), "8× B300");
  assert.equal(gpuSummaryText([{ name: "NVIDIA H100 80GB HBM3" }, { name: "NVIDIA H100 80GB HBM3" }, { name: "NVIDIA L40S" }]), "2× H100, 1× L40S");
  assert.equal(gpuSummaryText([{ name: "NVIDIA RTX PRO 6000 Blackwell Server Edition" }]), "1× RTX PRO 6000");
  assert.ok(looksLikeEmail("maya@acme.ai"));
  for (const bad of ["maya", "maya@acme", "ma ya@acme.ai", "@acme.ai", `${"a".repeat(250)}@acme.ai`]) assert.ok(!looksLikeEmail(bad), bad);
});

test("the choice: optimized engine first and selected, open-source engine named after the entry's engine", async () => {
  const { prompter, asked } = scripted(["open-source"]);
  const { ui, lines } = capture();
  const { fetch, posts } = inbox();
  assert.equal(await chooseEngine({ ui, prompter, model: deepseek, gpus: B300, fetch }), "continue");
  const first = asked[0]!;
  assert.equal(first.kind, "select");
  if (first.kind !== "select") return;
  assert.match(first.question, /How should this GPU serve deepseek-v4\.1-flash-fp8\?/);
  assert.equal(first.initial, 0);
  assert.deepEqual(first.options.map((option) => [option.label, option.accent, option.detail]), [
    ["Optimized engine", "(55% cheaper per token)", "same speed as the model's official API · set up by our team · recommended"],
    ["Open-source engine (vLLM)", undefined, "free · starts now · what most providers run"],
  ]);
  assert.equal(posts.length, 0);
  assert.ok(lines.some((line) => line === "ok Engine: vLLM\n"));
  // An SGLang entry names SGLang.
  const sglang = scripted(["open-source"]);
  await chooseEngine({ ui, prompter: sglang.prompter, model: recipe("deepseek-v4.1-flash-fp4"), gpus: B300, fetch });
  const options = sglang.asked[0]!.kind === "select" ? (sglang.asked[0] as { options: SelectOption[] }).options : [];
  assert.equal(options[1]!.label, "Open-source engine (SGLang)");
});

test("optimized: three questions prefilled, the request posted with its source, then Yes continues with vLLM", async () => {
  // Enter keeps the sign-in email, Company typed, Enter keeps the detected GPUs, Yes (the default).
  const { prompter, asked, left } = scripted(["", "", "Acme AI", "", ""]);
  const { ui, lines } = capture();
  const { fetch, posts } = inbox();
  const outcome = await chooseEngine({ ui, prompter, model: deepseek, gpus: B300, fetch, signInEmail: async () => "maya@acme.ai" });
  assert.equal(outcome, "continue");
  assert.equal(left.length, 0);
  const edits = asked.filter((item) => item.kind === "edit");
  assert.deepEqual(edits.map((item) => item.initial), ["maya@acme.ai", "", "8× B300"]);
  assert.match(edits[0]!.question, /Work email.*from your GitHub sign-in, Enter to keep/);
  assert.match(edits[1]!.question, /Company/);
  assert.match(edits[2]!.question, /GPUs you'd run it on.*this box: 8× B300, add any others/);
  assert.deepEqual(posts, [{ url: PILOT_URL, method: "POST", body: { company: "Acme AI", email: "maya@acme.ai", gpus: "8× B300", models: "deepseek-v4.1-flash-fp8", tokens: "", source: "dl model up" } }]);
  const out = lines.join("");
  assert.match(out, /ok Thanks\. We'll email maya@acme\.ai within one working day\n-- with a quote and a pilot plan for 8× B300\.\n/);
  const last = asked.at(-1)!;
  assert.equal(last.kind, "select");
  assert.match(last.question, /Continue with vLLM for now, to try the rest of dl\?/);
  assert.equal((last as { initial: number }).initial, 0);
  assert.deepEqual((last as { options: SelectOption[] }).options.map((option) => option.label), ["Yes, continue with vLLM", "No, stop here"]);
  assert.match(out, /ok Engine: vLLM for now/);
});

test("optimized: No stops with how to continue later", async () => {
  const { prompter } = scripted(["", "maya@acme.ai", "Acme AI", "8× B300", "no"]);
  const { ui, lines } = capture();
  const { fetch } = inbox();
  assert.equal(await chooseEngine({ ui, prompter, model: deepseek, gpus: B300, fetch }), "stop");
  const out = lines.join("");
  assert.match(out, /Got it\. We'll be in touch at maya@acme\.ai\./);
  assert.match(out, /Run dl model up any time to continue with vLLM\./);
});

test("Esc on any of the three questions goes back to the choice with the open-source engine highlighted", async () => {
  for (const position of [0, 1, 2]) {
    const answers = ["", ...["maya@acme.ai", "Acme AI", "8× B300"].slice(0, position), "<esc>", "open-source"];
    const { prompter, asked, left } = scripted(answers);
    const { ui } = capture();
    const { fetch, posts } = inbox();
    assert.equal(await chooseEngine({ ui, prompter, model: deepseek, gpus: B300, fetch }), "continue", `Esc on question ${position + 1}`);
    assert.equal(left.length, 0);
    const selects = asked.filter((item) => item.kind === "select") as Array<{ initial: number; question: string }>;
    assert.deepEqual(selects.map((item) => item.initial), [0, 1]);
    assert.match(selects[1]!.question, /How should this GPU serve/);
    assert.equal(posts.length, 0, "nothing is sent");
  }
});

test("the questions re-ask an invalid email and an empty answer", async () => {
  const { prompter, left } = scripted(["", "not-an-email", "maya@acme", "maya@acme.ai", "", "Acme AI", "", "8× B300", ""]);
  const { ui, lines } = capture();
  const { fetch, posts } = inbox();
  // No sign-in email and no GPUs detected: nothing to prefill.
  assert.equal(await chooseEngine({ ui, prompter, model: deepseek, gpus: [], fetch, signInEmail: async () => undefined }), "continue");
  assert.equal(left.length, 0);
  assert.equal(lines.filter((line) => line.includes("doesn't look like an email")).length, 2);
  assert.equal(lines.filter((line) => line.includes("Please answer this one")).length, 2);
  assert.deepEqual(posts[0]!.body, { company: "Acme AI", email: "maya@acme.ai", gpus: "8× B300", models: "deepseek-v4.1-flash-fp8", tokens: "", source: "dl model up" });
});

test("network failure: says to email us, never blocks, still offers to continue", async () => {
  const { prompter } = scripted(["", "maya@acme.ai", "Acme AI", "8× B300", ""]);
  const { ui, lines } = capture();
  const { fetch } = inbox(true);
  assert.equal(await chooseEngine({ ui, prompter, model: deepseek, gpus: B300, fetch }), "continue");
  const out = lines.join("");
  assert.match(out, /FAILED Couldn't send\. Email contact@directionallylocal\.com/);
  assert.doesNotMatch(out, /Thanks\./);
});

test("--engine and when the question is asked at all", async () => {
  assert.equal(engineFlag(undefined), undefined);
  assert.equal(engineFlag("vllm"), "open-source");
  assert.equal(engineFlag("SGLang"), "open-source");
  assert.equal(engineFlag("optimized"), "optimized");
  assert.throws(() => engineFlag("fast"), /--engine is vllm .* or optimized/);
  const base = (o: { interactive?: boolean; engine?: string; env?: NodeJS.ProcessEnv; dryRun?: boolean; answers?: string[] } = {}) => {
    const system = new FakeModelSystem();
    if (o.dryRun) (system as { dryRun: boolean }).dryRun = true;
    const s = scripted(o.answers ?? []);
    return { s, options: { system, ui: new PlainUi(() => {}), prompter: s.prompter, interactive: o.interactive ?? true, env: o.env ?? {}, pilotFetch: inbox().fetch, signInEmail: async () => undefined, ...(o.engine ? { engine: o.engine } : {}) } };
  };
  // A model the optimized engine doesn't serve: no question.
  let run = base();
  assert.equal(await engineStep(run.options, recipe("qwen-new"), B300 as never), "continue");
  assert.equal(run.s.asked.length, 0);
  // No terminal, CI, --dry-run, --engine vllm: no question, the open-source engine.
  for (const o of [{ interactive: false }, { env: { CI: "true" } }, { dryRun: true }, { engine: "vllm" }]) {
    run = base(o);
    assert.equal(await engineStep(run.options, deepseek, B300 as never), "continue", JSON.stringify(o));
    assert.equal(run.s.asked.length, 0, JSON.stringify(o));
  }
  // On a terminal: asked.
  run = base({ answers: ["open-source"] });
  assert.equal(await engineStep(run.options, deepseek, B300 as never), "continue");
  assert.equal(run.s.asked.length, 1);
  // --engine optimized: straight to the questions; needs a terminal and a model it serves.
  run = base({ engine: "optimized", answers: ["maya@acme.ai", "Acme AI", "", "no"] });
  assert.equal(await engineStep(run.options, deepseek, B300 as never), "stop");
  assert.equal(run.s.asked[0]!.kind, "edit");
  await assert.rejects(engineStep(base({ engine: "optimized", interactive: false }).options, deepseek, B300 as never), /--engine optimized asks three questions/);
  await assert.rejects(engineStep(base({ engine: "optimized" }).options, recipe("qwen-new"), B300 as never), /qwen-new isn't offered on the optimized engine/);
});

test("dl model up: a supported model asks before anything starts; No stops with nothing run", async () => {
  const system = new FakeModelSystem();
  const { prompter, asked } = scripted(["", "maya@acme.ai", "Acme AI", "", "no"]);
  const { fetch, posts } = inbox();
  const lines: string[] = [];
  const code = await modelCommand("up", ["glm-flash"], { system, ui: new PlainUi((line) => lines.push(line)), prompter, interactive: true, env: {}, pilotFetch: fetch,
    signInEmail: async () => undefined, statePath: "/tmp/m.json", configPath: "/tmp/c.json", logDir: "/tmp/logs" });
  assert.equal(code, 0);
  assert.match((asked[0] as { question: string }).question, /How should this GPU serve glm-flash\?/);
  assert.equal(posts.length, 1);
  assert.equal((posts[0]!.body as { gpus: string }).gpus, "1× RTX 6000");
  assert.equal(system.modelCommands.length, 0, "no container started");
  assert.ok(!asked.some((item) => /Context length|Port/.test(item.question)), "stopped before the context and port questions");
  assert.match(lines.join(""), /Run dl model up any time to continue with vLLM\./);
});

test("GPU first run: the same step after the picker; No ends the setup as cancelled, a retry doesn't ask again", async () => {
  const { prompter, asked, left } = scripted(["glm-flash", "", "maya@acme.ai", "Acme AI", "", "no"]);
  const ui = Object.assign(new PlainUi(() => {}), { interactive: true }) as Ui;
  const { fetch, posts } = inbox();
  const ups: string[][] = [];
  const result = await firstRunModelUp({ system: new FakeModelSystem(), ui, prompter, statePath: "/tmp/m.json", configPath: "/tmp/c.json", env: {}, pilotFetch: fetch,
    signInEmail: async () => undefined, modelUp: async (_action, args) => { ups.push(args); return 0; } });
  assert.deepEqual(result, { ok: false, errorType: "cancelled", message: "Cancelled.", model: "glm-flash" });
  assert.equal(left.length, 0);
  assert.match((asked[0] as { question: string }).question, /Pick a model/);
  assert.match((asked[1] as { question: string }).question, /How should this GPU serve glm-flash\?/);
  assert.equal(posts.length, 1);
  assert.deepEqual(ups, [], "nothing started");
  // Picking the open-source engine runs dl model up as before.
  const open = scripted(["glm-flash", "open-source"]);
  const ups2: string[][] = [];
  assert.deepEqual(await firstRunModelUp({ system: new FakeModelSystem(), ui, prompter: open.prompter, statePath: "/tmp/m.json", configPath: "/tmp/c.json", env: {},
    modelUp: async (_action, args) => { ups2.push(args); return 0; } }), { ok: true, model: "zai-org/GLM-4.7-Flash" });
  assert.deepEqual(ups2, [["glm-flash"]]);
  // A retry of the same model (Autopilot's Retry) isn't asked again.
  const retry = scripted([]);
  const ups3: string[][] = [];
  assert.deepEqual(await firstRunModelUp({ system: new FakeModelSystem(), ui, prompter: retry.prompter, statePath: "/tmp/m.json", configPath: "/tmp/c.json", env: {}, model: "glm-flash",
    modelUp: async (_action, args) => { ups3.push(args); return 0; } }), { ok: true, model: "zai-org/GLM-4.7-Flash" });
  assert.equal(retry.asked.length, 0);
  assert.deepEqual(ups3, [["glm-flash"]]);
});

test("the copy stays as approved", () => {
  assert.equal(ENGINE_COPY.sendFailed, "Couldn't send. Email contact@directionallylocal.com");
  assert.equal(ENGINE_COPY.stopped("vLLM"), "Run dl model up any time to continue with vLLM.");
});
