import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, createInvite, createService, MODEL, usage, type Service } from "./harness.js";
import { hostOf, hostSlug, isNoHostError, providerPreferences } from "../src/routing.js";
import { readFreeConfig } from "../src/config.js";

const FILTERS = { sort: "price", allow_fallbacks: true, quantizations: ["fp8", "mxfp8", "fp16", "bf16", "fp32"], data_collection: "deny" };
const MINUTE = 60_000;

async function member(vars: Record<string, string> = {}): Promise<{ service: Service; token: string; adminToken: string }> {
  const service = await createService(vars);
  const adminToken = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const token = (await service.signIn({ id: 100, login: "alice" }, { invite: await createInvite(service, adminToken) })).access_token;
  return { service, token, adminToken };
}

const chat = (service: Service, token: string, body: Record<string, unknown> = {}) =>
  service.request("POST", "/v1/chat/completions", { token, body: { model: MODEL, messages: [{ role: "user", content: "hello" }], ...body } });

/** A completion served by `provider`, the way OpenRouter names it. */
function served(provider: string): Response {
  return Response.json({ id: "gen-1", object: "chat.completion", model: MODEL, provider, choices: [{ index: 0, message: { role: "assistant", content: "hi" } }], usage: usage(100, 10) });
}

/** OpenRouter's error when a host fails, naming the host. */
function hostError(provider: string, status = 502): Response {
  return Response.json({ error: { code: status, message: "regional pod proxy response stream failed", metadata: { provider_name: provider } } }, { status });
}

function noHost(): Response {
  return Response.json({ error: { code: 404, message: "No allowed providers are available for the selected model." } }, { status: 404 });
}

/** A stream from `provider` that fails part way, the way OpenRouter reports it. */
function failingStream(provider: string): Response {
  const chunks = [
    { id: "gen-2", provider, choices: [{ index: 0, delta: { content: "par" } }] },
    { id: "gen-2", provider, error: { code: 502, message: "regional pod proxy response stream failed" }, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] },
  ];
  const text = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function lastProvider(service: Service): Record<string, unknown> {
  return service.calls.openRouter.at(-1)!.body.provider as Record<string, unknown>;
}

