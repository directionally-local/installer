import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, createService, NOW, startBrowserFlow, type Service } from "./harness.js";
import { policyOf } from "../src/queue.js";
import { readFreeConfig } from "../src/config.js";
import { broadcastCopyProblem, hasCapitals } from "../src/broadcast.js";
import { bindingSender, userEmailTransport } from "../src/user-email-send.js";

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

  it("sends the welcome through the binding, not Resend, with the same copy, sender, reply-to and headers", async () => {
    const s = await createService({ OPEN_ADMISSION: "true", RESEND_API_KEY: "re_test_key" }, { userEmail: true });
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
  async function setup(): Promise<{ s: Service; admin: string }> {
    const s = await createService({ OPEN_ADMISSION: "true" }, { userEmail: true });
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
});
