import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { modelCommand, type ModelCommandOptions } from "./model-command.js";
import { firstRunModelUp } from "./model-first-run.js";
import { gpuLine, shortGpuName } from "./model-runtime.js";
import { smokeTest } from "./model-smoke.js";
import { FakeModelSystem } from "./test-support/fake-model-system.js";
import { fakeVllm, type FakeVllm } from "./test-support/fake-vllm.js";
import { PlainUi, TerminalUi, type Ui } from "./ui.js";
import type { Prompter } from "./prompt.js";

const GIB = 1024 ** 3;
const PRO_5000 = "0, NVIDIA RTX PRO 5000 Blackwell, 48935, 48000, 580.95.05\n";

/** Hugging Face's file list for the model: two 4 GiB weight files and a config. */
function hfTree(): Response {
  return new Response(JSON.stringify([
    { type: "file", path: "model-00001-of-00002.safetensors", size: 4 * GIB - 1000, lfs: { size: 4 * GIB - 1000 } },
    { type: "file", path: "model-00002-of-00002.safetensors", size: 4 * GIB - 1000, lfs: { size: 4 * GIB - 1000 } },
    { type: "file", path: "config.json", size: 2000 },
    { type: "file", path: "README.md", size: 99_999 },
  ]), { status: 200 });
}

const prompter: Prompter = {
  choose: async () => "", select: async (_question, options, initial) => ({ value: options[initial ?? 0]!.value }),
  secret: async () => "", text: async () => "",
};

/** What a terminal shows: escape codes gone, one entry per printed line. */
function printed(output: string): string[] {
  // eslint-disable-next-line no-control-regex
  return output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n");
}

