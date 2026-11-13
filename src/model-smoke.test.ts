import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo, LookupFunction } from "node:net";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";
import { createLocalFetch, curlLine, FIRST_ANSWER_MS, modelApiBase, NO_THINKING, SmokeError, smokeTest, type FetchModel } from "./model-smoke.js";
import { FakeModelSystem } from "./test-support/fake-model-system.js";
import { fakeVllm, type FakeVllm } from "./test-support/fake-vllm.js";

const at = (port: number) => ({ repo: "Qwen/Qwen3-4B", container: "dl-model-1", port });

/** A resolver that answers ::1 for every name, like a host where "localhost" resolves to IPv6 first. */
function preferIpv6(looked: string[]): LookupFunction {
  return ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    looked.push(hostname);
    if (options?.all) callback(null, [{ address: "::1", family: 6 }]);
    else callback(null, "::1", 6);
  }) as unknown as LookupFunction;
}

describe("the smoke test's address", () => {
  let server: FakeVllm | undefined;
  afterEach(async () => { await server?.close(); server = undefined; });

  it("is one explicit IPv4 base URL, unless the deployment names a host", () => {
    assert.equal(modelApiBase({ port: 8000 }), "http://127.0.0.1:8000/v1");
    assert.equal(modelApiBase({ port: 8001, host: "::1" }), "http://[::1]:8001/v1");
    assert.equal(modelApiBase({ port: 8001, host: "10.0.0.5" }), "http://10.0.0.5:8001/v1");
  });

  it("every check reaches the server the readiness probe reached, even where localhost resolves to ::1", async () => {
    // The fake vLLM listens on 127.0.0.1 only, like `docker run -p 127.0.0.1:PORT:8000`.
    server = await fakeVllm({ thinking: "none" });
    const looked: string[] = [];
    const call = createLocalFetch({ lookup: preferIpv6(looked) });
    // The trap: with that resolver, "localhost" never reaches the server.
    const viaLocalhost = await call(`http://localhost:${server.port}/v1/models`).catch((error: NodeJS.ErrnoException) => error);
    assert.ok(viaLocalhost instanceof Error, "localhost goes to ::1, where nothing listens");
    assert.match(String((viaLocalhost as NodeJS.ErrnoException).code), /ECONNREFUSED|EADDRNOTAVAIL|ENETUNREACH/);
    looked.length = 0;

    const log: string[] = [];
    const result = await smokeTest(at(server.port), new FakeModelSystem(), call, { attempts: 1, record: (line) => log.push(line) });
    assert.deepEqual([result.chat, result.tools, result.json], [true, true, true]);
    assert.deepEqual(looked, [], "an IP literal never goes through the resolver");
    const hosts = new Set(server.requests.map((request) => request.host));
    assert.deepEqual([...hosts], [`127.0.0.1:${server.port}`], "the probe and every check use the same host and port");
    assert.deepEqual(server.requests.map((request) => `${request.method} ${request.path}`), [
      "GET /v1/models", "POST /v1/chat/completions", "POST /v1/chat/completions", "POST /v1/chat/completions", "POST /v1/chat/completions",
    ]);
    const base = `http://127.0.0.1:${server.port}/v1`;
    assert.equal(log.length, 5, "one log line per request");
    assert.match(log[0]!, new RegExp(`^smoke ready GET ${base}/models started \\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z: HTTP 200 after \\d+ ms, sent after \\d+ ms$`));
    for (const [index, check] of ["chat", "speed", "tools", "json"].entries()) {
      assert.match(log[index + 1]!, new RegExp(`^smoke ${check} POST ${base}/chat/completions started \\S+Z: HTTP 200 after \\d+ ms, sent after \\d+ ms`));
    }
  });
});

