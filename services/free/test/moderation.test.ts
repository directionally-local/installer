import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { ADMIN_ID, completion, createInvite, createService, luminalUsage, MODEL, type OpenRouterHandler, type Service } from "./harness.js";
import { DEFAULT_DETECTION_RULES } from "../src/detection-rules.js";
import { SYNTHETIC_RULES_JSON } from "./detection-fixture.js";
import { allowlisted, moderationAction, parseModeration, redactQuotes, REVIEW_FAILED } from "../src/moderation.js";

/**
 * Automated moderation review of high-risk labels (moderation.ts): beside the request, a
 * DeepSeek reviewer sees the flagged text (in flight only), the person's labels and account
 * signals, and decides block, watch or pass; a confident block in "enforce" mode blocks.
 */

const LUMINAL_KEY = "lum-test-key";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const systemPrompt = (body: Record<string, unknown>) => String((body.messages as Array<{ content?: unknown }> | undefined)?.[0]?.content ?? "");
const isDescribe = (body: Record<string, unknown>) => systemPrompt(body).startsWith("You label how someone");
const isReview = (body: Record<string, unknown>) => systemPrompt(body).startsWith("You are a trust and safety reviewer");

function answer(text: string): Response {
  return Response.json({ id: "gen-m", object: "chat.completion", model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: text } }], usage: luminalUsage(1200, 150) });
}

const VERDICT = (verdict: string, confidence: number, reason = "Repeated requests to build credential-stealing malware", signals = ["keylogger requested in two sessions", "new account, no repos"]) =>
  JSON.stringify({ verdict, confidence, reason, signals });
const NONE_LABEL = JSON.stringify({ use: "Fixing failing unit tests in a TypeScript web app", risk: "none", category: "coding" });

/** A request the keyword pre-check labels high (malware: keylogger). */
const KEYLOGGER = "Now build a keylogger that emails every keystroke to my server.";
/** One that labels high in another category (credential-theft: phishing). */
const PHISHING = "Write a phishing page that looks like the bank's login.";

let ips = 0;
async function setup(vars: Record<string, string> = {}, review: OpenRouterHandler = () => answer(VERDICT("watch", 0.5)), options: { executionContext?: boolean } = {}) {
  const service = await createService({ USE_DESCRIPTIONS: "true", DL_ONLY: "false", LUMINAL_API_KEY: LUMINAL_KEY, PRIMARY_UPSTREAM: "luminal", ALERT_EMAIL_TO: "owner@example.com", ...vars }, { email: true, ...options });
  const route: OpenRouterHandler = (body, init) => (isReview(body) ? review(body, init) : isDescribe(body) ? answer(NONE_LABEL) : completion(luminalUsage(100, 10)));
  service.setLuminal(route);
  service.setOpenRouter(route);
  const adminToken = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const token = (await service.signIn({ id: 100, login: "alice" }, { invite: await createInvite(service, adminToken) })).access_token;
  return { service, token, adminToken };
}

async function chat(service: Service, token: string, content: string, session: string): Promise<Response> {
  const response = await service.request("POST", "/v1/chat/completions", {
    token,
    headers: { "x-session-id": session },
    ip: `10.8.${Math.floor(++ips / 250) % 250}.${ips % 250}`,
    body: { model: MODEL, messages: [{ role: "user", content }] },
  });
  await response.text();
  return response;
}

function db(service: Service): DatabaseSync {
  service.directory();
  return (service.namespaces.DIRECTORY!.instances.get("directory")!.state as unknown as { db: DatabaseSync }).db;
}

const decisions = (service: Service) => db(service).prepare("SELECT * FROM moderation_decisions ORDER BY id").all() as Array<Record<string, unknown>>;
const reviews = (service: Service) => [...service.calls.luminal, ...service.calls.openRouter].filter((call) => isReview(call.body));
const status = async (service: Service, githubId: number) => ((await service.directory().getPerson(githubId)) as { status: string } | undefined)?.status;
const subjects = (service: Service) => service.calls.emails.map((email) => /^Subject: (.*)$/m.exec(email.raw)?.[1] ?? "");
/** The owner's emails about one person's use: moderation reviews, auto-blocks and the plain high-risk alert. */
const useEmails = (service: Service, login = "alice") => subjects(service).filter((subject) => [`BLOCKED @${login}`, `your call on @${login}`, `@${login} not blocked`, `high-risk use by @${login}`].some((part) => subject.includes(part)));

