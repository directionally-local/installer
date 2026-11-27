import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEEPSEEK_MODEL, hasKimi, KIMI_MODEL, planModelLabel, planModelName, planModelsLine, planOrder, planProviderName } from "./plan-models.js";
import { FREE_TIER_MODELS, opencodeConfig, opencodeModelsLine } from "./opencode.js";
import { piModelsLine, piProvider } from "./pi.js";
import { t3ModelsLine } from "./t3.js";

const KIMI = { id: KIMI_MODEL, name: "Kimi K3.1 Pro", contextWindow: 1_048_576, maxOutputTokens: 131_072, vision: true };
const PLUS = [KIMI, ...FREE_TIER_MODELS];

describe("the plan's models in each agent", () => {
  it("names them as dl.new does, DeepSeek first", () => {
    assert.deepEqual(planOrder(PLUS).map(planModelName), ["DeepSeek V4.1 Flash", "Kimi K3.1"]);
    assert.equal(planModelName({ id: "x/other", name: "Other" }), "Other");
    assert.equal(planModelLabel({ id: DEEPSEEK_MODEL }, null), "dl / DeepSeek V4.1 Flash (Free)");
    assert.equal(planModelLabel({ id: KIMI_MODEL }, "plus"), "dl / Kimi K3.1 (Plus)");
    assert.equal(planModelLabel({ id: "x/other", name: "Other" }, "max"), "dl / Other (Max)");
    assert.equal(planProviderName(null), "dl");
    assert.equal(planProviderName(undefined), "dl");
    // GET /v1/me names the Free plan "free" (a string), not null.
    assert.equal(planProviderName("free"), "dl");
    assert.equal(planProviderName("Free"), "dl");
    assert.equal(planProviderName("FREE"), "dl");
    assert.equal(planProviderName(""), "dl");
    assert.equal(planProviderName("  "), "dl");
    assert.equal(planProviderName("plus"), "dl (Plus)");
    assert.equal(planProviderName("max"), "dl (Max)");
    assert.ok(hasKimi(PLUS));
    assert.ok(!hasKimi(FREE_TIER_MODELS));
    assert.equal(planModelsLine(["DeepSeek V4.1 Flash"], "switch with /model"), "Model on your plan: DeepSeek V4.1 Flash", "nothing to switch to");
    assert.equal(planModelsLine([]), "Model on your plan: DeepSeek V4.1 Flash");
  });

  it("OpenCode and Pi list both under the dl provider on Plus and Max, with each agent's own switch", () => {
    assert.equal(opencodeModelsLine(PLUS, "plus"), "Models on your plan: dl / DeepSeek V4.1 Flash (Plus), dl / Kimi K3.1 (Plus) — switch with /models (under dl)");
    assert.equal(opencodeModelsLine(FREE_TIER_MODELS), "Model on your plan: dl / DeepSeek V4.1 Flash (Free)");
    assert.deepEqual(Object.keys((opencodeConfig({ origin: "https://x", models: PLUS, plan: "plus" }).provider as any).dl.models), [KIMI_MODEL, DEEPSEEK_MODEL]);
    assert.equal((opencodeConfig({ origin: "https://x", models: PLUS, plan: "plus" }) as any).model, `dl/${DEEPSEEK_MODEL}`, "DeepSeek stays the default");
    assert.equal(piModelsLine(PLUS, "plus"), "Models on your plan: dl / DeepSeek V4.1 Flash (Plus), dl / Kimi K3.1 (Plus) — switch with /model");
    assert.deepEqual((piProvider({ origin: "https://x", models: PLUS, plan: "plus" }).models as Array<{ id: string }>).map((model) => model.id), [KIMI_MODEL, DEEPSEEK_MODEL]);
  });

  it("T3 Code says which Claude Code row is which, and that its picker switches", () => {
    assert.equal(t3ModelsLine(PLUS, "plus"), "Models on your plan: dl / DeepSeek V4.1 Flash (Plus) as Sonnet, dl / Kimi K3.1 (Plus) as Opus — switch in T3 Code's model picker");
    assert.equal(t3ModelsLine(FREE_TIER_MODELS), "Model on your plan: dl / DeepSeek V4.1 Flash (Free)");
  });
});
