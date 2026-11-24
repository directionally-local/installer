import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, createService, MODEL, type Service } from "./harness.js";
import { policyOf } from "../src/queue.js";
import { readFreeConfig } from "../src/config.js";
import { renderUserEmail, shortTokens } from "../src/user-emails.js";
import { weeklyResetTokens, weeklyResetWindow } from "../src/user-email-send.js";
import { PROBE_CRON } from "../src/probes.js";

// After the harness: app.js loads cloudflare:workers, which the harness resolves.
const { DIGEST_CRON } = await import("../src/app.js");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The first week's Monday, 00:00 UTC, and its daily run at 01:00. */
const MONDAY = Date.parse("2026-11-30T00:00:00Z");
const RUN = MONDAY + HOUR;
const URL_STOP = "https://free.directionallylocal.com/email/stop?u=1&t=x";

async function service(vars: Record<string, string> = {}): Promise<Service> {
  // Speed probes off, so a 10-minute tick does only the weekly_reset part here.
  return createService({ OPEN_ADMISSION: "true", RESEND_API_KEY: "re_test_key", SPEED_PROBES: "false", ...vars });
}

async function scheduled(s: Service, at: number, cron: string = DIGEST_CRON): Promise<void> {
  s.clock.now = at;
  await (s.handler as unknown as { scheduled(controller: { cron: string; scheduledTime: number }, env: never): Promise<void> }).scheduled({ cron, scheduledTime: at }, s.env as never);
}

/** Admits someone straight through the Directory, with an email unless `email` is null, and a request at `usedAt` unless null. */
async function person(s: Service, githubId: number, login: string, options: { admittedAt?: number; usedAt?: number | null; email?: string | null } = {}): Promise<void> {
  const admittedAt = options.admittedAt ?? MONDAY - 20 * DAY;
  const result = await s.directory().admit({
    githubId,
    login,
    isAdmin: githubId === ADMIN_ID,
    inviteCode: undefined,
    clientDeviceId: null,
    accountTooNew: false,
    openAdmission: true,
    inviteOnly: false,
    maxActive: 500,
    policy: policyOf(readFreeConfig(s.env)),
    now: admittedAt,
  });
  assert.equal(result.ok, true);
  const email = options.email === undefined ? `${login}@example.com` : options.email;
  if (email) await s.directory().setEmail(githubId, email, false, admittedAt);
  const usedAt = options.usedAt === undefined ? MONDAY - 2 * DAY : options.usedAt;
  if (usedAt !== null) {
    await s.directory().recordRequest({ githubId, isAdmin: githubId === ADMIN_ID, at: usedAt, model: MODEL, promptTokens: 100, completionTokens: 10, cachedTokens: 0, chargedTokens: 110, costUsd: 0.001, status: "ok", latencyMs: 10 });
  }
}

function db(s: Service) {
  return s.namespaces.DIRECTORY!.instances.get("directory")!.state.db;
}

/** The weekly_reset emails sent so far: to whom, subject and text. */
function resets(s: Service): Array<{ to: string; subject: string; text: string }> {
  return s.calls.resend
    .filter((call) => String(call.headers["idempotency-key"]).startsWith("dl-user-email-weekly_reset-"))
    .map((call) => ({ to: (call.body.to as string[])[0]!, subject: String(call.body.subject), text: String(call.body.text) }));
}

const resetTo = (s: Service) => resets(s).map((email) => email.to).sort();

