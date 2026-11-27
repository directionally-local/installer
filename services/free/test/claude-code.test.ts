import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, allowServerKeys, completion, createService, luminalUsage, MODEL, NOW, sse, type Service } from "./harness.js";

/**
 * Claude Code through `dl claude`: a short-lived harness key minted by a signed-in dl, and the
 * Anthropic Messages endpoint at /anthropic/v1/messages, served by DeepSeek through the same
 * reservation, caps, trial and refusals as Autopilot's chat requests, on the same allowance by default.
 */

const MINUTE = 60_000;
const SECRET = "whsec_test_0123456789abcdef";
const BILLING = { STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_PRICE_TOPUP: "price_topup123" };

/** A paid Pro subscription, through Stripe's webhook (as billing tests do). */
async function goPro(service: Service, githubId: number): Promise<void> {
  const { signatureHeader } = await import("../src/stripe.js");
  const session = {
    id: `cs_pro_${githubId}`,
    object: "checkout.session",
    mode: "subscription",
    client_reference_id: String(githubId),
    customer: `cus_${githubId}`,
    subscription: `sub_${githubId}`,
    payment_status: "paid",
    amount_subtotal: 399,
    amount_total: 399,
    metadata: { github_id: String(githubId), product: "pro" },
  };
  const body = JSON.stringify({ id: `evt_pro_${githubId}`, object: "event", type: "checkout.session.completed", created: Math.floor(service.clock.now / 1000), data: { object: session } });
  const header = await signatureHeader(SECRET, Math.floor(service.clock.now / 1000), body);
  assert.equal((await service.request("POST", "/v1/billing/webhook", { body, headers: { "stripe-signature": header } })).status, 200);
}
const LUMINAL = { LUMINAL_API_KEY: "lum-test" };

async function world(vars: Record<string, string> = {}) {
  const service = await createService({ OPEN_ADMISSION: "true", ...LUMINAL, ...vars });
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const tokens = await service.signIn({ id: 100, login: "alice" });
  return { service, admin, token: tokens.access_token, refreshToken: tokens.refresh_token };
}

async function mint(service: Service, token: string, harness = "claude-code"): Promise<{ id: string; key: string; expiresAt: string; ttlSeconds: number; otherHarnessShare: number }> {
  const response = await service.request("POST", "/v1/harness-keys", { token, body: { harness } });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()) as never;
}

const ask = { model: "claude-sonnet-4-5", max_tokens: 1024, messages: [{ role: "user", content: "hello" }] };

/** What Claude Code sends: x-api-key or a bearer, and `?beta=true`. */
const messages = (service: Service, key: string, body: Record<string, unknown> = {}, as: "bearer" | "x-api-key" = "bearer") =>
  service.request("POST", "/anthropic/v1/messages?beta=true", {
    ...(as === "bearer" ? { token: key } : { headers: { "x-api-key": key } }),
    headers: { "anthropic-version": "2023-06-01", "anthropic-beta": "claude-code-20250219", ...(as === "x-api-key" ? { "x-api-key": key } : {}) },
    body: { ...ask, ...body },
  });

async function anthropicError(response: Response): Promise<{ type: string; message: string; code?: string }> {
  const body = (await response.json()) as { type: string; error: { type: string; message: string; code?: string } };
  assert.equal(body.type, "error");
  return body.error;
}

/** The same refusal on the endpoint dl and Autopilot use: still our 403, code and message. */
async function chatError(service: Service, token: string): Promise<{ status: number; code: string; message: string }> {
  const response = await service.request("POST", "/v1/chat/completions", { token, body: { model: MODEL, messages: [{ role: "user", content: "hello" }] } });
  const body = (await response.json()) as { error: { code: string; message: string } };
  return { status: response.status, code: body.error.code, message: body.error.message };
}

