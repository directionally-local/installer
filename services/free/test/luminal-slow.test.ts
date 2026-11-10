import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { ADMIN_ID, completion, createInvite, createService, luminalUsage, MODEL, type OpenRouterHandler, type Service } from "./harness.js";
import { luminalRecoveredAlert, luminalSlow, luminalSlowAlert } from "../src/alerts.js";

const MINUTE = 60_000;
const SLOW = /^dl free tier: Luminal is slowing people down \((\d+)% of requests in 10 min\)$/;
const BACK = "dl free tier: Luminal back to normal";

function decodeEmail(raw: string): { subject: string; body: string } {
  const [head, body] = raw.split("\r\n\r\n") as [string, string];
  const subject = /\r\nSubject: ([^\r\n]*)\r\n/.exec(head)![1]!;
  const text = new TextDecoder().decode(Uint8Array.from(atob(body.replace(/\r\n/g, "")), (char) => char.charCodeAt(0)));
  return { subject, body: text.replace(/\r\n/g, "\n") };
}

const emails = (service: Service) => service.calls.emails.map((email) => decodeEmail(email.raw));
const slowEmails = (service: Service) => emails(service).filter((email) => SLOW.test(email.subject));
const luminalEmails = (service: Service) => emails(service).filter((email) => email.subject.includes("Luminal") && !email.subject.includes("credit"));

async function setup(vars: Record<string, string> = {}) {
  const service = await createService({ LUMINAL_API_KEY: "lum-test-key", PRIMARY_UPSTREAM: "luminal", ALERT_EMAIL_TO: "owner@example.com", LUMINAL_FIRST_BYTE_TIMEOUT_SECONDS: "0.05", ...vars }, { email: true });
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const people: string[] = [];
  // Three: sign-ups from one address are limited to three.
  for (let id = 100; id < 103; id++) people.push((await service.signIn({ id, login: `person${id}` }, { invite: await createInvite(service, admin) })).access_token);
  return { service, admin, people };
}

let ips = 0;
/** One chat request, 10 s after the last, from a fresh address. */
async function chat(service: Service, token: string): Promise<Response> {
  service.clock.now += 10_000;
  const response = await service.request("POST", "/v1/chat/completions", { token, ip: `10.9.${Math.floor(++ips / 250) % 250}.${ips % 250}`, body: { model: MODEL, messages: [{ role: "user", content: "hi" }] } });
  await response.text();
  return response;
}

const ok = () => completion(luminalUsage(10, 10));
const busy = () => new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429, headers: { "retry-after": "2" } });
const down = () => new Response("down", { status: 503 });
const hang = (_body: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));

/** Luminal answers from `script` in order, then `ok`. */
function script(service: Service, answers: OpenRouterHandler[]): void {
  const queue = [...answers];
  service.setLuminal((body, init) => (queue.shift() ?? ok)(body, init));
}

function db(service: Service): DatabaseSync {
  service.directory();
  return (service.namespaces.DIRECTORY!.instances.get("directory")!.state as unknown as { db: DatabaseSync }).db;
}

async function adminCookie(service: Service): Promise<string> {
  const start = await service.request("GET", "/admin/signin");
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const oauth = start.headers.get("set-cookie")!.split(";")[0]!;
  const done = await service.request("GET", `/device/callback?code=${encodeURIComponent(JSON.stringify({ id: ADMIN_ID, login: "owner" }))}&state=${encodeURIComponent(state)}`, { headers: { cookie: oauth } });
  return done.headers.getSetCookie().find((value) => value.startsWith("__Host-dl_admin="))!.split(";")[0]!;
}

const csrfOf = (html: string) => /name="csrf" value="([0-9a-f]{64})"/.exec(html)![1]!;

