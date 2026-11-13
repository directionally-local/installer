import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { recipe } from "./model-catalog.js";
import { caveatsFor, defaultPortFor, deploymentName, devicesFor, imageText, needsText, parseGpuList, takenPorts } from "./model-command.js";
import { engine } from "./model-engines.js";
import { chooseImage, unofficialWarning, withImage } from "./model-image.js";
import { TESTED_MODELS } from "./model-first-run.js";
import { gib, hostResources, memoryLimitBytes, preflight, RAM_PER_GPU_BYTES } from "./model-preflight.js";
import { detectHardware, dockerArgs, gpuLine, maxContext, modelDownloadBytes, recipeFor } from "./model-runtime.js";
import { interconnect } from "./model-topology.js";
import type { FetchModel } from "./model-smoke.js";
import { DEFAULT_DEPLOYMENT, readDeployments } from "./state.js";
import type { RunOptions, RunResult, System, WriteOptions } from "./system.js";

const MiB = 1024 ** 2;

/**
 * A System that can only look: `dl model up --plan` runs nothing, writes nothing and starts
 * nothing. Reads (nvidia-smi, /proc/meminfo, df, the state file) go to `inner`; anything else
 * throws, so a plan that tried would fail loudly instead of acting.
 */
export function readOnly(inner: Pick<System, "probe" | "readFile" | "exists">): System {
  const refuse = (what: string) => { throw new Error(`dl model up --plan never ${what}`); };
  return {
    dryRun: true,
    run: async (command: string, args: string[], _options?: RunOptions): Promise<RunResult> => refuse(`runs commands (asked to run ${[command, ...args].join(" ")})`),
    probe: (command, args, options) => {
      // Read-only detection only: the GPUs, their links, and free disk. Never Docker.
      if (command !== "nvidia-smi" && command !== "df") return Promise.resolve({ code: 1, stdout: "", stderr: `${command} is not probed by --plan` });
      return inner.probe(command, args, options);
    },
    readFile: (path) => inner.readFile(path),
    writeFile: async (path: string, _content: string, _options?: WriteOptions) => refuse(`writes files (asked to write ${path})`),
    mkdir: async (path: string) => refuse(`creates directories (asked to create ${path})`),
    remove: async (path: string) => refuse(`removes files (asked to remove ${path})`),
    exists: (path) => inner.exists(path),
    log: () => {},
  };
}

/**
 * Another machine's command output in a directory (see src/test-support/fixtures/gpu/README.md):
 * nvidia-smi.csv, nvidia-smi.txt, topo.txt, meminfo, df.txt. `--plan --hardware DIR` plans for
 * that machine without probing this one.
 */
export function hardwareDir(dir: string): System {
  const read = (file: string) => readFile(join(dir, file), "utf8").then((text) => text, () => undefined);
  const answer = (text: string | undefined): RunResult => (text === undefined ? { code: 1, stdout: "", stderr: "missing" } : { code: 0, stdout: text, stderr: "" });
  return readOnly({
    probe: async (command, args) => {
      if (command === "nvidia-smi" && args[0] === "topo") return answer(await read("topo.txt"));
      if (command === "nvidia-smi" && args.length === 0) return answer(await read("nvidia-smi.txt"));
      if (command === "nvidia-smi") return answer(await read("nvidia-smi.csv"));
      if (command === "df") return answer(await read("df.txt"));
      return answer(undefined);
    },
    readFile: async (path) => (path === "/proc/meminfo" ? read("meminfo") : undefined),
    exists: async () => false,
  });
}

