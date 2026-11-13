import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ADMIN_ID, completion, createService, MODEL, NOW, startBrowserFlow, usage, type Service } from "./harness.js";
import { policyOf } from "../src/queue.js";
import { readFreeConfig } from "../src/config.js";
import { FOOTER, renderUserEmail, resetsText, USER_EMAILS } from "../src/user-emails.js";

// After the harness: app.js loads cloudflare:workers, which the harness resolves.
const { DIGEST_CRON } = await import("../src/app.js");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The daily run after NOW (Wed 2026-11-04 12:00 UTC). */
const RUN = Date.parse("2026-11-05T01:00:00Z");

async function service(vars: Record<string, string> = {}): Promise<Service> {
  return createService({ OPEN_ADMISSION: "true", RESEND_API_KEY: "re_test_key", ...vars });
}

async function scheduled(s: Service, at: number): Promise<void> {
  s.clock.now = at;
  await (s.handler as unknown as { scheduled(controller: { cron: string; scheduledTime: number }, env: never): Promise<void> }).scheduled({ cron: DIGEST_CRON, scheduledTime: at }, s.env as never);
}

/** Admits someone straight through the Directory, with an email unless `email` is null. */
async function admit(s: Service, githubId: number, login: string, at: number, email: string | null = `${login}@example.com`): Promise<void> {
  const result = await s.directory().admit({
    githubId,
    login,
    isAdmin: githubId === ADMIN_ID,
    inviteCode: undefined,
    clientDeviceId: null,
    accountTooNew: false,
    openAdmission: true,
    inviteOnly: false,
    maxActive: 50,
    policy: policyOf(readFreeConfig(s.env)),
    now: at,
  });
  assert.equal(result.ok, true);
  if (email) await s.directory().setEmail(githubId, email, false, at);
}

async function request(s: Service, githubId: number, at: number): Promise<void> {
  await s.directory().recordRequest({ githubId, isAdmin: githubId === ADMIN_ID, at, model: MODEL, promptTokens: 100, completionTokens: 10, cachedTokens: 0, chargedTokens: 110, costUsd: 0.001, status: "ok", latencyMs: 10 });
}

const sentTo = (s: Service) => s.calls.resend.map((call) => (call.body.to as string[])[0]);
const subjects = (s: Service) => s.calls.resend.map((call) => String(call.body.subject));

function rows(s: Service): Array<Record<string, unknown>> {
  return [...s.namespaces.DIRECTORY!.instances.get("directory")!.state.db.prepare("SELECT * FROM user_emails ORDER BY claimed_at").all()] as Array<Record<string, unknown>>;
}

function stopLink(s: Service, index = 0): string {
  const header = String((s.calls.resend[index]!.body.headers as Record<string, string>)["List-Unsubscribe"]);
  return /^<(.+)>$/.exec(header)![1]!;
}

