import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { autopilotConfigFile } from "./laptop/free-tier.js";
import { fittingModels, gpuCounts, recipe, type ModelRecipe } from "./model-catalog.js";
import { checkGpuDocker, containerRunning, containerSpec, detectHardware, dockerArgs, downloadedBytes, gpuLine, inspectContainer, logTail, modelDownloadBytes, removeContainer, type Gpu, type Hardware, type LaunchExtras, recipeFor } from "./model-runtime.js";
import { chooseParallelism } from "./model-parallel.js";
import { interconnect } from "./model-topology.js";
import { bench as benchModel } from "./model-bench.js";
import { FIRST_ANSWER_MS, localFetch, modelApiBase, SmokeError, smokeTest, type FetchModel, type SmokeCheck } from "./model-smoke.js";
import { modelStatePath, readModelState, writeModelState, type ModelDeployment } from "./state.js";
import type { System } from "./system.js";
import type { Ui } from "./ui.js";
import type { Prompter } from "./prompt.js";

export interface ModelCommandOptions {
  system: System;
  ui: Ui;
  prompter: Prompter;
  fetch?: FetchModel;
  statePath?: string;
  configPath?: string;
  /** Whether questions can be asked; defaults to ui.interactive. */
  interactive?: boolean;
  /** For tests; production waits for the model to download and start. */
  smoke?: typeof smokeTest;
  bench?: typeof benchModel;
  /** Directory for per-run logs; defaults to ~/.directionallylocal/logs. */
  logDir?: string;
  /** For tests: the wait between readiness polls (5 s in production). */
  delay?: (ms: number) => Promise<void>;
  /** The GPU lines were already shown (the first run shows them before its own checks). */
  hardwareShown?: boolean;
  /** Writes a line to the run log only, never to the screen (set by modelCommand). */
  record?: (line: string) => void;
}

/** The run log a failed `dl model` command wrote, when it wrote one. */
export function logPathOf(error: unknown): string | undefined {
  const path = (error as { logPath?: unknown } | null)?.logPath;
  return typeof path === "string" ? path : undefined;
}

const firstLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0]!;

/** A warning's prefix and a reason cut so the whole line fits 80 columns. */
function fitWarning(prefix: string, reason: string): string {
  const room = 74 - prefix.length;
  return `${prefix}${reason.length > room ? `${reason.slice(0, room - 3).trimEnd()}...` : reason}`;
}

/** The GPU in one short line, then the driver: each fits an 80-column terminal. */
export function showHardware(ui: Ui, hardware: Hardware): void {
  ui.line("info", "GPU", gpuLine(hardware.gpus));
  const drivers = [...new Set(hardware.gpus.map((gpu) => gpu.driver))].join(", ");
  ui.line("info", "Driver", `${drivers} · CUDA ${hardware.cuda}`);
}

/** Tee every UI event into a per-run log file so a failed switch can be diagnosed afterwards. */
function loggingUi(ui: Ui, record: (line: string) => void): Ui {
  const stamp = (text: string) => record(`${new Date().toISOString()} ${text}`);
  let started: string | undefined;
  return {
    get interactive() { return ui.interactive; },
    title: (text) => { stamp(`== ${text}`); ui.title(text); },
    line: (status, label, detail) => { stamp(`${status} ${label}${detail ? `: ${detail}` : ""}`); ui.line(status, label, detail); },
    plan: (steps) => { stamp(`plan ${steps.map((step) => step.label).join(" | ")}`); ui.plan(steps); },
    // Progress updates restart the same step: log the step once, not every update.
    start: (id, detail) => { if (id !== started) stamp(`.. ${id}${detail ? `: ${detail}` : ""}`); started = id; ui.start(id, detail); },
    done: (id, detail) => { stamp(`ok ${id}${detail ? `: ${detail}` : ""}`); ui.done(id, detail); },
    fail: (id, message) => { stamp(`FAIL ${id}: ${message}`); ui.fail(id, message); },
    questions: (intro) => ui.questions(intro),
    answered: (label, detail) => ui.answered(label, detail),
    rejected: (message) => ui.rejected(message),
    prompt: (label, hint) => ui.prompt(label, hint),
    ready: (headline, items, extra) => ui.ready(headline, items, extra),
    warn: (text) => { stamp(`WARN ${text}`); ui.warn(text); },
    finish: () => ui.finish(),
  };
}

