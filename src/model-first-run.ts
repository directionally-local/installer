import { fitGpus, gpuCounts, MODEL_CATALOG, type GpuSize, type ModelRecipe } from "./model-catalog.js";
import { configureProvider, logPathOf, modelCommand, showHardware, type ModelCommandOptions } from "./model-command.js";
import { modelApiBase, SmokeError } from "./model-smoke.js";
import { checkGpuDocker, containerRunning, detectHardware, type Hardware } from "./model-runtime.js";
import { modelStatePath, readModelState } from "./state.js";
import { autopilotConfigFile } from "./laptop/free-tier.js";
import { PromptCancelled } from "./prompt.js";

/**
 * `dl model up` for the GPU-aware first run: what Autopilot hands to dl when someone says yes
 * to "Run a private model on this GPU?" (see laptop/gpu-handoff.ts). It adds what a first-time
 * user needs before `dl model up` itself runs, and then calls its entry point unchanged:
 *
 * 1. Docker and the Nvidia container toolkit: checked, and the toolkit offered for install
 *    (Ubuntu/Debian, with sudo) when it's missing.
 * 2. A model picker over the whole catalog: each model says whether it fits this GPU and
 *    whether it was tested on real hardware. Only one that fits can be started; when only one
 *    fits, it is picked and the line says why. A retry (Autopilot's "Retry") names the model
 *    and skips the picker.
 * 3. `modelCommand("up", [id])` non-interactively (default context and port): live progress,
 *    smoke tests, and the vllm provider written to Autopilot's config.
 *
 * A model this machine already serves is reused: the provider is pointed at it.
 */

/** Why the first-run model setup didn't finish: short words, sent as telemetry by Autopilot. */
export type ModelUpErrorType =
  | "cancelled"
  | "no_docker"
  | "no_toolkit"
  | "toolkit_install_failed"
  | "no_fit"
  | "already_running"
  | "launch_failed"
  | "smoke_failed"
  | "other";

/**
 * How the setup went. A failure's `message` is one short line ("Chat test: the model returned
 * no text, thinking mode used all tokens"); `log` is the run log with the details, `model` the
 * catalog id that was tried.
 */
export type ModelUpResult =
  | { ok: true; model: string }
  | { ok: false; errorType: ModelUpErrorType; message: string; log?: string; model?: string; details?: string[] };

/**
 * Catalog models verified end to end (launch, chat, tool call and JSON smoke tests, an Autopilot
 * session) on a real GPU: an RTX PRO 5000 Blackwell on 10 Nov 2026 with vLLM 0.20. Others are
 * offered as untested.
 */
export const TESTED_MODELS: ReadonlySet<string> = new Set(["qwen-new", "qwen-old"]);

/** The toolkit's install on Ubuntu/Debian, from Nvidia's guide; then Docker gets the runtime. */
export const TOOLKIT_INSTALL_SCRIPT = [
  "set -e",
  "curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg",
  "curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' > /etc/apt/sources.list.d/nvidia-container-toolkit.list",
  "apt-get update -qq",
  "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nvidia-container-toolkit",
  "nvidia-ctk runtime configure --runtime=docker",
  "systemctl restart docker",
].join("\n");

export interface FirstRunModelUpOptions extends Omit<ModelCommandOptions, "interactive"> {
  /** Whether this process runs as root (no sudo needed for the toolkit install). */
  root?: boolean;
  /** For tests; production runs `dl model up`'s own entry point. */
  modelUp?: typeof modelCommand;
  /** Run this catalog model again without the picker (a retry). */
  model?: string;
  /** The model that just failed: marked in the picker, and not the default. */
  avoid?: string;
}

const gb = (mib: number) => Math.ceil(mib / 1024);

/**
 * The picker's rows: every catalog model, with whether it fits this machine's GPUs (all of
 * them; a number is one GPU of that size) and whether it was tested.
 */
export function modelChoices(gpus: number | readonly GpuSize[]): Array<{ recipe: ModelRecipe; fits: boolean; tested: boolean }> {
  const list = typeof gpus === "number" ? [{ index: 0, totalMiB: gpus }] : gpus;
  return MODEL_CATALOG.filter((recipe) => !recipe.blocked).map((recipe) => ({ recipe, fits: fitGpus(recipe, list) !== undefined, tested: TESTED_MODELS.has(recipe.id) }));
}

