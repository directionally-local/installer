import { fitGpus, type EngineId, type ModelRecipe } from "./model-catalog.js";
import type { Gpu } from "./model-runtime.js";
import { interconnect, type Interconnect, type Topology } from "./model-topology.js";

/**
 * How a model is spread over its GPUs: tp × pp GPUs serve one copy of the model.
 */
export interface ParallelPlan {
  /** Host GPU indices the deployment uses (and the only ones its container sees). */
  gpus: number[];
  interconnect: Interconnect;
  tp: number;
  pp: number;
  /** Experts placed whole on each GPU instead of sliced (MoE models only). */
  ep: boolean;
  /** Why, in a sentence for the plan, with the doc it follows. */
  why: string;
}

/**
 * The engine guidance the layouts follow, from vLLM's "Parallelism and Scaling" page
 * (https://docs.vllm.ai/en/latest/serving/parallelism_scaling.html): "if the model is too large
 * for a single GPU but fits on a single node with multiple GPUs, use tensor parallelism", and
 * "if the GPUs on the node do not have NVLINK interconnect (e.g. L40S), leverage pipeline
 * parallelism" for "higher throughput and lower communication overhead". SGLang's docs give no
 * PCIe-specific advice (none found as of Nov 2026), so the same rule applies to it. A model's
 * own recipe overrides it (`parallel.pcie`), with its source in the catalog.
 */
export const VLLM_DOCS = "https://docs.vllm.ai/en/latest/serving/parallelism_scaling.html";

/** The engine flags for a layout; none for one GPU, so single-GPU commands stay as they were. */
export function parallelFlags(plan: Pick<ParallelPlan, "tp" | "pp" | "ep"> | undefined, engine: EngineId = "vllm"): string[] {
  if (!plan) return [];
  const flags: string[] = [];
  if (engine === "sglang") {
    if (plan.tp > 1) flags.push("--tp-size", String(plan.tp));
    if (plan.pp > 1) flags.push("--pp-size", String(plan.pp));
    if (plan.ep) flags.push("--ep-size", String(plan.tp));
    return flags;
  }
  if (plan.tp > 1) flags.push("--tensor-parallel-size", String(plan.tp));
  if (plan.pp > 1) flags.push("--pipeline-parallel-size", String(plan.pp));
  if (plan.ep) flags.push("--enable-expert-parallel");
  return flags;
}

/** One GPU, or tensor parallel over NVLink: the engines' default single-node layout. */
function tensorParallel(model: ModelRecipe, gpus: number[], link: Interconnect): ParallelPlan {
  const ep = gpus.length > 1 && model.parallel?.ep === true;
  return { gpus, interconnect: link, tp: gpus.length, pp: 1, ep,
    why: gpus.length === 1 ? "one GPU" : `tensor parallel over ${gpus.length} GPUs (${link.text})${ep ? ", experts split whole across GPUs (expert parallel)" : ""}` };
}

/**
 * Picks the GPUs and the layout for `model` on these GPUs (all usable ones, or the --gpus
 * subset). Over NVLink: tensor parallel over all of them. Over PCIe only: what the model's
 * entry says works for PCIe (`pcie`), else pipeline parallel as vLLM's docs advise for GPUs
 * without NVLink. Undefined when the model doesn't fit.
 */
export function chooseParallelism(model: ModelRecipe, gpus: readonly Gpu[], topology: Topology | undefined, engine: EngineId = model.engine ?? "vllm"): ParallelPlan | undefined {
  const chosen = fitGpus(model, gpus);
  if (!chosen) return undefined;
  const indices = chosen.map((gpu) => gpu.index);
  const link = interconnect(topology, indices);
  if (indices.length === 1 || link.kind === "nvlink") return tensorParallel(model, indices, link);
  if (model.parallel?.pcie === "tp") {
    return { ...tensorParallel(model, indices, link), why: `tensor parallel over ${indices.length} GPUs (${link.text}): ${model.parallel.pcieWhy ?? "the model's recipe uses it"}` };
  }
  // Pipeline parallel: each GPU holds whole layers, so only activations between stages cross PCIe.
  return { gpus: indices, interconnect: link, tp: 1, pp: indices.length, ep: false,
    why: `pipeline parallel over ${indices.length} GPUs (${link.text}): ${engine === "sglang" ? "pipeline" : "vLLM's docs advise pipeline"} over tensor parallel for GPUs without NVLink` };
}