export function runLogDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME || homedir(), ".directionallylocal", "logs");
}

function isInteractive(options: ModelCommandOptions): boolean {
  return options.interactive ?? options.ui.interactive;
}

function portNumber(text: string): number {
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isInteger(value) || value < 1 || value > 65534) throw new Error("Port must be an integer between 1 and 65534 (the next port is reserved for updates).");
  return value;
}

/** What a model needs, in words: "16 GB of GPU VRAM", "4 GPUs with 80 GB each, 320 GB in total". */
export function needsText(model: ModelRecipe): string {
  const counts = gpuCounts(model);
  const fewest = counts[counts.length - 1]!;
  if (fewest === 1 && !model.minTotalVramMiB) return `${Math.ceil(model.minVramMiB / 1024)} GB of GPU VRAM`;
  const total = Math.ceil((model.minTotalVramMiB ?? model.minVramMiB) / 1024);
  return `${fewest === 1 ? "1 GPU" : `${fewest} GPUs`} with ${Math.ceil(model.minVramMiB / 1024)} GB each, ${total} GB in total (runs on ${[...counts].reverse().join(", ")} GPUs)`;
}

/** Models that fit count every usable GPU (or the --gpus subset), not just the largest one. */
async function selectModel(options: ModelCommandOptions, id: string | undefined, gpus: readonly Gpu[]): Promise<ModelRecipe> {
  // A blocked entry (no released engine runs it yet) is planned, never started.
  const choices = fittingModels(gpus).filter((item) => !item.blocked);
  const totalMiB = gpus.reduce((sum, gpu) => sum + gpu.totalMiB, 0);
  if (choices.length === 0) throw new Error(`No catalog models fit ${gpus.length > 1 ? `${gpus.length} GPUs with ${Math.floor(totalMiB / 1024)} GB` : `${Math.floor(totalMiB / 1024)} GB`} of GPU VRAM.`);
  options.ui.line("info", "Models that fit", choices.map((item) => item.id).join(", "));
  if (id) {
    const selected = recipe(id);
    if (selected.blocked) throw new Error(`${selected.id} can't be started yet: ${selected.blocked}. dl model up ${selected.id} --plan shows what it would run.`);
    if (!choices.includes(selected)) throw new Error(`${selected.id} needs ${needsText(selected)}.`);
    return selected;
  }
  if (!isInteractive(options)) throw new Error(`Name a model: ${choices.map((item) => item.id).join(", ")}`);
  const selected = await options.prompter.select(options.ui.prompt("Pick a model"), choices.map((item) => ({ value: item.id, label: `${item.id}  ${item.repo}`, detail: `${Math.ceil(item.minVramMiB / 1024)} GB` })));
  return recipe(selected.value);
}

export async function configureProvider(options: Pick<ModelCommandOptions, "system">, deployment: ModelDeployment, path: string): Promise<void> {
  const raw = await options.system.readFile(path);
  let config: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid config");
      config = parsed as Record<string, unknown>;
    } catch { throw new Error(`Autopilot config at ${path} is invalid; provider was not changed.`); }
  }
  const providers = config.providers && typeof config.providers === "object" && !Array.isArray(config.providers) ? config.providers as Record<string, unknown> : {};
  const saved = providers.vllm && typeof providers.vllm === "object" && !Array.isArray(providers.vllm) ? providers.vllm as Record<string, unknown> : {};
  await options.system.mkdir(dirname(path), { mode: 0o700 });
  await options.system.writeFile(path, `${JSON.stringify({ ...config, provider: "vllm", model: deployment.repo,
    providers: { ...providers, vllm: { ...saved, model: deployment.repo, baseUrl: modelApiBase(deployment) } } }, null, 2)}\n`, { mode: 0o600 });
}

const GB = 1024 ** 3;
const gbText = (bytes: number) => (bytes / GB).toFixed(1);

/** vLLM's log once the weights are on disk and loading onto the GPU. */
const LOADING = /Loading safetensors checkpoint shards|Loading weights took|Model loading took|Starting vLLM API server/;