/** A word for the shell: single-quoted when it has anything a shell would read. */
export function shellWord(word: string): string {
  return /^[A-Za-z0-9_./:=,@%+-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** `docker run …` as one copy-pasteable command, one option per line. */
export function shellCommand(args: readonly string[]): string {
  const words = ["docker", ...args].map(shellWord);
  const lines: string[] = [];
  let line = "";
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    // A flag and its value stay together; a new flag starts a new line once the line is long.
    const startsFlag = word.startsWith("-") && line.length > 0;
    if (startsFlag && line.length > 40) { lines.push(line); line = ""; }
    line = line ? `${line} ${word}` : word;
  }
  lines.push(line);
  return lines.map((text, index) => `${index ? "    " : ""}${text}`).join(" \\\n");
}

export interface PlanOptions {
  system: System;
  /** The model's id (or repo); required: a plan is for one model. */
  model: string | undefined;
  name?: string | undefined;
  gpus?: string | undefined;
  port?: string | undefined;
  context?: string | undefined;
  /** --image: the container image instead of the catalog's (never pulled or inspected by a plan). */
  image?: string | undefined;
  /** Plan for another machine from its command output (no probes here, no network). */
  hardware?: string | undefined;
  statePath?: string | undefined;
  fetch?: FetchModel | undefined;
  out: (text: string) => void;
}

const pad = (label: string) => label.padEnd(10);

/**
 * `dl model up MODEL --plan`: the exact docker run command, the GPUs, the parallel layout and the
 * memory math (weights per GPU, KV cache, buffers, offload RAM, disk), without running,
 * downloading or writing anything. On this machine it reads nvidia-smi, /proc/meminfo, df and the
 * weights' size from the Hugging Face API; with --hardware it reads that directory instead and
 * uses the catalog's recorded size (no network).
 */
export async function planCommand(options: PlanOptions): Promise<number> {
  const { out } = options;
  const print = (label: string, text: string) => out(`${pad(label)} ${text}\n`);
  if (!options.model) throw new Error("Name a model to plan: dl model up MODEL --plan");
  const catalog = recipe(options.model);
  const choice = chooseImage(catalog, options.image);
  const model = withImage(catalog, choice);
  const override = choice.catalogImage !== undefined;
  const elsewhere = options.hardware !== undefined;
  const system = elsewhere ? hardwareDir(options.hardware!) : readOnly(options.system);
  const hardware = await detectHardware(system);
  const host = await hostResources(system);
  const name = deploymentName(options.name);
  const named = name !== DEFAULT_DEPLOYMENT;
  // Another machine's deployments aren't known; here, the plan avoids this machine's GPUs and ports.
  const deployments = elsewhere ? {} : await readDeployments(system, options.statePath);
  const others = Object.entries(deployments).filter(([other]) => other !== name);
  const existing = deployments[name];
  const pinned = options.gpus !== undefined ? parseGpuList(options.gpus, hardware.gpus) : undefined;
  const usable = pinned ?? hardware.gpus;
  const context = options.context !== undefined ? Number(options.context) : model.defaultContext;
  if (!Number.isInteger(context) || context < 512 || context > maxContext(model)) throw new Error(`Context length must be between 512 and ${maxContext(model)} for ${model.id}.`);
  const result = preflight({ model, context, hardware, usable, host,
    liveWeightsBytes: elsewhere ? undefined : await modelDownloadBytes(model.repo, options.fetch ?? fetch) });
  // Entries without sizes (the single-GPU catalog) are planned as `up` runs them: one GPU, no math.
  const layout = result?.layout ?? (() => {
    const gpus = [...usable].sort((a, b) => b.totalMiB - a.totalMiB || a.index - b.index).slice(0, 1).map((gpu) => gpu.index);
    return { gpus, interconnect: interconnect(hardware.topology, gpus), tp: 1, pp: 1, ep: false, why: "one GPU" };
  })();
  const parallel = layout.gpus.length > 1 ? layout : undefined;
  const devices = devicesFor(pinned, layout, hardware.gpus.length);
  const computeCap = hardware.gpus.find((gpu) => gpu.index === layout.gpus[0])?.computeCap;
  const memoryBytes = memoryLimitBytes(model, layout.gpus.length);
  const taken = takenPorts(others);
  const port = options.port !== undefined ? Number(options.port) : defaultPortFor(undefined, named, taken);
  const args = dockerArgs(model, port, context, 1, { parallel, computeCap, ...(named ? { name } : {}), ...(devices ? { devices } : {}), ...(memoryBytes ? { memoryBytes } : {}) });
  const server = engine(model.engine);
  const gpusUsed = hardware.gpus.filter((gpu) => layout.gpus.includes(gpu.index));
  const fits = !result || result.problems.length === 0;

  out(`Plan for ${model.id} (${model.repo}) · ${TESTED_MODELS.has(model.id) ? "tested" : "untested"}${elsewhere ? ` · hardware from ${options.hardware}` : ""}\n`);
  out("Nothing was run, downloaded or written.\n\n");
  print("Engine", `${server.label} · ${imageText(choice)}`);
  const unofficial = override ? unofficialWarning(server.id, server.label, model.image) : undefined;
  if (unofficial) print("Warning", unofficial);
  print("Machine", `${gpuLine(hardware.gpus)} · driver ${[...new Set(hardware.gpus.map((gpu) => gpu.driver))].join(", ")}, CUDA ${hardware.cuda}`
    + `${host.ramTotalBytes ? ` · RAM ${gib(host.ramTotalBytes)}${host.ramAvailableBytes ? ` (${gib(host.ramAvailableBytes)} available)` : ""}` : ""}`);
  for (const gpu of hardware.gpus) {
    const role = layout.gpus.includes(gpu.index) ? "used" : pinned && !pinned.some((item) => item.index === gpu.index) ? "not in --gpus" : "unused";
    print(gpu.index === hardware.gpus[0]!.index ? "GPUs" : "", `${gpu.index}  ${gpu.name} · ${gib(gpu.totalMiB * MiB)} (${gib(gpu.freeMiB * MiB)} free) · sm ${gpu.computeCap ?? "?"} · ${gpu.uuid ?? "no UUID"} · ${role}`);
  }
  print("Links", layout.interconnect.text);
  print("Layout", `${layout.why}${parallel ? ` · TP ${layout.tp} × PP ${layout.pp}${layout.ep ? " · expert parallel" : ""}` : ""}`);
  const gpuSettings = recipeFor(model, computeCap).gpuLabel;
  if (gpuSettings) print("Settings", `sm ${computeCap}: ${gpuSettings}`);
  print("Container", `${args[args.indexOf("--name") + 1]} · sees ${devices ? `GPU ${devices.join(", ")} only` : "every GPU"} · 127.0.0.1:${port} → ${server.containerPort}${named ? ` · deployment ${name}` : ""}`);
  if (existing) print("Note", `a deployment named ${name} exists (${existing.active.id}): up refuses; dl model update${named ? ` --name ${name}` : ""} replaces it`);
  if (taken.has(port)) print("Note", `port ${port} belongs to deployment ${taken.get(port)}: up refuses it`);

  if (result) {
    const first = result.gpus[0]!;
    const count = result.layout.gpus.length;
    const kvSource = model.memory!.kvSource;
    out("\nMemory per GPU\n");
    print("  budget", `${gib(first.budgetBytes)} = ${Math.round(model.gpuMemoryUtilization * 100)}% of ${gib(first.totalMiB * MiB)} (what ${server.label} reserves)`);
    print("  weights", `${gib(first.weightsBytes)} = (${gib(result.weightsBytes)}${result.offloadBytes ? ` − ${gib(result.offloadBytes)} in host RAM` : ""}) / ${count} GPUs`);
    print("  KV", `${gib(first.kvBytes)} = ${result.kvPerToken} B/token × ${context} tokens, one sequence at full context (${kvSource})`);
    if (first.bufferBytes) print("  buffer", `${gib(first.bufferBytes)} = ${model.memory!.contextBuffer!.bytesPerCell} B × ${result.batchedTokens} batched tokens × ${context} (${model.memory!.contextBuffer!.source})`);
    print("  left", `${gib(first.leftBytes)} for more sequences' KV, activations and CUDA graphs`);
    for (const gpu of result.gpus.slice(1)) if (gpu.totalMiB !== first.totalMiB) print(`  GPU ${gpu.index}`, `${gib(gpu.budgetBytes)} budget, ${gib(gpu.leftBytes)} left`);
    out("\nHost\n");
    if (result.ramNeedBytes) {
      print("  RAM", `${gib(result.ramNeedBytes)} container limit (--memory) = ${gib(result.offloadBytes)} in host RAM + ${count} × ${gib(RAM_PER_GPU_BYTES)} per GPU worker; `
        + `${host.ramAvailableBytes !== undefined ? `${gib(host.ramAvailableBytes)} available` : "available RAM unknown"}`);
      print("", model.memory!.offloadSource ?? "");
    } else print("  RAM", "nothing offloaded to host RAM");
    print("  disk", `${gib(result.weightsBytes)} of weights (${result.weightsSource}); ${host.diskAvailableBytes !== undefined ? `${gib(host.diskAvailableBytes)} free on ${host.diskPath}` : "free disk unknown"}`);
    print("  driver", `CUDA ${hardware.cuda}${model.minCuda ? `; the image needs ${model.minCuda}`
      : override && catalog.minCuda ? `; --image's CUDA requirement is unknown, so not checked (the catalog image needs ${catalog.minCuda})` : ""}`);
  } else {
    out("\nMemory\n");
    print("  needs", `${needsText(model)} (catalog); ${server.label} reserves ${Math.round(model.gpuMemoryUtilization * 100)}% of the GPU = ${gib(model.gpuMemoryUtilization * Math.max(...gpusUsed.map((gpu) => gpu.totalMiB)) * MiB)}`);
  }

  const caveats = caveatsFor(model, gpusUsed);
  if (model.blocked || caveats.length || result?.warnings.length) out("\nCaveats\n");
  if (model.blocked) out(`  - can't be started yet: ${model.blocked}${override ? " (--image doesn't lift this: dl starts no blocked entry)" : ""}\n`);
  for (const warning of result?.warnings ?? []) out(`  - ${warning}\n`);
  for (const caveat of caveats) out(`  - ${caveat}\n`);

  const checked = override && catalog.minCuda ? ": GPU memory, host RAM and disk (driver not checked for --image)" : ": GPU memory, host RAM, disk and driver";
  out(`\nResult    ${fits ? `${model.blocked ? "fits on paper, but blocked (see above)" : "fits"}${result ? checked : ""}` : "doesn't fit"}\n`);
  for (const problem of result?.problems ?? []) out(`  - ${problem}\n`);
  if (result?.suggestions.length) out(`  nearest that fits: ${result.suggestions.join("; ")}\n`);

  out(`\nCommand${model.blocked ? " (once unblocked)" : ""}\n${shellCommand(args)}\n`);
  return fits && !model.blocked ? 0 : 1;
}
