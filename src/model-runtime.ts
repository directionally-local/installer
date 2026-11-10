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
    model.image, "--model", model.repo, "--served-model-name", model.repo, ...flags, "--max-model-len", String(context)];
}

export async function containerRunning(system: System, container: string): Promise<boolean> {
  const result = await system.probe("docker", ["inspect", "--format", "{{.State.Running}}", container]);
  return result.code === 0 && result.stdout.trim() === "true";
}

export async function removeContainer(system: System, container: string): Promise<void> {
  await system.run("docker", ["rm", "-f", container], { allowFailure: true });
}

export async function logTail(system: System, container: string): Promise<string> {
  const result = await system.probe("docker", ["logs", "--tail", "25", container]);
  return (result.stdout + result.stderr).trim().split("\n").slice(-25).join("\n");
}
