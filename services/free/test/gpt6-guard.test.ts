import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ADMIN_ID, completion, createService, luminalUsage, MODEL, usage, type OpenRouterHandler, type Service } from "./harness.js";
import { GUARD_INPUT_CHARS, guardInput, newContentTexts, safeguardVerdict, SAFEGUARD_MODEL, MODERATION_MODEL } from "../src/presend-guard.js";
import { toChatRequest } from "../src/anthropic.js";
import { toResponsesRequest } from "../src/openai-responses.js";
import { trustOf, TRUST_MIN_SPREAD_MS, type TrustFacts } from "../src/gpt6-trust.js";
import { DEFAULT_DETECTION_RULES, parseDetectionRules } from "../src/detection-rules.js";

/**
 * GPT-6's pre-send checks (presend-guard.ts) and trust gate (gpt6-trust.ts), for every agent that
 * reaches the free tier: Autopilot (chat completions and session events), OpenCode through
 * `dl opencode` (a harness key, chat completions, no session events), Claude Code through
 * `dl claude` (Anthropic Messages, translated) and the Responses shape the OpenAI upstream gets.
 */

const MINUTE = 60_000;
const DAY = 86_400_000;
const LUNA = "gpt-6-luna";
const KEYS = { OPENAI_API_KEY: "sk-openai-test", LUMINAL_API_KEY: "lum-test" };

const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;
const AUTOPILOT = fixture("autopilot-chat.json");
const OPENCODE = fixture("opencode-chat.json");
const ANTHROPIC = fixture("anthropic-messages.json");
const RESPONSES = fixture("responses-input.json");

const NEVER_SENT = ["OLD-USER", "OLD-TOOL", "SYSTEM-PROMPT"];

/** What the checkers answer in a world: "0"/"1" or an HTTP failure or a hang, per checker. */
interface Answers {
  openai: "pass" | "flag" | "error" | "hang";
  safeguard: "0" | "1" | "error" | "hang" | "junk";
}

async function world(vars: Record<string, string> = {}) {
  const service = await createService({ OPEN_ADMISSION: "true", DL_ONLY: "false", ...KEYS, GPT6_PRESEND_GUARD: "enforce", GPT6_GUARD_TIMEOUT_MS: "200", ...vars });
  const answers: Answers = { openai: "pass", safeguard: "0" };
  const hang = () => new Promise<Response>(() => undefined);
  service.setModerations(() => {
    if (answers.openai === "hang") return hang();
    if (answers.openai === "error") return new Response("down", { status: 500 });
    return Response.json({ id: "modr", model: MODERATION_MODEL, results: [{ flagged: answers.openai === "flag", categories: {}, category_scores: {} }] });
  });
  const openRouter: OpenRouterHandler = (body) => {
    if (body.model !== SAFEGUARD_MODEL) return completion(usage(100, 10));
    if (answers.safeguard === "hang") return hang();
    if (answers.safeguard === "error") return new Response("down", { status: 502 });
    const content = answers.safeguard === "junk" ? "I think this is fine" : answers.safeguard;
    return Response.json({ id: "sg", object: "chat.completion", model: SAFEGUARD_MODEL, choices: [{ index: 0, message: { role: "assistant", content } }], usage: usage(900, 30, 0, 0.0002) });
  };
  service.setOpenRouter(openRouter);
  service.setLuminal(() => completion(luminalUsage(100, 10)));
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const token = (await service.signIn({ id: 100, login: "alice" })).access_token;
  return { service, admin, token, answers };
}

let ips = 0;
const chat = (service: Service, token: string, body: Record<string, unknown>, session?: string) =>
  service.request("POST", "/v1/chat/completions", { token, body, ip: `10.9.${Math.floor(++ips / 250) % 250}.${ips % 250}`, headers: session ? { "x-session-id": session } : {} });

const simple = (text: string, model = LUNA) => ({ model, messages: [{ role: "system", content: "SYSTEM-PROMPT" }, { role: "user", content: text }] });

async function errorOf(response: Response): Promise<Record<string, unknown>> {
  return ((await response.json()) as { error: Record<string, unknown> }).error;
}

