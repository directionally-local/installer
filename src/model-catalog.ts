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
  /** Fraction of GPU VRAM the engine reserves; low enough for small models to allow side-by-side updates. */
  gpuMemoryUtilization: number;
  image: string;
  /** The engine's flags, for the entry's engine; the context flag is replaced by the chosen context. */
  flags: readonly string[];
  /** Environment for the container (`-e NAME=value`). */
  env?: Readonly<Record<string, string>>;
  /** Extra flags and environment by GPU family (compute capability major version: "9" Hopper, "10"/"12" Blackwell). */
  byGpu?: ReadonlyArray<{ computeCaps: readonly string[]; label: string; flags?: readonly string[]; env?: Readonly<Record<string, string>> }>;
  defaultContext: number;
  /** The longest context it may be started with; defaults to defaultContext. */
  maxContext?: number;
  /** What the memory and disk checks need (multi-GPU entries). */
  memory?: ModelMemory;
  /** Lowest CUDA version the driver must support for the image (CUDA 13 images need an R580+ driver). */
  minCuda?: string;
  /** Not startable yet, and why (the plan still shows it). */
  blocked?: string;
  /** Known caveats, shown in the plan and before a start; `computeCaps` limits one to those GPUs. */
  caveats?: ReadonlyArray<{ computeCaps?: readonly string[]; text: string }>;
}

/** Sizes from the model's files and docs, for the preflight. Each value says where it comes from. */
export interface ModelMemory {
  /** The repo's *.safetensors bytes (Hugging Face API), used when the API can't be reached. */
  weightsBytes: number;
  weightsSource: string;
  /** Bytes of the weights kept in host RAM instead of VRAM (e.g. Engram tables), one copy per deployment. */
  offloadBytes?: number;
  offloadSource?: string;
  /** KV cache bytes per token of context, for one sequence. */
  kvBytesPerToken: number;
  /** Whether every GPU holds the whole KV (one KV head / an MLA latent can't be split by tensor parallel). */
  kvWhole: boolean;
  kvSource: string;
  /** Per-GPU buffers that grow with the context: bytes per (batched token × context token). */
  contextBuffer?: { bytesPerCell: number; batchedTokens: number; source: string };
}

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

const IMAGE = "vllm/vllm-openai:v0.20.0";

/*
 * Multi-GPU entries. Every flag below comes from an official source, cited next to it, as read
 * on 2026-11-13. None has been run on real hardware yet: they are untested (see TESTED_MODELS),
 * and the plan says so. Sources:
 *
 * [V41-RECIPE] vLLM recipe, https://github.com/vllm-project/recipes/blob/main/models/deepseek-ai/DeepSeek-V4.1-Flash.yaml
 * [V41-CARD]   https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash and .../DeepSeek-V4.1-Flash-1017
 * [ENGRAM]     vLLM Engram docs, https://docs.vllm.ai/en/latest/features/engram/
 * [SGL-ENGRAM] SGLang Engram docs, https://docs.sglang.io/docs/advanced_features/engram
 * [NVFP4-CARD] https://huggingface.co/nvidia/DeepSeek-V4.1-Flash-1017-NVFP4
 * [GLM-RECIPE] vLLM recipe, https://github.com/vllm-project/recipes/blob/main/models/zai-org/GLM-5.3-Flash.yaml
 * [GLM-CARD]   https://huggingface.co/zai-org/GLM-5.3-Flash (config.json)
 * [VLLM-REL]   https://github.com/vllm-project/vllm/releases ; [SGL-REL] https://github.com/sgl-project/sglang/releases
 */

/**
 * vLLM v0.33.0 (2026-11-02): the latest final release. The DeepSeek recipe needs "min_vllm_version:
 * 0.31.0"; GLM-5.3-Flash is in v0.30.0's notes ("New models: … GLM-5.3-Flash (#53906)"). Its
 * notes: "release wheels and images are CUDA 13.0 only"; vLLM's Docker docs: CUDA 13 images
 * need an R580+ driver. [VLLM-REL]
 */
