import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { ADMIN_ID, completion, createInvite, createService, luminalUsage, MODEL, usage, type Service } from "./harness.js";
import { costAtPrices, type Usage } from "../src/quota.js";
import { creditAlert, crossed } from "../src/alerts.js";
import { readFreeConfig } from "../src/config.js";
import { creditForecast, shouldQueue } from "../src/queue.js";
import { hasContent } from "../src/sse.js";

const KEY = "lum-test-key";
const LUMINAL_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
const HOOK = "https://alerts.test/hook";

/** 800k uncached + 200k cached prompt tokens, 100k completion tokens. */
const BIG = { prompt: 1_000_000, completion: 100_000, cached: 200_000 };
/** BIG at Luminal's list prices: 0.8 × 0.1425 + 0.2 × 0.0029 + 0.1 × 0.57. */
const BIG_CREDIT = 0.8 * 0.1425 + 0.2 * 0.0029 + 0.1 * 0.57;
/**
 * BIG at the OpenRouter prices we were billed (Morph, per OpenRouter's endpoints API on
 * 2026-11-04): 0.8 × 0.035 + 0.2 × 0.006 + 0.1 × 0.315.
 */
const BIG_EQUIVALENT = 0.8 * 0.035 + 0.2 * 0.006 + 0.1 * 0.315;

let ips = 0;
async function member(vars: Record<string, string> = {}): Promise<{ service: Service; token: string; adminToken: string }> {
  const service = await createService({ LUMINAL_API_KEY: KEY, ALERT_WEBHOOK_URL: HOOK, ...vars });
  const adminToken = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const token = (await service.signIn({ id: 100, login: "alice" }, { invite: await createInvite(service, adminToken) })).access_token;
  return { service, token, adminToken };
}

/** A chat request from a fresh address, so the per-IP limit never interferes. */
const chat = (service: Service, token: string, body: Record<string, unknown> = {}) =>
  service.request("POST", "/v1/chat/completions", { token, ip: `10.7.${Math.floor(++ips / 250) % 250}.${ips % 250}`, body: { model: MODEL, messages: [{ role: "user", content: "hello" }], ...body } });

async function errorOf(response: Response): Promise<Record<string, unknown>> {
  return ((await response.json()) as { error: Record<string, unknown> }).error;
}

function db(service: Service): DatabaseSync {
  service.directory();
  return (service.namespaces.DIRECTORY!.instances.get("directory")!.state as unknown as { db: DatabaseSync }).db;
}

function rows(service: Service): Array<Record<string, any>> {
  return db(service).prepare("SELECT upstream, status, cost_usd, credit_usd, upstream_error, ttfb_ms, ttft_ms FROM requests ORDER BY id").all() as Array<Record<string, any>>;
}

const alertTexts = (service: Service) => service.calls.webhooks.map((hook) => String(hook.body.text));

