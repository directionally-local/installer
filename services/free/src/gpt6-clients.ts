/**
 * Which coding agents GPT-6 (OpenAI's models) is served to: `gpt6Clients` (GPT6_CLIENTS).
 *
 * "autopilot" (the default): GPT-6 only inside Autopilot, our own app (a sign-in token or a server
 * key; `dl_only` already keeps those to dl). Every other agent dl starts gets a harness key
 * (`dl claude`, `dl opencode`, `dl pi`, `dl t3`, and `dl proxy` for desktop apps), and a GPT-6
 * request with one is refused like any provider limit, 402 `provider_limit`, reason
 * "autopilot_only", `alternative` the DeepSeek model, so the agent switches to DeepSeek. Such keys
 * aren't offered GPT-6 either: /v1/models and the unknown-model refusal leave it out.
 *
 * "all": every agent gets every model it could before (Claude Code through dl is DeepSeek only
 * either way). Admins are never held to it, so GPT-6 can still be tested in other agents.
 */

import type { Gpt6Clients } from "./config.js";
import { DEEPSEEK_MODEL, type FreeModel } from "./models.js";

export const AUTOPILOT_ONLY_REASON = "autopilot_only";
/**
 * The refusal's wording: a plain statement of where the model is served, no push to switch agents.
 * The restriction comes from the model provider's approval, not from a preference for Autopilot.
 */
export function autopilotOnlyMessage(modelName = "GPT-6.1 Sol"): string {
  return `${modelName} is available in Autopilot for now; other agents use DeepSeek V4.1 Flash.`;
}
export const AUTOPILOT_ONLY_MESSAGE = autopilotOnlyMessage();

/** The agents a model can be used in, as /v1/providers lists them. */
export type ModelClient = "autopilot" | "claude-code" | "opencode" | "pi";

/** Whether GPT-6 is served to a caller: `harness` is the harness key's agent, undefined for Autopilot. */
export function gpt6ServedTo(setting: Gpt6Clients, harness: string | undefined, isAdmin: boolean): boolean {
  return isAdmin || harness === undefined || setting === "all";
}

/** Whether `model` is GPT-6 held back from this caller. */
export function heldFromClient(model: Pick<FreeModel, "family">, setting: Gpt6Clients, harness: string | undefined, isAdmin: boolean): boolean {
  return model.family === "gpt6" && !gpt6ServedTo(setting, harness, isAdmin);
}

/**
 * The agents `model` can be used in: GPT-6 in Autopilot only while `gpt6Clients` is "autopilot";
 * Claude Code through dl is always served by DeepSeek, so only DeepSeek lists it.
 */
export function modelClients(model: Pick<FreeModel, "id" | "family">, setting: Gpt6Clients): ModelClient[] {
  if (model.family === "gpt6" && setting === "autopilot") return ["autopilot"];
  return model.id === DEEPSEEK_MODEL ? ["autopilot", "claude-code", "opencode", "pi"] : ["autopilot", "opencode", "pi"];
}