const safeguardCalls = (service: Service) => service.calls.openRouter.filter((call) => call.body.model === SAFEGUARD_MODEL);
const sentToCheckers = (service: Service): string[] => [
  ...service.calls.moderations.map((call) => String(call.body.input)),
  ...safeguardCalls(service).map((call) => String((call.body.messages as Array<{ content: string }>)[1]!.content)),
];
const sql = (service: Service, query: string, ...args: unknown[]) => service.directory().ctx.storage.sql.exec(query, ...args).toArray().map((row: object) => ({ ...row }));

async function mintOpenCode(service: Service, token: string): Promise<string> {
  const response = await service.request("POST", "/v1/harness-keys", { token, body: { harness: "opencode" } });
  assert.equal(response.status, 201, await response.clone().text());
  return ((await response.json()) as { key: string }).key;
}

/** Moves the clock on and signs alice in again (access tokens are short-lived). */
async function later(service: Service, ms: number): Promise<string> {
  service.clock.now += ms;
  return (await service.signIn({ id: 100, login: "alice" })).access_token;
}

let eventId = 0;
async function turns(service: Service, token: string, session: string, count: number): Promise<void> {
  const events = Array.from({ length: count }, () => ({ id: `t${++eventId}`, type: "turn.end", sessionId: session, at: new Date(service.clock.now).toISOString(), props: {} }));
  const response = await service.request("POST", "/v1/events", { token, body: { events } });
  assert.equal(response.status, 202, await response.clone().text());
}

describe("pre-send checks: what is new in each client's request", () => {
  const expected = {
    autopilot: ["NEW-USER now refactor the tokenizer in src/parser.ts into its own module", "NEW-TOOL export function tokenize(input: string) { return input.split(/\\s+/); }"],
  };

  it("Autopilot (chat completions): the latest user message and the tool results after the last assistant turn", () => {
    assert.deepEqual(newContentTexts(AUTOPILOT), expected.autopilot);
  });

  it("OpenCode (chat completions with text parts, several tool results)", () => {
    const texts = newContentTexts(OPENCODE);
    assert.deepEqual(texts.map((text) => text.split(" ")[0]), ["NEW-USER", "NEW-USER-2", "NEW-TOOL", "NEW-TOOL-2"]);
  });

  it("Claude Code (Anthropic Messages): tool_result blocks count as tool output, read the same raw and once translated", () => {
    const raw = newContentTexts(ANTHROPIC);
    assert.deepEqual(raw.map((text) => text.split(" ")[0]), ["<system-reminder>Context.</system-reminder>", "NEW-USER", "NEW-TOOL", "NEW-TOOL-2"]);
    const translated = toChatRequest(ANTHROPIC, { model: MODEL, vision: false });
    assert.ok(translated.ok);
    const text = guardInput(translated.body);
    for (const part of ["NEW-USER fix the flag parsing bug", "NEW-TOOL const flags", "NEW-TOOL-2 cli.ts"]) assert.ok(text.includes(part), part);
    for (const old of NEVER_SENT) assert.ok(!text.includes(old), old);
  });

  it("Responses input items: function_call_output after the last function call or assistant message", () => {
    assert.deepEqual(newContentTexts(RESPONSES), ["NEW-USER make the build output smaller", "NEW-TOOL 12M\tdist"]);
  });

  it("what OpenAI is sent (the Responses translation) holds no new content the checkers didn't see", () => {
    for (const body of [AUTOPILOT, OPENCODE]) {
      const payload = toResponsesRequest(body, { model: "gpt-6-luna", maxTokens: 1000, user: "dl-x", stream: true });
      assert.equal(guardInput(payload), guardInput(body));
    }
  });

  it("never includes system, developer or older content, and caps long content head and tail", () => {
    for (const body of [AUTOPILOT, OPENCODE, ANTHROPIC, RESPONSES]) {
      const text = guardInput(body);
      for (const old of NEVER_SENT) assert.ok(!text.includes(old), `${old} left out`);
    }
    const long = `HEAD ${"x".repeat(50_000)} TAIL`;
    const text = guardInput({ messages: [{ role: "user", content: long }] });
    assert.ok(text.length <= GUARD_INPUT_CHARS + 1);
    assert.ok(text.startsWith("HEAD") && text.endsWith("TAIL"), "both ends are read");
  });

  it("reads only 1 or 0 from the safeguard", () => {
    assert.deepEqual(safeguardVerdict("1"), { verdict: "flag" });
    assert.deepEqual(safeguardVerdict(" 0\n"), { verdict: "pass" });
    assert.equal(safeguardVerdict("maybe 1").verdict, "error");
    assert.equal(safeguardVerdict(undefined).verdict, "error");
  });

  it("takes guardPolicy from DETECTION_RULES, with a generic default", () => {
    const { rules, status } = parseDetectionRules(JSON.stringify({ guardPolicy: "SYNTHETIC GUARD POLICY" }));
    assert.equal(rules.guardPolicy, "SYNTHETIC GUARD POLICY");
    assert.equal(status.guardPolicy, "secret");
    assert.ok(DEFAULT_DETECTION_RULES.guardPolicy.includes("1 or 0"));
    assert.equal(parseDetectionRules(JSON.stringify({ guardPolicy: "" })).status.source, "invalid");
  });
});