let eventId = 0;
const sessionEvent = (service: Service, key: string, type = "session.start") =>
  service.request("POST", "/v1/events", { token: key, body: { events: [{ id: `cc${++eventId}`, type, sessionId: "dl-claude-1", at: new Date(service.clock.now).toISOString(), props: { harness: "something-else" } }] } });

describe("harness keys", () => {
  it("are minted from a signed-in access token only, for a known harness", async () => {
    const { service, admin, token } = await world();
    const minted = await mint(service, token);
    assert.match(minted.key, /^dlh_100_[a-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
    assert.equal(minted.ttlSeconds, 900);
    // The agent's part of the allowance: all of it by default, the same as Autopilot.
    assert.equal(minted.otherHarnessShare, 1);
    assert.equal(((await (await service.request("GET", "/v1/me", { token })).json()) as { otherHarnessShare: number }).otherHarnessShare, 1);
    assert.equal(minted.expiresAt, new Date(NOW + 15 * MINUTE).toISOString());
    assert.equal((await service.request("POST", "/v1/harness-keys", { token, body: { harness: "cursor" } })).status, 400);
    // Not from a harness key or a server key.
    assert.equal((await service.request("POST", "/v1/harness-keys", { token: minted.key, body: { harness: "claude-code" } })).status, 401);
    allowServerKeys(service, ADMIN_ID);
    const serverKey = ((await (await service.request("POST", "/v1/keys", { token: admin, body: { name: "box" } })).json()) as { key: string }).key;
    assert.equal((await service.request("POST", "/v1/harness-keys", { token: serverKey, body: { harness: "claude-code" } })).status, 401);
  });

  it("work only on the Anthropic endpoint and events, never on chat completions or /v1/me", async () => {
    const { service, token } = await world();
    const { key } = await mint(service, token);
    const chat = await service.request("POST", "/v1/chat/completions", { token: key, body: { model: "gpt-6-luna", messages: [{ role: "user", content: "x" }] } });
    assert.equal(chat.status, 401);
    assert.equal((await service.request("GET", "/v1/me", { token: key })).status, 401);
    assert.equal((await messages(service, key)).status, 200);
  });

  it("expire 15 minutes after they were made or refreshed, refresh themselves, and end when revoked", async () => {
    const { service, token } = await world();
    const { id, key } = await mint(service, token);
    service.clock.now += 14 * MINUTE;
    const refreshed = await service.request("POST", `/v1/harness-keys/${id}/refresh`, { token: key });
    assert.equal(refreshed.status, 200);
    service.clock.now += 14 * MINUTE;
    assert.equal((await messages(service, key)).status, 200, "still alive after the refresh");
    service.clock.now += 16 * MINUTE;
    const expired = await messages(service, key);
    assert.equal(expired.status, 401);
    const error = await anthropicError(expired);
    assert.equal(error.type, "authentication_error");
    assert.equal(error.code, "invalid_harness_key");
    assert.match(error.message, /run dl claude again/);
    assert.equal((await service.request("POST", `/v1/harness-keys/${id}/refresh`, { token: key })).status, 401);

    service.clock.now = NOW + 2 * MINUTE;
    const fresh = await service.signIn({ id: 100, login: "alice" }, {});
    const second = await mint(service, fresh.access_token);
    const other = await mint(service, fresh.access_token);
    // A key manages only itself.
    assert.equal((await service.request("DELETE", `/v1/harness-keys/${other.id}`, { token: second.key })).status, 403);
    assert.equal((await service.request("DELETE", `/v1/harness-keys/${second.id}`, { token: second.key })).status, 200);
    assert.equal((await messages(service, second.key)).status, 401);
  });

  it("end with the sign-in they were minted from", async () => {
    const { service, token, refreshToken } = await world();
    const { key } = await mint(service, token);
    const out = await service.request("POST", "/v1/token/revoke", { token, body: { refresh_token: refreshToken } });
    assert.equal(out.status, 200);
    assert.equal((await messages(service, key)).status, 401);
  });

  it("are refused while the kill switch is off, and so are requests with a key minted before", async () => {
    const { service, admin, token } = await world();
    const { key } = await mint(service, token);
    const off = await service.request("POST", "/admin/config", { token: admin, body: { allowOtherHarnesses: false } });
    assert.equal(off.status, 200, await off.clone().text());
    const refused = await messages(service, key);
    assert.equal(refused.status, 402);
    const error = await anthropicError(refused);
    assert.deepEqual([error.type, error.code], ["billing_error", "harness_not_allowed"]);
    assert.match(error.message, /Free tokens in Claude Code are switched off/);
    assert.equal(service.calls.luminal.length, 0, "nothing goes upstream");
    const mintRefused = await service.request("POST", "/v1/harness-keys", { token, body: { harness: "claude-code" } });
    assert.equal(mintRefused.status, 403);
    // Autopilot is unaffected.
    assert.equal((await service.request("POST", "/v1/chat/completions", { token, body: { model: MODEL, messages: [{ role: "user", content: "x" }] } })).status, 200);
  });
});

describe("POST /anthropic/v1/messages", () => {
  it("answers a non-streaming request as an Anthropic message, served by DeepSeek whatever model was named", async () => {
    const { service, token } = await world();
    const { key } = await mint(service, token);
    service.setLuminal(() => Response.json({ id: "c1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "Hi there" }, finish_reason: "stop" }], usage: luminalUsage(120, 4, 100) }));
    for (const as of ["bearer", "x-api-key"] as const) {
      const response = await messages(service, key, { model: "claude-opus-4-5", system: "Be brief.", thinking: { type: "enabled", budget_tokens: 2000 } }, as);
      assert.equal(response.status, 200, await response.clone().text());
      assert.ok(response.headers.get("x-dl-quota-resets-at"));
      const body = (await response.json()) as Record<string, any>;
      assert.equal(body.type, "message");
      assert.equal(body.model, MODEL, "the model that answered, not the claude-* name asked for");
      assert.equal(response.headers.get("x-dl-served-model"), MODEL);
      assert.deepEqual(body.content, [{ type: "text", text: "Hi there" }]);
      assert.equal(body.stop_reason, "end_turn");
      assert.deepEqual(body.usage, { input_tokens: 20, output_tokens: 4, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 });
    }
    const sent = service.calls.luminal.at(-1)!.body;
    assert.equal(sent.model, "deepseek-ai/DeepSeek-V4.1-Flash-1017");
    assert.deepEqual(sent.messages, [{ role: "system", content: "Be brief." }, { role: "user", content: "hello" }]);
    assert.ok(!("thinking" in sent));
    // Recorded as Claude Code's, counts only.
    const rows = service.directory().ctx.storage.sql.exec("SELECT harness, model, via_key FROM requests WHERE github_id = 100").toArray().map((row: object) => ({ ...row }));
    assert.deepEqual(rows, [
      { harness: "claude-code", model: MODEL, via_key: 0 },
      { harness: "claude-code", model: MODEL, via_key: 0 },
    ]);
  });

  it("streams Anthropic's event sequence, tool calls included, and settles the usage", async () => {
    const { service, token } = await world();
    const { key } = await mint(service, token);
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) => JSON.stringify({ id: "c1", choices: [{ index: 0, delta, finish_reason: finish }] });
    service.setLuminal((body) => {
      assert.equal(body.stream, true);
      return sse(
        [
          chunk({ role: "assistant", content: "Reading" }),
          chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "Read", arguments: '{"file_' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: 'path":"a.ts"}' } }] }),
          chunk({}, "tool_calls"),
          JSON.stringify({ id: "c1", choices: [], usage: luminalUsage(300, 25, 200) }),
        ],
        { split: true },
      );
    });
    const response = await messages(service, key, {
      stream: true,
      tools: [{ name: "Read", description: "Read a file", input_schema: { type: "object", properties: { file_path: { type: "string" } } } }],
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await response.text();
    const names = [...text.matchAll(/^event: (.+)$/gm)].map((match) => match[1]);
    assert.deepEqual(names, [
      "message_start",
      "ping",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    assert.match(text, /"stop_reason":"tool_use"/);
    assert.match(text, /"output_tokens":25/);
    // message_start names the model that answered, not the claude-* name asked for.
    const start = JSON.parse(/^event: message_start\ndata: (.+)$/m.exec(text)![1]!) as { message: { model: string } };
    assert.equal(start.message.model, MODEL);
    assert.equal(response.headers.get("x-dl-served-model"), MODEL);
    const sent = service.calls.luminal.at(-1)!.body;
    assert.deepEqual(sent.tools, [{ type: "function", function: { name: "Read", description: "Read a file", parameters: { type: "object", properties: { file_path: { type: "string" } } } } }]);
    // Settled: DeepSeek's week counts the tokens.
    const me = (await (await service.request("GET", "/v1/me", { token })).json()) as { budgets: { deepseek: { tokensThisWeek: number } } };
    assert.equal(me.budgets.deepseek.tokensThisWeek, 325);
  });

  it("sends a whole answer as a stream when the upstream didn't stream", async () => {
    const { service, token } = await world();
    const { key } = await mint(service, token);
    service.setLuminal(() => completion(luminalUsage(10, 1)));
    const text = await (await messages(service, key, { stream: true })).text();
    assert.deepEqual([...text.matchAll(/^event: (.+)$/gm)].map((match) => match[1]), ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
  });

  it("estimates count_tokens without going upstream or charging anything", async () => {
    const { service, token } = await world();
    const { key } = await mint(service, token);
    const response = await service.request("POST", "/anthropic/v1/messages/count_tokens?beta=true", { headers: { "x-api-key": key }, body: { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "x".repeat(400) }] } });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { input_tokens: number };
    assert.ok(body.input_tokens > 100 && body.input_tokens < 140, String(body.input_tokens));
    assert.equal(service.calls.luminal.length, 0);
  });

  it("answers other paths, a missing key and a bad body in Anthropic's error shape", async () => {
    const { service, token } = await world();
    const { key } = await mint(service, token);
    const other = await service.request("GET", "/anthropic/v1/models", { token: key });
    assert.equal(other.status, 404);
    assert.equal((await anthropicError(other)).type, "not_found_error");
    const anonymous = await service.request("POST", "/anthropic/v1/messages", { body: ask });
    assert.equal(anonymous.status, 401);
    assert.equal((await anthropicError(anonymous)).type, "authentication_error");
    // A sign-in token isn't a harness key: Claude Code gets free tokens only through dl claude.
    const signedIn = await messages(service, token);
    assert.equal(signedIn.status, 401);
    const bad = await messages(service, key, { messages: [] });
    assert.equal(bad.status, 400);
    assert.equal((await anthropicError(bad)).type, "invalid_request_error");
  });
});

describe("Claude Code's share of the allowance", () => {
  it("stops Claude Code at otherHarnessShare of the week when it is set below 1", async () => {
    const { service, token } = await world({ DEEPSEEK_WEEKLY_USD_CAP: "1", OTHER_HARNESS_SHARE: "0.5" });
    const { key } = await mint(service, token);
    // 10M uncached prompt tokens at $0.035/M: $0.35 a request.
    service.setLuminal(() => completion(luminalUsage(10_000_000, 0)));
    assert.equal((await messages(service, key)).status, 200);
    assert.equal((await messages(service, key)).status, 200);
    const refused = await messages(service, key);
    assert.equal(refused.status, 402);
    const error = await anthropicError(refused);
    assert.deepEqual([error.type, error.code], ["billing_error", "harness_limit"]);
    assert.match(error.message, /Claude Code through dl gets half of your free allowance, and that part is used up\. It resets at 2026-11-09T00:00:00\.000Z\./);
    assert.doesNotMatch(error.message, /Autopilot/, "no push towards another agent");
    // The rest of the week's DeepSeek budget is still there.
    assert.equal((await service.request("POST", "/v1/chat/completions", { token, body: { model: MODEL, messages: [{ role: "user", content: "x" }] } })).status, 200);
    // Past the whole budget, the usual refusal, worded for Claude Code.
    const spent = await messages(service, key);
    const whole = await anthropicError(spent);
    assert.equal(whole.code, "quota_exceeded");
  });

  it("exempts Pro: a subscriber gets the whole Pro allowance in Claude Code", async () => {
    const { service, token } = await world({ ...BILLING, DEEPSEEK_WEEKLY_USD_CAP: "0.25", PRO_OPEN_MODELS_MULTIPLIER: "4" });
    await goPro(service, 100);
    const { key } = await mint(service, token);
    service.setLuminal(() => completion(luminalUsage(10_000_000, 0)));
    // $0.35 a request against Pro's $1 (4 x the free $0.25): past half of it, still served.
    assert.deepEqual([(await messages(service, key)).status, (await messages(service, key)).status, (await messages(service, key)).status], [200, 200, 200]);
    const me = (await (await service.request("GET", "/v1/me", { token })).json()) as { plan: string };
    assert.equal(me.plan, "pro");
    // Past the whole Pro allowance, Pro's usual refusal, not harness_limit.
    const spent = await messages(service, key);
    assert.equal((await anthropicError(spent)).code, "quota_exceeded");
  });

  it("gives Claude Code the whole allowance by default (otherHarnessShare 1)", async () => {
    const { service, token } = await world({ DEEPSEEK_WEEKLY_USD_CAP: "1" });
    const { key, otherHarnessShare } = await mint(service, token);
    assert.equal(otherHarnessShare, 1);
    service.setLuminal(() => completion(luminalUsage(10_000_000, 0)));
    assert.deepEqual([(await messages(service, key)).status, (await messages(service, key)).status, (await messages(service, key)).status], [200, 200, 200]);
  });

  it("scales the trial too, and refuses with trial_ended (pointing at dl's /upgrade) once the whole trial is used", async () => {
    const service = await createService({ OPEN_ADMISSION: "true", OTHER_HARNESS_SHARE: "0.5", ...LUMINAL });
    const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { trialCutoff: new Date(NOW + MINUTE).toISOString() } })).status, 200);
    service.clock.now = NOW + 2 * MINUTE;
    const token = (await service.signIn({ id: 200, login: "bob" })).access_token;
    const { key } = await mint(service, token);
    // 3M tokens a request, against a 10M trial: Claude Code may use 5M of it.
    service.setLuminal(() => completion(luminalUsage(3_000_000, 0)));
    assert.equal((await messages(service, key)).status, 200);
    assert.equal((await messages(service, key)).status, 200);
    const share = await messages(service, key);
    assert.equal(share.status, 402);
    assert.equal((await anthropicError(share)).code, "harness_limit");
    const chat = () => service.request("POST", "/v1/chat/completions", { token, body: { model: MODEL, messages: [{ role: "user", content: "x" }] } });
    assert.equal((await chat()).status, 200);
    assert.equal((await chat()).status, 200);
    const ended = await messages(service, key);
    assert.equal(ended.status, 402);
    const error = await anthropicError(ended);
    assert.deepEqual([error.type, error.code], ["billing_error", "trial_ended"]);
    assert.match(error.message, /Keep going with dl Pro for \$7 a month, or add a top-up: run dl and type \/upgrade$/);
  });
});

