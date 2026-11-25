import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, createService, type Service } from "./harness.js";
import { PROVIDER_INQUIRIES_PER_DAY, PROVIDER_INQUIRY_EMAILS_PER_DAY, parseProviderInquiry } from "../src/provider-inquiry.js";

/** POST /web/provider-inquiry (dl.new/providers' form), its owner email, and the admin list. */

const ORIGIN = "https://dl.new";
const VARS = { OPEN_ADMISSION: "true", ALERT_EMAIL_TO: "owner@example.com", ALERT_WEBHOOK_URL: "" };
const VALID = { company: "Acme Inference", name: "Ada Lovelace", email: "ada@acme.example.com" };

function decode(raw: string): { subject: string; body: string; to: string; replyTo: string | undefined; head: string } {
  const [head, body] = raw.split("\r\n\r\n") as [string, string];
  const subject = /\r\nSubject: ([^\r\n]*)\r\n/.exec(head)![1]!;
  const to = /\r\nTo: <([^>]*)>/.exec(head)![1]!;
  const replyTo = /\r\nReply-To: <([^>]*)>/.exec(head)?.[1];
  const text = new TextDecoder().decode(Uint8Array.from(atob(body.replace(/\r\n/g, "")), (char) => char.charCodeAt(0)));
  return { subject, body: text.replace(/\r\n/g, "\n"), to, replyTo, head };
}

const mails = (s: Service) => s.calls.emails.map((call) => decode(call.raw)).filter((mail) => mail.subject.startsWith("Provider inquiry"));
const submit = (s: Service, body: unknown, ip = "203.0.113.7") => s.request("POST", "/web/provider-inquiry", { body, ip, headers: { origin: ORIGIN } });

async function open(): Promise<{ s: Service; admin: string }> {
  const s = await createService(VARS, { email: true });
  const admin = (await s.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  s.calls.emails.length = 0;
  return { s, admin };
}

async function list(s: Service, admin: string): Promise<{ total: number; inquiries: Array<Record<string, unknown>> }> {
  const response = await s.request("GET", "/v1/admin/provider-inquiries", { token: admin });
  assert.equal(response.status, 200);
  return (await response.json()) as { total: number; inquiries: Array<Record<string, unknown>> };
}

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  const body = (await response.json()) as { error: { code: string; message: string } };
  return body.error;
}