describe("steering around a failing host", () => {
  it("ignores a host for 10 minutes after it fails a request", async () => {
    const { service, token } = await member();
    service.setOpenRouter(() => hostError("Morph"));
    assert.equal((await chat(service, token)).status, 502);
    assert.deepEqual(lastProvider(service), FILTERS, "the first request has no ignore list");

    service.setOpenRouter(() => served("DeepInfra"));
    service.clock.now += 9 * MINUTE;
    assert.equal((await chat(service, token)).status, 200);
    assert.deepEqual(lastProvider(service), { ...FILTERS, ignore: ["morph"] }, "the next one skips Morph; the filters still pick the host");

    service.clock.now += MINUTE + 1;
    assert.equal((await chat(service, token)).status, 200);
    assert.deepEqual(lastProvider(service), FILTERS, "after 10 minutes Morph is tried again");
  });

  it("counts a stream that fails part way as the host's failure, but not a client going away", async () => {
    const { service, token } = await member();
    service.setOpenRouter(() => failingStream("Morph"));
    await (await chat(service, token, { stream: true })).text();
    await chat(service, token);
    assert.deepEqual(lastProvider(service).ignore, ["morph"]);

    const fresh = await member();
    fresh.service.setOpenRouter(() => new Response(`data: ${JSON.stringify({ provider: "Novita", choices: [{ delta: { content: "a" } }] })}\n\n`.repeat(50), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const response = await chat(fresh.service, fresh.token, { stream: true });
    await response.body!.cancel();
    fresh.service.setOpenRouter(() => served("Novita"));
    await chat(fresh.service, fresh.token);
    assert.equal(lastProvider(fresh.service).ignore, undefined);
  });

  it("does not blame a host for a refusal, a rate limit or an unnamed error", async () => {
    const { service, token } = await member();
    for (const response of [
      () => Response.json({ error: { message: "bad request", metadata: { provider_name: "Morph" } } }, { status: 400 }),
      () => Response.json({ error: { message: "slow down", metadata: { provider_name: "Morph" } } }, { status: 429 }),
      () => Response.json({ error: { message: "upstream failed" } }, { status: 502 }),
    ]) {
      service.setOpenRouter(response);
      await chat(service, token);
    }
    service.setOpenRouter(() => served("Morph"));
    await chat(service, token);
    assert.equal(lastProvider(service).ignore, undefined);
  });

  it("retries once without the ignore list when no other host is left", async () => {
    const { service, token } = await member();
    service.setOpenRouter(() => hostError("Morph", 503));
    await chat(service, token);
    service.setOpenRouter((body) => ((body.provider as { ignore?: string[] }).ignore ? noHost() : served("Morph")));
    const before = service.calls.openRouter.length;
    const response = await chat(service, token);
    assert.equal(response.status, 200);
    const calls = service.calls.openRouter.slice(before);
    assert.equal(calls.length, 2);
    assert.deepEqual((calls[0]!.body.provider as Record<string, unknown>).ignore, ["morph"]);
    assert.deepEqual(calls[1]!.body.provider, FILTERS);

    // Only once: a second "no host" is passed on.
    service.setOpenRouter(() => noHost());
    const after = service.calls.openRouter.length;
    assert.equal((await chat(service, token)).status, 400);
    assert.equal(service.calls.openRouter.length - after, 2);
  });

  it("does not retry a 'no host' refusal when nothing was ignored", async () => {
    const { service, token } = await member();
    service.setOpenRouter(() => noHost());
    assert.equal((await chat(service, token)).status, 400);
    assert.equal(service.calls.openRouter.length, 1);
  });

  it("keeps the cooldown configurable: env, admin override, and 0 turns it off", async () => {
    const off = await member({ OPENROUTER_HOST_COOLDOWN_MINUTES: "0" });
    off.service.setOpenRouter(() => hostError("Morph"));
    await chat(off.service, off.token);
    off.service.setOpenRouter(() => served("Morph"));
    await chat(off.service, off.token);
    assert.equal(lastProvider(off.service).ignore, undefined);

    const short = await member({ OPENROUTER_HOST_COOLDOWN_MINUTES: "2" });
    short.service.setOpenRouter(() => hostError("Morph"));
    await chat(short.service, short.token);
    short.service.setOpenRouter(() => served("DeepInfra"));
    short.service.clock.now += MINUTE;
    await chat(short.service, short.token);
    assert.deepEqual(lastProvider(short.service).ignore, ["morph"]);
    short.service.clock.now += MINUTE + 1;
    await chat(short.service, short.token);
    assert.equal(lastProvider(short.service).ignore, undefined);

    const { service, token, adminToken } = await member();
    service.setOpenRouter(() => hostError("Morph"));
    await chat(service, token);
    const set = await service.request("POST", "/admin/config", { token: adminToken, body: { openRouterHostCooldownMinutes: 0 } });
    assert.equal(set.status, 200);
    assert.equal(((await set.json()) as any).effective.openRouterHostCooldownMinutes, 0);
    service.setOpenRouter(() => served("Morph"));
    await chat(service, token);
    assert.equal(lastProvider(service).ignore, undefined, "turning it off applies at once");
    await service.request("POST", "/admin/config", { token: adminToken, body: { openRouterHostCooldownMinutes: null } });
    await chat(service, token);
    assert.deepEqual(lastProvider(service).ignore, ["morph"], "back to the env value: the recent failure counts again");

    const bad = await service.request("POST", "/admin/config", { token: adminToken, body: { openRouterHostCooldownMinutes: -1 } });
    assert.equal(bad.status, 400);
    assert.throws(() => readFreeConfig({ OPENROUTER_API_KEY: "k", GITHUB_CLIENT_ID: "c", GITHUB_CLIENT_SECRET: "s", TOKEN_SIGNING_KEY: "x".repeat(32), OPENROUTER_HOST_COOLDOWN_MINUTES: "soon" }), /OPENROUTER_HOST_COOLDOWN_MINUTES/);
  });

  it("logs host outcomes as counts only, for error rates by host", async () => {
    const { service, token, adminToken } = await member();
    service.setOpenRouter(() => hostError("Morph"));
    await chat(service, token);
    service.setOpenRouter(() => failingStream("Morph"));
    await (await chat(service, token, { stream: true })).text();
    service.setOpenRouter(() => served("DeepInfra"));
    await chat(service, token);
    await chat(service, token);

    const failures = service.directory().ctx.storage.sql.exec("SELECT * FROM host_failures ORDER BY id").toArray();
    assert.deepEqual(
      failures.map((row: any) => [row.host, row.kind, row.upstream_status]),
      [["morph", "http_5xx", 502], ["morph", "stream", null]],
    );
    assert.deepEqual(Object.keys(failures[0]).sort(), ["at", "host", "id", "kind", "upstream_status"], "no content is kept");

    const metrics = (await (await service.request("GET", "/admin/metrics", { token: adminToken })).json()) as any;
    assert.deepEqual(metrics.hosts, [
      { host: "deepinfra", requests: 2, failures: 0, failureRate: 0 },
      { host: "morph", requests: 2, failures: 2, failureRate: 1 },
    ]);
  });
});

describe("routing helpers", () => {
  it("turns OpenRouter host names into slugs", () => {
    assert.equal(hostSlug("Morph"), "morph");
    assert.equal(hostSlug("DeepInfra"), "deepinfra");
    assert.equal(hostSlug("Google Vertex"), "google-vertex");
    assert.equal(hostSlug(""), undefined);
    assert.equal(hostSlug(3), undefined);
    assert.equal(hostOf({ provider: "Novita" }), "novita");
    assert.equal(hostOf({ error: { metadata: { provider_name: "Morph" } } }), "morph");
    assert.equal(hostOf(undefined), undefined);
  });

  it("adds ignore only when there are hosts to skip", () => {
    const config = { openRouterProviderOrder: [], openRouterQuantizations: [], openRouterDataCollection: "deny" as const };
    assert.deepEqual(providerPreferences(config), { sort: "price", allow_fallbacks: true, data_collection: "deny" });
    assert.deepEqual(providerPreferences(config, ["morph"]), { sort: "price", allow_fallbacks: true, data_collection: "deny", ignore: ["morph"] });
  });

  it("recognises OpenRouter's 'no host' refusals", () => {
    assert.equal(isNoHostError(404, JSON.stringify({ error: { message: "No allowed providers are available for the selected model." } })), true);
    assert.equal(isNoHostError(404, JSON.stringify({ error: { message: "No endpoints found matching your data policy." } })), true);
    assert.equal(isNoHostError(503, "No endpoints found that can handle the requested parameters."), true);
    assert.equal(isNoHostError(502, JSON.stringify({ error: { message: "regional pod proxy response stream failed" } })), false);
    assert.equal(isNoHostError(429, "No providers available"), false);
    assert.equal(isNoHostError(200, ""), false);
  });
});