describe("rate limits and refusals on /anthropic", () => {
  it("answers a short rate limit as 429 rate_limit_error with Retry-After, so Claude Code retries", async () => {
    const { service, token } = await world();
    const { key } = await mint(service, token);
    // Empty the person's per-minute bucket (apiPerson: 60 a minute) before the request.
    const limiter = (
      service.namespaces.RATE_LIMITER as {
        getByName(name: string): { spend(key: string, limit: { capacity: number; perHour: number }, cost: number, now: number): Promise<{ allowed: boolean }> };
      }
    ).getByName("api:gh:100");
    const limit = { capacity: 60, perHour: 3600 };
    while ((await limiter.spend("api:gh:100", limit, 1, service.clock.now)).allowed) {
      // Spend until the bucket is empty.
    }
    const refused = await messages(service, key);
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get("retry-after"), "1");
    const error = await anthropicError(refused);
    assert.deepEqual([error.type, error.code], ["rate_limit_error", "rate_limited"]);
    assert.match(error.message, /^Too many requests\. Try again in 1 seconds\.$/);
    assert.equal(service.calls.luminal.length, 0, "nothing goes upstream");
  });

  it("answers a used-up allowance as 402 billing_error with our message, not a 403 login problem", async () => {
    const { service, token } = await world({ DEEPSEEK_WEEKLY_USD_CAP: "1" });
    const { key } = await mint(service, token);
    // 10M uncached prompt tokens at $0.035/M: $0.35 a request, against a $1 week.
    service.setLuminal(() => completion(luminalUsage(10_000_000, 0)));
    for (let index = 0; index < 3; index++) assert.equal((await messages(service, key)).status, 200);
    const refused = await messages(service, key);
    assert.equal(refused.status, 402);
    const error = await anthropicError(refused);
    assert.deepEqual([error.type, error.code], ["billing_error", "quota_exceeded"]);
    assert.match(error.message, /used up|dl Pro/);
    assert.doesNotMatch(error.message, /authenticate|log ?in/i);
  });

  it("answers a pause for everyone as 402 billing_error, not a 403 login problem", async () => {
    const { service, token } = await world();
    const { key } = await mint(service, token);
    service.env.PAUSED = "true";
    const refused = await messages(service, key);
    assert.equal(refused.status, 402);
    const error = await anthropicError(refused);
    assert.deepEqual([error.type, error.code], ["billing_error", "service_paused"]);
    assert.match(error.message, /paused/);
  });
});

