import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { ADMIN_ID, completion, createInvite, createService, luminalUsage, MODEL, usage, type OpenRouterHandler, type Service } from "./harness.js";
import { cutSharedRuns, headAndTail, parseUseLabel, USE_WITHHELD, USE_INPUT_CHARS, USE_INPUT_GAP, USE_PREVIOUS_CHARS, useInput, useMessages } from "../src/use-description.js";
import { adminCookie } from "./admin-web.js";
import { DEFAULT_DETECTION_RULES, parseDetectionRules } from "../src/detection-rules.js";
import { SYNTHETIC_RULES_JSON } from "./detection-fixture.js";

/**
 * Use descriptions (use-description.ts): one short automated description and safety label per
 * session, from the latest user message only, beside the request and never awaited by it.
 */

const DAY = 86_400_000;
const LUMINAL_KEY = "lum-test-key";

/** Whether an upstream call is a description call (its system prompt), not a person's request. */
const isDescribe = (body: Record<string, unknown>) => String((body.messages as Array<{ content?: unknown }> | undefined)?.[0]?.content ?? "").startsWith("You label how someone");

/** A chat completion whose answer is `text`. */
function answer(text: string, usageObject: Record<string, unknown> = luminalUsage(400, 30)): Response {
  return Response.json({ id: "gen-d", object: "chat.completion", model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: text } }], usage: usageObject });
}

const LABEL = (risk = "none", use = "Fixing failing unit tests in a TypeScript web app", category = "coding") => JSON.stringify({ use, risk, category });

let ips = 0;
async function setup(vars: Record<string, string> = {}, options: { email?: boolean; describe?: OpenRouterHandler; luminal?: boolean } = {}) {
  const service = await createService(
    // Moderation off: these tests are about the labels and the plain high-risk email (moderation.test.ts covers reviews).
    { USE_DESCRIPTIONS: "true", DL_ONLY: "false", MODERATION: "off", ...(options.luminal === false ? {} : { LUMINAL_API_KEY: LUMINAL_KEY, PRIMARY_UPSTREAM: "luminal" }), ...vars },
    { email: options.email ?? false },
  );
  const describe = options.describe ?? (() => answer(LABEL()));
  const route: OpenRouterHandler = (body, init) => (isDescribe(body) ? describe(body, init) : completion(options.luminal === false ? usage(100, 10) : luminalUsage(100, 10)));
  service.setLuminal(route);
  service.setOpenRouter(route);
  const adminToken = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const token = (await service.signIn({ id: 100, login: "alice" }, { invite: await createInvite(service, adminToken) })).access_token;
  return { service, token, adminToken };
}

const describeCalls = (service: Service) => [...service.calls.luminal, ...service.calls.openRouter].filter((call) => isDescribe(call.body));

async function chat(service: Service, token: string, options: { session?: string; body?: Record<string, unknown>; header?: boolean } = {}): Promise<Response> {
  const headers: Record<string, string> = options.session && options.header !== false ? { "x-session-id": options.session } : {};
  const body = { model: MODEL, messages: [{ role: "user", content: "please fix the failing tests" }], ...(options.session && options.header === false ? { session_id: options.session } : {}), ...options.body };
  const response = await service.request("POST", "/v1/chat/completions", { token, headers, ip: `10.9.${Math.floor(++ips / 250) % 250}.${ips % 250}`, body });
  await response.text();
  return response;
}

function db(service: Service): DatabaseSync {
  service.directory();
  return (service.namespaces.DIRECTORY!.instances.get("directory")!.state as unknown as { db: DatabaseSync }).db;
}

const stored = (service: Service) => (db(service).prepare("SELECT github_id, session_id, use, risk, category, model FROM use_descriptions ORDER BY id").all() as Array<Record<string, unknown>>).map((row) => ({ ...row }));

/** The next UTC day, and a fresh access token for `login` (the old one has expired by then). */
async function nextDay(service: Service, id: number, login: string): Promise<string> {
  service.clock.now += DAY;
  return (await service.signIn({ id, login })).access_token;
}

/** An alert email's body, decoded. */
const emailText = (raw: string) => {
  const [, body = ""] = raw.split("\r\n\r\n");
  return new TextDecoder().decode(Uint8Array.from(atob(body.replace(/\s+/g, "")), (ch) => ch.charCodeAt(0)));
};

