import { MODEL_CATALOG, gpuCounts, type ModelRecipe } from "./model-catalog.js";
import { chooseParallelism, type ParallelPlan } from "./model-parallel.js";
import { interconnect } from "./model-topology.js";
import type { Gpu, Hardware } from "./model-runtime.js";
import { recipeFor } from "./model-runtime.js";
import type { System } from "./system.js";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
/** "71.5 GiB": one decimal, so the sums in the plan add up to what's printed. */
export const gib = (bytes: number) => `${(bytes / GiB).toFixed(1)} GiB`;

/** vLLM's default --max-num-batched-tokens, as the recipe's indexer-buffer note uses it ("8192 x 1M x 2 B"). */
const DEFAULT_BATCHED_TOKENS = 8192;
/** Below this much VRAM left per GPU after weights, KV and buffers, the plan calls the fit tight. */
export const TIGHT_BYTES = 4 * GiB;

/**
 * Host RAM a deployment that keeps weights in host memory may use (its container's --memory):
 * those weights (one copy per deployment, e.g. the Engram tables) plus 8 GiB per GPU for each
 * engine worker's own memory (CUDA context, tokenizer, loader buffers). The 8 GiB is dl's
 * allowance, not an engine figure.
 */
export const RAM_PER_GPU_BYTES = 8 * GiB;
export function memoryLimitBytes(model: ModelRecipe, gpuCount: number): number | undefined {
  const offload = model.memory?.offloadBytes;
  return offload ? offload + gpuCount * RAM_PER_GPU_BYTES : undefined;
}

/** Host memory and disk where Docker keeps the model cache volume; undefined where unreadable. */
export interface HostResources {
  ramTotalBytes?: number;
  ramAvailableBytes?: number;
  diskAvailableBytes?: number;
  /** Where the disk figure is from. */
  diskPath: string;
}

/** The machine's RAM (/proc/meminfo) and the free disk under Docker's data root. Read-only. */
export async function hostResources(system: System, dockerRoot = "/var/lib/docker"): Promise<HostResources> {
  const meminfo = await system.readFile("/proc/meminfo").catch(() => undefined);
  const kb = (key: string) => {
    const value = meminfo?.match(new RegExp(`^${key}:\\s+(\\d+) kB`, "m"))?.[1];
    return value ? Number(value) * 1024 : undefined;
  };
  const resources: HostResources = { diskPath: dockerRoot };
  const total = kb("MemTotal");
  const available = kb("MemAvailable");
  if (total) resources.ramTotalBytes = total;
  if (available) resources.ramAvailableBytes = available;
  // Docker's root may not exist yet (no image pulled): df then reports the filesystem it would be on.
  for (const path of [dockerRoot, "/"]) {
    const df = await system.probe("df", ["-B1", "--output=avail,target", path]);
    const avail = df.code === 0 ? df.stdout.trim().split("\n")[1]?.trim().split(/\s+/)[0] : undefined;
    if (avail && /^\d+$/.test(avail)) {
      resources.diskAvailableBytes = Number(avail);
      resources.diskPath = path;
      break;
    }
  }
  return resources;
}

export interface GpuMath {
  index: number;
  totalMiB: number;
  freeMiB: number;
  /** What the engine reserves: gpuMemoryUtilization × total. */
  budgetBytes: number;
  weightsBytes: number;
  kvBytes: number;
  bufferBytes: number;
  /** Budget left for more sequences' KV, activations and CUDA graphs (negative: doesn't fit). */
  leftBytes: number;
  /** The engine can reserve its share of this GPU (free VRAM ≥ budget). */
  free: boolean;
}

export interface Preflight {
  model: ModelRecipe;
  context: number;
  layout: ParallelPlan;
  gpus: GpuMath[];
  weightsBytes: number;
  weightsSource: string;
  offloadBytes: number;
  /** --memory for the container (offload + allowance), when it offloads. */
  ramNeedBytes?: number;
  kvPerToken: number;
  batchedTokens: number;
  /** Everything that's short, in words; empty when it fits. */
  problems: string[];
  /** The nearest options that would fit. */
  suggestions: string[];
  /** Fits, but with little room: worth saying. */
  warnings: string[];
}

export interface PreflightInput {
  model: ModelRecipe;
  context: number;
  hardware: Hardware;
  /** The GPUs it may use (the --gpus subset, or all). */
  usable: readonly Gpu[];
  host: HostResources;
  /** The repo's weights in bytes from the Hugging Face API, when it answered. */
  liveWeightsBytes?: number | undefined;
  /** The container memory limit the deployment gets (offload + allowance). */
  ramNeedBytes?: number | undefined;
}

