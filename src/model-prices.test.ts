import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OPENROUTER_MODELS_URL, countModelPrices, fetchModelPrices, isModelNotPriced, modelPricesHealth, pricesFromCatalog, refreshModelPrices, renderModelPrices,
} from "./model-prices.js";
import { CATALOG, withCatalog } from "./test-support/fake-catalog.js";
import { FakeSystem } from "./test-support/fake-system.js";

const unreachable = (async () => { throw new Error("getaddrinfo ENOTFOUND openrouter.ai"); }) as unknown as typeof fetch;

describe("model prices", () => {
  it("converts OpenRouter's per-token strings to per-million prices, keyed by lower-cased id", () => {
    const table = pricesFromCatalog({
      data: [
        { id: "OpenAI/GPT-6-Luna", pricing: { prompt: "0.0000001", completion: "0.0000004" } },
        { id: "anthropic/claude-opus-5", pricing: { prompt: "0.000015", completion: "0.000075" } },
        { id: "free/model:free", pricing: { prompt: "0", completion: "0" } },
        { id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } },
        { id: "garbage/a", pricing: { prompt: "abc", completion: "0.000001" } },
        { id: "garbage/b", pricing: { prompt: "", completion: "0.000001" } },
        { id: "garbage/c", pricing: { prompt: "0.000001" } },
        { id: "garbage/d", pricing: { prompt: "Infinity", completion: "0.000001" } },
        { id: "garbage/e" },
        { pricing: { prompt: "0.000001", completion: "0.000001" } },
        null,
        { id: "numeric/model", pricing: { prompt: 0.000002, completion: 0.000008 } },
      ],
    });
    assert.deepEqual(table, {
      "openai/gpt-6-luna": { inputPerMTok: 0.1, outputPerMTok: 0.4 },
      "anthropic/claude-opus-5": { inputPerMTok: 15, outputPerMTok: 75 },
      "free/model:free": { inputPerMTok: 0, outputPerMTok: 0 },
      "numeric/model": { inputPerMTok: 2, outputPerMTok: 8 },
    });
    assert.throws(() => pricesFromCatalog({ models: [] }), /no models/);
  });

  it("fetches the public catalog without a key, and refuses an empty or failed answer", async () => {
    let asked: { url: string; auth: string | null } | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      asked = { url: String(url), auth: new Headers(init?.headers).get("authorization") };
      return Response.json(CATALOG);
    }) as typeof fetch;
    const { table, count } = await fetchModelPrices(fetchImpl);
    assert.deepEqual(asked, { url: OPENROUTER_MODELS_URL, auth: null });
    assert.equal(count, 3);
    assert.deepEqual(table["openai/gpt-6-luna"], { inputPerMTok: 2.5, outputPerMTok: 10 });

    await assert.rejects(() => fetchModelPrices(withCatalog(unreachable, { data: [] })), /no prices/);
    await assert.rejects(() => fetchModelPrices((async () => new Response("busy", { status: 503 })) as unknown as typeof fetch), /HTTP 503/);
    await assert.rejects(() => fetchModelPrices(unreachable), /couldn't reach openrouter\.ai: getaddrinfo ENOTFOUND/);
  });

  it("renders JSON Hotcell overlays on its built-in prices", () => {
    const text = renderModelPrices({ "b/m": { inputPerMTok: 1, outputPerMTok: 2 }, "a/m": { inputPerMTok: 0, outputPerMTok: 0 } });
    assert.deepEqual(Object.keys(JSON.parse(text) as object), ["a/m", "b/m"]);
    assert.ok(text.endsWith("}\n"));
    assert.equal(countModelPrices(text), 2);
    assert.equal(countModelPrices("not json"), undefined);
    assert.equal(countModelPrices("[]"), undefined);
  });

  it("keeps the last list when OpenRouter can't be reached, and warns clearly when there's none", async () => {
    const system = new FakeSystem();
    const warnings: string[] = [];
    const refresh = (fetchImpl: typeof fetch) => refreshModelPrices(system, { path: "/p.json", write: { mode: 0o644 }, fetchImpl, warn: (text) => warnings.push(text), retry: "dl up" });

    assert.equal(await refresh(unreachable), undefined);
    assert.equal(system.files.has("/p.json"), false);
    assert.match(warnings[0]!, /Couldn't download model prices \(couldn't reach openrouter\.ai.*\)\. Tasks will fail with "model not priced" until dl up can reach openrouter\.ai\./);

    assert.equal(await refresh(withCatalog(unreachable)), "prices for 3 models");
    const written = system.files.get("/p.json")!.content;
    assert.equal(await refresh(unreachable), undefined);
    assert.equal(system.files.get("/p.json")!.content, written, "kept as it was");
    assert.match(warnings[1]!, /Couldn't refresh model prices .*; kept the last list \(3 models\)\./);
  });

  it("reports a price file's health: missing fails, older than a week warns", () => {
    const now = new Date("2026-10-29T12:00:00Z");
    const seconds = (iso: string) => Date.parse(iso) / 1000;
    const text = renderModelPrices({ "a/m": { inputPerMTok: 1, outputPerMTok: 1 } });
    assert.deepEqual(modelPricesHealth(undefined, undefined, now, "dl up"), { ok: false, warn: false, detail: 'missing; tasks fail with "model not priced"' });
    assert.equal(modelPricesHealth("{}", seconds("2026-10-29T00:00:00Z"), now, "dl up").ok, false);
    assert.deepEqual(modelPricesHealth(text, seconds("2026-10-29T08:00:00Z"), now, "dl up"), { ok: true, warn: false, detail: "1 model · updated today" });
    assert.deepEqual(modelPricesHealth(text, seconds("2026-10-22T08:00:00Z"), now, "dl up"), { ok: true, warn: false, detail: "1 model · 7 days old" });
    assert.deepEqual(modelPricesHealth(text, seconds("2026-10-01T08:00:00Z"), now, "dl up"), { ok: true, warn: true, detail: "1 model · 28 days old; dl up refreshes it" });
  });

  it("recognizes the gateway's refusal", () => {
    assert.ok(isModelNotPriced("HTTP 403: model not priced: openai/gpt-6-luna — a spend cap applies"));
    assert.ok(!isModelNotPriced("HTTP 403: spend cap reached"));
  });
});
