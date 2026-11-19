import type { ModelRecipe } from "./model-catalog.js";
import { engine } from "./model-engines.js";
import { shortGpuName, type Gpu } from "./model-runtime.js";
import { PromptCancelled, type Prompter, type SelectOption } from "./prompt.js";
import type { Ui } from "./ui.js";

/**
 * The engine choice in `dl model up`, after the model is picked and before anything downloads
 * or starts. For a model the optimized engine serves (`optimizedEngine` in the catalog), it asks
 * how this GPU should serve it:
 *
 * - The optimized engine (the default): three questions (work email, company, GPUs), sent to
 *   the same pilot inbox as the website's form, then "Continue with vLLM for now?". Esc on any
 *   question goes back to the choice with the open-source engine highlighted.
 * - The open-source engine (the catalog entry's: vLLM, or SGLang): today's setup, unchanged.
 *
 * Both `dl model up` (model-command.ts) and the GPU first run Autopilot hands to dl
 * (model-first-run.ts) call it once, right after their model picker. Runs that can't ask
 * (no terminal, CI, --dry-run) never get here: they use the open-source engine.
 */

export const PILOT_URL = "https://directionallylocal.com/api/pilot";
export const PILOT_SOURCE = "dl model up";
export const CONTACT_EMAIL = "contact@directionallylocal.com";
const PILOT_TIMEOUT_MS = 10_000;

/** The words, in one place. */
export const ENGINE_COPY = {
  question: (model: string) => `How should this GPU serve ${model}?`,
  optimized: { label: "Optimized engine", accent: "(55% cheaper per token)", detail: "same speed as the model's official API · set up by our team · recommended" },
  openSource: (label: string) => ({ label: `Open-source engine (${label})`, detail: "free · starts now · what most providers run" }),
  intro: "Our team sets it up on your GPUs. Three quick questions · Esc goes back",
  fields: {
    email: { label: "Work email", hint: (prefilled: boolean) => (prefilled ? "from your GitHub sign-in, Enter to keep" : "") },
    company: { label: "Company", hint: () => "" },
    gpus: { label: "GPUs you'd run it on", hint: (prefilled: boolean, detected?: string) => (prefilled && detected ? `this box: ${detected}, add any others` : "") },
  },
  empty: "Please answer this one, or press Esc to go back and pick the open-source engine.",
  badEmail: "That doesn't look like an email. Enter one like you@company.com.",
  sendFailed: `Couldn't send. Email ${CONTACT_EMAIL}`,
  thanks: (email: string) => `Thanks. We'll email ${email} within one working day`,
  thanksDetail: (gpus: string) => `with a quote and a pilot plan for ${gpus}.`,
  continueQuestion: (label: string) => `Continue with ${label} for now, to try the rest of dl?`,
  later: "You can switch to the optimized engine later; nothing to reinstall.",
  yes: (label: string) => ({ label: `Yes, continue with ${label}`, detail: "download the model and start serving it now" }),
  no: { label: "No, stop here", detail: "we'll reach out; run dl model up again any time" },
  stopped: (label: string) => `Run dl model up any time to continue with ${label}.`,
  inTouch: (email: string) => `Got it. We'll be in touch at ${email}.`,
} as const;

/** What the pilot inbox gets: the same fields as the website's form, plus where it came from. */
export interface PilotRequest {
  company: string;
  email: string;
  gpus: string;
  models: string;
  tokens: string;
  source: string;
}

export type PilotFetch = (url: string, init: RequestInit) => Promise<Pick<Response, "ok" | "status">>;

export interface EngineChoiceOptions {
  ui: Ui;
  prompter: Prompter;
  model: ModelRecipe;
  /** The machine's GPUs, for the GPUs question's prefill ("8× B300"). */
  gpus: readonly Pick<Gpu, "name">[];
  /** The email from the dl/free-tier GitHub sign-in, when dl has one. Never throws. */
  signInEmail?: () => Promise<string | undefined>;
  /** --engine optimized: straight to the questions. */
  start?: "choice" | "questions";
  /** For tests; production uses fetch. */
  fetch?: PilotFetch;
}

/** "continue": set up the open-source engine as before; "stop": nothing more (the person said no). */
export type EngineChoiceOutcome = "continue" | "stop";

/** Whether `dl model up` asks the engine question for this model. */
export function offersOptimizedEngine(model: Pick<ModelRecipe, "optimizedEngine">): boolean {
  return model.optimizedEngine === true;
}

/** "8× B300", "4× H100, 2× L40S": the GPUs by short name, for the GPUs question's prefill. */
export function gpuSummaryText(gpus: readonly Pick<Gpu, "name">[]): string {
  const counts = new Map<string, number>();
  for (const gpu of gpus) {
    // "NVIDIA B300 SXM6 AC" → "B300", "NVIDIA H100 80GB HBM3" → "H100": the form factor and memory words go.
    const words = shortGpuName(gpu.name).replace(/^NVIDIA\s+/i, "").split(" ");
    const cut = words.findIndex((word, index) => index > 0 && /^(SXM\d*|PCIe|NVL\d*|HBM\w*|\d+GB|AC|MIG.*)$/i.test(word));
    const name = (cut > 0 ? words.slice(0, cut) : words).join(" ");
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => `${count}× ${name}`).join(", ");
}