describe("Claude Code and the dl-only check", () => {
  it("counts its requests like Autopilot's: dl's session events cover them, and none means dl_only after 20 (dlOnly on)", async () => {
    const { service, token } = await world({ DL_ONLY: "true" });
    const { key } = await mint(service, token);
    for (let index = 0; index < 20; index++) {
      assert.equal((await messages(service, key)).status, 200);
      service.clock.now += 1000;
    }
    const refused = await messages(service, key);
    assert.equal(refused.status, 402);
    const dlOnly = await anthropicError(refused);
    assert.deepEqual([dlOnly.type, dlOnly.code], ["billing_error", "dl_only"]);
    assert.match(dlOnly.message, /run dl claude again/);
    const sent = await sessionEvent(service, key);
    assert.equal(sent.status, 202);
    assert.equal((await messages(service, key)).status, 200);
    const stored = service.directory().ctx.storage.sql.exec("SELECT props FROM events WHERE github_id = 100").toArray() as Array<{ props: string }>;
    assert.deepEqual(JSON.parse(stored[0]!.props), { harness: "claude-code" }, "the key's harness, whatever the body said");
  });

  it("shows Claude Code's requests and tokens this week on the admin people list", async () => {
    const { service, admin, token } = await world();
    const { key } = await mint(service, token);
    service.setLuminal(() => completion(luminalUsage(100, 10)));
    await messages(service, key);
    await messages(service, key);
    const people = (await (await service.request("GET", "/admin/people", { token: admin })).json()) as { people: Array<{ githubId: number; otherHarnessThisWeek: { requests: number; tokens: number } }> };
    const alice = people.people.find((person) => person.githubId === 100)!;
    assert.deepEqual(alice.otherHarnessThisWeek, { requests: 2, tokens: 220 });
  });
});