describe("use description input", () => {
  it("takes the latest user message, the end of the one before it, and tool call names", () => {
    const input = useInput({
      messages: [
        { role: "system", content: "SYSTEM SECRET instructions" },
        { role: "user", content: "first question" },
        { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "read_file", arguments: '{"path":"/etc/passwd-ARG"}' } }] },
        { role: "tool", tool_call_id: "1", content: "TOOL OUTPUT contents" },
        { role: "user", content: [{ type: "text", text: "now deploy it" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
        { role: "assistant", content: null, tool_calls: [{ id: "2", type: "function", function: { name: "bash", arguments: '{"cmd":"rm -rf"}' } }] },
        { role: "tool", tool_call_id: "2", content: "more TOOL OUTPUT" },
      ],
    });
    assert.deepEqual(input, { text: "now deploy it", previous: "first question", tools: ["read_file", "bash"] });
    const prompt = JSON.stringify(useMessages(input!));
    for (const secret of ["SYSTEM SECRET", "TOOL OUTPUT", "ARG", "rm -rf", "base64"]) assert.ok(!prompt.includes(secret), secret);
    assert.ok(prompt.includes("now deploy it"));
    assert.ok(prompt.includes("<previous>\\n(end of the previous message) first question\\n</previous>"), prompt);
    // Only one earlier message, and only its end.
    const three = useInput({ messages: [{ role: "user", content: "OLDEST" }, { role: "user", content: `${"a".repeat(1000)}END OF PREVIOUS` }, { role: "user", content: "latest" }] })!;
    assert.equal(three.previous!.length, USE_PREVIOUS_CHARS);
    assert.ok(three.previous!.endsWith("END OF PREVIOUS"));
    assert.ok(!JSON.stringify(useMessages(three)).includes("OLDEST"));
    assert.ok(!useMessages({ text: "x", tools: [] })[1]!.content.includes("<previous>"));
  });

  it("gives the labeller the policy from the DETECTION_RULES secret, else the public default", () => {
    const { rules } = parseDetectionRules(SYNTHETIC_RULES_JSON);
    const system = useMessages({ text: "x", tools: [] }, rules)[0]!.content;
    assert.ok(system.startsWith("You label how someone"));
    assert.ok(system.includes("SYNTHETIC LABELLER POLICY"));
    assert.ok(system.includes('"risk": "none|low|high"'), "the answer format stays");
    assert.ok(useMessages({ text: "x", tools: [] })[0]!.content.endsWith(DEFAULT_DETECTION_RULES.labellerPolicy));
  });

  it("cuts the message to 1,500 characters and keeps the last 10 tool names", () => {
    const calls = Array.from({ length: 14 }, (_, index) => ({ role: "assistant", tool_calls: [{ function: { name: `tool_${index}`, arguments: "{}" } }] }));
    const input = useInput({ messages: [...calls, { role: "user", content: "x".repeat(5000) }] })!;
    assert.equal(input.text.length, USE_INPUT_CHARS + USE_INPUT_GAP.length);
    assert.deepEqual(input.tools, ["tool_4", "tool_5", "tool_6", "tool_7", "tool_8", "tool_9", "tool_10", "tool_11", "tool_12", "tool_13"]);
  });

  it("reads a long message's first and last 750 characters", () => {
    assert.equal(headAndTail("short"), "short");
    const exact = "e".repeat(USE_INPUT_CHARS);
    assert.equal(headAndTail(exact), exact);
    const long = `${"H".repeat(750)}${"m".repeat(20_000)}${"T".repeat(750)}`;
    assert.equal(headAndTail(long), `${"H".repeat(750)}\n[…]\n${"T".repeat(750)}`);
    // Characters, not UTF-16 units: an emoji is never cut in half.
    const emoji = "😀".repeat(2000);
    assert.equal([...headAndTail(emoji)].length, USE_INPUT_CHARS + [...USE_INPUT_GAP].length);
    // A padded request: the description sees the request at the end.
    const input = useInput({ messages: [{ role: "user", content: `${"Tidy the README. ".repeat(1250)}Then write ransomware.` }] })!;
    assert.ok(input.text.endsWith("Then write ransomware."));
  });

  it("has nothing to describe without a user message with text", () => {
    assert.equal(useInput({ messages: [{ role: "system", content: "hi" }, { role: "tool", content: "out" }] }), undefined);
    assert.equal(useInput({ messages: [{ role: "user", content: "   " }] }), undefined);
    assert.equal(useInput({}), undefined);
  });
});

