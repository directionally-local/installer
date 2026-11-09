import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, createService, errorCode } from "./harness.js";

const tools = [{ type: "function", function: { name: "read", parameters: { type: "object", properties: {} } } }];

describe("GPT-6 with function tools", () => {
  it("sends GPT-6 Luna tool calls with reasoning off", async () => {
    const service = await createService({ OPENAI_API_KEY: "sk-test" });
    const t = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const res = await service.request("POST", "/v1/chat/completions", { token: t, body: { model: "gpt-6-luna", reasoning_effort: "high", tools, messages: [{ role: "user", content: "hi" }] } });
    assert.equal(res.status, 200);
    assert.equal(service.calls.openai.at(-1)?.body.reasoning_effort, "none");
  });

  it("keeps the reasoning setting when there are no tools", async () => {
    const service = await createService({ OPENAI_API_KEY: "sk-test" });
    const t = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    await service.request("POST", "/v1/chat/completions", { token: t, body: { model: "gpt-6-luna", reasoning_effort: "high", messages: [{ role: "user", content: "hi" }] } });
    assert.equal(service.calls.openai.at(-1)?.body.reasoning_effort, "high");
  });

  it("answers Sol and Astra tool requests with a clear message, without calling OpenAI", async () => {
    const service = await createService({ OPENAI_API_KEY: "sk-test" });
    const t = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    for (const model of ["gpt-6.1-sol", "gpt-6-astra"]) {
      const res = await service.request("POST", "/v1/chat/completions", { token: t, body: { model, tools, messages: [{ role: "user", content: "hi" }] } });
      assert.equal(res.status, 400);
      assert.equal(await errorCode(res), "tools_unsupported");
    }
    assert.equal(service.calls.openai.length, 0);
  });
});