/** "16 GB" for one GPU, "311 GB on 2+ GPUs" for a multi-GPU model. */
function sizeText(recipe: ModelRecipe): string {
  if (!recipe.parallel) return `${gb(recipe.minVramMiB)} GB`;
  return `${gb(recipe.minTotalVramMiB ?? recipe.minVramMiB)} GB on ${Math.min(...gpuCounts(recipe))}+ GPUs`;
}

/** Map `dl model up`'s error to a short type. */
export function modelUpErrorType(error: unknown): ModelUpErrorType {
  if (error instanceof PromptCancelled) return "cancelled";
  if (error instanceof SmokeError) return error.check === "ready" ? "launch_failed" : "smoke_failed";
  const message = error instanceof Error ? error.message : String(error);
  if (/Smoke test failed/i.test(message)) return "smoke_failed";
  if (/Could not start vLLM/i.test(message)) return "launch_failed";
  if (/VRAM|GPU memory|reserves/i.test(message)) return "no_fit";
  if (/Docker is missing|daemon/i.test(message)) return "no_docker";
  if (/nvidia-container-toolkit|nvidia runtime/i.test(message)) return "no_toolkit";
  if (/already serving|is stopped/i.test(message)) return "already_running";
  return "other";
}

async function ask(options: FirstRunModelUpOptions, label: string, hint: string, yesByDefault: boolean): Promise<boolean> {
  const answer = (await options.prompter.text(options.ui.prompt(label, hint))).trim();
  return answer === "" ? yesByDefault : /^y(es)?$/i.test(answer);
}

