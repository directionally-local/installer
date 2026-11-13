import type { EngineId, ModelRecipe } from "./model-catalog.js";
import { parallelFlags, type ParallelPlan } from "./model-parallel.js";

/**
 * A serving engine behind dl model: how its container is started and read. Both serve the
 * OpenAI-compatible API under /v1 (models, chat completions with tools, JSON mode, streaming
 * with usage), so readiness, smoke tests and bench are the same for both.
 */
export interface Engine {
  id: EngineId;
  /** For people: "vLLM", "SGLang". */
  label: string;
  /** The port the API listens on inside the container. */
  containerPort: number;
  /** The flag the context length goes in (a recipe's own value is replaced by the chosen one). */
  contextFlag: string;
  /** Everything after the image: the server command (if the image has no entrypoint for it) and its flags. */
  serve(model: Pick<ModelRecipe, "repo" | "gpuMemoryUtilization">, flags: readonly string[], context: number, parallel?: Pick<ParallelPlan, "tp" | "pp" | "ep">): string[];
  /** A log line meaning the weights are downloaded and loading (or the server is up). */
  loading: RegExp;
  /** The prefix cache hit rate (%) from recent logs, when the engine logs it. */
  prefixCacheHitRate(logs: string): number | undefined;
}

/**
 * vLLM: the image's entrypoint is the OpenAI server, so only flags follow it
 * (https://docs.vllm.ai/en/latest/deployment/docker.html: "vllm/vllm-openai:latest --model …").
 */
export const VLLM: Engine = {
  id: "vllm",
  label: "vLLM",
  containerPort: 8000,
  contextFlag: "--max-model-len",
  serve: (model, flags, context, parallel) => ["--model", model.repo, "--served-model-name", model.repo, ...flags, "--max-model-len", String(context),
    "--gpu-memory-utilization", String(model.gpuMemoryUtilization), ...parallelFlags(parallel)],
  loading: /Loading safetensors checkpoint shards|Loading weights took|Model loading took|Starting vLLM API server/,
  prefixCacheHitRate: (logs) => {
    const matches = [...logs.matchAll(/Prefix cache hit rate: ([\d.]+)%/g)];
    return matches.length ? Number(matches[matches.length - 1]![1]) : undefined;
  },
};

/**
 * SGLang, from its docs (https://docs.sglang.io/docs/get-started/install.md and the server
 * arguments page): image lmsysorg/sglang, server `python3 -m sglang.launch_server --model-path …
 * --host 0.0.0.0 --port 30000`, `--context-length`, `--mem-fraction-static` ("The fraction of the
 * memory used for static allocation (model weights and KV cache memory pool)"), `--tp-size`,
 * `--pp-size`, `--ep-size`. It serves /v1/models and the OpenAI chat API (tools, response_format
 * json_object, stream_options include_usage, chat_template_kwargs, ignore_eos), and logs "The
 * server is fired up and ready to roll!" when ready.
 */
export const SGLANG: Engine = {
  id: "sglang",
  label: "SGLang",
  containerPort: 30000,
  contextFlag: "--context-length",
  serve: (model, flags, context, parallel) => ["python3", "-m", "sglang.launch_server", "--model-path", model.repo, "--served-model-name", model.repo,
    "--host", "0.0.0.0", "--port", "30000", ...flags, "--context-length", String(context),
    "--mem-fraction-static", String(model.gpuMemoryUtilization), ...parallelFlags(parallel, "sglang")],
  loading: /The server is fired up and ready to roll/,
  /**
   * Prefill lines read "Prefill batch, #new-seq: 1, #new-token: 64, #cached-token: 49216, …"
   * (as quoted in https://github.com/sgl-project/sglang/discussions/21117; not in the docs): the
   * share of prompt tokens served from the radix cache.
   */
  prefixCacheHitRate: (logs) => {
    let cached = 0;
    let fresh = 0;
    for (const match of logs.matchAll(/#new-token: (\d+), #cached-token: (\d+)/g)) {
      fresh += Number(match[1]);
      cached += Number(match[2]);
    }
    return cached + fresh > 0 ? Math.round(cached / (cached + fresh) * 1000) / 10 : undefined;
  },
};

export function engine(id: EngineId | undefined): Engine {
  return id === "sglang" ? SGLANG : VLLM;
}
