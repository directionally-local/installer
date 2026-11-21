import assert from "node:assert/strict";
import { test } from "node:test";
import { agentsEnv, parseHandoff, resultEnv } from "./gpu-handoff.js";
import type { LocalModel } from "./local-agents.js";

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
  assert.deepEqual(resultEnv({ ok: true, model: "Qwen/Qwen3-4B" }, undefined), { DL_GPU_RESULT: "ok", DL_CHAT_SETUP: "1", DL_API_SETUP: "1" }, "and dl can set up the team chat or the API endpoint next");
});

test("the answer to \"How will your team use it?\": API endpoint, with nothing else carried", () => {
  assert.deepEqual(parseHandoff('{"version":1,"action":"api-up"}'), { version: 1, action: "api-up" });
  assert.deepEqual(parseHandoff('{"version":1,"action":"api-up","use":"public","port":80}'), { version: 1, action: "api-up" }, "nothing from the request widens access");
  assert.equal(parseHandoff('{"version":2,"action":"api-up"}'), undefined);
});

test("the answer to \"Which coding agent?\": another agent, alone or with Both; Autopilot never comes to dl", () => {
  assert.deepEqual(parseHandoff('{"version":1,"action":"agent","agent":"claude-code"}'), { version: 1, action: "agent", agent: "claude-code" });
  assert.deepEqual(parseHandoff('{"version":1,"action":"agent","agent":"pi"}'), { version: 1, action: "agent", agent: "pi" });
  assert.equal(parseHandoff('{"version":1,"action":"agent","agent":"autopilot"}'), undefined);
  assert.equal(parseHandoff('{"version":1,"action":"agent","agent":"codex"}'), undefined);
  assert.equal(parseHandoff('{"version":1,"action":"agent"}'), undefined);
  assert.deepEqual(parseHandoff('{"version":1,"action":"chat-up","use":"both","agent":"opencode"}'), { version: 1, action: "chat-up", use: "both", agent: "opencode" });
  assert.deepEqual(parseHandoff('{"version":1,"action":"chat-up","use":"both","agent":"rm -rf"}'), { version: 1, action: "chat-up", use: "both" });
  assert.deepEqual(parseHandoff('{"version":1,"action":"chat-up","use":"browser","agent":"pi"}'), { version: 1, action: "chat-up", use: "browser" }, "no agent with the browser alone");
});

test("DL_AGENTS: the agents besides Autopilot that can work on the model, and whether each is installed", () => {
  const model: LocalModel = { name: "default", model: "Qwen/Qwen3-4B", baseUrl: "http://127.0.0.1:8000/v1", context: 32768, output: 8192, engine: "vllm", image: "vllm/vllm-openai:v0.20.0" };
  const installed = { autopilot: true, "claude-code": true, opencode: false, pi: true };
  assert.deepEqual(JSON.parse(agentsEnv(model, installed).DL_AGENTS!), [{ id: "claude-code", installed: true }, { id: "opencode", installed: false }, { id: "pi", installed: true }]);
  assert.deepEqual(JSON.parse(agentsEnv({ ...model, context: 8192 }, installed).DL_AGENTS!).map((a: { id: string }) => a.id), ["opencode", "pi"], "Claude Code left out on an 8k context");
  assert.deepEqual(agentsEnv(undefined, installed), {}, "no model: no question");
});