const compareVersion = (a: string, b: string) => {
  const [x = [], y = []] = [a.split(".").map(Number), b.split(".").map(Number)];
  for (let index = 0; index < Math.max(x.length, y.length); index++) {
    const diff = (x[index] ?? 0) - (y[index] ?? 0);
    if (diff) return diff;
  }
  return 0;
};

/** Per-GPU memory for a layout: weights split evenly over the GPUs, KV (whole or split) and context buffers. */
function perGpu(model: ModelRecipe, context: number, layout: ParallelPlan, hardware: Hardware, weightsBytes: number, offloadBytes: number, batchedTokens: number): GpuMath[] {
  const memory = model.memory!;
  const count = layout.gpus.length;
  const weights = (weightsBytes - offloadBytes) / count;
  const kv = memory.kvBytesPerToken * context / (memory.kvWhole ? 1 : count);
  const buffer = memory.contextBuffer ? memory.contextBuffer.bytesPerCell * batchedTokens * context : 0;
  return layout.gpus.map((index) => {
    const gpu = hardware.gpus.find((item) => item.index === index)!;
    const budget = model.gpuMemoryUtilization * gpu.totalMiB * MiB;
    return { index, totalMiB: gpu.totalMiB, freeMiB: gpu.freeMiB, budgetBytes: budget, weightsBytes: weights, kvBytes: kv, bufferBytes: buffer,
      leftBytes: budget - weights - kv - buffer, free: gpu.freeMiB >= Math.ceil(model.gpuMemoryUtilization * gpu.totalMiB) };
  });
}

/** The longest context (a multiple of 1024, at least 512) whose KV and buffers fit beside the weights on every GPU. */
function longestContext(model: ModelRecipe, gpus: readonly GpuMath[], batchedTokens: number, count: number): number {
  const memory = model.memory!;
  const perToken = memory.kvBytesPerToken / (memory.kvWhole ? 1 : count) + (memory.contextBuffer ? memory.contextBuffer.bytesPerCell * batchedTokens : 0);
  const room = Math.min(...gpus.map((gpu) => gpu.budgetBytes - gpu.weightsBytes - TIGHT_BYTES));
  if (room <= 0 || perToken <= 0) return 0;
  return Math.min(model.maxContext ?? model.defaultContext, Math.floor(room / perToken / 1024) * 1024);
}

const kTokens = (context: number) => context % 1048576 === 0 ? `${context / 1048576}M` : context >= 1024 && context % 1024 === 0 ? `${context / 1024}k` : String(context);

/**
 * Whether `model` fits before anything is downloaded: VRAM per GPU (weights, KV cache at the
 * context, context-sized buffers), host RAM for offloaded weights, disk for the weights, and the
 * driver's CUDA version for the image. Says exactly what's short and the nearest option that fits.
 */
