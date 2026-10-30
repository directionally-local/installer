import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RemoteClient } from "./client.js";
import type { RemoteServer } from "./config.js";
import { ConnectCancelled } from "./connect.js";
import { ensurePlaceProvider, placeHasProvider, type PlaceProviderDeps } from "./place-provider.js";

const LOCAL: RemoteServer = { name: "this-computer", url: "http://127.0.0.1:4096", token: "aster_x", credentialId: "c", expiresAt: "2027-01-01T00:00:00.000Z", addedAt: "2026-10-28T00:00:00.000Z" };
const SERVER: RemoteServer = { ...LOCAL, name: "box", ssh: { target: "root@203.0.113.10" } };

/** The parts of the API this check asks for: /models, with or without the provider behind it. */
function client(provider: { id: string; name: string } | undefined): RemoteClient {
  return { catalog: async () => ({ models: ["deepseek-v4-pro"], ...(provider ? { provider } : {}) }) } as unknown as RemoteClient;
}

const CHOSEN = { provider: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKey: "sk-deepseek-secretsecret", apiKeyEnv: "DEEPSEEK_API_KEY", keyRequired: true, model: "deepseek-v4-pro" };
const ANSWER = { provider: { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKey: CHOSEN.apiKey, apiKeyEnv: "DEEPSEEK_API_KEY" } };

function deps(extra: Partial<PlaceProviderDeps> = {}) {
  const lines: string[] = [];
  const connects: Array<{ modelOnly?: boolean }> = [];
  const configured: unknown[] = [];
  const value: PlaceProviderDeps = {
    connect: async (options) => { connects.push(options); return CHOSEN; },
    local: { ready: async () => true, configure: async (answers) => { configured.push(answers); } },
    write: (text) => { lines.push(text); },
    color: false,
    ...extra,
  };
  return { deps: value, lines, connects, configured };
}

describe("a place's provider before a session", () => {
  it("asks nothing when this computer's provider route is active", async () => {
    const run = deps();
    assert.equal(await ensurePlaceProvider(LOCAL, client({ id: "deepseek", name: "DeepSeek" }), run.deps), true);
    assert.deepEqual(run.connects, []);
    assert.deepEqual(run.configured, []);
    assert.deepEqual(run.lines, []);
  });

  it("runs Autopilot's picker and stores the key when this computer's route is inactive", async () => {
    const run = deps({ local: { ready: async () => false, configure: async (answers) => { run.configured.push(answers); } } });
    assert.equal(await ensurePlaceProvider(LOCAL, client({ id: "openrouter", name: "OpenRouter" }), run.deps), true);
    assert.deepEqual(run.connects, [{}], "the whole picker: provider, key and model");
    assert.deepEqual(run.configured, [ANSWER]);
    assert.match(run.lines.join(""), /! this computer has no model provider yet\n/);
    assert.match(run.lines.join(""), /✓ DeepSeek · deepseek-v4-pro · key stays on this computer\n/);
  });

  it("leaves an older server that names no provider alone", async () => {
    const run = deps();
    assert.equal(await placeHasProvider(SERVER, client(undefined), run.deps), undefined);
    assert.equal(await ensurePlaceProvider(SERVER, client(undefined), run.deps), true);
    assert.deepEqual(run.connects, []);
  });

  it("takes a server's /models naming a provider as its word", async () => {
    const run = deps({ local: { ready: async () => false, configure: async () => {} } });
    assert.equal(await ensurePlaceProvider(SERVER, client({ id: "deepseek", name: "DeepSeek" }), run.deps), true);
    assert.deepEqual(run.connects, [], "no picker for a place this laptop can't check");
  });

  it("stops quietly when the user backs out of the picker", async () => {
    const run = deps({ connect: async () => { throw new ConnectCancelled(); }, local: { ready: async () => false, configure: async () => {} } });
    assert.equal(await ensurePlaceProvider(LOCAL, client({ id: "openrouter", name: "OpenRouter" }), run.deps), false);
    assert.deepEqual(run.configured, [], "nothing stored");
  });
});