const VLLM_MULTI = "vllm/vllm-openai:v0.33.0";

/** RTX PRO Blackwell workstation and server cards (sm120): in no official recipe for these models. */
const SM120 = ["12"];
const SM120_V41 = "No official recipe covers RTX PRO Blackwell (sm120) GPUs: the vLLM recipe lists H100, H200, B200, GB200, B300, GB300 and AMD. "
  + "vLLM's SM120 fix for this model (#60762, 64-token kernel blocks, merged 2026-11-05) is in no final release yet (v0.34.0rc2 only), "
  + "and issue #59203 reports indexer_kv_dtype mxfp4 rejected on SM120 on the release tag. Expect to need a newer image.";

/** DeepSeek-V4.1-Flash-1017's safetensors minus its two Engram shards (model-00047/48, Engram tensors only). */
const V41_WEIGHTS = 510_296_708_312;
const V41_ENGRAM = 203_073_076_240;

const MULTI_GPU: readonly ModelRecipe[] = [
  {
    // The official checkpoint is one mixed-precision repo: "native mixed checkpoint (MXFP4 MoE
    // experts, MXFP8 block-quantized dense weights, UE8M0 scales)", which the vLLM recipe labels
    // "FP8 (1017)" [V41-RECIPE]. quantization_config is read from the checkpoint ("quant_method":
    // "fp8", "expert_dtype": "fp4"), so no --quantization flag.
    id: "deepseek-v4.1-flash-fp8", repo: "deepseek-ai/DeepSeek-V4.1-Flash-1017", engine: "vllm", image: VLLM_MULTI, minCuda: "13.0",
    // single_node_tp: "tp: default: 4, h100: 8, b200: 2" [V41-RECIPE]. The recipe names no PCIe
    // layout, and no pipeline-parallel setup for this model, so the documented tensor-parallel
    // layout is used on PCIe too.
    parallel: { tp: [2, 4, 8], pcie: "tp", pcieWhy: "vLLM's DeepSeek-V4.1-Flash recipe runs tensor parallel (TP 4 by default) and documents no other single-node layout; vLLM falls back from its custom all-reduce to NCCL on more than two PCIe-only GPUs" },
    // Per GPU: no single card holds a half of the resident weights below 143 GiB, so the floor is
    // the TP 8 share (36 GiB "of resident weights at TP8" [V41-RECIPE]); the total is the resident
    // weights at the utilization below. The preflight does the exact math.
    minVramMiB: 40 * 1024, minTotalVramMiB: Math.ceil((V41_WEIGHTS - V41_ENGRAM) / MiB / 0.92),
    // The H100 block sets "--gpu-memory-utilization 0.92", vLLM's default without the extensible KV cache. [V41-RECIPE]
    gpuMemoryUtilization: 0.92,
    flags: [
      // base_args: "--tokenizer-mode deepseek_v41" (the recipe: the repo "ships no chat_template.jinja"). [V41-RECIPE]
      "--tokenizer-mode", "deepseek_v41",
      // tool_calling: "--tool-call-parser deepseek_v41 --enable-auto-tool-choice". [V41-RECIPE]
      "--tool-call-parser", "deepseek_v41", "--enable-auto-tool-choice",
      // reasoning: "--reasoning-parser deepseek_v41". Thinking is on by default ("With both keys
      // unset, thinking is ON at effort 50"); dl's checks send enable_thinking false. [V41-RECIPE]
      "--reasoning-parser", "deepseek_v41",
      // text_only: "Skip loading the vision encoder for text-only workloads — frees VRAM for KV cache." [V41-RECIPE]
      "--language-model-only",
      // Engram tables (~189 GiB) in pinned host memory: "cpu_offload defaults to true", set explicitly
      // as the recipe does ('{"cpu_offload":true}' on H100, B200, GB200, GB300). [ENGRAM] [V41-RECIPE]
      "--engram-config", '{"cpu_offload":true}',
      // Not "--speculative-config" (DSpark, "the only speculative method for this checkpoint"):
      // TODO(multi-gpu): opt-in once tested; it costs VRAM these 96 GB cards don't have spare. [V41-RECIPE]
      // Recipe context_length 1048576; no recommended max-model-len for TP4 ("size the context limit
      // for your prompt plus output lengths"). dl starts at 128k; --context goes up to 1M.
      "--max-model-len", "131072",
    ],
    // base_env: VLLM_ENGINE_READY_TIMEOUT_S "3600": loading ~510 GB takes a while. [V41-RECIPE]
    env: { VLLM_ENGINE_READY_TIMEOUT_S: "3600" },
    byGpu: [
      // hardware_overrides.h100: "--max-num-batched-tokens 4096" with VLLM_USE_V2_MODEL_RUNNER=1 and
      // PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True ("8192 x 1M x 2 B is exactly 16 GiB and
      // does not fit next to the weights, so batched tokens are capped at 4096"). [V41-RECIPE]
      { computeCaps: ["9"], label: "Hopper (the recipe's H100 settings)", flags: ["--max-num-batched-tokens", "4096"],
        env: { VLLM_USE_V2_MODEL_RUNNER: "1", PYTORCH_CUDA_ALLOC_CONF: "expandable_segments:True" } },
      // hardware_overrides.blackwell: attention backend, fp8 KV cache, 128 sequences. [V41-RECIPE]
      // Written for datacenter Blackwell (B200/GB200/B300/GB300); applied to sm120 untested, see SM120_V41.
      { computeCaps: ["10", "12"], label: "Blackwell (the recipe's Blackwell settings)", flags: [
        "--attention-config", '{"backend":"FLASHINFER_MLA_SPARSE_DSV41","indexer_kv_dtype":"mxfp4","indexer_sparse_logits":true}',
        "--kv-cache-dtype", "fp8", "--max-num-seqs", "128"] },
    ],
    defaultContext: 131072, maxContext: 1048576,
    memory: {
      weightsBytes: V41_WEIGHTS, weightsSource: "Hugging Face API, *.safetensors of deepseek-ai/DeepSeek-V4.1-Flash-1017 (48 shards), 2026-11-13",
      offloadBytes: V41_ENGRAM,
      offloadSource: "Engram tables (layers 1 and 14), the two Engram-only shards; vLLM keeps one TP-sharded host copy per replica (\"one host copy per replica\", vLLM Engram docs)",
      // "these designs reduce the global KV cache footprint to 890 bytes per token" with FP4 main KV
      // [V41-CARD]; no per-token figure is documented for --kv-cache-dtype fp8, so this is a floor.
      kvBytesPerToken: 890, kvWhole: true,
      kvSource: "DeepSeek's 890 bytes per token (FP4 KV; no fp8 figure is documented, so a floor), whole on every GPU (one KV head)",
      // "The sparse-attention indexer then allocates a [max-num-batched-tokens, max-model-len] logits
      // buffer at startup: 8192 x 1M x 2 B is exactly 16 GiB". [V41-RECIPE]
      contextBuffer: { bytesPerCell: 2, batchedTokens: 8192, source: "the indexer's [batched tokens × context] logits buffer, 2 B each (vLLM recipe)" },
    },
    caveats: [
      { computeCaps: SM120, text: SM120_V41 },
      { text: "The recipe's vram_minimum_gb is 614 with the Engram tables on the GPU; with them in host RAM the resident weights are ~286 GiB. Measure before relying on long contexts: the recipe says \"measure before assuming a given context/batch fits\"." },
    ],
  },
  {
    // DeepSeek publishes no FP4-only checkpoint. NVIDIA's NVFP4 build of 1017 is the FP4 option,
    // and per its card "stock vLLM images cannot load" it (needs vllm#61530, merged 2026-11-11, in no
    // tag), while "SGLang loads this checkpoint natively from 2026-11-04 on (sgl-project/sglang#47935)",
    // which is in no SGLang release (v0.5.23, 2026-11-02, is the latest) and no documented image. [NVFP4-CARD] [SGL-REL]
    id: "deepseek-v4.1-flash-fp4", repo: "nvidia/DeepSeek-V4.1-Flash-1017-NVFP4", engine: "sglang",
    // TODO(multi-gpu): pin the first SGLang release that contains sglang#47935.
    image: "lmsysorg/sglang:v0.5.23", minCuda: "13.0",
    blocked: "no released engine image loads it yet: SGLang needs #47935 (merged 2026-11-04; v0.5.23 predates it) and vLLM needs #61530 (merged 2026-11-11, in no tag)",
    // The card's SGLang command uses "--tp 4"; no other size is documented.
    parallel: { tp: [4], pcie: "tp", pcieWhy: "NVIDIA's model card runs SGLang with --tp 4; SGLang's Engram lookup picks a collective itself for \"GPUs without NVLink between them\"" },
    minVramMiB: 40 * 1024, minTotalVramMiB: Math.ceil((428_986_460_424 - 97 * GiB) / MiB / 0.9),
    // The card's command: "--mem-fraction-static 0.9". [NVFP4-CARD]
    gpuMemoryUtilization: 0.9,
    flags: [
      // From the card's SGLang command, verbatim, without speculative decoding
      // ("--speculative-algorithm DSPARK --speculative-dspark-block-size 5": TODO(multi-gpu) opt-in once tested). [NVFP4-CARD]
      "--trust-remote-code", "--kv-cache-dtype", "fp8_e4m3", "--dsv4-attn-backend", "flashmla",
      // Engram tables in host memory: "keeps the Engram tables in host memory, about 97 GiB per node". [NVFP4-CARD] [SGL-ENGRAM]
      "--engram-config", '{"placement":"cpu","replication":"none","lookup":"auto"}',
      "--reasoning-parser", "auto", "--tool-call-parser", "auto",
      "--context-length", "131072",
    ],
    defaultContext: 131072, maxContext: 1048576,
    memory: {
      weightsBytes: 428_986_460_424, weightsSource: "Hugging Face API, *.safetensors of nvidia/DeepSeek-V4.1-Flash-1017-NVFP4, 2026-11-13",
      offloadBytes: 97 * GiB, offloadSource: "Engram tables in MXFP4, \"about 97 GiB per node\" (NVIDIA's model card)",
      kvBytesPerToken: 890, kvWhole: true,
      kvSource: "DeepSeek's 890 bytes per token (FP4 KV; no fp8 figure is documented, so a floor), whole on every GPU (one KV head)",
    },
    caveats: [
      { computeCaps: SM120, text: "NVIDIA's card lists \"Test Hardware: NVIDIA GB300\" and SGLang's cookbook lists H200/B200/B300/GB300/MI355X: no sm120. The FlashMLA attention backend it names is not documented for sm120." },
      { text: "The Engram tables are converted to MXFP4: \"the Engram conversion is lossy\" (NVIDIA's model card)." },
    ],
  },
  {
    // zai-org/GLM-5.3-Flash is the FP8 checkpoint ("quant_method": "fp8" in config.json), 320B total
    // / 18B active ("With 320B total parameters and just 18B active parameters"). [GLM-CARD]
    id: "glm-5.3-flash", repo: "zai-org/GLM-5.3-Flash", engine: "vllm", image: VLLM_MULTI, minCuda: "13.0",
    // The recipe's command: "vllm serve zai-org/GLM-5.3-Flash --tensor-parallel-size 4 …"; no other size documented. [GLM-RECIPE]
    parallel: { tp: [4], pcie: "tp", pcieWhy: "vLLM's GLM-5.3-Flash recipe runs --tensor-parallel-size 4 and documents no other layout" },
    minVramMiB: 40 * 1024, minTotalVramMiB: Math.ceil(328_337_455_672 / MiB / 0.9),
    // vLLM's default is 0.92; 0.9 as dl's other GLM entry, leaving a little room. No recipe value.
    gpuMemoryUtilization: 0.9,
    flags: [
      // "--tool-call-parser glm47 --reasoning-parser glm47 --enable-auto-tool-choice". [GLM-RECIPE]
      "--tool-call-parser", "glm47", "--enable-auto-tool-choice", "--reasoning-parser", "glm47",
      // Not "--speculative-config '{\"method\":\"mtp\",\"num_speculative_tokens\":5}'" (MTP): TODO(multi-gpu) opt-in once tested. [GLM-RECIPE]
      // Not "--kv-cache-dtype fp8": the recipe gives it for Blackwell and says "Hopper does not support
      // FP8 KV cache for this model and must run BF16 KV"; whether "Blackwell" covers sm120 isn't said.
      // TODO(multi-gpu): add it for Blackwell once tested on sm120. [GLM-RECIPE]
      // max_position_embeddings 1048576 [GLM-CARD]; no recommended GPU max-model-len documented.
      "--max-model-len", "131072",
    ],
    defaultContext: 131072, maxContext: 1048576,
    memory: {
      weightsBytes: 328_337_455_672, weightsSource: "Hugging Face API, *.safetensors of zai-org/GLM-5.3-Flash (62 shards), 2026-11-13",
      // config.json: 11 of 45 layers are deepseek_sparse_attention with kv_lora_rank 512 and
      // qk_rope_head_dim 0, plus a 128-dim indexer key (index_head_dim); the 34 linear_attention
      // layers keep a fixed per-sequence state instead. At 2 bytes (BF16 KV): 11 × (512 + 128) × 2.
      kvBytesPerToken: 11 * (512 + 128) * 2, kvWhole: true,
      kvSource: "config.json: 11 sparse-attention layers × (kv_lora_rank 512 + indexer key 128) × 2 B (BF16), whole on every GPU (one latent)",
    },
    caveats: [
      { computeCaps: SM120, text: "The GLM-5.3-Flash recipe lists no sm120 hardware; vLLM v0.31.0 added \"NoPE sparse MLA on the FlashInfer SM120 backend (#55277)\", which this model needs." },
      { text: "\"Thinking is always on\" for this model (vLLM recipe): dl's chat checks ask for no thinking and may run out of tokens." },
    ],
  },
];
/** First is the default pick: qwen-new answers without a thinking phase, so it is the safer start. */
export const MODEL_CATALOG: readonly ModelRecipe[] = [
  { id: "qwen-new", repo: "Qwen/Qwen3-4B-Instruct-2507", minVramMiB: 16384, gpuMemoryUtilization: 0.4, image: IMAGE,
    flags: ["--tool-call-parser", "hermes", "--enable-auto-tool-choice", "--max-model-len", "32768"], defaultContext: 32768 },
  { id: "qwen-old", repo: "Qwen/Qwen3-4B", minVramMiB: 12288, gpuMemoryUtilization: 0.4, image: IMAGE,
    flags: ["--tool-call-parser", "hermes", "--enable-auto-tool-choice", "--reasoning-parser", "qwen3", "--max-model-len", "32768"], defaultContext: 32768 },
  { id: "glm-flash", repo: "zai-org/GLM-4.7-Flash", minVramMiB: 49152, gpuMemoryUtilization: 0.9, image: IMAGE,
    flags: ["--tool-call-parser", "glm47", "--enable-auto-tool-choice", "--reasoning-parser", "glm47", "--max-model-len", "8192", "--quantization", "fp8"], defaultContext: 8192 },
  ...MULTI_GPU,
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
