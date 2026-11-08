/** Curated, pinned vLLM recipes. VRAM is per GPU, with room for KV cache and startup. */
export interface ModelRecipe {
  id: string;
  repo: string;
  minVramMiB: number;
  image: string;
  flags: readonly string[];
  defaultContext: number;
}

const IMAGE = "vllm/vllm-openai:v0.20.0";
export const MODEL_CATALOG: readonly ModelRecipe[] = [
  { id: "qwen-old", repo: "Qwen/Qwen3-4B", minVramMiB: 12288, image: IMAGE,
    flags: ["--tool-call-parser", "hermes", "--enable-auto-tool-choice", "--reasoning-parser", "qwen3", "--max-model-len", "8192"], defaultContext: 8192 },
  { id: "qwen-new", repo: "Qwen/Qwen3-4B-Instruct-2507", minVramMiB: 16384, image: IMAGE,
    flags: ["--tool-call-parser", "hermes", "--enable-auto-tool-choice", "--max-model-len", "8192"], defaultContext: 8192 },
  { id: "glm-flash", repo: "zai-org/GLM-4.7-Flash", minVramMiB: 49152, image: IMAGE,
    flags: ["--tool-call-parser", "glm47", "--enable-auto-tool-choice", "--reasoning-parser", "glm47", "--max-model-len", "8192", "--quantization", "fp8"], defaultContext: 8192 },
];

export function fittingModels(vramMiB: number): ModelRecipe[] {
  return MODEL_CATALOG.filter((entry) => entry.minVramMiB <= vramMiB);
}

export function recipe(id: string): ModelRecipe {
  const found = MODEL_CATALOG.find((entry) => entry.id === id || entry.repo === id);
  if (!found) throw new Error(`Unknown model "${id}". Choose one of: ${MODEL_CATALOG.map((entry) => entry.id).join(", ")}`);
  return found;
}
