import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, createService, MODEL, NOW, type Service } from "./harness.js";
import { readFreeConfig, ConfigError } from "../src/config.js";
import { parseSettingsUpdate } from "../src/runtime-config.js";
import { requestRefusalReason } from "../src/refusals.js";
import { autopilotOnlyMessage, gpt6ServedTo, modelClients } from "../src/gpt6-clients.js";
import { FREE_MODELS } from "../src/models.js";

/**
 * GPT-6 in Autopilot only (`gpt6Clients`, gpt6-clients.ts): another coding agent dl launches with
 * a harness key (dl opencode, dl pi, dl claude, dl t3, dl proxy) gets DeepSeek; GPT-6 requests from
 * it are refused like a provider limit, pointing at DeepSeek, and aren't offered to it.
 */

const GPT6 = ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"];
const BOTH = { OPENAI_API_KEY: "sk-openai-test", LUMINAL_API_KEY: "lum-test" };
const TODAY = new Date(NOW).toISOString().slice(0, 10);

async function world(vars: Record<string, string> = {}) {
  const service = await createService({ OPEN_ADMISSION: "true", ...BOTH, ...vars });
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const token = (await service.signIn({ id: 100, login: "alice" })).access_token;
  return { service, admin, token };
}

async function mint(service: Service, token: string, harness: string): Promise<string> {
  const response = await service.request("POST", "/v1/harness-keys", { token, body: { harness } });
  assert.equal(response.status, 201, await response.clone().text());
  return ((await response.json()) as { key: string }).key;
}

const chat = (service: Service, key: string, model: string) =>
  service.request("POST", "/v1/chat/completions", { token: key, body: { model, messages: [{ role: "user", content: "hello" }] } });

async function errorOf(response: Response): Promise<Record<string, unknown>> {
  return ((await response.json()) as { error: Record<string, unknown> }).error;
}

async function listed(service: Service, key: string): Promise<string[]> {
  const response = await service.request("GET", "/v1/models", { token: key });
  assert.equal(response.status, 200, await response.clone().text());
  return ((await response.json()) as { data: Array<{ id: string }> }).data.map((model) => model.id);
}

async function refusals(service: Service, admin: string): Promise<Record<string, number>> {
  const response = await service.request("GET", "/admin/metrics", { token: admin });
  const body = (await response.json()) as { refusals: Array<{ day: string; reason: string; client: string; count: number }> };
  return Object.fromEntries(body.refusals.filter((row) => row.day === TODAY).map((row) => [`${row.reason}|${row.client}`, row.count]));
}