describe("dl model up against a fake vLLM", () => {
  let server: FakeVllm | undefined;
  afterEach(async () => { await server?.close(); server = undefined; });

  function setup(o: { thinking?: "reasoning_content" | "none"; alwaysThinks?: boolean; ui?: Ui } = {}) {
    const system = new FakeModelSystem();
    system.gpu = PRO_5000;
    system.downloads = [2 * GIB, 4 * GIB, 8 * GIB];
    system.vllmLogs = "INFO 11-12 starting engine\nERROR 11-12 a long vLLM traceback line\n";
    const lines: string[] = [];
    const options = (vllm: FakeVllm): ModelCommandOptions => ({
      system, ui: o.ui ?? new PlainUi((line) => lines.push(line)), prompter, interactive: false,
      statePath: "/tmp/model.json", configPath: "/tmp/autopilot/config.json", logDir: "/tmp/logs",
      delay: async () => {},
      fetch: async (url, init) => url.startsWith("https://huggingface.co/") ? hfTree() : fetch(url.replace(/:800\d\//, `:${vllm.port}/`), init),
    });
    return { system, lines, options };
  }

  it("shows the download in GB and %, then starting vLLM, then each test as it passes", async () => {
    server = await fakeVllm({ notReadyFor: 3 });
    const { lines, options } = setup();
    assert.equal(await modelCommand("up", ["qwen-new"], options(server)), 0);
    const text = lines.join("");
    assert.match(text, /\.\. Download qwen-new: waiting for vLLM\n/);
    assert.match(text, /Download qwen-new: 2\.0 of 8\.0 GB · 25%/);
    assert.match(text, /ok Download qwen-new: 8\.0 GB\n/);
    assert.match(text, /\.\. Start vLLM: loading the model\nok Start vLLM\n/);
    assert.match(text, /ok Chat test\n\.\. Speed test\nok Speed test: [\d.]+ tokens\/sec\n\.\. Tool call test\nok Tool call test\n\.\. JSON test\nok JSON test\n/);
  });

  it("a failure names the test and reason; vLLM's own log goes to the log file, not the screen", async () => {
    server = await fakeVllm({ thinking: "reasoning_content", alwaysThinks: true });
    const { system, lines, options } = setup();
    const error = await modelCommand("up", ["qwen-old"], options(server)).catch((caught: Error) => caught);
    assert.ok(error instanceof Error);
    const [first, kept, stop, reproduce, logLine, ...more] = error.message.split("\n");
    assert.equal(first, "Chat test: the model returned no text, thinking mode used all tokens");
    assert.equal(kept, "The vLLM container is still running: docker logs dl-model-1");
    assert.equal(stop, "Stop it with docker rm -f dl-model-1; dl model up reuses it while it answers");
    assert.match(reproduce!, /^Reproduce: curl -sS --max-time 30 -X POST 'http:\/\/127\.0\.0\.1:8000\/v1\/chat\/completions' -H 'content-type: application\/json' -d '\{"model":"Qwen\/Qwen3-4B","chat_template_kwargs":\{"enable_thinking":false\},"max_tokens":256,"messages":.*\}'$/);
    assert.match(logLine!, /^Full log: \/tmp\/logs\/.*-up\.log$/);
    assert.deepEqual(more, [], "nothing more in the message: no server logs");
    assert.match(lines.join(""), /!! Chat test: only thinking, out of tokens|FAIL|failed/i);
    assert.doesNotMatch(lines.join(""), /traceback|starting engine/, "no server logs on screen");
    const log = system.files.get(logLine!.slice("Full log: ".length))!.content;
    assert.match(log, /vLLM logs \(dl-model-1, last 200 lines\):\n {2}INFO 11-12 starting engine\n {2}ERROR 11-12 a long vLLM traceback line/);
    assert.match(log, /FAILED Chat test: the model returned no text/);
  });

  it("a failed check keeps the container running and logs every request; Retry reuses it while it answers", async () => {
    const vllm = { thinking: "none" as const, hangChat: true };
    server = await fakeVllm(vllm);
    const { system, options } = setup();
    const opts = { ...options(server), smoke: ((deployment, sys, call, smokeOptions) => smokeTest(deployment, sys, call, { ...smokeOptions, answerMs: 300 })) as typeof smokeTest };
    const error = await modelCommand("up", ["qwen-new"], opts).catch((caught: Error) => caught);
    assert.ok(error instanceof Error);
    assert.equal(error.message.split("\n")[0], "Chat test: no answer in 0.3 s");
    assert.ok(system.running.has("dl-model-1"), "the container is kept for inspection");
    assert.ok(!system.modelCommands.some((command) => command.startsWith("rm")), "not torn down");
    assert.match(error.message, /\nThe vLLM container is still running: docker logs dl-model-1\n/);
    const log = system.files.get(error.message.match(/Full log: (\S+)/)![1]!)!.content;
    assert.match(log, /smoke ready GET http:\/\/127\.0\.0\.1:8000\/v1\/models started \S+Z: HTTP 200 after \d+ ms/);
    assert.match(log, /smoke chat POST http:\/\/127\.0\.0\.1:8000\/v1\/chat\/completions started \S+Z: FAILED after \d+ ms: no answer in 0\.3 s/);
    assert.match(log, /Reproduce: curl -sS --max-time 1 -X POST 'http:\/\/127\.0\.0\.1:8000\/v1\/chat\/completions'/);
    assert.equal(await system.readFile("/tmp/model.json"), undefined, "no state written");

    // Retry: the same recipe, still answering, is reused (no second docker run).
    vllm.hangChat = false;
    const runs = system.modelCommands.filter((command) => command.startsWith("run")).length;
    assert.equal(await modelCommand("up", ["qwen-new"], opts), 0);
    assert.equal(system.modelCommands.filter((command) => command.startsWith("run")).length, runs, "reused, not recreated");
    assert.ok(!system.modelCommands.some((command) => command.startsWith("rm")));
  });

  it("Retry replaces a kept container that doesn't answer, or runs another model", async () => {
    server = await fakeVllm({ thinking: "reasoning_content", alwaysThinks: true });
    const { system, options } = setup();
    const opts = options(server);
    await assert.rejects(modelCommand("up", ["qwen-new"], opts), /: Chat test: the model returned no text/);
    assert.ok(system.running.has("dl-model-1"));
    // Its API stopped answering: replaced.
    let answered = false;
    const dead = { ...opts, fetch: async (url: string, init?: RequestInit) => {
      if (!answered && url.endsWith("/v1/models")) { answered = true; throw new Error("connect ECONNREFUSED"); }
      return opts.fetch!(url, init);
    } };
    await assert.rejects(modelCommand("up", ["qwen-new"], dead), /: Chat test: the model returned no text/);
    assert.deepEqual(system.modelCommands.filter((command) => /^(run|rm)/.test(command)).map((command) => command.split(" ").slice(0, 2).join(" ")), ["run -d", "rm -f", "run -d"]);
    // Another model: replaced too.
    await assert.rejects(modelCommand("up", ["qwen-old"], opts), /: Chat test: the model returned no text/);
    assert.deepEqual(system.modelCommands.filter((command) => /^(run|rm)/.test(command)).map((command) => command.split(" ").slice(0, 2).join(" ")), ["run -d", "rm -f", "run -d", "rm -f", "run -d"]);
    assert.match(system.modelCommands.at(-1)!, /Qwen\/Qwen3-4B /);
  });

  it("every line of dl model up, status, update, rollback and bench fits 80 columns", async () => {
    server = await fakeVllm({ thinking: "none" });
    let output = "";
    // A fresh terminal UI per command, as on a real terminal.
    const ui = () => new TerminalUi((text) => { output += text; }, () => 80, false);
    const { system, options } = setup();
    const opts = options(server);
    assert.equal(await modelCommand("up", ["qwen-old"], { ...opts, ui: ui() }), 0);
    assert.equal(await modelCommand("status", [], { ...opts, ui: ui() }), 0);
    system.downloads = [8 * GIB];
    assert.equal(await modelCommand("update", ["qwen-new"], { ...opts, ui: ui(), bench: async () => ({ levels: [{ concurrency: 1, requests: 1, ttftP50: 0.123, ttftP95: 0.456, decodeTokPerSec: 126.3 }] }) }), 0);
    assert.equal(await modelCommand("rollback", [], { ...opts, ui: ui(), bench: async () => { throw new Error("connection refused by 127.0.0.1:8001 after a very long wait of many seconds"); } }), 0);
    assert.equal(await modelCommand("bench", [], { ...opts, ui: ui(), fetch: async (url, init) => fetch(url.replace(/:800\d\//, `:${server!.port}/`), init) }), 0);
    system.gpu = "0, GPU, 49152, 1024, 570\n";
    assert.equal(await modelCommand("update", ["qwen-new"], { ...opts, ui: ui(), interactive: true, prompter: { ...prompter, text: async (q) => (/downtime/.test(q) ? "y" : "") } }), 0);
    system.gpu = PRO_5000;
    await system.remove("/tmp/model.json");
    system.running.clear();
    const first = await firstRunModelUp({ system, ui: ui(), prompter, statePath: "/tmp/model.json", configPath: "/tmp/autopilot/config.json", ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.delay ? { delay: opts.delay } : {}) });
    assert.equal(first.ok, true);
    const shown = printed(output);
    const long = shown.filter((line) => line.length > 79 || line.includes("…"));
    assert.deepEqual(long, [], "no line is cut off or wraps");
    assert.ok(shown.some((line) => /GPU\s+NVIDIA RTX PRO 5000 · 48 GB$/.test(line)), "the short GPU line");
  });
});

describe("the GPU in one line", () => {
  it("drops the edition words, and sums several GPUs", () => {
    assert.equal(shortGpuName("NVIDIA RTX PRO 5000 Blackwell"), "NVIDIA RTX PRO 5000");
    assert.equal(shortGpuName("NVIDIA RTX PRO 6000 Blackwell Server Edition"), "NVIDIA RTX PRO 6000");
    assert.equal(shortGpuName("NVIDIA GeForce RTX 4090"), "NVIDIA GeForce RTX 4090");
    assert.equal(gpuLine([{ name: "NVIDIA RTX PRO 5000 Blackwell", totalMiB: 48935 }]), "NVIDIA RTX PRO 5000 · 48 GB");
    const pro6000 = { name: "NVIDIA RTX PRO 6000 Blackwell Server Edition", totalMiB: 97887 };
    assert.equal(gpuLine([pro6000, pro6000, pro6000, pro6000]), "4x NVIDIA RTX PRO 6000 · 384 GB total");
    assert.equal(gpuLine([pro6000, { name: "NVIDIA GeForce RTX 4090", totalMiB: 24564 }]), "2 GPUs · 120 GB total");
  });
});
