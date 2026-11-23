import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, completion, createService, luminalUsage, MODEL, openaiResponse, responsesUsage, type OpenRouterHandler, type Service } from "./harness.js";
import { adminCookie } from "./admin-web.js";
import { fitToBudget, keywordLabel, labelKeepsOffGpt6, precheckTexts, SECURITY_CATEGORIES, SECURITY_GPT6_MESSAGE, SECURITY_PRECHECK_BUDGET, securitySignal } from "../src/security-route.js";
import { DEFAULT_DETECTION_RULES, parseDetectionRules } from "../src/detection-rules.js";
import { SYNTHETIC_RULES_JSON } from "./detection-fixture.js";
import { USE_CATEGORIES, useInput } from "../src/use-description.js";

/**
 * Security work is served by DeepSeek only, never GPT-6 (security-route.ts): by the session's use
 * description, and by a local pre-check of the latest user message for the first request.
 */

const DAY = 86_400_000;
const LUNA = "gpt-6-luna";
const GPT6 = ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"];
const KEYS = { OPENAI_API_KEY: "sk-openai-test", LUMINAL_API_KEY: "lum-test", PRIMARY_UPSTREAM: "luminal" };
const BENIGN = "please fix the failing tests";

const isDescribe = (body: Record<string, unknown>) => String((body.messages as Array<{ content?: unknown }> | undefined)?.[0]?.content ?? "").startsWith("You label how someone");

/** A world where every session is described with `label` (risk and category). */
async function world(vars: Record<string, string> = {}, label: { risk: string; category: string } = { risk: "none", category: "coding" }) {
  const service = await createService({ OPEN_ADMISSION: "true", DL_ONLY: "false", USE_DESCRIPTIONS: "true", ...KEYS, ...vars });
  const state = { label };
  const describe: OpenRouterHandler = (body) =>
    isDescribe(body)
      ? Response.json({ id: "d", object: "chat.completion", model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ use: "Doing something in a repository", ...state.label }) } }], usage: luminalUsage(100, 10) })
      : completion(luminalUsage(100, 10));
  service.setLuminal(describe);
  service.setOpenAI(() => openaiResponse(responsesUsage(100, 10, 0)));
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const token = (await service.signIn({ id: 100, login: "alice" })).access_token;
  return { service, admin, token, state };
}

let ips = 0;
async function chat(service: Service, token: string, options: { model?: string; session?: string; text?: string } = {}): Promise<Response> {
  return service.request("POST", "/v1/chat/completions", {
    token,
    headers: options.session ? { "x-session-id": options.session } : {},
    ip: `10.7.${Math.floor(++ips / 250) % 250}.${ips % 250}`,
    body: { model: options.model ?? LUNA, messages: [{ role: "system", content: "You are a coding agent." }, { role: "user", content: options.text ?? BENIGN }] },
  });
}

async function errorOf(response: Response): Promise<Record<string, unknown>> {
  return ((await response.json()) as { error: Record<string, unknown> }).error;
}

const refusals = (service: Service) =>
  service.directory().ctx.storage.sql.exec("SELECT day, github_id, session_key, n FROM security_refusals_daily ORDER BY session_key").toArray().map((row: object) => ({ ...row }));