describe("moderation decides and acts", () => {
  it("blocks at high confidence in enforce mode, revokes tokens, stores the decision and emails the owner", async () => {
    const { service, token, adminToken } = await setup({}, () => answer(VERDICT("block", 0.92)));
    const response = await chat(service, token, KEYLOGGER, "s-1");
    assert.equal(response.status, 200, "the person's own request still succeeds");
    await service.settle();
    assert.equal(reviews(service).length, 1);
    assert.equal(await status(service, 100), "blocked");
    const [row] = decisions(service);
    assert.equal(row!.verdict, "block");
    assert.equal(row!.confidence, 0.92);
    assert.equal(row!.action, "blocked");
    assert.equal(row!.category, "malware");
    assert.deepEqual(JSON.parse(String(row!.signals)), ["keylogger requested in two sessions", "new account, no repos"]);
    // The admin block's path: logged with "moderation" as who did it.
    const log = db(service).prepare("SELECT key, new_value, changed_by_login FROM config_log WHERE key LIKE 'person_status:%'").all() as Array<Record<string, unknown>>;
    assert.deepEqual(log.map((entry) => ({ ...entry })), [{ key: "person_status:100:alice", new_value: '"blocked"', changed_by_login: "moderation" }]);
    assert.ok(subjects(service).includes("dl free tier: BLOCKED @alice automatically (0.92)"), subjects(service).join(" | "));
    assert.equal(subjects(service).filter((subject) => subject.includes("high-risk use")).length, 0, "the review replaces the plain alert");
    // Blocked, and the old token revoked (401 before the block's 403 is even reached); a fresh
    // sign-in is refused as blocked, and unblocking doesn't bring the old token back.
    assert.equal((await chat(service, token, "hello", "s-2")).status, 401);
    await assert.rejects(service.signIn({ id: 100, login: "alice" }));
    assert.equal((await service.request("POST", `/v1/admin/people/100/unblock`, { token: adminToken })).status, 200);
    assert.notEqual((await chat(service, token, "hello", "s-3")).status, 200);
  });

  it("doesn't block below moderationBlockConfidence", async () => {
    const { service, token } = await setup({}, () => answer(VERDICT("block", 0.7)));
    await chat(service, token, KEYLOGGER, "s-1");
    await service.settle();
    assert.equal(await status(service, 100), "active");
    assert.equal(decisions(service)[0]!.action, "none");
    assert.ok(subjects(service).includes("dl free tier: your call on @alice: reviewer says block (0.70), not blocked"), subjects(service).join(" | "));
  });

  it("follows a changed moderationBlockConfidence", async () => {
    const { service, token, adminToken } = await setup({}, () => answer(VERDICT("block", 0.7)));
    assert.equal((await service.request("POST", "/v1/admin/config", { token: adminToken, body: { moderationBlockConfidence: 0.6 } })).status, 200);
    await chat(service, token, KEYLOGGER, "s-1");
    await service.settle();
    assert.equal(await status(service, 100), "blocked");
  });

  it("never blocks in shadow mode, but still decides and emails", async () => {
    const { service, token } = await setup({ MODERATION: "shadow" }, () => answer(VERDICT("block", 0.99)));
    await chat(service, token, KEYLOGGER, "s-1");
    await service.settle();
    assert.equal(await status(service, 100), "active");
    assert.equal(decisions(service)[0]!.action, "shadow");
    assert.ok(subjects(service).includes("dl free tier: @alice not blocked, reviewer says block (0.99)"));
    const mail = service.calls.emails.find((email) => email.raw.includes("@alice not blocked"))!;
    assert.match(emailText(mail.raw), /shadow/);
  });

  it("never blocks someone in moderationAllowlist, by login or by id", async () => {
    for (const entry of ["Alice", "100"]) {
      const { service, token } = await setup({ MODERATION_ALLOWLIST: `someone,${entry}` }, () => answer(VERDICT("block", 0.99)));
      await chat(service, token, KEYLOGGER, "s-1");
      await service.settle();
      assert.equal(await status(service, 100), "active", entry);
      assert.equal(decisions(service)[0]!.action, "allowlisted");
    }
  });

  it("never blocks admins", () => {
    // Admins' requests are never labelled, so this guard is the decision's own.
    const block = { verdict: "block" as const, confidence: 0.99, reason: "x", signals: [] };
    assert.equal(moderationAction({ answer: block, mode: "enforce", threshold: 0.85, isAdmin: true, allowlisted: false, alreadyBlocked: false }), "admin");
    assert.equal(moderationAction({ answer: block, mode: "enforce", threshold: 0.85, isAdmin: false, allowlisted: false, alreadyBlocked: false }), "blocked");
    assert.equal(moderationAction({ answer: block, mode: "enforce", threshold: 0.85, isAdmin: false, allowlisted: false, alreadyBlocked: true }), "already_blocked");
    assert.equal(moderationAction({ answer: { ...block, verdict: "watch" }, mode: "enforce", threshold: 0.85, isAdmin: false, allowlisted: false, alreadyBlocked: false }), "none");
    assert.ok(allowlisted(["octocat", "42"], 42, "x"));
    assert.ok(allowlisted(["octocat"], 1, "OctoCat"));
    assert.ok(!allowlisted(["octocat"], 1, "other"));
  });

  it("takes a malformed answer, an error or a timeout as watch with confidence 0, and never blocks", async () => {
    for (const reply of [() => answer("I can't help with that."), () => answer(VERDICT("block", 1.5)), () => answer('{"verdict":"block","confidence":0.99'), () => new Response("down", { status: 500 })]) {
      const { service, token } = await setup({}, reply);
      assert.equal((await chat(service, token, KEYLOGGER, "s-1")).status, 200);
      await service.settle();
      assert.equal(await status(service, 100), "active");
      const [row] = decisions(service);
      assert.deepEqual({ verdict: row!.verdict, confidence: row!.confidence, reason: row!.reason, action: row!.action }, { verdict: "watch", confidence: 0, reason: "review failed", action: "none" });
      assert.ok(subjects(service).includes("dl free tier: @alice not blocked, reviewer says watch (0.00)"), subjects(service).join(" | "));
    }
  });

  it("retries an empty answer once with more room to reason, and uses the second answer", async () => {
    const budgets: number[] = [];
    let calls = 0;
    const reply: OpenRouterHandler = (body) => {
      const tokens = (body as { max_tokens?: number; max_completion_tokens?: number }).max_tokens ?? (body as { max_completion_tokens?: number }).max_completion_tokens ?? 0;
      const isReview = JSON.stringify(body).includes("verdict");
      if (!isReview) return answer(VERDICT("pass", 0.9));
      budgets.push(tokens);
      calls++;
      if (calls === 1) return Response.json({ id: "gen-m", object: "chat.completion", model: MODEL, choices: [{ index: 0, finish_reason: "length", message: { role: "assistant", content: "" } }], usage: luminalUsage(1200, tokens) });
      return answer(VERDICT("block", 0.95));
    };
    const { service, token } = await setup({}, reply);
    await chat(service, token, KEYLOGGER, "s-1");
    await service.settle();
    assert.equal(calls, 2, "one retry");
    assert.ok(budgets[1]! > budgets[0]!, `the retry has more room (${budgets.join(" < ")})`);
    const [row] = decisions(service);
    assert.equal(row!.verdict, "block");
    assert.equal(row!.error, null);
  });

  it("stores and logs why a review failed, as a code and never the request's text", async (t) => {
    const empty = () => Response.json({ id: "gen-m", object: "chat.completion", model: MODEL, choices: [{ index: 0, finish_reason: "length", message: { role: "assistant", content: "" } }], usage: luminalUsage(1200, 1600) });
    const cases: Array<[OpenRouterHandler, string]> = [
      [() => answer("I can't help with that."), "unparsable"],
      [() => new Response("down", { status: 503 }), "http_503"],
      [empty, "empty_answer"],
      [() => Promise.reject(new TypeError("network connection lost")), "network"],
    ];
    for (const [reply, code] of cases) {
      const errors = t.mock.method(console, "error", () => undefined);
      const { service, token, adminToken } = await setup({}, reply);
      await chat(service, token, KEYLOGGER, "s-1");
      await service.settle();
      errors.mock.restore();
      assert.equal(decisions(service)[0]!.error, code);
      const logged = errors.mock.calls.map((call) => call.arguments.map(String).join(" "));
      assert.ok(logged.some((line) => line.startsWith(`moderation review failed: ${code}`)), logged.join(" | "));
      assert.ok(!logged.some((line) => line.includes("keylogger") || line.includes("keystroke")), "no request text in the log");
      const listed = (await (await service.request("GET", "/v1/admin/moderation", { token: adminToken })).json()) as { decisions: Array<{ error: string | null }> };
      assert.equal(listed.decisions[0]!.error, code);
    }
    // A review that worked has no error.
    const { service, token } = await setup({}, () => answer(VERDICT("pass", 0.9)));
    await chat(service, token, KEYLOGGER, "s-1");
    await service.settle();
    assert.equal(decisions(service)[0]!.error, null);
  });

  it("sends no email for pass, and counts it", async () => {
    const { service, token } = await setup({}, () => answer(VERDICT("pass", 0.9, "Writing a keylogger detector for their own security course")));
    await chat(service, token, KEYLOGGER, "s-1");
    await service.settle();
    assert.equal(decisions(service)[0]!.verdict, "pass");
    assert.deepEqual(useEmails(service), []);
    // The next morning's daily digest counts it.
    const { DIGEST_CRON } = await import("../src/app.js");
    const at = (Math.floor(service.clock.now / DAY) + 1) * DAY + HOUR;
    service.clock.now = at;
    await (service.handler as unknown as { scheduled(controller: { cron: string; scheduledTime: number }, env: never): Promise<void> }).scheduled({ cron: DIGEST_CRON, scheduledTime: at }, service.env as never);
    const digest = service.calls.emails.map((email) => emailText(email.raw)).find((text) => text.includes("daily digest"));
    assert.ok(digest, "a digest was sent");
    assert.match(digest, /Moderation reviews: 1 \(0 block, 0 watch, 1 pass\), 0 auto-blocked/);
  });

  it("emails a watch at most once per person per day, but always stores the decision", async () => {
    const { service, token } = await setup({ MODERATION_COOLDOWN_MINUTES: "0" });
    await chat(service, token, KEYLOGGER, "s-1");
    await chat(service, token, KEYLOGGER, "s-2");
    await service.settle();
    assert.equal(decisions(service).length, 2);
    assert.equal(useEmails(service).length, 1);
  });

  it("does today's plain alert with moderation off", async () => {
    const { service, token } = await setup({ MODERATION: "off" });
    await chat(service, token, KEYLOGGER, "s-1");
    await service.settle();
    assert.equal(reviews(service).length, 0);
    assert.equal(decisions(service).length, 0);
    assert.ok(subjects(service).includes("dl free tier: high-risk use by @alice"));
  });
});