describe("a failing check", () => {
  let server: FakeVllm | undefined;
  let raw: Server | undefined;
  afterEach(async () => {
    await server?.close(); server = undefined;
    if (raw) { raw.closeAllConnections(); await new Promise((resolve) => raw!.close(resolve)); raw = undefined; }
  });

  it("that was sent but never answered is 'no answer', logged with method, URL, start and duration", async () => {
    server = await fakeVllm({ thinking: "none", hangChat: true });
    const log: string[] = [];
    const error = await smokeTest(at(server.port), new FakeModelSystem(), undefined, { attempts: 1, answerMs: 300, record: (line) => log.push(line) }).catch((caught: unknown) => caught);
    assert.ok(error instanceof SmokeError);
    assert.equal(error.message, "Chat test: no answer in 0.3 s");
    assert.equal(error.short, "no answer in 0.3 s");
    assert.ok(server.requests.some((request) => request.path === "/v1/chat/completions"), "the request reached the server");
    const line = log.find((entry) => entry.startsWith("smoke chat"))!;
    assert.match(line, new RegExp(`^smoke chat POST http://127\\.0\\.0\\.1:${server.port}/v1/chat/completions started \\S+Z: FAILED after \\d+ ms, sent after \\d+ ms: no answer in 0\\.3 s$`));
  });

  it("the first chat answer after a fresh start gets the longer budget; later checks keep theirs", async () => {
    // Every non-streaming answer takes 400 ms: within the 1 s first-answer budget, over the 300 ms the others get.
    server = await fakeVllm({ thinking: "none", answerDelayMs: 400 });
    const steps: string[] = [];
    const error = await smokeTest(at(server.port), new FakeModelSystem(), undefined, { attempts: 1, answerMs: 300, chatAnswerMs: 1000,
      onCheck: (check, status, detail) => steps.push(`${status} ${check}${detail ? `: ${detail}` : ""}`) }).catch((caught: unknown) => caught);
    assert.ok(error instanceof SmokeError);
    assert.equal(error.message, "Tool call test: no answer in 0.3 s", "chat passed in 400 ms; the tool call test kept 300 ms");
    assert.deepEqual(steps.slice(2, 4), ["start chat: first answer can take a minute", "done chat"]);
    assert.match(error.curl!, /--max-time 1 /);
    assert.equal(FIRST_ANSWER_MS, 120_000);
  });

  it("logs the HTTP status and a short body excerpt", async () => {
    server = await fakeVllm({ thinking: "none", chatStatus: 503 });
    const log: string[] = [];
    const error = await smokeTest(at(server.port), new FakeModelSystem(), undefined, { attempts: 1, record: (line) => log.push(line) }).catch((caught: unknown) => caught);
    assert.ok(error instanceof SmokeError);
    assert.equal(error.short, "HTTP 503");
    assert.match(log.find((entry) => entry.startsWith("smoke chat"))!, /: HTTP 503 after \d+ ms, sent after \d+ ms: \{"error":\{"message":"model is overloaded, try later"\}\}$/);
  });

  it("that couldn't connect is a connection error with its code, not 'no answer'", async () => {
    // Answers the probe, then stops listening: the chat request is never sent.
    raw = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }), () => { raw!.close(); raw!.closeAllConnections(); });
    });
    await new Promise<void>((resolve) => raw!.listen(0, "127.0.0.1", resolve));
    const port = (raw.address() as AddressInfo).port;
    const log: string[] = [];
    const error = await smokeTest(at(port), new FakeModelSystem(), undefined, { attempts: 1, record: (line) => log.push(line) }).catch((caught: unknown) => caught);
    assert.ok(error instanceof SmokeError);
    assert.equal(error.message, `Chat test: could not reach http://127.0.0.1:${port}/v1/chat/completions (ECONNREFUSED connect ECONNREFUSED 127.0.0.1:${port})`);
    assert.equal(error.short, "connection failed (ECONNREFUSED)");
    assert.match(log.find((entry) => entry.startsWith("smoke chat"))!, /FAILED after \d+ ms, never sent: could not reach .* \[ECONNREFUSED connect ECONNREFUSED 127\.0\.0\.1:\d+\]$/);
  });

  it("that couldn't send within the connect budget says so, not 'no answer'", async () => {
    const call: FetchModel = Object.assign(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/models")) return new Response("{}", { status: 200 });
      // Never connects: waits until aborted.
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    }, { reportsSent: true });
    const log: string[] = [];
    const error = await smokeTest(at(8000), new FakeModelSystem(), call, { attempts: 1, connectMs: 100, answerMs: 5000, record: (line) => log.push(line) }).catch((caught: unknown) => caught);
    assert.ok(error instanceof SmokeError);
    assert.equal(error.message, "Chat test: could not connect to http://127.0.0.1:8000/v1/chat/completions in 0.1 s");
    assert.equal(error.short, "could not connect");
    assert.match(log.find((entry) => entry.startsWith("smoke chat"))!, /never sent: could not connect/);
  });

  it("gets its whole answer budget from when it is sent, not from when it was called", async () => {
    // The chat test takes 800 ms to connect and 200 ms to answer: over a 600 ms budget in
    // total, well within it once sent.
    server = await fakeVllm({ thinking: "none" });
    const real = createLocalFetch();
    let posts = 0;
    const slowConnect: FetchModel = Object.assign(async (url: string, init?: RequestInit) => {
      const slow = !url.endsWith("/models") && posts++ === 0;
      if (slow) await new Promise((resolve) => setTimeout(resolve, 800));
      const response = await real(url, init);
      if (slow) await new Promise((resolve) => setTimeout(resolve, 200));
      return response;
    }, { reportsSent: true });
    const result = await smokeTest(at(server.port), new FakeModelSystem(), slowConnect, { attempts: 1, answerMs: 600, connectMs: 2000 });
    assert.equal(result.chat, true);
  });

  it("prints a single-line curl that reproduces it: same URL, header and JSON body", async () => {
    server = await fakeVllm({ thinking: "reasoning_content", alwaysThinks: true });
    const error = await smokeTest(at(server.port), new FakeModelSystem(), undefined, { attempts: 1 }).catch((caught: unknown) => caught);
    assert.ok(error instanceof SmokeError && error.curl);
    const sent = server.requests.find((request) => request.path === "/v1/chat/completions")!.body!;
    const url = `http://127.0.0.1:${server.port}/v1/chat/completions`;
    assert.equal(error.curl, `curl -sS --max-time 30 -X POST '${url}' -H 'content-type: application/json' -d '${JSON.stringify(sent)}'`);
    assert.doesNotMatch(error.curl, /\n/);
    assert.deepEqual(sent.chat_template_kwargs, NO_THINKING.chat_template_kwargs);
    // Run through a shell, it sends exactly that request (curl itself is replaced by printf).
    const { stdout } = await promisify(execFile)("bash", ["-c", `curl() { printf '%s\\n' "$@"; }; ${error.curl}`]);
    const args = stdout.trimEnd().split("\n");
    assert.deepEqual(args.slice(0, 7), ["-sS", "--max-time", "30", "-X", "POST", url, "-H"]);
    assert.equal(args[7], "content-type: application/json");
    assert.deepEqual(JSON.parse(args[9]!), sent);
  });

  it("quotes apostrophes in the body for the shell", async () => {
    const line = curlLine("POST", "http://127.0.0.1:8000/v1/chat/completions", { content: "it's" });
    const { stdout } = await promisify(execFile)("bash", ["-c", `curl() { printf '%s\\n' "$@"; }; ${line}`]);
    assert.deepEqual(JSON.parse(stdout.trimEnd().split("\n").at(-1)!), { content: "it's" });
  });
});