describe("weekly reset email: the copy", () => {
  it("says tokens short and rounded down", () => {
    assert.equal(shortTokens(1_000_000), "1M");
    assert.equal(shortTokens(1_200_000), "1.2M");
    assert.equal(shortTokens(1_290_000), "1.2M", "never more than the person has");
    assert.equal(shortTokens(10_000_000), "10M");
    assert.equal(shortTokens(50_000_000), "50M");
    assert.equal(shortTokens(60_000_000), "60M");
    assert.equal(shortTokens(500_000), "500K");
    assert.equal(shortTokens(1_500_000_000), "1.5B");
    assert.equal(shortTokens(999), "999");
  });

  it("renders the approved copy, plain text, with the person's tokens and invite link", () => {
    const email = renderUserEmail("weekly_reset", { resets: "monday 7 dec", unsubscribeUrl: URL_STOP, weeklyReset: { tokens: 50_000_000, fullTokens: 50_000_000, login: "alice" } });
    assert.equal(email.subject, "50M tokens, reset.");
    assert.equal(
      email.body,
      `hey,

new week: you have 50M free tokens again.

to jump back in, open your terminal and type dl
- continue your last session: dl -c
- on windows: open ubuntu (wsl), not powershell, then type dl
- not installed anymore? curl -fsSL https://dl.new | sh

two small asks:
- star dl on github: https://github.com/directionally-local/autopilot
- send dl to one friend who codes: https://dl.new/r/alice

sina

don't want these? ${URL_STOP}
`,
    );
  });

  it("adds the grows line below the Full allowance only", () => {
    const below = renderUserEmail("weekly_reset", { resets: "", unsubscribeUrl: URL_STOP, weeklyReset: { tokens: 1_200_000, fullTokens: 50_000_000, login: "bo" } });
    assert.equal(below.subject, "1.2M tokens, reset.");
    assert.match(below.body, /^hey,\n\nnew week: you have 1\.2M free tokens again\.\n\nit grows as you use dl, up to 50M a week\.\n\nto jump back in, /);
    const atFull = renderUserEmail("weekly_reset", { resets: "", unsubscribeUrl: URL_STOP, weeklyReset: { tokens: 50_000_000, fullTokens: 50_000_000, login: "bo" } });
    const aboveFull = renderUserEmail("weekly_reset", { resets: "", unsubscribeUrl: URL_STOP, weeklyReset: { tokens: 60_000_000, fullTokens: 50_000_000, login: "bo" } });
    for (const email of [atFull, aboveFull]) assert.doesNotMatch(email.body, /it grows/);
  });

  it("takes the allowance's own weekly tokens, and skips the trial, Pro, no tokens and inactive accounts", () => {
    const free = { plan: "free", status: "active", tokensPerWeek: 10_000_000, trial: null };
    assert.equal(weeklyResetTokens(free, false), 10_000_000);
    assert.equal(weeklyResetTokens({ ...free, status: null }, false), 10_000_000, "no account row yet: what dl status shows");
    assert.equal(weeklyResetTokens(free, true), "trial");
    assert.equal(weeklyResetTokens({ ...free, trial: { tokens: 1 } }, false), "trial");
    assert.equal(weeklyResetTokens({ ...free, plan: "pro" }, false), "pro");
    assert.equal(weeklyResetTokens({ ...free, tokensPerWeek: 0 }, false), "no_allowance");
    assert.equal(weeklyResetTokens({ ...free, tokensPerWeek: null }, false), "no_allowance");
    assert.equal(weeklyResetTokens({ ...free, status: "blocked" }, false), "not_active");
    assert.equal(weeklyResetTokens({ ...free, status: "suspended" }, false), "not_active");
  });
});

describe("weekly reset email: when", () => {
  it("runs Monday from 01:00 (ticks from 01:30) through Tuesday, from 30 Nov 2026 on", () => {
    assert.equal(weeklyResetWindow(RUN, "daily"), true);
    assert.equal(weeklyResetWindow(RUN - MINUTE, "daily"), false);
    assert.equal(weeklyResetWindow(RUN, "tick"), false);
    assert.equal(weeklyResetWindow(MONDAY + 90 * MINUTE, "tick"), true);
    assert.equal(weeklyResetWindow(MONDAY + DAY + HOUR, "daily"), true, "Tuesday carries on");
    assert.equal(weeklyResetWindow(MONDAY + 2 * DAY - MINUTE, "tick"), true);
    assert.equal(weeklyResetWindow(MONDAY + 2 * DAY + HOUR, "daily"), false, "never Wednesday");
    assert.equal(weeklyResetWindow(MONDAY + 6 * DAY + HOUR, "daily"), false, "never Sunday");
    assert.equal(weeklyResetWindow(MONDAY - 7 * DAY + HOUR, "daily"), false, "not before the first week");
    assert.equal(weeklyResetWindow(MONDAY + 7 * DAY + HOUR, "daily"), true);
  });

  it("sends nothing before the first week or on a Wednesday, and goes on Monday's daily run", async () => {
    const s = await service();
    await person(s, 801, "ana", { admittedAt: MONDAY - 40 * DAY, usedAt: MONDAY - 9 * DAY });
    await scheduled(s, MONDAY - 7 * DAY + HOUR); // Monday 23 Nov
    assert.deepEqual(resets(s), []);
    await person(s, 802, "ben", { usedAt: MONDAY - 9 * DAY });
    await scheduled(s, MONDAY - 5 * DAY + HOUR); // Wednesday
    assert.deepEqual(resets(s), []);
    await scheduled(s, RUN);
    assert.deepEqual(resetTo(s), ["ana@example.com", "ben@example.com"]);
  });
});