/**
 * The "Download" step's progress while vLLM isn't answering yet: bytes in the model's Hugging
 * Face cache folder against its size from the Hugging Face API (or just bytes, when the size
 * can't be read). It moves on to "Start vLLM" when the download is complete or vLLM's log says
 * the weights are loading.
 */
function downloadWatch(options: ModelCommandOptions, model: ModelRecipe, container: string) {
  const { system, ui } = options;
  let total: number | undefined | null = null;
  let last = 0;
  let phase: "download" | "ready" = "download";
  const toReady = () => {
    if (phase !== "download") return;
    phase = "ready";
    ui.done("download", last > 0 ? `${gbText(Math.max(last, total ?? 0))} GB` : "already here");
    ui.start("ready", "loading the model");
  };
  return {
    phase: (): "download" | "ready" => phase,
    ready: toReady,
    /** One look at the download; true when it moved on since the last look. */
    poll: async (): Promise<boolean> => {
      if (phase !== "download") return false;
      if (total === null) total = await modelDownloadBytes(model.repo, options.fetch ?? fetch);
      const bytes = await downloadedBytes(system, container, model.repo);
      const moved = bytes !== undefined && bytes > last;
      if (bytes !== undefined) last = Math.max(last, bytes);
      const logs = await system.probe("docker", ["logs", "--tail", "40", container]).catch(() => undefined);
      if ((total && last >= total * 0.98) || LOADING.test(`${logs?.stdout ?? ""}${logs?.stderr ?? ""}`)) {
        toReady();
        return moved;
      }
      ui.start("download", last === 0 ? "waiting for vLLM" : total ? `${gbText(last)} of ${gbText(total)} GB · ${Math.min(99, Math.floor(last / total * 100))}%` : `${gbText(last)} GB so far`);
      return moved;
    },
  };
}

/** The container's recent logs go to the run log, never the screen. */
async function recordLogs(options: ModelCommandOptions, container: string): Promise<void> {
  if (!options.record) return;
  const tail = await logTail(options.system, container, 200).catch(() => "");
  options.record(`vLLM logs (${container}, last 200 lines):`);
  for (const line of tail.split("\n")) options.record(`  ${line}`);
}

/**
 * Whether a container left running by an earlier, failed attempt can be used as is: it runs the
 * same recipe (same image, model, flags, port and context) and its API answers.
 */
async function reusable(options: ModelCommandOptions, model: ModelRecipe, port: number, context: number, slot: number, extras: LaunchExtras = {}): Promise<"reuse" | "replace" | "none"> {
  const existing = await inspectContainer(options.system, `dl-model-${slot}`);
  if (!existing) return "none";
  if (!existing.running || existing.spec !== containerSpec(model, port, context, slot, extras)) return "replace";
  try {
    const response = await (options.fetch ?? localFetch)(`${modelApiBase({ port })}/models`, { signal: AbortSignal.timeout(5000) });
    await response.arrayBuffer().catch(() => undefined);
    return response.ok ? "reuse" : "replace";
  } catch {
    return "replace";
  }
}

