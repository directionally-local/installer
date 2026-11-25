import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, createService, NOW, startBrowserFlow, type Service } from "./harness.js";
import { policyOf } from "../src/queue.js";
import { readFreeConfig } from "../src/config.js";
import { broadcastCopyProblem, hasCapitals } from "../src/broadcast.js";
import { bindingSender, userEmailRoute, userEmailRoutes, userEmailTransport } from "../src/user-email-send.js";

// After the harness: app.js loads cloudflare:workers, which the harness resolves.
const { DIGEST_CRON } = await import("../src/app.js");

/**
 * Emails to users through Cloudflare Email Service (the USER_EMAIL send_email binding), the
 * admin's test email, and broadcasts. The binding is a fake that records each message.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RUN = Date.parse("2026-11-05T01:00:00Z");

async function scheduled(s: Service, at: number): Promise<void> {
  s.clock.now = at;
  await (s.handler as unknown as { scheduled(controller: { cron: string; scheduledTime: number }, env: never): Promise<void> }).scheduled({ cron: DIGEST_CRON, scheduledTime: at }, s.env as never);
}

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

function rows(s: Service): Array<Record<string, unknown>> {
  return [...s.namespaces.DIRECTORY!.instances.get("directory")!.state.db.prepare("SELECT * FROM user_emails ORDER BY claimed_at").all()] as Array<Record<string, unknown>>;
}

const sentTo = (s: Service) => s.calls.userEmail.map((message) => String(message.to));

function refusal(code: string): Error {
  return Object.assign(new Error("refused"), { code });
}

describe("emails to users through Cloudflare Email Service", () => {
  it("picks the binding first, then Resend, then nothing", () => {
    const binding = { send: async () => ({ messageId: "x" }) };
    const fetcher = async () => new Response();
    assert.equal(userEmailTransport(binding, { resendApiKey: "re_key" }, fetcher)?.provider, "cloudflare");
    assert.equal(userEmailTransport(binding, { resendApiKey: undefined }, fetcher)?.provider, "cloudflare");
    assert.equal(userEmailTransport(undefined, { resendApiKey: "re_key" }, fetcher)?.provider, "resend");
    assert.equal(userEmailTransport(undefined, { resendApiKey: undefined }, fetcher), undefined);
  });

  it("splits the sender into the binding's {email, name}", () => {
    assert.deepEqual(bindingSender("sina <sina@directionallylocal.com>"), { email: "sina@directionallylocal.com", name: "sina" });
    assert.equal(bindingSender("sina@directionallylocal.com"), "sina@directionallylocal.com");
    assert.equal(bindingSender("<sina@directionallylocal.com>"), "sina@directionallylocal.com");
  });

  it("sends the welcome through the binding, not Resend, with the same copy, sender, reply-to and headers (broadcastEmailProvider cloudflare)", async () => {
    const s = await createService({ OPEN_ADMISSION: "true", RESEND_API_KEY: "re_test_key", BROADCAST_EMAIL_PROVIDER: "cloudflare" }, { userEmail: true });
    const flow = await startBrowserFlow(s.request, { id: 200, login: "alice", email: "alice@work.example" });
    assert.match(flow.page, /signed in/);
    assert.equal(s.calls.resend.length, 0, "the binding wins over Resend");
    assert.equal(s.calls.userEmail.length, 1);
    const message = s.calls.userEmail[0]!;
    assert.deepEqual(message.from, { email: "sina@directionallylocal.com", name: "sina" });
    assert.equal(message.to, "alice@work.example");
    assert.equal(message.replyTo, "contact@directionallylocal.com");
    assert.equal(message.subject, "you're in");
    assert.equal(message.html, undefined, "plain text only");
    const headers = message.headers as Record<string, string>;
    const link = /^<(https:\/\/free\.directionallylocal\.com\/email\/stop\?u=200&t=[A-Za-z0-9_-]+)>$/.exec(headers["List-Unsubscribe"]!)![1]!;
    assert.equal(headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
    assert.deepEqual(Object.keys(headers).sort(), ["List-Unsubscribe", "List-Unsubscribe-Post"], "only allowlisted headers; Reply-To is the API field");
    assert.ok(String(message.text).endsWith(`\n\ndon't want these? ${link}\n`));
    assert.equal(rows(s)[0]!.status, "sent");
  });

  it("sends without RESEND_API_KEY when the binding exists", async () => {
    const s = await createService({ OPEN_ADMISSION: "true" }, { userEmail: true });
    await startBrowserFlow(s.request, { id: 201, login: "bea" });
    assert.equal(s.calls.userEmail.length, 1);
  });

  it("marks a refused send failed, doesn't fail the sign-in, and retries once on the next daily run", async () => {
    const s = await createService({ OPEN_ADMISSION: "true" }, { userEmail: true });
    s.setUserEmail(() => {
      throw refusal("E_INTERNAL_SERVER_ERROR");
    });
    const flow = await startBrowserFlow(s.request, { id: 202, login: "cy" });
    assert.match(flow.page, /signed in/);
    assert.equal(rows(s)[0]!.status, "failed");
    s.setUserEmail(() => ({ messageId: "ok" }));
    await scheduled(s, RUN);
    assert.equal(s.calls.userEmail.length, 2);
    assert.equal(rows(s)[0]!.status, "sent");
    await scheduled(s, RUN + DAY);
    assert.equal(s.calls.userEmail.filter((message) => message.subject === "you're in").length, 2, "retried at most once");
  });

  it("runs the daily emails through the binding", async () => {
    const s = await createService({ OPEN_ADMISSION: "true" }, { userEmail: true });
    await admit(s, 300, "dee", RUN - 30 * HOUR);
    await scheduled(s, RUN);
    assert.deepEqual(sentTo(s), ["dee@example.com"]);
    assert.equal(s.calls.userEmail[0]!.subject, "did something get in the way?");
  });
});

describe("POST /admin/emails/test", () => {
  it("sends one email of the kind to the address, exactly as a user gets it, and touches no user record", async () => {
    const s = await createService({ OPEN_ADMISSION: "true", USER_EMAILS: "false" }, { userEmail: true });
    const admin = (await s.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const response = await s.request("POST", "/admin/emails/test", { token: admin, body: { kind: "gone_quiet", to: "me@example.org" } });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { sent: boolean; provider: string; messageId: string };
    assert.deepEqual([body.sent, body.provider, body.messageId], [true, "cloudflare", "cf-1"]);
    assert.equal(s.calls.userEmail.length, 1);
    const message = s.calls.userEmail[0]!;
    assert.equal(message.to, "me@example.org");
    assert.equal(message.subject, "quick question");
    assert.match((message.headers as Record<string, string>)["List-Unsubscribe"]!, new RegExp(`/email/stop\\?u=${ADMIN_ID}&t=`));
    assert.deepEqual(rows(s), [], "no user_emails row: it counts as a send for nobody");
    assert.equal((await s.directory().getPerson(ADMIN_ID)).email_stop, 0);
  });

  it("sends typed copy as a broadcast would, to the admin's own address unless one is given", async () => {
    const s = await createService({ OPEN_ADMISSION: "true", USER_EMAILS: "false" }, { userEmail: true });
    const admin = (await s.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const own = await s.request("POST", "/admin/emails/test", { token: admin, body: { subject: "GPT-6 is in", text: "hey,\r\n\nline two  \n\n" } });
    assert.equal(own.status, 200);
    const message = s.calls.userEmail.at(-1)!;
    assert.equal(message.to, "owner.1@example.com");
    assert.equal(message.subject, "GPT-6 is in");
    assert.match(String(message.text), /^hey,\n\nline two\n\n.*\/email\/stop\?u=1&t=/s);
    const other = await s.request("POST", "/admin/emails/test", { token: admin, body: { subject: "hi", text: "hey", to: "me@example.org" } });
    assert.equal(other.status, 200);
    assert.equal(s.calls.userEmail.at(-1)!.to, "me@example.org");
    assert.equal((await s.request("POST", "/admin/emails/test", { token: admin, body: { subject: "hi — there", text: "hey" } })).status, 400);
    assert.equal((await s.request("POST", "/admin/emails/test", { token: admin, body: { subject: "", text: "hey" } })).status, 400);
    assert.deepEqual(rows(s), []);
  });

  it("is for admins only and checks its input", async () => {
    const s = await createService({ OPEN_ADMISSION: "true" }, { userEmail: true });
    const admin = (await s.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const user = (await s.signIn({ id: 401, login: "finn" })).access_token;
    const before = s.calls.userEmail.length;
    assert.equal((await s.request("POST", "/admin/emails/test", { token: user, body: { kind: "welcome", to: "me@example.org" } })).status, 403);
    assert.equal((await s.request("POST", "/admin/emails/test", { token: admin, body: { kind: "nope", to: "me@example.org" } })).status, 400);
    assert.equal((await s.request("POST", "/admin/emails/test", { token: admin, body: { kind: "welcome", to: "me@example.org\r\nBcc: x@y.z" } })).status, 400);
    assert.equal(s.calls.userEmail.length, before);
  });

  it("reports the provider's refusal code", async () => {
    const s = await createService({ OPEN_ADMISSION: "true" }, { userEmail: true });
    const admin = (await s.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    s.setUserEmail(() => {
      throw refusal("E_SENDER_NOT_VERIFIED");
    });
    const response = await s.request("POST", "/admin/emails/test", { token: admin, body: { kind: "welcome", to: "me@example.org" } });
    assert.equal(response.status, 502);
    assert.match(await response.text(), /E_SENDER_NOT_VERIFIED/);
  });

  it("says so when there is no provider", async () => {
    const s = await createService({ OPEN_ADMISSION: "true" });
    const admin = (await s.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    assert.equal((await s.request("POST", "/admin/emails/test", { token: admin, body: { kind: "welcome", to: "me@example.org" } })).status, 503);
  });

  it("goes through Resend when there is no binding", async () => {
    const s = await createService({ OPEN_ADMISSION: "true", RESEND_API_KEY: "re_test_key" });
    const admin = (await s.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const response = await s.request("POST", "/admin/emails/test", { token: admin, body: { kind: "week_80", to: "me@example.org" } });
    assert.equal(response.status, 200);
    assert.equal(s.calls.resend.length, 1);
    assert.deepEqual(s.calls.resend[0]!.body.to, ["me@example.org"]);
  });
});

describe("POST /admin/emails/broadcast", () => {
  const COPY = { subject: "a quick check-in", text: "hey,\n\nhow is dl going? reply to sina@directionallylocal.com or see https://dl.new/Docs.\n\nsina" };

  /** People signed up on different days and levels; the admin signed in. */
  async function setup(vars: Record<string, string> = {}): Promise<{ s: Service; admin: string }> {
    const s = await createService({ OPEN_ADMISSION: "true", ...vars }, { userEmail: true });
    await s.signIn({ id: ADMIN_ID, login: "owner" });
    const actor = { githubId: ADMIN_ID, login: "owner", now: NOW };
    await admit(s, 500, "gail", Date.parse("2026-10-20T10:00:00Z")); // full
    await admit(s, 501, "hal", Date.parse("2026-10-25T10:00:00Z")); // starter
    await s.directory().setLevel(501, "starter", actor);
    await admit(s, 502, "iris", Date.parse("2026-11-01T10:00:00Z")); // full
    await admit(s, 503, "jon", Date.parse("2026-10-21T10:00:00Z")); // blocked
    await s.directory().setPersonStatus(503, "blocked");
    await admit(s, 504, "kai", Date.parse("2026-10-22T10:00:00Z")); // pressed stop
    await s.directory().setEmailStop(504);
    await admit(s, 505, "lou", Date.parse("2026-10-23T10:00:00Z"), null); // no email
    s.clock.now = NOW + DAY; // a new day: no other email went today
    return { s, admin: (await s.signIn({ id: ADMIN_ID, login: "owner" })).access_token };
  }

  async function broadcast(s: Service, admin: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, any> }> {
    const response = await s.request("POST", "/admin/emails/broadcast", { token: admin, body });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  }

  it("dry run: counts and samples the audience, sends nothing", async () => {
    const { s, admin } = await setup();
    const before = s.calls.userEmail.length;
    const all = await broadcast(s, admin, { ...COPY, audience: "all", dryRun: true });
    assert.equal(all.status, 200);
    assert.equal(all.body.count, 3, "gail, hal, iris; never blocked, stopped, no email or the admin");
    assert.deepEqual(
      all.body.sample.map((person: { githubId: number }) => person.githubId),
      [500, 501, 502],
    );
    assert.equal(all.body.sample[0].address, "gail@example.com");
    assert.equal(s.calls.userEmail.length, before);
    assert.deepEqual(rows(s).filter((row) => row.kind === "broadcast"), []);
  });

  it("filters by level and sign-up dates", async () => {
    const { s, admin } = await setup();
    const ids = async (body: Record<string, unknown>) =>
      (await broadcast(s, admin, { ...COPY, dryRun: true, ...body })).body.sample.map((person: { githubId: number }) => person.githubId);
    assert.deepEqual(await ids({ audience: "full" }), [500, 502]);
    assert.deepEqual(await ids({ audience: "starter" }), [501]);
    assert.deepEqual(await ids({ audience: "all", signedUpFrom: "2026-10-25" }), [501, 502]);
    assert.deepEqual(await ids({ audience: "all", signedUpTo: "2026-10-25" }), [500, 501], "a plain date includes that day");
    assert.deepEqual(await ids({ audience: "full", signedUpFrom: "2026-10-21", signedUpTo: "2026-11-01T00:00:00Z" }), []);
  });

  it("skipIfSent: a reworded resend skips people who got the earlier broadcast", async () => {
    const setUp = await setup();
    const s = setUp.s;
    let admin = setUp.admin;
    const first = await broadcast(s, admin, { ...COPY, audience: "full", dryRun: false });
    assert.equal(first.body.sent, 2, "gail and iris got the first wording");
    s.clock.now += DAY;
    admin = (await s.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const reworded = { ...COPY, subject: "a shorter check-in" };
    const dry = await broadcast(s, admin, { ...reworded, audience: "all", dryRun: true, skipIfSent: first.body.id });
    assert.deepEqual(dry.body.sample.map((person: { githubId: number }) => person.githubId), [501], "only hal, who didn't get it");
    const before = s.calls.userEmail.length;
    const second = await broadcast(s, admin, { ...reworded, audience: "all", dryRun: false, skipIfSent: first.body.id });
    assert.equal(second.body.sent, 1);
    assert.deepEqual(s.calls.userEmail.slice(before).map((message) => message.to), ["hal@example.com"]);
    assert.equal((await broadcast(s, admin, { ...reworded, audience: "all", dryRun: true, skipIfSent: "not-an-id" })).status, 400);
  });

  it("sends to the audience with the stop link and List-Unsubscribe, and a retried call sends nothing twice", async () => {
    const { s, admin } = await setup();
    const before = s.calls.userEmail.length;
    const first = await broadcast(s, admin, { ...COPY, audience: "all", dryRun: false });
    assert.equal(first.status, 200);
    assert.deepEqual([first.body.sent, first.body.failed, first.body.remaining], [3, 0, 0]);
    const sent = s.calls.userEmail.slice(before);
    assert.deepEqual(sent.map((message) => message.to), ["gail@example.com", "hal@example.com", "iris@example.com"]);
    for (const message of sent) {
      assert.equal(message.subject, COPY.subject);
      assert.deepEqual(message.from, { email: "sina@directionallylocal.com", name: "sina" });
      assert.equal(message.replyTo, "contact@directionallylocal.com");
      const headers = message.headers as Record<string, string>;
      const link = /^<(.+)>$/.exec(headers["List-Unsubscribe"]!)![1]!;
      assert.match(link, /\/email\/stop\?u=50[0-2]&t=/);
      assert.equal(headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
      assert.equal(message.text, `${COPY.text}\n\ndon't want these? ${link}\n`);
    }
    const again = await broadcast(s, admin, { ...COPY, audience: "all", dryRun: false });
    assert.deepEqual([again.body.sent, again.body.remaining], [0, 0]);
    s.clock.now += 3 * DAY;
    const fresh = (await s.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const later = await broadcast(s, fresh, { ...COPY, audience: "full", dryRun: false });
    assert.equal(later.body.sent, 0, "the same message never goes twice, whatever the filters");
    assert.equal(s.calls.userEmail.length, before + 3);
    assert.equal(rows(s).filter((row) => row.kind === "broadcast" && row.status === "sent").length, 3);
    // The daily run doesn't pick broadcasts up.
    await scheduled(s, s.clock.now + DAY);
    assert.equal(s.calls.userEmail.length, before + 3);
  });

  it("marks a refused send failed, retries it on the next call, and stops at the provider's rate limit", async () => {
    const { s, admin } = await setup();
    const before = s.calls.userEmail.length;
    s.setUserEmail((message) => {
      if (message.to === "gail@example.com") throw refusal("E_DELIVERY_FAILED");
      if (message.to === "hal@example.com") throw refusal("E_RATE_LIMIT_EXCEEDED");
      return { messageId: "ok" };
    });
    const first = await broadcast(s, admin, { ...COPY, audience: "all", dryRun: false });
    assert.deepEqual([first.body.sent, first.body.failed, first.body.stoppedBy, first.body.remaining], [0, 2, "E_RATE_LIMIT_EXCEEDED", 3]);
    assert.equal(s.calls.userEmail.length, before + 2, "iris waits for the next call");
    s.setUserEmail(() => ({ messageId: "ok" }));
    const second = await broadcast(s, admin, { ...COPY, audience: "all", dryRun: false });
    assert.deepEqual([second.body.sent, second.body.failed, second.body.remaining], [3, 0, 0]);
    assert.equal(rows(s).filter((row) => row.kind === "broadcast" && row.status === "sent").length, 3);
  });

  it("githubIds: only listed accounts are candidates, still filtered by every other rule", async () => {
    const { s, admin } = await setup();
    // 500 gail and 502 iris qualify; 503 blocked, 504 pressed stop, 505 no email, the admin and an unknown id never do.
    const listed = [502, 500, 503, 504, 505, ADMIN_ID, 999_999, 500];
    const dry = await broadcast(s, admin, { ...COPY, audience: "all", dryRun: true, githubIds: listed });
    assert.equal(dry.status, 200);
    assert.equal(dry.body.count, 2);
    assert.deepEqual(dry.body.sample.map((person: { githubId: number }) => person.githubId), [500, 502]);
    // The level and sign-up filters still narrow the list.
    assert.equal((await broadcast(s, admin, { ...COPY, audience: "starter", dryRun: true, githubIds: listed })).body.count, 0);
    assert.equal((await broadcast(s, admin, { ...COPY, audience: "all", signedUpFrom: "2026-10-25", dryRun: true, githubIds: listed })).body.count, 1);
    const before = s.calls.userEmail.length;
    const sent = await broadcast(s, admin, { ...COPY, audience: "all", dryRun: false, githubIds: listed });
    assert.deepEqual([sent.body.sent, sent.body.failed, sent.body.remaining], [2, 0, 0]);
    assert.deepEqual(s.calls.userEmail.slice(before).map((message) => message.to).sort(), ["gail@example.com", "iris@example.com"]);
    assert.deepEqual(rows(s).filter((row) => row.kind === "broadcast" && row.status === "sent").map((row) => row.github_id).sort(), [500, 502]);
    // A retry sends nothing twice; hal, never listed, was never emailed.
    s.clock.now += DAY;
    const fresh = (await s.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    assert.equal((await broadcast(s, fresh, { ...COPY, audience: "all", dryRun: true, githubIds: listed })).body.count, 0);
    assert.equal((await broadcast(s, fresh, { ...COPY, audience: "all", dryRun: true })).body.count, 1, "hal is still waiting");
    // A reworded resend with skipIfSent skips the listed people who got the first one.
    const reworded = { subject: "a second check-in", text: COPY.text };
    assert.equal((await broadcast(s, fresh, { ...reworded, audience: "all", dryRun: true, githubIds: [500, 501], skipIfSent: sent.body.id })).body.count, 1);
  });

  it("githubIds: refuses a list that isn't 1 to 500 positive whole numbers", async () => {
    const { s, admin } = await setup();
    const before = s.calls.userEmail.length;
    for (const githubIds of [[], "500", [500, "501"], [0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 2], { 0: 500 }, Array.from({ length: 501 }, (_, i) => i + 1)]) {
      const refused = await broadcast(s, admin, { ...COPY, audience: "all", dryRun: false, githubIds });
      assert.equal(refused.status, 400, JSON.stringify(githubIds).slice(0, 40));
    }
    assert.equal(s.calls.userEmail.length, before);
    assert.equal((await broadcast(s, admin, { ...COPY, audience: "all", dryRun: true, githubIds: Array.from({ length: 500 }, (_, i) => i + 1) })).status, 200);
    assert.equal((await broadcast(s, admin, { ...COPY, audience: "all", dryRun: true, githubIds: null })).body.count, 3, "null is no list");
  });

  it("leaves people already emailed today for tomorrow", async () => {
    const { s, admin } = await setup();
    await startBrowserFlow(s.request, { id: 506, login: "max" }); // a welcome today
    const dry = await broadcast(s, admin, { ...COPY, audience: "all", dryRun: true });
    assert.deepEqual([dry.body.count, dry.body.waitingForTomorrow], [3, 1]);
    s.clock.now += DAY;
    const fresh = (await s.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const next = await broadcast(s, fresh, { ...COPY, audience: "all", dryRun: true });
    assert.deepEqual([next.body.count, next.body.waitingForTomorrow], [4, 0]);
  });

  it("refuses em and en dashes and a missing dryRun, but allows capitals and notes them", async () => {
    const { s, admin } = await setup();
    const before = s.calls.userEmail.length;
    for (const body of [
      { subject: "a check—in", text: "hey" },
      { subject: "a check-in", text: "hey – there" },
      { subject: "a check-in\nsecond line", text: "hey" },
    ]) {
      const refused = await broadcast(s, admin, { ...body, audience: "all", dryRun: false });
      assert.equal(refused.status, 400, JSON.stringify(body));
    }
    assert.equal((await broadcast(s, admin, { ...COPY, audience: "all" })).status, 400);
    assert.equal((await broadcast(s, admin, { ...COPY, audience: "everyone", dryRun: true })).status, 400);
    assert.equal((await broadcast(s, admin, { ...COPY, audience: "all", signedUpFrom: "last week", dryRun: true })).status, 400);
    assert.equal(s.calls.userEmail.length, before);
    // Proper nouns are fine: capitals are noted, never refused.
    const named = await broadcast(s, admin, { subject: "GPT-6 is in", text: "hey, OpenAI's GPT-6 is on the free tier now.", audience: "all", dryRun: true });
    assert.equal(named.status, 200);
    assert.equal(named.body.hasCapitals, true);
    assert.equal((await broadcast(s, admin, { ...COPY, audience: "all", dryRun: true })).body.hasCapitals, false);
    assert.equal(broadcastCopyProblem("ok", "Hey"), undefined);
    assert.equal(hasCapitals("see https://Example.com/A and Sina@Example.com", "ok"), false);
    assert.equal(hasCapitals("ok", "Hey"), true);
  });

  it("gets the same id from CRLF and LF line breaks, so a form and the API never send twice", async () => {
    const { s, admin } = await setup();
    const lf = await broadcast(s, admin, { ...COPY, audience: "all", dryRun: true });
    const crlf = await broadcast(s, admin, { ...COPY, text: COPY.text.replace(/\n/g, "\r\n"), audience: "all", dryRun: true });
    assert.equal(crlf.body.id, lf.body.id);
  });

  it("is for admins only, and refuses to send while user emails are off", async () => {
    const { s, admin } = await setup();
    const user = (await s.signIn({ id: 502, login: "iris" })).access_token;
    assert.equal((await broadcast(s, user, { ...COPY, audience: "all", dryRun: true })).status, 403);
    assert.equal((await s.request("POST", "/admin/config", { token: admin, body: { userEmails: false } })).status, 200);
    assert.equal((await broadcast(s, admin, { ...COPY, audience: "all", dryRun: false })).status, 409);
    assert.equal((await broadcast(s, admin, { ...COPY, audience: "all", dryRun: true })).status, 200);
  });
  describe("through Resend beside the binding (broadcastEmailProvider)", () => {
    const RESEND = { RESEND_API_KEY: "re_test_key" };

    function budgetRows(s: Service): Record<string, number> {
      const all = [...s.namespaces.DIRECTORY!.instances.get("directory")!.state.db.prepare("SELECT class, n FROM email_budget_daily").all()] as Array<{ class: string; n: number }>;
      return Object.fromEntries(all.map((row) => [row.class, row.n]));
    }

    it("sends broadcasts through Resend with the same stop link and List-Unsubscribe headers, counted apart from the binding's budget", async () => {
      // The binding's bulk share is 0: a broadcast through Resend doesn't need it.
      const { s, admin } = await setup({ ...RESEND, USER_EMAILS_DAILY_MAX: "0" });
      const before = s.calls.userEmail.length;
      const dry = await broadcast(s, admin, { ...COPY, audience: "all", dryRun: true });
      assert.equal(dry.body.provider, "resend");
      const result = await broadcast(s, admin, { ...COPY, audience: "all", dryRun: false });
      assert.equal(result.status, 200);
      assert.deepEqual([result.body.provider, result.body.sent, result.body.failed, result.body.remaining, result.body.stoppedBy], ["resend", 3, 0, 0, null]);
      assert.equal(s.calls.userEmail.length, before, "nothing through the binding");
      assert.deepEqual(s.calls.resend.map((call) => (call.body.to as string[])[0]), ["gail@example.com", "hal@example.com", "iris@example.com"]);
      for (const call of s.calls.resend) {
        assert.equal(call.headers.authorization, "Bearer re_test_key");
        assert.match(call.headers["idempotency-key"]!, new RegExp(`^dl-broadcast-${result.body.id}-50[0-2]$`));
        assert.equal(call.body.from, "sina <sina@directionallylocal.com>");
        assert.equal(call.body.reply_to, "contact@directionallylocal.com");
        assert.equal(call.body.subject, COPY.subject);
        const headers = call.body.headers as Record<string, string>;
        const link = /^<(.+)>$/.exec(headers["List-Unsubscribe"]!)![1]!;
        assert.match(link, /\/email\/stop\?u=50[0-2]&t=/);
        assert.equal(headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
        assert.equal(call.body.text, `${COPY.text}\n\ndon't want these? ${link}\n`);
      }
      assert.deepEqual(budgetRows(s), { resend_bulk: 3 }, "the binding's bulk and transactional counts are untouched");
    });

    it("stops at resendBulkDailyMax and carries on the next day", async () => {
      const { s, admin } = await setup({ ...RESEND, RESEND_BULK_DAILY_MAX: "2" });
      const first = await broadcast(s, admin, { ...COPY, audience: "all", dryRun: false });
      assert.deepEqual([first.body.sent, first.body.remaining, first.body.stoppedBy], [2, 1, "daily_budget"]);
      assert.equal(s.calls.resend.length, 2);
      assert.equal((await broadcast(s, admin, { ...COPY, audience: "all", dryRun: false })).body.sent, 0, "no room left today");
      // The setting changes at runtime like the others.
      assert.equal((await s.request("POST", "/admin/config", { token: admin, body: { resendBulkDailyMax: 3 } })).status, 200);
      const raised = await broadcast(s, admin, { ...COPY, audience: "all", dryRun: false });
      assert.deepEqual([raised.body.sent, raised.body.remaining], [1, 0]);
      assert.equal(budgetRows(s).resend_bulk, 3);
      assert.equal(s.calls.userEmail.length, 0);
    });

    it("counts a refused Resend send as failed, never falls back to the binding, and stops at Resend's 429", async () => {
      const { s, admin } = await setup(RESEND);
      const errors: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
      try {
        s.setResend((body) => ((body.to as string[])[0] === "gail@example.com" ? new Response("{}", { status: 403 }) : (body.to as string[])[0] === "hal@example.com" ? new Response("{}", { status: 429 }) : Response.json({ id: "ok" })));
        const first = await broadcast(s, admin, { ...COPY, audience: "all", dryRun: false });
        assert.deepEqual([first.body.provider, first.body.sent, first.body.failed, first.body.stoppedBy, first.body.remaining], ["resend", 0, 2, "http_429", 3]);
      } finally {
        console.error = original;
      }
      assert.equal(s.calls.userEmail.length, 0, "no fallback to the binding for bulk mail");
      assert.ok(errors.some((line) => line.includes("resend send failed: http_403")));
      assert.ok(errors.every((line) => !line.includes("re_test_key") && !line.includes("@example.com")), "never the key or an address");
      assert.deepEqual(
        rows(s).filter((row) => row.kind === "broadcast").map((row) => row.status),
        ["failed", "failed"],
      );
      s.setResend(() => Response.json({ id: "ok" }));
      const second = await broadcast(s, admin, { ...COPY, audience: "all", dryRun: false });
      assert.deepEqual([second.body.sent, second.body.failed, second.body.remaining], [3, 0, 0]);
    });

    it("goes back to the binding with broadcastEmailProvider cloudflare (POST /admin/config), against the binding's bulk share", async () => {
      const { s, admin } = await setup(RESEND);
      assert.equal((await s.request("POST", "/admin/config", { token: admin, body: { broadcastEmailProvider: "mailgun" } })).status, 400);
      assert.equal((await s.request("POST", "/admin/config", { token: admin, body: { broadcastEmailProvider: "cloudflare" } })).status, 200);
      const result = await broadcast(s, admin, { ...COPY, audience: "all", dryRun: false });
      assert.deepEqual([result.body.provider, result.body.sent], ["cloudflare", 3]);
      assert.equal(s.calls.resend.length, 0);
      assert.equal(s.calls.userEmail.length, 3);
      assert.deepEqual(budgetRows(s), { bulk: 3 });
    });

    it("sends lifecycle mail through Resend and transactional mail through the binding", async () => {
      const { s, admin } = await setup(RESEND);
      // The welcome (lifecycle, bulk) through Resend.
      await startBrowserFlow(s.request, { id: 520, login: "nia", email: "nia@example.com" });
      assert.deepEqual(s.calls.resend.map((call) => (call.body.to as string[])[0]), ["nia@example.com"]);
      assert.match((s.calls.resend[0]!.body.headers as Record<string, string>)["List-Unsubscribe"]!, /\/email\/stop\?u=520&t=/);
      assert.equal(s.calls.userEmail.length, 0);
      assert.equal(budgetRows(s).resend_bulk, 1);
      // The admin's test email takes the provider the real one would: typed copy as a broadcast, a kind by its class.
      const typed = await s.request("POST", "/admin/emails/test", { token: admin, body: { subject: "hi", text: "hey", to: "me@example.org" } });
      assert.equal(((await typed.json()) as { provider: string }).provider, "resend");
      const granted = await s.request("POST", "/admin/emails/test", { token: admin, body: { kind: "access_granted", to: "me@example.org" } });
      assert.equal(((await granted.json()) as { provider: string }).provider, "cloudflare");
      assert.equal(s.calls.userEmail.at(-1)!.to, "me@example.org");
    });

    it("routes per class: bulk to Resend only beside the binding with the setting on", () => {
      const binding = { send: async () => ({ messageId: "x" }) };
      const fetcher = async () => new Response();
      const both = userEmailRoutes(binding, { resendApiKey: "re_key", broadcastEmailProvider: "resend" }, fetcher);
      assert.deepEqual([both.transactional?.provider, both.bulk?.provider, both.bulkClass], ["cloudflare", "resend", "resend_bulk"]);
      assert.deepEqual([userEmailRoute(both, "broadcast").transport?.provider, userEmailRoute(both, "broadcast").budgetClass], ["resend", "resend_bulk"]);
      for (const kind of ["welcome", "weekly_reset", "plan_reset", "gone_quiet"] as const) assert.equal(userEmailRoute(both, kind).transport?.provider, "resend", kind);
      for (const kind of ["welcome_paid", "plan_80", "access_granted", "trial_converted"] as const) {
        assert.deepEqual([userEmailRoute(both, kind).transport?.provider, userEmailRoute(both, kind).budgetClass], ["cloudflare", "transactional"], kind);
      }
      const off = userEmailRoutes(binding, { resendApiKey: "re_key", broadcastEmailProvider: "cloudflare" }, fetcher);
      assert.deepEqual([off.bulk?.provider, off.bulkClass], ["cloudflare", "bulk"]);
      const noKey = userEmailRoutes(binding, { resendApiKey: undefined, broadcastEmailProvider: "resend" }, fetcher);
      assert.deepEqual([noKey.bulk?.provider, noKey.bulkClass], ["cloudflare", "bulk"]);
      // Resend alone (no binding): everything through it, on the one budget, as before.
      const resendOnly = userEmailRoutes(undefined, { resendApiKey: "re_key", broadcastEmailProvider: "resend" }, fetcher);
      assert.deepEqual([resendOnly.transactional?.provider, resendOnly.bulk?.provider, resendOnly.bulkClass], ["resend", "resend", "bulk"]);
      const none = userEmailRoutes(undefined, { resendApiKey: undefined, broadcastEmailProvider: "resend" }, fetcher);
      assert.deepEqual([none.transactional, none.bulk], [undefined, undefined]);
    });
  });
});
