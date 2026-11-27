import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEEPSEEK_MODEL, hasKimi, KIMI_MODEL, planModelName, planModelsLine, planOrder } from "./plan-models.js";
import { FREE_TIER_MODELS, opencodeConfig, opencodeModelsLine } from "./opencode.js";
import { piModelsLine, piProvider } from "./pi.js";
import { t3ModelsLine } from "./t3.js";

const KIMI = { id: KIMI_MODEL, name: "Kimi K3.1 Pro", contextWindow: 1_048_576, maxOutputTokens: 131_072, vision: true };
const PLUS = [KIMI, ...FREE_TIER_MODELS];

describe("the plan's models in each agent", () => {
  it("names them as dl.new does, DeepSeek first", () => {
    assert.deepEqual(planOrder(PLUS).map(planModelName), ["DeepSeek V4.1 Flash", "Kimi K3.1"]);
    assert.equal(planModelName({ id: "x/other", name: "Other" }), "Other");
    assert.ok(hasKimi(PLUS));
    assert.ok(!hasKimi(FREE_TIER_MODELS));
    assert.equal(planModelsLine(["DeepSeek V4.1 Flash"], "switch with /model"), "Model on your plan: DeepSeek V4.1 Flash", "nothing to switch to");
    assert.equal(planModelsLine([]), "Model on your plan: DeepSeek V4.1 Flash");
  });

  it("OpenCode and Pi list both under the dl provider on Plus and Max, with each agent's own switch", () => {
    assert.equal(opencodeModelsLine(PLUS), "Models on your plan: DeepSeek V4.1 Flash, Kimi K3.1 — switch with /models (under dl)");
    assert.equal(opencodeModelsLine(FREE_TIER_MODELS), "Model on your plan: DeepSeek V4.1 Flash");
    assert.deepEqual(Object.keys((opencodeConfig({ origin: "https://x", models: PLUS }).provider as any).dl.models), [KIMI_MODEL, DEEPSEEK_MODEL]);
    assert.equal((opencodeConfig({ origin: "https://x", models: PLUS }) as any).model, `dl/${DEEPSEEK_MODEL}`, "DeepSeek stays the default");
    assert.equal(piModelsLine(PLUS), "Models on your plan: DeepSeek V4.1 Flash, Kimi K3.1 — switch with /model");
    assert.deepEqual((piProvider({ origin: "https://x", models: PLUS }).models as Array<{ id: string }>).map((model) => model.id), [KIMI_MODEL, DEEPSEEK_MODEL]);
  });

  it("T3 Code says which Claude Code row is which, and that its picker switches", () => {
    assert.equal(t3ModelsLine(PLUS), "Models on your plan: DeepSeek V4.1 Flash (Sonnet), Kimi K3.1 (Opus) — switch in T3 Code's model picker");
    assert.equal(t3ModelsLine(FREE_TIER_MODELS), "Model on your plan: DeepSeek V4.1 Flash");
  });
});
