import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chooseUpstream } from "../src/upstream-choice.js";

describe("which upstream serves", () => {
  it("never OpenRouter without an OpenRouter key, whatever the setting", () => {
    assert.equal(chooseUpstream("openrouter", { luminalApiKey: "lum", openRouterApiKey: undefined }), "luminal");
    assert.equal(chooseUpstream("luminal", { luminalApiKey: "lum", openRouterApiKey: undefined }), "luminal");
    assert.equal(chooseUpstream("openrouter", { luminalApiKey: undefined, openRouterApiKey: undefined }), undefined);
    assert.equal(chooseUpstream("luminal", { luminalApiKey: undefined, openRouterApiKey: undefined }), undefined);
  });
  it("with both keys, the setting decides; with only OpenRouter's, OpenRouter", () => {
    assert.equal(chooseUpstream("luminal", { luminalApiKey: "lum", openRouterApiKey: "or" }), "luminal");
    assert.equal(chooseUpstream("openrouter", { luminalApiKey: "lum", openRouterApiKey: "or" }), "openrouter");
    assert.equal(chooseUpstream("luminal", { luminalApiKey: undefined, openRouterApiKey: "or" }), "openrouter");
  });
});
