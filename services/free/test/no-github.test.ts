import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, createService, NOW, type Service } from "./harness.js";
import { NO_GITHUB_EMAILS_PER_DAY, parseNoGithubLead } from "../src/no-github.js";

// After the harness: app.js loads cloudflare:workers, which the harness resolves.
const { DIGEST_CRON } = await import("../src/app.js");

/**
 * "Don't have GitHub?": the link on the device page, GET /no-github (counts the click, emails the
 * owner), POST /no-github (keeps an answer), the admin read, the metrics, the CSVs, the
 * noGithubAlerts setting and the daily digest's line.
 */

const DAY = 86_400_000;
const VARS = { OPEN_ADMISSION: "true", ALERT_EMAIL_TO: "owner@example.com", ALERT_WEBHOOK_URL: "" };

function decode(raw: string): { subject: string; body: string; to: string } {
  const [head, body] = raw.split("\r\n\r\n") as [string, string];
  const subject = /\r\nSubject: ([^\r\n]*)\r\n/.exec(head)![1]!;
  const to = /\r\nTo: <([^>]*)>/.exec(head)![1]!;
  const text = new TextDecoder().decode(Uint8Array.from(atob(body.replace(/\r\n/g, "")), (char) => char.charCodeAt(0)));
  return { subject, body: text.replace(/\r\n/g, "\n"), to };
}

const emails = (s: Service) => s.calls.emails.map((call) => decode(call.raw)).filter((mail) => mail.subject.includes("Don't have GitHub?") || mail.subject.includes("daily"));
const click = (s: Service, from: string, ip?: string) => s.request("GET", `/no-github?from=${from}`, ip ? { ip } : {});
const answer = (s: Service, form: Record<string, string>, ip?: string) => s.request("POST", "/no-github", { form, ...(ip ? { ip } : {}) });