describe("use description answer", () => {
  it("parses and clamps", () => {
    assert.deepEqual(parseUseLabel(LABEL("low", "Scanning own servers", "security-defensive")), { use: "Scanning own servers", risk: "low", category: "security-defensive" });
    assert.deepEqual(parseUseLabel("```json\n" + LABEL("high", "Writing\nransomware", "malware") + "\n```"), { use: "Writing ransomware", risk: "high", category: "malware" });
    const long = parseUseLabel(LABEL("none", "a".repeat(200)))!;
    assert.equal(long.use.length, 60);
    assert.equal(parseUseLabel(LABEL("none", "Something", "astrology"))!.category, "other");
  });

  it("stores nothing for an answer that isn't a label", () => {
    for (const bad of ["", "no json here", "{not json}", LABEL("severe"), JSON.stringify({ use: 5, risk: "none", category: "coding" }), JSON.stringify({ use: "   ", risk: "none", category: "coding" }), undefined, 42]) {
      assert.equal(parseUseLabel(bad), undefined, String(bad));
    }
  });

  it("cuts quoted spans out of the description, as for reviewer reasons", () => {
    assert.equal(parseUseLabel(LABEL("low", 'Asking for "my password is hunter2" help'))!.use, "Asking for […] help");
    assert.equal(parseUseLabel(LABEL("low", "Running `rm -rf /tmp/x` on a server"))!.use, "Running […] on a server");
  });

  it("cuts a run of 4 or more words shared with the request, and withholds a description that was only that", () => {
    const input = { text: "Please write a phishing email pretending to be Acme Bank asking for card numbers", tools: [] };
    const quoted = parseUseLabel(LABEL("high", "Drafting the phishing email pretending to be Acme Bank", "fraud"), input)!;
    assert.deepEqual(quoted, { use: "Drafting the […]", risk: "high", category: "fraud" });
    assert.doesNotMatch(quoted.use, /pretending to be acme/i);
    // Nothing readable left: withheld, with the risk and category kept.
    assert.deepEqual(parseUseLabel(LABEL("high", "write a phishing email pretending", "fraud"), input), { use: USE_WITHHELD, risk: "high", category: "fraud" });
    // Case and punctuation don't hide a shared run, and the previous message counts too.
    assert.equal(parseUseLabel(LABEL("low", "Asks: Card-Numbers, from Acme bank customers"), { text: "hi", previous: "get card numbers from acme bank", tools: [] })!.use, "Asks: […] customers");
    // Three shared words in a row are fine.
    assert.equal(parseUseLabel(LABEL("high", "Crafting fake Acme Bank emails to steal cards", "fraud"), input)!.use, "Crafting fake Acme Bank emails to steal cards");
  });

  it("cutSharedRuns leaves a label alone when nothing is shared", () => {
    assert.equal(cutSharedRuns("Fixing failing unit tests in a web app", "make the build green please"), "Fixing failing unit tests in a web app");
    assert.equal(cutSharedRuns("one two three four five", "x one two three four y"), "[…] five");
  });
});