describe("pre-send checks on GPT-6 requests", () => {
  it("a clean Autopilot request passes both checks and is forwarded; only the new content is checked", async () => {
    const { service, token } = await world({ DETECTION_RULES: JSON.stringify({ guardPolicy: "SYNTHETIC GUARD POLICY" }) });
    const response = await chat(service, token, AUTOPILOT, "s-1");
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(service.calls.openai.length, 1, "sent to OpenAI");
    assert.equal(service.calls.moderations.length, 1);
    assert.equal(service.calls.moderations[0]!.body.model, "omni-moderation-latest");
    assert.equal(service.calls.moderations[0]!.headers.authorization, "Bearer sk-openai-test");
    const [safeguard] = safeguardCalls(service);
    assert.ok(safeguard);
    assert.deepEqual(safeguard.body.reasoning, { effort: "low" });
    assert.equal(safeguard.body.max_tokens, 400);
    assert.equal(safeguard.body.temperature, 0);
    assert.equal((safeguard.body.messages as Array<{ role: string; content: string }>)[0]!.content, "SYNTHETIC GUARD POLICY");
    for (const sent of sentToCheckers(service)) {
      assert.ok(sent.includes("NEW-USER") && sent.includes("NEW-TOOL"));
      for (const old of NEVER_SENT) assert.ok(!sent.includes(old), `${old} never sent to a checker`);
    }
    await service.settle();
    assert.deepEqual(sql(service, "SELECT outcome, n FROM gpt6_guard_daily"), [{ outcome: "passed", n: 1 }]);
    const spend = sql(service, "SELECT internal_requests, internal_tokens, internal_usd FROM spend_weeks")[0] as { internal_requests: number; internal_tokens: number; internal_usd: number };
    assert.equal(spend.internal_tokens, 930, "the safeguard's tokens go to internal accounting");
    assert.ok(Math.abs(spend.internal_usd - 0.0002) < 1e-9);
  });

  it("an OpenAI Moderation flag stops the request before OpenAI, holds the session for the day and records a high label", async () => {
    const { service, token, answers } = await world({ MODERATION: "shadow" });
    answers.openai = "flag";
    const response = await chat(service, token, AUTOPILOT, "s-1");
    assert.equal(response.status, 402);
    const error = await errorOf(response);
    assert.equal(error.code, "gpt_limit");
    assert.equal(error.alternative, MODEL);
    assert.equal(error.reason, "security");
    assert.equal(service.calls.openai.length, 0, "never sent to OpenAI");
    await service.settle();
    assert.deepEqual(sql(service, "SELECT risk, model, session_id FROM use_descriptions"), [{ risk: "high", model: "presend:openai", session_id: "s-1" }]);
    assert.equal(sql(service, "SELECT * FROM moderation_decisions").length, 1, "the moderation reviewer looked at it");
    assert.deepEqual(sql(service, "SELECT outcome, n FROM gpt6_guard_daily"), [{ outcome: "flagged_openai", n: 1 }]);
    // Held: a clean request on GPT-6 in another session the same day is refused too, before any check.
    answers.openai = "pass";
    const moderations = service.calls.moderations.length;
    const again = await chat(service, token, simple("NEW-USER hello"), "s-2");
    assert.equal(again.status, 402);
    assert.equal((await errorOf(again)).reason, "security");
    assert.equal(service.calls.moderations.length, moderations);
    // DeepSeek still works.
    assert.equal((await chat(service, token, simple("NEW-USER hello", MODEL), "s-2")).status, 200);
    // The next UTC day, GPT-6 works again in a new session.
    const tomorrow = await later(service, DAY);
    assert.equal((await chat(service, tomorrow, simple("NEW-USER hello"), "s-3")).status, 200);
  });

  it("a safeguard flag stops the request", async () => {
    const { service, token, answers } = await world();
    answers.safeguard = "1";
    const response = await chat(service, token, AUTOPILOT, "s-1");
    assert.equal(response.status, 402);
    assert.equal((await errorOf(response)).code, "gpt_limit");
    assert.equal(service.calls.openai.length, 0);
    await service.settle();
    assert.deepEqual(sql(service, "SELECT risk, model FROM use_descriptions"), [{ risk: "high", model: "presend:safeguard" }]);
    assert.deepEqual(sql(service, "SELECT outcome, n FROM gpt6_guard_daily"), [{ outcome: "flagged_safeguard", n: 1 }]);
  });

  for (const [name, set] of [
    ["the Moderation API fails", (a: Answers) => (a.openai = "error")],
    ["the Moderation API times out", (a: Answers) => (a.openai = "hang")],
    ["the safeguard fails", (a: Answers) => (a.safeguard = "error")],
    ["the safeguard times out", (a: Answers) => (a.safeguard = "hang")],
    ["the safeguard answers something else", (a: Answers) => (a.safeguard = "junk")],
  ] as const) {
    it(`fails closed when ${name}: not sent, refused toward DeepSeek, no label`, async () => {
      const { service, token, answers } = await world();
      set(answers);
      const response = await chat(service, token, AUTOPILOT, "s-1");
      assert.equal(response.status, 402);
      const error = await errorOf(response);
      assert.equal(error.code, "gpt_limit");
      assert.equal(error.alternative, MODEL);
      assert.equal(service.calls.openai.length, 0);
      await service.settle();
      assert.deepEqual(sql(service, "SELECT outcome, n FROM gpt6_guard_daily"), [{ outcome: "error", n: 1 }]);
      assert.equal(sql(service, "SELECT * FROM use_descriptions").length, 0);
    });
  }

  it("fails closed without an OpenRouter key", async () => {
    const { service, token } = await world({ OPENROUTER_API_KEY: "" });
    assert.equal((await chat(service, token, AUTOPILOT)).status, 402);
    assert.equal(service.calls.openai.length, 0);
  });

  it("skips admins", async () => {
    const { service, admin, answers } = await world();
    answers.openai = "flag";
    assert.equal((await chat(service, admin, AUTOPILOT)).status, 200);
    assert.equal(service.calls.moderations.length, 0);
    assert.equal(safeguardCalls(service).length, 0);
  });

  it("off: the old behaviour, no checks", async () => {
    const { service, token, answers } = await world({ GPT6_PRESEND_GUARD: "off" });
    answers.openai = "flag";
    assert.equal((await chat(service, token, AUTOPILOT)).status, 200);
    assert.equal(service.calls.moderations.length, 0);
    assert.equal(safeguardCalls(service).length, 0);
    assert.equal(service.calls.openai.length, 1);
  });

  it("can be turned off at runtime", async () => {
    const { service, admin, token, answers } = await world();
    answers.openai = "flag";
    assert.equal((await service.request("POST", "/v1/admin/config", { token: admin, body: { gpt6PresendGuard: "off" } })).status, 200);
    assert.equal((await chat(service, token, AUTOPILOT)).status, 200);
    assert.equal((await service.request("POST", "/v1/admin/config", { token: admin, body: { gpt6PresendGuard: "maybe" } })).status, 400);
  });

  it("never checks DeepSeek requests", async () => {
    const { service, token, answers } = await world();
    answers.openai = "flag";
    assert.equal((await chat(service, token, { ...AUTOPILOT, model: MODEL })).status, 200);
    assert.equal(service.calls.moderations.length, 0);
    assert.equal(safeguardCalls(service).length, 0);
  });

  it("checks OpenCode's GPT-6 requests (harness key, no session events), with OpenCode's wording", async () => {
    const { service, token, answers } = await world({ GPT6_CLIENTS: "all" });
    const key = await mintOpenCode(service, token);
    assert.equal((await chat(service, key, OPENCODE)).status, 200);
    for (const sent of sentToCheckers(service)) {
      assert.ok(sent.includes("NEW-USER-2") && sent.includes("NEW-TOOL-2"));
      for (const old of NEVER_SENT) assert.ok(!sent.includes(old));
    }
    answers.safeguard = "1";
    const refused = await chat(service, key, OPENCODE);
    assert.equal(refused.status, 402);
    const error = await errorOf(refused);
    assert.equal(error.code, "gpt_limit");
    assert.match(String(error.message), /pick it in \/models\./);
    assert.equal(service.calls.openai.length, 1, "only the clean one reached OpenAI");
  });

  it("Claude Code (DeepSeek only) is unaffected", async () => {
    const { service, token, answers } = await world({ GPT6_TRUSTED_WEEKLY_USD_CAP: "5" });
    answers.openai = "flag";
    const minted = await service.request("POST", "/v1/harness-keys", { token, body: { harness: "claude-code" } });
    const { key } = (await minted.json()) as { key: string };
    const response = await service.request("POST", "/anthropic/v1/messages?beta=true", { token: key, headers: { "anthropic-version": "2023-06-01" }, body: { ...ANTHROPIC, stream: false } });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(service.calls.moderations.length, 0);
  });

  it("counts outcomes per day in /v1/admin/metrics", async () => {
    const { service, admin, token, answers } = await world();
    await chat(service, token, AUTOPILOT, "a");
    answers.openai = "error";
    await chat(service, token, AUTOPILOT, "b");
    await service.settle();
    const metrics = (await (await service.request("GET", "/v1/admin/metrics", { token: admin })).json()) as { gpt6Guard: Array<Record<string, unknown>>; gpt6Trusted: number };
    assert.equal(metrics.gpt6Guard.length, 1);
    assert.equal(metrics.gpt6Guard[0]!.passed, 1);
    assert.equal(metrics.gpt6Guard[0]!.error, 1);
    assert.equal(metrics.gpt6Guard[0]!.flagged_openai, 0);
    assert.equal(typeof metrics.gpt6Trusted, "number");
  });
});

