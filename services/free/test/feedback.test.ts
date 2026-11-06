import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createService, errorCode, NOW, type Service } from "./harness.js";
import { mimeMessage } from "../src/alerts.js";
import { clearEmailCache, feedbackEmail, parseFeedback, publicGithubEmail } from "../src/feedback.js";

const HOUR = 3_600_000;

function decodeEmail(raw: string): { headers: Record<string, string>; head: string; body: string } {
  const [head, body] = raw.split("\r\n\r\n") as [string, string];
  const headers: Record<string, string> = {};
  for (const line of head.split("\r\n")) {
    const at = line.indexOf(": ");
    headers[line.slice(0, at).toLowerCase()] = line.slice(at + 2);
  }
  const text = new TextDecoder().decode(Uint8Array.from(atob(body.replace(/\r\n/g, "")), (char) => char.charCodeAt(0)));
  return { headers, head, body: text.replace(/\r\n/g, "\n") };
}

async function service(vars: Record<string, string> = {}, email = true): Promise<Service> {
  return createService({ OPEN_ADMISSION: "true", ALERT_EMAIL_TO: "owner@example.com", ...vars }, { email });
}

function profileEmail(email: string | null) {
  return (login: string) => Response.json({ login, email });
}

/** The feedback emails (sign-up alerts go through the same binding). */
function mails(s: Service) {
  return s.calls.emails.filter((email) => /\r\nSubject: dl feedback/.test(email.raw));
}

async function send(s: Service, body: unknown, options: { token?: string; ip?: string } = {}) {
  return s.request("POST", "/v1/feedback", { body, ...options });
}

/** Every row of every table in every Durable Object, as one string. */
function everything(s: Service): string {
  const out: string[] = [];
  for (const namespace of Object.values(s.namespaces)) {
    for (const { state } of namespace.instances.values()) {
      const tables = state.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
      for (const { name } of tables) out.push(JSON.stringify(state.db.prepare(`SELECT * FROM "${name}"`).all()));
    }
  }
  return out.join("\n");
}

beforeEach(() => clearEmailCache());