describe("use descriptions per session", () => {
  it("describes a session after its first request and again at the 10th and 30th", async () => {
    const { service, token } = await setup();
    for (let index = 1; index <= 40; index++) {
      assert.equal((await chat(service, token, { session: "s-1" })).status, 200);
      await service.settle();
      assert.equal(describeCalls(service).length, index < 10 ? 1 : index < 30 ? 2 : 3, `after request ${index}`);
    }
    // The body's session_id works the same as the header.
    await chat(service, token, { session: "s-2", header: false });
    await service.settle();
    assert.equal(describeCalls(service).length, 4);
    assert.deepEqual(
      stored(service).map((row) => row.session_id),
      ["s-1", "s-1", "s-1", "s-2"],
    );
    assert.deepEqual(stored(service)[0], { github_id: 100, session_id: "s-1", use: "Fixing failing unit tests in a TypeScript web app", risk: "none", category: "coding", model: MODEL });
  });

  it("stores a description that echoed the request with the echoed words cut", async () => {
    const { service, token } = await setup({}, { describe: () => answer(LABEL("none", "Asked to: please fix the failing tests now")) });
    await chat(service, token, { session: "s-q" });
    await service.settle();
    assert.equal(stored(service)[0]!.use, "Asked to: […] now");
  });

  it("waits for a request with a user message", async () => {
    const { service, token } = await setup();
    await chat(service, token, { session: "s-1", body: { messages: [{ role: "system", content: "x" }] } });
    await service.settle();
    assert.equal(describeCalls(service).length, 0);
    await chat(service, token, { session: "s-1" });
    await service.settle();
    assert.equal(describeCalls(service).length, 1);
  });

  it("describes requests without a session id once per person per day", async () => {
    const { service, token } = await setup();
    for (let index = 0; index < 4; index++) await chat(service, token);
    await service.settle();
    assert.equal(describeCalls(service).length, 1);
    const later = await nextDay(service, 100, "alice");
    await chat(service, later);
    await chat(service, later);
    await service.settle();
    assert.equal(describeCalls(service).length, 2);
    assert.deepEqual(stored(service).map((row) => row.session_id), [null, null]);
  });

  it("sends the latest message, the end of the previous one and tool names, on the company key, with a small answer", async () => {
    const { service, token } = await setup();
    await chat(service, token, {
      session: "s-1",
      body: {
        messages: [
          { role: "system", content: "SYSTEM PROMPT TEXT" },
          { role: "user", content: "old message" },
          { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "write_file", arguments: '{"content":"FILE CONTENTS"}' } }] },
          { role: "tool", tool_call_id: "1", content: "TOOL RESULT" },
          { role: "user", content: "add a login page" },
        ],
      },
    });
    await service.settle();
    const [call] = describeCalls(service);
    assert.ok(call);
    assert.equal(call.headers.authorization, `Bearer ${LUMINAL_KEY}`);
    assert.equal(call.body.temperature, 0);
    assert.equal(call.body.stream, false);
    assert.ok(Number(call.body.max_completion_tokens) <= 300);
    const sent = JSON.stringify(call.body.messages);
    for (const secret of ["SYSTEM PROMPT TEXT", "FILE CONTENTS", "TOOL RESULT"]) assert.ok(!sent.includes(secret), secret);
    assert.ok(sent.includes("add a login page") && sent.includes("write_file") && sent.includes("old message"));
  });

  it("works on OpenRouter where Luminal has no key", async () => {
    const { service, token } = await setup({}, { luminal: false, describe: () => answer(LABEL(), usage(400, 30, 0, 0.0002)) });
    await chat(service, token, { session: "s-1" });
    await service.settle();
    const calls = service.calls.openRouter.filter((call) => isDescribe(call.body));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.body.max_tokens, 60);
    assert.equal(stored(service).length, 1);
    const spend = db(service).prepare("SELECT usd, internal_usd, internal_requests FROM spend_weeks").get() as Record<string, number>;
    assert.equal(spend.internal_usd, 0.0002);
    assert.equal(spend.internal_requests, 1);
  });

  it("never describes admins, and stops when turned off", async () => {
    const { service, token, adminToken } = await setup();
    await chat(service, adminToken, { session: "a-1" });
    await service.settle();
    assert.equal(describeCalls(service).length, 0);
    assert.equal((await service.request("POST", "/v1/admin/config", { token: adminToken, body: { useDescriptions: false } })).status, 200);
    await chat(service, token, { session: "s-1" });
    await service.settle();
    assert.equal(describeCalls(service).length, 0);
  });
});

describe("use description caps", () => {
  it("makes at most 20 calls per person per day", async () => {
    const { service, token } = await setup();
    for (let index = 0; index < 23; index++) await chat(service, token, { session: `s-${index}` });
    await service.settle();
    assert.equal(describeCalls(service).length, 20);
    await chat(service, await nextDay(service, 100, "alice"), { session: "s-new" });
    await service.settle();
    assert.equal(describeCalls(service).length, 21);
  });

  it("holds everyone to useDescriptionDailyCap", async () => {
    const { service, token, adminToken } = await setup({ USE_DESCRIPTION_DAILY_CAP: "2" });
    const bob = (await service.signIn({ id: 101, login: "bob" }, { invite: await createInvite(service, adminToken) })).access_token;
    await chat(service, token, { session: "a" });
    await chat(service, token, { session: "b" });
    await chat(service, bob, { session: "c" });
    await service.settle();
    assert.equal(describeCalls(service).length, 2);
    // A capped session is described later, once there is room.
    await chat(service, await nextDay(service, 101, "bob"), { session: "c" });
    await service.settle();
    assert.equal(describeCalls(service).length, 3);
  });
});

