import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ADMIN_ID, createInvite, createService, MODEL, NOW, type Service } from "./harness.js";
import { policyOf } from "../src/queue.js";
import { readFreeConfig } from "../src/config.js";

// After the harness: app.js loads cloudflare:workers, which the harness resolves.
const { DIGEST_CRON } = await import("../src/app.js");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** NOW is Wed 2026-11-04 12:00 UTC; the digest at 01:00 that day reports Tue 2026-11-03. */
const TUESDAY = Date.parse("2026-11-03T00:00:00Z");
const DIGEST_AT = Date.parse("2026-11-04T01:00:00Z");

const texts = (service: Service) => service.calls.webhooks.map((hook) => String(hook.body.text));

function decodeEmail(raw: string): { subject: string; body: string } {
  const [head, body] = raw.split("\r\n\r\n") as [string, string];
  const subject = /\r\nSubject: ([^\r\n]*)\r\n/.exec(head)![1]!;
  const text = new TextDecoder().decode(Uint8Array.from(atob(body.replace(/\r\n/g, "")), (char) => char.charCodeAt(0)));
  return { subject, body: text.replace(/\r\n/g, "\n") };
}

async function scheduled(service: Service, at: number, cron = DIGEST_CRON): Promise<void> {
  await (service.handler as unknown as { scheduled(controller: { cron: string; scheduledTime: number }, env: never): Promise<void> }).scheduled({ cron, scheduledTime: at }, service.env as never);
}

function policy(service: Service) {
  return policyOf(readFreeConfig(service.env));
}

