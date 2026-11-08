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
  try {
    let chat: Awaited<ReturnType<typeof request>> | undefined;
    for (let attempt = 0; attempt < (options.attempts ?? 60); attempt++) {
      try { chat = await request({}); break; } catch (error) {
        if (attempt === (options.attempts ?? 60) - 1) throw error;
        await delay(5000);
      }
    }
    if (!chat?.body.choices?.[0]?.message?.content?.trim()) throw new Error("Chat returned no text");
    const tool = await request({ messages: [{ role: "user", content: "Call ping with value 1." }],
      tools: [{ type: "function", function: { name: "ping", description: "Check a value", parameters: { type: "object", properties: { value: { type: "integer" } }, required: ["value"] } } }], tool_choice: { type: "function", function: { name: "ping" } } });
    const calls = tool.body.choices?.[0]?.message?.tool_calls as Array<{ function?: { name?: string; arguments?: string } }> | undefined;
    if (calls?.[0]?.function?.name !== "ping" || !calls[0].function?.arguments || JSON.parse(calls[0].function.arguments).value !== 1) throw new Error("Tool call did not return ping(1)");
    const json = await request({ messages: [{ role: "user", content: "Return JSON with ok true." }], response_format: { type: "json_object" } });
    if (JSON.parse(json.body.choices?.[0]?.message?.content ?? "null")?.ok !== true) throw new Error("JSON mode did not return {ok:true}");
    return { chat: true, tools: true, json: true, tokensPerSecond: Math.round((chat.body.usage?.completion_tokens ?? 0) / Math.max(chat.seconds, 0.001) * 10) / 10, at: new Date().toISOString() };
  } catch (error) {
    throw new Error(`Smoke test failed for ${deployment.repo}: ${error instanceof Error ? error.message : String(error)}\nvLLM logs (${deployment.container}):\n${await logTail(system, deployment.container)}`);
  }
}