describe("POST /web/provider-inquiry", () => {
  it("keeps a valid inquiry, emails the owner every field, and answers {ok: true} with dl.new's CORS", async () => {
    const { s, admin } = await open();
    const response = await submit(s, {
      company: "  Acme Inference ",
      name: "Ada Lovelace",
      email: "ada@acme.example.com",
      website: "https://acme.example.com",
      models: "DeepSeek V4, GLM 5",
      regions: "EU, US",
      credits: "$5,000",
      notes: "Line one\r\nLine two",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(response.headers.get("access-control-allow-origin"), ORIGIN);
    assert.equal(response.headers.get("cache-control"), "no-store");

    const data = await list(s, admin);
    assert.equal(data.total, 1);
    const stored = data.inquiries[0]!;
    assert.equal(stored.company, "Acme Inference");
    assert.equal(stored.credits, "$5,000");
    assert.equal(stored.notes, "Line one\nLine two");
    assert.equal(stored.at, "2026-11-04T12:00:00.000Z");
    assert.equal("ip" in stored, false);

    const sent = mails(s);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, "owner@example.com");
    assert.equal(sent[0]!.subject, "Provider inquiry: Acme Inference");
    assert.equal(sent[0]!.replyTo, "ada@acme.example.com");
    for (const line of ["Company: Acme Inference", "Name: Ada Lovelace", "Email: ada@acme.example.com", "Website: https://acme.example.com", "Models: DeepSeek V4, GLM 5", "Regions: EU, US", "Credits: $5,000", "Notes:\nLine one\nLine two"]) {
      assert.ok(sent[0]!.body.includes(line), line);
    }

    const tools = await (await s.request("GET", "/admin?view=tools", { token: admin })).text();
    assert.match(tools, /<h2>Provider inquiries<\/h2>/);
    assert.match(tools, /Acme Inference/);
  });

  it("marks optional fields not given, and keeps CR/LF and HTML out of the subject and headers", async () => {
    const { s } = await open();
    const response = await submit(s, { ...VALID, company: "Evil\r\nBcc: x@evil.example <b>Co</b>" });
    assert.equal(response.status, 200);
    const sent = mails(s)[0]!;
    assert.equal(sent.subject, "Provider inquiry: Evil Bcc: x@evil.example <b>Co</b>");
    assert.doesNotMatch(sent.head, /\r\nBcc:/);
    assert.match(sent.body, /Website: \(not given\)/);
    assert.match(sent.body, /Notes: \(not given\)/);
  });

  it("escapes what people wrote on the admin Tools tab", async () => {
    const { s, admin } = await open();
    await submit(s, { ...VALID, notes: "<script>alert(1)</script>" });
    const tools = await (await s.request("GET", "/admin?view=tools", { token: admin })).text();
    assert.doesNotMatch(tools, /<script>alert\(1\)<\/script>/);
    assert.match(tools, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  it("refuses a missing required field with 400 invalid_request naming it", async () => {
    const { s, admin } = await open();
    for (const field of ["company", "name", "email"] as const) {
      const body: Record<string, string> = { ...VALID };
      delete body[field];
      const response = await submit(s, body);
      assert.equal(response.status, 400);
      const error = await errorOf(response);
      assert.equal(error.code, "invalid_request");
      assert.equal(error.message, `${field} is required.`);
    }
    const blank = await submit(s, { ...VALID, name: "   " });
    assert.equal(blank.status, 400);
    assert.equal((await errorOf(blank)).message, "name is required.");
    assert.equal((await list(s, admin)).total, 0);
    assert.equal(mails(s).length, 0);
  });

  it("refuses a bad email with 400", async () => {
    const { s } = await open();
    for (const email of ["ada", "ada@acme", "ada@@acme.com", "ada @acme.com", "@acme.com"]) {
      const response = await submit(s, { ...VALID, email });
      assert.equal(response.status, 400, email);
      const error = await errorOf(response);
      assert.equal(error.code, "invalid_request");
      assert.equal(error.message, "email must be a valid email address.");
    }
  });

  it("refuses an oversized field, an unknown field, a non-string, a non-object and a too-large body with 400", async () => {
    const { s } = await open();
    const cases: Array<[unknown, string]> = [
      [{ ...VALID, company: "x".repeat(121) }, "company can be at most 120 characters."],
      [{ ...VALID, email: `${"a".repeat(190)}@acme.example.com` }, "email can be at most 200 characters."],
      [{ ...VALID, notes: "n".repeat(2001) }, "notes can be at most 2000 characters."],
      [{ ...VALID, credits: "$".repeat(201) }, "credits can be at most 200 characters."],
      [{ ...VALID, phone: "123" }, "Unknown field: phone."],
      [{ ...VALID, models: ["a"] }, "models must be a string."],
      [[VALID], "Send a JSON object: {company, name, email, website?, models?, regions?, credits?, notes?}."],
    ];
    for (const [body, message] of cases) {
      const response = await submit(s, body);
      assert.equal(response.status, 400, message);
      assert.deepEqual(await errorOf(response), { code: "invalid_request", message });
    }
    const huge = await submit(s, JSON.stringify({ ...VALID, notes: "x".repeat(40_000) }));
    assert.equal(huge.status, 400);
    assert.equal((await errorOf(huge)).message, "The inquiry is too large.");
    // Exactly at the limits is fine.
    const edge = await submit(s, { ...VALID, company: "c".repeat(120), notes: "n".repeat(2000) });
    assert.equal(edge.status, 200);
  });

  it("rate limits a network to 5 an hour with 429 rate_limited", async () => {
    const { s, admin } = await open();
    for (let i = 0; i < 5; i++) assert.equal((await submit(s, VALID)).status, 200);
    const refused = await submit(s, VALID);
    assert.equal(refused.status, 429);
    assert.equal((await errorOf(refused)).code, "rate_limited");
    assert.ok(Number(refused.headers.get("retry-after")) > 0);
    // Another network still gets through.
    assert.equal((await submit(s, VALID, "198.51.100.9")).status, 200);
    assert.equal((await list(s, admin)).total, 6);
  });

  it("keeps at most PROVIDER_INQUIRIES_PER_DAY a UTC day in all, and emails only the first PROVIDER_INQUIRY_EMAILS_PER_DAY", async () => {
    const { s, admin } = await open();
    for (let i = 0; i < PROVIDER_INQUIRIES_PER_DAY; i++) assert.equal((await submit(s, VALID, `10.0.${Math.floor(i / 200)}.${i % 200}`)).status, 200);
    const refused = await submit(s, VALID, "192.0.2.1");
    assert.equal(refused.status, 429);
    assert.equal((await errorOf(refused)).code, "rate_limited");
    assert.equal((await list(s, admin)).total, PROVIDER_INQUIRIES_PER_DAY);
    assert.equal(mails(s).length, PROVIDER_INQUIRY_EMAILS_PER_DAY);
    // The next UTC day opens again.
    s.clock.now += 86_400_000;
    assert.equal((await submit(s, VALID, "192.0.2.1")).status, 200);
  });

  it("answers 405 for other methods, 204 to dl.new's preflight, and 403 to another site", async () => {
    const { s } = await open();
    const get = await s.request("GET", "/web/provider-inquiry", { headers: { origin: ORIGIN } });
    assert.equal(get.status, 405);
    assert.equal((await errorOf(get)).code, "method_not_allowed");
    assert.equal((await s.request("PUT", "/web/provider-inquiry", { body: VALID, headers: { origin: ORIGIN } })).status, 405);
    const preflight = await s.request("OPTIONS", "/web/provider-inquiry", { headers: { origin: ORIGIN, "access-control-request-method": "POST" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), ORIGIN);
    const evil = await s.request("POST", "/web/provider-inquiry", { body: VALID, headers: { origin: "https://evil.example" } });
    assert.equal(evil.status, 403);
    assert.equal((await errorOf(evil)).code, "forbidden_origin");
  });

  it("is admins-only to list", async () => {
    const { s } = await open();
    const someone = (await s.signIn({ id: 4242, login: "someone" })).access_token;
    assert.equal((await s.request("GET", "/v1/admin/provider-inquiries", { token: someone })).status, 403);
  });
});

describe("parseProviderInquiry", () => {
  it("trims, drops empty optional fields, and turns line breaks in one-line fields into spaces", () => {
    const parsed = parseProviderInquiry({ ...VALID, website: "  ", regions: "EU\nUS", notes: null });
    assert.deepEqual(parsed, { ok: true, value: { ...VALID, website: null, models: null, regions: "EU US", credits: null, notes: null } });
  });
});
