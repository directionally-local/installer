/** A slice of OpenRouter's public model list, as `GET /api/v1/models` returns it. */
export const CATALOG = {
  data: [
    { id: "openai/gpt-6-luna", pricing: { prompt: "0.0000025", completion: "0.00001" } },
    { id: "moonshotai/kimi-k2.6", pricing: { prompt: "0.0000006", completion: "0.0000025" } },
    { id: "meta-llama/llama-5-8b:free", pricing: { prompt: "0", completion: "0" } },
  ],
};

/** Answers OpenRouter's model list with CATALOG and passes everything else on. */
export function withCatalog(fetchImpl: typeof fetch, catalog: unknown = CATALOG): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) =>
    String(url) === "https://openrouter.ai/api/v1/models" ? Response.json(catalog) : fetchImpl(url, init)) as typeof fetch;
}