describe("emails to users: the copy", () => {
  it("is lowercase, has no em or en dash, never names the person, and ends with the stop link", () => {
    for (const [kind, copy] of Object.entries(USER_EMAILS)) {
      for (const text of [copy.subject, copy.body, FOOTER].map((part) => part.replace("{unsubscribeUrl}", ""))) {
        // Links keep their case (an invite code is case-sensitive); the words around them don't.
        const words = text.replace(/https?:\/\/\S+/g, "");
        assert.equal(words, words.toLowerCase(), `${kind} isn't all lowercase`);
        assert.doesNotMatch(text, /[—–]/, `${kind} has an em or en dash`);
        assert.doesNotMatch(text, /\{login\}/, `${kind} uses the login`);
      }
      assert.match(copy.body, /^hey,\n/, `${kind} starts with "hey,"`);
      const rendered = renderUserEmail(kind as keyof typeof USER_EMAILS, { resets: "monday 10 nov", unsubscribeUrl: "https://free.directionallylocal.com/email/stop?u=1&t=x" });
      assert.match(rendered.body, /\n\ndon't want these\? https:\/\/free\.directionallylocal\.com\/email\/stop\?u=1&t=x\n$/);
      assert.doesNotMatch(rendered.body, /\{\w+\}/, `${kind} has a placeholder left`);
    }
    assert.equal(resetsText(Date.parse("2026-11-09T00:00:00Z")), "monday 9 nov");
  });

  it("keeps the source file free of em and en dashes", async () => {
    const source = await readFile(new URL("../src/user-emails.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /[—–]/);
  });
});

describe("emails to users: welcome", () => {
  it("goes once to a new sign-up, after the details step, from sina, plain text, with unsubscribe headers", async () => {
    const s = await service();
    const flow = await startBrowserFlow(s.request, { id: 200, login: "Alice", email: "alice@work.example" });
    assert.match(flow.page, /signed in/);
    assert.deepEqual(sentTo(s), ["alice@work.example"]);
    const call = s.calls.resend[0]!;
    assert.equal(call.headers.authorization, "Bearer re_test_key");
    assert.equal(call.headers["idempotency-key"], "dl-user-email-welcome-200-once");
    assert.equal(call.body.from, "sina <sina@directionallylocal.com>");
    assert.equal(call.body.reply_to, "contact@directionallylocal.com");
    assert.equal(call.body.subject, "you're in");
    assert.equal(call.body.html, undefined, "plain text only");
    const text = String(call.body.text);
    assert.match(text, /^hey,\n\nsina here, i build dl\./);
    assert.doesNotMatch(text, /alice/i, "the body never contains the login");
    const link = stopLink(s);
    assert.match(link, /^https:\/\/free\.directionallylocal\.com\/email\/stop\?u=200&t=[A-Za-z0-9_-]+$/);
    assert.ok(text.endsWith(`\n\ndon't want these? ${link}\n`));
    assert.equal((call.body.headers as Record<string, string>)["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");

    // Signing in again is a returning person: nothing more.
    await s.signIn({ id: 200, login: "Alice", email: "alice@work.example" });
    assert.equal(s.calls.resend.length, 1);
  });

  it("tells a sign-up below the bar, with no Starter tokens, that they need a key or can ask for credits", async () => {
    const s = await service({ STARTER_WEEKLY_TOKENS: "0", FULL_MIN_ACCOUNT_AGE_DAYS: "365", FULL_MIN_CONTRIBUTIONS: "100", FULL_MIN_PUBLIC_REPOS: "100000" });
    await startBrowserFlow(s.request, { id: 210, login: "newbie", email: "newbie@work.example", createdAt: "2026-10-01T00:00:00Z", publicRepos: 0, contributions: 3 });
    assert.deepEqual(sentTo(s), ["newbie@work.example"]);
    const text = String(s.calls.resend[0]!.body.text);
    assert.match(text, /\/provider/);
    assert.match(text, /contact@directionallylocal\.com/);
    assert.doesNotMatch(text, /\$20 worth/, "no promise of free tokens");
    assert.equal(s.calls.resend[0]!.headers["idempotency-key"], "dl-user-email-welcome_starter-210-once");

    // And no "did something get in the way?" later: "pick free" wouldn't help them.
    await scheduled(s, NOW + 2 * DAY);
    assert.equal(s.calls.resend.length, 1);
  });

  it("doesn't go to admins, or to people who signed up before and only now give an email", async () => {
    const s = await service();
    await s.signIn({ id: ADMIN_ID, login: "owner" });
    await admit(s, 201, "bob", NOW - DAY, null); // in already, no email yet
    await startBrowserFlow(s.request, { id: 201, login: "bob" });
    assert.equal(s.calls.resend.length, 0);
  });

  it("goes to admins too with USER_EMAILS_TO_ADMINS (for testing)", async () => {
    const s = await service({ USER_EMAILS_TO_ADMINS: "true" });
    await s.signIn({ id: ADMIN_ID, login: "owner" });
    assert.deepEqual(subjects(s), ["you're in"]);
  });
});

describe("emails to users: didn't start", () => {
  it("goes once to people admitted 24 to 72 hours ago with no request", async () => {
    const s = await service();
    await admit(s, 300, "carol", RUN - 30 * HOUR);
    await admit(s, 301, "dave", RUN - 30 * HOUR); // used it
    await request(s, 301, RUN - 20 * HOUR);
    await admit(s, 302, "erin", RUN - 10 * HOUR); // too soon
    await admit(s, 303, "frank", RUN - 80 * HOUR); // too late
    await admit(s, 304, "gina", RUN - 30 * HOUR, null); // no email
    await admit(s, ADMIN_ID, "owner", RUN - 30 * HOUR); // admin
    await scheduled(s, RUN);
    assert.deepEqual(sentTo(s), ["carol@example.com"]);
    assert.deepEqual(subjects(s), ["did something get in the way?"]);
    await scheduled(s, RUN + 5 * 60_000); // a doubled run
    await scheduled(s, RUN + DAY); // carol is still in the window
    assert.equal(sentTo(s).filter((to) => to === "carol@example.com").length, 1);
  });

  it("doesn't go after stop was pressed", async () => {
    const s = await service();
    await admit(s, 305, "hank", RUN - 30 * HOUR);
    await s.directory().setEmailStop(305);
    await scheduled(s, RUN);
    assert.equal(s.calls.resend.length, 0);
  });
});

describe("emails to users: gone quiet", () => {
  it("goes once to people who used dl on 2 days, then nothing for 7", async () => {
    const s = await service();
    await admit(s, 400, "ivy", RUN - 30 * DAY);
    await request(s, 400, RUN - 12 * DAY);
    await request(s, 400, RUN - 10 * DAY);
    await admit(s, 401, "jack", RUN - 30 * DAY); // one day only
    await request(s, 401, RUN - 12 * DAY);
    await request(s, 401, RUN - 12 * DAY + HOUR);
    await admit(s, 402, "kim", RUN - 30 * DAY); // still active
    await request(s, 402, RUN - 12 * DAY);
    await request(s, 402, RUN - 2 * DAY);
    await admit(s, 403, "lee", RUN - 30 * DAY, null); // no email
    await request(s, 403, RUN - 12 * DAY);
    await request(s, 403, RUN - 10 * DAY);
    await admit(s, ADMIN_ID, "owner", RUN - 30 * DAY);
    await request(s, ADMIN_ID, RUN - 12 * DAY);
    await request(s, ADMIN_ID, RUN - 10 * DAY);
    await admit(s, 404, "mo", RUN - 30 * DAY);
    await request(s, 404, RUN - 12 * DAY);
    await request(s, 404, RUN - 10 * DAY);
    await s.directory().setEmailStop(404);
    await scheduled(s, RUN);
    assert.deepEqual(sentTo(s), ["ivy@example.com"]);
    assert.deepEqual(subjects(s), ["quick question"]);
    await scheduled(s, RUN + DAY);
    await scheduled(s, RUN + 40 * DAY);
    assert.equal(sentTo(s).filter((to) => to === "ivy@example.com").length, 1);
  });
});

describe("emails to users: most of the week used", () => {
  async function chat(s: Service, token: string): Promise<number> {
    return (await s.request("POST", "/v1/chat/completions", { token, body: { model: MODEL, messages: [{ role: "user", content: "hi" }] } })).status;
  }

  it("goes on the request that crosses 80% of the week, once a week, and waits a day after another email", async () => {
    // DeepSeek has no token cap: its week is its dollar budget.
    const s = await service({ DEEPSEEK_WEEKLY_USD_CAP: "1" });
    s.setOpenRouter(() => completion(usage(3_000_000, 10, 0, 0.3)));
    const nora = { id: 500, login: "nora" };
    let token = (await s.signIn(nora)).access_token;
    assert.deepEqual(subjects(s), ["you're in"]);
    assert.equal(await chat(s, token), 200); // 30%
    assert.equal(await chat(s, token), 200); // 60%
    assert.equal(await chat(s, token), 200); // 90%: crossed, but the welcome went today
    assert.equal(s.calls.resend.length, 1, "at most one email a day");
    s.clock.now = NOW + DAY;
    token = (await s.signIn(nora)).access_token;
    s.setOpenRouter(() => completion(usage(10, 1, 0, 0.0001)));
    assert.equal(await chat(s, token), 200);
    assert.deepEqual(subjects(s), ["you're in", "you've used most of this week's tokens"]);
    assert.match(String(s.calls.resend[1]!.body.text), /they reset on monday 9 nov\./);
    s.clock.now = NOW + 2 * DAY;
    token = (await s.signIn(nora)).access_token;
    assert.equal(await chat(s, token), 200);
    assert.equal(s.calls.resend.length, 2, "once a week");
  });

  it("goes when the dollar cap is 80% used first", async () => {
    const s = await service({ DEEPSEEK_WEEKLY_USD_CAP: "1" });
    await s.signIn({ id: 501, login: "olga" });
    s.clock.now = NOW + DAY;
    const { access_token: token } = await s.signIn({ id: 501, login: "olga" });
    s.setOpenRouter(() => completion(usage(100, 10, 0, 0.5)));
    assert.equal(await chat(s, token), 200); // 50%
    assert.equal(s.calls.resend.length, 1);
    assert.equal(await chat(s, token), 200); // 100%
    assert.deepEqual(subjects(s).slice(1), ["you've used most of this week's tokens"]);
  });

  it("doesn't go to admins", async () => {
    const s = await service({ WEEKLY_TOKENS: "1000000" });
    s.setOpenRouter(() => completion(usage(900_000, 10)));
    await s.signIn({ id: ADMIN_ID, login: "owner" });
    s.clock.now = NOW + DAY;
    const { access_token: token } = await s.signIn({ id: ADMIN_ID, login: "owner" });
    assert.equal(await chat(s, token), 200);
    assert.equal(s.calls.resend.length, 0);
  });
});

describe("emails to users: unsubscribe", () => {
  it("shows a page with one button for a signed link, refuses a bad one, and the button stops every email", async () => {
    const s = await service();
    await startBrowserFlow(s.request, { id: 600, login: "pat" });
    const url = new URL(stopLink(s));
    const page = await s.request("GET", `${url.pathname}${url.search}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<form method="post" action="\/email\/stop\?u=600&amp;t=[A-Za-z0-9_-]+">\s*<button class="btn" type="submit">Stop emails<\/button>/);

    const forged = await s.request("GET", `/email/stop?u=601&t=${url.searchParams.get("t")}`);
    assert.equal(forged.status, 400, "another person's id with this token");
    assert.equal((await s.request("GET", "/email/stop?u=600&t=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).status, 400);
    assert.equal((await s.request("POST", "/email/stop?u=600&t=nope")).status, 400);
    assert.equal((await s.directory().getPerson(600)).email_stop, 0);

    const stop = await s.request("POST", `${url.pathname}${url.search}`, { form: {} });
    assert.equal(stop.status, 200);
    assert.match(await stop.text(), /Emails stopped/);
    assert.equal((await s.directory().getPerson(600)).email_stop, 1);
  });

  it("takes a mail app's one-click POST without the page", async () => {
    const s = await service();
    await startBrowserFlow(s.request, { id: 602, login: "quinn" });
    const url = new URL(stopLink(s));
    const response = await s.request("POST", `${url.pathname}${url.search}`, { form: { "List-Unsubscribe": "One-Click" } });
    assert.equal(response.status, 200);
    assert.equal((await s.directory().getPerson(602)).email_stop, 1);
    // Stopped people get none of them.
    await scheduled(s, NOW + 30 * HOUR);
    assert.equal(s.calls.resend.length, 1);
  });
});

describe("emails to users: switches and failures", () => {
  it("sends nothing and fails nothing without RESEND_API_KEY", async () => {
    const s = await createService({ OPEN_ADMISSION: "true" });
    const flow = await startBrowserFlow(s.request, { id: 700, login: "rae" });
    assert.match(flow.page, /signed in/);
    await admit(s, 701, "sam", RUN - 30 * HOUR);
    await scheduled(s, RUN);
    assert.equal(s.calls.resend.length, 0);
    assert.deepEqual(rows(s), []);
  });

  it("sends nothing while the userEmails runtime setting is off", async () => {
    const s = await service();
    const admin = (await s.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    assert.equal((await s.request("POST", "/admin/config", { token: admin, body: { userEmails: false } })).status, 200);
    await startBrowserFlow(s.request, { id: 702, login: "tess" });
    await admit(s, 703, "uma", RUN - 30 * HOUR);
    await scheduled(s, RUN);
    assert.equal(s.calls.resend.length, 0);
    const again = (await s.signIn({ id: ADMIN_ID, login: "owner" })).access_token; // the clock moved on
    assert.equal((await s.request("POST", "/admin/config", { token: again, body: { userEmails: null } })).status, 200);
    await startBrowserFlow(s.request, { id: 704, login: "vic" });
    assert.deepEqual(sentTo(s), ["vic.704@example.com"]);
  });

  it("doesn't fail the sign-in when Resend fails, retries once on the next daily run, then gives up", async () => {
    const s = await service();
    s.setResend(() => new Response("{}", { status: 500 }));
    const flow = await startBrowserFlow(s.request, { id: 705, login: "wes" });
    assert.match(flow.page, /signed in/);
    assert.equal(s.calls.resend.length, 1);
    assert.equal(rows(s)[0]!.status, "failed");
    await scheduled(s, RUN); // the retry fails too
    assert.equal(s.calls.resend.length, 2);
    s.setResend(() => Response.json({ id: "ok" }));
    await scheduled(s, RUN + DAY);
    assert.equal(subjects(s).filter((subject) => subject === "you're in").length, 2, "retried at most once");
  });

  it("delivers a failed email on the retry", async () => {
    const s = await service();
    s.setResend(() => new Response("{}", { status: 503 }));
    await startBrowserFlow(s.request, { id: 706, login: "xan" });
    s.setResend(() => Response.json({ id: "ok" }));
    await scheduled(s, RUN);
    assert.deepEqual(subjects(s), ["you're in", "you're in"]);
    assert.equal(s.calls.resend[1]!.headers["idempotency-key"], "dl-user-email-welcome-706-once");
    assert.equal(rows(s)[0]!.status, "sent");
    await scheduled(s, RUN + DAY);
    assert.equal(subjects(s).filter((subject) => subject === "you're in").length, 2);
  });
});