/** A stream with `content` chunks, then an error part way (no [DONE]). */
function brokenStream(content: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const text of content) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`));
        controller.error(new Error("connection reset"));
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

/** A Luminal stream with usage in its last chunk. */
function luminalStream(usageObject: Record<string, unknown>): Response {
  const chunks = [{ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }, { choices: [{ index: 0, delta: { content: "hi" } }] }, { choices: [], usage: usageObject }];
  const text = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("upstream selection", () => {
  it("sends every request to Luminal by default, in Luminal's shape, with the key", async () => {
    const { service, token } = await member();
    const response = await chat(service, token, { max_tokens: 1000, provider: { order: ["x"] }, reasoning: { effort: "high" }, session_id: "s1" });
    assert.equal(response.status, 200);
    assert.equal(service.calls.openRouter.length, 0);
    assert.equal(service.calls.luminal.length, 1);
    const { body, headers } = service.calls.luminal[0]!;
    assert.equal(headers.authorization, `Bearer ${KEY}`);
    assert.equal(body.model, LUMINAL_MODEL);
    assert.equal(body.max_completion_tokens, 1000);
    assert.equal(body.reasoning_effort, "high");
    for (const field of ["max_tokens", "provider", "usage", "reasoning", "session_id", "stream_options"]) assert.equal(body[field], undefined, field);
    assert.match(String(body.user), /^dl-[0-9a-f]{32}$/);
    assert.equal(rows(service).at(-1)!.upstream, "luminal");

    await (await chat(service, token, { stream: true })).text();
    assert.deepEqual(service.calls.luminal[1]!.body.stream_options, { include_usage: true });
  });

  it("uses OpenRouter without LUMINAL_API_KEY, and never mentions the key in a response", async () => {
    const service = await createService();
    const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    assert.equal((await chat(service, admin)).status, 200);
    assert.equal(service.calls.luminal.length, 0);
    assert.equal(service.calls.openRouter.length, 1);
    assert.equal(rows(service)[0]!.upstream, "openrouter");

    const { service: withKey, adminToken } = await member();
    const config = await (await withKey.request("GET", "/admin/config", { token: adminToken })).text();
    assert.doesNotMatch(config, new RegExp(KEY));
  });

  it("switches to OpenRouter by the admin setting or PRIMARY_UPSTREAM, and back", async () => {
    const { service, token, adminToken } = await member();
    const set = await service.request("POST", "/admin/config", { token: adminToken, body: { primaryUpstream: "openrouter" } });
    assert.equal(set.status, 200);
    assert.equal((await chat(service, token)).status, 200);
    assert.equal(service.calls.openRouter.length, 1);
    assert.equal(service.calls.luminal.length, 0);
    await service.request("POST", "/admin/config", { token: adminToken, body: { primaryUpstream: null } });
    assert.equal((await chat(service, token)).status, 200);
    assert.equal(service.calls.luminal.length, 1);
    assert.equal((await service.request("POST", "/admin/config", { token: adminToken, body: { primaryUpstream: "groq" } })).status, 400);

    const env = await member({ PRIMARY_UPSTREAM: "openrouter" });
    assert.equal((await chat(env.service, env.token)).status, 200);
    assert.equal(env.service.calls.luminal.length, 0);
    assert.throws(() => readFreeConfig({ OPENROUTER_API_KEY: "k", GITHUB_CLIENT_ID: "i", GITHUB_CLIENT_SECRET: "s", TOKEN_SIGNING_KEY: "x".repeat(32), PRIMARY_UPSTREAM: "both" }));
  });
});

describe("Luminal errors (no automatic fallback)", () => {
  it("answers a Luminal 429 with 429 upstream_busy and its Retry-After, charging nothing", async () => {
    const { service, token } = await member();
    const before = rows(service).length;
    service.setLuminal(() => new Response(JSON.stringify({ error: { message: "rate limit" } }), { status: 429, headers: { "retry-after": "7" } }));
    const response = await chat(service, token);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "7");
    assert.deepEqual(await errorOf(response), { code: "upstream_busy", message: "The free tier is busy right now; retrying…", retryAfter: 7, retryable: true, upstream: "luminal" });
    assert.equal(service.calls.openRouter.length, 0, "no switch to OpenRouter");
    const row = rows(service).at(-1)!;
    assert.equal(rows(service).length, before + 1);
    assert.deepEqual([row.upstream, row.status, row.cost_usd, row.credit_usd, row.upstream_error], ["luminal", "upstream_busy", 0, 0, 1]);
    const me = (await (await service.request("GET", "/v1/me", { token })).json()) as { allowance: { usedThisWeek: number } };
    assert.equal(me.allowance.usedThisWeek, 0);
  });

  it("answers a Luminal 5xx or an unreachable Luminal with a transient 503", async () => {
    const { service, token } = await member();
    service.setLuminal(() => new Response("bad gateway", { status: 502 }));
    const response = await chat(service, token);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "5");
    const error = await errorOf(response);
    assert.equal(error.code, "upstream_unavailable");
    assert.equal(error.retryable, true);

    service.setLuminal(() => {
      throw new TypeError("network down");
    });
    const unreachable = await chat(service, token);
    assert.equal(unreachable.status, 503);
    assert.equal((await errorOf(unreachable)).code, "upstream_unavailable");
    assert.equal(service.calls.openRouter.length, 0);
  });

  it("answers 503 upstream_timeout when nothing arrives before the first-byte timeout", async () => {
    const { service, token } = await member({ LUMINAL_FIRST_BYTE_TIMEOUT_SECONDS: "0.05" });
    let aborted = false;
    service.setLuminal(
      (_body, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    );
    const response = await chat(service, token);
    assert.equal(response.status, 503);
    assert.equal((await errorOf(response)).code, "upstream_timeout");
    assert.equal(aborted, true, "the Luminal request is aborted");
    assert.equal(service.calls.openRouter.length, 0);
    assert.equal(rows(service).at(-1)!.status, "upstream_timeout");
    assert.equal(readFreeConfig({ OPENROUTER_API_KEY: "k", GITHUB_CLIENT_ID: "i", GITHUB_CLIENT_SECRET: "s", TOKEN_SIGNING_KEY: "x".repeat(32) }).luminalFirstByteTimeoutSeconds, 30);
  });

  it("passes a stream that fails after content through as it is, without switching", async () => {
    const { service, token } = await member();
    service.setLuminal(() => brokenStream(["Hel", "lo"]));
    const response = await chat(service, token, { stream: true });
    assert.equal(response.status, 200);
    await assert.rejects(response.text());
    assert.equal(service.calls.openRouter.length, 0);
    const row = rows(service).at(-1)!;
    assert.deepEqual([row.upstream, row.status, row.upstream_error], ["luminal", "no_usage", 1]);
    assert.ok(row.credit_usd > 0, "without usage, the credit is charged the reservation at the fallback price");
  });

  it("fails a stream before any content the same way: the client retries", async () => {
    const { service, token } = await member();
    service.setLuminal(() => brokenStream([]));
    const response = await chat(service, token, { stream: true });
    assert.equal(response.status, 200);
    await assert.rejects(response.text());
    assert.equal(service.calls.openRouter.length, 0);
    assert.equal(rows(service).at(-1)!.upstream_error, 1);
  });

  it("refuses a 4xx as the request's problem, and Luminal refusing the key as the service's", async () => {
    const { service, token } = await member();
    service.setLuminal(() => Response.json({ error: { message: "bad tool schema" } }, { status: 400 }));
    const bad = await chat(service, token);
    assert.equal(bad.status, 400);
    assert.match(String((await errorOf(bad)).message), /bad tool schema/);
    service.setLuminal(() => Response.json({ error: { message: "invalid api key" } }, { status: 401 }));
    const key = await chat(service, token);
    assert.equal(key.status, 502);
    assert.doesNotMatch(JSON.stringify(await errorOf(key)), new RegExp(KEY));
  });
});

describe("Luminal credit", () => {
  it("computes credit from usage and Luminal prices, and charges the allowance at OpenRouter prices", async () => {
    const { service, token, adminToken } = await member();
    service.setLuminal(() => completion(luminalUsage(BIG.prompt, BIG.completion, BIG.cached)));
    assert.equal((await chat(service, token)).status, 200);
    const row = rows(service).at(-1)!;
    assert.ok(Math.abs(row.credit_usd - BIG_CREDIT) < 1e-9, `${row.credit_usd}`);
    assert.ok(Math.abs(row.cost_usd - BIG_EQUIVALENT) < 1e-9, `${row.cost_usd}`);
    const me = (await (await service.request("GET", "/v1/me", { token })).json()) as { allowance: { spentUsdThisWeek: number } };
    assert.ok(Math.abs(me.allowance.spentUsdThisWeek - BIG_EQUIVALENT) < 1e-6);
    const spend = (await (await service.request("GET", "/admin/spend", { token: adminToken })).json()) as Record<string, any>;
    assert.equal(spend.spentUsd, 0, "no cash");
    assert.ok(Math.abs(spend.luminalCredit.usedUsd - BIG_CREDIT) < 1e-6);
    assert.equal(spend.luminalCredit.balanceUsd, 2000);
    assert.equal(spend.upstream.serving, "luminal");

    // A stream's usage counts the same way.
    service.setLuminal(() => luminalStream(luminalUsage(BIG.prompt, BIG.completion, BIG.cached)));
    await (await chat(service, token, { stream: true })).text();
    assert.ok(Math.abs(rows(service).at(-1)!.credit_usd - BIG_CREDIT) < 1e-9);
  });

  it("takes the prices from LUMINAL_PRICE_* and OPENROUTER_PRICE_*", () => {
    const config = readFreeConfig({
      OPENROUTER_API_KEY: "k",
      GITHUB_CLIENT_ID: "i",
      GITHUB_CLIENT_SECRET: "s",
      TOKEN_SIGNING_KEY: "x".repeat(32),
      LUMINAL_PRICE_INPUT: "1",
      LUMINAL_PRICE_CACHED: "0.5",
      LUMINAL_PRICE_OUTPUT: "2",
      OPENROUTER_PRICE_OUTPUT: "3",
    });
    const used: Usage = { promptTokens: 1_000_000, completionTokens: 1_000_000, cachedTokens: 500_000, costUsd: undefined };
    assert.equal(costAtPrices(used, config.luminalPrices), 0.5 + 0.25 + 2);
    assert.deepEqual(config.openRouterPrices, { input: 0.035, cached: 0.006, output: 3 });
    // The defaults: Morph's prices on OpenRouter, 2026-11-04.
    assert.deepEqual(readFreeConfig({ OPENROUTER_API_KEY: "k", GITHUB_CLIENT_ID: "i", GITHUB_CLIENT_SECRET: "s", TOKEN_SIGNING_KEY: "x".repeat(32) }).openRouterPrices, { input: 0.035, cached: 0.006, output: 0.315 });
    assert.equal(config.luminalCreditUsd, 2000);
    assert.equal(config.luminalWeeklyCreditUsd, 250);
  });

  it("pauses free, Pro and admin usage with upstream_credit_exhausted once the credit is used, and resumes when it is raised", async () => {
    const { service, token, adminToken } = await member({ LUMINAL_CREDIT_USD: "0.3" });
    service.setLuminal(() => completion(luminalUsage(BIG.prompt, BIG.completion, BIG.cached)));
    assert.equal((await chat(service, token)).status, 200); // 0.17 of 0.30
    assert.equal((await chat(service, token)).status, 200); // 0.34: past the balance
    const calls = service.calls.luminal.length;

    const refused = await chat(service, token);
    assert.equal(refused.status, 503);
    assert.deepEqual(await errorOf(refused), {
      code: "upstream_credit_exhausted",
      message: "Free tokens are paused while we top up. Your own key still works.",
      reason: "credit_exhausted",
      pausedForEveryone: true,
      resetsAt: null,
    });
    assert.equal((await chat(service, adminToken)).status, 503);
    // Pro usage pauses too.
    await service.account(100).applySubscription({ subscriptionId: "sub_1", state: "active", periodEnd: Date.now() + 30 * 86_400_000, eventAt: 1 });
    assert.equal((await errorOf(await chat(service, token))).code, "upstream_credit_exhausted");
    assert.equal(service.calls.luminal.length, calls, "Luminal isn't called");
    assert.equal(service.calls.openRouter.length, 0, "no switch to OpenRouter");

    const texts = alertTexts(service);
    assert.equal(texts.filter((text) => text.includes("Luminal credit used up") || text.includes("upstream_credit_exhausted")).length, 1, "one pause alert");
    assert.equal(texts.filter((text) => text.includes("100%")).length, 1);

    await service.request("POST", "/admin/config", { token: adminToken, body: { luminalCreditUsd: 1 } });
    assert.equal((await chat(service, token)).status, 200);

    // The admin can also move to OpenRouter while the credit is out.
    await service.request("POST", "/admin/config", { token: adminToken, body: { luminalCreditUsd: 0.1, primaryUpstream: "openrouter" } });
    assert.equal((await chat(service, token)).status, 200);
    assert.equal(service.calls.openRouter.length, 1);
  });

  it("alerts at 50%, 80% and 100% of the credit, once each", async () => {
    const { service, token } = await member({ LUMINAL_CREDIT_USD: "1" });
    service.setLuminal(() => completion(luminalUsage(BIG.prompt, BIG.completion, BIG.cached)));
    for (let index = 0; index < 8; index++) await chat(service, token); // ~0.17 each
    const credit = alertTexts(service).filter((text) => text.includes("Luminal credit used ("));
    assert.deepEqual(
      credit.map((text) => /\((\d+)%\)/.exec(text)![1]),
      ["50", "80", "100"],
    );
  });
});

describe("cash caps and the queue with Luminal", () => {
  it("counts only OpenRouter cost against the global caps", async () => {
    const { service, token, adminToken } = await member({ GLOBAL_WEEKLY_USD_CAP: "0.2", GLOBAL_TOTAL_USD_CAP: "0.5" });
    service.setLuminal(() => completion(luminalUsage(BIG.prompt, BIG.completion, BIG.cached)));
    for (let index = 0; index < 3; index++) assert.equal((await chat(service, token)).status, 200, "credit spend never reaches the cash caps");

    await service.request("POST", "/admin/config", { token: adminToken, body: { primaryUpstream: "openrouter" } });
    service.setOpenRouter(() => completion(usage(10, 10, 0, 0.25)));
    assert.equal((await chat(service, token)).status, 200);
    const refused = await chat(service, token);
    assert.equal(refused.status, 503);
    assert.equal((await errorOf(refused)).code, "global_weekly_budget_reached");
    const spend = (await (await service.request("GET", "/admin/spend", { token: adminToken })).json()) as Record<string, any>;
    assert.equal(spend.spentUsd, 0.25);
  });

  it("charges the per-person dollar allowance at OpenRouter prices on Luminal", async () => {
    const { service, token } = await member({ PER_PERSON_WEEKLY_USD_CAP: "0.1" });
    service.setLuminal(() => completion(luminalUsage(BIG.prompt, BIG.completion, BIG.cached)));
    assert.equal((await chat(service, token)).status, 200); // 0.0607 at the billed OpenRouter prices
    assert.equal((await chat(service, token)).status, 200); // 0.1214: past the cap
    const refused = await chat(service, token);
    assert.equal(refused.status, 402);
    const error = await errorOf(refused);
    assert.equal(error.code, "quota_exceeded");
    assert.equal(error.reason, "spend");
  });

  it("queues open sign-ups at the threshold of the weekly credit budget", () => {
    const policy = { globalWeeklyUsdCap: 250, queueThreshold: 0.8, primaryUpstream: "luminal" as const, luminalConfigured: true, luminalWeeklyCreditUsd: 100 };
    assert.equal(shouldQueue({ weekUsd: 0, weekCreditUsd: 79, queueLength: 0, policy }), false);
    assert.equal(shouldQueue({ weekUsd: 0, weekCreditUsd: 80, queueLength: 0, policy }), true);
    assert.equal(shouldQueue({ weekUsd: 0, weekCreditUsd: 80, queueLength: 0, policy: { ...policy, primaryUpstream: "openrouter" } }), false, "credit only counts while Luminal serves");
    assert.equal(shouldQueue({ weekUsd: 0, weekCreditUsd: 80, queueLength: 0, policy: { ...policy, luminalConfigured: false } }), false);
    assert.equal(shouldQueue({ weekUsd: 200, weekCreditUsd: 0, queueLength: 0, policy }), true, "cash still counts");
    // Monday: threshold × weekly credit budget, no more than the credit left.
    const plan = creditForecast({ lastWeekCreditUsd: 20, lastWeekActives: 10, policy: { queueThreshold: 0.8, perPersonWeeklyUsdCap: 5, luminalCreditUsd: 2000, luminalWeeklyCreditUsd: 100 }, creditUsedUsd: 0 });
    assert.deepEqual(plan, { avgUsd: 2, actives: 10, budgetUsd: 80, room: 30 });
    const low = creditForecast({ lastWeekCreditUsd: 20, lastWeekActives: 10, policy: { queueThreshold: 0.8, perPersonWeeklyUsdCap: 5, luminalCreditUsd: 2000, luminalWeeklyCreditUsd: 100 }, creditUsedUsd: 1970 });
    assert.equal(low.budgetUsd, 30);
    assert.equal(low.room, 5);
  });

  it("queues open sign-ups end to end once free credit passes 80% of LUMINAL_WEEKLY_CREDIT_USD", async () => {
    const service = await createService({ LUMINAL_API_KEY: KEY, OPEN_ADMISSION: "true", ALERT_WEBHOOK_URL: HOOK, LUMINAL_WEEKLY_CREDIT_USD: "0.2" });
    const early = (await service.signIn({ id: 100, login: "early" })).access_token;
    service.setLuminal(() => completion(luminalUsage(BIG.prompt, BIG.completion, BIG.cached)));
    assert.equal((await chat(service, early)).status, 200); // 0.17 ≥ 0.8 × 0.2
    const late = (await service.signIn({ id: 101, login: "late" })).access_token;
    const refused = await chat(service, late);
    assert.equal(refused.status, 402);
    assert.equal((await errorOf(refused)).code, "free_tier_queued");
    assert.ok(alertTexts(service).some((text) => text.includes("queue started") && text.includes("weekly Luminal credit budget")));
  });
});

describe("upstream telemetry, dashboard and alerts", () => {
  it("records time to first byte and first token, and shows per-upstream numbers and the credit gauge", async () => {
    const { service, token, adminToken } = await member({ LUMINAL_CREDIT_USD: "10" });
    // Ten requests answered after 1 s, 2 s, … 10 s.
    for (let index = 1; index <= 10; index++) {
      service.setLuminal(() => {
        service.clock.now += index * 1000;
        return completion(luminalUsage(1000, 100, 750));
      });
      assert.equal((await chat(service, token)).status, 200);
    }
    service.setLuminal(() => new Response("busy", { status: 429 }));
    await chat(service, token);
    await service.request("POST", "/admin/config", { token: adminToken, body: { primaryUpstream: "openrouter" } });
    service.setOpenRouter(() => completion(usage(100, 10, 0, 0.01)));
    await chat(service, token);

    const timing = rows(service).find((row) => row.upstream === "luminal")!;
    assert.equal(timing.ttfb_ms, 1000);
    assert.equal(timing.ttft_ms, 1000);

    const csv = await (await service.request("GET", "/admin/dashboard/upstreams.csv", { token: adminToken })).text();
    const lines = csv.trim().split("\r\n").map((line) => line.split(","));
    const header = lines[0]!;
    const luminalToday = Object.fromEntries(header.map((name, index) => [name, lines.find((line) => line[0] === "today" && line[1] === "luminal")![index]]));
    assert.equal(luminalToday.requests, "11");
    assert.equal(luminalToday.errors, "1");
    assert.equal(luminalToday.ttft_median_ms, "5000");
    assert.equal(luminalToday.ttft_p90_ms, "9000");
    assert.equal(luminalToday.cache_hit_share, "0.75");
    assert.equal(luminalToday.cash_usd, "0");
    assert.ok(Number(luminalToday.credit_usd) > 0);
    const openRouterWeek = Object.fromEntries(header.map((name, index) => [name, lines.find((line) => line[0] === "week" && line[1] === "openrouter")![index]]));
    assert.equal(openRouterWeek.requests, "1");
    assert.equal(openRouterWeek.cash_usd, "0.01");
    assert.equal(openRouterWeek.credit_usd, "0");

    const html = await (await service.request("GET", "/admin?view=full", { token: adminToken })).text();
    assert.match(html, /<h2>Upstreams<\/h2>/);
    assert.match(html, /<tr><td>Luminal<\/td><td class="l wrap">[^<]*<\/td><td class="used">\$0\.\d+ <span class="muted">of \$10\.00<\/span>/);
    assert.match(html, /aria-label="Luminal credit used against the balance"/);
    assert.match(html, /<td>Luminal<\/td><td>11<\/td><td>1 <span class="muted">\(9\.1%\)<\/span><\/td><td>5\.0 s<\/td><td>9\.0 s<\/td>/);
  });

  it("shows the red banner at 80% of the credit", async () => {
    const { service, token, adminToken } = await member({ LUMINAL_CREDIT_USD: "0.2" });
    service.setLuminal(() => completion(luminalUsage(BIG.prompt, BIG.completion, BIG.cached)));
    await chat(service, token);
    const html = await (await service.request("GET", "/admin?view=full", { token: adminToken })).text();
    assert.match(html, /class="banner"[^>]*>[^<]*of the \$0\.200 Luminal credit used/);
  });
});

describe("Luminal units", () => {
  it("finds content in text, reasoning and tool-call deltas only", () => {
    assert.equal(hasContent({ choices: [{ delta: { content: "a" } }] }), true);
    assert.equal(hasContent({ choices: [{ delta: { reasoning_content: "x" } }] }), true);
    assert.equal(hasContent({ choices: [{ delta: { tool_calls: [{ index: 0 }] } }] }), true);
    assert.equal(hasContent({ choices: [{ delta: { role: "assistant", content: "" } }] }), false);
    assert.equal(hasContent({ choices: [], usage: {} }), false);
  });

  it("words the credit alerts", () => {
    assert.equal(creditAlert(1000, 2000, 0.5).text, "dl free tier: $1,000 of the $2,000 Luminal credit used (50%).");
    assert.match(creditAlert(2000, 2000, 1).text, /paused until the credit is topped up/);
    assert.deepEqual(crossed(0.85, new Set([0.5])), { threshold: 0.8, mark: [0.8] });
  });
});