describe("weekly reset email: who gets it", () => {
  it("goes to active free-allowance people who used dl in the last 28 days, with their own tokens", async () => {
    const s = await service({ BASIC_WEEKLY_TOKENS: "10000000", STARTER_WEEKLY_TOKENS: "0", ALLOCATOR_START_TOKENS: "0", TRIAL_CUTOFF: new Date(MONDAY - 10 * DAY).toISOString() });
    await person(s, ADMIN_ID, "owner"); // an admin
    await person(s, 811, "Full-One", { email: "full-one@example.com" }); // Full: 50M
    await person(s, 812, "basic"); // basic: 10M, below Full
    db(s).prepare("UPDATE people SET level = 'basic' WHERE github_id = 812").run();
    await person(s, 813, "blocked");
    db(s).prepare("UPDATE people SET status = 'blocked' WHERE github_id = 813").run();
    await person(s, 814, "starter"); // Starter with no tokens: no allowance
    db(s).prepare("UPDATE people SET level = 'starter' WHERE github_id = 814").run();
    await person(s, 815, "trial", { admittedAt: MONDAY - 5 * DAY }); // on the trial
    await person(s, 816, "idle", { usedAt: MONDAY - 29 * DAY }); // no request in 28 days
    await person(s, 817, "never", { usedAt: null }); // never used dl
    await person(s, 818, "noemail", { email: null });
    await person(s, 819, "stopped");
    db(s).prepare("UPDATE people SET email_stop = 1 WHERE github_id = 819").run();
    await person(s, 820, "recent", { usedAt: MONDAY - 27 * DAY });

    await scheduled(s, RUN);
    assert.deepEqual(resetTo(s), ["basic@example.com", "full-one@example.com", "recent@example.com"]);
    const full = resets(s).find((email) => email.to === "full-one@example.com")!;
    assert.equal(full.subject, "50M tokens, reset.");
    assert.doesNotMatch(full.text, /it grows/);
    assert.match(full.text, /https:\/\/dl\.new\/r\/full-one\n/, "the person's own invite link");
    const basic = resets(s).find((email) => email.to === "basic@example.com")!;
    assert.equal(basic.subject, "10M tokens, reset.");
    assert.match(basic.text, /\n\nit grows as you use dl, up to 50M a week\.\n\n/);

    // The dry run agrees, and sends nothing.
    const before = s.calls.resend.length;
    db(s).prepare("DELETE FROM user_emails").run();
    const admin = (await s.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const preview = await s.request("GET", "/admin/emails/weekly-reset", { token: admin });
    assert.equal(preview.status, 200);
    const body = (await preview.json()) as Record<string, any>;
    assert.equal(s.calls.resend.length, before);
    assert.equal(body.week, "2026-11-30");
    assert.equal(body.count, 3);
    assert.equal(body.belowFull, 1);
    assert.deepEqual(body.skipped, { trial: 1, pro: 0, no_allowance: 1, not_active: 0 });
    assert.equal(body.samples.length, 3);
    assert.deepEqual(body.samples.map((sample: { login: string }) => sample.login), ["Full-One", "basic", "recent"]);
    assert.equal(body.samples[1].subject, "10M tokens, reset.");
    assert.match(body.samples[0].body, /don't want these\? https:\/\/free\.directionallylocal\.com\/email\/stop\?u=1&t=/, "the admin's own stop link");
    assert.deepEqual(db(s).prepare("SELECT * FROM user_emails").all(), [], "records nothing");

    const user = (await s.signIn({ id: 811, login: "Full-One" })).access_token;
    assert.equal((await s.request("GET", "/admin/emails/weekly-reset", { token: user })).status, 403);
  });

  it("honours stop: someone who pressed it after one week gets nothing the next", async () => {
    const s = await service();
    await person(s, 831, "cal");
    await scheduled(s, RUN);
    assert.equal(resets(s).length, 1);
    const header = String((s.calls.resend.at(-1)!.body.headers as Record<string, string>)["List-Unsubscribe"]);
    const stop = new URL(/^<(.+)>$/.exec(header)![1]!);
    assert.equal((await s.request("POST", `${stop.pathname}${stop.search}`, { form: {} })).status, 200);
    await s.directory().recordRequest({ githubId: 831, isAdmin: false, at: RUN + 2 * DAY, model: MODEL, promptTokens: 1, completionTokens: 1, cachedTokens: 0, chargedTokens: 2, costUsd: 0, status: "ok", latencyMs: 1 });
    await scheduled(s, RUN + 7 * DAY);
    assert.equal(resets(s).length, 1);
  });
});

describe("weekly reset email: once a week", () => {
  it("goes once per person per week across the daily run, the ticks and Tuesday, then again next Monday", async () => {
    const s = await service();
    await person(s, 841, "dee");
    await person(s, 842, "eli");
    await scheduled(s, RUN);
    await scheduled(s, MONDAY + 90 * MINUTE, PROBE_CRON);
    await scheduled(s, MONDAY + 100 * MINUTE, PROBE_CRON);
    await scheduled(s, MONDAY + DAY + HOUR);
    await scheduled(s, MONDAY + DAY + 2 * HOUR, PROBE_CRON);
    assert.deepEqual(resetTo(s), ["dee@example.com", "eli@example.com"]);
    assert.equal(s.calls.resend[0]!.headers["idempotency-key"], `dl-user-email-weekly_reset-841-${MONDAY}`);

    // Next week they used dl again: once more.
    for (const id of [841, 842]) await s.directory().recordRequest({ githubId: id, isAdmin: false, at: RUN + 3 * DAY, model: MODEL, promptTokens: 1, completionTokens: 1, cachedTokens: 0, chargedTokens: 2, costUsd: 0, status: "ok", latencyMs: 1 });
    await scheduled(s, RUN + 7 * DAY);
    await scheduled(s, RUN + 7 * DAY + HOUR, PROBE_CRON);
    assert.equal(resets(s).length, 4);

    const admin = (await s.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const metrics = (await (await s.request("GET", `/admin/metrics?from=2026-11-25&to=2026-12-08`, { token: admin })).json()) as Record<string, any>;
    assert.deepEqual(metrics.weeklyResetEmails, [
      { week: "2026-11-30", sent: 2, failed: 0 },
      { week: "2026-12-07", sent: 2, failed: 0 },
    ]);
  });

  it("waits a day for someone who already had another email on Monday", async () => {
    const s = await service();
    await person(s, 851, "fay");
    db(s).prepare("INSERT INTO user_emails (github_id, kind, period, status, attempts, day, claimed_at, sent_at) VALUES (851, 'gone_quiet', '', 'sent', 1, ?, ?, ?)").run(MONDAY / DAY, MONDAY + 10 * MINUTE, MONDAY + 10 * MINUTE);
    await scheduled(s, RUN);
    await scheduled(s, MONDAY + 2 * HOUR, PROBE_CRON);
    assert.deepEqual(resets(s), []);
    await scheduled(s, MONDAY + DAY + HOUR);
    assert.deepEqual(resetTo(s), ["fay@example.com"]);
  });

  it("keeps within the daily limit and carries on in later runs", async () => {
    const s = await service();
    for (let id = 900; id < 905; id++) await person(s, id, `p${id}`);
    // 297 other emails were already claimed today: room for 3.
    const insert = db(s).prepare("INSERT INTO user_emails (github_id, kind, period, status, attempts, day, claimed_at, sent_at) VALUES (?, 'didnt_start', '', 'sent', 1, ?, ?, ?)");
    for (let id = 20_000; id < 20_297; id++) insert.run(id, MONDAY / DAY, MONDAY, MONDAY);
    await scheduled(s, RUN);
    assert.equal(resets(s).length, 3);
    await scheduled(s, MONDAY + 2 * HOUR, PROBE_CRON);
    assert.equal(resets(s).length, 3, "the day's limit is reached");
    await scheduled(s, MONDAY + DAY + HOUR); // Tuesday
    assert.deepEqual(resetTo(s), ["p900@example.com", "p901@example.com", "p902@example.com", "p903@example.com", "p904@example.com"]);
  });

  it("sends at most 100 a run, and the next tick carries on", async () => {
    const s = await service();
    for (let id = 1000; id < 1105; id++) await person(s, id, `q${id}`);
    await scheduled(s, RUN);
    assert.equal(resets(s).length, 100);
    await scheduled(s, MONDAY + 90 * MINUTE, PROBE_CRON);
    assert.equal(resets(s).length, 105);
    assert.equal(new Set(resetTo(s)).size, 105);
  });
});

describe("weekly reset email: switches", () => {
  it("sends nothing while weeklyResetEmail or userEmails is off", async () => {
    const s = await service();
    await person(s, 861, "gus");
    const admin = (await s.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    assert.equal((await s.request("POST", "/admin/config", { token: admin, body: { weeklyResetEmail: false } })).status, 200);
    await scheduled(s, RUN);
    assert.deepEqual(resets(s), []);
    const again = (await s.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    assert.equal((await s.request("POST", "/admin/config", { token: again, body: { weeklyResetEmail: null, userEmails: false } })).status, 200);
    await scheduled(s, MONDAY + 2 * HOUR, PROBE_CRON);
    assert.deepEqual(resets(s), []);
    const third = (await s.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    assert.equal((await s.request("POST", "/admin/config", { token: third, body: { userEmails: null } })).status, 200);
    await scheduled(s, MONDAY + 3 * HOUR, PROBE_CRON);
    assert.deepEqual(resetTo(s), ["gus@example.com"]);
  });

  it("is off by WEEKLY_RESET_EMAIL=false", async () => {
    const s = await service({ WEEKLY_RESET_EMAIL: "false" });
    await person(s, 871, "hal");
    await scheduled(s, RUN);
    assert.deepEqual(resets(s), []);
  });
});