/** Light check: one @, a dot in the domain, no spaces, at most 254 characters. The inbox checks again. */
export function looksLikeEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** The engine choice's two options: the optimized engine first (the default). */
export function engineOptions(model: Pick<ModelRecipe, "engine">): SelectOption[] {
  const open = ENGINE_COPY.openSource(engine(model.engine).label);
  return [
    { value: "optimized", label: ENGINE_COPY.optimized.label, accent: ENGINE_COPY.optimized.accent, detail: ENGINE_COPY.optimized.detail, detailBelow: true },
    { value: "open-source", label: open.label, detail: open.detail, detailBelow: true },
  ];
}

/** POST the request to the pilot inbox. True when it was taken; never throws, never waits more than ~10 s. */
export async function sendPilotRequest(request: PilotRequest, call: PilotFetch = (url, init) => fetch(url, init)): Promise<boolean> {
  try {
    const response = await call(PILOT_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(PILOT_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

type Field = keyof typeof ENGINE_COPY.fields;

/**
 * Ask one question until it has an answer: null when Esc goes back. Without an editing prompt
 * (an older Prompter), text() is asked and an empty answer keeps the prefill.
 */
async function askField(options: EngineChoiceOptions, field: Field, initial: string, detected?: string): Promise<string | null> {
  const { ui, prompter } = options;
  const copy = ENGINE_COPY.fields[field];
  for (;;) {
    const question = ui.prompt(copy.label, copy.hint(initial !== "", detected) || undefined);
    const raw = prompter.edit ? await prompter.edit(question, initial) : ((await prompter.text(question)).trim() || initial);
    if (raw === null) return null;
    const answer = raw.trim();
    if (!answer) { ui.rejected(ENGINE_COPY.empty); initial = ""; continue; }
    if (field === "email" && !looksLikeEmail(answer)) { ui.rejected(ENGINE_COPY.badEmail); initial = answer; continue; }
    ui.answered(copy.label, answer);
    return answer;
  }
}

/**
 * The engine step. Call it only for a model that offersOptimizedEngine and when questions can be
 * asked. Esc at the engine choice itself (or Ctrl-C anywhere) cancels, like every dl picker.
 */
export async function chooseEngine(options: EngineChoiceOptions): Promise<EngineChoiceOutcome> {
  const { ui, prompter, model } = options;
  const openLabel = engine(model.engine).label;
  const detected = gpuSummaryText(options.gpus);
  let email: string | undefined;
  let initial = 0;
  let skipChoice = options.start === "questions";
  let introduced = false;
  for (;;) {
    if (!skipChoice) {
      const picked = await prompter.select(ui.prompt(ENGINE_COPY.question(model.id)), engineOptions(model), initial);
      if (picked.value !== "optimized") {
        ui.answered("Engine", openLabel);
        return "continue";
      }
      ui.answered("Engine", "optimized engine");
    }
    skipChoice = false;
    // The intro once: after an Esc and a second pick it's still on screen.
    if (!introduced) ui.questions(ENGINE_COPY.intro);
    introduced = true;
    email ??= (await options.signInEmail?.().catch(() => undefined)) ?? "";
    const answers: Record<Field, string> = { email, company: "", gpus: detected };
    let back = false;
    for (const field of ["email", "company", "gpus"] as const) {
      const answer = await askField(options, field, answers[field], detected);
      if (answer === null) { back = true; break; }
      answers[field] = answer;
    }
    if (back) {
      // Back to the choice, the open-source engine highlighted: no details needed for it.
      initial = 1;
      continue;
    }
    const sent = await sendPilotRequest({ company: answers.company, email: answers.email, gpus: answers.gpus, models: model.id, tokens: "", source: PILOT_SOURCE }, options.fetch);
    if (sent) {
      ui.line("done", ENGINE_COPY.thanks(answers.email));
      ui.line("info", ENGINE_COPY.thanksDetail(answers.gpus));
    } else ui.line("failed", ENGINE_COPY.sendFailed);
    ui.line("info", ENGINE_COPY.later);
    const yes = ENGINE_COPY.yes(openLabel);
    let next;
    try {
      next = await prompter.select(ui.prompt(ENGINE_COPY.continueQuestion(openLabel)), [
        { value: "yes", label: yes.label, detail: yes.detail },
        { value: "no", label: ENGINE_COPY.no.label, detail: ENGINE_COPY.no.detail },
      ], 0);
    } catch (error) {
      // Esc here is a no: the request is in, nothing starts.
      if (!(error instanceof PromptCancelled)) throw error;
      next = { value: "no" };
    }
    if (next.value === "yes") {
      ui.answered("Engine", `${openLabel} for now`);
      return "continue";
    }
    if (sent) ui.line("done", ENGINE_COPY.inTouch(answers.email));
    ui.line("info", ENGINE_COPY.stopped(openLabel));
    return "stop";
  }
}