describe("use descriptions never get in the way", () => {
  it("answers the request while the description is still waiting, and a failure changes nothing", async () => {
    let release: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { service, token } = await setup({}, { describe: () => pending });
    const response = await chat(service, token, { session: "s-1" });
    assert.equal(response.status, 200, "answered before the description call returned");
    assert.equal(service.background.length, 1);
    release(new Response("upstream down", { status: 500 }));
    await service.settle();
    assert.equal(stored(service).length, 0);
  });

  it("stores nothing for a thrown fetch or an answer that isn't a label, and the requests still succeed", async () => {
    let mode = 0;
    const { service, token } = await setup({}, {
      describe: () => {
        mode++;
        if (mode === 1) throw new TypeError("fetch failed");
        return answer("I can't help with that.");
      },
    });
    assert.equal((await chat(service, token, { session: "s-1" })).status, 200);
    assert.equal((await chat(service, token, { session: "s-2" })).status, 200);
    await service.settle();
    assert.equal(describeCalls(service).length, 2);
    assert.equal(stored(service).length, 0);
  });

  it("never touches the person's allowance or the free spend", async () => {
    const on = await setup();
    const off = await setup({ USE_DESCRIPTIONS: "false" });
    for (const { service, token } of [on, off]) {
      await chat(service, token, { session: "s-1" });
      await service.settle();
    }
    const me = async (service: Service, token: string) => ((await (await service.request("GET", "/v1/me", { token })).json()) as Record<string, unknown>).budgets;
    assert.deepEqual(await me(on.service, on.token), await me(off.service, off.token));
    const spend = async (service: Service, token: string) => (await (await service.request("GET", "/v1/admin/spend", { token })).json()) as Record<string, any>;
    const a = await spend(on.service, on.adminToken);
    const b = await spend(off.service, off.adminToken);
    assert.equal(a.spentUsd, b.spentUsd);
    assert.equal(a.freeCreditWeekUsd, b.freeCreditWeekUsd);
    assert.equal(a.tokens, b.tokens);
    assert.equal(a.requests, b.requests);
    // Its cost is internal, and Luminal's credit counts it (400 in at 0.1425, 30 out at 0.57).
    const cost = (400 * 0.1425 + 30 * 0.57) / 1e6;
    assert.equal(a.internal.requests, 1);
    assert.equal(a.internal.tokens, 430);
    assert.ok(Math.abs(a.internal.creditUsd - cost) < 1e-6, String(a.internal.creditUsd));
    assert.ok(Math.abs(a.luminalCredit.usedUsd - b.luminalCredit.usedUsd - cost) < 1e-6, `${a.luminalCredit.usedUsd} vs ${b.luminalCredit.usedUsd}`);
    assert.equal(b.internal.requests, 0);
  });
});