describe("POST /v1/feedback, signed in", () => {
  it("uses the public GitHub email as Reply-To and says so", async () => {
    const s = await service();
    s.setGithubProfile(profileEmail("alice@example.org"));
    const { access_token } = await s.signIn({ id: 501, login: "alice" });
    const response = await send(s, { message: "The deck froze when I\nresized the window.", client: { dl: "0.11.0", autopilot: "3.5.0", os: "macos", arch: "arm64", provider: "free" } }, { token: access_token });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, replyTo: "alice@example.org" });
    assert.equal(s.calls.githubProfiles.length, 1);
    assert.equal(s.calls.githubProfiles[0]!.login, "alice");
    assert.equal(s.calls.githubProfiles[0]!.headers["user-agent"], "dl-free-feedback");
    assert.equal(s.calls.githubProfiles[0]!.headers.authorization, undefined, "the lookup is unauthenticated");
    assert.equal(mails(s).length, 1);
    const sent = mails(s)[0]!;
    assert.equal(sent.to, "owner@example.com");
    assert.equal(sent.from, "alerts@dl.new");
    const { headers, body } = decodeEmail(sent.raw);
    assert.equal(headers["subject"], "dl feedback from @alice");
    assert.equal(headers["reply-to"], "<alice@example.org>");
    assert.equal(headers["from"], "dl feedback <alerts@dl.new>");
    assert.ok(body.startsWith("The deck froze when I\nresized the window.\n\n"), body);
    assert.match(body, /From: @alice \(https:\/\/github\.com\/alice\), GitHub id 501/);
    assert.match(body, /Reply to: alice@example\.org \(their public GitHub email\)/);
    assert.match(body, /Client: dl 0\.11\.0, Autopilot 3\.5\.0, OS macos, Arch arm64, Provider free/);
    assert.match(body, /Time: 2026-11-04 12:00:00 UTC/);
    assert.doesNotMatch(body, /Reply through GitHub/);
  });

  it("without a public email: no Reply-To, and the body says they can't get a reply", async () => {
    const s = await service();
    const { access_token } = await s.signIn({ id: 502, login: "bob" });
    const response = await send(s, { message: "hello" }, { token: access_token });
    assert.deepEqual(await response.json(), { ok: true, replyTo: null });
    const { headers, head, body } = decodeEmail(mails(s)[0]!.raw);
    assert.equal(headers["reply-to"], undefined);
    assert.doesNotMatch(head, /Reply-To/i);
    assert.match(body, /Reply to: no email given: they can't get a reply/);
    assert.match(body, /Reply through GitHub: open an issue mention or DM @bob/);
    assert.match(body, /Client: not given/);
  });

  it("an email given with the feedback wins over the public one, without asking GitHub", async () => {
    const s = await service();
    s.setGithubProfile(profileEmail("alice@example.org"));
    const { access_token } = await s.signIn({ id: 501, login: "alice" });
    const response = await send(s, { message: "hi", email: "alice+dl@work.example" }, { token: access_token });
    assert.deepEqual(await response.json(), { ok: true, replyTo: "alice+dl@work.example" });
    assert.equal(s.calls.githubProfiles.length, 0);
    const { headers, body } = decodeEmail(mails(s)[0]!.raw);
    assert.equal(headers["reply-to"], "<alice+dl@work.example>");
    assert.match(body, /Reply to: alice\+dl@work\.example \(given with the feedback\)/);
  });

  it("never uses a GitHub noreply address: a public one is ignored, a given one falls back to the lookup", async () => {
    const s = await service();
    s.setGithubProfile(profileEmail("501+alice@users.noreply.github.com"));
    const { access_token } = await s.signIn({ id: 501, login: "alice" });
    const first = await send(s, { message: "one" }, { token: access_token });
    assert.deepEqual(await first.json(), { ok: true, replyTo: null });
    assert.equal(decodeEmail(mails(s)[0]!.raw).headers["reply-to"], undefined);

    clearEmailCache();
    s.setGithubProfile(profileEmail("alice@example.org"));
    const second = await send(s, { message: "two", email: "501+alice@users.noreply.github.com" }, { token: access_token });
    assert.deepEqual(await second.json(), { ok: true, replyTo: "alice@example.org" });
  });

  it("a GitHub error or a bad profile email means no Reply-To, and the feedback still goes", async () => {
    const s = await service();
    s.setGithubProfile(() => new Response("nope", { status: 502 }));
    const { access_token } = await s.signIn({ id: 501, login: "alice" });
    assert.deepEqual(await (await send(s, { message: "one" }, { token: access_token })).json(), { ok: true, replyTo: null });
    s.setGithubProfile(profileEmail("alice@example.org\r\nBcc: evil@example.com"));
    assert.deepEqual(await (await send(s, { message: "two" }, { token: access_token })).json(), { ok: true, replyTo: null });
    for (const email of mails(s)) assert.doesNotMatch(email.raw.split("\r\n\r\n")[0]!, /^(Reply-To|Bcc):/im);
  });

  it("refuses an invalid bearer (401) rather than sending it as anonymous", async () => {
    const s = await service();
    const response = await send(s, { message: "hi" }, { token: "not-a-token" });
    assert.equal(response.status, 401);
    assert.equal(mails(s).length, 0);
  });
});

