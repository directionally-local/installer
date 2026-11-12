import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A fake vLLM OpenAI-compatible server for the smoke test. By default it behaves like
 * Qwen/Qwen3-4B served with `--reasoning-parser qwen3`: unless a request turns thinking off
 * (chat_template_kwargs.enable_thinking: false), the whole reply is reasoning_content and the
 * tokens run out (finish_reason "length"), which is what failed on a real GPU.
 */
export interface FakeVllmOptions {
  /** /v1/models answers 503 this many times first (still loading). */
  notReadyFor?: number;
  /** How a reply with thinking left on looks. */
  thinking?: "reasoning_content" | "inline" | "none";
  /** Thinking even when asked not to (a model that ignores the switch). */
  alwaysThinks?: boolean;
  /** finish_reason for thinking-only replies. */
  thinkingFinish?: "length" | "stop";
  /** Content for a non-thinking chat reply. */
  chatText?: string;
}

export interface FakeVllm {
  url: string;
  port: number;
  requests: Array<{ path: string; body?: Record<string, unknown> }>;
  close: () => Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  let text = "";
  for await (const chunk of req) text += String(chunk);
  return text ? JSON.parse(text) as Record<string, unknown> : undefined;
}

export async function fakeVllm(options: FakeVllmOptions = {}): Promise<FakeVllm> {
  const requests: FakeVllm["requests"] = [];
  let notReady = options.notReadyFor ?? 0;
  const thinking = options.thinking ?? "reasoning_content";
  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      requests.push({ path: req.url ?? "", ...(body ? { body } : {}) });
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.url === "/v1/models") {
        if (notReady > 0) { notReady--; return json(503, { error: "loading" }); }
        return json(200, { object: "list", data: [{ id: "Qwen/Qwen3-4B", object: "model" }] });
      }
      if (req.url !== "/v1/chat/completions" || !body) return json(404, {});
      const kwargs = body.chat_template_kwargs as { enable_thinking?: boolean } | undefined;
      const thinks = thinking !== "none" && (options.alwaysThinks || kwargs?.enable_thinking !== false);
      const thought = "Okay, the user wants a short reply. Let me think about what to say";
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
        if (thinks && thinking === "reasoning_content") send({ choices: [{ delta: { reasoning_content: thought } }] });
        else if (thinks) { send({ choices: [{ delta: { content: "<thi" } }] }); send({ choices: [{ delta: { content: `nk>${thought}` } }] }); }
        else { send({ choices: [{ delta: { content: "1 2 3" } }] }); send({ choices: [{ delta: { content: " 4 5" } }] }); }
        send({ choices: [{ delta: {}, finish_reason: thinks ? options.thinkingFinish ?? "length" : "stop" }] });
        send({ choices: [], usage: { completion_tokens: 12 } });
        res.end("data: [DONE]\n\n");
        return;
      }
      if (body.tools) {
        return json(200, { choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "ping", arguments: "{\"value\":1}" } }] }, finish_reason: "tool_calls" }] });
      }
      if (body.response_format) {
        return json(200, { choices: [{ message: { content: thinks && thinking === "inline" ? `<think>${thought}</think>{"ok":true}` : "{\"ok\":true}" }, finish_reason: "stop" }] });
      }
      if (thinks) {
        const message = thinking === "reasoning_content" ? { content: null, reasoning_content: thought } : { content: `<think>${thought}` };
        return json(200, { choices: [{ message, finish_reason: options.thinkingFinish ?? "length" }] });
      }
      return json(200, { choices: [{ message: { content: options.chatText ?? "Ready." }, finish_reason: "stop" }] });
    })().catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, port, requests, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