async function launch(options: ModelCommandOptions, model: ModelRecipe, port: number, context: number, slot: number, reuse = false, progress: { started: boolean } = { started: false }, extras: LaunchExtras = {}): Promise<ModelDeployment> {
  const { system, ui } = options;
  const container = `dl-model-${slot}`;
  const resolved = recipeFor(model, extras.computeCap);
  const deployment: ModelDeployment = { id: model.id, repo: model.repo, container, port, context,
    // The flags and environment as run (per-GPU-family ones included), so rollback restarts exactly this.
    image: model.image, flags: resolved.flags, minVramMiB: model.minVramMiB, gpuMemoryUtilization: model.gpuMemoryUtilization,
    ...(Object.keys(resolved.env).length ? { env: resolved.env } : {}),
    ...(model.engine && model.engine !== "vllm" ? { engine: model.engine } : {}),
    ...(extras.parallel ? { parallel: { gpus: extras.parallel.gpus, tp: extras.parallel.tp, pp: extras.parallel.pp, ep: extras.parallel.ep } } : {}),
    lastTest: { chat: false, tools: false, json: false, tokensPerSecond: 0, at: "" } };
  ui.plan([
    { id: "launch", label: "Start the vLLM container" },
    { id: "download", label: `Download ${model.id}` },
    { id: "ready", label: "Start vLLM" },
    { id: "chat", label: "Chat test" },
    { id: "speed", label: "Speed test" },
    { id: "tools", label: "Tool call test" },
    { id: "json", label: "JSON test" },
  ]);
  ui.start("launch", model.image);
  try {
    if (reuse) {
      options.record?.(`reusing ${container}: it runs the same recipe and its API answers`);
      ui.done("launch", `port ${port} · already running`);
    } else {
      await system.run("docker", dockerArgs(model, port, context, slot, extras));
      ui.done("launch", `port ${port}`);
    }
    progress.started = true;
  } catch (error) {
    ui.fail("launch", firstLine(error));
    ui.finish();
    await recordLogs(options, container);
    throw new Error(`Could not start vLLM: ${firstLine(error)}`);
  }
  if (system.dryRun) { ui.finish(); return deployment; }
  options.record?.(`logs: docker logs -f ${container}`);
  const watch = downloadWatch(options, model, container);
  let current: SmokeCheck | "download" = "download";
  ui.start("download", "waiting for vLLM");
  if (reuse) watch.ready();
  try {
    deployment.lastTest = await (options.smoke ?? smokeTest)(deployment, system, options.fetch, {
      waiting: watch.poll,
      ...(options.delay ? { delay: options.delay } : {}),
      running: () => containerRunning(system, container),
      ...(options.record ? { record: options.record } : {}),
      // A fresh vLLM's first answer can take a minute; a reused one is warm.
      ...(reuse ? {} : { chatAnswerMs: FIRST_ANSWER_MS }),
      onCheck: (check, status, detail) => {
        if (check === "ready") {
          if (status === "done") { watch.ready(); ui.done("ready"); }
          return;
        }
        if (status === "start") { current = check; ui.start(check, detail); } else ui.done(check, detail);
      },
    });
    ui.finish();
    return deployment;
  } catch (error) {
    const step = error instanceof SmokeError && error.check !== "ready" ? error.check : current === "download" || current === "ready" ? watch.phase() : current;
    ui.fail(step, error instanceof SmokeError ? error.short : firstLine(error));
    ui.finish();
    await recordLogs(options, container);
    throw error;
  }
}

export async function modelCommand(action: string, args: string[], options: ModelCommandOptions): Promise<number> {
  const records: string[] = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const wrapped: ModelCommandOptions = { ...options, ui: loggingUi(options.ui, (line) => records.push(line)), record: (line) => records.push(line) };
  const persist = async (): Promise<string | undefined> => {
    if (options.system.dryRun) return undefined;
    try {
      const dir = options.logDir ?? runLogDir();
      const path = join(dir, `${stamp}-${action}.log`);
      await options.system.mkdir(dir, { mode: 0o700 });
      await options.system.writeFile(path, `${records.join("\n")}\n`, { mode: 0o644 });
      return path;
    } catch { return undefined; }
  };
  try {
    const code = await modelCommandInner(action, args, wrapped);
    // Warnings given after the checklist (a failed comparison) are printed now.
    options.ui.finish();
    await persist();
    return code;
  } catch (error) {
    records.push(`${new Date().toISOString()} FAILED ${error instanceof Error ? error.message : String(error)}`);
    const path = await persist();
    const failure = error instanceof Error ? error : new Error(String(error));
    if (path) {
      failure.message += `\nFull log: ${path}`;
      (failure as Error & { logPath?: string }).logPath = path;
    }
    throw failure;
  }
}

