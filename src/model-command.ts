import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { autopilotConfigFile } from "./laptop/free-tier.js";
import { fittingModels, gpuCounts, recipe, type ModelRecipe } from "./model-catalog.js";
import { checkGpuDocker, containerRunning, containerSpec, detectHardware, dockerArgs, downloadedBytes, gpuLine, inspectContainer, logTail, modelDownloadBytes, removeContainer, type Gpu, type Hardware, type LaunchExtras, containerName, maxContext, recipeFor } from "./model-runtime.js";
import { chooseParallelism, type ParallelPlan } from "./model-parallel.js";
import { interconnect } from "./model-topology.js";
import { engine } from "./model-engines.js";
import { gib, hostResources, memoryLimitBytes, preflight, preflightError } from "./model-preflight.js";
import { bench as benchModel } from "./model-bench.js";
import { FIRST_ANSWER_MS, localFetch, modelApiBase, SmokeError, smokeTest, type FetchModel, type SmokeCheck } from "./model-smoke.js";
import { DEFAULT_DEPLOYMENT, modelStatePath, readDeployments, writeDeployment, type ModelDeployment, type ModelState } from "./state.js";
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
  /** --name: which deployment (default: the unnamed one). */
  name?: string;
  /** --gpus: host GPU indices ("0,1") the deployment is pinned to. */
  gpus?: string;
  /** --port and --context: answers to the questions up and update ask on a terminal. */
  port?: string;
  context?: string;
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


/**
 * The "Download" step's progress while vLLM isn't answering yet: bytes in the model's Hugging
 * Face cache folder against its size from the Hugging Face API (or just bytes, when the size
 * can't be read). It moves on to "Start vLLM" when the download is complete or vLLM's log says
 * the weights are loading.
 */
function downloadWatch(options: ModelCommandOptions, model: ModelRecipe, container: string) {
  const { system, ui } = options;
  const server = engine(model.engine);
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
      if ((total && last >= total * 0.98) || server.loading.test(`${logs?.stdout ?? ""}${logs?.stderr ?? ""}`)) {
        toReady();
        return moved;
      }
      ui.start("download", last === 0 ? `waiting for ${server.label}` : total ? `${gbText(last)} of ${gbText(total)} GB · ${Math.min(99, Math.floor(last / total * 100))}%` : `${gbText(last)} GB so far`);
      return moved;
    },
  };
}

/** The container's recent logs go to the run log, never the screen. */
async function recordLogs(options: ModelCommandOptions, container: string, label = "vLLM", lines = 200): Promise<void> {
  if (!options.record) return;
  const tail = await logTail(options.system, container, lines).catch(() => "");
  options.record(`${label} logs (${container}, last ${lines} lines):`);
  for (const line of tail.split("\n")) options.record(`  ${line}`);
}

/**
 * Whether a container left running by an earlier, failed attempt can be used as is: it runs the
 * same recipe (same image, model, flags, port and context) and its API answers.
 */
