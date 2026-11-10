import type { ModelDeployment } from "./state.js";
import type { System } from "./system.js";
import { logTail } from "./model-runtime.js";

export type FetchModel = (url: string, init?: RequestInit) => Promise<Response>;

/** Check the actual OpenAI-compatible API rather than trusting a healthy container alone. */
export async function smokeTest(deployment: Pick<ModelDeployment, "repo" | "port" | "container">, system: System, call: FetchModel = fetch, options: { attempts?: number; delay?: (ms: number) => Promise<void> } = {}): Promise<ModelDeployment["lastTest"]> {
  const url = `http://127.0.0.1:${deployment.port}/v1/chat/completions`;
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const request = async (extra: Record<string, unknown>) => {
    const started = performance.now();
    const response = await call(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: deployment.repo, messages: [{ role: "user", content: "Reply briefly." }], max_tokens: 256, ...extra }), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return { body: await response.json() as { choices?: Array<{ message?: { content?: string; tool_calls?: unknown[] } }>; usage?: { completion_tokens?: number } }, seconds: (performance.now() - started) / 1000 };
  };
  /** Decode-only throughput: stream the chat reply and divide completion tokens by (last token time - first token time), excluding TTFT. */
  const streamingChat = async (): Promise<{ content: string; tokensPerSecond: number }> => {
    const response = await call(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: deployment.repo, messages: [{ role: "user", content: "Reply briefly." }], max_tokens: 256, stream: true, stream_options: { include_usage: true } }), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    if (!response.body) throw new Error("Chat stream had no body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let completionTokens = 0;
    let firstTokenAt: number | undefined;
    let lastTokenAt: number | undefined;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const event of events) {
        const line = event.split("\n").find((part) => part.startsWith("data:"));
        if (!line) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string | null; reasoning_content?: string | null } }>; usage?: { completion_tokens?: number } };
        const delta = parsed.choices?.[0]?.delta;
        if ((delta?.reasoning_content ?? "") + (delta?.content ?? "")) {
          const now = performance.now();
          if (firstTokenAt === undefined) firstTokenAt = now;
          lastTokenAt = now;
          content += delta?.content ?? "";
        }
        if (parsed.usage?.completion_tokens) completionTokens = parsed.usage.completion_tokens;
      }
    }
    const decodeSeconds = firstTokenAt !== undefined && lastTokenAt !== undefined ? (lastTokenAt - firstTokenAt) / 1000 : 0;
    const tokensPerSecond = Math.round(completionTokens / Math.max(decodeSeconds, 0.001) * 10) / 10;
    return { content, tokensPerSecond };
  };
  try {
    let chat: { content: string; tokensPerSecond: number } | undefined;
    for (let attempt = 0; attempt < (options.attempts ?? 60); attempt++) {
      try { chat = await streamingChat(); break; } catch (error) {
        if (attempt === (options.attempts ?? 60) - 1) throw error;
        await delay(5000);
      }
    }
    if (!chat?.content.trim()) throw new Error("Chat returned no text");
    const tool = await request({ messages: [{ role: "user", content: "Call ping with value 1." }], chat_template_kwargs: { enable_thinking: false },
    // Thinking models (Qwen3 base) burn their reply on <think> tokens or leak them into content; disable thinking for the structured checks.
      tools: [{ type: "function", function: { name: "ping", description: "Check a value", parameters: { type: "object", properties: { value: { type: "integer" } }, required: ["value"] } } }], tool_choice: { type: "function", function: { name: "ping" } } });
    const calls = tool.body.choices?.[0]?.message?.tool_calls as Array<{ function?: { name?: string; arguments?: string } }> | undefined;
    if (calls?.[0]?.function?.name !== "ping" || !calls[0].function?.arguments || JSON.parse(calls[0].function.arguments).value !== 1) throw new Error("Tool call did not return ping(1)");
    const json = await request({ messages: [{ role: "user", content: "Return JSON with ok true." }], response_format: { type: "json_object" }, chat_template_kwargs: { enable_thinking: false } });
    const text = String(json.body.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (JSON.parse(text || "null")?.ok !== true) throw new Error("JSON mode did not return {ok:true}");
    return { chat: true, tools: true, json: true, tokensPerSecond: chat.tokensPerSecond, at: new Date().toISOString() };
  } catch (error) {
    throw new Error(`Smoke test failed for ${deployment.repo}: ${error instanceof Error ? error.message : String(error)}\nvLLM logs (${deployment.container}):\n${await logTail(system, deployment.container)}`);
  }
}
