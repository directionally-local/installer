import { dirname } from "node:path";
import { autopilotConfigFile } from "./laptop/free-tier.js";
import { fittingModels, recipe, type ModelRecipe } from "./model-catalog.js";
import { checkGpuDocker, containerRunning, detectHardware, dockerArgs, logTail, removeContainer } from "./model-runtime.js";
import { smokeTest, type FetchModel } from "./model-smoke.js";
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
}

function isInteractive(options: ModelCommandOptions): boolean {
  return options.interactive ?? options.ui.interactive;
}

function portNumber(text: string): number {
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isInteger(value) || value < 1 || value > 65534) throw new Error("Port must be an integer between 1 and 65534 (the next port is reserved for updates).");
  return value;
}

async function selectModel(options: ModelCommandOptions, id: string | undefined, availableMiB: number): Promise<ModelRecipe> {
  const choices = fittingModels(availableMiB);
  if (choices.length === 0) throw new Error(`No catalog models fit ${Math.floor(availableMiB / 1024)} GB of GPU VRAM.`);
  options.ui.line("info", "Models that fit", choices.map((item) => `${item.id} (${Math.ceil(item.minVramMiB / 1024)} GB)`).join(" · "));
  if (id) {
    const selected = recipe(id);
    if (!choices.includes(selected)) throw new Error(`${selected.id} needs ${Math.ceil(selected.minVramMiB / 1024)} GB of GPU VRAM.`);
    return selected;
  }
  if (!isInteractive(options)) throw new Error(`Name a model: ${choices.map((item) => item.id).join(", ")}`);
  const selected = await options.prompter.select(options.ui.prompt("Model"), choices.map((item) => ({ value: item.id, label: `${item.id}  ${item.repo}`, detail: `${Math.ceil(item.minVramMiB / 1024)} GB` })));
  return recipe(selected.value);
}