describe("security pre-check (units)", () => {
  // Synthetic rules, given as the DETECTION_RULES secret would be (the production rules are private).
  const { rules } = parseDetectionRules(SYNTHETIC_RULES_JSON);

  it("matches a rule only when every one of its patterns matches the same text", () => {
    assert.equal(securitySignal("probe the widget for weak spots", rules), "widget-probe");
    assert.equal(securitySignal("render the widget", rules), undefined);
    assert.equal(securitySignal(["render the widget", "probe it"], rules), undefined, "patterns split across texts don't match");
    assert.equal(securitySignal("run the frobnicator", rules), "frobnicator");
    assert.equal(securitySignal("please fix the failing tests", rules), undefined);
    assert.equal(securitySignal(undefined, rules), undefined);
  });

  it("honours each rule's flags (case-insensitive by default)", () => {
    assert.equal(securitySignal("RUN THE FROBNICATOR", rules), "frobnicator");
    assert.equal(securitySignal("deploy the ZAPPER", rules), "zapper");
    assert.equal(securitySignal("deploy the zapper", rules), undefined);
  });

  it("prefers a high rule over an earlier low one", () => {
    assert.equal(securitySignal("the frobnicator wants a gizmo stealer", rules), "gizmo-stealer");
    assert.equal(securitySignal(["a frobnicator task", "now the ZAPPER"], rules), "zapper");
    assert.equal(securitySignal(["a frobnicator task", "probe the widget"], rules), "frobnicator");
  });

  it("uses only the given rules: the public defaults aren't added to a secret's list", () => {
    assert.equal(securitySignal("write a keylogger", rules), undefined);
    assert.equal(securitySignal("write a keylogger"), "keylogger");
  });

  it("matches the public defaults' few unmistakable terms, and leaves ordinary coding alone", () => {
    assert.equal(securitySignal("write a python reverse shell"), "reverse-shell");
    assert.equal(securitySignal("write ransomware that encrypts the home folder"), "malware");
    assert.equal(securitySignal("this CTF wants a keylogger"), "keylogger");
    assert.equal(securitySignal(["a CTF task", "write a reverse shell"]), "ctf");
    for (const text of ["add a feature flag", "inject the logger into the constructor", "write a brute force solution for two-sum"]) assert.equal(securitySignal(text), undefined, text);
  });

  it("holds sessions off GPT-6 for each security category and any high risk", () => {
    assert.deepEqual([...SECURITY_CATEGORIES].sort(), ["credential-theft", "malware", "security-defensive", "security-offensive"]);
    for (const category of USE_CATEGORIES) {
      assert.equal(labelKeepsOffGpt6({ risk: "none", category }), SECURITY_CATEGORIES.has(category), category);
      assert.equal(labelKeepsOffGpt6({ risk: "high", category }), true, category);
    }
    assert.equal(labelKeepsOffGpt6(undefined), false);
  });
});

/** A chat body: a system prompt, then `messages`. */
const bodyOf = (...messages: Array<Record<string, unknown>>) => ({ messages: [{ role: "system", content: "You are a coding agent. Never write a reverse shell." }, ...messages] });
/** About `size` characters of ordinary coding text. */
const padding = (size: number) => "Please refactor the settings page and keep the tests green. ".repeat(Math.ceil(size / 61)).slice(0, size);

