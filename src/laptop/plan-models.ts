import { DL_DEFAULT_MODEL } from "./dl-key.js";

/**
 * The models on the person's dl plan, as each agent dl sets up shows them. Every plan has
 * DeepSeek V4.1 Flash; Plus and Max add Kimi K3.1 (services/free/src/plans.ts). What a key may
 * use is what the service's GET /v1/models lists for it (opencode.ts freeTierModels reads it):
 * Kimi is offered in an agent only when it's listed there.
 */

/** Kimi K3.1 Pro's id on the service (Plus and Max). */
export const KIMI_MODEL = "moonshotai/kimi-k3.1-pro";
export const DEEPSEEK_MODEL = DL_DEFAULT_MODEL;

/** The names users see, as on dl.new: "DeepSeek V4.1 Flash", "Kimi K3.1"; else the service's name. */
export function planModelName(model: { id: string; name?: string }): string {
  if (model.id === DEEPSEEK_MODEL) return "DeepSeek V4.1 Flash";
  if (model.id === KIMI_MODEL) return "Kimi K3.1";
  return model.name || model.id;
}

/** Whether the key's models include Kimi K3.1 (Plus and Max). */
export function hasKimi(models: readonly { id: string }[]): boolean {
  return models.some((model) => model.id === KIMI_MODEL);
}

/**
 * The one line after an agent is set up: "Models on your plan: DeepSeek V4.1 Flash, Kimi K3.1 —
 * switch with /model". `switchHow` is the agent's own way ("switch with /models"); left out with
 * one model, as there's nothing to switch to.
 */
export function planModelsLine(names: readonly string[], switchHow?: string): string {
  if (names.length <= 1) return `Model on your plan: ${names[0] ?? planModelName({ id: DEEPSEEK_MODEL })}`;
  return `Models on your plan: ${names.join(", ")}${switchHow ? ` — ${switchHow}` : ""}`;
}

/** The plan's models in the order users know them: DeepSeek first, Kimi next, then the rest. */
export function planOrder<T extends { id: string }>(models: readonly T[]): T[] {
  const rank = (id: string) => (id === DEEPSEEK_MODEL ? 0 : id === KIMI_MODEL ? 1 : 2);
  return [...models].sort((a, b) => rank(a.id) - rank(b.id));
}