describe("GPT-6 trust gate", () => {
  const facts = (over: Partial<TrustFacts> = {}): TrustFacts => ({ known: true, status: "active", level: "full", batchFlagged: false, activeWeeks: 2, multiTurn: true, highRiskLabel: false, moderation: false, ...over });

  it("rules: admin, or earned use with a clean record (paying is not a trust signal)", () => {
    assert.deepEqual(trustOf(facts(), false), { trusted: true, reasons: ["earned"] });
    assert.deepEqual(trustOf(facts({ level: "starter" }), true), { trusted: true, reasons: ["admin"] });
    assert.deepEqual(trustOf(facts({ level: "starter", activeWeeks: 0, multiTurn: false }), false), { trusted: false, reasons: ["level", "weeks", "multi_turn"] });
    assert.deepEqual(trustOf(facts({ level: "basic", activeWeeks: 1, multiTurn: false, highRiskLabel: true, moderation: true, batchFlagged: true }), false).reasons, ["level", "batch_flagged", "weeks", "multi_turn", "high_risk_label", "moderation"]);
    assert.deepEqual(trustOf(facts({ status: "blocked" }), false), { trusted: false, reasons: ["inactive"] });
  });

  it("off by default (cap 0): nothing changes", async () => {
    const { service, token } = await world({ GPT6_PRESEND_GUARD: "off" });
    assert.equal((await chat(service, token, simple("hi"))).status, 200);
  });

  it("refuses an untrusted person GPT-6 toward DeepSeek, even with a GPT-6 cap set, before any check", async () => {
    const { service, token } = await world({ GPT6_TRUSTED_WEEKLY_USD_CAP: "5", PER_PERSON_WEEKLY_USD_CAP: "2" });
    const response = await chat(service, token, AUTOPILOT, "s-1");
    assert.equal(response.status, 402);
    const error = await errorOf(response);
    assert.equal(error.code, "gpt_limit");
    assert.equal(error.reason, "trust");
    assert.equal(error.alternative, MODEL);
    assert.equal(service.calls.openai.length, 0);
    assert.equal(service.calls.moderations.length, 0);
    // DeepSeek is unaffected, and GPT-6 isn't listed for them.
    assert.equal((await chat(service, token, { ...AUTOPILOT, model: MODEL }, "s-1")).status, 200);
    const models = (await (await service.request("GET", "/v1/models", { token })).json()) as { data: Array<{ id: string }> };
    assert.deepEqual(models.data.map((model) => model.id), [MODEL]);
    // An unknown model's refusal names only what they can use.
    const unknown = await errorOf(await chat(service, token, { ...AUTOPILOT, model: "not-a-model" }, "s-1"));
    assert.equal(unknown.code, "model_not_allowed");
    assert.equal(unknown.message, `The free tier serves ${MODEL} only.`);
    assert.deepEqual(unknown.allowed, [MODEL]);
  });

  it("never trusts a person for paying: a top-up, a Pro payment or an active Pro subscription leaves GPT-6 refused", async () => {
    // Production-like: no GPT-6 for the free plan, the trusted budget only.
    const { service, token } = await world({ GPT6_TRUSTED_WEEKLY_USD_CAP: "5", PER_PERSON_WEEKLY_USD_CAP: "0" });
    await service.directory().recordPayment({ id: "pi_1", githubId: 100, kind: "topup", amountCents: 300, at: service.clock.now - DAY });
    await service.directory().recordPayment({ id: "in_1", githubId: 100, kind: "pro", amountCents: 700, at: service.clock.now - DAY });
    await service.directory().mirrorSubscription({ githubId: 100, state: "active", periodEnd: service.clock.now + 30 * DAY, eventAt: service.clock.now - DAY });
    const response = await chat(service, token, AUTOPILOT, "s-1");
    assert.equal(response.status, 402);
    assert.equal((await errorOf(response)).reason, "trust");
    assert.equal(service.calls.openai.length, 0);
    const models = (await (await service.request("GET", "/v1/models", { token })).json()) as { data: Array<{ id: string }> };
    assert.ok(!models.data.some((model) => model.id === LUNA), "GPT-6 isn't listed for someone who only paid");
  });

  it("works out again a trust cached as \"paid\" before paying stopped counting", async () => {
    const { service, token } = await world({ GPT6_TRUSTED_WEEKLY_USD_CAP: "5", PER_PERSON_WEEKLY_USD_CAP: "0" });
    sql(service, "INSERT INTO gpt6_trust (github_id, trusted, reasons, computed_at) VALUES (100, 1, '[\"paid\"]', ?)", service.clock.now);
    const response = await chat(service, token, AUTOPILOT, "s-1");
    assert.equal(response.status, 402);
    assert.equal((await errorOf(response)).reason, "trust");
  });

  it("trusts an Autopilot user who earned it: two active weeks and a 5-turn session from events", async () => {
    const { service, token } = await world({ GPT6_TRUSTED_WEEKLY_USD_CAP: "5", PER_PERSON_WEEKLY_USD_CAP: "0", GPT6_PRESEND_GUARD: "off" });
    assert.equal((await chat(service, token, simple("hi", MODEL), "ap-1")).status, 200);
    await turns(service, token, "ap-1", 5);
    const next = await later(service, 7 * DAY);
    assert.equal((await chat(service, next, simple("hi", MODEL), "ap-2")).status, 200);
    const response = await chat(service, next, simple("hi"), "ap-2");
    assert.equal(response.status, 200, await response.clone().text());
    const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const people = (await (await service.request("GET", "/v1/admin/people", { token: admin })).json()) as { people: Array<{ githubId: number; gpt6Trusted: boolean; gpt6TrustReasons: string[] }> };
    const alice = people.people.find((person) => person.githubId === 100)!;
    assert.equal(alice.gpt6Trusted, true);
    assert.deepEqual(alice.gpt6TrustReasons, ["earned"]);
    const metrics = (await (await service.request("GET", "/v1/admin/metrics", { token: admin })).json()) as { gpt6Trusted: number };
    assert.equal(metrics.gpt6Trusted, 1, "admins aren't counted");
  });

  it("trusts an OpenCode-only user (no events) from the request log: 5 requests in one run over 5 minutes, two weeks", async () => {
    const { service, token } = await world({ GPT6_TRUSTED_WEEKLY_USD_CAP: "5", PER_PERSON_WEEKLY_USD_CAP: "0", GPT6_PRESEND_GUARD: "off", GPT6_CLIENTS: "all" });
    const key = await mintOpenCode(service, token);
    // Five quick requests aren't multi-turn use.
    for (let n = 0; n < 5; n++) assert.equal((await chat(service, key, simple("hi", MODEL))).status, 200);
    let fresh = await later(service, 7 * DAY);
    const key2 = await mintOpenCode(service, fresh);
    assert.equal((await chat(service, key2, simple("hi", MODEL))).status, 200);
    assert.equal((await chat(service, key2, simple("hi"))).status, 402, "not yet: no spread-out session");
    assert.deepEqual(sql(service, "SELECT trusted, reasons FROM gpt6_trust WHERE github_id = 100"), [{ trusted: 0, reasons: '["multi_turn"]' }]);
    // An hour later (the cache), a run with five requests spread over five minutes.
    fresh = await later(service, 61 * MINUTE);
    const key3 = await mintOpenCode(service, fresh);
    for (let n = 0; n < 5; n++) {
      assert.equal((await chat(service, key3, simple("hi", MODEL))).status, 200);
      service.clock.now += TRUST_MIN_SPREAD_MS / 4;
    }
    fresh = await later(service, 61 * MINUTE);
    const key4 = await mintOpenCode(service, fresh);
    const response = await chat(service, key4, OPENCODE);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(service.calls.openai.length, 1);
  });

  it("a high-risk label removes earned trust at once", async () => {
    const { service, token } = await world({ GPT6_TRUSTED_WEEKLY_USD_CAP: "5", PER_PERSON_WEEKLY_USD_CAP: "0", GPT6_PRESEND_GUARD: "off" });
    assert.equal((await chat(service, token, simple("hi", MODEL), "s-1")).status, 200);
    await turns(service, token, "s-1", 5);
    const next = await later(service, 7 * DAY);
    assert.equal((await chat(service, next, simple("hi", MODEL), "s-2")).status, 200);
    assert.equal((await chat(service, next, simple("hi"), "s-2")).status, 200, "earned");
    // A high label (without a hold, to show trust itself drops): refused within the cached hour.
    service.clock.now += MINUTE;
    sql(service, "INSERT INTO use_descriptions (github_id, session_id, day, use, risk, category, model, created_at) VALUES (100, 'x', 0, 'u', 'high', 'malware', 'test', ?)", service.clock.now);
    const refused = await chat(service, next, simple("hi"), "s-2");
    assert.equal(refused.status, 402);
    assert.equal((await errorOf(refused)).reason, "trust");
    // DeepSeek still works.
    assert.equal((await chat(service, next, simple("hi", MODEL), "s-2")).status, 200);
  });

  it("a moderation watch in the last 30 days removes earned trust", async () => {
    const { service, token } = await world({ GPT6_TRUSTED_WEEKLY_USD_CAP: "5", PER_PERSON_WEEKLY_USD_CAP: "0", GPT6_PRESEND_GUARD: "off" });
    assert.equal((await chat(service, token, simple("hi", MODEL), "s-1")).status, 200);
    await turns(service, token, "s-1", 5);
    const next = await later(service, 7 * DAY);
    assert.equal((await chat(service, next, simple("hi", MODEL), "s-2")).status, 200);
    sql(
      service,
      "INSERT INTO moderation_decisions (github_id, label_id, session_id, category, verdict, confidence, reason, signals, action, model, created_at) VALUES (100, NULL, NULL, 'other', 'watch', 0.5, 'r', '[]', 'none', 'm', ?)",
      service.clock.now - DAY,
    );
    const refused = await chat(service, next, simple("hi"), "s-2");
    assert.equal(refused.status, 402);
    assert.equal((await errorOf(refused)).reason, "trust");
  });

  it("admins are always served", async () => {
    const { service, admin } = await world({ GPT6_TRUSTED_WEEKLY_USD_CAP: "5" });
    assert.equal((await chat(service, admin, simple("hi"))).status, 200);
  });
});