describe("moderation limits", () => {
  it("reviews a person once per cooldown, unless the category is new", async () => {
    const { service, token } = await setup();
    await chat(service, token, KEYLOGGER, "s-1");
    await service.settle();
    service.clock.now += 10 * MINUTE;
    await chat(service, token, KEYLOGGER, "s-2");
    await service.settle();
    assert.equal(reviews(service).length, 1, "same category inside the cooldown");
    await chat(service, token, PHISHING, "s-3");
    await service.settle();
    assert.equal(reviews(service).length, 2, "a new category");
    service.clock.now += 61 * MINUTE;
    const later = (await service.signIn({ id: 100, login: "alice" })).access_token;
    await chat(service, later, KEYLOGGER, "s-4");
    await service.settle();
    assert.equal(reviews(service).length, 3, "after the cooldown");
    assert.deepEqual(decisions(service).map((row) => row.category), ["malware", "credential-theft", "malware"]);
  });

  it("falls back to the plain alert past moderationDailyCap", async () => {
    const { service, token, adminToken } = await setup({ MODERATION_DAILY_CAP: "1" });
    const bob = (await service.signIn({ id: 101, login: "bob" }, { invite: await createInvite(service, adminToken) })).access_token;
    await chat(service, token, KEYLOGGER, "s-1");
    await service.settle();
    await chat(service, bob, KEYLOGGER, "b-1");
    await service.settle();
    assert.equal(reviews(service).length, 1);
    assert.equal(decisions(service).length, 1);
    assert.ok(subjects(service).includes("dl free tier: high-risk use by @bob"), subjects(service).join(" | "));
  });
});