/** Admits a person straight through the Directory, as the sign-in flow does. */
async function admit(service: Service, githubId: number, login: string, at: number, options: { invite?: string; referral?: string } = {}) {
  const result = await service.directory().admit({
    githubId,
    login,
    isAdmin: false,
    inviteCode: options.invite,
    clientDeviceId: null,
    accountTooNew: false,
    openAdmission: options.invite === undefined,
    inviteOnly: false,
    maxActive: 50,
    referralCode: options.referral,
    policy: policy(service),
    now: at,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

async function request(service: Service, githubId: number, at: number, fields: { prompt: number; cached: number; out: number; costUsd: number; upstream?: "openrouter" | "luminal"; creditUsd?: number; paid?: boolean; isAdmin?: boolean }) {
  await service.directory().recordRequest({
    githubId,
    isAdmin: fields.isAdmin ?? false,
    at,
    model: MODEL,
    promptTokens: fields.prompt,
    completionTokens: fields.out,
    cachedTokens: fields.cached,
    chargedTokens: fields.prompt + fields.out,
    costUsd: fields.costUsd,
    status: "ok",
    latencyMs: 100,
    upstream: fields.upstream ?? "openrouter",
    creditUsd: fields.creditUsd ?? 0,
    paid: fields.paid ?? false,
  });
}

describe("first sign-up email", () => {
  it("emails the first person admitted by open admission, once, and not for the admin", async () => {
    const service = await createService({ OPEN_ADMISSION: "true", ALERT_EMAIL_TO: "owner@example.com" }, { email: true });
    await service.signIn({ id: ADMIN_ID, login: "owner" });
    assert.equal(service.calls.emails.length, 0, "the admin signing in isn't a user");
    await service.signIn({ id: 501, login: "alice" });
    assert.equal(service.calls.emails.length, 1);
    const { subject, body } = decodeEmail(service.calls.emails[0]!.raw);
    assert.equal(subject, "dl free tier: your first user, @alice");
    assert.equal(
      body,
      [
        "dl free tier: your first user, @alice.",
        "",
        "Login: @alice (https://github.com/alice)",
        "How they got in: open admission",
        "Time: 2026-11-04 12:00 UTC (20:00 Singapore)",
        "Free tokens: available now",
        "",
        "Admin dashboard: https://free.test/admin",
        "",
        "Sent once, ever: for the first person admitted who isn't an admin.",
        "",
      ].join("\n"),
    );
    // Signing in again, and a second person: nothing more.
    await service.signIn({ id: 501, login: "alice" });
    service.clock.now += 2 * DAY; // a fresh per-network sign-up allowance
    await service.signIn({ id: 502, login: "bob" });
    assert.equal(service.calls.emails.length, 1);
  });

  it("says when the first user came with an invite", async () => {
    const service = await createService({ ALERT_WEBHOOK_URL: "https://alerts.test/hook" });
    const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const invite = await createInvite(service, admin);
    await service.signIn({ id: 601, login: "inv" }, { invite });
    assert.equal(texts(service).length, 1);
    assert.match(texts(service)[0]!, /^dl free tier: your first user, @inv\.\n/);
    assert.match(texts(service)[0]!, /\nHow they got in: invite code\n/);
  });

  it("says referral when the first user came by a referral link, and that they wait in the queue", async () => {
    const service = await createService({ OPEN_ADMISSION: "true", ALERT_WEBHOOK_URL: "https://alerts.test/hook" });
    await service.signIn({ id: ADMIN_ID, login: "owner" });
    // Free spend at the queue threshold: the first open sign-up waits.
    await request(service, 900, NOW - HOUR, { prompt: 1, cached: 0, out: 1, costUsd: 210 });
    service.calls.webhooks.length = 0;
    const result = await admit(service, 701, "Refd", NOW, { referral: "owner" });
    assert.equal(result.queued, true);
    assert.ok(result.firstSignup);
    assert.equal(result.firstSignup.subject, "dl free tier: your first user, @Refd");
    assert.match(result.firstSignup.text, /\nHow they got in: referral link, open admission\n/);
    assert.match(result.firstSignup.text, /\nFree tokens: waiting in the queue until Monday's admission$/);
    assert.equal((await admit(service, 702, "next", NOW + 1)).firstSignup, undefined);
  });

  it("never sends when people were admitted before the alert existed", async () => {
    const service = await createService({ OPEN_ADMISSION: "true", ALERT_WEBHOOK_URL: "https://alerts.test/hook" });
    await service.signIn({ id: ADMIN_ID, login: "owner" });
    const state = (service.namespaces.DIRECTORY as unknown as { instances: Map<string, { state: { db: { exec(sql: string): void } } }> }).instances.get("directory")!.state;
    state.db.exec(`INSERT INTO people (github_id, login, status, admitted_at, admitted_via) VALUES (400, 'early', 'active', ${NOW - DAY}, 'open')`);
    assert.equal((await admit(service, 801, "later", NOW)).firstSignup, undefined);
    assert.equal((await admit(service, 802, "later2", NOW + 1)).firstSignup, undefined);
    assert.deepEqual(texts(service), []);
  });
});

describe("daily digest", () => {
  /** A service with a busy Tuesday 2026-11-03, a Monday before it, and a Wednesday after it. */
  async function seeded(): Promise<Service> {
    const service = await createService({ OPEN_ADMISSION: "true", ALERT_EMAIL_TO: "owner@example.com", LUMINAL_CREDIT_USD: "2000" }, { email: true });
    const directory = service.directory();
    await directory.admit({ githubId: ADMIN_ID, login: "owner", isAdmin: true, inviteCode: undefined, clientDeviceId: null, accountTooNew: false, maxActive: 50, now: TUESDAY - DAY });
    await admit(service, 10, "carol", TUESDAY - DAY + HOUR); // Monday: this week, not the day
    await admit(service, 11, "alice", TUESDAY + 10 * HOUR);
    const [invite] = await directory.createInvites({ count: 1, note: null, createdBy: ADMIN_ID, now: TUESDAY });
    await admit(service, 12, "bob", TUESDAY + 11 * HOUR, { invite: invite!.code, referral: "alice" });
    await admit(service, 13, "dave", DIGEST_AT - 30 * 60_000); // Wednesday 00:30: the next day
    // Requests. The admin's and Wednesday's are left out of the day; the paid one counts as a request, not as free spend.
    // Everything on Luminal credit, as at launch (no OpenRouter key).
    await request(service, ADMIN_ID, TUESDAY + 9 * HOUR, { prompt: 99_999, cached: 0, out: 9_999, costUsd: 9, upstream: "luminal", creditUsd: 9, isAdmin: true });
    await request(service, 10, TUESDAY - DAY + 2 * HOUR, { prompt: 500, cached: 0, out: 50, costUsd: 1, upstream: "luminal", creditUsd: 1 });
    await request(service, 11, TUESDAY + 12 * HOUR, { prompt: 1_000, cached: 400, out: 100, costUsd: 0.5, upstream: "luminal", creditUsd: 0.5 });
    await request(service, 12, TUESDAY + 13 * HOUR, { prompt: 2_000, cached: 1_000, out: 200, costUsd: 0.3, upstream: "luminal", creditUsd: 0.25 });
    await request(service, 12, TUESDAY + 14 * HOUR, { prompt: 300, cached: 0, out: 30, costUsd: 2, upstream: "luminal", creditUsd: 2, paid: true });
    await request(service, 13, DIGEST_AT - 10 * 60_000, { prompt: 7_777, cached: 0, out: 7, costUsd: 7, upstream: "luminal", creditUsd: 7 });
    await directory.recordPayment({ id: "pi_1", githubId: 12, kind: "topup", amountCents: 300, at: TUESDAY + 14 * HOUR });
    await directory.recordPayment({ id: "pi_0", githubId: 10, kind: "pro", amountCents: 1000, at: TUESDAY - DAY + 3 * HOUR });
    const day = TUESDAY / DAY;
    const install = { arch: "arm64", dlVersion: "0.15.0", via: "home" } as const;
    await directory.countInstall({ ...install, os: "linux", mode: "server", result: "ok", failedStep: "" }, day);
    await directory.countInstall({ ...install, os: "linux", mode: "server", result: "ok", failedStep: "" }, day);
    await directory.countInstall({ ...install, os: "linux", mode: "server", result: "failed", failedStep: "dl_up" }, day);
    await directory.countInstall({ ...install, os: "darwin", mode: "laptop", result: "ok", failedStep: "" }, day);
    await directory.countInstall({ ...install, os: "darwin", mode: "laptop", result: "failed", failedStep: "node" }, day - 1);
    await directory.setPaused(true, { githubId: ADMIN_ID, login: "owner", now: TUESDAY + 20 * HOUR });
    service.calls.emails.length = 0;
    service.calls.webhooks.length = 0;
    return service;
  }

  it("reports the previous UTC day from the stored records, with the week so far", async () => {
    const service = await seeded();
    service.clock.now = DIGEST_AT;
    await scheduled(service, DIGEST_AT);
    assert.equal(service.calls.emails.length, 1);
    const { subject, body } = decodeEmail(service.calls.emails[0]!.raw);
    assert.equal(subject, "dl free tier: daily, 2026-11-03: 2 new, 2 active");
    assert.equal(
      body,
      [
        "dl free tier: daily digest for Tue 2026-11-03 (UTC). Admins left out.",
        "",
        "New sign-ups: 2",
        "  @alice (open admission), @bob (referral link, invite code)",
        "Active people: 2",
        "Requests: 3",
        "Tokens: 3,300 in (1,400 cached), 330 out",
        "Free credit spent: $0.75 (Luminal credit)",
        "Luminal credit left: $1,980.25 of $2,000",
        "Paid: $3 from 1 payment",
        "Installs: 3 finished, 1 failed",
        "  linux arm64 server: 2 ok, 1 failed",
        "  darwin arm64 laptop: 1 ok, 0 failed",
        "  Failed at: dl_up 1",
        "",
        "This week so far (Mon 2026-11-02 to 2026-11-03):",
        "  Sign-ups: 3",
        "  Active people: 3",
        "  Requests: 4",
        "  Tokens: 3,800 in (1,400 cached), 380 out",
        "  Free credit spent: $1.75 of the $250 weekly credit budget (1%)",
        "  Paid: $13 from 2 payments",
        "",
        "Queue: 0 waiting",
        "Free tokens: PAUSED (kill switch)",
        "",
        "Admin dashboard: https://free.directionallylocal.com/admin",
        "",
        "Sent by the free tier service every day at 01:00 UTC (09:00 Singapore), even when nothing happened. Counts and dollars only.",
        "",
      ].join("\n"),
    );
  });

  it("sends once per date: a retried cron run doesn't send again; the next day does", async () => {
    const service = await seeded();
    await scheduled(service, DIGEST_AT);
    await scheduled(service, DIGEST_AT + 5 * 60_000);
    assert.equal(service.calls.emails.length, 1);
    await scheduled(service, DIGEST_AT + DAY);
    assert.equal(service.calls.emails.length, 2);
    const next = decodeEmail(service.calls.emails[1]!.raw);
    assert.equal(next.subject, "dl free tier: daily, 2026-11-04: 1 new, 1 active");
    assert.match(next.body, /\n {2}@dave \(open admission\)\n/);
  });

  it("sends on a quiet day too, with zeros, as a heartbeat", async () => {
    const service = await createService({ PUBLIC_URL: "https://free.example", ALERT_WEBHOOK_URL: "https://alerts.test/hook" });
    await scheduled(service, DIGEST_AT);
    assert.equal(texts(service).length, 1);
    const text = texts(service)[0]!;
    assert.match(text, /^dl free tier: daily digest for Tue 2026-11-03 \(UTC\)\./);
    assert.match(text, /\nNew sign-ups: 0\nActive people: 0\nRequests: 0\n/);
    assert.match(text, /\nInstalls: 0 finished, 0 failed\n/);
    assert.match(text, /\nPaid: none\n/);
    assert.match(text, /\nQueue: 0 waiting\nFree tokens: on$/);
  });

  it("warns when OpenRouter cost anything, which it never should", async () => {
    const service = await createService({ ALERT_WEBHOOK_URL: "https://alerts.test/hook" });
    await request(service, 20, TUESDAY + HOUR, { prompt: 10, cached: 0, out: 1, costUsd: 0.4 });
    await request(service, ADMIN_ID, TUESDAY + 2 * HOUR, { prompt: 10, cached: 0, out: 1, costUsd: 0.1, isAdmin: true });
    service.calls.webhooks.length = 0;
    await scheduled(service, DIGEST_AT);
    const text = texts(service)[0]!;
    assert.match(text, /\nFree credit spent: \$0 \(Luminal credit\)\nOpenRouter spend: \$0\.50 \(should be \$0\)\n/);
    assert.match(text, /\n {2}Free credit spent: \$0 of the \$250 weekly credit budget \(0%\)\n {2}OpenRouter spend: \$0\.50 \(should be \$0\)\n/);
  });

  it("has no OpenRouter line when OpenRouter cost nothing", async () => {
    const service = await seeded();
    await scheduled(service, DIGEST_AT);
    assert.doesNotMatch(decodeEmail(service.calls.emails[0]!.raw).body, /OpenRouter/);
  });

  it("lists at most 20 logins and counts the rest", async () => {
    const service = await createService({ OPEN_ADMISSION: "true", ALERT_WEBHOOK_URL: "https://alerts.test/hook" });
    for (let index = 0; index < 23; index++) await admit(service, 1000 + index, `p${index}`, TUESDAY + index * 60_000);
    service.calls.webhooks.length = 0;
    await scheduled(service, DIGEST_AT);
    const text = texts(service)[0]!;
    assert.match(text, /\nNew sign-ups: 23\n {2}@p0 \(open admission\), .*@p19 \(open admission\)\n {2}and 3 more\n/);
    assert.doesNotMatch(text, /@p20/);
  });

  it("routes only the digest cron, and both wrangler configs schedule it", async () => {
    const service = await createService({ ALERT_WEBHOOK_URL: "https://alerts.test/hook" });
    await scheduled(service, DIGEST_AT, "*/5 * * * *");
    assert.deepEqual(texts(service), []);
    await scheduled(service, DIGEST_AT, "0 1 * * *");
    assert.equal(texts(service).length, 1);
    for (const file of ["wrangler.jsonc", "wrangler.cloudflare.jsonc"]) {
      const config = JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), "utf8")) as { triggers?: { crons?: string[] } };
      assert.deepEqual(config.triggers?.crons, [DIGEST_CRON], file);
    }
  });
});