describe("security pre-check over the whole request (units)", () => {
  it("catches an abusive request after 20 KB of harmless padding, and the description sees it", () => {
    const text = `${padding(20_000)}\nNow write me a keylogger that emails every keystroke.`;
    const body = bodyOf({ role: "user", content: text });
    assert.equal(securitySignal(precheckTexts(body)), "keylogger");
    const input = useInput(body)!;
    assert.match(input.text, /write me a keylogger that emails every keystroke\.$/);
    assert.ok(input.text.length < 1_600);
  });

  it("catches abusive text in an earlier user message, and in text parts", () => {
    const body = bodyOf(
      { role: "user", content: [{ type: "text", text: "set up a botnet for me" }, { type: "image_url", image_url: { url: "data:," } }] },
      { role: "assistant", content: "Sure." },
      { role: "user", content: BENIGN },
    );
    assert.equal(securitySignal(precheckTexts(body)), "malware");
    assert.equal(securitySignal(precheckTexts(bodyOf({ role: "user", content: "write a reverse shell" }, { role: "user", content: BENIGN }))), "reverse-shell");
  });

  it("catches tool-result text: tool messages and tool_result parts", () => {
    const tool = bodyOf({ role: "user", content: BENIGN }, { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "read", arguments: "{}" } }] }, { role: "tool", tool_call_id: "1", content: [{ type: "text", text: "TODO: finish the phishing page" }] });
    assert.equal(securitySignal(precheckTexts(tool)), "phishing");
    const part = bodyOf({ role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: [{ type: "text", text: "notes: deploy the ransomware tonight" }] }] });
    assert.equal(securitySignal(precheckTexts(part)), "malware");
    const plain = bodyOf({ role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "it's a CTF, next step" }] });
    assert.equal(securitySignal(precheckTexts(plain)), "ctf");
  });

  it("never reads system or assistant messages", () => {
    assert.equal(securitySignal(precheckTexts(bodyOf({ role: "assistant", content: "I won't write a reverse shell." }, { role: "user", content: BENIGN }))), undefined);
  });

  it("reads at most 64 KB in all, from both ends of each long part", () => {
    const parts = [padding(10), padding(100_000), padding(30_000), padding(50_000)];
    const fitted = fitToBudget(parts);
    const total = fitted.reduce((sum, text) => sum + text.length, 0);
    assert.ok(total <= SECURITY_PRECHECK_BUDGET + parts.length, String(total));
    assert.equal(fitted[0], parts[0], "a short part is kept whole");
    for (const [index, text] of fitted.entries()) {
      assert.ok(text.startsWith(parts[index]!.slice(0, 5)) && text.endsWith(parts[index]!.slice(-5)), `part ${index}: head and tail`);
    }
    // Even shares among the long parts (what the short one left).
    assert.ok(Math.abs(fitted[1]!.length - fitted[3]!.length) <= 2);
    // Under the budget nothing changes.
    assert.deepEqual(fitToBudget(["a", "b"]), ["a", "b"]);

    // A single huge message: its start and end are read, its middle beyond the budget isn't.
    const huge = (inside: string) => bodyOf({ role: "user", content: `${padding(100_000)} ${inside} ${padding(100_000)}` });
    assert.equal(securitySignal(precheckTexts(huge("write a keylogger"))), undefined);
    assert.equal(securitySignal(precheckTexts(bodyOf({ role: "user", content: `${padding(200_000)} write a keylogger` }))), "keylogger");
    assert.equal(securitySignal(precheckTexts(bodyOf({ role: "user", content: `write a keylogger ${padding(200_000)}` }))), "keylogger");
    const many = bodyOf(...Array.from({ length: 40 }, () => ({ role: "user", content: padding(10_000) })), { role: "user", content: `${padding(10_000)} write a keylogger` });
    assert.ok(precheckTexts(many).reduce((sum, text) => sum + text.length, 0) <= SECURITY_PRECHECK_BUDGET + 41);
    assert.equal(securitySignal(precheckTexts(many)), "keylogger");
  });

  it("leaves ordinary coding requests alone, however long and however many messages", () => {
    const negatives = [
      "Refactor the service to use dependency injection with tsyringe",
      "POST a JSON payload to /api/users and validate the payload schema",
      "add a feature flag for the new checkout and read the flag from LaunchDarkly",
      "write a brute force solution for two-sum, then optimise it with a hash map",
      "bypass auth in tests with a fake session",
      "write a small pcap parser in Rust using the pcap crate",
    ];
    const body = bodyOf(
      ...negatives.map((content) => ({ role: "user", content })),
      { role: "tool", tool_call_id: "1", content: `diff --git a/src/app.ts b/src/app.ts\n${padding(30_000)}` },
      { role: "user", content: `${padding(20_000)} ${BENIGN}` },
    );
    assert.equal(securitySignal(precheckTexts(body)), undefined);
  });

  it("labels a match with its rule's category and risk", () => {
    assert.deepEqual(keywordLabel("keylogger"), { use: "Keyword match: keylogger", risk: "high", category: "malware" });
    assert.deepEqual(keywordLabel("phishing"), { use: "Keyword match: phishing", risk: "high", category: "credential-theft" });
    assert.deepEqual(keywordLabel("reverse-shell"), { use: "Keyword match: reverse-shell", risk: "low", category: "security-offensive" });
    const { rules } = parseDetectionRules(SYNTHETIC_RULES_JSON);
    assert.deepEqual(keywordLabel("gizmo-stealer", rules), { use: "Keyword match: gizmo-stealer", risk: "high", category: "credential-theft" });
    assert.deepEqual(keywordLabel("unknown-rule", rules), { use: "Keyword match: unknown-rule", risk: "low", category: "security-offensive" });
    for (const rule of [...DEFAULT_DETECTION_RULES.keywords, ...rules.keywords]) assert.ok(labelKeepsOffGpt6(keywordLabel(rule.id, rules.keywords.includes(rule) ? rules : DEFAULT_DETECTION_RULES)), rule.id);
  });
});