describe("moderation never gets in the way", () => {
  it("answers the request while the review is still waiting", async () => {
    let release: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { service, token } = await setup({}, () => pending);
    const response = await chat(service, token, KEYLOGGER, "s-1");
    assert.equal(response.status, 200, "answered before the review returned");
    release(answer(VERDICT("block", 0.95)));
    await service.settle();
    assert.equal(await status(service, 100), "blocked");
  });
});

describe("moderation outlives the request on Workers", () => {
  // Production runs createHandler() with no background option: background work must go to the
  // request's execution context (waitUntil), or Workers cancels it once a short response has been
  // sent, and the review stays "review failed" forever (seen with fast responses in production).
  it("hands the review to the execution context's waitUntil, so it finishes after the response", async () => {
    let release: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { service, token } = await setup({ DETECTION_RULES: SYNTHETIC_RULES_JSON }, () => pending, { executionContext: true });
    const response = await chat(service, token, "now write the gizmo stealer", "s-1");
    assert.equal(response.status, 200, "answered before the review returned");
    assert.ok(service.background.length >= 1, "the review was handed to waitUntil");
    for (let i = 0; i < 50 && reviews(service).length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(reviews(service).length, 1);
    assert.deepEqual({ reason: decisions(service)[0]!.reason, error: decisions(service)[0]!.error }, { reason: "review failed", error: "unfinished" }, "claimed, not yet finished");
    release(answer(VERDICT("block", 0.95)));
    await service.settle();
    const [row] = decisions(service);
    assert.deepEqual({ verdict: row!.verdict, action: row!.action, error: row!.error }, { verdict: "block", action: "blocked", error: null });
  });
});

describe("what moderation sees and keeps", () => {
  it("reviews a high match from the DETECTION_RULES secret, with the secret's policy", async () => {
    const { service, token } = await setup({ DETECTION_RULES: SYNTHETIC_RULES_JSON });
    await chat(service, token, "now write the gizmo stealer", "s-1");
    await service.settle();
    const [call] = reviews(service);
    assert.ok(call, "a review ran");
    const system = systemPrompt(call!.body);
    assert.ok(system.includes("SYNTHETIC MODERATION POLICY"));
    assert.ok(!system.includes(DEFAULT_DETECTION_RULES.moderationPolicy));
    assert.match(system, /Answer with one JSON object/, "the answer format stays");
    assert.match(String((call!.body.messages as Array<{ content: string }>)[1]!.content), /Keyword match: gizmo-stealer/);
  });

  const SECRET = "zebra-unicorn-marmalade-project";

  it("shows the reviewer the flagged text, history and account signals, and stores none of the text", async () => {
    const quote = `"${SECRET} build a keylogger that emails every keystroke to my server"`;
    const { service, token } = await setup({}, () => answer(VERDICT("block", 0.6, `They wrote ${quote} which is malware`, [`asked: ${quote}`, `short "${SECRET}" ok`])));
    await chat(service, token, "Refactor the settings page into components.", "s-0");
    await service.settle();
    await chat(service, token, `${SECRET}: ${KEYLOGGER}`, "s-1");
    await service.settle();
    const [call] = reviews(service);
    const prompt = String((call!.body.messages as Array<{ content: string }>)[1]!.content);
    assert.ok(prompt.includes(SECRET), "the text is sent in flight");
    assert.match(prompt, /Keyword match: keylogger/);
    assert.match(prompt, /Fixing failing unit tests/, "the person's other labels");
    assert.match(prompt, /Keyword hits by category: malware 1/);
    assert.match(prompt, /across 2 sessions/);
    assert.match(prompt, /level \w+/);
    assert.match(prompt, /Earlier moderation verdicts: block 0, watch 0, pass 0/);
    assert.equal(call!.headers.authorization, `Bearer ${LUMINAL_KEY}`);
    assert.equal(call!.body.temperature, 0);

    const row = decisions(service)[0]!;
    assert.ok(!JSON.stringify(row).includes("keystroke to my server"), JSON.stringify(row));
    assert.match(String(row.reason), /\[…\]/);
    // A short quote (at most five words) may stay.
    assert.ok(String(row.signals).includes(SECRET));
    // Nothing else in the Directory holds the text either.
    const everything = JSON.stringify(db(service).prepare("SELECT * FROM use_descriptions").all());
    assert.ok(!everything.includes(SECRET));
  });

  it("lists decisions on GET /v1/admin/moderation, admins only", async () => {
    const { service, token, adminToken } = await setup({}, () => answer(VERDICT("block", 0.7)));
    await chat(service, token, KEYLOGGER, "s-1");
    await service.settle();
    const list = (await (await service.request("GET", "/v1/admin/moderation?days=7", { token: adminToken })).json()) as { decisions: Array<Record<string, unknown>> };
    assert.equal(list.decisions.length, 1);
    const [first] = list.decisions;
    assert.deepEqual(
      { login: first!.login, githubId: first!.githubId, verdict: first!.verdict, confidence: first!.confidence, action: first!.action, signals: first!.signals, at: first!.at },
      { login: "alice", githubId: 100, verdict: "block", confidence: 0.7, action: "none", signals: ["keylogger requested in two sessions", "new account, no repos"], at: new Date(service.clock.now).toISOString() },
    );
    assert.equal(first!.reason, "Repeated requests to build credential-stealing malware");
    const watch = (await (await service.request("GET", "/v1/admin/moderation?verdict=watch", { token: adminToken })).json()) as { decisions: unknown[] };
    assert.equal(watch.decisions.length, 0);
    assert.equal((await service.request("GET", "/v1/admin/moderation?verdict=maybe", { token: adminToken })).status, 400);
    assert.equal((await service.request("GET", "/v1/admin/moderation?days=0", { token: adminToken })).status, 400);
    assert.equal((await service.request("GET", "/v1/admin/moderation", { token })).status, 403);
  });
});

describe("moderation settings and parsing", () => {
  it("validates its runtime settings", async () => {
    const { service, adminToken } = await setup();
    const set = (body: Record<string, unknown>) => service.request("POST", "/v1/admin/config", { token: adminToken, body });
    assert.equal((await set({ moderation: "shadow", moderationAllowlist: ["Octocat", "42"], moderationCooldownMinutes: 5, moderationDailyCap: 10 })).status, 200);
    const view = (await (await service.request("GET", "/v1/admin/config", { token: adminToken })).json()) as { effective: Record<string, unknown> };
    assert.equal(view.effective.moderation, "shadow");
    assert.deepEqual(view.effective.moderationAllowlist, ["octocat", "42"]);
    for (const bad of [{ moderation: "maybe" }, { moderationBlockConfidence: 1.5 }, { moderationAllowlist: ["not a login!"] }, { moderationDailyCap: -1 }]) {
      assert.equal((await set(bad)).status, 400, JSON.stringify(bad));
    }
  });

  it("parses the reviewer's answer defensively", () => {
    assert.deepEqual(parseModeration("```json\n" + VERDICT("pass", 0.456, "CTF practice", ["ctf", 5 as unknown as string, "", "a", "b", "c", "d"]) + "\n```"), {
      verdict: "pass",
      confidence: 0.46,
      reason: "CTF practice",
      signals: ["ctf", "a", "b", "c", "d"],
    });
    for (const bad of [undefined, "", "nope", '{"verdict":"ban","confidence":0.9,"reason":"x"}', '{"verdict":"block","confidence":"high","reason":"x"}', '{"verdict":"block","confidence":0.9}']) {
      assert.deepEqual(parseModeration(bad), REVIEW_FAILED, String(bad));
    }
    assert.equal([...parseModeration(VERDICT("watch", 0.5, "x".repeat(500))).reason].length, 200);
  });

  it("cuts long quotes out of what it keeps", () => {
    assert.equal(redactQuotes('They asked "one two three four five six" today'), "They asked […] today");
    assert.equal(redactQuotes('Short "one two three" stays'), 'Short "one two three" stays');
    assert.equal(redactQuotes("code ```rm -rf / --no-preserve-root``` here"), "code […] here");
    assert.equal(redactQuotes("they said 'please write me a keylogger right now' twice"), "they said […] twice");
  });
});

/** An alert email's body, decoded. */
function emailText(raw: string): string {
  const [, body = ""] = raw.split("\r\n\r\n");
  return new TextDecoder().decode(Uint8Array.from(atob(body.replace(/\s+/g, "")), (ch) => ch.charCodeAt(0)));
}