export function preflight(input: PreflightInput, siblings = true): Preflight | undefined {
  const { model, context, hardware, usable, host } = input;
  const memory = model.memory;
  if (!memory) return undefined;
  const weightsBytes = input.liveWeightsBytes ?? memory.weightsBytes;
  const weightsSource = input.liveWeightsBytes !== undefined ? "Hugging Face API, now" : memory.weightsSource;
  const offloadBytes = memory.offloadBytes ?? 0;
  const resolved = recipeFor(model, usable[0]?.computeCap);
  const batchedAt = resolved.flags.indexOf("--max-num-batched-tokens");
  const batchedTokens = batchedAt === -1 ? DEFAULT_BATCHED_TOKENS : Number(resolved.flags[batchedAt + 1]);
  const problems: string[] = [];
  const suggestions: string[] = [];
  const warnings: string[] = [];
  // The layout over the usable GPUs. When the model doesn't fit them, the largest supported count
  // that's there (or all of them) is still planned, to show what's short.
  const layout: ParallelPlan = chooseParallelism(model, usable, hardware.topology) ?? (() => {
    const size = gpuCounts(model).find((item) => item <= usable.length) ?? usable.length;
    const chosen = [...usable].sort((x, y) => y.totalMiB - x.totalMiB || x.index - y.index).slice(0, size).map((gpu) => gpu.index).sort((x, y) => x - y);
    return { gpus: chosen, interconnect: interconnect(hardware.topology, chosen), tp: chosen.length, pp: 1, ep: false, why: "doesn't fit these GPUs" };
  })();
  const count = layout.gpus.length;
  const gpus = perGpu(model, context, layout, hardware, weightsBytes, offloadBytes, batchedTokens);
  const kvText = `${gib(gpus[0]!.kvBytes)} KV${gpus[0]!.bufferBytes ? ` + ${gib(gpus[0]!.bufferBytes)} indexer buffer` : ""} at ${kTokens(context)}`;

  // GPUs: too few for any supported count, short of VRAM, or busy.
  const counts = gpuCounts(model);
  if (usable.length < Math.min(...counts)) problems.push(`needs ${Math.min(...counts)} GPUs (runs on ${[...counts].reverse().join(", ")}); ${usable.length === 1 ? "1 GPU is" : `${usable.length} GPUs are`} available`);
  const overfull = gpus.filter((gpu) => gpu.leftBytes < 0);
  if (overfull.length) {
    const pct = `${Math.round(model.gpuMemoryUtilization * 100)}%`;
    const same = overfull.length === gpus.length && new Set(gpus.map((gpu) => gpu.totalMiB)).size === 1;
    problems.push(`needs ${count}x ${gib(gpus[0]!.weightsBytes)} for weights + ${kvText} per GPU; ${same
      ? `each GPU reserves ${gib(gpus[0]!.budgetBytes)} (${pct} of ${gib(gpus[0]!.totalMiB * MiB)})`
      : overfull.map((gpu) => `GPU ${gpu.index} reserves ${gib(gpu.budgetBytes)} (${pct} of ${gib(gpu.totalMiB * MiB)})`).join(", ")}`);
  }
  for (const gpu of gpus.filter((item) => !item.free)) problems.push(`GPU ${gpu.index} has ${gib(gpu.freeMiB * MiB)} free; the engine reserves ${gib(gpu.budgetBytes)}`);
  if (!overfull.length) for (const gpu of gpus.filter((item) => item.leftBytes < TIGHT_BYTES)) warnings.push(`GPU ${gpu.index} keeps only ${gib(gpu.leftBytes)} for more sequences, activations and CUDA graphs`);

  // Host RAM for the offloaded weights.
  const ramNeedBytes = input.ramNeedBytes;
  if (ramNeedBytes && host.ramAvailableBytes !== undefined && ramNeedBytes > host.ramAvailableBytes) {
    problems.push(`system RAM: needs ${gib(ramNeedBytes)} (${gib(offloadBytes)} offloaded + ${gib(ramNeedBytes - offloadBytes)} for ${count} GPU workers), has ${gib(host.ramAvailableBytes)} available of ${gib(host.ramTotalBytes ?? host.ramAvailableBytes)}`);
  }
  // Disk for the weights (the cache may already hold some: then it needs less).
  if (host.diskAvailableBytes !== undefined && weightsBytes > host.diskAvailableBytes) {
    problems.push(`disk: needs ${gib(weightsBytes)} for the weights, ${host.diskPath} has ${gib(host.diskAvailableBytes)} free (less is needed if they're already in the cache)`);
  }
  // The driver must run the image's CUDA.
  if (model.minCuda && compareVersion(hardware.cuda, model.minCuda) < 0) problems.push(`the Nvidia driver supports CUDA ${hardware.cuda}; ${model.image} needs CUDA ${model.minCuda} (driver R580 or newer)`);

  if (problems.length) {
    // Nearest options that fit: a shorter context, a sibling quantization, more GPUs.
    const longest = longestContext(model, gpus, batchedTokens, count);
    if (overfull.length && longest >= 512 && longest < context) suggestions.push(`a shorter context: --context ${longest}`);
    const family = model.id.replace(/-fp\d+$/, "");
    for (const sibling of siblings ? MODEL_CATALOG.filter((entry) => entry !== model && entry.id.replace(/-fp\d+$/, "") === family && entry.memory) : []) {
      const theirs = preflight({ ...input, model: sibling, context: Math.min(context, sibling.maxContext ?? sibling.defaultContext), liveWeightsBytes: undefined,
        ramNeedBytes: memoryLimitBytes(sibling, count) }, false);
      if (theirs && theirs.problems.length === 0) suggestions.push(`${sibling.id}${sibling.blocked ? ` (once it can run: ${sibling.blocked})` : ""}`);
    }
    const more = counts.filter((size) => size > count).sort((a, b) => a - b)[0];
    if (overfull.length && more) suggestions.push(`more GPUs: it also runs on ${more}${hardware.gpus.length >= more ? ` (this machine has ${hardware.gpus.length}; widen --gpus)` : ` (this machine has ${hardware.gpus.length})`}`);
  }
  return { model, context, layout, gpus, weightsBytes, weightsSource, offloadBytes, ...(ramNeedBytes ? { ramNeedBytes } : {}), kvPerToken: memory.kvBytesPerToken,
    batchedTokens, problems, suggestions, warnings };
}

/** One error for a preflight that doesn't fit: what's short, and what would fit. */
export function preflightError(result: Preflight): Error {
  const lines = [`${result.model.id} doesn't fit: ${result.problems.join("; ")}.`];
  if (result.suggestions.length) lines.push(`Nearest that fits: ${result.suggestions.join("; ")}.`);
  return new Error(lines.join("\n"));
}