describe("final refusals on /anthropic are 402 billing_error", () => {
  it("harness_not_allowed: the kill switch", async () => {
    const { service, admin, token } = await world();
    const { key } = await mint(service, token);
    const opencode = await mint(service, token, "opencode");
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { allowOtherHarnesses: false } })).status, 200);
    const refused = await messages(service, key);
    assert.equal(refused.status, 402);
    const error = await anthropicError(refused);
    assert.deepEqual([error.type, error.code], ["billing_error", "harness_not_allowed"]);
    assert.match(error.message, /Free tokens in Claude Code are switched off for now/);
    assert.doesNotMatch(error.message, /authenticate|log ?in/i);
    assert.equal(service.calls.luminal.length, 0, "nothing goes upstream");
    // dl's own endpoints keep the 403 and the code they parse.
    const other = await chatError(service, opencode.key);
    assert.equal(other.status, 403);
    assert.equal(other.code, "harness_not_allowed");
    assert.match(other.message, /Free tokens in OpenCode are switched off for now/);
  });

  it("dl_only: free tokens outside dl", async () => {
    const { service, token } = await world({ DL_ONLY: "true" });
    const { key } = await mint(service, token);
    for (let index = 0; index < 20; index++) {
      assert.equal((await messages(service, key)).status, 200);
      service.clock.now += 1000;
    }
    const refused = await messages(service, key);
    assert.equal(refused.status, 402);
    const error = await anthropicError(refused);
    assert.deepEqual([error.type, error.code], ["billing_error", "dl_only"]);
    assert.match(error.message, /Free tokens in Claude Code work only while it runs from dl claude\. Quit Claude Code and run dl claude again/);
    assert.doesNotMatch(error.message, /authenticate|log ?in/i);
    const other = await chatError(service, token);
    assert.equal(other.status, 403);
    assert.equal(other.code, "dl_only");
  });

  it("below_bar: an account below the bar with no free tokens", async () => {
    const service = await createService({
      OPEN_ADMISSION: "true",
      ...LUMINAL,
      STARTER_WEEKLY_TOKENS: "0",
      FULL_MIN_ACCOUNT_AGE_DAYS: "365",
      FULL_MIN_CONTRIBUTIONS: "100",
      FULL_MIN_PUBLIC_REPOS: "100000",
      NETWORK_SIGNUPS_PER_DAY: "1000",
      DOMAIN_SIGNUPS_PER_DAY: "1000",
    });
    const { access_token: token } = await service.signIn({ id: 100, login: "alice", createdAt: "2026-06-01T00:00:00Z", publicRepos: 0, contributions: 10 });
    const { key } = await mint(service, token);
    const refused = await messages(service, key);
    assert.equal(refused.status, 402);
    const error = await anthropicError(refused);
    assert.deepEqual([error.type, error.code], ["billing_error", "below_bar"]);
    assert.match(error.message, /^Free tokens are for established GitHub accounts:/);
    assert.doesNotMatch(error.message, /authenticate|log ?in/i);
    assert.equal(service.calls.luminal.length, 0, "nothing goes upstream");
    const other = await chatError(service, token);
    assert.equal(other.status, 403);
    assert.equal(other.code, "below_bar");
  });

  it("blocked: an account an admin blocked", async () => {
    const { service, admin, token } = await world();
    const { key } = await mint(service, token);
    assert.equal((await service.request("POST", "/admin/people/100/block", { token: admin })).status, 200);
    const refused = await messages(service, key);
    assert.equal(refused.status, 402);
    const error = await anthropicError(refused);
    assert.deepEqual([error.type, error.code], ["billing_error", "blocked"]);
    assert.equal(error.message, "This account is blocked from the free tier. Contact contact@directionallylocal.com.");
    const other = await chatError(service, token);
    assert.equal(other.status, 403);
    assert.equal(other.code, "blocked");
    assert.equal(other.message, "This account is blocked from the free tier. Contact contact@directionallylocal.com.");
  });
});
