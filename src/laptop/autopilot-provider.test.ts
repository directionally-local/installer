import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFreeTierServerKey, readAutopilotProvider } from "./autopilot-provider.js";

/** Autopilot's config.json, as its `connect` picker writes it. */
function config(value: unknown): string {
  return JSON.stringify(value);
}

function reader(text: string | undefined) {
  const reads: string[] = [];
  return {
    reads,
    options: {
      env: { HOME: "/home/octo" },
      exists: () => false,
      readFile: async (path: string) => (reads.push(path), text),
    },
  };
}

describe("reading the provider Autopilot already has", () => {
  it("reads a provider with a key, its address and model", async () => {
    const { options, reads } = reader(config({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      providers: { deepseek: { apiKey: "sk-deepseek-secret", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro" } },
    }));
    assert.deepEqual(await readAutopilotProvider(options), {
      kind: "provider",
      result: { provider: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKey: "sk-deepseek-secret", apiKeyEnv: "DEEPSEEK_API_KEY", keyRequired: true, model: "deepseek-v4-pro" },
    });
    assert.deepEqual(reads, ["/home/octo/.config/autopilot/config.json"]);
  });

  it("reads a keyless provider without a key", async () => {
    const { options } = reader(config({ provider: "ollama", model: "qwen3:32b", providers: { ollama: { model: "qwen3:32b" } } }));
    assert.deepEqual(await readAutopilotProvider(options), {
      kind: "provider",
      result: { provider: "ollama", name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", apiKey: null, apiKeyEnv: "OLLAMA_API_KEY", keyRequired: false, model: "qwen3:32b" },
    });
  });

  it("reads the free tier as a sign-in to make a server key from, never as a key to copy", async () => {
    const { options } = reader(config({
      provider: "directionally-local",
      model: "gpt-6-luna",
      providers: { "directionally-local": { apiKey: "access-token", refreshToken: "refresh", expiresAt: 1, baseUrl: "https://free.example.com/v1", model: "gpt-6-luna" } },
    }));
    assert.deepEqual(await readAutopilotProvider(options), {
      kind: "free-tier",
      origin: "https://free.example.com",
      accessToken: "access-token",
      model: "gpt-6-luna",
    });
  });

  it("falls back to the default free tier origin when none is saved", async () => {
    const { options } = reader(config({ provider: "directionally-local", providers: { "directionally-local": { apiKey: "access-token" } } }));
    const found = await readAutopilotProvider(options);
    assert.equal(found?.kind, "free-tier");
    assert.equal(found?.kind === "free-tier" ? found.origin : undefined, "https://free.directionallylocal.com");
  });

  it("reads an older config that keeps the OpenRouter key at the top level", async () => {
    const { options } = reader(config({ openrouterApiKey: "sk-or-v1-secret", model: "openrouter/auto" }));
    assert.deepEqual(await readAutopilotProvider(options), {
      kind: "provider",
      result: { provider: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-v1-secret", apiKeyEnv: "OPENROUTER_API_KEY", keyRequired: true, model: "openrouter/auto" },
    });
  });

  it("returns undefined when nothing is chosen, a key is missing, or the file is unreadable", async () => {
    assert.equal(await readAutopilotProvider(reader(undefined).options), undefined, "no config");
    assert.equal(await readAutopilotProvider(reader("{nope").options), undefined, "damaged config");
    assert.equal(await readAutopilotProvider(reader(config({ provider: "deepseek", providers: { deepseek: {} } })).options), undefined, "a provider that needs a key has none");
    assert.equal(await readAutopilotProvider(reader(config({ provider: "directionally-local", providers: { "directionally-local": {} } })).options), undefined, "the free tier isn't signed in");
  });
});

describe("creating a free tier server key", () => {
  it("posts the place's name with the access token and returns the key", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return Response.json({ id: "ab12cd34ef56", name: "box", key: "dlk_583231_ab_secret" }, { status: 201 });
    };
    assert.deepEqual(await createFreeTierServerKey("https://free.example.com", "access-token", "box", { fetch }), { key: "dlk_583231_ab_secret" });
    assert.equal(calls[0]!.url, "https://free.example.com/v1/keys");
    assert.equal(calls[0]!.init.method, "POST");
    assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer access-token");
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { name: "box" });
  });

  it("turns the key limit, a refusal and a network error into one line", async () => {
    const limit = async () => Response.json({ error: { code: "key_limit_reached", message: "This account already has 3 server keys. Revoke one first." } }, { status: 409 });
    assert.deepEqual(await createFreeTierServerKey("https://free.example.com", "t", "box", { fetch: limit }), { problem: "This account already has 3 server keys. Revoke one first." });
    const refused = async () => Response.json({ error: { code: "invalid_token", message: "Sign in again." } }, { status: 401 });
    assert.deepEqual(await createFreeTierServerKey("https://free.example.com", "t", "box", { fetch: refused }), { problem: "Sign in again." });
    const offline = async () => { throw new Error("getaddrinfo ENOTFOUND free.example.com"); };
    assert.deepEqual(await createFreeTierServerKey("https://free.example.com", "t", "box", { fetch: offline }), { problem: "getaddrinfo ENOTFOUND free.example.com" });
  });
});
