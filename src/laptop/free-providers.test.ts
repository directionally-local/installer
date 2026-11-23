import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chosenFreeModel, FREE_DEFAULT_MODEL_ID, formatProvidersTable, freeModelLine, freeModelStatus, freeProviders, modelsCommand, parseProviders, type FreeProvidersOptions } from "./free-providers.js";

const BODY = {
  updatedAt: "2026-11-23T09:00:00.000Z",
  providers: [
    {
      id: "luminal", name: "Luminal", website: "https://luminal.example", url: "https://luminal.example/?utm_source=dl.new&utm_medium=referral&utm_campaign=providers", logo: "/logos/luminal.svg",
      models: [{ id: FREE_DEFAULT_MODEL_ID, name: "DeepSeek V4.1 Flash", family: "deepseek", contextWindow: 1_048_576, access: "free", status: "on", tokensPerSecond: 84.6, ttftMs: 620, successRate24h: 0.998, measuredAt: "2026-11-23T08:55:00.000Z" }],
    },
    {
      id: "openai", name: "OpenAI", website: "https://openai.example", url: "https://openai.example/?utm_source=dl.new", logo: "/logos/openai.svg",
      models: [{ id: "gpt-6-luna", name: "GPT-6 Luna", family: "gpt6", contextWindow: 1_050_000, access: "trusted", status: "paused", tokensPerSecond: null, ttftMs: null, successRate24h: null, measuredAt: null }],
    },
  ],
};

function options(respond: (url: string, init: RequestInit) => Response | Promise<Response>, config?: unknown): FreeProvidersOptions & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    env: { HOME: "/home/octo" },
    exists: () => false,
    readFile: async () => (config === undefined ? Promise.reject(new Error("ENOENT")) : JSON.stringify(config)),
    fetch: async (url, init) => (calls.push(url), respond(url, init)),
  };
}

describe("free providers", () => {
  it("reads GET /v1/providers from the service, without credentials and with a short timeout", async () => {
    let seen: RequestInit | undefined;
    const opts = options((_url, init) => ((seen = init), Response.json(BODY)));
    const list = await freeProviders(opts);
    assert.deepEqual(opts.calls, ["https://free.directionallylocal.com/v1/providers"]);
    assert.equal(new Headers(seen?.headers).get("authorization"), null);
    assert.ok(seen?.signal);
    assert.equal(list.live, true);
    assert.deepEqual(list.providers.map((p) => p.name), ["Luminal", "OpenAI"]);
    assert.equal(list.providers[0]!.models[0]!.tokensPerSecond, 84.6);
  });

  it("falls back to DeepSeek V4.1 Flash on Luminal, no speeds, while the endpoint 404s or is down", async () => {
    for (const respond of [() => new Response("not found", { status: 404 }), () => Promise.reject(new Error("timeout")), () => Response.json({ nope: 1 })]) {
      const list = await freeProviders(options(respond));
      assert.equal(list.live, false);
      assert.equal(list.providers.length, 1);
      assert.equal(list.providers[0]!.name, "Luminal");
      assert.equal(list.providers[0]!.models[0]!.id, FREE_DEFAULT_MODEL_ID);
      assert.equal(list.providers[0]!.models[0]!.tokensPerSecond, null);
    }
  });

  it("honours AUTOPILOT_DL_FREE_URL", async () => {
    const opts = options(() => Response.json(BODY));
    await freeProviders({ ...opts, env: { AUTOPILOT_DL_FREE_URL: "http://127.0.0.1:8787/v1" } });
    assert.deepEqual(opts.calls, ["http://127.0.0.1:8787/v1/providers"]);
  });

  it("drops malformed providers and models and defaults unknown enums safely", () => {
    const list = parseProviders({ providers: [{ id: "x" }, { id: "y", name: "Y", models: [{ id: "m", name: "M", access: "weird", status: "??", tokensPerSecond: -3 }, { name: "no id" }] }] });
    assert.equal(list?.providers.length, 1);
    assert.deepEqual(list?.providers[0]!.models.map((m) => [m.id, m.access, m.status, m.tokensPerSecond]), [["m", "free", "paused", null]]);
    assert.equal(parseProviders({ providers: [] }), undefined);
  });

  it("reads the model /model saved for the free tier from Autopilot's config", async () => {
    const fetch = () => Response.json(BODY);
    assert.equal(await chosenFreeModel(options(fetch, { provider: "openrouter", model: "moonshotai/kimi-k2.6", providers: { "directionally-local": { apiKey: "t", model: "gpt-6-luna" } } })), "gpt-6-luna");
    assert.equal(await chosenFreeModel(options(fetch, { provider: "directionally-local", model: FREE_DEFAULT_MODEL_ID })), FREE_DEFAULT_MODEL_ID);
    assert.equal(await chosenFreeModel(options(fetch, { provider: "openrouter", model: "moonshotai/kimi-k2.6" })), undefined);
    assert.equal(await chosenFreeModel(options(fetch)), undefined);
  });
});

