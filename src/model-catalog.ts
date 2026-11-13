/** The serving engines dl can run a model with; the catalog entry picks one. */
export type EngineId = "vllm" | "sglang";

/**
 * How a model spreads over several GPUs. Without it a model runs on one GPU, as every model
 * did before multi-GPU support.
 */
export interface ParallelSupport {
  /** GPUs per model copy the model runs at, as tensor-parallel sizes (the engine shards weights over them). */
  tp: readonly number[];
  /** A mixture-of-experts model whose experts can be placed whole on each GPU (expert parallel) instead of sliced. */
  ep?: boolean;
  /**
   * The layout over PCIe-only GPUs when the model's own recipe names one ("tp"), with the
   * reason and source for the plan; absent: the engine's generic advice (pipeline parallel).
   */
  pcie?: "tp" | "pp";
  pcieWhy?: string;
}

/** Curated, pinned recipes. VRAM is per GPU, with room for KV cache and startup. */
export interface ModelRecipe {
  id: string;
  repo: string;
  /** VRAM each GPU it runs on needs. */
  minVramMiB: number;
  /** VRAM all its GPUs need together (multi-GPU models); defaults to minVramMiB. */
  minTotalVramMiB?: number;
  /** Multi-GPU support; absent: one GPU. */
  parallel?: ParallelSupport;
  /** Defaults to vLLM. */
  engine?: EngineId;
  /** Fraction of GPU VRAM vLLM reserves; low enough for small models to allow side-by-side updates. */
  gpuMemoryUtilization: number;
  image: string;
  flags: readonly string[];
  defaultContext: number;
}

const IMAGE = "vllm/vllm-openai:v0.20.0";
/** First is the default pick: qwen-new answers without a thinking phase, so it is the safer start. */
export const MODEL_CATALOG: readonly ModelRecipe[] = [
  { id: "qwen-new", repo: "Qwen/Qwen3-4B-Instruct-2507", minVramMiB: 16384, gpuMemoryUtilization: 0.4, image: IMAGE,
    flags: ["--tool-call-parser", "hermes", "--enable-auto-tool-choice", "--max-model-len", "32768"], defaultContext: 32768 },
  { id: "qwen-old", repo: "Qwen/Qwen3-4B", minVramMiB: 12288, gpuMemoryUtilization: 0.4, image: IMAGE,
    flags: ["--tool-call-parser", "hermes", "--enable-auto-tool-choice", "--reasoning-parser", "qwen3", "--max-model-len", "32768"], defaultContext: 32768 },
  { id: "glm-flash", repo: "zai-org/GLM-4.7-Flash", minVramMiB: 49152, gpuMemoryUtilization: 0.9, image: IMAGE,
    flags: ["--tool-call-parser", "glm47", "--enable-auto-tool-choice", "--reasoning-parser", "glm47", "--max-model-len", "8192", "--quantization", "fp8"], defaultContext: 8192 },
];

/** The part of a GPU the catalog's fit check needs. */
export interface GpuSize { index: number; totalMiB: number }

/** GPU counts a model runs at, largest first. */
export function gpuCounts(model: ModelRecipe): number[] {
  return [...new Set(model.parallel?.tp ?? [1])].sort((a, b) => b - a);
}

/**
 * The GPUs a model would run on: the most GPUs it supports (more GPUs, more room for KV
 * cache), taken from the largest, each with its per-GPU minimum and together with its total.
 * Undefined when no supported count fits.
 */
export function fitGpus<T extends GpuSize>(model: ModelRecipe, gpus: readonly T[]): T[] | undefined {
  const largest = [...gpus].sort((a, b) => b.totalMiB - a.totalMiB || a.index - b.index);
  for (const count of gpuCounts(model)) {
    if (count > largest.length) continue;
    const chosen = largest.slice(0, count);
    const total = chosen.reduce((sum, gpu) => sum + gpu.totalMiB, 0);
    if (chosen.every((gpu) => gpu.totalMiB >= model.minVramMiB) && total >= (model.minTotalVramMiB ?? model.minVramMiB)) {
      return chosen.sort((a, b) => a.index - b.index);
    }
  }
  return undefined;
}

/**
 * Models that fit these GPUs (all usable ones, or the --gpus subset). A number is one GPU of
 * that many MiB, as before multi-GPU support.
 */
export function fittingModels(gpus: number | readonly GpuSize[]): ModelRecipe[] {
  const list = typeof gpus === "number" ? [{ index: 0, totalMiB: gpus }] : gpus;
  return MODEL_CATALOG.filter((entry) => fitGpus(entry, list) !== undefined);
}

export function recipe(id: string): ModelRecipe {
  const found = MODEL_CATALOG.find((entry) => entry.id === id || entry.repo === id);
  if (!found) throw new Error(`Unknown model "${id}". Choose one of: ${MODEL_CATALOG.map((entry) => entry.id).join(", ")}`);
  return found;
}