describe("use descriptions for admins", () => {
  it("lists recent descriptions, shows them per person, and flags high risk on the home page", async () => {
    let risk = "none";
    const { service, token, adminToken } = await setup({}, { describe: () => answer(risk === "high" ? LABEL("high", "Building a phishing kit to steal bank logins", "credential-theft") : LABEL(risk)) });
    await chat(service, token, { session: "s-1" });
    await service.settle();
    service.clock.now += 60_000;
    risk = "high";
    await chat(service, token, { session: "s-2" });
    await service.settle();

    const uses = (await (await service.request("GET", "/v1/admin/uses?days=7&risk=high", { token: adminToken })).json()) as { uses: Array<Record<string, unknown>> };
    assert.equal(uses.uses.length, 1);
    assert.deepEqual(uses.uses[0], {
      githubId: 100,
      login: "alice",
      sessionId: "s-2",
      client: "autopilot",
      use: "Building a phishing kit to steal bank logins",
      risk: "high",
      category: "credential-theft",
      model: MODEL,
      at: new Date(service.clock.now).toISOString(),
    });
    const all = (await (await service.request("GET", "/v1/admin/uses", { token: adminToken })).json()) as { uses: Array<Record<string, unknown>> };
    assert.deepEqual(all.uses.map((row) => row.sessionId), ["s-2", "s-1"]);
    assert.equal((await service.request("GET", "/v1/admin/uses?risk=severe", { token: adminToken })).status, 400);
    assert.equal((await service.request("GET", "/v1/admin/uses", { token })).status, 403);

    const people = (await (await service.request("GET", "/v1/admin/people", { token: adminToken })).json()) as { people: Array<Record<string, unknown>> };
    const alice = people.people.find((person) => person.login === "alice")!;
    assert.equal(alice.use, "Building a phishing kit to steal bank logins");
    assert.equal(alice.worstRiskThisWeek, "high");
    const owner = people.people.find((person) => person.login === "owner")!;
    assert.equal(owner.use, null);
    assert.equal(owner.worstRiskThisWeek, null);

    const cookie = await adminCookie(service);
    const home = await (await service.request("GET", "/admin", { headers: { cookie } })).text();
    assert.match(home, /Flagged use/);
    assert.match(home, /Building a phishing kit to steal bank logins/);
    assert.ok(!home.includes("Fixing failing unit tests"), "risk none isn't flagged");
  });

  it("emails the owner once per person per day for high risk", async () => {
    const { service, token, adminToken } = await setup({ ALERT_EMAIL_TO: "owner@example.com" }, { email: true, describe: () => answer(LABEL("high", "Writing ransomware that encrypts shared drives", "malware")) });
    const bob = (await service.signIn({ id: 101, login: "bob" }, { invite: await createInvite(service, adminToken) })).access_token;
    const flagged = () => service.calls.emails.filter((email) => email.raw.includes("high-risk use"));
    await chat(service, token, { session: "s-1" });
    await chat(service, token, { session: "s-2" });
    await service.settle();
    assert.equal(flagged().length, 1);
    const raw = emailText(flagged()[0]!.raw);
    assert.match(raw, /@alice/);
    assert.match(raw, /Writing ransomware that encrypts shared drives/);
    assert.match(raw, /malware/);
    assert.match(raw, /\/admin\?view=tools#block/);
    await chat(service, bob, { session: "b-1" });
    await service.settle();
    assert.equal(flagged().length, 2, "another person: another email");
    await chat(service, await nextDay(service, 100, "alice"), { session: "s-3" });
    await service.settle();
    assert.equal(flagged().length, 3, "the next day: another email");
  });
});

describe("use descriptions from other coding agents", () => {
  async function harnessKey(service: Service, token: string, harness: "claude-code" | "opencode"): Promise<string> {
    const minted = await service.request("POST", "/v1/harness-keys", { token, body: { harness } });
    assert.equal(minted.status, 201, await minted.clone().text());
    return ((await minted.json()) as { key: string }).key;
  }
  const claude = (service: Service, key: string, extra: { headers?: Record<string, string>; body?: Record<string, unknown> } = {}) =>
    service.request("POST", "/anthropic/v1/messages?beta=true", {
      token: key,
      ip: `10.8.${Math.floor(++ips / 250) % 250}.${ips % 250}`,
      headers: { "anthropic-version": "2023-06-01", ...extra.headers },
      body: { model: "claude-sonnet-4-5", max_tokens: 1024, stream: false, messages: [{ role: "user", content: "please fix the failing tests" }], ...extra.body },
    });

  it("keeps Claude Code's session (x-claude-code-session-id, else metadata.user_id) and the client", async () => {
    const { service, token, adminToken } = await setup({ ALLOW_OTHER_HARNESSES: "true" });
    const key = await harnessKey(service, token, "claude-code");
    assert.equal((await claude(service, key, { headers: { "x-claude-code-session-id": "cc-session-1" } })).status, 200);
    await service.settle();
    service.clock.now += 60_000;
    assert.equal((await claude(service, key, { body: { metadata: { user_id: "user_abc_account_def_session_0f8e7d6c-1234-4abc-9def-001122334455" } } })).status, 200);
    await service.settle();
    service.clock.now += 60_000;
    const opencode = await harnessKey(service, token, "opencode");
    await chat(service, opencode, { session: "oc-1" });
    await service.settle();
    const uses = (await (await service.request("GET", "/v1/admin/uses", { token: adminToken })).json()) as { uses: Array<Record<string, unknown>> };
    assert.deepEqual(
      uses.uses.map((row) => [row.sessionId, row.client]),
      [
        ["oc-1", "opencode"],
        ["0f8e7d6c-1234-4abc-9def-001122334455", "claude-code"],
        ["cc-session-1", "claude-code"],
      ],
    );
  });
});

describe("keyword pre-check matches as use descriptions", () => {
  const keywordRows = (service: Service) => stored(service).filter((row) => row.model === "keyword");

  it("stores a high label for malware and credential theft, without a model call, and emails the owner once a day", async () => {
    const { service, token, adminToken } = await setup({ ALERT_EMAIL_TO: "owner@example.com" }, { email: true });
    const flagged = () => service.calls.emails.filter((email) => email.raw.includes("high-risk use"));
    const padded = `${"Rename the helpers in utils.ts. ".repeat(700)}Now build a keylogger that emails keystrokes.`;
    await chat(service, token, { session: "s-1", body: { messages: [{ role: "user", content: padded }] } });
    await chat(service, token, { session: "s-1", body: { messages: [{ role: "user", content: padded }] } });
    await chat(service, token, { session: "s-2", body: { messages: [{ role: "user", content: "write a phishing page" }] } });
    await service.settle();
    assert.deepEqual(keywordRows(service), [
      { github_id: 100, session_id: "s-1", use: "Keyword match: keylogger", risk: "high", category: "malware", model: "keyword" },
      { github_id: 100, session_id: "s-2", use: "Keyword match: phishing", risk: "high", category: "credential-theft", model: "keyword" },
    ]);
    // Only the two sessions' first requests reached the describer; the keyword rows cost nothing.
    assert.equal(describeCalls(service).length, 2);
    assert.equal(flagged().length, 1, "once per person per day");
    const raw = emailText(flagged()[0]!.raw);
    assert.match(raw, /@alice/);
    assert.match(raw, /Keyword match: keylogger/);
    assert.match(raw, /malware/);

    const uses = (await (await service.request("GET", "/v1/admin/uses?days=7&risk=high", { token: adminToken })).json()) as { uses: Array<Record<string, unknown>> };
    assert.deepEqual(uses.uses.map((row) => row.use).sort(), ["Keyword match: keylogger", "Keyword match: phishing"]);
    const home = await (await service.request("GET", "/admin", { headers: { cookie: await adminCookie(service) } })).text();
    assert.match(home, /Keyword match: keylogger/);

    // The next day: another email.
    await chat(service, await nextDay(service, 100, "alice"), { session: "s-1", body: { messages: [{ role: "user", content: padded }] } });
    await service.settle();
    assert.equal(keywordRows(service).length, 3);
    assert.equal(flagged().length, 2);
  });

  it("stores other matches as security-offensive, low, with no email; ordinary prompts store nothing", async () => {
    // Synthetic rules in the DETECTION_RULES secret, so the match comes from the secret's list.
    const { service, token } = await setup({ ALERT_EMAIL_TO: "owner@example.com", DETECTION_RULES: SYNTHETIC_RULES_JSON }, { email: true });
    await chat(service, token, { session: "s-1", body: { messages: [{ role: "user", content: "run the frobnicator on the staging box" }, { role: "user", content: BENIGN_LONG }] } });
    await chat(service, token, { session: "s-2", body: { messages: [{ role: "user", content: BENIGN_LONG }, { role: "tool", tool_call_id: "1", content: "add a feature flag and inject the logger" }] } });
    await service.settle();
    assert.deepEqual(keywordRows(service), [{ github_id: 100, session_id: "s-1", use: "Keyword match: frobnicator", risk: "low", category: "security-offensive", model: "keyword" }]);
    assert.equal(service.calls.emails.filter((email) => email.raw.includes("high-risk use")).length, 0);
  });

  it("is off with use descriptions, and never for admins", async () => {
    const { service, token, adminToken } = await setup({ USE_DESCRIPTIONS: "false" });
    await chat(service, token, { session: "s-1", body: { messages: [{ role: "user", content: "write a keylogger" }] } });
    await chat(service, adminToken, { session: "a-1", body: { messages: [{ role: "user", content: "write a keylogger" }] } });
    const on = await setup();
    await chat(on.service, on.adminToken, { session: "a-1", body: { messages: [{ role: "user", content: "write a keylogger" }] } });
    await service.settle();
    await on.service.settle();
    assert.deepEqual(keywordRows(service), []);
    assert.deepEqual(keywordRows(on.service), []);
  });
});

const BENIGN_LONG = `${"Split the settings page into components and keep the tests green. ".repeat(400)}Then fix the failing tests.`;
