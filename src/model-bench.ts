import type { ModelDeployment } from "./state.js";
import type { System } from "./system.js";
import type { FetchModel } from "./model-smoke.js";

export interface BenchLevel { concurrency: number; requests: number; ttftP50: number; ttftP95: number; decodeTokPerSec: number }
export interface BenchResult { levels: BenchLevel[]; prefixCacheHitRate?: number }

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index]! * 1000) / 1000;
};

/** One streaming request: TTFT plus decode-only tok/s, exactly like the smoke test measurement. */
async function one(url: string, repo: string, call: FetchModel): Promise<{ ttft: number; tokPerSec: number }> {
  const started = performance.now();
  const response = await call(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: repo, messages: [{ role: "user", content: "Count from 1 to 200, separated by spaces." }], max_tokens: 512, stream: true, stream_options: { include_usage: true } }), signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  if (!response.body) throw new Error("Stream had no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstTokenAt: number | undefined;
  let lastTokenAt: number | undefined;
  let completionTokens = 0;
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
      }
      if (parsed.usage?.completion_tokens) completionTokens = parsed.usage.completion_tokens;
    }
  }
  if (firstTokenAt === undefined) throw new Error("No tokens received");
  const decodeSeconds = (lastTokenAt! - firstTokenAt) / 1000;
  // Single-chunk replies collapse the decode window; floor it so tok/s stays plausible.
  return { ttft: (firstTokenAt - started) / 1000, tokPerSec: completionTokens / Math.max(decodeSeconds, 0.05) };
}

/** Concurrency sweep against the active model: TTFT p50/p95 and aggregate decode throughput per level. */
export async function bench(deployment: Pick<ModelDeployment, "repo" | "port" | "container">, system: System, call: FetchModel = fetch, options: { levels?: number[] } = {}): Promise<BenchResult> {
  const url = `http://127.0.0.1:${deployment.port}/v1/chat/completions`;
  const levels: BenchLevel[] = [];
  for (const concurrency of options.levels ?? [1, 8, 32]) {
    const results = await Promise.all(Array.from({ length: concurrency }, () => one(url, deployment.repo, call)));
    levels.push({ concurrency, requests: results.length,
      ttftP50: percentile(results.map((r) => r.ttft), 50), ttftP95: percentile(results.map((r) => r.ttft), 95),
      decodeTokPerSec: Math.round(results.reduce((sum, r) => sum + r.tokPerSec, 0) * 10) / 10 });
  }
  let prefixCacheHitRate: number | undefined;
  const logs = await system.probe("docker", ["logs", "--tail", "200", deployment.container]).catch(() => undefined);
  const matches = [...(logs ? logs.stdout + logs.stderr : "").matchAll(/Prefix cache hit rate: ([\d.]+)%/g)];
  if (matches.length) prefixCacheHitRate = Number(matches[matches.length - 1]![1]);
  return { levels, ...(prefixCacheHitRate !== undefined ? { prefixCacheHitRate } : {}) };
}