async function configureProvider(options: ModelCommandOptions, deployment: ModelDeployment, path: string): Promise<void> {
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
    providers: { ...providers, vllm: { ...saved, model: deployment.repo, baseUrl: `http://127.0.0.1:${deployment.port}/v1` } } }, null, 2)}\n`, { mode: 0o600 });
}

async function launch(options: ModelCommandOptions, model: ModelRecipe, port: number, context: number, slot: number): Promise<ModelDeployment> {
  const container = `dl-model-${slot}`;
  const deployment: ModelDeployment = { id: model.id, repo: model.repo, container, port, context,
    image: model.image, flags: model.flags, minVramMiB: model.minVramMiB, gpuMemoryUtilization: model.gpuMemoryUtilization,
    lastTest: { chat: false, tools: false, json: false, tokensPerSecond: 0, at: "" } };
  options.ui.plan([{ id: "launch", label: `Download and start ${model.id}` }, { id: "test", label: "Chat, tool call and JSON smoke tests" }]);
  options.ui.start("launch", model.image);
  try {
    await options.system.run("docker", dockerArgs(model, port, context, slot));
    options.ui.done("launch", `port ${port} · logs: docker logs -f ${container}`);
  } catch (error) {
    options.ui.fail("launch", error instanceof Error ? error.message : String(error));
    throw new Error(`Could not start vLLM: ${error instanceof Error ? error.message : String(error)}\n${await logTail(options.system, container)}`);
  }
  if (options.system.dryRun) { options.ui.finish(); return deployment; }
  options.ui.start("test", "waiting for download and API readiness (up to 5 minutes)");
  try {
    deployment.lastTest = await (options.smoke ?? smokeTest)(deployment, options.system, options.fetch);
    options.ui.done("test", `${deployment.lastTest.tokensPerSecond} tokens/sec`);
    options.ui.finish();
    return deployment;
  } catch (error) {
    options.ui.fail("test", error instanceof Error ? error.message : String(error));
    options.ui.finish();
    throw error;
  }
}

/** The existing `dl model [ID]` picker lives in laptop/settings.ts; only subcommands come here. */
export async function modelCommand(action: string, args: string[], options: ModelCommandOptions): Promise<number> {
  const { system, ui } = options;
  if ((action === "up" || action === "update") && args.length > 1 || (action === "status" || action === "rollback") && args.length > 0) {
    ui.line("failed", "Usage", `dl model ${action}${action === "up" || action === "update" ? " [model] [--dry-run]" : ""}`);
    return 2;
  }
  const statePath = options.statePath ?? modelStatePath();
  const state = await readModelState(system, statePath);
  if (action === "status") {
    if (!state) { ui.line("info", "Model", "none · dl model up"); return 0; }
    const running = await containerRunning(system, state.active.container);
    ui.line(running ? "done" : "failed", "Model", `${state.active.repo} · port ${state.active.port} · ${running ? "running" : "stopped"}`);
    const hardware = await detectHardware(system).catch(() => undefined);
    if (hardware) for (const gpu of hardware.gpus) ui.line("info", `GPU ${gpu.index}`, `${gpu.name} · ${gpu.freeMiB}/${gpu.totalMiB} MiB free · driver ${gpu.driver} · CUDA ${hardware.cuda}`);
    ui.line("info", "Last test", `${state.active.lastTest.chat ? "chat ✓" : "chat ✗"} · ${state.active.lastTest.tools ? "tools ✓" : "tools ✗"} · ${state.active.lastTest.json ? "JSON ✓" : "JSON ✗"} · ${state.active.lastTest.tokensPerSecond} tokens/sec · ${state.active.lastTest.at}`);
    if (state.previous) ui.line("info", "Rollback", `${state.previous.repo} · dl model rollback`);
    return running ? 0 : 1;
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
  for (const gpu of hardware.gpus) ui.line("info", `GPU ${gpu.index}`, `${gpu.name} · ${gpu.totalMiB} MiB · driver ${gpu.driver} · CUDA ${hardware.cuda}`);
  const maxTotal = Math.max(...hardware.gpus.map((gpu) => gpu.totalMiB));
  const previous = state?.previous;
  const selected: ModelRecipe = action === "rollback"
    ? { id: previous!.id, repo: previous!.repo, minVramMiB: previous!.minVramMiB, gpuMemoryUtilization: previous!.gpuMemoryUtilization ?? 0.9, image: previous!.image, flags: previous!.flags, defaultContext: previous!.context }
    : await selectModel(options, args[0], maxTotal);
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
  // Check the spare slot before stopping anything: a stale candidate must not cause downtime.
  if (old && await containerRunning(system, candidateContainer)) throw new Error(`Spare container ${candidateContainer} is running; stop it manually before changing models.`);
  // nvidia-smi free memory is per GPU. Do not sum several cards: vLLM is configured for one GPU.
  // vLLM reserves gpuMemoryUtilization * total VRAM, not minVramMiB: that is what side-by-side must fit.
  const reserveMiB = Math.ceil(selected.gpuMemoryUtilization * maxTotal);
  if (reserveMiB < selected.minVramMiB) throw new Error(`${selected.id} gpu-memory-utilization ${selected.gpuMemoryUtilization} reserves ${Math.floor(reserveMiB / 1024)} GB, less than the ${Math.ceil(selected.minVramMiB / 1024)} GB the model needs.`);
  const enoughFree = hardware.gpus.some((gpu) => gpu.freeMiB >= reserveMiB);
  if (old) ui.line("info", "Update strategy", enoughFree
    ? `side-by-side: the old model keeps serving while ${selected.id} starts (${Math.ceil(reserveMiB / 1024)} GB new + ${Math.ceil((old.gpuMemoryUtilization ?? 0.9) * maxTotal / 1024)} GB old)`
    : `downtime: ${Math.ceil(Math.max(...hardware.gpus.map((gpu) => gpu.freeMiB)) / 1024)} GB free, ${selected.id} reserves ${Math.ceil(reserveMiB / 1024)} GB`);
  let stoppedOld = false;
  if (old && !enoughFree) {
    ui.warn("Not enough free GPU memory for both models. The current model must stop while the new one starts; there will be downtime.");
    if (system.dryRun) ui.line("info", "Dry run", "would ask to confirm downtime");
    else if (!interactive) throw new Error("Not enough free GPU memory for both models. Free VRAM or run on a terminal to accept downtime.");
    else if (!/^y(es)?$/i.test((await options.prompter.text(ui.prompt("Accept downtime?", "y/N"))).trim())) { ui.finish(); return 130; }
    await system.run("docker", ["stop", old.container]);
    stoppedOld = true;
  }
  if (!old && !enoughFree) throw new Error(`${selected.id} reserves ${Math.ceil(reserveMiB / 1024)} GB of GPU VRAM but the largest GPU has ${Math.ceil(Math.max(...hardware.gpus.map((gpu) => gpu.freeMiB)) / 1024)} GB free.`);
  if (old) await removeContainer(system, candidateContainer);
  const configPath = options.configPath ?? autopilotConfigFile();
  const previousConfig = await system.readFile(configPath);
  const previousState = await system.readFile(statePath);
  try {
    const candidate = await launch(options, selected, port, context, slot);
    if (system.dryRun) {
      if (old && !stoppedOld) await system.run("docker", ["stop", old.container]);
      ui.line("info", "Dry run", "No model, provider or state changed.");
      return 0;
    }
    // Test the previous endpoint too — but only the candidate gates the switch: a broken incumbent is a reason to switch, not to abort.
    if (old && !stoppedOld) {
      try {
        const oldResult = await (options.smoke ?? smokeTest)(old, system, options.fetch);
        ui.line("info", "Comparison", `old ${old.repo}: ${oldResult.tokensPerSecond} tok/s | new ${candidate.repo}: ${candidate.lastTest.tokensPerSecond} tok/s`);
        ui.line("info", "Checks", `old chat/tools/JSON ${oldResult.chat ? "✓" : "✗"} ${oldResult.tools ? "✓" : "✗"} ${oldResult.json ? "✓" : "✗"} | new chat/tools/JSON ✓ ✓ ✓`);
      } catch (error) {
        ui.warn(`The current model failed its smoke re-test (${error instanceof Error ? error.message.split("\n")[0] : String(error)}). Switching anyway.`);
        ui.line("info", "Comparison", `old ${old.repo}: re-test failed | new ${candidate.repo}: ${candidate.lastTest.tokensPerSecond} tok/s`);
      }
    } else if (old) ui.line("info", "Comparison", `old ${old.repo}: ${old.lastTest.tokensPerSecond} tok/s (last test) | new ${candidate.repo}: ${candidate.lastTest.tokensPerSecond} tok/s`);
    await configureProvider(options, candidate, configPath);
    await writeModelState(system, { version: 1, active: candidate, ...(old ? { previous: old } : {}) }, statePath);
    if (old) await system.run("docker", ["stop", old.container]);
    ui.line("done", "Model serving", `${candidate.repo} · http://127.0.0.1:${candidate.port}/v1`);
    return 0;
  } catch (error) {
    if (!system.dryRun) {
      await removeContainer(system, candidateContainer);
      if (stoppedOld && old) await system.run("docker", ["start", old.container]);
      // Put the provider and state back if either was written before the failure.
      if (previousConfig !== undefined) await system.writeFile(configPath, previousConfig, { mode: 0o600 });
      else await system.remove(configPath);
      if (previousState !== undefined) await system.writeFile(statePath, previousState, { mode: 0o600 });
      else await system.remove(statePath);
    }
    throw error;
  }
}
