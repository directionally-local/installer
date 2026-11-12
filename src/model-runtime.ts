import type { ModelRecipe } from "./model-catalog.js";
import type { System } from "./system.js";

export interface Gpu { index: number; name: string; totalMiB: number; freeMiB: number; driver: string }
export interface Hardware { gpus: Gpu[]; cuda: string }

/** Probes do not mutate the machine, even with --dry-run. */
export async function detectHardware(system: System): Promise<Hardware> {
  const result = await system.probe("nvidia-smi", ["--query-gpu=index,name,memory.total,memory.free,driver_version", "--format=csv,noheader,nounits"]);
  if (result.code !== 0 || !result.stdout.trim()) throw new Error("No Nvidia GPU detected. Install the Nvidia driver and check nvidia-smi before running dl model up.");
  const gpus = result.stdout.trim().split("\n").map((line) => {
    const fields = line.split(",").map((part) => part.trim());
    const [index, name, total, free, driver] = fields;
    if (!index || !name || !total || !free || !driver || !/^\d+$/.test(index) || !/^\d+$/.test(total) || !/^\d+$/.test(free)) throw new Error(`Could not parse Nvidia GPU details: ${line}`);
    return { index: Number(index), name, totalMiB: Number(total), freeMiB: Number(free), driver };
  });
  const smi = await system.probe("nvidia-smi", []);
  const cuda = smi.stdout.match(/CUDA Version:\s*([\d.]+)/)?.[1];
  if (!cuda) throw new Error("nvidia-smi did not report a CUDA version; check your Nvidia driver.");
  return { gpus, cuda };
}

export async function checkGpuDocker(system: System): Promise<void> {
  const docker = await system.probe("docker", ["info", "--format", "{{json .Runtimes}}"]);
  if (docker.code !== 0) throw new Error("Docker is missing or its daemon is stopped. Install/start Docker before running dl model up.");
  const toolkit = await system.probe("nvidia-ctk", ["--version"]);
  if (toolkit.code !== 0 || !/nvidia/i.test(toolkit.stdout + toolkit.stderr)) throw new Error("nvidia-container-toolkit is missing. Install and configure it for Docker, then restart Docker.");
  if (!/"nvidia"\s*:/.test(docker.stdout)) throw new Error("Docker has no nvidia runtime. Run nvidia-ctk runtime configure --runtime=docker and restart Docker.");
}

export function dockerArgs(model: ModelRecipe, port: number, context: number, slot: number): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be between 1 and 65535.");
  if (!Number.isInteger(context) || context < 512 || context > model.defaultContext) throw new Error(`Context length must be between 512 and ${model.defaultContext} for ${model.id}.`);
  const flags = [...model.flags];
  const index = flags.indexOf("--max-model-len");
  if (index !== -1) flags.splice(index, 2);
  return ["run", "-d", "--name", `dl-model-${slot}`, "--gpus", "all", "--ipc=host",
    "-p", `127.0.0.1:${port}:8000`, "-v", "dl-model-hf-cache:/root/.cache/huggingface",
    model.image, "--model", model.repo, "--served-model-name", model.repo, ...flags, "--max-model-len", String(context),
    "--gpu-memory-utilization", String(model.gpuMemoryUtilization)];
}

export async function containerRunning(system: System, container: string): Promise<boolean> {
  const result = await system.probe("docker", ["inspect", "--format", "{{.State.Running}}", container]);
  return result.code === 0 && result.stdout.trim() === "true";
}

export async function removeContainer(system: System, container: string): Promise<void> {
  await system.run("docker", ["rm", "-f", container], { allowFailure: true });
}

/** The container's last log lines, for the run log (never for the screen). */
export async function logTail(system: System, container: string, lines = 25): Promise<string> {
  const result = await system.probe("docker", ["logs", "--tail", String(lines), container]);
  return (result.stdout + result.stderr).trim().split("\n").slice(-lines).join("\n");
}

/** "NVIDIA RTX PRO 5000 Blackwell" → "NVIDIA RTX PRO 5000": the edition words don't fit a line. */
export function shortGpuName(name: string): string {
  const short = name
    .replace(/\s+Blackwell\b.*$/i, "")
    .replace(/\s+(Server|Workstation)\s+Edition\b.*$/i, "")
    .replace(/\s+Max-Q\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return short.length > 32 ? short.slice(0, 32).trimEnd() : short;
}

const roundGb = (mib: number) => Math.round(mib / 1024);

/** One short line for the GPUs: "NVIDIA RTX PRO 5000 · 48 GB", "4x NVIDIA RTX PRO 6000 · 384 GB total". */
export function gpuLine(gpus: readonly Pick<Gpu, "name" | "totalMiB">[]): string {
  if (gpus.length === 0) return "none";
  if (gpus.length === 1) return `${shortGpuName(gpus[0]!.name)} · ${roundGb(gpus[0]!.totalMiB)} GB`;
  const names = new Set(gpus.map((gpu) => shortGpuName(gpu.name)));
  const total = gpus.reduce((sum, gpu) => sum + roundGb(gpu.totalMiB), 0);
  return names.size === 1 ? `${gpus.length}x ${[...names][0]} · ${total} GB total` : `${gpus.length} GPUs · ${total} GB total`;
}

/** Where vLLM's Hugging Face download of `repo` lands inside the container. */
export function hfCacheDir(repo: string): string {
  return `/root/.cache/huggingface/hub/models--${repo.replace(/\//g, "--")}`;
}

/** Bytes of `repo` downloaded so far (partial files included), or undefined before the folder exists. */
export async function downloadedBytes(system: System, container: string, repo: string): Promise<number | undefined> {
  const result = await system.probe("docker", ["exec", container, "du", "-sb", hfCacheDir(repo)]);
  if (result.code !== 0) return undefined;
  const bytes = Number(result.stdout.trim().split(/\s+/)[0]);
  return Number.isFinite(bytes) && bytes >= 0 ? bytes : undefined;
}

/**
 * The model's download size from the Hugging Face API: its weights (safetensors) and the small
 * JSON files next to them, which is what vLLM fetches. Undefined when it can't be read.
 */
export async function modelDownloadBytes(repo: string, call: (url: string, init?: RequestInit) => Promise<Response> = fetch): Promise<number | undefined> {
  try {
    const response = await call(`https://huggingface.co/api/models/${repo}/tree/main`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return undefined;
    const files = await response.json() as Array<{ type?: string; path?: string; size?: number; lfs?: { size?: number } }>;
    if (!Array.isArray(files)) return undefined;
    const sizeOf = (file: (typeof files)[number]) => file.lfs?.size ?? file.size ?? 0;
    const weights = files.filter((file) => file.type === "file" && /\.safetensors$/.test(file.path ?? ""));
    if (weights.length === 0) return undefined;
    const extras = files.filter((file) => file.type === "file" && /\.json$/.test(file.path ?? ""));
    const total = [...weights, ...extras].reduce((sum, file) => sum + sizeOf(file), 0);
    return total > 0 ? total : undefined;
  } catch {
    return undefined;
  }
}