describe("POST /v1/feedback, anonymous", () => {
  it("is allowed, says not signed in, and never asks GitHub", async () => {
    const s = await service();
    const response = await send(s, { message: "Install failed on step 3" });
    assert.deepEqual(await response.json(), { ok: true, replyTo: null });
    assert.equal(s.calls.githubProfiles.length, 0);
    const { headers, body } = decodeEmail(mails(s)[0]!.raw);
    assert.equal(headers["subject"], "dl feedback (not signed in)");
    assert.equal(headers["reply-to"], undefined);
    assert.match(body, /From: not signed in/);
    assert.match(body, /no email given: they can't get a reply/);
    assert.doesNotMatch(body, /Reply through GitHub/);
  });

  it("uses an email given with it", async () => {
    const s = await service();
    const response = await send(s, { message: "hi", email: "someone@example.com" });
    assert.deepEqual(await response.json(), { ok: true, replyTo: "someone@example.com" });
    assert.equal(decodeEmail(mails(s)[0]!.raw).headers["reply-to"], "<someone@example.com>");
  });

  it("is 503 when the service has no email channel", async () => {
    const s = await service({}, false);
    const response = await send(s, { message: "hi" });
    assert.equal(response.status, 503);
    assert.equal(await errorCode(response), "feedback_unavailable");
  });
});

describe("POST /v1/feedback, validation", () => {
  it("rejects header injection in the email", async () => {
    const s = await service();
    for (const email of ["a@example.com\r\nBcc: evil@example.com", "a@example.com\nBcc: evil@example.com", "a@example.com\rX: y", "a b@example.com", "Evil <a@example.com>", "a@b@example.com", "noat.example.com", `${"a".repeat(250)}@example.com`, 42]) {
      const response = await send(s, { message: "hi", email });
      assert.equal(response.status, 400, JSON.stringify(email));
      assert.equal(await errorCode(response), "invalid_email");
    }
    assert.equal(mails(s).length, 0);
  });

  it("mimeMessage refuses a Reply-To with CR or LF", () => {
    const base = { from: "alerts@dl.new", to: "owner@example.com", subject: "s", body: "b", now: NOW, messageId: "m" };
    assert.throws(() => mimeMessage({ ...base, replyTo: "a@example.com\r\nBcc: evil@example.com" }));
    assert.throws(() => mimeMessage({ ...base, replyTo: "a@example.com\n" }));
    assert.match(mimeMessage({ ...base, replyTo: "a@example.com" }), /\r\nReply-To: <a@example\.com>\r\n/);
    assert.doesNotMatch(mimeMessage(base), /Reply-To/);
  });

  it("a message that looks like headers stays in the body", async () => {
    const s = await service();
    await send(s, { message: "\r\nBcc: evil@example.com\r\n\r\nhi" });
    const [head] = mails(s)[0]!.raw.split("\r\n\r\n") as [string];
    assert.doesNotMatch(head, /Bcc/);
  });

  it("limits the message to 1..5000 characters", async () => {
    const s = await service();
    for (const body of [{}, { message: "" }, { message: "   \n " }, { message: 5 }, { message: "x".repeat(5001) }]) {
      const response = await send(s, body);
      assert.equal(response.status, 400, JSON.stringify(body).slice(0, 40));
      assert.equal(await errorCode(response), "invalid_request");
    }
    assert.equal((await send(s, { message: "x".repeat(5000) })).status, 200);
    // Characters, not UTF-16 units: 5,000 emoji fit.
    assert.equal((await send(s, { message: "🙂".repeat(5000) }, { ip: "198.51.100.1" })).status, 200);
    assert.equal(decodeEmail(mails(s)[1]!.raw).body.startsWith("🙂".repeat(5000)), true);
    assert.equal((await send(s, "not json", { ip: "198.51.100.1" })).status, 400);
    assert.equal((await send(s, { message: "x".repeat(40_000) }, { ip: "198.51.100.1" })).status, 413);
  });

  it("keeps only the allowlisted client fields and checks them", async () => {
    const parsed = parseFeedback({ message: "hi", client: { dl: "0.11.0", os: "linux", secret: "sk-123", provider: "own-key" } });
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.value.client, { dl: "0.11.0", os: "linux", provider: "own-key" });
    for (const client of [{ os: "linux\nBcc: x" }, { dl: "x".repeat(41) }, { provider: "openai" }, { arch: "<b>" }, { dl: 1 }, "macos"]) {
      const result = parseFeedback({ message: "hi", client });
      assert.equal(result.ok, false, JSON.stringify(client));
    }
  });
});

describe("POST /v1/feedback, rate limits", () => {
  it("allows 10 an hour per network", async () => {
    const s = await service();
    for (let i = 0; i < 10; i++) assert.equal((await send(s, { message: `m${i}` })).status, 200);
    const refused = await send(s, { message: "eleven" });
    assert.equal(refused.status, 429);
    const body = (await refused.json()) as { error: { code: string; retryAfter: number } };
    assert.equal(body.error.code, "rate_limited");
    assert.ok(body.error.retryAfter > 0);
    assert.equal(refused.headers.get("retry-after"), String(body.error.retryAfter));
    assert.equal((await send(s, { message: "other network" }, { ip: "198.51.100.9" })).status, 200);
    s.clock.now += HOUR;
    assert.equal((await send(s, { message: "next hour" })).status, 200);
    assert.equal(mails(s).length, 12);
  });

  it("allows a signed-in person 5 an hour and 20 a day, from any network", async () => {
    const s = await service();
    let { access_token } = await s.signIn({ id: 501, login: "alice" });
    let ip = 0;
    const next = () => send(s, { message: "hi" }, { token: access_token, ip: `198.51.100.${++ip}` });
    for (let i = 0; i < 5; i++) assert.equal((await next()).status, 200);
    assert.equal((await next()).status, 429, "sixth in the hour");
    // Four hours of 5 an hour: 20, and the day bucket has only refilled about 3 since.
    for (let hour = 1; hour <= 3; hour++) {
      s.clock.now += HOUR;
      ({ access_token } = await s.signIn({ id: 501, login: "alice" }));
      for (let i = 0; i < 5; i++) assert.equal((await next()).status, 200, `hour ${hour}, ${i}`);
    }
    s.clock.now += HOUR;
    ({ access_token } = await s.signIn({ id: 501, login: "alice" }));
    for (let i = 0; i < 3; i++) assert.equal((await next()).status, 200);
    const refused = await next();
    assert.equal(refused.status, 429, "the day's limit, with the hour's not used up");
    assert.equal(await errorCode(refused), "rate_limited");
    assert.equal(mails(s).length, 23);
  });
});