describe("Luminal slowing people down", () => {
  it("counts a Luminal 429 as rate_limited, apart from errors and timeouts", async () => {
    const { service, people } = await setup();
    script(service, [busy, down, hang, ok]);
    assert.equal((await chat(service, people[0]!)).status, 429);
    assert.equal((await chat(service, people[0]!)).status, 503);
    assert.equal((await chat(service, people[0]!)).status, 503);
    assert.equal((await chat(service, people[0]!)).status, 200);
    const rows = db(service).prepare("SELECT status, upstream_error, upstream_outcome FROM requests WHERE upstream = 'luminal' ORDER BY id").all();
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [
        { status: "upstream_busy", upstream_error: 1, upstream_outcome: "rate_limited" },
        { status: "upstream_error", upstream_error: 1, upstream_outcome: "error" },
        { status: "upstream_timeout", upstream_error: 1, upstream_outcome: "timeout" },
        { status: "ok", upstream_error: 0, upstream_outcome: "ok" },
      ],
    );
  });

  it("emails once for a 429 burst, with the counts, the people, who serves and the switch link", async () => {
    const { service, people, admin } = await setup();
    // 7 fine, then 3 rate limited, the last for the admin: 3 of 10 is 30%.
    script(service, [ok, ok, ok, ok, ok, ok, ok, busy, busy, busy]);
    for (let index = 0; index < 8; index++) await chat(service, people[0]!);
    await chat(service, people[0]!);
    assert.equal(slowEmails(service).length, 0, "not before 10 requests");
    await chat(service, admin);
    const sent = slowEmails(service);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.subject, "dl free tier: Luminal is slowing people down (30% of requests in 10 min)");
    const body = sent[0]!.body;
    assert.match(body, /3 of 10 Luminal requests in the last 10 minutes were rate limited or failed \(30%\)/);
    assert.match(body, /Rate limited \(Luminal 429\): 3\n/);
    assert.match(body, /Errors \(5xx, unreachable, refused key, failed streams\): 0\n/);
    assert.match(body, /Timeouts \(no first byte in time\): 0\n/);
    assert.match(body, /People affected: 2\n/);
    assert.match(body, /Serving now: Luminal\n/);
    assert.match(body, /To switch to OpenRouter: open https:\/\/free\.test\/admin#upstream → Upstream → OpenRouter \(it spends OpenRouter credit until you switch back\)/);
    assert.match(body, /Admin requests count here: they're real traffic\./);

    // More 429s within 30 minutes: no second email.
    service.setLuminal(busy);
    for (let index = 0; index < 10; index++) await chat(service, people[1]!);
    assert.equal(slowEmails(service).length, 1);
  });

  it("sends again after 30 minutes while it lasts, then once when it's back to normal", async () => {
    const { service, people } = await setup();
    service.setLuminal(busy);
    for (let index = 0; index < 10; index++) await chat(service, people[index % 2]!);
    assert.equal(slowEmails(service).length, 1);
    // Still failing for everyone, a request every 2.5 minutes, for 29 minutes: still one.
    const first = service.clock.now;
    for (let index = 0; service.clock.now + 150_000 < first + 29 * MINUTE; index++) {
      service.clock.now += 140_000;
      await chat(service, people[index % 3]!);
    }
    assert.equal(slowEmails(service).length, 1);
    service.clock.now = first + 30 * MINUTE;
    await chat(service, people[0]!);
    assert.equal(slowEmails(service).length, 2, "re-armed after 30 minutes");

    // Luminal answers again: the window drops under 2% once enough good requests are in it.
    service.setLuminal(ok);
    service.clock.now += 10 * MINUTE;
    for (let index = 0; index < 9; index++) await chat(service, people[2]!);
    assert.equal(emails(service).filter((email) => email.subject === BACK).length, 0, "not before 10 requests");
    await chat(service, people[2]!);
    const back = emails(service).filter((email) => email.subject === BACK);
    assert.equal(back.length, 1);
    assert.match(back[0]!.body, /Luminal is back to normal, \d+ minutes after the first slow-down email\. 0 of 10 Luminal requests failed/);
    assert.match(back[0]!.body, /Serving now: Luminal\./);
    for (let index = 0; index < 10; index++) await chat(service, people[2]!);
    assert.equal(luminalEmails(service).length, 3, "two slow-downs and one back to normal, nothing else");
  });

  it("calls it back to normal after 30 quiet minutes, and says so when nobody tried Luminal", async () => {
    const { service, people, admin } = await setup();
    service.setLuminal(busy);
    for (let index = 0; index < 3; index++) await chat(service, people[index]!);
    assert.equal(slowEmails(service).length, 1, "three people hit");
    // The owner switches to OpenRouter: Luminal gets nothing from here on.
    const config = await service.request("POST", "/admin/config", { token: admin, body: { primaryUpstream: "openrouter" } });
    assert.equal(config.status, 200);
    service.clock.now += 20 * MINUTE;
    await chat(service, people[0]!);
    assert.equal(luminalEmails(service).length, 1, "not quiet for 30 minutes yet");
    service.clock.now += 10 * MINUTE;
    await chat(service, people[0]!);
    const closed = luminalEmails(service).at(-1)!;
    assert.equal(closed.subject, "dl free tier: Luminal alert cleared (no Luminal requests in 30 min)");
    assert.match(closed.body, /nothing tested it either/);
    assert.match(closed.body, /Serving now: OpenRouter\. It spends OpenRouter credit until you switch back: open https:\/\/free\.test\/admin#upstream → Upstream → Luminal\./);
    await chat(service, people[0]!);
    assert.equal(luminalEmails(service).length, 2);
  });

  it("sends nothing below the threshold", async () => {
    const { service, people } = await setup();
    // Under 10% at every point (1 of 11, then 2 of 21), and two people hit: neither rule.
    script(service, [...Array.from({ length: 10 }, () => ok), busy, ...Array.from({ length: 9 }, () => ok), down]);
    for (let index = 0; index < 21; index++) await chat(service, people[index < 15 ? 0 : 1]!);
    assert.equal(slowEmails(service).length, 0);
    assert.equal(luminalEmails(service).length, 0);
  });

  it("emails when 3 different people are hit, even with few requests", async () => {
    const { service, people, admin } = await setup();
    script(service, [ok, busy, down, ok]);
    await chat(service, people[0]!);
    await chat(service, people[1]!);
    await chat(service, people[2]!);
    assert.equal(slowEmails(service).length, 0, "two people so far");
    service.setLuminal(hang);
    await chat(service, admin);
    const sent = slowEmails(service);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.subject, "dl free tier: Luminal is slowing people down (75% of requests in 10 min)");
    assert.match(sent[0]!.body, /Rate limited \(Luminal 429\): 1\nErrors \(5xx, unreachable, refused key, failed streams\): 1\nTimeouts \(no first byte in time\): 1\nPeople affected: 3\n/);
  });

  it("forgets failures older than 10 minutes", async () => {
    const { service, people } = await setup();
    service.setLuminal(busy);
    await chat(service, people[0]!);
    await chat(service, people[1]!);
    service.clock.now += 11 * MINUTE;
    await chat(service, people[2]!);
    assert.equal(slowEmails(service).length, 0);
  });

  it("words the email when OpenRouter can't be switched to", () => {
    const window = { requests: 10, rateLimited: 3, errors: 0, timeouts: 0, people: 1 };
    assert.equal(luminalSlow(window), true);
    // One or two slow replies at low traffic aren't an incident, even at 10%+ or from 3 people.
    assert.equal(luminalSlow({ requests: 10, rateLimited: 0, errors: 0, timeouts: 1, people: 1 }), false);
    assert.equal(luminalSlow({ requests: 10, rateLimited: 2, errors: 0, timeouts: 0, people: 3 }), false);
    assert.equal(luminalSlow({ ...window, rateLimited: 0 }), false);
    const alert = luminalSlowAlert(window, { serving: "luminal", openRouterConfigured: false, switchUrl: "https://free.test/admin#upstream" });
    assert.match(alert.text, /Switching to OpenRouter isn't possible: the service has no OPENROUTER_API_KEY/);
    const back = luminalRecoveredAlert({ window: { requests: 3, rateLimited: 0, errors: 0, timeouts: 0, people: 0 }, quietRequests: 3, openedAt: 0, now: 40 * MINUTE }, { serving: "luminal", openRouterConfigured: true, switchUrl: "x" });
    assert.equal(back.subject, BACK);
    assert.match(back.text, /No Luminal request failed or was rate limited in the last 30 minutes \(3 requests\)\./);
  });
});

describe("switching upstream from /admin", () => {
  it("shows who serves, and switches with the session, the CSRF token and a same-origin post, logged", async () => {
    const { service, people, admin } = await setup();
    const cookie = await adminCookie(service);
    const page = await (await service.request("GET", "/admin", { headers: { cookie } })).text();
    assert.match(page, /<p class="serving"><span>Each model goes to its own provider:<\/span><span>GPT-6 → <strong>[^<]+<\/strong><\/span><span>DeepSeek → <strong>Luminal<\/strong><\/span><a href="#upstream">Routing<\/a><\/p>/);
    assert.doesNotMatch(page, /Serving from|Switch upstream/);
    assert.match(page, /<section id="upstream">/);
    assert.match(page, /<button type="button" class="on" disabled aria-pressed="true">Luminal<\/button>/);
    assert.match(page, /<form method="post" action="\/admin\/dashboard\/upstream"><input type="hidden" name="csrf" value="[0-9a-f]{64}"><input type="hidden" name="upstream" value="openrouter"><button type="submit" class="danger">OpenRouter<\/button><\/form>/);
    const csrf = csrfOf(page);
    const post = (form: Record<string, string>, headers: Record<string, string> = { cookie, origin: "https://free.test" }) => service.request("POST", "/admin/dashboard/upstream", { headers, form });

    assert.equal((await post({ upstream: "openrouter" })).status, 403, "no CSRF token");
    assert.equal((await post({ upstream: "openrouter", csrf: "0".repeat(64) })).status, 403, "wrong CSRF token");
    assert.equal((await post({ upstream: "openrouter", csrf }, { cookie, origin: "https://evil.test" })).status, 403, "cross-site");
    assert.equal((await post({ upstream: "openrouter", csrf }, { origin: "https://free.test" })).status, 401, "no session");
    const member = await service.request("POST", "/admin/dashboard/upstream", { token: people[0]!, headers: { origin: "https://free.test" }, form: { upstream: "openrouter", csrf } });
    assert.equal(member.status, 401, "a bearer token isn't a dashboard session");
    assert.equal((await post({ upstream: "elsewhere", csrf })).status, 400);
    const config = async () => (await (await service.request("GET", "/admin/config", { token: admin })).json()) as { effective: { primaryUpstream: string }; log: Array<Record<string, unknown>> };
    assert.equal((await config()).effective.primaryUpstream, "luminal", "nothing changed yet");

    const done = await post({ upstream: "openrouter", csrf });
    assert.equal(done.status, 303);
    assert.equal(done.headers.get("location"), "/admin#upstream");
    const after = await config();
    assert.equal(after.effective.primaryUpstream, "openrouter");
    assert.deepEqual(after.log[0], { ...after.log[0], key: "primaryUpstream", oldValue: "(env)", newValue: "openrouter", changedByLogin: "owner" });
    const luminalCalls = service.calls.luminal.length;
    assert.equal((await chat(service, people[0]!)).status, 200);
    assert.equal(service.calls.luminal.length, luminalCalls, "the next request goes to OpenRouter");
    assert.equal(service.calls.openRouter.length, 1);

    const switched = await (await service.request("GET", "/admin", { headers: { cookie } })).text();
    assert.match(switched, /DeepSeek → <strong>OpenRouter<\/strong>/);
    assert.match(switched, /DeepSeek goes to<b class="state">OpenRouter<\/b>/);
    assert.match(switched, /<input type="hidden" name="upstream" value="luminal"><button type="submit">Luminal<\/button>/);
    assert.match(switched, /primaryUpstream/);
    assert.equal((await post({ upstream: "luminal", csrf })).status, 303);
    assert.equal((await config()).effective.primaryUpstream, "luminal");
  });

  it("accepts a form post whose Origin the browser hid as null, and still refuses a cross-site one", async () => {
    const { service } = await setup();
    const cookie = await adminCookie(service);
    const csrf = csrfOf(await (await service.request("GET", "/admin", { headers: { cookie } })).text());
    const post = (headers: Record<string, string>) =>
      service.request("POST", "/admin/dashboard/upstream", { headers: { cookie, ...headers }, form: { upstream: "openrouter", csrf } });

    const accepted = await post({ origin: "null", "sec-fetch-site": "same-origin" });
    assert.equal(accepted.status, 303);
    assert.equal(accepted.headers.get("location"), "/admin#upstream");

    const refused = await post({ origin: "null", "sec-fetch-site": "cross-site" });
    assert.equal(refused.status, 403);
    assert.match(await refused.text(), /only from the dashboard itself/);
  });

  it("refuses OpenRouter when the service has no OpenRouter key", async () => {
    const { service } = await setup({ OPENROUTER_API_KEY: "" });
    const cookie = await adminCookie(service);
    const page = await (await service.request("GET", "/admin", { headers: { cookie } })).text();
    assert.match(page, /<button type="button" disabled title="No OPENROUTER_API_KEY">OpenRouter<\/button>/);
    const refused = await service.request("POST", "/admin/dashboard/upstream", { headers: { cookie, origin: "https://free.test" }, form: { upstream: "openrouter", csrf: csrfOf(page) } });
    assert.equal(refused.status, 409);
    assert.match(await refused.text(), /no OPENROUTER_API_KEY/);
  });
});