async function reusable(options: ModelCommandOptions, model: ModelRecipe, port: number, context: number, slot: number, extras: LaunchExtras = {}): Promise<"reuse" | "replace" | "none"> {
  const existing = await inspectContainer(options.system, containerName(extras.name, slot));
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
  const container = containerName(extras.name, slot);
  const server = engine(model.engine);
  const resolved = recipeFor(model, extras.computeCap);
  const deployment: ModelDeployment = { id: model.id, repo: model.repo, container, port, context,
    // The flags and environment as run (per-GPU-family ones included), so rollback restarts exactly this.
    image: model.image, flags: resolved.flags, minVramMiB: model.minVramMiB, gpuMemoryUtilization: model.gpuMemoryUtilization,
    ...(Object.keys(resolved.env).length ? { env: resolved.env } : {}),
    ...(model.engine && model.engine !== "vllm" ? { engine: model.engine } : {}),
    ...(extras.name ? { name: extras.name } : {}), ...(extras.devices ? { devices: [...extras.devices] } : {}),
    ...(extras.memoryBytes ? { memoryBytes: extras.memoryBytes } : {}),
    ...(extras.parallel ? { parallel: { gpus: extras.parallel.gpus, tp: extras.parallel.tp, pp: extras.parallel.pp, ep: extras.parallel.ep } } : {}),
    lastTest: { chat: false, tools: false, json: false, tokensPerSecond: 0, at: "" } };
  ui.plan([
    { id: "launch", label: `Start the ${server.label} container` },
    { id: "download", label: `Download ${model.id}` },
    { id: "ready", label: `Start ${server.label}` },
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
    await recordLogs(options, container, server.label);
    throw new Error(`Could not start ${server.label}: ${firstLine(error)}`);
  }
  if (system.dryRun) { ui.finish(); return deployment; }
  options.record?.(`logs: docker logs -f ${container}`);
  const watch = downloadWatch(options, model, container);
  let current: SmokeCheck | "download" = "download";
  ui.start("download", `waiting for ${server.label}`);
  if (reuse) watch.ready();
  try {
    deployment.lastTest = await (options.smoke ?? smokeTest)(deployment, system, options.fetch, {
      waiting: watch.poll,
      ...(options.delay ? { delay: options.delay } : {}),
      running: () => containerRunning(system, container),
      ...(options.record ? { record: options.record } : {}),
      ...(server.id !== "vllm" ? { engineLabel: server.label } : {}),
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
    // The engine's startup goes in the run log too, for comparing a later failure with a good start.
    await recordLogs(options, container, server.label, 50);
    return deployment;
  } catch (error) {
    const step = error instanceof SmokeError && error.check !== "ready" ? error.check : current === "download" || current === "ready" ? watch.phase() : current;
    ui.fail(step, error instanceof SmokeError ? error.short : firstLine(error));
    ui.finish();
    await recordLogs(options, container, server.label);
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

/** A deployment name: lowercase letters, digits and dashes, so it fits a container name. */
export function deploymentName(text: string | undefined): string {
  const name = text?.trim() || DEFAULT_DEPLOYMENT;
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(name)) throw new Error(`Deployment name "${name}" must be lowercase letters, digits and dashes (at most 31).`);
  return name;
}

/** --gpus "0,1": host GPU indices that exist, without repeats. */
export function parseGpuList(text: string, gpus: readonly Gpu[]): Gpu[] {
  const indices = text.split(",").map((part) => part.trim());
  if (indices.some((index) => !/^\d+$/.test(index))) throw new Error(`--gpus takes GPU indices like 0,1 (got "${text}").`);
  const chosen = [...new Set(indices.map(Number))].sort((a, b) => a - b);
  const missing = chosen.filter((index) => !gpus.some((gpu) => gpu.index === index));
  if (missing.length) throw new Error(`No GPU ${missing.join(", ")} on this machine; it has ${gpus.map((gpu) => gpu.index).join(", ")}.`);
  return gpus.filter((gpu) => chosen.includes(gpu.index));
}

/**
 * The host GPUs a container may see: all it was pinned to (they're reserved for it, and the
 * engine takes the first ones it sees), unless the layout picked others among them; unpinned, the
 * layout's GPUs when it uses some of the machine's; otherwise undefined (every GPU, as 0.30.1).
 */
export function devicesFor(pinned: readonly Gpu[] | undefined, layout: Pick<ParallelPlan, "gpus"> | undefined, machineGpus: number): number[] | undefined {
  const pinnedIndices = pinned?.map((gpu) => gpu.index);
  if (pinnedIndices) return layout && !layout.gpus.every((index, at) => pinnedIndices[at] === index) ? layout.gpus : pinnedIndices;
  return layout && layout.gpus.length > 1 && layout.gpus.length < machineGpus ? layout.gpus : undefined;
}

/** Ports other deployments hold (their current and previous), so a new one or an update can't take one. */
export function takenPorts(others: ReadonlyArray<[string, Omit<ModelState, "version">]>): Map<number, string> {
  return new Map(others.flatMap(([other, entry]) => [entry.active, ...(entry.previous ? [entry.previous] : [])].map((deployment) => [deployment.port, other] as const)));
}

/** The first free port: after the current one for an update; a new named deployment also keeps the next one free for its updates. */
export function defaultPortFor(old: ModelDeployment | undefined, named: boolean, taken: ReadonlyMap<number, string>): number {
  let port = old ? old.port + 1 : 8000;
  if (old) while (taken.has(port)) port++;
  else if (named) while (taken.has(port) || taken.has(port + 1)) port += 2;
  return port;
}

/** `dl model list`: every deployment on this machine. */
async function listDeployments(options: ModelCommandOptions, deployments: Record<string, Omit<ModelState, "version">>): Promise<number> {
  const names = Object.keys(deployments).sort((a, b) => (a === DEFAULT_DEPLOYMENT ? -1 : b === DEFAULT_DEPLOYMENT ? 1 : a.localeCompare(b)));
  if (names.length === 0) { options.ui.line("info", "Models", "none · dl model up"); return 0; }
  for (const name of names) {
    const active = deployments[name]!.active;
    const running = await containerRunning(options.system, active.container);
    const gpus = active.devices ? active.devices.join(",") : active.parallel ? active.parallel.gpus.join(",") : "all";
    options.ui.line(running ? "done" : "failed", name, `${active.id} · ${engine(active.engine).label} · GPUs ${gpus} · port ${active.port} · ${running ? "running" : "stopped"}`);
  }
  return 0;
}

/**
 * The preflight before anything is downloaded, for models with known sizes: VRAM per GPU, host
 * RAM for offloaded weights, disk for the weights (their size from the Hugging Face API, else the
 * catalog's), and the driver. Throws what's short and the nearest option that fits.
 */
async function checkFits(options: ModelCommandOptions, model: ModelRecipe, context: number, hardware: Hardware, usable: readonly Gpu[], ramNeedBytes: number | undefined): Promise<void> {
  if (!model.memory) return;
  const { system, ui } = options;
  const host = await hostResources(system);
  const live = await modelDownloadBytes(model.repo, options.fetch ?? fetch);
  const result = preflight({ model, context, hardware, usable, host, liveWeightsBytes: live, ramNeedBytes })!;
  const first = result.gpus[0]!;
  ui.line(result.problems.length ? "failed" : "info", "Memory", `${gib(first.weightsBytes)} weights + ${gib(first.kvBytes + first.bufferBytes)} KV/buffers per GPU of ${gib(first.budgetBytes)}`
    + `${result.ramNeedBytes ? ` · RAM ${gib(result.ramNeedBytes)}` : ""} · disk ${gib(result.weightsBytes)}`);
  for (const warning of result.warnings) ui.warn(warning);
  for (const caveat of caveatsFor(model, usable)) ui.warn(caveat);
  if (result.problems.length) throw preflightError(result);
}

/** A recipe's caveats that apply to these GPUs. */
export function caveatsFor(model: ModelRecipe, gpus: readonly Pick<Gpu, "computeCap">[]): string[] {
  const majors = new Set(gpus.map((gpu) => gpu.computeCap?.split(".")[0]));
  return (model.caveats ?? []).filter((caveat) => !caveat.computeCaps || caveat.computeCaps.some((cap) => majors.has(cap))).map((caveat) => caveat.text);
}

/** The existing `dl model [ID]` picker lives in laptop/settings.ts; only subcommands come here. */
async function modelCommandInner(action: string, args: string[], options: ModelCommandOptions): Promise<number> {
  const { system, ui } = options;
  if ((action === "up" || action === "update") && args.length > 1 || (action === "status" || action === "rollback" || action === "bench" || action === "list") && args.length > 0) {
    ui.line("failed", "Usage", `dl model ${action}${action === "up" || action === "update" ? " [model] [--dry-run]" : ""}`);
    return 2;
  }
  const statePath = options.statePath ?? modelStatePath();
  const name = deploymentName(options.name);
  const named = name !== DEFAULT_DEPLOYMENT;
  const deployments = await readDeployments(system, statePath);
  if (action === "list") return listDeployments(options, deployments);
  const state = deployments[name];
  /** "dl model rollback --name b": commands name a named deployment. */
  const command = (verb: string) => `dl model ${verb}${named ? ` --name ${name}` : ""}`;
  const others = Object.entries(deployments).filter(([other]) => other !== name);
  if (action === "status") {
    if (!state) { ui.line("info", "Model", named ? `no deployment named ${name} · dl model list` : "none · dl model up"); return 0; }
    const running = await containerRunning(system, state.active.container);
    ui.line(running ? "done" : "failed", "Model", state.active.repo);
    ui.line("info", "API", `${modelApiBase(state.active)} · ${running ? "running" : "stopped"}`);
    // Only what 0.30.1 didn't have: the engine when it isn't vLLM, the GPUs when pinned or several.
    if (state.active.engine && state.active.engine !== "vllm") ui.line("info", "Engine", engine(state.active.engine).label);
    if (state.active.devices || state.active.parallel) ui.line("info", "GPUs", `${(state.active.devices ?? state.active.parallel!.gpus).join(", ")}${state.active.parallel ? ` · TP ${state.active.parallel.tp}${state.active.parallel.pp > 1 ? ` · PP ${state.active.parallel.pp}` : ""}` : ""}`);
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
    if (state.previous) ui.line("info", "Previous", `${state.previous.id} · ${command("rollback")}`);
    if (!named && others.length) ui.line("info", "Others", `${others.map(([other]) => other).join(", ")} · dl model list`);
    return running ? 0 : 1;
  }
  const noModel = () => new Error(named ? `No deployment named ${name}. Run dl model up [model] --name ${name} first, or see dl model list.` : "No model is installed. Run dl model up first.");
  if (action === "bench") {
    if (!state) throw noModel();
    if (!(await containerRunning(system, state.active.container))) throw new Error(`Model container ${state.active.container} is stopped; bench needs a running model.`);
    const result = await benchModel(state.active, system, options.fetch);
    for (const level of result.levels) ui.line("info", `${level.concurrency} at once, ${level.requests} reqs`, `TTFT p50 ${level.ttftP50}s p95 ${level.ttftP95}s · ${level.decodeTokPerSec} tok/s`);
    if (result.prefixCacheHitRate !== undefined) ui.line("info", "Prefix cache", `${result.prefixCacheHitRate}% hits (${engine(state.active.engine).label} logs)`);
    return 0;
  }
  if (action !== "up" && action !== "update" && action !== "rollback") return 2;
  if (action === "up" && state) {
    const running = await containerRunning(system, state.active.container);
    throw new Error(running
      ? named ? `A model is already serving as ${name}. Use ${command("update")} [model] to replace it, or pick another --name.` : "A model is already serving on this machine. Use dl model update [model] to replace it."
      : `The configured model ${state.active.container} is stopped. Restart it with docker start ${state.active.container}, or replace it with ${command("update")} [model].`);
  }
  if (action !== "up" && !state) throw noModel();
  if (action === "rollback" && !state?.previous) throw new Error("No previous model is available for rollback.");
  const hardware = await detectHardware(system);
  await checkGpuDocker(system);
  if (!options.hardwareShown) showHardware(ui, hardware);
  const previous = state?.previous;
  const old = state?.active;
  // --gpus pins the deployment to those GPUs; an update keeps the current pinning unless given anew.
  const pinned = options.gpus !== undefined ? parseGpuList(options.gpus, hardware.gpus)
    : action === "rollback" ? previous!.devices && hardware.gpus.filter((gpu) => previous!.devices!.includes(gpu.index))
      : old?.devices && hardware.gpus.filter((gpu) => old.devices!.includes(gpu.index));
  const usable = pinned ?? hardware.gpus;
  if (pinned) ui.line("info", "GPUs", `${pinned.map((gpu) => gpu.index).join(", ")} (of ${hardware.gpus.length})`);
  const maxTotal = Math.max(...usable.map((gpu) => gpu.totalMiB));
  const selected: ModelRecipe = action === "rollback"
    ? { id: previous!.id, repo: previous!.repo, minVramMiB: previous!.minVramMiB, gpuMemoryUtilization: previous!.gpuMemoryUtilization ?? 0.9, image: previous!.image, flags: previous!.flags,
      ...(previous!.env ? { env: previous!.env } : {}), ...(previous!.engine ? { engine: previous!.engine } : {}), defaultContext: previous!.context }
    : await selectModel(options, args[0], usable);
  // A multi-GPU model gets its layout for these GPUs and their links; one GPU adds no flags.
  // Rollback restarts the previous deployment's layout as it was.
  const layout = action === "rollback" ? previous!.parallel && { ...previous!.parallel, interconnect: interconnect(hardware.topology, previous!.parallel.gpus), why: "as before" }
    : chooseParallelism(selected, usable, hardware.topology);
  const parallel = layout && layout.gpus.length > 1 ? layout : undefined;
  if (parallel) ui.line("info", "Layout", parallel.why);
  // The container sees only its GPUs when pinned (all it was given: they're reserved for it, and
  // the engine takes the first ones it sees), or when its layout uses some of the machine's GPUs.
  const devices = devicesFor(pinned, layout, hardware.gpus.length);
  // Two deployments never share a pinned GPU; one that sees every GPU is a warning, not an error.
  for (const [other, entry] of others) {
    const theirs = entry.active.devices;
    if (devices && theirs) {
      const shared = devices.filter((index) => theirs.includes(index));
      if (shared.length) throw new Error(`GPU ${shared.join(", ")} is already used by deployment ${other}; pick others with --gpus (dl model list).`);
    } else ui.warn(`Deployment ${other} ${theirs ? "uses GPUs " + theirs.join(",") : "sees every GPU"} and this one ${devices ? "uses GPUs " + devices.join(",") : "sees every GPU"}: pin both with --gpus to keep them apart.`);
  }
  // Per-GPU-family flags (byGpu) follow the GPUs it runs on; a rollback's stored flags already have them.
  const computeCap = action === "rollback" ? undefined : hardware.gpus.find((gpu) => gpu.index === (layout?.gpus[0] ?? hardware.gpus[0]!.index))?.computeCap;
  const memoryBytes = action === "rollback" ? previous!.memoryBytes : memoryLimitBytes(selected, layout?.gpus.length ?? 1);
  const extras: LaunchExtras = { parallel, computeCap, ...(named ? { name } : {}), ...(devices ? { devices } : {}), ...(memoryBytes ? { memoryBytes } : {}) };
  if (old && !(await containerRunning(system, old.container))) throw new Error(`Current model container ${old.container} is stopped; restart it before changing models.`);
  const interactive = isInteractive(options);
  const limit = maxContext(selected);
  const contextText = action === "rollback" ? String(previous!.context) : options.context ?? (interactive ? (await options.prompter.text(ui.prompt("Context length", `512–${limit} · default ${selected.defaultContext}`))).trim() : "");
  const context = contextText ? Number(contextText) : selected.defaultContext;
  if (!Number.isInteger(context) || context < 512 || context > limit) throw new Error(`Context length must be between 512 and ${limit} for ${selected.id}.`);
  if (action !== "rollback") await checkFits(options, selected, context, hardware, usable, memoryBytes);
  // Ports other deployments hold (their current and previous), so an update can't take one.
  const taken = takenPorts(others);
  const defaultPort = defaultPortFor(old, named, taken);
  const portText = action === "rollback" ? String(previous!.port) : options.port ?? (interactive ? (await options.prompter.text(ui.prompt("Port", `default ${defaultPort}`))).trim() : "");
  const port = portNumber(portText || String(defaultPort));
  if (old && port === old.port) throw new Error("The new model needs a different port from the current model.");
  if (taken.has(port)) throw new Error(`Port ${port} belongs to deployment ${taken.get(port)}; pick another with --port.`);
  const slot = old?.container === containerName(name, 1) ? 2 : 1;
  const candidateContainer = containerName(name, slot);
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
  // nvidia-smi free memory is per GPU. The engine reserves gpuMemoryUtilization * total VRAM on each
  // GPU it uses, not minVramMiB: that is what side-by-side must fit.
  // One unpinned GPU (the 0.30.1 path): any GPU with room. Otherwise: every GPU it will use.
  const used = devices ? (layout?.gpus ?? devices) : parallel?.gpus;
  const reserveMiB = Math.ceil(selected.gpuMemoryUtilization * maxTotal);
  if (!used && reserveMiB < selected.minVramMiB) throw new Error(`${selected.id} gpu-memory-utilization ${selected.gpuMemoryUtilization} reserves ${Math.floor(reserveMiB / 1024)} GB, less than the ${Math.ceil(selected.minVramMiB / 1024)} GB the model needs.`);
  const targets = used ? hardware.gpus.filter((gpu) => used.includes(gpu.index)) : hardware.gpus;
  const short = used ? targets.filter((gpu) => gpu.freeMiB < Math.ceil(selected.gpuMemoryUtilization * gpu.totalMiB)) : [];
  // A reused candidate already holds its memory.
  const enoughFree = reuse || (used ? short.length === 0 : hardware.gpus.some((gpu) => gpu.freeMiB >= reserveMiB));
  const perGpu = used ? " per GPU" : "";
  if (old) ui.line("info", "Update", enoughFree
    ? `side-by-side, ${Math.ceil(reserveMiB / 1024)} GB new + ${Math.ceil((old.gpuMemoryUtilization ?? 0.9) * maxTotal / 1024)} GB old${perGpu}`
    : used ? `downtime: GPU ${short.map((gpu) => `${gpu.index} has ${Math.floor(gpu.freeMiB / 1024)} GB free`).join(", GPU ")}, needs ${Math.ceil(reserveMiB / 1024)} GB per GPU`
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
  if (!old && !enoughFree) {
    throw new Error(used
      ? `${selected.id} reserves ${Math.round(selected.gpuMemoryUtilization * 100)}% of each GPU's VRAM, but GPU ${short.map((gpu) => `${gpu.index} has ${Math.floor(gpu.freeMiB / 1024)} GB free`).join(", GPU ")}.`
      : `${selected.id} reserves ${Math.ceil(reserveMiB / 1024)} GB of GPU VRAM but the largest GPU has ${Math.ceil(Math.max(...hardware.gpus.map((gpu) => gpu.freeMiB)) / 1024)} GB free.`);
  }
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
    await writeDeployment(system, name, { active: candidate, ...(old ? { previous: old } : {}) }, statePath);
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
        const label = engine(selected.engine).label;
        notes.push(running ? `The ${label} container is still running: docker logs ${candidateContainer}` : `The ${label} container stopped: docker logs ${candidateContainer}`,
          `${running ? "Stop" : "Remove"} it with docker rm -f ${candidateContainer}${running ? `; ${command(action)} reuses it while it answers` : ""}`);
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