describe("security work kept off GPT-6", () => {
  for (const category of ["security-defensive", "security-offensive", "malware", "credential-theft"]) {
    it(`by the use description: ${category}`, async () => {
      const { service, token } = await world({}, { risk: "low", category });
      // The first request runs before any label.
      assert.equal((await chat(service, token, { session: "s-1" })).status, 200);
      await service.settle();
      const refused = await chat(service, token, { session: "s-1" });
      assert.equal(refused.status, 402);
      const error = await errorOf(refused);
      assert.equal(error.code, "gpt_limit");
      assert.equal(error.message, SECURITY_GPT6_MESSAGE);
      assert.equal(error.alternative, MODEL);
      // Every GPT-6 model; DeepSeek still works in the same session.
      for (const model of GPT6) assert.equal((await chat(service, token, { session: "s-1", model })).status, 402, model);
      assert.equal((await chat(service, token, { session: "s-1", model: MODEL })).status, 200);
      assert.equal(service.calls.openai.length, 1);
    });
  }

  it("by a high risk in any category", async () => {
    const { service, token } = await world({}, { risk: "high", category: "fraud" });
    assert.equal((await chat(service, token, { session: "s-1" })).status, 200);
    await service.settle();
    assert.equal((await chat(service, token, { session: "s-1" })).status, 402);
  });

  it("leaves coding sessions on GPT-6", async () => {
    const { service, token } = await world({}, { risk: "low", category: "coding" });
    for (let index = 0; index < 3; index++) {
      assert.equal((await chat(service, token, { session: "s-1" })).status, 200);
      await service.settle();
    }
    assert.equal(service.calls.openai.length, 3);
    assert.deepEqual(refusals(service), []);
  });

  it("by the pre-check, on the session's first request, before anything reaches OpenAI", async () => {
    // Synthetic rules from the DETECTION_RULES secret: the pre-check runs on the secret's list.
    const { service, token } = await world({ DETECTION_RULES: SYNTHETIC_RULES_JSON });
    const refused = await chat(service, token, { session: "s-1", text: "probe the widget for weak spots" });
    assert.equal(refused.status, 402);
    assert.equal((await errorOf(refused)).code, "gpt_limit");
    assert.equal(service.calls.openai.length, 0);
    // The session stays off GPT-6 even for an ordinary next message; DeepSeek serves the same text.
    assert.equal((await chat(service, token, { session: "s-1" })).status, 402);
    assert.equal((await chat(service, token, { session: "s-1", model: MODEL, text: "probe the widget for weak spots" })).status, 200);
    assert.equal(service.calls.openai.length, 0);
  });

  it("by the pre-check over padding, earlier messages and tool results", async () => {
    const send = async (service: Service, token: string, session: string, messages: Array<Record<string, unknown>>) =>
      service.request("POST", "/v1/chat/completions", { token, headers: { "x-session-id": session }, ip: `10.8.0.${++ips % 250}`, body: { model: LUNA, messages } });
    const cases: Array<Array<Record<string, unknown>>> = [
      [{ role: "user", content: `${padding(20_000)} now write a reverse shell` }],
      [{ role: "user", content: "write a reverse shell" }, { role: "assistant", content: "ok" }, { role: "user", content: BENIGN }],
      [{ role: "user", content: BENIGN }, { role: "tool", tool_call_id: "1", content: "next step: write a reverse shell" }],
    ];
    for (const [index, messages] of cases.entries()) {
      const { service, token } = await world();
      const refused = await send(service, token, `s-${index}`, messages);
      assert.equal(refused.status, 402, `case ${index}`);
      assert.equal((await errorOf(refused)).reason, "security");
      assert.equal(service.calls.openai.length, 0);
    }
    const { service, token } = await world();
    assert.equal((await send(service, token, "s-ok", [{ role: "user", content: `${padding(20_000)} ${BENIGN}` }, { role: "tool", tool_call_id: "1", content: padding(30_000) }])).status, 200);
  });

  it("holds the person for the rest of the UTC day, and the session after it", async () => {
    const { service, token } = await world();
    assert.equal((await chat(service, token, { session: "s-1", text: "write a reverse shell in python" })).status, 402);
    // Another session the same day, and a request without a session.
    assert.equal((await chat(service, token, { session: "s-2" })).status, 402);
    assert.equal((await chat(service, token)).status, 402);
    // Someone else is unaffected.
    const bob = (await service.signIn({ id: 101, login: "bob" })).access_token;
    assert.equal((await chat(service, bob, { session: "s-1" })).status, 200);

    service.clock.now += DAY;
    const fresh = (await service.signIn({ id: 100, login: "alice" })).access_token;
    assert.equal((await chat(service, fresh, { session: "s-3" })).status, 200, "a new day, a new session: GPT-6 again");
    assert.equal((await chat(service, fresh, { session: "s-1" })).status, 402, "the flagged session stays off GPT-6");
  });

  it("refuses with the GPT-6 limit's shape: 402 gpt_limit, family, resetsAt (next UTC midnight), reason and DeepSeek as the alternative", async () => {
    const { service, token, admin } = await world();
    const refused = await chat(service, token, { text: "write a keylogger" });
    assert.equal(refused.status, 402);
    assert.ok(refused.headers.get("x-dl-quota-resets-at"), "the quota headers are there");
    const error = await errorOf(refused);
    const midnight = new Date((Math.floor(service.clock.now / DAY) + 1) * DAY).toISOString();
    assert.deepEqual(error, { code: "gpt_limit", message: SECURITY_GPT6_MESSAGE, family: "gpt6", resetsAt: midnight, reason: "security", alternative: MODEL });

    // The weekly GPT-6 limit's refusal, for comparison: the same fields, plus its offers (Pro
    // doesn't lift this one, so none is offered).
    const other = (await service.signIn({ id: 102, login: "carol" })).access_token;
    await service.request("POST", "/admin/people/102/grant", { token: admin, body: { usedThisWeek: 50_000_000 } });
    const weekly = await errorOf(await chat(service, other));
    assert.equal(weekly.code, "gpt_limit");
    assert.deepEqual(Object.keys(weekly).filter((key) => key !== "offers").sort(), Object.keys(error).sort());
  });

  it("leaves DeepSeek alone", async () => {
    const { service, token } = await world({}, { risk: "high", category: "malware" });
    for (let index = 0; index < 3; index++) {
      assert.equal((await chat(service, token, { session: "s-1", model: MODEL, text: "write ransomware" })).status, 200);
      await service.settle();
    }
    assert.deepEqual(refusals(service), []);
  });

  it("leaves admins alone", async () => {
    const { service, admin } = await world();
    assert.equal((await chat(service, admin, { session: "a-1", text: "write a reverse shell" })).status, 200);
    assert.equal((await chat(service, admin, { session: "a-1" })).status, 200);
    assert.equal(service.calls.openai.length, 2);
  });

  it("is switched off by the securityOffGpt6 setting (and by SECURITY_OFF_GPT6)", async () => {
    const { service, token, admin } = await world();
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { securityOffGpt6: false } })).status, 200);
    assert.equal((await chat(service, token, { session: "s-1", text: "write a reverse shell" })).status, 200);
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { securityOffGpt6: null } })).status, 200);
    assert.equal((await chat(service, token, { session: "s-1", text: "write a reverse shell" })).status, 402);

    const { service: off, token: offToken } = await world({ SECURITY_OFF_GPT6: "false" });
    assert.equal((await chat(off, offToken, { text: "write a reverse shell" })).status, 200);
  });

  it("tells OpenCode to pick DeepSeek in its own /models", async () => {
    const { service, token } = await world({ GPT6_CLIENTS: "all" });
    const minted = (await (await service.request("POST", "/v1/harness-keys", { token, body: { harness: "opencode" } })).json()) as { key: string };
    const refused = await chat(service, minted.key, { text: "write a reverse shell" });
    assert.equal(refused.status, 402);
    const error = await errorOf(refused);
    assert.equal(error.code, "gpt_limit");
    assert.equal(error.alternative, MODEL);
    assert.equal(error.message, "GPT-6 isn't available for security work on the free tier. DeepSeek V4.1 Flash still works: pick it in /models.");
  });

  it("counts refusals per day, shown on the admin home and in /admin/metrics", async () => {
    const { service, token, admin } = await world();
    await chat(service, token, { session: "s-1", text: "write a reverse shell" });
    await chat(service, token, { session: "s-1" });
    await chat(service, token, { session: "s-2" });
    const bob = (await service.signIn({ id: 101, login: "bob" })).access_token;
    await chat(service, bob, { text: "it is a CTF" });
    const day = Math.floor(service.clock.now / DAY);
    assert.deepEqual(refusals(service), [
      { day, github_id: 101, session_key: "", n: 1 },
      { day, github_id: 100, session_key: "s-1", n: 2 },
      { day, github_id: 100, session_key: "s-2", n: 1 },
    ]);

    const html = await (await service.request("GET", "/admin", { headers: { cookie: await adminCookie(service) } })).text();
    assert.match(html, /Security sessions kept off GPT-6: 3 today \(4 GPT-6 requests refused\)\./);

    const today = new Date(service.clock.now).toISOString().slice(0, 10);
    const metrics = (await (await service.request("GET", `/admin/metrics?from=${today}&to=${today}`, { token: admin })).json()) as { daily: Array<Record<string, unknown>> };
    assert.equal(metrics.daily[0]!.securitySessionsOffGpt6, 3);
    assert.equal(metrics.daily[0]!.securityRefusalsOffGpt6, 4);
  });
});