async function osId(options: FirstRunModelUpOptions): Promise<string | undefined> {
  const release = await options.system.readFile("/etc/os-release").catch(() => undefined);
  return release?.match(/^ID=["']?([a-z0-9._-]+)/m)?.[1];
}

/** Docker and the toolkit, offering to install the toolkit. Undefined when ready. */
async function preflight(options: FirstRunModelUpOptions): Promise<ModelUpResult | undefined> {
  const { system, ui } = options;
  try {
    await checkGpuDocker(system);
    ui.line("done", "Docker", "Nvidia container toolkit ready");
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const type = modelUpErrorType(error);
    if (type === "no_docker") {
      ui.line("failed", "Docker", "not installed or not running");
      return { ok: false, errorType: "no_docker", message: `${message} See https://docs.docker.com/engine/install/ then run dl model up.` };
    }
    ui.line("failed", "Nvidia container toolkit", "missing");
    const id = await osId(options);
    if (id !== "ubuntu" && id !== "debian") {
      return { ok: false, errorType: "no_toolkit", message: `${message} Install guide: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html then run dl model up.` };
    }
    if (!(await ask(options, "Install the Nvidia container toolkit now?", options.root ? "Y/n" : "Y/n · uses sudo", true))) {
      return { ok: false, errorType: "no_toolkit", message: "The Nvidia container toolkit is needed to run models. Run dl model up when it's installed." };
    }
    try {
      // sudo asks for the password first, on the terminal, before the progress line takes it.
      if (!options.root) await system.run("sudo", ["-v"], { describe: "sudo -v", inherit: true });
    } catch (sudoError) {
      return { ok: false, errorType: "toolkit_install_failed", message: `sudo didn't work: ${sudoError instanceof Error ? sudoError.message : String(sudoError)}` };
    }
    ui.plan([{ id: "toolkit", label: "Install the Nvidia container toolkit" }]);
    ui.start("toolkit", "apt, then Docker restarts");
    try {
      if (options.root) await system.run("sh", ["-c", TOOLKIT_INSTALL_SCRIPT], { describe: "install nvidia-container-toolkit" });
      else await system.run("sudo", ["-n", "sh", "-c", TOOLKIT_INSTALL_SCRIPT], { describe: "sudo install nvidia-container-toolkit" });
      await checkGpuDocker(system);
      ui.done("toolkit");
      ui.finish();
      return undefined;
    } catch (installError) {
      const detail = installError instanceof Error ? installError.message : String(installError);
      ui.fail("toolkit", detail);
      ui.finish();
      return { ok: false, errorType: "toolkit_install_failed", message: `Couldn't install the Nvidia container toolkit: ${detail}` };
    }
  }
}

async function pickModel(options: FirstRunModelUpOptions, hardware: Hardware): Promise<ModelRecipe | ModelUpResult> {
  const largest = Math.max(...hardware.gpus.map((gpu) => gpu.totalMiB));
  const choices = modelChoices(hardware.gpus);
  const fitting = choices.filter((choice) => choice.fits);
  if (fitting.length === 0) {
    return { ok: false, errorType: "no_fit", message: `No model in dl's catalog fits ${gb(largest)} GB of GPU memory yet.` };
  }
  const again = options.model ? fitting.find((choice) => choice.recipe.id === options.model) : undefined;
  if (again) {
    options.ui.line("info", "Model", `${again.recipe.id}, trying again`);
    return again.recipe;
  }
  if (fitting.length === 1) {
    options.ui.line("info", "Model", `Only one model fits this GPU: ${fitting[0]!.recipe.id}`);
    return fitting[0]!.recipe;
  }
  // The default: the first tested model that fits and didn't just fail (the catalog lists qwen-new first).
  const preferred = [
    (choice: (typeof choices)[number]) => choice.fits && choice.tested && choice.recipe.id !== options.avoid,
    (choice: (typeof choices)[number]) => choice.fits && choice.recipe.id !== options.avoid,
    (choice: (typeof choices)[number]) => choice.fits,
  ];
  const initial = preferred.map((test) => choices.findIndex(test)).find((index) => index >= 0) ?? 0;
  for (;;) {
    const picked = await options.prompter.select(
      options.ui.prompt("Pick a model"),
      choices.map(({ recipe, fits, tested }) => ({
        value: recipe.id,
        label: `${recipe.id}  ${recipe.repo}`,
        detail: `${sizeText(recipe)} · ${fits ? "fits" : "doesn't fit"} · ${tested ? "tested" : "untested"}${recipe.id === options.avoid ? " · failed" : ""}`,
      })),
      initial,
    );
    const choice = choices.find((item) => item.recipe.id === picked.value);
    if (choice?.fits) {
      options.ui.answered("Model", `${choice.recipe.id} · ${choice.tested ? "tested" : "untested"}`);
      return choice.recipe;
    }
    options.ui.rejected(`${picked.value} needs ${choice ? gb(choice.recipe.minVramMiB) : "?"} GB; this GPU has ${gb(largest)} GB. Pick one that fits.`);
  }
}

/** The first run's model setup. Never throws: every outcome is a result. */
export async function firstRunModelUp(options: FirstRunModelUpOptions): Promise<ModelUpResult> {
  const { system, ui } = options;
  try {
    ui.title("Private model on this GPU");
    const hardware = await detectHardware(system);
    showHardware(ui, hardware);
    const statePath = options.statePath ?? modelStatePath();
    const state = await readModelState(system, statePath);
    if (state) {
      if (await containerRunning(system, state.active.container)) {
        // Already serving here (an earlier dl model up): point Autopilot at it.
        await configureProvider(options, state.active, options.configPath ?? autopilotConfigFile());
        ui.line("done", "Model serving", state.active.repo);
        ui.line("info", "API", modelApiBase(state.active));
        return { ok: true, model: state.active.repo };
      }
      return {
        ok: false,
        errorType: "already_running",
        message: `The model set up earlier (${state.active.container}) is stopped. Start it with docker start ${state.active.container}, or replace it with dl model update.`,
      };
    }
    const blocked = await preflight(options);
    if (blocked) return blocked;
    const picked = await pickModel(options, hardware);
    if (!("id" in picked)) return picked;
    try {
      const code = await (options.modelUp ?? modelCommand)("up", [picked.id], { ...options, statePath, interactive: false, hardwareShown: true });
      if (code === 130) return { ok: false, errorType: "cancelled", message: "Cancelled.", model: picked.id };
      if (code !== 0) return { ok: false, errorType: "other", message: `dl model up exited with ${code}.`, model: picked.id };
      return { ok: true, model: picked.repo };
    } catch (error) {
      return { ...failure(error), model: picked.id };
    }
  } catch (error) {
    return failure(error);
  }
}

/** A thrown error as a result: its first line (never server logs), and its run log. */
function failure(error: unknown): Extract<ModelUpResult, { ok: false }> {
  const errorType = modelUpErrorType(error);
  if (errorType === "cancelled") return { ok: false, errorType, message: "Cancelled." };
  const [first, ...rest] = (error instanceof Error ? error.message : String(error)).split("\n");
  const message = first!.trim();
  const log = logPathOf(error);
  // What to run next (the container kept for inspection, a curl that reproduces the failure);
  // only those lines, so nothing else a message carries can reach the screen.
  const details = rest.map((line) => line.trim()).filter((line) => /^(The vLLM container |Stop it with |Remove it with |Reproduce: curl )/.test(line));
  return { ok: false, errorType, message, ...(log ? { log } : {}), ...(details.length ? { details } : {}) };
}