async function open(vars: Record<string, string> = {}): Promise<{ s: Service; admin: string }> {
  const s = await createService({ ...VARS, ...vars }, { email: true });
  const admin = (await s.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  s.calls.emails.length = 0;
  return { s, admin };
}

async function report(s: Service, admin: string, query = ""): Promise<Record<string, any>> {
  const response = await s.request("GET", `/v1/admin/no-github${query}`, { token: admin });
  assert.equal(response.status, 200);
  return (await response.json()) as Record<string, any>;
}

describe("the Don't have GitHub? link", () => {
  it("sits under Continue with GitHub on the device sign-in page", async () => {
    const s = await createService(VARS);
    const code = (await (await s.request("POST", "/v1/device/code", { body: {} })).json()) as { user_code: string };
    const page = await (await s.request("GET", `/device?user_code=${encodeURIComponent(code.user_code)}`)).text();
    assert.match(page, /Continue with GitHub<\/a>\s*<a class="link" href="\/no-github\?from=device">Don't have GitHub\?<\/a>/);
  });
});

describe("GET /no-github", () => {
  it("shows the form, counts the click and emails the owner on every click with the running count", async () => {
    const { s, admin } = await open();
    const response = await click(s, "dlnew");
    assert.equal(response.status, 200);
    const page = await response.text();
    assert.match(page, /dl's free tier uses GitHub to keep bots out\. Leave your email and we'll tell you when other sign-in options open\./);
    assert.match(page, /name="email"/);
    assert.match(page, /What do you use instead\? \(GitLab, Bitbucket, none…\)/);
    assert.match(page, /<input type="hidden" name="from" value="dlnew">/);
    await click(s, "device");
    await click(s, "dlnew");

    const mails = emails(s);
    assert.equal(mails.length, 3);
    assert.equal(mails[0]!.to, "owner@example.com");
    assert.equal(mails[0]!.subject, "dl free tier: someone clicked Don't have GitHub? (from dl.new)");
    assert.equal(mails[1]!.subject, "dl free tier: someone clicked Don't have GitHub? (from the dl sign-in page)");
    assert.match(mails[2]!.body, /Source: dl\.new \(from=dlnew\)/);
    assert.match(mails[2]!.body, /Time: 2026-11-04 12:00 UTC/);
    assert.match(mails[2]!.body, /Clicks today: 2 from dl\.new, 3 in all/);
    assert.match(mails[2]!.body, /Clicks so far: 3\./);

    const data = await report(s, admin);
    assert.deepEqual(data.days, [{ date: "2026-11-04", clicks: { device: 1, web: 0, dlnew: 2, other: 0 }, total: 3, leads: 0 }]);
    assert.equal(data.totals.clicks, 3);
  });

  it("counts an unknown source as other", async () => {
    const { s, admin } = await open();
    await click(s, "<script>");
    assert.equal((await report(s, admin)).days[0].clicks.other, 1);
  });

  it("is rate limited per network: past 20 an hour the page still shows, but nothing is counted or emailed", async () => {
    const { s, admin } = await open();
    for (let i = 0; i < 25; i++) assert.equal((await click(s, "dlnew")).status, 200);
    assert.equal((await report(s, admin)).totals.clicks, 20);
    assert.equal(emails(s).length, 20);
    // Another network is counted.
    await click(s, "dlnew", "198.51.100.9");
    assert.equal((await report(s, admin)).totals.clicks, 21);
  });

  it(`emails at most ${NO_GITHUB_EMAILS_PER_DAY} a UTC day; the rest go to the daily digest`, async () => {
    const { s } = await open();
    for (let i = 0; i < NO_GITHUB_EMAILS_PER_DAY + 3; i++) await click(s, "dlnew", `198.51.${Math.floor(i / 200)}.${i % 200}`);
    assert.equal(emails(s).filter((mail) => mail.subject.includes("clicked")).length, NO_GITHUB_EMAILS_PER_DAY);
    s.clock.now = Date.parse("2026-11-05T01:00:00Z");
    await (s.handler as any).scheduled({ cron: DIGEST_CRON, scheduledTime: s.clock.now }, s.env);
    const digest = emails(s).find((mail) => mail.subject.includes("daily"));
    assert.ok(digest);
    assert.match(digest.body, new RegExp(`Don't have GitHub\\?: ${NO_GITHUB_EMAILS_PER_DAY + 3} clicks \\(dlnew ${NO_GITHUB_EMAILS_PER_DAY + 3}\\), 0 left an email or answer`));
  });
});

describe("POST /no-github", () => {
  it("validates: a plausible email, an answer of at most 100 characters, and at least one of them", () => {
    assert.deepEqual(parseNoGithubLead(new URLSearchParams({ email: " me@example.com ", uses: "  GitLab\n " })), { ok: true, email: "me@example.com", uses: "GitLab" });
    assert.deepEqual(parseNoGithubLead(new URLSearchParams({ uses: "Bitbucket" })), { ok: true, email: null, uses: "Bitbucket" });
    assert.deepEqual(parseNoGithubLead(new URLSearchParams({ email: "me@example.com", uses: "" })), { ok: true, email: "me@example.com", uses: null });
    for (const bad of [{} as Record<string, string>, { email: "", uses: " " }, { email: "not-an-email" }, { email: "a b@example.com" }, { email: "me@example.com", uses: "x".repeat(101) }, { email: `${"a".repeat(250)}@example.com` }]) {
      assert.equal(parseNoGithubLead(new URLSearchParams(bad)).ok, false, JSON.stringify(bad));
    }
  });

  it("refuses a bad email with the form again, storing and emailing nothing", async () => {
    const { s, admin } = await open();
    const response = await answer(s, { from: "dlnew", email: "nope", uses: "<b>GitLab</b>" });
    assert.equal(response.status, 400);
    const page = await response.text();
    assert.match(page, /doesn&#39;t look right/);
    assert.match(page, /value="&lt;b&gt;GitLab&lt;\/b&gt;"/);
    assert.equal((await report(s, admin)).leads.length, 0);
    assert.equal(emails(s).length, 0);
  });

  it("stores the answer without the IP, and emails the owner the address and the answer", async () => {
    const { s, admin } = await open();
    const response = await answer(s, { from: "dlnew", email: "someone@example.com", uses: "GitLab" });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /We&#39;ll email you when other ways to sign in open/);
    const data = await report(s, admin);
    assert.deepEqual(data.leads, [{ at: new Date(NOW).toISOString(), source: "dlnew", email: "someone@example.com", uses: "GitLab" }]);
    assert.deepEqual(data.totals, { clicks: 0, leads: 1, emails: 1 });
    const rows = s.directory().ctx.storage.sql.exec("SELECT * FROM no_github_leads").toArray() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.match(String(rows[0]!.ip_hash), /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(rows).includes("203.0.113"));

    const [mail] = emails(s);
    assert.equal(mail!.subject, "dl free tier: someone left an email after Don't have GitHub? (from dl.new)");
    assert.match(mail!.body, /Email: someone@example\.com/);
    assert.match(mail!.body, /Uses instead: GitLab/);
    assert.match(mail!.body, /Answers kept: 1\./);
  });

  it("keeps one row per address, and drops the same anonymous answer from the same network that day", async () => {
    const { s, admin } = await open();
    await answer(s, { from: "dlnew", email: "Someone@example.com", uses: "GitLab" });
    await answer(s, { from: "device", email: "someone@example.com" });
    await answer(s, { from: "device", uses: "none" });
    await answer(s, { from: "device", uses: "none" });
    const data = await report(s, admin);
    assert.equal(data.leads.length, 2);
    const withEmail = data.leads.find((lead: any) => lead.email);
    assert.deepEqual({ source: withEmail.source, email: withEmail.email, uses: withEmail.uses }, { source: "device", email: "someone@example.com", uses: "GitLab" });
    // The repeat address emails again (marked), the dropped anonymous answer doesn't.
    assert.equal(emails(s).length, 3);
    assert.match(emails(s)[1]!.body, /again: the same address/);
  });

  it("is rate limited per network: 5 answers an hour, then 429", async () => {
    const { s } = await open();
    for (let i = 0; i < 5; i++) assert.equal((await answer(s, { from: "dlnew", email: `p${i}@example.com` })).status, 200);
    assert.equal((await answer(s, { from: "dlnew", email: "p9@example.com" })).status, 429);
    assert.equal((await answer(s, { from: "dlnew", email: "p9@example.com" }, "198.51.100.9")).status, 200);
  });
});

describe("noGithubAlerts", () => {
  it('"daily" sends no email per click or answer, and puts one line in the daily digest', async () => {
    const { s, admin } = await open();
    assert.equal((await s.request("POST", "/admin/config", { token: admin, body: { noGithubAlerts: "daily" } })).status, 200);
    await click(s, "dlnew");
    await click(s, "device");
    await answer(s, { from: "dlnew", email: "someone@example.com" });
    assert.equal(emails(s).length, 0);
    s.clock.now = NOW + DAY;
    await (s.handler as any).scheduled({ cron: DIGEST_CRON, scheduledTime: Date.parse("2026-11-05T01:00:00Z") }, s.env);
    const digest = emails(s).find((mail) => mail.subject.includes("daily"));
    assert.ok(digest);
    assert.match(digest.body, /Don't have GitHub\?: 2 clicks \(device 1, dlnew 1\), 1 left an email or answer\. GET \/v1\/admin\/no-github/);
    assert.ok(!digest.body.includes("someone@example.com"));
  });

  it('"off" sends nothing and adds no digest line, but still counts and stores', async () => {
    const { s, admin } = await open({ NO_GITHUB_ALERTS: "off" });
    await click(s, "dlnew");
    await answer(s, { from: "dlnew", email: "someone@example.com" });
    assert.equal(emails(s).length, 0);
    const data = await report(s, admin, "?days=7");
    assert.equal(data.totals.clicks, 1);
    assert.equal(data.leads.length, 1);
    s.clock.now = NOW + DAY;
    await (s.handler as any).scheduled({ cron: DIGEST_CRON, scheduledTime: Date.parse("2026-11-05T01:00:00Z") }, s.env);
    const digest = emails(s).find((mail) => mail.subject.includes("daily"));
    assert.ok(digest);
    assert.doesNotMatch(digest.body, /Don't have GitHub/);
  });

  it("refuses a value that isn't each, daily or off", async () => {
    const { s, admin } = await open();
    assert.equal((await s.request("POST", "/admin/config", { token: admin, body: { noGithubAlerts: "hourly" } })).status, 400);
  });
});

describe("the admin side", () => {
  it("GET /v1/admin/no-github is admins only and checks ?days", async () => {
    const { s, admin } = await open();
    const person = (await s.signIn({ id: 500, login: "someone" })).access_token;
    assert.equal((await s.request("GET", "/v1/admin/no-github", { token: person })).status, 403);
    assert.equal((await s.request("GET", "/v1/admin/no-github?days=0", { token: admin })).status, 400);
    assert.equal((await s.request("GET", "/v1/admin/no-github?days=367", { token: admin })).status, 400);
  });

  it("puts daily counts in /v1/admin/metrics, a card on the Tools tab, and two CSVs", async () => {
    const { s, admin } = await open();
    await click(s, "dlnew");
    await answer(s, { from: "dlnew", email: "someone@example.com", uses: "=cmd|' /C calc'!A0" });
    const metrics = (await (await s.request("GET", "/v1/admin/metrics", { token: admin })).json()) as Record<string, any>;
    assert.deepEqual(metrics.noGithub, [{ date: "2026-11-04", clicks: { device: 0, web: 0, dlnew: 1, other: 0 }, total: 1, leads: 1 }]);

    const tools = await (await s.request("GET", "/admin?view=tools", { token: admin })).text();
    assert.match(tools, /<h2>Don't have GitHub\?<\/h2>/);
    assert.match(tools, /someone@example\.com/);
    assert.match(tools, /href="\/admin\/dashboard\/no-github\.csv"/);

    const answers = await s.request("GET", "/admin/dashboard/no-github.csv", { token: admin });
    assert.equal(answers.status, 200);
    const text = await answers.text();
    assert.match(text, /^date,source,email,uses\r\n2026-11-04,dlnew,someone@example\.com,'=cmd/);
    const clicks = await (await s.request("GET", "/admin/dashboard/no-github-clicks.csv", { token: admin })).text();
    assert.equal(clicks, "date,device,web,dlnew,other,total,answers\r\n2026-11-04,0,0,1,0,1,1\r\n");
  });
});

describe("a Directory still on the previous code (just after a deploy)", () => {
  // Production, 23 Nov: right after the deploy that added /no-github, the one Directory object kept
  // running the previous code for a few minutes, so the RPC threw "The RPC receiver does not
  // implement the method "noGithubClick"" and the page answered 500. The page must still show.
  const missing = (method: string) => () => {
    throw new TypeError(`The RPC receiver does not implement the method "${method}".`);
  };
  async function withoutMethods<T>(run: () => Promise<T>): Promise<T> {
    const { DirectoryObject } = await import("../src/directory-object.js");
    const proto = DirectoryObject.prototype as unknown as Record<string, unknown>;
    const saved = { noGithubClick: proto.noGithubClick, noGithubLead: proto.noGithubLead };
    proto.noGithubClick = missing("noGithubClick");
    proto.noGithubLead = missing("noGithubLead");
    try {
      return await run();
    } finally {
      Object.assign(proto, saved);
    }
  }

  it("GET still shows the form (200), counting and emailing nothing", async () => {
    const { s } = await open();
    const response = await withoutMethods(() => click(s, "web"));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /name="email"/);
    assert.equal(emails(s).length, 0);
  });

  it("POST asks to try again (503), not a 500", async () => {
    const { s } = await open();
    const response = await withoutMethods(() => answer(s, { from: "web", email: "someone@example.com" }));
    assert.equal(response.status, 503);
    assert.match(await response.text(), /try again in a minute/);
    assert.equal(emails(s).length, 0);
  });
});