/** The existing `dl model [ID]` picker lives in laptop/settings.ts; only subcommands come here. */
async function modelCommandInner(action: string, args: string[], options: ModelCommandOptions): Promise<number> {
  const { system, ui } = options;
  if ((action === "up" || action === "update") && args.length > 1 || (action === "status" || action === "rollback" || action === "bench") && args.length > 0) {
    ui.line("failed", "Usage", `dl model ${action}${action === "up" || action === "update" ? " [model] [--dry-run]" : ""}`);
    return 2;
  }
  const statePath = options.statePath ?? modelStatePath();
  const state = await readModelState(system, statePath);
  if (action === "status") {
    if (!state) { ui.line("info", "Model", "none · dl model up"); return 0; }
    const running = await containerRunning(system, state.active.container);
    ui.line(running ? "done" : "failed", "Model", state.active.repo);
    ui.line("info", "API", `${modelApiBase(state.active)} · ${running ? "running" : "stopped"}`);
    const hardware = await detectHardware(system).catch(() => undefined);
    if (hardware) {
      showHardware(ui, hardware);
      const free = hardware.gpus.reduce((sum, gpu) => sum + gpu.freeMiB, 0);
      const total = hardware.gpus.reduce((sum, gpu) => sum + gpu.totalMiB, 0);
      ui.line("info", "GPU memory", `${Math.round(free / 1024)} of ${Math.round(total / 1024)} GB free`);
    }
    const last = state.active.lastTest;
    const mark = (ok: boolean) => (ok ? "✓" : "✗");
    ui.line("info", "Last test", `chat ${mark(last.chat)} · tools ${mark(last.tools)} · JSON ${mark(last.json)} · ${last.tokensPerSecond} tok/s`);
    if (last.at) ui.line("info", "Tested", last.at.replace("T", " ").slice(0, 16));
    if (state.previous) ui.line("info", "Previous", `${state.previous.id} · dl model rollback`);
    return running ? 0 : 1;
  }
  if (action === "bench") {
    if (!state) throw new Error("No model is installed. Run dl model up first.");
    if (!(await containerRunning(system, state.active.container))) throw new Error(`Model container ${state.active.container} is stopped; bench needs a running model.`);
    const result = await benchModel(state.active, system, options.fetch);
    for (const level of result.levels) ui.line("info", `${level.concurrency} at once, ${level.requests} reqs`, `TTFT p50 ${level.ttftP50}s p95 ${level.ttftP95}s · ${level.decodeTokPerSec} tok/s`);
    if (result.prefixCacheHitRate !== undefined) ui.line("info", "Prefix cache", `${result.prefixCacheHitRate}% hits (vLLM logs)`);
    return 0;
  }
  if (action !== "up" && action !== "update" && action !== "rollback") return 2;
  if (action === "up" && state) {
    const running = await containerRunning(system, state.active.container);
    throw new Error(running
      ? "A model is already serving on this machine. Use dl model update [model] to replace it."
      : `The configured model ${state.active.container} is stopped. Restart it with docker start ${state.active.container}, or replace it with dl model update [model].`);
  }
  if (action !== "up" && !state) throw new Error("No model is installed. Run dl model up first.");
  if (action === "rollback" && !state?.previous) throw new Error("No previous model is available for rollback.");
  const hardware = await detectHardware(system);
  await checkGpuDocker(system);
  if (!options.hardwareShown) showHardware(ui, hardware);
  const maxTotal = Math.max(...hardware.gpus.map((gpu) => gpu.totalMiB));
  const previous = state?.previous;
  const selected: ModelRecipe = action === "rollback"
    ? { id: previous!.id, repo: previous!.repo, minVramMiB: previous!.minVramMiB, gpuMemoryUtilization: previous!.gpuMemoryUtilization ?? 0.9, image: previous!.image, flags: previous!.flags,
      ...(previous!.env ? { env: previous!.env } : {}), ...(previous!.engine ? { engine: previous!.engine } : {}), defaultContext: previous!.context }
    : await selectModel(options, args[0], hardware.gpus);
  // A multi-GPU model gets its layout for this machine's GPUs and links; one GPU adds no flags.
  // Rollback restarts the previous deployment's layout as it was.
  const layout = action === "rollback" ? previous!.parallel && { ...previous!.parallel, interconnect: interconnect(hardware.topology, previous!.parallel.gpus), why: "as before" }
    : chooseParallelism(selected, hardware.gpus, hardware.topology);
  const parallel = layout && layout.gpus.length > 1 ? layout : undefined;
  if (parallel) ui.line("info", "Layout", parallel.why);
  // Per-GPU-family flags (byGpu) follow the GPUs it runs on; a rollback's stored flags already have them.
  const computeCap = action === "rollback" ? undefined : hardware.gpus.find((gpu) => gpu.index === (layout?.gpus[0] ?? hardware.gpus[0]!.index))?.computeCap;
  const extras: LaunchExtras = { parallel, computeCap };
  const old = state?.active;
  if (old && !(await containerRunning(system, old.container))) throw new Error(`Current model container ${old.container} is stopped; restart it before changing models.`);
  const interactive = isInteractive(options);
  const contextText = action === "rollback" ? String(previous!.context) : interactive ? (await options.prompter.text(ui.prompt("Context length", `512–${selected.defaultContext} · default ${selected.defaultContext}`))).trim() : "";
  const context = contextText ? Number(contextText) : selected.defaultContext;
  const portText = action === "rollback" ? String(previous!.port) : interactive ? (await options.prompter.text(ui.prompt("Port", `default ${old ? old.port + 1 : 8000}`))).trim() : "";
  const port = portNumber(portText || String(old ? old.port + 1 : 8000));
  if (old && port === old.port) throw new Error("The new model needs a different port from the current model.");
  const slot = old?.container === "dl-model-1" ? 2 : 1;
  const candidateContainer = `dl-model-${slot}`;
  // A container a failed attempt left running for inspection is reused when it runs this exact
  // recipe and answers; otherwise it is replaced (and the GPU memory it held is counted again).
  const existing = await reusable(options, selected, port, context, slot, extras);
  const reuse = existing === "reuse";
  // Check the spare slot before stopping anything: a stale candidate must not cause downtime.
  if (old && !reuse && await containerRunning(system, candidateContainer)) {
    const spare = await inspectContainer(system, candidateContainer);
    if (spare?.spec !== containerSpec(selected, port, context, slot, extras)) throw new Error(`Spare container ${candidateContainer} is running; stop it manually before changing models.`);
  }
  if (existing === "replace") {
    const wasRunning = await containerRunning(system, candidateContainer);
    await removeContainer(system, candidateContainer);
    if (wasRunning && !system.dryRun) hardware.gpus = (await detectHardware(system)).gpus;
  }
  // nvidia-smi free memory is per GPU. Do not sum several cards: vLLM is configured for one GPU.
  // vLLM reserves gpuMemoryUtilization * total VRAM, not minVramMiB: that is what side-by-side must fit.
  const reserveMiB = Math.ceil(selected.gpuMemoryUtilization * maxTotal);
  if (reserveMiB < selected.minVramMiB) throw new Error(`${selected.id} gpu-memory-utilization ${selected.gpuMemoryUtilization} reserves ${Math.floor(reserveMiB / 1024)} GB, less than the ${Math.ceil(selected.minVramMiB / 1024)} GB the model needs.`);
  // A reused candidate already holds its memory.
  const enoughFree = reuse || hardware.gpus.some((gpu) => gpu.freeMiB >= reserveMiB);
  if (old) ui.line("info", "Update", enoughFree
    ? `side-by-side, ${Math.ceil(reserveMiB / 1024)} GB new + ${Math.ceil((old.gpuMemoryUtilization ?? 0.9) * maxTotal / 1024)} GB old`
    : `downtime: ${Math.ceil(Math.max(...hardware.gpus.map((gpu) => gpu.freeMiB)) / 1024)} GB free, needs ${Math.ceil(reserveMiB / 1024)} GB`);
  let stoppedOld = false;
  if (old && !enoughFree) {
    ui.warn("Not enough GPU memory for both models: the current one stops first.");
    if (system.dryRun) ui.line("info", "Dry run", "would ask to confirm downtime");
    else if (!interactive) throw new Error("Not enough free GPU memory for both models. Free VRAM or run on a terminal to accept downtime.");
    else if (!/^y(es)?$/i.test((await options.prompter.text(ui.prompt("Accept downtime?", "y/N"))).trim())) { ui.finish(); return 130; }
    await system.run("docker", ["stop", old.container]);
    stoppedOld = true;
  }
  if (!old && !enoughFree) throw new Error(`${selected.id} reserves ${Math.ceil(reserveMiB / 1024)} GB of GPU VRAM but the largest GPU has ${Math.ceil(Math.max(...hardware.gpus.map((gpu) => gpu.freeMiB)) / 1024)} GB free.`);
  if (old && existing === "none") await removeContainer(system, candidateContainer);
  const configPath = options.configPath ?? autopilotConfigFile();
  const previousConfig = await system.readFile(configPath);
  const previousState = await system.readFile(statePath);
  const progress = { started: false };
  try {
    const candidate = await launch(options, selected, port, context, slot, reuse, progress, extras);
    if (system.dryRun) {
      if (old && !stoppedOld) await system.run("docker", ["stop", old.container]);
      ui.line("info", "Dry run", "No model, provider or state changed.");
      return 0;
    }
    // Test the previous endpoint too — but only the candidate gates the switch: a broken incumbent is a reason to switch, not to abort.
    if (old && !stoppedOld) {
      try {
        const oldResult = await (options.smoke ?? smokeTest)(old, system, options.fetch);
        ui.line("info", "Checks", `old ${oldResult.chat ? "✓" : "✗"}${oldResult.tools ? "✓" : "✗"}${oldResult.json ? "✓" : "✗"} · new ✓✓✓ (chat, tools, JSON)`);
      } catch (error) {
        ui.warn(fitWarning("Old model failed its re-test, switching anyway: ", firstLine(error)));
      }
      try {
        const measure = options.bench ?? benchModel;
        const oldBench = await measure(old, system, options.fetch, { levels: [1] });
        const newBench = await measure(candidate, system, options.fetch, { levels: [1] });
        const oldRate = oldBench.levels[0]?.decodeTokPerSec;
        const newRate = newBench.levels[0]?.decodeTokPerSec;
        if (oldRate === undefined || newRate === undefined) throw new Error("single-request bench returned no result");
        ui.line("info", "Speed (512 tokens)", `old ${oldRate} · new ${newRate} tok/s`);
      } catch (error) {
        ui.warn(fitWarning("Speed comparison failed, switching anyway: ", firstLine(error)));
        ui.line("info", "Speed (512 tokens)", "not compared, bench failed");
      }
    } else if (old) ui.line("info", "Speed", `new ${candidate.lastTest.tokensPerSecond} tok/s (old was stopped)`);
    await configureProvider(options, candidate, configPath);
    await writeModelState(system, { version: 1, active: candidate, ...(old ? { previous: old } : {}) }, statePath);
    if (old) await system.run("docker", ["stop", old.container]);
    ui.line("done", "Model serving", candidate.repo);
    ui.line("info", "API", modelApiBase(candidate));
    return 0;
  } catch (error) {
    if (!system.dryRun) {
      // A container that started is kept so it can be inspected (and reused by a retry), unless
      // the old model was stopped for it and needs the GPU back.
      const keep = progress.started && !(stoppedOld && old);
      const notes: string[] = [];
      if (keep) {
        const running = await containerRunning(system, candidateContainer);
        notes.push(running ? `The vLLM container is still running: docker logs ${candidateContainer}` : `The vLLM container stopped: docker logs ${candidateContainer}`,
          `${running ? "Stop" : "Remove"} it with docker rm -f ${candidateContainer}${running ? `; dl model ${action} reuses it while it answers` : ""}`);
      } else await removeContainer(system, candidateContainer);
      if (error instanceof SmokeError && error.curl) notes.push(`Reproduce: ${error.curl}`);
      if (stoppedOld && old) await system.run("docker", ["start", old.container]);
      // Put the provider and state back if either was written before the failure.
      if (previousConfig !== undefined) await system.writeFile(configPath, previousConfig, { mode: 0o600 });
      else await system.remove(configPath);
      if (previousState !== undefined) await system.writeFile(statePath, previousState, { mode: 0o600 });
      else await system.remove(statePath);
      // After the reason (first line), before "Full log": never server logs, only what to run.
      for (const note of notes) options.record?.(note);
      if (notes.length && error instanceof Error) error.message += `\n${notes.join("\n")}`;
    }
    throw error;
  }
}
