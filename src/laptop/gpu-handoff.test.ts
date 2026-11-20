import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHandoff, resultEnv } from "./gpu-handoff.js";

test("a request may name a model to retry or ask for the picker; anything odd in them is dropped", () => {
  assert.deepEqual(parseHandoff('{"version":1,"action":"model-up","model":"qwen-old"}'), { version: 1, action: "model-up", model: "qwen-old" });
  assert.deepEqual(parseHandoff('{"version":1,"action":"model-up","pick":true}'), { version: 1, action: "model-up", pick: true });
  assert.deepEqual(parseHandoff('{"version":1,"action":"model-up","model":"../../etc; rm -rf","pick":"yes"}'), { version: 1, action: "model-up" });
  assert.equal(parseHandoff('{"version":2,"action":"model-up","model":"qwen-old"}'), undefined);
});

test("the answer to \"How will your team use it?\": browser or both; anything else is ignored", () => {
  assert.deepEqual(parseHandoff('{"version":1,"action":"chat-up","use":"browser"}'), { version: 1, action: "chat-up", use: "browser" });
  assert.deepEqual(parseHandoff('{"version":1,"action":"chat-up","use":"both","extra":1}'), { version: 1, action: "chat-up", use: "both" });
  assert.equal(parseHandoff('{"version":1,"action":"chat-up","use":"terminal"}'), undefined, "terminal never comes to dl");
  assert.equal(parseHandoff('{"version":1,"action":"chat-up"}'), undefined);
});

test("the relaunch after a failure carries the model, one line of reason and the log; after success, none of them", () => {
  assert.deepEqual(resultEnv({ ok: false, errorType: "launch_failed", message: "Startup: vLLM\u001b[31m stopped\nwhile loading", log: "/l.log", model: "glm-flash" }, undefined), {
    DL_GPU_RESULT: "failed", DL_GPU_ERROR: "launch_failed", DL_GPU_MODEL: "glm-flash", DL_GPU_REASON: "Startup: vLLM [31m stopped while loading", DL_GPU_LOG: "/l.log",
  });
  assert.deepEqual(resultEnv({ ok: true, model: "Qwen/Qwen3-4B" }, undefined), { DL_GPU_RESULT: "ok", DL_CHAT_SETUP: "1" }, "and dl can set up the team chat next");
});