describe("GPT-6 in Autopilot only (gpt6Clients)", () => {
  for (const harness of ["opencode", "pi"]) {
    it(`refuses GPT-6 from ${harness}'s harness key with provider_limit autopilot_only, pointing at DeepSeek, and serves DeepSeek`, async () => {
      const { service, admin, token } = await world();
      const key = await mint(service, token, harness);
      for (const model of GPT6) {
        const refused = await chat(service, key, model);
        assert.equal(refused.status, 402, model);
        const error = await errorOf(refused);
        assert.deepEqual(
          { code: error.code, reason: error.reason, family: error.family, provider: error.provider, alternative: error.alternative, resetsAt: error.resetsAt, clients: error.clients, message: error.message },
          { code: "provider_limit", reason: "autopilot_only", family: "gpt6", provider: "openai", alternative: MODEL, resetsAt: null, clients: ["autopilot"], message: autopilotOnlyMessage(FREE_MODELS.find((m) => m.id === model)!.name) },
        );
      }
      assert.equal(service.calls.openai.length, 0, "nothing reached OpenAI");
      assert.equal((await chat(service, key, MODEL)).status, 200, "DeepSeek still works");
      const counts = await refusals(service, admin);
      assert.equal(counts[`provider_limit:autopilot_only|${harness}`], 3, "counted under the agent");
    });
  }

  it("leaves GPT-6 out of a harness key's /v1/models and its unknown-model refusal", async () => {
    const { service, token } = await world();
    const key = await mint(service, token, "opencode");
    assert.deepEqual(await listed(service, key), [MODEL]);
    const unknown = await chat(service, key, "gpt-5");
    assert.equal(unknown.status, 400);
    const error = await errorOf(unknown);
    assert.equal(error.code, "model_not_allowed");
    assert.deepEqual(error.allowed, [MODEL]);
  });

  it("keeps serving and listing GPT-6 to Autopilot (a sign-in token)", async () => {
    const { service, token } = await world();
    assert.deepEqual(await listed(service, token), [...GPT6, MODEL]);
    const luna = await chat(service, token, "gpt-6-luna");
    assert.equal(luna.status, 200, await luna.clone().text());
    assert.equal(service.calls.openai.length, 1);
    const me = (await (await service.request("GET", "/v1/me", { token })).json()) as { models: string[] };
    assert.deepEqual(me.models, [...GPT6, MODEL], "/v1/me answers Autopilot and dl only (harness keys can't read it)");
  });

  it("lets admins use GPT-6 from another agent, for testing", async () => {
    const { service, admin } = await world();
    const key = await mint(service, admin, "opencode");
    assert.deepEqual(await listed(service, key), [...GPT6, MODEL]);
    assert.equal((await chat(service, key, "gpt-6-luna")).status, 200);
  });

  it("leaves Claude Code through dl as it was: DeepSeek, whatever model it names", async () => {
    const { service, token } = await world();
    const key = await mint(service, token, "claude-code");
    const response = await service.request("POST", "/anthropic/v1/messages", {
      token: key,
      headers: { "anthropic-version": "2023-06-01" },
      body: { model: "claude-opus-4", max_tokens: 50, messages: [{ role: "user", content: "hello" }] },
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(service.calls.openai.length, 0);
  });

  it('opens GPT-6 to every agent with gpt6Clients "all", from env or the admin runtime setting', async () => {
    const fromEnv = await world({ GPT6_CLIENTS: "all" });
    const envKey = await mint(fromEnv.service, fromEnv.token, "opencode");
    assert.equal((await chat(fromEnv.service, envKey, "gpt-6-luna")).status, 200);
    assert.deepEqual(await listed(fromEnv.service, envKey), [...GPT6, MODEL]);

    const { service, admin, token } = await world();
    const key = await mint(service, token, "pi");
    assert.equal((await chat(service, key, "gpt-6-luna")).status, 402);
    const set = await service.request("POST", "/admin/config", { token: admin, body: { gpt6Clients: "all" } });
    assert.equal(set.status, 200, await set.clone().text());
    assert.equal((await chat(service, key, "gpt-6-luna")).status, 200);
    const providers = (await (await service.request("GET", "/v1/providers")).json()) as { providers: Array<{ models: Array<{ id: string; clients: string[] }> }> };
    const luna = providers.providers.flatMap((provider) => provider.models).find((model) => model.id === "gpt-6-luna");
    assert.deepEqual(luna?.clients, ["autopilot", "opencode", "pi"]);
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { gpt6Clients: "everyone" } })).status, 400);
  });

  it("parses the setting and counts the refusal by its reason", () => {
    const base = { GITHUB_CLIENT_ID: "x", GITHUB_CLIENT_SECRET: "x", TOKEN_SIGNING_KEY: "k".repeat(32), OPENROUTER_API_KEY: "x" };
    assert.equal(readFreeConfig(base).gpt6Clients, "autopilot");
    assert.equal(readFreeConfig({ ...base, GPT6_CLIENTS: "ALL" }).gpt6Clients, "all");
    assert.throws(() => readFreeConfig({ ...base, GPT6_CLIENTS: "opencode" }), ConfigError);
    assert.deepEqual(parseSettingsUpdate({ gpt6Clients: "autopilot" }), { changes: [{ key: "gpt6Clients", value: "autopilot" }] });
    assert.ok("error" in parseSettingsUpdate({ gpt6Clients: true }));
    assert.equal(requestRefusalReason(402, { code: "provider_limit", reason: "autopilot_only" }), "provider_limit:autopilot_only");
    assert.equal(gpt6ServedTo("autopilot", undefined, false), true);
    assert.equal(gpt6ServedTo("autopilot", "opencode", false), false);
    assert.equal(gpt6ServedTo("autopilot", "opencode", true), true);
    assert.equal(gpt6ServedTo("all", "pi", false), true);
    for (const model of FREE_MODELS.filter((one) => one.family === "gpt6")) assert.deepEqual(modelClients(model, "autopilot"), ["autopilot"]);
  });
});