describe("dl status's free model line", () => {
  it("names the model, its provider and its measured speed", async () => {
    const line = await freeModelStatus(options(() => Response.json(BODY), { providers: { "directionally-local": { model: FREE_DEFAULT_MODEL_ID } } }));
    assert.equal(line, "DeepSeek V4.1 Flash · Luminal · ~85 tok/s");
  });

  it("leaves the speed out when unmeasured, and says when a model is paused", () => {
    const list = parseProviders(BODY)!;
    assert.equal(freeModelLine("gpt-6-luna", list), "GPT-6 Luna · OpenAI · paused");
    assert.equal(freeModelLine("some/unknown", list), "some/unknown");
  });

  it("shows the default on the built-in list when nothing is chosen and the endpoint isn't live", async () => {
    const line = await freeModelStatus(options(() => new Response("", { status: 404 })));
    assert.equal(line, "DeepSeek V4.1 Flash (default) · Luminal");
  });
});

describe("dl models", () => {
  it("prints a table of providers and models with speed and first token time", () => {
    const table = formatProvidersTable(parseProviders(BODY)!, { chosen: FREE_DEFAULT_MODEL_ID });
    assert.match(table, /Provider\s+Model\s+Context\s+Access\s+Status\s+Speed\s+First token/);
    assert.match(table, /✓\s+Luminal\s+DeepSeek V4\.1 Flash\s+1M\s+free\s+on\s+~85 tok\/s\s+~0\.6 s/);
    assert.match(table, /OpenAI\s+GPT-6 Luna\s+1\.1M\s+trusted\s+paused\n/);
    assert.match(table, /measured every 10 minutes/);
    assert.match(table, /utm_source=dl\.new/);
    assert.doesNotMatch(table, /\x1b\[/);
  });

  it("marks dl Pro only models Pro, says what Pro gives and where to upgrade", () => {
    const kimi = { id: "moonshotai/kimi-k3.1-pro", name: "Kimi K3.1 Pro", family: "kimi", contextWindow: 1_048_576, access: "pro", status: "on", tokensPerSecond: 40, ttftMs: 1500, successRate24h: 1, measuredAt: "2026-11-23T08:55:00.000Z" };
    const list = parseProviders({ ...BODY, providers: [...BODY.providers, { id: "liquid", name: "Liquid Inference", models: [kimi] }] })!;
    const table = formatProvidersTable(list);
    assert.match(table, /Liquid Inference\s+Kimi K3\.1 Pro\s+1M\s+Pro\s+on\s+~40 tok\/s/);
    assert.match(table, /Pro: dl Pro only, a small weekly allowance, then DeepSeek\. Upgrade: https:\/\/dl\.new\/account/);
    assert.equal(freeModelLine("moonshotai/kimi-k3.1-pro", list), "Kimi K3.1 Pro · Liquid Inference · ~40 tok/s · Pro");
    assert.doesNotMatch(formatProvidersTable(parseProviders(BODY)!), /dl Pro only/);
  });

  it("says when it shows the built-in list", async () => {
    let out = "";
    assert.equal(await modelsCommand({ out: (t) => (out += t) }, options(() => new Response("", { status: 404 }))), 0);
    assert.match(out, /built-in list/);
    assert.match(out, /Luminal\s+DeepSeek V4\.1 Flash/);
  });

  it("prints JSON with --json", async () => {
    let out = "";
    await modelsCommand({ out: (t) => (out += t) }, { ...options(() => Response.json(BODY), { providers: { "directionally-local": { model: "gpt-6-luna" } } }), json: true });
    const parsed = JSON.parse(out);
    assert.equal(parsed.live, true);
    assert.equal(parsed.chosen, "gpt-6-luna");
    assert.equal(parsed.providers.length, 2);
  });
});