describe("POST /v1/feedback stores nothing", () => {
  it("keeps neither the message nor the address in any Durable Object", async () => {
    const s = await service();
    s.setGithubProfile(profileEmail("alice-public@example.org"));
    const { access_token } = await s.signIn({ id: 501, login: "alice" });
    await send(s, { message: "SECRET-FEEDBACK-TEXT-1" }, { token: access_token });
    await send(s, { message: "SECRET-FEEDBACK-TEXT-2", email: "typed-address@example.net" }, { token: access_token, ip: "198.51.100.7" });
    // Anonymous, from an address only feedback has used (sign-in keeps its own network records).
    await send(s, { message: "SECRET-FEEDBACK-TEXT-3", email: "anon-address@example.net" }, { ip: "198.51.100.7" });
    assert.equal(mails(s).length, 3);
    const stored = everything(s);
    for (const needle of ["SECRET-FEEDBACK", "alice-public", "typed-address", "anon-address", "198.51.100.7"]) {
      assert.ok(!stored.includes(needle), `${needle} is stored`);
    }
  });
});

describe("GET /v1/feedback/reply-address", () => {
  it("needs a sign-in", async () => {
    const s = await service();
    assert.equal((await s.request("GET", "/v1/feedback/reply-address")).status, 401);
  });

  it("returns the public email, cached for 10 minutes; errors aren't cached", async () => {
    const s = await service();
    s.setGithubProfile(profileEmail("alice@example.org"));
    const { access_token } = await s.signIn({ id: 501, login: "alice" });
    const get = async () => (await s.request("GET", "/v1/feedback/reply-address", { token: access_token })).json();
    assert.deepEqual(await get(), { email: "alice@example.org" });
    assert.deepEqual(await get(), { email: "alice@example.org" });
    await send(s, { message: "hi" }, { token: access_token });
    assert.equal(s.calls.githubProfiles.length, 1, "the second read and the feedback used the cache");
    s.clock.now += 10 * 60_000;
    s.setGithubProfile(() => new Response("down", { status: 503 }));
    assert.deepEqual(await get(), { email: null });
    s.setGithubProfile(profileEmail(null));
    assert.deepEqual(await get(), { email: null });
    assert.equal(s.calls.githubProfiles.length, 3);
  });
});

describe("publicGithubEmail", () => {
  it("gives up after the timeout, even when the fetch ignores the abort", async () => {
    const started = Date.now();
    const email = await publicGithubEmail("slow", () => new Promise<Response>(() => {}), NOW, 30);
    assert.equal(email, null);
    assert.ok(Date.now() - started < 1000);
  });

  it("doesn't ask about something that isn't a GitHub login", async () => {
    let asked = false;
    const fetcher = async () => {
      asked = true;
      return Response.json({ email: "x@example.com" });
    };
    assert.equal(await publicGithubEmail("../orgs/x", fetcher, NOW), null);
    assert.equal(asked, false);
  });
});

describe("feedbackEmail", () => {
  it("prints a sample", () => {
    const mail = feedbackEmail({
      message: "dl deck crashed when I opened the third session.",
      sender: { login: "alice", githubId: 501 },
      replyTo: null,
      replySource: undefined,
      client: { dl: "0.11.0", autopilot: "3.5.0", os: "linux", arch: "x64", provider: "free" },
      at: NOW,
    });
    assert.equal(mail.subject, "dl feedback from @alice");
    assert.match(mail.body, /^dl deck crashed when I opened the third session\.\n\n──────────\nFrom: @alice/);
  });
});
